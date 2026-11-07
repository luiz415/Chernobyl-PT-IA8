// ============================================================================
// ITENS MANUAIS DO "ITENS À VENDA" (89ª) — Meus Personagens
// ----------------------------------------------------------------------------
// Núcleo PURO (testável sem DOM) dos itens ADICIONADOS MANUALMENTE pelo
// usuário no modal "Itens à Venda": itens que NÃO vieram da identificação
// automática do sistema (Quests declaradas nos personagens, snapshot do
// Bazaar ou negociações) e por isso não têm personagem/negociação de origem.
//
// CATEGORIA "MANUAL": esses itens carregam identificação própria em TODO o
// modal (badge "Manual", origem própria no filtro e no Texto de Venda) —
// nunca se confundem com os itens encontrados automaticamente.
//
// PERSISTÊNCIA — 100% LOCAL, POR USUÁRIO (decisão explícita):
//   • localStorage `rubinot_manual_sale_items_<uid||"local">` — o MESMO
//     padrão das demais extensões locais deste modal (ordenação 76ª, seleção
//     do Texto de Venda 76ª, config do anúncio 75ª);
//   • NENHUMA escrita no Firestore/Cloud Functions: o dado é privado do
//     usuário, não participa de validação cruzada nem de fluxo compartilhado
//     — não há vantagem real de backend, e evita mudança de schema/rules.
//   • Toda gravação dispara `MANUAL_SALE_ITEMS_UPDATED_EVENT` na própria
//     janela — o App (contador do botão) e o modal recarregam na hora, sem
//     recarregar a página (mesmo padrão dos eventos da Lista de Itens).
//
// O REGISTRO DE VENDA (ItemSaleRecord — a MESMA calculadora oficial
// ItemSoldModal) é gravado no próprio item manual: o item transita entre as
// abas "À Venda"/"Vendidos" pelo MESMO critério canônico dos demais
// (isItemSaleConcluded), sem nenhuma lógica paralela.
// ============================================================================

import type { ItemSaleRecord } from "../types";

/** Um item adicionado MANUALMENTE no "Itens à Venda" (sem origem automática). */
export interface ManualSaleItem {
  /** Id estável (gerado na inclusão) — base da chave `manual:<id>`. */
  id: string;
  /** Nome do item, exatamente como digitado (apresentação faz Title Case). */
  name: string;
  /** Tier do item (0 = sem Tier) — mesma regra de negócio (+30%/nível). */
  tier: number;
  /** Nome canônico do servidor (serverLabel aplicado na inclusão). */
  server: string;
  /** Data REAL de inclusão (epoch ms) — nunca inventada. */
  addedAtMs: number;
  /** Registro de venda da calculadora oficial — null enquanto pendente. */
  sale: ItemSaleRecord | null;
}

/** Evento (janela atual) disparado a CADA gravação da lista de itens manuais. */
export const MANUAL_SALE_ITEMS_UPDATED_EVENT = "rubinot:manual-sale-items-updated";

export const MANUAL_SALE_ITEMS_KEY_PREFIX = "rubinot_manual_sale_items_";
export function manualSaleItemsKey(uid: string): string {
  return `${MANUAL_SALE_ITEMS_KEY_PREFIX}${String(uid || "").trim() || "local"}`;
}

/** Tier máximo aceito (mesma faixa exibida nos itens do Bazaar). */
export const MANUAL_ITEM_MAX_TIER = 10;

function sanitizeTier(raw: unknown): number {
  const tier = Math.floor(Number(raw) || 0);
  return Number.isFinite(tier) ? Math.min(MANUAL_ITEM_MAX_TIER, Math.max(0, tier)) : 0;
}

/** Normaliza UM registro vindo do storage; null = inválido (descartado). */
function sanitizeManualSaleItem(raw: unknown): ManualSaleItem | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Partial<Record<keyof ManualSaleItem, unknown>>;
  const id = String(source.id || "").trim();
  const name = String(source.name || "").trim();
  const server = String(source.server || "").trim();
  if (!id || !name || !server) return null;
  const addedAtMs = Number(source.addedAtMs) || 0;
  const sale = source.sale && typeof source.sale === "object" ? (source.sale as ItemSaleRecord) : null;
  return { id, name, tier: sanitizeTier(source.tier), server, addedAtMs: addedAtMs > 0 ? addedAtMs : 0, sale };
}

export function loadManualSaleItems(uid: string): ManualSaleItem[] {
  try {
    const raw = localStorage.getItem(manualSaleItemsKey(uid));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(sanitizeManualSaleItem).filter((item): item is ManualSaleItem => item !== null);
  } catch {
    return [];
  }
}

export function saveManualSaleItems(uid: string, items: ManualSaleItem[]): void {
  try {
    localStorage.setItem(manualSaleItemsKey(uid), JSON.stringify(items.map(sanitizeManualSaleItem).filter(Boolean)));
  } catch { /* storage indisponível: a lista vale só para a sessão */ }
  try {
    window.dispatchEvent(new CustomEvent(MANUAL_SALE_ITEMS_UPDATED_EVENT));
  } catch { /* ambiente sem CustomEvent (testes): a gravação permanece válida */ }
}

/**
 * Inclui um item manual — validação completa ANTES de gravar (nada é salvo
 * com dado inválido). Duplicados são PERMITIDOS de propósito: dois itens
 * idênticos à venda (ex.: duas espadas T1) são registros reais distintos.
 */
export function addManualSaleItem(
  uid: string,
  input: { name: string; tier: number; server: string },
): { ok: boolean; error?: string; item?: ManualSaleItem } {
  const name = String(input.name || "").replace(/\s+/g, " ").trim();
  const server = String(input.server || "").trim();
  if (!name) return { ok: false, error: "Informe o nome do item." };
  if (!server) return { ok: false, error: "Selecione o servidor do item." };
  const tier = Math.floor(Number(input.tier));
  if (!Number.isFinite(tier) || tier < 0 || tier > MANUAL_ITEM_MAX_TIER) {
    return { ok: false, error: `Tier inválido — use 0 (sem Tier) a ${MANUAL_ITEM_MAX_TIER}.` };
  }
  const item: ManualSaleItem = {
    id: `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    name,
    tier,
    server,
    addedAtMs: Date.now(),
    sale: null,
  };
  saveManualSaleItems(uid, [...loadManualSaleItems(uid), item]);
  return { ok: true, item };
}

/** Grava/atualiza o registro de venda de UM item manual (calculadora oficial). */
export function setManualSaleItemSale(uid: string, id: string, sale: ItemSaleRecord): boolean {
  const items = loadManualSaleItems(uid);
  const index = items.findIndex(item => item.id === id);
  if (index < 0) return false;
  const next = [...items];
  next[index] = { ...next[index], sale };
  saveManualSaleItems(uid, next);
  return true;
}

/** Remove UM item manual (inclusive o registro de venda, se houver). */
export function removeManualSaleItem(uid: string, id: string): boolean {
  const items = loadManualSaleItems(uid);
  const next = items.filter(item => item.id !== id);
  if (next.length === items.length) return false;
  saveManualSaleItems(uid, next);
  return true;
}
