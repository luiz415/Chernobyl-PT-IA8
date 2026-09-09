// ============================================================================
// TUTORIAL — STATS E RANKING DEMONSTRATIVOS
// ----------------------------------------------------------------------------
// userStats fictício (formato do doc userStats/{uid} consumido pelo
// StatsPanel) e quadro de ranking fictício (formato RankingEntry do
// RankingPanel) para os tópicos "Stats" e "Ranking".
//
// Os valores FINANCEIROS do Stats (Resultado Líquido 25.200 RC e Resultado
// Médio/Personagem 900 RC) NÃO vêm daqui: são derivados pelos próprios
// cálculos do StatsPanel a partir de demoCharacters + demoAcquisitions.
// Este doc alimenta apenas os contadores operacionais (PTs, mortes, tempo,
// parceiros, dias) — mantidos coerentes com o volume de personagens demo.
// ============================================================================

function dayKey(now: number, minusDays: number): string {
  return new Date(now - minusDays * 86400000).toISOString().slice(0, 10);
}

/** Doc no formato de userStats/{uid} (campos lidos pelo StatsPanel/Ranking). */
export function buildDemoUserStats(now: number): Record<string, any> {
  return {
    totalPtsConcluidas: 27,
    totalPtsSoulwar: 16,
    totalPtsSanguine: 11,
    totalParticipacoes: 31,
    totalMortes: 9,
    totalDuracaoMs: 27 * (2 * 3600000 + 30 * 60000),
    ptsSemMorte: 19,
    ptsComMorte: 8,
    sequenciaAtualSemMorte: 5,
    maxSequenciaSemMorte: 9,
    rankingScore: 2360,
    totalRcDoadoAprovado: 250,
    services: 7,
    servers: { Mystian: 9, Elysian: 7, Solarian: 6, Lunarian: 3, Auroria: 2 },
    partners: { "demo-uid-ana": 12, "demo-uid-bruno": 9, "demo-uid-carla": 7, "demo-uid-rafael": 5, "demo-uid-sofia": 3 },
    dailyStats: {
      [dayKey(now, 1)]: { totalPtsConcluidas: 1, totalPtsSoulwar: 1, totalPtsSanguine: 0 },
      [dayKey(now, 2)]: { totalPtsConcluidas: 2, totalPtsSoulwar: 1, totalPtsSanguine: 1 },
      [dayKey(now, 3)]: { totalPtsConcluidas: 2, totalPtsSoulwar: 1, totalPtsSanguine: 1 },
      [dayKey(now, 5)]: { totalPtsConcluidas: 1, totalPtsSoulwar: 0, totalPtsSanguine: 1 },
      [dayKey(now, 6)]: { totalPtsConcluidas: 2, totalPtsSoulwar: 1, totalPtsSanguine: 1 },
      [dayKey(now, 8)]: { totalPtsConcluidas: 1, totalPtsSoulwar: 1, totalPtsSanguine: 0 },
      [dayKey(now, 9)]: { totalPtsConcluidas: 2, totalPtsSoulwar: 2, totalPtsSanguine: 0 },
      [dayKey(now, 11)]: { totalPtsConcluidas: 1, totalPtsSoulwar: 0, totalPtsSanguine: 1 },
      [dayKey(now, 12)]: { totalPtsConcluidas: 2, totalPtsSoulwar: 2, totalPtsSanguine: 0 },
      [dayKey(now, 14)]: { totalPtsConcluidas: 1, totalPtsSoulwar: 1, totalPtsSanguine: 0 },
      [dayKey(now, 15)]: { totalPtsConcluidas: 2, totalPtsSoulwar: 1, totalPtsSanguine: 1 },
      [dayKey(now, 17)]: { totalPtsConcluidas: 1, totalPtsSoulwar: 0, totalPtsSanguine: 1 },
      [dayKey(now, 19)]: { totalPtsConcluidas: 2, totalPtsSoulwar: 1, totalPtsSanguine: 1 },
      [dayKey(now, 21)]: { totalPtsConcluidas: 1, totalPtsSoulwar: 1, totalPtsSanguine: 0 },
      [dayKey(now, 23)]: { totalPtsConcluidas: 2, totalPtsSoulwar: 1, totalPtsSanguine: 1 },
      [dayKey(now, 25)]: { totalPtsConcluidas: 1, totalPtsSoulwar: 0, totalPtsSanguine: 1 },
      [dayKey(now, 26)]: { totalPtsConcluidas: 2, totalPtsSoulwar: 1, totalPtsSanguine: 1 },
      [dayKey(now, 28)]: { totalPtsConcluidas: 1, totalPtsSoulwar: 1, totalPtsSanguine: 0 },
    },
  };
}

/** Nomes dos usuários fictícios citados em partners/ranking. */
export const DEMO_USER_NAMES: Record<string, string> = {
  "demo-uid-you": "Você",
  "demo-uid-ana": "Demo Ana",
  "demo-uid-bruno": "Demo Bruno",
  "demo-uid-carla": "Demo Carla",
  "demo-uid-rafael": "Demo Rafael",
  "demo-uid-sofia": "Demo Sofia",
  "demo-uid-diego": "Demo Diego",
  "demo-uid-livia": "Demo Lívia",
};

/** Entradas no formato RankingEntry (RankingPanel). */
export function buildDemoRanking(now: number): Record<string, any>[] {
  const mk = (uid: string, nome: string, score: number, concluidas: number, mortes: number, streak: number, doado: number, services: number) => ({
    uid,
    nome,
    score,
    concluidas,
    totalParticipacoes: concluidas + 2,
    totalMortes: mortes,
    totalDuracaoMs: concluidas * (2 * 3600000 + 25 * 60000),
    totalPtsSoulwar: Math.ceil(concluidas * 0.6),
    totalPtsSanguine: Math.floor(concluidas * 0.4),
    ptsSemMorte: Math.max(0, concluidas - mortes),
    ptsComMorte: Math.min(concluidas, mortes),
    sequenciaAtualSemMorte: streak,
    maxSequenciaSemMorte: streak + 2,
    servers: { Elysian: Math.ceil(concluidas / 2), Lunarian: Math.floor(concluidas / 2) },
    partners: {},
    totalRcDoadoAprovado: doado,
    services,
    dailyStats: { [dayKey(now, 1)]: { totalPtsConcluidas: 1 } },
  });
  return [
    mk("demo-uid-ana", "Demo Ana", 2980, 34, 6, 8, 300, 9),
    mk("demo-uid-you", "Você", 2360, 27, 9, 5, 250, 7),
    mk("demo-uid-bruno", "Demo Bruno", 1890, 19, 8, 2, 100, 3),
    mk("demo-uid-carla", "Demo Carla", 1450, 15, 3, 6, 150, 4),
    mk("demo-uid-rafael", "Demo Rafael", 1130, 12, 7, 1, 50, 2),
    mk("demo-uid-sofia", "Demo Sofia", 890, 9, 2, 4, 0, 1),
    mk("demo-uid-diego", "Demo Diego", 640, 7, 5, 0, 0, 1),
    mk("demo-uid-livia", "Demo Lívia", 420, 4, 1, 3, 0, 0),
  ];
}
