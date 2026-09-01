import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { onSchedule } from "firebase-functions/v2/scheduler";
import {
  buildMonthSnapshotEntries,
  buildMonthlyDocFromUserStats,
  getPreviousMonthKey,
  getUtcMonthKey,
  listMonthsToArchive,
  monthlyDocNeedsRewrite,
  type RankingHistoryEntry,
} from "./rankingCore.js";

/**
 * RESET MENSAL DO RANKING — Cloud Function agendada.
 * ============================================================================
 *
 * Roda TODOS os dias às 00:20 UTC (20 minutos de folga para commits de stats
 * de PTs concluídas no fim do dia anterior assentarem — o dayKey vem do
 * questFinalizedAt, então PTs concluídas às 23:59 entram no mês certo mesmo
 * materializadas pouco depois da meia-noite).
 *
 * O trabalho real é PORTADO DO MESMO LÓGICA do `ensureMonthlyRankingReset`
 * do frontend (rankingResetService.ts), que continua existindo como fallback
 * (Boss abre o painel). As duas partes são idempotentes entre si: mesmos
 * metadados (`settings/ranking_reset`), mesmos gates (histórico antigo nunca
 * é sobrescrito; metadado avança em transação que revalida o mês).
 *
 * Por execução:
 *   1. Lê `settings/ranking_reset` (1 leitura) — mês já resetado → só
 *      reconcilia o mês corrente.
 *   2. Lê TODOS os `userStats` (N leituras) — base única para reconciliação
 *      e snapshots.
 *   3. RECONCILIA `rankingMonthly/{mês corrente}/users/{uid}`: reconstrói o
 *      valor absoluto a partir de `dailyStats` e só escreve o que mudou.
 *      Cache autocorrigível: qualquer divergência (fallback do frontend,
 *      escrita atrasada, falha) desaparece no dia seguinte.
 *   4. Se o mês mudou: arquedia `rankingHistory/{mês}` de TODOS os meses
 *      ainda não arquivados desde o último reset (fecha lacunas), grava o
 *      snapshot apenas quando há entradas e então avança os metadados em
 *      transação com revalidação do mês.
 *
 * Custos típicos (comunidade pequena): 1 + 2N leituras/dia, escritas apenas
 * quando há mudança real. Com app fechado: o reset acontece do mesmo jeito —
 * não depende de usuário algum.
 */

const firestore = getFirestore();
const SETTINGS_COLLECTION = "settings";
const RANKING_RESET_SETTINGS_ID = "ranking_reset";
const USER_STATS_COLLECTION = "userStats";
const RANKING_MONTHLY_COLLECTION = "rankingMonthly";
const RANKING_HISTORY_COLLECTION = "rankingHistory";
const MONTHLY_USERS_SUBCOLLECTION = "users";
const USERS_COLLECTION = "users";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export const scheduledRankingReset = onSchedule(
  {
    schedule: "20 0 * * *",
    timeZone: "UTC",
  },
  async () => {
    const currentMonthKey = getUtcMonthKey(new Date());
    const previousMonthKey = getPreviousMonthKey(currentMonthKey);
    const settingsRef = firestore.collection(SETTINGS_COLLECTION).doc(RANKING_RESET_SETTINGS_ID);

    // 1. Metadados atuais (1 leitura).
    const metaSnap = await settingsRef.get();
    const meta = metaSnap.exists ? record(metaSnap.data()) : {};
    const alreadyReset = String(meta.lastRankingResetMonth || "") === currentMonthKey;

    // 2. Base única: todos os userStats (N leituras).
    const statsSnap = await firestore.collection(USER_STATS_COLLECTION).get();
    const statsDocs = statsSnap.docs.map(docSnap => ({ uid: docSnap.id, data: record(docSnap.data()) }));

    // 3. Reconciliação do mês corrente — valor absoluto a partir de dailyStats.
    const monthDocRef = firestore.collection(RANKING_MONTHLY_COLLECTION).doc(currentMonthKey);
    const monthlyUsersRef = monthDocRef.collection(MONTHLY_USERS_SUBCOLLECTION);
    const existingMonthly = await monthlyUsersRef.get();
    const existingByUid = new Map<string, Record<string, unknown>>();
    existingMonthly.forEach(docSnap => existingByUid.set(docSnap.id, record(docSnap.data())));

    let monthlyWritten = 0;
    const writeBatch = firestore.batch();
    statsDocs.forEach(({ uid, data }) => {
      const desired = buildMonthlyDocFromUserStats(uid, data, currentMonthKey);
      const existing = existingByUid.get(uid);
      if (!desired) {
        // Sem atividade no mês corrente e sem fallback legado: sem doc.
        // (Doc legado antigo, se existir, é removido — o usuário passou a ter
        // histórico diário e o quadro mensal volta a mostrar só o período.)
        if (existing && existing.legacy === true) {
          writeBatch.delete(monthlyUsersRef.doc(uid));
          monthlyWritten += 1;
        }
        return;
      }
      if (monthlyDocNeedsRewrite(existing, desired)) {
        writeBatch.set(monthlyUsersRef.doc(uid), { ...desired, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        monthlyWritten += 1;
      }
    });
    if (monthlyWritten > 0) {
      // Doc pai do mês (apenas observabilidade no console; subcoleções não o
      // exigem). merge preserva createdAt da primeira escrita.
      writeBatch.set(monthDocRef, {
        monthKey: currentMonthKey,
        createdAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      await writeBatch.commit();
    }

    // Flag de migração: o painel passa a confiar em rankingMonthly (mesmo
    // vazia em mês sem atividade) depois da primeira reconciliação bem
    // sucedida. Antes disso o painel usa o caminho legado (userStats).
    if (meta.rankingMonthlyActive !== true) {
      await settingsRef.set({ rankingMonthlyActive: true }, { merge: true });
    }

    let archivedMonths: string[] = [];
    let resetClaimed = false;

    // 4. Reset do mês — apenas quando o mês corrente ainda não foi marcado.
    if (!alreadyReset) {
      // Meses a arquivar: do último reset até o mês anterior ao corrente.
      const historySnap = await firestore.collection(RANKING_HISTORY_COLLECTION).get();
      const archived = new Set(historySnap.docs.map(docSnap => docSnap.id));
      const monthsToArchive = listMonthsToArchive(
        String(meta.lastRankingResetMonth || ""),
        currentMonthKey,
        archived,
      );

      if (monthsToArchive.length > 0) {
        // Nomes para o snapshot (mesma fonte do frontend: usuários aprovados).
        const usersSnap = await firestore.collection(USERS_COLLECTION)
          .where("status", "==", "aprovado")
          .get();
        const uidToName = new Map<string, string>();
        usersSnap.forEach(docSnap => {
          const nome = String(record(docSnap.data()).nome || "").trim();
          if (nome) uidToName.set(docSnap.id, nome);
        });

        for (const monthKey of monthsToArchive) {
          const entries: RankingHistoryEntry[] = buildMonthSnapshotEntries(statsDocs, monthKey, uidToName);
          if (entries.length === 0) continue; // mês sem atividade: sem snapshot
          await firestore.collection(RANKING_HISTORY_COLLECTION).doc(monthKey).set({
            monthKey,
            entries,
            totalPlayers: entries.length,
            generatedAtMs: Date.now(),
            generatedByUid: "scheduled_ranking_reset",
            generatedAt: FieldValue.serverTimestamp(),
          });
          archivedMonths.push(monthKey);
        }
      }

      // Metadados — transação revalida o mês (impede avanço duplicado em
      // concorrência com o fallback do frontend/Boss).
      await firestore.runTransaction(async transaction => {
        const snap = await transaction.get(settingsRef);
        const current = snap.exists ? record(snap.data()) : null;
        if (String(current?.lastRankingResetMonth || "") === currentMonthKey) return; // outro escritor ganhou.
        const payload: Record<string, unknown> = {
          lastRankingResetMonth: currentMonthKey,
          lastRankingResetAt: FieldValue.serverTimestamp(),
          lastRankingResetAtMs: Date.now(),
        };
        const latestArchived = archivedMonths[archivedMonths.length - 1];
        if (latestArchived) payload.lastHistoryMonth = latestArchived;
        if (!current?.firstRankingReset) {
          payload.firstRankingReset = true;
          payload.firstRankingResetAt = FieldValue.serverTimestamp();
        }
        transaction.set(settingsRef, payload, { merge: true });
        resetClaimed = true;
      });
    }

    logger.info("ranking daily maintenance done", {
      currentMonthKey,
      previousMonthKey,
      statsDocs: statsDocs.length,
      monthlyWritten,
      archivedMonths,
      resetClaimed,
      alreadyReset,
    });
  },
);