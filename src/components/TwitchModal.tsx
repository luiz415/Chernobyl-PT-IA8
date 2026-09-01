import { useState, useEffect } from "react";
import { X, Check, Tv } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { db, isSimulationMode } from "../firebase/config";
import { doc } from "firebase/firestore";
import { getDoc, setDoc } from "../firebase/config";

interface Props {
  open: boolean;
  onClose: () => void;
}

type StreamPlatform = "twitch" | "kick";

const PLATFORM_CONFIG: Record<StreamPlatform, { label: string; prefix: string; fullPrefix: string; color: string; borderColor: string; bgColor: string; glowColor: string }> = {
  twitch: {
    label: "Twitch",
    prefix: "twitch.tv/",
    fullPrefix: "https://www.twitch.tv/",
    color: "text-violet-400",
    borderColor: "border-violet-600/50",
    bgColor: "bg-violet-500/20",
    glowColor: "shadow-[0_0_8px_rgba(139,92,246,0.15)]",
  },
  kick: {
    label: "Kick",
    prefix: "kick.com/",
    fullPrefix: "https://www.kick.com/",
    color: "text-emerald-400",
    borderColor: "border-emerald-600/50",
    bgColor: "bg-emerald-500/20",
    glowColor: "shadow-[0_0_8px_rgba(16,185,129,0.15)]",
  },
};

const PLATFORMS: StreamPlatform[] = ["twitch", "kick"];

/**
 * Detecta a plataforma a partir de uma URL salva.
 * Retorna a plataforma e o nome do canal extraído.
 */
function parseSavedUrl(url: string): { platform: StreamPlatform; channelName: string } {
  if (!url) return { platform: "twitch", channelName: "" };

  // Detectar Kick
  const kickMatch = url.match(/^https?:\/\/(www\.)?kick\.com\/(.+)/i);
  if (kickMatch) {
    return { platform: "kick", channelName: kickMatch[2].replace(/\/+$/, "") };
  }

  // Detectar Twitch (padrão / fallback)
  const twitchMatch = url.match(/^https?:\/\/(www\.)?twitch\.tv\/(.+)/i);
  if (twitchMatch) {
    return { platform: "twitch", channelName: twitchMatch[2].replace(/\/+$/, "") };
  }

  // Fallback: se é uma URL desconhecida, trata como nome de canal Twitch
  return { platform: "twitch", channelName: url.replace(/\/+$/, "") };
}

export default function TwitchModal({ open, onClose }: Props) {
  const { currentUser } = useAuth();
  const [channelName, setChannelName] = useState("");
  const [platform, setPlatform] = useState<StreamPlatform>("twitch");
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(false);

  // A superfície global limita altura e entrega rolagem interna, preservando
  // tamanho de fonte e foco em vez de reduzir o modal via transform: scale.

  // Carregar o canal salvo ao abrir o modal
  useEffect(() => {
    if (!open || !currentUser?.uid) return;
    setSaved(false);

    if (isSimulationMode || !db) {
      try {
        const raw = localStorage.getItem(`tibia_twitch_channel_${currentUser.uid}`);
        const parsed = parseSavedUrl(raw || "");
        setChannelName(parsed.channelName);
        setPlatform(parsed.platform);
      } catch {
        setChannelName("");
        setPlatform("twitch");
      }
      return;
    }

    let isMounted = true;
    async function loadChannel() {
      try {
        const snap = await getDoc(doc(db, "users", currentUser.uid));
        if (!isMounted) return;
        if (snap.exists()) {
          const data = snap.data() as any;
          const savedUrl = data.twitchChannel || "";
          const parsed = parseSavedUrl(savedUrl);
          setChannelName(parsed.channelName);
          setPlatform(parsed.platform);
        }
      } catch {
        setChannelName("");
        setPlatform("twitch");
      }
    }
    loadChannel();
    return () => { isMounted = false; };
  }, [open, currentUser?.uid]);

  if (!open) return null;

  const currentConfig = PLATFORM_CONFIG[platform];

  function handleClose() {
    setChannelName("");
    setPlatform("twitch");
    setSaved(false);
    onClose();
  }

  async function handleSave() {
    if (!currentUser?.uid) return;
    setLoading(true);

    const trimmed = channelName.trim().replace(/\/+$/, "");
    const fullUrl = trimmed ? `${currentConfig.fullPrefix}${trimmed}` : "";

    try {
      if (isSimulationMode || !db) {
        // Em simulação, salva a URL completa (que inclui a plataforma)
        localStorage.setItem(`tibia_twitch_channel_${currentUser.uid}`, fullUrl);
      } else {
        await setDoc(doc(db, "users", currentUser.uid), {
          twitchChannel: fullUrl,
        }, { merge: true });
      }

      setSaved(true);
      setTimeout(() => {
        handleClose();
      }, 1200);
    } catch {
      // Silencioso
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="app-modal-overlay fixed inset-0 z-[350] flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === e.currentTarget) handleClose(); }}
    >
      <div
        className="app-modal-frame app-modal-size-sm app-modal-frame--scroll w-full max-w-md bg-[var(--th-n-base)] border border-[var(--th-line)]/100 rounded-2xl shadow-[0_0_40px_color-mix(in_oklab,var(--th-brand)_30%,transparent)]"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[var(--th-line)]/60 bg-gradient-to-r from-[var(--th-bg-base)] to-[var(--th-n-base)] flex-shrink-0">
          <div className="flex items-center gap-2">
            <div className={`w-8 h-8 rounded-lg border flex items-center justify-center transition-all duration-300 ${PLATFORM_CONFIG[platform].bgColor} ${PLATFORM_CONFIG[platform].borderColor} ${PLATFORM_CONFIG[platform].glowColor}`}>
              <Tv size={16} className={`transition-colors duration-300 ${PLATFORM_CONFIG[platform].color}`} />
            </div>
            <h3 className="text-base font-bold text-white tracking-wide">Canal de Streaming</h3>
          </div>
          <button
            onClick={handleClose}
            className="text-slate-500 hover:text-white p-1.5 rounded-lg hover:bg-[var(--th-line)]/25 transition-colors cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>

        {/* Scrollable content */}
        <div className="app-modal-body">
          {saved ? (
            <div className="flex flex-col items-center justify-center py-14 px-6 gap-3">
              <div className="w-14 h-14 rounded-full bg-emerald-500/15 border border-emerald-500/40 flex items-center justify-center animate-in zoom-in duration-300 shadow-[0_0_20px_rgba(16,185,129,0.15)]">
                <Check size={28} className="text-emerald-400" />
              </div>
              <h4 className="text-lg font-bold text-white">Canal salvo com sucesso!</h4>
              <p className="text-sm text-slate-500 text-center max-w-xs">
                {channelName.trim()
                  ? `Seu canal da ${currentConfig.label} será exibido nas PT's que você participar.`
                  : "Canal removido. Nenhum link será exibido."}
              </p>
            </div>
          ) : (
            <div className="p-5 space-y-4">
              <div className="text-xs text-slate-400 leading-relaxed">
                Configure o link do seu canal de streaming. Ele será exibido para os outros membros nas PT's em que você participar.
              </div>

              {/* Seletor de plataforma */}
              <div>
                <label className="block text-[10px] text-red-400/80 uppercase tracking-wider mb-1.5 font-bold">
                  Plataforma
                </label>
                <div className="flex gap-1.5 bg-black/30 rounded-lg border border-[var(--th-line)]/40 p-1">
                  {PLATFORMS.map((p) => {
                    const cfg = PLATFORM_CONFIG[p];
                    const isActive = platform === p;
                    return (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setPlatform(p)}
                        className={`flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-xs font-bold transition-all duration-200 cursor-pointer ${
                          isActive
                            ? `${cfg.bgColor} ${cfg.borderColor} border ${cfg.color} ${cfg.glowColor}`
                            : "border border-transparent text-slate-500 hover:text-slate-300 hover:bg-white/[0.03]"
                        }`}
                      >
                        <Tv size={13} />
                        {cfg.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <label className="block text-[10px] text-red-400/80 uppercase tracking-wider mb-1.5 font-bold">
                  Seu Canal
                </label>
                <div className="flex items-stretch rounded-lg overflow-hidden border border-[var(--th-line)]/50 focus-within:border-violet-700/60 transition-colors">
                  <div className={`flex items-center px-3 bg-[var(--th-bg-raised)] border-r border-[var(--th-line)]/30 text-xs font-mono select-none whitespace-nowrap transition-colors duration-300 ${currentConfig.color}`}>
                    {currentConfig.prefix}
                  </div>
                  <input
                    type="text"
                    value={channelName}
                    onChange={(e) => setChannelName(e.target.value.replace(/\s/g, ""))}
                    placeholder="SeuCanal"
                    className="flex-1 bg-black/40 px-3 py-2.5 text-white focus:outline-none text-sm placeholder-slate-600 font-mono"
                    maxLength={50}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleSave();
                      if (e.key === "Escape") handleClose();
                    }}
                    autoFocus
                  />
                </div>
                {channelName.trim() && (
                  <div className="mt-2 text-[10px] text-slate-500">
                    Preview: <span className={`font-mono transition-colors duration-300 ${currentConfig.color}`}>{currentConfig.fullPrefix}{channelName.trim()}</span>
                  </div>
                )}
              </div>

              <div className="flex justify-end gap-3 pt-2 border-t border-[var(--th-line)]/60">
                <button
                  onClick={handleClose}
                  className="px-4 py-2 rounded-lg border border-[var(--th-line)]/80 text-slate-500 hover:text-white hover:bg-[var(--th-line)]/20 text-xs font-semibold transition-colors cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  onClick={handleSave}
                  disabled={loading}
                  className="inline-flex items-center gap-1.5 px-5 py-2 rounded-lg bg-gradient-to-r from-[var(--th-brand-mid)] to-[var(--th-brand)] hover:from-[var(--th-brand-bright)] hover:to-[var(--th-line-strong)] text-white text-xs font-bold shadow-lg shadow-red-900/30 transition-colors cursor-pointer border border-[var(--th-brand-mid)]/60 disabled:opacity-50"
                >
                  <Check size={13} /> {loading ? "Salvando..." : "Salvar"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}