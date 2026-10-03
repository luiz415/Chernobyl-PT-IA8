import type { PtType } from "../types";

// ============================================================================
// BOSSES E COOLDOWNS POR QUEST
//
// Catálogo usado ao PAUSAR uma PT: o líder informa em qual Boss a party parou
// e o cooldown daquele Boss é calculado a partir do instante da pausa.
//
// `description` é o nome da etapa (o que o jogador vê no jogo) e `name` é o
// apelido do Boss usado pelo time. A interface prioriza a DESCRIÇÃO e cai no
// nome quando ela não existe — regra explícita do produto.
//
// Nada aqui conclui Boss nem altera a Quest: o cooldown é apenas informativo,
// indicando quando aquele Boss volta a ficar disponível.
// ============================================================================

export interface QuestBoss {
  /** Identificador estável, gravado na PT. Nunca renomear. */
  id: string;
  /** Nome da etapa/Boss no jogo. Tem prioridade na exibição. */
  description: string;
  /** Apelido do Boss. Usado quando não há descrição. */
  name: string;
  /** Cooldown em horas. */
  hours: number;
}

/** Soul War — cinco bosses de 20h e o final de 72h. */
export const SOULWAR_BOSSES: QuestBoss[] = [
  { id: "sw_malice", description: "Goshnar's Malice", name: "Brachio", hours: 20 },
  { id: "sw_hatred", description: "Goshnar's Hatred", name: "Rotten", hours: 20 },
  { id: "sw_spite", description: "Goshnar's Spite", name: "Piranha", hours: 20 },
  { id: "sw_cruelty", description: "Goshnar's Cruelty", name: "Cloak", hours: 20 },
  { id: "sw_greed", description: "Goshnar's Greed", name: "Dark Thais", hours: 20 },
  { id: "sw_megalomania", description: "Goshnar's Megalomania", name: "Final", hours: 72 },
];

/**
 * Sanguine — quatro bosses de 20h e Bakragore com 72h.
 *
 * Aqui o nome do Boss É a própria etapa, então `description` e `name`
 * coincidem. Manter os dois campos preenchidos mantém a exibição uniforme
 * com Soul War, sem exigir um caso especial na interface.
 */
export const SANGUINE_BOSSES: QuestBoss[] = [
  { id: "sg_chagorz", description: "Chagorz", name: "Chagorz", hours: 20 },
  { id: "sg_ichgahal", description: "Ichgahal", name: "Ichgahal", hours: 20 },
  { id: "sg_murcion", description: "Murcion", name: "Murcion", hours: 20 },
  { id: "sg_vemiath", description: "Vemiath", name: "Vemiath", hours: 20 },
  { id: "sg_bakragore", description: "Bakragore", name: "Bakragore", hours: 72 },
];

/**
 * GB ("The Roost of the Graveborn"; identificador interno `crypt`) — mesmos
 * bosses verificados pela consulta de Bosstiary (electron-main). Cooldowns
 * espelham a Sanguine (20h nas etapas, 72h no final) — valor INFORMATIVO da
 * pausa, nunca conclui Boss nem altera a Quest.
 */
export const CRYPT_BOSSES: QuestBoss[] = [
  { id: "gb_adventurer_group", description: "Adventurer Group", name: "Adventurer Group", hours: 20 },
  { id: "gb_eldritch_dragon_lord", description: "Eldritch Dragon Lord", name: "Eldritch Dragon Lord", hours: 20 },
  { id: "gb_ice_horror", description: "Ice Horror", name: "Ice Horror", hours: 20 },
  { id: "gb_the_gravedigger", description: "The Gravedigger", name: "The Gravedigger", hours: 20 },
  { id: "gb_bonelords_phylactery", description: "Bonelord's Phylactery", name: "Bonelord's Phylactery", hours: 72 },
];

/** Bosses da Quest da PT. Lista vazia quando o tipo não está definido. */
export function getQuestBosses(ptType: PtType | undefined): QuestBoss[] {
  if (ptType === "soulwar") return SOULWAR_BOSSES;
  if (ptType === "sanguine") return SANGUINE_BOSSES;
  if (ptType === "crypt") return CRYPT_BOSSES;
  return [];
}

/**
 * Busca por id, varrendo as duas listas.
 *
 * Independe do `ptType` atual de propósito: se o tipo da PT for alterado
 * depois de uma pausa, o Boss gravado continua sendo resolvido corretamente
 * em vez de sumir da tela.
 */
export function findQuestBoss(bossId: string | undefined): QuestBoss | null {
  if (!bossId) return null;
  return [...SOULWAR_BOSSES, ...SANGUINE_BOSSES, ...CRYPT_BOSSES].find(boss => boss.id === bossId) || null;
}

/**
 * Rótulo de exibição: DESCRIÇÃO primeiro, nome como reserva.
 *
 * Um Boss gravado numa versão futura (id desconhecido nesta) não deixa a tela
 * em branco: devolvemos string vazia e o chamador decide o texto padrão.
 */
export function questBossLabel(bossId: string | undefined): string {
  const boss = findQuestBoss(bossId);
  if (!boss) return "";
  return boss.description || boss.name || "";
}

/** Horário de término do cooldown, a partir do instante da pausa. */
export function computeCooldownEnd(pausedAtMs: number, hours: number): number {
  return pausedAtMs + hours * 60 * 60 * 1000;
}

/**
 * Tempo restante em ms, nunca negativo.
 *
 * Calculado sempre por DIFERENÇA entre agora e o término salvo — nunca por um
 * contador local que precise correr sem parar. É isso que mantém o valor
 * correto depois de fechar o app, e igual para todos os participantes.
 */
export function cooldownRemainingMs(cooldownEndsAt: number | undefined, nowMs: number): number {
  if (!cooldownEndsAt) return 0;
  return Math.max(0, cooldownEndsAt - nowMs);
}

/** `12h 35min restantes` / `35min restantes` / `1min restantes`. */
export function formatCooldownRemaining(remainingMs: number): string {
  const totalMinutes = Math.ceil(remainingMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${minutes}min restantes`;
  return `${Math.max(1, minutes)}min restantes`;
}
