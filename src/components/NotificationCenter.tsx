import { useState, useEffect, useRef, useCallback } from "react";
import { Bell, BellOff, Check, X, ShieldAlert, Clock, Info, DollarSign, ExternalLink, Crown, Heart, CheckCircle2, ShoppingBag, Briefcase, BellRing } from "lucide-react";
import type { Notification } from "../types/notifications";
import { checkPermission } from "../utils/desktopNotify";
import { dispatchNotificationNavigate } from "../utils/notificationNavigation";
import { formatHourMinuteWithOffset, readBazarTimezoneOffsetMinutes } from "../utils/bazaarTime";
import ThemeSelector from "./ThemeSelector";
import NotificationSettingsModal from "./NotificationSettingsModal";

interface Props {
  notifications: Notification[];
  onMarkDone: (id: string) => void;
  onMarkAllDone: () => void;
  onClearDone: () => void;
  onClose: () => void;
  desktopEnabled: boolean;
  onToggleDesktop: (v: boolean) => void;
  closeTray: boolean;
  onToggleCloseTray: (v: boolean) => void;
  startWithWindows: boolean;
  onToggleStartWithWindows: (v: boolean) => void;
  lowCpuUsage: boolean;
  onToggleLowCpuUsage: (v: boolean) => void;
  userRole?: string;
  // Abre o DonationModal a partir da notificação "Quest Concluída" (botão Doar).
  onOpenDonation?: () => void;
  // Atualiza personagens a partir da notificação "Quest Concluída" (botão Att Chars).
  // Agora utiliza apenas o partyId para buscar a versão mais recente da PT
  // diretamente nas coleções do Firestore (ativas ou arquivadas).
  onUpdateCharacters?: (params: {
    notificationId: string;
    partyId: string;
    questType: "soulwar" | "sanguine";
  }) => Promise<boolean> | boolean;
  // Auto-Att: estado e toggle
  autoCharUpdate?: boolean;
  onToggleAutoCharUpdate?: (v: boolean) => void;
}

// Detecção de ambiente — mesmo critério já usado em App.tsx, BazarPanel.tsx e
// utils/openExternal.ts: só o Electron expõe window.require.
// Avaliado uma vez, no módulo, pois o ambiente não muda em runtime.
const isElectron = typeof window !== "undefined" && !!(window as any).require;

function openExternalUrl(url?: string) {
  if (!url) return;
  try {
    const electronRequire = (window as any).require;
    if (electronRequire) {
      const { shell } = electronRequire("electron");
      shell.openExternal(url);
      return;
    }
  } catch {}
  window.open(url, "_blank", "noopener,noreferrer");
}

/* ─── Premium Checkbox Component ─── */
function PremiumCheckbox({
  id,
  checked,
  onChange,
  disabled,
}: {
  id: string;
  checked: boolean;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  disabled?: boolean;
}) {
  return (
    <label
      htmlFor={id}
      className={`
        relative flex-shrink-0
        w-5 h-5 rounded-[6px]
        flex items-center justify-center
        transition-all duration-200 ease-out
        ${disabled
          ? "bg-white/[0.04] border border-white/[0.08] cursor-not-allowed opacity-40"
          : checked
            ? "cursor-pointer"
            : "bg-white/[0.06] border-[1.5px] border-white/[0.14] hover:border-[#b91c1c]/40 hover:bg-[var(--th-brand)]/20 cursor-pointer"
        }
      `}
      style={!disabled && checked ? {
        background: "var(--th-brand)",
        border: "1.5px solid color-mix(in oklab, var(--color-red-600) 55%, transparent)",
        boxShadow: "0 0 6px color-mix(in oklab, var(--color-red-600) 15%, transparent), inset 0 1px 0 rgba(255,255,255,0.04)",
      } : {}}
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        className="sr-only"
      />
      <svg
        className={`
          w-3 h-3
          transition-all duration-200 ease-out
          ${checked
            ? "opacity-100 scale-100"
            : "opacity-0 scale-75"
          }
        `}
        viewBox="0 0 12 12"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M2.5 6.5L5 9L9.5 3.5"
          stroke="#f87171"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </label>
  );
}

function getRelativeTime(timestamp: number): string {
  if (!timestamp || !Number.isFinite(timestamp)) return "—";
  const ts = timestamp < 1e12 ? timestamp * 1000 : timestamp;
  const now = Date.now();
  const diffMs = now - ts;
  if (diffMs < 0 || !Number.isFinite(diffMs)) return "Agora";
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "Agora";
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function getQuestLabel(questType?: Notification["questType"]): string | null {
  if (questType === "soulwar") return "SW";
  if (questType === "sanguine") return "SG";
  return null;
}

function formatScheduledBadge(scheduledTime?: number): string | null {
  if (!scheduledTime || !Number.isFinite(scheduledTime)) return null;
  return new Date(scheduledTime).toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatBazaarEndTime(scheduledTime?: number): string | null {
  if (!scheduledTime || !Number.isFinite(scheduledTime)) return null;
  return formatHourMinuteWithOffset(scheduledTime, readBazarTimezoneOffsetMinutes());
}

function renderNotificationBody(n: Notification, className: string) {
  if (n.type === "service_request") {
    // O corpo chega como "<Personagem> — <descrição>". Separar permite
    // destacar o nome do personagem, que é a informação mais importante.
    const [charName, ...rest] = String(n.body || "").split("—");
    const detail = rest.join("—").trim();
    return (
      <div className={`${className} flex flex-col gap-0.5`}>
        <span className="font-black text-sky-200 truncate">{charName.trim() || "Personagem"}</span>
        <span className="text-slate-400 text-[10px] leading-snug">
          {detail || "Nova solicitação de Service aguardando aprovação."}
        </span>
      </div>
    );
  }
  if (n.type === "service_waiting") {
    // O corpo chega como "<Personagem> — <detalhe>". Destaca o nome do
    // personagem, que é a informação mais importante para a triagem.
    const [charName, ...rest] = String(n.body || "").split("—");
    const detail = rest.join("—").trim();
    return (
      <div className={`${className} flex flex-col gap-0.5`}>
        <span className="font-black text-cyan-200 truncate">{charName.trim() || "Personagem"}</span>
        <span className="text-slate-400 text-[10px] leading-snug">
          {detail || "Novo personagem de Service aguardando triagem na guia Services."}
        </span>
      </div>
    );
  }
  if (n.type === "bazaar_interest_ending") {
    const endTime = formatBazaarEndTime(n.scheduledTime);
    return (
      <div className={`${className} flex items-center gap-1.5`}>
        <Clock size={11} className="text-amber-300 flex-shrink-0" />
        <span className="text-slate-400">Encerra às</span>
        <span className="font-mono font-black text-amber-300">{endTime || "--:--"}</span>
      </div>
    );
  }
  return <p className={className}>{n.body}</p>;
}

function getReminderBadge(title: string): string | null {
  const match = title.match(/(\d+)/);
  return match?.[1] ? `${match[1]}m` : null;
}

function getNotificationBadges(n: Notification): string[] {
  const badges: string[] = [];
  const questLabel = getQuestLabel(n.questType);

  if (n.type === "vip_approved" && typeof n.vipDays === "number" && n.vipDays > 0) {
    badges.push(`+${n.vipDays}d`);
  }
  if (n.type === "payment_received") {
    if (n.paidAmountFormatted) badges.push(n.paidAmountFormatted);
    else if (typeof n.vipDays === "number" && n.vipDays > 0) badges.push(`+${n.vipDays}d`);
  }
  if (n.type === "pt_reminder") {
    const reminder = getReminderBadge(n.title);
    if (reminder) badges.push(reminder);
  }
  if (n.type === "schedule_changed") {
    const scheduled = formatScheduledBadge(n.scheduledTime);
    if (scheduled) badges.push(scheduled);
  }
  if (n.type === "update_available" && n.updateVersion) {
    badges.push(`v${n.updateVersion}`);
  }
  if (n.type === "bazaar_interest_ending") {
    const endTime = formatBazaarEndTime(n.scheduledTime);
    if (endTime) badges.push(endTime);
  }
  if (n.type === "service_request") {
    badges.push("Pendente");
  }
  if (n.type === "service_waiting") {
    badges.push("Triagem");
  }
  if ((n.type === "pt_added" || n.type === "quest_completed_donation" || n.type === "pt_updated" || n.type === "schedule_changed" || n.type === "party_finalized" || n.type === "service_waiting") && questLabel) {
    badges.push(questLabel);
  }

  return badges.slice(0, 2);
}

function getNotificationTheme(type: Notification["type"]) {
  switch (type) {
    case "service_request":
      return {
        pendingCard: "relative px-2.5 py-2 rounded-lg border border-sky-500/35 bg-gradient-to-r from-sky-900/25 via-sky-800/10 to-transparent flex flex-col gap-1.5 shadow-[0_0_18px_rgba(56,189,248,0.10)] overflow-hidden",
        historyCard: "px-2.5 py-1.5 rounded-lg border border-sky-500/15 bg-sky-500/[0.04] opacity-60 hover:opacity-100 transition-opacity flex flex-col gap-0.5",
        stripe: "from-sky-300 via-sky-400 to-sky-600",
        iconWrap: "bg-sky-500/15 border border-sky-400/30 text-sky-200",
        pendingTitle: "text-[11px] font-black tracking-tight text-sky-100 truncate",
        historyTitle: "text-[10px] font-bold text-sky-200/85 truncate",
        pendingBody: "text-[11px] leading-snug",
        historyBody: "text-[10px] text-sky-100/45 line-clamp-1",
        badge: "border-sky-400/40 text-sky-200 bg-sky-500/15",
        historyBadge: "border-sky-400/30 text-sky-300/80 bg-sky-500/10",
      };
    case "service_waiting":
      return {
        pendingCard: "relative px-2.5 py-2 rounded-lg border border-cyan-500/35 bg-gradient-to-r from-cyan-950/25 via-cyan-900/10 to-transparent flex flex-col gap-1.5 shadow-[0_0_18px_rgba(34,211,238,0.10)] overflow-hidden",
        historyCard: "px-2.5 py-1.5 rounded-lg border border-cyan-500/15 bg-cyan-500/[0.04] opacity-60 hover:opacity-100 transition-opacity flex flex-col gap-0.5",
        stripe: "from-cyan-300 via-cyan-400 to-sky-600",
        iconWrap: "bg-cyan-500/15 border border-cyan-400/30 text-cyan-200",
        pendingTitle: "text-[11px] font-black tracking-tight text-cyan-100 truncate",
        historyTitle: "text-[10px] font-bold text-cyan-200/85 truncate",
        pendingBody: "text-[11px] leading-snug",
        historyBody: "text-[10px] text-cyan-100/45 line-clamp-1",
        badge: "border-cyan-400/40 text-cyan-200 bg-cyan-500/15",
        historyBadge: "border-cyan-400/30 text-cyan-300/80 bg-cyan-500/10",
      };
    case "bazaar_interest_ending":
      return {
        pendingCard: "relative px-2.5 py-2 rounded-lg border border-amber-500/30 bg-gradient-to-r from-amber-950/25 via-cyan-950/10 to-transparent flex flex-col gap-1.5 shadow-[0_0_18px_color-mix(in_oklab,var(--color-amber-500)_8%,transparent)] overflow-hidden",
        historyCard: "px-2.5 py-1.5 rounded-lg border border-amber-500/10 bg-amber-500/[0.04] opacity-60 hover:opacity-100 transition-opacity flex flex-col gap-0.5",
        stripe: "from-amber-300 via-cyan-400 to-amber-600",
        iconWrap: "bg-amber-500/15 border border-amber-400/25 text-amber-200",
        pendingTitle: "text-[11px] font-black tracking-tight text-amber-100 truncate",
        historyTitle: "text-[10px] font-bold text-amber-200/80 truncate",
        pendingBody: "text-[11px] leading-snug",
        historyBody: "text-[10px] leading-snug",
        badge: "border-amber-400/35 text-amber-200 bg-amber-500/15",
        historyBadge: "border-amber-400/25 text-amber-300/80 bg-amber-500/10",
      };
    case "vip_approved":
      return {
        pendingCard: "relative px-2.5 py-2 rounded-lg border border-amber-500/35 bg-gradient-to-r from-amber-900/25 via-amber-800/10 to-transparent flex flex-col gap-1.5 shadow-[0_0_18px_color-mix(in_oklab,var(--color-amber-500)_8%,transparent)] overflow-hidden",
        historyCard: "px-2.5 py-1.5 rounded-lg border border-amber-500/15 bg-amber-500/[0.04] opacity-60 hover:opacity-100 transition-opacity flex flex-col gap-0.5",
        stripe: "from-amber-300 via-amber-400 to-amber-600",
        iconWrap: "bg-amber-500/15 border border-amber-400/30 text-amber-200",
        pendingTitle: "text-[11px] font-black tracking-tight bg-gradient-to-r from-amber-200 via-amber-100 to-amber-300 bg-clip-text text-transparent truncate",
        historyTitle: "text-[10px] font-bold text-amber-200/85 truncate",
        pendingBody: "text-[11px] text-amber-100/85 leading-snug line-clamp-2",
        historyBody: "text-[10px] text-amber-100/45 line-clamp-1",
        badge: "border-amber-400/40 text-amber-200 bg-amber-500/15",
        historyBadge: "border-amber-400/30 text-amber-300/80 bg-amber-500/10",
      };
    case "payment_received":
      return {
        pendingCard: "relative px-2.5 py-2 rounded-lg border border-emerald-500/30 bg-gradient-to-r from-emerald-900/20 via-emerald-800/10 to-transparent flex flex-col gap-1.5 shadow-[0_0_18px_rgba(16,185,129,0.08)] overflow-hidden",
        historyCard: "px-2.5 py-1.5 rounded-lg border border-emerald-500/10 bg-emerald-500/[0.04] opacity-60 hover:opacity-100 transition-opacity flex flex-col gap-0.5",
        stripe: "from-emerald-300 via-emerald-400 to-emerald-600",
        iconWrap: "bg-emerald-500/15 border border-emerald-400/25 text-emerald-200",
        pendingTitle: "text-[11px] font-black tracking-tight text-emerald-100 truncate",
        historyTitle: "text-[10px] font-bold text-emerald-200/80 truncate",
        pendingBody: "text-[11px] text-emerald-100/80 leading-snug line-clamp-2",
        historyBody: "text-[10px] text-emerald-100/40 line-clamp-1",
        badge: "border-emerald-400/35 text-emerald-200 bg-emerald-500/15",
        historyBadge: "border-emerald-400/25 text-emerald-300/80 bg-emerald-500/10",
      };
    case "party_finalized":
      return {
        pendingCard: "relative px-2.5 py-2 rounded-lg border border-emerald-500/30 bg-gradient-to-r from-emerald-900/20 via-emerald-800/10 to-transparent flex flex-col gap-1.5 shadow-[0_0_18px_rgba(16,185,129,0.08)] overflow-hidden",
        historyCard: "px-2.5 py-1.5 rounded-lg border border-emerald-500/10 bg-emerald-500/[0.04] opacity-60 hover:opacity-100 transition-opacity flex flex-col gap-0.5",
        stripe: "from-emerald-300 via-emerald-400 to-emerald-600",
        iconWrap: "bg-emerald-500/15 border border-emerald-400/25 text-emerald-200",
        pendingTitle: "text-[11px] font-black tracking-tight text-emerald-100 truncate",
        historyTitle: "text-[10px] font-bold text-emerald-200/80 truncate",
        pendingBody: "text-[11px] text-emerald-100/80 leading-snug line-clamp-2",
        historyBody: "text-[10px] text-emerald-100/40 line-clamp-1",
        badge: "border-emerald-400/35 text-emerald-200 bg-emerald-500/15",
        historyBadge: "border-emerald-400/25 text-emerald-300/80 bg-emerald-500/10",
      };
    case "quest_completed_donation":
      return {
        pendingCard: "relative px-2.5 py-2 rounded-lg border border-rose-500/30 bg-gradient-to-r from-rose-950/25 via-amber-900/10 to-transparent flex flex-col gap-1.5 shadow-[0_0_18px_color-mix(in_oklab,var(--color-red-600)_8%,transparent)] overflow-hidden",
        historyCard: "px-2.5 py-1.5 rounded-lg border border-rose-500/10 bg-rose-500/[0.04] opacity-60 hover:opacity-100 transition-opacity flex flex-col gap-0.5",
        stripe: "from-rose-300 via-amber-400 to-amber-600",
        iconWrap: "bg-rose-500/15 border border-rose-400/25 text-rose-200",
        pendingTitle: "text-[11px] font-black tracking-tight text-rose-100 truncate",
        historyTitle: "text-[10px] font-bold text-rose-200/80 truncate",
        pendingBody: "text-[11px] text-rose-100/80 leading-snug line-clamp-2",
        historyBody: "text-[10px] text-rose-100/40 line-clamp-1",
        badge: "border-rose-400/35 text-rose-200 bg-rose-500/15",
        historyBadge: "border-rose-400/25 text-rose-300/80 bg-rose-500/10",
      };
    case "pt_reminder":
      return {
        pendingCard: "relative px-2.5 py-2 rounded-lg border border-amber-500/30 bg-gradient-to-r from-amber-950/25 via-amber-900/10 to-transparent flex flex-col gap-1.5 shadow-[0_0_18px_color-mix(in_oklab,var(--color-amber-500)_8%,transparent)] overflow-hidden",
        historyCard: "px-2.5 py-1.5 rounded-lg border border-amber-500/10 bg-amber-500/[0.04] opacity-60 hover:opacity-100 transition-opacity flex flex-col gap-0.5",
        stripe: "from-amber-300 via-amber-400 to-orange-500",
        iconWrap: "bg-amber-500/15 border border-amber-400/25 text-amber-200",
        pendingTitle: "text-[11px] font-black tracking-tight text-amber-100 truncate",
        historyTitle: "text-[10px] font-bold text-amber-200/80 truncate",
        pendingBody: "text-[11px] text-amber-100/78 leading-snug line-clamp-2",
        historyBody: "text-[10px] text-amber-100/40 line-clamp-1",
        badge: "border-amber-400/35 text-amber-200 bg-amber-500/15",
        historyBadge: "border-amber-400/25 text-amber-300/80 bg-amber-500/10",
      };
    case "schedule_changed":
      return {
        pendingCard: "relative px-2.5 py-2 rounded-lg border border-sky-500/30 bg-gradient-to-r from-sky-950/25 via-sky-900/10 to-transparent flex flex-col gap-1.5 shadow-[0_0_18px_rgba(14,165,233,0.08)] overflow-hidden",
        historyCard: "px-2.5 py-1.5 rounded-lg border border-sky-500/10 bg-sky-500/[0.04] opacity-60 hover:opacity-100 transition-opacity flex flex-col gap-0.5",
        stripe: "from-sky-300 via-sky-400 to-cyan-500",
        iconWrap: "bg-sky-500/15 border border-sky-400/25 text-sky-200",
        pendingTitle: "text-[11px] font-black tracking-tight text-sky-100 truncate",
        historyTitle: "text-[10px] font-bold text-sky-200/80 truncate",
        pendingBody: "text-[11px] text-sky-100/78 leading-snug line-clamp-2",
        historyBody: "text-[10px] text-sky-100/40 line-clamp-1",
        badge: "border-sky-400/35 text-sky-200 bg-sky-500/15",
        historyBadge: "border-sky-400/25 text-sky-300/80 bg-sky-500/10",
      };
    case "pt_updated":
      return {
        pendingCard: "relative px-2.5 py-2 rounded-lg border border-cyan-500/30 bg-gradient-to-r from-cyan-950/25 via-cyan-900/10 to-transparent flex flex-col gap-1.5 shadow-[0_0_18px_rgba(34,211,238,0.08)] overflow-hidden",
        historyCard: "px-2.5 py-1.5 rounded-lg border border-cyan-500/10 bg-cyan-500/[0.04] opacity-60 hover:opacity-100 transition-opacity flex flex-col gap-0.5",
        stripe: "from-cyan-300 via-cyan-400 to-teal-500",
        iconWrap: "bg-cyan-500/15 border border-cyan-400/25 text-cyan-200",
        pendingTitle: "text-[11px] font-black tracking-tight text-cyan-100 truncate",
        historyTitle: "text-[10px] font-bold text-cyan-200/80 truncate",
        pendingBody: "text-[11px] text-cyan-100/78 leading-snug line-clamp-2",
        historyBody: "text-[10px] text-cyan-100/40 line-clamp-1",
        badge: "border-cyan-400/35 text-cyan-200 bg-cyan-500/15",
        historyBadge: "border-cyan-400/25 text-cyan-300/80 bg-cyan-500/10",
      };
    case "update_available":
      return {
        pendingCard: "relative px-2.5 py-2 rounded-lg border border-indigo-500/30 bg-gradient-to-r from-indigo-950/25 via-sky-900/10 to-transparent flex flex-col gap-1.5 shadow-[0_0_18px_rgba(99,102,241,0.08)] overflow-hidden",
        historyCard: "px-2.5 py-1.5 rounded-lg border border-indigo-500/10 bg-indigo-500/[0.04] opacity-60 hover:opacity-100 transition-opacity flex flex-col gap-0.5",
        stripe: "from-indigo-300 via-sky-400 to-sky-500",
        iconWrap: "bg-indigo-500/15 border border-indigo-400/25 text-indigo-200",
        pendingTitle: "text-[11px] font-black tracking-tight text-sky-100 truncate",
        historyTitle: "text-[10px] font-bold text-sky-200/80 truncate",
        pendingBody: "text-[11px] text-sky-100/78 leading-snug line-clamp-2",
        historyBody: "text-[10px] text-sky-100/40 line-clamp-1",
        badge: "border-sky-400/35 text-sky-200 bg-sky-500/15",
        historyBadge: "border-sky-400/25 text-sky-300/80 bg-sky-500/10",
      };
    case "pt_added":
      return {
        pendingCard: "relative px-2.5 py-2 rounded-lg border border-red-500/30 bg-gradient-to-r from-red-950/25 via-red-900/10 to-transparent flex flex-col gap-1.5 shadow-[0_0_18px_color-mix(in_oklab,var(--color-red-600)_8%,transparent)] overflow-hidden",
        historyCard: "px-2.5 py-1.5 rounded-lg border border-red-500/10 bg-red-500/[0.04] opacity-60 hover:opacity-100 transition-opacity flex flex-col gap-0.5",
        stripe: "from-red-300 via-red-400 to-rose-500",
        iconWrap: "bg-red-500/15 border border-red-400/25 text-red-200",
        pendingTitle: "text-[11px] font-black tracking-tight text-red-100 truncate",
        historyTitle: "text-[10px] font-bold text-red-200/80 truncate",
        pendingBody: "text-[11px] text-red-100/78 leading-snug line-clamp-2",
        historyBody: "text-[10px] text-red-100/40 line-clamp-1",
        badge: "border-red-400/35 text-red-200 bg-red-500/15",
        historyBadge: "border-red-400/25 text-red-300/80 bg-red-500/10",
      };
    default:
      return {
        pendingCard: "relative px-2.5 py-2 rounded-lg border border-white/10 bg-gradient-to-r from-white/[0.05] to-transparent flex flex-col gap-1.5 overflow-hidden",
        historyCard: "px-2.5 py-1.5 rounded-lg border border-white/5 bg-white/[0.02] opacity-60 hover:opacity-100 transition-opacity flex flex-col gap-0.5",
        stripe: "from-slate-300 via-slate-400 to-slate-500",
        iconWrap: "bg-white/10 border border-white/10 text-slate-200",
        pendingTitle: "text-[11px] font-bold text-slate-100 truncate tracking-tight",
        historyTitle: "text-[10px] font-semibold text-slate-300 truncate",
        pendingBody: "text-[11px] text-slate-400 leading-snug line-clamp-2",
        historyBody: "text-[10px] text-slate-500 line-clamp-1",
        badge: "border-white/15 text-slate-200 bg-white/10",
        historyBadge: "border-white/10 text-slate-300/80 bg-white/[0.06]",
      };
  }
}

export function NotificationCenter({
  notifications,
  onMarkDone,
  onMarkAllDone,
  onClearDone,
  onClose,
  desktopEnabled,
  onToggleDesktop,
  closeTray,
  onToggleCloseTray,
  startWithWindows,
  onToggleStartWithWindows,
  lowCpuUsage,
  onToggleLowCpuUsage,
  userRole,
  onOpenDonation,
  onUpdateCharacters,
  autoCharUpdate,
  onToggleAutoCharUpdate
}: Props) {
  const [activeTab, setActiveTab] = useState<"center" | "settings">("center");
  const panelRef = useRef<HTMLDivElement>(null);
  // Modal central de notificações. O som e as janelas de lembrete de PT
  // viviam soltos na aba Ajustes; agora ficam TODOS lá dentro, junto dos
  // demais tipos, sem controle duplicado fora do modal.
  // Declarado aqui no topo porque o efeito de clique-fora (logo abaixo)
  // depende dele.
  const [notifSettingsOpen, setNotifSettingsOpen] = useState(false);

  const [updatingNotifIds, setUpdatingNotifIds] = useState<Set<string>>(new Set());
  const [attCharsDoneIds, setAttCharsDoneIds] = useState<Set<string>>(new Set());
  const attCharsTimersRef = useRef<Record<string, number>>({});
  // Card do histórico expandido (reabre a notificação na versão completa).
  const [expandedHistoryId, setExpandedHistoryId] = useState<string | null>(null);

  useEffect(() => {
    // Com o modal de notificações aberto, o clique-fora fica SUSPENSO: o
    // modal é renderizado por portal em document.body, então qualquer clique
    // nele conta como "fora" deste painel e fecharia os dois de uma vez.
    if (notifSettingsOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    const timer = window.setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
    }, 100);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [onClose, notifSettingsOpen]);

  const [confirmingClear, setConfirmingClear] = useState(false);
  const confirmClearTimerRef = useRef<number | null>(null);

  const handleClearClick = useCallback(() => {
    if (confirmingClear) {
      if (confirmClearTimerRef.current) window.clearTimeout(confirmClearTimerRef.current);
      setConfirmingClear(false);
      onClearDone();
    } else {
      setConfirmingClear(true);
      confirmClearTimerRef.current = window.setTimeout(() => {
        setConfirmingClear(false);
      }, 4000);
    }
  }, [confirmingClear, onClearDone]);

  const [confirmingClearAll, setConfirmingClearAll] = useState(false);
  const confirmClearAllTimerRef = useRef<number | null>(null);

  const handleClearAllClick = useCallback(() => {
    if (confirmingClearAll) {
      if (confirmClearAllTimerRef.current) window.clearTimeout(confirmClearAllTimerRef.current);
      setConfirmingClearAll(false);
      onMarkAllDone();
    } else {
      setConfirmingClearAll(true);
      confirmClearAllTimerRef.current = window.setTimeout(() => {
        setConfirmingClearAll(false);
      }, 4000);
    }
  }, [confirmingClearAll, onMarkAllDone]);

  useEffect(() => {
    return () => {
      Object.values(attCharsTimersRef.current).forEach(t => window.clearTimeout(t));
      if (confirmClearTimerRef.current) window.clearTimeout(confirmClearTimerRef.current);
      if (confirmClearAllTimerRef.current) window.clearTimeout(confirmClearAllTimerRef.current);
    };
  }, []);

  const [autoBazaarEnabled, setAutoBazaarEnabled] = useState<boolean>(() => localStorage.getItem("rubinot_bazaar_auto_enabled") === "true");

  function handleToggleAutoBazaar(value: boolean) {
    setAutoBazaarEnabled(value);
    try {
      localStorage.setItem("rubinot_bazaar_auto_enabled", JSON.stringify(value));
      window.dispatchEvent(new Event("storage"));
    } catch {}
  }

  const handleAttChars = useCallback(async (n: Notification) => {
    if (!onUpdateCharacters || !n.questType || !n.partyId) return;

    setUpdatingNotifIds(prev => new Set(prev).add(n.id));
    try {
      const result = await onUpdateCharacters({
        notificationId: n.id,
        partyId: n.partyId,
        questType: n.questType,
      });
      if (result !== false) {
        setUpdatingNotifIds(prev => {
          const next = new Set(prev);
          next.delete(n.id);
          return next;
        });
        setAttCharsDoneIds(prev => new Set(prev).add(n.id));
        if (attCharsTimersRef.current[n.id]) window.clearTimeout(attCharsTimersRef.current[n.id]);
        attCharsTimersRef.current[n.id] = window.setTimeout(() => {
          setAttCharsDoneIds(prev => {
            const next = new Set(prev);
            next.delete(n.id);
            return next;
          });
          delete attCharsTimersRef.current[n.id];
        }, 4000);
      } else {
        setUpdatingNotifIds(prev => {
          const next = new Set(prev);
          next.delete(n.id);
          return next;
        });
      }
    } catch {
      setUpdatingNotifIds(prev => {
        const next = new Set(prev);
        next.delete(n.id);
        return next;
      });
    }
  }, [onUpdateCharacters]);

  const visibleNotifications = notifications.filter(n => n.type !== "request_entry" && n.type !== "rate_limit_block");
  const pendingNotifs = visibleNotifications
    .filter(n => n.status === "pending")
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const doneNotifs = visibleNotifications
    .filter(n => n.status === "done")
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  /**
   * Navegação a partir de uma notificação do Centro — EVENTO CANÔNICO ÚNICO.
   *
   * O mesmo fluxo do clique na notificação desktop: o roteador do App
   * (sempre montado) resolve o destino pelo mapa
   * `resolveNotificationDestination` (PT por ID, janela Bazaar, Meus
   * Services, Lista de Espera ou Centro como fallback). Aqui no Centro a
   * notificação já está visível, então o painel apenas fecha após despachar.
   */
  function handleNavigateFromNotification(notif: Notification) {
    dispatchNotificationNavigate(notif);
    onClose();
  }

  const handleToggleCloseTray = (v: boolean) => {
    onToggleCloseTray(v);
    if (isElectron) {
      try {
        const { ipcRenderer } = (window as any).require("electron");
        ipcRenderer.invoke("set-close-to-tray", v);
      } catch (_) {}
    }
  };

  const handleToggleStartWindows = (v: boolean) => {
    onToggleStartWithWindows(v);
    if (isElectron) {
      try {
        const { ipcRenderer } = (window as any).require("electron");
        ipcRenderer.invoke("set-start-with-windows", v);
      } catch (_) {}
    }
  };

  function renderCardIcon(type: Notification["type"]) {
    const size = 14;
    switch (type) {
      case "pt_added": return <ShieldAlert size={size} className="text-red-400" />;
      case "pt_reminder": return <Clock size={size} className="text-amber-400" />;
      case "update_available": return <Bell size={size} className="text-sky-400" />;
      case "payment_received": return <DollarSign size={size} className="text-emerald-400" />;
      case "quest_completed_donation": return <Heart size={size} className="text-rose-300" />;
      case "schedule_changed": return <Clock size={size} className="text-sky-400" />;
      case "pt_updated": return <Info size={size} className="text-cyan-400" />;
      case "vip_approved": return <Crown size={size} className="text-amber-300" />;
      case "bazaar_interest_ending": return <Clock size={size} className="text-amber-300" />;
      case "service_request": return <Briefcase size={size} className="text-sky-300" />;
      case "service_waiting": return <Clock size={size} className="text-cyan-300" />;
      case "party_finalized": return <CheckCircle2 size={size} className="text-emerald-300" />;
    }
  }

  return (
    <div
      ref={panelRef}
      className="fixed top-16 left-6 z-[1000] w-[700px] max-w-[calc(100vw-3rem)] bg-[var(--th-n-panel)] border rounded-2xl overflow-hidden flex flex-col animate-in fade-in slide-in-from-top-4 duration-200"
      style={{
        maxHeight: "calc(100vh - 6rem)",
        borderColor: "color-mix(in oklab, var(--color-red-600) 14%, transparent)",
        boxShadow: "0 25px 50px -12px rgba(0,0,0,0.75), 0 0 0 1px color-mix(in oklab, var(--color-red-600) 6%, transparent)",
      }}
    >
      {/* Header Compact */}
      <div
        className="flex items-center justify-between px-4 py-2 flex-shrink-0"
        style={{
          background: "linear-gradient(180deg, var(--th-n-elev) 0%, var(--th-n-elev) 100%)",
          borderBottom: "1px solid color-mix(in oklab, var(--color-red-600) 12%, transparent)",
        }}
      >
        <div className="flex items-center gap-3">
          <h3 className="text-[13px] font-black text-white uppercase tracking-wider">Menu</h3>
          <button
            type="button"
            onClick={() => {
              const newValue = !desktopEnabled;
              onToggleDesktop(newValue);
              // Solicitar permissão no navegador quando ativando
              if (newValue && !isElectron) {
                checkPermission();
              }
            }}
            className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-bold border transition-all duration-200 cursor-pointer ${
              desktopEnabled
                ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 hover:border-emerald-500/60"
                : "border-slate-600/40 bg-slate-600/15 text-slate-400 hover:bg-slate-600/25 hover:border-slate-500/60"
            }`}
          >
            {desktopEnabled ? <Bell size={11} /> : <BellOff size={11} />}
            <span>Desktop</span>
            <span className="opacity-50">{desktopEnabled ? "ON" : "OFF"}</span>
          </button>
          {onToggleAutoCharUpdate && (
            <button
              type="button"
              onClick={() => onToggleAutoCharUpdate(!autoCharUpdate)}
              className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-bold border transition-all duration-200 cursor-pointer ${
                autoCharUpdate
                  ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 hover:border-emerald-500/60"
                  : "border-slate-600/40 bg-slate-600/15 text-slate-400 hover:bg-slate-600/25 hover:border-slate-500/60"
              }`}
              title={autoCharUpdate ? "Auto-Att ATIVO — personagens atualizados automaticamente ao concluir PTs" : "Auto-Att INATIVO — clique para ativar atualização automática"}
            >
              <CheckCircle2 size={11} />
              <span>Auto-Att</span>
            </button>
          )}
          {userRole === "Boss" && isElectron && (
            <button
              type="button"
              onClick={() => handleToggleAutoBazaar(!autoBazaarEnabled)}
              className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-bold border transition-all duration-200 cursor-pointer ${
                autoBazaarEnabled
                  ? "border-amber-500/40 bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 hover:border-amber-500/60"
                  : "border-slate-600/40 bg-slate-600/15 text-slate-400 hover:bg-slate-600/25 hover:border-slate-500/60"
              }`}
              title={autoBazaarEnabled ? "Auto-Bazaar ATIVO — consulta automática após a notificação diária" : "Auto-Bazaar INATIVO"}
            >
              <ShoppingBag size={11} />
              <span>Auto-Bazaar</span>
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          {userRole === "VIP" && (
            <div
              className="relative inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[9px] font-black uppercase border border-amber-400/40 text-amber-200"
              style={{ background: "color-mix(in oklab, var(--color-amber-500) 15%, transparent)" }}
            >
              <Crown size={9} className="text-amber-300" />
              <span>VIP</span>
            </div>
          )}
          <button
            type="button"
            onClick={onClose}
            className="text-slate-500 hover:text-white p-1 rounded-lg hover:bg-white/[0.06] transition-all"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Tabs Compact */}
      <div className="flex gap-1 p-1 bg-[var(--th-n-panel)] border-b border-red-900/10">
        <button
          type="button"
          onClick={() => setActiveTab("center")}
          className={`flex-1 py-1.5 text-[11px] font-bold rounded-lg transition-all flex items-center justify-center gap-2 ${
            activeTab === "center" ? "text-red-200 bg-red-900/15 border border-red-500/20" : "text-slate-500 hover:bg-white/5"
          }`}
        >
          <Bell size={12} className={pendingNotifs.length > 0 && activeTab === "center" ? "text-red-400" : ""} />
          <span>Notificações</span>
          {pendingNotifs.length > 0 && (
            <span className="px-1.5 rounded-full bg-red-900 text-red-200 text-[9px]">{pendingNotifs.length}</span>
          )}
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("settings")}
          className={`flex-1 py-1.5 text-[11px] font-bold rounded-lg transition-all flex items-center justify-center gap-2 ${
            activeTab === "settings" ? "text-red-200 bg-red-900/15 border border-red-500/20" : "text-slate-500 hover:bg-white/5"
          }`}
        >
          <Info size={12} />
          <span>Ajustes</span>
        </button>
      </div>

      {activeTab === "center" && (
        <div className="flex-1 min-h-[300px] grid grid-cols-2 overflow-hidden">
          {/* Coluna Pendentes */}
          <div className="flex flex-col overflow-hidden border-r border-red-900/10 bg-[var(--th-n-panel)]">
            <div className="px-3 py-1.5 text-[10px] font-black uppercase text-red-300/80 flex items-center justify-between border-b border-red-900/5">
              <span className="flex items-center gap-1.5">
                <span className="w-1 h-1 rounded-full bg-red-500 shadow-[0_0_4px_#ef4444]" />
                Pendentes ({pendingNotifs.length})
              </span>
              {pendingNotifs.length > 0 && (
                <button onClick={handleClearAllClick} className={`text-[9px] font-bold uppercase transition-all ${confirmingClearAll ? "text-red-400 animate-pulse" : "text-red-400 hover:text-red-300"}`}>
                  {confirmingClearAll ? "Confirmar?" : "Limpar Tudo"}
                </button>
              )}
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-1.5 custom-scrollbar">
              {pendingNotifs.length === 0 ? (
                <div className="h-full flex items-center justify-center text-slate-600 text-[10px] italic">Vazio</div>
              ) : (
                pendingNotifs.map(n => {
                  const theme = getNotificationTheme(n.type);
                  const badges = getNotificationBadges(n);
                  const isVip = n.type === "vip_approved";

                  return (
                    <div
                      key={n.id}
                      className={`${theme.pendingCard}${n.type === "service_request" ? " cursor-pointer hover:border-sky-400/55 transition-colors" : ""}`}
                      // Clicar no card também navega — exceto quando o clique
                      // parte de um botão interno (marcar como lida, ações),
                      // que mantém seu próprio comportamento.
                      onClick={n.type === "service_request"
                        ? (event) => {
                            if ((event.target as HTMLElement).closest("button")) return;
                            handleNavigateFromNotification(n);
                          }
                        : undefined}
                    >
                      <span className={`pointer-events-none absolute inset-y-0 left-0 w-[3px] bg-gradient-to-b ${theme.stripe}`} />
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 min-w-0 flex-1">
                          <span className={`inline-flex h-6 w-6 items-center justify-center rounded-full flex-shrink-0 ${theme.iconWrap}`}>
                            {renderCardIcon(n.type)}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
                              <span className={theme.pendingTitle}>{n.title}</span>
                              {badges.map((badge, idx) => (
                                <span key={`${n.id}_pending_badge_${idx}`} className={`inline-flex items-center gap-0.5 px-1.5 py-[1px] rounded-full text-[9px] font-black uppercase tracking-wider border flex-shrink-0 ${theme.badge}`}>
                                  {badge}
                                </span>
                              ))}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          <span className={`text-[9px] font-mono ${isVip ? "text-amber-200/50" : "text-slate-500"}`}>{getRelativeTime(n.createdAt)}</span>
                          <button onClick={() => onMarkDone(n.id)} className="w-5 h-5 flex items-center justify-center rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20 transition-all"><Check size={12} /></button>
                        </div>
                      </div>

                      {renderNotificationBody(n, theme.pendingBody)}

                      <div className="flex items-center gap-1.5 flex-wrap">
                        {n.type === "quest_completed_donation" && n.participantCharIds && n.participantCharIds.length > 0 && onUpdateCharacters && (
                          attCharsDoneIds.has(n.id) ? (
                            <span className="text-[10px] font-bold text-emerald-400 flex items-center gap-1"><Check size={12} /> Atualizado</span>
                          ) : (
                            <button
                              onClick={() => handleAttChars(n)}
                              disabled={updatingNotifIds.has(n.id)}
                              className="h-6 px-2 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-black border border-emerald-400/30 flex items-center gap-1 shadow-md"
                            >
                              {updatingNotifIds.has(n.id) ? "..." : "Att Chars"}
                            </button>
                          )
                        )}
                        {n.type === "quest_completed_donation" && onOpenDonation && (
                          <button
                            onClick={() => onOpenDonation()}
                            className="h-6 px-2 rounded bg-gradient-to-r from-amber-700/80 to-amber-600/80 hover:from-amber-600 hover:to-amber-500 text-white text-[10px] font-black border border-amber-500/40 flex items-center gap-1 shadow-md shadow-amber-900/20 hover:shadow-amber-800/30 transition-all"
                          >
                            <Heart size={11} /> Doar
                          </button>
                        )}
                        {n.partyId && (
                          <button
                            onClick={() => handleNavigateFromNotification(n)}
                            className="h-6 px-2 rounded bg-red-900/40 border border-red-500/20 text-red-200 text-[10px] font-bold hover:bg-red-900/60 flex items-center gap-1"
                          >
                            <ExternalLink size={11} /> Ver PT
                          </button>
                        )}
                        {n.type === "bazaar_interest_ending" && n.url && (
                          <button
                            onClick={() => openExternalUrl(n.url)}
                            className="h-6 px-2 rounded bg-amber-500/10 border border-amber-500/25 text-amber-300 text-[10px] font-bold hover:bg-amber-500/20 flex items-center gap-1"
                          >
                            <ExternalLink size={11} /> Abrir Link
                          </button>
                        )}
                        {n.type === "bazaar_daily_available" && (
                          <button
                            onClick={() => handleNavigateFromNotification(n)}
                            className="h-6 px-2 rounded bg-amber-500/10 border border-amber-500/25 text-amber-300 text-[10px] font-bold hover:bg-amber-500/20 flex items-center gap-1"
                          >
                            <ShoppingBag size={11} /> Consultar Bazaar
                          </button>
                        )}
                        {n.type === "service_request" && (
                          <button
                            onClick={() => handleNavigateFromNotification(n)}
                            className="h-6 px-2 rounded bg-sky-500/10 border border-sky-500/25 text-sky-300 text-[10px] font-bold hover:bg-sky-500/20 flex items-center gap-1 cursor-pointer"
                            title="Abrir a aba Meus Services"
                          >
                            <Briefcase size={11} /> Meus Services
                          </button>
                        )}
                        {n.type === "service_waiting" && (
                          <button
                            onClick={() => handleNavigateFromNotification(n)}
                            className="h-6 px-2 rounded bg-cyan-500/10 border border-cyan-500/25 text-cyan-300 text-[10px] font-bold hover:bg-cyan-500/20 flex items-center gap-1 cursor-pointer"
                            title="Abrir a guia Services (Lista de Espera)"
                          >
                            <Clock size={11} /> Ver Services
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Coluna Histórico */}
          <div className="flex flex-col overflow-hidden bg-[var(--th-n-panel)]">
            <div className="px-3 py-1.5 text-[10px] font-black uppercase text-slate-500 flex items-center justify-between border-b border-red-900/5">
              <span>Histórico ({doneNotifs.length})</span>
              {doneNotifs.length > 0 && (
                <button onClick={handleClearClick} className={`text-[9px] font-bold uppercase transition-all ${confirmingClear ? "text-red-400 animate-pulse" : "text-slate-600 hover:text-slate-400"}`}>
                  {confirmingClear ? "Confirmar?" : "Limpar"}
                </button>
              )}
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-1.5 custom-scrollbar">
              {doneNotifs.length === 0 ? (
                <div className="h-full flex items-center justify-center text-slate-700 text-[10px] italic">Vazio</div>
              ) : (
                doneNotifs.map(n => {
                  const theme = getNotificationTheme(n.type);
                  const badges = getNotificationBadges(n);
                  const isVip = n.type === "vip_approved";
                  const isExpanded = expandedHistoryId === n.id;

                  // Versão expandida: reabre a notificação em layout completo,
                  // mantendo a identidade visual do histórico e todas as ações.
                  if (isExpanded) {
                    return (
                      <div
                        key={n.id}
                        className={theme.pendingCard}
                      >
                        <span className={`pointer-events-none absolute inset-y-0 left-0 w-[3px] bg-gradient-to-b ${theme.stripe}`} />
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5 min-w-0 flex-1">
                            <span className={`inline-flex h-6 w-6 items-center justify-center rounded-full flex-shrink-0 ${theme.iconWrap}`}>
                              {renderCardIcon(n.type)}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
                                <span className={theme.pendingTitle}>{n.title}</span>
                                {badges.map((badge, idx) => (
                                  <span key={`${n.id}_expanded_badge_${idx}`} className={`inline-flex items-center gap-0.5 px-1.5 py-[1px] rounded-full text-[9px] font-black uppercase tracking-wider border flex-shrink-0 ${theme.badge}`}>
                                    {badge}
                                  </span>
                                ))}
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5 flex-shrink-0">
                            <span className={`text-[9px] font-mono ${isVip ? "text-amber-200/50" : "text-slate-500"}`}>{getRelativeTime(n.createdAt)}</span>
                            <button
                              onClick={() => setExpandedHistoryId(null)}
                              className="w-5 h-5 flex items-center justify-center rounded bg-white/[0.06] border border-white/10 text-slate-400 hover:bg-white/10 hover:text-white transition-all"
                              title="Recolher"
                            >
                              <X size={12} />
                            </button>
                          </div>
                        </div>

                        {renderNotificationBody(n, theme.pendingBody)}

                        <div className="flex items-center gap-1.5 flex-wrap">
                          {n.type === "quest_completed_donation" && n.participantCharIds && n.participantCharIds.length > 0 && onUpdateCharacters && (
                            attCharsDoneIds.has(n.id) ? (
                              <span className="text-[10px] font-bold text-emerald-400 flex items-center gap-1"><Check size={12} /> Atualizado</span>
                            ) : (
                              <button
                                onClick={() => handleAttChars(n)}
                                disabled={updatingNotifIds.has(n.id)}
                                className="h-6 px-2 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-black border border-emerald-400/30 flex items-center gap-1 shadow-md"
                              >
                                {updatingNotifIds.has(n.id) ? "..." : "Att Chars"}
                              </button>
                            )
                          )}
                          {n.type === "quest_completed_donation" && onOpenDonation && (
                            <button
                              onClick={() => onOpenDonation()}
                              className="h-6 px-2 rounded bg-gradient-to-r from-amber-700/80 to-amber-600/80 hover:from-amber-600 hover:to-amber-500 text-white text-[10px] font-black border border-amber-500/40 flex items-center gap-1 shadow-md shadow-amber-900/20 hover:shadow-amber-800/30 transition-all"
                            >
                              <Heart size={11} /> Doar
                            </button>
                          )}
                          {n.partyId && (
                            <button
                              onClick={() => handleNavigateFromNotification(n)}
                              className="h-6 px-2 rounded bg-red-900/40 border border-red-500/20 text-red-200 text-[10px] font-bold hover:bg-red-900/60 flex items-center gap-1"
                            >
                              <ExternalLink size={11} /> Ver PT
                            </button>
                          )}
                          {n.type === "bazaar_interest_ending" && n.url && (
                            <button
                              onClick={() => openExternalUrl(n.url)}
                              className="h-6 px-2 rounded bg-amber-500/10 border border-amber-500/25 text-amber-300 text-[10px] font-bold hover:bg-amber-500/20 flex items-center gap-1"
                            >
                              <ExternalLink size={11} /> Abrir Link
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div
                      key={n.id}
                      onClick={() => setExpandedHistoryId(n.id)}
                      className={`${theme.historyCard} cursor-pointer`}
                      title="Clique para abrir a notificação completa"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 min-w-0 flex-1">
                          <span className={`inline-flex h-5 w-5 items-center justify-center rounded-full flex-shrink-0 ${theme.iconWrap}`}>
                            {renderCardIcon(n.type)}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1 min-w-0 flex-wrap">
                              <span className={theme.historyTitle}>{n.title}</span>
                              {badges.map((badge, idx) => (
                                <span key={`${n.id}_history_badge_${idx}`} className={`inline-flex items-center px-1 py-[1px] rounded-full text-[8px] font-black uppercase tracking-wider border flex-shrink-0 ${theme.historyBadge}`}>
                                  {badge}
                                </span>
                              ))}
                            </div>
                          </div>
                        </div>
                        <span className={`text-[8px] font-mono ${isVip ? "text-amber-200/40" : "text-slate-600"}`}>{getRelativeTime(n.createdAt)}</span>
                      </div>
                      {renderNotificationBody(n, theme.historyBody)}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {activeTab === "settings" && (
        <div className="flex-1 overflow-y-auto p-4 space-y-2 bg-[var(--th-n-panel)]">
          <ThemeSelector />

          {/* Porta de entrada única para TODAS as preferências de
              notificação. O som e os avisos de PT saíram desta aba e passaram
              a viver no modal, junto dos demais tipos — nada duplicado. */}
          <button
            type="button"
            onClick={() => setNotifSettingsOpen(true)}
            className="w-full flex items-center justify-between gap-3 p-3 rounded-xl border border-red-500/25 bg-red-900/10 hover:bg-red-900/20 hover:border-red-500/40 transition-colors cursor-pointer"
          >
            <span className="flex items-center gap-2.5 min-w-0">
              <BellRing size={15} className="text-red-300 flex-shrink-0" />
              <span className="min-w-0 text-left">
                <span className="block text-[12px] font-bold text-slate-100">Configurar Notificações</span>
                <span className="block text-[10px] text-slate-500 leading-tight">
                  Ative ou desative cada tipo de aviso, o som e as notificações do sistema.
                </span>
              </span>
            </span>
            <ExternalLink size={13} className="flex-shrink-0 text-slate-500" />
          </button>

          {[
            // "Fechar para bandeja" e "Iniciar com Windows" dependem de IPC do
            // Electron e não têm efeito na Web — por isso não são renderizadas lá
            // (filtradas da lista, sem deixar espaço vazio no layout).
            //
            // Nenhuma opção de NOTIFICAÇÃO aqui: todas foram centralizadas no
            // modal acima. O que resta são ajustes de janela e desempenho.
            { id: "tray", label: "Fechar para bandeja", desc: "Minimiza para o ícone do sistema.", value: closeTray, toggle: handleToggleCloseTray, electronOnly: true },
            { id: "win", label: "Iniciar com Windows", desc: "Abre o app ao ligar o PC.", value: startWithWindows, toggle: handleToggleStartWindows, electronOnly: true },
            { id: "cpu", label: "Poupar CPU", desc: "Reduz animações da logo.", value: lowCpuUsage, toggle: onToggleLowCpuUsage },
          ].filter(s => isElectron || !s.electronOnly).map(s => (
            <div key={s.id} className="flex items-center justify-between gap-4 p-3 rounded-xl border border-red-900/10 bg-white/[0.01]">
              <div className="min-w-0">
                <span className="text-[12px] font-bold text-slate-200 block mb-0.5">{s.label}</span>
                <p className="text-[10px] text-slate-500 leading-tight">{s.desc}</p>
              </div>
              <PremiumCheckbox id={`toggle-${s.id}`} checked={s.value} onChange={e => s.toggle(e.target.checked)} />
            </div>
          ))}
        </div>
      )}

      {/* Modal central de notificações. Renderizado por portal, então fica
          acima do painel e não é afetado pelo clique-fora dele. */}
      <NotificationSettingsModal
        open={notifSettingsOpen}
        onClose={() => setNotifSettingsOpen(false)}
        isBoss={userRole === "Boss"}
        isElectron={isElectron}
        desktopEnabled={desktopEnabled}
        onToggleDesktop={onToggleDesktop}
      />
    </div>
  );
}