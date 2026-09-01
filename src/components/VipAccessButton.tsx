import { useState } from "react";
import { Crown } from "lucide-react";
import type { UserProfile } from "../context/AuthContext";
import { getVipRemainingDays } from "../utils/vipAccess";
import BecomeVIPModal from "./BecomeVIPModal";
import VIPModal from "./VIPModal";

interface VipAccessButtonProps {
  userProfile: UserProfile | null;
}

type VipFlow = "vip" | "become" | null;

/**
 * Gatilho único usado nas barras da aplicação. Ele apenas identifica o acesso
 * atual e encaminha diretamente para o modal correspondente, mantendo os dois
 * fluxos visual e estruturalmente independentes.
 */
export default function VipAccessButton({ userProfile }: VipAccessButtonProps) {
  const [activeFlow, setActiveFlow] = useState<VipFlow>(null);
  const remainingVipDays = getVipRemainingDays(userProfile);
  const hasVipStyle = userProfile?.role === "Boss" || remainingVipDays > 0;
  const label = hasVipStyle ? "VIP" : "SEJA VIP";

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        data-vip-flow={hasVipStyle ? "vip" : "seja-vip"}
        onClick={() => setActiveFlow(hasVipStyle ? "vip" : "become")}
        className={`relative inline-flex items-center gap-1 overflow-hidden rounded-md border px-2.5 py-1 text-[9px] font-black uppercase tracking-wider transition-transform hover:scale-[1.03] active:scale-[0.98] cursor-pointer select-none ${
          hasVipStyle
            ? "border-amber-400/60 text-amber-200"
            : "border-violet-400/60 text-violet-200"
        }`}
        style={hasVipStyle ? {
          background: "linear-gradient(135deg, color-mix(in oklab, var(--color-amber-500) 25%, transparent) 0%, color-mix(in oklab, var(--color-amber-500) 18%, transparent) 50%, color-mix(in oklab, var(--color-amber-500) 22%, transparent) 100%)",
          boxShadow: "0 0 12px color-mix(in oklab, var(--color-amber-500) 35%, transparent), inset 0 0 8px color-mix(in oklab, var(--color-amber-500) 15%, transparent)",
        } : {
          background: "linear-gradient(135deg, rgba(139,92,246,0.25) 0%, rgba(124,58,237,0.18) 50%, rgba(91,33,182,0.22) 100%)",
          boxShadow: "0 0 12px rgba(139,92,246,0.30), inset 0 0 8px rgba(139,92,246,0.12)",
        }}
        title={hasVipStyle ? "Membro VIP — abrir Painel VIP" : "Seja VIP — abrir contratação VIP"}
      >
        <span
          className="pointer-events-none absolute inset-0 -translate-x-full"
          style={{
            background: "linear-gradient(110deg, transparent 30%, rgba(255,255,255,0.45) 50%, transparent 70%)",
            animation: "vipShimmer 2.6s ease-in-out infinite",
          }}
        />
        <Crown
          size={11}
          className={`relative z-10 ${hasVipStyle ? "text-amber-300" : "text-violet-300"}`}
          style={{
            filter: hasVipStyle
              ? "drop-shadow(0 0 4px color-mix(in oklab, var(--color-amber-500) 90%, transparent)) drop-shadow(0 0 8px color-mix(in oklab, var(--color-amber-500) 55%, transparent))"
              : "drop-shadow(0 0 4px rgba(196,181,253,0.9)) drop-shadow(0 0 8px rgba(139,92,246,0.55))",
          }}
        />
        <span
          className={`relative z-10 bg-clip-text text-transparent ${hasVipStyle ? "bg-gradient-to-r from-amber-200 via-yellow-100 to-amber-300" : "bg-gradient-to-r from-violet-200 via-fuchsia-100 to-violet-300"}`}
          style={{
            filter: hasVipStyle
              ? "drop-shadow(0 0 3px color-mix(in oklab, var(--color-amber-500) 50%, transparent))"
              : "drop-shadow(0 0 3px rgba(139,92,246,0.5))",
          }}
        >
          {label}
        </span>
        <style>{`
          @keyframes vipShimmer {
            0% { transform: translateX(-100%); }
            60%, 100% { transform: translateX(200%); }
          }
        `}</style>
      </button>

      <VIPModal
        open={activeFlow === "vip"}
        onClose={() => setActiveFlow(null)}
        onOpenBecomeVip={() => setActiveFlow("become")}
        userProfile={userProfile}
      />
      <BecomeVIPModal
        open={activeFlow === "become"}
        onClose={() => setActiveFlow(null)}
        userProfile={userProfile}
      />
    </>
  );
}