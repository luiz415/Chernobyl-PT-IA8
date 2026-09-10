// ============================================================================
// FORMULÁRIO DE SERVICE — LINK EXCLUSIVO POR USUÁRIO (slug)
// ----------------------------------------------------------------------------
// Fonte única da identificação usada na rota `#/servico/{id}`:
//
//   • GERAÇÃO (Meus Services → "Gerar link do formulário"): slug amigável
//     derivado do nome do usuário ("Luis" → "luis"). Se OUTRO usuário
//     elegível tiver o mesmo slug, anexa um sufixo com o prefixo do UID
//     ("luis-ab12cd") — o link continua legível e vira único.
//
//   • RESOLUÇÃO (PublicServiceForm): o identificador da URL é comparado com
//     a lista de serviceiros ELEGÍVEIS que o formulário JÁ carrega hoje
//     (mesma consulta — zero leituras extras). Aceita, nesta ordem:
//       1. UID completo (estável para sempre, mesmo se o nome mudar);
//       2. slug exato do nome, desde que corresponda a UM único elegível;
//       3. slug com sufixo de UID (resolve ambiguidade de nomes iguais).
//     Sem correspondência única → null (o formulário avisa e cai no modo
//     normal com seleção manual — nunca associa "no chute").
//
// SEGURANÇA — por que resolver contra a lista de ELEGÍVEIS é suficiente:
// o identificador da URL nunca é gravado; ele apenas seleciona um UID da
// lista de destinos legítimos (Boss ou VIP ativo + serviceiro). O envio usa
// o MESMO caminho do seletor manual (`serviceRequests` com `serviceiroUid`),
// cuja regra do Firestore valida NO BACKEND que o destinatário é aprovado e
// habilitado. Manipular a URL não dá nenhum poder além do que o seletor
// visível já dá — e o destinatário ainda precisa APROVAR a solicitação.
//
// Módulo puro (sem Firebase/JSX) — compilável e testável em Node.
// ============================================================================

/** Base pública do formulário — mesma constante exibida nos botões de link. */
export const PUBLIC_SERVICE_FORM_BASE_URL = "https://chernobyl-pt.web.app/#/servico";

/** Candidato à resolução: os mesmos campos da lista de elegíveis do form. */
export interface ServiceFormTarget {
  uid: string;
  nome: string;
}

/** Tamanho mínimo do sufixo de UID aceito na resolução. */
const MIN_UID_SUFFIX = 4;
/** Tamanho do sufixo de UID usado na GERAÇÃO de links ambíguos. */
const GENERATED_UID_SUFFIX = 6;

/**
 * Slug amigável e seguro para URL a partir do nome exibido:
 * minúsculas, sem acentos, blocos não alfanuméricos viram um único "-".
 * Ex.: "Luís  d'Ávila" → "luis-d-avila".
 */
export function serviceiroSlug(nome: string): string {
  return String(nome || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/**
 * Monta a URL exclusiva do usuário.
 * `eligible` é a lista de TODOS os usuários elegíveis (incluindo ou não o
 * próprio) — usada apenas para detectar conflito de slug e, nesse caso,
 * anexar o sufixo de UID que torna o link único.
 * Nome vazio/só símbolos cai no prefixo do UID (sempre há identificador).
 */
export function buildExclusiveServiceFormUrl(uid: string, nome: string, eligible: ServiceFormTarget[]): string {
  const cleanUid = String(uid || "").trim();
  if (!cleanUid) return "";
  const base = serviceiroSlug(nome) || cleanUid.slice(0, 8).toLowerCase();
  const conflict = eligible.some(user => user.uid !== cleanUid && serviceiroSlug(user.nome) === base);
  const slug = conflict ? `${base}-${cleanUid.slice(0, GENERATED_UID_SUFFIX).toLowerCase()}` : base;
  return `${PUBLIC_SERVICE_FORM_BASE_URL}/${slug}`;
}

/**
 * Resolve o identificador vindo da URL para UM único elegível — ou null.
 *
 * A regra de ouro: NUNCA devolver um alvo em caso de ambiguidade. Melhor o
 * formulário cair no modo normal (com seleção explícita) do que associar o
 * cadastro ao usuário errado.
 */
export function resolveServiceFormTarget(rawId: string, eligible: ServiceFormTarget[]): ServiceFormTarget | null {
  let id = String(rawId || "").trim();
  try { id = decodeURIComponent(id); } catch {}
  id = id.trim().toLowerCase();
  if (!id) return null;

  // 1) UID completo (identificador interno, sempre estável).
  const byUid = eligible.filter(user => user.uid.toLowerCase() === id);
  if (byUid.length === 1) return byUid[0];

  // 2) Slug exato do nome — precisa ser ÚNICO entre os elegíveis.
  const bySlug = eligible.filter(user => serviceiroSlug(user.nome) === id);
  if (bySlug.length === 1) return bySlug[0];

  // 3) Slug + sufixo de UID ("luis-ab12cd"): desempata homônimos.
  for (const user of eligible) {
    const slug = serviceiroSlug(user.nome);
    if (!slug || !id.startsWith(`${slug}-`)) continue;
    const suffix = id.slice(slug.length + 1);
    if (suffix.length >= MIN_UID_SUFFIX && user.uid.toLowerCase().startsWith(suffix)) return user;
  }

  return null;
}

/**
 * Extrai o identificador exclusivo da URL atual do formulário.
 * Aceita `#/servico/{id}`, `#/serviço/{id}` (com cedilha, decodificada ou
 * não) e o modo query `?servico={id}`. Sem identificador → "" (modo normal).
 */
export function getServiceFormIdFromLocation(hash: string, search: string): string {
  let decodedHash = String(hash || "");
  try { decodedHash = decodeURIComponent(decodedHash); } catch {}
  const match = decodedHash.match(/^#\/servi[cç]o\/([^/?#]+)/i);
  if (match && match[1]) return match[1].trim();
  try {
    const value = new URLSearchParams(search || "").get("servico");
    if (value && value.trim()) return value.trim();
  } catch {}
  return "";
}
