// ============================================================================
// HISTÓRICO OFICIAL DO BAZAAR — persistência incremental e métricas (Firestore)
// ----------------------------------------------------------------------------
// ARQUITETURA (ver também src/utils/bazaarHistoryStats.ts):
//
//   • `bazaar/historySync` (DOC ÚNICO de estado): fronteira incremental
//     (`lastEndTs` + ids recentes na margem), metadados dos meses existentes
//     (contagem por servidor, updatedAtMs) e o resumo da última consulta.
//     É o ÚNICO documento que a tela precisa ler para saber o que existe —
//     1 leitura (com cache local + TTL) por abertura.
//
//   • `bazaarHistoryRaw/{auctionId}` (BASE HISTÓRICA, 1 doc por LEILÃO):
//     o ID do documento é o identificador ESTÁVEL do leilão fornecido pelo
//     histórico do RubinOT — regravar o mesmo leilão sobrescreve o MESMO
//     documento (idempotência física; nada duplica, em nenhuma hipótese).
//     Cada doc carrega a entrada completa + campos de partição (`day`,
//     `ym`, `server`, `endTs`) para range-queries/reagregações futuras.
//     Nenhum documento cresce com o tempo: o limite de 1 MiB/doc do
//     Firestore fica a ordens de grandeza de distância (um leilão ≈ 1-3 KB)
//     e ainda há um guarda defensivo de tamanho individual por documento.
//     A tela NUNCA lê esta coleção; ela é a fonte permanente/auditoria.
//
//   • `bazaarHistoryMetrics/{YYYY-MM__servidor}` (MÉTRICAS, 1 doc por MÊS ×
//     SERVIDOR): células dimensionais pré-agregadas + mapa `ids` com os
//     leilões JÁ CONTABILIZADOS naquele doc. O `ids` é a segunda linha de
//     defesa da idempotência: mesmo que a mesma entrada chegue duas vezes
//     (repetição de consulta, recarga completa de 30 dias, retomada após
//     falha parcial), ela é contada UMA única vez — a fusão só agrega
//     entradas cujo id ainda não está no documento. A tela lê SOMENTE
//     esses docs (cache local invalidado por `updatedAtMs`; o mapa `ids`
//     NÃO vai para o cache da tela — só as células).
//
// ── GRAVAÇÃO EM LOTES SEGUROS (correção do estouro de payload) ─────────────
// O Firestore impõe DOIS limites independentes: ~500 operações por
// `writeBatch` e ~10 MiB por requisição de commit. Fatiar apenas por
// quantidade de documentos NÃO basta (o tamanho de cada leilão varia);
// os lotes daqui fecham pelo que vier primeiro:
//   • `MAX_BATCH_OPS` operações, OU
//   • `MAX_BATCH_BYTES` de payload ESTIMADO (UTF-8 real via TextEncoder,
//     com folga de segurança larga sobre o limite de 10 MiB).
// Cada lote tem uma retentativa automática; uma falha definitiva NÃO perde
// os lotes anteriores (já commitados) e o resultado informa exatamente
// quantos leilões foram persistidos e quantos faltaram. A retomada NÃO
// exige repetir a consulta no site: as mesmas entradas podem ser
// reenviadas a esta função (botão "Tentar gravar novamente" da tela) — a
// base bruta regrava por id (idempotente) e as métricas pulam ids já
// contabilizados.
//
// ── ORDEM DAS FASES (recuperação de falhas) ────────────────────────────────
//   1. BASE BRUTA em lotes — falhou? métricas/estado não rodam; retomada
//      regrava por id sem duplicar.
//   2. MÉTRICAS doc a doc (leitura da verdade → filtra por `ids` → funde →
//      grava) — falha em um doc não impede os demais; docs com falha são
//      listados e o ESTADO NÃO AVANÇA (a retomada reaplica só o que falta,
//      e os docs já aplicados pulam pelos `ids`).
//   3. ESTADO (fronteira + índice de meses) — só após 100% das fases 1-2.
//      Se falhar, a retomada repete as fases (1 = sobrescrita idempotente,
//      2 = tudo pulado pelos `ids`) e conclui o estado.
// A consulta só é apresentada como SUCESSO quando as três fases terminam.
//
// CUSTOS: a prioridade do projeto é economizar LEITURAS/ESCRITAS, não
// bytes. Leituras por ingestão: 1 estado + 1 por doc de métricas afetado.
// Escritas: 1 por leilão NOVO (base bruta) + docs de métricas afetados +
// 1 estado. Primeira carga (~15 mil leilões): ~15 mil escritas ÚNICAS —
// centavos, uma vez só; incrementais diários: dezenas. NENHUMA releitura
// da base bruta é necessária para deduplicar.
// ============================================================================

import { doc, getDoc, setDoc, writeBatch } from "firebase/firestore";
import { db } from "../firebase/config";
import {
  addEntryToCell,
  dayKeyFromTs,
  emptyMetricCell,
  mergeCellInto,
  metricCellKey,
  monthKeyFromTs,
  HISTORY_INCREMENTAL_MARGIN_SECONDS,
  type BazaarHistoryEntry,
  type MetricCell,
  type MetricsDocData,
} from "../utils/bazaarHistoryStats";

const SYNC_DOC = ["bazaar", "historySync"] as const;
const RAW_COLLECTION = "bazaarHistoryRaw";
const METRICS_COLLECTION = "bazaarHistoryMetrics";

const SYNC_CACHE_KEY = "rubinot_bazaar_history_sync_cache";
const SYNC_CHECKED_KEY = "rubinot_bazaar_history_sync_checked_at";
const METRICS_CACHE_PREFIX = "rubinot_bazaar_history_metrics_";
/** Intervalo mínimo entre releituras automáticas do doc de estado. */
const SYNC_TTL_MS = 5 * 60 * 1000;

// ── Limites de segurança da gravação (ver cabeçalho) ───────────────────────
/** Operações por writeBatch (limite do Firestore: 500). */
export const MAX_BATCH_OPS = 300;
/** Payload estimado por commit (limite da API: ~10 MiB) — folga de ~3×. */
export const MAX_BATCH_BYTES = 3_500_000;
/** Tamanho individual máximo aceito por documento (limite: ~1 MiB). */
export const MAX_DOC_BYTES = 900_000;
/** Overhead estimado por documento (nome do doc, índices, envelope). */
const DOC_OVERHEAD_BYTES = 256;

// ── Tipos ───────────────────────────────────────────────────────────────────

export interface HistoryRunInfo {
  startedAtMs: number;
  durationMs: number;
  listedCount: number;
  approvedNewCount: number;
  knownSkippedCount: number;
  analyzedCount: number;
  failedCount: number;
  stoppedManually: boolean;
  routeUsed?: string;
  pagesScanned?: number;
  processedMaxEndTs?: number;
}

export interface HistoryMonthMeta {
  count: number;
  servers: string[];
  updatedAtMs: number;
  /** Contagem POR SERVIDOR, espelhada do próprio doc de métricas (auto-corretiva). */
  serverCounts?: Record<string, number>;
}

export interface HistorySyncState {
  schemaVersion: number;
  /** Fronteira incremental: maior data de término já processada (s). */
  lastEndTs: number;
  /** Ids processados com endTs dentro da margem da fronteira (id → endTs). */
  recent: Record<string, number>;
  /** Metadados por mês 'YYYY-MM' — o índice que a tela usa. */
  months: Record<string, HistoryMonthMeta>;
  /** Total acumulado de leilões na base histórica. */
  totalCount: number;
  lastRun?: HistoryRunInfo;
}

/** Fase em que a ingestão terminou (ou falhou). */
export type IngestionPhase = "raw" | "metrics" | "state" | "done";

/** Progresso da gravação, para a tela exibir "lote X de Y". */
export type IngestionProgress = (phase: IngestionPhase, done: number, total: number) => void;

export interface IngestionResult {
  ok: boolean;
  state: HistorySyncState | null;
  /** Última fase executada ('done' = sucesso completo). */
  phase: IngestionPhase;
  /** Leilões efetivamente gravados na base bruta NESTA chamada. */
  rawDocsWritten: number;
  /** Leilões que NÃO chegaram a ser gravados (lote com falha + restantes). */
  rawFailedCount: number;
  /** Lotes commitados / total de lotes planejados. */
  rawBatchesDone: number;
  rawBatchesTotal: number;
  metricDocsWritten: number;
  metricDocsRead: number;
  /** Docs de métricas que falharam nesta chamada (retomada reaplica só eles). */
  failedMetricDocIds: string[];
  /** Leilões contabilizados nas métricas AGORA (primeira vez). */
  addedToMetrics: number;
  /** Leilões que as métricas já conheciam (pulados pelos `ids`). */
  alreadyInMetrics: number;
  error?: string;
}

function emptySyncState(): HistorySyncState {
  return { schemaVersion: 1, lastEndTs: 0, recent: {}, months: {}, totalCount: 0 };
}

function emptyResult(state: HistorySyncState | null, phase: IngestionPhase): IngestionResult {
  return {
    ok: false, state, phase,
    rawDocsWritten: 0, rawFailedCount: 0, rawBatchesDone: 0, rawBatchesTotal: 0,
    metricDocsWritten: 0, metricDocsRead: 0, failedMetricDocIds: [],
    addedToMetrics: 0, alreadyInMetrics: 0,
  };
}

function now(): number { return Date.now(); }

function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

function readNumber(key: string): number {
  try {
    const value = Number(localStorage.getItem(key) || 0);
    return Number.isFinite(value) ? value : 0;
  } catch { return 0; }
}
function writeNumber(key: string, value: number): void {
  try { localStorage.setItem(key, String(value)); } catch { /* storage indisponível */ }
}

// ── Estimativa de tamanho (UTF-8 real) ─────────────────────────────────────

const utf8 = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

/** Bytes UTF-8 estimados de um documento serializado + overhead do envelope. */
export function estimateDocBytes(data: unknown): number {
  try {
    const json = JSON.stringify(data) || "";
    const bytes = utf8 ? utf8.encode(json).length : Math.ceil(json.length * 1.2);
    return bytes + DOC_OVERHEAD_BYTES;
  } catch {
    return MAX_DOC_BYTES; // ilegível → trate como grande (nunca deve ocorrer)
  }
}

/** Remove chaves `undefined` (o Firestore as rejeita). */
function sanitizeEntryForWrite(entry: BazaarHistoryEntry): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (value === undefined) continue;
    output[key] = value;
  }
  return output;
}

/**
 * Documento da base bruta de UM leilão. Guarda a entrada completa (bytes não
 * são o problema) + campos de partição no topo. GUARDA DEFENSIVO: se um
 * leilão específico ultrapassar o limite individual do Firestore (na prática
 * impossível — um leilão tem ~1-3 KB), os campos opcionais mais pesados são
 * podados EM ORDEM e o doc registra o que foi podado em `truncatedFields`
 * (o leilão NUNCA é descartado por tamanho).
 */
export function buildRawAuctionDoc(entry: BazaarHistoryEntry): { data: Record<string, unknown>; bytes: number } {
  const base: Record<string, unknown> = {
    ...sanitizeEntryForWrite(entry),
    day: dayKeyFromTs(entry.endTs),
    ym: monthKeyFromTs(entry.endTs),
    updatedAtMs: now(),
  };
  let bytes = estimateDocBytes(base);
  if (bytes <= MAX_DOC_BYTES) return { data: base, bytes };
  const truncated: string[] = [];
  for (const field of ["matches", "skills", "statusText", "detailError"]) {
    if (!(field in base)) continue;
    delete base[field];
    truncated.push(field);
    base.truncatedFields = truncated;
    bytes = estimateDocBytes(base);
    if (bytes <= MAX_DOC_BYTES) break;
  }
  return { data: base, bytes };
}

/**
 * Fatia as entradas em LOTES SEGUROS: cada lote fecha ao atingir
 * `MAX_BATCH_OPS` operações OU `MAX_BATCH_BYTES` de payload estimado —
 * o que vier primeiro. A quantidade de leilões por lote é, portanto,
 * dinâmica: leilões maiores → lotes menores.
 */
export function sliceIntoSafeBatches(
  entries: BazaarHistoryEntry[],
): { entries: BazaarHistoryEntry[]; docs: Record<string, unknown>[]; bytes: number }[] {
  const batches: { entries: BazaarHistoryEntry[]; docs: Record<string, unknown>[]; bytes: number }[] = [];
  let current: { entries: BazaarHistoryEntry[]; docs: Record<string, unknown>[]; bytes: number } = { entries: [], docs: [], bytes: 0 };
  for (const entry of entries) {
    const { data, bytes } = buildRawAuctionDoc(entry);
    if (current.entries.length > 0
      && (current.entries.length >= MAX_BATCH_OPS || current.bytes + bytes > MAX_BATCH_BYTES)) {
      batches.push(current);
      current = { entries: [], docs: [], bytes: 0 };
    }
    current.entries.push(entry);
    current.docs.push(data);
    current.bytes += bytes;
  }
  if (current.entries.length > 0) batches.push(current);
  return batches;
}

// ── Estado de sincronização (doc único, cache local + TTL) ─────────────────

export function readSyncStateCache(): HistorySyncState | null {
  try {
    const raw = localStorage.getItem(SYNC_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || typeof parsed.lastEndTs !== "number") return null;
    return parsed as HistorySyncState;
  } catch { return null; }
}

function writeSyncStateCache(state: HistorySyncState): void {
  try { localStorage.setItem(SYNC_CACHE_KEY, JSON.stringify(state)); } catch { /* quota */ }
}

/**
 * Lê o estado de sincronização. Cache local responde na hora; o Firestore
 * só é consultado após o TTL (ou com `force` — obrigatório antes de uma
 * ingestão, para a fronteira incremental estar fresca).
 */
export async function loadHistorySyncState(options: { force?: boolean } = {}): Promise<{ state: HistorySyncState | null; error?: string }> {
  const local = readSyncStateCache();
  if (!db) return { state: local, error: "Firestore indisponível." };
  if (!options.force && local && now() - readNumber(SYNC_CHECKED_KEY) < SYNC_TTL_MS) {
    return { state: local };
  }
  try {
    const snap = await getDoc(doc(db, SYNC_DOC[0], SYNC_DOC[1]));
    writeNumber(SYNC_CHECKED_KEY, now());
    if (!snap.exists()) return { state: local };
    const data = snap.data() as HistorySyncState;
    if (!data || typeof data.lastEndTs !== "number") return { state: local };
    writeSyncStateCache(data);
    return { state: data };
  } catch (error: any) {
    return { state: local, error: String(error?.message || error) };
  }
}

// ── Métricas: leitura com cache por documento ───────────────────────────────

interface MetricsDocCache { updatedAtMs: number; data: MetricsDocData }

function readMetricsDocCache(docId: string): MetricsDocCache | null {
  try {
    const raw = localStorage.getItem(METRICS_CACHE_PREFIX + docId);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.data?.cells) return null;
    return parsed as MetricsDocCache;
  } catch { return null; }
}

function writeMetricsDocCache(docId: string, cache: MetricsDocCache): void {
  try { localStorage.setItem(METRICS_CACHE_PREFIX + docId, JSON.stringify(cache)); } catch { /* quota: cache é opcional */ }
}

/**
 * Busca os documentos de métricas dos meses pedidos. Cada doc só é RELIDO
 * do Firestore quando o `updatedAtMs` do mês (no estado) é mais novo que o
 * cache local — meses passados são imutáveis e nunca geram nova leitura.
 * O cache da tela guarda SÓ as células (o mapa `ids` fica no servidor).
 */
export async function fetchHistoryMetricDocs(months: string[], state: HistorySyncState): Promise<{ docs: MetricsDocData[]; reads: number; error?: string }> {
  const docs: MetricsDocData[] = [];
  let reads = 0;
  let error: string | undefined;
  for (const ym of months) {
    const meta = state.months[ym];
    if (!meta) continue;
    for (const server of meta.servers || []) {
      const docId = metricsDocIdOf(ym, server);
      const cached = readMetricsDocCache(docId);
      if (cached && cached.updatedAtMs >= (meta.updatedAtMs || 0)) {
        docs.push(cached.data);
        continue;
      }
      if (!db) { error = "Firestore indisponível."; continue; }
      try {
        const snap = await getDoc(doc(db, METRICS_COLLECTION, docId));
        reads += 1;
        if (!snap.exists()) continue;
        const data = snap.data() as MetricsDocData & { updatedAtMs?: number };
        const docData: MetricsDocData = { ym: data.ym || ym, server: data.server || server, cells: data.cells || {} };
        docs.push(docData);
        writeMetricsDocCache(docId, { updatedAtMs: Number(data.updatedAtMs || meta.updatedAtMs || now()), data: docData });
      } catch (err: any) {
        error = String(err?.message || err);
      }
    }
  }
  return { docs, reads, error };
}

/** Mesmo id gerado na ingestão (reexposto para evitar import circular). */
function metricsDocIdOf(ym: string, server: string): string {
  return `${ym}__${String(server || "—").replace(/[\/\s]+/g, "_")}`;
}

// ── Ingestão: base bruta + métricas + estado (idempotente e retomável) ──────

/**
 * Persiste UMA execução da consulta do histórico (ou a RETOMADA de uma
 * gravação que falhou — as mesmas entradas podem ser reenviadas quantas
 * vezes for preciso, sem duplicar NADA):
 *
 *   1. BASE BRUTA: 1 doc por leilão (`bazaarHistoryRaw/{id}`), gravado em
 *      lotes dinâmicos limitados por operações E por payload estimado;
 *   2. MÉTRICAS: por doc mês×servidor — lê a verdade do Firestore, pula os
 *      ids já contabilizados, funde só os inéditos e grava;
 *   3. ESTADO: fronteira incremental + ids recentes + índice de meses —
 *      somente quando as fases 1-2 terminaram por completo.
 *
 * Toda auction aprovada que entrar aqui É persistida — a quantidade nunca
 * é motivo de descarte; o volume apenas gera mais lotes.
 */
export async function persistHistoryIngestion(
  entries: BazaarHistoryEntry[],
  run: HistoryRunInfo,
  prevState: HistorySyncState | null,
  onProgress?: IngestionProgress,
): Promise<IngestionResult> {
  const result = emptyResult(prevState, "raw");
  if (!db) return { ...result, error: "Firestore indisponível." };
  const base = prevState
    ? { ...prevState, recent: { ...prevState.recent }, months: { ...prevState.months } }
    : emptySyncState();

  try {
    // ── 1. BASE BRUTA: lotes seguros (ops × bytes), retomáveis ────────────
    const valid = entries.filter(entry => entry.id && entry.endTs > 0);
    const batches = sliceIntoSafeBatches(valid);
    result.rawBatchesTotal = batches.length;
    onProgress?.("raw", 0, batches.length);
    for (let index = 0; index < batches.length; index += 1) {
      const slice = batches[index];
      const commitOnce = async () => {
        const batch = writeBatch(db);
        for (let i = 0; i < slice.entries.length; i += 1) {
          batch.set(doc(db, RAW_COLLECTION, slice.entries[i].id), slice.docs[i]);
        }
        await batch.commit();
      };
      try {
        await commitOnce();
      } catch {
        // Uma retentativa para falhas transitórias (rede/indisponibilidade).
        await sleep(1500);
        try {
          await commitOnce();
        } catch (err: any) {
          // Lotes anteriores JÁ estão no Firestore e não se perdem. O
          // chamador sabe exatamente quantos leilões faltaram; reenviar as
          // MESMAS entradas regrava por id — zero duplicação.
          result.rawFailedCount = valid.length - result.rawDocsWritten;
          result.error = `Falha no lote ${index + 1} de ${batches.length} da base bruta (${slice.entries.length} leilões, ~${Math.round(slice.bytes / 1024)} KB): ${String(err?.message || err)}`;
          return result;
        }
      }
      result.rawDocsWritten += slice.entries.length;
      result.rawBatchesDone = index + 1;
      onProgress?.("raw", index + 1, batches.length);
    }

    // ── 2. MÉTRICAS: dedupe exato por doc via mapa `ids` ──────────────────
    result.phase = "metrics";
    const groups = new Map<string, { ym: string; server: string; entries: BazaarHistoryEntry[] }>();
    for (const entry of valid) {
      const ym = monthKeyFromTs(entry.endTs);
      const docId = metricsDocIdOf(ym, entry.server);
      const group = groups.get(docId) || { ym, server: entry.server, entries: [] };
      group.entries.push(entry);
      groups.set(docId, group);
    }
    const groupIds = Array.from(groups.keys()).sort();
    onProgress?.("metrics", 0, groupIds.length);
    let lastMetricError = "";
    for (let index = 0; index < groupIds.length; index += 1) {
      const docId = groupIds[index];
      const group = groups.get(docId)!;
      try {
        const ref = doc(db, METRICS_COLLECTION, docId);
        // Leitura da VERDADE do Firestore antes da fusão (nunca o cache: o
        // Boss pode ter usado outro dispositivo). Poucos docs por execução.
        const snap = await getDoc(ref);
        result.metricDocsRead += 1;
        const existing = snap.exists() ? (snap.data() as any) : {};
        const cells: Record<string, MetricCell> = existing.cells || {};
        const ids: Record<string, number> = existing.ids || {};
        // SÓ entradas inéditas contam — repetição/retomada/recarga completa
        // nunca contabiliza o mesmo leilão duas vezes.
        const fresh = group.entries.filter(entry => !ids[entry.id]);
        result.alreadyInMetrics += group.entries.length - fresh.length;
        const docCount = () => Object.keys(ids).length;
        if (fresh.length === 0 && snap.exists()) {
          // Nada novo neste doc; apenas espelha a contagem no índice local.
          applyMonthMeta(base, group.ym, group.server, docCount(), Number(existing.updatedAtMs || 0));
          onProgress?.("metrics", index + 1, groupIds.length);
          continue;
        }
        for (const entry of fresh) {
          const key = metricCellKey(entry);
          if (!cells[key]) cells[key] = emptyMetricCell();
          const delta = emptyMetricCell();
          addEntryToCell(delta, entry);
          mergeCellInto(cells[key], delta);
          ids[entry.id] = 1;
        }
        const updatedAtMs = now();
        await setDoc(ref, { ym: group.ym, server: group.server, updatedAtMs, n: docCount(), cells, ids });
        result.metricDocsWritten += 1;
        result.addedToMetrics += fresh.length;
        // O dispositivo que escreveu já tem o doc mais novo em memória
        // (cache da tela SEM o mapa `ids`).
        writeMetricsDocCache(docId, { updatedAtMs, data: { ym: group.ym, server: group.server, cells } });
        applyMonthMeta(base, group.ym, group.server, docCount(), updatedAtMs);
      } catch (err: any) {
        // Falha NESTE doc não derruba os demais; a retomada reaplica só o
        // que falta (os aplicados pulam pelos `ids`).
        result.failedMetricDocIds.push(docId);
        lastMetricError = String(err?.message || err);
      }
      onProgress?.("metrics", index + 1, groupIds.length);
    }
    if (result.failedMetricDocIds.length > 0) {
      // Estado NÃO avança: as entradas destes docs precisam voltar na
      // retomada (ou numa nova consulta) para as métricas ficarem completas.
      result.error = `Falha ao atualizar ${result.failedMetricDocIds.length} documento(s) de métricas (${result.failedMetricDocIds.join(", ")}): ${lastMetricError}`;
      return result;
    }

    // ── 3. ESTADO: fronteira incremental + ids recentes ───────────────────
    result.phase = "state";
    let maxEndTs = base.lastEndTs;
    for (const entry of valid) {
      if (entry.endTs > maxEndTs) maxEndTs = entry.endTs;
    }
    if (run.processedMaxEndTs && run.processedMaxEndTs > maxEndTs) maxEndTs = run.processedMaxEndTs;
    const recentFloor = maxEndTs - HISTORY_INCREMENTAL_MARGIN_SECONDS * 2;
    const recent: Record<string, number> = {};
    for (const [id, endTs] of Object.entries(base.recent)) {
      if (endTs >= recentFloor) recent[id] = endTs;
    }
    for (const entry of valid) {
      if (entry.endTs >= recentFloor) recent[entry.id] = entry.endTs;
    }
    const totalCount = Object.values(base.months).reduce((sum, meta) => sum + (meta.count || 0), 0);
    const nextState: HistorySyncState = {
      schemaVersion: 1,
      lastEndTs: maxEndTs,
      recent,
      months: base.months,
      totalCount,
      lastRun: run,
    };
    await setDoc(doc(db, SYNC_DOC[0], SYNC_DOC[1]), nextState);
    writeSyncStateCache(nextState);
    writeNumber(SYNC_CHECKED_KEY, now());

    result.phase = "done";
    result.ok = true;
    result.state = nextState;
    return result;
  } catch (error: any) {
    result.error = String(error?.message || error);
    return result;
  }
}

/**
 * Espelha no índice de meses a contagem REAL do doc de métricas (vinda do
 * próprio documento após a fusão) — auto-corretivo: mesmo que uma execução
 * anterior tenha parado entre métricas e estado, o índice converge para os
 * números verdadeiros na retomada.
 */
function applyMonthMeta(state: HistorySyncState, ym: string, server: string, docCount: number, updatedAtMs: number): void {
  const meta: HistoryMonthMeta = state.months[ym]
    ? { ...state.months[ym], serverCounts: { ...(state.months[ym].serverCounts || {}) } }
    : { count: 0, servers: [], updatedAtMs: 0, serverCounts: {} };
  const counts = meta.serverCounts || {};
  counts[server] = docCount;
  meta.serverCounts = counts;
  if (!meta.servers.includes(server)) meta.servers = [...meta.servers, server];
  // Legado (sem serverCounts): preserva a contagem antiga dos servidores
  // ainda não espelhados somando apenas o que já foi medido de verdade.
  const measured = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const unmeasuredServers = meta.servers.filter(name => !(name in counts)).length;
  meta.count = unmeasuredServers > 0 ? Math.max(meta.count, measured) : measured;
  if (updatedAtMs > meta.updatedAtMs) meta.updatedAtMs = updatedAtMs;
  state.months[ym] = meta;
}

/**
 * Registra uma execução SEM leilões novos (só atualiza o resumo da última
 * consulta no doc de estado — 1 escrita).
 */
export async function recordEmptyHistoryRun(run: HistoryRunInfo, prevState: HistorySyncState | null): Promise<IngestionResult> {
  const result = emptyResult(prevState, "state");
  if (!db) return { ...result, error: "Firestore indisponível." };
  const nextState: HistorySyncState = { ...(prevState || emptySyncState()), lastRun: run };
  try {
    await setDoc(doc(db, SYNC_DOC[0], SYNC_DOC[1]), nextState);
    writeSyncStateCache(nextState);
    writeNumber(SYNC_CHECKED_KEY, now());
    return { ...result, ok: true, phase: "done", state: nextState };
  } catch (error: any) {
    return { ...result, error: String(error?.message || error) };
  }
}
