import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { Plus, Users, X, Lock, LockOpen, RotateCcw, ChevronDown, UserCheck, ArrowDown, ArrowUp, ArrowUpDown, Sparkles, RefreshCw, BarChart3, Eye, EyeOff, MousePointerClick, Coins } from "lucide-react";
import type { Character, CharacterAcquisition, PartyFinalizationReason, PartyTab, WaitingService } from "../types";
import { getCharacterAccountKey } from "../utils/accountIdentity";
import { countPartiesAwaitingPaymentForUser } from "../utils/partyPendingPayment";
import { getPartyParticipation, isPartyVisibleToViewer } from "../utils/partyPermissions";
import { VOCATIONS } from "../types";
import PartyPanel from "./PartyPanel";
import ItemsForSaleModal, { collectUnsoldSaleGroups } from "./ItemsForSaleModal";
import AvailableCharacter, { type OtherPartyInfo } from "./AvailableCharacter";
import RefreshButton from "./RefreshButton";
import ServersPyramidChart from "./ServerGraphic";
import WaitingServiceAvailableList from "./ServiceList";
import SuggestPartyModal from "./SuggestPartyModal";
import OverviewPanel from "./OverviewPanel";
import { type ToggleState } from "./FilterTypes";
import { useAuth } from "../context/AuthContext";
import { SERVER_OPTIONS, isOfficialServer, isSameServer, serverLabel } from "../constants/servers";
// Mesmo hook de persistência utilizado no PartyPanel (reutilização da mesma lógica
// e do mesmo sistema de armazenamento das larguras dos painéis).
function usePersistedState<T>(key: string, initial: T) {
  const [val, setVal] = useState<T>(() => {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : initial; } catch { return initial; }
  });
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} }, [key, val]);
  return [val, setVal] as const;
}
interface Props {
  parties: PartyTab[];
  characters: Character[];
  waitingList: WaitingService[];
  userName: string;
  onUpdate: (party: PartyTab) => void;
  /**
   * Grava a PT imediatamente e confirma o sucesso. Usado pelo "Concluir Quest"
   * para só concluir depois que o snapshot dos participantes estiver salvo.
   */
  onPersistPartyNow?: (party: PartyTab) => Promise<boolean>;
  onDelete: (id: string) => void;
  // O 7º parâmetro `suggestedIds` é opcional. Quando presente, indica que a PT
  // está sendo criada a partir de uma sugestão e os personagens devem ser
  // pré-inseridos automaticamente. Quando ausente, criação manual padrão.
  onCreate: (name: string, ptType?: "soulwar" | "sanguine", horarioTimestamp?: number, visibility?: "public" | "private", invitedUsers?: string[], servidor?: string, suggestedIds?: string[]) => void;
  onSaveParty?: (party: PartyTab) => void;
  activePt: string | null;
  setActivePt: (id: string | null) => void;
  minimized: Record<string, boolean>;
  setMinimized: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  onPaymentMarked?: (info: { partyId: string; partyName: string; paidBy: string; amount: number; ownerUid?: string }) => void;
  onNotifyMembers?: (party: PartyTab) => void;
  onRequestFinalization?: (party: PartyTab, reason: PartyFinalizationReason) => Promise<{ ok: boolean; error?: string }>;
  onRefresh?: () => Promise<void>;
  characterAcquisitions?: CharacterAcquisition[];
  onCreateCharacterAcquisition?: (input: {
    partyId: string;
    characterId: string;
    originalCharacterCost: number;
    personalFee: 0 | 25 | 50;
  }) => Promise<{ ok: boolean; error?: string }>;
  onConfirmCharacterAcquisitionPayment?: (acquisitionId: string) => Promise<{ ok: boolean; error?: string }>;
  // Chamado pelo PartyManager ao montar (aba "PT's" ativa).
  // O App.tsx usa este callback para buscar PTs públicas via getDocs()
  // de forma sob demanda, em vez de manter um listener contínuo.
  onTabChange?: () => void;
  publicPartiesEnabled?: boolean;
}

// ============================================================================
// ESTÁGIOS DE UMA PT — fonte única da categorização do seletor
// ----------------------------------------------------------------------------
// A classificação reaproveita exatamente os estados que o PartyPanel já usa
// (`questConcluida`, `ptStartedAt`, contagem de participantes vs. slots), sem
// criar flags paralelas. Os estágios são mutuamente exclusivos e avaliados em
// ordem de precedência — uma PT nunca aparece em duas categorias:
//   1. aguardando — Quest concluída, PT ainda não finalizada (`questConcluida`;
//      PTs finalizadas são arquivadas e nem chegam a este componente).
//   2. iniciadas  — Quest em andamento OU pausada (`ptStartedAt` setado; a
//      pausa não zera o início — mesma leitura do `questState` do PartyPanel).
//   3. prontas    — todos os slots preenchidos, Quest ainda não iniciada.
//   4. comVagas   — ainda há slots livres.
// ============================================================================
export type PartyStage = "comVagas" | "prontas" | "iniciadas" | "aguardando";

export function getPartyStage(p: PartyTab): PartyStage {
  if (p.questConcluida) return "aguardando";
  if (p.ptStartedAt || p.isPaused) return "iniciadas";
  const total = p.selectedIds.length + (p.customMembers?.length || 0);
  if (total >= p.slots) return "prontas";
  return "comVagas";
}

// Identidade visual de cada estágio: a MESMA cor do botão seletor é aplicada
// ao card/aba da PT (aberta e fechada), mantendo contraste e legibilidade.
const STAGE_THEME: Record<PartyStage, {
  label: string;
  /** Botão seletor ativo. */
  btnActive: string;
  /** Botão seletor inativo. */
  btnIdle: string;
  /**
   * Classes do pulso de borda (src/index.css): keyframe único parametrizado
   * pela cor da categoria. Aplicado ao botão NÃO selecionado quando o gatilho
   * do estágio dispara (ver render dos seletores).
   */
  pulse: string;
  /** Card/aba da PT aberta (ativa e não minimizada). */
  tabOpened: string;
  /** Card/aba da PT fechada/minimizada. */
  tabClosed: string;
  /** Selo do contador de slots (apenas Com Vagas) — aberto/fechado. */
  counterOpened: string;
  counterClosed: string;
}> = {
  comVagas: {
    label: "Com Vagas",
    btnActive: "bg-violet-500/15 border-violet-500/50 text-violet-300 shadow-[0_0_8px_rgba(139,92,246,0.15)]",
    // Sem PTs na categoria: borda FIXA na cor do seletor (mesmo tom do vale
    // do pulso, para a transição pulsando ↔ parado ser imperceptível).
    btnIdle: "bg-black/20 border-violet-500/30 text-slate-500 hover:text-violet-300 hover:bg-violet-500/10 hover:border-violet-500/40",
    pulse: "pt-stage-pulse pt-stage-pulse--violet",
    tabOpened: "bg-gradient-to-b from-violet-500/20 to-violet-600/10 border border-violet-500/60 text-violet-200 shadow-[0_0_10px_rgba(139,92,246,0.18)]",
    tabClosed: "border border-violet-500/15 text-violet-400/60 hover:text-violet-300 hover:border-violet-500/30 hover:bg-violet-500/[0.06] bg-transparent",
    counterOpened: "bg-violet-500/25 text-violet-200",
    counterClosed: "bg-violet-500/10 text-violet-400/60",
  },
  prontas: {
    label: "Prontas",
    btnActive: "bg-emerald-500/15 border-emerald-500/50 text-emerald-300 shadow-[0_0_8px_rgba(16,185,129,0.15)]",
    btnIdle: "bg-black/20 border-emerald-500/30 text-slate-500 hover:text-emerald-300 hover:bg-emerald-500/10 hover:border-emerald-500/40",
    pulse: "pt-stage-pulse pt-stage-pulse--emerald",
    tabOpened: "bg-gradient-to-b from-emerald-500/20 to-emerald-600/10 border border-emerald-500/60 text-emerald-200 shadow-[0_0_10px_rgba(16,185,129,0.18)]",
    tabClosed: "border border-emerald-500/15 text-emerald-400/60 hover:text-emerald-300 hover:border-emerald-500/30 hover:bg-emerald-500/[0.06] bg-transparent",
    counterOpened: "bg-emerald-500/25 text-emerald-200",
    counterClosed: "bg-emerald-500/10 text-emerald-400/60",
  },
  iniciadas: {
    label: "Iniciadas",
    btnActive: "bg-sky-500/15 border-sky-500/50 text-sky-300 shadow-[0_0_8px_rgba(14,165,233,0.15)]",
    btnIdle: "bg-black/20 border-sky-500/30 text-slate-500 hover:text-sky-300 hover:bg-sky-500/10 hover:border-sky-500/40",
    pulse: "pt-stage-pulse pt-stage-pulse--sky",
    tabOpened: "bg-gradient-to-b from-sky-500/20 to-sky-600/10 border border-sky-500/60 text-sky-200 shadow-[0_0_10px_rgba(14,165,233,0.18)]",
    tabClosed: "border border-sky-500/15 text-sky-400/60 hover:text-sky-300 hover:border-sky-500/30 hover:bg-sky-500/[0.06] bg-transparent",
    counterOpened: "bg-sky-500/25 text-sky-200",
    counterClosed: "bg-sky-500/10 text-sky-400/60",
  },
  aguardando: {
    label: "Aguardando Pagamento",
    btnActive: "bg-amber-500/15 border-amber-500/50 text-amber-300 shadow-[0_0_8px_color-mix(in_oklab,var(--color-amber-500)_15%,transparent)]",
    btnIdle: "bg-black/20 border-amber-500/30 text-slate-500 hover:text-amber-300 hover:bg-amber-500/10 hover:border-amber-500/40",
    pulse: "pt-stage-pulse pt-stage-pulse--amber",
    tabOpened: "bg-gradient-to-b from-amber-500/20 to-amber-600/10 border border-amber-500/60 text-amber-200 shadow-[0_0_10px_color-mix(in_oklab,var(--color-amber-500)_15%,transparent)]",
    tabClosed: "border border-amber-500/15 text-amber-400/60 hover:text-amber-300 hover:border-amber-500/30 hover:bg-amber-500/[0.05] bg-transparent",
    counterOpened: "bg-amber-600/25 text-amber-300",
    counterClosed: "bg-amber-500/10 text-amber-400/50",
  },
};

const STAGE_ORDER: PartyStage[] = ["comVagas", "prontas", "iniciadas", "aguardando"];

export default function PartyManager({ parties, characters, waitingList, userName, onUpdate, onPersistPartyNow, onDelete, onCreate, onSaveParty, activePt, setActivePt, minimized, setMinimized, onPaymentMarked, onNotifyMembers, onRequestFinalization, onRefresh, characterAcquisitions = [], onCreateCharacterAcquisition, onConfirmCharacterAcquisitionPayment, onTabChange, publicPartiesEnabled = true }: Props) {
  const { currentUser, userProfile, allUsers, acceptedFriendUids } = useAuth();
  const isNormalUser = userProfile?.role === "Normal";
  const tabsContainerRef = useRef<HTMLDivElement>(null);
  const [showCreate, setShowCreate] = useState(false);

  function ensurePartyVisibleState(target: PartyTab) {
    if (!target) return;

    if (minimized[target.id]) {
      setMinimized(m => (m[target.id] ? { ...m, [target.id]: false } : m));
    }

    const targetStatusView = getPartyStage(target);
    if (ptStatusView !== targetStatusView) {
      setPtStatusView(targetStatusView);
    }

    if (filterServer && (target.servidor || "") !== filterServer) {
      setFilterServer("");
      setServerDropOpen(false);
    }

    if (filterPrivate && !filterPublic && target.visibility !== "private") {
      setFilterPrivate(false);
    }
    if (filterPublic && !filterPrivate && target.visibility === "private") {
      setFilterPublic(false);
    }

    if (filterMine) {
      const uid = currentUser?.uid;
      const participation = !!uid && getPartyParticipation(target,
        { uid, userName, role: userProfile?.role },
        (id) => characters.find(c => c.id === id)?.ownerUid || target.memberSnapshots?.[id]?.ownerUid);
      if (!participation || !participation.isParticipant) {
        setFilterMine(false);
      }
    }
  }
  const [newPtType, setNewPtType] = useState<"soulwar" | "sanguine">("soulwar");
  const [newHorario, setNewHorario] = useState("");
  const [newDate, setNewDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [newVisibility, setNewVisibility] = useState<"public" | "private">("public");
  const [newServidor, setNewServidor] = useState("");
  const [serverSearch, setServerSearch] = useState("");
  const [servidorMenuOpen, setServidorMenuOpen] = useState(false);
  const [isCreatingParty, setIsCreatingParty] = useState(false);
  const pendingManualCreateRef = useRef<{
    existingIds: string[];
    servidor: string;
    ptType: "soulwar" | "sanguine";
    visibility: "public" | "private";
    horarioTimestamp?: number;
  } | null>(null);
  const handleWheel = (e: React.WheelEvent) => {
    if (tabsContainerRef.current) {
      tabsContainerRef.current.scrollLeft += e.deltaY;
    }
  };
  // ============================================================================
  // FLUXO "SUGERIR PT"
  // ============================================================================
  // O modal SuggestPartyModal é aberto a partir do botão "Sugerir PT" (ao lado
  // do botão "Criar PT"). Ao clicar em "Salvar PT" dentro do SuggestPartyModal,
  // a PT é criada diretamente no Firestore (sem abrir o modal "Criar PT"),
  // populando slotData/members/invitedUsers e disparando a notificação
  // "Você foi adicionado a uma PT" para cada participante via createParty().
  const [showSuggestModal, setShowSuggestModal] = useState(false);

  // Notifica o App.tsx que a aba "PT's" está ativa (montagem do componente).
  // O App.tsx usa este callback para buscar PTs públicas via getDocs() sob demanda.
  useEffect(() => {
    onTabChange?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Lista oficial centralizada em src/constants/servers.ts
  const CREATE_PT_SERVERS = SERVER_OPTIONS;

  const filteredServerOptions = useMemo(() => {
    const list = [...CREATE_PT_SERVERS].sort((a, b) => a.localeCompare(b, "pt-BR"));
    if (!serverSearch) return list;
    const lower = serverSearch.toLowerCase();
    return list.filter(s => s.toLowerCase().includes(lower));
  }, [serverSearch]);

  const [filterPrivate, setFilterPrivate] = useState(false);
  const [filterPublic, setFilterPublic] = useState(false);
  const [filterMine, setFilterMine] = useState(false);
  const [ptStatusView, setPtStatusView] = useState<PartyStage>("comVagas");
  const [filterServer, setFilterServer] = useState("");
  const [serverDropOpen, setServerDropOpen] = useState(false);
  const serverBtnRef = useRef<HTMLButtonElement>(null);
  const serverMenuRef = useRef<HTMLDivElement>(null);
  const [serverDropPos, setServerDropPos] = useState({ top: 0, left: 0 });
  // ===== STANDALONE BOTTOM PANELS STATE (when no PT is selected) =====
  // Redimensionamento lateral dos 3 painéis — mesma lógica, persistência e
  // aparência do PartyPanel. A chave é a MESMA (`pt_panels_global_{uid}`),
  // mantendo as larguras sincronizadas entre a visão da PT e a Visão Geral.
  const [standalonePanelWidths, setStandalonePanelWidths] = usePersistedState<{ p1: number; p2: number; p3: number }>(`pt_panels_global_${currentUser?.uid || userName || "default"}`, { p1: 38, p2: 16, p3: 46 });
  const [standaloneDraggingPanel, setStandaloneDraggingPanel] = useState<"left" | "right" | "pair" | null>(null);
  const standalonePanelsRef = useRef<HTMLDivElement>(null);
  // ── GUIA EXIBIDA QUANDO NENHUMA PT ESTÁ ABERTA ─────────────────────────
  // "selectPrompt" (padrão) → tela "Selecione uma PT";
  // "overview"              → guia "Visão Geral" (somente OverviewPanel);
  // "allChars"              → guia "Todos Personagens" (3 painéis).
  // Abrir uma PT retorna a área standalone ao padrão: minimizá-la depois
  // volta a exibir "Selecione uma PT" (regra: nenhuma PT selecionada).
  const [standaloneView, setStandaloneView] = useState<"selectPrompt" | "overview" | "allChars">("selectPrompt");
  useEffect(() => {
    if (activePt) setStandaloneView("selectPrompt");
  }, [activePt]);
  // ── VISIBILIDADE INDIVIDUAL DOS 3 PAINÉIS (guia "Todos Personagens") ───
  // Persistida por usuário; cada painel liga/desliga de forma independente
  // e os visíveis reaproveitam o espaço liberado.
  const [panelVisibility, setPanelVisibility] = usePersistedState<{ available: boolean; chart: boolean; waiting: boolean }>(
    `pt_allchars_panels_${currentUser?.uid || userName || "default"}`,
    { available: true, chart: true, waiting: true },
  );
  // Larguras persistidas POR COMBINAÇÃO de painéis visíveis:
  //   • 3 visíveis → `standalonePanelWidths` (p1/p2/p3 — chave/semântica
  //     preservadas do comportamento anterior);
  //   • 2 visíveis → % do painel esquerdo em `pairWidths[combo]`, onde
  //     combo é "ac"/"aw"/"cw" (available/chart/waiting, na ordem fixa).
  // Assim cada arranjo lembra o último ajuste feito pelo usuário.
  const [pairWidths, setPairWidths] = usePersistedState<Record<string, number>>(
    `pt_allchars_pairs_${currentUser?.uid || userName || "default"}`,
    {},
  );
  const visiblePanelKeys = useMemo(() => {
    const keys: Array<"available" | "chart" | "waiting"> = [];
    if (panelVisibility.available) keys.push("available");
    if (panelVisibility.chart) keys.push("chart");
    if (panelVisibility.waiting) keys.push("waiting");
    return keys;
  }, [panelVisibility]);
  const pairComboKey = visiblePanelKeys.length === 2 ? visiblePanelKeys.map(k => k[0]).join("") : "";
  const PAIR_DEFAULT_WIDTHS: Record<string, number> = { ac: 65, aw: 50, cw: 30 };
  useEffect(() => {
    if (!standaloneDraggingPanel) return;
    const dragMode = standaloneDraggingPanel;
    const comboKey = pairComboKey;
    function onMove(e: MouseEvent) {
      if (!standalonePanelsRef.current) return;
      const rect = standalonePanelsRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const totalW = rect.width || 1;
      const curPct = Math.max(15, Math.min(85, (x / totalW) * 100));
      if (dragMode === "pair") {
        // Dois painéis visíveis: o divisor único define a % do esquerdo.
        if (comboKey) setPairWidths(prev => ({ ...prev, [comboKey]: Math.round(curPct) }));
        return;
      }
      setStandalonePanelWidths(prev => {
        if (dragMode === "left") {
          const maxPossible = 100 - prev.p3 - 10;
          const newP1 = Math.max(15, Math.min(maxPossible, curPct));
          const newP2 = 100 - newP1 - prev.p3;
          return { p1: Math.round(newP1), p2: Math.round(newP2), p3: prev.p3 };
        } else {
          const minPossible = prev.p1 + 10;
          const newLeftSum = Math.max(minPossible, Math.min(85, curPct));
          const newP2 = newLeftSum - prev.p1;
          const newP3 = 100 - newLeftSum;
          return { p1: prev.p1, p2: Math.round(newP2), p3: Math.round(newP3) };
        }
      });
    }
    function onUp() {
      setStandaloneDraggingPanel(null);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [standaloneDraggingPanel, pairComboKey]);
  function shortAccountMask(index: number): string {
    const num = (index % 9) + 1;
    let letterIndex = Math.floor(index / 9);
    let suffix = "";
    do {
      suffix = String.fromCharCode(97 + (letterIndex % 26)) + suffix;
      letterIndex = Math.floor(letterIndex / 26) - 1;
    } while (letterIndex >= 0);
    return `${num}${suffix}`;
  }
  const [standaloneSortKey, setStandaloneSortKey] = useState<string | null>(null);
  const [standaloneSortDir, setStandaloneSortDir] = useState<"asc" | "desc" | null>(null);
  // ── FILTROS PERSISTENTES da vista "Todos Personagens" ────────────────────
  // Mesma mecânica dos filtros por PT do PartyPanel (`pt_*_${party.id}`),
  // aqui com chave por usuário: sair da guia, trocar de vista ou remontar o
  // componente NÃO reseta os filtros — eles voltam exatamente como estavam.
  // (Inclui o filtro de servidor acionado pelo gráfico "Oportunidade por
  // Servidor", que grava em `standaloneFilterServer` + `standaloneWlFilters`.)
  const standaloneFilterKey = currentUser?.uid || userName || "default";
  const [standaloneFilterPersonagem, setStandaloneFilterPersonagem] = usePersistedState(`pt_allchars_f_personagem_${standaloneFilterKey}`, "");
  const [standaloneFilterServer, setStandaloneFilterServer] = usePersistedState(`pt_allchars_f_srv_${standaloneFilterKey}`, "");
  const [standaloneFilterVoc, setStandaloneFilterVoc] = usePersistedState(`pt_allchars_f_voc_${standaloneFilterKey}`, "");
  const [standaloneFilterLevel, setStandaloneFilterLevel] = usePersistedState(`pt_allchars_f_lvl_${standaloneFilterKey}`, "");
  const [standaloneFilterLevelOp, setStandaloneFilterLevelOp] = usePersistedState<"gte" | "lte">(`pt_allchars_f_lvlop_${standaloneFilterKey}`, "gte");
  const [standaloneFilterSW, setStandaloneFilterSW] = usePersistedState<ToggleState>(`pt_allchars_f_sw_${standaloneFilterKey}`, "off");
  const [standaloneFilterSG, setStandaloneFilterSG] = usePersistedState<ToggleState>(`pt_allchars_f_sg_${standaloneFilterKey}`, "off");
  const [standaloneFilterDonos, setStandaloneFilterDonos] = usePersistedState<string[]>(`pt_allchars_f_donos_${standaloneFilterKey}`, []);
  const [standaloneSmartAccountFilter, setStandaloneSmartAccountFilter] = usePersistedState(`pt_allchars_f_smart_${standaloneFilterKey}`, false);
  const [standaloneWlFilters, setStandaloneWlFilters] = usePersistedState<Record<string, string>>(`pt_allchars_f_wl_${standaloneFilterKey}`, {});
  const [standaloneIsRefreshing, setStandaloneIsRefreshing] = useState(false);
  const [standaloneRefreshDone, setStandaloneRefreshDone] = useState(false);
  const standaloneGetCharOwner = (c: Character) => (c as any).ownerName || userName || "—";
  // Indexado pela IDENTIDADE da conta (`ownerUid + nome`), igual ao
  // PartyPanel: contas homônimas de usuários diferentes recebem códigos
  // fictícios diferentes.
  const standaloneAccountMap = useMemo(() => {
    const keys = Array.from(new Set(
      characters.map(c => getCharacterAccountKey(c)).filter((k): k is string => !!k),
    )).sort();
    const map: Record<string, string> = {};
    keys.forEach((key, index) => { map[key] = shortAccountMask(index); });
    return map;
  }, [characters]);

  /** Código fictício, com fallback para snapshots antigos (já são o código). */
  const standaloneAccountLabelFor = (character: Character) => {
    const key = getCharacterAccountKey(character);
    if (key && standaloneAccountMap[key]) return standaloneAccountMap[key];
    return String(character.account || "");
  };
  const standaloneIdsInOtherParties = useMemo(() => {
    const set = new Set<string>();
    parties.forEach(p => { p.selectedIds.forEach(id => set.add(id)); });
    return set;
  }, [parties]);
  // Tooltip do ⚠ "em outra PT" na lista standalone: nome da PT + Quest,
  // derivados das mesmas `parties` que alimentam o Set acima — tudo já está
  // em memória, sem nenhuma leitura extra do Firestore.
  const standaloneOtherPartiesInfoFor = useCallback((characterId: string) => {
    const infos: OtherPartyInfo[] = [];
    parties.forEach(p => {
      if (!p.selectedIds.includes(characterId)) return;
      infos.push({
        name: String(p.name || "").trim() || "PT sem nome",
        questLabel: p.ptType === "sanguine" ? "Sanguine" : p.ptType === "soulwar" ? "Soul War" : "Quest não definida",
        statusNote: p.archived ? (p.questFalha ? "falhou" : "finalizada") : undefined,
      });
    });
    return infos.length ? infos : undefined;
  }, [parties]);
  const standaloneServerOptions = useMemo(() => Array.from(new Set(characters.map(c => serverLabel(c.servidor)).filter(Boolean))).sort(), [characters]);
  const standaloneVocOptions = useMemo(() => VOCATIONS.filter(v => characters.some(c => c.voc === v)), [characters]);
  const standaloneDonoOptions = useMemo(() => Array.from(new Set(characters.map(standaloneGetCharOwner))).sort(), [characters, userName]);
  const standaloneAvailable = useMemo(() => {
    return characters.filter(c => {
      if (c.shared === false) return false;
      if (!c.soulwar && !c.sanguine) return false;
      if (standaloneFilterPersonagem && !c.personagem.toLowerCase().includes(standaloneFilterPersonagem.toLowerCase())) return false;
      if (standaloneFilterServer && !isSameServer(c.servidor, standaloneFilterServer)) return false;
      if (standaloneFilterVoc && c.voc !== standaloneFilterVoc) return false;
      if (standaloneFilterSW === "yes" && !c.soulwar) return false;
      if (standaloneFilterSW === "no" && c.soulwar) return false;
      if (standaloneFilterSG === "yes" && !c.sanguine) return false;
      if (standaloneFilterSG === "no" && c.sanguine) return false;
      if (standaloneFilterLevel) { const t = parseInt(standaloneFilterLevel, 10); if (Number.isFinite(t)) { if (standaloneFilterLevelOp === "gte" && c.level < t) return false; if (standaloneFilterLevelOp === "lte" && c.level > t) return false; } }
      if (standaloneFilterDonos.length > 0 && !standaloneFilterDonos.includes(standaloneGetCharOwner(c))) return false;
      return true;
    });
  }, [characters, standaloneFilterPersonagem, standaloneFilterServer, standaloneFilterVoc, standaloneFilterSW, standaloneFilterSG, standaloneFilterLevel, standaloneFilterLevelOp, standaloneFilterDonos, userName]);
  const standaloneSortedAvailable = useMemo(() => {
    if (!standaloneSortKey || !standaloneSortDir) return standaloneAvailable;
    const arr = [...standaloneAvailable].sort((a, b) => {
      let av: any, bv: any;
      if (standaloneSortKey === "account") { av = standaloneAccountLabelFor(a); bv = standaloneAccountLabelFor(b); }
      else if (standaloneSortKey === "servidor") { av = a.servidor; bv = b.servidor; }
      else if (standaloneSortKey === "voc") { av = a.voc; bv = b.voc; }
      else if (standaloneSortKey === "level") { av = a.level; bv = b.level; }
      else if (standaloneSortKey === "soulwar") { av = a.soulwar ? 1 : 0; bv = b.soulwar ? 1 : 0; }
      else if (standaloneSortKey === "sanguine") { av = a.sanguine ? 1 : 0; bv = b.sanguine ? 1 : 0; }
      else return 0;
      if (typeof av === "number" && typeof bv === "number") return av - bv;
      return String(av).localeCompare(String(bv), "pt-BR", { sensitivity: "base" });
    });
    return standaloneSortDir === "desc" ? arr.reverse() : arr;
  }, [standaloneAvailable, standaloneSortKey, standaloneSortDir, standaloneAccountMap]);
  const standaloneVisibleWaitingList = useMemo(() => {
    return waitingList.filter(i => {
      if (standaloneWlFilters.personagem && !i.personagem.toLowerCase().includes(standaloneWlFilters.personagem.toLowerCase())) return false;
      // Igualdade EXATA: o valor vem de um seletor de servidores (nome completo).
      // Com includes(), "Grimoria I" casava também com "Grimoria II/III/IV".
      if (standaloneWlFilters.servidor && !isSameServer(i.servidor, standaloneWlFilters.servidor)) return false;
      if (standaloneWlFilters.voc && i.voc !== standaloneWlFilters.voc) return false;
      if (standaloneWlFilters.ownerName && !i.ownerName.toLowerCase().includes(standaloneWlFilters.ownerName.toLowerCase())) return false;
      if (standaloneWlFilters.quest && i.quest !== standaloneWlFilters.quest) return false;
      if (standaloneWlFilters.addedBy && !(i.addedBy || "").toLowerCase().includes(standaloneWlFilters.addedBy.toLowerCase())) return false;
      if (standaloneWlFilters.notes && !i.notes.toLowerCase().includes(standaloneWlFilters.notes.toLowerCase())) return false;
      if (standaloneWlFilters.level) {
        const t = parseInt(standaloneWlFilters.level, 10);
        if (Number.isFinite(t)) {
          const op = standaloneWlFilters.levelOp || "gte";
          if (op === "gte" && (i.level || 0) < t) return false;
          if (op === "lte" && (i.level || 0) > t) return false;
        }
      }
      return true;
    });
  }, [waitingList, standaloneWlFilters]);
  function standaloneToggleSort(key: string) { if (standaloneSortKey !== key) { setStandaloneSortKey(key); setStandaloneSortDir("asc"); } else if (standaloneSortDir === "asc") setStandaloneSortDir("desc"); else { setStandaloneSortDir(null); setStandaloneSortKey(null); } }
  function standaloneResetFilters() {
    setStandaloneFilterPersonagem("");
    setStandaloneFilterServer("");
    setStandaloneFilterVoc("");
    setStandaloneFilterLevel("");
    setStandaloneFilterLevelOp("gte");
    setStandaloneFilterSW("off");
    setStandaloneFilterSG("off");
    setStandaloneSmartAccountFilter(false);
    setStandaloneFilterDonos([]);
  }
  async function standaloneHandleRefresh() {
    if (standaloneIsRefreshing || !onRefresh) return;
    setStandaloneIsRefreshing(true);
    setStandaloneRefreshDone(false);
    try { await onRefresh(); setStandaloneRefreshDone(true); setTimeout(() => setStandaloneRefreshDone(false), 2000); } catch {}
    finally { setStandaloneIsRefreshing(false); }
  }
  function standaloneHandleServerChartClick(srv: string) {
    const isActive = standaloneFilterServer === srv && standaloneWlFilters.servidor === srv;
    if (isActive) {
      setStandaloneFilterServer("");
      setStandaloneWlFilters(f => { const next = { ...f }; delete next.servidor; return next; });
    } else {
      setStandaloneFilterServer(srv);
      setStandaloneWlFilters(f => ({ ...f, servidor: srv }));
    }
  }
  function StandaloneSI({ col }: { col: string }) {
    if (standaloneSortKey === col && standaloneSortDir === "asc") return <ArrowUp size={12} className="text-red-400" />;
    if (standaloneSortKey === col && standaloneSortDir === "desc") return <ArrowDown size={12} className="text-red-400" />;
    return <ArrowUpDown size={12} className="opacity-30" />;
  }
  const standaloneThCls = "bg-[var(--th-bg-overlay)] px-3 py-1.5 border-b border-red-900/20 cursor-pointer hover:bg-[var(--th-bg-hover)] select-none";
  const standaloneHdr = "flex items-center gap-1.5 text-xs uppercase tracking-wider text-slate-300 font-semibold";

  useEffect(() => {
    if (serverDropOpen && serverBtnRef.current) {
      const rect = serverBtnRef.current.getBoundingClientRect();
      setServerDropPos({
        top: rect.bottom + 4,
        left: Math.max(8, Math.min(rect.right - 176, window.innerWidth - 184)),
      });
    }
  }, [serverDropOpen]);

  useEffect(() => {
    if (!serverDropOpen) return;
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as Node;
      if (serverBtnRef.current?.contains(target) || serverMenuRef.current?.contains(target)) return;
      setServerDropOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [serverDropOpen]);

  const ptServerOptions = useMemo(() => {
    return Array.from(new Set(parties.map(p => p.servidor).filter(Boolean) as string[])).sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [parties]);

  // ============================================================================
  // SINCRONIZAÇÃO AUTOMÁTICA DE CATEGORIA AO CONCLUIR QUEST
  // ============================================================================
  // Sempre que a PT atualmente selecionada (activePt) mudar de estágio
  // (Com Vagas → Prontas → Iniciadas → Aguardando Pagamento, ou o caminho
  // reverso), trocamos automaticamente a categoria visível para o estágio
  // real da PT. Isto garante que a PT permaneça visível e selecionada sem
  // exigir nenhuma ação manual do usuário (sincronização via Firestore).
  useEffect(() => {
    if (!activePt) return;
    const current = parties.find(p => p.id === activePt);
    if (!current) return;
    ensurePartyVisibleState(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePt, parties, minimized, filterServer, filterPrivate, filterPublic, filterMine, currentUser?.uid, characters]);

  // Navegação local por evento: quando o gerenciador já está montado, permite
  // abrir a PT imediatamente mesmo sem depender de remontagem da aba.
  useEffect(() => {
    function handleNavigateToParty(event: Event) {
      const customEvent = event as CustomEvent<{ partyId?: string }>;
      const partyId = customEvent.detail?.partyId;
      if (!partyId) return;
      const target = parties.find(p => p.id === partyId);
      if (!target) return;
      setActivePt(partyId);
      ensurePartyVisibleState(target);
    }

    window.addEventListener("pt-navigate-request", handleNavigateToParty as EventListener);
    return () => window.removeEventListener("pt-navigate-request", handleNavigateToParty as EventListener);
  }, [parties, setActivePt, minimized, filterServer, filterPrivate, filterPublic, filterMine, currentUser?.uid, characters]);

  // Quando uma PT é selecionada externamente, garante que a aba correspondente
  // fique visível no carrossel horizontal de PT's.
  useEffect(() => {
    if (!activePt || !tabsContainerRef.current) return;
    const tabEl = tabsContainerRef.current.querySelector<HTMLElement>(`[data-party-tab-id="${activePt}"]`);
    if (!tabEl) return;
    const raf = window.requestAnimationFrame(() => {
      tabEl.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    });
    return () => window.cancelAnimationFrame(raf);
  }, [activePt, parties, ptStatusView, filterServer, filterPrivate, filterPublic, filterMine]);

  const baseFilteredParties = useMemo(() => {
    const uid = currentUser?.uid;
    return parties.filter(p => {
      if (filterPrivate && !filterPublic && p.visibility !== "private") return false;
      if (filterPublic && !filterPrivate && p.visibility === "private") return false;
      if (filterServer && (p.servidor || "") !== filterServer) return false;
      // Visibilidade pela fonte única (utils/partyPermissions): PT pública
      // iniciada deixa de existir para não-participantes; participar por
      // DONO ou JOGADOR conta igual. Normal só vê as próprias (vagas em PTs
      // são exclusivas de VIP — regra atual do app).
      if (!isPartyVisibleToViewer(p, { uid: uid || "", userName, role: userProfile?.role },
        (id) => characters.find(c => c.id === id)?.ownerUid || p.memberSnapshots?.[id]?.ownerUid)) {
        return false;
      }
      if (filterMine || isNormalUser) {
        // Mostrar apenas PTs que o usuário criou OU em que participa
        // (personagem próprio na composição OU como JOGADOR de algum slot).
        if (!uid) return false;
        const participation = getPartyParticipation(p,
          { uid, userName, role: userProfile?.role },
          (id) => characters.find(c => c.id === id)?.ownerUid || p.memberSnapshots?.[id]?.ownerUid);
        if (!participation.isParticipant) return false;
      }
      return true;
    });
  }, [parties, filterPrivate, filterPublic, filterServer, filterMine, isNormalUser, currentUser?.uid, userName, userProfile?.role, characters]);

  // Agrupamento por estágio — uma única passada; os grupos são mutuamente
  // exclusivos porque getPartyStage devolve exatamente um estágio por PT.
  const partiesByStage = useMemo(() => {
    const groups: Record<PartyStage, PartyTab[]> = { comVagas: [], prontas: [], iniciadas: [], aguardando: [] };
    baseFilteredParties.forEach(p => { groups[getPartyStage(p)].push(p); });
    return groups;
  }, [baseFilteredParties]);
  const pendentesParties = partiesByStage.aguardando;

  // ── ITENS A VENDA ───────────────────────────────────────────────────────
  // Itens dropados AINDA NÃO VENDIDOS nas PTs "Aguardando Pagamento" que o
  // usuário atual pode ver. As PTs consideradas aplicam SOMENTE as regras de
  // ACESSO da lista (isPartyVisibleToViewer + participação p/ Normal — as
  // mesmas de baseFilteredParties), ignorando de propósito os filtros
  // visuais (servidor/privada/pública/minhas): o modal reflete tudo a que o
  // usuário tem acesso, não o recorte momentâneo da tela. A lista é
  // individual por usuário — e 100% local: nenhuma consulta extra ao
  // Firestore, apenas os documentos que o painel já escuta em tempo real.
  const [showItemsForSale, setShowItemsForSale] = useState(false);
  const itemsForSaleParties = useMemo(() => {
    const uid = currentUser?.uid;
    return parties.filter(p => {
      if (getPartyStage(p) !== "aguardando") return false;
      if (!isPartyVisibleToViewer(p, { uid: uid || "", userName, role: userProfile?.role },
        (id) => characters.find(c => c.id === id)?.ownerUid || p.memberSnapshots?.[id]?.ownerUid)) {
        return false;
      }
      if (isNormalUser) {
        if (!uid) return false;
        const participation = getPartyParticipation(p,
          { uid, userName, role: userProfile?.role },
          (id) => characters.find(c => c.id === id)?.ownerUid || p.memberSnapshots?.[id]?.ownerUid);
        if (!participation.isParticipant) return false;
      }
      return true;
    });
  }, [parties, currentUser?.uid, userName, userProfile?.role, isNormalUser, characters]);
  const unsoldItemsCount = useMemo(
    () => collectUnsoldSaleGroups(itemsForSaleParties, characters, waitingList)
      .reduce((s, g) => s + g.items.length, 0),
    [itemsForSaleParties, characters, waitingList],
  );

  // PTs que são pendências de pagamento REAIS para o usuário logado: lideradas
  // por ele (deve pagar os membros) ou com slot da divisão ainda não pago
  // beneficiando-o (deve receber). Participantes sem participação financeira
  // não contam — a mesma regra de `viewerUids` da Cloud Function de settlement.
  // Cálculo local sobre os documentos que o painel já escuta (tempo real,
  // nenhum listener/leitura extra do Firestore).
  const pendingPaymentForUserCount = useMemo(
    () => countPartiesAwaitingPaymentForUser(pendentesParties, currentUser?.uid),
    [pendentesParties, currentUser?.uid],
  );

  const filteredParties = useMemo(() => {
    return partiesByStage[ptStatusView];
  }, [ptStatusView, partiesByStage]);

  function resetFilters() {
    setFilterPrivate(false);
    setFilterPublic(false);
    setFilterMine(false);
    setFilterServer("");
    setServerDropOpen(false);
  }

  const [invitedUsers, setInvitedUsers] = useState<string[]>([]);
  const [createInviteSearch, setCreateInviteSearch] = useState("");

  // ============================================================================
  // Lista de usuários autorizáveis na criação de PT privada.
  // Usa a fonte central de amigos aceitos do AuthContext, sem criar consultas extras.
  // ============================================================================
  const approvedUsers = useMemo(() => {
    const friendUidSet = new Set(acceptedFriendUids || []);
    return allUsers
      .filter(u => u.status === "aprovado" && friendUidSet.has(u.uid))
      .map(u => ({ uid: u.uid, nome: u.nome }));
  }, [allUsers, acceptedFriendUids]);

  useEffect(() => {
  const handleTrayOpenCreatePt = () => { setShowCreate(true); };
  window.addEventListener('tray-open-create-pt', handleTrayOpenCreatePt);
  return () => window.removeEventListener('tray-open-create-pt', handleTrayOpenCreatePt);
}, []);

  function resetCreateForm() {
    setNewPtType("soulwar");
    setNewHorario("");
    setNewDate(new Date().toISOString().slice(0, 10));
    setNewVisibility(publicPartiesEnabled ? "public" : "private");
    setInvitedUsers([]);
    setCreateInviteSearch("");
    setNewServidor("");
    setServerSearch("");
    setServidorMenuOpen(false);
  }

  function cancelCreateModal() {
    setIsCreatingParty(false);
    pendingManualCreateRef.current = null;
    setShowCreate(false);
  }

  useEffect(() => {
    if (!publicPartiesEnabled && newVisibility === "public") {
      setNewVisibility("private");
    }
  }, [publicPartiesEnabled, newVisibility]);

  useEffect(() => {
    if (!isCreatingParty || !pendingManualCreateRef.current) return;
    const pending = pendingManualCreateRef.current;
    const existingIds = new Set(pending.existingIds);
    const foundParty = parties.find((p) => {
      if (existingIds.has(p.id)) return false;
      if (currentUser?.uid && p.leaderUid !== currentUser.uid) return false;
      if ((p.servidor || "") !== pending.servidor) return false;
      if ((p.ptType === "sanguine" ? "sanguine" : "soulwar") !== pending.ptType) return false;
      if ((p.visibility || "public") !== pending.visibility) return false;
      if ((p.selectedIds || []).length > 0) return false;
      return true;
    });
    if (foundParty) {
      setActivePt(foundParty.id);
      setMinimized(m => ({ ...m, [foundParty.id]: false }));
      setIsCreatingParty(false);
      pendingManualCreateRef.current = null;
      setShowCreate(false);
      resetCreateForm();
    }
  }, [parties, isCreatingParty, currentUser?.uid, setActivePt, setMinimized]);

  function handleCreate() {
    if (isCreatingParty) return;
    // Nome da PT é gerado AUTOMATICAMENTE no App.tsx (padrão "#N" com
    // numeração sequencial atômica via Firestore). O usuário não preenche
    // mais o nome — enviamos string vazia, que será substituída pelo nome
    // gerado de forma segura contra concorrência.
    const servidor = newServidor.trim();
    if (!isOfficialServer(servidor)) return;
    let horarioTimestamp: number | undefined;
    if (newDate && newHorario) {
      horarioTimestamp = new Date(`${newDate}T${newHorario}:00`).getTime();
    }

    const finalInvited = newVisibility === "private"
      ? Array.from(new Set([...invitedUsers, currentUser?.uid].filter(Boolean)))
      : undefined;

    // Fluxo "Criar PT" manual (não vindo do SuggestPartyModal): não há suggestedIds.
    // A sugestão de PT usa o fluxo próprio via onCreateFromSuggestion, que cria
    // diretamente a PT com os personagens sugeridos.
    pendingManualCreateRef.current = {
      existingIds: parties.map(p => p.id),
      servidor,
      ptType: newPtType,
      visibility: newVisibility,
      horarioTimestamp,
    };
    setIsCreatingParty(true);
    onCreate("", newPtType, horarioTimestamp, newVisibility, finalInvited, servidor, undefined);
  }

  // O formulário usa a moldura global de modal: viewport limitado e conteúdo
  // rolável, sem reduzir controles via transform em telas pequenas.

  // Auto-select first party if current is gone
  if (activePt && !parties.find(p => p.id === activePt) && parties.length > 0) {
    setActivePt(parties[0].id);
  }

  function toggleMinimize(id: string) {
    setMinimized(m => {
      const next = { ...m, [id]: !m[id] };
      if (next[id]) {
        // Se está minimizando a PT atual, limpa activePt
        if (activePt === id) setActivePt(null);
      } else {
        // Se está expandindo, torna ela a PT ativa
        setActivePt(id);
      }
      return next;
    });
  }

  return (
    <div className="flex flex-col h-full w-full bg-[var(--th-bg-base)]">
      {/* Sub-tabs bar */}
      <div className="flex items-center gap-0.5 px-1 bg-gradient-to-r from-[var(--th-bg-raised)] to-[var(--th-bg-base)] border-b border-[var(--th-line)]/60 flex-shrink-0 overflow-x-auto" style={{ minHeight: "clamp(28px, 3.2vh, 34px)", padding: "clamp(2px, 0.25vh, 4px) clamp(3px, 0.4vw, 6px)" }}>
        <div ref={tabsContainerRef} onWheel={handleWheel} className="flex gap-0.5 bg-[var(--th-bg-base)] p-0.5 rounded-xl border border-[var(--th-brand)]/60 overflow-x-auto max-w-full flex-1">
          {[...filteredParties].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map(p => {
            const total = p.selectedIds.length + (p.customMembers?.length || 0);
            // Card/aba com a MESMA cor do botão seletor do estágio atual da
            // PT — a categoria e o visual sempre andam juntos.
            const stage = getPartyStage(p);
            const theme = STAGE_THEME[stage];
            const isActive = activePt === p.id;
            const isMin = minimized[p.id];
            const isTabOpened = isActive && !isMin;

             return (
                <div key={p.id} className="flex items-center gap-0 group/tab">
                <button
                  data-party-tab-id={p.id}
                  onClick={() => {
                    if (isActive) {
                      toggleMinimize(p.id);
                    } else {
                      setActivePt(p.id);
                      setMinimized(m => ({ ...m, [p.id]: false }));
                    }
                  }}
                  title={isTabOpened ? "Minimizar" : "Abrir PT"}
                  className={`inline-flex items-center gap-1 rounded-lg font-semibold transition-all duration-200 cursor-pointer whitespace-nowrap ${
                    isTabOpened ? theme.tabOpened : theme.tabClosed
                  }`}
                  style={{ padding: "clamp(3px, 0.4vh, 5px) clamp(5px, 0.65vw, 9px)", fontSize: "clamp(10px, 1.2vh, 12px)" }}
                >
                  <Users size={11} className="flex-shrink-0" />
                  <span className="truncate max-w-[60px]">{p.name}</span>
                  {p.ptType === "sanguine" ? (
                    <span className="text-[8px] font-bold px-1 py-px rounded border border-rose-500/30 bg-rose-500/10 text-rose-400 flex-shrink-0">SG</span>
                  ) : p.ptType === "soulwar" ? (
                    <span className="text-[8px] font-bold px-1 py-px rounded border border-slate-500/30 bg-slate-500/10 text-slate-400 flex-shrink-0">SW</span>
                  ) : null}
                  {/* Contador de slots: apenas em "Com Vagas" — nos demais
                      estágios a lotação já é implícita pela categoria. */}
                  {stage === "comVagas" && (
                    <span className={`text-[9px] font-bold px-1 py-px rounded flex-shrink-0 ${
                      isTabOpened ? theme.counterOpened : theme.counterClosed
                    }`}>
                      {total}/{p.slots}
                    </span>
                  )}
                </button>
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-0.5 bg-[var(--th-bg-base)] p-0.5 rounded-xl border border-[var(--th-brand)]/60 flex-shrink-0">
          {STAGE_ORDER.map(stage => {
            const theme = STAGE_THEME[stage];
            const isCurrent = ptStatusView === stage;
            // Pulso de borda por categoria (mesmo conceito visual do antigo
            // pulso âmbar, agora na cor de CADA seletor):
            //   • Com Vagas / Prontas / Iniciadas → pulsa quando existe ≥1 PT
            //     na categoria (dinâmico: partiesByStage vem do estado vivo,
            //     então entrar/sair de PT liga/desliga o pulso na hora);
            //   • Aguardando Pagamento → regra ORIGINAL preservada: pulsa
            //     apenas quando há pagamento pendente COM o usuário logado.
            // Sem gatilho, a borda fica FIXA na cor do seletor (btnIdle).
            const shouldPulse = stage === "aguardando"
              ? pendingPaymentForUserCount > 0
              : partiesByStage[stage].length > 0;
            const pulse = !isCurrent && shouldPulse ? ` ${theme.pulse}` : "";
            const title = stage === "comVagas"
              ? "Exibir PTs com slots ainda em aberto"
              : stage === "prontas"
                ? "Exibir PTs completas com Quest ainda não iniciada"
                : stage === "iniciadas"
                  ? "Exibir PTs com Quest iniciada ou pausada"
                  : pendingPaymentForUserCount > 0
                    ? `Exibir PTs com quest finalizada e pagamento pendente — ${pendingPaymentForUserCount} aguardando pagamento com você`
                    : "Exibir PTs com quest finalizada e pagamento pendente";
            return (
              <button
                key={stage}
                type="button"
                onClick={() => setPtStatusView(stage)}
                className={`px-2.5 py-1 rounded-lg border text-[10px] font-bold transition-all duration-200 cursor-pointer whitespace-nowrap ${
                  isCurrent ? theme.btnActive : `${theme.btnIdle}${pulse}`
                }`}
                title={title}
              >
                {theme.label} ({partiesByStage[stage].length})
              </button>
            );
          })}

          {/* ── ITENS A VENDA ─────────────────────────────────────────────
              Botão à direita do seletor "Aguardando Pagamento": abre o modal
              que centraliza os itens ainda não vendidos das PTs "aguardando"
              acessíveis ao usuário. O separador vertical deixa claro que NÃO
              é um seletor de categoria, mantendo-o integrado à mesma área. */}
          <div className="w-px h-4 bg-amber-500/25 mx-0.5" />
          {/* Borda pulsante IDÊNTICA e sincronizada com a dos seletores: as
              MESMAS classes CSS (pt-stage-pulse + cor âmbar) compartilham o
              mesmo keyframe e a mesma duração (1.8s), então todos os pulsos
              da barra respiram juntos. Gatilho: existe ≥1 item à venda. */}
          <button
            type="button"
            onClick={() => setShowItemsForSale(true)}
            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border text-[10px] font-bold transition-all duration-200 cursor-pointer whitespace-nowrap bg-black/20 border-amber-500/30 text-slate-500 hover:text-amber-300 hover:bg-amber-500/10 hover:border-amber-500/40${unsoldItemsCount > 0 ? " pt-stage-pulse pt-stage-pulse--amber" : ""}`}
            title={unsoldItemsCount > 0
              ? `Ver itens ainda não vendidos nas PTs em Aguardando Pagamento — ${unsoldItemsCount} item${unsoldItemsCount === 1 ? "" : "s"} à venda`
              : "Ver itens ainda não vendidos nas PTs em Aguardando Pagamento"}
          >
            <Coins size={11} className="flex-shrink-0" />
            Itens a Venda{unsoldItemsCount > 0 ? ` (${unsoldItemsCount})` : ""}
          </button>
        </div>

        <div className="relative flex items-center gap-0.5 bg-[var(--th-bg-base)] p-0.5 rounded-xl border border-[var(--th-brand)]/60 flex-shrink-0">
          <button
            type="button"
            onClick={() => setFilterPrivate(v => !v)}
            className={`px-1.5 py-1 rounded-lg border transition-all cursor-pointer ${
              filterPrivate
                ? "bg-red-900/30 border-red-700/50 text-red-300"
                : "bg-black/20 border-red-900/20 text-slate-500 hover:text-red-300 hover:bg-red-900/20 hover:border-red-700/40"
            }`}
            title="Filtrar PT's privadas"
          >
            <Lock size={11} />
          </button>

          <button
            type="button"
            onClick={() => setFilterPublic(v => !v)}
            className={`px-1.5 py-1 rounded-lg border transition-all cursor-pointer ${
              filterPublic
                ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300"
                : "bg-black/20 border-red-900/20 text-slate-500 hover:text-emerald-300 hover:bg-emerald-500/10 hover:border-emerald-500/40"
            }`}
            title="Filtrar PT's públicas"
          >
            <LockOpen size={11} />
          </button>

          <button
            type="button"
            onClick={() => { if (!isNormalUser) setFilterMine(v => !v); }}
            disabled={isNormalUser}
            className={`px-1.5 py-1 rounded-lg border transition-all ${
              (filterMine || isNormalUser)
                ? "bg-red-900/30 border-red-700/50 text-red-300"
                : "bg-black/20 border-red-900/20 text-slate-500 hover:text-red-300 hover:bg-red-900/20 hover:border-red-700/40"
            } ${isNormalUser ? "cursor-not-allowed opacity-80" : "cursor-pointer"}`}
            title={isNormalUser ? "Encontrar vagas em PTs é exclusivo para VIPs" : "Filtrar apenas as PT's que participo"}
          >
            <UserCheck size={11} />
          </button>

          <div className="w-px h-4 bg-red-900/30 mx-0.5" />

          <button
            ref={serverBtnRef}
            type="button"
            onClick={() => setServerDropOpen(v => !v)}
            className={`inline-flex items-center gap-1 px-1.5 py-1 rounded-lg border text-[9px] font-bold transition-all cursor-pointer whitespace-nowrap ${
              filterServer
                ? "bg-red-900/30 border-red-700/50 text-red-300"
                : "bg-black/20 border-red-900/20 text-slate-500 hover:text-red-300 hover:bg-red-900/20 hover:border-red-700/40"
            }`}
            title="Filtrar por servidor"
          >
            {filterServer || "Servidor"} <ChevronDown size={10} />
          </button>
          {serverDropOpen && createPortal(
            <div
              ref={serverMenuRef}
              className="fixed z-[60] w-40 rounded-lg border border-red-900/30 bg-[var(--th-n-raised)] shadow-xl overflow-hidden max-h-44 overflow-y-auto"
              style={{ top: serverDropPos.top, left: serverDropPos.left }}
            >
              <div
                onMouseDown={(e) => { e.preventDefault(); setFilterServer(""); setServerDropOpen(false); }}
                className="px-2.5 py-1.5 text-[9px] font-bold text-rose-400 hover:bg-rose-500/10 cursor-pointer border-b border-red-900/20"
              >
                Limpar filtro
              </div>
              {ptServerOptions.length === 0 ? (
                <div className="px-2.5 py-1.5 text-[9px] text-slate-500 italic">Nenhum servidor</div>
              ) : (
                ptServerOptions.map(srv => (
                  <div
                    key={srv}
                    onMouseDown={(e) => { e.preventDefault(); setFilterServer(srv); setServerDropOpen(false); }}
                    className={`px-2.5 py-1.5 text-[9px] font-semibold cursor-pointer transition-colors ${
                      filterServer === srv ? "bg-red-900/30 text-red-300" : "text-slate-300 hover:bg-red-900/20 hover:text-white"
                    }`}
                  >
                    {srv}
                  </div>
                ))
              )}
            </div>,
            document.body
          )}

          <button
            type="button"
            onClick={resetFilters}
            disabled={!filterPrivate && !filterPublic && !filterMine && !filterServer}
            className="px-1.5 py-1 rounded-lg border border-red-900/20 bg-black/20 text-slate-500 hover:text-rose-300 hover:bg-rose-500/10 hover:border-rose-500/40 transition-all cursor-pointer disabled:opacity-30 disabled:pointer-events-none"
            title="Limpar todos os filtros"
          >
            <RotateCcw size={10} />
          </button>
        </div>

        <button
          type="button"
          onClick={() => { setActivePt(null); setStandaloneView("overview"); }}
          data-active={standaloneView === "overview" && (activePt === null || !filteredParties.find(p => p.id === activePt) || !!minimized[activePt])}
          className="nav-pill nav-pill--action inline-flex items-center gap-1 px-2.5 py-1 text-[10px] cursor-pointer whitespace-nowrap flex-shrink-0"
          style={{ ["--pill-accent" as string]: "var(--color-red-500)" }}
          title="Visão Geral das Estatísticas"
        >
          <BarChart3 size={12} className={standaloneView === "overview" && (activePt === null || !filteredParties.find(p => p.id === activePt) || !!minimized[activePt]) ? "text-amber-300" : "text-amber-600/80"} />
          Visão Geral
        </button>

        <button
          type="button"
          onClick={() => { setActivePt(null); setStandaloneView("allChars"); }}
          data-active={standaloneView === "allChars" && (activePt === null || !filteredParties.find(p => p.id === activePt) || !!minimized[activePt])}
          className="nav-pill nav-pill--action inline-flex items-center gap-1 px-2.5 py-1 text-[10px] cursor-pointer whitespace-nowrap flex-shrink-0"
          style={{ ["--pill-accent" as string]: "var(--color-sky-500)" }}
          title="Personagens Disponíveis, Lista de Espera e Oportunidade por Servidor"
        >
          <Users size={12} className={standaloneView === "allChars" && (activePt === null || !filteredParties.find(p => p.id === activePt) || !!minimized[activePt]) ? "text-sky-300" : "text-sky-600/80"} />
          Todos Personagens
        </button>

        <button
          onClick={() => { setShowSuggestModal(true); }}
          className="nav-pill nav-pill--action inline-flex items-center gap-1 px-2.5 py-1 text-[10px] cursor-pointer whitespace-nowrap flex-shrink-0"
          style={{ ["--pill-accent" as string]: "var(--color-amber-500)" }}
          title="Montar PT automaticamente com algoritmo inteligente"
        >
          <Sparkles size={12} /> Sugerir PT
        </button>
        <button
          onClick={() => { setShowCreate(true); }}
          className="nav-pill nav-pill--action inline-flex items-center gap-1 px-2.5 py-1 text-[10px] cursor-pointer whitespace-nowrap flex-shrink-0"
          style={{ ["--pill-accent" as string]: "var(--color-emerald-500)" }}
        >
          <Plus size={12} /> Criar PT
        </button>
      </div>

      {/* Modal Criar PT */}
      {showCreate && (
        <div className="app-modal-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm" onMouseDown={e => { if (!isCreatingParty && e.target === e.currentTarget) setShowCreate(false); }}>
          <div
            className="app-modal-frame app-modal-size-sm app-modal-frame--scroll bg-[var(--th-n-deep)] border border-[var(--th-line)]/100 rounded-2xl shadow-xl w-full max-w-md"
          >

            {/* Scrollable content */}
            <div className="app-modal-body p-4 sm:p-5 space-y-4">
              <div className="flex items-center justify-between border-b border-[var(--th-line)]/50 pb-3">
                <h3 className="text-base font-bold text-white tracking-wide flex items-center gap-2">
                  <Users size={18} className="text-amber-600" /> Criar Nova PT
                </h3>
                <button onClick={() => setShowCreate(false)} disabled={isCreatingParty} className="text-slate-400 hover:text-white transition-colors disabled:opacity-30 disabled:pointer-events-none">
                  <X size={18} />
                </button>
              </div>

              <fieldset disabled={isCreatingParty} className={`space-y-3 text-left ${isCreatingParty ? "opacity-60 pointer-events-none" : ""}`}>
                {/* Nome da PT é gerado automaticamente no padrão "#N"
                    (numeração sequencial atômica via Firestore). O usuário
                    não precisa mais informar manualmente. */}

                <div className="relative">
                  <label className="block text-[10px] text-red-400/80 uppercase tracking-wider font-bold mb-1.5">
                    Servidor <span className="text-rose-400">*</span>
                  </label>
                  <input
                    type="text"
                    value={serverSearch}
                    onChange={e => {
                      const raw = e.target.value;
                      const capitalized = raw.charAt(0).toUpperCase() + raw.slice(1);
                      setServerSearch(capitalized);
                      setNewServidor("");
                      setServidorMenuOpen(true);
                    }}
                    onFocus={() => setServidorMenuOpen(true)}
                    onBlur={() => setTimeout(() => setServidorMenuOpen(false), 150)}
                    className="w-full bg-black/40 border border-red-900/30 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-700/60 placeholder-slate-600 transition-colors"
                    placeholder="Digite e selecione um servidor"
                    onKeyDown={e => { if (e.key === "Enter") handleCreate(); if (e.key === "Escape") setShowCreate(false); }}
                  />
                  {servidorMenuOpen && filteredServerOptions.length > 0 && (
                    <div className="absolute z-[60] w-full mt-1 bg-[var(--th-n-raised)] border border-red-900/40 rounded-lg shadow-xl overflow-hidden max-h-48 overflow-y-auto">
                      <div className="px-3 py-1.5 text-[9px] text-slate-500 uppercase tracking-wider border-b border-red-900/20">
                        Servidores disponíveis ({filteredServerOptions.length})
                      </div>
                      {filteredServerOptions.map(srv => (
                        <div
                          key={srv}
                          onMouseDown={(e) => { e.preventDefault(); setNewServidor(srv); setServerSearch(srv); setServidorMenuOpen(false); }}
                          className={`px-3 py-2 text-xs cursor-pointer transition-colors ${
                            srv === newServidor
                              ? "bg-red-900/30 text-red-300 font-semibold"
                              : "text-slate-300 hover:bg-red-900/20 hover:text-white"
                          }`}
                        >
                          {srv}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <label className="block text-[10px] text-red-400/80 uppercase tracking-wider font-bold mb-1.5">Quest</label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setNewPtType("soulwar")}
                      className={`flex-1 py-2 rounded-lg text-xs font-bold border transition-colors ${
                        newPtType === "soulwar"
                          ? "border-slate-400 bg-slate-500/20 text-slate-200"
                          : "border-red-900/30 bg-black/20 text-slate-500 hover:text-slate-300"
                      }`}
                    >
                      SOULWAR
                    </button>
                    <button
                      type="button"
                      onClick={() => setNewPtType("sanguine")}
                      className={`flex-1 py-2 rounded-lg text-xs font-bold border transition-colors ${
                        newPtType === "sanguine"
                          ? "border-rose-500/50 bg-rose-500/20 text-rose-300"
                          : "border-red-900/30 bg-black/20 text-rose-500/70 hover:text-rose-300"
                      }`}
                    >
                      SANGUINE
                    </button>
                  </div>
                </div>

                 <div>
                  <label className="block text-[10px] text-red-400/80 uppercase tracking-wider font-bold mb-1.5">Visibilidade</label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => { if (publicPartiesEnabled) setNewVisibility("public"); }}
                      disabled={!publicPartiesEnabled}
                      className={`flex-1 py-2 rounded-lg text-xs font-bold border transition-colors flex items-center justify-center gap-1.5 ${
                        !publicPartiesEnabled
                          ? "border-slate-700/40 bg-slate-800/20 text-slate-600 cursor-not-allowed"
                          : newVisibility === "public"
                            ? "border-emerald-500/50 bg-emerald-500/20 text-emerald-300"
                            : "border-red-900/30 bg-black/20 text-slate-500 hover:text-slate-300"
                      }`}
                      title={!publicPartiesEnabled ? "Criação de PTs públicas pausada pelo administrador" : "Criar PT Pública"}
                    >
                      <LockOpen size={14} /> Pública
                    </button>
                    <button
                      type="button"
                      onClick={() => setNewVisibility("private")}
                      className={`flex-1 py-2 rounded-lg text-xs font-bold border transition-colors flex items-center justify-center gap-1.5 ${
                        newVisibility === "private"
                          ? "border-red-700/50 bg-red-900/30 text-red-300"
                          : "border-red-900/30 bg-black/20 text-slate-500 hover:text-slate-300"
                      }`}
                    >
                      <Lock size={14} /> Privada
                    </button>
                  </div>
                </div>

                {newVisibility === "private" && (
                  <div>
                    <label className="block text-[10px] text-red-400/80 uppercase tracking-wider font-bold mb-1.5">
                      Convidados Autorizados
                    </label>
                    <input
                      type="text"
                      value={createInviteSearch}
                      onChange={(e) => setCreateInviteSearch(e.target.value)}
                      placeholder="Pesquisar usuário..."
                      className="w-full bg-black/40 border border-red-900/30 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-red-700/50 placeholder-slate-600 transition-colors mb-1.5"
                    />
                    <div className="max-h-28 overflow-y-auto bg-black/30 border border-red-900/20 rounded-lg p-2 space-y-1">
                      {(() => {
                        const sorted = [...approvedUsers].sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR", { sensitivity: "base" }));
                        const filtered = createInviteSearch.trim()
                          ? sorted.filter(u => u.nome.toLowerCase().includes(createInviteSearch.toLowerCase()))
                          : sorted;
                        if (filtered.length === 0) {
                          return (
                            <div className="text-center py-2 text-slate-500 text-[10px]">
                              {approvedUsers.length === 0 ? "Nenhum amigo aprovado encontrado." : "Nenhum resultado para a pesquisa."}
                            </div>
                          );
                        }
                        return filtered.map(user => {
                          const isSelf = user.uid === currentUser?.uid;
                          const isChecked = isSelf || invitedUsers.includes(user.uid);
                          return (
                            <label
                              key={user.uid}
                              className={`flex items-center gap-2 text-xs py-1 px-1.5 rounded select-none ${
                                isSelf ? "opacity-50 cursor-not-allowed bg-red-900/10" : "cursor-pointer hover:bg-red-900/20"
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={isChecked}
                                disabled={isSelf}
                                onChange={(e) => {
                                  if (isSelf) return;
                                  if (e.target.checked) {
                                    setInvitedUsers(prev => [...prev, user.uid]);
                                  } else {
                                    setInvitedUsers(prev => prev.filter(id => id !== user.uid));
                                  }
                                }}
                                className="w-3.5 h-3.5 accent-red-500 rounded cursor-pointer"
                              />
                              <span className="text-slate-300 truncate">{user.nome}</span>
                              {isSelf && <span className="text-[9px] text-red-400 font-bold ml-auto">(Você)</span>}
                            </label>
                          );
                        });
                      })()}
                    </div>
                    <span className="block text-[9px] text-slate-500 mt-1">
                      Selecione quem poderá visualizar e interagir com esta PT Privada.
                    </span>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3 pt-1">
                  <div>
                    <label className="block text-[10px] text-red-400/80 uppercase tracking-wider font-bold mb-1.5">Data (Opcional)</label>
                    <input
                      type="date"
                      value={newDate}
                      onChange={e => setNewDate(e.target.value)}
                      className="w-full bg-black/40 border border-red-900/30 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-700/50 [color-scheme:dark]"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-red-400/80 uppercase tracking-wider font-bold mb-1.5">Horário (Opcional)</label>
                    <input
                      type="time"
                      value={newHorario}
                      onChange={e => setNewHorario(e.target.value)}
                      className="w-full bg-black/40 border border-red-900/30 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-700/50 [color-scheme:dark]"
                    />
                  </div>
                </div>
              </fieldset>
            </div>{/* end scrollable content */}

            {/* Footer fixo */}
            <div className="app-modal-footer flex flex-wrap justify-end gap-2 px-4 sm:px-5 py-3 border-t border-red-900/20">
              <button onClick={cancelCreateModal} className="px-4 py-2 rounded-lg border border-red-900/30 text-slate-400 hover:text-white text-xs transition-colors hover:bg-red-900/20">
                Cancelar
              </button>
              <button onClick={handleCreate} disabled={!isOfficialServer(newServidor) || isCreatingParty} className="px-5 py-2 rounded-lg bg-gradient-to-r from-[var(--th-brand-mid)] to-[var(--th-brand)] hover:from-[var(--th-brand-bright)] hover:to-[var(--th-line-strong)] text-white text-xs font-semibold disabled:opacity-20 transition-colors border border-[var(--th-brand-mid)]/60">
                {isCreatingParty ? <span className="inline-flex items-center gap-1.5"><RefreshCw size={12} className="animate-spin" /> Aguardando PT...</span> : "Criar PT"}
              </button>
            </div>

          </div>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        {activePt && filteredParties.find(p => p.id === activePt) && !minimized[activePt] ? (
          (() => {
            const p = filteredParties.find(p => p.id === activePt)!;
            return (
              <PartyPanel
                key={p.id}
                party={p}
                characters={characters}
                waitingList={waitingList}
                allParties={parties}
                userName={userName}
                onUpdate={onUpdate}
                onPersistPartyNow={onPersistPartyNow}
                onDelete={() => onDelete(p.id)}
                onSaveParty={onSaveParty}
                onPaymentMarked={onPaymentMarked}
                onNotifyMembers={onNotifyMembers}
                onRequestFinalization={onRequestFinalization}
                onRefresh={onRefresh}
                characterAcquisitions={characterAcquisitions}
                onCreateCharacterAcquisition={onCreateCharacterAcquisition}
                onConfirmCharacterAcquisitionPayment={onConfirmCharacterAcquisitionPayment}
              />
            );
          })()
        ) : standaloneView === "overview" ? (
          /* ── GUIA "VISÃO GERAL": somente o OverviewPanel, ocupando 100%
                da área disponível (as listas e o gráfico agora vivem na
                guia "Todos Personagens"). ─────────────────────────────── */
          <div className="h-full w-full p-1">
            <OverviewPanel
              characters={characters}
              waitingList={waitingList}
              activeParties={parties}
            />
          </div>
        ) : standaloneView === "allChars" ? (
          /* ── GUIA "TODOS PERSONAGENS": os 3 painéis em tela cheia, com
                visibilidade individual + divisores redimensionáveis. ──── */
          <div className="flex flex-col h-full bg-[var(--th-n-deep)] text-sm overflow-hidden rounded-xl border border-[var(--th-line)]/80">
            {/* Barra de controles: liga/desliga cada painel independentemente. */}
            <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-[var(--th-line)]/60 bg-[var(--th-bg-raised)]/60 flex-shrink-0 overflow-x-auto">
              <span className="text-[9px] uppercase tracking-widest font-black text-slate-500 whitespace-nowrap">Painéis:</span>
              {([
                { key: "available" as const, label: "Personagens Disponíveis", accent: "amber" },
                { key: "waiting" as const, label: "Lista de Espera", accent: "red" },
                { key: "chart" as const, label: "Oportunidade por Servidor", accent: "sky" },
              ]).map(({ key, label, accent }) => {
                const isOn = panelVisibility[key];
                const activeCls = accent === "amber"
                  ? "bg-amber-500/15 border-amber-500/50 text-amber-300"
                  : accent === "red"
                    ? "bg-red-500/15 border-red-500/50 text-red-300"
                    : "bg-sky-500/15 border-sky-500/50 text-sky-300";
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setPanelVisibility(prev => ({ ...prev, [key]: !prev[key] }))}
                    className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border text-[10px] font-bold transition-all cursor-pointer whitespace-nowrap ${
                      isOn ? activeCls : "bg-black/20 border-white/10 text-slate-500 hover:text-slate-300 hover:bg-white/5"
                    }`}
                    title={isOn ? `Ocultar ${label}` : `Exibir ${label}`}
                  >
                    {isOn ? <Eye size={11} /> : <EyeOff size={11} />} {label}
                  </button>
                );
              })}
            </div>

            {visiblePanelKeys.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-2 text-slate-500">
                <EyeOff size={28} className="text-slate-600" />
                <span className="text-xs font-bold text-slate-400">Todos os painéis estão ocultos</span>
                <span className="text-[10px] text-slate-600">Use os botões acima para exibir os painéis desejados.</span>
              </div>
            ) : (
              <div ref={standalonePanelsRef} className="flex flex-col xl:flex-row gap-2 items-stretch px-2 py-2 w-full relative box-border flex-1 min-h-0">
                {visiblePanelKeys.map((panelKey, index) => {
                  // Larguras: 1 visível = 100%; 2 visíveis = divisor único
                  // (persistido por combinação); 3 visíveis = p1/p2/p3
                  // originais. O último painel absorve a folga (flex-1).
                  const isLast = index === visiblePanelKeys.length - 1;
                  let flexStyle: React.CSSProperties;
                  if (visiblePanelKeys.length === 1) {
                    flexStyle = { flex: "1 1 auto" };
                  } else if (visiblePanelKeys.length === 2) {
                    const leftPct = pairWidths[pairComboKey] ?? PAIR_DEFAULT_WIDTHS[pairComboKey] ?? 50;
                    flexStyle = isLast ? { flex: "1 1 0%" } : { flex: `0 0 calc(${leftPct}% - 14px)` };
                  } else {
                    flexStyle = panelKey === "available"
                      ? { flex: `0 0 calc(${standalonePanelWidths.p1}% - 14px)` }
                      : panelKey === "chart"
                        ? { flex: `0 0 calc(${standalonePanelWidths.p2}% - 14px)`, minWidth: "195px" }
                        : { flex: "1 1 0%" };
                  }
                  // Divisor entre este painel e o próximo: com 3 visíveis,
                  // usa os manipuladores originais left/right; com 2, "pair".
                  const dragTarget = visiblePanelKeys.length === 3
                    ? (index === 0 ? "left" as const : "right" as const)
                    : "pair" as const;
                  const panelNode = panelKey === "available" ? (
                    <div key={panelKey} className="flex flex-col border border-red-800/50 rounded-xl bg-[var(--th-n-raised)] self-stretch overflow-hidden min-w-0" style={flexStyle}>
                      <AvailableCharacter
                        onRefresh={onRefresh}
                        handleRefresh={standaloneHandleRefresh}
                        isRefreshing={standaloneIsRefreshing}
                        refreshDone={standaloneRefreshDone}
                        thCls={standaloneThCls}
                        hdr={standaloneHdr}
                        toggleSort={standaloneToggleSort}
                        SI={StandaloneSI}
                        resetAvailableFilters={standaloneResetFilters}
                        smartAccountFilter={standaloneSmartAccountFilter}
                        setSmartAccountFilter={setStandaloneSmartAccountFilter}
                        filterPersonagem={standaloneFilterPersonagem}
                        setFilterPersonagem={setStandaloneFilterPersonagem}
                        serverOptions={standaloneServerOptions}
                        filterServer={standaloneFilterServer}
                        setFilterServer={setStandaloneFilterServer}
                        vocOptions={standaloneVocOptions}
                        filterVoc={standaloneFilterVoc}
                        setFilterVoc={setStandaloneFilterVoc}
                        filterLevel={standaloneFilterLevel}
                        filterLevelOp={standaloneFilterLevelOp}
                        setFilterLevel={setStandaloneFilterLevel}
                        setFilterLevelOp={setStandaloneFilterLevelOp}
                        filterSW={standaloneFilterSW}
                        setFilterSW={setStandaloneFilterSW}
                        filterSG={standaloneFilterSG}
                        setFilterSG={setStandaloneFilterSG}
                        donoOptions={standaloneDonoOptions}
                        filterDonos={standaloneFilterDonos}
                        setFilterDonos={setStandaloneFilterDonos}
                        sortedAvailable={standaloneSortedAvailable}
                        idsInOtherParties={standaloneIdsInOtherParties}
                        otherPartiesInfoFor={standaloneOtherPartiesInfoFor}
                        isFull={false}
                        addToParty={() => {}}
                        accountLabelFor={standaloneAccountLabelFor}
                        getCharOwner={standaloneGetCharOwner}
                      />
                    </div>
                  ) : panelKey === "chart" ? (
                    <div key={panelKey} className="self-stretch flex flex-col items-stretch overflow-hidden border border-red-900/30 rounded-xl bg-[var(--th-n-raised)]" style={flexStyle}>
                      <ServersPyramidChart
                        availableChars={standaloneAvailable}
                        waitingItems={standaloneVisibleWaitingList}
                        selectedSet={new Set()}
                        activeServer={standaloneFilterServer}
                        onServerClick={standaloneHandleServerChartClick}
                      />
                    </div>
                  ) : (
                    <div key={panelKey} className="flex flex-col border border-red-800/50 rounded-xl bg-[var(--th-n-raised)] self-stretch overflow-hidden min-w-0" style={flexStyle}>
                      <div className="px-3 py-1 bg-[var(--th-bg-base)] border-b border-red-800/50 text-[10px] uppercase tracking-wider text-red-400 font-bold truncate flex-shrink-0 flex items-center justify-between gap-2">
                        <span>Lista de Espera (Services)</span>
                        {onRefresh && (
                          <RefreshButton
                            onRefresh={standaloneHandleRefresh}
                            isRefreshing={standaloneIsRefreshing}
                            refreshDone={standaloneRefreshDone}
                            title="Sincronizar Lista de Espera (Services) da nuvem"
                          />
                        )}
                      </div>
                      <div className="flex-1 min-h-0 overflow-y-auto" onWheel={e => e.stopPropagation()}>
                        <WaitingServiceAvailableList items={standaloneVisibleWaitingList} selectedIds={new Set()} isFull={false} onAdd={() => {}} filters={standaloneWlFilters} setFilters={setStandaloneWlFilters} />
                      </div>
                    </div>
                  );
                  return (
                    <div key={`wrap_${panelKey}`} className="contents">
                      {panelNode}
                      {!isLast && (
                        <div className="w-2.5 bg-transparent hover:bg-emerald-500/30 cursor-col-resize self-stretch flex items-center justify-center rounded transition-colors select-none group flex-shrink-0" title="Arraste para ajustar" onMouseDown={e => { e.preventDefault(); setStandaloneDraggingPanel(dragTarget); }}>
                          <div className="w-[3px] h-12 bg-white/20 group-hover:bg-emerald-400 rounded-full transition-colors" />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          /* ── NENHUMA PT SELECIONADA: tela "Selecione uma PT". ────────── */
          <div className="flex flex-col h-full items-center justify-center bg-[var(--th-n-deep)] rounded-xl border border-[var(--th-line)]/80 relative overflow-hidden">
            <div className="absolute inset-0 overflow-hidden pointer-events-none">
              <div className="absolute top-1/4 left-1/3 w-72 h-72 bg-emerald-950/20 blur-[120px] rounded-full" />
              <div className="absolute bottom-1/4 right-1/3 w-72 h-72 bg-red-950/15 blur-[120px] rounded-full" />
            </div>
            <div className="relative z-10 flex flex-col items-center gap-3 px-6 text-center">
              <div className="w-16 h-16 rounded-2xl border border-[var(--th-brand-mid)]/40 bg-[var(--th-bg-raised)]/80 flex items-center justify-center shadow-lg">
                <MousePointerClick size={28} className="text-amber-400" />
              </div>
              <h2 className="text-lg font-black text-white tracking-wide">Selecione uma PT</h2>
              <p className="text-xs text-slate-400 max-w-sm leading-relaxed">
                Clique em uma das PTs na barra acima para abrir seu painel completo,
                ou utilize os botões <span className="font-bold text-amber-300">Visão Geral</span> e{" "}
                <span className="font-bold text-sky-300">Todos Personagens</span> para explorar
                as estatísticas e os personagens disponíveis.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Modal Sugerir PT — operação em modo "standalone" (sem PT existente):
          ao confirmar com "Salvar PT", a PT é criada DIRETAMENTE no Firestore
          via onCreateFromSuggestion, sem abrir o modal "Criar PT". O fluxo
          popula slotData/members/invitedUsers e dispara a notificação
          "Você foi adicionado a uma PT" para cada participante. */}
      <SuggestPartyModal
        open={showSuggestModal}
        onClose={() => setShowSuggestModal(false)}
        characters={characters}
        waitingList={waitingList}
        allParties={parties}
        userName={userName}
        publicPartiesEnabled={publicPartiesEnabled}
        onCreateFromSuggestion={(suggestedIds, suggestedServidor, suggestedPtType, visibility, horarioTimestamp) => {
          // Cria a PT DIRETAMENTE no Firestore, sem abrir o modal "Criar PT".
          // O nome da PT é gerado automaticamente (#N) no App.tsx, e a
          // função `createParty` já popula slotData/members/invitedUsers e
          // dispara a notificação "Você foi adicionado a uma PT" para cada
          // participante (mesma lógica usada na adição manual).
          onCreate("", suggestedPtType, horarioTimestamp, visibility, undefined, suggestedServidor, suggestedIds);
        }}
      />

      {/* Modal "Itens a Venda" — independente da PT selecionada; recebe as
          PTs "Aguardando Pagamento" já filtradas pelas regras de ACESSO do
          usuário atual (itemsForSaleParties). Props vivas do listener de
          parties -> conteúdo em tempo real, sem nenhuma consulta extra. */}
      {showItemsForSale && (
        <ItemsForSaleModal
          parties={itemsForSaleParties}
          characters={characters}
          waitingList={waitingList}
          onClose={() => setShowItemsForSale(false)}
        />
      )}
    </div>
  );
}