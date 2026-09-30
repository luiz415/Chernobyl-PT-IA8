// ============================================================================
// ESTATÍSTICAS DO BAZAAR — tela do histórico oficial (3º modo do painel)
// ----------------------------------------------------------------------------
// Consome o HISTÓRICO oficial do Bazaar (leilões FINALIZADOS com LANCE
// VENCEDOR) e apresenta estatísticas 100% locais sobre o conjunto filtrado.
//
// FONTES DE DADOS (nesta ordem de prioridade, pela consulta mais RECENTE):
//   • última consulta local (`rubinot_bazaar_history_last_query`) — gravada
//     pelo próprio dispositivo do Boss ao consultar;
//   • doc publicado `bazaar/history` (Firestore, doc único) — como TODOS os
//     usuários do painel recebem os dados sem Electron/sessão.
//
// A CONSULTA (botão "Consultar Histórico") é exclusiva do Boss no Electron:
// canal dedicado `rubinot-bazaar-history-v1` (100% API JSON, sem fallback de
// scraping — ver electron-bazaar-history.cjs). Os FILTROS desta tela nunca
// disparam consulta nova: filtram o conjunto já salvo, localmente.
//
// REUSO (nenhuma reinterpretação):
//   • skills por vocação: SKILL_DISPLAY/skillDefsForVocation/MIN_DISPLAY_
//     SKILL exportados do BazaarItemsPanel — as MESMAS regras da guia Itens;
//   • kk→RC: computeItemRC com a cotação carimbada NA consulta (coinRateKk);
//   • filtros multi: FilterMulti (o mesmo componente das tabelas do Bazaar).
// ============================================================================

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, BarChart3, Eraser, RefreshCw, Square } from "lucide-react";
import { FilterMulti } from "./FilterTypes";
import { MIN_DISPLAY_SKILL, skillDefsForVocation } from "./BazaarItemsPanel";
import { collectAllWatchKeys, loadWatchedItemsByServer } from "../utils/bazaarWatchedItems";
import {
  applyHistoryFilters,
  buildHistoryLastQuery,
  computeHistoryStats,
  defaultHistoryFilters,
  hasActiveHistoryFilters,
  loadHistoryLastQuery,
  saveHistoryLastQuery,
  type BazaarHistoryEntry,
  type BazaarHistoryFilters,
  type BazaarHistoryLastQuery,
  type BazaarHistoryQueryResponse,
  type HistoryQuestFilter,
} from "../utils/bazaarHistoryStats";
import { publishBazaarHistory, readOfficialHistoryCache, syncBazaarHistory } from "../services/bazaarHistoryService";

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

/** Data/hora completa da consulta em pt-BR. */
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
  // ── Fontes de dados ────────────────────────────────────────────────────────
  const [localQuery, setLocalQuery] = useState<BazaarHistoryLastQuery | null>(() => loadHistoryLastQuery());
  const [officialQuery, setOfficialQuery] = useState<BazaarHistoryLastQuery | null>(() => readOfficialHistoryCache()?.query || null);
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState<HistoryProgressEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [maxPagesText, setMaxPagesText] = useState("10");
  const [filters, setFilters] = useState<BazaarHistoryFilters>(() => defaultHistoryFilters());

  // Bloqueio cruzado: o BazarPanel precisa saber quando ESTA consulta roda
  // (o navegador de sessão é um só). Efeito para cobrir também o unmount.
  useEffect(() => {
    onRunningChange?.(isRunning);
    return () => { if (isRunning) onRunningChange?.(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRunning]);

  // Sincronização do doc publicado — cache local responde na hora; a
  // releitura do Firestore respeita o TTL do serviço (custo mínimo).
  useEffect(() => {
    let cancelled = false;
    void syncBazaarHistory().then(result => {
      if (!cancelled && result.cache) setOfficialQuery(result.cache.query);
    });
    return () => { cancelled = true; };
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

  // Fonte EFETIVA = consulta mais recente entre a local e a publicada.
  const activeQuery: BazaarHistoryLastQuery | null = useMemo(() => {
    if (localQuery && officialQuery) {
      return localQuery.fetchedAtMs >= officialQuery.fetchedAtMs ? localQuery : officialQuery;
    }
    return localQuery || officialQuery;
  }, [localQuery, officialQuery]);

  const entries: BazaarHistoryEntry[] = activeQuery?.entries || [];
  const coinRateKk = activeQuery?.coinRateKk || 0;

  const serverOptions = useMemo(() => Array.from(new Set(entries.map(e => e.server).filter(Boolean))).sort((a, b) => a.localeCompare(b, "pt-BR")), [entries]);
  const vocationOptions = useMemo(() => Array.from(new Set(entries.map(e => e.vocation).filter(Boolean))).sort((a, b) => a.localeCompare(b, "pt-BR")), [entries]);

  const filtered = useMemo(() => applyHistoryFilters(entries, filters, coinRateKk), [entries, filters, coinRateKk]);
  const stats = useMemo(() => computeHistoryStats(filtered, coinRateKk), [filtered, coinRateKk]);

  // Médias de skills POR VOCAÇÃO — exibindo somente as skills que a guia
  // Itens exibe para aquela vocação (skillDefsForVocation, regras únicas).
  const skillsByVocation = useMemo(() => {
    const groups: { vocation: string; count: number; skills: { abbr: string; full: string; avg: number }[] }[] = [];
    for (const vocation of Array.from(new Set(filtered.map(e => e.vocation).filter(Boolean)))) {
      const defs = skillDefsForVocation(vocation);
      if (!defs) continue;
      const subset = filtered.filter(e => e.vocation === vocation);
      const subsetStats = computeHistoryStats(subset, coinRateKk);
      const skills = defs
        .map(def => ({ abbr: def.abbr, full: def.full, avg: subsetStats.avgSkills[def.key] ?? 0 }))
        .filter(skill => skill.avg >= MIN_DISPLAY_SKILL);
      if (skills.length > 0) groups.push({ vocation, count: subset.length, skills });
    }
    return groups.sort((a, b) => b.count - a.count || a.vocation.localeCompare(b.vocation, "pt-BR"));
  }, [filtered, coinRateKk]);

  function updateFilters(patch: Partial<BazaarHistoryFilters>) {
    setFilters(prev => ({ ...prev, ...patch }));
  }

  // ── Consulta (exclusiva Boss + Electron) ──────────────────────────────────
  async function runHistoryQuery() {
    if (!isBossUser || !isElectron || isRunning || isOtherQueryRunning) return;
    setError(null);
    setNotice(null);
    setIsRunning(true);
    setProgress(null);
    try {
      const { ipcRenderer } = (window as any).require("electron");
      const maxPages = Math.min(50, Math.max(1, Math.floor(Number(maxPagesText) || 10)));
      const response = await ipcRenderer.invoke("rubinot-bazaar-history-v1", {
        maxPages,
        // Itens monitorados de TODOS os servidores: o Electron devolve os
        // matches brutos; a precificação (lista do servidor do personagem,
        // sem fallback) acontece aqui no renderer, em buildHistoryLastQuery.
        watchKeys: collectAllWatchKeys(loadWatchedItemsByServer()),
      }) as BazaarHistoryQueryResponse;
      if (!response?.ok) {
        setError(response?.error || "Falha na consulta do histórico do Bazaar.");
        return;
      }
      const query = buildHistoryLastQuery(response);
      saveHistoryLastQuery(query);
      setLocalQuery(query);
      // Publicação (1 escrita, doc único) — os demais usuários recebem via
      // sync. Falha aqui NÃO invalida a consulta local: apenas avisa.
      const publish = await publishBazaarHistory(query);
      if (!publish.ok) {
        setNotice(`Consulta salva neste dispositivo, mas a publicação para os demais usuários falhou: ${publish.error || "erro desconhecido"}`);
      } else if (response.stoppedManually) {
        setNotice("Consulta encerrada manualmente — os resultados já analisados foram salvos e publicados.");
      }
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

  const inputClass = "h-6 w-20 rounded-md border border-[var(--th-line)]/60 bg-black/30 px-1.5 text-[10px] text-slate-200 outline-none focus:border-sky-400/60";
  const labelClass = "text-[9px] font-black uppercase tracking-wide text-slate-400";

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-1.5 overflow-hidden">
      {error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300 flex items-center gap-2">
          <AlertTriangle size={15} /> {error}
        </div>
      )}
      {notice && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200 flex items-center gap-2">
          <AlertTriangle size={15} className="text-amber-400" /> {notice}
        </div>
      )}

      {/* ── ÚLTIMA CONSULTA + CONTROLES ──────────────────────────────────── */}
      <div className="rounded-xl border border-[var(--th-line)]/60 bg-[var(--th-n-base)]/80 backdrop-blur-md px-3 py-2 flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <div className="flex items-center gap-2 min-w-0">
          <BarChart3 size={14} className="text-sky-300 flex-shrink-0" />
          <div className="min-w-0">
            <div className="text-[10px] font-black text-slate-200">Última consulta do histórico</div>
            {activeQuery ? (
              <div className="text-[10px] text-slate-400">
                {formatDateTime(activeQuery.fetchedAtMs)}
                {" · "}<span className="text-slate-300">{formatInt(activeQuery.listedCount)}</span> leilões encontrados
                {" · "}<span className="text-emerald-300">{formatInt(activeQuery.approvedCount)}</span> aprovados (finalizados com lance vencedor)
                {activeQuery.failedCount > 0 && <>{" · "}<span className="text-amber-300">{formatInt(activeQuery.failedCount)}</span> detalhes sem resposta</>}
                {activeQuery.stoppedManually && <span className="text-amber-300"> · encerrada manualmente</span>}
              </div>
            ) : (
              <div className="text-[10px] text-slate-500">Nenhuma consulta do histórico disponível ainda.</div>
            )}
          </div>
        </div>

        {/* Controles de consulta — SOMENTE Boss no Electron. Os filtros da
            tela nunca consultam o site: filtram o que já foi salvo. */}
        {isBossUser && isElectron && (
          <div className="ml-auto flex items-center gap-1.5">
            <label className={labelClass} htmlFor="history-max-pages">Páginas</label>
            <input
              id="history-max-pages"
              type="text"
              inputMode="numeric"
              value={maxPagesText}
              onChange={e => setMaxPagesText(e.target.value.replace(/[^0-9]/g, "").slice(0, 2))}
              disabled={isRunning}
              className="h-7 w-12 rounded-lg border border-[var(--th-line)]/60 bg-black/30 px-2 text-center text-[11px] font-bold text-slate-200 outline-none focus:border-sky-400/60 disabled:opacity-50"
              title="Quantas páginas da listagem do histórico consultar (100 leilões por página)"
            />
            {isRunning ? (
              <button
                type="button"
                onClick={() => void requestStop()}
                className="inline-flex h-7 items-center gap-1 px-2.5 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-200 text-[10px] font-black transition-all cursor-pointer hover:bg-amber-500/20 hover:border-amber-400/60"
                title="Encerra a consulta após o personagem atual. Os resultados já analisados são mantidos."
              >
                <Square size={11} /> Parar
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void runHistoryQuery()}
                disabled={!!isOtherQueryRunning}
                title={isOtherQueryRunning ? "Outra consulta do Bazaar em andamento — aguarde a finalização." : "Consulta o histórico oficial (leilões finalizados com lance vencedor)"}
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

      {/* ── FILTROS (100% locais — nunca disparam consulta nova) ─────────── */}
      <div className="rounded-xl border border-[var(--th-line)]/60 bg-[var(--th-n-base)]/80 backdrop-blur-md px-3 py-2 flex flex-wrap items-end gap-x-3 gap-y-1.5">
        <div className="flex flex-col gap-0.5">
          <span className={labelClass}>Servidor</span>
          <FilterMulti label="Servidor" options={serverOptions} selected={filters.servers} onApply={values => updateFilters({ servers: values })} placeholder="Servidor" searchable />
        </div>
        <div className="flex flex-col gap-0.5">
          <span className={labelClass}>Vocação</span>
          <FilterMulti label="Vocação" options={vocationOptions} selected={filters.vocations} onApply={values => updateFilters({ vocations: values })} placeholder="Vocação" searchable />
        </div>
        {([["Soul War", "soulwar"], ["Sanguine", "sanguine"]] as const).map(([label, field]) => (
          <div key={field} className="flex flex-col gap-0.5">
            <span className={labelClass}>{label}</span>
            <select
              value={filters[field]}
              onChange={e => updateFilters({ [field]: e.target.value as HistoryQuestFilter } as Partial<BazaarHistoryFilters>)}
              className="h-6 rounded-md border border-[var(--th-line)]/60 bg-black/30 px-1.5 text-[10px] text-slate-200 outline-none focus:border-sky-400/60 cursor-pointer"
            >
              {QUEST_FILTER_LABELS.map(option => (
                <option key={option.value} value={option.value} className="bg-slate-900">{option.label}</option>
              ))}
            </select>
          </div>
        ))}
        {([
          ["Level", "levelMin", "levelMax"],
          ["Lance (RC)", "bidMin", "bidMax"],
          ["Itens (RC)", "itemsRcMin", "itemsRcMax"],
          ["Charm Points", "charmMin", "charmMax"],
        ] as const).map(([label, minField, maxField]) => (
          <div key={minField} className="flex flex-col gap-0.5">
            <span className={labelClass}>{label}</span>
            <div className="flex items-center gap-1">
              <input type="text" inputMode="numeric" placeholder="mín" value={filters[minField]} onChange={e => updateFilters({ [minField]: e.target.value.replace(/[^0-9]/g, "") } as Partial<BazaarHistoryFilters>)} className={inputClass} />
              <span className="text-[10px] text-slate-500">–</span>
              <input type="text" inputMode="numeric" placeholder="máx" value={filters[maxField]} onChange={e => updateFilters({ [maxField]: e.target.value.replace(/[^0-9]/g, "") } as Partial<BazaarHistoryFilters>)} className={inputClass} />
            </div>
          </div>
        ))}
        {([
          ["Auras ≥", "aurasMin"],
          ["Hirelings ≥", "hirelingsMin"],
          ["Passe Deluxe ≥", "deluxeMin"],
        ] as const).map(([label, field]) => (
          <div key={field} className="flex flex-col gap-0.5">
            <span className={labelClass}>{label}</span>
            <input type="text" inputMode="numeric" placeholder="mín" value={filters[field]} onChange={e => updateFilters({ [field]: e.target.value.replace(/[^0-9]/g, "") } as Partial<BazaarHistoryFilters>)} className={inputClass} />
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
          <span className="font-black text-slate-200">{formatInt(stats.count)}</span> de {formatInt(entries.length)} personagens no filtro
        </div>
      </div>

      {/* ── ESTATÍSTICAS ─────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 overflow-y-auto space-y-1.5 pr-0.5">
        {entries.length === 0 ? (
          <div className="rounded-xl border border-[var(--th-line)]/60 bg-[var(--th-n-base)]/80 px-4 py-8 text-center text-xs text-slate-400">
            {isBossUser && isElectron
              ? "Nenhum dado do histórico ainda. Defina as páginas e clique em “Consultar Histórico”."
              : "Nenhum dado do histórico publicado ainda. Aguarde a próxima consulta do Boss."}
          </div>
        ) : (
          <>
            {/* VALOR MÉDIO DO LANCE VENCEDOR — o destaque pedido da tela */}
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
                  {coinRateKk > 0 && stats.withItemsCount > 0 ? `${formatInt(stats.avgItemsRc)} RC` : "—"}
                </div>
                <div className="text-[10px] text-slate-500">
                  {coinRateKk > 0
                    ? `${formatInt(stats.withItemsCount)} personagens com itens da lista · cotação ${formatDec1(coinRateKk)} kk/coin da consulta`
                    : "sem cotação do coin registrada na consulta"}
                  {stats.avgItemsToBidPercent !== null && <> · itens/lance médio: <span className="text-slate-300 font-bold">{formatDec1(stats.avgItemsToBidPercent)}%</span></>}
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

            {/* SKILLS MÉDIAS POR VOCAÇÃO — mesmas regras da guia Itens */}
            {skillsByVocation.length > 0 && (
              <div className="rounded-xl border border-[var(--th-line)]/60 bg-[var(--th-n-base)]/80 px-3 py-2">
                <div className="text-[9px] font-black uppercase tracking-wide text-slate-400 mb-1">Skills médias por vocação</div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-1">
                  {skillsByVocation.map(group => (
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
    </div>
  );
}
