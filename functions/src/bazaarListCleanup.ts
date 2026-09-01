import { getApps, initializeApp } from "firebase-admin/app";
import { FieldPath, getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { onDocumentWritten } from "firebase-functions/v2/firestore";

if (getApps().length === 0) {
  initializeApp();
}

// ============================================================================
// LIMPEZA GLOBAL DA CONSULTA ANTERIOR DO BAZAAR — disparada pela publicação.
// ============================================================================
//
// Por que é uma Cloud Function (e não código no cliente que publicou):
// a publicação parte do Boss, mas a limpeza é GLOBAL e precisa acontecer
// mesmo se o cliente do Boss cair logo após o commit, e independentemente de
// outros usuários estarem online. Um trigger em `bazaar/current` roda no
// servidor no mesmo instante da escrita, sempre.
//
// O que ela limpa a cada NOVA lista publicada (versão diferente da anterior):
//   1. Marcadores `notifyState/bazaar_ending_*` — resíduo do antigo watcher
//      de encerramento (removido: o alerta agora é agendado no dispositivo).
//   2. Notificações `notifications` do tipo `bazaar_interest_ending` ainda
//      pendentes — avisos de leilões que deixaram de existir com a rotação
//      diária; sem dono que os leia a tempo, viram lixo nas listas.
//
// O ZERAMENTO dos interesses (`bazaarInterests/current`) acontece no MESMO
// batch da publicação (bazaarOfficialService.ts) — não aqui.
//
// Custo: uma execução por publicação (~1×/dia), leituras/escritas pontuais e
// limitadas (lotes de até 450 exclusões, teto de 5 lotes por alvo).
// ============================================================================

const firestore = getFirestore();

const NOTIFY_STATE_COLLECTION = "notifyState";
const NOTIFICATIONS_COLLECTION = "notifications";

/** Prefixo dos marcadores do antigo watcher de leilões. */
const BAZAAR_ENDING_MARKER_PREFIX = "bazaar_ending_";

/** Teto por execução — lotes de até 450 (limite do Firestore é 500). */
const MAX_DOCS_PER_TARGET = 450 * 5;

async function deleteInBatches(
  refs: FirebaseFirestore.DocumentReference[],
  label: string,
): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < refs.length; i += 450) {
    const slice = refs.slice(i, i + 450);
    const batch = firestore.batch();
    slice.forEach(ref => batch.delete(ref));
    await batch.commit();
    deleted += slice.length;
  }
  if (deleted > 0) logger.info(`Bazaar: limpeza de ${label}`, { deleted });
  return deleted;
}

export const bazaarListCleanup = onDocumentWritten(
  { document: "bazaar/current" },
  async event => {
    const beforeVersion = String(event.data?.before?.data()?.version || "");
    const afterVersion = String(event.data?.after?.data()?.version || "");
    if (!afterVersion) return; // documento removido: nada a limpar
    if (beforeVersion === afterVersion) return; // mesma versão: não rotacionou

    // 1. Marcadores do antigo watcher (consulta por PREFIXO do id do doc).
    try {
      const prefixUpper = BAZAAR_ENDING_MARKER_PREFIX + "\uf8ff";
      const markerSnap = await firestore
        .collection(NOTIFY_STATE_COLLECTION)
        .where(FieldPath.documentId(), ">=", BAZAAR_ENDING_MARKER_PREFIX)
        .where(FieldPath.documentId(), "<", prefixUpper)
        .limit(MAX_DOCS_PER_TARGET)
        .get();
      await deleteInBatches(markerSnap.docs.map(doc => doc.ref), "marcadores bazaar_ending");
    } catch (error) {
      logger.warn("Bazaar: falha ao limpar marcadores antigos", { error: String(error) });
    }

    // 2. Notificações pendentes de encerramento da consulta anterior.
    try {
      const notifSnap = await firestore
        .collection(NOTIFICATIONS_COLLECTION)
        .where("type", "==", "bazaar_interest_ending")
        .limit(MAX_DOCS_PER_TARGET)
        .get();
      await deleteInBatches(notifSnap.docs.map(doc => doc.ref), "notificações de encerramento antigas");
    } catch (error) {
      logger.warn("Bazaar: falha ao limpar notificações antigas", { error: String(error) });
    }
  },
);