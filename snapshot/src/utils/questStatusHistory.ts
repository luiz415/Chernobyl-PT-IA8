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

/** Um registro é de MUDANÇA DE STATUS? (formato original da 98ª — `kind`
 *  ausente — ou `kind: "status"` explícito). */
function isStatusEntry(entry: QuestStatusHistoryEntry): boolean {
  return !entry.kind || entry.kind === "status";
}

/** Último registro de um TIPO de uma quest específica no histórico (ou null). */
function lastEntryFor(
  history: QuestStatusHistoryEntry[] | undefined,
  quest: QuestStatusHistoryQuest,
  kind: "status" | "drop" | "rotation",
): QuestStatusHistoryEntry | null {
  if (!Array.isArray(history)) return null;
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (!entry || entry.quest !== quest) continue;
    if (kind === "status" ? isStatusEntry(entry) : entry.kind === kind) return entry;
  }
  return null;
}

/** Campos de ITEM DROPADO de cada quest (células DROP SW/SG/GB do CharTable). */
const DROP_FIELDS: Record<QuestStatusHistoryQuest, { item: "itemDropadoSW" | "itemDropadoSG" | "itemDropadoCrypt"; at: "itemDropadoSWAt" | "itemDropadoSGAt" | "itemDropadoCryptAt" }> = {
  soulwar: { item: "itemDropadoSW", at: "itemDropadoSWAt" },
  sanguine: { item: "itemDropadoSG", at: "itemDropadoSGAt" },
  crypt: { item: "itemDropadoCrypt", at: "itemDropadoCryptAt" },
};

/** Rotações SG concluídas — mesma sanitização de utils/sanguineRotation
 *  (duplicada aqui de propósito: módulo puro, sem dependências cruzadas). */
function sgRotOf(value: unknown): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return 0;
  const int = Math.floor(num);
  return int >= 0 ? int : 0;
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
    const last = lastEntryFor(base, quest, "status");
    if (last && last.status === nextStatus) continue;
    appended.push({ quest, status: nextStatus, at });
  }

  // ── DROPS (102ª) — item dropado registrado/atualizado ─────────────────────
  // Mesmas duas camadas anti-duplicação da 98ª: (1) só quando o item/data
  // EFETIVAMENTE mudou entre o estado anterior e o novo; (2) se o último
  // registro de drop da quest já tem o MESMO item e a MESMA data (eco de
  // sincronização), nada é anexado. `at` do registro = itemDropadoXXAt REAL
  // (gravado no clique da célula DROP — nunca se inventa data); remoção do
  // item NÃO é drop (nenhum registro). O histórico anterior é preservado.
  for (const quest of QUEST_STATUS_HISTORY_QUESTS) {
    const fields = DROP_FIELDS[quest];
    const prevItem = String(prev[fields.item] || "").trim();
    const nextItem = String(next[fields.item] || "").trim();
    const prevAt = Number(prev[fields.at]) || 0;
    const nextAt = Number(next[fields.at]) || 0;
    if (!nextItem) continue;                                   // sem item → nada
    if (nextItem === prevItem && nextAt === prevAt) continue;  // camada 1
    const last = lastEntryFor(base, quest, "drop");
    if (last && last.item === nextItem && last.at === (nextAt || at)) continue; // camada 2
    appended.push({ quest, status: false, at: nextAt || at, kind: "drop", item: nextItem });
  }

  // ── ROTAÇÕES SANGUINE (102ª) — rotação concluída = quest realizada ───────
  // sgRot AUMENTOU (resposta "Drop?" Sim OU Não na PT concluída, ou edição
  // manual) → UM registro com o número da rotação e se houve drop
  // (sgDropRot === rotação, mesma regra das colunas "Rot SG"). Camada 2: o
  // último registro de rotação já tem o mesmo número (eco de sincronização)
  // → nada. Redução manual do contador nunca gera registro.
  {
    const prevRot = sgRotOf(prev.sgRot);
    const nextRot = sgRotOf(next.sgRot);
    if (nextRot > prevRot) {
      const last = lastEntryFor(base, "sanguine", "rotation");
      if (!last || last.rot !== nextRot) {
        appended.push({
          quest: "sanguine",
          status: false,
          at,
          kind: "rotation",
          rot: nextRot,
          drop: sgRotOf(next.sgDropRot) === nextRot && nextRot > 0,
        });
      }
    }
  }

  if (appended.length === 0) return null;
  return [...base, ...appended];
}

// ============================================================================
// DERIVAÇÕES COMPARTILHADAS (102ª tarefa) — FONTE ÚNICA de leitura do
// histórico para os modais "Últimos Drops"/"Últimas Quests" E a guia Stats.
// Funções puras sobre os personagens da lista pessoal: nenhum consumidor
// mantém histórico próprio, e novos indicadores podem reutilizá-las.
// ============================================================================

/** Um DROP de um personagem (histórico + retrocompatibilidade). */
export interface CharacterDropEvent {
  charId: string;
  server: string;
  character: string;
  quest: QuestStatusHistoryQuest;
  item: string;
  /**
   * Data/hora REAL do drop (epoch ms) — `null` apenas para itens legados
   * gravados antes do campo itemDropadoXXAt existir (contam nas estatísticas,
   * mas nunca entram em listas cronológicas: data não se inventa).
   */
  at: number | null;
}

/**
 * TODOS os drops conhecidos de UM personagem: os registros `kind:"drop"` do
 * histórico + os campos atuais itemDropadoXX/At quando AINDA não representados
 * no histórico (retrocompatibilidade: itens selecionados antes da 102ª não
 * geraram registro — entram pela data real já gravada neles, sem migração e
 * sem duplicar: item+data iguais ao último registro são o MESMO drop).
 */
export function collectCharacterDropEvents(character: Character): CharacterDropEvent[] {
  const history = Array.isArray(character.questStatusHistory) ? character.questStatusHistory : [];
  const events: CharacterDropEvent[] = [];
  const baseOf = (quest: QuestStatusHistoryQuest, item: string, at: number | null): CharacterDropEvent => ({
    charId: character.id,
    server: String(character.servidor || "").trim(),
    character: String(character.personagem || "").trim(),
    quest,
    item,
    at,
  });

  for (const entry of history) {
    if (entry && entry.kind === "drop" && String(entry.item || "").trim()) {
      events.push(baseOf(entry.quest, String(entry.item).trim(), entry.at > 0 ? entry.at : null));
    }
  }

  for (const quest of QUEST_STATUS_HISTORY_QUESTS) {
    const fields = DROP_FIELDS[quest];
    const item = String(character[fields.item] || "").trim();
    if (!item) continue;
    const at = Number(character[fields.at]) || 0;
    const represented = events.some(ev =>
      ev.quest === quest && ev.item === item && (at > 0 ? ev.at === at : true),
    );
    if (!represented) events.push(baseOf(quest, item, at > 0 ? at : null));
  }

  return events;
}

/**
 * Drops de TODOS os personagens informados, do MAIS RECENTE para o mais
 * antigo (somente eventos com data real — sem data não há cronologia).
 */
export function collectRecentDrops(characters: Character[]): CharacterDropEvent[] {
  const all: CharacterDropEvent[] = [];
  for (const character of characters) {
    for (const ev of collectCharacterDropEvents(character)) {
      if (ev.at !== null) all.push(ev);
    }
  }
  return all.sort((a, b) => b.at! - a.at! || a.character.localeCompare(b.character));
}

/** Uma QUEST REALIZADA por um personagem (conclusão de status ou rotação SG). */
export interface QuestRealizationEvent {
  charId: string;
  server: string;
  character: string;
  quest: QuestStatusHistoryQuest;
  /** Data/hora REAL da conclusão (epoch ms). */
  at: number;
  /** Houve drop nesta realização? ("Com drop" / "Sem drop"). */
  withDrop: boolean;
  /** Item dropado associado (quando conhecido). */
  item: string | null;
  /** Número da rotação Sanguine (só para realizações vindas de rotação). */
  rot: number | null;
}

/** Janela de associação drop ↔ realização: cobre o fluxo real das células
 *  DROP (selecionar o item CONCLUI a quest no MESMO salvamento — o registro
 *  de status nasce milissegundos depois do horário do clique no item). */
const DROP_MATCH_MARGIN_MS = 10 * 60_000;

/**
 * QUESTS REALIZADAS de todos os personagens, da mais recente para a mais
 * antiga. Realização = registro de CONCLUSÃO de status (status=false, 98ª)
 * OU rotação Sanguine concluída (kind="rotation" — conta SEMPRE, com ou sem
 * drop). Quando a conclusão de status da SG nasce no MESMO salvamento da
 * rotação, só a rotação aparece (evita linha duplicada da mesma realização).
 * "Com drop": rotações respondem por si (campo `drop`); para as demais
 * realizações, um drop registrado da MESMA quest é associado à realização
 * mais próxima anterior (com margem para o fluxo item→conclusão automática).
 */
export function collectQuestRealizations(characters: Character[]): QuestRealizationEvent[] {
  const all: QuestRealizationEvent[] = [];

  for (const character of characters) {
    const history = Array.isArray(character.questStatusHistory) ? character.questStatusHistory : [];
    const drops = collectCharacterDropEvents(character).filter(ev => ev.at !== null);
    const rotations = history.filter(e => e && e.kind === "rotation");

    const realizations: QuestRealizationEvent[] = [];
    const baseOf = (quest: QuestStatusHistoryQuest, at: number): QuestRealizationEvent => ({
      charId: character.id,
      server: String(character.servidor || "").trim(),
      character: String(character.personagem || "").trim(),
      quest,
      at,
      withDrop: false,
      item: null,
      rot: null,
    });

    for (const entry of history) {
      if (!entry || entry.at <= 0) continue;
      if (entry.kind === "rotation") {
        realizations.push({ ...baseOf("sanguine", entry.at), withDrop: entry.drop === true, rot: typeof entry.rot === "number" ? entry.rot : null });
        continue;
      }
      if (!isStatusEntry(entry) || entry.status !== false) continue;
      // Conclusão de status da SG nascida JUNTO de uma rotação (mesmo
      // salvamento) é a MESMA realização → só a rotação entra.
      if (entry.quest === "sanguine" && rotations.some(r => Math.abs(r.at - entry.at) <= DROP_MATCH_MARGIN_MS)) continue;
      realizations.push(baseOf(entry.quest, entry.at));
    }

    // Associação drop ↔ realização POR QUEST: cada drop pertence à realização
    // mais próxima ANTERIOR (com margem); drops nunca se duplicam entre
    // realizações e uma rotação com resposta "Sim" apenas ganha o nome do item.
    for (const quest of QUEST_STATUS_HISTORY_QUESTS) {
      const questRealizations = realizations
        .filter(r => r.quest === quest)
        .sort((a, b) => a.at - b.at);
      if (questRealizations.length === 0) continue;
      for (const drop of drops.filter(d => d.quest === quest)) {
        let target: QuestRealizationEvent | null = null;
        for (const realization of questRealizations) {
          if (realization.at <= drop.at! + DROP_MATCH_MARGIN_MS) target = realization;
          else break;
        }
        if (target && target.item === null) {
          target.withDrop = true;
          target.item = drop.item;
        }
      }
    }

    all.push(...realizations);
  }

  return all.sort((a, b) => b.at - a.at || a.character.localeCompare(b.character));
}
