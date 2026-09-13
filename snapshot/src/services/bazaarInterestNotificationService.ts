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
/**
 * Registro equivalente do painel "Personagens com Itens" — SEPARADO do das
 * quests: as duas consultas rotacionam de forma independente (versões
 * diferentes), então cada fila tem o seu próprio anti-redisparo.
 */
const ITEMS_SENT_STORE_KEY = "rubinot_bazaar_items_ending_alerts";
const SENT_STORE_SCHEMA = 1;
const SENT_STORE_LIMIT = 200;

/**
 * Prefixo do id das notificações do painel de ITENS. O núcleo puro gera
 * `bazaar_ending_{leilao}_{fim}_{uid}`; o mesmo personagem pode estar marcado
 * como interesse nos DOIS painéis ao mesmo tempo — sem prefixo próprio, o
 * dedup por id do centro de notificações engoliria um dos dois alertas.
 */
const ITEMS_ALERT_ID_PREFIX = "bazaar_items_ending_";

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

/**
 * CANAL DE ALERTAS — uma fila independente por painel.
 *
 * O serviço nasceu com UMA fila (quests). O painel "Personagens com Itens"
 * precisa das MESMAS notificações, mas alimentado por outra consulta (local)
 * e outro conjunto de interesses (local). Se os dois painéis compartilhassem
 * a fila, o último `sync` SOBRESCREVERIA o do outro. Cada canal tem a sua
 * fila, o seu registro anti-redisparo e o seu prefixo de id; a varredura, o
 * timer e os despertadores (visibility/focus/online) são compartilhados —
 * uma única varredura percorre os dois canais.
 */
interface AlertChannel {
  /** Chave do registro "já alertei" no localStorage (uma por canal). */
  storeKey: string;
  /** Prefixo aplicado ao id da notificação ("" = convenção original das quests). */
  idPrefix: string;
  queue: QueueSnapshot | null;
  storeCache: SentStore | null;
}

const questsChannel: AlertChannel = { storeKey: SENT_STORE_KEY, idPrefix: "", queue: null, storeCache: null };
const itemsChannel: AlertChannel = { storeKey: ITEMS_SENT_STORE_KEY, idPrefix: ITEMS_ALERT_ID_PREFIX, queue: null, storeCache: null };
const channels: AlertChannel[] = [questsChannel, itemsChannel];

let sweepTimer: number | null = null;
let wakeBound = false;

function readStore(channel: AlertChannel, bazaarVersion: string): SentStore {
  if (channel.storeCache && channel.storeCache.bazaarVersion === bazaarVersion) return channel.storeCache;
  try {
    const raw = localStorage.getItem(channel.storeKey);
    const parsed = raw ? JSON.parse(raw) : null;
    channel.storeCache = parsed && parsed.schemaVersion === SENT_STORE_SCHEMA && parsed.bazaarVersion === bazaarVersion
      ? { schemaVersion: SENT_STORE_SCHEMA, bazaarVersion, sent: parsed.sent || {} }
      : { schemaVersion: SENT_STORE_SCHEMA, bazaarVersion, sent: {} };
  } catch {
    channel.storeCache = { schemaVersion: SENT_STORE_SCHEMA, bazaarVersion, sent: {} };
  }
  return channel.storeCache;
}

function writeStore(channel: AlertChannel, store: SentStore): void {
  try {
    localStorage.setItem(channel.storeKey, JSON.stringify(store));
  } catch {}
}

function clearTimerIfIdle(): void {
  if (sweepTimer !== null && channels.every(channel => channel.queue === null)) {
    window.clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

function dispatchAlert(alert: ReturnType<typeof collectDueEndingAlerts>[number], createdAtMs: number, idPrefix: string): void {
  // Prefixo por canal: o MESMO leilão pode ser interesse nos dois painéis ao
  // mesmo tempo — ids distintos garantem que o dedup do centro não engula um
  // dos alertas. Tipo, formato e caminho de entrega são IDÊNTICOS. O id do
  // canal de itens preserva a estrutura `{leilao}_{fim}_{uid}` do núcleo,
  // trocando apenas o prefixo ("bazaar_ending_" → "bazaar_items_ending_").
  const notificationId = idPrefix
    ? alert.notificationId.replace(/^bazaar_ending_/, idPrefix)
    : alert.notificationId;
  const payload = {
    id: notificationId,
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
        id: notificationId,
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
 * Varredura de UM canal: coleta e dispara os alertas vencidos.
 *
 * A antecedência e o fuso são relidos A CADA varredura — alterar no painel
 * vale no minuto seguinte, sem reconstruir fila nem reagendar nada.
 */
function sweepChannel(channel: AlertChannel): void {
  const queue = channel.queue;
  if (!queue || !queue.currentUserUid) return;
  const store = readStore(channel, queue.bazaarVersion);
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
    dispatchAlert(alert, nowMs, channel.idPrefix);
  });
  if (due.length > 0) {
    // Compacta: mantém os registros mais recentes (chaves antigas sobram
    // quando a consulta rotaciona de qualquer forma — versão nova zera tudo).
    const entries = Object.entries(store.sent)
      .sort(([, a], [, b]) => b - a)
      .slice(0, SENT_STORE_LIMIT);
    store.sent = Object.fromEntries(entries);
    writeStore(channel, store);
  }
}

/** Varredura completa: percorre os dois canais (quests e itens). */
function sweep(): void {
  channels.forEach(sweepChannel);
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
    questsChannel.queue = null;
    clearTimerIfIdle();
    return;
  }
  const interested = new Set<string>();
  Object.entries(input.interestsByAuctionId || {}).forEach(([auctionId, entries]) => {
    if ((entries || []).some(entry => String(entry?.uid || "") === uid)) interested.add(auctionId);
  });
  questsChannel.queue = { characters: input.characters, interestedAuctionIds: interested, currentUserUid: uid, bazaarVersion: version };
  // Poda os registros da versão anterior: consulta nova, alertas zerados.
  readStore(questsChannel, version);
  ensureSweeper();
  sweepChannel(questsChannel);
}

export interface SyncItemsEndingAlertsInput {
  /** Resultados da última consulta LOCAL do painel de itens. */
  characters: EndingAuctionInput[];
  /** Ids de leilão marcados como interesse (armazenamento LOCAL do painel de itens). */
  interestedAuctionIds: string[] | Set<string>;
  currentUserUid: string;
  /**
   * Versão da consulta de itens (ex.: `items_{completedAtMs}`) — consulta
   * nova zera o registro anti-redisparo, como no painel de quests.
   */
  bazaarVersion: string;
}

/**
 * (Re)alimenta a fila de alertas do painel "Personagens com Itens".
 *
 * MESMO mecanismo das quests (varredura compartilhada, mesmo formato de
 * alerta, mesmos eventos de entrega), porém 100% LOCAL: os interesses vêm do
 * localStorage do dispositivo — NADA passa pelo Firestore. Fila separada da
 * das quests: alimentar uma nunca sobrescreve a outra.
 */
export function syncBazaarItemsEndingAlerts(input: SyncItemsEndingAlertsInput): void {
  const uid = String(input?.currentUserUid || "").trim();
  const version = String(input?.bazaarVersion || "").trim();
  if (!uid || !version || !Array.isArray(input?.characters)) {
    itemsChannel.queue = null;
    clearTimerIfIdle();
    return;
  }
  const interested = input.interestedAuctionIds instanceof Set
    ? new Set(Array.from(input.interestedAuctionIds, id => String(id)))
    : new Set((input.interestedAuctionIds || []).map(id => String(id)));
  itemsChannel.queue = { characters: input.characters, interestedAuctionIds: interested, currentUserUid: uid, bazaarVersion: version };
  // Poda os registros da versão anterior: consulta nova, alertas zerados.
  readStore(itemsChannel, version);
  ensureSweeper();
  sweepChannel(itemsChannel);
}

/** Para o agendador do painel de itens (logout/troca de usuário). */
export function stopBazaarItemsEndingAlerts(): void {
  itemsChannel.queue = null;
  clearTimerIfIdle();
}

/** Para o agendador (logout/troca de usuário). */
export function stopBazaarEndingAlerts(): void {
  questsChannel.queue = null;
  clearTimerIfIdle();
}

/** Chave de registro exposta para testes/compatibilidade. */
export { endingAlertSentKey };