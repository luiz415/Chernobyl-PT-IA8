import { onValueWritten } from "firebase-functions/v2/database";
import { logger } from "firebase-functions";
import { getApps, initializeApp } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

if (getApps().length === 0) {
  initializeApp();
}

// ============================================================================
// PRESENCE SYNC — contador de usuários online (RTDB → Firestore)
// ============================================================================
//
// ARQUITETURA (prioridade: ECONOMIA de consumo do Firestore):
//   Cliente ──► RTDB status/{uid}/conns/{connId} (+ onDisconnect no servidor)
//           ──► ESTE trigger (dispara SÓ quando o nó de um uid muda:
//               conexão aberta/fechada ou flag de ociosidade)
//           ──► Firestore presence/count { onlineCount } — escrito SOMENTE
//               quando o total realmente muda.
//   Clientes leem presence/count por POLLING de 10 min (1 read) — SEM listener.
//
// POR QUE É BARATO:
//   • presença bruta vive no RTDB → zero custo por operação;
//   • o trigger roda apenas em transições (login/logout/queda/ocioso) —
//     nunca em intervalos; sem usuários mudando, zero invocações;
//   • a leitura do total é feita no RTDB (grátis); o Firestore só recebe
//     1 write quando `onlineCount` muda de valor;
//   • nenhuma coleção Firestore é varrida por ninguém (a antiga coleção
//     `presence/{uid}` foi aposentada — só o doc `presence/count` resta).
//
// SEMÂNTICA DE ONLINE: uid online ⇔ status/{uid}/conns tem ≥1 conexão com
// `active !== false`. Múltiplas abas/dispositivos contam UMA vez. A flag
// `active:false` é a ociosidade (6 min sem atividade, marcada pelo cliente);
// a REMOÇÃO da conexão é a desconexão (feita pelo servidor via onDisconnect
// em fechamento abrupto, ou pelo cliente em logout limpo).
//
// REGIÃO: o RTDB do projeto vive em us-central1 (o RTDB não existe em
// southamerica-east1) e triggers de RTDB DEVEM rodar na região da instância.
// O write em presence/count atravessa regiões (~1 write raro — irrelevante).
//
// IDEMPOTÊNCIA / CONCORRÊNCIA: o total é recontado do zero a cada execução
// (fonte = RTDB inteiro, não deltas) e a escrita compara com o valor já
// persistido — reexecuções ou eventos fora de ordem convergem sozinhos.
// `maxInstances: 1` (herdado do padrão do projeto, aqui explícito) serializa
// rajadas e evita corridas de escrita.
// ============================================================================

export const presenceSync = onValueWritten(
  {
    ref: "/status/{uid}",
    region: "us-central1",
    maxInstances: 1,
    memory: "256MiB",
    timeoutSeconds: 30,
  },
  async event => {
    const changedUid = event.params.uid;

    // 1) Reconta o total no RTDB (leitura gratuita, fonte da verdade).
    const statusSnap = await getDatabase().ref("status").get();
    const status = (statusSnap.val() || {}) as Record<string, any>;

    let onlineCount = 0;
    for (const uid of Object.keys(status)) {
      const conns = status[uid]?.conns;
      if (!conns || typeof conns !== "object") continue;
      const hasActiveConn = Object.keys(conns).some(id => conns[id]?.active !== false);
      if (hasActiveConn) onlineCount += 1;
    }

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
