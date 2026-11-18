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
  /**
   * PROTEÇÃO CONTRA ALTERAÇÕES ACIDENTAIS (103ª): `true` quando a realização
   * à qual este drop pertence foi DESFEITA (status da quest voltou a
   * "Disponível" depois dela, sem nova conclusão). O registro bruto é
   * PRESERVADO no histórico (nada é apagado) — ele apenas deixa de contar
   * nas listagens válidas ("Últimos Drops" e Stats). Drops de ROTAÇÕES
   * Sanguine nunca são revertidos por status (a rotação é uma resposta
   * explícita "Drop?" — voltar a SG a "Disponível" é o ciclo normal).
   */
  reverted: boolean;
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
 * ANÁLISE ÚNICA do histórico de UM personagem (103ª) — ponto central que
 * produz, de uma vez, os DROPS (com a flag `reverted`) e as REALIZAÇÕES
 * VÁLIDAS. Tudo deriva daqui: "Últimos Drops", "Últimas Quests" e a guia
 * Stats leem o MESMO resultado (nenhum consumidor tem regra própria).
 *
 * Regras:
 *   • DROPS = registros `kind:"drop"` + campos atuais itemDropadoXX/At ainda
 *     não representados (retrocompatibilidade sem migração; dedup item+data).
 *   • REALIZAÇÃO = conclusão de status (status=false, 98ª) ou rotação SG
 *     (kind="rotation" — conta SEMPRE, com ou sem drop). A conclusão de
 *     status da SG nascida no MESMO salvamento de uma rotação é a MESMA
 *     realização (só a rotação entra).
 *   • PROTEÇÃO (103ª): conclusão de status seguida de volta a "Disponível"
 *     (registro status=true posterior) = alteração desfeita → NÃO conta como
 *     realização e o drop a ela associado fica `reverted` (fora dos "últimos
 *     drops válidos" e da Stats). O histórico bruto é integralmente
 *     preservado; nova conclusão posterior gera realização nova, normalmente.
 *     Rotações SG nunca são invalidadas por status (resposta explícita).
 *   • Associação drop ↔ realização: cada drop pertence à realização mais
 *     próxima ANTERIOR (com margem para o fluxo item→conclusão automática);
 *     drop sem realização conhecida é revertido apenas se um status=true
 *     posterior o desfez; drops sem data (legados) nunca são presumidos
 *     revertidos (nada se inventa).
 */
function analyzeCharacterQuestHistory(character: Character): {
  drops: CharacterDropEvent[];
  realizations: QuestRealizationEvent[];
} {
  const history = Array.isArray(character.questStatusHistory) ? character.questStatusHistory : [];
  const server = String(character.servidor || "").trim();
  const name = String(character.personagem || "").trim();

  // ── DROPS brutos (histórico + retrocompatibilidade, dedup item+data) ─────
  const drops: CharacterDropEvent[] = [];
  const dropOf = (quest: QuestStatusHistoryQuest, item: string, at: number | null): CharacterDropEvent => ({
    charId: character.id, server, character: name, quest, item, at, reverted: false,
  });
  for (const entry of history) {
    if (entry && entry.kind === "drop" && String(entry.item || "").trim()) {
      drops.push(dropOf(entry.quest, String(entry.item).trim(), entry.at > 0 ? entry.at : null));
    }
  }
  for (const quest of QUEST_STATUS_HISTORY_QUESTS) {
    const fields = DROP_FIELDS[quest];
    const item = String(character[fields.item] || "").trim();
    if (!item) continue;
    const at = Number(character[fields.at]) || 0;
    const represented = drops.some(ev => ev.quest === quest && ev.item === item && (at > 0 ? ev.at === at : true));
    if (!represented) drops.push(dropOf(quest, item, at > 0 ? at : null));
  }

  // ── Entradas de status e rotações ────────────────────────────────────────
  const statusEntries = history.filter(e => e && isStatusEntry(e) && e.at > 0);
  const rotations = history.filter(e => e && e.kind === "rotation" && e.at > 0);
  const revertedAfter = (quest: QuestStatusHistoryQuest, at: number): boolean =>
    statusEntries.some(e => e.quest === quest && e.status === true && e.at > at);

  // ── Candidatos a realização (rotações + conclusões, com validade) ────────
  interface Candidate { quest: QuestStatusHistoryQuest; at: number; invalid: boolean; event: QuestRealizationEvent }
  const candidates: Candidate[] = [];
  const realizationOf = (quest: QuestStatusHistoryQuest, at: number): QuestRealizationEvent => ({
    charId: character.id, server, character: name, quest, at, withDrop: false, item: null, rot: null,
  });
  for (const entry of rotations) {
    candidates.push({
      quest: "sanguine", at: entry.at, invalid: false,
      event: { ...realizationOf("sanguine", entry.at), withDrop: entry.drop === true, rot: typeof entry.rot === "number" ? entry.rot : null },
    });
  }
  for (const entry of statusEntries) {
    if (entry.status !== false) continue;
    // Conclusão de status da SG nascida JUNTO de uma rotação (mesmo
    // salvamento) é a MESMA realização → só a rotação entra.
    if (entry.quest === "sanguine" && rotations.some(r => Math.abs(r.at - entry.at) <= DROP_MATCH_MARGIN_MS)) continue;
    // PROTEÇÃO (103ª): conclusão desfeita (voltou a "Disponível" depois) não
    // conta como realização — mas permanece como alvo de pareamento para que
    // o drop associado seja marcado como revertido junto.
    candidates.push({ quest: entry.quest, at: entry.at, invalid: revertedAfter(entry.quest, entry.at), event: realizationOf(entry.quest, entry.at) });
  }

  // ── Associação drop ↔ realização POR QUEST ──────────────────────────────
  // Dono do drop: (1) a PRIMEIRA realização imediatamente posterior dentro
  // da margem (fluxo item→conclusão automática no mesmo salvamento) ou, não
  // havendo, (2) a última realização ANTERIOR ao drop (item registrado
  // depois da conclusão). Um drop nunca "pula" para uma realização mais
  // nova que a sua (ex.: drop de conclusão desfeita não é associado à
  // re-conclusão seguinte — a 103ª o marca como revertido junto com ela).
  for (const quest of QUEST_STATUS_HISTORY_QUESTS) {
    const questCandidates = candidates.filter(c => c.quest === quest).sort((a, b) => a.at - b.at);
    for (const drop of drops) {
      if (drop.quest !== quest || drop.at === null) continue;
      let target: Candidate | null = null;
      for (const candidate of questCandidates) {
        if (candidate.at >= drop.at && candidate.at <= drop.at + DROP_MATCH_MARGIN_MS) { target = candidate; break; }
      }
      if (!target) {
        for (const candidate of questCandidates) {
          if (candidate.at <= drop.at) target = candidate;
          else break;
        }
      }
      if (target) {
        if (target.invalid) {
          drop.reverted = true;             // realização desfeita → drop fora das listas válidas
        } else if (target.event.item === null) {
          target.event.withDrop = true;
          target.event.item = drop.item;
        }
      } else {
        // Sem realização conhecida (ex.: drop legado anterior à 98ª): só um
        // status=true POSTERIOR desfaz o drop (alteração acidental corrigida).
        drop.reverted = revertedAfter(quest, drop.at);
      }
    }
  }

  return { drops, realizations: candidates.filter(c => !c.invalid).map(c => c.event) };
}

/**
 * TODOS os drops conhecidos de UM personagem (inclusive os revertidos, com a
 * flag) — a Stats conta apenas `!reverted`; listas cronológicas usam
 * `collectRecentDrops`. Fonte única: analyzeCharacterQuestHistory.
 */
export function collectCharacterDropEvents(character: Character): CharacterDropEvent[] {
  return analyzeCharacterQuestHistory(character).drops;
}

/**
 * Drops VÁLIDOS de todos os personagens informados, do MAIS RECENTE para o
 * mais antigo (somente eventos com data real — sem data não há cronologia;
 * drops de realizações desfeitas ficam fora: proteção da 103ª).
 */
export function collectRecentDrops(characters: Character[]): CharacterDropEvent[] {
  const all: CharacterDropEvent[] = [];
  for (const character of characters) {
    for (const ev of collectCharacterDropEvents(character)) {
      if (ev.at !== null && !ev.reverted) all.push(ev);
    }
  }
  return all.sort((a, b) => b.at! - a.at! || a.character.localeCompare(b.character));
}

/**
 * QUESTS REALIZADAS VÁLIDAS de todos os personagens, da mais recente para a
 * mais antiga (conclusões desfeitas — voltas a "Disponível" — não contam:
 * proteção da 103ª). Fonte única: analyzeCharacterQuestHistory.
 */
export function collectQuestRealizations(characters: Character[]): QuestRealizationEvent[] {
  const all: QuestRealizationEvent[] = [];
  for (const character of characters) {
    all.push(...analyzeCharacterQuestHistory(character).realizations);
  }
  return all.sort((a, b) => b.at - a.at || a.character.localeCompare(b.character));
}
