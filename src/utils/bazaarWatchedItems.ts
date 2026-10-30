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
  /** Valor unitário após o Tier: base × (1 + 0.3 × tier). */
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
  /** Crypt (The Roost of the Graveborn) — mesma derivação/semântica. */
  cryptCompleted?: boolean | null;
  /**
   * Origem da identificação das quests nesta consulta: "quests" = lista de
   * quests do payload (modo novo; SEM contador de bosses — a célula mostra
   * "—"). Ausente/"bosstiary" = derivação pela Bosstiary (original).
   */
  questSource?: "bosstiary" | "quests";
  /**
   * CONTADORES de bosses das quests ("X/Y" da guia Quests) — calculados pela
   * MESMA função (deriveQuestsFromApiPayload) a partir do MESMO payload da
   * consulta de itens. Ausentes em consultas antigas (persistidas antes do
   * campo existir) ou quando a resposta foi inconclusiva — nesse caso a
   * exibição mostra o padrão sem contador, nunca um número inventado.
   */
  soulWarBossCount?: number;
  sanguineBossCount?: number;
  cryptBossCount?: number;
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

/** Regra de negócio do Tier: cada nível vale +30% sobre o valor base. */
export function computeTieredValueKk(baseValueKk: number, tier: number): number {
  const base = Number(baseValueKk);
  const safeTier = Number.isFinite(tier) && tier > 0 ? Math.floor(tier) : 0;
  if (!Number.isFinite(base) || base <= 0) return 0;
  // Duas casas bastam para kk e evitam ruído de ponto flutuante (ex.: 4.5 × 1.3).
  return Math.round(base * (1 + 0.3 * safeTier) * 100) / 100;
}

/**
 * OPERAÇÃO INVERSA do Tier (72ª): valor BASE (kk) derivado de um TOTAL
 * considerado — base = total ÷ quantidade ÷ (1 + 0,3 × tier), arredondado a
 * UMA casa (a precisão aceita pela Lista de Itens, a mesma que o núcleo
 * applyOfficialWatchedItemUpdate grava). É a regra que permite ao Boss
 * editar o valor base a partir do TOTAL exibido no modal "Ver" da guia de
 * quests (que não apresenta o base): o que ele digita como total vira o
 * base equivalente — nunca o valor antigo da consulta. Entradas inválidas
 * (total/quantia não positivos) devolvem 0 (botões de atualização
 * desabilitam; nada é gravado).
 */
export function deriveWatchedBaseKkFromTotal(totalKk: number, amount: number, tier: number): number {
  const total = Number(totalKk);
  if (!Number.isFinite(total) || total <= 0) return 0;
  const safeAmount = Number.isFinite(amount) && amount > 0 ? Math.floor(amount) : 1;
  const safeTier = Number.isFinite(tier) && tier > 0 ? Math.floor(tier) : 0;
  return Math.round((total / safeAmount / (1 + 0.3 * safeTier)) * 10) / 10;
}

// ── ENTRADA DE VALORES EM KK (modais de Meus Personagens — 73ª) ─────────────
// MESMAS regras dos campos de valor da guia Itens (sanitizeDecimalKk/
// parseDecimalKk do BazaarItemsPanel): dígitos + um único separador, no
// máximo 1 casa decimal; válido = número finito > 0. Exportadas daqui para
// os modais "Itens Encontrados"/"Itens à Venda" usarem a MESMA validação da
// Lista de Itens sem duplicar a regra em cada componente.

/** Mantém apenas dígitos e UM separador decimal (máx. 1 casa) no campo. */
export function sanitizeDecimalKkText(raw: string): string {
  let text = String(raw || "").replace(/[^\d.,]+/g, "").slice(0, 11);
  // Um único separador (o primeiro vale); demais são removidos.
  const sepIndex = text.search(/[.,]/);
  if (sepIndex >= 0) {
    const head = text.slice(0, sepIndex + 1);
    const tail = text.slice(sepIndex + 1).replace(/[.,]+/g, "");
    text = head + tail.slice(0, 1); // no máximo 1 casa decimal
  }
  return text;
}

/**
 * Converte o texto do campo em número kk com 1 casa decimal.
 * null = inválido (vazio, zero, formato errado).
 */
export function parseDecimalKkText(raw: string): number | null {
  const text = String(raw || "").trim().replace(",", ".");
  if (!/^\d+(\.\d)?$/.test(text)) return null;
  const value = Math.round(Number(text) * 10) / 10;
  return Number.isFinite(value) && value > 0 ? value : null;
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
 * Item da Lista de Itens de UM servidor casado pelo NOME (73ª) — a MESMA
 * regra de casamento da consulta (nome base sem o sufixo "[Tier x]",
 * normalizado sem acentos/caixa). null = item não cadastrado na lista
 * daquele servidor (a exibição mostra o fallback/"—", nunca inventa valor).
 * Usada pelos modais "Itens Encontrados"/"Itens à Venda" de Meus Personagens
 * para exibir o valor BASE vivo do servidor do personagem.
 */
export function findServerWatchedItem(map: WatchedItemsByServer, server: string, itemName: string): WatchedItem | null {
  const nameKey = normalizeWatchedItemName(parseTieredItemName(String(itemName || "")).baseName);
  if (!nameKey) return null;
  return getServerWatchedItems(map, server).find(item => normalizeWatchedItemName(item.name) === nameKey) || null;
}

/**
 * EDIÇÃO DO VALOR CONSIDERADO de um item do snapshot da compra (73ª) —
 * função PURA usada pelos modais "Itens Encontrados" e "Itens à Venda" de
 * Meus Personagens: grava o novo total (kk, 1 casa decimal) no PRÓPRIO match
 * e recalcula o total automático do personagem (matches restantes + Ouro),
 * EXATAMENTE como a remoção de item já faz.
 *
 * CORREÇÃO MANUAL (83ª tarefa — auditoria do Valor Itens): a edição
 * individual LIMPA a correção manual da compra (`manualTotalKk`). Antes ela
 * era preservada E continuava prioritária no total efetivo — ou seja, o
 * valor editado pelo usuário era IGNORADO nos cálculos (Valor Itens (RC),
 * rodapé do modal "Ver"). A precedência agora é a MESMA do modal "Ver" do
 * Painel Bazaar (`hasValueOverride`/buildPurchaseItemsSnapshot): a
 * personalização mais recente por item prevalece e o total efetivo passa a
 * ser o recalculado (itens + Ouro). Snapshots sem correção manual seguem
 * idênticos ao comportamento anterior.
 *
 * Retorna null quando o índice/valor é inválido; retorna o MESMO objeto
 * quando o valor já está em vigor (idempotência — nada a gravar).
 */
export function updateSnapshotMatchTotalKk<S extends { totalKk: number; goldKk?: number; manualTotalKk?: number | null; matches: Array<{ totalKk: number }> }>(
  snap: S,
  matchIndex: number,
  newTotalKk: number,
): S | null {
  const value = Math.round(Number(newTotalKk) * 10) / 10;
  if (!Number.isFinite(value) || value <= 0) return null;
  if (!snap || !Array.isArray(snap.matches) || matchIndex < 0 || matchIndex >= snap.matches.length) return null;
  if (snap.matches[matchIndex].totalKk === value) return snap;
  const matches = snap.matches.map((m, i) => (i === matchIndex ? { ...m, totalKk: value } : m));
  const autoTotal = Math.round((matches.reduce((sum, m) => sum + (Number(m.totalKk) || 0), 0) + (Number(snap.goldKk) || 0)) * 100) / 100;
  // Edição individual > correção manual antiga (nunca o contrário): o manual
  // é zerado para o total recalculado — com o valor que o usuário acabou de
  // definir — valer em TODOS os cálculos e exibições.
  return { ...snap, matches, totalKk: autoTotal, manualTotalKk: null };
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
 * é recalculado pela MESMA regra de Tier (+30%/nível) e os totais do
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
 *   • Tier: base × (1 + 0,3 × tier), via computeTieredValueKk;
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
 * "ATUALIZAR VALOR PARA TODOS OS SERVIDORES" (modal Detalhes e Lista de
 * Itens) — propaga o valor de UM item para TODAS as listas de servidores,
 * CRIANDO o item onde ele ainda não existir (valor propagado como valor
 * inicial). Regras de eficiência (as listas são 100% locais — localStorage
 * —, mas o princípio de "só gravar o necessário" vale igual):
 *   • altera SOMENTE o item de nome casado (normalizeWatchedItemName — a
 *     MESMA chave de identificação da Lista/consulta; variações de caixa ou
 *     formatação nunca duplicam) — nenhum outro item de nenhuma lista é
 *     tocado;
 *   • servidor sem o item recebe uma cópia nova com id próprio
 *     (`addedServers`); universo = lista oficial ∪ servidores já no mapa;
 *   • servidor que JÁ está no valor novo não é regravado (updatedAtMs
 *     preservado — mesma regra "data só muda se o valor mudou" da edição);
 *     repetir a operação é idempotente: nada é criado nem regravado;
 *   • se nada mudou, devolve o MESMO mapa (referência), sinalizando ao
 *     chamador que nenhuma persistência/reprecificação é necessária.
 */
export function propagateWatchedItemValueToAllServers(
  map: WatchedItemsByServer,
  watchedName: string,
  valueKk: number,
  nowMs: number,
  /**
   * Universo de servidores onde o item deve EXISTIR após a propagação
   * (lista oficial). Servidores presentes só no mapa também entram. Vazio =
   * comportamento antigo (atualiza apenas onde o item já existe).
   */
  serverUniverse: readonly string[] = [],
): { map: WatchedItemsByServer; changedServers: string[]; addedServers: string[] } {
  const trimmedName = String(watchedName || "").trim();
  const nameKey = normalizeWatchedItemName(trimmedName);
  if (!nameKey) return { map, changedServers: [], addedServers: [] };
  // Universo: servidores oficiais + qualquer servidor já presente no mapa
  // (mesma regra do addWatchedItemToAllServers — dados antigos nunca ficam
  // de fora, e a ordem oficial prevalece).
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
  const changedServers: string[] = [];
  const addedServers: string[] = [];
  for (const server of servers) {
    const items = next[server] || [];
    const index = items.findIndex(item => normalizeWatchedItemName(item.name) === nameKey);
    if (index >= 0) {
      // Item EXISTE neste servidor: atualiza somente se o valor mudou
      // (idempotência — repetir a operação não regrava nem toca a data).
      if (items[index].valueKk === valueKk) continue;
      next[server] = items.map((item, i) => (i === index ? { ...item, valueKk, updatedAtMs: nowMs } : item));
      changedServers.push(server);
    } else {
      // Item NÃO existe neste servidor: cria com o valor propagado como
      // valor inicial e id próprio (nunca compartilhado entre servidores).
      // Nome preservado como informado (o casamento é sempre pelo nome
      // normalizado, então variações de caixa não geram duplicata).
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
  }
  return changedServers.length > 0 || addedServers.length > 0
    ? { map: next, changedServers, addedServers }
    : { map, changedServers, addedServers };
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

// ============================================================================
// ATUALIZAÇÃO OFICIAL A PARTIR DOS MODAIS "VER" (66ª tarefa) — NÚCLEO ÚNICO.
//
// Usado pela coluna "Atualizar" dos modais "Ver" do Painel Bazaar (guia de
// quests) e de Meus Personagens → Itens (exclusivos do Boss): grava o valor
// BASE de um item na "Lista de Itens" oficial (a MESMA fonte da guia
// "Personagens com Itens") — em TODOS os servidores ou SOMENTE no servidor
// do personagem do modal.
//
// Reutiliza integralmente as regras existentes (nenhuma fonte paralela,
// nenhuma fórmula nova):
//   • escopo GLOBAL: propagateWatchedItemValueToAllServers — o mesmo núcleo
//     do botão "Atualizar" do modal Detalhes/Lista de Itens (atualiza onde o
//     valor difere, cria onde não existe, data só muda se o valor mudou);
//   • escopo SERVIDOR: a mesma regra da edição inline do modal Detalhes
//     (atualiza/cria APENAS na lista do servidor — as demais ficam intactas);
//   • reprecifica a última consulta da guia Itens SÓ nos servidores tocados
//     (repriceQueryResultsForServerItem), preservando correções manuais e a
//     parcela de Ouro; a gravação dispara o evento que o painel já escuta.
//
// As listas são 100% LOCAIS (localStorage do dispositivo do Boss — decisão
// de arquitetura da guia Itens): não existe escrita em backend nesta
// operação, logo não há autorização de backend aplicável; o gate de cargo é
// o mesmo da guia Itens (recursos exclusivos do Boss na interface).
//
// CONCORRÊNCIA: a operação é síncrona (localStorage), mas um guard de
// reentrância garante que dois acionamentos jamais se intercalem (o segundo
// recebe erro e nada grava). Em QUALQUER falha, nada parcial é persistido
// antes do ponto de gravação única do mapa.
// ============================================================================

/** Disparado quando a Lista de Itens oficial é gravada FORA da guia Itens. */
export const BAZAAR_WATCHED_ITEMS_UPDATED_EVENT = "bazaar-watched-items-updated";

export interface OfficialItemUpdateResult {
  ok: boolean;
  error?: string;
  /** Servidores cujo VALOR foi efetivamente alterado. */
  changedServers: string[];
  /** Servidores onde o item foi CRIADO (ainda não existia na lista). */
  addedServers: string[];
}

let officialItemUpdateInProgress = false;

export function applyOfficialWatchedItemUpdate(input: {
  /** "all" = todas as listas de servidores; "server" = só a do personagem. */
  scope: "all" | "server";
  /** Servidor do personagem do modal (alvo do escopo "server" e do reprice). */
  server: string;
  /** Nome do item (da lista quando conhecido; aceita o encontrado com [Tier x]). */
  itemName: string;
  /** Valor BASE (kk, até 1 casa decimal) a gravar na(s) lista(s). */
  valueKk: number;
  /** Universo oficial de servidores (SERVER_OPTIONS) — escopo "all". */
  serverUniverse: readonly string[];
}): OfficialItemUpdateResult {
  const fail = (error: string): OfficialItemUpdateResult => ({ ok: false, error, changedServers: [], addedServers: [] });
  if (officialItemUpdateInProgress) return fail("Já existe uma atualização em andamento — aguarde a conclusão.");
  officialItemUpdateInProgress = true;
  try {
    // Nome BASE do item (sem o sufixo [Tier x]) — mesma separação oficial.
    const baseName = parseTieredItemName(String(input.itemName || "")).baseName;
    const nameKey = normalizeWatchedItemName(baseName);
    if (!nameKey) return fail("Item sem nome válido para atualizar.");
    // Valor base com a MESMA precisão aceita pela Lista de Itens (1 casa).
    const valueKk = Math.round(Number(input.valueKk) * 10) / 10;
    if (!Number.isFinite(valueKk) || valueKk < 0.1) return fail("Valor base inválido (precisa ser maior que zero, com até 1 casa decimal).");
    const now = Date.now();
    const map = loadWatchedItemsByServer();
    // Nome CANÔNICO: se o item já está cadastrado em alguma lista, preserva
    // o nome de lá (evita variação de caixa/acentos); senão usa o base.
    let canonicalName = baseName;
    for (const items of Object.values(map)) {
      const listed = (items || []).find(item => normalizeWatchedItemName(item.name) === nameKey);
      if (listed) { canonicalName = listed.name; break; }
    }

    let nextMap: WatchedItemsByServer;
    let changedServers: string[] = [];
    let addedServers: string[] = [];
    if (input.scope === "all") {
      // MESMO núcleo do "Atualizar" global do modal Detalhes/Lista de Itens.
      const result = propagateWatchedItemValueToAllServers(map, canonicalName, valueKk, now, input.serverUniverse);
      nextMap = result.map;
      changedServers = result.changedServers;
      addedServers = result.addedServers;
    } else {
      // MESMA regra da edição inline do modal Detalhes: SOMENTE a lista do
      // servidor do personagem — nenhum outro servidor é tocado.
      const serverKey = canonicalServerKey(String(input.server || ""));
      if (!serverKey) return fail("Servidor do personagem não identificado.");
      const items = map[serverKey] || [];
      const index = items.findIndex(item => normalizeWatchedItemName(item.name) === nameKey);
      if (index >= 0) {
        if (items[index].valueKk === valueKk) {
          // Idempotência: valor já em vigor — nada a gravar, data intacta.
          return { ok: true, changedServers: [], addedServers: [] };
        }
        nextMap = { ...map, [serverKey]: items.map((item, i) => (i === index ? { ...item, valueKk, updatedAtMs: now } : item)) };
        changedServers = [serverKey];
      } else {
        nextMap = {
          ...map,
          [serverKey]: [...items, { id: `wi_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`, name: canonicalName, valueKk, updatedAtMs: now }],
        };
        addedServers = [serverKey];
      }
    }

    if (changedServers.length === 0 && addedServers.length === 0) {
      // Tudo já estava no valor (idempotência) — nenhuma gravação.
      return { ok: true, changedServers, addedServers };
    }
    // Gravação ÚNICA do mapa (mesma chave/formato de sempre).
    saveWatchedItemsByServer(nextMap);
    // Reprecifica a última consulta da guia Itens SÓ nos servidores tocados
    // (correções manuais e Ouro preservados). A gravação dispara o evento
    // BAZAAR_ITEMS_LAST_QUERY_UPDATED_EVENT — o painel/App já escutam.
    try {
      const lastQuery = loadItemsLastQuery();
      if (lastQuery && Array.isArray(lastQuery.results) && lastQuery.results.length > 0) {
        let repriced = lastQuery.results;
        for (const server of [...changedServers, ...addedServers]) {
          repriced = repriceQueryResultsForServerItem(repriced, server, canonicalName, valueKk);
        }
        if (repriced !== lastQuery.results) {
          saveItemsLastQuery({ ...lastQuery, results: repriced });
        }
      }
    } catch { /* consulta local ilegível: a lista já foi atualizada; o botão "Atualizar" do quadro reprecifica depois */ }
    // Avisa a guia Itens (se montada) para recarregar a lista do storage.
    try { window.dispatchEvent(new Event(BAZAAR_WATCHED_ITEMS_UPDATED_EVENT)); } catch {}
    return { ok: true, changedServers, addedServers };
  } catch (error) {
    return fail(String((error as Error)?.message || error || "Falha ao atualizar a Lista de Itens."));
  } finally {
    officialItemUpdateInProgress = false;
  }
}

// ── LEGADO: cotação ÚNICA do coin (taxa fixa global) ────────────────────────
// Substituída pela cotação POR SERVIDOR (src/utils/bazaarCoinRates.ts —
// persistida em users/{uid}.bazaarCoinRates e espelhada em localStorage).
// Nenhum cálculo do aplicativo usa mais estas funções; os exports permanecem
// apenas por compatibilidade (chave antiga do localStorage não é migrada).
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
  // AVISO LOCAL (mesma janela) de que a última consulta de itens mudou —
  // a guia Quests usa este evento para manter a coluna "Valor Itens (kk)"
  // em dia sem reler o localStorage a cada render (o evento "storage" do
  // navegador NÃO dispara na própria janela que gravou). Nenhuma rede,
  // nenhum Firestore — é um CustomEvent no próprio window.
  try {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(BAZAAR_ITEMS_LAST_QUERY_UPDATED_EVENT));
    }
  } catch { /* ambiente sem window (testes) — gravação já feita acima */ }
}

/** Nome do evento local disparado sempre que a última consulta de itens é salva. */
export const BAZAAR_ITEMS_LAST_QUERY_UPDATED_EVENT = "bazaar-items-last-query-updated";

/**
 * Valor EFETIVO do "Valor Itens (KK)" de um personagem: a correção MANUAL
 * (quando presente e válida) tem prioridade sobre o total calculado pela
 * consulta. FONTE ÚNICA — exibição, filtros, ordenação, cálculo de RC e a
 * coluna "Valor Itens (kk)" da guia Quests passam todos por aqui (o painel
 * de itens importa daqui; nenhuma lógica paralela).
 */
export function effectiveTotalKk(result: BazaarItemsCharacterResult): number {
  const manual = Number(result.manualTotalKk);
  return Number.isFinite(manual) && manual > 0 ? manual : result.totalKk;
}

/** true quando o personagem tem correção manual ativa no KK. */
export function hasManualTotalKk(result: BazaarItemsCharacterResult): boolean {
  const manual = Number(result.manualTotalKk);
  return Number.isFinite(manual) && manual > 0;
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

// ── INTERESSE POR REGISTRO ESTÁVEL (71ª tarefa) ─────────────────────────────
// A marcação deixa de ser apenas o id do leilão e passa a guardar TAMBÉM o
// personagem (nome + servidor, normalizados). Motivo: o id do leilão morre
// quando o leilão encerra — um personagem RE-LEILOADO volta com id NOVO e a
// marcação antiga nunca mais batia ("perdia" o interesse entre consultas).
// Com o registro completo, o interesse segue o PERSONAGEM: bate pelo id do
// leilão OU pelo par nome+servidor (identificadores estáveis), então a
// marcação sobrevive quando o personagem some de uma consulta e reaparece
// depois (mesmo leilão ou leilão novo). Continua 100% LOCAL (mesma chave de
// localStorage por uid — ZERO Firestore) e aceita o formato legado (array de
// ids puros), que segue batendo por id e é PROMOVIDO ao formato novo quando
// o personagem é reencontrado em uma consulta.

export interface ItemsInterestRecord {
  /** Id do leilão no momento da marcação ("" só em registro legado anômalo). */
  id: string;
  /** Nome do personagem (como exibido; comparação é normalizada). */
  name: string;
  /** Servidor do personagem (comparação pela chave canônica). */
  server: string;
}

/** Alvo de comparação: um resultado/linha da consulta. */
export interface ItemsInterestTarget {
  id: string;
  name?: string;
  server?: string;
}

function interestNameKey(name: string | undefined): string {
  return String(name || "").trim().toLowerCase();
}

/**
 * Chave de servidor para COMPARAÇÃO de interesses: canônica (fonte única em
 * constants/servers) e, por segurança, caixa-insensível — o fallback de
 * canonicalServerKey preserva a caixa de nomes fora da lista oficial.
 */
function interestServerKey(server: string | undefined): string {
  return canonicalServerKey(String(server || "")).toLowerCase();
}

/** true quando o registro marca este personagem/leilão (id OU nome+servidor). */
export function itemsInterestMatches(record: ItemsInterestRecord, target: ItemsInterestTarget): boolean {
  const targetId = String(target.id || "").trim();
  if (record.id && targetId && record.id === targetId) return true;
  const recordName = interestNameKey(record.name);
  const targetName = interestNameKey(target.name);
  if (!recordName || !targetName || recordName !== targetName) return false;
  const recordServer = interestServerKey(record.server);
  const targetServer = interestServerKey(target.server);
  return !!recordServer && !!targetServer && recordServer === targetServer;
}

/**
 * Carrega os registros de interesse (MESMA chave local por uid de sempre),
 * aceitando o formato legado (strings de id) e o novo (objetos completos).
 */
export function loadItemsInterestRecords(uid: string): ItemsInterestRecord[] {
  const raw = loadUIState<unknown>(itemsInterestsKey(uid), []);
  if (!Array.isArray(raw)) return [];
  const records: ItemsInterestRecord[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      const id = entry.trim();
      if (id) records.push({ id, name: "", server: "" });
      continue;
    }
    if (entry && typeof entry === "object") {
      const id = String((entry as ItemsInterestRecord).id ?? "").trim();
      const name = String((entry as ItemsInterestRecord).name ?? "").trim();
      const server = String((entry as ItemsInterestRecord).server ?? "").trim();
      if (id || (name && server)) records.push({ id, name, server });
    }
  }
  // Dedup: registros que marcam o mesmo personagem/leilão colapsam no mais
  // completo (preferência por quem tem nome+servidor preenchidos).
  const deduped: ItemsInterestRecord[] = [];
  for (const record of records) {
    const existingIndex = deduped.findIndex(item =>
      (record.id && item.id && record.id === item.id) ||
      (interestNameKey(item.name) && interestNameKey(item.name) === interestNameKey(record.name) &&
        interestServerKey(item.server) && interestServerKey(item.server) === interestServerKey(record.server)));
    if (existingIndex < 0) { deduped.push(record); continue; }
    const existing = deduped[existingIndex];
    deduped[existingIndex] = {
      id: existing.id || record.id,
      name: existing.name || record.name,
      server: existing.server || record.server,
    };
  }
  return deduped;
}

export function saveItemsInterestRecords(uid: string, records: ItemsInterestRecord[]): void {
  const clean = (records || [])
    .map(record => ({
      id: String(record?.id ?? "").trim(),
      name: String(record?.name ?? "").trim(),
      server: String(record?.server ?? "").trim(),
    }))
    .filter(record => record.id || (record.name && record.server));
  saveUIState(itemsInterestsKey(uid), clean);
}

/** true quando algum registro marca este personagem/leilão. */
export function isItemsInterestMarked(records: ItemsInterestRecord[], target: ItemsInterestTarget): boolean {
  return (records || []).some(record => itemsInterestMatches(record, target));
}

/**
 * Marca/desmarca o interesse deste personagem. Desmarcar remove TODOS os
 * registros que batem (inclusive legados por id e duplicados por nome) —
 * nunca sobra marcação fantasma.
 */
export function toggleItemsInterestRecord(records: ItemsInterestRecord[], target: ItemsInterestTarget): ItemsInterestRecord[] {
  const current = records || [];
  if (isItemsInterestMarked(current, target)) {
    return current.filter(record => !itemsInterestMatches(record, target));
  }
  return [...current, {
    id: String(target.id || "").trim(),
    name: String(target.name || "").trim(),
    server: String(target.server || "").trim(),
  }];
}

/**
 * PROMOÇÃO DOS REGISTROS a partir de uma consulta: registros legados (só id)
 * reencontrados ganham nome+servidor; registros cujo personagem voltou com
 * LEILÃO NOVO ganham o id atual (os alertas de encerramento usam o id do
 * leilão vivo). Retorna a lista promovida e se algo mudou (o chamador só
 * regrava quando `changed`).
 */
export function upgradeItemsInterestRecords(
  records: ItemsInterestRecord[],
  characters: ItemsInterestTarget[],
): { records: ItemsInterestRecord[]; changed: boolean } {
  let changed = false;
  const upgraded = (records || []).map(record => {
    const match = (characters || []).find(character => itemsInterestMatches(record, character));
    if (!match) return record;
    const nextId = String(match.id || "").trim() || record.id;
    const nextName = record.name || String(match.name || "").trim();
    const nextServer = record.server || String(match.server || "").trim();
    if (nextId === record.id && nextName === record.name && nextServer === record.server) return record;
    changed = true;
    return { id: nextId, name: nextName, server: nextServer };
  });
  return { records: upgraded, changed };
}

/**
 * Ids de leilão VIVOS cobertos pelos interesses — alimenta o agendador de
 * alertas de encerramento (que trabalha por id de leilão, como sempre).
 */
export function interestedAuctionIdsFrom(records: ItemsInterestRecord[], characters: ItemsInterestTarget[]): string[] {
  const ids = new Set<string>();
  for (const character of characters || []) {
    const id = String(character.id || "").trim();
    if (!id) continue;
    if (isItemsInterestMarked(records, character)) ids.add(id);
  }
  return Array.from(ids);
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
