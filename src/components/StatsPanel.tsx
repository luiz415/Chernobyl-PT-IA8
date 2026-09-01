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
} from "lucide-react";
import type { Character, CharacterAcquisition, CharacterAcquisitionBuyerDetails, NegotiationTimestamp, PartyTab, PtType, SharedService } from "../types";
import { serverLabel } from "../constants/servers";
import { formatRC } from "../types";
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
};

const SW_PRIORITY = [
  "#22c55e", "#4ade80", "#86efac", "#a3e635", "#eab308",
  "#f97316", "#ef4444", "#dc2626",
];

const SG_PRIORITY = [
  "#fbbf24", "#22c55e", "#4ade80", "#86efac", "#a3e635",
  "#eab308", "#f97316", "#ef4444", "#dc2626",
];

const GOLD_BORDER = "border-amber-600/25";
const GOLD_BORDER_HOVER = "hover:border-amber-500/45";

type ValueFilter = {
  valorPago: boolean;
  dropSW: boolean;
  dropBakra: boolean;
  valorVenda: boolean;
};

type StatusFilter = {
  ativos: boolean;
  historico: boolean;
};

type PeriodKey = "week" | "month" | "lastmonth" | "3m" | "6m" | "year" | "all";

const DEFAULT_VALUE_FILTER: ValueFilter = {
  valorPago: true,
  dropSW: true,
  dropBakra: true,
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
function getPeriodRange(period: PeriodKey, now = Date.now()): { start: number; end: number } | null {
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

export default function StatsPanel({ characters, parties = [], userName = "", userStats = null, userNames = {}, services = [], characterAcquisitions = [], characterAcquisitionBuyerDetails = [], currentUserUid = "" }: Props) {
  const [totalVisible, setTotalVisible] = usePersistedState("stats_totalVisible", true);
  const [valueFilter, setValueFilter] = usePersistedState<ValueFilter>("stats_value_filter", DEFAULT_VALUE_FILTER);
  const [statusFilter, setStatusFilter] = usePersistedState<StatusFilter>("stats_statusFilter", DEFAULT_STATUS);
  const [period, setPeriod] = usePersistedState<PeriodKey>("stats_period_v2", "all");
  // "Apenas personagens completos" — filtra para personagens com Custo preenchido
  // e pelo menos um dos lucros (SW ou SG). Integrado à mesma lógica centralizada
  // de filtragem (baseFiltered). Marcada POR PADRÃO (true) para novos usuários;
  // a escolha do usuário é persistida em localStorage ("stats_only_complete").
  const [onlyComplete, setOnlyComplete] = usePersistedState<boolean>("stats_only_complete", true);

  // ── Período resolvido (null = "Tudo") ────────────────────────────────────
  const periodRange = useMemo(() => getPeriodRange(period), [period]);

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
        // Completo = Custo preenchido E pelo menos um dos lucros (SW ou SG).
        const hasCost = (c.valorPago || 0) > 0;
        const hasAnyProfit = (c.dropSW || 0) > 0 || (c.dropBakra || 0) > 0;
        if (!hasCost || !hasAnyProfit) return false;
      }
      return true;
    });
  }, [characters, negotiatedOriginalCharacterIds, statusFilter, periodRange, onlyComplete]);

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
    let saleRevenue = 0;
    let visibleCount = 0;
    let buyerActiveCount = 0;
    let buyerSoldCount = 0;
    const acquisitionCostValues: number[] = [];
    const saleValueValues: number[] = [];
    const questProfitSWValues: number[] = [];
    const questProfitSGValues: number[] = [];
    const netEntries: number[] = [];
    const buyerEntries: BuyerEntry[] = [];

    const buyerDetailsByAcquisition = new Map(characterAcquisitionBuyerDetails.map(detail => [detail.acquisitionId, detail]));
    characterAcquisitions.forEach(record => {
      const isAcquirer = record.acquirerUid === currentUserUid;
      // O dono original acompanha a negociação na guia Vendidos, mas o
      // personagem não entra em nenhuma métrica dele. Só a perspectiva do
      // adquirente é incorporada às Stats financeiras/operacionais.
      if (!isAcquirer) return;
      visibleCount += 1;

      const paid = !!record.paymentConfirmedAt || ["payment_confirmed", "quest_completed", "for_sale", "sold", "created"].includes(record.status);
      const paymentAt = record.paymentConfirmedAt || record.createdAt;
      if (!paid || !inRange(paymentAt)) return;
      if (record.status === "sold") buyerSoldCount += 1; else buyerActiveCount += 1;

      const buyerDetails = buyerDetailsByAcquisition.get(record.id);
      const questType = buyerDetails?.questType || record.questType;
      const normalizedQuestType: PtType | undefined = questType === "soulwar" || questType === "sanguine" ? questType : undefined;
      const hasQuestInRange = !!buyerDetails && inRange(buyerDetails.questCompletedAt || buyerDetails.updatedAt);
      const privateQuestProfit = hasQuestInRange ? (buyerDetails?.questProfit || 0) : 0;
      const saleValue = record.saleValue !== undefined && inRange(record.soldAt || record.updatedAt) ? (record.saleValue || 0) : 0;
      const questIsIncluded = normalizedQuestType === "soulwar" ? valueFilter.dropSW : normalizedQuestType === "sanguine" ? valueFilter.dropBakra : false;
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
      questProfitSWValues,
      questProfitSGValues,
      saleRevenue,
      saleValueValues,
      netEntries,
      buyerEntries,
      net: sum(netEntries),
    };
  }, [characterAcquisitions, characterAcquisitionBuyerDetails, currentUserUid, periodRange, valueFilter]);

  // ── Cálculos financeiros (personagens + negociações) ─────────────────────
  const stats = useMemo(() => {
    const ativos = baseFiltered.filter((c) => !c.vendido);
    const vendidos = baseFiltered.filter((c) => c.vendido);
    const dropSWAvg = avgNonZero([...baseFiltered.map((c) => c.dropSW), ...acquisitionFinance.questProfitSWValues]);
    const dropBakraAvg = avgNonZero([...baseFiltered.map((c) => c.dropBakra), ...acquisitionFinance.questProfitSGValues]);
    const valorPagoAvg = avgNonZero([...baseFiltered.map((c) => c.valorPago), ...acquisitionFinance.acquisitionCostValues]);
    const valorVendaAvg = avgNonZero([...vendidos.map((c) => c.valorVenda), ...acquisitionFinance.saleValueValues]);
    const totalInvestido = sum(baseFiltered.map((c) => c.valorPago)) + acquisitionFinance.acquisitionCost;
    const totalDropSW = sum(baseFiltered.map((c) => c.dropSW)) + acquisitionFinance.questProfitSW;
    const totalDropBakra = sum(baseFiltered.map((c) => c.dropBakra)) + acquisitionFinance.questProfitSG;
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
      dropSWAvg, dropBakraAvg, valorPagoAvg, valorVendaAvg,
      totalInvestido, totalDropSW, totalDropBakra, totalVendas,
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
        const ts = p.archivedAt || p.ptStartedAt || p.createdAt || 0;
        if (!ts || ts < periodRange.start || ts > periodRange.end) return false;
      }
      return true;
    });
  }, [parties, characters, negotiatedOriginalCharacterIds, userName, periodRange]);

  const completedParties = useMemo(
    () => partyBase.filter((p) => p.questConcluida && !p.questFalha),
    [partyBase],
  );

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
    const scoped = periodRange
      ? services.filter((s) => s.status === "realizado"
          && (s.completedAt || s.updatedAt || 0) >= periodRange.start
          && (s.completedAt || s.updatedAt || 0) <= periodRange.end)
      : services;
    return sumServiceProfit(scoped);
  }, [services, periodRange]);

  // ── MIGRAÇÃO PARCIAL — userStats (estatísticas persistentes no Firestore) ─
  // Quando o documento userStats/{uid} existe, PT's concluídas / Soulwar /
  // Sanguine usam os valores PERSISTIDOS; caso contrário, recalcula das PTs.
  const hasNegotiatedParticipation = characterAcquisitions.some(record =>
    record.originalOwnerUid === currentUserUid || record.acquirerUid === currentUserUid,
  );
  // Os buckets históricos não guardam a perspectiva financeira do slot. Quando
  // há negociação, derivamos as PTs atuais para reconhecer o JOGADOR/adquirente
  // e excluir corretamente o DONO original.
  const hasPersistedStats = !!userStats && typeof userStats.totalPtsConcluidas === "number" && !hasNegotiatedParticipation;

  // PT's concluídas PERÍODO-CIENTES via userStats.dailyStats (doc já assinado
  // via onSnapshot — ZERO leituras extras de Firestore):
  //   • Período "Tudo" (sem periodRange): usa o contador vitalício (bate com a
  //     soma acumulada).
  //   • Período selecionado: agrega os buckets diários cujo dia cai no intervalo
  //     (considera qualquer quest — Soulwar e Sanguine juntos).
  //   • Sem dailyStats (simulação/pré-migração): cai no cálculo derivado das PTs.
  const periodDailyStats = useMemo(() => {
    const daily = userStats?.dailyStats;
    if (!hasPersistedStats || !daily || !periodRange) return null;
    const acc = { totalPtsConcluidas: 0, totalPtsSoulwar: 0, totalPtsSanguine: 0 };
    Object.entries(daily).forEach(([dayKey, bucket]) => {
      const dayTs = Date.parse(`${dayKey}T00:00:00Z`);
      if (Number.isNaN(dayTs)) return;
      if (dayTs < periodRange.start || dayTs > periodRange.end) return;
      acc.totalPtsConcluidas += bucket?.totalPtsConcluidas || 0;
      acc.totalPtsSoulwar += bucket?.totalPtsSoulwar || 0;
      acc.totalPtsSanguine += bucket?.totalPtsSanguine || 0;
    });
    return acc;
  }, [hasPersistedStats, userStats?.dailyStats, periodRange]);

  const statConcluidas = !hasPersistedStats
    ? partyStats.concluidas
    : (periodRange
        ? (periodDailyStats?.totalPtsConcluidas ?? partyStats.concluidas)
        : (userStats!.totalPtsConcluidas || 0));
  const statSoulwar = !hasPersistedStats
    ? partyStats.soulwar
    : (periodRange
        ? (periodDailyStats?.totalPtsSoulwar ?? partyStats.soulwar)
        : (userStats!.totalPtsSoulwar || 0));
  const statSanguine = !hasPersistedStats
    ? partyStats.sanguine
    : (periodRange
        ? (periodDailyStats?.totalPtsSanguine ?? partyStats.sanguine)
        : (userStats!.totalPtsSanguine || 0));

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

  // ── Drops (Soulwar / Sanguine) ───────────────────────────────────────────
  const itemStats = useMemo(() => {
    const swCounts: Record<string, number> = {};
    const sgCounts: Record<string, number> = {};
    SOULWAR_ITEMS.forEach((item) => { swCounts[item] = 0; });
    SANGUINE_ITEMS.forEach((item) => { sgCounts[item] = 0; });
    baseFiltered.forEach((c) => {
      if (c.itemDropadoSW && swCounts[c.itemDropadoSW] !== undefined) swCounts[c.itemDropadoSW]++;
      if (c.itemDropadoSG && sgCounts[c.itemDropadoSG] !== undefined) sgCounts[c.itemDropadoSG]++;
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

    const getPriority = (itemName: string, isSanguine: boolean) => {
      const color = ITEM_COLORS[itemName];
      const list = isSanguine ? SG_PRIORITY : SW_PRIORITY;
      const idx = list.indexOf(color);
      return idx === -1 ? 999 : idx;
    };

    const sortSW = (a: [string, number], b: [string, number]) => {
      const pA = getPriority(a[0], false);
      const pB = getPriority(b[0], false);
      if (pA !== pB) return pA - pB;
      return b[1] - a[1] || a[0].localeCompare(b[0]);
    };

    const sortSG = (a: [string, number], b: [string, number]) => {
      const pA = getPriority(a[0], true);
      const pB = getPriority(b[0], true);
      if (pA !== pB) return pA - pB;
      return b[1] - a[1] || a[0].localeCompare(b[0]);
    };

    return {
      swList: Object.entries(swCounts).sort(sortSW),
      sgList: Object.entries(sgCounts).sort(sortSG),
      totalSW: sum(Object.values(swCounts)), totalSG: sum(Object.values(sgCounts)),
    };
  }, [acquisitionFinance.buyerEntries, baseFiltered]);

  // ── Parceiros de Quest (persistidos por UID, senão recalculados) ────────
  const partnerStats = useMemo(() => {
    const userCharIds = new Set(characters.filter((c) => !negotiatedOriginalCharacterIds.has(c.id)).map((c) => c.id));
    const userParties = parties.filter((p) => {
      if (userName && p.createdByName === userName) return true;
      if (p.selectedIds.some((id) => userCharIds.has(id))) return true;
      if (userName) {
        const sd = p.slotData || {};
        return Object.values(sd).some((slot) =>
          (slot.isService === true || !!slot.characterAcquisitionId)
          && (slot.player || "") === userName
        );
      }
      return false;
    });
    const completedPartiesLocal = userParties.filter((p) => p.questConcluida && !p.questFalha);

    const partners: Record<string, number> = {};
    completedPartiesLocal.forEach((p) => {
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
  }, [parties, characters, negotiatedOriginalCharacterIds, userName]);

  const displayPartners = useMemo<[string, number][]>(() => {
    const persisted = userStats?.partners;
    if (hasPersistedStats && persisted && Object.keys(persisted).length > 0) {
      return Object.entries(persisted)
        .map(([uid, count]) => [userNames[uid] || `Usuário ${uid.slice(0, 6)}…`, count] as [string, number])
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);
    }
    return partnerStats;
  }, [hasPersistedStats, userStats?.partners, userNames, partnerStats]);

  const resetAllFilters = () => {
    setValueFilter(DEFAULT_VALUE_FILTER);
    setStatusFilter(DEFAULT_STATUS);
    setPeriod("all");
    setOnlyComplete(false);
  };

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
      {/* ═══════════ HEADER + FILTROS (sempre visíveis) ═══════════ */}
      <div className="sticky top-0 z-20 bg-[var(--th-n-base)] border-b border-[var(--th-line)]/50 pb-2 pt-1">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BarChart3 size={15} className="text-amber-500/90" />
            <span className="text-sm font-bold text-white uppercase tracking-tight">Estatísticas</span>
          </div>
          <button onClick={resetAllFilters} className="inline-flex items-center gap-1 rounded-md border border-[var(--th-line)]/40 bg-[var(--th-bg-base)] px-2 py-1 text-[9px] font-bold text-slate-400 transition-colors hover:bg-[var(--th-line)]/15 hover:text-slate-200" title="Restaurar todos os filtros">
            <RotateCcw size={10} /> Resetar
          </button>
        </div>

        <div className="mt-2 flex flex-wrap items-end gap-x-5 gap-y-2">
          {/* Período */}
          <div className="flex flex-col gap-1">
            <span className="text-[8px] uppercase tracking-wider text-slate-500 font-bold">Período</span>
            <div className="flex flex-wrap gap-1">
              {PERIODS.map((p) => (
                <button key={p.key} onClick={() => setPeriod(p.key)} className={`px-1.5 py-0.5 rounded-md text-[9px] font-bold border transition-all ${period === p.key ? pillActive : pillIdle}`}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <span className="hidden lg:block w-px self-stretch bg-[var(--th-line)]/30" />

          {/* Status */}
          <div className="flex flex-col gap-1">
            <span className="text-[8px] uppercase tracking-wider text-slate-500 font-bold">Status</span>
            <div className="flex gap-1">
              <button onClick={() => setStatusFilter((f) => ({ ...f, ativos: !f.ativos }))} className={`px-2 py-0.5 rounded-md text-[9px] font-bold border transition-all ${statusFilter.ativos ? "border-sky-500/60 bg-sky-500/20 text-sky-300" : pillIdle}`}>Disponíveis</button>
              <button onClick={() => setStatusFilter((f) => ({ ...f, historico: !f.historico }))} className={`px-2 py-0.5 rounded-md text-[9px] font-bold border transition-all ${statusFilter.historico ? "border-amber-500/60 bg-amber-500/20 text-amber-300" : pillIdle}`}>Vendidos</button>
            </div>
          </div>

          <span className="hidden lg:block w-px self-stretch bg-[var(--th-line)]/30" />

          {/* Apenas completos */}
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

          {/* Cálculo */}
          <div className="flex flex-col gap-1">
            <span className="text-[8px] uppercase tracking-wider text-slate-500 font-bold">Cálculo</span>
            <div className="flex gap-1">
              <button onClick={() => setValueFilter((f) => ({ ...f, valorPago: !f.valorPago }))} className={`px-2 py-0.5 rounded-md text-[9px] font-bold border transition-all ${valueFilter.valorPago ? "border-rose-500/60 bg-rose-500/20 text-rose-300" : `${pillIdle} opacity-50`}`} title="Custo (subtrai)">Custo</button>
              <button onClick={() => setValueFilter((f) => ({ ...f, dropSW: !f.dropSW }))} className={`px-2 py-0.5 rounded-md text-[9px] font-bold border transition-all ${valueFilter.dropSW ? "border-purple-500/60 bg-purple-500/20 text-purple-300" : `${pillIdle} opacity-50`}`} title="Drop SW (soma)">Drop SW</button>
              <button onClick={() => setValueFilter((f) => ({ ...f, dropBakra: !f.dropBakra }))} className={`px-2 py-0.5 rounded-md text-[9px] font-bold border transition-all ${valueFilter.dropBakra ? "border-orange-500/60 bg-orange-500/20 text-orange-300" : `${pillIdle} opacity-50`}`} title="Drop SG (soma)">Drop SG</button>
              <button onClick={() => setValueFilter((f) => ({ ...f, valorVenda: !f.valorVenda }))} className={`px-2 py-0.5 rounded-md text-[9px] font-bold border transition-all ${valueFilter.valorVenda ? "border-emerald-500/60 bg-emerald-500/20 text-emerald-300" : `${pillIdle} opacity-50`}`} title="Venda (soma)">Venda</button>
            </div>
          </div>
        </div>
      </div>

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
            Custos {money(stats.totalInvestido)} · Drops {money(stats.totalDropSW + stats.totalDropBakra)} · Vendas {money(stats.totalVendas)}
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
            <StatRow label="Custo Médio / Personagem" value={moneyAvg(stats.valorPagoAvg.avg)} title={tt.custoUnit} />
            <StatRow label="Venda Média / Personagem" value={moneyAvg(stats.valorVendaAvg.avg)} title={tt.vendaUnit} />
            <StatRow label="Resultado Médio / Personagem" value={moneyAvg(stats.lucroMedio.avg)} valueColor={stats.lucroMedio.avg >= 0 ? "text-emerald-400" : "text-rose-400"} title={tt.resultadoMedio} />
            <StatRow label="Desvalorização (Bazar)" value={`${stats.desvalorizacaoMedia.toFixed(1)}%`} valueColor={stats.desvalorizacaoMedia >= 0 ? "text-emerald-400" : "text-rose-400"} title={tt.desvalorizacao} />
            <StatRow label="Negociações adquiridas" value={money(stats.acquisitionFinance.net)} valueColor={stats.acquisitionFinance.net >= 0 ? "text-violet-300" : "text-rose-400"} title="Saldo da perspectiva do adquirente: custo de aquisição, lucro privado da Quest e venda posterior." />
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
              <PartyTypeBar label="Soulwar" count={statSoulwar} total={hasPersistedStats ? statConcluidas : partyStats.total} color="bg-slate-500" title={tt.volSoulwar} />
              <PartyTypeBar label="Sanguine" count={statSanguine} total={hasPersistedStats ? statConcluidas : partyStats.total} color="bg-rose-600" title={tt.volSanguine} />
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
                <span className="text-[10px] text-slate-200 font-bold tabular-nums">{partyStats.freqPorDia.toFixed(2)}</span>
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
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-2 items-stretch">
        <ItemSection title="Drop Soulwar" list={itemStats.swList} masterList={SOULWAR_ITEMS} total={itemStats.totalSW} type="sw" />
        <ItemSection title="Drop Sanguine" list={itemStats.sgList} masterList={SANGUINE_ITEMS} total={itemStats.totalSG} type="sg" />
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

function ItemSection({ title, list, masterList, total, type }: { title: string; list: [string, number][]; masterList: string[]; total: number; type: "sw" | "sg" }) {
  const fullList = useMemo(() => {
    const map = new Map(list);
    const priorityList = type === "sw" ? SW_PRIORITY : SG_PRIORITY;
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