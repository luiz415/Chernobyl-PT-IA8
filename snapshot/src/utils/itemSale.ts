/**
 * itemSale.ts
 * -----------
 * CÁLCULO CANÔNICO da venda de itens (modal "Item Vendido").
 *
 * FUNÇÃO PURA — sem React, sem Firebase, sem DOM (testável em Node).
 *
 * ── REGRAS ──────────────────────────────────────────────────────────────────
 * 1. Conversão kk -> RC (a MESMA regra que sempre existiu na mini-calculadora
 *    do PartyPanel): floor((totalKk / rateKk) × 1000), inteiro, sem forçar
 *    múltiplo de 25 — múltiplo de 25 é regra EXCLUSIVA da divisão.
 *
 * 2. TAXAS DO MARKET (regra VIGENTE do jogo — duas taxas independentes):
 *
 *    • CRIAÇÃO DA OFERTA: 1% do valor anunciado, máx. 1kk POR OFERTA criada
 *      (cobrada mesmo sem venda). N ofertas criadas = N × min(1%, 1kk).
 *    • VENDA CONCLUÍDA: 3% do valor da venda, máx. 5kk — cobrada UMA única
 *      vez quando o item é efetivamente vendido, independentemente de
 *      quantas ofertas foram criadas antes.
 *
 *      Taxa total = ofertas × min(1% × valor, 1kk) + min(3% × valor, 5kk)
 *
 *    Exemplos canônicos (validados em teste):
 *      50kk, 2 ofertas  -> 2×0,5 + 1,5      = 2,5kk
 *      150kk, 3 ofertas -> 3×1 (teto) + 4,5 = 7,5kk
 *      200kk, 2 ofertas -> 2×1 (teto) + 5 (teto) = 7kk
 *
 *    A regra ANTIGA (5% por oferta, teto 10kk) não é mais usada em cálculos
 *    novos; registros antigos permanecem legíveis (formatItemSaleSummary
 *    detecta o formato pela presença de `saleTaxKk`).
 */

import type { ItemSaleRecord } from "../types";

/** CRIAÇÃO da oferta: porcentagem sobre o valor anunciado. */
export const OFFER_TAX_PERCENT = 1;
/** CRIAÇÃO da oferta: teto em kk POR OFERTA criada. */
export const OFFER_TAX_CAP_KK = 1;
/** VENDA concluída: porcentagem sobre o valor da venda. */
export const SALE_TAX_PERCENT = 3;
/** VENDA concluída: teto em kk (cobrada uma única vez). */
export const SALE_TAX_CAP_KK = 5;

/**
 * Conversão kk -> RC. Fórmula: floor((totalKk / rateKk) * 1000).
 * Idêntica à `computeItemRC` histórica do PartyPanel (fonte movida para cá
 * para ser reutilizada pelo modal e por "Meus Personagens" sem duplicação).
 *   rate=75, total=340   -> 4533.33 -> 4533
 *   rate=2.5, total=0.34 -> 137.84  -> 137
 */
export function computeItemRC(rateKk: number, totalKk: number): number {
  if (!Number.isFinite(rateKk) || rateKk <= 0) return 0;
  if (!Number.isFinite(totalKk) || totalKk <= 0) return 0;
  const raw = (totalKk / rateKk) * 1000;
  return Math.floor(raw);
}

/** Arredonda a 2 casas — evita ruído de ponto flutuante nos percentuais. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * CRIAÇÃO: taxa de UMA oferta = min(1% do valor anunciado, 1kk).
 */
export function computeOfferTaxPerOfferKk(vendaKk: number): number {
  if (!Number.isFinite(vendaKk) || vendaKk <= 0) return 0;
  return Math.min(round2((vendaKk * OFFER_TAX_PERCENT) / 100), OFFER_TAX_CAP_KK);
}

/**
 * CRIAÇÃO: taxa TOTAL de `offerCount` ofertas criadas.
 * O teto de 1kk vale POR OFERTA (aplicado antes da multiplicação) — nunca
 * um percentual ilimitado sobre o total.
 */
export function computeOfferTaxTotalKk(vendaKk: number, offerCount: number): number {
  if (!Number.isFinite(offerCount) || offerCount <= 0) return 0;
  return round2(computeOfferTaxPerOfferKk(vendaKk) * Math.floor(offerCount));
}

/**
 * VENDA CONCLUÍDA: min(3% do valor da venda, 5kk) — uma única vez.
 */
export function computeSaleTaxKk(vendaKk: number): number {
  if (!Number.isFinite(vendaKk) || vendaKk <= 0) return 0;
  return Math.min(round2((vendaKk * SALE_TAX_PERCENT) / 100), SALE_TAX_CAP_KK);
}

/**
 * TAXA TOTAL do Market para a venda: criação (N ofertas) + venda concluída.
 *   50kk/2 ofertas -> 2,5kk · 150kk/3 -> 7,5kk · 200kk/2 -> 7kk
 */
export function computeMarketTaxTotalKk(vendaKk: number, offerCount: number): number {
  if (!Number.isFinite(vendaKk) || vendaKk <= 0) return 0;
  return round2(computeOfferTaxTotalKk(vendaKk, offerCount) + computeSaleTaxKk(vendaKk));
}

/**
 * Monta o registro COMPLETO da venda — persistimos a operação inteira (e não
 * só o RC final) para que o "Copiar (WA)" e qualquer releitura futura possam
 * RECONSTRUIR o cálculo: valor, cotação, nº de ofertas, taxa por oferta,
 * taxa de venda, taxa total e resultado em RC.
 */
export function buildItemSaleRecord(
  vendaKk: number,
  rateKk: number,
  offerCount: number,
): ItemSaleRecord {
  const safeVenda = Number.isFinite(vendaKk) && vendaKk > 0 ? vendaKk : 0;
  const safeRate = Number.isFinite(rateKk) && rateKk > 0 ? rateKk : 0;
  const safeCount = Number.isFinite(offerCount) && offerCount > 0 ? Math.floor(offerCount) : 0;
  const offerTaxPerOfferKk = safeCount > 0 ? computeOfferTaxPerOfferKk(safeVenda) : 0;
  const offerTaxTotalKk = computeOfferTaxTotalKk(safeVenda, safeCount);
  const saleTaxKk = computeSaleTaxKk(safeVenda);
  const taxDeductedKk = round2(offerTaxTotalKk + saleTaxKk);
  // Valor líquido = venda − taxa total; a conversão para RC (regra existente,
  // inalterada) acontece SOMENTE sobre este líquido.
  const netKk = taxDeductedKk > 0
    ? Math.max(0, round2(safeVenda - taxDeductedKk))
    : safeVenda;
  return {
    vendaKk: safeVenda,
    rateKk: safeRate,
    // Percentual da CRIAÇÃO — mantém o campo legado preenchido com a regra nova.
    taxPercent: OFFER_TAX_PERCENT,
    taxCount: safeCount,
    taxDeductedKk,
    netKk,
    resultRC: computeItemRC(safeRate, netKk),
    soldAt: Date.now(),
    offerTaxPerOfferKk,
    offerTaxTotalKk,
    saleTaxKk,
  };
}

// ============================================================================
// ENTRADA DO PREÇO DO RC (kk>RC) COM UMA CASA DECIMAL
// (movidas do PartyPanel — mesmas regras, agora reutilizáveis pelo modal)
// ============================================================================

/** Sanitiza a digitação: dígitos + UMA vírgula com UMA casa (ponto -> vírgula). */
export function sanitizeRateKkInput(raw: string): string {
  const unified = String(raw || "").replace(/[^\d.,]/g, "").replace(/\./g, ",");
  const firstComma = unified.indexOf(",");
  if (firstComma === -1) return unified;
  const intPart = unified.slice(0, firstComma);
  const decPart = unified.slice(firstComma + 1).replace(/,/g, "").slice(0, 1);
  return `${intPart},${decPart}`;
}

/** Converte o texto exibido (vírgula pt-BR) para o número exato do cálculo. */
export function parseRateKk(raw: string): number {
  const n = parseFloat(String(raw || "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Texto exibido para um valor persistido (número -> vírgula pt-BR). */
export function formatRateKkDisplay(value: number | undefined): string {
  if (!value) return "";
  return String(value).replace(".", ",");
}

/** Formata um valor em kk/k (pt-BR, até 2 casas quando fracionário). */
export function formatKkValue(value: number, suffix: "k" | "kk" = "kk"): string {
  if (!Number.isFinite(value)) return `0${suffix}`;
  const rounded = Math.round(value * 100) / 100;
  const text = Number.isInteger(rounded)
    ? rounded.toLocaleString("de-DE")
    : rounded.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${text}${suffix}`;
}

/** Formata kk SEM zeros à direita (4,5 e não 4,50) — usado no texto do WA. */
function formatKkShort(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(value * 100) / 100;
  return rounded.toLocaleString("de-DE", { maximumFractionDigits: 2 });
}

/**
 * Linha RESUMIDA da venda para o texto do WhatsApp — curta e suficiente para
 * explicar a origem do valor final.
 *
 * Regra VIGENTE (registro tem `saleTaxKk`) — formato definido pelo produto:
 *   "Oferta criada 3x (-3kk), taxa venda 3% (-4,5kk) = 142,5kk, RC a 90k"
 *   (o chamador acrescenta " = 1.583 RC" com o resultado final)
 *   0 ofertas: "taxa venda 3% (-1,5kk) = 48,5kk, RC a 2,5k"
 * Regra ANTIGA (registros persistidos antes da mudança):
 *   "Vendido por 300kk − Taxa Market 2x 5% (−20kk) = 280kk, RC a 2,5k"
 *   "Vendido por 100kk (venda direta, sem taxa), RC a 2,5k"
 */
export function formatItemSaleSummary(sale: ItemSaleRecord): string {
  const bruto = formatKkValue(sale.vendaKk, "kk");
  const cotacao = `RC a ${formatRateKkDisplay(sale.rateKk) || String(sale.rateKk)}k`;
  // ── Registro da regra VIGENTE (criação 1%/1kk + venda 3%/5kk) ────────────
  if (typeof sale.saleTaxKk === "number") {
    const parts: string[] = [];
    if (sale.taxCount > 0 && (sale.offerTaxTotalKk || 0) > 0) {
      parts.push(`Oferta criada ${sale.taxCount}x (-${formatKkShort(sale.offerTaxTotalKk || 0)}kk)`);
    }
    if (sale.saleTaxKk > 0) {
      parts.push(`taxa venda ${SALE_TAX_PERCENT}% (-${formatKkShort(sale.saleTaxKk)}kk)`);
    }
    if (parts.length === 0) return `Vendido por ${bruto} (sem taxa), ${cotacao}`;
    return `${parts.join(", ")} = ${formatKkShort(sale.netKk)}kk, ${cotacao}`;
  }
  // ── Registro LEGADO (regra antiga de 5%/10kk por oferta) ─────────────────
  if (sale.taxCount > 0 && sale.taxDeductedKk > 0) {
    return `Vendido por ${bruto} − Taxa Market ${sale.taxCount}x ${formatRateKkDisplay(sale.taxPercent) || sale.taxPercent}% (−${formatKkValue(sale.taxDeductedKk, "kk")}) = ${formatKkValue(sale.netKk, "kk")}, ${cotacao}`;
  }
  return `Vendido por ${bruto} (venda direta, sem taxa), ${cotacao}`;
}
