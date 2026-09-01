import { arrayRemove, arrayUnion, doc, getDoc, serverTimestamp, setDoc, updateDoc } from "firebase/firestore";
import type { FirebaseApp } from "firebase/app";
import { getMessaging, getToken, isSupported, onRegistered } from "firebase/messaging";
import appDefault, { db, isSimulationMode } from "../firebase/config";

// ============================================================================
// WEB PUSH (FCM) — registro de tokens do dispositivo do usuário.
// ============================================================================
//
// Toda notificação persistida em `notifications` dispara o push pela Cloud
// Function `notificationPushTrigger`. Este serviço cuida da PONTE LOCAL:
//
//   1. Registra o Service Worker (public/firebase-messaging-sw.js) com a
//      config do Firebase anexada na query string (o SW é estático e não tem
//      acesso às variáveis de ambiente do Vite);
//   2. Obtém o token FCM do dispositivo/navegador (com chave VAPID);
//   3. Grava o token em `pushTokens/{uid}` — um documento por usuário com a
//      lista de tokens de TODOS os seus dispositivos (múltiplos dispositivos
//      recebem simultaneamente; tokens inválidos são removidos pelo próprio
//      backend a partir da resposta do FCM);
//   4. Renova o token automaticamente (onTokenRefresh) — o navegador pode
//      trocar a subscription (rotação periódica, mudança de permissão).
//
// O app NÃO exibe push no primeiro plano: com o app aberto (visível ou em
// segundo plano), quem exibe é o listener do Firestore — o Service Worker
// detecta a existência de uma janela aberta e fica em silêncio. Push existe
// para a aba fechada.
//
// Tudo aqui é silencioso por design: push é acessório, jamais bloqueia o app.
// ============================================================================

/**
 * Chave pública VAPID (P-256). Usada apenas no registro da subscription — o
 * envio é feito pelo FCM via Cloud Function, que não precisa da chave
 * privada. Substituível sem quebrar as subscriptions existentes? NÃO: trocar
 * a chave invalida os tokens atuais (eles são re-registrados no próximo
//  login/auto-refresh pelo onTokenRefresh e pela re-execução do registro).
 */
export const PUSH_VAPID_PUBLIC_KEY =
  "BO9bcOCd2QzOeJZYSx0tca7LrOHSVpw77uKrTE2uyoTgV2Z8ST8tsjlAG1Dvl0SHDqcGCcIDuqKREZJkXpZEctY";

const app = appDefault as FirebaseApp;

const PUSH_TOKENS_COLLECTION = "pushTokens";

let registrationPromise: Promise<ServiceWorkerRegistration | null> | null = null;
let refreshListenerBound = false;

function isPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "Notification" in window &&
    !isSimulationMode
  );
}

/**
 * Estamos rodando no app Electron (instalado)?
 *
 * O Electron carrega a página via `file://` — nesse protocolo o navegador
 * NÃO registra Service Worker, então o Web Push/FCM não existe no Electron:
 * `registerPushForUser` desiste rápido (sem tentativa inútil de SW), e a
 * entrega lá é feita pelo LISTENER do Firestore + Notificação nativa via IPC
 * (`show-desktop-notification`), que funciona com a janela aberta,
 * minimizada ou na BANDEJA (backgroundThrottling desligado no main).
 */
export function isElectronEnvironment(): boolean {
  return typeof window !== "undefined" && !!(window as unknown as { require?: unknown }).require;
}

function swUrlWithConfig(): string {
  if (!app) return "/firebase-messaging-sw.js";
  const config = app.options as Record<string, string>;
  const params = new URLSearchParams({
    apiKey: config.apiKey || "",
    projectId: config.projectId || "",
    messagingSenderId: config.messagingSenderId || "",
    appId: config.appId || "",
  });
  return `/firebase-messaging-sw.js?${params.toString()}`;
}

async function ensureServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!isPushSupported()) return null;
  if (!registrationPromise) {
    registrationPromise = navigator.serviceWorker
      .register(swUrlWithConfig(), { scope: "/" })
      .catch(() => null);
  }
  return registrationPromise;
}

/**
 * Último token conhecido DESTE dispositivo — persistido localmente para que a
 * rotação (o navegador troca a subscription de tempos em tempos) REMOVA o
 * token anterior do array. Sem isso, o mesmo dispositivo acumulava dois
 * tokens válidos e recebia o mesmo push DUAS vezes (mesmo app, mesmo SO).
 */
const LAST_DEVICE_TOKEN_KEY = "tibia_push_last_device_token";

function readLastDeviceToken(): string {
  try {
    return String(localStorage.getItem(LAST_DEVICE_TOKEN_KEY) || "");
  } catch {
    return "";
  }
}

function writeLastDeviceToken(token: string): void {
  try {
    localStorage.setItem(LAST_DEVICE_TOKEN_KEY, token);
  } catch {}
}

async function saveToken(uid: string, token: string): Promise<void> {
  const ref = doc(db, PUSH_TOKENS_COLLECTION, uid);
  const previousToken = readLastDeviceToken();
  const snap = await getDoc(ref).catch(() => null);
  if (!snap || !snap.exists()) {
    await setDoc(ref, {
      tokens: [token],
      updatedAt: serverTimestamp(),
    }).catch(() => undefined);
    writeLastDeviceToken(token);
    return;
  }
  // Rotação: remove o token ANTERIOR deste dispositivo antes de adicionar o
  // novo — cada update aceita um único transform de array por campo, então
  // são duas escritas best-effort (a segunda é a que importa).
  if (previousToken && previousToken !== token) {
    await updateDoc(ref, {
      tokens: arrayRemove(previousToken),
      updatedAt: serverTimestamp(),
    }).catch(() => undefined);
  }
  await updateDoc(ref, {
    tokens: arrayUnion(token),
    updatedAt: serverTimestamp(),
  }).catch(async () => {
    // Documento removido concorrentemente — recria.
    await setDoc(ref, {
      tokens: [token],
      updatedAt: serverTimestamp(),
    }).catch(() => undefined);
  });
  writeLastDeviceToken(token);
}

/**
 * Registra o push para o usuário logado neste dispositivo.
 * Silencioso: qualquer falha (permissão negada, navegador sem suporte,
 * Firestore indisponível) apenas desiste — a notificação continua chegando
 * pelo listener do app aberto.
 */
export async function registerPushForUser(uid: string): Promise<boolean> {
  const targetUid = String(uid || "").trim();
  if (!targetUid || !isPushSupported()) return false;
  // Electron (file://) não tem Service Worker → não há token FCM para
  // registrar. A entrega no Electron é coberta pelo listener + IPC nativo.
  if (isElectronEnvironment()) return false;
  // Sem permissão concedida não há push — o pedido acontece em contexto de
  // gesto do usuário via `ensurePushRegistration` (modal de notificações).
  if (window.Notification.permission !== "granted") return false;

  try {
    if (!(await isSupported())) return false;
    const registration = await ensureServiceWorker();
    if (!registration) return false;

    const messaging = getMessaging(app);
    const token = await getToken(messaging, {
      vapidKey: PUSH_VAPID_PUBLIC_KEY,
      serviceWorkerRegistration: registration,
    });
    if (!token) return false;

    await saveToken(targetUid, token);
    bindTokenRefresh(targetUid);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pede a permissão de notificação (em contexto de GESTO do usuário — o
 * clique no toggle do modal) e, concedida a permissão, REGISTRA O TOKEN na
 * hora. Fecha o buraco em que o usuário concedia a permissão DEPOIS do
 * login e o token só seria registrado na sessão seguinte.
 *
 * Retorna o estado final da permissão ("granted" | "denied" | "default"),
 * para a UI poder avisar quando o navegador está bloqueando as notificações
 * — sem esse feedback a permissão negada era uma perda SILENCIOSA (nenhum
 * aviso chegava, nem com o app aberto).
 */
export async function ensurePushRegistration(uid: string): Promise<"granted" | "denied" | "default"> {
  const targetUid = String(uid || "").trim();
  if (typeof window === "undefined" || !("Notification" in window)) return "denied";
  try {
    if (window.Notification.permission !== "granted" && window.Notification.permission !== "denied") {
      await window.Notification.requestPermission();
    }
  } catch { /* segue com o estado atual */ }
  const permission = window.Notification.permission === "granted" ? "granted"
    : window.Notification.permission === "denied" ? "denied"
    : "default";
  if (permission === "granted" && targetUid && !isElectronEnvironment()) {
    void registerPushForUser(targetUid);
  }
  return permission;
}

/**
 * Renovação de token — o navegador troca a subscription de tempos em tempos
 * (rotação, mudança de permissão). Firebase 12: `onRegistered` entrega o
 * novo token assim que ele é (re)emitido.
 */
function bindTokenRefresh(uid: string): void {
  if (refreshListenerBound) return;
  refreshListenerBound = true;
  try {
    const messaging = getMessaging(app);
    onRegistered(messaging, (token: string) => {
      void saveToken(uid, String(token || "")).catch(() => undefined);
    });
  } catch {}
}

/** Remove o token DESTE dispositivo (logout) — os demais seguem intactos. */
export async function unregisterPushForUser(uid: string): Promise<void> {
  const targetUid = String(uid || "").trim();
  if (!targetUid || !isPushSupported()) return;
  if (isElectronEnvironment()) return; // file:// → nunca houve token FCM aqui
  try {
    if (!(await isSupported())) return;
    const registration = await ensureServiceWorker();
    if (!registration) return;
    const messaging = getMessaging(app);
    const token = await getToken(messaging, {
      vapidKey: PUSH_VAPID_PUBLIC_KEY,
      serviceWorkerRegistration: registration,
    });
    if (!token) return;
    await updateDoc(doc(db, PUSH_TOKENS_COLLECTION, targetUid), {
      tokens: arrayRemove(token),
      updatedAt: serverTimestamp(),
    }).catch(() => undefined);
    writeLastDeviceToken("");
  } catch {}
}

/**
 * Clique em notificação do SO com o app fechado → o SW abriu/focou a janela e
 * avisou por postMessage. Devolve os dados para o roteador de notificações
 * decidir o destino (mesmo mapa do clique no app).
 */
export function listenPushNotificationClicks(handler: (data: Record<string, unknown>) => void): () => void {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return () => {};
  function onMessage(event: MessageEvent) {
    const data = (event.data || {}) as { type?: string; data?: Record<string, unknown> };
    if (data && data.type === "push-notification-click" && data.data) {
      handler(data.data);
    }
  }
  navigator.serviceWorker.addEventListener("message", onMessage);
  return () => navigator.serviceWorker.removeEventListener("message", onMessage);
}