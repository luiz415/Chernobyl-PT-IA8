// ============================================================================
// IDENTIDADE DE CONTA
//
// O nome da conta é escolhido livremente por cada usuário — "1", "2", "Main",
// "principal" são nomes comuníssimos. Comparar apenas o nome faz o sistema
// concluir que a conta "1" do Usuário A e a conta "1" do Usuário B são a mesma
// coisa, e passa a bloquear indevidamente a montagem de PTs.
//
// A identidade real é o par:
//
//     dono (ownerUid)  +  nome da conta normalizado
//
// Duas contas só são a MESMA quando as duas partes coincidem.
//
//     userA + "1"   ===  userA + "1"    → mesma conta   (bloquear na PT)
//     userA + "1"   !==  userB + "1"    → contas distintas (permitir)
//
// A regra de negócio NÃO muda: dois personagens da mesma conta real continuam
// proibidos na mesma PT. O que muda é só a definição de "mesma conta".
//
// FALLBACK PARA DADOS ANTIGOS
// ---------------------------------------------------------------------------
// Registros legados (PTs arquivadas, snapshots antigos, Services) podem não ter
// `ownerUid`. Nesses casos caímos para `ownerName` e, na falta dele, marcamos a
// origem como desconhecida. Duas contas de origem desconhecida NUNCA são
// consideradas iguais — presumir igualdade bloquearia PTs válidas com base em
// dados que não temos.
// ============================================================================

/** Entrada mínima para derivar a identidade de conta. */
export interface AccountIdentityInput {
  account?: string | null;
  ownerUid?: string | null;
  ownerName?: string | null;
  /** Alguns registros antigos guardam o autor em `addedBy`/`createdBy`. */
  addedBy?: string | null;
  createdBy?: string | null;
  /**
   * Identidade previamente calculada e persistida (snapshots da PT). Quando
   * presente, é usada diretamente — é o único dado confiável ali, já que o
   * `account` do snapshot é mascarado por privacidade.
   */
  accountKey?: string | null;
  /** Identificador do próprio personagem — último recurso. */
  id?: string | null;
}

/** Normaliza o nome da conta preservando o comportamento atual (trim + caixa). */
export function normalizeAccountName(account: string | null | undefined): string {
  return String(account ?? "").trim().toLowerCase();
}

/**
 * Dono do personagem em forma canônica.
 *
 * Prioriza `ownerUid` (estável e único). Só recorre ao nome quando o UID não
 * existe — o caso dos registros legados.
 */
export function resolveOwnerIdentity(entity: AccountIdentityInput | null | undefined): string {
  if (!entity) return "";
  const uid = String(entity.ownerUid ?? "").trim();
  if (uid) return `uid:${uid.toLowerCase()}`;

  const legacy = String(entity.ownerName ?? entity.addedBy ?? entity.createdBy ?? "").trim();
  if (legacy) return `name:${legacy.toLowerCase()}`;

  return "";
}

/**
 * Chave única da conta: `dono + nome da conta`.
 *
 * Devolve `null` quando a identidade não pode ser afirmada — sem nome de conta
 * ou sem dono conhecido. `null` significa "não dá para provar que é a mesma
 * conta", e quem compara deve tratar isso como NÃO conflitante.
 */
export function getCharacterAccountKey(entity: AccountIdentityInput | null | undefined): string | null {
  if (!entity) return null;

  // Identidade já gravada (snapshots da PT, onde `account` vem MASCARADO e
  // portanto não serve para comparar). Tem precedência sobre tudo.
  const stored = String(entity.accountKey ?? "").trim();
  if (stored) return stored;

  const account = normalizeAccountName(entity.account);
  if (!account) return null;          // sem conta: nada a comparar

  const owner = resolveOwnerIdentity(entity);
  if (!owner) return null;            // dono desconhecido: não presumir igualdade

  return `${owner}|acct:${account}`;
}

/**
 * Duas entidades pertencem à MESMA conta real?
 *
 * `false` sempre que a identidade de qualquer uma delas for indeterminada —
 * é o lado seguro: não inventamos um conflito que não podemos comprovar.
 */
export function isSameAccount(
  a: AccountIdentityInput | null | undefined,
  b: AccountIdentityInput | null | undefined,
): boolean {
  const keyA = getCharacterAccountKey(a);
  const keyB = getCharacterAccountKey(b);
  if (!keyA || !keyB) return false;
  return keyA === keyB;
}

/**
 * Alguma entidade da lista está na mesma conta que `candidate`?
 *
 * Substitui as varreduras que comparavam somente `account`.
 */
export function hasAccountConflictWith(
  list: readonly (AccountIdentityInput | null | undefined)[],
  candidate: AccountIdentityInput | null | undefined,
): boolean {
  const key = getCharacterAccountKey(candidate);
  if (!key) return false;
  return list.some(entity => getCharacterAccountKey(entity) === key);
}

/** Conjunto de chaves de conta de uma lista (ignora as indetermináveis). */
export function buildAccountKeySet(
  list: readonly (AccountIdentityInput | null | undefined)[],
): Set<string> {
  const set = new Set<string>();
  for (const entity of list) {
    const key = getCharacterAccountKey(entity);
    if (key) set.add(key);
  }
  return set;
}
