import { useState, useMemo } from "react";
import { 
  BarChart3, 
  Swords, Filter, RotateCcw
} from "lucide-react";
import type { Character, PartyTab, WaitingService } from "../types";
import { VOC_COLORS } from "../types";
import { analyzeServerPotential, type ServerAnalysis } from "../utils/suggestionAlgorithm";
import { useAuth } from "../context/AuthContext";
import OverviewFiltersModal from "./OverviewFiltersModal";
import { useOverviewFilters } from "../hooks/useOverviewFilters";
import { SERVER_OPTIONS, serverLabel } from "../constants/servers";

interface Props {
  characters: Character[];
  waitingList: WaitingService[];
  activeParties: PartyTab[];
}

// Lista oficial centralizada em src/constants/servers.ts
const SERVERS = SERVER_OPTIONS;

export default function OverviewPanel({ characters, waitingList, activeParties }: Props) {
  const { userProfile } = useAuth();
  const currentUserName = userProfile?.nome || "Anônimo";

  // --- Sistema de Filtros Avançados ---
  // Estado compartilhado com o Resumo de Amigos (Bazaar). Alterar aqui reflete
  // imediatamente lá, e vice-versa — ver src/hooks/useOverviewFilters.ts.
  const [showFilters, setShowFilters] = useState(false);
  const {
    questFilter, setQuestFilter,
    templateType, setTemplateType,
    minLevels, setMinLevels,
    userMode, setUserMode,
    selectedUsers, setSelectedUsers,
    useCharacters, setUseCharacters,
    useWaitingList, setUseWaitingList,
    resetFilters,
  } = useOverviewFilters();

  // --- Recálculo Inteligente e Imediato dos Dados (com Cache e Estabilidade) ---
  // Identifica IDs de personagens e services já alocados em PTs ativas (não arquivadas)
  const busyIds = useMemo(() => {
    const set = new Set<string>();
    (activeParties || []).forEach(p => {
      if (p.archived) return;
      (p.selectedIds || []).forEach(id => set.add(id));
    });
    return set;
  }, [activeParties]);

  const unifiedCandidates = useMemo(() => {
    const list: any[] = [];
    if (useCharacters) {
      characters.filter(c => !c.vendido && !busyIds.has(c.id)).forEach(c => {
        list.push({
          id: c.id,
          servidor: serverLabel(c.servidor),
          voc: c.voc,
          level: c.level || 0,
          dono: c.ownerName || currentUserName || "Anônimo",
          account: c.account || "",
          type: "char" as const,
          rawObj: c
        });
      });
    }
    if (useWaitingList) {
      waitingList.filter(w => !busyIds.has(w.id)).forEach(w => {
        list.push({
          id: w.id,
          servidor: serverLabel(w.servidor),
          voc: w.voc,
          level: w.level || 0,
          dono: w.ownerName || w.addedBy || currentUserName || "Anônimo",
          account: `service_${w.id}`,
          type: "waiting" as const,
          rawObj: w
        });
      });
    }
    return list;
  }, [characters, waitingList, currentUserName, useCharacters, useWaitingList, busyIds]);

  const serverAnalysis = useMemo(() => {
    const analysis = SERVERS.map(srv => {
      return analyzeServerPotential(unifiedCandidates, srv, {
        questFilter,
        questType: questFilter === "all" ? "soulwar" : questFilter,
        minLevels,
        templateType,
        userMode,
        selectedUsers,
        maxOwnerRepeats: null,
        strength: "high",
        serverMode: "specific",
        specificServer: srv
      } as any);
    });

    // Ranking automático: maior número de PTs possíveis, melhor equilíbrio e volume de chars
    return analysis.sort((a, b) => {
      if (b.possiblePTs !== a.possiblePTs) return b.possiblePTs - a.possiblePTs;
      if (b.eligibleChars !== a.eligibleChars) return b.eligibleChars - a.eligibleChars;
      return a.serverName.localeCompare(b.serverName);
    });
  }, [unifiedCandidates, questFilter, minLevels, templateType, userMode, selectedUsers]);

  // --- Helpers de Exibição Compacta ---
  function renderIndicatorBadge(srv: ServerAnalysis) {
    if (srv.status === "ideal") {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-extrabold bg-emerald-950/40 border border-emerald-500/50 text-emerald-300">
          ✅ PT Ideal disponível
        </span>
      );
    }
    if (srv.status === "boa") {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-extrabold bg-emerald-950/40 border border-emerald-500/50 text-emerald-400">
          🟢 PT Boa
        </span>
      );
    }
    if (srv.status === "falta1") {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-extrabold bg-amber-950/40 border border-amber-500/50 text-amber-300">
          🟡 Falta 1 vocação
        </span>
      );
    }
    if (srv.status === "falta2") {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-extrabold bg-orange-950/40 border border-orange-500/50 text-orange-300">
          🟠 Faltam 2 vocações
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-rose-950/30 border border-rose-500/40 text-rose-400/80">
        🔴 Sem potencial
      </span>
    );
  }

  const activeFiltersCount = (questFilter !== "all" ? 1 : 0) + 
                             (templateType !== "inteligente" ? 1 : 0) + 
                             (userMode === "filter" && selectedUsers.length > 0 ? 1 : 0) +
                             (!useCharacters || !useWaitingList ? 1 : 0);

  const filterSummary = useMemo(() => {
    const parts: string[] = [];
    if (userMode === "filter" && selectedUsers.length > 0) {
      if (selectedUsers.length <= 2) parts.push(`👤 ${selectedUsers.join(", ")}`);
      else parts.push(`👥 ${selectedUsers.length} usuários`);
    } else {
      parts.push("👥 Todos");
    }
    parts.push(questFilter === "all" ? "Todas quests" : questFilter === "soulwar" ? "Soulwar" : "Sanguine");
    const templateLabel = templateType === "inteligente" ? "Auto" : templateType === "ideal" ? "Ideal" : templateType === "custom" ? "Custom" : "Muito Boa";
    parts.push(templateLabel);
    if (!useCharacters || !useWaitingList) {
      parts.push(useCharacters ? "Personagens" : "Services");
    }
    return parts.join(" • ");
  }, [questFilter, templateType, userMode, selectedUsers, useCharacters, useWaitingList]);

  return (
    <div className="flex flex-col h-full bg-[var(--th-n-base)] text-sm rounded-xl border border-[var(--th-line)]/80 p-3 relative overflow-hidden select-none">
      {/* Background Sutil e Premium */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-0 right-0 w-64 h-64 bg-red-950/10 blur-[100px] rounded-full" />
      </div>

      {/* Topo com Título e Botões Fixos de Filtros */}
      <div className="flex items-center justify-between pb-2.5 mb-2 border-b border-[var(--th-line)]/50 flex-shrink-0 relative z-10">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[var(--th-line)] to-[var(--th-brand-mid)]/40 border border-[var(--th-brand-mid)]/60 flex items-center justify-center shadow-md">
            <BarChart3 size={16} className="text-amber-500" />
          </div>
          <div>
            <h2 className="text-sm font-black bg-gradient-to-r from-red-500 via-orange-400 to-yellow-400 bg-clip-text text-transparent uppercase tracking-tight">
              Visão Geral
            </h2>
            <p className="text-[10px] text-slate-400 font-medium leading-none mt-0.5">
              Panorama inteligente • {unifiedCandidates.length} personagens analisados
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <div
            className="hidden md:inline-flex items-center max-w-[360px] px-2.5 py-1 rounded-lg border border-[var(--th-line)]/50 bg-black/25 text-[10px] font-semibold text-amber-300/90 truncate shadow-inner shadow-black/20"
            title={filterSummary}
          >
            <span className="truncate">{filterSummary}</span>
          </div>

          <button
            type="button"
            onClick={resetFilters}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-red-900/30 bg-black/30 text-slate-400 hover:text-white hover:bg-red-950/20 text-[10px] font-bold transition-all cursor-pointer"
            title="Restaurar filtros para os valores padrão"
          >
            <RotateCcw size={11} /> Resetar filtros
          </button>

          <button
            type="button"
            onClick={() => setShowFilters(v => !v)}
            className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-lg text-[10px] font-extrabold border transition-all cursor-pointer shadow-sm ${
              showFilters || activeFiltersCount > 0
                ? "bg-gradient-to-r from-red-800 to-red-900 border-red-500/80 text-white shadow-red-950/50"
                : "bg-[var(--th-bg-base)] border-[var(--th-brand)] text-amber-500 hover:text-amber-300 hover:border-red-600/70"
            }`}
          >
            <Filter size={11} className={activeFiltersCount > 0 ? "text-amber-300 animate-pulse" : ""} />
            <span>Filtros</span>
            {activeFiltersCount > 0 && (
              <span className="w-4 h-4 rounded-full bg-amber-500 text-black font-mono font-black flex items-center justify-center text-[9px] leading-none">
                {activeFiltersCount}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Modal Dedicado de Filtros Avançados */}
      <OverviewFiltersModal
        open={showFilters}
        onClose={() => setShowFilters(false)}
        questFilter={questFilter}
        setQuestFilter={setQuestFilter}
        templateType={templateType}
        setTemplateType={setTemplateType}
        minLevels={minLevels}
        setMinLevels={setMinLevels}
        userMode={userMode}
        setUserMode={setUserMode}
        selectedUsers={selectedUsers}
        setSelectedUsers={setSelectedUsers}
        useCharacters={useCharacters}
        setUseCharacters={setUseCharacters}
        useWaitingList={useWaitingList}
        setUseWaitingList={setUseWaitingList}
        onReset={resetFilters}
      />

      {/* Grade de Quadros de Servidores Ultra Compactos */}
      <div className="flex-1 overflow-y-auto pr-1 custom-scrollbar relative z-10">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
          {serverAnalysis.map((srv) => {
            const missingText = srv.missingVocs.map(m => `${m.count} ${m.voc}`).join(", ");
            const surplusText = srv.surplusVocs.filter(s => s.count > 0).map(s => `${s.count} ${s.voc}`).join(", ");
            
            return (
              <div
                key={srv.serverName}
                className="bg-[var(--th-bg-base)] border border-[var(--th-line)]/60 hover:border-red-800/80 rounded-lg p-2.5 flex flex-col justify-between transition-all group shadow-sm"
              >
                {/* 1ª Linha: Nome do Servidor • Quantidade de personagens • Indicador do Potencial */}
                <div className="flex items-center justify-between gap-1.5 pb-1.5 border-b border-[var(--th-line)]/30 min-w-0">
                  <div className="flex items-baseline gap-1.5 min-w-0">
                    <h3 className="text-xs font-black text-white truncate tracking-wide">{srv.serverName}</h3>
                    <span className="text-[10px] text-slate-400 font-bold tabular-nums flex-shrink-0">
                      ({srv.eligibleChars} chars)
                    </span>
                  </div>
                  {renderIndicatorBadge(srv)}
                </div>

                {/* 2ª Linha: Contagem Horizontal por Vocação (EK • ED • MS • RP • MK) */}
                <div className="flex items-center justify-between py-1 px-1 bg-black/25 rounded border border-red-950/40 my-1">
                  {(["EK", "ED", "MS", "RP", "MK"] as const).map((voc, vIdx) => (
                    <div key={voc} className="flex items-center gap-0.5 text-[10px] font-black">
                      {vIdx > 0 && <span className="text-slate-700/60 font-normal select-none mr-0.5">•</span>}
                      <span style={{ color: VOC_COLORS[voc] }}>{voc}:</span>
                      <span className="text-slate-200 tabular-nums">{srv.counts[voc]}</span>
                    </div>
                  ))}
                </div>

                {/* 3ª Linha: PTs Possíveis • Composição Disponível */}
                <div className="flex items-center justify-between text-[10px] font-extrabold text-slate-300 py-0.5 px-0.5">
                  <span className="flex items-center gap-1 text-amber-400">
                    <Swords size={11} className="text-amber-500/80 inline" />
                    <span>PTs possíveis: <strong className="text-white text-[11px] tabular-nums">{srv.possiblePTs}</strong></span>
                  </span>
                  <span className="text-slate-400 truncate max-w-[110px]" title={srv.bestComposition}>
                    Comp: <span className="text-slate-200 font-bold">{srv.bestComposition}</span>
                  </span>
                </div>

                {/* 4ª Linha: Diagnóstico (Falta X • Sobrando Y + Estimativa Se adicionar...) */}
                <div className="pt-1 mt-0.5 border-t border-[var(--th-line)]/30 flex items-center justify-between text-[9px] font-bold leading-tight min-w-0 gap-2">
                  <div className="min-w-0 truncate">
                    {missingText ? (
                      <span className="text-amber-400/90 truncate block" title={`Falta: ${missingText}`}>
                        Falta: <strong className="text-white">{missingText}</strong>
                      </span>
                    ) : (
                      <span className="text-emerald-400 truncate block">✓ Vocações balanceadas</span>
                    )}
                    {surplusText && (
                      <span className="text-slate-500 truncate block text-[8px] font-medium" title={`Sobrando: ${surplusText}`}>
                        Sobrando: {surplusText}
                      </span>
                    )}
                  </div>

                  {srv.limitingVoc !== "Nenhuma" && srv.additionalIfSolved > 0 && (
                    <div className="flex-shrink-0 text-right bg-amber-500/10 border border-amber-500/20 rounded px-1.5 py-0.5 text-amber-300/90 text-[8px]">
                      +1 {srv.limitingVoc} → +{srv.additionalIfSolved} PT{srv.additionalIfSolved > 1 ? "s" : ""}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}