import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, RotateCw } from "lucide-react";

// ============================================================================
// SANGUINE — EDIÇÃO DA ROTAÇÃO PELO PARTY PANEL (modal próprio)
//
// Aberto pelo clique na célula "Rot SG" da PT (apenas o DONO do personagem,
// antes da conclusão da Quest). Exibe com clareza as DUAS grandezas:
//   • Rotação cadastrada  — rotações já registradas em Meus Personagens;
//   • Rotação nesta PT    — a rotação que o personagem fará (cadastrada + 1).
// O usuário ajusta a ROTAÇÃO DA PT (>= 1); a rotação cadastrada resultante é
// mostrada em tempo real (`rotação da PT - 1`).
//
// O modal NÃO persiste nada sozinho: devolve ao chamador a quantidade de
// rotações CONCLUÍDAS resultante (`onConfirm(completed)`), que o App grava
// com um patch MÍNIMO apenas do campo de rotação do personagem vivo —
// nenhuma segunda fonte de verdade e nenhum dado cadastral (Account/nome/
// código) é tocado.
//
// Renderiza por portal em document.body — o painel vive dentro de um
// container com CSS `zoom`, que quebra o hit-testing de `position: fixed`
// (mesmo motivo documentado em ConfirmModal, NextRotationModal e
// SgCooldownModal).
// ============================================================================

interface Props {
  open: boolean;
  /** Nome do personagem (título do modal). */
  characterName: string;
  /** Rotações já registradas em Meus Personagens (0 = nenhuma → "-"). */
  registeredRotations: number;
  /** Rotação atualmente exibida para esta PT (registradas + 1 / planejada). */
  partyRotation: number;
  /** Confirma: nova quantidade de rotações CONCLUÍDAS (rotação da PT - 1). */
  onConfirm: (completedRotations: number) => void;
  onCancel: () => void;
}

export default function SgRotationModal({ open, characterName, registeredRotations, partyRotation, onConfirm, onCancel }: Props) {
  const [value, setValue] = useState("1");

  // Reinicia SOMENTE quando o modal abre (mesmo padrão dos demais modais do
  // painel: callbacks mudam de referência a cada render e não podem resetar
  // a digitação do usuário).
  useEffect(() => {
    if (!open) return;
    setValue(String(partyRotation));
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

  const parsed = /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= 99;
  const resultingRegistered = valid ? parsed - 1 : null;

  function confirm() {
    if (!valid) return;
    onConfirm(parsed - 1);
  }

  const fmtRegistered = (n: number) => (n === 0 ? "-" : `${n}ª Rot`);

  return createPortal(
    <div
      className="app-modal-overlay fixed inset-0 z-[1100] flex items-center justify-center bg-black/85 backdrop-blur-sm"
      onMouseDown={event => { if (event.target === event.currentTarget) onCancel(); }}
    >
      <div className="app-modal-frame app-modal-size-xs relative w-full max-w-sm rounded-xl border border-[var(--th-line)]/100 bg-[var(--th-bg-base)] shadow-2xl shadow-black/60">

        <div className="flex-shrink-0 flex items-center justify-between px-4 py-2.5 bg-gradient-to-r from-[var(--th-bg-raised)] to-[var(--th-bg-base)] border-b border-[var(--th-line)]/60">
          <div className="flex items-center gap-2 min-w-0">
            <RotateCw size={14} className="text-rose-400 flex-shrink-0" />
            <h2 className="text-sm font-bold text-slate-100 truncate">Rotação Sanguine — {characterName}</h2>
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
          {/* Situação atual — as duas grandezas, lado a lado */}
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg border border-[var(--th-line)]/50 bg-white/[0.02] px-3 py-2">
              <p className="text-[9px] font-bold uppercase tracking-wide text-slate-500">Rotação cadastrada</p>
              <p className="text-[13px] font-bold tabular-nums text-slate-200" title="Rotações já registradas em Meus Personagens">
                {fmtRegistered(registeredRotations)}
              </p>
            </div>
            <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2">
              <p className="text-[9px] font-bold uppercase tracking-wide text-rose-400/80">Rotação nesta PT</p>
              <p className="text-[13px] font-bold tabular-nums text-rose-300" title="Rotação que o personagem fará nesta PT (cadastrada + 1)">
                {partyRotation}ª Rot
              </p>
            </div>
          </div>

          <div className="rounded-lg border border-[var(--th-line)]/50 bg-white/[0.02] px-3 py-2 space-y-1.5">
            <label className="block text-[10px] font-bold uppercase tracking-wide text-slate-400">
              Ajustar a rotação desta PT
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={99}
                step={1}
                autoFocus
                value={value}
                onChange={event => setValue(event.target.value)}
                onKeyDown={event => { if (event.key === "Enter") confirm(); }}
                className="w-20 bg-black/60 border border-[var(--th-line)]/60 rounded px-2 py-1 text-[12px] text-rose-200 text-center tabular-nums focus:outline-none focus:border-rose-500/50"
              />
              <span className="text-[11px] text-slate-400">ª rotação nesta PT</span>
            </div>
            {valid ? (
              <p className="text-[10px] leading-snug text-slate-500">
                Ao confirmar, o personagem ficará com{" "}
                <span className="font-bold text-slate-300">{fmtRegistered(resultingRegistered as number)}</span>{" "}
                cadastrada em Meus Personagens (a PT sempre mostra a rotação seguinte). O resultado
                Drop/Não Drop da última rotação acompanha a contagem de forma coerente.
              </p>
            ) : (
              <p className="text-[10px] leading-snug font-bold text-rose-400">
                Informe um número inteiro de 1 a 99.
              </p>
            )}
          </div>
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
            onClick={confirm}
            disabled={!valid}
            title={!valid ? "Informe um número inteiro de 1 a 99." : undefined}
            className="px-3 py-1.5 rounded-md border border-rose-500/50 bg-rose-500/15 text-rose-300 text-[11px] font-bold hover:bg-rose-500/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            Confirmar
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
