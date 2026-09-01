import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, X } from "lucide-react";

// ============================================================================
// MODAL DE CONFIRMAÇÃO REUTILIZÁVEL
//
// Substitui `window.confirm()` por um diálogo com o visual do aplicativo.
// O nativo do navegador ignora os temas, trava a janela inteira e, no
// Electron, aparece com a cara do sistema operacional — destoa de tudo.
//
// Genérico de propósito: hoje é usado na exclusão de Services, mas nada aqui
// é específico daquele fluxo. Os demais `window.confirm()` do projeto podem
// migrar para cá depois, sem precisar de outro componente.
//
// Detalhes que importam:
//   • PORTAL em document.body — o painel vive dentro de um container com CSS
//     `zoom`, que quebra o hit-testing de `position: fixed`. Mesmo motivo já
//     documentado em ServiceValueModal, CharTable e FilterTypes.
//   • Esc e clique no fundo cancelam. Nenhum dado é alterado ao cancelar.
//   • O foco inicial vai para CANCELAR, não para o botão destrutivo: um
//     "Enter" reflexo logo após abrir não deve apagar nada.
//   • Só cores por token `--th-*` e utilitários já usados no app, para
//     funcionar nos 7 temas.
// ============================================================================

interface Props {
  open: boolean;
  /** Título curto do cabeçalho. */
  title: string;
  /** Pergunta principal. Aceita nó para permitir destacar o nome em negrito. */
  message: React.ReactNode;
  /** Linha auxiliar opcional (ex.: "Esta ação não pode ser desfeita."). */
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /**
   * `danger` pinta o botão principal em vermelho (exclusões). `neutral` usa
   * o tom padrão para confirmações que não destroem nada.
   */
  tone?: "danger" | "neutral";
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmModal({
  open,
  title,
  message,
  detail,
  confirmLabel = "Confirmar",
  cancelLabel = "Cancelar",
  tone = "danger",
  onConfirm,
  onCancel,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Foco no CANCELAR ao abrir: a ação destrutiva nunca é o alvo padrão.
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => cancelRef.current?.focus(), 60);
    return () => window.clearTimeout(timer);
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

  const isDanger = tone === "danger";

  return createPortal(
    <div
      // z-[1100]: acima dos modais de formulário (z-[1000]), para poder ser
      // aberto a partir de um deles.
      className="app-modal-overlay fixed inset-0 z-[1100] flex items-center justify-center bg-black/85 backdrop-blur-sm"
      onMouseDown={event => { if (event.target === event.currentTarget) onCancel(); }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        className="app-modal-frame app-modal-size-xs app-modal-frame--scroll relative w-full max-w-sm bg-[var(--th-bg-base)] border border-[var(--th-line)]/100 rounded-xl shadow-2xl shadow-black/60"
      >
        <div className="flex items-center justify-between px-4 py-2.5 bg-gradient-to-r from-[var(--th-bg-raised)] to-[var(--th-bg-base)] border-b border-[var(--th-line)]/60">
          <div className="flex items-center gap-2 min-w-0">
            <AlertTriangle size={14} className={isDanger ? "text-rose-400" : "text-amber-400"} />
            <h2 className="text-sm font-bold text-slate-100 truncate">{title}</h2>
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

        <div className="app-modal-body px-4 py-4 space-y-2">
          <p className="text-[12px] leading-relaxed text-slate-300">{message}</p>
          {!!detail && (
            <p className={`text-[10.5px] leading-snug ${isDanger ? "text-rose-300/80" : "text-slate-500"}`}>
              {detail}
            </p>
          )}
        </div>

        <div className="app-modal-footer flex flex-wrap items-center justify-end gap-2 px-4 py-2.5 border-t border-[var(--th-line)]/60 bg-[var(--th-bg-raised)]">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 rounded-lg border border-white/10 bg-white/5 text-slate-300 hover:text-white hover:bg-white/10 text-[11px] font-bold transition-colors cursor-pointer"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`px-4 py-1.5 rounded-lg text-white text-[11px] font-black transition-all cursor-pointer border ${
              isDanger
                ? "bg-gradient-to-r from-rose-600/90 to-rose-500/90 hover:from-rose-500 hover:to-rose-400 border-rose-400/50"
                : "bg-gradient-to-r from-emerald-600/90 to-emerald-500/90 hover:from-emerald-500 hover:to-emerald-400 border-emerald-400/50"
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}