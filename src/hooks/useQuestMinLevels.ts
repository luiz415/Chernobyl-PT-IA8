import { useSyncExternalStore } from "react";
import { loadUIState, saveUIState } from "../storage";

// ============================================================================
// LEVEL MÍNIMO POR QUEST — FONTE ÚNICA
//
// Antes, cada recurso guardava UM único conjunto de níveis mínimos por
// vocação, aplicado igualmente a Soul War e Sanguine:
//   - Sugestão Automática de PT  -> "suggest_modal_prefs.minLevels"
//   - Filtros Visão Geral/Resumo -> minLevels dentro de
//                                   "unified_overview_filters.state"
//
// Este módulo passa a ser a fonte única dos níveis, agora POR QUEST:
// cada recurso ("suggest" | "overview") possui dois conjuntos independentes
// (soulwar/sanguine). Selecionar SW exibe/edita os níveis de Soul War;
// selecionar SG, os de Sanguine — sem sobrescrever a outra quest.
//
// PERSISTÊNCIA (por usuário, entre sessões e dispositivos):
//   • Cache local por uid (localStorage) — resposta imediata, offline-first;
//   • Perfil do usuário (`users/{uid}.questMinLevels`) — gravado pelo MESMO
//     `updateUserProfile` já existente no AuthContext (as regras do Firestore
//     já permitem que o dono atualize campos fora de role/status; nenhuma
//     mudança de rules). A leitura NÃO custa nada: o perfil já é carregado
//     no login. A gravação é DEBOUNCED e só acontece quando o usuário edita
//     de fato (hidratação nunca grava).
//
// MIGRAÇÃO (não sobrescrever preferências existentes):
//   • Nuvem presente -> vence (estado mais recente entre dispositivos);
//   • Sem nuvem, cache local por uid presente -> usa o cache;
//   • Sem ambos, conjunto ÚNICO legado salvo e DIFERENTE do padrão antigo
//     (ou seja, personalizado pelo usuário) -> vira o valor das DUAS quests,
//     preservando exatamente o comportamento anterior;
//   • Caso contrário -> padrões novos por quest (abaixo).
// ============================================================================

export type QuestLevelQuest = "soulwar" | "sanguine" | "crypt";
export type QuestLevelFeature = "suggest" | "overview";
export type MinLevelsRecord = Record<string, number>;
export type MinLevelsByQuest = Record<QuestLevelQuest, MinLevelsRecord>;
export type QuestMinLevelsPrefs = Record<QuestLevelFeature, MinLevelsByQuest>;
/** Forma PERSISTIDA (cache local e perfil): preferências + versão dos padrões. */
export type QuestMinLevelsStored = QuestMinLevelsPrefs & { defaultsVersion: number };

/**
 * Versão dos PADRÕES por quest. Configurações persistidas SEM esta marca (ou
 * com marca menor) passam pela correção de padrões abaixo — conjuntos nunca
 * personalizados (idênticos ao padrão da época) sobem para o padrão novo.
 * Configurações já gravadas NESTA versão nunca são "corrigidas" de novo:
 * se o usuário escolher deliberadamente valores iguais a um padrão antigo,
 * a escolha é respeitada para sempre.
 */
const DEFAULTS_VERSION = 2;

export const QUEST_LEVEL_VOCS = ["EK", "ED", "MS", "RP", "MK"] as const;

/** Padrões POR QUEST — usados apenas para quem não tem configuração salva. */
export const QUEST_MIN_LEVEL_DEFAULTS: MinLevelsByQuest = {
  soulwar: { EK: 500, ED: 400, MS: 400, RP: 500, MK: 500 },
  sanguine: { EK: 700, ED: 500, MS: 600, RP: 700, MK: 700 },
  // GB ("crypt"): padrão próprio da quest, definido pelo usuário.
  // Vale apenas para quem não tem configuração salva — editável por quest.
  crypt: { EK: 600, ED: 500, MS: 500, RP: 550, MK: 550 },
};

/**
 * Padrões POR QUEST da versão ANTERIOR deste módulo. Usados SOMENTE para a
 * correção de padrões: a hidratação sempre persistiu o conjunto em uso no
 * cache local (e qualquer edição grava TODAS as quests no perfil), então um
 * conjunto salvo IDÊNTICO ao padrão antigo significa que o usuário NUNCA o
 * personalizou — ele deve receber o padrão NOVO da quest. Conjuntos com
 * QUALQUER diferença são personalizações e permanecem intocados.
 * (Sanguine não mudou: padrão antigo = novo, upgrade é um no-op.)
 */
const PREVIOUS_QUEST_DEFAULTS: MinLevelsByQuest = {
  soulwar: { EK: 500, ED: 380, MS: 380, RP: 500, MK: 500 },
  sanguine: { EK: 700, ED: 500, MS: 600, RP: 700, MK: 700 },
  // GB nasceu espelhando os níveis do Sanguine — era o padrão antigo.
  crypt: { EK: 700, ED: 500, MS: 600, RP: 700, MK: 700 },
};

/**
 * Padrões ANTIGOS do conjunto único de cada recurso — usados SOMENTE na
 * migração: um conjunto legado salvo IGUAL ao padrão antigo significa que o
 * usuário nunca personalizou (os recursos salvavam o padrão automaticamente),
 * então ele recebe os padrões novos por quest.
 */
const LEGACY_SINGLE_DEFAULTS: Record<QuestLevelFeature, MinLevelsRecord> = {
  suggest: { EK: 500, ED: 400, MS: 400, RP: 500, MK: 600 },
  overview: { EK: 480, ED: 360, MS: 360, RP: 480, MK: 500 },
};

/** Lê o conjunto único legado de cada recurso (null quando nunca salvo). */
function readLegacySingle(feature: QuestLevelFeature): MinLevelsRecord | null {
  if (feature === "suggest") {
    return loadUIState<MinLevelsRecord | null>("suggest_modal_prefs.minLevels", null);
  }
  const raw = loadUIState<{ minLevels?: MinLevelsRecord } | null>("unified_overview_filters.state", null);
  return raw && raw.minLevels ? raw.minLevels : null;
}

function sanitizeRecord(raw: unknown, fallback: MinLevelsRecord): MinLevelsRecord {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: MinLevelsRecord = {};
  for (const voc of QUEST_LEVEL_VOCS) {
    const value = Number(source[voc]);
    out[voc] = Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback[voc];
  }
  return out;
}

function sameRecord(a: MinLevelsRecord | null | undefined, b: MinLevelsRecord): boolean {
  if (!a) return false;
  return QUEST_LEVEL_VOCS.every(voc => Number(a[voc]) === Number(b[voc]));
}

/**
 * Correção de padrões: conjunto salvo IGUAL ao padrão ANTIGO da quest nunca
 * foi personalizado (a hidratação/edição persistia o padrão automaticamente)
 * e é atualizado para o padrão NOVO. Qualquer personalização real (qualquer
 * vocação diferente do padrão antigo) é preservada exatamente como salva.
 */
function upgradeUncustomizedDefaults(record: MinLevelsRecord, quest: QuestLevelQuest): MinLevelsRecord {
  return sameRecord(record, PREVIOUS_QUEST_DEFAULTS[quest]) ? { ...QUEST_MIN_LEVEL_DEFAULTS[quest] } : record;
}

/**
 * `upgrade` = a configuração veio de uma versão de padrões ANTERIOR
 * (`defaultsVersion` ausente/menor): aplica a correção de padrões por quest.
 * Configurações já na versão atual passam direto — personalizações (mesmo
 * iguais a um padrão antigo) nunca são alteradas.
 */
function normalizeByQuest(raw: unknown, upgrade: boolean): MinLevelsByQuest {
  const source = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<QuestLevelQuest, unknown>>;
  const resolve = (quest: QuestLevelQuest): MinLevelsRecord => {
    const sanitized = sanitizeRecord(source[quest], QUEST_MIN_LEVEL_DEFAULTS[quest]);
    return upgrade ? upgradeUncustomizedDefaults(sanitized, quest) : sanitized;
  };
  return {
    soulwar: resolve("soulwar"),
    sanguine: resolve("sanguine"),
    // GB: configurações salvas ANTES da quest existir não têm a chave —
    // caem no padrão sem tocar nos conjuntos de SW/SG do usuário.
    crypt: resolve("crypt"),
  };
}

function defaultByQuest(): MinLevelsByQuest {
  return {
    soulwar: { ...QUEST_MIN_LEVEL_DEFAULTS.soulwar },
    sanguine: { ...QUEST_MIN_LEVEL_DEFAULTS.sanguine },
    crypt: { ...QUEST_MIN_LEVEL_DEFAULTS.crypt },
  };
}

/** Migração do conjunto único legado — só roda sem nuvem e sem cache novo. */
function migrateLegacy(feature: QuestLevelFeature): MinLevelsByQuest {
  const legacy = readLegacySingle(feature);
  if (legacy && !sameRecord(legacy, LEGACY_SINGLE_DEFAULTS[feature])) {
    // Personalizado pelo usuário: o conjunto antigo valia para as duas quests
    // — preservá-lo nas duas mantém o comportamento que ele conhecia.
    return {
      soulwar: sanitizeRecord(legacy, QUEST_MIN_LEVEL_DEFAULTS.soulwar),
      sanguine: sanitizeRecord(legacy, QUEST_MIN_LEVEL_DEFAULTS.sanguine),
      // GB não existia no conjunto único legado: recebe o padrão novo.
      crypt: { ...QUEST_MIN_LEVEL_DEFAULTS.crypt },
    };
  }
  return defaultByQuest();
}

/** Cache local POR USUÁRIO — contas diferentes no mesmo dispositivo não se misturam. */
function cacheKey(uid: string | null): string {
  return `quest_min_levels.v1.${uid || "local"}`;
}

type CloudPrefs = (Partial<Record<QuestLevelFeature, unknown>> & { defaultsVersion?: unknown }) | null | undefined;

/** Versão dos padrões registrada numa configuração persistida (ausente = 1). */
function storedVersion(container: { defaultsVersion?: unknown } | null | undefined): number {
  const value = Number(container?.defaultsVersion);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1;
}

function resolveFeature(
  feature: QuestLevelFeature,
  cloudPart: unknown,
  cachedPart: unknown,
  cloudUpgrade: boolean,
  cacheUpgrade: boolean,
): MinLevelsByQuest {
  if (cloudPart && typeof cloudPart === "object") return normalizeByQuest(cloudPart, cloudUpgrade);
  if (cachedPart && typeof cachedPart === "object") return normalizeByQuest(cachedPart, cacheUpgrade);
  return migrateLegacy(feature);
}

function buildState(uid: string | null, cloud: CloudPrefs): QuestMinLevelsPrefs {
  const cached = loadUIState<(Partial<QuestMinLevelsPrefs> & { defaultsVersion?: unknown }) | null>(cacheKey(uid), null);
  // Correção de padrões SÓ para configurações persistidas antes da versão
  // atual (a marca é gravada junto com os dados — ver notify/scheduleCloudSave).
  const cloudUpgrade = storedVersion(cloud) < DEFAULTS_VERSION;
  const cacheUpgrade = storedVersion(cached) < DEFAULTS_VERSION;
  return {
    suggest: resolveFeature("suggest", cloud?.suggest, cached?.suggest, cloudUpgrade, cacheUpgrade),
    overview: resolveFeature("overview", cloud?.overview, cached?.overview, cloudUpgrade, cacheUpgrade),
  };
}

let currentUid: string | null = null;
let state: QuestMinLevelsPrefs = buildState(null, null);

const listeners = new Set<() => void>();

function notify() {
  // A marca de versão acompanha os dados: o que está em memória já passou
  // pela correção de padrões (ou foi editado pelo usuário) — nunca deve ser
  // "corrigido" de novo em hidratações futuras.
  saveUIState(cacheKey(currentUid), { ...state, defaultsVersion: DEFAULTS_VERSION });
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getSnapshot(): QuestMinLevelsPrefs {
  return state;
}

// ── Sincronização com o perfil (users/{uid}) ────────────────────────────────
// O App injeta o saver (que usa o updateUserProfile já existente). A gravação
// é debounced e dispara SOMENTE a partir de edições do usuário — hidratar a
// partir do perfil nunca grava de volta (sem loops, sem writes desnecessários).
let cloudSaver: ((prefs: QuestMinLevelsStored) => void) | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function setQuestMinLevelsCloudSaver(saver: ((prefs: QuestMinLevelsStored) => void) | null) {
  cloudSaver = saver;
}

function scheduleCloudSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    // Perfil recebe a mesma marca de versão do cache (ver notify).
    if (cloudSaver) cloudSaver({ ...state, defaultsVersion: DEFAULTS_VERSION });
  }, 1200);
}

function samePrefs(a: QuestMinLevelsPrefs, b: QuestMinLevelsPrefs): boolean {
  return (["suggest", "overview"] as const).every(feature =>
    (["soulwar", "sanguine", "crypt"] as const).every(quest => sameRecord(a[feature][quest], b[feature][quest])));
}

/**
 * Hidrata o store para o usuário atual (login/troca de conta/logout).
 * Com edição pendente de gravação (debounce em curso), a hidratação do MESMO
 * usuário é ignorada — o estado local é o mais novo e será gravado em seguida.
 */
export function hydrateQuestMinLevels(uid: string | null, cloud: CloudPrefs) {
  if (uid === currentUid && saveTimer) return;
  const next = buildState(uid, cloud);
  const changedUser = uid !== currentUid;
  currentUid = uid;
  if (!changedUser && samePrefs(next, state)) return;
  state = next;
  notify();
}

/** Edição do usuário: grava o conjunto da QUEST do recurso, sem tocar na outra. */
export function setQuestMinLevels(feature: QuestLevelFeature, quest: QuestLevelQuest, record: MinLevelsRecord) {
  const sanitized = sanitizeRecord(record, QUEST_MIN_LEVEL_DEFAULTS[quest]);
  state = {
    ...state,
    [feature]: { ...state[feature], [quest]: sanitized },
  };
  notify();
  scheduleCloudSave();
}

/** "Resetar Padrão" do recurso: as DUAS quests voltam aos padrões novos. */
export function resetQuestMinLevelsFeature(feature: QuestLevelFeature) {
  state = { ...state, [feature]: defaultByQuest() };
  notify();
  scheduleCloudSave();
}

/**
 * Hook por recurso. `byQuest` traz os dois conjuntos; quem consome escolhe o
 * ativo pela quest selecionada e edita só ele via `setForQuest`.
 */
export function useQuestMinLevels(feature: QuestLevelFeature) {
  const prefs = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    byQuest: prefs[feature],
    setForQuest: (quest: QuestLevelQuest, record: MinLevelsRecord) => setQuestMinLevels(feature, quest, record),
    resetFeature: () => resetQuestMinLevelsFeature(feature),
  };
}
