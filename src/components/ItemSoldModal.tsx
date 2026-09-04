import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { X, Coins, Percent, RotateCcw, Check } from "lucide-react";
import type { ItemSaleRecord } from "../types";
import { formatRC } from "../types";
import {
  DEFAULT_MARKET_TAX_PERCENT,
  MARKET_TAX_CAP_KK,
  buildItemSaleRecord,
  computeItemRC,
  computeMarketTaxKk,
  formatKkValue,
  formatRateKkDisplay,
  parseRateKk,
  sanitizeRateKkInput,
} from "../utils/itemSale";

/**
 * MODAL "ITEM VENDIDO"
 * --------------------
 * Substitui os dois campos kk (venda + cotação) por um fluxo único e claro:
 *   valor vendido do item + valor do RC no Market -> resultado em RC,
 * com aplicação opcional da Taxa do Market (N% por oferta criada, teto de
 * 10kk por oferta — regra em src/utils/itemSale.ts).
 *
 * Compartilhado entre o PartyPanel (coluna ITEM VENDIDO/SERVICE) e a guia
 * Meus Personagens (Lucro SW / Lucro SG) — mesma operação, mesmo registro.
 */
interface Props {
  /** Nome do item dropado (contexto no cabeçalho). */
  itemName: string;
  /** Rótulo do contexto: nome do personagem/jogador ou da Quest. */
  contextLabel?: string;
  /** Registro existente (reabrir para editar antes do salvamento permanente). */
  initial?: ItemSaleRecord | null;
  onCancel: () => void;
  onSave: (record: ItemSaleRecord) => void;
}

export default function ItemSoldModal({ itemName, contextLabel, initial, onCancel, onSave }: Props) {
  // ── Estado dos campos (strings de digitação, pt-BR) ───────────────────────
  const [vendaRaw, setVendaRaw] = useState(() => initial && initial.vendaKk > 0 ? formatRateKkDisplay(initial.vendaKk) : "");
  const [rateRaw, setRateRaw] = useState(() => initial && initial.rateKk > 0 ? formatRateKkDisplay(initial.rateKk) : "");
  const [percentRaw, setPercentRaw] = useState(() =>
    initial && initial.taxPercent > 0 ? formatRateKkDisplay(initial.taxPercent) : String(DEFAULT_MARKET_TAX_PERCENT));
  const [taxCount, setTaxCount] = useState(() => initial?.taxCount || 0);

  // Esc fecha sem salvar (padrão dos demais modais do app).
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onCancel(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  // ── Valores numéricos derivados ───────────────────────────────────────────
  // `parseRateKk` aceita vírgula pt-BR; venda também tolera decimais.
  const vendaKk = parseRateKk(vendaRaw);
  const rateKk = parseRateKk(rateRaw);
  const taxPercent = parseRateKk(percentRaw) || 0;

  const readyForTax = vendaKk > 0 && rateKk > 0;
  const preview = useMemo(() => {
    const taxKk = computeMarketTaxKk(vendaKk, taxPercent, taxCount);
    const netKk = Math.max(0, Math.round((vendaKk - taxKk) * 100) / 100);
    return { taxKk, netKk, resultRC: computeItemRC(rateKk, netKk) };
  }, [vendaKk, rateKk, taxPercent, taxCount]);

  // Taxa de UMA oferta com o teto — só para o texto explicativo do botão.
  const singleCapped = vendaKk > 0 && taxPercent > 0 && (vendaKk * taxPercent) / 100 > MARKET_TAX_CAP_KK;

  function handleSave() {
    if (!readyForTax) return;
    onSave(buildItemSaleRecord(vendaKk, rateKk, taxPercent, taxCount));
  }

  const inputCls = "w-full bg-black/40 border rounded-lg px-2.5 py-1.5 text-sm text-right tabular-nums outline-none transition-colors placeholder-slate-600";

  return createPortal(
    <div
      className="fixed inset-0 z-[500] flex items-center justify-center bg-black/75 backdrop-blur-sm p-4"
      onMouseDown={e => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="w-full max-w-sm bg-[var(--th-n-elev,#0f1219)] border border-emerald-500/25 rounded-2xl shadow-2xl shadow-black/60 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/5 bg-emerald-500/[0.06]">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-7 h-7 rounded-lg bg-emerald-500/15 border border-emerald-500/40 flex items-center justify-center flex-shrink-0">
              <Coins size={14} className="text-emerald-400" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-bold text-white leading-tight">Item Vendido</h3>
              <p className="text-[10px] text-slate-400 truncate">
                {itemName}{contextLabel ? ` — ${contextLabel}` : ""}
              </p>
            </div>
          </div>
          <button onClick={onCancel} className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-white/5 transition-colors cursor-pointer flex-shrink-0">
            <X size={15} />
          </button>
        </div>

        <div className="p-4 space-y-3">
          {/* Valor vendido + Cotação RC */}
          <div className="grid grid-cols-2 gap-2.5">
            <label className="block">
              <span className="text-[10px] font-bold uppercase tracking-wider text-sky-300">Valor vendido</span>
              <div className="relative mt-1">
                <input
                  type="text"
                  inputMode="decimal"
                  value={vendaRaw}
                  onChange={e => setVendaRaw(sanitizeRateKkInput(e.target.value))}
                  placeholder="0"
                  autoFocus
                  className={`${inputCls} pr-8 border-sky-500/40 focus:border-sky-400/70 text-sky-200`}
                />
                <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] font-bold text-sky-400/70 select-none pointer-events-none">kk</span>
              </div>
            </label>
            <label className="block">
              <span className="text-[10px] font-bold uppercase tracking-wider text-red-300">RC no Market</span>
              <div className="relative mt-1">
                <input
                  type="text"
                  inputMode="decimal"
                  value={rateRaw}
                  onChange={e => setRateRaw(sanitizeRateKkInput(e.target.value))}
                  placeholder="0"
                  title="Cotação: quantos k equivalem a 1000 RC"
                  className={`${inputCls} pr-7 border-red-500/40 focus:border-red-400/70 text-red-200`}
                />
                <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] font-bold text-red-400/70 select-none pointer-events-none">k</span>
              </div>
            </label>
          </div>

          {/* Taxa Market */}
          <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.05] p-2.5 space-y-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={!readyForTax}
                onClick={() => setTaxCount(c => c + 1)}
                title={readyForTax
                  ? `Cada clique soma 1 oferta criada no Market (taxa de ${percentRaw || "5"}% por oferta, limitada a ${MARKET_TAX_CAP_KK}kk). Venda direta para oferta de compra = 0x (sem taxa).`
                  : "Preencha o valor vendido e o RC no Market para habilitar"}
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg border border-amber-500/40 bg-amber-500/15 text-amber-300 text-xs font-bold hover:bg-amber-500/25 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Percent size={12} /> Taxa Market
                <span className="px-1.5 py-0.5 rounded bg-amber-500 text-black text-[10px] font-black font-mono">{taxCount}x</span>
              </button>
              <div className="relative w-16 flex-shrink-0">
                <input
                  type="text"
                  inputMode="decimal"
                  value={percentRaw}
                  onChange={e => setPercentRaw(sanitizeRateKkInput(e.target.value))}
                  title="Porcentagem da taxa do Market por oferta (padrão 5%)"
                  className={`${inputCls} pr-6 py-1.5 text-xs border-amber-500/30 focus:border-amber-400/60 text-amber-200`}
                />
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-bold text-amber-400/70 select-none pointer-events-none">%</span>
              </div>
              <button
                type="button"
                disabled={taxCount === 0}
                onClick={() => setTaxCount(0)}
                title="Resetar a contagem de taxas aplicadas (0x)"
                className="p-1.5 rounded-lg border border-white/10 bg-white/5 text-slate-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed flex-shrink-0"
              >
                <RotateCcw size={13} />
              </button>
            </div>
            <p className="text-[9px] leading-snug text-amber-200/60">
              {taxCount === 0
                ? "0x = venda direta para a oferta de compra mais alta (sem taxa)."
                : `${taxCount} oferta${taxCount > 1 ? "s" : ""} criada${taxCount > 1 ? "s" : ""} no Market — ${taxCount} taxa${taxCount > 1 ? "s" : ""} de ${percentRaw || "5"}% aplicada${taxCount > 1 ? "s" : ""}${singleCapped ? ` (teto de ${MARKET_TAX_CAP_KK}kk por oferta)` : ""}: −${formatKkValue(preview.taxKk, "kk")}.`}
            </p>
          </div>

          {/* Resultado */}
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/[0.07] px-3 py-2.5">
            <div className="flex items-center justify-between text-[10px] text-slate-400">
              <span>Valor considerado</span>
              <span className="tabular-nums font-bold text-slate-200">{formatKkValue(preview.netKk, "kk")}</span>
            </div>
            <div className="flex items-center justify-between mt-1">
              <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-400">Resultado em RC</span>
              <span className={`text-lg font-black tabular-nums ${preview.resultRC > 0 ? "text-emerald-300" : "text-emerald-400/40"}`}>
                {preview.resultRC > 0 ? formatRC(preview.resultRC) : "0"}
              </span>
            </div>
          </div>

          {/* Ações */}
          <div className="flex items-center gap-2 pt-0.5">
            <button
              type="button"
              onClick={onCancel}
              className="flex-1 py-1.5 rounded-lg border border-white/10 bg-white/5 text-slate-300 text-xs font-bold hover:bg-white/10 transition-colors cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="button"
              disabled={!readyForTax || preview.resultRC <= 0}
              onClick={handleSave}
              className="flex-1 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-black text-xs font-black inline-flex items-center justify-center gap-1 transition-colors cursor-pointer shadow-lg shadow-emerald-500/10 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Check size={13} /> Salvar venda
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
