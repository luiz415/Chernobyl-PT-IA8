import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Coins, X } from "lucide-react";
import type { SharedService } from "../types";

// ============================================================================
// MODAL DE VALOR PENDENTE
//
// Aberto ao concluir um Service cuja coluna VALOR está vazia — o caso de
// PIX e 50/50, que não preenchem valor automaticamente. Exibe apenas o
// mínimo para identificar o registro e o campo de valor em destaque.
//
// Cancelar NÃO conclui e NÃO altera nenhum dado.
// ============================================================================

interface Props {
  service: SharedService | null;
  onConfirm: (valor: number) => void;
  onCancel: () => void;
}

export default function ServiceValueModal({ service, onConfirm, onCancel }: Props) {
  const [valor, setValor] = useState(0);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!service) return;
    setValor(0);
    setError("");
    const timer = window.setTimeout(() => inputRef.current?.focus(), 80);
    return () => window.clearTimeout(timer);
  }, [service]);

  useEffect(() => {
    if (!service) return;
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [service, onCancel]);

  if (!service) return null;

  function handleConfirm() {
    if (!Number.isFinite(valor) || valor <= 0) {
      setError("Informe um valor válido para concluir.");
      return;
    }
    onConfirm(valor);
  }

  // PORTAL: o painel vive dentro de um container com CSS `zoom`, que quebra
  // o hit-testing de elementos `position: fixed` — cliques caem no elemento
  // errado e os campos nunca recebem foco. Renderizar em document.body
  // escapa do zoom, mesmo padrão já usado por CharTable e FilterTypes.
  return createPortal(
    <div
      // Acima do MyServiceModal (z-[1000]) para poder abrir sobre ele.
      className="app-modal-overlay fixed inset-0 z-[1100] flex items-center justify-center bg-black/85 backdrop-blur-sm"
      onMouseDown={event => { if (event.target === event.currentTarget) onCancel(); }}
    >
      <div className="app-modal-frame app-modal-size-xs app-modal-frame--scroll relative w-full max-w-sm bg-[var(--th-bg-base)] border border-[var(--th-line)]/100 rounded-xl shadow-2xl shadow-black/60">
        <div className="flex items-center justify-between px-4 py-2.5 bg-gradient-to-r from-[var(--th-bg-raised)] to-[var(--th-bg-base)] border-b border-[var(--th-line)]/60">
          <div className="flex items-center gap-2">
            <Coins size={14} className="text-emerald-400" />
            <h2 className="text-sm font-bold text-slate-100">Informe o valor</h2>
          </div>
          <button type="button" onClick={onCancel} className="text-slate-500 hover:text-slate-200 p-1 rounded-md hover:bg-white/[0.04] transition-colors cursor-pointer">
            <X size={16} />
          </button>
        </div>

        <div className="app-modal-body p-4 space-y-3">
          {/* Identificação mínima do registro */}
          <div className="rounded-lg border border-white/5 bg-white/[0.03] px-3 py-2 space-y-1 text-[11px]">
            <div className="flex items-baseline gap-2">
              <span className="text-slate-500 w-16 flex-shrink-0">Personagem</span>
              <span className="font-bold text-slate-200 truncate">{service.personagem || "—"}</span>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-slate-500 w-16 flex-shrink-0">Cliente</span>
              <span className="text-slate-300 truncate">{service.ownerName || <span className="italic text-slate-600">não informado</span>}</span>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-slate-500 w-16 flex-shrink-0">Servidor</span>
              <span className="text-slate-300 truncate">{service.servidor || "—"}</span>
            </div>
          </div>

          {/* Campo destacado */}
          <label className="block">
            <span className="block text-[9px] font-bold uppercase tracking-wider text-emerald-400/80 mb-1">Valor do Service (RC)</span>
            <input
              ref={inputRef}
              type="text"
              inputMode="numeric"
              value={valor === 0 ? "" : String(valor)}
              placeholder="0"
              onChange={e => {
                const cleaned = e.target.value.replace(/[^\d]/g, "");
                const parsed = parseInt(cleaned, 10);
                setValor(Number.isFinite(parsed) ? parsed : 0);
                if (error) setError("");
              }}
              onKeyDown={e => { if (e.key === "Enter") handleConfirm(); }}
              className="w-full px-3 py-2.5 bg-[var(--th-n-elev)] border border-emerald-500/30 rounded-lg text-center text-lg font-mono font-black text-emerald-300 placeholder-slate-700 focus:outline-none focus:border-emerald-400/70 transition-colors"
            />
          </label>

          {error && (
            <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-2.5 py-1.5 text-[11px] font-semibold text-rose-300">
              {error}
            </div>
          )}
        </div>

        <div className="app-modal-footer flex flex-wrap items-center justify-end gap-2 px-4 py-2.5 border-t border-[var(--th-line)]/60 bg-[var(--th-bg-raised)]">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 rounded-lg border border-white/10 bg-white/5 text-slate-300 hover:text-white hover:bg-white/10 text-[11px] font-bold transition-colors cursor-pointer"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            className="px-4 py-1.5 rounded-lg bg-gradient-to-r from-emerald-600/90 to-emerald-500/90 hover:from-emerald-500 hover:to-emerald-400 border border-emerald-400/50 text-white text-[11px] font-black transition-all cursor-pointer"
          >
            Confirmar e concluir
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}