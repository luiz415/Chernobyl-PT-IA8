/**
 * Resolução do destinatário da divisão de um slot da PT.
 * ============================================================================
 *
 * Extraída do PartyPanel para ser pura e testável — é a MESMA cadeia que a
 * Cloud Function aplica em `partyLifecycleCore.slotFromRaw` e que as demais
 * rotas do painel (seletor de JOGADOR, `withResolvedSlotUids`) já usam:
 *
 *   1. `financialRightsHolderUid` — a negociação/acquisição já definiu o
 *      titular financeiro; a divisão é dele por construção;
 *   2. UID já gravado no slot para o alvo escolhido (`playerUid`/`ownerUid`) —
 *      a fonte primária: NOME nunca sobrescreve UID existente;
 *   3. ownerUid do snapshot congelado (ou do personagem ao vivo) — mesmo
 *      fallback do backend (`rawSlot.ownerUid ?? rawSnapshot.ownerUid`);
 *   4. playerUid resolvido por NOME entre usuários aprovados — cobre PTs
 *      legadas em que o JOGADOR foi gravado só como texto.
 *
 * Sem esta cadeia completa no modal "Destinatário da Divisão", um slot com UID
 * ausente no lado escolhido deixava a seleção morta — e o aviso de erro abria
 * ATRÁS do modal, parecendo que o clique "não fazia nada".
 */

export type SplitTargetOption = "owner" | "player";

export interface SplitBeneficiarySlotInput {
  /** UID do titular dos direitos financeiros (negociação/acquisição). */
  financialRightsHolderUid?: string;
  /** UID do DONO gravado no slotData. */
  ownerUid?: string;
  /** UID do JOGADOR gravado no slotData. */
  playerUid?: string;
  /** Nome de exibição do JOGADOR gravado no slotData. */
  player?: string;
}

export interface SplitBeneficiaryContext {
  /**
   * Resolve um nome de exibição (já normalizado: trim + lowercase) para o UID
   * de um usuário APROVADO. É a mesma fonte do seletor de JOGADOR e da
   * migração `withResolvedSlotUids`.
   */
  findApprovedUidByName?: (normalizedName: string) => string | undefined;
  /** ownerUid do memberSnapshot congelado ou do personagem ao vivo. */
  fallbackOwnerUid?: string;
}

function nonEmpty(value: unknown): string {
  const text = String(value ?? "").trim();
  return text || "";
}

/**
 * UID do candidato a destinatário para o alvo escolhido, ou "" quando o
 * candidato não é identificável com segurança no app.
 */
export function resolveSplitBeneficiaryCandidate(
  slot: SplitBeneficiarySlotInput | undefined,
  target: SplitTargetOption,
  context: SplitBeneficiaryContext = {},
): string {
  if (!slot) return "";
  // 1) Titular financeiro prevalece — mesma precedência de confirmSplitTarget
  //    e do handleSplitToggle (ramo de negociação).
  const financial = nonEmpty(slot.financialRightsHolderUid);
  if (financial) return financial;

  if (target === "player") {
    // 2) UID já gravado no slot.
    const playerUid = nonEmpty(slot.playerUid);
    if (playerUid) return playerUid;
    // 4) Resolução por nome entre aprovados (fonte do seletor de JOGADOR).
    const playerName = String(slot.player ?? "").trim().toLowerCase();
    if (!playerName || !context.findApprovedUidByName) return "";
    return nonEmpty(context.findApprovedUidByName(playerName));
  }

  // 3) DONO: UID do slot → snapshot/personagem ao vivo (fallback do backend).
  return nonEmpty(slot.ownerUid) || nonEmpty(context.fallbackOwnerUid);
}

/**
 * Patch complementar a gravar no slot após a confirmação, para a PT ficar
 * autoconsistente: quando o UID foi RESOLVIDO por fallback (não existia no
 * slot), ele volta gravado — assim a validação do backend confirma a cadeia
 * sem recorrer aos próprios fallbacks, e as verificações locais (pagamentos,
 * elegibilidade pós-Quest) enxergam o UID.
 *
 * Nunca sobrescreve UID já existente.
 */
export function buildResolvedUidPatch(
  slot: SplitBeneficiarySlotInput | undefined,
  target: SplitTargetOption,
  resolvedUid: string,
): { playerUid?: string; ownerUid?: string } {
  if (!slot || !resolvedUid) return {};
  if (target === "player" && !nonEmpty(slot.playerUid)) return { playerUid: resolvedUid };
  if (target === "owner" && !nonEmpty(slot.ownerUid)) return { ownerUid: resolvedUid };
  return {};
}