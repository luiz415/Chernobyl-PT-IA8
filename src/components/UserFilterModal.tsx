import { useMemo, useState } from "react";
import { X, Users } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { useOverviewFilters } from "../hooks/useOverviewFilters";

/**
 * FILTRAR USUÁRIOS — modal dedicado à seleção de usuários cujos personagens
 * são considerados na Visão Geral e no Bazaar (Resumo de Amigos/notificações).
 *
 * É a MESMA funcionalidade que vivia no "Grupo 4: Usuários Aprovados" do
 * OverviewFiltersModal — movida para cá sem lógica paralela:
 *   • o estado (userMode/selectedUsers) continua sendo o store único de
 *     `useOverviewFilters` (persistido em unified_overview_filters.state);
 *   • a lista de usuários vem do AuthContext (amigos aceitos + o próprio),
 *     exatamente como antes — nenhuma consulta adicional ao Firestore;
 *   • alterar aqui reflete imediatamente em TODOS os consumidores do hook
 *     (OverviewPanel, BazarPanel, Resumo de Amigos), e vice-versa.
 */
interface Props {
  open: boolean;
  onClose: () => void;
  /** Camada de empilhamento — mesmo contrato do OverviewFiltersModal. */
  zIndexClassName?: string;
}

export default function UserFilterModal({ open, onClose, zIndexClassName = "z-[1000]" }: Props) {
  const { allUsers, acceptedFriendUids, currentUser, userProfile } = useAuth();
  const { userMode, setUserMode, selectedUsers, setSelectedUsers } = useOverviewFilters();
  const [userSearch, setUserSearch] = useState("");

  // Listar apenas amigos aceitos do usuário logado.
  // A fonte é o AuthContext, que já mantém users/{uid}/friends em memória,
  // evitando qualquer nova consulta/listener no Firestore.
  // (Mesma derivação que existia no OverviewFiltersModal.)
  const approvedUsersList = useMemo(() => {
    const friendUidSet = new Set(acceptedFriendUids || []);
    const names = new Set<string>();
    const ownName = (userProfile?.nome || allUsers?.find(u => u.uid === currentUser?.uid)?.nome || "").trim();
    if (ownName) names.add(ownName);
    (allUsers || [])
      .filter(u => u.status === "aprovado" && friendUidSet.has(u.uid))
      .map(u => u.nome)
      .filter(Boolean)
      .forEach(name => names.add(String(name).trim()));
    return Array.from(names).filter(Boolean).sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [allUsers, acceptedFriendUids, currentUser?.uid, userProfile?.nome]);

  if (!open) return null;

  function handleToggleUser(u: string) {
    if (selectedUsers.includes(u)) {
      setSelectedUsers(selectedUsers.filter(x => x !== u));
    } else {
      setSelectedUsers([...selectedUsers, u]);
    }
  }

  return (
    <div
      className={`app-modal-overlay fixed inset-0 ${zIndexClassName} flex items-center justify-center bg-black/85 backdrop-blur-sm select-none`}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="app-modal-frame app-modal-size-sm app-modal-frame--scroll bg-[var(--th-bg-deep)] border border-[var(--th-line-strong)]/80 rounded-2xl shadow-[0_0_40px_color-mix(in_oklab,var(--th-brand)_40%,transparent)] w-full max-w-md animate-in zoom-in-95 duration-200">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 bg-gradient-to-r from-[var(--th-bg-base)] to-[var(--th-bg-abyss)] border-b border-[var(--th-line)]/50">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-red-950/40 border border-red-800/40 flex items-center justify-center">
              <Users size={15} className="text-amber-500" />
            </div>
            <div>
              <h3 className="text-sm font-black text-white uppercase tracking-wider">Filtrar Usuários</h3>
              <p className="text-[9px] text-slate-500">Personagens dos usuários selecionados são considerados no Bazaar e na Visão Geral</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-red-900/20 transition-colors cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>

        {/* Content — MESMO quadro que existia no modal de filtros */}
        <div className="app-modal-body p-4 sm:p-5 custom-scrollbar">
          <div className="bg-[var(--th-bg-base)] border border-[var(--th-line)]/30 rounded-xl p-3 space-y-2">
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 text-[10px] text-red-400/80 font-black uppercase cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={userMode === "filter"}
                  onChange={e => setUserMode(e.target.checked ? "filter" : "any")}
                  className={`w-4 h-4 accent-red-500 cursor-pointer appearance-none rounded-[3px] border ${userMode === "filter" ? "border-red-500 bg-red-950/50" : "border-red-900/40 bg-[var(--th-bg-deep)]"} hover:border-red-600 focus:outline-none transition-colors relative checked:after:content-['✓'] checked:after:absolute checked:after:inset-0 checked:after:flex checked:after:items-center checked:after:justify-center checked:after:text-[10px] checked:after:text-amber-400 checked:after:font-black`}
                />
                <span>Filtrar por Usuários Autorizados</span>
              </label>
              {userMode === "filter" && selectedUsers.length > 0 && (
                <button type="button" onClick={() => setSelectedUsers([])} className="text-[9px] text-rose-400 hover:underline font-bold cursor-pointer">
                  Limpar todos ({selectedUsers.length})
                </button>
              )}
            </div>

            {userMode === "filter" && (
              <div className="space-y-1.5 animate-in fade-in duration-200">
                <input
                  type="text"
                  value={userSearch}
                  onChange={e => setUserSearch(e.target.value)}
                  placeholder="Pesquisar usuários autorizados..."
                  className="w-full bg-black/45 border border-red-900/40 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-red-700/60 placeholder-slate-650 transition-colors"
                />
                <div className="flex flex-wrap gap-1 max-h-40 overflow-y-auto pr-1 custom-scrollbar">
                  {approvedUsersList.filter(u => !userSearch || u.toLowerCase().includes(userSearch.toLowerCase())).map(u => {
                    const checked = selectedUsers.includes(u);
                    return (
                      <button
                        key={u}
                        type="button"
                        onClick={() => handleToggleUser(u)}
                        className={`px-2 py-0.5 rounded text-[10px] font-extrabold transition-all cursor-pointer border ${
                          checked
                            ? "bg-red-900/35 border-red-600 text-amber-200 shadow-sm"
                            : "bg-black/35 border-red-950/40 text-slate-400 hover:text-slate-200"
                        }`}
                      >
                        {u}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {userMode !== "filter" && (
              <p className="text-[10px] text-slate-500">
                Com a caixa desmarcada, os personagens de todos os usuários autorizados são considerados normalmente.
              </p>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="app-modal-footer px-4 sm:px-5 py-3.5 bg-gradient-to-r from-[var(--th-bg-base)] to-[var(--th-bg-abyss)] border-t border-[var(--th-line)]/50 flex items-center justify-between gap-2">
          <span className="text-[10px] text-slate-500">
            {userMode === "filter"
              ? `${selectedUsers.length} usuário${selectedUsers.length === 1 ? "" : "s"} selecionado${selectedUsers.length === 1 ? "" : "s"}`
              : "Filtro desativado"}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-1.5 px-5 py-1.5 rounded-lg bg-gradient-to-r from-[var(--th-brand-mid)] to-[var(--th-line)] hover:from-[var(--th-brand-bright)] hover:to-[var(--th-line-strong)] text-white font-bold text-xs shadow-lg shadow-red-950/40 border border-[var(--th-brand-mid)]/60 transition-all cursor-pointer"
          >
            Aplicar
          </button>
        </div>

      </div>
    </div>
  );
}
