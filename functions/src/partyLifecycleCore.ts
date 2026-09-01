/**
 * Núcleo puro da materialização de histórico pessoal e settlement de PT.
 *
 * Não depende de Firebase nem React. A Function usa este módulo para garantir
 * que retries, eventos repetidos e projeções de histórico gerem sempre o mesmo
 * resultado a partir da mesma versão da PT.
 */

export type PartyHistoryStatus = "quest_finalized" | "finalized" | "failed";
export type FinalizationReason = "payment" | "quest_failed";
export type QuestType = "soulwar" | "sanguine";

type UnknownRecord = Record<string, unknown>;

export interface LifecycleSlot {
  id: string;
  characterName: string;
  ownerName: string;
  ownerUid: string;
  playerName: string;
  playerUid: string;
  financialRightsHolderUid: string;
  financialRightsHolderName: string;
  characterAcquisitionId: string;
  split: boolean;
  splitTarget: "owner" | "player";
  splitTargetName: string;
  splitBeneficiaryUid: string;
  itemDropado: string;
  itemVendido: number;
  deaths: number;
  paid: boolean;
  paidByUid: string;
  paidByName: string;
  paidAt: number;
  isService: boolean;
}

export interface LifecycleParty {
  id: string;
  name: string;
  questType: QuestType;
  questConcluida: boolean;
  questFalha: boolean;
  pagamentoFeito: boolean;
  leaderUid: string;
  leaderName: string;
  members: string[];
  server: string;
  visibility: "public" | "private";
  durationMs: number;
  questFinalizedAt: number;
  customMembers: Array<{ id: string; label: string; servidor: string; voc: string; level: number }>;
  slots: LifecycleSlot[];
  participantUids: string[];
  validationErrors: string[];
}

export interface PartySettlementProjection {
  partyId: string;
  schemaVersion: number;
  status: "open" | "finalization_requested" | "finalized";
  revision: number;
  fingerprint: string;
  leaderUid: string;
  participantUids: string[];
  viewerUids: string[];
  quest: {
    name: string;
    type: QuestType;
    server: string;
    durationMs: number;
    questFinalizedAt: number;
  };
  slots: LifecycleSlot[];
  totals: {
    splitMemberCount: number;
    splitValuePerMember: number;
    totalSoldValue: number;
  };
}

export interface PersonalHistoryProjection {
  partyId: string;
  status: PartyHistoryStatus;
  sourceRevision: number;
  party: {
    name: string;
    questType: QuestType;
    server: string;
    leaderName: string;
    questFinalizedAt: number;
    durationMs: number;
  };
  roles: {
    participant: boolean;
    leader: boolean;
    owner: boolean;
    player: boolean;
    divisionParticipant: boolean;
    financialRightsHolder: boolean;
  };
  personalSlots: Array<{
    slotId: string;
    characterName: string;
    ownerName: string;
    playerName: string;
    deaths: number;
    itemDropado: string;
    itemVendido: number;
    paid: boolean;
    isService: boolean;
    isDivisionBeneficiary: boolean;
    divisionValue: number;
  }>;
  /**
   * Resumo de TODOS os personagens da PT (mesma forma do que `personalSlots`,
   * somando `split` e `splitTargetName`). Preparado AQUI, no backend, para
   * que cada participante receba o resumo completo da PT no seu documento
   * privado — sem leituras adicionais no cliente e com a mesma atualização
   * em tempo real do histórico (a reprojeção regrava `allSlots`).
   */
  allSlots: Array<{
    slotId: string;
    characterName: string;
    ownerName: string;
    playerName: string;
    deaths: number;
    itemDropado: string;
    itemVendido: number;
    paid: boolean;
    isService: boolean;
    isDivisionBeneficiary: boolean;
    divisionValue: number;
    split: boolean;
    splitTargetName: string;
  }>;
  division: {
    participates: boolean;
    beneficiarySlotIds: string[];
    valuePerMember: number;
  };
}

export interface SanitizedPartyArchive {
  partyId: string;
  schemaVersion: number;
  archived: true;
  archivedAtMs: number;
  status: PartyHistoryStatus;
  participantUids: string[];
  name: string;
  leaderUid: string;
  leaderName: string;
  ptType: QuestType;
  servidor: string;
  ptDuration: number;
  questConcluida: boolean;
  questFalha: boolean;
  pagamentoFeito: boolean;
  selectedIds: string[];
  customMembers: Array<{ id: string; label: string; servidor: string; voc: string; level: number }>;
  memberSnapshots: Record<string, {
    id: string;
    personagem: string;
    servidor: string;
    voc: string;
    level: number;
    ownerUid: string;
    ownerName: string;
  }>;
  slotData: Record<string, {
    owner: string;
    ownerUid: string;
    player: string;
    playerUid: string;
    financialRightsHolderUid: string;
    financialRightsHolderName: string;
    split: boolean;
    splitTarget: "owner" | "player";
    splitTargetName: string;
    splitBeneficiaryUid: string;
    deaths: number;
    itemDropado: string;
    itemVendido: number;
    pago: boolean;
    paidByName: string;
    paidAt: number;
    isService: boolean;
  }>;
  totals: PartySettlementProjection["totals"];
}

function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, max = 160): string {
  return String(value ?? "").trim().slice(0, max);
}

function uid(value: unknown): string {
  return text(value, 120);
}

function integer(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function millis(value: unknown): number {
  if (typeof value === "number") return integer(value);
  if (value && typeof (value as { toMillis?: unknown }).toMillis === "function") {
    return integer((value as { toMillis: () => unknown }).toMillis());
  }
  if (isRecord(value) && typeof value.seconds === "number") return integer(value.seconds * 1000);
  return 0;
}

function normalizeQuestType(value: unknown): QuestType | null {
  return value === "soulwar" || value === "sanguine" ? value : null;
}

function normalizeTarget(value: unknown): "owner" | "player" {
  return value === "player" ? "player" : "owner";
}

function memberIds(raw: UnknownRecord): string[] {
  const selected = Array.isArray(raw.selectedIds)
    ? raw.selectedIds.map(value => text(value, 220)).filter(Boolean)
    : [];
  const custom = Array.isArray(raw.customMembers)
    ? raw.customMembers.map(item => isRecord(item) ? text(item.id, 220) : "").filter(Boolean)
    : [];
  return [...selected, ...custom];
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.keys(value).sort().reduce<UnknownRecord>((result, key) => {
    result[key] = stableValue(value[key]);
    return result;
  }, {});
}

export function stableFingerprint(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

/** Mesmo arredondamento aplicado pelo PartyPanel: sempre múltiplo de 25 para baixo. */
export function floorTo25(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value / 25) * 25;
}

function slotFromRaw(id: string, rawSlot: UnknownRecord, rawSnapshot: UnknownRecord | undefined): LifecycleSlot {
  const ownerUid = uid(rawSlot.ownerUid ?? rawSnapshot?.ownerUid);
  const playerUid = uid(rawSlot.playerUid);
  const financialRightsHolderUid = uid(rawSlot.financialRightsHolderUid);
  const splitTarget = normalizeTarget(rawSlot.splitTarget);
  const explicitBeneficiary = uid(rawSlot.splitBeneficiaryUid);
  // Último recurso: o JOGADOR. Personagens EXTERNOS têm DONO apenas por nome
  // (sem ownerUid) e PTs legadas gravaram divisões sem destinatário — sem este
  // fallback o slot ficaria com `split` e sem beneficiário, rejeitando a
  // finalização inteira com `split_beneficiary_missing` para sempre. Quando o
  // destino era ambíguo (splitTarget ausente), DONO e JOGADOR coincidem por
  // nome, então o jogador é a mesma pessoa; quando o dono tem UID, a cadeia
  // nunca chega a este último recurso.
  const splitBeneficiaryUid = explicitBeneficiary
    || financialRightsHolderUid
    || (splitTarget === "player" ? playerUid : ownerUid)
    || playerUid;

  return {
    id,
    characterName: text(rawSnapshot?.personagem, 120),
    ownerName: text(rawSlot.owner ?? rawSnapshot?.ownerName, 120),
    ownerUid,
    playerName: text(rawSlot.player, 120),
    playerUid,
    financialRightsHolderUid,
    financialRightsHolderName: text(rawSlot.financialRightsHolderName, 120),
    characterAcquisitionId: text(rawSlot.characterAcquisitionId, 220),
    split: rawSlot.split === true,
    splitTarget,
    splitTargetName: text(rawSlot.splitTargetName, 120),
    splitBeneficiaryUid,
    itemDropado: text(rawSlot.itemDropado, 160),
    itemVendido: integer(rawSlot.itemVendido),
    deaths: integer(rawSlot.deaths),
    paid: rawSlot.pago === true,
    paidByUid: uid(rawSlot.paidByUid),
    paidByName: text(rawSlot.paidByName, 120),
    paidAt: integer(rawSlot.paidAt),
    isService: rawSlot.isService === true,
  };
}

/**
 * Normaliza uma PT apenas para os campos necessários ao settlement/histórico.
 * Valores privados de Character não entram nesse contrato.
 */
export function parseLifecycleParty(partyId: unknown, raw: unknown): LifecycleParty | null {
  if (!isRecord(raw)) return null;
  const id = text(partyId, 220);
  const questType = normalizeQuestType(raw.ptType);
  if (!id || !questType) return null;

  const rawSlots = isRecord(raw.slotData) ? raw.slotData : {};
  const rawSnapshots = isRecord(raw.memberSnapshots) ? raw.memberSnapshots : {};
  const customMembers = Array.isArray(raw.customMembers)
    ? raw.customMembers
      .filter(isRecord)
      .map(member => ({
        id: text(member.id, 220),
        label: text(member.label, 120),
        servidor: text(member.servidor, 80),
        voc: text(member.voc, 20),
        level: integer(member.level),
      }))
      .filter(member => !!member.id)
    : [];
  const customById = new Map(customMembers.map(member => [member.id, member]));
  const slots = memberIds(raw).map(slotId => {
    const slot = isRecord(rawSlots[slotId]) ? rawSlots[slotId] : {};
    const snapshot = isRecord(rawSnapshots[slotId]) ? rawSnapshots[slotId] : undefined;
    const parsed = slotFromRaw(slotId, slot, snapshot);
    const custom = customById.get(slotId);
    return custom && !parsed.characterName
      ? { ...parsed, characterName: custom.label, isService: true }
      : parsed;
  });

  const members = Array.isArray(raw.members)
    ? raw.members.map(uid).filter(Boolean)
    : [];
  const participantUids = unique([
    uid(raw.leaderUid),
    ...members,
    ...slots.flatMap(slot => [
      slot.ownerUid,
      slot.playerUid,
      slot.financialRightsHolderUid,
      slot.splitBeneficiaryUid,
    ]),
  ]);

  const validationErrors: string[] = [];
  slots.forEach(slot => {
    if (slot.split && !slot.splitBeneficiaryUid) {
      validationErrors.push(`split_beneficiary_missing:${slot.id}`);
    }
    if (
      slot.financialRightsHolderUid
      && slot.split
      && slot.splitBeneficiaryUid
      && slot.splitBeneficiaryUid !== slot.financialRightsHolderUid
    ) {
      validationErrors.push(`financial_rights_mismatch:${slot.id}`);
    }
  });

  return {
    id,
    name: text(raw.name, 120) || id,
    questType,
    questConcluida: raw.questConcluida === true,
    questFalha: raw.questFalha === true,
    pagamentoFeito: raw.pagamentoFeito === true,
    leaderUid: uid(raw.leaderUid),
    leaderName: text(raw.LeaderPT ?? raw.createdByName, 120),
    members,
    server: text(raw.servidor, 80),
    visibility: raw.visibility === "private" ? "private" : "public",
    durationMs: integer(raw.ptDuration),
    questFinalizedAt: millis(raw.questFinalizedAt ?? raw.archivedAt),
    customMembers,
    slots,
    participantUids,
    validationErrors,
  };
}

export function settlementTotals(party: LifecycleParty): PartySettlementProjection["totals"] {
  const splitSlots = party.slots.filter(slot => slot.split);
  const splitTotal = splitSlots.reduce((sum, slot) => sum + slot.itemVendido, 0);
  return {
    splitMemberCount: splitSlots.length,
    splitValuePerMember: splitSlots.length > 0 ? floorTo25(splitTotal / splitSlots.length) : 0,
    totalSoldValue: party.slots.reduce((sum, slot) => sum + slot.itemVendido, 0),
  };
}

/** Fingerprint de campos que afetam histórico/divisão após Quest. */
export function partySettlementFingerprint(party: LifecycleParty): string {
  return stableFingerprint({
    questConcluida: party.questConcluida,
    questFalha: party.questFalha,
    pagamentoFeito: party.pagamentoFeito,
    questType: party.questType,
    server: party.server,
    slots: party.slots.map(slot => ({
      id: slot.id,
      ownerUid: slot.ownerUid,
      playerUid: slot.playerUid,
      financialRightsHolderUid: slot.financialRightsHolderUid,
      split: slot.split,
      splitTarget: slot.splitTarget,
      splitBeneficiaryUid: slot.splitBeneficiaryUid,
      itemDropado: slot.itemDropado,
      itemVendido: slot.itemVendido,
      paid: slot.paid,
      paidByUid: slot.paidByUid,
      paidAt: slot.paidAt,
    })),
  });
}

export function buildPartySettlement(party: LifecycleParty, revision: number): PartySettlementProjection {
  const totals = settlementTotals(party);
  const viewerUids = unique([
    party.leaderUid,
    ...party.slots.filter(slot => slot.split).flatMap(slot => [slot.splitBeneficiaryUid, slot.financialRightsHolderUid]),
  ]);
  return {
    partyId: party.id,
    schemaVersion: 1,
    status: "open",
    revision: Math.max(1, Math.floor(revision)),
    fingerprint: partySettlementFingerprint(party),
    leaderUid: party.leaderUid,
    participantUids: party.participantUids,
    viewerUids,
    quest: {
      name: party.name,
      type: party.questType,
      server: party.server,
      durationMs: party.durationMs,
      questFinalizedAt: party.questFinalizedAt,
    },
    slots: party.slots,
    totals,
  };
}

export function buildPersonalPartyHistory(
  party: LifecycleParty,
  userId: string,
  revision: number,
  status: PartyHistoryStatus,
): PersonalHistoryProjection {
  const targetUid = uid(userId);
  const totals = settlementTotals(party);
  const personalSlots = party.slots
    .filter(slot => [slot.ownerUid, slot.playerUid, slot.financialRightsHolderUid, slot.splitBeneficiaryUid].includes(targetUid))
    .map(slot => ({
      slotId: slot.id,
      characterName: slot.characterName,
      ownerName: slot.ownerName,
      playerName: slot.playerName,
      deaths: slot.deaths,
      itemDropado: slot.itemDropado,
      itemVendido: slot.itemVendido,
      paid: slot.paid,
      isService: slot.isService,
      isDivisionBeneficiary: slot.split && slot.splitBeneficiaryUid === targetUid,
      divisionValue: slot.split && slot.splitBeneficiaryUid === targetUid ? totals.splitValuePerMember : 0,
    }));
  // Resumo completo da PT: TODOS os slots, para o card do histórico exibir
  // todos os personagens (personagem/dono/jogador/drop/lucro/divisão) e o
  // "Copiar (WA)" reproduzir o resumo da PT sem depender da PT ativa.
  // `isDivisionBeneficiary`/`divisionValue` continuam relativos ao dono do
  // documento (targetUid); `split`/`splitTargetName` são fatos do próprio
  // slot, iguais para todos os destinatários.
  const allSlots = party.slots.map(slot => ({
    slotId: slot.id,
    characterName: slot.characterName,
    ownerName: slot.ownerName,
    playerName: slot.playerName,
    deaths: slot.deaths,
    itemDropado: slot.itemDropado,
    itemVendido: slot.itemVendido,
    paid: slot.paid,
    isService: slot.isService,
    isDivisionBeneficiary: slot.split && slot.splitBeneficiaryUid === targetUid,
    divisionValue: slot.split && slot.splitBeneficiaryUid === targetUid ? totals.splitValuePerMember : 0,
    split: slot.split,
    splitTargetName: slot.splitTargetName,
  }));
  const beneficiarySlotIds = party.slots
    .filter(slot => slot.split && slot.splitBeneficiaryUid === targetUid)
    .map(slot => slot.id);

  return {
    partyId: party.id,
    status,
    sourceRevision: Math.max(1, Math.floor(revision)),
    party: {
      name: party.name,
      questType: party.questType,
      server: party.server,
      leaderName: party.leaderName,
      questFinalizedAt: party.questFinalizedAt,
      durationMs: party.durationMs,
    },
    roles: {
      participant: party.participantUids.includes(targetUid),
      leader: targetUid === party.leaderUid,
      owner: party.slots.some(slot => slot.ownerUid === targetUid),
      player: party.slots.some(slot => slot.playerUid === targetUid),
      divisionParticipant: beneficiarySlotIds.length > 0,
      financialRightsHolder: party.slots.some(slot => slot.financialRightsHolderUid === targetUid),
    },
    personalSlots,
    allSlots,
    division: {
      participates: beneficiarySlotIds.length > 0,
      beneficiarySlotIds,
      valuePerMember: beneficiarySlotIds.length > 0 ? totals.splitValuePerMember : 0,
    },
  };
}

export function buildSanitizedPartyArchive(
  party: LifecycleParty,
  status: PartyHistoryStatus,
  archivedAtMs: number,
): SanitizedPartyArchive {
  const totals = settlementTotals(party);
  const selectedIds = party.slots.map(slot => slot.id);
  const slotData = Object.fromEntries(party.slots.map(slot => [slot.id, {
    owner: slot.ownerName,
    ownerUid: slot.ownerUid,
    player: slot.playerName,
    playerUid: slot.playerUid,
    financialRightsHolderUid: slot.financialRightsHolderUid,
    financialRightsHolderName: slot.financialRightsHolderName,
    split: slot.split,
    splitTarget: slot.splitTarget,
    splitTargetName: slot.splitTargetName,
    splitBeneficiaryUid: slot.splitBeneficiaryUid,
    deaths: slot.deaths,
    itemDropado: slot.itemDropado,
    itemVendido: slot.itemVendido,
    pago: slot.paid,
    paidByName: slot.paidByName,
    paidAt: slot.paidAt,
    isService: slot.isService,
  }]));
  const memberSnapshots = Object.fromEntries(party.slots.map(slot => [slot.id, {
    id: slot.id,
    personagem: slot.characterName,
    servidor: party.server,
    voc: "",
    level: 0,
    ownerUid: slot.ownerUid,
    ownerName: slot.ownerName,
  }]));

  return {
    partyId: party.id,
    schemaVersion: 1,
    archived: true,
    archivedAtMs,
    status,
    participantUids: party.participantUids,
    name: party.name,
    leaderUid: party.leaderUid,
    leaderName: party.leaderName,
    ptType: party.questType,
    servidor: party.server,
    ptDuration: party.durationMs,
    questConcluida: party.questConcluida,
    questFalha: party.questFalha,
    pagamentoFeito: status === "finalized",
    selectedIds,
    customMembers: party.customMembers,
    memberSnapshots,
    slotData,
    totals,
  };
}

/**
 * Após Quest Finalizada, apenas UIDs presentes no roster congelado podem virar
 * JOGADOR ou beneficiário de divisão. O frontend bloqueia a ação e a Function
 * mantém uma segunda defesa para alterações concorrentes/manipuladas.
 */
export function validateParticipantRoster(party: LifecycleParty, allowedParticipantUids: string[]): string | null {
  const allowed = new Set(allowedParticipantUids.filter(Boolean));
  const referenced = unique(party.slots.flatMap(slot => [
    slot.ownerUid,
    slot.playerUid,
    slot.financialRightsHolderUid,
    slot.splitBeneficiaryUid,
  ]));
  const invalid = referenced.find(participantUid => !allowed.has(participantUid));
  return invalid ? `late_participant_not_original:${invalid}` : null;
}

export function validateFinalization(party: LifecycleParty, reason: FinalizationReason): string | null {
  if (reason === "quest_failed") {
    return party.questFalha ? null : "quest_failure_not_confirmed";
  }
  if (!party.questConcluida || party.questFalha) return "quest_not_completed";
  if (party.validationErrors.length > 0) return party.validationErrors[0];

  const splitSlots = party.slots.filter(slot => slot.split);
  const hasUnsoldSplitItem = splitSlots.some(slot => !!slot.itemDropado && slot.itemVendido <= 0);
  if (hasUnsoldSplitItem) return "split_item_value_missing";
  if (splitSlots.length > 0 && splitSlots.some(slot => !slot.paid)) return "split_payment_pending";
  return null;
}

/** Só mudanças relevantes devem reprojetar settlement/histórico. */
export function shouldProjectPartyUpdate(before: LifecycleParty | null, after: LifecycleParty | null): boolean {
  if (!after) return false;
  if (!after.questConcluida || after.questFalha) return false;
  if (!before || !before.questConcluida || before.questFalha) return true;
  return partySettlementFingerprint(before) !== partySettlementFingerprint(after);
}