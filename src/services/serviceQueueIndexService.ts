import { deleteDoc, doc, getDoc, setDoc, writeBatch } from "firebase/firestore";
import { db } from "../firebase/config";
import { serverKey } from "../constants/servers";

// ============================================================================
// ÍNDICE ANTI-DUPLICADO DA FILA DE SERVICES — coleção `serviceQueueIndex`
//
// PROBLEMA: o Formulário Público permitia cadastrar o MESMO personagem várias
// vezes (na fila do Boss, na de um Serviceiro, ou nas duas), porque nenhuma
// verificação global existia — e uma verificação "por consulta" no cliente
// seria impossível (o cliente é anônimo e não pode ler `sharedServices` nem
// `serviceRequests` de outros usuários) e insegura (condição de corrida entre
// dois envios quase simultâneos).
//
// SOLUÇÃO: um documento-índice por personagem na fila, com ID DETERMINÍSTICO
// derivado do nome normalizado + servidor. A unicidade é garantida pelo
// PRÓPRIO Firestore:
//
//   • as regras da coleção permitem apenas `create` (update: false);
//   • o envio do formulário grava índice + pedido num ÚNICO WriteBatch
//     (atômico). Se o índice já existir, o `set` vira update → negado pelas
//     regras → o batch INTEIRO falha e NADA é criado (nem notificação);
//   • em dois envios simultâneos, o servidor serializa os commits: o segundo
//     encontra o documento criado pelo primeiro e falha. Exatamente UM vence.
//
// Isso dispensa Cloud Function: as regras JÁ SÃO a validação de backend, sem
// latência de cold start nem dependência de deploy adicional de função.
//
// IDENTIDADE DO PERSONAGEM: `servidor + nome`, ambos normalizados (minúsculas,
// trim, espaços internos colapsados; servidor via serverKey, que também
// resolve aliases históricos). Dois personagens homônimos em servidores
// DIFERENTES são personagens diferentes e não se bloqueiam.
//
// CICLO DE VIDA da chave: criada no envio do formulário (ou no cadastro
// manual, best-effort); liberada quando o Service é concluído (realizado),
// excluído ou a solicitação é recusada. Enquanto o personagem está na fila,
// a chave existe e novos envios são bloqueados.
//
// LEGADO: registros criados ANTES deste índice não têm chave. Eles NÃO são
// apagados nem alterados; o backfill best-effort (chamado pelos painéis do
// dono ao carregar as listas) cria as chaves que faltam, sem nenhuma perda
// de dados.
// ============================================================================

export const SERVICE_QUEUE_INDEX_COLLECTION = "serviceQueueIndex";

/** Mensagem exibida ao cliente quando o personagem já está na fila. */
export const DUPLICATE_SERVICE_MESSAGE =
  "Este personagem já está na fila para a realização do Service.";

/**
 * Normaliza o nome do personagem para comparação: minúsculas, sem espaços
 * nas pontas, espaços internos colapsados e forma Unicode canônica (NFC).
 * "  Sir  KNIGHT " e "sir knight" produzem a MESMA chave.
 */
export function normalizeCharacterName(name: string | null | undefined): string {
  return String(name || "")
    .normalize("NFC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * Chave determinística do personagem na fila: `servidor__nome`, normalizados.
 * Serve de ID do documento-índice — "/" é substituído por segurança (IDs do
 * Firestore não aceitam barra), embora nomes válidos nunca o contenham.
 */
export function buildServiceQueueKey(personagem: string, servidor: string): string {
  const name = normalizeCharacterName(personagem).replace(/\//g, "_");
  if (!name) return "";
  const server = serverKey(servidor).replace(/\//g, "_");
  return server ? `${server}__${name}` : name;
}

export interface ServiceQueueEntryInput {
  personagem: string;
  servidor: string;
  quest: "soulwar" | "sanguine";
  /** ID do registro que originou a chave (request/waiting/service). */
  refId: string;
  refKind: "request" | "waiting" | "service";
}

/** Payload mínimo do documento-índice — nada sensível (sem WhatsApp/nome do cliente). */
function queueEntryData(key: string, input: ServiceQueueEntryInput): Record<string, unknown> {
  return {
    key,
    personagem: String(input.personagem || "").trim(),
    servidor: String(input.servidor || "").trim(),
    quest: input.quest === "sanguine" ? "sanguine" : "soulwar",
    refId: String(input.refId || ""),
    refKind: input.refKind,
    createdAt: Date.now(),
  };
}

/**
 * Verifica se a chave já existe. Erro de rede/permissão conta como "não
 * existe" — a barreira REAL é o batch atômico, esta leitura só antecipa o
 * feedback amigável.
 */
export async function serviceQueueKeyExists(key: string): Promise<boolean> {
  if (!db || !key) return false;
  try {
    const snap = await getDoc(doc(db, SERVICE_QUEUE_INDEX_COLLECTION, key));
    return snap.exists();
  } catch {
    return false;
  }
}

/**
 * Cria o registro de destino (serviceRequests/waitingList) JUNTO com a chave
 * do índice, num único WriteBatch atômico — a proteção contra duplicados e
 * contra corrida do Formulário Público.
 *
 * Resultado:
 *   • ok           → registro criado (com ou sem índice — ver fallback);
 *   • duplicate    → personagem já está na fila; NADA foi criado;
 *   • error        → falha real (rede etc.); NADA foi criado.
 *
 * FALLBACK DE COMPATIBILIDADE: se o batch falhar e a chave NÃO existir
 * (tipicamente: regras do `serviceQueueIndex` ainda não publicadas no
 * Firebase), o registro é criado sozinho, como antes desta proteção — o
 * formulário nunca quebra por causa do índice.
 */
export async function createWithQueueGuard(params: {
  entry: ServiceQueueEntryInput;
  targetCollection: string;
  targetId: string;
  targetData: Record<string, unknown>;
}): Promise<{ ok: boolean; duplicate?: boolean; error?: string }> {
  const { entry, targetCollection, targetId, targetData } = params;
  if (!db) return { ok: false, error: "Firestore indisponível." };

  const key = buildServiceQueueKey(entry.personagem, entry.servidor);
  const targetRef = doc(db, targetCollection, targetId);

  // Sem chave válida (nome vazio — não deve ocorrer, o form valida antes):
  // grava sem guarda, preservando o comportamento anterior.
  if (!key) {
    try {
      await setDoc(targetRef, targetData);
      return { ok: true };
    } catch (error: any) {
      return { ok: false, error: error?.message || String(error) };
    }
  }

  const keyRef = doc(db, SERVICE_QUEUE_INDEX_COLLECTION, key);

  // 1. Pré-checagem: feedback imediato e elegante, sem tentar gravar.
  if (await serviceQueueKeyExists(key)) {
    return { ok: false, duplicate: true };
  }

  // 2. Batch atômico: índice + registro. É ELE que fecha a corrida — se dois
  //    envios passarem juntos pela pré-checagem, só o primeiro commit vence.
  try {
    const batch = writeBatch(db);
    batch.set(keyRef, queueEntryData(key, entry));
    batch.set(targetRef, targetData);
    await batch.commit();
    return { ok: true };
  } catch (batchError: any) {
    // 3. O batch falhou. Se a chave EXISTE, perdemos a corrida → duplicado.
    if (await serviceQueueKeyExists(key)) {
      return { ok: false, duplicate: true };
    }
    // 4. Chave não existe (ou não pôde ser lida): regras do índice ainda não
    //    publicadas ou falha transitória. Cria o registro sozinho para não
    //    quebrar o formulário (comportamento idêntico ao anterior).
    try {
      await setDoc(targetRef, targetData);
      console.warn(
        "[serviceQueueIndex] Registro criado SEM chave de índice (regras ainda não publicadas?):",
        batchError?.message || batchError,
      );
      return { ok: true };
    } catch (error: any) {
      return { ok: false, error: error?.message || String(error) };
    }
  }
}

/**
 * Registra a chave de um personagem que entrou na fila por fluxo INTERNO
 * (cadastro manual em "Meus Services" ou na Lista de Espera do Boss).
 * Best-effort: se a chave já existir (ou as regras ainda não estiverem
 * publicadas), a falha é silenciosa — o fluxo interno nunca é bloqueado.
 */
export async function registerServiceQueueEntry(input: ServiceQueueEntryInput): Promise<void> {
  if (!db) return;
  const key = buildServiceQueueKey(input.personagem, input.servidor);
  if (!key) return;
  try {
    await setDoc(doc(db, SERVICE_QUEUE_INDEX_COLLECTION, key), queueEntryData(key, input));
  } catch {
    // Chave já existe (update é proibido pelas regras) ou regras pendentes.
  }
}

/**
 * Libera a chave quando o personagem SAI da fila (Service concluído/excluído,
 * solicitação recusada, item da Lista de Espera removido/realizado).
 * Best-effort e idempotente: apagar chave inexistente não é erro.
 */
export async function freeServiceQueueEntry(personagem: string, servidor: string): Promise<void> {
  if (!db) return;
  const key = buildServiceQueueKey(personagem, servidor);
  if (!key) return;
  try {
    await deleteDoc(doc(db, SERVICE_QUEUE_INDEX_COLLECTION, key));
  } catch {
    // Sem permissão/rede: a chave residual só bloqueia novos envios até ser
    // liberada numa próxima conclusão/exclusão — nunca corrompe dados.
  }
}

/**
 * BACKFILL dos registros legados (criados antes do índice existir): garante
 * uma chave para cada personagem já na fila, tornando o bloqueio efetivo
 * também contra o histórico. Roda UMA vez por dispositivo/escopo (flag em
 * localStorage), com escritas best-effort — chaves que já existem apenas
 * falham silenciosamente (create-only), sem custo de leitura.
 *
 * NUNCA apaga nem altera registros existentes — apenas cria chaves ausentes.
 */
export async function backfillServiceQueueEntries(
  flagScope: string,
  entries: ServiceQueueEntryInput[],
): Promise<void> {
  if (!db) return;
  const flagKey = `service_queue_backfill_v1.${flagScope || "anon"}`;
  try {
    if (localStorage.getItem(flagKey) === "done") return;
  } catch {}

  const seen = new Set<string>();
  const unique = entries.filter(entry => {
    const key = buildServiceQueueKey(entry.personagem, entry.servidor);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  await Promise.allSettled(unique.map(entry => registerServiceQueueEntry(entry)));

  try { localStorage.setItem(flagKey, "done"); } catch {}
}
