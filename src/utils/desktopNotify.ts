// ============================================================================
// FILTRO DE SESSÃO — Notificações Desktop
// ============================================================================
// Garante que APENAS notificações geradas APÓS o login sejam exibidas
// no desktop. Notificações antigas (acumuladas com o app fechado) são
// ignoradas PARA SEMPRE — não basta um delay, elas nunca devem aparecer.
//
// Três camadas de proteção:
//   1. COMPARAÇÃO POR TIMESTAMP: se a notificação tem `createdAt` anterior
//      ao início da sessão, é ignorada definitivamente.
//   2. GRACE PERIOD: nos primeiros 5s após o módulo carregar, nenhuma
//      notificação SEM timestamp é exibida (cobre o "pico" de pendentes
//      sem createdAt que disparam ao logar).
//   3. BLOQUEIO DEFINITIVO DE NOTIFS SEM CREATEDAT após o grace period:
//      notificações sem `createdAt` são SEMPRE ignoradas (caso de borda).
// ============================================================================

let sessionStartTime = Date.now();

const electronNotificationCallbacks = new Map<string, () => void>();
let electronNotificationListenerReady = false;

function ensureElectronNotificationListener() {
  if (electronNotificationListenerReady || typeof window === "undefined") return;
  try {
    const electronRequire = (window as any).require;
    if (!electronRequire) return;
    const { ipcRenderer } = electronRequire("electron");
    ipcRenderer.on("desktop-notification-click", (_event: unknown, payload: { actionId?: string }) => {
      const actionId = payload?.actionId || "";
      const callback = electronNotificationCallbacks.get(actionId);
      if (callback) {
        electronNotificationCallbacks.delete(actionId);
        callback();
      }
    });
    electronNotificationListenerReady = true;
  } catch {}
}

const GRACE_PERIOD_MS = 5000; // 5 segundos

// Chamar esta função no momento do login para definir o marco da sessão.
// Todas as notificações com createdAt ANTES deste instante serão ignoradas.
export function markSessionStart(): void {
  sessionStartTime = Date.now();
}

function showRendererNotification(title: string, body: string, tag: string, onClick?: () => void) {
  if (!("Notification" in window)) return;
  try {
    const notif = new window.Notification(title, { body, tag, requireInteraction: false });
    if (onClick) {
      notif.onclick = (event) => {
        try { event.preventDefault(); } catch {}
        try { window.focus(); } catch {}
        onClick();
        try { notif.close(); } catch {}
      };
    }
  } catch {}
}

export function sendDesktopNotification(
  title: string,
  body: string,
  onClick?: () => void,
  createdAt?: number,
  tag?: string,
): void {
  if (typeof window === "undefined") return;

  const hasElectron = !!(window as any).require;

  // No Electron e na Web, a notificação pode ser exibida mesmo com o app aberto.
  // A deduplicação é feita por id/tag no fluxo de notificações, não por foco de janela.

  // FILTRO 1 — Timestamp anterior ao login → ignorada PARA SEMPRE
  if (typeof createdAt === "number" && createdAt < sessionStartTime) {
    return;
  }

  // FILTRO 2 — Notificação SEM createdAt: só permitir APÓS o grace period
  if (typeof createdAt !== "number") {
    if (Date.now() - sessionStartTime < GRACE_PERIOD_MS) {
      return; // ainda estamos no período de carência
    }
  }

  // FILTRO 3 — Notificação COM createdAt mas ainda dentro do grace period
  // (não deveria acontecer, mas como defesa extra)
  if (Date.now() - sessionStartTime < GRACE_PERIOD_MS) {
    return;
  }

  // Tag da notificação: o ID da notificação quando disponível (ESTÁVEL) —
  // com várias abas do app abertas, cada aba exibe a própria bolha do SO,
  // e o SO SUBSTITUI a anterior de mesma tag em vez de empilhar duas
  // notificações idênticas do mesmo evento. Fallback: tag aleatória.
  const notificationTag = (tag && tag.trim()) || `chernobyl_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  if (hasElectron) {
    try {
      ensureElectronNotificationListener();
      const { ipcRenderer } = (window as any).require("electron");
      const actionId = notificationTag;
      if (onClick) electronNotificationCallbacks.set(actionId, onClick);
      ipcRenderer.invoke("show-desktop-notification", { title, body, actionId }).then((result: { ok?: boolean } | undefined) => {
        if (!result?.ok) {
          if (onClick) electronNotificationCallbacks.delete(actionId);
          showRendererNotification(title, body, notificationTag, onClick);
        }
      }).catch(() => {
        if (onClick) electronNotificationCallbacks.delete(actionId);
        showRendererNotification(title, body, notificationTag, onClick);
      });
      return;
    } catch (_) {
      showRendererNotification(title, body, notificationTag, onClick);
      return;
    }
  }

  if ("Notification" in window && window.Notification.permission === "granted") {
    showRendererNotification(title, body, notificationTag, onClick);
  }
}

export async function checkPermission(): Promise<boolean> {
  if (typeof window === "undefined" || !("Notification" in window)) return false;
  if (window.Notification.permission === "granted") return true;
  if (window.Notification.permission !== "denied") {
    try {
      const perm = await window.Notification.requestPermission();
      return perm === "granted";
    } catch (_) {
      return false;
    }
  }
  return false;
}