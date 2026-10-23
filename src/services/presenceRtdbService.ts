// ============================================================================
// PRESENÇA VIA REALTIME DATABASE — substitui o heartbeat Firestore de 3 min.
//
// PRIORIDADE: ECONOMIA DE CONSUMO DO FIRESTORE.
//   • O RTDB não cobra por operação (cobra por GB armazenado/transferido);
//     documentos de presença têm poucos bytes → custo ~zero.
//   • NENHUMA escrita de presença vai ao Firestore a partir do cliente.
//   • O contador agregado (`presence/count` no Firestore) é mantido pela
//     Cloud Function `presenceSync`, que só escreve quando o total MUDA.
//   • O cliente continua lendo o contador por POLLING (1 read/10 min) —
//     sem listener Firestore, conforme decisão de arquitetura.
//
// ESTRUTURA NO RTDB (regras em database.rules.json — cada uid escreve só o seu):
//   status/{uid}: {
//     name:        string           — exibição no painel Boss
//     lastLoginAt: number (ms)      — última conexão estabelecida
//     lastSeen:    number (ms)      — última vez visto (gravado TAMBÉM pelo
//                                     servidor via onDisconnect, cobrindo
//                                     fechamento abrupto/crash/queda de rede)
//     conns/{connId}: {             — UMA entrada por aba/dispositivo
//       active: boolean             — false = ocioso (não conta como online)
//       since:  number (ms)
//       hb:     number (ms)         — HEARTBEAT (ver abaixo)
//     }
//   }
//
// SEMÂNTICA DE ONLINE (regra única em src/utils/presenceStatus.ts, espelhada
// no backend em functions/src/presenceCore.ts): uid online ⇔ existe ao menos
// uma conexão com `active !== false` E heartbeat FRESCO. Múltiplas
// abas/dispositivos do mesmo usuário contam UMA vez; fechar uma aba não
// derruba o usuário enquanto outra conexão viver.
//
// POR QUE HEARTBEAT (correção da auditoria de presença): a semântica antiga
// dependia 100% do `onDisconnect` para remover a conexão — e onDisconnect
// NÃO é garantido (socket que morre antes de o arm chegar ao servidor,
// corrida no logout, conexões fantasma). Uma falha única deixava a conexão
// órfã e o usuário "Online" para sempre. Agora cada conexão regrava
// `hb = serverTimestamp()` a cada 4 min (escrita RTDB = custo zero);
// conexões cujo hb parou EXPIRAM pela regra de frescor (painel/contador) e
// são removidas pela limpeza agendada (`presenceCleanup`). O heartbeat
// continua mesmo com a aba OCIOSA (active:false): ociosa ≠ órfã — ela não
// conta como online, mas permanece válida para voltar a ativa na hora.
//
// O padrão `.info/connected` + re-registro do onDisconnect é o recomendado
// pela documentação oficial: após uma reconexão de rede, o SDK restabelece o
// nó e re-arma o onDisconnect no servidor. Esse listener é do RTDB (gratuito
// e local ao socket) — NÃO é um listener Firestore.
// ============================================================================
import {
  ref,
  onValue,
  set,
  update,
  remove,
  onDisconnect,
  serverTimestamp,
  push,
  type Database,
} from "firebase/database";
import { PRESENCE_HEARTBEAT_INTERVAL_MS } from "../utils/presenceStatus";

export interface RtdbPresenceHandle {
  /** Marca a conexão atual como ativa/ociosa (RTDB apenas — custo zero). */
  setActive: (active: boolean) => void;
  /** Encerra a presença desta aba (remove o nó e desarma o onDisconnect). */
  stop: () => void;
}

export function startRtdbPresence(
  rtdb: Database,
  uid: string,
  displayName: string,
): RtdbPresenceHandle {
  const userRef = ref(rtdb, `status/${uid}`);
  const connRef = push(ref(rtdb, `status/${uid}/conns`));
  const lastSeenRef = ref(rtdb, `status/${uid}/lastSeen`);
  const connectedRef = ref(rtdb, ".info/connected");

  let stopped = false;
  let currentActive = true;
  let socketConnected = false;

  // `.info/connected` dispara em cada (re)conexão do socket. É aqui que o
  // onDisconnect precisa ser re-armado: um onDisconnect só vale para a
  // conexão em que foi registrado.
  const unsubscribe = onValue(connectedRef, snapshot => {
    if (stopped) return;
    if (snapshot.val() !== true) { socketConnected = false; return; } // offline — nada a registrar
    socketConnected = true;

    // 1) ARMA a limpeza no SERVIDOR antes de se declarar online:
    //    se o socket cair (fechamento abrupto, crash, rede), o próprio
    //    servidor remove a conexão e grava o lastSeen — sem depender de
    //    beforeunload nem de heartbeat.
    onDisconnect(connRef).remove().catch(() => {});
    onDisconnect(lastSeenRef).set(serverTimestamp()).catch(() => {});

    // 2) Declara a conexão desta aba (preserva o estado ativo/ocioso atual
    //    em caso de reconexão no meio de uma ociosidade). O `set` COMPLETO
    //    também recria a conexão caso a limpeza agendada a tenha removido
    //    durante uma suspensão longa do computador.
    set(connRef, { active: currentActive, since: serverTimestamp(), hb: serverTimestamp() }).catch(() => {});

    // 3) Metadados do usuário (exibição no painel Boss). `update` não toca
    //    nas conexões de outras abas.
    update(userRef, {
      name: displayName || "Anônimo",
      lastLoginAt: serverTimestamp(),
      lastSeen: serverTimestamp(),
    }).catch(() => {});
  });

  // HEARTBEAT: regrava `hb` na PRÓPRIA conexão a cada 4 min, somente com o
  // socket conectado (sem fila offline inútil). Timer parado durante
  // suspensão do computador → hb envelhece → a conexão expira pela regra de
  // frescor; na retomada, `.info/connected` recria a conexão completa.
  const heartbeatTimer = setInterval(() => {
    if (stopped || !socketConnected) return;
    update(connRef, { hb: serverTimestamp() }).catch(() => {});
  }, PRESENCE_HEARTBEAT_INTERVAL_MS);

  return {
    setActive(active: boolean) {
      if (stopped || active === currentActive) return;
      currentActive = active;
      // `hb` acompanha a transição: a volta da ociosidade é um sinal de vida.
      update(connRef, { active, hb: serverTimestamp() }).catch(() => {});
      update(userRef, { lastSeen: serverTimestamp() }).catch(() => {});
    },
    stop() {
      if (stopped) return;
      stopped = true;
      unsubscribe();
      clearInterval(heartbeatTimer);
      // Saída limpa — ORDEM IMPORTA (correção da auditoria): o `remove` da
      // conexão é emitido ANTES de desarmar o onDisconnect. Na ordem antiga
      // (cancel → remove), se o remove não chegasse ao servidor (aba
      // fechando logo após o logout, rede caindo no meio), a conexão ficava
      // ÓRFÃ e SEM rede de segurança → usuário "Online" para sempre. Agora,
      // se o remove falhar, o onDisconnect ainda armado limpa no timeout do
      // socket — e, em último caso, o heartbeat parado faz a conexão
      // expirar e ser varrida pela limpeza agendada.
      update(userRef, { lastSeen: serverTimestamp() }).catch(() => {});
      remove(connRef)
        .then(() => {
          // Conexão removida no servidor: agora é seguro desarmar.
          onDisconnect(connRef).cancel().catch(() => {});
          onDisconnect(lastSeenRef).cancel().catch(() => {});
        })
        .catch(() => { /* remove não confirmado: onDisconnect fica armado de propósito */ });
    },
  };
}
