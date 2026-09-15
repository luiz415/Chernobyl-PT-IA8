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
import { OFFICIAL_SERVERS, normalizeServerName } from "../constants/servers";

// ── Persistência (somente configurações e resultado local) ──────────────────
export const BAZAAR_WATCHED_ITEMS_KEY = "rubinot_bazaar_watched_items";
/**
 * LISTAS DE PREÇOS POR SERVIDOR — formato atual: um único mapa
 * `{ "<servidor oficial>": WatchedItem[] }`. Estrutura escalável
 * (Servidor → lista de itens → preço): novos servidores entram sem nenhuma
 * lógica individual. A chave LEGADA acima (lista única) é migrada UMA vez
 * para todos os servidores (era o comportamento vigente: mesma lista usada
 * para todos) e preservada como backup — nunca mais escrita.
 */
export const BAZAAR_WATCHED_ITEMS_BY_SERVER_KEY = "rubinot_bazaar_watched_items_by_server";
export const BAZAAR_ITEMS_COIN_RATE_KEY = "rubinot_bazaar_items_coin_rate";
export const BAZAAR_ITEMS_LAST_QUERY_KEY = "rubinot_bazaar_items_last_query";
/**
 * Interesse do painel de itens — 100% LOCAL, por usuário (requisito explícito:
 * NADA de Firestore para registrar/atualizar/sincronizar interesse de itens).
 */
export const BAZAAR_ITEMS_INTERESTS_KEY_PREFIX = "rubinot_bazaar_items_interests_";

/** Item monitorado: nome exato (sem Tier) + valor base em kk. */
export interface WatchedItem {
  id: string;
  name: string;
  valueKk: number;
  /** Última vez que o VALOR foi alterado e salvo (ms). Ausente em itens legados. */
  updatedAtMs?: number;
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

/**
 * Skills inteiras lidas da página do leilão (chaves canônicas do Electron:
 * axe/club/sword/distance/shielding/fist/magic). Campo ausente = a skill
 * não veio na resposta (a exibição mostra "—", nunca inventa 0).
 */
export type ItemsCharacterSkills = Partial<Record<"axe" | "club" | "sword" | "distance" | "shielding" | "fist" | "magic", number>>;

/** Resultado de UM personagem na consulta de itens. */
export interface BazaarItemsCharacterResult {
  id: string;
  name: string;
  url: string;
  level: number;
  vocation: string;
  server: string;
  matches: CharacterItemMatch[];
  /**
   * TOTAL da coluna "Valor Itens (KK)" = soma dos matches + `goldKk`.
   * O ouro entra UMA única vez (aqui); `goldKk` guarda a parcela para a
   * exibição e para a reprecificação não perdê-la nem duplicá-la.
   */
  totalKk: number;
  /** Ouro da página convertido para kk (1.000.000 gold = 1kk). */
  goldKk?: number;
  /** Skills inteiras encontradas na página do leilão. */
  skills?: ItemsCharacterSkills;
  /**
   * QUESTS derivadas do MESMO payload do leilão (bosstiary), pela MESMA
   * função das quests (deriveQuestsFromApiPayload — zero fetch extra):
   * true = quest JÁ FEITA (indisponível); false = disponível; null/ausente =
   * inconclusivo (a resposta não trouxe bosstiary reconhecível).
   */
  soulwarCompleted?: boolean | null;
  sanguineCompleted?: boolean | null;
  /** Valor (bid) do personagem NO MOMENTO da consulta — só exibição. */
  bid?: number;
  /** Encerramento do leilão (s ou ms, normalizado na exibição) — só exibição. */
  auctionEndTs?: number | null;
  /**
   * CORREÇÃO MANUAL do "Valor Itens (KK)" (feita pelo usuário após conferir
   * o personagem). Quando presente (> 0), tem PRIORIDADE sobre `totalKk` em
   * exibição, filtros, ordenação e no cálculo de RC. O cálculo automático
   * (`totalKk`) NUNCA é apagado — remover a correção volta ao automático.
   */
  manualTotalKk?: number | null;
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
  // Valores em kk aceitam UMA casa decimal (ex.: 1,5kk). A leitura pisa
  // qualquer precisão extra para 1 casa — importações/legados com mais casas
  // são arredondados; um item que arredonde para 0 deixa de ser válido.
  const rounded = Math.round(valueKk * 10) / 10;
  if (rounded < 0.1) return null;
  const id = String(item.id ?? "").trim() || `wi_${Math.random().toString(36).slice(2, 10)}`;
  const updatedAtMs = Number(item.updatedAtMs);
  return {
    id,
    name,
    valueKk: rounded,
    ...(Number.isFinite(updatedAtMs) && updatedAtMs > 0 ? { updatedAtMs } : {}),
  };
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

// ============================================================================
// LISTAS DE PREÇOS POR SERVIDOR
// ----------------------------------------------------------------------------
// Estrutura: `{ "<servidor oficial>": WatchedItem[] }` — cada servidor tem
// itens, valores e datas de atualização PRÓPRIOS. O cálculo de um personagem
// usa SEMPRE a lista do servidor dele; item sem preço no servidor NÃO usa o
// preço de outro servidor como fallback (simplesmente não é contabilizado,
// mesmo comportamento de item fora da lista).
//
// MIGRAÇÃO: na primeira leitura sem o mapa novo, a lista única legada é
// copiada para TODOS os servidores oficiais — exatamente o comportamento
// vigente até aqui (uma lista valia para todos). A chave legada permanece
// como estava (backup), nunca mais é escrita.
// ============================================================================

export type WatchedItemsByServer = Record<string, WatchedItem[]>;

/** Nome canônico do servidor (fonte única em constants/servers). */
export function canonicalServerKey(server: string): string {
  const normalized = normalizeServerName(String(server || ""));
  return normalized || String(server || "").trim();
}

export function sanitizeWatchedItemsByServer(raw: unknown): WatchedItemsByServer {
  const out: WatchedItemsByServer = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [server, list] of Object.entries(raw as Record<string, unknown>)) {
    const key = canonicalServerKey(server);
    if (!key) continue;
    const items = sanitizeWatchedItems(list);
    if (items.length === 0) continue;
    if (!out[key]) {
      out[key] = items;
      continue;
    }
    // Duas chaves que normalizam para o mesmo servidor (ex.: alias legado):
    // mescla sem duplicar nomes — a primeira ocorrência prevalece.
    const seen = new Set(out[key].map(item => normalizeWatchedItemName(item.name)));
    for (const item of items) {
      const nameKey = normalizeWatchedItemName(item.name);
      if (seen.has(nameKey)) continue;
      seen.add(nameKey);
      out[key].push(item);
    }
  }
  return out;
}

export function loadWatchedItemsByServer(): WatchedItemsByServer {
  const raw = loadUIState<unknown>(BAZAAR_WATCHED_ITEMS_BY_SERVER_KEY, null);
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return sanitizeWatchedItemsByServer(raw);
  }
  // Migração única: a lista legada (que valia para TODOS os servidores)
  // vira a lista inicial de cada servidor — a partir daí, cada um evolui
  // de forma independente.
  const legacy = sanitizeWatchedItems(loadUIState<unknown>(BAZAAR_WATCHED_ITEMS_KEY, []));
  const seeded: WatchedItemsByServer = {};
  if (legacy.length > 0) {
    for (const server of OFFICIAL_SERVERS) {
      seeded[server] = legacy.map(item => ({ ...item }));
    }
    saveUIState(BAZAAR_WATCHED_ITEMS_BY_SERVER_KEY, seeded);
  }
  return seeded;
}

export function saveWatchedItemsByServer(map: WatchedItemsByServer): void {
  saveUIState(BAZAAR_WATCHED_ITEMS_BY_SERVER_KEY, sanitizeWatchedItemsByServer(map));
}

/** Lista de preços de UM servidor (vazia quando não há nada cadastrado). */
export function getServerWatchedItems(map: WatchedItemsByServer, server: string): WatchedItem[] {
  return map[canonicalServerKey(server)] || [];
}

/**
 * União dos nomes monitorados (normalizados) de TODOS os servidores — é o
 * conjunto enviado à consulta: a consulta ENCONTRA os itens; o preço aplicado
 * depois é sempre o do servidor do personagem.
 */
export function collectAllWatchKeys(map: WatchedItemsByServer): string[] {
  const seen = new Set<string>();
  for (const items of Object.values(map)) {
    for (const item of items) {
      const key = normalizeWatchedItemName(item.name);
      if (key) seen.add(key);
    }
  }
  return Array.from(seen);
}

/**
 * Reprecifica um item nos resultados persistidos da última consulta,
 * SOMENTE para os personagens do servidor indicado (edição pelo modal
 * "Detalhes"): matches do item ganham novo `baseValueKk`, o `unitValueKk`
 * é recalculado pela MESMA regra de Tier (+20%/nível) e os totais do
 * personagem são refeitos. Personagens de OUTROS servidores e correções
 * manuais (`manualTotalKk`) não são tocados.
 */
export function repriceQueryResultsForServerItem(
  results: BazaarItemsCharacterResult[],
  server: string,
  watchedName: string,
  newBaseValueKk: number,
): BazaarItemsCharacterResult[] {
  const serverKey = canonicalServerKey(server);
  const nameKey = normalizeWatchedItemName(watchedName);
  return (Array.isArray(results) ? results : []).map(result => {
    if (canonicalServerKey(result.server) !== serverKey) return result;
    let touched = false;
    const matches = (result.matches || []).map(match => {
      if (normalizeWatchedItemName(match.watchedName) !== nameKey) return match;
      touched = true;
      const unitValueKk = computeTieredValueKk(newBaseValueKk, match.tier);
      const totalKk = Math.round(unitValueKk * match.amount * 100) / 100;
      return { ...match, baseValueKk: newBaseValueKk, unitValueKk, totalKk };
    });
    if (!touched) return result;
    // Total = matches reprecificados + parcela de OURO do personagem (que
    // não depende de preço de item — preservada, nunca duplicada).
    const goldKk = Number.isFinite(result.goldKk) && (result.goldKk || 0) > 0 ? (result.goldKk as number) : 0;
    const totalKk = Math.round((matches.reduce((sum, item) => sum + item.totalKk, 0) + goldKk) * 100) / 100;
    return { ...result, matches, totalKk };
  });
}

/**
 * "ADICIONAR ITEM" DO MODAL LISTA DE ITENS — cria o item na lista de TODOS
 * os servidores de uma só vez (o usuário não precisa cadastrar o mesmo item
 * servidor por servidor). Regras:
 *   • universo de servidores = lista oficial (`serverUniverse`) ∪ servidores
 *     que JÁ possuem lista no mapa (dados antigos nunca ficam de fora);
 *   • servidor onde o item JÁ existe permanece INTACTO — valor e data de
 *     atualização preservados (cada servidor mantém o próprio preço);
 *   • servidor sem o item recebe uma cópia com o valor informado e ids
 *     próprios (nunca compartilhados entre servidores);
 *   • sem duplicação: o casamento é por nome normalizado
 *     (normalizeWatchedItemName), a MESMA chave usada pela consulta;
 *   • se o item já existir em todos os servidores, devolve o MESMO mapa
 *     (referência) e `addedServers` vazio — nada é gravado.
 */
export function addWatchedItemToAllServers(
  map: WatchedItemsByServer,
  serverUniverse: readonly string[],
  name: string,
  valueKk: number,
  nowMs: number,
): { map: WatchedItemsByServer; addedServers: string[] } {
  const trimmedName = String(name || "").trim();
  const nameKey = normalizeWatchedItemName(trimmedName);
  if (!nameKey) return { map, addedServers: [] };
  // Universo: servidores oficiais + qualquer servidor já presente no mapa.
  const servers: string[] = [];
  const seen = new Set<string>();
  for (const server of serverUniverse || []) {
    const key = canonicalServerKey(server);
    if (key && !seen.has(key)) { seen.add(key); servers.push(key); }
  }
  for (const server of Object.keys(map || {})) {
    const key = canonicalServerKey(server);
    if (key && !seen.has(key)) { seen.add(key); servers.push(key); }
  }
  const next: WatchedItemsByServer = { ...map };
  const addedServers: string[] = [];
  for (const server of servers) {
    const items = next[server] || [];
    if (items.some(item => normalizeWatchedItemName(item.name) === nameKey)) continue;
    next[server] = [
      ...items,
      {
        id: `wi_${nowMs.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        name: trimmedName,
        valueKk,
        updatedAtMs: nowMs,
      },
    ];
    addedServers.push(server);
  }
  return addedServers.length > 0 ? { map: next, addedServers } : { map, addedServers };
}

/**
 * BOTÃO "ATUALIZAR" DA GUIA ITENS — reprecifica TODOS os personagens da
 * última consulta com os preços ATUAIS das Listas de Itens (por servidor),
 * 100% localmente. É a versão "consulta inteira" do
 * repriceQueryResultsForServerItem, com as MESMAS regras:
 *   • cada match usa o valor do item na lista do SERVIDOR do personagem
 *     (nunca preço de outro servidor);
 *   • Tier: base × (1 + 0,2 × tier), via computeTieredValueKk;
 *   • Ouro do personagem preservado e somado UMA única vez ao total;
 *   • `manualTotalKk` (correção manual) NUNCA é tocado — o cálculo
 *     automático é refeito por baixo, e a prioridade do manual permanece
 *     com a regra de exibição existente (effectiveTotalKk);
 *   • item que saiu da lista do servidor: o match mantém o snapshot da
 *     consulta (não zera nem inventa preço);
 *   • dados brutos da consulta (nome, tier, quantidade, bid, encerramento)
 *     intactos — só os campos de valor derivados mudam;
 *   • nada mudou ⇒ devolve o MESMO array (referência), sinalizando ao
 *     chamador que nenhuma persistência é necessária.
 */
export function repriceAllQueryResults(
  results: BazaarItemsCharacterResult[],
  map: WatchedItemsByServer,
): { results: BazaarItemsCharacterResult[]; changedCount: number } {
  let changedCount = 0;
  const out = (Array.isArray(results) ? results : []).map(result => {
    const serverItems = getServerWatchedItems(map, canonicalServerKey(String(result.server || "")));
    if (serverItems.length === 0) return result;
    const index = buildWatchlistIndex(serverItems);
    let touched = false;
    const matches = (result.matches || []).map(match => {
      const watched = index.get(normalizeWatchedItemName(match.watchedName));
      if (!watched || watched.valueKk === match.baseValueKk) return match;
      touched = true;
      const unitValueKk = computeTieredValueKk(watched.valueKk, match.tier);
      const totalKk = Math.round(unitValueKk * match.amount * 100) / 100;
      return { ...match, baseValueKk: watched.valueKk, unitValueKk, totalKk };
    });
    if (!touched) return result;
    changedCount += 1;
    // Total = matches reprecificados + parcela de OURO (independente de
    // preço de item — preservada, nunca duplicada). Mesma fórmula do
    // repriceQueryResultsForServerItem.
    const goldKk = Number.isFinite(result.goldKk) && (result.goldKk || 0) > 0 ? (result.goldKk as number) : 0;
    const totalKk = Math.round((matches.reduce((sum, item) => sum + item.totalKk, 0) + goldKk) * 100) / 100;
    return { ...result, matches, totalKk };
  });
  return changedCount > 0 ? { results: out, changedCount } : { results, changedCount: 0 };
}

/**
 * "ATUALIZAR" DO MODAL DETALHES — propaga o valor de UM item para TODAS as
 * listas de servidores. Regras de eficiência (as listas são 100% locais —
 * localStorage —, mas o princípio de "só gravar o necessário" vale igual):
 *   • altera SOMENTE o item de nome casado (normalizeWatchedItemName) —
 *     nenhum outro item de nenhuma lista é tocado;
 *   • servidor cuja lista NÃO contém o item permanece intacto (a propagação
 *     não cria o item onde ele nunca foi cadastrado);
 *   • servidor que JÁ está no valor novo não é regravado (updatedAtMs
 *     preservado — mesma regra "data só muda se o valor mudou" da edição);
 *   • se nada mudou, devolve o MESMO mapa (referência), sinalizando ao
 *     chamador que nenhuma persistência/reprecificação é necessária.
 */
export function propagateWatchedItemValueToAllServers(
  map: WatchedItemsByServer,
  watchedName: string,
  valueKk: number,
  nowMs: number,
): { map: WatchedItemsByServer; changedServers: string[] } {
  const nameKey = normalizeWatchedItemName(watchedName);
  const next: WatchedItemsByServer = {};
  const changedServers: string[] = [];
  for (const [server, items] of Object.entries(map || {})) {
    let touched = false;
    const list = (items || []).map(item => {
      if (normalizeWatchedItemName(item.name) !== nameKey) return item;
      if (item.valueKk === valueKk) return item;
      touched = true;
      return { ...item, valueKk, updatedAtMs: nowMs };
    });
    if (touched) changedServers.push(server);
    next[server] = touched ? list : items;
  }
  return changedServers.length > 0 ? { map: next, changedServers } : { map, changedServers };
}

/**
 * Mescla de importação (mesma regra que o painel sempre usou): itens novos
 * entram; nomes já existentes têm o valor ATUALIZADO pelo arquivo quando
 * diferente (a importação é a fonte mais recente) — com a data do arquivo
 * quando presente, senão `nowMs`.
 */
export function mergeWatchedLists(
  current: WatchedItem[],
  incoming: WatchedItem[],
  nowMs = Date.now(),
): { merged: WatchedItem[]; added: number; updated: number } {
  const merged = [...current];
  let added = 0;
  let updated = 0;
  for (const item of incoming) {
    const key = normalizeWatchedItemName(item.name);
    const existingIndex = merged.findIndex(entry => normalizeWatchedItemName(entry.name) === key);
    if (existingIndex >= 0) {
      if (merged[existingIndex].valueKk !== item.valueKk) {
        merged[existingIndex] = {
          ...merged[existingIndex],
          valueKk: item.valueKk,
          updatedAtMs: item.updatedAtMs || nowMs,
        };
        updated += 1;
      }
    } else {
      merged.push({ ...item });
      added += 1;
    }
  }
  return { merged, added, updated };
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
// "TENHO INTERESSE" DO PAINEL DE ITENS — 100% LOCAL (localStorage, por uid)
// ----------------------------------------------------------------------------
// Requisito explícito da funcionalidade: o interesse deste painel NÃO passa
// pelo Firestore em NENHUMA hipótese (nem registro, nem atualização, nem
// sincronização). O formato é um simples array de ids de leilão marcados
// pelo usuário neste dispositivo.
// ============================================================================

function itemsInterestsKey(uid: string): string {
  return `${BAZAAR_ITEMS_INTERESTS_KEY_PREFIX}${String(uid || "").trim() || "local"}`;
}

/** Ids de leilão marcados como "Tenho Interesse" no painel de itens (local). */
export function loadItemsInterests(uid: string): string[] {
  const raw = loadUIState<unknown>(itemsInterestsKey(uid), []);
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const entry of raw) {
    const id = String(entry ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function saveItemsInterests(uid: string, auctionIds: string[]): void {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const entry of auctionIds || []) {
    const id = String(entry ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  saveUIState(itemsInterestsKey(uid), ids);
}

// ============================================================================
// EXPORTAR / IMPORTAR a Lista de Itens (arquivo JSON)
// ============================================================================

function serializeWatchedItem(item: WatchedItem): { name: string; valueKk: number; updatedAtMs?: number } {
  return {
    name: item.name,
    valueKk: item.valueKk,
    // Preserva a data da última atualização de valor no arquivo, para que
    // um import em outro dispositivo mantenha o histórico visível.
    ...(item.updatedAtMs ? { updatedAtMs: item.updatedAtMs } : {}),
  };
}

/**
 * Exportação "Apenas Este Servidor": mantém o formato v1 (compatível com
 * versões anteriores do importador) acrescido do campo informativo `server`.
 */
export function exportWatchlistJson(items: WatchedItem[], server?: string): string {
  return JSON.stringify(
    {
      kind: "bazaar-watched-items",
      version: 1,
      exportedAt: new Date().toISOString(),
      ...(server ? { server } : {}),
      items: items.map(serializeWatchedItem),
    },
    null,
    2,
  );
}

/**
 * Exportação "Todos Servidores": UM único documento com a lista de CADA
 * servidor, preservando a estrutura Servidor → Item → Valor.
 */
export function exportWatchlistByServerJson(map: WatchedItemsByServer): string {
  const servers: Record<string, ReturnType<typeof serializeWatchedItem>[]> = {};
  for (const server of Object.keys(map).sort((a, b) => a.localeCompare(b, "pt-BR"))) {
    const items = map[server];
    if (!items || items.length === 0) continue;
    servers[server] = items.map(serializeWatchedItem);
  }
  return JSON.stringify(
    {
      kind: "bazaar-watched-items",
      version: 2,
      scope: "all-servers",
      exportedAt: new Date().toISOString(),
      servers,
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

/**
 * Interpreta QUALQUER arquivo de lista suportado e classifica o conteúdo:
 * - `kind: "multi"` — arquivo v2 "Todos Servidores" (`servers` = mapa
 *   Servidor → itens, já saneado e com nomes de servidor canônicos);
 * - `kind: "single"` — formato v1 / array puro (uma lista, sem servidor
 *   embutido para restauração — o destino é escolhido pelo usuário).
 */
export function parseWatchlistImportAny(text: string):
  | { kind: "multi"; servers: WatchedItemsByServer; error: null }
  | { kind: "single"; items: WatchedItem[]; error: null }
  | { kind: "error"; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(text || ""));
  } catch {
    return { kind: "error", error: "Arquivo inválido: não foi possível ler o JSON." };
  }
  const obj = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
  if (obj && obj.servers && typeof obj.servers === "object" && !Array.isArray(obj.servers)) {
    const servers = sanitizeWatchedItemsByServer(obj.servers);
    if (Object.keys(servers).length === 0) {
      return { kind: "error", error: "Nenhum item válido no arquivo (cada item precisa de nome e valor em kk > 0)." };
    }
    return { kind: "multi", servers, error: null };
  }
  const single = parseWatchlistImport(text);
  if (single.error) return { kind: "error", error: single.error };
  return { kind: "single", items: single.items, error: null };
}
