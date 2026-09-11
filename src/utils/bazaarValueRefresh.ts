// ============================================================================
// ATUALIZAR VALORES (Bazaar) — OVERLAY LOCAL DE VALORES
// ----------------------------------------------------------------------------
// Suporte puro (sem Firebase/JSX) para a função "Atualizar Valores" do Boss:
//
//   • O Boss relê APENAS a listagem do Bazaar (leitura inicial, sem análise
//     de quests) e os novos valores são aplicados como um OVERLAY sobre a
//     lista oficial — exclusivamente em memória e no localStorage DESTE
//     dispositivo. NADA é escrito no Firestore: a lista compartilhada, o
//     metadado de versão e os caches dos demais usuários ficam intactos
//     (zero leituras/escritas para os outros usuários).
//
//   • O overlay é atrelado à VERSÃO da lista oficial: quando uma nova
//     consulta publica outra versão, o overlay antigo deixa de casar e morre
//     sozinho (a leitura valida a versão antes de aplicar).
//
//   • "Auto Remover Interesse": com o limite configurado, os leilões cujo
//     NOVO valor ultrapassa o limite (estritamente maior) e que possuem
//     interessados são identificados aqui — a remoção efetiva é feita pelo
//     serviço em UMA transação única no doc agregado.
//
// Módulo puro e testável em Node.
// ============================================================================

/** Campos de valor atualizáveis de um leilão. */
export interface BazaarValuePatch {
  bid: number;
  currentValue: number;
  hasBid: boolean;
}

/** Overlay persistido localmente (por dispositivo), atrelado à versão. */
export interface BazaarValueOverlay {
  version: string;
  updatedAtMs: number;
  values: Record<string, BazaarValuePatch>;
}

/** Forma mínima de leilão que o overlay precisa conhecer. */
interface AuctionLike {
  id?: string | number;
  url?: string;
  name?: string;
  bid?: number;
  currentValue?: number;
  hasBid?: boolean;
  [key: string]: any;
}

const OVERLAY_STORAGE_KEY = "rubinot_bazaar_value_overlay";

/** MESMA identidade usada pelo painel (getAuctionKey): id → url → name. */
export function bazaarValueAuctionKey(auction: AuctionLike): string {
  return String(auction?.id || auction?.url || auction?.name || "");
}

/**
 * Cruza a lista oficial com a listagem recém-lida e monta o overlay
 * {auctionKey → novos valores}. Só entram leilões da lista oficial que
 * foram reencontrados na leitura — personagens já encerrados/ausentes
 * permanecem com os valores originais (nenhum dado antigo é inventado).
 */
export function buildValueOverlay(
  officialAuctions: AuctionLike[],
  fetchedAuctions: AuctionLike[],
): { values: Record<string, BazaarValuePatch>; matchedCount: number } {
  const fetchedByKey = new Map<string, AuctionLike>();
  (fetchedAuctions || []).forEach(auction => {
    const key = bazaarValueAuctionKey(auction);
    if (key) fetchedByKey.set(key, auction);
  });

  const values: Record<string, BazaarValuePatch> = {};
  let matchedCount = 0;
  (officialAuctions || []).forEach(auction => {
    const key = bazaarValueAuctionKey(auction);
    if (!key) return;
    const fresh = fetchedByKey.get(key);
    if (!fresh) return;
    matchedCount += 1;
    values[key] = {
      bid: Number(fresh.bid ?? 0) || 0,
      currentValue: Number(fresh.currentValue ?? fresh.bid ?? 0) || 0,
      hasBid: fresh.hasBid === true,
    };
  });
  return { values, matchedCount };
}

/**
 * Aplica o overlay sobre uma lista de leilões, devolvendo NOVOS objetos
 * apenas para os itens alterados (os demais são reutilizados por referência
 * — sem reconstrução desnecessária da lista inteira).
 */
export function applyValueOverlay<T extends AuctionLike>(
  auctions: T[],
  values: Record<string, BazaarValuePatch>,
): T[] {
  if (!values || Object.keys(values).length === 0) return auctions;
  return (auctions || []).map(auction => {
    const patch = values[bazaarValueAuctionKey(auction)];
    if (!patch) return auction;
    if (auction.bid === patch.bid && auction.currentValue === patch.currentValue && auction.hasBid === patch.hasBid) {
      return auction;
    }
    return { ...auction, bid: patch.bid, currentValue: patch.currentValue, hasBid: patch.hasBid };
  });
}

/**
 * AUTO REMOVER INTERESSE — identifica os leilões afetados.
 * Critério EXATO do requisito: interesse marcado por alguém E novo valor
 * ESTRITAMENTE maior que o limite (`>`); valor igual ou abaixo mantém.
 * Retorna também a contagem de interesses (usuários) que serão removidos.
 */
export function computeAutoRemoveAuctions(
  updatedAuctions: AuctionLike[],
  interests: Record<string, Array<{ uid: string }>>,
  limit: number,
): { auctionIds: string[]; removedInterestCount: number } {
  const auctionIds: string[] = [];
  let removedInterestCount = 0;
  if (!Number.isFinite(limit)) return { auctionIds, removedInterestCount };
  (updatedAuctions || []).forEach(auction => {
    const key = bazaarValueAuctionKey(auction);
    if (!key) return;
    const users = interests?.[key] || [];
    if (users.length === 0) return;
    if ((Number(auction.bid) || 0) > limit) {
      auctionIds.push(key);
      removedInterestCount += users.length;
    }
  });
  return { auctionIds, removedInterestCount };
}

/** Lê o overlay persistido; null quando ausente, corrompido ou de OUTRA versão. */
export function readBazaarValueOverlay(version: string): BazaarValueOverlay | null {
  try {
    const raw = localStorage.getItem(OVERLAY_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object") return null;
    if (String(parsed.version || "") !== String(version || "") || !version) return null;
    if (!parsed.values || typeof parsed.values !== "object") return null;
    return {
      version: String(parsed.version),
      updatedAtMs: Number(parsed.updatedAtMs) || 0,
      values: parsed.values as Record<string, BazaarValuePatch>,
    };
  } catch {
    return null;
  }
}

/** Persiste o overlay do dispositivo (substitui o anterior). */
export function saveBazaarValueOverlay(overlay: BazaarValueOverlay): void {
  try { localStorage.setItem(OVERLAY_STORAGE_KEY, JSON.stringify(overlay)); } catch {}
}

/** Remove o overlay local (reset manual/estado limpo). */
export function clearBazaarValueOverlay(): void {
  try { localStorage.removeItem(OVERLAY_STORAGE_KEY); } catch {}
}

/** Sanitiza o campo "Limite": somente dígitos (inteiro não-negativo). */
export function sanitizeAutoRemoveLimit(raw: string): string {
  return String(raw || "").replace(/\D/g, "").slice(0, 9);
}

/** Converte o texto do limite em número; null quando vazio/inválido. */
export function parseAutoRemoveLimit(raw: string): number | null {
  const clean = sanitizeAutoRemoveLimit(raw);
  if (!clean) return null;
  const value = parseInt(clean, 10);
  return Number.isFinite(value) ? value : null;
}
