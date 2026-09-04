import type { CSSProperties } from "react";
import { BarChart3, Filter, Server, X } from "lucide-react";
import type { Character, PartyTab, Vocation, WaitingService } from "../types";
import { analyzeServerPotential } from "../utils/suggestionAlgorithm";
import { serverKey, serverLabel } from "../constants/servers";
import { getCharacterAccountKey } from "../utils/accountIdentity";
import { RECOMMENDABLE_VOCATIONS, VOCATION_ORDER, computeServerPriorityVocations } from "../utils/vocationPriority";
import { characterQuestEligible, serviceQuestEligible, collectBusyIdsForQuest } from "../utils/questEligibility";

export interface FriendsSummaryFilters {
  questFilter: "soulwar" | "sanguine" | "all";
  templateType: any;
  minLevels: Record<string, number>;
  userMode: "any" | "filter";
  selectedUsers: string[];
  useCharacters: boolean;
  useWaitingList: boolean;
}

interface FriendsSummaryModalProps {
  isOpen: boolean;
  onClose: () => void;
  characters: Character[];
  waitingList?: WaitingService[];
  activeParties?: PartyTab[];
  filters: FriendsSummaryFilters;
  /** Abre o modal de filtros POR CIMA deste, sem fechá-lo. */
  onOpenFilters?: () => void;
}

type VocationSummary = Record<Vocation, number>;

const VOCATION_LABELS: Record<Vocation, string> = {
  ED: "Elder Druid",
  MS: "Master Sorcerer",
  RP: "Royal Paladin",
  EK: "Elite Knight",
  MK: "Exalted Monk",
};

const VOCATION_BADGES: Record<Vocation, string> = {
  ED: "bg-emerald-500/10 border-emerald-500/30 text-emerald-300",
  MS: "bg-rose-500/10 border-rose-500/30 text-rose-300",
  RP: "bg-yellow-500/10 border-yellow-500/30 text-yellow-300",
  EK: "bg-slate-500/10 border-slate-400/30 text-slate-300",
  MK: "bg-purple-500/10 border-purple-500/30 text-purple-300",
};

/** Cor-base do pulso de prioridade — a própria cor da vocação.
 *  Injetada como `--voc-hue`; o keyframe deriva borda, anel e halo dela. */
const VOCATION_PULSE_HUE: Record<Vocation, string> = {
  ED: "var(--color-emerald-400)",
  MS: "var(--color-rose-400)",
  RP: "var(--color-yellow-400)",
  EK: "var(--color-slate-300)",
  MK: "var(--color-purple-400)",
};

export interface ServerSummary {
  server: string;
  total: number;
  counts: VocationSummary;
  differentVocations: number;
  balanced: boolean;
  /** Menor contagem entre TODAS as vocações do servidor (inclui MK). */
  minCount: number;
  /** Vocações ZERADAS no servidor (havendo outras disponíveis). */
  maxPriorityVocations: Vocation[];
  /**
   * As 2 vocações de MENOR quantidade que não são Prioridade Máxima.
   * Empate segue a ordem ED → EK → RP → MS → MK.
   */
  priorityVocations: Vocation[];
  possiblePTs: number;
}

/** Candidato já filtrado pelas regras do Resumo de Amigos. */
export interface FriendsSummaryCandidate {
  id: string;
  servidor: string;
  voc: Vocation;
  level: number;
  dono: string;
  account: string;
  /** Identidade real da conta (`ownerUid + nome`) — ver `accountIdentity`. */
  accountKey: string | null;
  type: "char" | "waiting";
  rawObj: any;
}

function emptyCounts(): VocationSummary {
  return { ED: 0, MS: 0, RP: 0, EK: 0, MK: 0 };
}

/**
 * Contagem por SERVIDOR + VOCAÇÃO aplicando exatamente os filtros do Resumo de
 * Amigos.
 *
 * Extraída de `buildServerSummaries` para virar fonte ÚNICA da filtragem: o
 * Resumo continua consumindo-a, e o Painel Bazaar a usa para o contador "xN"
 * da coluna VOC. Assim não existe uma segunda regra que possa divergir.
 *
 * Diferença importante em relação a `buildServerSummaries`: aqui NÃO há o
 * corte `total >= 3`. Aquele corte existe para não poluir o Resumo com
 * servidores irrelevantes, mas um servidor com 2 personagens continua tendo
 * 2 personagens — e o contador da coluna VOC precisa dizer a verdade.
 *
 * A chave do mapa é o rótulo canônico (`serverLabel`): "Grimoria I" e
 * "Grimoria II" nunca se misturam; nomenclaturas antigas do MESMO servidor
 * somam no lugar certo. Nenhuma comparação por `includes`/`startsWith`.
 */
export function buildVocationCountsByServer(
  characters: Character[],
  waitingList: WaitingService[] = [],
  activeParties: PartyTab[] = [],
  filters: FriendsSummaryFilters,
): { counts: Map<string, VocationSummary>; candidates: FriendsSummaryCandidate[] } {
  // Ocupação POR QUEST: quem está em PT de Sanguine segue contando como
  // disponível para Soul War (e vice-versa). Com Quest Alvo "all" (que exige
  // AMBAS as quests), qualquer PT ativa ocupa — o personagem já está
  // comprometido em uma delas.
  const busyIds = collectBusyIdsForQuest(activeParties, filters.questFilter);

  const candidates: FriendsSummaryCandidate[] = [];

  if (filters.useCharacters) {
    characters.forEach(character => {
      if (character.vendido || busyIds.has(character.id)) return;
      // Quest Alvo (fonte única em questEligibility.ts): "all" exige AMBAS
      // quests disponíveis.
      if (!characterQuestEligible(character, filters.questFilter)) return;
      if ((character.level || 0) < (filters.minLevels[character.voc] || 0)) return;
      const dono = character.ownerName || "";
      if (filters.userMode === "filter" && filters.selectedUsers.length > 0 && !filters.selectedUsers.includes(dono)) return;
      candidates.push({
        id: character.id,
        servidor: serverLabel(character.servidor),
        voc: character.voc,
        level: character.level || 0,
        dono,
        account: character.account || "",
        accountKey: getCharacterAccountKey(character),
        type: "char",
        rawObj: character,
      });
    });
  }

  if (filters.useWaitingList) {
    waitingList.forEach(service => {
      if (busyIds.has(service.id)) return;
      // Quest Alvo para services (fonte única): service é de uma quest só.
      if (!serviceQuestEligible(service, filters.questFilter)) return;
      if ((service.level || 0) < (filters.minLevels[service.voc] || 0)) return;
      const dono = service.ownerName || service.addedBy || service.createdByName || "";
      if (filters.userMode === "filter" && filters.selectedUsers.length > 0 && !filters.selectedUsers.includes(dono)) return;
      candidates.push({
        id: service.id,
        servidor: serverLabel(service.servidor),
        voc: service.voc,
        level: service.level || 0,
        dono,
        account: `service_${service.id}`,
        // Service não tem conta real: identidade única, nunca conflita.
        accountKey: `service:${service.id}`,
        type: "waiting",
        rawObj: service,
      });
    });
  }

  const grouped = new Map<string, VocationSummary>();

  // Agrupa pelo rótulo canônico: cada Grimoria permanece independente e
  // nomenclaturas antigas do MESMO servidor somam no lugar certo.
  candidates.forEach(candidate => {
    const server = serverLabel(candidate.servidor);
    const vocation = candidate.voc;
    if (!server || !VOCATION_ORDER.includes(vocation)) return;
    if (!grouped.has(server)) grouped.set(server, emptyCounts());
    grouped.get(server)![vocation] += 1;
  });

  return { counts: grouped, candidates };
}

export function buildServerSummaries(characters: Character[], waitingList: WaitingService[] = [], activeParties: PartyTab[] = [], filters: FriendsSummaryFilters): ServerSummary[] {
  // Mesma coleta/filtragem de `buildVocationCountsByServer` — fonte única.
  const { counts: grouped, candidates } = buildVocationCountsByServer(characters, waitingList, activeParties, filters);

  return Array.from(grouped.entries())
    .map(([server, counts]) => {
      const total = VOCATION_ORDER.reduce((sum, vocation) => sum + counts[vocation], 0);
      const differentVocations = VOCATION_ORDER.filter(vocation => counts[vocation] > 0).length;
      const nonMonkCounts = RECOMMENDABLE_VOCATIONS.map(vocation => counts[vocation]);
      const nonMonkMin = Math.min(...nonMonkCounts);
      const nonMonkMax = Math.max(...nonMonkCounts);
      const spread = nonMonkMax - nonMonkMin;
      const balanced = total >= 3 && nonMonkMin > 0 && spread === 0;
      // Menor quantidade CONSIDERANDO TODAS as vocações, inclusive Monk (MK).
      // Alimenta o destaque de escassez crítica no card.
      const minCount = Math.min(...VOCATION_ORDER.map(vocation => counts[vocation]));

      // ── PRIORIDADE POR SERVIDOR ──────────────────────────────────────────
      // Calculada isoladamente para cada servidor: nunca compara quantidades
      // entre servidores diferentes. Monk entra normalmente nos dois níveis.
      //
      // Prioridade Máxima: vocação ZERADA, desde que o servidor tenha algum
      // personagem em outra vocação (sem isso não há com o que comparar).
      //
      // Prioridade: SEMPRE destaca 2 vocações — as de menor quantidade entre
      // as que NÃO são Prioridade Máxima. Empate é resolvido pela ordem
      // ED → EK → RP → MS → MK.
      //
      // Os dois níveis CONVIVEM: um servidor pode ter Prioridades Máximas e,
      // ao mesmo tempo, 2 Prioridades comuns. Uma vocação zerada já está em
      // Prioridade Máxima e por isso nunca ocupa uma das 2 vagas comuns —
      // sem isso o mesmo card acumularia os dois destaques.
      //
      // Quando sobram menos de 2 elegíveis (ex.: 4 vocações zeradas), a
      // Prioridade destaca as que existirem: nunca inventamos uma vaga.
      const { max: maxPriorityVocations, normal: priorityVocations } = computeServerPriorityVocations(counts);
      const serverCandidates = candidates.filter(candidate => serverKey(candidate.servidor) === serverKey(server));
      const possiblePTs = analyzeServerPotential(serverCandidates, server, {
        questFilter: filters.questFilter,
        questType: filters.questFilter === "all" ? "soulwar" : filters.questFilter,
        minLevels: filters.minLevels,
        templateType: filters.templateType,
        userMode: filters.userMode,
        selectedUsers: filters.selectedUsers,
        maxOwnerRepeats: null,
        strength: "high",
        serverMode: "specific",
        specificServer: server,
      } as any).possiblePTs;

      return { server, total, counts, differentVocations, balanced, minCount, maxPriorityVocations, priorityVocations, possiblePTs };
    })
    .filter(summary => summary.total >= 3)
    // Ordem alfabética por servidor.
    .sort((a, b) => a.server.localeCompare(b.server, "pt-BR"));
}

export default function FriendsSummaryModal({ isOpen, onClose, characters, waitingList = [], activeParties = [], filters, onOpenFilters }: FriendsSummaryModalProps) {
  if (!isOpen) return null;

  const summaries = buildServerSummaries(characters, waitingList, activeParties, filters);

  return (
    <div className="app-modal-overlay fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="app-modal-frame app-modal-size-wide app-modal-frame--scroll w-full max-w-5xl rounded-2xl border border-[var(--th-line)]/80 bg-[var(--th-n-raised)] shadow-2xl shadow-black/60">
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-[var(--th-line)]/70 bg-[var(--th-bg-base)]">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl border border-amber-600/30 bg-amber-500/10 flex items-center justify-center">
              <BarChart3 size={18} className="text-amber-300" />
            </div>
            <div className="min-w-0">
              <h3 className="text-base font-black text-amber-200">Resumo de Amigos</h3>
              <p className="text-[11px] text-slate-500">Planejamento local por servidor usando a mesma lista de personagens disponíveis do OverviewPanel.</p>
            </div>
          </div>

          {/* Ações do cabeçalho: Filtros à esquerda do X (Fechar).
              Abre o modal de filtros POR CIMA deste, sem fechar o Resumo. */}
          <div className="flex items-center gap-2 flex-shrink-0">
            {onOpenFilters && (
              <button
                type="button"
                onClick={onOpenFilters}
                title="Ajustar os filtros do resumo"
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-gradient-to-r from-amber-600/90 to-amber-500/90 hover:from-amber-500 hover:to-amber-400 border border-amber-400/50 text-black text-xs font-black shadow-lg shadow-amber-950/40 transition-all cursor-pointer"
              >
                <Filter size={13} strokeWidth={2.5} /> Filtros
              </button>
            )}
            <button type="button" onClick={onClose} className="p-2 rounded-lg border border-white/10 bg-white/5 text-slate-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer">
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="app-modal-body custom-scrollbar p-4 sm:p-5">
          {summaries.length === 0 ? (
            <div className="rounded-xl border border-white/10 bg-white/5 px-5 py-8 text-center text-sm text-slate-400">
              Nenhum servidor com pelo menos 3 personagens compartilhados foi encontrado.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {summaries.map(summary => (
                <div key={summary.server} className="rounded-2xl border border-[var(--th-line)]/70 bg-black/25 p-4 space-y-4 shadow-lg shadow-black/20">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2 text-amber-200 font-black text-sm">
                        <Server size={14} className="text-amber-400" /> {summary.server}
                      </div>
                      <div className="text-[10px] text-slate-500 mt-1">
                        Total: <span className="font-mono text-slate-300">{summary.total}</span> • Vocações: <span className="font-mono text-slate-300">{summary.differentVocations}/5</span> • PT's possíveis: <span className="font-mono text-amber-300">{summary.possiblePTs}</span>
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-5 gap-1.5">
                    {VOCATION_ORDER.map(vocation => {
                      const count = summary.counts[vocation];
                      // Mesma regra de prioridade usada no Painel Bazaar —
                      // consome os campos já calculados, sem duplicar lógica.
                      // Prioridade Máxima (zerada) recebe a amplitude maior.
                      const isMaxPriority = summary.maxPriorityVocations.includes(vocation);
                      const isPriority = summary.priorityVocations.includes(vocation);
                      const pulseClass = isMaxPriority
                        ? "voc-pulse voc-pulse--max"
                        : isPriority ? "voc-pulse" : "";
                      const title = isMaxPriority
                        ? `${VOCATION_LABELS[vocation]} (${vocation}): nenhum personagem neste servidor — prioridade máxima`
                        : isPriority
                          ? `${VOCATION_LABELS[vocation]} (${vocation}): menor quantidade neste servidor — prioridade`
                          : `${VOCATION_LABELS[vocation]} (${vocation})`;
                      return (
                        <div
                          key={vocation}
                          title={title}
                          // `--voc-hue` faz o pulso herdar a cor da vocação.
                          style={pulseClass ? ({ "--voc-hue": VOCATION_PULSE_HUE[vocation] } as CSSProperties) : undefined}
                          className={`relative rounded-lg border px-2 py-2 text-center ${VOCATION_BADGES[vocation]} ${pulseClass}`}
                        >
                          {/* Selo de alerta nas zeradas: reforço redundante ao
                              brilho, para o aviso não depender só de cor. */}
                          {isMaxPriority && <span className="voc-alert" aria-hidden="true">!</span>}
                          <div className="text-[10px] font-black">{vocation}</div>
                          <div className="font-mono text-sm font-black mt-0.5 voc-pulse-count">{count}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="app-modal-footer flex flex-wrap items-center justify-end gap-2 px-4 sm:px-5 py-4 border-t border-[var(--th-line)]/70 bg-[var(--th-bg-base)]">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-xl bg-gradient-to-r from-amber-700/80 to-amber-600/80 hover:from-amber-600 hover:to-amber-500 border border-amber-500/40 text-black text-xs font-black transition-all cursor-pointer">
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
}