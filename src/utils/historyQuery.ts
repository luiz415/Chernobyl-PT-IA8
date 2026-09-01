import type { PersonalPartyHistory, PersonalPartyHistorySlot } from "../types";
import { toFirestoreMillis } from "./firestoreTimestamp";
import { applySlotOverrides, type PartyHistoryOverrides } from "./historyOverrides";

/**
 * Filtro e ordenação do "Meu Histórico de PT's".
 * ============================================================================
 *
 * Tudo aqui opera sobre a lista de projeções JÁ CARREGADAS pela guia (o
 * listener de users/{uid}/partyHistory) — zero leituras extras do Firestore.
 * Os filtros são combináveis (Quest + Servidor + Personagem + Usuário
 * participante) e a ordenação padrão é Data de conclusão, mais recente
 * primeiro (a MESMA precedência de datas usada pelo serviço ao ordenar a
 * lista bruta: finalizedAt → questFinalizedAt → updatedAt).
 */

// ── Ordenação ────────────────────────────────────────────────────────────────
export const SORT_DATE_DESC = "Conclusão ↓ (recentes)";
export const SORT_DATE_ASC = "Conclusão ↑ (antigas)";
export const SORT_NUMBER_ASC = "Número da PT ↑";
export const SORT_NUMBER_DESC = "Número da PT ↓";
export const SORT_TOTAL_DESC = "Valor total ↓";
export const SORT_TOTAL_ASC = "Valor total ↑";
export const SORT_OPTIONS = [
  SORT_DATE_DESC,
  SORT_DATE_ASC,
  SORT_NUMBER_ASC,
  SORT_NUMBER_DESC,
  SORT_TOTAL_DESC,
  SORT_TOTAL_ASC,
];

export type HistorySortKey = "date" | "partyNumber" | "totalValue";
export type HistorySortDir = "asc" | "desc";

export function sortOptionToKeyDir(option: string): { key: HistorySortKey; dir: HistorySortDir } {
  switch (option) {
    case SORT_DATE_ASC: return { key: "date", dir: "asc" };
    case SORT_NUMBER_ASC: return { key: "partyNumber", dir: "asc" };
    case SORT_NUMBER_DESC: return { key: "partyNumber", dir: "desc" };
    case SORT_TOTAL_DESC: return { key: "totalValue", dir: "desc" };
    case SORT_TOTAL_ASC: return { key: "totalValue", dir: "asc" };
    default: return { key: "date", dir: "desc" };
  }
}

// ── Filtro de Quest (rótulo exibido ↔ valor do documento) ────────────────────
export const QUEST_FILTER_SOULWAR = "Soul War";
export const QUEST_FILTER_SANGUINE = "Sanguine";

export function questFilterToType(label: string): string {
  if (label === QUEST_FILTER_SOULWAR) return "soulwar";
  if (label === QUEST_FILTER_SANGUINE) return "sanguine";
  return "";
}

// ── Auxiliares puros ─────────────────────────────────────────────────────────
/** Normaliza texto para busca: sem acentos, minúsculo, sem espaços extras. */
export function normalizeText(value: unknown): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/** Slots do card: TODOS os personagens quando a projeção traz `allSlots`. */
export function cardSlots(entry: PersonalPartyHistory): PersonalPartyHistorySlot[] {
  return entry.allSlots?.length ? entry.allSlots : entry.personalSlots;
}

/** Data de referência da PT — MESMA precedência da ordenação do serviço. */
export function entryDateValue(entry: PersonalPartyHistory): number {
  return toFirestoreMillis(entry.party.finalizedAt || entry.party.questFinalizedAt || entry.updatedAt) || 0;
}

/** Número da PT (nome "#N"); sem número legível vai para o fim da lista. */
export function partyNumberValue(entry: PersonalPartyHistory): number {
  const match = /^#?(\d+)/.exec(String(entry.party.name || "").trim());
  return match ? parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

/** Total vendido pela divisão, COM as correções locais aplicadas (o número exibido). */
export function entryTotalValue(entry: PersonalPartyHistory, overrides?: PartyHistoryOverrides): number {
  return cardSlots(entry)
    .map(slot => applySlotOverrides(slot, overrides))
    .filter(slot => slot.split)
    .reduce((sum, slot) => sum + (slot.itemVendido || 0), 0);
}

// ── Filtro combinável ────────────────────────────────────────────────────────
export interface HistoryQueryFilters {
  /** Texto livre — casa com o NOME de qualquer personagem da PT. */
  characterQuery?: string;
  /** Rótulo do filtro de Quest ("Soul War" / "Sanguine"; vazio = todas). */
  questFilter?: string;
  /** Texto livre — casa com Líder, Dono ou Jogador de qualquer slot. */
  userQuery?: string;
  /** Nome exato do servidor (vazio = todos). */
  serverFilter?: string;
}

export function filterHistoryEntries(entries: PersonalPartyHistory[], filters: HistoryQueryFilters): PersonalPartyHistory[] {
  const questType = questFilterToType(String(filters.questFilter || ""));
  const charQ = normalizeText(filters.characterQuery);
  const userQ = normalizeText(filters.userQuery);
  const server = String(filters.serverFilter || "").trim();

  return entries.filter(entry => {
    if (questType && entry.party.questType !== questType) return false;
    if (server && String(entry.party.server || "").trim() !== server) return false;
    if (charQ) {
      const found = cardSlots(entry).some(slot => normalizeText(slot.characterName).includes(charQ));
      if (!found) return false;
    }
    if (userQ) {
      const slots = cardSlots(entry);
      const names = [entry.party.leaderName, ...slots.flatMap(slot => [slot.ownerName, slot.playerName])];
      const found = names.some(name => normalizeText(name).includes(userQ));
      if (!found) return false;
    }
    return true;
  });
}

// ── Ordenação ────────────────────────────────────────────────────────────────
export function sortHistoryEntries(
  entries: PersonalPartyHistory[],
  sortOption: string,
  overridesByParty?: Record<string, PartyHistoryOverrides>,
): PersonalPartyHistory[] {
  const { key, dir } = sortOptionToKeyDir(sortOption);
  const factor = dir === "asc" ? 1 : -1;
  return [...entries].sort((a, b) => {
    if (key === "partyNumber") {
      const av = partyNumberValue(a);
      const bv = partyNumberValue(b);
      if (av !== bv) return (av - bv) * factor;
      // Desempate natural: data mais recente primeiro.
      return entryDateValue(b) - entryDateValue(a);
    }
    if (key === "totalValue") {
      const av = entryTotalValue(a, overridesByParty?.[a.partyId]);
      const bv = entryTotalValue(b, overridesByParty?.[b.partyId]);
      if (av !== bv) return (av - bv) * factor;
      return entryDateValue(b) - entryDateValue(a);
    }
    // Padrão: data de conclusão — MESMA precedência da ordenação do serviço.
    return (entryDateValue(a) - entryDateValue(b)) * factor;
  });
}