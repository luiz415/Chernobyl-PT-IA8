// ============================================================================
// DURAÇÃO EM DIAS/HORAS/MINUTOS — helpers compartilhados (fonte única)
// ----------------------------------------------------------------------------
// Usados pelos fluxos que definem um COOLDOWN por TEMPO RESTANTE digitado em
// campos separados (dias/horas/minutos):
//   • NextRotationModal — horário da nova PT via "Próxima Rotação";
//   • SgCooldownModal   — cooldown do Bakragore em "Meus Personagens".
// Mesma validação e mesmo arredondamento nos dois lugares.
// ============================================================================

/** Decompõe uma duração (ms) em dias/horas/minutos (clamp em 0). */
export function splitDuration(ms: number): { days: number; hours: number; mins: number } {
  const total = Math.max(0, Math.ceil(ms / 60_000)); // minutos restantes (arredonda p/ cima)
  const days = Math.floor(total / (24 * 60));
  const hours = Math.floor((total % (24 * 60)) / 60);
  const mins = total % 60;
  return { days, hours, mins };
}

/**
 * Valida um campo de duração: inteiro dentro de [min, max].
 * Campo vazio é INVÁLIDO (o usuário deve digitar 0 explicitamente) — evita
 * salvar um tempo diferente do que parece estar na tela.
 */
export function parseDurationField(value: string, min: number, max: number): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}
