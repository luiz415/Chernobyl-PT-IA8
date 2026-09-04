import type { Character, WaitingService, PartyTab, PtType } from "../types";

// ============================================================================
// ELEGIBILIDADE POR QUEST ALVO — fonte única
// ----------------------------------------------------------------------------
// Regra de contabilização de personagens/services conforme a "Quest Alvo"
// selecionada nos filtros (Todas / Soul War / Sanguine).
//
// Consumida por TODOS os pontos que contam "disponíveis":
//   • OverviewPanel  (via analyzeServerPotential);
//   • Resumo de Amigos / coluna VOC (via buildVocationCountsByServer).
//
// Garante que os três quadros usem EXATAMENTE a mesma regra, sem divergência.
// ============================================================================

export type QuestFilter = "soulwar" | "sanguine" | "all";

/**
 * Um personagem (`Character`) só é contabilizado se atender à Quest Alvo.
 *
 *   • "soulwar"  → Soul War disponível.
 *   • "sanguine" → Sanguine disponível.
 *   • "all"      → AMBAS disponíveis (Soul War E Sanguine).
 *
 * O campo `soulwar`/`sanguine` é o marcador de "disponível" usado em todo o
 * app (probableMarkers já o forçam a `false` quando a quest provavelmente foi
 * concluída em `availableCharactersForParty`).
 */
export function characterQuestEligible(character: Character, questFilter: QuestFilter): boolean {
  if (questFilter === "soulwar") return !!character.soulwar;
  if (questFilter === "sanguine") return !!character.sanguine;
  // "all": exige as duas disponíveis.
  return !!character.soulwar && !!character.sanguine;
}

/**
 * Um service (`WaitingService`) é de UMA quest específica.
 *
 *   • "soulwar"  → só services de Soul War.
 *   • "sanguine" → só services de Sanguine.
 *   • "all"      → qualquer service conta (cada um atende a uma das duas quests).
 */
export function serviceQuestEligible(service: WaitingService, questFilter: QuestFilter): boolean {
  if (questFilter === "soulwar") return service.quest === "soulwar";
  if (questFilter === "sanguine") return service.quest === "sanguine";
  return true;
}
// ============================================================================
// OCUPAÇÃO POR QUEST — "em PT" só bloqueia a MESMA Quest
// ----------------------------------------------------------------------------
// Antes, qualquer personagem/service presente em uma PT ativa era considerado
// indisponível para TODAS as Quests. A regra correta: quem está numa PT de
// Sanguine continua disponível para uma PT de Soul War (e vice-versa) — só a
// PT cuja Quest é IGUAL à Quest alvo ocupa o personagem.
//
// Estes helpers são a fonte única dessa regra, consumidos por:
//   • suggestionAlgorithm (Sugerir PT / composição sugerida);
//   • SuggestPartyModal   (quadro de vocações e contagem por servidor);
//   • FriendsSummaryModal (Resumo de Amigos, via buildVocationCountsByServer);
//   • OverviewPanel       (Visão Geral);
//   • BazarPanel          (prioridade de compra por servidor).
// ============================================================================

/**
 * Decide se uma PT "ocupa" seus participantes para a Quest alvo.
 *
 *   • PT arquivada nunca ocupa (histórico);
 *   • PT sem Quest definida ocupa QUALQUER alvo (conservador — é o
 *     comportamento antigo; sem `ptType` não há como saber se conflita);
 *   • alvo "all" (quadros que contam AMBAS as quests) é ocupado por qualquer
 *     PT ativa — o personagem está efetivamente comprometido em uma delas;
 *   • caso geral: ocupa somente quando a Quest da PT é IGUAL à Quest alvo.
 */
export function partyBlocksQuest(party: PartyTab, targetQuest: PtType | "all"): boolean {
  if (party.archived) return false;
  const partyQuest = party.ptType;
  if (partyQuest !== "soulwar" && partyQuest !== "sanguine") return true;
  if (targetQuest === "all") return true;
  return partyQuest === targetQuest;
}

/**
 * IDs (personagens e services) ocupados para a Quest alvo.
 *
 * `excludePartyId` = a PT atual (os próprios membros dela nunca são "outra
 * PT"). Substitui os antigos Sets que somavam `selectedIds` de toda PT ativa
 * sem olhar a Quest.
 */
export function collectBusyIdsForQuest(
  parties: readonly PartyTab[] | null | undefined,
  targetQuest: PtType | "all",
  excludePartyId?: string,
): Set<string> {
  const busy = new Set<string>();
  (parties || []).forEach(p => {
    if (!p) return;
    if (excludePartyId && p.id === excludePartyId) return;
    if (!partyBlocksQuest(p, targetQuest)) return;
    (p.selectedIds || []).forEach(id => { if (id) busy.add(id); });
  });
  return busy;
}
