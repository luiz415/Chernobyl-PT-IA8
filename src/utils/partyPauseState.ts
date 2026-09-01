import type { PartyTab } from "../types";

/** Dados mínimos do Boss selecionado no modal de pausa. */
export interface PauseBossSelection {
  id: string;
  hours: number;
}

/**
 * Constrói os campos persistidos pela pausa atual.
 *
 * `cooldownIgnored` é uma exceção explícita desta pausa/Boss. Ela não altera
 * o catálogo normal de cooldowns e é apagada ao retomar a PT.
 */
export function buildPauseBossState(
  boss: PauseBossSelection | null,
  pausedAt: number,
  ignoreCooldown: boolean,
): Pick<PartyTab, "pausedBossId" | "pausedAt" | "cooldownHours" | "cooldownEndsAt" | "cooldownIgnored"> {
  const safePausedAt = Number.isFinite(pausedAt) && pausedAt > 0 ? Math.floor(pausedAt) : Date.now();
  if (!boss) {
    return {
      pausedBossId: "",
      pausedAt: safePausedAt,
      cooldownHours: 0,
      cooldownEndsAt: 0,
      cooldownIgnored: false,
    };
  }

  const hours = Number.isFinite(boss.hours) && boss.hours > 0 ? Math.floor(boss.hours) : 0;
  const ignored = ignoreCooldown === true;
  return {
    pausedBossId: boss.id,
    pausedAt: safePausedAt,
    cooldownHours: ignored ? 0 : hours,
    cooldownEndsAt: ignored ? 0 : safePausedAt + (hours * 60 * 60 * 1000),
    cooldownIgnored: ignored,
  };
}

/**
 * Retomar encerra completamente o estado visual da pausa anterior.
 *
 * Zerar, em vez de manter os campos antigos, impede que um snapshot, refresh
 * ou reabertura do PartyPanel volte a exibir um Boss/cooldown como se a pausa
 * ainda estivesse ativa.
 */
export function clearPartyPauseState(party: PartyTab, resumedAt: number): PartyTab {
  const safeResumedAt = Number.isFinite(resumedAt) && resumedAt > 0 ? Math.floor(resumedAt) : Date.now();
  return {
    ...party,
    isPaused: false,
    ptStartedAt: safeResumedAt,
    accumulatedMs: party.accumulatedMs || 0,
    pausedBossId: "",
    pausedAt: 0,
    cooldownHours: 0,
    cooldownEndsAt: 0,
    cooldownIgnored: false,
  };
}