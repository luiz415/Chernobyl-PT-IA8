// ─────────────────────────────────────────────────────────────────────────────
// NÚCLEO da coluna "Valor Itens (kk)" / modal "Ver" do Painel Bazaar — funções
// e tipos PUROS movidos do BazarPanel.tsx na 105ª tarefa (corpos IDÊNTICOS,
// nenhuma regra nova): o painel "Próximo Bid" do rodapé (App) precisa calcular
// o "Valor dos Itens" EXATAMENTE como a guia Quests do Painel Bazaar
// (personalização LOCAL do modal "Ver" > automático; cotação personalizada >
// cotação do servidor), e o App NÃO pode importar o BazarPanel inteiro — o
// painel é carregado sob demanda (lazy) e o rodapé é montado sempre.
// O BazarPanel importa daqui as MESMAS funções que antes viviam nele: uma
// única implementação, zero divergência entre painel e rodapé.
// Nada aqui lê/grava Firestore — somente localStorage (overrides locais).
// ─────────────────────────────────────────────────────────────────────────────
import { loadUIState } from "../storage";
import {
  effectiveTotalKk,
  hasManualTotalKk,
  type BazaarItemsCharacterResult,
} from "./bazaarWatchedItems";

/**
 * REGRA ÚNICA de relevância do resultado de itens de um personagem:
 * há informação para exibir quando existe ao menos UM item monitorado
 * encontrado OU quando o Ouro lido no leilão passa de 1kk. A presença de
 * itens deixou de ser a única condição — personagem só com Ouro (> 1kk)
 * também gera resultado, botão "Ver" e valor na coluna. Ouro até 1kk
 * continua irrelevante sozinho (comportamento anterior preservado).
 * Todos os pontos que decidem "tem dados de itens?" usam ESTE predicado.
 */
const RELEVANT_GOLD_KK_THRESHOLD = 1;
export function hasRelevantLoot(matchCount: number, goldKk: number): boolean {
  const gold = Number(goldKk || 0);
  return matchCount > 0 || (Number.isFinite(gold) && gold > RELEVANT_GOLD_KK_THRESHOLD);
}

/**
 * Dados exibidos pela coluna "Valor Itens (kk)" e pelo modal "Ver" — shape
 * NEUTRO que unifica as DUAS fontes possíveis:
 *   • LOCAL (dispositivo do Boss): última consulta da guia Itens
 *     (`rubinot_bazaar_items_last_query`), que inclui a correção manual;
 *   • EMBUTIDA (todos os usuários): campos `items*` gravados dentro de cada
 *     personagem da lista oficial pela publicação da consulta de Itens.
 * A LOCAL tem prioridade quando existe (é a mais fresca no dispositivo que
 * rodou a consulta); nos demais dispositivos só a embutida existe.
 */
export interface QuestsItemsDetailView {
  name: string;
  server: string;
  /**
   * `watchedName`/`baseValueKk` (66ª tarefa): identificação do item na Lista
   * de Itens e o valor BASE usado na valoração — fonte LOCAL os traz
   * prontos; fonte EMBUTIDA os reconstrói pela MESMA fórmula oficial do
   * Tier já usada no snapshot de compra (buildPurchaseItemsSnapshot).
   * Alimentam a coluna "Atualizar" (exclusiva do Boss) do modal "Ver".
   */
  matches: { foundName: string; tier: number; amount: number; totalKk: number; watchedName?: string; baseValueKk?: number }[];
  /** Valor EFETIVO exibido (correção manual > calculado, quando fonte local). */
  effectiveKk: number;
  /** Valor CALCULADO pela consulta (para o tooltip quando há manual). */
  calculatedKk: number;
  isManual: boolean;
  goldKk: number;
  /** Chave do leilão (mesma getAuctionKey da tabela) — indexa a personalização LOCAL do modal. */
  auctionKey?: string;
}

// ── MODAL "VER" — PERSONALIZAÇÃO LOCAL DE VALORES ───────────────────────────
// O usuário pode ajustar, SOMENTE para si: o valor do Coin usado na conversão
// para RC, o valor considerado de cada item e o valor do Ouro. NADA disso é
// gravado no Firestore nem afeta outros usuários: vive no localStorage deste
// dispositivo (chave por usuário) e é DESCARTADO automaticamente quando o
// personagem deixa de existir na lista atual (poda contra os leilões
// presentes — nunca acumula personagens removidos indefinidamente).
// A conversão kk → RC usa a MESMA função canônica do aplicativo
// (computeItemRC: floor(kk ÷ cotação × 1000); cotação = quantos k equivalem
// a 1000 RC — idêntica à guia Itens).
export interface QuestsViewOverride {
  /** Cotação do coin usada na conversão (k por 1000 RC). */
  coinRateKk?: number;
  /** Valor do Ouro (kk) personalizado. */
  goldKk?: number;
  /** Valor (kk) personalizado por item — chave `${índice}:${nome}`. */
  items?: Record<string, number>;
}
export type QuestsViewOverridesMap = Record<string, QuestsViewOverride>;
const BAZAR_QUESTS_VIEW_OVERRIDES_KEY_PREFIX = "rubinot_bazaar_quests_view_overrides_";
export function questsViewOverridesKey(uid?: string): string {
  return `${BAZAR_QUESTS_VIEW_OVERRIDES_KEY_PREFIX}${uid || "anon"}`;
}
export function readQuestsViewOverrides(uid?: string): QuestsViewOverridesMap {
  const raw = loadUIState<QuestsViewOverridesMap | null>(questsViewOverridesKey(uid), null);
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}
export function questsViewItemKey(index: number, foundName: string): string {
  return `${index}:${foundName}`;
}

/**
 * Total (kk) EXIBIDO na coluna "Valor Itens" — SINCRONIZADO com o modal
 * "Ver": quando o personagem tem personalização LOCAL salva (valor de item
 * e/ou Ouro), o total é RECALCULADO exatamente como no modal (soma dos
 * itens efetivos + Ouro efetivo, arredondado a 1 casa); sem personalização,
 * mantém o efetivo original (inclusive a correção manual da guia Itens).
 * A persistência (updateQuestsViewOverride) só guarda entradas que DIFEREM
 * do automático — presença no mapa significa valor realmente personalizado,
 * a mesma semântica do `hasValueOverride` do modal. Nada é lido/gravado no
 * Firestore: puro reflexo do override local já existente.
 */
export function questsViewAdjustedTotalKk(
  view: QuestsItemsDetailView,
  ovr: QuestsViewOverride | undefined,
): { kk: number; adjusted: boolean } {
  const items = ovr?.items || {};
  const hasItemOverride = Object.keys(items).length > 0;
  const hasGoldOverride = typeof ovr?.goldKk === "number";
  if (!hasItemOverride && !hasGoldOverride) return { kk: view.effectiveKk, adjusted: false };
  const sum = view.matches.reduce((acc, match, index) => {
    const override = items[questsViewItemKey(index, match.foundName)];
    return acc + (typeof override === "number" ? override : Number(match.totalKk || 0));
  }, 0);
  const gold = hasGoldOverride ? Number(ovr?.goldKk || 0) : Number(view.goldKk || 0);
  return { kk: Math.round((sum + gold) * 10) / 10, adjusted: true };
}

/** Constrói a view a partir do resultado LOCAL da guia Itens (Boss). */
export function itemsViewFromLocalResult(result: BazaarItemsCharacterResult): QuestsItemsDetailView {
  return {
    name: String(result.name || ""),
    server: String(result.server || ""),
    matches: (result.matches || []).map(match => ({
      foundName: String(match.foundName || ""),
      tier: Number(match.tier || 0),
      amount: Number(match.amount || 0),
      totalKk: Number(match.totalKk || 0),
      // Fonte LOCAL (consulta da guia Itens): o match já carrega o item da
      // lista e o valor base — transportados para a coluna "Atualizar".
      watchedName: String(match.watchedName || ""),
      baseValueKk: Number(match.baseValueKk || 0),
    })),
    effectiveKk: effectiveTotalKk(result),
    calculatedKk: Number(result.totalKk || 0),
    isManual: hasManualTotalKk(result),
    goldKk: Number(result.goldKk || 0),
  };
}

/**
 * Shape MÍNIMO (estrutural) do leilão com os campos `items*` EMBUTIDOS pela
 * publicação da consulta de Itens — aceita tanto o `BazaarAuction` do painel
 * quanto o `OfficialBazaarCharacter` da lista oficial (o rodapé lê direto do
 * cache oficial), sem acoplar este módulo a nenhum dos dois tipos.
 */
export interface AuctionWithEmbeddedItems {
  name?: string;
  server?: string;
  itemsMatches?: { foundName?: string; tier?: number; amount?: number; totalKk?: number }[];
  itemsTotalKk?: number;
  itemsGoldKk?: number;
}

/** Constrói a view a partir dos campos EMBUTIDOS na lista oficial. */
export function itemsViewFromAuction(auction: AuctionWithEmbeddedItems): QuestsItemsDetailView | null {
  // Resultado embutido é válido com itens OU Ouro relevante (> 1kk) — mesma
  // regra única (hasRelevantLoot) usada na coleta da consulta.
  const embeddedMatches = Array.isArray(auction.itemsMatches) ? auction.itemsMatches : [];
  if (typeof auction.itemsTotalKk !== "number" || !hasRelevantLoot(embeddedMatches.length, Number(auction.itemsGoldKk || 0))) return null;
  return {
    name: String(auction.name || ""),
    server: String(auction.server || ""),
    matches: embeddedMatches.map(match => {
      // Fonte EMBUTIDA (resumo publicado): reconstrói o valor BASE pela
      // MESMA fórmula oficial do Tier usada no snapshot de compra
      // (buildPurchaseItemsSnapshot): unit = total ÷ qtd; base = unit ÷
      // (1 + 0,3 × tier). O resumo não guarda o nome da lista — o item é
      // identificado pelo nome encontrado (o [Tier x] é separado na hora
      // de atualizar, via parseTieredItemName).
      const amount = Number(match.amount || 0);
      const totalKk = Number(match.totalKk || 0);
      const tier = Math.max(0, Number(match.tier || 0));
      const unitValueKk = Math.round((amount > 0 ? totalKk / amount : totalKk) * 100) / 100;
      const baseValueKk = Math.round((unitValueKk / (1 + 0.3 * tier)) * 100) / 100;
      const foundName = String(match.foundName || "");
      return { foundName, tier, amount, totalKk, watchedName: foundName, baseValueKk };
    }),
    effectiveKk: Number(auction.itemsTotalKk || 0),
    calculatedKk: Number(auction.itemsTotalKk || 0),
    // A correção manual do Boss é local ao dispositivo dele — o publicado é
    // sempre o valor calculado pela consulta.
    isManual: false,
    goldKk: Number(auction.itemsGoldKk || 0),
  };
}
