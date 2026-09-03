// ============================================================================
// REGISTRO CENTRAL DE PREFERÊNCIAS DE NOTIFICAÇÃO
// ============================================================================
//
// Fonte única da verdade sobre QUAIS notificações existem no aplicativo e se
// cada uma está ligada. Antes desta central, as preferências estavam
// espalhadas: três chaves soltas para os lembretes de PT, uma para o som,
// uma para o desktop — e a maioria dos tipos sequer tinha controle.
//
// PRINCÍPIOS
//
// 1. NENHUMA CHAVE NOVA PARA PREFERÊNCIA QUE JÁ EXISTIA. Os identificadores
//    antigos (`notif_pt_30`, `notif_pt_15`, `notif_pt_5`, `tibia_notify_sound`,
//    `tibia_notify_desktop`) continuam sendo lidos e gravados exatamente como
//    antes, então quem já tinha algo desligado continua com aquilo desligado.
//    Só os tipos que NUNCA tiveram controle ganharam chave nova.
//
// 2. PADRÃO LIGADO. Ausência de valor = notificação ativa. Isso preserva o
//    comportamento atual para quem nunca abriu as configurações.
//
// 3. O PORTÃO É ÚNICO. `isNotificationTypeEnabled` é consultado num só ponto
//    do fluxo de entrega (`addNotification` em `useNotifications`). A lógica
//    de DISPARO de cada notificação não foi tocada.
//
// 4. NOTIFICAÇÕES OBRIGATÓRIAS. Algumas não podem ser desligadas (ver
//    `mandatory` abaixo). Elas aparecem no modal com cadeado, para o usuário
//    saber que existem — nunca são escondidas por baixo do tapete.
// ============================================================================

/** Todos os tipos de notificação do aplicativo (espelha `Notification["type"]`). */
export type NotificationTypeId =
  | "pt_added"
  | "pt_reminder"
  | "pt_updated"
  | "schedule_changed"
  | "quest_completed_donation"
  | "party_finalized"
  | "bazaar_interest_ending"
  | "bazaar_daily_available"
  | "service_request"
  | "service_waiting"
  | "vip_approved"
  | "payment_received"
  | "update_available"
  | "request_entry"
  | "rate_limit_block";

export type NotificationCategoryId =
  | "pt"
  | "bazaar"
  | "services"
  | "vip"
  | "system"
  | "admin";

export interface NotificationCategory {
  id: NotificationCategoryId;
  label: string;
  description: string;
}

export interface NotificationPreferenceItem {
  /** Tipo real da notificação, igual ao gravado no Firestore. */
  id: NotificationTypeId;
  category: NotificationCategoryId;
  label: string;
  description: string;
  /** Chave no localStorage. Reaproveita a antiga quando ela já existia. */
  storageKey: string;
  /** Só aparece (e só existe) para usuários Boss. */
  bossOnly?: boolean;
  /** Só faz sentido no Electron (ex.: atualização do app instalado). */
  electronOnly?: boolean;
  /** Não pode ser desligada — exibida com cadeado e sempre ativa. */
  mandatory?: boolean;
  /**
   * Motivo de ser obrigatória. Exibido no modal para o usuário entender por
   * que aquele item não tem interruptor.
   */
  mandatoryReason?: string;
  /** Sub-opções (ex.: as janelas de 30/15/5 min do lembrete de PT). */
  children?: NotificationPreferenceChild[];
}

export interface NotificationPreferenceChild {
  id: string;
  label: string;
  storageKey: string;
}

/**
 * Canais de ENTREGA. Não são tipos de notificação: controlam COMO qualquer
 * notificação chega ao usuário. Ficam no mesmo modal porque é exatamente ali
 * que o usuário espera encontrá-los.
 */
export interface NotificationChannelItem {
  id: "desktop" | "sound";
  label: string;
  description: string;
  storageKey: string;
}

export const NOTIFICATION_CATEGORIES: NotificationCategory[] = [
  { id: "pt", label: "PTs e Quests", description: "Convites, lembretes de horário e conclusão de quests." },
  { id: "bazaar", label: "Bazaar", description: "Leilões de interesse e atualização diária da lista." },
  { id: "services", label: "Services", description: "Pedidos de service enviados a você." },
  { id: "vip", label: "VIP e Pagamentos", description: "Aprovação de VIP e confirmação de pagamentos." },
  { id: "system", label: "Sistema", description: "Atualizações do aplicativo e canais de entrega." },
  { id: "admin", label: "Administrativas", description: "Eventos de moderação — exclusivo do Boss." },
];

/**
 * Chaves ANTIGAS, preservadas para não perder a preferência de ninguém.
 * Qualquer mudança aqui invalidaria a configuração já salva dos usuários.
 */
const LEGACY_PT_30 = "notif_pt_30";
const LEGACY_PT_15 = "notif_pt_15";
const LEGACY_PT_5 = "notif_pt_5";
const LEGACY_SOUND = "tibia_notify_sound";
const LEGACY_DESKTOP = "tibia_notify_desktop";

/** Prefixo das chaves NOVAS (tipos que nunca tiveram controle). */
const TYPE_KEY_PREFIX = "notif_type_";

export const NOTIFICATION_PREFERENCES: NotificationPreferenceItem[] = [
  // ── PTs e Quests ─────────────────────────────────────────────────────────
  {
    id: "pt_added",
    category: "pt",
    label: "Adicionado a uma PT",
    description: "Alguém te incluiu em uma party de Soul War ou Sanguine.",
    storageKey: `${TYPE_KEY_PREFIX}pt_added`,
  },
  {
    id: "pt_reminder",
    category: "pt",
    label: "Lembrete de horário da PT",
    description: "Avisa quando a PT que você participa está prestes a começar.",
    // Sem chave própria: as três janelas abaixo já eram a preferência real.
    // Desligar todas as três equivale a desligar o lembrete.
    storageKey: `${TYPE_KEY_PREFIX}pt_reminder`,
    children: [
      { id: "30", label: "Aviso 30 minutos antes", storageKey: LEGACY_PT_30 },
      { id: "15", label: "Aviso 15 minutos antes", storageKey: LEGACY_PT_15 },
      { id: "5", label: "Aviso 5 minutos antes", storageKey: LEGACY_PT_5 },
    ],
  },
  {
    id: "schedule_changed",
    category: "pt",
    label: "Horário da PT alterado",
    description: "Um membro mudou o horário de uma PT que você participa.",
    storageKey: `${TYPE_KEY_PREFIX}schedule_changed`,
  },
  {
    id: "pt_updated",
    category: "pt",
    label: "Itens e valores atualizados",
    description: "Alguém salvou os drops e valores de uma PT sua.",
    storageKey: `${TYPE_KEY_PREFIX}pt_updated`,
  },
  {
    id: "quest_completed_donation",
    category: "pt",
    label: "Quest concluída",
    description: "A PT foi finalizada — inclui os botões Att Chars e Doar.",
    storageKey: `${TYPE_KEY_PREFIX}quest_completed_donation`,
  },
  {
    id: "party_finalized",
    category: "pt",
    label: "PT finalizada no histórico",
    description: "O backend concluiu a finalização de uma PT que você participou.",
    storageKey: `${TYPE_KEY_PREFIX}party_finalized`,
  },

  // ── Bazaar ───────────────────────────────────────────────────────────────
  {
    id: "bazaar_interest_ending",
    category: "bazaar",
    label: "Leilão de interesse encerrando",
    description: "Um leilão que você marcou como interesse está perto do fim.",
    storageKey: `${TYPE_KEY_PREFIX}bazaar_interest_ending`,
  },
  {
    id: "bazaar_daily_available",
    category: "bazaar",
    label: "Atualização diária do Bazaar",
    description: "A lista do Rubinot já pode ser consultada.",
    storageKey: `${TYPE_KEY_PREFIX}bazaar_daily_available`,
    bossOnly: true,
    electronOnly: true,
  },

  // ── Services ─────────────────────────────────────────────────────────────
  {
    id: "service_request",
    category: "services",
    label: "Pedido de service",
    description: "Alguém solicitou um service seu.",
    storageKey: `${TYPE_KEY_PREFIX}service_request`,
  },
  {
    id: "service_waiting",
    category: "services",
    label: "Service sem Serviceiro definido",
    description: "O Formulário Público recebeu um personagem \"Qualquer um\" aguardando atendimento na guia Services.",
    storageKey: `${TYPE_KEY_PREFIX}service_waiting`,
    bossOnly: true,
  },

  // ── VIP e Pagamentos ─────────────────────────────────────────────────────
  {
    id: "vip_approved",
    category: "vip",
    label: "Bônus VIP recebido",
    description: "Um administrador te presenteou com dias de VIP.",
    storageKey: `${TYPE_KEY_PREFIX}vip_approved`,
  },
  {
    id: "payment_received",
    category: "vip",
    label: "Assinatura VIP ativada",
    description: "Sua solicitação de VIP foi aprovada e os dias foram creditados.",
    storageKey: `${TYPE_KEY_PREFIX}payment_received`,
  },

  // ── Sistema ──────────────────────────────────────────────────────────────
  {
    id: "update_available",
    category: "system",
    label: "Atualização disponível",
    description: "Uma nova versão do aplicativo pode ser instalada.",
    storageKey: `${TYPE_KEY_PREFIX}update_available`,
    electronOnly: true,
  },

  // ── Administrativas (Boss) ───────────────────────────────────────────────
  // Estas DUAS não passam pelo Centro de Notificações: são filtradas em
  // `useNotifications` e entregues no painel Boss > Notificações. Ficam aqui
  // com cadeado para que a lista do modal seja realmente completa.
  {
    id: "request_entry",
    category: "admin",
    label: "Solicitação de entrada",
    description: "Um usuário pediu acesso ao aplicativo e aguarda aprovação.",
    storageKey: `${TYPE_KEY_PREFIX}request_entry`,
    bossOnly: true,
    mandatory: true,
    mandatoryReason: "Sem ela ninguém conseguiria aprovar novos usuários.",
  },
  {
    id: "rate_limit_block",
    category: "admin",
    label: "Bloqueio por uso excessivo",
    description: "Um usuário atingiu o limite de operações no Firestore.",
    storageKey: `${TYPE_KEY_PREFIX}rate_limit_block`,
    bossOnly: true,
    mandatory: true,
    mandatoryReason: "Alerta de segurança e custo — precisa sempre chegar ao Boss.",
  },
];

export const NOTIFICATION_CHANNELS: NotificationChannelItem[] = [
  {
    id: "desktop",
    label: "Notificações na área de trabalho",
    description: "Mostra um aviso do sistema operacional além do sino do app.",
    storageKey: LEGACY_DESKTOP,
  },
  {
    id: "sound",
    label: "Som das notificações",
    description: "Toca um aviso curto ao receber notificações novas.",
    storageKey: LEGACY_SOUND,
  },
];

/** Índice por tipo, para consulta O(1) no portão de entrega. */
const PREFERENCE_BY_TYPE = new Map<string, NotificationPreferenceItem>(
  NOTIFICATION_PREFERENCES.map(item => [item.id, item]),
);

/**
 * Lê uma chave booleana.
 *
 * Aceita os DOIS formatos já presentes no armazenamento: a string crua
 * `"false"` (usada pelas chaves antigas de PT) e o JSON `false` (usado pelo
 * som e pelo desktop). Qualquer outra coisa — inclusive ausência — é `true`.
 */
export function readBooleanPref(storageKey: string, defaultValue = true): boolean {
  if (typeof window === "undefined") return defaultValue;
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw === null) return defaultValue;
    if (raw === "false") return false;
    if (raw === "true") return true;
    const parsed = JSON.parse(raw);
    return parsed !== false;
  } catch {
    return defaultValue;
  }
}

/**
 * Grava uma chave booleana e avisa a aplicação.
 *
 * O evento `storage` é o mesmo mecanismo que `saveNotificationSoundPref` e
 * `saveDesktopNotifyPref` já usavam para sincronizar outras partes da UI.
 */
export function writeBooleanPref(storageKey: string, value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(storageKey, JSON.stringify(value));
    window.dispatchEvent(new Event("storage"));
  } catch {}
}

/**
 * PORTÃO DE ENTREGA — a única pergunta que o fluxo de notificações faz.
 *
 * `true` para: tipo desconhecido (nunca bloquear algo que não conhecemos),
 * tipo obrigatório, ou tipo cuja preferência está ligada.
 *
 * O lembrete de PT é um caso especial: ele não tem interruptor próprio de
 * fato — as três janelas SÃO a preferência. Ele só é considerado desligado
 * quando o usuário desliga o pai explicitamente OU as três janelas.
 */
export function isNotificationTypeEnabled(type: string | undefined | null): boolean {
  if (!type) return true;
  const item = PREFERENCE_BY_TYPE.get(type);
  if (!item) return true;
  if (item.mandatory) return true;
  if (!readBooleanPref(item.storageKey)) return false;
  if (item.children && item.children.length > 0) {
    return item.children.some(child => readBooleanPref(child.storageKey));
  }
  return true;
}

/** Lista de preferências visíveis para o papel/ambiente informados. */
export function getVisiblePreferences(isBoss: boolean, isElectron: boolean): NotificationPreferenceItem[] {
  return NOTIFICATION_PREFERENCES.filter(item => {
    if (item.bossOnly && !isBoss) return false;
    if (item.electronOnly && !isElectron) return false;
    return true;
  });
}

/**
 * Categorias que têm ao menos um item visível.
 *
 * É o que impede o modal de renderizar um cabeçalho de categoria vazio para
 * usuário comum — o requisito de "não deixar espaços vazios".
 */
export function getVisibleCategories(isBoss: boolean, isElectron: boolean): Array<{
  category: NotificationCategory;
  items: NotificationPreferenceItem[];
}> {
  const visible = getVisiblePreferences(isBoss, isElectron);
  return NOTIFICATION_CATEGORIES
    .map(category => ({ category, items: visible.filter(item => item.category === category.id) }))
    .filter(group => group.items.length > 0);
}