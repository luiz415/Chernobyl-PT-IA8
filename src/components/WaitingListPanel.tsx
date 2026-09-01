import { useState, useEffect, useRef, useMemo } from "react";
import { Plus, Pencil, Trash2, X, Save, Ban, Clock, MessageCircle, ArrowDown, ArrowUp, ArrowUpDown, RotateCcw, Check, CheckCircle2, ExternalLink, Crown, Star, Shield, Zap, ChevronRight } from "lucide-react";
import type { ServicePaymentMethod, WaitingService, Vocation } from "../types";
import { VOCATIONS, VOC_COLORS, VOC_LABEL, formatRC, todayISO, formatDateBR, formatDateTimeBR, SERVICE_PAYMENT_LABELS, customAlert, customConfirm } from "../types";
import { useAuth } from "../context/AuthContext";
import { openExternalUrl } from "../utils/openExternal";
import { FilterSelect } from "./FilterTypes";
import VipAccessButton from "./VipAccessButton";
import { getEffectiveUserRole } from "../utils/vipAccess";
import { SERVER_OPTIONS, isOfficialServer } from "../constants/servers";
import WhatsappMessagePicker from "./WhatsappMessagePicker";
import WhatsappTemplateModal from "./WhatsappTemplateModal";
import {
  DEFAULT_WHATSAPP_TEMPLATES,
  cleanWhatsappPhone,
  loadWhatsappTemplates,
  saveWhatsappTemplates,
  serviceToWhatsappContext,
  type WhatsappTemplate,
} from "../services/whatsappTemplatesService";

interface Props {
  items: WaitingService[];
  onAdd: (item: WaitingService) => void;
  onUpdate: (item: WaitingService) => void;
  onDelete: (id: string) => void;
  userName: string;
  /**
   * Id da entrada da Lista de Espera a destacar — usado quando a navegação
   * veio do clique numa notificação de service "Qualquer um" (serviceId da
   * notificação). Mesmo padrão visual do destaque de PT no Meu Histórico.
   */
  highlightId?: string | null;
}

type SortKey = "personagem" | "servidor" | "voc" | "level" | "ownerName" | "valor" | "data" | "quest" | "addedBy" | "createdAt" | null;
type SortDir = "asc" | "desc" | null;

/** Sub-guias da guia Services: fila de espera e services entregues. */
type ServicesSubTab = "fila" | "realizados";

function newId() { return "ws_" + Math.random().toString(36).slice(2) + Date.now().toString(36); }

function emptyService(defaultUser: string): WaitingService {
  return {
    id: newId(),
    personagem: "",
    ownerName: "",
    servidor: "",
    voc: "EK",
    level: 0,
    valorCombinado: 0,
    dataAdicionado: todayISO(),
    notes: "",
    whatsappCountry: "55",
    whatsappArea: "",
    whatsappNumber: "",
    addedBy: defaultUser || "",
    quest: "soulwar",
    paymentMethod: "",
    triagem: false,
    createdAt: Date.now(),
  };
}

/**
 * Data+hora de adição exibida na lista.
 *
 * Fonte de verdade: o timestamp `createdAt` (ms) gravado no documento —
 * convertido para o fuso LOCAL do usuário por `formatDateTimeBR`. A string
 * `dataAdicionado` (só data, ISO) é apenas fallback de registros muito
 * antigos que ainda não tinham timestamp.
 */
function formatWaitingAddedAt(item: WaitingService): string {
  if (Number.isFinite(item.createdAt) && item.createdAt > 0) return formatDateTimeBR(item.createdAt);
  return formatDateBR(item.dataAdicionado);
}

/**
 * Data+hora da ENTREGA (sub-guia "Realizados"): timestamp `realizadoAt`,
 * gravado quando a Quest da PT que levou o personagem foi concluída.
 */
function formatWaitingRealizadoAt(item: WaitingService): string {
  return formatDateTimeBR(item.realizadoAt || item.createdAt);
}

/** Rótulo curto da forma de pagamento (mesma exibição de "Meus Services"). */
function paymentLabel(method?: ServicePaymentMethod): string {
  return method && SERVICE_PAYMENT_LABELS[method] ? SERVICE_PAYMENT_LABELS[method] : "";
}

function buildWhatsLink(item: WaitingService): string {
  const c = (item.whatsappCountry || "").replace(/\D/g, "");
  const a = (item.whatsappArea || "").replace(/\D/g, "");
  const n = (item.whatsappNumber || "").replace(/\D/g, "");
  if (!c && !a && !n) return "";
  return `https://wa.me/${c}${a}${n}`;
}

function formatWhatsDisplay(item: WaitingService): string {
  const c = (item.whatsappCountry || "").trim();
  const a = (item.whatsappArea || "").trim();
  const n = (item.whatsappNumber || "").trim();
  if (!c && !a && !n) return "";
  return `+${c} ${a} ${n}`.trim();
}

export default function WaitingListPanel({ items, onAdd, onUpdate, onDelete, userName, highlightId }: Props) {
  const { currentUser, userProfile, allUsers } = useAuth();

  // ── Mensagens padrão do WhatsApp ──────────────────────────────────────────
  // Mesma preferência individual do Meus Services (localStorage por UID):
  // alimenta o seletor que abre ao clicar no WhatsApp de um cliente.
  const [waTemplates, setWaTemplates] = useState<WhatsappTemplate[]>(DEFAULT_WHATSAPP_TEMPLATES);
  const [waTemplatesOpen, setWaTemplatesOpen] = useState(false);
  const [waTarget, setWaTarget] = useState<WaitingService | null>(null);
  useEffect(() => {
    setWaTemplates(loadWhatsappTemplates(currentUser?.uid || ""));
  }, [currentUser?.uid]);
  function handleWaTemplatesSave(next: WhatsappTemplate[]) {
    setWaTemplates(next);
    saveWhatsappTemplates(currentUser?.uid || "", next);
  }
  const waContext = useMemo(
    () => serviceToWhatsappContext(waTarget, userProfile?.nome || userName || "", userProfile?.twitchChannel || ""),
    [waTarget, userProfile?.nome, userName, userProfile?.twitchChannel],
  );
  // Boss pode excluir qualquer service; ninguém mais (nem o próprio serviceiro)
  const canDeleteWaiting = userProfile?.role === "Boss";
  // Boss pode editar qualquer service; o Serviceiro designado também pode editar seus próprios
  function canEditService(item: WaitingService): boolean {
    if (userProfile?.role === "Boss") return true;
    const assignedServiceiro = (item.addedBy || "").trim();
    if (!assignedServiceiro || assignedServiceiro.toLowerCase() === "qualquer um") return false;
    const viewerName = (userProfile?.nome || userName || "").trim();
    return assignedServiceiro.toLowerCase() === viewerName.toLowerCase();
  }
  const isAuthorized = userProfile?.role === "Boss" || userProfile?.role === "VIP";

  // ============================================================================
  // VISIBILIDADE DO WHATSAPP DO CLIENTE
  // ============================================================================
  // Regras:
  //   1. Boss vê sempre.
  //   2. Se o cliente selecionou um serviceiro específico, apenas esse usuário
  //      (addedBy) pode ver o número.
  //   3. Se o cliente deixou "Qualquer um", apenas Boss vê o número.
  function canViewServiceWhats(item: WaitingService): boolean {
    if (userProfile?.role === "Boss") return true;
    const assignedServiceiro = (item.addedBy || "").trim().toLowerCase();
    if (!assignedServiceiro || assignedServiceiro === "qualquer um") return false;
    const viewerName = (userProfile?.nome || userName || "").trim().toLowerCase();
    return assignedServiceiro === viewerName;
  }
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<WaitingService | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("createdAt");
  const [subTab, setSubTab] = useState<ServicesSubTab>("fila");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  // Estado para feedback de cópia na coluna Personagem
  const [copiedCharId, setCopiedCharId] = useState<string | null>(null);
  function handleCopyPersonagem(id: string, name: string) {
    try {
      navigator.clipboard.writeText(name);
      setCopiedCharId(id);
      setTimeout(() => setCopiedCharId(null), 1500);
    } catch {}
  }

  // ============================================================================
  // RASCUNHO LOCAL para edição das Anotações (evita sobrescrita pelo onSnapshot)
  // ============================================================================
  // O input de Anotações usava `item.notes` diretamente como value. A cada tecla
  // o onUpdate gravava no Firestore e o onSnapshot retornava dados antigos,
  // sobrescrevendo o que o usuário estava digitando. Agora o usuário digita em
  // um rascunho LOCAL e o valor só é persistido ao sair do campo (blur) ou após
  // 1,5s sem digitar (debounce).
  const [notesDrafts, setNotesDrafts] = useState<Record<string, string>>({});
  const notesDebounceTimers = useRef<Record<string, number>>({});

  useEffect(() => {
    return () => {
      Object.values(notesDebounceTimers.current).forEach(t => window.clearTimeout(t));
    };
  }, []);

  function handleNotesChange(item: WaitingService, nextValue: string) {
    // Atualiza o rascunho local imediatamente (digitação fluida)
    setNotesDrafts(prev => ({ ...prev, [item.id]: nextValue }));
    // Debounce: grava no Firestore após 1,5s sem digitar
    const existing = notesDebounceTimers.current[item.id];
    if (existing) window.clearTimeout(existing);
    notesDebounceTimers.current[item.id] = window.setTimeout(() => {
      delete notesDebounceTimers.current[item.id];
      commitNotesDraft(item, nextValue);
    }, 1500);
  }

  function commitNotesDraft(item: WaitingService, value: string) {
    // Cancela debounce pendente (caso chamado via blur)
    const existing = notesDebounceTimers.current[item.id];
    if (existing) {
      window.clearTimeout(existing);
      delete notesDebounceTimers.current[item.id];
    }
    if ((item.notes || "") !== value) {
      updateField(item, { notes: value });
    }
    // Limpa o rascunho — o valor agora vem do item (Firestore)
    setNotesDrafts(prev => {
      const next = { ...prev };
      delete next[item.id];
      return next;
    });
  }

  // ============================================================================
  // OPTIMIZAÇÃO: Usar allUsers do AuthContext em vez de listeners duplicados
  // ============================================================================
  const bosses = useMemo(() => {
    return allUsers.filter(u => u.status === "aprovado" && u.role === "Boss").map(u => ({
      uid: u.uid,
      nome: u.nome || "Anônimo",
      whatsappCountry: u.whatsappCountry,
      whatsappRegion: u.whatsappRegion,
      whatsappNumber: u.whatsappNumber
    }));
  }, [allUsers]);

  const eligibleServiceiros = useMemo(() => {
    return allUsers
      .filter(u => {
        const role = getEffectiveUserRole(u);
        return u.status === "aprovado" && (role === "Boss" || (role === "VIP" && (u as any).serviceiro === true));
      })
      .map(u => ({
        uid: u.uid,
        nome: u.nome || "Anônimo"
      }));
  }, [allUsers]);

  // Filters
  const [fPersonagem, setFPersonagem] = useState("");
  const [fServidor, setFServidor] = useState("");
  const [fVoc, setFVoc] = useState("");
  const [fLevel, setFLevel] = useState("");
  const [fLevelOp, setFLevelOp] = useState<"gte" | "lte">("gte");
  const [fOwner, setFOwner] = useState("");
  const [fValor, setFValor] = useState("");
  const [fValorOp, setFValorOp] = useState<"gte" | "lte">("gte");
  const [fData, setFData] = useState("");
  const [fAddedBy, setFAddedBy] = useState("");
  const [fNotes, setFNotes] = useState("");
  const [fWhats, setFWhats] = useState<"Sim" | "Não" | "">("");
  const [fQuest, setFQuest] = useState<"soulwar" | "sanguine" | "">("");
  const [fPgto, setFPgto] = useState<ServicePaymentMethod>("");

  function openAdd() { setEditing(null); setModalOpen(true); }
  function openEdit(item: WaitingService) { setEditing(item); setModalOpen(true); }

  function handleSave(item: WaitingService) {
    // Auto-preencher valor se as anotações contém "Pagamento: RC" ou "Pagamento: PIX"
    const notesLower = (item.notes || "").toLowerCase();
    const hasRCorPIX = notesLower.includes("pagamento: rc") || notesLower.includes("pagamento: pix");
    if (hasRCorPIX && (item.valorCombinado === 0 || item.valorCombinado === undefined)) {
      item = { ...item, valorCombinado: 1000 };
    }
    if (editing) onUpdate(item);
    else onAdd(item);
    setModalOpen(false);
  }

  function handleDelete(id: string) {
    customConfirm("Excluir este service da lista de espera?", () => onDelete(id));
  }

  function updateField(item: WaitingService, patch: Partial<WaitingService>) {
    // Auto-preencher valorCombinado quando as anotações contiverem "Pagamento: RC" ou "Pagamento: PIX"
    if (patch.notes !== undefined) {
      const notesLower = patch.notes.toLowerCase();
      const hasRCorPIX = notesLower.includes("pagamento: rc") || notesLower.includes("pagamento: pix");
      if (hasRCorPIX && (item.valorCombinado === 0 || item.valorCombinado === undefined)) {
        patch.valorCombinado = 1000;
      }
    }
    // Importante: enviar TODOS os campos alterados de uma vez para evitar que
    // o onSnapshot do Firestore sobrescreva o valorCombinado com 0 (valor antigo).
    // Se só enviássemos notes, o snapshot retornaria o documento sem o
    // valorCombinado atualizado, e o estado local seria sobrescrito para 0.
    onUpdate({ ...item, ...patch });
  }

  function toggleSort(key: SortKey) {
    if (sortKey !== key) { setSortKey(key); setSortDir("asc"); }
    else if (sortDir === "asc") setSortDir("desc");
    else { setSortDir(null); setSortKey(null); }
  }

  function clearFilters() {
    setFPersonagem(""); setFServidor(""); setFVoc(""); setFLevel(""); setFLevelOp("gte");
    setFOwner(""); setFValor(""); setFValorOp("gte"); setFData(""); setFAddedBy(""); setFNotes(""); setFWhats(""); setFQuest(""); setFPgto("");
  }

  const hasActiveFilters = fPersonagem || fServidor || fVoc || fLevel || fOwner || fValor || fData || fAddedBy || fNotes || fWhats || fQuest || fPgto;

  // Sub-guia ativa decide a fonte da tabela: "Na Fila" (padrão, tudo que
  // ainda não foi entregue — inclui registros legados sem status) ou
  // "Realizados" (services marcados pelo backend da conclusão da Quest).
  const filaItems = useMemo(() => items.filter(i => i.status !== "realizado"), [items]);
  const realizadosItems = useMemo(() => items.filter(i => i.status === "realizado"), [items]);
  const activeItems = subTab === "fila" ? filaItems : realizadosItems;

  // Cada visão tem sua ordenação natural: fila = ordem de chegada (mais
  // antigo primeiro); realizados = entrega mais recente primeiro.
  function switchSubTab(next: ServicesSubTab) {
    if (next === subTab) return;
    setSubTab(next);
    setSortKey("createdAt");
    setSortDir(next === "fila" ? "asc" : "desc");
  }

  const serverOptions = useMemo(() => Array.from(new Set(activeItems.map(i => i.servidor).filter(Boolean))).sort(), [activeItems]);
  const vocOptions = useMemo(() => VOCATIONS.filter(v => activeItems.some(i => i.voc === v)), [activeItems]);

  const filteredItems = useMemo(() => {
    return activeItems.filter(i => {
      if (fPersonagem && !i.personagem.toLowerCase().includes(fPersonagem.toLowerCase())) return false;
      if (fServidor && i.servidor !== fServidor) return false;
      if (fVoc && i.voc !== fVoc) return false;
      if (fOwner && !i.ownerName.toLowerCase().includes(fOwner.toLowerCase())) return false;
      if (fAddedBy && !(i.addedBy || "").toLowerCase().includes(fAddedBy.toLowerCase())) return false;
      if (fNotes && !i.notes.toLowerCase().includes(fNotes.toLowerCase())) return false;
      if (fLevel) { const t = parseInt(fLevel, 10); if (Number.isFinite(t)) { if (fLevelOp === "gte" && i.level < t) return false; if (fLevelOp === "lte" && i.level > t) return false; } }
      if (fValor) { const t = parseInt(fValor, 10); if (Number.isFinite(t)) { if (fValorOp === "gte" && i.valorCombinado < t) return false; if (fValorOp === "lte" && i.valorCombinado > t) return false; } }
      if (fData) {
        const raw = (i.dataAdicionado || "").toLowerCase();
        const fmt = formatDateBR(i.dataAdicionado).toLowerCase();
        if (!raw.includes(fData.toLowerCase()) && !fmt.includes(fData.toLowerCase())) return false;
      }
      const visibleWhats = canViewServiceWhats(i) && !!buildWhatsLink(i);
      if (fWhats === "Sim" && !visibleWhats) return false;
      if (fWhats === "Não" && visibleWhats) return false;
      if (fQuest && i.quest !== fQuest) return false;
      if (fPgto && (i.paymentMethod || "") !== fPgto) return false;
      return true;
    });
  }, [activeItems, fPersonagem, fServidor, fVoc, fLevel, fLevelOp, fOwner, fValor, fValorOp, fData, fAddedBy, fNotes, fWhats, fQuest, fPgto]);

  const sortedItems = useMemo(() => {
    return [...filteredItems].sort((a, b) => {
      // Ordenação padrão: por ordem de chegada (createdAt mais antigo primeiro)
      if (!sortKey) return a.createdAt - b.createdAt;
      let av: any, bv: any;
      switch (sortKey) {
        case "personagem": av = a.personagem; bv = b.personagem; break;
        case "servidor": av = a.servidor; bv = b.servidor; break;
        case "voc": av = a.voc; bv = b.voc; break;
        case "level": av = a.level; bv = b.level; break;
        case "ownerName": av = a.ownerName; bv = b.ownerName; break;
        case "valor": av = a.valorCombinado; bv = b.valorCombinado; break;
        case "data":
          // Na sub-guia "Realizados" a coluna exibe a entrega — ordenar por
          // dataAdicionado lá seria ordenar pela coluna errada.
          av = subTab === "realizados" ? (a.realizadoAt || a.createdAt) : a.dataAdicionado;
          bv = subTab === "realizados" ? (b.realizadoAt || b.createdAt) : b.dataAdicionado;
          break;
        case "quest": av = a.quest; bv = b.quest; break;
        case "addedBy": av = a.addedBy || ""; bv = b.addedBy || ""; break;
        case "createdAt":
          // Na sub-guia "Realizados" a coluna (e a ordem natural) é a ENTREGA;
          // na fila continua sendo a ordem de chegada.
          av = subTab === "realizados" ? (a.realizadoAt || a.createdAt) : a.createdAt;
          bv = subTab === "realizados" ? (b.realizadoAt || b.createdAt) : b.createdAt;
          break;
        default: return 0;
      }

      let cmp = 0;
      if (typeof av === "number" && typeof bv === "number") cmp = av - bv;
      else cmp = String(av).localeCompare(String(bv), "pt-BR", { sensitivity: "base" });

      return sortDir === "desc" ? -cmp : cmp;
    });
  }, [filteredItems, sortKey, sortDir, subTab]);

  // Destaque vindo do clique em notificação de service "Qualquer um": a guia
  // acabou de montar (a navegação troca de aba antes), então a linha pode
  // ainda não existir no primeiro frame — duas tentativas (rAF + timeout).
  useEffect(() => {
    if (!highlightId) return;
    let cancelled = false;
    const scroll = () => {
      if (cancelled) return;
      const row = document.querySelector<HTMLElement>(`[data-waiting-id="${CSS.escape(highlightId)}"]`);
      if (row) row.scrollIntoView({ behavior: "smooth", block: "center" });
    };
    const raf = window.requestAnimationFrame(scroll);
    const timer = window.setTimeout(scroll, 350);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [highlightId, subTab]);

  function openWhats(item: WaitingService) {
    if (!canViewServiceWhats(item)) {
      customAlert("Você não tem permissão para visualizar o WhatsApp deste cliente.");
      return;
    }
    const link = buildWhatsLink(item);
    if (!link) { customAlert("Este service não possui WhatsApp cadastrado."); return; }
    // Em vez de abrir a conversa seca, abre o SELETOR de mensagens padrão:
    // o link wa.me só é aberto com a mensagem escolhida pré-preenchida.
    setWaTarget(item);
  }

  function handleTriagem(item: WaitingService) {
    if (!item.triagem) {
      customConfirm("O nome do personagem foi realmente conferido no site?", () => {
        updateField(item, { triagem: true });
      });
      return;
    }
    updateField(item, { triagem: false });
  }

  function SI({ col }: { col: SortKey }) {
    if (sortKey === col && sortDir === "asc") return <ArrowUp size={11} className="text-emerald-400" />;
    if (sortKey === col && sortDir === "desc") return <ArrowDown size={11} className="text-emerald-400" />;
    return <ArrowUpDown size={11} className="opacity-30" />;
  }

  const thCls = "bg-[var(--th-bg-overlay)] px-2 py-1.5 border-b border-[var(--th-line)]/100 text-xs font-semibold uppercase tracking-wider text-slate-400 cursor-pointer hover:bg-[var(--th-bg-hover)] select-none whitespace-nowrap text-center";
  const thStatic = "bg-[var(--th-bg-overlay)] px-2 py-1.5 border-b border-[var(--th-line)]/100 text-xs font-semibold uppercase tracking-wider text-slate-400 whitespace-nowrap select-none text-center";

  // =========================================================
  // RESTRIÇÃO DE ACESSO: apenas Boss e VIP podem usar esta aba
  // =========================================================

  // Responsividade: calcula a escala da janela não-Boss/não-VIP baseada na altura da tela
  const [nonAuthScale, setNonAuthScale] = useState(1);

  useEffect(() => {
    function handleNonAuthResize() {
      const targetHeight = 850; // Altura ideal de design da janela
      const availableHeight = window.innerHeight * 0.95; // 95vh disponível
      // Reduz a escala se a altura da tela for insuficiente (mínimo de 0.5)
      if (availableHeight < targetHeight) {
        setNonAuthScale(Math.max(0.5, availableHeight / targetHeight));
      } else {
        setNonAuthScale(1);
      }
    }
    handleNonAuthResize();
    window.addEventListener("resize", handleNonAuthResize);
    return () => window.removeEventListener("resize", handleNonAuthResize);
  }, []);

  if (!isAuthorized) {
    return (
      <div className="flex flex-col h-full w-full bg-[var(--th-bg-base)]">
        {/* Header igual ao normal */}
        <div className="flex items-center justify-between px-3 py-2 bg-gradient-to-r from-[var(--th-bg-raised)] to-[var(--th-bg-base)] border-b border-[var(--th-line)]/30 flex-shrink-0">
          <div className="flex items-center gap-2">
            <Clock size={14} className="text-cyan-400" />
            <span className="text-sm font-bold text-cyan-300 uppercase tracking-wider">Lista de Espera</span>
            {/* ── Acesso VIP direto: Painel VIP ou Seja VIP ── */}
            <VipAccessButton userProfile={userProfile} />
          </div>
        </div>
        {/* Mensagem informativa — tela de upgrade VIP aprimorada */}
        <div className="flex-1 min-h-0 flex items-center justify-center overflow-y-auto">
          <div
            className="flex flex-col items-center px-6 py-8 text-center gap-6"
            style={{
              transform: `scale(${nonAuthScale})`,
              transformOrigin: "center center",
              transition: "transform 0.2s ease-in-out"
            }}
          >
            {/* Ícone principal com glow */}
            <div className="relative">
              <div className="absolute inset-0 rounded-full bg-amber-500/20 blur-xl scale-150" />
              <div className="relative w-20 h-20 rounded-full bg-gradient-to-br from-amber-500/20 to-amber-600/10 border-2 border-amber-500/40 flex items-center justify-center shadow-[0_0_30px_color-mix(in_oklab,var(--color-amber-500)_15%,transparent)]">
                <Crown size={36} className="text-amber-400" />
              </div>
            </div>

            {/* Título e subtítulo */}
            <div className="space-y-3 max-w-lg">
              <h3 className="text-xl font-extrabold text-white tracking-tight">
                Desbloqueie o Acesso <span className="text-transparent bg-clip-text bg-gradient-to-r from-amber-300 to-amber-500">VIP</span>
              </h3>
              <p className="text-sm text-slate-400 leading-relaxed">
                Como <strong className="text-amber-300">VIP</strong>, você pode cadastrar e divulgar seus serviços em um formulário exclusivo e se tornar um <strong className="text-amber-300">Serviceiro</strong>, ficando disponível para ser escolhido por qualquer cliente da plataforma.
              </p>
            </div>

            {/* Cards de benefícios */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 w-full max-w-lg">
              <div className="flex flex-col items-center gap-2 bg-[var(--th-bg-hover)] border border-amber-900/30 rounded-xl px-4 py-4">
                <div className="w-10 h-10 rounded-lg bg-amber-500/10 border border-amber-500/25 flex items-center justify-center">
                  <Star size={18} className="text-amber-400" />
                </div>
                <span className="text-[11px] font-semibold text-slate-300 text-center leading-tight">Formulário Exclusivo</span>
              </div>
              <div className="flex flex-col items-center gap-2 bg-[var(--th-bg-hover)] border border-amber-900/30 rounded-xl px-4 py-4">
                <div className="w-10 h-10 rounded-lg bg-amber-500/10 border border-amber-500/25 flex items-center justify-center">
                  <Shield size={18} className="text-amber-400" />
                </div>
                <span className="text-[11px] font-semibold text-slate-300 text-center leading-tight">Seja um Serviceiro</span>
              </div>
              <div className="flex flex-col items-center gap-2 bg-[var(--th-bg-hover)] border border-amber-900/30 rounded-xl px-4 py-4">
                <div className="w-10 h-10 rounded-lg bg-amber-500/10 border border-amber-500/25 flex items-center justify-center">
                  <Zap size={18} className="text-amber-400" />
                </div>
                <span className="text-[11px] font-semibold text-slate-300 text-center leading-tight">Acesso Completo</span>
              </div>
            </div>

            {/* Preço destaque */}
            <div className="bg-gradient-to-r from-amber-900/20 via-amber-800/15 to-amber-900/20 border border-amber-700/30 rounded-xl px-6 py-3 flex items-center gap-3">
              <span className="text-sm text-slate-300">Apenas</span>
              <span className="text-2xl font-black text-amber-300">100 RC</span>
              <span className="text-sm text-slate-300">por <strong className="text-white">30 dias</strong> de VIP</span>
            </div>

            {/* Botão / CTA */}
            <p className="text-xs text-slate-500">Entre em contato com um administrador e torne-se VIP hoje mesmo:</p>

            {/* Lista de bosses */}
            <div className="flex flex-col gap-2 w-full max-w-md">
              {bosses.length === 0 ? (
                <div className="text-xs text-slate-500 italic py-4">Nenhum proprietário encontrado.</div>
              ) : (
                bosses.map((boss) => {
                  const phone = ((boss.whatsappCountry || "") + (boss.whatsappRegion || "") + (boss.whatsappNumber || "")).replace(/\D/g, "");
                  const hasPhone = phone.length > 0;
                  const waLink = `https://wa.me/${phone}`;
                  return (
                    <div key={boss.uid} className="flex items-center justify-between gap-3 bg-[var(--th-bg-hover)] border border-amber-900/20 hover:border-amber-700/40 rounded-xl px-4 py-3 transition-colors">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-amber-500/20 to-amber-600/10 border border-amber-500/30 flex items-center justify-center flex-shrink-0">
                          <span className="text-sm font-bold text-amber-400">{boss.nome.charAt(0).toUpperCase()}</span>
                        </div>
                        <div className="flex flex-col items-start min-w-0">
                          <span className="text-sm font-semibold text-white truncate">{boss.nome}</span>
                          <span className="text-[10px] text-amber-500/70 font-medium uppercase tracking-wider">Administrador</span>
                        </div>
                      </div>
                      {hasPhone ? (
                        <a href={waLink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-gradient-to-r from-emerald-600/20 to-emerald-500/15 hover:from-emerald-500/30 hover:to-emerald-400/20 border border-emerald-500/40 text-emerald-300 hover:text-emerald-200 text-[11px] font-bold transition-all flex-shrink-0 shadow-[0_0_10px_rgba(16,185,129,0.08)]">
                          <MessageCircle size={13} /> WhatsApp <ChevronRight size={12} />
                        </a>
                      ) : (
                        <span className="text-[10px] text-slate-500 italic">(sem WhatsApp cadastrado)</span>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full w-full bg-[var(--th-bg-base)]">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-gradient-to-r from-[var(--th-bg-raised)] to-[var(--th-bg-base)] border-b border-[var(--th-line)]/100 flex-shrink-0">
        <div className="flex items-center gap-2">
          <Clock size={14} className="text-cyan-400" />
          <span className="text-sm font-bold text-cyan-300 uppercase tracking-wider">Lista de Espera</span>
          <span className="text-xs font-bold text-cyan-400 tabular-nums">
            {filteredItems.length}/{activeItems.length} service(s) {subTab === "fila" ? "na fila" : "realizado(s)"}
          </span>
          {/* ── Acesso VIP direto: Painel VIP ou Seja VIP ── */}
          <VipAccessButton userProfile={userProfile} />
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={async () => {
              const formUrl = "https://chernobyl-pt.web.app/#/servico";
              let copied = false;
              // Tentativa 1: API moderna (Clipboard API)
              if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
                try {
                  await navigator.clipboard.writeText(formUrl);
                  copied = true;
                } catch {
                  copied = false;
                }
              }
              // Tentativa 2: Fallback via execCommand (navegadores antigos ou contextos sem permissão)
              if (!copied) {
                try {
                  const textarea = document.createElement("textarea");
                  textarea.value = formUrl;
                  textarea.style.position = "fixed";
                  textarea.style.left = "-9999px";
                  textarea.style.top = "-9999px";
                  textarea.style.opacity = "0";
                  document.body.appendChild(textarea);
                  textarea.focus();
                  textarea.select();
                  copied = document.execCommand("copy");
                  document.body.removeChild(textarea);
                } catch {
                  copied = false;
                }
              }
              if (copied) {
                customAlert("Link do formulário copiado! Envie para o cliente preencher.", "Link Copiado");
              } else {
                customAlert(`Não foi possível copiar automaticamente. Copie manualmente:\n\n${formUrl}`, "Copiar Link");
              }
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/50 text-amber-400 transition-colors whitespace-nowrap"
          >
            <ExternalLink size={14} /> Link Formulário
          </button>
          {/* Mensagens padrão do WhatsApp — configuração (título/conteúdo) das
              mensagens oferecidas no seletor ao clicar no WhatsApp do cliente. */}
          <button
            type="button"
            onClick={() => setWaTemplatesOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/50 text-emerald-400 transition-colors whitespace-nowrap"
            title="Configurar as mensagens padrão enviadas aos clientes pelo WhatsApp"
          >
            <MessageCircle size={14} /> Mensagens
          </button>
          {/* Adicionar só faz sentido na fila: um service novo nasce aguardando
              atendimento — em "Realizados" a lista é alimentada pela conclusão
              das Quests. */}
          {subTab === "fila" && (
            <button
              onClick={openAdd}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/50 text-cyan-300 hover:text-cyan-200 transition-colors whitespace-nowrap"
            >
              <Plus size={14} /> Adicionar Service
            </button>
          )}
        </div>
      </div>

      {/* ── Sub-guias: Na Fila / Realizados ─────────────────────────────────
          Mesma semântica de "Meus Services": concluída a Quest, a entrada é
          marcada como "realizado" (não apagada) e migra para cá. */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-[var(--th-line)]/60 bg-[var(--th-bg-base)] flex-shrink-0">
        <button
          type="button"
          onClick={() => switchSubTab("fila")}
          aria-pressed={subTab === "fila"}
          className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-bold transition-colors cursor-pointer ${
            subTab === "fila"
              ? "border border-cyan-400/60 bg-cyan-500/15 text-cyan-200"
              : "border border-white/10 bg-white/[0.02] text-slate-500 hover:bg-white/5 hover:text-slate-300"
          }`}
          title="Personagens aguardando atendimento"
        >
          <Clock size={12} /> Na Fila
          <span className="tabular-nums opacity-80">{filaItems.length}</span>
        </button>
        <button
          type="button"
          onClick={() => switchSubTab("realizados")}
          aria-pressed={subTab === "realizados"}
          className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-bold transition-colors cursor-pointer ${
            subTab === "realizados"
              ? "border border-emerald-400/60 bg-emerald-500/15 text-emerald-200"
              : "border border-white/10 bg-white/[0.02] text-slate-500 hover:bg-white/5 hover:text-slate-300"
          }`}
          title="Services entregues (Quest concluída com sucesso)"
        >
          <CheckCircle2 size={12} /> Realizados
          <span className="tabular-nums opacity-80">{realizadosItems.length}</span>
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-x-scroll overflow-y-auto max-w-full min-w-0">
        {activeItems.length === 0 ? (
          subTab === "fila" ? (
            <div className="flex flex-col items-center justify-center h-full text-slate-500 gap-3 px-6">
              <Clock size={40} className="opacity-30" />
              <div className="text-base font-medium">Lista de espera vazia</div>
              <div className="text-xs text-center">Clique em "Adicionar Service" para incluir um personagem na lista.</div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-slate-500 gap-3 px-6">
              <CheckCircle2 size={40} className="opacity-30" />
              <div className="text-base font-medium">Nenhum service realizado ainda</div>
              <div className="text-xs text-center">Quando a Quest de uma PT for concluída com sucesso, os personagens de Service dela aparecem aqui automaticamente.</div>
            </div>
          )
        ) : (
          <table className="border-collapse w-full">
            <colgroup>
              <col /><col /><col /><col /><col /><col /><col /><col /><col /><col /><col /><col /><col />
              <col style={{ width: "100%" }} />
            </colgroup>
            <thead className="sticky top-0 z-10">
              <tr>
                <th className={`${thStatic} w-8`}>#</th>
                <th className={thStatic}>Triagem</th>
                <th className={thCls} onClick={() => toggleSort("personagem")}><div className="flex items-center justify-center gap-1">Personagem <SI col="personagem" /></div></th>
                <th className={thCls} onClick={() => toggleSort("servidor")}><div className="flex items-center justify-center gap-1">Servidor <SI col="servidor" /></div></th>
                <th className={thCls} onClick={() => toggleSort("voc")}><div className="flex items-center justify-center gap-1">Voc <SI col="voc" /></div></th>
                <th className={thCls} onClick={() => toggleSort("level")}><div className="flex items-center justify-center gap-1">Level <SI col="level" /></div></th>
                <th className={thCls} onClick={() => toggleSort("ownerName")}><div className="flex items-center justify-center gap-1">Cliente <SI col="ownerName" /></div></th>
                <th className={thCls} onClick={() => toggleSort("addedBy")}><div className="flex items-center justify-center gap-1">Serviceiro <SI col="addedBy" /></div></th>
                <th className={thCls} onClick={() => toggleSort("valor")}><div className="flex items-center justify-center gap-1">Valor <SI col="valor" /></div></th>
                <th className={thStatic} title="Forma de pagamento">Pgto</th>
                <th className={thCls} onClick={() => toggleSort("data")}><div className="flex items-center justify-center gap-1">{subTab === "fila" ? "Adicionado em" : "Realizado em"} <SI col="data" /></div></th>
                <th className={thStatic}>WhatsApp</th>
                <th className={thStatic}>Quest</th>
                {/* LARGURA AUMENTADA PARA A COLUNA ANOTAÇÕES: min-w-[300px] */}
                <th className={thStatic + " min-w-[300px]"}>Anotações</th>
                <th className="bg-[var(--th-bg-overlay)] border-b border-[var(--th-line)]/100" />
              </tr>
              {/* Filter row */}
              <tr>
                <th className="bg-[var(--th-bg-base)] px-1 py-1 border-b border-[var(--th-line)]/100 text-center">
                  <button type="button" onClick={clearFilters}
                    className={`w-7 h-7 rounded flex items-center justify-center transition-all cursor-pointer mx-auto ${hasActiveFilters ? "bg-amber-500 text-black font-bold animate-pulse" : "bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white"}`}
                    title="Limpar todos os filtros">
                    <RotateCcw size={11} />
                  </button>
                </th>
                <th className="bg-[var(--th-bg-base)] px-1 py-1 border-b border-[var(--th-line)]/80" />
                <th className="bg-[var(--th-bg-base)] px-1 py-1 border-b border-[var(--th-line)]/80"><input type="text" value={fPersonagem} onChange={e => setFPersonagem(e.target.value)} placeholder="filtrar..." className="filter-input" /></th>
                <th className="bg-[var(--th-bg-base)] px-1 py-1 border-b border-[var(--th-line)]/80"><select value={fServidor} onChange={e => setFServidor(e.target.value)} className="filter-select"><option value="">Todos</option>{serverOptions.map(s => <option key={s} value={s}>{s}</option>)}</select></th>
                <th className="bg-[var(--th-bg-base)] px-1 py-1 border-b border-[var(--th-line)]/80"><select value={fVoc} onChange={e => setFVoc(e.target.value)} className="filter-select text-center"><option value="">Todas</option>{vocOptions.map(v => <option key={v} value={v}>{v}</option>)}</select></th>
                <th className="bg-[var(--th-bg-base)] px-1 py-1 border-b border-[var(--th-line)]/80">
                  <div className="flex items-center gap-0.5">
                    <input type="text" inputMode="numeric" value={fLevel} onChange={e => setFLevel(e.target.value.replace(/[^\d]/g, ""))} placeholder="nº" className="filter-input text-right tabular-nums w-12" />
                    <button onClick={() => setFLevelOp(o => o === "gte" ? "lte" : "gte")} className={`w-6 h-6 flex-shrink-0 rounded border text-xs font-black ${fLevelOp === "gte" ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300" : "border-rose-500/40 bg-rose-500/15 text-rose-300"}`}>{fLevelOp === "gte" ? "+" : "−"}</button>
                  </div>
                </th>
                <th className="bg-[var(--th-bg-base)] px-1 py-1 border-b border-[var(--th-line)]/80"><input type="text" value={fOwner} onChange={e => setFOwner(e.target.value)} placeholder="filtrar..." className="filter-input" /></th>
                <th className="bg-[var(--th-bg-base)] px-1 py-1 border-b border-[var(--th-line)]/80"><input type="text" value={fAddedBy} onChange={e => setFAddedBy(e.target.value)} placeholder="filtrar..." className="filter-input" /></th>
                <th className="bg-[var(--th-bg-base)] px-1 py-1 border-b border-[var(--th-line)]/80">
                  <div className="flex items-center gap-0.5">
                    <input type="text" inputMode="numeric" value={fValor} onChange={e => setFValor(e.target.value.replace(/[^\d]/g, ""))} placeholder="nº" className="filter-input text-right tabular-nums w-16" />
                    <button onClick={() => setFValorOp(o => o === "gte" ? "lte" : "gte")} className={`w-6 h-6 flex-shrink-0 rounded border text-xs font-black ${fValorOp === "gte" ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300" : "border-rose-500/40 bg-rose-500/15 text-rose-300"}`}>{fValorOp === "gte" ? "+" : "−"}</button>
                  </div>
                </th>
                <th className="bg-[var(--th-bg-base)] px-1 py-1 border-b border-[var(--th-line)]/80">
                  <select value={fPgto} onChange={e => setFPgto(e.target.value as ServicePaymentMethod)} className="filter-select text-center" title="Filtrar por forma de pagamento">
                    <option value="">Todas</option>
                    {Object.entries(SERVICE_PAYMENT_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </th>
                <th className="bg-[var(--th-bg-base)] px-1 py-1 border-b border-[var(--th-line)]/80"><input type="text" value={fData} onChange={e => setFData(e.target.value)} placeholder="dd/mm" className="filter-input" /></th>
                <th className="bg-[var(--th-bg-base)] px-1 py-1 border-b border-[var(--th-line)]/80">
                  <div className="grid grid-cols-2 gap-0.5">
                    <button type="button" onClick={() => setFWhats(fWhats === "Sim" ? "" : "Sim")} className={`h-6 rounded border text-[10px] font-bold ${fWhats === "Sim" ? "border-emerald-500/50 bg-emerald-500/20 text-emerald-300" : "border-emerald-500/15 bg-black/20 text-emerald-500/50 hover:bg-emerald-500/10"}`}>S</button>
                    <button type="button" onClick={() => setFWhats(fWhats === "Não" ? "" : "Não")} className={`h-6 rounded border text-[10px] font-bold ${fWhats === "Não" ? "border-rose-500/50 bg-rose-500/20 text-rose-300" : "border-rose-500/15 bg-black/20 text-rose-500/50 hover:bg-rose-500/10"}`}>N</button>
                  </div>
                </th>
                <th className="bg-[var(--th-bg-base)] px-1 py-1 border-b border-[var(--th-line)]/80">
                  <div className="grid grid-cols-2 gap-0.5">
                    <button type="button" onClick={() => setFQuest(fQuest === "soulwar" ? "" : "soulwar")} className={`h-6 rounded border text-[9px] font-bold ${fQuest === "soulwar" ? "border-slate-400 bg-slate-500/20 text-slate-200" : "border-slate-600/30 bg-white/[0.02] text-slate-500 hover:bg-white/5"}`}>SW</button>
                    <button type="button" onClick={() => setFQuest(fQuest === "sanguine" ? "" : "sanguine")} className={`h-6 rounded border text-[9px] font-bold ${fQuest === "sanguine" ? "border-rose-500/50 bg-rose-500/20 text-rose-300" : "border-rose-600/30 bg-white/[0.02] text-rose-500 hover:bg-white/5"}`}>SG</button>
                  </div>
                </th>
                <th className="bg-[var(--th-bg-base)] px-1 py-1 border-b border-[var(--th-line)]/80"><input type="text" value={fNotes} onChange={e => setFNotes(e.target.value)} placeholder="filtrar..." className="filter-input" /></th>
                <th className="bg-[var(--th-bg-base)] border-b border-[var(--th-line)]/80" />
              </tr>
            </thead>
            <tbody>
              {sortedItems.length === 0 && (
                <tr><td colSpan={15} className="text-center py-16 text-slate-500">Nenhum service encontrado com os filtros atuais.</td></tr>
              )}
              {sortedItems.map((item, idx) => {
                const whatsDisplay = formatWhatsDisplay(item);
                const canViewWhats = canViewServiceWhats(item);
                const hasVisibleWhats = canViewWhats && !!buildWhatsLink(item);
                const whatsappRestricted = !!buildWhatsLink(item) && !canViewWhats;
                return (
                  <tr
                    key={item.id}
                    data-waiting-id={item.id}
                    className={`group border-b border-[var(--th-line)]/50 transition-colors ${
                      highlightId && item.id === highlightId
                        ? "bg-amber-500/25 ring-2 ring-inset ring-amber-400/60 shadow-[0_0_18px_color-mix(in_oklab,var(--color-amber-500)_30%,transparent)] animate-pulse"
                        : `${idx % 2 === 0 ? "bg-[var(--th-bg-base)]" : "bg-[var(--th-bg-raised)]"} hover:bg-[var(--th-bg-overlay)]`
                    }`}
                  >
                    <td className="px-2 py-1 text-center font-mono text-slate-500 font-bold whitespace-nowrap">{idx + 1}</td>
                    <td className="px-2 py-1 text-center whitespace-nowrap">
                      <input
                        type="checkbox"
                        checked={!!item.triagem}
                        onChange={() => handleTriagem(item)}
                        className="w-4 h-4 accent-cyan-500 cursor-pointer"
                        title={item.triagem ? "Nome conferido no site" : "Marcar triagem"}
                      />
                    </td>
                    <td className="px-2 py-1 text-center font-medium whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => handleCopyPersonagem(item.id, item.personagem)}
                        className="inline-flex items-center gap-1 text-slate-100 hover:text-cyan-300 transition-colors cursor-pointer"
                        title="Clique para copiar o nome do personagem"
                      >
                        <span>{item.personagem}</span>
                        {copiedCharId === item.id && <Check size={12} className="text-emerald-400" />}
                      </button>
                    </td>
                    <td className="px-2 py-1 text-center text-slate-300 whitespace-nowrap">{item.servidor || "—"}</td>
                    <td className="px-2 py-1 text-center whitespace-nowrap"><span className="font-bold" style={{ color: VOC_COLORS[item.voc] }}>{item.voc}</span></td>
                    <td className="px-2 py-1 text-center tabular-nums whitespace-nowrap">{item.level || "—"}</td>
                    <td className="px-2 py-1 text-center text-cyan-300 whitespace-nowrap">{item.ownerName || "—"}</td>
                    <td className="px-2 py-1 text-center text-slate-400 whitespace-nowrap">{item.addedBy || "—"}</td>
                    <td className="px-2 py-1 text-center tabular-nums text-emerald-400 font-medium whitespace-nowrap">{formatRC(
                      (() => {
                        // Auto-detect: se o campo notes contiver "Pagamento: RC" ou "Pagamento: PIX"
                        // e o valor atual for 0 ou indefinido, exibe 1000 RC
                        const notes = (item.notes || "").toLowerCase();
                        if ((notes.includes("pagamento: rc") || notes.includes("pagamento: pix")) && (!item.valorCombinado || item.valorCombinado === 0)) {
                          return 1000;
                        }
                        return item.valorCombinado;
                      })()
                    )}</td>
                    <td className="px-2 py-1 text-center whitespace-nowrap">
                      {paymentLabel(item.paymentMethod) ? (
                        <span className="text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border border-sky-500/30 bg-sky-500/10 text-sky-300">
                          {paymentLabel(item.paymentMethod)}
                        </span>
                      ) : (
                        <span className="text-slate-600 text-xs">—</span>
                      )}
                    </td>
                    {subTab === "fila" ? (
                      <td className="px-2 py-1 text-center text-slate-300 tabular-nums whitespace-nowrap" title={`Adicionado em ${formatWaitingAddedAt(item)} (horário local)`}>{formatWaitingAddedAt(item)}</td>
                    ) : (
                      <td className="px-2 py-1 text-center text-emerald-300/90 tabular-nums whitespace-nowrap" title={`Realizado em ${formatWaitingRealizadoAt(item)} (horário local)`}>{formatWaitingRealizadoAt(item)}</td>
                    )}
                    <td className="px-2 py-1 text-center whitespace-nowrap">
                      {hasVisibleWhats ? (
                        <button
                          onClick={() => openWhats(item)}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-300 hover:text-emerald-200 text-[11px] font-medium transition-colors"
                          title={`Enviar mensagem para ${whatsDisplay}`}
                        >
                          <MessageCircle size={12} /> {whatsDisplay}
                        </button>
                      ) : whatsappRestricted ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-white/5 border border-white/10 text-slate-500 text-[11px] font-medium" title="WhatsApp visível apenas para o Serviceiro selecionado ou para Boss">
                          🔒 Restrito
                        </span>
                      ) : (
                        <span className="text-slate-600 text-xs">—</span>
                      )}
                    </td>
                    <td className="px-2 py-1 text-center whitespace-nowrap">
                      {item.quest === "sanguine" ? (
                        <span className="text-rose-400 font-bold text-xs tracking-wider">SANGUINE</span>
                      ) : (
                        <span className="text-slate-400 font-bold text-xs tracking-wider">SOULWAR</span>
                      )}
                    </td>
                    {/* LARGURA AUMENTADA PARA A COLUNA ANOTAÇÕES: min-w-[300px] w-full */}
                    <td className="px-1 py-0.5 min-w-[300px] w-full text-center">
                      <input
                        type="text"
                        value={notesDrafts[item.id] !== undefined ? notesDrafts[item.id] : item.notes}
                        onChange={e => handleNotesChange(item, e.target.value)}
                        onBlur={() => {
                          if (notesDrafts[item.id] !== undefined) {
                            commitNotesDraft(item, notesDrafts[item.id]);
                          }
                        }}
                        placeholder="—"
                        className="w-full bg-transparent border-b border-white/10 focus:border-amber-500/50 outline-none px-1 py-0.5 text-slate-300 placeholder-slate-600 text-center"
                        maxLength={150}
                      />
                    </td>
                    <td className="px-2 py-1 text-center whitespace-nowrap">
                      <div className="inline-flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        {/* Botão Editar - visível para Boss ou Serviceiro designado */}
                        {canEditService(item) && (
                          <button onClick={() => openEdit(item)} className="p-1 rounded text-slate-400 hover:bg-white/10 hover:text-cyan-400 cursor-pointer" title="Editar"><Pencil size={13} /></button>
                        )}
                        {/* Botão Excluir - visível apenas para Boss */}
                        {canDeleteWaiting && (
                          <button onClick={() => handleDelete(item.id)} className="p-1 rounded text-slate-400 hover:bg-white/10 hover:text-rose-400 cursor-pointer" title="Excluir"><Trash2 size={13} /></button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <ServiceModal open={modalOpen} initial={editing} userName={userName} eligibleServiceiros={eligibleServiceiros} userProfileRole={userProfile?.role} onSave={handleSave} onClose={() => setModalOpen(false)} />

      {/* Contato com o cliente: seletor de mensagem padrão → wa.me com o
          texto pré-preenchido (?text=). As permissões do WhatsApp continuam
          sendo verificadas em `openWhats`, antes de chegar aqui. */}
      <WhatsappMessagePicker
        open={!!waTarget && !waTemplatesOpen}
        phoneDigits={waTarget ? cleanWhatsappPhone(waTarget.whatsappCountry, waTarget.whatsappArea, waTarget.whatsappNumber) : ""}
        phoneDisplay={waTarget ? formatWhatsDisplay(waTarget) : ""}
        templates={waTemplates}
        context={waContext}
        onClose={() => setWaTarget(null)}
        onOpenSettings={() => setWaTemplatesOpen(true)}
        onOpenLink={openExternalUrl}
      />

      {/* Configuração das mensagens padrão (título/conteúdo), por usuário. */}
      <WhatsappTemplateModal
        open={waTemplatesOpen}
        templates={waTemplates}
        onClose={() => setWaTemplatesOpen(false)}
        onSave={handleWaTemplatesSave}
      />
    </div>
  );
}

// Lista oficial centralizada em src/constants/servers.ts

const ONLY_LETTERS_REGEX = /^[A-Za-zÀ-ÿ\s'\-]+$/;

function ServiceModal({ open, initial, userName, eligibleServiceiros, userProfileRole, onSave, onClose }: {
  open: boolean;
  initial: WaitingService | null;
  userName: string;
  eligibleServiceiros: { uid: string; nome: string }[];
  userProfileRole?: string;
  onSave: (s: WaitingService) => void;
  onClose: () => void;
}) {
  const [data, setData] = useState<WaitingService>(emptyService(userName));
  const firstFieldRef = useRef<HTMLInputElement>(null);

  // A moldura de modal limita altura e entrega rolagem interna sem reduzir o
  // formulário por transform em viewport menor.

  useEffect(() => {
    if (open) {
      const svc = initial ? { ...initial } : emptyService(userName);
      // Auto-selecionar Serviceiro:
      // Se initial já possui addedBy, mantém; senão, seleciona o usuário logado (se elegível) ou "Qualquer um".
      if (!svc.addedBy || svc.addedBy.trim() === "") {
        const isSelfEligible = (userProfileRole === "Boss" || userProfileRole === "VIP") && eligibleServiceiros.some(u => u.nome === userName);
        svc.addedBy = isSelfEligible ? userName : "Qualquer um";
      }
      setData(svc);
      setTimeout(() => firstFieldRef.current?.focus(), 50);
    }
  }, [open, initial, userName, eligibleServiceiros, userProfileRole]);

  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCloseRef.current();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;

  function set<K extends keyof WaitingService>(k: K, v: WaitingService[K]) {
    setData(d => ({ ...d, [k]: v }));
  }

  const personagemTrim = data.personagem.trim();
  const ownerTrim = data.ownerName.trim();
  const addedByTrim = (data.addedBy || "").trim();
  const countryDigits = (data.whatsappCountry || "").replace(/\D/g, "");
  const areaDigits = (data.whatsappArea || "").replace(/\D/g, "");
  const numberDigits = (data.whatsappNumber || "").replace(/\D/g, "");

  const isValid =
    personagemTrim.length > 0 && ONLY_LETTERS_REGEX.test(personagemTrim) &&
    ownerTrim.length > 0 && ONLY_LETTERS_REGEX.test(ownerTrim) &&
    !!data.servidor && isOfficialServer(data.servidor) &&
    Number.isFinite(data.level) && data.level > 0 &&
    Number.isFinite(data.valorCombinado) && data.valorCombinado > 0 &&
    countryDigits.length > 0 &&
    areaDigits.length > 0 &&
    numberDigits.length > 0 &&
    addedByTrim.length > 0;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isValid) return;
    // A lista exibe data+hora a partir do TIMESTAMP `createdAt` (fonte de
    // verdade). Quando a data é corrigida aqui, o timestamp é deslocado para
    // o novo dia preservando a hora original — uma única fonte, sem string
    // formatada como dado primário.
    const nextDate = data.dataAdicionado || todayISO();
    let createdAt = data.createdAt;
    if (initial && nextDate && nextDate !== initial.dataAdicionado) {
      const [year, month, day] = nextDate.split("-").map(Number);
      if (year > 0 && month > 0 && day > 0) {
        const base = new Date(Number.isFinite(initial.createdAt) && initial.createdAt > 0 ? initial.createdAt : Date.now());
        base.setFullYear(year, month - 1, day);
        createdAt = base.getTime();
      }
    }
    onSave({
      ...data,
      personagem: data.personagem.trim(),
      ownerName: data.ownerName.trim(),
      servidor: data.servidor.trim(),
      whatsappCountry: (data.whatsappCountry || "").replace(/\D/g, ""),
      whatsappArea: (data.whatsappArea || "").replace(/\D/g, ""),
      whatsappNumber: (data.whatsappNumber || "").replace(/\D/g, ""),
      addedBy: (data.addedBy || "").trim(),
      dataAdicionado: nextDate,
      ...(createdAt ? { createdAt } : {}),
    });
  }

  const fullWhats = `+${data.whatsappCountry || ""} ${data.whatsappArea || ""} ${data.whatsappNumber || ""}`.trim();

  return (
    <div
      className="app-modal-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <form
        onSubmit={handleSubmit}
        className="app-modal-frame app-modal-size-lg app-modal-frame--scroll relative w-full max-w-2xl bg-[var(--th-bg-base)] border border-[var(--th-line)]/100 rounded-xl"
        style={{ boxShadow: "0 8px 32px rgba(0,0,0,0.4)" }}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between px-7 py-4 bg-gradient-to-r from-[var(--th-bg-raised)] to-[var(--th-bg-base)] border-b border-[var(--th-line)]/60 flex-shrink-0">
          <div className="flex items-center gap-3">
            <Clock size={16} className="text-amber-600" />
            <h2 className="text-base font-medium text-slate-100 tracking-tight">{initial ? "Editar Service" : "Adicionar Service"}</h2>
          </div>
          <button type="button" onClick={onClose} className="text-slate-500 hover:text-slate-200 transition-colors p-1.5 rounded-md hover:bg-white/[0.04]">
            <X size={18} />
          </button>
        </div>

        <div className="app-modal-body p-4 sm:p-7 space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <Field label="Nome do Personagem">
              <input
                ref={firstFieldRef}
                type="text"
                value={data.personagem}
                onChange={e => set("personagem", e.target.value)}
                className="w-full px-3 py-2 bg-[var(--th-n-elev)] border border-white/[0.07] rounded-md text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-cyan-500/50 transition-colors"
                placeholder="Nome do personagem"
                maxLength={50}
              />
            </Field>
            <Field label="Cliente">
              <input
                type="text"
                value={data.ownerName}
                onChange={e => set("ownerName", e.target.value)}
                className="w-full px-3 py-2 bg-[var(--th-n-elev)] border border-white/[0.07] rounded-md text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-cyan-500/50 transition-colors"
                placeholder="Quem solicitou o service"
                maxLength={50}
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            <Field label="Servidor">
              <FilterSelect
                selected={data.servidor}
                onSelect={(v: string) => set("servidor", v)}
                options={SERVER_OPTIONS}
                placeholder="Selecione servidor"
                searchable
                searchPlaceholder="Buscar servidor..."
                allLabel=""
                activeColor="cyan"
                className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-md bg-[var(--th-n-elev)] border border-white/[0.07] hover:border-white/15 focus:border-cyan-500/50 focus:outline-none transition-colors text-sm ${!data.servidor ? "text-slate-500" : "text-slate-200"}`}
              />
            </Field>
            <Field label="Level">
              <NumInput value={data.level} onChange={v => set("level", v)} />
            </Field>
            <Field label="Valor combinado (RC)">
              <NumInput value={data.valorCombinado} onChange={v => set("valorCombinado", v)} />
            </Field>
          </div>

          <Field label="Vocação">
            <div className="grid grid-cols-5 gap-2">
              {VOCATIONS.map(v => (
                <VocRadio key={v} voc={v} selected={data.voc === v} onClick={() => set("voc", v as Vocation)} />
              ))}
            </div>
          </Field>

          <Field label="Forma de Pagamento">
            <div className="grid grid-cols-4 gap-1 rounded-md">
              {(Object.entries(SERVICE_PAYMENT_LABELS) as Array<[Exclude<ServicePaymentMethod, "">, string]>).map(([value, label]) => {
                const selected = data.paymentMethod === value;
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => set("paymentMethod", selected ? "" : value)}
                    aria-pressed={selected}
                    className={`py-1.5 px-1 rounded-md border text-[10px] font-black tracking-tight transition-colors cursor-pointer truncate ${
                      selected
                        ? "border-sky-400/60 bg-sky-500/15 text-sky-200"
                        : "border-white/10 bg-white/[0.02] text-slate-500 hover:bg-white/5"
                    }`}
                    title={label}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </Field>

          <Field label="Quest">
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => set("quest", "soulwar")}
                className={`px-4 py-2.5 rounded-md border text-sm font-medium transition-colors ${
                  data.quest === "soulwar"
                    ? "border-slate-400/60 bg-slate-500/10 text-slate-200"
                    : "border-white/[0.07] bg-[var(--th-n-elev)] text-slate-500 hover:text-slate-300 hover:border-white/15"
                }`}
              >
                SOULWAR
              </button>
              <button
                type="button"
                onClick={() => set("quest", "sanguine")}
                className={`px-4 py-2.5 rounded-md border text-sm font-medium transition-colors ${
                  data.quest === "sanguine"
                    ? "border-rose-500/60 bg-rose-500/10 text-rose-300"
                    : "border-white/[0.07] bg-[var(--th-n-elev)] text-slate-500 hover:text-rose-300 hover:border-white/15"
                }`}
              >
                SANGUINE
              </button>
            </div>
          </Field>

          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-medium uppercase tracking-wider text-slate-500">WhatsApp</span>
              {fullWhats !== "+" && <span className="text-[10px] text-emerald-400/80 font-mono">{fullWhats}</span>}
            </div>
            <div className="grid grid-cols-[80px_80px_1fr] gap-2">
              <div>
                <div className="text-[10px] text-slate-600 mb-1">País</div>
                <div className="relative">
                  <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none text-sm">+</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={data.whatsappCountry}
                    onChange={e => set("whatsappCountry", e.target.value.replace(/\D/g, "").slice(0, 3))}
                    placeholder="55"
                    className="w-full pl-5 pr-2 py-2 bg-[var(--th-n-elev)] border border-white/[0.07] rounded-md text-sm text-slate-200 tabular-nums font-mono focus:outline-none focus:border-cyan-500/50 transition-colors"
                    maxLength={3}
                  />
                </div>
              </div>
              <div>
                <div className="text-[10px] text-slate-600 mb-1">Região</div>
                <input
                  type="text"
                  inputMode="numeric"
                  value={data.whatsappArea}
                  onChange={e => set("whatsappArea", e.target.value.replace(/\D/g, "").slice(0, 3))}
                  placeholder="35"
                  className="w-full px-3 py-2 bg-[var(--th-n-elev)] border border-white/[0.07] rounded-md text-sm text-slate-200 tabular-nums font-mono focus:outline-none focus:border-cyan-500/50 transition-colors"
                  maxLength={3}
                />
              </div>
              <div>
                <div className="text-[10px] text-slate-600 mb-1">Número</div>
                <input
                  type="text"
                  inputMode="numeric"
                  value={data.whatsappNumber}
                  onChange={e => set("whatsappNumber", e.target.value.replace(/\D/g, "").slice(0, 11))}
                  placeholder="988448899"
                  className="w-full px-3 py-2 bg-[var(--th-n-elev)] border border-white/[0.07] rounded-md text-sm text-slate-200 tabular-nums font-mono focus:outline-none focus:border-cyan-500/50 transition-colors"
                  maxLength={11}
                />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <Field label="Serviceiro">
              <FilterSelect
                selected={data.addedBy}
                onSelect={(v: string) => set("addedBy", v)}
                options={eligibleServiceiros.map(u => u.nome).sort((a, b) => a.localeCompare(b, "pt-BR", { sensitivity: "base" }))}
                placeholder="Selecione serviceiro"
                searchable
                searchPlaceholder="Buscar serviceiro..."
                allLabel="Qualquer um"
                allValue="Qualquer um"
                activeColor="cyan"
                className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-md bg-[var(--th-n-elev)] border border-white/[0.07] hover:border-white/15 focus:border-cyan-500/50 focus:outline-none transition-colors text-sm ${!data.addedBy ? "text-slate-500" : "text-slate-200"}`}
              />
            </Field>
            <Field label="Data adicionado na lista">
              <input
                type="date"
                value={data.dataAdicionado || todayISO()}
                onChange={e => set("dataAdicionado", e.target.value)}
                className="w-full px-3 py-2 bg-[var(--th-n-elev)] border border-white/[0.07] rounded-md text-sm text-slate-200 color-scheme-dark focus:outline-none focus:border-cyan-500/50 transition-colors"
              />
            </Field>
          </div>
        </div>

        <div className="app-modal-footer sticky bottom-0 flex flex-wrap items-center justify-end gap-2 px-4 sm:px-7 py-4 bg-gradient-to-r from-[var(--th-bg-raised)] to-[var(--th-bg-base)] border-t border-[var(--th-line)]/60">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md text-slate-400 hover:text-slate-200 hover:bg-white/[0.04] text-sm font-medium transition-colors"
          >
            <Ban size={14} /> Cancelar
          </button>
          <button
            type="submit"
            disabled={!isValid}
            className={`inline-flex items-center gap-1.5 px-5 py-2 rounded-md text-sm font-medium transition-colors ${
              isValid
                ? "bg-cyan-500 hover:bg-cyan-400 text-black cursor-pointer"
                : "bg-white/[0.04] text-slate-600 cursor-not-allowed"
            }`}
            title={isValid ? "Salvar service" : "Preencha todos os campos corretamente para salvar"}
          >
            <Save size={14} /> Salvar
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium uppercase tracking-wider text-slate-400 mb-1.5">{label}</span>
      {children}
    </label>
  );
}

function NumInput({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <input
      type="text"
      inputMode="numeric"
      value={value === 0 ? "" : String(value)}
      placeholder="0"
      onChange={e => {
        const cleaned = e.target.value.replace(/[^\d-]/g, "");
        const n = parseInt(cleaned, 10);
        onChange(Number.isFinite(n) ? n : 0);
      }}
      className="ipt"
    />
  );
}

function VocRadio({ voc, selected, onClick }: { voc: Vocation; selected: boolean; onClick: () => void }) {
  const color = VOC_COLORS[voc];
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative flex flex-col items-center justify-center px-2 py-3 rounded-xl border-2 transition-all ${
        selected ? "bg-white/5 shadow-lg" : "bg-white/[0.02] border-white/10 hover:bg-white/5"
      }`}
      style={selected ? { borderColor: color, boxShadow: `0 0 0 3px ${color}33` } : undefined}
      title={VOC_LABEL[voc]}
    >
      <span className="text-lg font-bold tracking-wider" style={{ color }}>{voc}</span>
      <span className="text-[10px] text-slate-400 mt-0.5">{VOC_LABEL[voc]}</span>
    </button>
  );
}