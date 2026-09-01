import { useState, useEffect, useRef, useCallback } from "react";
import type { Notification } from "../types/notifications";
import type { ManualVipCreditNotification } from "../types";
import { loadNotifications, saveNotifications, loadNotificationHistory, saveNotificationHistory, loadDesktopNotifyPref, saveDesktopNotifyPref } from "../storage";
import { sendDesktopNotification, checkPermission } from "../utils/desktopNotify";
import { dispatchNotificationNavigate } from "../utils/notificationNavigation";
import { playNotificationSound } from "../utils/notificationSound";
import { isNotificationTypeEnabled } from "../utils/notificationPreferences";
import { collection, query, where, doc, getDocs } from "firebase/firestore";
import { db, onSnapshot, deleteDoc } from "../firebase/config";

interface Props {
  currentUserUid?: string;
}

const SEEN_KEYS_STORAGE = "tibia_notif_seen_keys";
const SIM_VIP_NOTIFICATIONS_PREFIX = "tibia_sim_vip_notifications_";

function loadSeenKeys(): Set<string> {
  try {
    const raw = localStorage.getItem(SEEN_KEYS_STORAGE);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr) : new Set();
  } catch { return new Set(); }
}

function loadSimVipNotifications(uid: string): ManualVipCreditNotification[] {
  try {
    const raw = localStorage.getItem(`${SIM_VIP_NOTIFICATIONS_PREFIX}${uid}`);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const DESKTOP_READY_DELAY_MS = 5000;

// Mescla pendentes (Firestore-mirror local) + histórico (apenas local) com
// deduplicação por id. Itens "done" (histórico) SEMPRE vencem itens "pending"
// com o mesmo id, garantindo que uma notificação já marcada como concluída
// não reapareça em pendentes nunca mais — independente do storage estar sujo.
// Converte qualquer formato de timestamp para número em milissegundos.
// Aceita: number (ms), number (segundos), Firestore Timestamp (com toMillis ou seconds).
function normalizeTimestamp(raw: unknown): number {
  if (typeof raw === "number") {
    return raw < 1e12 ? raw * 1000 : raw; // segundos → ms
  }
  if (raw && typeof raw === "object" && typeof (raw as any).toMillis === "function") {
    return (raw as any).toMillis();
  }
  if (raw && typeof raw === "object" && typeof (raw as any).seconds === "number") {
    return (raw as any).seconds * 1000;
  }
  return Date.now();
}

function mergeNotifLayers(): Notification[] {
  const historyRaw = loadNotificationHistory().map(n => ({ ...n, status: "done" as const }));
  const doneIds = new Set(historyRaw.map(n => n.id));
  const pendingRaw = loadNotifications()
    .map(n => ({ ...n, status: "pending" as const }))
    .filter(n => !doneIds.has(n.id));
  // Dedup interno (caso o próprio storage tenha duplicatas)
  const seen = new Set<string>();
  const merged: Notification[] = [];
  for (const n of [...pendingRaw, ...historyRaw]) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    // Normaliza o timestamp de cada notificação ao carregar do localStorage,
    // garantindo que mesmo dados legados (Firestore Timestamp serializado como
    // objeto {seconds, nanoseconds}) sejam convertidos para número.
    merged.push({ ...n, createdAt: normalizeTimestamp(n.createdAt) });
  }
  return merged.sort((a, b) => b.createdAt - a.createdAt);
}

export function useNotifications({ currentUserUid }: Props) {
  const [notifications, setNotifications] = useState<Notification[]>(() => mergeNotifLayers());
  const [desktopEnabled, setDesktopEnabledState] = useState<boolean>(() => loadDesktopNotifyPref());

  // Espelho do estado atual de notificações para leitura síncrona dentro de callbacks
  // (ex: onSnapshot do Firestore) sem precisar re-inscrever o listener a cada mudanças.
  const notificationsRef = useRef<Notification[]>(notifications);
  useEffect(() => {
    notificationsRef.current = notifications;
  }, [notifications]);

  // Ref do UID do usuário atual — disponível de forma síncrona dentro de callbacks
  // de exclusão sem precisar fechar em closures que podem estar desatualizadas.
  const currentUserUidRef = useRef<string | undefined>(currentUserUid);
  useEffect(() => {
    currentUserUidRef.current = currentUserUid;
  }, [currentUserUid]);

  const seenKeys = useRef<Set<string>>(loadSeenKeys());

  const seenPtAdded = useRef<Set<string>>(new Set());
  const seenScheduleChanges = useRef<Set<string>>(new Set());
  // `seenCompletions` precisa ser persistido para evitar que a notificação
  // "Quest Concluída! Colabore com o projeto" reapareça ao atualizar a página
  // ou reabrir o app no Electron. Sem persistência, o useRef renasce vazio a
  // cada boot e o Firestore reentrega a PT concluída como se fosse novo evento.
  const seenCompletions = useRef<Set<string>>(new Set());

  useEffect(() => {
    seenKeys.current.forEach(key => {
      if (key.startsWith("pt_added:")) seenPtAdded.current.add(key.slice("pt_added:".length));
      else if (key.startsWith("schedule_changed:")) seenScheduleChanges.current.add(key.slice("schedule_changed:".length));
      else if (key.startsWith("quest_completed:")) seenCompletions.current.add(key.slice("quest_completed:".length));
    });
  }, []);
  const isReadyForDesktop = useRef<boolean>(false);
  useEffect(() => {
    const t = window.setTimeout(() => { isReadyForDesktop.current = true; }, DESKTOP_READY_DELAY_MS);
    return () => window.clearTimeout(t);
  }, []);

  // ── ANTI-DUPLICIDADE DESKTOP (determinística) ────────────────────────────
  // `addNotification` decidia "é duplicada?" lendo uma flag mutada DENTRO do
  // updater do setState — mas o React 18 pode executar o updater DEPOIS de a
  // função já ter seguido (batching). Resultado: um mesmo documento que
  // chegava como `added` e depois como `modified` (reexecução do watcher no
  // backend reescrevendo createdAt) passava pelo filtro como "nova" e gerava
  // uma SEGUNDA notificação no SO — o app não duplicava no centro (o dedup
  // de estado funciona), mas o desktop exibia duas.
  //
  // Este Set é consultado/gravado de forma SÍNCRONA e independe do React:
  // um id só ganha notificação desktop UMA vez por sessão. Sobrevive a
  // re-attach do listener (a ref não é recriada) e é limitado para não
  // crescer indefinidamente.
  const desktopShownIds = useRef<Set<string>>(new Set());
  const DESKTOP_SHOWN_IDS_LIMIT = 500;

  useEffect(() => {
    if (desktopEnabled) {
      checkPermission();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync state with localStorage if changed elsewhere (usa o merge deduplicado)
  useEffect(() => {
    function handleStorage() {
      setNotifications(mergeNotifLayers());
      setDesktopEnabledState(loadDesktopNotifyPref());
    }
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const setDesktopEnabled = useCallback((enabled: boolean) => {
    setDesktopEnabledState(enabled);
    saveDesktopNotifyPref(enabled);
    if (enabled) {
      checkPermission();
    }
  }, []);


  // `normalizeTimestamp` está definida no escopo do módulo (linha 40).
  // Reusamos a mesma função para evitar duplicação.

  const addNotification = useCallback((notif: Omit<Notification, "id" | "createdAt" | "status"> & { id?: string; createdAt?: number; status?: "pending" | "done" }) => {
    // ── PORTÃO ÚNICO DE PREFERÊNCIA ────────────────────────────────────────
    // Se o usuário desligou este tipo no modal "Configurar Notificações", a
    // notificação não entra no centro, não toca som e não vai para o desktop.
    // A LÓGICA DE DISPARO de cada notificação continua exatamente como era —
    // aqui só respeitamos a escolha do usuário, num ponto único.
    // Tipos obrigatórios e desconhecidos sempre passam.
    if (!isNotificationTypeEnabled(notif.type)) return;

    const newNotif: Notification = {
      id: notif.id || Date.now().toString() + Math.random().toString(36).slice(2),
      createdAt: normalizeTimestamp(notif.createdAt),
      status: notif.status || "pending",
      ...notif
    };
    // Garante que createdAt final esteja normalizado mesmo após spread
    newNotif.createdAt = normalizeTimestamp(newNotif.createdAt);

    let isDuplicate = false;

    setNotifications(prev => {
      // 1) Si já está no histórico local (done) → NUNCA reinserir.
      const inHistory = prev.find(n => n.id === newNotif.id && n.status === "done");
      if (inHistory) {
        isDuplicate = true;
        return prev;
      }

      const existing = prev.find(n => n.id === newNotif.id);
      let next: Notification[];

      if (existing) {
        // Já existe uma notificação pendente com este id: atualiza os dados em vez de duplicar.
        isDuplicate = true;
        next = prev.map(n => n.id === newNotif.id
          ? { ...n, ...newNotif, status: n.status }
          : n
        );
      } else {
        next = [newNotif, ...prev];
      }

      next = next.sort((a, b) => b.createdAt - a.createdAt);

      // IMPORTANTE: `tibia_notifications` armazena APENAS pendentes (espelho do
      // Firestore). Itens concluídos vivem somente em `tibia_notifications_history`.
      // Salvar a lista inteira aqui era a causa raiz da triplicação após reload.
      const pendingOnly = next.filter(n => n.status === "pending");
      saveNotifications(pendingOnly);
      return next;
    });

    // Notificação na área de trabalho apenas para notificações realmente novas e pendentes
    if (!isDuplicate && newNotif.status === "pending" && isReadyForDesktop.current) {
      playNotificationSound();
    }

    // Dedup desktop SÍNCRONO: o id entra no Set na primeira vez que a
    // notificação é vista como nova — qualquer evento posterior do MESMO id
    // (modified, reattach, reexecução do backend) não volta a exibir no SO.
    const alreadyShownOnDesktop = desktopShownIds.current.has(newNotif.id);
    if (!alreadyShownOnDesktop) {
      desktopShownIds.current.add(newNotif.id);
      if (desktopShownIds.current.size > DESKTOP_SHOWN_IDS_LIMIT) {
        // Descarta os mais antigos (ordem de inserção) para o Set não crescer
        // indefinidamente em sessões longas.
        const iterator = desktopShownIds.current.values();
        for (let i = 0; i < 50; i++) {
          const oldest = iterator.next();
          if (oldest.done) break;
          desktopShownIds.current.delete(oldest.value);
        }
      }
    }

    if (!isDuplicate && !alreadyShownOnDesktop && newNotif.status === "pending" && desktopEnabled && isReadyForDesktop.current) {
      // Clique na notificação desktop → EVENTO CANÔNICO ÚNICO. O roteador do
      // App (sempre montado) resolve o destino de TODOS os tipos pelo mapa
      // resolveNotificationDestination: PT por ID (Gerenciador/Meu Histórico),
      // janela Bazaar (+ consulta automática na diária), Meus Services,
      // Lista de Espera ou Centro de Notificações como fallback. No Electron,
      // o processo principal já restaurou/focou a janela (showAndFocusWindow)
      // antes de entregar o clique — aqui resta apenas navegar.
      sendDesktopNotification(newNotif.title, newNotif.body, () => {
        dispatchNotificationNavigate(newNotif);
      }, newNotif.createdAt, newNotif.id);
    }
  }, [desktopEnabled]);

  // Em modo de simulação, entrega ao usuário beneficiado as notificações de
  // bônus VIP que ficaram aguardando no armazenamento local.
  useEffect(() => {
    if (!currentUserUid) return;
    const storageKey = `${SIM_VIP_NOTIFICATIONS_PREFIX}${currentUserUid}`;

    function syncSimVipNotifications() {
      const queued = loadSimVipNotifications(currentUserUid!);
      if (queued.length === 0) return;
      localStorage.removeItem(storageKey);
      queued.forEach(notification => {
        addNotification({
          ...notification,
          status: "pending",
        });
      });
    }

    syncSimVipNotifications();
    window.addEventListener("storage", syncSimVipNotifications);
    return () => window.removeEventListener("storage", syncSimVipNotifications);
  }, [currentUserUid, addNotification]);


  // A detecção de "pt_added" agora é puramente orientada aos documentos no Firestore
  // gravados pelo remetente na coleção "notifications".

  // Notificações de alteração de horário agora são persistidas no Firestore
  // pelo fluxo que altera a PT. Este hook apenas consome os documentos persistidos
  // em notifications/{id}, evitando duplicação entre geração local e Firestore.

  // ============================================================================
  // LEMBRETES DE PT (30/15/5 min) — MIGRADOS PARA O BACKEND.
  // ============================================================================
  // Antes: um setInterval local de 60s comparava horários aqui — os lembretes
  // só existiam com o app aberto e sumiam com ele fechado. Agora a Cloud
  // Function `scheduledPtReminderWatch` (a cada minuto) grava os documentos
  // `notifications/{pt_reminder_...}` para cada membro; chegam pelo listener
  // (app aberto em qualquer estado) e por push (aba fechada), respeitando as
  // mesmas janelas e preferências (userNotificationPrefs).
  //


  // Remove notificações pendentes do Firestore após salvá-las no histórico local.
  // Importante: usa deleteDoc DIRETAMENTE. A tentativa anterior com
  // updateDoc({ __delete__: true }) sempre sucedia (apenas adicionava um campo)
  // e por isso o documento jamais era removido do Firestore.
  //
  // RETRY SIMPLES: em alguns casos (ex: notificação recebida com o app fechado)
  // a exclusão falha temporariamente, deixando "notificações fantasmas" no
  // Firestore que reaparecem depois. Sempre que a exclusão falhar: captura o
  // erro, aguarda ~1 segundo e tenta novamente, até 5 tentativas ou sucesso.
  // Ao obter sucesso, interrompe imediatamente as demais tentativas. Se todas
  // falharem, apenas registra no console (sem exibir erro ao usuário).
  const deletePendingFromFirestore = useCallback((ids: string[]) => {
    const MAX_ATTEMPTS = 5;
    const RETRY_DELAY_MS = 1000;

    async function deleteWithRetry(id: string) {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          await deleteDoc(doc(db, "notifications", id));
          return; // sucesso: interrompe imediatamente as demais tentativas
        } catch (err) {
          if (attempt === MAX_ATTEMPTS) {
            console.error(`Falha ao excluir notificação ${id} do Firestore após ${MAX_ATTEMPTS} tentativas:`, err);
            return;
          }
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        }
      }
    }

    ids.forEach((id) => {
      if (!id) return;
      try {
        deleteWithRetry(id);
      } catch {}
    });
  }, []);

  // Fluxo: 1) remove dos pendentes (otimista); 2) salva no histórico local;
  // 3) deleta do Firestore. Sempre dedup por id (não pode existir mesma notif
  // simultaneamente em pendentes e histórico).
  const markAsDone = useCallback((id: string) => {
    let didMove = false;
    setNotifications(prev => {
      const target = prev.find(n => n.id === id && n.status === "pending");
      if (!target) return prev;
      didMove = true;

      const moved: Notification = { ...target, status: "done" };
      const remaining = prev.filter(n => n.id !== id);
      const next = [moved, ...remaining].sort((a, b) => b.createdAt - a.createdAt);

      // Persistência separada: pendentes em `tibia_notifications`, done em `_history`.
      saveNotifications(next.filter(n => n.status === "pending"));
      saveNotificationHistory(next.filter(n => n.status === "done"));
      return next;
    });
    if (didMove) deletePendingFromFirestore([id]);
  }, [deletePendingFromFirestore]);

  const markAllAsDone = useCallback(() => {
    // ── PASSO 1: Atualização otimista da interface ──
    // Move todos os itens "pending" para "done" localmente de forma imediata,
    // garantindo resposta instantânea ao usuário sem depender da rede.
    setNotifications(prev => {
      const pendings = prev.filter(n => n.status === "pending");
      const movedPendings: Notification[] = pendings.map(n => ({ ...n, status: "done" as const }));
      const existingHistory = prev.filter(n => n.status === "done");

      const map = new Map<string, Notification>();
      [...existingHistory, ...movedPendings].forEach(n => map.set(n.id, n));
      const nextHistory = Array.from(map.values()).sort((a, b) => b.createdAt - a.createdAt);

      saveNotificationHistory(nextHistory);
      saveNotifications([]);
      return nextHistory;
    });

    // ── PASSO 2: Exclusão autoritativa diretamente do Firestore ──
    // Busca os documentos que existem NO FIRESTORE para este usuário, independente
    // do estado em memória ou do localStorage. Resolve o problema de novos dispositivos
    // onde o estado local ainda pode não ter sido totalmente populado como "pending".
    const uid = currentUserUidRef.current;
    if (!uid || !db) return;

    (async () => {
      try {
        const snap = await getDocs(
          query(collection(db, "notifications"), where("userId", "==", uid))
        );
        const ids = snap.docs.map(d => d.id).filter(Boolean);
        if (ids.length > 0) {
          deletePendingFromFirestore(ids);
        }

        // ── PASSO 3: Limpeza final definitiva (garantia de remoção total) ──
        // Após o fluxo normal de exclusão, realiza uma consulta DIRETA na coleção
        // de notificações do Firestore para localizar QUALQUER documento restante
        // para este usuário, independentemente do estado local, cache, lista de
        // pendentes ou qualquer outro controle interno.
        // Isto garante que nenhuma notificação "fantasma" ou não rastreada
        // permaneça registrada após o uso do botão "Limpar".
        // Aguarda brevemente para que as exclusões do PASSO 2 se propaguem.
        await new Promise(resolve => setTimeout(resolve, 2000));

        const finalSnap = await getDocs(
          query(collection(db, "notifications"), where("userId", "==", uid))
        );
        const remainingIds = finalSnap.docs.map(d => d.id).filter(Boolean);
        if (remainingIds.length > 0) {
          console.warn(`[markAllAsDone] ${remainingIds.length} notificação(ões) encontradas na limpeza final — removendo.`);
          remainingIds.forEach((id) => {
            try {
              deleteDoc(doc(db, "notifications", id));
            } catch (err) {
              console.error(`Erro ao excluir notificação residual ${id}:`, err);
            }
          });
        }
      } catch (err) {
        console.error("Erro ao buscar notificações para exclusão em lote:", err);
      }
    })();
  }, [deletePendingFromFirestore]);

  const clearDone = useCallback(() => {
    setNotifications(prev => {
      const pending = prev.filter(n => n.status === "pending");
      saveNotificationHistory([]);
      saveNotifications(pending);
      return pending;
    });
  }, []);

  // Escutar a coleção "notifications" do Firestore para o usuário logado.
  //
  // FLUXO DE INICIALIZAÇÃO (first snapshot):
  //   O onSnapshot entrega TODOS os documentos existentes como "added" no
  //   primeiro callback. Neste lote, as notificações são carregadas diretamente
  //   para o estado e para o localStorage SEM passar pelo addNotification.
  //   Isso evita que notificações antigas sejam tratadas como "recém-chegadas"
  //   e exibam "Agora mesmo". O timestamp real da notificação é preservado.
  //
  // FLUXO EM TEMPO REAL (após initialSyncDoneRef):
  //   Mudanças posteriores (novas notificações criadas por outros usuários)
  //   passam pelo addNotification normalmente, com desktop notification,
  //   e aparecem como "Agora mesmo" conforme esperado.
  // ============================================================================
  useEffect(() => {
    if (!currentUserUid) return;
    const q = query(collection(db, "notifications"), where("userId", "==", currentUserUid));
    const initialSyncDoneRef = { current: false };

    const unsub = onSnapshot(q, (snapshot) => {
      // ── SINALIZA QUE O PRIMEIRO LOTE DE SINCRONIZAÇÃO CHEGOU ──
      // O snapshot inicial contém todos os documentos. Processamos como
      // um lote único — não roteamos cada "added" individual para
      // addNotification, mas sim aplicamos diretamente no estado.
      if (!initialSyncDoneRef.current) {
        const existingNotifs = new Map<string, Notification>();
        notificationsRef.current.forEach(n => existingNotifs.set(n.id, n));

        const pendingNotifs: Notification[] = [];
        const addedIds = new Set<string>();

        snapshot.docChanges().forEach((change) => {
          if (change.type === "added" || change.type === "modified") {
            const data = change.doc.data() as Notification;
            if (data.type === "request_entry" || data.type === "rate_limit_block") return;
            const notifId = data.id || change.doc.id;
            addedIds.add(notifId);

            // Respeita notificações já no histórico
            const history = loadNotificationHistory();
            if (history.some(n => n.id === notifId)) return;

            // Normaliza o timestamp (objeto Timestamp do Firestore → número)
            const normalized = {
              ...data,
              id: notifId,
              status: "pending" as const,
              createdAt: normalizeTimestamp(data.createdAt),
            };
            pendingNotifs.push(normalized);
          }
        });

        // Mescla com as notificações já existentes no estado (ex: da store local)
        pendingNotifs.forEach(n => existingNotifs.set(n.id, n));
        const merged = Array.from(existingNotifs.values())
          .sort((a, b) => b.createdAt - a.createdAt);

        setNotifications(merged);
        saveNotifications(merged.filter(n => n.status === "pending"));
        initialSyncDoneRef.current = true;
        return;
      }

      // ── FLUXO EM TEMPO REAL (após sincronização inicial) ──
      snapshot.docChanges().forEach((change) => {
        if (change.type === "added" || change.type === "modified") {
          const data = change.doc.data() as Notification;
          if (data.type === "request_entry" || data.type === "rate_limit_block") return;

          const notifId = data.id || change.doc.id;

          const local = notificationsRef.current.find(n => n.id === notifId);
          if (local && local.status === "done") return;

          const persistedHistory = loadNotificationHistory();
          if (persistedHistory.some(n => n.id === notifId)) return;

          addNotification({
            ...data,
            id: notifId,
            status: "pending"
          });
        }
      });
    }, () => {});
    return () => unsub();
  }, [currentUserUid, addNotification]);

  // Notificações de "Quest Concluída" agora têm o Firestore como fonte
  // única da verdade. A criação persistente ocorre quando a PT muda para
  // questConcluida=true; este hook apenas consome notifications/{id}.

  // ============================================================================
  // DROPS/VALORES DA PT (pt_updated) — MIGRADO PARA O BACKEND.
  // ============================================================================
  // Antes: cada receptor computava a mudança de `dropsValuesSavedAt` a partir
  // do listener de parties, com o app aberto. Agora o trigger
  // `onPartyUpdated` (onDocumentUpdated em parties/{id}) detecta a mudança no
  // INSTANTE do salvamento e grava as notificações dos membros (exceto o
  // autor) — entregues por listener e push como qualquer outra.
  //


  const pendingCount = notifications.filter(n => n.status === "pending").length;

  return {
    notifications,
    pendingCount,
    markAsDone,
    markAllAsDone,
    clearDone,
    desktopEnabled,
    setDesktopEnabled,
    addNotification
  };
}