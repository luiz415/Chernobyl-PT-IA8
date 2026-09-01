import { useState, useEffect, useMemo } from "react";
import { X, UserPlus, Users, Clock, Check, UserMinus, Search, MessageCircle, ShieldCheck } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { db, setDoc, deleteDoc } from "../firebase/config";
import { doc } from "firebase/firestore";
import { openExternalUrl } from "../utils/openExternal";

interface Props {
  open: boolean;
  onClose: () => void;
}

interface FriendRequest {
  uid: string;
  nome: string;
  email: string;
  status: "pendente" | "enviada" | "aceita" | "recusada";
  createdAt: number;
  whatsappCountry?: string;
  whatsappRegion?: string;
  whatsappNumber?: string;
}

function maskEmail(email: string): string {
  const [local, domain] = (email || "").split("@");
  if (!local || !domain) return email || "";
  const visibleLength = local.length <= 3 ? 1 : 3;
  const visible = local.slice(0, visibleLength);
  return `${visible}***@${domain}`;
}

function buildWhatsappPhone(user: { whatsappCountry?: string; whatsappRegion?: string; whatsappNumber?: string }): string {
  return `${user.whatsappCountry || ""}${user.whatsappRegion || ""}${user.whatsappNumber || ""}`.replace(/\D/g, "");
}

export default function FriendsModal({ open, onClose }: Props) {
  const { currentUser, userProfile, allUsers, isSimulation, friendshipRecords } = useAuth();
  const [searchQuery, setSearchQuery] = useState("");
  const [friends, setFriends] = useState<FriendRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [confirmRemoveUid, setConfirmRemoveUid] = useState<string | null>(null);

  // A altura é tratada pela moldura global com rolagem interna; não usamos
  // scale porque ele reduz a leitura e quebra o foco em zoom alto.

  // Carregar lista de amigos a partir da fonte única do AuthContext.
  // O listener Firestore de users/{uid}/friends fica centralizado no AuthContext.
  useEffect(() => {
    if (!open || !currentUser) return;

    const list: FriendRequest[] = friendshipRecords.map(friend => {
      const user = allUsers.find(u => u.uid === friend.uid);
      return {
        uid: friend.uid,
        nome: user?.nome || "Usuário",
        email: user?.email || "",
        status: friend.status,
        createdAt: friend.createdAt || Date.now(),
        whatsappCountry: user?.whatsappCountry || "",
        whatsappRegion: user?.whatsappRegion || "",
        whatsappNumber: user?.whatsappNumber || "",
      };
    });
    setFriends(list);
  }, [open, currentUser, allUsers, friendshipRecords]);

  // Usuários aprovados que não são amigos e não são o próprio usuário
  const availableUsers = useMemo(() => {
    const friendUids = new Set(friends.map(f => f.uid));
    return allUsers.filter(u =>
      u.status === "aprovado" &&
      u.uid !== currentUser?.uid &&
      !friendUids.has(u.uid)
    );
  }, [allUsers, friends, currentUser]);

  // Usuários filtrados pela busca
  const filteredUsers = useMemo(() => {
    if (!searchQuery.trim()) return availableUsers;
    const q = searchQuery.toLowerCase();
    return availableUsers.filter(u =>
      u.nome.toLowerCase().includes(q) ||
      u.email.toLowerCase().includes(q)
    );
  }, [availableUsers, searchQuery]);

  // Solicitações pendentes recebidas (o outro usuário enviou para mim)
  const pendingRequests = useMemo(() => {
    return friends.filter(f => f.status === "pendente");
  }, [friends]);

  // Solicitações pendentes enviadas (eu enviei para o outro usuário)
  const sentRequests = useMemo(() => {
    return friends.filter(f => f.status === "enviada");
  }, [friends]);

  // Amigos aceitos
  const acceptedFriends = useMemo(() => {
    return friends.filter(f => f.status === "aceita");
  }, [friends]);

  const showMessage = (type: "success" | "error", text: string) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 3000);
  };

  function openFriendWhatsapp(friend: FriendRequest) {
    if (friend.status !== "aceita") return;
    const phone = buildWhatsappPhone(friend);
    if (!phone) return;
    openExternalUrl(`https://wa.me/${phone}`);
  }

  // Enviar solicitação de amizade
  const sendFriendRequest = async (friendUid: string, friendNome: string) => {
    if (!currentUser) return;
    setLoading(true);

    try {
      if (isSimulation) {
        // Modo simulação - No remetente salva como "enviada"
        const friendRequest: FriendRequest = {
          uid: friendUid,
          nome: friendNome,
          email: allUsers.find(u => u.uid === friendUid)?.email || "",
          status: "enviada",
          createdAt: Date.now(),
        };
        const newFriends = [...friends, friendRequest];
        setFriends(newFriends);
        localStorage.setItem(`friends_${currentUser.uid}`, JSON.stringify(newFriends));

        // No destinatário salva como "pendente"
        const otherFriendsRaw = localStorage.getItem(`friends_${friendUid}`) || "[]";
        const otherFriends = JSON.parse(otherFriendsRaw);
        const receivedRequest = {
          uid: currentUser.uid,
          nome: userProfile?.nome || "Anônimo",
          email: userProfile?.email || "",
          status: "pendente",
          createdAt: Date.now(),
        };
        localStorage.setItem(`friends_${friendUid}`, JSON.stringify([...otherFriends, receivedRequest]));

        showMessage("success", `Solicitação enviada para ${friendNome}!`);
        setSearchQuery("");
      } else {
        // Modo real - No remetente salva como "enviada"
        const friendData = {
          status: "enviada",
          createdAt: Date.now(),
        };
        await setDoc(doc(db, "users", currentUser.uid, "friends", friendUid), friendData);

        // No destinatário salva como "pendente"
        const receivedData = {
          status: "pendente",
          createdAt: Date.now(),
        };
        await setDoc(doc(db, "users", friendUid, "friends", currentUser.uid), receivedData);

        showMessage("success", `Solicitação enviada para ${friendNome}!`);
        setSearchQuery("");
      }
    } catch (err) {
      console.error("Erro ao enviar solicitação de amizade:", err);
      showMessage("error", "Erro ao enviar solicitação de amizade. Verifique as permissões do Firestore.");
    } finally {
      setLoading(false);
    }
  };

  // Aceitar solicitação
  const acceptRequest = async (friendUid: string) => {
    if (!currentUser) return;
    setLoading(true);

    try {
      if (isSimulation) {
        const newFriends = friends.map(f =>
          f.uid === friendUid ? { ...f, status: "aceita" as const } : f
        );
        setFriends(newFriends);
        localStorage.setItem(`friends_${currentUser.uid}`, JSON.stringify(newFriends));

        // Atualizar no outro usuário também
        const otherFriendsRaw = localStorage.getItem(`friends_${friendUid}`) || "[]";
        const otherFriends = JSON.parse(otherFriendsRaw);
        const updatedOther = otherFriends.map((f: any) =>
          f.uid === currentUser.uid ? { ...f, status: "aceita" } : f
        );
        localStorage.setItem(`friends_${friendUid}`, JSON.stringify(updatedOther));

        showMessage("success", "Amizade aceita!");
      } else {
        await setDoc(doc(db, "users", currentUser.uid, "friends", friendUid), {
          status: "aceita",
          acceptedAt: Date.now(),
        }, { merge: true });
        await setDoc(doc(db, "users", friendUid, "friends", currentUser.uid), {
          status: "aceita",
          acceptedAt: Date.now(),
        }, { merge: true });
        showMessage("success", "Amizade aceita!");
      }
    } catch (err) {
      showMessage("error", "Erro ao aceitar solicitação.");
    } finally {
      setLoading(false);
    }
  };

  // Recusar solicitação
  const rejectRequest = async (friendUid: string) => {
    if (!currentUser) return;
    setLoading(true);

    try {
      if (isSimulation) {
        const newFriends = friends.filter(f => f.uid !== friendUid);
        setFriends(newFriends);
        localStorage.setItem(`friends_${currentUser.uid}`, JSON.stringify(newFriends));

        // Remover do outro usuário também
        const otherFriendsRaw = localStorage.getItem(`friends_${friendUid}`) || "[]";
        const otherFriends = JSON.parse(otherFriendsRaw);
        const updatedOther = otherFriends.filter((f: any) => f.uid !== currentUser.uid);
        localStorage.setItem(`friends_${friendUid}`, JSON.stringify(updatedOther));

        showMessage("success", "Solicitação recusada.");
      } else {
        await deleteDoc(doc(db, "users", currentUser.uid, "friends", friendUid));
        await deleteDoc(doc(db, "users", friendUid, "friends", currentUser.uid));
        showMessage("success", "Solicitação recusada.");
      }
    } catch (err) {
      showMessage("error", "Erro ao recusar solicitação.");
    } finally {
      setLoading(false);
    }
  };

  // Remover amigo
  const removeFriend = async (friendUid: string) => {
    if (!currentUser) return;
    setLoading(true);

    try {
      if (isSimulation) {
        const newFriends = friends.filter(f => f.uid !== friendUid);
        setFriends(newFriends);
        localStorage.setItem(`friends_${currentUser.uid}`, JSON.stringify(newFriends));

        // Remover do outro usuário também
        const otherFriendsRaw = localStorage.getItem(`friends_${friendUid}`) || "[]";
        const otherFriends = JSON.parse(otherFriendsRaw);
        const updatedOther = otherFriends.filter((f: any) => f.uid !== currentUser.uid);
        localStorage.setItem(`friends_${friendUid}`, JSON.stringify(updatedOther));

        showMessage("success", "Amizade removida.");
      } else {
        await deleteDoc(doc(db, "users", currentUser.uid, "friends", friendUid));
        await deleteDoc(doc(db, "users", friendUid, "friends", currentUser.uid));
        showMessage("success", "Amizade removida.");
      }
    } catch (err) {
      showMessage("error", "Erro ao remover amizade.");
    } finally {
      setConfirmRemoveUid(null);
      setLoading(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="app-modal-overlay fixed inset-0 z-[350] flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="app-modal-frame app-modal-size-xl app-modal-frame--scroll bg-gradient-to-b from-[var(--th-bg-base)] via-[var(--th-n-base)] to-[var(--th-bg-abyss)] border border-[var(--th-line)]/80 rounded-2xl shadow-[0_0_45px_color-mix(in_oklab,var(--th-brand)_38%,transparent)] w-full max-w-4xl"
      >

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[var(--th-line)]/60 bg-gradient-to-r from-[var(--th-bg-raised)] via-[var(--th-bg-base)] to-[var(--th-n-base)] flex-shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-amber-500/15 border border-amber-600/35 flex items-center justify-center shadow-[0_0_8px_color-mix(in_oklab,var(--color-amber-500)_12%,transparent)]">
              <Users size={16} className="text-amber-400" />
            </div>
            <h3 className="text-base font-bold text-white tracking-wide">Meus Amigos</h3>
            {pendingRequests.length > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-amber-500 text-black text-[10px] font-black">
                {pendingRequests.length} pendente{pendingRequests.length > 1 ? "s" : ""}
              </span>
            )}
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white p-1.5 rounded-lg hover:bg-[var(--th-line)]/25 transition-colors cursor-pointer">
            <X size={16} />
          </button>
        </div>

        {/* Message */}
        {message && (
          <div className={`px-4 py-2 text-xs font-bold ${message.type === "success" ? "bg-emerald-500/15 text-emerald-400 border-b border-emerald-500/40" : "bg-rose-500/10 text-rose-400 border-b border-rose-500/20"}`}>
            {message.text}
          </div>
        )}

        {/* Content — todas as seções visíveis simultaneamente */}
        <div className="app-modal-body p-4 space-y-3 custom-scrollbar bg-[radial-gradient(circle_at_top_right,color-mix(in_oklab,var(--th-brand)_12%,transparent),transparent_34%),radial-gradient(circle_at_bottom_left,color-mix(in_oklab,var(--color-amber-500)_6%,transparent),transparent_30%)]">
          <div className="rounded-xl border border-amber-600/25 bg-gradient-to-r from-amber-950/18 via-black/25 to-[var(--th-bg-base)]/80 px-3 py-2.5 flex items-start gap-2.5 text-[11px] leading-relaxed text-slate-300 shadow-[0_0_14px_color-mix(in_oklab,var(--color-amber-500)_6%,transparent)]">
            <div className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg border border-amber-500/30 bg-amber-500/10">
              <ShieldCheck size={14} className="text-amber-300" />
            </div>
            <p>
              <strong className="text-amber-200">Privacidade entre amigos:</strong> somente seus amigos podem visualizar seus personagens compartilhados, e você também verá apenas os personagens compartilhados por eles. Além disso, apenas amigos podem adicionar você em PTs.
            </p>
          </div>

          {/* Amigos aceitos — seção principal */}
          <section className="rounded-xl border border-amber-600/35 bg-gradient-to-br from-amber-950/20 via-black/35 to-[var(--th-bg-base)] shadow-[0_0_18px_color-mix(in_oklab,var(--color-amber-500)_8%,transparent)] overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 border-b border-amber-600/20 bg-gradient-to-r from-amber-950/30 to-[var(--th-bg-base)]">
              <div className="flex items-center gap-2 text-xs font-black text-amber-200 uppercase tracking-wider">
                <Users size={13} className="text-amber-400" />
                <span>Amigos ({acceptedFriends.length})</span>
              </div>
              <span className="text-[9px] text-amber-400/70 font-bold">Lista principal</span>
            </div>
            <div className="p-3 space-y-1 max-h-48 overflow-y-auto custom-scrollbar">
              {acceptedFriends.length === 0 ? (
                <div className="text-center py-6 text-xs text-slate-600">Você ainda não tem amigos aceitos.</div>
              ) : (
                acceptedFriends.map(friend => (
                  <div key={friend.uid} className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-black/40 border border-amber-900/30 hover:border-amber-700/40 transition-colors">
                    <div className="min-w-0">
                      <div className="font-bold text-sm text-white truncate">{friend.nome}</div>
                      <div className="text-xs text-slate-500 font-mono truncate">{maskEmail(friend.email)}</div>
                    </div>
                    {confirmRemoveUid === friend.uid ? (
                      <div className="flex flex-wrap items-center justify-end gap-1.5 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2 py-1">
                        <span className="text-[10px] font-bold text-rose-300 whitespace-nowrap">Remover este amigo?</span>
                        <button
                          type="button"
                          onClick={() => removeFriend(friend.uid)}
                          disabled={loading}
                          className="px-2 py-0.5 rounded bg-rose-500/20 border border-rose-500/40 text-rose-200 hover:bg-rose-500/30 text-[10px] font-black transition-colors cursor-pointer disabled:opacity-50"
                        >
                          Confirmar
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmRemoveUid(null)}
                          disabled={loading}
                          className="px-2 py-0.5 rounded bg-white/5 border border-white/10 text-slate-300 hover:bg-white/10 text-[10px] font-bold transition-colors cursor-pointer disabled:opacity-50"
                        >
                          Cancelar
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center justify-end gap-1.5 flex-shrink-0">
                        {buildWhatsappPhone(friend) && (
                          <button
                            type="button"
                            onClick={() => openFriendWhatsapp(friend)}
                            disabled={loading}
                            title="Abrir conversa no WhatsApp"
                            className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-emerald-500/25 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 hover:text-emerald-200 transition-colors cursor-pointer disabled:opacity-50"
                          >
                            <MessageCircle size={13} />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setConfirmRemoveUid(friend.uid)}
                          disabled={loading}
                          className="px-3 py-1 rounded-lg border border-[var(--th-line)]/50 text-slate-500 hover:text-white hover:bg-[var(--th-line)]/20 text-xs font-bold transition-colors cursor-pointer disabled:opacity-50 flex-shrink-0"
                        >
                          <UserMinus size={12} className="inline mr-1" /> Remover
                        </button>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </section>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {/* Buscar amigos */}
            <section className="rounded-xl border border-[var(--th-line)]/60 bg-black/25 overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--th-line)]/50 bg-[var(--th-bg-base)] text-xs font-black text-red-300 uppercase tracking-wider">
                <Search size={13} className="text-red-400" /> Buscar
              </div>
              <div className="p-3 space-y-3">
                <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Pesquisar usuário por nome ou e-mail..." className="w-full bg-black/40 border border-[var(--th-line)]/60 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-700/60 focus:ring-1 focus:ring-red-700/20 placeholder-slate-600" />
                <div className="space-y-1 max-h-44 overflow-y-auto custom-scrollbar">
                  {filteredUsers.length === 0 ? (
                    <div className="text-center py-6 text-xs text-slate-600">Nenhum usuário encontrado.</div>
                  ) : (
                    filteredUsers.map(user => (
                      <div key={user.uid} className="flex items-center justify-between px-3 py-2 rounded-lg bg-black/40 border border-[var(--th-line)]/60">
                        <div>
                          <div className="font-bold text-sm text-white">{user.nome}</div>
                          <div className="text-xs text-slate-500 font-mono">{maskEmail(user.email)}</div>
                        </div>
                        <button onClick={() => sendFriendRequest(user.uid, user.nome)} disabled={loading} className="px-3 py-1 rounded-lg bg-gradient-to-r from-[var(--th-brand-mid)] to-[var(--th-brand)] hover:from-[var(--th-brand-bright)] hover:to-[var(--th-line-strong)] border border-[var(--th-brand-mid)]/60 text-white text-xs font-bold shadow-red-900/30 transition-colors cursor-pointer disabled:opacity-50">
                          <UserPlus size={12} className="inline mr-1" /> Solicitar
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </section>

            {/* Solicitações pendentes recebidas */}
            <section className="rounded-xl border border-[var(--th-line)]/60 bg-black/25 overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--th-line)]/50 bg-[var(--th-bg-base)] text-xs font-black text-red-300 uppercase tracking-wider">
                <Clock size={13} className="text-amber-400" /> Recebidas ({pendingRequests.length})
              </div>
              <div className="p-3 space-y-1 max-h-44 overflow-y-auto custom-scrollbar">
                {pendingRequests.length === 0 ? (
                  <div className="text-center py-6 text-xs text-slate-600">Nenhuma solicitação pendente recebida.</div>
                ) : (
                  pendingRequests.map(friend => (
                    <div key={friend.uid} className="flex items-center justify-between px-3 py-2 rounded-lg bg-black/40 border border-[var(--th-line)]/60">
                      <div>
                        <div className="font-bold text-sm text-white">{friend.nome}</div>
                        <div className="text-xs text-slate-500 font-mono">{maskEmail(friend.email)}</div>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => acceptRequest(friend.uid)} disabled={loading} className="px-3 py-1 rounded-lg bg-gradient-to-r from-[var(--th-brand-mid)] to-[var(--th-brand)] hover:from-[var(--th-brand-bright)] hover:to-[var(--th-line-strong)] border border-[var(--th-brand-mid)]/60 text-white text-xs font-bold shadow-red-900/30 transition-colors cursor-pointer disabled:opacity-50">
                          <Check size={12} className="inline mr-1" /> Aceitar
                        </button>
                        <button onClick={() => rejectRequest(friend.uid)} disabled={loading} className="px-3 py-1 rounded-lg border border-[var(--th-line)]/50 text-slate-500 hover:text-white hover:bg-[var(--th-line)]/20 text-xs font-bold transition-colors cursor-pointer disabled:opacity-50">
                          <X size={12} className="inline mr-1" /> Recusar
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>

            {/* Solicitações pendentes enviadas */}
            <section className="rounded-xl border border-[var(--th-line)]/60 bg-black/25 overflow-hidden lg:col-span-2">
              <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--th-line)]/50 bg-[var(--th-bg-base)] text-xs font-black text-red-300 uppercase tracking-wider">
                <Clock size={13} className="text-slate-400" /> Enviadas ({sentRequests.length})
              </div>
              <div className="p-3 space-y-1 max-h-36 overflow-y-auto custom-scrollbar">
                {sentRequests.length === 0 ? (
                  <div className="text-center py-6 text-xs text-slate-600">Nenhuma solicitação enviada pendente.</div>
                ) : (
                  sentRequests.map(friend => (
                    <div key={friend.uid} className="flex items-center justify-between px-3 py-2 rounded-lg bg-black/40 border border-[var(--th-line)]/60">
                      <div>
                        <div className="font-bold text-sm text-white">{friend.nome}</div>
                        <div className="text-xs text-slate-500 font-mono flex items-center gap-2">
                          <span>{maskEmail(friend.email)}</span>
                          <span className="text-[10px] text-amber-300 font-bold">⏳ Aguardando resposta</span>
                        </div>
                      </div>
                      <button onClick={() => rejectRequest(friend.uid)} disabled={loading} className="px-3 py-1.5 rounded-lg border border-[var(--th-line)]/50 text-slate-500 hover:text-white hover:bg-[var(--th-line)]/20 text-xs font-bold transition-colors cursor-pointer disabled:opacity-50">
                        <X size={12} className="inline mr-1" /> Cancelar Solicitação
                      </button>
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>
        </div>

        <div className="app-modal-footer px-4 sm:px-5 py-3 border-t border-[var(--th-line)]/60 bg-gradient-to-r from-[var(--th-bg-base)] to-[var(--th-n-base)] flex flex-wrap justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg border border-[var(--th-line)]/50 hover:bg-[var(--th-line)]/20 text-slate-500 hover:text-white text-xs font-bold transition-colors cursor-pointer">Fechar</button>
        </div>
      </div>
    </div>
  );
}