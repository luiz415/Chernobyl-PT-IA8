// ============================================================================
// MENSAGENS PADRÃO DO WHATSAPP — serviço compartilhado
// ============================================================================
//
// Usado pelas guias "Meus Services" (MyServicesPanel) e "Services"
// (WaitingListPanel) para montar o contato com o cliente:
//
//   botão WhatsApp → escolher uma mensagem padrão → wa.me/…?text=…
//
// Tudo aqui é 100% frontend — sem Cloud Functions e sem Firestore: as
// mensagens são uma PREFERÊNCIA individual do usuário (como o "Auto-aprovar"
// e as preferências de notificação), portanto ficam no localStorage, com a
// chave separada por UID. Zero leitura/escrita desnecessária no Firestore.
//
// As mensagens usam variáveis `{{token}}` preenchidas com os dados do próprio
// Service (cliente, personagem, servidor, vocação, level, quest, status,
// valor, pagamento, data, serviceiro e o nome de quem envia).
//
// Módulo puro (sem imports de Firebase) — compilável/testável em Node.
// ============================================================================

import { SERVICE_PAYMENT_LABELS, VOC_LABEL, formatRC, formatDateBR } from "../types";

/** Uma mensagem padrão cadastrada pelo usuário. */
export interface WhatsappTemplate {
  id: string;
  titulo: string;
  conteudo: string;
}

/**
 * Objeto "service-like": aceita tanto `SharedService` (Meus Services) quanto
 * `WaitingService` (Services/Lista de Espera) — os dois tipos são
 * estruturalmente compatíveis nos campos usados nas mensagens.
 */
export interface WhatsappServiceInput {
  personagem?: string;
  ownerName?: string;
  servidor?: string;
  voc?: string;
  level?: number;
  quest?: string;
  paymentMethod?: string;
  valorCombinado?: number;
  status?: string;
  /** SharedService */
  dataService?: string;
  serviceiroNome?: string;
  /** WaitingService */
  dataAdicionado?: string;
  addedBy?: string;
}

/** Valores resolvidos de cada `{{token}}`. */
export type WhatsappMessageContext = Record<string, string>;

/** Rótulo das quests exibido nas mensagens. */
const QUEST_LABELS: Record<string, string> = {
  soulwar: "Soulwar",
  sanguine: "Sanguine",
};

/** Registro das variáveis suportadas — alimenta também o modal de edição. */
export const WHATSAPP_TEMPLATE_VARIABLES: Array<{ token: string; label: string }> = [
  { token: "{{cliente}}", label: "Nome do cliente" },
  { token: "{{personagem}}", label: "Nome do personagem" },
  { token: "{{servidor}}", label: "Servidor" },
  { token: "{{voc}}", label: "Vocação (nome completo)" },
  { token: "{{level}}", label: "Level do personagem" },
  { token: "{{quest}}", label: "Quest (Soulwar/Sanguine)" },
  { token: "{{status}}", label: "Status do Service" },
  { token: "{{valor}}", label: "Valor (ex.: 1.000 RC / a combinar)" },
  { token: "{{pagamento}}", label: "Forma de pagamento" },
  { token: "{{data}}", label: "Data do Service" },
  { token: "{{serviceiro}}", label: "Serviceiro responsável" },
  { token: "{{meunome}}", label: "Seu nome (quem envia)" },
  { token: "{{live}}", label: "Sua live (Twitch/Kick)" },
];

// ── Mensagens iniciais ──────────────────────────────────────────────────────
// Profissionais, diretas e usando os dados reais do Service. O usuário pode
// editar título e conteúdo no modal de configuração — estas são apenas o
// ponto de partida (restauráveis a qualquer momento).
export const DEFAULT_WHATSAPP_TEMPLATES: WhatsappTemplate[] = [
  {
    id: "contato_inicial",
    titulo: "Contato Inicial",
    conteudo:
      "Olá, {{cliente}}! 👋\n\n" +
      "Aqui é {{meunome}}, da equipe Chernobyl. Recebemos seu pedido de service e seu personagem já foi adicionado na fila.\n\n" +
      "⚔️ *Personagem:* {{personagem}} ({{voc}}, level {{level}})\n" +
      "🌍 *Servidor:* {{servidor}}\n" +
      "🏹 *Quest:* {{quest}}\n" +
      "💵 *Pagamento:* {{pagamento}}\n\n" +
      "Em breve será solicitado o pagamento e suas credenciais para entrar na conta e realizar o Service. Qualquer dúvida é só me chamar por aqui. Obrigado pela confiança! 🤝",
  },
  {
    id: "conta_pagamento",
    titulo: "Solicitar Conta e Pagamento",
    conteudo:
      "Olá, {{cliente}}! Seu personagem foi selecionado para a realização do Service agora! 📢\n\n" +
      "Para isso, solicito que faça o pagamento do valor combinado e me envie o e-mail e senha do personagem {{personagem}}.\n\n" +
      "Certifique-se de que o personagem possui o valor do refill.\n\n" +
      "Para acompanhar seu service ao vivo, entre na live:\n" +
      "{{live}}\n\n" +
      "Responda o mais rápido possível para que seu Service seja iniciado!",
  },
  {
    id: "quest_concluida",
    titulo: "Quest Concluída",
    conteudo:
      "Olá, {{cliente}}! Missão cumprida! 🎉\n\n" +
      "A quest {{quest}} foi concluída com sucesso!\n\n" +
      "✅ *Personagem:* {{personagem}} — {{voc}} (level {{level}})\n" +
      "🌍 *Servidor:* {{servidor}}\n" +
      "🤝 *Serviceiro:* {{serviceiro}}\n\n" +
      "Muito obrigado pela confiança! Se precisar de mais algum Service, pode me chamar. 🙏",
  },
  {
    id: "falha_service",
    titulo: "Falha no Service",
    conteudo:
      "Olá, {{cliente}}! Tudo bem? 🙂\n\n" +
      "Passando para te manter informado: tivemos um imprevisto com a PT responsável pelo Service do seu personagem {{personagem}}, e ele precisará ser retomado um pouco mais adiante.\n\n" +
      "Fique tranquilo(a): seu Service continua garantido. Assim que pudermos retomar, eu mesmo entro em contato por aqui para agendar. 🤝\n\n" +
      "Obrigado pela paciência e pela confiança!",
  },
];

// ── Contexto (variáveis ← dados do Service) ─────────────────────────────────

/** Valor formatado para o cliente: "1.000 RC" ou "a combinar". */
function whatsValorLabel(valorCombinado?: number): string {
  const valor = Number(valorCombinado);
  return Number.isFinite(valor) && valor > 0 ? formatRC(valor) : "a combinar";
}

/** Status na linguagem do cliente. */
function whatsStatusLabel(status?: string): string {
  return status === "realizado" ? "Realizado" : "Em andamento";
}

/**
 * Rótulo da forma de pagamento para as mensagens ao cliente.
 *
 * 50/50 inclui o refil no próprio rótulo ("50/50 + 250 RC"): no Service
 * 50/50 o cliente paga 250 RC + refil, então a mensagem precisa mostrar o
 * total de onde ele vê o custo. As demais formas seguem o rótulo padrão do
 * app (SERVICE_PAYMENT_LABELS), sem alteração.
 */
function whatsPaymentLabel(paymentMethod: string): string {
  if (paymentMethod === "5050") return "50/50 + 250 RC";
  return SERVICE_PAYMENT_LABELS[paymentMethod as keyof typeof SERVICE_PAYMENT_LABELS] || "a combinar";
}

/**
 * Monta o contexto de variáveis a partir de um Service (de qualquer uma das
 * guias) + o nome de quem está enviando (e a live do remetente, se houver).
 * Campos ausentes viram "—" para a mensagem nunca sair com um `{{token}}` cru.
 */
export function serviceToWhatsappContext(
  input: WhatsappServiceInput | null | undefined,
  viewerName: string,
  viewerLiveUrl?: string,
): WhatsappMessageContext {
  const fallback = "—";
  const voc = (input?.voc || "").trim();
  const quest = (input?.quest || "").trim();
  const paymentMethod = (input?.paymentMethod || "").trim();
  const data = (input?.dataService || input?.dataAdicionado || "").trim();
  return {
    cliente: (input?.ownerName || "").trim() || fallback,
    personagem: (input?.personagem || "").trim() || fallback,
    servidor: (input?.servidor || "").trim() || fallback,
    voc: (VOC_LABEL as Record<string, string>)[voc] || voc || fallback,
    level: input?.level && input.level > 0 ? String(input.level) : fallback,
    quest: QUEST_LABELS[quest] || quest || fallback,
    status: whatsStatusLabel(input?.status),
    valor: whatsValorLabel(input?.valorCombinado),
    pagamento: whatsPaymentLabel(paymentMethod),
    data: data ? formatDateBR(data) : fallback,
    serviceiro: (input?.serviceiroNome || input?.addedBy || "").trim() || fallback,
    meunome: (viewerName || "").trim() || fallback,
    live: (viewerLiveUrl || "").trim() || fallback,
  };
}

/**
 * Substitui os `{{token}}` pelo valor real do contexto. Tokens desconhecidos
 * são removidos (a mensagem nunca vai para o cliente com o código à vista).
 */
export function resolveWhatsappTemplate(conteudo: string, context: WhatsappMessageContext): string {
  return (conteudo || "")
    .replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, token: string) => {
      const value = context[token];
      return value === undefined || value === null ? "" : value;
    })
    .replace(/[ \t]+\n/g, "\n") // linha que ficou só com espaços
    .trim();
}

// ── Link wa.me ──────────────────────────────────────────────────────────────

/** Dígitos do WhatsApp a partir dos três campos salvos (país/ddd/número). */
export function cleanWhatsappPhone(country: string | undefined, area: string | undefined, number: string | undefined): string {
  return `${country || ""}${area || ""}${number || ""}`.replace(/\D/g, "");
}

/**
 * Link oficial de click-to-chat do WhatsApp, com mensagem pré-preenchida.
 *
 * POR QUE `api.whatsapp.com/send` E NÃO `wa.me`: o domínio curto wa.me é só
 * um redirecionamento para api.whatsapp.com — e é exatamente nesse redirect
 * que emojis e outros caracteres UTF-8 são corrompidos (viram "�" no campo
 * de mensagem do WhatsApp Web/Desktop, mesmo com o encoding correto no
 * link). Apontando direto para api.whatsapp.com/send/, com o texto
 * percent-encodado em UTF-8 via encodeURIComponent, emojis, acentos,
 * quebras de linha (\n → %0A) e formatação chegam intactos.
 *
 * `type=phone_number&app_absent=0` é o formato atual do click-to-chat:
 * abre o app quando instalado, ou a página "continuar para o chat" na web.
 *
 * O texto chega como RASCUNHO pronto na conversa — o envio continua sendo
 * uma ação consciente do usuário dentro do próprio WhatsApp.
 */
export function buildWhatsappLink(phone: string, message?: string): string {
  const digits = (phone || "").replace(/\D/g, "");
  if (!digits) return "";
  const text = (message || "").trim();
  const base = `https://api.whatsapp.com/send/?phone=${digits}&type=phone_number&app_absent=0`;
  return text ? `${base}&text=${encodeURIComponent(text)}` : base;
}

// ── Persistência (localStorage, por UID) ────────────────────────────────────
// Mesmo padrão das demais preferências do app ("my_services_auto_approve.{uid}",
// "notif_pt_*"): leitura/escrita locais e instantâneas, sem custo no Firestore.
// A separação por usuário vem da chave: "whatsapp_templates.{uid}".

const STORAGE_PREFIX = "whatsapp_templates.";

function storageKey(uid: string): string {
  return `${STORAGE_PREFIX}${(uid || "").trim() || "anon"}`;
}

function hasLocalStorage(): boolean {
  return typeof localStorage !== "undefined";
}

/** Normaliza um template lido de fonte externa (storage/handoff). */
function normalizeTemplate(raw: unknown): WhatsappTemplate | null {
  if (!raw || typeof raw !== "object") return null;
  const id = String((raw as WhatsappTemplate).id || "").trim();
  const titulo = String((raw as WhatsappTemplate).titulo || "").trim();
  const conteudo = String((raw as WhatsappTemplate).conteudo || "");
  if (!id || !titulo || !conteudo.trim()) return null;
  return { id, titulo, conteudo };
}

/** Mensagens do usuário; cai nos padrões quando não há nada salvo/inválido. */
export function loadWhatsappTemplates(uid: string): WhatsappTemplate[] {
  let raw: string | null = null;
  try {
    raw = hasLocalStorage() ? localStorage.getItem(storageKey(uid)) : null;
  } catch { raw = null; }
  if (!raw) return DEFAULT_WHATSAPP_TEMPLATES.map(t => ({ ...t }));
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_WHATSAPP_TEMPLATES.map(t => ({ ...t }));
    const templates = parsed.map(normalizeTemplate).filter((t): t is WhatsappTemplate => t !== null);
    return templates.length > 0 ? templates : DEFAULT_WHATSAPP_TEMPLATES.map(t => ({ ...t }));
  } catch {
    return DEFAULT_WHATSAPP_TEMPLATES.map(t => ({ ...t }));
  }
}

/** Persiste as mensagens do usuário (edições no modal de configuração). */
export function saveWhatsappTemplates(uid: string, templates: WhatsappTemplate[]): void {
  try {
    if (!hasLocalStorage()) return;
    const normalized = templates.map(normalizeTemplate).filter((t): t is WhatsappTemplate => t !== null);
    localStorage.setItem(storageKey(uid), JSON.stringify(normalized));
  } catch { /* quota/privado: prefere perder a preferência a quebrar o app */ }
}