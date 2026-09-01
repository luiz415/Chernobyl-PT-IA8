import type { Vocation } from "../types";
import { serverKey } from "../constants/servers";
import { computeServerPriorityVocations } from "../utils/vocationPriority";
import type { FriendsSummaryCandidate } from "../components/FriendsSummaryModal";

// ============================================================================
// PRIORIDADE PARA VOCÊ — destaque de compra específico do usuário atual
// ----------------------------------------------------------------------------
// Regra do Painel Bazaar (ADITIVA, não substitui as prioridades atuais).
// Calculada INDIVIDUALMENTE para o usuário que está visualizando, usando APENAS
// os filtros atuais do Resumo de Amigos/VISÃO GERAL.
//
// Para CADA servidor, decide-se de forma independente:
//   • quantos personagens PRÓPRIOS do usuário passaram pelos filtros nele;
//   • quantos personagens dos AMIGOS SELECIONADOS passaram pelos mesmos filtros.
//
// Regra de destaque:
//   • usuário atual com 0 personagens válidos no servidor E amigos selecionados
//     com ≥1 personagem válido lá → TODOS os personagens do Bazaar daquele
//     servidor recebem "Prioridade para você".
//   • usuário atual com ≥1 personagem válido no servidor → mantém a lógica de
//     melhores vocações (não marca o servidor inteiro).
//
// Isso vale para TODOS os servidores que satisfazem a condição — nunca apenas
// o primeiro/"melhor". O resultado é estritamente por usuário + filtros: não há
// estado global nem cache compartilhado; cada chamada recalcula a partir dos
// candidatos e da cobertura do usuário recebidos.
//
// FONTE ÚNICA: recebe os `candidates` já produzidos por
// `buildVocationCountsByServer` (a MESMA coleta/filtragem do Resumo de Amigos).
// O estado de cobertura do usuário vem de `currentUserServerKeys` (personagens
// próprios sob os MESMOS filtros).
//
// PERFORMANCE: o cálculo roda UMA vez por render (useMemo no BazarPanel) e
// produz conjuntos pré-derivados (servidor e servidor+vocação) reutilizados por
// todas as linhas — nunca refiltra a base por linha.
//
// A chave de servidor é sempre `serverKey` (nome COMPLETO e canônico): Grimoria
// I/II/III/IV nunca se misturam e nomenclaturas antigas do mesmo servidor caem
// no mesmo balde. Nenhum `includes`/`startsWith` envolvido.
// ============================================================================

export interface UserPriorityResult {
  /** `serverKey`s (minúsculo e canônico) onde a regra vale. */
  highlightedServers: Set<string>;
  /**
   * Para cada servidor em destaque, as vocações prioritárias de compra
   * (Prioridade Máxima + Prioridade comum, mesma lógica do Resumo de Amigos).
   */
  priorityVocationsByServer: Map<string, Set<Vocation>>;
  /** Os amigos considerados por esta regra (nomes de dono). */
  amigos: string[];
}

export interface UserPriorityInput {
  /** Candidatos do Resumo de Amigos (já filtrados por Quest/level/usuários/etc.). */
  candidates: FriendsSummaryCandidate[];
  currentUserName: string;
  currentUserUid: string | null;
  userMode: "any" | "filter";
  selectedUsers: string[];
  /**
   * `serverKey`s onde o usuário ATUAL possui personagem válido sob os MESMOS
   * filtros do Resumo de Amigos. Precisamos passá-lo separado porque, quando
   * `userMode === "filter"`, os candidatos podem excluir o próprio usuário.
   */
  currentUserServerKeys: Set<string>;
  /**
   * `serverKey`s presentes na listagem atual do Bazaar. Quando informado, o
   * destaque considera TODOS os servidores do Bazaar (e não apenas os que os
   * amigos possuem personagem), destacando aqueles em que o usuário atual não
   * tem nenhum personagem válido.
   */
  bazaarServerKeys?: Set<string>;
}

/** Um personagem pertence ao usuário atual (por uid ou nome de dono). */
function isOwnCandidate(candidate: FriendsSummaryCandidate, name: string, uid: string | null): boolean {
  if (uid && candidate.rawObj && (candidate.rawObj as { ownerUid?: string }).ownerUid === uid) return true;
  return !!candidate.dono && candidate.dono === name;
}

const EMPTY_COUNTS: Record<Vocation, number> = { EK: 0, ED: 0, MS: 0, RP: 0, MK: 0 };

export function computeUserPriority(input: UserPriorityInput): UserPriorityResult {
  const { candidates, currentUserName, currentUserUid, userMode, selectedUsers, currentUserServerKeys, bazaarServerKeys } = input;
  const highlightedServers = new Set<string>();
  const priorityVocationsByServer = new Map<string, Set<Vocation>>();

  // "Amigos" são os DONOS reais de personagem (não Services de terceiros) e
  // nunca o usuário atual. Mantidos apenas para as vocações prioritárias.
  const friendCandidates = candidates.filter(
    candidate => candidate.type === "char" && !isOwnCandidate(candidate, currentUserName, currentUserUid),
  );

  // Conjunto de amigos a considerar — exatamente os "atualmente selecionados":
  //   • `userMode === "filter"` com usuários escolhidos → usa `selectedUsers`;
  //   • caso contrário → todos os donos de personagem presentes (excluindo o usuário).
  let amigos: string[];
  if (userMode === "filter" && selectedUsers.length > 0) {
    const set = new Set(selectedUsers);
    set.delete(currentUserName);
    amigos = [...set];
  } else {
    amigos = [...new Set(friendCandidates.map(candidate => candidate.dono).filter(Boolean))] as string[];
  }

  const amigoSet = new Set(amigos);

  // Contagens servidor+vocação considerando APENAS os amigos selecionados.
  // `friendCountByServer` guarda quantos personagens válidos dos amigos existem
  // em cada servidor (usado para exigir que haja ao menos um). `countsByServer`
  // alimenta as vocações prioritárias dentro de um servidor já em destaque.
  const friendCountByServer = new Map<string, number>();
  const countsByServer = new Map<string, Record<Vocation, number>>();

  friendCandidates.forEach(candidate => {
    if (!amigoSet.has(candidate.dono)) return;
    const serverKeyValue = serverKey(candidate.servidor);
    if (!serverKeyValue) return;

    friendCountByServer.set(serverKeyValue, (friendCountByServer.get(serverKeyValue) || 0) + 1);

    if (!countsByServer.has(serverKeyValue)) countsByServer.set(serverKeyValue, { ...EMPTY_COUNTS });
    const voc = candidate.voc as Vocation;
    if (voc in countsByServer.get(serverKeyValue)!) {
      countsByServer.get(serverKeyValue)![voc] += 1;
    }
  });

  // ── Servidores a avaliar ─────────────────────────────────────────────────
  // Quando `bazaarServerKeys` é fornecido, considera TODOS os servidores da
  // listagem atual do Bazaar. Caso contrário, cai nos servidores presentes nos
  // candidatos do Resumo de Amigos. Todos passam por `serverKey` (normalização
  // canônica) para que aliases/variações colapsem no mesmo balde.
  const candidateServers = new Set<string>();
  if (bazaarServerKeys && bazaarServerKeys.size > 0) {
    bazaarServerKeys.forEach(raw => {
      const sk = serverKey(raw);
      if (sk) candidateServers.add(sk);
    });
  } else {
    candidates.forEach(candidate => {
      const sk = serverKey(candidate.servidor);
      if (sk) candidateServers.add(sk);
    });
  }

  candidateServers.forEach(serverKeyValue => {
    // Regra de destaque (por servidor, individual):
    //   1) o usuário atual NÃO possui personagem válido neste servidor;
    //   2) existe ao menos UM personagem válido dos amigos selecionados aqui.
    // Ambas as condições são necessárias. Aplica-se a TODOS os servidores que
    // as satisfazem — nunca apenas ao primeiro/"melhor".
    if (currentUserServerKeys.has(serverKeyValue)) return;
    const friendCount = friendCountByServer.get(serverKeyValue) || 0;
    if (friendCount <= 0) return;

    highlightedServers.add(serverKeyValue);

    // Vocações prioritárias de compra: como o usuário não tem personagem aqui,
    // as contagens dos amigos == contagens totais do servidor (0 do usuário).
    const counts = countsByServer.get(serverKeyValue);
    if (counts) {
      const { max, normal } = computeServerPriorityVocations(counts);
      const set = new Set<Vocation>([...max, ...normal]);
      if (set.size > 0) priorityVocationsByServer.set(serverKeyValue, set);
    }
  });

  return { highlightedServers, priorityVocationsByServer, amigos };
}