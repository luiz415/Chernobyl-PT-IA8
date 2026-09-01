import { collection, doc, getDoc, query, serverTimestamp, setDoc } from "firebase/firestore";
import { db, isSimulationMode, onSnapshot } from "../firebase/config";
import type { PartyFinalizationReason, PersonalPartyHistory } from "../types";
import { toFirestoreMillis } from "../utils/firestoreTimestamp";
import { buildOverrideDoc, sanitizeHistoryOverrides, type PartyHistoryOverrides } from "../utils/historyOverrides";

const PERSONAL_HISTORY_COLLECTION = "partyHistory";
const HISTORY_OVERRIDES_COLLECTION = "partyHistoryOverrides";
// Espelho local do histórico privado — mesmo padrão dos demais caches do app
// (cloud_cache_*). Zero leituras extras: é gravado pelo próprio listener quando
// a guia está aberta e lido apenas para hidratar o contador na inicialização.
const PERSONAL_HISTORY_CACHE_PREFIX = "cloud_cache_personal_party_history_";
const FINALIZATION_REQUESTS_COLLECTION = "partyFinalizationRequests";
const SIMULATION_HISTORY_KEY_PREFIX = "tibia_sim_party_history_";

function simulationHistoryKey(uid: string) {
  return `${SIMULATION_HISTORY_KEY_PREFIX}${uid}`;
}

function readSimulationHistory(uid: string): PersonalPartyHistory[] {
  try {
    const raw = localStorage.getItem(simulationHistoryKey(uid));
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function personalHistoryCacheKey(uid: string) {
  return `${PERSONAL_HISTORY_CACHE_PREFIX}${uid}`;
}

/**
 * Lê o espelho local do histórico privado.
 *
 * Fonte INSTANTÂNEA e gratuita (localStorage) para o contador da guia
 * "Meu Histórico de PT's" e para o 1º passo do "Ver PT": permite exibir o
 * último valor conhecido sem montar listener nem ler o Firestore. O listener
 * da guia segue sendo a fonte de verdade — ele regrava este cache a cada
 * snapshot enquanto a guia está aberta.
 *
 * No modo simulação, o espelho é o próprio storage de simulação.
 */
export function readPersonalPartyHistoryCache(uid: string): PersonalPartyHistory[] {
  const normalizedUid = String(uid || "").trim();
  if (!normalizedUid) return [];
  try {
    if (isSimulationMode || !db) {
      return sortHistory(readSimulationHistory(normalizedUid));
    }
    const raw = localStorage.getItem(personalHistoryCacheKey(normalizedUid));
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? sortHistory(parsed as PersonalPartyHistory[]) : [];
  } catch {
    return [];
  }
}

function savePersonalPartyHistoryCache(uid: string, entries: PersonalPartyHistory[]): void {
  const normalizedUid = String(uid || "").trim();
  if (!normalizedUid) return;
  try {
    localStorage.setItem(personalHistoryCacheKey(normalizedUid), JSON.stringify(entries));
  } catch {}
}

function sortHistory(entries: PersonalPartyHistory[]): PersonalPartyHistory[] {
  return [...entries].sort((left, right) => {
    const rightDate = toFirestoreMillis(right.party.finalizedAt || right.party.questFinalizedAt || right.updatedAt);
    const leftDate = toFirestoreMillis(left.party.finalizedAt || left.party.questFinalizedAt || left.updatedAt);
    return rightDate - leftDate;
  });
}

/**
 * Único listener do histórico privado do usuário, montado somente enquanto a
 * guia Histórico de PT's estiver aberta. Não toca partyArchives ou PTs alheias.
 * Cada snapshot também atualiza o espelho local (cache do contador persistente).
 */
export function subscribePersonalPartyHistory(
  uid: string,
  onChange: (entries: PersonalPartyHistory[]) => void,
): () => void {
  const normalizedUid = String(uid || "").trim();
  if (!normalizedUid) {
    onChange([]);
    return () => {};
  }

  if (isSimulationMode || !db) {
    onChange(sortHistory(readSimulationHistory(normalizedUid)));
    return () => {};
  }

  return onSnapshot(
    query(collection(db, "users", normalizedUid, PERSONAL_HISTORY_COLLECTION)),
    snapshot => {
      const entries = snapshot.docs.map(item => ({
        id: item.id,
        ...item.data(),
      } as PersonalPartyHistory));
      const sorted = sortHistory(entries);
      // Espelho local: alimenta o contador persistente da guia sem nenhuma
      // leitura adicional — o snapshot que já chegou é gravado de graça.
      savePersonalPartyHistoryCache(normalizedUid, sorted);
      onChange(sorted);
    },
    () => onChange([]),
  );
}

/** Consulta pontual usada para navegar por uma notificação sem montar listener global. */
export async function getPersonalPartyHistoryEntry(uid: string, partyId: string): Promise<PersonalPartyHistory | null> {
  const normalizedUid = String(uid || "").trim();
  const normalizedPartyId = String(partyId || "").trim();
  if (!normalizedUid || !normalizedPartyId) return null;
  if (isSimulationMode || !db) {
    return readSimulationHistory(normalizedUid).find(entry => entry.partyId === normalizedPartyId) || null;
  }
  try {
    const snapshot = await getDoc(doc(db, "users", normalizedUid, PERSONAL_HISTORY_COLLECTION, normalizedPartyId));
    return snapshot.exists() ? ({ id: snapshot.id, ...snapshot.data() } as PersonalPartyHistory) : null;
  } catch {
    return null;
  }
}

/**
 * Correções locais do usuário (Drop/Lucro dos SEUS personagens) sobre a
 * projeção do histórico. Documento privado em
 * users/{uid}/partyHistoryOverrides/{partyId}: o backend nunca o toca, então
 * as reprojeções da PT não apagam correções manuais.
 */
export function subscribePartyHistoryOverrides(
  uid: string,
  onChange: (overridesByParty: Record<string, PartyHistoryOverrides>) => void,
): () => void {
  const normalizedUid = String(uid || "").trim();
  if (!normalizedUid || isSimulationMode || !db) {
    onChange({});
    return () => {};
  }
  return onSnapshot(
    query(collection(db, "users", normalizedUid, HISTORY_OVERRIDES_COLLECTION)),
    snapshot => {
      const map: Record<string, PartyHistoryOverrides> = {};
      snapshot.docs.forEach(item => {
        map[item.id] = sanitizeHistoryOverrides(item.data());
      });
      onChange(map);
    },
    () => onChange({}),
  );
}

/**
 * Grava o documento de correções de uma PT (inteiro — só o dono da conta
 * escreve, não há concorrência). O formato é validado pelas regras do
 * Firestore: hasOnly([partyId, drops, profits, updatedAt]).
 */
export async function savePartyHistoryOverrides(
  uid: string,
  partyId: string,
  overrides: PartyHistoryOverrides,
): Promise<{ ok: boolean; error?: string }> {
  const normalizedUid = String(uid || "").trim();
  const normalizedPartyId = String(partyId || "").trim();
  if (!normalizedUid || !normalizedPartyId) {
    return { ok: false, error: "Correção inválida: usuário ou PT não identificado." };
  }
  if (isSimulationMode || !db) {
    return { ok: false, error: "As correções do histórico exigem o Firestore configurado." };
  }
  try {
    await setDoc(
      doc(db, "users", normalizedUid, HISTORY_OVERRIDES_COLLECTION, normalizedPartyId),
      buildOverrideDoc(normalizedPartyId, overrides, Date.now()),
    );
    return { ok: true };
  } catch (error: any) {
    return { ok: false, error: error?.message || "Não foi possível salvar a correção do histórico." };
  }
}

/**
 * Solicita finalização no backend. O documento é somente um comando durável:
 * a Function valida a versão mais recente, cria históricos e encerra a PT.
 */
export async function requestPartyFinalization(input: {
  partyId: string;
  reason: PartyFinalizationReason;
  requestedByUid: string;
  expectedRevision?: number;
}): Promise<{ ok: boolean; requestId?: string; error?: string }> {
  const partyId = String(input.partyId || "").trim();
  const requestedByUid = String(input.requestedByUid || "").trim();
  if (!partyId || !requestedByUid) {
    return { ok: false, error: "PT ou usuário inválido para finalização." };
  }

  if (isSimulationMode || !db) {
    return {
      ok: false,
      error: "A finalização por Cloud Function exige Firestore configurado; o modo simulação não processa jobs de backend.",
    };
  }

  const requestId = `party_finalization_${partyId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    await setDoc(doc(db, FINALIZATION_REQUESTS_COLLECTION, requestId), {
      id: requestId,
      partyId,
      reason: input.reason,
      requestedByUid,
      expectedRevision: Math.max(0, Math.floor(Number(input.expectedRevision) || 0)),
      state: "requested",
      clientRequestedAt: Date.now(),
      requestedAt: serverTimestamp(),
    });
    return { ok: true, requestId };
  } catch (error: any) {
    return { ok: false, error: error?.message || "Não foi possível solicitar a finalização da PT." };
  }
}