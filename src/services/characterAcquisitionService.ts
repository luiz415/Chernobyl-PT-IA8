import { collection, doc, getDoc, query, runTransaction, serverTimestamp, Timestamp, where } from "firebase/firestore";
import { db, isSimulationMode, onSnapshot } from "../firebase/config";
import type {
  CharacterAcquisition,
  CharacterAcquisitionBuyerDetails,
  CharacterAcquisitionStatus,
  NegotiationTimestamp,
  PartyTab,
  PtType,
  Vocation,
} from "../types";
import { getProfitFieldsForQuest, getSplitValuePerMember } from "../utils/partyProfit";
import { toFirestoreMillis } from "../utils/firestoreTimestamp";

/** Documento compartilhado: termos, estados e valores necessários aos dois lados. */
const ACQUISITIONS_COLLECTION = "characterAcquisitions";
/** Documento privado: drop e lucro da Quest pertencentes apenas ao adquirente. */
const BUYER_DETAILS_COLLECTION = "characterAcquisitionBuyerDetails";
const SIMULATION_STORAGE_KEY = "tibia_character_acquisitions";
const SIMULATION_DETAILS_STORAGE_KEY = "tibia_character_acquisition_buyer_details";
const SIMULATION_EVENT = "character-acquisitions-changed";
const SIMULATION_DETAILS_EVENT = "character-acquisition-buyer-details-changed";

export interface CreateCharacterAcquisitionInput {
  partyId: string;
  partyName: string;
  characterId: string;
  characterName: string;
  server: string;
  vocation: Vocation;
  level: number;
  originalOwnerUid: string;
  originalOwnerName: string;
  sellerMainCharacterName: string;
  acquirerUid: string;
  acquirerName: string;
  buyerMainCharacterName: string;
  originalCharacterCost: number;
  personalFee: number;
  bazaarFee: number;
  actorUid: string;
  actorName: string;
  actorRole?: string;
}

export interface AcquisitionLifecycleUpdate {
  status?: CharacterAcquisitionStatus;
  questType?: PtType;
  saleValue?: number;
  /** Solicita Timestamp do servidor se a Quest ainda não tiver instante gravado. */
  markQuestCompletedAt?: boolean;
  /** Solicita Timestamp do servidor se a listagem ainda não tiver instante gravado. */
  markListedAt?: boolean;
  /** Solicita Timestamp do servidor se a venda ainda não tiver instante gravado. */
  markSoldAt?: boolean;
}

export type CharacterAcquisitionSubscriptionScope = "confirmed" | "pre_approved";

/** Estados que representam uma negociação efetiva, já aceita/paga pelo comprador. */
export const CONFIRMED_CHARACTER_ACQUISITION_STATUSES: CharacterAcquisitionStatus[] = [
  "payment_confirmed",
  "quest_completed",
  "for_sale",
  "sold",
  // Compatibilidade com o fluxo anterior, em que `created` já era confirmado.
  "created",
];

function normalizeText(value: unknown, max = 120): string {
  return String(value || "").trim().slice(0, max);
}

function normalizeMoney(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizePersonalFee(value: unknown): number | null {
  const fee = normalizeMoney(value);
  return fee === 0 || fee === 25 || fee === 50 ? fee : null;
}

/** Timestamp local apenas para feedback otimista; o Firestore recebe serverTimestamp(). */
function optimisticTimestamp(): NegotiationTimestamp {
  return isSimulationMode || !db ? Date.now() : Timestamp.now();
}

function timestampForWrite(value?: NegotiationTimestamp): any {
  if (value === undefined || value === null) return serverTimestamp();
  if (typeof value === "number") return Timestamp.fromMillis(value);
  return value;
}

/** Firestore rejeita undefined: remove campos opcionais ausentes antes do write. */
function withoutUndefined<T extends Record<string, any>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

/** Um personagem original só pode ter uma negociação financeira ativa/histórica. */
export function getCharacterAcquisitionId(originalOwnerUid: string, characterId: string): string {
  const owner = normalizeText(originalOwnerUid, 80).replace(/[^a-zA-Z0-9_-]/g, "_");
  const character = normalizeText(characterId, 120).replace(/[^a-zA-Z0-9_-]/g, "_");
  return `acq_${owner}_${character}`;
}

/** `created` era o estado confirmado do fluxo antigo; é tratado como pago. */
export function normalizeCharacterAcquisitionStatus(status: unknown): CharacterAcquisitionStatus {
  if (status === "pre_approved" || status === "payment_confirmed" || status === "quest_completed" || status === "for_sale" || status === "sold") return status;
  return "created";
}

export function isPaymentConfirmed(record: CharacterAcquisition): boolean {
  return CONFIRMED_CHARACTER_ACQUISITION_STATUSES.includes(normalizeCharacterAcquisitionStatus(record.status));
}

export function getCharacterAcquisitionPersonalFee(record: CharacterAcquisition): number {
  const value = record.personalFee ?? record.additionalFee ?? 0;
  return normalizePersonalFee(value) ?? 0;
}

export function getCharacterAcquisitionSellerReceived(record: CharacterAcquisition): number {
  // Regra atual: o comprador transfere ao vendedor o valor integral da
  // aquisição, incluindo a taxa Bazaar obrigatória. `finalPaid` é a fonte
  // preferencial inclusive para registros antigos que guardavam sellerReceived
  // com a semântica anterior.
  const total = normalizeMoney(record.finalPaid);
  if (total !== null) return total;
  const explicit = normalizeMoney(record.sellerReceived);
  if (explicit !== null) return explicit;
  return Math.max(0, Number(record.originalCharacterCost || 0) + getCharacterAcquisitionPersonalFee(record) + Number(record.bazaarFee || 0));
}

function readSimulationRecords(): CharacterAcquisition[] {
  try {
    const raw = localStorage.getItem(SIMULATION_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(Boolean) as CharacterAcquisition[] : [];
  } catch {
    return [];
  }
}

function writeSimulationRecords(records: CharacterAcquisition[]) {
  try {
    localStorage.setItem(SIMULATION_STORAGE_KEY, JSON.stringify(records));
    window.dispatchEvent(new Event(SIMULATION_EVENT));
  } catch {}
}

function readSimulationBuyerDetails(): CharacterAcquisitionBuyerDetails[] {
  try {
    const raw = localStorage.getItem(SIMULATION_DETAILS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(Boolean) as CharacterAcquisitionBuyerDetails[] : [];
  } catch {
    return [];
  }
}

function writeSimulationBuyerDetails(records: CharacterAcquisitionBuyerDetails[]) {
  try {
    localStorage.setItem(SIMULATION_DETAILS_STORAGE_KEY, JSON.stringify(records));
    window.dispatchEvent(new Event(SIMULATION_DETAILS_EVENT));
  } catch {}
}

function buildRecord(input: CreateCharacterAcquisitionInput): CharacterAcquisition | null {
  const originalCharacterCost = normalizeMoney(input.originalCharacterCost);
  const personalFee = normalizePersonalFee(input.personalFee);
  const bazaarFee = normalizeMoney(input.bazaarFee);
  const ownerUid = normalizeText(input.originalOwnerUid, 80);
  const acquirerUid = normalizeText(input.acquirerUid, 80);
  const characterId = normalizeText(input.characterId, 120);
  const partyId = normalizeText(input.partyId, 120);
  // Mantém o valor exatamente como está no perfil para o botão de copiar.
  // Só a validação usa trim; o conteúdo persistido não ganha nem perde espaços.
  const sellerMainCharacterName = String(input.sellerMainCharacterName || "").slice(0, 80);
  const buyerMainCharacterName = String(input.buyerMainCharacterName || "").slice(0, 80);

  if (!partyId || !characterId || !ownerUid || !acquirerUid || ownerUid === acquirerUid) return null;
  if (!sellerMainCharacterName.trim() || !buyerMainCharacterName.trim()) return null;
  if (originalCharacterCost === null || personalFee === null || bazaarFee !== 50) return null;

  const now = optimisticTimestamp();
  const finalPaid = originalCharacterCost + personalFee + bazaarFee;
  // A taxa Bazaar faz parte do pagamento que o comprador envia ao vendedor.
  const sellerReceived = finalPaid;
  return {
    id: getCharacterAcquisitionId(ownerUid, characterId),
    partyId,
    partyName: normalizeText(input.partyName),
    characterId,
    characterName: normalizeText(input.characterName),
    server: normalizeText(input.server),
    vocation: input.vocation,
    level: Math.max(0, Math.floor(Number(input.level) || 0)),
    originalOwnerUid: ownerUid,
    originalOwnerName: normalizeText(input.originalOwnerName),
    sellerMainCharacterName,
    acquirerUid,
    acquirerName: normalizeText(input.acquirerName),
    buyerMainCharacterName,
    financialRightsHolderUid: acquirerUid,
    financialRightsHolderName: normalizeText(input.acquirerName),
    originalCharacterCost,
    personalFee,
    bazaarFee,
    finalPaid,
    sellerReceived,
    status: "pre_approved",
    createdAt: now,
    createdByUid: normalizeText(input.actorUid, 80),
    createdByName: normalizeText(input.actorName),
    preApprovedAt: now,
    salePayoutStatus: "pending",
    updatedAt: now,
  };
}

/**
 * O dono original pré-aprova os termos. O comprador não pode criar nem alterar
 * valor, taxa pessoal, vendedor ou adquirente.
 */
export async function createCharacterAcquisition(input: CreateCharacterAcquisitionInput): Promise<{ ok: boolean; record?: CharacterAcquisition; error?: string }> {
  const isOriginalOwner = input.actorUid === input.originalOwnerUid;
  if (!isOriginalOwner && input.actorRole !== "Boss") {
    return { ok: false, error: "Somente o dono original pode pré-aprovar a venda deste personagem." };
  }

  const record = buildRecord(input);
  if (!record) {
    return { ok: false, error: "Os dados da pré-aprovação são inválidos. Revise valor, taxa e Main Character dos envolvidos." };
  }

  if (isSimulationMode || !db) {
    const records = readSimulationRecords();
    if (records.some(item => item.id === record.id)) {
      return { ok: false, error: "Este personagem já possui uma negociação registrada." };
    }
    writeSimulationRecords([...records, record]);
    return { ok: true, record };
  }

  try {
    const ref = doc(db, ACQUISITIONS_COLLECTION, record.id);
    let alreadyExists = false;
    await runTransaction(db, async transaction => {
      const snapshot = await transaction.get(ref);
      if (snapshot.exists()) {
        alreadyExists = true;
        return;
      }
      transaction.set(ref, {
        ...record,
        // O servidor determina o instante definitivo; o record local só serve
        // de feedback até o snapshot retornar com Timestamp real.
        createdAt: serverTimestamp(),
        preApprovedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    });
    if (alreadyExists) return { ok: false, error: "Este personagem já possui uma negociação registrada." };
    return { ok: true, record };
  } catch (error: any) {
    return { ok: false, error: error?.message || "Não foi possível pré-aprovar a negociação." };
  }
}

/** Consulta defensiva pelo ID determinístico, usada após reinicialização. */
export async function getCharacterAcquisition(originalOwnerUid: string, characterId: string): Promise<CharacterAcquisition | null> {
  const id = getCharacterAcquisitionId(originalOwnerUid, characterId);
  if (!id) return null;
  if (isSimulationMode || !db) return readSimulationRecords().find(record => record.id === id) || null;
  try {
    const snapshot = await getDoc(doc(db, ACQUISITIONS_COLLECTION, id));
    return snapshot.exists() ? ({ id: snapshot.id, ...snapshot.data() } as CharacterAcquisition) : null;
  } catch {
    return null;
  }
}

function canReadOrUpdate(record: CharacterAcquisition, actorUid: string): boolean {
  return actorUid === record.originalOwnerUid || actorUid === record.acquirerUid || actorUid === record.createdByUid;
}

function validateLifecycleTransition(record: CharacterAcquisition, patch: AcquisitionLifecycleUpdate, actorUid: string): string | null {
  if (!canReadOrUpdate(record, actorUid)) return "Apenas os envolvidos podem atualizar esta negociação.";

  const current = normalizeCharacterAcquisitionStatus(record.status);
  const next = patch.status ? normalizeCharacterAcquisitionStatus(patch.status) : current;
  const changesSaleValue = patch.saleValue !== undefined && patch.saleValue !== record.saleValue;
  const touchesOwnerSaleFields = changesSaleValue || !!patch.markListedAt || !!patch.markSoldAt;
  const changesSaleLifecycle = next !== current
    && (current === "for_sale" || current === "sold" || next === "for_sale" || next === "sold");

  // `saleValue` é uma publicação exata do valor oficial salvo no Character do
  // dono. O adquirente nunca pode escrever, recalcular ou substituir esse valor.
  if ((touchesOwnerSaleFields || changesSaleLifecycle) && actorUid !== record.originalOwnerUid) {
    return "Somente o dono original pode atualizar a venda deste personagem.";
  }
  if (changesSaleValue && current !== "sold" && next !== "sold") {
    return "O valor da venda só pode ser publicado quando o personagem for marcado como vendido.";
  }
  if (changesSaleValue && record.salePayoutStatus === "confirmed") {
    return "O valor da venda não pode mudar depois que o repasse foi confirmado.";
  }

  // Atualizações pontuais (por exemplo, o espelho do valor oficial já vendido)
  // não devem reabrir nem reinterpretar o ciclo de vida.
  if (next === current) return null;

  if (current === "pre_approved" && next !== "payment_confirmed") return "Aguardando a confirmação de pagamento do comprador.";
  if (current === "pre_approved" && actorUid !== record.acquirerUid) return "Somente o comprador pode confirmar o primeiro pagamento.";
  if ((current === "payment_confirmed" || current === "created") && next !== "quest_completed") return "A Quest precisa ser concluída antes da venda.";
  if (current === "quest_completed" && next !== "for_sale" && next !== "sold") return "Transição de negociação inválida.";
  if (current === "for_sale" && next !== "quest_completed" && next !== "sold") return "Transição de negociação inválida.";
  if (current === "sold" && next !== "sold") return "Uma negociação vendida não pode ser reaberta.";
  return null;
}

/** Atualiza apenas o ciclo compartilhado — nunca valores privados da Quest. */
export async function updateCharacterAcquisitionLifecycle(id: string, patch: AcquisitionLifecycleUpdate, actorUid?: string): Promise<{ ok: boolean; record?: CharacterAcquisition; error?: string }> {
  const acquisitionId = normalizeText(id, 220);
  const actor = normalizeText(actorUid, 80);
  if (!acquisitionId || !actor) return { ok: false, error: "Negociação ou usuário inválido." };

  const safePatch: AcquisitionLifecycleUpdate = {};
  if (patch.status) safePatch.status = patch.status;
  if (patch.questType === "soulwar" || patch.questType === "sanguine") safePatch.questType = patch.questType;
  if (patch.saleValue !== undefined) {
    const value = normalizeMoney(patch.saleValue);
    if (value === null) return { ok: false, error: "Valor da venda inválido." };
    safePatch.saleValue = value;
  }
  const markQuestCompletedAt = patch.markQuestCompletedAt === true;
  const markListedAt = patch.markListedAt === true;
  const markSoldAt = patch.markSoldAt === true;
  const validationPatch: AcquisitionLifecycleUpdate = {
    ...safePatch,
    markQuestCompletedAt,
    markListedAt,
    markSoldAt,
  };

  const mutate = (current: CharacterAcquisition): { next?: CharacterAcquisition; error?: string } => {
    const error = validateLifecycleTransition(current, validationPatch, actor);
    if (error) return { error };
    const now = optimisticTimestamp();
    const next: CharacterAcquisition = { ...current, ...safePatch, updatedAt: now };
    if (markQuestCompletedAt && !current.questCompletedAt) next.questCompletedAt = now;
    if (markListedAt && !current.listedAt) next.listedAt = now;
    if (markSoldAt && !current.soldAt) next.soldAt = now;
    if (next.status === "sold" && !next.salePayoutStatus) next.salePayoutStatus = "pending";
    return { next };
  };

  if (isSimulationMode || !db) {
    const records = readSimulationRecords();
    const index = records.findIndex(item => item.id === acquisitionId);
    if (index < 0) return { ok: false, error: "Negociação não encontrada." };
    const { next, error } = mutate(records[index]);
    if (error || !next) return { ok: false, error: error || "Não foi possível atualizar a negociação." };
    records[index] = next;
    writeSimulationRecords(records);
    return { ok: true, record: next };
  }

  try {
    const ref = doc(db, ACQUISITIONS_COLLECTION, acquisitionId);
    let nextRecord: CharacterAcquisition | undefined;
    let updateError = "";
    await runTransaction(db, async transaction => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists()) {
        updateError = "Negociação não encontrada.";
        return;
      }
      const current = { id: snapshot.id, ...snapshot.data() } as CharacterAcquisition;
      const result = mutate(current);
      if (result.error || !result.next) {
        updateError = result.error || "Não foi possível atualizar a negociação.";
        return;
      }
      nextRecord = result.next;
      const writePatch: Record<string, any> = {
        ...safePatch,
        salePayoutStatus: result.next.salePayoutStatus,
        updatedAt: serverTimestamp(),
      };
      if (markQuestCompletedAt && !current.questCompletedAt) writePatch.questCompletedAt = serverTimestamp();
      if (markListedAt && !current.listedAt) writePatch.listedAt = serverTimestamp();
      if (markSoldAt && !current.soldAt) writePatch.soldAt = serverTimestamp();
      transaction.update(ref, withoutUndefined(writePatch));
    });
    if (updateError) return { ok: false, error: updateError };
    return { ok: true, record: nextRecord };
  } catch (error: any) {
    return { ok: false, error: error?.message || "Não foi possível atualizar a negociação." };
  }
}

/** Comprador confirma que enviou o valor total ao Main Character do vendedor. */
export async function confirmCharacterAcquisitionPayment(id: string, buyerUid?: string): Promise<{ ok: boolean; record?: CharacterAcquisition; error?: string }> {
  const actor = normalizeText(buyerUid, 80);
  const update = (current: CharacterAcquisition): { next?: CharacterAcquisition; error?: string } => {
    if (actor !== current.acquirerUid) return { error: "Somente o comprador pode confirmar este pagamento." };
    const status = normalizeCharacterAcquisitionStatus(current.status);
    if (status !== "pre_approved") return { error: "Esta negociação não está aguardando pagamento do comprador." };
    return {
      next: {
        ...current,
        status: "payment_confirmed",
        paymentConfirmedAt: optimisticTimestamp(),
        paymentConfirmedByUid: actor,
        updatedAt: optimisticTimestamp(),
      },
    };
  };
  return mutateSharedRecord(id, update, ["paymentConfirmedAt"]);
}

/** Após a venda posterior, o dono confirma o repasse integral ao comprador. */
export async function confirmCharacterAcquisitionSalePayout(id: string, ownerUid?: string): Promise<{ ok: boolean; record?: CharacterAcquisition; error?: string }> {
  const actor = normalizeText(ownerUid, 80);
  const update = (current: CharacterAcquisition): { next?: CharacterAcquisition; error?: string } => {
    if (actor !== current.originalOwnerUid) return { error: "Somente o dono original pode confirmar o repasse da venda." };
    if (normalizeCharacterAcquisitionStatus(current.status) !== "sold" || !Number.isFinite(current.saleValue)) {
      return { error: "O personagem ainda não possui uma venda registrada para repasse." };
    }
    if (current.salePayoutStatus === "confirmed") return { error: "O repasse da venda já foi confirmado." };
    return {
      next: {
        ...current,
        salePayoutStatus: "confirmed",
        salePayoutConfirmedAt: optimisticTimestamp(),
        salePayoutConfirmedByUid: actor,
        updatedAt: optimisticTimestamp(),
      },
    };
  };
  return mutateSharedRecord(id, update, ["salePayoutConfirmedAt"]);
}

async function mutateSharedRecord(
  id: string,
  mutator: (record: CharacterAcquisition) => { next?: CharacterAcquisition; error?: string },
  serverTimestampFields: Array<"paymentConfirmedAt" | "salePayoutConfirmedAt"> = [],
): Promise<{ ok: boolean; record?: CharacterAcquisition; error?: string }> {
  const acquisitionId = normalizeText(id, 220);
  if (!acquisitionId) return { ok: false, error: "Negociação inválida." };
  if (isSimulationMode || !db) {
    const records = readSimulationRecords();
    const index = records.findIndex(record => record.id === acquisitionId);
    if (index < 0) return { ok: false, error: "Negociação não encontrada." };
    const { next, error } = mutator(records[index]);
    if (error || !next) return { ok: false, error: error || "Não foi possível atualizar a negociação." };
    records[index] = next;
    writeSimulationRecords(records);
    return { ok: true, record: next };
  }
  try {
    const ref = doc(db, ACQUISITIONS_COLLECTION, acquisitionId);
    let nextRecord: CharacterAcquisition | undefined;
    let updateError = "";
    await runTransaction(db, async transaction => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists()) {
        updateError = "Negociação não encontrada.";
        return;
      }
      const { next, error } = mutator({ id: snapshot.id, ...snapshot.data() } as CharacterAcquisition);
      if (error || !next) {
        updateError = error || "Não foi possível atualizar a negociação.";
        return;
      }
      nextRecord = next;
      const writePatch: Record<string, any> = {
        status: next.status,
        paymentConfirmedAt: next.paymentConfirmedAt,
        paymentConfirmedByUid: next.paymentConfirmedByUid,
        salePayoutStatus: next.salePayoutStatus,
        salePayoutConfirmedAt: next.salePayoutConfirmedAt,
        salePayoutConfirmedByUid: next.salePayoutConfirmedByUid,
        updatedAt: serverTimestamp(),
      };
      serverTimestampFields.forEach(field => { writePatch[field] = serverTimestamp(); });
      transaction.update(ref, withoutUndefined(writePatch));
    });
    if (updateError) return { ok: false, error: updateError };
    return { ok: true, record: nextRecord };
  } catch (error: any) {
    return { ok: false, error: error?.message || "Não foi possível atualizar a negociação." };
  }
}

/**
 * Calcula o lucro privado da Quest para o adquirente usando a MESMA regra da
 * PT/colunas Lucro SW e Lucro SG. Quando uma PT histórica já trouxe o valor
 * para o snapshot do personagem, esse campo é apenas o fallback — o slot da PT
 * continua sendo a fonte prioritária e atual.
 */
export function calculateAcquiredQuestProfit(party: PartyTab, characterId: string): number {
  const slot = party.slotData?.[characterId];
  const calculated = slot
    ? (slot.split ? getSplitValuePerMember(party) : Number(slot.itemVendido || 0))
    : 0;
  if (Number.isFinite(calculated) && calculated > 0) return Math.floor(calculated);

  const questType: PtType = party.ptType === "sanguine" ? "sanguine" : "soulwar";
  const { valueField } = getProfitFieldsForQuest(questType);
  const importedValue = Number(party.memberSnapshots?.[characterId]?.[valueField] || 0);
  return Number.isFinite(importedValue) && importedValue > 0 ? Math.floor(importedValue) : 0;
}

/**
 * Usa o item registrado no slot da PT (a mesma fonte usada durante a Quest) e
 * só recorre ao snapshot do personagem para PTs históricas que já foram
 * consolidadas antes de o vínculo de negociação existir.
 */
export function calculateAcquiredQuestDrops(party: PartyTab, characterId: string): string[] {
  const slotItem = normalizeText(party.slotData?.[characterId]?.itemDropado, 120);
  if (slotItem) return [slotItem];

  const questType: PtType = party.ptType === "sanguine" ? "sanguine" : "soulwar";
  const { itemField } = getProfitFieldsForQuest(questType);
  const importedItem = normalizeText(party.memberSnapshots?.[characterId]?.[itemField], 120);
  return importedItem ? [importedItem] : [];
}

/** Somente o adquirente escreve seus drops/lucros privados. */
export async function upsertCharacterAcquisitionBuyerDetails(input: {
  acquisitionId: string;
  acquirerUid: string;
  questType: PtType;
  questDrops: string[];
  questDropsSource?: "pt" | "buyer";
  questProfit: number;
  questProfitSource?: "pt" | "buyer";
  /** Mantém instante existente ou solicita Timestamp do servidor na criação. */
  questCompletedAt?: NegotiationTimestamp;
}): Promise<{ ok: boolean; record?: CharacterAcquisitionBuyerDetails; error?: string }> {
  const id = normalizeText(input.acquisitionId, 220);
  const acquirerUid = normalizeText(input.acquirerUid, 80);
  const questProfit = normalizeMoney(input.questProfit);
  if (!id || !acquirerUid || questProfit === null) return { ok: false, error: "Detalhes privados inválidos." };
  const record: CharacterAcquisitionBuyerDetails = {
    id,
    acquisitionId: id,
    acquirerUid,
    questType: input.questType,
    questDrops: Array.from(new Set((input.questDrops || []).map(item => normalizeText(item, 120)).filter(Boolean))).slice(0, 20),
    questDropsSource: input.questDropsSource === "buyer" ? "buyer" : "pt",
    questProfit,
    questProfitSource: input.questProfitSource === "buyer" ? "buyer" : "pt",
    questCompletedAt: input.questCompletedAt || optimisticTimestamp(),
    updatedAt: optimisticTimestamp(),
  };
  if (isSimulationMode || !db) {
    const records = readSimulationBuyerDetails();
    const index = records.findIndex(item => item.id === id);
    if (index >= 0) records[index] = record; else records.push(record);
    writeSimulationBuyerDetails(records);
    return { ok: true, record };
  }
  try {
    const ref = doc(db, BUYER_DETAILS_COLLECTION, id);
    await runTransaction(db, async transaction => {
      const shared = await transaction.get(doc(db, ACQUISITIONS_COLLECTION, id));
      if (!shared.exists() || shared.data().acquirerUid !== acquirerUid) throw new Error("Você não pode registrar os detalhes desta negociação.");
      transaction.set(ref, {
        ...record,
        questCompletedAt: timestampForWrite(input.questCompletedAt),
        updatedAt: serverTimestamp(),
      }, { merge: true });
    });
    return { ok: true, record };
  } catch (error: any) {
    return { ok: false, error: error?.message || "Não foi possível salvar os detalhes privados da Quest." };
  }
}

/** Retorna se o registro pertence ao escopo de leitura solicitado. */
export function matchesCharacterAcquisitionScope(record: CharacterAcquisition, scope: CharacterAcquisitionSubscriptionScope): boolean {
  const status = normalizeCharacterAcquisitionStatus(record.status);
  return scope === "pre_approved"
    ? status === "pre_approved"
    : CONFIRMED_CHARACTER_ACQUISITION_STATUSES.includes(status);
}

/**
 * Assina documentos compartilhados nas duas perspectivas, sem listeners por
 * personagem. `confirmed` é a fonte da guia/Stats; `pre_approved` só é aberto
 * enquanto o Gerenciador de PTs precisa exibir o aceite do comprador.
 */
export function subscribeCharacterAcquisitions(
  uid: string,
  callback: (records: CharacterAcquisition[]) => void,
  scope: CharacterAcquisitionSubscriptionScope = "confirmed",
): () => void {
  const viewerUid = normalizeText(uid, 80);
  if (!viewerUid) {
    callback([]);
    return () => {};
  }
  const sortRecords = (records: CharacterAcquisition[]) => records.sort((a, b) => toFirestoreMillis(b.updatedAt) - toFirestoreMillis(a.updatedAt));
  if (isSimulationMode || !db) {
    const emit = () => callback(sortRecords(readSimulationRecords().filter(record =>
      (record.originalOwnerUid === viewerUid || record.acquirerUid === viewerUid)
      && matchesCharacterAcquisitionScope(record, scope),
    )));
    emit();
    window.addEventListener(SIMULATION_EVENT, emit);
    return () => window.removeEventListener(SIMULATION_EVENT, emit);
  }

  let ownerRecords: CharacterAcquisition[] = [];
  let acquirerRecords: CharacterAcquisition[] = [];
  const emit = () => {
    const byId = new Map<string, CharacterAcquisition>();
    [...ownerRecords, ...acquirerRecords].forEach(record => byId.set(record.id, record));
    callback(sortRecords(Array.from(byId.values())));
  };
  const fromSnapshot = (snapshot: any): CharacterAcquisition[] => snapshot.docs.map((entry: any) => ({ id: entry.id, ...entry.data() } as CharacterAcquisition));
  const statusConstraint = scope === "pre_approved"
    ? where("status", "==", "pre_approved")
    : where("status", "in", CONFIRMED_CHARACTER_ACQUISITION_STATUSES);
  const unsubscribeOwner = onSnapshot(
    query(collection(db, ACQUISITIONS_COLLECTION), where("originalOwnerUid", "==", viewerUid), statusConstraint),
    snapshot => { ownerRecords = fromSnapshot(snapshot); emit(); },
    error => { console.error("Erro no listener de negociações do dono:", error); ownerRecords = []; emit(); },
  );
  const unsubscribeAcquirer = onSnapshot(
    query(collection(db, ACQUISITIONS_COLLECTION), where("acquirerUid", "==", viewerUid), statusConstraint),
    snapshot => { acquirerRecords = fromSnapshot(snapshot); emit(); },
    error => { console.error("Erro no listener de negociações do comprador:", error); acquirerRecords = []; emit(); },
  );
  return () => { unsubscribeOwner(); unsubscribeAcquirer(); };
}

/** Um listener agregado e privado para os dados de Quest do próprio adquirente. */
export function subscribeCharacterAcquisitionBuyerDetails(uid: string, callback: (records: CharacterAcquisitionBuyerDetails[]) => void): () => void {
  const viewerUid = normalizeText(uid, 80);
  if (!viewerUid) {
    callback([]);
    return () => {};
  }
  if (isSimulationMode || !db) {
    const emit = () => callback(readSimulationBuyerDetails().filter(record => record.acquirerUid === viewerUid).sort((a, b) => toFirestoreMillis(b.updatedAt) - toFirestoreMillis(a.updatedAt)));
    emit();
    window.addEventListener(SIMULATION_DETAILS_EVENT, emit);
    return () => window.removeEventListener(SIMULATION_DETAILS_EVENT, emit);
  }
  return onSnapshot(
    query(collection(db, BUYER_DETAILS_COLLECTION), where("acquirerUid", "==", viewerUid)),
    snapshot => {
      const records = snapshot.docs
        .map((entry: any) => ({ id: entry.id, ...entry.data() } as CharacterAcquisitionBuyerDetails))
        .sort((a, b) => toFirestoreMillis(b.updatedAt) - toFirestoreMillis(a.updatedAt));
      callback(records);
    },
    () => callback([]),
  );
}