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

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, BarChart3, Coins, Database, Eraser, HelpCircle, RefreshCw, SlidersHorizontal, Square } from "lucide-react";
import { FilterMulti } from "./FilterTypes";
import BazaarBrowserModal, { DEFAULT_BAZAAR_QUEST_SOURCE, normalizeBazaarQuestSource } from "./BazaarBrowserModal";
import type { BazaarQuestSource } from "./BazaarBrowserModal";
import { MIN_DISPLAY_SKILL, SKILL_DISPLAY, skillDefsForVocation } from "./BazaarItemsPanel";
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
  computeStatsFromMetricDocs,
  countActiveHistoryFilters,
  defaultHistoryFilters,
  emptyRange,
  hasActiveHistoryFilters,
  monthLabel,
  rangeActive,
  type BazaarHistoryEntry,
  type BazaarHistoryQueryResponse,
  type HistoryMetricsFilters,
  type HistoryQuestFilter,
  type MetricsDocData,
  type NumberRange,
} from "../utils/bazaarHistoryStats";
import {
  fetchHistoryMetricDocs,
  loadHistorySyncState,
  persistHistoryIngestion,
  recordEmptyHistoryRun,
  type HistoryRunInfo,
  type HistorySyncState,
  type IngestionPhase,
  type IngestionResult,
} from "../services/bazaarHistoryService";

/** Gravação pendente (consulta coletada mas não 100% persistida). */
interface PendingSave {
  entries: BazaarHistoryEntry[];
  run: HistoryRunInfo;
}

/** Progresso da gravação em lotes (fase + lote atual/total). */
interface SaveProgress {
  phase: IngestionPhase;
  done: number;
  total: number;
}

const SAVE_PHASE_LABELS: Record<IngestionPhase, string> = {
  raw: "Gravando base histórica (lotes)",
  metrics: "Atualizando métricas",
  state: "Finalizando estado incremental",
  done: "Gravação concluída",
};

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

// ── Skills filtráveis — derivadas das regras ÚNICAS da guia Itens ──────────
// SKILL_DISPLAY é a fonte de verdade de "qual skill pertence a qual
// vocação"; aqui só se agrega a lista de skills distintas + as vocações em
// que cada uma se aplica (exibido como dica no filtro). A exigência é
// aplicada por personagem em tupleMatchesFilters (via skillDefsForVocation).
const VOCATION_HINT_LABELS: Record<string, string> = {
  knight: "Knight", paladin: "Paladin", druid: "Druid", sorcerer: "Sorcerer", monk: "Monk",
};
const SKILL_FILTER_DEFS: { key: string; abbr: string; full: string; vocations: string[] }[] = (() => {
  const map = new Map<string, { key: string; abbr: string; full: string; vocations: string[] }>();
  for (const [vocationHint, defs] of Object.entries(SKILL_DISPLAY)) {
    for (const def of defs) {
      const existing = map.get(def.key) || { key: def.key, abbr: def.abbr, full: def.full, vocations: [] };
      const label = VOCATION_HINT_LABELS[vocationHint] || vocationHint;
      if (!existing.vocations.includes(label)) existing.vocations.push(label);
      map.set(def.key, existing);
    }
  }
  return Array.from(map.values());
})();

/**
 * Rótulo padrão de um campo do quadro de filtros: nome + ícone de ajuda com
 * TOOLTIP nativo (padrão `title` já usado no app — funciona em desktop e,
 * no mobile, via toque longo). O tooltip também cobre o campo inteiro.
 */
function FieldLabel({ text, hint, active, disabled }: { text: string; hint: string; active?: boolean; disabled?: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wide cursor-help ${disabled ? "text-slate-600" : active ? "text-sky-300" : "text-slate-400"}`}
      title={hint}
    >
      {text}
      <HelpCircle size={9} className={disabled ? "text-slate-700" : "text-slate-500"} />
    </span>
  );
}

/** Campo de FAIXA mín/máx (inteiros ≥ 0; vazio = sem limite no lado). */
function RangeField({ label, range, onChange, hint, disabled }: {
  label: string;
  range: NumberRange;
  onChange: (next: NumberRange) => void;
  hint: string;
  /** Campo dependente desabilitado (ex.: Valor RC sem o desconto ativo). */
  disabled?: boolean;
}) {
  const parse = (text: string): number | null => {
    if (text.trim() === "") return null;
    const value = Math.floor(Number(text));
    return Number.isFinite(value) ? Math.max(0, value) : null;
  };
  const active = !disabled && rangeActive(range);
  const inputClass = (filled: boolean) =>
    `h-7 w-16 rounded-md border bg-black/30 px-1.5 text-[10px] outline-none focus:border-sky-400/60 transition-colors `
    + (disabled
      ? "border-[var(--th-line)]/30 text-slate-600 cursor-not-allowed opacity-60"
      : filled ? "border-sky-400/50 text-sky-200 font-bold" : "border-[var(--th-line)]/60 text-slate-200");
  return (
    <div className="flex flex-col gap-0.5" title={hint}>
      <FieldLabel text={label} hint={hint} active={active} disabled={disabled} />
      <div className="flex items-center gap-1">
        <input
          type="number" inputMode="numeric" min={0} placeholder="mín."
          value={range.min ?? ""}
          disabled={disabled}
          onChange={e => onChange({ ...range, min: parse(e.target.value) })}
          className={inputClass(range.min !== null)}
        />
        <span className={`text-[9px] ${disabled ? "text-slate-700" : "text-slate-600"}`}>–</span>
        <input
          type="number" inputMode="numeric" min={0} placeholder="máx."
          value={range.max ?? ""}
          disabled={disabled}
          onChange={e => onChange({ ...range, max: parse(e.target.value) })}
          className={inputClass(range.max !== null)}
        />
      </div>
    </div>
  );
}

/** Agrupador visual de uma CATEGORIA do quadro de filtros. */
function FilterCategory({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-[var(--th-line)]/50 bg-black/20 px-2.5 py-2">
      <div className="text-[8px] font-black uppercase tracking-widest text-sky-400/70 mb-1.5 border-b border-[var(--th-line)]/30 pb-1">{title}</div>
      <div className="flex flex-wrap items-end gap-x-3 gap-y-1.5">{children}</div>
    </div>
  );
}

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
  // ── Gravação retomável: entradas coletadas ficam retidas até persistir ───
  // 100%. Se QUALQUER fase da gravação falhar, "Tentar gravar novamente"
  // reaproveita as MESMAS entradas — sem repetir a consulta no site e sem
  // duplicar nada (base bruta regrava por id; métricas pulam ids já
  // contabilizados).
  const [pendingSave, setPendingSave] = useState<PendingSave | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveProgress, setSaveProgress] = useState<SaveProgress | null>(null);

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
      for (const tuple of Object.values(docData.auctions || {})) set.add(tuple.v || "—");
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [metricDocs]);

  // Docs de métricas no formato ANTERIOR (células, sem tuplas): ficam fora
  // das estatísticas e geram o aviso de conversão (recarga completa).
  const legacyDocs = useMemo(() => metricDocs.filter(docData => docData.legacy), [metricDocs]);
  const legacyCount = useMemo(() => legacyDocs.reduce((sum, docData) => sum + (docData.legacyCount || 0), 0), [legacyDocs]);

  // TODAS as estatísticas saem das tuplas filtradas; as regras de skill por
  // vocação são as da guia Itens (skillDefsForVocation), injetadas aqui.
  const stats = useMemo(() => computeStatsFromMetricDocs(metricDocs, filters, skillDefsForVocation), [metricDocs, filters]);
  const activeFilterCount = countActiveHistoryFilters(filters);

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

  /** Atualiza a faixa mín/máx de uma SKILL (chave da guia Itens). */
  function updateSkillRange(skillKey: string, next: NumberRange) {
    setFilters(prev => {
      const skills = { ...prev.skills };
      if (next.min === null && next.max === null) delete skills[skillKey];
      else skills[skillKey] = next;
      return { ...prev, skills };
    });
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
    if (isRunning || isSaving) return;
    if (pendingSave) {
      setError("Há uma gravação pendente da última consulta. Use \"Tentar gravar novamente\" para concluí-la antes de consultar de novo (nada será duplicado).");
      return;
    }
    setError(null);
    setNotice(null);
    setIsBrowserModalOpen(true);
  }

  /** 2º passo (onConfirm do modal): executa a consulta de fato. */
  async function executeHistoryQuery(options: { browserKey: string; cleanProfile: boolean; questSource?: BazaarQuestSource }) {
    if (!isBossUser || !isElectron || isRunning || isSaving || isOtherQueryRunning) return;
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
        // "30 dias completos" é também o MECANISMO DE REPARO da base: sem
        // knownIds, TODOS os leilões da janela são reanalisados e as tuplas
        // regravadas por id (corrige dados históricos — ex.: Passe Deluxe —
        // sem duplicar nada; a contagem vem do mapa por id).
        knownIds: fullReload ? [] : Object.keys(prevState?.recent || {}),
        fullReload,
        // Identificação das quests (Bosstiary × Quests) escolhida no modal —
        // decide só COMO SW/SG são derivadas do JSON de cada leilão. A coleta
        // continua EXCLUSIVAMENTE via JSON (nenhuma página de personagem é
        // renderizada); quest inconclusiva fica "sem dado" nas métricas.
        questSource: normalizeBazaarQuestSource(options.questSource ?? DEFAULT_BAZAAR_QUEST_SOURCE),
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
            // GB ("The Roost of the Graveborn") — derivada pelo canal do
            // histórico com as MESMAS funções das demais consultas, do MESMO
            // payload JSON. Consulta antiga/inconclusiva = null ("sem dado").
            crypt: raw.cryptCompleted ?? null,
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

      // ── Ingestão idempotente e RETOMÁVEL (lotes seguros) ─────────────────
      // As entradas ficam retidas em `pendingSave` ATÉ a persistência
      // completa: se algo falhar, nada precisa ser consultado de novo.
      const pending: PendingSave = { entries, run };
      setPendingSave(pending);
      await persistCollectedEntries(pending, prevState, {
        knownSkippedCount: response.knownSkippedCount || 0,
        failedCount: response.failedCount || 0,
        stoppedManually: response.stoppedManually === true,
      });
    } catch (err: any) {
      setError(String(err?.message || err));
    } finally {
      setIsRunning(false);
      setProgress(null);
    }
  }

  /**
   * Persistência compartilhada entre a consulta e o "Tentar gravar
   * novamente". Só limpa `pendingSave` (e só anuncia sucesso) quando as
   * TRÊS fases — base bruta em lotes, métricas e estado — terminarem.
   */
  async function persistCollectedEntries(
    pending: PendingSave,
    freshState: HistorySyncState | null,
    runNotes: { knownSkippedCount: number; failedCount: number; stoppedManually: boolean },
  ): Promise<void> {
    setIsSaving(true);
    setSaveProgress(null);
    try {
      const result: IngestionResult = pending.entries.length > 0
        ? await persistHistoryIngestion(pending.entries, pending.run, freshState,
            (phase, done, total) => setSaveProgress({ phase, done, total }))
        : await recordEmptyHistoryRun(pending.run, freshState);

      if (!result.ok) {
        // Diagnóstico preciso por fase + retomada SEM nova consulta ao site.
        const saved: string[] = [];
        if (result.rawDocsWritten > 0) saved.push(`${formatInt(result.rawDocsWritten)} leilões já gravados na base histórica (${result.rawBatchesDone}/${result.rawBatchesTotal} lotes)`);
        if (result.rawFailedCount > 0) saved.push(`${formatInt(result.rawFailedCount)} ainda não gravados`);
        if (result.addedToMetrics > 0) saved.push(`${formatInt(result.addedToMetrics)} já contabilizados nas métricas`);
        if (result.failedMetricDocIds.length > 0) saved.push(`${result.failedMetricDocIds.length} documento(s) de métricas pendentes`);
        setError(
          `A gravação parou na fase "${SAVE_PHASE_LABELS[result.phase]}": ${result.error || "erro desconhecido"}.`
          + (saved.length ? ` Progresso preservado: ${saved.join(" · ")}.` : "")
          + ` Nada se perdeu e NADA será duplicado — use "Tentar gravar novamente" para concluir a partir deste ponto (a consulta ao site NÃO precisa ser repetida).`,
        );
        return;
      }

      // Sucesso completo: libera as entradas retidas e atualiza a tela.
      setPendingSave(null);
      setSyncState(result.state);
      // Docs de métricas recém-escritos já estão no cache local: recarregar
      // aqui custa ZERO leituras extras.
      if (result.state) {
        const { docs } = await fetchHistoryMetricDocs(Object.keys(result.state.months || {}), result.state);
        setMetricDocs(docs);
      }

      const pieces = [
        `${formatInt(result.addedToMetrics)} leilão(ões) novo(s) contabilizados na base histórica e nas métricas`,
        result.alreadyInMetrics > 0 ? `${formatInt(result.alreadyInMetrics)} já contabilizados antes — dados atualizados sem duplicar` : "",
        runNotes.knownSkippedCount ? `${formatInt(runNotes.knownSkippedCount)} já conhecidos ignorados` : "",
        runNotes.failedCount ? `${formatInt(runNotes.failedCount)} detalhes sem resposta (dados da listagem preservados)` : "",
        runNotes.stoppedManually ? "consulta encerrada manualmente — a próxima retoma da fronteira" : "",
      ].filter(Boolean);
      setNotice(pieces.join(" · ") + ".");
      setFullReload(false);
    } finally {
      setIsSaving(false);
      setSaveProgress(null);
    }
  }

  /**
   * Retomada da gravação pendente: reaproveita as entradas coletadas na
   * última consulta (nenhum acesso ao site). Idempotente de ponta a ponta —
   * pode ser acionada quantas vezes for preciso.
   */
  async function retryPendingSave() {
    if (!pendingSave || isSaving || isRunning) return;
    setError(null);
    setNotice(null);
    // Fronteira FRESCA do Firestore: a retomada pode acontecer bem depois.
    const { state: freshState } = await loadHistorySyncState({ force: true });
    await persistCollectedEntries(pendingSave, freshState, {
      knownSkippedCount: pendingSave.run.knownSkippedCount,
      failedCount: pendingSave.run.failedCount,
      stoppedManually: pendingSave.run.stoppedManually,
    });
  }

  /** Encerramento antecipado — mesmo canal de parada das demais consultas. */
  async function requestStop() {
    try {
      const { ipcRenderer } = (window as any).require("electron");
      await ipcRenderer.invoke("rubinot-bazaar-request-stop");
    } catch { /* Electron indisponível */ }
  }

  const lastRun = syncState?.lastRun;
  const totalCount = syncState?.totalCount || 0;

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-1.5 overflow-hidden">
      {error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300 flex items-start gap-2">
          <AlertTriangle size={15} className="flex-shrink-0 mt-0.5" />
          <span className="min-w-0 flex-1">{error}</span>
          {/* Retomada da gravação pendente — NÃO repete a consulta ao site. */}
          {pendingSave && !isRunning && !isSaving && (
            <button
              type="button"
              onClick={() => void retryPendingSave()}
              className="flex-shrink-0 inline-flex h-7 items-center gap-1 px-2.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-emerald-200 text-[10px] font-black transition-all cursor-pointer hover:bg-emerald-500/20 hover:border-emerald-400/60"
              title="Conclui a gravação a partir do ponto em que parou, com as entradas já coletadas — sem nova consulta ao site e sem duplicar nada."
            >
              <RefreshCw size={11} /> Tentar gravar novamente
            </button>
          )}
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
              title="Ignora a fronteira incremental e REANALISA os 30 dias completos do site, incluindo leilões já conhecidos: as tuplas são regravadas por id (nada duplica) e dados corrigidos — como o Passe Deluxe — são atualizados na base histórica e nas métricas. Também converte documentos de métricas do formato antigo."
            >
              <input
                type="checkbox"
                checked={fullReload}
                onChange={e => setFullReload(e.target.checked)}
                disabled={isRunning || isSaving}
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
                disabled={!!isOtherQueryRunning || isSaving}
                title={isOtherQueryRunning
                  ? "Outra consulta do Bazaar em andamento — aguarde a finalização."
                  : isSaving
                    ? "Gravação em andamento — aguarde a conclusão."
                    : "Abre a configuração da consulta (navegador) e coleta os leilões finalizados do histórico oficial"}
                className="inline-flex h-7 items-center gap-1 px-2.5 rounded-lg bg-gradient-to-r from-sky-700/80 to-sky-600/80 hover:from-sky-600 hover:to-sky-500 border border-sky-500/40 text-black text-[10px] font-black transition-all cursor-pointer shadow-md shadow-sky-900/15 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <RefreshCw size={12} /> Consultar Histórico
              </button>
            )}
          </div>
        )}

        {/* Progresso ao vivo — consulta E/OU gravação (a retomada da
            gravação acontece sem consulta, por isso o `|| isSaving`) */}
        {(isRunning || isSaving) && (
          <div className="w-full space-y-0.5">
            {isRunning && (
            <div className="flex items-center gap-2 text-[10px] text-sky-200">
              <RefreshCw size={11} className="animate-spin" />
              <span className="truncate">{progress?.message || "Consultando histórico..."}</span>
              {(progress?.total || 0) > 0 && (
                <span className="font-mono flex-shrink-0">{progress?.processed}/{progress?.total}</span>
              )}
            </div>
            )}
            {/* Progresso da GRAVAÇÃO em lotes (fase de persistência) */}
            {isSaving && saveProgress && (
              <div className="flex items-center gap-2 text-[10px] text-emerald-200">
                <Database size={11} className="flex-shrink-0" />
                <span className="truncate">{SAVE_PHASE_LABELS[saveProgress.phase]}</span>
                {saveProgress.total > 0 && (
                  <span className="font-mono flex-shrink-0">{saveProgress.done}/{saveProgress.total}</span>
                )}
              </div>
            )}
            {(progress?.total || 0) > 0 && (
              <div className="h-1 rounded bg-black/40 overflow-hidden">
                <div className="h-full bg-gradient-to-r from-sky-600 to-sky-400 transition-all" style={{ width: `${progress?.percent || 0}%` }} />
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── MÉTRICAS NO FORMATO ANTERIOR — aviso de conversão ─────────────── */}
      {legacyDocs.length > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200 flex items-start gap-2">
          <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
          <span className="min-w-0 flex-1">
            {legacyDocs.length} documento(s) de métricas ({formatInt(legacyCount)} leilão(ões)) estão no formato anterior e
            {" "}<span className="font-black">não entram nas estatísticas abaixo</span> — os filtros por faixa não se aplicam a eles.
            {isBossUser && isElectron
              ? " Rode uma consulta com “30 dias completos” marcado para convertê-los (nada será duplicado)."
              : " Aguarde o Boss rodar uma consulta com “30 dias completos” para convertê-los."}
          </span>
        </div>
      )}

      {/* ── FILTROS + ESTATÍSTICAS — UMA ÚNICA ESTRUTURA ROLÁVEL ───────────
          Os dois quadros (filtros da análise e resultados) vivem DENTRO do
          mesmo contêiner de rolagem e se movem JUNTOS, como uma única
          unidade — em desktop e mobile. Nada do conteúdo/funcionamento de
          cada quadro mudou: apenas a organização visual (antes o quadro de
          filtros tinha rolagem própria, separada dos resultados). */}
      <div className="flex-1 min-h-0 overflow-y-auto space-y-1.5 pr-0.5">

      {/* ── FILTROS DA ANÁLISE (quadro dedicado — 100% local, zero leituras) ─
          Todas as condições valem EM CONJUNTO sobre as tuplas em memória:
          mudar filtro NUNCA consulta o site nem relê documentos. ─────────── */}
      <div className="rounded-xl border border-sky-500/25 bg-[var(--th-n-base)]/90 backdrop-blur-md px-3 py-2 space-y-2 shadow-[0_0_14px_color-mix(in_oklab,var(--color-sky-500)_6%,transparent)]">
        {/* Cabeçalho do quadro: título + selo de filtros ativos + limpar */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <div className="flex items-center gap-2 text-slate-100">
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-sky-400/40 bg-sky-500/15">
              <SlidersHorizontal size={12} className="text-sky-300" />
            </span>
            <span className="text-[11px] font-black uppercase tracking-wide">Filtros da Análise</span>
          </div>
          {activeFilterCount > 0 ? (
            <span
              className="inline-flex items-center gap-1 px-1.5 h-5 rounded-md border border-sky-400/40 bg-sky-500/15 text-sky-200 text-[9px] font-black cursor-help"
              title="Quantidade de filtros/opções em efeito agora. Todos os indicadores e gráficos abaixo consideram apenas o conjunto filtrado."
            >
              {activeFilterCount} filtro(s) ativo(s)
            </span>
          ) : (
            <span className="text-[9px] text-slate-500 font-bold">nenhum filtro ativo — estatísticas da base completa</span>
          )}
          {hasActiveHistoryFilters(filters) && (
            <button
              type="button"
              onClick={() => setFilters(defaultHistoryFilters())}
              title="Remove todos os filtros (incluindo o desconto de itens) e restaura o padrão: estatísticas da base completa com o Lance Vencedor original."
              className="inline-flex h-6 items-center gap-1 px-2 rounded-md border border-rose-500/25 bg-rose-500/10 text-rose-300 text-[9px] font-black transition-all cursor-pointer hover:bg-rose-500/20 hover:border-rose-400/40"
            >
              <Eraser size={10} /> Limpar Filtros
            </button>
          )}
          <div
            className="ml-auto text-[10px] text-slate-400 cursor-help"
            title="Quantos leilões da base histórica atendem a TODOS os filtros ativos, sobre o total de leilões disponíveis."
          >
            <span className="font-black text-sky-200">{formatInt(stats.count)}</span> de {formatInt(totalCount)} leilões no filtro
          </div>
        </div>

        {/* Categorias de filtros */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-1.5">
          <FilterCategory title="Período e Origem">
            <div className="flex flex-col gap-0.5" title="Meses (pela data de término do leilão) incluídos na análise. Seleção múltipla; nenhum selecionado = todos os meses da base.">
              <FieldLabel text="Meses" hint="Meses (pela data de término do leilão) incluídos na análise. Seleção múltipla; nenhum selecionado = todos os meses da base." active={filters.months.length > 0} />
              <FilterMulti label="Meses" options={monthOptions} selected={filters.months} onApply={values => updateFilters({ months: values })} placeholder="Meses" searchable />
            </div>
            <div className="flex flex-col gap-0.5" title="Servidores dos personagens vendidos. Seleção múltipla; nenhum selecionado = todos os servidores.">
              <FieldLabel text="Servidor" hint="Servidores dos personagens vendidos. Seleção múltipla; nenhum selecionado = todos os servidores." active={filters.servers.length > 0} />
              <FilterMulti label="Servidor" options={serverOptions} selected={filters.servers} onApply={values => updateFilters({ servers: values })} placeholder="Servidor" searchable />
            </div>
          </FilterCategory>

          <FilterCategory title="Personagem">
            <div className="flex flex-col gap-0.5" title="Vocações consideradas. Seleção múltipla; nenhuma selecionada = todas. Também delimita os filtros de skill (cada skill só se aplica às vocações da guia Itens).">
              <FieldLabel text="Vocação" hint="Vocações consideradas. Seleção múltipla; nenhuma selecionada = todas. Também delimita os filtros de skill (cada skill só se aplica às vocações da guia Itens)." active={filters.vocations.length > 0} />
              <FilterMulti label="Vocação" options={vocationOptions} selected={filters.vocations} onApply={values => updateFilters({ vocations: values })} placeholder="Vocação" searchable />
            </div>
            <RangeField label="Level" range={filters.level} onChange={range => updateFilters({ level: range })} hint="Intervalo de level do personagem (mín/máx livres — ex.: 400 a 800). Vazio em um lado = sem limite naquele lado." />
          </FilterCategory>

          <FilterCategory title="Valores (RC)">
            {/* DESCONTAR VALOR DOS ITENS — muda a MEDIDA de preço de toda a
                análise e habilita o campo dependente "Valor RC". */}
            <label
              className={`inline-flex h-7 items-center gap-1.5 px-2 rounded-md border text-[9px] font-black uppercase tracking-wide cursor-pointer select-none transition-colors ${filters.discountItems ? "border-amber-400/60 bg-amber-500/15 text-amber-200" : "border-[var(--th-line)]/60 bg-black/25 text-slate-300 hover:border-amber-400/40"}`}
              title="Quando ativado, subtrai do Lance Vencedor o valor estimado dos itens do personagem, convertido para RC (mesma conversão kk→RC da guia Itens, registrada na ingestão). As estatísticas de preço (média, mínimo, máximo, evolução mensal e distribuição) passam a representar o valor estimado do personagem SEM os itens. Sem itens avaliados, nada é descontado; itens valendo mais que o lance contam como valor 0 (nunca negativo). O Lance Vencedor original do histórico não é alterado."
            >
              <input
                type="checkbox"
                checked={filters.discountItems}
                onChange={e => updateFilters({ discountItems: e.target.checked })}
                className="accent-amber-500"
              />
              <Coins size={11} className={filters.discountItems ? "text-amber-300" : "text-slate-500"} />
              Descontar valor dos itens
            </label>
            <RangeField label="Lance Vencedor" range={filters.bid} onChange={range => updateFilters({ bid: range })} hint="Faixa do Lance Vencedor ORIGINAL em Rubini Coins (mín/máx), sem nenhum desconto — independe da opção “Descontar valor dos itens”." />
            <RangeField
              label="Valor RC"
              range={filters.value}
              onChange={range => updateFilters({ value: range })}
              disabled={!filters.discountItems}
              hint={filters.discountItems
                ? "Define a faixa de preço dos personagens considerados na análise, usando o VALOR ESTIMADO após subtrair os itens (Lance Vencedor − itens em RC, mínimo 0). Ex.: mín. 500 e máx. 2000."
                : "Faixa do valor estimado do personagem SEM os itens. Disponível apenas com “Descontar valor dos itens” ativado."}
            />
            <RangeField label="Valor dos Itens" range={filters.items} onChange={range => updateFilters({ items: range })} hint="Faixa do valor dos itens monitorados do personagem, em RC pela cotação registrada na ingestão (0 = sem itens avaliados). Útil junto com o desconto para isolar personagens com muitos ou poucos itens." />
          </FilterCategory>

          <FilterCategory title="Quests">
            {/* GB ("Graveborn") usa a MESMA semântica de SW/SG; tuplas
                gravadas antes da GB existir não têm o dado e ficam fora
                quando uma opção específica é escolhida. */}
            {([["Soul War", "soulwar"], ["Sanguine", "sanguine"], ["Graveborn", "crypt"]] as const).map(([label, field]) => {
              const hint = `${label}: “Tanto Faz” ignora a quest; “Disponível” só personagens com a quest AINDA DISPONÍVEL para fazer; “Feita” só personagens que já a concluíram. Personagens sem o dado ficam fora quando uma opção específica é escolhida.`;
              return (
                <div key={field} className="flex flex-col gap-0.5" title={hint}>
                  <FieldLabel text={label} hint={hint} active={filters[field] !== "any"} />
                  <select
                    value={filters[field]}
                    onChange={e => updateFilters({ [field]: e.target.value as HistoryQuestFilter } as Partial<HistoryMetricsFilters>)}
                    className="h-7 rounded-md border border-[var(--th-line)]/60 bg-black/30 px-1.5 text-[10px] text-slate-200 outline-none focus:border-sky-400/60 cursor-pointer"
                  >
                    {QUEST_FILTER_LABELS.map(option => (
                      <option key={option.value} value={option.value} className="bg-slate-900">{option.label}</option>
                    ))}
                  </select>
                </div>
              );
            })}
          </FilterCategory>

          <FilterCategory title="Progresso da Conta">
            <RangeField label="Charm Points" range={filters.charm} onChange={range => updateFilters({ charm: range })} hint="Faixa do Total Charm Points armazenado (ex.: mín. 800 e máx. 1500, limites inclusivos). Personagens sem o dado coletado ficam fora quando a faixa está ativa." />
            <RangeField label="Auras" range={filters.auras} onChange={range => updateFilters({ auras: range })} hint="Faixa da quantidade de auras do personagem (mín/máx). Sem o dado coletado, o personagem fica fora quando a faixa está ativa." />
            <RangeField label="Hirelings" range={filters.hirelings} onChange={range => updateFilters({ hirelings: range })} hint="Faixa da quantidade de hirelings do personagem (mín/máx). Sem o dado coletado, o personagem fica fora quando a faixa está ativa." />
            <RangeField label="Passes Deluxe" range={filters.deluxe} onChange={range => updateFilters({ deluxe: range })} hint="Faixa de temporadas do Battlepass com Deluxe = “sim” (0 = nenhuma, 1, 2…). Use mín=máx para valor exato — ex.: 0–0 só personagens sem nenhum passe. Sem o dado, o personagem fica fora quando a faixa está ativa." />
          </FilterCategory>

          <FilterCategory title="Skills (regras por vocação da guia Itens)">
            {SKILL_FILTER_DEFS.map(def => (
              <RangeField
                key={def.key}
                label={def.abbr}
                range={filters.skills[def.key] || emptyRange()}
                onChange={range => updateSkillRange(def.key, range)}
                hint={`Faixa de ${def.full} (mín/máx). Aplicável a: ${def.vocations.join(", ")} — com a faixa ativa, só entram personagens dessas vocações E com a skill coletada (sem valores fictícios).`}
              />
            ))}
          </FilterCategory>
        </div>

        <div className="text-[9px] text-slate-500 border-t border-[var(--th-line)]/30 pt-1.5">
          Todos os indicadores e gráficos abaixo consideram <span className="font-black text-slate-400">exclusivamente</span> o conjunto filtrado; as médias com “com dado” usam só os personagens que possuem aquela informação. Filtros de skill seguem as regras por vocação da guia Itens.
          {filters.discountItems && (
            <span className="text-amber-300/90 font-bold"> Preços no modo “valor estimado sem itens”: Lance Vencedor − itens (RC); o lance original do histórico permanece intacto.</span>
          )}
        </div>
      </div>

      {/* ── ESTATÍSTICAS (somente métricas agregadas) — rolam JUNTO com o
          quadro de filtros acima (contêiner único). ─────────────────────── */}
      <div className="space-y-1.5">
        {metricDocs.length === 0 ? (
          <div className="rounded-xl border border-[var(--th-line)]/60 bg-[var(--th-n-base)]/80 px-4 py-8 text-center text-xs text-slate-400">
            {isBossUser && isElectron
              ? "Base histórica vazia. Clique em “Consultar Histórico” para a primeira carga dos 30 dias disponíveis no site."
              : "Base histórica vazia. Aguarde a primeira consulta do Boss."}
          </div>
        ) : (
          <>
            {/* AVISO DE MODO AJUSTADO — preços = valor estimado SEM itens */}
            {stats.priceAdjusted && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[10px] text-amber-200 flex items-center gap-2 flex-wrap">
                <Coins size={13} className="text-amber-300 flex-shrink-0" />
                <span className="min-w-0">
                  <span className="font-black">Valores ajustados:</span> as estatísticas de preço mostram o valor estimado do personagem <span className="font-black">sem os itens</span> (Lance Vencedor − itens em RC) — não confundir com o Lance Vencedor original, que permanece intacto no histórico.
                  {stats.negativeAdjustedCount > 0 && (
                    <> {formatInt(stats.negativeAdjustedCount)} personagem(ns) com itens valendo mais que o lance entram com valor 0 (nunca negativo).</>
                  )}
                </span>
              </div>
            )}

            {/* VALOR MÉDIO (lance vencedor OU valor estimado sem itens) */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-1.5">
              <div className={`rounded-xl border px-3 py-2.5 ${stats.priceAdjusted ? "border-amber-500/40 bg-gradient-to-br from-amber-500/15 to-amber-900/20 shadow-[0_0_18px_color-mix(in_oklab,var(--color-amber-500)_12%,transparent)]" : "border-sky-500/40 bg-gradient-to-br from-sky-500/15 to-sky-900/20 shadow-[0_0_18px_color-mix(in_oklab,var(--color-sky-500)_12%,transparent)]"}`}>
                <div className={`text-[9px] font-black uppercase tracking-wide ${stats.priceAdjusted ? "text-amber-300" : "text-sky-300"}`}>
                  {stats.priceAdjusted ? "Valor médio estimado (sem itens)" : "Valor médio do lance vencedor"}
                </div>
                <div className={`text-2xl font-black ${stats.priceAdjusted ? "text-amber-100" : "text-sky-100"}`}>{stats.count > 0 ? `${formatInt(stats.avgWinningBidRc)} RC` : "—"}</div>
                <div className={`text-[10px] ${stats.priceAdjusted ? "text-amber-300/80" : "text-sky-300/80"}`}>
                  {formatInt(stats.count)} personagens vendidos no filtro{stats.priceAdjusted ? " · lance − itens (RC)" : ""}
                </div>
              </div>
              <div className="rounded-xl border border-[var(--th-line)]/60 bg-[var(--th-n-base)]/80 px-3 py-2.5">
                <div className="text-[9px] font-black uppercase tracking-wide text-slate-400">
                  {stats.priceAdjusted ? "Valor estimado mínimo / máximo" : "Lance mínimo / máximo"}
                </div>
                <div className="text-lg font-black text-slate-100">
                  {stats.count > 0 ? <>{formatInt(stats.minWinningBidRc)} <span className="text-slate-500 text-sm">/</span> {formatInt(stats.maxWinningBidRc)} RC</> : "—"}
                </div>
                <div className="text-[10px] text-slate-500">
                  {stats.priceAdjusted ? "entre os valores estimados sem itens do filtro" : "entre os lances vencedores do filtro"}
                </div>
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
                ["Passes Deluxe médios", stats.deluxeSampleCount > 0 ? formatDec1(stats.avgDeluxePasses) : "—", `${formatInt(stats.deluxeSampleCount)} com dado · ${formatInt(stats.totalDeluxePasses)} passes no total`],
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
                <div className="text-[9px] font-black uppercase tracking-wide text-slate-400 mb-1">
                  Evolução mensal (vendidos · {stats.priceAdjusted ? "valor médio estimado sem itens" : "lance médio"})
                </div>
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
                <div className="text-[9px] font-black uppercase tracking-wide text-slate-400 mb-1">Soul War / Sanguine / Graveborn</div>
                {([["Soul War", stats.soulwar], ["Sanguine", stats.sanguine], ["Graveborn", stats.crypt]] as const).map(([label, dist]) => (
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

            {/* DISTRIBUIÇÕES DE LANCE, CHARM E DELUXE (histogramas das tuplas) */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-1.5">
              {([[stats.priceAdjusted ? "Distribuição do valor estimado (sem itens)" : "Distribuição do lance vencedor", stats.bidDistribution], ["Distribuição de Charm Points", stats.charmDistribution], ["Distribuição de Passes Deluxe", stats.deluxeDistribution]] as const).map(([title, dist]) => (
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

      {/* Fecha o contêiner único de rolagem (filtros + estatísticas). */}
      </div>

      {/* ── Configuração da consulta — MESMO modal das demais consultas do
          Bazaar (navegador/perfil/velocidade); método travado em API JSON.
          O navegador SÓ abre depois do "Iniciar consulta" daqui. ──────────── */}
      <BazaarBrowserModal
        open={isBrowserModalOpen}
        forcedMethod="novo"
        onCancel={() => setIsBrowserModalOpen(false)}
        onConfirm={(browserKey, _browserOrder, cleanProfile, _retryBrowsers, _speedMode, _retryCounts, _method, questSource) => {
          setIsBrowserModalOpen(false);
          // `questSource`: identificação das quests (Bosstiary × Quests)
          // escolhida no modal — respeitada na consulta inteira do histórico.
          void executeHistoryQuery({ browserKey, cleanProfile, questSource });
        }}
      />
    </div>
  );
}
