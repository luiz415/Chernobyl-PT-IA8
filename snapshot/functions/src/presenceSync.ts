import { onValueWritten } from "firebase-functions/v2/database";
import { logger } from "firebase-functions";
import { getApps, initializeApp } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import {
  countOnlineUsers,
  isCountRelevantConnChange,
  type PresenceConn,
  type PresenceStatusTree,
} from "./presenceCore.js";

if (getApps().length === 0) {
  initializeApp();
}

// ============================================================================
// PRESENCE SYNC — contador de usuários online (RTDB → Firestore)
// ============================================================================
//
// ARQUITETURA (prioridade: ECONOMIA de consumo do Firestore):
//   Cliente ──► RTDB status/{uid}/conns/{connId} (+ onDisconnect no servidor
//               + HEARTBEAT `hb` a cada 4 min — ver presenceCore.ts)
//           ──► ESTE trigger (dispara quando UMA conexão muda)
//           ──► Firestore presence/count { onlineCount } — escrito SOMENTE
//               quando o total realmente muda.
//   Clientes leem presence/count por POLLING de 10 min (1 read) — SEM listener.
//
// MUDANÇAS DA AUDITORIA DE PRESENÇA (falsos "Online" por dias):
//   • O trigger desceu de `/status/{uid}` para `/status/{uid}/conns/{connId}`:
//     com o heartbeat, a imensa maioria dos eventos é "só hb mudou" — o
//     before/after da PRÓPRIA conexão permite detectar isso e RETORNAR CEDO
//     sem nenhuma leitura (custo ~zero por invocação de heartbeat). As
//     gravações de metadados (`name`/`lastSeen`/`lastLoginAt`) deixaram de
//     disparar o trigger — elas nunca mudam o total.
//   • A contagem agora usa a regra única de `presenceCore.ts`: online ⇔
//     ≥1 conexão com `active !== false` E heartbeat FRESCO (15 min).
//     Conexões órfãs (onDisconnect que falhou) deixam de inflar o contador
//     mesmo ANTES de a limpeza agendada (`presenceCleanup`) removê-las.
//
// POR QUE É BARATO:
//   • presença bruta vive no RTDB → zero custo por operação;
//   • heartbeats retornam cedo SEM ler nada; transições reais (login/
//     logout/queda/ocioso/limpeza) recontam com UMA leitura RTDB (grátis);
//   • o Firestore só recebe 1 write quando `onlineCount` muda de valor;
//   • nenhuma coleção Firestore é varrida por ninguém (a antiga coleção
//     `presence/{uid}` foi aposentada — só o doc `presence/count` resta).
//
// REGIÃO: o RTDB do projeto vive em us-central1 (o RTDB não existe em
// southamerica-east1) e triggers de RTDB DEVEM rodar na região da instância.
// O write em presence/count atravessa regiões (~1 write raro — irrelevante).
//
// IDEMPOTÊNCIA / CONCORRÊNCIA: o total é recontado do zero a cada execução
// (fonte = RTDB inteiro, não deltas) e a escrita compara com o valor já
// persistido — reexecuções ou eventos fora de ordem convergem sozinhos.
// `maxInstances: 1` serializa rajadas e evita corridas de escrita.
// ============================================================================

export const presenceSync = onValueWritten(
  {
    ref: "/status/{uid}/conns/{connId}",
    region: "us-central1",
    maxInstances: 1,
    memory: "256MiB",
    timeoutSeconds: 30,
  },
  async event => {
    const changedUid = event.params.uid;

    // 0) HEARTBEAT PERIÓDICO? (conexão existia antes e depois com o mesmo
    //    estado ativo/ocioso → só `hb` mudou) — nada a recontar, custo zero.
    const before = (event.data.before.val() || null) as PresenceConn | null;
    const after = (event.data.after.val() || null) as PresenceConn | null;
    if (!isCountRelevantConnChange(before, after)) {
      return;
    }

    // 1) Reconta o total no RTDB (leitura gratuita, fonte da verdade) com a
    //    regra única (ativa E fresca — presenceCore.ts).
    const statusSnap = await getDatabase().ref("status").get();
    const status = (statusSnap.val() || {}) as PresenceStatusTree;
    const onlineCount = countOnlineUsers(status, Date.now());

    // 2) Compara com o último total publicado — guardado no PRÓPRIO RTDB
    //    (meta/onlineCount), para que invocações sem mudança de total não
    //    custem NENHUMA operação de Firestore (nem read, nem write).
    const metaRef = getDatabase().ref("meta/onlineCount");
    const previousSnap = await metaRef.get();
    const previous = previousSnap.exists() ? Number(previousSnap.val()) : null;

    if (previous === onlineCount) {
      logger.debug("presenceSync: total inalterado, sem escrita", { changedUid, onlineCount });
      return;
    }

    // 3) Publica: memória no RTDB + doc agregado no Firestore (1 write,
    //    somente nas transições reais do total).
    await metaRef.set(onlineCount);
    await getFirestore().collection("presence").doc("count").set(
      {
        onlineCount,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    logger.info("presenceSync: contador atualizado", { changedUid, previous, onlineCount });
  },
);
