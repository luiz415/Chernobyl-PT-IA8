// ============================================================================
// FIRESTORE USAGE MONITOR — Controller global (sem React)
// ============================================================================
// Monitora em tempo real TODAS as operações Firestore do usuário logado
// (reads + writes + deletes), em janela deslizante de 60 segundos.
// Ao ultrapassar o limite (salvo apenas localmente), entra em estado de
// BLOQUEIO por tempo progressivo e notifica os assinantes (AuthContext).
//
// ESCADA DE PENALIDADE:
//   1º bloqueio: 10 segundos
//   2º bloqueio: 30 segundos
//   3º bloqueio em diante: 60 segundos
//
// GRACE PERIOD: nos primeiros 5s após o login, nenhuma operação é contada
// (evita bloqueio no pico de leitura inicial).
//
// IMPORTANTE: este módulo não importa React nem AuthContext (evita ciclo).
// O firestoreLogger chama recordFirestoreOp() a cada operação.
// ============================================================================

const WINDOW_MS = 90000;
const STARTUP_GRACE_MS = 5000;
const LIMIT_STORAGE_KEY = "tibia_firestore_ops_limit";

type RoleLimit = "Boss" | "VIP" | "Normal";
const ROLE_LIMITS: Record<RoleLimit, number> = {
  Boss: Number.POSITIVE_INFINITY,
  VIP: 100,
  Normal: 80,
};
const DEFAULT_ROLE: RoleLimit = "Normal";

let currentUid: string | null = null;
let currentRole: RoleLimit = DEFAULT_ROLE;
let rateLimitDisabled = false;
const opsTimestamps: number[] = [];
let blockedUntil = 0;
let sessionBlockCount = 0;
let monitorStartedAt = 0;

function resetUsageWindow(): void {
  opsTimestamps.length = 0;
  notifyUsage();
}

function getBlockDurationMs(blockNumber: number): number {
  if (blockNumber <= 1) return 10_000;   // 1º: 10 segundos
  if (blockNumber === 2) return 30_000;  // 2º: 30 segundos
  return 60_000;                          // 3º+: 60 segundos
}

type Listener = () => void;
type BlockListener = (sessionCount: number, durationMs: number) => void;
const usageListeners = new Set<Listener>();
const blockListeners = new Set<BlockListener>();

function notifyUsage() {
  usageListeners.forEach(fn => { try { fn(); } catch {} });
}

function notifyBlock(durationMs: number) {
  blockListeners.forEach(fn => { try { fn(sessionBlockCount, durationMs); } catch {} });
}

export function getUsageLimit(): number {
  const roleLimit = ROLE_LIMITS[currentRole] ?? ROLE_LIMITS[DEFAULT_ROLE];
  if (!Number.isFinite(roleLimit)) return Number.POSITIVE_INFINITY;
  try {
    const raw = localStorage.getItem(LIMIT_STORAGE_KEY);
    const parsed = raw ? parseInt(raw, 10) : NaN;
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  } catch {}
  return roleLimit;
}

export function setUsageLimit(limit: number): void {
  try {
    if (Number.isFinite(limit) && limit > 0) {
      localStorage.setItem(LIMIT_STORAGE_KEY, String(Math.floor(limit)));
    }
  } catch {}
}

/** Define o role do usuário atual (influencia o limite por minuto). */
export function setUsageRole(role: string | null | undefined): void {
  const r = (role === "Boss" || role === "VIP" || role === "Normal") ? role : DEFAULT_ROLE;
  currentRole = r;
  // Boss tem limite ilimitado — desabilita rate limit automaticamente
  rateLimitDisabled = (r === "Boss");
}

/** Boss nunca é bloqueado. Chamado pelo AuthContext quando o role é Boss. */
export function setRateLimitDisabled(disabled: boolean): void {
  rateLimitDisabled = disabled;
}

/** Define o usuário atual. Trocar de usuário reseta janela e bloqueio. */
export function setUsageMonitorUid(uid: string | null, persistedBlocks = 0): void {
  if (uid === currentUid) return;
  currentUid = uid;
  resetUsageWindow();
  blockedUntil = 0;
  sessionBlockCount = persistedBlocks;
  monitorStartedAt = Date.now();
}

/** Registra 1 operação Firestore. Chamado pelo firestoreLogger em cada op. */
export function recordFirestoreOp(_type: "read" | "write" | "delete"): void {
  if (rateLimitDisabled) return;

  const now = Date.now();

  // Grace period: ignora contagem nos primeiros segundos após login
  if (now - monitorStartedAt < STARTUP_GRACE_MS) return;

  // Durante o bloqueio não acumula (evita re-bloqueio em cadeia ao liberar)
  if (now < blockedUntil) {
    resetUsageWindow();
    return;
  }

  // Se o bloqueio acabou, garante que a próxima janela comece zerada.
  if (blockedUntil > 0 && now >= blockedUntil) {
    blockedUntil = 0;
    resetUsageWindow();
  }

  opsTimestamps.push(now);
  const cutoff = now - WINDOW_MS;
  while (opsTimestamps.length > 0 && opsTimestamps[0] < cutoff) {
    opsTimestamps.shift();
  }

  if (opsTimestamps.length > getUsageLimit()) {
    sessionBlockCount += 1;
    const duration = getBlockDurationMs(sessionBlockCount);
    blockedUntil = now + duration;
    resetUsageWindow();
    notifyBlock(duration);
  }
}

export function isFirestoreBlocked(): boolean {
  if (rateLimitDisabled) return false;
  const blocked = Date.now() < blockedUntil;
  if (!blocked && blockedUntil > 0) {
    blockedUntil = 0;
    resetUsageWindow();
  }
  return blocked;
}

export function getBlockedUntil(): number {
  return blockedUntil;
}

export function getOpsInWindow(): number {
  const cutoff = Date.now() - WINDOW_MS;
  while (opsTimestamps.length > 0 && opsTimestamps[0] < cutoff) {
    opsTimestamps.shift();
  }
  return opsTimestamps.length;
}

export function getSessionBlockCount(): number {
  return sessionBlockCount;
}

/** Libera o bloqueio imediatamente. */
export function clearBlock(): void {
  blockedUntil = 0;
  resetUsageWindow();
}

export function subscribeUsage(listener: Listener): () => void {
  usageListeners.add(listener);
  return () => { usageListeners.delete(listener); };
}

/** Dispara quando um novo bloqueio acontece. Callback: (blockCount, durationMs). */
export function onRateLimitBlock(listener: BlockListener): () => void {
  blockListeners.add(listener);
  return () => { blockListeners.delete(listener); };
}