import { useState, useEffect } from "react";
import { HeartHandshake, AlertTriangle } from "lucide-react";
import { formatRC } from "../types";

interface Props {
  open: boolean;
  onClose: () => void;
  onOpenDonation: () => void;
  averageRcPerPt: number;
  minAverage: number;
}

export default function AdviceDonationModal({ open, onClose, onOpenDonation, averageRcPerPt, minAverage }: Props) {
  const [checkboxChecked, setCheckboxChecked] = useState(false);

  // Reset checkbox when modal opens/closes
  useEffect(() => {
    setCheckboxChecked(false);
  }, [open]);

  if (!open) return null;

  return (
    <div className="app-modal-overlay fixed inset-0 z-[500] flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="app-modal-frame app-modal-size-md app-modal-frame--scroll bg-[var(--th-n-elev)] border border-amber-500/40 rounded-2xl shadow-[0_0_40px_color-mix(in_oklab,var(--color-amber-500)_30%,transparent)] w-full max-w-lg">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-amber-500/20 bg-gradient-to-r from-[var(--th-bg-raised)] to-[var(--th-n-elev)] flex-shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-amber-500/15 border border-amber-600/35 flex items-center justify-center shadow-[0_0_8px_color-mix(in_oklab,var(--color-amber-500)_12%,transparent)]">
              <AlertTriangle size={16} className="text-amber-400" />
            </div>
            <h3 className="text-base font-bold text-white tracking-wide uppercase">Aviso Importante</h3>
          </div>
        </div>

        {/* Content */}
        <div className="app-modal-body p-4 sm:p-5 space-y-4 custom-scrollbar">
          <div className="bg-[var(--th-bg-base)] border border-amber-500/30 rounded-xl p-4 text-center shadow-[0_0_15px_color-mix(in_oklab,var(--color-amber-500)_8%,transparent)]">
            <p className="text-sm font-bold text-slate-300 mb-1">Sua média atual é de:</p>
            <div className="text-2xl font-black text-emerald-400 font-mono drop-shadow-[0_0_8px_rgba(52,211,153,0.3)]">
              {formatRC(averageRcPerPt)} <span className="text-lg text-slate-500">/ PT</span>
            </div>
            <p className="text-[10px] text-amber-500 font-bold uppercase tracking-wider mt-2">
              Mínimo: {formatRC(minAverage)} / PT
            </p>
          </div>

          <div className="text-xs text-slate-300 leading-relaxed space-y-3">
            <p>
              O <strong className="text-amber-200">Chernobyl PT</strong> economiza seu tempo, organiza suas PT's, controla seus personagens, pagamentos, estatísticas e utiliza <strong className="text-violet-300">IA para sugerir automaticamente a melhor composição de PT</strong>. Tudo isso por uma contribuição que representa <strong className="text-emerald-400">menos de 0.5% do lucro médio de uma PT</strong>, ou seja, praticamente irrelevante.
            </p>

            <p>
              Sua doação ajuda a manter os servidores, a <strong className="text-sky-300">sincronização na nuvem</strong> e a evolução de recursos VIP como o <strong className="text-amber-200">Painel Bazaar</strong>, já disponível para consultar, filtrar e acompanhar personagens do Bazaar com mais praticidade.
            </p>

            <p className="text-rose-300 font-semibold border-l-2 border-rose-500/50 pl-3 py-1 bg-rose-500/5 rounded-r">
              Caso sua média continue abaixo do mínimo recomendado, <strong className="text-white">seu cadastro poderá ser bloqueado automaticamente</strong>, sendo necessário entrar em contato com a equipe do <strong className="text-amber-200">Chernobyl PT</strong> para solicitar a reativação da conta.
            </p>
          </div>

          {/* Checkbox */}
          <label className="flex items-start gap-2 p-3 rounded-lg bg-white/[0.02] border border-white/5 cursor-pointer hover:bg-white/[0.03] transition-colors">
            <input
              type="checkbox"
              checked={checkboxChecked}
              onChange={(e) => setCheckboxChecked(e.target.checked)}
              className="w-4 h-4 accent-amber-500 rounded mt-0.5 cursor-pointer appearance-none border border-white/20 bg-black/50 checked:bg-amber-500 checked:border-amber-400 checked:after:content-['✓'] checked:after:block checked:after:text-black checked:after:text-center checked:after:text-xs"
            />
            <span className="text-xs text-slate-300 leading-relaxed">
              Li e estou ciente que minha média de doação precisa aumentar.
            </span>
          </label>
        </div>

        {/* Footer with buttons */}
        <div className="app-modal-footer px-4 sm:px-5 py-3 border-t border-amber-500/20 bg-[var(--th-bg-raised)]/50 flex flex-wrap justify-end gap-2">
          <button
            onClick={onClose}
            disabled={!checkboxChecked}
            className="px-4 py-2 rounded-lg border border-[var(--th-line)]/80 text-slate-500 hover:text-white hover:bg-[var(--th-line)]/20 text-xs font-semibold transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Fechar
          </button>
          <button
            onClick={() => { onOpenDonation(); onClose(); }}
            disabled={!checkboxChecked}
            className="inline-flex items-center gap-1.5 px-5 py-2 rounded-lg bg-gradient-to-r from-[var(--th-brand-mid)] to-[var(--th-brand)] hover:from-[var(--th-brand-bright)] hover:to-[var(--th-line-strong)] text-white text-xs font-bold shadow-lg shadow-red-900/30 transition-all cursor-pointer border border-[var(--th-brand-mid)]/60 disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none"
          >
            <HeartHandshake size={13} /> Fazer Doação
          </button>
        </div>
      </div>
    </div>
  );
}