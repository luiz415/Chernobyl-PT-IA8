/**
 * Núcleo puro do Ranking consolidado e do reset mensal (backend).
 * ============================================================================
 *
 * Duas responsabilidades, ambas derivadas dos MESMOS dados que o frontend já
 * usa (`userStats` + `dailyStats` com chaves de dia UTC):
 *
 *   1. CONSOLIDAÇÃO MENSAL — coleção `rankingMonthly/{YYYY-MM}/users/{uid}`:
 *      documento pequeno por usuário/mês com o agregado do período. Alimenta
 *      o quadro "Mês Atual" do painel (orderBy score, sem ler os documentos
 *      completos de userStats, que carregam TODO o histórico diário) e passa
 *      a cobrir TODOS os usuários ativos no mês — hoje o painel lê o top-N
 *      vitalício e agrega no cliente, escondendo usuários ativos fora desse
 *      recorte.
 *
 *      Escrita por dois caminhos intercambiáveis:
 *        - TRANSAÇÃO de stats (materializePartySettlement): atualiza o doc do
 *          mês na MESMA transação idempotente de userStats (tempo real);
 *        - RECONCILIAÇÃO diária (scheduledRankingReset): reconstrói o doc do
 *          mês corrente a partir de `dailyStats` — valor absoluto, o que
 *          torna a coleção um CACHE AUTOCORRIGÍVEL: qualquer divergência
 *          (commit do fallback do frontend, escrita atrasada, falha) some no
 *          dia seguinte.
 *
 *   2. RESET MENSAL — snapshot imutável `rankingHistory/{YYYY-MM}` +
 *      metadados em `settings/ranking_reset`. Espelha EXATAMENTE a semântica
 *      do `ensureMonthlyRankingReset` do frontend (rankingResetService.ts),
 *      que permanece como fallback: histórico antigo nunca é sobrescrito,
 *      metadado avança apenas em transação que revalida o mês, mês sem
 *      atividade não gera snapshot e não avança o metadado.
 *
 * Não depende de Firebase nem React — testável via tools/ranking-reset-tests.
 */
import type { LifecycleParty } from "./partyLifecycleCore.js";
import type { ParticipantStatsInfo } from "./partyStatsCore.js";

/** Campos exibidos no quadro mensal (espelham RankingHistoryEntry). */
export interface MonthlyRankingDoc {
  uid: string;
  legacy: boolean;
  score: number;
  concluidas: number;
  totalParticipacoes: number;
  totalMortes: number;
  totalDuracaoMs: number;
  totalPtsSoulwar: number;
  totalPtsSanguine: number;
  ptsSemMorte: number;
  ptsComMorte: number;
  services: number;
  sequenciaAtualSemMorte: number;
  maxSequenciaSemMorte: number;
  totalRcDoadoAprovado: number;
  servers: Record<string, number>;
  partners: Record<string, number>;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function counterMap(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  const out: Record<string, number> = {};
  Object.entries(value).forEach(([key, count]) => {
    if (typeof count === "number" && Number.isFinite(count)) out[key] = count;
  });
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Meses (UTC) — mesmas regras do rankingResetService.ts
// ─────────────────────────────────────────────────────────────────────────────

export function getUtcMonthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}

export function getPreviousMonthKey(monthKey: string): string {
  const [yearRaw, monthRaw] = String(monthKey).split("-");
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return monthKey;
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  return `${String(prevYear).padStart(4, "0")}-${String(prevMonth).padStart(2, "0")}`;
}

export function getNextMonthKey(monthKey: string): string {
  const [yearRaw, monthRaw] = String(monthKey).split("-");
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return monthKey;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  return `${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}`;
}

export function isDayInMonth(dayKey: string, monthKey: string): boolean {
  return typeof dayKey === "string" && dayKey.slice(0, 7) === monthKey;
}

export function getDaysInMonth(monthKey: string): number {
  const [yearRaw, monthRaw] = String(monthKey).split("-");
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return 30;
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Lista ascendente de meses em (fromInclusive..toInclusive], com teto de 24. */
export function listMonthsRange(fromInclusive: string, toInclusive: string): string[] {
  const out: string[] = [];
  let cursor = fromInclusive;
  let guard = 0;
  while (cursor < toInclusive && guard < 24) {
    cursor = getNextMonthKey(cursor);
    guard += 1;
    out.push(cursor);
  }
  return out;
}

export function hasNoDailyHistoryAtAll(dailyStats: UnknownRecord | undefined): boolean {
  return Object.keys(dailyStats || {}).length === 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Agregação mensal — porta EXATA de aggregateMonthFromDaily/computeScopedScore
// (src/services/rankingResetService.ts). Paridade verificada em testes.
// ─────────────────────────────────────────────────────────────────────────────

export interface ScopedMonthAggregate {
  score: number;
  concluidas: number;
  totalParticipacoes: number;
  totalMortes: number;
  totalDuracaoMs: number;
  totalPtsSoulwar: number;
  totalPtsSanguine: number;
  ptsSemMorte: number;
  ptsComMorte: number;
  services: number;
  servers: Record<string, number>;
  partners: Record<string, number>;
}

export function computeScopedScore(input: {
  concluidas: number;
  totalParticipacoes: number;
  ptsSemMorte: number;
  totalMortes: number;
  totalDuracaoMs: number;
  totalPtsSoulwar: number;
  totalPtsSanguine: number;
}): number {
  const base = (input.concluidas * 10) + (input.totalParticipacoes * 3) + (input.ptsSemMorte * 5);
  const penalty = input.totalMortes * 2;
  const horasScore = Math.floor(input.totalDuracaoMs / 3_600_000) * 2;
  const questScore = input.totalPtsSoulwar + (input.totalPtsSanguine * 2);
  return Math.max(0, base - penalty + horasScore + questScore);
}

export function aggregateMonthFromDaily(
  dailyStats: UnknownRecord | undefined,
  monthKey: string,
): ScopedMonthAggregate {
  const acc: ScopedMonthAggregate = {
    score: 0,
    concluidas: 0,
    totalParticipacoes: 0,
    totalMortes: 0,
    totalDuracaoMs: 0,
    totalPtsSoulwar: 0,
    totalPtsSanguine: 0,
    ptsSemMorte: 0,
    ptsComMorte: 0,
    services: 0,
    servers: {},
    partners: {},
  };
  Object.entries(dailyStats || {}).forEach(([day, rawBucket]) => {
    if (!isDayInMonth(day, monthKey) || !isRecord(rawBucket)) return;
    const bucket = rawBucket;
    acc.concluidas += num(bucket.totalPtsConcluidas);
    acc.totalPtsSoulwar += num(bucket.totalPtsSoulwar);
    acc.totalPtsSanguine += num(bucket.totalPtsSanguine);
    acc.totalMortes += num(bucket.totalMortes);
    acc.totalDuracaoMs += num(bucket.totalDuracaoMs);
    acc.totalParticipacoes += num(bucket.totalParticipacoes);
    acc.services += num(bucket.services);
    acc.ptsSemMorte += num(bucket.ptsSemMorte);
    acc.ptsComMorte += num(bucket.ptsComMorte);
    Object.entries(counterMap(bucket.servers)).forEach(([srv, count]) => {
      acc.servers[srv] = (acc.servers[srv] || 0) + count;
    });
    Object.entries(counterMap(bucket.partners)).forEach(([uid, count]) => {
      acc.partners[uid] = (acc.partners[uid] || 0) + count;
    });
  });
  acc.score = computeScopedScore(acc);
  return acc;
}

// ─────────────────────────────────────────────────────────────────────────────
// Consolidação mensal — docs rankingMonthly/{YYYY-MM}/users/{uid}
// ─────────────────────────────────────────────────────────────────────────────

function emptyMonthlyDoc(uid: string): MonthlyRankingDoc {
  return {
    uid,
    legacy: false,
    score: 0,
    concluidas: 0,
    totalParticipacoes: 0,
    totalMortes: 0,
    totalDuracaoMs: 0,
    totalPtsSoulwar: 0,
    totalPtsSanguine: 0,
    ptsSemMorte: 0,
    ptsComMorte: 0,
    services: 0,
    sequenciaAtualSemMorte: 0,
    maxSequenciaSemMorte: 0,
    totalRcDoadoAprovado: 0,
    servers: {},
    partners: {},
  };
}

/**
 * Doc consolidado do mês corrente derivado de userStats (reconciliação).
 * Retorna null quando o usuário não teve atividade no mês (sem doc — o quadro
 * mensal lista apenas quem jogou no período).
 *
 * LEGADO: usuário sem NENHUM bucket diário exibia totais vitalícios no quadro
 * mensal (fallback do painel). A reconciliação reproduz esse fallback com
 * `legacy: true` para que a transação de stats saiba recomeçar do zero
 * assim que o primeiro bucket diário existir.
 */
export function buildMonthlyDocFromUserStats(
  uid: string,
  data: UnknownRecord,
  monthKey: string,
): MonthlyRankingDoc | null {
  const daily = isRecord(data.dailyStats) ? data.dailyStats : undefined;
  if (hasNoDailyHistoryAtAll(daily)) {
    return {
      ...emptyMonthlyDoc(uid),
      legacy: true,
      score: num(data.rankingScore),
      concluidas: num(data.totalPtsConcluidas),
      totalParticipacoes: num(data.totalParticipacoes) || num(data.totalPtsConcluidas),
      totalMortes: num(data.totalMortes),
      totalDuracaoMs: num(data.totalDuracaoMs),
      totalPtsSoulwar: num(data.totalPtsSoulwar),
      totalPtsSanguine: num(data.totalPtsSanguine),
      ptsSemMorte: num(data.ptsSemMorte),
      ptsComMorte: num(data.ptsComMorte),
      services: num(data.services),
      maxSequenciaSemMorte: num(data.maxSequenciaSemMorte),
      totalRcDoadoAprovado: num(data.totalRcDoadoAprovado),
      servers: counterMap(data.servers),
      partners: counterMap(data.partners),
    };
  }
  const scoped = aggregateMonthFromDaily(daily, monthKey);
  if (scoped.concluidas === 0 && scoped.totalParticipacoes === 0 && scoped.totalMortes === 0) {
    return null;
  }
  return {
    ...emptyMonthlyDoc(uid),
    ...scoped,
    maxSequenciaSemMorte: num(data.maxSequenciaSemMorte),
  };
}

/**
 * Aplica os deltas de uma PT concluída ao doc consolidado do mês da Quest
 * (mesma transação idempotente de userStats — o marcador processedParties
 * garante 1× por usuário por PT). Base zerada quando o doc não existe ou é
 * legado (usuário ganhou histórico diário com esta própria PT).
 */
export function applyPartyToMonthlyDoc(
  current: UnknownRecord | undefined,
  info: ParticipantStatsInfo,
  party: LifecycleParty,
  newMaxSequenciaSemMorte: number,
): MonthlyRankingDoc {
  const uid = info.uid;
  const base = current && current.legacy !== true
    ? {
      score: num(current.score),
      concluidas: num(current.concluidas),
      totalParticipacoes: num(current.totalParticipacoes),
      totalMortes: num(current.totalMortes),
      totalDuracaoMs: num(current.totalDuracaoMs),
      totalPtsSoulwar: num(current.totalPtsSoulwar),
      totalPtsSanguine: num(current.totalPtsSanguine),
      ptsSemMorte: num(current.ptsSemMorte),
      ptsComMorte: num(current.ptsComMorte),
      services: num(current.services),
      servers: counterMap(current.servers),
      partners: counterMap(current.partners),
    }
    : {
      score: 0, concluidas: 0, totalParticipacoes: 0, totalMortes: 0, totalDuracaoMs: 0,
      totalPtsSoulwar: 0, totalPtsSanguine: 0, ptsSemMorte: 0, ptsComMorte: 0,
      services: 0, servers: {}, partners: {},
    };

  const isSoulwar = party.questType === "soulwar";
  const isSanguine = party.questType === "sanguine";
  const semMorte = info.deaths === 0;
  const servidor = (party.server || "").trim();

  const next: MonthlyRankingDoc = {
    ...emptyMonthlyDoc(uid),
    concluidas: base.concluidas + 1,
    totalParticipacoes: base.totalParticipacoes + info.participations,
    totalMortes: base.totalMortes + info.deaths,
    totalDuracaoMs: base.totalDuracaoMs + party.durationMs,
    totalPtsSoulwar: base.totalPtsSoulwar + (isSoulwar ? 1 : 0),
    totalPtsSanguine: base.totalPtsSanguine + (isSanguine ? 1 : 0),
    ptsSemMorte: base.ptsSemMorte + (semMorte ? 1 : 0),
    ptsComMorte: base.ptsComMorte + (semMorte ? 0 : 1),
    services: base.services + info.services,
    maxSequenciaSemMorte: newMaxSequenciaSemMorte,
    servers: { ...base.servers },
    partners: { ...base.partners },
  };
  if (servidor) next.servers[servidor] = (next.servers[servidor] || 0) + 1;
  info.partnerUids.forEach(partnerUid => {
    next.partners[partnerUid] = (next.partners[partnerUid] || 0) + 1;
  });
  next.score = computeScopedScore(next);
  return next;
}

/** Compara o doc existente com o desejado (updatedAt fora da comparação). */
export function monthlyDocNeedsRewrite(
  existing: UnknownRecord | undefined,
  desired: MonthlyRankingDoc,
): boolean {
  if (!existing) return true;
  if ((existing.legacy === true) !== (desired.legacy === true)) return true;
  const keys: Array<keyof MonthlyRankingDoc> = [
    "score", "concluidas", "totalParticipacoes", "totalMortes",
    "totalDuracaoMs", "totalPtsSoulwar", "totalPtsSanguine", "ptsSemMorte",
    "ptsComMorte", "services", "sequenciaAtualSemMorte", "maxSequenciaSemMorte",
    "totalRcDoadoAprovado",
  ];
  if (keys.some(key => num(existing[key]) !== desired[key])) return true;
  const servers = counterMap(existing.servers);
  const partners = counterMap(existing.partners);
  if (Object.keys(servers).length !== Object.keys(desired.servers).length) return true;
  if (Object.keys(partners).length !== Object.keys(desired.partners).length) return true;
  return Object.entries(desired.servers).some(([k, v]) => servers[k] !== v)
    || Object.entries(desired.partners).some(([k, v]) => partners[k] !== v);
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot do mês encerrado — porta EXATA de buildMonthSnapshot (frontend)
// ─────────────────────────────────────────────────────────────────────────────

export interface RankingHistoryEntry {
  uid: string;
  nome: string;
  score: number;
  concluidas: number;
  totalParticipacoes: number;
  totalMortes: number;
  totalDuracaoMs: number;
  totalPtsSoulwar: number;
  totalPtsSanguine: number;
  ptsSemMorte: number;
  ptsComMorte: number;
  sequenciaAtualSemMorte: number;
  maxSequenciaSemMorte: number;
  servers: Record<string, number>;
  partners: Record<string, number>;
  totalRcDoadoAprovado: number;
  services: number;
}

/**
 * Monta as entradas do snapshot de um mês encerrado a partir dos docs de
 * userStats. Sem atividade no mês → fora do snapshot (doc enxuto), igual ao
 * buildMonthSnapshot do frontend. Ordenado por score.
 */
export function buildMonthSnapshotEntries(
  statsDocs: Array<{ uid: string; data: UnknownRecord }>,
  monthKey: string,
  uidToName: ReadonlyMap<string, string>,
): RankingHistoryEntry[] {
  const entries: RankingHistoryEntry[] = [];
  statsDocs.forEach(({ uid, data }) => {
    const daily = isRecord(data.dailyStats) ? data.dailyStats : undefined;
    const scoped = aggregateMonthFromDaily(daily, monthKey);
    if (scoped.concluidas === 0 && scoped.totalParticipacoes === 0 && scoped.totalMortes === 0) return;
    entries.push({
      uid,
      nome: uidToName.get(uid) || String(data._nome || `Jogador ${uid.slice(0, 6)}`),
      ...scoped,
      sequenciaAtualSemMorte: 0,
      maxSequenciaSemMorte: num(data.maxSequenciaSemMorte),
      totalRcDoadoAprovado: num(data.totalRcDoadoAprovado),
    });
  });
  entries.sort((a, b) => b.score - a.score);
  return entries;
}

/**
 * Meses que ainda precisam ser arquivados: do mês do último reset registrado
 * (INCLUSIVE — seus próprios dados só são arquivados no reset seguinte) até o
 * mês anterior ao corrente, ignorando os que já possuem snapshot. Sem último
 * reset (primeiro uso), apenas o mês imediatamente anterior. Teto de 24 meses
 * protege contra metadado corrompido.
 */
export function listMonthsToArchive(
  fromInclusive: string,
  currentMonthKey: string,
  archivedMonths: ReadonlySet<string>,
): string[] {
  const end = getPreviousMonthKey(currentMonthKey);
  const start = fromInclusive || end;
  if (start > end) return []; // metadado à frente do relógio — nada a arquivar
  const all = start === end ? [start] : [start, ...listMonthsRange(start, end)];
  return all.filter(month => !archivedMonths.has(month));
}