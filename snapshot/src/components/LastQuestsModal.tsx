import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { X, ScrollText, CheckCircle2, XCircle } from "lucide-react";
import type { Character, QuestStatusHistoryQuest } from "../types";
import { collectQuestRealizations } from "../utils/questStatusHistory";
import { QUEST_SIGLA, QUEST_BADGE_COLOR_CLASSES } from "../constants/questBadges";

// ============================================================================
// ÚLTIMAS QUESTS (102ª/103ª tarefas) — modal compacto de "Meus Personagens"
//
// Exibe as 10 QUESTS REALIZADAS VÁLIDAS mais recentes dos personagens da
// lista pessoal (servidor, personagem, quest, data/hora da conclusão e
// "Com drop"/"Sem drop"), da mais recente para a mais antiga. Fonte ÚNICA
// compartilhada com "Últimos Drops" e a guia Stats:
// `collectQuestRealizations` (utils/questStatusHistory) — o modal NÃO
// mantém histórico próprio nem grava nada. Conclusões DESFEITAS (quest
// voltou a "Disponível" — proteção da 103ª) não contam como realização.
//
// REGRA SANGUINE: cada ROTAÇÃO CONCLUÍDA (resposta "Drop?" Sim OU Não) é uma
// quest realizada — a linha distingue "Com drop"/"Sem drop" e o nº da rotação.
//
// Filtros por quest em CHECKBOXES INDEPENDENTES (SW/SG/GB — 103ª, mesmos do
// "Últimos Drops"): seleção PERSISTIDA POR USUÁRIO, independente da escolha
// feita no outro modal; NENHUMA marcada = nenhuma realização exibida.
//
// Renderiza por portal em document.body (mesmo motivo documentado em
// ConfirmModal/SgCooldownModal: containers com CSS zoom quebram fixed).
// ============================================================================

/** Quantidade exibida — as 10 realizações válidas mais recentes (103ª). */
const SHOWN_LIMIT = 10;

const ALL_QUESTS: QuestStatusHistoryQuest[] = ["soulwar", "sanguine", "crypt"];

const QUEST_FILTER_OPTIONS: Array<{ key: QuestStatusHistoryQuest; label: string; title: string; accent: string }> = [
  { key: "soulwar", label: "SW", title: "Exibir realizações da Soul War", accent: "accent-slate-400" },
  { key: "sanguine", label: "SG", title: "Exibir realizações da Sanguine (inclui rotações)", accent: "accent-red-700" },
  { key: "crypt", label: "GB", title: "Exibir realizações da Graveborn (GB)", accent: "accent-lime-700" },
];

/** Chave da persistência POR USUÁRIO dos filtros deste modal (103ª) —
 *  independente da chave do "Últimos Drops". */
export function lastQuestsFiltersKey(uid: string): string {
  return `rubinot_last_quests_filters_${String(uid || "").trim() || "local"}`;
}

/** Carrega a última seleção persistida (padrão: todas as quests marcadas). */
function loadPersistedQuests(uid: string): QuestStatusHistoryQuest[] {
  try {
    const raw = localStorage.getItem(lastQuestsFiltersKey(uid));
    if (!raw) return [...ALL_QUESTS];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...ALL_QUESTS];
    return ALL_QUESTS.filter(q => parsed.includes(q));
  } catch {
    return [...ALL_QUESTS];
  }
}

/** Data/hora REAL da conclusão: dd/mm/aa + hh:mm. */
function formatDate(at: number): { date: string; time: string } {
  const d = new Date(at);
  return {
    date: d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit" }),
    time: d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
  };
}

interface Props {
  /** Personagens da lista pessoal do usuário (ativos + vendidos). */
  characters: Character[];
  /** Dono da lista — define a chave da persistência dos filtros (103ª). */
  currentUserUid: string;
  onClose: () => void;
}

export default function LastQuestsModal({ characters, currentUserUid, onClose }: Props) {
  // Filtros independentes — restaurados da última seleção do PRÓPRIO usuário.
  const [quests, setQuests] = useState<QuestStatusHistoryQuest[]>(() => loadPersistedQuests(currentUserUid));

  // Persiste a cada alteração (por usuário — não interfere em outros).
  useEffect(() => {
    try { localStorage.setItem(lastQuestsFiltersKey(currentUserUid), JSON.stringify(quests)); } catch { /* storage indisponível */ }
  }, [quests, currentUserUid]);

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  // Realizações válidas já ordenadas da mais recente para a mais antiga
  // (derivação pura da fonte única — nada é gravado aqui).
  const realizations = useMemo(() => collectQuestRealizations(characters), [characters]);
  const shown = useMemo(
    () => realizations.filter(entry => quests.includes(entry.quest)).slice(0, SHOWN_LIMIT),
    [realizations, quests],
  );

  return createPortal(
    <div
      className="app-modal-overlay fixed inset-0 z-[500] flex items-center justify-center bg-black/80 backdrop-blur-sm p-2 sm:p-4"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="app-modal-frame app-modal-size-md relative w-full flex flex-col max-h-[85vh] rounded-xl border border-[var(--th-line)]/100 bg-[var(--th-bg-base)] shadow-2xl shadow-black/60 overflow-hidden">

        {/* Cabeçalho: título + filtros na MESMA linha (espaço otimizado). */}
        <div className="flex-shrink-0 flex items-center gap-2 flex-wrap px-4 py-2.5 bg-gradient-to-r from-[var(--th-bg-raised)] to-[var(--th-bg-base)] border-b border-[var(--th-line)]/60">
          <ScrollText size={14} className="text-amber-400 flex-shrink-0" />
          <h2 className="text-sm font-bold text-slate-100">Últimas Quests</h2>
          <span className="text-[9px] font-bold text-slate-500 uppercase tracking-wide">{SHOWN_LIMIT} mais recentes</span>
          <div className="flex items-center gap-1 ml-auto">
            {QUEST_FILTER_OPTIONS.map(opt => {
              const checked = quests.includes(opt.key);
              return (
                <label
                  key={opt.key}
                  title={opt.title}
                  className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[9px] font-black uppercase tracking-wide transition-colors cursor-pointer select-none ${
                    checked ? QUEST_BADGE_COLOR_CLASSES[opt.key] : "border-white/10 bg-white/[0.03] text-slate-500 hover:text-slate-300 hover:border-white/20"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => setQuests(prev => prev.includes(opt.key) ? prev.filter(q => q !== opt.key) : ALL_QUESTS.filter(q => q === opt.key || prev.includes(q)))}
                    aria-label={opt.title}
                    className={`w-2.5 h-2.5 rounded-sm cursor-pointer ${opt.accent}`}
                  />
                  {opt.label}
                </label>
              );
            })}
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

        <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2">
          {shown.length === 0 ? (
            <p className="text-[11px] text-slate-500 text-center py-6">
              {quests.length === 0
                ? "Nenhuma quest selecionada — marque SW, SG e/ou GB para exibir as realizações."
                : "Nenhuma quest realizada registrada nas quests selecionadas ainda — conclusões e rotações Sanguine passam a aparecer aqui com data e horário."}
            </p>
          ) : (
            <ul className="divide-y divide-white/5">
              {shown.map((entry, index) => {
                const when = formatDate(entry.at);
                return (
                  <li key={`${entry.charId}:${entry.quest}:${entry.at}:${index}`} className="py-1.5 px-1 flex items-center gap-2">
                    <span className={`text-[8px] font-black px-1 py-px rounded border uppercase tracking-wide flex-shrink-0 ${QUEST_BADGE_COLOR_CLASSES[entry.quest]}`} title={`Quest: ${QUEST_SIGLA[entry.quest]}`}>
                      {QUEST_SIGLA[entry.quest]}
                    </span>
                    {/* Destaques: PERSONAGEM (linha 1) e resultado (linha 2). */}
                    <div className="min-w-0 flex-1 leading-tight">
                      <div className="text-[11px] font-bold text-slate-100 truncate" title={`Personagem: ${entry.character}`}>
                        {entry.character}
                        {entry.rot !== null && (
                          <span className="ml-1.5 text-[8px] font-bold px-1 py-px rounded border border-white/10 bg-white/[0.03] text-slate-400 uppercase tracking-wide align-middle" title="Rotação Sanguine concluída (conta como quest realizada, com ou sem drop)">
                            Rot {entry.rot}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 min-w-0">
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
                          <span className="text-[10px] font-bold text-amber-200 truncate" title={entry.item}>{entry.item}</span>
                        )}
                      </div>
                    </div>
                    {/* Servidor + data/hora: bloco à direita, leitura imediata. */}
                    <div className="flex-shrink-0 text-right leading-tight">
                      <div className="text-[9px] font-bold uppercase tracking-wide text-sky-300/80" title="Servidor">{entry.server || "—"}</div>
                      <div className="text-[9px] text-slate-500 tabular-nums" title="Data e horário reais da conclusão">{when.date} · {when.time}</div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
