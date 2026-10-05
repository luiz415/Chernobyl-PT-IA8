import type { Character, PartyTab } from "../types";
import { toFirestoreMillis } from "./firestoreTimestamp";

// ============================================================================
// SANGUINE — ROTAÇÕES, "DROP?" E COOLDOWN DO BAKRAGORE (fonte única)
// ----------------------------------------------------------------------------
// Regras do fluxo reformulado da Quest Sanguine:
//
//   • `Character.sgRot` = quantidade de ROTAÇÕES CONCLUÍDAS (0/ausente =
//     nunca registrou rotação → "Meus Personagens" exibe "-").
//   • `Character.sgDropRot` = rotação em que o DROP ocorreu (resultado da
//     última rotação): igual a `sgRot` → última rotação teve drop (VERDE);
//     diferente/ausente → sem drop (VERMELHO, precisa de outra rotação).
//   • No Party Panel, a coluna "Rot SG" mostra a rotação que o personagem
//     FARÁ naquela PT: SEMPRE `rotações concluídas + 1`.
//   • A conclusão da PT NÃO altera a disponibilidade da SG de ninguém — o
//     resultado é informado POR PERSONAGEM na coluna "Drop?" do PartyPanel.
//   • Drop? = SIM ou NÃO → a rotação feita na PT entra na contagem
//     (`sgRot = rotação da PT`); SIM registra `sgDropRot` e marca a SG como
//     realizada; NÃO mantém a SG disponível e liga o cooldown de 72h do
//     Bakragore contado da CONCLUSÃO da Quest (timestamp absoluto —
//     confiável entre dispositivos e fusos).
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

/** Normaliza uma ROTAÇÃO DE PT (1-based): inteiro >= 1; ausente/inválido = 1. */
export function normalizeSgRot(value: unknown): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return 1;
  const int = Math.floor(num);
  return int >= 1 ? int : 1;
}

/**
 * ROTAÇÕES CONCLUÍDAS de um personagem (`Character.sgRot`): inteiro >= 0.
 * 0/ausente = o personagem NUNCA teve uma rotação registrada ("Meus
 * Personagens" exibe "-"). A rotação que ele fará numa PT é SEMPRE
 * `concluídas + 1` — essa distinção (quantidade realizada × rotação da PT)
 * é a base de toda a exibição/contabilização.
 */
export function completedSgRotations(value: unknown): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return 0;
  const int = Math.floor(num);
  return int >= 0 ? int : 0;
}

/** Alvo ABSOLUTO de reconciliação de um personagem após a resposta "Drop?". */
export interface SanguineOutcomeTarget {
  /** Disponibilidade resultante da SG (true = disponível). */
  sanguine: boolean;
  /**
   * ROTAÇÕES CONCLUÍDAS resultantes (`Character.sgRot`): a rotação feita na
   * PT entra na contagem COM ou SEM drop — concluir a Nª rotação deixa o
   * personagem com N rotações registradas.
   */
  sgRot: number;
  /**
   * Fim do cooldown do Bakragore (epoch ms) quando Drop=Não; `null` quando a
   * resposta não define cooldown (Drop=Sim) — nesse caso o valor existente do
   * personagem NÃO é alterado (não-destrutivo).
   */
  sgBakraCooldownUntil: number | null;
  /**
   * Rotação em que o DROP ocorreu (Drop=Sim): registrada no personagem para
   * as colunas "Rot SG" exibirem a rotação em VERDE. `null` quando a
   * resposta não registra drop (Drop=Não) — valor existente não é alterado.
   */
  sgDropRot: number | null;
}

/**
 * Calcula o alvo determinístico de um personagem a partir da resposta Drop?.
 *
 * @param sgDrop        resposta da coluna "Drop?" (true = dropou).
 * @param partyRotation rotação FEITA nesta PT (1-based), CONGELADA na
 *                      conclusão da Quest (`slot.sgRotBase`) — base fixa
 *                      torna o cálculo idempotente.
 * @param conclusionAt  epoch ms da conclusão da Quest (`questFinalizedAt`).
 *
 * Em AMBAS as respostas o personagem termina com `sgRot = partyRotation`
 * rotações concluídas (a rotação foi realizada — o que muda é o resultado):
 *   • Drop=Sim → SG realizada; `sgDropRot` registra a rotação do drop
 *     (exibição em VERDE enquanto for a última rotação);
 *   • Drop=Não → SG continua disponível (próxima rotação necessária —
 *     exibição em VERMELHO) + cooldown de 72h do Bakragore.
 */
export function computeSanguineOutcome(sgDrop: boolean, partyRotation: unknown, conclusionAt: number): SanguineOutcomeTarget {
  const rot = normalizeSgRot(partyRotation);
  if (sgDrop) {
    return { sanguine: false, sgRot: rot, sgBakraCooldownUntil: null, sgDropRot: rot };
  }
  const base = Number.isFinite(conclusionAt) && conclusionAt > 0 ? conclusionAt : 0;
  return {
    sanguine: true,
    sgRot: rot,
    sgBakraCooldownUntil: base > 0 ? base + SG_BAKRA_COOLDOWN_MS : null,
    sgDropRot: null,
  };
}

/** PT Sanguine concluída com sucesso (única situação em que Drop? vale algo). */
export function isConcludedSanguineParty(party: Pick<PartyTab, "ptType" | "questConcluida" | "questFalha">): boolean {
  return party.ptType === "sanguine" && !!party.questConcluida && !party.questFalha;
}

/**
 * Rotação FEITA na PT (1-based): o SNAPSHOT IMUTÁVEL congelado na CONCLUSÃO
 * da Quest. Prioridade: `slot.sgRotBase` (gravado explicitamente na
 * conclusão — sobrevive inclusive ao arquivo sanitizado da finalização) →
 * `sgRot` do memberSnapshot (legado 1-based de PTs antigas sem `sgRotBase`)
 * → rotação planejada da PT ("Próxima Rotação") → 1ª.
 * A contabilização posterior NUNCA depende do `sgRot` atual do personagem,
 * que pode ser alterado por outros fluxos depois da conclusão.
 */
export function sanguineSlotBaseRot(party: PartyTab, charId: string): number {
  const slot = party.slotData?.[charId];
  if (typeof slot?.sgRotBase === "number" && slot.sgRotBase >= 1) return normalizeSgRot(slot.sgRotBase);
  const snapRot = party.memberSnapshots?.[charId]?.sgRot;
  if (typeof snapRot === "number" && snapRot >= 1) return normalizeSgRot(snapRot);
  if (typeof slot?.sgRotPlanned === "number" && slot.sgRotPlanned >= 1) return normalizeSgRot(slot.sgRotPlanned);
  return 1;
}

/**
 * Rotação do personagem NO CONTEXTO de uma PT Sanguine:
 *   • PT concluída → a rotação CONGELADA na conclusão (histórico imutável);
 *   • PT em aberto → a rotação em que o personagem ENTRARÁ: o personagem
 *     vivo (fonte da verdade — "Meus Personagens"/compartilhados) ou, se o
 *     dono ainda não refletiu o resultado da PT anterior, a rotação
 *     PLANEJADA gravada na criação via "Próxima Rotação" (a maior vale).
 */
export function sanguineRotationInParty(party: PartyTab, charId: string, liveChar?: Character | null): number {
  if (party.ptType !== "sanguine") return 1;
  if (party.questConcluida) return sanguineSlotBaseRot(party, charId);
  const slot = party.slotData?.[charId];
  // Rotação que o personagem FARÁ nesta PT = rotações CONCLUÍDAS registradas
  // em "Meus Personagens" + 1 (sem registro = 1ª rotação).
  const completed = completedSgRotations(liveChar?.sgRot ?? party.memberSnapshots?.[charId]?.sgRot);
  const planned = slot?.sgRotPlanned;
  return Math.max(completed + 1, typeof planned === "number" ? normalizeSgRot(planned) : 1);
}

/**
 * CONFLITO "personagem em outra PT" — regra por Quest + Rotação.
 *
 * O personagem presente em `otherParty` só conta como conflito para
 * `currentParty` quando:
 *   • a outra PT ainda NÃO foi concluída (concluída = compromisso cumprido);
 *   • as duas PTs são da MESMA Quest (quests diferentes nunca conflitam
 *     entre si quando ambas estão definidas);
 *   • e, sendo ambas Sanguine, o personagem está na MESMA rotação nas duas
 *     (1ª rotação numa PT e 2ª noutra = sequência legítima, sem conflito).
 * PT sem Quest definida mantém o comportamento conservador (conflita).
 */
export function partiesConflictForCharacter(
  currentParty: PartyTab,
  otherParty: PartyTab,
  charId: string,
  liveChar?: Character | null,
): boolean {
  if (otherParty.archived || otherParty.questConcluida) return false;
  const currentQuest = currentParty.ptType;
  const otherQuest = otherParty.ptType;
  // Quests definidas e DIFERENTES: sem conflito.
  if (currentQuest && otherQuest && currentQuest !== otherQuest) return false;
  // Ambas Sanguine: conflito somente na MESMA rotação.
  if (currentQuest === "sanguine" && otherQuest === "sanguine") {
    return sanguineRotationInParty(currentParty, charId, liveChar)
      === sanguineRotationInParty(otherParty, charId, liveChar);
  }
  return true;
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
  const currentRot = completedSgRotations(character.sgRot);
  const cooldownChanged = target.sgBakraCooldownUntil !== null
    && (character.sgBakraCooldownUntil || 0) !== target.sgBakraCooldownUntil;
  const dropRotChanged = target.sgDropRot !== null
    && (character.sgDropRot || 0) !== target.sgDropRot;
  const changed = character.sanguine !== target.sanguine
    || currentRot !== target.sgRot
    || cooldownChanged
    || dropRotChanged;
  if (!changed) return null;
  const next: Character = { ...character, sanguine: target.sanguine, sgRot: target.sgRot };
  if (target.sgBakraCooldownUntil !== null) next.sgBakraCooldownUntil = target.sgBakraCooldownUntil;
  if (target.sgDropRot !== null) next.sgDropRot = target.sgDropRot;
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
  /** Rotação em que o drop ocorreu — omitido quando Drop=Não. */
  sgDropRot?: number;
}

/** Monta o mapa de transporte (charId → entrada SG) de uma PT concluída. */
export function collectSanguineTransportMap(party: PartyTab): Record<string, SanguineTransportEntry> {
  const targets = collectSanguineOutcomes(party);
  const result: Record<string, SanguineTransportEntry> = {};
  Object.entries(targets).forEach(([charId, target]) => {
    const sgDrop = party.slotData?.[charId]?.sgDrop === true;
    const entry: SanguineTransportEntry = { questType: "sanguine", sgDrop, sgRot: target.sgRot };
    if (target.sgBakraCooldownUntil !== null) entry.sgCooldownUntil = target.sgBakraCooldownUntil;
    if (target.sgDropRot !== null) entry.sgDropRot = target.sgDropRot;
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
  const dropRot = typeof raw.sgDropRot === "number" && raw.sgDropRot >= 1 ? normalizeSgRot(raw.sgDropRot) : null;
  return {
    sanguine: !raw.sgDrop,
    sgRot: normalizeSgRot(raw.sgRot),
    sgBakraCooldownUntil: cooldown,
    sgDropRot: dropRot,
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
