import { Filter, X } from "lucide-react";

interface BazaarUsedFiltersModalProps {
  isOpen: boolean;
  onClose: () => void;
  filters?: Record<string, any> | null;
}

function formatQuest(value?: string) {
  if (value === "available") return "Disponível";
  if (value === "completed") return "Concluída";
  return "Todas";
}

export default function BazaarUsedFiltersModal({ isOpen, onClose, filters }: BazaarUsedFiltersModalProps) {
  if (!isOpen) return null;
  const vocationLevels = filters?.vocationLevels || {};
  const selectedServers = Array.isArray(filters?.selectedServers) ? filters.selectedServers : [];

  return (
    <div className="app-modal-overlay fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="app-modal-frame app-modal-size-lg app-modal-frame--scroll w-full max-w-3xl rounded-2xl border border-[var(--th-line)]/80 bg-[var(--th-n-raised)] shadow-2xl shadow-black/60">
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-[var(--th-line)]/70 bg-[var(--th-bg-base)]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl border border-amber-600/30 bg-amber-500/10 flex items-center justify-center">
              <Filter size={18} className="text-amber-300" />
            </div>
            <div>
              <h3 className="text-base font-black text-amber-200">Filtros Usados</h3>
              <p className="text-[11px] text-slate-500">Critérios oficiais usados pelo Boss na geração desta lista.</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="p-2 rounded-lg border border-white/10 bg-white/5 text-slate-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer">
            <X size={16} />
          </button>
        </div>

        <div className="app-modal-body custom-scrollbar p-4 sm:p-5 space-y-4 text-xs">
          {!filters ? (
            <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-6 text-center text-slate-400">Nenhum filtro oficial foi encontrado na metadata local.</div>
          ) : (
            <>
              <section className="rounded-xl border border-[var(--th-line)]/70 bg-black/20 p-4 space-y-2">
                <div className="text-[10px] font-black uppercase tracking-wide text-amber-300">Servidores</div>
                <div className="text-slate-300">{filters.serverSelectionMode === "custom" ? (selectedServers.join(", ") || "Nenhum selecionado") : "Todos os servidores"}</div>
              </section>

              <section className="rounded-xl border border-[var(--th-line)]/70 bg-black/20 p-4 space-y-2">
                <div className="text-[10px] font-black uppercase tracking-wide text-amber-300">Níveis por vocação</div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2">
                  {Object.entries(vocationLevels).map(([vocation, rule]: any) => (
                    <div key={vocation} className="rounded-lg border border-white/10 bg-white/[0.03] p-2">
                      <div className="text-slate-300 font-bold truncate">{vocation}</div>
                      <div className="text-[11px] text-slate-500 font-mono">Min: {rule?.min || "—"}</div>
                      <div className="text-[11px] text-slate-500 font-mono">Max: {rule?.max || "—"}</div>
                    </div>
                  ))}
                </div>
              </section>

              <section className="rounded-xl border border-[var(--th-line)]/70 bg-black/20 p-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div><span className="text-slate-500">Valor máximo:</span> <span className="text-slate-200 font-mono">{filters.maxValue || "—"}</span></div>
                <div><span className="text-slate-500">Encerra até:</span> <span className="text-slate-200 font-mono">{filters.endUntil || "—"}</span></div>
                <div><span className="text-slate-500">Soul War:</span> <span className="text-slate-200">{formatQuest(filters.soulwarFilter)}</span></div>
                <div><span className="text-slate-500">Sanguine:</span> <span className="text-slate-200">{formatQuest(filters.sanguineFilter)}</span></div>
                <div><span className="text-slate-500">Fuso:</span> <span className="text-slate-200 font-mono">UTC{Number(filters.timezoneOffsetMinutes || 0) >= 0 ? "+" : ""}{Number(filters.timezoneOffsetMinutes || 0) / 60}</span></div>
              </section>
            </>
          )}
        </div>

        <div className="flex items-center justify-end px-5 py-4 border-t border-[var(--th-line)]/70 bg-[var(--th-bg-base)]">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-xl bg-gradient-to-r from-amber-700/80 to-amber-600/80 hover:from-amber-600 hover:to-amber-500 border border-amber-500/40 text-black text-xs font-black transition-all cursor-pointer">Fechar</button>
        </div>
      </div>
    </div>
  );
}