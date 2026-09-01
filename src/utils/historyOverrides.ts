import type { PersonalPartyHistorySlot } from "../types";

/**
 * Correções LOCAIS do usuário sobre a projeção do seu histórico privado
 * (users/{uid}/partyHistory — somente leitura para o cliente, gravada pelo
 * backend). As correções moram num documento apartado
 * (users/{uid}/partyHistoryOverrides/{partyId}) que o backend NUNCA toca, então
 * uma reprojeção não as apaga.
 *
 * Regras de negócio (tarefa do histórico):
 * - Os dados importados permanecem o PADRÃO: sem chave no mapa, o valor da
 *   projeção é o exibido.
 * - Chave presente = correção manual do dono da conta: passa a ser a
 *   informação exibida no histórico (e nos resumos derivados).
 * - A correção é de exibição privada: não altera a PT, a divisão oficial nem
 *   o que outros usuários veem.
 */
export interface PartyHistoryOverrides {
  /** slotId → item dropado corrigido ("" = sem drop). */
  drops?: Record<string, string>;
  /** slotId → lucro corrigido em RC (0 = sem lucro). */
  profits?: Record<string, number>;
}

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/** Normaliza um documento do Firestore para a forma segura de uso no render. */
export function sanitizeHistoryOverrides(raw: unknown): PartyHistoryOverrides {
  const doc = asRecord(raw);
  const drops: Record<string, string> = {};
  for (const [slotId, value] of Object.entries(asRecord(doc.drops))) {
    if (typeof value === "string" && value.length <= 60) drops[slotId] = value;
  }
  const profits: Record<string, number> = {};
  for (const [slotId, value] of Object.entries(asRecord(doc.profits))) {
    const num = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(num) && num >= 0 && num <= 999999999) profits[slotId] = Math.floor(num);
  }
  return { drops, profits };
}

/**
 * Slot de exibição: o valor importado é o padrão; existindo correção manual
 * (mesmo vazia/zero), ela prevalece. Retorna um NOVO slot — o original nunca
 * é mutado.
 */
export function applySlotOverrides(
  slot: PersonalPartyHistorySlot,
  overrides?: PartyHistoryOverrides,
): PersonalPartyHistorySlot {
  if (!overrides) return slot;
  const dropOverride = overrides.drops?.[slot.slotId];
  const profitOverride = overrides.profits?.[slot.slotId];
  if (dropOverride === undefined && profitOverride === undefined) return slot;
  return {
    ...slot,
    itemDropado: dropOverride !== undefined ? dropOverride : slot.itemDropado,
    itemVendido: profitOverride !== undefined ? profitOverride : slot.itemVendido,
  };
}

/** Este slot possui alguma correção manual ativa (Drop ou Lucro)? */
export function hasSlotOverride(slotId: string, overrides?: PartyHistoryOverrides): boolean {
  if (!overrides) return false;
  return overrides.drops?.[slotId] !== undefined || overrides.profits?.[slotId] !== undefined;
}

/**
 * Documento canônico gravado em users/{uid}/partyHistoryOverrides/{partyId}.
 * Sempre completo (gravação inteira do próprio doc — só o dono da conta
 * escreve) e validado pelo formato exigido nas regras do Firestore:
 * hasOnly([partyId, drops, profits, updatedAt]).
 */
export function buildOverrideDoc(
  partyId: string,
  overrides: PartyHistoryOverrides,
  updatedAtMs: number,
): { partyId: string; drops: Record<string, string>; profits: Record<string, number>; updatedAt: number } {
  return {
    partyId,
    drops: { ...overrides.drops },
    profits: { ...overrides.profits },
    updatedAt: Math.max(0, Math.floor(updatedAtMs) || 0),
  };
}

/** Limite superior aceito para um lucro manual (RC). */
export const MAX_MANUAL_PROFIT_RC = 999999999;