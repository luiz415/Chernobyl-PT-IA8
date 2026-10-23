// ============================================================================
// PRESENCE CORE — regra única de "online" e plano de limpeza (lado backend)
// ----------------------------------------------------------------------------
// Funções PURAS (sem Firebase) usadas por `presenceSync` (contador) e
// `presenceCleanup` (varredura agendada). ESPELHO DOCUMENTADO de
// `src/utils/presenceStatus.ts` do front — os dois lados DEVEM usar as
// mesmas constantes/predicados; qualquer alteração aqui deve ser replicada
// lá (e vice-versa). Puro = testável sem emulador.
//
// POR QUE EXISTE (auditoria da presença): a semântica antiga era
// "online ⇔ existe conexão com active !== false", sem expiração temporal —
// dependia 100% do onDisconnect do RTDB. Uma falha única do onDisconnect
// (corrida no logout, socket que morre antes de o arm chegar ao servidor,
// conexão fantasma) deixava a conexão órfã e o usuário "Online" por dias.
// A regra nova exige também heartbeat FRESCO (`hb`, regravado pelo cliente
// a cada 4 min); conexões cujo hb parou expiram e são removidas pela
// limpeza agendada.
// ============================================================================

/** Intervalo do heartbeat gravado pelo cliente (espelho do front). */
export const PRESENCE_HEARTBEAT_INTERVAL_MS = 4 * 60 * 1000;

/**
 * Tolerância de frescor: 15 min sem heartbeat (≈3 heartbeats perdidos +
 * folga para skew/suspensões curtas) ⇒ conexão expirada. É o TETO do falso
 * "Online" (antes: infinito).
 */
export const PRESENCE_FRESHNESS_TOLERANCE_MS = 15 * 60 * 1000;

/**
 * TRANSIÇÃO: conexões de clientes antigos (sem `hb`) usam `since` com
 * tolerância de 24h — limpa órfãs de dias já na primeira varredura sem
 * derrubar abas legítimas ainda não recarregadas no dia do deploy.
 */
export const PRESENCE_LEGACY_TOLERANCE_MS = 24 * 60 * 60 * 1000;

export interface PresenceConn {
  active?: boolean;
  since?: number;
  hb?: number;
}

export interface PresenceUserEntry {
  name?: string;
  lastLoginAt?: number;
  lastSeen?: number;
  conns?: Record<string, PresenceConn>;
}

export type PresenceStatusTree = Record<string, PresenceUserEntry>;

/** Último sinal de vida da conexão (hb; fallback legado: since). */
export function connLastBeatMs(conn: PresenceConn | null | undefined): number {
  if (!conn || typeof conn !== "object") return 0;
  const hb = Number(conn.hb) || 0;
  if (hb > 0) return hb;
  return Number(conn.since) || 0;
}

/** Conexão expirada = sem sinal de vida dentro da tolerância aplicável. */
export function isConnExpired(conn: PresenceConn | null | undefined, nowMs: number): boolean {
  if (!conn || typeof conn !== "object") return true;
  const hb = Number(conn.hb) || 0;
  const tolerance = hb > 0 ? PRESENCE_FRESHNESS_TOLERANCE_MS : PRESENCE_LEGACY_TOLERANCE_MS;
  const lastBeat = connLastBeatMs(conn);
  if (lastBeat <= 0) return true; // sem NENHUM timestamp: lixo → expirada
  return nowMs - lastBeat > tolerance;
}

/** Conexão conta como online = ativa (não ociosa) E não expirada. */
export function isConnOnline(conn: PresenceConn | null | undefined, nowMs: number): boolean {
  if (!conn || typeof conn !== "object") return false;
  if (conn.active === false) return false;
  return !isConnExpired(conn, nowMs);
}

/**
 * Total de usuários online na árvore `status` — cada uid conta UMA vez se
 * tiver ≥1 conexão ativa e fresca. Mesma regra do painel Boss.
 */
export function countOnlineUsers(status: PresenceStatusTree | null | undefined, nowMs: number): number {
  const tree = status && typeof status === "object" ? status : {};
  let onlineCount = 0;
  for (const uid of Object.keys(tree)) {
    const conns = tree[uid]?.conns;
    if (!conns || typeof conns !== "object") continue;
    const hasLive = Object.keys(conns).some(id => isConnOnline(conns[id], nowMs));
    if (hasLive) onlineCount += 1;
  }
  return onlineCount;
}

export interface PresenceCleanupPlan {
  /** Caminhos RTDB (relativos à raiz) a REMOVER — um por conexão expirada. */
  removals: string[];
  /**
   * Atualizações de `status/{uid}/lastSeen`: maior sinal de vida entre as
   * conexões removidas, quando for MAIS RECENTE que o lastSeen gravado —
   * preserva o "Visto por último" que o onDisconnect falhou em registrar.
   */
  lastSeenUpdates: Record<string, number>;
}

/**
 * Plano de limpeza das conexões EXPIRADAS (órfãs/suspensas/legadas) — usado
 * pela Cloud Function agendada `presenceCleanup`. Determinístico e
 * idempotente: rodar duas vezes sobre o mesmo estado produz o mesmo plano;
 * após a aplicação, o plano seguinte é vazio. NUNCA remove conexões
 * frescas, nunca toca em `name`/`lastLoginAt` nem em nós de usuários — só
 * conexões mortas e o lastSeen correspondente.
 */
export function planPresenceCleanup(status: PresenceStatusTree | null | undefined, nowMs: number): PresenceCleanupPlan {
  const tree = status && typeof status === "object" ? status : {};
  const removals: string[] = [];
  const lastSeenUpdates: Record<string, number> = {};
  for (const uid of Object.keys(tree)) {
    const entry = tree[uid] || {};
    const conns = entry.conns && typeof entry.conns === "object" ? entry.conns : {};
    let maxRemovedBeat = 0;
    for (const connId of Object.keys(conns)) {
      const conn = conns[connId];
      if (!isConnExpired(conn, nowMs)) continue;
      removals.push(`status/${uid}/conns/${connId}`);
      const beat = connLastBeatMs(conn);
      if (beat > maxRemovedBeat) maxRemovedBeat = beat;
    }
    const recordedLastSeen = Number(entry.lastSeen) || 0;
    if (maxRemovedBeat > recordedLastSeen) {
      lastSeenUpdates[uid] = maxRemovedBeat;
    }
  }
  return { removals, lastSeenUpdates };
}

/**
 * Transição de conexão relevante para o CONTADOR? `false` quando a escrita
 * foi apenas o heartbeat periódico (conexão existia antes e depois com o
 * MESMO estado ativo/ocioso) — nesses casos `presenceSync` retorna cedo sem
 * ler nada (economia: heartbeats são a maioria absoluta dos eventos).
 */
export function isCountRelevantConnChange(
  before: PresenceConn | null | undefined,
  after: PresenceConn | null | undefined,
): boolean {
  const beforeExists = !!before && typeof before === "object";
  const afterExists = !!after && typeof after === "object";
  if (!beforeExists || !afterExists) return true; // criação/remoção: transição real
  const beforeActive = before!.active !== false;
  const afterActive = after!.active !== false;
  return beforeActive !== afterActive; // só mudou hb/since ⇒ irrelevante
}
