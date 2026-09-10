// ============================================================================
// TUTORIAL — CAMADA DE DADOS DEMONSTRATIVOS (agregador)
// ----------------------------------------------------------------------------
// Ponto único de acesso do motor do tutorial aos datasets fictícios. O
// carregamento é feito por import dinâmico (loadDemoData) para que os dados
// NUNCA entrem no bundle inicial — só são baixados/instanciados quando uma
// cena com `demo: true` é aberta pela primeira vez na sessão.
//
// ISOLAMENTO: os dados existem apenas em memória, com ids prefixados por
// "demo-". Nenhuma função aqui grava em Firestore, localStorage ou qualquer
// outro armazenamento. As guardas finais contra persistência acidental estão
// nos handlers do App (rejeitam ids "demo-") e no bloqueio de cliques do
// TutorialOverlay.
// ============================================================================
import type { Character, CharacterAcquisition, CharacterAcquisitionBuyerDetails, PartyTab, PersonalPartyHistory, ServiceRequest, SharedService, WaitingService } from "../../types";
import type { DemoBazaarData } from "./demoBazaar";

export interface TutorialDemoData {
  /** Instante em que o conjunto foi instanciado (referência dos cronômetros). */
  builtAt: number;
  characters: Character[];
  /**
   * Personagens dos AMIGOS fictícios (demo-friend-*): entram SOMENTE como
   * `sharedCharacters` do Bazaar demonstrativo, para os destaques de
   * prioridade (Máxima/comum/"para você") acenderem no tutorial. Nunca vão
   * para "Meus Personagens" nem para o Stats.
   */
  friendCharacters: Character[];
  /** characters + friendCharacters — lista compartilhada do Bazaar demo. */
  bazaarSharedCharacters: Character[];
  soldCharacters: Character[];
  acquisitions: CharacterAcquisition[];
  acquisitionBuyerDetails: CharacterAcquisitionBuyerDetails[];
  parties: PartyTab[];
  waitingList: WaitingService[];
  history: PersonalPartyHistory[];
  sharedServices: SharedService[];
  serviceRequests: ServiceRequest[];
  bazaar: DemoBazaarData;
  userStats: Record<string, any>;
  userNames: Record<string, string>;
  ranking: Record<string, any>[];
}

/** Prefixo reservado de TODOS os ids fictícios do tutorial. */
export const DEMO_ID_PREFIX = "demo-";

/** True quando o id pertence a um registro demonstrativo do tutorial. */
export function isDemoId(id: unknown): boolean {
  return typeof id === "string" && id.startsWith(DEMO_ID_PREFIX);
}

/**
 * UID simbólico usado nos datasets para representar o PRÓPRIO usuário.
 * `loadDemoData` troca-o pelo uid real logado (personalização): assim os
 * painéis reconhecem o usuário como líder/dono/serviceiro e exibem a visão
 * completa (botões de líder, destaque no ranking, coluna DONO "Você").
 */
export const DEMO_SELF_UID = "demo-uid-you";

/** Nome simbólico do próprio usuário nos datasets — trocado pelo nome real. */
export const DEMO_SELF_NAME = "Você";

/**
 * Substitui o uid/nome simbólicos pelos reais em todo o conjunto.
 * A troca é feita no JSON serializado comparando o VALOR COMPLETO com aspas
 * (`"demo-uid-you"` / `"Você"`), o que cobre valores e chaves de mapas
 * (partners/userNames) sem risco de tocar substrings dentro de textos.
 */
function personalize(data: TutorialDemoData, uid: string, name: string): TutorialDemoData {
  try {
    let json = JSON.stringify(data);
    if (uid && uid !== DEMO_SELF_UID) json = json.split(JSON.stringify(DEMO_SELF_UID)).join(JSON.stringify(uid));
    if (name && name !== DEMO_SELF_NAME) json = json.split(JSON.stringify(DEMO_SELF_NAME)).join(JSON.stringify(name));
    return JSON.parse(json) as TutorialDemoData;
  } catch {
    return data;
  }
}

let cached: TutorialDemoData | null = null;
let cachedKey = "";

/**
 * Instancia (uma vez por sessão/usuário) o conjunto completo de dados
 * fictícios, personalizado com o uid/nome reais do usuário logado.
 * Import dinâmico: o custo de bundle/memória só existe se o tutorial usar.
 */
export async function loadDemoData(uid = "", userName = ""): Promise<TutorialDemoData> {
  const key = `${uid}|${userName}`;
  if (cached && cachedKey === key) return cached;
  const now = Date.now();
  const [chars, parties, waiting, history, services, bazaar, stats, acquisitions] = await Promise.all([
    import("./demoCharacters"),
    import("./demoParties"),
    import("./demoWaitingList"),
    import("./demoHistory"),
    import("./demoServices"),
    import("./demoBazaar"),
    import("./demoStats"),
    import("./demoAcquisitions"),
  ]);
  const ownCharacters = chars.buildDemoCharacters(now);
  const friendCharacters = chars.buildDemoFriendCharacters(now);
  const raw: TutorialDemoData = {
    builtAt: now,
    characters: ownCharacters,
    friendCharacters,
    bazaarSharedCharacters: [...ownCharacters, ...friendCharacters],
    soldCharacters: chars.buildDemoSoldCharacters(now),
    acquisitions: acquisitions.buildDemoAcquisitions(now),
    acquisitionBuyerDetails: acquisitions.buildDemoAcquisitionBuyerDetails(now),
    parties: parties.buildDemoParties(now),
    waitingList: waiting.buildDemoWaitingList(now),
    history: history.buildDemoHistory(now),
    sharedServices: services.buildDemoSharedServices(now),
    serviceRequests: services.buildDemoServiceRequests(now),
    bazaar: bazaar.buildDemoBazaar(now),
    userStats: stats.buildDemoUserStats(now),
    userNames: stats.DEMO_USER_NAMES,
    ranking: stats.buildDemoRanking(now),
  };
  cached = personalize(raw, uid, userName);
  cachedKey = key;
  return cached;
}
