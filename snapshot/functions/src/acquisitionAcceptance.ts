import { getApps, initializeApp } from "firebase-admin/app";
import { FieldPath, getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { onDocumentUpdated } from "firebase-functions/v2/firestore";

/**
 * MATERIALIZAÇÃO DO ACEITE DA COMPRA NO SLOT DA PT — Admin SDK.
 *
 * Por que esta Function existe:
 * O comprador (JOGADOR) pode aceitar uma venda PRÉ-APROVADA até a PT ser
 * efetivamente finalizada — inclusive DEPOIS de a Quest ter sido concluída.
 * A transição `pre_approved → payment_confirmed` no documento compartilhado
 * `characterAcquisitions/{id}` é gravada pelo próprio comprador e validada
 * pelas Security Rules (somente o adquirente, somente a partir de
 * `pre_approved`). Porém, o REFLEXO da negociação no slot da PT
 * (`characterAcquisitionId`, direitos financeiros, beneficiário da divisão)
 * exige um update em `parties/{partyId}` — e, após a Quest concluída, as
 * Rules de `parties` restringem escritas a Líder/Boss (liquidação
 * centralizada). Um comprador comum seria negado e os direitos nunca
 * chegariam ao servidor.
 *
 * A solução segura é materializar o slot AQUI, no backend, a partir do
 * documento canônico da aquisição (nunca de dados livres do cliente):
 *   • dispara exclusivamente na transição `pre_approved → payment_confirmed`,
 *     que as Rules já garantem ter sido feita pelo comprador legítimo;
 *   • idempotente: se o slot já contém exatamente os valores esperados
 *     (caso pré-Quest, em que o cliente do comprador ainda grava a PT
 *     diretamente como participante), nenhuma escrita acontece;
 *   • respeita o encerramento: PT finalizada (`pagamentoFeito`) ou arquivada
 *     nunca é alterada — a negociação não "reabre" uma PT encerrada;
 *   • escreve por FieldPath somente os campos do slot afetado, sem tocar no
 *     restante do documento da PT (sem sobrescrever edições concorrentes).
 *
 * Encadeamento (sem loops): o update em `parties` dispara
 * `reconcileQuestCompletion` (promove a aquisição para `quest_completed` e
 * materializa os detalhes privados do comprador quando a Quest já concluiu) e
 * `materializePartySettlement` (reprojeta o settlement com o adquirente como
 * beneficiário da divisão). Nenhum deles regrava `status: payment_confirmed`,
 * então esta Function não é reativada.
 */
if (getApps().length === 0) {
  initializeApp();
}

const firestore = getFirestore();
const PARTIES_COLLECTION = "parties";

function trimmed(value: unknown, max: number): string {
  return String(value ?? "").trim().slice(0, max);
}

export const materializeAcquisitionAcceptance = onDocumentUpdated(
  {
    document: "characterAcquisitions/{acquisitionId}",
    retry: true,
  },
  async event => {
    const before = event.data?.before?.data() || {};
    const after = event.data?.after?.data() || {};

    // Somente o ACEITE do comprador interessa: pre_approved → payment_confirmed.
    if (trimmed(before.status, 40) !== "pre_approved" || trimmed(after.status, 40) !== "payment_confirmed") {
      return;
    }

    const acquisitionId = trimmed(event.params.acquisitionId, 220);
    const partyId = trimmed(after.partyId, 220);
    const characterId = trimmed(after.characterId, 220);
    const acquirerUid = trimmed(after.acquirerUid, 128);
    const acquirerName = trimmed(after.acquirerName, 120);
    if (!acquisitionId || !partyId || !characterId || !acquirerUid) {
      logger.warn("acquisition acceptance missing identifiers", {
        eventId: event.id,
        acquisitionId,
        partyId,
        characterId,
      });
      return;
    }

    const partyRef = firestore.collection(PARTIES_COLLECTION).doc(partyId);
    const outcome = await firestore.runTransaction(async transaction => {
      const partySnap = await transaction.get(partyRef);
      // A PT pode já ter sido finalizada e removida (finalizePartyHistory).
      if (!partySnap.exists) return "party_not_found";

      const party = partySnap.data() || {};
      // PT finalizada/arquivada: a negociação não permanece disponível — o
      // encerramento é respeitado e nada é regravado.
      if (party.pagamentoFeito === true || party.archived === true) return "party_finalized";

      const slotData = (party.slotData && typeof party.slotData === "object")
        ? party.slotData as Record<string, Record<string, unknown> | undefined>
        : {};
      const slot = slotData[characterId];
      if (!slot || typeof slot !== "object") return "slot_not_found";

      // Espelho exato do patch aplicado pelo cliente no aceite pré-Quest:
      // direitos da Quest/divisão e venda futura passam ao adquirente, sem
      // mudar o DONO original do personagem.
      const desired: Record<string, unknown> = {
        characterAcquisitionId: acquisitionId,
        financialRightsHolderUid: acquirerUid,
        financialRightsHolderName: acquirerName,
        playerUid: acquirerUid,
        splitTarget: "player",
        splitTargetName: acquirerName,
        splitBeneficiaryUid: acquirerUid,
      };
      const changedKeys = Object.keys(desired).filter(key => slot[key] !== desired[key]);
      if (changedKeys.length === 0) return "already_materialized";

      // FieldPath por segmento: nunca interpolar o characterId em dot-notation.
      const fieldsAndValues: unknown[] = [];
      changedKeys.slice(1).forEach(key => {
        fieldsAndValues.push(new FieldPath("slotData", characterId, key), desired[key]);
      });
      fieldsAndValues.push(new FieldPath("updatedAt"), Date.now());
      transaction.update(
        partyRef,
        new FieldPath("slotData", characterId, changedKeys[0]),
        desired[changedKeys[0]],
        ...fieldsAndValues,
      );
      return "materialized";
    });

    logger.info("acquisition acceptance processed", {
      eventId: event.id,
      acquisitionId,
      partyId,
      characterId,
      outcome,
    });
  },
);
