import { useState, useEffect, useRef, useMemo } from "react";
import {
  Trophy,
  ChevronDown,
  ChevronUp,
  Shield,
  Clock,
  Zap,
  Award,
  Server,
  ArrowDown,
  UserPlus,
  Star,
  Flame,
  Activity
} from "lucide-react";
import {
  collection,
  query,
  orderBy,
  limit as fireLimit,
  startAfter,
  getDocs,
  getCountFromServer,
  where,
  type DocumentData,
  type QueryDocumentSnapshot
} from "firebase/firestore";
import { db, isSimulationMode } from "../firebase/config";
import { useAuth } from "../context/AuthContext";
import {
  aggregateMonthFromDaily,
  ensureMonthlyRankingReset,
  formatResetTimestampUtc,
  getDaysInMonth,
  getElapsedDaysInCurrentMonth,
  getPreviousMonthKey,
  getUtcMonthKey,
  hasNoDailyHistoryAtAll,
  readRankingHistory,
  readRankingResetMeta,
  type RankingHistoryDoc,
  type RankingHistoryEntry,
  type RankingResetMeta,
} from "../services/rankingResetService";

interface DailyStatsBucket {
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

export interface RankingEntry {
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
  ultimaAtualizacao?: any;
  totalRcDoadoAprovado: number;
  services: number;
  dailyStats?: Record<string, DailyStatsBucket>;
}

interface RankingPanelProps {
  currentUserUid: string;
  userNames?: Record<string, string>;
  userStatsDoc?: Record<string, any> | null;
  displayUserName?: string;
}

const PAGE_SIZE = 20;
const RANKING_CACHE_KEY = "ranking_panel_initial_cache";
const RANKING_CACHE_TS_KEY = "ranking_panel_initial_cache_ts";
const RANKING_CACHE_TTL_MS = 10 * 60 * 1000;

export default function RankingPanel({
  currentUserUid,
  userNames = {},
  userStatsDoc = null,
  displayUserName = "Anônimo",
}: RankingPanelProps) {
  const { allUsers, userProfile } = useAuth();
  const userRoles = useMemo(() => {
    const map: Record<string, string> = {};
    (allUsers || []).forEach(u => {
      if (u.uid && u.role) map[u.uid] = u.role;
    });
    return map;
  }, [allUsers]);

  type RankingMode = "geral" | "menos_mortes" | "streak" | "quests" | "menor_duracao" | "pts_dia";
  const [rankingMode, setRankingMode] = useState<RankingMode>("geral");
  const [entries, setEntries] = useState<RankingEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [expandedTotalUid, setExpandedTotalUid] = useState<string | null>(null);
  const [expandedRecentUid, setExpandedRecentUid] = useState<string | null>(null);
  const [myExactPosition, setMyExactPosition] = useState<number | null>(null);

  // ─── Reset mensal / histórico ───────────────────────────────────────────
  const isBossUser = userProfile?.role === "Boss";
  // Mês UTC corrente — base do recorte "Mês Atual".
  const currentMonthKey = useMemo(() => getUtcMonthKey(), []);
  const [resetMeta, setResetMeta] = useState<RankingResetMeta | null>(null);
  const [historyDoc, setHistoryDoc] = useState<RankingHistoryDoc | null>(null);
  // Aviso exibido só ao Boss quando o reset fica pendente.
  const [resetNotice, setResetNotice] = useState<string>("");
  // Guarda de sessão: impede leituras/resets repetidos ao reabrir o painel.
  const resetCheckedRef = useRef(false);
  // Modo do quadro "Mês Atual": true = docs consolidados rankingMonthly
  // (backend migrado); false = caminho legado (userStats + agregação cliente).
  // null enquanto os metadados não foram lidos na sessão.
  const monthlyModeRef = useRef<boolean | null>(null);

  const lastDocRef = useRef<QueryDocumentSnapshot<DocumentData, DocumentData> | null>(null);

  // Helper de conversão de tempo
  function formatDur(ms: number): string {
    if (!ms || ms <= 0) return "—";
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    if (h < 1) return `${m}m`;
    if (h < 24) return `${h}h${m > 0 ? m + "m" : ""}`;
    const d = Math.floor(h / 24);
    const rh = h % 24;
    return `${d}d${rh > 0 ? rh + "h" : ""}`;
  }

  // Parse de documento do Firestore
  function parseDoc(docSnap: QueryDocumentSnapshot<DocumentData, DocumentData>): RankingEntry | null {
    const data = docSnap.data();
    if (typeof data.rankingScore !== "number") return null;
    return {
      uid: docSnap.id,
      nome: userNames[docSnap.id] || data._nome || `Jogador ${docSnap.id.slice(0, 6)}`,
      score: data.rankingScore || 0,
      concluidas: typeof data.totalPtsConcluidas === "number" ? data.totalPtsConcluidas : 0,
      totalParticipacoes: typeof data.totalParticipacoes === "number" ? data.totalParticipacoes : (data.totalPtsConcluidas || 0),
      totalMortes: typeof data.totalMortes === "number" ? data.totalMortes : 0,
      totalDuracaoMs: typeof data.totalDuracaoMs === "number" ? data.totalDuracaoMs : 0,
      totalPtsSoulwar: typeof data.totalPtsSoulwar === "number" ? data.totalPtsSoulwar : 0,
      totalPtsSanguine: typeof data.totalPtsSanguine === "number" ? data.totalPtsSanguine : 0,
      ptsSemMorte: typeof data.ptsSemMorte === "number" ? data.ptsSemMorte : 0,
      ptsComMorte: typeof data.ptsComMorte === "number" ? data.ptsComMorte : 0,
      sequenciaAtualSemMorte: typeof data.sequenciaAtualSemMorte === "number" ? data.sequenciaAtualSemMorte : 0,
      maxSequenciaSemMorte: typeof data.maxSequenciaSemMorte === "number" ? data.maxSequenciaSemMorte : 0,
      servers: (data.servers && typeof data.servers === "object") ? data.servers as Record<string, number> : {},
      partners: (data.partners && typeof data.partners === "object") ? data.partners as Record<string, number> : {},
      ultimaAtualizacao: data.ultimaAtualizacao,
      totalRcDoadoAprovado: typeof data.totalRcDoadoAprovado === "number" ? data.totalRcDoadoAprovado : 0,
      services: typeof data.services === "number" ? data.services : 0,
      dailyStats: (data.dailyStats && typeof data.dailyStats === "object") ? data.dailyStats as Record<string, DailyStatsBucket> : {},
    };
  }

  function readRankingCache(): { entries: RankingEntry[]; hasMore: boolean; monthKey: string; monthlyMode: boolean } | null {
    try {
      const raw = localStorage.getItem(RANKING_CACHE_KEY);
      const ts = parseInt(localStorage.getItem(RANKING_CACHE_TS_KEY) || "0", 10) || 0;
      if (!raw || !ts || Date.now() - ts > RANKING_CACHE_TTL_MS) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.entries)) return null;
      return { entries: parsed.entries, hasMore: parsed.hasMore === true, monthKey: String(parsed.monthKey || ""), monthlyMode: parsed.monthlyMode === true };
    } catch {
      return null;
    }
  }

  function saveRankingCache(nextEntries: RankingEntry[], nextHasMore: boolean, monthlyMode: boolean) {
    try {
      // monthKey no cache: a virada do mês invalida o cache sozinha (o quadro
      // mensal de um mês não pode vazar para o mês seguinte).
      localStorage.setItem(RANKING_CACHE_KEY, JSON.stringify({ entries: nextEntries, hasMore: nextHasMore, monthKey: currentMonthKey, monthlyMode }));
      localStorage.setItem(RANKING_CACHE_TS_KEY, String(Date.now()));
    } catch {}
  }

  // ─── Parse do doc consolidado mensal (rankingMonthly/{mês}/users/{uid}) ──
  function parseMonthlyDoc(docSnap: QueryDocumentSnapshot<DocumentData, DocumentData>): RankingEntry | null {
    const data = docSnap.data();
    if (typeof data.score !== "number") return null;
    return {
      uid: docSnap.id,
      nome: userNames[docSnap.id] || `Jogador ${docSnap.id.slice(0, 6)}`,
      score: data.score || 0,
      concluidas: typeof data.concluidas === "number" ? data.concluidas : 0,
      totalParticipacoes: typeof data.totalParticipacoes === "number" ? data.totalParticipacoes : 0,
      totalMortes: typeof data.totalMortes === "number" ? data.totalMortes : 0,
      totalDuracaoMs: typeof data.totalDuracaoMs === "number" ? data.totalDuracaoMs : 0,
      totalPtsSoulwar: typeof data.totalPtsSoulwar === "number" ? data.totalPtsSoulwar : 0,
      totalPtsSanguine: typeof data.totalPtsSanguine === "number" ? data.totalPtsSanguine : 0,
      ptsSemMorte: typeof data.ptsSemMorte === "number" ? data.ptsSemMorte : 0,
      ptsComMorte: typeof data.ptsComMorte === "number" ? data.ptsComMorte : 0,
      // sequenciaAtualSemMorte é sempre 0 no recorte mensal (igual ao
      // toCurrentMonthEntry); maxSequencia continua vitalício (contexto).
      sequenciaAtualSemMorte: 0,
      maxSequenciaSemMorte: typeof data.maxSequenciaSemMorte === "number" ? data.maxSequenciaSemMorte : 0,
      servers: (data.servers && typeof data.servers === "object") ? data.servers as Record<string, number> : {},
      partners: (data.partners && typeof data.partners === "object") ? data.partners as Record<string, number> : {},
      ultimaAtualizacao: data.updatedAt,
      totalRcDoadoAprovado: typeof data.totalRcDoadoAprovado === "number" ? data.totalRcDoadoAprovado : 0,
      services: typeof data.services === "number" ? data.services : 0,
      dailyStats: {},
    };
  }

  /**
   * Carrega a primeira página do quadro "Mês Atual".
   *
   * MODO MENSAL (padrão após a migração do backend): lê os docs consolidados
   * `rankingMonthly/{mês corrente}/users` ordenados por score — documentos
   * PEQUENOS (só o mês), ordenação mensal CORRETA no servidor (o quadro deixa
   * de ser "top-N vitalício agregado no cliente", que escondia usuários
   * ativos fora desse recorte) e zero agregação repetida por cliente.
   *
   * MODO LEGADO (fallback): top-N de userStats por rankingScore vitalício +
   * agregação de dailyStats no cliente — caminho original, mantido enquanto a
   * Cloud Function agendada não rodou pela primeira vez (metadado
   * `rankingMonthlyActive`) e em modo simulação.
   */
  const fetchInitial = async (force = false, monthlyOverride?: boolean) => {
    if (isSimulationMode || !db) {
      setLoading(false);
      return;
    }
    const monthly = monthlyOverride ?? monthlyModeRef.current === true;

    if (!force) {
      const cached = readRankingCache();
      if (cached && cached.monthKey === currentMonthKey && cached.monthlyMode === monthly) {
        setEntries(cached.entries);
        setHasMore(cached.hasMore);
        lastDocRef.current = null;
        setLoading(false);
        return;
      }
    }

    setLoading(true);
    try {
      const q = monthly
        ? query(
            collection(db, "rankingMonthly", currentMonthKey, "users"),
            orderBy("score", "desc"),
            fireLimit(PAGE_SIZE)
          )
        : query(
            collection(db, "userStats"),
            orderBy("rankingScore", "desc"),
            fireLimit(PAGE_SIZE)
          );
      const snap = await getDocs(q);
      const list: RankingEntry[] = [];
      snap.forEach((d) => {
        const parsed = monthly ? parseMonthlyDoc(d) : parseDoc(d);
        if (parsed) list.push(parsed);
      });
      const nextHasMore = snap.docs.length === PAGE_SIZE;
      setEntries(list);
      lastDocRef.current = snap.docs.length > 0 ? snap.docs[snap.docs.length - 1] : null;
      setHasMore(nextHasMore);
      saveRankingCache(list, nextHasMore, monthly);
    } catch (err) {
      console.error("Erro ao carregar ranking universal:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Só re-busca por troca de nomes quando o modo já é conhecido (a carga
    // inicial acontece no efeito de sessão, após ler os metadados de reset).
    if (monthlyModeRef.current !== null) fetchInitial();
  }, [userNames]);

  /**
   * Sessão do painel: metadados de reset → modo do quadro → carga inicial →
   * histórico "Último Mês".
   *
   * Roda UMA vez por sessão (`resetCheckedRef`), evitando releituras a cada
   * reabertura do painel. O reset mensal é PRIMARIAMENTE a Cloud Function
   * agendada `scheduledRankingReset` (diária 00:20 UTC, idempotente); o
   * caminho do Boss abaixo permanece como fallback self-healing — os dois
   * usam os mesmos metadados e gates, então nunca duplicam o reset.
   */
  useEffect(() => {
    if (isSimulationMode || !db) return;
    if (resetCheckedRef.current) return;
    resetCheckedRef.current = true;

    let cancelled = false;
    (async () => {
      // Boss (fallback): verifica e, se for o caso, executa o reset do mês.
      let meta: RankingResetMeta | null = null;
      let forceReload = false;
      if (isBossUser) {
        const result = await ensureMonthlyRankingReset({
          isBoss: true,
          currentUserUid,
          userNames,
        });
        meta = result.meta || await readRankingResetMeta();
        // Reset pendente (sem dados diários para arquivar): informa o Boss em
        // vez de falhar em silêncio. A tentativa continua aberta.
        if (result.error && !cancelled) setResetNotice(result.error);
        // Reset concluído agora: recarrega os dados para refletir o novo mês.
        if (result.didReset) forceReload = true;
      } else {
        meta = await readRankingResetMeta();
      }
      if (cancelled) return;
      setResetMeta(meta);

      // Modo do quadro: consolidado mensal após a primeira execução da CF
      // agendada; antes disso, caminho legado.
      monthlyModeRef.current = meta?.rankingMonthlyActive === true;
      if (cancelled) return;
      fetchInitial(forceReload, monthlyModeRef.current === true);

      // "Último Mês": snapshot do mês anterior ao último reset registrado.
      // Sem metadado de histórico, tenta o mês anterior ao corrente.
      const candidates = Array.from(new Set([
        meta?.lastHistoryMonth || "",
        meta?.lastRankingResetMonth ? getPreviousMonthKey(meta.lastRankingResetMonth) : "",
        getPreviousMonthKey(currentMonthKey),
      ].filter(Boolean)));

      for (const month of candidates) {
        const history = await readRankingHistory(month);
        if (cancelled) return;
        if (history && history.entries.length > 0) {
          setHistoryDoc(history);
          return;
        }
      }
    })().catch(() => {});

    return () => { cancelled = true; };
  }, [isBossUser, currentUserUid]);

  const lastResetLabel = useMemo(() => formatResetTimestampUtc(resetMeta), [resetMeta]);
  // Divisores de "PT's por dia" coerentes com cada recorte.
  const elapsedDaysInMonth = useMemo(() => getElapsedDaysInCurrentMonth(), []);
  const lastMonthDayCount = useMemo(
    () => getDaysInMonth(historyDoc?.monthKey || getPreviousMonthKey(currentMonthKey)),
    [historyDoc, currentMonthKey],
  );

  // Carregar mais (paginação) — pagina a mesma fonte da carga inicial
  // (docs mensais consolidados no modo migrado; userStats no legado).
  const handleLoadMore = async () => {
    if (loadingMore || !hasMore || isSimulationMode || !db) return;
    setLoadingMore(true);
    const monthly = monthlyModeRef.current === true;
    try {
      // Quando a página inicial veio do cache, não existe cursor persistível do
      // Firestore. Nesse caso, relemos a primeira página apenas no clique de
      // "carregar mais" para reconstruir o cursor e preservar a paginação.
      let cursor = lastDocRef.current;
      if (!cursor) {
        const baseQuery = monthly
          ? query(collection(db, "rankingMonthly", currentMonthKey, "users"), orderBy("score", "desc"), fireLimit(PAGE_SIZE))
          : query(collection(db, "userStats"), orderBy("rankingScore", "desc"), fireLimit(PAGE_SIZE));
        const firstSnap = await getDocs(baseQuery);
        const firstList: RankingEntry[] = [];
        firstSnap.forEach((d) => {
          const parsed = monthly ? parseMonthlyDoc(d) : parseDoc(d);
          if (parsed) firstList.push(parsed);
        });
        const firstHasMore = firstSnap.docs.length === PAGE_SIZE;
        setEntries(firstList);
        saveRankingCache(firstList, firstHasMore, monthly);
        setHasMore(firstHasMore);
        cursor = firstSnap.docs.length > 0 ? firstSnap.docs[firstSnap.docs.length - 1] : null;
        lastDocRef.current = cursor;
        if (!cursor || !firstHasMore) return;
      }

      const qNext = monthly
        ? query(
            collection(db, "rankingMonthly", currentMonthKey, "users"),
            orderBy("score", "desc"),
            startAfter(cursor),
            fireLimit(PAGE_SIZE)
          )
        : query(
            collection(db, "userStats"),
            orderBy("rankingScore", "desc"),
            startAfter(cursor),
            fireLimit(PAGE_SIZE)
          );
      const snap = await getDocs(qNext);
      const nextList: RankingEntry[] = [];
      snap.forEach((d) => {
        const parsed = monthly ? parseMonthlyDoc(d) : parseDoc(d);
        if (parsed) nextList.push(parsed);
      });
      const nextHasMore = snap.docs.length === PAGE_SIZE;
      setEntries(prev => {
        const map = new Map<string, RankingEntry>();
        prev.forEach(e => map.set(e.uid, e));
        nextList.forEach(e => map.set(e.uid, e));
        // A ordenação primária dos dados carregados ainda é pelo score
        const merged = Array.from(map.values()).sort((a, b) => b.score - a.score);
        saveRankingCache(merged, nextHasMore, monthly);
        return merged;
      });
      lastDocRef.current = snap.docs.length > 0 ? snap.docs[snap.docs.length - 1] : lastDocRef.current;
      setHasMore(nextHasMore);
    } catch (err) {
      console.error("Erro na paginação do ranking:", err);
    } finally {
      setLoadingMore(false);
    }
  };

  /**
   * "Mês Atual": agrega apenas os dias do mês UTC corrente.
   *
   * `dailyStats` usa chave UTC (`toISOString().slice(0,10)`), então o recorte
   * é exato e o acumulado zera sozinho na virada do mês — o reset não precisa
   * apagar nada de `userStats`.
   */
  function toCurrentMonthEntry(entry: RankingEntry): RankingEntry {
    const daily = entry.dailyStats || {};

    // FALLBACK DE COMPATIBILIDADE
    // `dailyStats` só passou a ser alimentado a partir de certo ponto do
    // projeto. Usuários cujas PTs foram concluídas antes disso têm totais
    // vitalícios em `userStats` mas NENHUM bucket diário — o recorte mensal
    // renderizaria uma linha de zeros, escondendo dados que existem.
    //
    // Quando o documento não tem histórico diário algum, exibimos os totais
    // vitalícios. Assim que os buckets passarem a existir, o recorte mensal
    // real assume automaticamente e este fallback deixa de ser acionado.
    if (hasNoDailyHistoryAtAll(daily)) {
      return { ...entry, sequenciaAtualSemMorte: 0 };
    }

    const scoped = aggregateMonthFromDaily(daily, currentMonthKey);
    return {
      ...entry,
      score: scoped.score,
      concluidas: scoped.concluidas,
      totalParticipacoes: scoped.totalParticipacoes,
      totalMortes: scoped.totalMortes,
      totalDuracaoMs: scoped.totalDuracaoMs,
      totalPtsSoulwar: scoped.totalPtsSoulwar,
      totalPtsSanguine: scoped.totalPtsSanguine,
      ptsSemMorte: scoped.ptsSemMorte,
      ptsComMorte: scoped.ptsComMorte,
      sequenciaAtualSemMorte: 0,
      maxSequenciaSemMorte: entry.maxSequenciaSemMorte,
      servers: scoped.servers,
      partners: scoped.partners,
      services: scoped.services,
      totalRcDoadoAprovado: 0,
    };
  }

  /** Converte uma entrada do snapshot histórico no formato do painel. */
  function historyToEntry(item: RankingHistoryEntry): RankingEntry {
    return {
      uid: item.uid,
      nome: userNames[item.uid] || item.nome,
      score: item.score || 0,
      concluidas: item.concluidas || 0,
      totalParticipacoes: item.totalParticipacoes || 0,
      totalMortes: item.totalMortes || 0,
      totalDuracaoMs: item.totalDuracaoMs || 0,
      totalPtsSoulwar: item.totalPtsSoulwar || 0,
      totalPtsSanguine: item.totalPtsSanguine || 0,
      ptsSemMorte: item.ptsSemMorte || 0,
      ptsComMorte: item.ptsComMorte || 0,
      sequenciaAtualSemMorte: item.sequenciaAtualSemMorte || 0,
      maxSequenciaSemMorte: item.maxSequenciaSemMorte || 0,
      servers: item.servers || {},
      partners: item.partners || {},
      totalRcDoadoAprovado: item.totalRcDoadoAprovado || 0,
      services: item.services || 0,
      dailyStats: {},
    };
  }

  function sortEntries(list: RankingEntry[], mode: RankingMode, dayCount: number): RankingEntry[] {
    const filtered = mode === "geral" ? [...list] : list.filter(e => e.concluidas >= 3);
    const sortGeral = (a: RankingEntry, b: RankingEntry) => b.score - a.score;
    filtered.sort((a, b) => {
      if (mode === "geral") return sortGeral(a, b);
      if (mode === "menos_mortes") {
        const avgA = a.totalMortes / (a.concluidas || 1);
        const avgB = b.totalMortes / (b.concluidas || 1);
        if (avgA !== avgB) return avgA - avgB;
        return sortGeral(a, b);
      }
      if (mode === "streak") {
        if (a.sequenciaAtualSemMorte !== b.sequenciaAtualSemMorte) return b.sequenciaAtualSemMorte - a.sequenciaAtualSemMorte;
        return sortGeral(a, b);
      }
      if (mode === "quests") {
        if (a.concluidas !== b.concluidas) return b.concluidas - a.concluidas;
        return sortGeral(a, b);
      }
      if (mode === "menor_duracao") {
        const avgA = a.totalDuracaoMs / (a.concluidas || 1);
        const avgB = b.totalDuracaoMs / (b.concluidas || 1);
        if (avgA !== avgB) return avgA - avgB;
        return sortGeral(a, b);
      }
      if (mode === "pts_dia") {
        // Divisor comum aos dois lados da comparação: a ordenação não muda,
        // mas o valor exibido no card fica coerente com o recorte.
        const freqA = a.concluidas / dayCount;
        const freqB = b.concluidas / dayCount;
        if (freqA !== freqB) return freqB - freqA;
        return sortGeral(a, b);
      }
      return sortGeral(a, b);
    });
    return filtered;
  }

  // "Mês Atual": no modo consolidado as entradas JÁ vêm recortadas pelo mês
  // (docs rankingMonthly do mês corrente); no legado, agrega os dias do mês
  // UTC corrente a partir de dailyStats.
  const currentMonthEntries = useMemo(
    () => (monthlyModeRef.current === true ? entries : entries.map(toCurrentMonthEntry)),
    [entries, currentMonthKey],
  );
  // "Último Mês": snapshot fixo, lido uma única vez por sessão.
  const lastMonthEntries = useMemo(
    () => (historyDoc?.entries || []).map(historyToEntry),
    [historyDoc, userNames],
  );

  // Reordenação local baseada no botão selecionado
  const sortedEntries = useMemo(
    () => sortEntries(currentMonthEntries, rankingMode, elapsedDaysInMonth),
    [currentMonthEntries, rankingMode, elapsedDaysInMonth],
  );
  const sortedRecentEntries = useMemo(
    () => sortEntries(lastMonthEntries, rankingMode, lastMonthDayCount),
    [lastMonthEntries, rankingMode, lastMonthDayCount],
  );

  // Buscar posição exata do usuário se ele não estiver visível nas páginas carregadas
  useEffect(() => {
    if (!currentUserUid || !userStatsDoc || typeof userStatsDoc.rankingScore !== "number" || isSimulationMode || !db) {
      setMyExactPosition(null);
      return;
    }
    const inLoaded = entries.some(e => e.uid === currentUserUid);
    if (inLoaded) {
      setMyExactPosition(null);
      return;
    }

    const fetchMyRank = async () => {
      try {
        if (monthlyModeRef.current === true) {
          // Modo consolidado: posição no MÊS — conta docs mensais com score
          // maior que o meu (meu score mensal vem da agregação ao vivo do meu
          // próprio userStats, sem leitura extra).
          const myMonthEntry = myOffscreenEntry ? toCurrentMonthEntry(myOffscreenEntry) : null;
          const myScore = myMonthEntry ? myMonthEntry.score : 0;
          const countSnap = await getCountFromServer(
            query(collection(db, "rankingMonthly", currentMonthKey, "users"), where("score", ">", myScore))
          );
          setMyExactPosition(countSnap.data().count + 1);
          return;
        }
        const myScore = userStatsDoc.rankingScore || 0;
        const countSnap = await getCountFromServer(
          query(collection(db, "userStats"), where("rankingScore", ">", myScore))
        );
        const pos = countSnap.data().count + 1;
        setMyExactPosition(pos);
      } catch (err) {
        console.error("Erro ao buscar posição exata do usuário:", err);
      }
    };
    fetchMyRank();
  }, [currentUserUid, userStatsDoc, entries]);

  // Montar entrada do usuário logado caso ele tenha dados no userStats mas não esteja visível
  const myOffscreenEntry: RankingEntry | null = useMemo(() => {
    if (!currentUserUid || !userStatsDoc || typeof userStatsDoc.rankingScore !== "number") return null;
    if (entries.some(e => e.uid === currentUserUid)) return null;
    return {
      uid: currentUserUid,
      nome: userNames[currentUserUid] || displayUserName || "Você",
      score: userStatsDoc.rankingScore || 0,
      concluidas: typeof userStatsDoc.totalPtsConcluidas === "number" ? userStatsDoc.totalPtsConcluidas : 0,
      totalParticipacoes: typeof userStatsDoc.totalParticipacoes === "number" ? userStatsDoc.totalParticipacoes : (userStatsDoc.totalPtsConcluidas || 0),
      totalMortes: typeof userStatsDoc.totalMortes === "number" ? userStatsDoc.totalMortes : 0,
      totalDuracaoMs: typeof userStatsDoc.totalDuracaoMs === "number" ? userStatsDoc.totalDuracaoMs : 0,
      totalPtsSoulwar: typeof userStatsDoc.totalPtsSoulwar === "number" ? userStatsDoc.totalPtsSoulwar : 0,
      totalPtsSanguine: typeof userStatsDoc.totalPtsSanguine === "number" ? userStatsDoc.totalPtsSanguine : 0,
      ptsSemMorte: typeof userStatsDoc.ptsSemMorte === "number" ? userStatsDoc.ptsSemMorte : 0,
      ptsComMorte: typeof userStatsDoc.ptsComMorte === "number" ? userStatsDoc.ptsComMorte : 0,
      sequenciaAtualSemMorte: typeof userStatsDoc.sequenciaAtualSemMorte === "number" ? userStatsDoc.sequenciaAtualSemMorte : 0,
      maxSequenciaSemMorte: typeof userStatsDoc.maxSequenciaSemMorte === "number" ? userStatsDoc.maxSequenciaSemMorte : 0,
      servers: (userStatsDoc.servers && typeof userStatsDoc.servers === "object") ? userStatsDoc.servers as Record<string, number> : {},
      partners: (userStatsDoc.partners && typeof userStatsDoc.partners === "object") ? userStatsDoc.partners as Record<string, number> : {},
      totalRcDoadoAprovado: typeof userStatsDoc.totalRcDoadoAprovado === "number" ? userStatsDoc.totalRcDoadoAprovado : 0,
      services: typeof userStatsDoc.services === "number" ? userStatsDoc.services : 0,
      dailyStats: (userStatsDoc.dailyStats && typeof userStatsDoc.dailyStats === "object") ? userStatsDoc.dailyStats as Record<string, DailyStatsBucket> : {},
    };
  }, [currentUserUid, userStatsDoc, entries, userNames, displayUserName]);

  // O card é exibido ao lado de "Mês Atual": recorta pelo mês corrente para
  // não misturar total vitalício com o quadro mensal.
  const myOffscreenMonthEntry = useMemo(
    () => (myOffscreenEntry ? toCurrentMonthEntry(myOffscreenEntry) : null),
    [myOffscreenEntry, currentMonthKey],
  );

  function toggleExpand(uid: string, scope: "recent" | "total") {
    if (scope === "recent") {
      setExpandedRecentUid(prev => (prev === uid ? null : uid));
    } else {
      setExpandedTotalUid(prev => (prev === uid ? null : uid));
    }
  }

  function Medalia({ index }: { index: number }) {
    if (index === 0) return <span className="text-xl leading-none select-none" title="1º lugar — Ouro">🥇</span>;
    if (index === 1) return <span className="text-xl leading-none select-none" title="2º lugar — Prata">🥈</span>;
    if (index === 2) return <span className="text-xl leading-none select-none" title="3º lugar — Bronze">🥉</span>;
    return null;
  }

  function getCardColors(index: number, isMe: boolean): string {
    if (isMe) {
      return "border-amber-500/70 bg-gradient-to-r from-amber-950/40 via-amber-900/20 to-[var(--th-bg-base)] shadow-[0_0_20px_color-mix(in_oklab,var(--color-amber-500)_20%,transparent)] ring-1 ring-amber-500/50";
    }
    if (index === 0) return "border-amber-400/50 bg-gradient-to-r from-amber-500/15 via-amber-500/5 to-[var(--th-bg-base)] shadow-[0_0_15px_color-mix(in_oklab,var(--color-amber-500)_12%,transparent)]";
    if (index === 1) return "border-slate-300/40 bg-gradient-to-r from-slate-400/15 via-slate-400/5 to-[var(--th-bg-base)] shadow-[0_0_15px_rgba(148,163,184,0.08)]";
    if (index === 2) return "border-amber-600/40 bg-gradient-to-r from-amber-700/15 via-amber-700/5 to-[var(--th-bg-base)] shadow-[0_0_15px_color-mix(in_oklab,var(--color-amber-500)_8%,transparent)]";
    return "border-[var(--th-line)]/30 bg-[var(--th-bg-base)] hover:border-[var(--th-brand)]/60 hover:bg-[var(--th-bg-raised)]";
  }

  // Componente de Card Individual do Jogador
  function PlayerCard({ entry, index, scope, customPos }: { entry: RankingEntry; index: number; scope: "recent" | "total"; customPos?: number }) {
    const isMe = entry.uid === currentUserUid;
    const isExpanded = scope === "recent" ? expandedRecentUid === entry.uid : expandedTotalUid === entry.uid;
    const pos = customPos !== undefined ? customPos : index + 1;
    const role = userRoles[entry.uid] || "Normal";

    // Estatísticas derivadas para o card expandido
    const concl = entry.concluidas || 1;
    const avgDeaths = entry.totalMortes > 0 ? (entry.totalMortes / concl).toFixed(1) : "0";
    const pctSemMorte = concl > 0 ? Math.round((entry.ptsSemMorte / concl) * 100) : 0;
    const totalHorasStr = formatDur(entry.totalDuracaoMs);
    const avgDurMs = concl > 0 ? Math.round(entry.totalDuracaoMs / concl) : 0;
    const avgDurStr = formatDur(avgDurMs);

    // Média de PT's por dia.
    // "Último Mês": divide pelos dias do mês fechado.
    // "Mês Atual": divide pelos dias já decorridos do mês corrente.
    const freqDia = useMemo(() => {
      if (entry.concluidas === 0) return "0.0";
      const days = scope === "recent" ? lastMonthDayCount : elapsedDaysInMonth;
      return (entry.concluidas / Math.max(1, days)).toFixed(1);
    }, [entry.concluidas, scope]);

    // Top servidores
    const topServers = useMemo(() => {
      const srvs = entry.servers || {};
      return Object.entries(srvs)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3);
    }, [entry.servers]);

    // Top parceiros
    const topPartners = useMemo(() => {
      const prts = entry.partners || {};
      return Object.entries(prts)
        .map(([uid, count]) => ({
          uid,
          name: userNames[uid] || `Jogador ${uid.slice(0, 6)}`,
          count
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);
    }, [entry.partners]);

    return (
      <div className={`rounded-xl border transition-all duration-200 overflow-hidden ${getCardColors(index, isMe)}`}>
         {/* Linha principal do jogador (clicável para expandir) */}
        <button
          type="button"
          onClick={() => toggleExpand(entry.uid, scope)}
          className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 text-left cursor-pointer hover:bg-white/[0.02] transition-colors"
        >
          {/* Lado Esquerdo: Posição + Nome + Stats */}
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            {/* Posição com destaque */}
            <div className="flex items-center justify-center flex-shrink-0">
              {index < 3 && customPos === undefined ? (
                <div className="relative">
                  <Medalia index={index} />
                  <div className={`absolute inset-0 rounded-full blur-md opacity-60 ${
                    index === 0 ? "bg-amber-400/50" : index === 1 ? "bg-slate-300/50" : "bg-amber-600/50"
                  }`} />
                </div>
              ) : (
                <span className={`inline-flex items-center justify-center min-w-[32px] h-7 px-1.5 rounded-lg text-sm font-black tabular-nums border-2 ${
                  isMe 
                    ? "bg-amber-500/20 border-amber-400 text-amber-300 shadow-[0_0_10px_color-mix(in_oklab,var(--color-amber-500)_40%,transparent)]" 
                    : "bg-black/40 border-[var(--th-line)] text-slate-300"
                }`}>
                  {pos}
                </span>
              )}
            </div>
            {/* Nome e estatísticas em uma única linha */}
            <div className="min-w-0 flex flex-col gap-0.5 flex-1">
              <div className="flex items-center gap-1.5">
                <span className={`text-xs font-black truncate tracking-tight ${isMe ? "text-amber-300" : "text-white"}`}>
                  {entry.nome}
                </span>
                {role === "VIP" && (
                  <span className="text-[8px] text-amber-300 bg-amber-500/15 border border-amber-500/30 px-1.5 py-0.5 rounded font-extrabold uppercase tracking-wider flex-shrink-0 select-none">
                    VIP
                  </span>
                )}
                {role === "Boss" && (
                  <span className="text-[8px] text-violet-300 bg-violet-500/15 border border-violet-500/30 px-1.5 py-0.5 rounded font-extrabold uppercase tracking-wider flex-shrink-0 select-none">
                    ADM
                  </span>
                )}
                {isMe && (
                  <span className="text-[8px] text-amber-400 bg-amber-500/20 border border-amber-500/40 px-1 py-0.5 rounded font-black uppercase tracking-wider flex-shrink-0">
                    Você
                  </span>
                )}
              </div>
              
              {/* Estatísticas em uma única linha */}
              <div className="flex items-center gap-1.5 text-[9px] text-slate-400 font-medium">
                <span className="text-emerald-400 font-bold">{entry.concluidas} PT{entry.concluidas !== 1 ? "'s" : ""}</span>
                <span className="text-slate-600">|</span>
                <span className="text-rose-400">Méd. Mortes: <strong className="text-slate-300 tabular-nums">{avgDeaths}</strong></span>
                <span className="text-slate-600">|</span>
                <span className="text-sky-400">Duração Méd.: <strong className="text-slate-300 tabular-nums">{avgDurStr}</strong></span>
                <span className="text-slate-600">|</span>
                <span className="text-emerald-400">PT/dia: <strong className="text-slate-300 tabular-nums">~{freqDia}</strong></span>
                <span className="text-slate-600">|</span>
                <span className="text-amber-400">Doação Méd. RC/PT: <strong className="text-slate-300 tabular-nums">{concl > 0 && entry.totalRcDoadoAprovado > 0 ? Math.round(entry.totalRcDoadoAprovado / concl) : "0"}</strong></span>
              </div>
            </div>
          </div>
          {/* Lado Direito: Pontuação + Seta de Expansão */}
          <div className="flex items-center gap-2 flex-shrink-0">
            <div className="flex flex-col items-end">
              <div className="text-xs sm:text-sm font-black text-amber-400 tabular-nums leading-none">
                {entry.score.toLocaleString("de-DE")} <span className="text-[10px] font-bold text-amber-500/80">pts</span>
              </div>
              <span className="text-[8px] text-slate-500 font-bold uppercase tracking-wider mt-0.5">
                {entry.totalParticipacoes} part.
              </span>
            </div>
            <div className="w-5 h-5 rounded-md bg-black/30 border border-[var(--th-line)]/40 flex items-center justify-center text-slate-400">
              {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </div>
          </div>
        </button>

        {/* Área Expandida com Estatísticas Detalhadas */}
        {isExpanded && (
          <div className="border-t border-[var(--th-line)]/40 bg-black/40 px-3 py-3 space-y-3 animate-in fade-in duration-200">
            {/* Grade Principal de 5 Grupos */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-2">
              
              {/* ⚡ Desempenho */}
              <div className="bg-[var(--th-bg-base)]/90 rounded-xl p-3 border border-[var(--th-line)]/40 space-y-2">
                <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-amber-400 border-b border-[var(--th-line)]/30 pb-1.5">
                  <Zap size={12} className="text-amber-400" /> Desempenho
                </div>
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between"><span className="text-slate-400">Pontuação Total:</span> <span className="font-black text-amber-300 tabular-nums">{entry.score.toLocaleString("de-DE")} pts</span></div>
                  <div className="flex justify-between"><span className="text-slate-400">PT's Concluídas:</span> <span className="font-bold text-emerald-400 tabular-nums">{entry.concluidas}</span></div>
                  <div className="flex justify-between"><span className="text-slate-400">Participações:</span> <span className="font-bold text-sky-400 tabular-nums">{entry.totalParticipacoes}</span></div>
                  <div className="flex justify-between"><span className="text-slate-400">Services:</span> <span className="font-bold text-sky-300 tabular-nums">{entry.services || 0}</span></div>
                </div>
              </div>

              {/* 🛡️ Sobrevivência */}
              <div className="bg-[var(--th-bg-base)]/90 rounded-xl p-3 border border-[var(--th-line)]/40 space-y-2">
                <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-rose-400 border-b border-[var(--th-line)]/30 pb-1.5">
                  <Shield size={12} className="text-rose-400" /> Sobrevivência
                </div>
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between"><span className="text-slate-400">Mortes Totais:</span> <span className="font-bold text-rose-400 tabular-nums">{entry.totalMortes}</span></div>
                  <div className="flex justify-between"><span className="text-slate-400">Média Mortes/PT:</span> <span className="font-bold text-rose-300 tabular-nums">{avgDeaths}</span></div>
                  <div className="flex justify-between"><span className="text-slate-400">Sem Morte:</span> <span className="font-bold text-emerald-400 tabular-nums">{entry.ptsSemMorte} ({pctSemMorte}%)</span></div>
                  <div className="flex justify-between"><span className="text-slate-400">Sequência Atual:</span> <span className="font-black text-amber-400 tabular-nums">{entry.sequenciaAtualSemMorte} 🔥</span></div>
                  <div className="flex justify-between"><span className="text-slate-400">Maior Sequência:</span> <span className="font-bold text-amber-300 tabular-nums">{entry.maxSequenciaSemMorte} ⭐</span></div>
                </div>
              </div>

              {/* ⚔️ Quests */}
              <div className="bg-[var(--th-bg-base)]/90 rounded-xl p-3 border border-[var(--th-line)]/40 space-y-2">
                <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-violet-400 border-b border-[var(--th-line)]/30 pb-1.5">
                  <Award size={12} className="text-violet-400" /> Quests Concluídas
                </div>
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between items-center"><span className="text-slate-400">Soulwar:</span> <span className="font-bold text-slate-200 bg-slate-500/20 border border-slate-500/40 px-1.5 py-0.5 rounded text-[10px] tabular-nums">{entry.totalPtsSoulwar}</span></div>
                  <div className="flex justify-between items-center"><span className="text-slate-400">Sanguine:</span> <span className="font-bold text-rose-300 bg-rose-500/20 border border-rose-500/40 px-1.5 py-0.5 rounded text-[10px] tabular-nums">{entry.totalPtsSanguine}</span></div>
                </div>
              </div>

              {/* ⏱️ Tempo & Atividade */}
              <div className="bg-[var(--th-bg-base)]/90 rounded-xl p-3 border border-[var(--th-line)]/40 space-y-2">
                <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-sky-400 border-b border-[var(--th-line)]/30 pb-1.5">
                  <Clock size={12} className="text-sky-400" /> Tempo & Atividade
                </div>
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between"><span className="text-slate-400">Tempo Jogado:</span> <span className="font-bold text-sky-300 tabular-nums">{totalHorasStr}</span></div>
                  <div className="flex justify-between"><span className="text-slate-400">Duração Média:</span> <span className="font-bold text-sky-400 tabular-nums">{avgDurStr}</span></div>
                  <div className="flex justify-between"><span className="text-slate-400">PT's por Dia:</span> <span className="font-bold text-emerald-400 tabular-nums">~{freqDia}</span></div>
                </div>
              </div>

              {/* 💰 Doações */}
              <div className="bg-[var(--th-bg-base)]/90 rounded-xl p-3 border border-[var(--th-line)]/40 space-y-2">
                <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-emerald-400 border-b border-[var(--th-line)]/30 pb-1.5">
                  <Star size={12} className="text-emerald-400" /> Doações
                </div>
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between"><span className="text-slate-400">Doação Total:</span> <span className="font-bold text-emerald-400 tabular-nums">{entry.totalRcDoadoAprovado > 0 ? entry.totalRcDoadoAprovado.toLocaleString("de-DE") + " RC" : "—"}</span></div>
                  <div className="flex justify-between"><span className="text-slate-400">Média (RC/PT):</span> <span className="font-bold text-amber-300 tabular-nums">{concl > 0 && entry.totalRcDoadoAprovado > 0 ? Math.round(entry.totalRcDoadoAprovado / concl) : "0"}</span></div>
                </div>
              </div>

            </div>

            {/* Linha Inferior: Servidores + Parceiros Frequentes */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 pt-1">
              
              {/* Servidores */}
              <div className="bg-[var(--th-bg-base)]/60 rounded-xl p-3 border border-[var(--th-line)]/30 flex flex-col gap-2">
                <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-slate-300">
                  <Server size={12} className="text-sky-400" /> Servidores Principais
                </div>
                {topServers.length === 0 ? (
                  <span className="text-xs text-slate-600 italic">Nenhum servidor registrado ainda.</span>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {topServers.map(([srv, cnt]) => {
                      const srvPct = Math.round((cnt / concl) * 100);
                      return (
                        <div key={srv} className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-black/40 border border-sky-500/20 text-xs">
                          <span className="font-bold text-sky-300">{srv}</span>
                          <span className="text-[10px] font-black text-sky-400 bg-sky-500/10 px-1 rounded tabular-nums">{cnt}× ({srvPct}%)</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Parceiros Frequentes */}
              <div className="bg-[var(--th-bg-base)]/60 rounded-xl p-3 border border-[var(--th-line)]/30 flex flex-col gap-2">
                <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-slate-300">
                  <UserPlus size={12} className="text-violet-400" /> Parceiros Mais Frequentes
                </div>
                {topPartners.length === 0 ? (
                  <span className="text-xs text-slate-600 italic">Nenhum parceiro registrado ainda.</span>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {topPartners.map((prt, pIdx) => (
                      <div key={prt.uid} className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-black/40 border border-violet-500/20 text-xs">
                        <span className="text-[9px] font-black text-violet-400">#{pIdx + 1}</span>
                        <span className="font-bold text-slate-200">{prt.name}</span>
                        <span className="text-[10px] font-black text-violet-300 bg-violet-500/10 px-1 rounded tabular-nums">{prt.count}×</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    // Container raiz: flex-column ocupando toda a altura disponível, sem scroll próprio
    <div className="h-full flex flex-col bg-[var(--th-n-deep)] text-slate-200">

      {/* ══ Área de scroll: cabeçalho + filtros + lista ══ */}
      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-3 sm:p-4 flex flex-col gap-4">

        {/* ══════════════════ CABEÇALHO DO PAINEL DE RANKING ══════════════════ */}
        <div
          className="rounded-2xl border border-amber-700/35 bg-[radial-gradient(circle_at_top,color-mix(in_oklab,var(--color-amber-500)_16%,transparent),transparent_34%),linear-gradient(115deg,var(--th-bg-raised)_0%,var(--th-bg-deep)_38%,var(--th-bg-active)_68%,var(--th-n-base)_100%)] px-4 sm:px-5 py-3.5 sm:py-4 shadow-2xl flex flex-col items-center justify-center gap-2 flex-shrink-0 relative overflow-hidden"
          style={{
            boxShadow:
              "0 0 0 1px color-mix(in oklab, var(--color-amber-500) 42%, transparent), 0 0 10px 1px color-mix(in oklab, var(--color-amber-500) 20%, transparent), 0 0 22px 3px color-mix(in oklab, var(--th-brand) 22%, transparent), 0 0 42px 6px color-mix(in oklab, var(--th-brand) 24%, transparent)",
          }}
        >
          {/* Borda Neon Animada */}
          <div className="absolute inset-0 rounded-2xl pointer-events-none ranking-hero-border-neon" />
          {/* Fundo animado premium */}
          <div className="absolute inset-0 pointer-events-none">
            {/* Meteoros */}
            <div className="absolute top-[15%] left-0 w-16 h-0.5 bg-gradient-to-r from-transparent via-red-500/70 to-transparent ranking-hero-meteor-1" />
            <div className="absolute top-[45%] left-0 w-20 h-0.5 bg-gradient-to-r from-transparent via-red-400/60 to-transparent ranking-hero-meteor-2" />
            <div className="absolute top-[75%] left-0 w-14 h-0.5 bg-gradient-to-r from-transparent via-amber-700/50 to-transparent ranking-hero-meteor-3" />
            <div className="absolute top-[30%] left-0 w-12 h-0.5 bg-gradient-to-r from-transparent via-red-600/55 to-transparent ranking-hero-meteor-4" />
            <div className="absolute -top-10 left-1/2 -translate-x-1/2 w-[88%] h-24 bg-amber-600/18 blur-3xl rounded-full ranking-hero-pulse" />
            <div className="absolute -top-8 left-1/2 -translate-x-1/2 w-[70%] h-16 bg-[var(--th-brand)]/25 blur-2xl rounded-full ranking-hero-pulse-secondary" />
            <div className="absolute inset-x-8 top-1 h-px bg-gradient-to-r from-transparent via-amber-400/40 to-transparent" />
            <div className="absolute inset-x-12 bottom-1 h-px bg-gradient-to-r from-transparent via-red-500/35 to-transparent" />
            <div className="absolute top-1/2 left-0 w-32 h-32 bg-[var(--th-line-strong)]/20 blur-3xl rounded-full ranking-hero-float-1" />
            <div className="absolute top-0 right-8 w-28 h-28 bg-amber-900/16 blur-3xl rounded-full ranking-hero-float-2" />
            <div className="absolute bottom-0 left-1/4 w-24 h-24 bg-[var(--th-brand-mid)]/14 blur-3xl rounded-full ranking-hero-float-3" />
            <div className="absolute top-1/2 right-1/4 w-20 h-20 bg-[var(--th-line)]/12 blur-2xl rounded-full ranking-hero-float-4" />
            <div className="absolute inset-0 bg-gradient-to-b from-[var(--th-brand-mid)]/10 via-transparent to-[var(--th-line-strong)]/8 ranking-hero-glow-wave" />
          </div>
          {/* Ícone + título centralizados */}
          <div className="relative z-10 flex items-center justify-center gap-2.5 flex-wrap text-center">
            <div className="w-11 h-11 sm:w-12 sm:h-12 rounded-xl bg-gradient-to-br from-amber-700/35 via-[var(--th-brand-mid)]/35 to-[var(--th-line-strong)]/18 border-2 border-amber-600/55 flex items-center justify-center shadow-[0_0_28px_color-mix(in_oklab,var(--color-amber-500)_24%,transparent),0_0_45px_color-mix(in_oklab,var(--th-brand)_34%,transparent),inset_0_0_20px_color-mix(in_oklab,var(--color-amber-500)_10%,transparent)] flex-shrink-0 ranking-hero-icon-glow">
              <Trophy size={22} className="text-amber-400 drop-shadow-[0_0_12px_color-mix(in_oklab,var(--color-red-600)_95%,transparent)] ranking-hero-icon-pulse" />
            </div>
            <div className="flex flex-col items-center justify-center min-w-0">
              <div className="flex items-center justify-center gap-2 flex-wrap">
                <h1 className="relative inline-flex items-center gap-2 text-lg sm:text-2xl font-black tracking-tight leading-none ranking-hero-title-glow">
                  <span className="absolute -inset-x-2 -inset-y-1 rounded-xl bg-amber-500/10 blur-md opacity-70 pointer-events-none" />
                  <span className="relative bg-gradient-to-r from-amber-200 via-yellow-500 to-amber-300 bg-clip-text text-transparent drop-shadow-[0_0_14px_color-mix(in_oklab,var(--color-amber-500)_34%,transparent)]">
                    Ranking Chernobyl PT
                  </span>
                  <span className="relative text-amber-300/80 text-sm sm:text-base drop-shadow-[0_0_10px_color-mix(in_oklab,var(--color-amber-500)_45%,transparent)]">✦</span>
                </h1>
                <span className="px-2.5 py-0.5 rounded-full bg-gradient-to-r from-amber-800/35 via-[var(--th-brand)]/38 to-amber-950/35 border-2 border-amber-600/45 text-amber-100 text-[9px] font-black uppercase tracking-wider shadow-[0_0_16px_color-mix(in_oklab,var(--color-amber-500)_22%,transparent),0_0_28px_color-mix(in_oklab,var(--th-brand)_28%,transparent)] ranking-hero-badge-pulse">
                  ✦ Top Jogadores
                </span>
              </div>
              <p className="text-[10px] sm:text-[11px] text-amber-100/70 leading-relaxed max-w-xl mt-1 drop-shadow-[0_1px_3px_rgba(0,0,0,0.65)]">
                Os melhores jogadores do Chernobyl PT ordenados por <span className="text-amber-300/90 font-bold">pontuação operacional</span>, sobrevivência e consistência.
              </p>
            </div>
          </div>
          <style>{`
            @keyframes rankingHeroPulse {
              0%, 100% { opacity: .25; transform: translateX(-50%) scale(1); }
              33% { opacity: .55; transform: translateX(-50%) scale(1.15); }
              66% { opacity: .35; transform: translateX(-50%) scale(1.08); }
            }
            @keyframes rankingHeroPulseSecondary {
              0%, 100% { opacity: .3; transform: translateX(-50%) scale(1.05); }
              50% { opacity: .6; transform: translateX(-50%) scale(1.2); }
            }
            @keyframes rankingHeroFloat1 {
              0%, 100% { transform: translate(0, 0) scale(1); opacity: .15; }
              33% { transform: translate(18px, -12px) scale(1.15); opacity: .35; }
              66% { transform: translate(-8px, -6px) scale(1.08); opacity: .25; }
            }
            @keyframes rankingHeroFloat2 {
              0%, 100% { transform: translate(0, 0) scale(1); opacity: .14; }
              40% { transform: translate(-15px, 14px) scale(1.12); opacity: .32; }
              80% { transform: translate(-8px, 7px) scale(1.06); opacity: .22; }
            }
            @keyframes rankingHeroFloat3 {
              0%, 100% { transform: translate(0, 0) scale(1); opacity: .12; }
              50% { transform: translate(12px, 10px) scale(1.1); opacity: .28; }
            }
            @keyframes rankingHeroFloat4 {
              0%, 100% { transform: translate(0, 0) scale(1); opacity: .1; }
              50% { transform: translate(-10px, -8px) scale(1.08); opacity: .24; }
            }
            @keyframes rankingHeroGlowWave {
              0%, 100% { opacity: .6; }
              33% { opacity: .85; }
              66% { opacity: .7; }
            }
            @keyframes rankingHeroIconGlow {
              0%, 100% { box-shadow: 0 0 28px color-mix(in oklab, var(--th-brand) 60%, transparent), 0 0 45px color-mix(in oklab, var(--th-brand) 30%, transparent), inset 0 0 20px color-mix(in oklab, var(--th-brand) 15%, transparent); }
              50% { box-shadow: 0 0 38px color-mix(in oklab, var(--th-brand) 85%, transparent), 0 0 60px color-mix(in oklab, var(--th-brand) 50%, transparent), inset 0 0 28px color-mix(in oklab, var(--th-brand) 25%, transparent); }
            }
            @keyframes rankingHeroIconPulse {
              0%, 100% { filter: drop-shadow(0 0 12px color-mix(in oklab, var(--color-red-600) 90%, transparent)); }
              50% { filter: drop-shadow(0 0 20px var(--color-red-600)) drop-shadow(0 0 30px color-mix(in oklab, var(--color-red-600) 60%, transparent)); }
            }
            @keyframes rankingHeroTitleGlow {
              0%, 100% { text-shadow: 0 2px 4px rgba(0,0,0,0.5), 0 0 20px color-mix(in oklab, var(--th-brand) 35%, transparent); }
              50% { text-shadow: 0 2px 4px rgba(0,0,0,0.5), 0 0 35px color-mix(in oklab, var(--th-brand) 55%, transparent), 0 0 50px color-mix(in oklab, var(--th-brand) 28%, transparent); }
            }
            @keyframes rankingHeroBadgePulse {
              0%, 100% {
                box-shadow: 0 0 16px color-mix(in oklab, var(--th-brand) 50%, transparent), 0 0 28px color-mix(in oklab, var(--th-brand) 25%, transparent);
                opacity: 0.95;
              }
              50% {
                box-shadow: 0 0 24px color-mix(in oklab, var(--th-brand) 75%, transparent), 0 0 40px color-mix(in oklab, var(--th-brand) 45%, transparent), 0 0 55px color-mix(in oklab, var(--th-brand) 20%, transparent);
                opacity: 1;
              }
            }
            @keyframes rankingHeroBorderNeon {
              0%, 100% {
                box-shadow:
                  inset 0 0 20px color-mix(in oklab, var(--th-brand) 40%, transparent),
                  inset 0 0 30px color-mix(in oklab, var(--th-brand) 25%, transparent),
                  0 0 15px color-mix(in oklab, var(--th-brand) 30%, transparent);
                opacity: 0.7;
              }
              50% {
                box-shadow:
                  inset 0 0 30px color-mix(in oklab, var(--th-brand) 60%, transparent),
                  inset 0 0 45px color-mix(in oklab, var(--th-brand) 40%, transparent),
                  0 0 25px color-mix(in oklab, var(--th-brand) 50%, transparent);
                opacity: 0.95;
              }
            }
            @keyframes rankingHeroMeteor1 {
              0% { transform: translate(-100%, 0) scaleX(0); opacity: 0; }
              5% { opacity: 0.7; transform: translate(-80%, 0) scaleX(1); }
              95% { opacity: 0.7; transform: translate(calc(100vw + 20%), -40%) scaleX(1); }
              100% { transform: translate(calc(100vw + 40%), -40%) scaleX(0); opacity: 0; }
            }
            @keyframes rankingHeroMeteor2 {
              0% { transform: translate(-120%, 0) scaleX(0); opacity: 0; }
              8% { opacity: 0.6; transform: translate(-90%, 0) scaleX(1); }
              92% { opacity: 0.6; transform: translate(calc(100vw + 30%), -35%) scaleX(1); }
              100% { transform: translate(calc(100vw + 50%), -35%) scaleX(0); opacity: 0; }
            }
            @keyframes rankingHeroMeteor3 {
              0% { transform: translate(-80%, 0) scaleX(0); opacity: 0; }
              6% { opacity: 0.5; transform: translate(-60%, 0) scaleX(1); }
              94% { opacity: 0.5; transform: translate(calc(100vw + 25%), -30%) scaleX(1); }
              100% { transform: translate(calc(100vw + 45%), -30%) scaleX(0); opacity: 0; }
            }
            @keyframes rankingHeroMeteor4 {
              0% { transform: translate(-110%, 0) scaleX(0); opacity: 0; }
              7% { opacity: 0.55; transform: translate(-85%, 0) scaleX(1); }
              93% { opacity: 0.55; transform: translate(calc(100vw + 28%), -38%) scaleX(1); }
              100% { transform: translate(calc(100vw + 48%), -38%) scaleX(0); opacity: 0; }
            }
            @keyframes rankingHeroOuterGlow {
              0%, 100% {
                box-shadow:
                  0 0 0 1px color-mix(in oklab, var(--th-brand) 55%, transparent),
                  0 0 8px 1px color-mix(in oklab, var(--th-brand) 35%, transparent),
                  0 0 18px 2px color-mix(in oklab, var(--th-brand) 18%, transparent),
                  0 0 32px 4px color-mix(in oklab, var(--th-brand) 20%, transparent);
              }
              50% {
                box-shadow:
                  0 0 0 1px color-mix(in oklab, var(--th-brand) 90%, transparent),
                  0 0 10px 2px color-mix(in oklab, var(--th-brand) 65%, transparent),
                  0 0 24px 4px color-mix(in oklab, var(--th-brand) 32%, transparent),
                  0 0 42px 6px color-mix(in oklab, var(--th-brand) 25%, transparent);
              }
            }
            .ranking-hero-pulse { animation: rankingHeroPulse 3s ease-in-out infinite; }
            .ranking-hero-pulse-secondary { animation: rankingHeroPulseSecondary 2.5s ease-in-out infinite; }
            .ranking-hero-float-1 { animation: rankingHeroFloat1 4s ease-in-out infinite; }
            .ranking-hero-float-2 { animation: rankingHeroFloat2 3.5s ease-in-out infinite; }
            .ranking-hero-float-3 { animation: rankingHeroFloat3 5s ease-in-out infinite; }
            .ranking-hero-float-4 { animation: rankingHeroFloat4 4.5s ease-in-out infinite; }
            .ranking-hero-glow-wave { animation: rankingHeroGlowWave 4s ease-in-out infinite; }
            .ranking-hero-icon-glow { animation: rankingHeroIconGlow 2s ease-in-out infinite; }
            .ranking-hero-icon-pulse { animation: rankingHeroIconPulse 2s ease-in-out infinite; }
            .ranking-hero-title-glow { animation: rankingHeroTitleGlow 3s ease-in-out infinite; }
            .ranking-hero-badge-pulse { animation: rankingHeroBadgePulse 2.5s ease-in-out infinite; }
            .ranking-hero-border-neon { animation: rankingHeroBorderNeon 3s ease-in-out infinite; }
            .ranking-hero-meteor-1 { animation: rankingHeroMeteor1 8s linear infinite; }
            .ranking-hero-meteor-2 { animation: rankingHeroMeteor2 10s linear infinite 2s; }
            .ranking-hero-meteor-3 { animation: rankingHeroMeteor3 9s linear infinite 4s; }
            .ranking-hero-meteor-4 { animation: rankingHeroMeteor4 11s linear infinite 6s; }
            .ranking-hero-outer-glow { animation: rankingHeroOuterGlow 3s ease-in-out infinite; }
          `}</style>
        </div>

        {/* ══════════════════ BARRA DE SELEÇÃO DE RANKING ══════════════════ */}
        <div className="flex flex-wrap items-center justify-center gap-2 bg-[var(--th-bg-base)]/90 backdrop-blur-sm border border-[var(--th-line)]/50 p-2.5 rounded-xl flex-shrink-0 shadow-lg">
          {[
            { id: "geral", label: "Geral", icon: <Trophy size={13} /> },
            { id: "menos_mortes", label: "Menos Mortes/PT", icon: <Shield size={13} /> },
            { id: "streak", label: "Sequência Sem Morrer", icon: <Flame size={13} /> },
            { id: "quests", label: "Quests Concluídas", icon: <Award size={13} /> },
            { id: "menor_duracao", label: "Menor Duração", icon: <Clock size={13} /> },
            { id: "pts_dia", label: "PT's por Dia", icon: <Activity size={13} /> },
          ].map((mode) => (
            <button
              key={mode.id}
              type="button"
              onClick={() => setRankingMode(mode.id as RankingMode)}
              className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-[10px] sm:text-xs font-bold transition-all duration-300 cursor-pointer ${
                rankingMode === mode.id
                  ? "bg-gradient-to-b from-amber-500/20 to-amber-600/10 border border-amber-500/50 text-amber-300 shadow-[0_0_12px_color-mix(in_oklab,var(--color-amber-500)_20%,transparent)]"
                  : "bg-black/30 border border-white/5 text-slate-400 hover:bg-black/50 hover:text-slate-200 hover:border-white/10"
              }`}
            >
              {mode.icon}
              {mode.label}
            </button>
          ))}

          {/* Data do último reset — sempre a que está salva no Firestore. */}
          {lastResetLabel && (
            <span
              className="inline-flex items-center gap-1 pl-1 text-[9px] sm:text-[10px] font-medium text-slate-500 select-none"
              title="Data do último reset mensal do Ranking (UTC)"
            >
              <Clock size={10} className="text-slate-600" />
              Último reset: {lastResetLabel}
            </span>
          )}

          {/* Reset pendente — visível apenas para o Boss. */}
          {isBossUser && resetNotice && (
            <span
              className="inline-flex items-center gap-1 pl-1 text-[9px] sm:text-[10px] font-medium text-amber-400/80 select-none"
              title={resetNotice}
            >
              <Clock size={10} className="text-amber-500/70" />
              Reset pendente
            </span>
          )}
        </div>

        {/* ════════════ DESTAQUE DO USUÁRIO LOGADO (SE FORA DA LISTA) ════════════ */}
        {myOffscreenMonthEntry && (
          <div className="flex-shrink-0">
            <div className="text-[10px] font-black uppercase tracking-wider text-amber-400 mb-1.5 px-1 flex items-center gap-1">
              <Star size={12} /> Sua posição no ranking
            </div>
            <PlayerCard
              entry={myOffscreenMonthEntry}
              index={0}
              scope="total"
              customPos={myExactPosition !== null ? myExactPosition : 999}
            />
          </div>
        )}

        {/* ══════════════════ LISTAS COMPARATIVAS ══════════════════ */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-2 items-start">
          {[
            { key: "recent" as const, title: "Último Mês", list: sortedRecentEntries, caption: "Fechado no último reset" },
            { key: "total" as const, title: "Mês Atual", list: sortedEntries, caption: "Acumulado desde o reset" },
          ].map(panel => (
            <div key={panel.key} className="flex flex-col gap-2 min-w-0">
              <div className="flex items-center justify-between px-2 py-1.5 rounded-xl border border-[var(--th-line)]/50 bg-[var(--th-bg-base)]/90 text-[10px] font-bold uppercase tracking-wider">
                <span className="text-amber-300">{panel.title}</span>
                <span className="text-slate-500">{panel.caption} • {panel.list.length} jogadores</span>
              </div>

              {loading && panel.list.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-slate-500 gap-2 border border-dashed border-[var(--th-line)]/40 rounded-2xl bg-[var(--th-bg-base)]/30">
                  <div className="w-9 h-9 rounded-full border-2 border-amber-500/30 border-t-amber-500 animate-spin" />
                  <span className="text-xs font-bold text-slate-400">Carregando Ranking Universal...</span>
                </div>
              ) : panel.list.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-slate-500 gap-2 border border-dashed border-[var(--th-line)]/40 rounded-2xl bg-[var(--th-bg-base)]/30">
                  <Trophy size={30} className="text-slate-600 mb-1" />
                  <span className="text-xs font-bold text-slate-400">Nenhum jogador pontuado</span>
                  <span className="text-[10px] text-slate-600 text-center max-w-sm">Sem dados para este quadro.</span>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {panel.list.map((entry, idx) => (
                    <PlayerCard key={`${panel.key}_${entry.uid}`} entry={entry} index={idx} scope={panel.key} />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Botão de Paginação "Carregar Mais" */}
        {hasMore && !loading && (
          <div className="pt-2 pb-2 flex justify-center flex-shrink-0">
            <button
              type="button"
              onClick={handleLoadMore}
              disabled={loadingMore}
              className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl bg-gradient-to-r from-[var(--th-bg-overlay)] to-[var(--th-bg-base)] border border-amber-600/40 hover:border-amber-500 text-amber-300 hover:text-white text-xs font-black uppercase tracking-wider shadow-lg hover:shadow-amber-500/10 transition-all cursor-pointer disabled:opacity-50"
            >
              <ArrowDown size={14} className={loadingMore ? "animate-bounce" : ""} />
              <span>{loadingMore ? "Carregando mais jogadores..." : "Carregar mais jogadores"}</span>
            </button>
          </div>
        )}

      </div>{/* fim da área de scroll */}

      {/* ══════════════════ RODAPÉ COM FÓRMULA DO RANKING ══════════════════
          Fixado fora da área de scroll — sempre visível no final da página,
          sem sobrepor nenhum conteúdo ao abrir cards ou em telas menores.
      ══════════════════════════════════════════════════════════════════════ */}
      <div className="flex-shrink-0 px-3 sm:px-4 pb-3 sm:pb-4 pt-0">
        <div className="rounded-xl bg-[var(--th-bg-base)] border border-[var(--th-line)]/40 p-3.5 flex flex-col sm:flex-row items-center justify-between gap-2 text-slate-500 text-[10px]">
          <div className="flex items-center gap-2 font-mono">
            <span className="font-bold text-amber-400 uppercase">Fórmula:</span>
            <span>(PTs×10) + (part.×3) + (sem morte×5) − (mortes×2) + streak + horas + quest + bônus</span>
          </div>
          <div className="flex items-center gap-1.5 text-slate-600 font-medium">
            <span>* Atualizado em tempo real no término de cada Quest</span>
          </div>
        </div>
      </div>

    </div>
  );
}