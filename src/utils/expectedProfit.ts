// ============================================================================
// LUCRO ESPERADO (SW / SG / GB / Itens Crypt) — fonte única PURA (115ª)
// ----------------------------------------------------------------------------
// Suporte do modal "Lucro Esperado": constantes das recompensas, tipos do
// cadastro de valores e TODOS os cálculos de retorno esperado, em um módulo
// puro e testável em Node (sem JSX; Firebase só nas funções de persistência).
//
// VALORES CONSIDERADOS (cadastro do Boss, compartilhado):
//   • por SERVIDOR e por ITEM, em kk, nas duas categorias:
//       d = "Venda Direta"  (mínimo alcançável — maior oferta de compra);
//       p = "Venda Paciente" (média esperada aguardando boa oportunidade);
//   • NADA é inventado: item sem valor cadastrado fica "não configurado" e
//     NUNCA entra nas médias (as estatísticas expõem configurados/total);
//   • PERSISTÊNCIA/SINCRONIZAÇÃO — MESMO mecanismo do "RC Servidores":
//     campo `expectedProfitItemValues` no documento `appSettings/global`
//     (as Security Rules JÁ DEPLOYADAS garantem no backend que SÓ o Boss
//     grava; todos os aprovados leem), espelho local para leitura síncrona
//     e evento DOM para os modais abertos; o onSnapshot de appSettings que
//     o App JÁ mantém entrega as alterações em tempo real a todos — ZERO
//     listeners/leituras adicionais no Firestore.
//
// CONVERSÃO kk → RC: EXCLUSIVAMENTE pela função canônica `computeItemRC`
// com a cotação do PRÓPRIO servidor (fonte única "RC Servidores" —
// bazaarCoinRates). Sem cotação configurada, o resultado é "indisponível".
//
// PREMISSA DE DISTRIBUIÇÃO (sinalizada na UI): não há confirmação oficial
// das probabilidades individuais de cada recompensa — os cálculos assumem
// recompensas EQUIPROVÁVEIS dentro de cada quest (média aritmética simples
// dos itens configurados). A premissa fica visível ao usuário.
// ============================================================================

import { loadUIState, saveUIState } from "../storage";
import { serverKey } from "../constants/servers";
import { computeItemRC } from "./itemSale";
import { db, isSimulationMode, updateDoc as fbUpdateDoc, setDoc as fbSetDoc } from "../firebase/config";
import { doc } from "firebase/firestore";

// ── RECOMPENSAS (nomes oficiais) ─────────────────────────────────────────────

/** Soul War — 21 itens, 1 recompensa GARANTIDA por conclusão. */
export const SW_REWARD_ITEMS: string[] = [
  "Soulcutter", "Soulshredder", "Soulbiter", "Souleater", "Soulcrusher",
  "Soulmaimer", "Soulbastion", "Pair of Soulwalkers", "Soulbleeder",
  "Soulpiercer", "Soulshell", "Pair of Soulstalkers", "Soultainter",
  "Soulmantle", "Soulshanks", "Soulhexer", "Soulshroud", "Soulstrider",
  "Soulgarb", "Soulkamas", "Soulsoles",
];

/** Sanguine — 16 itens, 20% de chance por rotação completa. */
export const SG_REWARD_ITEMS: string[] = [
  "Sanguine Blade", "Sanguine Razor", "Sanguine Hatchet", "Sanguine Battleaxe",
  "Sanguine Cudgel", "Sanguine Bludgeon", "Sanguine Legs", "Sanguine Bow",
  "Sanguine Crossbow", "Sanguine Greaves", "Sanguine Coil", "Sanguine Boots",
  "Sanguine Rod", "Sanguine Galoshes", "Sanguine Claws", "Sanguine Trousers",
];

/** Graveborn — 5 runas, 1 recompensa GARANTIDA por conclusão. */
export const GB_REWARD_RUNES: string[] = [
  "Fiery Crypt Rune", "Icy Crypt Rune", "Deathly Crypt Rune",
  "Ancient Crypt Rune", "Necromantic Crypt Rune",
];

/** Itens Crypt — 5 runas de GB viram 1 item aleatório entre estes 7. */
export const CRYPT_ITEMS: string[] = [
  "Crypt Spine", "Crypt Splitter", "Crypt Breaker", "Crypt Strike",
  "Crypt Bile", "Crypt Jaw", "Crypt Slicer",
];

/** Runas necessárias para a conversão em 1 item Crypt. */
export const CRYPT_RUNES_REQUIRED = 5;

// ── QUESTS (tempos/chances — requisitos da 115ª) ────────────────────────────

export interface ExpectedQuestDef {
  key: "sw" | "sg" | "gb";
  label: string;
  /** Horas por tentativa (SW/GB: conclusão; SG: UMA rotação). */
  hoursPerAttempt: number;
  timeLabel: string;
  /** Probabilidade de recompensa por tentativa (1 = garantida). */
  dropChance: number;
  items: string[];
}

export const EXPECTED_QUESTS: ExpectedQuestDef[] = [
  { key: "sw", label: "Soul War", hoursPerAttempt: 3.5, timeLabel: "3h30min", dropChance: 1, items: SW_REWARD_ITEMS },
  { key: "sg", label: "Sanguine", hoursPerAttempt: 1.5, timeLabel: "1h30min por rotação", dropChance: 0.2, items: SG_REWARD_ITEMS },
  { key: "gb", label: "Graveborn", hoursPerAttempt: 1, timeLabel: "1h", dropChance: 1, items: GB_REWARD_RUNES },
];

// ── CADASTRO DE VALORES (por servidor → por item → {d, p} em kk) ────────────

/** Valores considerados de UM item (kk > 0; ausente = não configurado). */
export interface ExpectedItemValueEntry {
  /** Venda Direta — mínimo alcançável (maior oferta de compra). */
  d?: number;
  /** Venda Paciente — média esperada sem pressa de vender. */
  p?: number;
}
export type ExpectedProfitServerValues = Record<string, ExpectedItemValueEntry>;
export type ExpectedProfitValues = Record<string, ExpectedProfitServerValues>;

/** Chave canônica de item no cadastro (nome normalizado). */
export function expectedItemKey(name: string): string {
  return String(name || "").trim().toLowerCase();
}

/** Arredonda a 1 casa decimal (mesma precisão dos demais campos kk). */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Sanitiza o mapa cru (Firestore/localStorage): só números finitos > 0. */
export function sanitizeExpectedProfitValues(raw: unknown): ExpectedProfitValues {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const clean: ExpectedProfitValues = {};
  for (const [srv, items] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof srv !== "string" || !srv.trim() || !items || typeof items !== "object" || Array.isArray(items)) continue;
    const cleanItems: ExpectedProfitServerValues = {};
    for (const [item, entry] of Object.entries(items as Record<string, unknown>)) {
      if (typeof item !== "string" || !item.trim() || !entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const e = entry as Record<string, unknown>;
      const out: ExpectedItemValueEntry = {};
      const d = Number(e.d);
      const p = Number(e.p);
      if (Number.isFinite(d) && d > 0) out.d = round1(d);
      if (Number.isFinite(p) && p > 0) out.p = round1(p);
      if (out.d !== undefined || out.p !== undefined) cleanItems[item] = out;
    }
    if (Object.keys(cleanItems).length > 0) clean[srv] = cleanItems;
  }
  return clean;
}

// ── PERSISTÊNCIA (mesmo padrão do bazaarCoinRates) ──────────────────────────

/** Espelho local GLOBAL (valores valem para o app inteiro, não por uid). */
const LOCAL_KEY = "rubinot_expected_profit_values_global";
/** Durabilidade no modo simulação (sem Firestore, por design). */
const SIM_KEY = "tibia_sim_expected_profit_values";

/** Evento DOM disparado quando o espelho local muda (gravação OU snapshot). */
export const EXPECTED_PROFIT_VALUES_EVENT = "rubinot:expected-profit-values";

export function readLocalExpectedProfitValues(): ExpectedProfitValues {
  return sanitizeExpectedProfitValues(loadUIState<unknown>(LOCAL_KEY, {}));
}

/** Grava o espelho local e avisa os modais abertos (mesma janela). */
export function writeLocalExpectedProfitValues(values: ExpectedProfitValues): void {
  saveUIState(LOCAL_KEY, sanitizeExpectedProfitValues(values));
  try {
    window.dispatchEvent(new CustomEvent(EXPECTED_PROFIT_VALUES_EVENT));
  } catch { /* ambientes sem window (testes) — espelho já gravado */ }
}

/**
 * PERSISTE o cadastro completo: espelho local na hora + Firestore
 * (`appSettings/global.expectedProfitItemValues`) como fonte durável — o
 * MESMO doc/listener/Rules do "RC Servidores" (SÓ Boss grava no backend;
 * os demais usuários recebem pelo onSnapshot que o App já mantém).
 * O campo é gravado por inteiro (substituição) para remoções também
 * persistirem. Nunca lança: `remoteOk=false` sinaliza falha remota (o
 * espelho local desta sessão já foi aplicado).
 */
export async function persistExpectedProfitValues(values: ExpectedProfitValues): Promise<{ remoteOk: boolean }> {
  const clean = sanitizeExpectedProfitValues(values);
  writeLocalExpectedProfitValues(clean);
  if (isSimulationMode || !db) {
    try { saveUIState(SIM_KEY, clean); } catch { /* espelho local garante a sessão */ }
    return { remoteOk: true };
  }
  try {
    await fbUpdateDoc(doc(db, "appSettings", "global"), { expectedProfitItemValues: clean });
    return { remoteOk: true };
  } catch {
    try {
      await fbSetDoc(doc(db, "appSettings", "global"), { expectedProfitItemValues: clean }, { merge: true });
      return { remoteOk: true };
    } catch { /* silencioso — espelho local garante esta sessão */ }
    return { remoteOk: false };
  }
}

/** Entrada cadastrada de um item no servidor (ou vazia). */
export function getExpectedItemEntry(values: ExpectedProfitValues, server: string, itemName: string): ExpectedItemValueEntry {
  return values[serverKey(server)]?.[expectedItemKey(itemName)] || {};
}

// ── ESTATÍSTICAS / CÁLCULOS ─────────────────────────────────────────────────

/** Média em RC de UMA categoria sobre um grupo de itens. */
export interface ExpectedCategoryStat {
  /** Média (RC) dos itens CONFIGURADOS — null quando nenhum/sem cotação. */
  avgRc: number | null;
  /** Quantos itens do grupo têm valor cadastrado nesta categoria. */
  configured: number;
}

export interface ExpectedGroupStats {
  total: number;
  direct: ExpectedCategoryStat;
  patient: ExpectedCategoryStat;
}

/**
 * Converte e agrega um grupo de itens para um servidor: cada item vale o
 * SEU RC individual (computeItemRC — floor por item, como nas vendas) e a
 * média é a aritmética simples dos CONFIGURADOS (premissa equiprovável,
 * sinalizada na UI). Sem cotação (rate<=0) nada é convertido (avgRc=null —
 * nunca inventamos conversão), mas `configured` ainda conta o cadastro.
 */
export function computeGroupStats(items: string[], values: ExpectedProfitValues, server: string, coinRate: number): ExpectedGroupStats {
  let dSum = 0, dCount = 0, pSum = 0, pCount = 0;
  for (const item of items) {
    const entry = getExpectedItemEntry(values, server, item);
    if (entry.d !== undefined && entry.d > 0) {
      dCount += 1;
      if (coinRate > 0) dSum += computeItemRC(coinRate, entry.d);
    }
    if (entry.p !== undefined && entry.p > 0) {
      pCount += 1;
      if (coinRate > 0) pSum += computeItemRC(coinRate, entry.p);
    }
  }
  return {
    total: items.length,
    direct: { avgRc: coinRate > 0 && dCount > 0 ? Math.round(dSum / dCount) : null, configured: dCount },
    patient: { avgRc: coinRate > 0 && pCount > 0 ? Math.round(pSum / pCount) : null, configured: pCount },
  };
}

/** Retorno esperado de uma quest em UMA categoria (RC). */
export interface ExpectedQuestOutcome {
  /** Valor esperado de 1 RECOMPENSA (média dos itens configurados). */
  perRewardRc: number | null;
  /** Valor esperado por TENTATIVA (= chance × recompensa; SG: por rotação). */
  perAttemptRc: number | null;
  /** RC por hora (comparador de rentabilidade entre quests). */
  rcPerHour: number | null;
}

/** Horas esperadas até 1 recompensa (SW 3,5h; SG 7,5h = 5 rotações; GB 1h). */
export function expectedHoursPerReward(def: ExpectedQuestDef): number {
  return def.hoursPerAttempt / def.dropChance;
}

/**
 * Retorno esperado da quest a partir da média da categoria:
 *   • perReward = média dos itens (1 recompensa);
 *   • perAttempt = chance × média — NUNCA tratamos o drop da SG como
 *     garantido: cada rotação vale 20% da recompensa média;
 *   • rcPerHour = perAttempt ÷ horas por tentativa (equivale a
 *     perReward ÷ horas esperadas por recompensa — 5 rotações/7h30 na SG).
 */
export function computeQuestOutcome(def: ExpectedQuestDef, stat: ExpectedCategoryStat): ExpectedQuestOutcome {
  if (stat.avgRc === null) return { perRewardRc: null, perAttemptRc: null, rcPerHour: null };
  const perAttempt = def.dropChance * stat.avgRc;
  return {
    perRewardRc: stat.avgRc,
    perAttemptRc: Math.round(perAttempt),
    rcPerHour: Math.round((perAttempt / def.hoursPerAttempt) * 10) / 10,
  };
}

/** Conversão Crypt em UMA categoria (RC). */
export interface CryptConversionOutcome {
  /** Valor esperado do item Crypt recebido (média dos 7 configurados). */
  expectedCryptRc: number | null;
  /** Custo de oportunidade: valor de VENDA das 5 runas gastas. */
  runesCostRc: number | null;
  /** Saldo esperado da conversão (item − 5 runas). */
  netRc: number | null;
}

/**
 * CONVERSÃO 5 RUNAS → 1 ITEM CRYPT (sem dupla contagem): o retorno do GB
 * continua sendo a RUNA média por conclusão; converter troca 5 runas (que
 * deixariam de ser vendidas — custo de oportunidade usa a MÉDIA das runas
 * configuradas) por 1 item Crypt aleatório (média dos 7, premissa
 * equiprovável). O saldo é a diferença — NUNCA soma runas E item como duas
 * recompensas. Exige médias disponíveis dos dois lados (senão null).
 */
export function computeCryptConversion(runeStat: ExpectedCategoryStat, cryptStat: ExpectedCategoryStat): CryptConversionOutcome {
  if (cryptStat.avgRc === null || runeStat.avgRc === null) {
    return { expectedCryptRc: cryptStat.avgRc, runesCostRc: runeStat.avgRc === null ? null : runeStat.avgRc * CRYPT_RUNES_REQUIRED, netRc: null };
  }
  const runesCost = runeStat.avgRc * CRYPT_RUNES_REQUIRED;
  return {
    expectedCryptRc: cryptStat.avgRc,
    runesCostRc: runesCost,
    netRc: cryptStat.avgRc - runesCost,
  };
}
