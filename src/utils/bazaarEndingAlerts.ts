// ============================================================================
// BAZAAR — PLANEJAMENTO PURO DOS ALERTAS LOCAIS DE ENCERRAMENTO.
// ============================================================================
//
// Núcleo 100% puro (sem DOM/Firebase) usado pelo agendador local do
// dispositivo (`services/bazaarInterestNotificationService.ts`).
//
// Decisão de arquitetura: o alerta de "Tenho Interesse" é programado NO
// PRÓPRIO DISPOSITIVO do usuário, não no backend. O motivo é simples: a
// notificação só é exibível pelo dispositivo de qualquer forma — no Electron
// não existe FCM (file:// sem Service Worker), então a Cloud Function só
// ajudava via listener (app aberto), caso que o agendador local cobre com
// bem menos peças móveis e zero custo por execução.
//
// O id da notificação segue a MESMA convenção do antigo watcher
// (`bazaar_ending_{leilao}_{fim}_{uid}`): durante a transição (CF ainda
// deployada) o documento e o alerta local colidem no MESMO id e o dedup do
// hook/App mantém uma exibição única por evento.
// ============================================================================

export interface EndingAuctionInput {
  /** Id do leilão (mesma chave usada no agregado de interesses). */
  id: string;
  name: string;
  server: string;
  /** Encerramento em SEGUNDOS ou MILISSEGUNDOS (normalizado aqui). */
  auctionEndTs: number | null;
  url: string;
}

/** Alerta pronto para exibição (payload do CustomEvent → hook → desktop). */
export interface EndingAlert {
  /** Id determinístico e estável do documento/notificação local. */
  notificationId: string;
  /** Chave do registro "já alertado" (sem uid — por dispositivo). */
  sentKey: string;
  auctionId: string;
  title: string;
  body: string;
  url: string;
  /** Encerramento em ms (absoluto — agnóstico de fuso). */
  auctionEndMs: number;
  /** Encerramento formatado no fuso do usuário ("HH:MM"). */
  endTimeLabel: string;
}

export const ENDING_ALERT_MINUTES_MIN = 1;
export const ENDING_ALERT_MINUTES_MAX = 60;
export const ENDING_ALERT_MINUTES_DEFAULT = 3;

export function clampEndingAlertMinutes(value: unknown): number {
  const numeric = Math.round(Number(value));
  if (!Number.isFinite(numeric)) return ENDING_ALERT_MINUTES_DEFAULT;
  return Math.min(ENDING_ALERT_MINUTES_MAX, Math.max(ENDING_ALERT_MINUTES_MIN, numeric));
}

/** Normaliza o carimbo de encerramento para MILISSEGUNDOS (aceita s ou ms). */
export function normalizeEndingMs(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return numeric > 1_000_000_000_000 ? Math.floor(numeric) : Math.floor(numeric * 1000);
}

/** Id de notificação — mesma convenção do antigo watcher (interoperação). */
export function endingAlertNotificationId(auctionId: string, auctionEndMs: number, uid: string): string {
  return `bazaar_ending_${auctionId}_${auctionEndMs}_${uid}`;
}

/** Chave anti-redisparo (por dispositivo, independe de usuário). */
export function endingAlertSentKey(auctionId: string, auctionEndMs: number): string {
  return `${auctionId}_${auctionEndMs}`;
}

/** hh:mm já ajustado ao offset do usuário (mesma formatação do painel). */
export function formatEndingHourMinute(auctionEndMs: number, offsetMinutes: number): string {
  const shifted = new Date(auctionEndMs + offsetMinutes * 60 * 1000);
  const hh = String(shifted.getUTCHours()).padStart(2, "0");
  const mm = String(shifted.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * Coleta os alertas DEVIDOS no instante `nowMs`.
 *
 * Um leilão dispara quando: ainda NÃO encerrou, o usuário tem interesse nele
 * e `agora >= fim - antecedência`. A antecedência é lida A CADA VARREDURA —
 * mudar o valor no painel vale no minuto seguinte, sem reagendamento.
 * Chaves em `sentKeys` nunca disparam de novo (idempotência local).
 */
export function collectDueEndingAlerts(input: {
  nowMs: number;
  /** Antecedência em minutos (1 a 60). */
  notifyMinutes: number;
  /** Offset de fuso do usuário em minutos (só apresentação). */
  timezoneOffsetMinutes: number;
  uid: string;
  characters: EndingAuctionInput[];
  /** Ids de leilão marcados como interesse PELO PRÓPRIO USUÁRIO. */
  interestedAuctionIds: Set<string> | string[];
  /** Chaves já alertadas neste dispositivo (registro local persistido). */
  sentKeys: Set<string> | string[];
}): EndingAlert[] {
  const interested = input.interestedAuctionIds instanceof Set
    ? input.interestedAuctionIds
    : new Set(input.interestedAuctionIds);
  const sent = input.sentKeys instanceof Set ? input.sentKeys : new Set(input.sentKeys);
  const notifyMs = clampEndingAlertMinutes(input.notifyMinutes) * 60 * 1000;
  const due: EndingAlert[] = [];

  (input.characters || []).forEach(character => {
    const auctionId = String(character?.id || "").trim();
    if (!auctionId || !interested.has(auctionId)) return;
    const auctionEndMs = normalizeEndingMs(character?.auctionEndTs);
    if (!auctionEndMs) return;

    const msUntilEnd = auctionEndMs - input.nowMs;
    // Leilão já encerrado → alertar é inútil (nunca dispara atrasado).
    if (msUntilEnd <= 0) return;
    // Ainda fora da janela de antecedência configurada.
    if (msUntilEnd > notifyMs) return;

    const sentKey = endingAlertSentKey(auctionId, auctionEndMs);
    if (sent.has(sentKey)) return;

    const minutesLeft = Math.max(1, Math.round(msUntilEnd / 60000));
    const endTimeLabel = formatEndingHourMinute(auctionEndMs, input.timezoneOffsetMinutes);
    const name = String(character?.name || auctionId);
    const server = String(character?.server || "—");
    due.push({
      notificationId: endingAlertNotificationId(auctionId, auctionEndMs, input.uid),
      sentKey,
      auctionId,
      title: `Leilão encerrando em ${minutesLeft} ${minutesLeft === 1 ? "minuto" : "minutos"}`,
      body: `${name} — ${server} — Encerra às ${endTimeLabel}`,
      url: String(character?.url || ""),
      auctionEndMs,
      endTimeLabel,
    });
  });

  return due;
}