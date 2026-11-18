import { AlertTriangle } from "lucide-react";
import { formatAuctionEnd, normalizeAuctionEndTimestamp } from "../utils/bazaarTime";

// ─────────────────────────────────────────────────────────────────────────────
// CÉLULA "ENCERRA" — FONTE ÚNICA VISUAL (87ª tarefa), MOVIDA do BazarPanel
// para arquivo próprio na 105ª: o badge agora também é usado pelo painel
// "Próximo Bid" do rodapé (App), que NÃO pode importar o BazarPanel inteiro
// (o painel é carregado sob demanda — lazy — e o rodapé é montado sempre).
// Corpo e regras IDÊNTICOS aos que viviam no BazarPanel; o BazarPanel
// reexporta `AuctionEndBadge` para preservar a importação existente do
// BazaarItemsPanel (nenhum consumidor muda).
// ─────────────────────────────────────────────────────────────────────────────

// Assinatura ESTRUTURAL (87ª — mesma estratégia da
// isAuctionVisibleWithEndedGrace): aceita qualquer objeto com
// `auctionEndTs`, para a MESMA regra valer também na coluna "Encerra" da
// guia "Personagens com Itens". Corpo idêntico ao anterior.
export function isAuctionStillActive(auction: { auctionEndTs?: number | null }, nowUnixTs: number): boolean {
  const auctionEndTs = normalizeAuctionEndTimestamp(auction.auctionEndTs ?? null);
  if (!auctionEndTs) return true;
  return auctionEndTs > nowUnixTs;
}

// Assinatura ESTRUTURAL (87ª) — ver nota da isAuctionStillActive acima.
export function isAuctionEndingSoon(auction: { auctionEndTs?: number | null }, nowUnixTs: number): boolean {
  const auctionEndTs = normalizeAuctionEndTimestamp(auction.auctionEndTs ?? null);
  if (!auctionEndTs) return false;
  const secondsLeft = auctionEndTs - nowUnixTs;
  return secondsLeft > 0 && secondsLeft <= 5 * 60;
}

/**
 * CÉLULA "ENCERRA" — FONTE ÚNICA VISUAL (87ª tarefa): o badge usado pela
 * tabela "Personagens Para SW/SG/GB" (BazarPanel), pela coluna "Encerra" da
 * guia "Personagens com Itens" (BazaarItemsPanel) e pelo modal "Próximo Bid"
 * do rodapé (105ª) — MESMOS indicadores, cores e critérios, sem lógica
 * visual duplicada:
 *   • encerra em ≤ 5 minutos → destaque âmbar (borda + fundo), ícone de
 *     alerta, negrito e tooltip "Leilão encerra em menos de 5 minutos";
 *   • ativo → texto padrão (slate-300);
 *   • JÁ ENCERRADO → texto apagado (slate-600) com tachado.
 * Exportado no mesmo padrão estrutural da isAuctionVisibleWithEndedGrace.
 */
export function AuctionEndBadge({ auctionEndTs, nowUnixTs, timezoneOffsetMinutes }: {
  auctionEndTs?: number | null;
  nowUnixTs: number;
  timezoneOffsetMinutes: number;
}) {
  const probe = { auctionEndTs: auctionEndTs ?? null };
  const endingSoon = isAuctionEndingSoon(probe, nowUnixTs);
  return (
    <span className={`inline-flex items-center justify-center gap-1 rounded-md px-1.5 py-0.5 ${endingSoon ? "border border-amber-500/35 bg-amber-500/10 text-amber-300 font-black" : isAuctionStillActive(probe, nowUnixTs) ? "text-slate-300" : "text-slate-600 line-through"}`} title={endingSoon ? "Leilão encerra em menos de 5 minutos" : undefined}>
      {endingSoon && <AlertTriangle size={10} className="text-amber-300" />}
      {formatAuctionEnd(auctionEndTs ?? null, timezoneOffsetMinutes)}
    </span>
  );
}
