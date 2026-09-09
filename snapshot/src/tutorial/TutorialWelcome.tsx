// ============================================================================
// TUTORIAL — MODAL DE BOAS-VINDAS (abre automaticamente no login)
// ----------------------------------------------------------------------------
// Recomenda o tutorial interativo assim que o usuário entra no aplicativo.
// A caixa "Nunca mais exibir essa mensagem" grava uma flag local por usuário
// (tutorial_welcome_dismissed_{uid}) — marcada, o modal deixa de abrir
// automaticamente; o tutorial continua acessível pelo botão do rodapé.
// ============================================================================
import { useState } from "react";
import { createPortal } from "react-dom";
import { GraduationCap, Play, X } from "lucide-react";
import { useTutorial } from "./TutorialContext";

export default function TutorialWelcome() {
  const { welcomeOpen, dismissWelcome, openMenu } = useTutorial();
  const [neverAgain, setNeverAgain] = useState(false);
  if (!welcomeOpen) return null;

  return createPortal(
    <div className="fixed inset-0 flex items-center justify-center bg-black/80 backdrop-blur-sm p-3" style={{ zIndex: 9400 }}>
      <div className="w-full max-w-md bg-[var(--th-bg-raised,#0d1117)] border border-amber-500/30 rounded-2xl shadow-[0_0_40px_color-mix(in_oklab,var(--color-amber-500)_18%,transparent)] overflow-hidden">
        {/* Cabeçalho */}
        <div className="flex items-start gap-3 px-4 pt-4 pb-3">
          <div className="w-11 h-11 rounded-xl border border-amber-500/40 bg-amber-500/10 flex items-center justify-center flex-shrink-0">
            <GraduationCap size={22} className="text-amber-400" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-black text-white tracking-wide">Conheça o Tutorial Interativo!</h2>
            <p className="text-[11px] text-slate-400 leading-relaxed mt-1">
              Aprenda a usar <span className="text-amber-300 font-bold">todas as funcionalidades</span> do
              aplicativo com um guia passo a passo que destaca os elementos{" "}
              <span className="text-emerald-300 font-bold">na própria interface</span> — organizado por
              painéis, no seu ritmo, com progresso salvo.
            </p>
          </div>
          <button
            type="button"
            onClick={() => dismissWelcome(neverAgain)}
            className="p-1.5 rounded-lg text-slate-500 hover:text-white hover:bg-white/10 transition-colors cursor-pointer flex-shrink-0"
            title="Fechar"
          >
            <X size={15} />
          </button>
        </div>

        {/* Dica de acesso permanente */}
        <div className="mx-4 mb-3 px-3 py-2 rounded-lg border border-white/8 bg-white/[0.03] text-[10px] text-slate-400 leading-relaxed">
          💡 Você pode abrir o tutorial quando quiser pelo botão{" "}
          <span className="text-amber-300 font-bold">🎓 Tutorial</span> no rodapé do aplicativo.
        </div>

        {/* Ações */}
        <div className="px-4 pb-4 flex flex-col gap-2.5">
          <button
            type="button"
            onClick={() => { dismissWelcome(neverAgain); openMenu(); }}
            className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl border border-amber-500/50 bg-gradient-to-r from-amber-600/25 to-amber-500/15 hover:from-amber-600/35 hover:to-amber-500/25 text-amber-200 text-[12px] font-black transition-all cursor-pointer"
          >
            <Play size={13} /> Abrir o Tutorial
          </button>
          <div className="flex items-center justify-between gap-2">
            <label className="inline-flex items-center gap-1.5 text-[10px] text-slate-500 hover:text-slate-300 cursor-pointer select-none transition-colors">
              <input
                type="checkbox"
                checked={neverAgain}
                onChange={e => setNeverAgain(e.target.checked)}
                className="w-3.5 h-3.5 rounded border-white/20 bg-white/5 accent-amber-500 cursor-pointer"
              />
              Nunca mais exibir essa mensagem
            </label>
            <button
              type="button"
              onClick={() => dismissWelcome(neverAgain)}
              className="px-3 py-1.5 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white text-[10px] font-bold transition-colors cursor-pointer"
            >
              Agora não
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
