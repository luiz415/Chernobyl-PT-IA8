/**
 * characterItemsValue.ts
 * ----------------------
 * VALOR DOS ITENS DO PERSONAGEM EM RC (82ª tarefa) — FONTE ÚNICA.
 *
 * MODELO NOVO ("itens = ganho potencial"): o valor dos itens do Bazaar NÃO
 * desconta mais o custo de aquisição. `valorPago` é o custo integral e os
 * itens compõem o LUCRO do personagem:
 *
 *   Valor Itens (RC) = REALIZADO + POTENCIAL
 *     • REALIZADO: soma dos `sale.resultRC` dos itens VENDIDOS (valor
 *       efetivamente obtido, registrado no momento da venda com a cotação da
 *       época — nunca recalculado). Venda "sem valor informado" soma 0.
 *     • POTENCIAL: kk pendente (efetivo do snapshot − kk dos itens vendidos)
 *       convertido pela cotação OFICIAL VIGENTE do servidor (regra canônica
 *       computeItemRC). O kk efetivo respeita a correção manual
 *       (`manualTotalKk`) e inclui o Ouro — exatamente o "Em RC" do modal
 *       "Ver". Item vendido SAI do potencial e ENTRA no realizado: nenhum
 *       item é contado duas vezes.
 *
 *   Total do personagem = calcTotal (drops + venda − valorPago) + Valor Itens.
 *
 * COMPATIBILIDADE (registros legados): personagens importados ANTES do
 * modelo novo não têm `itemsValueRc` — pode ter havido o desconto antigo no
 * custo e não há como reconstruir o valor original com segurança. Para eles
 * NADA muda: `computeCharacterItemsRc` retorna null, o Total continua sendo
 * o calcTotal de sempre e a coluna exibe "—" (nenhum valor inventado,
 * nenhuma dupla contagem).
 *
 * FUNÇÕES PURAS — a cotação vigente é passada pelo chamador (os componentes
 * a resolvem pelo espelho local da fonte oficial, como no restante do app).
 */

import type { Character } from "../types";
import { calcTotal } from "../types";
import { computeItemRC, isItemSaleConcluded } from "./itemSale";

export interface CharacterItemsRcBreakdown {
  /** REALIZADO + POTENCIAL — o "Valor Itens (RC)" exibido/somado no Total. */
  totalRc: number;
  /** Soma dos resultRC das vendas registradas (ganho realizado). */
  realizedRc: number;
  /** RC estimado dos itens ainda não vendidos (cotação vigente). */
  potentialRc: number;
  /** kk ainda não vendido (efetivo do snapshot − kk dos vendidos). */
  pendingKk: number;
  /** Quantos itens do snapshot têm venda registrada. */
  soldCount: number;
  /** Cotação usada no potencial (0 = servidor sem cotação configurada). */
  rateKk: number;
}

/**
 * Personagem está no MODELO NOVO? (importado já com o registro separado do
 * valor dos itens). Legado/sem snapshot ⇒ false — comportamento histórico.
 */
export function isItemsProfitModel(c: Character | null | undefined): boolean {
  return !!c && typeof c.itemsValueRc === "number" && Number.isFinite(c.itemsValueRc) && !!c.bazaarItems;
}

/**
 * Decomposição do Valor Itens (RC) do personagem. `rateKk` = cotação oficial
 * VIGENTE do servidor do snapshot (0/ausente = sem cotação).
 * Retorna null para personagens legados ou sem itens — o chamador exibe "—"
 * e NÃO altera o Total.
 */
export function computeCharacterItemsRc(c: Character, rateKk: number): CharacterItemsRcBreakdown | null {
  if (!isItemsProfitModel(c)) return null;
  const snapshot = c.bazaarItems!;
  let realizedRc = 0;
  let soldKk = 0;
  let soldCount = 0;
  for (const match of snapshot.matches || []) {
    if (!isItemSaleConcluded(match.sale || null)) continue;
    // Valor REAL da venda (resultRC gravado na época — nunca recalculado);
    // "sem valor informado" (noValue) soma 0: nada é inventado.
    realizedRc += Math.max(0, Math.floor(Number(match.sale?.resultRC || 0)));
    soldKk += Math.max(0, Number(match.totalKk || 0));
    soldCount += 1;
  }
  // kk EFETIVO — mesma regra do modal "Ver"/coluna "Valor Itens (kk)":
  // correção manual (quando > 0) prevalece sobre o calculado; inclui o Ouro.
  const manual = Number(snapshot.manualTotalKk);
  const effectiveKk = Number.isFinite(manual) && manual > 0 ? manual : Math.max(0, Number(snapshot.totalKk || 0));
  const pendingKk = Math.max(0, effectiveKk - soldKk);
  const rate = Number(rateKk);
  const rateOk = Number.isFinite(rate) && rate > 0;
  // POTENCIAL: cotação vigente sobre o kk pendente. Sem cotação configurada
  // E sem nenhuma venda, vale o RC REGISTRADO na importação (conversão
  // oficial da época — um dado real, não inventado); com vendas no meio não
  // há como ratear o registro por item ⇒ 0 até a cotação ser configurada.
  const potentialRc = rateOk
    ? computeItemRC(rate, pendingKk)
    : soldCount === 0
      ? Math.max(0, Math.floor(Number(c.itemsValueRc || 0)))
      : 0;
  return {
    totalRc: realizedRc + potentialRc,
    realizedRc,
    potentialRc,
    pendingKk,
    soldCount,
    rateKk: rateOk ? rate : 0,
  };
}

/**
 * TOTAL do personagem no modelo novo: calcTotal (drops + venda − valorPago)
 * + Valor Itens (RC). Para legados/sem itens é EXATAMENTE o calcTotal de
 * sempre (parcela de itens = 0) — nenhuma mudança retroativa.
 */
export function calcTotalWithItems(c: Character, rateKk: number): number {
  return calcTotal(c) + (computeCharacterItemsRc(c, rateKk)?.totalRc || 0);
}
