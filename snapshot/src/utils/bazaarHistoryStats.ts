// ============================================================================
// HISTÓRICO OFICIAL DO BAZAAR — tipos, persistência e estatísticas
// ----------------------------------------------------------------------------
// Camada de DADOS da tela "Estatísticas do Bazaar". Responsabilidades:
//
//   • tipar o resultado do canal Electron `rubinot-bazaar-history-v1`;
//   • transformar o resultado bruto em ENTRADAS compactas e auto-suficientes
//     (valor de itens já precificado em kk pelas MESMAS funções da guia
//     Itens — buildWatchlistIndex/buildCharacterMatches, preço da lista do
//     SERVIDOR do personagem, sem fallback de outro servidor);
//   • persistir a ÚLTIMA consulta localmente (`rubinot_bazaar_history_last_
//     query`, mesmo padrão da guia Itens — nunca o resultado completo no
//     Firestore);
//   • calcular TODAS as estatísticas localmente sobre o conjunto filtrado
//     (nenhuma consulta nova ao site por interação de filtro).
//
// A conversão kk→RC usa `computeItemRC` (a MESMA função do restante do app)
// com a cotação carimbada na consulta (`coinRateKk`) — assim o número não
// muda silenciosamente quando a cotação local for alterada depois.
// ============================================================================

import { loadUIState, saveUIState } from "../storage";
import { computeItemRC } from "./itemSale";
import {
  buildWatchlistIndex,
  buildCharacterMatches,
  canonicalServerKey,
  getServerWatchedItems,
  loadItemsCoinRate,
  loadWatchedItemsByServer,
  type ItemsCharacterSkills,
  type RawItemMatch,
} from "./bazaarWatchedItems";

// ── Persistência local ───────────────────────────────────────────────────────
export const BAZAAR_HISTORY_LAST_QUERY_KEY = "rubinot_bazaar_history_last_query";
export const BAZAAR_HISTORY_LAST_QUERY_UPDATED_EVENT = "bazaar-history-last-query-updated";
const HISTORY_SCHEMA_VERSION = 1;

/** Entrada bruta devolvida pelo canal Electron (uma por leilão aprovado). */
export interface BazaarHistoryRawEntry {
  id: string;
  name: string;
  vocation: string;
  level: number;
  server: string;
  /** Lance Vencedor em RC (o lance do Bazaar já é em Rubini Coins). */
  winningBid: number;
  auctionEndTs: number | null;
  statusText?: string;
  matches?: RawItemMatch[];
  gold?: number;
  skills?: ItemsCharacterSkills;
  soulwarCompleted?: boolean | null;
  sanguineCompleted?: boolean | null;
  charmPoints?: number | null;
  auraCount?: number | null;
  hirelingCount?: number | null;
  deluxePassCount?: number | null;
  /** Preenchido quando a consulta individual falhou (listagem permanece válida). */
  detailError?: string;
}

/** Resposta completa do canal `rubinot-bazaar-history-v1`. */
export interface BazaarHistoryQueryResponse {
  ok: boolean;
  error?: string;
  needsHumanVerification?: boolean;
  fetchedAt?: number;
  listedCount?: number;
  approvedCount?: number;
  analyzedCount?: number;
  failedCount?: number;
  stoppedManually?: boolean;
  entries?: BazaarHistoryRawEntry[];
  totalDurationMs?: number;
  primaryBrowser?: string;
}

/**
 * Entrada PERSISTIDA/PUBLICADA — compacta e auto-suficiente. O valor dos
 * itens já vem precificado em kk (regras da guia Itens aplicadas no momento
 * da consulta); nada precisa ser recalculado por outros dispositivos.
 */
export interface BazaarHistoryEntry {
  id: string;
  name: string;
  vocation: string;
  level: number;
  server: string;
  /** Lance Vencedor em RC. */
  winningBidRc: number;
  auctionEndTs: number | null;
  /** Valor dos itens monitorados encontrados, em kk (0 = nenhum). */
  itemsKk: number;
  skills?: ItemsCharacterSkills;
  /** true = concluída; false = disponível; null/ausente = inconclusivo. */
  soulwarCompleted?: boolean | null;
  sanguineCompleted?: boolean | null;
  charmPoints?: number | null;
  auraCount?: number | null;
  hirelingCount?: number | null;
  deluxePassCount?: number | null;
}

/** Última consulta do histórico (persistida localmente e publicada). */
export interface BazaarHistoryLastQuery {
  schemaVersion: number;
  /** Início da consulta (ms). */
  fetchedAtMs: number;
  durationMs: number;
  /** Leilões listados nas páginas lidas do histórico. */
  listedCount: number;
  /** Aprovados pelo filtro obrigatório Finalizado + Lance Vencedor. */
  approvedCount: number;
  /** Analisados individualmente com sucesso pela API JSON. */
  analyzedCount: number;
  failedCount: number;
  stoppedManually: boolean;
  /** Cotação kk do coin usada para converter itens kk→RC (0 = sem cotação). */
  coinRateKk: number;
  entries: BazaarHistoryEntry[];
}

// ── Construção das entradas (precificação idêntica à guia Itens) ────────────

/**
 * Converte o resultado bruto do Electron na estrutura persistida. O valor
 * dos itens usa SEMPRE a Lista de Itens do SERVIDOR do personagem (sem
 * fallback de preço de outro servidor) — exatamente `buildWatchlistIndex` +
 * `buildCharacterMatches`, as mesmas funções da guia Itens.
 */
export function buildHistoryLastQuery(response: BazaarHistoryQueryResponse): BazaarHistoryLastQuery {
  const watchedByServer = loadWatchedItemsByServer();
  const indexCache = new Map<string, Map<string, import("./bazaarWatchedItems").WatchedItem>>();
  const indexForServer = (server: string) => {
    const key = canonicalServerKey(server);
    let index = indexCache.get(key);
    if (!index) {
      index = buildWatchlistIndex(getServerWatchedItems(watchedByServer, key));
      indexCache.set(key, index);
    }
    return index;
  };

  const entries: BazaarHistoryEntry[] = (response.entries || []).map(raw => {
    const { totalKk } = buildCharacterMatches(raw.matches || [], indexForServer(raw.server));
    const entry: BazaarHistoryEntry = {
      id: raw.id,
      name: raw.name,
      vocation: raw.vocation,
      level: raw.level,
      server: raw.server,
      winningBidRc: raw.winningBid,
      auctionEndTs: raw.auctionEndTs ?? null,
      itemsKk: totalKk,
    };
    if (raw.skills && Object.keys(raw.skills).length > 0) entry.skills = raw.skills;
    if (raw.soulwarCompleted !== undefined) entry.soulwarCompleted = raw.soulwarCompleted;
    if (raw.sanguineCompleted !== undefined) entry.sanguineCompleted = raw.sanguineCompleted;
    if (raw.charmPoints !== undefined && raw.charmPoints !== null) entry.charmPoints = raw.charmPoints;
    if (raw.auraCount !== undefined && raw.auraCount !== null) entry.auraCount = raw.auraCount;
    if (raw.hirelingCount !== undefined && raw.hirelingCount !== null) entry.hirelingCount = raw.hirelingCount;
    if (raw.deluxePassCount !== undefined && raw.deluxePassCount !== null) entry.deluxePassCount = raw.deluxePassCount;
    return entry;
  });

  return {
    schemaVersion: HISTORY_SCHEMA_VERSION,
    fetchedAtMs: response.fetchedAt || Date.now(),
    durationMs: response.totalDurationMs || 0,
    listedCount: response.listedCount || 0,
    approvedCount: response.approvedCount || 0,
    analyzedCount: response.analyzedCount || 0,
    failedCount: response.failedCount || 0,
    stoppedManually: response.stoppedManually === true,
    coinRateKk: loadItemsCoinRate(),
    entries,
  };
}

export function loadHistoryLastQuery(): BazaarHistoryLastQuery | null {
  const raw = loadUIState<BazaarHistoryLastQuery | null>(BAZAAR_HISTORY_LAST_QUERY_KEY, null);
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.entries)) return null;
  return raw;
}

export function saveHistoryLastQuery(query: BazaarHistoryLastQuery): void {
  saveUIState(BAZAAR_HISTORY_LAST_QUERY_KEY, query);
  try {
    window.dispatchEvent(new Event(BAZAAR_HISTORY_LAST_QUERY_UPDATED_EVENT));
  } catch {
    // Ambiente sem window/CustomEvent: persistência local basta.
  }
}

// ── Valor dos itens em RC ────────────────────────────────────────────────────

/** Valor dos itens de UMA entrada em RC, pela cotação da consulta. */
export function entryItemsRc(entry: BazaarHistoryEntry, coinRateKk: number): number {
  if (!Number.isFinite(coinRateKk) || coinRateKk <= 0) return 0;
  if (!Number.isFinite(entry.itemsKk) || entry.itemsKk <= 0) return 0;
  return computeItemRC(coinRateKk, entry.itemsKk);
}

// ── Estatísticas (todas locais, sobre o conjunto filtrado) ──────────────────

export interface BazaarHistoryStats {
  count: number;
  avgWinningBidRc: number;
  minWinningBidRc: number;
  maxWinningBidRc: number;
  /** Média do valor de itens em RC (personagens COM itens e cotação > 0). */
  avgItemsRc: number;
  /** Quantos personagens têm itens monitorados com valor > 0. */
  withItemsCount: number;
  avgLevel: number;
  /** Média de charm points (somente entradas com o dado). */
  avgCharmPoints: number;
  charmSampleCount: number;
  avgAuras: number;
  auraSampleCount: number;
  avgHirelings: number;
  hirelingSampleCount: number;
  avgDeluxePasses: number;
  deluxeSampleCount: number;
  /** Distribuições ordenadas por quantidade (desc). */
  byVocation: { label: string; count: number }[];
  byServer: { label: string; count: number }[];
  /** SW/SG: disponíveis (false), concluídas (true) e sem dado. */
  soulwar: { available: number; completed: number; unknown: number };
  sanguine: { available: number; completed: number; unknown: number };
  /** Média de (itens RC ÷ lance vencedor RC) × 100, onde ambos existem. */
  avgItemsToBidPercent: number | null;
  /** Médias de skills por chave (somente valores presentes). */
  avgSkills: Partial<Record<keyof ItemsCharacterSkills & string, number>>;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function distribution(entries: BazaarHistoryEntry[], get: (e: BazaarHistoryEntry) => string): { label: string; count: number }[] {
  const map = new Map<string, number>();
  for (const entry of entries) {
    const label = get(entry) || "—";
    map.set(label, (map.get(label) || 0) + 1);
  }
  return Array.from(map.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "pt-BR"));
}

function questDistribution(entries: BazaarHistoryEntry[], field: "soulwarCompleted" | "sanguineCompleted") {
  let available = 0;
  let completed = 0;
  let unknown = 0;
  for (const entry of entries) {
    const value = entry[field];
    if (value === false) available += 1;
    else if (value === true) completed += 1;
    else unknown += 1;
  }
  return { available, completed, unknown };
}

/** Calcula TODAS as estatísticas do conjunto filtrado (100% local). */
export function computeHistoryStats(entries: BazaarHistoryEntry[], coinRateKk: number): BazaarHistoryStats {
  const bids = entries.map(e => e.winningBidRc).filter(v => Number.isFinite(v) && v > 0);
  const itemsRcValues: number[] = [];
  const itemsToBidPercents: number[] = [];
  for (const entry of entries) {
    const rc = entryItemsRc(entry, coinRateKk);
    if (rc > 0) {
      itemsRcValues.push(rc);
      if (entry.winningBidRc > 0) itemsToBidPercents.push((rc / entry.winningBidRc) * 100);
    }
  }

  const charms = entries.map(e => e.charmPoints).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const auras = entries.map(e => e.auraCount).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const hirelings = entries.map(e => e.hirelingCount).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const deluxe = entries.map(e => e.deluxePassCount).filter((v): v is number => typeof v === "number" && Number.isFinite(v));

  const avgSkills: BazaarHistoryStats["avgSkills"] = {};
  const skillSums = new Map<string, { sum: number; count: number }>();
  for (const entry of entries) {
    if (!entry.skills) continue;
    for (const [key, value] of Object.entries(entry.skills)) {
      if (!Number.isFinite(value)) continue;
      const bucket = skillSums.get(key) || { sum: 0, count: 0 };
      bucket.sum += value as number;
      bucket.count += 1;
      skillSums.set(key, bucket);
    }
  }
  for (const [key, bucket] of skillSums.entries()) {
    if (bucket.count > 0) avgSkills[key as keyof ItemsCharacterSkills & string] = round1(bucket.sum / bucket.count);
  }

  return {
    count: entries.length,
    avgWinningBidRc: Math.round(average(bids)),
    minWinningBidRc: bids.length > 0 ? Math.min(...bids) : 0,
    maxWinningBidRc: bids.length > 0 ? Math.max(...bids) : 0,
    avgItemsRc: Math.round(average(itemsRcValues)),
    withItemsCount: itemsRcValues.length,
    avgLevel: Math.round(average(entries.map(e => e.level).filter(v => Number.isFinite(v) && v > 0))),
    avgCharmPoints: Math.round(average(charms)),
    charmSampleCount: charms.length,
    avgAuras: round1(average(auras)),
    auraSampleCount: auras.length,
    avgHirelings: round1(average(hirelings)),
    hirelingSampleCount: hirelings.length,
    avgDeluxePasses: round1(average(deluxe)),
    deluxeSampleCount: deluxe.length,
    byVocation: distribution(entries, e => e.vocation),
    byServer: distribution(entries, e => e.server),
    soulwar: questDistribution(entries, "soulwarCompleted"),
    sanguine: questDistribution(entries, "sanguineCompleted"),
    avgItemsToBidPercent: itemsToBidPercents.length > 0 ? round1(average(itemsToBidPercents)) : null,
    avgSkills,
  };
}

// ── Filtros estatísticos (100% locais) ───────────────────────────────────────

/** "any" = não filtra; "available" = quest disponível; "completed" = concluída. */
export type HistoryQuestFilter = "any" | "available" | "completed";

export interface BazaarHistoryFilters {
  servers: string[];
  vocations: string[];
  levelMin: string;
  levelMax: string;
  bidMin: string;
  bidMax: string;
  itemsRcMin: string;
  itemsRcMax: string;
  charmMin: string;
  charmMax: string;
  aurasMin: string;
  hirelingsMin: string;
  deluxeMin: string;
  soulwar: HistoryQuestFilter;
  sanguine: HistoryQuestFilter;
}

export function defaultHistoryFilters(): BazaarHistoryFilters {
  return {
    servers: [],
    vocations: [],
    levelMin: "",
    levelMax: "",
    bidMin: "",
    bidMax: "",
    itemsRcMin: "",
    itemsRcMax: "",
    charmMin: "",
    charmMax: "",
    aurasMin: "",
    hirelingsMin: "",
    deluxeMin: "",
    soulwar: "any",
    sanguine: "any",
  };
}

function parseBound(text: string): number | null {
  // Campo vazio = SEM limite (Number("") seria 0 e filtraria tudo).
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  const value = Number(trimmed.replace(",", "."));
  return Number.isFinite(value) ? value : null;
}

function inRange(value: number, minText: string, maxText: string): boolean {
  const min = parseBound(minText);
  const max = parseBound(maxText);
  if (min !== null && value < min) return false;
  if (max !== null && value > max) return false;
  return true;
}

function matchQuest(value: boolean | null | undefined, filter: HistoryQuestFilter): boolean {
  if (filter === "any") return true;
  if (filter === "available") return value === false;
  return value === true;
}

/** Aplica TODOS os filtros combinados sobre as entradas (AND entre filtros). */
export function applyHistoryFilters(
  entries: BazaarHistoryEntry[],
  filters: BazaarHistoryFilters,
  coinRateKk: number,
): BazaarHistoryEntry[] {
  return entries.filter(entry => {
    if (filters.servers.length > 0 && !filters.servers.includes(entry.server)) return false;
    if (filters.vocations.length > 0 && !filters.vocations.includes(entry.vocation)) return false;
    if (!inRange(entry.level, filters.levelMin, filters.levelMax)) return false;
    if (!inRange(entry.winningBidRc, filters.bidMin, filters.bidMax)) return false;
    if (filters.itemsRcMin.trim() !== "" || filters.itemsRcMax.trim() !== "") {
      if (!inRange(entryItemsRc(entry, coinRateKk), filters.itemsRcMin, filters.itemsRcMax)) return false;
    }
    if (filters.charmMin.trim() !== "" || filters.charmMax.trim() !== "") {
      if (!inRange(entry.charmPoints ?? 0, filters.charmMin, filters.charmMax)) return false;
    }
    if (filters.aurasMin.trim() !== "" && (entry.auraCount ?? 0) < (parseBound(filters.aurasMin) ?? 0)) return false;
    if (filters.hirelingsMin.trim() !== "" && (entry.hirelingCount ?? 0) < (parseBound(filters.hirelingsMin) ?? 0)) return false;
    if (filters.deluxeMin.trim() !== "" && (entry.deluxePassCount ?? 0) < (parseBound(filters.deluxeMin) ?? 0)) return false;
    if (!matchQuest(entry.soulwarCompleted, filters.soulwar)) return false;
    if (!matchQuest(entry.sanguineCompleted, filters.sanguine)) return false;
    return true;
  });
}

export function hasActiveHistoryFilters(filters: BazaarHistoryFilters): boolean {
  const defaults = defaultHistoryFilters();
  return JSON.stringify(filters) !== JSON.stringify(defaults);
}
