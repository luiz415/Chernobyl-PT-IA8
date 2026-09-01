/**
 * Núcleo puro do commit de estatísticas persistentes (userStats) no backend.
 * ============================================================================
 *
 * Espelha EXATAMENTE a semântica do commitPartyStats do App.tsx (transação
 * idempotente por usuário por PT), para que backend e frontend sejam
 * escritores intercambiáveis sobre os MESMOS documentos e marcadores:
 *
 *   - Coleção:        userStats/{uid}
 *   - Marcador:       userStats/{uid}/processedParties/{partyId}
 *   - Contadores:     increment() (sem leitura prévia, exceto streak/ranking)
 *   - Streak/Ranking: valores ABSOLUTOS calculados a partir do doc atual
 *   - dayKey:         data UTC (YYYY-MM-DD) do instante de conclusão da Quest
 *
 * Diferenças DOCUMENTADAS em relação ao analyzePartyForStats do frontend
 * (aceitas na especificação desta migração):
 *   1. Resolução do JOGADOR: o backend prefere slot.playerUid (identidade
 *      estável, gravada pelo PartyPanel junto ao nome) e só então resolve o
 *      nome via usuários aprovados. O frontend resolve apenas por nome — um
 *      usuário renomeado após a PT deixaria de receber stats no frontend,
 *      mas continua recebendo no backend (comportamento mais correto).
 *   2. Service: usa SOMENTE a flag slot.isService (persistida em toda PT
 *      nova). O fallback para a Lista de Espera — que cobre PTs legadas
 *      anteriores à flag — permanece no frontend, que eventualmente as
 *      processa. Entradas custom (id "cust_*") recebem isService:true no
 *      parser do lifecycle, mas NÃO são services no frontend: o prefixo
 *      cust_ as exclui aqui também.
 *   3. Sem fallback para o DONO (ownerUid/ownerName): estatísticas são
 *      atribuídas APENAS ao JOGADOR da coluna respectiva.
 *
 * Não depende de Firebase nem de React — testável via tools/party-stats-tests.
 */
import type { LifecycleParty } from "./partyLifecycleCore.js";

/** Contribuições agregadas de um usuário em uma PT concluída. */
export interface ParticipantStatsInfo {
  uid: string;
  deaths: number;
  participations: number;
  services: number;
  partnerUids: string[];
}

/**
 * Plano de escrita sobre userStats/{uid}, separado por tipo de operação para
 * que o wiring converta cada incremento em FieldValue.increment() — o resto
 * permanece puro e comparável em testes.
 */
export interface UserStatsUpdatePlan {
  /** Caminho Firestore (com pontos p/ mapas aninhados) → delta incremental. */
  increments: Record<string, number>;
  /** Caminho Firestore → valor ABSOLUTO (streak/ranking). */
  absolutes: Record<string, number>;
}

function isCustomSlot(slotId: string): boolean {
  return slotId.startsWith("cust_");
}

/**
 * Responde se a PT precisa da lista de usuários aprovados para resolver
 * JOGADORES. PTs modernas gravam playerUid em todo slot com jogador — nestas,
 * a query de usuários (1 leitura por materialização) pode ser pulada.
 */
export function needsApprovedUsersLookup(party: LifecycleParty): boolean {
  return party.slots.some(slot => !!slot.playerName && !slot.playerUid);
}

/**
 * Analisa a PT e agrega, por usuário resolvido, as contribuições como JOGADOR
 * (participações, mortes, services) e a lista de parceiros (todos os outros
 * jogadores resolvidos, por UID). Cada usuário aparece uma única vez, mesmo
 * presente em múltiplos slots. Retorna [] para PT não concluída/falha ou sem
 * jogadores resolvíveis.
 */
export function resolveParticipantStats(
  party: LifecycleParty,
  nameToUid: ReadonlyMap<string, string>,
): ParticipantStatsInfo[] {
  if (!party.questConcluida || party.questFalha) return [];
  const own = new Map<string, { deaths: number; participations: number; services: number }>();
  const resolvedOrder: string[] = [];
  party.slots.forEach(slot => {
    const playerName = slot.playerName.trim();
    if (!playerName) return;
    const resolvedUid = slot.playerUid
      || nameToUid.get(playerName.toLowerCase())
      || undefined;
    if (!resolvedUid) return;
    let agg = own.get(resolvedUid);
    if (!agg) {
      agg = { deaths: 0, participations: 0, services: 0 };
      own.set(resolvedUid, agg);
      resolvedOrder.push(resolvedUid);
    }
    agg.participations += 1;
    agg.deaths += slot.deaths;
    if (slot.isService && !isCustomSlot(slot.id)) {
      agg.services += 1;
    }
  });
  return resolvedOrder.map(uid => ({
    uid,
    ...own.get(uid)!,
    partnerUids: resolvedOrder.filter(other => other !== uid),
  }));
}

/**
 * Chave do dia (UTC, YYYY-MM-DD) para os buckets de dailyStats — a mesma
 * derivada do archivedAt/questFinalizedAt gravado na conclusão da Quest.
 */
export function statsDayKey(questFinalizedAt: number, now: number): string {
  return new Date(questFinalizedAt > 0 ? questFinalizedAt : now).toISOString().slice(0, 10);
}

/** Documento-marcador de idempotência (mesma forma do frontend). */
export function buildStatsMarker(party: LifecycleParty, now: number): Record<string, unknown> {
  return {
    processedAt: now,
    partyName: party.name || "",
    questType: party.questType,
  };
}

/**
 * Constrói o plano de escrita de userStats/{uid} para uma PT concluída.
 * `current` são os dados atuais do doc (lidos DENTRO da transação) — apenas
 * streak e rankingScore dependem deles; todo o restante é incremental.
 *
 * Ranking score (fórmula idêntica ao commitPartyStats): recompensa
 * participação, sobrevivência, tempo investido e consistência, com marcos em
 * 100/250/500 PTs concluídas.
 */
export function buildUserStatsUpdatePlan(
  info: ParticipantStatsInfo,
  party: LifecycleParty,
  dayKey: string,
  current: Record<string, unknown> | undefined,
  now: number,
): UserStatsUpdatePlan {
  const cur = current || {};
  const duration = party.durationMs;
  const isSoulwar = party.questType === "soulwar";
  const isSanguine = party.questType === "sanguine";
  const servidor = (party.server || "").trim();
  const semMorte = info.deaths === 0;

  const curStreak = typeof cur.sequenciaAtualSemMorte === "number" ? cur.sequenciaAtualSemMorte : 0;
  const newStreak = semMorte ? curStreak + 1 : 0;
  const curMax = typeof cur.maxSequenciaSemMorte === "number" ? cur.maxSequenciaSemMorte : 0;
  const newMax = Math.max(curMax, newStreak);

  // RANKING SCORE — a partir dos valores PÓS-incremento.
  const curConcluidas = (typeof cur.totalPtsConcluidas === "number" ? cur.totalPtsConcluidas : 0) + 1;
  const curParticipacoes = (typeof cur.totalParticipacoes === "number" ? cur.totalParticipacoes : 0) + info.participations;
  const curSW = (typeof cur.totalPtsSoulwar === "number" ? cur.totalPtsSoulwar : 0) + (isSoulwar ? 1 : 0);
  const curSG = (typeof cur.totalPtsSanguine === "number" ? cur.totalPtsSanguine : 0) + (isSanguine ? 1 : 0);
  const curMortes = (typeof cur.totalMortes === "number" ? cur.totalMortes : 0) + info.deaths;
  const curSemMorte = (typeof cur.ptsSemMorte === "number" ? cur.ptsSemMorte : 0) + (semMorte ? 1 : 0);
  const curDurMs = (typeof cur.totalDuracaoMs === "number" ? cur.totalDuracaoMs : 0) + duration;

  const base = (curConcluidas * 10) + (curParticipacoes * 3) + (curSemMorte * 5);
  const penalty = curMortes * 2;
  const streakScore = newStreak + Math.floor(newMax * 0.5);
  const horasScore = Math.floor(curDurMs / 3_600_000) * 2;
  const questScore = curSW + (curSG * 2);

  let milestoneBonus = 0;
  if (curConcluidas >= 500) milestoneBonus = 250;
  else if (curConcluidas >= 250) milestoneBonus = 100;
  else if (curConcluidas >= 100) milestoneBonus = 50;

  const rankingScore = Math.max(0, base - penalty + streakScore + horasScore + questScore + milestoneBonus);

  const increments: Record<string, number> = {
    totalPtsConcluidas: 1,
    totalPtsSoulwar: isSoulwar ? 1 : 0,
    totalPtsSanguine: isSanguine ? 1 : 0,
    totalMortes: info.deaths,
    totalDuracaoMs: duration,
    totalParticipacoes: info.participations,
    services: info.services,
    ptsSemMorte: semMorte ? 1 : 0,
    ptsComMorte: semMorte ? 0 : 1,
    // Campos de doação — sempre presentes para que todo usuário possua ambos;
    // increment(0) apenas cria os campos sem alterar valores existentes.
    totalRcDoado: 0,
    totalRcDoadoAprovado: 0,
    [`dailyStats.${dayKey}.totalPtsConcluidas`]: 1,
    [`dailyStats.${dayKey}.totalPtsSoulwar`]: isSoulwar ? 1 : 0,
    [`dailyStats.${dayKey}.totalPtsSanguine`]: isSanguine ? 1 : 0,
    [`dailyStats.${dayKey}.totalMortes`]: info.deaths,
    [`dailyStats.${dayKey}.totalDuracaoMs`]: duration,
    [`dailyStats.${dayKey}.totalParticipacoes`]: info.participations,
    [`dailyStats.${dayKey}.services`]: info.services,
    [`dailyStats.${dayKey}.ptsSemMorte`]: semMorte ? 1 : 0,
    [`dailyStats.${dayKey}.ptsComMorte`]: semMorte ? 0 : 1,
  };
  // Contador por servidor (apenas o servidor desta PT)
  if (servidor) {
    increments[`servers.${servidor}`] = 1;
    increments[`dailyStats.${dayKey}.servers.${servidor}`] = 1;
  }
  // Parceiros de quest — SEMPRE por UID, nunca por nome
  info.partnerUids.forEach(partnerUid => {
    increments[`partners.${partnerUid}`] = 1;
    increments[`dailyStats.${dayKey}.partners.${partnerUid}`] = 1;
  });

  return {
    increments,
    absolutes: {
      sequenciaAtualSemMorte: newStreak,
      maxSequenciaSemMorte: newMax,
      rankingScore,
      rankingUpdatedAt: now,
    },
  };
}