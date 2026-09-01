import { MAX_BID_AMOUNT, parseBidAmount } from "./bazaarBid";

// ============================================================================
// BID PADRÃO (quadro "Última consulta" do Painel Bazaar)
//
// Preferência individual por usuário/dispositivo, persistida no localStorage
// na MESMA chave das demais preferências do Bazaar ("rubinot_bazaar_filters",
// usada por bazaarTime.ts e BazarPanel.tsx) — leitura/escrita por mesclagem,
// preservando os campos irmãos (fuso, minutos de notificação etc.).
//
// Regras do valor:
//   • apenas números INTEIROS positivos (validação reaproveitada de
//     parseBidAmount, o mesmo gate do campo de lance da linha);
//   • valor inválido/vazio/zero → amount null → Bid Padrão INATIVO, mesmo com
//     a caixa marcada (nada é aberto com valor inválido).
//
// Regras de prioridade do botão "Bid" da linha (resolveBazaarBid):
//   • valor INDIVIDUAL válido na linha → é ele que vale (o padrão nunca
//     sobrescreve nem desativa o campo individual);
//   • campo individual VAZIO → Bid Padrão ativo entra como fallback;
//   • campo individual preenchido com valor INVÁLIDO → nada acontece (o
//     padrão NÃO substitui silenciosamente o que o usuário digitou);
//   • sem valor válido algum → a ação é impedida.
// ============================================================================

/** Mesma chave das preferências do Bazaar (bazaarTime.ts / BazarPanel.tsx). */
const BAZAR_FILTERS_KEY = "rubinot_bazaar_filters";

export interface BazaarDefaultBidConfig {
  /** Caixa "Bid Padrão" marcada? */
  enabled: boolean;
  /** Valor inteiro válido, ou null quando vazio/inválido. */
  amount: number | null;
}

/** Preferência padrão: desativado, sem valor. */
export const DEFAULT_BAZAAR_DEFAULT_BID: BazaarDefaultBidConfig = { enabled: false, amount: null };

/**
 * Lê a preferência do Bid Padrão. O valor salvo precisa SER um inteiro
 * válido (maior que zero, dentro do teto) — nada de interpretação criativa
 * de entradas corrompidas. Tolerante a falhas: qualquer problema devolve a
 * preferência padrão (desativada).
 */
export function readBazaarDefaultBid(): BazaarDefaultBidConfig {
  try {
    const raw = localStorage.getItem(BAZAR_FILTERS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_BAZAAR_DEFAULT_BID };
    const enabled = parsed.defaultBidEnabled === true;
    const rawAmount = parsed.defaultBidAmount;
    const numeric = typeof rawAmount === "number"
      ? rawAmount
      : (typeof rawAmount === "string" && rawAmount.trim() !== "" ? Number(rawAmount) : NaN);
    const amount = Number.isFinite(numeric) && Number.isInteger(numeric) && numeric > 0 && numeric <= MAX_BID_AMOUNT
      ? numeric
      : null;
    return { enabled, amount };
  } catch {
    return { ...DEFAULT_BAZAAR_DEFAULT_BID };
  }
}

/**
 * Grava a preferência POR MESCLAGEM na chave compartilhada — os demais campos
 * (fuso, minutos de notificação, filtros salvos) são preservados. Campos
 * vazios são removidos do objeto para mantê-lo limpo.
 */
export function saveBazaarDefaultBid(config: BazaarDefaultBidConfig): void {
  try {
    const raw = localStorage.getItem(BAZAR_FILTERS_KEY);
    let base: Record<string, unknown> = {};
    try {
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === "object") base = parsed as Record<string, unknown>;
    } catch {}
    const next: Record<string, unknown> = { ...base };
    if (config.enabled) next.defaultBidEnabled = true;
    else delete next.defaultBidEnabled;
    if (config.amount !== null) next.defaultBidAmount = config.amount;
    else delete next.defaultBidAmount;
    localStorage.setItem(BAZAR_FILTERS_KEY, JSON.stringify(next));
  } catch {}
}

/** Fonte do valor que o botão "Bid" de uma linha vai usar. */
export type BazaarBidSource = "individual" | "default" | "none";

/**
 * Resolução do valor de Bid de UMA linha da tabela:
 *   • source "individual" — linha com valor válido: prioridade máxima, mesmo
 *     com o Bid Padrão ativo;
 *   • source "default" — campo individual vazio + Bid Padrão ativo (fallback);
 *   • source "none" — sem valor utilizável; `invalidIndividual` true quando o
 *     campo está preenchido com valor inválido (ex.: "0"): o padrão NÃO é
 *     usado nesse caso, para não substituir o que o usuário digitou.
 */
export type BazaarBidResolution =
  | { source: "individual"; amount: number; invalidIndividual: false }
  | { source: "default"; amount: number; invalidIndividual: false }
  | { source: "none"; amount: null; invalidIndividual: boolean };

/**
 * Resolve qual valor de lance o botão "Bid" deve usar para uma linha:
 * individual preenchido e válido > Bid Padrão ativo (só com campo vazio) >
 * nenhum. Puro: sem React, sem storage, sem efeitos colaterais — a mesma
 * função alimenta o gate do botão, o clique e o tooltip da linha.
 */
export function resolveBazaarBid(
  individualRaw: string,
  defaultBid: BazaarDefaultBidConfig,
): BazaarBidResolution {
  const individualAmount = parseBidAmount(individualRaw);
  if (individualAmount !== null) {
    return { source: "individual", amount: individualAmount, invalidIndividual: false };
  }
  const filled = String(individualRaw ?? "").trim() !== "";
  if (filled) {
    return { source: "none", amount: null, invalidIndividual: true };
  }
  if (defaultBid.enabled && defaultBid.amount !== null) {
    return { source: "default", amount: defaultBid.amount, invalidIndividual: false };
  }
  return { source: "none", amount: null, invalidIndividual: false };
}