// ============================================================================
// NAVEGAÇÃO POR NOTIFICAÇÃO — EVENTO CANÔNICO + MAPA DE DESTINOS
// ============================================================================
// Todos os cliques em notificação (desktop web via Notification.onclick,
// desktop Electron via IPC "desktop-notification-click" e botões do Centro
// de Notificações) convergem num ÚNICO evento canônico, tratado por um
// roteador no App.tsx — componente que nunca é desmontado. A causa raiz do
// bug "clica, foca, mas não navega" era despachar eventos cujos listeners
// viviam em painéis montados condicionalmente (ex.: BazarPanel só existe na
// janela Bazaar), além de tipos simplesmente sem destino mapeado.
//
// Este módulo é PURO (sem React/Firebase): o mapa de destinos é testável em
// isolado (tools/notification-navigation-tests) e consumido pelo roteador.
import type { Notification } from "../types/notifications";

export const NOTIFICATION_NAVIGATE_EVENT = "notification-navigate-request";

/** Destino de navegação resolvido a partir de uma notificação. */
export type NotificationDestination =
  | { kind: "party"; partyId: string }
  | { kind: "bazaar"; autoRun: boolean }
  | { kind: "myServices" }
  | { kind: "waitlist"; serviceId?: string }
  | { kind: "center" };

/** Payload do evento canônico — carrega os IDENTIFICADORES da entidade. */
export interface NotificationNavigateDetail {
  notificationId: string;
  type: Notification["type"] | string;
  partyId?: string;
  serviceId?: string;
  url?: string;
}

/**
 * Resolve o destino de navegação de uma notificação. Regras:
 *
 *   1. ENTIDADE ESPECÍFICA POR ID: notificações com `partyId` (pt_added,
 *      pt_reminder, payment_received, schedule_changed, pt_updated,
 *      quest_completed_donation, party_finalized) abrem a PT — no Gerenciador
 *      de PT's (ativa/aguardando pagamento) ou destacada no "Meu Histórico
 *      de PT's" quando já finalizada. Sempre pelo ID, nunca por nome.
 *   2. BAZAAR: "Atualização diária disponível" e "leilão de interesse
 *      encerrando" levam à janela do Painel Bazaar. A diária AINDA dispara a
 *      consulta automática (autoRun) depois de o painel montar.
 *   3. SERVICES: "Nova solicitação de Service" → aba Meus Services;
 *      "Service aguardando atendimento" (Lista de Espera) → guia Services,
 *      carregando o serviceId para localização da entrada.
 *   4. FALLBACK: tipos sem destino funcional próprio (vip_approved,
 *      update_available, …) abrem o Centro de Notificações — o clique nunca
 *      termina em "só focou a janela".
 */
export function resolveNotificationDestination(notif: {
  type?: string;
  partyId?: string;
  serviceId?: string;
}): NotificationDestination {
  // 1) Entidade específica: PT por ID
  if (notif.partyId) return { kind: "party", partyId: notif.partyId };
  // 2) Bazaar
  if (notif.type === "bazaar_daily_available") return { kind: "bazaar", autoRun: true };
  if (notif.type === "bazaar_interest_ending") return { kind: "bazaar", autoRun: false };
  // 3) Services
  if (notif.type === "service_request") return { kind: "myServices" };
  if (notif.type === "service_waiting") return { kind: "waitlist", serviceId: notif.serviceId };
  // 4) Fallback — Centro de Notificações
  return { kind: "center" };
}

/**
 * Despacha o evento canônico de navegação. Aceita a notificação inteira (ou
 * um subconjunto) e extrai apenas os identificadores relevantes.
 */
export function dispatchNotificationNavigate(notif: {
  id?: string;
  type?: string;
  partyId?: string;
  serviceId?: string;
  url?: string;
}): void {
  if (typeof window === "undefined") return;
  const detail: NotificationNavigateDetail = {
    notificationId: String(notif.id || ""),
    type: String(notif.type || ""),
    partyId: notif.partyId,
    serviceId: notif.serviceId,
    url: notif.url,
  };
  window.dispatchEvent(new CustomEvent(NOTIFICATION_NAVIGATE_EVENT, { detail }));
}