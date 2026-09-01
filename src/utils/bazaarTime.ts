const BAZAR_FILTERS_KEY = "rubinot_bazaar_filters";
const DEFAULT_BAZAAR_TIMEZONE_OFFSET_MINUTES = -180;

// ============================================================================
// ANTECEDÊNCIA DA NOTIFICAÇÃO DE ENCERRAMENTO
//
// Quantos minutos antes do fim do leilão o usuário quer ser avisado.
// Persistido junto das demais preferências do Bazaar (mesma chave do fuso
// horário), portanto é individual por usuário/dispositivo.
//
// O limite superior cobre avisos folgados (10, 15, 30, 60 min…) — o
// agendador LOCAL do dispositivo (bazaarInterestNotificationService) dispara
// no primeiro minuto em que o leilão entra na janela configurada. O mesmo
// limite vale no planejador puro (utils/bazaarEndingAlerts.ts) — manter os
// dois iguais.
// ============================================================================
export const BAZAR_NOTIFY_MINUTES_MIN = 1;
export const BAZAR_NOTIFY_MINUTES_MAX = 60;
export const BAZAR_NOTIFY_MINUTES_DEFAULT = 3;

/** Restringe qualquer entrada ao intervalo permitido (1 a 60, inteiro). */
export function clampBazarNotifyMinutes(value: unknown): number {
  const numeric = Math.round(Number(value));
  if (!Number.isFinite(numeric)) return BAZAR_NOTIFY_MINUTES_DEFAULT;
  return Math.min(BAZAR_NOTIFY_MINUTES_MAX, Math.max(BAZAR_NOTIFY_MINUTES_MIN, numeric));
}

/**
 * Minutos de antecedência configurados pelo usuário.
 * Retorna o padrão quando nunca houve configuração ou o valor está corrompido.
 */
export function readBazarNotifyMinutes(): number {
  try {
    const raw = localStorage.getItem(BAZAR_FILTERS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    const value = parsed?.notifyBeforeMinutes;
    if (value === undefined || value === null) return BAZAR_NOTIFY_MINUTES_DEFAULT;
    return clampBazarNotifyMinutes(value);
  } catch {
    return BAZAR_NOTIFY_MINUTES_DEFAULT;
  }
}

/** Mesma preferência já convertida para milissegundos. */
export function readBazarNotifyBeforeMs(): number {
  return readBazarNotifyMinutes() * 60 * 1000;
}

/**
 * Título da notificação de encerramento, já com singular/plural correto.
 * Fonte única do texto: quem dispara a notificação passa os minutos que
 * realmente usou no agendamento, garantindo que a mensagem sempre reflita
 * a antecedência configurada pelo usuário.
 */
export function formatBazarNotifyTitle(minutes: number): string {
  const safe = clampBazarNotifyMinutes(minutes);
  return `Leilão encerrando em ${safe} ${safe === 1 ? "minuto" : "minutos"}`;
}

export function readBazarTimezoneOffsetMinutes(): number {
  try {
    const raw = localStorage.getItem(BAZAR_FILTERS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && Number.isFinite(Number(parsed?.timezoneOffsetMinutes))) {
      return Number(parsed.timezoneOffsetMinutes);
    }
    // Nunca configurado → usa o FUSO REAL DO DISPOSITIVO (horário local do
    // usuário). Antes o default era fixo -180 (Brasília): para quem usa o app
    // em outro fuso, a notificação de encerramento mostrava a hora errada —
    // exatamente o "horário fixo/global" que não pode existir.
    return getDeviceTimezoneOffsetMinutes();
  } catch {
    return getDeviceTimezoneOffsetMinutes();
  }
}

/**
 * Offset do fuso do DISPOSITIVO em minutos (mesma convenção do seletor do
 * Bazaar: -180 = UTC-3, 0 = UTC). Fora do navegador (SSR/teste) cai no
 * default fixo.
 */
export function getDeviceTimezoneOffsetMinutes(): number {
  try {
    const offset = -new Date().getTimezoneOffset();
    if (Number.isFinite(offset)) return offset; // 0 (UTC) também é fuso válido
  } catch {}
  return DEFAULT_BAZAAR_TIMEZONE_OFFSET_MINUTES;
}

export function formatTimeOfDayWithOffset(ms: number | null | undefined, offsetMinutes: number): string {
  if (!ms || !Number.isFinite(ms)) return "--:--:--";
  const shifted = new Date(ms + offsetMinutes * 60 * 1000);
  const hours = String(shifted.getUTCHours()).padStart(2, "0");
  const minutes = String(shifted.getUTCMinutes()).padStart(2, "0");
  const seconds = String(shifted.getUTCSeconds()).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

export function formatHourMinuteWithOffset(ms: number | null | undefined, offsetMinutes: number): string {
  if (!ms || !Number.isFinite(ms)) return "--:--";
  const shifted = new Date(ms + offsetMinutes * 60 * 1000);
  const hours = String(shifted.getUTCHours()).padStart(2, "0");
  const minutes = String(shifted.getUTCMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}