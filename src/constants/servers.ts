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
  "Dominum",     // novo — criado na união dos antigos Infernum 1/2/3
  "Drakaria",    // Grimoria I + Grimoria III
  "Eldrian",     // Serenian + Halorian
  "Elysian",
  "Infernum",    // novo — criado na união dos antigos Infernum 1/2/3
  "Lunarian",
  "Malveria",    // Grimoria II + Grimoria IV
  "Mystian",
  "Obsidian",    // Etherian + Divinian
  "Solarian",
  "Tenebrium",
  "Vesperia",
] as const;

// ── CLASSIFICAÇÃO OFICIAL (tipo de PVP + situação de transferência) ─────────

/**
 * Categorias de PVP dos servidores — ordem canônica de exibição.
 * 126ª — nomenclatura oficial: a categoria antes chamada só de "PVP" passou a
 * se chamar "Open PVP" em todo o aplicativo; "Retro PVP" e "Non PVP" são
 * nomes próprios e permanecem como estão.
 */
export type ServerPvpType = "Open PVP" | "Retro PVP" | "Non PVP";
export const SERVER_PVP_TYPE_ORDER: readonly ServerPvpType[] = ["Open PVP", "Retro PVP", "Non PVP"];

/**
 * Forma COMPACTA da categoria, para quando ela acompanha o nome do servidor
 * (ex.: "Infernum · Retro", "Auroria · Open", "Eldrian · Non" no PartyPanel).
 * Fonte única — nunca recrie estas abreviações nos componentes.
 */
export const SERVER_PVP_TYPE_SHORT: Readonly<Record<ServerPvpType, string>> = {
  "Open PVP": "Open",
  "Retro PVP": "Retro",
  "Non PVP": "Non",
};

export interface OfficialServerMeta {
  pvpType: ServerPvpType;
  /** true = transferência ABERTA; false = FECHADA. */
  transferOpen: boolean;
}

/** Catálogo oficial: tipo de PVP e transferência de CADA servidor. */
export const SERVER_META: Readonly<Record<string, OfficialServerMeta>> = {
  "Auroria":   { pvpType: "Open PVP",  transferOpen: true },
  "Belaria":   { pvpType: "Open PVP",  transferOpen: true },
  "Bellum":    { pvpType: "Retro PVP", transferOpen: true },
  "Dominum":   { pvpType: "Retro PVP", transferOpen: false },
  "Drakaria":  { pvpType: "Open PVP",  transferOpen: false },
  "Eldrian":   { pvpType: "Non PVP",   transferOpen: false },
  "Elysian":   { pvpType: "Non PVP",   transferOpen: true },
  "Infernum":  { pvpType: "Retro PVP", transferOpen: false },
  "Lunarian":  { pvpType: "Non PVP",   transferOpen: true },
  "Malveria":  { pvpType: "Open PVP",  transferOpen: false },
  "Mystian":   { pvpType: "Non PVP",   transferOpen: true },
  "Obsidian":  { pvpType: "Non PVP",   transferOpen: false },
  "Solarian":  { pvpType: "Non PVP",   transferOpen: true },
  "Tenebrium": { pvpType: "Retro PVP", transferOpen: false },
  "Vesperia":  { pvpType: "Open PVP",  transferOpen: true },
};

/** Metadados do servidor (aceita alias/caixa) — null para inválidos. */
export function getServerMeta(value: string | null | undefined): OfficialServerMeta | null {
  const label = serverLabel(value);
  return label ? SERVER_META[label] ?? null : null;
}

/**
 * IDENTIDADE VISUAL por categoria de PVP — fonte única de cores usada em
 * TODAS as exibições de servidores (badges, selects, tabelas):
 *   Open PVP = amarelo · Retro PVP = vermelho · Non PVP = esmeralda (126ª).
 * `optionHex` é a cor equivalente para <option>/<optgroup> nativos (que não
 * aceitam classes Tailwind de forma confiável).
 */
export const SERVER_PVP_TYPE_COLORS: Readonly<Record<ServerPvpType, { text: string; border: string; bg: string; dot: string; optionHex: string }>> = {
  "Open PVP":  { text: "text-yellow-300",  border: "border-yellow-500/40",  bg: "bg-yellow-500/10",  dot: "bg-yellow-400",  optionHex: "#fde047" },
  "Retro PVP": { text: "text-red-300",     border: "border-red-500/40",     bg: "bg-red-500/10",     dot: "bg-red-400",     optionHex: "#fca5a5" },
  "Non PVP":   { text: "text-emerald-300", border: "border-emerald-500/40", bg: "bg-emerald-500/10", dot: "bg-emerald-400", optionHex: "#6ee7b7" },
};

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

  // ── Infernum 1/2/3 — NÃO há alias (decisão da união) ─────────────────────
  // Os antigos Infernum 1, 2 e 3 foram unidos e deram origem a DOIS novos
  // servidores (Infernum e Dominum). Como não existe correspondência 1:1,
  // NENHUM personagem antigo é associado automaticamente: esses nomes são
  // APOSENTADOS (ver RETIRED_SERVER_KEYS) — o campo fica sem definição até
  // o próprio usuário editar o cadastro e escolher o servidor correto.
};

/**
 * SERVIDORES APOSENTADOS (125ª — união Infernum): nomes que deixaram de
 * existir SEM servidor sucessor automático. Qualquer dado com estes nomes é
 * tratado como "sem servidor definido": `serverLabel`/`serverKey` devolvem
 * vazio, então eles somem de filtros, relatórios, cálculos e exibições —
 * mas o valor ORIGINAL permanece intacto no armazenamento (o usuário decide
 * o novo servidor ao editar). Inclui as variações históricas de grafia.
 */
export const RETIRED_SERVERS: readonly string[] = ["Infernum 1", "Infernum 2", "Infernum 3"];
const RETIRED_SERVER_KEYS = new Set<string>([
  "infernum 1", "infernum 01", "infernum i",
  "infernum 2", "infernum 02", "infernum ii",
  "infernum 3", "infernum 03", "infernum iii",
]);

/** true quando o valor corresponde a um servidor aposentado (sem sucessor). */
export function isRetiredServer(value: string | null | undefined): boolean {
  return RETIRED_SERVER_KEYS.has((value || "").trim().toLowerCase());
}

/**
 * Merges de servidores, em forma legível.
 *
 * Serve de documentação viva e alimenta os testes. A tradução em si acontece
 * em `LEGACY_SERVER_ALIASES`, que é o caminho por onde TODO o aplicativo já
 * passava (`normalizeServerName` → `serverKey`/`serverLabel`).
 */
export const SERVER_MERGES: ReadonlyArray<{ from: readonly string[]; to: OfficialServer }> = [
  // A união dos Infernum 1/2/3 (→ Infernum + Dominum) NÃO está aqui de
  // propósito: por ter DOIS sucessores, não existe tradução automática —
  // ver RETIRED_SERVERS.
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
  const lowercase = normalizeServerName(value).toLowerCase();
  // 125ª — servidores INVÁLIDOS (aposentados ou desconhecidos) não têm
  // chave: caem fora de agrupamentos, filtros, relatórios e cálculos sem
  // nunca se misturar com os oficiais. O dado bruto permanece onde está.
  return OFFICIAL_BY_LOWERCASE.has(lowercase) ? lowercase : "";
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
  const normalized = normalizeServerName(value);
  // 125ª — nome antigo/inválido NUNCA é exibido: o campo aparece sem
  // definição ("" → "—"/placeholder na UI) até o usuário escolher um
  // servidor da lista oficial. O valor original segue preservado nos dados.
  return OFFICIAL_BY_LOWERCASE.has(normalized.toLowerCase()) ? normalized : "";
}
