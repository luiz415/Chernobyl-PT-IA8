// ============================================================================
// TUTORIAL — MENU DE TÓPICOS
// ----------------------------------------------------------------------------
// Modal (portal, mesmo padrão visual dos demais modais do app) com a lista de
// tópicos disponíveis para o papel do usuário, o progresso individual de cada
// um (concluído / em andamento / não iniciado) e o botão "Tutorial Completo".
// Clicar num tópico inicia o tour daquele painel; tópicos em andamento
// retomam da última cena visitada.
// ============================================================================
import { createPortal } from "react-dom";
import { Check, ChevronRight, GraduationCap, Play, RotateCcw, X } from "lucide-react";
import { useTutorial } from "./TutorialContext";
import type { TourTone } from "./types";

const TONE_ROW: Record<TourTone, { icon: string; bar: string; hover: string }> = {
  emerald: { icon: "text-emerald-400", bar: "bg-emerald-500", hover: "hover:border-emerald-500/50 hover:bg-emerald-500/[0.06]" },
  violet: { icon: "text-violet-400", bar: "bg-violet-500", hover: "hover:border-violet-500/50 hover:bg-violet-500/[0.06]" },
  sky: { icon: "text-sky-400", bar: "bg-sky-500", hover: "hover:border-sky-500/50 hover:bg-sky-500/[0.06]" },
  amber: { icon: "text-amber-400", bar: "bg-amber-500", hover: "hover:border-amber-500/50 hover:bg-amber-500/[0.06]" },
  rose: { icon: "text-rose-400", bar: "bg-rose-500", hover: "hover:border-rose-500/50 hover:bg-rose-500/[0.06]" },
};

export default function TutorialMenu() {
  const { menuOpen, closeMenu, topics, progress, startTopic, startFullTour, resetProgress } = useTutorial();
  if (!menuOpen) return null;

  const completedCount = topics.filter(t => progress[t.id]?.completed).length;
  const overallPct = topics.length > 0 ? Math.round((completedCount / topics.length) * 100) : 0;

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/80 backdrop-blur-sm p-3"
      style={{ zIndex: 9500 }}
      onMouseDown={e => { if (e.target === e.currentTarget) closeMenu(); }}
    >
      <div className="w-full max-w-lg bg-[var(--th-bg-raised,#0d1117)] border border-white/12 rounded-2xl shadow-2xl flex flex-col overflow-hidden" style={{ maxHeight: "84vh" }}>
        {/* Cabeçalho */}
        <div className="flex items-center gap-2.5 px-4 pt-3.5 pb-3 border-b border-white/8 flex-shrink-0">
          <div className="w-9 h-9 rounded-xl border border-amber-500/40 bg-amber-500/10 flex items-center justify-center flex-shrink-0">
            <GraduationCap size={18} className="text-amber-400" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-black text-white tracking-wide">Tutorial Interativo</h2>
            <p className="text-[10px] text-slate-500">Escolha um tópico ou percorra o tutorial completo.</p>
          </div>
          <button type="button" onClick={closeMenu} className="ml-auto p-1.5 rounded-lg text-slate-500 hover:text-white hover:bg-white/10 transition-colors cursor-pointer" title="Fechar">
            <X size={15} />
          </button>
        </div>

        {/* Progresso geral */}
        <div className="px-4 py-2.5 border-b border-white/8 flex items-center gap-3 flex-shrink-0">
          <div className="flex-1 h-1.5 bg-white/8 rounded-full overflow-hidden">
            <div className="h-full bg-gradient-to-r from-amber-500 to-emerald-500 rounded-full transition-all duration-500" style={{ width: `${overallPct}%` }} />
          </div>
          <span className="text-[10px] font-bold text-slate-400 whitespace-nowrap">{completedCount}/{topics.length} concluídos</span>
          {completedCount > 0 && (
            <button type="button" onClick={resetProgress} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border border-white/10 bg-white/5 hover:bg-white/10 text-slate-500 hover:text-slate-300 text-[9px] font-bold transition-colors cursor-pointer" title="Zerar o progresso do tutorial">
              <RotateCcw size={9} /> Zerar
            </button>
          )}
        </div>

        {/* Lista de tópicos */}
        <div className="flex-1 min-h-0 overflow-y-auto p-2.5 flex flex-col gap-1.5">
          {topics.map((topic, idx) => {
            const prog = progress[topic.id];
            const tone = TONE_ROW[topic.tone];
            const inProgress = prog && !prog.completed && prog.lastScene > 0;
            const resumeFrom = inProgress ? prog.lastScene : 0;
            return (
              <button
                key={topic.id}
                type="button"
                onClick={() => startTopic(topic.id, resumeFrom)}
                className={`group text-left flex items-center gap-2.5 px-3 py-2 rounded-xl border border-white/8 bg-white/[0.02] transition-all cursor-pointer ${tone.hover}`}
                title={prog?.completed ? "Rever tópico" : inProgress ? `Retomar da cena ${resumeFrom + 1}` : "Iniciar tópico"}
              >
                <span className="text-[9px] font-black text-slate-600 w-4 text-right flex-shrink-0">{idx + 1}</span>
                <topic.icon size={15} className={`flex-shrink-0 ${tone.icon}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] font-black text-white truncate">{topic.title}</span>
                    {topic.bossOnly && (
                      <span className="text-[8px] font-black px-1 py-px rounded border border-violet-500/30 bg-violet-500/10 text-violet-300 uppercase flex-shrink-0">Boss</span>
                    )}
                  </div>
                  <p className="text-[9px] text-slate-500 truncate">{topic.description}</p>
                  {inProgress && (
                    <div className="mt-1 h-0.5 bg-white/8 rounded-full overflow-hidden max-w-[140px]">
                      <div className={`h-full rounded-full ${tone.bar}`} style={{ width: `${Math.round(((prog.lastScene + 1) / topic.scenes.length) * 100)}%` }} />
                    </div>
                  )}
                </div>
                <span className="text-[9px] text-slate-600 font-bold flex-shrink-0">{topic.scenes.length} cenas</span>
                {prog?.completed ? (
                  <span className="w-5 h-5 rounded-full bg-emerald-500/15 border border-emerald-500/40 flex items-center justify-center flex-shrink-0" title="Tópico concluído">
                    <Check size={11} className="text-emerald-400" />
                  </span>
                ) : (
                  <ChevronRight size={13} className="text-slate-600 group-hover:text-slate-300 transition-colors flex-shrink-0" />
                )}
              </button>
            );
          })}
        </div>

        {/* Rodapé: Tutorial Completo */}
        <div className="px-3 py-2.5 border-t border-white/8 flex-shrink-0">
          <button
            type="button"
            onClick={startFullTour}
            className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl border border-amber-500/50 bg-gradient-to-r from-amber-600/25 to-amber-500/15 hover:from-amber-600/35 hover:to-amber-500/25 text-amber-200 text-[11px] font-black transition-all cursor-pointer"
            title="Percorrer todos os tópicos em sequência"
          >
            <Play size={12} /> Tutorial Completo ({topics.length} tópicos)
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
