import type { NegotiationTimestamp } from "../types";

/**
 * Converte Timestamp do Firestore ou epoch legado para milissegundos.
 * Nunca interpreta strings localizadas como fonte de tempo.
 */
export function toFirestoreMillis(value?: NegotiationTimestamp | null): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (value && typeof (value as any).toMillis === "function") {
    const millis = Number((value as any).toMillis());
    return Number.isFinite(millis) ? millis : 0;
  }
  return 0;
}

/** Formata sempre no fuso do navegador de quem está visualizando. */
export function formatFirestoreLocalDateTime(
  value?: NegotiationTimestamp | null,
  options: Intl.DateTimeFormatOptions = { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" },
): string {
  const millis = toFirestoreMillis(value);
  return millis > 0 ? new Date(millis).toLocaleString("pt-BR", options) : "—";
}