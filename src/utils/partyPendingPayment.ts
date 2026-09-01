// ============================================================================
// PTs EM "AGUARDANDO PAGAMENTO" RELEVANTES PARA O USUÁRIO LOGADO
//
// Espelha a MESMA regra financeira que a Cloud Function de settlement aplica
// (functions/src/partyLifecycleCore.ts):
//   • um slot participa da divisão quando `split === true`;
//   • o destinatário da divisão segue a cadeia congelada de `slotFromRaw`:
//     splitBeneficiaryUid → financialRightsHolderUid →
//     (splitTarget === "player" ? playerUid : ownerUid) → playerUid;
//   • após a Quest, apenas líder + beneficiários da divisão permanecem na PT
//     operacional (`viewerUids` do settlement) — participantes sem
//     participação financeira deixam de ver a PT como pendência.
//
// "Efetivamente aguardando pagamento" = existe ao menos um slot da divisão
// ainda NÃO pago — a mesma semântica do erro `split_payment_pending` que a
// finalização valida no backend. Para o usuário a pendência existe quando:
//   • ele é o LÍDER da PT (quem realiza os pagamentos), OU
//   • ele é o beneficiário de um slot da divisão ainda não pago (a receber).
// Quem participou da PT mas não tem valor a receber/pagar não recebe a
// indicação.
//
// Cálculo 100% local sobre os documentos de PT que o painel JÁ escuta —
// nenhum listener ou leitura extra do Firestore.
// ============================================================================

export interface PendingPaymentSlotInput {
  /** O slot participa da divisão (DIVIDIR marcado)? */
  split?: boolean;
  /** O líder já marcou o pagamento deste slot? */
  pago?: boolean;
  /** UID do beneficiário congelado no slot. */
  splitBeneficiaryUid?: string;
  /** UID do titular dos direitos financeiros (negociação/aquisição). */
  financialRightsHolderUid?: string;
  /** Destino escolhido da divisão: DONO (padrão) ou JOGADOR. */
  splitTarget?: "owner" | "player";
  /** UID do jogador gravado no slot. */
  playerUid?: string;
  /** UID do dono gravado no slot. */
  ownerUid?: string;
}

export interface PendingPaymentPartyInput {
  /** Quest concluída (PT saiu de "Ativas")? */
  questConcluida?: boolean;
  /** Pagamento final já realizado (PT finalizada)? */
  pagamentoFeito?: boolean;
  /** PT arquivada (finalização definitiva concluída)? */
  archived?: boolean;
  /** UID do líder da PT. */
  leaderUid?: string;
  slotData?: Record<string, PendingPaymentSlotInput>;
}

function nonEmpty(value: unknown): string {
  const text = String(value ?? "").trim();
  return text || "";
}

/**
 * Cadeia de resolução do beneficiário da divisão de um slot — idêntica à do
 * backend (`slotFromRaw`): UID explícito congelado > titular financeiro >
 * (destino JOGADOR ? playerUid : ownerUid) > último recurso playerUid.
 */
export function resolveSlotSplitBeneficiaryUid(slot: PendingPaymentSlotInput | undefined): string {
  if (!slot) return "";
  return nonEmpty(slot.splitBeneficiaryUid)
    || nonEmpty(slot.financialRightsHolderUid)
    || (slot.splitTarget === "player" ? nonEmpty(slot.playerUid) : nonEmpty(slot.ownerUid))
    || nonEmpty(slot.playerUid);
}

/**
 * A PT está na fase de pagamento (Quest concluída, pagamento final ainda não
 * realizado, não arquivada) E ainda existe divisão a pagar.
 */
export function isPartyEffectivelyAwaitingPayment(party: PendingPaymentPartyInput | undefined): boolean {
  if (!party || !party.questConcluida || party.pagamentoFeito || party.archived) return false;
  const slots = Object.values(party.slotData || {});
  return slots.some(slot => !!slot && slot.split === true && slot.pago !== true);
}

/**
 * A PT é uma pendência de pagamento PARA ESTE usuário: ele lidera a PT (deve
 * pagar os membros) ou é beneficiário de um slot da divisão ainda não pago
 * (deve receber). Participantes sem participação financeira na divisão não
 * recebem a indicação.
 */
export function isPartyAwaitingPaymentForUser(party: PendingPaymentPartyInput | undefined, uid: string | undefined): boolean {
  const userId = nonEmpty(uid);
  if (!userId) return false;
  if (!isPartyEffectivelyAwaitingPayment(party)) return false;
  if (nonEmpty(party?.leaderUid) === userId) return true;
  const slots = Object.values(party?.slotData || {});
  return slots.some(slot => !!slot
    && slot.split === true
    && slot.pago !== true
    && resolveSlotSplitBeneficiaryUid(slot) === userId);
}

/** Quantas PTs da lista são pendências de pagamento para o usuário. */
export function countPartiesAwaitingPaymentForUser(parties: readonly PendingPaymentPartyInput[], uid: string | undefined): number {
  return parties.reduce((total, party) => total + (isPartyAwaitingPaymentForUser(party, uid) ? 1 : 0), 0);
}