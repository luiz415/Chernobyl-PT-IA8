import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { X, Gem, Server, CalendarClock } from "lucide-react";
import type { Character, QuestStatusHistoryQuest } from "../types";
import { collectRecentDrops } from "../utils/questStatusHistory";
import { QUEST_SIGLA, QUEST_BADGE_COLOR_CLASSES } from "../constants/questBadges";

// ============================================================================
// ÚLTIMOS DROPS (102ª tarefa) — modal compacto de "Meus Personagens"
//
// Exibe os 5 DROPS MAIS RECENTES dos personagens da lista pessoal do usuário
// (servidor, personagem, data/hora, item e quest), do mais recente para o
// mais antigo. A fonte é ÚNICA e compartilhada com "Últimas Quests" e a guia
// Stats: `collectRecentDrops` (utils/questStatusHistory) lê o histórico
// `kind:"drop"` + os campos itemDropadoXX/At atuais (retrocompatibilidade,
// sem duplicação) — o modal NÃO mantém histórico próprio nem grava nada.
//
// Filtros por quest em CHECKBOXES INDEPENDENTES (SW/SG/GB — mesmo padrão dos
// filtros de categoria do "Itens à Venda"): várias podem estar marcadas ao
// mesmo tempo; desmarcada, somente os drops dela saem da lista; NENHUMA
// marcada = nenhum drop exibido. Os 5 exibidos são os 5 mais recentes DENTRE
// os que passam no filtro.
//
// Renderiza por portal em document.body (mesmo motivo documentado em
// ConfirmModal/SgCooldownModal: containers com CSS zoom quebram fixed).
// ============================================================================

const QUEST_FILTER_OPTIONS: Array<{ key: QuestStatusHistoryQuest; label: string; title: string; accent: string }> = [
  { key: "soulwar", label: "SW", title: "Exibir drops da Soul War", accent: "accent-slate-400" },
  { key: "sanguine", label: "SG", title: "Exibir drops da Sanguine", accent: "accent-red-700" },
  { key: "crypt", label: "GB", title: "Exibir drops da Graveborn (GB)", accent: "accent-lime-700" },
];

/** Data/hora REAL do drop no formato dd/mm/aaaa hh:mm. */
function formatDropDate(at: number): string {
  return new Date(at).toLocaleString("pt-BR", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

interface Props {
  /** Personagens da lista pessoal do usuário (ativos + vendidos). */
  characters: Character[];
  onClose: () => void;
}

export default function LastDropsModal({ characters, onClose }: Props) {
  // Filtros independentes — padrão: TODAS as quests marcadas.
  const [quests, setQuests] = useState<QuestStatusHistoryQuest[]>(["soulwar", "sanguine", "crypt"]);

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  // Todos os drops com data real, já ordenados do mais recente para o mais
  // antigo (derivação pura da fonte única — nada é gravado aqui).
  const allDrops = useMemo(() => collectRecentDrops(characters), [characters]);
  const shown = useMemo(
    () => allDrops.filter(drop => quests.includes(drop.quest)).slice(0, 5),
    [allDrops, quests],
  );

  return createPortal(
    <div
      className="app-modal-overlay fixed inset-0 z-[500] flex items-center justify-center bg-black/80 backdrop-blur-sm p-2 sm:p-4"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="app-modal-frame app-modal-size-md relative w-full flex flex-col max-h-[85vh] rounded-xl border border-[var(--th-line)]/100 bg-[var(--th-bg-base)] shadow-2xl shadow-black/60 overflow-hidden">

        <div className="flex-shrink-0 flex items-center justify-between px-4 py-2.5 bg-gradient-to-r from-[var(--th-bg-raised)] to-[var(--th-bg-base)] border-b border-[var(--th-line)]/60">
          <div className="flex items-center gap-2 min-w-0">
            <Gem size={14} className="text-amber-400 flex-shrink-0" />
            <h2 className="text-sm font-bold text-slate-100 truncate">Últimos Drops</h2>
            <span className="text-[9px] font-bold text-slate-500 uppercase tracking-wide">5 mais recentes</span>
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

        {/* Filtros por quest — checkboxes INDEPENDENTES (multi-seleção livre;
            nenhuma marcada = nenhum drop exibido). */}
        <div className="flex-shrink-0 flex items-center gap-1 flex-wrap px-4 py-2 border-b border-white/5">
          <span className="text-[8px] font-bold uppercase tracking-wider text-slate-500 flex-shrink-0">Quests</span>
          {QUEST_FILTER_OPTIONS.map(opt => {
            const checked = quests.includes(opt.key);
            return (
              <label
                key={opt.key}
                title={opt.title}
                className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[9px] font-black uppercase tracking-wide transition-colors cursor-pointer select-none flex-shrink-0 ${
                  checked ? QUEST_BADGE_COLOR_CLASSES[opt.key] : "border-white/10 bg-white/[0.03] text-slate-500 hover:text-slate-300 hover:border-white/20"
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => setQuests(prev => prev.includes(opt.key) ? prev.filter(q => q !== opt.key) : [...prev, opt.key])}
                  aria-label={opt.title}
                  className={`w-2.5 h-2.5 rounded-sm cursor-pointer ${opt.accent}`}
                />
                {opt.label}
              </label>
            );
          })}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-2.5">
          {shown.length === 0 ? (
            <p className="text-[11px] text-slate-500 text-center py-6">
              {quests.length === 0
                ? "Nenhuma quest selecionada — marque SW, SG e/ou GB para exibir os drops."
                : "Nenhum drop com data registrada nas quests selecionadas ainda."}
            </p>
          ) : (
            <ul className="divide-y divide-white/5">
              {shown.map((drop, index) => (
                <li key={`${drop.charId}:${drop.quest}:${drop.at}:${index}`} className="py-1.5 flex items-center gap-2 flex-wrap">
                  <span className={`text-[8px] font-black px-1 py-px rounded border uppercase tracking-wide flex-shrink-0 ${QUEST_BADGE_COLOR_CLASSES[drop.quest]}`}>
                    {QUEST_SIGLA[drop.quest]}
                  </span>
                  <span className="text-[11px] font-bold text-slate-200 truncate">{drop.item}</span>
                  <span className="inline-flex items-center gap-1 text-[10px] text-slate-400 min-w-0">
                    <span className="truncate">{drop.character}</span>
                  </span>
                  <span className="inline-flex items-center gap-0.5 text-[9px] text-slate-500 flex-shrink-0">
                    <Server size={9} /> {drop.server || "—"}
                  </span>
                  <span className="inline-flex items-center gap-0.5 text-[9px] text-slate-500 tabular-nums ml-auto flex-shrink-0" title="Data e horário reais do drop">
                    <CalendarClock size={9} /> {formatDropDate(drop.at!)}
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
