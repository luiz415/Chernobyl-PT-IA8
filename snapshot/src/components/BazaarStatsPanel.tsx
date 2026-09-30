// ============================================================================
// ESTATÍSTICAS DO BAZAAR — interface ANALÍTICA do histórico oficial
// ----------------------------------------------------------------------------
// Esta tela NÃO é uma listagem de personagens: ela consome as MÉTRICAS
// pré-agregadas da base histórica permanente do Chernobyl Team (leilões
// FINALIZADOS com LANCE VENCEDOR coletados do histórico do RubinOT).
//
// O QUE A TELA LÊ (e só isso):
//   • `bazaar/historySync` — 1 doc de estado (índice de meses + última
//     consulta), com cache local + TTL;
//   • `bazaarHistoryMetrics/{mês__servidor}` — docs de células agregadas,
//     cada um cacheado localmente e relido APENAS quando o mês mudou.
// A base bruta (`bazaarHistoryRaw`) NUNCA é lida aqui; filtros nunca
// consultam o site nem percorrem leilões individuais — tudo é resolvido
// nas células já em memória.
//
// FLUXO DA CONSULTA (exclusiva Boss + Electron):
//   Consultar Histórico → BazaarBrowserModal (mesma configuração das demais
//   consultas; método travado em API JSON) → canal `rubinot-bazaar-history-
//   v1` (navega em https://rubinot.com.br/bazaar/history, descobre a rota
//   JSON real e pagina os ~30 dias por completo, incrementalmente) →
//   precificação de itens no renderer (regras da guia Itens) → ingestão
//   idempotente (base bruta por dia + métricas por mês×servidor + estado).
// ============================================================================

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, BarChart3, Database, Eraser, RefreshCw, Square } from "lucide-react";
import { FilterMulti } from "./FilterTypes";
import BazaarBrowserModal from "./BazaarBrowserModal";
import { MIN_DISPLAY_SKILL, skillDefsForVocation } from "./BazaarItemsPanel";
import {
  buildCharacterMatches,
  buildWatchlistIndex,
  canonicalServerKey,
  collectAllWatchKeys,
  getServerWatchedItems,
  loadItemsCoinRate,
  loadWatchedItemsByServer,
  type WatchedItem,
} from "../utils/bazaarWatchedItems";
import { computeItemRC } from "../utils/itemSale";
import {
  BID_BUCKETS,
  LEVEL_BANDS,
  bandLabel,
  computeStatsFromMetricDocs,
  defaultHistoryFilters,
  hasActiveHistoryFilters,
  monthLabel,
  type BazaarHistoryEntry,
  type BazaarHistoryQueryResponse,
  type HistoryMetricsFilters,
  type HistoryQuestFilter,
  type MetricsDocData,
} from "../utils/bazaarHistoryStats";
import {
  fetchHistoryMetricDocs,
  loadHistorySyncState,
  persistHistoryIngestion,
  recordEmptyHistoryRun,
  type HistoryRunInfo,
  type HistorySyncState,
} from "../services/bazaarHistoryService";

interface HistoryProgressEvent {
  active?: boolean;
  stage?: string;
  message?: string;
  processed?: number;
  total?: number;
  percent?: number;
  /** Carimbo da guia dona da consulta — esta tela SÓ consome 'history'. */
  scope?: string;
}

interface Props {
  isBossUser: boolean;
  isElectron: boolean;
  /** Consulta de QUESTS ou ITENS em andamento — bloqueia o Consultar daqui. */
  isOtherQueryRunning?: boolean;
  /** Avisa o BazarPanel quando a consulta do histórico roda (bloqueio cruzado). */
  onRunningChange?: (running: boolean) => void;
}

/** Número inteiro em pt-BR ("12.345"). */
function formatInt(value: number): string {
  return Math.round(value).toLocaleString("pt-BR");
}

/** Data/hora completa em pt-BR. */
function formatDateTime(ms: number): string {
  if (!ms) return "—";
  try {
    return new Date(ms).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return "—";
  }
}

/** 1 casa decimal com vírgula ("3,5"); inteiros sem casa. */
function formatDec1(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(".", ",");
}

const QUEST_FILTER_LABELS: { value: HistoryQuestFilter; label: string }[] = [
  { value: "any", label: "Tanto Faz" },
  { value: "available", label: "Disponível" },
  { value: "completed", label: "Feita" },
];

export default function BazaarStatsPanel({ isBossUser, isElectron, isOtherQueryRunning, onRunningChange }: Props) {
  // ── Estado analítico (métricas) ───────────────────────────────────────────
  const [syncState, setSyncState] = useState<HistorySyncState | null>(null);
  const [metricDocs, setMetricDocs] = useState<MetricsDocData[]>([]);
  const [filters, setFilters] = useState<HistoryMetricsFilters>(() => defaultHistoryFilters());
  // ── Estado da consulta (exclusiva Boss + Electron) ────────────────────────
  const [isRunning, setIsRunning] = useState(false);
  const [isBrowserModalOpen, setIsBrowserModalOpen] = useState(false);
  const [fullReload, setFullReload] = useState(false);
  const [progress, setProgress] = useState<HistoryProgressEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Bloqueio cruzado: o navegador de sessão é um só para as três consultas.
  useEffect(() => {
    onRunningChange?.(isRunning);
    return () => { if (isRunning) onRunningChange?.(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRunning]);

  /** Carrega estado + TODOS os docs de métricas (cache local absorve custo). */
  async function refreshMetrics(options: { force?: boolean } = {}) {
    const { state } = await loadHistorySyncState(options);
    setSyncState(state);
    if (!state) { setMetricDocs([]); return; }
    const months = Object.keys(state.months || {});
    const { docs } = await fetchHistoryMetricDocs(months, state);
    setMetricDocs(docs);
  }

  useEffect(() => {
    void refreshMetrics();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Progresso do processo principal — MESMO canal das outras guias, filtrado
  // pelo carimbo: esta tela só consome eventos scope 'history'.
  useEffect(() => {
    if (!isElectron) return;
    try {
      const { ipcRenderer } = (window as any).require("electron");
      const applyProgress = (event: HistoryProgressEvent) => {
        if (event?.scope !== "history") return;
        if (!event || event.active === false) { setProgress(null); return; }
        setProgress(event);
      };
      const handleProgress = (_event: unknown, event: HistoryProgressEvent) => applyProgress(event);
      ipcRenderer.on("rubinot-bazaar-progress", handleProgress);
      ipcRenderer.invoke("rubinot-bazaar-current-progress")
        .then((event: HistoryProgressEvent) => applyProgress(event))
        .catch(() => {});
      return () => { ipcRenderer.removeListener("rubinot-bazaar-progress", handleProgress); };
    } catch {
      return;
    }
  }, [isElectron]);

  const monthOptions = useMemo(
    () => Object.keys(syncState?.months || {}).sort((a, b) => b.localeCompare(a)),
    [syncState],
  );
  const serverOptions = useMemo(() => {
    const set = new Set<string>();
    for (const meta of Object.values(syncState?.months || {})) for (const server of meta.servers || []) set.add(server);
    return Array.from(set).sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [syncState]);
  const vocationOptions = useMemo(() => {
    const set = new Set<string>();
    for (const docData of metricDocs) {
      for (const key of Object.keys(docData.cells || {})) set.add(key.split("|")[0] || "—");
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [metricDocs]);

  const stats = useMemo(() => computeStatsFromMetricDocs(metricDocs, filters), [metricDocs, filters]);

  /**
   * Skills médias por vocação — EXIBINDO somente as skills que a guia Itens
   * exibe para aquela vocação (skillDefsForVocation/MIN_DISPLAY_SKILL:
   * regras únicas do app, reutilizadas, nunca reinterpretadas).
   */
  const skillsDisplay = useMemo(() => {
    const groups: { vocation: string; count: number; skills: { abbr: string; full: string; avg: number }[] }[] = [];
    for (const group of stats.skillsByVocation) {
      const defs = skillDefsForVocation(group.vocation);
      if (!defs) continue;
      const skills = defs
        .map(def => {
          const found = group.skills.find(skill => skill.key === def.key);
          return found ? { abbr: def.abbr, full: def.full, avg: found.avg } : null;
        })
        .filter((skill): skill is { abbr: string; full: string; avg: number } => !!skill && skill.avg >= MIN_DISPLAY_SKILL);
      if (skills.length > 0) groups.push({ vocation: group.vocation, count: group.count, skills });
    }
    return groups;
  }, [stats]);

  function updateFilters(patch: Partial<HistoryMetricsFilters>) {
    setFilters(prev => ({ ...prev, ...patch }));
  }

  // ── Consulta: Consultar Histórico → BazaarBrowserModal → executar ────────
  /**
   * 1º passo: validações e abertura do MODAL de configuração — o navegador
   * NUNCA abre direto no clique (mesmo padrão das consultas de Quests e
   * Itens). A execução só começa no onConfirm do modal.
   */
  function requestHistoryQuery() {
    if (!isBossUser) { setError("Apenas usuários Boss podem consultar o histórico do Bazaar."); return; }
    if (!isElectron) { setError("A consulta do histórico precisa ser executada no aplicativo Desktop (Electron)."); return; }
    if (isOtherQueryRunning) { setError("Há outra consulta do Bazaar em andamento. Aguarde a finalização."); return; }
    if (isRunning) return;
    setError(null);
    setNotice(null);
    setIsBrowserModalOpen(true);
  }

  /** 2º passo (onConfirm do modal): executa a consulta de fato. */
  async function executeHistoryQuery(options: { browserKey: string; cleanProfile: boolean }) {
    if (!isBossUser || !isElectron || isRunning || isOtherQueryRunning) return;
    const startedAt = Date.now();
    setIsRunning(true);
    setError(null);
    setNotice(null);
    setProgress(null);
    try {
      const { ipcRenderer } = (window as any).require("electron");

      // Fronteira incremental FRESCA (força a leitura do doc de estado):
      // é ela que impede reprocessar os milhares de leilões já ingeridos.
      const { state: prevState } = await loadHistorySyncState({ force: true });

      const response = await ipcRenderer.invoke("rubinot-bazaar-history-v1", {
        // Itens monitorados de TODOS os servidores; a precificação (lista
        // do servidor do personagem, SEM fallback) acontece aqui no
        // renderer, com as mesmas funções da guia Itens.
        watchKeys: collectAllWatchKeys(loadWatchedItemsByServer()),
        sinceEndTs: fullReload ? 0 : (prevState?.lastEndTs || 0),
        knownIds: Object.keys(prevState?.recent || {}),
        fullReload,
        browser: options.browserKey,
        cleanProfile: options.cleanProfile,
      }) as BazaarHistoryQueryResponse;

      if (!response?.ok) {
        setError(response?.error || "Falha na consulta do histórico do Bazaar.");
        return;
      }

      // ── Precificação de itens (regras idênticas à guia Itens) ────────────
      const coinRate = loadItemsCoinRate();
      const watchedByServer = loadWatchedItemsByServer();
      const indexCache = new Map<string, Map<string, WatchedItem>>();
      const indexFor = (server: string) => {
        const key = canonicalServerKey(server);
        let index = indexCache.get(key);
        if (!index) {
          index = buildWatchlistIndex(getServerWatchedItems(watchedByServer, key));
          indexCache.set(key, index);
        }
        return index;
      };

      const entries: BazaarHistoryEntry[] = (response.entries || [])
        .filter(raw => raw.id && raw.auctionEndTs)
        .map(raw => {
          const { matches, totalKk } = buildCharacterMatches(raw.matches || [], indexFor(raw.server));
          const entry: BazaarHistoryEntry = {
            id: raw.id,
            name: raw.name,
            vocation: raw.vocation,
            level: raw.level,
            server: raw.server,
            endTs: raw.auctionEndTs || 0,
            bidRc: raw.winningBid,
            itemsKk: totalKk,
            itemsRc: coinRate > 0 && totalKk > 0 ? computeItemRC(coinRate, totalKk) : 0,
            coinRateKk: coinRate,
            soulwar: raw.soulwarCompleted ?? null,
            sanguine: raw.sanguineCompleted ?? null,
            charmPoints: raw.charmPoints ?? null,
            auraCount: raw.auraCount ?? null,
            hirelingCount: raw.hirelingCount ?? null,
            deluxePassCount: raw.deluxePassCount ?? null,
          };
          if (matches.length > 0) {
            entry.matches = matches.map(match => ({
              foundName: match.foundName,
              tier: match.tier,
              amount: match.amount,
              totalKk: match.totalKk,
            }));
          }
          if (Number(raw.gold || 0) > 0) entry.goldKk = Number(raw.gold);
          if (raw.skills && Object.keys(raw.skills).length > 0) entry.skills = raw.skills;
          if (raw.statusText) entry.statusText = raw.statusText;
          if (raw.detailError) entry.detailError = raw.detailError;
          return entry;
        });

      const run: HistoryRunInfo = {
        startedAtMs: startedAt,
        durationMs: response.totalDurationMs || (Date.now() - startedAt),
        listedCount: response.listedCount || 0,
        approvedNewCount: response.approvedNewCount || 0,
        knownSkippedCount: response.knownSkippedCount || 0,
        analyzedCount: response.analyzedCount || 0,
        failedCount: response.failedCount || 0,
        stoppedManually: response.stoppedManually === true,
        ...(response.routeUsed ? { routeUsed: response.routeUsed } : {}),
        ...(response.pagesScanned ? { pagesScanned: response.pagesScanned } : {}),
        ...(response.processedMaxEndTs ? { processedMaxEndTs: response.processedMaxEndTs } : {}),
      };

      // ── Ingestão idempotente (base bruta + métricas + estado) ────────────
      const result = entries.length > 0
        ? await persistHistoryIngestion(entries, run, prevState)
        : await recordEmptyHistoryRun(run, prevState);

      if (!result.ok) {
        setError(`Consulta concluída, mas a gravação no Firestore falhou: ${result.error || "erro desconhecido"}. Nada foi perdido no site — repita a consulta.`);
        return;
      }
      setSyncState(result.state);
      // Docs de métricas recém-escritos já estão no cache local: recarregar
      // aqui custa ZERO leituras extras.
      if (result.state) {
        const { docs } = await fetchHistoryMetricDocs(Object.keys(result.state.months || {}), result.state);
        setMetricDocs(docs);
      }

      const pieces = [
        `${formatInt(entries.length)} leilão(ões) novo(s) adicionados à base histórica`,
        response.knownSkippedCount ? `${formatInt(response.knownSkippedCount)} já conhecidos ignorados` : "",
        response.failedCount ? `${formatInt(response.failedCount)} detalhes sem resposta (dados da listagem preservados)` : "",
        response.stoppedManually ? "consulta encerrada manualmente — a próxima retoma da fronteira" : "",
      ].filter(Boolean);
      setNotice(pieces.join(" · ") + ".");
      setFullReload(false);
    } catch (err: any) {
      setError(String(err?.message || err));
    } finally {
      setIsRunning(false);
      setProgress(null);
    }
  }

  /** Encerramento antecipado — mesmo canal de parada das demais consultas. */
  async function requestStop() {
    try {
      const { ipcRenderer } = (window as any).require("electron");
      await ipcRenderer.invoke("rubinot-bazaar-request-stop");
    } catch { /* Electron indisponível */ }
  }

  const labelClass = "text-[9px] font-black uppercase tracking-wide text-slate-400";
  const lastRun = syncState?.lastRun;
  const totalCount = syncState?.totalCount || 0;

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-1.5 overflow-hidden">
      {error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300 flex items-center gap-2">
          <AlertTriangle size={15} /> {error}
        </div>
      )}
      {notice && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200 flex items-center gap-2">
          <Database size={15} className="text-emerald-400 flex-shrink-0" /> {notice}
        </div>
      )}

      {/* ── BASE HISTÓRICA + ÚLTIMA CONSULTA + CONTROLES ─────────────────── */}
      <div className="rounded-xl border border-[var(--th-line)]/60 bg-[var(--th-n-base)]/80 backdrop-blur-md px-3 py-2 flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <div className="flex items-center gap-2 min-w-0">
          <BarChart3 size={14} className="text-sky-300 flex-shrink-0" />
          <div className="min-w-0">
            <div className="text-[10px] font-black text-slate-200">
              Base histórica: {formatInt(totalCount)} leilão(ões) finalizados com lance vencedor
              {monthOptions.length > 0 && <span className="text-slate-400 font-bold"> · {monthOptions.length} mês(es)</span>}
            </div>
            {lastRun ? (
              <div className="text-[10px] text-slate-400">
                Última consulta: {formatDateTime(lastRun.startedAtMs)}
                {" · "}<span className="text-slate-300">{formatInt(lastRun.listedCount)}</span> listados
                {" · "}<span className="text-emerald-300">{formatInt(lastRun.approvedNewCount)}</span> novos aprovados
                {lastRun.knownSkippedCount > 0 && <>{" · "}<span className="text-slate-300">{formatInt(lastRun.knownSkippedCount)}</span> já conhecidos</>}
                {lastRun.failedCount > 0 && <>{" · "}<span className="text-amber-300">{formatInt(lastRun.failedCount)}</span> falhas de detalhe</>}
                {lastRun.stoppedManually && <span className="text-amber-300"> · encerrada manualmente</span>}
              </div>
            ) : (
              <div className="text-[10px] text-slate-500">Nenhuma consulta do histórico registrada ainda.</div>
            )}
          </div>
        </div>

        {/* Controles — SOMENTE Boss no Electron. O clique abre o MODAL de
            configuração (BazaarBrowserModal); o navegador nunca abre direto. */}
        {isBossUser && isElectron && (
          <div className="ml-auto flex items-center gap-1.5">
            <label
              className="inline-flex h-7 items-center gap-1 px-2 rounded-lg border border-[var(--th-line)]/60 bg-black/20 text-[9px] font-black uppercase tracking-wide text-slate-400 cursor-pointer select-none"
              title="Ignora a fronteira incremental e repassa os 30 dias completos do site (leilões já conhecidos continuam sem duplicar)"
            >
              <input
                type="checkbox"
                checked={fullReload}
                onChange={e => setFullReload(e.target.checked)}
                disabled={isRunning}
                className="accent-sky-500"
              />
              30 dias completos
            </label>
            {isRunning ? (
              <button
                type="button"
                onClick={() => void requestStop()}
                className="inline-flex h-7 items-center gap-1 px-2.5 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-200 text-[10px] font-black transition-all cursor-pointer hover:bg-amber-500/20 hover:border-amber-400/60"
                title="Encerra a consulta após o leilão atual. Tudo que já foi processado é salvo; a próxima consulta retoma da fronteira."
              >
                <Square size={11} /> Parar
              </button>
            ) : (
              <button
                type="button"
                onClick={requestHistoryQuery}
                disabled={!!isOtherQueryRunning}
                title={isOtherQueryRunning ? "Outra consulta do Bazaar em andamento — aguarde a finalização." : "Abre a configuração da consulta (navegador) e coleta os leilões finalizados do histórico oficial"}
                className="inline-flex h-7 items-center gap-1 px-2.5 rounded-lg bg-gradient-to-r from-sky-700/80 to-sky-600/80 hover:from-sky-600 hover:to-sky-500 border border-sky-500/40 text-black text-[10px] font-black transition-all cursor-pointer shadow-md shadow-sky-900/15 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <RefreshCw size={12} /> Consultar Histórico
              </button>
            )}
          </div>
        )}

        {/* Progresso ao vivo — apenas o da CONSULTA DO HISTÓRICO */}
        {isRunning && (
          <div className="w-full space-y-0.5">
            <div className="flex items-center gap-2 text-[10px] text-sky-200">
              <RefreshCw size={11} className="animate-spin" />
              <span className="truncate">{progress?.message || "Consultando histórico..."}</span>
              {(progress?.total || 0) > 0 && (
                <span className="font-mono flex-shrink-0">{progress?.processed}/{progress?.total}</span>
              )}
            </div>
            {(progress?.total || 0) > 0 && (
              <div className="h-1 rounded bg-black/40 overflow-hidden">
                <div className="h-full bg-gradient-to-r from-sky-600 to-sky-400 transition-all" style={{ width: `${progress?.percent || 0}%` }} />
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── FILTROS (dimensões das métricas — 100% locais) ────────────────── */}
      <div className="rounded-xl border border-[var(--th-line)]/60 bg-[var(--th-n-base)]/80 backdrop-blur-md px-3 py-2 flex flex-wrap items-end gap-x-3 gap-y-1.5">
        <div className="flex flex-col gap-0.5">
          <span className={labelClass}>Meses</span>
          <FilterMulti label="Meses" options={monthOptions} selected={filters.months} onApply={values => updateFilters({ months: values })} placeholder="Meses" searchable />
        </div>
        <div className="flex flex-col gap-0.5">
          <span className={labelClass}>Servidor</span>
          <FilterMulti label="Servidor" options={serverOptions} selected={filters.servers} onApply={values => updateFilters({ servers: values })} placeholder="Servidor" searchable />
        </div>
        <div className="flex flex-col gap-0.5">
          <span className={labelClass}>Vocação</span>
          <FilterMulti label="Vocação" options={vocationOptions} selected={filters.vocations} onApply={values => updateFilters({ vocations: values })} placeholder="Vocação" searchable />
        </div>
        <div className="flex flex-col gap-0.5">
          <span className={labelClass}>Level</span>
          <FilterMulti
            label="Level"
            options={LEVEL_BANDS.map(band => band.label)}
            selected={filters.levelBands.map(key => bandLabel(LEVEL_BANDS, key))}
            onApply={labels => updateFilters({ levelBands: LEVEL_BANDS.filter(band => labels.includes(band.label)).map(band => band.key) })}
            placeholder="Level"
          />
        </div>
        <div className="flex flex-col gap-0.5">
          <span className={labelClass}>Lance</span>
          <FilterMulti
            label="Lance"
            options={BID_BUCKETS.map(bucket => bucket.label)}
            selected={filters.bidBuckets.map(key => bandLabel(BID_BUCKETS, key))}
            onApply={labels => updateFilters({ bidBuckets: BID_BUCKETS.filter(bucket => labels.includes(bucket.label)).map(bucket => bucket.key) })}
            placeholder="Lance"
          />
        </div>
        {([["Soul War", "soulwar"], ["Sanguine", "sanguine"]] as const).map(([label, field]) => (
          <div key={field} className="flex flex-col gap-0.5">
            <span className={labelClass}>{label}</span>
            <select
              value={filters[field]}
              onChange={e => updateFilters({ [field]: e.target.value as HistoryQuestFilter } as Partial<HistoryMetricsFilters>)}
              className="h-6 rounded-md border border-[var(--th-line)]/60 bg-black/30 px-1.5 text-[10px] text-slate-200 outline-none focus:border-sky-400/60 cursor-pointer"
            >
              {QUEST_FILTER_LABELS.map(option => (
                <option key={option.value} value={option.value} className="bg-slate-900">{option.label}</option>
              ))}
            </select>
          </div>
        ))}
        {hasActiveHistoryFilters(filters) && (
          <button
            type="button"
            onClick={() => setFilters(defaultHistoryFilters())}
            className="inline-flex h-6 items-center gap-1 px-2 rounded-md border border-rose-500/25 bg-rose-500/10 text-rose-300 text-[9px] font-black transition-all cursor-pointer hover:bg-rose-500/20"
          >
            <Eraser size={10} /> Limpar Filtros
          </button>
        )}
        <div className="ml-auto text-[10px] text-slate-400">
          <span className="font-black text-slate-200">{formatInt(stats.count)}</span> de {formatInt(totalCount)} leilões no filtro
        </div>
      </div>

      {/* ── ESTATÍSTICAS (somente métricas agregadas) ─────────────────────── */}
      <div className="flex-1 min-h-0 overflow-y-auto space-y-1.5 pr-0.5">
        {metricDocs.length === 0 ? (
          <div className="rounded-xl border border-[var(--th-line)]/60 bg-[var(--th-n-base)]/80 px-4 py-8 text-center text-xs text-slate-400">
            {isBossUser && isElectron
              ? "Base histórica vazia. Clique em “Consultar Histórico” para a primeira carga dos 30 dias disponíveis no site."
              : "Base histórica vazia. Aguarde a primeira consulta do Boss."}
          </div>
        ) : (
          <>
            {/* VALOR MÉDIO DO LANCE VENCEDOR — o destaque da tela */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-1.5">
              <div className="rounded-xl border border-sky-500/40 bg-gradient-to-br from-sky-500/15 to-sky-900/20 px-3 py-2.5 shadow-[0_0_18px_color-mix(in_oklab,var(--color-sky-500)_12%,transparent)]">
                <div className="text-[9px] font-black uppercase tracking-wide text-sky-300">Valor médio do lance vencedor</div>
                <div className="text-2xl font-black text-sky-100">{stats.count > 0 ? `${formatInt(stats.avgWinningBidRc)} RC` : "—"}</div>
                <div className="text-[10px] text-sky-300/80">{formatInt(stats.count)} personagens vendidos no filtro</div>
              </div>
              <div className="rounded-xl border border-[var(--th-line)]/60 bg-[var(--th-n-base)]/80 px-3 py-2.5">
                <div className="text-[9px] font-black uppercase tracking-wide text-slate-400">Lance mínimo / máximo</div>
                <div className="text-lg font-black text-slate-100">
                  {stats.count > 0 ? <>{formatInt(stats.minWinningBidRc)} <span className="text-slate-500 text-sm">/</span> {formatInt(stats.maxWinningBidRc)} RC</> : "—"}
                </div>
                <div className="text-[10px] text-slate-500">entre os lances vencedores do filtro</div>
              </div>
              <div className="rounded-xl border border-[var(--th-line)]/60 bg-[var(--th-n-base)]/80 px-3 py-2.5">
                <div className="text-[9px] font-black uppercase tracking-wide text-slate-400">Valor médio dos itens monitorados</div>
                <div className="text-lg font-black text-slate-100">
                  {stats.withItemsCount > 0 ? `${formatInt(stats.avgItemsRc)} RC` : "—"}
                </div>
                <div className="text-[10px] text-slate-500">
                  {stats.withItemsCount > 0
                    ? `${formatInt(stats.withItemsCount)} personagens com itens da lista (cotação da ingestão)`
                    : "nenhum personagem com itens avaliados no filtro"}
                </div>
              </div>
            </div>

            {/* MÉDIAS GERAIS */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-1.5">
              {([
                ["Level médio", stats.count > 0 ? formatInt(stats.avgLevel) : "—", `${formatInt(stats.count)} personagens`],
                ["Charm Points médios", stats.charmSampleCount > 0 ? formatInt(stats.avgCharmPoints) : "—", `${formatInt(stats.charmSampleCount)} com dado`],
                ["Auras médias", stats.auraSampleCount > 0 ? formatDec1(stats.avgAuras) : "—", `${formatInt(stats.auraSampleCount)} com dado`],
                ["Hirelings médios", stats.hirelingSampleCount > 0 ? formatDec1(stats.avgHirelings) : "—", `${formatInt(stats.hirelingSampleCount)} com dado`],
                ["Passes Deluxe médios", stats.deluxeSampleCount > 0 ? formatDec1(stats.avgDeluxePasses) : "—", `${formatInt(stats.deluxeSampleCount)} com dado`],
              ] as const).map(([title, value, hint]) => (
                <div key={title} className="rounded-xl border border-[var(--th-line)]/60 bg-[var(--th-n-base)]/80 px-3 py-2">
                  <div className="text-[9px] font-black uppercase tracking-wide text-slate-400">{title}</div>
                  <div className="text-base font-black text-slate-100">{value}</div>
                  <div className="text-[9px] text-slate-500">{hint}</div>
                </div>
              ))}
            </div>

            {/* EVOLUÇÃO MENSAL — análise histórica (partição central por mês) */}
            {stats.byMonth.length > 0 && (
              <div className="rounded-xl border border-[var(--th-line)]/60 bg-[var(--th-n-base)]/80 px-3 py-2">
                <div className="text-[9px] font-black uppercase tracking-wide text-slate-400 mb-1">Evolução mensal (vendidos · lance médio)</div>
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {stats.byMonth.map(month => (
                    <div key={month.label} className="text-[10px] text-slate-400">
                      <span className="font-bold text-slate-300">{monthLabel(month.label)}</span>:{" "}
                      <span className="text-slate-200 font-bold">{formatInt(month.count)}</span> vendidos ·{" "}
                      <span className="text-sky-300 font-bold">{formatInt(month.avgBid)} RC</span> médio
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* SW/SG + DISTRIBUIÇÕES */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-1.5">
              <div className="rounded-xl border border-[var(--th-line)]/60 bg-[var(--th-n-base)]/80 px-3 py-2">
                <div className="text-[9px] font-black uppercase tracking-wide text-slate-400 mb-1">Soul War / Sanguine</div>
                {([["Soul War", stats.soulwar], ["Sanguine", stats.sanguine]] as const).map(([label, dist]) => (
                  <div key={label} className="flex items-center justify-between gap-2 text-[10px] py-0.5">
                    <span className="font-bold text-slate-300">{label}</span>
                    <span className="text-slate-400">
                      <span className="text-emerald-300 font-bold">{formatInt(dist.available)}</span> disponível
                      {" · "}<span className="text-amber-300 font-bold">{formatInt(dist.completed)}</span> feita
                      {dist.unknown > 0 && <>{" · "}<span className="text-slate-500">{formatInt(dist.unknown)} sem dado</span></>}
                    </span>
                  </div>
                ))}
              </div>
              {([["Por vocação", stats.byVocation], ["Por servidor", stats.byServer]] as const).map(([title, dist]) => (
                <div key={title} className="rounded-xl border border-[var(--th-line)]/60 bg-[var(--th-n-base)]/80 px-3 py-2">
                  <div className="text-[9px] font-black uppercase tracking-wide text-slate-400 mb-1">{title}</div>
                  <div className="space-y-0.5 max-h-28 overflow-y-auto pr-1">
                    {dist.map(row => (
                      <div key={row.label} className="flex items-center gap-2 text-[10px]">
                        <span className="w-24 truncate text-slate-300 font-bold flex-shrink-0">{row.label}</span>
                        <div className="flex-1 h-1.5 rounded bg-black/40 overflow-hidden">
                          <div className="h-full bg-gradient-to-r from-sky-600 to-sky-400" style={{ width: `${stats.count > 0 ? Math.max(3, Math.round((row.count / stats.count) * 100)) : 0}%` }} />
                        </div>
                        <span className="w-10 text-right font-mono text-slate-400 flex-shrink-0">{formatInt(row.count)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {/* DISTRIBUIÇÕES DE LANCE E CHARM (histogramas das células) */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-1.5">
              {([["Distribuição do lance vencedor", stats.bidDistribution], ["Distribuição de Charm Points", stats.charmDistribution]] as const).map(([title, dist]) => (
                dist.length > 0 && (
                  <div key={title} className="rounded-xl border border-[var(--th-line)]/60 bg-[var(--th-n-base)]/80 px-3 py-2">
                    <div className="text-[9px] font-black uppercase tracking-wide text-slate-400 mb-1">{title}</div>
                    <div className="space-y-0.5">
                      {dist.map(row => (
                        <div key={row.label} className="flex items-center gap-2 text-[10px]">
                          <span className="w-24 truncate text-slate-300 font-bold flex-shrink-0">{row.label}</span>
                          <div className="flex-1 h-1.5 rounded bg-black/40 overflow-hidden">
                            <div className="h-full bg-gradient-to-r from-sky-600 to-sky-400" style={{ width: `${stats.count > 0 ? Math.max(3, Math.round((row.count / stats.count) * 100)) : 0}%` }} />
                          </div>
                          <span className="w-10 text-right font-mono text-slate-400 flex-shrink-0">{formatInt(row.count)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              ))}
            </div>

            {/* SKILLS MÉDIAS POR VOCAÇÃO — mesmas regras da guia Itens */}
            {skillsDisplay.length > 0 && (
              <div className="rounded-xl border border-[var(--th-line)]/60 bg-[var(--th-n-base)]/80 px-3 py-2">
                <div className="text-[9px] font-black uppercase tracking-wide text-slate-400 mb-1">Skills médias por vocação</div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-1">
                  {skillsDisplay.map(group => (
                    <div key={group.vocation} className="flex items-center justify-between gap-2 text-[10px]">
                      <span className="font-bold text-slate-300 truncate">{group.vocation} <span className="text-slate-500">({formatInt(group.count)})</span></span>
                      <span className="text-slate-400 flex-shrink-0">
                        {group.skills.map((skill, index) => (
                          <span key={skill.abbr} title={skill.full}>
                            {index > 0 && " · "}
                            {skill.abbr} <span className="text-sky-300 font-bold">{formatInt(skill.avg)}</span>
                          </span>
                        ))}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Configuração da consulta — MESMO modal das demais consultas do
          Bazaar (navegador/perfil/velocidade); método travado em API JSON.
          O navegador SÓ abre depois do "Iniciar consulta" daqui. ──────────── */}
      <BazaarBrowserModal
        open={isBrowserModalOpen}
        forcedMethod="novo"
        onCancel={() => setIsBrowserModalOpen(false)}
        onConfirm={(browserKey, _browserOrder, cleanProfile) => {
          setIsBrowserModalOpen(false);
          void executeHistoryQuery({ browserKey, cleanProfile });
        }}
      />
    </div>
  );
}
