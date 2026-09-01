// ============================================================================
// FONTE ÚNICA DE SERVIDORES — Chernobyl PT
//
// Antes desta centralização o projeto tinha 7 listas de servidores duplicadas
// e divergentes entre si (CharacterModal, OverviewPanel, PartyManager,
// PartyPanel, PublicServiceForm, SuggestPartyModal e WaitingListPanel), com
// três nomenclaturas diferentes para o mesmo servidor:
//
//   "Grimoria 1"  (5 arquivos)   "Grimoria 01" (1 arquivo)   → mesmo servidor
//
// Qualquer lista de servidores do aplicativo deve importar deste arquivo.
// Não declare listas locais.
// ============================================================================

/**
 * Lista oficial de servidores, exatamente nesta ordem.
 *
 * A ordem já é alfabética em pt-BR, então componentes que aplicam
 * `.sort((a, b) => a.localeCompare(b, "pt-BR"))` continuam produzindo
 * exatamente esta mesma sequência.
 */
export const OFFICIAL_SERVERS = [
  "Auroria",
  "Belaria",
  "Bellum",      // recebeu Spectrum
  "Drakaria",    // Grimoria I + Grimoria III
  "Eldrian",     // Serenian + Halorian
  "Elysian",
  "Lunarian",
  "Malveria",    // Grimoria II + Grimoria IV
  "Mystian",
  "Obsidian",    // Etherian + Divinian
  "Solarian",
  "Tenebrium",
  "Vesperia",
] as const;

export type OfficialServer = (typeof OFFICIAL_SERVERS)[number];

/**
 * Cópia mutável para componentes que precisam de `string[]`
 * (ex.: props de dropdown que não aceitam `readonly string[]`).
 */
export const SERVER_OPTIONS: string[] = [...OFFICIAL_SERVERS];

/**
 * Nomes antigos que ainda podem existir em dados já salvos (Firestore,
 * localStorage, backups em JSON/CSV) mapeados para o nome oficial.
 *
 * Sem este mapa, um personagem gravado como "Grimoria 1" deixaria de casar
 * com "Grimoria I" e simplesmente sumiria dos filtros de PT, do Resumo de
 * Servidores e das sugestões — sem erro visível.
 *
 * As chaves são comparadas em minúsculas e sem espaços nas pontas.
 */
const LEGACY_SERVER_ALIASES: Record<string, OfficialServer> = {
  // ── Grimoria — variações de numeração (pré-merge) ────────────────────────
  // Precisam continuar aqui: um registro salvo como "Grimoria 1" tem de chegar
  // a Drakaria, e "Grimoria 2" a Malveria. Cada numeral é mapeado
  // individualmente — nunca por prefixo — para que I/II/III/IV jamais se
  // cruzem.
  "grimoria 1": "Drakaria",
  "grimoria 01": "Drakaria",
  "grimoria i": "Drakaria",
  "grimoria 3": "Drakaria",
  "grimoria 03": "Drakaria",
  "grimoria iii": "Drakaria",

  "grimoria 2": "Malveria",
  "grimoria 02": "Malveria",
  "grimoria ii": "Malveria",
  "grimoria 4": "Malveria",
  "grimoria 04": "Malveria",
  "grimoria iv": "Malveria",

  // ── MERGES DE SERVIDORES ─────────────────────────────────────────────────
  // Os nomes antigos deixaram a lista oficial (não são mais selecionáveis),
  // mas continuam aqui PARA SEMPRE: é isto que faz um personagem gravado como
  // "Spectrum" passar a funcionar como "Bellum" sem que ninguém edite nada.
  //
  // Bellum é o único alvo que já existia antes; os demais são nomes novos.
  "spectrum": "Bellum",

  "serenian": "Eldrian",
  "halorian": "Eldrian",

  "etherian": "Obsidian",
  "divinian": "Obsidian",

  // ── Renomeação anterior (mantida) ────────────────────────────────────────
  // Tormentum foi substituído por Tenebrium na lista oficial.
  "tormentum": "Tenebrium",
};

/**
 * Merges de servidores, em forma legível.
 *
 * Serve de documentação viva e alimenta os testes. A tradução em si acontece
 * em `LEGACY_SERVER_ALIASES`, que é o caminho por onde TODO o aplicativo já
 * passava (`normalizeServerName` → `serverKey`/`serverLabel`).
 */
export const SERVER_MERGES: ReadonlyArray<{ from: readonly string[]; to: OfficialServer }> = [
  { from: ["Bellum", "Spectrum"], to: "Bellum" },
  { from: ["Serenian", "Halorian"], to: "Eldrian" },
  { from: ["Etherian", "Divinian"], to: "Obsidian" },
  { from: ["Grimoria I", "Grimoria III"], to: "Drakaria" },
  { from: ["Grimoria II", "Grimoria IV"], to: "Malveria" },
];

/** Servidores que deixaram de existir e hoje são apenas nomes de origem. */
export const MERGED_AWAY_SERVERS: readonly string[] = [
  "Spectrum", "Serenian", "Halorian", "Etherian", "Divinian",
  "Grimoria I", "Grimoria II", "Grimoria III", "Grimoria IV",
];

/** Índice de busca case-insensitive dos nomes oficiais. */
const OFFICIAL_BY_LOWERCASE = new Map<string, OfficialServer>(
  OFFICIAL_SERVERS.map((server) => [server.toLowerCase(), server]),
);

/**
 * Converte qualquer variação conhecida para o nome oficial do servidor.
 *
 * - Corrige espaços nas pontas e diferenças de maiúsculas/minúsculas.
 * - Traduz nomenclaturas antigas ("Grimoria 01" → "Grimoria I").
 * - Devolve o valor original (apenas com trim) quando não reconhece, para
 *   nunca descartar silenciosamente um dado que o usuário digitou.
 */
export function normalizeServerName(value: string | null | undefined): string {
  const trimmed = (value || "").trim();
  if (!trimmed) return "";

  const lowercase = trimmed.toLowerCase();
  const official = OFFICIAL_BY_LOWERCASE.get(lowercase);
  if (official) return official;

  const alias = LEGACY_SERVER_ALIASES[lowercase];
  if (alias) return alias;

  return trimmed;
}

/**
 * Indica se o valor corresponde a um servidor oficial, aceitando também
 * nomenclaturas antigas — usar sempre no lugar de
 * `OFFICIAL_SERVERS.includes(x)` quando `x` vier de dados salvos.
 */
export function isOfficialServer(value: string | null | undefined): boolean {
  const normalized = normalizeServerName(value);
  return OFFICIAL_BY_LOWERCASE.has(normalized.toLowerCase());
}
/**
 * Chave canônica de agrupamento/comparação de servidores.
 *
 * Use SEMPRE que for agrupar, contar ou comparar servidores vindos de dados
 * salvos. Garante que "Grimoria I", "Grimoria 1", "grimoria i" e
 * "Grimoria I " caiam no MESMO balde, e — igualmente importante — que
 * "Grimoria I" e "Grimoria II" nunca se misturem, porque a comparação é
 * sempre pelo nome COMPLETO e exato (nunca prefixo/substring).
 *
 * Retorna string vazia para entradas vazias, permitindo descartá-las.
 */
export function serverKey(value: string | null | undefined): string {
  return normalizeServerName(value).toLowerCase();
}

/** Compara dois servidores pelo nome completo, tolerando caixa/alias/espaços. */
export function isSameServer(a: string | null | undefined, b: string | null | undefined): boolean {
  const keyA = serverKey(a);
  const keyB = serverKey(b);
  return keyA !== "" && keyA === keyB;
}

/**
 * Rótulo de exibição canônico — evita que a UI mostre "Grimoria 01" ao lado
 * de "Grimoria I" como se fossem servidores distintos.
 */
export function serverLabel(value: string | null | undefined): string {
  return normalizeServerName(value);
}
