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
 * 2. Taxa do Market: ao CRIAR uma oferta de venda, o Market cobra uma taxa de
 *    N% (padrão 5%) sobre o valor total da oferta, LIMITADA a 10kk por oferta.
 *      • até 200kk (com 5%)  -> taxa = 5% do valor;
 *      • acima de 200kk      -> taxa = 10kk (teto).
 *    Vender direto para a oferta de compra mais alta NÃO paga taxa (0x).
 *    O multiplicador (0x, 1x, 2x, ...) representa QUANTAS ofertas foram
 *    criadas até a venda acontecer — cada uma pagou a própria taxa, cada uma
 *    com o próprio teto de 10kk.
 */

import type { ItemSaleRecord } from "../types";

/** Teto da taxa do Market por oferta criada, em kk. */
export const MARKET_TAX_CAP_KK = 10;

/** Porcentagem padrão da taxa do Market. */
export const DEFAULT_MARKET_TAX_PERCENT = 5;

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

/**
 * Taxa de UMA oferta: percent% do valor, respeitando o teto de 10kk.
 * O teto NÃO é proporcional ao percent — é o limite fixo do Market.
 */
export function computeSingleOfferTaxKk(vendaKk: number, taxPercent: number): number {
  if (!Number.isFinite(vendaKk) || vendaKk <= 0) return 0;
  if (!Number.isFinite(taxPercent) || taxPercent <= 0) return 0;
  const raw = (vendaKk * taxPercent) / 100;
  // Arredonda a 2 casas para evitar ruído de ponto flutuante em percentuais
  // fracionários; o teto é aplicado DEPOIS, por oferta.
  const rounded = Math.round(raw * 100) / 100;
  return Math.min(rounded, MARKET_TAX_CAP_KK);
}

/**
 * Desconto TOTAL da taxa do Market para `taxCount` ofertas criadas.
 * Cada oferta paga a própria taxa com o próprio teto de 10kk — nunca um
 * percentual ilimitado sobre o total.
 */
export function computeMarketTaxKk(vendaKk: number, taxPercent: number, taxCount: number): number {
  if (!Number.isFinite(taxCount) || taxCount <= 0) return 0;
  const per = computeSingleOfferTaxKk(vendaKk, taxPercent);
  return Math.round(per * Math.floor(taxCount) * 100) / 100;
}

/**
 * Monta o registro COMPLETO da venda — persistimos a operação inteira (e não
 * só o RC final) para que o "Copiar (WA)" e qualquer releitura futura possam
 * explicar como o valor foi obtido.
 */
export function buildItemSaleRecord(
  vendaKk: number,
  rateKk: number,
  taxPercent: number,
  taxCount: number,
): ItemSaleRecord {
  const safeVenda = Number.isFinite(vendaKk) && vendaKk > 0 ? vendaKk : 0;
  const safeRate = Number.isFinite(rateKk) && rateKk > 0 ? rateKk : 0;
  const safePercent = Number.isFinite(taxPercent) && taxPercent > 0 ? taxPercent : 0;
  const safeCount = Number.isFinite(taxCount) && taxCount > 0 ? Math.floor(taxCount) : 0;
  const taxDeductedKk = computeMarketTaxKk(safeVenda, safePercent, safeCount);
  // SEM desconto o valor de venda passa INTACTO (sem arredondar): preserva a
  // precisão de vendas decimais, exatamente como a calculadora kk histórica.
  const netKk = taxDeductedKk > 0
    ? Math.max(0, Math.round((safeVenda - taxDeductedKk) * 100) / 100)
    : safeVenda;
  return {
    vendaKk: safeVenda,
    rateKk: safeRate,
    taxPercent: safePercent,
    taxCount: safeCount,
    taxDeductedKk,
    netKk,
    resultRC: computeItemRC(safeRate, netKk),
    soldAt: Date.now(),
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

/**
 * Linha RESUMIDA da venda para o texto do WhatsApp.
 * Curta, mas explica a operação: valor bruto, quantas ofertas pagaram taxa
 * (e quanto foi descontado), a cotação e o resultado final.
 *   2x: "Vendido por 300kk − Taxa Market 2x 5% (−20kk) = 280kk, RC a 2,5k"
 *   0x: "Vendido por 100kk (venda direta, sem taxa), RC a 2,5k"
 */
export function formatItemSaleSummary(sale: ItemSaleRecord): string {
  const bruto = formatKkValue(sale.vendaKk, "kk");
  const cotacao = `RC a ${formatRateKkDisplay(sale.rateKk) || String(sale.rateKk)}k`;
  if (sale.taxCount > 0 && sale.taxDeductedKk > 0) {
    return `Vendido por ${bruto} − Taxa Market ${sale.taxCount}x ${formatRateKkDisplay(sale.taxPercent) || sale.taxPercent}% (−${formatKkValue(sale.taxDeductedKk, "kk")}) = ${formatKkValue(sale.netKk, "kk")}, ${cotacao}`;
  }
  return `Vendido por ${bruto} (venda direta, sem taxa), ${cotacao}`;
}
