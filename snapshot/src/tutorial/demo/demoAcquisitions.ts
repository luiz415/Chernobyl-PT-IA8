// ============================================================================
// TUTORIAL — NEGOCIAÇÕES ENTRE USUÁRIOS DEMONSTRATIVAS
// ----------------------------------------------------------------------------
// Aquisições fictícias (formato CharacterAcquisition) para a sub-visão
// "Negociados entre usuários" de Meus Personagens e para as métricas do
// StatsPanel (a perspectiva do adquirente entra no Resultado Líquido e no
// Resultado Médio/Personagem).
//
// MATEMÁTICA DO STATS (validada por simulação — não alterar sem recalcular):
// net do adquirente = −finalPaid + lucroQuest(se concluída) + valorVenda.
//   acq-1: −275 + 885  = +610      acq-2: −320 + 725 = +405
//   acq-3..7: −555, −610, −640, −650, −660 (pagas, quest pendente)
//   → 7 entradas não-nulas somando −2.100.
// Combinadas com os 21 resultados dos personagens (27.300): 28 entradas,
// soma 25.200 → média 900 RC exata e Resultado Líquido 25.200 RC.
// ============================================================================
import type { CharacterAcquisition, CharacterAcquisitionBuyerDetails, Vocation } from "../../types";

export function buildDemoAcquisitions(now: number): CharacterAcquisition[] {
  const mk = (
    n: number,
    characterName: string,
    server: string,
    vocation: Vocation,
    level: number,
    sellerUid: string,
    sellerName: string,
    cost: number,
    status: CharacterAcquisition["status"],
    questType: "soulwar" | "sanguine",
    daysAgo: number,
  ): CharacterAcquisition => ({
    id: `demo-acq-${n}`,
    partyId: `demo-acq-pt-${n}`,
    partyName: `PT Demo — Negociação ${n}`,
    characterId: `demo-acqchar-${n}`,
    characterName,
    server,
    vocation,
    level,
    originalOwnerUid: sellerUid,
    originalOwnerName: sellerName,
    sellerMainCharacterName: `${sellerName} Main`,
    acquirerUid: "demo-uid-you",
    acquirerName: "Você",
    buyerMainCharacterName: "Demo Knight",
    financialRightsHolderUid: "demo-uid-you",
    financialRightsHolderName: "Você",
    originalCharacterCost: cost,
    personalFee: 25,
    bazaarFee: 50,
    finalPaid: cost + 25,
    sellerReceived: cost + 75,
    status,
    questType,
    createdAt: now - daysAgo * 86400000,
    createdByUid: "demo-uid-you",
    createdByName: "Você",
    preApprovedAt: now - daysAgo * 86400000,
    paymentConfirmedAt: now - (daysAgo - 1) * 86400000,
    paymentConfirmedByUid: sellerUid,
    questCompletedAt: status === "quest_completed" ? now - Math.max(1, daysAgo - 3) * 86400000 : undefined,
    updatedAt: now - Math.max(1, daysAgo - 3) * 86400000,
  });
  return [
    // Quests concluídas — o lucro privado entra nas Stats do adquirente.
    mk(1, "Demo Sorceress Neg", "Lunarian", "MS", 356, "demo-uid-ana", "Demo Ana", 250, "quest_completed", "sanguine", 9),
    mk(2, "Demo Knight Neg", "Mystian", "EK", 401, "demo-uid-bruno", "Demo Bruno", 295, "quest_completed", "soulwar", 7),
    // Pagas — quest ainda pendente (net = −finalPaid).
    mk(3, "Demo Paladin Neg", "Elysian", "RP", 389, "demo-uid-carla", "Demo Carla", 530, "payment_confirmed", "soulwar", 5),
    mk(4, "Demo Druid Neg", "Solarian", "ED", 372, "demo-uid-rafael", "Demo Rafael", 585, "payment_confirmed", "sanguine", 4),
    mk(5, "Demo Warrior Neg", "Auroria", "EK", 415, "demo-uid-sofia", "Demo Sofia", 615, "payment_confirmed", "soulwar", 3),
    mk(6, "Demo Archer Neg", "Mystian", "RP", 394, "demo-uid-ana", "Demo Ana", 625, "payment_confirmed", "soulwar", 2),
    mk(7, "Demo Mage Neg", "Lunarian", "MS", 366, "demo-uid-bruno", "Demo Bruno", 635, "payment_confirmed", "sanguine", 1),
  ];
}

export function buildDemoAcquisitionBuyerDetails(now: number): CharacterAcquisitionBuyerDetails[] {
  return [
    {
      id: "demo-acqd-1",
      acquisitionId: "demo-acq-1",
      acquirerUid: "demo-uid-you",
      questType: "sanguine",
      questDrops: ["Sanguine Rod"],
      questDropsSource: "pt",
      questProfit: 885,
      questProfitSource: "pt",
      questCompletedAt: now - 6 * 86400000,
      updatedAt: now - 6 * 86400000,
    },
    {
      id: "demo-acqd-2",
      acquisitionId: "demo-acq-2",
      acquirerUid: "demo-uid-you",
      questType: "soulwar",
      questDrops: ["Soulhexer"],
      questDropsSource: "pt",
      questProfit: 725,
      questProfitSource: "pt",
      questCompletedAt: now - 4 * 86400000,
      updatedAt: now - 4 * 86400000,
    },
  ];
}
