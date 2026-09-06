import { collection, deleteDoc, doc, getDoc, getDocs, onSnapshot, query, setDoc, serverTimestamp, where } from "firebase/firestore";
import { db } from "../firebase/config";
import type { ServicePaymentMethod, ServiceRequest, ServiceRequestStatus, SharedService, SharedServiceStatus, Vocation, WaitingService } from "../types";
import { normalizeServerName } from "../constants/servers";
import { resolveServiceValue } from "../types";

// ============================================================================
// MEUS SERVICES — persistência em `sharedServices/{uid}`
//
// Um documento por Serviceiro, contendo o array `services`. O formato espelha
// `userCharacters/{uid}` (usado por "Meus Personagens") justamente para
// reaproveitar a mesma estratégia de economia do Firestore:
//
//   • 1 leitura por sessão (não por render, nem por troca de aba);
//   • cache local em localStorage, hidratado na abertura;
//   • gravação em documento único — 1 escrita por alteração, não N.
//
// Diferente da Lista de Espera, nada aqui é apagado ao concluir a Quest: o
// Service apenas muda de `status`, preservando histórico e lucro.
// ============================================================================

export const SHARED_SERVICES_COLLECTION = "sharedServices";
const CACHE_KEY_PREFIX = "cloud_cache_sharedServices_";

function cacheKey(uid: string) {
  return `${CACHE_KEY_PREFIX}${uid}`;
}

/** Converte um timestamp em `YYYY-MM-DD` (data local). */
export function toIsoDate(ms: number = Date.now()): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Cria um id estável, no mesmo padrão já usado pelo restante do projeto. */
export function createServiceId(): string {
  return `svc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/** Normaliza um registro vindo do Firestore/cache, preenchendo lacunas. */
function normalizeService(raw: any, fallbackUid: string, fallbackNome: string): SharedService | null {
  const id = String(raw?.id || "").trim();
  if (!id) return null;
  const status: SharedServiceStatus = raw?.status === "realizado" ? "realizado" : "disponivel";
  const toNumber = (value: unknown) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  };
  return {
    id,
    personagem: String(raw?.personagem || "").trim(),
    ownerName: String(raw?.ownerName || "").trim(),
    servidor: normalizeServerName(raw?.servidor),
    voc: (raw?.voc || "EK") as Vocation,
    level: toNumber(raw?.level),
    valorCombinado: toNumber(raw?.valorCombinado),
    notes: String(raw?.notes || ""),
    whatsappCountry: String(raw?.whatsappCountry || ""),
    whatsappArea: String(raw?.whatsappArea || ""),
    whatsappNumber: String(raw?.whatsappNumber || ""),
    quest: raw?.quest === "sanguine" ? "sanguine" : "soulwar",
    paymentMethod: (["pix", "rc", "5050", "combinado"].includes(raw?.paymentMethod) ? raw.paymentMethod : "") as ServicePaymentMethod,
    // Registros antigos não têm data: usa a de criação como referência.
    dataService: String(raw?.dataService || "").trim() || toIsoDate(toNumber(raw?.createdAt) || Date.now()),
    serviceiroUid: String(raw?.serviceiroUid || fallbackUid),
    serviceiroNome: String(raw?.serviceiroNome || fallbackNome || ""),
    status,
    lucroService: toNumber(raw?.lucroService),
    createdAt: toNumber(raw?.createdAt) || Date.now(),
    updatedAt: toNumber(raw?.updatedAt) || toNumber(raw?.createdAt) || Date.now(),
    ...(status === "realizado" && toNumber(raw?.completedAt) ? { completedAt: toNumber(raw.completedAt) } : {}),
    // Marcador de primeira mensagem ao cliente ("Abrir conversa" confirmado
    // no modal Enviar WhatsApp). Preservado apenas quando presente e válido.
    ...(toNumber(raw?.firstMessageSentAt) ? { firstMessageSentAt: toNumber(raw.firstMessageSentAt) } : {}),
  };
}

/** Lê o cache local. Evita tela vazia enquanto o Firestore responde. */
export function readSharedServicesCache(uid: string): SharedService[] {
  if (!uid) return [];
  try {
    const raw = localStorage.getItem(cacheKey(uid));
    const parsed = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(item => normalizeService(item, uid, ""))
      .filter((item): item is SharedService => item !== null);
  } catch {
    return [];
  }
}

export function saveSharedServicesCache(uid: string, services: SharedService[]) {
  if (!uid) return;
  try { localStorage.setItem(cacheKey(uid), JSON.stringify(services)); } catch {}
}

/**
 * Carrega os Services do usuário. UMA leitura por sessão — o chamador é
 * responsável por não repetir a chamada (ver guarda no MyServicesPanel).
 */
export async function fetchSharedServices(uid: string, serviceiroNome: string): Promise<{ services: SharedService[]; error?: string }> {
  if (!uid) return { services: [] };
  if (!db) return { services: readSharedServicesCache(uid), error: "Firestore indisponível." };
  try {
    const snap = await getDoc(doc(db, SHARED_SERVICES_COLLECTION, uid));
    if (!snap.exists()) {
      saveSharedServicesCache(uid, []);
      return { services: [] };
    }
    const data = snap.data() as any;
    const list = Array.isArray(data?.services) ? data.services : [];
    const services = list
      .map((item: any) => normalizeService(item, uid, serviceiroNome))
      .filter((item: SharedService | null): item is SharedService => item !== null);
    saveSharedServicesCache(uid, services);
    return { services };
  } catch (error: any) {
    // Falha de rede/permissão: mantém o que já estava em cache.
    return { services: readSharedServicesCache(uid), error: error?.message || String(error) };
  }
}

/**
 * Persiste a lista completa do usuário.
 *
 * `serviceiroUid` é sempre reescrito com o UID autenticado, então o
 * proprietário não pode ser forjado nem alterado pelo cliente.
 */
export async function persistSharedServices(uid: string, services: SharedService[]): Promise<{ ok: boolean; error?: string }> {
  if (!uid) return { ok: false, error: "Usuário não autenticado." };
  const owned = services.map(service => ({ ...service, serviceiroUid: uid }));
  saveSharedServicesCache(uid, owned);
  if (!db) return { ok: false, error: "Firestore indisponível." };
  try {
    await setDoc(doc(db, SHARED_SERVICES_COLLECTION, uid), {
      serviceiroUid: uid,
      services: owned,
      updatedAt: serverTimestamp(),
      updatedAtMs: Date.now(),
    });
    return { ok: true };
  } catch (error: any) {
    return { ok: false, error: error?.message || String(error) };
  }
}

/** Aplica os campos derivados de status/lucro de forma consistente. */
export function applyServiceStatus(service: SharedService, realizado: boolean, lucroService: number): SharedService {
  const now = Date.now();
  const lucro = Number.isFinite(lucroService) && lucroService > 0 ? lucroService : 0;
  if (realizado) {
    return {
      ...service,
      status: "realizado",
      lucroService: lucro,
      updatedAt: now,
      // Preserva a data da primeira conclusão em edições posteriores.
      completedAt: service.completedAt || now,
    };
  }
  const { completedAt, ...rest } = service;
  void completedAt;
  return { ...rest, status: "disponivel", lucroService: lucro, updatedAt: now };
}

/** Total de lucro dos Services realizados — consumido pelo painel Stats. */
export function sumServiceProfit(services: SharedService[]): number {
  return services
    .filter(service => service.status === "realizado")
    .reduce((sum, service) => sum + (service.lucroService || 0), 0);
}

// ============================================================================
// CAMADA DE ADAPTAÇÃO — sharedServices → WaitingService
//
// Os consumidores (ServiceList, OverviewPanel, PartyPanel, PartyManager,
// FriendsSummaryModal, SuggestPartyModal, ServerGraphic) recebem hoje
// `WaitingService[]`. Em vez de alterar todos eles, convertemos aqui: a
// estrutura entregue continua EXATAMENTE a mesma, então nenhuma lógica de
// filtro, contagem, prioridade ou seleção precisa mudar.
// ============================================================================

const SHARED_SERVICES_CACHE_KEY = "cloud_cache_sharedServices_all";

/**
 * Converte um Service próprio no formato consumido pelas PTs.
 *
 * Mapeamentos que merecem nota:
 *  • `addedBy` recebe o NOME do Serviceiro dono. É o campo que
 *    `canViewServiceEntry`/`canAddServiceToPT` usam para decidir quem
 *    enxerga e quem pode alocar — assim o dono continua no controle.
 *  • `dataAdicionado` reaproveita `dataService`, já no formato ISO curto.
 */
/**
 * "SERVICE PROVAVELMENTE JÁ REALIZADO"
 *
 * Reaproveita, sem duplicar, o mesmo mecanismo de "Meus Personagens": quando
 * uma PT tem a Quest concluída, `writeProbableMarkers` grava
 * `sharedCharacters/{ownerUid}.probableMarkers[<id>].<quest> = true` para cada
 * participante, usando o id do SLOT e o `ownerUid` do slot.
 *
 * Para um Service isso já funciona de graça: `sharedServiceToWaiting` usa
 * `id: service.id`, e o slot recebe `ownerUid = serviceiroUid`. Ou seja, o
 * marcador do Service cai em `probableMarkers[service.id]` no documento do
 * Serviceiro — sem precisar de coleção nova, de campo novo ou de escrita
 * adicional (que, aliás, as regras do Firestore proibiriam: só o dono pode
 * escrever em `sharedServices/{uid}`, e quem conclui a PT costuma ser outro
 * usuário).
 *
 * Um Service conta como provavelmente realizado quando existe marcador para a
 * quest DELE. Um Service de Soul War não é afetado por um marcador de
 * Sanguine, e vice-versa.
 */
export function isServiceProbablyDone(
  service: { id: string; quest?: "soulwar" | "sanguine" },
  markers: Record<string, { soulwar?: boolean; sanguine?: boolean } | undefined>,
): boolean {
  if (!service?.id) return false;
  const marker = markers?.[service.id];
  if (!marker) return false;
  const quest = service.quest === "sanguine" ? "sanguine" : "soulwar";
  return marker[quest] === true;
}

export function sharedServiceToWaiting(service: SharedService): WaitingService {
  return {
    id: service.id,
    personagem: service.personagem,
    ownerName: service.ownerName,
    servidor: service.servidor,
    voc: service.voc,
    level: service.level,
    valorCombinado: service.valorCombinado,
    dataAdicionado: service.dataService || toIsoDate(service.createdAt),
    notes: service.notes,
    whatsappCountry: service.whatsappCountry,
    whatsappArea: service.whatsappArea,
    whatsappNumber: service.whatsappNumber,
    addedBy: service.serviceiroNome || "",
    serviceiroUid: service.serviceiroUid,
    quest: service.quest,
    paymentMethod: service.paymentMethod,
    createdAt: service.createdAt,
    createdBy: service.serviceiroUid,
    createdByName: service.serviceiroNome || "",
  };
}

/**
 * Services de TODOS os Serviceiros, já no formato `WaitingService`.
 *
 * Apenas os `disponivel` são entregues: um Service realizado saiu de
 * circulação e não deve mais aparecer para montar PTs. Note que ele
 * continua existindo em `sharedServices` — diferente da Lista de Espera,
 * onde o documento era APAGADO ao concluir a Quest. É isso que faz o
 * personagem sobreviver à conclusão da PT.
 */
export function readAllSharedServicesCache(): WaitingService[] {
  try {
    const raw = localStorage.getItem(SHARED_SERVICES_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveAllSharedServicesCache(items: WaitingService[]) {
  try { localStorage.setItem(SHARED_SERVICES_CACHE_KEY, JSON.stringify(items)); } catch {}
}

/**
 * Atualiza no cache/projeção compartilhada apenas os Services de um Serviceiro.
 * Não faz leitura nem cria documento extra: a fonte persistida continua sendo
 * `sharedServices/{uid}` e a projeção retorna no formato WaitingService que a
 * PT já consome.
 */
export function replaceOwnerSharedServicesInWaitingCache(ownerUid: string, services: SharedService[]): WaitingService[] {
  const uid = String(ownerUid || "").trim();
  if (!uid) return readAllSharedServicesCache();

  const own = services
    .filter(service => service.status === "disponivel")
    .map(service => sharedServiceToWaiting({ ...service, serviceiroUid: uid }));
  const ownIds = new Set(own.map(item => item.id));
  const remaining = readAllSharedServicesCache().filter(item => item.serviceiroUid !== uid && !ownIds.has(item.id));
  const next = [...remaining, ...own];
  saveAllSharedServicesCache(next);
  return next;
}

/**
 * Lê a coleção inteira e devolve os Services disponíveis como
 * `WaitingService[]`. Uma leitura por chamada — o App a dispara junto das
 * demais sincronizações, não a cada render.
 */
export async function fetchAllSharedServicesAsWaiting(
  ownerUids: string[] = [],
): Promise<{ items: WaitingService[]; error?: string }> {
  if (!db) return { items: readAllSharedServicesCache(), error: "Firestore indisponível." };

  // As regras liberam a leitura apenas ao dono, ao Boss e aos AMIGOS do dono.
  // Um getDocs() na coleção inteira falharia por inteiro ao esbarrar no
  // primeiro documento sem permissão, então buscamos documento a documento,
  // apenas os UIDs autorizados (o próprio usuário + seus amigos).
  const uids = Array.from(new Set(ownerUids.map(uid => String(uid || "").trim()).filter(Boolean)));
  if (uids.length === 0) return { items: [] };

  try {
    const results = await Promise.allSettled(
      uids.map(uid => getDoc(doc(db!, SHARED_SERVICES_COLLECTION, uid))),
    );

    const items: WaitingService[] = [];
    results.forEach(result => {
      // Documento inexistente ou sem permissão apenas não contribui.
      if (result.status !== "fulfilled" || !result.value.exists()) return;
      const data = result.value.data() as any;
      const ownerUid = String(data?.serviceiroUid || result.value.id);
      const list = Array.isArray(data?.services) ? data.services : [];
      list.forEach((raw: any) => {
        const normalized = normalizeService(raw, ownerUid, "");
        if (!normalized) return;
        // Realizados saem de circulação para montagem de PT.
        if (normalized.status !== "disponivel") return;
        items.push(sharedServiceToWaiting(normalized));
      });
    });

    saveAllSharedServicesCache(items);
    return { items };
  } catch (error: any) {
    return { items: readAllSharedServicesCache(), error: error?.message || String(error) };
  }
}

// ============================================================================
// SOLICITAÇÕES PENDENTES — coleção `serviceRequests`
//
// O formulário público NÃO grava mais em `sharedServices`. Um pedido dirigido
// a um Serviceiro específico nasce como solicitação PENDENTE numa coleção
// própria, e só vira um Service real quando o destinatário aprova.
//
// Coleção separada (e não subcoleção de sharedServices) por dois motivos:
//   • um pedido não aprovado jamais entra na ServiceList/PTs/Sugerir PT;
//   • a consulta `where(serviceiroUid == meu uid)` é direta e barata.
// ============================================================================

export const SERVICE_REQUESTS_COLLECTION = "serviceRequests";
const REQUESTS_CACHE_PREFIX = "cloud_cache_serviceRequests_";

function requestsCacheKey(uid: string) {
  return `${REQUESTS_CACHE_PREFIX}${uid}`;
}

/**
 * Cache local das solicitações pendentes.
 *
 * Sem ele, sair e voltar à aba disparava uma nova leitura do Firestore (e,
 * pior, a tela ficava vazia até a resposta chegar). O cache é a fonte inicial
 * e é reescrito a cada leitura bem-sucedida, aprovação ou recusa.
 */
export function readServiceRequestsCache(uid: string): ServiceRequest[] {
  if (!uid) return [];
  try {
    const raw = localStorage.getItem(requestsCacheKey(uid));
    const parsed = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item: any) => normalizeRequest(item, String(item?.id || "")))
      .filter((item: ServiceRequest | null): item is ServiceRequest => item !== null);
  } catch {
    return [];
  }
}

export function saveServiceRequestsCache(uid: string, requests: ServiceRequest[]) {
  if (!uid) return;
  try { localStorage.setItem(requestsCacheKey(uid), JSON.stringify(requests)); } catch {}
}

/** Campos que o formulário público pode enviar. Nada administrativo. */
export interface PublicServiceRequest {
  personagem: string;
  ownerName: string;
  servidor: string;
  voc: Vocation;
  level: number;
  notes: string;
  whatsappCountry: string;
  whatsappArea: string;
  whatsappNumber: string;
  quest: "soulwar" | "sanguine";
  paymentMethod: ServicePaymentMethod;
}

function normalizeRequest(raw: any, id: string): ServiceRequest | null {
  const serviceiroUid = String(raw?.serviceiroUid || "").trim();
  if (!serviceiroUid) return null;
  const status: ServiceRequestStatus =
    raw?.status === "aprovado" ? "aprovado" : raw?.status === "recusado" ? "recusado" : "pendente";
  const num = (value: unknown) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  };
  return {
    id,
    personagem: String(raw?.personagem || "").trim(),
    ownerName: String(raw?.ownerName || "").trim(),
    servidor: normalizeServerName(raw?.servidor),
    voc: (raw?.voc || "EK") as Vocation,
    level: num(raw?.level),
    notes: String(raw?.notes || ""),
    whatsappCountry: String(raw?.whatsappCountry || ""),
    whatsappArea: String(raw?.whatsappArea || ""),
    whatsappNumber: String(raw?.whatsappNumber || ""),
    quest: raw?.quest === "sanguine" ? "sanguine" : "soulwar",
    paymentMethod: (["pix", "rc", "5050", "combinado"].includes(raw?.paymentMethod) ? raw.paymentMethod : "") as ServicePaymentMethod,
    serviceiroUid,
    status,
    createdAt: num(raw?.createdAt) || Date.now(),
    ...(num(raw?.decidedAt) ? { decidedAt: num(raw.decidedAt) } : {}),
    ...(raw?.approvedServiceId ? { approvedServiceId: String(raw.approvedServiceId) } : {}),
    source: "public_form",
  };
}

/** Cria a solicitação pendente para o Serviceiro escolhido. */
export async function createServiceRequest(
  serviceiroUid: string,
  request: PublicServiceRequest,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (!db) return { ok: false, error: "Firestore indisponível." };
  const uid = String(serviceiroUid || "").trim();
  if (!uid) return { ok: false, error: "Serviceiro inválido." };

  const id = createServiceId();
  try {
    await setDoc(doc(db, SERVICE_REQUESTS_COLLECTION, id), {
      id,
      personagem: request.personagem,
      ownerName: request.ownerName,
      servidor: request.servidor,
      voc: request.voc,
      level: request.level,
      notes: request.notes,
      whatsappCountry: request.whatsappCountry,
      whatsappArea: request.whatsappArea,
      whatsappNumber: request.whatsappNumber,
      quest: request.quest,
      paymentMethod: request.paymentMethod,
      serviceiroUid: uid,
      status: "pendente",
      createdAt: Date.now(),
      source: "public_form",
    });
    // Notifica o Serviceiro destinatário. Reaproveita a coleção
    // `notifications` (chaveada por `userId`), a mesma que o hook
    // useNotifications (App) já escuta — sem estrutura paralela.
    //
    // Falha aqui NÃO invalida a solicitação: o pedido já está gravado e
    // aparecerá em "Meus Services" de qualquer forma.
    try {
      await setDoc(doc(db, "notifications", `svcreq_${id}`), {
        id: `svcreq_${id}`,
        type: "service_request",
        title: "Nova solicitação de Service",
        body: `${request.personagem} — solicitação pendente de aprovação em Meus Services.`,
        status: "pending",
        userId: uid,
        createdAt: Date.now(),
      });
    } catch { /* notificação é acessória */ }

    return { ok: true, id };
  } catch (error: any) {
    return { ok: false, error: error?.message || String(error) };
  }
}

/** Solicitações dirigidas a um Serviceiro. Uma consulta indexada por UID. */
export async function fetchServiceRequests(uid: string): Promise<{ requests: ServiceRequest[]; error?: string }> {
  if (!uid) return { requests: [] };
  if (!db) return { requests: readServiceRequestsCache(uid), error: "Firestore indisponível." };
  try {
    const snap = await getDocs(
      query(collection(db, SERVICE_REQUESTS_COLLECTION), where("serviceiroUid", "==", uid)),
    );
    const requests: ServiceRequest[] = [];
    snap.forEach(docSnap => {
      const normalized = normalizeRequest(docSnap.data(), docSnap.id);
      // Aprovadas/recusadas são apagadas do Firestore; qualquer resíduo
      // de versões anteriores é ignorado aqui.
      if (normalized && normalized.status === "pendente") requests.push(normalized);
    });
    requests.sort((a, b) => b.createdAt - a.createdAt);
    saveServiceRequestsCache(uid, requests);
    return { requests };
  } catch (error: any) {
    // Falha de rede/permissão NÃO apaga o que já estava carregado.
    return { requests: readServiceRequestsCache(uid), error: error?.message || String(error) };
  }
}

/** Converte uma solicitação aprovada em Service real. */
export function requestToSharedService(request: ServiceRequest, serviceiroNome: string): SharedService {
  const now = Date.now();
  return {
    id: request.id,
    personagem: request.personagem,
    ownerName: request.ownerName,
    servidor: request.servidor,
    voc: request.voc,
    level: request.level,
    valorCombinado: resolveServiceValue(request.paymentMethod, 0),
    notes: request.notes,
    whatsappCountry: request.whatsappCountry,
    whatsappArea: request.whatsappArea,
    whatsappNumber: request.whatsappNumber,
    quest: request.quest,
    paymentMethod: request.paymentMethod,
    dataService: toIsoDate(request.createdAt),
    serviceiroUid: request.serviceiroUid,
    serviceiroNome: serviceiroNome || "",
    status: "disponivel",
    lucroService: 0,
    createdAt: request.createdAt,
    updatedAt: now,
  };
}

/**
 * Aprova a solicitação e cria o Service.
 *
 * Protegido contra duplicação em três camadas:
 *   1. rejeita se o status já não for "pendente";
 *   2. rejeita se o id já existir no array do dono;
 *   3. grava `approvedServiceId` no pedido, deixando a decisão registrada.
 */
export async function approveServiceRequest(params: {
  request: ServiceRequest;
  viewerUid: string;
  serviceiroNome: string;
  current: SharedService[];
}): Promise<{ ok: boolean; services?: SharedService[]; error?: string }> {
  const { request, viewerUid, serviceiroNome, current } = params;
  if (!db) return { ok: false, error: "Firestore indisponível." };
  // Revalida o destinatário no momento da ação.
  if (!viewerUid || request.serviceiroUid !== viewerUid) {
    return { ok: false, error: "Somente o Serviceiro destinatário pode aprovar." };
  }
  // Guarda contra duplicação: o Service herda o id do pedido, então se ele
  // já existe a aprovação já aconteceu.
  if (current.some(item => item.id === request.id)) {
    return { ok: false, error: "Este Service já foi criado." };
  }

  const created = requestToSharedService(request, serviceiroNome);
  const merged = [created, ...current];

  // 1º grava o Service. Só depois remove o pedido — se a ordem fosse
  // inversa e a gravação falhasse, a solicitação se perderia.
  const persisted = await persistSharedServices(viewerUid, merged);
  if (!persisted.ok) return { ok: false, error: persisted.error };

  try {
    await deleteDoc(doc(db, SERVICE_REQUESTS_COLLECTION, request.id));
  } catch {
    // O Service já existe e é o que importa. Um resíduo do pedido é
    // inofensivo: a guarda por id impede recriar na próxima tentativa.
  }
  return { ok: true, services: merged };
}

/**
 * Recusa a solicitação: apenas apaga o pedido.
 *
 * Nada é criado em `sharedServices` e, nesta etapa, não se guarda
 * histórico de recusados.
 */
export async function rejectServiceRequest(params: {
  request: ServiceRequest;
  viewerUid: string;
}): Promise<{ ok: boolean; error?: string }> {
  const { request, viewerUid } = params;
  if (!db) return { ok: false, error: "Firestore indisponível." };
  if (!viewerUid || request.serviceiroUid !== viewerUid) {
    return { ok: false, error: "Somente o Serviceiro destinatário pode recusar." };
  }
  try {
    await deleteDoc(doc(db, SERVICE_REQUESTS_COLLECTION, request.id));
    return { ok: true };
  } catch (error: any) {
    return { ok: false, error: error?.message || String(error) };
  }
}

/**
 * Listener em tempo real das solicitações pendentes do Serviceiro.
 *
 * UMA inscrição por usuário, na única consulta que precisa ser reativa
 * (`serviceRequests` filtrado por `serviceiroUid`). Os Services em si
 * continuam vindo de leitura pontual + cache, sem listener.
 *
 * O cache é reescrito a cada emissão, então trocar de aba não custa leitura
 * e os últimos dados válidos sobrevivem a uma falha posterior.
 *
 * Devolve a função de cancelamento — o chamador DEVE invocá-la ao desmontar.
 */
export function subscribeServiceRequests(
  uid: string,
  onChange: (requests: ServiceRequest[]) => void,
  onError?: (message: string) => void,
): () => void {
  if (!db || !uid) return () => {};
  try {
    const q = query(collection(db, SERVICE_REQUESTS_COLLECTION), where("serviceiroUid", "==", uid));
    return onSnapshot(
      q,
      snap => {
        const requests: ServiceRequest[] = [];
        snap.forEach(docSnap => {
          const normalized = normalizeRequest(docSnap.data(), docSnap.id);
          if (normalized && normalized.status === "pendente") requests.push(normalized);
        });
        requests.sort((a, b) => b.createdAt - a.createdAt);
        saveServiceRequestsCache(uid, requests);
        onChange(requests);
      },
      error => {
        // Erro NÃO limpa a tela: o cache já carregado permanece.
        onError?.(error?.message || String(error));
      },
    );
  } catch (error: any) {
    onError?.(error?.message || String(error));
    return () => {};
  }
}