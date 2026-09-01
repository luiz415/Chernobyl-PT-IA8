import { useState, useEffect, useMemo, useRef } from "react";
import { useAuth } from "../context/AuthContext";
import {
  Shield,
  ShieldAlert,
  Check,
  X,
  Users,
  Clock,
  Calendar,
  CheckCircle2,
  HeartHandshake,
  Save,
  Info,
  Activity,
  Copy,
  ClipboardCheck,
  Database,
  Settings,
  PauseCircle,
  PlayCircle,
  Crown,
  Star,
} from "lucide-react";
import type { Donation } from "../types/donations";
import { formatRC, type ManualVipCreditNotification, type VipCreditRequest } from "../types";
import { db, isSimulationMode, onSnapshot, updateDoc, setDoc, deleteDoc, getDoc, getDocs } from "../firebase/config";
import { collection, doc, serverTimestamp, query, where, increment, runTransaction, Timestamp } from "firebase/firestore";
import { getLogs, clearLogs, getStats, type LogEntry } from "../utils/firestoreLogger";
import { getVipEffectiveExpirationMillis, getVipExpirationMillis, formatVipExpirationDate, formatVipRemainingTime, VIP_DAY_MS } from "../utils/vipAccess";

interface Props {
  open: boolean;
  onClose: () => void;
  presenceMap?: Record<string, any>;
  minAverage?: number;
  globalSettings?: {
    minimumAverageDonation: number;
    firestoreLoggerPaused: boolean;
    bossBadgesMode?: "realtime" | "economy" | "manual";
    firestoreLoggerDetailLevel?: "complete" | "summary";
    firestoreLoggerSendIntervalSeconds?: 120 | 300 | 600;
    feedbackMode?: "manual";
    presenceEnabled?: boolean;
    presenceMode?: "economico" | "completo";
    idleModeTimeoutMinutes?: number;
    publicPartiesEnabled?: boolean;
  };
  pendingDonationsCount?: number;
  pendingRequestsCount?: number;
  pendingVipCount?: number;
}

const DONATIONS_KEY = "chernobyl_donations";

export default function BossAdminPanel({ open, onClose, presenceMap = {}, minAverage = 10, globalSettings, pendingDonationsCount: externalPendingDonationsCount = 0, pendingRequestsCount: externalPendingRequestsCount = 0, pendingVipCount: externalPendingVipCount = 0 }: Props) {
  const {
    currentUser,
    userProfile,
    allUsers,
    approveUser,
    refuseUser,
    isSimulation,
    isIdleMode
  } = useAuth();

  const [activeTab, setActiveTab] = useState<"pending" | "users" | "notifications" | "donations" | "vip" | "logfirestore" | "colections" | "settings">("settings");

  useEffect(() => {
    if (open) {
      setActiveTab("settings");
    }
  }, [open]);

  // Solicitações de crédito VIP — histórico permanente, sem exclusões
  const [vipRequests, setVipRequests] = useState<VipCreditRequest[]>([]);
  const [processingVipRequestIds, setProcessingVipRequestIds] = useState<Set<string>>(new Set());
  const [vipActionMessage, setVipActionMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [manualVipDaysByUser, setManualVipDaysByUser] = useState<Record<string, string>>({});
  const [processingManualVipUserIds, setProcessingManualVipUserIds] = useState<Set<string>>(new Set());
  const [manualVipMessages, setManualVipMessages] = useState<Record<string, { type: "success" | "error"; text: string }>>({});

  // Estados para a aba Configurações
  const [minDonationInput, setMinDonationInput] = useState("");
  useEffect(() => {
    if (globalSettings) {
      setMinDonationInput(String(globalSettings.minimumAverageDonation));
    }
  }, [globalSettings]);
  const [searchQuery, setSearchQuery] = useState("");

  // Configuração dos Planos VIP
  const [plan30PriceInput, setPlan30PriceInput] = useState("100");
  const [plan90PriceInput, setPlan90PriceInput] = useState("250");
  const [vipPlansSaving, setVipPlansSaving] = useState(false);
  const [vipPlansSaveMessage, setVipPlansSaveMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    if (!open || !userProfile || userProfile.role !== "Boss" || activeTab !== "settings" || isIdleMode) return;
    if (isSimulationMode || !db) {
      try {
        const raw = localStorage.getItem("tibia_vip_plans_config");
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed.plan30PriceRC === "number" && typeof parsed.plan90PriceRC === "number") {
            setPlan30PriceInput(String(parsed.plan30PriceRC));
            setPlan90PriceInput(String(parsed.plan90PriceRC));
          }
        }
      } catch {}
      return;
    }
    // ============================================================================
    // OPTIMIZAÇÃO: Cache para vip_plans em vez de listener permanente
    // ============================================================================
    const loadVipPlans = async () => {
      try {
        const { getDoc } = await import("firebase/firestore");
        const docSnap = await getDoc(doc(db, "appSettings", "vip_plans"));
        if (docSnap.exists()) {
          const data = docSnap.data();
          const p30 = typeof data.plan30PriceRC === "number" ? data.plan30PriceRC : 100;
          const p90 = typeof data.plan90PriceRC === "number" ? data.plan90PriceRC : 250;
          setPlan30PriceInput(String(p30));
          setPlan90PriceInput(String(p90));
          // Salvar no cache local
          localStorage.setItem("chernobyl_vip_plans", JSON.stringify({ plan30PriceRC: p30, plan90PriceRC: p90 }));
        }
      } catch {
        // Fallback para cache local
        try {
          const cached = localStorage.getItem("chernobyl_vip_plans");
          if (cached) {
            const plans = JSON.parse(cached);
            setPlan30PriceInput(String(plans.plan30PriceRC || 100));
            setPlan90PriceInput(String(plans.plan90PriceRC || 250));
          }
        } catch {}
      }
    };

    loadVipPlans();
    return () => {};
  }, [open, userProfile?.role, activeTab, isIdleMode]);

  async function handleSaveVipPlans() {
    const p30 = parseInt(plan30PriceInput.replace(/[^\d]/g, ""), 10);
    const p90 = parseInt(plan90PriceInput.replace(/[^\d]/g, ""), 10);
    if (!Number.isFinite(p30) || p30 < 0 || !Number.isFinite(p90) || p90 < 0) {
      setVipPlansSaveMessage({ type: "error", text: "Informe valores válidos em RC para os planos." });
      return;
    }
    setVipPlansSaving(true);
    setVipPlansSaveMessage(null);
    try {
      const config = { plan30PriceRC: p30, plan90PriceRC: p90 };
      if (isSimulationMode || !db) {
        localStorage.setItem("tibia_vip_plans_config", JSON.stringify(config));
        window.dispatchEvent(new Event("storage"));
      } else {
        await setDoc(doc(db, "appSettings", "vip_plans"), {
          ...config,
          updatedBy: currentUser?.uid || "",
          updatedAt: serverTimestamp()
        }, { merge: true });
      }
      setVipPlansSaveMessage({ type: "success", text: "Configuração dos Planos VIP salva com sucesso!" });
      setTimeout(() => setVipPlansSaveMessage(null), 3000);
    } catch (err: any) {
      setVipPlansSaveMessage({ type: "error", text: err?.message || "Erro ao salvar planos VIP." });
    } finally {
      setVipPlansSaving(false);
    }
  }

  // Doações (Cloud ou Local)
  const [donations, setDonations] = useState<Donation[]>([]);
  const [donationChar, setDonationChar] = useState("A definir pelo administrador");
  const [inputDonationChar, setInputDonationChar] = useState("A definir pelo administrador");

  // Estados de aprovação da sub-aba "Pendentes"
  const [approvalId, setApprovalId] = useState<string | null>(null);
  const [approvalAmount, setApprovalAmount] = useState<string>("");

  // Confirmação inline para reset de bloqueios — guarda o uid em estado "armado"
  const [confirmResetUid, setConfirmResetUid] = useState<string | null>(null);
  const confirmResetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => { if (confirmResetTimerRef.current) window.clearTimeout(confirmResetTimerRef.current); };
  }, []);

  async function handleResetBlocks(uid: string) {
    if (confirmResetUid !== uid) {
      setConfirmResetUid(uid);
      if (confirmResetTimerRef.current) window.clearTimeout(confirmResetTimerRef.current);
      confirmResetTimerRef.current = window.setTimeout(() => {
        setConfirmResetUid(cur => cur === uid ? null : cur);
      }, 4000);
      return;
    }
    if (confirmResetTimerRef.current) window.clearTimeout(confirmResetTimerRef.current);
    setConfirmResetUid(null);
    try {
      if (!isSimulationMode && db) {
        await updateDoc(doc(db, "users", uid), { rateLimitBlocks: 0 });
      }
    } catch {}
  }

  // Notificações da aba Boss (próprio listener, independente do hook global)
  const [bossTabNotifications, setBossTabNotifications] = useState<Array<{ id: string; title: string; body: string; createdAt: number; ignored?: boolean; ignoredAt?: number; ignoredBy?: string; type?: string }>>([]);
  const [logCopied, setLogCopied] = useState(false);
  const [firestoreLogs, setFirestoreLogs] = useState<LogEntry[]>([]);
  const [firestoreStats, setFirestoreStats] = useState<ReturnType<typeof getStats>>(getStats());
  // Estado para logs remotos de outros usuários (carregados do Firestore)
  const [remoteUserLogs, setRemoteUserLogs] = useState<Array<{
    uid: string;
    updatedAt: string;
    stats: {
      totalReads: number;
      totalWrites: number;
      totalDeletes: number;
      byCollection: Record<string, { reads: number; writes: number; deletes: number }>;
    };
  }>>([]);
  const [selectedRemoteUid, setSelectedRemoteUid] = useState<string | null>(null);
  const [remoteLogCopied, setRemoteLogCopied] = useState(false);

  // Estatísticas de doação por usuário (userStats)
  const [userStatsMap, setUserStatsMap] = useState<Record<string, { totalRcDoadoAprovado: number; totalPtsConcluidas: number }>>({});

  // Estados para a aba de Coleções Firestore
  const [hoursThreshold, setHoursThreshold] = useState(72);
  const [cleaningNotifications, setCleaningNotifications] = useState(false);
  const [cleanResult, setCleanResult] = useState<{ success: boolean; message: string } | null>(null);

  // Listener lazy: solicitações de crédito VIP (pendentes + histórico)
  // Ativo somente enquanto a aba VIP está aberta.
  useEffect(() => {
    if (!open || !userProfile || userProfile.role !== "Boss" || activeTab !== "vip" || isIdleMode) return;
    if (isSimulationMode || !db) {
      setVipRequests([]);
      return;
    }

    const unsubscribe = onSnapshot(
      collection(db, "vipCreditRequests"),
      (snapshot) => {
        const list = snapshot.docs.map(requestDoc => ({
          id: requestDoc.id,
          ...requestDoc.data(),
        } as VipCreditRequest));
        list.sort((a, b) => (b.clientCreatedAt || 0) - (a.clientCreatedAt || 0));
        setVipRequests(list);
      },
      () => setVipRequests([])
    );

    return () => {
      unsubscribe();
      setVipRequests([]);
    };
  }, [open, userProfile?.role, activeTab, isIdleMode]);

  const pendingVipRequestsCount = useMemo(
    () => vipRequests.filter(request => request.status === "pendente").length,
    [vipRequests]
  );

  function formatVipRequestDate(request: VipCreditRequest): string {
    const millis = request.createdAt?.toMillis?.() || request.clientCreatedAt;
    if (!millis) return "—";
    return new Date(millis).toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function setVipRequestProcessing(requestId: string, processing: boolean) {
    setProcessingVipRequestIds(prev => {
      const next = new Set(prev);
      if (processing) next.add(requestId);
      else next.delete(requestId);
      return next;
    });
  }

  async function approveVipRequest(request: VipCreditRequest) {
    if (!db || isSimulationMode || !currentUser?.uid || request.status !== "pendente") return;
    setVipRequestProcessing(request.id, true);
    setVipActionMessage(null);
    try {
      await runTransaction(db, async transaction => {
        const requestRef = doc(db, "vipCreditRequests", request.id);
        const userRef = doc(db, "users", request.userId);
        const requestSnap = await transaction.get(requestRef);
        const userSnap = await transaction.get(userRef);

        if (!requestSnap.exists()) throw new Error("Solicitação não encontrada.");
        if (!userSnap.exists()) throw new Error("Usuário não encontrado.");

        const currentRequest = requestSnap.data() as VipCreditRequest;
        if (currentRequest.status !== "pendente") return;
        const days = Number(currentRequest.requestedDays);
        if (!Number.isInteger(days) || days < 30 || days % 30 !== 0) {
          throw new Error("Quantidade de dias inválida.");
        }

        const userData = userSnap.data() as any;
        const now = Date.now();
        const storedExpiration = getVipExpirationMillis(userData.vipExpiresAt);
        const legacyDays = !storedExpiration && typeof userData.vipDays === "number" && userData.vipDays > 0
          ? Math.floor(userData.vipDays)
          : 0;
        const baseExpiration = storedExpiration > now
          ? storedExpiration
          : now + legacyDays * VIP_DAY_MS;
        const newExpiration = baseExpiration + days * VIP_DAY_MS;

        transaction.update(userRef, {
          vipExpiresAt: Timestamp.fromMillis(newExpiration),
          vipUpdatedAt: serverTimestamp(),
          role: userData.role === "Boss" ? "Boss" : "VIP",
        });
        transaction.update(requestRef, {
          status: "aprovado",
          approvedDays: days,
          reviewedBy: currentUser.uid,
          reviewedByName: userProfile?.nome || "Boss",
          reviewedAt: serverTimestamp(),
        });

        // Grava a notificação VIP para o usuário na coleção 'notifications' do Firestore
        const notifId = "notif_" + Date.now() + "_" + Math.random().toString(36).slice(2);
        const notifRef = doc(db, "notifications", notifId);
        transaction.set(notifRef, {
          id: notifId,
          userId: request.userId,
          type: "payment_received",
          title: "⭐ Assinatura VIP Ativada!",
          body: `Parabéns! Sua solicitação de VIP foi aprovada. Foram creditados ${days} dias de VIP na sua conta. Aproveite todas as vantagens!`,
          status: "pending",
          read: false,
          createdAt: Date.now()
        });
      });
      setVipActionMessage({ type: "success", text: `Solicitação de ${request.requestedDays} dias aprovada.` });
    } catch (error: any) {
      setVipActionMessage({ type: "error", text: error?.message || "Não foi possível aprovar a solicitação." });
    } finally {
      setVipRequestProcessing(request.id, false);
    }
  }

  async function refuseVipRequest(request: VipCreditRequest) {
    if (!db || isSimulationMode || !currentUser?.uid || request.status !== "pendente") return;
    setVipRequestProcessing(request.id, true);
    setVipActionMessage(null);
    try {
      await runTransaction(db, async transaction => {
        const requestRef = doc(db, "vipCreditRequests", request.id);
        const requestSnap = await transaction.get(requestRef);
        if (!requestSnap.exists()) throw new Error("Solicitação não encontrada.");

        const currentRequest = requestSnap.data() as VipCreditRequest;
        if (currentRequest.status !== "pendente") return;

        transaction.update(requestRef, {
          status: "recusado",
          reviewedBy: currentUser.uid,
          reviewedByName: userProfile?.nome || "Boss",
          reviewedAt: serverTimestamp(),
        });
      });
      setVipActionMessage({ type: "success", text: "Solicitação VIP recusada." });
    } catch (error: any) {
      setVipActionMessage({ type: "error", text: error?.message || "Não foi possível recusar a solicitação." });
    } finally {
      setVipRequestProcessing(request.id, false);
    }
  }

  async function addManualVipCredit(user: (typeof allUsers)[number]) {
    const days = Number(manualVipDaysByUser[user.uid]);
    if (!Number.isInteger(days) || days <= 0) {
      setManualVipMessages(prev => ({
        ...prev,
        [user.uid]: { type: "error", text: "Informe uma quantidade válida de dias." },
      }));
      return;
    }

    setProcessingManualVipUserIds(prev => new Set(prev).add(user.uid));
    setManualVipMessages(prev => {
      const next = { ...prev };
      delete next[user.uid];
      return next;
    });

    const createdAt = Date.now();
    const notification: ManualVipCreditNotification = {
      id: "notif_vip_bonus_" + createdAt + "_" + Math.random().toString(36).slice(2),
      userId: user.uid,
      type: "vip_approved",
      title: "Parabéns! Você recebeu bônus VIP.",
      body: `Um administrador do Chernobyl PT te presenteou com ${days} dias de VIP.`,
      status: "pending",
      read: false,
      createdAt,
      vipDays: days,
    };

    try {
      if (isSimulationMode || !db) {
        const now = Date.now();
        const storedExpiration = getVipExpirationMillis(user.vipExpiresAt);
        const legacyDays = !storedExpiration && typeof user.vipDays === "number" && user.vipDays > 0
          ? Math.floor(user.vipDays)
          : 0;
        const baseExpiration = storedExpiration > now ? storedExpiration : now + legacyDays * VIP_DAY_MS;
        const newExpiration = baseExpiration + days * VIP_DAY_MS;
        const updatedUsers = allUsers.map(item => item.uid === user.uid
          ? { ...item, vipExpiresAt: newExpiration, role: "VIP" as const }
          : item
        );
        localStorage.setItem("tibia_sim_users", JSON.stringify(updatedUsers));

        const simNotificationKey = `tibia_sim_vip_notifications_${user.uid}`;
        const rawNotifications = localStorage.getItem(simNotificationKey);
        const simNotifications = rawNotifications ? JSON.parse(rawNotifications) : [];
        localStorage.setItem(
          simNotificationKey,
          JSON.stringify([notification, ...(Array.isArray(simNotifications) ? simNotifications : [])])
        );
        window.dispatchEvent(new Event("storage"));
      } else {
        await runTransaction(db, async transaction => {
          const userRef = doc(db, "users", user.uid);
          const userSnap = await transaction.get(userRef);
          if (!userSnap.exists()) throw new Error("Usuário não encontrado.");

          const userData = userSnap.data() as any;
          const now = Date.now();
          const storedExpiration = getVipExpirationMillis(userData.vipExpiresAt);
          const legacyDays = !storedExpiration && typeof userData.vipDays === "number" && userData.vipDays > 0
            ? Math.floor(userData.vipDays)
            : 0;
          const baseExpiration = storedExpiration > now ? storedExpiration : now + legacyDays * VIP_DAY_MS;
          const newExpiration = baseExpiration + days * VIP_DAY_MS;

          transaction.update(userRef, {
            vipExpiresAt: Timestamp.fromMillis(newExpiration),
            vipUpdatedAt: serverTimestamp(),
            role: userData.role === "Boss" ? "Boss" : "VIP",
          });
          transaction.set(doc(db, "notifications", notification.id), notification);
        });
      }

      setManualVipDaysByUser(prev => ({ ...prev, [user.uid]: "" }));
      setManualVipMessages(prev => ({
        ...prev,
        [user.uid]: { type: "success", text: `${days} dias adicionados.` },
      }));
    } catch (error: any) {
      setManualVipMessages(prev => ({
        ...prev,
        [user.uid]: { type: "error", text: error?.message || "Erro ao adicionar o crédito VIP." },
      }));
    } finally {
      setProcessingManualVipUserIds(prev => {
        const next = new Set(prev);
        next.delete(user.uid);
        return next;
      });
    }
  }

  // Listener lazy: estatísticas de doação de todos os usuários (userStats)
  // Ativo somente na aba Usuários, onde a média de doação é exibida.
  useEffect(() => {
    if (!open || !userProfile || userProfile.role !== "Boss" || activeTab !== "users" || isIdleMode) return;
    if (isSimulationMode || !db) return;
    try {
      const unsubscribe = onSnapshot(
        collection(db, "userStats"),
        (snapshot) => {
          const map: Record<string, { totalRcDoadoAprovado: number; totalPtsConcluidas: number }> = {};
          snapshot.docs.forEach(d => {
            const data = d.data();
            map[d.id] = {
              totalRcDoadoAprovado: typeof data.totalRcDoadoAprovado === "number" ? data.totalRcDoadoAprovado : 0,
              totalPtsConcluidas: typeof data.totalPtsConcluidas === "number" ? data.totalPtsConcluidas : 0,
            };
          });
          setUserStatsMap(map);
        },
        () => setUserStatsMap({})
      );
      return () => {
        unsubscribe();
        setUserStatsMap({});
      };
    } catch { setUserStatsMap({}); }
  }, [open, userProfile?.role, activeTab, isIdleMode]);

  useEffect(() => {
    if (!open || !userProfile || userProfile.role !== "Boss" || activeTab !== "logfirestore" || globalSettings?.firestoreLoggerPaused || isIdleMode) return;

    const syncLogs = () => {
      try {
        setFirestoreLogs(getLogs().slice().sort((a, b) => b.timestamp - a.timestamp));
        setFirestoreStats(getStats());
      } catch {}
    };

    syncLogs();
    const interval = window.setInterval(syncLogs, 2000);
    return () => window.clearInterval(interval);
  }, [open, userProfile?.role, activeTab, globalSettings?.firestoreLoggerPaused, isIdleMode]);

  function formatLogTime(timestamp: number): string {
    try {
      return new Date(timestamp).toLocaleTimeString("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch {
      return "--:--:--";
    }
  }

  // ============================================================================
  // CACHE PERSISTENTE DE "VISTO POR ÚLTIMO"
  // O documento presence/{uid} é DELETADO quando o usuário desconecta, fazendo o
  // lastSeen sumir do presenceMap. Este cache (localStorage) registra
  // obrigatoriamente o último horário visto de cada usuário, garantindo que o
  // "visto por último" continue exibido mesmo após o usuário sair.
  // ============================================================================
  const LASTSEEN_CACHE_KEY = "boss_lastseen_cache";
  const [, setLastSeenCache] = useState<Record<string, number>>(() => {
    try {
      const raw = localStorage.getItem(LASTSEEN_CACHE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch { return {}; }
  });
  // Mescla o presenceMap atual no cache — sempre mantém o MAIOR timestamp conhecido
  useEffect(() => {
    const uids = Object.keys(presenceMap);
    if (uids.length === 0) return;
    setLastSeenCache(prev => {
      let changed = false;
      const next = { ...prev };
      uids.forEach(uid => {
        const incoming = presenceMap[uid];
        if (incoming > 0 && (!next[uid] || incoming > next[uid])) {
          next[uid] = incoming;
          changed = true;
        }
      });
      if (changed) {
        try { localStorage.setItem(LASTSEEN_CACHE_KEY, JSON.stringify(next)); } catch {}
        return next;
      }
      return prev;
    });
  }, [presenceMap]);
  function formatPresenceTime(ts?: any): string {
    if (!ts) return "—";
    const millis = ts?.toMillis?.() || ts;
    if (!millis || millis <= 0) return "—";
    return new Date(millis).toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function isUserOnline(lastActivityAt?: any): boolean {
    if (!lastActivityAt) return false;
    const millis = lastActivityAt?.toMillis?.() || lastActivityAt;
    const ONLINE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutos
    return Date.now() - millis < ONLINE_THRESHOLD_MS;
  }

  // Listener lazy: Doações + leitura pontual de donation_settings
  // Ativo somente enquanto a aba Doações está aberta.
  useEffect(() => {
    if (!open || !userProfile || userProfile.role !== "Boss" || activeTab !== "donations" || isIdleMode) return;

    if (isSimulationMode || !db) {
      const loadLocal = () => {
        try {
          const raw = localStorage.getItem(DONATIONS_KEY);
          const parsed = raw ? JSON.parse(raw) : [];
          setDonations(Array.isArray(parsed) ? parsed : []);
        } catch { setDonations([]); }

        try {
          const char = localStorage.getItem("chernobyl_donation_char") || "A definir pelo administrador";
          setDonationChar(char);
          setInputDonationChar(char);
        } catch {}
      };

      loadLocal();
      window.addEventListener("storage", loadLocal);
      return () => {
        window.removeEventListener("storage", loadLocal);
        setDonations([]);
      };
    }

    const unsubDonations = onSnapshot(collection(db, "donations"), (snapshot) => {
      const list: Donation[] = snapshot.docs.map(d => {
        const data = d.data();
        return {
          id: d.id,
          userId: data.userId || "",
          userName: data.userName || "Anônimo",
          userEmail: data.userEmail || "",
          amount: data.amount || 0,
          fromCharacter: data.fromCharacter || "",
          toCharacter: data.toCharacter || "",
          donationDate: data.donationDate || "",
          createdAt: data.createdAt || new Date().toISOString(),
          status: data.status || "pendente",
          approvedBy: data.approvedBy,
          approvedByName: data.approvedByName,
          approvedAt: data.approvedAt
        };
      });
      setDonations(list);
    }, () => {});

    const loadDonationSettings = async () => {
      try {
        const { getDoc } = await import("firebase/firestore");
        const docSnap = await getDoc(doc(db, "settings", "donation_settings"));
        if (docSnap.exists()) {
          const data = docSnap.data();
          const char = data.donationCharacter || data.characterName || "A definir pelo administrador";
          setDonationChar(char);
          setInputDonationChar(char);
          localStorage.setItem("chernobyl_donation_char", char);
        }
      } catch {
        try {
          const cached = localStorage.getItem("chernobyl_donation_char");
          if (cached) {
            setDonationChar(cached);
            setInputDonationChar(cached);
          }
        } catch {}
      }
    };

    loadDonationSettings();

    return () => {
      unsubDonations();
      setDonations([]);
    };
  }, [open, userProfile?.role, activeTab, isIdleMode]);

  // Listener lazy: notificações administrativas do Boss.
  // Ativo somente enquanto a aba Notificações está aberta.
  useEffect(() => {
    if (!open || !userProfile || userProfile.role !== "Boss" || activeTab !== "notifications" || isIdleMode) return;
    if (isSimulationMode || !db) return;

    const notifQ = query(
      collection(db, "notifications"),
      where("targetRole", "==", "Boss")
    );
    const unsubBossNotifs = onSnapshot(notifQ, (snapshot) => {
      const list = snapshot.docs.map(d => {
        const data = d.data();
        return {
          id: d.id,
          title: data.title || "",
          body: data.body || "",
          createdAt: data.createdAt || Date.now(),
          ignored: data.ignored === true,
          ignoredAt: data.ignoredAt,
          ignoredBy: data.ignoredBy,
          type: data.type || "request_entry"
        };
      }).sort((a, b) => b.createdAt - a.createdAt);
      setBossTabNotifications(list);
    }, () => {});

    return () => {
      unsubBossNotifs();
      setBossTabNotifications([]);
    };
  }, [open, userProfile?.role, activeTab, isIdleMode]);

  // Listener lazy: logs remotos de usuários (user_logs).
  // Ativo somente enquanto a aba Log Firestore está aberta.
  useEffect(() => {
    if (!open || !userProfile || userProfile.role !== "Boss" || activeTab !== "logfirestore" || globalSettings?.firestoreLoggerPaused || isIdleMode) return;
    if (isSimulationMode || !db) return;

    const unsubUserLogs = onSnapshot(collection(db, "user_logs"), (snapshot) => {
      const list = snapshot.docs.map(d => {
        const data = d.data();
        return {
          uid: d.id,
          updatedAt: data.updatedAt || "",
          stats: {
            totalReads: data.stats?.totalReads || 0,
            totalWrites: data.stats?.totalWrites || 0,
            totalDeletes: data.stats?.totalDeletes || 0,
            byCollection: (data.stats?.byCollection || {}) as Record<string, { reads: number; writes: number; deletes: number }>,
          },
        };
      });
      setRemoteUserLogs(list);
    }, () => {});

    return () => {
      unsubUserLogs();
      setRemoteUserLogs([]);
      setSelectedRemoteUid(null);
    };
  }, [open, userProfile?.role, activeTab, globalSettings?.firestoreLoggerPaused, isIdleMode]);

  const pendingUsers = useMemo(() => {
    return allUsers.filter(u => u.status === "pendente");
  }, [allUsers]);

  const activeUsers = useMemo(() => {
    return allUsers.filter(u => u.status === "aprovado" || u.status === "recusado");
  }, [allUsers]);

  const filteredActiveUsers = useMemo(() => {
    return activeUsers.filter(u =>
      u.nome.toLowerCase().includes(searchQuery.toLowerCase()) ||
      u.email.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [activeUsers, searchQuery]);

  const pendingDonations = useMemo(() => {
    return donations
      .filter(d => d.status === "pendente")
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [donations]);


  const donationRanking = useMemo(() => {
    const approved = donations.filter(d => d.status === "aprovado");
    const grouped = new Map<string, { userName: string; total: number; count: number }>();
    approved.forEach(d => {
      const current = grouped.get(d.userName) || { userName: d.userName, total: 0, count: 0 };
      current.total += d.amount;
      current.count += 1;
      grouped.set(d.userName, current);
    });
    return Array.from(grouped.values()).sort((a, b) => b.total - a.total || b.count - a.count || a.userName.localeCompare(b.userName, "pt-BR"));
  }, [donations]);

  // Salvar nome do personagem de doação no Firestore
  async function persistDonationChar() {
    const char = inputDonationChar.trim() || "A definir pelo administrador";
    setDonationChar(char);

    if (isSimulationMode || !db) {
      try {
        localStorage.setItem("chernobyl_donation_char", char);
        window.dispatchEvent(new Event("storage"));
      } catch {}
      return;
    }

    try {
      await setDoc(doc(db, "settings", "donation_settings"), {
        donationCharacter: char,
        characterName: char,
        updatedBy: currentUser?.uid || "",
        updatedAt: serverTimestamp()
      }, { merge: true });
    } catch {}
  }

  function startApproveDonation(donation: Donation) {
    setApprovalId(donation.id);
    setApprovalAmount(String(donation.amount));
  }

  async function confirmApproveDonation(id: string) {
    const parsed = parseInt(approvalAmount, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return;

    if (isSimulationMode || !db) {
      const donation = donations.find(d => d.id === id);
      const next = donations.filter(d => d.id !== id);
      setDonations(next);
      try { localStorage.setItem(DONATIONS_KEY, JSON.stringify(next)); window.dispatchEvent(new Event("storage")); } catch {}
      // Atualizar totalRcDoadoAprovado no localStorage simulado
      try {
        const raw = localStorage.getItem("chernobyl_user_stats_sim") || "{}";
        const statsMap = JSON.parse(raw);
        const uid = donation?.userId || currentUser?.uid || "";
        if (uid) {
          const prev = statsMap[uid]?.totalRcDoadoAprovado || 0;
          statsMap[uid] = { ...(statsMap[uid] || {}), totalRcDoadoAprovado: prev + parsed };
          localStorage.setItem("chernobyl_user_stats_sim", JSON.stringify(statsMap));
          window.dispatchEvent(new Event("storage"));
        }
      } catch {}
      // Ajustar delta em totalRcDoado se o Boss alterou o valor
      if (donation && donation.userId && parsed !== (donation.amount || 0)) {
        try {
          const raw = localStorage.getItem("chernobyl_user_stats_sim") || "{}";
          const statsMap = JSON.parse(raw);
          const uid = donation.userId;
          const curRc = statsMap[uid]?.totalRcDoado || 0;
          const delta = parsed - (donation.amount || 0);
          statsMap[uid] = { ...(statsMap[uid] || {}), totalRcDoado: curRc + delta };
          localStorage.setItem("chernobyl_user_stats_sim", JSON.stringify(statsMap));
          window.dispatchEvent(new Event("storage"));
        } catch {}
      }
      setApprovalId(null);
      setApprovalAmount("");
      return;
    }

    try {
      // Buscar a doação para obter o userId (dono da doação)
      const donation = donations.find(d => d.id === id);

      // IDEMPOTÊNCIA: se a doação já foi processada (status !== "pendente"),
      // apenas garante que o documento individual seja removido, sem alterar
      // novamente os acumuladores. Evita dupla contabilização.
      if (donation && donation.status !== "pendente") {
        try { await deleteDoc(doc(db, "donations", id)); } catch {}
        setApprovalId(null);
        setApprovalAmount("");
        return;
      }

      // 1. Incrementar totalRcDoadoAprovado em userStats/{uid}.
      //    Este é o ÚNICO valor usado pelo Ranking do DonationModal.
      //    Usa setDoc com merge para criar o documento se não existir.
      if (donation && donation.userId) {
        try {
          await setDoc(doc(db, "userStats", donation.userId), {
            totalRcDoadoAprovado: increment(parsed)
          }, { merge: true });
        } catch {}
      }

      // 2. Sincronizar totalRcDoado com totalRcDoadoAprovado (camada de segurança).
      //    Após aprovação, ambos os campos devem ficar iguais. Lê o valor atual
      //    de totalRcDoadoAprovado (já incrementado) e força totalRcDoado igual.
      if (donation && donation.userId) {
        try {
          const userStatsDoc = await getDoc(doc(db, "userStats", donation.userId));
          if (userStatsDoc.exists()) {
            const data = userStatsDoc.data();
            const valorAprovado = data.totalRcDoadoAprovado || 0;
            await setDoc(doc(db, "userStats", donation.userId), {
              totalRcDoado: valorAprovado
            }, { merge: true });
          }
        } catch {}
      }

      // 3. Após concluir a atualização dos acumuladores, excluir o documento
      //    individual da doação. Não é mais necessário mantê-lo.
      try { await deleteDoc(doc(db, "donations", id)); } catch {}

      setApprovalId(null);
      setApprovalAmount("");
    } catch {}
  }

  async function refuseDonation(id: string) {
    // Buscar a doação antes de recusar para obter o uid do usuário e o valor
    const donation = donations.find(d => d.id === id);

    if (isSimulationMode || !db) {
      const next = donations.map(d => d.id === id ? { ...d, status: "recusado" as const } : d);
      setDonations(next);
      try { localStorage.setItem(DONATIONS_KEY, JSON.stringify(next)); window.dispatchEvent(new Event("storage")); } catch {}
      if (approvalId === id) {
        setApprovalId(null);
        setApprovalAmount("");
      }
      return;
    }

    try {
      // IDEMPOTÊNCIA: se a doação já foi processada (status !== "pendente"),
      // apenas garante que o documento individual seja removido, sem alterar
      // novamente os acumuladores.
      if (donation && donation.status !== "pendente") {
        try { await deleteDoc(doc(db, "donations", id)); } catch {}
        if (approvalId === id) {
          setApprovalId(null);
          setApprovalAmount("");
        }
        return;
      }

      // 1. Sincronizar totalRcDoado com totalRcDoadoAprovado (camada de segurança).
      //    Após recusa, ambos os campos devem ficar iguais. Lê o valor atual
      //    de totalRcDoadoAprovado (não alterado pela recusa) e força totalRcDoado igual.
      //    Isso automaticamente remove o valor da doação recusada do Valor Registrado.
      if (donation && donation.userId) {
        try {
          const userStatsDoc = await getDoc(doc(db, "userStats", donation.userId));
          if (userStatsDoc.exists()) {
            const data = userStatsDoc.data();
            const valorAprovado = data.totalRcDoadoAprovado || 0;
            await setDoc(doc(db, "userStats", donation.userId), {
              totalRcDoado: valorAprovado
            }, { merge: true });
          }
        } catch {}
      }

      // 2. Excluir o documento individual da doação recusada.
      try { await deleteDoc(doc(db, "donations", id)); } catch {}

      if (approvalId === id) {
        setApprovalId(null);
        setApprovalAmount("");
      }
    } catch {}
  }

  if (!open || !userProfile || userProfile.role !== "Boss") return null;

  // Funções de limpeza das coleções do Firestore
  async function handleCleanNotifications() {
    if (!db || isSimulationMode) return;
    if (!confirm(`Deseja remover todas as notificações com mais de ${hoursThreshold} horas? Esta ação não pode ser desfeita.`)) return;
    setCleaningNotifications(true);
    setCleanResult(null);
    try {
      const cutoffMs = Date.now() - hoursThreshold * 60 * 60 * 1000;
      const q = query(collection(db, "notifications"), where("createdAt", "<", cutoffMs));
      const snap = await getDocs(q);
      const batch = snap.docs.map(d => deleteDoc(doc(db, "notifications", d.id)));
      await Promise.all(batch);
      setCleanResult({ success: true, message: `${batch.length} notificação(ões) removida(s) com sucesso.` });
    } catch {
      setCleanResult({ success: false, message: "Erro ao limpar notificações." });
    } finally {
      setCleaningNotifications(false);
    }
  }


  // Tab configuration array for clean rendering
  const tabs: Array<{
    key: "pending" | "users" | "notifications" | "donations" | "vip" | "logfirestore" | "colections" | "settings";
    label: string;
    icon: React.ReactNode;
    badge?: React.ReactNode;
  }> = [
    {
      key: "pending",
      label: "Solicitações",
      icon: <Clock size={13} className="text-amber-400" />,
      badge: pendingUsers.length > 0 ? (
        <span className="px-1.5 py-0.2 rounded bg-amber-500 text-black text-[9px] font-bold font-mono">
          {pendingUsers.length}
        </span>
      ) : undefined,
    },
    {
      key: "users",
      label: pendingUsers.length > 0 ? `Usuários (${pendingUsers.length})` : "Usuários",
      icon: <Users size={13} className="text-emerald-400" />,
      badge: (
        <span className="px-1.5 py-0.2 rounded bg-emerald-500/10 text-emerald-400 text-[9px] border border-emerald-500/30 font-bold font-mono">
          {activeUsers.length}
        </span>
      ),
    },
    {
      key: "notifications",
      label: (bossTabNotifications.length || externalPendingRequestsCount) > 0 ? `Notificações (${bossTabNotifications.length || externalPendingRequestsCount})` : "Notificações",
      icon: <ShieldAlert size={13} className="text-violet-400" />,
      badge: (bossTabNotifications.length || externalPendingRequestsCount) > 0 ? (
        <span className="px-1.5 py-0.2 rounded bg-violet-500 text-black text-[9px] font-bold font-mono">
          {bossTabNotifications.length || externalPendingRequestsCount}
        </span>
      ) : undefined,
    },
    {
      key: "donations",
      label: (pendingDonations.length || externalPendingDonationsCount) > 0 ? `Doações (${pendingDonations.length || externalPendingDonationsCount})` : "Doações",
      icon: <HeartHandshake size={13} className="text-amber-400" />,
      badge: (pendingDonations.length || externalPendingDonationsCount) > 0 ? (
        <span className="px-1.5 py-0.2 rounded bg-amber-500 text-black text-[9px] font-bold font-mono">
          {pendingDonations.length || externalPendingDonationsCount}
        </span>
      ) : undefined,
    },
    {
      key: "vip",
      label: (pendingVipRequestsCount || externalPendingVipCount) > 0 ? `VIP (${pendingVipRequestsCount || externalPendingVipCount})` : "VIP",
      icon: <Crown size={13} className="text-amber-400" />,
      badge: (pendingVipRequestsCount || externalPendingVipCount) > 0 ? (
        <span className="px-1.5 py-0.2 rounded bg-amber-500 text-black text-[9px] font-bold font-mono">
          {pendingVipRequestsCount || externalPendingVipCount}
        </span>
      ) : undefined,
    },
    {
      key: "logfirestore",
      label: "Log Firestore",
      icon: <Activity size={13} className="text-sky-400" />,
      badge: (
        <span className="px-1.5 py-0.2 rounded bg-sky-500/10 text-sky-300 text-[9px] border border-sky-500/30 font-bold font-mono">
          {firestoreLogs.length}
        </span>
      ),
    },
    {
      key: "colections",
      label: "Coleções Firestore",
      icon: <Database size={13} className="text-rose-400" />,
    },
    {
      key: "settings",
      label: "Configurações",
      icon: <Settings size={13} className="text-slate-400" />,
    },
  ];

  return (
    <div
      className="app-modal-overlay fixed inset-0 z-[400] flex items-center justify-center bg-black/75 backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="app-modal-frame app-modal-size-xl app-modal-frame--scroll bg-[var(--th-n-elev)] border border-white/10 rounded-2xl shadow-2xl w-full max-w-4xl" style={{ height: "min(85dvh, 58rem)" }}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/5 bg-[var(--th-n-hi)] flex-shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-violet-500/20 border border-violet-500/40 flex items-center justify-center">
              <Shield size={16} className="text-violet-400" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white tracking-wide">Painel do Fundador (Boss)</h3>
              <p className="text-[10px] text-slate-400">Gerenciamento de acessos, permissões e solicitações de entrada.</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1.5 rounded-lg hover:bg-white/5 transition-colors cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>

        {/* Local warning */}
        {isSimulation && (
          <div className="bg-amber-500/10 border-b border-amber-500/25 px-4 py-1.5 text-center text-[10px] text-amber-400 font-bold uppercase tracking-wider">
            Simulação de Banco de Dados Local Ativa (Mudanças salvas no navegador)
          </div>
        )}

        {/* Tab Selection — MODIFIED: flex-wrap grid layout, no horizontal scroll */}
        <div className="bg-[var(--th-n-panel)] border-b border-white/10 p-1.5 flex-shrink-0">
          <div className="flex flex-wrap gap-1">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => {
                  setActiveTab(tab.key);
                }}
                className={`flex-1 min-w-[140px] py-2 text-xs font-bold rounded-lg transition-all flex items-center justify-center gap-2 cursor-pointer ${
                  activeTab === tab.key
                    ? "bg-[var(--th-n-hi)] border border-white/10 text-white shadow-md"
                    : "text-slate-500 hover:bg-white/5 hover:text-slate-350 border border-transparent"
                }`}
              >
                {tab.icon}
                <span>{tab.label}</span>
                {tab.badge}
              </button>
            ))}
          </div>
        </div>

        {/* Content Area */}
        <div className="app-modal-body p-4 sm:p-5">
          {activeTab === "pending" && (
            pendingUsers.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-slate-500 italic text-xs gap-3">
                <CheckCircle2 size={36} className="text-emerald-500/40" />
                <span>Nenhuma solicitação de entrada pendente. Bom trabalho!</span>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                {pendingUsers.map((user) => (
                  <div key={user.uid} className="bg-[var(--th-n-panel)] border border-white/5 hover:border-white/10 rounded-xl p-4 flex flex-col justify-between gap-3 transition-all duration-200">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="w-8 h-8 rounded-lg bg-amber-500/10 border border-amber-500/30 flex items-center justify-center font-bold text-amber-400">
                          {user.nome.charAt(0).toUpperCase()}
                        </span>
                        <div>
                          <h4 className="text-xs font-bold text-white tracking-wide">{user.nome}</h4>
                          <span className="text-[10px] text-slate-500 font-mono block">{user.email}</span>
                        </div>
                      </div>
                      <div className="pt-2 text-[9px] text-slate-500 flex items-center gap-1.5">
                        <Calendar size={10} />
                        <span>Cadastrado em: {new Date(user.createdAt).toLocaleString("pt-BR")}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 pt-2 border-t border-white/5">
                      <button
                        onClick={() => approveUser(user.uid)}
                        className="flex-1 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-black text-[10px] font-black flex items-center justify-center gap-1 cursor-pointer transition-colors shadow-lg shadow-emerald-500/10"
                      >
                        <Check size={12} /> Aprovar
                      </button>
                      <button
                        onClick={() => refuseUser(user.uid)}
                        className="flex-1 py-1.5 rounded-lg border border-rose-500/40 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20 text-[10px] font-black flex items-center justify-center gap-1 cursor-pointer transition-colors"
                      >
                        <X size={12} /> Recusar
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )
          )}
          {activeTab === "users" && (
            <div className="flex flex-col h-full gap-3">
              <div className="relative flex-shrink-0">
                <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Pesquisar por nome ou e-mail..." className="w-full bg-[var(--th-n-panel)] border border-white/10 focus:border-red-500/50 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none placeholder-slate-600 transition-colors" />
              </div>
              <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2 text-[10px] text-amber-300 flex items-center gap-2">
                <Info size={12} className="text-amber-400 flex-shrink-0" />
                <span>💡 Botões <strong>+ VIP</strong> e <strong>- VIP</strong> gerenciam o timestamp de expiração. Para promover alguém ao cargo Boss, edite manualmente na Firestore.</span>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto border border-white/5 rounded-xl bg-[var(--th-n-panel)]">
                <table className="w-full border-collapse text-left text-xs">
                  <thead>
                    <tr className="bg-[var(--th-n-hi)]/60 border-b border-white/5">
                      <th className="px-4 py-2.5 font-bold uppercase tracking-wider text-slate-400">Usuário</th>
                      <th className="px-4 py-2.5 font-bold uppercase tracking-wider text-slate-400">Status</th>
                      <th className="px-4 py-2.5 font-bold uppercase tracking-wider text-slate-400">Visto por último</th>
                      <th className="px-4 py-2.5 font-bold uppercase tracking-wider text-slate-400 text-center">Média Doação</th>
                      <th className="px-4 py-2.5 font-bold uppercase tracking-wider text-slate-400 text-right">Ações</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredActiveUsers.length === 0 ? (
                      <tr><td colSpan={5} className="text-center py-10 text-slate-500 italic">Nenhum usuário correspondente encontrado.</td></tr>
                    ) : (
                      filteredActiveUsers.map((user) => (
                        <tr key={user.uid} className="border-b border-white/5 hover:bg-white/[0.01] transition-colors">
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <span className="w-6 h-6 rounded bg-slate-800 border border-white/5 flex items-center justify-center font-bold text-slate-300 text-[10px]">{user.nome.charAt(0).toUpperCase()}</span>
                              <div>
                                <div className="flex items-center gap-2">
                                  <span className="font-bold text-white block">{user.nome}</span>
                                  {(() => {
                                    const effectiveRole = (() => {
                                      if (user.role === "Boss") return "Boss";
                                      const expMs = getVipEffectiveExpirationMillis(user);
                                      if (expMs > Date.now()) return "VIP";
                                      return "Normal";
                                    })();
                                    return (
                                      <span className={`px-2 py-0.5 rounded-full border text-[9px] font-black uppercase tracking-wider ${
                                        effectiveRole === "Boss"
                                          ? "bg-violet-500/10 border-violet-500/30 text-violet-300"
                                          : effectiveRole === "VIP"
                                            ? "bg-amber-500/10 border-amber-500/30 text-amber-300"
                                            : "bg-slate-500/10 border-slate-500/30 text-slate-400"
                                      }`}>
                                        {effectiveRole}
                                      </span>
                                    );
                                  })()}
                                </div>
                                {(() => {
                                  const effectiveRole = user.role === "Boss" ? "Boss" : (getVipEffectiveExpirationMillis(user) > Date.now() ? "VIP" : "Normal");
                                  if (effectiveRole === "VIP") {
                                    const expiresAt = getVipEffectiveExpirationMillis(user);
                                    return (
                                      <div className="text-[9px] text-amber-400/80 font-medium mt-0.5">
                                        VIP até {formatVipExpirationDate(expiresAt)}
                                      </div>
                                    );
                                  }
                                  return null;
                                })()}
                                <span className="text-[10px] text-slate-500 font-mono block">{user.email}</span>
                                {(user.rateLimitBlocks || 0) > 0 && (
                                  <button type="button" onClick={() => handleResetBlocks(user.uid)} className={`inline-flex items-center gap-1 mt-0.5 px-1.5 py-0.5 rounded text-[9px] font-bold border uppercase tracking-wider cursor-pointer transition-colors ${confirmResetUid === user.uid ? "border-amber-400 bg-amber-500/25 text-amber-200 animate-pulse shadow-sm shadow-amber-500/30" : "border-rose-500/40 bg-rose-500/10 text-rose-300 hover:bg-rose-500/25 hover:border-rose-500/60"}`} title={confirmResetUid === user.uid ? "Clique novamente para confirmar o reset" : "Clique para resetar a contagem de bloqueios deste usuário"}>
                                    {confirmResetUid === user.uid ? <>↻ Confirmar reset?</> : <>⚠ {user.rateLimitBlocks} bloqueio{(user.rateLimitBlocks || 0) > 1 ? "s" : ""} por uso excessivo</>}
                                  </button>
                                )}
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold border uppercase tracking-wider ${user.status === "aprovado" ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400" : "bg-rose-500/10 border-rose-500/30 text-rose-450"}`}>{user.status}</span>
                          </td>
                          <td className="px-4 py-3">
                            {(() => {
                              if (globalSettings?.presenceEnabled === false) {
                                return (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-bold border border-slate-500/30 bg-slate-500/10 text-slate-400 uppercase tracking-wider">
                                    Presence pausado
                                  </span>
                                );
                              }
                              const p = presenceMap[user.uid];
                              const online = isUserOnline(p?.lastActivityAt);
                              return (
                                <div className="space-y-1">
                                  {online ? (
                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-bold border border-emerald-500/40 bg-emerald-500/15 text-emerald-300 uppercase tracking-wider shadow-sm shadow-emerald-500/20">
                                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]" />Online
                                    </span>
                                  ) : (
                                    <span className="px-2 py-0.5 rounded-full text-[9px] font-bold border border-slate-500/30 bg-slate-500/10 text-slate-400 uppercase tracking-wider">
                                      Offline
                                    </span>
                                  )}
                                  <div className="text-[8px] text-slate-500 flex flex-col font-mono leading-tight">
                                    <span>Ativ: {formatPresenceTime(p?.lastActivityAt)}</span>
                                    <span>In: {formatPresenceTime(p?.lastLoginAt)}</span>
                                    <span>Out: {formatPresenceTime(p?.lastLogoutAt)}</span>
                                  </div>
                                </div>
                              );
                            })()}
                          </td>
                          <td className="px-4 py-3 text-center">
                            {(() => {
                              const stats = userStatsMap[user.uid];
                              const totalRcAprovado = stats?.totalRcDoadoAprovado || 0;
                              const totalPtsConcluidas = stats?.totalPtsConcluidas || 0;
                              const media = totalPtsConcluidas > 0 ? Math.round(totalRcAprovado / totalPtsConcluidas) : 0;
                              const isBelow = media < minAverage;
                              return (
                                <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-bold tabular-nums ${
                                  isBelow
                                    ? "bg-amber-500/10 border border-amber-500/30 text-amber-300"
                                    : "bg-emerald-500/10 border border-emerald-500/30 text-emerald-300"
                                }`}>
                                  <HeartHandshake size={12} className={isBelow ? "text-amber-400" : "text-emerald-400"} />
                                  {media} RC/PT
                                </span>
                              );
                            })()}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <div className="flex flex-col items-end gap-1.5">
                              {/* Botões de controle de VIP — visíveis para qualquer usuário aprovado */}
                              {user.role !== "Boss" && (
                                <div className="flex flex-col items-end gap-1">
                                  <div className="flex items-center gap-1">
                                    <input
                                      type="number"
                                      min={1}
                                      step={1}
                                      value={manualVipDaysByUser[user.uid] || ""}
                                      onChange={(event) => {
                                        const value = event.target.value.replace(/[^\d]/g, "");
                                        setManualVipDaysByUser(prev => ({ ...prev, [user.uid]: value }));
                                        setManualVipMessages(prev => {
                                          const next = { ...prev };
                                          delete next[user.uid];
                                          return next;
                                        });
                                      }}
                                      placeholder="Dias"
                                      className="w-16 rounded-lg border border-white/10 bg-[var(--th-n-elev)] px-2 py-1 text-[10px] font-mono text-white outline-none transition-colors focus:border-emerald-500/50"
                                      title="Quantidade de dias de VIP a adicionar"
                                    />
                                  <button
                                    type="button"
                                    onClick={() => addManualVipCredit(user)}
                                    disabled={processingManualVipUserIds.has(user.uid) || !Number.isInteger(Number(manualVipDaysByUser[user.uid])) || Number(manualVipDaysByUser[user.uid]) <= 0}
                                    className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/25 text-[10px] font-bold transition-colors cursor-pointer whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed"
                                    title="Adicionar a quantidade informada de dias de VIP"
                                  >
                                    <Crown size={10} />{processingManualVipUserIds.has(user.uid) ? "..." : "+ VIP"}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={async () => {
                                      // - VIP: remove todo o tempo restante (define vipExpiresAt = 0)
                                      if (isSimulationMode || !db) {
                                        const updatedUsers = allUsers.map(u => u.uid === user.uid
                                          ? { ...u, vipExpiresAt: 0, vipDays: 0 }
                                          : u
                                        );
                                        try { localStorage.setItem("tibia_sim_users", JSON.stringify(updatedUsers)); window.dispatchEvent(new Event("storage")); } catch {}
                                        return;
                                      }

                                      try {
                                        await updateDoc(doc(db, "users", user.uid), {
                                          vipExpiresAt: Timestamp.fromMillis(0),
                                          vipDays: 0,
                                          vipUpdatedAt: serverTimestamp(),
                                        });
                                      } catch (err) {
                                        console.error("Erro ao remover VIP:", err);
                                      }
                                    }}
                                    className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-rose-500/15 border border-rose-500/40 text-rose-300 hover:bg-rose-500/25 text-[10px] font-bold transition-colors cursor-pointer whitespace-nowrap"
                                    title="Remover todo o tempo de VIP"
                                  >
                                    <X size={10} />- VIP
                                  </button>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={async () => {
                                      const nextServiceiro = !(user as any).serviceiro;
                                      if (isSimulationMode || !db) {
                                        const updatedUsers = allUsers.map(u => u.uid === user.uid ? { ...u, serviceiro: nextServiceiro } : u);
                                        try { localStorage.setItem("tibia_sim_users", JSON.stringify(updatedUsers)); window.dispatchEvent(new Event("storage")); } catch {}
                                        return;
                                      }
                                      try {
                                        await updateDoc(doc(db, "users", user.uid), { serviceiro: nextServiceiro });
                                      } catch (err) {
                                        console.error("Erro ao alterar permissão de Serviceiro:", err);
                                      }
                                    }}
                                    className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-bold transition-colors cursor-pointer whitespace-nowrap border ${
                                      (user as any).serviceiro
                                        ? "bg-cyan-500/15 border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/25"
                                        : "bg-white/5 border-white/10 text-slate-400 hover:bg-white/10 hover:text-slate-200"
                                    }`}
                                    title="Autorizar ou remover este usuário da lista de Serviceiros do Formulário Público"
                                  >
                                    <Star size={10} /> Serviceiro: {(user as any).serviceiro ? "Sim" : "Não"}
                                  </button>
                                  {manualVipMessages[user.uid] && (
                                    <span className={`text-[9px] font-bold ${manualVipMessages[user.uid].type === "success" ? "text-emerald-400" : "text-rose-400"}`}>
                                      {manualVipMessages[user.uid].text}
                                    </span>
                                  )}
                                </div>
                              )}
                              {/* Aprovar / Recusar */}
                              {user.role !== "Boss" && (
                                <div className="flex items-center gap-1">
                                  {user.status === "recusado" && (
                                    <button onClick={() => approveUser(user.uid)} className="p-1 rounded bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 border border-emerald-500/30 hover:text-white transition-colors cursor-pointer" title="Aprovar Usuário"><Check size={12} /></button>
                                  )}
                                  {user.status === "aprovado" && (
                                    <button onClick={() => refuseUser(user.uid)} className="p-1 rounded bg-rose-500/15 text-rose-400 hover:bg-rose-500/25 border border-rose-500/30 hover:text-white transition-colors cursor-pointer" title="Recusar/Desativar Usuário"><X size={12} /></button>
                                  )}
                                </div>
                              )}
                              {user.role === "Boss" && (
                                <span className="text-[10px] text-slate-500 italic">Protegido</span>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {activeTab === "vip" && (
            <div className="flex flex-col gap-4 h-full">
              {/* Configuração dos Planos VIP */}
              <div className="bg-[var(--th-n-panel)] border border-amber-500/30 rounded-xl p-4 space-y-3 flex-shrink-0 shadow-lg shadow-amber-950/20">
                <div className="flex items-center justify-between border-b border-white/5 pb-2 flex-wrap gap-2">
                  <div className="flex items-center gap-2 text-sm font-bold text-amber-300">
                    <Crown size={15} className="text-amber-400" />
                    <span>Configuração dos Planos VIP</span>
                  </div>
                  <span className="text-[10px] text-slate-400">Valores em RC exibidos e aplicados no fluxo Seja VIP</span>
                </div>

                {vipPlansSaveMessage && (
                  <div className={`px-3 py-1.5 rounded-lg border text-xs font-bold ${
                    vipPlansSaveMessage.type === "success"
                      ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
                      : "bg-rose-500/10 border-rose-500/30 text-rose-300"
                  }`}>
                    {vipPlansSaveMessage.text}
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {/* Plano 30 dias */}
                  <div className="p-3 bg-black/40 border border-white/5 rounded-xl space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-black text-amber-300 uppercase tracking-wide">Plano 30 Dias</span>
                      <span className="px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/20 text-amber-400 text-[10px] font-mono font-bold">Duração: 30 dias</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="text-[11px] text-slate-400 font-semibold flex-shrink-0">Valor em RC:</label>
                      <input
                        type="number"
                        min={0}
                        value={plan30PriceInput}
                        onChange={(e) => setPlan30PriceInput(e.target.value.replace(/[^\d]/g, ""))}
                        className="w-full bg-[var(--th-n-elev)] border border-white/10 rounded-lg px-2.5 py-1.5 text-sm text-white font-mono font-bold focus:outline-none focus:border-amber-500/50 tabular-nums"
                        placeholder="100"
                      />
                    </div>
                  </div>

                  {/* Plano 90 dias */}
                  <div className="p-3 bg-black/40 border border-white/5 rounded-xl space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-black text-amber-300 uppercase tracking-wide">Plano 90 Dias</span>
                      <span className="px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/20 text-amber-400 text-[10px] font-mono font-bold">Duração: 90 dias</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="text-[11px] text-slate-400 font-semibold flex-shrink-0">Valor em RC:</label>
                      <input
                        type="number"
                        min={0}
                        value={plan90PriceInput}
                        onChange={(e) => setPlan90PriceInput(e.target.value.replace(/[^\d]/g, ""))}
                        className="w-full bg-[var(--th-n-elev)] border border-white/10 rounded-lg px-2.5 py-1.5 text-sm text-white font-mono font-bold focus:outline-none focus:border-amber-500/50 tabular-nums"
                        placeholder="250"
                      />
                    </div>
                  </div>
                </div>

                <div className="flex justify-end pt-1">
                  <button
                    type="button"
                    onClick={handleSaveVipPlans}
                    disabled={vipPlansSaving}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-gradient-to-r from-amber-600 to-amber-700 hover:from-amber-500 hover:to-amber-600 text-black text-xs font-black shadow-md transition-all cursor-pointer disabled:opacity-50"
                  >
                    <Save size={13} />
                    {vipPlansSaving ? "Salvando..." : "Salvar Configuração dos Planos"}
                  </button>
                </div>
              </div>

              {/* Solicitações de Crédito VIP */}
              <div className="flex items-center justify-between gap-3 flex-wrap flex-shrink-0">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-lg bg-amber-500/15 border border-amber-500/35 flex items-center justify-center">
                    <Crown size={16} className="text-amber-400" />
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-white">Solicitações de Crédito VIP</h4>
                    <p className="text-[10px] text-slate-500">Aprovação credita dias; recusa mantém o histórico sem créditos.</p>
                  </div>
                </div>
                <div className="text-[10px] text-slate-400">
                  Pendentes: <strong className="text-amber-300 tabular-nums">{pendingVipRequestsCount}</strong>
                  <span className="mx-2 text-slate-700">|</span>
                  Total: <strong className="text-white tabular-nums">{vipRequests.length}</strong>
                </div>
              </div>

              {vipActionMessage && (
                <div className={`px-3 py-2 rounded-lg border text-xs font-bold ${
                  vipActionMessage.type === "success"
                    ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
                    : "bg-rose-500/10 border-rose-500/30 text-rose-300"
                }`}>
                  {vipActionMessage.text}
                </div>
              )}

              <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-1">
                {vipRequests.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-20 text-slate-500 italic text-xs gap-3">
                    <Crown size={36} className="text-amber-500/30" />
                    <span>Nenhuma solicitação VIP registrada.</span>
                  </div>
                ) : (
                  vipRequests.map(request => {
                    const targetUser = allUsers.find(user => user.uid === request.userId);
                    const targetVipExpiration = getVipEffectiveExpirationMillis(targetUser);
                    const processing = processingVipRequestIds.has(request.id);
                    const statusClass = request.status === "aprovado"
                      ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
                      : request.status === "recusado"
                        ? "bg-rose-500/10 border-rose-500/30 text-rose-300"
                        : "bg-amber-500/10 border-amber-500/30 text-amber-300";
                    const statusLabel = request.status === "aprovado"
                      ? "Aprovada"
                      : request.status === "recusado"
                        ? "Recusada"
                        : "Pendente";

                    return (
                      <div key={request.id} className="bg-[var(--th-n-panel)] border border-white/5 hover:border-white/10 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 transition-colors">
                        <div className="min-w-0 space-y-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-bold text-white text-sm truncate">{request.userName || "Anônimo"}</span>
                            <span className={`px-2 py-0.5 rounded-full border text-[9px] font-black uppercase tracking-wider ${statusClass}`}>
                              {statusLabel}
                            </span>
                          </div>
                          <div className="text-[10px] text-slate-500 font-mono truncate">{request.userEmail || request.userId}</div>
                          <div className="flex items-center gap-3 flex-wrap text-[11px]">
                            <span className="text-slate-400">Dias solicitados: <strong className="text-amber-300 tabular-nums">{request.requestedDays}</strong></span>
                            <span className="text-slate-400">Meses: <strong className="text-violet-300 tabular-nums">{request.requestedMonths || request.requestedDays / 30}</strong></span>
                            <span className="text-slate-400">De: <strong className="text-amber-300 font-mono">{request.fromCharacter || "—"}</strong></span>
                            <span className="text-slate-400">VIP termina: <strong className="text-emerald-300">{formatVipExpirationDate(targetVipExpiration)}</strong></span>
                            <span className="text-slate-400">Tempo restante: <strong className="text-emerald-300">{formatVipRemainingTime(targetVipExpiration)}</strong></span>
                            <span className="text-slate-500">Data: {formatVipRequestDate(request)}</span>
                          </div>
                        </div>

                        {request.status === "pendente" && (
                          <div className="flex items-center gap-2 flex-shrink-0">
                            <button
                              type="button"
                              onClick={() => approveVipRequest(request)}
                              disabled={processing}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/25 text-xs font-bold transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              <Check size={12} /> {processing ? "Processando..." : "Aprovar"}
                            </button>
                            <button
                              type="button"
                              onClick={() => refuseVipRequest(request)}
                              disabled={processing}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-500/15 border border-rose-500/40 text-rose-300 hover:bg-rose-500/25 text-xs font-bold transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              <X size={12} /> Recusar
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}
          {activeTab === "notifications" && (
            <div className="flex flex-col gap-3 h-full">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-2 flex-shrink-0">
                <div className="flex items-center gap-2 text-xs font-bold text-violet-200">
                  <ShieldAlert size={14} className="text-violet-400" />
                  <span>Notificações Administrativas ({bossTabNotifications.length})</span>
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    if (!confirm("Remover todas as notificações administrativas destinadas ao Boss?")) return;
                    if (!db) return;
                    try {
                      const q = query(collection(db, "notifications"), where("targetRole", "==", "Boss"));
                      const snap = await getDocs(q);
                      await Promise.all(snap.docs.map(d => deleteDoc(doc(db, "notifications", d.id))));
                    } catch {}
                    setBossTabNotifications([]);
                  }}
                  className="px-3 py-1 rounded-lg bg-rose-500/15 border border-rose-500/40 text-rose-300 hover:bg-rose-500/25 text-[10px] font-bold transition-colors cursor-pointer"
                >
                  Limpar Tudo
                </button>
              </div>
              {(() => {
                const activeNotifs = bossTabNotifications;
                if (activeNotifs.length === 0) return (<div className="flex flex-col items-center justify-center py-20 text-slate-500 italic text-xs gap-3"><CheckCircle2 size={36} className="text-emerald-500/40" /><span>Nenhuma notificação administrativa. Bom trabalho!</span></div>);
                return (
                  <div className="space-y-2 overflow-y-auto flex-1">
                    {activeNotifs.map((notif) => (
                      <div key={notif.id} className="bg-[var(--th-n-panel)] border border-white/5 rounded-xl p-3 flex items-start justify-between gap-4">
                        <div className="space-y-1 min-w-0">
                          <h4 className="text-xs font-bold text-white flex items-center gap-1.5"><ShieldAlert size={12} className="text-violet-400 flex-shrink-0" /><span className="truncate">{notif.title}</span></h4>
                          <p className="text-[11px] text-slate-400 leading-relaxed">{notif.body}</p>
                          <div className="text-[9px] text-slate-500 font-mono flex items-center gap-2">
                            {(notif as any).userName && (notif as any).userName !== "Anônimo" && (<span className="text-emerald-400 font-semibold">👤 {(notif as any).userName}</span>)}
                            <span>Recebida em: {new Date(notif.createdAt).toLocaleString("pt-BR")}</span>
                          </div>
                        </div>
                        <button
                          onClick={async () => {
                            try { await deleteDoc(doc(db, "notifications", notif.id)); } catch {}
                            setBossTabNotifications(prev => prev.filter(n => n.id !== notif.id));
                          }}
                          className="px-2 py-1 bg-white/5 border border-white/10 hover:bg-rose-500/20 hover:border-rose-500/30 hover:text-rose-300 rounded text-[10px] text-slate-300 transition-colors cursor-pointer flex-shrink-0"
                        >
                          Ignorar
                        </button>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>
          )}
          {activeTab === "logfirestore" && (
            <div className="flex flex-col gap-4 h-full">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="rounded-xl border border-sky-500/30 bg-sky-500/10 p-4"><div className="text-[10px] uppercase tracking-wider text-sky-300 font-bold">Leituras</div><div className="mt-2 text-2xl font-black text-sky-200 tabular-nums">{firestoreStats.totalReads}</div></div>
                <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4"><div className="text-[10px] uppercase tracking-wider text-emerald-300 font-bold">Gravações</div><div className="mt-2 text-2xl font-black text-emerald-200 tabular-nums">{firestoreStats.totalWrites}</div></div>
                <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-4"><div className="text-[10px] uppercase tracking-wider text-rose-300 font-bold">Exclusões</div><div className="mt-2 text-2xl font-black text-rose-200 tabular-nums">{firestoreStats.totalDeletes}</div></div>
              </div>
              <div className="bg-[var(--th-n-panel)] border border-white/5 rounded-xl overflow-hidden flex flex-col" style={{ maxHeight: "180px" }}>
                <div className="px-4 py-2.5 bg-[var(--th-n-hi)]/60 border-b border-white/5 text-xs font-bold uppercase tracking-wider text-slate-400 flex-shrink-0">Consumo por coleção</div>
                <div className="overflow-y-auto overflow-x-auto flex-1">
                  <table className="w-full border-collapse text-left text-xs">
                    <thead className="sticky top-0 z-10"><tr className="bg-[var(--th-n-elev)] border-b border-white/5"><th className="px-4 py-2 font-bold uppercase tracking-wider text-slate-500">Coleção</th><th className="px-4 py-2 font-bold uppercase tracking-wider text-sky-400">Reads</th><th className="px-4 py-2 font-bold uppercase tracking-wider text-emerald-400">Writes</th><th className="px-4 py-2 font-bold uppercase tracking-wider text-rose-400">Deletes</th></tr></thead>
                    <tbody>{Object.keys(firestoreStats.byCollection).length === 0 ? (<tr><td colSpan={4} className="px-4 py-6 text-center text-slate-500 italic">Nenhuma coleção registrada ainda.</td></tr>) : (Object.entries(firestoreStats.byCollection).map(([collectionName, stats]) => (<tr key={collectionName} className="border-b border-white/5 last:border-b-0"><td className="px-4 py-2 text-white font-medium">{collectionName}</td><td className="px-4 py-2 text-sky-300 tabular-nums">{stats.reads}</td><td className="px-4 py-2 text-emerald-300 tabular-nums">{stats.writes}</td><td className="px-4 py-2 text-rose-300 tabular-nums">{stats.deletes}</td></tr>)))}</tbody>
                  </table>
                </div>
              </div>
              <div className="bg-[var(--th-n-panel)] border border-white/5 rounded-xl overflow-hidden flex flex-col" style={{ maxHeight: "400px" }}>
                <div className="px-4 py-2.5 bg-[var(--th-n-hi)]/60 border-b border-white/5 flex items-center justify-between gap-3 flex-shrink-0">
                  <div className="text-xs font-bold uppercase tracking-wider text-amber-400">Consumo por Usuário</div>
                  <div className="flex items-center gap-2">
                    {selectedRemoteUid && (() => { const remoteEntry = remoteUserLogs.find(e => e.uid === selectedRemoteUid); if (!remoteEntry) return null; return (<button type="button" onClick={() => { try { const remoteUser = allUsers.find(u => u.uid === selectedRemoteUid); const rs = remoteEntry.stats; const lines: string[] = []; lines.push(`📊 Resumo de Log — ${remoteUser?.nome || selectedRemoteUid}`); if (remoteUser?.email) lines.push(`E-mail: ${remoteUser.email}`); lines.push(`Última atualização: ${remoteEntry.updatedAt ? new Date(remoteEntry.updatedAt).toLocaleString("pt-BR") : "—"}`); lines.push(""); lines.push(`Totais: Reads: ${rs.totalReads} | Writes: ${rs.totalWrites} | Deletes: ${rs.totalDeletes}`); lines.push(""); lines.push("Consumo por Coleção:"); if (Object.keys(rs.byCollection).length === 0) { lines.push("  (nenhuma coleção registrada)"); } else { Object.entries(rs.byCollection).forEach(([colName, colStats]) => { lines.push(`  ${colName} — Reads: ${colStats.reads} | Writes: ${colStats.writes} | Deletes: ${colStats.deletes}`); }); } navigator.clipboard.writeText(lines.join("\n")).then(() => { setRemoteLogCopied(true); setTimeout(() => setRemoteLogCopied(false), 2000); }).catch(() => {}); } catch {} }} className={`inline-flex items-center gap-1 px-3 py-1 rounded-lg border text-[10px] font-bold transition-colors cursor-pointer ${remoteLogCopied ? "bg-emerald-500/15 border-emerald-500/30 text-emerald-300" : "bg-amber-500/15 border-amber-500/30 text-amber-300 hover:bg-amber-500/25"}`} title="Copiar resumo do usuário para a área de transferência">{remoteLogCopied ? <ClipboardCheck size={11} /> : <Copy size={11} />}{remoteLogCopied ? "Copiado!" : "Copiar Resumo"}</button>); })()}
                    <select value={selectedRemoteUid || ""} onChange={(e) => { setSelectedRemoteUid(e.target.value || null); setRemoteLogCopied(false); }} className="bg-[var(--th-n-elev)] border border-white/10 rounded px-2 py-1 text-[10px] text-white focus:outline-none focus:border-amber-500 cursor-pointer min-w-[160px]"><option value="">Selecionar usuário...</option>{remoteUserLogs.map((entry) => { const user = allUsers.find(u => u.uid === entry.uid); const label = user ? `${user.nome} (${user.email})` : entry.uid; return (<option key={entry.uid} value={entry.uid}>{label}</option>); })}</select>
                  </div>
                </div>
                <div className="overflow-y-auto flex-1">
                  {!selectedRemoteUid ? (<div className="px-4 py-8 text-center text-slate-500 italic text-xs">Selecione um usuário acima para visualizar o consumo individual por coleção.</div>) : (() => { const remoteEntry = remoteUserLogs.find(e => e.uid === selectedRemoteUid); if (!remoteEntry) return (<div className="px-4 py-8 text-center text-slate-500 italic text-xs">Nenhum log encontrado para este usuário.</div>); const remoteUser = allUsers.find(u => u.uid === selectedRemoteUid); const rs = remoteEntry.stats; return (<div className="p-4 space-y-3"><div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2"><span className="w-7 h-7 rounded-lg bg-amber-500/10 border border-amber-500/30 flex items-center justify-center font-bold text-amber-400 text-[10px]">{(remoteUser?.nome || "?").charAt(0).toUpperCase()}</span><div><span className="text-xs font-bold text-white">{remoteUser?.nome || selectedRemoteUid}</span>{remoteUser?.email && <span className="text-[10px] text-slate-500 font-mono block">{remoteUser.email}</span>}</div></div><div className="text-[9px] text-slate-500 font-mono">Última atualização: {remoteEntry.updatedAt ? new Date(remoteEntry.updatedAt).toLocaleString("pt-BR") : "—"}</div></div><div className="grid grid-cols-3 gap-2"><div className="rounded-lg border border-sky-500/20 bg-sky-500/5 px-3 py-2 text-center"><div className="text-[9px] uppercase text-sky-300 font-bold">Reads</div><div className="text-lg font-black text-sky-200 tabular-nums">{rs.totalReads}</div></div><div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-center"><div className="text-[9px] uppercase text-emerald-300 font-bold">Writes</div><div className="text-lg font-black text-emerald-200 tabular-nums">{rs.totalWrites}</div></div><div className="rounded-lg border border-rose-500/20 bg-rose-500/5 px-3 py-2 text-center"><div className="text-[9px] uppercase text-rose-300 font-bold">Deletes</div><div className="text-lg font-black text-rose-200 tabular-nums">{rs.totalDeletes}</div></div></div><div className="overflow-x-auto"><table className="w-full border-collapse text-left text-xs"><thead className="sticky top-0 z-10"><tr className="bg-[var(--th-n-elev)] border-b border-white/5"><th className="px-4 py-2 font-bold uppercase tracking-wider text-slate-500">Coleção</th><th className="px-4 py-2 font-bold uppercase tracking-wider text-sky-400">Reads</th><th className="px-4 py-2 font-bold uppercase tracking-wider text-emerald-400">Writes</th><th className="px-4 py-2 font-bold uppercase tracking-wider text-rose-400">Deletes</th></tr></thead><tbody>{Object.keys(rs.byCollection).length === 0 ? (<tr><td colSpan={4} className="px-4 py-6 text-center text-slate-500 italic">Nenhuma coleção registrada para este usuário.</td></tr>) : (Object.entries(rs.byCollection).map(([colName, colStats]) => (<tr key={colName} className="border-b border-white/5 last:border-b-0"><td className="px-4 py-2 text-white font-medium">{colName}</td><td className="px-4 py-2 text-sky-300 tabular-nums">{colStats.reads}</td><td className="px-4 py-2 text-emerald-300 tabular-nums">{colStats.writes}</td><td className="px-4 py-2 text-rose-300 tabular-nums">{colStats.deletes}</td></tr>)))}</tbody></table></div></div>); })()}
                </div>
              </div>
              <div className="flex-1 min-h-0 flex flex-col bg-[var(--th-n-panel)] border border-white/5 rounded-xl overflow-hidden">
                <div className="px-4 py-2.5 bg-[var(--th-n-hi)]/60 border-b border-white/5 flex items-center justify-between gap-3 flex-shrink-0">
                  <div className="text-xs font-bold uppercase tracking-wider text-slate-400">Log detalhado</div>
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={() => { try { const text = firestoreLogs.map(log => `[${formatLogTime(log.timestamp)}] ${log.type.toUpperCase()} | ${log.operation} | ${log.collection}${log.docId ? `/${log.docId}` : ""} | docs:${log.docsCount}${log.details ? ` | ${log.details}` : ""}`).join("\n"); navigator.clipboard.writeText(text).then(() => { setLogCopied(true); setTimeout(() => setLogCopied(false), 2000); }).catch(() => {}); } catch {} }} disabled={firestoreLogs.length === 0} className={`inline-flex items-center gap-1 px-3 py-1 rounded-lg border text-[10px] font-bold transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${logCopied ? "bg-emerald-500/15 border-emerald-500/30 text-emerald-300" : "bg-sky-500/15 border-sky-500/30 text-sky-300 hover:bg-sky-500/25"}`} title="Copiar todo o log para a área de transferência">{logCopied ? <ClipboardCheck size={11} /> : <Copy size={11} />}{logCopied ? "Copiado!" : "Copiar"}</button>
                    <button type="button" onClick={() => { clearLogs(); setFirestoreLogs([]); setFirestoreStats(getStats()); }} className="px-3 py-1 rounded-lg bg-rose-500/15 border border-rose-500/30 text-rose-300 hover:bg-rose-500/25 text-[10px] font-bold transition-colors cursor-pointer">Limpar Logs</button>
                  </div>
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
                  {firestoreLogs.length === 0 ? (<div className="flex flex-col items-center justify-center py-16 text-slate-500 italic text-xs gap-3"><Activity size={36} className="text-sky-500/30" /><span>Nenhuma operação registrada ainda.</span></div>) : (firestoreLogs.map((log) => (<div key={log.id} className="rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2 text-[11px] text-slate-300 flex flex-wrap items-center gap-x-3 gap-y-1"><span className="font-mono text-slate-500">{formatLogTime(log.timestamp)}</span><span className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider ${log.type === "read" ? "bg-sky-500/15 border border-sky-500/30 text-sky-300" : log.type === "write" ? "bg-emerald-500/15 border border-emerald-500/30 text-emerald-300" : "bg-rose-500/15 border border-rose-500/30 text-rose-300"}`}>{log.type}</span><span className="font-bold text-white">{log.operation}</span><span className="text-slate-400">{log.collection}${log.docId ? `/${log.docId}` : ""}</span>{log.docsCount > 1 && <span className="text-amber-300 font-mono">docs: {log.docsCount}</span>}{log.details && <span className="text-slate-500 italic truncate">{log.details}</span>}</div>)))}
                </div>
              </div>
            </div>
          )}
          {activeTab === "donations" && (
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap justify-between items-center gap-3">
                <div className="flex items-center gap-2"><HeartHandshake size={16} className="text-amber-400" /><span className="text-sm font-bold text-white tracking-wide">Gerenciamento de Doações Pendentes ({pendingDonations.length})</span></div>
                <div className="flex items-center gap-2 w-full sm:w-auto">
                  <input type="text" value={inputDonationChar} onChange={(e) => setInputDonationChar(e.target.value)} placeholder="Personagem para receber doações" className="w-full sm:w-auto bg-[var(--th-n-panel)] border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-amber-500/50" />
                  <button onClick={persistDonationChar} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-amber-500/40 bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 text-xs font-bold transition-colors cursor-pointer flex-shrink-0"><Save size={12} /> Salvar</button>
                </div>
              </div>
              <div className="text-[10px] text-slate-400">Personagem recebedor atual: <strong className="text-amber-300 font-mono">{donationChar}</strong></div>
              {pendingDonations.length === 0 ? (<div className="text-center py-10 text-slate-500 italic text-xs">Nenhuma doação pendente de validação.</div>) : (
                <div className="space-y-2">{pendingDonations.map((d) => (<div key={d.id} className="bg-[var(--th-n-panel)] border border-white/5 rounded-xl p-3 flex flex-col gap-2"><div className="flex justify-between text-xs"><div className="text-slate-400">Data: <span className="text-slate-200 font-mono">{d.donationDate}</span></div><div className="text-amber-400 font-bold text-[10px] border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 rounded">PENDENTE</div></div><div className="text-sm text-white font-bold">{d.userName} <span className="text-slate-500 text-xs font-normal">({d.userEmail})</span></div><div className="text-xs text-slate-300">De: <span className="font-mono text-amber-300 font-bold">{d.fromCharacter}</span> → Para: <span className="font-mono text-slate-400">{d.toCharacter}</span></div><div className="text-xs">Valor informado: <span className="text-emerald-400 font-bold tabular-nums text-sm">{formatRC(d.amount)}</span></div>{approvalId === d.id ? (<div className="flex items-center gap-2 pt-2 border-t border-white/5 flex-wrap"><label className="text-[10px] text-slate-400">Ajustar RC:</label><input type="number" value={approvalAmount} onChange={(e) => setApprovalAmount(e.target.value.replace(/[^\d]/g, ""))} className="w-20 bg-[var(--th-n-elev)] border border-white/10 rounded px-2 py-1 text-xs text-white font-mono" /><button onClick={() => confirmApproveDonation(d.id)} className="px-3 py-1 rounded bg-emerald-500 hover:bg-emerald-400 text-black text-xs font-bold shadow">Confirmar</button><button onClick={() => { setApprovalId(null); setApprovalAmount(""); }} className="px-3 py-1 rounded bg-white/5 hover:bg-white/10 text-slate-400 text-xs font-bold">Cancelar</button></div>) : (<div className="flex gap-2 pt-2 border-t border-white/5 justify-end"><button onClick={() => startApproveDonation(d)} className="px-4 py-1.5 rounded bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 text-xs font-bold hover:bg-emerald-500/25 transition-colors cursor-pointer">Aprovar</button><button onClick={() => refuseDonation(d.id)} className="px-4 py-1.5 rounded bg-rose-500/15 border border-rose-500/40 text-rose-300 text-xs font-bold hover:bg-rose-500/25 transition-colors cursor-pointer">Recusar</button></div>)}</div>))}</div>
              )}
              {donationRanking.length > 0 && (<div className="pt-3 border-t border-white/5"><div className="text-xs font-bold uppercase text-emerald-400 tracking-wider mb-2">Ranking de Colaboradores</div>{donationRanking.map((entry, index) => (<div key={entry.userName} className="flex justify-between bg-white/[0.02] border border-white/5 rounded px-3 py-1 text-xs mb-1"><div className="font-bold text-white">#{index + 1} — {entry.userName}</div><div className="tabular-nums text-emerald-400 font-mono">{formatRC(entry.total)} <span className="text-slate-500">({entry.count})</span></div></div>))}</div>)}
            </div>
          )}
          {activeTab === "colections" && (
            <div className="flex flex-col gap-4">
              <div className="bg-[var(--th-n-panel)] border border-white/5 rounded-xl p-4 space-y-3">
                <div className="flex items-center gap-2 text-sm font-bold text-white">
                  <Database size={14} className="text-rose-400" />
                  <span>Limpeza de Documentos Antigos</span>
                </div>
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  Remova documentos antigos das coleções do Firestore para liberar espaço e melhorar a performance.
                  A limpeza considera o tempo de criação/atualização de cada documento.
                </p>
              </div>

              <div className="bg-[var(--th-n-panel)] border border-white/5 rounded-xl p-4 space-y-3">
                <label className="block text-xs font-bold text-slate-300 uppercase tracking-wider">
                  Considerar documentos com mais de:
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="number"
                    min={72}
                    value={hoursThreshold}
                    onChange={(e) => setHoursThreshold(Math.max(72, parseInt(e.target.value) || 72))}
                    className="w-24 bg-[var(--th-n-elev)] border border-white/10 rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-rose-500/50 tabular-nums"
                  />
                  <span className="text-xs text-slate-400">horas (mínimo: 72)</span>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={handleCleanNotifications}
                  disabled={cleaningNotifications}
                  className="flex items-center justify-center gap-2 px-4 py-3 rounded-xl border border-violet-500/40 bg-violet-500/10 text-violet-300 text-xs font-bold hover:bg-violet-500/20 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <ShieldAlert size={14} />
                  {cleaningNotifications ? "Limpando..." : "Limpar Notifications"}
                </button>

              </div>

              {cleanResult && (
                <div className={`flex items-center gap-2 px-4 py-3 rounded-xl border text-xs font-bold ${
                  cleanResult.success
                    ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
                    : "bg-rose-500/10 border-rose-500/30 text-rose-300"
                }`}>
                  {cleanResult.success ? <CheckCircle2 size={14} /> : <X size={14} />}
                  {cleanResult.message}
                </div>
              )}
            </div>
          )}

          {activeTab === "settings" && (
            <div className="flex flex-col gap-4">
              {/* Card: Média Mínima de Doação/PT */}
              <div className="bg-[var(--th-n-panel)] border border-white/5 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between border-b border-white/5 pb-2">
                  <div className="flex items-center gap-2 text-sm font-bold text-white">
                    <HeartHandshake size={14} className="text-amber-400" />
                    <span>Média Mínima de Doação/PT</span>
                  </div>
                </div>
                <div className="space-y-3">
                  <p className="text-xs text-slate-400 leading-relaxed">
                    Este valor define o mínimo exigido de <strong>RC/PT</strong> (RC doado por PT concluída).
                    Qualquer alteração será replicada instantaneamente para todos os usuários através do documento <code className="bg-black/40 px-1 rounded">appSettings/global</code>.
                  </p>
                  <div className="flex items-center gap-3">
                    <input
                      type="number"
                      min={0}
                      value={minDonationInput}
                      onChange={(e) => setMinDonationInput(e.target.value.replace(/[^\d]/g, ""))}
                      className="w-24 bg-[var(--th-n-elev)] border border-white/10 rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-amber-500/50 tabular-nums"
                      placeholder={String(minAverage)}
                    />
                    <button
                      type="button"
                      disabled={!minDonationInput || parseInt(minDonationInput) === minAverage}
                      onClick={async () => {
                        const val = parseInt(minDonationInput);
                        if (!Number.isFinite(val) || val < 0) return;
                        if (!isSimulationMode && db) {
                          try {
                            await setDoc(doc(db, "appSettings", "global"), {
                              minimumAverageDonation: val,
                              updatedAt: serverTimestamp()
                            }, { merge: true });
                          } catch {}
                        }
                      }}
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-amber-500/15 border border-amber-500/40 hover:bg-amber-500/25 text-amber-300 text-xs font-bold transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <Save size={14} /> Salvar Valor
                    </button>
                  </div>
                </div>
              </div>

              {/* Card: Governança do Firestore */}
              <div className="bg-[var(--th-n-panel)] border border-sky-500/20 rounded-xl p-4 space-y-4">
                <div className="flex items-center justify-between border-b border-white/5 pb-2">
                  <div className="flex items-center gap-2 text-sm font-bold text-white">
                    <Activity size={14} className="text-sky-400" />
                    <span>Governança do Firestore</span>
                  </div>
                  <span className="text-[9px] font-bold uppercase tracking-wider text-sky-300 bg-sky-500/10 border border-sky-500/25 rounded-full px-2 py-0.5">Configuração global</span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {/* Badges Administrativos */}
                  <div className="rounded-xl border border-white/5 bg-black/20 p-3 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs font-black text-white">Badges Administrativos</div>
                      <select
                        value={globalSettings?.bossBadgesMode || "realtime"}
                        onChange={async (e) => {
                          if (!isSimulationMode && db) {
                            try {
                              await setDoc(doc(db, "appSettings", "global"), {
                                bossBadgesMode: e.target.value,
                                updatedAt: serverTimestamp()
                              }, { merge: true });
                            } catch {}
                          }
                        }}
                        className="bg-[var(--th-n-elev)] border border-white/10 rounded px-2 py-1 text-[10px] text-white focus:outline-none focus:border-sky-500 cursor-pointer"
                      >
                        <option value="realtime">Realtime</option>
                        <option value="economy">Econômico</option>
                        <option value="manual">Manual</option>
                      </select>
                    </div>
                    <p className="text-[10px] text-slate-400 leading-relaxed">
                      Realtime mantém os contadores do botão Boss sincronizados. Econômico consulta a cada 5 minutos. Manual desliga as consultas automáticas dos badges.
                    </p>
                  </div>

                  {/* PTs Públicas */}
                  <div className="rounded-xl border border-white/5 bg-black/20 p-3 space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-xs font-black text-white">PTs Públicas</div>
                        <p className="text-[10px] text-slate-500 leading-relaxed">Controla a criação de novas PTs públicas pelos usuários.</p>
                      </div>
                      <button
                        type="button"
                        onClick={async () => {
                          if (!isSimulationMode && db) {
                            try {
                              await setDoc(doc(db, "appSettings", "global"), {
                                publicPartiesEnabled: !(globalSettings?.publicPartiesEnabled !== false),
                                updatedAt: serverTimestamp()
                              }, { merge: true });
                            } catch {}
                          }
                        }}
                        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[10px] font-bold transition-colors cursor-pointer ${
                          globalSettings?.publicPartiesEnabled === false
                            ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/25"
                            : "bg-rose-500/15 border-rose-500/40 text-rose-300 hover:bg-rose-500/25"
                        }`}
                      >
                        {globalSettings?.publicPartiesEnabled === false ? "Retomar Públicas" : "Pausar Públicas"}
                      </button>
                    </div>
                  </div>

                  {/* Feedback */}
                  <div className="rounded-xl border border-white/5 bg-black/20 p-3 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs font-black text-white">Feedback</div>
                      <span className="px-2 py-1 rounded border border-emerald-500/30 bg-emerald-500/10 text-[10px] font-bold text-emerald-300">Manual / Cache</span>
                    </div>
                    <p className="text-[10px] text-slate-400 leading-relaxed">
                      O Feedback não usa mais listener em tempo real. Os relatórios são carregados sob demanda com cache local temporário.
                    </p>
                  </div>

                  {/* Idle Mode */}
                  <div className="rounded-xl border border-white/5 bg-black/20 p-3 space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-xs font-black text-white">Idle Mode</div>
                        <p className="text-[10px] text-slate-500 leading-relaxed">Tempo sem uso até pausar sincronizações não críticas.</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min={1}
                          max={1440}
                          value={globalSettings?.idleModeTimeoutMinutes || 30}
                          onChange={async (e) => {
                            const value = Math.max(1, Math.min(1440, parseInt(e.target.value, 10) || 30));
                            if (!isSimulationMode && db) {
                              try {
                                await setDoc(doc(db, "appSettings", "global"), {
                                  idleModeTimeoutMinutes: value,
                                  updatedAt: serverTimestamp()
                                }, { merge: true });
                              } catch {}
                            }
                          }}
                          className="w-20 bg-[var(--th-n-elev)] border border-white/10 rounded px-2 py-1.5 text-xs text-white font-mono text-center focus:outline-none focus:border-sky-500"
                        />
                        <span className="text-[10px] font-bold text-slate-400">min</span>
                      </div>
                    </div>
                  </div>

                  {/* Presence */}
                  <div className="rounded-xl border border-white/5 bg-black/20 p-3 space-y-3 md:col-span-2">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <div className={`w-3 h-3 rounded-full ${globalSettings?.presenceEnabled === false ? "bg-rose-500 shadow-[0_0_8px_color-mix(in_oklab,var(--color-red-600)_60%,transparent)]" : "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]"}`} />
                        <div>
                          <div className="text-xs font-black text-white">Presence</div>
                          <div className="text-[10px] text-slate-400">Status: <span className={globalSettings?.presenceEnabled === false ? "text-rose-400" : "text-emerald-400"}>{globalSettings?.presenceEnabled === false ? "PAUSADO" : "ATIVO"}</span></div>
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={async () => {
                          if (!isSimulationMode && db) {
                            try {
                              await setDoc(doc(db, "appSettings", "global"), {
                                presenceEnabled: !(globalSettings?.presenceEnabled !== false),
                                updatedAt: serverTimestamp()
                              }, { merge: true });
                            } catch {}
                          }
                        }}
                        className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border text-xs font-bold transition-colors cursor-pointer ${
                          globalSettings?.presenceEnabled === false
                            ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/25"
                            : "bg-rose-500/15 border-rose-500/40 text-rose-300 hover:bg-rose-500/25"
                        }`}
                      >
                        {globalSettings?.presenceEnabled === false ? "Retomar Presence" : "Pausar Presence"}
                      </button>
                    </div>

                    <label className="space-y-1 block">
                      <span className="text-[10px] font-bold text-slate-300 uppercase tracking-wider">Modo do Presence</span>
                      <select
                        value={globalSettings?.presenceMode || "completo"}
                        onChange={async (e) => {
                          if (!isSimulationMode && db) {
                            try {
                              await setDoc(doc(db, "appSettings", "global"), {
                                presenceMode: e.target.value,
                                updatedAt: serverTimestamp()
                              }, { merge: true });
                            } catch {}
                          }
                        }}
                        className="w-full bg-[var(--th-n-elev)] border border-white/10 rounded px-2 py-2 text-xs text-white focus:outline-none focus:border-sky-500 cursor-pointer"
                      >
                        <option value="economico">Modo Econômico</option>
                        <option value="completo">Modo Completo</option>
                      </select>
                    </label>
                    <p className="text-[10px] text-slate-500 leading-relaxed">
                      Econômico: usuários comuns leem apenas presence/count. Completo: preserva fallback e recálculo atuais. Pausado: interrompe heartbeat, polling e agregados do Presence.
                    </p>
                  </div>
                </div>

                {/* Firestore Logger */}
                <div className="rounded-xl border border-white/5 bg-black/20 p-3 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div className={`w-3 h-3 rounded-full ${globalSettings?.firestoreLoggerPaused ? "bg-rose-500 shadow-[0_0_8px_color-mix(in_oklab,var(--color-red-600)_60%,transparent)]" : "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]"}`} />
                      <div>
                        <div className="text-xs font-black text-white">Firestore Logger</div>
                        <div className="text-[10px] text-slate-400">Status: <span className={globalSettings?.firestoreLoggerPaused ? "text-rose-400" : "text-emerald-400"}>{globalSettings?.firestoreLoggerPaused ? "PAUSADO" : "ATIVO"}</span></div>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={async () => {
                        if (!isSimulationMode && db) {
                          try {
                            const currentPaused = globalSettings?.firestoreLoggerPaused || false;
                            await setDoc(doc(db, "appSettings", "global"), {
                              firestoreLoggerPaused: !currentPaused,
                              updatedAt: serverTimestamp()
                            }, { merge: true });
                          } catch {}
                        }
                      }}
                      className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border text-xs font-bold transition-colors cursor-pointer ${
                        globalSettings?.firestoreLoggerPaused
                          ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/25"
                          : "bg-rose-500/15 border-rose-500/40 text-rose-300 hover:bg-rose-500/25"
                      }`}
                    >
                      {globalSettings?.firestoreLoggerPaused ? (
                        <><PlayCircle size={14} /> Retomar Firestore Logger</>
                      ) : (
                        <><PauseCircle size={14} /> Pausar Firestore Logger</>
                      )}
                    </button>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2 border-t border-white/5">
                    <label className="space-y-1">
                      <span className="text-[10px] font-bold text-slate-300 uppercase tracking-wider">Detalhamento remoto</span>
                      <select
                        value={globalSettings?.firestoreLoggerDetailLevel || "complete"}
                        onChange={async (e) => {
                          if (!isSimulationMode && db) {
                            try {
                              await setDoc(doc(db, "appSettings", "global"), {
                                firestoreLoggerDetailLevel: e.target.value,
                                updatedAt: serverTimestamp()
                              }, { merge: true });
                            } catch {}
                          }
                        }}
                        className="w-full bg-[var(--th-n-elev)] border border-white/10 rounded px-2 py-2 text-xs text-white focus:outline-none focus:border-sky-500 cursor-pointer"
                      >
                        <option value="complete">Completo</option>
                        <option value="summary">Resumido</option>
                      </select>
                    </label>

                    <label className="space-y-1">
                      <span className="text-[10px] font-bold text-slate-300 uppercase tracking-wider">Envio remoto</span>
                      <select
                        value={String(globalSettings?.firestoreLoggerSendIntervalSeconds || 120)}
                        onChange={async (e) => {
                          if (!isSimulationMode && db) {
                            try {
                              await setDoc(doc(db, "appSettings", "global"), {
                                firestoreLoggerSendIntervalSeconds: parseInt(e.target.value, 10),
                                updatedAt: serverTimestamp()
                              }, { merge: true });
                            } catch {}
                          }
                        }}
                        className="w-full bg-[var(--th-n-elev)] border border-white/10 rounded px-2 py-2 text-xs text-white focus:outline-none focus:border-sky-500 cursor-pointer"
                      >
                        <option value="120">120 segundos</option>
                        <option value="300">300 segundos</option>
                        <option value="600">600 segundos</option>
                      </select>
                    </label>
                  </div>

                  <p className="text-[10px] text-slate-500 leading-relaxed">
                    O modo Resumido mantém totais por coleção e deixa de enviar a lista detalhada de eventos para user_logs, reduzindo armazenamento e bytes por gravação.
                  </p>
                </div>
              </div>

            </div>
          )}
        </div>

        <div className="app-modal-footer px-4 sm:px-5 py-3 border-t border-white/5 bg-[var(--th-n-hi)] flex flex-wrap justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 text-slate-300 hover:text-white text-xs font-bold transition-colors cursor-pointer">Fechar Painel</button>
        </div>
      </div>
    </div>
  );
}