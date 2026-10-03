import { useMemo, useSyncExternalStore } from "react";
import type { PartyTemplateType } from "../utils/suggestionAlgorithm";
import { loadUIState, saveUIState } from "../storage";
import { useQuestMinLevels } from "./useQuestMinLevels";

// ============================================================================
// FONTE ÚNICA DOS FILTROS
//
// Antes existiam DUAS cópias independentes do mesmo conjunto de filtros:
//   - OverviewPanel  -> "overview_panel_filters.state"
//   - BazarPanel     -> "bazar_friends_summary_filters"
//
// Ambas alimentavam o MESMO componente (OverviewFiltersModal) e o mesmo
// algoritmo (analyzeServerPotential), mas viviam separadas — alterar um lado
// não refletia no outro, e os padrões eram divergentes.
//
// Este módulo centraliza o estado num store externo consumido via
// `useSyncExternalStore`. Qualquer componente que use o hook é notificado na
// mesma renderização, então a sincronização é imediata e não exige Provider
// nem alterações na árvore do App.
// ============================================================================

export interface OverviewFiltersState {
  questFilter: "soulwar" | "sanguine" | "crypt" | "all";
  templateType: PartyTemplateType;
  minLevels: Record<string, number>;
  userMode: "any" | "filter";
  selectedUsers: string[];
  useCharacters: boolean;
  useWaitingList: boolean;
}

/**
 * Níveis mínimos padrão por vocação (conjunto ÚNICO legado).
 *
 * Continua exportado por DOIS motivos:
 *   1. MODO DEMO: o tutorial usa SEMPRE `DEFAULT_OVERVIEW_FILTERS` e os dados
 *      demonstrativos foram calibrados para estes valores — não mudar;
 *   2. normalização do estado persistido antigo (campo `minLevels` abaixo).
 *
 * FORA do demo, o valor efetivo de `minLevels` passou a ser DERIVADO da fonte
 * única POR QUEST (`useQuestMinLevels("overview")`): SW usa os níveis de Soul
 * War, SG os de Sanguine — ver `useOverviewFilters()`.
 */
export const DEFAULT_MIN_LEVELS: Record<string, number> = {
  EK: 480,
  ED: 360,
  MS: 360,
  RP: 480,
  MK: 500,
};

/**
 * Configuração padrão única — usada na primeira carga e no "Resetar filtros"
 * dos dois pontos de entrada.
 */
export const DEFAULT_OVERVIEW_FILTERS: OverviewFiltersState = {
  questFilter: "all",              // Quest Alvo: Todas
  templateType: "inteligente",     // Composição: Auto (Inteligente)
  minLevels: { ...DEFAULT_MIN_LEVELS },
  userMode: "any",
  selectedUsers: [],
  useCharacters: true,             // Origem: Disponíveis marcado
  useWaitingList: true,            // Origem: Service marcado
};

const STORAGE_KEY = "unified_overview_filters.state";

/** Normaliza o que veio do localStorage, preenchendo lacunas com o padrão. */
function normalize(raw: Partial<OverviewFiltersState> | null | undefined): OverviewFiltersState {
  const source = raw || {};
  const minLevels: Record<string, number> = { ...DEFAULT_MIN_LEVELS };
  Object.entries(source.minLevels || {}).forEach(([voc, value]) => {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) minLevels[voc] = parsed;
  });
  return {
    questFilter: (["all", "soulwar", "sanguine", "crypt"] as const).includes(source.questFilter as any)
      ? source.questFilter as OverviewFiltersState["questFilter"]
      : DEFAULT_OVERVIEW_FILTERS.questFilter,
    templateType: (source.templateType || DEFAULT_OVERVIEW_FILTERS.templateType) as PartyTemplateType,
    minLevels,
    userMode: source.userMode === "filter" ? "filter" : "any",
    selectedUsers: Array.isArray(source.selectedUsers) ? source.selectedUsers : [],
    useCharacters: source.useCharacters !== false,
    useWaitingList: source.useWaitingList !== false,
  };
}

let state: OverviewFiltersState = normalize(loadUIState<Partial<OverviewFiltersState> | null>(STORAGE_KEY, null));

const listeners = new Set<() => void>();

function emit() {
  saveUIState(STORAGE_KEY, state);
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getSnapshot(): OverviewFiltersState {
  return state;
}

/** Aplica um patch parcial. Ignora escritas que não mudam nada. */
export function patchOverviewFilters(patch: Partial<OverviewFiltersState>) {
  const next = { ...state, ...patch };
  if (
    next.questFilter === state.questFilter &&
    next.templateType === state.templateType &&
    next.minLevels === state.minLevels &&
    next.userMode === state.userMode &&
    next.selectedUsers === state.selectedUsers &&
    next.useCharacters === state.useCharacters &&
    next.useWaitingList === state.useWaitingList
  ) return;
  state = next;
  emit();
}

/** Restaura exatamente a configuração padrão. */
export function resetOverviewFilters() {
  state = { ...DEFAULT_OVERVIEW_FILTERS, minLevels: { ...DEFAULT_MIN_LEVELS }, selectedUsers: [] };
  emit();
}

/**
 * Hook compartilhado. Retorna o estado atual e setters com a MESMA assinatura
 * já esperada pelo `OverviewFiltersModal`, para reaproveitar o componente sem
 * adaptações.
 *
 * LEVEL MÍNIMO POR QUEST: `minLevels` deixou de ser um conjunto único salvo
 * aqui e passou a ser DERIVADO da fonte única por quest
 * (`useQuestMinLevels("overview")`), escolhida pela Quest Alvo:
 *   SW -> níveis de Soul War | SG -> níveis de Sanguine
 *   "Todas" -> níveis de Soul War (mesmo fallback que a análise já aplica em
 *   `questType: questFilter === "all" ? "soulwar" : questFilter`).
 * `setMinLevels` grava SOMENTE o conjunto da quest ativa — alternar a Quest
 * Alvo recupera o que está salvo para a outra, sem sobrescrever nada. Todos
 * os consumidores (Visão Geral, Resumo de Amigos, BazarPanel) continuam
 * lendo `filters.minLevels` como antes.
 */
export function useOverviewFilters() {
  const base = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const { byQuest, setForQuest, resetFeature } = useQuestMinLevels("overview");
  const activeQuest = base.questFilter === "sanguine" ? "sanguine" : base.questFilter === "crypt" ? "crypt" : "soulwar";
  const minLevels = byQuest[activeQuest];
  const filters = useMemo<OverviewFiltersState>(() => ({ ...base, minLevels }), [base, minLevels]);

  return {
    filters,
    ...filters,
    setQuestFilter: (v: OverviewFiltersState["questFilter"]) => patchOverviewFilters({ questFilter: v }),
    setTemplateType: (v: PartyTemplateType) => patchOverviewFilters({ templateType: v }),
    setMinLevels: (v: Record<string, number>) => setForQuest(activeQuest, v),
    setUserMode: (v: OverviewFiltersState["userMode"]) => patchOverviewFilters({ userMode: v }),
    setSelectedUsers: (v: string[]) => patchOverviewFilters({ selectedUsers: v }),
    setUseCharacters: (v: boolean) => patchOverviewFilters({ useCharacters: v }),
    setUseWaitingList: (v: boolean) => patchOverviewFilters({ useWaitingList: v }),
    resetFilters: () => { resetOverviewFilters(); resetFeature(); },
  };
}
