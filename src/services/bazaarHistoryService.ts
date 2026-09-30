// ============================================================================
// HISTÓRICO OFICIAL DO BAZAAR — persistência incremental e métricas (Firestore)
// ----------------------------------------------------------------------------
// ARQUITETURA (ver também src/utils/bazaarHistoryStats.ts):
//
//   • `bazaar/historySync` (DOC ÚNICO de estado): fronteira incremental
//     (`lastEndTs` + ids recentes na margem), metadados dos meses existentes
//     (contagem, servidores, updatedAtMs) e o resumo da última consulta.
//     É o ÚNICO documento que a tela precisa ler para saber o que existe —
//     1 leitura (com cache local + TTL) por abertura.
//
//   • `bazaarHistoryRaw/{YYYY-MM-DD}` (BASE HISTÓRICA, 1 doc por DIA de
//     término): mapa `auctions[id] = entrada completa`. Escrita com
//     `setDoc(..., {merge:true})` — regravar o mesmo leilão é IDEMPOTENTE
//     (sobrescreve a própria chave; nada duplica). A tela NUNCA lê esta
//     coleção; ela existe como fonte permanente/auditoria/reagregação.
//     ~330 leilões/dia ≈ centenas de KB/doc — folga no limite de 1 MB.
//
//   • `bazaarHistoryMetrics/{YYYY-MM__servidor}` (MÉTRICAS, 1 doc por MÊS ×
//     SERVIDOR): células dimensionais pré-agregadas. A tela lê SOMENTE
//     esses docs, e cada um fica em cache local invalidado por
//     `updatedAtMs` do mês (meses passados nunca mudam → nunca são
//     relidos). Leituras por abertura ≈ nº de docs ALTERADOS desde a
//     última visita — normalmente zero ou o mês corrente.
//
// CUSTOS POR CONSULTA (Boss): ~1 leitura de estado + 1 leitura por doc de
// métricas afetado (mês×servidor tocados) + escritas: dias tocados + docs de
// métricas afetados + 1 estado. Primeira carga (30 dias): ~30 + ~16 + 1
// escritas. Incremental diário: ~2-4 escritas. NENHUMA releitura da base
// bruta é necessária para deduplicar (a fronteira + ids recentes resolvem).
//
// IDEMPOTÊNCIA: a deduplicação acontece ANTES da agregação (fronteira
// incremental no Electron + ids recentes). As métricas só recebem deltas de
// leilões inéditos; a base bruta aceita regravação sem duplicar (merge por
// id). Concorrência: escrita exclusiva do Boss, serializada pela fila do
// Electron e pelo bloqueio cruzado da interface.
// ============================================================================

import { doc, getDoc, setDoc, writeBatch } from "firebase/firestore";
import { db } from "../firebase/config";
import {
  buildMetricsDeltas,
  dayKeyFromTs,
  emptyMetricCell,
  mergeCellInto,
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

function emptySyncState(): HistorySyncState {
  return { schemaVersion: 1, lastEndTs: 0, recent: {}, months: {}, totalCount: 0 };
}

function now(): number { return Date.now(); }

function readNumber(key: string): number {
  try {
    const value = Number(localStorage.getItem(key) || 0);
    return Number.isFinite(value) ? value : 0;
  } catch { return 0; }
}
function writeNumber(key: string, value: number): void {
  try { localStorage.setItem(key, String(value)); } catch { /* storage indisponível */ }
}

/** Remove chaves `undefined` (o Firestore as rejeita) — raso e em 1 nível de matches. */
function sanitizeEntryForWrite(entry: BazaarHistoryEntry): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (value === undefined) continue;
    output[key] = value;
  }
  return output;
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

// ── Ingestão: base bruta + métricas + estado (idempotente) ──────────────────

export interface IngestionResult {
  ok: boolean;
  state: HistorySyncState | null;
  rawDocsWritten: number;
  metricDocsWritten: number;
  metricDocsRead: number;
  error?: string;
}

/**
 * Persiste UMA execução da consulta do histórico:
 *   1. base bruta: entradas agrupadas por DIA de término, merge por id;
 *   2. métricas: deltas por mês×servidor fundidos no doc existente
 *      (1 leitura + 1 escrita por doc afetado);
 *   3. estado: fronteira incremental + ids recentes + índice de meses.
 *
 * `entries` já deve conter APENAS leilões inéditos (o Electron deduplica
 * pela fronteira + ids conhecidos) — é isso que torna a agregação
 * idempotente: repetir a consulta não devolve os mesmos leilões, logo não
 * os contabiliza de novo.
 */
export async function persistHistoryIngestion(
  entries: BazaarHistoryEntry[],
  run: HistoryRunInfo,
  prevState: HistorySyncState | null,
): Promise<IngestionResult> {
  const base = prevState ? { ...prevState, recent: { ...prevState.recent }, months: { ...prevState.months } } : emptySyncState();
  if (!db) return { ok: false, state: prevState, rawDocsWritten: 0, metricDocsWritten: 0, metricDocsRead: 0, error: "Firestore indisponível." };

  let rawDocsWritten = 0;
  let metricDocsWritten = 0;
  let metricDocsRead = 0;

  try {
    // ── 1. BASE BRUTA: 1 doc por dia de término, merge por id ─────────────
    const byDay = new Map<string, BazaarHistoryEntry[]>();
    for (const entry of entries) {
      if (!entry.endTs) continue;
      const day = dayKeyFromTs(entry.endTs);
      const list = byDay.get(day) || [];
      list.push(entry);
      byDay.set(day, list);
    }
    // writeBatch aceita até 500 operações; dias são poucos (≤ ~31 por
    // execução), mas o lote é fatiado por segurança.
    const dayKeys = Array.from(byDay.keys()).sort();
    for (let i = 0; i < dayKeys.length; i += 400) {
      const batch = writeBatch(db);
      for (const day of dayKeys.slice(i, i + 400)) {
        const dayEntries = byDay.get(day) || [];
        const auctions: Record<string, unknown> = {};
        for (const entry of dayEntries) auctions[entry.id] = sanitizeEntryForWrite(entry);
        batch.set(doc(db, RAW_COLLECTION, day), {
          day,
          ym: day.slice(0, 7),
          updatedAtMs: now(),
          auctions,
        }, { merge: true });
        rawDocsWritten += 1;
      }
      await batch.commit();
    }

    // ── 2. MÉTRICAS: fusão de deltas nos docs mês×servidor afetados ───────
    const deltas = buildMetricsDeltas(entries);
    for (const delta of deltas) {
      const ref = doc(db, METRICS_COLLECTION, delta.docId);
      // Leitura da VERDADE do Firestore antes da fusão (nunca o cache: o
      // Boss pode ter usado outro dispositivo). Poucos docs por execução.
      const snap = await getDoc(ref);
      metricDocsRead += 1;
      const existing: Record<string, MetricCell> = snap.exists() ? ((snap.data() as any).cells || {}) : {};
      for (const [key, cell] of Object.entries(delta.cells)) {
        if (!existing[key]) existing[key] = emptyMetricCell();
        mergeCellInto(existing[key], cell);
      }
      const updatedAtMs = now();
      await setDoc(ref, { ym: delta.ym, server: delta.server, updatedAtMs, cells: existing });
      metricDocsWritten += 1;
      // O dispositivo que escreveu já tem o doc mais novo em memória.
      writeMetricsDocCache(delta.docId, { updatedAtMs, data: { ym: delta.ym, server: delta.server, cells: existing } });

      // Índice de meses no estado.
      const monthMeta = base.months[delta.ym] || { count: 0, servers: [], updatedAtMs: 0 };
      monthMeta.count += delta.count;
      if (!monthMeta.servers.includes(delta.server)) monthMeta.servers = [...monthMeta.servers, delta.server];
      monthMeta.updatedAtMs = updatedAtMs;
      base.months[delta.ym] = monthMeta;
    }

    // ── 3. ESTADO: fronteira incremental + ids recentes ───────────────────
    let maxEndTs = base.lastEndTs;
    for (const entry of entries) {
      if (entry.endTs > maxEndTs) maxEndTs = entry.endTs;
    }
    if (run.processedMaxEndTs && run.processedMaxEndTs > maxEndTs) maxEndTs = run.processedMaxEndTs;
    const recentFloor = maxEndTs - HISTORY_INCREMENTAL_MARGIN_SECONDS * 2;
    const recent: Record<string, number> = {};
    for (const [id, endTs] of Object.entries(base.recent)) {
      if (endTs >= recentFloor) recent[id] = endTs;
    }
    for (const entry of entries) {
      if (entry.endTs >= recentFloor) recent[entry.id] = entry.endTs;
    }
    const nextState: HistorySyncState = {
      schemaVersion: 1,
      lastEndTs: maxEndTs,
      recent,
      months: base.months,
      totalCount: base.totalCount + entries.length,
      lastRun: run,
    };
    await setDoc(doc(db, SYNC_DOC[0], SYNC_DOC[1]), nextState);
    writeSyncStateCache(nextState);
    writeNumber(SYNC_CHECKED_KEY, now());

    return { ok: true, state: nextState, rawDocsWritten, metricDocsWritten, metricDocsRead };
  } catch (error: any) {
    return { ok: false, state: prevState, rawDocsWritten, metricDocsWritten, metricDocsRead, error: String(error?.message || error) };
  }
}

/**
 * Registra uma execução SEM leilões novos (só atualiza o resumo da última
 * consulta no doc de estado — 1 escrita).
 */
export async function recordEmptyHistoryRun(run: HistoryRunInfo, prevState: HistorySyncState | null): Promise<IngestionResult> {
  if (!db) return { ok: false, state: prevState, rawDocsWritten: 0, metricDocsWritten: 0, metricDocsRead: 0, error: "Firestore indisponível." };
  const nextState: HistorySyncState = { ...(prevState || emptySyncState()), lastRun: run };
  try {
    await setDoc(doc(db, SYNC_DOC[0], SYNC_DOC[1]), nextState);
    writeSyncStateCache(nextState);
    writeNumber(SYNC_CHECKED_KEY, now());
    return { ok: true, state: nextState, rawDocsWritten: 0, metricDocsWritten: 0, metricDocsRead: 0 };
  } catch (error: any) {
    return { ok: false, state: prevState, rawDocsWritten: 0, metricDocsWritten: 0, metricDocsRead: 0, error: String(error?.message || error) };
  }
}
