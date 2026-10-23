import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions";
import { getApps, initializeApp } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";
import { planPresenceCleanup, type PresenceStatusTree } from "./presenceCore.js";

if (getApps().length === 0) {
  initializeApp();
}

// ============================================================================
// PRESENCE CLEANUP — varredura agendada das conexões de presença EXPIRADAS
// ============================================================================
//
// POR QUE EXISTE (auditoria dos falsos "Online"): o onDisconnect do RTDB é a
// limpeza IMEDIATA, mas não é garantido — quando ele falha (corrida no
// logout, socket que morre antes de o arm chegar ao servidor, conexão
// fantasma), a conexão fica órfã em `status/{uid}/conns` para sempre. Nenhum
// CLIENTE pode removê-la (as regras do RTDB só permitem a cada uid escrever
// no próprio nó, e não há cliente garantidamente aberto) — a remoção
// confiável precisa ser server-side e periódica. Esta função é essa rede de
// segurança final.
//
// O QUE FAZ: a cada 15 minutos lê a árvore `status` (RTDB — leitura
// gratuita, nó pequeno) e aplica o plano puro de `presenceCore.ts`:
//   • REMOVE conexões expiradas — sem heartbeat fresco (15 min) ou, para
//     conexões legadas sem `hb`, com `since` além de 24h (transição);
//   • PRESERVA o "Visto por último": grava em `status/{uid}/lastSeen` o
//     maior sinal de vida das conexões removidas quando for mais recente
//     que o registrado (o dado que o onDisconnect falhou em gravar);
//   • NUNCA toca em conexões frescas, `name`, `lastLoginAt`, nós de outros
//     usuários nem em QUALQUER dado do Firestore.
//
// A PRIMEIRA execução após o deploy corrige o passivo acumulado: todas as
// órfãs antigas (dias parados) somem de uma vez — e cada remoção dispara o
// trigger `presenceSync`, que reconta e corrige o doc `presence/count`.
//
// CUSTO: 96 execuções/dia (1 a cada 15 min), cada uma com UMA leitura RTDB
// (grátis; bytes de poucos KB) e UM update multi-path apenas quando há algo
// a limpar (regime normal: plano vazio → zero escritas). Nenhuma operação
// de Firestore nesta função.
//
// REGIÃO: us-central1, junto da instância RTDB (southamerica-east1 não tem
// RTDB) — evita tráfego inter-região da leitura periódica.
//
// IDEMPOTÊNCIA / CONCORRÊNCIA: o plano é determinístico sobre o snapshot
// lido; aplicá-lo duas vezes converge (remover nó ausente é no-op). O update
// multi-path é ATÔMICO no RTDB. `maxInstances: 1` impede execuções
// sobrepostas. Corrida benigna com uma reconexão simultânea: se o cliente
// recriar a conexão (set completo com hb novo) após a leitura, a remoção
// desta rodada pode apagá-la — o `.info/connected` do cliente permanece
// conectado e o PRÓXIMO heartbeat/evento a recria; na prática a janela é de
// milissegundos sobre uma conexão que já estava >15 min sem heartbeat.
// ============================================================================

export const presenceCleanup = onSchedule(
  {
    schedule: "every 15 minutes",
    timeZone: "America/Sao_Paulo",
    region: "us-central1",
    maxInstances: 1,
    memory: "256MiB",
    timeoutSeconds: 60,
  },
  async () => {
    const db = getDatabase();
    const statusSnap = await db.ref("status").get();
    const status = (statusSnap.val() || {}) as PresenceStatusTree;

    const plan = planPresenceCleanup(status, Date.now());
    if (plan.removals.length === 0 && Object.keys(plan.lastSeenUpdates).length === 0) {
      logger.debug("presenceCleanup: nada a limpar");
      return;
    }

    // UM update multi-path atômico: conexões expiradas → null (remoção) +
    // lastSeen resgatado dos heartbeats das conexões removidas.
    const updates: Record<string, unknown> = {};
    for (const path of plan.removals) updates[path] = null;
    for (const uid of Object.keys(plan.lastSeenUpdates)) {
      updates[`status/${uid}/lastSeen`] = plan.lastSeenUpdates[uid];
    }
    await db.ref().update(updates);

    logger.info("presenceCleanup: conexões expiradas removidas", {
      removedConns: plan.removals.length,
      lastSeenRecovered: Object.keys(plan.lastSeenUpdates).length,
    });
  },
);
