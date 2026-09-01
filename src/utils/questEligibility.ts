import type { Character, WaitingService } from "../types";

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