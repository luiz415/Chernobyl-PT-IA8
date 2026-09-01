import { useState, useMemo } from "react";
import { X, Target, Filter, RotateCcw, ChevronDown, Check } from "lucide-react";
import type { PartyTemplateType } from "../utils/suggestionAlgorithm";
import { normalizeTemplateType } from "../utils/suggestionAlgorithm";
import { useAuth } from "../context/AuthContext";
import { VOC_COLORS } from "../types";

interface Props {
  open: boolean;
  onClose: () => void;
  /**
   * Camada de empilhamento. O padrão cobre o uso na Visão Geral; quando aberto
   * sobre o Resumo de Amigos (z-[9999]) é preciso um valor maior, senão o modal
   * renderiza ATRÁS e fica inacessível.
   */
  zIndexClassName?: string;
  // Filtros atuais
  questFilter: "soulwar" | "sanguine" | "all";
  setQuestFilter: (v: "soulwar" | "sanguine" | "all") => void;
  templateType: PartyTemplateType;
  setTemplateType: (v: PartyTemplateType) => void;
  minLevels: Record<string, number>;
  setMinLevels: (v: Record<string, number>) => void;
  userMode: "any" | "filter";
  setUserMode: (v: "any" | "filter") => void;
  selectedUsers: string[];
  setSelectedUsers: (v: string[]) => void;
  // Estados de origem
  useCharacters: boolean;
  setUseCharacters: (v: boolean) => void;
  useWaitingList: boolean;
  setUseWaitingList: (v: boolean) => void;
  // Ações
  onReset: () => void;
}

export default function OverviewFiltersModal({
  open,
  onClose,
  zIndexClassName = "z-[1000]",
  questFilter,
  setQuestFilter,
  templateType,
  setTemplateType,
  minLevels,
  setMinLevels,
  userMode,
  setUserMode,
  selectedUsers,
  setSelectedUsers,
  useCharacters,
  setUseCharacters,
  useWaitingList,
  setUseWaitingList,
  onReset,
}: Props) {
  const { allUsers, acceptedFriendUids, currentUser, userProfile } = useAuth();
  const [userSearch, setUserSearch] = useState("");

  // Listar apenas amigos aceitos do usuário logado.
  // A fonte é o AuthContext, que já mantém users/{uid}/friends em memória,
  // evitando qualquer nova consulta/listener no Firestore.
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

  const [compositionSelectOpen, setCompositionSelectOpen] = useState(false);
  // Só duas categorias: Ideal (composição única) e Muito Boa (as oito demais,
  // escolhidas por escassez de vocação, sem ordem fixa). "PT Boa" e
  // "Aceitável" deixaram de existir.
  const compositionOptions: Array<{ value: PartyTemplateType; label: string; featured?: boolean }> = [
    { value: "inteligente", label: "✨ Auto (Inteligente)", featured: true },
    { value: "ideal", label: "PT Ideal (1 EK, 1 MK, 1 ED, 1 RP, 1 MS)" },
    { value: "muito_boa", label: "PT Muito Boa (melhor entre as 8 composições)" },
  ];
  // Preferência legada salva no localStorage é normalizada antes de casar com
  // as opções, para o seletor nunca aparecer em branco após a atualização.
  const normalizedTemplateType = normalizeTemplateType(templateType);
  const selectedComposition = compositionOptions.find(option => option.value === normalizedTemplateType) || compositionOptions[0];

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
      <div className="app-modal-frame app-modal-size-md app-modal-frame--scroll bg-[var(--th-bg-deep)] border border-[var(--th-line-strong)]/80 rounded-2xl shadow-[0_0_40px_color-mix(in_oklab,var(--th-brand)_40%,transparent)] w-full max-w-lg animate-in zoom-in-95 duration-200">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 bg-gradient-to-r from-[var(--th-bg-base)] to-[var(--th-bg-abyss)] border-b border-[var(--th-line)]/50">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-red-950/40 border border-red-800/40 flex items-center justify-center">
              <Filter size={15} className="text-amber-500" />
            </div>
            <div>
              <h3 className="text-sm font-black text-white uppercase tracking-wider">Filtros Visão Geral e Resumo de Amigos (Bazaar)</h3>
              <p className="text-[9px] text-slate-500">Ajuste o panorama geral de análise de servidores</p>
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

        {/* Content */}
        <div className="app-modal-body p-4 sm:p-5 space-y-4 custom-scrollbar">

          {/* Grupo 1: Quest e Composição */}
          <div className="grid grid-cols-2 gap-4 bg-[var(--th-bg-base)] border border-[var(--th-line)]/30 rounded-xl p-3">
            <div>
              <label className="block text-[9px] text-red-400/80 uppercase font-black tracking-wider mb-2">Quest Alvo</label>
              <div className="flex gap-1 bg-black/40 p-0.5 rounded-lg border border-red-900/30">
                {(["all", "soulwar", "sanguine"] as const).map(q => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => setQuestFilter(q)}
                    className={`flex-1 py-1 rounded text-[9px] font-bold transition-all cursor-pointer ${
                      questFilter === q
                        ? q === "sanguine" ? "bg-rose-700 text-white" : q === "soulwar" ? "bg-slate-600 text-white" : "bg-red-800 text-white"
                        : "text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    {q === "all" ? "Todas" : q === "soulwar" ? "SW" : "SG"}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-[9px] text-red-400/80 uppercase font-black tracking-wider mb-2">Composição</label>
              <div className={`relative rounded-lg p-[1px] transition-all duration-200 ${
                templateType === "inteligente"
                  ? "bg-gradient-to-r from-amber-700/70 via-amber-500/35 to-red-900/45 shadow-[0_0_14px_color-mix(in_oklab,var(--color-amber-500)_14%,transparent)]"
                  : "bg-gradient-to-r from-red-950/70 via-[var(--th-line)]/45 to-red-950/70"
              }`}>
                <button
                  type="button"
                  onClick={() => setCompositionSelectOpen(v => !v)}
                  onBlur={() => window.setTimeout(() => setCompositionSelectOpen(false), 120)}
                  className={`w-full h-[28px] rounded-[7px] px-2.5 py-1 text-[10px] font-black focus:outline-none cursor-pointer transition-all duration-200 shadow-inner shadow-black/30 flex items-center justify-between gap-2 ${
                    templateType === "inteligente"
                      ? "bg-gradient-to-r from-amber-950/85 via-[var(--th-line-subtle)] to-[var(--th-bg-base)] text-amber-200 focus:ring-1 focus:ring-amber-500/30"
                      : "bg-gradient-to-r from-[var(--th-bg-abyss)] via-[var(--th-bg-base)] to-[var(--th-bg-abyss)] text-white focus:ring-1 focus:ring-red-900/40"
                  }`}
                >
                  <span className="truncate">{selectedComposition.label}</span>
                  <ChevronDown size={12} className={`flex-shrink-0 transition-transform duration-200 ${compositionSelectOpen ? "rotate-180 text-amber-300" : "text-red-300/70"}`} />
                </button>

                {compositionSelectOpen && (
                  <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-[1100] overflow-hidden rounded-xl border border-red-900/60 bg-[var(--th-bg-deep)]/98 shadow-2xl shadow-black/70 backdrop-blur-sm animate-in fade-in zoom-in-95 duration-100">
                    <div className="max-h-56 overflow-y-auto p-1 custom-scrollbar">
                      {compositionOptions.map(option => {
                        const selected = option.value === normalizedTemplateType;
                        const featured = option.featured === true;
                        return (
                          <button
                            key={option.value}
                            type="button"
                            onMouseDown={e => e.preventDefault()}
                            onClick={() => {
                              setTemplateType(option.value);
                              setCompositionSelectOpen(false);
                            }}
                            className={`w-full flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[10px] font-bold transition-all duration-150 cursor-pointer ${
                              featured
                                ? selected
                                  ? "bg-gradient-to-r from-amber-800/55 via-amber-700/35 to-red-950/55 text-amber-100 border border-amber-500/35 shadow-[inset_0_0_14px_color-mix(in_oklab,var(--color-amber-500)_12%,transparent)]"
                                  : "bg-amber-950/30 text-amber-200/90 hover:bg-gradient-to-r hover:from-amber-900/55 hover:to-red-950/40 hover:text-amber-100 border border-amber-700/20"
                                : selected
                                  ? "bg-red-900/45 text-white border border-red-600/45"
                                  : "text-slate-300 hover:bg-[var(--th-bg-active)] hover:text-amber-100 border border-transparent hover:border-red-800/45"
                            }`}
                          >
                            <span className="truncate">{option.label}</span>
                            {selected && <Check size={11} className={featured ? "text-amber-300" : "text-red-300"} />}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Grupo 2: Origem dos Dados */}
          <div className="bg-[var(--th-bg-base)] border border-[var(--th-line)]/30 rounded-xl p-3 space-y-2">
            <label className="block text-[9px] text-red-400/80 uppercase font-black tracking-wider mb-1">Origem dos Dados</label>
            <div className="grid grid-cols-2 gap-3">
              <label className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border transition-all cursor-pointer text-[10px] font-bold ${useCharacters ? "bg-red-950/40 border-red-800/60 text-red-200" : "bg-black/20 border-red-950/20 text-slate-450 hover:bg-[var(--th-bg-raised)] hover:border-red-900/30"}`}>
                <input
                  type="checkbox"
                  checked={useCharacters}
                  onChange={e => setUseCharacters(e.target.checked)}
                  className={`w-4 h-4 accent-red-500 cursor-pointer appearance-none rounded-[3px] border ${useCharacters ? "border-red-500 bg-red-950/50" : "border-red-900/40 bg-[var(--th-bg-deep)]"} hover:border-red-600 focus:outline-none transition-colors relative checked:after:content-['✓'] checked:after:absolute checked:after:inset-0 checked:after:flex checked:after:items-center checked:after:justify-center checked:after:text-[10px] checked:after:text-amber-400 checked:after:font-black`}
                />
                Disponíveis (Hub)
              </label>
              <label className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border transition-all cursor-pointer text-[10px] font-bold ${useWaitingList ? "bg-red-950/40 border-red-800/60 text-red-200" : "bg-black/20 border-red-950/20 text-slate-450 hover:bg-[var(--th-bg-raised)] hover:border-red-900/30"}`}>
                <input
                  type="checkbox"
                  checked={useWaitingList}
                  onChange={e => setUseWaitingList(e.target.checked)}
                  className={`w-4 h-4 accent-red-500 cursor-pointer appearance-none rounded-[3px] border ${useWaitingList ? "border-red-500 bg-red-950/50" : "border-red-900/40 bg-[var(--th-bg-deep)]"} hover:border-red-600 focus:outline-none transition-colors relative checked:after:content-['✓'] checked:after:absolute checked:after:inset-0 checked:after:flex checked:after:items-center checked:after:justify-center checked:after:text-[10px] checked:after:text-amber-400 checked:after:font-black`}
                />
                Service (Espera)
              </label>
            </div>
          </div>

          {/* Grupo 3: Nível Mínimo */}
          <div className="bg-[var(--th-bg-base)] border border-[var(--th-line)]/30 rounded-xl p-3">
            <label className="block text-[9px] text-red-400/80 uppercase font-black tracking-wider mb-2.5 flex items-center gap-1">
              <Target size={10} className="text-amber-500" /> Nível Mínimo por Vocação
            </label>
            <div className="flex items-center justify-between gap-1.5">
              {(["EK", "ED", "MS", "RP", "MK"] as const).map(voc => (
                <div key={voc} className="flex flex-col items-center gap-1 flex-1 bg-black/20 border border-red-950/40 p-1.5 rounded-lg">
                  <span className="text-[10px] font-black" style={{ color: VOC_COLORS[voc] }}>{voc}</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={minLevels[voc] ?? ""}
                    onChange={e => {
                      const raw = e.target.value.replace(/\D/g, "");
                      setMinLevels({ ...minLevels, [voc]: raw ? parseInt(raw, 10) : 0 });
                    }}
                    placeholder="500"
                    className="w-full text-center bg-black/40 border border-red-900/35 rounded py-0.5 text-[10px] font-black text-white focus:outline-none focus:border-red-700/50"
                  />
                </div>
              ))}
            </div>
          </div>

          {/* Grupo 4: Usuários Aprovados */}
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
                <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto pr-1 custom-scrollbar">
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
          </div>

        </div>

        {/* Footer */}
        <div className="app-modal-footer px-4 sm:px-5 py-3.5 bg-gradient-to-r from-[var(--th-bg-base)] to-[var(--th-bg-abyss)] border-t border-[var(--th-line)]/50 flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            onClick={onReset}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-[var(--th-line)]/60 hover:bg-[var(--th-line)]/20 text-slate-450 hover:text-white text-xs font-semibold transition-all cursor-pointer"
          >
            <RotateCcw size={13} /> Resetar Padrão
          </button>

          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-1.5 px-5 py-1.5 rounded-lg bg-gradient-to-r from-[var(--th-brand-mid)] to-[var(--th-line)] hover:from-[var(--th-brand-bright)] hover:to-[var(--th-line-strong)] text-white font-bold text-xs shadow-lg shadow-red-950/40 border border-[var(--th-brand-mid)]/60 transition-all cursor-pointer"
          >
            Aplicar Filtros
          </button>
        </div>

      </div>
    </div>
  );
}