import { useMemo, useState, useEffect } from "react";
import {
  TrendingUp,
  TrendingDown,
  Users,
  CheckCircle2,
  Package,
  Activity,
  Award,
  Layers,
  Eye,
  EyeOff,
  Trophy,
  UserPlus,
  RotateCcw,
  Server as ServerIcon,
  Target,
  BarChart3,
  Briefcase,
  SlidersHorizontal,
  ChevronDown,
  ChevronUp,
  HelpCircle,
} from "lucide-react";
import type { Character, CharacterAcquisition, CharacterAcquisitionBuyerDetails, NegotiationTimestamp, PartyTab, PersonalPartyHistory, PtType, SharedService } from "../types";
import { serverLabel } from "../constants/servers";
import { formatRC, VOCATIONS } from "../types";
import { FilterMulti } from "./FilterTypes";
import { sumServiceProfit } from "../services/sharedServicesService";
import { toFirestoreMillis } from "../utils/firestoreTimestamp";

// ============================================================================
// STATS — Dashboard de estatísticas do usuário
// ----------------------------------------------------------------------------
// Reconstrução visual da guia Stats (a antiga não serviu de base). Reaproveita
// apenas a ORIGEM dos dados (characters + parties + userStats persistido) e os
// cálculos financeiros já existentes, com uma nova organização:
//
//   1) Filtros compactos sempre visíveis no topo (Período · Status · Cálculo,
//      além de "Apenas personagens completos") — todos funcionam combinados.
//      As estatísticas consideram sempre qualquer quest (Soulwar e Sanguine).
//   2) KPIs principais em destaque (Resultado Líquido, ROI, PT's Concluídas,
//      Personagens).
//   3) Estatísticas secundárias (Médias Financeiras e Relatório de PT's).
//   4) Seção "Servidor" (por servidor com PTs concluídas).
//   5) Drops (Soulwar / Sanguine) e Parceiros.
//
// Removidos (por definição do layout): quadros "Desempenho" e "Níveis", mortes,
// taxa de sucesso, duração média e os filtros de Vocação e Servidor.
//
// A filtragem é CENTRALIZADA: `baseFiltered` (personagens) e `partyBase`
// (PTs) derivam dos mesmos filtros (período); o cálculo financeiro usa
// `calcResult(c, valueFilter)` compartilhado pelos KPIs e pela seção Servidor.
// ============================================================================

interface Props {
  characters: Character[];
  parties?: PartyTab[];
  /**
   * Projeção privada users/{uid}/partyHistory — a MESMA fonte de "Meu
   * Histórico de PTs", já assinada via onSnapshot no App (zero leituras
   * extras). Alimenta os contadores exatos de PTs concluídas do Relatório.
   */
  partyHistory?: PersonalPartyHistory[];
  userName?: string;
  // Estatísticas persistentes (userStats/{uid} no Firestore) — migração
  // parcial: apenas as métricas ainda presentes neste documento usam esta
  // fonte; as demais continuam na arquitetura antiga (characters + parties).
  userStats?: UserStatsData | null;
  // Mapa uid -> nome (usuários aprovados) para exibir os parceiros
  // persistidos (que são armazenados por UID, nunca por nome).
  userNames?: Record<string, string>;
  // Services do usuário (painel "Meus Services"). O lucro de Services da Stats
  // vem do campo `lucroService` dos services com status "realizado" — NÃO do
  // valor preenchido na PT.
  services?: SharedService[];
  /** Negociações em que o usuário é dono original ou adquirente financeiro. */
  characterAcquisitions?: CharacterAcquisition[];
  /** Dados privados de Quest, disponíveis apenas quando o usuário é adquirente. */
  characterAcquisitionBuyerDetails?: CharacterAcquisitionBuyerDetails[];
  currentUserUid?: string;
}

interface UserStatsData {
  totalPtsConcluidas?: number;
  totalPtsSoulwar?: number;
  totalPtsSanguine?: number;
  partners?: Record<string, number>;
  // Buckets diários (YYYY-MM-DD → contadores) gravados por commitPartyStats /
  // catch-up sweep. Permitir filtrar PT's concluídas por período sem leituras
  // extras (o doc userStats/{uid} já é assinado via onSnapshot).
  dailyStats?: Record<string, {
    totalPtsConcluidas?: number;
    totalPtsSoulwar?: number;
    totalPtsSanguine?: number;
  }>;
}

const SOULWAR_ITEMS = [
  "Soulbleeder", "Soulkamas", "Soulshredder", "Pair of Soulwalkers", "Soulshell",
  "Pair of Soulstalkers", "Souleater", "Soulmaimer", "Soultainter", "Soulmantle",
  "Soulgarb", "Soulhexer", "Soulcrusher", "Soulshanks", "Soulstrider",
  "Soulsoles", "Soulcutter", "Soulpiercer", "Soulshroud", "Soulbastion", "Soulbiter",
];

const SANGUINE_ITEMS = [
  "Grand Sanguine Bow", "Grand Sanguine Crossbow", "Grand Sanguine Rod",
  "Grand Sanguine Coil", "Grand Sanguine Claws", "Grand Sanguine Blade",
  "Grand Sanguine Battleaxe", "Grand Sanguine Bludgeon", "Grand Sanguine Razor",
  "Grand Sanguine Hatchet", "Grand Sanguine Cudgel",
  "Sanguine Bow", "Sanguine Legs", "Sanguine Greaves", "Sanguine Coil",
  "Sanguine Razor", "Sanguine Claws", "Sanguine Rod", "Sanguine Trousers",
  "Sanguine Boots", "Sanguine Galoshes", "Sanguine Bludgeon", "Sanguine Blade",
  "Sanguine Crossbow", "Sanguine Battleaxe", "Sanguine Hatchet", "Sanguine Cudgel",
];

// CRYPT — mesma lista/ordem (mais → menos valioso) do CharTable (CRYPT_ITEMS).
const CRYPT_ITEMS = [
  "Necromantic Crypt Rune", "Icy Crypt Rune", "Deathly Crypt Rune",
  "Fiery Crypt Rune", "Ancient Crypt Rune",
];

const ITEM_COLORS: Record<string, string> = {
  "Soulbleeder": "#22c55e", "Soulkamas": "#22c55e", "Soulshredder": "#22c55e",
  "Pair of Soulwalkers": "#4ade80", "Soulshell": "#4ade80",
  "Pair of Soulstalkers": "#86efac", "Souleater": "#86efac", "Soulmaimer": "#86efac",
  "Soultainter": "#a3e635", "Soulmantle": "#a3e635", "Soulgarb": "#a3e635",
  "Soulhexer": "#eab308", "Soulcrusher": "#eab308",
  "Soulshanks": "#f97316", "Soulstrider": "#f97316", "Soulsoles": "#f97316",
  "Soulcutter": "#ef4444", "Soulpiercer": "#ef4444",
  "Soulshroud": "#dc2626", "Soulbastion": "#dc2626", "Soulbiter": "#dc2626",
  "Grand Sanguine Bow": "#fbbf24", "Grand Sanguine Crossbow": "#fbbf24",
  "Grand Sanguine Rod": "#fbbf24", "Grand Sanguine Coil": "#fbbf24",
  "Grand Sanguine Claws": "#fbbf24", "Grand Sanguine Blade": "#fbbf24",
  "Grand Sanguine Battleaxe": "#fbbf24", "Grand Sanguine Bludgeon": "#fbbf24",
  "Grand Sanguine Razor": "#fbbf24", "Grand Sanguine Hatchet": "#fbbf24",
  "Grand Sanguine Cudgel": "#fbbf24",
  "Sanguine Bow": "#22c55e", "Sanguine Legs": "#22c55e",
  "Sanguine Greaves": "#4ade80", "Sanguine Coil": "#4ade80",
  "Sanguine Razor": "#86efac", "Sanguine Claws": "#86efac",
  "Sanguine Rod": "#a3e635", "Sanguine Trousers": "#a3e635",
  "Sanguine Boots": "#eab308", "Sanguine Galoshes": "#eab308",
  "Sanguine Bludgeon": "#f97316", "Sanguine Blade": "#f97316",
  "Sanguine Crossbow": "#ef4444", "Sanguine Battleaxe": "#ef4444",
  "Sanguine Hatchet": "#dc2626", "Sanguine Cudgel": "#dc2626",
  // CRYPT — cores relativas (verde = topo, vermelho = base), como no CharTable.
  "Necromantic Crypt Rune": "#22c55e", "Icy Crypt Rune": "#4ade80",
  "Deathly Crypt Rune": "#eab308", "Fiery Crypt Rune": "#f97316",
  "Ancient Crypt Rune": "#ef4444",
};

const SW_PRIORITY = [
  "#22c55e", "#4ade80", "#86efac", "#a3e635", "#eab308",
  "#f97316", "#ef4444", "#dc2626",
];

const SG_PRIORITY = [
  "#fbbf24", "#22c55e", "#4ade80", "#86efac", "#a3e635",
  "#eab308", "#f97316", "#ef4444", "#dc2626",
];

const CRYPT_PRIORITY = [
  "#22c55e", "#4ade80", "#eab308", "#f97316", "#ef4444",
];

const GOLD_BORDER = "border-amber-600/25";
const GOLD_BORDER_HOVER = "hover:border-amber-500/45";

type ValueFilter = {
  valorPago: boolean;
  dropSW: boolean;
  dropBakra: boolean;
  /** Lucro Crypt (dropCrypt) — opcional no estado salvo (legado): a leitura
   *  mescla com o DEFAULT para o filtro antigo continuar incluindo a Crypt. */
  dropCrypt: boolean;
  valorVenda: boolean;
};

type StatusFilter = {
  ativos: boolean;
  historico: boolean;
};

// ── FILTROS AVANÇADOS (quadro dedicado) ─────────────────────────────────────
// Novas dimensões de análise sobre dados JÁ CARREGADOS (personagens, PTs e
// negociações em memória): Vocação/Servidor com seleção múltipla e faixas
// numéricas mín/máx para Level, Custo e Venda. Filtragem 100% LOCAL — nenhuma
// leitura extra de Firestore ao mudar qualquer filtro.

/** Faixa numérica mín/máx — null = sem limite naquele lado. */
type NumRange = { min: number | null; max: number | null };

interface AdvancedFilters {
  /** Servidores (rótulo canônico de serverLabel). Vazio = todos. */
  servers: string[];
  /** Vocações (sigla oficial: EK/ED/MS/RP/MK). Vazio = todas. */
  vocations: string[];
  level: NumRange;
  /** Custo em RC — Valor Pago do personagem / finalPaid da negociação. */
  cost: NumRange;
  /** Venda em RC — apenas vendidos (faixa ativa exclui não vendidos). */
  sale: NumRange;
}

function emptyRange(): NumRange { return { min: null, max: null }; }
function defaultAdvancedFilters(): AdvancedFilters {
  return { servers: [], vocations: [], level: emptyRange(), cost: emptyRange(), sale: emptyRange() };
}

function rangeOn(range: NumRange | undefined): boolean {
  return !!range && (range.min !== null || range.max !== null);
}

function inNumRange(value: number, range: NumRange): boolean {
  if (range.min !== null && value < range.min) return false;
  if (range.max !== null && value > range.max) return false;
  return true;
}

/** Blindagem do estado persistido (localStorage pode ter formato antigo/parcial). */
function normalizeAdvanced(raw: unknown): AdvancedFilters {
  const base = defaultAdvancedFilters();
  if (!raw || typeof raw !== "object") return base;
  const source = raw as Partial<AdvancedFilters>;
  const normRange = (value: unknown): NumRange => {
    if (!value || typeof value !== "object") return emptyRange();
    const range = value as Partial<NumRange>;
    const norm = (side: unknown): number | null => (typeof side === "number" && Number.isFinite(side) ? Math.max(0, Math.floor(side)) : null);
    return { min: norm(range.min), max: norm(range.max) };
  };
  return {
    servers: Array.isArray(source.servers) ? source.servers.filter((v): v is string => typeof v === "string") : [],
    vocations: Array.isArray(source.vocations) ? source.vocations.filter((v): v is string => typeof v === "string") : [],
    level: normRange(source.level),
    cost: normRange(source.cost),
    sale: normRange(source.sale),
  };
}

type PeriodKey = "week" | "month" | "lastmonth" | "3m" | "6m" | "year" | "all" | "custom";

/** Intervalo PERSONALIZADO (dia/mês/ano) — datas locais "YYYY-MM-DD"; vazio = lado aberto. */
type CustomPeriod = { start: string; end: string };

const DEFAULT_CUSTOM_PERIOD: CustomPeriod = { start: "", end: "" };

/** Blindagem do intervalo persistido (localStorage pode ter formato inválido). */
function normalizeCustomPeriod(raw: unknown): CustomPeriod {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_CUSTOM_PERIOD };
  const source = raw as Partial<CustomPeriod>;
  const norm = (value: unknown): string =>
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
  return { start: norm(source.start), end: norm(source.end) };
}

const DEFAULT_VALUE_FILTER: ValueFilter = {
  valorPago: true,
  dropSW: true,
  dropBakra: true,
  dropCrypt: true,
  valorVenda: true,
};

const DEFAULT_STATUS: StatusFilter = {
  ativos: true,
  historico: true,
};

const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: "week", label: "Essa Semana" },
  { key: "month", label: "Esse Mês" },
  { key: "lastmonth", label: "Mês Passado" },
  { key: "3m", label: "Últimos 3 meses" },
  { key: "6m", label: "Últimos 6 meses" },
  { key: "year", label: "Esse Ano" },
  { key: "all", label: "Tudo" },
  { key: "custom", label: "Personalizado" },
];

function usePersistedState<T>(key: string, initial: T) {
  const [val, setVal] = useState<T>(() => {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : initial; } catch { return initial; }
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
  }, [key, val]);
  return [val, setVal] as const;
}

// ── Período (calendário) ────────────────────────────────────────────────────
// Retorna { start, end } em epoch ms, ou null para "Tudo". Inclusivo em ambos.
// "custom" usa o intervalo PERSONALIZADO (dia/mês/ano locais): início às
// 00:00:00.000 e fim às 23:59:59.999 do dia escolhido; um lado vazio fica em
// aberto (início → desde sempre; fim → até agora); os dois vazios = "Tudo";
// datas invertidas são trocadas (nunca um intervalo impossível silencioso).
function getPeriodRange(period: PeriodKey, custom: CustomPeriod = DEFAULT_CUSTOM_PERIOD, now = Date.now()): { start: number; end: number } | null {
  if (period === "custom") {
    const parseDay = (value: string, endOfDay: boolean): number | null => {
      if (!value) return null;
      const t = new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}`).getTime();
      return Number.isNaN(t) ? null : t;
    };
    let start = parseDay(custom.start, false);
    let end = parseDay(custom.end, true);
    if (start === null && end === null) return null; // nada preenchido = Tudo
    if (start !== null && end !== null && start > end) {
      // Intervalo invertido: troca os lados preservando 00:00/23:59 corretos.
      const swappedStart = parseDay(custom.end, false)!;
      const swappedEnd = parseDay(custom.start, true)!;
      start = swappedStart; end = swappedEnd;
    }
    return { start: start ?? 0, end: end ?? now };
  }
  const d = new Date(now);
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  switch (period) {
    case "week": {
      const dow = dayStart.getDay(); // 0=Dom .. 6=Sáb
      const diff = dow === 0 ? 6 : dow - 1; // semana começa na 2ª (Mon)
      const start = new Date(dayStart);
      start.setDate(start.getDate() - diff);
      return { start: start.getTime(), end: now };
    }
    case "month": {
      const start = new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
      return { start: start.getTime(), end: now };
    }
    case "lastmonth": {
      const start = new Date(d.getFullYear(), d.getMonth() - 1, 1, 0, 0, 0, 0);
      const end = new Date(d.getFullYear(), d.getMonth(), 0, 23, 59, 59, 999);
      return { start: start.getTime(), end: end.getTime() };
    }
    case "3m": {
      const start = new Date(dayStart);
      start.setMonth(start.getMonth() - 3);
      return { start: start.getTime(), end: now };
    }
    case "6m": {
      const start = new Date(dayStart);
      start.setMonth(start.getMonth() - 6);
      return { start: start.getTime(), end: now };
    }
    case "year": {
      const start = new Date(d.getFullYear(), 0, 1, 0, 0, 0, 0);
      return { start: start.getTime(), end: now };
    }
    default:
      return null; // all
  }
}

function charDateMs(c: Character): number {
  const dateStr = c.vendido ? c.dataVenda : c.dataCompra;
  if (!dateStr) return 0;
  const t = new Date(`${dateStr}T00:00:00`).getTime();
  return Number.isNaN(t) ? 0 : t;
}

// Resultado financeiro líquido de um personagem segundo o filtro de Cálculo.
function calcResult(c: Character, vf: ValueFilter): number {
  let total = 0;
  if (vf.dropSW) total += c.dropSW || 0;
  if (vf.dropBakra) total += c.dropBakra || 0;
  if (vf.dropCrypt) total += c.dropCrypt || 0;
  if (vf.valorVenda) total += c.valorVenda || 0;
  if (vf.valorPago) total -= c.valorPago || 0;
  return total;
}

function resolvePartyServer(p: PartyTab, characters: Character[]): string {
  if (p.servidor) return serverLabel(p.servidor);
  const ids = new Set(p.selectedIds || []);
  const own = characters.find(c => ids.has(c.id));
  return own ? serverLabel(own.servidor) : "";
}

function avgNonZero(values: number[]) {
  const valid = values.filter((v) => v !== 0);
  if (valid.length === 0) return { avg: 0, count: 0 };
  return {
    avg: Math.round(valid.reduce((s, v) => s + v, 0) / valid.length),
    count: valid.length,
  };
}

function sum(values: number[]): number {
  return values.reduce((s, v) => s + v, 0);
}

function daysBetween(a: Date, b: Date): number {
  return Math.max(1, Math.round((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24)));
}

export default function StatsPanel({ characters, parties = [], partyHistory = [], userName = "", userStats = null, userNames = {}, services = [], characterAcquisitions = [], characterAcquisitionBuyerDetails = [], currentUserUid = "" }: Props) {
  const [totalVisible, setTotalVisible] = usePersistedState("stats_totalVisible", true);
  const [valueFilterStored, setValueFilter] = usePersistedState<ValueFilter>("stats_value_filter", DEFAULT_VALUE_FILTER);
  // BLINDAGEM do estado salvo: filtros gravados ANTES da Crypt não têm
  // `dropCrypt` — o merge com o DEFAULT liga a Crypt neles (mesmo
  // comportamento que o usuário tinha: todos os componentes somando).
  const valueFilter = useMemo<ValueFilter>(() => ({ ...DEFAULT_VALUE_FILTER, ...valueFilterStored }), [valueFilterStored]);
  const [statusFilter, setStatusFilter] = usePersistedState<StatusFilter>("stats_statusFilter", DEFAULT_STATUS);
  const [period, setPeriod] = usePersistedState<PeriodKey>("stats_period_v2", "all");
  // "Apenas personagens completos" — filtra para personagens com Custo preenchido
  // e pelo menos um dos lucros (SW ou SG). Integrado à mesma lógica centralizada
  // de filtragem (baseFiltered). Marcada POR PADRÃO (true) para novos usuários;
  // a escolha do usuário é persistida em localStorage ("stats_only_complete").
  const [onlyComplete, setOnlyComplete] = usePersistedState<boolean>("stats_only_complete", true);
  // Filtros avançados do quadro dedicado (Vocação/Servidor/faixas) — persistidos
  // como os demais; `normalizeAdvanced` blinda contra formatos antigos/parciais.
  const [advRaw, setAdvRaw] = usePersistedState<AdvancedFilters>("stats_adv_filters_v1", defaultAdvancedFilters());
  const adv = useMemo(() => normalizeAdvanced(advRaw), [advRaw]);
  const updateAdvanced = (patch: Partial<AdvancedFilters>) => setAdvRaw((prev) => ({ ...normalizeAdvanced(prev), ...patch }));
  // Quadro de filtros recolhível (preferência local persistida; padrão aberto).
  const [filtersOpen, setFiltersOpen] = usePersistedState<boolean>("stats_filters_open", true);
  // Intervalo PERSONALIZADO (dia/mês/ano) — persistido como os demais filtros.
  const [customPeriodRaw, setCustomPeriodRaw] = usePersistedState<CustomPeriod>("stats_period_custom_v1", DEFAULT_CUSTOM_PERIOD);
  const customPeriod = useMemo(() => normalizeCustomPeriod(customPeriodRaw), [customPeriodRaw]);

  // ── Período resolvido (null = "Tudo") ────────────────────────────────────
  const periodRange = useMemo(() => getPeriodRange(period, customPeriod), [period, customPeriod]);

  // O Character do dono original continua existindo tecnicamente, mas seus
  // drops, venda e participação financeira pertencem à negociação após o
  // aceite. Excluí-lo daqui evita que ele seja contado duas vezes nas Stats.
  const negotiatedOriginalCharacterIds = useMemo(() => new Set(
    characterAcquisitions
      .filter(record => record.originalOwnerUid === currentUserUid)
      .map(record => record.characterId),
  ), [characterAcquisitions, currentUserUid]);

  // ── Personagens filtrados (filtros centralizados) ───────────────────────
  const baseFiltered = useMemo(() => {
    return characters.filter((c) => {
      if (negotiatedOriginalCharacterIds.has(c.id)) return false;
      if (c.vendido && !statusFilter.historico) return false;
      if (!c.vendido && !statusFilter.ativos) return false;
      if (periodRange) {
        const ms = charDateMs(c);
        if (!ms || ms < periodRange.start || ms > periodRange.end) return false;
      }
      if (onlyComplete) {
        // Completo = Custo preenchido E pelo menos um dos lucros (SW, SG ou Crypt).
        const hasCost = (c.valorPago || 0) > 0;
        const hasAnyProfit = (c.dropSW || 0) > 0 || (c.dropBakra || 0) > 0 || (c.dropCrypt || 0) > 0;
        if (!hasCost || !hasAnyProfit) return false;
      }
      // ── Filtros avançados (quadro dedicado) — todos combinados ──────────
      if (adv.servers.length > 0 && !adv.servers.includes(serverLabel(c.servidor))) return false;
      if (adv.vocations.length > 0 && !adv.vocations.includes(c.voc)) return false;
      if (!inNumRange(c.level || 0, adv.level)) return false;
      if (rangeOn(adv.cost) && !inNumRange(c.valorPago || 0, adv.cost)) return false;
      // Faixa de VENDA ativa só compara quem FOI vendido — personagem
      // disponível não tem valor de venda e fica fora do conjunto filtrado.
      if (rangeOn(adv.sale) && (!c.vendido || !inNumRange(c.valorVenda || 0, adv.sale))) return false;
      return true;
    });
  }, [characters, negotiatedOriginalCharacterIds, statusFilter, periodRange, onlyComplete, adv]);

  // ── Financeiro das negociações de personagens adquiridos ────────────────
  // Não cria um Character duplicado para o adquirente. O dono original é
  // excluído integralmente desta agregação; o comprador recebe custo, Quest
  // privada e venda. Assim o mesmo personagem nunca aparece nas duas
  // perspectivas de Stats ao mesmo tempo.
  const acquisitionFinance = useMemo(() => {
    type BuyerEntry = { server: string; net: number; questType?: PtType; questDrops: string[] };
    const inRange = (timestamp?: NegotiationTimestamp) => {
      const millis = toFirestoreMillis(timestamp);
      return !periodRange || (millis > 0 && millis >= periodRange.start && millis <= periodRange.end);
    };
    let acquisitionCost = 0;
    let questProfit = 0;
    let questProfitSW = 0;
    let questProfitSG = 0;
    let questProfitCrypt = 0;
    let saleRevenue = 0;
    let visibleCount = 0;
    let buyerActiveCount = 0;
    let buyerSoldCount = 0;
    const acquisitionCostValues: number[] = [];
    const saleValueValues: number[] = [];
    const questProfitSWValues: number[] = [];
    const questProfitSGValues: number[] = [];
    const questProfitCryptValues: number[] = [];
    const netEntries: number[] = [];
    const buyerEntries: BuyerEntry[] = [];

    const buyerDetailsByAcquisition = new Map(characterAcquisitionBuyerDetails.map(detail => [detail.acquisitionId, detail]));
    characterAcquisitions.forEach(record => {
      const isAcquirer = record.acquirerUid === currentUserUid;
      // O dono original acompanha a negociação na guia Vendidos, mas o
      // personagem não entra em nenhuma métrica dele. Só a perspectiva do
      // adquirente é incorporada às Stats financeiras/operacionais.
      if (!isAcquirer) return;
      // ── Filtros avançados — mesma régua dos personagens próprios ─────────
      // A negociação carrega server/vocation/level/finalPaid/saleValue; a
      // faixa de VENDA ativa só aceita negociações já vendidas (saleValue).
      if (adv.servers.length > 0 && !adv.servers.includes(serverLabel(record.server))) return;
      if (adv.vocations.length > 0 && !adv.vocations.includes(record.vocation)) return;
      if (!inNumRange(record.level || 0, adv.level)) return;
      if (rangeOn(adv.cost) && !inNumRange(record.finalPaid || 0, adv.cost)) return;
      if (rangeOn(adv.sale) && (record.status !== "sold" || !inNumRange(record.saleValue || 0, adv.sale))) return;
      visibleCount += 1;

      const paid = !!record.paymentConfirmedAt || ["payment_confirmed", "quest_completed", "for_sale", "sold", "created"].includes(record.status);
      const paymentAt = record.paymentConfirmedAt || record.createdAt;
      if (!paid || !inRange(paymentAt)) return;
      if (record.status === "sold") buyerSoldCount += 1; else buyerActiveCount += 1;

      const buyerDetails = buyerDetailsByAcquisition.get(record.id);
      const questType = buyerDetails?.questType || record.questType;
      const normalizedQuestType: PtType | undefined = questType === "soulwar" || questType === "sanguine" || questType === "crypt" ? questType : undefined;
      const hasQuestInRange = !!buyerDetails && inRange(buyerDetails.questCompletedAt || buyerDetails.updatedAt);
      const privateQuestProfit = hasQuestInRange ? (buyerDetails?.questProfit || 0) : 0;
      const saleValue = record.saleValue !== undefined && inRange(record.soldAt || record.updatedAt) ? (record.saleValue || 0) : 0;
      const questIsIncluded = normalizedQuestType === "soulwar" ? valueFilter.dropSW : normalizedQuestType === "sanguine" ? valueFilter.dropBakra : normalizedQuestType === "crypt" ? valueFilter.dropCrypt : false;
      const buyerNet = (valueFilter.valorPago ? -(record.finalPaid || 0) : 0)
        + (questIsIncluded ? privateQuestProfit : 0)
        + (valueFilter.valorVenda ? saleValue : 0);

      acquisitionCost += record.finalPaid || 0;
      acquisitionCostValues.push(record.finalPaid || 0);
      if (privateQuestProfit > 0) {
        questProfit += privateQuestProfit;
        if (normalizedQuestType === "soulwar") {
          questProfitSW += privateQuestProfit;
          questProfitSWValues.push(privateQuestProfit);
        } else if (normalizedQuestType === "sanguine") {
          questProfitSG += privateQuestProfit;
          questProfitSGValues.push(privateQuestProfit);
        } else if (normalizedQuestType === "crypt") {
          questProfitCrypt += privateQuestProfit;
          questProfitCryptValues.push(privateQuestProfit);
        }
      }
      if (saleValue > 0) {
        saleRevenue += saleValue;
        saleValueValues.push(saleValue);
      }
      netEntries.push(buyerNet);
      buyerEntries.push({
        server: record.server,
        net: buyerNet,
        questType: normalizedQuestType,
        questDrops: hasQuestInRange ? (buyerDetails?.questDrops || []) : [],
      });
    });

    return {
      visibleCount,
      buyerActiveCount,
      buyerSoldCount,
      acquisitionCost,
      acquisitionCostValues,
      questProfit,
      questProfitSW,
      questProfitSG,
      questProfitCrypt,
      questProfitSWValues,
      questProfitSGValues,
      questProfitCryptValues,
      saleRevenue,
      saleValueValues,
      netEntries,
      buyerEntries,
      net: sum(netEntries),
    };
  }, [characterAcquisitions, characterAcquisitionBuyerDetails, currentUserUid, periodRange, valueFilter, adv]);

  // ── Cálculos financeiros (personagens + negociações) ─────────────────────
  const stats = useMemo(() => {
    const ativos = baseFiltered.filter((c) => !c.vendido);
    const vendidos = baseFiltered.filter((c) => c.vendido);
    const dropSWAvg = avgNonZero([...baseFiltered.map((c) => c.dropSW), ...acquisitionFinance.questProfitSWValues]);
    const dropBakraAvg = avgNonZero([...baseFiltered.map((c) => c.dropBakra), ...acquisitionFinance.questProfitSGValues]);
    // GB entra nas negociações como SW/SG: personagens negociados que
    // concluem Quest GB somam o lucro privado do comprador aqui também.
    const dropCryptAvg = avgNonZero([...baseFiltered.map((c) => c.dropCrypt || 0), ...acquisitionFinance.questProfitCryptValues]);
    const valorPagoAvg = avgNonZero([...baseFiltered.map((c) => c.valorPago), ...acquisitionFinance.acquisitionCostValues]);
    const valorVendaAvg = avgNonZero([...vendidos.map((c) => c.valorVenda), ...acquisitionFinance.saleValueValues]);
    const totalInvestido = sum(baseFiltered.map((c) => c.valorPago)) + acquisitionFinance.acquisitionCost;
    const totalDropSW = sum(baseFiltered.map((c) => c.dropSW)) + acquisitionFinance.questProfitSW;
    const totalDropBakra = sum(baseFiltered.map((c) => c.dropBakra)) + acquisitionFinance.questProfitSG;
    const totalDropCrypt = sum(baseFiltered.map((c) => c.dropCrypt || 0)) + acquisitionFinance.questProfitCrypt;
    const totalVendas = sum(vendidos.map((c) => c.valorVenda)) + acquisitionFinance.saleRevenue;

    const filteredResults = baseFiltered.map((c) => calcResult(c, valueFilter));
    const totalGeral = sum(filteredResults) + acquisitionFinance.net;
    const lucroMedio = avgNonZero([...filteredResults, ...acquisitionFinance.netEntries]);
    const soldWithCost = vendidos.filter((c) => c.valorPago > 0);
    const desvalorizacoes = soldWithCost.map((c) => ((c.valorVenda - c.valorPago) / c.valorPago) * 100);
    const desvalorizacaoMedia = desvalorizacoes.length > 0 ? sum(desvalorizacoes) / desvalorizacoes.length : 0;
    const roiGlobal = totalInvestido > 0 ? (totalGeral / totalInvestido) * 100 : 0;

    return {
      ativos: ativos.length + acquisitionFinance.buyerActiveCount,
      vendidos: vendidos.length + acquisitionFinance.buyerSoldCount,
      totalCharacters: baseFiltered.length + acquisitionFinance.buyerActiveCount + acquisitionFinance.buyerSoldCount,
      dropSWAvg, dropBakraAvg, dropCryptAvg, valorPagoAvg, valorVendaAvg,
      totalInvestido, totalDropSW, totalDropBakra, totalDropCrypt, totalVendas,
      totalGeral, lucroMedio, desvalorizacaoMedia, roiGlobal,
      acquisitionFinance,
    };
  }, [baseFiltered, valueFilter, acquisitionFinance]);

  // ── PT's do usuário, filtradas pelo mesmo período ───────────────────────
  // Uma PT pertence ao usuário quando ele a criou, tem personagem próprio nela,
  // OU participou dela como JOGADOR de um slot de Service (isService) — assim os
  // Services não são ignorados apenas por virem de outra coleção (ServiceList /
  // "+ Externo").
  const partyBase = useMemo(() => {
    const userCharIds = new Set(characters.filter((c) => !negotiatedOriginalCharacterIds.has(c.id)).map((c) => c.id));
    const userParties = parties.filter((p) => {
      if (userName && p.createdByName === userName) return true;
      if (p.selectedIds?.some((id) => userCharIds.has(id))) return true;
      if (userName) {
        const sd = p.slotData || {};
        return Object.values(sd).some((slot) =>
          (slot.isService === true || !!slot.characterAcquisitionId)
          && (slot.player || "") === userName
        );
      }
      return false;
    });
    return userParties.filter((p) => {
      if (periodRange) {
        // DATA CORRETA POR ESTADO: PT concluída entra pelo instante da
        // CONCLUSÃO da Quest (questFinalizedAt — mesma referência dos buckets
        // diários do backend); sem ele, mantém a cadeia antiga
        // arquivamento → início → criação (nunca mistura venda/criação).
        const concludedAt = p.questConcluida ? toFirestoreMillis(p.questFinalizedAt) : 0;
        const ts = concludedAt || p.archivedAt || p.ptStartedAt || p.createdAt || 0;
        if (!ts || ts < periodRange.start || ts > periodRange.end) return false;
      }
      // Filtro de SERVIDOR também delimita o relatório de PT's (resolução
      // canônica já usada na seção Servidor: campo da PT ou personagem próprio).
      if (adv.servers.length > 0) {
        const srv = resolvePartyServer(p, characters);
        if (!srv || !adv.servers.includes(srv)) return false;
      }
      return true;
    });
  }, [parties, characters, negotiatedOriginalCharacterIds, userName, periodRange, adv.servers]);

  const completedParties = useMemo(
    () => partyBase.filter((p) => p.questConcluida && !p.questFalha),
    [partyBase],
  );

  // ── FONTE EXATA DAS PTs CONCLUÍDAS (Relatório de PTs) ─────────────────────
  // CAUSA REAL da divergência com "Meu Histórico de PTs": a finalização APAGA
  // o doc da PT de `parties`, então o cálculo derivado só enxergava as ainda
  // ativas; e os buckets diários persistidos (dailyStats, particionados por
  // dia UTC) não casam com os limites LOCAIS dos filtros de período —
  // omissões sistemáticas nas bordas dos dias (ex.: filtro de um dia
  // específico não contava PTs concluídas naquele dia local).
  //
  // A fonte correta já está EM MEMÓRIA, sem nenhuma leitura extra: a mesma
  // projeção privada users/{uid}/partyHistory que alimenta "Meu Histórico de
  // PTs" (assinada via onSnapshot no App + cache local). União dedup por
  // partyId:
  //   • entradas do histórico com status != "failed" (concluídas), datadas
  //     pelo instante de CONCLUSÃO da Quest (questFinalizedAt) e filtradas
  //     em hora local — exatamente como o restante dos Filtros da Análise;
  //   • + PTs concluídas AINDA presentes em `parties` (completedParties, já
  //     período/servidor-filtradas), que podem ainda não ter projeção de
  //     histórico — o dedup garante que nenhuma PT conta duas vezes.
  // Resultado: o Relatório bate com o Histórico por construção, para
  // qualquer período/servidor, incluindo PTs com participantes de outros
  // usuários (cada participante tem sua própria projeção de histórico).
  const concludedExact = useMemo(() => {
    const byId = new Map<string, { questType: string; concludedAt: number }>();
    (partyHistory || []).forEach((entry) => {
      if (!entry || entry.status === "failed") return;
      const id = entry.partyId || entry.id;
      if (!id || byId.has(id)) return;
      const concludedAt = toFirestoreMillis(entry.party?.questFinalizedAt)
        || toFirestoreMillis(entry.party?.finalizedAt)
        || toFirestoreMillis(entry.createdAt);
      if (periodRange && (!concludedAt || concludedAt < periodRange.start || concludedAt > periodRange.end)) return;
      if (adv.servers.length > 0) {
        const srv = serverLabel(entry.party?.server || "");
        if (!srv || !adv.servers.includes(srv)) return;
      }
      byId.set(id, { questType: entry.party?.questType || "", concludedAt });
    });
    completedParties.forEach((p) => {
      if (byId.has(p.id)) return;
      const concludedAt = toFirestoreMillis(p.questFinalizedAt) || p.archivedAt || p.ptStartedAt || p.createdAt || 0;
      byId.set(p.id, { questType: p.ptType || "", concludedAt });
    });
    const list = Array.from(byId.values());
    return {
      concluidas: list.length,
      soulwar: list.filter((e) => e.questType === "soulwar").length,
      sanguine: list.filter((e) => e.questType === "sanguine").length,
      timestamps: list.map((e) => e.concludedAt).filter((ts) => ts > 0),
    };
  }, [partyHistory, completedParties, periodRange, adv.servers]);

  const partyStats = useMemo(() => {
    const concluidas = completedParties.length;
    let freqPorDia = 0;
    if (concluidas > 0) {
      const timestamps = completedParties.map((p) => p.ptStartedAt || p.createdAt || 0).filter((ts) => ts > 0);
      if (timestamps.length > 0) {
        const days = daysBetween(new Date(Math.min(...timestamps)), new Date());
        freqPorDia = concluidas / days;
      }
    }
    return {
      total: partyBase.length,
      concluidas,
      falhadas: partyBase.filter((p) => p.questFalha).length,
      pagas: partyBase.filter((p) => p.pagamentoFeito).length,
      ativas: partyBase.filter((p) => !p.archived).length,
      soulwar: partyBase.filter((p) => p.ptType === "soulwar").length,
      sanguine: partyBase.filter((p) => p.ptType === "sanguine").length,
      freqPorDia,
    };
  }, [partyBase, completedParties]);

  // ── Lucro de Services ─────────────────────────────────────────────────────
  // Vem do LUCRO informado no painel "Meus Services" (campo `lucroService` dos
  // services com status "realizado"), NÃO do valor preenchido na PT. Usa a
  // função canônica sumServiceProfit (mesma fonte consumida pelo painel).
  // Quando há um período selecionado, filtra pelos services concluídos no
  // período (completedAt) para respeitar os filtros da Stats.
  const serviceProfit = useMemo(() => {
    // DATA CORRETA do Service realizado: conclusão (completedAt) → data do
    // próprio Service (dataService, o dia em que foi feito) → última
    // atualização como derradeiro fallback. Antes, um Service sem completedAt
    // caía direto em updatedAt (qualquer edição mudava o período dele).
    const serviceDateMs = (s: SharedService): number => {
      if (s.completedAt) return s.completedAt;
      if (s.dataService) {
        const t = new Date(`${s.dataService}T00:00:00`).getTime();
        if (!Number.isNaN(t)) return t;
      }
      return s.updatedAt || 0;
    };
    const periodScoped = periodRange
      ? services.filter((s) => s.status === "realizado"
          && serviceDateMs(s) >= periodRange.start
          && serviceDateMs(s) <= periodRange.end)
      : services;
    // Services têm servidor e vocação próprios — os filtros avançados também
    // delimitam este indicador (faixas de Level/Custo/Venda não se aplicam a
    // Services, que não têm esses campos financeiros; ver tooltip).
    const scoped = periodScoped.filter((s) => {
      if (adv.servers.length > 0 && !adv.servers.includes(serverLabel(s.servidor))) return false;
      if (adv.vocations.length > 0 && !adv.vocations.includes(s.voc)) return false;
      return true;
    });
    return sumServiceProfit(scoped);
  }, [services, periodRange, adv.servers, adv.vocations]);

  // ── userStats (estatísticas persistentes no Firestore) ───────────────────
  // Hoje este portão alimenta APENAS a seção de PARCEIROS persistidos (mapa
  // partners por UID, sem partição por período/servidor — por isso exige
  // "Tudo" sem filtro de servidor). Os contadores de PTs concluídas do
  // Relatório passaram a usar o conjunto exato `concludedExact` (histórico
  // pessoal + PTs em memória), com o vitalício persistido como piso no
  // "Tudo" — ver bloco "CONTADORES DO RELATÓRIO DE PTs" abaixo.
  const hasPersistedStats = !!userStats && typeof userStats.totalPtsConcluidas === "number" && adv.servers.length === 0;

  // ── CONTADORES DO RELATÓRIO DE PTs ────────────────────────────────────────
  // COM filtro de período e/ou servidor ativo: usa EXCLUSIVAMENTE o conjunto
  // exato `concludedExact` (histórico pessoal + PTs concluídas em memória,
  // dedup por partyId) — filtragem precisa em hora local pelo instante de
  // CONCLUSÃO da Quest. Os buckets dailyStats (particionados por dia UTC)
  // deixaram de alimentar estes contadores: a comparação dia-UTC × limites
  // locais omitia PTs nas bordas dos dias (a divergência reportada em
  // relação a "Meu Histórico de PTs").
  //
  // SEM filtros ("Tudo"): o contador vitalício persistido (userStats) segue
  // sendo a fonte — ele cobre PTs antigas, anteriores à projeção de
  // histórico — com o conjunto exato como PISO (max): se alguma PT visível
  // no histórico ainda não foi creditada em userStats (ex.: falha transitória
  // do commit), o Relatório nunca mostra menos do que o Histórico. max()
  // nunca duplica: escolhe a maior das duas contagens, não as soma.
  const exactFiltersActive = !!periodRange || adv.servers.length > 0;
  const persistedConcluidas = !!userStats && typeof userStats.totalPtsConcluidas === "number" ? (userStats.totalPtsConcluidas || 0) : 0;
  const persistedSoulwar = !!userStats && typeof userStats.totalPtsSoulwar === "number" ? (userStats.totalPtsSoulwar || 0) : 0;
  const persistedSanguine = !!userStats && typeof userStats.totalPtsSanguine === "number" ? (userStats.totalPtsSanguine || 0) : 0;

  const statConcluidas = exactFiltersActive
    ? concludedExact.concluidas
    : Math.max(concludedExact.concluidas, persistedConcluidas);
  const statSoulwar = exactFiltersActive
    ? concludedExact.soulwar
    : Math.max(concludedExact.soulwar, persistedSoulwar);
  const statSanguine = exactFiltersActive
    ? concludedExact.sanguine
    : Math.max(concludedExact.sanguine, persistedSanguine);

  // Frequência/dia COERENTE com o conjunto contado acima: da primeira
  // conclusão do conjunto até o FIM do período selecionado (ou agora, no
  // "Tudo") — um período antigo nunca é diluído até a data atual.
  const statFreqPorDia = useMemo(() => {
    if (concludedExact.timestamps.length === 0) return 0;
    const first = Math.min(...concludedExact.timestamps);
    const endAnchor = Math.min(Date.now(), periodRange?.end ?? Date.now());
    const days = Math.max(1, daysBetween(new Date(first), new Date(endAnchor)));
    return concludedExact.concluidas / days;
  }, [concludedExact, periodRange]);

  // ── Média de compra por dia ─────────────────────────────────────────────
  // Média de personagens comprados/adicionados à lista "Meus Personagens" por
  // dia, usando "Data da Compra". Considera apenas os personagens válidos
  // (baseFiltered). Registros sem Data da Compra válida são ignorados.
  const avgPurchasePerDay = useMemo(() => {
    const tsList: number[] = [];
    baseFiltered.forEach((c) => {
      const ms = charDateMs(c);
      if (ms > 0) tsList.push(ms);
    });
    if (tsList.length === 0) return 0;
    const earliest = Math.min(...tsList);
    const days = daysBetween(new Date(earliest), new Date());
    return tsList.length / days;
  }, [baseFiltered]);

  // ── Seção "Servidor" ─────────────────────────────────────────────────────
  // Cada servidor que tenha PTs concluídas (no período selecionado).
  // Exibe: nº de PTs concluídas, lucro médio por personagem e lucro total,
  // usando o mesmo cálculo financeiro (Cálculo) dos demais indicadores.
  const serverStats = useMemo(() => {
    const map = new Map<string, { ptCount: number; charCount: number; totalProfit: number }>();
    completedParties.forEach((p) => {
      const srv = resolvePartyServer(p, characters);
      if (!srv) return;
      const e = map.get(srv) || { ptCount: 0, charCount: 0, totalProfit: 0 };
      e.ptCount += 1;
      map.set(srv, e);
    });
    baseFiltered.forEach((c) => {
      const srv = serverLabel(c.servidor);
      if (!srv) return;
      const e = map.get(srv) || { ptCount: 0, charCount: 0, totalProfit: 0 };
      e.charCount += 1;
      e.totalProfit += calcResult(c, valueFilter);
      map.set(srv, e);
    });
    // A perspectiva do adquirente não possui um Character duplicado. Incluímos
    // a entrada privada dela pelo servidor da negociação, sem reintroduzir o
    // personagem do dono original nesta agregação.
    acquisitionFinance.buyerEntries.forEach((entry) => {
      const srv = serverLabel(entry.server);
      if (!srv) return;
      const e = map.get(srv) || { ptCount: 0, charCount: 0, totalProfit: 0 };
      e.charCount += 1;
      e.totalProfit += entry.net;
      map.set(srv, e);
    });
    return [...map.entries()]
      .filter(([, e]) => e.ptCount > 0)
      .map(([srv, e]) => ({ srv, ...e, avgProfit: e.charCount > 0 ? e.totalProfit / e.charCount : 0 }))
      .sort((a, b) => b.totalProfit - a.totalProfit || b.ptCount - a.ptCount);
  }, [acquisitionFinance.buyerEntries, baseFiltered, completedParties, characters, valueFilter]);

  // ── Drops (Soulwar / Sanguine / Crypt) ───────────────────────────────────
  const itemStats = useMemo(() => {
    const swCounts: Record<string, number> = {};
    const sgCounts: Record<string, number> = {};
    const cryptCounts: Record<string, number> = {};
    SOULWAR_ITEMS.forEach((item) => { swCounts[item] = 0; });
    SANGUINE_ITEMS.forEach((item) => { sgCounts[item] = 0; });
    CRYPT_ITEMS.forEach((item) => { cryptCounts[item] = 0; });
    baseFiltered.forEach((c) => {
      if (c.itemDropadoSW && swCounts[c.itemDropadoSW] !== undefined) swCounts[c.itemDropadoSW]++;
      if (c.itemDropadoSG && sgCounts[c.itemDropadoSG] !== undefined) sgCounts[c.itemDropadoSG]++;
      if (c.itemDropadoCrypt && cryptCounts[c.itemDropadoCrypt] !== undefined) cryptCounts[c.itemDropadoCrypt]++;
    });
    // Os drops privados do adquirente usam a mesma lista SW/SG da tabela de
    // personagens. Eles não são expostos ao dono original, mas entram nas
    // próprias estatísticas do comprador.
    acquisitionFinance.buyerEntries.forEach((entry) => {
      entry.questDrops.forEach((item) => {
        if (entry.questType === "soulwar" && swCounts[item] !== undefined) swCounts[item]++;
        if (entry.questType === "sanguine" && sgCounts[item] !== undefined) sgCounts[item]++;
      });
    });

    const getPriority = (itemName: string, type: "sw" | "sg" | "crypt") => {
      const color = ITEM_COLORS[itemName];
      const list = type === "sg" ? SG_PRIORITY : type === "crypt" ? CRYPT_PRIORITY : SW_PRIORITY;
      const idx = list.indexOf(color);
      return idx === -1 ? 999 : idx;
    };

    const sortBy = (type: "sw" | "sg" | "crypt") => (a: [string, number], b: [string, number]) => {
      const pA = getPriority(a[0], type);
      const pB = getPriority(b[0], type);
      if (pA !== pB) return pA - pB;
      return b[1] - a[1] || a[0].localeCompare(b[0]);
    };

    return {
      swList: Object.entries(swCounts).sort(sortBy("sw")),
      sgList: Object.entries(sgCounts).sort(sortBy("sg")),
      cryptList: Object.entries(cryptCounts).sort(sortBy("crypt")),
      totalSW: sum(Object.values(swCounts)), totalSG: sum(Object.values(sgCounts)),
      totalCrypt: sum(Object.values(cryptCounts)),
    };
  }, [acquisitionFinance.buyerEntries, baseFiltered]);

  // ── Parceiros de Quest (persistidos por UID, senão recalculados) ────────
  // O recálculo local parte de `completedParties` — as PTs concluídas JÁ
  // delimitadas pelos filtros de período/servidor da análise (antes a lista
  // era rederivada sem período, ignorando o filtro selecionado).
  const partnerStats = useMemo(() => {
    const userCharIds = new Set(characters.filter((c) => !negotiatedOriginalCharacterIds.has(c.id)).map((c) => c.id));
    const partners: Record<string, number> = {};
    completedParties.forEach((p) => {
      const sd = p.slotData || {};
      p.selectedIds.forEach((id) => {
        if (!userCharIds.has(id)) {
          const name = sd[id]?.player || sd[id]?.owner;
          if (name) partners[name] = (partners[name] || 0) + 1;
        }
      });
      p.customMembers?.forEach((cm) => {
        partners[cm.label] = (partners[cm.label] || 0) + 1;
      });
    });

    return Object.entries(partners)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
  }, [completedParties, characters, negotiatedOriginalCharacterIds]);

  const displayPartners = useMemo<[string, number][]>(() => {
    // Persistido = contagem VITALÍCIA por UID (sem partição por dia): só vale
    // sem período selecionado. Com período ativo, usa o recálculo local já
    // delimitado pelos filtros — nenhum indicador fica com resultado de
    // critérios diferentes dos escolhidos.
    const persisted = userStats?.partners;
    if (hasPersistedStats && !periodRange && persisted && Object.keys(persisted).length > 0) {
      return Object.entries(persisted)
        .map(([uid, count]) => [userNames[uid] || `Usuário ${uid.slice(0, 6)}…`, count] as [string, number])
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);
    }
    return partnerStats;
  }, [hasPersistedStats, periodRange, userStats?.partners, userNames, partnerStats]);

  const resetAllFilters = () => {
    setValueFilter(DEFAULT_VALUE_FILTER);
    setStatusFilter(DEFAULT_STATUS);
    setPeriod("all");
    setCustomPeriodRaw({ ...DEFAULT_CUSTOM_PERIOD });
    setOnlyComplete(false);
    setAdvRaw(defaultAdvancedFilters());
  };

  // ── Opções dos seletores múltiplos — derivadas dos dados JÁ carregados ──
  // Servidores: personagens próprios + negociações do adquirente + Services
  // (rótulo canônico). Vocações: ordem oficial de VOCATIONS, exibindo apenas
  // as presentes nos dados (lista cheia como fallback quando não há dados).
  const serverOptions = useMemo(() => {
    const set = new Set<string>();
    characters.forEach((c) => { const s = serverLabel(c.servidor); if (s) set.add(s); });
    characterAcquisitions.forEach((r) => {
      if (r.acquirerUid !== currentUserUid) return;
      const s = serverLabel(r.server); if (s) set.add(s);
    });
    services.forEach((s) => { const srv = serverLabel(s.servidor); if (srv) set.add(srv); });
    return Array.from(set).sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [characters, characterAcquisitions, currentUserUid, services]);
  const vocationOptions = useMemo(() => {
    const set = new Set<string>();
    characters.forEach((c) => { if (c.voc) set.add(c.voc); });
    characterAcquisitions.forEach((r) => { if (r.acquirerUid === currentUserUid && r.vocation) set.add(r.vocation); });
    services.forEach((s) => { if (s.voc) set.add(s.voc); });
    const ordered = VOCATIONS.filter((v) => set.has(v));
    return ordered.length > 0 ? ordered : [...VOCATIONS];
  }, [characters, characterAcquisitions, currentUserUid, services]);

  // ── Selo "N filtro(s) ativo(s)" — qualquer desvio do padrão conta ───────
  const activeFilterCount = useMemo(() => {
    let n = 0;
    // "Personalizado" sem nenhuma data preenchida equivale a "Tudo" — não conta.
    if (period !== "all" && (period !== "custom" || periodRange !== null)) n += 1;
    if (!statusFilter.ativos || !statusFilter.historico) n += 1;
    if (onlyComplete) n += 1;
    if (!valueFilter.valorPago || !valueFilter.dropSW || !valueFilter.dropBakra || !valueFilter.dropCrypt || !valueFilter.valorVenda) n += 1;
    if (adv.servers.length > 0) n += 1;
    if (adv.vocations.length > 0) n += 1;
    for (const range of [adv.level, adv.cost, adv.sale]) if (rangeOn(range)) n += 1;
    return n;
  }, [period, periodRange, statusFilter, onlyComplete, valueFilter, adv]);

  // Universo total comparável ao contador do quadro: personagens próprios
  // (sem os cedidos em negociação) + negociações em que sou o adquirente.
  const totalUniverse = useMemo(() => {
    const own = characters.filter((c) => !negotiatedOriginalCharacterIds.has(c.id)).length;
    const acquired = characterAcquisitions.filter((r) => r.acquirerUid === currentUserUid).length;
    return own + acquired;
  }, [characters, negotiatedOriginalCharacterIds, characterAcquisitions, currentUserUid]);

  // ── Tooltips ─────────────────────────────────────────────────────────────
  const tt = {
    resultadoLiquido: `RESULTADO LÍQUIDO CONSOLIDADO\n\nFórmula: (Drops SW + Drops SG + Vendas) − Custos`,
    custos: `CUSTOS TOTAIS\n\nSoma de "Valor Pago (RC)" de todos os personagens incluídos pelos filtros.`,
    drops: `LUCRO TOTAL EM DROPS\n\nSoma de Drop SW (Soulwar) + Drop SG (Sanguine) de todos os personagens da base filtrada.`,
    vendas: `VENDAS TOTAIS\n\nSoma de "Valor Venda (RC)" de todos os personagens marcados como vendidos.`,
    roi: `RETORNO SOBRE INVESTIMENTO (ROI)\n\nFórmula: (Resultado Líquido ÷ Custos Totais) × 100`,
    ativos: `PERSONAGENS ATIVOS\n\nQuantidade de personagens que ainda NÃO foram marcados como vendidos.`,
    vendidos: `PERSONAGENS VENDIDOS\n\nQuantidade de personagens já vendidos e movidos para a aba "Meu Histórico".`,
    pts: `PT's TOTAIS\n\nNúmero total de PT's que você criou OU participou com seus personagens.`,
    ptsDia: `FREQUÊNCIA DE PT's\n\nMédia diária de PT's CONCLUÍDAS (sucesso).`,
    medDropSW: `MÉDIA DE DROP SOULWAR\n\nLucro médio (RC) em Soulwar por personagem que dropou.`,
    medDropSG: `MÉDIA DE DROP SANGUINE\n\nLucro médio (RC) em Sanguine por personagem que dropou.`,
    medDropCrypt: `MÉDIA DE DROP GRAVEBORN\n\nLucro médio (RC) na Graveborn por personagem que dropou.`,
    custoUnit: `CUSTO UNITÁRIO MÉDIO\n\nPreço médio pago pelos personagens da base filtrada.`,
    vendaUnit: `VENDA UNITÁRIA MÉDIA\n\nValor médio de revenda dos personagens vendidos.`,
    resultadoMedio: `RESULTADO MÉDIO\n\nLucro líquido médio por personagem.`,
    desvalorizacao: `DESVALORIZAÇÃO MÉDIA\n\nFórmula: Média de ((Valor Venda − Valor Pago) ÷ Valor Pago) × 100`,
    concluidas: `PT's CONCLUÍDAS\n\nPT's onde a quest foi finalizada COM SUCESSO.`,
    falhas: `PT's FALHADAS\n\nPT's marcadas explicitamente como "Falha".`,
    pagas: `PT's PAGAS\n\nPT's onde o pagamento foi distribuído e a PT foi finalizada.`,
    aberto: `PT's EM ABERTO\n\nPT's ainda não arquivadas.`,
    volSoulwar: `VOLUME SOULWAR\n\nQuantidade e porcentagem de PT's do tipo Soulwar.`,
    volSanguine: `VOLUME SANGUINE\n\nQuantidade e porcentagem de PT's do tipo Sanguine.`,
    compraDia: `MÉDIA DE COMPRA POR DIA\n\nMédia de personagens comprados/adicionados à lista "Meus Personagens" por dia, considerando a "Data da Compra" dos personagens válidos pelos filtros atuais.\nRegistros sem data válida são ignorados.`,
    lucroServices: `LUCRO DE SERVICES\n\nSoma do lucro informado nos seus Services com status "realizado" no painel Meus Services (campo lucroService). Quando há período selecionado, considera apenas os concluídos no período.`,
  };

  const money = (v: number) => (totalVisible ? formatRC(v) : "•••");
  const moneyAvg = (v: number) => (totalVisible ? formatRC(Math.round(v)) : "•••");

  const pillActive = "border-emerald-500/60 bg-emerald-500/20 text-emerald-300";
  const pillIdle = "border-white/10 bg-white/[0.03] text-slate-400 hover:border-white/25 hover:text-slate-200";

  return (
    <div className="h-full flex flex-col overflow-y-auto gap-3 px-3 pb-4 custom-scrollbar text-xs">
      {/* ═══════════ CABEÇALHO (sempre visível) ═══════════ */}
      <div className="sticky top-0 z-20 bg-[var(--th-n-base)] border-b border-[var(--th-line)]/50 pb-1.5 pt-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <div className="flex items-center gap-2">
            <BarChart3 size={15} className="text-amber-500/90" />
            <span className="text-sm font-bold text-white uppercase tracking-tight">Estatísticas</span>
          </div>
          {activeFilterCount > 0 ? (
            <span
              className="inline-flex items-center gap-1 px-1.5 h-5 rounded-md border border-amber-400/40 bg-amber-500/15 text-amber-200 text-[9px] font-black cursor-help"
              title="Quantidade de filtros/opções em efeito agora. Todos os indicadores, gráficos e tabelas abaixo consideram apenas o conjunto filtrado."
            >
              {activeFilterCount} filtro(s) ativo(s)
            </span>
          ) : (
            <span className="text-[9px] text-slate-500 font-bold">nenhum filtro ativo — estatísticas completas</span>
          )}
          <span
            className="text-[10px] text-slate-400 cursor-help"
            title="Quantos personagens (próprios + negociações em que você é o adquirente) atendem a TODOS os filtros ativos, sobre o total disponível."
          >
            <span className="font-black text-amber-200">{stats.totalCharacters}</span> de {totalUniverse} personagens no filtro
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            {activeFilterCount > 0 && (
              <button
                onClick={resetAllFilters}
                className="inline-flex items-center gap-1 rounded-md border border-rose-500/25 bg-rose-500/10 px-2 py-1 text-[9px] font-bold text-rose-300 transition-colors hover:bg-rose-500/20 hover:border-rose-400/40"
                title="Remove todos os filtros e restaura a visualização padrão (período Tudo, Disponíveis + Vendidos, cálculo completo, sem faixas)."
              >
                <RotateCcw size={10} /> Limpar Filtros
              </button>
            )}
            <button
              onClick={() => setFiltersOpen((v) => !v)}
              className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[9px] font-bold transition-colors ${filtersOpen ? "border-amber-500/40 bg-amber-500/15 text-amber-200" : "border-[var(--th-line)]/40 bg-[var(--th-bg-base)] text-slate-400 hover:text-slate-200 hover:bg-[var(--th-line)]/15"}`}
              title={filtersOpen ? "Recolher o quadro de filtros (os filtros continuam aplicados)" : "Exibir o quadro de filtros"}
            >
              <SlidersHorizontal size={10} /> Filtros {filtersOpen ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
            </button>
          </div>
        </div>
      </div>

      {/* ═══════════ QUADRO DEDICADO DE FILTROS ═══════════
          Separado dos resultados, 100% local (nenhuma leitura de Firestore ao
          mudar filtro) e combinável: todas as condições valem em conjunto. */}
      {filtersOpen && (
        <div className="rounded-xl border border-amber-500/25 bg-[var(--th-bg-base)]/95 px-3 py-2 space-y-2 flex-shrink-0 shadow-[0_0_14px_rgba(245,158,11,0.06)]">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-amber-400/40 bg-amber-500/15">
              <SlidersHorizontal size={12} className="text-amber-300" />
            </span>
            <span className="text-[11px] font-black uppercase tracking-wide text-slate-100">Filtros da Análise</span>
            <span className="text-[9px] text-slate-500">
              combináveis entre si · todos os indicadores, gráficos e tabelas refletem o conjunto filtrado
            </span>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {/* ── PERÍODO ─────────────────────────────────────────────── */}
            <StatsFilterBox title="Período" hint="Janela de tempo da análise: personagens pela Data de Compra/Venda, PT's concluídas pela data de CONCLUSÃO da Quest, negociações pelos registros da própria negociação e Services pela conclusão (ou data do Service). 'Personalizado' permite escolher dia/mês/ano de início e fim.">
              <div className="flex flex-wrap gap-1">
                {PERIODS.map((p) => (
                  <button key={p.key} onClick={() => setPeriod(p.key)} className={`px-1.5 py-0.5 rounded-md text-[9px] font-bold border transition-all ${period === p.key ? pillActive : pillIdle}`}>
                    {p.label}
                  </button>
                ))}
              </div>
              {period === "custom" && (
                <div className="flex flex-wrap items-end gap-x-3 gap-y-1.5 pt-0.5">
                  {([["Início", "start"], ["Fim", "end"]] as const).map(([label, side]) => (
                    <div key={side} className="flex flex-col gap-0.5" title={side === "start"
                      ? "Primeiro dia incluído na análise (00:00). Vazio = desde o primeiro registro."
                      : "Último dia incluído na análise (23:59). Vazio = até hoje."}>
                      <span className={`text-[9px] font-black uppercase tracking-wide ${customPeriod[side] ? "text-amber-300" : "text-slate-400"}`}>{label}</span>
                      <input
                        type="date"
                        value={customPeriod[side]}
                        onChange={(e) => setCustomPeriodRaw({ ...customPeriod, [side]: e.target.value })}
                        className={`h-7 rounded-md border bg-black/30 px-1.5 text-[10px] outline-none focus:border-amber-400/60 transition-colors [color-scheme:dark] ${customPeriod[side] ? "border-amber-400/50 text-amber-200 font-bold" : "border-[var(--th-line)]/60 text-slate-200"}`}
                      />
                    </div>
                  ))}
                  {(customPeriod.start || customPeriod.end) && (
                    <button
                      type="button"
                      onClick={() => setCustomPeriodRaw({ ...DEFAULT_CUSTOM_PERIOD })}
                      className="h-7 px-2 rounded-md border border-[var(--th-line)]/50 bg-black/25 text-[9px] font-bold text-slate-400 hover:text-slate-200 hover:border-rose-400/40 transition-colors"
                      title="Limpa apenas as datas do intervalo personalizado."
                    >
                      Limpar datas
                    </button>
                  )}
                </div>
              )}
            </StatsFilterBox>

            {/* ── PERSONAGEM ──────────────────────────────────────────── */}
            <StatsFilterBox title="Personagem" hint="Delimita QUAIS personagens/negociações entram na análise: status, completude dos dados, vocações, servidores e faixa de level. Seleções múltiplas valem como 'qualquer um dos escolhidos'.">
              <div className="flex flex-col gap-0.5" title="Inclui personagens disponíveis e/ou já vendidos. Os dois ligados = todos.">
                <span className="text-[9px] font-black uppercase tracking-wide text-slate-400">Status</span>
                <div className="flex gap-1">
                  <button onClick={() => setStatusFilter((f) => ({ ...f, ativos: !f.ativos }))} className={`px-2 py-0.5 rounded-md text-[9px] font-bold border transition-all ${statusFilter.ativos ? "border-sky-500/60 bg-sky-500/20 text-sky-300" : pillIdle}`}>Disponíveis</button>
                  <button onClick={() => setStatusFilter((f) => ({ ...f, historico: !f.historico }))} className={`px-2 py-0.5 rounded-md text-[9px] font-bold border transition-all ${statusFilter.historico ? "border-amber-500/60 bg-amber-500/20 text-amber-300" : pillIdle}`}>Vendidos</button>
                </div>
              </div>
              <div className="flex flex-col gap-0.5" title="Vocações consideradas (seleção múltipla). Nenhuma selecionada = todas.">
                <span className={`text-[9px] font-black uppercase tracking-wide ${adv.vocations.length > 0 ? "text-amber-300" : "text-slate-400"}`}>Vocação</span>
                <FilterMulti label="Vocação" options={vocationOptions} selected={adv.vocations} onApply={(values) => updateAdvanced({ vocations: values })} placeholder="Vocação" />
              </div>
              <div className="flex flex-col gap-0.5" title="Servidores considerados (seleção múltipla). Nenhum selecionado = todos. Também delimita o Relatório de PT's, a seção Servidor e o Lucro de Services.">
                <span className={`text-[9px] font-black uppercase tracking-wide ${adv.servers.length > 0 ? "text-amber-300" : "text-slate-400"}`}>Servidor</span>
                <FilterMulti label="Servidor" options={serverOptions} selected={adv.servers} onApply={(values) => updateAdvanced({ servers: values })} placeholder="Servidor" searchable />
              </div>
              <StatsRangeField label="Level" range={adv.level} onChange={(range) => updateAdvanced({ level: range })} hint="Faixa de level do personagem (mín/máx livres). Vazio em um lado = sem limite naquele lado." />
              <button
                type="button"
                onClick={() => setOnlyComplete((v) => !v)}
                className={`inline-flex items-center gap-1.5 self-end rounded-md border px-2 py-0.5 text-[9px] font-bold transition-all ${onlyComplete ? "border-violet-500/60 bg-violet-500/20 text-violet-300" : pillIdle}`}
                title="Considera somente personagens com Custo preenchido e pelo menos um dos lucros (SW ou SG)."
              >
                <span className={`inline-flex items-center justify-center w-3 h-3 rounded border ${onlyComplete ? "bg-violet-500/40 border-violet-400" : "border-[var(--th-line)]/60"}`}>
                  {onlyComplete && <span className="block w-1.5 h-1.5 rounded-full bg-violet-300" />}
                </span>
                Apenas personagens completos
              </button>
            </StatsFilterBox>

            {/* ── VALORES (RC) ────────────────────────────────────────── */}
            <StatsFilterBox title="Valores (RC)" hint="Faixas financeiras em Rubini Coins. Custo = Valor Pago do personagem (ou valor pago na negociação adquirida). Venda = valor de venda — faixa ativa considera apenas vendidos. Não se aplicam ao Lucro de Services.">
              <StatsRangeField label="Custo" range={adv.cost} onChange={(range) => updateAdvanced({ cost: range })} hint="Faixa do Valor Pago (RC) pelo personagem — inclui o valor pago nas negociações em que você é o adquirente." />
              <StatsRangeField label="Venda" range={adv.sale} onChange={(range) => updateAdvanced({ sale: range })} hint="Faixa do Valor de Venda (RC). Com esta faixa ativa, apenas personagens/negociações JÁ VENDIDOS entram na análise." />
            </StatsFilterBox>

            {/* ── CÁLCULO DO RESULTADO ────────────────────────────────── */}
            <StatsFilterBox title="Cálculo do Resultado" hint="Compõe o Resultado Líquido: cada parcela ligada entra na conta (Custo subtrai; Drops e Venda somam). Desligar uma parcela NÃO exclui personagens — só muda a fórmula.">
              <div className="flex flex-wrap gap-1">
                <button onClick={() => setValueFilter((f) => ({ ...f, valorPago: !f.valorPago }))} className={`px-2 py-0.5 rounded-md text-[9px] font-bold border transition-all ${valueFilter.valorPago ? "border-rose-500/60 bg-rose-500/20 text-rose-300" : `${pillIdle} opacity-50`}`} title="Custo (subtrai)">Custo</button>
                <button onClick={() => setValueFilter((f) => ({ ...f, dropSW: !f.dropSW }))} className={`px-2 py-0.5 rounded-md text-[9px] font-bold border transition-all ${valueFilter.dropSW ? "border-purple-500/60 bg-purple-500/20 text-purple-300" : `${pillIdle} opacity-50`}`} title="Drop SW (soma)">Drop SW</button>
                <button onClick={() => setValueFilter((f) => ({ ...f, dropBakra: !f.dropBakra }))} className={`px-2 py-0.5 rounded-md text-[9px] font-bold border transition-all ${valueFilter.dropBakra ? "border-orange-500/60 bg-orange-500/20 text-orange-300" : `${pillIdle} opacity-50`}`} title="Drop SG (soma)">Drop SG</button>
                <button onClick={() => setValueFilter((f) => ({ ...f, dropCrypt: !(f.dropCrypt ?? true) }))} className={`px-2 py-0.5 rounded-md text-[9px] font-bold border transition-all ${valueFilter.dropCrypt ? "border-cyan-500/60 bg-cyan-500/20 text-cyan-300" : `${pillIdle} opacity-50`}`} title="Drop GB (soma)">Drop GB</button>
                <button onClick={() => setValueFilter((f) => ({ ...f, valorVenda: !f.valorVenda }))} className={`px-2 py-0.5 rounded-md text-[9px] font-bold border transition-all ${valueFilter.valorVenda ? "border-emerald-500/60 bg-emerald-500/20 text-emerald-300" : `${pillIdle} opacity-50`}`} title="Venda (soma)">Venda</button>
              </div>
            </StatsFilterBox>
          </div>
        </div>
      )}

      {/* ═══════════ KPIs PRINCIPAIS ═══════════ */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {/* Resultado Líquido */}
        <div className={`relative rounded-xl border border-amber-600/25 bg-[var(--th-bg-base)] px-3 py-2.5 flex flex-col justify-center min-w-0 col-span-2 md:col-span-1 ${stats.totalGeral >= 0 ? "border-emerald-500/25" : "border-rose-500/30"}`} title={tt.resultadoLiquido}>
          <button onClick={() => setTotalVisible(!totalVisible)} className="absolute top-1.5 right-1.5 p-0.5 rounded bg-black/20 text-slate-500 hover:text-slate-200 transition-colors" title={totalVisible ? "Ocultar valores" : "Mostrar valores"}>
            {totalVisible ? <EyeOff size={11} /> : <Eye size={11} />}
          </button>
          <div className="flex items-center gap-1.5 text-[8px] uppercase tracking-wider text-slate-500 font-bold mb-1">Resultado Líquido</div>
          <div className={`text-2xl font-black tabular-nums leading-none flex items-center gap-1.5 ${stats.totalGeral >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
            {money(stats.totalGeral)} {stats.totalGeral >= 0 ? <TrendingUp size={18} /> : <TrendingDown size={18} />}
          </div>
          <div className="mt-1 text-[9px] text-slate-500 truncate">
            Custos {money(stats.totalInvestido)} · Drops {money(stats.totalDropSW + stats.totalDropBakra + stats.totalDropCrypt)} · Vendas {money(stats.totalVendas)}
          </div>
        </div>

        {/* ROI */}
        <HeroCard icon={<Target size={13} className="text-amber-400" />} label="ROI" value={totalVisible ? `${stats.roiGlobal.toFixed(1)}%` : "•••"} accent={stats.roiGlobal >= 0 ? "text-emerald-400" : "text-rose-400"} sub={`Sobre ${money(stats.totalInvestido)} investidos`} title={tt.roi} />

        {/* PT's Concluídas */}
        <HeroCard icon={<CheckCircle2 size={13} className="text-emerald-400" />} label="PT's Concluídas" value={statConcluidas.toString()} accent="text-white" sub={`${partyStats.falhadas} falha(s) no período`} title={tt.concluidas} />

        {/* Personagens */}
        <HeroCard icon={<Users size={13} className="text-sky-400" />} label="Personagens" value={stats.totalCharacters.toString()} accent="text-white" sub={`${stats.ativos} disponíveis · ${stats.vendidos} vendidos`} title={`${tt.ativos}\n\n${tt.vendidos}`} />
      </div>

      {/* ═══════════ SECUNDÁRIO: Médias Financeiras + Relatório de PT's ═══════════ */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-2 items-stretch">
        <Section title="Médias Financeiras" icon={<Award size={12} className="text-amber-400" />}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            <StatRow label="Lucro Médio SW" value={moneyAvg(stats.dropSWAvg.avg)} title={tt.medDropSW} />
            <StatRow label="Lucro Médio SG" value={moneyAvg(stats.dropBakraAvg.avg)} title={tt.medDropSG} />
            <StatRow label="Lucro Médio GB" value={moneyAvg(stats.dropCryptAvg.avg)} title={tt.medDropCrypt} />
            <StatRow label="Custo Médio / Personagem" value={moneyAvg(stats.valorPagoAvg.avg)} title={tt.custoUnit} />
            <StatRow label="Venda Média / Personagem" value={moneyAvg(stats.valorVendaAvg.avg)} title={tt.vendaUnit} />
            <StatRow label="Resultado Médio / Personagem" value={moneyAvg(stats.lucroMedio.avg)} valueColor={stats.lucroMedio.avg >= 0 ? "text-emerald-400" : "text-rose-400"} title={tt.resultadoMedio} />
            <StatRow label="Desvalorização (Bazar)" value={`${stats.desvalorizacaoMedia.toFixed(1)}%`} valueColor={stats.desvalorizacaoMedia >= 0 ? "text-emerald-400" : "text-rose-400"} title={tt.desvalorizacao} />
          </div>
        </Section>

        <Section title="Relatório de PT's" icon={<Layers size={12} className="text-yellow-400" />}>
          <div className="grid grid-cols-2 gap-1.5">
            <div className="grid grid-cols-2 gap-1.5">
              <MiniStat label="Concluídas" value={statConcluidas} color="text-emerald-400" title={tt.concluidas} />
              <MiniStat label="Falhas" value={partyStats.falhadas} color="text-rose-400" title={tt.falhas} />
              <MiniStat label="Pagas" value={partyStats.pagas} color="text-sky-400" title={tt.pagas} />
              <MiniStat label="Em aberto" value={partyStats.ativas} color="text-amber-400" title={tt.aberto} />
            </div>
            <div className="flex flex-col gap-1.5 justify-center">
              <PartyTypeBar label="Soulwar" count={statSoulwar} total={statConcluidas || partyStats.total} color="bg-slate-500" title={tt.volSoulwar} />
              <PartyTypeBar label="Sanguine" count={statSanguine} total={statConcluidas || partyStats.total} color="bg-rose-600" title={tt.volSanguine} />
              <div className={`flex items-center justify-between rounded-md bg-black/20 border ${GOLD_BORDER} ${GOLD_BORDER_HOVER} px-2 py-1 transition-colors`} title={tt.compraDia}>
                <span className="text-[8px] uppercase text-slate-500 font-bold flex items-center gap-1"><Users size={10} /> Média de compra/dia</span>
                <span className="text-[10px] text-slate-200 font-bold tabular-nums">{avgPurchasePerDay.toFixed(2)}</span>
              </div>
              <div className={`flex items-center justify-between rounded-md bg-black/20 border ${GOLD_BORDER} ${GOLD_BORDER_HOVER} px-2 py-1 transition-colors`} title={tt.lucroServices}>
                <span className="text-[8px] uppercase text-slate-500 font-bold flex items-center gap-1"><Briefcase size={10} /> Lucro de Services</span>
                <span className={`text-[10px] font-bold tabular-nums ${serviceProfit >= 0 ? "text-emerald-300" : "text-rose-400"}`}>{money(serviceProfit)}</span>
              </div>
              <div className={`flex items-center justify-between rounded-md bg-black/20 border ${GOLD_BORDER} ${GOLD_BORDER_HOVER} px-2 py-1 transition-colors`} title="Valores registrados para personagens adquiridos temporariamente em PTs.">
                <span className="text-[8px] uppercase text-slate-500 font-bold flex items-center gap-1"><Briefcase size={10} /> Adquiridos</span>
                <span className="text-[10px] text-violet-200 font-bold tabular-nums">{stats.acquisitionFinance.visibleCount} · {money(stats.acquisitionFinance.net)}</span>
              </div>
              <div className={`flex items-center justify-between rounded-md bg-black/20 border ${GOLD_BORDER} ${GOLD_BORDER_HOVER} px-2 py-1 transition-colors`} title={tt.ptsDia}>
                <span className="text-[8px] uppercase text-slate-500 font-bold flex items-center gap-1"><Activity size={10} /> PT's/Dia</span>
                <span className="text-[10px] text-slate-200 font-bold tabular-nums">{statFreqPorDia.toFixed(2)}</span>
              </div>
            </div>
          </div>
        </Section>
      </div>

      {/* ═══════════ SERVIDOR ═══════════ */}
      <div className="rounded-xl border border-[var(--th-line)]/30 bg-[var(--th-bg-base)] px-2.5 py-2">
        <div className="flex items-center justify-between border-b border-[var(--th-line)]/20 pb-1.5 mb-2">
          <div className="text-[9px] font-black uppercase tracking-wider text-slate-200 flex items-center gap-1.5">
            <ServerIcon size={12} className="text-amber-500" /> Servidor
          </div>
          <div className="text-[9px] font-bold text-slate-500 uppercase bg-black/30 px-1.5 py-px rounded">{serverStats.length} servidor(es)</div>
        </div>

        {serverStats.length === 0 ? (
          <div className="text-center text-slate-600 italic text-[10px] py-4">Nenhuma PT concluída nos filtros atuais.</div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-1.5">
            {serverStats.map((s) => (
              <div key={s.srv} className="rounded-lg border border-[var(--th-line)]/20 bg-black/20 px-2.5 py-2 flex flex-col gap-1 transition-colors hover:border-amber-500/30" title={`${s.srv}\n\nPT's concluídas: ${s.ptCount}\nLucro médio por personagem: ${moneyAvg(s.avgProfit)}\nLucro total: ${money(s.totalProfit)}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-black text-slate-100 truncate">{s.srv}</span>
                  <span className="flex-shrink-0 text-[9px] font-bold text-slate-400 tabular-nums bg-white/[0.04] border border-white/10 px-1.5 py-px rounded-full">{s.ptCount} PT{s.ptCount !== 1 ? "s" : ""}</span>
                </div>
                <div className="grid grid-cols-2 gap-x-2 gap-y-1 mt-1">
                  <div className="flex flex-col">
                    <span className="text-[7px] uppercase tracking-wider text-slate-500 font-bold">Lucro médio/personagem</span>
                    <span className={`text-[11px] font-black tabular-nums ${s.avgProfit >= 0 ? "text-emerald-400" : "text-rose-400"}`}>{moneyAvg(s.avgProfit)}</span>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-[7px] uppercase tracking-wider text-slate-500 font-bold">Lucro total</span>
                    <span className={`text-[11px] font-black tabular-nums ${s.totalProfit >= 0 ? "text-emerald-400" : "text-rose-400"}`}>{money(s.totalProfit)}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ═══════════ DROPS | PARCEIROS ═══════════ */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-2 items-stretch">
        <ItemSection title="Drop Soulwar" list={itemStats.swList} masterList={SOULWAR_ITEMS} total={itemStats.totalSW} type="sw" />
        <ItemSection title="Drop Sanguine" list={itemStats.sgList} masterList={SANGUINE_ITEMS} total={itemStats.totalSG} type="sg" />
        <ItemSection title="Drop GB" list={itemStats.cryptList} masterList={CRYPT_ITEMS} total={itemStats.totalCrypt} type="crypt" />
        <PartnerSection title="Parceiros de Quest (Top 5)" partners={displayPartners} />
      </div>

      {baseFiltered.length === 0 && (
        <div className="flex-1 flex items-center justify-center text-slate-600 text-sm italic py-6 border border-dashed border-[var(--th-line)]/30 rounded-xl">Nenhum personagem corresponde aos filtros.</div>
      )}
    </div>
  );
}

// ============================================================================
// Componentes de apresentação
// ============================================================================

/** Agrupador visual de uma CATEGORIA do quadro de filtros. */
function StatsFilterBox({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="flex-1 min-w-[230px] rounded-lg border border-[var(--th-line)]/50 bg-black/20 px-2.5 py-2">
      <div className="flex items-center gap-1 text-[8px] font-black uppercase tracking-widest text-amber-400/80 mb-1.5 border-b border-[var(--th-line)]/30 pb-1 cursor-help" title={hint}>
        {title}
        <HelpCircle size={9} className="text-slate-600" />
      </div>
      <div className="flex flex-wrap items-end gap-x-3 gap-y-1.5">{children}</div>
    </div>
  );
}

/** Campo de FAIXA mín/máx (inteiros ≥ 0; vazio = sem limite no lado). */
function StatsRangeField({ label, range, onChange, hint }: {
  label: string;
  range: NumRange;
  onChange: (next: NumRange) => void;
  hint: string;
}) {
  const parse = (text: string): number | null => {
    if (text.trim() === "") return null;
    const value = Math.floor(Number(text));
    return Number.isFinite(value) ? Math.max(0, value) : null;
  };
  const active = rangeOn(range);
  const inputClass = (filled: boolean) =>
    `h-7 w-16 rounded-md border bg-black/30 px-1.5 text-[10px] outline-none focus:border-amber-400/60 transition-colors `
    + (filled ? "border-amber-400/50 text-amber-200 font-bold" : "border-[var(--th-line)]/60 text-slate-200");
  return (
    <div className="flex flex-col gap-0.5" title={hint}>
      <span className={`inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wide cursor-help ${active ? "text-amber-300" : "text-slate-400"}`}>
        {label}
        <HelpCircle size={9} className="text-slate-500" />
      </span>
      <div className="flex items-center gap-1">
        <input
          type="number" inputMode="numeric" min={0} placeholder="mín."
          value={range.min ?? ""}
          onChange={(e) => onChange({ ...range, min: parse(e.target.value) })}
          className={inputClass(range.min !== null)}
        />
        <span className="text-[9px] text-slate-600">–</span>
        <input
          type="number" inputMode="numeric" min={0} placeholder="máx."
          value={range.max ?? ""}
          onChange={(e) => onChange({ ...range, max: parse(e.target.value) })}
          className={inputClass(range.max !== null)}
        />
      </div>
    </div>
  );
}

function HeroCard({ icon, label, value, accent, sub, title }: { icon: React.ReactNode; label: string; value: string; accent: string; sub?: string; title?: string }) {
  return (
    <div className="rounded-xl border border-amber-600/25 bg-[var(--th-bg-base)] px-3 py-2.5 flex flex-col justify-center min-w-0" title={title}>
      <div className="flex items-center gap-1.5 text-[8px] uppercase tracking-wider text-slate-500 font-bold mb-1">{icon} {label}</div>
      <div className={`text-2xl font-black tabular-nums leading-none ${accent}`}>{value}</div>
      {sub && <div className="mt-1 text-[9px] text-slate-500 truncate">{sub}</div>}
    </div>
  );
}

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[var(--th-line)]/30 bg-[var(--th-bg-base)] px-2.5 py-2 flex flex-col gap-1.5 h-full overflow-hidden">
      <div className="flex items-center gap-1.5 text-[9px] uppercase tracking-wider text-slate-200 font-black border-b border-[var(--th-line)]/25 pb-1.5 flex-shrink-0">
        <span className="w-0.5 h-3 rounded-full bg-gradient-to-b from-[var(--th-brand-mid)] to-[var(--th-line)] flex-shrink-0" />
        {icon} {title}
      </div>
      <div className="flex-1 flex flex-col">{children}</div>
    </div>
  );
}

function StatRow({ label, value, valueColor, title }: { label: string; value: string; valueColor?: string; title?: string }) {
  return (
    <div className={`flex items-center justify-between rounded-md bg-black/25 border ${GOLD_BORDER} ${GOLD_BORDER_HOVER} px-2 py-1.5 gap-2 hover:bg-[var(--th-line)]/[0.06] transition-colors`} title={title}>
      <div className="text-[8px] text-slate-400 font-bold uppercase truncate">{label}</div>
      <div className={`text-[10px] font-black tabular-nums whitespace-nowrap ${valueColor || "text-slate-100"}`}>{value}</div>
    </div>
  );
}

function MiniStat({ label, value, color, title }: { label: string; value: number; color: string; title?: string }) {
  return (
    <div className={`bg-black/25 border ${GOLD_BORDER} ${GOLD_BORDER_HOVER} rounded-md px-1 py-1.5 text-center flex flex-col justify-center transition-colors`} title={title}>
      <div className="text-[7px] uppercase tracking-wider text-slate-500 font-bold leading-none mb-1">{label}</div>
      <div className={`text-lg font-black tabular-nums ${color} leading-none`}>{value}</div>
    </div>
  );
}

function PartyTypeBar({ label, count, total, color, title }: { label: string; count: number; total: number; color: string; title?: string }) {
  const pct = total > 0 ? (count / total) * 100 : 0;
  return (
    <div className={`bg-black/20 rounded-md px-2 py-1 border ${GOLD_BORDER} ${GOLD_BORDER_HOVER} transition-colors`} title={title}>
      <div className="flex items-center justify-between mb-px">
        <span className="text-[8px] font-black uppercase text-slate-400 tracking-tighter">{label}</span>
        <span className="text-[8px] text-white font-bold tabular-nums">{count} <span className="text-slate-500 font-normal">({pct.toFixed(0)}%)</span></span>
      </div>
      <div className="h-0.5 bg-black/50 rounded-full overflow-hidden">
        <div className={`h-full ${color} transition-all duration-700`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function ItemSection({ title, list, masterList, total, type }: { title: string; list: [string, number][]; masterList: string[]; total: number; type: "sw" | "sg" | "crypt" }) {
  const fullList = useMemo(() => {
    const map = new Map(list);
    const priorityList = type === "sw" ? SW_PRIORITY : type === "crypt" ? CRYPT_PRIORITY : SG_PRIORITY;
    return masterList.map(name => ({ name, count: map.get(name) || 0 })).sort((a, b) => {
      const colorA = ITEM_COLORS[a.name];
      const colorB = ITEM_COLORS[b.name];
      const pA = priorityList.indexOf(colorA);
      const pB = priorityList.indexOf(colorB);
      if (pA !== pB) return (pA === -1 ? 999 : pA) - (pB === -1 ? 999 : pB);
      return b.count - a.count || a.name.localeCompare(b.name);
    });
  }, [list, masterList, type]);

  return (
    <div className="bg-[var(--th-bg-base)] border border-[var(--th-line)]/30 rounded-xl px-2 py-1.5 flex flex-col h-[280px]" title={`LISTA DE ${title.toUpperCase()}\n\nExibe todos os itens possíveis da quest, ordenados por raridade (cor).\nA contagem indica quantos drops daquele item específico você obteve no período filtrado.`}>
      <div className="flex items-center justify-between border-b border-[var(--th-line)]/20 pb-1 mb-1.5 px-0.5">
        <div className="text-[9px] font-black uppercase tracking-wider text-slate-300 flex items-center gap-1.5"><Package size={11} className="text-amber-500" /> {title}</div>
        <div className="text-[9px] font-bold tabular-nums text-slate-500 uppercase bg-black/30 px-1 py-px rounded" title={`Total de ${total} drops registrados nesta categoria.`}>{total} drops</div>
      </div>
      <div className="flex-1 overflow-y-auto pr-1 custom-scrollbar grid grid-cols-2 gap-x-1.5 gap-y-px content-start">
        {fullList.map((item) => {
          const pct = total > 0 ? (item.count / total) * 100 : 0;
          const color = ITEM_COLORS[item.name] || "#64748b";
          const hasDrop = item.count > 0;
          return (
            <div key={item.name} className="flex items-center gap-1 py-0.5 px-1 rounded-sm border border-[var(--th-line)]/15 bg-black/15 hover:bg-[var(--th-line)]/10 transition-all group" style={{ borderColor: hasDrop ? color + '40' : undefined }} title={`${item.name}\n\nQuantidade dropada: ${item.count}\n${hasDrop ? `Representa ${pct.toFixed(1)}% dos drops desta categoria.` : "Ainda não dropado pelos seus personagens."}`}>
              <div className={`text-[9px] truncate flex-1 font-medium ${hasDrop ? "" : "text-slate-600"}`} style={{ color: hasDrop ? color : undefined }}>{item.name}</div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <span className={`text-[9px] font-mono w-3 text-right font-bold ${hasDrop ? "text-white" : "text-slate-700"}`}>{item.count}</span>
                <div className="w-5 h-1 bg-black/40 rounded-full overflow-hidden"><div className={`h-full transition-all`} style={{ width: `${Math.max(hasDrop ? 10 : 0, pct)}%`, backgroundColor: color, opacity: hasDrop ? 1 : 0.2 }} /></div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PartnerSection({ title, partners }: { title: string; partners: [string, number][] }) {
  return (
    <div className="bg-[var(--th-bg-base)] border border-[var(--th-line)]/30 rounded-xl px-2 py-1.5 flex flex-col h-[280px]" title="PARCEIROS DE QUEST&#10;&#10;Top 5 jogadores que mais participaram de PT's concluídas com você.">
      <div className="flex items-center justify-between border-b border-[var(--th-line)]/20 pb-1 mb-1.5 px-0.5">
        <div className="text-[9px] font-black uppercase tracking-wider text-slate-300 flex items-center gap-1.5"><Trophy size={11} className="text-violet-500" /> {title}</div>
        <div className="text-[9px] font-bold tabular-nums text-slate-500 uppercase bg-black/30 px-1 py-px rounded">{partners.length} parceiros</div>
      </div>
      <div className="flex-1 overflow-y-auto pr-1 custom-scrollbar grid grid-cols-1 gap-1 content-start">
        {partners.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-slate-600 text-[10px] italic">Nenhuma quest concluída com parceiros.</div>
        ) : (
          partners.map(([name, count], idx) => (
            <div key={name} className="flex items-center gap-2 py-1 px-1.5 bg-black/15 rounded-md border border-[var(--th-line)]/15 hover:border-violet-500/25 transition-colors" title={`${name}\n\nParticipou de ${count} PT(s) concluída(s) com você.\nPosição no ranking: #${idx + 1}`}>
              <div className="flex items-center justify-center w-5 h-5 rounded-full bg-violet-500/20 text-violet-400 text-[9px] font-bold border border-violet-500/30">
                #{idx + 1}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[10px] font-bold text-slate-200 truncate flex items-center gap-1">
                  <UserPlus size={10} className="text-slate-500" /> {name}
                </div>
                <div className="text-[8px] text-slate-500 uppercase font-bold tracking-wider mt-0.5">Quests Concluídas</div>
              </div>
              <div className="text-sm font-black text-violet-400 tabular-nums bg-violet-500/10 px-1.5 py-0.5 rounded border border-violet-500/20">
                {count}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}