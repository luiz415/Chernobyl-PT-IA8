// ============================================================================
// TUTORIAL — PTs DEMONSTRATIVAS (todas as fases do Gerenciador preenchidas)
// ----------------------------------------------------------------------------
// Seis PTs fictícias — duas Com Vagas, uma Pronta, uma Iniciada e duas
// Aguardando Pagamento — para que os tópicos "Painel da PT" e "Gerenciador
// de PTs" fiquem preenchidos e realistas mesmo quando o usuário ainda não
// possui nenhuma PT real.
//
// Datas/cronômetros são calculados em relação a `now` no momento da carga
// (não são constantes congeladas): a PT "Iniciada" mostra o cronômetro
// correndo de verdade e as "Com Vagas" têm horários futuros plausíveis.
// As PTs "Aguardando" carregam itens dropados AINDA NÃO vendidos — assim o
// botão "Itens a Venda" do Gerenciador pulsa e o modal abre preenchido.
// ============================================================================
import type { Character, PartyTab } from "../../types";
import { buildDemoCharacters } from "./demoCharacters";

function snapshotOf(c: Character): Character {
  // Mesmo formato dos memberSnapshots reais: conta mascarada por privacidade.
  return { ...c, account: "•••", accountKey: `demo-acc-${c.id}` };
}

export function buildDemoParties(now: number): PartyTab[] {
  const chars = buildDemoCharacters(now);
  const snapshots: Record<string, Character> = {};
  chars.forEach(c => { snapshots[c.id] = snapshotOf(c); });

  /** PT COM VAGAS — 3/5 slots, agendada para amanhã. */
  const comVagas: PartyTab = {
    id: "demo-pt-vagas",
    name: "PT Demo — Com Vagas",
    slots: 5,
    selectedIds: ["demo-char-1", "demo-char-3", "demo-char-15"],
    ptType: "soulwar",
    servidor: "Elysian",
    visibility: "public",
    LeaderPT: "Você",
    createdByName: "Você",
    leaderUid: "demo-uid-you",
    createdAt: now - 2 * 3600000,
    horarioTimestamp: now + 22 * 3600000,
    memberSnapshots: snapshots,
    slotData: {
      "demo-char-1": { deaths: 0, drop: 0, itemDropado: "", itemVendido: 0, player: "Você", split: true, owner: "Você", notes: "", pago: false },
      "demo-char-3": { deaths: 0, drop: 0, itemDropado: "", itemVendido: 0, player: "Demo Ana", split: true, owner: "Você", notes: "", pago: false },
      "demo-char-15": { deaths: 0, drop: 0, itemDropado: "", itemVendido: 0, player: "Demo Rafael", split: false, owner: "Você", notes: "Service da fila", pago: false, isService: true },
    },
    notes: "PT demonstrativa do tutorial — os dados não são reais.",
  };

  /** PT COM VAGAS 2 — Sanguine pública, 2/5 slots, agendada para depois de amanhã. */
  const comVagas2: PartyTab = {
    id: "demo-pt-vagas-2",
    name: "PT Demo — Sanguine Aberta",
    slots: 5,
    selectedIds: ["demo-char-7", "demo-char-10"],
    ptType: "sanguine",
    servidor: "Solarian",
    visibility: "public",
    LeaderPT: "Demo Carla",
    createdByName: "Demo Carla",
    leaderUid: "demo-uid-carla",
    createdAt: now - 8 * 3600000,
    horarioTimestamp: now + 46 * 3600000,
    memberSnapshots: snapshots,
    slotData: {
      "demo-char-7": { deaths: 0, drop: 0, itemDropado: "", itemVendido: 0, player: "Você", split: true, owner: "Você", notes: "", pago: false },
      "demo-char-10": { deaths: 0, drop: 0, itemDropado: "", itemVendido: 0, player: "Demo Carla", split: true, owner: "Você", notes: "", pago: false },
    },
    notes: "",
  };

  /** PT PRONTA — 4/4 slots preenchidos, Quest ainda não iniciada. */
  const pronta: PartyTab = {
    id: "demo-pt-pronta",
    name: "PT Demo — Pronta",
    slots: 4,
    selectedIds: ["demo-char-2", "demo-char-4", "demo-char-16"],
    customMembers: [
      { id: "demo-ext-1", label: "Demo External", ownerName: "Demo Carla", servidor: "Lunarian", voc: "MS", level: 372, soulwar: false, sanguine: true },
    ],
    ptType: "sanguine",
    servidor: "Lunarian",
    visibility: "private",
    LeaderPT: "Você",
    createdByName: "Você",
    leaderUid: "demo-uid-you",
    createdAt: now - 26 * 3600000,
    horarioTimestamp: now + 3 * 3600000,
    memberSnapshots: snapshots,
    slotData: {
      "demo-char-2": { deaths: 0, drop: 0, itemDropado: "", itemVendido: 0, player: "Você", split: true, owner: "Você", notes: "", pago: false },
      "demo-char-4": { deaths: 0, drop: 0, itemDropado: "", itemVendido: 0, player: "Demo Bruno", split: true, owner: "Você", notes: "", pago: false },
      "demo-char-16": { deaths: 0, drop: 0, itemDropado: "", itemVendido: 0, player: "Demo Ana", split: true, owner: "Você", notes: "", pago: false },
      "demo-ext-1": { deaths: 0, drop: 0, itemDropado: "", itemVendido: 0, player: "Demo Carla", split: false, owner: "Demo Carla", notes: "Personagem externo", pago: false },
    },
    notes: "",
  };

  /** PT INICIADA — cronômetro rodando há ~47 minutos. */
  const iniciada: PartyTab = {
    id: "demo-pt-iniciada",
    name: "PT Demo — Iniciada",
    slots: 4,
    selectedIds: ["demo-char-1", "demo-char-2", "demo-char-3", "demo-char-4"],
    ptType: "soulwar",
    servidor: "Elysian",
    visibility: "private",
    LeaderPT: "Você",
    createdByName: "Você",
    leaderUid: "demo-uid-you",
    createdAt: now - 3 * 3600000,
    ptStartedAt: now - 47 * 60000,
    accumulatedMs: 0,
    memberSnapshots: snapshots,
    slotData: {
      "demo-char-1": { deaths: 0, drop: 0, itemDropado: "", itemVendido: 0, player: "Você", split: true, owner: "Você", notes: "", pago: false },
      "demo-char-2": { deaths: 1, drop: 0, itemDropado: "", itemVendido: 0, player: "Demo Bruno", split: true, owner: "Você", notes: "", pago: false },
      "demo-char-3": { deaths: 0, drop: 0, itemDropado: "", itemVendido: 0, player: "Demo Ana", split: true, owner: "Você", notes: "", pago: false },
      "demo-char-4": { deaths: 0, drop: 0, itemDropado: "", itemVendido: 0, player: "Demo Rafael", split: true, owner: "Você", notes: "", pago: false },
    },
    notes: "Quest em andamento (demonstração).",
  };

  /** PT AGUARDANDO PAGAMENTO — Quest concluída, drops lançados, 2/4 pagos.
   *  O Soulcutter do slot 1 ainda NÃO foi vendido → alimenta "Itens a Venda". */
  const aguardando: PartyTab = {
    id: "demo-pt-aguardando",
    name: "PT Demo — Aguardando Pagamento",
    slots: 4,
    selectedIds: ["demo-char-1", "demo-char-3", "demo-char-15", "demo-char-11"],
    ptType: "soulwar",
    servidor: "Solarian",
    visibility: "private",
    LeaderPT: "Você",
    createdByName: "Você",
    leaderUid: "demo-uid-you",
    createdAt: now - 30 * 3600000,
    questConcluida: true,
    ptStartedAt: undefined,
    accumulatedMs: 2 * 3600000 + 12 * 60000,
    dropsValuesSaved: true,
    dropsValuesSavedBy: "Você",
    dropsValuesSavedAt: now - 50 * 60000,
    memberSnapshots: snapshots,
    slotData: {
      "demo-char-1": { deaths: 0, drop: 210, itemDropado: "Soulcutter", itemVendido: 0, player: "Você", split: true, owner: "Você", notes: "Item aguardando venda", pago: true, dropLocked: true },
      "demo-char-3": { deaths: 1, drop: 145, itemDropado: "", itemVendido: 0, player: "Demo Ana", split: true, owner: "Você", notes: "", pago: true, dropLocked: true },
      "demo-char-15": { deaths: 0, drop: 95, itemDropado: "", itemVendido: 0, player: "Demo Rafael", split: true, owner: "Você", notes: "", pago: false, dropLocked: true },
      "demo-char-11": { deaths: 2, drop: 80, itemDropado: "", itemVendido: 0, player: "Demo Bruno", split: true, owner: "Você", notes: "", pago: false, dropLocked: true },
    },
    notes: "Aguardando os dois últimos pagamentos (demonstração).",
  };

  /** PT AGUARDANDO PAGAMENTO 2 — Sanguine com item Grand ainda à venda. */
  const aguardando2: PartyTab = {
    id: "demo-pt-aguardando-2",
    name: "PT Demo — Sanguine a Pagar",
    slots: 4,
    selectedIds: ["demo-char-7", "demo-char-10", "demo-char-13", "demo-char-5"],
    ptType: "sanguine",
    servidor: "Solarian",
    visibility: "private",
    LeaderPT: "Você",
    createdByName: "Você",
    leaderUid: "demo-uid-you",
    createdAt: now - 52 * 3600000,
    questConcluida: true,
    ptStartedAt: undefined,
    accumulatedMs: 3 * 3600000 + 4 * 60000,
    dropsValuesSaved: true,
    dropsValuesSavedBy: "Você",
    dropsValuesSavedAt: now - 5 * 3600000,
    memberSnapshots: snapshots,
    slotData: {
      "demo-char-7": { deaths: 0, drop: 320, itemDropado: "Grand Sanguine Rod", itemVendido: 0, player: "Você", split: true, owner: "Você", notes: "Grand drop — anunciado", pago: true, dropLocked: true },
      "demo-char-10": { deaths: 0, drop: 180, itemDropado: "Sanguine Blade", itemVendido: 165, player: "Demo Carla", split: true, owner: "Você", notes: "", pago: true, dropLocked: true },
      "demo-char-13": { deaths: 1, drop: 120, itemDropado: "", itemVendido: 0, player: "Demo Sofia", split: true, owner: "Você", notes: "", pago: false, dropLocked: true },
      "demo-char-5": { deaths: 0, drop: 90, itemDropado: "", itemVendido: 0, player: "Demo Bruno", split: true, owner: "Você", notes: "", pago: false, dropLocked: true },
    },
    notes: "Grand Sanguine Rod ainda à venda (demonstração).",
  };

  return [comVagas, comVagas2, pronta, iniciada, aguardando, aguardando2];
}
