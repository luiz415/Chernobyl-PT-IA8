import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { X, Gem } from "lucide-react";
import type { Character, QuestStatusHistoryQuest } from "../types";
import { collectRecentDrops } from "../utils/questStatusHistory";
import { QUEST_SIGLA, QUEST_BADGE_COLOR_CLASSES } from "../constants/questBadges";

// ============================================================================
// ÚLTIMOS DROPS (102ª/103ª tarefas) — modal compacto de "Meus Personagens"
//
// Exibe os 10 DROPS VÁLIDOS MAIS RECENTES dos personagens da lista pessoal
// do usuário (servidor, personagem, data/hora, item e quest), do mais
// recente para o mais antigo. A fonte é ÚNICA e compartilhada com "Últimas
// Quests" e a guia Stats: `collectRecentDrops` (utils/questStatusHistory) —
// o modal NÃO mantém histórico próprio nem grava nada. Drops de realizações
// DESFEITAS (quest voltou a "Disponível" — proteção da 103ª) ficam fora.
//
// Filtros por quest em CHECKBOXES INDEPENDENTES (SW/SG/GB): várias podem
// estar marcadas ao mesmo tempo; NENHUMA marcada = nenhum drop exibido.
// A seleção é PERSISTIDA POR USUÁRIO (localStorage) — fechar/reabrir o
// modal ou recarregar a página restaura a última escolha (103ª).
//
// Renderiza por portal em document.body (mesmo motivo documentado em
// ConfirmModal/SgCooldownModal: containers com CSS zoom quebram fixed).
// ============================================================================

/** Quantidade exibida — os 10 drops válidos mais recentes (103ª). */
const SHOWN_LIMIT = 10;

const ALL_QUESTS: QuestStatusHistoryQuest[] = ["soulwar", "sanguine", "crypt"];

const QUEST_FILTER_OPTIONS: Array<{ key: QuestStatusHistoryQuest; label: string; title: string; accent: string }> = [
  { key: "soulwar", label: "SW", title: "Exibir drops da Soul War", accent: "accent-slate-400" },
  { key: "sanguine", label: "SG", title: "Exibir drops da Sanguine", accent: "accent-red-700" },
  { key: "crypt", label: "GB", title: "Exibir drops da Graveborn (GB)", accent: "accent-lime-700" },
];

/** Chave da persistência POR USUÁRIO dos filtros deste modal (103ª). */
export function lastDropsFiltersKey(uid: string): string {
  return `rubinot_last_drops_filters_${String(uid || "").trim() || "local"}`;
}

/** Carrega a última seleção persistida (padrão: todas as quests marcadas). */
function loadPersistedQuests(uid: string): QuestStatusHistoryQuest[] {
  try {
    const raw = localStorage.getItem(lastDropsFiltersKey(uid));
    if (!raw) return [...ALL_QUESTS];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...ALL_QUESTS];
    // Sanitização: só quests conhecidas, ordem canônica, sem duplicatas.
    return ALL_QUESTS.filter(q => parsed.includes(q));
  } catch {
    return [...ALL_QUESTS];
  }
}

/** Data/hora REAL do drop: dd/mm/aa + hh:mm (linhas separadas na UI). */
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

export default function LastDropsModal({ characters, currentUserUid, onClose }: Props) {
  // Filtros independentes — restaurados da última seleção do PRÓPRIO usuário.
  const [quests, setQuests] = useState<QuestStatusHistoryQuest[]>(() => loadPersistedQuests(currentUserUid));

  // Persiste a cada alteração (por usuário — não interfere em outros).
  useEffect(() => {
    try { localStorage.setItem(lastDropsFiltersKey(currentUserUid), JSON.stringify(quests)); } catch { /* storage indisponível */ }
  }, [quests, currentUserUid]);

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  // Drops válidos com data real, já ordenados do mais recente para o mais
  // antigo (derivação pura da fonte única — nada é gravado aqui).
  const allDrops = useMemo(() => collectRecentDrops(characters), [characters]);
  const shown = useMemo(
    () => allDrops.filter(drop => quests.includes(drop.quest)).slice(0, SHOWN_LIMIT),
    [allDrops, quests],
  );

  return createPortal(
    <div
      className="app-modal-overlay fixed inset-0 z-[500] flex items-center justify-center bg-black/80 backdrop-blur-sm p-2 sm:p-4"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="app-modal-frame app-modal-size-md relative w-full flex flex-col max-h-[85vh] rounded-xl border border-[var(--th-line)]/100 bg-[var(--th-bg-base)] shadow-2xl shadow-black/60 overflow-hidden">

        {/* Cabeçalho: título + filtros na MESMA linha (espaço otimizado). */}
        <div className="flex-shrink-0 flex items-center gap-2 flex-wrap px-4 py-2.5 bg-gradient-to-r from-[var(--th-bg-raised)] to-[var(--th-bg-base)] border-b border-[var(--th-line)]/60">
          <Gem size={14} className="text-amber-400 flex-shrink-0" />
          <h2 className="text-sm font-bold text-slate-100">Últimos Drops</h2>
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
                ? "Nenhuma quest selecionada — marque SW, SG e/ou GB para exibir os drops."
                : "Nenhum drop com data registrada nas quests selecionadas ainda."}
            </p>
          ) : (
            <ul className="divide-y divide-white/5">
              {shown.map((drop, index) => {
                const when = formatDate(drop.at!);
                return (
                  <li key={`${drop.charId}:${drop.quest}:${drop.at}:${index}`} className="py-1.5 px-1 flex items-center gap-2">
                    <span className={`text-[8px] font-black px-1 py-px rounded border uppercase tracking-wide flex-shrink-0 ${QUEST_BADGE_COLOR_CLASSES[drop.quest]}`} title={`Quest: ${QUEST_SIGLA[drop.quest]}`}>
                      {QUEST_SIGLA[drop.quest]}
                    </span>
                    {/* Destaques: ITEM e PERSONAGEM (coluna principal). */}
                    <div className="min-w-0 flex-1 leading-tight">
                      <div className="text-[11px] font-bold text-amber-200 truncate" title={drop.item}>{drop.item}</div>
                      <div className="text-[10px] font-semibold text-slate-300 truncate" title={`Personagem: ${drop.character}`}>{drop.character}</div>
                    </div>
                    {/* Servidor + data/hora: bloco à direita, leitura imediata. */}
                    <div className="flex-shrink-0 text-right leading-tight">
                      <div className="text-[9px] font-bold uppercase tracking-wide text-sky-300/80" title="Servidor">{drop.server || "—"}</div>
                      <div className="text-[9px] text-slate-500 tabular-nums" title="Data e horário reais do drop">{when.date} · {when.time}</div>
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
