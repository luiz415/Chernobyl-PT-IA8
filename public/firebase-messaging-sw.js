// ============================================================================
// SERVICE WORKER — Notificações Desktop via Web Push (FCM)
// ============================================================================
//
// Responsável por exibir as notificações quando a ABA DO APLICATIVO ESTÁ
// FECHADA (navegador aberto). Este arquivo vive FORA do bundle React: ele é
// carregado e gerenciado pelo navegador, independente do app estar aberto.
//
// Fluxo completo:
//   Evento (outra pessoa, Cloud Function ou watcher agendado)
//     → documento criado em `notifications` no Firestore
//     → Cloud Function `notificationPushTrigger` (onDocumentCreated)
//     → FCM entrega o push para todos os dispositivos do usuário
//     → [aba aberta]  o listener do Firestore exibe na hora — e este SW
//                      PERCEBE a existência do cliente e NÃO exibe a dele
//                      (anti-duplicidade);
//     → [aba fechada] este SW exibe a notificação do sistema.
//
// Configuração: o app registra este SW anexando a config do Firebase na query
// string (public/firebase-messaging-sw.js?apiKey=…&projectId=…), pois o
// arquivo é estático e não tem acesso às variáveis de ambiente do Vite.
//
// Clique na notificação: foca a janela do app (ou abre) — sem depender do
// React estar carregado.
// ============================================================================

/* eslint-disable no-undef */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getMessaging, onBackgroundMessage } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-sw.js";

const params = new URL(self.location.href).searchParams;
const firebaseConfig = {
  apiKey: params.get("apiKey") || "",
  projectId: params.get("projectId") || "",
  messagingSenderId: params.get("messagingSenderId") || "",
  appId: params.get("appId") || "",
};

initializeApp(firebaseConfig);

const APP_ICON = "/favicon.png";

/**
 * Existem janelas do app abertas (mesmo em segundo plano/minimizadas)?
 * Se sim, o listener do Firestore da própria página exibe a notificação em
 * tempo real — mostrar aqui DUPLICARIA. Só exibimos quando não há cliente
 * algum (aba fechada / app fechado com o navegador rodando).
 */
async function hasWindowClients() {
  const clientList = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  return clientList.length > 0;
}

function showNotification(payload) {
  const title = payload.notification?.title || payload.data?.notificationTitle || "Chernobyl";
  const body = payload.notification?.body || payload.data?.notificationBody || "";
  const notificationId = payload.data?.notificationId || `push_${Date.now()}`;
  const options = {
    body,
    icon: APP_ICON,
    badge: APP_ICON,
    // `tag` = id da notificação: o SO agrupa/substitui — um reenvio do mesmo
    // evento substitui a bolha anterior em vez de empilhar.
    tag: notificationId,
    data: payload.data || {},
    requireInteraction: false,
  };
  return self.registration.showNotification(title, options);
}

// ── Push em BACKGROUND (aba fechada ou navegador em segundo plano) ──────────
// AUTORIDADE ÚNICA DE EXIBIÇÃO: o backend envia payloads DATA-ONLY (sem
// campo `notification`), então o SDK do FCM NUNCA auto-exibe — só este
// handler mostra notificação. Isso elimina a duplicidade clássica do FCM
// (SDK auto-exibindo + handler exibindo = 2 bolhas do mesmo evento).
onBackgroundMessage(getMessaging(), async payload => {
  try {
    if (await hasWindowClients()) return; // o app aberto exibe por conta própria
    await showNotification(payload);
  } catch (error) {
    // Nunca deixar o handler morrer — push é acessório.
    console.warn("[sw] falha ao exibir notificação:", error);
  }
});

// ── Fallback: evento `push` cru (mensagens sem payload de notificação) ─────
self.addEventListener("push", event => {
  if (!event.data) return;
  try {
    const payload = event.data.json();
    if (payload && payload.notification) {
      event.waitUntil(
        (async () => {
          try {
            if (await hasWindowClients()) return;
            await showNotification(payload);
          } catch {}
        })(),
      );
    }
  } catch {}
});

// ── Clique na notificação: foca/abre o app ──────────────────────────────────
self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      // Janela já aberta → foca (o app navega para o destino se o usuário
      // pedir de novo; focar é o comportamento esperado do SO).
      for (const client of clientList) {
        if ("focus" in client) {
          try {
            await client.focus();
            if ("postMessage" in client && event.notification.data) {
              client.postMessage({ type: "push-notification-click", data: event.notification.data });
            }
            return;
          } catch {}
        }
      }
      // Sem janela → abre o app na raiz (o hash router leva ao Hub).
      await self.clients.openWindow("/");
    })(),
  );
});