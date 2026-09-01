import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { X, Check, Copy, Sparkles, UserCheck, ShieldAlert, RefreshCw, Save, Ban, Users, ChevronUp, ChevronDown, Lock, LockOpen, Settings2, Target, Server, Zap, Swords, Eye, CalendarDays, Clock, AlertTriangle } from "lucide-react";
import type { Character, PartyTab, WaitingService, Vocation } from "../types";
import { VOC_COLORS } from "../types";
import { suggestParty, findStrongerSwap, findWeakerSwap, computeCarrierIndices, normalizeTemplateType, orderTeamForDisplay, computeVocationAlternatives, isFlexibleSlot, FIXED_SLOT_COUNT, resolveServiceResponsible, type SuggestedPartyResult, type PartyCandidate, type SwapCandidates } from "../utils/suggestionAlgorithm";
import { useAuth } from "../context/AuthContext";
import { canViewCharacter } from "../utils/friendshipAccess";
import { canViewServiceForViewer } from "../utils/serviceVisibility";
import { getCharacterAccountKey } from "../utils/accountIdentity";
import { loadUIState, saveUIState } from "../storage";
import { SERVER_OPTIONS, isOfficialServer, normalizeServerName, serverKey } from "../constants/servers";

// ============================================================================
// CursorTooltip — Tooltip que segue o cursor do mouse e usa Portal para evitar
// clipping pelo modal. Reposiciona automaticamente conforme espaço disponível.
// ============================================================================
interface CursorTooltipProps {
  text: string;
  children: React.ReactNode;
}

function CursorTooltip({ text, children }: CursorTooltipProps) {
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const tooltipRef = useRef<HTMLDivElement>(null);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const padding = 12;
    const tooltipWidth = 220;
    const tooltipHeight = 60;

    let x = e.clientX + padding;
    let y = e.clientY + padding;

    // Ajuste horizontal: se não cabe à direita, posiciona à esquerda
    if (x + tooltipWidth > window.innerWidth - padding) {
      x = e.clientX - tooltipWidth - padding;
    }

    // Ajuste vertical: se não cabe abaixo, posiciona acima
    if (y + tooltipHeight > window.innerHeight - padding) {
      y = e.clientY - tooltipHeight - padding;
    }

    // Garantir que não ultrapasse os limites mínimos
    x = Math.max(padding, x);
    y = Math.max(padding, y);

    setPosition({ x, y });
  }, []);

  const handleMouseEnter = useCallback((e: React.MouseEvent) => {
    handleMouseMove(e);
    setVisible(true);
  }, [handleMouseMove]);

  const handleMouseLeave = useCallback(() => {
    setVisible(false);
  }, []);

  return (
    <>
      <div
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onMouseMove={handleMouseMove}
        className="contents"
      >
        {children}
      </div>
      {visible && createPortal(
        <div
          ref={tooltipRef}
          className="fixed z-[9999] pointer-events-none animate-in fade-in zoom-in-95 duration-100"
          style={{
            left: position.x,
            top: position.y,
          }}
        >
          <div className="max-w-[200px] px-2.5 py-1.5 rounded-lg bg-[var(--th-bg-raised)] border border-red-900/60 shadow-xl shadow-black/60 text-[10px] text-slate-200 leading-relaxed">
            {text}
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

// Chave base de persistência das configurações do modal de sugestão.
// Todas as chaves são prefixadas com este valor para isolamento no localStorage.
const PERSIST_KEY = "suggest_modal_prefs";
// Uma PT tem 5 vagas, logo o máximo teórico de repetições de dono é 4
// (um único usuário com os 5 personagens). Acima disso o número não teria
// significado algum, então o campo é limitado aqui.
const MAX_OWNER_REPEATS_LIMIT = 4;

/** Mesmo código fictício compacto usado no PartyPanel para contas de terceiros. */
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

interface Props {
  open: boolean;
  onClose: () => void;
  // `party` é opcional: quando ausente, o modal opera em modo "Criar PT a partir
  // da sugestão" — usuário escolhe Quest (SW/SG), Visibilidade (Pública/Privada)
  // e o servidor vem do filtro interno. Ao clicar em "Salvar PT", a PT é criada
  // diretamente no Firestore e todos os participantes recebem a notificação
  // "Você foi adicionado a uma PT" usando a mesma lógica do addToParty do PartyPanel.
  party?: PartyTab;
  characters: Character[];
  waitingList: WaitingService[];
  allParties: PartyTab[];
  userName: string;
  // Cria diretamente a PT no Firestore com os IDs sugeridos, servidor, ptType e
  // visibilidade. Responsável por gravar a PT, popular slotData/members/invitedUsers
  // e disparar a notificação "Você foi adicionado a uma PT" para cada participante.
  onCreateFromSuggestion: (
    suggestedIds: string[],
    suggestedServidor: string,
    suggestedPtType: "soulwar" | "sanguine",
    visibility: "public" | "private",
    horarioTimestamp?: number,
  ) => void;
  publicPartiesEnabled?: boolean;
}

// Lista oficial centralizada em src/constants/servers.ts
const CREATE_PT_SERVERS = SERVER_OPTIONS;

export default function SuggestPartyModal({
  open,
  onClose,
  party,
  characters,
  waitingList,
  allParties,
  userName,
  onCreateFromSuggestion,
  publicPartiesEnabled = true,
}: Props) {
  const { allUsers, currentUser, userProfile, acceptedFriendUids } = useAuth();
  const [copiedCellId, setCopiedCellId] = useState<string | null>(null);

  // O mapa é calculado na base completa recebida pelo modal, igual ao
  // PartyPanel. Assim o mesmo `ownerUid + conta` recebe o mesmo código fictício
  // nas duas telas, sem revelar o nome real de usuários terceiros.
  const accountMaskByKey = useMemo(() => {
    const keys = Array.from(new Set(
      characters.map(character => getCharacterAccountKey(character)).filter((key): key is string => !!key),
    )).sort();
    const map: Record<string, string> = {};
    keys.forEach((key, index) => { map[key] = shortAccountMask(index); });
    return map;
  }, [characters]);

  async function copyCell(event: React.MouseEvent<HTMLButtonElement>, cellId: string, value: string) {
    event.stopPropagation();
    const text = String(value || "").trim();
    if (!text || text === "—") return;
    const markCopied = () => {
      setCopiedCellId(cellId);
      window.setTimeout(() => setCopiedCellId(current => current === cellId ? null : current), 1500);
    };
    try {
      await navigator.clipboard.writeText(text);
      markCopied();
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      area.style.pointerEvents = "none";
      document.body.appendChild(area);
      area.focus();
      area.select();
      document.execCommand("copy");
      document.body.removeChild(area);
      markCopied();
    }
  }

  function getCandidateAccountCell(candidate: PartyCandidate): { value: string; ownAccount: boolean; serviceClient: boolean } {
    if (candidate.type === "waiting") {
      const service = candidate.rawObj as WaitingService;
      return {
        value: String(service.ownerName || "").trim() || "—",
        ownAccount: false,
        serviceClient: true,
      };
    }

    const character = candidate.rawObj as Character;
    const ownAccount = !!currentUser?.uid && character.ownerUid === currentUser.uid;
    if (ownAccount) {
      return {
        value: String(character.account || "").trim() || "—",
        ownAccount: true,
        serviceClient: false,
      };
    }

    const key = candidate.accountKey || getCharacterAccountKey(character);
    return {
      value: (key ? accountMaskByKey[key] : "") || "—",
      ownAccount: false,
      serviceClient: false,
    };
  }

  // Set memorizado e coleções exclusivamente com amigos/próprios (SEM a
  // exceção de PTs existentes) para garantir que sugestões automáticas NUNCA
  // utilizem personagens pertencentes a usuários que não sejam amigos.
  const acceptedFriendSet = useMemo(() => new Set(acceptedFriendUids || []), [acceptedFriendUids]);
  const friendsOnlyCharacters = useMemo(() => {
    const viewerUid = currentUser?.uid || "";
    return characters.filter(c => canViewCharacter(c, viewerUid, acceptedFriendSet));
  }, [characters, currentUser, acceptedFriendSet]);

  // ── VISIBILIDADE DOS SERVICES ────────────────────────────────────────────
  // CAUSA RAIZ do bug "Services nao entram na sugestao": aqui usava-se
  // `canViewCharacter`, que exige `entity.ownerUid` e devolve `false` quando
  // o campo esta ausente. Um `WaitingService` NAO tem `ownerUid` — o dono
  // dele e `serviceiroUid` (ou `addedBy`, nos registros legados).
  //
  // Resultado: `canViewCharacter` devolvia `false` para TODO Service, e a
  // lista chegava vazia ao algoritmo. Nenhum filtro posterior tinha chance de
  // agir, porque ja nao havia candidatos. Era por isso que corrigir apenas o
  // filtro de Participantes nao resolveu.
  //
  // A regra correta ja existe em `serviceVisibility.ts` e e a MESMA que a
  // Lista de Espera usa: dono, Boss, amigos do dono, e "Qualquer um" aberto a
  // todos. A lista recebida ja vem filtrada por `availableWaitingListForParty`
  // no App.tsx; reaplicamos aqui para o modal nao depender dessa garantia.
  const friendsOnlyWaitingList = useMemo(() => {
    const viewer = {
      viewerUid: currentUser?.uid || "",
      viewerName: userName || "",
      isBoss: userProfile?.role === "Boss",
      friendUids: acceptedFriendSet,
    };
    return waitingList.filter(w => canViewServiceForViewer(w, viewer));
  }, [waitingList, currentUser, acceptedFriendSet, userName, userProfile?.role]);

  // ============================================================================
  // ESTADO PERSISTENTE — carregado do localStorage na inicialização do
  // componente e salvo sempre que o usuário altera uma configuração.
  //
  // TODAS as configurações do modal são restauradas ao reabrir: usuários
  // selecionados, quest, composição, servidor, filtros e preferências.
  // Reaproveita `loadUIState`/`saveUIState` (src/storage.ts), o mesmo
  // mecanismo usado no resto do projeto — sem lógica de persistência nova.
  //
  // Exceção deliberada: DATA e HORÁRIO não persistem (uma PT nova quase nunca
  // reaproveita o horário da anterior; ver mais abaixo).
  // ============================================================================
  // SELEÇÃO DE USUÁRIOS É OBRIGATÓRIA.
  //
  // Antes existia a opção "Usuários", que alternava entre "any" (qualquer
  // usuário) e "filter" (apenas os selecionados). Ela foi removida: o quadro
  // de amigos fica sempre visível e a escolha é sempre exigida.
  //
  // O valor continua sendo passado como `userMode` para o algoritmo, agora
  // fixo em "filter" — assim nada muda em `suggestParty`, que segue com a
  // mesma assinatura e o mesmo comportamento.
  const userMode = "filter" as const;
  const [selectedUsers, setSelectedUsers] = useState<string[]>(() =>
    loadUIState(`${PERSIST_KEY}.selectedUsers`, [] as string[]));
  // "Nao emprestar Service": impede que um Service ocupe a participacao
  // EXCEDENTE de um usuario. Nao remove Services da sugestao.
  const [noServiceLoan, setNoServiceLoan] = useState<boolean>(() =>
    loadUIState(`${PERSIST_KEY}.noServiceLoan`, false));
  // ============================================================================
  // EMPRÉSTIMO — "Emprestar no máximo: N"
  //
  // Substitui a antiga caixa "Não emprestar" (booleana). O valor é o número de
  // REPETIÇÕES DE DONO toleradas na PT, não um teto por usuário:
  //
  //     repetições = 5 − (donos distintos na PT)
  //
  //   0 → no máximo 1 personagem por usuário (comportamento antigo);
  //   1 → um único usuário pode levar 2 personagens;
  //   2 → ex.: A=2, B=2, C=1.
  //
  // Migração: quem tinha `onePerUser === true` salvo começa em 0; quem tinha
  // false (ou nada) começa em 0 também — 0 é o padrão mais conservador e
  // jamais sugere uma PT que o usuário não teria aceitado antes.
  const [maxOwnerRepeats, setMaxOwnerRepeats] = useState<number>(() => {
    // O valor vem do localStorage, que pode conter lixo de versões antigas.
    // Qualquer coisa que não seja um inteiro no intervalo válido vira 0.
    const stored = loadUIState(`${PERSIST_KEY}.maxOwnerRepeats`, 0);
    const parsed = typeof stored === "number" ? stored : Number(stored);
    if (!Number.isFinite(parsed)) return 0;
    return Math.min(MAX_OWNER_REPEATS_LIMIT, Math.max(0, Math.floor(parsed)));
  });
  const [strength, setStrength] = useState<"low" | "medium" | "high">(() =>
    loadUIState(`${PERSIST_KEY}.strength`, "high" as "low" | "medium" | "high"));
  // Servidor — persistido junto das demais configurações do modal.
  const [serverMode, setServerMode] = useState<"auto" | "specific">(() =>
    loadUIState(`${PERSIST_KEY}.serverMode`, "auto" as "auto" | "specific"));
  const [specificServer, setSpecificServer] = useState<string>(() =>
    loadUIState(`${PERSIST_KEY}.specificServer`, ""));
  const [minLevels, setMinLevels] = useState<Record<string, number>>(() =>
    loadUIState(`${PERSIST_KEY}.minLevels`, { EK: 500, ED: 400, MS: 400, RP: 500, MK: 600 }));

  // Quest e Visibilidade — persistidas
  const [internalPtType, setInternalPtType] = useState<"soulwar" | "sanguine">(() =>
    loadUIState(`${PERSIST_KEY}.ptType`, "soulwar" as "soulwar" | "sanguine"));
  const effectivePtType: "soulwar" | "sanguine" = party
    ? (party.ptType === "sanguine" ? "sanguine" : "soulwar")
    : internalPtType;
  const effectivePartyId = party?.id || "__suggest_standalone__";

  const [internalVisibility, setInternalVisibility] = useState<"public" | "private">(() =>
    loadUIState(`${PERSIST_KEY}.visibility`, "public" as "public" | "private"));
  const effectiveVisibility: "public" | "private" = internalVisibility;
  // A PT privada exigia forçar o modo "filter" e restaurá-lo depois. Como a
  // seleção agora é SEMPRE obrigatória, não há mais estado a salvar/restaurar.
  function setVisibilityMode(nextVisibility: "public" | "private") {
    if (nextVisibility === "public" && !publicPartiesEnabled) return;
    setInternalVisibility(nextVisibility === "private" ? "private" : "public");
  }

  useEffect(() => {
    if (!publicPartiesEnabled && internalVisibility === "public") {
      setVisibilityMode("private");
    }
  }, [publicPartiesEnabled, internalVisibility]);


  // Data e Horário — NÃO persistidos (resetam ao abrir o modal: data = hoje, hora = vazia)
  const [internalDate, setInternalDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [internalTime, setInternalTime] = useState("");

  // Composição
  // `normalizeTemplateType` converte preferências antigas ("boa",
  // "aceitavel_*") em "muito_boa" — a categoria que as absorveu.
  const [templateType, setTemplateType] = useState<import("../utils/suggestionAlgorithm").PartyTemplateType>(() =>
    normalizeTemplateType(loadUIState<string>(`${PERSIST_KEY}.templateType`, "inteligente")));
  const [suggestionMode, setSuggestionMode] = useState<"inteligente" | "personalizado">(() =>
    loadUIState(`${PERSIST_KEY}.suggestionMode`, "inteligente" as "inteligente" | "personalizado"));
  const [customComposition, setCustomComposition] = useState(() =>
    loadUIState(`${PERSIST_KEY}.customComposition`, { EK: 1, ED: 1, MS: 1, RP: 2, MK: 0 }));
  const [customCompositionSaved, setCustomCompositionSaved] = useState(false);
  const [applyFeedback, setApplyFeedback] = useState(false);

  const [sharedXP, setSharedXP] = useState<boolean>(() =>
    loadUIState(`${PERSIST_KEY}.sharedXP`, false));
  const [useCharacters, setUseCharacters] = useState<boolean>(() =>
    loadUIState(`${PERSIST_KEY}.useCharacters`, true));
  const [useWaitingList, setUseWaitingList] = useState<boolean>(() =>
    loadUIState(`${PERSIST_KEY}.useWaitingList`, true));
  const [userSearch, setUserSearch] = useState<string>("");

  // ============================================================================
  // NOVO: Estado para o painel de estatísticas "Com os filtros"
  // ============================================================================
  // A caixa "Filtros" nasce MARCADA: o quadro de totais só é útil quando
  // reflete o que a sugestão realmente enxerga. A escolha continua persistida
  // na mesma chave, então quem desmarcar mantém a preferência ao reabrir.
  const [withFilters, setWithFilters] = useState<boolean>(() =>
    loadUIState(`${PERSIST_KEY}.withFilters`, true));

  // A moldura global limita o modal pelo viewport e deixa somente o conteúdo
  // interno rolar. Não usamos scale: ele reduz legibilidade e pode cortar
  // controles em zoom alto ou telas baixas.

  // ============================================================================
  // PERSISTÊNCIA — salva cada configuração sempre que muda
  // ============================================================================
  useEffect(() => { saveUIState(`${PERSIST_KEY}.selectedUsers`, selectedUsers); }, [selectedUsers]);
  useEffect(() => { saveUIState(`${PERSIST_KEY}.maxOwnerRepeats`, maxOwnerRepeats); }, [maxOwnerRepeats]);
  useEffect(() => { saveUIState(`${PERSIST_KEY}.noServiceLoan`, noServiceLoan); }, [noServiceLoan]);
  useEffect(() => { saveUIState(`${PERSIST_KEY}.strength`, strength); }, [strength]);
  useEffect(() => { saveUIState(`${PERSIST_KEY}.minLevels`, minLevels); }, [minLevels]);
  useEffect(() => { saveUIState(`${PERSIST_KEY}.ptType`, internalPtType); }, [internalPtType]);
  useEffect(() => { saveUIState(`${PERSIST_KEY}.visibility`, internalVisibility); }, [internalVisibility]);
  useEffect(() => { saveUIState(`${PERSIST_KEY}.templateType`, templateType); }, [templateType]);
  useEffect(() => { saveUIState(`${PERSIST_KEY}.suggestionMode`, suggestionMode); }, [suggestionMode]);
  useEffect(() => { saveUIState(`${PERSIST_KEY}.customComposition`, customComposition); }, [customComposition]);
  useEffect(() => { saveUIState(`${PERSIST_KEY}.sharedXP`, sharedXP); }, [sharedXP]);
  useEffect(() => { saveUIState(`${PERSIST_KEY}.useCharacters`, useCharacters); }, [useCharacters]);
  useEffect(() => { saveUIState(`${PERSIST_KEY}.useWaitingList`, useWaitingList); }, [useWaitingList]);
  useEffect(() => { saveUIState(`${PERSIST_KEY}.serverMode`, serverMode); }, [serverMode]);
  useEffect(() => { saveUIState(`${PERSIST_KEY}.specificServer`, specificServer); }, [specificServer]);
  useEffect(() => { saveUIState(`${PERSIST_KEY}.withFilters`, withFilters); }, [withFilters]);

  // Ao abrir o modal, reseta APENAS data e horário.
  //
  // O servidor deixou de ser reiniciado para "Auto": ele agora é persistido
  // como as demais configurações. Data/horário continuam sendo zerados de
  // propósito — reaproveitar o horário da PT anterior quase nunca é o desejado
  // e passaria despercebido.
  useEffect(() => {
    if (open) {
      setInternalDate(new Date().toISOString().slice(0, 10));
      setInternalTime("");
    }
  }, [open]);

  const [result, setResult] = useState<SuggestedPartyResult | null>(null);
  const [shownAutoTemplates, setShownAutoTemplates] = useState<string[]>([]);
  const [nextAutoSuggestion, setNextAutoSuggestion] = useState<SuggestedPartyResult | null>(null);
  const [isCalculating, setIsCalculating] = useState(false);
  const [isSavingParty, setIsSavingParty] = useState(false);
  const [liveCandidates, setLiveCandidates] = useState<PartyCandidate[]>([]);
  const [liveCarriers, setLiveCarriers] = useState<number[]>([]);
  const pendingCreateRef = useRef<{
    existingIds: string[];
    suggestedIds: string[];
    servidor: string;
    ptType: "soulwar" | "sanguine";
    visibility: "public" | "private";
    horarioTimestamp?: number;
  } | null>(null);

  // Limite efetivo repassado ao algoritmo (inteiro ≥ 0; nunca NaN).
  const effectiveMaxOwnerRepeats = Number.isFinite(maxOwnerRepeats) ? Math.max(0, Math.floor(maxOwnerRepeats)) : 0;

  const allDonos = useMemo(() => {
    const set = new Set<string>();
    const viewerUid = currentUser?.uid || "";

    // 1. O próprio usuário
    if (userName) set.add(userName.trim());
    if (userProfile?.nome) set.add(userProfile.nome.trim());

    // 2. Todos os usuários com amizade aceita
    allUsers.forEach(u => {
      if (u.uid === viewerUid || acceptedFriendSet.has(u.uid)) {
        if (u.nome) set.add(u.nome.trim());
      }
    });

    return Array.from(set).filter(Boolean).sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [allUsers, acceptedFriendSet, currentUser, userName, userProfile]);

  const ownAuthorizedUser = useMemo(() => {
    return (userProfile?.nome || userName || "").trim();
  }, [userProfile?.nome, userName]);

  useEffect(() => {
    if (userMode !== "filter" || !ownAuthorizedUser) return;
    setSelectedUsers(prev => {
      const ownLower = ownAuthorizedUser.toLowerCase();
      if (prev.some(u => u.toLowerCase() === ownLower)) return prev;
      return [...prev, ownAuthorizedUser];
    });
  }, [userMode, ownAuthorizedUser]);

  const serverOptions = useMemo(() => [...CREATE_PT_SERVERS], []);


  const [serverDropdownOpen, setServerDropdownOpen] = useState(false);
  const serverDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!serverDropdownOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (serverDropdownRef.current && !serverDropdownRef.current.contains(e.target as Node)) {
        setServerDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [serverDropdownOpen]);

  // Potencial de formação de PT por servidor em tempo real (respeitando os filtros configurados no modal).
  //
  // Só é calculado quando o resultado pode ser visto/usado:
  //   • modo IA  → alimenta a escolha automática do servidor;
  //   • dropdown aberto → alimenta os selos por servidor e a ordenação.
  // Com servidor MANUAL e dropdown fechado nada é recalculado, exatamente
  // como pedido: a IA volta a trabalhar quando "IA" for selecionada de novo.
  const shouldComputeServerPotentials = serverMode === "auto" || serverDropdownOpen;

  const serverPotentials = useMemo(() => {
    const potentials: Record<string, { success: boolean; label: string; futurePTs: number; templateQuality: number; teamScore: number; serverCandidatesCount: number }> = {};
    if (!shouldComputeServerPotentials) return potentials;

    CREATE_PT_SERVERS.forEach(srv => {
      // 1. Filtrar APENAS personagens e services de AMIGOS / PRÓPRIOS para sugestão automática
      // Comparação canônica (mesma do algoritmo): "Grimoria 1" e "Grimoria I"
      // são o mesmo servidor; "Grimoria I" e "Grimoria II" nunca se misturam.
      // Com igualdade textual crua, personagens salvos com nomenclatura antiga
      // ficavam de fora e o servidor era julgado inviável sem motivo.
      const srvKey = serverKey(srv);
      const srvChars = friendsOnlyCharacters.filter(c => serverKey(c.servidor) === srvKey);
      const srvWaiting = friendsOnlyWaitingList.filter(w => serverKey(w.servidor) === srvKey);

      // 2. Rodar suggestParty para este servidor especificamente
      const res = suggestParty(
        srvChars,
        srvWaiting,
        allParties,
        effectivePartyId,
        userName,
        {
          questType: effectivePtType,
          userMode,
          selectedUsers,
          maxOwnerRepeats: effectiveMaxOwnerRepeats,
          noServiceLoan,
          strength,
          serverMode: "specific",
          specificServer: srv,
          minLevels,
          templateType: suggestionMode === "inteligente"
            ? "inteligente"
            : (customCompositionSaved ? "custom" : templateType),
          customComposition: suggestionMode === "personalizado" && customCompositionSaved
            ? customComposition
            : undefined,
          sharedXP,
          useCharacters,
          useWaitingList,
        }
      );

      if (res.success) {
        let label = res.templateName;
        if (label.includes("PT Ideal")) label = "PT Ideal";
        else if (label.includes("PT Muito Boa")) label = "PT Muito Boa";
        else if (label.includes("Composição Personalizada")) label = "PT Custom";

        potentials[srv] = {
          success: true,
          label,
          futurePTs: res.futurePTsAfterSuggestion || 0,
          templateQuality: res.templateQuality || 0,
          teamScore: res.teamScore || 0,
          serverCandidatesCount: res.serverCandidatesCount || (srvChars.length + srvWaiting.length),
        };
      } else {
        // Testar se adicionando uma única vocação a PT é formada.
        // Esse diagnóstico custa 5 execuções extras por servidor e só aparece
        // nos selos do dropdown — então só roda quando o dropdown está aberto.
        const missingVocs: string[] = [];
        (serverDropdownOpen ? (["EK", "ED", "MS", "RP", "MK"] as Vocation[]) : []).forEach(V => {
          const mockChar = {
            id: `mock_char_${V}`,
            account: `mock_account_${V}`,
            personagem: "Mock Personagem",
            servidor: srv,
            voc: V,
            level: 2000,
            soulwar: true,
            sanguine: true,
            valorPago: 0,
            dropSW: 0,
            dropBakra: 0,
            valorVenda: 0,
            vendido: false,
            shared: true,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            ownerName: `Mock Owner ${V}`,
            ownerUid: `mock_uid_${V}`
          } as Character;

          const testRes = suggestParty(
            [...srvChars, mockChar],
            srvWaiting,
            allParties,
            effectivePartyId,
            userName,
            {
              questType: effectivePtType,
              userMode,
              selectedUsers,
              maxOwnerRepeats: effectiveMaxOwnerRepeats,
              noServiceLoan,
              strength,
              serverMode: "specific",
              specificServer: srv,
              minLevels,
              templateType: suggestionMode === "inteligente"
                ? "inteligente"
                : (customCompositionSaved ? "custom" : templateType),
              customComposition: suggestionMode === "personalizado" && customCompositionSaved
                ? customComposition
                : undefined,
              sharedXP,
              useCharacters,
              useWaitingList,
            }
          );

          if (testRes.success) {
            missingVocs.push(V);
          }
        });

        if (missingVocs.length > 0) {
          potentials[srv] = { success: false, label: `Falta ${missingVocs.join("/")}`, futurePTs: -1, templateQuality: 0, teamScore: 0, serverCandidatesCount: srvChars.length + srvWaiting.length };
        } else {
          potentials[srv] = { success: false, label: "⚠", futurePTs: -1, templateQuality: 0, teamScore: 0, serverCandidatesCount: srvChars.length + srvWaiting.length };
        }
      }
    });

    return potentials;
  }, [
    // A base REAL usada no corpo é a de amigos/próprios: sem estas duas
    // dependências, aceitar/remover uma amizade não recalculava o servidor.
    friendsOnlyCharacters, friendsOnlyWaitingList,
    shouldComputeServerPotentials, serverDropdownOpen,
    allParties, effectivePartyId, effectivePtType,
    userMode, selectedUsers, effectiveMaxOwnerRepeats, noServiceLoan, strength, minLevels,
    suggestionMode, templateType, customComposition, customCompositionSaved,
    sharedXP, useCharacters, useWaitingList, userName
  ]);

  const orderedServerOptions = useMemo(() => {
    return [...serverOptions].sort((a, b) => {
      const pa = serverPotentials[a];
      const pb = serverPotentials[b];
      const aSuccess = pa?.success ? 1 : 0;
      const bSuccess = pb?.success ? 1 : 0;
      if (bSuccess !== aSuccess) return bSuccess - aSuccess;
      if ((pb?.futurePTs ?? -1) !== (pa?.futurePTs ?? -1)) return (pb?.futurePTs ?? -1) - (pa?.futurePTs ?? -1);
      if ((pb?.templateQuality ?? 0) !== (pa?.templateQuality ?? 0)) return (pb?.templateQuality ?? 0) - (pa?.templateQuality ?? 0);
      if ((pb?.teamScore ?? 0) !== (pa?.teamScore ?? 0)) return (pb?.teamScore ?? 0) - (pa?.teamScore ?? 0);
      if ((pb?.serverCandidatesCount ?? 0) !== (pa?.serverCandidatesCount ?? 0)) return (pb?.serverCandidatesCount ?? 0) - (pa?.serverCandidatesCount ?? 0);
      return a.localeCompare(b, "pt-BR");
    });
  }, [serverOptions, serverPotentials]);

  // ============================================================================
  // MODO IA — ESCOLHA DO SERVIDOR
  //
  // `serverPotentials` já roda o algoritmo REAL (`suggestParty`) servidor a
  // servidor, com TODOS os filtros do modal: usuários selecionados, levels
  // mínimos, vocações/composição, Quest, Services vs personagens, limite de
  // empréstimo, Shared XP e força. Um servidor só tem `success: true` quando
  // uma PT completa e válida foi de fato montada nele.
  //
  // A IA passa a escolher EXCLUSIVAMENTE entre esses servidores, na ordem já
  // usada pelo dropdown (`orderedServerOptions`): mais PTs futuras, melhor
  // qualidade de composição, melhor pontuação e mais candidatos.
  //
  // Se nenhum servidor consegue montar PT, o valor é `null` — a interface
  // mostra "IA (Nenhum)" em vermelho e o botão de gerar fica bloqueado, em vez
  // de apontar para um servidor onde a composição é impossível.
  // ============================================================================
  const aiSelectedServer = useMemo<string | null>(() => {
    for (const srv of orderedServerOptions) {
      if (serverPotentials[srv]?.success) return srv;
    }
    return null;
  }, [orderedServerOptions, serverPotentials]);

  // ============================================================================
  // QUADRO DE TOTAIS POR VOCAÇÃO (tempo real)
  //
  // Com a caixa "Filtros" MARCADA, o quadro precisa refletir exatamente o
  // universo que `suggestParty` enxerga. Três divergências existiam:
  //
  //   1. o SERVIDOR era comparado por igualdade textual crua, então
  //      "Grimoria 1" não casava com "Grimoria I" (o algoritmo agrupa por
  //      `serverKey`, que canoniza alias/caixa/espaços);
  //   2. a base usada era `characters`/`waitingList` cruas, sem o recorte de
  //      AMIZADE — o quadro contava personagens de não-amigos, que a sugestão
  //      jamais poderia escolher;
  //   3. servidor em branco com modo "specific" zerava a comparação.
  //
  // O quadro também ACOMPANHA o servidor do modo IA: quando o campo Servidor
  // está em "IA (Lunarian)", o recorte é Lunarian. Se a IA não acha servidor
  // algum ("IA (Nenhum)"), o quadro zera em vez de mostrar totais de outro
  // servidor. Declarado DEPOIS de `aiSelectedServer` de propósito: ler a
  // constante antes da inicialização seria um erro de TDZ em runtime.
  //
  // Com a caixa DESMARCADA nada muda: o quadro segue mostrando o total bruto.
  // ============================================================================
  const vocationCounts = useMemo(() => {
    const counts: Record<Vocation | "Total", number> = { EK: 0, ED: 0, MS: 0, RP: 0, MK: 0, Total: 0 };

    // IDs ocupados em outras PTs ativas
    const busyIds = new Set<string>();
    allParties.forEach(p => {
      if (p.id === effectivePartyId || p.archived) return;
      (p.selectedIds || []).forEach(id => busyIds.add(id));
    });

    // Helper para resolver nome do dono
    const resolveOwner = (ownerName?: string, addedBy?: string) => {
      return (ownerName || addedBy || userName || "").trim().toLowerCase();
    };
    // Responsavel por um Service = SERVICEIRO (`addedBy`), nunca o cliente
    // (`ownerName`). "Qualquer um"/vazio => Service livre, sem dono exigido.
    // Espelha `resolveServiceResponsible` do algoritmo, para o contador e a
    // sugestao considerarem exatamente o mesmo conjunto.
    const resolveServiceOwner = (addedBy?: string) => {
      const assigned = (addedBy || "").trim();
      if (!assigned || assigned.toLowerCase() === "qualquer um") return "";
      return assigned.toLowerCase();
    };

    // Servidor de referência do quadro:
    //   • manual  → o servidor escolhido pelo usuário;
    //   • IA      → o servidor que a IA selecionou agora;
    //   • IA sem servidor viável → nenhum resultado é válido (zera).
    // String vazia = sem recorte (manual ainda sem servidor escolhido).
    const referenceServer = serverMode === "specific" ? specificServer : (aiSelectedServer || "");
    const selectedServerKey = serverKey(referenceServer);
    const aiHasNoServer = serverMode === "auto" && !aiSelectedServer;

    // Com filtros ligados, contar sobre a MESMA base da sugestão: apenas
    // personagens/services próprios ou de amigos.
    const baseCharacters = withFilters ? friendsOnlyCharacters : characters;
    const baseWaitingList = withFilters ? friendsOnlyWaitingList : waitingList;

    // Sem servidor válido no modo IA não há universo a contar: devolver zeros
    // em vez de números de um servidor que não é o de referência.
    if (withFilters && aiHasNoServer) return counts;

    // Processar personagens
    if (!withFilters || useCharacters) {
      baseCharacters.forEach(c => {
        // Filtros básicos (sempre aplicados)
        if (c.vendido) return;
        if (!isOfficialServer(c.servidor)) return;
        if (effectivePtType === "soulwar" && !c.soulwar) return;
        if (effectivePtType === "sanguine" && !c.sanguine) return;

        // Filtros adicionais (apenas quando withFilters está ativo)
        if (withFilters) {
          if (c.shared === false) return;
          if (busyIds.has(c.id)) return;

          // Filtrar por nível mínimo
          const minLv = minLevels[c.voc];
          if (minLv !== undefined && (c.level || 0) < minLv) return;

          // Filtrar por usuário
          if (userMode === "filter" && selectedUsers.length > 0) {
            const dono = resolveOwner(c.ownerName);
            const match = selectedUsers.some(u => u.toLowerCase() === dono);
            if (!match) return;
          }

          // Filtrar pelo SERVIDOR selecionado, com a mesma canonização do
          // algoritmo: "Grimoria 1" e "Grimoria I" são o mesmo servidor;
          // "Grimoria I" e "Grimoria II" nunca se misturam.
          if (selectedServerKey && serverKey(c.servidor) !== selectedServerKey) return;
        }

        if (c.voc && counts[c.voc] !== undefined) {
          counts[c.voc]++;
        }
      });
    }

    // Processar waiting list (services)
    if (!withFilters || useWaitingList) {
      baseWaitingList.forEach(w => {
        // Filtros básicos
        if (!isOfficialServer(w.servidor)) return;
        if (w.quest !== effectivePtType) return;

        // Filtros adicionais
        if (withFilters) {
          if (busyIds.has(w.id)) return;

          // Filtrar por nível mínimo
          const minLv = minLevels[w.voc];
          if (minLv !== undefined && (w.level || 0) < minLv) return;

          // Filtrar por usuário
          if (userMode === "filter" && selectedUsers.length > 0) {
            const responsavel = resolveServiceOwner(w.addedBy);
            if (responsavel) {
              const match = selectedUsers.some(u => u.toLowerCase() === responsavel);
              if (!match) return;
            }
          }

          // Mesmo recorte de servidor aplicado aos Services.
          if (selectedServerKey && serverKey(w.servidor) !== selectedServerKey) return;
        }

        if (w.voc && counts[w.voc] !== undefined) {
          counts[w.voc]++;
        }
      });
    }

    counts.Total = counts.EK + counts.ED + counts.MS + counts.RP + counts.MK;
    return counts;
  }, [
    characters, waitingList, friendsOnlyCharacters, friendsOnlyWaitingList,
    allParties, effectivePartyId, effectivePtType,
    withFilters, useCharacters, useWaitingList, minLevels, userMode,
    selectedUsers, serverMode, specificServer, aiSelectedServer, userName
  ]);

  // Contagem de personagens qualificados por servidor (tempo real, respeitando todos os filtros configurados no modal)
  const serverCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    CREATE_PT_SERVERS.forEach(srv => {
      counts[srv] = 0;
    });

    const busyIds = new Set<string>();
    allParties.forEach(p => {
      if (p.id === effectivePartyId || p.archived) return;
      (p.selectedIds || []).forEach(id => busyIds.add(id));
    });

    const resolveOwner = (ownerName?: string, addedBy?: string) => {
      return (ownerName || addedBy || userName || "").trim().toLowerCase();
    };
    // Responsavel por um Service = SERVICEIRO (`addedBy`), nunca o cliente
    // (`ownerName`). "Qualquer um"/vazio => Service livre, sem dono exigido.
    // Espelha `resolveServiceResponsible` do algoritmo, para o contador e a
    // sugestao considerarem exatamente o mesmo conjunto.
    const resolveServiceOwner = (addedBy?: string) => {
      const assigned = (addedBy || "").trim();
      if (!assigned || assigned.toLowerCase() === "qualquer um") return "";
      return assigned.toLowerCase();
    };

    if (useCharacters) {
      characters.forEach(c => {
        if (c.vendido) return;
        const srv = normalizeServerName(c.servidor);
        if (!isOfficialServer(srv)) return;
        if (effectivePtType === "soulwar" && !c.soulwar) return;
        if (effectivePtType === "sanguine" && !c.sanguine) return;

        if (c.shared === false) return;
        if (busyIds.has(c.id)) return;

        const minLv = minLevels[c.voc];
        if (minLv !== undefined && (c.level || 0) < minLv) return;

        if (userMode === "filter" && selectedUsers.length > 0) {
          const dono = resolveOwner(c.ownerName);
          const match = selectedUsers.some(u => u.toLowerCase() === dono);
          if (!match) return;
        }

        counts[srv] = (counts[srv] || 0) + 1;
      });
    }

    if (useWaitingList) {
      waitingList.forEach(w => {
        const srv = normalizeServerName(w.servidor);
        if (!isOfficialServer(srv)) return;
        if (w.quest !== effectivePtType) return;

        if (busyIds.has(w.id)) return;

        const minLv = minLevels[w.voc];
        if (minLv !== undefined && (w.level || 0) < minLv) return;

        if (userMode === "filter" && selectedUsers.length > 0) {
          const responsavel = resolveServiceOwner(w.addedBy);
          if (responsavel) {
            const match = selectedUsers.some(u => u.toLowerCase() === responsavel);
            if (!match) return;
          }
        }

        counts[srv] = (counts[srv] || 0) + 1;
      });
    }

    return counts;
  }, [
    characters, waitingList, allParties, effectivePartyId, effectivePtType,
    useCharacters, useWaitingList, minLevels, userMode, selectedUsers, userName
  ]);

  // Rótulo do modo IA.
  //
  // O fallback antigo era "servidor com mais personagens", que ignorava os
  // filtros e podia apontar um servidor onde nenhuma PT se forma. Agora o
  // rótulo só mostra um servidor que comprovadamente monta PT.
  //
  // O rótulo NÃO pode preferir `result` de forma incondicional: `result` é a
  // última PT gerada e sobrevive a mudanças de filtro, o que congelava o nome
  // do servidor antigo. Ele só vale enquanto o servidor que produziu ainda for
  // o que a IA escolheria com os filtros ATUAIS; caso contrário manda a IA.
  const autoServerLabel = useMemo(() => {
    if (result?.success && result.server && serverKey(result.server) === serverKey(aiSelectedServer || "")) {
      return `IA (${result.server})`;
    }
    if (aiSelectedServer) return `IA (${aiSelectedServer})`;
    return "IA (Nenhum)";
  }, [result, aiSelectedServer]);

  // Nenhum servidor viável com os filtros atuais: usado para destacar o rótulo
  // em vermelho e impedir a tentativa de gerar uma composição impossível.
  const hasNoViableServer = serverMode === "auto" && !aiSelectedServer;

  useEffect(() => {
    if (open) {
      setResult(null);
      setLiveCandidates([]);
      setLiveCarriers([]);
      setIsSavingParty(false);
      pendingCreateRef.current = null;
    }
  }, [open]);

  useEffect(() => {
    if (!isSavingParty || !pendingCreateRef.current) return;
    const pending = pendingCreateRef.current;
    const existingIds = new Set(pending.existingIds);
    const foundParty = allParties.find((p) => {
      if (existingIds.has(p.id)) return false;
      if (currentUser?.uid && p.leaderUid !== currentUser.uid) return false;
      if ((p.servidor || "") !== pending.servidor) return false;
      if ((p.ptType === "sanguine" ? "sanguine" : "soulwar") !== pending.ptType) return false;
      if ((p.visibility || "public") !== pending.visibility) return false;
      if ((p.selectedIds || []).length !== pending.suggestedIds.length) return false;
      return pending.suggestedIds.every((id) => (p.selectedIds || []).includes(id));
    });
    if (foundParty) {
      setIsSavingParty(false);
      pendingCreateRef.current = null;
      onClose();
    }
  }, [allParties, isSavingParty, currentUser?.uid, onClose]);

  useEffect(() => {
    if (result?.success) {
      // EK, ED e RP ocupam sempre as 3 primeiras linhas. É apenas uma
      // permutação do time já montado: a composição não muda.
      const ordered = orderTeamForDisplay(result.candidates);
      setLiveCandidates(ordered);
      // Calcular carriers diretamente dos candidates para garantir consistência
      setLiveCarriers(computeCarrierIndices(ordered));
    } else {
      setLiveCandidates([]);
      setLiveCarriers([]);
    }
  }, [result]);

  // ============================================================================
  // CORREÇÃO DE STALE FILTERS NA SUGESTÃO DE PT
  // ============================================================================
  const filtersRef = useRef({
    characters, waitingList, allParties, userName,
    party, effectivePartyId, effectivePtType,
    userMode, selectedUsers, effectiveMaxOwnerRepeats, noServiceLoan,
    strength, serverMode, specificServer, minLevels,
    sharedXP, useCharacters, useWaitingList,
    suggestionMode, templateType, customComposition, customCompositionSaved,
  });
  filtersRef.current = {
    characters, waitingList, allParties, userName,
    party, effectivePartyId, effectivePtType,
    userMode, selectedUsers, effectiveMaxOwnerRepeats, noServiceLoan,
    strength, serverMode, specificServer, minLevels,
    sharedXP, useCharacters, useWaitingList,
    suggestionMode, templateType, customComposition, customCompositionSaved,
  };

  // Trocar o servidor manual invalida resultado e composição pré-calculada do
  // servidor anterior. Sem esta limpeza, "Sugerir outra composição" podia usar
  // `nextAutoSuggestion` criada antes da troca e mostrar outro servidor.
  useEffect(() => {
    if (!open) return;
    setResult(null);
    setShownAutoTemplates([]);
    setNextAutoSuggestion(null);
    setLiveCandidates([]);
    setLiveCarriers([]);
  }, [open, serverMode, specificServer]);

  function isSuggestionCompatibleWithCurrentServer(suggestion: SuggestedPartyResult | null): boolean {
    if (!suggestion?.success) return false;
    const current = filtersRef.current;
    if (current.serverMode !== "specific") return true;
    const selectedKey = serverKey(current.specificServer);
    return !!selectedKey && serverKey(suggestion.server) === selectedKey;
  }

  function buildSuggestion(skipTemplateNames: string[] = []): SuggestedPartyResult {
    const f = filtersRef.current;

    // Utilizar APENAS personagens e services de amigos na sugestão automática
    const allowedChars = friendsOnlyCharacters.filter(c => isOfficialServer(c.servidor));
    const allowedWaiting = friendsOnlyWaitingList.filter(w => isOfficialServer(w.servidor));

    return suggestParty(
      allowedChars,
      allowedWaiting,
      f.allParties,
      f.effectivePartyId,
      f.userName,
      {
        questType: f.effectivePtType,
        userMode: f.userMode,
        selectedUsers: f.selectedUsers,
        maxOwnerRepeats: f.effectiveMaxOwnerRepeats,
        noServiceLoan: f.noServiceLoan,
        strength: f.strength,
        serverMode: f.serverMode,
        specificServer: f.specificServer,
        minLevels: f.minLevels,
        templateType: f.suggestionMode === "inteligente"
          ? "inteligente"
          : (f.customCompositionSaved ? "custom" : f.templateType),
        customComposition: f.suggestionMode === "personalizado" && f.customCompositionSaved
          ? f.customComposition
          : undefined,
        sharedXP: f.sharedXP,
        useCharacters: f.useCharacters,
        useWaitingList: f.useWaitingList,
        skipTemplateNames,
      }
    );
  }

  function handleRunSuggestion() {
    // Nenhum servidor forma PT com os filtros atuais: não tentar gerar uma
    // composição impossível. O botão já está desabilitado; esta guarda protege
    // contra qualquer outro caminho de disparo.
    if (hasNoViableServer) return;
    setResult(null);
    setLiveCandidates([]);
    setLiveCarriers([]);
    setIsCalculating(true);

    setTimeout(() => {
      const res = buildSuggestion([]);
      const shown = res.success ? [res.templateName] : [];
      const next = shown.length > 0 ? buildSuggestion(shown) : null;
      setShownAutoTemplates(shown);
      setNextAutoSuggestion(next && next.success ? next : null);
      setResult(res);
      setIsCalculating(false);
    }, 250);
  }

  function handleSuggestAnotherComposition() {
    if (suggestionMode !== "inteligente") return;

    // Uma sugestão pré-calculada só pode ser usada se ainda for compatível com
    // o servidor manual atual. Caso filtros/servidor tenham mudado, calculamos
    // de novo usando `filtersRef.current`, que sempre carrega o servidor atual.
    const currentResultIsCompatible = isSuggestionCompatibleWithCurrentServer(result);
    const usedTemplates = currentResultIsCompatible
      ? Array.from(new Set([...shownAutoTemplates, result!.templateName]))
      : [];
    const next = isSuggestionCompatibleWithCurrentServer(nextAutoSuggestion)
      ? nextAutoSuggestion
      : buildSuggestion(usedTemplates);

    if (!next?.success || !isSuggestionCompatibleWithCurrentServer(next)) {
      setNextAutoSuggestion(null);
      return;
    }

    const nextShown = Array.from(new Set([...usedTemplates, next.templateName]));
    const following = buildSuggestion(nextShown);
    setShownAutoTemplates(nextShown);
    setResult(next);
    setNextAutoSuggestion(following.success && isSuggestionCompatibleWithCurrentServer(following) ? following : null);
  }

  function computeSwapData(candidate: PartyCandidate, idx: number): SwapCandidates {
    if (!result?.candidatesByVocAndServer) return { slotIndex: idx, stronger: null, weaker: null };

    const teamIds = new Set(liveCandidates.map(c => c.id));

    // A troca manual respeita o MESMO limite de empréstimo da sugestão: o
    // substituto é avaliado contra o time sem o personagem que está saindo.
    const stronger = findStrongerSwap(result.candidatesByVocAndServer, candidate, teamIds, liveCandidates, effectiveMaxOwnerRepeats, noServiceLoan);
    const weaker = findWeakerSwap(result.candidatesByVocAndServer, candidate, teamIds, liveCandidates, effectiveMaxOwnerRepeats, noServiceLoan);

    return { slotIndex: idx, stronger, weaker };
  }

  function recalcCarriers(team: PartyCandidate[]) {
    setLiveCarriers(computeCarrierIndices(team));
  }

  const levelGapIndices = useMemo(() => {
    if (liveCandidates.length === 0) return new Set<number>();
    const maxLevel = Math.max(...liveCandidates.map(c => c.level));
    const threshold = maxLevel * 0.67;
    const indices = new Set<number>();
    liveCandidates.forEach((c, i) => {
      if (c.level < threshold) indices.add(i);
    });
    return indices;
  }, [liveCandidates]);

  function handleSwapStronger(idx: number) {
    const candidate = liveCandidates[idx];
    if (!candidate) return;
    const swapData = computeSwapData(candidate, idx);
    if (!swapData.stronger) return;

    const nextTeam = liveCandidates.map((c, i) => (i === idx ? swapData.stronger! : c));
    setLiveCandidates(nextTeam);
    recalcCarriers(nextTeam);
  }

  function handleSwapWeaker(idx: number) {
    const candidate = liveCandidates[idx];
    if (!candidate) return;
    const swapData = computeSwapData(candidate, idx);
    if (!swapData.weaker) return;

    const nextTeam = liveCandidates.map((c, i) => (i === idx ? swapData.weaker! : c));
    setLiveCandidates(nextTeam);
    recalcCarriers(nextTeam);
  }

  // ============================================================================
  // TROCA DE VOCAÇÃO NAS POSIÇÕES FLEXÍVEIS (4 e 5)
  //
  // As alternativas já vêm validadas por `computeVocationAlternatives`: só
  // existem quando a composição resultante continua válida E há personagem
  // elegível. Aqui apenas aplicamos a troca, revalidando por segurança.
  // ============================================================================
  const vocationAlternativesBySlot = useMemo(() => {
    return liveCandidates.map((_, index) => computeVocationAlternatives(
      liveCandidates, index, result?.candidatesByVocAndServer, effectiveMaxOwnerRepeats, noServiceLoan,
    ));
  }, [liveCandidates, result?.candidatesByVocAndServer, effectiveMaxOwnerRepeats]);

  function handleSwapVocation(idx: number, voc: Vocation) {
    if (!isFlexibleSlot(idx, liveCandidates.length)) return;
    const alternative = (vocationAlternativesBySlot[idx] || []).find(item => item.voc === voc);
    if (!alternative) return;

    const nextTeam = liveCandidates.map((c, i) => (i === idx ? alternative.candidate : c));
    setLiveCandidates(nextTeam);
    recalcCarriers(nextTeam);
  }

  function handleToggleUser(u: string) {
    if (ownAuthorizedUser && u.toLowerCase() === ownAuthorizedUser.toLowerCase()) return;
    setSelectedUsers(prev => {
      if (prev.includes(u)) return prev.filter(x => x !== u);
      return [...prev, u];
    });
  }

  function handleApplyComposition() {
    if (Object.values(customComposition).reduce((a, b) => a + b, 0) !== 5) return;
    setCustomCompositionSaved(true);
    setApplyFeedback(true);
    setTimeout(() => setApplyFeedback(false), 500);
  }

  function handleCompositionChange(voc: keyof typeof customComposition, delta: number) {
    setCustomComposition(prev => ({
      ...prev,
      [voc]: Math.max(0, prev[voc] + delta)
    }));
    setCustomCompositionSaved(false);
  }

  function handleSave() {
    if (liveCandidates.length === 0 || isSavingParty) return;
    if (!isSuggestionCompatibleWithCurrentServer(result)) return;
    const suggestedServidor = result?.server || (serverMode === "specific" ? specificServer : "");
    if (!isOfficialServer(suggestedServidor)) return;

    let horarioTimestamp: number | undefined;
    if (internalDate && internalTime) {
      horarioTimestamp = new Date(`${internalDate}T${internalTime}:00`).getTime();
    }

    pendingCreateRef.current = {
      existingIds: allParties.map(p => p.id),
      suggestedIds: liveCandidates.map(c => c.id),
      servidor: suggestedServidor,
      ptType: effectivePtType,
      visibility: effectiveVisibility,
      horarioTimestamp,
    };
    setIsSavingParty(true);

    onCreateFromSuggestion(
      liveCandidates.map(c => c.id),
      suggestedServidor,
      effectivePtType,
      effectiveVisibility,
      horarioTimestamp,
    );
  }

  if (!open) return null;

  const avgLevel = liveCandidates.length > 0
    ? Math.round(liveCandidates.reduce((s, c) => s + c.level, 0) / liveCandidates.length)
    : 0;

  return (
    <div
      className="app-modal-overlay fixed inset-0 z-[500] flex items-center justify-center bg-black/80 backdrop-blur-sm select-none"
      onMouseDown={e => { if (!isSavingParty && e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="app-modal-frame app-modal-size-wide app-modal-frame--scroll bg-[var(--th-n-deep)] border border-[var(--th-line)]/100 rounded-2xl shadow-xl w-full max-w-5xl"
      >

        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 sm:px-4 py-2.5 bg-gradient-to-r from-[var(--th-bg-raised)] to-[var(--th-bg-base)] border-b border-[var(--th-line)]/50 flex-shrink-0">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[var(--th-line)] to-[var(--th-brand-mid)]/40 border border-[var(--th-brand-mid)]/40 flex items-center justify-center">
              <Sparkles size={15} className="text-amber-600" />
            </div>
            <h2 className="text-sm font-bold text-white">
              Sugestão Automática de PT
            </h2>
          </div>

          {/* Painel de estatísticas de vocações */}
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
            <div className="flex items-center gap-0.5 bg-black/40 rounded-lg px-1.5 py-1 border border-red-900/100">
              {(["EK", "ED", "MS", "RP", "MK"] as const).map(voc => (
                <div
                  key={voc}
                  className="flex items-center gap-0.5 px-1 py-0.5"
                  title={`${voc}: ${vocationCounts[voc]} disponível(is)`}
                >
                  <span className="text-[8px] font-black" style={{ color: VOC_COLORS[voc] }}>{voc}</span>
                  <span className="text-[9px] font-bold text-white/90 tabular-nums">{vocationCounts[voc]}</span>
                </div>
              ))}
              <div className="flex items-center gap-0.5 px-1.5 py-0.5 ml-0.5 bg-red-900/20 rounded border border-red-800/100">
                <span className="text-[8px] font-black text-red-400">Total:</span>
                <span className="text-[9px] font-bold text-red-300 tabular-nums">{vocationCounts.Total}</span>
              </div>
            </div>

            <label
              className="group flex items-center gap-1.5 px-1.5 py-1 rounded-lg cursor-pointer transition-all text-[9px] font-medium border border-transparent hover:border-red-900/40 select-none"
              title="Exibir apenas personagens elegíveis após aplicação dos filtros atuais"
            >
              <input
                type="checkbox"
                checked={withFilters}
                onChange={e => setWithFilters(e.target.checked)}
                className="sr-only"
              />
              <div className={`relative w-[14px] h-[14px] rounded-[3px] border-2 flex-shrink-0 flex items-center justify-center transition-all duration-200 ${
                withFilters
                  ? "bg-gradient-to-br from-[var(--th-brand-mid)] to-[var(--th-brand-deep)] border-amber-600/50 shadow-[0_0_5px_color-mix(in_oklab,var(--th-brand)_40%,transparent),inset_0_1px_1px_rgba(255,255,255,0.08)]"
                  : "bg-[var(--th-n-deep)] border-[var(--th-line)]/100 group-hover:border-[var(--th-brand)]/80 group-hover:bg-[var(--th-bg-base)]"
              }`}>
                {withFilters && (
                  <svg width="8" height="6" viewBox="0 0 10 8" fill="none" className="drop-shadow-sm">
                    <path d="M1.5 4L3.8 6.5L8.5 1.5" stroke="#f6c96e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                )}
              </div>
              <span className={`transition-colors duration-200 ${withFilters ? "text-slate-200" : "text-slate-400 group-hover:text-slate-300"}`}>Filtros</span>
            </label>

            <button type="button" onClick={onClose} disabled={isSavingParty} className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-red-900/20 transition-colors cursor-pointer ml-0.5 disabled:opacity-30 disabled:pointer-events-none">
              <X size={15} />
            </button>
          </div>
        </div>

        <div className={`app-modal-body p-2.5 space-y-2 ${isSavingParty ? "opacity-60 pointer-events-none" : ""}`}>

          {/* Grid de Configurações */}
          <div className="grid grid-cols-1 sm:grid-cols-12 gap-2">

            {/* Card: Origem dos Dados */}
            <div className="col-span-1 sm:col-span-3 bg-[var(--th-n-base)] border border-[var(--th-line)]/80 rounded-xl p-2.5">
              <div className="flex items-center gap-1.5 text-[9px] font-bold text-red-400/80 uppercase tracking-wider mb-2">
                <Users size={10} /> Origem
              </div>
              <div className="space-y-1.5">
                <label className="group flex items-center gap-2 px-2 py-1.5 rounded-lg border border-transparent hover:border-red-900/30 transition-all cursor-pointer text-[10px] font-medium select-none">
                  <input type="checkbox" checked={useCharacters} onChange={e => setUseCharacters(e.target.checked)} className="sr-only" />
                  <div className={`relative w-[16px] h-[16px] rounded-[4px] border-2 flex-shrink-0 flex items-center justify-center transition-all duration-200 ${
                    useCharacters
                      ? "bg-gradient-to-br from-[var(--th-brand-mid)] to-[var(--th-brand-deep)] border-amber-600/50 shadow-[0_0_6px_color-mix(in_oklab,var(--th-brand)_40%,transparent),inset_0_1px_1px_rgba(255,255,255,0.08)]"
                      : "bg-[var(--th-n-deep)] border-[var(--th-line)]/100 group-hover:border-[var(--th-brand)]/80 group-hover:bg-[var(--th-bg-base)]"
                  }`}>
                    {useCharacters && (
                      <svg width="9" height="7" viewBox="0 0 10 8" fill="none" className="drop-shadow-sm">
                        <path d="M1.5 4L3.8 6.5L8.5 1.5" stroke="#f6c96e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    )}
                  </div>
                  <span className={`transition-colors duration-200 ${useCharacters ? "text-slate-200" : "text-slate-400 group-hover:text-slate-300"}`}>Personagens do Hub</span>
                </label>
                <label className="group flex items-center gap-2 px-2 py-1.5 rounded-lg border border-transparent hover:border-red-900/30 transition-all cursor-pointer text-[10px] font-medium select-none">
                  <input type="checkbox" checked={useWaitingList} onChange={e => setUseWaitingList(e.target.checked)} className="sr-only" />
                  <div className={`relative w-[16px] h-[16px] rounded-[4px] border-2 flex-shrink-0 flex items-center justify-center transition-all duration-200 ${
                    useWaitingList
                      ? "bg-gradient-to-br from-[var(--th-brand-mid)] to-[var(--th-brand-deep)] border-amber-600/50 shadow-[0_0_6px_color-mix(in_oklab,var(--th-brand)_40%,transparent),inset_0_1px_1px_rgba(255,255,255,0.08)]"
                      : "bg-[var(--th-n-deep)] border-[var(--th-line)]/100 group-hover:border-[var(--th-brand)]/80 group-hover:bg-[var(--th-bg-base)]"
                  }`}>
                    {useWaitingList && (
                      <svg width="9" height="7" viewBox="0 0 10 8" fill="none" className="drop-shadow-sm">
                        <path d="M1.5 4L3.8 6.5L8.5 1.5" stroke="#f6c96e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    )}
                  </div>
                  <span className={`transition-colors duration-200 ${useWaitingList ? "text-slate-200" : "text-slate-400 group-hover:text-slate-300"}`}>Personagens de Services</span>
                </label>
              </div>
            </div>

            {/* Card: Regras */}
            <div className="col-span-1 sm:col-span-4 bg-[var(--th-n-base)] border border-[var(--th-line)]/80 rounded-xl p-2.5">
              <div className="flex items-center gap-1.5 text-[9px] font-bold text-red-400/80 uppercase tracking-wider mb-2">
                <Settings2 size={10} /> Regras
              </div>
              {/* Empilhado: "Emprestar no máximo" em cima, "Shared XP" logo abaixo. */}
              <div className="flex flex-col gap-1">
                <CursorTooltip text="Total de personagens EMPRESTADOS na PT (soma de todos os usuários): cada personagem além do primeiro de um mesmo usuário conta 1. O limite é global e pode se distribuir entre usuários diferentes. 0 = no máximo 1 personagem por usuário. 2 = por exemplo A com 2 e B com 2, ou um único usuário com 3. Duas contas iguais nunca entram na mesma PT.">
                  <div className={`group flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg border transition-all duration-200 text-[10px] font-medium select-none ${maxOwnerRepeats > 0
                    ? "border-[var(--th-brand)]/45 bg-gradient-to-r from-[var(--th-brand-deep)]/45 via-[var(--th-brand-deep)]/20 to-transparent shadow-[inset_0_0_10px_color-mix(in_oklab,var(--th-brand)_10%,transparent)]"
                    : "border-[var(--th-brand)]/25 bg-gradient-to-r from-[var(--th-brand-deep)]/20 to-transparent hover:border-[var(--th-brand)]/45"}`}>
                    <span className="flex items-center gap-1.5 min-w-0">
                      <Users size={11} className={`flex-shrink-0 transition-colors duration-200 ${maxOwnerRepeats > 0 ? "text-amber-300" : "text-amber-500/50"}`} />
                      <span className={`truncate transition-colors duration-200 ${maxOwnerRepeats > 0 ? "text-amber-100 font-bold" : "text-slate-300 group-hover:text-amber-100/90"}`}>Emprestar no máximo:</span>
                    </span>
                    {/* Stepper: o valor NÃO é digitável, só muda por − / +. */}
                    <div className="flex items-center gap-0.5 flex-shrink-0">
                      <button
                        type="button"
                        onClick={() => setMaxOwnerRepeats(prev => Math.max(0, prev - 1))}
                        disabled={maxOwnerRepeats <= 0}
                        aria-label="Diminuir o limite de empréstimo"
                        title="Diminuir"
                        className={`h-[18px] w-[18px] flex items-center justify-center rounded border text-[11px] font-black leading-none transition-all duration-200 ${maxOwnerRepeats <= 0
                          ? "border-[var(--th-brand)]/25 bg-black/30 text-slate-600 cursor-not-allowed"
                          : "border-[var(--th-brand)]/45 bg-black/40 text-amber-200/90 hover:border-[var(--th-brand)]/80 hover:bg-[var(--th-brand-deep)]/40 hover:text-amber-100 cursor-pointer"}`}
                      >−</button>
                      <span
                        aria-live="polite"
                        aria-label={`Emprestar no máximo ${maxOwnerRepeats} repetição(ões) de dono`}
                        className={`w-7 text-center rounded border px-1 py-[3px] text-[10px] font-black tabular-nums transition-all duration-200 ${maxOwnerRepeats > 0
                          ? "border-[var(--th-brand)]/55 bg-gradient-to-br from-[var(--th-brand-mid)] to-[var(--th-brand-deep)] text-amber-50 shadow-[0_0_6px_color-mix(in_oklab,var(--th-brand)_35%,transparent),inset_0_1px_1px_rgba(255,255,255,0.08)]"
                          : "border-[var(--th-brand)]/25 bg-black/40 text-slate-400"}`}
                      >{maxOwnerRepeats}</span>
                      <button
                        type="button"
                        onClick={() => setMaxOwnerRepeats(prev => Math.min(MAX_OWNER_REPEATS_LIMIT, prev + 1))}
                        disabled={maxOwnerRepeats >= MAX_OWNER_REPEATS_LIMIT}
                        aria-label="Aumentar o limite de empréstimo"
                        title="Aumentar"
                        className={`h-[18px] w-[18px] flex items-center justify-center rounded border text-[11px] font-black leading-none transition-all duration-200 ${maxOwnerRepeats >= MAX_OWNER_REPEATS_LIMIT
                          ? "border-[var(--th-brand)]/25 bg-black/30 text-slate-600 cursor-not-allowed"
                          : "border-[var(--th-brand)]/45 bg-black/40 text-amber-200/90 hover:border-[var(--th-brand)]/80 hover:bg-[var(--th-brand-deep)]/40 hover:text-amber-100 cursor-pointer"}`}
                      >+</button>
                    </div>
                  </div>
                </CursorTooltip>
                <CursorTooltip text="Impede que um personagem de Service seja usado como o personagem EXCEDENTE (emprestado) de um usuário. Os Services continuam participando normalmente da PT — só não ocupam a vaga de empréstimo. Personagens pessoais seguem podendo ser emprestados até o limite acima.">
                  <label className="group flex items-center gap-2 px-2 py-1.5 rounded-lg border border-transparent hover:border-red-900/30 transition-all cursor-pointer text-[10px] font-medium select-none">
                    <input type="checkbox" checked={noServiceLoan} onChange={e => setNoServiceLoan(e.target.checked)} className="sr-only" />
                    <div className={`relative w-[16px] h-[16px] rounded-[4px] border-2 flex-shrink-0 flex items-center justify-center transition-all duration-200 ${
                      noServiceLoan
                        ? "bg-gradient-to-br from-[var(--th-brand-mid)] to-[var(--th-brand-deep)] border-amber-600/50 shadow-[0_0_6px_color-mix(in_oklab,var(--th-brand)_40%,transparent),inset_0_1px_1px_rgba(255,255,255,0.08)]"
                        : "bg-[var(--th-n-deep)] border-[var(--th-line)]/100 group-hover:border-[var(--th-brand)]/80 group-hover:bg-[var(--th-bg-base)]"
                    }`}>
                      {noServiceLoan && (
                        <svg width="9" height="7" viewBox="0 0 10 8" fill="none" className="drop-shadow-sm">
                          <path d="M1.5 4L3.8 6.5L8.5 1.5" stroke="#f6c96e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      )}
                    </div>
                    <span className={`transition-colors duration-200 ${noServiceLoan ? "text-slate-200" : "text-slate-400 group-hover:text-slate-300"}`}>Não emprestar Service</span>
                  </label>
                </CursorTooltip>
                <CursorTooltip text="Forçar PT's em que os personagens compartilham experiência (Shared XP).">
                  <label className="group flex items-center gap-2 px-2 py-1.5 rounded-lg border border-transparent hover:border-red-900/30 transition-all cursor-pointer text-[10px] font-medium select-none">
                    <input type="checkbox" checked={sharedXP} onChange={e => setSharedXP(e.target.checked)} className="sr-only" />
                    <div className={`relative w-[16px] h-[16px] rounded-[4px] border-2 flex-shrink-0 flex items-center justify-center transition-all duration-200 ${
                      sharedXP
                        ? "bg-gradient-to-br from-[var(--th-brand-mid)] to-[var(--th-brand-deep)] border-amber-600/50 shadow-[0_0_6px_color-mix(in_oklab,var(--th-brand)_40%,transparent),inset_0_1px_1px_rgba(255,255,255,0.08)]"
                        : "bg-[var(--th-n-deep)] border-[var(--th-line)]/100 group-hover:border-[var(--th-brand)]/80 group-hover:bg-[var(--th-bg-base)]"
                    }`}>
                      {sharedXP && (
                        <svg width="9" height="7" viewBox="0 0 10 8" fill="none" className="drop-shadow-sm">
                          <path d="M1.5 4L3.8 6.5L8.5 1.5" stroke="#f6c96e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      )}
                    </div>
                    <span className={`transition-colors duration-200 ${sharedXP ? "text-slate-200" : "text-slate-400 group-hover:text-slate-300"}`}>Shared XP</span>
                  </label>
                </CursorTooltip>
              </div>
            </div>

            {/* Card: Composição & Força */}
            <div className="col-span-1 sm:col-span-5 bg-[var(--th-n-base)] border border-[var(--th-line)]/80 rounded-xl p-2.5">
              <div className="flex items-center gap-1.5 text-[9px] font-bold text-red-400/80 uppercase tracking-wider mb-2">
                <Zap size={10} /> Composição & Força
              </div>
              <div className="flex items-center gap-2">
                <div className="flex gap-0.5 bg-black/30 rounded-lg border border-red-900/40 p-0.5">
                  <CursorTooltip text="Define automaticamente a composição ideal da PT com base nos personagens disponíveis.">
                    <button type="button" onClick={() => setSuggestionMode("inteligente")}
                      className={`px-2.5 py-1 rounded text-[9px] font-black cursor-pointer transition-all duration-200 ${suggestionMode === "inteligente" ? "bg-gradient-to-r from-amber-800/70 via-amber-700/45 to-red-950/60 border border-amber-500/35 text-amber-100 shadow-[0_0_12px_color-mix(in_oklab,var(--color-amber-500)_16%,transparent),inset_0_0_10px_color-mix(in_oklab,var(--color-amber-500)_8%,transparent)]" : "text-amber-300/85 border border-amber-700/20 bg-amber-950/15 hover:text-amber-100 hover:bg-gradient-to-r hover:from-amber-900/45 hover:to-red-950/35 hover:border-amber-600/35"}`}
                    >✨ IA (Auto)</button>
                  </CursorTooltip>
                  <CursorTooltip text="Permite configurar manualmente a composição da PT.">
                    <button type="button" onClick={() => { setSuggestionMode("personalizado"); if(templateType === "inteligente") setTemplateType("ideal"); }}
                      className={`px-2.5 py-1 rounded text-[9px] font-bold cursor-pointer transition-colors ${suggestionMode === "personalizado" ? "bg-red-900/40 text-red-200" : "text-slate-400 hover:text-slate-300 hover:bg-black/30"}`}
                    >Manual</button>
                  </CursorTooltip>
                </div>
                <div className="flex gap-0.5 bg-black/30 rounded-lg border border-red-900/40 p-0.5">
                  <CursorTooltip text="Prioriza personagens de level baixo.">
                    <button type="button" onClick={() => setStrength("low")}
                      className={`px-2 py-1 rounded text-[9px] font-bold transition-all cursor-pointer ${strength === "low" ? "bg-emerald-600 text-white" : "text-slate-400 hover:text-slate-300 hover:bg-black/30"}`}
                    >Baixo</button>
                  </CursorTooltip>
                  <CursorTooltip text="Prioriza personagens de level médio.">
                    <button type="button" onClick={() => setStrength("medium")}
                      className={`px-2 py-1 rounded text-[9px] font-bold transition-all cursor-pointer ${strength === "medium" ? "bg-amber-500 text-black" : "text-slate-400 hover:text-slate-300 hover:bg-black/30"}`}
                    >Médio</button>
                  </CursorTooltip>
                  <CursorTooltip text="Prioriza personagens de level alto.">
                    <button type="button" onClick={() => setStrength("high")}
                      className={`px-2 py-1 rounded text-[9px] font-bold transition-all cursor-pointer ${strength === "high" ? "bg-red-600 text-white" : "text-slate-400 hover:text-slate-300 hover:bg-black/30"}`}
                    >Alto</button>
                  </CursorTooltip>
                </div>
              </div>
            </div>

          </div>

          {/* Participantes — SEMPRE visível.
              A seleção é obrigatória, então o quadro não é mais condicional. */}
          {(
            <div className="bg-[var(--th-n-base)] border border-[var(--th-line)]/80 rounded-xl p-2.5">
              <div className="flex items-center gap-1.5 text-[9px] font-bold text-red-400/80 uppercase tracking-wider mb-2">
                <Users size={10} /> Participantes
              </div>
              <input
                type="text"
                value={userSearch}
                onChange={e => setUserSearch(e.target.value)}
                placeholder="Buscar usuário..."
                className="w-full bg-black/40 border border-red-900/40 rounded-lg px-2.5 py-1.5 text-[10px] text-white focus:outline-none focus:border-red-700/50 placeholder-slate-600 transition-colors mb-2"
              />
              <div className="flex flex-wrap gap-1 max-h-16 overflow-y-auto">
                {allDonos.filter(u => !userSearch || u.toLowerCase().includes(userSearch.toLowerCase())).map(u => {
                  const checked = selectedUsers.some(sel => sel.toLowerCase() === u.toLowerCase());
                  const isSelf = !!ownAuthorizedUser && u.toLowerCase() === ownAuthorizedUser.toLowerCase();
                  return (
                    <button key={u} type="button" onClick={() => handleToggleUser(u)} title={isSelf ? "Você sempre permanece selecionado nesta regra" : undefined}
                      className={`px-2 py-0.5 rounded text-[10px] font-medium transition-all border ${isSelf ? "cursor-not-allowed bg-amber-900/25 border-amber-600/45 text-amber-200" : checked ? "cursor-pointer bg-red-900/30 border-red-700/50 text-red-200" : "cursor-pointer bg-black/20 border-red-900/10 text-slate-400 hover:text-white hover:bg-black/30"}`}
                    >{isSelf ? `${u} (Você)` : u}</button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Composição Personalizada */}
          {suggestionMode === "personalizado" && (
            <div className="bg-[var(--th-n-base)] border border-[var(--th-line)]/80 rounded-xl p-2.5">
              <div className="flex items-center gap-1.5 text-[9px] font-bold text-red-400/80 uppercase tracking-wider mb-2">
                <Settings2 size={10} /> Composição Manual
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {(["EK", "ED", "MS", "RP", "MK"] as const).map(voc => (
                    <div key={voc} className="flex items-center gap-1 bg-black/30 border border-[var(--th-line)]/80 rounded-lg px-2 py-1">
                      <span className="text-[9px] font-bold" style={{ color: VOC_COLORS[voc] }}>{voc}</span>
                      <button type="button" onClick={() => handleCompositionChange(voc, -1)}
                        className="w-4 h-4 rounded bg-red-900/30 border border-red-800/40 text-red-300 hover:bg-red-800/40 flex items-center justify-center text-[9px] font-black cursor-pointer" disabled={customComposition[voc] === 0}>−</button>
                      <span className="text-[10px] font-bold text-white min-w-[14px] text-center">{customComposition[voc]}</span>
                      <button type="button" onClick={() => handleCompositionChange(voc, 1)}
                        className="w-4 h-4 rounded bg-emerald-900/30 border border-emerald-800/40 text-emerald-300 hover:bg-emerald-800/40 flex items-center justify-center text-[9px] font-black cursor-pointer">+</button>
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-[10px] font-bold ${Object.values(customComposition).reduce((a, b) => a + b, 0) === 5 ? "text-emerald-400" : "text-amber-400"}`}>
                    {Object.values(customComposition).reduce((a, b) => a + b, 0)}/5
                  </span>
                  <button type="button" onClick={handleApplyComposition} disabled={Object.values(customComposition).reduce((a, b) => a + b, 0) !== 5}
                    className={`px-2.5 py-1 rounded text-[9px] font-bold transition-all cursor-pointer ${Object.values(customComposition).reduce((a, b) => a + b, 0) === 5 ? applyFeedback ? "bg-emerald-700 text-white" : "bg-red-700 hover:bg-red-600 text-white" : "bg-black/20 border border-red-900/10 text-slate-500 cursor-not-allowed"}`}>
                    {applyFeedback ? "✓" : "Aplicar"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Grid: Níveis + Servidor + Quest/Visibilidade */}
          <div className="grid grid-cols-1 sm:grid-cols-12 gap-2">

            {/* Card: Nível Mínimo */}
            <div className="col-span-1 sm:col-span-5 bg-[var(--th-n-base)] border border-[var(--th-line)]/80 rounded-xl p-2.5">
              <div className="flex items-center gap-1.5 text-[9px] font-bold text-red-400/80 uppercase tracking-wider mb-2">
                <Target size={10} /> Nível Mínimo
              </div>
              <div className="flex items-center gap-1.5">
                {(["EK", "ED", "MS", "RP", "MK"] as const).map(voc => (
                  <div key={voc} className="flex items-center gap-1">
                    <span className="text-[9px] font-bold" style={{ color: VOC_COLORS[voc] }}>{voc}</span>
                    <input type="text" inputMode="numeric" value={minLevels[voc] ?? ""}
                      onChange={e => { const raw = e.target.value.replace(/\D/g, ""); const val = raw ? parseInt(raw, 10) : 0; setMinLevels(prev => ({ ...prev, [voc]: val })); }}
                      placeholder="0" className="w-10 text-center bg-black/40 border border-red-900/40 rounded px-1 py-1 text-[10px] font-bold tabular-nums text-white focus:outline-none focus:border-red-700/50" />
                  </div>
                ))}
              </div>
            </div>

            {/* Card: Servidor */}
            <div className="col-span-1 sm:col-span-3 bg-[var(--th-n-base)] border border-[var(--th-line)]/80 rounded-xl p-2.5">
              <div className="flex items-center gap-1.5 text-[9px] font-bold text-red-400/80 uppercase tracking-wider mb-2">
                <Server size={10} /> Servidor
              </div>
              <div ref={serverDropdownRef} className="relative">
                <button
                  type="button"
                  disabled={isSavingParty}
                  onClick={() => setServerDropdownOpen(prev => !prev)}
                  title={hasNoViableServer
                    ? "Nenhum servidor consegue formar uma PT com os filtros atuais. Ajuste os filtros para liberar a sugestão."
                    : serverMode === "auto"
                      ? "Servidor escolhido automaticamente entre os que formam PT com os filtros atuais"
                      : "Servidor selecionado manualmente"}
                  className={`w-full flex items-center justify-between gap-1.5 px-2.5 py-1.5 rounded-lg border text-[10px] focus:outline-none cursor-pointer transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed ${hasNoViableServer ? "border-rose-500 bg-rose-950/70 text-rose-200 font-black ring-2 ring-rose-500/60 ring-offset-1 ring-offset-[var(--th-n-base)] shadow-[0_0_18px_color-mix(in_oklab,var(--color-rose-500)_45%,transparent)] animate-pulse" : serverMode === "auto" ? "border-amber-500/35 bg-gradient-to-r from-amber-800/70 via-amber-700/45 to-red-950/60 text-amber-100 shadow-[0_0_12px_color-mix(in_oklab,var(--color-amber-500)_16%,transparent),inset_0_0_10px_color-mix(in_oklab,var(--color-amber-500)_8%,transparent)]" : "border-red-900/40 bg-black/40 text-white hover:border-red-700/60"}` }
                >
                  <span className="flex items-center gap-1 truncate">
                    {hasNoViableServer && <AlertTriangle size={11} className="flex-shrink-0 text-rose-300" />}
                    <span className="truncate">{serverMode === "auto" ? (hasNoViableServer ? autoServerLabel : `✨ ${autoServerLabel}`) : specificServer}</span>
                  </span>
                  <ChevronDown size={11} className={`text-slate-500 transition-transform duration-150 ${serverDropdownOpen ? "rotate-180 text-red-400" : ""}`} />
                </button>
                {serverDropdownOpen && (
                  <div className="absolute left-0 right-0 z-50 mt-1 max-h-48 overflow-y-auto rounded-lg border border-red-900/60 bg-[var(--th-n-raised)] shadow-2xl shadow-black/80">
                    <div
                      onClick={() => { setServerMode("auto"); setServerDropdownOpen(false); }}
                      className={`px-3 py-2 text-[10px] cursor-pointer transition-all border-b ${!aiSelectedServer ? "border-rose-600/60 bg-rose-950/60 text-rose-200 font-black" : serverMode === "auto" ? "bg-gradient-to-r from-amber-800/45 via-amber-900/25 to-red-950/45 border-amber-600/35 text-amber-100 font-black shadow-[inset_0_0_12px_color-mix(in_oklab,var(--color-amber-500)_10%,transparent)]" : "border-red-900/20 text-amber-200/90 bg-amber-950/15 hover:bg-gradient-to-r hover:from-amber-900/40 hover:to-red-950/30 hover:text-amber-100"}`}
                    >
                      ✨ {autoServerLabel}
                    </div>
                    {orderedServerOptions.map(srv => {
                      const count = serverCounts[srv] || 0;
                      const isSelected = serverMode === "specific" && specificServer === srv;
                      const potential = serverPotentials[srv] || { success: false, label: "", futurePTs: -1, templateQuality: 0, teamScore: 0, serverCandidatesCount: 0 };

                      const statusColorClass = potential.success
                        ? "text-emerald-400 font-bold"
                        : potential.label.startsWith("Falta")
                          ? "text-amber-400 font-bold"
                          : "text-rose-500/80";

                      return (
                        <div
                          key={srv}
                          onClick={() => { setServerMode("specific"); setSpecificServer(srv); setServerDropdownOpen(false); }}
                          className={`px-3 py-1.5 text-[10px] cursor-pointer transition-colors flex items-center justify-between gap-3 ${isSelected ? "bg-red-500/15 text-red-300 font-bold border-l-2 border-red-500" : "text-slate-300 hover:bg-red-500/5 hover:text-red-200"}`}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="truncate font-semibold">{srv}</span>
                            <span className="font-mono text-[9px] text-amber-500 font-black">[{String(count).padStart(2, "0")}]</span>
                          </div>
                          <span className={`text-[9px] font-bold uppercase tracking-wider flex-shrink-0 ${statusColorClass}`}>
                            {potential.label}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              {hasNoViableServer && (
                <div className="mt-1.5 flex items-start gap-1 text-[9px] font-bold leading-tight text-rose-300">
                  <AlertTriangle size={10} className="mt-[1px] flex-shrink-0" />
                  <span>Nenhum servidor forma PT com os filtros atuais.</span>
                </div>
              )}
            </div>

            {/* Card: Quest & Visibilidade (apenas se não há party) */}
            {!party && (
              <div className="col-span-1 sm:col-span-4 bg-[var(--th-n-base)] border border-[var(--th-line)]/80 rounded-xl p-2.5">
                <div className="flex items-center gap-3">
                  <div>
                    <div className="flex items-center gap-1 text-[9px] font-bold text-red-400/80 uppercase tracking-wider mb-2">
                      <Swords size={10} /> Quest
                    </div>
                    <div className="flex gap-0.5 bg-black/30 rounded-lg border border-red-900/40 p-0.5">
                      <CursorTooltip text="Quest Soulwar.">
                        <button type="button" onClick={() => setInternalPtType("soulwar")}
                          className={`px-2 py-1 rounded text-[9px] font-bold transition-all cursor-pointer ${internalPtType === "soulwar" ? "bg-slate-600 text-white" : "text-slate-400 hover:text-slate-300"}`}>SW</button>
                      </CursorTooltip>
                      <CursorTooltip text="Quest Sanguine.">
                        <button type="button" onClick={() => setInternalPtType("sanguine")}
                          className={`px-2 py-1 rounded text-[9px] font-bold transition-all cursor-pointer ${internalPtType === "sanguine" ? "bg-rose-700 text-white" : "text-slate-400 hover:text-slate-300"}`}>SG</button>
                      </CursorTooltip>
                    </div>
                  </div>
                  <div>
                    <div className="flex items-center gap-1 text-[9px] font-bold text-red-400/80 uppercase tracking-wider mb-2">
                      <Eye size={10} /> Visibilidade
                    </div>
                    <div className="flex gap-0.5 bg-black/30 rounded-lg border border-red-900/40 p-0.5">
                      <CursorTooltip text="A PT será criada como Pública.">
                        <button type="button" onClick={() => setVisibilityMode("public")}
                          disabled={!publicPartiesEnabled}
                          className={`inline-flex items-center gap-0.5 px-2 py-1 rounded text-[9px] font-bold transition-all ${!publicPartiesEnabled ? "text-slate-600 bg-slate-800/20 cursor-not-allowed" : internalVisibility === "public" ? "bg-emerald-700 text-white cursor-pointer" : "text-slate-400 hover:text-slate-300 cursor-pointer"}`}
                          title={!publicPartiesEnabled ? "Criação de PTs públicas pausada pelo administrador" : "A PT será criada como Pública"}>
                          <LockOpen size={9} /> Pub
                        </button>
                      </CursorTooltip>
                      <CursorTooltip text="A PT será criada como Privada.">
                        <button type="button" onClick={() => setVisibilityMode("private")}
                          className={`inline-flex items-center gap-0.5 px-2 py-1 rounded text-[9px] font-bold transition-all cursor-pointer ${internalVisibility === "private" ? "bg-violet-700 text-white" : "text-slate-400 hover:text-slate-300"}`}>
                          <Lock size={9} /> Priv
                        </button>
                      </CursorTooltip>
                    </div>
                  </div>
                </div>
              </div>
            )}

          </div>

          {/* Data/Horário (apenas se não há party) */}
          {!party && (
            <div className="grid grid-cols-1 sm:grid-cols-12 gap-2">
              <div className="col-span-1 sm:col-span-3 bg-[var(--th-n-base)] border border-[var(--th-line)]/80 rounded-xl p-2.5">
                <div className="flex items-center gap-1 text-[9px] font-bold text-red-400/80 uppercase tracking-wider mb-2">
                  <CalendarDays size={10} /> Data
                </div>
                <input type="date" value={internalDate} onChange={e => setInternalDate(e.target.value)}
                  className="w-full bg-black/40 border border-red-900/40 rounded-lg px-2 py-1.5 text-[10px] text-white focus:outline-none focus:border-red-700/50 [color-scheme:dark]" />
              </div>
              <div className="col-span-1 sm:col-span-3 bg-[var(--th-n-base)] border border-[var(--th-line)]/80 rounded-xl p-2.5">
                <div className="flex items-center gap-1 text-[9px] font-bold text-red-400/80 uppercase tracking-wider mb-2">
                  <Clock size={10} /> Horário
                </div>
                <input type="time" value={internalTime} onChange={e => setInternalTime(e.target.value)}
                  className="w-full bg-black/40 border border-red-900/40 rounded-lg px-2 py-1.5 text-[10px] text-white focus:outline-none focus:border-red-700/50 [color-scheme:dark]" />
              </div>
              <div className="col-span-1 sm:col-span-6 flex flex-col justify-end gap-1.5">
                {suggestionMode === "inteligente" && (
                  <button type="button" onClick={handleSuggestAnotherComposition} disabled={isCalculating || !nextAutoSuggestion?.success}
                    className="w-full px-4 py-1.5 rounded-xl bg-gradient-to-r from-amber-900/45 to-red-950/35 hover:from-amber-800/55 hover:to-red-900/45 text-amber-200 text-[10px] font-black flex items-center justify-center gap-1.5 transition-all cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed border border-amber-700/35 shadow-md shadow-black/20">
                    <Sparkles size={12} /> Sugerir Outra Composição
                  </button>
                )}
                <button type="button" onClick={handleRunSuggestion} disabled={isCalculating || hasNoViableServer}
                  title={hasNoViableServer ? "Nenhum servidor forma PT com os filtros atuais" : undefined}
                  className="w-full px-4 py-2 rounded-xl bg-gradient-to-r from-red-800 to-red-900 hover:from-red-700 hover:to-red-800 text-white text-[11px] font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer disabled:opacity-50 border border-red-700/50 shadow-lg shadow-red-950/40">
                  <RefreshCw size={13} className={isCalculating ? "animate-spin" : ""} />
                  {isCalculating ? "Calculando..." : "Sugerir PT"}
                </button>
              </div>
            </div>
          )}

          {/* Botão Sugerir PT (quando há party) */}
          {party && (
            <div className="space-y-1.5">
              {suggestionMode === "inteligente" && (
                <button type="button" onClick={handleSuggestAnotherComposition} disabled={isCalculating || !nextAutoSuggestion?.success}
                  className="w-full px-4 py-1.5 rounded-xl bg-gradient-to-r from-amber-900/45 to-red-950/35 hover:from-amber-800/55 hover:to-red-900/45 text-amber-200 text-[10px] font-black flex items-center justify-center gap-1.5 transition-all cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed border border-amber-700/35 shadow-md shadow-black/20">
                  <Sparkles size={12} /> Sugerir Outra Composição
                </button>
              )}
              <button type="button" onClick={handleRunSuggestion} disabled={isCalculating || hasNoViableServer}
                  title={hasNoViableServer ? "Nenhum servidor forma PT com os filtros atuais" : undefined}
                className="w-full px-4 py-2 rounded-xl bg-gradient-to-r from-red-800 to-red-900 hover:from-red-700 hover:to-red-800 text-white text-[11px] font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer disabled:opacity-50 border border-red-700/50 shadow-lg shadow-red-950/40">
                <RefreshCw size={13} className={isCalculating ? "animate-spin" : ""} />
                {isCalculating ? "Calculando..." : "Sugerir PT"}
              </button>
            </div>
          )}

          {/* Tabela de Resultado */}
          <div className="bg-[var(--th-n-base)] border border-[var(--th-line)]/80 rounded-xl overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 bg-gradient-to-r from-[var(--th-bg-raised)] to-[var(--th-bg-base)] border-b border-[var(--th-line)]/80">
              <h3 className="text-[10px] font-bold text-white flex items-center gap-1.5">
                <UserCheck size={12} className="text-red-400" />
                Resultado da Sugestão
              </h3>
              {liveCandidates.length > 0 && (
                <div className="flex items-center gap-1.5">
                  <span className="px-2 py-0.5 rounded bg-red-900/30 border border-red-800/40 text-[9px] font-bold text-red-300">{result?.templateName || "PT"}</span>
                  <span className="px-2 py-0.5 rounded bg-sky-900/30 border border-sky-800/40 text-[9px] font-bold text-sky-300">{result?.server}</span>
                  <span className="px-2 py-0.5 rounded bg-amber-900/30 border border-amber-800/40 text-[9px] font-bold text-amber-300">Lv {avgLevel}</span>
                  <span className={`px-2 py-0.5 rounded text-[9px] font-bold flex items-center gap-0.5 ${levelGapIndices.size === 0 ? "bg-emerald-900/30 border border-emerald-800/40 text-emerald-300" : "bg-rose-900/30 border border-rose-800/40 text-rose-300"}`}>
                    {levelGapIndices.size === 0 ? <Check size={9} /> : <X size={9} />} Share
                  </span>
                </div>
              )}
            </div>

            <div className="overflow-x-auto custom-scrollbar">
            <table className="w-full min-w-[760px] border-collapse text-left text-xs">
              <thead>
                <tr className="bg-[var(--th-n-base)] text-[9px] uppercase font-bold text-slate-400 tracking-wider">
                  <th className="px-3 py-2 w-8 text-center">#</th>
                  <th className="px-3 py-2 text-center">Conta</th>
                  <th className="px-3 py-2">Personagem</th>
                  <th className="px-3 py-2">Servidor</th>
                  <th className="px-3 py-2 text-center">Voc</th>
                  <th className="px-3 py-2 text-center">Level</th>
                  <th className="px-3 py-2">Dono</th>
                  <th className="px-3 py-2 text-center w-[120px]">Ajuste</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-red-900/10 font-medium">
                {isCalculating ? (
                  <tr>
                    <td colSpan={8} className="py-12 text-center text-slate-400 space-y-2">
                      <RefreshCw size={24} className="animate-spin text-red-500 mx-auto" />
                      <span className="block text-[10px] font-medium">Calculando permutações...</span>
                    </td>
                  </tr>
                ) : result && !result.success ? (
                  <tr>
                    <td colSpan={8} className="py-10 px-6 text-center space-y-2">
                      <ShieldAlert size={28} className="text-amber-500 mx-auto" />
                      <span className="block text-xs font-bold text-white">Não foi possível montar a PT</span>
                      <p className="text-[10px] text-slate-400 max-w-md mx-auto leading-relaxed whitespace-pre-line">{result.errorMessage || "Não há personagens suficientes."}</p>
                    </td>
                  </tr>
                ) : liveCandidates.length > 0 ? (
                  liveCandidates.map((cand, i) => {
                    const isCarrier = liveCarriers.includes(i);
                    // Só as posições 4 e 5 trocam de vocação; EK/ED/RP no topo são fixos.
                    const isFixedSlot = i < FIXED_SLOT_COUNT;
                    const vocAlternatives = vocationAlternativesBySlot[i] || [];
                    const swapData = computeSwapData(cand, i);
                    const hasStronger = !!swapData.stronger;
                    const hasWeaker = !!swapData.weaker;
                    const accountCell = getCandidateAccountCell(cand);
                    // DONO de Service SEM Serviceiro designado: o valor da coluna
                    // cai no CLIENTE do cadastro (ownerName) — pessoa de fora,
                    // sem conta no aplicativo. Mesma lógica que monta `dono`
                    // (resolveServiceResponsible), reutilizada — nada novo aqui.
                    const serviceClientOwner = cand.type === "waiting"
                      && !resolveServiceResponsible((cand.rawObj as WaitingService).addedBy);
                    const accountCellId = `suggest-account-${cand.id}-${i}`;
                    const characterCellId = `suggest-character-${cand.id}-${i}`;
                    return (
                      <tr key={cand.id + i} className={`hover:bg-red-900/5 transition-colors ${isCarrier ? "bg-emerald-900/10" : ""}`}>
                        <td className={`px-3 py-2 text-center font-mono font-bold w-8 ${isCarrier ? "text-emerald-400" : "text-slate-400"}`}>
                          <span className="inline-flex items-center gap-1">
                            {isCarrier && <span title="Carregador" className="text-[9px]">★</span>}
                            {i + 1}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-center whitespace-nowrap">
                          <button
                            type="button"
                            onClick={event => copyCell(event, accountCellId, accountCell.value)}
                            className={`group inline-flex max-w-[150px] items-center gap-1 rounded px-1 py-0.5 text-[10px] font-medium transition-colors cursor-copy ${
                              copiedCellId === accountCellId
                                ? "bg-emerald-500/20 text-emerald-300"
                                : accountCell.ownAccount
                                  ? "text-slate-100 hover:bg-white/10 hover:text-white"
                                  : accountCell.serviceClient
                                    ? "text-cyan-300 hover:bg-cyan-500/10 hover:text-cyan-200"
                                    : "text-slate-400 hover:bg-white/10 hover:text-slate-200"
                            }`}
                            title={copiedCellId === accountCellId
                              ? "Copiado!"
                              : accountCell.serviceClient
                                ? `Copiar cliente "${accountCell.value}"`
                                : accountCell.ownAccount
                                  ? `Copiar sua conta "${accountCell.value}"`
                                  : `Copiar identificador "${accountCell.value}"`}
                          >
                            {copiedCellId === accountCellId ? (
                              <><Check size={11} className="flex-shrink-0 text-emerald-400" /><span>Copiado!</span></>
                            ) : (
                              <>
                                <span className="truncate">{accountCell.value}</span>
                                <Copy size={10} className="flex-shrink-0 opacity-0 group-hover:opacity-70 transition-opacity" />
                                {accountCell.serviceClient && <span className="text-[7px] font-black uppercase tracking-wide text-cyan-500/80">Cliente</span>}
                              </>
                            )}
                          </button>
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <button
                            type="button"
                            onClick={event => copyCell(event, characterCellId, cand.rawObj.personagem)}
                            className={`group inline-flex max-w-[190px] items-center gap-1 rounded px-1 py-0.5 font-bold transition-colors cursor-copy ${
                              copiedCellId === characterCellId
                                ? "bg-emerald-500/20 text-emerald-300"
                                : "text-white hover:bg-white/10 hover:text-white"
                            }`}
                            title={copiedCellId === characterCellId ? "Copiado!" : `Copiar "${cand.rawObj.personagem}"`}
                          >
                            {copiedCellId === characterCellId ? (
                              <><Check size={12} className="flex-shrink-0 text-emerald-400" /><span>Copiado!</span></>
                            ) : (
                              <>
                                <span className="truncate">{cand.rawObj.personagem}</span>
                                <Copy size={11} className="flex-shrink-0 opacity-0 group-hover:opacity-70 transition-opacity" />
                              </>
                            )}
                          </button>
                          {cand.type === "waiting" && <span className="ml-1 px-1 py-0.5 rounded bg-cyan-900/30 text-cyan-400 text-[7px] font-mono border border-cyan-800/40">Svc</span>}
                        </td>
                        <td className="px-3 py-2 text-slate-300 text-[10px]">{cand.servidor}</td>
                        <td className="px-3 py-2 text-center">
                          <div className="flex items-center justify-center gap-1">
                            {/* Vocação atual: elemento PRINCIPAL da coluna. */}
                            <span className="relative inline-flex items-center justify-center flex-shrink-0">
                              <span
                                className="px-2 py-[3px] rounded-md text-[10px] font-black tracking-widest leading-none"
                                style={{
                                  // Cor viva: a cor da vocação clareada em oklab, preservando
                                  // a identidade de cada uma e funcionando nos 7 temas.
                                  color: `color-mix(in oklab, ${VOC_COLORS[cand.voc]} 55%, white)`,
                                  backgroundColor: `color-mix(in oklab, ${VOC_COLORS[cand.voc]} 32%, transparent)`,
                                  border: `1px solid color-mix(in oklab, ${VOC_COLORS[cand.voc]} 75%, white 25%)`,
                                  boxShadow: `0 0 10px color-mix(in oklab, ${VOC_COLORS[cand.voc]} 40%, transparent), inset 0 1px 1px rgba(255,255,255,0.10)`,
                                  textShadow: `0 0 8px color-mix(in oklab, ${VOC_COLORS[cand.voc]} 55%, transparent)`,
                                }}
                                title={isFixedSlot ? `Posição fixa: ${cand.voc}` : cand.voc}
                              >{cand.voc}</span>
                              {isFixedSlot && (
                                <Lock size={8} className="absolute -right-2.5 text-slate-600" aria-label="Posição fixa" />
                              )}
                            </span>
                            {/* Trocas: à DIREITA da vocação, na mesma linha.
                                Cores vivas da própria vocação de destino e aparência
                                clicável (fundo + borda sólida), mas em corpo menor que
                                o selo principal — destacam sem competir. */}
                            {!isFixedSlot && vocAlternatives.length > 0 && (
                              <span className="flex items-center gap-0.5">
                                {vocAlternatives.map(alt => (
                                  <button
                                    key={alt.voc}
                                    type="button"
                                    onClick={() => handleSwapVocation(i, alt.voc)}
                                    title={`Trocar para ${alt.voc}: ${alt.candidate.rawObj.personagem} (level ${alt.candidate.level})`}
                                    aria-label={`Trocar a posição ${i + 1} para ${alt.voc}`}
                                    className="px-1 py-[2px] rounded text-[8px] font-black tracking-wide leading-none border transition-all duration-150 cursor-pointer opacity-85 hover:opacity-100 hover:-translate-y-[1px] active:translate-y-0 active:scale-95"
                                    style={{
                                      color: `color-mix(in oklab, ${VOC_COLORS[alt.voc]} 60%, white)`,
                                      backgroundColor: `color-mix(in oklab, ${VOC_COLORS[alt.voc]} 22%, transparent)`,
                                      borderColor: `color-mix(in oklab, ${VOC_COLORS[alt.voc]} 65%, transparent)`,
                                      boxShadow: `0 0 6px color-mix(in oklab, ${VOC_COLORS[alt.voc]} 25%, transparent)`,
                                    }}
                                  >{alt.voc}</button>
                                ))}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className={`px-3 py-2 text-center font-mono font-bold tabular-nums text-[11px] ${isCarrier ? "text-emerald-400" : "text-slate-300"}`}>
                          {cand.level}
                        </td>
                        <td className="px-3 py-2 max-w-[100px] text-[10px]">
                          {serviceClientOwner ? (
                            /* Cliente do Service: nome da pessoa de FORA (não é
                               usuário do app). Visual distinto dos donos reais —
                               ciano itálico + selo no MESMO padrão de "Svc" da
                               coluna ao lado / "Service" do PartyPanel. */
                            <span
                              className="flex min-w-0 items-center gap-1"
                              title={`${cand.dono} — cliente do Service (dono do personagem), não é um usuário do aplicativo`}
                            >
                              <span className="min-w-0 truncate font-medium italic text-cyan-300/90">{cand.dono}</span>
                              <span className="flex-shrink-0 rounded border border-cyan-800/40 bg-cyan-900/30 px-1 py-0.5 font-mono text-[7px] font-black uppercase tracking-wide text-cyan-400">Cliente</span>
                            </span>
                          ) : (
                            <span className="block truncate font-medium text-sky-300">{cand.dono}</span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-center">
                          <div className="flex items-center justify-center gap-0.5">
                            <button type="button" disabled={!hasStronger} onClick={() => handleSwapStronger(i)}
                              className={`px-1.5 py-0.5 rounded text-[8px] font-bold border transition-all flex items-center gap-0.5 cursor-pointer disabled:opacity-20 disabled:cursor-not-allowed ${hasStronger ? "bg-emerald-900/30 border-emerald-800/40 text-emerald-400 hover:bg-emerald-800/40" : "bg-black/20 border-red-900/10 text-slate-500"}`}>
                              <ChevronUp size={9} /> +
                            </button>
                            <button type="button" disabled={!hasWeaker} onClick={() => handleSwapWeaker(i)}
                              className={`px-1.5 py-0.5 rounded text-[8px] font-bold border transition-all flex items-center gap-0.5 cursor-pointer disabled:opacity-20 disabled:cursor-not-allowed ${hasWeaker ? "bg-rose-900/30 border-rose-800/40 text-rose-400 hover:bg-rose-800/40" : "bg-black/20 border-red-900/10 text-slate-500"}`}>
                              <ChevronDown size={9} /> −
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan={8} className="py-12 px-6 text-center space-y-2">
                      <Sparkles size={24} className="text-red-900/50 mx-auto" />
                      <span className="block text-xs font-bold text-slate-300">Aguardando Sugestão</span>
                      <p className="text-[10px] text-slate-500">Configure os filtros e clique em <strong className="text-red-400">Sugerir PT</strong>.</p>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            </div>
          </div>

        </div>

        {/* Footer */}
        <div className="app-modal-footer px-3 py-2.5 bg-gradient-to-r from-[var(--th-bg-raised)] to-[var(--th-bg-base)] border-t border-[var(--th-line)]/80 flex flex-wrap items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-[var(--th-line)]/100 hover:bg-[var(--th-line)]/20 text-slate-300 hover:text-white text-[10px] font-semibold transition-colors cursor-pointer">
            <Ban size={12} /> Cancelar
          </button>
          <button type="button" onClick={handleSave} disabled={liveCandidates.length === 0 || isCalculating || isSavingParty}
            className="inline-flex items-center gap-1 px-4 py-1.5 rounded-lg bg-gradient-to-r from-[var(--th-brand-mid)] to-[var(--th-line)] hover:from-[var(--th-brand-bright)] hover:to-[var(--th-line-strong)] text-white font-bold text-[10px] transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed border border-[var(--th-brand-mid)]/60">
            {isSavingParty ? <RefreshCw size={12} className="animate-spin" /> : <Save size={12} />} {isSavingParty ? "Aguardando PT..." : "Salvar/Criar PT"}
          </button>
        </div>

      </div>
    </div>
  );
}