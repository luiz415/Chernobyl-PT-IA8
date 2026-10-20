// ============================================================================
// IDENTIDADE GLOBAL DE CORES DOS EMBLEMAS DE QUEST (siglas SW / SG / GB)
// ----------------------------------------------------------------------------
// Fonte ÚNICA das cores dos emblemas que exibem as siglas das Quests em todo
// o aplicativo (tabelas, cards, modais e filtros):
//   • SW — Soul War:   CINZA-AZULADO (slate);
//   • SG — Sanguine:   VERMELHO-SANGUE (red profundo — não o rosa anterior);
//   • GB — Graveborn:  VERDE-PODRE (lime escuro — não o esmeralda anterior).
// As constantes carregam SOMENTE as cores (borda/fundo/texto); formato,
// tamanho e tipografia continuam definidos em cada ponto de uso, para
// preservar o layout existente de cada tela.
// ============================================================================

export type QuestBadgeKey = "soulwar" | "sanguine" | "crypt";

/** Sigla oficial exibida nos emblemas. */
export const QUEST_SIGLA: Record<QuestBadgeKey, string> = {
  soulwar: "SW",
  sanguine: "SG",
  crypt: "GB",
};

/**
 * Classes de COR (borda + fundo + texto) do emblema de cada Quest, legíveis
 * sobre os fundos escuros do app.
 */
export const QUEST_BADGE_COLOR_CLASSES: Record<QuestBadgeKey, string> = {
  // Cinza-azulado — próximo do tom neutro já usado, agora oficial.
  soulwar: "border-slate-400/40 bg-slate-500/15 text-slate-300",
  // Vermelho-sangue — vermelho profundo, substitui o rosa (rose) anterior.
  sanguine: "border-red-700/60 bg-red-900/30 text-red-400",
  // Verde-podre — verde amarelado escuro, substitui o esmeralda anterior.
  crypt: "border-lime-700/50 bg-lime-900/25 text-lime-500",
};

/** Cores do emblema a partir da SIGLA ("SW" | "SG" | "GB"). */
export function questBadgeColorBySigla(sigla: string): string {
  if (sigla === "SG") return QUEST_BADGE_COLOR_CLASSES.sanguine;
  if (sigla === "GB") return QUEST_BADGE_COLOR_CLASSES.crypt;
  return QUEST_BADGE_COLOR_CLASSES.soulwar;
}
