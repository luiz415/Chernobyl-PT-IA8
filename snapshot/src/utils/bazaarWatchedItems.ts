// ============================================================================
// PERSONAGENS COM ITENS — utilitários puros do painel de itens do Bazaar
// ----------------------------------------------------------------------------
// Tudo aqui é LOCAL: a Lista de Itens, a cotação do coin e o resultado da
// última consulta vivem exclusivamente no localStorage deste dispositivo.
// NADA deste módulo grava no Firestore — requisito explícito da funcionalidade.
//
// A conversão kk -> RC NÃO é reimplementada aqui: o painel usa a
// `computeItemRC` já existente em `utils/itemSale.ts` (mesma fórmula do
// restante do aplicativo).
// ============================================================================

import { loadUIState, saveUIState } from "../storage";

// ── Persistência (somente configurações e resultado local) ──────────────────
export const BAZAAR_WATCHED_ITEMS_KEY = "rubinot_bazaar_watched_items";
export const BAZAAR_ITEMS_COIN_RATE_KEY = "rubinot_bazaar_items_coin_rate";
export const BAZAAR_ITEMS_LAST_QUERY_KEY = "rubinot_bazaar_items_last_query";

/** Item monitorado: nome exato (sem Tier) + valor base em kk. */
export interface WatchedItem {
  id: string;
  name: string;
  valueKk: number;
}

/** Match bruto devolvido pelo processo principal (Electron). */
export interface RawItemMatch {
  /** Nome exatamente como apareceu no JSON do leilão (pode conter [Tier x]). */
  foundName: string;
  /** Nome base normalizado (sem Tier) — chave de casamento com a lista. */
  baseKey: string;
  tier: number;
  amount: number;
}

/** Match já casado com a Lista de Itens e com valores calculados. */
export interface CharacterItemMatch {
  foundName: string;
  watchedName: string;
  baseValueKk: number;
  tier: number;
  /** Valor unitário após o Tier: base × (1 + 0.2 × tier). */
  unitValueKk: number;
  amount: number;
  totalKk: number;
}

/** Resultado de UM personagem na consulta de itens. */
export interface BazaarItemsCharacterResult {
  id: string;
  name: string;
  url: string;
  level: number;
  vocation: string;
  server: string;
  matches: CharacterItemMatch[];
  totalKk: number;
}

/** Resumo persistido da última consulta de itens (local, nunca Firestore). */
export interface BazaarItemsLastQuery {
  completedAtMs: number;
  durationMs: number;
  /** Total de leilões listados pela API. */
  listedCount: number;
  /** Quantos passaram no filtro de data (elegíveis para análise). */
  eligibleCount: number;
  /** Quantos foram analisados com sucesso pela API JSON. */
  analyzedCount: number;
  failedCount: number;
  stoppedManually: boolean;
  /** Valor do campo "Encerra até" usado na consulta (texto do input). */
  endUntilLabel: string;
  /** Somente personagens com pelo menos um item monitorado encontrado. */
  results: BazaarItemsCharacterResult[];
}

// ============================================================================
// NORMALIZAÇÃO E TIER
// ----------------------------------------------------------------------------
// A MESMA regra de normalização é aplicada no processo principal
// (`electron-bazaar-new.cjs`): acentos removidos, aspas curvas retificadas,
// espaços colapsados, caixa baixa. Manter as duas em sincronia.
// ============================================================================

/** Normaliza um nome de item para casamento tolerante. */
export function normalizeWatchedItemName(value: string): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’`´]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Padrão oficial do Tier no nome: "Falcon Coif [Tier 3]". */
const TIER_PATTERN = /\s*\[\s*tier\s*(\d+)\s*\]\s*/i;

/**
 * Separa o Tier do nome. "Falcon Coif [Tier 3]" -> base "Falcon Coif", tier 3.
 * Nome sem o padrão -> tier 0 e base igual ao próprio nome.
 */
export function parseTieredItemName(raw: string): { baseName: string; tier: number } {
  const text = String(raw || "");
  const match = text.match(TIER_PATTERN);
  if (!match) return { baseName: text.trim(), tier: 0 };
  const tier = Number(match[1]);
  return {
    baseName: text.replace(TIER_PATTERN, " ").replace(/\s+/g, " ").trim(),
    tier: Number.isFinite(tier) && tier > 0 ? Math.floor(tier) : 0,
  };
}

/** Regra de negócio do Tier: cada nível vale +20% sobre o valor base. */
export function computeTieredValueKk(baseValueKk: number, tier: number): number {
  const base = Number(baseValueKk);
  const safeTier = Number.isFinite(tier) && tier > 0 ? Math.floor(tier) : 0;
  if (!Number.isFinite(base) || base <= 0) return 0;
  // Duas casas bastam para kk e evitam ruído de ponto flutuante (ex.: 4.5 × 1.2).
  return Math.round(base * (1 + 0.2 * safeTier) * 100) / 100;
}

/** Índice nome-normalizado -> item monitorado, para casamento O(1). */
export function buildWatchlistIndex(items: WatchedItem[]): Map<string, WatchedItem> {
  const index = new Map<string, WatchedItem>();
  for (const item of items) {
    const key = normalizeWatchedItemName(item.name);
    if (key && !index.has(key)) index.set(key, item);
  }
  return index;
}

/**
 * Converte os matches brutos do Electron em matches valorados, casando com a
 * Lista de Itens. Matches cujo `baseKey` não está mais na lista são ignorados
 * (a lista pode ter mudado entre a consulta e a renderização).
 */
export function buildCharacterMatches(rawMatches: RawItemMatch[], index: Map<string, WatchedItem>): { matches: CharacterItemMatch[]; totalKk: number } {
  const matches: CharacterItemMatch[] = [];
  let totalKk = 0;
  for (const raw of Array.isArray(rawMatches) ? rawMatches : []) {
    const watched = index.get(String(raw?.baseKey || ""));
    if (!watched) continue;
    const tier = Number.isFinite(raw?.tier) && raw.tier > 0 ? Math.floor(raw.tier) : 0;
    const amount = Number.isFinite(raw?.amount) && raw.amount > 0 ? Math.floor(raw.amount) : 1;
    const unitValueKk = computeTieredValueKk(watched.valueKk, tier);
    const itemTotal = Math.round(unitValueKk * amount * 100) / 100;
    matches.push({
      foundName: String(raw?.foundName || watched.name),
      watchedName: watched.name,
      baseValueKk: watched.valueKk,
      tier,
      unitValueKk,
      amount,
      totalKk: itemTotal,
    });
    totalKk += itemTotal;
  }
  return { matches, totalKk: Math.round(totalKk * 100) / 100 };
}

// ============================================================================
// PERSISTÊNCIA LOCAL (localStorage via loadUIState/saveUIState)
// ============================================================================

function sanitizeWatchedItem(raw: unknown): WatchedItem | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const name = String(item.name ?? "").trim();
  const valueKk = Number(item.valueKk);
  if (!name || !Number.isFinite(valueKk) || valueKk <= 0) return null;
  const id = String(item.id ?? "").trim() || `wi_${Math.random().toString(36).slice(2, 10)}`;
  return { id, name, valueKk: Math.round(valueKk * 100) / 100 };
}

export function sanitizeWatchedItems(raw: unknown): WatchedItem[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const items: WatchedItem[] = [];
  for (const entry of raw) {
    const item = sanitizeWatchedItem(entry);
    if (!item) continue;
    const key = normalizeWatchedItemName(item.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }
  return items;
}

export function loadWatchedItems(): WatchedItem[] {
  return sanitizeWatchedItems(loadUIState<unknown>(BAZAAR_WATCHED_ITEMS_KEY, []));
}

export function saveWatchedItems(items: WatchedItem[]): void {
  saveUIState(BAZAAR_WATCHED_ITEMS_KEY, sanitizeWatchedItems(items));
}

export function loadItemsCoinRate(): number {
  const value = Number(loadUIState<unknown>(BAZAAR_ITEMS_COIN_RATE_KEY, 0));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function saveItemsCoinRate(rate: number): void {
  const value = Number(rate);
  saveUIState(BAZAAR_ITEMS_COIN_RATE_KEY, Number.isFinite(value) && value > 0 ? value : 0);
}

export function loadItemsLastQuery(): BazaarItemsLastQuery | null {
  const raw = loadUIState<BazaarItemsLastQuery | null>(BAZAAR_ITEMS_LAST_QUERY_KEY, null);
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.results)) return null;
  return raw;
}

export function saveItemsLastQuery(query: BazaarItemsLastQuery): void {
  saveUIState(BAZAAR_ITEMS_LAST_QUERY_KEY, query);
}

// ============================================================================
// EXPORTAR / IMPORTAR a Lista de Itens (arquivo JSON)
// ============================================================================

export function exportWatchlistJson(items: WatchedItem[]): string {
  return JSON.stringify(
    {
      kind: "bazaar-watched-items",
      version: 1,
      exportedAt: new Date().toISOString(),
      items: items.map(item => ({ name: item.name, valueKk: item.valueKk })),
    },
    null,
    2,
  );
}

export function parseWatchlistImport(text: string): { items: WatchedItem[]; error: string | null } {
  try {
    const parsed = JSON.parse(String(text || ""));
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : null;
    if (!list) return { items: [], error: "Arquivo inválido: nenhuma lista de itens encontrada." };
    const items = sanitizeWatchedItems(list);
    if (items.length === 0) return { items: [], error: "Nenhum item válido no arquivo (cada item precisa de nome e valor em kk > 0)." };
    return { items, error: null };
  } catch {
    return { items: [], error: "Arquivo inválido: não foi possível ler o JSON." };
  }
}
