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
//     }
//   }
//
// SEMÂNTICA DE ONLINE (mesma da Cloud Function): uid online ⇔ existe ao menos
// uma conexão com `active !== false`. Múltiplas abas/dispositivos do mesmo
// usuário contam UMA vez; fechar uma aba não derruba o usuário enquanto outra
// conexão viver.
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

  // `.info/connected` dispara em cada (re)conexão do socket. É aqui que o
  // onDisconnect precisa ser re-armado: um onDisconnect só vale para a
  // conexão em que foi registrado.
  const unsubscribe = onValue(connectedRef, snapshot => {
    if (stopped) return;
    if (snapshot.val() !== true) return; // offline — nada a registrar

    // 1) ARMA a limpeza no SERVIDOR antes de se declarar online:
    //    se o socket cair (fechamento abrupto, crash, rede), o próprio
    //    servidor remove a conexão e grava o lastSeen — sem depender de
    //    beforeunload nem de heartbeat.
    onDisconnect(connRef).remove().catch(() => {});
    onDisconnect(lastSeenRef).set(serverTimestamp()).catch(() => {});

    // 2) Declara a conexão desta aba (preserva o estado ativo/ocioso atual
    //    em caso de reconexão no meio de uma ociosidade).
    set(connRef, { active: currentActive, since: serverTimestamp() }).catch(() => {});

    // 3) Metadados do usuário (exibição no painel Boss). `update` não toca
    //    nas conexões de outras abas.
    update(userRef, {
      name: displayName || "Anônimo",
      lastLoginAt: serverTimestamp(),
      lastSeen: serverTimestamp(),
    }).catch(() => {});
  });

  return {
    setActive(active: boolean) {
      if (stopped || active === currentActive) return;
      currentActive = active;
      update(connRef, { active }).catch(() => {});
      update(userRef, { lastSeen: serverTimestamp() }).catch(() => {});
    },
    stop() {
      if (stopped) return;
      stopped = true;
      unsubscribe();
      // Saída limpa: desarma o onDisconnect e remove a conexão agora.
      onDisconnect(connRef).cancel().catch(() => {});
      onDisconnect(lastSeenRef).cancel().catch(() => {});
      update(userRef, { lastSeen: serverTimestamp() }).catch(() => {});
      remove(connRef).catch(() => {});
    },
  };
}
