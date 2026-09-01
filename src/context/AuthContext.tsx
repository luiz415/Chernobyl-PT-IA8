import React, { createContext, useContext, useState, useEffect, useRef, useMemo } from "react";
import { markSessionStart } from "../utils/desktopNotify";
import { 
  createUserWithEmailAndPassword, 
  signInWithEmailAndPassword, 
  signOut as fbSignOut, 
  onAuthStateChanged,
  setPersistence,
  browserSessionPersistence
} from "firebase/auth";
import { 
  doc, 
  collection, 
  serverTimestamp,
  runTransaction,
  Timestamp
} from "firebase/firestore";
import { auth, db, isSimulationMode, setDoc, getDoc, updateDoc, onSnapshot, addDoc } from "../firebase/config";
import { saveUserLogsToFirestore, getLogs, getStats, getLoggerGovernance, subscribeLoggerGovernance } from "../utils/firestoreLogger";
import { increment } from "firebase/firestore";
import {
  setUsageMonitorUid,
  onRateLimitBlock,
  isFirestoreBlocked,
  getBlockedUntil,
  clearBlock,
  setRateLimitDisabled,
  setUsageRole,
} from "../utils/firestoreUsageMonitor";
import FirestoreUsageBlockModal from "../components/FirestoreUsageBlockModal";
import { getEffectiveUserRole, getVipExpirationMillis, getVipRemainingDays, VIP_DAY_MS } from "../utils/vipAccess";
import { getPresenceGovernance, subscribePresenceGovernance } from "../utils/presenceGovernance";
import { getIdleGovernance, subscribeIdleGovernance } from "../utils/idleGovernance";
// --- Types ---
export type UserRole = "Boss" | "VIP" | "Normal";
export type UserStatus = "pendente" | "aprovado" | "recusado";
export interface UserProfile {
  uid: string;
  nome: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  createdAt: number;
  mainCharacterName?: string;
  whatsappCountry?: string;
  whatsappRegion?: string;
  whatsappNumber?: string;
  rateLimitBlocks?: number;
  vipDays?: number;
  vipExpiresAt?: number | { toMillis?: () => number; seconds?: number } | null;
  autoCharUpdate?: boolean;
  twitchChannel?: string;
  serviceiro?: boolean;
}
export interface AuthNotification {
  id: string;
  type: "request_entry";
  title: string;
  body: string;
  targetRole: "Boss";
  userId: string;
  userName: string;
  userEmail: string;
  createdAt: number;
  status: "unread" | "read";
  ignored?: boolean;
  ignoredAt?: any;
  ignoredBy?: string;
}

export interface FriendshipRecord {
  uid: string;
  status: "pendente" | "enviada" | "aceita" | "recusada";
  createdAt?: number;
}
interface SignUpExtra {
  whatsappCountry?: string;
  whatsappRegion?: string;
  whatsappNumber?: string;
  mainCharacterName?: string;
}
interface AuthContextType {
  currentUser: any | null;
  userProfile: UserProfile | null;
  loading: boolean;
  isSimulation: boolean;
  requestPendingLocally: boolean;
  loginErrorCooldown: boolean;
  setLoginErrorCooldown: (v: boolean) => void;
  signUp: (nome: string, email: string, senha: string, extra?: SignUpExtra) => Promise<void>;
  signIn: (email: string, senha: string, remember: boolean) => Promise<void>;
  signOut: () => Promise<void>;
  approveUser: (uid: string) => Promise<void>;
  refuseUser: (uid: string) => Promise<void>;
  changeUserRole: (uid: string, role: UserRole) => Promise<void>;
  allUsers: UserProfile[];
  bossNotifications: AuthNotification[];
  dismissNotification: (id: string) => Promise<void>;
  ignoreNotification: (id: string) => Promise<void>;
  updateUserProfile: (patch: Partial<UserProfile>) => Promise<void>;
  rateLimited: boolean;
  rateLimitSecondsLeft: number;
  rateLimitBlockCount: number;
  checkRateLimit: () => boolean;
  hasSharedCharChanged: (id: string, obj: Record<string, unknown>) => boolean;
  isUserIdle: boolean;
  isIdleMode: boolean;
  isIdleRestoring: boolean;
  restoreFromIdle: () => void;
  friendshipRecords: FriendshipRecord[];
  acceptedFriendUids: string[];
  pendingFriendsCount: number;
  checkActiveSession: (email: string, senha: string) => Promise<"free" | "occupied">;
  disconnectOtherSessions: () => Promise<void>;
}
const AuthContext = createContext<AuthContextType | null>(null);
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [currentUser, setCurrentUser] = useState<any | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [vipClock, setVipClock] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setVipClock(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);
  useEffect(() => {
    const expiresAt = getVipExpirationMillis(userProfile?.vipExpiresAt);
    if (expiresAt <= Date.now()) return;
    const delay = Math.min(expiresAt - Date.now() + 50, 2_147_483_647);
    const timeout = window.setTimeout(() => setVipClock(Date.now()), delay);
    return () => window.clearTimeout(timeout);
  }, [userProfile?.vipExpiresAt]);
  const effectiveUserProfile = useMemo<UserProfile | null>(() => {
    if (!userProfile) return null;
    return {
      ...userProfile,
      role: getEffectiveUserRole(userProfile, vipClock),
      vipDays: getVipRemainingDays(userProfile, vipClock),
    };
  }, [userProfile, vipClock]);

  // Migração automática de saldos antigos que possuíam vipDays sem vencimento.
  useEffect(() => {
    if (!currentUser?.uid || !userProfile) return;
    if (getVipExpirationMillis(userProfile.vipExpiresAt) > 0) return;
    if (typeof userProfile.vipDays !== "number" || userProfile.vipDays <= 0) return;
    const vipExpiresAt = Timestamp.fromMillis(Date.now() + Math.floor(userProfile.vipDays) * VIP_DAY_MS);
    setUserProfile(prev => prev ? { ...prev, vipExpiresAt } : prev);
    if (isSimulationMode || !db) {
      setSimUsers(prev => prev.map(user => user.uid === currentUser.uid ? { ...user, vipExpiresAt } : user));
      return;
    }
    updateDoc(doc(db, "users", currentUser.uid), {
      vipExpiresAt,
      vipUpdatedAt: serverTimestamp(),
    }).catch(() => {});
  }, [currentUser?.uid, userProfile?.vipDays, userProfile?.vipExpiresAt]);
  const [loading, setLoading] = useState(true);
  const [requestPendingLocally, setRequestPendingLocally] = useState<boolean>(() => {
    return localStorage.getItem("tibia_auth_pending_locally") === "true";
  });
  const [loginErrorCooldown, setLoginErrorCooldown] = useState(false);

  // ============================================================================
  // RATE LIMITING — alimentado pelo firestoreUsageMonitor (janela 60s)
  // Ao bloquear: modal fullscreen por 60s + persiste +1 em users/{uid}.rateLimitBlocks
  // ============================================================================
  const [rateLimited, setRateLimited] = useState(false);
  const [rateLimitSecondsLeft, setRateLimitSecondsLeft] = useState(0);
  const [rateLimitTotalDuration, setRateLimitTotalDuration] = useState(60);
  const [rateLimitBlockCount, setRateLimitBlockCount] = useState(0);
  const rateLimitBlockedDurationRef = useRef<number>(60_000);
  const currentUserRef = useRef<any>(null);
  const userProfileRef = useRef<UserProfile | null>(null);

  // IDLE TRACKER — exposto para que App.tsx possa pausar leituras (polling) quando ocioso
  const [isUserIdle, setIsUserIdle] = useState(false);

  // ============================================================================
  // IDLE MODE LEVE — pausa temporária de listeners/timers seguros
  // ============================================================================
  const IDLE_RESTORE_DELAY_MS = 1200;
  const [idleGovernance, setIdleGovernanceState] = useState(() => getIdleGovernance());
  const [isIdleMode, setIsIdleMode] = useState(false);
  const [isIdleRestoring, setIsIdleRestoring] = useState(false);
  const idleTimerRef = useRef<number | null>(null);
  const idleRestoreTimerRef = useRef<number | null>(null);

  useEffect(() => {
    setIdleGovernanceState(getIdleGovernance());
    return subscribeIdleGovernance(setIdleGovernanceState);
  }, []);

  function clearIdleTimer() {
    if (idleTimerRef.current) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }

  function enterIdleMode() {
    clearIdleTimer();
    setIsIdleMode(true);
    setIsIdleRestoring(false);
    setIsUserIdle(true);
  }

  function scheduleIdleTimer() {
    clearIdleTimer();
    idleTimerRef.current = window.setTimeout(enterIdleMode, idleGovernance.timeoutMinutes * 60 * 1000);
  }

  function restoreFromIdle() {
    if (!currentUserRef.current || userProfileRef.current?.status !== "aprovado") return;
    if (!isIdleMode && !isIdleRestoring) {
      scheduleIdleTimer();
      return;
    }
    if (idleRestoreTimerRef.current) window.clearTimeout(idleRestoreTimerRef.current);
    setIsIdleRestoring(true);
    setIsIdleMode(false);
    setIsUserIdle(false);
    idleRestoreTimerRef.current = window.setTimeout(() => {
      setIsIdleRestoring(false);
      scheduleIdleTimer();
    }, IDLE_RESTORE_DELAY_MS);
  }

  useEffect(() => {
    if (!currentUser || !effectiveUserProfile || effectiveUserProfile.status !== "aprovado") {
      clearIdleTimer();
      if (idleRestoreTimerRef.current) window.clearTimeout(idleRestoreTimerRef.current);
      setIsIdleMode(false);
      setIsIdleRestoring(false);
      return;
    }

    const resetActivityTimer = () => {
      if (isIdleMode || isIdleRestoring) {
        restoreFromIdle();
        return;
      }
      setIsUserIdle(false);
      scheduleIdleTimer();
    };

    const handleVisibility = () => {
      if (document.hidden) {
        scheduleIdleTimer();
      } else {
        resetActivityTimer();
      }
    };

    const handleFocus = () => resetActivityTimer();
    const handleBlur = () => scheduleIdleTimer();

    const activityEvents = ["mousemove", "keydown", "click", "scroll", "touchstart", "wheel"] as const;
    activityEvents.forEach(evt => window.addEventListener(evt, resetActivityTimer, { passive: true }));
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("focus", handleFocus);
    window.addEventListener("blur", handleBlur);

    scheduleIdleTimer();

    return () => {
      activityEvents.forEach(evt => window.removeEventListener(evt, resetActivityTimer));
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("blur", handleBlur);
      clearIdleTimer();
    };
  }, [currentUser?.uid, effectiveUserProfile?.status, isIdleMode, isIdleRestoring, idleGovernance.timeoutMinutes]);

  useEffect(() => {
    return () => {
      clearIdleTimer();
      if (idleRestoreTimerRef.current) window.clearTimeout(idleRestoreTimerRef.current);
    };
  }, []);

  // ============================================================================
  // FRIENDSHIPS — fonte única para users/{uid}/friends
  // Um único listener lê toda a subcoleção e deriva: aceitos, pendentes, enviados
  // e recusados. Isso substitui listeners separados por status no App/FriendsModal.
  // ============================================================================
  const [friendshipRecords, setFriendshipRecords] = useState<FriendshipRecord[]>([]);

  const acceptedFriendUids = useMemo(() => {
    return friendshipRecords.filter(f => f.status === "aceita").map(f => f.uid);
  }, [friendshipRecords]);

  const pendingFriendsCount = useMemo(() => {
    return friendshipRecords.filter(f => f.status === "pendente").length;
  }, [friendshipRecords]);

  useEffect(() => {
    if (!currentUser?.uid) {
      setFriendshipRecords([]);
      return;
    }

    // MODO SIMULAÇÃO: lê friends_{uid} do localStorage
    if (isSimulationMode || !db) {
      try {
        const raw = localStorage.getItem(`friends_${currentUser.uid}`);
        const parsed: FriendshipRecord[] = raw ? JSON.parse(raw) : [];
        setFriendshipRecords(Array.isArray(parsed) ? parsed : []);
      } catch {
        setFriendshipRecords([]);
      }
      return;
    }

    // MODO PRODUÇÃO: listener único na subcoleção friends
    try {
      const unsub = onSnapshot(
        collection(db, "users", currentUser.uid, "friends"),
        (snap) => {
          const list: FriendshipRecord[] = snap.docs.map(d => {
            const data = d.data();
            return {
              uid: d.id,
              status: data.status || "pendente",
              createdAt: data.createdAt || Date.now(),
            } as FriendshipRecord;
          });
          setFriendshipRecords(list);
        },
        () => setFriendshipRecords([])
      );
      return () => unsub();
    } catch {
      setFriendshipRecords([]);
    }
  }, [currentUser?.uid, isSimulationMode]);

  function checkRateLimit(): boolean {
    if (isSimulationMode) return false;
    return isFirestoreBlocked();
  }

  // Sincroniza o uid atual com o monitor (troca de usuário reseta janela/bloqueio)
  // e aplica o limite específico do role: Boss=ilimitado, VIP=100/min, Normal=50/min
  useEffect(() => {
    const isBoss = effectiveUserProfile?.role === "Boss";
    setRateLimitDisabled(isBoss);
    setUsageRole(effectiveUserProfile?.role || "Normal");
    setUsageMonitorUid(currentUser?.uid || null, userProfile?.rateLimitBlocks || 0);
    setRateLimitBlockCount(userProfile?.rateLimitBlocks || 0);
    currentUserRef.current = currentUser;
    userProfileRef.current = effectiveUserProfile;
  }, [currentUser, effectiveUserProfile?.role, userProfile?.rateLimitBlocks]);

  // Assinatura: dispara quando um novo bloqueio acontece no monitor.
  // O callback recebe (blockCount, durationMs).
  useEffect(() => {
    const unsub = onRateLimitBlock((_blockCount, durationMs) => {
      setRateLimited(true);
      const totalSec = Math.ceil(durationMs / 1000);
      setRateLimitSecondsLeft(totalSec);
      setRateLimitTotalDuration(totalSec);
      rateLimitBlockedDurationRef.current = durationMs;
      setRateLimitBlockCount(prev => prev + 1);

      const uid = currentUserRef.current?.uid;
      if (!uid) return;

      // Persistir +1 no cadastro do usuário (users/{uid}.rateLimitBlocks)
      if (!isSimulationMode && db) {
        try {
          updateDoc(doc(db, "users", uid), { rateLimitBlocks: increment(1) }).catch(() => {});
        } catch {}
        setUserProfile(prev => prev ? { ...prev, rateLimitBlocks: (prev.rateLimitBlocks || 0) + 1 } : prev);
      }

      // Gravar notificação para o Boss (aparece no BossAdminPanel)
      if (!isSimulationMode && db) {
        const up = userProfileRef.current;
        const notifId = "notif_rl_" + Date.now() + "_" + Math.random().toString(36).slice(2);
        const currentBlocks = (up?.rateLimitBlocks || 0) + 1;
        const blockLabel =
          currentBlocks <= 1 ? "1º bloqueio" :
          currentBlocks <= 2 ? "2º bloqueio" : `${currentBlocks}º bloqueio`;
        addDoc(collection(db, "notifications"), {
          id: notifId,
          type: "rate_limit_block",
          title: "⚠ Usuário bloqueado por uso excessivo",
          body: `${up?.nome || "Anônimo"} (${up?.email || ""}) atingiu o limite de operações no Firestore. Bloqueio Nº ${currentBlocks} (${blockLabel}, ${totalSec}s de penalidade).`,
          targetRole: "Boss",
          subjectUserId: uid,
          userName: up?.nome || "Anônimo",
          userEmail: up?.email || "",
          createdAt: Date.now(),
          status: "unread",
        }).catch(() => {});
      }
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cronômetro regressivo do bloqueio + failsafe anti-travamento
  useEffect(() => {
    if (!rateLimited) return;
    const failsafeMs = rateLimitBlockedDurationRef.current + 10_000;
    const startedAt = Date.now();
    const interval = window.setInterval(() => {
      const until = getBlockedUntil();
      const left = Math.ceil((until - Date.now()) / 1000);
      const elapsed = Date.now() - startedAt;
      if (left <= 0 || elapsed > failsafeMs) {
        clearBlock();
        setRateLimited(false);
        setRateLimitSecondsLeft(0);
        window.clearInterval(interval);
      } else {
        setRateLimitSecondsLeft(left);
      }
    }, 1000);
    return () => window.clearInterval(interval);
  }, [rateLimited]);

  // Shared-character dedup hash map (evita writes repetidos)
  const sharedCharHashRef = useRef<Map<string, string>>(new Map());
  function hasSharedCharChanged(id: string, charObj: Record<string, unknown>): boolean {
    const hash = JSON.stringify(charObj);
    const prev = sharedCharHashRef.current.get(id);
    if (prev === hash) return false;
    sharedCharHashRef.current.set(id, hash);
    return true;
  }

  // Lists for all users and Boss notifications
  const [allUsers, setAllUsers] = useState<UserProfile[]>([]);
  const effectiveAllUsers = useMemo<UserProfile[]>(() => {
    return allUsers.map(user => ({
      ...user,
      role: getEffectiveUserRole(user, vipClock),
      vipDays: getVipRemainingDays(user, vipClock),
    }));
  }, [allUsers, vipClock]);
  const [bossNotifications, setBossNotifications] = useState<AuthNotification[]>([]);
  // Local storage lists for simulation
  const [simUsers, setSimUsers] = useState<UserProfile[]>(() => {
    try {
      const raw = localStorage.getItem("tibia_sim_users");
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  });
  const [simNotifs, setSimNotifs] = useState<AuthNotification[]>(() => {
    try {
      const raw = localStorage.getItem("tibia_sim_notifications");
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  });
  useEffect(() => {
    if (isSimulationMode) {
      localStorage.setItem("tibia_sim_users", JSON.stringify(simUsers));
    }
  }, [simUsers]);
  useEffect(() => {
    if (isSimulationMode) {
      localStorage.setItem("tibia_sim_notifications", JSON.stringify(simNotifs));
    }
  }, [simNotifs]);
  // Ref para bloquear onAuthStateChanged durante o processo de checkActiveSession
  const isCheckingSessionRef = useRef<boolean>(false);

  // Handle Auth State changes
  useEffect(() => {
    if (!isSimulationMode && auth && db) {
      const unsubscribe = onAuthStateChanged(auth, async (user) => {
        if (isCheckingSessionRef.current) return;
        setCurrentUser(user);
        if (user) {
          // Fetch firestore profile
          try {
            const userDocRef = doc(db, "users", user.uid);
            const docSnap = await getDoc(userDocRef);
            if (docSnap.exists()) {
              const data = docSnap.data() as UserProfile;
              setUserProfile(data);

              if (data.status === "pendente") {
                setRequestPendingLocally(true);
                localStorage.setItem("tibia_auth_pending_locally", "true");
              } else {
                setRequestPendingLocally(false);
                localStorage.removeItem("tibia_auth_pending_locally");
              }
            } else {
              setUserProfile(null);
            }
          } catch (e) {
            console.error("Error loading user profile:", e);
            setUserProfile(null);
          }
        } else {
          setUserProfile(null);
        }
        setLoading(false);
      });
      return unsubscribe;
    } else {
      // Simulation mode mount
      const simSession = sessionStorage.getItem("tibia_sim_session_uid");
      if (simSession) {
        const found = simUsers.find(u => u.uid === simSession);
        if (found) {
          setCurrentUser({ uid: found.uid, email: found.email });
          setUserProfile(found);
          if (found.status === "pendente") {
            setRequestPendingLocally(true);
            localStorage.setItem("tibia_auth_pending_locally", "true");
          } else {
            setRequestPendingLocally(false);
            localStorage.removeItem("tibia_auth_pending_locally");
          }
        } else {
          sessionStorage.removeItem("tibia_sim_session_uid");
        }
      }
      setLoading(false);
    }
  }, [simUsers]);

  // ============================================================================
  // Real-time synchronization for ALL approved users (allUsers list)
  // Boss notifications are only loaded for Boss role
  // ============================================================================
  useEffect(() => {
    // Carrega allUsers para TODOS os usuários aprovados (Boss, VIP e Normal)
    // Isso permite que qualquer usuário aprovado veja a lista de usuários
    // e possa enviar/receber solicitações de amizade
    if (userProfile && userProfile.status === "aprovado") {
      if (!isSimulationMode && db) {
        // Real Firestore snapshots - allUsers para todos os aprovados
        const unsubUsers = onSnapshot(collection(db, "users"), (snapshot) => {
          const list: UserProfile[] = [];
          snapshot.forEach(doc => {
            list.push(doc.data() as UserProfile);
          });
          setAllUsers(list);
        });

        // Notificações de targetRole=Boss não são escutadas aqui para evitar
        // duplicação com os contadores do App.tsx e com o BossAdminPanel.
        setBossNotifications([]);

        return () => {
          unsubUsers();
        };
      } else {
        // Simulation sync - allUsers para todos os aprovados
        setAllUsers(simUsers);
        if (userProfile.role === "Boss") {
          setBossNotifications(simNotifs.filter(n => n.targetRole === "Boss" && n.status === "unread").sort((a, b) => b.createdAt - a.createdAt));
        } else {
          setBossNotifications([]);
        }
      }
    } else {
      // Usuário não aprovado ou não logado - limpa as listas
      setAllUsers([]);
      setBossNotifications([]);
    }
  }, [userProfile, simUsers, simNotifs]);

  // --- Auth Actions ---
  async function signUp(nome: string, email: string, senha: string, extra?: SignUpExtra) {
    if (!isSimulationMode && auth && db) {
      try {
        await setPersistence(auth, browserSessionPersistence);
        const userCredential = await createUserWithEmailAndPassword(auth, email, senha);
        const uid = userCredential.user.uid;
        const docRef = doc(db, "users", uid);
        const newProfile: UserProfile = {
          uid,
          nome,
          email,
          status: "pendente",
          role: "Normal",
          createdAt: Date.now(),
          mainCharacterName: extra?.mainCharacterName || "",
          whatsappCountry: extra?.whatsappCountry || "",
          whatsappRegion: extra?.whatsappRegion || "",
          whatsappNumber: extra?.whatsappNumber || "",
        };
        // Check if this is the first user
        try {
          const firstCheckDoc = doc(db, "settings", "first_user_check");
          const checkSnap = await getDoc(firstCheckDoc);
          if (!checkSnap.exists()) {
            // First user ever, approve immediately and make Boss
            newProfile.status = "aprovado";
            newProfile.role = "Boss";
            await setDoc(firstCheckDoc, { checked: true });
          }
        } catch (_) {}
        await setDoc(docRef, newProfile);
        setUserProfile(newProfile);
        // If pendente, add a notification for Bosses
        if (newProfile.status === "pendente") {
          setRequestPendingLocally(true);
          localStorage.setItem("tibia_auth_pending_locally", "true");
          
          await addDoc(collection(db, "notifications"), {
            type: "request_entry",
            title: "🔑 Nova solicitação de entrada",
            body: `${newProfile.nome} (${newProfile.email}) está aguardando aprovação.`,
            targetRole: "Boss",
            userId: uid,
            userName: newProfile.nome,
            userEmail: newProfile.email,
            createdAt: Date.now(),
            status: "unread"
          });
        }
      } catch (e: any) {
        throw new Error(e.message || "Erro ao registrar conta.");
      }
    } else {
      // Simulation Sign Up
      const lowerEmail = email.toLowerCase().trim();
      const exists = simUsers.some(u => u.email.toLowerCase() === lowerEmail);
      if (exists) {
        throw new Error("O e-mail informado já está em uso.");
      }
      const uid = "sim_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
      
      // First user in simulation becomes Boss immediately so developer can approve future mock users!
      const isFirst = simUsers.length === 0;
      const newProfile: UserProfile = {
        uid,
        nome,
        email: lowerEmail,
        status: isFirst ? "aprovado" : "pendente",
        role: isFirst ? "Boss" : "Normal",
        createdAt: Date.now(),
        mainCharacterName: extra?.mainCharacterName || "",
        whatsappCountry: extra?.whatsappCountry || "",
        whatsappRegion: extra?.whatsappRegion || "",
        whatsappNumber: extra?.whatsappNumber || "",
      };
      // Add to password storage sim
      const passRaw = localStorage.getItem("tibia_sim_passwords") || "{}";
      const passObj = JSON.parse(passRaw);
      passObj[uid] = senha;
      localStorage.setItem("tibia_sim_passwords", JSON.stringify(passObj));
      // Append user
      markSessionStart();
      setSimUsers(prev => [...prev, newProfile]);
      // If pendente, create a simulation notification
      if (newProfile.status === "pendente") {
        setRequestPendingLocally(true);
        localStorage.setItem("tibia_auth_pending_locally", "true");
        const notif: AuthNotification = {
          id: "sim_notif_" + Math.random().toString(36).slice(2) + Date.now().toString(36),
          type: "request_entry",
          title: "🔑 Nova solicitação de entrada",
          body: `${newProfile.nome} (${newProfile.email}) está aguardando aprovação.`,
          targetRole: "Boss",
          userId: uid,
          userName: newProfile.nome,
          userEmail: newProfile.email,
          createdAt: Date.now(),
          status: "unread"
        };
        setSimNotifs(prev => [notif, ...prev]);
      } else {
        // Log in immediately
        markSessionStart();
        sessionStorage.setItem("tibia_sim_session_uid", uid);
        setCurrentUser({ uid, email: lowerEmail });
        setUserProfile(newProfile);
      }
    }
  }
  async function signIn(email: string, senha: string, remember: boolean) {
    if (remember) {
      localStorage.setItem("tibia_auth_remember", "true");
      localStorage.setItem("tibia_auth_email", email);
      localStorage.setItem("tibia_auth_pass", senha);
    } else {
      localStorage.removeItem("tibia_auth_remember");
      localStorage.removeItem("tibia_auth_email");
      localStorage.removeItem("tibia_auth_pass");
    }
    // Salvar credenciais para auto-login se estiver ativo
    if (localStorage.getItem("tibia_auto_login") === "true") {
      localStorage.setItem("tibia_saved_email", btoa(email));
      localStorage.setItem("tibia_saved_pass", btoa(senha));
    }
    if (!isSimulationMode && auth && db) {
      try {
        await setPersistence(auth, browserSessionPersistence);
        const userCredential = await signInWithEmailAndPassword(auth, email, senha);
        const user = userCredential.user;
        
        markSessionStart();

        const userDocRef = doc(db, "users", user.uid);
        const docSnap = await getDoc(userDocRef);
        if (docSnap.exists()) {
          const profile = docSnap.data() as UserProfile;

          setUserProfile(profile);
          if (profile.status === "pendente") {
            setRequestPendingLocally(true);
            localStorage.setItem("tibia_auth_pending_locally", "true");
          } else {
            setRequestPendingLocally(false);
            localStorage.removeItem("tibia_auth_pending_locally");
          }
        }
        setCurrentUser(user);
      } catch (e: any) {
        throw new Error(e.message || "E-mail ou senha inválidos.");
      }
    } else {
      // Simulation Sign In
      const lowerEmail = email.toLowerCase().trim();
      const found = simUsers.find(u => u.email.toLowerCase() === lowerEmail);
      if (!found) {
        throw new Error("Usuário não cadastrado.");
      }
      const passRaw = localStorage.getItem("tibia_sim_passwords") || "{}";
      const passObj = JSON.parse(passRaw);
      const correctPass = passObj[found.uid];
      if (correctPass !== senha) {
        throw new Error("Senha incorreta.");
      }
      // Successful simulated login
      sessionStorage.setItem("tibia_sim_session_uid", found.uid);
      markSessionStart();
      setCurrentUser({ uid: found.uid, email: found.email });
      setUserProfile(found);
      if (found.status === "pendente") {
        setRequestPendingLocally(true);
        localStorage.setItem("tibia_auth_pending_locally", "true");
      } else {
        setRequestPendingLocally(false);
        localStorage.removeItem("tibia_auth_pending_locally");
      }
    }
  }
  async function signOut() {
    // Limpar activeSessionId do Firestore (sessão única)
    const uid = currentUser?.uid || currentUserRef.current?.uid;
    if (!isSimulationMode && db && uid && activeSessionIdRef.current) {
      try {
        await updateDoc(doc(db, "users", uid), { activeSessionId: "" });
      } catch (_) {}
    }
    activeSessionIdRef.current = "";

    if (!isSimulationMode && auth) {
      try {
        await fbSignOut(auth);
      } catch (_) {}
    }
    
    // Limpeza completa de chaves e estados
    sessionStorage.removeItem("tibia_sim_session_uid");
    sessionStorage.removeItem("tibia_auto_login_executed");
    localStorage.removeItem("tibia_auto_login");
    localStorage.removeItem("tibia_saved_email");
    localStorage.removeItem("tibia_saved_pass");
    localStorage.removeItem("tibia_auth_pending_locally");
    
    // Libera o bloqueio de uso excessivo (garante que o modal nunca prenda o usuário)
    try { clearBlock(); } catch {}
    setRateLimited(false);
    setRateLimitSecondsLeft(0);

    setCurrentUser(null);
    setUserProfile(null);
    setRequestPendingLocally(false);
  }

  // ============================================================================
  // SESSÃO ÚNICA POR USUÁRIO COM IDENTIDADE PERSISTENTE DO DISPOSITIVO
  // ============================================================================
  // O app mantém um identificador permanente por instalação/navegador no
  // localStorage (`tibia_device_id`). Ao checar ou reivindicar a sessão, o
  // `activeSessionId` gravado em users/{uid} é exatamente esse deviceId.
  // Assim, reiniciar o app, atualizar a página ou fazer login/auto-login
  // no MESMO computador não acusa conflito de sessão nem expulsa o usuário.
  // Apenas outro computador/navegador (com deviceId diferente) acusa conflito.
  // ============================================================================
  const activeSessionIdRef = useRef<string>("");

  function getOrCreateDeviceId(): string {
    try {
      const existing = localStorage.getItem("tibia_device_id");
      if (existing && existing.trim()) return existing;
      const newId = "dev_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2);
      localStorage.setItem("tibia_device_id", newId);
      return newId;
    } catch {
      return "dev_fallback_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2);
    }
  }

  // checkActiveSession: verifica se já existe sessão ativa ANTES de completar o login.
  // A reivindicação da sessão é ATÔMICA via runTransaction, eliminando a race condition
  // em que dois dispositivos poderiam ler o campo vazio e gravar simultaneamente.
  // Armazena credenciais temporárias para uso posterior em disconnectOtherSessions.
  const pendingCredentialsRef = useRef<{ email: string; senha: string; remember: boolean } | null>(null);

  async function checkActiveSession(email: string, senha: string): Promise<"free" | "occupied"> {
    if (isSimulationMode || !auth || !db) return "free";

    // Bloqueia onAuthStateChanged de disparar redirecionamento/unmount de AuthModal
    // enquanto fazemos a validação da sessão.
    isCheckingSessionRef.current = true;

    try {
      await setPersistence(auth, browserSessionPersistence);
      const cred = await signInWithEmailAndPassword(auth, email, senha);
      const uid = cred.user.uid;
      const userRef = doc(db, "users", uid);
      const localDeviceId = getOrCreateDeviceId();

      const txResult = await runTransaction(db, async (tx) => {
        const snap = await tx.get(userRef);
        if (!snap.exists()) {
          throw new Error("Perfil de usuário não encontrado.");
        }
        const data = snap.data() as any;
        const remoteSessionId = data.activeSessionId || "";
        // Se existe sessão remota registrada E ela pertence a um dispositivo diferente
        if (remoteSessionId && remoteSessionId !== localDeviceId) {
          return { occupied: true, profile: data };
        }
        // Sessão livre OU já pertence a este mesmo dispositivo (reload/restart)
        tx.update(userRef, {
          activeSessionId: localDeviceId,
          sessionUpdatedAt: Date.now()
        });
        return { occupied: false, profile: data };
      });

      if (txResult.occupied) {
        pendingCredentialsRef.current = { email, senha, remember: false };
        try { await fbSignOut(auth); } catch {}
        // Desbloqueia onAuthStateChanged após retornar null de forma limpa
        isCheckingSessionRef.current = false;
        return "occupied";
      }

      activeSessionIdRef.current = localDeviceId;
      markSessionStart();
      const profile = txResult.profile as UserProfile;
      if (profile) {
        setUserProfile(profile);
        if (profile.status === "pendente") {
          setRequestPendingLocally(true);
          localStorage.setItem("tibia_auth_pending_locally", "true");
        } else {
          setRequestPendingLocally(false);
          localStorage.removeItem("tibia_auth_pending_locally");
        }
      }
      
      // Desbloqueia onAuthStateChanged e completa login definindo o usuário
      isCheckingSessionRef.current = false;
      setCurrentUser(cred.user);
      return "free";
    } catch (e: any) {
      isCheckingSessionRef.current = false;
      throw new Error(e.message || "E-mail ou senha inválidos.");
    }
  }

  // disconnectOtherSessions: apenas invalida todas as outras sessões definindo activeSessionId = "".
  // Aguarda a confirmação da operação (Firestore atualizado com sucesso).
  async function disconnectOtherSessions(): Promise<void> {
    const creds = pendingCredentialsRef.current;
    if (!creds) throw new Error("Nenhuma credencial pendente para desconectar dispositivos.");

    if (isSimulationMode || !auth || !db) return;

    isCheckingSessionRef.current = true;

    try {
      await setPersistence(auth, browserSessionPersistence);
      const cred = await signInWithEmailAndPassword(auth, creds.email, creds.senha);
      const uid = cred.user.uid;
      const userRef = doc(db, "users", uid);

      await runTransaction(db, async (tx) => {
        const snap = await tx.get(userRef);
        if (!snap.exists()) {
          throw new Error("Perfil de usuário não encontrado.");
        }
        tx.update(userRef, {
          activeSessionId: "",
          sessionUpdatedAt: Date.now()
        });
      });

      // Desconectar o cliente local temporário do Auth
      try { await fbSignOut(auth); } catch {}

      pendingCredentialsRef.current = null;
      isCheckingSessionRef.current = false;
    } catch (e: any) {
      isCheckingSessionRef.current = false;
      throw new Error(e.message || "Erro ao desconectar outros dispositivos.");
    }
  }

  // --- Boss / VIP Actions ---
  async function approveUser(uid: string) {
    if (!isSimulationMode && db) {
      const userRef = doc(db, "users", uid);
      await updateDoc(userRef, { status: "aprovado" });
    } else {
      setSimUsers(prev => prev.map(u => u.uid === uid ? { ...u, status: "aprovado" as const } : u));
    }
  }
  async function refuseUser(uid: string) {
    if (!isSimulationMode && db) {
      const userRef = doc(db, "users", uid);
      await updateDoc(userRef, { status: "recusado" });
    } else {
      setSimUsers(prev => prev.map(u => u.uid === uid ? { ...u, status: "recusado" as const } : u));
    }
  }
  async function changeUserRole(uid: string, role: UserRole) {
    if (!isSimulationMode && db) {
      const userRef = doc(db, "users", uid);
      await updateDoc(userRef, { role });
    } else {
      setSimUsers(prev => prev.map(u => u.uid === uid ? { ...u, role } : u));
    }
  }
  async function dismissNotification(id: string) {
    if (!isSimulationMode && db) {
      const notifRef = doc(db, "notifications", id);
      await updateDoc(notifRef, { status: "read" });
    } else {
      setSimNotifs(prev => prev.map(n => n.id === id ? { ...n, status: "read" as const } : n));
    }
  }
  // Marcar notificação como ignorada pelo Boss (gravar no Firestore)
  async function ignoreNotification(id: string) {
    try {
      if (!isSimulationMode && db && currentUser?.uid) {
        const notifRef = doc(db, "notifications", id);
        await updateDoc(notifRef, {
          ignored: true,
          ignoredAt: serverTimestamp(),
          ignoredBy: currentUser.uid
        });
      } else {
        setSimNotifs(prev => prev.map(n => n.id === id ? {
          ...n,
          ignored: true,
          ignoredAt: Date.now(),
          ignoredBy: currentUser?.uid || "sim_boss"
        } : n));
      }
    } catch (_) {}
  }
  async function updateUserProfile(patch: Partial<UserProfile>) {
    if (!currentUser || !userProfile) return;
    try {
      if (!isSimulationMode && db) {
        const userRef = doc(db, "users", currentUser.uid);
        await updateDoc(userRef, patch);
      }
      // Atualizar localmente independente de simulação ou não
      setUserProfile({ ...userProfile, ...patch });
      if (isSimulationMode) {
        setSimUsers(prev => prev.map(u => u.uid === currentUser.uid ? { ...u, ...patch } : u));
      }
    } catch (_) {}
  }
  // --- LISTENER: valida o documento users/{uid} em tempo real ---
  // Regras:
  //   1. Se o documento for excluído → logout local imediato.
  //   2. Se status === "recusado" → logout local imediato.
  //   3. Se activeSessionId remoto for diferente do local → esta sessão foi
  //      invalidada por outro dispositivo → logout local imediato.
  useEffect(() => {
    if (!currentUser?.uid) return;
    let isInitialSnapshot = true;

    if (!isSimulationMode && db) {
      try {
        const userRef = doc(db, "users", currentUser.uid);
        const unsubscribe = onSnapshot(userRef, (snap) => {
          try {
            if (!snap.exists()) {
              activeSessionIdRef.current = "";
              signOut().catch(() => {});
              return;
            }
            const data = snap.data() as any;
            setUserProfile(prev => prev ? { ...prev, ...data } as UserProfile : data as UserProfile);
            if (data.status === "recusado") {
              activeSessionIdRef.current = "";
              signOut().catch(() => {});
              return;
            }

            // Ignorar a checagem de activeSessionId apenas no snapshot inicial de montagem
            // do listener, pois a sessão atual acabou de ser validada com segurança
            // pelo checkActiveSession. Reagir ao snapshot inicial do cache pode
            // causar desconexão própria acidental por race condition de sincronização.
            if (isInitialSnapshot) {
              isInitialSnapshot = false;
              return;
            }

            const remoteSessionId = data.activeSessionId || "";
            const localDeviceId = getOrCreateDeviceId();
            if (
              activeSessionIdRef.current &&
              remoteSessionId &&
              remoteSessionId !== activeSessionIdRef.current &&
              remoteSessionId !== localDeviceId
            ) {
              // NÃO limpar o activeSessionId remoto — a nova sessão é a dona válida.
              activeSessionIdRef.current = "";
              // Logout local imediato: mesmo se o fbSignOut falhar, o app perde acesso.
              setCurrentUser(null);
              setUserProfile(null);
              setRequestPendingLocally(false);
              try { fbSignOut(auth!).catch(() => {}); } catch {}
              return;
            }
          } catch (_) {}
        }, () => {});
        return () => {
          isInitialSnapshot = false;
          unsubscribe();
        };
      } catch (_) {}
    } else {
      // Modo simulação: apenas mantém o comportamento anterior de recusa
      try {
        const found = simUsers.find(u => u.uid === currentUser.uid);
        if (found?.status === "recusado") {
          signOut().catch(() => {});
        }
      } catch (_) {}
    }
  }, [currentUser?.uid, simUsers]);

  // Centralized log sending — dirty-check: só envia se o total de ops mudou desde o último envio
  const lastSentLogTotalRef = useRef(0);
  const [loggerGovernance, setLoggerGovernanceState] = useState(() => getLoggerGovernance());

  useEffect(() => {
    setLoggerGovernanceState(getLoggerGovernance());
    return subscribeLoggerGovernance(setLoggerGovernanceState);
  }, []);

  const [presenceGovernance, setPresenceGovernanceState] = useState(() => getPresenceGovernance());

  useEffect(() => {
    setPresenceGovernanceState(getPresenceGovernance());
    return subscribePresenceGovernance(setPresenceGovernanceState);
  }, []);

  useEffect(() => {
    if (!currentUser || !userProfile || userProfile.status !== "aprovado") return;
    if (isSimulationMode) return;
    if (!db) return;
    if (isIdleMode) return;
    if (loggerGovernance.paused) return;

    const sendLogsIfNeeded = () => {
      try {
        if (getLoggerGovernance().paused) return;
        const stats = getStats();
        const total = stats.totalReads + stats.totalWrites + stats.totalDeletes;
        if (total === 0 || total === lastSentLogTotalRef.current) return;
        lastSentLogTotalRef.current = total;
        saveUserLogsToFirestore(db as any, currentUser.uid, stats, getLogs()).catch(() => {});
      } catch {}
    };

    sendLogsIfNeeded();

    const interval = setInterval(sendLogsIfNeeded, loggerGovernance.sendIntervalSeconds * 1000);

    window.addEventListener("beforeunload", sendLogsIfNeeded);

    return () => {
      clearInterval(interval);
      window.removeEventListener("beforeunload", sendLogsIfNeeded);
      sendLogsIfNeeded();
    };
  }, [currentUser, userProfile, loggerGovernance.paused, loggerGovernance.sendIntervalSeconds, isIdleMode]);

  // Presence heartbeat — 10 min interval (600.000ms)
  // Requisitos: lastLoginAt, lastActivityAt, lastLogoutAt, isOnline
  useEffect(() => {
    if (!currentUser || !userProfile || userProfile.status !== "aprovado") return;
    if (isIdleMode) return;
    if (!presenceGovernance.enabled) return;
    if (isSimulationMode || !db) return;

    const IDLE_THRESHOLD_MS = 6 * 60 * 1000; // 6 minutos de ociosidade (2x intervalo)
    const HEARTBEAT_INTERVAL_MS = 180 * 1000; // 180 segundos (3 minutos)
    const ACTIVITY_THROTTLE_MS = 10000; // throttle de 10s para detecção de atividade

    const userRef = doc(db, "presence", currentUser.uid);
    let lastActivityTime = Date.now();
    let wentIdle = false;
    let lastEventTime = 0;

    const updatePresence = async (fields: Record<string, any>) => {
      if (checkRateLimit()) return;
      try {
        await setDoc(userRef, {
          uid: currentUser.uid,
          displayName: userProfile.nome || currentUser.email || "Anônimo",
          role: effectiveUserProfile?.role || "Normal",
          ...fields,
          updatedAt: serverTimestamp(),
        }, { merge: true });
      } catch (err) {
        console.error("Erro ao atualizar presença:", err);
      }
    };

    // Heartbeat inicial (Login)
    updatePresence({
      lastLoginAt: serverTimestamp(),
      lastActivityAt: serverTimestamp(),
      isOnline: true
    });

    const runHeartbeat = async () => {
      const isIdle = Date.now() - lastActivityTime > IDLE_THRESHOLD_MS;
      
      if (isIdle) {
        if (!wentIdle) {
          wentIdle = true;
          setIsUserIdle(true);
          // Marca como offline no Firestore se ultrapassou os 30 min
          updatePresence({ isOnline: false });
        }
        return;
      }

      // Heartbeat normal de manutenção
      updatePresence({
        lastActivityAt: serverTimestamp(),
        isOnline: true
      });
    };

    const onUserActivity = () => {
      const now = Date.now();
      if (now - lastEventTime < ACTIVITY_THROTTLE_MS) return;
      lastEventTime = now;
      lastActivityTime = now;

      if (wentIdle) {
        wentIdle = false;
        setIsUserIdle(false);
        updatePresence({
          lastActivityAt: serverTimestamp(),
          isOnline: true
        });
      }
    };

    const activityEvents = ["mousemove", "keydown", "click", "scroll", "touchstart", "wheel"];
    activityEvents.forEach(evt => window.addEventListener(evt, onUserActivity, { passive: true }));

    const interval = setInterval(runHeartbeat, HEARTBEAT_INTERVAL_MS);

    const handleBeforeUnload = () => {
      // Logout silencioso ao fechar aba
      updatePresence({
        lastLogoutAt: serverTimestamp(),
        isOnline: false
      });
    };
    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      clearInterval(interval);
      activityEvents.forEach(evt => window.removeEventListener(evt, onUserActivity));
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser?.uid, userProfile?.status, isIdleMode, presenceGovernance.enabled]);

  // Presence READ listener lives in App.tsx (feeds onlineCount / presenceMap state).
  // Only the WRITE heartbeat lives here to centralize rate-limit logic.

  return (
    <AuthContext.Provider
      value={{
        currentUser,
        userProfile: effectiveUserProfile,
        loading,
        isSimulation: isSimulationMode,
        requestPendingLocally,
        loginErrorCooldown,
        setLoginErrorCooldown,
        signUp,
        signIn,
        signOut,
        approveUser,
        refuseUser,
        changeUserRole,
        allUsers: effectiveAllUsers,
        bossNotifications,
        dismissNotification,
        ignoreNotification,
        updateUserProfile,
        rateLimited,
        rateLimitSecondsLeft,
        rateLimitBlockCount,
        checkRateLimit,
        hasSharedCharChanged,
        isUserIdle,
        isIdleMode,
        isIdleRestoring,
        restoreFromIdle,
        friendshipRecords,
        acceptedFriendUids,
        pendingFriendsCount,
        checkActiveSession,
        disconnectOtherSessions,
      }}
    >
      {children}
      {/* Modal de bloqueio por uso excessivo — fullscreen, acima de tudo.
          Some automaticamente se: cronômetro zerar, usuário desconectar (currentUser null)
          ou reconectar (setUsageMonitorUid reseta o bloqueio na troca de uid). */}
      {rateLimited && currentUser && (
        <FirestoreUsageBlockModal
          secondsLeft={rateLimitSecondsLeft}
          totalSeconds={rateLimitTotalDuration}
          blockCount={userProfile?.rateLimitBlocks !== undefined ? userProfile.rateLimitBlocks : rateLimitBlockCount}
          onDisconnect={() => { signOut().catch(() => {}); }}
        />
      )}
    </AuthContext.Provider>
  );
}
export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within an AuthProvider");
  return context;
}