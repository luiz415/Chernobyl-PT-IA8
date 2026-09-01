import {
  collectDueEndingAlerts,
  endingAlertSentKey,
  type EndingAuctionInput,
} from "../utils/bazaarEndingAlerts";
import { readBazarNotifyMinutes, readBazarTimezoneOffsetMinutes } from "../utils/bazaarTime";

// ============================================================================
// ALERTAS DE ENCERRAMENTO DO BAZAAR — AGENDADOR LOCAL DO DISPOSITIVO.
// ============================================================================
//
// Sucessor direto do `bazaarInterestNotificationService.ts` original (o
// `setTimeout` dentro do painel), com os defeitos corrigidos:
//
//   ANTES (pré-Cloud Function): um `setTimeout` ÚNICO e longo por leilão. Em
//   aba oculta o Chrome estrangula congela timers — o disparo ficava preso
//   até a aba voltar a ficar visível; e a fila só existia com o PAINEL aberto.
//
//   AGORA: uma varredura leve a cada 60s (o intervalo sobrevive ao throttle
//   do Chrome, que reduz para ~1 disparo/minuto — exatamente a granularidade
//   do alerta) + despertar IMEDIATO em visibilitychange/focus (recupera o
//   caso de aba congelada: ao voltar, dispara na hora o que venceu) + fila
//   alimentada pelo cache oficial local (funciona com o painel fechado, só
//   com o app aberto) + registro persistido por versão da consulta (reinício
//   do app não refire alertas da mesma consulta).
//
// Onde cada peça vive:
//   • interesses (visão de todos): `bazaarInterests/current` no Firestore
//     (o painel sincroniza; o agregado é zerado a cada nova consulta);
//   • antecedência/fuso: localStorage (preferências do Bazaar);
//   • o alerta em si: AQUI, no dispositivo — nada de Cloud Function por
//     usuário/leilão. A exibição usa o mesmo caminho das demais
//     notificações (CustomEvent → hook `useNotifications` → centro/som/
//     desktop/IPC), então preferências, dedup por id e clique/navegação
//     funcionam sem código extra.
// ============================================================================

/** Registro local "já alertei este leilão nesta consulta" (por dispositivo). */
const SENT_STORE_KEY = "rubinot_bazaar_ending_alerts";
const SENT_STORE_SCHEMA = 1;
const SENT_STORE_LIMIT = 200;

/** Varredura a cada 60s — granularidade do alerta (o painel trabalha em minutos). */
const SWEEP_INTERVAL_MS = 60 * 1000;

interface SentStore {
  schemaVersion: number;
  bazaarVersion: string;
  sent: Record<string, number>;
}

interface QueueSnapshot {
  characters: EndingAuctionInput[];
  interestedAuctionIds: Set<string>;
  currentUserUid: string;
  bazaarVersion: string;
}

let queue: QueueSnapshot | null = null;
let sweepTimer: number | null = null;
let wakeBound = false;
let storeCache: SentStore | null = null;

function readStore(bazaarVersion: string): SentStore {
  if (storeCache && storeCache.bazaarVersion === bazaarVersion) return storeCache;
  try {
    const raw = localStorage.getItem(SENT_STORE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    storeCache = parsed && parsed.schemaVersion === SENT_STORE_SCHEMA && parsed.bazaarVersion === bazaarVersion
      ? { schemaVersion: SENT_STORE_SCHEMA, bazaarVersion, sent: parsed.sent || {} }
      : { schemaVersion: SENT_STORE_SCHEMA, bazaarVersion, sent: {} };
  } catch {
    storeCache = { schemaVersion: SENT_STORE_SCHEMA, bazaarVersion, sent: {} };
  }
  return storeCache;
}

function writeStore(store: SentStore): void {
  try {
    localStorage.setItem(SENT_STORE_KEY, JSON.stringify(store));
  } catch {}
}

function clearTimer(): void {
  if (sweepTimer !== null) {
    window.clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

function dispatchAlert(alert: ReturnType<typeof collectDueEndingAlerts>[number], createdAtMs: number): void {
  const payload = {
    id: alert.notificationId,
    type: "bazaar_interest_ending",
    title: alert.title,
    body: alert.body,
    createdAt: createdAtMs,
    scheduledTime: alert.auctionEndMs,
    auctionId: alert.auctionId,
    url: alert.url,
  };
  try {
    // Caminho principal: entra no centro de notificações pelo hook do App —
    // o mesmo gate de preferências, som, notificação desktop e roteamento de
    // clique de TODAS as notificações.
    window.dispatchEvent(new CustomEvent("bazaar-interest-notification-center", { detail: payload }));
  } catch {}
  try {
    // Chip/atalho no painel do Bazar (independe das preferências, igual ao
    // comportamento original do painel).
    window.dispatchEvent(new CustomEvent("bazaar-interest-local-notification", {
      detail: {
        id: alert.notificationId,
        title: alert.title,
        body: alert.body,
        url: alert.url,
        auctionId: alert.auctionId,
        expiresAtMs: alert.auctionEndMs,
      },
    }));
  } catch {}
}

/**
 * Varredura: coleta e dispara os alertas vencidos.
 *
 * A antecedência e o fuso são relidos A CADA varredura — alterar no painel
 * vale no minuto seguinte, sem reconstruir fila nem reagendar nada.
 */
function sweep(): void {
  if (!queue || !queue.currentUserUid) return;
  const store = readStore(queue.bazaarVersion);
  const nowMs = Date.now();
  const due = collectDueEndingAlerts({
    nowMs,
    notifyMinutes: readBazarNotifyMinutes(),
    timezoneOffsetMinutes: readBazarTimezoneOffsetMinutes(),
    uid: queue.currentUserUid,
    characters: queue.characters,
    interestedAuctionIds: queue.interestedAuctionIds,
    sentKeys: new Set(Object.keys(store.sent)),
  });
  due.forEach(alert => {
    // Marca ANTES de despachar: o registro é síncrono no localStorage, então
    // outra aba/tick enxerga o alerta como já feito (janela de corrida mínima).
    store.sent[alert.sentKey] = nowMs;
    dispatchAlert(alert, nowMs);
  });
  if (due.length > 0) {
    // Compacta: mantém os registros mais recentes (chaves antigas sobram
    // quando a consulta rotaciona de qualquer forma — versão nova zera tudo).
    const entries = Object.entries(store.sent)
      .sort(([, a], [, b]) => b - a)
      .slice(0, SENT_STORE_LIMIT);
    store.sent = Object.fromEntries(entries);
    writeStore(store);
  }
}

function ensureSweeper(): void {
  if (sweepTimer !== null) return;
  sweepTimer = window.setInterval(sweep, SWEEP_INTERVAL_MS);
  if (!wakeBound) {
    wakeBound = true;
    // Aba congelada pelo navegador (Idle extremo/economia de bateria): os
    // timers podem ter parado — ao VOLTAR, varre imediatamente o que venceu.
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") sweep(); });
    window.addEventListener("focus", sweep);
    window.addEventListener("online", sweep);
  }
}

export interface SyncEndingAlertsInput {
  /** Lista oficial (cache local ou recém-publicada). */
  characters: EndingAuctionInput[];
  /** Interesses de TODOS os usuários (mapa por id do leilão). */
  interestsByAuctionId: Record<string, { uid: string; name?: string; createdAtMs?: number }[]>;
  currentUserUid: string;
  bazaarVersion: string;
}

/**
 * (Re)alimenta a fila de alertas com o estado atual da consulta.
 * Chamado: no boot do App (cache local), ao carregar a lista oficial no
 * painel, ao marcar/desmarcar interesse e ao publicar nova consulta.
 * Versão da consulta diferente → registro de alertas enviados zera sozinho.
 */
export function syncBazaarEndingAlerts(input: SyncEndingAlertsInput): void {
  const uid = String(input?.currentUserUid || "").trim();
  const version = String(input?.bazaarVersion || "").trim();
  if (!uid || !version || !Array.isArray(input?.characters)) {
    queue = null;
    clearTimer();
    return;
  }
  const interested = new Set<string>();
  Object.entries(input.interestsByAuctionId || {}).forEach(([auctionId, entries]) => {
    if ((entries || []).some(entry => String(entry?.uid || "") === uid)) interested.add(auctionId);
  });
  queue = { characters: input.characters, interestedAuctionIds: interested, currentUserUid: uid, bazaarVersion: version };
  // Poda os registros da versão anterior: consulta nova, alertas zerados.
  readStore(version);
  ensureSweeper();
  sweep();
}

/** Para o agendador (logout/troca de usuário). */
export function stopBazaarEndingAlerts(): void {
  queue = null;
  clearTimer();
}

/** Chave de registro exposta para testes/compatibilidade. */
export { endingAlertSentKey };