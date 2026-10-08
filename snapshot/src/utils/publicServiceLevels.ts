import type { Vocation } from "../types";

// ============================================================================
// FORMULÁRIO PÚBLICO — LEVEL MÍNIMO POR QUEST + VOCAÇÃO (fonte ÚNICA)
//
// Usado pelo PublicServiceForm em TRÊS pontos, sempre com a MESMA tabela:
//   • Etapa 2 (informações da Quest): exibição dos requisitos;
//   • Etapa 6 (Level e cadastro): bloqueio visual do botão "Cadastrar";
//   • handleSubmit: re-checagem DURA antes de qualquer gravação — mesmo que
//     a interface seja contornada, o cadastro não acontece abaixo do mínimo.
//
// PUBLIC_MIN_LEVELS são os PADRÕES. O dono de um link exclusivo pode
// personalizar o mínimo de cada combinação Quest + vocação pelo modal
// "Configurar Meu Formulário" (users/{uid}.serviceFormConfig.minLevels —
// ver utils/serviceFormConfig). O PublicServiceForm passa o mínimo efetivo
// (configuração resolvida do dono) no parâmetro `minOverride` de
// `publicLevelBlockReason`; sem override, valem os padrões abaixo.
//
// Estes valores são EXCLUSIVOS do formulário público de clientes. A página
// de recrutamento de serviceiros (#/serviceiro) tem a própria tabela e não
// é afetada.
// ============================================================================

export type PublicQuest = "soulwar" | "sanguine";

export const PUBLIC_QUEST_LABEL: Record<PublicQuest, string> = {
  soulwar: "Soul War",
  sanguine: "Sanguine",
};

export const PUBLIC_MIN_LEVELS: Record<PublicQuest, Record<Vocation, number>> = {
  soulwar: { EK: 550, ED: 400, MS: 400, RP: 500, MK: 550 },
  sanguine: { EK: 700, ED: 600, MS: 600, RP: 700, MK: 750 },
};

/** Level mínimo exigido para a combinação Quest + Vocação. */
export function publicMinLevelFor(quest: PublicQuest, voc: Vocation): number {
  return PUBLIC_MIN_LEVELS[quest]?.[voc] ?? 0;
}

/**
 * Motivo do bloqueio do cadastro para a combinação Quest + Vocação + Level,
 * ou `null` quando o cadastro está liberado.
 *
 * `minOverride`: level mínimo EFETIVO (ex.: o personalizado pelo dono do
 * link exclusivo via serviceFormConfig.minLevels). Ausente = padrão da
 * tabela PUBLIC_MIN_LEVELS.
 */
export function publicLevelBlockReason(quest: PublicQuest, voc: Vocation, level: number, minOverride?: number): string | null {
  if (!Number.isFinite(level) || level <= 0) {
    return "Informe o level atual do personagem";
  }
  const min = typeof minOverride === "number" && Number.isFinite(minOverride) && minOverride > 0
    ? Math.round(minOverride)
    : publicMinLevelFor(quest, voc);
  if (level < min) {
    return `Level insuficiente: ${PUBLIC_QUEST_LABEL[quest]} com ${voc} exige level mínimo ${min} (informado: ${level}).`;
  }
  return null;
}
