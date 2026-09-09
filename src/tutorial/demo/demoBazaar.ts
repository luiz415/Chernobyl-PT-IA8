// ============================================================================
// TUTORIAL — BAZAAR DEMONSTRATIVO
// ----------------------------------------------------------------------------
// Leilões, interesses e notificações fictícios para o tópico "Bazaar". O
// formato replica o BazaarFetchResult/BazaarAuction real (BazarPanel), mas
// nada aqui toca cache, Firestore ou o site do Rubinot: os links usam
// example.com e os encerramentos são relativos a `now`.
//
// Contadores de bosses: o padrão do jogo é Soul War 0/6 e Sanguine 0/5 —
// a MAIORIA dos leilões demonstrativos usa exatamente esses valores, com
// poucas exceções (quest concluída 6/6 e 5/5, progresso parcial) para
// mostrar as demais aparências da coluna.
// ============================================================================

/** Mesmo shape do BazaarAuction interno do BazarPanel (estruturalmente). */
export interface DemoBazaarAuction {
  id: string;
  name: string;
  vocation: string;
  level: number;
  server: string;
  bid: number;
  currentValue: number;
  startingValue: number;
  hasBid: boolean;
  auctionEndTs: number | null;
  url: string;
  soulwarCompleted?: boolean | null;
  sanguineCompleted?: boolean | null;
  soulWarBossCount?: number;
  sanguineBossCount?: number;
  soulWarBossTotal?: number;
  sanguineBossTotal?: number;
}

export interface DemoBazaarData {
  fetchedAt: number;
  auctions: DemoBazaarAuction[];
  /** auctionId → usuários interessados (mesmo shape do BazaarInterestMap). */
  interests: Record<string, { uid: string; name: string; auctionId: string; bazaarVersion: string; createdAtMs: number }[]>;
  notifications: { id: string; title: string; body: string; url?: string; expiresAtMs?: number; auctionId?: string }[];
}

export function buildDemoBazaar(now: number): DemoBazaarData {
  const nowSec = Math.floor(now / 1000);
  const mk = (
    n: number, name: string, vocation: string, level: number, server: string,
    currentValue: number, startingValue: number, hasBid: boolean, endsInMin: number,
    sw: boolean | null, sg: boolean | null, swCount = 0, sgCount = 0,
  ): DemoBazaarAuction => ({
    id: `demo-auction-${n}`,
    name,
    vocation,
    level,
    server,
    bid: currentValue,
    currentValue,
    startingValue,
    hasBid,
    auctionEndTs: nowSec + endsInMin * 60,
    url: "https://example.com/tutorial-demo",
    soulwarCompleted: sw,
    sanguineCompleted: sg,
    soulWarBossCount: swCount,
    soulWarBossTotal: 6,
    sanguineBossCount: sgCount,
    sanguineBossTotal: 5,
  });
  const auctions = [
    // ── Maioria: quests disponíveis, bosses zerados (SW 0/6 / SG 0/5) ──────
    mk(1, "Demo Warrior", "Elite Knight", 421, "Elysian", 480, 300, true, 12, false, false),
    mk(2, "Demo Ranger", "Royal Paladin", 397, "Elysian", 415, 350, true, 55, false, false),
    mk(3, "Demo Mage", "Master Sorcerer", 372, "Lunarian", 380, 380, false, 130, false, false),
    mk(4, "Demo Healer", "Elder Druid", 355, "Lunarian", 340, 250, true, 220, false, false),
    mk(5, "Demo Fighter", "Exalted Monk", 318, "Solarian", 290, 290, false, 400, false, false),
    mk(6, "Demo Tank", "Elite Knight", 296, "Mystian", 260, 200, true, 750, false, false),
    mk(7, "Demo Sniper", "Royal Paladin", 341, "Auroria", 330, 330, false, 1300, false, false),
    mk(8, "Demo Elder", "Elder Druid", 305, "Solarian", 275, 220, true, 2100, false, false),
    mk(9, "Demo Vanguard", "Elite Knight", 384, "Auroria", 410, 360, true, 95, false, false),
    mk(10, "Demo Arcanist", "Master Sorcerer", 359, "Mystian", 355, 310, false, 510, false, false),
    mk(11, "Demo Marksman", "Royal Paladin", 327, "Elysian", 305, 280, true, 980, false, false),
    // ── Variações pontuais: concluídas e progresso parcial ─────────────────
    mk(12, "Demo Conqueror", "Elite Knight", 447, "Lunarian", 620, 500, true, 45, true, false, 6, 0),
    mk(13, "Demo Bloodmage", "Master Sorcerer", 412, "Solarian", 545, 450, true, 160, false, true, 0, 5),
    mk(14, "Demo Pathfinder", "Royal Paladin", 366, "Mystian", 360, 320, false, 640, false, false, 2, 0),
  ];
  // Leilão já encerrado — demonstra o estado "Encerrado" da lista.
  auctions.push({ ...mk(15, "Demo Closed", "Elder Druid", 288, "Mystian", 240, 240, true, -30, false, false) });
  return {
    fetchedAt: now - 8 * 60000,
    auctions,
    interests: {
      "demo-auction-1": [
        { uid: "demo-uid-you", name: "Você", auctionId: "demo-auction-1", bazaarVersion: "demo", createdAtMs: now - 3600000 },
        { uid: "demo-uid-ana", name: "Demo Ana", auctionId: "demo-auction-1", bazaarVersion: "demo", createdAtMs: now - 2 * 3600000 },
      ],
      "demo-auction-4": [
        { uid: "demo-uid-bruno", name: "Demo Bruno", auctionId: "demo-auction-4", bazaarVersion: "demo", createdAtMs: now - 5 * 3600000 },
      ],
      "demo-auction-9": [
        { uid: "demo-uid-you", name: "Você", auctionId: "demo-auction-9", bazaarVersion: "demo", createdAtMs: now - 40 * 60000 },
      ],
      "demo-auction-12": [
        { uid: "demo-uid-carla", name: "Demo Carla", auctionId: "demo-auction-12", bazaarVersion: "demo", createdAtMs: now - 7 * 3600000 },
        { uid: "demo-uid-rafael", name: "Demo Rafael", auctionId: "demo-auction-12", bazaarVersion: "demo", createdAtMs: now - 9 * 3600000 },
      ],
    },
    notifications: [
      { id: "demo-notif-1", title: "Leilão encerrando", body: "Demo Warrior (Elysian) encerra em 12 minutos — você marcou interesse.", url: "https://example.com/tutorial-demo", expiresAtMs: now + 12 * 60000, auctionId: "demo-auction-1" },
      { id: "demo-notif-2", title: "Leilão encerrando", body: "Demo Vanguard (Auroria) encerra em 1h35 — você marcou interesse.", url: "https://example.com/tutorial-demo", expiresAtMs: now + 95 * 60000, auctionId: "demo-auction-9" },
    ],
  };
}
