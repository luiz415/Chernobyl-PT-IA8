import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Pause, X, Clock, Check } from "lucide-react";
import type { PtType } from "../types";
import { getQuestBosses } from "../constants/questBosses";
import type { QuestBoss } from "../constants/questBosses";

// ============================================================================
// PAUSAR PT — escolha do Boss
//
// Aberto ao clicar em "Pausar". O líder informa em qual Boss a party parou.
// A exceção "Não considerar cooldown" vale somente para esta pausa/Boss; não
// altera o catálogo normal e é apagada quando a PT é retomada.
//
// Renderiza por portal em document.body — o painel vive dentro de um container
// com CSS `zoom`, que quebra o hit-testing de `position: fixed`. Mesmo motivo
// já documentado em ConfirmModal e ServiceValueModal.
// ============================================================================

interface Props {
  open: boolean;
  ptType: PtType | undefined;
  /** `boss` nulo = pausar sem Boss (sem cooldown). */
  onConfirm: (boss: QuestBoss | null, ignoreCooldown: boolean) => void;
  onCancel: () => void;
}

export default function PausePartyModal({ open, ptType, onConfirm, onCancel }: Props) {
  const [ignoreCooldown, setIgnoreCooldown] = useState(false);

  // Reinicia a escolha somente quando o modal é aberto. `onCancel` é uma
  // callback criada pelo PartyPanel e pode ganhar nova referência a cada
  // render/tique do cronômetro; usá-la nesta dependência desmarcava a caixa
  // sozinha enquanto o modal ainda estava aberto.
  useEffect(() => {
    if (open) setIgnoreCooldown(false);
  }, [open]);

  // O listener de teclado precisa acompanhar a callback atual, mas nunca pode
  // resetar o estado do checkbox por causa de uma atualização do PartyPanel.
  useEffect(() => {
    if (!open) return;
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onCancel]);

  if (!open) return null;

  const bosses = getQuestBosses(ptType);
  const questLabel = ptType === "sanguine" ? "Sanguine" : ptType === "soulwar" ? "Soul War" : "";

  return createPortal(
    <div
      className="app-modal-overlay fixed inset-0 z-[1100] flex items-center justify-center bg-black/85 backdrop-blur-sm"
      onMouseDown={event => { if (event.target === event.currentTarget) onCancel(); }}
    >
      <div className="app-modal-frame app-modal-size-xs app-modal-frame--scroll relative w-full max-w-sm rounded-xl border border-[var(--th-line)]/100 bg-[var(--th-bg-base)] shadow-2xl shadow-black/60">

        <div className="flex-shrink-0 flex items-center justify-between px-4 py-2.5 bg-gradient-to-r from-[var(--th-bg-raised)] to-[var(--th-bg-base)] border-b border-[var(--th-line)]/60">
          <div className="flex items-center gap-2 min-w-0">
            <Pause size={14} className="text-amber-400 flex-shrink-0" />
            <h2 className="text-sm font-bold text-slate-100 truncate">
              Pausar PT{questLabel ? ` — ${questLabel}` : ""}
            </h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            title="Cancelar (Esc)"
            className="text-slate-500 hover:text-slate-200 p-1 rounded-md hover:bg-white/[0.04] transition-colors cursor-pointer flex-shrink-0"
          >
            <X size={16} />
          </button>
        </div>

        <div className="app-modal-body custom-scrollbar px-4 py-3 space-y-3">
          <p className="text-[11px] leading-snug text-slate-400">
            Em qual Boss a PT foi pausada? O estado fica visível para todos os
            participantes enquanto a pausa estiver ativa.
          </p>

          <label className={`flex items-start gap-2 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
            ignoreCooldown
              ? "border-emerald-500/40 bg-emerald-500/10"
              : "border-[var(--th-line)]/50 bg-white/[0.02] hover:bg-white/[0.04]"
          }`}>
            <input
              type="checkbox"
              checked={ignoreCooldown}
              onChange={event => setIgnoreCooldown(event.target.checked)}
              className="mt-0.5 h-4 w-4 accent-emerald-500 cursor-pointer"
            />
            <span className="min-w-0">
              <span className="block text-[11px] font-bold text-slate-200">Não considerar cooldown</span>
              <span className={`block mt-0.5 text-[10px] leading-snug ${ignoreCooldown ? "text-emerald-300" : "text-slate-500"}`}>
                {ignoreCooldown
                  ? "O Boss selecionado não terá cooldown nesta pausa."
                  : "O Boss selecionado receberá o cooldown normal da Quest."}
              </span>
            </span>
          </label>

          {bosses.length > 0 ? (
            <div className="space-y-1">
              {bosses.map(boss => (
                <button
                  key={boss.id}
                  type="button"
                  onClick={() => onConfirm(boss, ignoreCooldown)}
                  className="w-full flex items-center justify-between gap-2 rounded-lg border border-[var(--th-line)]/40 bg-white/[0.02] px-3 py-2 text-left hover:bg-white/[0.06] hover:border-amber-500/40 transition-colors cursor-pointer"
                >
                  <span className="min-w-0">
                    <span className="block text-[12px] font-bold text-slate-100 truncate">
                      {boss.description}
                    </span>
                    {boss.name && boss.name !== boss.description && (
                      <span className="block text-[10px] text-slate-500">Boss {boss.name}</span>
                    )}
                  </span>
                  {ignoreCooldown ? (
                    <span className="flex-shrink-0 inline-flex items-center gap-1 rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-black text-emerald-300">
                      <Check size={9} /> Disponível
                    </span>
                  ) : (
                    <span className="flex-shrink-0 inline-flex items-center gap-1 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-black text-amber-300">
                      <Clock size={9} /> {boss.hours}h
                    </span>
                  )}
                </button>
              ))}
            </div>
          ) : (
            <p className="rounded-lg border border-[var(--th-line)]/40 bg-white/[0.02] px-3 py-2 text-[11px] text-slate-500">
              Esta PT não tem tipo de Quest definido, então não há bosses para
              escolher. Você ainda pode pausá-la normalmente.
            </p>
          )}
        </div>

        <div className="flex-shrink-0 flex items-center justify-between gap-2 px-4 py-2.5 border-t border-[var(--th-line)]/60 bg-[var(--th-bg-raised)]">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 rounded-lg border border-white/10 bg-white/5 text-slate-300 hover:text-white hover:bg-white/10 text-[11px] font-bold transition-colors cursor-pointer"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={() => onConfirm(null, false)}
            className="px-3 py-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20 text-[11px] font-bold transition-colors cursor-pointer"
          >
            Pausar sem selecionar Boss
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}