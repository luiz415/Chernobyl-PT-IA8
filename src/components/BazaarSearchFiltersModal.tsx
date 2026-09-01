import { Filter, Server, ShieldCheck, Swords, X } from "lucide-react";

type QuestFilter = "all" | "available" | "completed";
type ServerSelectionMode = "all" | "custom";
type VocationLevelFilters = Record<string, { min: string; max: string }>;

interface BazaarSearchFiltersModalProps {
  isOpen: boolean;
  onClose: () => void;
  vocations: string[];
  vocationLevels: VocationLevelFilters;
  onVocationLevelChange: (vocation: string, key: "min" | "max", value: string) => void;
  serverOptions: string[];
  serverSelectionMode: ServerSelectionMode;
  selectedServers: string[];
  onServerSelectionModeChange: (mode: ServerSelectionMode) => void;
  onSelectedServersChange: (servers: string[]) => void;
  maxValue: string;
  onMaxValueChange: (value: string) => void;
  soulwarFilter: QuestFilter;
  onSoulwarFilterChange: (value: QuestFilter) => void;
  sanguineFilter: QuestFilter;
  onSanguineFilterChange: (value: QuestFilter) => void;
  endUntil: string;
  onEndUntilChange: (value: string) => void;
  /** "manual" usa a data fixa; "automatico" calcula sempre o próximo dia. */
  endUntilMode: "manual" | "automatico";
  onEndUntilModeChange: (value: "manual" | "automatico") => void;
  /** Horário "HH:MM" usado pelo modo automático. */
  endUntilAutoTime: string;
  onEndUntilAutoTimeChange: (value: string) => void;
  /** Prévia já formatada da data que o modo automático usaria agora. */
  autoEndUntilPreview: string;
}

function getVocationAbbreviation(vocation: string): string {
  const normalized = vocation.trim().toLowerCase();
  if (normalized === "elder druid" || normalized === "druid") return "ED";
  if (normalized === "elite knight" || normalized === "knight") return "EK";
  if (normalized === "master sorcerer" || normalized === "sorcerer") return "MS";
  if (normalized === "royal paladin" || normalized === "paladin") return "RP";
  if (normalized === "exalted monk" || normalized === "monk") return "MK";
  return vocation;
}

export default function BazaarSearchFiltersModal({
  isOpen,
  onClose,
  vocations,
  vocationLevels,
  onVocationLevelChange,
  serverOptions,
  serverSelectionMode,
  selectedServers,
  onServerSelectionModeChange,
  onSelectedServersChange,
  maxValue,
  onMaxValueChange,
  soulwarFilter,
  onSoulwarFilterChange,
  sanguineFilter,
  onSanguineFilterChange,
  endUntil,
  onEndUntilChange,
  endUntilMode,
  onEndUntilModeChange,
  endUntilAutoTime,
  onEndUntilAutoTimeChange,
  autoEndUntilPreview,
}: BazaarSearchFiltersModalProps) {
  if (!isOpen) return null;

  const sortedServers = [...serverOptions].sort((a, b) => a.localeCompare(b, "pt-BR"));
  const selectedSet = new Set(selectedServers);

  function toggleServer(server: string) {
    onServerSelectionModeChange("custom");
    if (selectedSet.has(server)) {
      onSelectedServersChange(selectedServers.filter(item => item !== server));
    } else {
      onSelectedServersChange([...selectedServers, server]);
    }
  }

  function selectAllServers() {
    onServerSelectionModeChange("all");
    onSelectedServersChange([]);
  }

  function clearServers() {
    onServerSelectionModeChange("custom");
    onSelectedServersChange([]);
  }

  return (
    <div className="app-modal-overlay fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="app-modal-frame app-modal-size-wide app-modal-frame--scroll w-full max-w-5xl rounded-2xl border border-[var(--th-line)]/80 bg-[var(--th-n-raised)] shadow-2xl shadow-black/60">
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-[var(--th-line)]/70 bg-[var(--th-bg-base)]">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl border border-amber-600/30 bg-amber-500/10 flex items-center justify-center">
              <Filter size={18} className="text-amber-300" />
            </div>
            <div className="min-w-0">
              <h3 className="text-base font-black text-amber-200">Filtros da consulta</h3>
              <p className="text-[11px] text-slate-500">Aplicados antes de consultar personagens e quests. Não filtram a tabela depois da busca.</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="p-2 rounded-lg border border-white/10 bg-white/5 text-slate-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer">
            <X size={16} />
          </button>
        </div>

        <div className="app-modal-body custom-scrollbar p-4 sm:p-5 space-y-5">
          <section className="rounded-xl border border-[var(--th-line)]/70 bg-black/20 p-4 space-y-3">
            <div className="flex items-center gap-2 text-xs font-black text-amber-300 uppercase tracking-wide">
              <Swords size={14} /> Vocações e level
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2">
              {vocations.map(vocation => (
                <div key={vocation} className="rounded-lg border border-[var(--th-line)]/50 bg-black/25 px-3 py-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-black text-slate-300 truncate">{vocation}</span>
                    <span className="px-1.5 py-0.5 rounded border border-amber-500/20 bg-amber-500/10 text-[9px] text-amber-300 font-mono">{getVocationAbbreviation(vocation)}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <input value={vocationLevels[vocation]?.min || ""} onChange={event => onVocationLevelChange(vocation, "min", event.target.value)} placeholder="Min" className="rounded border border-[var(--th-line)]/60 bg-black/35 px-2 py-1 text-[10px] text-white outline-none focus:border-amber-600/60" />
                    <input value={vocationLevels[vocation]?.max || ""} onChange={event => onVocationLevelChange(vocation, "max", event.target.value)} placeholder="Max" className="rounded border border-[var(--th-line)]/60 bg-black/35 px-2 py-1 text-[10px] text-white outline-none focus:border-amber-600/60" />
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-xl border border-[var(--th-line)]/70 bg-black/20 p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-black text-amber-300 uppercase tracking-wide">
                <Server size={14} /> Servidores
              </div>
              <div className="flex items-center gap-2">
                <button type="button" onClick={selectAllServers} className="px-2 py-1 rounded border border-emerald-500/20 bg-emerald-500/10 text-[10px] text-emerald-300 hover:bg-emerald-500/20 cursor-pointer">Marcar todos</button>
                <button type="button" onClick={clearServers} className="px-2 py-1 rounded border border-rose-500/20 bg-rose-500/10 text-[10px] text-rose-300 hover:bg-rose-500/20 cursor-pointer">Desmarcar todos</button>
              </div>
            </div>

            {sortedServers.length === 0 ? (
              <div className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-slate-500">A lista de servidores será preenchida após a primeira consulta do Bazaar.</div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2">
                {sortedServers.map(server => {
                  const checked = serverSelectionMode === "all" || selectedSet.has(server);
                  return (
                    <label key={server} className={`flex items-center gap-2 rounded-lg border px-2 py-2 text-xs cursor-pointer transition-colors ${checked ? "border-amber-500/30 bg-amber-500/10 text-amber-200" : "border-white/10 bg-white/5 text-slate-500 hover:text-slate-300"}`}>
                      <input type="checkbox" checked={checked} onChange={() => toggleServer(server)} className="accent-amber-500" />
                      <span className="truncate">{server}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </section>

          <section className="rounded-xl border border-[var(--th-line)]/70 bg-black/20 p-4 space-y-3">
            <div className="flex items-center gap-2 text-xs font-black text-amber-300 uppercase tracking-wide">
              <ShieldCheck size={14} /> Regras da consulta
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
              <label className="space-y-1">
                <span className="text-[10px] text-slate-500 uppercase tracking-wide">Valor máximo (coins)</span>
                <input value={maxValue} onChange={event => onMaxValueChange(event.target.value.replace(/\D/g, ""))} placeholder="Coins máx" className="w-full rounded-lg border border-[var(--th-line)]/70 bg-black/35 px-3 py-2 text-xs text-white outline-none focus:border-amber-600/60" />
              </label>

              <label className="space-y-1">
                <span className="text-[10px] text-slate-500 uppercase tracking-wide">Soul War</span>
                <select value={soulwarFilter} onChange={event => onSoulwarFilterChange(event.target.value as QuestFilter)} className="w-full rounded-lg border border-[var(--th-line)]/70 bg-black/35 px-3 py-2 text-xs text-white outline-none focus:border-amber-600/60">
                  <option value="available">Disponível</option>
                  <option value="completed">Concluída</option>
                  <option value="all">Todas</option>
                </select>
              </label>

              <label className="space-y-1">
                <span className="text-[10px] text-slate-500 uppercase tracking-wide">Sanguine</span>
                <select value={sanguineFilter} onChange={event => onSanguineFilterChange(event.target.value as QuestFilter)} className="w-full rounded-lg border border-[var(--th-line)]/70 bg-black/35 px-3 py-2 text-xs text-white outline-none focus:border-amber-600/60">
                  <option value="available">Disponível</option>
                  <option value="completed">Concluída</option>
                  <option value="all">Todas</option>
                </select>
              </label>

              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] text-slate-500 uppercase tracking-wide">Encerra até</span>
                  {/* Alternador compacto Manual / Automático. Manual é o padrão
                      e preserva exatamente o campo de data original. */}
                  <div className="flex items-center gap-0.5 rounded-md border border-[var(--th-line)]/60 bg-black/30 p-0.5">
                    {([
                      { key: "manual" as const, label: "Manual" },
                      { key: "automatico" as const, label: "Auto" },
                    ]).map(option => (
                      <button
                        key={option.key}
                        type="button"
                        onClick={() => onEndUntilModeChange(option.key)}
                        className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide transition-colors cursor-pointer ${
                          endUntilMode === option.key
                            ? "bg-amber-600/80 text-black"
                            : "text-slate-400 hover:text-slate-200"
                        }`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>

                {endUntilMode === "manual" ? (
                  <input type="datetime-local" value={endUntil} onChange={event => onEndUntilChange(event.target.value)} className="w-full rounded-lg border border-[var(--th-line)]/70 bg-black/35 px-3 py-2 text-xs text-white outline-none focus:border-amber-600/60 [color-scheme:dark]" />
                ) : (
                  <>
                    <input type="time" value={endUntilAutoTime} onChange={event => onEndUntilAutoTimeChange(event.target.value)} className="w-full rounded-lg border border-[var(--th-line)]/70 bg-black/35 px-3 py-2 text-xs text-white outline-none focus:border-amber-600/60 [color-scheme:dark]" />
                    <p className="text-[9px] leading-snug text-amber-300/80">
                      Automático: próximo dia às {endUntilAutoTime}
                    </p>
                    <p className="text-[9px] leading-snug text-slate-500">
                      Próxima consulta: até {autoEndUntilPreview}
                    </p>
                  </>
                )}
              </div>
            </div>
          </section>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-[var(--th-line)]/70 bg-[var(--th-bg-base)]">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-xl bg-gradient-to-r from-amber-700/80 to-amber-600/80 hover:from-amber-600 hover:to-amber-500 border border-amber-500/40 text-black text-xs font-black transition-all cursor-pointer">
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
}