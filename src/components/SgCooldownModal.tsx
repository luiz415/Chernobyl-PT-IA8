import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, Clock } from "lucide-react";
import { parseDurationField, splitDuration } from "../utils/durationFields";

// ============================================================================
// SANGUINE — COOLDOWN DO BAKRAGORE (edição manual em "Meus Personagens")
//
// Modal compacto aberto pela coluna "Rot SG" do CharTable: define quanto
// TEMPO FALTA (dias/horas/minutos — mesma lógica/validação do modo manual do
// NextRotationModal, via utils/durationFields) para o fim do cooldown do
// boss final da Sanguine do personagem. O fim exato é calculado ao salvar
// (agora + restante). "Zerar" remove o cooldown imediatamente.
//
// O modal NÃO persiste nada sozinho: devolve o epoch ms ao chamador
// (`onSave`), que grava pelo MESMO caminho da edição inline do personagem —
// nenhuma segunda fonte de verdade.
//
// Renderiza por portal em document.body — a tabela vive dentro de um
// container com CSS `zoom`, que quebra o hit-testing de `position: fixed`
// (mesmo motivo documentado em ConfirmModal e NextRotationModal).
// ============================================================================

interface Props {
  open: boolean;
  /** Nome do personagem (título do modal). */
  characterName: string;
  /** Fim atual do cooldown (epoch ms); 0/undefined = sem cooldown ativo. */
  currentUntil?: number;
  /** Salva o novo fim (epoch ms); `0` = remover o cooldown. */
  onSave: (untilMs: number) => void;
  onCancel: () => void;
}

export default function SgCooldownModal({ open, characterName, currentUntil, onSave, onCancel }: Props) {
  const [cdDays, setCdDays] = useState("0");
  const [cdHours, setCdHours] = useState("0");
  const [cdMins, setCdMins] = useState("0");

  // Reinicia os campos SOMENTE quando o modal abre, pré-preenchidos com o
  // tempo restante do cooldown atual (0/0/0 quando não há cooldown ativo).
  useEffect(() => {
    if (!open) return;
    const remaining = splitDuration((currentUntil || 0) - Date.now());
    setCdDays(String(remaining.days));
    setCdHours(String(remaining.hours));
    setCdMins(String(remaining.mins));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onCancel]);

  if (!open) return null;

  // Mesma validação do modo manual do NextRotationModal.
  const days = parseDurationField(cdDays, 0, 365);
  const hours = parseDurationField(cdHours, 0, 23);
  const mins = parseDurationField(cdMins, 0, 59);
  const valid = days !== null && hours !== null && mins !== null;
  const error = !valid
    ? (days === null
      ? "Dias: número inteiro de 0 a 365."
      : hours === null
        ? "Horas: número inteiro de 0 a 23."
        : "Minutos: número inteiro de 0 a 59.")
    : "";
  const remainingMs = valid ? ((days as number) * 24 * 60 + (hours as number) * 60 + (mins as number)) * 60_000 : 0;

  function save() {
    if (!valid) return;
    // Fim exato calculado AGORA + restante digitado; 0 remove o cooldown.
    onSave(remainingMs === 0 ? 0 : Date.now() + remainingMs);
  }

  return createPortal(
    <div
      className="app-modal-overlay fixed inset-0 z-[1100] flex items-center justify-center bg-black/85 backdrop-blur-sm"
      onMouseDown={event => { if (event.target === event.currentTarget) onCancel(); }}
    >
      <div className="app-modal-frame app-modal-size-xs relative w-full max-w-sm rounded-xl border border-[var(--th-line)]/100 bg-[var(--th-bg-base)] shadow-2xl shadow-black/60">

        <div className="flex-shrink-0 flex items-center justify-between px-4 py-2.5 bg-gradient-to-r from-[var(--th-bg-raised)] to-[var(--th-bg-base)] border-b border-[var(--th-line)]/60">
          <div className="flex items-center gap-2 min-w-0">
            <Clock size={14} className="text-amber-400 flex-shrink-0" />
            <h2 className="text-sm font-bold text-slate-100 truncate">Cooldown do Bakragore — {characterName}</h2>
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

        <div className="px-4 py-3 space-y-2.5">
          <p className="text-[11px] leading-snug text-slate-400">
            Informe quanto tempo <span className="font-bold text-amber-300">falta</span> para o boss final da
            Sanguine ficar disponível para este personagem. Zere os três campos para remover o cooldown.
          </p>

          <div className="flex items-end gap-2 flex-wrap">
            {([
              { label: "Dias", value: cdDays, set: setCdDays, max: 365 },
              { label: "Horas", value: cdHours, set: setCdHours, max: 23 },
              { label: "Min", value: cdMins, set: setCdMins, max: 59 },
            ] as const).map(({ label, value, set, max }) => (
              <label key={label} className="flex flex-col gap-0.5">
                <span className="text-[9px] font-bold uppercase tracking-wide text-slate-500">{label}</span>
                <input
                  type="number"
                  min={0}
                  max={max}
                  step={1}
                  value={value}
                  onChange={event => set(event.target.value)}
                  className="w-16 bg-black/60 border border-[var(--th-line)]/60 rounded px-2 py-1 text-[11px] text-slate-200 text-center focus:outline-none focus:border-amber-500/50"
                />
              </label>
            ))}
            <button
              type="button"
              onClick={() => { setCdDays("0"); setCdHours("0"); setCdMins("0"); }}
              className="px-2 py-1 rounded-md border border-[var(--th-line)]/50 bg-white/[0.02] text-slate-400 text-[10px] font-bold hover:bg-white/[0.06] transition-colors cursor-pointer"
              title="Zerar os campos (remove o cooldown ao salvar)"
            >
              Zerar
            </button>
          </div>

          {error ? (
            <p className="text-[10px] leading-snug font-bold text-rose-400">{error}</p>
          ) : (
            <p className="text-[10px] leading-snug text-slate-500">
              {remainingMs === 0
                ? "Sem cooldown — o contador será removido ao salvar."
                : `Cooldown até ≈ ${new Date(Date.now() + remainingMs).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })} (o fim exato é calculado ao salvar).`}
            </p>
          )}
        </div>

        <div className="flex-shrink-0 flex items-center justify-end gap-2 px-4 py-2.5 border-t border-[var(--th-line)]/60 bg-[var(--th-bg-raised)]/40">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 rounded-md border border-[var(--th-line)]/60 bg-white/[0.03] text-slate-300 text-[11px] font-bold hover:bg-white/[0.07] transition-colors cursor-pointer"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!valid}
            title={!valid ? "Corrija o tempo restante (dias/horas/minutos)." : undefined}
            className="px-3 py-1.5 rounded-md border border-amber-500/50 bg-amber-500/15 text-amber-300 text-[11px] font-bold hover:bg-amber-500/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            Salvar
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
