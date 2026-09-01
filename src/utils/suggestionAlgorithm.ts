import type { Character, PartyTab, Vocation, WaitingService } from "../types";
import { serverKey, serverLabel } from "../constants/servers";
import { getCharacterAccountKey } from "./accountIdentity";
import { characterQuestEligible, serviceQuestEligible, type QuestFilter } from "./questEligibility";

/**
 * Tipos de composição oferecidos.
 *
 * As classificações antigas ("boa", "aceitavel_1..4") foram REMOVIDAS: agora
 * existem apenas PT Ideal e PT Muito Boa. Os identificadores legados seguem
 * declarados como `PartyTemplateTypeLegacy` só para que preferências já
 * salvas no localStorage sejam reconhecidas e migradas, nunca para gerar
 * sugestão nova.
 */
export type PartyTemplateType = "inteligente" | "ideal" | "muito_boa" | "custom";

/** Identificadores que existiram em versões anteriores. Não gerar sugestões. */
export type PartyTemplateTypeLegacy = "boa" | "aceitavel_1" | "aceitavel_2" | "aceitavel_3" | "aceitavel_4";

/**
 * Normaliza um `templateType` possivelmente legado.
 *
 * Quem tinha "PT Boa" ou qualquer "Aceitável" salvo cai em "muito_boa", que é
 * a categoria que absorveu essas composições. Assim ninguém fica com uma
 * preferência inválida depois da atualização.
 */
export function normalizeTemplateType(value: string | undefined | null): PartyTemplateType {
  if (value === "inteligente" || value === "ideal" || value === "muito_boa" || value === "custom") return value;
  if (value === "boa" || (typeof value === "string" && value.startsWith("aceitavel"))) return "muito_boa";
  return "inteligente";
}

export interface CustomComposition {
  EK: number;
  ED: number;
  MS: number;
  RP: number;
  MK: number;
}

export interface SuggestionOptions {
  questType: "soulwar" | "sanguine";
  userMode: "any" | "filter";
  selectedUsers: string[]; // list of owner names when userMode === "filter"
  /**
   * Empréstimo — quantas REPETIÇÕES DE DONO a PT pode ter.
   *
   * Repetição de dono = quantos personagens a mais do que um o mesmo usuário
   * coloca na PT. Formalmente, numa PT de 5:
   *
   *     repetições = 5 − (quantidade de donos distintos)
   *
   *   • 0            → no máximo 1 personagem por usuário (antigo "Não emprestar");
   *   • 1            → um único usuário pode ter 2 personagens;
   *   • 2            → ex.: A=2, B=2, C=1 (5 − 3 donos = 2 repetições);
   *   • null/undefined → sem limite (compatibilidade com quem não informa).
   *
   * NÃO é um teto por usuário: um único dono com 3 personagens também consome
   * 2 repetições, exatamente como dois donos com 2 personagens cada.
   *
   * A unicidade de CONTA é independente disto e vale sempre.
   */
  maxOwnerRepeats?: number | null;
  /**
   * "Não emprestar Service": impede que um Service ocupe uma participação
   * considerada empréstimo do usuário. Não exclui Services da sugestão.
   */
  noServiceLoan?: boolean;
  strength: "low" | "medium" | "high"; // baixo, médio, alto
  serverMode: "auto" | "specific";
  specificServer: string;
  minLevels?: Record<string, number>; // nível mínimo por vocation (ex: { EK: 500, ED: 400, MS: 400, RP: 500, MK: 600 })
  templateType?: PartyTemplateType; // Tipo de PT desejado (padrão: ideal)
  customComposition?: CustomComposition; // Composição personalizada (quando templateType === "custom")
  sharedXP?: boolean; // Shared XP: diferença de level entre o mais alto e o mais baixo não pode ser > 33%
  useCharacters?: boolean; // Usar personagens da lista de personagens disponíveis
  useWaitingList?: boolean; // Usar personagens da lista de espera (services)
  skipTemplateNames?: string[]; // uso interno: permite navegar por composições já sugeridas no modo Auto
}

export interface PartyCandidate {
  id: string;
  servidor: string;
  voc: Vocation;
  level: number;
  dono: string;
  /** Nome da conta (apenas exibição/diagnóstico). NÃO usar para comparar. */
  account: string;
  /**
   * Identidade REAL da conta: `ownerUid + nome`. É o que distingue a conta "1"
   * do Usuário A da conta "1" do Usuário B. `null` = indeterminada (sem conta
   * ou sem dono conhecido), e nesse caso nunca há conflito.
   */
  accountKey: string | null;
  type: "char" | "waiting";
  rawObj: Character | WaitingService;
}

export interface SuggestedPartyResult {
  success: boolean;
  templateName: string;
  server: string;
  candidates: PartyCandidate[];
  avgLevel: number;
  strength: "low" | "medium" | "high";
  errorMessage?: string;
  // Dados auxiliares para substituição no modal
  candidatesByVocAndServer?: Record<string, PartyCandidate[]>;
  carriers?: number[]; // índices dos candidatos que são "carregadores"
  carrierLevel?: number; // level mínimo considerado para carregador
  futurePTsAfterSuggestion?: number;
  templateQuality?: number;
  teamScore?: number;
  serverCandidatesCount?: number;
}

export interface SwapCandidates {
  slotIndex: number;
  stronger: PartyCandidate | null;
  weaker: PartyCandidate | null;
}

export interface StrengthTargets {
  low: number;
  medium: number;
  high: number;
  baseAverage: number;
  server: string;
  candidatesCount: number;
}

// Configurações de sintonia para a Força da PT futuramente
export const TARGET_STRENGTH_AVG_LEVEL = {
  low: 400,
  medium: 750,
  high: 1500, // ou simplesmente o maior level possível
};

// ============================================================================
// GABARITOS DE PT
// ============================================================================
// Regras obrigatórias de TODA composição:
//   • exatamente 1 EK;
//   • no mínimo 1 ED;
//   • no mínimo 1 RP;
//   • no máximo 1 MK;
//   • 5 personagens no total.
//
// Só existem DUAS categorias: "PT Ideal" (uma única composição) e
// "PT Muito Boa" (as oito demais). As antigas "PT Boa" e "PT Aceitável"
// deixaram de existir.
//
// Entre as PTs Muito Boas NÃO há ordem fixa de preferência: a escolha é feita
// em tempo de execução pela escassez de vocações daquele servidor
// (ver `rankTemplatesByScarcity`).
// ============================================================================

export interface PartyTemplate {
  name: string;
  counts: Record<Vocation, number>;
}

/** Nome exato da composição ideal. Usado para classificar a qualidade. */
export const IDEAL_TEMPLATE_NAME = "PT Ideal (1 EK, 1 MK, 1 ED, 1 RP, 1 MS)";

/**
 * A ÚNICA composição ideal: uma de cada vocação.
 *
 * Fica sempre na primeira posição de `PARTY_TEMPLATES` — vários pontos do
 * código usam `PARTY_TEMPLATES[0]` como referência do gabarito ideal.
 */
export const PARTY_TEMPLATES: PartyTemplate[] = [
  // ── PT IDEAL ──────────────────────────────────────────────────────────────
  { name: IDEAL_TEMPLATE_NAME, counts: { EK: 1, ED: 1, MS: 1, RP: 1, MK: 1 } },

  // ── PT MUITO BOA (8 composições, sem ordem de preferência entre si) ───────
  { name: "PT Muito Boa (1 EK, 1 ED, 2 RP, 1 MS)", counts: { EK: 1, ED: 1, MS: 1, RP: 2, MK: 0 } },
  { name: "PT Muito Boa (1 EK, 1 ED, 1 RP, 2 MS)", counts: { EK: 1, ED: 1, MS: 2, RP: 1, MK: 0 } },
  { name: "PT Muito Boa (1 EK, 2 ED, 1 RP, 1 MS)", counts: { EK: 1, ED: 2, MS: 1, RP: 1, MK: 0 } },
  { name: "PT Muito Boa (1 EK, 2 ED, 2 RP)", counts: { EK: 1, ED: 2, MS: 0, RP: 2, MK: 0 } },
  { name: "PT Muito Boa (1 EK, 1 ED, 3 RP)", counts: { EK: 1, ED: 1, MS: 0, RP: 3, MK: 0 } },
  { name: "PT Muito Boa (1 EK, 3 ED, 1 RP)", counts: { EK: 1, ED: 3, MS: 0, RP: 1, MK: 0 } },
  { name: "PT Muito Boa (1 EK, 1 MK, 1 ED, 2 RP)", counts: { EK: 1, ED: 1, MS: 0, RP: 2, MK: 1 } },
  { name: "PT Muito Boa (1 EK, 1 MK, 2 ED, 1 RP)", counts: { EK: 1, ED: 2, MS: 0, RP: 1, MK: 1 } },
];

/**
 * Verificação das regras obrigatórias.
 *
 * Existe como rede de segurança: qualquer composição criada fora da lista
 * acima — em especial a "Composição Personalizada" montada pelo usuário —
 * passa por aqui antes de virar sugestão.
 */
export function isValidPartyComposition(counts: Record<Vocation, number>): boolean {
  const total = counts.EK + counts.ED + counts.MS + counts.RP + counts.MK;
  if (total !== 5) return false;
  if (counts.EK !== 1) return false;   // exatamente 1 EK
  if (counts.ED < 1) return false;     // pelo menos 1 ED
  if (counts.RP < 1) return false;     // pelo menos 1 RP
  if (counts.MK > 1) return false;     // no máximo 1 MK
  if (counts.EK < 0 || counts.ED < 0 || counts.MS < 0 || counts.RP < 0 || counts.MK < 0) return false;
  return true;
}

export interface ServerAnalysis {
  serverName: string;
  totalChars: number;
  eligibleChars: number;
  counts: Record<Vocation, number>;
  percentages: Record<Vocation, number>;
  possiblePTs: number;
  bestComposition: string;
  missingVocs: Array<{ voc: Vocation; count: number }>;
  surplusVocs: Array<{ voc: Vocation; count: number }>;
  limitingVoc: Vocation | "Nenhuma";
  additionalIfSolved: number;
  status: "ideal" | "boa" | "falta1" | "falta2" | "nada";
}

/**
 * Analisa profundamente o potencial de um servidor para formar PTs.
 * Esta função expande a lógica de sugestão para fins estatísticos na Visão Geral.
 */
export function analyzeServerPotential(
  candidates: PartyCandidate[],
  serverName: string,
  options: SuggestionOptions & { questFilter?: "soulwar" | "sanguine" | "all" }
): ServerAnalysis {
  // Filtrar candidatos pelo servidor e pelas regras configuradas de filtros
  // Comparação pelo nome COMPLETO e canônico: "Grimoria I" nunca casa com
  // "Grimoria II", e "Grimoria 1"/"grimoria i" casam com "Grimoria I".
  const targetKey = serverKey(serverName);
  const srvCandidates = candidates.filter(c => serverKey(c.servidor) === targetKey);

  const eligible = srvCandidates.filter(c => {
    const minLv = options.minLevels?.[c.voc];
    if (minLv !== undefined && (c.level || 0) < minLv) return false;

    // Quest Alvo (fonte única em questEligibility.ts). "all" exige AMBAS
    // quests disponíveis para personagens; services são de uma quest só.
    const questFilter = (options.questFilter || "all") as QuestFilter;
    const eligibleForQuest = c.type === "char"
      ? characterQuestEligible(c.rawObj as Character, questFilter)
      : serviceQuestEligible(c.rawObj as WaitingService, questFilter);
    if (!eligibleForQuest) return false;

    if (options.userMode === "filter" && options.selectedUsers?.length > 0) {
      const dono = (c.dono || "").toLowerCase();
      const match = options.selectedUsers.some(u => u.toLowerCase() === dono);
      if (!match) return false;
    }
    return true;
  });

  const total = srvCandidates.length;
  const eligibleCount = eligible.length;
  
  const counts: Record<Vocation, number> = { EK: 0, ED: 0, MS: 0, RP: 0, MK: 0 };
  eligible.forEach(c => { if (c.voc && counts[c.voc] !== undefined) counts[c.voc]++; });

  const percentages: Record<Vocation, number> = { EK: 0, ED: 0, MS: 0, RP: 0, MK: 0 };
  if (eligibleCount > 0) {
    (Object.keys(counts) as Vocation[]).forEach(v => {
      percentages[v] = Math.round((counts[v] / eligibleCount) * 100);
    });
  }

  // 1. Calcular PTs possíveis considerando todos os templates oficiais válidos.
  const possiblePTs = computeMaxPossibleParties(counts);
  
  // 2. Determinar melhor composição disponível (através dos templates)
  let bestComp = "Nenhuma";
  let status: ServerAnalysis["status"] = "nada";

  const requestedType = normalizeTemplateType(options.templateType);
  const templatesToTry = requestedType === "inteligente" ? PARTY_TEMPLATES : PARTY_TEMPLATES.filter(t => {
    if (requestedType === "ideal") return t.name === IDEAL_TEMPLATE_NAME;
    if (requestedType === "muito_boa") return t.name !== IDEAL_TEMPLATE_NAME;
    return true;
  });

  for (const template of (templatesToTry.length > 0 ? templatesToTry : PARTY_TEMPLATES)) {
    let canForm = true;
    for (const [v, req] of Object.entries(template.counts)) {
      if (counts[v as Vocation] < req) {
        canForm = false;
        break;
      }
    }
    if (canForm) {
      bestComp = template.name.split('(')[0].trim();
      status = template.name.includes("Ideal") ? "ideal" : "boa";
      break;
    }
  }

  // 3. Diagnóstico de faltas e excessos
  const missingVocs: ServerAnalysis["missingVocs"] = [];
  const surplusVocs: ServerAnalysis["surplusVocs"] = [];
  const idealReq = PARTY_TEMPLATES[0].counts;
  
  (Object.keys(idealReq) as Vocation[]).forEach(v => {
    const req = idealReq[v];
    if (req > 0) {
      if (counts[v] < req) {
        missingVocs.push({ voc: v, count: req - counts[v] });
      } else {
        const surplus = counts[v] - (possiblePTs * req);
        if (surplus > 0) {
          surplusVocs.push({ voc: v, count: surplus });
        }
      }
    }
  });

  if (status === "nada") {
    if (missingVocs.length === 1) status = "falta1";
    else if (missingVocs.length === 2) status = "falta2";
  }

  // 4. Vocação Limitante & estimativa de PTs adicionais
  let limitingVoc: Vocation | "Nenhuma" = "Nenhuma";
  let additionalIfSolved = 0;

  if (eligibleCount > 0) {
    const capacities = [
      { v: "EK" as Vocation, cap: counts.EK, req: 1 },
      { v: "ED" as Vocation, cap: counts.ED, req: 1 },
      { v: "MS" as Vocation, cap: counts.MS, req: 1 },
      { v: "RP" as Vocation, cap: Math.floor(counts.RP / 2), req: 2 }
    ];
    capacities.sort((a, b) => a.cap - b.cap);
    limitingVoc = capacities[0].v;

    // Se resolver a vocação limitante (subindo para a segunda menor capacidade)
    const secondCap = capacities[1]?.cap || 0;
    if (secondCap > capacities[0].cap) {
      additionalIfSolved = secondCap - capacities[0].cap;
    } else if (capacities[0].cap === 0 && (capacities[1]?.cap || 0) > 0) {
      additionalIfSolved = capacities[1].cap;
    }
  }

  return {
    serverName,
    totalChars: total,
    eligibleChars: eligibleCount,
    counts,
    percentages,
    possiblePTs,
    bestComposition: bestComp,
    missingVocs,
    surplusVocs,
    limitingVoc,
    additionalIfSolved,
    status
  };
}

function roundToNearestFive(n: number): number {
  return Math.max(1, Math.round(n / 5) * 5);
}

function deriveStrengthTargets(baseAverage: number): StrengthTargets {
  const safeAverage = Math.max(1, Math.round(baseAverage || 0));
  return {
    low: roundToNearestFive(safeAverage * 0.8),
    medium: roundToNearestFive(safeAverage),
    high: roundToNearestFive(safeAverage * 1.285),
    baseAverage: safeAverage,
    server: "",
    candidatesCount: 0,
  };
}

function resolveOwnerName(ownerName: string | undefined, addedBy: string | undefined, defaultUserName: string): string {
  const clean = (ownerName || addedBy || defaultUserName).trim();
  return clean || "Anônimo";
}

/** Rótulo da opção "sem Serviceiro designado" (espelha useEligibleServiceiros). */
const ANY_SERVICEIRO_LABEL = "Qualquer um";

/**
 * Usuário RESPONSÁVEL por um Service — o que aparece em "Participantes".
 *
 * ── A CAUSA DO BUG ────────────────────────────────────────────────────────
 * Antes usávamos `resolveOwnerName(w.ownerName, w.addedBy, ...)`, que dá
 * precedência a `ownerName`. Só que num Service `ownerName` é o **CLIENTE**
 * (o dono do personagem, exibido na coluna "Cliente" da Lista de Espera) —
 * uma pessoa de fora, que NÃO é usuária do aplicativo.
 *
 * "Participantes" lista usuários do app. Como o filtro comparava o nome do
 * cliente contra essa lista, praticamente nenhum Service casava, e todos eram
 * descartados. Era por isso que os Services não entravam na sugestão.
 *
 * O responsável é `addedBy`, o Serviceiro designado — mesmo campo que
 * `serviceVisibility.ts` já usa para decidir quem enxerga e quem pode levar o
 * Service para a PT.
 *
 * "Qualquer um" (ou vazio) significa que nenhum Serviceiro foi designado: o
 * Service é livre. Nesse caso devolvemos "" e o chamador o trata como
 * disponível para qualquer participante selecionado, em vez de exigir um
 * casamento de nome que não existe.
 */
export function resolveServiceResponsible(addedBy: string | undefined): string {
  const assigned = (addedBy || "").trim();
  if (!assigned) return "";
  if (assigned.toLowerCase() === ANY_SERVICEIRO_LABEL.toLowerCase()) return "";
  return assigned;
}

function collectEligibleCandidates(
  characters: Character[],
  waitingList: WaitingService[],
  allParties: PartyTab[],
  currentPartyId: string,
  defaultUserName: string,
  options: SuggestionOptions
): PartyCandidate[] {
  // 1. Determinar UIDs/IDs ocupados em outras PTs ativas
  const busyIds = new Set<string>();
  allParties.forEach(p => {
    if (p.id === currentPartyId || p.archived) return;
    (p.selectedIds || []).forEach(id => busyIds.add(id));
  });

  // 2. Extrair e normalizar a base de candidatos elegíveis
  const candidates: PartyCandidate[] = [];

  // 2a. Characters (apenas se useCharacters estiver ativo ou não especificado)
  if (options.useCharacters !== false) {
    characters.forEach(c => {
      if (c.vendido) return; // não sugerir vendidos
      if (c.shared === false) return; // respeitar compartilhamento
      if (busyIds.has(c.id)) return; // já ocupado em outra PT

      // Filtrar pela Quest da PT
      if (options.questType === "soulwar" && !c.soulwar) return;
      if (options.questType === "sanguine" && !c.sanguine) return;

      // Filtrar por nível mínimo da vocação
      if (options.minLevels) {
        const minLv = options.minLevels[c.voc];
        if (minLv !== undefined && (c.level || 0) < minLv) return;
      }

      const dono = resolveOwnerName(c.ownerName, undefined, defaultUserName);

      // Filtrar por usuário (se userMode === "filter")
      if (options.userMode === "filter") {
        const match = options.selectedUsers.some(
          u => u.toLowerCase() === dono.toLowerCase()
        );
        if (!match) return;
      }

      candidates.push({
        id: c.id,
        servidor: serverLabel(c.servidor) || "Desconhecido",
        voc: c.voc || "EK",
        level: c.level || 0,
        dono,
        account: (c.account || "").trim(),
        accountKey: getCharacterAccountKey(c),
        type: "char",
        rawObj: c,
      });
    });
  }

  // 2b. Waiting List (Services) - apenas se useWaitingList estiver ativo
  if (options.useWaitingList !== false) {
    waitingList.forEach(w => {
      if (busyIds.has(w.id)) return;
      if (w.quest !== options.questType) return;

      // Filtrar por nível mínimo da vocação
      if (options.minLevels) {
        const minLv = options.minLevels[w.voc];
        if (minLv !== undefined && (w.level || 0) < minLv) return;
      }

      // ── VÍNCULO DO SERVICE COM O USUÁRIO RESPONSÁVEL ────────────────────
      // O responsável é o SERVICEIRO (`addedBy`), não o cliente (`ownerName`).
      // Ver `resolveServiceResponsible` para o motivo — era exatamente aqui
      // que os Services ficavam de fora da sugestão.
      const responsavel = resolveServiceResponsible(w.addedBy);
      // `dono` continua sendo o nome exibido/agrupado. Com Serviceiro
      // designado é ele; sem designação, cai no comportamento anterior para
      // não perder a informação do cliente na exibição.
      const dono = responsavel || resolveOwnerName(w.ownerName, w.addedBy, defaultUserName);

      if (options.userMode === "filter") {
        // Service SEM Serviceiro designado ("Qualquer um") é livre: qualquer
        // participante selecionado pode usá-lo, então ele não é descartado
        // por não casar com nenhum nome da lista.
        if (responsavel) {
          const match = options.selectedUsers.some(
            u => u.toLowerCase() === responsavel.toLowerCase()
          );
          if (!match) return;
        }
      }

      candidates.push({
        id: w.id,
        servidor: serverLabel(w.servidor) || "Desconhecido",
        voc: w.voc || "EK",
        level: w.level || 0,
        dono,
        account: `service_${w.id}`, // services não possuem account, damos um ID virtual
        // Service não tem conta real: identidade única por Service, o que
        // preserva o comportamento atual (nunca conflita com ninguém).
        accountKey: `service:${w.id}`,
        type: "waiting",
        rawObj: w,
      });
    });
  }

  return candidates;
}

function groupCandidatesByServer(candidates: PartyCandidate[]): Record<string, PartyCandidate[]> {
  // Agrupa pela chave canônica para que nomenclaturas antigas caiam no mesmo
  // balde, mas indexa pelo rótulo oficial exibido na UI.
  const byServer: Record<string, PartyCandidate[]> = {};
  const labelByKey = new Map<string, string>();
  candidates.forEach(c => {
    const key = serverKey(c.servidor);
    if (!key) return;
    let label = labelByKey.get(key);
    if (!label) {
      label = serverLabel(c.servidor) || c.servidor;
      labelByKey.set(key, label);
    }
    if (!byServer[label]) byServer[label] = [];
    byServer[label].push(c);
  });
  return byServer;
}

function groupCandidatesByVocAndServer(candidates: PartyCandidate[]): Record<string, PartyCandidate[]> {
  const grouped: Record<string, PartyCandidate[]> = {};
  candidates.forEach(c => {
    const key = `${c.servidor}|${c.voc}`;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(c);
  });
  // ── ORDEM DE PREFERÊNCIA DENTRO DE CADA GRUPO ─────────────────────────────
  // 1º) SERVICES antes de personagens pessoais.
  //     É uma PREFERÊNCIA de desempate, não uma obrigação: a ordem só decide
  //     quem é tentado primeiro. Se o Service não couber (conta, empréstimo,
  //     composição), o laço segue para o próximo candidato normalmente — logo
  //     a prioridade nunca produz uma PT pior ou inválida.
  // 2º) Level decrescente, exatamente como antes. Isso preserva os botões de
  //     troca de vocação, que continuam listando as alternativas do mais alto
  //     para o mais baixo dentro de cada origem.
  Object.keys(grouped).forEach(key => {
    grouped[key].sort((a, b) => {
      const aService = a.type === "waiting" ? 0 : 1;
      const bService = b.type === "waiting" ? 0 : 1;
      if (aService !== bService) return aService - bService;
      return b.level - a.level;
    });
  });
  return grouped;
}

function getServerQueue(byServer: Record<string, PartyCandidate[]>, options: SuggestionOptions): string[] {
  if (options.serverMode === "specific") {
    // Resolve pelo nome canônico para aceitar nomenclaturas antigas.
    const targetKey = serverKey(options.specificServer);
    const match = Object.keys(byServer).find(srv => serverKey(srv) === targetKey);
    return match ? [match] : [];
  }
  return Object.keys(byServer).sort((a, b) => byServer[b].length - byServer[a].length);
}

function getAverageLevel(candidates: PartyCandidate[]): number {
  if (candidates.length === 0) return 0;
  return candidates.reduce((sum, c) => sum + c.level, 0) / candidates.length;
}

/**
 * Calcula os índices dos carregadores da PT.
 * Carregador = personagem com o level mais alto da PT, MAS só é marcado se
 * o level dele for > 30% acima da média dos outros membros (excluindo ele mesmo).
 */
// ============================================================================
// EXIBIÇÃO DA PT: 3 POSIÇÕES FIXAS + 2 FLEXÍVEIS
// ============================================================================
//
// Toda composição válida tem, por construção, exatamente 1 EK, pelo menos 1 ED
// e pelo menos 1 RP (ver `isValidPartyComposition`). Logo é SEMPRE possível
// reservar as três primeiras linhas para EK, ED e RP — sem inventar nada e sem
// remover ninguém: apenas reordenando o time já montado pelo algoritmo.
//
// As duas últimas linhas ficam com o excedente (o "resto" da composição) e são
// as únicas que podem trocar de vocação.

/** Ordem estável em que as alternativas de vocação são exibidas. */
export const VOCATION_DISPLAY_ORDER: Vocation[] = ["EK", "ED", "MS", "RP", "MK"];

/** Vocações reservadas às 3 primeiras linhas, nesta ordem. */
export const FIXED_SLOT_VOCATIONS: Vocation[] = ["EK", "ED", "RP"];

/** Quantidade de linhas fixas no topo da tabela. */
export const FIXED_SLOT_COUNT = FIXED_SLOT_VOCATIONS.length;

/** Contagem de vocações de um time. */
export function countTeamVocations(team: PartyCandidate[]): Record<Vocation, number> {
  const counts: Record<Vocation, number> = { EK: 0, ED: 0, MS: 0, RP: 0, MK: 0 };
  team.forEach(member => { if (counts[member.voc] !== undefined) counts[member.voc]++; });
  return counts;
}

/**
 * Reordena o time para exibição: EK, ED e RP nas posições 1, 2 e 3; o restante
 * mantém a ordem original nas posições 4 e 5.
 *
 * Não altera a composição — é uma permutação. Se por algum motivo faltar uma
 * das vocações obrigatórias (composição personalizada inválida vinda de dados
 * antigos), a função devolve o time intacto em vez de embaralhar.
 */
export function orderTeamForDisplay(team: PartyCandidate[]): PartyCandidate[] {
  const remaining = [...team];
  const fixed: PartyCandidate[] = [];

  for (const voc of FIXED_SLOT_VOCATIONS) {
    const index = remaining.findIndex(member => member.voc === voc);
    if (index === -1) return [...team]; // sem a vocação obrigatória: não reordena
    fixed.push(remaining[index]);
    remaining.splice(index, 1);
  }

  return [...fixed, ...remaining];
}

/** A posição aceita troca de vocação? Apenas as duas últimas (índices 3 e 4). */
export function isFlexibleSlot(slotIndex: number, teamSize: number): boolean {
  return slotIndex >= FIXED_SLOT_COUNT && slotIndex < teamSize;
}

/**
 * Melhor personagem disponível de uma vocação para ocupar um slot.
 *
 * Usa os MESMOS critérios do algoritmo: o pool `grouped` já vem ordenado por
 * level decrescente (`groupCandidatesByVocAndServer`), então o primeiro que
 * respeitar todas as regras é o melhor. Regras aplicadas:
 *   • mesmo servidor e vocação pedida;
 *   • ninguém que já esteja no time;
 *   • nunca duas contas iguais;
 *   • limite de repetições de dono (empréstimo).
 *
 * O candidato é avaliado contra o time SEM o ocupante atual do slot.
 */
export function findBestCandidateForVocation(
  grouped: Record<string, PartyCandidate[]>,
  servidor: string,
  voc: Vocation,
  team: PartyCandidate[],
  slotIndex: number,
  maxOwnerRepeats: number | null,
  noServiceLoan?: boolean
): PartyCandidate | null {
  const pool = grouped[`${servidor}|${voc}`];
  if (!pool || pool.length === 0) return null;

  const rest = team.filter((_, index) => index !== slotIndex);
  const restIds = new Set(rest.map(member => member.id));
  const limit = normalizeMaxOwnerRepeats(maxOwnerRepeats);

  for (const cand of pool) {
    if (restIds.has(cand.id)) continue;
    if (hasAccountConflict(rest, cand)) continue;
    if (!canAddWithinOwnerRepeats(rest, cand, limit)) continue;
    if (isBlockedServiceLoan(rest, cand, noServiceLoan)) continue;
    return cand;
  }
  return null;
}

/** Alternativa de vocação oferecida para um slot flexível. */
export interface VocationAlternative {
  voc: Vocation;
  candidate: PartyCandidate;
}

/**
 * Vocações alternativas realmente possíveis para um slot flexível.
 *
 * Uma alternativa só é oferecida quando as DUAS condições valem:
 *   1. a composição resultante continua válida — exatamente 1 EK, ≥1 ED,
 *      ≥1 RP, ≤1 MK, total 5 (`isValidPartyComposition`, que corresponde
 *      exatamente ao conjunto de gabaritos do algoritmo);
 *   2. existe um personagem elegível daquela vocação, respeitando servidor,
 *      conta e limite de empréstimo (os filtros de level/Quest/usuário já
 *      foram aplicados na montagem de `grouped`).
 *
 * A vocação atual do slot nunca aparece como alternativa.
 */
export function computeVocationAlternatives(
  team: PartyCandidate[],
  slotIndex: number,
  grouped: Record<string, PartyCandidate[]> | undefined,
  maxOwnerRepeats: number | null,
  noServiceLoan?: boolean
): VocationAlternative[] {
  if (!grouped) return [];
  if (!isFlexibleSlot(slotIndex, team.length)) return [];

  const current = team[slotIndex];
  if (!current) return [];

  const baseCounts = countTeamVocations(team);
  const alternatives: VocationAlternative[] = [];

  for (const voc of VOCATION_DISPLAY_ORDER) {
    if (voc === current.voc) continue;

    // 1. A composição resultante precisa continuar válida.
    const counts: Record<Vocation, number> = { ...baseCounts };
    counts[current.voc] -= 1;
    counts[voc] += 1;
    if (!isValidPartyComposition(counts)) continue;

    // 2. Precisa existir um personagem elegível dessa vocação.
    const candidate = findBestCandidateForVocation(
      grouped, current.servidor, voc, team, slotIndex, maxOwnerRepeats, noServiceLoan
    );
    if (!candidate) continue;

    alternatives.push({ voc, candidate });
  }

  return alternatives;
}

export function computeCarrierIndices(team: PartyCandidate[]): number[] {
  if (team.length === 0) return [];
  const maxLevel = Math.max(...team.map(c => c.level));
  // Calcular a média dos membros excluindo os de level máximo
  const others = team.filter(c => c.level < maxLevel);
  if (others.length === 0) return []; // todos têm o mesmo level, nenhum carregador
  const avgOthers = others.reduce((s, c) => s + c.level, 0) / others.length;
  const threshold = avgOthers * 1.3; // 30% acima da média dos outros
  if (maxLevel < threshold) return []; // o mais alto não é 30% acima → sem carregador
  // Marcar todos que têm o level máximo como carregadores
  const carriers: number[] = [];
  team.forEach((c, i) => { if (c.level === maxLevel) carriers.push(i); });
  return carriers;
}

export function getSuggestionStrengthTargets(
  characters: Character[],
  waitingList: WaitingService[],
  allParties: PartyTab[],
  currentPartyId: string,
  defaultUserName: string,
  options: SuggestionOptions
): StrengthTargets {
  const candidates = collectEligibleCandidates(
    characters,
    waitingList,
    allParties,
    currentPartyId,
    defaultUserName,
    options
  );

  const byServer = groupCandidatesByServer(candidates);
  const serverQueue = getServerQueue(byServer, options);
  const selectedServer = serverQueue[0] || (options.serverMode === "specific" ? options.specificServer : "Auto");
  const serverCandidates = serverQueue[0] ? byServer[serverQueue[0]] : [];
  const baseAverage = serverCandidates.length > 0
    ? getAverageLevel(serverCandidates)
    : TARGET_STRENGTH_AVG_LEVEL.medium;

  const derived = deriveStrengthTargets(baseAverage);
  return {
    ...derived,
    server: selectedServer,
    candidatesCount: serverCandidates.length,
  };
}

// ============================================================================
// EMPRÉSTIMO — LIMITE DE REPETIÇÕES DE DONO
// ============================================================================
//
// "Repetição de dono" é o excedente de personagens de um mesmo usuário dentro
// da PT. Para um time qualquer:
//
//     repetições = (nº de personagens) − (nº de donos distintos)
//
// Exemplos numa PT de 5:
//     A,B,C,D,E      → 5 − 5 = 0 repetições  (equivale a "Não emprestar")
//     A,A,B,C,D      → 5 − 4 = 1 repetição
//     A,A,B,B,C      → 5 − 3 = 2 repetições
//     A,A,A,B,C      → 5 − 3 = 2 repetições  (o mesmo custo do caso acima)
//
// O último exemplo é justamente o motivo de a regra NÃO ser um teto por
// usuário: o que se limita é o total de repetições da PT.
//
// A unicidade de CONTA é uma regra separada e inviolável — duas contas iguais
// nunca entram na mesma PT, qualquer que seja o limite de empréstimo.

/** Chave de dono normalizada (case-insensitive, sem espaços nas pontas). */
export function ownerKey(dono: string | undefined | null): string {
  return String(dono || "").trim().toLowerCase();
}

/**
 * Normaliza o limite vindo da interface/persistência.
 * `null`/`undefined` significam "sem limite"; qualquer número vira inteiro ≥ 0.
 */
export function normalizeMaxOwnerRepeats(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.floor(value));
}

/**
 * PERSONAGENS EMPRESTADOS num conjunto — limite GLOBAL da PT.
 *
 * Implementa literalmente a definição:
 *
 *     emprestados = Σ max(0, personagensDoUsuario − 1)
 *
 * O primeiro personagem de cada usuário é "dele"; todo personagem ADICIONAL
 * do mesmo usuário conta como um empréstimo. O teto vale para a PT INTEIRA e
 * os empréstimos podem estar distribuídos entre usuários diferentes:
 *
 *     A,B,C,D,E  → 0    A,A,B,C,D  → 1
 *     A,A,B,B,C  → 2    A,A,A,B,C  → 2     (dois caminhos para o mesmo total)
 *     A,A,B,B,C,C→ 3    A,A,A,A,B  → 3
 *
 * NÃO é "um único usuário pode levar N personagens", NÃO existe dono
 * responsável pelos empréstimos e os extras NÃO precisam ser do mesmo usuário.
 */
export function countLoanedCharacters(team: { dono: string; type?: PartyCandidate["type"] }[]): number {
  const byOwner = new Map<string, number>();
  for (const member of team) {
    // ── A ORIGEM NÃO ALTERA A REGRA DE EMPRÉSTIMO ───────────────────────
    // Services e personagens pessoais contam JUNTOS, pelo mesmo usuário
    // responsável. Com "Emprestar no máximo: 1", o usuário A pode levar 2
    // personagens em qualquer combinação:
    //
    //   1 pessoal + 1 Service  ·  2 Services  ·  2 pessoais
    //
    // Todas equivalem a "1 principal + 1 extra" = 1 empréstimo. Levar 3
    // personagens de A seriam 2 empréstimos e estoura o limite 1.
    //
    // Uma versão anterior isentava Services da contagem; isso permitia uma PT
    // inteira de um só responsável com o limite em 0, contrariando a regra.
    const key = ownerKey(member.dono);
    byOwner.set(key, (byOwner.get(key) || 0) + 1);
  }
  let loaned = 0;
  for (const total of byOwner.values()) loaned += Math.max(0, total - 1);
  return loaned;
}

/**
 * Alias histórico de `countLoanedCharacters`.
 *
 * O nome antigo ("repetições de dono") descrevia o mesmo número, mas induzia à
 * leitura errada de que o limite seria por usuário. Mantido para não quebrar
 * chamadas existentes; a definição canônica é `countLoanedCharacters`.
 */
export function countOwnerRepeats(team: { dono: string; type?: PartyCandidate["type"] }[]): number {
  return countLoanedCharacters(team);
}

/**
 * Pode `cand` entrar num time que já tem `team`, respeitando o limite?
 *
 * Como as repetições só crescem quando membros são adicionados, verificar o
 * limite em cada passo parcial é seguro: um ramo que já estourou nunca voltaria
 * a caber (poda válida no backtracking).
 */
/**
 * REGRA "NÃO EMPRESTAR SERVICE".
 *
 * Quando ligada, um personagem de Service não pode ocupar uma participação
 * que conte como EMPRÉSTIMO daquele usuário — isto é, não pode ser o 2º (ou
 * seguinte) personagem do mesmo responsável.
 *
 * O que ela NÃO faz (deliberadamente):
 *   • não remove Services da sugestão;
 *   • não impede que um Service seja o PRIMEIRO personagem de um usuário
 *     (aí ele é gratuito, não é empréstimo);
 *   • não afeta Services de responsáveis diferentes — cada um é o primeiro
 *     do seu dono, então uma PT inteira de Services de 5 usuários continua
 *     válida;
 *   • não interfere no empréstimo de personagens pessoais, que segue
 *     valendo normalmente até o limite de "Emprestar no máximo".
 *
 * O custo em empréstimo é o MESMO critério de `countLoanedCharacters`: o
 * primeiro personagem de cada usuário é gratuito, do segundo em diante cada
 * um custa 1. Por isso a checagem é "o time já tem alguém deste dono?".
 */
export function isBlockedServiceLoan(
  team: { dono: string; type?: PartyCandidate["type"] }[],
  cand: { dono: string; type?: PartyCandidate["type"] },
  noServiceLoan: boolean | undefined,
): boolean {
  if (!noServiceLoan) return false;
  if (cand.type !== "waiting") return false;
  const key = ownerKey(cand.dono);
  // Já existe personagem deste responsável no time => este Service seria o
  // excedente/emprestado. Bloqueado.
  return team.some(member => ownerKey(member.dono) === key);
}

export function canAddWithinOwnerRepeats(
  team: { dono: string; type?: PartyCandidate["type"] }[],
  cand: { dono: string; type?: PartyCandidate["type"] },
  maxOwnerRepeats: number | null
): boolean {
  if (maxOwnerRepeats === null) return true;
  return countLoanedCharacters([...team, cand]) <= maxOwnerRepeats;
}

/**
 * Regra permanente: nunca dois personagens da MESMA CONTA REAL na mesma PT.
 *
 * "Mesma conta" = mesmo dono E mesmo nome de conta (`accountKey`). Comparar só
 * o nome tratava a conta "1" do Usuário A e a "1" do Usuário B como iguais e
 * bloqueava PTs perfeitamente válidas.
 *
 * Identidade indeterminada (sem conta ou sem dono conhecido) NUNCA bloqueia:
 * não se inventa um conflito que não se pode comprovar.
 */
export function hasAccountConflict(
  team: { accountKey?: string | null }[],
  cand: { accountKey?: string | null },
): boolean {
  const key = cand.accountKey;
  if (!key) return false;
  return team.some(member => member.accountKey === key);
}

/**
 * Retorna o candidato mais forte disponível (mesmo servidor e vocação) que não esteja no time atual,
 * OU null se não houver.
 */
export function findStrongerSwap(
  grouped: Record<string, PartyCandidate[]>,
  current: PartyCandidate,
  teamIds: Set<string>,
  team: PartyCandidate[],
  maxOwnerRepeats: number | null,
  noServiceLoan?: boolean
): PartyCandidate | null {
  const key = `${current.servidor}|${current.voc}`;
  const pool = grouped[key];
  if (!pool || pool.length <= 1) return null;

  const myIdx = pool.findIndex(c => c.id === current.id);
  if (myIdx <= 0) return null; // já é o mais forte

  // O time SEM o personagem que está sendo trocado: é contra ele que a conta e
  // as repetições de dono do substituto precisam ser avaliadas.
  const rest = team.filter(c => c.id !== current.id);
  const limit = normalizeMaxOwnerRepeats(maxOwnerRepeats);

  // Procurar o primeiro acima que não está no time e respeita as regras
  for (let i = myIdx - 1; i >= 0; i--) {
    const cand = pool[i];
    if (teamIds.has(cand.id)) continue;
    if (hasAccountConflict(rest, cand)) continue;
    if (!canAddWithinOwnerRepeats(rest, cand, limit)) continue;
    if (isBlockedServiceLoan(rest, cand, noServiceLoan)) continue;
    return cand;
  }
  return null;
}

/**
 * Retorna o candidato mais fraco disponível (mesmo servidor e vocação) que não esteja no time atual,
 * OU null se não houver.
 */
export function findWeakerSwap(
  grouped: Record<string, PartyCandidate[]>,
  current: PartyCandidate,
  teamIds: Set<string>,
  team: PartyCandidate[],
  maxOwnerRepeats: number | null,
  noServiceLoan?: boolean
): PartyCandidate | null {
  const key = `${current.servidor}|${current.voc}`;
  const pool = grouped[key];
  if (!pool || pool.length <= 1) return null;

  const myIdx = pool.findIndex(c => c.id === current.id);
  if (myIdx === -1 || myIdx >= pool.length - 1) return null; // já é o mais fraco

  const rest = team.filter(c => c.id !== current.id);
  const limit = normalizeMaxOwnerRepeats(maxOwnerRepeats);

  // Procurar o primeiro abaixo que não está no time e respeita as regras
  for (let i = myIdx + 1; i < pool.length; i++) {
    const cand = pool[i];
    if (teamIds.has(cand.id)) continue;
    if (hasAccountConflict(rest, cand)) continue;
    if (!canAddWithinOwnerRepeats(rest, cand, limit)) continue;
    if (isBlockedServiceLoan(rest, cand, noServiceLoan)) continue;
    return cand;
  }
  return null;
}

// ============================================================================
// MODO INTELIGENTE — Pontuação de templates por escassez de vocação
// ============================================================================
//
// Para cada template, calcula o "custo de escassez": quanto mais um template
// consome vocações raras no servidor, maior o custo. O template com menor
// custo é o que melhor preserva as vocações escassas.
//
// O custo de cada vocação consumida é inversamente proporcional à sua
// disponibilidade: se há 5 RP e o template pede 2, o custo de RP é 2/5 = 0.40.
// Se há 40 ED e o template pede 1, o custo de ED é 1/40 = 0.025.
//
// O custo total é a soma dos custos de todas as vocações consumidas.
// Em caso de empate (custos idênticos), a prioridade do array PARTY_TEMPLATES
// (Ideal > Muito Boa > Boa > Aceitável) serve como desempate.
// ============================================================================

/**
 * Conta a disponibilidade de cada vocação entre os candidatos de um servidor.
 */
function countVocationsOnServer(srvCandidates: PartyCandidate[]): Record<Vocation, number> {
  const counts: Record<Vocation, number> = { EK: 0, ED: 0, MS: 0, RP: 0, MK: 0 };
  srvCandidates.forEach(c => {
    if (c.voc && counts[c.voc] !== undefined) counts[c.voc]++;
  });
  return counts;
}

function canApplyTemplate(counts: Record<Vocation, number>, template: PartyTemplate): boolean {
  return (Object.keys(template.counts) as Vocation[]).every(voc => counts[voc] >= template.counts[voc]);
}

function applyTemplateCounts(counts: Record<Vocation, number>, template: PartyTemplate): Record<Vocation, number> {
  return {
    EK: counts.EK - template.counts.EK,
    ED: counts.ED - template.counts.ED,
    MS: counts.MS - template.counts.MS,
    RP: counts.RP - template.counts.RP,
    MK: counts.MK - template.counts.MK,
  };
}

export function computeMaxPossibleParties(counts: Record<Vocation, number>, templates: PartyTemplate[] = PARTY_TEMPLATES): number {
  const memo = new Map<string, number>();

  function key(c: Record<Vocation, number>) {
    return `${c.EK}|${c.ED}|${c.MS}|${c.RP}|${c.MK}`;
  }

  function dfs(c: Record<Vocation, number>): number {
    const k = key(c);
    const cached = memo.get(k);
    if (cached !== undefined) return cached;

    let best = 0;
    for (const template of templates) {
      if (!canApplyTemplate(c, template)) continue;
      best = Math.max(best, 1 + dfs(applyTemplateCounts(c, template)));
    }
    memo.set(k, best);
    return best;
  }

  return dfs(counts);
}

/**
 * Calcula o custo de escassez de um template dado a disponibilidade de vocações.
 * Quanto menor o custo, melhor o template preserva vocações raras.
 *
 * Para vocações com 0 disponíveis e requisito > 0, retorna Infinity (impossível).
 */
function computeScarcityCost(
  template: PartyTemplate,
  vocCounts: Record<Vocation, number>
): number {
  let totalCost = 0;
  for (const voc of Object.keys(template.counts) as Vocation[]) {
    const required = template.counts[voc];
    if (required === 0) continue;
    const available = vocCounts[voc];
    if (available === 0) return Infinity; // impossível formar com este template
    // Custo = quanto este template consome proporcionalmente ao que existe
    totalCost += required / available;
  }
  return totalCost;
}

/**
 * Ordena os templates para o modo "inteligente" com base na escassez de vocações.
 * Retorna uma cópia dos templates reordenada: menor custo de escassez primeiro.
 * Em caso de empate, mantém a ordem original (Ideal > Muito Boa > Boa > Aceitável).
 */
function rankTemplatesByScarcity(
  templates: PartyTemplate[],
  vocCounts: Record<Vocation, number>
): PartyTemplate[] {
  const scored = templates.map((t, originalIndex) => {
    const possible = canApplyTemplate(vocCounts, t);
    const remaining = possible ? applyTemplateCounts(vocCounts, t) : vocCounts;
    return {
      template: t,
      cost: computeScarcityCost(t, vocCounts),
      futurePTs: possible ? computeMaxPossibleParties(remaining, templates) : -1,
      originalIndex,
    };
  });

  // 1) preserva o maior número de PTs futuras;
  // 2) entre opções equivalentes, consome proporcionalmente menos vocações escassas;
  // 3) por fim, usa a hierarquia oficial como desempate.
  scored.sort((a, b) => {
    if (b.futurePTs !== a.futurePTs) return b.futurePTs - a.futurePTs;
    if (a.cost !== b.cost) return a.cost - b.cost;
    return a.originalIndex - b.originalIndex;
  });

  return scored.map(s => s.template);
}

/**
 * Função principal para rodar o algoritmo de sugestão de PT.
 */
export function suggestParty(
  characters: Character[],
  waitingList: WaitingService[],
  allParties: PartyTab[],
  currentPartyId: string,
  defaultUserName: string,
  options: SuggestionOptions
): SuggestedPartyResult {
  const candidates = collectEligibleCandidates(
    characters,
    waitingList,
    allParties,
    currentPartyId,
    defaultUserName,
    options
  );

  if (candidates.length < 5) {
    return {
      success: false,
      templateName: "Nenhum",
      server: "Nenhum",
      candidates: [],
      avgLevel: 0,
      strength: options.strength,
      errorMessage: `Existem apenas ${candidates.length} personagem(ns) elegível(is) após os filtros. São necessários pelo menos 5.`,
    };
  }

  // 3. Agrupar por Servidor
  const byServer = groupCandidatesByServer(candidates);

  // 4. Definir ordem de servidores a inspecionar
  const serverQueue = getServerQueue(byServer, options);

  if (serverQueue.length === 0) {
    return {
      success: false,
      templateName: "Nenhum",
      server: options.serverMode === "specific" ? options.specificServer : "Auto",
      candidates: [],
      avgLevel: 0,
      strength: options.strength,
      errorMessage: "Nenhum servidor possui candidatos suficientes de acordo com os filtros de usuário e quest aplicados.",
    };
  }

  // 4.1. Resolver gabaritos a serem usados com base no templateType
  let templatesToTry: PartyTemplate[] = [];
  const requestedType = normalizeTemplateType(options.templateType);

  if (requestedType === "inteligente") {
    // PT Inteligente: os templates serão reordenados por servidor (ver seção 5)
    templatesToTry = [...PARTY_TEMPLATES];
  } else if (requestedType === "custom" && options.customComposition) {
    // PT Personalizada: usa a composição definida pelo usuário
    const customTemplate: PartyTemplate = {
      name: "Composição Personalizada",
      counts: {
        EK: options.customComposition.EK,
        ED: options.customComposition.ED,
        MS: options.customComposition.MS,
        RP: options.customComposition.RP,
        MK: options.customComposition.MK,
      }
    };
    templatesToTry = [customTemplate];
  } else if (requestedType === "ideal") {
    // Só a composição ideal.
    templatesToTry = PARTY_TEMPLATES.filter(t => t.name === IDEAL_TEMPLATE_NAME);
  } else {
    // "muito_boa": TODAS as oito. Não há ordem fixa entre elas — a escolha
    // sai da escassez do servidor, igual ao modo inteligente.
    templatesToTry = PARTY_TEMPLATES.filter(t => t.name !== IDEAL_TEMPLATE_NAME);
  }

  // Helper para pontuar uma combinação de acordo com a Força (Strength)
  function scoreTeamLevel(team: PartyCandidate[], strength: "low" | "medium" | "high", targets: StrengthTargets): number {
    const avgLevel = team.reduce((sum, c) => sum + c.level, 0) / team.length;

    if (strength === "high") {
      return avgLevel >= targets.high ? 100000 + avgLevel : avgLevel;
    }

    if (strength === "low") {
      return avgLevel <= targets.low
        ? 100000 - Math.abs(avgLevel - targets.low)
        : -Math.abs(avgLevel - targets.low);
    }

    // Medium: quão próximo do level alvo automático do servidor
    return 100000 - Math.abs(avgLevel - targets.medium);
  }

  // Limite de empréstimo desta execução: quantas repetições de dono a PT pode
  // ter. `null` = sem limite. Resolvido uma única vez, fora da recursão.
  const maxOwnerRepeats = normalizeMaxOwnerRepeats(options.maxOwnerRepeats);

  // Função para buscar a melhor combinação de 5 membros para um dado gabarito (template) e servidor
  function findBestTeamForTemplate(
    srvCandidates: PartyCandidate[],
    template: PartyTemplate,
    targets: StrengthTargets
  ): { team: PartyCandidate[]; score: number } | null {
    // Separar candidatos por vocação
    const pool: Record<Vocation, PartyCandidate[]> = {
      EK: [],
      ED: [],
      MS: [],
      RP: [],
      MK: [],
    };

    srvCandidates.forEach(c => {
      if (pool[c.voc]) pool[c.voc].push(c);
    });

    // Inspecionar se temos candidatos suficientes em cada vocação antes de rodar a busca
    for (const voc of Object.keys(template.counts) as Vocation[]) {
      if (pool[voc].length < template.counts[voc]) return null;
    }

    // Identificar a lista exata de slots a preencher
    const requiredVocations: Vocation[] = [];
    for (const voc of Object.keys(template.counts) as Vocation[]) {
      for (let i = 0; i < template.counts[voc]; i++) {
        requiredVocations.push(voc);
      }
    }
    // requiredVocations tem exatamente 5 elementos

    let bestTeam: PartyCandidate[] | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;

    let evalCount = 0;
    const MAX_EVAL = 10000; // Proteção contra travamento

    // Backtracking DFS para montar as combinações
    function dfs(
      slotIdx: number,
      currentTeam: PartyCandidate[],
      usedAccounts: Set<string>,
      donoCounts: Map<string, number>,
      ownerRepeats: number
    ) {
      if (evalCount > MAX_EVAL) return;

      if (slotIdx === 5) {
        evalCount++;
        const score = scoreTeamLevel(currentTeam, options.strength, targets);
        if (score > bestScore) {
          bestScore = score;
          bestTeam = [...currentTeam];
        }
        return;
      }

      const voc = requiredVocations[slotIdx];
      const candidatesForSlot = pool[voc];

      for (let i = 0; i < candidatesForSlot.length; i++) {
        const cand = candidatesForSlot[i];

        // Verificar unicidade de candidatos já escolhidos na combinação atual
        if (currentTeam.some(c => c.id === cand.id)) continue;

        // Unicidade de CONTA REAL (SEMPRE: 1 personagem por conta).
        // A chave é `ownerUid + nome`, então a conta "1" do Usuário A não
        // colide com a conta "1" do Usuário B. Independente do empréstimo.
        if (cand.accountKey && usedAccounts.has(cand.accountKey)) continue;

        // Limite de EMPRÉSTIMO: quantas repetições de dono a PT pode ter.
        // O dono só custa uma repetição a partir do 2º personagem dele; poda
        // válida porque as repetições nunca diminuem ao avançar nos slots.
        // Custo em EMPRÉSTIMOS: o 1º personagem de um dono é gratuito; do 2º
        // em diante cada um custa 1. Somando ao longo do time isso é
        // exatamente Σ max(0, personagensDoUsuario − 1) — um total GLOBAL,
        // livre para se distribuir entre donos diferentes.
        const candDono = ownerKey(cand.dono);
        const candRepeatCost = (donoCounts.get(candDono) || 0) > 0 ? 1 : 0;
        if (maxOwnerRepeats !== null && ownerRepeats + candRepeatCost > maxOwnerRepeats) continue;

        // "Não emprestar Service": um Service não pode ser o personagem
        // EXCEDENTE do usuário. `candRepeatCost > 0` significa exatamente
        // "já existe alguém deste dono no time", ou seja, este entraria como
        // empréstimo. Reaproveita o custo já calculado acima em vez de
        // varrer o time de novo.
        if (options.noServiceLoan && cand.type === "waiting" && candRepeatCost > 0) continue;

        // Shared XP: verificar se a diferença de level é ≤ 33%
        if (options.sharedXP && currentTeam.length > 0) {
          const levels = [...currentTeam.map(c => c.level), cand.level];
          const maxLevel = Math.max(...levels);
          const minLevel = Math.min(...levels);
          const diff = maxLevel - minLevel;
          const maxAllowed = maxLevel * 0.33;
          if (diff > maxAllowed) continue;
        }

        // Fazer a jogada
        currentTeam.push(cand);
        if (cand.accountKey) usedAccounts.add(cand.accountKey);
        donoCounts.set(candDono, (donoCounts.get(candDono) || 0) + 1);

        dfs(slotIdx + 1, currentTeam, usedAccounts, donoCounts, ownerRepeats + candRepeatCost);

        // Desfazer a jogada
        currentTeam.pop();
        if (cand.accountKey) usedAccounts.delete(cand.accountKey);
        const restored = (donoCounts.get(candDono) || 1) - 1;
        if (restored > 0) donoCounts.set(candDono, restored);
        else donoCounts.delete(candDono);

        if (evalCount > MAX_EVAL) break;
      }
    }

    dfs(0, [], new Set(), new Map(), 0);

    if (!bestTeam) return null;
    return { team: bestTeam, score: bestScore };
  }

  /**
   * Qualidade da composição: só existem duas categorias.
   *
   * Serve de DESEMPATE entre servidores, depois de "PTs futuras". Entre as
   * Muito Boas o valor é o mesmo de propósito — não há ordem fixa entre elas,
   * a preferência vem da escassez de vocação (ver `rankTemplatesByScarcity`).
   */
  function getTemplateQuality(template: PartyTemplate): number {
    if (template.name === IDEAL_TEMPLATE_NAME) return 2;
    if (template.name.startsWith("PT Muito Boa")) return 1;
    return 0;   // Composição Personalizada
  }

  interface ServerSuggestionCandidate {
    result: SuggestedPartyResult;
    template: PartyTemplate;
    teamScore: number;
    futurePTs: number;
    templateQuality: number;
    serverCandidatesCount: number;
  }

  const serverSuggestions: ServerSuggestionCandidate[] = [];

  // 5. Pipeline principal: testar TODOS os servidores da fila antes de escolher.
  for (let sIdx = 0; sIdx < serverQueue.length; sIdx++) {
    const srv = serverQueue[sIdx];
    const srvCandidates = byServer[srv];
    const targets = {
      ...deriveStrengthTargets(getAverageLevel(srvCandidates)),
      server: srv,
      candidatesCount: srvCandidates.length,
    };

    // Para este servidor, determinar a ordem dos templates a tentar.
    // No modo "inteligente", reordena os templates com base na escassez de
    // vocações DESTE servidor específico, preservando a prioridade hierárquica
    // (Ideal > Muito Boa > Boa > Aceitável) como desempate.
    let templates: PartyTemplate[];
    const vocCounts = countVocationsOnServer(srvCandidates);
    if (requestedType === "inteligente") {
      templates = rankTemplatesByScarcity(templatesToTry, vocCounts);
    } else {
      templates = templatesToTry.length > 0 ? templatesToTry : PARTY_TEMPLATES;
    }

    for (let tIdx = 0; tIdx < templates.length; tIdx++) {
      const template = templates[tIdx];
      if (options.skipTemplateNames?.includes(template.name)) continue;

      const res = findBestTeamForTemplate(srvCandidates, template, targets);

      if (res) {
        // Encontramos a melhor composição deste servidor segundo a ordem do algoritmo.
        const avgLevel = Math.round(
          res.team.reduce((sum, c) => sum + c.level, 0) / 5
        );

        const carriers: number[] = computeCarrierIndices(res.team);
        const carrierLevel = carriers.length > 0 ? res.team[carriers[0]].level : 0;
        const candidatesByVocAndServer = groupCandidatesByVocAndServer(srvCandidates);
        const remainingCounts = applyTemplateCounts(vocCounts, template);

        serverSuggestions.push({
          result: {
            success: true,
            templateName: template.name,
            server: srv,
            candidates: res.team,
            avgLevel,
            strength: options.strength,
            candidatesByVocAndServer,
            carriers,
            carrierLevel,
            futurePTsAfterSuggestion: computeMaxPossibleParties(remainingCounts, templatesToTry.length > 0 ? templatesToTry : PARTY_TEMPLATES),
            templateQuality: getTemplateQuality(template),
            teamScore: res.score,
            serverCandidatesCount: srvCandidates.length,
          },
          template,
          teamScore: res.score,
          futurePTs: computeMaxPossibleParties(remainingCounts, templatesToTry.length > 0 ? templatesToTry : PARTY_TEMPLATES),
          templateQuality: getTemplateQuality(template),
          serverCandidatesCount: srvCandidates.length,
        });
        break;
      }
    }
  }

  if (serverSuggestions.length > 0) {
    serverSuggestions.sort((a, b) => {
      if (b.futurePTs !== a.futurePTs) return b.futurePTs - a.futurePTs;
      if (b.templateQuality !== a.templateQuality) return b.templateQuality - a.templateQuality;
      if (b.teamScore !== a.teamScore) return b.teamScore - a.teamScore;
      if (b.serverCandidatesCount !== a.serverCandidatesCount) return b.serverCandidatesCount - a.serverCandidatesCount;
      return a.result.server.localeCompare(b.result.server, "pt-BR");
    });

    return serverSuggestions[0].result;
  }

  // Se passou por todos os servidores e todos os gabaritos e não encontrou nada
  // Montar mensagem detalhada informando o que faltou
  const templateLabel = requestedType === "inteligente" ? "PT Inteligente"
    : requestedType === "ideal" ? IDEAL_TEMPLATE_NAME
    : requestedType === "muito_boa" ? "PT Muito Boa"
    : requestedType === "custom" ? "Composição Personalizada"
    : "PT";
  const totalCandidates = candidates.length;
  const serversChecked = serverQueue.length;

  let detailedMsg = `Não foi possível montar "${templateLabel}" com os filtros atuais.\n\n`;
  detailedMsg += `• ${totalCandidates} personagem(ns) elegível(is) encontrado(s)\n`;
  detailedMsg += `• ${serversChecked} servidor(es) inspecionado(s)\n`;
  if (options.sharedXP) detailedMsg += `• Shared XP ativo (diferença de level máxima 33%)\n`;
  if (options.useCharacters === false) detailedMsg += `• Personagens de usuários desativados\n`;
  if (options.useWaitingList === false) detailedMsg += `• Lista de Espera desativada\n`;
  detailedMsg += `\nVerifique os filtros de nível mínimo, vocação, servidor e Shared XP.`;

  return {
    success: false,
    templateName: "Nenhum",
    server: options.serverMode === "specific" ? options.specificServer : "Auto",
    candidates: [],
    avgLevel: 0,
    strength: options.strength,
    errorMessage: detailedMsg,
  };
}