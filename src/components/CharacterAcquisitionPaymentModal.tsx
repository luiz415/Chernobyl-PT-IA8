import { useEffect, useState } from "react";
import { Check, Clipboard, ClipboardCheck, Coins, Send, UserRound, X } from "lucide-react";
import { formatRC } from "../types";

export interface CharacterAcquisitionPaymentModalContext {
  title: string;
  characterName: string;
  payerLabel: string;
  payerName: string;
  recipientLabel: string;
  recipientName: string;
  mainCharacterName: string;
  amount: number;
  /** Detalhamento opcional do primeiro pagamento (aceite da aquisição). */
  calculation?: {
    characterValue: number;
    personalFee: number;
    bazaarFee: number;
    total: number;
  };
  instruction: string;
  confirmLabel: string;
}

interface Props {
  open: boolean;
  context: CharacterAcquisitionPaymentModalContext | null;
  onClose: () => void;
  onConfirm: () => Promise<{ ok: boolean; error?: string }>;
}

async function copyExact(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    try {
      const textArea = document.createElement("textarea");
      textArea.value = value;
      textArea.style.position = "fixed";
      textArea.style.opacity = "0";
      document.body.appendChild(textArea);
      textArea.select();
      const copied = document.execCommand("copy");
      document.body.removeChild(textArea);
      return copied;
    } catch {
      return false;
    }
  }
}

function CalculationRow({ label, value, tone = "default" }: { label: string; value: string; tone?: "default" | "muted" | "amber" | "sky" }) {
  const valueClass = tone === "amber"
    ? "text-amber-200"
    : tone === "sky"
      ? "text-sky-200"
      : tone === "muted"
        ? "text-slate-400"
        : "text-slate-200";
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-slate-400">{label}</span>
      <span className={`font-mono font-bold text-right ${valueClass}`}>{value}</span>
    </div>
  );
}

export default function CharacterAcquisitionPaymentModal({ open, context, onClose, onConfirm }: Props) {
  const [isSaving, setIsSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setIsSaving(false);
    setCopied(false);
    setError("");
  }, [open, context?.title, context?.mainCharacterName]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isSaving) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, isSaving, onClose]);

  if (!open || !context) return null;
  const paymentContext = context;
  // No aceite, o cálculo já informa quem paga/recebe; evitamos duplicar cards.
  const isAcquisitionAcceptance = !!context.calculation;
  const acceptanceInstruction = context.calculation
    ? `Envie ${formatRC(context.calculation.total)} para ${context.recipientName} usando o Main Character abaixo. Depois de pagar, confirme a aquisição.`
    : context.instruction;

  async function handleCopy() {
    const exact = String(paymentContext.mainCharacterName || "");
    if (!exact) return;
    const success = await copyExact(exact);
    if (success) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!paymentContext.mainCharacterName.trim()) {
      setError("O Main Character necessário para o pagamento não está cadastrado.");
      return;
    }
    setIsSaving(true);
    setError("");
    try {
      const result = await onConfirm();
      if (!result.ok) {
        setError(result.error || "Não foi possível confirmar o pagamento.");
        return;
      }
      onClose();
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="app-modal-overlay fixed inset-0 z-[720] flex items-center justify-center bg-black/80 backdrop-blur-sm" onMouseDown={event => { if (event.target === event.currentTarget && !isSaving) onClose(); }}>
      <form onSubmit={submit} className="app-modal-frame app-modal-size-sm app-modal-frame--scroll w-full max-w-md rounded-2xl border border-emerald-500/35 bg-[var(--th-bg-base)] shadow-2xl shadow-black/70">
        <header className="flex items-center justify-between border-b border-[var(--th-line)]/50 bg-gradient-to-r from-emerald-500/10 via-[var(--th-bg-raised)] to-sky-500/10 px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-emerald-400/35 bg-emerald-500/15 text-emerald-300"><Send size={18} /></div>
            <div>
              <h2 className="text-base font-black text-slate-100">{context.title}</h2>
              <p className="text-[10px] text-slate-400">Confirmação financeira da negociação.</p>
            </div>
          </div>
          <button type="button" onClick={onClose} disabled={isSaving} className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-40" aria-label="Fechar modal"><X size={17} /></button>
        </header>

        <div className="app-modal-body space-y-3 p-4 sm:p-5">
          <section className="rounded-xl border border-[var(--th-line)]/60 bg-black/20 p-3">
            <div className="text-[9px] font-black uppercase tracking-wider text-slate-500">Personagem</div>
            <div className="mt-0.5 text-sm font-black text-slate-100">{context.characterName}</div>
            {isAcquisitionAcceptance && <div className="mt-1 text-[10px] text-slate-400">Você pagará diretamente para <span className="font-bold text-sky-200">{context.recipientName}</span>.</div>}
          </section>

          {!isAcquisitionAcceptance && (
            <>
              <section className="grid grid-cols-2 gap-2">
                <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-3">
                  <div className="text-[9px] font-black uppercase tracking-wider text-amber-300">{context.payerLabel}</div>
                  <div className="mt-1 truncate text-xs font-bold text-slate-100">{context.payerName}</div>
                </div>
                <div className="rounded-xl border border-sky-500/25 bg-sky-500/[0.06] p-3">
                  <div className="text-[9px] font-black uppercase tracking-wider text-sky-300">{context.recipientLabel}</div>
                  <div className="mt-1 truncate text-xs font-bold text-slate-100">{context.recipientName}</div>
                </div>
              </section>

              <section className="rounded-xl border border-[var(--th-line)]/60 bg-[var(--th-bg-raised)]/60 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[9px] font-black uppercase tracking-wider text-slate-500">Valor a enviar</div>
                    <div className="mt-1 font-mono text-xl font-black text-emerald-300">{formatRC(context.amount)}</div>
                  </div>
                  <Coins size={24} className="text-amber-400" />
                </div>
              </section>
            </>
          )}

          {context.calculation && (
            <section className="rounded-xl border border-amber-500/30 bg-amber-500/[0.055] p-3">
              <div className="mb-2 text-[9px] font-black uppercase tracking-wider text-amber-200">Cálculo da aquisição</div>
              <div className="space-y-1.5 text-[11px]">
                <CalculationRow label="Valor do personagem" value={formatRC(context.calculation.characterValue)} />
                <CalculationRow
                  label="Taxa pessoal"
                  value={`${formatRC(context.calculation.personalFee)}${context.calculation.personalFee === 0 ? " · não aplicada" : " · aplicada"}`}
                  tone={context.calculation.personalFee === 0 ? "muted" : "amber"}
                />
                <CalculationRow
                  label="Taxa Bazaar obrigatória"
                  value={`${formatRC(context.calculation.bazaarFee)} · obrigatória`}
                  tone="sky"
                />
              </div>
              <div className="mt-2 flex items-center justify-between gap-3 border-t border-amber-400/20 pt-2">
                <span className="text-[10px] font-black uppercase tracking-wider text-emerald-200">Total final</span>
                <span className="font-mono text-base font-black text-emerald-300">{formatRC(context.calculation.total)}</span>
              </div>
            </section>
          )}

          <p className="rounded-lg border border-emerald-500/20 bg-emerald-500/[0.06] px-3 py-2 text-[11px] leading-relaxed text-emerald-100">{acceptanceInstruction}</p>

          <section className="rounded-xl border border-violet-500/25 bg-violet-500/[0.06] p-3">
            <div className="mb-1 flex items-center gap-1 text-[9px] font-black uppercase tracking-wider text-violet-300"><UserRound size={11} /> Main Character para pagamento</div>
            <button
              type="button"
              onClick={handleCopy}
              disabled={!context.mainCharacterName.trim()}
              className="flex w-full items-center justify-between gap-2 rounded-lg border border-violet-400/30 bg-black/25 px-3 py-2 text-left transition-colors hover:bg-violet-500/15 disabled:cursor-not-allowed disabled:opacity-45"
              title="Copiar exatamente o Main Character informado"
            >
              <span className="min-w-0 truncate font-mono text-sm font-black text-violet-100">{context.mainCharacterName || "Main Character não informado"}</span>
              {copied ? <ClipboardCheck size={15} className="flex-shrink-0 text-emerald-300" /> : <Clipboard size={15} className="flex-shrink-0 text-violet-300" />}
            </button>
            <p className="mt-1 text-[9px] text-slate-500">{copied ? "Copiado exatamente para a área de transferência." : "Clique para copiar sem espaços ou formatação adicional."}</p>
          </section>

          {error && <p role="alert" className="text-center text-[11px] font-medium text-rose-300">{error}</p>}
        </div>

        <footer className="app-modal-footer flex justify-end gap-2 border-t border-[var(--th-line)]/40 bg-[var(--th-bg-raised)] px-4 sm:px-5 py-3">
          <button type="button" onClick={onClose} disabled={isSaving} className="rounded-lg border border-white/10 bg-white/[0.04] px-4 py-2 text-xs font-bold text-slate-300 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-40">Cancelar</button>
          <button type="submit" disabled={isSaving} className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-400/45 bg-emerald-500/15 px-4 py-2 text-xs font-black text-emerald-200 transition-colors hover:bg-emerald-500/25 disabled:cursor-wait disabled:opacity-55"><Check size={13} /> {isSaving ? "Confirmando..." : context.confirmLabel}</button>
        </footer>
      </form>
    </div>
  );
}