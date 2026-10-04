import type { Character, PartyTab } from "../types";
import { toFirestoreMillis } from "./firestoreTimestamp";

// ============================================================================
// SANGUINE — ROTAÇÕES, "DROP?" E COOLDOWN DO BAKRAGORE (fonte única)
// ----------------------------------------------------------------------------
// Regras do fluxo reformulado da Quest Sanguine:
//
//   • Cada personagem tem uma ROTAÇÃO ATUAL (`Character.sgRot`, 1 = primeira).
//   • A conclusão da PT NÃO altera a disponibilidade da SG de ninguém — o
//     resultado é informado POR PERSONAGEM na coluna "Drop?" do PartyPanel.
//   • Drop? = SIM  → SG realizada (sanguine=false); a rotação MANTÉM o valor.
//   • Drop? = NÃO  → SG continua disponível (sanguine=true); a rotação avança
//     (+1) e o Bakragore entra em cooldown de 72h contados da CONCLUSÃO da
//     Quest (timestamp absoluto — confiável entre dispositivos e fusos).
//
// Este módulo é PURO (sem Firebase/React): todo cálculo de alvo (`target`) é
// determinístico — f(resposta, rotação-base congelada na conclusão, momento da
// conclusão). Reaplicar o mesmo alvo nunca duplica incremento: alternar
// Sim ↔ Não apenas reconcilia o personagem para o novo alvo absoluto.
//
// Consumidores:
//   • App.tsx — efeito que reconcilia os PRÓPRIOS personagens ao observar a
//     PT (online) e transporte cross-user via `sharedCharacters.partyProfit`
//     (donos offline), além do fluxo Att Chars;
//   • PartyPanel.tsx / CharTable.tsx — exibição da rotação e do contador
//     regressivo do cooldown.
// ============================================================================

/** Cooldown do boss Bakragore após a conclusão da rotação: 72 horas. */
export const SG_BAKRA_COOLDOWN_MS = 72 * 60 * 60 * 1000;

/** Normaliza a rotação: inteiro >= 1; ausente/invalido = 1 (primeira). */
export function normalizeSgRot(value: unknown): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return 1;
  const int = Math.floor(num);
  return int >= 1 ? int : 1;
}

/** Alvo ABSOLUTO de reconciliação de um personagem após a resposta "Drop?". */
export interface SanguineOutcomeTarget {
  /** Disponibilidade resultante da SG (true = disponível). */
  sanguine: boolean;
  /** Rotação resultante (Drop=Sim mantém; Drop=Não avança +1). */
  sgRot: number;
  /**
   * Fim do cooldown do Bakragore (epoch ms) quando Drop=Não; `null` quando a
   * resposta não define cooldown (Drop=Sim) — nesse caso o valor existente do
   * personagem NÃO é alterado (não-destrutivo).
   */
  sgBakraCooldownUntil: number | null;
}

/**
 * Calcula o alvo determinístico de um personagem a partir da resposta Drop?.
 *
 * @param sgDrop       resposta da coluna "Drop?" (true = dropou).
 * @param baseRot      rotação do personagem CONGELADA na conclusão da Quest
 *                     (memberSnapshots) — base fixa torna o cálculo idempotente.
 * @param conclusionAt epoch ms da conclusão da Quest (`questFinalizedAt`).
 */
export function computeSanguineOutcome(sgDrop: boolean, baseRot: unknown, conclusionAt: number): SanguineOutcomeTarget {
  const rot = normalizeSgRot(baseRot);
  if (sgDrop) {
    // Dropou: SG realizada; rotação mantida (decisão de negócio confirmada).
    return { sanguine: false, sgRot: rot, sgBakraCooldownUntil: null };
  }
  const base = Number.isFinite(conclusionAt) && conclusionAt > 0 ? conclusionAt : 0;
  return {
    sanguine: true,
    sgRot: rot + 1,
    sgBakraCooldownUntil: base > 0 ? base + SG_BAKRA_COOLDOWN_MS : null,
  };
}

/** PT Sanguine concluída com sucesso (única situação em que Drop? vale algo). */
export function isConcludedSanguineParty(party: Pick<PartyTab, "ptType" | "questConcluida" | "questFalha">): boolean {
  return party.ptType === "sanguine" && !!party.questConcluida && !party.questFalha;
}

/**
 * Rotação-base de um slot: a rotação do personagem congelada no snapshot da
 * conclusão. Snapshots antigos/externos sem o campo contam como 1ª rotação.
 */
export function sanguineSlotBaseRot(party: PartyTab, charId: string): number {
  return normalizeSgRot(party.memberSnapshots?.[charId]?.sgRot);
}

/**
 * Alvos de TODOS os slots com resposta definida de uma PT Sanguine concluída.
 * Slots sem resposta ficam de fora — "sem resposta" nunca altera personagem.
 */
export function collectSanguineOutcomes(party: PartyTab): Record<string, SanguineOutcomeTarget> {
  const result: Record<string, SanguineOutcomeTarget> = {};
  if (!isConcludedSanguineParty(party)) return result;
  const conclusionAt = toFirestoreMillis(party.questFinalizedAt);
  (party.selectedIds || []).forEach(charId => {
    const sgDrop = party.slotData?.[charId]?.sgDrop;
    if (typeof sgDrop !== "boolean") return;
    result[charId] = computeSanguineOutcome(sgDrop, sanguineSlotBaseRot(party, charId), conclusionAt);
  });
  return result;
}

/**
 * Reconcilia UM personagem para o alvo. Devolve o personagem NOVO quando algo
 * mudou, ou `null` quando já está no alvo (nenhum write necessário).
 *
 * `sgBakraCooldownUntil === null` no alvo significa "não alterar" — o valor
 * existente (de uma rotação anterior) é preservado.
 */
export function applySanguineOutcomeToCharacter(character: Character, target: SanguineOutcomeTarget): Character | null {
  const currentRot = normalizeSgRot(character.sgRot);
  const cooldownChanged = target.sgBakraCooldownUntil !== null
    && (character.sgBakraCooldownUntil || 0) !== target.sgBakraCooldownUntil;
  const changed = character.sanguine !== target.sanguine
    || currentRot !== target.sgRot
    || cooldownChanged;
  if (!changed) return null;
  const next: Character = { ...character, sanguine: target.sanguine, sgRot: target.sgRot };
  if (target.sgBakraCooldownUntil !== null) next.sgBakraCooldownUntil = target.sgBakraCooldownUntil;
  return next;
}

/**
 * Reconcilia uma lista de personagens contra os alvos de uma PT. Personagens
 * fora da PT (ou sem resposta) ficam intocados. `changed: false` => mesma
 * referência de array => nenhum write.
 */
export function applySanguineOutcomesToCharacters(
  party: PartyTab,
  characters: Character[],
): { changed: boolean; characters: Character[]; appliedCharIds: string[] } {
  const targets = collectSanguineOutcomes(party);
  if (Object.keys(targets).length === 0) return { changed: false, characters, appliedCharIds: [] };
  let changed = false;
  const appliedCharIds: string[] = [];
  const next = characters.map(character => {
    const target = targets[character.id];
    if (!target) return character;
    const updated = applySanguineOutcomeToCharacter(character, target);
    if (!updated) return character;
    changed = true;
    appliedCharIds.push(character.id);
    return updated;
  });
  return changed ? { changed, characters: next, appliedCharIds } : { changed: false, characters, appliedCharIds: [] };
}

/**
 * Entrada de transporte SG gravada em `sharedCharacters/{dono}.partyProfit`
 * (único canal cross-user permitido pelas Firestore Rules para não-donos),
 * ao lado dos campos de lucro já existentes. Carrega o ALVO absoluto — o
 * dono aplica sem precisar da PT (que é apagada na finalização).
 */
export interface SanguineTransportEntry {
  questType: "sanguine";
  sgDrop: boolean;
  sgRot: number;
  /** Omitido quando a resposta não define cooldown (Drop=Sim). */
  sgCooldownUntil?: number;
}

/** Monta o mapa de transporte (charId → entrada SG) de uma PT concluída. */
export function collectSanguineTransportMap(party: PartyTab): Record<string, SanguineTransportEntry> {
  const targets = collectSanguineOutcomes(party);
  const result: Record<string, SanguineTransportEntry> = {};
  Object.entries(targets).forEach(([charId, target]) => {
    const sgDrop = party.slotData?.[charId]?.sgDrop === true;
    const entry: SanguineTransportEntry = { questType: "sanguine", sgDrop, sgRot: target.sgRot };
    if (target.sgBakraCooldownUntil !== null) entry.sgCooldownUntil = target.sgBakraCooldownUntil;
    result[charId] = entry;
  });
  return result;
}

/**
 * Converte uma entrada de transporte recebida (dados brutos do Firestore) no
 * alvo absoluto. Devolve `null` quando a entrada não é um transporte SG
 * válido (ex.: entrada apenas de lucro).
 */
export function sanguineTargetFromTransport(entry: unknown): SanguineOutcomeTarget | null {
  if (!entry || typeof entry !== "object") return null;
  const raw = entry as Record<string, unknown>;
  if (raw.questType !== "sanguine" || typeof raw.sgDrop !== "boolean") return null;
  const cooldown = typeof raw.sgCooldownUntil === "number" && raw.sgCooldownUntil > 0 ? raw.sgCooldownUntil : null;
  return {
    sanguine: !raw.sgDrop,
    sgRot: normalizeSgRot(raw.sgRot),
    sgBakraCooldownUntil: cooldown,
  };
}

/** Cooldown ativo? (contador exibido apenas enquanto não expirar) */
export function isSgCooldownActive(until: number | undefined, now: number): boolean {
  return typeof until === "number" && until > now;
}

/**
 * Texto curto do contador regressivo ("71h 59m", "45m", "<1m") — discreto,
 * para caber ao lado da rotação sem alargar as colunas.
 */
export function formatSgCooldownRemaining(until: number, now: number): string {
  const remaining = Math.max(0, until - now);
  const totalMinutes = Math.floor(remaining / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m`;
  return "<1m";
}

/** Título/tooltip com a data-hora absoluta do fim do cooldown. */
export function describeSgCooldown(until: number): string {
  const when = new Date(until).toLocaleString("pt-BR", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
  return `Boss Bakragore indisponível até ${when} (cooldown de 72h após a conclusão da rotação).`;
}
