import type { Vocation } from "../types";

// ============================================================================
// PRIORIDADE DE COMPRA POR VOCAÇÃO — fonte única
// ----------------------------------------------------------------------------
// Lógica compartilhada entre o Resumo de Amigos (FriendsSummaryModal) e o
// destaque "Prioridade para você" do Painel Bazaar (bazaarUserPriority.ts).
//
// Vive aqui (e não num componente) para que ambos consumam a MESMA regra de
// classificação, sem duplicação divergente, e para poder ser testada em
// ambiente Node sem JSX.
// ============================================================================

/** Ordem de EXIBIÇÃO das vocações nos cards. */
export const VOCATION_ORDER: Vocation[] = ["EK", "ED", "MS", "RP", "MK"];

/** Vocações recomendáveis (exclui Monk) em análises de balanceamento. */
export const RECOMMENDABLE_VOCATIONS: Vocation[] = ["EK", "ED", "MS", "RP"];

/**
 * Ordem de DESEMPATE da Prioridade comum.
 *
 * Quando duas vocações têm a mesma quantidade, a que aparece primeiro nesta
 * lista é escolhida. É uma ordem de preferência de compra, deliberadamente
 * diferente de `VOCATION_ORDER` (que é só a ordem de EXIBIÇÃO dos cards).
 */
export const PRIORITY_TIEBREAK_ORDER: Vocation[] = ["ED", "EK", "RP", "MS", "MK"];

/** Quantas vocações a Prioridade comum deve destacar por servidor. */
export const PRIORITY_SLOTS = 2;

/**
 * Seleciona as vocações de menor quantidade que NÃO são Prioridade Máxima.
 *
 * Regras:
 *   • as Prioridade Máxima (zeradas) são excluídas e nunca ocupam uma vaga;
 *   • ordena por quantidade crescente e, no empate, por
 *     `PRIORITY_TIEBREAK_ORDER`;
 *   • devolve `PRIORITY_SLOTS` vocações — ou todas as elegíveis, se houver
 *     menos que isso.
 */
export function pickPriorityVocations(
  counts: Record<Vocation, number>,
  excluded: Vocation[],
  slots: number = PRIORITY_SLOTS,
): Vocation[] {
  const excludedSet = new Set(excluded);
  return PRIORITY_TIEBREAK_ORDER
    .filter(vocation => !excludedSet.has(vocation))
    // `sort` estável no V8: mantém a ordem de desempate quando as quantidades
    // são iguais, já que a lista de entrada já está nessa ordem.
    .sort((a, b) => counts[a] - counts[b])
    .slice(0, Math.max(0, slots));
}

/**
 * Calcula os dois níveis de prioridade de compra de UM servidor a partir das
 * contagens por vocação.
 *
 *   • Prioridade Máxima: vocação ZERADA (desde que o servidor tenha algum
 *     personagem em outra vocação — sem isso não há com o que comparar).
 *   • Prioridade: SEMPRE 2 vocações de menor quantidade entre as que NÃO são
 *     Prioridade Máxima. Empate resolvido por `PRIORITY_TIEBREAK_ORDER`.
 *
 * Os dois níveis CONVIVEM: um servidor pode ter Prioridades Máximas e, ao
 * mesmo tempo, 2 Prioridades comuns. Uma vocação zerada já está em Prioridade
 * Máxima e por isso nunca ocupa uma das 2 vagas comuns.
 */
export function computeServerPriorityVocations(counts: Record<Vocation, number>): { max: Vocation[]; normal: Vocation[] } {
  const total = VOCATION_ORDER.reduce((sum, vocation) => sum + (counts[vocation] || 0), 0);
  const hasAnyCharacter = total > 0;
  const max = hasAnyCharacter ? VOCATION_ORDER.filter(vocation => counts[vocation] === 0) : [];
  const normal = hasAnyCharacter ? pickPriorityVocations(counts, max) : [];
  return { max, normal };
}
