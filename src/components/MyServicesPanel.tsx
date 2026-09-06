import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Briefcase, Plus, Pencil, Trash2, Crown, Shield, Star, Zap,
  MessageCircle, ChevronRight, CheckCircle2, Clock, History as HistoryIcon, Check, X, ThumbsUp, ThumbsDown,
  ArrowUp, ArrowDown, ArrowUpDown, RotateCcw, ExternalLink,
} from "lucide-react";
import type { ProbableMarkersMap, ServiceRequest, SharedService, Vocation } from "../types";
import { VOC_COLORS, formatRC, resolveServiceValue, SERVICE_PAYMENT_LABELS } from "../types";
import { useAuth } from "../context/AuthContext";
import { isVipActive } from "../utils/vipAccess";
import { SERVER_OPTIONS, isSameServer, serverLabel } from "../constants/servers";
import { FilterSelect, FilterMulti, FilterNumber, FilterDateMax } from "./FilterTypes";
import { loadUIState, saveUIState } from "../storage";
import { openExternalUrl } from "../utils/openExternal";
import { rubinotCharacterUrl } from "../utils/rubinotLinks";
import VipAccessButton from "./VipAccessButton";
import MyServiceModal, { type MyServiceSavePayload } from "./MyServiceModal";
import ServiceValueModal from "./ServiceValueModal";
import ConfirmModal from "./ConfirmModal";
import ServiceFormLinkButton from "./ServiceFormLinkButton";
import WhatsappMessagePicker from "./WhatsappMessagePicker";
import WhatsappTemplateModal from "./WhatsappTemplateModal";
import FirstMessageMarker from "./FirstMessageMarker";
import {
  DEFAULT_WHATSAPP_TEMPLATES,
  cleanWhatsappPhone,
  loadWhatsappTemplates,
  saveWhatsappTemplates,
  serviceToWhatsappContext,
  type WhatsappTemplate,
} from "../services/whatsappTemplatesService";
import {
  applyServiceStatus,
  approveServiceRequest,
  subscribeServiceRequests,
  rejectServiceRequest,
  createServiceId,
  fetchSharedServices,
  persistSharedServices,
  isServiceProbablyDone,
  readServiceRequestsCache,
  readSharedServicesCache,
  saveSharedServicesCache,
  requestToSharedService,
  saveServiceRequestsCache,
  toIsoDate,
} from "../services/sharedServicesService";

// ============================================================================
// MEUS SERVICES — etapa 1 da reestruturação
//
// Área exclusiva do Serviceiro (VIP ativo + `serviceiro === true`) para
// cadastrar os próprios Services numa coleção permanente (`sharedServices`),
// resolvendo o problema dos personagens "fantasma" que sumiam das PTs ao
// concluir a Quest.
//
// NADA aqui altera o WaitingListPanel, a ServiceList, a inclusão em PTs ou o
// fluxo de conclusão de Quest — esta é apenas a base para a próxima etapa.
// ============================================================================

type ServicesView = "disponiveis" | "realizados";

/** Exibição curta: +55 92 999999999 */
function formatWhatsDisplay(service: SharedService): string {
  const country = (service.whatsappCountry || "").trim();
  const area = (service.whatsappArea || "").trim();
  const number = (service.whatsappNumber || "").trim();
  if (!number) return "";
  return `+${country} ${area} ${number}`.trim();
}

/**
 * Campo de filtro de uma coluna.
 *
 * Declarado no nível do módulo de propósito: se ficasse dentro de
 * MyServicesPanel, cada render criaria um novo tipo de componente, o React
 * remontaria o <input> e o foco se perderia a cada tecla digitada.
 */
function ColFilter({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="relative w-full">
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full min-w-0 rounded border bg-[var(--th-n-elev)] px-1.5 py-0.5 pr-4 text-[10px] text-slate-200 placeholder-slate-600 focus:outline-none transition-colors ${
          value ? "border-sky-500/50" : "border-white/10 hover:border-white/20 focus:border-sky-500/40"
        }`}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          className="absolute right-0.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-rose-300 transition-colors cursor-pointer"
          title="Limpar filtro"
        >
          <X size={9} />
        </button>
      )}
    </div>
  );
}

/** `YYYY-MM-DD` -> `DD/MM/AA`, sem depender de fuso. */
function formatServiceDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec((value || "").trim());
  if (!match) return "";
  return `${match[3]}/${match[2]}/${match[1].slice(2)}`;
}

/**
 * Largura de cada uma das 16 colunas, na ordem em que aparecem no <colgroup>.
 *
 * Os valores NÃO são estéticos: cada um é a largura mínima em que o filtro
 * daquela coluna ainda se desenha por inteiro (rótulo + chevron/ícone + botão
 * de limpar + paddings), medida a partir das classes reais de `FilterTypes`
 * (`px-2 py-1 text-[11px]`) e do `ColFilter` local (`px-1.5 pr-4 text-[10px]`).
 *
 * `null` = coluna elástica: em `table-fixed` as colunas sem largura declarada
 * repartem a folga quando a janela é mais larga que `TABLE_MIN_WIDTH`, fazendo
 * a tabela preencher 100% da área — mesmo princípio da coluna "Notas" no
 * CharTable, só que distribuído entre as 5 colunas de texto livre.
 */
const COL_WIDTHS: (number | null)[] = [
  40,   // #          — botão de reset (h-6 w-full) + px-1 da célula
  48,   // Link       — botão de link para a página oficial do personagem
  null, // Personagem — elástica (ColFilter, piso 106)
  null, // Cliente    — elástica (ColFilter, piso 100)
  176,  // Data       — FilterDateMax: input datetime-local (max-w-[150px])
        //              + px-2 + borda + px-1 da célula. É o filtro mais largo.
  null, // Servidor   — elástica (FilterSelect w-full, piso 96)
  76,   // Voc        — FilterMulti inline ("Voc (5)" + chevron 10 + px-2)
  84,   // Lv         — FilterNumber inline ("≥ 1000" + chevron 10 + px-2)
  86,   // Quest      — FilterSelect ("sanguine")
  96,   // Pgto       — FilterSelect ("combinado", o rótulo mais longo)
  90,   // Valor      — FilterNumber ("≥ 100000")
  null, // WhatsApp   — elástica (piso 116: "+55 99 999999999")
  null, // Anotações  — elástica (piso 120)
  88,   // Status     — botão "Concluir" / selo "Realizado"
  56,   // 🔗         — Compartilhando (botão 6x6 + FilterToggle), como no CharTable
  62,   // Ações      — dois botões de ícone (p-1) + gap
];

/**
 * Piso de cada coluna elástica, na mesma ordem em que aparecem acima.
 *
 * As elásticas são as 5 colunas de texto livre. Em `table-fixed`, colunas sem
 * largura declarada dividem IGUALMENTE o espaço que sobra — então a folga de
 * uma janela larga se espalha entre elas em vez de inflar só "Anotações".
 * A soma destes pisos entra no `minWidth` da tabela: abaixo disso o contêiner
 * rola horizontalmente e nenhum filtro é espremido.
 */
const ELASTIC_MIN_WIDTHS = [106, 100, 96, 116, 120];

/**
 * Como as elásticas recebem partes IGUAIS, reservar apenas a soma dos pisos
 * deixaria a mais exigente abaixo do próprio piso. Por isso reservamos
 * `maior piso × quantidade` — assim, no ponto mínimo, todas as cinco recebem
 * pelo menos 120px e nenhum filtro é cortado.
 */
const TABLE_MIN_WIDTH =
  COL_WIDTHS.reduce<number>((sum, width) => sum + (width ?? 0), 0) +
  Math.max(...ELASTIC_MIN_WIDTHS) * ELASTIC_MIN_WIDTHS.length;

export default function MyServicesPanel({
  onCountChange,
  onServicesChanged,
  probableMarkers = {},
}: {
  onCountChange?: (total: number) => void;
  /** Atualiza a projeção local do App após persistir sharedServices com sucesso. */
  onServicesChanged?: (services: SharedService[]) => void;
  /**
   * Marcadores de "provavelmente já realizado", vindos do App — a MESMA fonte
   * que "Meus Personagens" consome. Passar por prop (em vez de reler o
   * localStorage aqui) mantém uma única fonte da verdade e faz a coluna
   * Compartilhando reagir na hora em que a Quest é concluída.
   */
  probableMarkers?: ProbableMarkersMap;
} = {}) {
  const { currentUser, userProfile, allUsers } = useAuth();

  // ── Controle de acesso: VIP ATIVO **e** serviceiro === true ─────────────
  // Exceção: o Boss é administrador da plataforma e não possui dias de VIP
  // nem a flag `serviceiro`, então recebe acesso direto.
  const isBoss = userProfile?.role === "Boss";
  const hasActiveVip = isVipActive(userProfile);
  const isServiceiro = userProfile?.serviceiro === true;
  const hasAccess = isBoss || (hasActiveVip && isServiceiro);

  const bosses = useMemo(
    () => (allUsers || []).filter(user => user.role === "Boss" && user.status === "aprovado"),
    [allUsers],
  );

  const [view, setView] = useState<ServicesView>("disponiveis");
  const [services, setServices] = useState<SharedService[]>(() => readSharedServicesCache(currentUser?.uid || ""));
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editing, setEditing] = useState<SharedService | null>(null);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  // Service aguardando o valor para poder ser concluído (PIX / 50/50).
  const [pendingValueService, setPendingValueService] = useState<SharedService | null>(null);
  // Service aguardando CONFIRMAÇÃO de exclusão. `null` = modal fechado.
  // Guardar o registro inteiro (e não só o id) permite exibir o nome do
  // personagem no modal sem procurá-lo de novo na lista.
  const [pendingDelete, setPendingDelete] = useState<SharedService | null>(null);
  // Solicitações do formulário público dirigidas a este Serviceiro.
  const [requests, setRequests] = useState<ServiceRequest[]>(() => readServiceRequestsCache(currentUser?.uid || ""));
  const [decidingId, setDecidingId] = useState<string>("");

  // UID em ref: o flush roda no cleanup/`beforeunload`, fora do ciclo de
  // render, e precisa do valor ATUAL — não do capturado no closure.
  const currentUserUidRef = useRef<string>(currentUser?.uid || "");
  useEffect(() => {
    currentUserUidRef.current = currentUser?.uid || "";
  }, [currentUser?.uid]);

  // Lista atual em ref. `handleApprove` faz `await flushServicesWrite()` antes
  // de seguir, e depois de um await a variável `services` do closure pode
  // estar defasada — a ref sempre tem o valor mais recente.
  const servicesRef = useRef<SharedService[]>(services);
  useEffect(() => { servicesRef.current = services; }, [services]);

  // O flush é assíncrono e não deve usar uma prop capturada em render antigo.
  const onServicesChangedRef = useRef(onServicesChanged);
  useEffect(() => { onServicesChangedRef.current = onServicesChanged; }, [onServicesChanged]);

  /**
   * Preferência "Aprovar automaticamente", INDIVIDUAL por Serviceiro.
   *
   * A chave inclui o UID, então dois usuários na mesma máquina não
   * compartilham a configuração. Persiste entre sessões via localStorage,
   * usando os helpers já padronizados do projeto.
   */
  const autoApproveKey = `my_services_auto_approve.${currentUser?.uid || "anon"}`;
  const [autoApprove, setAutoApprove] = useState<boolean>(() => loadUIState(autoApproveKey, false));
  useEffect(() => {
    saveUIState(autoApproveKey, autoApprove);
  }, [autoApproveKey, autoApprove]);

  // ── Mensagens padrão do WhatsApp ──────────────────────────────────────────
  // Preferência individual do usuário, persistida por UID no localStorage
  // (mesmo padrão do "Auto-aprovar" e das notificações) — sem custo no
  // Firestore. `waTarget` é o Service cujo cliente será contactado.
  const [waTemplates, setWaTemplates] = useState<WhatsappTemplate[]>(DEFAULT_WHATSAPP_TEMPLATES);
  const [waTemplatesOpen, setWaTemplatesOpen] = useState(false);
  const [waTarget, setWaTarget] = useState<SharedService | null>(null);
  useEffect(() => {
    setWaTemplates(loadWhatsappTemplates(currentUser?.uid || ""));
  }, [currentUser?.uid]);
  function handleWaTemplatesSave(next: WhatsappTemplate[]) {
    setWaTemplates(next);
    saveWhatsappTemplates(currentUser?.uid || "", next);
  }
  const waContext = useMemo(
    () => serviceToWhatsappContext(waTarget, userProfile?.nome || "", userProfile?.twitchChannel || ""),
    [waTarget, userProfile?.nome, userProfile?.twitchChannel],
  );

  /**
   * GATILHO OFICIAL da primeira mensagem ao cliente: a confirmação de
   * "Abrir conversa" no modal "Enviar WhatsApp" (WhatsappMessagePicker →
   * `onOpenLink`). Abre o link normalmente e, se este Service ainda não tem
   * `firstMessageSentAt`, registra o momento — persistido pelo mesmo fluxo
   * otimista (`commit` → cache local → Firestore) das demais edições, com
   * flush imediato por ser uma ação explícita do usuário. Abertura do modal,
   * seleção de mensagem ou o botão de WhatsApp da linha NÃO marcam nada.
   */
  function handleWaOpenLink(link: string) {
    openExternalUrl(link);
    if (waTarget && !(waTarget.firstMessageSentAt && waTarget.firstMessageSentAt > 0)) {
      const stampedId = waTarget.id;
      const sentAt = Date.now();
      commit(
        services.map(item => (item.id === stampedId ? { ...item, firstMessageSentAt: sentAt } : item)),
        { flushImmediately: true },
      );
    }
  }
  // Feedback de "copiado" no nome do personagem (mesmo padrão do CharTable).
  const [copiedId, setCopiedId] = useState<string | null>(null);

  async function copyCharacterName(text: string, id: string) {
    if (!text) return;
    try { await navigator.clipboard.writeText(text); } catch { /* fallback silencioso */ }
    setCopiedId(id);
    window.setTimeout(() => setCopiedId(null), 1500);
  }

  // Filtros da tabela
  const [serverFilter, setServerFilter] = useState("");
  const [vocFilter, setVocFilter] = useState<string[]>([]);
  const [questFilter, setQuestFilter] = useState("");
  // Filtros por coluna, exibidos na 2ª linha do cabeçalho da tabela.
  const [personagemFilter, setPersonagemFilter] = useState("");
  const [clienteFilter, setClienteFilter] = useState("");
  const [pgtoFilter, setPgtoFilter] = useState("");
  const [whatsFilter, setWhatsFilter] = useState("");
  const [notesFilter, setNotesFilter] = useState("");
  // Filtros numéricos (≥ / ≤), no mesmo formato do FilterNumber usado em
  // "Meus Personagens".
  const [levelNum, setLevelNum] = useState<{ value: number | null; op: "gte" | "lte" }>({ value: null, op: "gte" });
  const [valorNum, setValorNum] = useState<{ value: number | null; op: "gte" | "lte" }>({ value: null, op: "gte" });
  // Data máxima (o registro precisa ser anterior ou igual).
  const [dataMax, setDataMax] = useState("");

  /**
   * Ordenação multi-coluna, mesma mecânica do CharTable: 1º clique asc,
   * 2º desc, 3º remove. A pilha guarda até 2 critérios, e o badge numérico
   * indica a prioridade quando há mais de um.
   */
  type SortEntry = { key: string; dir: "asc" | "desc" };
  const [sortStack, setSortStack] = useState<SortEntry[]>([]);

  function getSortEntry(key: string) { return sortStack.find(e => e.key === key); }
  function getSortPriority(key: string) {
    const idx = sortStack.findIndex(e => e.key === key);
    return idx === -1 ? -1 : sortStack.length - idx;
  }
  function toggleSort(key: string) {
    setSortStack(prev => {
      const existing = prev.find(e => e.key === key);
      if (!existing) {
        const base = prev.length >= 2 ? prev.slice(1) : prev;
        return [...base, { key, dir: "asc" }];
      }
      if (existing.dir === "asc") {
        return prev.map(e => (e.key === key ? { ...e, dir: "desc" as const } : e));
      }
      return prev.filter(e => e.key !== key);
    });
  }

  // Guarda de sessão: UMA leitura do Firestore por usuário, como em
  // "Meus Personagens". Trocar de aba ou de visão não relê nada.
  const loadedForUidRef = useRef<string>("");

  /**
   * Carrega Services e solicitações pendentes.
   *
   * CORREÇÃO DO "Carregando" ETERNO: antes o `finally` só chamava
   * `setIsLoading(false)` quando `isCancelled()` era falso. Quando uma
   * dependência do efeito mudava no meio da requisição (o `userProfile.nome`
   * chega do Firestore depois do primeiro render), o cleanup marcava
   * `cancelled = true`, a re-execução era barrada pela guarda de sessão e
   * NINGUÉM desligava o loading — o botão ficava preso.
   *
   * Agora `setIsLoading(false)` roda SEMPRE; o `isCancelled` protege apenas
   * a escrita dos dados, evitando resultado obsoleto.
   */
  async function loadServices(isCancelled: () => boolean = () => false) {
    const uid = currentUser?.uid || "";
    if (!uid) return;
    setIsLoading(true);
    setError("");
    try {
      const result = await fetchSharedServices(uid, userProfile?.nome || "");
      if (!isCancelled()) {
        setServices(result.services);
        if (result.error) setError(`Não foi possível carregar tudo: ${result.error}`);
      }
    } catch (err: any) {
      if (!isCancelled()) setError(err?.message || "Falha ao carregar seus Services.");
    } finally {
      // SEMPRE desliga — mesmo cancelado — para o botão nunca travar.
      setIsLoading(false);
    }
  }

  // Carga dos SERVICES (leitura pontual + cache; sem listener).
  useEffect(() => {
    const uid = currentUser?.uid || "";
    if (!uid || !hasAccess) return;
    if (loadedForUidRef.current === uid) return;
    loadedForUidRef.current = uid;

    // Cache já hidratou a tela: não gasta leitura na primeira abertura.
    if (readSharedServicesCache(uid).length > 0) return;

    let cancelled = false;
    loadServices(() => cancelled);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser?.uid, hasAccess]);

  /**
   * LISTENER EM TEMPO REAL das solicitações pendentes.
   *
   * Uma única inscrição por usuário. As dependências são apenas `uid` e
   * `hasAccess`, então trocar de seção (Disponíveis/Realizados), filtrar ou
   * abrir modais NÃO recria o listener — evitando inscrições duplicadas e
   * leituras extras. O retorno cancela a inscrição ao desmontar.
   */
  useEffect(() => {
    const uid = currentUser?.uid || "";
    if (!uid || !hasAccess) return;

    const unsubscribe = subscribeServiceRequests(
      uid,
      incoming => setRequests(incoming),
      message => setError(message),
    );
    return () => unsubscribe();
  }, [currentUser?.uid, hasAccess]);

  // ── GRAVAÇÃO COM DEBOUNCE DE 5 SEGUNDOS ────────────────────────────────
  // Mesmo padrão de "Meus Personagens" (App.tsx, `userCharacters/{uid}`):
  // a interface muda na hora. Alterações manuais explícitas são persistidas
  // imediatamente porque outros usuários dependem dos campos compartilhados;
  // operações internas em lote continuam podendo usar o debounce de 5s.
  //
  // A serialização abaixo impede que uma escrita completa mais antiga chegue
  // depois e sobrescreva a última versão salva.
  //
  // `pendingWriteRef` guarda a versão mais recente e o estado de rollback
  // ORIGINAL (o anterior à primeira alteração da rajada) — sem isso, um erro
  // no fim da rajada reverteria apenas o último passo.
  const SERVICES_WRITE_DEBOUNCE_MS = 5000;
  const writeTimerRef = useRef<number | null>(null);
  const pendingWriteRef = useRef<{ latest: SharedService[]; rollback: SharedService[] } | null>(null);
  // Serializa writes completos do mesmo documento para uma versão antiga nunca
  // chegar depois e sobrescrever uma edição manual mais nova.
  const servicesWriteInFlightRef = useRef(false);

  /**
   * Envia ao Firestore o que estiver pendente. Chamado pelo timer, ao trocar
   * de aba (desmontagem) e antes de fechar a janela.
   */
  const flushServicesWrite = useCallback(async () => {
    if (writeTimerRef.current !== null) {
      window.clearTimeout(writeTimerRef.current);
      writeTimerRef.current = null;
    }
    // Uma edição pode acontecer enquanto o write anterior aguarda o servidor.
    // Mantemos o último payload pendente e o enviamos somente depois do atual.
    if (servicesWriteInFlightRef.current) return;
    const pending = pendingWriteRef.current;
    if (!pending) return;
    pendingWriteRef.current = null;
    servicesWriteInFlightRef.current = true;

    try {
      const uid = currentUserUidRef.current;
      const result = await persistSharedServices(uid, pending.latest);
      if (!result.ok) {
        // Se já há uma versão mais nova aguardando, ela continua sendo a fonte
        // desejada e terá sua própria tentativa. Sem versão nova, rollback.
        if (!pendingWriteRef.current) setServices(pending.rollback);
        setError(result.error || "Não foi possível salvar o Service.");
        return;
      }
      // O documento compartilhado foi confirmado: atualiza a projeção usada pela
      // própria PartyPanel sem gastar uma leitura adicional no Firestore.
      onServicesChangedRef.current?.(pending.latest);
    } finally {
      servicesWriteInFlightRef.current = false;
      // Drena apenas a versão mais recente acumulada durante o write anterior.
      if (pendingWriteRef.current) void flushServicesWrite();
    }
  }, []);

  /**
   * Atualização OTIMISTA + agendamento da escrita.
   *
   * O cache local é gravado na hora (`saveSharedServicesCache`), então sair e
   * voltar à aba mostra o estado novo mesmo antes de o Firestore receber.
   */
  function commit(next: SharedService[], options: { flushImmediately?: boolean } = {}) {
    const previous = services;
    setServices(next);
    setError("");

    // Cache imediato: é ele que sustenta a navegação entre abas.
    saveSharedServicesCache(currentUser?.uid || "", next);

    // Acumula: o rollback é sempre o estado ANTERIOR À RAJADA.
    pendingWriteRef.current = {
      latest: next,
      rollback: pendingWriteRef.current?.rollback ?? previous,
    };

    if (writeTimerRef.current !== null) window.clearTimeout(writeTimerRef.current);
    if (options.flushImmediately) {
      // Edição manual é uma ação explícita: persiste já para que outro usuário
      // que atualizar/acessar a PT use o servidor, vocação e demais campos novos.
      void flushServicesWrite();
      return;
    }
    writeTimerRef.current = window.setTimeout(() => {
      writeTimerRef.current = null;
      void flushServicesWrite();
    }, SERVICES_WRITE_DEBOUNCE_MS);
  }

  // Não perder alterações pendentes ao sair da aba ou fechar o app.
  useEffect(() => {
    function handleBeforeUnload() { void flushServicesWrite(); }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      // Desmontagem (troca de aba) também descarrega o que estiver pendente.
      void flushServicesWrite();
    };
  }, [flushServicesWrite]);

  function handleSave(form: MyServiceSavePayload) {
    const uid = currentUser?.uid || "";
    const now = Date.now();

    if (editing) {
      // VALOR: automático para 1K RC e Valor Combinado; para PIX/50/50
      // preserva o que já existir (informado numa conclusão anterior).
      const resolved = resolveServiceValue(form.paymentMethod, form.valorCombinado);
      const merged: SharedService = {
        ...editing,
        personagem: form.personagem,
        ownerName: form.ownerName,
        servidor: form.servidor,
        voc: form.voc,
        level: form.level,
        valorCombinado: resolved > 0 ? resolved : editing.valorCombinado,
        notes: form.notes,
        whatsappCountry: form.whatsappCountry,
        whatsappArea: form.whatsappArea,
        whatsappNumber: form.whatsappNumber,
        quest: form.quest,
        paymentMethod: form.paymentMethod,
        dataService: form.dataService,
      };

      // Concluir sem valor exige informá-lo antes.
      if (form.realizado && merged.valorCombinado <= 0) {
        setIsModalOpen(false);
        setEditing(null);
        setPendingValueService(merged);
        return;
      }

      const updated = applyServiceStatus(merged, form.realizado, merged.valorCombinado);
      commit(services.map(item => (item.id === updated.id ? updated : item)), { flushImmediately: true });
    } else {
      const resolved = resolveServiceValue(form.paymentMethod, form.valorCombinado);
      const draft: SharedService = {
        id: createServiceId(),
        personagem: form.personagem,
        ownerName: form.ownerName,
        servidor: form.servidor,
        voc: form.voc,
        level: form.level,
        valorCombinado: resolved,
        notes: form.notes,
        whatsappCountry: form.whatsappCountry,
        whatsappArea: form.whatsappArea,
        whatsappNumber: form.whatsappNumber,
        quest: form.quest,
        paymentMethod: form.paymentMethod,
        dataService: form.dataService,
        // Vínculo automático com o usuário autenticado.
        serviceiroUid: uid,
        serviceiroNome: userProfile?.nome || "",
        status: "disponivel",
        lucroService: 0,
        createdAt: now,
        updatedAt: now,
      };

      if (form.realizado && draft.valorCombinado <= 0) {
        setIsModalOpen(false);
        setEditing(null);
        setPendingValueService(draft);
        return;
      }

      const created = applyServiceStatus(draft, form.realizado, draft.valorCombinado);
      commit([created, ...services], { flushImmediately: true });
    }

    setIsModalOpen(false);
    setEditing(null);
  }

  /**
   * Clique na lixeira: apenas ABRE a confirmação. Nada é excluído aqui.
   * A remoção acontece só em `confirmDelete`, após o usuário confirmar.
   */
  function handleDelete(service: SharedService) {
    setPendingDelete(service);
  }

  /**
   * Confirmação do modal: executa a exclusão de fato.
   *
   * A lógica é EXATAMENTE a de antes (`commit` com o item filtrado) — só o
   * meio de confirmar mudou, de `window.confirm` para o modal do app.
   */
  function confirmDelete() {
    const target = pendingDelete;
    if (!target) return;
    setPendingDelete(null);
    commit(services.filter(item => item.id !== target.id), { flushImmediately: true });
  }

  /**
   * Conclui a partir da coluna Status.
   * Sem VALOR preenchido, pede o valor antes — cancelar não altera nada.
   */
  function toggleRealizado(service: SharedService) {
    if (service.status !== "realizado" && service.valorCombinado <= 0) {
      setPendingValueService(service);
      return;
    }
    const next = applyServiceStatus(service, service.status !== "realizado", service.valorCombinado);
    commit(services.map(item => (item.id === next.id ? next : item)), { flushImmediately: true });
  }

  /** Confirmação do modal de valor: grava o valor e conclui. */
  function confirmPendingValue(valor: number) {
    const target = pendingValueService;
    if (!target) return;
    const withValue: SharedService = { ...target, valorCombinado: valor };
    const concluded = applyServiceStatus(withValue, true, valor);
    const exists = services.some(item => item.id === concluded.id);
    commit(exists
      ? services.map(item => (item.id === concluded.id ? concluded : item))
      : [concluded, ...services], { flushImmediately: true });
    setPendingValueService(null);
  }

  /**
   * Aprova: cria o Service e apaga a solicitação.
   *
   * ATUALIZAÇÃO OTIMISTA — o pendente sai da tabela e o Service entra em
   * Disponíveis na hora. Se a gravação falhar, o estado anterior é
   * restaurado por completo e o erro é exibido.
   */
  async function handleApprove(request: ServiceRequest) {
    if (decidingId) return;

    // Descarrega qualquer escrita pendente ANTES de aprovar. `approveServiceRequest`
    // grava o documento por conta própria; se um debounce antigo disparasse
    // depois, ele reescreveria a lista SEM o Service recém-criado e a
    // aprovação se perderia. Com o flush aqui, não há escrita em voo.
    await flushServicesWrite();

    const uid = currentUser?.uid || "";
    const prevServices = servicesRef.current;
    const prevRequests = requests;

    setDecidingId(request.id);
    setError("");

    // Otimista: remove o pendente e insere o Service já aprovado.
    const optimistic = requestToSharedService(request, userProfile?.nome || "");
    const nextRequests = requests.filter(item => item.id !== request.id);
    setServices(prev => (prev.some(i => i.id === optimistic.id) ? prev : [optimistic, ...prev]));
    setRequests(nextRequests);

    try {
      const result = await approveServiceRequest({
        request,
        viewerUid: uid,
        serviceiroNome: userProfile?.nome || "",
        current: prevServices,
      });
      if (!result.ok) {
        // Rollback completo.
        setServices(prevServices);
        setRequests(prevRequests);
        setError(result.error || "Não foi possível aprovar a solicitação.");
        return;
      }
      if (result.services) {
        setServices(result.services);
        onServicesChangedRef.current?.(result.services);
      }
      saveServiceRequestsCache(uid, nextRequests);
    } catch (err: any) {
      setServices(prevServices);
      setRequests(prevRequests);
      setError(err?.message || "Falha ao aprovar a solicitação.");
    } finally {
      setDecidingId("");
    }
  }

  /**
   * Recusa: apaga a solicitação. Nada é criado em `sharedServices` e não se
   * guarda histórico de recusados nesta etapa.
   */
  async function handleReject(request: ServiceRequest) {
    if (decidingId) return;
    const uid = currentUser?.uid || "";
    const prevRequests = requests;

    setDecidingId(request.id);
    setError("");

    const nextRequests = requests.filter(item => item.id !== request.id);
    setRequests(nextRequests);

    try {
      const result = await rejectServiceRequest({ request, viewerUid: uid });
      if (!result.ok) {
        setRequests(prevRequests);
        setError(result.error || "Não foi possível recusar a solicitação.");
        return;
      }
      saveServiceRequestsCache(uid, nextRequests);
    } catch (err: any) {
      setRequests(prevRequests);
      setError(err?.message || "Falha ao recusar a solicitação.");
    } finally {
      setDecidingId("");
    }
  }

  /**
   * APROVAÇÃO AUTOMÁTICA.
   *
   * Quando ligada, cada solicitação pendente que chega pelo listener é
   * aprovada em sequência (não em paralelo) — assim cada uma enxerga o array
   * já atualizado pela anterior, e a guarda por id funciona.
   *
   * `autoApprovingRef` impede reentrância: enquanto um lote é processado, uma
   * nova emissão do listener não dispara outro. `handledRef` registra os ids
   * já tratados, evitando reprocessar o mesmo pedido caso ele reapareça antes
   * de o Firestore confirmar a exclusão.
   */
  const autoApprovingRef = useRef(false);
  const autoHandledRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!autoApprove || !hasAccess) return;
    const uid = currentUser?.uid || "";
    if (!uid) return;
    if (autoApprovingRef.current) return;

    const queue = requests.filter(r => r.status === "pendente" && !autoHandledRef.current.has(r.id));
    if (queue.length === 0) return;

    autoApprovingRef.current = true;
    let cancelled = false;

    (async () => {
      // `current` acompanha o array a cada aprovação, garantindo que a
      // verificação de duplicidade use sempre o estado mais recente.
      let current = services;
      for (const request of queue) {
        if (cancelled) break;
        autoHandledRef.current.add(request.id);
        const result = await approveServiceRequest({
          request,
          viewerUid: uid,
          serviceiroNome: userProfile?.nome || "",
          current,
        });
        if (result.ok && result.services) {
          current = result.services;
          if (!cancelled) {
            setServices(current);
            onServicesChangedRef.current?.(current);
          }
        } else if (result.error) {
          // Libera para nova tentativa e informa o usuário.
          autoHandledRef.current.delete(request.id);
          if (!cancelled) setError(result.error);
        }
      }
      autoApprovingRef.current = false;
    })().catch(() => { autoApprovingRef.current = false; });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoApprove, requests, hasAccess, currentUser?.uid]);

  const disponiveis = useMemo(() => services.filter(s => s.status === "disponivel"), [services]);
  const realizados = useMemo(() => services.filter(s => s.status === "realizado"), [services]);
  // Só as pendentes contam no badge — decididas ficam no histórico da aba.
  const pendentes = useMemo(() => requests.filter(r => r.status === "pendente"), [requests]);

  /**
   * Linha da tabela: uma solicitação pendente OU um Service já aprovado.
   *
   * Unificar os dois num só modelo evita duplicar a tabela — os pendentes
   * aparecem no TOPO de "Disponíveis", com selo próprio, em vez de numa
   * seção separada.
   */
  type ServiceRow =
    | { kind: "pending"; id: string; request: ServiceRequest }
    | { kind: "service"; id: string; service: SharedService };

  // Informa o total ao botão da aba, seguindo a SEÇÃO ATIVA — mesmo
  // comportamento do botão "Meus Personagens", cujo contador alterna entre
  // `ativos` e `vendidos` conforme a visão escolhida.
  //
  // Em "Disponíveis" somamos as solicitações pendentes porque elas ocupam
  // linhas dessa mesma seção. Um pedido aprovado vira Service e sai de
  // `pendentes` no mesmo instante, então nada é contado duas vezes.
  const totalCount = view === "realizados"
    ? realizados.length
    : disponiveis.length + pendentes.length;
  useEffect(() => {
    onCountChange?.(totalCount);
  }, [totalCount, onCountChange]);

  const visibleRows = useMemo((): ServiceRow[] => {
    // Busca parcial, sem diferenciar maiúsculas/minúsculas.
    const has = (source: string, needle: string) =>
      !needle.trim() || String(source || "").toLowerCase().includes(needle.trim().toLowerCase());

    // Numérico: ≥ ou ≤, conforme o operador escolhido no FilterNumber.
    const matchNum = (value: number, filter: { value: number | null; op: "gte" | "lte" }) => {
      if (filter.value === null || !Number.isFinite(filter.value)) return true;
      const n = Number(value) || 0;
      return filter.op === "gte" ? n >= filter.value : n <= filter.value;
    };

    // Data máxima: compara as strings ISO (YYYY-MM-DD), que ordenam
    // lexicograficamente — sem depender de fuso.
    const matchDateMax = (isoDate: string, max: string) => {
      if (!max) return true;
      const limit = max.slice(0, 10);
      return String(isoDate || "").slice(0, 10) <= limit;
    };

    const matchesService = (service: SharedService) => {
      if (!has(service.personagem, personagemFilter)) return false;
      if (!has(service.ownerName, clienteFilter)) return false;
      if (!matchDateMax(service.dataService, dataMax)) return false;
      if (serverFilter && !isSameServer(service.servidor, serverFilter)) return false;
      if (vocFilter.length > 0 && !vocFilter.includes(service.voc)) return false;
      if (!matchNum(service.level, levelNum)) return false;
      if (questFilter && service.quest !== questFilter) return false;
      if (pgtoFilter && service.paymentMethod !== pgtoFilter) return false;
      if (!matchNum(service.valorCombinado, valorNum)) return false;
      if (!has(formatWhatsDisplay(service), whatsFilter)) return false;
      if (!has(service.notes, notesFilter)) return false;
      return true;
    };

    // Solicitações usam os mesmos filtros, nos campos equivalentes.
    const matchesRequest = (request: ServiceRequest) => {
      if (!has(request.personagem, personagemFilter)) return false;
      if (!has(request.ownerName, clienteFilter)) return false;
      if (!matchDateMax(toIsoDate(request.createdAt), dataMax)) return false;
      if (serverFilter && !isSameServer(request.servidor, serverFilter)) return false;
      if (vocFilter.length > 0 && !vocFilter.includes(request.voc)) return false;
      if (!matchNum(request.level, levelNum)) return false;
      if (questFilter && request.quest !== questFilter) return false;
      if (pgtoFilter && request.paymentMethod !== pgtoFilter) return false;
      if (!has(request.notes, notesFilter)) return false;
      return true;
    };

    const base = view === "disponiveis" ? disponiveis : realizados;
    /** Valor comparável de cada coluna, para a ordenação. */
    const sortValue = (service: SharedService, key: string): string | number => {
      switch (key) {
        case "personagem": return service.personagem;
        case "cliente": return service.ownerName;
        case "data": return service.dataService || "";
        case "servidor": return service.servidor;
        case "voc": return service.voc;
        case "level": return service.level || 0;
        case "quest": return service.quest;
        case "pgto": return service.paymentMethod || "";
        case "valor": return service.valorCombinado || 0;
        case "whatsapp": return formatWhatsDisplay(service);
        case "notes": return service.notes;
        case "status": return service.status;
        // Compartilhando: 0 = em circulação, 1 = provavelmente realizado,
        // 2 = realizado. Ordena do mais disponível para o menos disponível.
        case "shared": {
          if (service.status === "realizado") return 2;
          return isServiceProbablyDone(service, probableMarkers) ? 1 : 0;
        }
        default: return "";
      }
    };

    const applySort = (list: SharedService[]) => {
      // Sem critério escolhido, mantém a ordem padrão (mais recente antes).
      if (sortStack.length === 0) return [...list].sort((a, b) => b.updatedAt - a.updatedAt);
      return [...list].sort((a, b) => {
        // Percorre de trás para frente: o último clique tem prioridade.
        for (let i = sortStack.length - 1; i >= 0; i--) {
          const { key, dir } = sortStack[i];
          const av = sortValue(a, key);
          const bv = sortValue(b, key);
          let cmp = 0;
          if (typeof av === "number" && typeof bv === "number") cmp = av - bv;
          else cmp = String(av).localeCompare(String(bv), "pt-BR", { sensitivity: "base" });
          if (cmp !== 0) return dir === "asc" ? cmp : -cmp;
        }
        return 0;
      });
    };

    const services: ServiceRow[] = applySort(base.filter(matchesService))
      .map(service => ({ kind: "service" as const, id: service.id, service }));

    // Pendentes só no topo de "Disponíveis" — nunca em "Realizados".
    if (view !== "disponiveis") return services;

    const pending: ServiceRow[] = pendentes
      .filter(matchesRequest)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(request => ({ kind: "pending" as const, id: request.id, request }));

    return [...pending, ...services];
  }, [
    view, disponiveis, realizados, pendentes,
    personagemFilter, clienteFilter, serverFilter, vocFilter,
    questFilter, pgtoFilter, whatsFilter, notesFilter,
    levelNum, valorNum, dataMax, sortStack,
    // A ordenação por "Compartilhando" depende dos marcadores.
    probableMarkers,
  ]);

  /** true quando algum filtro de coluna está ativo. */
  const hasActiveFilters =
    !!(personagemFilter || clienteFilter || serverFilter || questFilter || pgtoFilter ||
       whatsFilter || notesFilter || dataMax) ||
    vocFilter.length > 0 || levelNum.value !== null || valorNum.value !== null;

  function clearColumnFilters() {
    setPersonagemFilter(""); setClienteFilter("");
    setServerFilter(""); setVocFilter([]);
    setQuestFilter(""); setPgtoFilter("");
    setWhatsFilter(""); setNotesFilter("");
    setLevelNum({ value: null, op: "gte" });
    setValorNum({ value: null, op: "gte" });
    setDataMax("");
  }

  // Total dos Services realizados. `lucroService` recebe o VALOR confirmado
  // na conclusão — é ele que o painel Stats contabiliza.
  const totalRealizado = useMemo(
    () => realizados.reduce((sum, service) => sum + (service.lucroService || service.valorCombinado || 0), 0),
    [realizados],
  );

  // ── Tela de bloqueio ────────────────────────────────────────────────────
  if (!hasAccess) {
    return (
      <div className="flex flex-col h-full w-full bg-[var(--th-bg-base)]">
        <div className="flex items-center justify-between px-3 py-2 bg-gradient-to-r from-[var(--th-bg-raised)] to-[var(--th-bg-base)] border-b border-[var(--th-line)]/30 flex-shrink-0">
          <div className="flex items-center gap-2">
            <Briefcase size={14} className="text-sky-400" />
            <span className="text-sm font-bold text-sky-300 uppercase tracking-wider">Meus Services</span>
            <VipAccessButton userProfile={userProfile} />
          </div>
        </div>

        <div className="flex-1 min-h-0 flex items-center justify-center overflow-y-auto custom-scrollbar">
          <div className="flex flex-col items-center px-6 py-8 text-center gap-6 max-w-lg">
            <div className="relative">
              <div className="absolute inset-0 rounded-full bg-amber-500/20 blur-xl scale-150" />
              <div className="relative w-20 h-20 rounded-full bg-gradient-to-br from-amber-500/20 to-amber-600/10 border-2 border-amber-500/40 flex items-center justify-center shadow-[0_0_30px_color-mix(in_oklab,var(--color-amber-500)_15%,transparent)]">
                <Crown size={36} className="text-amber-400" />
              </div>
            </div>

            <div className="space-y-3">
              <h3 className="text-xl font-extrabold text-white tracking-tight">
                Área exclusiva de <span className="text-transparent bg-clip-text bg-gradient-to-r from-sky-300 to-sky-500">Serviceiros</span>
              </h3>
              <p className="text-sm text-slate-400 leading-relaxed">
                Para gerenciar seus próprios Services você precisa cumprir os dois requisitos abaixo.
              </p>
            </div>

            {/* Checklist explícito: mostra exatamente o que falta. */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full">
              <div className={`flex flex-col items-center gap-2 rounded-xl px-4 py-4 border ${hasActiveVip ? "bg-emerald-500/[0.06] border-emerald-600/40" : "bg-[var(--th-bg-hover)] border-amber-900/30"}`}>
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center border ${hasActiveVip ? "bg-emerald-500/10 border-emerald-500/30" : "bg-amber-500/10 border-amber-500/25"}`}>
                  {hasActiveVip ? <CheckCircle2 size={18} className="text-emerald-400" /> : <Star size={18} className="text-amber-400" />}
                </div>
                <span className="text-[11px] font-semibold text-slate-300 text-center leading-tight">VIP ativo</span>
                <span className={`text-[10px] font-bold uppercase tracking-wider ${hasActiveVip ? "text-emerald-400" : "text-amber-400"}`}>
                  {hasActiveVip ? "Requisito cumprido" : "Requisito pendente"}
                </span>
              </div>

              <div className={`flex flex-col items-center gap-2 rounded-xl px-4 py-4 border ${isServiceiro ? "bg-emerald-500/[0.06] border-emerald-600/40" : "bg-[var(--th-bg-hover)] border-amber-900/30"}`}>
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center border ${isServiceiro ? "bg-emerald-500/10 border-emerald-500/30" : "bg-amber-500/10 border-amber-500/25"}`}>
                  {isServiceiro ? <CheckCircle2 size={18} className="text-emerald-400" /> : <Shield size={18} className="text-amber-400" />}
                </div>
                <span className="text-[11px] font-semibold text-slate-300 text-center leading-tight">Autorizado como Serviceiro</span>
                <span className={`text-[10px] font-bold uppercase tracking-wider ${isServiceiro ? "text-emerald-400" : "text-amber-400"}`}>
                  {isServiceiro ? "Requisito cumprido" : "Requisito pendente"}
                </span>
              </div>
            </div>

            {!isServiceiro && (
              <div className="flex items-center gap-2 rounded-xl border border-sky-700/30 bg-sky-500/[0.06] px-4 py-3 text-xs text-slate-300">
                <Zap size={14} className="text-sky-400 flex-shrink-0" />
                <span>A autorização de <strong className="text-sky-300">Serviceiro</strong> é concedida por um administrador do Chernobyl PT.</span>
              </div>
            )}

            <p className="text-xs text-slate-500">Fale com um administrador para liberar seu acesso:</p>

            <div className="flex flex-col gap-2 w-full">
              {bosses.length === 0 ? (
                <div className="text-xs text-slate-500 italic py-4">Nenhum administrador encontrado.</div>
              ) : (
                bosses.map(boss => {
                  const phone = ((boss.whatsappCountry || "") + (boss.whatsappRegion || "") + (boss.whatsappNumber || "")).replace(/\D/g, "");
                  const hasPhone = phone.length > 0;
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
                        <a href={`https://wa.me/${phone}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-gradient-to-r from-emerald-600/20 to-emerald-500/15 hover:from-emerald-500/30 hover:to-emerald-400/20 border border-emerald-500/40 text-emerald-300 hover:text-emerald-200 text-[11px] font-bold transition-all flex-shrink-0">
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

  // ── Área autorizada ─────────────────────────────────────────────────────
  const thCls = "bg-[var(--th-bg-overlay)] px-1 py-1.5 border-b border-[var(--th-line)]/100 text-xs font-semibold uppercase tracking-wider text-slate-400 whitespace-nowrap select-none text-center";
  // Célula da 2ª linha do cabeçalho, onde ficam os filtros de cada coluna.
  // `text-center` centraliza os filtros que são inline-flex de largura
  // intrínseca (FilterMulti, FilterNumber, FilterDateMax); os que já são
  // `w-full` (ColFilter, FilterSelect) não são afetados.
  const thFilterCls = "bg-[var(--th-bg-overlay)]/70 px-1 py-1 border-b border-[var(--th-line)]/100 align-middle text-center";
  // Borda vertical que separa a coluna numérica do resto da tabela — mesmo
  // recurso usado na coluna "#" da tabela "Meus Personagens" (CharTable).
  // Aplicada nas três linhas (título, filtro e corpo) para formar um traço
  // contínuo de cima a baixo.
  const numColBorder = "border-r border-[var(--th-line)]/100";

  /**
   * Título de coluna ordenável — mesmo comportamento visual do CharTable:
   * seta cinza quando inativo, verde asc/desc quando ativo, e badge de
   * prioridade quando há mais de um critério na pilha.
   *
   * A largura não é mais declarada aqui: quem manda é o <colgroup>, que usa
   * COL_WIDTHS. Todos os títulos ficam centralizados, alinhados ao conteúdo
   * das células.
   */
  function SortTh({ colKey, label }: { colKey: string; label: string }) {
    const entry = getSortEntry(colKey);
    const priority = getSortPriority(colKey);
    return (
      <th
        className={`${thCls} cursor-pointer hover:bg-[var(--th-bg-hover)] transition-colors`}
        onClick={() => toggleSort(colKey)}
        title={`Ordenar por ${label}`}
      >
        <span className="inline-flex items-center justify-center gap-1 max-w-full">
          <span className="truncate">{label}</span>
          {!entry ? (
            <ArrowUpDown size={9} className="opacity-30 flex-shrink-0" />
          ) : (
            <span className="inline-flex items-center gap-0.5 flex-shrink-0">
              {entry.dir === "asc"
                ? <ArrowUp size={9} className="text-emerald-400" />
                : <ArrowDown size={9} className="text-emerald-400" />}
              {sortStack.length > 1 && (
                <span className="text-[8px] font-bold text-emerald-400/70 tabular-nums leading-none">{priority}</span>
              )}
            </span>
          )}
        </span>
      </th>
    );
  }


  /**
   * Botão "Adicionar Service" — MESMO estilo, ícone e handler em todos os
   * lugares: cabeçalho da tabela (ícone compacto) e estado vazio da guia
   * (com rótulo, para ficar evidente). A adição manual produz um
   * SharedService idêntico ao de uma solicitação aprovada do Formulário
   * Público (requestToSharedService) — mesmos campos, mesmo destino
   * (sharedServices/{uid}), nenhuma segunda implementação.
   */
  function AddServiceButton({ labeled = false }: { labeled?: boolean }) {
    return (
      <button
        type="button"
        onClick={() => { setEditing(null); setIsModalOpen(true); }}
        className={`group/add relative inline-flex items-center justify-center rounded-lg bg-gradient-to-br from-sky-500 to-sky-600 text-white shadow-lg shadow-sky-500/30 border border-sky-400/40 hover:from-sky-400 hover:to-sky-500 hover:shadow-xl hover:shadow-sky-500/40 hover:scale-110 active:scale-95 transition-all duration-200 ease-out cursor-pointer ${
          labeled
            ? "h-8 px-3 gap-1.5 text-[11px] font-bold hover:scale-105"
            : "w-7 h-7"
        }`}
        title="Adicionar Service"
      >
        <span className="absolute inset-0 rounded-lg bg-sky-400/20 animate-ping opacity-40 pointer-events-none" style={{ animationDuration: "2.5s" }} />
        <Plus size={labeled ? 13 : 15} strokeWidth={2.5} className="relative z-10 drop-shadow-sm" />
        {labeled && <span className="relative z-10">Adicionar Service</span>}
      </button>
    );
  }

  return (
    <div className="flex flex-col h-full w-full bg-[var(--th-bg-base)]">
      {/* Barra de controles única.
          A antiga linha de título ("Meus Services" + emblema VIP) foi removida:
          a aba já está identificada na navegação principal, então o título era
          redundante e roubava altura útil da tabela.
          À esquerda ficam os controles acionáveis (as visões Disponíveis /
          Realizados e o "Auto-aprovar"); à direita, apenas leitura
          ("Total realizado"). */}
      <div className="flex items-center justify-between gap-2 px-2 py-1.5 flex-shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <button
            type="button"
            onClick={() => setView("disponiveis")}
            aria-pressed={view === "disponiveis"}
            data-active={view === "disponiveis"}
            className="nav-pill nav-pill--action inline-flex items-center gap-1 px-3 py-1 text-[10px] cursor-pointer whitespace-nowrap"
            style={{ ["--pill-accent" as string]: "var(--color-sky-500)" }}
            title="Services ainda não concluídos"
          >
            <Clock size={11} /> DISPONÍVEIS
            <span className="font-bold font-mono">({disponiveis.length + pendentes.length})</span>
          </button>
          <button
            type="button"
            onClick={() => setView("realizados")}
            aria-pressed={view === "realizados"}
            data-active={view === "realizados"}
            className="nav-pill nav-pill--action inline-flex items-center gap-1 px-3 py-1 text-[10px] cursor-pointer whitespace-nowrap"
            style={{ ["--pill-accent" as string]: "var(--color-emerald-500)" }}
            title="Services já concluídos (histórico)"
          >
            <HistoryIcon size={11} /> REALIZADOS
            <span className="font-bold font-mono">({realizados.length})</span>
          </button>

          {/* Separador: "Auto-aprovar" fica junto das seções, mas é um
              controle de outra natureza — não seleciona uma visão. */}
          <span className="w-px h-4 bg-[var(--th-line)]/60 mx-0.5" aria-hidden="true" />

          {/* Aprovação automática — preferência individual do Serviceiro,
              persistida por UID. Substitui o antigo botão "Atualizar": a
              tabela agora sincroniza em tempo real. */}
          <button
            type="button"
            onClick={() => setAutoApprove(v => !v)}
            aria-pressed={autoApprove}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[10px] font-bold transition-colors cursor-pointer whitespace-nowrap ${
              autoApprove
                ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-300"
                : "border-white/10 bg-white/5 text-slate-400 hover:text-white hover:bg-white/10"
            }`}
            title={autoApprove
              ? "Novas solicitações são aprovadas automaticamente"
              : "Aprovar automaticamente as novas solicitações recebidas"}
          >
            <Zap size={12} className={autoApprove ? "text-emerald-300" : "text-slate-500"} />
            Auto-aprovar
            <span className="text-[9px] font-black uppercase tracking-wider opacity-70">
              {autoApprove ? "ON" : "OFF"}
            </span>
          </button>

          {/* Mensagens padrão do WhatsApp — abre o modal de configuração
              (editar título/conteúdo). As mensagens alimentam o seletor que
              aparece ao clicar no WhatsApp de um cliente. */}
          <span className="w-px h-4 bg-[var(--th-line)]/60 mx-0.5" aria-hidden="true" />
          <button
            type="button"
            onClick={() => setWaTemplatesOpen(true)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-white/10 bg-white/5 text-slate-400 hover:text-emerald-300 hover:border-emerald-500/40 hover:bg-emerald-500/10 text-[10px] font-bold transition-colors cursor-pointer whitespace-nowrap"
            title="Configurar as mensagens padrão enviadas aos clientes pelo WhatsApp"
          >
            <MessageCircle size={12} />
            Mensagens
          </button>
        </div>

        {/* Lado direito: total (leitura) + link do formulário público.
            O botão é o MESMO componente usado na aba "Services" — mesmo
            estilo, ícone, link e feedback, sem duplicar a lógica de cópia. */}
        <div className="flex flex-shrink-0 items-center gap-2">
          <span className="hidden sm:inline text-[10px] font-bold uppercase tracking-wider text-slate-500 whitespace-nowrap">
            Total realizado: <span className="text-emerald-400 font-mono">{formatRC(totalRealizado)}</span>
          </span>
          <ServiceFormLinkButton />
        </div>
      </div>

      {error && (
        <div className="mx-2 mb-1.5 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-[11px] font-semibold text-rose-300 flex-shrink-0">
          {error}
        </div>
      )}

      {/* Tabela */}
      <div className="flex-1 min-h-0 overflow-auto custom-scrollbar border-t border-[var(--th-line)]/100">
        {isLoading && services.length === 0 && requests.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-2 text-slate-500">
            <div className="w-8 h-8 rounded-full border-2 border-sky-500/30 border-t-sky-500 animate-spin" />
            <span className="text-xs font-bold">Carregando seus Services...</span>
          </div>
        ) : visibleRows.length === 0 ? (
          <div className="mx-2 my-2 flex flex-col items-center justify-center py-16 gap-2.5 text-slate-500 border border-dashed border-[var(--th-line)]/40 rounded-xl">
            <Briefcase size={28} className="text-slate-600" />
            <span className="text-xs font-bold text-slate-400">
              {view === "disponiveis" ? "Nenhum Service disponível" : "Nenhum Service realizado ainda"}
            </span>
            {/* O botão também existe no cabeçalho da tabela — mas com a guia
                vazia a tabela inteira não renderiza. Aqui ele garante que a
                adição manual esteja SEMPRE acessível, inclusive no primeiro
                uso. Rótulo completo: visibilidade evidente no estado vazio. */}
            <AddServiceButton labeled />
            <span className="text-[10px] text-slate-600">
              {view === "disponiveis"
                ? "Cadastre um personagem para Service sem usar o Formulário Público."
                : "Registre um Service já concluído diretamente por aqui."}
            </span>
          </div>
        ) : (
          // `w-full` + `minWidth: TABLE_MIN_WIDTH` + `table-fixed`:
          //   • quando a janela é larga, a tabela ocupa 100% da área e a folga
          //     inteira é absorvida pela única coluna sem largura declarada
          //     (Anotações) — mesmo comportamento da tabela "Meus Personagens";
          //   • quando a janela é estreita, `minWidth` garante que nenhum
          //     filtro seja espremido e o contêiner rola horizontalmente.
          <table className="w-full text-sm table-fixed border-collapse" style={{ minWidth: TABLE_MIN_WIDTH }}>
            <colgroup>
              {COL_WIDTHS.map((width, i) => (
                <col key={i} style={width ? { width } : undefined} />
              ))}
            </colgroup>
            <thead className="sticky top-0 z-10">
              <tr>
                {/* Coluna do contador — abriga o botão "Adicionar Service",
                    mesmo padrão do "Adicionar Personagem" no CharTable. */}
                <th className={`${thCls} ${numColBorder}`}>
                  <AddServiceButton />
                </th>
                {/* Link — botão que abre a página oficial do personagem no
                    RubinOT. Sem ordenação: é apenas uma ação por linha. */}
                <th className={thCls}>Link</th>
                <SortTh colKey="personagem" label="Personagem" />
                <SortTh colKey="cliente" label="Cliente" />
                <SortTh colKey="data" label="Data" />
                <SortTh colKey="servidor" label="Servidor" />
                <SortTh colKey="voc" label="Voc" />
                <SortTh colKey="level" label="Lv" />
                <SortTh colKey="quest" label="Quest" />
                <SortTh colKey="pgto" label="Pgto" />
                <SortTh colKey="valor" label="Valor" />
                <SortTh colKey="whatsapp" label="WhatsApp" />
                <SortTh colKey="notes" label="Anotações" />
                <SortTh colKey="status" label="Status" />
                {/* Compartilhando — mesmo rótulo 🔗 usado na tabela "Meus
                    Personagens", para o usuário reconhecer de imediato. */}
                <SortTh colKey="shared" label="🔗" />
                <th className={thCls}>Ações</th>
              </tr>

              {/* 2ª linha: um filtro por coluna, logo abaixo do título. */}
              <tr>
                <th className={`${thFilterCls} ${numColBorder}`}>
                  {/* Botão de reset dos filtros — mesmo padrão da aba
                      "Meus Personagens" (CharTable): sempre visível, fica
                      âmbar e pulsando quando há algum filtro ativo. */}
                  <button
                    type="button"
                    onClick={clearColumnFilters}
                    className={`w-full h-6 rounded flex items-center justify-center transition-all cursor-pointer ${
                      hasActiveFilters
                        ? "bg-amber-500 text-black font-bold shadow-sm shadow-amber-500/20 animate-pulse"
                        : "bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white"
                    }`}
                    title="Limpar todos os filtros"
                  >
                    <RotateCcw size={11} />
                  </button>
                </th>
                {/* Link — sem filtro. */}
                <th className={thFilterCls} />
                <th className={thFilterCls}>
                  <ColFilter value={personagemFilter} onChange={setPersonagemFilter} placeholder="Filtrar..." />
                </th>
                <th className={thFilterCls}>
                  <ColFilter value={clienteFilter} onChange={setClienteFilter} placeholder="Filtrar..." />
                </th>
                <th className={thFilterCls}>
                  <FilterDateMax
                    label="Data máxima"
                    value={dataMax}
                    onChange={setDataMax}
                    placeholder="Até"
                  />
                </th>
                <th className={thFilterCls}>
                  <FilterSelect
                    options={SERVER_OPTIONS}
                    selected={serverFilter}
                    onSelect={setServerFilter}
                    placeholder="Todos"
                    allLabel="Todos"
                    searchable
                    searchPlaceholder="Buscar servidor..."
                    activeColor="cyan"
                    className={`w-full flex items-center justify-between gap-1 rounded border bg-[var(--th-n-elev)] px-1.5 py-0.5 text-[10px] transition-colors ${
                      serverFilter ? "border-sky-500/50 text-sky-300" : "border-white/10 text-slate-400 hover:border-white/20"
                    }`}
                  />
                </th>
                <th className={thFilterCls}>
                  <FilterMulti
                    label="Voc"
                    options={["EK", "ED", "MS", "RP", "MK"]}
                    selected={vocFilter}
                    onApply={setVocFilter}
                    placeholder="Todas"
                  />
                </th>
                <th className={thFilterCls}>
                  <FilterNumber
                    label="Level"
                    value={levelNum.value}
                    operator={levelNum.op}
                    onChange={(value, op) => setLevelNum({ value, op })}
                    placeholder="Lv"
                  />
                </th>
                <th className={thFilterCls}>
                  <FilterSelect
                    options={["soulwar", "sanguine"]}
                    selected={questFilter}
                    onSelect={setQuestFilter}
                    placeholder="Todas"
                    allLabel="Todas"
                    activeColor="cyan"
                    className={`w-full flex items-center justify-between gap-1 rounded border bg-[var(--th-n-elev)] px-1.5 py-0.5 text-[10px] transition-colors ${
                      questFilter ? "border-sky-500/50 text-sky-300" : "border-white/10 text-slate-400 hover:border-white/20"
                    }`}
                  />
                </th>
                <th className={thFilterCls}>
                  <FilterSelect
                    options={["pix", "rc", "5050", "combinado"]}
                    selected={pgtoFilter}
                    onSelect={setPgtoFilter}
                    placeholder="Todos"
                    allLabel="Todos"
                    activeColor="cyan"
                    className={`w-full flex items-center justify-between gap-1 rounded border bg-[var(--th-n-elev)] px-1.5 py-0.5 text-[10px] transition-colors ${
                      pgtoFilter ? "border-sky-500/50 text-sky-300" : "border-white/10 text-slate-400 hover:border-white/20"
                    }`}
                  />
                </th>
                <th className={thFilterCls}>
                  <FilterNumber
                    label="Valor"
                    value={valorNum.value}
                    operator={valorNum.op}
                    onChange={(value, op) => setValorNum({ value, op })}
                    placeholder="RC"
                  />
                </th>
                <th className={thFilterCls}>
                  <ColFilter value={whatsFilter} onChange={setWhatsFilter} placeholder="Filtrar..." />
                </th>
                <th className={thFilterCls}>
                  <ColFilter value={notesFilter} onChange={setNotesFilter} placeholder="Filtrar..." />
                </th>
                {/* Status, Compartilhando e Ações não têm filtro: a visão já
                    separa por status e o compartilhamento é derivado dele. */}
                <th className={thFilterCls} />
                <th className={thFilterCls} />
                <th className={thFilterCls} />
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row, idx) => {
                // ── SOLICITAÇÃO PENDENTE (topo de Disponíveis) ──────────
                if (row.kind === "pending") {
                  const request = row.request;
                  const isDeciding = decidingId === request.id;
                  return (
                    <tr key={`req_${request.id}`} className="h-10 border-b border-amber-500/20 bg-amber-500/[0.04] hover:bg-amber-500/[0.07] transition-colors">
                      <td className={`px-1 py-1 text-center font-mono text-[10px] font-bold text-slate-500 select-none ${numColBorder}`}>{idx + 1}</td>
                      {/* Link — página oficial do personagem no RubinOT. */}
                      <td className="px-1 py-1 text-center">
                        {request.personagem ? (
                          <button
                            type="button"
                            onClick={() => openExternalUrl(rubinotCharacterUrl(request.personagem))}
                            className="inline-flex items-center justify-center rounded p-1 text-sky-300 hover:text-sky-200 hover:bg-sky-500/10 transition-colors cursor-pointer"
                            title={`Abrir a página oficial de "${request.personagem}" no RubinOT`}
                          >
                            <ExternalLink size={12} />
                          </button>
                        ) : <span className="text-slate-600 text-xs">—</span>}
                      </td>
                      <td className="px-1 py-1 text-center">
                        <button
                          type="button"
                          onClick={() => copyCharacterName(request.personagem, request.id)}
                          className="w-full flex items-center justify-center gap-1 min-w-0 rounded px-1 py-0.5 hover:bg-white/5 transition-colors cursor-pointer"
                          title="Clique para copiar o nome do personagem"
                        >
                          <span className="text-xs font-bold text-slate-100 truncate">{request.personagem || "—"}</span>
                          {copiedId === request.id && <Check size={11} className="text-emerald-400 flex-shrink-0" />}
                        </button>
                      </td>
                      <td className="px-1 py-1.5 text-center text-xs text-sky-300 truncate" title={request.ownerName}>
                        {request.ownerName || <span className="italic text-slate-600">—</span>}
                      </td>
                      <td className="px-1 py-1.5 text-center text-[11px] font-mono text-amber-300/90 whitespace-nowrap">
                        {formatServiceDate(toIsoDate(request.createdAt)) || "—"}
                      </td>
                      <td className="px-1 py-1.5 text-center text-xs text-violet-300/90 truncate" title={serverLabel(request.servidor)}>{serverLabel(request.servidor) || "—"}</td>
                      <td className="px-1 py-1.5 text-center">
                        <span className="text-xs font-black" style={{ color: VOC_COLORS[request.voc as Vocation] }}>{request.voc}</span>
                      </td>
                      <td className="px-1 py-1.5 text-center text-xs font-mono text-orange-300/90">{request.level || 0}</td>
                      <td className="px-1 py-1.5 text-center">
                        <span className={`text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border ${
                          request.quest === "sanguine"
                            ? "border-rose-500/40 bg-rose-500/10 text-rose-300"
                            : "border-slate-500/40 bg-slate-500/10 text-slate-300"
                        }`}>
                          {request.quest === "sanguine" ? "SG" : "SW"}
                        </span>
                      </td>
                      <td className="px-1 py-1.5 text-center">
                        {request.paymentMethod ? (
                          <span className="text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border border-sky-500/30 bg-sky-500/10 text-sky-300">
                            {SERVICE_PAYMENT_LABELS[request.paymentMethod]}
                          </span>
                        ) : <span className="text-slate-600 text-xs">—</span>}
                      </td>
                      <td className="px-1 py-1.5 text-center text-xs font-mono">
                        <span className="text-slate-600 italic text-[10px]">a informar</span>
                      </td>
                      {/* WhatsApp e Anotações: o pedido é do próprio dono. */}
                      <td className="px-1 py-1.5 text-center text-slate-600 italic text-[10px]">—</td>
                      <td className="px-1 py-1.5 text-center text-[10px] text-slate-400 truncate" title={request.notes}>
                        {request.notes || <span className="italic text-slate-600">—</span>}
                      </td>
                      {/* Status: selo discreto de pendente */}
                      <td className="px-1 py-1.5 text-center">
                        <span className="inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border border-amber-500/40 bg-amber-500/10 text-amber-300">
                          <Clock size={10} /> Pendente
                        </span>
                      </td>
                      {/* Compartilhando — um pedido PENDENTE ainda não é um
                          Service: não existe em `sharedServices` e não alimenta
                          lista alguma. Traço apenas para alinhar as colunas. */}
                      <td className="px-1 py-1.5 text-center">
                        <span className="text-[10px] italic text-slate-600">—</span>
                      </td>
                      {/* Ações: Aprovar / Recusar */}
                      <td className="px-1 py-1.5 text-center">
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => handleApprove(request)}
                            disabled={isDeciding}
                            className="p-1 rounded border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                            title="Aprovar e criar o Service"
                          >
                            <ThumbsUp size={11} />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleReject(request)}
                            disabled={isDeciding}
                            className="p-1 rounded border border-rose-500/25 bg-rose-500/10 text-rose-400 hover:text-rose-200 hover:bg-rose-500/20 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                            title="Recusar a solicitação"
                          >
                            <ThumbsDown size={11} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                }

                // ── SERVICE JÁ APROVADO ────────────────────────────────
                const service = row.service;
                return (
                <tr
                  key={service.id}
                  onDoubleClick={() => { setEditing(service); setIsModalOpen(true); }}
                  className="h-10 border-b border-[var(--th-line)]/30 hover:bg-sky-500/[0.04] transition-colors cursor-default"
                  title="Clique duas vezes para editar este Service"
                >
                  <td className={`px-1 py-1 text-center font-mono text-[10px] font-bold text-slate-500 select-none ${numColBorder}`}>{idx + 1}</td>
                  {/* Link — página oficial do personagem no RubinOT.
                      `stopPropagation` no duplo clique: abrir o link não deve
                      disparar a edição do Service por trás. */}
                  <td className="px-1 py-1 text-center" onDoubleClick={e => e.stopPropagation()}>
                    {service.personagem ? (
                      <button
                        type="button"
                        onClick={() => openExternalUrl(rubinotCharacterUrl(service.personagem))}
                        className="inline-flex items-center justify-center rounded p-1 text-sky-300 hover:text-sky-200 hover:bg-sky-500/10 transition-colors cursor-pointer"
                        title={`Abrir a página oficial de "${service.personagem}" no RubinOT`}
                      >
                        <ExternalLink size={12} />
                      </button>
                    ) : <span className="text-slate-600 text-xs">—</span>}
                  </td>
                  {/* Nome copiável — mesmo padrão do CharTable. O marcador à
                      esquerda indica se a PRIMEIRA mensagem ao cliente já foi
                      enviada (confirmação "Abrir conversa" no Enviar WhatsApp). */}
                  <td className="px-1 py-1 text-center">
                    <span className="w-full flex items-center justify-center gap-1.5 min-w-0">
                      <FirstMessageMarker sentAt={service.firstMessageSentAt} />
                      <button
                        type="button"
                        onClick={() => copyCharacterName(service.personagem, service.id)}
                        className="flex items-center justify-center gap-1 min-w-0 rounded px-1 py-0.5 hover:bg-white/5 transition-colors cursor-pointer"
                        title="Clique para copiar o nome — duas vezes para editar"
                      >
                        <span className="text-xs font-bold text-slate-100 truncate">{service.personagem || "—"}</span>
                        {copiedId === service.id && <Check size={11} className="text-emerald-400 flex-shrink-0" />}
                      </button>
                    </span>
                  </td>
                  {/* Cliente — azul */}
                  <td className="px-1 py-1.5 text-center text-xs text-sky-300 truncate" title={service.ownerName}>
                    {service.ownerName || <span className="italic text-slate-600">—</span>}
                  </td>
                  {/* Data — dourado */}
                  <td className="px-1 py-1.5 text-center text-[11px] font-mono text-amber-300/90 whitespace-nowrap">
                    {formatServiceDate(service.dataService) || <span className="italic text-slate-600">—</span>}
                  </td>
                  <td className="px-1 py-1.5 text-center text-xs text-violet-300/90 truncate" title={serverLabel(service.servidor)}>{serverLabel(service.servidor) || "—"}</td>
                  <td className="px-1 py-1.5 text-center">
                    <span className="text-xs font-black" style={{ color: VOC_COLORS[service.voc as Vocation] }}>{service.voc}</span>
                  </td>
                  <td className="px-1 py-1.5 text-center text-xs font-mono text-orange-300/90">{service.level || 0}</td>
                  <td className="px-1 py-1.5 text-center">
                    <span className={`text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border ${
                      service.quest === "sanguine"
                        ? "border-rose-500/40 bg-rose-500/10 text-rose-300"
                        : "border-slate-500/40 bg-slate-500/10 text-slate-300"
                    }`}>
                      {service.quest === "sanguine" ? "SG" : "SW"}
                    </span>
                  </td>
                  <td className="px-1 py-1.5 text-center">
                    {service.paymentMethod ? (
                      <span className="text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border border-sky-500/30 bg-sky-500/10 text-sky-300">
                        {SERVICE_PAYMENT_LABELS[service.paymentMethod]}
                      </span>
                    ) : (
                      <span className="text-slate-600 text-xs">—</span>
                    )}
                  </td>
                  <td className="px-1 py-1.5 text-center text-xs font-mono">
                    {service.valorCombinado > 0
                      ? <span className="text-emerald-400 font-bold">{formatRC(service.valorCombinado)}</span>
                      : <span className="text-slate-600 italic text-[10px]">a informar</span>}
                  </td>
                  {/* WhatsApp — verde. Abre o SELETOR de mensagens padrão: a
                      conversa só abre com a mensagem escolhida (pré-preenchida
                      via ?text=). `stopPropagation` no duplo clique: dois
                      cliques rápidos no botão não devem abrir o modal por trás
                      do seletor. */}
                  <td className="px-1 py-1.5 text-center whitespace-nowrap" onDoubleClick={e => e.stopPropagation()}>
                    {(() => {
                      const display = formatWhatsDisplay(service);
                      if (!display) return <span className="text-slate-600 italic text-[10px]">—</span>;
                      return (
                        <button
                          type="button"
                          onClick={() => setWaTarget(service)}
                          className="inline-flex items-center gap-1 text-[10px] font-mono text-emerald-400/90 hover:text-emerald-300 hover:underline transition-colors cursor-pointer"
                          title={`Enviar mensagem para ${display} — escolha uma mensagem padrão`}
                        >
                          <MessageCircle size={10} className="flex-shrink-0" />
                          {display}
                        </button>
                      );
                    })()}
                  </td>
                  {/* Anotações — neutro */}
                  <td className="px-1 py-1.5 text-center text-[10px] text-slate-400 truncate" title={service.notes}>
                    {service.notes || <span className="italic text-slate-600">—</span>}
                  </td>
                  {/* Status — "Concluir" abre o ServiceValueModal; um duplo
                      clique aqui não pode empilhar o modal de edição atrás. */}
                  <td className="px-1 py-1.5 text-center" onDoubleClick={e => e.stopPropagation()}>
                    {view === "realizados" ? (
                      <span className="inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border border-emerald-500/30 bg-emerald-500/10 text-emerald-300">
                        <CheckCircle2 size={10} /> Realizado
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => toggleRealizado(service)}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 text-[9px] font-black uppercase tracking-wider transition-colors cursor-pointer"
                        title="Marcar como realizado"
                      >
                        <CheckCircle2 size={10} /> Concluir
                      </button>
                    )}
                  </td>
                  {/* ── COMPARTILHANDO ──────────────────────────────────
                      Indica se este Service ainda é oferecido em
                      `sharedServices` para os outros usuários montarem PT.

                      É DERIVADO, não um interruptor: o compartilhamento de um
                      Service é consequência do estado dele, e não uma escolha
                      separada. Três situações:

                        ✓  disponível  — aparece na ServiceList/Sugerir PT;
                        ⚠  provavelmente realizado — participou de uma PT com a
                           Quest concluída; sai de circulação automaticamente;
                        ✕  realizado   — concluído pelo Serviceiro.

                      O ⚠ usa o mesmo vocabulário visual dos personagens com
                      "Quest provavelmente já realizada" em Meus Personagens. */}
                  <td className="px-1 py-1.5 text-center" onDoubleClick={e => e.stopPropagation()}>
                    {(() => {
                      const isDone = service.status === "realizado";
                      const probablyDone = !isDone && isServiceProbablyDone(service, probableMarkers);
                      const isSharing = !isDone && !probablyDone;

                      if (probablyDone) {
                        return (
                          <span
                            className="inline-flex items-center justify-center w-6 h-6 rounded border border-amber-500/40 bg-amber-500/15 text-amber-400 text-[10px] font-bold"
                            title="Service provavelmente já realizado — participou de uma PT com a Quest concluída. O compartilhamento foi desativado automaticamente e ele não aparece mais para os outros usuários."
                          >
                            ⚠
                          </span>
                        );
                      }
                      return (
                        <span
                          className={`inline-flex items-center justify-center w-6 h-6 rounded border text-[10px] font-bold ${
                            isSharing
                              ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-400"
                              : "border-rose-500/40 bg-rose-500/15 text-rose-400"
                          }`}
                          title={isSharing
                            ? "Compartilhando — visível para os outros usuários montarem PT"
                            : "Não compartilhado — Service realizado, fora de circulação"}
                        >
                          {isSharing ? "✓" : "✕"}
                        </span>
                      );
                    })()}
                  </td>
                  {/* Ações — o botão Excluir vive aqui; um duplo clique
                      acidental não deve virar "editar" logo após a exclusão. */}
                  <td className="px-1 py-1.5 text-center" onDoubleClick={e => e.stopPropagation()}>
                    <div className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => { setEditing(service); setIsModalOpen(true); }}
                        className="p-1 rounded border border-white/10 bg-white/5 text-slate-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
                        title="Editar Service"
                      >
                        <Pencil size={11} />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(service)}
                        className="p-1 rounded border border-rose-500/25 bg-rose-500/10 text-rose-400 hover:text-rose-200 hover:bg-rose-500/20 transition-colors cursor-pointer"
                        title="Excluir Service"
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <MyServiceModal
        open={isModalOpen}
        initial={editing}
        onClose={() => { setIsModalOpen(false); setEditing(null); }}
        onSave={handleSave}
      />

      {/* Valor pendente: cancelar não conclui e não altera dados. */}
      <ServiceValueModal
        service={pendingValueService}
        onConfirm={confirmPendingValue}
        onCancel={() => setPendingValueService(null)}
      />

      {/* Exclusão de Service: substitui o antigo `window.confirm`.
          Cancelar apenas fecha — nenhum dado é tocado. */}
      <ConfirmModal
        open={!!pendingDelete}
        title="Excluir Service"
        message={
          <>
            Deseja realmente excluir o personagem{" "}
            <strong className="font-bold text-slate-100">{pendingDelete?.personagem || "—"}</strong>{" "}
            da sua lista de Services?
          </>
        }
        detail="Esta ação não pode ser desfeita."
        confirmLabel="Excluir"
        cancelLabel="Cancelar"
        tone="danger"
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />

      {/* Contato com o cliente: seletor de mensagem padrão → wa.me com o
          texto pré-preenchido (?text=). O envio é confirmado pelo usuário
          dentro do próprio WhatsApp. */}
      <WhatsappMessagePicker
        open={!!waTarget && !waTemplatesOpen}
        phoneDigits={waTarget ? cleanWhatsappPhone(waTarget.whatsappCountry, waTarget.whatsappArea, waTarget.whatsappNumber) : ""}
        phoneDisplay={waTarget ? formatWhatsDisplay(waTarget) : ""}
        templates={waTemplates}
        context={waContext}
        onClose={() => setWaTarget(null)}
        onOpenSettings={() => setWaTemplatesOpen(true)}
        onOpenLink={handleWaOpenLink}
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