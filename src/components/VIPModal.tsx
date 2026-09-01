import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { CalendarDays, Clock, Crown, Sparkles, X } from "lucide-react";
import type { UserProfile } from "../context/AuthContext";
import {
  formatVipExpirationDate,
  formatVipRemainingTime,
  getVipEffectiveExpirationMillis,
  getVipRemainingDays,
} from "../utils/vipAccess";
import VipBenefitsModal from "./VipBenefitsModal";

interface VIPModalProps {
  open: boolean;
  onClose: () => void;
  /** Abre o fluxo independente de contratação/renovação, sem aba compartilhada. */
  onOpenBecomeVip: () => void;
  userProfile: UserProfile | null;
}

/**
 * Painel exclusivo de status VIP. Não contém contratação: quem já possui
 * acesso entra diretamente nos dados de validade e tempo restante.
 */
export default function VIPModal({ open, onClose, onOpenBecomeVip, userProfile }: VIPModalProps) {
  const [benefitsOpen, setBenefitsOpen] = useState(false);
  const [vipClock, setVipClock] = useState(() => Date.now());

  useEffect(() => {
    if (!open) {
      setBenefitsOpen(false);
      return;
    }

    const updateVipClock = () => setVipClock(Date.now());
    updateVipClock();
    const interval = window.setInterval(updateVipClock, 60_000);
    const now = Date.now();
    const expiresAt = getVipEffectiveExpirationMillis(userProfile, now);
    const timeout = expiresAt > now
      ? window.setTimeout(updateVipClock, Math.min(expiresAt - now + 50, 2_147_483_647))
      : null;

    return () => {
      window.clearInterval(interval);
      if (timeout) window.clearTimeout(timeout);
    };
  }, [open, userProfile?.vipDays, userProfile?.vipExpiresAt]);

  const remainingVipDays = getVipRemainingDays(userProfile, vipClock);
  const vipExpiration = getVipEffectiveExpirationMillis(userProfile, vipClock);
  const isBoss = userProfile?.role === "Boss";

  const closeModal = () => {
    setBenefitsOpen(false);
    onClose();
  };

  return (
    <>
      {open && createPortal(
        <div
          className="app-modal-overlay fixed inset-0 z-[600] flex items-center justify-center bg-black/80 backdrop-blur-sm animate-in fade-in duration-200"
          onMouseDown={event => { if (event.target === event.currentTarget) closeModal(); }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Painel VIP"
            className="app-modal-frame app-modal-size-xs app-modal-frame--scroll w-full rounded-2xl border border-amber-500/45 bg-[var(--th-bg-base)] shadow-2xl shadow-amber-950/50 animate-in zoom-in-95 duration-200"
          >
            <header className="app-modal-header flex items-center justify-between gap-3 border-b border-amber-500/25 bg-gradient-to-r from-amber-950/45 via-amber-900/18 to-[var(--th-bg-base)] px-4 py-3.5">
              <div className="flex min-w-0 items-center gap-2.5">
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl border border-amber-500/40 bg-amber-500/15 shadow-inner shadow-amber-500/10">
                  <Crown size={16} className="text-amber-300" />
                </div>
                <div className="min-w-0">
                  <h2 className="truncate text-sm font-black uppercase tracking-wide text-amber-200">Meu VIP</h2>
                  <p className="text-[10px] text-slate-400">Acompanhe seu acesso e tempo disponível.</p>
                </div>
              </div>
              <button
                type="button"
                onClick={closeModal}
                aria-label="Fechar painel VIP"
                className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-amber-500/10 hover:text-white cursor-pointer"
              >
                <X size={16} />
              </button>
            </header>

            <div className="app-modal-body p-4 sm:p-5">
              <div className="space-y-3">
                <div className="relative overflow-hidden rounded-2xl border border-amber-500/30 bg-gradient-to-br from-amber-500/14 via-amber-500/[0.06] to-transparent px-4 py-4 text-center">
                  <div className="pointer-events-none absolute -right-5 -top-5 h-20 w-20 rounded-full bg-amber-400/10 blur-2xl" />
                  <div className="relative mx-auto flex h-11 w-11 items-center justify-center rounded-2xl border border-amber-500/35 bg-amber-500/12 shadow-inner shadow-amber-500/15">
                    <Crown size={22} className="text-amber-300" />
                  </div>
                  <p className="relative mt-2 text-[10px] font-black uppercase tracking-[0.16em] text-amber-300/80">
                    {isBoss ? "Acesso administrativo" : "Membro VIP ativo"}
                  </p>
                  <strong className="relative mt-1 block text-lg font-black tabular-nums text-amber-100">
                    {isBoss ? "Acesso permanente" : `${remainingVipDays} ${remainingVipDays === 1 ? "dia restante" : "dias restantes"}`}
                  </strong>
                </div>

                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <div className="rounded-xl border border-amber-500/20 bg-black/20 px-3 py-2.5">
                    <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                      <CalendarDays size={12} className="text-amber-400" />
                      VIP ativo até
                    </div>
                    <strong className="mt-1 block text-[11px] tabular-nums text-amber-100">
                      {isBoss ? "Acesso permanente" : formatVipExpirationDate(vipExpiration)}
                    </strong>
                  </div>
                  <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] px-3 py-2.5">
                    <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                      <Clock size={12} className="text-emerald-400" />
                      Tempo restante
                    </div>
                    <strong className="mt-1 block text-[11px] tabular-nums text-emerald-300">
                      {isBoss ? "Sem expiração" : formatVipRemainingTime(vipExpiration, vipClock)}
                    </strong>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => setBenefitsOpen(true)}
                  className="flex w-full items-center justify-between gap-3 rounded-xl border border-amber-500/28 bg-amber-500/[0.07] px-3.5 py-3 text-left transition-colors hover:bg-amber-500/[0.12] cursor-pointer"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg border border-amber-500/30 bg-amber-500/10">
                      <Sparkles size={14} className="text-amber-300" />
                    </span>
                    <span className="min-w-0">
                      <strong className="block text-xs font-black text-amber-100">Benefícios Inclusos</strong>
                      <span className="block truncate text-[10px] text-slate-400">Consulte todos os recursos exclusivos do VIP.</span>
                    </span>
                  </span>
                  <span className="text-xs font-black text-amber-300">Ver</span>
                </button>
              </div>
            </div>

            <footer className="app-modal-footer flex flex-wrap items-center justify-between gap-2 border-t border-amber-500/20 bg-black/30 px-4 py-3">
              <button
                type="button"
                onClick={onOpenBecomeVip}
                className="rounded-xl border border-amber-500/35 bg-amber-500/[0.08] px-3 py-2 text-xs font-black text-amber-200 transition-colors hover:bg-amber-500/[0.16] cursor-pointer"
              >
                Renovar / Seja VIP
              </button>
              <button
                type="button"
                onClick={closeModal}
                className="rounded-xl bg-gradient-to-r from-amber-500 to-amber-400 px-4 py-2 text-xs font-black text-black shadow-md shadow-amber-950/30 transition-colors hover:from-amber-400 hover:to-amber-300 cursor-pointer"
              >
                Fechar
              </button>
            </footer>
          </section>
        </div>,
        document.body,
      )}

      <VipBenefitsModal open={open && benefitsOpen} onClose={() => setBenefitsOpen(false)} />
    </>
  );
}