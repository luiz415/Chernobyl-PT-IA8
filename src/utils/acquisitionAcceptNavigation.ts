// ============================================================================
// "COMPRAR PERSONAGEM" A PARTIR DA NOTIFICAÇÃO — PONTE ATÉ O MODAL DE ACEITE
// ============================================================================
// O botão "Comprar Personagem" da notificação `acquisition_pre_approved`
// precisa fazer DUAS coisas: navegar até a PT exata (isso já é resolvido pelo
// evento canônico de navegação — `dispatchNotificationNavigate`, roteado no
// App por `partyId`) e, DEPOIS que o PartyPanel daquela PT estiver montado,
// abrir o modal de confirmação da compra do personagem específico
// (`CharacterAcquisitionPaymentModal`, o MESMO aberto pelo botão de aceite ✓
// do slot).
//
// O problema de timing é o mesmo já documentado no roteador de notificações:
// o painel de destino pode ainda NÃO estar montado quando o clique acontece.
// Por isso este módulo segue o padrão do app (evento canônico + estado
// pendente consumível):
//
//   • `requestAcquisitionAccept` registra o pedido e dispara o CustomEvent —
//     se o PartyPanel da PT já estiver montado, ele abre o modal na hora;
//   • `peekPendingAcquisitionAccept` permite ao PartyPanel, ao montar (ou ao
//     receber as negociações pelo listener), verificar se existe um pedido
//     para a SUA PT; o pedido só é limpo com `clearPendingAcquisitionAccept`
//     quando o registro da negociação é encontrado — assim a latência do
//     listener de `characterAcquisitions` não perde o pedido;
//   • o pedido expira (TTL) para nunca abrir um modal "fantasma" minutos
//     depois, fora do contexto do clique.
//
// Módulo PURO (sem React/Firebase), no mesmo espírito de
// `notificationNavigation.ts`. Nenhuma leitura extra do Firestore: o
// PartyPanel valida com os dados que já recebe via props.
// ============================================================================

export const ACQUISITION_ACCEPT_EVENT = "acquisition-accept-request";

export interface AcquisitionAcceptRequestDetail {
  /** PT em que o personagem está sendo negociado. */
  partyId: string;
  /** Documento em `characterAcquisitions` (id determinístico dono+personagem). */
  acquisitionId: string;
  /** Id do personagem em negociação (slot da PT) — redundância de localização. */
  characterId?: string;
}

/** Janela máxima entre o clique na notificação e a abertura do modal. */
const PENDING_TTL_MS = 60_000;

let pending: (AcquisitionAcceptRequestDetail & { requestedAt: number }) | null = null;

/**
 * Registra o pedido de compra e avisa um eventual PartyPanel já montado.
 * Chamado pelo Centro de Notificações no clique em "Comprar Personagem".
 */
export function requestAcquisitionAccept(detail: AcquisitionAcceptRequestDetail): void {
  if (!detail?.partyId || !detail?.acquisitionId) return;
  pending = { ...detail, requestedAt: Date.now() };
  window.dispatchEvent(new CustomEvent<AcquisitionAcceptRequestDetail>(ACQUISITION_ACCEPT_EVENT, {
    detail: { partyId: detail.partyId, acquisitionId: detail.acquisitionId, characterId: detail.characterId },
  }));
}

/**
 * Consulta (SEM consumir) o pedido pendente para uma PT específica.
 * Devolve null quando não há pedido, quando é de outra PT ou quando expirou.
 */
export function peekPendingAcquisitionAccept(partyId: string): AcquisitionAcceptRequestDetail | null {
  if (!pending) return null;
  if (Date.now() - pending.requestedAt > PENDING_TTL_MS) {
    pending = null;
    return null;
  }
  if (!partyId || pending.partyId !== partyId) return null;
  return { partyId: pending.partyId, acquisitionId: pending.acquisitionId, characterId: pending.characterId };
}

/** Limpa o pedido pendente — chamado quando o PartyPanel o processa. */
export function clearPendingAcquisitionAccept(): void {
  pending = null;
}
