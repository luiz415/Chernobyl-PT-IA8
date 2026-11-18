import { useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { X, ScrollText, Server, CalendarClock, CheckCircle2, XCircle } from "lucide-react";
import type { Character } from "../types";
import { collectQuestRealizations } from "../utils/questStatusHistory";
import { QUEST_SIGLA, QUEST_BADGE_COLOR_CLASSES } from "../constants/questBadges";

// ============================================================================
// ÚLTIMAS QUESTS (102ª tarefa) — modal compacto de "Meus Personagens"
//
// Exibe as ÚLTIMAS QUESTS REALIZADAS pelos personagens da lista pessoal
// (servidor, personagem, quest, data/hora da conclusão e "Com drop"/"Sem
// drop"), da mais recente para a mais antiga. A fonte é ÚNICA e compartilhada
// com "Últimos Drops" e a guia Stats: `collectQuestRealizations`
// (utils/questStatusHistory) lê o histórico append-only do próprio
// personagem — o modal NÃO mantém histórico próprio nem grava nada.
//
// REGRA SANGUINE: cada ROTAÇÃO CONCLUÍDA (resposta "Drop?" Sim OU Não) é uma
// quest realizada — o drop não é garantido, então a linha distingue
// claramente "Com drop" de "Sem drop" e indica o número da rotação.
//
// Renderiza por portal em document.body (mesmo motivo documentado em
// ConfirmModal/SgCooldownModal: containers com CSS zoom quebram fixed).
// ============================================================================

/** Quantidade exibida — as realizações mais recentes (lista compacta). */
const SHOWN_LIMIT = 20;

/** Data/hora REAL da conclusão no formato dd/mm/aaaa hh:mm. */
function formatQuestDate(at: number): string {
  return new Date(at).toLocaleString("pt-BR", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

interface Props {
  /** Personagens da lista pessoal do usuário (ativos + vendidos). */
  characters: Character[];
  onClose: () => void;
}

export default function LastQuestsModal({ characters, onClose }: Props) {
  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  // Realizações já ordenadas da mais recente para a mais antiga (derivação
  // pura da fonte única — nada é gravado aqui).
  const realizations = useMemo(() => collectQuestRealizations(characters), [characters]);
  const shown = realizations.slice(0, SHOWN_LIMIT);

  return createPortal(
    <div
      className="app-modal-overlay fixed inset-0 z-[500] flex items-center justify-center bg-black/80 backdrop-blur-sm p-2 sm:p-4"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="app-modal-frame app-modal-size-md relative w-full flex flex-col max-h-[85vh] rounded-xl border border-[var(--th-line)]/100 bg-[var(--th-bg-base)] shadow-2xl shadow-black/60 overflow-hidden">

        <div className="flex-shrink-0 flex items-center justify-between px-4 py-2.5 bg-gradient-to-r from-[var(--th-bg-raised)] to-[var(--th-bg-base)] border-b border-[var(--th-line)]/60">
          <div className="flex items-center gap-2 min-w-0">
            <ScrollText size={14} className="text-amber-400 flex-shrink-0" />
            <h2 className="text-sm font-bold text-slate-100 truncate">Últimas Quests</h2>
            <span className="text-[9px] font-bold text-slate-500 uppercase tracking-wide">{SHOWN_LIMIT} mais recentes</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="Fechar (Esc)"
            className="text-slate-500 hover:text-slate-200 p-1 rounded-md hover:bg-white/[0.04] transition-colors cursor-pointer flex-shrink-0"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-2.5">
          {shown.length === 0 ? (
            <p className="text-[11px] text-slate-500 text-center py-6">
              Nenhuma quest realizada registrada ainda — conclusões de quest e
              rotações Sanguine passam a aparecer aqui com data e horário.
            </p>
          ) : (
            <ul className="divide-y divide-white/5">
              {shown.map((entry, index) => (
                <li key={`${entry.charId}:${entry.quest}:${entry.at}:${index}`} className="py-1.5 flex items-center gap-2 flex-wrap">
                  <span className={`text-[8px] font-black px-1 py-px rounded border uppercase tracking-wide flex-shrink-0 ${QUEST_BADGE_COLOR_CLASSES[entry.quest]}`}>
                    {QUEST_SIGLA[entry.quest]}
                  </span>
                  <span className="text-[11px] font-bold text-slate-200 truncate">{entry.character}</span>
                  {/* Rotação SG: concluída = quest realizada (com OU sem drop). */}
                  {entry.rot !== null && (
                    <span className="text-[8px] font-bold px-1 py-px rounded border border-white/10 bg-white/[0.03] text-slate-400 uppercase tracking-wide flex-shrink-0" title="Rotação Sanguine concluída (a rotação conta como quest realizada, com ou sem drop)">
                      Rot {entry.rot}
                    </span>
                  )}
                  <span
                    className={`inline-flex items-center gap-0.5 text-[8px] font-black px-1 py-px rounded border uppercase tracking-wide flex-shrink-0 ${
                      entry.withDrop
                        ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
                        : "border-slate-500/30 bg-slate-500/10 text-slate-400"
                    }`}
                    title={entry.withDrop ? (entry.item ? `Com drop: ${entry.item}` : "Com drop") : "Sem drop nesta realização"}
                  >
                    {entry.withDrop ? <CheckCircle2 size={8} /> : <XCircle size={8} />}
                    {entry.withDrop ? "Com drop" : "Sem drop"}
                  </span>
                  {entry.withDrop && entry.item && (
                    <span className="text-[10px] text-emerald-300/90 truncate">{entry.item}</span>
                  )}
                  <span className="inline-flex items-center gap-0.5 text-[9px] text-slate-500 flex-shrink-0">
                    <Server size={9} /> {entry.server || "—"}
                  </span>
                  <span className="inline-flex items-center gap-0.5 text-[9px] text-slate-500 tabular-nums ml-auto flex-shrink-0" title="Data e horário reais da conclusão">
                    <CalendarClock size={9} /> {formatQuestDate(entry.at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
