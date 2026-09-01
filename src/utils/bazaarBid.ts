// ============================================================================
// LANCE DIRETO NO BAZAAR (coluna LINK do Painel Bazaar)
//
// Responsabilidades deste módulo (puro, sem React e sem efeitos colaterais):
//   • extrair o ID do personagem a partir do link/ID já existente do leilão;
//   • validar o valor digitado pelo usuário (apenas numérico, inteiro > 0);
//   • montar a URL oficial de lance:
//       https://rubinot.com.br/bazaar/{ID}/bid?amount={VALOR}
//
// Este módulo NÃO executa lance algum: ele apenas devolve a URL que o usuário
// abrirá manualmente ao clicar no botão "Bid".
// ============================================================================

export const RUBINOT_BAZAAR_BASE_URL = "https://rubinot.com.br/bazaar";

/** Valor máximo aceito no campo de lance (evita overflow/typo absurdo). */
export const MAX_BID_AMOUNT = 999_999_999;

/**
 * Extrai o ID numérico do personagem usando o link já existente e, como
 * alternativa, o campo `id` do leilão. Nunca inventa um ID: se não houver
 * dígitos utilizáveis, devolve string vazia.
 */
export function extractBazaarAuctionId(url?: string | null, fallbackId?: string | null): string {
  const fromUrl = (url || "").trim();
  if (fromUrl) {
    // Descarta query string e fragmento antes de olhar os segmentos do caminho.
    const clean = fromUrl.split("#")[0].split("?")[0];
    const segments = clean.split("/").map(part => part.trim()).filter(Boolean);
    for (let index = segments.length - 1; index >= 0; index -= 1) {
      const segment = segments[index];
      if (/^\d+$/.test(segment)) return segment;
    }
  }
  const fromId = String(fallbackId || "").trim();
  if (/^\d+$/.test(fromId)) return fromId;
  return "";
}

/**
 * Normaliza o texto digitado pelo usuário mantendo apenas dígitos.
 * Separadores de milhar (`.`, `,`, espaço) são tolerados na digitação.
 */
export function sanitizeBidInput(raw: string): string {
  return String(raw ?? "").replace(/\D+/g, "").replace(/^0+(?=\d)/, "");
}

/**
 * Converte o texto digitado em um valor de lance válido.
 * Devolve `null` quando o valor é vazio, não numérico, zero ou fora do limite.
 */
export function parseBidAmount(raw: string): number | null {
  const digits = sanitizeBidInput(raw);
  if (!digits) return null;
  const value = Number(digits);
  if (!Number.isFinite(value) || !Number.isInteger(value)) return null;
  if (value <= 0 || value > MAX_BID_AMOUNT) return null;
  return value;
}

/** `true` somente quando o botão "Bid" pode ser habilitado. */
export function isBidAmountValid(raw: string): boolean {
  return parseBidAmount(raw) !== null;
}

/**
 * Monta a URL oficial de lance a partir do link/ID já existente do personagem.
 * Devolve `null` se faltar o ID ou se o valor informado for inválido — nesse
 * caso nada deve ser aberto.
 */
export function buildBazaarBidUrl(
  url: string | null | undefined,
  fallbackId: string | null | undefined,
  rawAmount: string,
): string | null {
  const auctionId = extractBazaarAuctionId(url, fallbackId);
  if (!auctionId) return null;
  const amount = parseBidAmount(rawAmount);
  if (amount === null) return null;
  return `${RUBINOT_BAZAAR_BASE_URL}/${auctionId}/bid?amount=${amount}`;
}
