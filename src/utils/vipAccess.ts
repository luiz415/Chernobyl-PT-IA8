export const VIP_DAY_MS = 24 * 60 * 60 * 1000;

export interface VipAccessData {
  role?: string;
  vipExpiresAt?: number | { toMillis?: () => number; seconds?: number } | null;
  // Compatibilidade temporária durante a migração dos usuários antigos.
  vipDays?: number;
}

export function getVipExpirationMillis(value: VipAccessData["vipExpiresAt"]): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (value && typeof value === "object") {
    if (typeof value.toMillis === "function") return value.toMillis();
    if (typeof value.seconds === "number") return value.seconds * 1000;
  }
  return 0;
}

export function isVipActive(data: VipAccessData | null | undefined, now = Date.now()): boolean {
  return getVipExpirationMillis(data?.vipExpiresAt) > now;
}

// Retorna uma expiração derivada apenas para exibir/migrar perfis legados que
// ainda não possuem vipExpiresAt. Um timestamp já existente sempre tem prioridade.
export function getVipEffectiveExpirationMillis(data: VipAccessData | null | undefined, now = Date.now()): number {
  if (!data) return 0;
  const expiresAt = getVipExpirationMillis(data.vipExpiresAt);
  if (expiresAt > 0) return expiresAt;
  if (typeof data.vipDays === "number" && data.vipDays > 0) {
    return now + Math.floor(data.vipDays) * VIP_DAY_MS;
  }
  return 0;
}

export function getVipRemainingDays(data: VipAccessData | null | undefined, now = Date.now()): number {
  if (!data) return 0;
  const expiresAt = getVipExpirationMillis(data.vipExpiresAt);
  if (expiresAt > now) return Math.ceil((expiresAt - now) / VIP_DAY_MS);
  // Compatibilidade temporária com créditos antigos, anteriores ao vipExpiresAt.
  if (!expiresAt && typeof data.vipDays === "number" && data.vipDays > 0) {
    return Math.floor(data.vipDays);
  }
  return 0;
}

export function getEffectiveUserRole(data: VipAccessData | null | undefined, now = Date.now()): "Boss" | "VIP" | "Normal" {
  if (data?.role === "Boss") return "Boss";
  return isVipActive(data, now) || (!getVipExpirationMillis(data?.vipExpiresAt) && getVipRemainingDays(data, now) > 0)
    ? "VIP"
    : "Normal";
}

export function formatVipExpirationDate(value: VipAccessData["vipExpiresAt"]): string {
  const expiresAt = getVipExpirationMillis(value);
  if (!expiresAt) return "—";
  return new Date(expiresAt).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatVipRemainingTime(value: VipAccessData["vipExpiresAt"], now = Date.now()): string {
  const expiresAt = getVipExpirationMillis(value);
  const diffMs = expiresAt - now;
  if (!expiresAt || diffMs <= 0) return "Expirado";

  const totalMinutes = Math.floor(diffMs / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];

  if (days > 0) parts.push(`${days} dia${days === 1 ? "" : "s"}`);
  if (hours > 0) parts.push(`${hours} hora${hours === 1 ? "" : "s"}`);
  if (minutes > 0) parts.push(`${minutes} minuto${minutes === 1 ? "" : "s"}`);
  return parts.join(", ") || "Menos de 1 minuto";
}
