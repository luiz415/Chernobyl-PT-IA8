import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import {
  planPtReminders,
  planPtUpdatedNotifications,
  resolvePartyMemberUids,
  type CharLike,
  type PartyLike,
  type PtReminderPrefs,
} from "./ptNotifyCore.js";

if (getApps().length === 0) {
  initializeApp();
}

// ============================================================================
// WATCHER DE PTs — lembretes de horário + drops/valores atualizados.
// ============================================================================
//
// 1) `scheduledPtReminderWatch` (a cada minuto): substitui o `setInterval`
//    de 60s do hook useNotifications. Lê apenas as PTs com horário na faixa
//    relevante (query de campo único, índice automático), resolve os UIDs dos
//    membros (personagens + nomes) e grava as notificações "PT em X minutos"
//    para cada membro — chegando por listener (app aberto) e push (aba
//    fechada) como qualquer outra notificação.
//
// 2) `onPartyUpdated` (onDocumentUpdated em parties/{id}): detecta a mudança
//    do campo `dropsValuesSavedAt` no INSTANTE do salvamento e notifica os
//    membros (exceto o autor) — antes isso era computado pelo receptor com o
//    app aberto.
//
// IDEMPOTÊNCIA: ids/marcadores determinísticos (`pt_reminder_{janela}_{pt}_{horário}_{uid}`
// e `pt_updated_{pt}_{savedAt}_{uid}`) gravados com `set` em `notifyState` —
// reexecuções e reentregas nunca duplicam. Marcadores sobrevivem à leitura da
// notificação (que apaga o doc de `notifications`).
// ============================================================================

const firestore = getFirestore();

const PREFS_COLLECTION = "userNotificationPrefs";
const NOTIFY_STATE_COLLECTION = "notifyState";
const NOTIFICATIONS_COLLECTION = "notifications";
const USERS_COLLECTION = "users";
const CHARACTERS_COLLECTION = "characters";
const PARTIES_COLLECTION = "parties";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function toPartyLike(data: Record<string, unknown>): PartyLike {
  return {
    id: String(data.id || ""),
    name: String(data.name || ""),
    ptType: data.ptType ? String(data.ptType) : undefined,
    horarioTimestamp: Number(data.horarioTimestamp || 0) || undefined,
    questConcluida: data.questConcluida === true,
    questFalha: data.questFalha === true,
    archived: data.archived === true,
    ptStartedAt: Number(data.ptStartedAt || 0) || undefined,
    isPaused: data.isPaused === true,
    selectedIds: Array.isArray(data.selectedIds) ? data.selectedIds.map(String) : [],
    customMembers: Array.isArray(data.customMembers)
      ? data.customMembers.map(member => ({ label: String(record(member).label || "") }))
      : [],
    slotData: ((): Record<string, { owner?: string; player?: string }> => {
      const result: Record<string, { owner?: string; player?: string }> = {};
      Object.entries(record(data.slotData)).forEach(([key, slot]) => {
        const slotRecord = record(slot);
        result[key] = {
          owner: slotRecord.owner ? String(slotRecord.owner) : undefined,
          player: slotRecord.player ? String(slotRecord.player) : undefined,
        };
      });
      return result;
    })(),
    dropsValuesSaved: data.dropsValuesSaved === true,
    dropsValuesSavedAt: Number(data.dropsValuesSavedAt || 0) || undefined,
    dropsValuesSavedBy: data.dropsValuesSavedBy ? String(data.dropsValuesSavedBy) : undefined,
  };
}

/** Mapa nome normalizado → uid (coleção `users` — comunidade pequena). */
async function loadUsersByName(): Promise<{ usersByName: Record<string, string>; uidByName: Record<string, string> }> {
  const usersByName: Record<string, string> = {};
  const uidByName: Record<string, string> = {};
  const snap = await firestore.collection(USERS_COLLECTION).get();
  snap.docs.forEach(userDoc => {
    const uid = String(userDoc.id || "").trim();
    const nome = String(record(userDoc.data()).nome || "").trim().toLowerCase();
    if (uid && nome) {
      usersByName[nome] = uid;
      uidByName[nome] = uid;
    }
  });
  return { usersByName, uidByName };
}

async function loadPrefsByUid(): Promise<Record<string, PtReminderPrefs>> {
  const prefsByUid: Record<string, PtReminderPrefs> = {};
  const snap = await firestore.collection(PREFS_COLLECTION).get();
  snap.docs.forEach(prefDoc => {
    const uid = String(prefDoc.id || "").trim();
    if (!uid) return;
    const data = record(prefDoc.data());
    const typeEnabled = record(data.typeEnabled);
    prefsByUid[uid] = {
      reminder30: data.ptReminder30 === false ? false : true,
      reminder15: data.ptReminder15 === false ? false : true,
      reminder5: data.ptReminder5 === false ? false : true,
      enabled: typeEnabled.pt_reminder === false ? false : true,
      ptUpdatedEnabled: typeEnabled.pt_updated === false ? false : true,
    };
  });
  return prefsByUid;
}

/** Lê personagens em lotes (getAll aceita até 300 refs por chamada). */
async function loadCharsById(charIds: string[]): Promise<Record<string, CharLike>> {
  const charsById: Record<string, CharLike> = {};
  const uniqueIds = Array.from(new Set(charIds.map(id => String(id || "").trim()).filter(id => id.length > 0)));
  const CHUNK = 250;
  for (let index = 0; index < uniqueIds.length; index += CHUNK) {
    const chunk = uniqueIds.slice(index, index + CHUNK);
    const refs = chunk.map(charId => firestore.collection(CHARACTERS_COLLECTION).doc(charId));
    const snaps = await firestore.getAll(...refs);
    snaps.forEach(snap => {
      if (!snap.exists) return;
      const data = record(snap.data());
      charsById[snap.id] = {
        id: snap.id,
        ownerUid: data.ownerUid ? String(data.ownerUid) : undefined,
        ownerName: data.ownerName ? String(data.ownerName) : undefined,
      };
    });
  }
  return charsById;
}

interface NotifiablePlan {
  notificationId: string;
  markerId: string;
  type: string;
  userId: string;
  createdAt: number;
  partyId?: string;
}

async function commitPlans<T extends NotifiablePlan>(plans: T[]): Promise<void> {
  if (plans.length === 0) return;
  const batch = firestore.batch();
  plans.forEach(plan => {
    const { notificationId, markerId, ...doc } = plan;
    // Doc da notificação: mesmo shape que os demais criadores do app usam
    // (id espelhado, userId = dono, status pending).
    batch.set(firestore.collection(NOTIFICATIONS_COLLECTION).doc(notificationId), {
      ...doc,
      id: notificationId,
    });
    batch.set(firestore.collection(NOTIFY_STATE_COLLECTION).doc(markerId), {
      kind: String(plan.type),
      partyId: plan.partyId || "",
      userId: plan.userId,
      notifiedAt: plan.createdAt,
    });
  });
  await batch.commit();
}

export const scheduledPtReminderWatch = onSchedule(
  { schedule: "every 1 minutes", timeZone: "America/Sao_Paulo" },
  async () => {
    const nowMs = Date.now();
    // PTs com horário nos próximos 40 min ou que começaram há até 10 min
    // (janela mais larga que a necessária — o núcleo filtra pelas faixas).
    const from = nowMs - 10 * 60 * 1000;
    const to = nowMs + 40 * 60 * 1000;

    const partiesSnap = await firestore.collection(PARTIES_COLLECTION)
      .where("horarioTimestamp", ">=", from)
      .where("horarioTimestamp", "<=", to)
      .get();
    if (partiesSnap.empty) return;

    const parties = partiesSnap.docs
      .map(doc => toPartyLike({ ...record(doc.data()), id: doc.id }))
      .filter(party => party.id && party.name);

    // Personagens de todas as PTs candidatas (uma leitura em lotes).
    const allCharIds = parties.flatMap(party => party.selectedIds || []);
    const [charsById, users, prefsByUid] = await Promise.all([
      loadCharsById(allCharIds),
      loadUsersByName(),
      loadPrefsByUid(),
    ]);

    const memberUidsByParty: Record<string, Set<string>> = {};
    parties.forEach(party => {
      memberUidsByParty[party.id] = resolvePartyMemberUids({ party, charsById, usersByName: users.usersByName });
    });

    // Marcadores candidatos (leitura pontual).
    const candidateMarkerIds = new Set<string>();
    parties.forEach(party => {
      const scheduledTime = Number(party.horarioTimestamp || 0);
      if (!scheduledTime) return;
      (memberUidsByParty[party.id] || new Set<string>()).forEach(uid => {
        // Mesma fórmula do núcleo (uid no fim) — um marcador por usuário.
        candidateMarkerIds.add(`pt_reminder_30_${party.id}_${scheduledTime}_${uid}`);
        candidateMarkerIds.add(`pt_reminder_15_${party.id}_${scheduledTime}_${uid}`);
        candidateMarkerIds.add(`pt_reminder_5_${party.id}_${scheduledTime}_${uid}`);
      });
    });
    if (candidateMarkerIds.size === 0) return;

    const markerRefs = Array.from(candidateMarkerIds).map(markerId =>
      firestore.collection(NOTIFY_STATE_COLLECTION).doc(markerId),
    );
    const markerSnaps = await firestore.getAll(...markerRefs);
    const existingMarkerIds = new Set<string>();
    markerSnaps.forEach(snap => { if (snap.exists) existingMarkerIds.add(snap.id); });

    const plans = planPtReminders({
      nowMs,
      parties,
      memberUidsByParty,
      prefsByUid,
      existingMarkerIds,
    });
    if (plans.length === 0) return;

    await commitPlans(plans);
    logger.info("Lembretes de PT criados", { count: plans.length });
  },
);

export const onPartyUpdated = onDocumentUpdated(
  { document: "parties/{partyId}" },
  async event => {
    const before = record(event.data?.before?.data());
    const after = record(event.data?.after?.data());
    if (!after || Object.keys(after).length === 0) return;

    const partyId = String(event.params.partyId || after.id || "").trim();
    if (!partyId) return;

    const afterParty = toPartyLike({ ...after, id: partyId });
    const beforeParty = toPartyLike({ ...before, id: partyId });
    const beforeSavedAt = Number(beforeParty.dropsValuesSavedAt || 0);
    const afterSavedAt = Number(afterParty.dropsValuesSavedAt || 0);
    if (!(afterSavedAt > 0 && afterSavedAt !== beforeSavedAt)) return;

    const [charsById, users] = await Promise.all([
      loadCharsById(afterParty.selectedIds || []),
      loadUsersByName(),
    ]);
    const memberUids = resolvePartyMemberUids({ party: afterParty, charsById, usersByName: users.usersByName });
    if (memberUids.size === 0) return;

    // O autor do salvamento (identificado por NOME na PT) não é notificado.
    const saverName = String(afterParty.dropsValuesSavedBy || "").trim().toLowerCase();
    const saverUid = saverName ? users.uidByName[saverName] : undefined;

    // Membros com o tipo "drops/valores" desligado não recebem nem o doc.
    const prefsByUid = await loadPrefsByUid();
    const eligibleMembers = new Set<string>();
    memberUids.forEach(uid => {
      if (prefsByUid[uid]?.ptUpdatedEnabled !== false) eligibleMembers.add(uid);
    });

    const plans = planPtUpdatedNotifications({
      nowMs: Date.now(),
      before: beforeParty,
      after: afterParty,
      memberUids: eligibleMembers,
      saverUid,
    });
    if (plans.length === 0) return;

    await commitPlans(plans);
    logger.info("Notificações de drops/valores criadas", { partyId, count: plans.length });
  },
);