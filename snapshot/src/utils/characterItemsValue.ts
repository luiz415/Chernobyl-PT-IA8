/**
 * characterItemsValue.ts
 * ----------------------
 * VALOR DOS ITENS DO PERSONAGEM EM RC (82ª tarefa; ajustada na 83ª) —
 * FONTE ÚNICA.
 *
 * MODELO "itens = ganho potencial": o valor dos itens do Bazaar NÃO desconta
 * o custo de aquisição. `valorPago` é o custo integral e os itens compõem o
 * LUCRO do personagem:
 *
 *   Valor Itens (RC) = REALIZADO + POTENCIAL
 *     • REALIZADO: soma dos `sale.resultRC` dos itens VENDIDOS (valor
 *       efetivamente obtido, registrado no momento da venda com a cotação da
 *       época — nunca recalculado). Venda "sem valor informado" soma 0.
 *     • POTENCIAL: kk pendente (efetivo do snapshot − kk dos itens vendidos)
 *       convertido pela cotação OFICIAL VIGENTE do servidor (regra canônica
 *       computeItemRC). O kk efetivo respeita a correção manual
 *       (`manualTotalKk`), inclui o Ouro e — fundamental — usa o valor
 *       PERSONALIZADO de cada item (`match.totalKk`, que nasce com o
 *       override do modal "Ver" na importação e acompanha as edições
 *       inline de "Itens à Venda"/"Itens Encontrados"). Item vendido SAI
 *       do potencial e ENTRA no realizado: nenhum item é contado duas vezes.
 *
 *   Total do personagem = calcTotal (drops + venda − valorPago) + Valor Itens.
 *
 * PRIORIDADE DAS FONTES (83ª tarefa — auditoria):
 *   1. Item VENDIDO → valor REAL da venda (`sale.resultRC`, histórico).
 *   2. Item PENDENTE → valor PERSONALIZADO considerado (snapshot do
 *      personagem) × cotação oficial vigente. O valor BASE global da Lista
 *      de Itens NUNCA entra direto no cálculo do personagem — ele só chega
 *      aqui via snapshot capturado na importação; personalizações nunca
 *      contaminam a base global.
 *   3. Sem cotação configurada: com `itemsValueRc` registrado e nenhuma
 *      venda → vale o RC registrado na importação; caso contrário 0
 *      (nenhuma conversão é inventada).
 *
 * ABRANGÊNCIA (83ª): TODO personagem com snapshot de itens (`bazaarItems`)
 * participa do cálculo — inclusive os adicionados ANTES da 82ª (sem
 * `itemsValueRc`): a inclusão em Meus Personagens nunca pode fazer os itens
 * deixarem de ser contabilizados. O snapshot é o mesmo dado que o Painel
 * Bazaar exibia na compra ⇒ consistência entre as telas. Apenas personagens
 * SEM snapshot ficam de fora (não há itens registrados — nada é inventado;
 * coluna "—" e Total = calcTotal de sempre).
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
 * Personagem participa do modelo "itens = ganho potencial"?
 * 83ª tarefa: SIM para todo personagem com snapshot de itens do Bazaar
 * (`bazaarItems`) — inclusive os adicionados antes da 82ª, sem
 * `itemsValueRc` (o snapshot traz todos os itens encontrados na compra; a
 * inclusão na lista pessoal nunca pode fazer o valor deixar de contar).
 * Sem snapshot ⇒ false: não há itens registrados e nada é inventado.
 */
export function isItemsProfitModel(c: Character | null | undefined): boolean {
  return !!c?.bazaarItems;
}

/**
 * Decomposição do Valor Itens (RC) do personagem. `rateKk` = cotação oficial
 * VIGENTE do servidor do snapshot (0/ausente = sem cotação).
 * Retorna null apenas para personagens SEM snapshot de itens — o chamador
 * exibe "—" e NÃO altera o Total.
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
  // 83ª: a edição INDIVIDUAL de um item (Itens à Venda/Itens Encontrados)
  // LIMPA a correção manual (updateSnapshotMatchTotalKk) — a personalização
  // mais recente do usuário é a fonte da verdade, mesma precedência do modal
  // "Ver" do Painel Bazaar (override > manual).
  const manual = Number(snapshot.manualTotalKk);
  const effectiveKk = Number.isFinite(manual) && manual > 0 ? manual : Math.max(0, Number(snapshot.totalKk || 0));
  const pendingKk = Math.max(0, effectiveKk - soldKk);
  const rate = Number(rateKk);
  const rateOk = Number.isFinite(rate) && rate > 0;
  // POTENCIAL: cotação vigente sobre o kk pendente. Sem cotação configurada
  // E sem nenhuma venda, vale o RC REGISTRADO na importação quando existe
  // (`itemsValueRc`, conversão oficial da época — um dado real, não
  // inventado); personagens anteriores à 82ª não têm o registro ⇒ 0 até a
  // cotação ser configurada. Com vendas no meio não há como ratear o
  // registro por item ⇒ idem (0 sem cotação).
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
 * TOTAL do personagem no modelo de itens: calcTotal (drops + venda −
 * valorPago) + Valor Itens (RC). Para personagens SEM snapshot de itens é
 * EXATAMENTE o calcTotal de sempre (parcela de itens = 0).
 */
export function calcTotalWithItems(c: Character, rateKk: number): number {
  return calcTotal(c) + (computeCharacterItemsRc(c, rateKk)?.totalRc || 0);
}
