import type { Character, QuestStatusHistoryEntry, QuestStatusHistoryQuest } from "../types";

// ============================================================================
// HISTÓRICO DE STATUS DAS QUESTS (98ª tarefa) — núcleo PURO
//
// Sempre que o status de uma quest (soulwar/sanguine/crypt) de um personagem
// da lista pessoal muda — manual OU automaticamente —, um registro
// `{ quest, status, at }` é anexado a `character.questStatusHistory`.
// `at` (epoch ms) carrega a DATA e o HORÁRIO EXATO da alteração; `status` é
// o NOVO valor (true = disponível/pendente, false = concluída/indisponível).
//
// A detecção é CENTRALIZADA: App.tsx compara o estado anterior da lista com
// o novo (mesmo padrão do efeito de remoção dos probableMarkers), então todo
// caminho de alteração (edição inline, modal, Att Chars, Auto-Att, conclusão
// de PT, drops etc.) passa por aqui sem instrumentação individual.
//
// ANTI-DUPLICAÇÃO (duas camadas):
//   1. Só há candidato a registro quando o status EFETIVAMENTE mudou entre o
//      estado anterior e o novo (sincronizações/salvamentos repetidos sem
//      mudança real não geram nada);
//   2. Mesmo com mudança aparente (ex.: lista local antiga substituída pela
//      versão da nuvem, onde o outro dispositivo JÁ registrou a alteração),
//      se o ÚLTIMO registro daquela quest já tem o mesmo status, nada é
//      anexado — ecos de sincronização ficam idempotentes.
//
// O histórico anterior é SEMPRE preservado (append-only; nunca truncado nem
// sobrescrito).
// ============================================================================

/** Ordem canônica das quests verificadas a cada comparação. */
export const QUEST_STATUS_HISTORY_QUESTS: readonly QuestStatusHistoryQuest[] = [
  "soulwar",
  "sanguine",
  "crypt",
] as const;

/**
 * Status atual (true = disponível) de uma quest no personagem, com as MESMAS
 * convenções de legado do app: `crypt` ausente conta como disponível
 * (`crypt !== false` — convenção documentada no Character), enquanto
 * soulwar/sanguine são booleans obrigatórios comparados a `true`.
 */
export function questStatusOf(character: Character, quest: QuestStatusHistoryQuest): boolean {
  if (quest === "crypt") return character.crypt !== false;
  return character[quest] === true;
}

/** Último registro de uma quest específica no histórico (ou null). */
function lastEntryFor(
  history: QuestStatusHistoryEntry[] | undefined,
  quest: QuestStatusHistoryQuest,
): QuestStatusHistoryEntry | null {
  if (!Array.isArray(history)) return null;
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry && entry.quest === quest) return entry;
  }
  return null;
}

/**
 * Compara o personagem ANTERIOR com o ATUAL e devolve o novo array de
 * histórico com os registros das mudanças reais de status anexados — ou
 * `null` quando NÃO há nada a registrar (nenhuma mudança real, ou mudanças
 * já registradas por outro dispositivo). Função pura: não muta os objetos
 * recebidos; o histórico pré-existente do personagem ATUAL é preservado
 * integralmente como base.
 */
export function appendQuestStatusHistory(
  prev: Character,
  next: Character,
  at: number,
): QuestStatusHistoryEntry[] | null {
  const base: QuestStatusHistoryEntry[] = Array.isArray(next.questStatusHistory)
    ? next.questStatusHistory
    : [];
  const appended: QuestStatusHistoryEntry[] = [];

  for (const quest of QUEST_STATUS_HISTORY_QUESTS) {
    const prevStatus = questStatusOf(prev, quest);
    const nextStatus = questStatusOf(next, quest);
    // Camada 1: sem mudança real entre o estado anterior e o novo → nada.
    if (prevStatus === nextStatus) continue;
    // Camada 2: o último registro desta quest já tem o novo status (eco de
    // sincronização — outro dispositivo já registrou a alteração) → nada.
    const last = lastEntryFor(base, quest);
    if (last && last.status === nextStatus) continue;
    appended.push({ quest, status: nextStatus, at });
  }

  if (appended.length === 0) return null;
  return [...base, ...appended];
}
