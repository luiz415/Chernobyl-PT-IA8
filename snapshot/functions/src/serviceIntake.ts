import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { onDocumentCreated } from "firebase-functions/v2/firestore";

if (getApps().length === 0) {
  initializeApp();
}

const firestore = getFirestore();
const USERS_COLLECTION = "users";
const NOTIFICATIONS_COLLECTION = "notifications";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function positiveNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function questType(value: unknown): "soulwar" | "sanguine" {
  return value === "sanguine" ? "sanguine" : "soulwar";
}

/**
 * Notifica o Boss quando o Formulário Público cadastra um personagem com
 * Serviceiro "Qualquer um".
 *
 * Por que uma Function: o cadastro acontece no navegador anônimo do cliente,
 * com o app do Boss fechado. O trigger `onDocumentCreated` em `waitingList`
 * processa o evento no backend no instante da gravação — independentemente de
 * quem está online.
 *
 * Escopo deliberadamente estreito:
 *   • Só `source === "public_form"` notifica. Pedidos dirigidos a um Serviceiro
 *     específico nem chegam aqui (nascem em `serviceRequests` com notificação
 *     própria), e adições internas pelo app do Boss não precisam avisar o
 *     próprio Boss.
 *   • Só usuários `role === "Boss"` e `status === "aprovado"` recebem — a guia
 *     "Services" é exclusiva deles.
 *
 * Anti-duplicação: o id do documento de notificação é determinístico
 * (`service_waiting_{serviceId}_{bossUid}`) e a gravação usa `set` com
 * `merge`. O trigger dispara uma vez por documento; se o evento for
 * reentregue, a mesma notificação é apenas reescrita sobre si mesma — nunca
 * criada em duplicidade.
 */
export const notifyBossServiceWaiting = onDocumentCreated(
  { document: "waitingList/{serviceId}" },
  async event => {
    const data = record(event.data?.data());
    if (String(data.source || "") !== "public_form") return;

    const serviceId = String(event.params.serviceId || "");
    if (!serviceId) return;

    const personagem = String(data.personagem || "").trim() || "Personagem";
    const level = positiveNumber(data.level);
    const quest = questType(data.quest);
    const createdAt = positiveNumber(data.createdAt) || Date.now();

    try {
      // Consulta de campo único (role) — atendida pelo índice automático.
      const usersSnap = await firestore.collection(USERS_COLLECTION)
        .where("role", "==", "Boss")
        .get();

      const bossUids = usersSnap.docs
        .filter(userDoc => String(record(userDoc.data()).status || "") === "aprovado")
        .map(userDoc => String(userDoc.id))
        .filter(uid => uid.length > 0);

      if (bossUids.length === 0) {
        logger.info("Nenhum Boss aprovado para notificar sobre o service", { serviceId });
        return;
      }

      const body = `${personagem}${level > 0 ? ` (level ${level})` : ""} — novo personagem de Service "Qualquer um" aguardando atendimento na guia Services.`;

      await Promise.all(bossUids.map(uid =>
        firestore.collection(NOTIFICATIONS_COLLECTION)
          .doc(`service_waiting_${serviceId}_${uid}`)
          .set({
            id: `service_waiting_${serviceId}_${uid}`,
            userId: uid,
            type: "service_waiting",
            title: "Novo Service aguardando atendimento",
            body,
            questType: quest,
            serviceId,
            status: "pending",
            createdAt,
          }, { merge: true }),
      ));
    } catch (error) {
      // Notificação é acessória: falhas são registradas sem derrubar o evento
      // nem disparar reentregas (que aqui seriam inúteis — o id é determinístico).
      logger.error("Falha ao notificar Boss sobre novo service da Lista de Espera", {
        serviceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
);