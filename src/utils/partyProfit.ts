/**
 * partyProfit.ts
 * --------------
 * CÁLCULO CANÔNICO do que uma PT rendeu para cada personagem.
 *
 * FUNÇÃO PURA — sem React, sem Firebase, sem DOM.
 *
 * ── POR QUE ESTE MÓDULO EXISTE ──────────────────────────────────────────────
 * A regra de divisão estava escrita DUAS vezes, com resultados diferentes:
 *
 *   • `PartyPanel` (a tela, fonte visível da verdade):
 *       participantes = `split === true`
 *       valor         = floorTo25(total / n)      -> múltiplo de 25, p/ baixo
 *
 *   • `App.tsx` (Auto-Att, o que era gravado em Meus Personagens):
 *       participantes = `split !== false`         -> incluía quem nunca marcou
 *       valor         = Math.round(total / n)     -> valor inexistente na PT
 *
 * Efeito medido: numa PT de 3 membros com 1 sem `split` definido e total de
 * 1.900 RC, a tela mostrava 950 e Meus Personagens gravava 633 (−33%). Mesmo
 * com os divisores iguais, 5.300/3 dava 1.750 na tela e 1.767 no Auto-Att.
 *
 * Este módulo passa a ser a ÚNICA definição. `PartyPanel` continua exibindo o
 * que sempre exibiu; o Auto-Att passa a concordar com ele.
 *
 * ── NENHUMA REGRA DE NEGÓCIO NOVA ───────────────────────────────────────────
 * Tudo aqui é a regra que a tela já aplicava. A única mudança de comportamento
 * é o Auto-Att deixar de divergir dela.
 */

import type { PartyTab, PartySlotData } from "../types";

/** Para quem vai a participação da divisão (espelha `PartyPanel`). */
export type ProfitSplitTarget = "owner" | "player";

/**
 * Campos do slot usados no cálculo.
 *
 * Declarado localmente (em vez de importar `ExtendedPartySlotData` do
 * `PartyPanel`) para o módulo continuar puro: importar o painel traria React
 * junto e impediria os testes de rodarem em Node.
 */
export interface ProfitSlotData extends PartySlotData {
  splitTarget?: ProfitSplitTarget;
  ownerUid?: string;
}

/**
 * ARREDONDAMENTO PARA MÚLTIPLO DE 25 (sempre para BAIXO).
 *
 * Mesma definição de `floorTo25` em `PartyPanel`. Duplicada aqui de propósito:
 * importar do painel arrastaria React para dentro de um módulo puro. O teste
 * `auto-att-profit` compara as duas implementações em massa para garantir que
 * nunca divirjam.
 */
export function floorTo25Profit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value / 25) * 25;
}

/** Todos os ids de membros da PT (personagens + externos). */
export function getAllPartyMemberIds(party: PartyTab): string[] {
  return [
    ...(party.selectedIds || []),
    ...(party.customMembers || []).map(member => member.id),
  ];
}

/**
 * Quem participa da divisão.
 *
 * `split === true` — EXATAMENTE o critério de `PartyPanel`. Slot sem o campo
 * (`undefined`) NÃO entra: nunca foi marcado, então não deve dividir. O
 * Auto-Att usava `!== false` e inflava o número de divisores.
 */
export function getSplitMemberIds(party: PartyTab): string[] {
  const slotData = (party.slotData || {}) as Record<string, ProfitSlotData>;
  return getAllPartyMemberIds(party).filter(id => slotData[id]?.split === true);
}

/** Soma dos valores vendidos por quem está na divisão. */
export function getSplitTotal(party: PartyTab): number {
  const slotData = (party.slotData || {}) as Record<string, ProfitSlotData>;
  return getSplitMemberIds(party).reduce(
    (sum, id) => sum + (slotData[id]?.itemVendido || 0),
    0,
  );
}

/**
 * Valor individual da divisão — o mesmo `dropPerSplit` exibido na guia da PT.
 */
export function getSplitValuePerMember(party: PartyTab): number {
  const members = getSplitMemberIds(party);
  if (members.length === 0) return 0;
  return floorTo25Profit(getSplitTotal(party) / members.length);
}

/** Uma entrada de lucro a ser transportada via `sharedCharacters`. */
export interface PartyProfitEntry {
  /** Quest da PT — define se o lucro vai para `dropSW` (Lucro SW) ou `dropBakra` (Lucro SG). */
  questType: "soulwar" | "sanguine";
  /** Valor final do lucro para aquele personagem (já resolvido divisão/cheio). */
  lucro: number;
}

/**
 * Calcula o lucro final de CADA personagem participante diretamente do
 * `slotData` da PT (não precisa da lista pessoal do dono). O líder usa isto
 * para transportar o valor via `sharedCharacters` até o dono.
 *
 * Só inclui entradas com `lucro > 0` — personagem sem valor em RC (ou com
 * DIVIDIR cujo split deu 0) não gera entrada, preservando a regra "sem valor
 * não altera o lucro".
 */
export function computePartyProfitMap(party: PartyTab): Record<string, PartyProfitEntry> {
  const map: Record<string, PartyProfitEntry> = {};
  (party.selectedIds || []).forEach(id => {
    const slot = (party.slotData || {})[id];
    // Services exclusivos não devem ser espelhados em Meus Personagens.
    if (slot?.isService === true) return;
    const profit = computeCharacterProfit(party, id);
    if (profit.lucro <= 0) return;
    map[id] = {
      questType: party.ptType === "sanguine" ? "sanguine" : "soulwar",
      lucro: profit.lucro,
    };
  });
  return map;
}

/** Resultado do cálculo para um personagem específico. */
export interface CharacterProfit {
  /** Item dropado pelo personagem na PT ("" quando não houve). */
  itemDropado: string;
  /** Quanto o personagem rendeu, já resolvido (divisão ou valor cheio). */
  lucro: number;
  /** true quando o personagem participa da divisão. */
  inSplit: boolean;
  /**
   * true quando o personagem participou, mas a cota foi destinada a OUTRA
   * pessoa (`splitTarget: "player"` num personagem emprestado).
   */
  redirectedToPlayer: boolean;
}

/**
 * Quanto a PT rendeu para UM personagem.
 *
 * Regras, todas já vigentes na tela:
 *   • na divisão   -> recebe o valor individual (`dropPerSplit`);
 *   • fora dela    -> recebe o próprio `itemVendido`;
 *   • sem slot     -> zero.
 *
 * ── DESTINATÁRIO DA DIVISÃO ────────────────────────────────────────────────
 * Quando o personagem é emprestado e o dono escolheu destinar a cota ao
 * JOGADOR (`splitTarget: "player"`), o lucro NÃO é creditado ao dono: quem
 * recebe os RC é o jogador. Creditar mesmo assim inflaria o lucro de quem não
 * recebeu nada.
 *
 * `splitTarget` ausente (PTs antigas e o caso dono == jogador) resolve para
 * "owner", preservando o comportamento anterior.
 */
export function computeCharacterProfit(
  party: PartyTab,
  characterId: string,
): CharacterProfit {
  const slotData = (party.slotData || {}) as Record<string, ProfitSlotData>;
  const slot = slotData[characterId];

  if (!slot) {
    return { itemDropado: "", lucro: 0, inSplit: false, redirectedToPlayer: false };
  }

  const itemDropado = String(slot.itemDropado || "").trim();
  const inSplit = slot.split === true;

  // Negociação de aquisição temporária: o dono original continua no slot, mas
  // os direitos financeiros foram registrados em `characterAcquisitions` para
  // o JOGADOR/adquirente. Nem lucro NEM item da Quest podem ser espelhados no
  // Character do dono; ambos ficam no documento privado do adquirente.
  if (slot.characterAcquisitionId) {
    return { itemDropado: "", lucro: 0, inSplit, redirectedToPlayer: true };
  }

  // Cota destinada ao jogador: o dono do personagem não recebe.
  const redirectedToPlayer = inSplit && slot.splitTarget === "player";
  if (redirectedToPlayer) {
    return { itemDropado, lucro: 0, inSplit, redirectedToPlayer };
  }

  const lucro = inSplit
    ? getSplitValuePerMember(party)
    : (slot.itemVendido || 0);

  return { itemDropado, lucro, inSplit, redirectedToPlayer };
}

/** Campos de Meus Personagens escritos por este cálculo, por tipo de Quest. */
export interface ProfitTargetFields {
  itemField: "itemDropadoSW" | "itemDropadoSG";
  valueField: "dropSW" | "dropBakra";
}

export function getProfitFieldsForQuest(questType: "soulwar" | "sanguine"): ProfitTargetFields {
  return questType === "soulwar"
    ? { itemField: "itemDropadoSW", valueField: "dropSW" }
    : { itemField: "itemDropadoSG", valueField: "dropBakra" };
}

/** Patch a aplicar num personagem (vazio = nada mudou). */
export type CharacterProfitPatch = Partial<{
  itemDropadoSW: string;
  itemDropadoSG: string;
  dropSW: number;
  dropBakra: number;
}>;

/**
 * Monta o patch de um personagem — e devolve `{}` quando nada mudou.
 *
 * O patch vazio é o que mantém o custo em Firestore perto de zero: sem
 * diferença real, `setData` não é chamado, o array `characters` não muda, a
 * guarda de igualdade de `userCharacters` corta o write e a franquia não é
 * consumida.
 *
 * ── PROTEÇÕES ──────────────────────────────────────────────────────────────
 *  1. Valor 0/vazio nunca sobrescreve um valor já preenchido. Uma PT em edição
 *     passa por estados intermediários zerados; apagar o histórico do
 *     personagem por causa deles seria destrutivo.
 *  2. `dropsValuesSaved` (dados travados na PT) impede qualquer alteração —
 *     mesma proteção que a tela aplica aos campos da calculadora.
 */
export function buildCharacterProfitPatch(
  party: PartyTab,
  character: { id: string; itemDropadoSW?: string; itemDropadoSG?: string; dropSW: number; dropBakra: number },
  questType: "soulwar" | "sanguine",
): CharacterProfitPatch {
  const { itemField, valueField } = getProfitFieldsForQuest(questType);
  const profit = computeCharacterProfit(party, character.id);
  const patch: CharacterProfitPatch = {};

  // Item dropado: só grava quando há nome. Nunca limpa o que já existe.
  if (profit.itemDropado && character[itemField] !== profit.itemDropado) {
    patch[itemField] = profit.itemDropado;
  }

  // Lucro: só grava valor positivo e diferente do atual.
  if (profit.lucro > 0 && (character[valueField] || 0) !== profit.lucro) {
    patch[valueField] = profit.lucro;
  }

  return patch;
}

/** true quando os valores da PT foram travados e não devem mais ser espelhados. */
export function isPartyValuesLocked(party: PartyTab): boolean {
  return party.dropsValuesSaved === true;
}

/**
 * Aplica o espelhamento a uma lista de personagens.
 *
 * Devolve `changed: false` quando NENHUM personagem mudou — sinal para o
 * chamador não tocar no estado e, por consequência, não gerar write.
 *
 * Só personagens presentes em `selectedIds` são considerados: o id do slot é o
 * id do personagem, então membros externos e Services ficam naturalmente de
 * fora (não existem em Meus Personagens).
 */
export function applyPartyProfitToCharacters<
  T extends { id: string; itemDropadoSW?: string; itemDropadoSG?: string; dropSW: number; dropBakra: number },
>(
  party: PartyTab,
  characters: T[],
  questType: "soulwar" | "sanguine",
): { characters: T[]; changed: boolean; updatedIds: string[] } {
  if (isPartyValuesLocked(party)) {
    return { characters, changed: false, updatedIds: [] };
  }

  const partyMemberIds = new Set(party.selectedIds || []);
  const updatedIds: string[] = [];

  const next = characters.map(character => {
    if (!partyMemberIds.has(character.id)) return character;
    const patch = buildCharacterProfitPatch(party, character, questType);
    if (Object.keys(patch).length === 0) return character;
    updatedIds.push(character.id);
    return { ...character, ...patch };
  });

  // Sem nenhuma mudança, devolve o array ORIGINAL (mesma referência).
  // `.map()` sempre cria um array novo, e uma referência nova faria o React
  // re-renderizar e o efeito de `userCharacters` reavaliar à toa. Devolver o
  // original mantém o custo em zero de verdade — inclusive de renderização.
  if (updatedIds.length === 0) {
    return { characters, changed: false, updatedIds };
  }

  return { characters: next, changed: true, updatedIds };
}