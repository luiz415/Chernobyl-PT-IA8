import {
  collection,
  doc,
  getDoc,
  getDocs,
  runTransaction,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import { db } from "../firebase/config";

// ============================================================================
// RESET MENSAL DO RANKING
//
// Sem Cloud Functions: a verificação roda quando um Boss abre o painel Ranking.
//
// IMPORTANTE — o reset é LÓGICO, não destrutivo:
//   - "Mês Atual" é derivado de `dailyStats`, agregando apenas os dias do mês
//     UTC corrente. Virou o mês, o acumulado zera sozinho.
//   - "Último Mês" lê o snapshot imutável salvo em `rankingHistory/{YYYY-MM}`.
//
// Nenhum campo de `userStats` é apagado. Os totais vitalícios continuam
// alimentando rankingScore, marcos, StatsPanel e Visão Geral exatamente como
// antes. Isso atende "não perder dados" e preserva os cálculos existentes.
// ============================================================================

export const RANKING_RESET_SETTINGS_ID = "ranking_reset";
export const RANKING_HISTORY_COLLECTION = "rankingHistory";

/** Bucket diário gravado por `persistUserStats` (chave = dia UTC). */
export interface DailyStatsBucket {
  totalPtsConcluidas?: number;
  totalPtsSoulwar?: number;
  totalPtsSanguine?: number;
  totalMortes?: number;
  totalDuracaoMs?: number;
  totalParticipacoes?: number;
  services?: number;
  ptsSemMorte?: number;
  ptsComMorte?: number;
  servers?: Record<string, number>;
  partners?: Record<string, number>;
}

/** Entrada do snapshot mensal — espelha o que o Ranking exibe. */
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

export interface RankingHistoryDoc {
  monthKey: string;
  entries: RankingHistoryEntry[];
  totalPlayers: number;
  generatedAtMs: number;
  generatedByUid: string;
}

export interface RankingResetMeta {
  firstRankingReset?: boolean;
  firstRankingResetAt?: any;
  lastRankingResetMonth?: string;
  lastRankingResetAt?: any;
  lastRankingResetAtMs?: number;
  lastHistoryMonth?: string;
  /**
   * true após a primeira execução da Cloud Function agendada
   * (scheduledRankingReset): o quadro "Mês Atual" passa a ler os docs
   * consolidados `rankingMonthly/{mês}/users` em vez do top-N vitalício de
   * userStats agregado no cliente.
   */
  rankingMonthlyActive?: boolean;
}

export interface EnsureResetResult {
  /** true quando ESTA chamada executou o reset. */
  didReset: boolean;
  /** true quando nada precisava ser feito (mês já resetado). */
  skipped: boolean;
  /** Mês UTC que passou a constar como resetado. */
  monthKey: string;
  /** Mês arquivado em rankingHistory (null quando não houve o que arquivar). */
  archivedMonthKey: string | null;
  meta: RankingResetMeta | null;
  error?: string;
}

/** Chave de mês UTC no formato `YYYY-MM`. */
export function getUtcMonthKey(date: Date = new Date()): string {
  return date.toISOString().slice(0, 7);
}

/**
 * Mês anterior a `monthKey`, tratando a virada de ano.
 * "2026-01" -> "2025-12"
 */
export function getPreviousMonthKey(monthKey: string): string {
  const [yearRaw, monthRaw] = String(monthKey).split("-");
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return monthKey;
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  return `${String(prevYear).padStart(4, "0")}-${String(prevMonth).padStart(2, "0")}`;
}

/** `true` quando o dia (`YYYY-MM-DD`) pertence ao mês (`YYYY-MM`). */
export function isDayInMonth(dayKey: string, monthKey: string): boolean {
  return typeof dayKey === "string" && dayKey.slice(0, 7) === monthKey;
}

/** Quantidade de dias do mês (`YYYY-MM`), já tratando anos bissextos. */
export function getDaysInMonth(monthKey: string): number {
  const [yearRaw, monthRaw] = String(monthKey).split("-");
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return 30;
  // Dia 0 do mês seguinte = último dia do mês pedido.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Dias decorridos do mês UTC corrente (mínimo 1).
 * Base honesta para "PT's por dia" no recorte "Mês Atual".
 */
export function getElapsedDaysInCurrentMonth(now: Date = new Date()): number {
  return Math.max(1, now.getUTCDate());
}

/**
 * `true` quando o recorte mensal não encontrou NENHUM bucket diário.
 *
 * Distingue "o usuário não jogou neste mês" de "este usuário não possui
 * histórico diário" — PTs concluídas antes de `dailyStats` existir só
 * aparecem nos totais vitalícios de `userStats`.
 */
export function hasNoDailyDataForMonth(
  dailyStats: Record<string, DailyStatsBucket> | undefined,
  monthKey: string,
): boolean {
  return !Object.keys(dailyStats || {}).some(day => isDayInMonth(day, monthKey));
}

/**
 * `true` quando o documento NÃO tem nenhum bucket diário registrado.
 *
 * Nesse caso o histórico por dia nunca foi alimentado para esse usuário, e o
 * recorte mensal produziria uma linha de zeros apesar de haver totais reais.
 */
export function hasNoDailyHistoryAtAll(dailyStats: Record<string, DailyStatsBucket> | undefined): boolean {
  return Object.keys(dailyStats || {}).length === 0;
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

/**
 * Agrega os buckets diários de um mês UTC específico.
 * `dailyStats` é sempre gravado com chave UTC (`toISOString().slice(0,10)`),
 * então o recorte mensal é exato — sem depender do fuso do cliente.
 */
export function aggregateMonthFromDaily(
  dailyStats: Record<string, DailyStatsBucket> | undefined,
  monthKey: string,
): Omit<RankingHistoryEntry, "uid" | "nome" | "sequenciaAtualSemMorte" | "maxSequenciaSemMorte" | "totalRcDoadoAprovado"> {
  const acc = {
    score: 0,
    concluidas: 0,
    totalParticipacoes: 0,
    totalMortes: 0,
    totalDuracaoMs: 0,
    totalPtsSoulwar: 0,
    totalPtsSanguine: 0,
    ptsSemMorte: 0,
    ptsComMorte: 0,
    servers: {} as Record<string, number>,
    partners: {} as Record<string, number>,
    services: 0,
  };

  Object.entries(dailyStats || {}).forEach(([day, bucket]) => {
    if (!isDayInMonth(day, monthKey)) return;
    acc.concluidas += bucket.totalPtsConcluidas || 0;
    acc.totalPtsSoulwar += bucket.totalPtsSoulwar || 0;
    acc.totalPtsSanguine += bucket.totalPtsSanguine || 0;
    acc.totalMortes += bucket.totalMortes || 0;
    acc.totalDuracaoMs += bucket.totalDuracaoMs || 0;
    acc.totalParticipacoes += bucket.totalParticipacoes || 0;
    acc.services += bucket.services || 0;
    acc.ptsSemMorte += bucket.ptsSemMorte || 0;
    acc.ptsComMorte += bucket.ptsComMorte || 0;
    Object.entries(bucket.servers || {}).forEach(([srv, count]) => {
      acc.servers[srv] = (acc.servers[srv] || 0) + count;
    });
    Object.entries(bucket.partners || {}).forEach(([uid, count]) => {
      acc.partners[uid] = (acc.partners[uid] || 0) + count;
    });
  });

  acc.score = computeScopedScore(acc);
  return acc;
}

/**
 * Reabre a tentativa de reset do mês corrente (uso do Boss).
 *
 * Limpa apenas `lastRankingResetMonth`, fazendo a próxima abertura do painel
 * tentar arquivar o mês anterior de novo. `firstRankingReset` e
 * `firstRankingResetAt` são preservados — nunca devem mudar.
 *
 * Necessário porque uma versão anterior marcava o mês como resetado mesmo
 * quando não havia snapshot a gravar, travando a idempotência.
 */
export async function reopenRankingResetAttempt(): Promise<{ ok: boolean; error?: string }> {
  if (!db) return { ok: false, error: "Firestore indisponível." };
  try {
    const ref = doc(db, "settings", RANKING_RESET_SETTINGS_ID);
    await runTransaction(db, async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists()) return;
      tx.set(ref, {
        lastRankingResetMonth: "",
        reopenedAt: serverTimestamp(),
        reopenedAtMs: Date.now(),
      }, { merge: true });
    });
    return { ok: true };
  } catch (error: any) {
    return { ok: false, error: error?.message || String(error) };
  }
}

/** Lê os metadados do reset. Uma leitura. */
export async function readRankingResetMeta(): Promise<RankingResetMeta | null> {
  if (!db) return null;
  try {
    const snap = await getDoc(doc(db, "settings", RANKING_RESET_SETTINGS_ID));
    return snap.exists() ? (snap.data() as RankingResetMeta) : null;
  } catch {
    return null;
  }
}

/** Lê o snapshot de um mês. Uma leitura, feita no máximo uma vez por sessão. */
export async function readRankingHistory(monthKey: string): Promise<RankingHistoryDoc | null> {
  if (!db || !monthKey) return null;
  try {
    const snap = await getDoc(doc(db, RANKING_HISTORY_COLLECTION, monthKey));
    if (!snap.exists()) return null;
    const data = snap.data() as RankingHistoryDoc;
    return { ...data, entries: Array.isArray(data.entries) ? data.entries : [] };
  } catch {
    return null;
  }
}

/**
 * Monta o snapshot do mês encerrado lendo TODOS os `userStats`.
 * Operação exclusiva do Boss e, no máximo, uma vez por mês.
 */
async function buildMonthSnapshot(monthKey: string, userNames: Record<string, string>): Promise<RankingHistoryEntry[]> {
  if (!db) return [];
  const snap = await getDocs(collection(db, "userStats"));
  const entries: RankingHistoryEntry[] = [];

  snap.forEach(docSnap => {
    const data = docSnap.data() as any;
    const daily = (data?.dailyStats && typeof data.dailyStats === "object")
      ? data.dailyStats as Record<string, DailyStatsBucket>
      : {};
    const scoped = aggregateMonthFromDaily(daily, monthKey);
    // Sem atividade no mês encerrado: fora do histórico (mantém o doc enxuto).
    if (scoped.concluidas === 0 && scoped.totalParticipacoes === 0 && scoped.totalMortes === 0) return;

    entries.push({
      uid: docSnap.id,
      nome: userNames[docSnap.id] || data?._nome || `Jogador ${docSnap.id.slice(0, 6)}`,
      ...scoped,
      sequenciaAtualSemMorte: 0,
      maxSequenciaSemMorte: typeof data?.maxSequenciaSemMorte === "number" ? data.maxSequenciaSemMorte : 0,
      totalRcDoadoAprovado: typeof data?.totalRcDoadoAprovado === "number" ? data.totalRcDoadoAprovado : 0,
    });
  });

  entries.sort((a, b) => b.score - a.score);
  return entries;
}

/**
 * Verifica e, se necessário, executa o reset mensal.
 *
 * Ordem (interrompe em qualquer falha, sem estado parcial):
 *  1. confirma Boss;
 *  2. calcula o mês UTC corrente;
 *  3. lê os metadados — se o mês já foi resetado, encerra sem escrever;
 *  4. monta e grava o snapshot do mês anterior;
 *  5. confirma por releitura que o snapshot está no Firestore;
 *  6. só então atualiza os metadados, dentro de uma transação que revalida o
 *     mês (impede reset duplo em concorrência entre Bosses).
 *
 * Falhou antes do passo 6? Os metadados não mudam e a próxima abertura do
 * painel tenta de novo.
 */
export async function ensureMonthlyRankingReset(params: {
  isBoss: boolean;
  currentUserUid: string;
  userNames?: Record<string, string>;
  now?: Date;
  /**
   * Conclui o reset mesmo sem nada a arquivar. Use apenas no primeiro uso
   * real, quando de fato não existe mês anterior a preservar.
   */
  allowResetWithoutHistory?: boolean;
}): Promise<EnsureResetResult> {
  const monthKey = getUtcMonthKey(params.now || new Date());
  const base: EnsureResetResult = { didReset: false, skipped: true, monthKey, archivedMonthKey: null, meta: null };

  // 1. Somente Boss dispara o reset.
  if (!params.isBoss) return base;
  if (!db) return { ...base, error: "Firestore indisponível." };

  try {
    // 3. Metadados atuais.
    const meta = await readRankingResetMeta();
    if (meta?.lastRankingResetMonth === monthKey) {
      // Já resetado neste mês: nenhuma escrita.
      return { ...base, meta };
    }

    // 4. Snapshot do mês encerrado.
    const previousMonthKey = getPreviousMonthKey(monthKey);
    const historyRef = doc(db, RANKING_HISTORY_COLLECTION, previousMonthKey);
    const existingHistory = await getDoc(historyRef);

    let archivedMonthKey: string | null = null;
    if (existingHistory.exists()) {
      // Histórico antigo nunca é sobrescrito.
      archivedMonthKey = previousMonthKey;
    } else {
      const entries = await buildMonthSnapshot(previousMonthKey, params.userNames || {});
      if (entries.length > 0) {
        const payload: RankingHistoryDoc = {
          monthKey: previousMonthKey,
          entries,
          totalPlayers: entries.length,
          generatedAtMs: Date.now(),
          generatedByUid: params.currentUserUid || "",
        };
        await setDoc(historyRef, { ...payload, generatedAt: serverTimestamp() });

        // 5. Confirmação: sem snapshot gravado, não se atualiza metadado algum.
        const confirm = await getDoc(historyRef);
        if (!confirm.exists()) {
          return { ...base, skipped: false, meta, error: "Snapshot do mês anterior não pôde ser confirmado." };
        }
        archivedMonthKey = previousMonthKey;
      } else if (!params.allowResetWithoutHistory) {
        // NÃO marcar o mês como resetado quando não houve nada a arquivar.
        //
        // Motivo: `dailyStats` pode ainda não ter sido populado no mês
        // encerrado. Se gravássemos o metadado aqui, a idempotência bloquearia
        // qualquer nova tentativa e o mês ficaria permanentemente sem
        // histórico. Preferimos deixar o reset em aberto para tentar de novo.
        //
        // `allowResetWithoutHistory` permite destravar de propósito (primeiro
        // uso real do sistema, quando de fato não existe mês anterior).
        return {
          ...base,
          skipped: false,
          meta,
          error: `Nenhum dado diário encontrado para ${previousMonthKey}; o reset ficará pendente para nova tentativa.`,
        };
      }
    }

    // 6. Metadados — transação revalida o mês (concorrência entre Bosses).
    const settingsRef = doc(db, "settings", RANKING_RESET_SETTINGS_ID);
    let claimed = false;
    await runTransaction(db, async tx => {
      const snap = await tx.get(settingsRef);
      const current = snap.exists() ? (snap.data() as RankingResetMeta) : null;
      if (current?.lastRankingResetMonth === monthKey) return; // outro Boss ganhou.

      const payload: Record<string, any> = {
        lastRankingResetMonth: monthKey,
        lastRankingResetAt: serverTimestamp(),
        lastRankingResetAtMs: Date.now(),
      };
      if (archivedMonthKey) payload.lastHistoryMonth = archivedMonthKey;
      // `firstRankingReset` é gravado UMA única vez e nunca mais alterado.
      if (!current?.firstRankingReset) {
        payload.firstRankingReset = true;
        payload.firstRankingResetAt = serverTimestamp();
      }
      tx.set(settingsRef, payload, { merge: true });
      claimed = true;
    });

    const finalMeta = await readRankingResetMeta();
    return {
      didReset: claimed,
      skipped: !claimed,
      monthKey,
      archivedMonthKey,
      meta: finalMeta,
    };
  } catch (error: any) {
    return { ...base, skipped: false, error: error?.message || String(error) };
  }
}

/** "01/08/2026 00:03 UTC" a partir do que está salvo no Firestore. */
export function formatResetTimestampUtc(meta: RankingResetMeta | null): string {
  if (!meta) return "";
  const raw = meta.lastRankingResetAt;
  let ms = 0;
  if (raw && typeof raw?.toDate === "function") ms = raw.toDate().getTime();
  else if (typeof raw?.seconds === "number") ms = raw.seconds * 1000;
  else if (typeof meta.lastRankingResetAtMs === "number") ms = meta.lastRankingResetAtMs;
  if (!ms || !Number.isFinite(ms)) return "";

  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}