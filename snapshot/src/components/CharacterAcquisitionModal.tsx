import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Coins, Copy, Lock, ReceiptText, UserRound, X } from "lucide-react";
import { formatRC } from "../types";

export interface CharacterAcquisitionModalContext {
  partyName: string;
  characterName: string;
  server: string;
  vocation: string;
  level: number;
  originalOwnerName: string;
  acquirerName: string;
  detectedOriginalCost: number | null;
}

interface Props {
  open: boolean;
  context: CharacterAcquisitionModalContext | null;
  onClose: () => void;
  onConfirm: (input: { originalCharacterCost: number; personalFee: 0 | 25 | 50 }) => Promise<{ ok: boolean; error?: string }>;
}

function normalizeCostDraft(value: string): string {
  return value.replace(/\D/g, "").slice(0, 15);
}

/** Copia o texto usando o mesmo caminho do "Copiar (WA)" do PartyPanel e do
 *  histórico de PT's (textarea + execCommand, com fallback para a API
 *  assíncrona de clipboard). */
function copyTextToClipboard(text: string): void {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "0";
    ta.style.opacity = "0";
    ta.style.pointerEvents = "none";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  } catch {
    navigator.clipboard.writeText(text).catch(() => {});
  }
}

/** Formata o instante como "DD/MM/AAAA HH:MM" no horário local do usuário. */
function formatLocalDateTime(ts: number): string {
  const dt = new Date(ts);
  const dia = String(dt.getDate()).padStart(2, "0");
  const mes = String(dt.getMonth() + 1).padStart(2, "0");
  const ano = dt.getFullYear();
  const hh = String(dt.getHours()).padStart(2, "0");
  const mm = String(dt.getMinutes()).padStart(2, "0");
  return `${dia}/${mes}/${ano} ${hh}:${mm}`;
}

export default function CharacterAcquisitionModal({ open, context, onClose, onConfirm }: Props) {
  const [costDraft, setCostDraft] = useState("");
  const [personalFee, setPersonalFee] = useState<0 | 25 | 50>(0);
  const [error, setError] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [waCopied, setWaCopied] = useState(false);
  const waCopiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) return;
    const detected = Number(context?.detectedOriginalCost || 0);
    setCostDraft(detected > 0 ? String(Math.floor(detected)) : "");
    setPersonalFee(0);
    setError("");
    setIsSaving(false);
    setWaCopied(false);
  }, [open, context?.characterName, context?.detectedOriginalCost]);

  useEffect(() => () => {
    if (waCopiedTimer.current) clearTimeout(waCopiedTimer.current);
  }, []);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !isSaving) onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, isSaving, onClose]);

  const originalCost = useMemo(() => {
    if (!/^\d+$/.test(costDraft)) return null;
    const value = Number(costDraft);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }, [costDraft]);
  const bazaarFee = 50;
  // O comprador transfere ao vendedor o valor integral, incluindo Bazaar.
  const sellerReceived = (originalCost ?? 0) + personalFee + bazaarFee;

  if (!open || !context) return null;

  /**
   * Gera o resumo compacto da negociação no formato WhatsApp e copia para a
   * área de transferência. Usa EXATAMENTE os valores exibidos/calculados pelo
   * modal neste instante (originalCost, personalFee, bazaarFee,
   * sellerReceived) — nenhuma segunda lógica financeira. A data/hora é o
   * momento exato do clique, no horário local do usuário.
   */
  function copyWhatsAppSummary() {
    if (!context) return;
    const linhas = [
      "🧾 *Venda de Char — Chernobyl PT*",
      "",
      `🎯 *Personagem:* ${context.characterName}${context.server ? ` (${context.server})` : ""}`,
      `🤝 *Vendedor:* ${context.originalOwnerName || "—"}`,
      `👤 *Comprador:* ${context.acquirerName || "—"}`,
      "",
      `💰 Valor do personagem: ${formatRC(originalCost ?? 0)}`,
      `➕ Taxa pessoal: ${formatRC(personalFee)}`,
      `➕ Taxa Bazaar: ${formatRC(bazaarFee)}`,
      `✅ *Vendedor recebe: ${formatRC(sellerReceived)}*`,
      "",
      `🕒 Gerado em ${formatLocalDateTime(Date.now())}`,
    ];
    copyTextToClipboard(linhas.join("\n"));
    setWaCopied(true);
    if (waCopiedTimer.current) clearTimeout(waCopiedTimer.current);
    waCopiedTimer.current = setTimeout(() => setWaCopied(false), 2000);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (originalCost === null) {
      setError("Informe um valor original válido para o personagem.");
      return;
    }
    setIsSaving(true);
    setError("");
    try {
      const result = await onConfirm({ originalCharacterCost: originalCost, personalFee });
      if (!result.ok) {
        setError(result.error || "Não foi possível registrar a negociação.");
        return;
      }
      onClose();
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div
      className="app-modal-overlay fixed inset-0 z-[700] flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onMouseDown={event => { if (event.target === event.currentTarget && !isSaving) onClose(); }}
    >
      <form onSubmit={submit} className="app-modal-frame app-modal-size-md app-modal-frame--scroll w-full max-w-lg rounded-2xl border border-amber-500/35 bg-[var(--th-bg-base)] shadow-2xl shadow-black/70">
        <header className="flex items-center justify-between border-b border-[var(--th-line)]/50 bg-gradient-to-r from-amber-500/10 via-[var(--th-bg-raised)] to-sky-500/10 px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl border border-amber-400/35 bg-amber-500/15 text-amber-300">
              <ReceiptText size={18} />
            </div>
            <div className="min-w-0">
              <h2 className="truncate text-base font-black text-slate-100">Vender Char</h2>
              <p className="truncate text-[10px] text-slate-400">Negociação de uso na Quest, sem transferir o dono original.</p>
            </div>
          </div>
          <button type="button" onClick={onClose} disabled={isSaving} className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-40" aria-label="Fechar modal">
            <X size={17} />
          </button>
        </header>

        <div className="app-modal-body space-y-3 p-4 sm:p-5">
          <section className="rounded-xl border border-[var(--th-line)]/60 bg-black/20 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-[9px] font-black uppercase tracking-wider text-slate-500">Personagem</div>
                <div className="text-sm font-black text-slate-100">{context.characterName}</div>
              </div>
              <div className="rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1 text-right font-mono text-[10px] text-slate-300">
                {context.server || "—"} · {context.vocation || "—"} · Lv {context.level || 0}
              </div>
            </div>
          </section>

          <section className="flex items-center gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.06] px-3 py-2">
            <UserRound size={13} className="flex-shrink-0 text-emerald-300" />
            <div className="min-w-0">
              <div className="text-[9px] font-black uppercase tracking-wider text-emerald-300">Comprador · jogador</div>
              <div className="truncate text-xs font-bold text-slate-100">{context.acquirerName || "—"}</div>
            </div>
          </section>

          <section className="rounded-xl border border-[var(--th-line)]/60 bg-[var(--th-bg-raised)]/60 p-3">
            <label className="block text-[10px] font-black uppercase tracking-wider text-slate-400">
              Valor original do personagem no Bazaar
              <div className="relative mt-1.5">
                <Coins size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-amber-400" />
                <input
                  autoFocus
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={costDraft}
                  onChange={event => { setCostDraft(normalizeCostDraft(event.target.value)); setError(""); }}
                  placeholder={context.detectedOriginalCost ? "Valor encontrado" : "Informe o valor"}
                  className={`h-10 w-full rounded-lg border bg-black/30 pl-8 pr-3 text-right font-mono text-sm text-white outline-none transition-colors placeholder:text-slate-600 focus:border-amber-400/65 ${error ? "border-rose-400/60" : "border-[var(--th-line)]/70"}`}
                />
              </div>
            </label>
            {context.detectedOriginalCost ? (
              <p className="mt-1.5 text-[10px] text-emerald-300">Valor encontrado automaticamente no cadastro atual. Você pode ajustá-lo se necessário.</p>
            ) : (
              <p className="mt-1.5 text-[10px] text-amber-300">Não há custo registrado no personagem. Informe o valor para continuar.</p>
            )}
          </section>

          <section className="rounded-xl border border-[var(--th-line)]/60 bg-black/20 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-xs font-bold text-slate-200">Taxa pessoal</span>
              <span className="text-[9px] text-slate-500">Definida por você</span>
            </div>
            <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label="Taxa pessoal">
              {([0, 25, 50] as const).map(value => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={personalFee === value}
                  onClick={() => setPersonalFee(value)}
                  className={`rounded-lg border px-2 py-1.5 text-[10px] font-black transition-all cursor-pointer ${
                    personalFee === value
                      ? "border-amber-400/65 bg-amber-500/20 text-amber-100 shadow-[0_0_10px_rgba(251,191,36,0.14)]"
                      : "border-white/10 bg-white/[0.03] text-slate-400 hover:bg-white/[0.08] hover:text-slate-200"
                  }`}
                >
                  {value === 0 ? "Nenhuma" : `+ ${value} RC`}
                </button>
              ))}
            </div>
          </section>

          <label className="flex items-center justify-between gap-3 rounded-lg border border-sky-500/25 bg-sky-500/[0.06] px-3 py-2">
            <span>
              <span className="flex items-center gap-1 text-xs font-bold text-slate-200"><Lock size={11} className="text-sky-300" /> Taxa Bazaar selecionada</span>
              <span className="block text-[9px] text-slate-500">{formatRC(bazaarFee)} · obrigatória nesta negociação.</span>
            </span>
            <input type="checkbox" checked disabled className="h-4 w-4 accent-sky-500" aria-label="Taxa Bazaar de 50 RC selecionada" />
          </label>

          <section className="rounded-xl border border-emerald-400/35 bg-emerald-500/[0.09] p-3">
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px]">
              <span className="text-slate-400">Valor do personagem</span><span className="text-right font-mono text-slate-200">{formatRC(originalCost ?? 0)}</span>
              <span className="text-slate-400">Taxa pessoal</span><span className="text-right font-mono text-amber-300">+ {formatRC(personalFee)}</span>
              <span className="text-slate-400">Taxa Bazaar</span><span className="text-right font-mono text-sky-300">+ {formatRC(bazaarFee)}</span>
            </div>
            <div className="mt-2 flex items-center justify-between border-t border-emerald-400/20 pt-2">
              <span className="text-[10px] font-black uppercase tracking-wider text-emerald-200">Você receberá do comprador</span>
              <span className="font-mono text-lg font-black text-emerald-300">{formatRC(sellerReceived)}</span>
            </div>
          </section>
          {error && <p role="alert" className="text-center text-[11px] font-medium text-rose-300">{error}</p>}
        </div>

        <footer className="app-modal-footer flex flex-wrap items-center justify-between gap-2 border-t border-[var(--th-line)]/40 bg-[var(--th-bg-raised)] px-4 sm:px-5 py-3">
          {/* Copiar (WA): gera o resumo compacto da negociação com os valores
              atuais e copia para a área de transferência — sem abrir modal. */}
          <button
            type="button"
            onClick={copyWhatsAppSummary}
            disabled={isSaving}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-bold transition-colors cursor-pointer disabled:opacity-40 ${
              waCopied
                ? "border-emerald-500/50 bg-emerald-500/30 text-emerald-200"
                : "border-sky-500/40 bg-sky-500/15 text-sky-300 hover:bg-sky-500/25 hover:text-sky-200"
            }`}
            title={waCopied ? "Resumo copiado!" : "Copiar resumo da negociação para o WhatsApp"}
          >
            {waCopied ? <Check size={13} /> : <Copy size={13} />} {waCopied ? "Copiado!" : "Copiar (WA)"}
          </button>
          <div className="flex gap-2">
          <button type="button" onClick={onClose} disabled={isSaving} className="rounded-lg border border-white/10 bg-white/[0.04] px-4 py-2 text-xs font-bold text-slate-300 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-40">Cancelar</button>
          <button type="submit" disabled={isSaving} className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-400/45 bg-emerald-500/15 px-4 py-2 text-xs font-black text-emerald-200 transition-colors hover:bg-emerald-500/25 disabled:cursor-wait disabled:opacity-55">
            <Check size={13} /> {isSaving ? "Pré-aprovando..." : "Pré-aprovar venda"}
          </button>
          </div>
        </footer>
      </form>
    </div>
  );
}