import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Swords, History as HistoryIcon, BarChart3, StickyNote,
  Save, CheckCircle2, AlertTriangle, Calculator, AppWindow, Users, UserPlus, Archive, User, Clock, Sparkles,
  Lock, LockOpen, ArrowUp, ArrowDown, MessageSquareMore, Heart, Cloud, CloudCog, ShoppingBag, Bell, Trophy,
  SlidersHorizontal, ChevronDown, FileSpreadsheet, Briefcase
} from "lucide-react";
import ExoriLogo from "./components/ExoriLogo";
import type { AppData, Character, CharacterAcquisition, CharacterAcquisitionBuyerDetails, PartyFinalizationReason, PartyTab, PersonalPartyHistory, PtType, WaitingService, SharedService, DialogOptions, ProbableMarkersMap, Vocation } from "./types";
import { setGlobalDialogHandler, customAlert, customConfirm } from "./types";
import { loadData, saveData, exportCSV, exportJSON, importJSON, buildPersonalBackup, normalizeImportedBackup, saveAutoSaveHandle, loadAutoSaveHandle, loadUIState, saveUIState, saveCloseTray, saveStartWithWindows, saveLowCpuUsage, loadSharedCharsCache, saveSharedCharsCache, isSharedCharsCacheFresh, invalidateSharedCharsCache } from "./storage";
import { canViewServiceEntry, canViewServiceForViewer, projectServiceForViewer } from "./utils/serviceVisibility";
import { applyPartyProfitToCharacters, buildCharacterProfitPatch, computePartyProfitMap } from "./utils/partyProfit";
import { calculateAcquiredQuestDrops, calculateAcquiredQuestProfit, confirmCharacterAcquisitionPayment, confirmCharacterAcquisitionSalePayout, createCharacterAcquisition, getCharacterAcquisition, isPaymentConfirmed, subscribeCharacterAcquisitionBuyerDetails, subscribeCharacterAcquisitions, updateCharacterAcquisitionLifecycle, upsertCharacterAcquisitionBuyerDetails } from "./services/characterAcquisitionService";
import { toFirestoreMillis } from "./utils/firestoreTimestamp";
import { getPersonalPartyHistoryEntry, readPersonalPartyHistoryCache, requestPartyFinalization, subscribePersonalPartyHistory } from "./services/partyHistoryService";
import initialBgUrl from "./assets/initial-bg.png";
import CharTable from "./components/CharTable";
import AcquiredCharactersPanel from "./components/AcquiredCharactersPanel";
import CharacterModal from "./components/CharacterModal";
import CurrencyCalculator from "./components/CurrencyCalculator";
import ImbuementsModal from "./components/ImbuementsModal";
import PartyManager from "./components/PartyManager";
import PersonalPartyHistoryList from "./components/PersonalPartyHistoryList";
import StatsPanel from "./components/StatsPanel";
import RankingPanel from "./components/RankingPanel";
import MyServicesPanel from "./components/MyServicesPanel";
import { fetchAllSharedServicesAsWaiting, isServiceProbablyDone, readAllSharedServicesCache, readServiceRequestsCache, readSharedServicesCache, replaceOwnerSharedServicesInWaitingCache } from "./services/sharedServicesService";
import NotesPanel from "./components/NotesPanel";
import WaitingListPanel from "./components/WaitingListPanel";
import { useNotifications } from "./hooks/useNotifications";
import { NotificationCenter } from "./components/NotificationCenter";
import FeedbackModal from "./components/FeedbackModal";
import DonationModal from "./components/DonationModal";
import AdviceDonationModal from "./components/AdviceDonationModal";
import { useAuth } from "./context/AuthContext";
import AuthModal from "./components/AuthModal";
import BossAdminPanel from "./components/BossAdminPanel";
import ReceiveRCModal from "./components/ReceiveRCModal";
import TwitchModal from "./components/TwitchModal";
import BazarPanel from "./components/BazarPanel";
import AutoBidEngine from "./components/AutoBidEngine";
import FriendsModal from "./components/FriendsModal";
import VipAccessButton from "./components/VipAccessButton";
import HubHelpTooltip from "./components/HubHelpTooltip";
import { Shield, HelpCircle, Tv } from "lucide-react";
import { setLoggerPaused, setLoggerRemoteConfig } from "./utils/firestoreLogger";
import { setPresenceGovernance } from "./utils/presenceGovernance";
import { setIdleGovernance } from "./utils/idleGovernance";
import { NOTIFICATION_NAVIGATE_EVENT, dispatchNotificationNavigate, resolveNotificationDestination, type NotificationNavigateDetail } from "./utils/notificationNavigation";
import {
  listenPushNotificationClicks,
  registerPushForUser,
  unregisterPushForUser,
} from "./services/pushNotificationService";
import { syncBazaarEndingAlerts, stopBazaarEndingAlerts } from "./services/bazaarInterestNotificationService";
import { readOfficialBazaarCache, readBazaarInterestsCache } from "./services/bazaarOfficialService";
import { syncNotificationPrefsToCloud } from "./services/notificationPrefsSyncService";
import { buildAcceptedFriendSet, filterVisibleEntitiesWithException } from "./utils/friendshipAccess";
import { useModalViewportBounds } from "./hooks/useModalViewportBounds";

// Firestore imports
import {
  doc,
  collection,
  serverTimestamp,
  query,
  where,
  runTransaction,
  increment,
  deleteField
} from "firebase/firestore";
import { db, setDoc, updateDoc, deleteDoc, onSnapshot, getDocs, getDoc } from "./firebase/config";
// Logs e presence centralizados no AuthContext
const isElectron = typeof window !== 'undefined' && !!(window as any).require;
const SHARED_CHARACTERS_METADATA_REF = { collection: "settings", id: "shared_characters_metadata" } as const;
const SHARED_CHARACTERS_META_CACHE_KEY = "cloud_cache_sharedCharacters_meta";

function usePersistedState(key: string, initial: boolean, saveFunc?: (v: boolean) => void) {
  const [val, setVal] = useState<boolean>(() => {
    try { const v = localStorage.getItem(key); return v !== null ? JSON.parse(v) : initial; } catch { return initial; }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(val));
      if (saveFunc) saveFunc(val);
      window.dispatchEvent(new Event("storage"));
    } catch {}
  }, [key, val]);
  return [val, setVal] as const;
}

type Tab = "ativos" | "meus_services" | "meu_historico" | "pts" | "waitlist";

/**
 * Contagem de "Meus Services" a partir do CACHE LOCAL, sem tocar no Firestore.
 *
 * Espelha o `totalCount` do MyServicesPanel na visão padrão ("Disponíveis"):
 * Services disponíveis + solicitações pendentes. Serve para o badge da aba
 * já nascer correto, antes de o painel ser montado pela primeira vez.
 */
function countMyServicesFromCache(uid: string): number {
  if (!uid) return 0;
  try {
    const disponiveis = readSharedServicesCache(uid).filter(s => s.status === "disponivel").length;
    const pendentes = readServiceRequestsCache(uid).filter(r => r.status === "pendente").length;
    return disponiveis + pendentes;
  } catch {
    return 0;
  }
}

// Sub-visão de "Meus Personagens": alterna entre a tabela de personagens
// disponíveis e a de vendidos (antiga aba "Histórico Meus Personagens").
type CharsView = "disponiveis" | "vendidos" | "adquiridos";
type WindowKey = "characters" | "stats" | "ranking" | "notes" | "bazar";
type AutoSaveStatus = "unconfigured" | "waiting" | "saved" | "error";

/** Dados enviados pelo formulário inline do Painel Bazaar. */
interface BazaarCharacterPurchase {
  name: string;
  level: number;
  server: string;
  vocation: string;
  account: string;
  valorPago: number;
}

interface BazaarCharacterPurchaseResult {
  ok: boolean;
  error?: string;
}

const AUTO_BAZAAR_ENABLED_KEY = "rubinot_bazaar_auto_enabled";
const AUTO_BAZAAR_NOTIFIED_IDS_KEY = "rubinot_bazaar_auto_notified_ids";
const AUTO_BAZAAR_PROCESSED_NOTIFICATIONS_KEY = "rubinot_bazaar_auto_processed_notifications";

function readBazarTimezoneOffsetMinutesForAuto(): number {
  try {
    const raw = localStorage.getItem("rubinot_bazaar_filters");
    const parsed = raw ? JSON.parse(raw) : null;
    const value = Number(parsed?.timezoneOffsetMinutes);
    return Number.isFinite(value) ? value : -180;
  } catch {
    return -180;
  }
}

function getAutoBazaarDateKey(nowMs = Date.now(), offsetMinutes = readBazarTimezoneOffsetMinutesForAuto()): string {
  const shifted = new Date(nowMs + offsetMinutes * 60 * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}


function readAutoBazaarIdSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? new Set(parsed.filter(Boolean).map(String)) : new Set();
  } catch {
    return new Set();
  }
}

function saveAutoBazaarIdSet(key: string, set: Set<string>) {
  try {
    localStorage.setItem(key, JSON.stringify(Array.from(set).slice(-60)));
  } catch {}
}

function getAutoBazaarNotificationId(dateKey: string, targetMs: number): string {
  const target = new Date(targetMs + readBazarTimezoneOffsetMinutesForAuto() * 60 * 1000);
  const hh = String(target.getUTCHours()).padStart(2, "0");
  const mm = String(target.getUTCMinutes()).padStart(2, "0");
  return `bazaar_daily_available_${dateKey}_${hh}${mm}`;
}

function getNextAutoBazaarTriggerMs(nowMs = Date.now(), offsetMinutes = readBazarTimezoneOffsetMinutesForAuto()): number {
  const shifted = new Date(nowMs + offsetMinutes * 60 * 1000);
  const target = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), 10, 5, 0, 0) - offsetMinutes * 60 * 1000;
  if (target <= nowMs) return target + 24 * 60 * 60 * 1000;
  return target;
}

function createLocalCharacterId(): string {
  return "char_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

// Converte a vocação textual do Bazaar para o código interno.
// O fluxo inline não pode criar um Character com vocação vazia; por isso uma
// vocação desconhecida é recusada e o registro do Bazaar permanece intacto.
function mapBazaarVocationToCharacterVocation(vocation: string): Vocation | null {
  const normalized = vocation.trim().toLowerCase();
  if (normalized.includes("paladin")) return "RP";
  if (normalized.includes("sorcerer")) return "MS";
  if (normalized.includes("druid")) return "ED";
  if (normalized.includes("monk")) return "MK";
  if (normalized.includes("knight")) return "EK";
  return null;
}

function normalizeBazaarCharacterNameForCompare(value: string): string {
  // Mantém a mesma normalização usada pelo estado visual da tabela Bazaar.
  return String(value || "").trim().toLowerCase();
}

export default function App() {
  const { currentUser, userProfile, loading: authLoading, signOut: handleSignOut, allUsers, isSimulation, isUserIdle, isIdleMode, isIdleRestoring, acceptedFriendUids, pendingFriendsCount, updateUserProfile } = useAuth();
  // A base global dos modais precisa do espaço físico realmente ocupado pelas
  // barras da aplicação. As variáveis são publicadas no <html>, cobrindo também
  // os modais que usam Portal fora desta árvore React.
  const appHeaderRef = useRef<HTMLElement | null>(null);
  const appFooterRef = useRef<HTMLElement | null>(null);
  const hasApplicationChrome = !authLoading && !!currentUser && userProfile?.status === "aprovado";
  useModalViewportBounds(appHeaderRef, appFooterRef, hasApplicationChrome);

  const [adminOpen, setAdminOpen] = useState(false);
  // Estado para controlar tooltips das abas
  const [activeTooltip, setActiveTooltip] = useState<'privado' | 'publico' | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const tooltipRef = useRef<HTMLDivElement>(null);
  // Abre o tooltip calculando a posição fixa a partir do botão clicado
  function openTooltip(which: 'privado' | 'publico', e: React.MouseEvent<HTMLButtonElement>) {
    if (activeTooltip === which) {
      setActiveTooltip(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const tooltipWidth = 440;
    let left = rect.left;
    // Evita estourar a borda direita da tela
    if (left + tooltipWidth > window.innerWidth - 8) {
      left = window.innerWidth - tooltipWidth - 8;
    }
    if (left < 8) left = 8;
    setTooltipPos({ top: rect.bottom + 8, left });
    setActiveTooltip(which);
  }
  // Fechar tooltip ao clicar fora
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (tooltipRef.current && !tooltipRef.current.contains(event.target as Node)) {
        setActiveTooltip(null);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);
  // PENDING COUNTS para o botão Boss
  const [pendingDonationsCount, setPendingDonationsCount] = useState(0);
  const [pendingRequestsCount, setPendingRequestsCount] = useState(0);
  const [pendingVipCount, setPendingVipCount] = useState(0);
  // CONFIGURAÇÕES GLOBAIS (appSettings/global)
  const [globalSettings, setGlobalSettings] = useState<{
    minimumAverageDonation: number;
    firestoreLoggerPaused: boolean;
    bossBadgesMode: "realtime" | "economy" | "manual";
    firestoreLoggerDetailLevel: "complete" | "summary";
    firestoreLoggerSendIntervalSeconds: 120 | 300 | 600;
    feedbackMode: "manual";
    presenceEnabled: boolean;
    presenceMode: "economico" | "completo";
    idleModeTimeoutMinutes: number;
    publicPartiesEnabled: boolean;
  }>({
    minimumAverageDonation: 10,
    firestoreLoggerPaused: false,
    bossBadgesMode: "realtime",
    firestoreLoggerDetailLevel: "complete",
    firestoreLoggerSendIntervalSeconds: 120,
    feedbackMode: "manual",
    presenceEnabled: true,
    presenceMode: "completo",
    idleModeTimeoutMinutes: 30,
    publicPartiesEnabled: true,
  });

  // Reseta as configurações globais sempre que o usuário trocar.
  // Evita misturar estado de um usuário antigo com o novo.
  useEffect(() => {
    setGlobalSettings({
      minimumAverageDonation: 10,
      firestoreLoggerPaused: false,
      bossBadgesMode: "realtime",
      firestoreLoggerDetailLevel: "complete",
      firestoreLoggerSendIntervalSeconds: 120,
      feedbackMode: "manual",
      presenceEnabled: true,
      presenceMode: "completo",
      idleModeTimeoutMinutes: 30,
      publicPartiesEnabled: true,
    });
  }, [currentUser?.uid]);

  // LOCAL DATA - mantido exatamente como estava (characters, notes, auto-save)
  const [data, setData] = useState<AppData>({ characters: [], notes: "", parties: [], waitingList: [] });
  // Fonte canônica das negociações financeiras temporárias de personagens.
  // A relação não é gravada em `Character`, pois o dono original permanece igual.
  /** Negociações efetivamente confirmadas: fonte da guia, Stats e venda. */
  const [characterAcquisitions, setCharacterAcquisitions] = useState<CharacterAcquisition[]>([]);
  /** Pré-aprovações são carregadas somente ao usar o Gerenciador de PTs. */
  const [pendingCharacterAcquisitions, setPendingCharacterAcquisitions] = useState<CharacterAcquisition[]>([]);
  const [characterAcquisitionBuyerDetails, setCharacterAcquisitionBuyerDetails] = useState<CharacterAcquisitionBuyerDetails[]>([]);
  // Evita leituras pontuais repetidas ao recuperar detalhes privados de Quest
  // para um comprador que estava com o aplicativo fechado.
  const recoveredAcquisitionDetailsRef = useRef<Set<string>>(new Set());

  // CLOUD DATA - separado em ATIVAS (sempre ouvidas) e ARQUIVADAS (lazy)
  // para reduzir consumo de leituras no Firestore
  const [cloudPartiesActive, setCloudPartiesActive] = useState<PartyTab[]>(() => {
    try {
      const cached = localStorage.getItem("cloud_cache_parties_active");
      if (cached) return JSON.parse(cached);
      // Migração: tentar usar o cache antigo "cloud_cache_parties" e filtrar
      const legacy = localStorage.getItem("cloud_cache_parties");
      if (legacy) {
        const parsed = JSON.parse(legacy) as PartyTab[];
        return parsed.filter(p => !p.archived);
      }
      return [];
    } catch { return []; }
  });
  // Histórico privado: fonte principal da guia Histórico de PT's para PTs novas.
  // O listener só é montado enquanto a guia estiver aberta; fora dela, o estado
  // retém o último valor conhecido (o contador da guia não pode zerar).
  const [personalPartyHistory, setPersonalPartyHistory] = useState<PersonalPartyHistory[]>([]);

  // CONTADOR PERSISTENTE: hidrata o histórico a partir do espelho local
  // (gravado pelo próprio listener a cada snapshot). Assim o contador da guia
  // "Meu Histórico de PT's" nasce com o último valor conhecido — na
  // inicialização e na troca de conta — SEM nenhuma leitura do Firestore. O
  // listener da guia continua sendo a fonte de verdade e regrava o espelho.
  useEffect(() => {
    setPersonalPartyHistory(
      currentUser?.uid && userProfile?.status === "aprovado"
        ? readPersonalPartyHistoryCache(currentUser.uid)
        : [],
    );
  }, [currentUser?.uid, userProfile?.status]);

  // PTs públicas (carregadas sob demanda via getDocs() ao abrir aba "Gerenciador de PT's")
  const [cloudPartiesPublic, setCloudPartiesPublic] = useState<PartyTab[]>([]);
  // Helper: remove uma PT da lista pública (usado em deleteParty)
  function removePartyFromPublic(id: string) {
    setCloudPartiesPublic(prev => prev.filter(p => p.id !== id));
  }

  // Lista unificada (apenas memo) para manter compatibilidade com o restante do código.
  // Deduplica por ID: party do listener do usuário (active) tem prioridade sobre
  // a mesma party carregada via getDocs() (public).
  const cloudParties = useMemo<PartyTab[]>(() => {
    const map = new Map<string, PartyTab>();
    cloudPartiesActive.forEach(p => map.set(p.id, p));
    cloudPartiesPublic.forEach(p => { if (!map.has(p.id)) map.set(p.id, p); });
    return Array.from(map.values());
  }, [cloudPartiesActive, cloudPartiesPublic]);
  // Helper para atualizar uma PT no estado local (usado em writes optimistas).
  // O histórico oficial das PTs finalizadas é a projeção privada
  // users/{uid}/partyHistory, gravada pelo backend — aqui só existem ativas.
  function patchPartyInState(updated: PartyTab) {
    if (updated.archived) {
      setCloudPartiesActive(prev => prev.filter(p => p.id !== updated.id));
    } else {
      setCloudPartiesActive(prev => {
        const exists = prev.some(p => p.id === updated.id);
        return exists ? prev.map(p => p.id === updated.id ? updated : p) : [...prev, updated];
      });
    }
  }

  // Services vindos de `sharedServices` (fonte oficial), já adaptados para
  // `WaitingService`. Alimentam a ServiceList e, por ela, todos os consumidores.
  const [sharedServicesList, setSharedServicesList] = useState<WaitingService[]>(() => readAllSharedServicesCache());
  // Contador do botão "Meus Services": quantos Services pertencem ao usuário.
  // Lê o cache local que o próprio painel mantém — sem leitura extra.
  //
  // O painel só existe enquanto a aba está aberta, então ele não pode ser a
  // ÚNICA fonte do número: ao entrar no app (aba padrão "Meus Personagens")
  // o badge ficava em 0 até a aba ser visitada pela primeira vez. O valor
  // inicial vem do cache, exatamente como `ativos`/`vendidos` de "Meus
  // Personagens" saem de `data.characters`, que já está hidratado.
  //
  // Enquanto a aba estiver aberta, o painel assume via `onCountChange` — ele
  // conhece a seção ativa (Disponíveis/Realizados) e os pendentes.
  const [myServicesCount, setMyServicesCount] = useState(() => countMyServicesFromCache(""));

  const [cloudWaitingList, setCloudWaitingList] = useState<WaitingService[]>(() => {
    try {
      const cached = localStorage.getItem("cloud_cache_waitingList");
      return cached ? JSON.parse(cached) : [];
    } catch { return []; }
  });

  const [sharedCharacters, setSharedCharacters] = useState<Character[]>(() => {
    // Inicializa a partir do cache local (válido ou expirado).
    // O conteúdo é exibido imediatamente; se estiver expirado (TTL),
    // uma nova leitura sob demanda será disparada ao abrir a aba "Gerenciador de PT's".
    try {
      const { data } = loadSharedCharsCache();
      return data;
    } catch { return []; }
  });

  // ============================================================================
  // PROBABLE MARKERS — mapa de "provável Quest concluída"
  // Carregado junto com sharedCharacters (extraindo o campo probableMarkers
  // de cada documento). Também carregado isoladamente no login para o próprio
  // usuário (sharedCharacters/{uid}), garantindo que o aviso visual no CharTable
  // funcione mesmo antes de abrir a aba "Gerenciador de PT's".
  // ============================================================================
  const [probableMarkers, setProbableMarkers] = useState<ProbableMarkersMap>(() => {
    try {
      const raw = localStorage.getItem("cloud_cache_probableMarkers");
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  });

  // Estados de conexão e sincronização para o rodapé
  const [isOnline, setIsOnline] = useState<boolean>(typeof navigator !== 'undefined' ? navigator.onLine : true);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [onlineCount, setOnlineCount] = useState<number>(() => {
    try {
      const cached = localStorage.getItem("presence_count_fallback");
      return cached ? parseInt(cached, 10) || 1 : 1;
    } catch { return 1; }
  });
  const [presenceCountUnavailable, setPresenceCountUnavailable] = useState(false);
  // Mapa centralizado de presença: uid -> lastSeen em milissegundos (alimentado pelo único listener de presence)
  const [presenceMap, setPresenceMap] = useState<Record<string, any>>({});

  const [tab, setTab] = useState<Tab>("ativos");
  // "DISPONÍVEIS" é o padrão ao entrar em Meus Personagens.
  const [charsView, setCharsView] = useState<CharsView>("disponiveis");

  // Badge de "Meus Services" enquanto a aba está FECHADA (o painel não está
  // montado e não pode informar o total). Recalculado do cache local, sem
  // leitura no Firestore. Com a aba aberta, o `onCountChange` do painel manda.
  const isMyServicesTabOpen = tab === "meus_services";
  useEffect(() => {
    if (isMyServicesTabOpen) return;
    setMyServicesCount(countMyServicesFromCache(currentUser?.uid || ""));
  }, [isMyServicesTabOpen, currentUser?.uid, userProfile?.status]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Character | null>(null);
  const [characterModalMode, setCharacterModalMode] = useState<"create" | "edit">("create");
  const [calcOpen, setCalcOpen] = useState(false);
  // Guia de Imbuements: modal somente-leitura, sem qualquer efeito nos dados.
  const [imbueOpen, setImbueOpen] = useState(false);
  // Contador de cliques no botão "Câmbio". Só marcar `calcOpen` como `true`
  // não basta: se a janela já está aberta o valor não muda, nenhum efeito
  // roda e o clique se perde. Este contador é o sinal de "trazer para frente".
  const [calcFocusSignal, setCalcFocusSignal] = useState(0);

  /** Abre o conversor ou, se já estiver aberto, traz a janela para frente. */
  function handleOpenCalc() {
    setCalcOpen(true);
    setCalcFocusSignal(value => value + 1);
  }
  const [userName, setUserName] = useState(() => loadUIState("tibia_user_name", ""));

  // Sync profile name to userName
  useEffect(() => {
    if (userProfile?.nome) {
      setUserName(userProfile.nome);
      saveUIState("tibia_user_name", userProfile.nome);
    }
  }, [userProfile]);
  const displayUserName = userName || userProfile?.nome || currentUser?.displayName || "Anônimo";

  // Listener das configurações globais do aplicativo (appSettings/global)
  // Este é o ÚNICO listener responsável por manter `globalSettings` atualizado.
  // Os componentes que consomem essas configurações dependem de re-renderização
  // direta, sem refresh manual. Por isso NÃO removemos este listener.
  useEffect(() => {
    if (isSimulation || !db) return;

    // Tenta criar o documento se não existir (inicialização)
    async function initializeGlobalSettings() {
      try {
        const snap = await getDoc(doc(db, "appSettings", "global"));
        if (!snap.exists()) {
          await setDoc(doc(db, "appSettings", "global"), {
            minimumAverageDonation: 10,
            firestoreLoggerPaused: false,
            bossBadgesMode: "realtime",
            firestoreLoggerDetailLevel: "complete",
            firestoreLoggerSendIntervalSeconds: 120,
            feedbackMode: "manual",
            presenceEnabled: true,
            presenceMode: "completo",
            idleModeTimeoutMinutes: 30,
            publicPartiesEnabled: true,
            updatedAt: serverTimestamp()
          }, { merge: true });
        }
      } catch {}
    }
    initializeGlobalSettings();

    // Listener único para todos os usuários
    const unsub = onSnapshot(doc(db, "appSettings", "global"), (snap) => {
      const data = snap.exists() ? snap.data() : {};
      const loggerInterval = data.firestoreLoggerSendIntervalSeconds === 300 || data.firestoreLoggerSendIntervalSeconds === 600 ? data.firestoreLoggerSendIntervalSeconds : 120;
      const idleTimeoutMinutes = typeof data.idleModeTimeoutMinutes === "number" && data.idleModeTimeoutMinutes > 0 ? Math.max(1, Math.min(1440, Math.floor(data.idleModeTimeoutMinutes))) : 30;
      const newSettings = {
        minimumAverageDonation: typeof data.minimumAverageDonation === "number" ? data.minimumAverageDonation : 10,
        firestoreLoggerPaused: data.firestoreLoggerPaused === true,
        bossBadgesMode: (data.bossBadgesMode === "economy" || data.bossBadgesMode === "manual" ? data.bossBadgesMode : "realtime") as "realtime" | "economy" | "manual",
        firestoreLoggerDetailLevel: (data.firestoreLoggerDetailLevel === "summary" ? "summary" : "complete") as "complete" | "summary",
        firestoreLoggerSendIntervalSeconds: loggerInterval as 120 | 300 | 600,
        feedbackMode: "manual" as const,
        presenceEnabled: data.presenceEnabled !== false,
        presenceMode: (data.presenceMode === "economico" ? "economico" : "completo") as "economico" | "completo",
        idleModeTimeoutMinutes: idleTimeoutMinutes,
        publicPartiesEnabled: data.publicPartiesEnabled !== false,
      };
      setGlobalSettings(newSettings);
      // Aplica imediatamente o status de pausa e as configurações remotas do logger local
      setLoggerPaused(newSettings.firestoreLoggerPaused);
      setLoggerRemoteConfig({
        detailLevel: newSettings.firestoreLoggerDetailLevel,
        sendIntervalSeconds: newSettings.firestoreLoggerSendIntervalSeconds,
      });
      setPresenceGovernance({
        enabled: newSettings.presenceEnabled,
        mode: newSettings.presenceMode,
      });
      setIdleGovernance({ timeoutMinutes: newSettings.idleModeTimeoutMinutes });
    }, () => {});

    return () => unsub();
  }, [isSimulation, currentUser?.uid]);

  const [customDialog, setCustomDialog] = useState<DialogOptions | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [autoSaveHandle, setAutoSaveHandle] = useState<any>(null);
  const [autoSaveName, setAutoSaveName] = useState("");
  const [autoSaveStatus, setAutoSaveStatus] = useState<AutoSaveStatus>("unconfigured");
  const [autoSaveInfoOpen, setAutoSaveInfoOpen] = useState(false);
  const autoSaveTimerRef = useRef<number | null>(null);

  // Nome de arquivo de auto-save pré-programado por usuário: "ChernobylTeam-AutoSave-{nome}"
  const autoSaveFileName = useMemo(() => {
    const raw = (userProfile?.nome || displayUserName || "Usuario").trim();
    const sanitized = raw.replace(/[^a-zA-Z0-9_-]/g, "") || "Usuario";
    return `ChernobylTeam-AutoSave-${sanitized}`;
  }, [userProfile?.nome, displayUserName]);

  // Atualiza o estado do AUTO-SAVE e persiste vinculado ao usuário logado
  function updateAutoSaveStatus(next: AutoSaveStatus) {
    setAutoSaveStatus(next);
    try {
      const uid = currentUser?.uid;
      if (uid) localStorage.setItem(`tibia_autosave_state_${uid}`, next);
    } catch {}
  }

  // Atualiza o nome do arquivo de auto-save e persiste vinculado ao usuário logado
  function updateAutoSaveName(next: string) {
    setAutoSaveName(next);
    try {
      const uid = currentUser?.uid;
      if (uid) localStorage.setItem(`tibia_autosave_name_${uid}`, next);
    } catch {}
  }

  // Restaurar o estado do AUTO-SAVE salvo para o usuário logado (ou resetar se for novo usuário)
  useEffect(() => {
    const uid = currentUser?.uid;
    if (!uid) return;
    try {
      const savedStatus = localStorage.getItem(`tibia_autosave_state_${uid}`);
      const savedName = localStorage.getItem(`tibia_autosave_name_${uid}`);
      if (savedStatus === "saved" || savedStatus === "waiting" || savedStatus === "error" || savedStatus === "unconfigured") {
        setAutoSaveStatus(savedStatus);
        setAutoSaveName(savedName || "");
      } else {
        setAutoSaveStatus("unconfigured");
        setAutoSaveName("");
      }
    } catch {
      setAutoSaveStatus("unconfigured");
      setAutoSaveName("");
    }
  }, [currentUser?.uid]);
  const [activePt, setActivePt] = useState<string | null>(null);
  const [minimized, setMinimized] = useState<Record<string, boolean>>({});
  const [activeWindow, setActiveWindow] = useState<WindowKey | null>(null);
  const [headerZoomLevel, setHeaderZoomLevel] = useState(() => loadUIState("tibia_header_zoom_level", 100));
  const [contentZoomLevel, setContentZoomLevel] = useState(() => loadUIState("tibia_content_zoom_level", 100));

  // Persistir zoom dos cabeçalhos
  useEffect(() => {
    saveUIState("tibia_header_zoom_level", headerZoomLevel);
  }, [headerZoomLevel]);

  // Persistir zoom dos conteúdos
  useEffect(() => {
    saveUIState("tibia_content_zoom_level", contentZoomLevel);
  }, [contentZoomLevel]);

  const [notificationOpen, setNotificationOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [donationOpen, setDonationOpen] = useState(false);
  const [adviceDonationOpen, setAdviceDonationOpen] = useState(false);
  const [receiveRCOpen, setReceiveRCOpen] = useState(false);
  const [twitchOpen, setTwitchOpen] = useState(false);
  const [friendsOpen, setFriendsOpen] = useState(false);
  const [closeTray, setCloseTray] = usePersistedState("tibia_close_to_tray", true, saveCloseTray);
  const [startWithWindows, setStartWithWindows] = usePersistedState("tibia_start_with_windows", false, saveStartWithWindows);
  const [lowCpuUsage, setLowCpuUsage] = usePersistedState("tibia_low_cpu_usage", false, saveLowCpuUsage);

  // Espelha "Poupar CPU" no <html> para que o CSS possa desligar as animações
  // contínuas (ex.: a borda pulsante dos botões principais em .nav-pill).
  useEffect(() => {
    document.documentElement.classList.toggle("low-cpu", lowCpuUsage);
  }, [lowCpuUsage]);

  function toggleNotificationMenu() {
    setNotificationOpen(v => !v);
  }

  // Destaque temporário do card no "Meu Histórico de PT's" quando a navegação
  // vem do botão "Ver PT" de uma notificação. Estado puramente de frontend
  // (nada no Firestore), consumido pelo card assim que localizado — mesmo
  // padrão do antigo destaque da guia "Histórico de PT's".
  const [highlightedHistoryPartyId, setHighlightedHistoryPartyId] = useState<string | null>(null);
  // Estável (setter do useState é fixo): evita que cada render do App re-dispare
  // o efeito de destaque do histórico por identidade nova de callback.
  const clearHistoryHighlight = useCallback(() => setHighlightedHistoryPartyId(null), []);
  // O destaque só existe como consequência da navegação pelo "Ver PT": ao
  // sair da guia ele é limpo — abrir o "Meu Histórico" normalmente nunca
  // exibe card destacado.
  useEffect(() => {
    if (tab !== "meu_historico") setHighlightedHistoryPartyId(null);
  }, [tab]);

  // Destaque equivalente na guia Services: entrada da Lista de Espera vinda
  // do clique na notificação de service "Qualquer um" (serviceId). Mesmo
  // ciclo de vida do destaque do histórico — nasce da navegação, morre ao
  // sair da guia.
  const [highlightedWaitingServiceId, setHighlightedWaitingServiceId] = useState<string | null>(null);
  useEffect(() => {
    if (tab !== "waitlist") setHighlightedWaitingServiceId(null);
  }, [tab]);
  /**
   * Navegação vinda da notificação de nova solicitação de Service.
   *
   * Chamada pelo ROTEADOR ÚNICO de notificações (abaixo), que resolve o
   * destino de todos os tipos. No Electron, a restauração da janela é feita
   * pelo processo principal, que já chama showAndFocusWindow() no clique da
   * notificação desktop.
   */
  function handleNavigateToMyServices() {
    setActiveWindow("characters");
    setTab("meus_services");
    setNotificationOpen(false);
  }

  /**
   * Navegação vinda da notificação de service "Qualquer um" (Formulário
   * Público). O Boss é levado direto à guia Services — a Lista de Espera que
   * ele tria. A guia já se protege sozinha contra não-Boss (efeito que
   * redireciona para "ativos").
   */
  function handleNavigateToServicesTab() {
    setActiveWindow("characters");
    setTab("waitlist");
    setNotificationOpen(false);
  }

  async function handleNavigateToParty(partyId: string) {
    setActiveWindow("characters");
    setNotificationOpen(false);
    // 1º — "Meu Histórico de PT's": histórico privado do usuário (projeção
    //      users/{uid}/partyHistory). Usa primeiro a lista já carregada em
    //      memória; se a guia não estava aberta (listener sob demanda), lê
    //      SOMENTE o documento desta PT (1 leitura) — nunca a coleção inteira.
    const privateHistory = personalPartyHistory.find(entry => entry.partyId === partyId)
      || await getPersonalPartyHistoryEntry(currentUser?.uid || "", partyId);
    if (privateHistory) {
      setTab("meu_historico");
      setHighlightedHistoryPartyId(partyId);
    } else {
      // 2º — PartyPanel: PT disponível para o usuário (ativa ou aguardando
      //      pagamento — coleção parties / cloudPartiesActive / cloudPartiesPublic).
      const isActive = activeParties.some(p => p.id === partyId)
                    || cloudPartiesActive.some(p => p.id === partyId && !p.archived)
                    || cloudPartiesPublic.some(p => p.id === partyId && !p.archived);
      if (isActive) {
        setTab("pts");
        setActivePt(partyId);
        setMinimized(m => ({ ...m, [partyId]: false }));
        setHighlightedHistoryPartyId(null);
      } else {
        // PT não encontrada em lugar nenhum — fallback para aba Gerenciador de PT's
        setTab("pts");
        setActivePt(partyId);
        setMinimized(m => ({ ...m, [partyId]: false }));
        setHighlightedHistoryPartyId(null);
      }
    }
    if (isElectron) {
      try {
        const { ipcRenderer } = (window as any).require("electron");
        ipcRenderer.invoke("focus-window");
      } catch (_) {}
    }
  }

  // ============================================================================
  // ROTEADOR ÚNICO DE NAVEGAÇÃO POR NOTIFICAÇÃO
  // ============================================================================
  // Todo clique em notificação — desktop web (Notification.onclick), desktop
  // Electron (IPC "desktop-notification-click" → callback no renderer) e
  // botões do Centro de Notificações — despacha o evento canônico
  // `notification-navigate-request`, tratado AQUI. O App nunca é desmontado,
  // logo a navegação NÃO depende de o painel de destino já estar montado
  // (causa raiz do bug "clica, foca a janela e não navega": os listeners
  // viviam dentro do BazarPanel/PartyManager, montados condicionalmente).
  //
  // Ordem de resolução (espelha resolveNotificationDestination):
  //   partyId → PT (Gerenciador ou Meu Histórico com destaque);
  //   bazaar_* → janela Bazaar (a diária dispara a consulta automática
  //              DEPOIS de o painel montar — mesmo padrão do agendador);
  //   service_request → aba Meus Services;
  //   service_waiting → guia Services (Lista de Espera);
  //   fallback (vip_approved, update_available, …) → Centro de Notificações.
  const navigateToPartyRef = useRef(handleNavigateToParty);
  navigateToPartyRef.current = handleNavigateToParty;
  const navigateToMyServicesRef = useRef(handleNavigateToMyServices);
  navigateToMyServicesRef.current = handleNavigateToMyServices;
  const navigateToServicesTabRef = useRef(handleNavigateToServicesTab);
  navigateToServicesTabRef.current = handleNavigateToServicesTab;

  useEffect(() => {
    function handleNotificationNavigate(event: Event) {
      const detail = (event as CustomEvent<NotificationNavigateDetail>).detail;
      if (!detail) return;
      setNotificationOpen(false);
      const destination = resolveNotificationDestination(detail);
      switch (destination.kind) {
        case "party": {
          // PT por ID: o handler resolve Gerenciador vs. Meu Histórico
          // (com destaque do card) e foca a janela no Electron. O evento
          // adicional avisa o PartyManager quando ele JÁ está montado.
          navigateToPartyRef.current(destination.partyId);
          window.dispatchEvent(new CustomEvent("pt-navigate-request", { detail: { partyId: destination.partyId } }));
          return;
        }
        case "bazaar": {
          setActiveWindow("bazar");
          if (destination.autoRun) {
            // Aguarda o BazarPanel montar na janela Bazaar antes de pedir a
            // consulta automática (mesmo atraso usado pelo agendador diário).
            window.setTimeout(() => {
              window.dispatchEvent(new CustomEvent("auto-bazaar-run-request", {
                detail: { source: "notification-click", notificationId: detail.notificationId },
              }));
            }, 500);
          }
          return;
        }
        case "myServices": {
          navigateToMyServicesRef.current();
          return;
        }
        case "waitlist": {
          // serviceId da notificação destaca a entrada específica da fila.
          setHighlightedWaitingServiceId(destination.serviceId || null);
          navigateToServicesTabRef.current();
          return;
        }
        case "center":
        default: {
          // Sem destino funcional próprio: abre o Centro de Notificações —
          // o clique nunca termina em "apenas focou a janela".
          setNotificationOpen(true);
          return;
        }
      }
    }
    window.addEventListener(NOTIFICATION_NAVIGATE_EVENT, handleNotificationNavigate as EventListener);
    return () => window.removeEventListener(NOTIFICATION_NAVIGATE_EVENT, handleNotificationNavigate as EventListener);
  }, []);

  const {
    notifications,
    pendingCount,
    markAsDone,
    markAllAsDone,
    clearDone,
    desktopEnabled,
    setDesktopEnabled,
    addNotification
  } = useNotifications({
    currentUserUid: currentUser?.uid
  });

  // ============================================================================
  // NOTIFICAÇÕES EM TEMPO REAL — push + backend
  // ============================================================================
  // O alerta de "leilão encerrando" voltou a ser programado NO DISPOSITIVO
  // (services/bazaarInterestNotificationService.ts — varredura por minuto +
  // despertar em visibilidade/foco, fila alimentada pelo cache oficial). O
  // agendador dispara o CustomEvent abaixo; este handler o entrega ao MESMO
  // fluxo das demais notificações (addNotification → centro/som/desktop),
  // com o mesmo gate de preferências, dedup por id e roteamento de clique.

  // ── Bazaar: alerta local de encerramento → centro de notificações ─────────
  useEffect(() => {
    function handleBazaarEndingAlert(event: Event) {
      const detail = (event as CustomEvent).detail || {};
      addNotification({
        id: detail.id,
        type: "bazaar_interest_ending",
        title: detail.title || "Leilão encerrando",
        body: detail.body || "Um leilão de interesse está perto de encerrar.",
        createdAt: detail.createdAt || Date.now(),
        scheduledTime: detail.scheduledTime,
        auctionId: detail.auctionId,
        url: detail.url,
        userId: currentUser?.uid,
      } as any);
    }
    window.addEventListener("bazaar-interest-notification-center", handleBazaarEndingAlert);
    return () => window.removeEventListener("bazaar-interest-notification-center", handleBazaarEndingAlert);
  }, [addNotification, currentUser?.uid]);

  // ── Bazaar: boot do agendador local (cache oficial + interesses) ───────────
  // Funciona com o painel fechado: a lista oficial e os interesses estão em
  // cache local; o painel realimenta com dados frescos quando sincroniza.
  useEffect(() => {
    const uid = currentUser?.uid || "";
    if (!uid) {
      stopBazaarEndingAlerts();
      return;
    }
    try {
      const cache = readOfficialBazaarCache();
      if (!cache) return;
      const interests = readBazaarInterestsCache(cache.version)?.interests || {};
      syncBazaarEndingAlerts({
        characters: cache.characters,
        interestsByAuctionId: interests,
        currentUserUid: uid,
        bazaarVersion: cache.version,
      });
    } catch { /* cache ilegível: o painel realimenta ao abrir */ }
  }, [currentUser?.uid]);

  // ── PUSH (Web Push/FCM): entrega com a aba/app fechado ────────────────────
  // Registra o token deste dispositivo no Firestore e espelha as preferências
  // locais (o backend precisa delas para os watchers e para o gate de push).
  // Silencioso por natureza — push é acessório e nunca bloqueia o app.
  const pushUidRef = useRef<string>("");
  useEffect(() => {
    const uid = currentUser?.uid || "";
    const previousUid = pushUidRef.current;
    if (previousUid && previousUid !== uid) {
      void unregisterPushForUser(previousUid);
    }
    pushUidRef.current = uid;
    if (!uid || isSimulation) return;
    void syncNotificationPrefsToCloud(uid);
    if (desktopEnabled) void registerPushForUser(uid);
  }, [currentUser?.uid, desktopEnabled, isSimulation]);

  // ── Clique em notificação entregue por PUSH (app estava fechado) ──────────
  // O Service Worker abriu/focou a janela e repassou os dados. O MESMO
  // roteador do clique no app decide o destino — nada de rota paralela.
  useEffect(() => {
    return listenPushNotificationClicks(data => {
      dispatchNotificationNavigate({
        id: String(data.notificationId || ""),
        type: String(data.type || ""),
        partyId: data.partyId ? String(data.partyId) : undefined,
        serviceId: data.serviceId ? String(data.serviceId) : undefined,
        url: data.url ? String(data.url) : undefined,
      });
    });
  }, []);

  // ── Bazaar: chips de "encerrando" no painel ───────────────────────────────
  // Os alertas de encerramento NASCEM NO DISPOSITIVO (agendador local) e já
  // disparam este evento por conta própria. Este efeito cobre apenas os
  // documentos residuais do antigo watcher (ainda não limpos pela
  // bazaarListCleanup): reencaminha ao painel, que deduplica por id — mesmo
  // id = convenção idêntica do agendador local → um único chip.
  const dispatchedBazaarIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    notifications.forEach(notif => {
      if (notif.type !== "bazaar_interest_ending" || notif.status !== "pending") return;
      if (dispatchedBazaarIdsRef.current.has(notif.id)) return;
      dispatchedBazaarIdsRef.current.add(notif.id);
      try {
        window.dispatchEvent(new CustomEvent("bazaar-interest-local-notification", {
          detail: {
            id: notif.id,
            title: notif.title,
            body: notif.body,
            url: notif.url || "",
            auctionId: notif.auctionId || "",
            expiresAtMs: notif.scheduledTime || 0,
          },
        }));
      } catch { /* o chip é acessório */ }
    });
  }, [notifications]);

  useEffect(() => {
    function handleAutoBazaarSuccess(event: Event) {
      const notificationId = (event as CustomEvent).detail?.notificationId;
      if (!notificationId) return;
      const processed = readAutoBazaarIdSet(AUTO_BAZAAR_PROCESSED_NOTIFICATIONS_KEY);
      processed.add(String(notificationId));
      saveAutoBazaarIdSet(AUTO_BAZAAR_PROCESSED_NOTIFICATIONS_KEY, processed);
    }
    window.addEventListener("auto-bazaar-success", handleAutoBazaarSuccess);
    return () => window.removeEventListener("auto-bazaar-success", handleAutoBazaarSuccess);
  }, []);

  useEffect(() => {
    if (!isElectron || userProfile?.role !== "Boss" || userProfile?.status !== "aprovado") return;
    let cancelled = false;
    let timer: number | null = null;

    function scheduleNext() {
      if (cancelled) return;
      const offset = readBazarTimezoneOffsetMinutesForAuto();
      const targetMs = getNextAutoBazaarTriggerMs(Date.now(), offset);
      const delay = Math.max(1000, Math.min(targetMs - Date.now(), 2_147_483_647));
      timer = window.setTimeout(runDailyNotification, delay);
    }

    function runDailyNotification() {
      if (cancelled) return;
      const offset = readBazarTimezoneOffsetMinutesForAuto();
      const dateKey = getAutoBazaarDateKey(Date.now(), offset);
      const targetMs = getNextAutoBazaarTriggerMs(Date.now() - 60 * 1000, offset);
      const notificationId = getAutoBazaarNotificationId(dateKey, targetMs);
      const notified = readAutoBazaarIdSet(AUTO_BAZAAR_NOTIFIED_IDS_KEY);
      if (!notified.has(notificationId)) {
        notified.add(notificationId);
        saveAutoBazaarIdSet(AUTO_BAZAAR_NOTIFIED_IDS_KEY, notified);
        addNotification({
          id: notificationId,
          type: "bazaar_daily_available",
          title: "📈 Atualização diária do Bazaar disponível",
          body: "A lista do Rubinot já pode ser consultada. Clique para iniciar a consulta do Bazaar.",
          createdAt: Date.now(),
          userId: currentUser?.uid,
        } as any);

        const autoEnabled = localStorage.getItem(AUTO_BAZAAR_ENABLED_KEY) === "true";
        const processed = readAutoBazaarIdSet(AUTO_BAZAAR_PROCESSED_NOTIFICATIONS_KEY);
        if (autoEnabled && !processed.has(notificationId)) {
          setActiveWindow("bazar");
          window.setTimeout(() => {
            window.dispatchEvent(new CustomEvent("auto-bazaar-run-request", { detail: { source: "daily-notification", dateKey, notificationId } }));
          }, 500);
        }
      }
      scheduleNext();
    }

    scheduleNext();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [addNotification, currentUser?.uid, userProfile?.role, userProfile?.status]);

  // ============================================================================
  // FIRESTORE LISTENERS - PT's ATIVAS (3 fluxos independentes)
  //
  // 1. BOSS: listener contínuo em TODAS as PTs ativas (visão global).
  // 2. NORMAL/VIP: listener contínuo APENAS em PTs do usuário (3 queries OR:
  //    leaderUid, members, invitedUsers). Deduplicação client-side.
  // 3. PTs PÚBLICAS: getDocs() sob demanda ao abrir aba "Gerenciador de PT's" (sem listener).
  //
  // Resultado combinado em `cloudParties` via useMemo (dedup por ID).
  // ============================================================================
  useEffect(() => {
    if (!currentUser || !userProfile || userProfile.status !== "aprovado") return;
    if (isIdleMode) return;
    const uid = currentUser.uid;
    const isBoss = userProfile.role === "Boss";

    const unsubs: Array<() => void> = [];

    function handleSnapshot(snapshot: any) {
      const parties = snapshot.docs.map((d: any) => ({ id: d.id, ...d.data() } as PartyTab));
      setCloudPartiesActive(parties);
      try { localStorage.setItem("cloud_cache_parties_active", JSON.stringify(parties)); } catch {}
      const hasPending = snapshot.metadata.hasPendingWrites;
      setIsSyncing(hasPending);
      if (!snapshot.metadata.fromCache) setIsOnline(true);
    }

    // Merge de múltiplos snapshots (para queries OR do Normal/VIP)
    const mergeResults = (snapshots: Record<string, PartyTab[]>) => {
      const all: PartyTab[] = [];
      const seen = new Set<string>();
      Object.values(snapshots).forEach(list => {
        list.forEach(p => { if (!seen.has(p.id)) { seen.add(p.id); all.push(p); } });
      });
      return all;
    };

    if (isBoss) {
      // ── BOSS: visão global — uma única query em todas as PTs ativas ──
      const bossQ = query(collection(db, "parties"), where("archived", "==", false));
      unsubs.push(onSnapshot(bossQ, handleSnapshot, () => {}));
    } else {
      // ── NORMAL/VIP: listener contínuo APENAS nas próprias PTs ──
      // 3 queries OR: leaderUid, members (array-contains), invitedUsers
      const results: Record<string, PartyTab[]> = { leader: [], member: [], invited: [] };
      let debounceTimer: number | null = null;

      function mergeAndSet() {
        const merged = mergeResults(results);
        handleSnapshot({ docs: merged.map(p => ({ id: p.id, data: () => p })), metadata: { hasPendingWrites: false, fromCache: false } });
      }

      function debouncedMerge() {
        if (debounceTimer) window.clearTimeout(debounceTimer);
        debounceTimer = window.setTimeout(() => {
          debounceTimer = null;
          mergeAndSet();
        }, 300);
      }

      const baseQ = query(collection(db, "parties"), where("archived", "==", false));

      // Query 1: lidera
      const leaderQ = query(baseQ, where("leaderUid", "==", uid));
      unsubs.push(onSnapshot(leaderQ, (snap) => {
        results.leader = snap.docs.map(d => ({ id: d.id, ...d.data() } as PartyTab));
        debouncedMerge();
      }, () => {}));

      // Query 2: é membro
      const memberQ = query(baseQ, where("members", "array-contains", uid));
      unsubs.push(onSnapshot(memberQ, (snap) => {
        results.member = snap.docs.map(d => ({ id: d.id, ...d.data() } as PartyTab));
        debouncedMerge();
      }, () => {}));

      // Query 3: foi convidado
      const invitedQ = query(baseQ, where("invitedUsers", "array-contains", uid));
      unsubs.push(onSnapshot(invitedQ, (snap) => {
        results.invited = snap.docs.map(d => ({ id: d.id, ...d.data() } as PartyTab));
        debouncedMerge();
      }, () => {}));
    }

    return () => {
      unsubs.forEach(u => u());
    };
  }, [currentUser?.uid, userProfile?.status, userProfile?.role, isIdleMode]);

  // ============================================================================
  // FIRESTORE: PT's PÚBLICAS — SOB DEMANDA (getDocs, sem listener)
  //
  // Para usuários Normal/VIP: busca PTs públicas não arquivadas APENAS quando
  // a aba "Gerenciador de PT's" está ativa. Utiliza getDocs() (1 read) em vez de onSnapshot()
  // (contínuo), economizando leituras significativamente.
  // Boss: não precisa — já tem visão global via listener contínuo.
  //
  // A chamada é feita via onTabChange no PartyManager (montagem na aba "pts").
  // ============================================================================
  async function fetchPublicParties() {
    if (!currentUser || !userProfile || userProfile.status !== "aprovado") return;
    if (userProfile.role === "Boss") return; // Boss já tem visão global
    try {
      const publicQ = query(
        collection(db, "parties"),
        where("visibility", "==", "public"),
        where("archived", "==", false),
        // PRÉ-Quest apenas: após o início a PT deixa de ser pública para
        // externos (Security Rules nega a leitura e a query precisa refletir
        // isso — regras não são filtros: um documento negado derruba a
        // consulta inteira).
        where("ptStartedAt", "==", 0)
      );
      const snap = await getDocs(publicQ);
      const publicParties = snap.docs.map(d => ({ id: d.id, ...d.data() } as PartyTab));

      // Deduplicar contra PTs já presentes no listener do usuário
      const userPartyIds = new Set(cloudPartiesActive.map(p => p.id));
      const newPublic = publicParties.filter(p => !userPartyIds.has(p.id));

      setCloudPartiesPublic(newPublic);
      try { localStorage.setItem("cloud_cache_parties_public", JSON.stringify(newPublic)); } catch {}
    } catch (err) {
      console.error("Erro ao buscar PTs públicas:", err);
    }
  }

  // Sincronizar cache local de PTs públicas quando as PTs do usuário mudam
  // (evita duplicatas: party que saiu do listener do usuário pode estar no cache público)
  useEffect(() => {
    setCloudPartiesPublic(prev => {
      const userIds = new Set(cloudPartiesActive.map(p => p.id));
      const filtered = prev.filter(p => !userIds.has(p.id));
      return filtered.length === prev.length ? prev : filtered;
    });
  }, [cloudPartiesActive]);

  // Limpar PTs públicas ao desconectar
  useEffect(() => {
    if (!currentUser) {
      setCloudPartiesPublic([]);
    }
  }, [currentUser?.uid]);

  // ============================================================================
  // WAITING LIST — CACHE LOCAL + SINCRONIZAÇÃO SOB DEMANDA
  // ============================================================================
  // Ao abrir o Gerenciador de PTs (tab === "pts"), usa apenas o cache local já
  // carregado em cloudWaitingList. A nuvem é sincronizada manualmente pelo botão
  // "Atualizar" da seção LISTA DE ESPERA (SERVICES). Ao abrir diretamente a aba
  // Services (tab === "waitlist"), faz uma leitura pontual para sincronizar.
  // ============================================================================
  // Carrega a Lista de Espera ao entrar (uma vez) e sempre que a aba Services
  // for aberta pelo Boss.
  //
  // Antes a leitura só ocorria com `tab === "waitlist"`. Como essa aba passou
  // a ser exclusiva do Boss, os demais usuários nunca mais buscavam a coleção
  // e os services "Qualquer um" sumiam da ServiceList — que depende deles.
  const waitingListLoadedRef = useRef(false);
  useEffect(() => {
    if (!currentUser?.uid || userProfile?.status !== "aprovado") return;
    if (isIdleMode) return;

    const isServicesTab = tab === "waitlist";
    if (!isServicesTab && waitingListLoadedRef.current) return;
    if (!isServicesTab) waitingListLoadedRef.current = true;

    let cancelled = false;
    (async () => {
      try {
        if (!cancelled) await refreshWaitingListFromCloud();
      } catch {}
    })();

    return () => { cancelled = true; };
  }, [currentUser?.uid, userProfile?.status, tab, isIdleMode]);

  function readSharedCharactersMetaCache(): { updatedAt: number; count: number } | null {
    try {
      const raw = localStorage.getItem(SHARED_CHARACTERS_META_CACHE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (!parsed || typeof parsed.updatedAt !== "number") return null;
      return {
        updatedAt: parsed.updatedAt,
        count: typeof parsed.count === "number" ? parsed.count : 0,
      };
    } catch {
      return null;
    }
  }

  function saveSharedCharactersMetaCache(meta: { updatedAt: number; count: number }) {
    try { localStorage.setItem(SHARED_CHARACTERS_META_CACHE_KEY, JSON.stringify(meta)); } catch {}
  }

  // ============================================================================
  // APLICA o `partyProfit` pendente (transportado por quem finalizou a PT) na
  // própria lista "Meus Personagens" e LIMPA o campo no próprio documento.
  //
  // O `partyProfit` vive no documento `sharedCharacters/{uid}` do DONO — não no
  // personagem — então funciona mesmo que o personagem tenha deixado de ser
  // compartilhado (ou sido vendido) depois de entrar na PT. O doc do dono não é
  // apagado quando um personagem sai; apenas o array `characters` encolhe.
  // ============================================================================
  function applyOwnIncomingPartyProfit(
    incomingProfit: Record<string, Record<string, { questType: string; lucro: number }>>,
  ) {
    try {
      if (!incomingProfit || Object.keys(incomingProfit).length === 0) return;
      if (!currentUser?.uid || !db) return;

      setData(prev => {
        let changed = false;
        const nextChars = prev.characters.map(char => {
          let applied = false;
          let questType: string | null = null;
          let lucro = 0;
          Object.values(incomingProfit).forEach(byParty => {
            const entry = byParty?.[char.id];
            if (entry && entry.lucro > 0) {
              questType = entry.questType;
              lucro = entry.lucro;
              applied = true;
            }
          });
          if (!applied) return char;
          if (questType === "sanguine") {
            if ((char.dropBakra || 0) === lucro) return char;
            changed = true;
            return { ...char, dropBakra: lucro };
          }
          if ((char.dropSW || 0) === lucro) return char;
          changed = true;
          return { ...char, dropSW: lucro };
        });
        if (!changed) return prev;
        return { ...prev, characters: nextChars };
      });

      // Limpa o campo `partyProfit` do próprio documento (escrita do dono,
      // permitida) para não reaplicar no próximo load — evita loop/write
      // repetido.
      try {
        const ownRef = doc(db, "sharedCharacters", currentUser.uid);
        const clearUpdates: Record<string, any> = {};
        Object.keys(incomingProfit).forEach(partyId => {
          clearUpdates[`partyProfit.${partyId}`] = deleteField();
        });
        updateDoc(ownRef, clearUpdates).catch(() => {
          setDoc(ownRef, { partyProfit: {} }, { merge: true }).catch(() => {});
        });
      } catch {}
    } catch (err) {
      console.error("Auto-Att: falha ao aplicar lucro pendente:", err);
    }
  }

  // ============================================================================
  // LEITOR REATIVO do `partyProfit` pendente do próprio usuário.
  // ----------------------------------------------------------------------------
  // Usa onSnapshot no próprio documento `sharedCharacters/{uid}` — NÃO um poll.
  // Custo em Firestore: 1 leitura no snapshot inicial e, depois, UMA leitura
  // apenas quando o documento muda (ex.: o líder finaliza a PT e grava
  // `partyProfit`). Sem mudança no documento, zero leituras recorrentes — ao
  // contrário de um intervalo fixo (que gastaria ~120 leituras/hora).
  //
  // Independente do cache/TTL de sharedCharacters: o listener entrega a
  // atualização em tempo real, mesmo que o personagem tenha saído de
  // sharedCharacters e mesmo que o cache de compartilhados esteja "fresco".
  // Pausado durante o modo ocioso (mesmo padrão dos demais listeners).
  // ============================================================================
  useEffect(() => {
    if (!currentUser?.uid || !userProfile || userProfile.status !== "aprovado") return;
    if (isSimulation || !db || !hydrated) return;
    if (isIdleMode) return;

    const ownRef = doc(db, "sharedCharacters", currentUser.uid);
    const unsubscribe = onSnapshot(ownRef, (snap) => {
      const dataSnap = snap.data();
      if (dataSnap?.partyProfit && typeof dataSnap.partyProfit === "object") {
        applyOwnIncomingPartyProfit(dataSnap.partyProfit);
      }
    }, () => {});

    return () => unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser?.uid, userProfile?.status, isSimulation, hydrated, isIdleMode]);

  // ============================================================================
  // SHARED CHARACTERS — CARREGAMENTO SOB DEMANDA (getDocs) COM CACHE + TTL
  // ============================================================================
  // Substitui o antigo listener global (onSnapshot) por leitura pontual.
  // - `force=false`: respeita o TTL — só lê do Firestore se o cache expirou.
  // - `force=true`: ignora o TTL (usado pelo botão "Atualizar" manual).
  // Reduz drasticamente as leituras: 0 reads enquanto o cache estiver fresco.
  // ============================================================================
  async function fetchSharedCharacters(force = false): Promise<void> {
    if (!currentUser || !userProfile || userProfile.status !== "aprovado") return;
    // Respeita o TTL salvo no cache, exceto quando forçado (refresh manual)
    if (!force && isSharedCharsCacheFresh()) return;
    try {
      if (!force) {
        const cached = loadSharedCharsCache();
        const localMeta = readSharedCharactersMetaCache();
        if (cached.data.length > 0 && localMeta) {
          try {
            const metaSnap = await getDoc(doc(db, SHARED_CHARACTERS_METADATA_REF.collection, SHARED_CHARACTERS_METADATA_REF.id));
            const remote = metaSnap.exists() ? metaSnap.data() : null;
            const remoteUpdatedAt = typeof remote?.updatedAt === "number" ? remote.updatedAt : 0;
            const remoteCount = typeof remote?.count === "number" ? remote.count : localMeta.count;
            if (remoteUpdatedAt > 0 && remoteUpdatedAt === localMeta.updatedAt && remoteCount === localMeta.count) {
              setSharedCharacters(cached.data);
              saveSharedCharsCache(cached.data);
              return;
            }
          } catch {}
        }
      }

      const sharedSnap = await getDocs(collection(db, "sharedCharacters"));
      const sharedList: Character[] = [];
      const markers: ProbableMarkersMap = {};
      // LUCRO a ser aplicado na lista pessoal, transportado via sharedCharacters
      // por quem finalizou a PT (Auto-Att). Estrutura: { [partyId]: { [charId]:
      // { questType, lucro } } }.
      let incomingProfit: Record<string, Record<string, { questType: string; lucro: number }>> | null = null;

      sharedSnap.docs.forEach(docSnap => {
        const data = docSnap.data();
        // O documento do PRÓPRIO usuário pode carregar `partyProfit` (gravação
        // cruzada feita pelo líder de uma PT que ele finalizou). Aplicamos na
        // lista pessoal e limpamos a seguir — sem loop.
        if (docSnap.id === currentUser.uid && data?.partyProfit && typeof data.partyProfit === "object") {
          incomingProfit = data.partyProfit as typeof incomingProfit;
        }
        if (Array.isArray(data?.characters)) {
          data.characters.forEach((c: any) => {
            sharedList.push({
              ...c,
              ownerUid: c.ownerUid || data.ownerUid,
              ownerName: c.ownerName || data.ownerName,
            } as Character);
          });
        }
        // Extrair probableMarkers de cada documento (campo armazenado pelo
        // proprietário, gravado por qualquer usuário que concluiu uma PT com
        // seus personagens). Chaveado por charId para lookup O(1).
        if (data?.probableMarkers && typeof data.probableMarkers === "object" && !Array.isArray(data.probableMarkers)) {
          Object.entries(data.probableMarkers).forEach(([charId, markerData]) => {
            if (markerData && typeof markerData === "object") {
              const m = markerData as Record<string, boolean>;
              if (m.soulwar || m.sanguine) {
                markers[charId] = {
                  soulwar: m.soulwar === true ? true : undefined,
                  sanguine: m.sanguine === true ? true : undefined,
                };
              }
            }
          });
        }
      });

      // ── APLICA o lucro transportado (Auto-Att) na própria lista pessoal ────
      // Atualiza SOMENTE o campo de lucro da Quest (dropSW=Lucro SW /
      // dropBakra=Lucro SG) de personagens que JÁ existem em Meus Personagens.
      // Personagem sem correspondência não é criado; lucro <= 0 não altera.
      if (incomingProfit) {
        applyOwnIncomingPartyProfit(incomingProfit);
      }

      setSharedCharacters(sharedList);
      setProbableMarkers(markers);
      saveSharedCharsCache(sharedList); // grava dados + carimbo de tempo (TTL)
      saveSharedCharactersMetaCache({ updatedAt: Date.now(), count: sharedSnap.docs.length });
      try {
        const metaSnap = await getDoc(doc(db, SHARED_CHARACTERS_METADATA_REF.collection, SHARED_CHARACTERS_METADATA_REF.id));
        const remote = metaSnap.exists() ? metaSnap.data() : null;
        const remoteUpdatedAt = typeof remote?.updatedAt === "number" ? remote.updatedAt : 0;
        const remoteCount = typeof remote?.count === "number" ? remote.count : sharedSnap.docs.length;
        if (remoteUpdatedAt > 0) saveSharedCharactersMetaCache({ updatedAt: remoteUpdatedAt, count: remoteCount });
      } catch {}
      try { localStorage.setItem("cloud_cache_probableMarkers", JSON.stringify(markers)); } catch {}
    } catch (err) {
      console.error("Erro ao carregar sharedCharacters:", err);
    }
  }

  // REFATORAÇÃO PRESENCE — Requisito: Documento agregado presence/count
  // Redução de leituras para Normal/VIP e tempo real para Boss
  useEffect(() => {
    if (!currentUser || !userProfile || userProfile.status !== "aprovado") return;
    if (isIdleMode) return;
    if (!globalSettings.presenceEnabled) {
      setPresenceCountUnavailable(true);
      return;
    }
    if (isSimulation) return;

    const isBoss = userProfile.role === "Boss";
    const POLL_INTERVAL_MS = 10 * 60 * 1000; // 10 minutos (requisito)
    const ONLINE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutos (requisito)
    const STALE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutos: documento considerado obsoleto

    let cancelled = false;

    // --- FUNÇÃO COMPARTILHADA: recalcula contador lendo toda a coleção ---
    // Qualquer usuário pode chamar como fallback quando o documento
    // presence/count está ausente ou obsoleto. O Boss chama a cada poll.
    const recalculatePresenceCount = async () => {
      try {
        const snap = await getDocs(collection(db, "presence"));
        if (cancelled) return;
        const now = Date.now();
        let onlineCount = 0;
        const nextPresenceMap: Record<string, any> = {};

        snap.docs.forEach(d => {
          if (d.id === "count") return; // pular documento agregado
          const p = d.data();

          // Compatibilidade: aceita lastActivityAt (novo) e lastSeen (legado)
          const activityAt = p.lastActivityAt?.toMillis?.()
            || p.lastSeen?.toMillis?.()
            || (typeof p.lastActivityAt === "number" ? p.lastActivityAt : 0)
            || (typeof p.lastSeen === "number" ? p.lastSeen : 0)
            || 0;
          if (activityAt > 0) nextPresenceMap[d.id] = { ...p, lastActivityAt: activityAt };

          // Regra: Online se atividade < 30 min E isOnline !== false
          if (activityAt > 0 && (now - activityAt) < ONLINE_THRESHOLD_MS && p.isOnline !== false) {
            onlineCount++;
          }
        });

        // Garantir que o contador NUNCA seja zero (o próprio usuário conta como mínimo 1)
        const finalCount = Math.max(1, onlineCount);

        setOnlineCount(finalCount);
        setPresenceCountUnavailable(false);
        setPresenceMap(nextPresenceMap);

        // Gravar documento agregado — qualquer usuário aprovado pode escrever
        try {
          await setDoc(doc(db, "presence", "count"), {
            onlineCount: finalCount,
            updatedAt: serverTimestamp(),
            recalculatedAt: now
          }, { merge: true });
        } catch (writeErr) {
          console.error("Erro ao gravar presence/count:", writeErr);
        }

        try { localStorage.setItem("presence_count_fallback", String(finalCount)); } catch {}
      } catch (err) {
        console.error("Erro ao recalcular presença:", err);
      }
    };

    // --- LEITURA LEVE: lê apenas o documento agregado (1 read) ---
    // Se o documento estiver ausente ou obsoleto (>15 min), faz fallback
    // para recálculo completo (N reads) para qualquer papel de usuário.
    const fetchAggregatedCount = async () => {
      try {
        const countSnap = await getDoc(doc(db, "presence", "count"));
        if (countSnap.exists()) {
          const countData = countSnap.data();
          const age = Date.now() - (countData.recalculatedAt || 0);
          const count = countData.onlineCount || 0;

          // Dados frescos e válidos: usar direto (1 read apenas)
          if (count > 0 && age < STALE_THRESHOLD_MS) {
            setOnlineCount(count);
            setPresenceCountUnavailable(false);
            return;
          }
        }
        if (globalSettings.presenceMode === "economico" && !isBoss) {
          setPresenceCountUnavailable(true);
          return;
        }
        // Documento ausente, obsoleto ou com count=0:
        // no modo completo, qualquer usuário faz recálculo completo como fallback
        await recalculatePresenceCount();
      } catch (err) {
        // Se falhar, tentar cache local como último recurso
        try {
          const cached = localStorage.getItem("presence_count_fallback");
          if (cached && globalSettings.presenceMode === "completo") {
            setOnlineCount(Math.max(1, parseInt(cached, 10) || 1));
            setPresenceCountUnavailable(false);
          } else {
            setPresenceCountUnavailable(true);
          }
        } catch { setPresenceCountUnavailable(true); }
      }
    };

    // --- Execução Inicial ---
    // Boss: sempre recalcula (mantém o documento atualizado para todos)
    // Normal/VIP: lê o documento agregado (com fallback automático)
    if (isBoss) recalculatePresenceCount();
    else fetchAggregatedCount();

    // --- Polling Periódico (10 min) ---
    // Pausa leituras quando o usuário está ocioso (economia de reads)
    const interval = setInterval(() => {
      if (isUserIdle) return;
      if (isBoss) recalculatePresenceCount();
      else fetchAggregatedCount();
    }, POLL_INTERVAL_MS);

    // --- Foco da Janela ---
    // Revalida ao focar (indica que o usuário voltou a interagir)
    const onFocus = () => {
      if (isBoss) recalculatePresenceCount();
      else fetchAggregatedCount();
    };
    window.addEventListener("focus", onFocus);

    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [currentUser?.uid, userProfile?.role, isSimulation, isUserIdle, adminOpen, isIdleMode, globalSettings.presenceEnabled, globalSettings.presenceMode]);

  // SYNC SHARED CHARACTERS - Observar data.characters e sincronizar com Firestore em documento agregado por usuário
  const lastSavedSharedCharsRef = useRef<string>("");
  useEffect(() => {
    if (!currentUser?.uid || !userProfile || userProfile.status !== "aprovado" || isSimulation || !db || !hydrated) return;

    // O documento sharedCharacters/{uid} deve conter apenas personagens com: shared === true && !vendido
    const charactersToShare = data.characters.filter(c => c.shared === true && !c.vendido).map(c => ({
      ...c,
      ownerUid: currentUser.uid,
      ownerName: displayUserName,
      updatedAt: Date.now()
    }));

    // Comparamos o conteúdo sem o campo updatedAt para saber se houve mudança real nas propriedades
    const cleanForCompare = charactersToShare.map(({ updatedAt: _, ...rest }) => rest);
    const charsJSON = JSON.stringify(cleanForCompare);
    if (lastSavedSharedCharsRef.current === "") {
      lastSavedSharedCharsRef.current = charsJSON;
      return;
    }
    if (charsJSON === lastSavedSharedCharsRef.current) return;

    // Usar updateDoc para preservar o campo probableMarkers gravado por outros
    // usuários (marcadores de "provável Quest concluída"). updateDoc substitui
    // apenas os campos especificados (characters, ownerUid, ownerName, updatedAt),
    // mantendo probableMarkers intacto. Fallback para setDoc se o documento ainda
    // não existir (primeira vez que o usuário compartilha personagens).
    async function updateSharedDoc() {
      try {
        const payload = {
          ownerUid: currentUser.uid,
          ownerName: displayUserName,
          characters: charactersToShare,
          updatedAt: Date.now()
        };
        const cleanPayload = JSON.parse(JSON.stringify(payload));
        try {
          await updateDoc(doc(db, "sharedCharacters", currentUser.uid), cleanPayload);
        } catch {
          // Documento não existe — criar com setDoc
          await setDoc(doc(db, "sharedCharacters", currentUser.uid), cleanPayload);
        }
        const metaUpdatedAt = Date.now();
        await setDoc(doc(db, SHARED_CHARACTERS_METADATA_REF.collection, SHARED_CHARACTERS_METADATA_REF.id), {
          updatedAt: metaUpdatedAt,
          lastOwnerUid: currentUser.uid,
        }, { merge: true }).catch(() => {});
        saveSharedCharactersMetaCache({ updatedAt: metaUpdatedAt, count: readSharedCharactersMetaCache()?.count || 0 });
        lastSavedSharedCharsRef.current = charsJSON;
      } catch (err) {
        console.error("Erro ao salvar sharedCharacters no Firestore:", err);
      }
    }
    updateSharedDoc();
  }, [data.characters, currentUser, userProfile, displayUserName, isSimulation, hydrated]);

  // ============================================================================
  // PROBABLE MARKERS — Escrita ao concluir Quest (Fluxo 1)
  // ============================================================================
  // Quando uma PT tem questConcluida alterada de false para true, gravamos
  // marcadores em sharedCharacters/{ownerUid} para cada personagem participante.
  // O marcador indica que aquele personagem PROVAVELMENTE já realizou a Quest.
  // Usa updateDoc com field paths (dot notation) para deep-merge — preserva
  // marcadores existentes de outros personagens/quests no mesmo documento.
  // ============================================================================
  async function writeProbableMarkers(party: PartyTab) {
    if (isSimulation || !db) return;
    const questType = party.ptType;
    if (!questType || party.questFalha) return;

    const slotData = party.slotData || {};
    // Agrupar charIds por ownerUid (a partir do slotData gravado na PT)
    const markersByOwner: Record<string, Record<string, boolean>> = {};

    (party.selectedIds || []).forEach(charId => {
      const slot = slotData[charId];
      const ownerUid = slot?.ownerUid;
      if (!ownerUid) return;
      if (!markersByOwner[ownerUid]) markersByOwner[ownerUid] = {};
      markersByOwner[ownerUid][charId] = true;
    });

    // Para cada proprietário, gravar os marcadores no seu documento sharedCharacters
    const writePromises: Promise<void>[] = [];

    for (const [ownerUid, charIds] of Object.entries(markersByOwner)) {
      const updates: Record<string, any> = {};
      Object.keys(charIds).forEach(charId => {
        updates[`probableMarkers.${charId}.${questType}`] = true;
      });

      if (Object.keys(updates).length === 0) continue;

      // Atualizar marcadores no estado local imediatamente (UI reativa)
      setProbableMarkers(prev => {
        const next = { ...prev };
        Object.keys(charIds).forEach(charId => {
          const existing = next[charId] || {};
          next[charId] = { ...existing, [questType]: true };
        });
        try { localStorage.setItem("cloud_cache_probableMarkers", JSON.stringify(next)); } catch {}
        return next;
      });

      // Gravar no Firestore usando updateDoc com field paths (deep merge)
      writePromises.push(
        updateDoc(doc(db, "sharedCharacters", ownerUid), updates).catch(() => {
          // Documento pode não existir ainda — criar com setDoc + merge
          const markers: Record<string, any> = {};
          Object.keys(charIds).forEach(charId => {
            markers[charId] = { [questType]: true };
          });
          setDoc(doc(db, "sharedCharacters", ownerUid), { probableMarkers: markers }, { merge: true }).catch(() => {});
        })
      );
    }

    if (writePromises.length > 0) {
      Promise.allSettled(writePromises);
    }
  }

  // ============================================================================
  // SERVICES — Remoção automática da Lista de Espera ao concluir a Quest
  // ============================================================================
  // Ao concluir a Quest com sucesso, os personagens de Service da PT que vieram
  // da Lista de Espera são marcados como "realizado" — o serviço foi entregue.
  //
  // Mesma semântica de "Meus Services": a entrada NÃO é apagada; ela apenas sai
  // de circulação (deixa de ser compartilhada na montagem de PTs) e passa a ser
  // exibida na sub-guia "Realizados" da guia Services.
  //
  // Só marca os IDs que realmente estão na Lista de Espera e que pertencem a
  // ESTA PT (via slotData). Personagens próprios, membros de "+ Externo"
  // (id "cust_*") e entradas de outras PTs não são afetados. Entradas já
  // realizadas preservam o `realizadoAt` original (marcador idempotente).
  //
  // A contabilização de estatísticas NÃO depende dessa entrada: o slot carrega
  // a flag `isService`, gravada na inclusão.
  // ============================================================================
  const removedWaitingForPartyRef = useRef<Set<string>>(new Set());

  async function markCompletedServicesAsRealizado(party: PartyTab) {
    if (isSimulation || !db) return;
    if (!party.questConcluida || party.questFalha) return;
    if (removedWaitingForPartyRef.current.has(party.id)) return;
    removedWaitingForPartyRef.current.add(party.id);

    const waitingById = new Map((cloudWaitingList || []).map(w => [w.id, w]));
    // Interseção: slots desta PT que ainda constam na Lista de Espera e ainda
    // não foram entregues.
    const toMark = Object.keys(party.slotData || {}).filter(slotId => {
      const entry = waitingById.get(slotId);
      return !!entry && entry.status !== "realizado";
    });
    if (toMark.length === 0) return;

    const realizadoAt = Date.now();
    // Atualização otimista: a sub-guia "Realizados" reflete na hora, sem
    // esperar a próxima leitura da coleção (que é pontual, sem listener).
    setCloudWaitingList(prev => {
      const next = prev.map(w => (toMark.includes(w.id) ? { ...w, status: "realizado" as const, realizadoAt } : w));
      try {
        localStorage.setItem("cloud_cache_waitingList", JSON.stringify(next));
      } catch {}
      return next;
    });

    try {
      await Promise.allSettled(
        toMark.map(id => updateDoc(doc(db, "waitingList", id), {
          status: "realizado",
          realizadoAt,
        }))
      );
    } catch {
      // Falha na marcação não pode interromper o fluxo de conclusão da PT;
      // libera o marcador para nova tentativa em um próximo ciclo.
      removedWaitingForPartyRef.current.delete(party.id);
    }
  }

  // Detecção de conclusão de Quest — observa cloudParties para mudanças de
  // questConcluida de false → true. Usa ref para comparar estado anterior.
  const prevQuestConcluidaRef = useRef<Record<string, boolean>>({});
  const questDetectionReadyRef = useRef(false);

  useEffect(() => {
    // Primeira execução: popular o ref sem disparar writes
    if (!questDetectionReadyRef.current) {
      cloudParties.forEach(pt => {
        prevQuestConcluidaRef.current[pt.id] = !!pt.questConcluida;
      });
      // Marcar como pronto após 2s (evita disparar em PTs já concluídas no cache)
      const timer = window.setTimeout(() => {
        questDetectionReadyRef.current = true;
      }, 2000);
      return () => window.clearTimeout(timer);
    }

    cloudParties.forEach(pt => {
      const wasConcluded = prevQuestConcluidaRef.current[pt.id] || false;
      const isNowConcluded = !!pt.questConcluida;

      if (!wasConcluded && isNowConcluded && !pt.questFalha) {
        writeProbableMarkers(pt);
        // Services entregues são marcados como "realizado" (saem de circulação,
        // sem serem apagados). Só roda quando a Quest é concluída COM SUCESSO —
        // PT cancelada ou com questFalha preserva a fila.
        markCompletedServicesAsRealizado(pt);
      }

      prevQuestConcluidaRef.current[pt.id] = isNowConcluded;
    });
  }, [cloudParties]);

  // ============================================================================
  // PROBABLE MARKERS — Remoção automática (Fluxo 4)
  // ============================================================================
  // Quando o campo soulwar/sanguine de um personagem é alterado para false
  // (via Att Chars, Auto-Att, edição manual, etc.), removemos o probableMarker
  // correspondente. Detecta mudanças comparando com o estado anterior.
  // ============================================================================
  const prevCharsForMarkersRef = useRef<Character[]>([]);

  useEffect(() => {
    const prevChars = prevCharsForMarkersRef.current;
    if (prevChars.length === 0) {
      // Primeira execução: apenas popular o ref
      prevCharsForMarkersRef.current = data.characters;
      return;
    }

    const changes: Array<{ charId: string; field: "soulwar" | "sanguine" }> = [];

    data.characters.forEach(c => {
      const prev = prevChars.find(pc => pc.id === c.id);
      if (!prev) return;

      // soulwar: true → false (personagem foi confirmado como tendo feito SoulWar)
      if (prev.soulwar && !c.soulwar) {
        changes.push({ charId: c.id, field: "soulwar" });
      }
      // sanguine: true → false
      if (prev.sanguine && !c.sanguine) {
        changes.push({ charId: c.id, field: "sanguine" });
      }
    });

    if (changes.length > 0) {
      // Limpar do estado local
      setProbableMarkers(prev => {
        const next = { ...prev };
        changes.forEach(({ charId, field }) => {
          if (next[charId]) {
            const marker = { ...next[charId] };
            delete (marker as any)[field];
            if (!marker.soulwar && !marker.sanguine) {
              delete next[charId];
            } else {
              next[charId] = marker;
            }
          }
        });
        try { localStorage.setItem("cloud_cache_probableMarkers", JSON.stringify(next)); } catch {}
        return next;
      });

      // Gravar no Firestore (remover campos com null)
      if (!isSimulation && db && currentUser?.uid) {
        const updates: Record<string, any> = {};
        changes.forEach(({ charId, field }) => {
          updates[`probableMarkers.${charId}.${field}`] = null; // null remove o campo
        });
        updateDoc(doc(db, "sharedCharacters", currentUser.uid), updates).catch(() => {});
      }
    }

    prevCharsForMarkersRef.current = data.characters;
  }, [data.characters]);

  // ============================================================================
  // AUTO-ATT — Atualização automática de personagens (Fluxo Auto-Att)
  // ============================================================================
  // Quando autoCharUpdate está ativo E existe uma notificação "Quest Concluída"
  // ainda não processada, aguarda ~2s e executa a rotina existente do Att Chars
  // (handleUpdateCharactersFromNotification). Cada notificação é processada apenas
  // uma única vez (controle via localStorage). Funciona também offline: ao reabrir
  // o app, notificações pendentes são localizadas e processadas automaticamente.
  // ============================================================================
  const AUTO_ATT_PROCESSED_KEY = "chernobyl_auto_att_processed";
  const autoAttDoneRef = useRef<Set<string>>(new Set());
  const autoAttInitRef = useRef(false);

  useEffect(() => {
    if (!autoAttInitRef.current) {
      try {
        const raw = localStorage.getItem(AUTO_ATT_PROCESSED_KEY);
        if (raw) {
          const arr = JSON.parse(raw);
          if (Array.isArray(arr)) arr.forEach((id: string) => autoAttDoneRef.current.add(id));
        }
      } catch {}
      autoAttInitRef.current = true;
    }
  }, []);

  function markAutoAttProcessed(notifId: string) {
    autoAttDoneRef.current.add(notifId);
    try {
      localStorage.setItem(AUTO_ATT_PROCESSED_KEY, JSON.stringify(Array.from(autoAttDoneRef.current)));
    } catch {}
  }

  useEffect(() => {
    notifications.forEach(n => {
      if (n.type === "quest_completed_donation" && n.attCharsDone) {
        autoAttDoneRef.current.add(n.id);
      }
    });
  }, [notifications]);

  useEffect(() => {
    if (!userProfile?.autoCharUpdate) return;
    if (!currentUser?.uid) return;

    // Encontrar notificações pendentes de "Quest Concluída" ainda não processadas
    const pendingQuestNotifs = notifications.filter(n =>
      n.type === "quest_completed_donation" &&
      n.status === "pending" &&
      n.partyId &&
      !n.attCharsDone &&
      !autoAttDoneRef.current.has(n.id)
    );

    if (pendingQuestNotifs.length === 0) return;

    const timers: number[] = [];

    // Processar cada notificação pendente com delay de 2s
    pendingQuestNotifs.forEach((notif) => {
      const timer = window.setTimeout(async () => {
        if (autoAttDoneRef.current.has(notif.id) || notif.attCharsDone) return;

        try {
          const success = await handleUpdateCharactersFromNotification({
            notificationId: notif.id,
            partyId: notif.partyId!,
            questType: notif.questType || "soulwar",
          });
          if (success) {
            markAutoAttProcessed(notif.id);
            try {
              if (db) {
                await updateDoc(doc(db, "notifications", notif.id), {
                  attCharsDone: true,
                  attCharsDoneAt: Date.now(),
                });
              }
            } catch {}
          }
        } catch (err) {
          console.error("Auto-Att: erro ao processar notificação:", err);
        }
      }, 2000);
      timers.push(timer);
    });

    return () => {
      timers.forEach(t => window.clearTimeout(t));
    };
  }, [notifications, userProfile?.autoCharUpdate, currentUser?.uid]);

  // ============================================================================
  // ESTATÍSTICAS PERSISTENTES (userStats) — ARQUITETURA HÍBRIDA
  // ============================================================================
  // Quando uma PT é concluída (questConcluida === true), os contadores do
  // usuário que aparece na coluna JOGADOR são incrementados em userStats/{uid}.
  //
  // ESCRITORES (dois, intercambiáveis e idempotentes):
  //   1. BACKEND (primário): a Cloud Function materializePartySettlement
  //      (functions/src/partyLifecycle.ts) commita as stats de TODOS os
  //      participantes na conclusão da Quest — com app aberto ou fechado,
  //      garantindo consistência entre usuários. A semântica do payload
  //      (partyStatsCore.ts) espelha exatamente o commitPartyStats abaixo.
  //   2. FRONTEND (fallback self-healing): a FASE 2 abaixo continua
  //      observando cloudParties e processa PTs que o backend ainda não
  //      cobriu (ex.: falha transitória na Function). Ambos usam OS MESMOS
  //      marcadores de idempotência, então nunca duplicam contagens: quem
  //      chegar segundo aborta silenciosamente ao encontrar o marcador.
  //
  // REGRAS FUNDAMENTAIS (conforme especificação):
  //   1. As estatísticas são atribuídas APENAS ao usuário selecionado na
  //      coluna JOGADOR (slotData[id].player). Se não houver jogador
  //      definido, ou se não for possível resolvê-lo a um uid via allUsers,
  //      a estatística NÃO é gravada. NÃO há fallback para o DONO
  //      (ownerUid/ownerName).
  //   2. Cada usuário é contabilizado apenas UMA vez por PT — mesmo que
  //      apareça como jogador em múltiplos slots, as contribuições (mortes)
  //      são agregadas em uma única transação.
  //   3. Idempotência garantida pela subcoleção
  //      userStats/{uid}/processedParties/{partyId}: se o marcador já
  //      existir, a transação aborta silenciosamente.
  //   4. Writes incrementais via increment() do Firestore (sem leitura
  //      prévia do documento userStats, minimizando Reads).
  //
  // DETECÇÃO (frontend): reativa, baseada em cloudParties — a mesma
  // arquitetura já usada em useNotifications.ts. Cada cliente processa
  // APENAS suas próprias stats (respeitando as regras: request.auth.uid ==
  // userId). Os marcadores NÃO são mais listados no login: a transação já
  // verifica o marcador individual de cada PT (e o backend é o escritor
  // primário), o que elimina uma leitura que crescia com o histórico total
  // de PTs do usuário.
  // ============================================================================
  const processedStatsRef = useRef<Set<string>>(new Set());
  const statsInitRef = useRef(false);
  const statsInFlightRef = useRef<Set<string>>(new Set());

  // Lista de usuários aprovados (uid + nome) carregada no login — necessária
  // para resolver o nome da coluna JOGADOR → UID (parceiros por UID, nunca
  // por nome). O AuthContext só popula allUsers para Boss/VIP, então esta
  // fonte própria garante a resolução também para usuários Normal.
  // Carregada UMA vez por sessão (getDocs, sem listener contínuo).
  const approvedUsersStatsRef = useRef<Array<{ uid: string; nome: string }>>([]);
  // Mapa uid -> nome para exibição dos parceiros persistidos no StatsPanel
  const [statsUserNames, setStatsUserNames] = useState<Record<string, string>>({});
  // Services do usuário (painel "Meus Services"), lidos do cache local — sem
  // leitura extra de Firestore. Alimentam o "Lucro de Services" da Stats.
  // Recalculado quando o contador de serviços muda (indica alteração no painel).
  const statsUserServices = useMemo(() => {
    if (!currentUser?.uid) return [] as SharedService[];
    try { return readSharedServicesCache(currentUser.uid); } catch { return []; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser?.uid, myServicesCount]);

  // Documento userStats/{uid} em tempo real — consumido pelo StatsPanel
  // (migração parcial: apenas métricas já persistidas usam esta fonte).
  const [userStatsDoc, setUserStatsDoc] = useState<Record<string, any> | null>(null);
  useEffect(() => {
    if (!currentUser?.uid || !userProfile || userProfile.status !== "aprovado" || isSimulation || !db) {
      setUserStatsDoc(null);
      return;
    }
    if (isIdleMode) return;
    const unsub = onSnapshot(doc(db, "userStats", currentUser.uid), (snap: any) => {
      setUserStatsDoc(snap.exists() ? (snap.data() as Record<string, any>) : null);
    }, () => {});
    return () => unsub();
  }, [currentUser?.uid, userProfile?.status, isSimulation, isIdleMode]);

  // ============================================================================
  // ADVICE DONATION MODAL — exibe quando média de doação está abaixo do mínimo
  // ============================================================================
  // Verifica ao montar (login) e sempre que userStatsDoc atualiza (após concluir PT).
  useEffect(() => {
    if (!userStatsDoc || !currentUser) return;
    if (userProfile?.role === "Boss") return;
    const totalRcDoado = typeof userStatsDoc.totalRcDoado === "number" ? userStatsDoc.totalRcDoado : 0;
    const totalPtsConcluidas = typeof userStatsDoc.totalPtsConcluidas === "number" ? userStatsDoc.totalPtsConcluidas : 0;
    if (totalPtsConcluidas < 3) return; // Precisa de no mínimo 3 PTs concluídas
    const average = totalRcDoado / totalPtsConcluidas;
    if (average < globalSettings.minimumAverageDonation) {
      setAdviceDonationOpen(true);
    }
  }, [userStatsDoc, currentUser?.uid, userProfile?.role, globalSettings.minimumAverageDonation]);

  // Resultado da análise de uma PT concluída sob a ótica do usuário atual.
  // deaths        → soma das mortes dos slots em que ele é o JOGADOR
  // participations → quantidade de slots em que ele é o JOGADOR
  // partnerUids   → UIDs (nunca nomes) dos DEMAIS jogadores da PT, deduplicados
  interface PartyStatsInfo {
    deaths: number;
    participations: number;
    partnerUids: string[];
    services: number;
  }
  // Analisa a PT e retorna as contribuições do usuário atual, resolvendo a
  // coluna JOGADOR (slotData.player) para UIDs via lista de usuários
  // aprovados. SEM fallback para DONO (ownerUid/owner), conforme regra.
  // Retorna null se o usuário não é JOGADOR em nenhum slot.
  function analyzePartyForStats(pt: PartyTab, uid: string, myNameLower: string): PartyStatsInfo | null {
    if (!pt.questConcluida || pt.questFalha) return null;
    const slotData = pt.slotData || {};
    const nameToUid = new Map<string, string>();
    approvedUsersStatsRef.current.forEach((u) => {
      if (u.nome) nameToUid.set(u.nome.toLowerCase(), u.uid);
    });
    // Conjunto de IDs da lista de espera (services) para identificar quais
    // slots são de personagens que vieram via Waiting List.
    const waitingIds = new Set<string>((cloudWaitingList || []).map(w => w.id));
    let deaths = 0;
    let participations = 0;
    let services = 0;
    const partnerSet = new Set<string>();
    Object.entries(slotData).forEach(([slotId, slot]) => {
      const player = slot?.player;
      if (!player) return;
      const lower = player.toLowerCase();
      const resolvedUid = nameToUid.get(lower) || (myNameLower && lower === myNameLower ? uid : undefined);
      if (resolvedUid === uid) {
        participations++;
        deaths += slot.deaths || 0;
        // Service = flag persistida no slot (fonte primária). O fallback para a
        // Lista de Espera cobre PTs antigas, criadas antes de `isService`
        // existir; desde que as entradas passaram a ser marcadas como
        // "realizado" (em vez de removidas), o fallback segue válido também
        // nas novas.
        if (slot.isService || waitingIds.has(slotId)) {
          services += 1;
        }
      } else if (resolvedUid) {
        // Parceiro identificado por UID (jogador de outro usuário aprovado)
        partnerSet.add(resolvedUid);
      }
      // Jogadores não resolvíveis a um UID (externos/convidados) são ignorados
    });
    if (participations === 0) return null;
    return { deaths, participations, partnerUids: Array.from(partnerSet), services };
  }

  // Helper da FASE 2: executa a transação idempotente que grava as
  // estatísticas de uma PT concluída para o usuário.
  // Retorna true em caso de sucesso (ou se já estava processada).
  //
  // PARIDADE COM O BACKEND: o espelho desta transação vive em
  // functions/src/partyStatsCore.ts (commitado pela Cloud Function
  // materializePartySettlement). Qualquer mudança de campo/semântica aqui
  // DEVE ser replicada lá — os dois escritores compartilham os mesmos
  // marcadores e se anulam sem duplicar.
  //
  // NOTA SOBRE READS: a transação faz 2 leituras — o marcador (idempotência)
  // e o próprio doc de stats. A segunda leitura é NECESSÁRIA porque a
  // sequência sem morte (streak) exige max/reset, operações que increment()
  // não suporta. Todos os demais campos continuam 100% incrementais.
  async function commitPartyStats(pt: PartyTab, uid: string, info: PartyStatsInfo): Promise<boolean> {
    const duration = pt.ptDuration || 0;
    const isSoulwar = pt.ptType === "soulwar";
    const isSanguine = pt.ptType === "sanguine";
    const servidor = (pt.servidor || "").trim();
    const semMorte = info.deaths === 0;
    try {
      await runTransaction(db, async (tx) => {
        const markerRef = doc(db, "userStats", uid, "processedParties", pt.id);
        const markerSnap = await tx.get(markerRef);

        // Já processado (por outro cliente/dispositivo ou pelo backend)
        if (markerSnap.exists()) {
          processedStatsRef.current.add(pt.id);
          return;
        }

        // Ler o doc de stats APENAS para calcular a sequência sem morte
        // (streak atual + máximo histórico) — não é possível via increment().
        const statsRef = doc(db, "userStats", uid);
        const statsSnap = await tx.get(statsRef);
        const cur: Record<string, any> = statsSnap.exists() ? statsSnap.data() : {};
        const curStreak = typeof cur.sequenciaAtualSemMorte === "number" ? cur.sequenciaAtualSemMorte : 0;
        const newStreak = semMorte ? curStreak + 1 : 0;
        const curMax = typeof cur.maxSequenciaSemMorte === "number" ? cur.maxSequenciaSemMorte : 0;
         const newMax = Math.max(curMax, newStreak);

        // ────────────────────────────────────────────────
        // RANKING SCORE — calculado a partir dos valores
        // PÓS-incremento (cur + 1, cur + deaths, etc.)
        // Fórmula balanceada que recompensa participação,
        // sobrevivência, tempo investido e consistência.
        // Usa set() com valor absoluto porque envolve
        // multiplicações e condicionais — não é possível
        // via increment().
        // ────────────────────────────────────────────────
        const curConcluidas = (typeof cur.totalPtsConcluidas === "number" ? cur.totalPtsConcluidas : 0) + 1;
        const curParticipacoes = (typeof cur.totalParticipacoes === "number" ? cur.totalParticipacoes : 0) + info.participations;
        const curSW = (typeof cur.totalPtsSoulwar === "number" ? cur.totalPtsSoulwar : 0) + (isSoulwar ? 1 : 0);
        const curSG = (typeof cur.totalPtsSanguine === "number" ? cur.totalPtsSanguine : 0) + (isSanguine ? 1 : 0);
        const curMortes = (typeof cur.totalMortes === "number" ? cur.totalMortes : 0) + info.deaths;
        const curSemMorte = (typeof cur.ptsSemMorte === "number" ? cur.ptsSemMorte : 0) + (semMorte ? 1 : 0);
        const curDurMs = (typeof cur.totalDuracaoMs === "number" ? cur.totalDuracaoMs : 0) + duration;

        const base = (curConcluidas * 10) + (curParticipacoes * 3) + (curSemMorte * 5);
        const penalty = curMortes * 2;
        const streakScore = newStreak + Math.floor(newMax * 0.5);
        const horasScore = Math.floor(curDurMs / 3_600_000) * 2;
        const questScore = curSW + (curSG * 2);

        let milestoneBonus = 0;
        if (curConcluidas >= 500) milestoneBonus = 250;
        else if (curConcluidas >= 250) milestoneBonus = 100;
        else if (curConcluidas >= 100) milestoneBonus = 50;

        const rankingScore = Math.max(0, base - penalty + streakScore + horasScore + questScore + milestoneBonus);

        // Criar marcador (idempotência)
        tx.set(markerRef, {
          processedAt: Date.now(),
          partyName: pt.name || "",
          questType: pt.ptType || "soulwar",
        });

        // Incrementar contadores (cria o doc se não existir)
        const dayKey = new Date(pt.archivedAt || (pt as any).updatedAt || Date.now()).toISOString().slice(0, 10);

        const payload: Record<string, any> = {
          totalPtsConcluidas: increment(1),
          totalPtsSoulwar: increment(isSoulwar ? 1 : 0),
          totalPtsSanguine: increment(isSanguine ? 1 : 0),
          totalMortes: increment(info.deaths),
          totalDuracaoMs: increment(duration),
          // NOVAS MÉTRICAS (etapa atual):
          totalParticipacoes: increment(info.participations),
          services: increment(info.services),
          ptsSemMorte: increment(semMorte ? 1 : 0),
          ptsComMorte: increment(semMorte ? 0 : 1),
          sequenciaAtualSemMorte: newStreak,
          maxSequenciaSemMorte: newMax,
          rankingScore: rankingScore,
          rankingUpdatedAt: Date.now(),
          ultimaAtualizacao: serverTimestamp(),
          // Campos de doação — sempre inicializados para que todo usuário
          // possua permanentemente ambos os campos, independentemente de
          // já ter realizado ou não uma doação. Increment(0) é seguro:
          // não altera valores já existentes, apenas cria os campos.
          totalRcDoado: increment(0),
          totalRcDoadoAprovado: increment(0),
          [`dailyStats.${dayKey}.totalPtsConcluidas`]: increment(1),
          [`dailyStats.${dayKey}.totalPtsSoulwar`]: increment(isSoulwar ? 1 : 0),
          [`dailyStats.${dayKey}.totalPtsSanguine`]: increment(isSanguine ? 1 : 0),
          [`dailyStats.${dayKey}.totalMortes`]: increment(info.deaths),
          [`dailyStats.${dayKey}.totalDuracaoMs`]: increment(duration),
          [`dailyStats.${dayKey}.totalParticipacoes`]: increment(info.participations),
          [`dailyStats.${dayKey}.services`]: increment(info.services),
          [`dailyStats.${dayKey}.ptsSemMorte`]: increment(semMorte ? 1 : 0),
          [`dailyStats.${dayKey}.ptsComMorte`]: increment(semMorte ? 0 : 1),
        };
        // Contador por servidor (incrementa apenas o servidor desta PT)
        if (servidor) {
          payload.servers = { [servidor]: increment(1) };
          payload[`dailyStats.${dayKey}.servers.${servidor}`] = increment(1);
        }
        // Parceiros de quest — SEMPRE por UID, nunca por nome
        if (info.partnerUids.length > 0) {
          const partnersMap: Record<string, any> = {};
          info.partnerUids.forEach((pu) => {
            partnersMap[pu] = increment(1);
            payload[`dailyStats.${dayKey}.partners.${pu}`] = increment(1);
          });
          payload.partners = partnersMap;
        }
        tx.set(statsRef, payload, { merge: true });
      });
      processedStatsRef.current.add(pt.id);
      return true;
    } catch (err) {
      console.error("Erro ao processar PT para userStats:", err);
      return false;
    }
  }

  // FASE 1 — Ao autenticar, carregar usuários aprovados para a resolução
  // JOGADOR (nome) → UID. Os marcadores de PTs já processadas NÃO são mais
  // listados aqui: essa consulta crescia sem limite com o histórico de PTs
  // do usuário. A idempotência agora é garantida (a) pelo próprio marcador
  // individual, verificado DENTRO da transação do commitPartyStats — que
  // registra a PT em processedStatsRef ao abortar — e (b) pelo commit
  // primário do backend na Cloud Function de materialização.
  useEffect(() => {
    if (!currentUser || !userProfile || userProfile.status !== "aprovado") return;
    if (isSimulation || !db) return;

    let cancelled = false;

    (async () => {
      // Carregar usuários aprovados (uid + nome) — necessário ANTES de
      // qualquer processamento de stats, pois a resolução JOGADOR → UID
      // (parceiros por UID) depende desta lista. Consulta única por sessão.
      try {
        const usersSnap = await getDocs(query(collection(db, "users"), where("status", "==", "aprovado")));
        if (cancelled) return;
        const list: Array<{ uid: string; nome: string }> = [];
        const names: Record<string, string> = {};
        usersSnap.forEach(d => {
          const data = d.data() as any;
          const nome = data.nome || "Anônimo";
          list.push({ uid: d.id, nome });
          names[d.id] = nome;
        });
        approvedUsersStatsRef.current = list;
        setStatsUserNames(names);
      } catch (err) {
        console.error("Erro ao carregar usuários aprovados para stats:", err);
      }

      // Liberar a FASE 2 mesmo sem os usuários (stats só terão fallback de
      // nome próprio; o backend é o escritor primário e não depende disso).
      if (!cancelled) statsInitRef.current = true;
    })();

    return () => { cancelled = true; };
  }, [currentUser?.uid, userProfile?.status, isSimulation]);

  // FASE 2 — Observar cloudParties e processar cada PT recém-concluída.
  // FALLBACK SELF-HEALING: o commit primário das stats acontece no backend
  // (materializePartySettlement) na conclusão da Quest; este caminho cobre
  // PTs que por qualquer motivo ficaram pendentes (ex.: falha transitória
  // da Function) e é a única fonte do fallback de services via Lista de
  // Espera (PTs legadas anteriores à flag isService).
  // Para cada PT com questConcluida === true && questFalha !== true:
  //   - Verifica se o uid atual aparece como JOGADOR em algum slot
  //     (resolvendo slotData.player via allUsers)
  //   - Verifica se a PT ainda não foi processada (Set em memória)
  //   - Verifica se não há outra execução em andamento para essa PT
  //   - Executa uma transação que (atomicamente):
  //       a) lê o marcador userStats/{uid}/processedParties/{partyId};
  //       b) se ausente, cria o marcador e incrementa os contadores em
  //          userStats/{uid} usando increment(). Se o backend chegou
  //           primeiro, o marcador já existe e a transação aborta sem
  //           gravar nada (sem duplicação).
  useEffect(() => {
    if (!currentUser || !userProfile || userProfile.status !== "aprovado") return;
    if (isSimulation || !db) return;
    if (!statsInitRef.current) return; // aguarda FASE 1 concluir

    const uid = currentUser.uid;
    const myNameLower = (displayUserName || "").toLowerCase();

    cloudParties.forEach((pt) => {
      if (!pt.questConcluida || pt.questFalha) return;
      if (processedStatsRef.current.has(pt.id)) return;
      if (statsInFlightRef.current.has(pt.id)) return;

      // Analisar a PT sob a ótica do usuário atual: contribuições como
      // JOGADOR (mortes, participações) e parceiros resolvidos por UID.
      // IMPORTANTE: NÃO usar fallback para DONO conforme especificação.
      const info = analyzePartyForStats(pt, uid, myNameLower);
      if (info === null) return;

      // Marcar imediatamente (in-flight) para evitar re-processamento
      // enquanto a transação está em andamento.
      statsInFlightRef.current.add(pt.id);

      // Transação idempotente compartilhada (mesma usada pelo catch-up sweep)
      (async () => {
        const ok = await commitPartyStats(pt, uid, info);
        if (!ok) statsInFlightRef.current.delete(pt.id);
      })();
    });
  }, [cloudParties, currentUser?.uid, userProfile?.status, isSimulation, displayUserName]);

  // ============================================================================
  // ONLINE/OFFLINE DETECTION
  // ============================================================================

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => {
      setIsOnline(false);
      // Ao perder a conexão, desconectar imediatamente para forçar a tela de login.
      handleSignOut();
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [handleSignOut]);

  useEffect(() => {
    if (isElectron) {
      fetch("./version.json").then(r => r.json()).then(res => {
        if (res.version && res.version > "1.0.0") {
          const seenVersionKey = "tibia_notified_update_version";
          const lastNotified = localStorage.getItem(seenVersionKey);
          if (lastNotified === res.version) return;
          localStorage.setItem(seenVersionKey, res.version);
          addNotification({
            // Id ESTÁVEL por versão: revalidações do version.json não criam
            // uma segunda notificação do mesmo aviso.
            id: `update_available_${res.version}`,
            type: "update_available",
            title: "🔔 Atualize seu aplicativo!",
            body: "Uma nova versão está disponível. Baixe a atualização para continuar aproveitando."
          });
        }
      }).catch(() => {});
    }
  }, [addNotification]);
  // IPC LISTENER — Progresso de atualização (electron-updater)
  // ============================================================================
  useEffect(() => {
    const isElectronEnv = !!(window as any).require;
    if (!isElectronEnv) return;
    try {
      const { ipcRenderer } = (window as any).require('electron');

      function handleUpdateStatus(_event: any, data: any) {
        const { status, version, percent, message: errorMsg } = data || {};

        switch (status) {
          case 'checking':
            // Silencioso — apenas registra que está verificando
            break;
          case 'available':
            addNotification({
              // Ids ESTÁVEIS por estágio: o electron-updater emite 'downloading'
              // a cada salto de progresso — sem id fixo, cada tick criava uma
              // NOVA notificação (com id aleatório) e o desktop exibia uma
              // bolha por porcentagem. Com id fixo, cada tick apenas ATUALIZA
              // a mesma notificação in-place.
              id: 'update_status_available',
              type: 'update_available',
              title: `🔔 Nova versão ${version || ''} disponível!`,
              body: 'Baixando automaticamente em segundo plano...',
              status: 'pending',
            });
            break;
          case 'downloading':
            // Atualiza a notificação de download IN-PLACE (mesmo id a cada tick).
            if (typeof percent === 'number') {
              addNotification({
                id: 'update_status_downloading',
                type: 'update_available',
                title: '⬇️ Baixando atualização...',
                body: `Progresso: ${percent}% concluído.`,
                status: 'pending',
              });
            }
            break;
          case 'downloaded':
            addNotification({
              id: 'update_status_downloaded',
              type: 'update_available',
              title: '✅ Atualização pronta!',
              body: 'Feche e abra o aplicativo novamente para instalar. Ou clique em "Reiniciar Agora" no menu.',
              status: 'pending',
            });
            break;
          case 'error':
            addNotification({
              id: 'update_status_error',
              type: 'update_available',
              title: '⚠️ Erro na atualização',
              body: errorMsg || 'Não foi possível verificar atualizações.',
              status: 'pending',
            });
            break;
        }
      }
      ipcRenderer.on('update-status', handleUpdateStatus);
      return () => {
        ipcRenderer.removeListener('update-status', handleUpdateStatus);
      };
    } catch {}
  }, [addNotification]);
  useEffect(() => {
    setGlobalDialogHandler(setCustomDialog);
  }, []);
  // IPC LISTENERS — Integração com System Tray do Electron
  // ============================================================================
  // Em App.tsx, dentro de um useEffect com [] (uma vez)
  useEffect(() => {
    const isElectron = !!(window as any).require;
    if (isElectron) {
      const { ipcRenderer } = (window as any).require('electron');
      ipcRenderer.on('tray-action', (_event: any, action: string) => {
        if (action === 'navigate-pts') {
          setActiveWindow('characters');
          setTab('pts');
        }
        if (action === 'create-pt') {
          setActiveWindow('characters');
          setTab('pts');
          // Dispara evento customizado que o PartyManager escuta para abrir o modal
          setTimeout(() => {
            window.dispatchEvent(new CustomEvent('tray-open-create-pt'));
          }, 150);
        }
      });
    }
  }, []);

  useEffect(() => {
    // Carrega apenas o handle do arquivo (o estado do botão é restaurado por usuário).
    loadAutoSaveHandle().then(async (handle) => {
      if (handle) {
        setAutoSaveHandle(handle);
        try {
          const mode = "readwrite";
          await handle.queryPermission({ mode });
        } catch {}
      }
    });
  }, []);

  async function requestAutoSavePermission() {
    if (!autoSaveHandle) return false;
    try {
      const mode = "readwrite";
      if ((await (autoSaveHandle as any).queryPermission({ mode })) === "granted") return true;
      if ((await (autoSaveHandle as any).requestPermission({ mode })) === "granted") return true;
    } catch {}
    return false;
  }

  async function handleAutoSaveClick() {
    // Estado verde (saved): abrir modal informativo em vez da ação direta
    if (autoSaveStatus === "saved") {
      setAutoSaveInfoOpen(true);
      return;
    }
    if (autoSaveStatus === "waiting" && autoSaveHandle) {
      if (await requestAutoSavePermission()) {
        updateAutoSaveStatus("saved");
        writeAutoSaveFile(autoSaveHandle, data);
      } else {
        updateAutoSaveStatus("error");
      }
      return;
    }
    configureAutoSave();
  }

  const [cloudHydrated, setCloudHydrated] = useState(false);
  const wasCloudHydratedRef = useRef(false);

  useEffect(() => {
    // 1. Carrega dados locais iniciais para acesso imediato/offline
    const localData = loadData();
    setData(localData);
    setHydrated(true);
  }, []);

  // 2. Carregar personagens privados do Firestore no login uma única vez (userCharacters/{uid})
  useEffect(() => {
    if (!currentUser?.uid || !userProfile || userProfile.status !== "aprovado") {
      if (!wasCloudHydratedRef.current) {
        setCloudHydrated(false);
      }
      return;
    }
    if (isSimulation || !db) {
      wasCloudHydratedRef.current = true;
      setCloudHydrated(true);
      return;
    }
    let isMounted = true;
    async function fetchUserCharacters() {
      try {
        setIsSyncing(true);
        const docRef = doc(db, "userCharacters", currentUser.uid);
        const snap = await getDoc(docRef);
        if (!isMounted) return;
        if (snap.exists()) {
          const docData = snap.data();
          if (Array.isArray(docData?.characters)) {
            setData(prev => ({ ...prev, characters: docData.characters }));
          }
        }
        // Carregar probableMarkers do próprio documento sharedCharacters/{uid}
        // para que o aviso visual no CharTable funcione imediatamente no login,
        // sem precisar abrir a aba "Gerenciador de PT's".
        try {
          const sharedSnap = await getDoc(doc(db, "sharedCharacters", currentUser.uid));
          if (sharedSnap.exists()) {
            const sharedData = sharedSnap.data();
            if (sharedData?.probableMarkers && typeof sharedData.probableMarkers === "object" && !Array.isArray(sharedData.probableMarkers)) {
              const markers: ProbableMarkersMap = {};
              Object.entries(sharedData.probableMarkers as Record<string, any>).forEach(([charId, m]) => {
                if (m && typeof m === "object" && (m.soulwar || m.sanguine)) {
                  markers[charId] = { soulwar: m.soulwar === true ? true : undefined, sanguine: m.sanguine === true ? true : undefined };
                }
              });
              // Mesclar com os marcadores já carregados (de outros usuários)
              setProbableMarkers(prev => {
                const merged = { ...prev, ...markers };
                try { localStorage.setItem("cloud_cache_probableMarkers", JSON.stringify(merged)); } catch {}
                return merged;
              });
            }
          }
        } catch {}
      } catch (err) {
        console.error("Erro ao carregar userCharacters do Firestore:", err);
      } finally {
        if (isMounted) {
          wasCloudHydratedRef.current = true;
          setCloudHydrated(true);
          setIsSyncing(false);
        }
      }
    }
    fetchUserCharacters();
    return () => {
      isMounted = false;
    };
  }, [currentUser?.uid, userProfile?.status, isSimulation]);

  // Negociações confirmadas: fonte da guia, Stats e sincronização financeira.
  // A consulta já exclui pré-aprovações no Firestore, evitando leituras
  // desnecessárias fora do Gerenciador de PTs.
  useEffect(() => {
    if (!currentUser?.uid || !userProfile || userProfile.status !== "aprovado") {
      setCharacterAcquisitions([]);
      setPendingCharacterAcquisitions([]);
      setCharacterAcquisitionBuyerDetails([]);
      return;
    }
    return subscribeCharacterAcquisitions(currentUser.uid, setCharacterAcquisitions, "confirmed");
  }, [currentUser?.uid, userProfile?.status]);

  // Pré-aprovações existem apenas para o convite/aceite no PartyPanel. Este
  // listener agregado só fica ativo enquanto o Gerenciador de PTs estiver aberto.
  useEffect(() => {
    if (tab !== "pts" || !currentUser?.uid || !userProfile || userProfile.status !== "aprovado") {
      setPendingCharacterAcquisitions([]);
      return;
    }
    return subscribeCharacterAcquisitions(currentUser.uid, setPendingCharacterAcquisitions, "pre_approved");
  }, [currentUser?.uid, userProfile?.status, tab]);

  // Dados de Quest são privados do adquirente. Este é um único listener
  // agregado por comprador, não um listener individual por personagem.
  useEffect(() => {
    if (!currentUser?.uid || !userProfile || userProfile.status !== "aprovado") {
      setCharacterAcquisitionBuyerDetails([]);
      return;
    }
    return subscribeCharacterAcquisitionBuyerDetails(currentUser.uid, setCharacterAcquisitionBuyerDetails);
  }, [currentUser?.uid, userProfile?.status]);

  // Reidratação: se uma PT já tiver sido concluída antes de o aplicativo abrir,
  // o vínculo adquirido ainda é promovido de forma idempotente para o estado
  // correto assim que dono ou adquirente carregar suas negociações.
  useEffect(() => {
    cloudParties.forEach(party => {
      if (party.questConcluida && !party.questFalha) {
        void synchronizeCharacterAcquisitionsForQuest(party);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloudParties, characterAcquisitions]);

  // Reconciliação pontual ao retornar ao app. Se a PT já foi arquivada e não
  // está no cache/listener ativo, buscamos somente essa PT necessária (ativa e,
  // como fallback, arquivada), sem listener por char. Para o dono, promove o
  // estado compartilhado; para o comprador, também atualiza os detalhes privados
  // que ficaram defasados enquanto ele estava fechado.
  useEffect(() => {
    if (!currentUser?.uid || !userProfile || userProfile.status !== "aprovado") return;
    const recoverable = characterAcquisitions.filter(record => {
      const needsSharedQuestStatus = ["payment_confirmed", "created"].includes(record.status);
      const needsBuyerQuestRefresh = record.acquirerUid === currentUser.uid
        && ["quest_completed", "for_sale", "sold", "created"].includes(record.status);
      return needsSharedQuestStatus || needsBuyerQuestRefresh;
    });
    let cancelled = false;

    recoverable.forEach(record => {
      const key = `${record.id}:${toFirestoreMillis(record.updatedAt)}`;
      if (recoveredAcquisitionDetailsRef.current.has(key)) return;
      recoveredAcquisitionDetailsRef.current.add(key);

      void (async () => {
        let party = cloudParties.find(item => item.id === record.partyId);
        if (!party && !isSimulation && db) {
          try {
            const active = await getDoc(doc(db, "parties", record.partyId));
            if (active.exists()) party = { id: active.id, ...active.data() } as PartyTab;
            if (!party) {
              const sanitizedArchive = await getDoc(doc(db, "partyArchives", record.partyId));
              if (sanitizedArchive.exists()) party = { id: sanitizedArchive.id, ...sanitizedArchive.data(), archived: true } as PartyTab;
            }
          } catch (error) {
            console.error("Erro ao recuperar a PT para reconciliação da negociação:", error);
            // O próximo login/atualização da negociação pode tentar novamente.
            recoveredAcquisitionDetailsRef.current.delete(key);
            return;
          }
        }
        if (!cancelled && party?.questConcluida && !party.questFalha) {
          await synchronizeCharacterAcquisitionsForQuest(party);
        }
      })();
    });

    return () => { cancelled = true; };
    // synchronizeCharacterAcquisitionsForQuest é declaração estável do componente.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characterAcquisitions, characterAcquisitionBuyerDetails, cloudParties, currentUser?.uid, isSimulation, userProfile?.status]);

  // Auto-save LOCAL apenas (characters e notes) - mantido intacto
  useEffect(() => {
    if (!hydrated) return;
    const t = window.setTimeout(() => {
      saveData(data);
    }, 300);
    return () => window.clearTimeout(t);
  }, [data, hydrated]);

  // 3. Salvar personagens privados com debounce de 5 segundos para userCharacters/{uid}
  const lastSavedUserCharsRef = useRef<string>("");
  // Invalida um debounce antigo quando uma venda financeira exige persistência
  // imediata, evitando que um snapshot local anterior volte a sobrescrever o
  // valor oficial alguns segundos depois.
  const userCharactersWriteVersionRef = useRef(0);

  /**
   * Salva imediatamente a lista privada em operações financeiras críticas.
   * O fluxo normal continua usando debounce; esta função é usada apenas quando
   * uma venda negociada precisa publicar seu valor oficial sem janela de
   * inconsistência entre o Character do dono e o espelho em tempo real.
   */
  async function persistUserCharactersNow(characters: Character[]): Promise<boolean> {
    if (isSimulation || !db) return true;
    if (!cloudHydrated || !currentUser?.uid || !userProfile || userProfile.status !== "aprovado") return false;
    try {
      const writeVersion = ++userCharactersWriteVersionRef.current;
      setIsSyncing(true);
      const payload = JSON.parse(JSON.stringify({
        ownerUid: currentUser.uid,
        ownerName: displayUserName,
        characters,
        updatedAt: Date.now(),
      }));
      await setDoc(doc(db, "userCharacters", currentUser.uid), payload);
      if (writeVersion === userCharactersWriteVersionRef.current) {
        lastSavedUserCharsRef.current = JSON.stringify(characters);
      }
      return true;
    } catch (err) {
      console.error("Erro ao salvar imediatamente userCharacters no Firestore:", err);
      return false;
    } finally {
      setIsSyncing(false);
    }
  }

  useEffect(() => {
    if (!cloudHydrated || !currentUser?.uid || !userProfile || userProfile.status !== "aprovado" || isSimulation || !db) return;

    const charsJSON = JSON.stringify(data.characters);
    if (lastSavedUserCharsRef.current === "") {
      // Primeira execução após carregar da nuvem: define a base para evitar loop/write desnecessário
      lastSavedUserCharsRef.current = charsJSON;
      return;
    }
    if (charsJSON === lastSavedUserCharsRef.current) return;

    const scheduledWriteVersion = userCharactersWriteVersionRef.current;
    const t = window.setTimeout(async () => {
      if (scheduledWriteVersion !== userCharactersWriteVersionRef.current) return;
      try {
        setIsSyncing(true);
        const payload = {
          ownerUid: currentUser.uid,
          ownerName: displayUserName,
          characters: data.characters,
          updatedAt: Date.now()
        };
        await setDoc(doc(db, "userCharacters", currentUser.uid), JSON.parse(JSON.stringify(payload)));
        if (scheduledWriteVersion === userCharactersWriteVersionRef.current) {
          lastSavedUserCharsRef.current = charsJSON;
        }
      } catch (err) {
        console.error("Erro ao salvar userCharacters no Firestore:", err);
      } finally {
        setIsSyncing(false);
      }
    }, 5000);

    return () => window.clearTimeout(t);
  }, [data.characters, cloudHydrated, currentUser, userProfile, displayUserName, isSimulation]);

  // Reset trackers on user change
  useEffect(() => {
    lastSavedSharedCharsRef.current = "";
    lastSavedUserCharsRef.current = "";
    userCharactersWriteVersionRef.current += 1;
    recoveredAcquisitionDetailsRef.current.clear();
    wasCloudHydratedRef.current = false;
    setCloudHydrated(false);
  }, [currentUser?.uid]);

  const isWritingAutoSave = useRef(false);
  const autoSaveReady = useRef(false);
  const prevCharactersRef = useRef<string>("");

  // Auto-Save = camada de segurança local APENAS para dados pessoais:
  // personagens (ativos + histórico de vendidos), anotações e HISTÓRICO DE
  // PT's (backup permanente do Histórico). PT's ativas, Lista de Espera,
  // ranking, notificações e dados compartilhados NÃO são gravados aqui —
  // são sincronizados continuamente pelo Firestore.
  async function writeAutoSaveFile(handle: any, currentData: AppData) {
    if (isWritingAutoSave.current) return;
    isWritingAutoSave.current = true;
    try {
      const payload = buildPersonalBackup(
        currentData.characters,
        currentData.notes,
        [],
        displayUserName
      );
      const json = JSON.stringify(payload, null, 2);
      if (isElectron) {
        const { ipcRenderer } = (window as any).require("electron");
        await ipcRenderer.invoke("write-autosave", handle, json);
      } else {
        const writable = await handle.createWritable();
        await writable.write(json);
        await writable.close();
      }
      updateAutoSaveStatus("saved");
    } catch (error) {
      console.error("Auto-Save falhou", error);
      updateAutoSaveStatus("error");
    } finally {
      isWritingAutoSave.current = false;
    }
  }

  useEffect(() => {
    autoSaveReady.current = autoSaveStatus === "saved";
  }, [autoSaveStatus]);

  useEffect(() => {
    if (!hydrated || !autoSaveHandle || !autoSaveReady.current) return;
    // Observa somente os dados PESSOAIS que o Auto-Save protege:
    // personagens (inclui histórico de vendidos) + anotações. PT's, histórico
    // e Lista de Espera são ignoradas de propósito (vivem no Firestore).
    const personalJSON = JSON.stringify({ c: data.characters, n: data.notes });
    if (prevCharactersRef.current === "") {
      prevCharactersRef.current = personalJSON;
      return;
    }
    if (personalJSON === prevCharactersRef.current) return;
    prevCharactersRef.current = personalJSON;

    if (autoSaveTimerRef.current) window.clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = window.setTimeout(() => {
      writeAutoSaveFile(autoSaveHandle, data);
    }, 1500);
    return () => { if (autoSaveTimerRef.current) window.clearTimeout(autoSaveTimerRef.current); };
  }, [data.characters, data.notes, autoSaveHandle, hydrated]);

  // PartyPanel precisa de propostas pendentes para o aceite; a guia e Stats
  // recebem apenas `characterAcquisitions`, que já contém registros confirmados.
  const partyCharacterAcquisitions = useMemo(() => {
    const byId = new Map<string, CharacterAcquisition>();
    [...characterAcquisitions, ...pendingCharacterAcquisitions].forEach(record => byId.set(record.id, record));
    return Array.from(byId.values()).sort((a, b) => toFirestoreMillis(b.updatedAt) - toFirestoreMillis(a.updatedAt));
  }, [characterAcquisitions, pendingCharacterAcquisitions]);

  // Identificação visual, sem alterar a lista ou a lógica normal dos personagens.
  const negotiatedOriginalCharacterIds = useMemo(() => new Set(
    characterAcquisitions
      .filter(record => record.originalOwnerUid === currentUser?.uid)
      .map(record => record.characterId),
  ), [characterAcquisitions, currentUser?.uid]);
  const ativos = useMemo(() => data.characters.filter((c) => !c.vendido), [data.characters]);
  const vendidos = useMemo(() => data.characters.filter((c) => c.vendido), [data.characters]);

  const accounts = useMemo(
    () => Array.from(new Set(data.characters.map((c) => c.account).filter((value): value is string => typeof value === "string" && value.length > 0))).sort(),
    [data.characters]
  );
  const servers = useMemo(
    () => Array.from(new Set(data.characters.map((c) => c.servidor).filter((value): value is string => typeof value === "string" && value.length > 0))).sort(),
    [data.characters]
  );

  function resolveLeaderName(leaderUid?: string, fallbackName?: string) {
    // `leaderUid` é o UID (string) do líder da PT gravado no Firestore.
    // `fallbackName` é o nome para exibição (já resolvido anteriormente ou armazenado).
    if (fallbackName) return fallbackName;
    if (leaderUid && currentUser?.uid === leaderUid) return displayUserName;
    return leaderUid || "Anônimo";
  }

  const cloudPartiesForDisplay = useMemo(
    () => cloudParties.map((party) => {
      const leaderUid = party.leaderUid || party.LeaderPT;
      const displayName = party.LeaderPT && party.LeaderPT.length > 0 && party.LeaderPT !== party.leaderUid
        ? party.LeaderPT
        : resolveLeaderName(leaderUid, party.createdByName);
      return {
        ...party,
        leaderUid: leaderUid,
        createdByName: displayName,
        LeaderPT: displayName,
      };
    }),
    [cloudParties, currentUser?.uid, displayUserName]
  );

  // VISIBILIDADE DOS SERVICES
  // Filtra a Lista de Espera pelo Serviceiro designado: quando o cliente
  // escolhe um serviceiro específico, apenas ele (e o Boss) enxerga o
  // personagem; com "Qualquer um", todos enxergam. Aplicado aqui, na fonte,
  // para valer igualmente no WaitingListPanel e na ServiceList — que
  // consomem esta mesma lista.
  // A aba Services (WaitingListPanel) é exclusiva do Boss: ele atende os
  // pedidos enviados como "Qualquer um".
  const isBossUser = userProfile?.role === "Boss";

  // Guarda de acesso: se um usuário não-Boss estiver na aba Services — por
  // estado restaurado, perda do papel Boss ou qualquer outro caminho —, ele é
  // devolvido para "Meus Personagens" em vez de ver um painel em branco.
  useEffect(() => {
    if (tab === "waitlist" && !isBossUser) setTab("ativos");
  }, [tab, isBossUser]);

  const cloudWaitingListForDisplay = useMemo(
    () => cloudWaitingList
      .filter((item) => canViewServiceEntry(item, displayUserName, userProfile?.role === "Boss"))
      .map((item) => ({
        ...item,
        createdByName: resolveLeaderName(item.createdBy, item.createdByName),
        LeaderPT: resolveLeaderName(item.createdBy, item.createdByName),
      })),
    [cloudWaitingList, currentUser?.uid, displayUserName, userProfile?.role]
  );

  // Contador da guia Services: apenas personagens NA FILA. Os "realizado"
  // continuam visíveis na sub-guia "Realizados" do painel, mas deixaram de ser
  // trabalho pendente — um contador que só cresce deixaria de informar.
  const waitingQueueCount = useMemo(
    () => cloudWaitingListForDisplay.filter(item => item.status !== "realizado").length,
    [cloudWaitingListForDisplay]
  );

  // ============================================================================
  // VISIBILIDADE DAS PARTIES
  // ============================================================================
  // Regras aplicadas:
  //   1. Boss tem acesso a TUDO (todas as PTs ativas e arquivadas, inclusive
  //      privadas e públicas em que ele não participa).
  //   2. PT PRIVADA: só é visível para o líder, convidados (invitedUsers),
  //      e membros que estão em algum slot (ownerUid).
  //   3. PT PÚBLICA: visível para todos enquanto a quest NÃO tiver sido
  //      iniciada (sem ptStartedAt). APÓS a quest iniciar
  //      (ptStartedAt !== undefined), a PT pública vira "restrita aos membros" —
  //      apenas líder, members e donos de slot continuam vendo.
  //   4. PTs arquivadas (archived=true): filtradas pelo listener LAZY. O
  //      usuário vê apenas as próprias, ou todas se for Boss.
  // ============================================================================
  const allParties = useMemo(() => {
    const uid = currentUser?.uid;
    return cloudPartiesForDisplay.filter(party => {
      // Regra 1: Boss enxerga TUDO
      if (userProfile?.role === "Boss") return true;
      if (!uid) return false;
      // Helper: usuário é participante (líder, member ou ownerUid em algum slot)
      function isUserParticipant() {
        if (party.leaderUid === uid) return true;
        if (party.members && party.members.includes(uid)) return true;
        if (party.invitedUsers && party.invitedUsers.includes(uid)) return true;
        const sd = party.slotData || {};
        return Object.values(sd).some((slot: any) => slot?.ownerUid === uid);
      }
      // Verifica se a PT está com todas as vagas preenchidas
      const totalMembers = (party.selectedIds?.length || 0) + (party.customMembers?.length || 0);
      const isFull = totalMembers >= (party.slots || 5);
      // Regra 2: PT Privada
      if (party.visibility === "private") {
        return isUserParticipant();
      }
      // Regra 3: PT Pública
      if (party.visibility === "public" || !party.visibility) {
        // Enquanto houver vagas, todos veem
        if (!isFull) return true;
        // PT cheia: só participantes veem
        return isUserParticipant();
      }
      return false;
    });
  }, [cloudPartiesForDisplay, currentUser?.uid, userProfile?.role]);

  const activeParties = useMemo(() => allParties.filter(p => !p.archived), [allParties]);

  // "Meu Histórico de PT's" (único histórico oficial) só consome listener
  // enquanto a guia está aberta — fora dela o estado NÃO é zerado: retém o
  // último snapshot (e o espelho local), mantendo o contador persistente sem
  // listener permanente. Troca de usuário/status é tratada pela hidratação.
  useEffect(() => {
    if (tab !== "meu_historico" || !currentUser?.uid || userProfile?.status !== "aprovado") {
      return;
    }
    return subscribePersonalPartyHistory(currentUser.uid, entries => {
      setPersonalPartyHistory(entries);
    });
  }, [tab, currentUser?.uid, userProfile?.status]);


  async function handleRequestPartyFinalization(party: PartyTab, reason: PartyFinalizationReason): Promise<{ ok: boolean; error?: string }> {
    if (!currentUser?.uid) return { ok: false, error: "Entre na sua conta para finalizar a PT." };
    if (party.leaderUid !== currentUser.uid && userProfile?.role !== "Boss") {
      return { ok: false, error: "Somente o Líder ou Boss pode solicitar a finalização." };
    }
    return requestPartyFinalization({
      partyId: party.id,
      reason,
      requestedByUid: currentUser.uid,
      expectedRevision: Math.max(0, Math.floor(Number(party.settlementRevision) || 0)),
    });
  }

  // ============================================================================
  // FIRESTORE WRITE OPERATIONS - PT's
  // ============================================================================

  async function createParty(_name: string, ptType?: "soulwar" | "sanguine", horarioTimestamp?: number, visibility?: "public" | "private", invitedUsers?: string[], servidor?: string, suggestedIds?: string[]) {
    if (!currentUser) return;
    if (globalSettings.publicPartiesEnabled === false && (visibility || "public") === "public") {
      customAlert("A criação de PTs públicas está temporariamente pausada pelo administrador.", "PT Pública pausada");
      return;
    }
    const id = "pt_" + Math.random().toString(36).slice(2) + Date.now().toString(36);

    // ============================================================================
    // GERAÇÃO AUTOMÁTICA E ATÔMICA DO NOME DA PT
    // Padrão: "#1", "#2", "#3", ... (numeração crescente e infinita).
    // Usa runTransaction em settings/pt_counter para garantir que dois usuários
    // simultâneos NÃO recebam o mesmo número (proteção contra concorrência).
    // O contador armazena o último número usado; a transação faz: leia atual +
    // some 1 + grave de volta + retorne o novo número — tudo de forma atômica.
    // ============================================================================
    let nextNumber = 1;
    try {
      const counterRef = doc(db, "settings", "pt_counter");
      nextNumber = await runTransaction(db, async (tx) => {
        const snap = await tx.get(counterRef);
        const current = snap.exists() ? (snap.data().lastNumber || 0) : 0;
        const newNumber = current + 1;
        tx.set(counterRef, { lastNumber: newNumber }, { merge: true });
        return newNumber;
      });
    } catch (err) {
      console.error("Erro ao gerar número sequencial da PT:", err);
      customAlert("Não foi possível gerar o número da PT. Verifique sua conexão e tente novamente.");
      return;
    }
    const generatedName = `#${nextNumber}`;

    // ============================================================================
    // SUGESTÃO DE PT — pré-popular slotData/members/invitedUsers
    // ============================================================================
    // Quando `suggestedIds` está presente, a PT está sendo criada a partir do
    // fluxo "Sugerir PT". Reaproveitamos a lógica de adicionar membros já
    // existente no PartyPanel (addToParty): para cada personagem sugerido,
    // resolvemos `owner`, `ownerUid` e `player`, e adicionamos ao slotData.
    // Em PT privada, adicionamos automaticamente os donos à lista de convidados.
    let initialSelectedIds: string[] = [];
    let initialSlotData: Record<string, any> = {};
    let initialMembers: string[] = [];
    let initialInvitedUsers: string[] | undefined = visibility === "private" ? (invitedUsers || [currentUser.uid]) : undefined;
    let initialSlots = 5;

    if (suggestedIds && suggestedIds.length > 0) {
      initialSelectedIds = [...suggestedIds];
      initialSlots = Math.max(5, suggestedIds.length);
      const invitedSet = new Set<string>(initialInvitedUsers || []);
      const membersSet = new Set<string>();
      membersSet.add(currentUser.uid);

      suggestedIds.forEach((charId) => {
        // Resolve o personagem/Service pela MESMA fonte que alimenta o
        // PartyPanel na adição manual (availableWaitingListForParty), que inclui
        // `sharedServices` com os metadados corretos. Antes usávamos apenas
        // `cloudWaitingList` (Lista de Espera legada), que NÃO contém
        // `sharedServices` — então um Service sugerido caía no `else` e o dono
        // virava o criador da PT. Agora o DONO/JOGADOR ficam idênticos ao
        // fluxo manual.
        const wt = availableWaitingListForParty.find((w) => w.id === charId);
        const ch = availableCharactersForParty.find((c) => c.id === charId);

        let ownerVal: string;
        let ownerUidVal: string;
        let playerVal: string;
        let itemVendidoVal = 0;

        if (wt) {
          // Mesma lógica do performAddToParty (PartyPanel):
          //   • DONO      = ownerName (para sharedServices é o CLIENTE, o dono
          //                real do personagem; para legado é o dono da entrada);
          //   • ownerUid  = ownerUid || createdBy || serviceiroUid — para um
          //                sharedService, `createdBy`/`serviceiroUid` é o
          //                SERVICEIRO (responsável), NUNCA o criador da PT;
          //   • JOGADOR   = addedBy (o Serviceiro/responsável definido).
          ownerVal = wt.ownerName || displayUserName;
          ownerUidVal = (wt as any).ownerUid || wt.createdBy || (wt as any).serviceiroUid || "";
          playerVal = wt.addedBy || displayUserName;
          itemVendidoVal = wt.valorCombinado || 0;
        } else if (ch) {
          ownerVal = (ch as any).ownerName || displayUserName;
          ownerUidVal = (ch as any).ownerUid || currentUser.uid;
          playerVal = ownerVal;
        } else {
          ownerVal = displayUserName;
          ownerUidVal = currentUser.uid;
          playerVal = displayUserName;
        }

        initialSlotData[charId] = {
          deaths: 0,
          drop: 0,
          itemDropado: "",
          itemVendido: itemVendidoVal,
          player: playerVal,
          playerUid: ownerUidVal,
          split: false,
          owner: ownerVal,
          ownerUid: ownerUidVal,
          notes: "",
          pago: false,
          dropLocked: false,
          // Marca origem Service (mesma flag que o fluxo manual grava), para
          // que as funções que dependem de DONO/JOGADOR tratem corretamente.
          ...(wt ? { isService: true } : {}),
        };

        if (ownerUidVal) membersSet.add(ownerUidVal);
        if (visibility === "private" && ownerUidVal) invitedSet.add(ownerUidVal);
      });

      initialMembers = Array.from(membersSet);
      if (visibility === "private") initialInvitedUsers = Array.from(invitedSet);
    }

    const newParty: PartyTab = {
      id,
      name: generatedName,
      slots: initialSlots,
      selectedIds: initialSelectedIds,
      slotData: initialSlotData,
      createdAt: Date.now(),
      LeaderPT: displayUserName,
      leaderUid: currentUser.uid,
      createdByName: displayUserName,
      ptType,
      horarioTimestamp,
      visibility: visibility || "public",
      servidor: servidor || "",
      invitedUsers: initialInvitedUsers,
      members: initialMembers,
      memberSnapshots: {},
      // `ptStartedAt: 0` explícito desde a criação: a query de PTs públicas
      // filtra `ptStartedAt == 0` (pré-Quest) — campo ausente NÃO é casado
      // por queries de igualdade no Firestore. 0 = falsy para toda a UI,
      // que continua tratando "sem início" com o mesmo teste de verdade.
      ptStartedAt: 0,
      // IMPORTANTE: sempre setar `archived: false` explicitamente. A query
      // `where("archived", "==", false)` não encontra documentos onde o campo é undefined.
      archived: false,
    };
    try {
      setIsSyncing(true);
      const cleanParty = JSON.parse(JSON.stringify({
        ...newParty,
        updatedAt: Date.now()
      }));
      await setDoc(doc(db, "parties", id), cleanParty);
      setActivePt(id);
      setMinimized(m => ({ ...m, [id]: false }));

      // ========================================================================
      // NOTIFICAÇÃO "Você foi adicionado a uma PT!"
      // ========================================================================
      // Para cada participante da PT recém-criada (com slotData preenchido via
      // suggestedIds OU adicionados manualmente), dispara a mesma notificação
      // usada pelo addToParty() do PartyPanel. Isto garante que tanto a criação
      // via SuggestPartyModal quanto a adição manual produzem exatamente o mesmo
      // comportamento no destinatário (in-app + desktop).
      // ========================================================================
      if (suggestedIds && suggestedIds.length > 0) {
        const sigla = ptType === "sanguine" ? "SG" : "SW";
        const horarioStr = horarioTimestamp
          ? new Date(horarioTimestamp).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })
          : "horário a combinar";
        const ownerUidsToNotify = new Set<string>();
        Object.values(initialSlotData).forEach(slot => {
          const ownerUid = (slot as any).ownerUid;
          if (ownerUid && ownerUid !== currentUser.uid) {
            ownerUidsToNotify.add(ownerUid);
          }
        });
        ownerUidsToNotify.forEach((ownerUidVal) => {
          const notifId = "notif_" + Date.now() + "_" + Math.random().toString(36).slice(2);
          setDoc(doc(db, "notifications", notifId), {
            id: notifId,
            userId: ownerUidVal,
            senderName: displayUserName,
            type: "pt_added",
            title: "Você foi adicionado a uma PT!",
            body: `${displayUserName} te adicionou na PT "${generatedName}" (${sigla}), ${horarioStr}`,
            partyId: id,
            partyName: generatedName,
            questType: ptType === "sanguine" ? "sanguine" : "soulwar",
            scheduledTime: horarioTimestamp ?? null,
            status: "pending",
            read: false,
            createdAt: Date.now(),
            targetRole: "Normal",
          }).catch(() => {});
        });
      }
    } catch (err) {
      console.error("Erro ao criar PT:", err);
    } finally {
      setIsSyncing(false);
    }
  }

  const updatePartyDebouncedRef = useRef<Record<string, {
    timer: number;
    latest: PartyTab;
  }>>({});
  const pendingQuestCompletedNotificationsRef = useRef<Set<string>>(new Set());
  const pendingScheduleChangedNotificationsRef = useRef<Set<string>>(new Set());

  function getPartyNotificationTargetUids(party: PartyTab): string[] {
    const targetUids = new Set<string>();
    if (party.leaderUid) targetUids.add(party.leaderUid);
    (party.members || []).forEach(uid => { if (uid) targetUids.add(uid); });
    Object.values(party.slotData || {}).forEach((slot: any) => {
      if (slot?.ownerUid) targetUids.add(slot.ownerUid);
      if (slot?.player) {
        const playerUser = allUsers.find(u => u.nome?.toLowerCase() === String(slot.player).toLowerCase());
        if (playerUser?.uid) targetUids.add(playerUser.uid);
      }
    });
    return Array.from(targetUids);
  }

  function getParticipantCharIdsForUid(party: PartyTab, uid: string): string[] {
    return (party.selectedIds || []).filter(charId => {
      const slot = (party.slotData || {})[charId];
      const snap = party.memberSnapshots?.[charId];
      return slot?.ownerUid === uid || snap?.ownerUid === uid;
    });
  }

  async function persistQuestCompletedNotifications(party: PartyTab) {
    if (!db) return;
    const sigla = party.ptType === "sanguine" ? "SG" : "SW";
    await Promise.all(getPartyNotificationTargetUids(party).map(async uid => {
      const notifId = `quest_completed_${party.id}_${uid}`;
      try {
        await setDoc(doc(db, "notifications", notifId), {
          id: notifId,
          userId: uid,
          type: "quest_completed_donation",
          title: "🎉 Quest Concluída! Colabore com o Projeto",
          body: `A PT "${party.name}" para ${sigla} foi concluída. Atualize seus lucros e colabore com o projeto fazendo uma doação em RC!`,
          partyId: party.id,
          partyName: party.name,
          questType: party.ptType,
          status: "pending",
          createdAt: Date.now(),
          participantCharIds: getParticipantCharIdsForUid(party, uid),
          attCharsDone: false,
        }, { merge: true });
      } catch {}
    }));
  }

  async function persistScheduleChangedNotifications(party: PartyTab) {
    if (!db || !party.horarioChangedAt || !party.horarioChangedBy) return;
    const sigla = party.ptType === "sanguine" ? "SG" : "SW";
    const newHorario = party.horarioTimestamp
      ? new Date(party.horarioTimestamp).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })
      : "Sem hora marcada";

    await Promise.all(getPartyNotificationTargetUids(party).map(async uid => {
      const user = allUsers.find(u => u.uid === uid);
      if (user?.nome && user.nome.toLowerCase() === party.horarioChangedBy?.toLowerCase()) return;
      const notifId = `schedule_changed_${party.id}_${party.horarioChangedAt}_${uid}`;
      try {
        await setDoc(doc(db, "notifications", notifId), {
          id: notifId,
          userId: uid,
          type: "schedule_changed",
          title: "⏰ Horário da PT alterado!",
          body: `${party.horarioChangedBy} alterou o horário da PT "${party.name}" (${sigla}) para ${newHorario}.`,
          partyId: party.id,
          partyName: party.name,
          questType: party.ptType === "sanguine" ? "sanguine" : "soulwar",
          scheduledTime: party.horarioTimestamp,
          changedBy: party.horarioChangedBy,
          status: "pending",
          createdAt: Date.now(),
        }, { merge: true });
      } catch {}
    }));
  }
  // Flush imediato: cancela timer e grava a última versão pendente da PT no Firestore
  async function flushPartyToFirestore(partyId: string) {
    const entry = updatePartyDebouncedRef.current[partyId];
    if (!entry) return;
    window.clearTimeout(entry.timer);
    const partyToSave = entry.latest;
    delete updatePartyDebouncedRef.current[partyId];
    if (!currentUser) return;
    const original = cloudParties.find((p) => p.id === partyId);
    const memberUids = new Set<string>();
    const leader = partyToSave.leaderUid || original?.leaderUid || currentUser.uid;
    const isPostQuestSettlement = !!partyToSave.questConcluida && !partyToSave.questFalha;
    if (leader) memberUids.add(leader);
    // Quem grava só entra no roster se for PARTICIPANTE de verdade (líder,
    // já membro, DONO ou JOGADOR de algum slot). Antes o uid do editor era
    // adicionado INCONDICIONALMENTE: um usuário externo que adicionasse um
    // personagem a uma PT pública virava "membro" — e membro mantém acesso
    // depois do início da Quest, exatamente o que a restrição de visibilidade
    // proíbe. O acesso do externo dura apenas enquanto ele adiciona.
    const editorIsParticipant = currentUser.uid === leader
      || (partyToSave.members || []).includes(currentUser.uid)
      || Object.values(partyToSave.slotData || {}).some((slot: any) =>
        slot?.ownerUid === currentUser.uid
        || slot?.playerUid === currentUser.uid
        || (displayUserName && slot?.player && String(slot.player).toLowerCase() === displayUserName.toLowerCase()));
    if (currentUser.uid && editorIsParticipant && (!isPostQuestSettlement || currentUser.uid === leader)) memberUids.add(currentUser.uid);
    (partyToSave.members || []).forEach(uid => { if (uid) memberUids.add(uid); });
    // Antes da Quest, DONOS e JOGADORES entram no roster da PT (auto-reparo:
    // qualquer salvamento cura PTs legadas cujo JOGADOR — p. ex. serviceiro
    // de um Service — nunca foi gravado em `members`, sem o qual ele não vê a
    // PT nem passa pelas Security Rules). Depois da Quest, a Function mantém
    // somente Líder/beneficiários no settlement para encerrar listeners de
    // participantes fora da divisão.
    if (!isPostQuestSettlement) {
      (partyToSave.selectedIds || []).forEach(id => {
        const ch = availableCharactersForParty.find(c => c.id === id) || partyToSave.memberSnapshots?.[id];
        if (ch?.ownerUid) memberUids.add(ch.ownerUid);
      });
      Object.values(partyToSave.slotData || {}).forEach((slot: any) => {
        if (slot?.playerUid) {
          memberUids.add(slot.playerUid);
        } else if (slot?.player) {
          // PT legada sem playerUid materializado: resolve o nome em UID.
          const playerUser = allUsers.find(u => u.nome?.toLowerCase() === String(slot.player).toLowerCase());
          if (playerUser?.uid) memberUids.add(playerUser.uid);
        }
      });
    }
    try {
      setIsSyncing(true);
      const cleanParty = JSON.parse(JSON.stringify({
        ...partyToSave,
        leaderUid: leader,
        createdByName: original?.createdByName || partyToSave.createdByName || displayUserName,
        members: Array.from(memberUids),
        // Normaliza `ptStartedAt` (0 = pré-Quest): PTs legadas gravadas antes
        // desta convenção ganham o campo no primeiro salvamento — sem isso a
        // query de PTs públicas (== 0) não as encontra.
        ptStartedAt: partyToSave.ptStartedAt || 0,
        archived: !!partyToSave.archived, // sempre normalizado para boolean
        updatedAt: Date.now()
      }));

      // A finalização/arquivamento é feita EXCLUSIVAMENTE pelo backend
      // (Cloud Function finalizePartyHistory → partyArchives + histórico
      // privado). O cliente apenas atualiza a PT operacional em "parties".
      await updateDoc(doc(db, "parties", partyId), cleanParty);

      if (pendingQuestCompletedNotificationsRef.current.delete(partyId)) {
        await persistQuestCompletedNotifications(cleanParty);
      }
      const scheduleKey = cleanParty.horarioChangedAt ? `${partyId}_${cleanParty.horarioChangedAt}` : "";
      if (scheduleKey && pendingScheduleChangedNotificationsRef.current.delete(scheduleKey)) {
        await persistScheduleChangedNotifications(cleanParty);
      }

      // 3. Sincroniza cache local com o que de fato foi gravado
      patchPartyInState(cleanParty);
      // Negociações vinculadas aos slots são promovidas para "Quest concluída"
      // com o lucro que pertence ao adquirente, sem tocar no dono original.
      await synchronizeCharacterAcquisitionsForQuest(cleanParty as PartyTab).catch(() => {});

      // 4. AUTO-ATT — espelha drop/lucro em Meus Personagens
      //
      // Fecha a lacuna real do fluxo antigo: a notificação de "Quest
      // Concluída" é ÚNICA e, uma vez processada (`attCharsDone`), nunca mais
      // reprocessa. Valores de drop/venda lançados DEPOIS da conclusão — o
      // caso comum, já que o item costuma ser vendido dias depois — nunca
      // chegavam a Meus Personagens.
      //
      // ── CUSTO EM FIRESTORE: ZERO LEITURAS, ZERO LISTENERS ───────────────
      // Roda sobre `cleanParty`, que já está em memória (acabou de ser
      // gravada), e sobre `data.characters`, também em memória. Não há
      // `getDoc` nem `onSnapshot` novo.
      //
      // O write é absorvido pela infraestrutura que já existe: `setData`
      // alimenta o efeito de `userCharacters`, que tem debounce de 5s e uma
      // guarda de igualdade (`lastSavedUserCharsRef`). Sem diferença real,
      // `applyProfit` devolve `changed: false`, `setData` nem é chamado e
      // nenhum write acontece.
      //
      // Sem risco de loop: o fluxo é unidirecional (PT -> personagem),
      // `userCharacters` não tem listener e nada aqui chama `updateParty`.
      maybeMirrorPartyProfitToCharacters(cleanParty as PartyTab);
      // Transporta o lucro final para o documento sharedCharacters de CADA dono
      // participante (outros usuários), que aplica na própria lista ao carregar.
      syncPartyProfitToOwners(cleanParty as PartyTab);
    } catch (err) {
      console.error("Erro ao atualizar PT:", err);
    } finally {
      setIsSyncing(false);
    }
  }

  /**
   * Espelha drop e lucro da PT em Meus Personagens — só para quem tem
   * Auto-Att ligado.
   *
   * Silencioso e best-effort: é um espelhamento de conveniência, então
   * qualquer falha aqui NÃO pode interromper o salvamento da PT.
   */
  function maybeMirrorPartyProfitToCharacters(party: PartyTab) {
    try {
      // Exclusivo do Auto-Att, como pedido: sem o toggle, nada muda.
      if (!userProfile?.autoCharUpdate) return;
      if (!currentUser?.uid) return;
      const ptType = party.ptType;
      if (ptType !== "soulwar" && ptType !== "sanguine") return;
      // Só faz sentido espelhar o que já foi concluído: uma PT em andamento
      // ainda não tem resultado, e valores intermediários poluiriam o
      // histórico do personagem.
      if (!party.questConcluida || party.questFalha) return;

      setData(current => {
        const result = applyPartyProfitToCharacters(party, current.characters, ptType);
        // `changed: false` => estado intocado => nenhum write.
        if (!result.changed) return current;
        return { ...current, characters: result.characters };
      });
    } catch (err) {
      console.error("Auto-Att: falha ao espelhar drop/lucro em Meus Personagens:", err);
    }
  }

  // ============================================================================
  // AUTO-ATT — TRANSPORTE DE LUCRO VIA sharedCharacters (verdadeiro dono)
  // ----------------------------------------------------------------------------
  // Quando uma PT é FINALIZADA (pagamentoFeito ou arquivada+concluída), o líder
  // calcula o lucro final de cada personagem participante e o grava no
  // documento `sharedCharacters/{ownerUid}` do verdadeiro dono, num campo
  // `partyProfit.{partyId}.{charId}`. Assim, mesmo que o dono não estivesse com
  // o app aberto, ao carregar `sharedCharacters` (no login/refresh) ele aplica
  // o lucro na própria lista "Meus Personagens" e limpa o campo — sem loop e
  // sem write repetido.
  //
  // Reutiliza `computePartyProfitMap` (partyProfit), a MESMA regra canônica de
  // DONO/JOGADOR, DIVIDIR e "sem valor em RC não altera". Firestore limita a
  // escrita cruzada em sharedCharacters/{outro} a `probableMarkers` e
  // `partyProfit` (regra atualizada em Firestore.rules).
  // ============================================================================
  const partyProfitSyncedRef = useRef<Set<string>>(new Set());

  function syncPartyProfitToOwners(party: PartyTab) {
    try {
      if (!userProfile?.autoCharUpdate) return;
      if (!currentUser?.uid || !db) return;
      const finalized = !!party.pagamentoFeito || (!!party.archived && !!party.questConcluida);
      if (!finalized) return;
      if (!party.questConcluida || party.questFalha) return;
      if (!party.id) return;

      const profitMap = computePartyProfitMap(party);
      if (Object.keys(profitMap).length === 0) return;

      // Agrupa charIds por dono (do slot/snapshot da PT — id, não nome).
      const byOwner: Record<string, string[]> = {};
      (party.selectedIds || []).forEach(id => {
        if (!profitMap[id]) return;
        const slot = party.slotData?.[id];
        const snap = party.memberSnapshots?.[id];
        const ownerUid = slot?.ownerUid || snap?.ownerUid;
        if (!ownerUid) return;
        if (ownerUid === currentUser.uid) return; // o próprio já trata localmente
        if (!byOwner[ownerUid]) byOwner[ownerUid] = [];
        byOwner[ownerUid].push(id);
      });

      Object.entries(byOwner).forEach(([ownerUid, charIds]) => {
        const key = `${ownerUid}|${party.id}`;
        if (partyProfitSyncedRef.current.has(key)) return;
        partyProfitSyncedRef.current.add(key);

        const updates: Record<string, any> = {};
        charIds.forEach(id => {
          updates[`partyProfit.${party.id}.${id}.questType`] = profitMap[id].questType;
          updates[`partyProfit.${party.id}.${id}.lucro`] = profitMap[id].lucro;
        });

        updateDoc(doc(db, "sharedCharacters", ownerUid), updates).catch(() => {
          // Documento pode não existir — cria com setDoc (apenas partyProfit).
          const payload: Record<string, any> = {};
          charIds.forEach(id => {
            payload[`partyProfit`] = {
              ...(payload[`partyProfit`] || {}),
              [party.id]: {
                ...(payload[`partyProfit`]?.[party.id] || {}),
                [id]: profitMap[id],
              },
            };
          });
          setDoc(doc(db, "sharedCharacters", ownerUid), payload, { merge: true }).catch(() => {});
        });
      });
    } catch (err) {
      console.error("Auto-Att: falha ao transportar lucro via sharedCharacters:", err);
    }
  }

  // ============================================================================
  // AUTO-ATT — espelha o LUCRO na lista "Meus Personagens" do VERDADEIRO dono
  // ----------------------------------------------------------------------------
  // A notificação de "Quest Concluída" (que espelha drop/lucro em cada dono) é
  // disparada na CONCLUSÃO da Quest, quando o lucro ainda pode não estar final.
  // O valor definitivo só existe em "PAGAMENTO REALIZADO / FINALIZAR PT"
  // (pagamentoFeito). Este efeito roda em CADA dispositivo dono e, ao observar
  // uma PT finalizada de que participa, espelha o lucro final na própria lista.
  //
  // Reutiliza a MESMA função canônica (maybeMirrorPartyProfitToCharacters →
  // applyPartyProfitToCharacters → partyProfit), então DONO/JOGADOR, DIVIDIR e
  // a regra "sem valor em RC não altera" são idênticos aos demais fluxos.
  //
  // Firestore não permite que um usuário escreva em userCharacters/{outroUid}
  // (regra: request.auth.uid == userId). Por isso o espelhamento de cada dono
  // acontece no próprio dispositivo, quando ele enxerga a PT finalizada
  // (cloudParties inclui ativas + arquivadas).
  // ============================================================================
  useEffect(() => {
    if (!userProfile?.autoCharUpdate) return;
    if (!currentUser?.uid) return;

    cloudParties.forEach(pt => {
      if (pt.ptType !== "soulwar" && pt.ptType !== "sanguine") return;
      // Finalizada = pagamento marcado, OU arquivada com Quest concluída.
      const finalized = !!pt.pagamentoFeito || (!!pt.archived && !!pt.questConcluida);
      if (!finalized) return;
      // Só participa quem é dono de ao menos um personagem nesta PT.
      const participates = (pt.selectedIds || []).some(id => {
        const slot = pt.slotData?.[id];
        const snap = pt.memberSnapshots?.[id];
        return slot?.ownerUid === currentUser.uid || snap?.ownerUid === currentUser.uid;
      });
      if (!participates) return;
      maybeMirrorPartyProfitToCharacters(pt);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloudParties, currentUser?.uid, userProfile?.autoCharUpdate]);
  /**
   * Grava UMA PT no Firestore AGORA e devolve se deu certo.
   *
   * Existe para o "Concluir Quest": o snapshot dos participantes precisa estar
   * CONFIRMADO no servidor antes de a Quest ser marcada como concluída. O
   * `updateParty` normal é debounced e fire-and-forget — não serve para uma
   * garantia dessas.
   *
   * Cancela qualquer debounce pendente da mesma PT: o objeto recebido aqui é
   * mais novo, e deixar o timer antigo disparar depois reescreveria por cima.
   */
  async function persistPartyNow(updated: PartyTab): Promise<boolean> {
    if (!currentUser || !db) return false;

    const pending = updatePartyDebouncedRef.current[updated.id];
    if (pending) {
      window.clearTimeout(pending.timer);
      delete updatePartyDebouncedRef.current[updated.id];
    }

    const original = cloudParties.find(p => p.id === updated.id);
    const memberUids = new Set<string>();
    const leader = updated.leaderUid || original?.leaderUid || currentUser.uid;
    const isPostQuestSettlement = !!updated.questConcluida && !updated.questFalha;
    if (leader) memberUids.add(leader);
    if (currentUser.uid && (!isPostQuestSettlement || currentUser.uid === leader)) memberUids.add(currentUser.uid);
    (updated.members || []).forEach(uid => { if (uid) memberUids.add(uid); });
    if (!isPostQuestSettlement) {
      (updated.selectedIds || []).forEach(id => {
        const ch = availableCharactersForParty.find(c => c.id === id) || updated.memberSnapshots?.[id];
        if (ch?.ownerUid) memberUids.add(ch.ownerUid);
      });
    }

    try {
      setIsSyncing(true);
      const cleanParty = JSON.parse(JSON.stringify({
        ...updated,
        leaderUid: leader,
        createdByName: original?.createdByName || updated.createdByName || displayUserName,
        members: Array.from(memberUids),
        archived: !!updated.archived,
        updatedAt: Date.now(),
      }));
      await updateDoc(doc(db, "parties", updated.id), cleanParty);
      patchPartyInState(cleanParty);

      // A conclusão precisa estar confirmada no backend antes de o painel
      // liberar o encerramento. Executamos as mesmas consequências do flush
      // normal, mas sem depender de timer/debounce.
      const questJustCompleted = !!cleanParty.questConcluida && !cleanParty.questFalha && !original?.questConcluida;
      if (questJustCompleted) {
        await persistQuestCompletedNotifications(cleanParty).catch(() => {});
        await synchronizeCharacterAcquisitionsForQuest(cleanParty).catch(() => {});
        maybeMirrorPartyProfitToCharacters(cleanParty);
        syncPartyProfitToOwners(cleanParty);
      }
      return true;
    } catch (err) {
      console.error("Erro ao gravar a PT (snapshot de participantes):", err);
      return false;
    } finally {
      setIsSyncing(false);
    }
  }

  function updateParty(updated: PartyTab) {
    if (!currentUser) return;
    const previous = cloudParties.find(p => p.id === updated.id);
    const shouldPersistQuestNotification = !!updated.questConcluida && !updated.questFalha && !previous?.questConcluida;
    const scheduleKey = updated.horarioChangedAt ? `${updated.id}_${updated.horarioChangedAt}` : "";
    const shouldPersistScheduleNotification = !!scheduleKey && updated.horarioChangedAt !== previous?.horarioChangedAt;

    if (shouldPersistQuestNotification) pendingQuestCompletedNotificationsRef.current.add(updated.id);
    if (shouldPersistScheduleNotification) pendingScheduleChangedNotificationsRef.current.add(scheduleKey);

    // 1) OPTIMISTIC UPDATE: aplica a mudança no estado local IMEDIATAMENTE
    //    para que a UI responda sem aguardar o debounce / round-trip do Firestore.
    patchPartyInState(updated);
    // 2) DEBOUNCE: acumula a versão mais recente e grava após 1s sem novas chamadas.
    const existing = updatePartyDebouncedRef.current[updated.id];
    if (existing) {
      window.clearTimeout(existing.timer);
    }
    const timer = window.setTimeout(() => {
      flushPartyToFirestore(updated.id);
    }, shouldPersistQuestNotification || shouldPersistScheduleNotification ? 0 : 1000);
    updatePartyDebouncedRef.current[updated.id] = { timer, latest: updated };
  }
  // Flush de todos os debounces pendentes antes de sair da página
  useEffect(() => {
    function flushAll() {
      Object.keys(updatePartyDebouncedRef.current).forEach((id) => {
        flushPartyToFirestore(id);
      });
    }
    window.addEventListener("beforeunload", flushAll);
    return () => {
      window.removeEventListener("beforeunload", flushAll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveParty(party: PartyTab) {
    if (!currentUser) return;

    const ptType = party.ptType;
    if (!ptType) return;

    const questField = ptType === "soulwar" ? "soulwar" as const : "sanguine" as const;

    // 1. Atualizar PT no Firestore
    const original = cloudParties.find((cloudParty) => cloudParty.id === party.id);

    const memberUids = new Set<string>();
    const leader = original?.leaderUid || party.leaderUid || currentUser.uid;
    const isPostQuestSettlement = !!party.questConcluida && !party.questFalha;
    if (leader) memberUids.add(leader);
    if (currentUser.uid && (!isPostQuestSettlement || currentUser.uid === leader)) memberUids.add(currentUser.uid);
    (party.members || []).forEach(uid => { if (uid) memberUids.add(uid); });

    if (!isPostQuestSettlement) {
      (party.selectedIds || []).forEach(id => {
        const ch = availableCharactersForParty.find(c => c.id === id) || party.memberSnapshots?.[id];
        if (ch?.ownerUid) memberUids.add(ch.ownerUid);
      });
    }

    try {
      setIsSyncing(true);
      const cleanParty = JSON.parse(JSON.stringify({
        ...party,
        leaderUid: leader,
        createdByName: original?.createdByName || party.createdByName || displayUserName,
        members: Array.from(memberUids),
        updatedAt: Date.now()
      }));
      await updateDoc(doc(db, "parties", party.id), cleanParty);
      patchPartyInState(cleanParty);
    } catch (err) {
      console.error("Erro ao salvar PT:", err);
    } finally {
      setIsSyncing(false);
    }

    // 2. Atualizar personagens LOCALMENTE
    //
    // Usa o MESMO cálculo da guia da PT (`partyProfit`). Antes havia aqui uma
    // terceira variação da regra, com dois problemas:
    //   • `split !== false` / `Math.round`, divergindo da tela;
    //   • gravava `dropValue` mesmo quando 0, ZERANDO o valor já registrado
    //     no personagem sempre que a PT era salva sem venda lançada.
    // `buildCharacterProfitPatch` devolve patch vazio quando nada mudou e
    // nunca sobrescreve um valor preenchido com zero.
    setData(d => ({
      ...d,
      characters: d.characters.map(c => {
        if (!(party.selectedIds || []).includes(c.id)) return c;
        return {
          ...c,
          [questField]: false,
          ...buildCharacterProfitPatch(party, c, ptType),
        };
      }),
    }));
  }
  // ============================================================================
  // Atualizar personagens a partir da notificação "Quest Concluída" (botão Att Chars).
  // DIFERENTE da implementação anterior, esta versão não usa os dados congelados
  // da notificação. Ela localiza a versão mais atual da PT no Firestore (na
  // coleção "parties" ou no arquivo sanitizado "partyArchives" da finalização
  // por backend) para garantir que itens e valores preenchidos após a criação
  // da notificação sejam considerados.
  // ============================================================================
  async function handleUpdateCharactersFromNotification(params: {
    notificationId: string;
    partyId: string;
    questType: "soulwar" | "sanguine";
  }): Promise<boolean> {
    if (!currentUser || !db) return false;
    const { partyId, questType } = params;

    try {
      setIsSyncing(true);

      // 1. Localizar a PT correspondente (Ativa ou Arquivada)
      let ptDoc: PartyTab | null = null;

      try {
        // Tenta primeiro em parties
        const activeSnap = await getDoc(doc(db, "parties", partyId));
        if (activeSnap.exists()) {
          ptDoc = activeSnap.data() as PartyTab;
        }
      } catch (err: any) {
        // Se falhar por permissão, significa que ou não somos participantes da ativa
        // ou ela já foi movida para arquivada e não temos mais acesso à referência antiga.
        // Silenciamos o erro para tentar a coleção de arquivadas.
      }
      if (!ptDoc) {
        try {
          // Arquivo sanitizado criado pela finalização de backend.
          const sanitizedSnap = await getDoc(doc(db, "partyArchives", partyId));
          if (sanitizedSnap.exists()) ptDoc = sanitizedSnap.data() as PartyTab;
        } catch (err) {
          // Falha total na localização
        }
      }

      if (!ptDoc) {
        console.error("PT não encontrada para atualização de personagens:", partyId);
        return false;
      }

      // 2. Extrair dados atuais da PT para o patch
      const questField = questType === "soulwar" ? "soulwar" as const : "sanguine" as const;

      // Identifica quais personagens do usuário logado participaram desta PT
      const myCharIds = (ptDoc.selectedIds || []).filter(id => data.characters.some(c => c.id === id));
      if (myCharIds.length === 0) return true;

      // ── CÁLCULO CANÔNICO DE DROP E LUCRO ────────────────────────────────
      // Antes o valor era recalculado aqui com regras PRÓPRIAS, que divergiam
      // das da guia da PT em dois pontos:
      //   • participantes: `split !== false` (incluía quem nunca marcou)
      //     contra `split === true` na tela;
      //   • arredondamento: `Math.round` contra `floorTo25` na tela.
      // O resultado é que Meus Personagens gravava um lucro que não batia com
      // o exibido na PT. Agora os dois usam `partyProfit`, definição única.
      const applyQuestCompletionPatch = (c: Character): Character => {
        if (!myCharIds.includes(c.id)) return c;
        // A conclusão da Quest continua sendo marcada exatamente como antes.
        const patch: Partial<Character> = { [questField]: false } as Partial<Character>;
        // Drop e lucro só entram quando REALMENTE mudaram; patch vazio deixa o
        // personagem intocado e não gera write.
        Object.assign(patch, buildCharacterProfitPatch(ptDoc as PartyTab, c, questType));
        return { ...c, ...patch };
      };

      // 3. Atualizar localmente
      const updatedChars = data.characters.map(applyQuestCompletionPatch);
      setData(d => ({ ...d, characters: updatedChars }));

      // 4. Persistir no Firestore
      // `updatedChars` pode conter campos opcionais do Character com valor
      // `undefined` (ex: ownerUid/ownerName herdados de snapshots legados ou
      // campos opcionais de drop/notes). O Firestore rejeita `undefined` em
      // qualquer profundidade. Seguimos o mesmo padrão já usado no restante do
      // projeto: serializar/deserializar o payload para omitir apenas os campos
      // realmente ausentes, preservando todos os dados válidos.
      const cleanUserCharactersPayload = JSON.parse(JSON.stringify({
        ownerUid: currentUser.uid,
        ownerName: displayUserName,
        characters: updatedChars,
        updatedAt: Date.now(),
      }));
      await setDoc(doc(db, "userCharacters", currentUser.uid), cleanUserCharactersPayload);

      return true;
    } catch (err) {
      console.error("Erro ao atualizar personagens via notificação:", err);
      return false;
    } finally {
      setIsSyncing(false);
    }
  }

  async function deleteParty(id: string) {
    if (!currentUser) return;
    customConfirm("Excluir esta PT permanentemente?", async () => {
      // Optimistic update local: remove de TODAS as listas imediatamente
      setCloudPartiesActive(prev => prev.filter(p => p.id !== id));
      removePartyFromPublic(id);
      // Cancela qualquer debounce pendente desta PT
      const entry = updatePartyDebouncedRef.current[id];
      if (entry) {
        window.clearTimeout(entry.timer);
        delete updatePartyDebouncedRef.current[id];
      }
      try {
        setIsSyncing(true);
        await deleteDoc(doc(db, "parties", id));
      } catch {
      } finally {
        setIsSyncing(false);
      }
    });
  }

  function toggleWindow(key: WindowKey) { setActiveWindow((w) => (w === key ? null : key)); }

  function openAdd() {
    setCharacterModalMode("create");
    setEditing(null);
    setModalOpen(true);
  }
  function openEdit(c: Character) {
    setCharacterModalMode("edit");
    setEditing(c);
    setModalOpen(true);
  }

  /**
   * Inclui um personagem comprado diretamente a partir do Bazaar.
   *
   * Mantém os mesmos valores padrão que o antigo rascunho do CharacterModal,
   * mas recebe Conta e Valor Pago já validados pelo formulário inline. A lista
   * é atualizada pelo mesmo `setData` usado pelo modal normal, preservando o
   * autosave local, a sincronização de `userCharacters`, o compartilhamento e
   * todas as estatísticas que dependem de `data.characters`.
   */
  function addCharacterFromBazaar(purchase: BazaarCharacterPurchase): BazaarCharacterPurchaseResult {
    if (!currentUser?.uid) return { ok: false, error: "Entre na sua conta para adicionar um personagem." };

    const account = String(purchase.account || "").trim();
    const personagem = String(purchase.name || "").trim();
    const servidor = String(purchase.server || "").trim();
    const voc = mapBazaarVocationToCharacterVocation(String(purchase.vocation || ""));
    const level = Math.floor(Number(purchase.level));
    const valorPago = Number(purchase.valorPago);

    if (!account) return { ok: false, error: "Informe a conta do personagem." };
    if (account.length > 40) return { ok: false, error: "A conta pode ter no máximo 40 caracteres." };
    if (!personagem || !servidor || !voc || !Number.isFinite(level) || level <= 0) {
      return { ok: false, error: "Os dados importados do Bazaar estão incompletos ou inválidos." };
    }
    if (!Number.isSafeInteger(valorPago) || valorPago < 0) {
      return { ok: false, error: "Informe um valor pago válido." };
    }

    const comparableName = normalizeBazaarCharacterNameForCompare(personagem);
    if (data.characters.some(character => normalizeBazaarCharacterNameForCompare(character.personagem) === comparableName)) {
      return { ok: false, error: "Este personagem já está na sua lista." };
    }

    const now = Date.now();
    const character: Character = {
      id: createLocalCharacterId(),
      account,
      personagem,
      servidor,
      voc,
      level,
      // Mantém os padrões do fluxo anterior do Bazaar. As quests continuam
      // disponíveis até que os fluxos próprios da aplicação as atualizem.
      soulwar: true,
      sanguine: true,
      valorPago,
      dropSW: 0,
      dropBakra: 0,
      valorVenda: 0,
      vendido: false,
      aVenda: false,
      shared: true,
      dataCompra: todayIsoDate(),
      dataVenda: "",
      ownerUid: currentUser.uid,
      ownerName: displayUserName,
      createdAt: now,
      updatedAt: now,
    };

    // A verificação se repete dentro do updater para evitar duplicação caso o
    // usuário dispare duas confirmações antes de a tabela renderizar novamente.
    setData(current => {
      const alreadyExists = current.characters.some(item =>
        normalizeBazaarCharacterNameForCompare(item.personagem) === comparableName,
      );
      if (alreadyExists) return current;
      return { ...current, characters: [...current.characters, character] };
    });

    return { ok: true };
  }

  /**
   * O DONO original pré-aprova a venda usando apenas os participantes reais do
   * slot da PT. O JOGADOR jamais informa ou altera preço, taxa ou vendedor.
   */
  async function createCharacterAcquisitionFromParty(input: {
    partyId: string;
    characterId: string;
    originalCharacterCost: number;
    personalFee: 0 | 25 | 50;
  }): Promise<{ ok: boolean; error?: string }> {
    if (!currentUser?.uid) return { ok: false, error: "Entre na sua conta para pré-aprovar a venda." };
    const party = cloudParties.find(item => item.id === input.partyId);
    if (!party || party.archived || party.questConcluida || party.questFalha) {
      return { ok: false, error: "A PT não está disponível para pré-aprovar esta venda." };
    }
    const slot = party.slotData?.[input.characterId];
    const sourceCharacter = availableCharactersForParty.find(character => character.id === input.characterId) || party.memberSnapshots?.[input.characterId];
    if (!slot || slot.isService || !sourceCharacter || !slot.ownerUid) {
      return { ok: false, error: "Este membro não é um personagem elegível para negociação." };
    }
    // A pré-aprovação é uma ação exclusiva do DONO, sem exceção por líder/Boss.
    if (currentUser.uid !== slot.ownerUid) {
      return { ok: false, error: "Somente o dono original pode pré-aprovar a venda deste personagem." };
    }
    const acquirer = allUsers.find(user => user.status === "aprovado" && user.nome.toLowerCase() === String(slot.player || "").trim().toLowerCase());
    const seller = allUsers.find(user => user.uid === slot.ownerUid) || userProfile;
    if (!acquirer?.uid || acquirer.uid === slot.ownerUid) {
      return { ok: false, error: "A pré-aprovação exige um JOGADOR aprovado diferente do DONO original." };
    }
    if (!seller?.mainCharacterName?.trim() || !acquirer.mainCharacterName?.trim()) {
      return { ok: false, error: "Dono e jogador precisam possuir Main Character cadastrado para esta negociação." };
    }

    const result = await createCharacterAcquisition({
      partyId: party.id,
      partyName: party.name,
      characterId: input.characterId,
      characterName: sourceCharacter.personagem,
      server: sourceCharacter.servidor,
      vocation: sourceCharacter.voc,
      level: sourceCharacter.level,
      originalOwnerUid: slot.ownerUid,
      originalOwnerName: slot.owner || sourceCharacter.ownerName || seller.nome || "Dono original",
      sellerMainCharacterName: seller.mainCharacterName,
      acquirerUid: acquirer.uid,
      acquirerName: acquirer.nome,
      buyerMainCharacterName: acquirer.mainCharacterName,
      originalCharacterCost: input.originalCharacterCost,
      personalFee: input.personalFee,
      bazaarFee: 50,
      actorUid: currentUser.uid,
      actorName: displayUserName,
      actorRole: userProfile?.role,
    });
    if (!result.ok || !result.record) return result;

    setPendingCharacterAcquisitions(previous => previous.some(item => item.id === result.record!.id) ? previous : [result.record!, ...previous]);
    // Pré-aprovação NÃO transfere direitos financeiros nem altera o slot. O
    // vínculo no slot só é gravado após o JOGADOR confirmar o pagamento.
    return result;
  }

  /** O JOGADOR confirma o pagamento ao Main Character do vendedor. */
  async function confirmCharacterAcquisitionPaymentFromParty(acquisitionId: string): Promise<{ ok: boolean; error?: string }> {
    if (!currentUser?.uid) return { ok: false, error: "Entre na sua conta para confirmar o pagamento." };
    const result = await confirmCharacterAcquisitionPayment(acquisitionId, currentUser.uid);
    if (result.ok && result.record) {
      // O registro deixa o conjunto pendente e passa a compor a fonte
      // confirmada da guia/Stats imediatamente, antes do snapshot chegar.
      setPendingCharacterAcquisitions(previous => previous.filter(record => record.id !== result.record!.id));
      setCharacterAcquisitions(previous => previous.some(record => record.id === result.record!.id)
        ? previous.map(record => record.id === result.record!.id ? result.record! : record)
        : [result.record!, ...previous]);
      const party = cloudParties.find(item => item.id === result.record!.partyId);
      const slot = party?.slotData?.[result.record.characterId];
      if (party && slot) {
        // Só agora a aquisição é efetivada na PT: direitos da Quest/divisão e
        // venda futura passam ao adquirente, sem mudar o DONO original.
        const patchedParty: PartyTab = {
          ...party,
          slotData: {
            ...(party.slotData || {}),
            [result.record.characterId]: {
              ...slot,
              characterAcquisitionId: result.record.id,
              financialRightsHolderUid: result.record.acquirerUid,
              financialRightsHolderName: result.record.acquirerName,
              playerUid: result.record.acquirerUid,
              splitTarget: "player",
              splitTargetName: result.record.acquirerName,
              splitBeneficiaryUid: result.record.acquirerUid,
            },
          },
        };
        // NOVA REGRA — aceite após Quest concluída (PT ainda não finalizada):
        // as Security Rules de `parties` só permitem update pós-Quest para
        // Líder/Boss. Se o comprador comum tentasse gravar a PT aqui, a
        // escrita inteira seria negada e os direitos financeiros do slot
        // nunca chegariam ao servidor. Nesse cenário o slot é materializado
        // pela Cloud Function `materializeAcquisitionAcceptance` (disparada
        // pela transição pre_approved → payment_confirmed, que o próprio
        // comprador acabou de gravar com validação das Rules); o cliente
        // aplica apenas o patch otimista local para resposta imediata da UI.
        // Pré-Quest (ou Líder/Boss) o comportamento permanece o de sempre.
        const canPersistPartyDirectly = !party.questConcluida
          || party.leaderUid === currentUser.uid
          || userProfile?.role === "Boss";
        if (canPersistPartyDirectly) {
          updateParty(patchedParty);
        } else {
          patchPartyInState(patchedParty);
        }
      }
    }
    return result;
  }

  /** O dono original confirma o segundo pagamento: repasse da venda ao comprador. */
  async function confirmCharacterAcquisitionSalePayoutFromNegotiations(acquisitionId: string): Promise<{ ok: boolean; error?: string }> {
    if (!currentUser?.uid) return { ok: false, error: "Entre na sua conta para confirmar o repasse." };
    let acquisition = characterAcquisitions.find(record => record.id === acquisitionId);
    if (!acquisition) return { ok: false, error: "Negociação não encontrada." };
    if (acquisition.originalOwnerUid !== currentUser.uid) return { ok: false, error: "Somente o dono original pode realizar este pagamento." };

    // O Character permanece a fonte oficial. Antes de abrir a confirmação final,
    // garantimos que o espelho compartilhado tenha exatamente esse mesmo valor.
    const originalCharacter = data.characters.find(character => character.id === acquisition!.characterId);
    const officialSaleValue = originalCharacter?.valorVenda;
    if (!originalCharacter?.vendido || typeof officialSaleValue !== "number" || !Number.isSafeInteger(officialSaleValue) || officialSaleValue <= 0) {
      return { ok: false, error: "Salve primeiro um valor de venda válido no personagem original." };
    }
    if (acquisition.status !== "sold") {
      return { ok: false, error: "O personagem ainda não foi marcado como vendido no fluxo da negociação." };
    }
    if (acquisition.saleValue !== officialSaleValue) {
      const publication = await updateCharacterAcquisitionLifecycle(acquisition.id, {
        status: "sold",
        saleValue: officialSaleValue,
        markSoldAt: !acquisition.soldAt,
      }, currentUser.uid);
      if (!publication.ok || !publication.record) return publication;
      acquisition = publication.record;
      setCharacterAcquisitions(previous => previous.map(record => record.id === acquisition!.id ? acquisition! : record));
    }

    const result = await confirmCharacterAcquisitionSalePayout(acquisition.id, currentUser.uid);
    if (result.ok && result.record) {
      setCharacterAcquisitions(previous => previous.map(record => record.id === result.record!.id ? result.record! : record));
    }
    return result;
  }

  /**
   * Atualiza o ciclo compartilhado da negociação e os detalhes privados da
   * Quest. Apenas o adquirente grava drops/lucro no documento privado dele.
   */
  async function synchronizeCharacterAcquisitionsForQuest(party: PartyTab) {
    if (!currentUser?.uid || !party.questConcluida || party.questFalha || (party.ptType !== "soulwar" && party.ptType !== "sanguine")) return;
    const completedQuestType = party.ptType as PtType;
    // Inclui vendas históricas para que o comprador que abriu o app depois da
    // Quest ainda importe seu Drop/Lucro privado da PT, sem listeners extras.
    const records = characterAcquisitions.filter(record => record.partyId === party.id && isPaymentConfirmed(record));
    await Promise.all(records.map(async record => {
      const slot = party.slotData?.[record.characterId];
      if (!slot) return;

      // Uma venda já concluída não pode voltar de estado. Os dados privados do
      // adquirente, porém, continuam podendo ser preenchidos idempotentemente.
      if (record.status !== "sold") {
        const currentStatus = record.status === "created" ? "payment_confirmed" : record.status;
        const nextStatus = currentStatus === "for_sale" ? "for_sale" : "quest_completed";
        if (currentStatus !== nextStatus || record.questType !== completedQuestType || !record.questCompletedAt) {
          await updateCharacterAcquisitionLifecycle(record.id, {
            status: nextStatus,
            questType: completedQuestType,
            markQuestCompletedAt: !record.questCompletedAt,
          }, currentUser.uid);
        }
      }

      // Privacidade: nenhum drop/lucro é gravado no documento compartilhado.
      // A fonte prioritária é o slot da PT; para PTs históricas o serviço usa o
      // snapshot do personagem como fallback. As fontes `buyer` tornam a
      // edição do adquirente definitiva: futuras sincronizações da PT não a
      // sobrescrevem. Registros antigos com valor preenchido são migrados de
      // modo conservador para `buyer`.
      if (currentUser.uid === record.acquirerUid) {
        const importedQuestProfit = calculateAcquiredQuestProfit(party, record.characterId);
        const importedQuestDrops = calculateAcquiredQuestDrops(party, record.characterId);
        const currentDetails = characterAcquisitionBuyerDetails.find(details => details.acquisitionId === record.id);
        const sameQuest = currentDetails?.questType === completedQuestType;
        const buyerDrop = sameQuest && (
          currentDetails?.questDropsSource === "buyer"
          || (currentDetails?.questDropsSource === undefined && !!currentDetails?.questDrops?.length)
        );
        const buyerProfit = sameQuest && (
          currentDetails?.questProfitSource === "buyer"
          || (currentDetails?.questProfitSource === undefined && (currentDetails?.questProfit || 0) > 0)
        );
        const questDrops = buyerDrop ? (currentDetails?.questDrops || []) : importedQuestDrops;
        const questProfit = buyerProfit ? (currentDetails?.questProfit || 0) : importedQuestProfit;
        const questDropsSource = buyerDrop ? "buyer" as const : "pt" as const;
        const questProfitSource = buyerProfit ? "buyer" as const : "pt" as const;
        const detailsChanged = !currentDetails
          || currentDetails.questType !== completedQuestType
          || JSON.stringify(currentDetails.questDrops || []) !== JSON.stringify(questDrops)
          || currentDetails.questProfit !== questProfit
          || currentDetails.questDropsSource !== questDropsSource
          || currentDetails.questProfitSource !== questProfitSource
          || !currentDetails.questCompletedAt;
        if (detailsChanged) {
          await upsertCharacterAcquisitionBuyerDetails({
            acquisitionId: record.id,
            acquirerUid: record.acquirerUid,
            questType: completedQuestType,
            questDrops,
            questDropsSource,
            questProfit,
            questProfitSource,
            questCompletedAt: currentDetails?.questCompletedAt || record.questCompletedAt,
          });
        }
      }
    }));
  }

  /** Atualiza o Drop Quest no mesmo documento privado usado pelas colunas SW/SG. */
  async function updateCharacterAcquisitionQuestDrop(input: { acquisitionId: string; questDrop: string }): Promise<{ ok: boolean; error?: string }> {
    if (!currentUser?.uid) return { ok: false, error: "Entre na sua conta para atualizar o Drop Quest." };
    const record = characterAcquisitions.find(item => item.id === input.acquisitionId);
    if (!record || record.acquirerUid !== currentUser.uid) {
      return { ok: false, error: "Somente o adquirente pode alterar o Drop Quest desta negociação." };
    }
    const currentDetails = characterAcquisitionBuyerDetails.find(item => item.acquisitionId === input.acquisitionId);
    const questType = currentDetails?.questType || record.questType;
    if (questType !== "soulwar" && questType !== "sanguine") {
      return { ok: false, error: "A Quest deste personagem ainda não foi identificada." };
    }
    const legacyBuyerProfit = currentDetails?.questProfitSource === undefined && (currentDetails?.questProfit || 0) > 0;
    const result = await upsertCharacterAcquisitionBuyerDetails({
      acquisitionId: record.id,
      acquirerUid: currentUser.uid,
      questType,
      questDrops: input.questDrop ? [input.questDrop] : [],
      questDropsSource: "buyer",
      questProfit: currentDetails?.questProfit || 0,
      questProfitSource: currentDetails?.questProfitSource === "buyer" || legacyBuyerProfit ? "buyer" : "pt",
      questCompletedAt: currentDetails?.questCompletedAt || record.questCompletedAt,
    });
    if (result.ok && result.record) {
      setCharacterAcquisitionBuyerDetails(previous => {
        const exists = previous.some(item => item.acquisitionId === result.record!.acquisitionId);
        return exists
          ? previous.map(item => item.acquisitionId === result.record!.acquisitionId ? result.record! : item)
          : [...previous, result.record!];
      });
    }
    return result;
  }

  /** Lucro Quest é editável apenas pelo adquirente depois da Quest concluída. */
  async function updateCharacterAcquisitionQuestProfit(input: { acquisitionId: string; questProfit: number }): Promise<{ ok: boolean; error?: string }> {
    if (!currentUser?.uid) return { ok: false, error: "Entre na sua conta para atualizar o Lucro Quest." };
    const value = Number(input.questProfit);
    if (!Number.isSafeInteger(value) || value < 0) return { ok: false, error: "Informe um Lucro Quest inteiro e não negativo." };
    const record = characterAcquisitions.find(item => item.id === input.acquisitionId);
    if (!record || record.acquirerUid !== currentUser.uid) {
      return { ok: false, error: "Somente o adquirente pode alterar o Lucro Quest desta negociação." };
    }
    const currentDetails = characterAcquisitionBuyerDetails.find(item => item.acquisitionId === input.acquisitionId);
    const questType = currentDetails?.questType || record.questType;
    if (questType !== "soulwar" && questType !== "sanguine") {
      return { ok: false, error: "A Quest deste personagem ainda não foi identificada." };
    }
    const legacyBuyerDrop = currentDetails?.questDropsSource === undefined && !!currentDetails?.questDrops?.length;
    const result = await upsertCharacterAcquisitionBuyerDetails({
      acquisitionId: record.id,
      acquirerUid: currentUser.uid,
      questType,
      questDrops: currentDetails?.questDrops || [],
      questDropsSource: currentDetails?.questDropsSource === "buyer" || legacyBuyerDrop ? "buyer" : "pt",
      questProfit: value,
      questProfitSource: "buyer",
      questCompletedAt: currentDetails?.questCompletedAt || record.questCompletedAt,
    });
    if (result.ok && result.record) {
      setCharacterAcquisitionBuyerDetails(previous => {
        const exists = previous.some(item => item.acquisitionId === result.record!.acquisitionId);
        return exists
          ? previous.map(item => item.acquisitionId === result.record!.acquisitionId ? result.record! : item)
          : [...previous, result.record!];
      });
    }
    return result;
  }

  async function handleSave(c: Character) {
    let acquisition = currentUser?.uid
      ? characterAcquisitions.find(record => record.originalOwnerUid === currentUser.uid && record.characterId === c.id)
      : undefined;
    // O listener é a fonte normal. Esta leitura pontual só cobre a corrida rara
    // em que o dono reinicia o app e tenta vender antes do primeiro snapshot.
    if (!acquisition && currentUser?.uid) {
      acquisition = await getCharacterAcquisition(currentUser.uid, c.id) || undefined;
      if (acquisition) {
        setCharacterAcquisitions(previous => previous.some(record => record.id === acquisition!.id) ? previous : [acquisition!, ...previous]);
      }
    }

    if (acquisition && isPaymentConfirmed(acquisition)) {
      // Defesa no write: mesmo que um payload seja manipulado fora da UI, o
      // vendedor não consegue gravar Drop/Lucro que pertencem ao comprador.
      const currentCharacter = data.characters.find(character => character.id === c.id);
      if (currentCharacter) {
        c = {
          ...c,
          itemDropadoSW: currentCharacter.itemDropadoSW,
          itemDropadoSG: currentCharacter.itemDropadoSG,
          dropSW: currentCharacter.dropSW,
          dropBakra: currentCharacter.dropBakra,
        };
      }
    }

    if (acquisition) {
      let questReadyForSale = ["quest_completed", "for_sale", "sold"].includes(acquisition.status);
      // NOVA REGRA — venda liberada pela CONCLUSÃO DA QUEST, não pela
      // finalização da PT: a condição que controla "Colocado à Venda"/
      // "Vendido" em Meus Personagens é `party.questConcluida`. O status da
      // negociação é promovido para `quest_completed` de forma assíncrona
      // (Cloud Function reconcileQuestCompletion + sincronizações do
      // cliente); se o dono tentar vender antes de a promoção refletir no
      // snapshot dele, verificamos a PT diretamente e promovemos AQUI, na
      // hora — pela MESMA transição já validada pelo serviço e pelas Rules
      // (payment_confirmed/created → quest_completed, somente participantes).
      // PT finalizada continua coberta: o arquivo `partyArchives` preserva
      // `questConcluida` e serve de fallback quando a PT operacional já saiu
      // de `parties`. Quest em andamento ou negociação ainda não paga
      // (pre_approved) seguem bloqueadas como antes.
      if (!questReadyForSale && (c.aVenda || c.vendido) && isPaymentConfirmed(acquisition)) {
        let acquisitionParty = cloudParties.find(item => item.id === acquisition!.partyId);
        if (!acquisitionParty && !isSimulation && db) {
          try {
            const active = await getDoc(doc(db, "parties", acquisition.partyId));
            if (active.exists()) acquisitionParty = { id: active.id, ...active.data() } as PartyTab;
            if (!acquisitionParty) {
              const sanitizedArchive = await getDoc(doc(db, "partyArchives", acquisition.partyId));
              if (sanitizedArchive.exists()) acquisitionParty = { id: sanitizedArchive.id, ...sanitizedArchive.data(), archived: true } as PartyTab;
            }
          } catch (error) {
            console.error("Erro ao verificar a conclusão da Quest da PT para liberar a venda:", error);
          }
        }
        if (
          acquisitionParty?.questConcluida
          && !acquisitionParty.questFalha
          && (acquisitionParty.ptType === "soulwar" || acquisitionParty.ptType === "sanguine")
        ) {
          const promotion = await updateCharacterAcquisitionLifecycle(acquisition.id, {
            status: "quest_completed",
            questType: acquisitionParty.ptType as PtType,
            markQuestCompletedAt: !acquisition.questCompletedAt,
          }, currentUser?.uid);
          if (promotion.ok && promotion.record) {
            acquisition = promotion.record;
            setCharacterAcquisitions(previous => previous.some(record => record.id === promotion.record!.id)
              ? previous.map(record => record.id === promotion.record!.id ? promotion.record! : record)
              : [promotion.record!, ...previous]);
            questReadyForSale = true;
          } else {
            customAlert(promotion.error || "Não foi possível sincronizar a conclusão da Quest da negociação. Tente novamente.", "Venda não sincronizada");
            return;
          }
        }
      }
      if ((c.aVenda || c.vendido) && !questReadyForSale) {
        if (acquisition.status === "pre_approved") {
          customAlert("Aguarde o comprador aceitar a compra e confirmar o pagamento antes de colocar este personagem negociado à venda.", "Negociação pendente");
        } else {
          customAlert("Conclua a Quest antes de colocar este personagem negociado à venda no Bazaar.", "Quest pendente");
        }
        return;
      }
      if (acquisition.status === "sold" && !c.vendido) {
        customAlert("Uma negociação vendida não pode voltar para disponível ou à venda.", "Venda protegida");
        return;
      }

      if (c.vendido) {
        // `Character.valorVenda` é a única fonte oficial. Não arredondamos nem
        // substituímos o valor informado pelo CharacterModal por outro cálculo.
        const saleValue = c.valorVenda;
        if (!Number.isSafeInteger(saleValue) || saleValue <= 0) {
          customAlert("Informe um valor de venda válido para direcioná-lo ao usuário adquirente.", "Valor da venda obrigatório");
          return;
        }

        const previousCharacter = data.characters.find(character => character.id === c.id);
        if (acquisition.salePayoutStatus === "confirmed" && previousCharacter && saleValue !== previousCharacter.valorVenda) {
          customAlert("O valor da venda não pode ser alterado depois que o repasse ao comprador foi confirmado.", "Repasse concluído");
          return;
        }

        const nextCharacters = data.characters.some(character => character.id === c.id)
          ? data.characters.map(character => character.id === c.id ? c : character)
          : [...data.characters, c];
        const publicationNeeded = acquisition.status !== "sold" || acquisition.saleValue !== saleValue;

        // Primeiro persiste a fonte oficial do valor; somente depois publica o
        // espelho compartilhado que o comprador observa em tempo real.
        const characterSaved = await persistUserCharactersNow(nextCharacters);
        if (!characterSaved) {
          customAlert("Não foi possível salvar o valor oficial do personagem no Firestore. Tente novamente.", "Venda não salva");
          return;
        }

        if (publicationNeeded) {
          const publication = await updateCharacterAcquisitionLifecycle(acquisition.id, {
            status: "sold",
            saleValue,
            markSoldAt: !acquisition.soldAt,
          }, currentUser?.uid);
          if (!publication.ok || !publication.record) {
            // Não deixamos um Character vendido com valor publicado de forma
            // incompleta. A restauração é best-effort e o erro fica explícito.
            const rollbackOk = await persistUserCharactersNow(data.characters);
            customAlert(`${publication.error || "Não foi possível publicar a venda."}${rollbackOk ? " O personagem foi restaurado." : " Não foi possível restaurar automaticamente o personagem; revise a conexão."}`, "Venda não sincronizada");
            return;
          }
          acquisition = publication.record;
          setCharacterAcquisitions(previous => previous.map(record => record.id === publication.record!.id ? publication.record! : record));
        }

        setData(current => ({ ...current, characters: nextCharacters }));
        setModalOpen(false);
        return;
      }

      if (c.aVenda) {
        if (acquisition.status !== "for_sale") {
          const listing = await updateCharacterAcquisitionLifecycle(acquisition.id, { status: "for_sale", markListedAt: !acquisition.listedAt }, currentUser?.uid);
          if (!listing.ok || !listing.record) {
            customAlert(listing.error || "Não foi possível atualizar o status de venda da negociação.", "Venda não sincronizada");
            return;
          }
          setCharacterAcquisitions(previous => previous.map(record => record.id === listing.record!.id ? listing.record! : record));
        }
      } else if (acquisition.status === "for_sale") {
        const unlist = await updateCharacterAcquisitionLifecycle(acquisition.id, { status: "quest_completed" }, currentUser?.uid);
        if (!unlist.ok || !unlist.record) {
          customAlert(unlist.error || "Não foi possível remover o personagem da venda.", "Venda não sincronizada");
          return;
        }
        setCharacterAcquisitions(previous => previous.map(record => record.id === unlist.record!.id ? unlist.record! : record));
      }
    }

    setData((d) => {
      const exists = d.characters.some((x) => x.id === c.id);
      const characters = exists ? d.characters.map((x) => (x.id === c.id ? c : x)) : [...d.characters, c];
      return { ...d, characters };
    });
    setModalOpen(false);
  }

  function openNegotiatedCharacterForEdit(characterId: string) {
    const character = data.characters.find(item => item.id === characterId);
    if (!character) {
      customAlert("O personagem original não está disponível na sua lista local para edição.", "Personagem não encontrado");
      return;
    }
    openEdit(character);
  }

  function handleDelete(id: string) {
    customConfirm("Deseja realmente excluir este personagem?", () => {
      setData((d) => ({ ...d, characters: d.characters.filter((c) => c.id !== id) }));
    });
  }

  function handleNotes(notes: string) { setData((d) => ({ ...d, notes })); }

  // ============================================================================
  // FIRESTORE WRITE OPERATIONS - Waiting List
  // ============================================================================
  async function handleAddWaiting(item: WaitingService) {
    if (!currentUser) return;
    try {
      setIsSyncing(true);
      await setDoc(doc(db, "waitingList", item.id), {
        ...item,
        createdBy: currentUser.uid,
        createdByName: displayUserName,
        createdAt: item.createdAt || Date.now(),
        updatedAt: serverTimestamp()
      });
    } catch {
    } finally {
      setIsSyncing(false);
    }
  }

  async function handleUpdateWaiting(item: WaitingService) {
    if (!currentUser) return;
    const original = cloudWaitingList.find((waitingItem) => waitingItem.id === item.id);
    // A Lista de Espera é carregada por getDocs() (leitura pontual), e não por
    // onSnapshot. Sem atualizar o estado local, a edição só aparecia ao trocar
    // de aba, que é quando ocorre uma nova leitura.
    //
    // UPDATE OTIMISTA: aplica a alteração no estado imediatamente e mantém o
    // cache local coerente. Em caso de erro, reverte para o valor anterior —
    // sem nenhuma leitura extra no Firestore.
    const merged: WaitingService = {
      ...item,
      createdBy: original?.createdBy || currentUser.uid,
      createdByName: original?.createdByName || item.createdByName || displayUserName,
    };
    const applyLocal = (next: WaitingService) => {
      setCloudWaitingList(prev => {
        const updated = prev.map(w => (w.id === next.id ? next : w));
        try {
          localStorage.setItem("cloud_cache_waitingList", JSON.stringify(updated));
        } catch {}
        return updated;
      });
    };
    applyLocal(merged);
    try {
      setIsSyncing(true);
      await updateDoc(doc(db, "waitingList", item.id), {
        ...merged,
        updatedAt: serverTimestamp()
      });
    } catch (err) {
      console.error("Erro ao atualizar service na Lista de Espera:", err);
      if (original) applyLocal(original); // rollback
      customAlert("Não foi possível salvar a edição. Verifique sua conexão e tente novamente.");
    } finally {
      setIsSyncing(false);
    }
  }

  async function handleDeleteWaiting(id: string) {
    if (!currentUser) return;
    // Mesmo motivo do update: sem onSnapshot, a remoção só apareceria na
    // próxima leitura. Reflete no estado local na hora.
    const removed = cloudWaitingList.find(w => w.id === id);
    setCloudWaitingList(prev => {
      const updated = prev.filter(w => w.id !== id);
      try {
        localStorage.setItem("cloud_cache_waitingList", JSON.stringify(updated));
      } catch {}
      return updated;
    });
    try {
      setIsSyncing(true);
      await deleteDoc(doc(db, "waitingList", id));
    } catch {
      // Restaura o item se a exclusão falhar.
      if (removed) {
        setCloudWaitingList(prev => {
          if (prev.some(w => w.id === id)) return prev;
          const updated = [...prev, removed];
          try {
            localStorage.setItem("cloud_cache_waitingList", JSON.stringify(updated));
          } catch {}
          return updated;
        });
      }
    } finally {
      setIsSyncing(false);
    }
  }

  function handleToggleShare(id: string, shared: boolean) {
    setData(d => ({
      ...d,
      characters: d.characters.map(c => c.id === id ? { ...c, shared } : c),
    }));
  }

  function handleToggleShareAll(shared: boolean, visibleIds: string[]) {
    setData(d => ({
      ...d,
      characters: d.characters.map(c => visibleIds.includes(c.id) ? { ...c, shared } : c),
    }));
  }

  function handleNoteChange(id: string, notes: string) {
    setData(d => ({
      ...d,
      characters: d.characters.map(c => c.id === id ? { ...c, notes } : c),
    }));
  }

  function handleCharacterInlineChange(updated: Character) {
    // O dono original mantém o Character, mas Drop/Lucro da Quest transferida
    // pertencem ao adquirente. A guarda protege também contra chamadas fora da UI.
    if (negotiatedOriginalCharacterIds.has(updated.id)) return;
    setData(d => ({
      ...d,
      characters: d.characters.map(c => c.id === updated.id ? updated : c),
    }));
  }

  async function handleImport(file: File) {
    try {
      const imported = await importJSON(file);
      // Restaura APENAS dados pessoais: personagens e anotações. Lista de
      // Espera e PT's são ignoradas de propósito, pois são sincronizadas
      // continuamente pelo Firestore — importá-las poderia sobrescrever o
      // estado sincronizado. O histórico de PT's vive no Firestore privado
      // (users/{uid}/partyHistory) e não faz parte do backup local.
      const { characters, notes } = normalizeImportedBackup(imported);
      customConfirm(`Importar ${characters.length} personagem(s) e suas anotações? Isto substituirá seus personagens e anotações atuais. (PT's, histórico e Lista de Espera continuam vindo da nuvem.)`, () => {
        setData(prev => ({ ...prev, characters, notes }));
      });
    } catch { customAlert("Arquivo JSON inválido."); }
  }

  async function configureAutoSave() {
    let filePath: string | null = null;
    let handle: any = null;

    if (isElectron) {
      const { ipcRenderer } = (window as any).require("electron");
      filePath = await ipcRenderer.invoke("configure-autosave", `${autoSaveFileName}.json`);
      handle = filePath;
    } else if ((window as any).showSaveFilePicker) {
      try {
        handle = await (window as any).showSaveFilePicker({
          suggestedName: `${autoSaveFileName}.json`,
          types: [{ description: "JSON", accept: { "application/json": [".json"] } }],
        });
        filePath = handle;
      } catch (error) {
        if ((error as Error)?.name !== "AbortError") { console.error("Auto-Save falhou", error); updateAutoSaveStatus("error"); }
        return;
      }
    } else {
      updateAutoSaveStatus("error");
      customAlert("Seu ambiente atual não suporta seleção automática de arquivo.");
      return;
    }

    if (!handle) return;
    setAutoSaveHandle(handle);
    let fileName = "";
    if (isElectron && filePath) {
      const path = (window as any).require("path");
      fileName = path.basename(filePath);
      // Salvar caminho absoluto para abrir pasta no Electron
      if (currentUser?.uid) localStorage.setItem(`tibia_autosave_path_${currentUser.uid}`, filePath);
    } else {
      fileName = handle.name || "";
    }
    updateAutoSaveName(fileName);
    saveAutoSaveHandle(handle);

    await writeAutoSaveFile(handle, data);
  }

  // Set imutável dos UIDs de amigos aceitos — construído uma única vez
  // quando a lista muda (alimentada pelo AuthContext via onSnapshot).
  // Usado para lookup O(1) na filtragem de visibilidade de personagens.
  const acceptedFriendSet = useMemo(
    () => buildAcceptedFriendSet(acceptedFriendUids),
    [acceptedFriendUids]
  );

  // ============================================================================
  // REQUISITO OBRIGATÓRIO: EXCEÇÃO DAS PTs EXISTENTES
  // Extrai os IDs de todos os personagens e services que já fazem parte de PTs
  // (ativas ou arquivadas). Se uma entidade já está em uma PT, ela NUNCA
  // poderá desaparecer da interface de qualquer usuário com acesso àquela PT.
  // ============================================================================
  const exceptionEntityIds = useMemo(() => {
    const ids = new Set<string>();
    cloudParties.forEach(p => {
      (p.selectedIds || []).forEach(id => { if (id) ids.add(id); });
      (p.customMembers || []).forEach(cm => { if (cm?.id) ids.add(cm.id); });
    });
    return ids;
  }, [cloudParties]);

  // ============================================================================
  // FONTE ÚNICA DE PERSONAGENS DISPONÍVEIS PARA A APLICAÇÃO
  // ============================================================================
  // Combina personagens próprios (ativos) + compartilhados, e aplica a regra
  // central de visibilidade de amigos + a EXCEÇÃO de PTs existentes (Etapa 1 & 4)
  // via `filterVisibleEntitiesWithException`. A deduplicação por id permanece.
  // Abastece PartyManager, PartyPanel, OverviewPanel, AvailableCharacter e SuggestPartyModal.
  // ============================================================================
  const availableCharactersForParty = useMemo(() => {
    const viewerUid = currentUser?.uid || "";
    // Normaliza os personagens locais garantindo ownerUid e ownerName preenchidos
    const normalizedLocal: Character[] = ativos.map(c => ({
      ...c,
      ownerUid: c.ownerUid || viewerUid,
      ownerName: c.ownerName || displayUserName
    }));
    // Remove compartilhados que duplicam personagens locais (mesmo id)
    const sharedFiltered: Character[] = sharedCharacters.filter(sc =>
      !normalizedLocal.some(lc => lc.id === sc.id)
    );
    const combined: Character[] = [...normalizedLocal, ...sharedFiltered];
    const visible = filterVisibleEntitiesWithException(combined, viewerUid, acceptedFriendSet, exceptionEntityIds);
    // Aplicar probableMarkers: se probableMarkers[charId].soulwar == true,
    // tratar como soulwar = false (indisponível para SoulWar). Mesmo para sanguine.
    // NÃO altera os campos reais — apenas a disponibilidade para uso em PTs.
    return visible.map(c => {
      const markers = probableMarkers[c.id];
      if (!markers) return c;
      const overridden = { ...c };
      if (markers.soulwar) overridden.soulwar = false;
      if (markers.sanguine) overridden.sanguine = false;
      return overridden;
    });
  }, [ativos, sharedCharacters, currentUser, displayUserName, acceptedFriendSet, exceptionEntityIds, probableMarkers]);

  // ============================================================================
  // FONTE ÚNICA DE SERVICES DA FILA DE ESPERA PARA A APLICAÇÃO
  // ============================================================================
  // A Lista de Espera (Services) é um recurso PÚBLICO/compartilhado: todos os
  // usuários aprovados devem visualizá-la integralmente. Diferente dos
  // personagens compartilhados (sharedCharacters), os Services NÃO passam
  // pelo filtro de amizade (friendshipAccess), pois:
  //   - Registros do PublicServiceForm possuem `createdBy` de um UID anônimo
  //     (signInAnonymously), que nunca corresponde a nenhum usuário real.
  //   - A visibilidade do WhatsApp e a permissão de uso em PTs já são
  //     controladas individualmente pelo WaitingListPanel (canUseServiceInPT).
  // Abastece a fila enviada para montagem e convite de PTs no PartyManager.
  // ============================================================================
  /**
   * FONTE OFICIAL DOS PERSONAGENS DE SERVICE PARA AS PTs.
   *
   * `sharedServices` passa a alimentar a ServiceList e, através dela, todos os
   * consumidores (OverviewPanel, PartyPanel, PartyManager, FriendsSummaryModal,
   * SuggestPartyModal, ServerGraphic e BazarPanel).
   *
   * A Lista de Espera legada continua entrando na mesma lista enquanto a
   * migração não termina — os registros antigos seguem utilizáveis. A união é
   * deduplicada por id, com `sharedServices` tendo prioridade.
   *
   * A visibilidade por Serviceiro é aplicada aqui com a MESMA função já usada
   * pela Lista de Espera (`canViewServiceEntry`), preservando as regras atuais.
   *
   * A aba Services (WaitingListPanel) NÃO consome esta lista: ela continua
   * lendo `cloudWaitingListForDisplay`, portanto permanece inalterada.
   */
  const availableWaitingListForParty = useMemo(() => {
    const viewer = {
      viewerUid: currentUser?.uid || "",
      viewerName: displayUserName,
      isBoss: isBossUser,
      friendUids: new Set(acceptedFriendUids || []),
    };

    const byId = new Map<string, WaitingService>();

    // sharedServices: dono, Boss e AMIGOS do dono enxergam.
    sharedServicesList.forEach(item => {
      if (!canViewServiceForViewer(item, viewer)) return;
      // SERVICE PROVAVELMENTE JÁ REALIZADO: participou de uma PT cuja Quest
      // foi concluída. Sai de circulação para montagem de PT exatamente como
      // um personagem com `probableMarkers` deixa de ter a Quest disponível.
      //
      // O marcador é o MESMO mecanismo de "Meus Personagens": chaveado pelo id
      // da entidade em `sharedCharacters/{dono}.probableMarkers`. Para um
      // Service, o id do slot é o próprio `service.id` e o `ownerUid` é o
      // Serviceiro, então `writeProbableMarkers` já o grava sem alteração.
      if (isServiceProbablyDone(item, probableMarkers)) return;
      // Projeção segura: WhatsApp só sai para o dono e para o Boss.
      byId.set(item.id, projectServiceForViewer(item, viewer));
    });

    // Lista de Espera: "Qualquer um" fica visível a todos os aprovados; os
    // designados continuam restritos ao Serviceiro. Entradas "realizado" estão
    // ENTREGUES e saem de circulação para todos — igual a um SharedService
    // realizado, não devem mais aparecer para montar PTs.
    cloudWaitingList.forEach(item => {
      if (byId.has(item.id)) return;
      if (item.status === "realizado") return;
      if (!canViewServiceForViewer(item, viewer)) return;
      byId.set(item.id, projectServiceForViewer({
        ...item,
        createdByName: resolveLeaderName(item.createdBy, item.createdByName),
        LeaderPT: resolveLeaderName(item.createdBy, item.createdByName),
      } as WaitingService, viewer));
    });

    return Array.from(byId.values());
  }, [sharedServicesList, cloudWaitingList, displayUserName, isBossUser, currentUser?.uid, acceptedFriendUids, probableMarkers]);

  // Carga inicial de `sharedServices`: UMA leitura por sessão, disparada
  // quando o usuário aprovado entra. Sem listener — o refresh manual e as
  // gravações otimistas de "Meus Services" cobrem as atualizações.
  const sharedServicesLoadedRef = useRef("");
  useEffect(() => {
    if (!currentUser?.uid || userProfile?.status !== "aprovado") return;
    if (isSimulation || !db) return;
    // Recarrega quando a lista de amigos muda: um novo amigo pode ter
    // Services que agora ficaram visíveis.
    const signature = `${currentUser.uid}|${(acceptedFriendUids || []).slice().sort().join(",")}`;
    if (sharedServicesLoadedRef.current === signature) return;
    sharedServicesLoadedRef.current = signature;

    // Só os documentos que as regras permitem ler: o próprio e os dos amigos.
    const readableUids = [currentUser.uid, ...(acceptedFriendUids || [])];

    let cancelled = false;
    fetchAllSharedServicesAsWaiting(readableUids)
      .then(result => {
        if (cancelled || result.error) return;
        setSharedServicesList(result.items);
      })
      .catch(() => {});

    return () => { cancelled = true; };
  }, [currentUser?.uid, userProfile?.status, isSimulation, acceptedFriendUids]);

  async function refreshWaitingListFromCloud(): Promise<void> {
    if (!db) return;
    const waitingSnap = await getDocs(collection(db, "waitingList"));
    const waiting = waitingSnap.docs.map(d => ({ id: d.id, ...d.data() } as WaitingService));
    setCloudWaitingList(waiting);
    try {
      localStorage.setItem("cloud_cache_waitingList", JSON.stringify(waiting));
    } catch {}
  }

  /**
   * Projeção otimista do próprio Serviceiro após o write confirmado. Evita uma
   * releitura do documento que ele acabou de gravar e atualiza imediatamente
   * PartyPanel, ServiceList e os demais consumidores desta sessão.
   */
  function handleOwnSharedServicesChanged(services: SharedService[]) {
    const uid = currentUser?.uid || "";
    if (!uid) return;
    setSharedServicesList(replaceOwnerSharedServicesInWaitingCache(uid, services));
  }

  /** Recarrega `sharedServices` (fonte oficial dos Services). */
  async function refreshSharedServicesFromCloud(): Promise<void> {
    const readableUids = [currentUser?.uid || "", ...(acceptedFriendUids || [])];
    const result = await fetchAllSharedServicesAsWaiting(readableUids);
    if (!result.error) setSharedServicesList(result.items);
  }

  // Função de refresh manual (botão "Atualizar" em AvailableCharacter):
  // força a releitura de sharedCharacters (ignorando o TTL) e da waitingList.
  async function handleRefreshCharacters(): Promise<void> {
    try {
      // Invalida o cache de compartilhados e força nova leitura (bypass TTL)
      invalidateSharedCharsCache();
      await Promise.all([
        fetchSharedCharacters(true), // force = true (ignora TTL)
        refreshWaitingListFromCloud(),
        refreshSharedServicesFromCloud(),
      ]);
    } catch {}
  }

  // ============================================================================
  // BOSS PENDING COUNTS - Contagem de pendências para o botão de alerta
  // Os contadores só são usados no botão "Boss" do rodapé — usuários não-Boss
  // não precisam destes listeners (economia de reads em donations + notifications).
  // ============================================================================
  useEffect(() => {
    if (!currentUser || !userProfile || userProfile.status !== "aprovado") return;
    if (isIdleMode) return;
    if (userProfile.role !== "Boss") {
      setPendingDonationsCount(0);
      setPendingRequestsCount(0);
      setPendingVipCount(0);
      return;
    }

    // Enquanto o BossAdminPanel está aberto, ele próprio mantém os listeners
    // administrativos detalhados. Pausamos os listeners de badge do App para
    // evitar duplicação sobre donations, notifications e vipCreditRequests.
    if (adminOpen) return;

    const bossBadgesMode = globalSettings.bossBadgesMode || "realtime";

    if (bossBadgesMode === "manual") {
      setPendingDonationsCount(0);
      setPendingRequestsCount(0);
      setPendingVipCount(0);
      return;
    }

    if (isSimulation || !db) {
      const checkLocal = () => {
        try {
          const rawDonations = localStorage.getItem("chernobyl_donations");
          const donations = rawDonations ? JSON.parse(rawDonations) : [];
          setPendingDonationsCount(Array.isArray(donations) ? donations.filter((d: any) => d.status === "pendente").length : 0);

          // Notificações do Boss em modo simulação: ler as notificações não ignoradas
          const rawNotifs = localStorage.getItem("tibia_sim_notifications");
          if (rawNotifs) {
            try {
              const notifs = JSON.parse(rawNotifs);
              const activeCount = Array.isArray(notifs) ? notifs.filter((n: any) => n.targetRole === "Boss" && n.status === "unread" && !n.ignored).length : 0;
              setPendingRequestsCount(activeCount);
            } catch { setPendingRequestsCount(0); }
          } else {
            setPendingRequestsCount(0);
          }

          // VIP — modo simulação
          try {
            const rawVip = localStorage.getItem("tibia_vip_requests_sim");
            if (rawVip) {
              const vipReqs = JSON.parse(rawVip);
              setPendingVipCount(Array.isArray(vipReqs) ? vipReqs.filter((r: any) => r.status === "pendente").length : 0);
              } else {
                setPendingVipCount(0);
                }
              } catch { setPendingVipCount(0); }

        } catch {}
      };

      checkLocal();
      window.addEventListener("storage", checkLocal);
      return () => window.removeEventListener("storage", checkLocal);
    }

    if (bossBadgesMode === "economy") {
      let cancelled = false;

      const fetchBossBadgeCounts = async () => {
        try {
          const [donationsSnap, bossNotifsSnap, vipSnap] = await Promise.all([
            getDocs(collection(db, "donations")),
            getDocs(query(collection(db, "notifications"), where("targetRole", "==", "Boss"))),
            getDocs(query(collection(db, "vipCreditRequests"), where("status", "==", "pendente"))),
          ]);
          if (cancelled) return;

          let donationsCount = 0;
          donationsSnap.docs.forEach(d => { if (d.data().status === "pendente") donationsCount++; });

          let requestsCount = 0;
          bossNotifsSnap.docs.forEach(d => {
            const data = d.data();
            if (!data.ignored && (data.status === "unread" || data.status === undefined)) requestsCount++;
          });

          setPendingDonationsCount(donationsCount);
          setPendingRequestsCount(requestsCount);
          setPendingVipCount(vipSnap.size);
        } catch {
          if (!cancelled) {
            setPendingDonationsCount(0);
            setPendingRequestsCount(0);
            setPendingVipCount(0);
          }
        }
      };

      fetchBossBadgeCounts();
      const interval = window.setInterval(fetchBossBadgeCounts, 300000);
      return () => {
        cancelled = true;
        window.clearInterval(interval);
      };
    }

    const unsubDonations = onSnapshot(collection(db, "donations"), (snap) => {
      let count = 0;
      snap.docs.forEach(d => {
        if (d.data().status === "pendente") count++;
      });
      setPendingDonationsCount(count);
    }, () => {});

    const unsubBossNotifs = onSnapshot(
      query(collection(db, "notifications"), where("targetRole", "==", "Boss")),
      (snap) => {
        let count = 0;
        snap.docs.forEach(d => {
          const data = d.data();
          if (!data.ignored && (data.status === "unread" || data.status === undefined)) count++;
        });
        setPendingRequestsCount(count);
      },
      () => {}
    );

    //listener VIP
    const unsubVip = onSnapshot(
      query(collection(db, "vipCreditRequests"), where("status", "==", "pendente")),
      (snap) => { setPendingVipCount(snap.size); },
      () => { setPendingVipCount(0); }
    );


    return () => {
      unsubDonations();
      unsubBossNotifs();
      unsubVip();
    };
  }, [currentUser?.uid, userProfile?.status, userProfile?.role, isSimulation, adminOpen, globalSettings.bossBadgesMode, isIdleMode]);

  const pendingUsersCount = useMemo(() => {
    return (allUsers || []).filter(u => u.status === "pendente").length;
  }, [allUsers]);

  const totalPendingBossActions = pendingUsersCount + pendingDonationsCount + pendingRequestsCount + pendingVipCount;

  const topContent = (
    <div className="flex flex-col h-full w-full bg-[var(--th-bg-base)]">
      <div className="flex flex-wrap items-center justify-between gap-1 px-1.5 flex-shrink-0 border-b border-[var(--th-line)]/80 bg-gradient-to-r from-[var(--th-bg-raised)] to-[var(--th-bg-base)] overflow-x-auto" style={{ minHeight: "clamp(12px, 1.67vh, 16px)", padding: "clamp(1.33px, 0.23vh, 2px) clamp(2px, 0.33vw, 3.33px)", zoom: `${headerZoomLevel}%` }}>
        <div className="flex items-center gap-0.5 sm:gap-1">
          <span className="font-bold uppercase tracking-wider text-amber-600/80 mr-0.5 select-none whitespace-nowrap" style={{ fontSize: "clamp(8px, 1.3vh, 10px)" }}>PRIVADO:</span>
          <button
            onClick={(e) => openTooltip('privado', e)}
            className="p-1 rounded border border-amber-700/25 bg-amber-950/10 hover:bg-amber-600/15 transition-all cursor-pointer animate-pulse"
            title="Informações sobre as abas privadas"
          >
            <HelpCircle size={12} className="text-amber-500 drop-shadow-[0_0_6px_color-mix(in_oklab,var(--color-amber-500)_35%,transparent)]" />
          </button>
          {activeTooltip === 'privado' && (
            <HubHelpTooltip type="privado" tooltipRef={tooltipRef} position={tooltipPos} />
          )}
          <div className="flex gap-1.5 bg-[var(--th-bg-base)] px-1.5 py-1 rounded-xl border border-[var(--th-brand)]/60">
            <TabButton active={tab === "ativos"} icon={<Swords size={11} />} label="Meus Personagens" count={charsView === "vendidos" ? vendidos.length : ativos.length} onClick={() => setTab("ativos")} variant="darkgreen" padlock="private" />
            <TabButton active={tab === "meus_services"} icon={<Briefcase size={11} />} label="Meus Services" count={myServicesCount} onClick={() => setTab("meus_services")} variant="sky" padlock="private" />
            <TabButton active={tab === "meu_historico"} icon={<HistoryIcon size={11} />} label="Meu Histórico de PT's" count={personalPartyHistory.length} onClick={() => setTab("meu_historico")} variant="orange" padlock="private" />
          </div>
        </div>

        <div className="flex items-center gap-0.5 sm:gap-1">
          <span className="font-bold uppercase tracking-wider text-amber-600/80 mr-0.5 select-none whitespace-nowrap" style={{ fontSize: "clamp(8px, 1.3vh, 10px)" }}>PÚBLICO:</span>
          <button
            onClick={(e) => openTooltip('publico', e)}
            className="p-1 rounded border border-amber-700/25 bg-amber-950/10 hover:bg-red-900/20 transition-all cursor-pointer animate-pulse"
            title="Informações sobre as abas públicas"
          >
            <HelpCircle size={12} className="text-amber-500 drop-shadow-[0_0_6px_color-mix(in_oklab,var(--color-amber-500)_35%,transparent)]" />
          </button>
          {activeTooltip === 'publico' && (
            <HubHelpTooltip type="publico" tooltipRef={tooltipRef} position={tooltipPos} />
          )}
          <div className="flex gap-1.5 bg-[var(--th-bg-base)] px-1.5 py-1 rounded-xl border border-[var(--th-brand)]/60">
            <TabButton active={tab === "pts"} icon={<Users size={11} />} label="Gerenciador de PT's" count={activeParties.length} onClick={() => setTab("pts")} variant="darkgreen" padlock="public" />
            {/* Exclusivo do Boss. Renderização condicional (sem wrapper
                vazio), então o layout se ajusta sozinho para os demais. */}
            {isBossUser && (
              <TabButton active={tab === "waitlist"} icon={<Clock size={11} />} label="Services" count={waitingQueueCount} onClick={() => setTab("waitlist")} variant="sky" padlock="public" />
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex flex-col overflow-hidden" style={{ zoom: `${contentZoomLevel}%` }}>
        {tab === "ativos" ? (
          <div className="p-0.3 flex-1 min-h-0 overflow-hidden flex flex-col">
            {/* Alternância DISPONÍVEIS / VENDIDOS — substitui a antiga aba
                "Histórico Meus Personagens". Só troca qual tabela é exibida;
                ambas continuam sendo o mesmo componente CharTable de antes. */}
            <div className="flex items-center gap-1.5 px-1 pb-1 flex-shrink-0">
              <button
                type="button"
                onClick={() => setCharsView("disponiveis")}
                aria-pressed={charsView === "disponiveis"}
                className={`nav-pill nav-pill--action inline-flex items-center gap-1 px-3 py-1 text-[10px] cursor-pointer whitespace-nowrap`}
                data-active={charsView === "disponiveis"}
                style={{ ["--pill-accent" as string]: "var(--color-emerald-500)" }}
                title="Exibir personagens disponíveis"
              >
                <Swords size={11} /> DISPONÍVEIS
                <span className="font-bold font-mono">({ativos.length})</span>
              </button>
              <button
                type="button"
                onClick={() => setCharsView("vendidos")}
                aria-pressed={charsView === "vendidos"}
                className={`nav-pill nav-pill--action inline-flex items-center gap-1 px-3 py-1 text-[10px] cursor-pointer whitespace-nowrap`}
                data-active={charsView === "vendidos"}
                style={{ ["--pill-accent" as string]: "var(--color-amber-500)" }}
                title="Exibir personagens vendidos (histórico)"
              >
                <HistoryIcon size={11} /> VENDIDOS
                <span className="font-bold font-mono">({vendidos.length})</span>
              </button>
              <button
                type="button"
                onClick={() => setCharsView("adquiridos")}
                aria-pressed={charsView === "adquiridos"}
                className={`nav-pill nav-pill--action inline-flex items-center gap-1 px-3 py-1 text-[10px] cursor-pointer whitespace-nowrap`}
                data-active={charsView === "adquiridos"}
                style={{ ["--pill-accent" as string]: "var(--color-violet-500)" }}
                title="Exibir negociados entre usuários"
              >
                <Briefcase size={11} /> NEGOCIADOS ENTRE USUÁRIOS
                <span className="font-bold font-mono">({characterAcquisitions.length})</span>
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-hidden">
              {charsView === "disponiveis" ? (
                <CharTable key="chars-active" characters={ativos} activeParties={activeParties} onAdd={openAdd} onEdit={openEdit} onDelete={handleDelete} onToggleShare={handleToggleShare} onToggleShareAll={handleToggleShareAll} onNoteChange={handleNoteChange} onCharacterInlineChange={handleCharacterInlineChange} probableMarkers={probableMarkers} negotiatedCharacterIds={negotiatedOriginalCharacterIds} lockedQuestFinancialIds={negotiatedOriginalCharacterIds} />
              ) : charsView === "vendidos" ? (
                <CharTable key="chars-history" characters={vendidos} showSaleDate onEdit={openEdit} onDelete={handleDelete} onNoteChange={handleNoteChange} onCharacterInlineChange={handleCharacterInlineChange} negotiatedCharacterIds={negotiatedOriginalCharacterIds} lockedQuestFinancialIds={negotiatedOriginalCharacterIds} />
              ) : (
                <AcquiredCharactersPanel
                  acquisitions={characterAcquisitions}
                  buyerDetails={characterAcquisitionBuyerDetails}
                  originalCharacters={data.characters}
                  currentUserUid={currentUser?.uid || ""}
                  onEditOriginalCharacter={openNegotiatedCharacterForEdit}
                  onConfirmSalePayout={confirmCharacterAcquisitionSalePayoutFromNegotiations}
                  onUpdateQuestDrop={async input => {
                    const result = await updateCharacterAcquisitionQuestDrop(input);
                    if (!result.ok) customAlert(result.error || "Não foi possível atualizar o Drop Quest.", "Drop Quest");
                    return result;
                  }}
                  onUpdateQuestProfit={async input => {
                    const result = await updateCharacterAcquisitionQuestProfit(input);
                    if (!result.ok) customAlert(result.error || "Não foi possível atualizar o Lucro Quest.", "Lucro Quest");
                    return result;
                  }}
                />
              )}
            </div>
          </div>
        ) : tab === "meus_services" ? (
          <MyServicesPanel
            onCountChange={setMyServicesCount}
            onServicesChanged={handleOwnSharedServicesChanged}
            probableMarkers={probableMarkers}
          />
        ) : tab === "pts" ? (
          <PartyManager
            parties={activeParties}
            characters={availableCharactersForParty}
            waitingList={availableWaitingListForParty}
            userName={displayUserName}
            onUpdate={updateParty}
            onDelete={deleteParty}
            onCreate={createParty}
            onSaveParty={saveParty}
            onPersistPartyNow={persistPartyNow}
            activePt={activePt}
            setActivePt={setActivePt}
            minimized={minimized}
            setMinimized={setMinimized}
            onNotifyMembers={() => {
              // A notificação persistente de "Quest Concluída" é criada no fluxo
              // de updateParty quando questConcluida muda para true. Mantido apenas
              // para compatibilidade com a assinatura do PartyManager/PartyPanel.
            }}
            onRequestFinalization={handleRequestPartyFinalization}
            onPaymentMarked={(_info) => {
              // A notificação de pagamento agora é tratada de forma reativa
              // pelo hook useNotifications ao detectar a mudança no Firestore.
              // Isso garante que apenas o DONO (ownerUid) receba a mensagem,
              // independente de quem clicou no botão.
            }}
            onRefresh={handleRefreshCharacters}
            characterAcquisitions={partyCharacterAcquisitions}
            onCreateCharacterAcquisition={createCharacterAcquisitionFromParty}
            onConfirmCharacterAcquisitionPayment={confirmCharacterAcquisitionPaymentFromParty}
            publicPartiesEnabled={globalSettings.publicPartiesEnabled}
            onTabChange={() => {
              // Ao abrir a aba "Gerenciador de PT's": carrega PTs públicas e personagens
              // compartilhados sob demanda. fetchSharedCharacters respeita o
              // TTL — só faz leitura no Firestore se o cache estiver expirado.
              fetchPublicParties();
              fetchSharedCharacters();
              void refreshSharedServicesFromCloud();
            }}
          />
        ) : tab === "meu_historico" ? (
          <div className="flex h-full min-h-0 flex-col gap-2">
            <div className="min-h-0 flex-1">
              {/* Único histórico oficial: projeção privada users/{uid}/partyHistory,
                  materializada pelo backend na conclusão/finalização da PT. */}
              <PersonalPartyHistoryList
                entries={personalPartyHistory}
                uid={currentUser?.uid}
                userName={displayUserName}
                readOnly={isSimulation || !db}
                highlightedPartyId={highlightedHistoryPartyId}
                onClearHighlight={clearHistoryHighlight}
              />
            </div>
          </div>
        ) : tab === "waitlist" && isBossUser ? (
          <WaitingListPanel items={cloudWaitingListForDisplay} onAdd={handleAddWaiting} onUpdate={handleUpdateWaiting} onDelete={handleDeleteWaiting} userName={displayUserName} highlightId={highlightedWaitingServiceId} />
        ) : null}
      </div>
    </div>
  );

  if (authLoading) {
    return (
      <div className="h-screen w-screen flex flex-col items-center justify-center bg-[var(--th-bg-abyss)] text-slate-200">
        <ExoriLogo size={80} className="drop-shadow-[0_0_15px_color-mix(in_oklab,var(--color-red-600)_70%,transparent)] animate-pulse" />
        <span className="text-xs text-slate-550 mt-4">Carregando perfil de acesso...</span>
      </div>
    );
  }

  if (!currentUser || !userProfile || userProfile.status !== "aprovado") {
    return <AuthModal />;
  }

  const idleModeOverlay = (isIdleMode || isIdleRestoring) ? (
    <div className="app-modal-overlay fixed inset-0 z-[9999] flex items-center justify-center bg-black/85 backdrop-blur-md">
      <div className="app-modal-frame app-modal-size-sm w-full max-w-md overflow-y-auto rounded-2xl border border-[var(--th-line)]/80 bg-gradient-to-b from-[var(--th-bg-raised)] to-[var(--th-bg-deep)] shadow-[0_0_45px_color-mix(in_oklab,var(--th-brand)_35%,transparent)] p-4 sm:p-6 text-center space-y-5">
        <div className="mx-auto w-14 h-14 rounded-2xl border border-amber-500/30 bg-amber-500/10 flex items-center justify-center">
          <Clock size={28} className={`text-amber-300 ${isIdleRestoring ? "animate-spin" : ""}`} />
        </div>
        <div className="space-y-2">
          <h2 className="text-lg font-black text-white tracking-wide">{isIdleRestoring ? "Reativando sistema..." : "Sistema pausado por inatividade"}</h2>
          <p className="text-sm text-slate-400 leading-relaxed">
            {isIdleRestoring
              ? "Estamos restaurando a sincronização e os recursos do aplicativo. Aguarde alguns instantes."
              : "Pausamos temporariamente sincronizações não críticas para reduzir o consumo de recursos enquanto o aplicativo não está sendo utilizado."}
          </p>
        </div>
        <div className="flex flex-col sm:flex-row gap-3 justify-center pt-2">
          <button
            type="button"
            onClick={() => { handleSignOut().catch(() => {}); }}
            className="px-5 py-2.5 rounded-xl border border-rose-500/40 bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 text-sm font-black transition-colors cursor-pointer"
          >
            Desconectar
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <div className="h-[100dvh] max-h-[100dvh] w-screen flex flex-col bg-[var(--th-bg-deep)] text-slate-200 overflow-hidden app-safe-shell font-sans select-none relative">
      {idleModeOverlay}
      {/* Background animado com gradientes */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-[30%] -left-[20%] w-[70%] h-[70%] rounded-full bg-red-900/5 blur-[120px] animate-pulse" style={{ animationDuration: '8s' }} />
        <div className="absolute -bottom-[30%] -right-[20%] w-[70%] h-[70%] rounded-full bg-red-950/5 blur-[120px] animate-pulse" style={{ animationDuration: '10s', animationDelay: '2s' }} />
        <div className="absolute top-[40%] left-[30%] w-[40%] h-[40%] rounded-full bg-amber-900/3 blur-[100px] animate-pulse" style={{ animationDuration: '12s', animationDelay: '4s' }} />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-transparent via-[var(--th-bg-deep)]/50 to-[var(--th-bg-deep)]" />
      </div>

      <header ref={appHeaderRef} className="flex items-center justify-between gap-1 px-1.5 sm:px-3 bg-[var(--th-bg-raised)]/95 backdrop-blur-md border-b border-[var(--th-line)]/60 flex-shrink-0 relative z-20" style={{ minHeight: "clamp(12.67px, 2vh, 17.33px)", padding: "clamp(1.33px, 0.27vh, 2.67px) clamp(2.67px, 0.33vw, 4px)", zoom: `${headerZoomLevel}%` }}>
        {/* ESQUERDA: Logo + Painel */}
        <div className="flex items-center gap-1.5 sm:gap-3 min-w-0 flex-1">
          <div className="flex items-center gap-1.5 sm:gap-4 min-w-0">
            <div className="flex items-center justify-center flex-shrink-0 relative group" style={{ width: "clamp(28px, 5vh, 40px)", height: "clamp(28px, 5vh, 40px)" }}>
              <ExoriLogo size={28} onClick={() => setNotificationOpen(v => !v)} notificationCount={pendingCount} isNotificationOpen={notificationOpen} className="drop-shadow-[0_0_8px_color-mix(in_oklab,var(--color-red-600)_55%,transparent)] group-hover:drop-shadow-[0_0_14px_color-mix(in_oklab,var(--color-red-600)_85%,transparent)] transition-all" />
            </div>
            <div className="min-w-0">
              <h1 className="font-bold tracking-tight truncate bg-gradient-to-r from-red-600 via-orange-500 to-yellow-400 bg-clip-text text-transparent" style={{ fontSize: "clamp(11px, 1.8vh, 15px)", filter: "drop-shadow(0 0 4px color-mix(in oklab, var(--color-red-600) 55%, transparent)) drop-shadow(0 0 8px color-mix(in oklab, var(--color-red-600) 35%, transparent))" }}>Chernobyl PT</h1>
              <p className="text-emerald-400 leading-none tracking-wide truncate" style={{ fontSize: "clamp(6px, 0.9vh, 8px)" }}>By Exori Coins</p>
            </div>
          </div>
          <div className="hidden lg:flex items-center gap-1.5 flex-shrink-0">
            <span className="uppercase tracking-widest text-slate-500 mr-0.5 whitespace-nowrap" style={{ fontSize: "clamp(8px, 1.3vh, 10px)" }}></span>
            <WindowToggle active={activeWindow === "characters"} icon={<Swords size={11} />} label="Hub Principal" onClick={() => toggleWindow("characters")} hero />
            <WindowToggle active={activeWindow === "stats"} icon={<BarChart3 size={11} />} label="Stats" onClick={() => toggleWindow("stats")} />
            <WindowToggle active={activeWindow === "ranking"} icon={<Trophy size={11} />} label="Ranking" onClick={() => toggleWindow("ranking")} />
            <WindowToggle active={activeWindow === "notes"} icon={<StickyNote size={11} />} label="Notas" onClick={() => toggleWindow("notes")} />
            <WindowToggle active={activeWindow === "bazar"} icon={<ShoppingBag size={11} />} label="Bazaar" onClick={() => toggleWindow("bazar")} hero />
          </div>
        </div>
        {/* CENTRO: Notificações pendentes */}
        <div className="flex-1 flex justify-center">
          {pendingCount > 0 && (
            <button
              type="button"
              onClick={() => setNotificationOpen(true)}
              className={`group inline-flex items-center gap-2.5 px-4 py-1.5 rounded-full bg-gradient-to-r from-red-600/20 via-red-500/25 to-orange-500/20 border border-red-500/40 hover:border-red-400/70 hover:from-red-600/30 hover:to-orange-500/30 transition-all duration-300 cursor-pointer shadow-lg shadow-red-500/20 hover:shadow-red-500/35 hover:scale-[1.03] active:scale-[0.98] relative overflow-hidden ${!lowCpuUsage ? "notification-pulse-anim" : ""}`}
              title="Clique para abrir as notificações"
            >
              {/* Glow effect interno */}
              <div className="absolute inset-0 bg-gradient-to-r from-red-500/0 via-red-500/5 to-orange-500/0 group-hover:from-red-500/10 group-hover:via-red-500/10 group-hover:to-orange-500/10 transition-all duration-300" />
              <span className="relative flex items-center justify-center w-6 h-6 rounded-full bg-red-500/30 border border-red-500/50 shadow-inner shadow-red-500/20 group-hover:bg-red-500/40 transition-colors">
                <Bell size={13} className="text-red-300 group-hover:text-white transition-colors" />
              </span>
              <span className="relative flex items-center gap-1.5 text-[11px] font-bold text-red-200 group-hover:text-white transition-colors whitespace-nowrap">
                Você tem
                <span className={`inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-red-500 text-white font-mono font-black text-[10px] shadow-md shadow-red-500/40 ${!lowCpuUsage ? "animate-pulse" : ""}`}>
                  {pendingCount}
                </span>
                notificaç{pendingCount === 1 ? 'ão pendente' : 'ões pendentes'}
              </span>
            </button>
          )}
        </div>
        {/* DIREITA: Botões de ação */}
        <div className="flex flex-wrap items-center gap-0.5 sm:gap-1 flex-1 justify-end flex-shrink-0">
          <button onClick={handleOpenCalc} className="inline-flex items-center gap-0.5 sm:gap-1 rounded-md border border-[var(--th-line)]/80 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 hover:border-amber-600/50 hover:text-amber-200 transition-all duration-200 cursor-pointer" title="Câmbio" style={{ padding: "clamp(2.7px, 0.54vh, 5.4px) clamp(5.4px, 0.9vw, 9px)", fontSize: "clamp(8.1px, 1.35vh, 9.9px)" }}>
            <Calculator size={11} className="sm:w-[13px] sm:h-[13px]" /> <span className="hidden sm:inline">Câmbio</span>
          </button>
          <button onClick={() => setImbueOpen(true)} className="inline-flex items-center gap-0.5 sm:gap-1 rounded-md border border-[var(--th-line)]/80 bg-violet-500/10 text-violet-300 hover:bg-violet-500/20 hover:border-violet-500/50 hover:text-violet-200 transition-all duration-200 cursor-pointer" title="Guia de Imbuements" style={{ padding: "clamp(2.7px, 0.54vh, 5.4px) clamp(5.4px, 0.9vw, 9px)", fontSize: "clamp(8.1px, 1.35vh, 9.9px)" }}>
            <Sparkles size={11} className="sm:w-[13px] sm:h-[13px]" /> <span className="hidden sm:inline">Imbue</span>
          </button>
          {/* Calc Win depende de IPC do Electron: não é renderizado na Web. */}
          {isElectron && (
            <button onClick={() => {
              try { const { ipcRenderer } = (window as any).require("electron"); ipcRenderer.invoke("open-windows-calc"); } catch { customAlert("Erro ao abrir calculadora."); }
            }} className="inline-flex items-center gap-0.5 sm:gap-1 rounded-md border border-[var(--th-line)]/80 bg-[var(--th-bg-base)] text-amber-200/70 hover:bg-[var(--th-bg-raised)] hover:border-[var(--th-brand)]/60 hover:text-amber-200 transition-all duration-200 cursor-pointer" title="Calc Win" style={{ padding: "clamp(2.7px, 0.54vh, 5.4px) clamp(5.4px, 0.9vw, 9px)", fontSize: "clamp(8.1px, 1.35vh, 9.9px)" }}>
              <AppWindow size={11} className="sm:w-[13px] sm:h-[13px] text-amber-600/80" /> <span className="hidden sm:inline">Calc Win</span>
            </button>
          )}
          <AutoSaveButton status={autoSaveStatus} fileName={autoSaveName} onClick={handleAutoSaveClick} />
          <OptionsMenu
            onImport={handleImport}
            onExport={() => exportJSON(buildPersonalBackup(data.characters, data.notes, [], displayUserName))}
            onExportCSV={() => exportCSV(data)}
          />
        </div>
      </header>

      {notificationOpen && (
        <NotificationCenter
          notifications={notifications}
          onMarkDone={markAsDone}
          onMarkAllDone={markAllAsDone}
          onClearDone={clearDone}
          onClose={() => setNotificationOpen(false)}
          desktopEnabled={desktopEnabled}
          onToggleDesktop={setDesktopEnabled}
          closeTray={closeTray}
          onToggleCloseTray={setCloseTray}
          startWithWindows={startWithWindows}
          onToggleStartWithWindows={setStartWithWindows}
          lowCpuUsage={lowCpuUsage}
          onToggleLowCpuUsage={setLowCpuUsage}
          userRole={userProfile?.role}
          onOpenDonation={() => {
            setNotificationOpen(false);
            setDonationOpen(true);
          }}
          onUpdateCharacters={handleUpdateCharactersFromNotification}
          autoCharUpdate={!!userProfile?.autoCharUpdate}
          onToggleAutoCharUpdate={(v) => updateUserProfile({ autoCharUpdate: v })}
        />
      )}

      <div className="lg:hidden flex items-center gap-1.5 px-1.5 sm:px-2 bg-[var(--th-bg-base)] border-b border-[var(--th-line)]/60 flex-shrink-0 overflow-x-auto [overflow-y:visible]" style={{ padding: "clamp(3px, 0.5vh, 6px) clamp(6px, 1vw, 8px)", zoom: `${headerZoomLevel}%` }}>
        <span className="uppercase tracking-widest text-slate-500 mr-0.5 whitespace-nowrap" style={{ fontSize: "clamp(9px, 1.4vh, 11px)" }}>Painel</span>
        <WindowToggle active={activeWindow === "characters"} icon={<Swords size={11} />} label="Hub Principal" onClick={() => toggleWindow("characters")} hero />
        <WindowToggle active={activeWindow === "stats"} icon={<BarChart3 size={11} />} label="Stats" onClick={() => toggleWindow("stats")} />
        <WindowToggle active={activeWindow === "ranking"} icon={<Trophy size={11} />} label="Ranking" onClick={() => toggleWindow("ranking")} />
        <WindowToggle active={activeWindow === "notes"} icon={<StickyNote size={11} />} label="Notas" onClick={() => toggleWindow("notes")} />
        <WindowToggle active={activeWindow === "bazar"} icon={<ShoppingBag size={11} />} label="Bazaar" onClick={() => toggleWindow("bazar")} hero />
      </div>

      <div className="flex-1 min-h-0 overflow-hidden relative z-10 p-0.25 sm:p-0.5">
        {activeWindow === "characters" ? (
          <div className="h-full w-full">{topContent}</div>
        ) : (
        <div className="h-full w-full" style={{ zoom: `${contentZoomLevel}%` }}>
        {activeWindow === null ? (
          <LandingPage onOpenHub={() => setActiveWindow("characters")} onOpenNotif={toggleNotificationMenu} pendingCount={pendingCount} notificationOpen={notificationOpen} setActiveWindow={setActiveWindow} setTab={setTab} />
        ) : activeWindow === "stats" ? (
          <div className="h-full bg-[var(--th-n-raised)]/90 backdrop-blur-sm rounded-xl border border-red-800/50 overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--th-line)]/50 bg-[var(--th-bg-overlay)] flex-shrink-0" style={{ zoom: `${headerZoomLevel}%` }}>
              <div className="flex items-center gap-2 text-slate-300">
                <BarChart3 size={13} />
                <span className="text-xs font-medium">Estatísticas</span>
              </div>
              <button onClick={() => setActiveWindow(null)} className="text-slate-500 hover:text-white text-xs cursor-pointer">✕</button>
            </div>
            <div className="flex-1 min-h-0 overflow-auto p-3">
              <StatsPanel characters={data.characters} parties={cloudParties} userName={displayUserName} userStats={userStatsDoc} userNames={statsUserNames} services={statsUserServices} characterAcquisitions={characterAcquisitions} characterAcquisitionBuyerDetails={characterAcquisitionBuyerDetails} currentUserUid={currentUser?.uid || ""} />
            </div>
          </div>
        ) : activeWindow === "notes" ? (
          <div className="h-full bg-[var(--th-n-raised)]/90 backdrop-blur-sm rounded-xl border border-red-800/50 overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--th-line)]/50 bg-[var(--th-bg-overlay)] flex-shrink-0" style={{ zoom: `${headerZoomLevel}%` }}>
              <div className="flex items-center gap-2 text-slate-300">
                <StickyNote size={13} />
                <span className="text-xs font-medium">Planilha/Anotações</span>
              </div>
              <button onClick={() => setActiveWindow(null)} className="text-slate-500 hover:text-white text-xs cursor-pointer">✕</button>
            </div>
            <div className="flex-1 min-h-0 overflow-auto p-3">
              <NotesPanel value={data.notes} onChange={handleNotes} />
            </div>
          </div>
        ) : activeWindow === "ranking" ? (
          <div className="h-full rounded-xl border border-red-800/50 overflow-hidden">
            <RankingPanel
              currentUserUid={currentUser?.uid || ""}
              userNames={statsUserNames}
              userStatsDoc={userStatsDoc}
              displayUserName={displayUserName}
            />
          </div>
        ) : activeWindow === "bazar" ? (
          <div className="h-full rounded-xl border border-red-800/50 overflow-hidden">
            <BazarPanel sharedCharacters={availableCharactersForParty} waitingList={availableWaitingListForParty} activeParties={cloudParties} personalCharacters={data.characters} accounts={accounts} onAddCharacterFromBazaar={addCharacterFromBazaar} />
          </div>
        ) : null}
        </div>
        )}
      </div>

      {/* Motor do Auto Bid — roda em segundo plano (independente do modal e do
          painel ativo). Renderiza nada; apenas agenda/executa os lances. */}
      <AutoBidEngine currentUserUid={currentUser?.uid || null} />

      {/* RODAPÉ COM STATUS DE CONEXÃO, USUÁRIOS ONLINE E SINCRONIZAÇÃO */}
      <footer ref={appFooterRef} className="px-2 sm:px-4 py-1 sm:py-1.5 text-[9px] bg-[var(--th-bg-raised)]/95 backdrop-blur-md border-t border-[var(--th-line)]/60 flex flex-wrap gap-2 sm:gap-3 items-center justify-between flex-shrink-0 relative z-10" style={{ minHeight: "clamp(20px, 3vh, 30px)", padding: "clamp(2px, 0.1vh, 5px) clamp(5px, 1vw, 10px)" }}>
        <div className="flex items-center gap-4 flex-wrap">
          {/* Acesso VIP modularizado: Painel VIP ou Seja VIP */}
          <VipAccessButton userProfile={userProfile} />

          {/* Status de conexão */}
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${isOnline ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'bg-red-500 shadow-[0_0_8px_color-mix(in_oklab,var(--color-red-600)_50%,transparent)]'}`} />
            <span className={`font-medium ${isOnline ? 'text-emerald-500' : 'text-red-300'}`}>
              {isOnline ? 'On' : 'Off'}
            </span>
            {!isOnline && (
              <span className="text-slate-500 text-[8px]">(usando cache local)</span>
            )}
          </div>

          <span className="h-4 w-px bg-red-900/30" />

          {/* Status de sincronização */}
          <div className="flex items-center gap-1.5">
            {isSyncing ? (
              <>
                <CloudCog size={14} className="text-amber-400 animate-pulse" />
              </>
            ) : (
              <>
                <Cloud size={14} className="text-emerald-400" />
              </>
            )}
         </div>

          <span className="h-4 w-px bg-red-900/30" />

          {/* Usuários online */}
          <div className="flex items-center gap-1.5 text-slate-400">
            <Users size={13} className={globalSettings.presenceEnabled ? "text-violet-400" : "text-slate-500"} />
            <span className="font-medium" title={!globalSettings.presenceEnabled ? "Presence pausado pelo Boss" : presenceCountUnavailable ? "Presence indisponível no modo econômico" : undefined}>
              {globalSettings.presenceEnabled && !presenceCountUnavailable ? onlineCount : "-"}
            </span>
          </div>

        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {/* BOX 1 — Controles de zoom (cabeçalho + conteúdo) */}
          <div className="nav-frame flex items-center gap-3 flex-wrap bg-[var(--th-bg-deep)]/60 rounded-lg px-2.5 py-1">
            <div className="flex items-center gap-1.5 text-slate-500">
              <span>Zoom Cabeçalho</span>
              <button type="button" onClick={() => setHeaderZoomLevel((z: number) => Math.max(60, z - 5))} className="w-4 h-4 flex items-center justify-center rounded hover:bg-white/5 border border-white/5 font-bold transition-colors cursor-pointer text-[11px]">-</button>
              <span className="font-bold font-mono min-w-[28px] text-center text-slate-400 text-[11px]">{headerZoomLevel}%</span>
              <button type="button" onClick={() => setHeaderZoomLevel((z: number) => Math.min(140, z + 5))} className="w-4 h-4 flex items-center justify-center rounded hover:bg-white/5 border border-white/5 font-bold transition-colors cursor-pointer text-[11px]">+</button>
            </div>

            <span className="h-3.5 w-px bg-[var(--th-line)]/50" />

            <div className="flex items-center gap-1.5 text-slate-500">
              <span>Zoom Conteúdo</span>
              <button type="button" onClick={() => setContentZoomLevel((z: number) => Math.max(60, z - 5))} className="w-4 h-4 flex items-center justify-center rounded hover:bg-white/5 border border-white/5 font-bold transition-colors cursor-pointer text-[11px]">-</button>
              <span className="font-bold font-mono min-w-[28px] text-center text-slate-400 text-[11px]">{contentZoomLevel}%</span>
              <button type="button" onClick={() => setContentZoomLevel((z: number) => Math.min(140, z + 5))} className="w-4 h-4 flex items-center justify-center rounded hover:bg-white/5 border border-white/5 font-bold transition-colors cursor-pointer text-[11px]">+</button>
            </div>
          </div>

          {/* BOX 2 — Ações do rodapé */}
          <div className="nav-frame footer-pulse flex items-center gap-2 flex-wrap bg-[var(--th-bg-deep)]/60 rounded-lg px-2.5 py-1">
            <button
              type="button"
              onClick={() => setFeedbackOpen(true)}
              className="pt-stage-pulse pt-stage-pulse--slate inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[9px] font-medium border border-slate-500/35 bg-[var(--th-bg-base)] text-slate-300 hover:text-slate-100 hover:bg-[var(--th-bg-raised)] hover:border-slate-400/60 hover:shadow-[0_0_10px_rgba(148,163,184,0.10)] shadow-[0_0_6px_rgba(148,163,184,0.05)] transition-all duration-200 cursor-pointer"
            >
              <MessageSquareMore size={10} className="text-slate-400/80" />
              Feedback
            </button>

            <button
              type="button"
              onClick={() => setDonationOpen(true)}
              className="pt-stage-pulse pt-stage-pulse--amber-600 inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[9px] font-medium border border-amber-600/35 bg-[var(--th-bg-base)] text-slate-300 hover:text-slate-100 hover:bg-[var(--th-bg-raised)] hover:border-amber-500/60 hover:shadow-[0_0_12px_color-mix(in_oklab,var(--color-amber-500)_15%,transparent)] shadow-[0_0_6px_color-mix(in_oklab,var(--color-amber-500)_6%,transparent)] transition-all duration-200 cursor-pointer"
              title="Colaborar com o projeto"
            >
              <Heart size={10} className="text-amber-500/70" />
              {userProfile?.role === "Boss" ? (
                <>Doação</>
              ) : (() => {
                const rcDoado = userStatsDoc && typeof userStatsDoc.totalRcDoado === "number" ? userStatsDoc.totalRcDoado : 0;
                const ptsConcluidas = userStatsDoc && typeof userStatsDoc.totalPtsConcluidas === "number" ? userStatsDoc.totalPtsConcluidas : 0;
                const mediaAtual = ptsConcluidas > 0 ? Math.round(rcDoado / ptsConcluidas) : 0;
                return <>Doação <span className="text-amber-400 font-bold">(Méd. Atual: {mediaAtual} RC/PT)</span></>;
              })()}
            </button>

            {userProfile?.role === "Boss" && (
              <button
                type="button"
                onClick={() => setAdminOpen(true)}
                className={
                  totalPendingBossActions > 0
                    ? "pt-stage-pulse pt-stage-pulse--amber inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[9px] font-bold border-2 border-amber-500/80 bg-gradient-to-b from-amber-900/25 to-amber-950/15 text-amber-200 hover:from-amber-900/35 hover:to-amber-950/25 transition-all duration-200 cursor-pointer animate-pulse shadow-[0_0_16px_color-mix(in_oklab,var(--color-amber-500)_30%,transparent),0_0_4px_color-mix(in_oklab,var(--color-amber-500)_15%,transparent)]"
                    : "pt-stage-pulse pt-stage-pulse--violet-600 inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[9px] font-medium border border-violet-600/35 bg-[var(--th-bg-base)] text-slate-300 hover:text-slate-100 hover:bg-[var(--th-bg-raised)] hover:border-violet-500/60 hover:shadow-[0_0_12px_rgba(139,92,246,0.15)] shadow-[0_0_6px_rgba(139,92,246,0.06)] transition-all duration-200 cursor-pointer"
                }
              >
                <Shield size={10} className="text-violet-500/70" />
                <span>Boss</span>
                {totalPendingBossActions > 0 && (
                  <span className="ml-0.5 px-1 py-0.2 bg-amber-700/80 text-amber-100 font-mono font-black rounded-full text-[9px]">
                    {totalPendingBossActions}
                  </span>
                )}
              </button>
            )}
            <button
              type="button"
              onClick={() => setReceiveRCOpen(true)}
              className="pt-stage-pulse pt-stage-pulse--emerald-600 inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-emerald-600/35 bg-[var(--th-bg-base)] text-slate-300 hover:text-slate-100 hover:bg-[var(--th-bg-raised)] hover:border-emerald-500/60 hover:shadow-[0_0_12px_rgba(16,185,129,0.15)] shadow-[0_0_6px_rgba(16,185,129,0.06)] transition-all duration-200 text-[9px] font-medium cursor-pointer"
              title="Configurar personagem principal para receber RC"
            >
              <User size={10} className="text-emerald-500/70" />
              Receber RC
            </button>
            <button
              type="button"
              onClick={() => setTwitchOpen(true)}
              className="pt-stage-pulse pt-stage-pulse--violet-600 inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-violet-600/35 bg-[var(--th-bg-base)] text-slate-300 hover:text-slate-100 hover:bg-[var(--th-bg-raised)] hover:border-violet-500/60 hover:shadow-[0_0_12px_rgba(139,92,246,0.15)] shadow-[0_0_6px_rgba(139,92,246,0.06)] transition-all duration-200 text-[9px] font-medium cursor-pointer"
              title="Configurar canal da Twitch"
            >
              <Tv size={10} className="text-violet-500/70" />
              Streaming
            </button>
            <button
              type="button"
              onClick={() => setFriendsOpen(true)}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md border text-[9px] transition-all duration-200 cursor-pointer relative ${
                pendingFriendsCount > 0
                  ? "pt-stage-pulse pt-stage-pulse--amber bg-gradient-to-r from-amber-500/25 via-amber-500/15 to-[var(--th-bg-base)] border-amber-500/80 text-amber-200 font-bold shadow-[0_0_14px_color-mix(in_oklab,var(--color-amber-500)_30%,transparent)] animate-pulse"
                  : "pt-stage-pulse pt-stage-pulse--emerald-600 border-emerald-600/35 bg-[var(--th-bg-base)] text-slate-300 font-medium hover:text-slate-100 hover:bg-[var(--th-bg-raised)] hover:border-emerald-500/60 hover:shadow-[0_0_12px_rgba(16,185,129,0.15)] shadow-[0_0_6px_rgba(16,185,129,0.06)]"
              }`}
              title="Gerenciar Amigos"
            >
              {pendingFriendsCount > 0 ? (
                <UserPlus size={10} className="text-amber-400" />
              ) : (
                <Users size={10} className="text-emerald-500/70" />
              )}
              <span>Amigos</span>
              {/* Indicator elegante de solicitações pendentes */}
              {pendingFriendsCount > 0 && (
                <span className="absolute -top-1 -right-1 flex items-center justify-center min-w-[14px] h-[14px] px-1 rounded-full bg-amber-400 text-black text-[8px] font-mono font-black shadow-[0_0_8px_color-mix(in_oklab,var(--color-amber-500)_90%,transparent)]">
                  {pendingFriendsCount}
                </span>
              )}
            </button>
            <button
              onClick={() => customConfirm("Deseja realmente desconectar?", () => {
                localStorage.setItem("tibia_auto_login", "false");
                localStorage.removeItem("tibia_saved_email");
                localStorage.removeItem("tibia_saved_pass");
                handleSignOut();
              })}
              className="pt-stage-pulse pt-stage-pulse--rose-700 inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-rose-700/35 bg-[var(--th-bg-base)] text-slate-300 hover:text-slate-100 hover:bg-[var(--th-bg-raised)] hover:border-rose-600/60 hover:shadow-[0_0_12px_color-mix(in_oklab,var(--color-red-600)_12%,transparent)] shadow-[0_0_6px_color-mix(in_oklab,var(--color-red-600)_5%,transparent)] text-[9px] font-medium transition-all duration-200 cursor-pointer"
            >
              <User size={10} className="text-rose-600/70" />
              {displayUserName} (Sair)
            </button>
          </div>
        </div>
      </footer>

      <CharacterModal
        open={modalOpen}
        initial={editing}
        accounts={accounts}
        servers={servers}
        onSave={handleSave}
        onClose={() => setModalOpen(false)}
        mode={characterModalMode}
        lockedQuestFinancialFields={!!editing && negotiatedOriginalCharacterIds.has(editing.id)}
      />
      <CurrencyCalculator open={calcOpen} onClose={() => setCalcOpen(false)} focusSignal={calcFocusSignal} />
      <ImbuementsModal open={imbueOpen} onClose={() => setImbueOpen(false)} />
      <FeedbackModal open={feedbackOpen} onClose={() => setFeedbackOpen(false)} userName={displayUserName} />
      <DonationModal open={donationOpen} onClose={() => setDonationOpen(false)} minAverage={globalSettings.minimumAverageDonation} />
      {(() => {
        if (userProfile?.role === "Boss") return null;
        const totalRcDoado = userStatsDoc && typeof userStatsDoc.totalRcDoado === "number" ? userStatsDoc.totalRcDoado : 0;
        const totalPtsConcluidas = userStatsDoc && typeof userStatsDoc.totalPtsConcluidas === "number" ? userStatsDoc.totalPtsConcluidas : 0;
        const averageRcPerPt = totalPtsConcluidas > 0 ? totalRcDoado / totalPtsConcluidas : 0;
        return (
          <AdviceDonationModal
            open={adviceDonationOpen}
            onClose={() => setAdviceDonationOpen(false)}
            onOpenDonation={() => setDonationOpen(true)}
            averageRcPerPt={averageRcPerPt}
            minAverage={globalSettings.minimumAverageDonation}
          />
        );
      })()}
      <BossAdminPanel open={adminOpen} onClose={() => setAdminOpen(false)} presenceMap={presenceMap} minAverage={globalSettings.minimumAverageDonation} globalSettings={globalSettings} pendingDonationsCount={pendingDonationsCount} pendingRequestsCount={pendingRequestsCount} pendingVipCount={pendingVipCount} />
      <ReceiveRCModal open={receiveRCOpen} onClose={() => setReceiveRCOpen(false)} />
      <TwitchModal open={twitchOpen} onClose={() => setTwitchOpen(false)} />
      <FriendsModal open={friendsOpen} onClose={() => setFriendsOpen(false)} />
      {autoSaveInfoOpen && (
        <div className="app-modal-overlay fixed inset-0 z-[200] flex items-center justify-center bg-black/75 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) setAutoSaveInfoOpen(false); }}>
           <div className="app-modal-frame app-modal-size-sm app-modal-frame--scroll bg-[var(--th-bg-base)] border border-[var(--th-line)]/80 rounded-2xl shadow-2xl w-full max-w-md">
            <div className="flex flex-col items-center text-center px-6 pt-6 pb-4 border-b border-[var(--th-line)]/40">
              <div className="w-14 h-14 rounded-full bg-emerald-500/15 border border-emerald-500/40 flex items-center justify-center mb-3">
                <CheckCircle2 size={28} className="text-emerald-400" />
              </div>
              <h3 className="text-lg font-bold text-white tracking-wide">Salvamento Automático Ativo</h3>
            </div>
            <div className="px-6 py-4 space-y-3 text-sm text-slate-300 leading-relaxed">
              <p>Está tudo certo com o salvamento automático! Seus dados estão sendo salvos automaticamente e estão seguros.</p>
              <p>O salvamento é <strong className="text-emerald-300">100% offline</strong>, gravado diretamente no seu computador. Seus dados <strong className="text-emerald-300">NÃO</strong> são compartilhados na nuvem nem enviados a servidores externos.</p>
              {autoSaveName && (
                <div className="text-xs text-slate-400 bg-[var(--th-bg-abyss)] border border-red-900/20 rounded-lg px-3 py-2">
                  Arquivo configurado: <span className="font-mono text-emerald-300 break-all">{autoSaveName}</span>
                </div>
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 px-6 pb-6">
              <button
                type="button"
                onClick={() => {
                  try {
                    if (isElectron) {
                      const { ipcRenderer } = (window as any).require("electron");
                      const savedPath = currentUser?.uid ? localStorage.getItem(`tibia_autosave_path_${currentUser.uid}`) : null;
                      if (savedPath) {
                        ipcRenderer.invoke("open-file-location", savedPath);
                      } else {
                        customAlert("Caminho do arquivo não encontrado. Configure um novo local de Auto-Save.");
                      }
                    } else {
                      customAlert("Abrir a pasta do arquivo está disponível apenas na versão Desktop (Electron).");
                    }
                  } catch {}
                  // Não fecha o modal
                }}
                className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-sky-500/15 border border-sky-500/40 text-sky-300 hover:bg-sky-500/25 text-xs font-bold transition-colors cursor-pointer"
              >
                Abrir local do arquivo
              </button>
              <button
                type="button"
                onClick={() => { configureAutoSave(); }}
                className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-amber-500/15 border border-amber-500/40 text-amber-300 hover:bg-amber-500/25 text-xs font-bold transition-colors cursor-pointer"
              >
                Configurar novo local
              </button>
              <button
                type="button"
                onClick={() => { updateAutoSaveStatus("waiting"); setAutoSaveInfoOpen(false); }}
                className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-white/[0.03] border border-white/10 text-slate-300 hover:bg-white/10 hover:text-white text-xs font-bold transition-colors cursor-pointer"
              >
                Pausar Autosave
              </button>
              <button
                type="button"
                onClick={() => setAutoSaveInfoOpen(false)}
                className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-white/[0.03] border border-white/10 text-slate-400 hover:bg-white/10 hover:text-white text-xs font-bold transition-colors cursor-pointer"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {customDialog && (
        /* z-[99990]: diálogo global (customAlert/customConfirm) precisa ficar
           ACIMA de qualquer modal do app (modais chegam a z-[1200] e pilhas a
           z-[9999]). Antes era z-[200]: alertas disparados de dentro de um
           modal — ex.: "Destinatário da divisão não identificado" no PartyPanel
           (z-[420]) — abriam ATRÁS dele, invisíveis, parecendo que o clique
           "não fazia nada". */
        <div className="app-modal-overlay fixed inset-0 z-[99990] flex items-center justify-center bg-black/75 backdrop-blur-sm">
          <div className="app-modal-frame app-modal-size-sm w-full max-w-md overflow-y-auto bg-[var(--th-bg-base)] border border-[var(--th-line)]/80 rounded-2xl shadow-2xl p-4 sm:p-6 space-y-4">
            <h3 className={`text-lg font-bold ${customDialog.type === "confirm" ? "text-amber-400" : "text-sky-400"}`}>
              {customDialog.title || (customDialog.type === "confirm" ? "Confirmação" : "Aviso")}
            </h3>
            <p className="text-sm text-slate-300 whitespace-pre-line leading-relaxed">
              {customDialog.message}
            </p>
            <div className="flex justify-end gap-3 pt-2">
              {customDialog.type === "confirm" && (
                <button
                  onClick={() => setCustomDialog(null)}
                  className="px-4 py-2 rounded-lg border border-white/10 text-slate-400 hover:text-white hover:bg-white/5 text-xs font-semibold transition-colors cursor-pointer"
                >
                  Cancelar
                </button>
              )}
              <button
                onClick={() => {
                  const cb = customDialog.onConfirm;
                  setCustomDialog(null);
                  if (cb) cb();
                }}
                className={`px-5 py-2 rounded-lg text-xs font-bold text-black shadow-lg transition-colors cursor-pointer ${
                  customDialog.type === "confirm" ? "bg-amber-500 hover:bg-amber-400 shadow-amber-500/20" : "bg-sky-500 hover:bg-sky-400 shadow-sky-500/20 text-black font-semibold"
                }`}
              >
                {customDialog.type === "confirm" ? "Confirmar" : "OK"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function WindowToggle({ active, icon, label, onClick, hero }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void; hero?: boolean }) {
  // Aparência centralizada em .nav-pill (src/index.css). A cor de destaque
  // vem do tema via --pill-accent, então acompanha a troca de tema sozinha.
  // `hero` aplica o modificador .nav-pill--hero, usado nas áreas mais
  // acessadas (Hub Principal e Bazaar) — apenas visual.
  return (
    <button
      onClick={onClick}
      data-active={active}
      aria-pressed={active}
      className={`nav-pill${hero ? " nav-pill--hero" : ""} inline-flex items-center gap-0.5 sm:gap-1 whitespace-nowrap cursor-pointer`}
      title={active ? `Fechar ${label}` : `Abrir ${label}`}
      style={{ padding: "clamp(2.7px, 0.45vh, 5.4px) clamp(5.4px, 0.9vw, 9px)", fontSize: "clamp(8.1px, 1.26vh, 9.9px)" }}
    >
      {icon} <span className="hidden sm:inline">{label}</span><span className="sm:hidden">{label.split(' ')[0]}</span>
    </button>
  );
}

function TabButton({ active, icon, label, count, countLabel, onClick, variant, padlock }: {
  active: boolean; icon: React.ReactNode; label: string; count: number; countLabel?: string; onClick: () => void; variant?: "green" | "orange" | "violet" | "sky" | "darkgreen";
  padlock?: "public" | "private";
}) {
  // Cada variante apenas escolhe a cor de destaque; toda a aparência
  // (borda, glow, hover, pulsação, estado ativo) vem de .nav-pill em
  // src/index.css — mesma linguagem visual dos botões de navegação.
  const variantColors: Record<string, { accent: string; badgeBg: string; badgeText: string }> = {
    green:     { accent: "var(--color-emerald-500)", badgeBg: "bg-emerald-800/40", badgeText: "text-emerald-300" },
    darkgreen: { accent: "var(--color-emerald-500)", badgeBg: "bg-emerald-800/40", badgeText: "text-emerald-300" },
    orange:    { accent: "var(--color-amber-500)",   badgeBg: "bg-amber-800/40",   badgeText: "text-amber-300" },
    violet:    { accent: "var(--color-violet-500)",  badgeBg: "bg-violet-800/40",  badgeText: "text-violet-300" },
    sky:       { accent: "var(--color-sky-500)",     badgeBg: "bg-sky-800/40",     badgeText: "text-sky-300" },
  };
  const vc = variantColors[variant || ""] || variantColors.green;

  return (
    <button onClick={onClick} data-active={active} aria-pressed={active} className="nav-pill nav-pill--sm inline-flex items-center gap-0.5 sm:gap-1 cursor-pointer whitespace-nowrap" style={{ ["--pill-accent" as string]: vc.accent, padding: "clamp(2.43px, 0.405vh, 4.86px) clamp(4.86px, 0.81vw, 8.1px)", fontSize: "clamp(7.29px, 1.134vh, 8.91px)" }}>
      {icon} <span className="hidden sm:inline">{label}</span><span className="sm:hidden">{label.length > 8 ? label.substring(0, 8) + '…' : label}</span>
      <span className={`font-bold px-0.5 sm:px-1 py-0.25 sm:py-0.5 rounded ${active ? vc.badgeBg + " " + vc.badgeText : "bg-black/25 text-slate-400"}`} style={{ fontSize: "clamp(8px, 1.3vh, 10px)" }}>{countLabel ?? count}</span>
      {padlock && (
        <span title={padlock === "private" ? "Aba Privada" : "Aba Pública"} className={`ml-0.5 flex-shrink-0 ${active ? "opacity-80" : "opacity-40"}`}>
          {padlock === "private"
            ? <Lock size={9} className="text-amber-500" />
            : <LockOpen size={9} className="text-amber-500" />
          }
        </span>
      )}
    </button>
  );
}

function AutoSaveButton({ status, fileName, onClick }: { status: AutoSaveStatus; fileName: string; onClick: () => void }) {
  const config = {
    unconfigured: { icon: <Save size={11} />, className: "bg-[var(--th-bg-base)] border-[var(--th-line)]/80 text-amber-200/60 hover:bg-[var(--th-bg-raised)] hover:border-[var(--th-brand)]/60 hover:text-amber-200", title: "Configurar Auto-Save" },
    waiting: { icon: <Save size={11} />, className: "bg-sky-500/10 border-sky-500/30 text-sky-400 hover:bg-sky-500/20 hover:border-sky-500/50", title: "Retomar Auto-Save" },
    saved: { icon: <CheckCircle2 size={11} />, className: "bg-emerald-500/10 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20 hover:border-emerald-500/50", title: fileName ? `Auto-Save: ${fileName}` : "Auto-Save ativo" },
    error: { icon: <AlertTriangle size={11} />, className: "bg-rose-500/10 border-rose-500/30 text-rose-400 hover:bg-rose-500/20 hover:border-rose-500/50", title: "Erro. Clique para reconfigurar." },
  }[status];
  return (
    <button onClick={onClick} className={`inline-flex items-center gap-0.5 sm:gap-1 rounded-md border transition-all cursor-pointer ${config.className}`} title={config.title} style={{ padding: "clamp(2.7px, 0.54vh, 5.4px) clamp(5.4px, 0.9vw, 9px)", fontSize: "clamp(8.1px, 1.35vh, 9.9px)" }}>
      {config.icon} <span className="hidden sm:inline">AUTO-SAVE</span>
    </button>
  );
}

/**
 * Menu "Opções" — agrupa Importar / Exportar / CSV em um único botão.
 *
 * Apenas apresentação: as três ações continuam sendo exatamente as mesmas
 * (inclusive o <input type="file"> do Importar, preservado como <label>).
 *
 * O menu é posicionado de forma absoluta DENTRO do header em vez de usar
 * portal: o header aplica `zoom`, e um portal em document.body ficaria
 * desalinhado, pois getBoundingClientRect() já devolve as coordenadas
 * afetadas pelo zoom.
 */
function OptionsMenu({
  onImport,
  onExport,
  onExportCSV,
}: {
  onImport: (f: File) => void;
  onExport: () => void;
  onExportCSV: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Fecha ao clicar fora ou ao pressionar Esc.
  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: MouseEvent) {
      if (wrapRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const itemClass =
    "w-full flex items-center gap-2 px-2.5 py-1.5 text-left rounded-md text-amber-200/80 hover:bg-amber-500/15 hover:text-amber-100 transition-colors cursor-pointer";

  return (
    <div ref={wrapRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`inline-flex items-center gap-0.5 sm:gap-1 rounded-md border transition-all duration-200 cursor-pointer ${
          open
            ? "border-amber-600/60 bg-amber-500/15 text-amber-200"
            : "border-[var(--th-line)]/80 bg-[var(--th-bg-base)] text-amber-200/70 hover:bg-[var(--th-bg-raised)] hover:border-[var(--th-brand)]/60 hover:text-amber-200"
        }`}
        title="Opções — Importar, Exportar e CSV"
        style={{ padding: "clamp(2.7px, 0.54vh, 5.4px) clamp(5.4px, 0.9vw, 9px)", fontSize: "clamp(8.1px, 1.35vh, 9.9px)" }}
      >
        <SlidersHorizontal size={11} className="sm:w-[13px] sm:h-[13px] text-amber-600/80" />
        <span className="hidden sm:inline">Opções</span>
        <ChevronDown size={10} className={`transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Opções"
          className="absolute right-0 top-full mt-1 z-50 min-w-[172px] p-1 rounded-lg border border-[var(--th-line)]/80 bg-[var(--th-bg-raised)]/98 backdrop-blur-md shadow-2xl shadow-black/60"
          style={{ fontSize: "clamp(8.1px, 1.35vh, 9.9px)" }}
        >
          {/* Importar — mantém o <input type="file"> original dentro do label. */}
          <label role="menuitem" className={itemClass} title="Importar backup pessoal (JSON)">
            <ArrowDown size={11} className="text-amber-600/80 flex-shrink-0" />
            <span>Importar</span>
            <input
              type="file"
              accept=".json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onImport(f);
                e.target.value = "";
                setOpen(false);
              }}
            />
          </label>

          <button
            type="button"
            role="menuitem"
            onClick={() => { setOpen(false); onExport(); }}
            className={itemClass}
            title="Exportar backup pessoal (JSON) — personagens, anotações e histórico de PT's"
          >
            <ArrowUp size={11} className="text-amber-600/80 flex-shrink-0" />
            <span>Exportar</span>
          </button>

          <button
            type="button"
            role="menuitem"
            onClick={() => { setOpen(false); onExportCSV(); }}
            className={itemClass}
            title="Exportar CSV"
          >
            <FileSpreadsheet size={11} className="text-amber-600/80 flex-shrink-0" />
            <span>CSV</span>
          </button>
        </div>
      )}
    </div>
  );
}

function LandingPage({ onOpenHub, onOpenNotif, pendingCount, notificationOpen, setActiveWindow, setTab }: {
  onOpenHub: () => void;
  onOpenNotif: () => void;
  pendingCount: number;
  notificationOpen: boolean;
  setActiveWindow: (key: WindowKey) => void;
  setTab: (tab: Tab) => void;
}) {
  const landingRef = useRef<HTMLDivElement>(null);
  const [landingScale, setLandingScale] = useState(1);

  useEffect(() => {
    function recalcScale() {
      if (!landingRef.current) return;
      const containerHeight = landingRef.current.parentElement?.clientHeight || window.innerHeight;
      const idealHeight = 700;
      const scale = Math.min(1, Math.max(0.55, (containerHeight - 40) / idealHeight));
      setLandingScale(scale);
    }
    recalcScale();
    window.addEventListener("resize", recalcScale);
    return () => window.removeEventListener("resize", recalcScale);
  }, []);

  const features = [
    {
      icon: <Swords size={20} className="text-emerald-400" />,
      title: "Gerenciamento de Personagens",
      desc: "Cadastre, edite e acompanhe o histórico de compra e venda de todos os seus personagens. Controle de lucro/prejuízo completo.",
      onClick: () => { onOpenHub(); setTab("ativos"); }
    },
    {
      icon: <Users size={20} className="text-violet-400" />,
      title: "Montagem de PT's (Parties)",
      desc: "Crie parties públicas ou privadas, adicione jogadores, gerencie drops, calcule splits e realize sorteios automaticamente. Tudo em um só lugar!",
      onClick: () => { onOpenHub(); setTab("pts"); }
    },
    {
      icon: <Archive size={20} className="text-amber-400" />,
      title: "Meu Histórico de PT's",
      desc: "Todas as PT's concluídas são arquivadas pelo backend no seu histórico privado, com relatório completo de drops, jogadores, lucros e pagamentos.",
      onClick: () => { onOpenHub(); setTab("meu_historico"); }
    },
    {
      icon: <Clock size={20} className="text-sky-400" />,
      title: "Lista de Espera",
      desc: "Adicione e gerencie seus Services de Soulwar e Sanguine, com informações detalhadas de contato (WhatsApp), link do personagem e valores combinados. Seus personagens de Services poderão ser convidados para PT's",
      onClick: () => { onOpenHub(); setTab("waitlist"); }
    },
    {
      icon: <BarChart3 size={20} className="text-rose-400" />,
      title: "Painel de Estatísticas",
      desc: "Visualize estatísticas de ganhos, gastos e rentabilidade de todos os seus personagens. Também exibe outras informações importante: média de mortes em PT's, médias por personagem, desempenho em sorteios, relatório de PT's, itens dropados e parceiros de quest.",
      onClick: () => setActiveWindow("stats")
    },
    {
      icon: <ShoppingBag size={20} className="text-amber-400" />,
      title: "Painel Bazaar",
      desc: "Consulte a lista oficial do Bazaar, use filtros inteligentes, acompanhe encerramentos, marque interesses e identifique oportunidades com alertas de leilões.",
      onClick: () => setActiveWindow("bazar")
    },
  ];

  return (
    <div ref={landingRef} className="h-full w-full flex flex-col items-center justify-center overflow-y-auto relative">
      {/* CAMADA 1 (mais ao fundo): Imagem de fundo */}
      <div
        className="absolute inset-0 pointer-events-none bg-[var(--th-bg-abyss)] animate-in fade-in duration-700"
        style={{
          backgroundImage: `url(${initialBgUrl})`,
          backgroundSize: 'cover',
          backgroundPosition: '50% 50%',
          backgroundRepeat: 'no-repeat',
          zIndex: 0,
        }}
      />
      {/* CAMADA 2: Filtro escuro */}
      <div className="absolute inset-0 bg-[var(--th-bg-abyss)]/85 pointer-events-none" style={{ zIndex: 1 }} />
      {/* CAMADA 2.5: Glow effects */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none" style={{ zIndex: 2 }}>
        <div className="absolute top-[20%] left-[10%] w-[30%] h-[30%] rounded-full bg-red-900/5 blur-[80px]" />
        <div className="absolute bottom-[20%] right-[10%] w-[30%] h-[30%] rounded-full bg-red-950/5 blur-[80px]" />
      </div>
      <div
        className="max-w-4xl w-full relative z-10"
        style={{
          transform: `scale(${landingScale})`,
          transformOrigin: "center center"
        }}
      >
        <div className="text-center space-y-3 py-6">
          <div className="flex items-center justify-center w-full group">
            <ExoriLogo size={72} onClick={onOpenNotif} onMouseDown={(e) => e.stopPropagation()} notificationCount={pendingCount} isNotificationOpen={notificationOpen} className="drop-shadow-[0_0_12px_color-mix(in_oklab,var(--color-red-600)_45%,transparent)] group-hover:drop-shadow-[0_0_20px_color-mix(in_oklab,var(--color-red-600)_80%,transparent)] transition-all" />
          </div>
          <h1 className="text-3xl font-black bg-gradient-to-r from-red-600 via-orange-500 to-yellow-400 bg-clip-text text-transparent tracking-tight" style={{ filter: "drop-shadow(0 0 4px color-mix(in oklab, var(--color-red-600) 55%, transparent)) drop-shadow(0 0 8px color-mix(in oklab, var(--color-red-600) 35%, transparent))" }}>Chernobyl PT</h1>
          <p className="text-emerald-400 text-xs tracking-wide">By Exori Coins</p>
          <p className="text-sm text-slate-400 max-w-lg mx-auto leading-relaxed">
            Gerenciador completo de personagens e PT's do Tibia. Controle total de lucros, drops e histórico de todas as suas aventuras.
          </p>
          <div className="flex items-center justify-center gap-3 pt-2">
            <button
              onClick={onOpenHub}
              className="px-6 py-2.5 text-sm font-bold rounded-xl bg-red-950 border border-red-500/70 text-red-200 hover:text-red-100 hover:bg-red-900 shadow-[0_0_14px_color-mix(in_oklab,var(--color-red-600)_55%,transparent)] hover:shadow-[0_0_20px_color-mix(in_oklab,var(--color-red-600)_75%,transparent)] transition-all hover:scale-105 duration-200 cursor-pointer"
            >
              Abrir Hub Principal
            </button>
            <span className="text-xs text-slate-500">ou clique nos cards abaixo</span>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 pb-6">
          {features.map((feat, idx) => (
            <button
              key={idx}
              onClick={feat.onClick}
              className="flex items-start gap-3 bg-[var(--th-n-raised)]/80 backdrop-blur-sm border border-red-800/30 hover:border-[var(--th-brand)]/60 hover:bg-[var(--th-bg-base)]/90 rounded-xl p-4 transition-all group hover:shadow-lg hover:shadow-red-900/15 hover:-translate-y-0.5 cursor-pointer text-left w-full"
            >
              <div className="w-10 h-10 rounded-lg bg-white/5 flex items-center justify-center flex-shrink-0 group-hover:bg-white/10 transition-colors group-hover:scale-110">
                {feat.icon}
              </div>
              <div className="min-w-0">
                <h3 className="text-sm font-bold text-white mb-1 group-hover:text-emerald-300 transition-colors">{feat.title}</h3>
                <p className="text-[11px] text-slate-400 leading-relaxed">{feat.desc}</p>
              </div>
            </button>
          ))}
        </div>

        <div className="text-center text-[10px] text-slate-600 pb-4">
          ☁️ Sincronização em tempo real na núvem • 💾 Sincronização local automática
        </div>
      </div>
    </div>
  );
}