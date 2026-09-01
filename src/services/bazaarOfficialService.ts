import {
  collectionGroup,
  doc,
  getDoc,
  getDocs,
  runTransaction,
  serverTimestamp,
  writeBatch,
} from "firebase/firestore";
import { db } from "../firebase/config";

export interface OfficialBazaarCharacter {
  id: string;
  name: string;
  vocation: string;
  level: number;
  server: string;
  bid: number;
  currentValue: number;
  startingValue: number;
  hasBid: boolean;
  auctionEndTs: number | null;
  url: string;
  soulwarCompleted?: boolean | null;
  sanguineCompleted?: boolean | null;
  soulWarBossCount?: number;
  sanguineBossCount?: number;
  soulWarBossTotal?: number;
  sanguineBossTotal?: number;
}

export interface OfficialBazaarMetadata {
  schemaVersion: number;
  version: string;
  generatedAtMs: number;
  durationMs: number;
  totalCharacters: number;
  generatedByUid: string;
  generatedByName: string;
  status: "ready" | "failed";
  filters: Record<string, any>;
  /**
   * Completude da listagem que gerou esta lista oficial.
   *
   * `partial: true` significa que algumas paginas da API do Rubinot nao
   * responderam. Os personagens presentes sao validos, mas a lista NAO
   * cobre todo o Bazaar. Campos opcionais para nao quebrar documentos
   * antigos, que simplesmente nao os possuem.
   */
  partial?: boolean;
  loadedPageCount?: number;
  totalPages?: number;
  failedPageNumbers?: number[];
  /**
   * Personagens que falharam na analise individual e NAO entraram na lista.
   * Persistido junto com a lista oficial para que TODOS os usuarios vejam a
   * mesma informacao no quadro "Ultima Consulta", nao so quem rodou a consulta.
   */
  failedCharacters?: number;
  /**
   * Personagens que falharam, com nome e link, para que qualquer usuario possa
   * abrir o leilao manualmente. Vem junto dos metadados - sem consulta extra.
   * Limitado a 50 entradas para nao inflar o documento.
   */
  failedCharacterList?: { id: string; name: string; url: string }[];
}

export interface OfficialBazaarCache {
  schemaVersion: number;
  version: string;
  metadata: OfficialBazaarMetadata;
  characters: OfficialBazaarCharacter[];
  loadedAtMs: number;
}

export interface BazaarInterestUser {
  uid: string;
  name: string;
  auctionId: string;
  bazaarVersion: string;
  createdAtMs: number;
}

export type BazaarInterestMap = Record<string, BazaarInterestUser[]>;

/** Entrada como é gravada no documento agregado (sem repetir auctionId/version). */
interface StoredInterestEntry {
  uid: string;
  name: string;
  createdAtMs: number;
}

/** Documento único `bazaarInterests/current`. */
interface AggregatedInterestsDoc {
  bazaarVersion: string;
  updatedAtMs: number;
  byAuction: Record<string, StoredInterestEntry[]>;
}

export interface PublishOfficialBazaarResult {
  metadata: OfficialBazaarMetadata;
  /** true quando o documento agregado foi zerado no mesmo commit da lista. */
  interestsCleared: boolean;
  /**
   * Interesses PRESERVADOS pela publicação (leilões que seguem na lista
   * nova), já expandidos no formato da UI (`BazaarInterestMap`) — o chamador
   * atualiza a tela com este mapa em vez de zerar.
   */
  interests: BazaarInterestMap;
}

const OFFICIAL_CACHE_KEY = "rubinot_bazaar_official_cache";
const METADATA_CHECK_KEY = "rubinot_bazaar_last_metadata_check_at";
const MANUAL_SYNC_KEY = "rubinot_bazaar_last_manual_sync_at";
const INTERESTS_CACHE_KEY = "rubinot_bazaar_interests_cache";
const INTERESTS_CHECK_KEY = "rubinot_bazaar_last_interest_check_at";
const INTERESTS_COLLECTION = "bazaarInterests";
const INTERESTS_DOC_ID = "current";
/** Coleção legada (bazaarInterests/{auctionId}/interestedUsers) — só migração. */
const LEGACY_INTERESTS_SUBCOLLECTION = "interestedUsers";
const LEGACY_MIGRATION_KEY = "rubinot_bazaar_interests_legacy_migrated";
const CACHE_SCHEMA_VERSION = 1;
const AUTO_CHECK_INTERVAL_MS = 60 * 60 * 1000;
export const BAZAAR_MANUAL_SYNC_COOLDOWN_MS = 60 * 1000;

function now() {
  return Date.now();
}

function readNumber(key: string): number {
  try {
    const raw = localStorage.getItem(key);
    const value = raw ? Number(raw) : 0;
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function writeNumber(key: string, value: number) {
  try { localStorage.setItem(key, String(value)); } catch {}
}


function normalizeFirestoreId(value: unknown, fieldName: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${fieldName} inválido para caminho do Firestore.`);
  if (normalized.includes("/")) throw new Error(`${fieldName} não pode conter '/'.`);
  return normalized;
}

function normalizeBazaarVersion(value: unknown): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error("Versão oficial do Bazaar ausente.");
  return normalized;
}

function normalizeOfficialCharacter(character: OfficialBazaarCharacter): OfficialBazaarCharacter {
  return {
    ...character,
    id: normalizeFirestoreId(character.id, "auctionId"),
  };
}
export function getManualSyncCooldownRemainingMs(): number {
  const last = readNumber(MANUAL_SYNC_KEY);
  return Math.max(0, BAZAAR_MANUAL_SYNC_COOLDOWN_MS - (now() - last));
}

export function markManualSyncAttempt() {
  writeNumber(MANUAL_SYNC_KEY, now());
}

export function readOfficialBazaarCache(): OfficialBazaarCache | null {
  try {
    const raw = localStorage.getItem(OFFICIAL_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || parsed.schemaVersion !== CACHE_SCHEMA_VERSION || !parsed.version || !Array.isArray(parsed.characters)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveOfficialBazaarCache(cache: OfficialBazaarCache) {
  try { localStorage.setItem(OFFICIAL_CACHE_KEY, JSON.stringify(cache)); } catch {}
}

export function readBazaarInterestsCache(version?: string): { version: number; bazaarVersion: string; interests: BazaarInterestMap } | null {
  try {
    const raw = localStorage.getItem(INTERESTS_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed.version !== "number" || !parsed.interests) return null;
    // `bazaarVersion` divergente = interesses de uma consulta antiga: descarta.
    if (version && parsed.bazaarVersion !== version) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveBazaarInterestsCache(payload: { version: number; bazaarVersion: string; interests: BazaarInterestMap }) {
  try { localStorage.setItem(INTERESTS_CACHE_KEY, JSON.stringify(payload)); } catch {}
}

/** Descarta o cache local de interesses e força a próxima sincronização a reler. */
export function clearBazaarInterestsCache() {
  try { localStorage.removeItem(INTERESTS_CACHE_KEY); } catch {}
  writeNumber(INTERESTS_CHECK_KEY, 0);
}

/** Converte o documento agregado no mapa consumido pela UI. */
function expandAggregatedInterests(data: AggregatedInterestsDoc | null, bazaarVersion: string): BazaarInterestMap {
  if (!data || !data.byAuction) return {};
  // Invalida automaticamente interesses de uma consulta anterior.
  if (bazaarVersion && String(data.bazaarVersion || "") !== bazaarVersion) return {};
  const grouped: BazaarInterestMap = {};
  Object.entries(data.byAuction).forEach(([auctionId, entries]) => {
    if (!Array.isArray(entries) || entries.length === 0) return;
    const users = entries
      .filter(entry => entry && String(entry.uid || "").trim())
      .map(entry => ({
        uid: String(entry.uid),
        name: String(entry.name || "Usuário"),
        auctionId,
        bazaarVersion: String(data.bazaarVersion || ""),
        createdAtMs: Number(entry.createdAtMs || 0),
      }));
    if (users.length === 0) return;
    // Ordem de chegada preservada.
    users.sort((a, b) => (a.createdAtMs || 0) - (b.createdAtMs || 0));
    grouped[auctionId] = users;
  });
  return grouped;
}

/**
 * Remove leilões sem interessados para o documento não crescer indefinidamente.
 * Retorna um novo objeto — nunca muta a entrada.
 */
function compactByAuction(byAuction: Record<string, StoredInterestEntry[]>): Record<string, StoredInterestEntry[]> {
  const compacted: Record<string, StoredInterestEntry[]> = {};
  Object.entries(byAuction || {}).forEach(([auctionId, entries]) => {
    if (Array.isArray(entries) && entries.length > 0) compacted[auctionId] = entries;
  });
  return compacted;
}

/**
 * Lê o documento agregado dentro de uma transação e descarta o conteúdo quando
 * ele pertence a outra versão do Bazaar (auto-invalidação por `bazaarVersion`).
 */
function readAggregateForVersion(snap: any, bazaarVersion: string): Record<string, StoredInterestEntry[]> {
  if (!snap.exists()) return {};
  const data = snap.data() as AggregatedInterestsDoc;
  if (String(data?.bazaarVersion || "") !== bazaarVersion) return {};
  return compactByAuction(data?.byAuction || {});
}

export function shouldAutoCheckOfficialBazaar(): boolean {
  const last = readNumber(METADATA_CHECK_KEY);
  return now() - last >= AUTO_CHECK_INTERVAL_MS;
}

export function shouldAutoCheckBazaarInterests(): boolean {
  const last = readNumber(INTERESTS_CHECK_KEY);
  return now() - last >= AUTO_CHECK_INTERVAL_MS;
}

/**
 * Publica a nova lista oficial e zera os interesses.
 *
 * A chamada só deve acontecer quando 100% da consulta terminou sem erros —
 * o chamador é responsável por essa validação.
 *
 * Como os interesses agora vivem em UM único documento, o batch tem sempre
 * exatamente 3 escritas (lista + metadados + interesses), muito abaixo do
 * limite de 500. A atomicidade é incondicional: ou os três documentos são
 * aplicados, ou nenhum é — se o commit falhar, a lista anterior E os
 * interesses anteriores permanecem intactos.
 */
export async function publishOfficialBazaarList(params: {
  characters: OfficialBazaarCharacter[];
  durationMs: number;
  generatedByUid: string;
  generatedByName: string;
  filters: Record<string, any>;
  partial?: boolean;
  loadedPageCount?: number;
  totalPages?: number;
  failedPageNumbers?: number[];
  failedCharacters?: number;
  failedCharacterList?: { id: string; name: string; url: string }[];
}): Promise<PublishOfficialBazaarResult | null> {
  if (!db) return null;
  const version = new Date().toISOString();
  const generatedAtMs = now();
  const characters = params.characters.map(normalizeOfficialCharacter);
  const metadata: OfficialBazaarMetadata = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    version,
    generatedAtMs,
    durationMs: params.durationMs,
    totalCharacters: characters.length,
    generatedByUid: params.generatedByUid,
    generatedByName: params.generatedByName,
    status: "ready",
    filters: params.filters,
    // Sinalizacao de lista parcial. Sempre gravada (mesmo `false`) para que
    // uma publicacao completa LIMPE a marca de uma parcial anterior.
    partial: params.partial === true,
    loadedPageCount: Number(params.loadedPageCount || 0),
    totalPages: Number(params.totalPages || 0),
    failedPageNumbers: Array.isArray(params.failedPageNumbers) ? params.failedPageNumbers : [],
    // Sempre gravado (mesmo 0) para que uma consulta limpa apague a contagem
    // de falhas da publicacao anterior.
    failedCharacters: Math.max(0, Number(params.failedCharacters || 0)),
    // Sempre gravado (mesmo vazio) para limpar a lista da publicacao anterior.
    failedCharacterList: (Array.isArray(params.failedCharacterList) ? params.failedCharacterList : [])
      .slice(0, 50)
      .map((entry) => ({
        id: String(entry?.id || ""),
        name: String(entry?.name || ""),
        url: String(entry?.url || ""),
      }))
      .filter((entry) => entry.url),
  };

  const batch = writeBatch(db);
  batch.set(doc(db, "bazaar", "current"), {
    schemaVersion: CACHE_SCHEMA_VERSION,
    version,
    generatedAtMs,
    characters,
    updatedAt: serverTimestamp(),
  });
  batch.set(doc(db, "bazaar", "metadata"), {
    ...metadata,
    generatedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  // ── INTERESSES: NOVA CONSULTA, ESTADO INICIAL VAZIO ─────────────────────
  // O Bazaar rotaciona a lista diariamente (~10:05): os personagens da
  // consulta anterior deixam de existir e os interesses daquela consulta não
  // fazem mais sentido. O agregado é recriado VAZIO já na nova versão — um
  // `set` sem merge descarta todo o `byAuction` anterior, sem varredura e
  // sem órfãos. Todos os usuários veem a nova lista sem interesses marcados,
  // independente de estarem online (o documento é global). O resíduo do
  // backend (marcadores/notificações da consulta anterior) é limpo pela
  // Cloud Function `bazaarListCleanup`, disparada por esta publicação.
  batch.set(doc(db, INTERESTS_COLLECTION, INTERESTS_DOC_ID), {
    bazaarVersion: version,
    updatedAtMs: generatedAtMs,
    byAuction: {},
    updatedAt: serverTimestamp(),
  });
  // Commit único: lista oficial + metadados + interesses zerados.
  await batch.commit();

  const cache = { schemaVersion: CACHE_SCHEMA_VERSION, version, metadata, characters, loadedAtMs: now() };
  saveOfficialBazaarCache(cache);
  writeNumber(METADATA_CHECK_KEY, now());
  // Cache local reflete a nova versão vazia — dispensa releitura.
  saveBazaarInterestsCache({ version: generatedAtMs, bazaarVersion: version, interests: {} });
  writeNumber(INTERESTS_CHECK_KEY, now());

  return { metadata, interestsCleared: true, interests: {} };
}

export async function syncOfficialBazaarList(options: { force?: boolean } = {}): Promise<{ cache: OfficialBazaarCache | null; changed: boolean; skipped: boolean; error?: string }> {
  const local = readOfficialBazaarCache();
  if (!db) return { cache: local, changed: false, skipped: true, error: "Firestore indisponível." };
  if (!options.force && local && !shouldAutoCheckOfficialBazaar()) return { cache: local, changed: false, skipped: true };

  try {
    const metadataSnap = await getDoc(doc(db, "bazaar", "metadata"));
    writeNumber(METADATA_CHECK_KEY, now());
    if (!metadataSnap.exists()) return { cache: local, changed: false, skipped: false };
    const metadata = metadataSnap.data() as OfficialBazaarMetadata;
    if (local && local.version === metadata.version) return { cache: { ...local, metadata }, changed: false, skipped: false };

    const currentSnap = await getDoc(doc(db, "bazaar", "current"));
    if (!currentSnap.exists()) return { cache: local, changed: false, skipped: false, error: "Lista oficial não encontrada." };
    const current = currentSnap.data() as any;
    const characters = Array.isArray(current.characters) ? current.characters.map((character: OfficialBazaarCharacter) => ({ ...character, id: String(character.id ?? "") })) : [];
    const cache: OfficialBazaarCache = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      version: metadata.version,
      metadata,
      characters,
      loadedAtMs: now(),
    };
    saveOfficialBazaarCache(cache);
    return { cache, changed: true, skipped: false };
  } catch (error: any) {
    return { cache: local, changed: false, skipped: false, error: error?.message || String(error) };
  }
}

/**
 * MIGRAÇÃO (uma vez por dispositivo): importa a estrutura legada
 * `bazaarInterests/{auctionId}/interestedUsers/{uid}` para o documento
 * agregado, sem perder nenhum interesse já registrado.
 *
 * Roda apenas quando o agregado ainda não existe. A escrita é feita por
 * transação, então uma migração concorrente de outro cliente não duplica nem
 * sobrescreve dados.
 */
async function migrateLegacyInterests(bazaarVersion: string): Promise<Record<string, StoredInterestEntry[]> | null> {
  if (!db) return null;
  if (readNumber(LEGACY_MIGRATION_KEY) > 0) return null;
  try {
    const legacySnap = await getDocs(collectionGroup(db, LEGACY_INTERESTS_SUBCOLLECTION));
    writeNumber(LEGACY_MIGRATION_KEY, now());
    if (legacySnap.empty) return null;

    const byAuction: Record<string, StoredInterestEntry[]> = {};
    legacySnap.docs.forEach(item => {
      // Segurança: só documentos que realmente pertencem a bazaarInterests.
      if (item.ref.parent.parent?.parent.id !== INTERESTS_COLLECTION) return;
      const data = item.data() as BazaarInterestUser;
      // Preserva apenas o que pertence à consulta vigente.
      if (String(data?.bazaarVersion || "") !== bazaarVersion) return;
      const auctionId = String(data?.auctionId || item.ref.parent.parent?.id || "").trim();
      const uid = String(data?.uid || item.id || "").trim();
      if (!auctionId || !uid) return;
      if (!byAuction[auctionId]) byAuction[auctionId] = [];
      if (byAuction[auctionId].some(entry => entry.uid === uid)) return;
      byAuction[auctionId].push({ uid, name: String(data?.name || "Usuário"), createdAtMs: Number(data?.createdAtMs || 0) });
    });

    Object.values(byAuction).forEach(entries => entries.sort((a, b) => (a.createdAtMs || 0) - (b.createdAtMs || 0)));
    const compacted = compactByAuction(byAuction);
    if (Object.keys(compacted).length === 0) return null;

    const ref = doc(db, INTERESTS_COLLECTION, INTERESTS_DOC_ID);
    await runTransaction(db, async tx => {
      const snap = await tx.get(ref);
      // Se o agregado já foi criado nesse meio-tempo, não sobrescreve.
      if (snap.exists() && String((snap.data() as AggregatedInterestsDoc)?.bazaarVersion || "") === bazaarVersion) return;
      tx.set(ref, { bazaarVersion, updatedAtMs: now(), byAuction: compacted, updatedAt: serverTimestamp() });
    });
    return compacted;
  } catch {
    // Falha de migração (ex.: regra do collection group) nunca quebra a leitura.
    writeNumber(LEGACY_MIGRATION_KEY, now());
    return null;
  }
}

/**
 * Carrega todos os interesses com UMA única leitura do documento agregado.
 *
 * `options.auctionIds` é aceito por compatibilidade de assinatura, mas não é
 * mais usado: o documento agregado traz tudo de uma vez.
 */
export async function syncBazaarInterests(bazaarVersion: string, options: { force?: boolean; auctionIds?: string[] } = {}): Promise<{ interests: BazaarInterestMap; version: number; changed: boolean; skipped: boolean; error?: string }> {
  const normalizedBazaarVersion = normalizeBazaarVersion(bazaarVersion);
  const local = readBazaarInterestsCache(normalizedBazaarVersion);
  if (!db) return { interests: local?.interests || {}, version: local?.version || 0, changed: false, skipped: true, error: "Firestore indisponível." };
  if (!options.force && local && !shouldAutoCheckBazaarInterests()) return { interests: local.interests, version: local.version, changed: false, skipped: true };

  try {
    // LEITURA ÚNICA. Antes: 1 (metadata) + N (collection group) + até N diretas.
    const snap = await getDoc(doc(db, INTERESTS_COLLECTION, INTERESTS_DOC_ID));
    writeNumber(INTERESTS_CHECK_KEY, now());

    if (!snap.exists()) {
      const migrated = await migrateLegacyInterests(normalizedBazaarVersion);
      const interests = expandAggregatedInterests(
        migrated ? { bazaarVersion: normalizedBazaarVersion, updatedAtMs: now(), byAuction: migrated } : null,
        normalizedBazaarVersion,
      );
      const version = now();
      saveBazaarInterestsCache({ version, bazaarVersion: normalizedBazaarVersion, interests });
      return { interests, version, changed: true, skipped: false };
    }

    const data = snap.data() as AggregatedInterestsDoc;
    // `updatedAtMs` funciona como versão: muda a cada escrita no agregado.
    const version = Number(data?.updatedAtMs || 0);
    const interests = expandAggregatedInterests(data, normalizedBazaarVersion);
    saveBazaarInterestsCache({ version, bazaarVersion: normalizedBazaarVersion, interests });
    return { interests, version, changed: version !== (local?.version || 0), skipped: false };
  } catch (error: any) {
    return { interests: local?.interests || {}, version: local?.version || 0, changed: false, skipped: false, error: error?.message || String(error) };
  }
}


/**
 * Aplica uma mutação no documento agregado dentro de uma transação.
 *
 * A transação garante que cliques simultâneos de usuários diferentes não se
 * percam: se o documento mudar entre a leitura e a escrita, o Firestore
 * repete a função automaticamente sobre o estado mais recente.
 *
 * Retorna o mapa já expandido, permitindo que a UI atualize sem nova leitura.
 */
async function mutateAggregatedInterests(
  bazaarVersion: string,
  mutate: (byAuction: Record<string, StoredInterestEntry[]>) => Record<string, StoredInterestEntry[]> | null,
): Promise<BazaarInterestMap> {
  if (!db) throw new Error("Firestore indisponível.");
  const ref = doc(db, INTERESTS_COLLECTION, INTERESTS_DOC_ID);
  let finalByAuction: Record<string, StoredInterestEntry[]> = {};

  await runTransaction(db, async tx => {
    const snap = await tx.get(ref);
    // Conteúdo de outra versão do Bazaar é descartado automaticamente.
    const current = readAggregateForVersion(snap, bazaarVersion);
    const mutated = mutate(current);
    if (mutated === null) {
      // Nada mudou (duplicata ou remoção inexistente): não gasta escrita.
      finalByAuction = current;
      return;
    }
    // Compacta: leilões sem interessados somem do documento.
    finalByAuction = compactByAuction(mutated);
    tx.set(ref, {
      bazaarVersion,
      updatedAtMs: now(),
      byAuction: finalByAuction,
      updatedAt: serverTimestamp(),
    });
  });

  const interests = expandAggregatedInterests(
    { bazaarVersion, updatedAtMs: now(), byAuction: finalByAuction },
    bazaarVersion,
  );
  saveBazaarInterestsCache({ version: now(), bazaarVersion, interests });
  return interests;
}

/** Marca interesse. Ignora duplicatas e preserva a ordem de chegada. */
export async function setBazaarInterest(params: { auctionId: string | number; bazaarVersion: string; uid: string; name: string }): Promise<BazaarInterestMap> {
  const auctionId = normalizeFirestoreId(params.auctionId, "auctionId");
  const uid = normalizeFirestoreId(params.uid, "uid");
  const bazaarVersion = normalizeBazaarVersion(params.bazaarVersion);
  const name = String(params.name || "Usuário").trim().slice(0, 80) || "Usuário";

  return mutateAggregatedInterests(bazaarVersion, byAuction => {
    const entries = byAuction[auctionId] || [];
    // Já registrado: sem duplicação e sem escrita.
    if (entries.some(entry => entry.uid === uid)) return null;
    return {
      ...byAuction,
      // Append no fim mantém a ordem de chegada.
      [auctionId]: [...entries, {
        uid,
        name,
        // Momento REAL da ação (relógio do servidor — referência confiável
        // já usada no projeto). O `createdAtMs` local continua para a UI
        // otimista; a leitura prefere o valor do servidor (ver
        // getInterestCreatedAtMs no painel).
        createdAt: serverTimestamp(),
        createdAtMs: now(),
      }],
    };
  });
}

/** Remove o interesse do usuário. `bazaarVersion` mantém o alvo correto. */
export async function removeBazaarInterest(params: { auctionId: string | number; uid: string; bazaarVersion: string }): Promise<BazaarInterestMap> {
  const auctionId = normalizeFirestoreId(params.auctionId, "auctionId");
  const uid = normalizeFirestoreId(params.uid, "uid");
  const bazaarVersion = normalizeBazaarVersion(params.bazaarVersion);

  return mutateAggregatedInterests(bazaarVersion, byAuction => {
    const entries = byAuction[auctionId] || [];
    const next = entries.filter(entry => entry.uid !== uid);
    // Nada a remover: sem escrita.
    if (next.length === entries.length) return null;
    const updated = { ...byAuction, [auctionId]: next };
    // Leilão sem interessados é removido pelo compactByAuction.
    return updated;
  });
}