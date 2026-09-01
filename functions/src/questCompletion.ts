import { getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import {
  buildQuestSettlementPlan,
  parseAcquisitionSnapshot,
  parseBuyerDetailsSnapshot,
  parseConcludedQuestParty,
  type ConcludedQuestParty,
} from "./questCompletionCore.js";

// O Admin SDK é necessário para materializar o detalhe privado no documento do
// adquirente mesmo quando ele está offline. Nunca use dados livres da PT para
// escolher o destinatário: o acquirerUid vem do registro de aquisição validado.
if (getApps().length === 0) {
  initializeApp();
}

const firestore = getFirestore();
const ACQUISITIONS_COLLECTION = "characterAcquisitions";
const BUYER_DETAILS_COLLECTION = "characterAcquisitionBuyerDetails";

function hasPersistedValue(value: unknown): boolean {
  return value !== undefined && value !== null;
}

interface ReconciliationResult {
  acquisitionId: string;
  state: "settled" | "skipped";
  reason?: string;
  wroteAcquisition: boolean;
  wroteBuyerDetails: boolean;
}

/**
 * Reconciliador idempotente de UMA aquisição vinculada a uma Quest concluída.
 *
 * A transação reabre o documento compartilhado e o detalhe privado para que
 * retries, eventos duplicados e uma edição concorrente do comprador nunca
 * sobrescrevam `questDropsSource: "buyer"` ou `questProfitSource: "buyer"`.
 */
async function reconcileAcquisition(
  party: ConcludedQuestParty,
  acquisitionRef: FirebaseFirestore.DocumentReference,
): Promise<ReconciliationResult> {
  return firestore.runTransaction(async transaction => {
    const acquisitionSnap = await transaction.get(acquisitionRef);
    if (!acquisitionSnap.exists) {
      return {
        acquisitionId: acquisitionRef.id,
        state: "skipped",
        reason: "acquisition_not_found",
        wroteAcquisition: false,
        wroteBuyerDetails: false,
      };
    }

    const acquisitionData = acquisitionSnap.data() || {};
    const acquisition = parseAcquisitionSnapshot(acquisitionSnap.id, acquisitionData);
    if (!acquisition) {
      return {
        acquisitionId: acquisitionSnap.id,
        state: "skipped",
        reason: "invalid_acquisition",
        wroteAcquisition: false,
        wroteBuyerDetails: false,
      };
    }

    const buyerDetailsRef = firestore.collection(BUYER_DETAILS_COLLECTION).doc(acquisition.id);
    const buyerDetailsSnap = await transaction.get(buyerDetailsRef);
    const existingBuyerDetails = parseBuyerDetailsSnapshot(
      buyerDetailsSnap.exists ? buyerDetailsSnap.data() : undefined,
    );
    const plan = buildQuestSettlementPlan(party, acquisition, existingBuyerDetails);

    if (!plan.eligible || !plan.buyerDetails.values) {
      return {
        acquisitionId: acquisition.id,
        state: "skipped",
        reason: plan.reason || "not_eligible",
        wroteAcquisition: false,
        wroteBuyerDetails: false,
      };
    }

    if (plan.acquisition.shouldWrite) {
      const acquisitionPatch: Record<string, unknown> = {
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (plan.acquisition.status) acquisitionPatch.status = plan.acquisition.status;
      if (plan.acquisition.questType) acquisitionPatch.questType = plan.acquisition.questType;
      if (plan.acquisition.ensureQuestCompletedAt) {
        acquisitionPatch.questCompletedAt = FieldValue.serverTimestamp();
      }
      transaction.update(acquisitionRef, acquisitionPatch);
    }

    if (plan.buyerDetails.shouldWrite) {
      const existingDetailsData = buyerDetailsSnap.exists ? buyerDetailsSnap.data() : undefined;
      const completedAt = hasPersistedValue(existingDetailsData?.questCompletedAt)
        ? existingDetailsData?.questCompletedAt
        : hasPersistedValue(acquisitionData.questCompletedAt)
          ? acquisitionData.questCompletedAt
          : FieldValue.serverTimestamp();

      transaction.set(buyerDetailsRef, {
        ...plan.buyerDetails.values,
        questCompletedAt: completedAt,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }

    return {
      acquisitionId: acquisition.id,
      state: "settled",
      wroteAcquisition: plan.acquisition.shouldWrite,
      wroteBuyerDetails: plan.buyerDetails.shouldWrite,
    };
  });
}

/**
 * Materializa no backend o resultado privado da Quest para aquisições já
 * pagas. O trigger é deliberadamente aditivo: ele não conclui a PT, não toca
 * Stats, pagamentos, Histórico, Services, notificações ou probableMarkers.
 */
export const reconcileQuestCompletion = onDocumentUpdated(
  {
    document: "parties/{partyId}",
    retry: true,
  },
  async event => {
    if (!event.data) {
      logger.warn("quest completion event without document data", { eventId: event.id });
      return;
    }

    const partyId = event.params.partyId;
    const party = parseConcludedQuestParty(partyId, event.data.after.data());
    if (!party) return;

    const acquisitions = await firestore
      .collection(ACQUISITIONS_COLLECTION)
      .where("partyId", "==", party.id)
      .get();

    if (acquisitions.empty) {
      logger.info("quest completion has no linked acquisitions", {
        eventId: event.id,
        partyId: party.id,
      });
      return;
    }

    const outcomes = await Promise.allSettled(
      acquisitions.docs.map(acquisition => reconcileAcquisition(party, acquisition.ref)),
    );
    const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    const results = outcomes
      .filter((outcome): outcome is PromiseFulfilledResult<ReconciliationResult> => outcome.status === "fulfilled")
      .map(outcome => outcome.value);

    logger.info("quest completion reconciliation finished", {
      eventId: event.id,
      partyId: party.id,
      matchedAcquisitions: acquisitions.size,
      settled: results.filter(result => result.state === "settled").length,
      skipped: results.filter(result => result.state === "skipped").length,
      acquisitionWrites: results.filter(result => result.wroteAcquisition).length,
      privateDetailWrites: results.filter(result => result.wroteBuyerDetails).length,
      failed: failures.length,
    });

    if (failures.length > 0) {
      // O trigger usa retry e as escritas são idempotentes. Falhar após registrar
      // o resumo garante que uma indisponibilidade transitória seja reconciliada
      // sem duplicar status, timestamps ou dados privados do comprador.
      throw new Error(`Quest completion reconciliation failed for ${failures.length} acquisition(s).`);
    }
  },
);