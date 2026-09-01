import { getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";
import { logger } from "firebase-functions";

if (getApps().length === 0) {
  initializeApp();
}

// ============================================================================
// PUSH (Web Push via FCM) — envio unificado das notificações Desktop.
// ============================================================================
//
// Arquitetura: TODA notificação persistente vive na coleção `notifications`
// (criada pelo frontend OU por Cloud Functions). O trigger
// `notificationPushTrigger` (notificationPush.ts) observa `onDocumentCreated`
// nessa coleção e repassa ao usuário dono do documento via FCM — um único
// ponto de envio para todas as categorias, presentes e futuras.
//
// Tokens: `pushTokens/{uid}` guarda a lista de tokens de TODOS os
// dispositivos/navegadores do usuário (múltiplos dispositivos = múltiplas
// entradas; o FCM entrega para todos e cada dispositivo mostra a sua).
// Tokens inválidos (app desinstalado, permissão revogada, subscription
// expirada) são removidos automaticamente a partir da resposta do FCM —
// subscription antiga nunca quebra o envio para os demais dispositivos.
// ============================================================================

const PUSH_TOKENS_COLLECTION = "pushTokens";

/**
 * Payload de push: SOMENTE DADOS (`data`). O título/corpo viajam dentro de
 * `data` (notificationTitle/notificationBody) e é o Service Worker do app —
 * o único dono da exibição — quem chama `showNotification`.
 *
 * Por que NÃO usar o campo `notification` do FCM: com um payload de
 * notificação, o SDK do FCM no Service Worker exibe a notificação
 * AUTOMATICAMENTE (sem visible client) E ainda invoca o nosso
 * `onBackgroundMessage` — que também exibe. Duas bolhas do mesmo evento no
 * SO. Com payload data-only o SDK nunca auto-exibe: só o nosso handler
 * decide (e ele já sabe silenciar quando há janela aberta).
 */
export interface PushPayloadInput {
  title: string;
  body: string;
  /** Id da notificação — usado como `tag` (agrupa/substitui no SO). */
  notificationId: string;
  /** DadosExtras levados ao Service Worker no clique (url, partyId, type…). */
  data?: Record<string, string>;
}

export interface PushSendResult {
  token: string;
  success: boolean;
  errorCode?: string;
}

/**
 * FILTRO PURO (testável): dado os tokens enviados e as respostas do FCM,
 * separa os que continuam válidos dos que devem ser descartados.
 *
 * Remove apenas erros definitivos de subscription:
 *   • UNREGISTERED — subscription expirada/removida pelo navegador;
 *   • INVALID_ARGUMENT — token malformado (corrompido no armazenamento);
 *   • SENDER_ID_MISMATCH / UNAVAILABLE? NÃO: o primeiro é de configuração
 *     (mantém o token para diagnóstico) e o segundo é transitório (o FCM
 *     pede retry — o token continua bom).
 * Erros desconhecidos NÃO removem o token: um bug de parsing nunca deve
 * apagar as subscriptions de um usuário.
 */
export function filterValidTokens(tokens: string[], results: PushSendResult[]): { valid: string[]; invalid: string[] } {
  const byToken = new Map<string, PushSendResult>();
  results.forEach(result => byToken.set(result.token, result));
  const valid: string[] = [];
  const invalid: string[] = [];
  tokens.forEach(token => {
    const result = byToken.get(token);
    if (!result) {
      // Sem resposta individual (ex: falha total do lote) — mantém o token.
      valid.push(token);
      return;
    }
    if (result.success) {
      valid.push(token);
      return;
    }
    const code = String(result.errorCode || "");
    if (code === "UNREGISTERED" || code === "INVALID_ARGUMENT") {
      invalid.push(token);
      return;
    }
    valid.push(token);
  });
  return { valid, invalid };
}

function normalizeTokens(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(token => String(token || "").trim())
    .filter(token => token.length > 0);
}

/**
 * Envia push para TODOS os dispositivos cadastrados do usuário.
 * Nunca lança para o chamador — push é sempre acessório: se falhar, a
 * notificação persistida no Firestore continua sendo entregue pelo listener
 * do app aberto e pelo histórico ao reabrir.
 */
export async function sendPushToUser(uid: string, payload: PushPayloadInput): Promise<void> {
  const targetUid = String(uid || "").trim();
  if (!targetUid) return;

  let tokens: string[] = [];
  try {
    const snap = await getFirestore().collection(PUSH_TOKENS_COLLECTION).doc(targetUid).get();
    if (!snap.exists) return;
    tokens = normalizeTokens(snap.data()?.tokens);
  } catch (error) {
    logger.warn("Falha ao ler tokens de push", { uid: targetUid, error: String(error) });
    return;
  }
  if (tokens.length === 0) return;

  const message = {
    // DATA-ONLY: sem campo `notification` o SDK do FCM NÃO auto-exibe nada
    // (ver comentário da interface) — quem exibe é o nosso Service Worker,
    // exatamente uma vez, com tag = id da notificação.
    data: {
      notificationId: payload.notificationId,
      notificationTitle: payload.title,
      notificationBody: payload.body,
      ...(payload.data || {}),
    },
    android: { priority: "high" as const },
    webpush: {
      headers: { Urgency: "high" },
    },
    tokens,
  };

  try {
    const response = await getMessaging().sendEachForMulticast(message);
    const results: PushSendResult[] = response.responses.map((item, index) => ({
      token: tokens[index],
      success: item.success,
      errorCode: item.error ? item.error.code : undefined,
    }));
    const { invalid } = filterValidTokens(tokens, results);
    if (invalid.length > 0) {
      // Limpeza cirúrgica: remove APENAS os tokens que o FCM rejeitou de
      // forma definitiva. Os demais dispositivos do usuário continuam
      // recebendo normalmente.
      await getFirestore().collection(PUSH_TOKENS_COLLECTION).doc(targetUid).update({
        tokens: FieldValue.arrayRemove(...invalid),
        updatedAt: FieldValue.serverTimestamp(),
      }).catch(() => undefined);
      logger.info("Tokens de push inválidos removidos", { uid: targetUid, removed: invalid.length });
    }
    const failures = response.failureCount || 0;
    if (failures > 0) {
      logger.info("Push parcial", { uid: targetUid, failures, total: tokens.length });
    }
  } catch (error) {
    logger.warn("Falha ao enviar push", { uid: targetUid, error: String(error) });
  }
}