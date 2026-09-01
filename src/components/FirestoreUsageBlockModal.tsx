import { ShieldAlert, LogOut, Clock } from "lucide-react";
import blockBgUrl from "../assets/block-bg.png";

interface Props {
  secondsLeft: number;
  totalSeconds: number;
  blockCount: number;
  onDisconnect: () => void;
}

export default function FirestoreUsageBlockModal({ secondsLeft, totalSeconds, blockCount, onDisconnect }: Props) {
  const mins = Math.floor(Math.max(0, secondsLeft) / 60);
  const secs = Math.max(0, secondsLeft) % 60;
  const timeLabel = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  const progress = totalSeconds > 0 ? Math.max(0, Math.min(100, (secondsLeft / totalSeconds) * 100)) : 0;

  return (
    <div className="app-modal-overlay fixed inset-0 z-[10000] bg-[var(--th-n-raised)] flex items-center justify-center select-none">
      {/* CAMADA 1 (mais ao fundo): Imagem de fundo — absolute para respeitar o stacking context do pai */}
      <div
        className="absolute inset-0 pointer-events-none bg-[var(--th-n-raised)] animate-in fade-in duration-700"
        style={{
          backgroundImage: `url(${blockBgUrl})`,
          backgroundSize: 'cover',
          backgroundPosition: '50% 50%',
          backgroundRepeat: 'no-repeat',
          zIndex: 0,
        }}
      />
      {/* CAMADA 2 (meio): Filtro escuro sobre a imagem (sem blur) */}
      <div className="absolute inset-0 bg-[var(--th-n-raised)]/85 pointer-events-none" style={{ zIndex: 1 }} />
      {/* CAMADA 2.5: Glow effects (ainda atrás do card) */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none" style={{ zIndex: 2 }}>
        <div className="absolute -top-[20%] -left-[10%] w-[60%] h-[60%] rounded-full bg-rose-600/10 blur-[140px]" />
        <div className="absolute -bottom-[20%] -right-[10%] w-[60%] h-[60%] rounded-full bg-amber-500/10 blur-[140px]" />
      </div>

      {/* CAMADA 3 (primeiro plano): Container Principal do Card (aparece instantaneamente) */}
      <div className="app-modal-frame app-modal-size-sm w-full max-w-md overflow-y-auto bg-[var(--th-n-elev)] border border-rose-500/30 rounded-2xl shadow-2xl shadow-rose-950/40 relative z-10">
        {/* Header */}
        <div className="flex flex-col items-center text-center px-6 pt-8 pb-5 border-b border-white/5 bg-gradient-to-b from-rose-950/30 to-transparent">
          <div className="w-16 h-16 rounded-2xl bg-rose-500/15 border border-rose-500/40 flex items-center justify-center mb-4 animate-pulse">
            <ShieldAlert size={32} className="text-rose-400" />
          </div>
          <h2 className="text-lg font-bold text-white tracking-wide">Uso excessivo detectado</h2>
          <p className="text-xs text-slate-400 mt-2 leading-relaxed max-w-xs">
            Você ultrapassou o limite de operações por minuto no banco de dados.
            O aplicativo foi pausado temporariamente para proteger o sistema.
          </p>
        </div>

        {/* Cronômetro */}
        <div className="px-6 py-6 flex flex-col items-center gap-4">
          <div className="flex items-center gap-3">
            <Clock size={20} className="text-amber-400" />
            <span className="text-4xl font-black font-mono text-amber-300 tabular-nums tracking-wider">
              {timeLabel}
            </span>
          </div>

          {/* Barra de progresso regressiva */}
          <div className="w-full h-2 bg-black/40 rounded-full overflow-hidden border border-white/5">
            <div
              className="h-full bg-gradient-to-r from-rose-500 to-amber-500 rounded-full transition-all duration-1000 ease-linear"
              style={{ width: `${progress}%` }}
            />
          </div>

          <p className="text-[11px] text-slate-500 text-center">
            O acesso será liberado automaticamente quando o cronômetro zerar.
          </p>

          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full border border-rose-500/30 bg-rose-500/10">
            <span className="text-[10px] font-bold text-rose-300 uppercase tracking-wider">
              Você já foi bloqueado {blockCount} vez{blockCount === 1 ? "" : "es"}
            </span>
          </div>
        </div>

        {/* Footer — única ação permitida */}
        <div className="px-6 py-4 border-t border-white/5 bg-[var(--th-n-panel)] flex flex-col items-center">
          <button
            type="button"
            onClick={onDisconnect}
            className="inline-flex items-center gap-2 px-5 py-2 rounded-lg border border-rose-500/40 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20 hover:text-rose-200 text-xs font-bold transition-colors cursor-pointer"
          >
            <LogOut size={13} /> Desconectar
          </button>
        </div>
      </div>
    </div>
  );
}