export type PresenceMode = "economico" | "completo";

export interface PresenceGovernance {
  enabled: boolean;
  mode: PresenceMode;
}

const STORAGE_KEY = "chernobyl_presence_governance";

function loadInitialGovernance(): PresenceGovernance {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return {
      enabled: parsed?.enabled !== false,
      mode: parsed?.mode === "economico" ? "economico" : "completo",
    };
  } catch {
    return { enabled: true, mode: "completo" };
  }
}

let currentGovernance: PresenceGovernance = loadInitialGovernance();
const listeners = new Set<(settings: PresenceGovernance) => void>();

export function getPresenceGovernance(): PresenceGovernance {
  return currentGovernance;
}

export function setPresenceGovernance(settings: Partial<PresenceGovernance>): void {
  const next: PresenceGovernance = {
    enabled: settings.enabled !== undefined ? settings.enabled : currentGovernance.enabled,
    mode: settings.mode === "economico" ? "economico" : (settings.mode === "completo" ? "completo" : currentGovernance.mode),
  };

  const changed = next.enabled !== currentGovernance.enabled || next.mode !== currentGovernance.mode;
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

export function subscribePresenceGovernance(listener: (settings: PresenceGovernance) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}