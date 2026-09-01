import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions";
import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { sendPushToUser } from "./pushNotify.js";

if (getApps().length === 0) {
  initializeApp();
}

const firestore = getFirestore();
const PREFS_COLLECTION = "userNotificationPrefs";

/**
 * Respeita a preferência do usuário (o mesmo toggle do modal "Configurar
 * Notificações", espelhado em `userNotificationPrefs/{uid}.typeEnabled`).
 * Sem documento ou sem entrada do tipo → habilitado (default ON, igual ao
 * gate local do app).
 */
async function isPushEnabledForType(uid: string, type: string): Promise<boolean> {
  try {
    const snap = await firestore.collection(PREFS_COLLECTION).doc(uid).get();
    if (!snap.exists) return true;
    const data = snap.data();
    const typeEnabled = data && typeof data.typeEnabled === "object" && data.typeEnabled !== null
      ? (data.typeEnabled as Record<string, unknown>)
      : {};
    return typeEnabled[type] !== false;
  } catch {
    return true; // pref ilegível nunca deve calar o push
  }
}

// ============================================================================
// PUSH UNIFICADO — um trigger para TODAS as notificações do app.
// ============================================================================
//
// Toda notificação persistente do Chernobyl vive em `notifications/{id}` com
// `userId` = dono. Este trigger observa a CRIAÇÃO de documentos nessa coleção
// — não importa QUEM criou (cliente web do remetente, Formulário Público,
// Boss no painel administrativo ou outra Cloud Function) — e dispara o push
// Web (FCM) para todos os dispositivos do dono.
//
// Com isso, uma única integração cobre todas as categorias existentes e
// futuras: service_request, payment_received, vip_approved, pt_added,
// schedule_changed, quest_completed, party_finalized, service_waiting,
// bazaar_interest_ending, pt_reminder, pt_updated…
//
// ENTREGA POR ESTADO DO NAVEGADOR (sem duplicar):
//   • App ABERTO (primeiro plano ou minimizado/segundo plano): o listener do
//     Firestore (onSnapshot) exibe a notificação na hora — o Service Worker
//     percebe a existência de um cliente aberto e NÃO mostra a dele.
//   • Aba FECHADA (navegador aberto): o Service Worker recebe o push e mostra
//     a notificação do sistema.
//   • Navegador FECHADO: dependente do SO/navegador (modo background do
//     Chrome) — limitação documentada, não da implementação.
//
// Tipos EXCLUÍDOS do push: apenas os que não são eventos para o usuário
// (`request_entry`/`rate_limit_block` são internos do fluxo de cadastro e
// `update_available` é local do Electron).
// ============================================================================

const EXCLUDED_TYPES = new Set(["request_entry", "rate_limit_block", "update_available"]);

export const notificationPushTrigger = onDocumentCreated(
  { document: "notifications/{notifId}" },
  async event => {
    const data = event.data?.data();
    if (!data || typeof data !== "object") return;

    const record = data as Record<string, unknown>;
    const type = String(record.type || "");
    if (EXCLUDED_TYPES.has(type)) return;

    const uid = String(record.userId || "").trim();
    if (!uid) return;

    const title = String(record.title || "").trim();
    const body = String(record.body || "").trim();
    if (!title) return;

    const dataPayload: Record<string, string> = { type };
    const url = String(record.url || "").trim();
    if (url) dataPayload.url = url;
    const partyId = String(record.partyId || "").trim();
    if (partyId) dataPayload.partyId = partyId;
    const serviceId = String(record.serviceId || "").trim();
    if (serviceId) dataPayload.serviceId = serviceId;

    const notifId = String(event.params.notifId || record.id || "") || `notif_${Date.now()}`;

    if (!(await isPushEnabledForType(uid, type))) {
      logger.info("Push suprimido pela preferência do usuário", { notifId, type, uid });
      return;
    }

    logger.info("Push de notificação", { notifId, type, uid });
    await sendPushToUser(uid, {
      title,
      body,
      notificationId: notifId,
      data: dataPayload,
    });
  },
);