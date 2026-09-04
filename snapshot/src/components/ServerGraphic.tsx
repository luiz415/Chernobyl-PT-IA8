import { useMemo } from "react";
import { Swords, X } from "lucide-react";
import type { Character, WaitingService } from "../types";
import { serverKey, serverLabel } from "../constants/servers";
export default function ServersPyramidChart({ availableChars, waitingItems, selectedSet, activeServer, onServerClick, partyServer }: {
  availableChars: Character[];
  waitingItems: WaitingService[];
  selectedSet: Set<string>;
  /** Servidor atualmente FILTRADO pelo usuário (clique no gráfico). */
  activeServer?: string;
  onServerClick?: (srv: string) => void;
  /**
   * Servidor da PT selecionada. Recebe um destaque próprio (apenas visual),
   * independente do filtro. Antes existia uma prop `locked` que bloqueava o
   * clique em TODOS os servidores quando a PT tinha servidor definido — o que
   * impedia comparar a PT com os demais. Agora o destaque é só indicativo e
   * todos os servidores continuam selecionáveis.
   */
  partyServer?: string;
}) {
  const data = useMemo(() => {
    // Conta por chave canônica: "Grimoria 1"/"grimoria i" somam em
    // "Grimoria I", e cada Grimoria permanece uma barra independente.
    const counts: Record<string, number> = {};
    const add = (value: string | undefined) => {
      const label = serverLabel(value) || "Desconhecido";
      counts[label] = (counts[label] || 0) + 1;
    };
    availableChars.forEach(c => add(c.servidor));
    waitingItems.forEach(w => { if (selectedSet.has(w.id)) return; add(w.servidor); });
    return Object.keys(counts).filter(srv => srv !== "Desconhecido").map(srv => ({ srv, count: counts[srv] })).sort((a, b) => b.count - a.count);
  }, [availableChars, waitingItems, selectedSet]);
  const maxCount = data.length > 0 ? data[0].count : 1;
  const colors = ["from-emerald-500 to-teal-400","from-teal-500 to-cyan-400","from-cyan-500 to-sky-400","from-sky-500 to-blue-400","from-blue-500 to-indigo-400","from-indigo-500 to-violet-400"];
  return (
    <div className="h-full w-full bg-[var(--th-bg-base)] border border-[var(--th-brand-mid)]/40 rounded-xl p-2.5 flex flex-col items-center select-none overflow-hidden" onWheel={e => e.stopPropagation()}>
      <div className="text-[10px] font-bold uppercase tracking-wider text-amber-600 mb-0.5 text-center truncate w-full">Oportunidade por Servidor</div>
      <div className="text-[9px] text-slate-500 text-center mb-3">Soma (Disponíveis + Espera) • Clique para filtrar</div>
      {data.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-slate-600 text-[10px] italic">Nenhum dado</div>
      ) : (
        <div className="w-full flex flex-col items-center gap-1.5 overflow-y-auto pr-1 flex-1">
          {data.map((item, idx) => {
            const pct = Math.max(12, Math.round((item.count / maxCount) * 100));
            const itemKey = serverKey(item.srv);
            const isActive = !!activeServer && serverKey(activeServer) === itemKey;
            const isPartyServer = !!partyServer && serverKey(partyServer) === itemKey;
            // ── INTENSIDADE PROPORCIONAL À QUANTIDADE ──────────────────────
            // A cor de cada barra "esmaece" conforme o servidor tem MENOS
            // personagens: razão count/maxCount (recalculada a cada mudança
            // dos dados, pois `data`/`maxCount` vêm do useMemo) modula
            // opacidade e saturação da MESMA cor já usada — servidor no topo
            // fica vivo/intenso, servidores com poucos personagens ficam
            // suaves/neutros, num degradê contínuo. Pisos altos (0.45/0.55)
            // mantêm a leitura elegante, sem barra "apagada".
            // Estados destacados (filtro ativo/servidor da PT) permanecem em
            // intensidade total — o destaque continua tendo prioridade visual.
            const intensity = maxCount > 0 ? item.count / maxCount : 1;
            const barIntensityStyle = (isActive || isPartyServer)
              ? undefined
              : { opacity: 0.45 + 0.55 * intensity, filter: `saturate(${(0.55 + 0.45 * intensity).toFixed(3)})` };
            return (
              <div key={item.srv} className="w-full flex flex-col items-center group">
                <button
                  type="button"
                  onClick={() => onServerClick?.(item.srv)}
                  title={
                    isActive
                      ? `Remover filtro do servidor ${item.srv}`
                      : isPartyServer
                        ? `Servidor da PT selecionada — clique para filtrar por ${item.srv}`
                        : `Filtrar pelo servidor ${item.srv}`
                  }
                  className={`flex items-center gap-1 text-[10px] font-semibold leading-tight px-1.5 py-0.5 rounded transition-all cursor-pointer border ${
                    isActive
                      ? "bg-amber-500/20 border-amber-500/50 text-amber-200 shadow-sm shadow-amber-500/20"
                      : isPartyServer
                        ? "bg-sky-500/10 border-sky-500/40 text-sky-200 shadow-sm shadow-sky-500/10 hover:bg-sky-500/20"
                        : "bg-transparent border-transparent text-slate-300 hover:bg-white/5 hover:border-white/10 hover:text-white"
                  }`}
                >
                  {isPartyServer && !isActive && <Swords size={8} className="text-sky-300 flex-shrink-0" />}
                  <span>{item.srv}</span>
                  <span className={`font-bold font-mono ${isActive ? "text-amber-300" : isPartyServer ? "text-sky-300" : "text-emerald-400"}`}>({item.count})</span>
                  {isActive && <X size={9} className="text-amber-300 ml-0.5" />}
                </button>
                <div className={`w-full bg-black/40 h-2.5 rounded-full overflow-hidden flex items-center justify-center p-0.5 border ${isActive ? "border-amber-500/40" : isPartyServer ? "border-sky-500/30" : "border-white/5"} mt-0.5 shadow-inner`}>
                  <div className={`h-full rounded-full bg-gradient-to-r ${isActive ? "from-amber-500 to-amber-300" : isPartyServer ? "from-sky-500 to-sky-300" : colors[idx % colors.length]} transition-all duration-500 shadow-sm`} style={{ width: `${pct}%`, ...barIntensityStyle }} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}