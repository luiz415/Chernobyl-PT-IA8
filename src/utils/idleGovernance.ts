export interface IdleGovernance {
  timeoutMinutes: number;
}

const DEFAULT_IDLE_TIMEOUT_MINUTES = 30;
const STORAGE_KEY = "chernobyl_idle_governance";

function sanitizeTimeoutMinutes(value: unknown): number {
  const parsed = typeof value === "number" ? value : parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_IDLE_TIMEOUT_MINUTES;
  return Math.max(1, Math.min(1440, Math.floor(parsed)));
}

function loadInitialGovernance(): IdleGovernance {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return { timeoutMinutes: sanitizeTimeoutMinutes(parsed?.timeoutMinutes) };
  } catch {
    return { timeoutMinutes: DEFAULT_IDLE_TIMEOUT_MINUTES };
  }
}

let currentGovernance: IdleGovernance = loadInitialGovernance();
const listeners = new Set<(settings: IdleGovernance) => void>();

export function getIdleGovernance(): IdleGovernance {
  return currentGovernance;
}

export function setIdleGovernance(settings: Partial<IdleGovernance>): void {
  const next: IdleGovernance = {
    timeoutMinutes: sanitizeTimeoutMinutes(settings.timeoutMinutes ?? currentGovernance.timeoutMinutes),
  };

  const changed = next.timeoutMinutes !== currentGovernance.timeoutMinutes;
  currentGovernance = next;

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(currentGovernance));
  } catch {}

  if (changed) {
    listeners.forEach(listener => {
      try { listener(currentGovernance); } catch {}
    });
  }
}

export function subscribeIdleGovernance(listener: (settings: IdleGovernance) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}