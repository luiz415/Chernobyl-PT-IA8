// ============================================================================
// GUIA DE IMBUEMENTS — dados
//
// Materiais necessários para completar cada Imbuement até o nível POWERFUL.
// Cada Imbuement usa exatamente TRÊS materiais distintos; as quantidades
// NUNCA são somadas entre itens diferentes — são apenas agrupadas.
//
// Este módulo é puro (sem React, sem I/O, sem Firestore) para poder ser
// verificado por teste automatizado.
//
// A identidade visual (`accent`) é semântica: fogo em tons quentes, gelo em
// tons frios, morte em roxo, terra em verde, sagrado em dourado, e assim por
// diante. O componente converte esse token em cor via `IMBUEMENT_ACCENTS`.
// ============================================================================

export type ImbuementCategoryId = "skill" | "damage" | "protection" | "support";

/** Token semântico de cor — traduzido para uma cor concreta na interface. */
export type ImbuementAccent =
  | "fire"
  | "ice"
  | "energy"
  | "death"
  | "earth"
  | "holy"
  | "life"
  | "mana"
  | "physical"
  | "magic"
  | "distance"
  | "shield"
  | "speed";

export interface ImbuementMaterial {
  /** Quantidade necessária até o Powerful. */
  qty: number;
  /** Nome do item, exatamente como no jogo. */
  item: string;
}

export interface Imbuement {
  /** Identificador estável (usado como `key` do React). */
  id: string;
  /** Emoji relacionado à função do Imbuement. */
  emoji: string;
  /** Nome oficial do Imbuement. */
  name: string;
  /** O que o Imbuement faz, em português. */
  description: string;
  category: ImbuementCategoryId;
  accent: ImbuementAccent;
  /** Sempre 3 materiais, na ordem oficial. */
  materials: [ImbuementMaterial, ImbuementMaterial, ImbuementMaterial];
}

export interface ImbuementCategory {
  id: ImbuementCategoryId;
  emoji: string;
  label: string;
  /** Cor de identidade da categoria (token semântico). */
  accent: ImbuementAccent;
}

export const IMBUEMENT_CATEGORIES: ImbuementCategory[] = [
  { id: "skill", emoji: "⚔️", label: "Aumento de Skill", accent: "physical" },
  { id: "damage", emoji: "🔥", label: "Dano Elemental", accent: "fire" },
  { id: "protection", emoji: "🛡️", label: "Proteção Elemental", accent: "shield" },
  { id: "support", emoji: "✨", label: "Suporte", accent: "holy" },
];

export const IMBUEMENTS: Imbuement[] = [
  // ── ⚔️ AUMENTO DE SKILL ───────────────────────────────────────────────────
  {
    id: "blockade", emoji: "🛡️", name: "Blockade",
    description: "Skillboost de Escudo", category: "skill", accent: "shield",
    materials: [
      { qty: 20, item: "Piece of Scarab Shell" },
      { qty: 25, item: "Brimstone Shell" },
      { qty: 25, item: "Frazzle Skin" },
    ],
  },
  {
    id: "chop", emoji: "🪓", name: "Chop",
    description: "Skillboost de Machado", category: "skill", accent: "physical",
    materials: [
      { qty: 20, item: "Orc Tooth" },
      { qty: 25, item: "Battle Stone" },
      { qty: 20, item: "Moohtant Horn" },
    ],
  },
  {
    id: "epiphany", emoji: "🔮", name: "Epiphany",
    description: "Skillboost de Nível Mágico", category: "skill", accent: "magic",
    materials: [
      { qty: 25, item: "Elvish Talisman" },
      { qty: 15, item: "Broken Shamanic Staff" },
      { qty: 15, item: "Strand of Medusa Hair" },
    ],
  },
  {
    id: "precision", emoji: "🏹", name: "Precision",
    description: "Skillboost de Distância", category: "skill", accent: "distance",
    materials: [
      { qty: 25, item: "Elven Scouting Glass" },
      { qty: 20, item: "Elven Hoof" },
      { qty: 10, item: "Metal Spike" },
    ],
  },
  {
    id: "slash", emoji: "⚔️", name: "Slash",
    description: "Skillboost de Espada", category: "skill", accent: "physical",
    materials: [
      { qty: 25, item: "Lion's Mane" },
      { qty: 25, item: "Mooh'tah Shell" },
      { qty: 5, item: "War Crystal" },
    ],
  },
  {
    id: "bash", emoji: "🔨", name: "Bash",
    description: "Skillboost de Clava", category: "skill", accent: "physical",
    materials: [
      { qty: 20, item: "Cyclops Toe" },
      { qty: 15, item: "Ogre Nose Ring" },
      { qty: 10, item: "Warmaster's Wristguards" },
    ],
  },
  {
    id: "punch", emoji: "👊", name: "Punch",
    description: "Skillboost de Punhos", category: "skill", accent: "physical",
    materials: [
      { qty: 25, item: "Tarantula Egg" },
      { qty: 20, item: "Mantassin Tail" },
      { qty: 15, item: "Gold-Brocaded Cloth" },
    ],
  },

  // ── 🔥 DANO ELEMENTAL ─────────────────────────────────────────────────────
  {
    id: "reap", emoji: "💀", name: "Reap",
    description: "Dano de Morte", category: "damage", accent: "death",
    materials: [
      { qty: 25, item: "Pile of Grave Earth" },
      { qty: 20, item: "Demonic Skeletal Hand" },
      { qty: 5, item: "Petrified Scream" },
    ],
  },
  {
    id: "electrify", emoji: "⚡", name: "Electrify",
    description: "Dano de Energia", category: "damage", accent: "energy",
    materials: [
      { qty: 25, item: "Rorc Feather" },
      { qty: 5, item: "Peacock Feather Fan" },
      { qty: 1, item: "Energy Vein" },
    ],
  },
  {
    id: "venom", emoji: "☣️", name: "Venom",
    description: "Dano de Terra", category: "damage", accent: "earth",
    materials: [
      { qty: 25, item: "Swamp Grass" },
      { qty: 20, item: "Poisonous Slime" },
      { qty: 2, item: "Slime Heart" },
    ],
  },
  {
    id: "frost", emoji: "❄️", name: "Frost",
    description: "Dano de Gelo", category: "damage", accent: "ice",
    materials: [
      { qty: 25, item: "Frosty Heart" },
      { qty: 10, item: "Seacrest Hair" },
      { qty: 5, item: "Polar Bear Paw" },
    ],
  },
  {
    id: "scorch", emoji: "🔥", name: "Scorch",
    description: "Dano de Fogo", category: "damage", accent: "fire",
    materials: [
      { qty: 25, item: "Fiery Heart" },
      { qty: 5, item: "Green Dragon Scale" },
      { qty: 5, item: "Demon Horn" },
    ],
  },

  // ── 🛡️ PROTEÇÃO ELEMENTAL ────────────────────────────────────────────────
  {
    id: "cloud-fabric", emoji: "⚡", name: "Cloud Fabric",
    description: "Proteção de Energia", category: "protection", accent: "energy",
    materials: [
      { qty: 20, item: "Wyvern Talisman" },
      { qty: 15, item: "Crawler Head Plating" },
      { qty: 10, item: "Wyrm Scale" },
    ],
  },
  {
    id: "demon-presence", emoji: "✨", name: "Demon Presence",
    description: "Proteção de Sagrado", category: "protection", accent: "holy",
    materials: [
      { qty: 25, item: "Cultish Robe" },
      { qty: 25, item: "Cultish Mask" },
      { qty: 20, item: "Hellspawn Tail" },
    ],
  },
  {
    id: "dragon-hide", emoji: "🔥", name: "Dragon Hide",
    description: "Proteção de Fogo", category: "protection", accent: "fire",
    materials: [
      { qty: 20, item: "Green Dragon Leather" },
      { qty: 10, item: "Blazing Bone" },
      { qty: 5, item: "Draken Sulphur" },
    ],
  },
  {
    id: "lich-shroud", emoji: "💀", name: "Lich Shroud",
    description: "Proteção de Morte", category: "protection", accent: "death",
    materials: [
      { qty: 25, item: "Flask of Embalming Fluid" },
      { qty: 20, item: "Gloom Wolf Fur" },
      { qty: 5, item: "Mystical Hourglass" },
    ],
  },
  {
    id: "quara-scale", emoji: "❄️", name: "Quara Scale",
    description: "Proteção de Gelo", category: "protection", accent: "ice",
    materials: [
      { qty: 25, item: "Winter Wolf Fur" },
      { qty: 15, item: "Thick Fur" },
      { qty: 10, item: "Deepling Warts" },
    ],
  },
  {
    id: "snake-skin", emoji: "🌿", name: "Snake Skin",
    description: "Proteção de Terra", category: "protection", accent: "earth",
    materials: [
      { qty: 25, item: "Piece of Swampling Wood" },
      { qty: 20, item: "Snake Skin" },
      { qty: 10, item: "Brimstone Fangs" },
    ],
  },

  // ── ✨ SUPORTE ────────────────────────────────────────────────────────────
  {
    id: "featherweight", emoji: "🎒", name: "Featherweight",
    description: "Aumento de Capacidade", category: "support", accent: "speed",
    materials: [
      { qty: 20, item: "Fairy Wings" },
      { qty: 10, item: "Little Bowl of Myrrh" },
      { qty: 5, item: "Goosebump Leather" },
    ],
  },
  {
    id: "strike", emoji: "💥", name: "Strike",
    description: "Dano Crítico", category: "support", accent: "physical",
    materials: [
      { qty: 20, item: "Protective Charm" },
      { qty: 25, item: "Sabretooth" },
      { qty: 5, item: "Vexclaw Talon" },
    ],
  },
  {
    id: "swiftness", emoji: "💨", name: "Swiftness",
    description: "Skillboost de Velocidade", category: "support", accent: "speed",
    materials: [
      { qty: 15, item: "Damselfly Wing" },
      { qty: 25, item: "Compass" },
      { qty: 20, item: "Waspoid Wing" },
    ],
  },
  {
    id: "vampirism", emoji: "❤️", name: "Vampirism",
    description: "Roubo de Vida", category: "support", accent: "life",
    materials: [
      { qty: 25, item: "Vampire Teeth" },
      { qty: 15, item: "Bloody Pincers" },
      { qty: 5, item: "Piece of Dead Brain" },
    ],
  },
  {
    id: "vibrancy", emoji: "⚡", name: "Vibrancy",
    description: "Remoção de Paralisia", category: "support", accent: "energy",
    materials: [
      { qty: 20, item: "Wereboar Hooves" },
      { qty: 15, item: "Crystallized Anger" },
      { qty: 5, item: "Quill" },
    ],
  },
  {
    id: "void", emoji: "💧", name: "Void",
    description: "Roubo de Mana", category: "support", accent: "mana",
    materials: [
      { qty: 25, item: "Rope Belt" },
      { qty: 25, item: "Silencer Claws" },
      { qty: 5, item: "Some Grimeleech Wings" },
    ],
  },
];

/** Imbuements de uma categoria, na ordem de declaração. */
export function getImbuementsByCategory(category: ImbuementCategoryId): Imbuement[] {
  return IMBUEMENTS.filter(imbuement => imbuement.category === category);
}
