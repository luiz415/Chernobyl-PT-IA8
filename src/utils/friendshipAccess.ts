/**
 * friendshipAccess.ts
 * -------------------
 * Módulo de domínio puro para o sistema de autorização de visualização
 * de personagens com base no sistema de amigos.
 *
 * FUNÇÕES PURAS — sem dependências de React, AuthContext, Firebase
 * ou qualquer outro módulo da aplicação.
 *
 * REGRAS DE AUTORIZAÇÃO:
 *   1. O viewer (usuário logado) pode ver um personagem SE:
 *      - O personagem pertence ao próprio viewer (ownerUid === viewerUid).
 *      - O ownerUid do personagem pertence à lista de amigos aceitos.
 *
 * Este módulo NÃO implementa a exceção das PTs existentes.
 * A exceção será tratada na etapa apropriada da arquitetura.
 */

// ============================================================================
// TIPOS
// ============================================================================

/**
 * Mínimo necessário de um Character para determinar autorização de visualização.
 * Não importamos o tipo completo do Character para manter o módulo desacoplado
 * e permitir que qualquer estrutura com ownerUid seja testada.
 */
export interface ViewableEntity {
  id?: string;
  ownerUid?: string;
}

// ============================================================================
// FUNÇÕES PURAS
// ============================================================================

/**
 * Verifica se o personagem pertence ao próprio usuário logado.
 *
 * @param entity - Personagem ou qualquer entidade com campo ownerUid.
 * @param viewerUid - UID do usuário logado.
 * @returns true se ownerUid da entidade for igual ao UID do viewer.
 */
export function isOwnedByViewer(entity: ViewableEntity, viewerUid: string): boolean {
  // ownerUid ausente não implica posse do viewer — a normalização explícita de
  // ownerUid é responsabilidade da camada de orquestração (App.tsx), que injeta
  // viewerUid nos personagens locais antes de chamar o helper. Aqui exigimos o
  // campo explícito para evitar que personagens de terceiros sem ownerUid sejam
  // incorretamente aprovados (regressão da Etapa 4).
  if (!entity.ownerUid) return false;
  return entity.ownerUid === viewerUid;
}

/**
 * Verifica se o personagem pertence a um amigo aceito do viewer.
 *
 * @param entity - Personagem ou qualquer entidade com campo ownerUid.
 * @param acceptedFriendUids - Set imutável com os UIDs dos amigos aceitos do viewer.
 * @returns true se ownerUid da entidade estiver contido no Set de amigos.
 */
export function isOwnedByAcceptedFriend(
  entity: ViewableEntity,
  acceptedFriendUids: ReadonlySet<string>
): boolean {
  if (!entity.ownerUid) return false;
  return acceptedFriendUids.has(entity.ownerUid);
}

/**
 * Helper central que determina se o viewer pode visualizar um personagem.
 *
 * Implementa a regra base de autorização:
 *   - ownerUid === viewerUid  (próprio)
 *   - ownerUid ∈ acceptedFriendUids  (amigo aceito)
 *
 * NOTA: Esta função NÃO implementa a exceção das PTs existentes.
 * Para a exceção, usar `canViewCharacterInContext()` na etapa apropriada.
 *
 * @param entity - Personagem ou qualquer entidade com campo ownerUid.
 * @param viewerUid - UID do usuário logado.
 * @param acceptedFriendUids - Set imutável com os UIDs dos amigos aceitos do viewer.
 * @returns true se o viewer tem autorização para visualizar a entidade.
 */
export function canViewCharacter(
  entity: ViewableEntity,
  viewerUid: string,
  acceptedFriendUids: ReadonlySet<string>
): boolean {
  return isOwnedByViewer(entity, viewerUid) || isOwnedByAcceptedFriend(entity, acceptedFriendUids);
}

/**
 * Filtra uma lista de entidades mantendo apenas as que o viewer pode visualizar.
 *
 * Operação pura: não muta o array de entrada, retorna novo array.
 * Complexidade: O(n) com lookup O(1) por item (Set.has).
 *
 * @param entities - Lista de entidades a serem filtradas.
 * @param viewerUid - UID do usuário logado.
 * @param acceptedFriendUids - Set imutável com os UIDs dos amigos aceitos do viewer.
 * @returns Nova lista contendo apenas as entidades que o viewer pode visualizar.
 */
export function filterVisibleEntities<T extends ViewableEntity>(
  entities: T[],
  viewerUid: string,
  acceptedFriendUids: ReadonlySet<string>
): T[] {
  return entities.filter(entity => canViewCharacter(entity, viewerUid, acceptedFriendUids));
}

/**
 * Constrói um Set imutável a partir de um array de UIDs.
 *
 * Dado que o AuthContext armazenará acceptedFriendUids como string[],
 * esta função cria o Set utilizado por canViewCharacter / filterVisibleEntities
 * para lookup O(1) em vez de O(n) por Array.includes.
 *
 * Deve ser chamada em um useMemo no componente consumidor para
 * evitar reconstrução do Set a cada render.
 *
 * @param uidArray - Array de UIDs de amigos aceitos.
 * @returns ReadonlySet<string> imutável para uso nas funções de autorização.
 */
export function buildAcceptedFriendSet(uidArray: string[]): ReadonlySet<string> {
  return new Set(uidArray);
}

/**
 * Helper central que determina se o viewer pode visualizar um personagem
 * RESPEITANDO A EXCEÇÃO OBRIGATÓRIA DAS PTs EXISTENTES.
 *
 * Se a entidade já pertence a uma PT existente, ela NUNCA poderá desaparecer
 * da interface de qualquer usuário que possua acesso àquela PT.
 *
 * @param entity - Entidade a checar (Character ou WaitingService).
 * @param viewerUid - UID do usuário logado.
 * @param acceptedFriendUids - Set de UIDs de amigos aceitos.
 * @param exceptionEntityIds - Set opcional de IDs de entidades já em PTs.
 * @returns true se a entidade for visível (própria, amigo aceito ou exceção de PT).
 */
export function canViewCharacterWithException(
  entity: ViewableEntity,
  viewerUid: string,
  acceptedFriendUids: ReadonlySet<string>,
  exceptionEntityIds?: ReadonlySet<string>
): boolean {
  // Requisito obrigatório de exceção
  if (exceptionEntityIds && entity.id && exceptionEntityIds.has(entity.id)) {
    return true;
  }
  return canViewCharacter(entity, viewerUid, acceptedFriendUids);
}

/**
 * Filtra uma lista de entidades aplicando a regra central de amizade e a exceção das PTs.
 */
export function filterVisibleEntitiesWithException<T extends ViewableEntity>(
  entities: T[],
  viewerUid: string,
  acceptedFriendUids: ReadonlySet<string>,
  exceptionEntityIds?: ReadonlySet<string>
): T[] {
  return entities.filter(entity =>
    canViewCharacterWithException(entity, viewerUid, acceptedFriendUids, exceptionEntityIds)
  );
}
