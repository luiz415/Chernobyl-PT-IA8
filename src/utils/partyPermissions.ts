// ============================================================================
// PT — PERMISSÕES E VISIBILIDADE (núcleo puro, compartilhado).
// ============================================================================
//
// Fonte única das regras de participação/visibilidade usadas por:
//   • PartyPanel  — remover personagem, alterar JOGADOR, adicionar personagem;
//   • PartyManager — quais PTs aparecem na lista para quem está vendo;
//   • testes funcionais (tools/party-permissions-tests).
//
// Modelo (especificação desta rodada):
//
//   PARTICIPANTE = usuário relacionado à PT pelas colunas DONO ou JOGADOR
//   (além de líder e membros do roster `members`). A coluna JOGADOR tem o
//   mesmo peso de participação que a DONO: quem só é JOGADOR também gerencia
//   a composição enquanto a Quest NÃO foi iniciada.
//
//   PRÉ-QUEST   → PT pública: visível a quem tem acesso (VIP/Boss) e esses
//                 usuários externos PODEM adicionar personagens;
//                 participantes (DONO/JOGADOR) podem remover participantes e
//                 alterar a coluna JOGADOR.
//
//   PÓS-INÍCIO  → externos perdem a PT (visualização E edição); só
//                 participantes (e convidados autorizados pelo líder em PT
//                 privada — modelo existente preservado) continuam.
//
//   PÓS-QUEST   → preservadas as regras restritivas existentes: liquidação
//                 financeira com Líder/Boss; participantes não concluem nem
//                 removem sozinhos.
//
// Nada aqui consulta rede: decisões locais instantâneas sobre o documento da
// PT já carregado. O Firestore (Security Rules) REFORÇA as mesmas regras na
// camada de dados — ver `firestore.rules`, bloco `match /parties/`.
// ============================================================================

export type PartyQuestState = "pre_start" | "in_progress" | "post_complete";

export interface PartySlotLike {
  owner?: string;
  ownerUid?: string;
  player?: string;
  playerUid?: string;
}

export interface PartyLike {
  leaderUid?: string;
  LeaderPT?: string;
  members?: string[];
  invitedUsers?: string[];
  visibility?: "public" | "private" | string;
  selectedIds?: string[];
  slotData?: Record<string, PartySlotLike | undefined>;
  memberSnapshots?: Record<string, { ownerUid?: string } | undefined>;
  ptStartedAt?: number;
  questConcluida?: boolean;
  questFalha?: boolean;
  pagamentoFeito?: boolean;
  archived?: boolean;
}

export interface ViewerLike {
  uid?: string;
  userName?: string;
  /** Papel no app: "Normal" | "VIP" | "Boss". */
  role?: string;
}

export interface PartyParticipation {
  /** Líder da PT (por UID; cai no nome legado para PTs muito antigas). */
  isLeader: boolean;
  /** Está no roster `members` do documento. */
  isMember: boolean;
  /** Convidado autorizado pelo líder (PT privada). */
  isInvited: boolean;
  /** DONO: tem personagem próprio na composição (coluna DONO). */
  ownsSlot: boolean;
  /** JOGADOR: foi selecionado na coluna JOGADOR de algum slot. */
  playsSlot: boolean;
  /** Participante de verdade: líder, roster, DONO ou JOGADOR. */
  isParticipant: boolean;
}

function sameName(a: unknown, b: unknown): boolean {
  const left = String(a || "").trim().toLowerCase();
  const right = String(b || "").trim().toLowerCase();
  return !!left && !!right && left === right;
}

/** Estado da Quest: antes do início, em andamento ou concluída. */
export function partyQuestState(party: PartyLike | null | undefined): PartyQuestState {
  if (!party) return "post_complete";
  if (party.questConcluida) return "post_complete";
  return party.ptStartedAt ? "in_progress" : "pre_start";
}

/**
 * Resolve a participação do usuário na PT.
 *
 * `resolveOwnerUid` permite ao chamador resolver donos de personagens por
 * id (o PartyManager usa a lista de personagens + snapshots; sem resolver,
 * vale o que está no próprio documento — slotData e memberSnapshots).
 */
export function getPartyParticipation(
  party: PartyLike | null | undefined,
  viewer: ViewerLike | null | undefined,
  resolveOwnerUid?: (characterId: string) => string | undefined,
): PartyParticipation {
  const uid = String(viewer?.uid || "");
  const userName = String(viewer?.userName || "");
  const slots = Object.values(party?.slotData || {});

  const isLeader = !!(party && (
    (!!uid && party.leaderUid === uid)
    || (!!userName && sameName(party.LeaderPT, userName))
  ));

  const isMember = !!(uid && party?.members && party.members.includes(uid));
  const isInvited = !!(uid && party?.invitedUsers && party.invitedUsers.includes(uid));

  // DONO: personagem selecionado cujo dono é o usuário (via resolvedor ou
  // pelo snapshot gravado junto à própria PT), ou slot com ownerUid/owner dele.
  const ownsSlot = !!(
    party
    && (
      slots.some(slot =>
        (!!uid && slot?.ownerUid === uid)
        || (!!userName && sameName(slot?.owner, userName)))
      || (party.selectedIds || []).some(id =>
        (!!uid && party.memberSnapshots?.[id]?.ownerUid === uid)
        || (!!uid && resolveOwnerUid?.(id) === uid))
    )
  );

  // JOGADOR: selecionado na coluna JOGADOR de qualquer slot (UID em primeiro
  // lugar; nome como fallback de PTs legadas sem playerUid materializado).
  const playsSlot = !!(party && slots.some(slot =>
    (!!uid && slot?.playerUid === uid)
    || (!!userName && sameName(slot?.player, userName))));

  const isParticipant = isLeader || isMember || ownsSlot || playsSlot;
  return { isLeader, isMember, isInvited, ownsSlot, playsSlot, isParticipant };
}

/**
 * GERENCIAR A COMPOSIÇÃO: remover participantes, alterar a coluna JOGADOR,
 * +Slot/-Slot, membro externo.
 *
 * Pré-início e em andamento: qualquer PARTICIPANTE (DONO ou JOGADOR — não
 * depende de o personagem ser dele). Após a Quest: regra restritiva
 * existente preservada (Líder/Boss cuidam da liquidação).
 */
export function canManagePartyRoster(
  party: PartyLike | null | undefined,
  viewer: ViewerLike | null | undefined,
  resolveOwnerUid?: (characterId: string) => string | undefined,
): boolean {
  const p = getPartyParticipation(party, viewer, resolveOwnerUid);
  if (partyQuestState(party) === "post_complete") {
    return p.isLeader || viewer?.role === "Boss";
  }
  return p.isParticipant;
}

/**
 * ADICIONAR personagens à composição.
 *
 * Pré-requisito: a PT precisa estar VISÍVEL para o usuário (quem não vê, não
 * abre o painel — logo não adiciona). Líder e Boss mantêm o acesso atual.
 * Participantes de verdade (roster/DONO/JOGADOR) adicionam enquanto a Quest
 * não foi concluída. Usuários externos ganham a adição apenas PRÉ-Quest:
 *   • convidado autorizado em PT privada (amigo do líder);
 *   • qualquer usuário com acesso a uma PT pública.
 * Após o início, ninguém externo adiciona (spec §6); após a conclusão, só
 * Líder/Boss (liquidação — regra restritiva existente).
 */
export function canAddCharacterToParty(
  party: PartyLike | null | undefined,
  viewer: ViewerLike | null | undefined,
  resolveOwnerUid?: (characterId: string) => string | undefined,
): boolean {
  if (!isPartyVisibleToViewer(party, viewer, resolveOwnerUid)) return false;
  const p = getPartyParticipation(party, viewer, resolveOwnerUid);
  if (p.isLeader || viewer?.role === "Boss") return true;
  const state = partyQuestState(party);
  if (state === "post_complete") return false;
  if (p.isMember || p.ownsSlot || p.playsSlot) return true;
  if (state !== "pre_start") return false;
  return p.isInvited || party?.visibility === "public";
}

/**
 * VISIBILIDADE da PT para quem está vendo (lista do Gerenciador).
 *
 * Boss vê tudo. Participantes (incluindo JOGADOR) sempre veem. Convidados
 * de PT privada continuam vendo (modelo existente: autorização pessoal do
 * líder, preservada por não ser um acesso "por ser pública"). PT pública:
 * visível a usuários VIP apenas enquanto a Quest NÃO foi iniciada — após o
 * início, externos deixam de ver.
 */
export function isPartyVisibleToViewer(
  party: PartyLike | null | undefined,
  viewer: ViewerLike | null | undefined,
  resolveOwnerUid?: (characterId: string) => string | undefined,
): boolean {
  if (!party) return false;
  if (party.archived) {
    // Arquivadas não aparecem no gerenciador (a própria query filtra
    // `archived == false`; aqui apenas confirma o mesmo comportamento).
    return false;
  }
  if (viewer?.role === "Boss") return true;
  const p = getPartyParticipation(party, viewer, resolveOwnerUid);
  if (p.isParticipant || p.isInvited) return true;
  if (party.visibility !== "public") return false;
  if (viewer?.role === "Normal") return false; // vagas em PTs: exclusivo VIP
  return partyQuestState(party) === "pre_start"
    && !party.questFalha
    && !party.pagamentoFeito;
}

/** PT pública visível/aberta a este usuário? (usada pela busca de PTs públicas) */
export function isPublicPartyOpen(party: PartyLike | null | undefined): boolean {
  return !!party
    && party.visibility === "public"
    && partyQuestState(party) === "pre_start"
    && !party.questFalha
    && !party.pagamentoFeito
    && !party.archived;
}