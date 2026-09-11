import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { X, Coins, Percent, RotateCcw, Check, Minus, Plus } from "lucide-react";
import type { ItemSaleRecord } from "../types";
import { formatRC } from "../types";
import {
  OFFER_TAX_CAP_KK,
  OFFER_TAX_PERCENT,
  SALE_TAX_CAP_KK,
  SALE_TAX_PERCENT,
  buildItemSaleRecord,
  computeItemRC,
  computeMarketTaxTotalKk,
  computeOfferTaxPerOfferKk,
  computeOfferTaxTotalKk,
  computeSaleTaxKk,
  formatKkValue,
  formatRateKkDisplay,
  parseRateKk,
  sanitizeRateKkInput,
} from "../utils/itemSale";

/**
 * MODAL "ITEM VENDIDO"
 * --------------------
 * Fluxo único e claro: valor vendido do item + valor do RC no Market +
 * quantidade de OFERTAS CRIADAS -> resultado em RC, com as DUAS taxas
 * vigentes do Market (regra em src/utils/itemSale.ts):
 *   • criação: 1% por oferta criada, máx. 1kk cada;
 *   • venda concluída: 3% uma única vez, máx. 5kk.
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
  // Quantidade de OFERTAS CRIADAS no Market para este item (0 = venda direta
  // para oferta de compra, sem criar oferta própria).
  const [offerCount, setOfferCount] = useState(() => initial?.taxCount || 0);

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

  const readyForTax = vendaKk > 0 && rateKk > 0;
  const preview = useMemo(() => {
    const offerPerKk = offerCount > 0 ? computeOfferTaxPerOfferKk(vendaKk) : 0;
    const offerTotalKk = computeOfferTaxTotalKk(vendaKk, offerCount);
    const saleTaxKk = computeSaleTaxKk(vendaKk);
    const taxKk = computeMarketTaxTotalKk(vendaKk, offerCount);
    const netKk = Math.max(0, Math.round((vendaKk - taxKk) * 100) / 100);
    return { offerPerKk, offerTotalKk, saleTaxKk, taxKk, netKk, resultRC: computeItemRC(rateKk, netKk) };
  }, [vendaKk, rateKk, offerCount]);

  // Tetos atingidos — só para os textos explicativos.
  const offerCapped = vendaKk > 0 && (vendaKk * OFFER_TAX_PERCENT) / 100 > OFFER_TAX_CAP_KK;
  const saleCapped = vendaKk > 0 && (vendaKk * SALE_TAX_PERCENT) / 100 > SALE_TAX_CAP_KK;

  function handleSave() {
    if (!readyForTax) return;
    onSave(buildItemSaleRecord(vendaKk, rateKk, offerCount));
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

          {/* Taxas do Market — regra vigente: criação (1%/1kk por oferta) +
              venda concluída (3%/5kk, uma vez). */}
          <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.05] p-2.5 space-y-1.5">
            {/* Ofertas criadas: stepper − N + */}
            <div className="flex items-center gap-2">
              <span className="flex-1 inline-flex items-center gap-1.5 text-xs font-bold text-amber-300">
                <Percent size={12} /> Ofertas criadas
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={!readyForTax || offerCount === 0}
                  onClick={() => setOfferCount(c => Math.max(0, c - 1))}
                  title="Uma oferta criada a menos"
                  className="w-6 h-6 inline-flex items-center justify-center rounded-lg border border-amber-500/40 bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <Minus size={11} strokeWidth={3} />
                </button>
                <span className="w-8 text-center px-1 py-0.5 rounded bg-amber-500 text-black text-[11px] font-black font-mono tabular-nums select-none">{offerCount}</span>
                <button
                  type="button"
                  disabled={!readyForTax}
                  onClick={() => setOfferCount(c => c + 1)}
                  title={readyForTax
                    ? `Cada oferta criada no Market paga ${OFFER_TAX_PERCENT}% do valor anunciado (máx. ${OFFER_TAX_CAP_KK}kk por oferta), mesmo sem venda. 0 = venda direta para oferta de compra.`
                    : "Preencha o valor vendido e o RC no Market para habilitar"}
                  className="w-6 h-6 inline-flex items-center justify-center rounded-lg border border-amber-500/40 bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Plus size={11} strokeWidth={3} />
                </button>
                <button
                  type="button"
                  disabled={offerCount === 0}
                  onClick={() => setOfferCount(0)}
                  title="Zerar ofertas criadas (venda direta)"
                  className="p-1.5 rounded-lg border border-white/10 bg-white/5 text-slate-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed flex-shrink-0"
                >
                  <RotateCcw size={12} />
                </button>
              </div>
            </div>
            {/* Detalhamento das DUAS taxas — sempre visível quando há valor. */}
            <div className="space-y-0.5 text-[9px] leading-snug tabular-nums">
              <div className="flex items-center justify-between gap-2 text-amber-200/70">
                <span>
                  Criação: {offerCount}× {OFFER_TAX_PERCENT}%{offerCapped ? ` (teto ${OFFER_TAX_CAP_KK}kk/oferta)` : ""}
                  {offerCount > 0 && vendaKk > 0 ? ` — ${formatKkValue(preview.offerPerKk, "kk")}/oferta` : ""}
                </span>
                <span className="font-bold text-amber-200">−{formatKkValue(preview.offerTotalKk, "kk")}</span>
              </div>
              <div className="flex items-center justify-between gap-2 text-amber-200/70">
                <span>Venda concluída: {SALE_TAX_PERCENT}% (1×){saleCapped ? ` (teto ${SALE_TAX_CAP_KK}kk)` : ""}</span>
                <span className="font-bold text-amber-200">−{formatKkValue(preview.saleTaxKk, "kk")}</span>
              </div>
              <div className="flex items-center justify-between gap-2 border-t border-amber-500/20 pt-0.5 text-amber-300">
                <span className="font-bold">Taxa total</span>
                <span className="font-black">−{formatKkValue(preview.taxKk, "kk")}</span>
              </div>
            </div>
          </div>

          {/* Resultado */}
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/[0.07] px-3 py-2.5">
            <div className="flex items-center justify-between text-[10px] text-slate-400">
              <span>Valor líquido (venda − taxas)</span>
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
