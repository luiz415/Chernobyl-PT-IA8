import { useState, useEffect, useMemo, useRef } from "react";
import { X, Save, User, Users, Copy, Check } from "lucide-react";
import { useAuth } from "../context/AuthContext";

interface Props {
  open: boolean;
  onClose: () => void;
}

/** Copia o texto usando o mesmo caminho do "Copiar (WA)" do PartyPanel, do
 *  histórico de PT's e da guia Negociados (textarea + execCommand, com
 *  fallback para a API assíncrona de clipboard). */
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

/** Nome do personagem principal do amigo como BOTÃO DE COPIAR — o MESMO
 *  padrão já usado na guia Negociados (AcquiredCharactersPanel): o nome
 *  continua visualmente identificado como personagem (âmbar/mono), com
 *  ícone de copiar no hover e ✓ verde por 2s após copiar o nome EXATO. */
function FriendMainCharacterName({ name, friendName }: { name: string; friendName: string }) {
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
  }, []);
  function handleCopy() {
    const clean = String(name || "").trim();
    if (!clean) return;
    copyTextToClipboard(clean);
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 2000);
  }
  return (
    <button
      type="button"
      onClick={handleCopy}
      title={copied ? "Nome copiado" : `Copiar "${name}" — personagem principal de ${friendName}`}
      className={`group inline-flex min-w-0 cursor-copy items-center gap-1 rounded px-0.5 py-0.5 font-mono text-[11px] font-bold transition-colors ${
        copied
          ? "bg-emerald-500/15 text-emerald-300"
          : "text-amber-300 hover:bg-white/[0.07] hover:text-amber-200"
      }`}
    >
      <span className="truncate">{name}</span>
      {copied
        ? <Check size={10} strokeWidth={3} className="flex-shrink-0 text-emerald-400" />
        : <Copy size={10} className="flex-shrink-0 text-slate-500 opacity-0 transition-opacity group-hover:opacity-80" />}
    </button>
  );
}

export default function ReceiveRCModal({ open, onClose }: Props) {
  const { userProfile, updateUserProfile, allUsers, acceptedFriendUids } = useAuth();
  const [characterName, setCharacterName] = useState("");
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);

  // ── Personagens principais dos AMIGOS ────────────────────────────────────
  // Seção SOMENTE informativa: para cada amigo (amizade "aceita" — mesma
  // fonte única do AuthContext usada pelo FriendsModal), mostra o personagem
  // principal que aquele usuário configurou para receber RC. Nenhuma leitura
  // extra: acceptedFriendUids e allUsers já estão carregados no contexto.
  const friendRecipients = useMemo(() => {
    return acceptedFriendUids
      .map(uid => allUsers.find(u => u.uid === uid))
      .filter((u): u is NonNullable<typeof u> => !!u)
      .map(u => ({
        uid: u.uid,
        nome: u.nome || "Usuário",
        mainCharacterName: (u.mainCharacterName || "").trim(),
      }))
      .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  }, [acceptedFriendUids, allUsers]);

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

              {/* ── Personagens principais dos amigos (informativo) ────── */}
              <div className="border-t border-[var(--th-line)]/50 pt-4">
                <div className="flex items-center gap-2 mb-2.5">
                  <div className="w-6 h-6 rounded-md bg-sky-500/15 border border-sky-500/30 flex items-center justify-center flex-shrink-0">
                    <Users size={12} className="text-sky-400" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[11px] font-bold text-slate-200 uppercase tracking-wider leading-tight">Personagens dos seus amigos</div>
                    <div className="text-[10px] text-slate-500 leading-tight">O personagem que receberá os RC de cada amigo.</div>
                  </div>
                </div>
                {friendRecipients.length === 0 ? (
                  <p className="text-[11px] italic text-slate-600 px-1 py-1.5">
                    Você ainda não possui amigos adicionados.
                  </p>
                ) : (
                  <div className="max-h-44 overflow-y-auto custom-scrollbar rounded-lg border border-[var(--th-line)]/50 bg-black/25 divide-y divide-[var(--th-line)]/40">
                    {friendRecipients.map(friend => (
                      <div key={friend.uid} className="flex items-center justify-between gap-2 px-2.5 py-2 min-w-0">
                        <span className="flex items-center gap-1.5 min-w-0 flex-shrink">
                          <User size={11} className="text-slate-500 flex-shrink-0" />
                          <span className="truncate text-[11px] font-semibold text-slate-300" title={friend.nome}>{friend.nome}</span>
                        </span>
                        {friend.mainCharacterName ? (
                          <FriendMainCharacterName name={friend.mainCharacterName} friendName={friend.nome} />
                        ) : (
                          <span className="text-[10px] italic text-slate-600 text-right flex-shrink-0" title={`${friend.nome} ainda não configurou o personagem principal`}>
                            Não configurado
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
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