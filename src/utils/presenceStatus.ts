// ============================================================================
// STATUS DE PRESENÇA — REGRA ÚNICA DE "ONLINE" (lado do cliente)
// ----------------------------------------------------------------------------
// PROBLEMA QUE ESTE MÓDULO RESOLVE (auditoria da presença): a semântica
// antiga era "online ⇔ existe conexão com active !== false", SEM nenhuma
// expiração temporal — dependia 100% do `onDisconnect` do RTDB para remover
// a conexão. Quando o onDisconnect falhava uma única vez (janela de corrida
// no logout, socket que morre antes de o arm chegar ao servidor, conexões
// fantasma), a conexão ficava ÓRFÃ para sempre e o usuário aparecia
// "Online" por dias no painel Boss.
//
// REGRA NOVA: online ⇔ existe ≥1 conexão com `active !== false` **E**
// heartbeat FRESCO. O cliente grava `hb` (serverTimestamp) na própria
// conexão a cada HEARTBEAT_INTERVAL; uma conexão cujo hb parou é tratada
// como expirada (órfã/suspensa/desconectada), mesmo que o onDisconnect
// nunca tenha rodado. O onDisconnect continua existindo como limpeza
// imediata — o heartbeat é a rede de segurança que não depende dele.
//
// ESTE ARQUIVO É PURO (sem imports do Firebase) e é a MESMA regra aplicada
// pelo backend em `functions/src/presenceCore.ts` (espelho documentado —
// os dois lados DEVEM usar as mesmas constantes/predicados). Qualquer
// alteração aqui deve ser replicada lá.
// ============================================================================

/** Intervalo do heartbeat gravado pelo cliente em cada conexão (4 min). */
export const PRESENCE_HEARTBEAT_INTERVAL_MS = 4 * 60 * 1000;

/**
 * Tolerância para considerar uma conexão viva: 15 minutos sem heartbeat
 * (≈ 3 heartbeats perdidos + folga para skew de relógio e suspensões
 * curtas). Menor → falsos "Offline" em redes instáveis; maior → falsos
 * "Online" mais longos. 15 min é o TETO do falso positivo (antes: infinito).
 */
export const PRESENCE_FRESHNESS_TOLERANCE_MS = 15 * 60 * 1000;

/**
 * TRANSIÇÃO: conexões gravadas por clientes ANTIGOS (antes do heartbeat)
 * não têm `hb` — para elas vale o `since` com tolerância de 24h. Isso
 * remove já na primeira varredura as órfãs acumuladas há dias SEM derrubar
 * no dia do deploy abas legítimas ainda não recarregadas. Dias depois do
 * deploy, nenhuma conexão sem `hb` existirá e esta regra vira letra morta.
 */
export const PRESENCE_LEGACY_TOLERANCE_MS = 24 * 60 * 60 * 1000;

/** Forma bruta de uma conexão em `status/{uid}/conns/{connId}` no RTDB. */
export interface PresenceConn {
  active?: boolean;
  since?: number;
  /** Último heartbeat (serverTimestamp) — ausente em conexões legadas. */
  hb?: number;
}

/** Último sinal de vida conhecido da conexão (hb; fallback legado: since). */
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
  if (conn.active === false) return false; // ociosa não conta como online
  return !isConnExpired(conn, nowMs);
}

/** Forma bruta do nó `status/{uid}` no RTDB. */
export interface PresenceUserEntry {
  name?: string;
  lastLoginAt?: number;
  lastSeen?: number;
  conns?: Record<string, PresenceConn>;
}

export interface DerivedPresence {
  /** ≥1 conexão ativa e fresca (múltiplas abas/dispositivos contam UMA vez). */
  online: boolean;
  /** Melhor "visto por último": max(lastSeen gravado, maior heartbeat). */
  lastSeen: number;
  lastLoginAt: number;
}

/**
 * Deriva o status exibível de um usuário a partir do nó bruto do RTDB —
 * usada pela guia Usuários do BossAdminPanel. Mesma semântica do backend
 * (contador `presence/count` e limpeza agendada).
 */
export function derivePresence(entry: PresenceUserEntry | null | undefined, nowMs: number): DerivedPresence {
  const safe = entry && typeof entry === "object" ? entry : {};
  const conns = safe.conns && typeof safe.conns === "object" ? safe.conns : {};
  let online = false;
  let maxBeat = 0;
  for (const id of Object.keys(conns)) {
    const conn = conns[id];
    if (isConnOnline(conn, nowMs)) online = true;
    const beat = connLastBeatMs(conn);
    if (beat > maxBeat) maxBeat = beat;
  }
  const lastSeen = Math.max(Number(safe.lastSeen) || 0, maxBeat);
  return { online, lastSeen, lastLoginAt: Number(safe.lastLoginAt) || 0 };
}

/**
 * CONTADOR DO RODAPÉ (74ª) — número exibível de usuários online.
 *
 * O agregado `presence/count` é um RETRATO ATRASADO: a Cloud Function
 * `presenceSync` só o escreve nas transições, e o cliente o lê por polling
 * de 10 min — logo após o login, a leitura quase sempre acontece ANTES de a
 * CF processar a conexão recém-criada (o doc ainda carrega o total SEM o
 * próprio usuário; com um único usuário, `0`).
 *
 * O único dado de presença que o cliente conhece com CERTEZA, em tempo
 * real, é o da PRÓPRIA sessão (conexão RTDB ativa + heartbeat desta aba —
 * a mesma regra única de "online" deste módulo). Quando essa sessão conta
 * como online (`selfCountsAsOnline`), o usuário faz parte do conjunto por
 * definição e o total exibido nunca pode ser menor que 1 — não é ajuste
 * cosmético: é a contabilização do próprio usuário, exigida pela regra.
 * Sessão própria OCIOSA/deslogada não força nada (ociosa não conta como
 * online — consistente com o painel Boss e com a CF).
 */
export function displayOnlineCount(aggregatedCount: number, selfCountsAsOnline: boolean): number {
  const safe = Number.isFinite(aggregatedCount) ? Math.max(0, Math.floor(Number(aggregatedCount))) : 0;
  return selfCountsAsOnline ? Math.max(1, safe) : safe;
}
