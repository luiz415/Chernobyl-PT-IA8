import { getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { onDocumentCreated, onDocumentUpdated } from "firebase-functions/v2/firestore";
import {
  buildPartySettlement,
  buildPersonalPartyHistory,
  buildSanitizedPartyArchive,
  parseLifecycleParty,
  partySettlementFingerprint,
  shouldProjectPartyUpdate,
  type FinalizationReason,
  type LifecycleParty,
  validateFinalization,
  validateParticipantRoster,
} from "./partyLifecycleCore.js";
import {
  buildStatsMarker,
  buildUserStatsUpdatePlan,
  needsApprovedUsersLookup,
  resolveParticipantStats,
  statsDayKey,
} from "./partyStatsCore.js";
import { applyPartyToMonthlyDoc } from "./rankingCore.js";

if (getApps().length === 0) {
  initializeApp();
}

const firestore = getFirestore();
const SETTLEMENTS_COLLECTION = "partySettlements";
const HISTORY_COLLECTION = "partyHistory";
const ARCHIVES_COLLECTION = "partyArchives";
const FINALIZATION_JOBS_COLLECTION = "partyFinalizationJobs";
const USERS_COLLECTION = "users";
const NOTIFICATIONS_COLLECTION = "notifications";
const ACQUISITIONS_COLLECTION = "characterAcquisitions";
const USER_STATS_COLLECTION = "userStats";
const PROCESSED_PARTIES_COLLECTION = "processedParties";
const RANKING_MONTHLY_COLLECTION = "rankingMonthly";
const MONTHLY_USERS_SUBCOLLECTION = "users";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function positiveInteger(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function finalizationReason(value: unknown): FinalizationReason | null {
  return value === "payment" || value === "quest_failed" ? value : null;
}

function historyRef(uid: string, partyId: string) {
  return firestore.collection(USERS_COLLECTION).doc(uid).collection(HISTORY_COLLECTION).doc(partyId);
}

function userStatsRef(uid: string) {
  return firestore.collection(USER_STATS_COLLECTION).doc(uid);
}

function processedPartyRef(uid: string, partyId: string) {
  return userStatsRef(uid).collection(PROCESSED_PARTIES_COLLECTION).doc(partyId);
}

/**
 * Commits cross-user statistics (userStats) for a concluded Quest, on the
 * backend — the same semantics, documents, and idempotency markers as the
 * commitPartyStats transaction in the frontend (App.tsx), which remains as a
 * self-healing fallback. Runs on EVERY materialization so that any later
 * update to the party also heals pending stats, and so the stats no longer
 * depend on each participant having the app open at the moment of conclusion.
 *
 * Idempotency: same marker subcollection userStats/{uid}/processedParties/
 * {partyId}. The frontend aborts silently when it finds the marker written
 * here (and vice versa), so the two writers never duplicate counts.
 */
async function commitPartyUserStats(party: LifecycleParty, eventId: string): Promise<void> {
  if (!party.questConcluida || party.questFalha) return;

  // Name → UID resolution is only needed for legacy slots without playerUid
  // (single query per materialization; modern parties skip it entirely).
  const nameToUid = new Map<string, string>();
  if (needsApprovedUsersLookup(party)) {
    const usersSnap = await firestore.collection(USERS_COLLECTION)
      .where("status", "==", "aprovado")
      .get();
    usersSnap.forEach(docSnap => {
      const nome = String(record(docSnap.data()).nome || "").trim();
      if (nome) nameToUid.set(nome.toLowerCase(), docSnap.id);
    });
  }

  const participants = resolveParticipantStats(party, nameToUid);
  let committed = 0;
  for (const info of participants) {
    try {
      await firestore.runTransaction(async transaction => {
        const markerRef = processedPartyRef(info.uid, party.id);
        const markerSnap = await transaction.get(markerRef);
        // Already processed — possibly by the frontend itself; abort silently.
        if (markerSnap.exists) return;

        const statsRef = userStatsRef(info.uid);
        const statsSnap = await transaction.get(statsRef);
        const now = Date.now();
        const dayKey = statsDayKey(party.questFinalizedAt, now);
        const plan = buildUserStatsUpdatePlan(
          info,
          party,
          dayKey,
          statsSnap.exists ? record(statsSnap.data()) : undefined,
          now,
        );

        transaction.set(markerRef, buildStatsMarker(party, now));

        const payload: Record<string, unknown> = { ...plan.absolutes };
        Object.entries(plan.increments).forEach(([path, delta]) => {
          payload[path] = FieldValue.increment(delta);
        });
        payload.ultimaAtualizacao = FieldValue.serverTimestamp();
        transaction.set(statsRef, payload, { merge: true });

        // RANKING MENSAL — doc consolidado do mês da Quest, atualizado na
        // MESMA transação (idempotente pelo mesmo marcador processedParties).
        // O mês vem do dayKey: conclusão atrasada de um mês anterior alimenta
        // o doc daquele mês. Base zerada quando o doc é legado (usuário ganha
        // histórico diário com esta própria PT). A reconciliação diária
        // (scheduledRankingReset) reconstrói o valor absoluto a partir de
        // dailyStats — este caminho dá o tempo real, aquela autocorrige.
        const monthKey = dayKey.slice(0, 7);
        const monthlyRef = firestore.collection(RANKING_MONTHLY_COLLECTION)
          .doc(monthKey)
          .collection(MONTHLY_USERS_SUBCOLLECTION)
          .doc(info.uid);
        const monthlySnap = await transaction.get(monthlyRef);
        const monthlyNext = applyPartyToMonthlyDoc(
          monthlySnap.exists ? record(monthlySnap.data()) : undefined,
          info,
          party,
          plan.absolutes.maxSequenciaSemMorte,
        );
        transaction.set(monthlyRef, {
          ...monthlyNext,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      });
      committed += 1;
    } catch (err) {
      // A failed participant must not abort the others, nor re-fail the
      // settlement (which has already been committed). Any later party update
      // retries the stats, and the frontend fallback still heals the gap.
      logger.error("party userStats commit failed", {
        eventId,
        partyId: party.id,
        uid: info.uid,
        err: String(err),
      });
    }
  }
  if (participants.length > 0) {
    logger.info("party userStats evaluated", {
      eventId,
      partyId: party.id,
      participants: participants.length,
      committed,
    });
  }
}

/**
 * Materializa settlement e históricos provisórios para PTs já concluídas.
 * Retorna sem qualquer leitura adicional quando uma atualização não altera
 * campos relevantes de divisão/drop/pagamento.
 */
export const materializePartySettlement = onDocumentUpdated(
  {
    document: "parties/{partyId}",
    retry: true,
  },
  async event => {
    if (!event.data) return;
    const before = parseLifecycleParty(event.params.partyId, event.data.before.data());
    const parsedAfter = parseLifecycleParty(event.params.partyId, event.data.after.data());
    if (!shouldProjectPartyUpdate(before, parsedAfter) || !parsedAfter) return;
    // PTs legadas podem não ter instante explícito; a primeira materialização
    // usa o momento do processamento e grava serverTimestamp no documento.
    const after = parsedAfter.questFinalizedAt > 0
      ? parsedAfter
      : { ...parsedAfter, questFinalizedAt: Date.now() };

    const partyRef = event.data.after.ref;
    const settlementRef = firestore.collection(SETTLEMENTS_COLLECTION).doc(after.id);
    let materializedParticipants = 0;

    await firestore.runTransaction(async transaction => {
      // A PT pode ter sido finalizada (e DELETADA) entre o evento e esta
      // transação — típico quando o líder solicita a finalização logo após
      // concluir a Quest. Sem esta checagem, o `transaction.update(partyRef)`
      // abaixo falharia sobre um documento inexistente e, com `retry: true`,
      // o trigger entraria em retentativa infinita.
      const [partySnap, settlementSnap] = await Promise.all([
        transaction.get(partyRef),
        transaction.get(settlementRef),
      ]);
      if (!partySnap.exists) return;
      const existingSettlement = settlementSnap.exists ? record(settlementSnap.data()) : {};
      const currentFingerprint = partySettlementFingerprint(after);
      const storedFingerprint = String(existingSettlement.fingerprint || "");
      const storedRevision = positiveInteger(existingSettlement.revision);
      const revision = storedFingerprint === currentFingerprint && storedRevision > 0
        ? storedRevision
        : Math.max(1, storedRevision + 1);
      const storedParticipants = Array.isArray(existingSettlement.participantUids)
        ? unique(existingSettlement.participantUids.map(value => String(value || "").trim()))
        : [];
      const participantIds = storedParticipants.length > 0 ? storedParticipants : unique(after.participantUids);
      const rosterError = storedParticipants.length > 0
        ? validateParticipantRoster(after, participantIds)
        : null;
      const settlement = buildPartySettlement(after, revision);
      settlement.participantUids = participantIds;
      settlement.viewerUids = settlement.viewerUids.filter(uid => participantIds.includes(uid));
      const histories = await Promise.all(participantIds.map(uid => transaction.get(historyRef(uid, after.id))));
      materializedParticipants = participantIds.length;

      transaction.set(settlementRef, {
        ...settlement,
        validationErrors: unique([...after.validationErrors, ...(rosterError ? [rosterError] : [])]),
        createdAt: existingSettlement.createdAt || FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      // Após a Quest, só Líder e beneficiários da divisão continuam na PT
      // operacional. Os demais já possuem histórico privado e deixam de manter
      // listener da PT ativa ao receberem o snapshot removido da query.
      const lifecyclePatch: Record<string, unknown> = {
        settlementRevision: revision,
        members: settlement.viewerUids,
        invitedUsers: after.visibility === "private" ? settlement.viewerUids : [],
      };
      if (after.questFinalizedAt === 0 || String(record(event.data?.after.data()).lifecycleStatus || "") !== "quest_finalized") {
        lifecyclePatch.lifecycleStatus = "quest_finalized";
        lifecyclePatch.questFinalizedAt = FieldValue.serverTimestamp();
      }
      transaction.update(partyRef, lifecyclePatch);

      participantIds.forEach((uid, index) => {
        const historySnap = histories[index];
        const existingHistory = historySnap.exists ? record(historySnap.data()) : {};
        const existingRevision = positiveInteger(existingHistory.sourceRevision);
        if (existingRevision > revision) return;
        const history = buildPersonalPartyHistory(after, uid, revision, "quest_finalized");
        transaction.set(historyRef(uid, after.id), {
          id: after.id,
          ...history,
          createdAt: existingHistory.createdAt || FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      });
    });

    logger.info("party settlement materialized", {
      eventId: event.id,
      partyId: after.id,
      participants: materializedParticipants,
    });

    // Statistics are committed AFTER the settlement transaction: a stats
    // failure must never roll back the (already committed) settlement, and
    // per-participant transactions keep the two concerns independent.
    await commitPartyUserStats(after, event.id);
  },
);

/**
 * Finalização definitiva orientada por comando durável. Uma vez que o pedido
 * chega ao Firestore, a Function conclui o trabalho mesmo se todos os clientes
 * fecharem o aplicativo.
 */
export const finalizePartyHistory = onDocumentCreated(
  {
    document: "partyFinalizationRequests/{requestId}",
    retry: true,
  },
  async event => {
    if (!event.data) return;
    const requestRef = event.data.ref;
    const request = record(event.data.data());
    const partyId = String(request.partyId || "").trim();
    const requestedByUid = String(request.requestedByUid || "").trim();
    const reason = finalizationReason(request.reason);

    if (!partyId || !requestedByUid || !reason) {
      await requestRef.set({
        state: "failed",
        lastError: "invalid_finalization_request",
        processedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return;
    }

    const partyRef = firestore.collection("parties").doc(partyId);
    const settlementRef = firestore.collection(SETTLEMENTS_COLLECTION).doc(partyId);
    const archiveRef = firestore.collection(ARCHIVES_COLLECTION).doc(partyId);
    const jobRef = firestore.collection(FINALIZATION_JOBS_COLLECTION).doc(partyId);
    const requesterRef = firestore.collection(USERS_COLLECTION).doc(requestedByUid);

    try {
      let finalStatus: "finalized" | "failed" | null = null;
      let validationError = "";
      let recipientCount = 0;

      await firestore.runTransaction(async transaction => {
        const [partySnap, settlementSnap, jobSnap, requesterSnap] = await Promise.all([
          transaction.get(partyRef),
          transaction.get(settlementRef),
          transaction.get(jobRef),
          transaction.get(requesterRef),
        ]);

        const existingJob = jobSnap.exists ? record(jobSnap.data()) : {};
        if (existingJob.state === "completed") {
          transaction.set(requestRef, {
            state: "completed",
            duplicateOf: partyId,
            processedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
          return;
        }

        if (!partySnap.exists) {
          validationError = "party_not_found";
          transaction.set(jobRef, {
            partyId,
            state: "failed",
            lastError: validationError,
            updatedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
          transaction.set(requestRef, {
            state: "failed",
            lastError: validationError,
            processedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
          return;
        }

        const party = parseLifecycleParty(partyId, partySnap.data());
        if (!party) {
          validationError = "invalid_party";
          transaction.set(jobRef, {
            partyId,
            state: "failed",
            lastError: validationError,
            updatedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
          transaction.set(requestRef, {
            state: "failed",
            lastError: validationError,
            processedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
          return;
        }

        const requesterRole = requesterSnap.exists ? String(record(requesterSnap.data()).role || "") : "";
        const requesterCanFinalize = party.leaderUid === requestedByUid || requesterRole === "Boss";
        if (!requesterCanFinalize) {
          validationError = "requester_not_authorized";
          transaction.set(jobRef, {
            partyId,
            state: "failed",
            lastError: validationError,
            updatedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
          transaction.set(requestRef, {
            state: "failed",
            lastError: validationError,
            processedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
          return;
        }

        const effectiveParty = reason === "quest_failed"
          ? { ...party, questFalha: true, questConcluida: false }
          : party;
        validationError = validateFinalization(effectiveParty, reason) || "";
        if (validationError) {
          transaction.set(jobRef, {
            partyId,
            state: "failed",
            lastError: validationError,
            updatedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
          transaction.set(requestRef, {
            state: "failed",
            lastError: validationError,
            processedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
          return;
        }

        // Direitos financeiros de personagem negociado não podem ser aceitos
        // somente porque o slot foi alterado no cliente. Revalidamos contra o
        // documento canônico da aquisição dentro da própria transação final.
        if (reason === "payment") {
          const acquiredSlots = effectiveParty.slots.filter(slot => !!slot.characterAcquisitionId);
          const acquisitionSnapshots = await Promise.all(acquiredSlots.map(slot =>
            transaction.get(firestore.collection(ACQUISITIONS_COLLECTION).doc(slot.characterAcquisitionId)),
          ));
          for (let index = 0; index < acquiredSlots.length; index += 1) {
            const slot = acquiredSlots[index];
            const acquisitionSnap = acquisitionSnapshots[index];
            const acquisition = acquisitionSnap.exists ? record(acquisitionSnap.data()) : {};
            const expectedHolder = String(acquisition.financialRightsHolderUid || acquisition.acquirerUid || "").trim();
            if (!expectedHolder || slot.financialRightsHolderUid !== expectedHolder) {
              validationError = `financial_rights_record_mismatch:${slot.id}`;
              break;
            }
          }
          if (validationError) {
            transaction.set(jobRef, {
              partyId,
              state: "failed",
              lastError: validationError,
              updatedAt: FieldValue.serverTimestamp(),
            }, { merge: true });
            transaction.set(requestRef, {
              state: "failed",
              lastError: validationError,
              processedAt: FieldValue.serverTimestamp(),
            }, { merge: true });
            return;
          }
        }

        const existingSettlement = settlementSnap.exists ? record(settlementSnap.data()) : {};
        const frozenParticipantUids = Array.isArray(existingSettlement.participantUids)
          ? unique(existingSettlement.participantUids.map(value => String(value || "").trim()))
          : unique(effectiveParty.participantUids);
        const rosterError = validateParticipantRoster(effectiveParty, frozenParticipantUids);
        if (rosterError) {
          validationError = rosterError;
          transaction.set(jobRef, {
            partyId,
            state: "failed",
            lastError: validationError,
            updatedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
          transaction.set(requestRef, {
            state: "failed",
            lastError: validationError,
            processedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
          return;
        }
        const existingRevision = positiveInteger(existingSettlement.revision);
        const expectedRevision = positiveInteger(request.expectedRevision);
        if (expectedRevision > 0 && existingRevision !== expectedRevision) {
          validationError = "stale_settlement_revision";
          transaction.set(jobRef, {
            partyId,
            state: "failed",
            lastError: validationError,
            expectedRevision,
            actualRevision: existingRevision,
            updatedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
          transaction.set(requestRef, {
            state: "failed",
            lastError: validationError,
            processedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
          return;
        }
        const fingerprint = partySettlementFingerprint(effectiveParty);
        const revision = String(existingSettlement.fingerprint || "") === fingerprint && existingRevision > 0
          ? existingRevision
          : Math.max(1, existingRevision + 1);
        const status = reason === "quest_failed" ? "failed" : "finalized";
        const recipients = frozenParticipantUids;
        const histories = await Promise.all(recipients.map(uid => transaction.get(historyRef(uid, partyId))));
        const archivedAtMs = Date.now();
        const archive = buildSanitizedPartyArchive(effectiveParty, status, archivedAtMs);

        transaction.set(archiveRef, {
          ...archive,
          archivedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });

        recipients.forEach((uid, index) => {
          const historySnap = histories[index];
          const existingHistory = historySnap.exists ? record(historySnap.data()) : {};
          const history = buildPersonalPartyHistory(effectiveParty, uid, revision, status);
          transaction.set(historyRef(uid, partyId), {
            id: partyId,
            ...history,
            finalizationVersion: revision,
            party: {
              ...history.party,
              finalizedAt: archivedAtMs,
            },
            createdAt: existingHistory.createdAt || FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          }, { merge: true });

          const notificationRef = firestore.collection(NOTIFICATIONS_COLLECTION).doc(`party_finalized_${partyId}_${uid}`);
          transaction.set(notificationRef, {
            id: `party_finalized_${partyId}_${uid}`,
            userId: uid,
            type: "party_finalized",
            title: status === "failed" ? "PT encerrada por falha" : "PT finalizada",
            body: status === "failed"
              ? `A PT "${effectiveParty.name}" foi encerrada como falha e já está no seu histórico.`
              : `A PT "${effectiveParty.name}" foi finalizada e já está no seu histórico privado.`,
            partyId,
            partyName: effectiveParty.name,
            questType: effectiveParty.questType,
            status: "pending",
            createdAt: archivedAtMs,
          }, { merge: true });
        });

        transaction.set(jobRef, {
          partyId,
          state: "completed",
          reason,
          requestedByUid,
          sourceRevision: revision,
          completedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        transaction.set(requestRef, {
          state: "completed",
          partyId,
          reason,
          processedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        transaction.delete(settlementRef);
        transaction.delete(partyRef);

        finalStatus = status;
        recipientCount = recipients.length;
      });

      if (validationError) {
        logger.warn("party finalization rejected", {
          eventId: event.id,
          partyId,
          reason,
          validationError,
        });
        return;
      }

      logger.info("party finalization completed", {
        eventId: event.id,
        partyId,
        reason,
        status: finalStatus,
        recipients: recipientCount,
      });
    } catch (error: any) {
      await Promise.allSettled([
        jobRef.set({
          partyId,
          state: "failed",
          lastError: String(error?.message || error),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true }),
        requestRef.set({
          state: "failed",
          lastError: String(error?.message || error),
          processedAt: FieldValue.serverTimestamp(),
        }, { merge: true }),
      ]);
      logger.error("party finalization failed", {
        eventId: event.id,
        partyId,
        error: String(error?.message || error),
      });
      throw error;
    }
  },
);