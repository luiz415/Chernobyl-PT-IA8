// ============================================================================
// TEXTO DE VENDA POR SERVIDOR (75ª) — modal "Itens à Venda" de Meus Personagens
// ----------------------------------------------------------------------------
// Núcleo PURO (testável sem DOM) da geração de anúncios personalizados:
//   • `SaleTextConfig` — as três seções do anúncio (Introdução / Itens /
//     Encerramento) + as opções de formatação dos itens;
//   • `buildSaleAnnouncement` — monta o texto final a partir da config e dos
//     itens à venda de UM servidor (nome/valor/quantidade já derivados pelo
//     modal com as MESMAS regras da 73ª — nenhuma fonte de dados nova);
//   • `loadSaleTextConfig`/`saveSaleTextConfig` — persistência POR USUÁRIO
//     em localStorage (mesmo padrão das demais preferências locais do app:
//     `rubinot_sale_text_config_<uid||"local">`), sobrevive a recarregar/
//     reabrir o aplicativo e NUNCA toca o Firestore.
//
// FORMATAÇÃO × DESTINO: a área de transferência recebe TEXTO PURO — negrito
// e afins dependem do aplicativo onde o texto será colado. Por isso o
// destaque é expresso em CARACTERES compatíveis com o destino escolhido
// (WhatsApp: *texto*; Discord/Telegram: **texto**; ou MAIÚSCULAS, que valem
// em qualquer lugar) — nunca se presume formatação visual automática.
// Emojis/acentos/quebras de linha são preservados exatamente como digitados.
// ============================================================================

import { formatKkValue } from "./itemSale";

/** Organização dos itens no texto gerado. */
export type SaleTextLayout = "lines" | "inline";

/** Destaque aplicado ao NOME de cada item (caracteres, não formatação real). */
export type SaleTextHighlight = "none" | "asterisks" | "double-asterisks" | "caps";

export interface SaleTextConfig {
  /** Introdução do anúncio — texto livre (emojis/quebras preservados). */
  intro: string;
  /** Encerramento do anúncio — texto livre (emojis/quebras preservados). */
  outro: string;
  /** "lines" = um item por linha; "inline" = lado a lado com separador. */
  layout: SaleTextLayout;
  /** Separador entre itens no layout "inline" (personalizável). */
  separator: string;
  /** Destaque do nome do item (caracteres compatíveis com o destino). */
  highlight: SaleTextHighlight;
  /** Incluir o valor (kk) do item, quando conhecido. */
  includeValue: boolean;
  /** Incluir a quantidade (xN) quando maior que 1. */
  includeAmount: boolean;
  /** Linha EXTRA em branco entre itens (somente layout "lines"). */
  blankLineBetweenItems: boolean;
  /** Linhas em branco entre as seções (Introdução/Itens/Encerramento): 0-3. */
  sectionBlankLines: number;
}

/** Padrões úteis — a funcionalidade funciona imediatamente, sem configurar. */
export const DEFAULT_SALE_TEXT_CONFIG: SaleTextConfig = {
  intro: "🔥 ITENS À VENDA 🔥",
  outro: "💬 Interessados: chama no PV!",
  layout: "lines",
  separator: " | ",
  highlight: "none",
  includeValue: true,
  includeAmount: true,
  blankLineBetweenItems: false,
  sectionBlankLines: 1,
};

const VALID_LAYOUTS: SaleTextLayout[] = ["lines", "inline"];
const VALID_HIGHLIGHTS: SaleTextHighlight[] = ["none", "asterisks", "double-asterisks", "caps"];

/** Normaliza uma config vinda do storage (parcial/antiga/corrompida). */
export function sanitizeSaleTextConfig(raw: unknown): SaleTextConfig {
  const source = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof SaleTextConfig, unknown>>;
  const text = (value: unknown, fallback: string) => (typeof value === "string" ? value : fallback);
  const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
  const sectionBlankLines = Number(source.sectionBlankLines);
  return {
    intro: text(source.intro, DEFAULT_SALE_TEXT_CONFIG.intro),
    outro: text(source.outro, DEFAULT_SALE_TEXT_CONFIG.outro),
    layout: VALID_LAYOUTS.includes(source.layout as SaleTextLayout) ? (source.layout as SaleTextLayout) : DEFAULT_SALE_TEXT_CONFIG.layout,
    separator: text(source.separator, DEFAULT_SALE_TEXT_CONFIG.separator),
    highlight: VALID_HIGHLIGHTS.includes(source.highlight as SaleTextHighlight) ? (source.highlight as SaleTextHighlight) : DEFAULT_SALE_TEXT_CONFIG.highlight,
    includeValue: bool(source.includeValue, DEFAULT_SALE_TEXT_CONFIG.includeValue),
    includeAmount: bool(source.includeAmount, DEFAULT_SALE_TEXT_CONFIG.includeAmount),
    blankLineBetweenItems: bool(source.blankLineBetweenItems, DEFAULT_SALE_TEXT_CONFIG.blankLineBetweenItems),
    sectionBlankLines: Number.isFinite(sectionBlankLines) ? Math.min(3, Math.max(0, Math.floor(sectionBlankLines))) : DEFAULT_SALE_TEXT_CONFIG.sectionBlankLines,
  };
}

/** Chave POR USUÁRIO (mesmo padrão das demais preferências locais). */
export const SALE_TEXT_CONFIG_KEY_PREFIX = "rubinot_sale_text_config_";
export function saleTextConfigKey(uid: string): string {
  return `${SALE_TEXT_CONFIG_KEY_PREFIX}${String(uid || "").trim() || "local"}`;
}

export function loadSaleTextConfig(uid: string): SaleTextConfig {
  try {
    const raw = localStorage.getItem(saleTextConfigKey(uid));
    if (!raw) return { ...DEFAULT_SALE_TEXT_CONFIG };
    return sanitizeSaleTextConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SALE_TEXT_CONFIG };
  }
}

export function saveSaleTextConfig(uid: string, config: SaleTextConfig): void {
  try {
    localStorage.setItem(saleTextConfigKey(uid), JSON.stringify(sanitizeSaleTextConfig(config)));
  } catch { /* storage indisponível: a config vale só para a sessão */ }
}

/** Dados de UM item no anúncio — derivados pelo modal (regras da 73ª). */
export interface SaleTextItemInput {
  name: string;
  /** Valor considerado (kk) — null/0 = desconhecido (omitido do texto). */
  valueKk: number | null;
  /** Quantidade (xN no texto quando > 1 e habilitado). */
  amount?: number;
}

/** Aplica o destaque escolhido ao nome (caracteres, nunca formatação real). */
function applyHighlight(name: string, highlight: SaleTextHighlight): string {
  if (highlight === "asterisks") return `*${name}*`;
  if (highlight === "double-asterisks") return `**${name}**`;
  if (highlight === "caps") return name.toLocaleUpperCase("pt-BR");
  return name;
}

/** Linha/trecho de UM item conforme a config (nome [xN] [— valor]). */
export function formatSaleTextItem(item: SaleTextItemInput, config: SaleTextConfig): string {
  let text = applyHighlight(String(item.name || "").trim(), config.highlight);
  const amount = Number(item.amount) || 0;
  if (config.includeAmount && amount > 1) text += ` x${amount}`;
  const valueKk = Number(item.valueKk) || 0;
  if (config.includeValue && valueKk > 0) text += ` — ${formatKkValue(valueKk, "kk", true)}`;
  return text;
}

/**
 * Monta o anúncio completo de UM servidor: Introdução + itens (na ordem
 * recebida) + Encerramento, com o espaçamento configurado. Seções vazias
 * são omitidas (sem linhas em branco órfãs); lista vazia gera só
 * Introdução/Encerramento. Emojis, acentos e quebras digitadas nas seções
 * livres são preservados byte a byte.
 */
export function buildSaleAnnouncement(config: SaleTextConfig, items: SaleTextItemInput[]): string {
  const cfg = sanitizeSaleTextConfig(config);
  const sectionJoin = "\n".repeat(1 + cfg.sectionBlankLines);
  const itemTexts = (Array.isArray(items) ? items : [])
    .map(item => formatSaleTextItem(item, cfg))
    .filter(text => text.length > 0);
  const body = cfg.layout === "inline"
    ? itemTexts.join(cfg.separator.length > 0 ? cfg.separator : " | ")
    : itemTexts.join("\n".repeat(cfg.blankLineBetweenItems ? 2 : 1));
  // Normaliza apenas CRLF das seções livres (clipboard multi-plataforma);
  // conteúdo (emojis/acentos/quebras) permanece como o usuário digitou.
  const intro = cfg.intro.replace(/\r\n/g, "\n").trim();
  const outro = cfg.outro.replace(/\r\n/g, "\n").trim();
  return [intro, body, outro].filter(section => section.length > 0).join(sectionJoin);
}
