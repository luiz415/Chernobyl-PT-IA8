import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions";
import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

if (getApps().length === 0) {
  initializeApp();
}

// ============================================================================
// NOTIFICAÇÕES PERSONALIZADAS DO BOSS — fan-out no backend.
// ============================================================================
//
// FLUXO:
//   1) O Boss grava um PEDIDO em `customNotificationRequests/{requestId}`
//      (as Firestore Rules já restringem a criação a Boss aprovado, com os
//      limites exatos de 30/120 caracteres validados nas próprias rules).
//   2) Este trigger REVALIDA no backend que o criador do pedido é Boss
//      aprovado (defesa em profundidade — a autorização nunca depende só da
//      interface nem só das rules) e valida título/descrição novamente.
//   3) Resolve os destinatários (um usuário específico ou todos os usuários
//      aprovados) e grava as notificações na coleção `notifications` — o
//      MESMO pipeline das demais notificações do app: o listener do
//      useNotifications entrega com o app aberto e o `notificationPushTrigger`
//      dispara o push (FCM) com a aba fechada. Nenhum mecanismo novo.
//   4) Atualiza o pedido com `status: "sent"` + contagem (feedback em tempo
//      real no painel do Boss) ou `status: "rejected"` + motivo.
//
// ANONIMATO: o documento da notificação carrega APENAS id/userId/type/title/
// body/status/createdAt — nenhum campo identifica o remetente ou indica
// origem administrativa. O tipo `custom_message` é renderizado pelo
// NotificationCenter com o tema neutro padrão, sem selo ou ação extra.
//
// VOLUME/DUPLICAÇÃO: fan-out em lotes de 400 writes (limite de 500 por
// WriteBatch) e ids DETERMINÍSTICOS (`custom_{requestId}_{uid}`) gravados com
// `set` — reexecuções/retries do trigger sobrescrevem os mesmos documentos em
// vez de duplicar. A releitura autoritativa do pedido no início (status
// precisa ser "pending") torna o processamento idempotente de ponta a ponta.
// ============================================================================

const firestore = getFirestore();

const REQUESTS_COLLECTION = "customNotificationRequests";
const NOTIFICATIONS_COLLECTION = "notifications";
const USERS_COLLECTION = "users";

export const CUSTOM_NOTIFICATION_TITLE_MAX = 30;
export const CUSTOM_NOTIFICATION_BODY_MAX = 120;

/** Limite seguro por WriteBatch (máximo real do Firestore: 500 operações). */
const BATCH_WRITE_LIMIT = 400;

export interface CustomNotificationRequest {
  createdBy: string;
  target: "all" | "user";
  targetUid?: string;
  title: string;
  body: string;
}

/**
 * Validação pura do payload do pedido (reaplicada no backend mesmo com as
 * rules já restringindo a criação — nunca confiar apenas no cliente).
 */
export function parseCustomNotificationRequest(raw: unknown):
  | { ok: true; request: CustomNotificationRequest }
  | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Pedido inválido." };
  const data = raw as Record<string, unknown>;

  const createdBy = typeof data.createdBy === "string" ? data.createdBy.trim() : "";
  if (!createdBy) return { ok: false, error: "Pedido sem remetente." };

  const title = typeof data.title === "string" ? data.title.trim() : "";
  if (!title) return { ok: false, error: "Título obrigatório." };
  if (title.length > CUSTOM_NOTIFICATION_TITLE_MAX) {
    return { ok: false, error: `Título acima de ${CUSTOM_NOTIFICATION_TITLE_MAX} caracteres.` };
  }

  const body = typeof data.body === "string" ? data.body.trim() : "";
  if (!body) return { ok: false, error: "Descrição obrigatória." };
  if (body.length > CUSTOM_NOTIFICATION_BODY_MAX) {
    return { ok: false, error: `Descrição acima de ${CUSTOM_NOTIFICATION_BODY_MAX} caracteres.` };
  }

  const target = data.target === "all" || data.target === "user" ? data.target : null;
  if (!target) return { ok: false, error: "Destinatário inválido." };

  const targetUid = typeof data.targetUid === "string" ? data.targetUid.trim() : "";
  if (target === "user" && !targetUid) return { ok: false, error: "Destinatário específico não informado." };

  return { ok: true, request: { createdBy, target, targetUid: targetUid || undefined, title, body } };
}

export const customNotify = onDocumentCreated(
  { document: `${REQUESTS_COLLECTION}/{requestId}` },
  async event => {
    const requestId = String(event.params.requestId || "");
    if (!requestId) return;
    const requestRef = firestore.collection(REQUESTS_COLLECTION).doc(requestId);

    // Releitura autoritativa: em redeliveries (at-least-once) o pedido já
    // processado está com status != "pending" — sai sem reenviar nada.
    const freshSnap = await requestRef.get();
    if (!freshSnap.exists) return;
    const rawData = freshSnap.data();
    if (!rawData || rawData.status !== "pending") return;

    const reject = async (error: string) => {
      await requestRef.set({ status: "rejected", error, processedAt: Date.now() }, { merge: true });
      logger.warn(`[customNotify] Pedido ${requestId} rejeitado: ${error}`);
    };

    const parsed = parseCustomNotificationRequest(rawData);
    if (!parsed.ok) {
      await reject(parsed.error);
      return;
    }
    const request = parsed.request;

    // ── AUTORIZAÇÃO NO BACKEND: somente Boss aprovado envia ────────────────
    const senderSnap = await firestore.collection(USERS_COLLECTION).doc(request.createdBy).get();
    const sender = senderSnap.exists ? senderSnap.data() : null;
    if (!sender || sender.role !== "Boss" || sender.status !== "aprovado") {
      await reject("Remetente sem permissão de Boss.");
      return;
    }

    // ── DESTINATÁRIOS ──────────────────────────────────────────────────────
    let recipientUids: string[];
    if (request.target === "user") {
      const targetUid = request.targetUid as string;
      const targetSnap = await firestore.collection(USERS_COLLECTION).doc(targetUid).get();
      if (!targetSnap.exists) {
        await reject("Usuário destinatário não encontrado.");
        return;
      }
      recipientUids = [targetUid];
    } else {
      const allSnap = await firestore
        .collection(USERS_COLLECTION)
        .where("status", "==", "aprovado")
        .get();
      // Set elimina qualquer repetição — cada usuário recebe UMA notificação.
      recipientUids = Array.from(new Set(allSnap.docs.map(d => d.id).filter(Boolean)));
    }

    // ── FAN-OUT EM LOTES ───────────────────────────────────────────────────
    // Mesmo shape das demais notificações persistidas do app (id espelhado,
    // userId = dono, status pending) — SEM campos de remetente/origem.
    const createdAt = Date.now();
    let sentCount = 0;
    for (let i = 0; i < recipientUids.length; i += BATCH_WRITE_LIMIT) {
      const chunk = recipientUids.slice(i, i + BATCH_WRITE_LIMIT);
      const batch = firestore.batch();
      chunk.forEach(uid => {
        const notificationId = `custom_${requestId}_${uid}`;
        batch.set(firestore.collection(NOTIFICATIONS_COLLECTION).doc(notificationId), {
          id: notificationId,
          userId: uid,
          type: "custom_message",
          title: request.title,
          body: request.body,
          status: "pending",
          createdAt,
        });
      });
      await batch.commit();
      sentCount += chunk.length;
    }

    await requestRef.set({ status: "sent", sentCount, processedAt: Date.now() }, { merge: true });
    logger.info(`[customNotify] Pedido ${requestId}: ${sentCount} notificação(ões) enviada(s) (target=${request.target}).`);
  },
);
