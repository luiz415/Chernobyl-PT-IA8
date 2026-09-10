import { deleteField, doc, serverTimestamp, setDoc } from "firebase/firestore";
import { db, isSimulationMode, onSnapshot } from "../firebase/config";
import { sanitizeRtcEntryMap, type RtcEntry, type RtcEntryMap } from "../constants/rtcImports";

// ============================================================================
// IMPORT RTC — PERSISTÊNCIA (Firestore)
// ----------------------------------------------------------------------------
// Duas fontes de dados, ambas com UM documento por escopo (custo mínimo):
//
//   • `rtcImports/recommended`
//       Perfis RECOMENDADOS pelo aplicativo. Documento ÚNICO e global:
//       todos os usuários aprovados leem; SOMENTE Boss escreve (garantido
//       também nas regras do Firestore — ver firestore.rules).
//
//   • `userRtcImports/{uid}`
//       Perfis PESSOAIS. Um documento por usuário, vinculado à conta
//       autenticada — sincroniza automaticamente entre computador, notebook,
//       celular e qualquer outro dispositivo logado. Só o próprio usuário
//       lê/escreve (regras do Firestore).
//
// Formato dos documentos: `{ entries: { "<chave composta>": RtcEntry } }`.
// A chave composta ("quest|voc|divisão|tipo") cobre TODAS as combinações num
// único mapa — 1 leitura carrega tudo, 1 escrita (merge) altera só um perfil.
//
// CUSTO FIRESTORE: os listeners são assinados apenas ENQUANTO O MODAL ESTÁ
// ABERTO (1 leitura inicial por doc + deltas). Nenhuma leitura em background.
//
// DECISÃO — SEM CLOUD FUNCTIONS: leitura/escrita direta com regras de
// segurança cobre 100% dos requisitos (validação de papel Boss, propriedade
// do doc pessoal, limites de tamanho). Uma CF só adicionaria latência e
// custo de invocação sem nenhum ganho real.
//
// CÓDIGO LITERAL: nenhuma função aqui altera o conteúdo dos códigos —
// vírgulas, pontos, pipes `|`, `;` e demais caracteres são persistidos e
// devolvidos exatamente como recebidos.
//
// MODO SIMULAÇÃO (sem Firebase): os perfis pessoais caem num fallback de
// localStorage para o app continuar utilizável em sandbox; os recomendados
// ficam vazios (não há como compartilhar sem backend).
// ============================================================================

const RECOMMENDED_COLLECTION = "rtcImports";
const RECOMMENDED_DOC_ID = "recommended";
const PERSONAL_COLLECTION = "userRtcImports";

/** Chave do fallback local (apenas modo simulação). */
function simulationKey(uid: string): string {
  return `rtc_imports_personal_${uid || "anon"}`;
}

function readSimulationPersonal(uid: string): RtcEntryMap {
  try {
    const raw = localStorage.getItem(simulationKey(uid));
    return sanitizeRtcEntryMap(raw ? JSON.parse(raw) : null);
  } catch {
    return {};
  }
}

function writeSimulationPersonal(uid: string, entries: RtcEntryMap) {
  try {
    localStorage.setItem(simulationKey(uid), JSON.stringify(entries));
  } catch {}
}

/**
 * Assina os perfis RECOMENDADOS. Retorna o unsubscribe.
 * Erros (ex.: permissão) entregam mapa vazio — o modal segue utilizável.
 */
export function subscribeRecommendedRtc(onData: (entries: RtcEntryMap) => void): () => void {
  if (isSimulationMode || !db) {
    onData({});
    return () => {};
  }
  const ref = doc(db, RECOMMENDED_COLLECTION, RECOMMENDED_DOC_ID);
  return onSnapshot(
    ref,
    snap => onData(sanitizeRtcEntryMap(snap.exists() ? (snap.data() as any)?.entries : null)),
    () => onData({}),
  );
}

/** Assina os perfis PESSOAIS do usuário autenticado. Retorna o unsubscribe. */
export function subscribePersonalRtc(uid: string, onData: (entries: RtcEntryMap) => void): () => void {
  if (!uid) {
    onData({});
    return () => {};
  }
  if (isSimulationMode || !db) {
    onData(readSimulationPersonal(uid));
    return () => {};
  }
  const ref = doc(db, PERSONAL_COLLECTION, uid);
  return onSnapshot(
    ref,
    snap => onData(sanitizeRtcEntryMap(snap.exists() ? (snap.data() as any)?.entries : null)),
    () => onData({}),
  );
}

/**
 * Grava (ou remove, com `entry === null`) UM perfil recomendado.
 * Escrita com merge: altera somente a chave informada. A autorização real
 * (papel Boss) é imposta pelas regras do Firestore — o frontend apenas
 * esconde os controles de quem não pode editar.
 */
export async function saveRecommendedRtcEntry(key: string, entry: RtcEntry | null): Promise<boolean> {
  if (isSimulationMode || !db) return false;
  try {
    await setDoc(
      doc(db, RECOMMENDED_COLLECTION, RECOMMENDED_DOC_ID),
      { entries: { [key]: entry ?? deleteField() }, updatedAt: serverTimestamp() },
      { merge: true },
    );
    return true;
  } catch {
    return false;
  }
}

/** Grava (ou remove, com `entry === null`) UM perfil pessoal do usuário. */
export async function savePersonalRtcEntry(uid: string, key: string, entry: RtcEntry | null, currentEntries?: RtcEntryMap): Promise<boolean> {
  if (!uid) return false;
  if (isSimulationMode || !db) {
    // Fallback local do modo simulação — precisa do mapa atual para reescrever.
    const next = { ...(currentEntries || readSimulationPersonal(uid)) };
    if (entry) next[key] = entry; else delete next[key];
    writeSimulationPersonal(uid, next);
    return true;
  }
  try {
    await setDoc(
      doc(db, PERSONAL_COLLECTION, uid),
      { uid, entries: { [key]: entry ?? deleteField() }, updatedAt: serverTimestamp() },
      { merge: true },
    );
    return true;
  } catch {
    return false;
  }
}
