/**
 * Regras puras da reconciliação de Quest concluída.
 *
 * Este módulo não importa Firebase, React nem código do cliente. Ele recebe
 * snapshots já lidos pelo trigger e devolve um plano determinístico de escrita.
 * Isso permite testar idempotência, preservação do comprador e cálculo de PT
 * sem depender de Emulator ou credenciais.
 */

export type QuestType = "soulwar" | "sanguine";
export type AcquisitionStatus = "pre_approved" | "payment_confirmed" | "quest_completed" | "for_sale" | "sold" | "created";
export type QuestValueSource = "pt" | "buyer";

export interface QuestSlot {
  itemDropado: string;
  itemVendido: number;
  split: boolean;
}

export interface ConcludedQuestParty {
  id: string;
  questType: QuestType;
  slots: Record<string, QuestSlot>;
  memberIds: string[];
}

export interface AcquisitionSnapshot {
  id: string;
  partyId: string;
  characterId: string;
  acquirerUid: string;
  status: AcquisitionStatus;
  questType?: QuestType;
  hasQuestCompletedAt: boolean;
}

export interface BuyerDetailsSnapshot {
  exists: boolean;
  id: string;
  acquisitionId: string;
  acquirerUid: string;
  questType?: QuestType;
  questDrops: string[];
  questDropsSource?: QuestValueSource;
  questProfit: number;
  questProfitSource?: QuestValueSource;
  hasQuestCompletedAt: boolean;
}

export interface BuyerDetailsValues {
  id: string;
  acquisitionId: string;
  acquirerUid: string;
  questType: QuestType;
  questDrops: string[];
  questDropsSource: QuestValueSource;
  questProfit: number;
  questProfitSource: QuestValueSource;
}

export interface QuestSettlementPlan {
  eligible: boolean;
  reason?: string;
  acquisition: {
    shouldWrite: boolean;
    status?: AcquisitionStatus;
    questType?: QuestType;
    ensureQuestCompletedAt: boolean;
  };
  buyerDetails: {
    shouldWrite: boolean;
    ensureQuestCompletedAt: boolean;
    values?: BuyerDetailsValues;
  };
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeText(value: unknown, max = 120): string {
  return String(value ?? "").trim().slice(0, max);
}

function normalizeId(value: unknown, max = 220): string {
  return normalizeText(value, max);
}

function normalizeMoney(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.max(0, Math.floor(parsed));
}

function normalizeQuestType(value: unknown): QuestType | undefined {
  return value === "soulwar" || value === "sanguine" ? value : undefined;
}

function normalizeStatus(value: unknown): AcquisitionStatus | undefined {
  return value === "pre_approved"
    || value === "payment_confirmed"
    || value === "quest_completed"
    || value === "for_sale"
    || value === "sold"
    || value === "created"
    ? value
    : undefined;
}

function normalizeSource(value: unknown): QuestValueSource | undefined {
  return value === "pt" || value === "buyer" ? value : undefined;
}

function normalizeDrops(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map(item => normalizeText(item, 120)).filter(Boolean))).slice(0, 20);
}

function sameTextArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function hasPersistedValue(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function memberIdsFromParty(raw: UnknownRecord): string[] {
  const selected = Array.isArray(raw.selectedIds)
    ? raw.selectedIds.map(value => normalizeId(value, 220)).filter(Boolean)
    : [];
  const custom = Array.isArray(raw.customMembers)
    ? raw.customMembers
      .map(member => isRecord(member) ? normalizeId(member.id, 220) : "")
      .filter(Boolean)
    : [];
  // Mantém a mesma semântica do cálculo do cliente: personagens e externos
  // contam como participantes distintos da divisão.
  return [...selected, ...custom];
}

/** Recebe o documento da PT e aceita apenas uma Quest concluída e válida. */
export function parseConcludedQuestParty(partyId: unknown, raw: unknown): ConcludedQuestParty | null {
  const id = normalizeId(partyId, 220);
  if (!id || !isRecord(raw)) return null;
  if (raw.questConcluida !== true || raw.questFalha === true) return null;

  const questType = normalizeQuestType(raw.ptType);
  if (!questType) return null;

  const rawSlots = isRecord(raw.slotData) ? raw.slotData : {};
  const slots: Record<string, QuestSlot> = {};
  Object.entries(rawSlots).forEach(([slotId, value]) => {
    const idValue = normalizeId(slotId, 220);
    if (!idValue || !isRecord(value)) return;
    slots[idValue] = {
      itemDropado: normalizeText(value.itemDropado, 120),
      itemVendido: normalizeMoney(value.itemVendido),
      split: value.split === true,
    };
  });

  return {
    id,
    questType,
    slots,
    memberIds: memberIdsFromParty(raw),
  };
}

/** Normaliza somente os campos administrativos que a Function pode reconciliar. */
export function parseAcquisitionSnapshot(documentId: unknown, raw: unknown): AcquisitionSnapshot | null {
  const id = normalizeId(documentId, 220);
  if (!id || !isRecord(raw)) return null;

  const partyId = normalizeId(raw.partyId, 220);
  const characterId = normalizeId(raw.characterId, 220);
  const acquirerUid = normalizeId(raw.acquirerUid, 80);
  const status = normalizeStatus(raw.status);
  if (!partyId || !characterId || !acquirerUid || !status) return null;

  return {
    id,
    partyId,
    characterId,
    acquirerUid,
    status,
    questType: normalizeQuestType(raw.questType),
    hasQuestCompletedAt: hasPersistedValue(raw.questCompletedAt),
  };
}

/** Normaliza o detalhe privado sem expor seus dados ao log ou documento público. */
export function parseBuyerDetailsSnapshot(raw: unknown): BuyerDetailsSnapshot {
  if (!isRecord(raw)) {
    return {
      exists: false,
      id: "",
      acquisitionId: "",
      acquirerUid: "",
      questDrops: [],
      questProfit: 0,
      hasQuestCompletedAt: false,
    };
  }

  return {
    exists: true,
    id: normalizeId(raw.id, 220),
    acquisitionId: normalizeId(raw.acquisitionId, 220),
    acquirerUid: normalizeId(raw.acquirerUid, 80),
    questType: normalizeQuestType(raw.questType),
    questDrops: normalizeDrops(raw.questDrops),
    questDropsSource: normalizeSource(raw.questDropsSource),
    questProfit: normalizeMoney(raw.questProfit),
    questProfitSource: normalizeSource(raw.questProfitSource),
    hasQuestCompletedAt: hasPersistedValue(raw.questCompletedAt),
  };
}

/** Mesmo arredondamento canônico da PT: múltiplo de 25 sempre para baixo. */
export function floorTo25(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value / 25) * 25;
}

/**
 * Arredondamento da DIVISÃO — múltiplo de 25 com corte em 10, espelhando
 * `roundSplitTo25` do PartyPanel: para baixo quando faltam MAIS de 10
 * unidades para o múltiplo superior; para cima quando faltam 10 ou menos.
 * Ex.: 389 -> 375 · 390 -> 400.
 */
export function roundSplitTo25(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const lower = Math.floor(value / 25) * 25;
  const excess = value - lower;
  if (excess === 0) return lower;
  return (25 - excess) <= 10 ? lower + 25 : lower;
}

/** Valor individual da divisão, incluindo membros externos, como no PartyPanel. */
export function getSplitValuePerMember(party: ConcludedQuestParty): number {
  const splitIds = party.memberIds.filter(id => party.slots[id]?.split === true);
  if (splitIds.length === 0) return 0;
  const total = splitIds.reduce((sum, id) => sum + party.slots[id].itemVendido, 0);
  return roundSplitTo25(total / splitIds.length);
}

function isBuyerOwnedDrops(details: BuyerDetailsSnapshot, questType: QuestType): boolean {
  return details.questType === questType && (
    details.questDropsSource === "buyer"
    || (details.questDropsSource === undefined && details.questDrops.length > 0)
  );
}

function isBuyerOwnedProfit(details: BuyerDetailsSnapshot, questType: QuestType): boolean {
  return details.questType === questType && (
    details.questProfitSource === "buyer"
    || (details.questProfitSource === undefined && details.questProfit > 0)
  );
}

function isSameBuyerDetails(existing: BuyerDetailsSnapshot, next: BuyerDetailsValues): boolean {
  return existing.exists
    && existing.id === next.id
    && existing.acquisitionId === next.acquisitionId
    && existing.acquirerUid === next.acquirerUid
    && existing.questType === next.questType
    && sameTextArray(existing.questDrops, next.questDrops)
    && existing.questDropsSource === next.questDropsSource
    && existing.questProfit === next.questProfit
    && existing.questProfitSource === next.questProfitSource;
}

/**
 * Produz um plano idempotente para uma aquisição vinculada à PT concluída.
 * Nenhuma escrita é feita aqui; o trigger aplica o plano em uma transação.
 */
export function buildQuestSettlementPlan(
  party: ConcludedQuestParty,
  acquisition: AcquisitionSnapshot,
  existingBuyerDetails: BuyerDetailsSnapshot,
): QuestSettlementPlan {
  const empty = (reason: string): QuestSettlementPlan => ({
    eligible: false,
    reason,
    acquisition: { shouldWrite: false, ensureQuestCompletedAt: false },
    buyerDetails: { shouldWrite: false, ensureQuestCompletedAt: false },
  });

  if (acquisition.partyId !== party.id) return empty("party_id_mismatch");
  if (acquisition.status === "pre_approved") return empty("payment_not_confirmed");

  const slot = party.slots[acquisition.characterId];
  if (!slot) return empty("party_slot_not_found");

  const importedDrops = slot.itemDropado ? [slot.itemDropado] : [];
  const importedProfit = slot.split
    ? getSplitValuePerMember(party)
    : slot.itemVendido;

  const preserveDrops = isBuyerOwnedDrops(existingBuyerDetails, party.questType);
  const preserveProfit = isBuyerOwnedProfit(existingBuyerDetails, party.questType);
  const values: BuyerDetailsValues = {
    id: acquisition.id,
    acquisitionId: acquisition.id,
    acquirerUid: acquisition.acquirerUid,
    questType: party.questType,
    questDrops: preserveDrops ? existingBuyerDetails.questDrops : importedDrops,
    questDropsSource: preserveDrops ? "buyer" : "pt",
    questProfit: preserveProfit ? existingBuyerDetails.questProfit : importedProfit,
    questProfitSource: preserveProfit ? "buyer" : "pt",
  };

  const terminalSold = acquisition.status === "sold";
  const nextStatus = acquisition.status === "payment_confirmed" || acquisition.status === "created"
    ? "quest_completed" as const
    : acquisition.status;
  const shouldWriteAcquisition = !terminalSold && (
    nextStatus !== acquisition.status
    || acquisition.questType !== party.questType
    || !acquisition.hasQuestCompletedAt
  );

  return {
    eligible: true,
    acquisition: {
      shouldWrite: shouldWriteAcquisition,
      status: nextStatus !== acquisition.status ? nextStatus : undefined,
      questType: !terminalSold && acquisition.questType !== party.questType ? party.questType : undefined,
      ensureQuestCompletedAt: !terminalSold && !acquisition.hasQuestCompletedAt,
    },
    buyerDetails: {
      shouldWrite: !isSameBuyerDetails(existingBuyerDetails, values) || !existingBuyerDetails.hasQuestCompletedAt,
      ensureQuestCompletedAt: !existingBuyerDetails.hasQuestCompletedAt,
      values,
    },
  };
}