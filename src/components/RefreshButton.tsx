import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

interface RefreshButtonProps {
  onRefresh: () => void;
  isRefreshing: boolean;
  refreshDone: boolean;
  title: string;
  cooldownSeconds?: number;
}

export default function RefreshButton({
  onRefresh,
  isRefreshing,
  refreshDone,
  title,
  cooldownSeconds = 30,
}: RefreshButtonProps) {
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const interval = setInterval(() => {
      setCooldown(prev => prev - 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [cooldown]);

  useEffect(() => {
    if (isRefreshing && cooldown === 0) {
      setCooldown(cooldownSeconds);
    }
  }, [isRefreshing, cooldown, cooldownSeconds]);

  return (
    <button
      type="button"
      onClick={() => {
        if (cooldown === 0 && !isRefreshing) {
          onRefresh();
        }
      }}
      disabled={isRefreshing || cooldown > 0}
      className="inline-flex items-center gap-1 px-2 py-0.1 rounded text-[10px] font-medium border border-red-500/40 bg-white/[0.03] text-slate-400 hover:text-white hover:bg-white/10 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
      title={title}
    >
      <RefreshCw size={11} className={isRefreshing ? "animate-spin" : ""} />
      {isRefreshing ? "Atualizando..." : cooldown > 0 ? `Aguarde ${cooldown}s` : refreshDone ? "Atualizado!" : "Atualizar"}
    </button>
  );
}