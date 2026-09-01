import type { Timestamp } from "firebase/firestore";

export type Vocation = "EK" | "RP" | "MS" | "ED" | "MK";

/**
 * Instante persistido pela negociação. Registros antigos usavam epoch em ms;
 * novos writes usam Firestore Timestamp do servidor. A união mantém leitura
 * retrocompatível durante a migração, sem converter horário para string.
 */
export type NegotiationTimestamp = Timestamp | number;

// ============================================================================
// PROBABLE MARKERS — marcação de "provável Quest concluída"
// Quando uma PT é concluída, o sistema grava em sharedCharacters/{ownerUid}
// um marcador indicando que determinado personagem provavelmente já realizou
// a Quest. Esse marcador NÃO substitui os campos reais (soulwar/sanguine),
// mas faz a aplicação tratar o personagem como indisponível até que o
// proprietário atualize o campo real (via Att Chars ou edição manual).
// ============================================================================
export interface ProbableMarker {
  soulwar?: boolean;
  sanguine?: boolean;
}

export type ProbableMarkersMap = Record<string, ProbableMarker>;

export type VipCreditRequestStatus = "pendente" | "aprovado" | "recusado";

export interface VipCreditRequest {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  requestedDays: number;
  requestedMonths: number;
  requestedPriceRC?: number;
  selectedPlan?: "30_dias" | "90_dias";
  fromCharacter?: string;
  status: VipCreditRequestStatus;
  roleAtRequest: string;
  source: "vip_modal";
  createdAt: any;
  clientCreatedAt: number;
}

export interface ManualVipCreditNotification {
  id: string;
  userId: string;
  type: "vip_approved";
  title: string;
  body: string;
  status: "pending";
  read: false;
  createdAt: number;
  vipDays: number;
}

export interface VipPlansConfig {
  plan30PriceRC: number;
  plan90PriceRC: number;
}

export interface Character {
  id: string;
  account: string;
  personagem: string;
  servidor: string;
  voc: Vocation;
  level: number;
  soulwar: boolean;
  sanguine: boolean;
  soulwarDone?: boolean;
  sanguineDone?: boolean;
  /**
   * Identidade da conta (`ownerUid + nome normalizado`), usada para saber se
   * dois personagens são da MESMA conta real. Existe porque `account` guarda
   * apenas o nome escolhido pelo usuário — "1"/"Main" se repetem entre pessoas
   * diferentes e não identificam nada sozinhos.
   *
   * Preenchido nos SNAPSHOTS da PT, onde `account` é mascarado por privacidade
   * e portanto não pode servir de comparação. Opcional: PTs antigas não têm.
   */
  accountKey?: string | null;
  ownerUid?: string;
  ownerName?: string;
  valorPago: number;
  dropSW: number;
  dropBakra: number;
  valorVenda: number;
  valorVendaOriginal?: number;
  taxaAplicada?: number;
  vendido: boolean;
  aVenda?: boolean;
  shared?: boolean;
  dataCompra?: string;
  dataVenda?: string;
  notes?: string;
  itemDropadoSW?: string;
  itemDropadoSG?: string;
  createdAt: number;
  updatedAt: number;
}

export interface PartyCustomMember {
  id: string;
  label: string;
  /**
   * Nome do DONO real do personagem EXTERNO, informado obrigatoriamente no
   * formulário "+ Externo". É o proprietário de verdade do personagem — que
   * NÃO é, necessariamente, o usuário que o adicionou à PT.
   *
   * O campo operacional usado pela tabela (coluna DONO, divisão, WhatsApp)
   * continua sendo `slotData[id].owner`; este campo persiste a associação
   * no próprio membro externo para exibições que não dependem do slotData
   * (ex.: Histórico de PTs arquivadas sem slot para o membro).
   * Opcional: PTs antigas não possuem.
   */
  ownerName?: string;
  servidor: string;
  voc: Vocation;
  level: number;
  soulwar: boolean;
  sanguine: boolean;
}

export interface PartySlotData {
  deaths: number;
  drop: number;
  itemDropado: string;
  itemVendido: number;
  player: string;
  split: boolean;
  owner: string;
  ownerUid?: string;
  notes: string;
  pago: boolean;
  dropLocked?: boolean;
  calcLocked?: boolean;
  /**
   * Marca o slot como Service (personagem de terceiro).
   * É gravado no próprio slot — e não inferido da Lista de Espera — porque a
   * entrada da lista é removida quando a Quest é concluída, e a contabilização
   * de estatísticas também roda sobre PTs já arquivadas (catch-up sweep).
   * Sem esse campo persistido, o Service deixaria de ser contado depois da
   * remoção. Vale tanto para personagens vindos da ServiceList quanto para os
   * adicionados manualmente pelo botão "+ Externo".
   */
  isService?: boolean;
  /**
   * Referência para a negociação de uso financeiro temporário do personagem.
   * O DONO original permanece imutável; estes campos apenas permitem que a PT
   * preserve o vínculo com quem tem os direitos financeiros da Quest/venda.
   */
  characterAcquisitionId?: string;
  financialRightsHolderUid?: string;
  financialRightsHolderName?: string;
  /** Destino explicitamente escolhido da divisão financeira no slot. */
  splitTarget?: "owner" | "player";
  splitTargetName?: string;
  /** UID do usuário selecionado na coluna JOGADOR. Nunca derivar histórico por nome. */
  playerUid?: string;
  /** UID que recebe a divisão deste slot, congelado junto com splitTarget. */
  splitBeneficiaryUid?: string;
}

export type PtType = "soulwar" | "sanguine";

export interface PartyTab {
  id: string;
  name: string;
  slots: number;
  selectedIds: string[];
  customMembers?: PartyCustomMember[];
  slotData?: Record<string, PartySlotData>;
  archived?: boolean;
  archivedAt?: number;
  createdAt?: number;
  LeaderPT?: string;
  createdByName?: string;
  leaderUid?: string;
  invitedUsers?: string[];
  members?: string[];
  memberSnapshots?: Record<string, Character>;
  ptType?: PtType;
  questConcluida?: boolean;
  questFalha?: boolean;
  pagamentoFeito?: boolean;
  /** Estado operacional adicional; funções de backend fazem as transições críticas. */
  lifecycleStatus?: "active" | "quest_finalized" | "finalization_requested";
  questFinalizedAt?: NegotiationTimestamp;
  questFinalizedByUid?: string;
  /** Revisão do settlement materializada pelo backend para finalização otimista. */
  settlementRevision?: number;
  ptStartedAt?: number;
  ptDuration?: number;
  startedAt?: number;
  duration?: number;
  horarioTimestamp?: number;
  horarioChangedBy?: string;
  horarioChangedAt?: number;
  visibility?: "public" | "private";
  servidor?: string;
  notes?: string;
  isLocked?: boolean;
  isPaused?: boolean;
  // ── PAUSA E COOLDOWN DE BOSS ──────────────────────────────────────────────
  // Gravados na própria PT para que TODOS os participantes vejam o mesmo
  // cooldown, e para que ele sobreviva a fechar o app / reiniciar o PC.
  /** Id do Boss escolhido ao pausar. Vazio = pausa sem Boss (sem cooldown). */
  pausedBossId?: string;
  /** Instante da pausa (epoch ms). */
  pausedAt?: number;
  /** Instante em que o cooldown termina (epoch ms). Ausente = sem cooldown. */
  cooldownEndsAt?: number;
  /** Duração do cooldown em horas, como escolhida (20 ou 72). */
  cooldownHours?: number;
  /**
   * Exceção apenas da pausa atual: o Boss foi informado, mas não deve receber
   * cooldown. É apagada ao retomar a PT e não altera o catálogo normal.
   */
  cooldownIgnored?: boolean;
  /**
   * Tempo efetivo da PT já acumulado ANTES da pausa atual, em ms.
   *
   * O contador de duração deixa de ser `agora - ptStartedAt` e passa a ser
   * `accumulated + (agora - ptStartedAt)`, com `ptStartedAt` reiniciado a cada
   * retomada. Assim o período pausado nunca entra na conta, e o valor continua
   * correto depois de fechar e reabrir o app.
   */
  accumulatedMs?: number;
  dropsValuesSaved?: boolean;
  dropsValuesSavedBy?: string;
  dropsValuesSavedAt?: number;
}

/** Estado do resumo privado de PT materializado pelo backend. */
export type PersonalPartyHistoryStatus = "quest_finalized" | "finalized" | "failed";
export type PartyFinalizationReason = "payment" | "quest_failed";

export interface PersonalPartyHistorySlot {
  slotId: string;
  characterName: string;
  ownerName: string;
  playerName: string;
  deaths: number;
  itemDropado: string;
  itemVendido: number;
  paid: boolean;
  isService: boolean;
  isDivisionBeneficiary: boolean;
  divisionValue: number;
  /**
   * O slot participa da divisão (DIVIDIR marcado na PT)?
   * Presente nas projeções novas (materializadas pelo backend); registros
   * antigos não possuem e a interface trata a ausência como "não informado".
   */
  split?: boolean;
  /**
   * Destinatário explícito escolhido para a divisão deste slot, congelado no
   * momento da materialização. Usado pelo "Copiar (WA)" para nomear quem
   * recebe, exatamente como o painel da PT faz com `resolveSplitRecipient`.
   */
  splitTargetName?: string;
}

/**
 * Documento realmente privado em users/{uid}/partyHistory/{partyId}.
 * Não contém conta real, WhatsApp, custo de personagem ou detalhes privados
 * de aquisições de outros participantes.
 */
export interface PersonalPartyHistory {
  id: string;
  partyId: string;
  status: PersonalPartyHistoryStatus;
  sourceRevision: number;
  finalizationVersion?: number;
  party: {
    name: string;
    questType: PtType | "";
    server: string;
    leaderName: string;
    questFinalizedAt?: NegotiationTimestamp;
    finalizedAt?: NegotiationTimestamp;
    durationMs: number;
  };
  roles: {
    participant: boolean;
    leader: boolean;
    owner: boolean;
    player: boolean;
    divisionParticipant: boolean;
    financialRightsHolder: boolean;
  };
  personalSlots: PersonalPartyHistorySlot[];
  /**
   * Resumo completo de TODOS os personagens da PT — mesmo snapshot congelado
   * da conclusão, mesma forma de atualização em tempo real (o backend
   * reprojeta o documento a cada mudança relevante da PT). Cada usuário
   * participante recebe a mesma lista, o que transforma o card do histórico
   * em um resumo da PT inteira sem nenhuma leitura extra do Firestore.
   *
   * Opcional: projeções materializadas antes deste campo existir contêm
   * apenas `personalSlots` e continuam renderizando pelo formato antigo.
   */
  allSlots?: PersonalPartyHistorySlot[];
  division: {
    participates: boolean;
    beneficiarySlotIds: string[];
    valuePerMember: number;
  };
  createdAt?: any;
  updatedAt?: any;
}

export interface PartyFinalizationRequest {
  id: string;
  partyId: string;
  reason: PartyFinalizationReason;
  requestedByUid: string;
  expectedRevision: number;
  state: "requested" | "processing" | "completed" | "failed";
  clientRequestedAt: number;
  requestedAt?: any;
}

/**
 * Ciclo compartilhado da negociação. `created` é mantido apenas para ler
 * registros do fluxo antigo, que eram considerados aquisição concluída.
 */
export type CharacterAcquisitionStatus = "pre_approved" | "payment_confirmed" | "quest_completed" | "for_sale" | "sold" | "created";
export type CharacterAcquisitionPayoutStatus = "pending" | "confirmed";

/**
 * Registro compartilhado da negociação. Contém somente dados que ambos os
 * envolvidos podem acompanhar. Drops e lucro da Quest vivem em um documento
 * privado do adquirente para não expor sua informação financeira ao vendedor.
 */
export interface CharacterAcquisition {
  id: string;
  partyId: string;
  partyName: string;
  characterId: string;
  characterName: string;
  server: string;
  vocation: Vocation;
  level: number;
  originalOwnerUid: string;
  originalOwnerName: string;
  sellerMainCharacterName: string;
  acquirerUid: string;
  acquirerName: string;
  buyerMainCharacterName: string;
  /** Alias explícito do adquirente, usado pelas integrações financeiras. */
  financialRightsHolderUid: string;
  financialRightsHolderName: string;
  originalCharacterCost: number;
  /** Taxa pessoal definida pelo dono: 0, 25 ou 50 RC. */
  personalFee: number;
  /** Campo legado da primeira implementação; só usado como fallback de leitura. */
  additionalFee?: number;
  bazaarFee: number;
  /** Valor total que o comprador paga diretamente ao vendedor. */
  finalPaid: number;
  /** Quantia efetivamente recebida pelo vendedor do comprador, incluindo Bazaar. */
  sellerReceived: number;
  status: CharacterAcquisitionStatus;
  questType?: PtType;
  /** Legado: novos lucros ficam em CharacterAcquisitionBuyerDetails. */
  questProfit?: number;
  /**
   * Espelho de publicação do `Character.valorVenda` oficial do dono original.
   * Nunca é um preço independente: só existe para que o adquirente receba a
   * atualização em tempo real, sem obter acesso ao documento privado do dono.
   */
  saleValue?: number;
  createdAt: NegotiationTimestamp;
  createdByUid: string;
  createdByName: string;
  preApprovedAt?: NegotiationTimestamp;
  paymentConfirmedAt?: NegotiationTimestamp;
  paymentConfirmedByUid?: string;
  questCompletedAt?: NegotiationTimestamp;
  listedAt?: NegotiationTimestamp;
  soldAt?: NegotiationTimestamp;
  salePayoutStatus?: CharacterAcquisitionPayoutStatus;
  salePayoutConfirmedAt?: NegotiationTimestamp;
  salePayoutConfirmedByUid?: string;
  updatedAt: NegotiationTimestamp;
}

/**
 * Dados privados da Quest. Somente o adquirente e o Boss podem ler esse
 * documento; o dono original não recebe drop nem lucro da Quest.
 */
export interface CharacterAcquisitionBuyerDetails {
  id: string;
  acquisitionId: string;
  acquirerUid: string;
  questType?: PtType;
  /** Mesmo item selecionado nas colunas Drop SW/Drop SG, preservado em privado. */
  questDrops: string[];
  /** Origem do Drop: PT importada ou edição definitiva do comprador. */
  questDropsSource?: "pt" | "buyer";
  /** Mesmo valor exibido como Lucro SW/Lucro SG, preservado em privado. */
  questProfit: number;
  /** Origem do lucro: PT importada ou edição definitiva do comprador. */
  questProfitSource?: "pt" | "buyer";
  questCompletedAt?: NegotiationTimestamp;
  updatedAt: NegotiationTimestamp;
}

export interface WaitingService {
  id: string;
  personagem: string;
  ownerName: string;
  servidor: string;
  voc: Vocation;
  level: number;
  valorCombinado: number;
  dataAdicionado: string;
  notes: string;
  whatsappCountry: string;
  whatsappArea: string;
  whatsappNumber: string;
  addedBy: string;
  serviceiroUid?: string;
  quest: "soulwar" | "sanguine";
  /** Forma de pagamento escolhida no Formulário Público/edição. */
  paymentMethod?: ServicePaymentMethod;
  triagem?: boolean;
  createdAt: number;
  /**
   * Ciclo de vida (mesma semântica de `SharedService`): "realizado" quando a
   * Quest foi concluída com sucesso e o serviço foi entregue. Ausente (ou
   * "disponivel") = personagem na fila, ainda compartilhado para montagem de PT.
   */
  status?: "disponivel" | "realizado";
  /** Momento (ms) da entrega — conclusão da Quest da PT que levou o personagem. */
  realizadoAt?: number;
  createdBy?: string;
  createdByName?: string;
}

/**
 * Service próprio de um Serviceiro, persistido em `sharedServices/{uid}`.
 *
 * Diferente de `WaitingService` (que vive na Lista de Espera pública e é
 * REMOVIDO quando a Quest é concluída), este registro é permanente: ao ser
 * marcado como realizado ele apenas muda de status, preservando o histórico
 * e o lucro para o painel Stats.
 *
 * Os campos compartilhados com `WaitingService` mantêm exatamente o mesmo
 * nome e tipo, para que a futura migração e a inclusão em PTs reaproveitem
 * as funções já existentes sem conversão.
 */
export interface SharedService {
  id: string;
  personagem: string;
  ownerName: string;
  servidor: string;
  voc: Vocation;
  level: number;
  valorCombinado: number;
  notes: string;
  whatsappCountry: string;
  whatsappArea: string;
  whatsappNumber: string;
  quest: "soulwar" | "sanguine";
  /**
   * Forma de pagamento. Reaproveita os identificadores já usados pelo
   * PublicServiceForm ("pix" | "rc" | "5050"), somando "combinado" para o
   * valor acordado manualmente.
   */
  paymentMethod: ServicePaymentMethod;
  /** Data do Service (YYYY-MM-DD). Preenchida com hoje ao criar. */
  dataService: string;
  /** UID do Serviceiro dono do registro — sempre o usuário autenticado. */
  serviceiroUid: string;
  /** Nome do Serviceiro no momento do cadastro (exibição sem lookup). */
  serviceiroNome: string;
  /** "disponivel" enquanto pendente; "realizado" após a conclusão. */
  status: SharedServiceStatus;
  /** Lucro em RC obtido no Service — contabilizado no painel Stats. */
  lucroService: number;
  createdAt: number;
  updatedAt: number;
  /** Preenchido apenas quando `status === "realizado"`. */
  completedAt?: number;
}

export type SharedServiceStatus = "disponivel" | "realizado";

/**
 * Solicitação enviada pelo formulário público a um Serviceiro específico.
 *
 * Vive em `serviceRequests/{id}` — coleção SEPARADA de `sharedServices`, para
 * que um pedido não aprovado nunca se misture aos Services reais nem apareça
 * na ServiceList, nas PTs ou no Sugerir PT.
 *
 * Só vira um `SharedService` quando o destinatário aprova.
 */
export interface ServiceRequest {
  id: string;
  personagem: string;
  ownerName: string;
  servidor: string;
  voc: Vocation;
  level: number;
  notes: string;
  whatsappCountry: string;
  whatsappArea: string;
  whatsappNumber: string;
  quest: "soulwar" | "sanguine";
  paymentMethod: ServicePaymentMethod;
  /** UID do Serviceiro destinatário — define quem pode ver e decidir. */
  serviceiroUid: string;
  status: ServiceRequestStatus;
  createdAt: number;
  /** Momento da decisão (aprovação ou recusa). */
  decidedAt?: number;
  /** Id do SharedService gerado na aprovação — trava contra duplicação. */
  approvedServiceId?: string;
  source: "public_form";
}

export type ServiceRequestStatus = "pendente" | "aprovado" | "recusado";


export type ServicePaymentMethod = "pix" | "rc" | "5050" | "combinado" | "";

/** Valor padrão em RC do pagamento "1K RC" — já praticado pelo sistema. */
export const SERVICE_RC_VALUE = 1000;

/** Rótulos exibidos na seleção de pagamento. */
export const SERVICE_PAYMENT_LABELS: Record<Exclude<ServicePaymentMethod, "">, string> = {
  pix: "PIX",
  rc: "1K RC",
  "5050": "50/50",
  combinado: "Valor Combinado",
};

/**
 * Valor que deve ir para a coluna VALOR conforme a forma de pagamento.
 *
 * Só "1K RC" e "Valor Combinado" preenchem automaticamente. PIX e 50/50
 * retornam 0 de propósito: o valor é informado na conclusão.
 */
export function resolveServiceValue(method: ServicePaymentMethod, valorCombinado: number): number {
  if (method === "rc") return SERVICE_RC_VALUE;
  if (method === "combinado") return Number.isFinite(valorCombinado) && valorCombinado > 0 ? valorCombinado : 0;
  return 0;
}

export interface AppData {
  characters: Character[];
  notes: string;
  parties?: PartyTab[];
  waitingList?: WaitingService[];
}

export const VOCATIONS: Vocation[] = ["EK", "RP", "MS", "ED", "MK"];

export const VOC_COLORS: Record<Vocation, string> = {
  EK: "#94a3b8",
  RP: "#B8860B",
  MS: "#8B0000",
  ED: "#006400",
  MK: "#9c27b0",
};

export const VOC_LABEL: Record<Vocation, string> = {
  EK: "Elite Knight",
  RP: "Royal Paladin",
  MS: "Master Sorcerer",
  ED: "Elder Druid",
  MK: "Exalted Monk",
};

export function calcTotal(c: Character): number {
  return (c.dropSW + c.dropBakra + c.valorVenda) - c.valorPago;
}

export function formatRC(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(n));
  return sign + abs.toLocaleString("de-DE") + " RC";
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function formatDateBR(date?: string): string {
  if (!date) return "—";
  const [year, month, day] = date.split("-");
  if (!year || !month || !day) return date;
  return `${day}/${month}/${year}`;
}

/**
 * Timestamp (ms) → "dd/mm/aaaa hh:mm" no FUSO LOCAL do usuário.
 * Fonte de verdade para exibição de data+hora: o timestamp do documento
 * (ex.: `WaitingService.createdAt`), nunca uma string pré-formatada.
 */
export function formatDateTimeBR(ms?: number): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "—";
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export interface DialogOptions {
  type: "alert" | "confirm";
  title?: string;
  message: string;
  onConfirm?: () => void;
}

let dialogHandler: ((options: DialogOptions) => void) | null = null;

export function setGlobalDialogHandler(handler: (options: DialogOptions) => void) {
  dialogHandler = handler;
}

export function customAlert(message: string, title = "Aviso") {
  if (dialogHandler) {
    dialogHandler({ type: "alert", title, message });
  } else {
    console.warn(title + ": " + message);
  }
}

export function customConfirm(message: string, onConfirm: () => void, title = "Confirmação") {
  if (dialogHandler) {
    dialogHandler({ type: "confirm", title, message, onConfirm });
  } else {
    console.warn("Confirmação ignorada: " + message);
  }
}