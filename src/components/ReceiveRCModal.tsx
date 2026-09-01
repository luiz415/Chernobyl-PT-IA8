import { useState, useEffect } from "react";
import { X, Save, User } from "lucide-react";
import { useAuth } from "../context/AuthContext";

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function ReceiveRCModal({ open, onClose }: Props) {
  const { userProfile, updateUserProfile } = useAuth();
  const [characterName, setCharacterName] = useState("");
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);

  // Responsividade vem da moldura global com max-height e rolagem interna.

  // Carregar valor atual sempre que o modal abrir
  useEffect(() => {
    if (open && userProfile) {
      setCharacterName(userProfile.mainCharacterName || "");
      setSuccess(false);
    }
  }, [open, userProfile]);

  if (!open) return null;

  async function handleSave() {
    if (!userProfile) return;
    setSaving(true);
    try {
      await updateUserProfile({ mainCharacterName: characterName.trim() });
      setSuccess(true);
      window.setTimeout(() => {
        setSuccess(false);
        onClose();
      }, 1200);
    } catch {
      // Tratamento silencioso
    } finally {
      setSaving(false);
    }
  }

  function handleClose() {
    if (saving) return;
    setSuccess(false);
    onClose();
  }

  return (
    <div
      className="app-modal-overlay fixed inset-0 z-[500] flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === e.currentTarget) handleClose(); }}
    >
      <div
        className="app-modal-frame app-modal-size-sm app-modal-frame--scroll relative bg-[var(--th-n-base)] border border-[var(--th-line)]/80 rounded-2xl shadow-[0_0_40px_color-mix(in_oklab,var(--th-brand)_30%,transparent)] w-full max-w-md"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[var(--th-line)]/60 bg-gradient-to-r from-[var(--th-bg-base)] to-[var(--th-n-base)] flex-shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-amber-500/15 border border-amber-600/35 flex items-center justify-center shadow-[0_0_8px_color-mix(in_oklab,var(--color-amber-500)_12%,transparent)]">
              <User size={16} className="text-amber-400" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white tracking-wide">Receber RC</h3>
              <p className="text-[10px] text-slate-500">Configure seu personagem principal para receber pagamentos.</p>
            </div>
          </div>
          <button
            onClick={handleClose}
            className="text-slate-500 hover:text-white p-1.5 rounded-lg hover:bg-[var(--th-line)]/25 transition-colors cursor-pointer"
            disabled={saving}
          >
            <X size={16} />
          </button>
        </div>

        {success ? (
          <div className="flex flex-col items-center justify-center py-14 px-6 gap-3 flex-1">
            <div className="w-14 h-14 rounded-full bg-emerald-500/15 border border-emerald-500/40 flex items-center justify-center shadow-[0_0_20px_rgba(16,185,129,0.15)]">
              <Save size={24} className="text-emerald-400" />
            </div>
            <h4 className="text-lg font-bold text-white">Personagem atualizado!</h4>
            <p className="text-sm text-slate-500 text-center max-w-xs">
              O personagem <span className="text-amber-300 font-bold">{characterName}</span> foi salvo como seu recebedor principal.
            </p>
          </div>
        ) : (
          <>
            {/* Content */}
            <div className="app-modal-body p-5 space-y-4">
              <div>
                <label className="block text-[10px] text-red-400/80 uppercase tracking-wider mb-1.5 font-bold">
                  Nome do Personagem Principal
                </label>
                <div className="relative">
                  <User size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-600 pointer-events-none" />
                  <input
                    type="text"
                    value={characterName}
                    onChange={(e) => setCharacterName(e.target.value.slice(0, 30))}
                    maxLength={30}
                    placeholder="Ex: Seu Personagem"
                    autoFocus
                    className="w-full pl-9 pr-3 py-2.5 bg-black/40 border border-[var(--th-line)]/60 rounded-lg text-white text-sm focus:outline-none focus:border-red-700/60 focus:ring-1 focus:ring-red-700/20 placeholder-slate-600 transition-colors"
                  />
                </div>
                <p className="text-[10px] text-slate-600 mt-1.5 leading-relaxed">
                  Este personagem será exibido aos outros usuários da PT como o destinatário dos pagamentos em RC.
                </p>
              </div>

              {userProfile?.mainCharacterName && (
                <div className="text-[10px] text-slate-600">
                  Valor atual salvo: <span className="text-amber-300 font-mono">{userProfile.mainCharacterName}</span>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="app-modal-footer flex flex-wrap justify-end gap-3 px-4 sm:px-5 py-3.5 border-t border-[var(--th-line)]/50 bg-gradient-to-r from-[var(--th-bg-base)] to-[var(--th-n-base)]">
              <button
                onClick={handleClose}
                className="px-4 py-2 rounded-lg border border-[var(--th-line)]/50 text-slate-500 hover:text-white hover:bg-[var(--th-line)]/20 text-xs font-semibold transition-colors cursor-pointer"
                disabled={saving}
              >
                Cancelar
              </button>
              <button
                onClick={handleSave}
                disabled={saving || !characterName.trim()}
                className="inline-flex items-center gap-1.5 px-5 py-2 rounded-lg bg-gradient-to-r from-[var(--th-brand-mid)] to-[var(--th-brand)] hover:from-[var(--th-brand-bright)] hover:to-[var(--th-line-strong)] text-white text-xs font-bold shadow-lg shadow-red-900/30 transition-colors cursor-pointer border border-[var(--th-brand-mid)]/60 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Save size={13} />
                {saving ? "Salvando..." : "Salvar"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}