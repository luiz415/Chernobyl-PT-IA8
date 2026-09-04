import { useCallback, useMemo, useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { isServiceOpenToAnyone } from "../utils/serviceVisibility";
import ConfirmModal from "./ConfirmModal";
import PausePartyModal from "./PausePartyModal";
import {
  cooldownRemainingMs,
  findQuestBoss,
  formatCooldownRemaining,
  questBossLabel,
} from "../constants/questBosses";
import type { QuestBoss } from "../constants/questBosses";
import { ArrowDown, ArrowUp, ArrowUpDown, Plus, Minus, X, UserPlus, ExternalLink, Play, Clock, Pencil, Check, Lock, Users, Tv, Handshake } from "lucide-react";
import type { Character, CharacterAcquisition, PartyFinalizationReason, PartyTab, PartyCustomMember, PartySlotData, Vocation, WaitingService } from "../types";
import { getCharacterAccountKey, hasAccountConflictWith } from "../utils/accountIdentity";
import { resolveSplitBeneficiaryCandidate, buildResolvedUidPatch, type SplitBeneficiaryContext } from "../utils/splitBeneficiary";
import { classifyDroppedItems } from "../utils/profitClassification";
import { buildPauseBossState, clearPartyPauseState } from "../utils/partyPauseState";
import { canAddCharacterToParty, getPartyParticipation } from "../utils/partyPermissions";
import { VOCATIONS, VOC_COLORS, formatRC, customAlert, customConfirm } from "../types";
import { doc, setDoc, onSnapshot } from "firebase/firestore";
import { db } from "../firebase/config";
import { useAuth } from "../context/AuthContext";
import { UserFilter, type ToggleState } from "./FilterTypes";
import AvailableCharacter, { type OtherPartyInfo } from "./AvailableCharacter";
import ServersPyramidChart from "./ServerGraphic";
import WaitingServiceAvailableList from "./ServiceList";
import CharacterAcquisitionModal, { type CharacterAcquisitionModalContext } from "./CharacterAcquisitionModal";
import CharacterAcquisitionPaymentModal, { type CharacterAcquisitionPaymentModalContext } from "./CharacterAcquisitionPaymentModal";
import { openExternalUrl } from "../utils/openExternal";
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
import { SERVER_OPTIONS, isSameServer, serverLabel } from "../constants/servers";
// SuggestPartyModal removido: o botão "Sugerir PT" foi movido para o
// PartyManager, então o modal não é mais invocado a partir deste arquivo.
// Lista oficial centralizada em src/constants/servers.ts
const CREATE_PT_SERVERS = SERVER_OPTIONS;

/** Para quem vai a participação da divisão. */
export type SplitTarget = "owner" | "player";

export interface ExtendedPartySlotData extends PartySlotData {
  paidByUid?: string;
  paidByName?: string;
  paidAt?: number;
  // ── DESTINATÁRIO DA DIVISÃO ───────────────────────────────────────────────
  // Quando DONO e JOGADOR são pessoas diferentes, é preciso saber para quem
  // vai a participação. O usuário escolhe no modal ao marcar DIVIDIR.
  //
  // Ausente (`undefined`) = PTs antigas e o caso DONO == JOGADOR, em que não
  // há ambiguidade. Nesses casos `resolveSplitRecipient` cai no dono, que é
  // exatamente o comportamento que sempre existiu — por isso nenhuma PT
  // existente muda de resultado.
  splitTarget?: SplitTarget;
  /** Nome do destinatário no instante da escolha (histórico legível). */
  splitTargetName?: string;
  // Mini-calculadora kk -> RC
  calcRateKk?: number;  // Campo 1 ("kk>RC"): taxa em k que equivale a 1000 RC
  calcTotalKk?: number; // Campo 2 ("kk"): valor total em kk a ser convertido
  calcLocked?: boolean; // Legado: trava a edição da calculadora e do campo RC
  calcRateKkLocked?: boolean;
  calcTotalKkLocked?: boolean;
  itemVendidoLocked?: boolean;
}

interface Props {
  party: PartyTab;
  characters: Character[];
  waitingList: WaitingService[];
  allParties: PartyTab[];
  userName: string;
  onUpdate: (party: PartyTab) => void;
  /** Grava a PT imediatamente e confirma. Ver `persistPartyNow` no App. */
  onPersistPartyNow?: (party: PartyTab) => Promise<boolean>;
  onDelete: () => void;
  onSaveParty?: (party: PartyTab) => void;
  onPaymentMarked?: (info: { partyId: string; partyName: string; paidBy: string; amount: number; ownerUid?: string }) => void;
  onNotifyMembers?: (party: PartyTab) => void;
  /** Pedido durável: a Function valida e finaliza sem depender do navegador aberto. */
  onRequestFinalization?: (party: PartyTab, reason: PartyFinalizationReason) => Promise<{ ok: boolean; requestId?: string; error?: string }>;
  onRefresh?: () => Promise<void>;
  /** Negociações ativas/históricas visíveis para os envolvidos na PT. */
  characterAcquisitions?: CharacterAcquisition[];
  onCreateCharacterAcquisition?: (input: {
    partyId: string;
    characterId: string;
    originalCharacterCost: number;
    personalFee: 0 | 25 | 50;
  }) => Promise<{ ok: boolean; error?: string }>;
  onConfirmCharacterAcquisitionPayment?: (acquisitionId: string) => Promise<{ ok: boolean; error?: string }>;
}

type SortDir = "asc" | "desc" | null;

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

function usePersistedState<T>(key: string, initial: T) {
  const [val, setVal] = useState<T>(() => {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : initial; } catch { return initial; }
  });
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} }, [key, val]);
  return [val, setVal] as const;
}

const defaultSlotData = (): PartySlotData => ({ deaths: 0, drop: 0, itemDropado: "", itemVendido: 0, player: "", split: false, owner: "", notes: "", pago: false, dropLocked: false });

// ============================================================================
// FINALIZAÇÃO POR BACKEND — TRADUÇÃO DOS ERROS DA CLOUD FUNCTION
// ----------------------------------------------------------------------------
// A Function `finalizePartyHistory` grava `lastError` com códigos estáveis no
// documento da solicitação. Este mapa devolve uma mensagem acionável para o
// usuário final, em vez de deixar a PT "não finalizada" sem explicação.
// ============================================================================
const FINALIZATION_OBSERVER_TIMEOUT_MS = 90_000;

function describeFinalizationError(rawError: string): string {
  const code = String(rawError || "").split(":")[0].trim();
  switch (code) {
    case "stale_settlement_revision":
      return "Os dados desta PT foram alterados depois que esta tela foi carregada. A tela já foi atualizada automaticamente — tente finalizar novamente.";
    case "split_beneficiary_missing":
      return "Há um membro com DIVIDIR marcado sem destinatário identificado. Desmarque a divisão ou selecione um usuário válido na coluna JOGADOR antes de finalizar.";
    case "split_payment_pending":
      return "Realize o pagamento de todos os membros com DIVIDIR marcado antes de finalizar.";
    case "split_item_value_missing":
      return "Algum item da divisão ainda está sem valor de venda. Preencha o valor antes de finalizar.";
    case "late_participant_not_original":
      return "A PT contém um participante que não fazia parte do congelamento original. Recarregue a PT e tente novamente; se o problema persistir, contate o suporte.";
    case "requester_not_authorized":
      return "Somente o Líder da PT ou um Boss pode solicitar a finalização.";
    case "financial_rights_record_mismatch":
      return "A negociação de um personagem desta PT diverge do registro original. Verifique a negociação vinculada ao slot antes de finalizar.";
    case "party_not_found":
      return "A PT não foi encontrada no servidor — ela pode já ter sido finalizada por outro dispositivo.";
    case "quest_not_completed":
      return "A Quest desta PT precisa estar concluída para a finalização por pagamento.";
    case "quest_failure_not_confirmed":
      return "A PT não está marcada como falha. Confirme a falha antes de encerrá-la.";
    case "invalid_finalization_request":
      return "A solicitação de finalização era inválida (PT, usuário ou motivo ausentes).";
    case "invalid_party":
      return "Os dados desta PT estão inconsistentes para a finalização automática.";
    default:
      return `A finalização foi rejeitada pelo backend (${rawError || "erro desconhecido"}).`;
  }
}

// ============================================================================
// MINI-CALCULADORA kk -> RC
// Calcula o valor em RC a partir de uma taxa (kk>RC) e um total (kk).
// Fórmula: floor((total / rate) * 1000)  -> arredonda para baixo ao INTEIRO.
// O resultado NÃO é mais forçado a múltiplo de 25: essa regra vale apenas
// para a DIVISÃO entre participantes (ver `roundSplitTo25`), nunca para o
// valor individual da venda do item.
// Ex: rate=75, total=340 -> (340/75)*1000 = 4533.33 -> floor = 4533
// Ex: rate=2.5, total=0.3446 -> 137.84 -> floor = 137
// ============================================================================
function computeItemRC(rateKk: number, totalKk: number): number {
  if (!Number.isFinite(rateKk) || rateKk <= 0) return 0;
  if (!Number.isFinite(totalKk) || totalKk <= 0) return 0;
  const raw = (totalKk / rateKk) * 1000;
  return Math.floor(raw);
}

// ============================================================================
// ENTRADA DO PREÇO DO RC (kk>RC) COM UMA CASA DECIMAL
// ----------------------------------------------------------------------------
// O campo aceita valores como "1", "1,5", "2,3" (vírgula pt-BR; ponto também é
// tolerado na digitação e normalizado para vírgula). Apenas UMA casa decimal.
// `parseRateKk` converte o texto exibido para o número EXATO usado no cálculo
// (vírgula -> ponto), sem truncamento.
// ============================================================================
function sanitizeRateKkInput(raw: string): string {
  const unified = String(raw || "").replace(/[^\d.,]/g, "").replace(/\./g, ",");
  const firstComma = unified.indexOf(",");
  if (firstComma === -1) return unified;
  const intPart = unified.slice(0, firstComma);
  const decPart = unified.slice(firstComma + 1).replace(/,/g, "").slice(0, 1);
  return `${intPart},${decPart}`;
}
function parseRateKk(raw: string): number {
  const n = parseFloat(String(raw || "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : 0;
}
/** Texto exibido para um `calcRateKk` persistido (número -> vírgula pt-BR). */
function formatRateKkDisplay(value: number | undefined): string {
  if (!value) return "";
  return String(value).replace(".", ",");
}

// ============================================================================
// ARREDONDAMENTO PARA MÚLTIPLO DE 25 (sempre para BAIXO)
// ----------------------------------------------------------------------------
// Devolve o maior múltiplo de 25 menor ou igual ao valor recebido.
//   1767 -> 1750 · 1774 -> 1750 · 1775 -> 1775
//   1799 -> 1775 · 1800 -> 1800 · 1812 -> 1800
//
// Extraído de `computeItemRC` (que já aplicava exatamente esta regra) para ser
// reutilizado também no valor individual da divisão, sem duplicar a lógica.
//
// Valores inválidos ou negativos devolvem 0: um valor individual negativo não
// tem significado na divisão e arredondá-lo "para baixo" só o afastaria mais.
// ============================================================================
// ============================================================================
// DESTINATÁRIO DA DIVISÃO
// ----------------------------------------------------------------------------
// DONO e JOGADOR podem ser pessoas diferentes (personagem emprestado, Service,
// membro externo). Nesses casos a participação precisa ter um destinatário
// explícito — quem de fato recebe os RC daquela cota.
//
// COMPATIBILIDADE (o ponto mais delicado desta mudança):
// `splitTarget` ausente cai em "owner". Isso reproduz exatamente o
// comportamento anterior, em que a divisão sempre era atribuída ao dono. PTs
// existentes, snapshots e registros já gravados continuam com o MESMO
// resultado — nada é reinterpretado retroativamente.
// ============================================================================

/** Nome do DONO de um slot, com as quedas usadas no restante do painel. */
export function getSlotOwnerName(slot: ExtendedPartySlotData | undefined, fallback = ""): string {
  return String(slot?.owner || "").trim() || fallback;
}

/** Nome do JOGADOR de um slot. Sem jogador definido, o dono responde. */
export function getSlotPlayerName(slot: ExtendedPartySlotData | undefined, fallback = ""): string {
  const player = String(slot?.player || "").trim();
  if (player) return player;
  return getSlotOwnerName(slot, fallback);
}

/**
 * DONO e JOGADOR são pessoas diferentes?
 *
 * Comparação sem caixa e sem espaços nas pontas — a mesma normalização que o
 * painel já usa ao casar nomes de usuário. Slot sem jogador definido NÃO é
 * ambíguo (o jogador é o próprio dono).
 */
export function hasDistinctOwnerAndPlayer(slot: ExtendedPartySlotData | undefined): boolean {
  const owner = getSlotOwnerName(slot).toLowerCase();
  const player = String(slot?.player || "").trim().toLowerCase();
  if (!owner || !player) return false;
  return owner !== player;
}

/**
 * Para quem vai a participação: "owner" (padrão) ou "player".
 *
 * Só devolve "player" quando a escolha foi explicitamente gravada E os nomes
 * de fato divergem. Se o jogador mudar depois e passar a coincidir com o dono,
 * a ambiguidade deixa de existir e o dono volta a responder.
 */
export function resolveSplitTarget(slot: ExtendedPartySlotData | undefined): SplitTarget {
  if (slot?.splitTarget === "player" && hasDistinctOwnerAndPlayer(slot)) return "player";
  return "owner";
}

/** Nome de quem recebe a participação da divisão. */
export function resolveSplitRecipient(slot: ExtendedPartySlotData | undefined, fallback = ""): string {
  return resolveSplitTarget(slot) === "player"
    ? getSlotPlayerName(slot, fallback)
    : getSlotOwnerName(slot, fallback);
}

export function floorTo25(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value / 25) * 25;
}

// ============================================================================
// ARREDONDAMENTO DA DIVISÃO ENTRE PARTICIPANTES (múltiplo de 25, corte em 10)
// ----------------------------------------------------------------------------
// Regra EXCLUSIVA do valor individual da DIVISÃO (nunca do valor da venda do
// item, que usa floor simples ao inteiro em `computeItemRC`):
//
//   • Se FALTAREM mais de 10 unidades para alcançar o múltiplo de 25
//     imediatamente superior -> arredonda para BAIXO (múltiplo inferior);
//   • Se faltarem 10 ou menos -> arredonda para CIMA (múltiplo superior).
//
// Exemplos normativos do produto:
//   389 -> 375  (faltam 11 para 400 -> baixo)
//   390 -> 400  (faltam 10 para 400 -> cima)
//   375 -> 375  (já é múltiplo)
// ============================================================================
export function roundSplitTo25(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const lower = Math.floor(value / 25) * 25;
  const excess = value - lower;
  if (excess === 0) return lower;
  return (25 - excess) <= 10 ? lower + 25 : lower;
}

// ============================================================================
// FORMATAÇÃO DE VALORES EM k / kk
// ----------------------------------------------------------------------------
// Mantém o padrão numérico do aplicativo (pt-BR: milhar com ".", decimal com
// ","), o mesmo de `formatRC`. Casas decimais só aparecem quando existem:
//   159 -> "159kk" · 56.25 -> "56,25kk" · 843.75 -> "843,75kk"
//
// O SUFIXO é parâmetro porque as duas grandezas do resumo têm unidades
// diferentes, e trocá-las falsearia o documento:
//   • valor de VENDA do item ...... kk  (ex.: 159kk)
//   • COTAÇÃO do RC ............... k   (ex.: 93k — quantos k valem 1000 RC)
// O nome do campo `calcRateKk` sugere "kk", mas o próprio comentário da
// interface o define como "taxa em k que equivale a 1000 RC" — ou seja, a
// unidade correta da cotação é `k`.
//
// Os campos da calculadora são inteiros hoje, mas a formatação tolera decimais
// para não truncar silenciosamente caso um valor fracionário chegue.
// ============================================================================
export function formatKk(value: number, suffix: "k" | "kk" = "kk"): string {
  if (!Number.isFinite(value)) return `0${suffix}`;
  const rounded = Math.round(value * 100) / 100;
  const text = Number.isInteger(rounded)
    ? rounded.toLocaleString("de-DE")
    : rounded.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${text}${suffix}`;
}

const SOULWAR_ITEMS = [
  "Soulbleeder", "Soulkamas", "Soulshredder", "Pair of Soulwalkers", "Soulshell",
  "Pair of Soulstalkers", "Souleater", "Soulmaimer", "Soultainter", "Soulmantle",
  "Soulgarb", "Soulhexer", "Soulcrusher", "Soulshanks", "Soulstrider",
  "Soulsoles", "Soulcutter", "Soulpiercer", "Soulshroud", "Soulbastion", "Soulbiter",
];

const SANGUINE_ITEMS = [
  "Grand Sanguine Bow", "Grand Sanguine Crossbow", "Grand Sanguine Rod",
  "Grand Sanguine Coil", "Grand Sanguine Claws", "Grand Sanguine Blade",
  "Grand Sanguine Battleaxe", "Grand Sanguine Bludgeon", "Grand Sanguine Razor",
  "Grand Sanguine Hatchet", "Grand Sanguine Cudgel",
  "Sanguine Bow", "Sanguine Legs", "Sanguine Greaves", "Sanguine Coil",
  "Sanguine Razor", "Sanguine Claws", "Sanguine Rod", "Sanguine Trousers",
  "Sanguine Boots", "Sanguine Galoshes", "Sanguine Bludgeon", "Sanguine Blade",
  "Sanguine Crossbow", "Sanguine Battleaxe", "Sanguine Hatchet", "Sanguine Cudgel",
];

const ITEM_COLORS: Record<string, string> = {
  "Soulbleeder": "#22c55e", "Soulkamas": "#22c55e", "Soulshredder": "#22c55e",
  "Pair of Soulwalkers": "#4ade80", "Soulshell": "#4ade80",
  "Pair of Soulstalkers": "#86efac", "Souleater": "#86efac", "Soulmaimer": "#86efac",
  "Soultainter": "#a3e635", "Soulmantle": "#a3e635", "Soulgarb": "#a3e635",
  "Soulhexer": "#eab308", "Soulcrusher": "#eab308",
  "Soulshanks": "#f97316", "Soulstrider": "#f97316", "Soulsoles": "#f97316",
  "Soulcutter": "#ef4444", "Soulpiercer": "#ef4444",
  "Soulshroud": "#dc2626", "Soulbastion": "#dc2626", "Soulbiter": "#dc2626",
  "Grand Sanguine Bow": "#fbbf24", "Grand Sanguine Crossbow": "#fbbf24",
  "Grand Sanguine Rod": "#fbbf24", "Grand Sanguine Coil": "#fbbf24",
  "Grand Sanguine Claws": "#fbbf24", "Grand Sanguine Blade": "#fbbf24",
  "Grand Sanguine Battleaxe": "#fbbf24", "Grand Sanguine Bludgeon": "#fbbf24",
  "Grand Sanguine Razor": "#fbbf24", "Grand Sanguine Hatchet": "#fbbf24",
  "Grand Sanguine Cudgel": "#fbbf24",
  "Sanguine Bow": "#22c55e",
  "Sanguine Legs": "#22c55e",
  "Sanguine Greaves": "#4ade80",
  "Sanguine Coil": "#4ade80",
  "Sanguine Razor": "#86efac",
  "Sanguine Claws": "#86efac",
  "Sanguine Rod": "#a3e635",
  "Sanguine Trousers": "#a3e635",
  "Sanguine Boots": "#eab308",
  "Sanguine Galoshes": "#eab308",
  "Sanguine Bludgeon": "#f97316",
  "Sanguine Blade": "#f97316",
  "Sanguine Crossbow": "#ef4444",
  "Sanguine Battleaxe": "#ef4444",
  "Sanguine Hatchet": "#dc2626",
  "Sanguine Cudgel": "#dc2626",
};

function ItemSelect({ value, onChange, ptType, disabled = false }: { value: string; onChange: (v: string) => void; ptType?: "soulwar" | "sanguine"; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0, maxHeight: 200 });
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const items = ptType === "sanguine" ? SANGUINE_ITEMS : SOULWAR_ITEMS;

  function updateMenuPosition() {
    if (!wrapRef.current) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom - 12;
    const spaceAbove = rect.top - 12;
    const maxHeight = Math.max(140, Math.min(240, Math.max(spaceBelow, spaceAbove)));
    const openUp = spaceBelow < 180 && spaceAbove > spaceBelow;
    setMenuPos({
      top: openUp ? Math.max(8, rect.top - maxHeight - 4) : rect.bottom + 4,
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 228)),
      maxHeight,
    });
  }

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const target = e.target as Node;
      if (wrapRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  useEffect(() => {
    if (!open) return;
    updateMenuPosition();
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
    return () => {
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [open]);

  const selectedColor = ITEM_COLORS[value] || "#e2e8f0";
  const isSelected = !!value && items.includes(value);

  return (
    <div ref={wrapRef} className="relative min-w-[110px]">
      <button
        type="button"
        disabled={disabled}
        onClick={(e) => { if (disabled) return; e.stopPropagation(); updateMenuPosition(); setOpen(prev => !prev); }}
        style={isSelected ? { color: selectedColor, fontWeight: 600 } : undefined}
        className={`w-full min-w-[100px] bg-transparent border-b border-white/10 hover:border-cyan-500/50 ${open ? "border-cyan-500/50" : ""} outline-none px-1 py-1 text-[11px] text-left cursor-pointer transition-colors ${isSelected ? "" : "text-slate-600"} ${disabled ? "opacity-40 cursor-not-allowed bg-black/30" : ""}`}
        title={disabled ? "Drop salvo permanentemente — não pode ser alterado" : undefined}
      >
        {value || "Item..."}
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          className="fixed z-[500] w-[220px] overflow-auto bg-[var(--th-n-hi)] border border-white/10 rounded-lg shadow-2xl shadow-black/60"
          style={{ top: menuPos.top, left: menuPos.left, maxHeight: menuPos.maxHeight }}
        >
          <div
            onClick={() => { onChange(""); setOpen(false); }}
            className="px-2 py-1.5 text-[11px] cursor-pointer hover:bg-rose-500/15 transition-colors text-rose-400 font-bold border-b border-white/10 flex items-center gap-1"
          >
            <X size={11} /> Limpar
          </div>
          {items.map(item => (
            <div
              key={item}
              onClick={() => { onChange(item); setOpen(false); }}
              className={`px-2 py-1.5 text-[11px] cursor-pointer hover:bg-white/10 transition-colors ${item === value ? "bg-white/10 font-bold" : ""}`}
              style={{ color: ITEM_COLORS[item] || "#94a3b8" }}
            >
              {item}
            </div>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}

/**
 * Exibição do WhatsApp do cliente de Service (+55 31 999…).
 * Mesmo formato do helper das guias de Services — declarado no módulo para
 * não recriar a função a cada render.
 */
function formatWhatsDisplay(service: WaitingService): string {
  const country = (service.whatsappCountry || "").trim();
  const area = (service.whatsappArea || "").trim();
  const number = (service.whatsappNumber || "").trim();
  if (!number) return "";
  return `+${country} ${area} ${number}`.trim();
}

export default function PartyPanel({ party, characters, waitingList, allParties, userName, onUpdate, onPersistPartyNow, onDelete, onSaveParty, onRequestFinalization, onRefresh, characterAcquisitions = [], onCreateCharacterAcquisition, onConfirmCharacterAcquisitionPayment }: Props) {
  const { currentUser, userProfile, allUsers, acceptedFriendUids } = useAuth();
  const [showAddCustom, setShowAddCustom] = useState(false);
  // Estado `showSuggestModal` removido junto com o botão "Sugerir PT" — esse
  // fluxo agora vive no PartyManager.tsx (criação de PT a partir da sugestão).
  const [showEditInvites, setShowEditInvites] = useState(false);
  const [inviteSearch, setInviteSearch] = useState("");
  const [whatsappCopied, setWhatsappCopied] = useState(false);

  // ── Mensagens pré-programadas do WhatsApp (CLIENTE de Service) ────────────
  // Mesma preferência individual das guias "Meus Services"/"Services"
  // (localStorage por UID — compartilhada entre os três lugares). No
  // PartyPanel o seletor só abre quando o destinatário é o CLIENTE de um
  // personagem de Service (slot "waiting", identificado pelo mesmo critério
  // que já decide o telefone exibido); para USUÁRIOS do próprio app o botão
  // segue abrindo o wa.me direto, sem modal.
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
  const [copiedCharId, setCopiedCharId] = useState<string | null>(null);
  // Feedback "copiado" da coluna CONTA. Mesmo padrão do nome do personagem.
  const [copiedAccountId, setCopiedAccountId] = useState<string | null>(null);
  const [showTransferLeader, setShowTransferLeader] = useState(false);
  const [tempInvites, setTempInvites] = useState<string[]>([]);
  const [editingServer, setEditingServer] = useState(false);
  const [serverValue, setServerValue] = useState("");
  const [showEditHorario, setShowEditHorario] = useState(false);
  const [editDataValue, setEditDataValue] = useState<string>("");
  const [editHoraValue, setEditHoraValue] = useState<string>("");
  const [customForm, setCustomForm] = useState<Omit<PartyCustomMember, "id">>({ label: "", ownerName: "", servidor: "", voc: "EK", level: 0, soulwar: true, sanguine: true });
  const [isFinalizationRequested, setIsFinalizationRequested] = useState(false);
  // ── OBSERVAÇÃO DO COMANDO DE FINALIZAÇÃO ────────────────────────────────
  // Listener + timer do documento `partyFinalizationRequests/{requestId}`
  // criado por `requestBackendFinalization`. Mantidos em refs para permitir
  // troca de solicitação (nova tentativa) e limpeza na desmontagem.
  const finalizationUnsubscribeRef = useRef<(() => void) | null>(null);
  const finalizationTimeoutRef = useRef<number | null>(null);
  const finalizationObserverActiveRef = useRef(false);

  // Estado para armazenar WhatsApp dos donos (ownerUid -> phone string formatado)
  // Estado para armazenar o personagem principal dos donos (ownerUid -> mainCharacterName)
  // Estado para armazenar o canal da Twitch dos donos (ownerUid -> twitchChannel URL)

  // Estado para modal de confirmação de pagamento (PG)
  const [paymentConfirmData, setPaymentConfirmData] = useState<{
    slotId: string;
    ownerName: string;
    ownerUid: string;
    value: number;
    mainCharName: string;
    charName: string;
  } | null>(null);
  const [pgCopied, setPgCopied] = useState(false);
  // Modal de escolha do destinatário da divisão. Aberto SOMENTE quando DONO e
  // JOGADOR são pessoas diferentes. Sem opção pré-selecionada: `null` até o
  // usuário decidir, e cancelar deixa DIVIDIR desmarcado.
  const [splitTargetPrompt, setSplitTargetPrompt] = useState<{
    slotId: string;
    ownerName: string;
    playerName: string;
  } | null>(null);
  // A negociação usa exclusivamente DONO/JOGADOR já persistidos no slot da PT.
  // Nenhum usuário é digitado ou escolhido manualmente neste fluxo.
  const [characterSalePrompt, setCharacterSalePrompt] = useState<{
    characterId: string;
    characterName: string;
    server: string;
    vocation: string;
    level: number;
    originalOwnerName: string;
    acquirerName: string;
    detectedOriginalCost: number | null;
  } | null>(null);
  const [acquisitionPaymentPrompt, setAcquisitionPaymentPrompt] = useState<CharacterAcquisition | null>(null);

  const [slotNotesDrafts, setSlotNotesDrafts] = useState<Record<string, string>>({});
  // Drafts da mini-calculadora kk -> RC (Campo 1 = rate, Campo 2 = total)
  const [calcRateKkDrafts, setCalcRateKkDrafts] = useState<Record<string, string>>({});
  const [calcTotalKkDrafts, setCalcTotalKkDrafts] = useState<Record<string, string>>({});
  // Controla qual campo da calculadora está focado (para exibir/ocultar o sufixo k/kk)
  const [calcFocused, setCalcFocused] = useState<{ id: string; field: "rate" | "total" } | null>(null);
  // Draft do campo RC editável manualmente (quando a calculadora não está ativa)
  const [rcDrafts, setRcDrafts] = useState<Record<string, string>>({});
  const partyRef = useRef(party);
  const debounceTimersRef = useRef<Record<string, number>>({});

  useEffect(() => {
    partyRef.current = party;
  }, [party]);

  useEffect(() => {
    return () => {
      Object.values(debounceTimersRef.current).forEach((timer) => window.clearTimeout(timer));
    };
  }, []);

  function clearDebounce(key: string) {
    const timer = debounceTimersRef.current[key];
    if (timer) {
      window.clearTimeout(timer);
      delete debounceTimersRef.current[key];
    }
  }

  function scheduleDebounce(key: string, fn: () => void) {
    clearDebounce(key);
    debounceTimersRef.current[key] = window.setTimeout(() => {
      delete debounceTimersRef.current[key];
      fn();
    }, 5000);
  }

  function updatePartyPatch(patch: Partial<PartyTab>) {
    const latestParty = partyRef.current;
    onUpdate({ ...latestParty, ...patch });
  }

  function commitServerValue(raw: string) {
    const trimmed = raw.trim();
    if (trimmed && trimmed !== (partyRef.current.servidor || "")) {
      updatePartyPatch({ servidor: trimmed });
    }
  }

  // Commit da mini-calculadora kk -> RC.
  // Recebe os valores brutos dos Campos 1 (rate) e 2 (total), calcula o RC
  // (arredondado para baixo ao múltiplo de 25 mais próximo) e grava tudo no
  // slotData: calcRateKk, calcTotalKk e o itemVendido final (para que Totais,
  // Divisão e botão PG continuem funcionando normalmente).
  function commitCalcDrafts(id: string, rateRaw: string, totalRaw: string) {
    // kk>RC aceita UMA casa decimal ("2,5") — o valor persistido/calculado é
    // exatamente o digitado (vírgula -> ponto), sem truncar.
    const rateNum = parseRateKk(rateRaw);
    const totalNum = parseInt(totalRaw.replace(/[^\d]/g, ""), 10) || 0;
    const computedRC = computeItemRC(rateNum, totalNum);
    const cur = getSD(id) as ExtendedPartySlotData;
    const patch: Partial<ExtendedPartySlotData> = {};
    if ((cur.calcRateKk || 0) !== rateNum) patch.calcRateKk = rateNum;
    if ((cur.calcTotalKk || 0) !== totalNum) patch.calcTotalKk = totalNum;
    // Sempre sincroniza o itemVendido com o valor calculado
    if ((cur.itemVendido || 0) !== computedRC) patch.itemVendido = computedRC;
    if (Object.keys(patch).length > 0) {
      setSD(id, patch);
    }
    setCalcRateKkDrafts(prev => { const next = { ...prev }; delete next[id]; return next; });
    setCalcTotalKkDrafts(prev => { const next = { ...prev }; delete next[id]; return next; });
  }

  // Commit do campo RC editável manualmente (quando a calculadora kk não está ativa)
  function commitRcDraft(id: string, raw: string) {
    const cleaned = raw.replace(/[^\d]/g, "");
    const nextValue = parseInt(cleaned, 10) || 0;
    if ((getSD(id).itemVendido || 0) !== nextValue) {
      setSD(id, { itemVendido: nextValue });
    }
    setRcDrafts(prev => { const next = { ...prev }; delete next[id]; return next; });
  }

  function commitSlotNotesDraft(id: string, nextValue: string) {
    if ((getSD(id).notes || "") !== nextValue) {
      setSD(id, { notes: nextValue });
    }
    setSlotNotesDrafts(prev => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  // ============================================================================
  // OPTIMIZAÇÃO: Usar allUsers do AuthContext em vez de listener duplicado
  // ============================================================================
  const approvedUsers = useMemo(() => {
    return allUsers.filter(u => u.status === "aprovado").map(u => ({ uid: u.uid, nome: u.nome }));
  }, [allUsers]);

  useEffect(() => {
    if (showEditInvites) {
      setTempInvites(party.invitedUsers || [currentUser?.uid || ""]);
    }
  }, [showEditInvites, party.invitedUsers, currentUser?.uid]);

  function saveInvites() {
    const oldList = party.invitedUsers || [];
    const finalInvited = Array.from(new Set([...tempInvites, currentUser?.uid].filter(Boolean)));

    const removedUids = oldList.filter(uid => !finalInvited.includes(uid) && uid !== currentUser?.uid);

    let newSelectedIds = [...party.selectedIds];
    const newSd = { ...(party.slotData || {}) };

    if (removedUids.length > 0) {
      const charIdsToRemove = new Set<string>();

      newSelectedIds.forEach(id => {
        const ch = characters.find(c => c.id === id);
        if (ch && ch.ownerUid && removedUids.includes(ch.ownerUid)) {
          charIdsToRemove.add(id);
        } else {
          const wt = waitingList.find(w => w.id === id);
          if (wt && (wt as any).ownerUid && removedUids.includes((wt as any).ownerUid)) {
            charIdsToRemove.add(id);
          } else if (newSd[id] && newSd[id].ownerUid && removedUids.includes(newSd[id].ownerUid!)) {
            charIdsToRemove.add(id);
          }
        }
      });

      newSelectedIds = newSelectedIds.filter(id => !charIdsToRemove.has(id));

      charIdsToRemove.forEach(id => {
        delete newSd[id];
      });
    }

    onUpdate({
      ...party,
      invitedUsers: finalInvited,
      selectedIds: newSelectedIds,
      slotData: newSd,
    });

    setShowEditInvites(false);
  }

  // Listener para buscar dados de WhatsApp, personagem principal e Twitch dos usuários do Firestore.
  // Coleta UIDs tanto de donos (ownerUid) quanto de jogadores (player → allUsers → uid).
  // ============================================================================
  // OPTIMIZAÇÃO: Usar allUsers do AuthContext em vez de queries individuais
  // ============================================================================
  const ownerPhoneMap = useMemo(() => {
    const map: Record<string, string> = {};
    const uids = new Set<string>();
    Object.values(party.slotData || {}).forEach((slot: any) => {
      if (slot?.ownerUid) uids.add(slot.ownerUid);
      if (slot?.player) {
        const playerUser = allUsers.find(u => u.nome.toLowerCase() === slot.player.toLowerCase());
        if (playerUser?.uid) uids.add(playerUser.uid);
      }
    });
    uids.forEach(uid => {
      const user = allUsers.find(u => u.uid === uid);
      if (user) {
        const phone = `${user.whatsappCountry || ""}${user.whatsappRegion || ""}${user.whatsappNumber || ""}`.replace(/\D/g, "");
        if (phone) map[uid] = phone;
      }
    });
    return map;
  }, [party.slotData, allUsers]);

  const ownerMainCharMap = useMemo(() => {
    const map: Record<string, string> = {};
    const uids = new Set<string>();
    Object.values(party.slotData || {}).forEach((slot: any) => {
      if (slot?.ownerUid) uids.add(slot.ownerUid);
      // O destinatário da DIVISÃO pode ser o JOGADOR (ou o beneficiário
      // explícito da participação) — sem os UIDs deles aqui, o modal de
      // pagamento não encontrava o personagem principal do participante e
      // exibia "A definir" mesmo com o cadastro correto.
      if (slot?.playerUid) uids.add(slot.playerUid);
      if (slot?.splitBeneficiaryUid) uids.add(slot.splitBeneficiaryUid);
      if (slot?.financialRightsHolderUid) uids.add(slot.financialRightsHolderUid);
      if (slot?.player) {
        const playerUser = allUsers.find(u => u.nome.toLowerCase() === slot.player.toLowerCase());
        if (playerUser?.uid) uids.add(playerUser.uid);
      }
    });
    uids.forEach(uid => {
      const user = allUsers.find(u => u.uid === uid);
      if (user) map[uid] = user.mainCharacterName || "";
    });
    return map;
  }, [party.slotData, allUsers]);

  const ownerTwitchMap = useMemo(() => {
    const map: Record<string, string> = {};
    const uids = new Set<string>();
    Object.values(party.slotData || {}).forEach((slot: any) => {
      if (slot?.ownerUid) uids.add(slot.ownerUid);
      if (slot?.player) {
        const playerUser = allUsers.find(u => u.nome.toLowerCase() === slot.player.toLowerCase());
        if (playerUser?.uid) uids.add(playerUser.uid);
      }
    });
    uids.forEach(uid => {
      const user = allUsers.find(u => u.uid === uid);
      if (user) map[uid] = user.twitchChannel || "";
    });
    return map;
  }, [party.slotData, allUsers]);

  function formatHorario(p: PartyTab): string {
    if (!p.horarioTimestamp) return "Sem hora marcada";
    return new Date(p.horarioTimestamp).toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  }

  function openEditHorario() {
    const d = new Date();
    let initData = d.toISOString().slice(0, 10);
    let initHora = "";

    if (party.horarioTimestamp) {
      const ts = new Date(party.horarioTimestamp);
      initData = ts.toLocaleDateString("sv-SE");
      initHora = ts.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    }

    setEditDataValue(initData);
    setEditHoraValue(initHora);
    setShowEditHorario(true);
  }

  function saveEditHorario() {
    const h = editHoraValue.trim();
    let newTimestamp: number | undefined;

    if (h) {
      const datePart = editDataValue || new Date().toISOString().slice(0, 10);
      newTimestamp = new Date(`${datePart}T${h}:00`).getTime();
    }

    onUpdate({
      ...party,
      horarioTimestamp: newTimestamp,
      horarioChangedBy: userName || "Anônimo",
      horarioChangedAt: Date.now(),
    });
    setShowEditHorario(false);
  }
  const [panelWidths, setPanelWidths] = usePersistedState<{ p1: number; p2: number; p3: number }>(`pt_panels_global_${currentUser?.uid || userName || "default"}`, { p1: 38, p2: 16, p3: 46 });
  const [draggingPanel, setDraggingPanel] = useState<"left" | "right" | null>(null);
  const panelsRef = useRef<HTMLDivElement>(null);

  // --- Inline confirmation state ---
  const [confirmingButton, setConfirmingButton] = useState<string | null>(null);
  const confirmTimeoutRef = useRef<number | null>(null);

  function requestConfirm(buttonId: string, action: () => void) {
    if (confirmingButton === buttonId) {
      if (confirmTimeoutRef.current) window.clearTimeout(confirmTimeoutRef.current);
      setConfirmingButton(null);
      action();
    } else {
      if (confirmTimeoutRef.current) window.clearTimeout(confirmTimeoutRef.current);
      setConfirmingButton(buttonId);
      confirmTimeoutRef.current = window.setTimeout(() => {
        setConfirmingButton(null);
      }, 4000);
    }
  }

  useEffect(() => { return () => { if (confirmTimeoutRef.current) window.clearTimeout(confirmTimeoutRef.current); }; }, []);

  // Gravando o snapshot dos participantes ao concluir a Quest. Trava o botão
  // para não disparar duas conclusões concorrentes.
  const [isConcludingQuest, setIsConcludingQuest] = useState(false);

  /**
   * Snapshot de UM participante, montado no MOMENTO DA INCLUSÃO.
   *
   * A partir daqui o participante é uma entidade da própria PT: nada em
   * `sharedCharacters` / `sharedServices` / lista pessoal é necessário para
   * reconstruí-lo depois.
   *
   * PRIVACIDADE: `account` recebe o CÓDIGO MASCARADO, nunca o nome real da
   * conta. A PT é um documento compartilhado — qualquer participante a lê. O
   * dono continua vendo o nome real porque ele o resolve localmente pela
   * própria lista (ver `ownCharacterAccountById`), que não sai do dispositivo.
   * O WhatsApp do cliente de Service também NÃO entra aqui.
   */
  function buildSnapshotForMember(
    id: string,
    ch: Character | undefined,
    wt: WaitingService | undefined,
  ): Character | null {
    if (ch) {
      // `account` vai MASCARADO (privacidade). Como o nome real não sobrevive,
      // gravamos `accountKey` — a identidade (`ownerUid + nome`) que permite
      // detectar "mesma conta" depois, sem expor o nome a ninguém.
      return { ...ch, account: accountLabelFor(ch), accountKey: getCharacterAccountKey(ch) };
    }
    if (wt) {
      return {
        id: wt.id,
        account: "",
        personagem: wt.personagem,
        servidor: wt.servidor,
        voc: wt.voc,
        level: wt.level,
        soulwar: wt.quest === "soulwar",
        sanguine: wt.quest === "sanguine",
        ownerUid: (wt as any).ownerUid || wt.createdBy,
        ownerName: wt.ownerName,
        // Service não tem conta real: identidade única por Service.
        accountKey: `service:${wt.id}`,
        valorPago: 0,
        dropSW: 0,
        dropBakra: 0,
        valorVenda: 0,
        vendido: false,
        notes: wt.notes,
        createdAt: wt.createdAt || Date.now(),
        updatedAt: Date.now(),
      };
    }
    void id;
    return null;
  }

  // Snapshot persistente dos personagens usados na PT.
  // O PartyPanel resolve o nome do personagem em tempo real via `characters.find(...)`.
  // Ao arquivar, o Histórico precisa ser autossuficiente; por isso gravamos o
  // snapshot em `memberSnapshots`, estrutura já existente na PartyTab.
  function buildMemberSnapshotsForArchive(sourceParty: PartyTab): Record<string, Character> {
    const snapshots: Record<string, Character> = { ...(sourceParty.memberSnapshots || {}) };
    (sourceParty.selectedIds || []).forEach(id => {
      const ch = characters.find(c => c.id === id);
      if (ch) {
        // PRIVACIDADE: o nome real da conta NUNCA entra no snapshot. A PT é um
        // documento compartilhado — qualquer participante a lê —, então gravar
        // `account` ali exporia a conta do dono a todos, para sempre.
        //
        // Guardamos o CÓDIGO MASCARADO no lugar. Assim a coluna CONTA continua
        // mostrando o mesmo rótulo de hoje depois da conclusão (em vez de cair
        // para "—"), sem vazar nada: o código é só um apelido posicional.
        //
        // O proprietário não perde nada: ele resolve o nome real localmente
        // pela própria lista de personagens (ver `ownCharacterAccountById`),
        // que nunca sai do dispositivo dele.
        snapshots[id] = { ...ch, account: accountLabelFor(ch), accountKey: getCharacterAccountKey(ch) };
        return;
      }

      const wt = waitingList.find(w => w.id === id);
      if (wt) {
        snapshots[id] = {
          id: wt.id,
          account: "",
          personagem: wt.personagem,
          servidor: wt.servidor,
          voc: wt.voc,
          level: wt.level,
          soulwar: wt.quest === "soulwar",
          sanguine: wt.quest === "sanguine",
          ownerUid: (wt as any).ownerUid || wt.createdBy,
          ownerName: wt.ownerName,
          valorPago: 0,
          dropSW: 0,
          dropBakra: 0,
          valorVenda: 0,
          vendido: false,
          notes: wt.notes,
          createdAt: wt.createdAt || Date.now(),
          updatedAt: Date.now(),
        };
        return;
      }

      // ÚLTIMA LINHA DE DEFESA: o personagem já sumiu das duas coleções e não
      // há snapshot anterior. Em vez de deixar o participante sem registro,
      // reconstruímos o mínimo a partir do próprio slot, que é dado da PT e
      // sempre existe. Melhor um participante identificado pelo dono/jogador
      // do que um slot fantasma.
      if (!snapshots[id]) {
        const slot = (sourceParty.slotData || {})[id];
        snapshots[id] = {
          id,
          account: "",
          personagem: "",
          servidor: sourceParty.servidor || "",
          voc: "EK",
          level: 0,
          soulwar: sourceParty.ptType === "soulwar",
          sanguine: sourceParty.ptType === "sanguine",
          ownerUid: slot?.ownerUid,
          ownerName: slot?.owner || "",
          valorPago: 0,
          dropSW: 0,
          dropBakra: 0,
          valorVenda: 0,
          vendido: false,
          notes: "",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
      }
    });
    return snapshots;
  }

  async function requestBackendFinalization(reason: PartyFinalizationReason) {
    if (!onRequestFinalization) {
      customAlert("A finalização segura por backend ainda não está disponível neste ambiente.", "Finalização indisponível");
      return;
    }
    if (isFinalizationRequested) return;
    setIsFinalizationRequested(true);
    let accepted = false;
    try {
      const result = await onRequestFinalization(partyRef.current, reason);
      if (!result.ok) {
        customAlert(result.error || "Não foi possível solicitar a finalização da PT.", "Finalização não solicitada");
        return;
      }
      accepted = true;
      if (result.requestId) {
        // Observa o documento do comando durável até o backend concluir (ou
        // rejeitar). Sem isto, qualquer falha de validação na Cloud Function
        // ficava invisível: a solicitação era criada, a Function gravava
        // `state: "failed"` + `lastError` e ninguém lia — a PT simplesmente
        // "não finalizava", sem qualquer aviso ao usuário.
        observeFinalizationRequest(result.requestId, reason);
        return;
      }
      customAlert(
        reason === "quest_failed"
          ? "A falha foi enviada para processamento seguro. A PT será movida ao histórico pelo backend."
          : "A finalização foi enviada para processamento seguro. A PT será movida ao histórico quando o backend concluir a validação.",
        "Processamento iniciado",
      );
    } finally {
      // Sem observador ativo, mantém apenas a janela curta contra duplo
      // clique. Com observador, o estado só é liberado quando o backend
      // responde (concluído, rejeitado ou timeout).
      if (!accepted) setIsFinalizationRequested(false);
      else if (!finalizationObserverActiveRef.current) {
        window.setTimeout(() => setIsFinalizationRequested(false), 3000);
      }
    }
  }

  /**
   * Acompanha em tempo real o documento `partyFinalizationRequests/{requestId}`
   * criado por este painel. A Cloud Function `finalizePartyHistory` atualiza
   * `state` para "completed" ou "failed" dentro da própria transação — este
   * listener apenas reflete o resultado para o usuário:
   *
   *   • completed → confirma e a PT sai da lista de ativas (deletada no mesmo
   *     instante, atomicamente com os históricos/arquivo/notificações);
   *   • failed    → exibe o motivo legível e libera o botão para nova tentativa;
   *   • timeout   → o backend não respondeu (Function indisponível, deploy
   *     ausente ou indisponibilidade) — a solicitação PERMANECE na fila e
   *     será processada quando o backend voltar.
   */
  function observeFinalizationRequest(requestId: string, reason: PartyFinalizationReason) {
    stopFinalizationObserver();
    finalizationObserverActiveRef.current = true;

    const finish = (notify: () => void) => {
      stopFinalizationObserver();
      setIsFinalizationRequested(false);
      notify();
    };

    finalizationTimeoutRef.current = window.setTimeout(() => {
      if (!finalizationObserverActiveRef.current) return;
      finish(() => {
        customAlert(
          "A finalização foi solicitada, mas o backend ainda não respondeu.\n\n"
          + "A solicitação permanece na fila e será processada assim que as Cloud Functions estiverem disponíveis. "
          + "Se a PT continuar ativa após alguns minutos, verifique a conexão e o deploy das Cloud Functions.",
          "Aguardando o backend",
        );
      });
    }, FINALIZATION_OBSERVER_TIMEOUT_MS);

    finalizationUnsubscribeRef.current = onSnapshot(
      doc(db, "partyFinalizationRequests", requestId),
      snapshot => {
        if (!finalizationObserverActiveRef.current) return;
        if (!snapshot.exists()) return;
        const data = (snapshot.data() || {}) as Record<string, unknown>;
        const state = String(data.state || "");
        if (state === "completed") {
          finish(() => {
            customAlert(
              reason === "quest_failed"
                ? "A PT foi encerrada como falha e movida para o histórico de todos os participantes."
                : "A PT foi finalizada com sucesso! Cada participante recebeu uma notificação e já pode consultar a PT no Histórico de PT's.",
              "Finalização concluída",
            );
          });
        } else if (state === "failed") {
          finish(() => {
            customAlert(
              describeFinalizationError(String(data.lastError || "")),
              "Finalização não concluída",
            );
          });
        }
      },
      () => {
        // Falha de leitura do documento (ex.: regra do Firestore sem permissão
        // de leita/escuta nesta coleção). A solicitação JÁ FOI criada e o
        // backend continua processando mesmo sem acompanhamento.
        if (!finalizationObserverActiveRef.current) return;
        finish(() => {
          customAlert(
            "A finalização foi enviada ao backend, mas não foi possível acompanhar o andamento da solicitação.\n\n"
            + "Aguarde alguns instantes e verifique se a PT saiu da lista de ativas (ou apareceu no Histórico).",
            "Acompanhamento indisponível",
          );
        });
      },
    );
  }

  function stopFinalizationObserver() {
    finalizationObserverActiveRef.current = false;
    if (finalizationUnsubscribeRef.current) {
      finalizationUnsubscribeRef.current();
      finalizationUnsubscribeRef.current = null;
    }
    if (finalizationTimeoutRef.current !== null) {
      window.clearTimeout(finalizationTimeoutRef.current);
      finalizationTimeoutRef.current = null;
    }
  }

  // Libera listener e timer quando o painel desmonta (ex.: a PT foi deletada
  // pelo backend após a finalização, ou o usuário trocou de aba/PT).
  useEffect(() => () => stopFinalizationObserver(), []);

  // ── TEMPO EFETIVO DA PT (descontando as pausas) ─────────────────────────
  //
  // Antes era `agora - ptStartedAt`, o que somava todo o tempo pausado.
  //
  // Agora o tempo é `accumulatedMs + (agora - ptStartedAt)`:
  //   • ao PAUSAR  → `accumulatedMs += agora - ptStartedAt` e `ptStartedAt`
  //                  deixa de contar (a PT está pausada);
  //   • ao RETOMAR → `ptStartedAt = agora`, e o acumulado é preservado.
  //
  // Como os dois campos ficam na PT (Firestore), o valor continua correto
  // depois de fechar o app, e é o mesmo para todos os participantes.
  /** Tempo efetivo da PT num dado instante, já sem os períodos pausados. */
  function computeEffectiveMs(source: PartyTab, nowMs: number): number {
    const accumulated = source.accumulatedMs || 0;
    // Pausada ou sem início: só o que já foi acumulado.
    if (source.isPaused || !source.ptStartedAt) return accumulated;
    return accumulated + Math.max(0, nowMs - source.ptStartedAt);
  }

  // ── PAUSAR / RETOMAR ────────────────────────────────────────────────────
  const [isPauseModalOpen, setIsPauseModalOpen] = useState(false);

  // Relógio do cooldown. O cálculo parte sempre de um término salvo na PT,
  // nunca de contador local. A exibição só existe enquanto a pausa atual está
  // ativa; retomar limpa todos os campos para um refresh não ressuscitar badge.
  const [cooldownNow, setCooldownNow] = useState(() => Date.now());
  const cooldownEndsAt = party.cooldownEndsAt || 0;
  const cooldownIgnored = party.cooldownIgnored === true;
  useEffect(() => {
    if (!party.isPaused || cooldownIgnored || !cooldownEndsAt) return;
    setCooldownNow(Date.now());
    if (cooldownEndsAt <= Date.now()) return;
    const timer = window.setInterval(() => setCooldownNow(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, [party.isPaused, cooldownIgnored, cooldownEndsAt]);

  /** Dados do Boss da pausa atual. `null` assim que a PT é retomada. */
  const cooldownInfo = useMemo(() => {
    if (!party.isPaused) return null;
    const boss = findQuestBoss(party.pausedBossId);
    if (!boss) return null;
    const label = questBossLabel(party.pausedBossId) || boss.name;
    if (cooldownIgnored) {
      return {
        label,
        bossName: boss.name,
        remaining: 0,
        isDone: true,
        ignored: true,
        endsAt: 0,
      };
    }
    if (!cooldownEndsAt) return null;
    const remaining = cooldownRemainingMs(cooldownEndsAt, cooldownNow);
    return {
      label,
      bossName: boss.name,
      remaining,
      isDone: remaining <= 0,
      ignored: false,
      endsAt: cooldownEndsAt,
    };
  }, [party.isPaused, party.pausedBossId, cooldownIgnored, cooldownEndsAt, cooldownNow]);

  /**
   * Congela o tempo efetivo antes da pausa. `ignoreCooldown` é válido somente
   * para este Boss/pausa e não altera o catálogo normal de cooldowns.
   */
  function confirmPause(boss: QuestBoss | null, ignoreCooldown: boolean) {
    setIsPauseModalOpen(false);
    const now = Date.now();
    const latest = partyRef.current;
    onUpdate({
      ...latest,
      isPaused: true,
      accumulatedMs: computeEffectiveMs(latest, now),
      ...buildPauseBossState(boss, now, ignoreCooldown),
    });
  }

  /**
   * Retomar encerra a pausa anterior e zera o badge/cooldown persistido.
   * Uma pausa posterior monta um estado novo, independente da anterior.
   */
  function resumeParty() {
    onUpdate(clearPartyPauseState(partyRef.current, Date.now()));
  }

  // --- PT Timer ---
  const [elapsedMs, setElapsedMs] = useState(() => {
    if (party.questConcluida && party.ptDuration) return party.ptDuration;
    return computeEffectiveMs(party, Date.now());
  });
  const ptTimerRef = useRef<number | null>(null);

  useEffect(() => {
    // Recalcula na hora sempre que o estado relevante muda (pausar, retomar,
    // concluir) — sem esperar o próximo tique.
    setElapsedMs(computeEffectiveMs(party, Date.now()));

    // O intervalo só existe enquanto a PT está REALMENTE correndo. Pausada,
    // não há timer algum rodando — nada a recalcular por segundo.
    if (party.ptStartedAt && !party.questConcluida && !party.isPaused) {
      ptTimerRef.current = window.setInterval(() => {
        setElapsedMs(computeEffectiveMs(partyRef.current, Date.now()));
      }, 1000);
    }
    return () => { if (ptTimerRef.current) window.clearInterval(ptTimerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [party.ptStartedAt, party.questConcluida, party.isPaused, party.accumulatedMs]);

  function formatDuration(ms: number): string {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    if (h <= 0) return `${m}m`;
    return `${h}h${m}m`;
  }

  function sendDropValueSavedNotifications(updatedParty: PartyTab) {
    const questLabel = updatedParty.ptType === "sanguine" ? "SANGUINE" : "SOULWAR";
    const memberUids = new Set<string>();
    if (currentUser?.uid) memberUids.add(currentUser.uid);
    (updatedParty.members || []).forEach(uid => { if (uid) memberUids.add(uid); });
    Object.values(updatedParty.slotData || {}).forEach((slot: any) => {
      if (slot?.ownerUid) memberUids.add(slot.ownerUid);
    });

    memberUids.forEach(async (uid) => {
      // Não notifica a própria pessoa remetente
      if (currentUser?.uid && uid === currentUser.uid) return;
      try {
        const notifId = "notif_" + Date.now() + Math.random().toString(36).slice(2);
        await setDoc(doc(db, "notifications", notifId), {
          id: notifId,
          userId: uid,
          senderName: userName,
          type: "pt_updated",
          title: "🔄 Itens e Valores Atualizados!",
          body: `${userName} salvou permanentemente os dados dos itens vendidos e services na PT '${updatedParty.name}' (${questLabel}).`,
          partyId: updatedParty.id,
          partyName: updatedParty.name,
          questType: updatedParty.ptType === "sanguine" ? "sanguine" : "soulwar",
          status: "pending",
          read: false,
          createdAt: Date.now()
        });
      } catch {}
    });
  }

  function handleQuestTimerClick() {
    if (!party.ptStartedAt) {
      if (!isFull) return;
      requestConfirm("startQuest", () => {
        onUpdate({ ...party, isLocked: false, ptStartedAt: Date.now(), ptDuration: undefined, questConcluida: false });
      });
      return;
    }

    if (!party.questConcluida) {
      requestConfirm("endQuest", () => { void concludeQuest(); });
    }
  }

  /**
   * CONCLUIR QUEST — snapshot ANTES da conclusão.
   *
   * O problema que isto resolve: até aqui o `memberSnapshots` só era montado
   * ao ARQUIVAR. Entre concluir e arquivar, a PT continuava resolvendo cada
   * participante ao vivo em `characters`/`waitingList`. Se nesse intervalo o
   * personagem fosse vendido, descompartilhado ou removido de
   * `sharedCharacters`/`sharedServices`, ele sumia do slot — o personagem
   * "fantasma".
   *
   * A ordem agora é: monta o snapshot → GRAVA e confirma → só então marca
   * `questConcluida`. Se a gravação falhar, nada é concluído e o usuário pode
   * tentar de novo; o estado atual permanece intacto.
   */
  /**
   * Migração segura de slots legados: antes de congelar a Quest, converte nomes
   * de JOGADOR já existentes em UID quando há correspondência aprovada única.
   * Não troca nome, dono, direito financeiro nem sobrescreve UID já gravado.
   */
  function withResolvedSlotUids(sourceParty: PartyTab): PartyTab {
    let changed = false;
    const nextSlotData: Record<string, PartySlotData> = {};
    Object.entries(sourceParty.slotData || {}).forEach(([slotId, rawSlot]) => {
      const slot = { ...rawSlot } as PartySlotData;
      const playerName = String(slot.player || "").trim().toLowerCase();
      const resolvedPlayerUid = !slot.playerUid && playerName
        ? allUsers.find(user => user.nome?.trim().toLowerCase() === playerName)?.uid || ""
        : "";
      if (resolvedPlayerUid) {
        slot.playerUid = resolvedPlayerUid;
        changed = true;
      }
      if (slot.split && !slot.splitBeneficiaryUid) {
        // Mesma cadeia da Cloud Function (partyLifecycleCore.slotFromRaw):
        // financeiro → alvo explícito → último recurso o JOGADOR. Personagens
        // EXTERNOS têm dono apenas por NOME (sem ownerUid); sem este fallback
        // a divisão ficaria sem destinatário e a finalização da PT seria
        // rejeitada com `split_beneficiary_missing`.
        const target = slot.financialRightsHolderUid
          || (slot.splitTarget === "player" ? (slot.playerUid || "") : (slot.ownerUid || ""))
          || (slot.playerUid || "");
        if (target) {
          slot.splitBeneficiaryUid = target;
          changed = true;
        }
      }
      nextSlotData[slotId] = slot;
    });
    return changed ? { ...sourceParty, slotData: nextSlotData } : sourceParty;
  }

  async function concludeQuest() {
    if (isConcludingQuest) return;
    const now = Date.now();
    // Duração EFETIVA: desconta os períodos pausados. Antes era
    // `now - ptStartedAt`, que somava o tempo parado.
    const duration = computeEffectiveMs(party, now);

    // 1) Resolve UID de JOGADOR/beneficiário antes de congelar o roster.
    const partyWithResolvedUids = withResolvedSlotUids(party);
    // 2) Snapshot de TODOS os participantes, no estado em que estão agora.
    const memberSnapshots = buildMemberSnapshotsForArchive(partyWithResolvedUids);
    const partyWithSnapshot: PartyTab = { ...partyWithResolvedUids, memberSnapshots };
    const finalizedParty: PartyTab = {
      ...partyWithSnapshot,
      questConcluida: true,
      questFinalizedAt: now,
      questFinalizedByUid: currentUser?.uid || "",
      ptDuration: duration,
      pagamentoFeito: false,
      archivedAt: party.archivedAt || now,
    };

    if (onPersistPartyNow) {
      // A mesma operação que confirma o snapshot também confirma o estado
      // final da Quest. Não dependemos mais de um flush assíncrono após o
      // clique, portanto fechar o navegador logo depois não perde a conclusão
      // já reconhecida pelo servidor.
      setIsConcludingQuest(true);
      try {
        const snapshotSaved = await onPersistPartyNow(partyWithSnapshot);
        if (!snapshotSaved) {
          customAlert(
            "Não foi possível salvar os dados dos participantes desta PT.\n\n"
            + "A Quest NÃO foi concluída e nenhum dado foi perdido. "
            + "Verifique sua conexão e tente novamente.",
          );
          return;
        }

        const questSaved = await onPersistPartyNow(finalizedParty);
        if (!questSaved) {
          customAlert(
            "Os participantes foram preservados, mas a conclusão da Quest não foi confirmada no Firestore.\n\n"
            + "A Quest continuará em aberto para que você tente concluir novamente com segurança.",
          );
          return;
        }
      } finally {
        setIsConcludingQuest(false);
      }
    } else {
      // Compatibilidade com usos externos do PartyPanel que ainda não injetam
      // persistência imediata. O App principal sempre fornece onPersistPartyNow.
      onUpdate(finalizedParty);
    }

    if (ptTimerRef.current) window.clearInterval(ptTimerRef.current);
    setElapsedMs(duration);
  }

  // ── CONTA REAL: visível SOMENTE para o proprietário ─────────────────────
  //
  // `characters` (PERSONAGENS DISPONÍVEIS) é a única fonte confiável do nome
  // real da conta. O snapshot da PT deliberadamente NÃO guarda esse campo
  // (ver `buildMemberSnapshotsForArchive`), então aqui resolvemos sempre pela
  // lista viva — e só quando o personagem é do próprio usuário.
  //
  // A identificação usa o UID (`ownerUid`), nunca o nome exibido: nomes se
  // repetem e podem ser alterados. Sem UID de ambos os lados, não há dono
  // "identificado com segurança" e o mascaramento é mantido.
  const ownCharacterAccountById = useMemo(() => {
    const map: Record<string, string> = {};
    const viewerUid = currentUser?.uid;
    if (!viewerUid) return map;
    characters.forEach(character => {
      if (!character.ownerUid || character.ownerUid !== viewerUid) return;
      const account = (character.account || "").trim();
      if (account) map[character.id] = account;
    });
    return map;
  }, [characters, currentUser?.uid]);

  // ── NOME FICTÍCIO DA CONTA (código exibido na coluna CONTA) ─────────────
  //
  // O mapa é indexado pela IDENTIDADE da conta (`ownerUid + nome`), não pelo
  // nome. Antes, a conta "1" do Usuário A e a "1" do Usuário B caíam na mesma
  // entrada e recebiam o MESMO código fictício — duas contas distintas ficavam
  // visualmente idênticas.
  //
  // Determinismo: as chaves são ordenadas antes de receber o código, então a
  // mesma conta sempre recebe o mesmo rótulo enquanto a lista não mudar — a
  // mesma garantia (e a mesma limitação) do comportamento anterior.
  //
  // A chave NUNCA é exibida: ela só indexa o mapa. O que aparece na tela
  // continua sendo o código curto (`1a`, `2b`, ...), sem `ownerUid`.
  const accountMap = useMemo(() => {
    const keys = Array.from(new Set(
      characters.map(c => getCharacterAccountKey(c)).filter((k): k is string => !!k),
    )).sort();
    const map: Record<string, string> = {};
    keys.forEach((key, index) => {
      map[key] = shortAccountMask(index);
    });
    return map;
  }, [characters]);

  /**
   * Código fictício de um personagem/snapshot.
   *
   * Compatibilidade com PTs antigas: um snapshot já persistido guarda o CÓDIGO
   * em `account` (o nome real nunca foi gravado). Quando a identidade não está
   * no mapa, devolvemos o próprio valor de `account` — preservando o rótulo
   * histórico em vez de reescrevê-lo.
   */
  function accountLabelFor(entity: Parameters<typeof getCharacterAccountKey>[0] & { account?: string } | null | undefined): string {
    if (!entity) return "";
    const key = getCharacterAccountKey(entity);
    if (key && accountMap[key]) return accountMap[key];
    return String(entity.account || "");
  }

  const idsInOtherParties = useMemo(() => {
    const set = new Set<string>();
    allParties.forEach(p => { if (p.id === party.id) return; p.selectedIds.forEach(id => set.add(id)); });
    return set;
  }, [allParties, party.id]);

  // ── TOOLTIP DO ⚠ "EM OUTRA PT" (nome da PT + Quest) ─────────────────────
  //
  // Mesma fonte e a mesma varredura do `idsInOtherParties` acima: as PT's já
  // estão em memória (`allParties`, mantidas vivas pelo listener do
  // Firestore), então o tooltip não custa NENHUMA leitura adicional — e uma
  // Cloud Function só agregaria consumo: o cliente já possui nome e quest de
  // toda PT capaz de acionar o ⚠. Como flag e tooltip derivam da mesma lista,
  // um nunca contradiz o outro.
  const otherPartiesInfoById = useMemo(() => {
    const map = new Map<string, OtherPartyInfo[]>();
    allParties.forEach(p => {
      if (p.id === party.id) return;
      p.selectedIds.forEach(id => {
        const info: OtherPartyInfo = {
          name: String(p.name || "").trim() || "PT sem nome",
          questLabel: p.ptType === "sanguine" ? "Sanguine" : p.ptType === "soulwar" ? "Soul War" : "Quest não definida",
          // PT arquivada (histórico) continua acionando o ⚠ como hoje; a nota
          // só esclarece o estado, para o nome não parecer uma PT ativa.
          statusNote: p.archived ? (p.questFalha ? "falhou" : "finalizada") : undefined,
        };
        const list = map.get(id);
        if (list) list.push(info);
        else map.set(id, [info]);
      });
    });
    return map;
  }, [allParties, party.id]);
  const otherPartiesInfoFor = useCallback(
    (characterId: string) => otherPartiesInfoById.get(characterId),
    [otherPartiesInfoById],
  );

  useEffect(() => {
    if (!draggingPanel) return;
    function onMove(e: MouseEvent) {
      if (!panelsRef.current) return;
      const rect = panelsRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const totalW = rect.width || 1;
      const curPct = Math.max(15, Math.min(85, (x / totalW) * 100));

      setPanelWidths(prev => {
        if (draggingPanel === "left") {
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
      setDraggingPanel(null);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [draggingPanel]);

  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>(null);
  const [filterServer, setFilterServer] = usePersistedState(`pt_srv_${party.id}`, "");
  const [filterVoc, setFilterVoc] = usePersistedState(`pt_voc_${party.id}`, "");
  const [filterAccount, setFilterAccount] = usePersistedState(`pt_acc_${party.id}`, "");
  const [filterPersonagem, setFilterPersonagem] = usePersistedState(`pt_personagem_${party.id}`, "");
  const [filterSW, setFilterSW] = usePersistedState<ToggleState>(`pt_sw_${party.id}`, "yes");
  const [filterSG, setFilterSG] = usePersistedState<ToggleState>(`pt_sg_${party.id}`, "off");
  const swLocked = party.ptType === "soulwar";
  const sgLocked = party.ptType === "sanguine";
  // O seletor de servidor NÃO é mais travado quando a PT tem servidor
  // definido: o usuário precisa poder comparar a PT com outros servidores.
  // O servidor da PT segue destacado no ServerGraphic (prop `partyServer`).
  const serverFilterLocked = false;
  const [filterLevel, setFilterLevel] = usePersistedState(`pt_lvl_${party.id}`, "");
  const [filterLevelOp, setFilterLevelOp] = usePersistedState<"gte"|"lte">(`pt_lvlop_${party.id}`, "gte");
  const [filterDonos, setFilterDonos] = usePersistedState<string[]>(`pt_donos_${party.id}`, []);

  useEffect(() => {
    if (party.ptType === "soulwar") {
      if (filterSW !== "yes") setFilterSW("yes");
      if (filterSG !== "off") setFilterSG("off");
      setWlFilters(prev => {
        const next = { ...prev, quest: "soulwar" };
        return next;
      });
    } else if (party.ptType === "sanguine") {
      if (filterSG !== "yes") setFilterSG("yes");
      if (filterSW !== "off") setFilterSW("off");
      setWlFilters(prev => {
        const next = { ...prev, quest: "sanguine" };
        return next;
      });
    }
  }, [party.ptType, filterSW, filterSG, setFilterSW, setFilterSG]);

  // SEED (uma vez por servidor da PT) — NÃO é sincronização contínua.
  //
  // Antes, este efeito tinha `filterServer` nas dependências e reescrevia o
  // filtro sempre que ele mudava: ao clicar em outro servidor no gráfico, o
  // efeito re-rodava e devolvia o valor para party.servidor. Na prática, o
  // filtro ficava travado no servidor da PT.
  //
  // Agora o servidor da PT apenas INICIALIZA o filtro (e só quando o usuário
  // ainda não escolheu nada nesta PT). Depois disso, a seleção é livre.
  const seededServerRef = useRef<string | null>(null);
  useEffect(() => {
    const srv = party.servidor;
    if (!srv) return;
    if (seededServerRef.current === srv) return; // já semeado para este servidor
    seededServerRef.current = srv;
    // Só semeia se não houver filtro escolhido pelo usuário.
    if (!filterServer) setFilterServer(srv);
    setWlFilters(prev => (prev.servidor ? prev : { ...prev, servidor: srv }));
    // `filterServer` é lido apenas na semeadura inicial; incluí-lo nas
    // dependências recriaria o bug de sobrescrever a escolha do usuário.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [party.servidor, setFilterServer]);

  const selectedSet = useMemo(() => new Set(party.selectedIds), [party.selectedIds]);
  const customs = party.customMembers || [];
  const customIdSet = useMemo(() => new Set(customs.map(c => c.id)), [customs]);
  const totalMembers = party.selectedIds.length + customs.length;
  const isFull = totalMembers >= party.slots;
  const sd = party.slotData || {};
  const isLocked = !!party.pagamentoFeito;
  const isQuestLocked = !!party.questConcluida;
  const isTrulyLockedForActions = isLocked || !!party.isLocked;
  const isPausedActive = !!party.isPaused;
  const questState: "pre_start" | "in_progress" | "post_complete" = party.questConcluida
    ? "post_complete"
    : party.ptStartedAt
      ? "in_progress"
      : "pre_start";
  const canOrganizeParty = questState === "pre_start";

  // PERMISSÕES DE EDIÇÃO DA PT (adicionado)
  // O usuário é o líder da PT se o UID dele for igual ao `leaderUid` armazenado.
  // (Não comparar com `party.LeaderPT` porque esse é o nome de exibição e pode
  // não bater com `userName` quando o líder foi transferido para outro membro.)
  const isLeaderPT = !!(party.leaderUid && currentUser?.uid === party.leaderUid);

  // DIVIDIR permanece disponível durante a Quest para quem já participava.
  // Após a Quest, enquanto a PT ainda está em "Aguardando pagamento" (sem pagamento
  // final), somente o LÍDER pode ajustar os participantes da divisão.
  // A trava normal da PT é pré-Quest; depois da Quest ela não bloqueia esse
  // ajuste financeiro. Pagamento final e pausa continuam bloqueando.
  const canToggleSplitAfterQuest = questState === "post_complete"
    && isLeaderPT
    && !party.pagamentoFeito;
  const canToggleSplit = !isPausedActive && (
    (questState === "in_progress" && !party.isLocked)
    || canToggleSplitAfterQuest
  );

  const isLeaderPTInParty = isLeaderPT && (
    party.selectedIds.some(id => {
      const ch = characters.find(c => c.id === id);
      if (!ch) return false;
      if (party.leaderUid && ch.ownerUid === party.leaderUid) return true;
      return ch.ownerName === userName;
    }) || Object.values(sd).some(slot => {
      if (party.leaderUid && slot.ownerUid === party.leaderUid) return true;
      return slot.owner === userName;
    })
  );
  // ── PARTICIPAÇÃO (fonte única: utils/partyPermissions) ─────────────────────
  // Participante = líder, roster `members`, DONO ou JOGADOR. A coluna JOGADOR
  // tem o MESMO peso que a DONO: quem só é JOGADOR também gerencia a
  // composição enquanto a Quest não foi iniciada (remover participantes,
  // alterar JOGADOR, adicionar). Antes apenas donos de personagem contavam —
  // JOGADOR ficava sem nenhuma ação no painel.
  const partyViewer = { uid: currentUser?.uid || "", userName, role: userProfile?.role };
  const resolveCharOwnerUid = (charId: string) =>
    characters.find(c => c.id === charId)?.ownerUid || party.memberSnapshots?.[charId]?.ownerUid;
  const participation = getPartyParticipation(party, partyViewer, resolveCharOwnerUid);
  const isMember = participation.isParticipant;

  // ── MIGRAÇÃO DE PTs ANTIGAS ───────────────────────────────────────────────
  // PTs criadas ANTES desta mudança não têm snapshot dos participantes e ainda
  // dependem das coleções externas. Ao abrir uma delas, gravamos o snapshot do
  // que ainda for resolvível — sem exigir ação do usuário.
  //
  // Vale para QUALQUER PT não arquivada (em andamento, concluída ou com
  // falha), e não só para as concluídas: é justamente a PT em andamento que
  // corre o risco de perder um participante enquanto a Quest não termina.
  //
  // Roda no máximo UMA vez por PT nesta sessão (`backfilledRef`), só para o
  // líder (quem tem permissão de escrita garantida) e só quando há algo novo
  // a acrescentar. Nada é sobrescrito: snapshots já existentes são mantidos.
  const backfilledRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (party.archived) return;
    if (!isLeaderPT || !onPersistPartyNow) return;
    if (backfilledRef.current.has(party.id)) return;

    const ids = party.selectedIds || [];
    const existing = party.memberSnapshots || {};
    const missing = ids.filter(id => !existing[id]);
    if (missing.length === 0) return;

    // Só grava se ao menos um participante puder ser resolvido agora.
    const resolvable = missing.some(id =>
      characters.some(c => c.id === id) || waitingList.some(w => w.id === id));
    if (!resolvable) return;

    backfilledRef.current.add(party.id);
    const memberSnapshots = buildMemberSnapshotsForArchive(party);
    void onPersistPartyNow({ ...party, memberSnapshots });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [party.id, party.questConcluida, party.questFalha, party.archived, isLeaderPT, characters, waitingList]);
  // A liquidação pós-Quest é centralizada: somente Líder/Boss pode editar
  // drops, valores, divisão e participantes depois da conclusão. Antes disso,
  // qualquer PARTICIPANTE (DONO ou JOGADOR) gerencia a composição — inclusive
  // remover participantes, independentemente de o personagem ser dele.
  const canEditPT = questState === "post_complete"
    ? (isLeaderPT || userProfile?.role === "Boss")
    : isMember;
  // Permissão de adicionar personagens — MESMA fonte única das Rules/Manager.
  // Participantes (DONO/JOGADOR/roster) sempre; Boss sempre; convidado de PT
  // privada ou visitante de PT pública apenas PRÉ-Quest (externo visualiza +
  // adiciona, nunca gerencia).
  const canAddToPartyNow = canAddCharacterToParty(party, partyViewer, resolveCharOwnerUid);
  // NOVA REGRA — "Iniciar Quest":
  // O líder também é considerado participante ativo da PT quando foi selecionado
  // na coluna JOGADOR de qualquer personagem participante (mesmo que o personagem
  // pertença a outro usuário na coluna DONO). A coluna JOGADOR representa
  // prioritariamente quem realmente participará da PT; a coluna DONO continua
  // representando apenas o proprietário do personagem.
  const isLeaderSelectedAsPlayer = isLeaderPT && Object.values(sd).some(slot => {
    if (!slot?.player) return false;
    return slot.player.toLowerCase() === (userName || "").toLowerCase();
  });
  const canStartQuest = isLeaderPTInParty || isLeaderSelectedAsPlayer;

  function getSD(id: string): ExtendedPartySlotData {
    const latestSd = partyRef.current.slotData || {};
    return latestSd[id] || defaultSlotData();
  }
  function setSD(id: string, patch: Partial<ExtendedPartySlotData>) {
    const latestParty = partyRef.current;
    const latestSd = latestParty.slotData || {};
    const cur = latestSd[id] || defaultSlotData();
    onUpdate({ ...latestParty, slotData: { ...latestSd, [id]: { ...cur, ...patch } } });
  }

  // ── CONFIRMAÇÃO DE INCOMPATIBILIDADE ─────────────────────────────────────
  //
  // Antes de adicionar, checamos DOIS pontos: a Quest exigida pela PT e o
  // servidor. Nenhum deles BLOQUEIA — apenas pedem confirmação, porque há
  // casos legítimos (o dono vai fazer a Quest antes, o personagem vai ser
  // transferido de servidor, etc.).
  //
  // Um ÚNICO modal cobre os dois problemas ao mesmo tempo: abrir dois seguidos
  // seria irritante e faria o usuário confirmar no piloto automático.
  const [pendingAdd, setPendingAdd] = useState<{
    id: string;
    name: string;
    questIssue: string;
    serverIssue: string;
  } | null>(null);

  /**
   * Porta de entrada da adição. Detecta incompatibilidades e, havendo alguma,
   * abre a confirmação em vez de adicionar direto.
   *
   * Vale para as DUAS listas (personagens e Services) porque ambas chamam
   * exatamente esta função.
   */
  function addToParty(id: string) {
    // Portão de permissão (espelha as Security Rules): participantes (DONO/
    // JOGADOR/líder) e Boss sempre; convidado de PT privada ou visitante de
    // PT pública apenas PRÉ-Quest. Sem isto o clique de um externo falharia
    // silenciosamente nas regras (a gravação é negada e reverte sozinha).
    if (!canAddToPartyNow) {
      customAlert(
        questState === "pre_start"
          ? "Você não tem permissão para adicionar personagens a esta PT."
          : "Não é possível adicionar personagens após o início da Quest.",
        "Sem permissão",
      );
      return;
    }
    const character = characters.find(c => c.id === id);
    const service = waitingList.find(w => w.id === id);
    if (!character && !service) { performAddToParty(id); return; }

    // A lista mantém o personagem visível em vermelho, mas esta guarda também
    // protege caminhos programáticos, cliques rápidos e confirmações pendentes.
    if (character && hasPartyAccountConflict(character)) {
      customAlert(
        "Este personagem não pode ser adicionado porque outro personagem da mesma conta já participa desta PT.",
        "Conta indisponível",
      );
      return;
    }

    // ── Quest ──────────────────────────────────────────────────────────────
    // Personagem: `soulwar`/`sanguine` indicam a Quest DISPONÍVEL (ainda não
    // feita). Service: o campo `quest` diz para qual Quest ele foi cadastrado.
    // Sem `ptType` definido não há o que comparar.
    let questIssue = "";
    const ptType = party.ptType;
    if (ptType === "soulwar" || ptType === "sanguine") {
      const questLabel = ptType === "soulwar" ? "Soul War" : "Sanguine";
      const hasQuest = service
        ? service.quest === ptType
        : ptType === "soulwar" ? !!character?.soulwar : !!character?.sanguine;
      if (!hasQuest) {
        questIssue = `não possui ${questLabel} disponível`;
      }
    }

    // ── Servidor ───────────────────────────────────────────────────────────
    // `serverLabel` normaliza nomenclaturas antigas do MESMO servidor, então
    // um registro legado não dispara aviso falso. Só comparamos quando os
    // dois lados têm servidor informado.
    let serverIssue = "";
    const partyServer = serverLabel(party.servidor);
    const entityServer = serverLabel(service ? service.servidor : character?.servidor);
    if (partyServer && entityServer && partyServer !== entityServer) {
      serverIssue = `está em ${entityServer}, mas esta PT está configurada para ${partyServer}`;
    }

    if (!questIssue && !serverIssue) { performAddToParty(id); return; }

    setPendingAdd({
      id,
      name: (service ? service.personagem : character?.personagem) || "Este personagem",
      questIssue,
      serverIssue,
    });
  }

  /**
   * Executa a adição de fato. Só é chamada depois de o usuário confirmar
   * eventuais incompatibilidades (ver `addToParty`).
   */
  function performAddToParty(id: string) {
    // Sempre trabalhar com a versão MAIS RECENTE da PT (mesmo padrão de setSD).
    // Usar `party` capturado no render pode causar sobreposição de estado quando
    // duas adições rápidas acontecem, substituindo um personagem já incluído.
    const latestParty = partyRef.current;
    const latestSelectedIds = latestParty.selectedIds || [];
    const latestCustoms = latestParty.customMembers || [];
    const latestSd = latestParty.slotData || {};
    const latestTotal = latestSelectedIds.length + latestCustoms.length;
    const latestIsFull = latestTotal >= latestParty.slots;

    if (latestIsFull) return;
    // Proteção contra duplicata: se o ID já está em selectedIds, não faz nada.
    if (latestSelectedIds.includes(id)) return;

    const newSd = { ...latestSd };
    const wt = waitingList.find(w => w.id === id);
    const ch = characters.find(c => c.id === id);

    // Defesa contra corrida: outro clique/dispositivo pode ter preenchido a PT
    // entre a abertura da lista e a persistência desta adição.
    if (ch && hasPartyAccountConflict(ch, latestParty)) {
      customAlert(
        "Este personagem não pode ser adicionado porque outro personagem da mesma conta já participa desta PT.",
        "Conta indisponível",
      );
      return;
    }

    // ==========================================================================
    // VALIDAÇÃO DE AMIZADE — Bloqueia adição de personagens de não-amigos
    // ==========================================================================
    // Se o personagem pertence a outro usuário que NÃO está na lista de amigos
    // aceitos do usuário atual, bloqueia a operação. O personagem continua visível
    // na PT atual (exceção de consistência), mas não pode ser adicionado a novas PTs.
    // Nota: services (waitingList) não passam por esta validação pois são públicos.
    // ==========================================================================
    if (ch && !wt) {
      const charOwnerUid = ch.ownerUid || currentUser?.uid || "";
      const isSelf = !charOwnerUid || charOwnerUid === currentUser?.uid;
      const isFriend = acceptedFriendUids.includes(charOwnerUid);
      if (!isSelf && !isFriend) {
        customAlert("Você não pode adicionar este personagem porque o proprietário não faz parte da sua lista de amigos.");
        return;
      }
    }

    let ownerVal: string;
    let ownerUidVal: string;
    let playerVal: string;
    let playerUidVal: string;

    if (wt) {
      ownerVal = wt.ownerName || userName;
      ownerUidVal = (wt as any).ownerUid || wt.createdBy || "";
      // Service recém-adicionado começa SEM JOGADOR ("Nenhum Jogador" / N/A):
      // nada de herdar o serviceiro da coluna "ADD POR". O JOGADOR só passa a
      // existir quando alguém for selecionado explicitamente no seletor da
      // coluna (handlePlayerSelect), que também resolve o UID e o roster.
      // Mesma convenção do "+ Externo": player vazio => nenhum Service é
      // contabilizado para ninguém até a atribuição manual.
      playerVal = "";
      playerUidVal = "";
    } else if (ch) {
      ownerVal = ch.ownerName || userName;
      ownerUidVal = ch.ownerUid || currentUser?.uid || "";
      playerVal = ownerVal;
      playerUidVal = ownerUidVal;
    } else {
      ownerVal = userName;
      ownerUidVal = currentUser?.uid || "";
      playerVal = userName;
      playerUidVal = ownerUidVal;
    }

    if (!newSd[id]) {
      newSd[id] = {
        ...defaultSlotData(),
        owner: ownerVal,
        ownerUid: ownerUidVal,
        player: playerVal,
        playerUid: playerUidVal,
        itemVendido: wt ? (wt.valorCombinado || 0) : 0,
        // Marca a origem Service já na entrada. A flag é persistida no slot
        // porque a entrada da Lista de Espera é removida ao concluir a Quest.
        ...(wt ? { isService: true } : {}),
      };
    } else {
      newSd[id] = {
        ...newSd[id],
        owner: newSd[id].owner || ownerVal,
        ownerUid: newSd[id].ownerUid || ownerUidVal,
        player: newSd[id].player || playerVal,
        playerUid: newSd[id].playerUid || playerUidVal,
        itemVendido: newSd[id].itemVendido || (wt ? (wt.valorCombinado || 0) : 0),
        ...(wt ? { isService: true } : {}),
      };
    }

    // Gravar notificação no Firestore se o destinatário não for o próprio remetente
    if (ownerUidVal && currentUser?.uid && ownerUidVal !== currentUser.uid) {
      const notifId = "notif_" + Date.now() + Math.random().toString(36).slice(2);
      const sigla = latestParty.ptType === "sanguine" ? "SG" : "SW";
      const horarioStr = latestParty.horarioTimestamp ? new Date(latestParty.horarioTimestamp).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }) : "horário a combinar";
      setDoc(doc(db, "notifications", notifId), {
        id: notifId,
        userId: ownerUidVal,
        senderName: userName,
        type: "pt_added",
        title: "Você foi adicionado a uma PT!",
        body: `${userName} te adicionou na PT "${latestParty.name}" para ${sigla}, ${horarioStr}`,
        partyId: latestParty.id,
        partyName: latestParty.name,
        questType: latestParty.ptType === "sanguine" ? "sanguine" : "soulwar",
        scheduledTime: latestParty.horarioTimestamp ?? null,
        status: "pending",
        read: false,
        createdAt: Date.now(),
        targetRole: "Normal",
      }).catch(() => {});
    }

    const currentInvited = latestParty.invitedUsers || [];
    const newInvited = (latestParty.visibility === "private" && ownerUidVal && !currentInvited.includes(ownerUidVal))
      ? [...currentInvited, ownerUidVal]
      : latestParty.invitedUsers;
    // DONO e JOGADOR entram no roster `members` JÁ NA ADIÇÃO — é isso que
    // garante a ambos (incluindo o serviceiro selecionado como JOGADOR de um
    // Service) o acesso de participante nas Security Rules e a presença na
    // lista de PTs deles. Antes só o DONO entrava (e apenas no próximo
    // salvamento): um JOGADOR sem personagem próprio ficava sem permissão de
    // editar e às vezes até de VER a PT.
    const nextMembers = Array.from(new Set([
      ...(latestParty.members || []),
      ownerUidVal,
      playerUidVal,
    ].filter(Boolean)));

    // ── SNAPSHOT NO MOMENTO DA INCLUSÃO ───────────────────────────────────
    // Grava os dados do participante JUNTO com a própria adição, no mesmo
    // `onUpdate`. A partir deste instante a PT é autossuficiente: se o
    // personagem for vendido, excluído ou descompartilhado depois, ele
    // continua aparecendo para todos que têm acesso à PT.
    const snapshot = buildSnapshotForMember(id, ch, wt);
    const newSnapshots = snapshot
      ? { ...(latestParty.memberSnapshots || {}), [id]: snapshot }
      : latestParty.memberSnapshots;

    onUpdate({
      ...latestParty,
      selectedIds: [...latestSelectedIds, id],
      slotData: newSd,
      invitedUsers: newInvited,
      memberSnapshots: newSnapshots,
      members: nextMembers,
    });
  }

  function addCustomMemberToParty() {
    const label = customForm.label.trim();
    const ownerName = (customForm.ownerName || "").trim();
    if (!label || !ownerName || isFull) return;
    const id = "cust_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    // Personagens adicionados por "+ Externo" seguem a mesma regra de
    // contabilização dos que vêm da ServiceList (1 Service para o usuário
    // escolhido na coluna JOGADOR ao concluir a Quest) — MAS sem qualquer
    // vínculo automático com quem adicionou:
    //   • DONO    = nome informado no formulário (proprietário REAL);
    //   • JOGADOR = "Nenhum Usuário" (vazio) até ser selecionado manualmente.
    // Sem `ownerUid`/`playerUid`, o slot não pertence a nenhum usuário do app:
    // enquanto o JOGADOR continuar "Nenhum Usuário", nenhum Service é
    // contabilizado para ninguém (a contagem exige Quest concluída + JOGADOR
    // válido, conforme analyzePartyForStats no App).
    const newSd = { ...sd, [id]: { ...defaultSlotData(), owner: ownerName, player: "", isService: true } };
    onUpdate({ ...party, customMembers: [...customs, { ...customForm, id, label, ownerName }], slotData: newSd });
    setCustomForm({ label: "", ownerName: "", servidor: "", voc: "EK", level: 0, soulwar: false, sanguine: false });
    setShowAddCustom(false);
  }

  /**
   * REMOÇÃO EXPLÍCITA da PT — a única forma de um participante sair dela.
   *
   * Diferente de o personagem sumir de `sharedCharacters`/`sharedServices`:
   * aquilo NÃO o remove da PT. Só esta ação remove.
   *
   * O snapshot também é apagado aqui. Sem isso o participante "ressuscitaria"
   * pelo próprio snapshot, já que ele passou a ser a fonte primária.
   */
  function removeFromParty(id: string) {
    const newSd = { ...sd }; delete newSd[id];
    const newSnapshots = { ...(party.memberSnapshots || {}) };
    delete newSnapshots[id];
    if (customIdSet.has(id)) onUpdate({ ...party, customMembers: customs.filter(c => c.id !== id), slotData: newSd, memberSnapshots: newSnapshots });
    else onUpdate({ ...party, selectedIds: party.selectedIds.filter(x => x !== id), slotData: newSd, memberSnapshots: newSnapshots });
  }
  /**
   * Clique na caixa DIVIDIR.
   *
   * DESMARCAR é sempre direto — e limpa a escolha anterior, para que marcar de
   * novo volte a perguntar (requisito explícito).
   *
   * MARCAR só é imediato quando DONO == JOGADOR. Havendo divergência, nada é
   * gravado agora: abrimos o modal e a marcação só acontece depois da escolha.
   * É isso que garante que cancelar deixe a caixa desmarcada.
   */
  function handleSplitToggle(id: string, checked: boolean) {
    const slot = getSD(id);
    // A aquisição já definiu permanentemente o titular financeiro. Quando a
    // divisão for usada, ela obrigatoriamente será paga ao adquirente/JOGADOR.
    if (slot.characterAcquisitionId) {
      setSD(id, {
        split: checked,
        splitTarget: "player",
        splitTargetName: slot.financialRightsHolderName || getSlotPlayerName(slot, "Jogador"),
        splitBeneficiaryUid: slot.financialRightsHolderUid || slot.playerUid || undefined,
      });
      return;
    }
    if (!checked) {
      setSD(id, { split: false, splitTarget: undefined, splitTargetName: undefined, splitBeneficiaryUid: undefined });
      return;
    }

    if (!hasDistinctOwnerAndPlayer(slot)) {
      // Sem ambiguidade: o destinatário é o próprio dono (ou o jogador, quando
      // os nomes coincidem). Personagens EXTERNOS não têm `ownerUid` (o dono
      // informado é um nome livre, não um usuário do app): a divisão só é
      // possível quando há um beneficiário identificado por UID — no caso, o
      // JOGADOR selecionado. Sem isso, o slot ficaria com a divisão marcada e
      // sem destinatário, bloqueando a finalização da PT.
      const splitBeneficiaryUid = slot.financialRightsHolderUid || slot.ownerUid || slot.playerUid || undefined;
      if (!splitBeneficiaryUid) {
        customAlert("A divisão exige um DONO/JOGADOR aprovado com UID identificado.", "Destinatário da divisão não identificado");
        return;
      }
      setSD(id, { split: true, splitTarget: undefined, splitTargetName: undefined, splitBeneficiaryUid });
      return;
    }

    setSplitTargetPrompt({
      slotId: id,
      ownerName: getSlotOwnerName(slot, "—"),
      playerName: getSlotPlayerName(slot, "—"),
    });
  }

  /**
   * Contexto de resolução do destinatário da divisão para o slot do modal
   * aberto: mesma fonte do seletor de JOGADOR (usuários aprovados por nome) e
   * mesmo fallback de DONO do backend (snapshot congelado / personagem vivo).
   */
  function splitBeneficiaryContextFor(slotId: string): SplitBeneficiaryContext {
    return {
      findApprovedUidByName: normalizedName => (
        allUsers.find(user => user.status === "aprovado"
          && String(user.nome || "").trim().toLowerCase() === normalizedName)?.uid
      ),
      fallbackOwnerUid: partyRef.current.memberSnapshots?.[slotId]?.ownerUid
        || characters.find(c => c.id === slotId)?.ownerUid
        || "",
    };
  }

  /** Confirma a escolha do modal e só então marca DIVIDIR. */
  function confirmSplitTarget(target: SplitTarget) {
    const prompt = splitTargetPrompt;
    if (!prompt) return;
    const slot = getSD(prompt.slotId);
    // Resolução completa da cadeia (ver util): UID do slot → snapshot/nome
    // resolvido. Antes apenas `financialRightsHolderUid || playerUid/ownerUid`
    // do slot — qualquer lacuna (PT legada, nome sem UID) deixava a escolha
    // morta com o aviso de erro abrindo ATRÁS deste modal.
    const beneficiaryUid = resolveSplitBeneficiaryCandidate(slot, target, splitBeneficiaryContextFor(prompt.slotId));
    if (!beneficiaryUid) {
      customAlert(
        "O destinatário escolhido não pôde ser identificado como usuário do app. A divisão exige um DONO/JOGADOR aprovado com UID identificado.",
        "Destinatário da divisão não identificado",
      );
      return;
    }
    setSD(prompt.slotId, {
      split: true,
      splitTarget: target,
      // Nome gravado junto: se o jogador do slot mudar depois, o histórico
      // preserva para quem a divisão foi destinada no momento da escolha.
      splitTargetName: target === "player"
        ? getSlotPlayerName(slot, prompt.playerName)
        : getSlotOwnerName(slot, prompt.ownerName),
      splitBeneficiaryUid: beneficiaryUid,
      // UID resolvido por fallback volta gravado no slot (sem sobrescrever o
      // existente) — PT autoconsistente e validação do backend direta.
      ...buildResolvedUidPatch(slot, target, beneficiaryUid),
    });
    setSplitTargetPrompt(null);
  }

  /**
   * Trocar o JOGADOR invalida uma escolha de destinatário já feita.
   *
   * Cenário do problema: DIVIDIR marcado com destino "jogador" = Ana; depois o
   * jogador do slot vira Bruno. Sem esta limpeza, a cota da Ana passaria
   * silenciosamente para o Bruno — dinheiro indo para a pessoa errada, sem
   * ninguém ser avisado.
   *
   * Por segurança, DIVIDIR é desmarcado junto: assim o usuário é obrigado a
   * marcar de novo e responder o modal com os nomes atualizados. Só age quando
   * havia escolha explícita (`splitTarget` definido) e o nome realmente mudou.
   */
  function buildPlayerChangeSplitPatch(slot: ExtendedPartySlotData, nextPlayer: string): Partial<ExtendedPartySlotData> {
    if (!slot.splitTarget) return {};
    const current = String(slot.player || "").trim().toLowerCase();
    const next = String(nextPlayer || "").trim().toLowerCase();
    if (current === next) return {};
    return { split: false, splitTarget: undefined, splitTargetName: undefined, splitBeneficiaryUid: undefined };
  }

  function handlePlayerSelect(id: string, name: string) {
    const latestParty = partyRef.current;
    const latestSd = latestParty.slotData || {};
    const curSlot = latestSd[id] || defaultSlotData();
    const curPlayer = curSlot.player ?? (curSlot.owner || "");
    const proposal = curSlot.ownerUid
      ? characterAcquisitions.find(acquisition => acquisition.characterId === id && acquisition.originalOwnerUid === curSlot.ownerUid)
      : undefined;
    // A proposta já identifica comprador e vendedor. Alterar o JOGADOR depois
    // da pré-aprovação mudaria silenciosamente quem deve aceitar/pagar.
    if ((curSlot.characterAcquisitionId || proposal) && name !== curPlayer) {
      customAlert("O JOGADOR não pode ser alterado após pré-aprovar ou registrar a negociação do personagem.", "Negociação protegida");
      return;
    }
    if (!name) {
      setSD(id, { player: name, playerUid: undefined, ...buildPlayerChangeSplitPatch(curSlot, name) });
      return;
    }
    // PTs legadas podem ter o mesmo nome exibido, mas ainda não possuir UID.
    // Nesse caso continuamos a resolver o usuário para materializar histórico seguro.
    if (name === curPlayer && curSlot.playerUid) {
      setSD(id, { player: name, playerUid: curSlot.playerUid, ...buildPlayerChangeSplitPatch(curSlot, name) });
      return;
    }
    const targetUser = allUsers.find(u => u.nome.toLowerCase() === name.toLowerCase());
    if (!targetUser) {
      setSD(id, { player: name, playerUid: undefined, ...buildPlayerChangeSplitPatch(curSlot, name) });
      return;
    }
    const uid = targetUser.uid;
    // Após Quest Finalizada, o Líder/Boss só pode direcionar divisão a quem já
    // pertence a algum slot, aos direitos financeiros ou à liderança da PT.
    // Isso impede introduzir terceiros que não participaram da Quest.
    if (latestParty.questConcluida) {
      const eligiblePostQuestUids = new Set<string>([latestParty.leaderUid || ""]);
      (latestParty.selectedIds || []).forEach(slotId => {
        const current = latestSd[slotId];
        if (current?.ownerUid) eligiblePostQuestUids.add(current.ownerUid);
        if (current?.playerUid) eligiblePostQuestUids.add(current.playerUid);
        if (current?.financialRightsHolderUid) eligiblePostQuestUids.add(current.financialRightsHolderUid);
      });
      if (!eligiblePostQuestUids.has(uid)) {
        customAlert("Após a Quest, a divisão só pode incluir usuários já vinculados a um slot da PT.", "Participante não elegível");
        return;
      }
    }
    // A notificação somente deverá ser enviada se o usuário selecionado na coluna JOGADOR
    // ainda não fizer parte daquela PT. Se ele já possuir um personagem participante
    // ou já tiver sido incluído anteriormente como convidado: não adicionar novamente;
    // não enviar uma nova notificação.
    const alreadyParticipant =
      (latestParty.leaderUid === uid || latestParty.LeaderPT?.toLowerCase() === name.toLowerCase()) ||
      (latestParty.members || []).includes(uid) ||
      (latestParty.invitedUsers || []).includes(uid) ||
      (latestParty.selectedIds || []).some(cid => {
        const ch = characters.find(c => c.id === cid) || latestParty.memberSnapshots?.[cid];
        return ch?.ownerUid === uid || ch?.ownerName?.toLowerCase() === name.toLowerCase();
      }) ||
      Object.values(latestSd).some(slot =>
        slot?.ownerUid === uid || slot?.owner?.toLowerCase() === name.toLowerCase() || slot?.player?.toLowerCase() === name.toLowerCase()
      );
    const nextSlotData = { ...latestSd, [id]: { ...curSlot, player: name, playerUid: uid, ...buildPlayerChangeSplitPatch(curSlot, name) } };
    if (alreadyParticipant) {
      onUpdate({ ...latestParty, slotData: nextSlotData });
      return;
    }
    const nextMembers = Array.from(new Set([...(latestParty.members || []), uid]));
    const nextInvited = latestParty.visibility === "private"
      ? Array.from(new Set([...(latestParty.invitedUsers || []), uid]))
      : latestParty.invitedUsers;
    // Enviar notificação "Você foi adicionado a uma PT!"
    if (uid && currentUser?.uid && uid !== currentUser.uid) {
      const notifId = "notif_" + Date.now() + "_" + Math.random().toString(36).slice(2);
      const sigla = latestParty.ptType === "sanguine" ? "SG" : "SW";
      const horarioStr = latestParty.horarioTimestamp
        ? new Date(latestParty.horarioTimestamp).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })
        : "horário a combinar";
      setDoc(doc(db, "notifications", notifId), {
        id: notifId,
        userId: uid,
        senderName: userName,
        type: "pt_added",
        title: "Você foi adicionado a uma PT!",
        body: `${userName} te adicionou na PT "${latestParty.name}" para ${sigla}, ${horarioStr}`,
        partyId: latestParty.id,
        partyName: latestParty.name,
        questType: latestParty.ptType === "sanguine" ? "sanguine" : "soulwar",
        scheduledTime: latestParty.horarioTimestamp ?? null,
        status: "pending",
        read: false,
        createdAt: Date.now(),
        targetRole: "Normal",
      }).catch(() => {});
    }
    onUpdate({
      ...latestParty,
      slotData: nextSlotData,
      members: nextMembers,
      invitedUsers: nextInvited
    });
  }

  function addSlot() { onUpdate({ ...party, slots: party.slots + 1 }); }
  function removeSlot() {
    if (party.slots <= 2) return;
    const max = party.slots - 1; let sel = [...party.selectedIds]; let cust = [...customs];
    while (sel.length + cust.length > max) { if (cust.length > 0) cust.pop(); else sel.pop(); }
    // Remover slots também é saída EXPLÍCITA: os snapshots de quem saiu vão
    // junto, senão o participante voltaria a aparecer pelo próprio snapshot.
    const keep = new Set([...sel, ...cust.map(c => c.id)]);
    const newSnapshots: Record<string, Character> = {};
    Object.entries(party.memberSnapshots || {}).forEach(([id, snap]) => {
      if (keep.has(id)) newSnapshots[id] = snap;
    });
    onUpdate({ ...party, slots: max, selectedIds: sel, customMembers: cust, memberSnapshots: newSnapshots });
  }

  const getCharOwner = (c: Character) => (c as any).ownerName || userName || "—";

  // Contas JÁ presentes na PT, por identidade REAL (`ownerUid + nome`).
  // O conjunto vem da regra canônica `getCharacterAccountKey`, portanto conta
  // "1" de usuários diferentes continua sendo distinta.
  const currentPartyAccountSet = useMemo(() => {
    const set = new Set<string>();
    party.selectedIds.forEach(id => {
      const ch = characters.find(c => c.id === id);
      const key = getCharacterAccountKey(ch);
      if (key) set.add(key);
    });
    return set;
  }, [party.selectedIds, characters]);

  // Personagens irmãos da conta já usada: permanecem na lista, mas a camada
  // visual os mostra em vermelho e a guarda de adição os mantém indisponíveis.
  const unavailableSameAccountIds = useMemo(() => {
    const ids = new Set<string>();
    characters.forEach(character => {
      if (selectedSet.has(character.id)) return;
      const accountKey = getCharacterAccountKey(character);
      if (accountKey && currentPartyAccountSet.has(accountKey)) ids.add(character.id);
    });
    return ids;
  }, [characters, selectedSet, currentPartyAccountSet]);

  /** Reutiliza a identidade canônica para proteger também chamadas fora da UI. */
  function hasPartyAccountConflict(candidate: Character, sourceParty: PartyTab = partyRef.current): boolean {
    const members = (sourceParty.selectedIds || [])
      .filter(id => id !== candidate.id)
      .map(id => characters.find(character => character.id === id) || sourceParty.memberSnapshots?.[id]);
    return hasAccountConflictWith(members, candidate);
  }

  // ── VISIBILIDADE POR AMIZADE (apenas nas listas de DISPONÍVEIS) ─────────
  //
  // `characters` e `waitingList` chegam do App já filtrados por amizade, MAS
  // com uma exceção deliberada: quem está em qualquer PT (`exceptionEntityIds`)
  // passa pelo filtro. Essa exceção existe para impedir personagem "fantasma"
  // dentro das PTs — e é indispensável.
  //
  // O efeito colateral é que o personagem de um NÃO-AMIGO que participa de
  // alguma PT reaparece nas listas de disponíveis, ficando ofertado para
  // adição. Aqui aplicamos o filtro de amizade SEM a exceção, só para as duas
  // listas de oferta.
  //
  // Isso NÃO afeta a composição da PT: os slots são resolvidos em
  // `slotMembers`, a partir de `party.selectedIds`, que não passa por aqui.
  // Nenhum dado é alterado — é puramente uma regra de exibição.
  const friendUidSet = useMemo(() => new Set(acceptedFriendUids || []), [acceptedFriendUids]);

  /** `true` quando o dono é o próprio usuário ou um amigo aceito. */
  const isOwnedBySelfOrFriend = useCallback((ownerUid?: string) => {
    const viewerUid = currentUser?.uid || "";
    // Sem UID do dono não há como afirmar que é de um não-amigo; manter
    // visível preserva o comportamento atual dos registros legados.
    if (!ownerUid) return true;
    if (viewerUid && ownerUid === viewerUid) return true;
    return friendUidSet.has(ownerUid);
  }, [currentUser?.uid, friendUidSet]);

  const available = useMemo(() => {
    return characters.filter(c => {
      // Não-amigo não é OFERECIDO. Se ele já estiver na PT, continua
      // aparecendo normalmente na composição (ver `slotMembers`).
      if (!isOwnedBySelfOrFriend(c.ownerUid)) return false;
      if (c.shared === false) return false;
      if (!c.soulwar && !c.sanguine) return false;
      if (selectedSet.has(c.id)) return false;
      // A mesma conta continua visível; `unavailableSameAccountIds` informa a
      // lista para desenhá-la em vermelho e bloquear apenas a sua adição.
      if (filterPersonagem && !c.personagem.toLowerCase().includes(filterPersonagem.toLowerCase())) return false;
      if (filterServer && !isSameServer(c.servidor, filterServer)) return false;
      if (filterVoc && c.voc !== filterVoc) return false;
      if (filterAccount && accountLabelFor(c) !== filterAccount) return false;
      if (filterSW === "yes" && !c.soulwar) return false;
      if (filterSW === "no" && c.soulwar) return false;
      if (filterSG === "yes" && !c.sanguine) return false;
      if (filterSG === "no" && c.sanguine) return false;
      if (filterLevel) { const t = parseInt(filterLevel, 10); if (Number.isFinite(t)) { if (filterLevelOp === "gte" && c.level < t) return false; if (filterLevelOp === "lte" && c.level > t) return false; } }
      if (filterDonos.length > 0 && !filterDonos.includes(getCharOwner(c))) return false;
      return true;
    });
    }, [characters, selectedSet, filterServer, filterVoc, filterAccount, filterSW, filterSG, filterLevel, filterLevelOp, accountMap, filterDonos, userName, filterPersonagem, isOwnedBySelfOrFriend]);

  // Persistido como os demais filtros da PT (`pt_*_${party.id}`): sair da
  // lista/guia e voltar mantém os filtros exatamente como estavam.
  const [wlFilters, setWlFilters] = usePersistedState<Record<string, string>>(`pt_wl_${party.id}`, {});
  const visibleWaitingList = useMemo(() => {
    return waitingList.filter(i => {
      // Mesma regra da lista de personagens: Service de NÃO-AMIGO não é
      // oferecido para adição. O dono de um Service é o `serviceiroUid`.
      //
      // Services SEM Serviceiro designado ("Qualquer um") continuam públicos:
      // são justamente os que qualquer usuário aprovado pode atender, e a
      // amizade não se aplica a eles — mesma exceção que
      // `canViewServiceForViewer` já faz no App.
      if (!isServiceOpenToAnyone(i) && !isOwnedBySelfOrFriend(i.serviceiroUid)) return false;
      if (selectedSet.has(i.id)) return false;
      if (wlFilters.personagem && !i.personagem.toLowerCase().includes(wlFilters.personagem.toLowerCase())) return false;
      // Igualdade EXATA: o valor vem de um seletor de servidores (nome completo).
      // Com includes(), "Grimoria I" casava também com "Grimoria II/III/IV".
      if (wlFilters.servidor && !isSameServer(i.servidor, wlFilters.servidor)) return false;
      if (wlFilters.voc && i.voc !== wlFilters.voc) return false;
      if (wlFilters.ownerName && !i.ownerName.toLowerCase().includes(wlFilters.ownerName.toLowerCase())) return false;
      if (wlFilters.quest && i.quest !== wlFilters.quest) return false;
      if (wlFilters.addedBy && !(i.addedBy || "").toLowerCase().includes(wlFilters.addedBy.toLowerCase())) return false;
      if (wlFilters.notes && !i.notes.toLowerCase().includes(wlFilters.notes.toLowerCase())) return false;
      return true;
    });
  }, [waitingList, selectedSet, wlFilters, isOwnedBySelfOrFriend]);

  const serverChartAvailable = useMemo(() => {
    return characters.filter(c => {
      if (c.shared === false) return false;
      if (!c.soulwar && !c.sanguine) return false;
      if (selectedSet.has(c.id)) return false;
      // O gráfico representa apenas candidatos adicionáveis; conflitos de
      // conta permanecem fora dele mesmo aparecendo em vermelho na lista.
      const accountKey = getCharacterAccountKey(c);
      if (accountKey && currentPartyAccountSet.has(accountKey)) return false;
      if (filterPersonagem && !c.personagem.toLowerCase().includes(filterPersonagem.toLowerCase())) return false;
      if (filterVoc && c.voc !== filterVoc) return false;
      if (filterAccount && accountLabelFor(c) !== filterAccount) return false;
      if (filterSW === "yes" && !c.soulwar) return false;
      if (filterSW === "no" && c.soulwar) return false;
      if (filterSG === "yes" && !c.sanguine) return false;
      if (filterSG === "no" && c.sanguine) return false;
      if (filterLevel) { const t = parseInt(filterLevel, 10); if (Number.isFinite(t)) { if (filterLevelOp === "gte" && c.level < t) return false; if (filterLevelOp === "lte" && c.level > t) return false; } }
      if (filterDonos.length > 0 && !filterDonos.includes(getCharOwner(c))) return false;
      return true;
    });
  }, [characters, selectedSet, currentPartyAccountSet, filterVoc, filterAccount, filterSW, filterSG, filterLevel, filterLevelOp, accountMap, filterDonos, userName, filterPersonagem]);

  const serverChartWaitingList = useMemo(() => {
    return waitingList.filter(i => {
      if (selectedSet.has(i.id)) return false;
      if (wlFilters.personagem && !i.personagem.toLowerCase().includes(wlFilters.personagem.toLowerCase())) return false;
      if (wlFilters.voc && i.voc !== wlFilters.voc) return false;
      if (wlFilters.ownerName && !i.ownerName.toLowerCase().includes(wlFilters.ownerName.toLowerCase())) return false;
      if (wlFilters.quest && i.quest !== wlFilters.quest) return false;
      if (wlFilters.addedBy && !(i.addedBy || "").toLowerCase().includes(wlFilters.addedBy.toLowerCase())) return false;
      if (wlFilters.notes && !i.notes.toLowerCase().includes(wlFilters.notes.toLowerCase())) return false;
      return true;
    });
  }, [waitingList, selectedSet, wlFilters]);

  // O gráfico distingue dois conceitos:
  //   - activeServer: o servidor FILTRADO pelo usuário (clique no gráfico);
  //   - partyServer : o servidor da PT, apenas destacado.
  // Antes, com PT selecionada, activeServer era forçado para party.servidor e a
  // prop `locked` bloqueava o clique em todos os servidores, impedindo comparar
  // a PT com os demais. Agora o filtro segue livre e o destaque é indicativo.
  const serverChartActiveServer = filterServer;
  const serverChartPartyServer = party.servidor || undefined;

  // Aplica/remove filtro de servidor nas listas "Personagens Disponíveis" e "Lista de Espera" via clique no gráfico
  function handleServerChartClick(srv: string) {
    const isActive = filterServer === srv && wlFilters.servidor === srv;
    if (isActive) {
      setFilterServer("");
      setWlFilters(f => {
        const next = { ...f };
        delete next.servidor;
        return next;
      });
    } else {
      setFilterServer(srv);
      setWlFilters(f => ({ ...f, servidor: srv }));
    }
  }

  const sortedAvailable = useMemo(() => {
    if (!sortKey || !sortDir) return available;
    const arr = [...available].sort((a, b) => {
      let av: any, bv: any;
      if (sortKey === "account") { av = accountLabelFor(a); bv = accountLabelFor(b); }
      else if (sortKey === "servidor") { av = a.servidor; bv = b.servidor; }
      else if (sortKey === "voc") { av = a.voc; bv = b.voc; }
      else if (sortKey === "level") { av = a.level; bv = b.level; }
      else if (sortKey === "soulwar") { av = a.soulwar ? 1 : 0; bv = b.soulwar ? 1 : 0; }
      else if (sortKey === "sanguine") { av = a.sanguine ? 1 : 0; bv = b.sanguine ? 1 : 0; }
      else return 0;
      if (typeof av === "number" && typeof bv === "number") return av - bv;
      return String(av).localeCompare(String(bv), "pt-BR", { sensitivity: "base" });
    });
    return sortDir === "desc" ? arr.reverse() : arr;
  }, [available, sortKey, sortDir, accountMap]);

  function toggleSort(key: string) { if (sortKey !== key) { setSortKey(key); setSortDir("asc"); } else if (sortDir === "asc") setSortDir("desc"); else { setSortDir(null); setSortKey(null); } }

  function resetAvailableFilters() {
    setFilterAccount("");
    setFilterPersonagem("");
    setFilterServer("");
    setFilterVoc("");
    setFilterLevel("");
    setFilterLevelOp("gte");
    setFilterSW("off");
    setFilterSG("off");
    setFilterDonos([]);
  }

  const serverOptions = useMemo(() => Array.from(new Set(characters.map(c => serverLabel(c.servidor)).filter(Boolean))).sort(), [characters]);
  const vocOptions = useMemo(() => VOCATIONS.filter(v => characters.some(c => c.voc === v)), [characters]);

  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshDone, setRefreshDone] = useState(false);

  async function handleRefresh() {
    if (isRefreshing || !onRefresh) return;
    setIsRefreshing(true);
    setRefreshDone(false);
    try {
      await onRefresh();
      setRefreshDone(true);
      setTimeout(() => setRefreshDone(false), 2000);
    } catch {}
    finally {
      setIsRefreshing(false);
    }
  }

  // --- Copiar resumo para WhatsApp ---
  function copyWhatsAppSummary() {
    try {
      const sd = party.slotData || {};
      const linhas: string[] = [];

      // Helper: formata data como "DD/MM, HH:MM"
      const fmtDateHH = (ts: number) => {
        const dt = new Date(ts);
        const dia = String(dt.getDate()).padStart(2, "0");
        const mes = String(dt.getMonth() + 1).padStart(2, "0");
        const hh = String(dt.getHours()).padStart(2, "0");
        const mm = String(dt.getMinutes()).padStart(2, "0");
        return `${dia}/${mes}, ${hh}:${mm}`;
      };

      // 1) Cabeçalho — Nome da PT (SW/SG)
      const questSigla = party.ptType === "sanguine" ? "SG" : "SW";
      linhas.push(`📋 *Resumo da PT: ${party.name}* (${questSigla})`);

      // 2) Servidor da PT
      //
      // `serverLabel` é a MESMA função usada no restante do painel: ela resolve
      // o nome canônico pós-merge (ex.: Spectrum -> Bellum), então o resumo
      // nunca divulga um nome de servidor que já não existe. PTs antigas sem
      // servidor gravado continuam funcionando — a linha é omitida.
      const partyServerLabel = serverLabel(party.servidor);
      if (partyServerLabel) linhas.push(`🌍 *Servidor:* ${partyServerLabel}`);

      // 3) Data da finalização
      const finalizadaTs = (party.ptStartedAt && party.ptDuration)
        ? party.ptStartedAt + party.ptDuration
        : (party.archivedAt || Date.now());
      linhas.push(`📅 PT Finalizada em: ${fmtDateHH(finalizadaTs)}`);

      // 4) Status — considera APENAS itens dropados pelos membros da DIVISÃO
      //
      // Um item é "pendente" quando foi dropado mas ainda não tem valor de
      // venda (`itemVendido <= 0`) — exatamente o mesmo critério já usado
      // antes. A diferença é que agora NOMEAMOS os itens pendentes em vez de
      // exibir uma mensagem genérica.
      const splitMembersList = allMemberIds.filter(id => sd[id]?.split);
      const unsoldItemNames = splitMembersList
        .filter(id => {
          const d = sd[id];
          return !!d?.itemDropado && (!d?.itemVendido || d.itemVendido <= 0);
        })
        .map(id => (sd[id]?.itemDropado || "").trim())
        .filter(Boolean);
      linhas.push(``);
      linhas.push(unsoldItemNames.length > 0
        ? `📌 Status: Ainda falta vender ${unsoldItemNames.join(", ")}`
        : `📌 Status: Todos os itens foram vendidos`);
      linhas.push(``);

      // 4) Total Vendido — soma de TODOS os itemVendido dos membros da DIVISÃO
      //
      // O CÁLCULO permanece aqui (a lista de participantes abaixo não depende
      // dele, mas o valor individual sim). A LINHA de exibição foi movida para
      // depois da lista, junto do Valor Individual, onde os dois totais ficam
      // agrupados.
      const totalVendido = splitMembersList.reduce((s, id) => s + (sd[id]?.itemVendido || 0), 0);

      // 5) Divisão entre os participantes
      const splitCount = splitMembersList.length;
      linhas.push(`👥 *Divisão entre ${splitCount} participante${splitCount === 1 ? "" : "s"}:*`);
      linhas.push(``);

      splitMembersList.forEach(id => {
        const d = sd[id] as ExtendedPartySlotData | undefined;
        const slot = slotMembers.find(m => m.id === id);
        let jogador = d?.player || "?";
        if (!d?.player && slot && slot.type !== "empty") {
          if (slot.type === "custom") jogador = slot.custom.label;
          else if (slot.type === "waiting") jogador = slot.waiting.personagem || "?";
          else if (slot.type === "char") jogador = d?.owner || slot.char.personagem || "?";
        }
        // O resumo é usado para acertar contas, então precisa nomear QUEM
        // RECEBE. Havendo escolha explícita de destinatário, ela prevalece
        // sobre a resolução acima; sem escolha, nada muda.
        if (d?.splitTarget) jogador = resolveSplitRecipient(d, jogador);
        const itemDropado = (d?.itemDropado || "").trim();
        const itemVendido = d?.itemVendido || 0;
        // Valores REAIS da mini-calculadora, exatamente como persistidos:
        //   • calcTotalKk -> valor de venda em kk
        //   • calcRateKk  -> cotação (quantos k equivalem a 1000 RC)
        // Nada é recalculado aqui: `itemVendido` já é o resultado gravado por
        // `commitCalcDrafts`, que aplica `computeItemRC`.
        const vendaKk = d?.calcTotalKk || 0;
        const cotacaoKk = d?.calcRateKk || 0;

        if (itemDropado && itemVendido > 0) {
          // O detalhamento completo só existe quando a calculadora foi usada.
          // Sem ela (valor RC digitado à mão), mantemos a linha antiga: é o
          // único dado que de fato existe, e exibir uma cotação inventada
          // seria falsear o resumo.
          if (vendaKk > 0 && cotacaoKk > 0) {
            linhas.push(`• ${jogador}: ${itemDropado} > Vendido por ${formatKk(vendaKk, "kk")}, RC por ${formatKk(cotacaoKk, "k")} = ${formatRC(itemVendido)}`);
          } else {
            linhas.push(`• ${jogador}: ${itemDropado} > Vendido por ${formatRC(itemVendido)}`);
          }
        } else if (!itemDropado && itemVendido > 0) {
          // Service (sem item dropado, apenas valor em RC)
          linhas.push(`• ${jogador}: Service: ${formatRC(itemVendido)}`);
        } else if (itemDropado && itemVendido <= 0) {
          // Item dropado, mas ainda não vendido
          linhas.push(`• ${jogador}: O item ${itemDropado} ainda não foi vendido.`);
        } else {
          // Sem item e sem valor declarado
          linhas.push(`• ${jogador}: Não declarou nenhum valor.`);
        }
      });
      linhas.push(``);

      // 6) Totais — Total Vendido e Valor Individual, lado a lado
      //
      // O valor individual usa `dropPerSplit`, a MESMA constante exibida na
      // guia da PT. Antes o resumo recalculava a divisão por conta própria; ao
      // reutilizar a constante, o texto copiado e a tela mostram exatamente o
      // mesmo número por construção, e não por coincidência.
      linhas.push(`💰 *Total Vendido:* ${formatRC(totalVendido)}`);
      linhas.push(`🔹 *Valor Individual:* ${formatRC(dropPerSplit)} para cada.`);
      linhas.push(``);

      // 7) Status do pagamento — SÓ quando não há item pendente de venda
      //
      // Enquanto existir qualquer item por vender, a linha inteira é OMITIDA.
      // Anunciar "Falta pagar" nesse momento seria enganoso: ainda não há o
      // que pagar, porque o valor da divisão sequer está fechado (o resumo
      // mostraria "0 RC para cada"). O que falta é vender, não pagar — e isso
      // a linha "📌 Status: Ainda falta vender ..." já informa.
      //
      // Reutiliza `unsoldItemNames`, a MESMA lista que monta aquela linha, em
      // vez de recalcular a pendência: um só critério, sem risco de as duas
      // mensagens se contradizerem.
      //
      // A lógica de pagamento em si não muda: assim que todos os itens estão
      // vendidos, a linha volta a aparecer normalmente como Pago/Falta pagar.
      if (unsoldItemNames.length === 0) {
        // "Pago" exige que TODOS os participantes da divisão estejam marcados.
        // `every` sobre lista vazia devolve `true`, então a divisão sem ninguém
        // é tratada explicitamente como NÃO paga — caso contrário uma PT sem
        // participantes apareceria como quitada.
        const todosPagos = splitCount > 0 && splitMembersList.every(id => sd[id]?.pago === true);
        linhas.push(todosPagos
          ? `💳 *Status do pagamento:* Pago. ✅`
          : `💳 *Status do pagamento:* Falta pagar. ❌`);
        linhas.push(``);
      }

      // 7) Timestamp do documento
      linhas.push(`📅 Documento gerado em: ${fmtDateHH(Date.now())}`);

      const texto = linhas.join("\n");

      // Copiar para clipboard
      try {
        const ta = document.createElement("textarea");
        ta.value = texto;
        ta.style.position = "fixed";
        ta.style.top = "0";
        ta.style.left = "0";
        ta.style.opacity = "0";
        ta.style.pointerEvents = "none";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {
        navigator.clipboard.writeText(texto).catch(() => {});
      }

      setWhatsappCopied(true);
      setTimeout(() => setWhatsappCopied(false), 2500);
    } catch {}
  }
  const donoOptions = useMemo(() => Array.from(new Set(characters.map(getCharOwner))).sort(), [characters, userName]);

  type SlotEntry = { type: "char"; char: Character; id: string } | { type: "waiting"; waiting: WaitingService; id: string } | { type: "custom"; custom: PartyCustomMember; id: string } | { type: "empty"; id: "" };
  const slotMembers: SlotEntry[] = [];
  for (let i = 0; i < party.slots; i++) {
    const cid = party.selectedIds[i];
    if (cid) {
      // ── RESOLUÇÃO DO PARTICIPANTE ────────────────────────────────────────
      //
      // O SNAPSHOT DA PT É A FONTE PRIMÁRIA. Ele é gravado no momento da
      // inclusão (ver `performAddToParty`), então o participante existe como
      // entidade da própria PT — não como uma consulta a `sharedCharacters` /
      // `sharedServices`, que podem sumir a qualquer momento.
      //
      // A fonte ao vivo é usada apenas para MANTER O SNAPSHOT ATUALIZADO
      // enquanto a PT está em andamento (o level sobe, o nome pode mudar).
      // É atualização de dados, não a base da existência do participante:
      // se a fonte ao vivo desaparecer, o snapshot segue sozinho e o slot
      // continua exibido normalmente para todos.
      //
      // PT concluída/falhada: o snapshot fica CONGELADO — os dados devem
      // refletir o que valia na conclusão, não o que mudou depois.
      const snap = party.memberSnapshots?.[cid];
      const live = characters.find(c => c.id === cid);
      const isFinished = !!party.questConcluida || !!party.questFalha;

      if (snap) {
        // Em andamento, deixa os campos voláteis acompanharem a fonte viva —
        // sem nunca depender dela para o participante existir. O `account`
        // do snapshot (já mascarado) é preservado, para não vazar a conta.
        const merged = (!isFinished && live)
          ? { ...snap, personagem: live.personagem, servidor: live.servidor, voc: live.voc, level: live.level, soulwar: live.soulwar, sanguine: live.sanguine }
          : snap;
        slotMembers.push({ type: "char", char: merged, id: cid });
        continue;
      }

      // ── PTs ANTIGAS (sem snapshot) ────────────────────────────────────────
      // Criadas antes desta mudança. Mantêm o comportamento anterior; o
      // efeito de backfill logo abaixo grava o snapshot que falta.
      if (live) { slotMembers.push({ type: "char", char: live, id: cid }); continue; }
      const wt = waitingList.find(w => w.id === cid);
      if (wt) { slotMembers.push({ type: "waiting", waiting: wt, id: cid }); continue; }
    }
    const ci = i - party.selectedIds.length;
    if (ci >= 0 && ci < customs.length) slotMembers.push({ type: "custom", custom: customs[ci], id: customs[ci].id });
    else slotMembers.push({ type: "empty", id: "" });
  }

  const allMemberIds = slotMembers.filter(s => s.type !== "empty").map(s => s.id);

  // Contas REALMENTE duplicadas na PT (mesmo dono + mesmo nome). Antes o
  // agrupamento era por nome, então dois usuários com a conta "1" apareciam
  // marcados como duplicados sem ser.
  const duplicateAccounts = useMemo(() => {
    const accCounts: Record<string, number> = {};
    slotMembers.forEach(s => {
      if (s.type === "char") {
        const key = getCharacterAccountKey(s.char);
        if (key) accCounts[key] = (accCounts[key] || 0) + 1;
      }
    });
    return new Set(Object.keys(accCounts).filter(a => accCounts[a] > 1));
  }, [slotMembers]);

  const totalDeaths = allMemberIds.reduce((s, id) => s + getSD(id).deaths, 0);
  const totalItemVendidoGeral = allMemberIds.reduce((s, id) => s + getSD(id).itemVendido, 0);
  const splitMembers = allMemberIds.filter(id => getSD(id).split);
  const allSplitHaveRC = splitMembers.every(sid => {
    const slot = getSD(sid);
    const rRaw = calcRateKkDrafts[sid] !== undefined ? calcRateKkDrafts[sid] : formatRateKkDisplay(slot.calcRateKk);
    const tRaw = calcTotalKkDrafts[sid] !== undefined ? calcTotalKkDrafts[sid] : (slot.calcTotalKk ? String(slot.calcTotalKk) : "");
    const lCalc = computeItemRC(parseRateKk(rRaw), parseInt(tRaw, 10) || 0);
    const rcVal = rcDrafts[sid] !== undefined ? (parseInt(rcDrafts[sid], 10) || 0) : (slot.itemVendido || 0);
    return (lCalc > 0 ? lCalc : rcVal) > 0;
  });
  const allSplitPaid = splitMembers.length > 0 && splitMembers.every(id => getSD(id).pago);
  const splitCount = splitMembers.length;

  const splitItemVendido = splitMembers.reduce((s, id) => s + getSD(id).itemVendido, 0);
  // ── VALOR INDIVIDUAL DA DIVISÃO ───────────────────────────────────────────
  // Ajustado ao MÚLTIPLO DE 25 pela regra do corte em 10 (`roundSplitTo25`):
  // para baixo quando faltam MAIS de 10 unidades para o múltiplo superior,
  // para cima quando faltam 10 ou menos. Regra EXCLUSIVA da divisão — o valor
  // individual da venda (`computeItemRC`) usa floor simples ao inteiro.
  //
  // Esta é a ÚNICA fonte do valor individual: alimenta o rodapé da guia, o
  // valor levado à confirmação de pagamento e o texto do "Copiar (WA)". Com
  // isso os três exibem o mesmo número por construção.
  //
  // Os valores BRUTOS das vendas não são tocados — apenas o resultado final
  // da divisão.
  const dropPerSplit = splitCount > 0 ? roundSplitTo25(splitItemVendido / splitCount) : 0;
  const splitMembersWithUnsoldItems = splitMembers.filter(id => { const d = getSD(id); return !!d.itemDropado && (!d.itemVendido || d.itemVendido <= 0); });
  const allSplitItemsSold = splitMembersWithUnsoldItems.length === 0;
  const splitNames = splitMembers.map(id => {
    const s = slotMembers.find(m => m.id === id);
    if (!s || s.type === "empty") return "?";
    const d = getSD(id);
    // Com destinatário escolhido, é ele que aparece na lista "Dividir:".
    // Sem escolha, mantém-se a resolução original (jogador -> rótulo do slot).
    if (resolveSplitTarget(d) === "player") return getSlotPlayerName(d, "?");
    if (d.splitTarget === "owner" && d.owner) return d.owner;
    if (d.player) return d.player;
    if (s.type === "custom") return s.custom.label;
    if (s.type === "waiting") return s.waiting.personagem || "?";
    return accountLabelFor(s.char) || "?";
  });

  // Classificação de lucro pelos drops da PT — regra centralizada em
  // src/utils/profitClassification.ts (mesma função usada pelo histórico
  // privado; antes a tabela de scores/thresholds vivia inline aqui).
  const dropClassification = useMemo(
    () => classifyDroppedItems(allMemberIds.map(id => getSD(id).itemDropado)),
    [allMemberIds, sd],
  );

  function SI({ col }: { col: string }) {
    if (sortKey === col && sortDir === "asc") return <ArrowUp size={12} className="text-emerald-400" />;
    if (sortKey === col && sortDir === "desc") return <ArrowDown size={12} className="text-emerald-400" />;
    return <ArrowUpDown size={12} className="opacity-30" />;
  }

  const thCls = "bg-[var(--th-bg-overlay)] px-3 py-1.5 border-b border-[var(--th-line)]/80 cursor-pointer hover:bg-[var(--th-bg-hover)] select-none";
  const hdr = "flex items-center gap-1.5 text-xs uppercase tracking-wider text-slate-300 font-semibold";

  const slotCols = [
    { k: "#", al: "center", l: "#" },
    { k: "conta", al: "center", l: "Conta" },
    { k: "personagem", al: "center", l: "Personagem" },
    { k: "servidor", al: "center", l: "Servidor" },
    { k: "voc", al: "center", l: "Voc" },
    { k: "level", al: "center", l: "Level" },
    { k: "dono", al: "center", l: "Dono" },
    { k: "jogador", al: "center", l: "Jogador" },
    { k: "mortes", al: "center", l: "Mortes" },
    { k: "dividir", al: "center", l: "Dividir" },
    { k: "itemDropado", al: "center", l: "Item Dropado" },
    { k: "itemVendido", al: "center", l: "Item Vendido/Service (RC)" },
    { k: "pago", al: "center", l: "PG" },
    { k: "anotacoes", al: "center", l: "Anotações" },
    { k: "whatsapp", al: "center", l: "WhatsApp" },
    { k: "streaming", al: "center", l: "Streaming" },
    { k: "x", al: "center", l: "" },
    { k: "_spacer", al: "center", l: "" },
  ];
  const totalSlotCols = slotCols.length;
  const ptTypeBadge = party.ptType === "sanguine"
    ? <span className="px-2 py-0.5 rounded text-[10px] font-bold border border-rose-500/50 bg-rose-500/20 text-rose-300">SANGUINE</span>
    : party.ptType === "soulwar"
      ? <span className="px-2 py-0.5 rounded text-[10px] font-bold border border-slate-400/50 bg-slate-500/20 text-slate-200">SOULWAR</span>
      : null;

  return (
    <div className="flex flex-col h-full bg-[var(--th-n-deep)] text-sm overflow-hidden rounded-xl border border-[var(--th-line)]/80">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1 bg-gradient-to-r from-[var(--th-bg-raised)] to-[var(--th-bg-base)] border-b border-[var(--th-line)]/60 flex-shrink-0">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          {ptTypeBadge && (
            <div>{ptTypeBadge}</div>
          )}
          {party.servidor && (
            <>
              {ptTypeBadge && <span className="h-5 w-px bg-white/10" />}
              {editingServer && (party.leaderUid === currentUser?.uid || party.LeaderPT === userName) ? (
                <div className="flex items-center gap-1">
                  <select
                    value={serverValue}
                    onChange={e => {
                      const nextValue = e.target.value;
                      setServerValue(nextValue);
                      commitServerValue(nextValue);
                      setEditingServer(false);
                    }}
                    onBlur={() => {
                      setEditingServer(false);
                    }}
                    className="bg-black/80 border border-sky-500/40 rounded px-1.5 py-0.5 text-[10px] text-sky-300 font-bold focus:outline-none w-28 cursor-pointer"
                    autoFocus
                  >
                    <option value="" disabled>Selecione...</option>
                    {CREATE_PT_SERVERS.map(srv => (
                      <option key={srv} value={srv} className="bg-[var(--th-n-hi)] text-slate-300 font-semibold">{srv}</option>
                    ))}
                  </select>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    if (party.leaderUid === currentUser?.uid || party.LeaderPT === userName) {
                      setServerValue(party.servidor || "");
                      setEditingServer(true);
                    }
                  }}
                  className={`px-1.5 py-0.5 rounded text-[10px] font-bold border transition-colors whitespace-nowrap ${
                    (party.leaderUid === currentUser?.uid || party.LeaderPT === userName)
                      ? "border-sky-500/30 bg-sky-500/10 text-sky-300 hover:bg-sky-500/20 hover:border-sky-500/50"
                      : "border-sky-500/20 bg-sky-500/5 text-sky-400 cursor-default"
                  }`}
                  title={
                    (party.leaderUid === currentUser?.uid || party.LeaderPT === userName)
                      ? "Clique para editar o servidor"
                      : "Servidor da PT"
                  }
                >
                  {serverLabel(party.servidor)}
                </button>
              )}
            </>
          )}
          {party.createdAt && (
            <>
              <span className="h-5 w-px bg-white/10" />
              <span className="text-xs font-semibold text-slate-400 whitespace-nowrap">
                {new Date(party.createdAt).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}
                {party.LeaderPT ? <> • {isLeaderPT && !party.questConcluida
                  ? <button
                      type="button"
                      onClick={() => setShowTransferLeader(true)}
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-red-500/40 bg-red-500/15 text-red-300 hover:bg-red-500/25 transition-colors text-[9px] font-bold cursor-pointer"
                      title="Transferir Liderança"
                    >
                      <span className="truncate max-w-[80px]">{party.LeaderPT}</span>
                      <Users size={8} />
                    </button>
                  : <span className="text-slate-300 font-medium">Líder: {party.LeaderPT}</span>
                }</> : ""}
              </span>
            </>
          )}
          {/* Botão Att Chars - visível apenas após quest concluída e enquanto PT não finalizada */}
          {onSaveParty && party.questConcluida && !party.isLocked && !isPausedActive && !party.pagamentoFeito && (
            <>
              <span className="h-5 w-px bg-white/10" />
              <button
                onClick={() => requestConfirm("saveParty", () => onSaveParty(party))}
                className={`px-2 py-0.5 rounded text-[10px] font-bold border transition-colors whitespace-nowrap ${
                  confirmingButton === "saveParty"
                    ? "border-amber-400 bg-amber-500/30 text-amber-200 animate-pulse shadow-md shadow-amber-500/30"
                    : "border-blue-500/40 bg-blue-500/15 text-blue-300 hover:bg-blue-500/25"
                }`}
                title={
                  confirmingButton === "saveParty"
                    ? "Clique novamente para confirmar"
                    : "Atualiza todos os dados da sua lista de personagens automaticamente"
                }
              >
                {confirmingButton === "saveParty" ? "✓ Confirmar?" : "Att Chars"}
              </button>
            </>
          )}
          {/* Botão Iniciar/Concluir Quest - visível apenas quando aplicável */}
          {canStartQuest && !isLocked && !isPausedActive && !party.questConcluida && !party.questFalha && (
            <>
              <span className="h-5 w-px bg-white/10" />
              {!party.ptStartedAt ? (
                /* Iniciar Quest - visível apenas quando PT está cheia */
                isFull && (
                  <button
                    onClick={handleQuestTimerClick}
                    className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-bold border transition-colors whitespace-nowrap ${
                      confirmingButton === "startQuest"
                        ? "border-amber-400 bg-amber-500/30 text-amber-200 animate-pulse shadow-md shadow-amber-500/30"
                        : "border-sky-500/40 bg-sky-500/15 text-sky-300 hover:bg-sky-500/25"
                    }`}
                    title={confirmingButton === "startQuest" ? "Clique novamente para confirmar Iniciar Quest" : "Iniciar Quest — começa o cronômetro"}
                  >
                    {confirmingButton === "startQuest" ? <><Play size={12} /> ✓ Confirmar Iniciar?</> : <><Play size={12} /> Iniciar Quest</>}
                  </button>
                )
              ) : (
                /* Concluir Quest - visível durante a quest */
                <button
                  onClick={handleQuestTimerClick}
                  disabled={isConcludingQuest}
                  className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-bold border transition-colors whitespace-nowrap disabled:opacity-60 disabled:cursor-not-allowed ${
                    confirmingButton === "endQuest"
                      ? "border-emerald-400 bg-emerald-500/30 text-emerald-100 animate-pulse shadow-md shadow-emerald-500/30"
                      : "border-emerald-500/40 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
                  }`}
                  title={isConcludingQuest
                    ? "Salvando os dados dos participantes antes de concluir..."
                    : confirmingButton === "endQuest" ? "Clique novamente para confirmar Concluir Quest" : "Concluir Quest e salvar duração"}
                >
                  {isConcludingQuest
                    ? <><Clock size={12} className="animate-spin" /> Salvando participantes...</>
                    : confirmingButton === "endQuest"
                      ? <><Clock size={12} /> ✓ Confirmar Concluir?</>
                      : <><Clock size={12} className="animate-pulse" /> Concluir Quest</>}
                </button>
              )}
            </>
          )}
          {/* Quest Finalizada badge */}
          {party.questConcluida && (
            <>
              <span className="h-5 w-px bg-white/10" />
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-bold border border-emerald-500/40 bg-emerald-500/15 text-emerald-300 whitespace-nowrap">
                <Clock size={12} /> Quest Finalizada
              </span>
            </>
          )}
          {/* BOTÃO TRANCAR / LIBERAR - Apenas líder pode ver */}
          {isLeaderPT && isFull && !party.ptStartedAt && (
            <>
              <span className="h-5 w-px bg-white/10" />
              <button
                onClick={() => onUpdate({ ...party, isLocked: !party.isLocked })}
                disabled={isPausedActive}
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold border transition-colors whitespace-nowrap cursor-pointer disabled:opacity-30 disabled:pointer-events-none ${
                  party.isLocked
                    ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
                    : "border-amber-500/40 bg-amber-500/15 text-amber-300 hover:bg-amber-500/25"
                }`}
                title={party.isLocked ? "Liberar edição da PT" : "Trancar PT (bloqueia remoções e alterações)"}
              >
                <Lock size={12} /> {party.isLocked ? "Liberar" : "Trancar"}
              </button>
            </>
          )}
          {/* Botões Falha e Pausar - visíveis apenas para líder durante quest ativa */}
          {isLeaderPT && party.ptStartedAt && !party.questConcluida && !party.questFalha && !isPausedActive && (
            <>
              <span className="h-5 w-px bg-white/10" />
              <button
                disabled={isFinalizationRequested}
                onClick={() => {
                  customConfirm("Marcar esta PT como FALHA? O backend criará o histórico privado e encerrará a PT com segurança.", () => {
                    void requestBackendFinalization("quest_failed");
                  });
                }}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold border border-rose-500/40 bg-rose-500/15 text-rose-300 hover:bg-rose-500/25 transition-colors whitespace-nowrap cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                title="Marcar como Falha"
              >
                <X size={12} /> Falha
              </button>
              <button
                onClick={() => setIsPauseModalOpen(true)}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold border border-amber-500/40 bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 transition-colors whitespace-nowrap cursor-pointer"
                title="Pausar a quest (bloquear edição de todos)"
              >
                ⏸ Pausar
              </button>
            </>
          )}
          {/* Botão Retomar - visível apenas para líder quando pausada */}
          {isLeaderPT && party.isPaused && (
            <>
              <span className="h-5 w-px bg-white/10" />
              <button
                onClick={resumeParty}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold border border-emerald-500/40 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 transition-colors whitespace-nowrap cursor-pointer"
                title="Retomar a quest (reativar edição)"
              >
                ▶ Retomar
              </button>
            </>
          )}
          {party.questFalha && (
            <>
              <span className="h-5 w-px bg-white/10" />
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold border border-rose-500/50 bg-rose-500/20 text-rose-300 whitespace-nowrap">
                <X size={12} /> QUEST FALHOU
              </span>
            </>
          )}
          {/* BOTÃO "SALVAR DROPS" (adicionado) */}
          {party.questConcluida && !party.questFalha && (
            <>
              <span className="h-5 w-px bg-white/10" />
              <button
                onClick={() => {
                  customConfirm("Deseja salvar permanentemente os dados de Drop e Valor (calculadora kk/RC)? Estes dados não poderão ser alterados após esta ação.", () => {
                    const updatedSlotData = { ...party.slotData };
                    Object.keys(updatedSlotData).forEach(id => {
                      const currentSlot = updatedSlotData[id] as ExtendedPartySlotData;
                      // Merge dos drafts PENDENTES (kk>RC, kk e RC) para salvar o valor mais recente.
                      // Apenas campos com dados preenchidos são salvos/travados.
                      const rateKk = calcRateKkDrafts[id] !== undefined ? parseRateKk(calcRateKkDrafts[id]) : (currentSlot.calcRateKk || 0);
                      const totalKk = calcTotalKkDrafts[id] !== undefined ? parseInt(calcTotalKkDrafts[id], 10) || 0 : (currentSlot.calcTotalKk || 0);
                      const manualRc = rcDrafts[id] !== undefined ? parseInt(rcDrafts[id], 10) || 0 : (currentSlot.itemVendido || 0);
                      const computedRc = computeItemRC(rateKk, totalKk);
                      const rc = computedRc > 0 ? computedRc : manualRc;

                      const hasDrop = !!currentSlot.itemDropado;
                      const hasRate = rateKk > 0;
                      const hasTotal = totalKk > 0;
                      const hasRc = rc > 0;

                      if (hasDrop || hasRate || hasTotal || hasRc) {
                        updatedSlotData[id] = {
                          ...currentSlot,
                          ...(hasRate ? { calcRateKk: rateKk } : {}),
                          ...(hasTotal ? { calcTotalKk: totalKk } : {}),
                          ...(hasRc ? {
                            itemVendido: rc,
                            itemVendidoLocked: true,
                            calcRateKkLocked: true,
                            calcTotalKkLocked: true
                          } : {}),
                          ...(!hasRc && hasRate ? { calcRateKkLocked: true } : {}),
                          ...(!hasRc && hasTotal ? { calcTotalKkLocked: true } : {}),
                          ...(hasDrop ? { dropLocked: true } : {}),
                        } as ExtendedPartySlotData;
                      }
                    });
                    // Limpa os drafts porque os valores foram persistidos/travados
                    setCalcRateKkDrafts({});
                    setCalcTotalKkDrafts({});
                    setRcDrafts({});
                    const updatedPartyObj = { ...party, slotData: updatedSlotData };
                    onUpdate(updatedPartyObj);
                    sendDropValueSavedNotifications(updatedPartyObj);
                  });
                }}
                disabled={!!party.isLocked || isPausedActive || (() => {
                  // Desabilita quando não há NENHUM dado preenchido ainda desbloqueado
                  const hasUnlockedDrafts =
                    Object.entries(calcRateKkDrafts).some(([id, v]) => {
                      const slot = (party.slotData || {})[id] as ExtendedPartySlotData | undefined;
                      return (parseInt(v, 10) || 0) > 0 && !slot?.calcLocked && !slot?.calcRateKkLocked;
                    }) ||
                    Object.entries(calcTotalKkDrafts).some(([id, v]) => {
                      const slot = (party.slotData || {})[id] as ExtendedPartySlotData | undefined;
                      return (parseInt(v, 10) || 0) > 0 && !slot?.calcLocked && !slot?.calcTotalKkLocked;
                    }) ||
                    Object.entries(rcDrafts).some(([id, v]) => {
                      const slot = (party.slotData || {})[id] as ExtendedPartySlotData | undefined;
                      return (parseInt(v, 10) || 0) > 0 && !slot?.calcLocked && !slot?.itemVendidoLocked;
                    });
                  if (hasUnlockedDrafts) return false;
                  return !Object.values(party.slotData || {}).some(s => {
                    const es = s as ExtendedPartySlotData;
                    const hasDrop = !!s.itemDropado && !s.dropLocked;
                    const hasRate = !es.calcLocked && !es.calcRateKkLocked && !!es.calcRateKk;
                    const hasTotal = !es.calcLocked && !es.calcTotalKkLocked && !!es.calcTotalKk;
                    const hasRC = !es.calcLocked && !es.itemVendidoLocked && !!s.itemVendido;
                    return hasDrop || hasRate || hasTotal || hasRC;
                  });
                })()}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold border border-emerald-500/40 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 transition-colors whitespace-nowrap cursor-pointer disabled:opacity-30 disabled:pointer-events-none"
                title="Salva permanentemente os dados de Drop e Valor (calculadora kk/RC) da PT (não poderá ser alterado depois)"
              >
                <Lock size={12} /> Salvar Drop/Valor
              </button>
            </>
          )}
          {/* BOTÃO "COPIAR (WA)" — visível apenas após quest finalizada */}
          {party.questConcluida && !party.questFalha && (
            <>
              <span className="h-5 w-px bg-white/10" />
              <button
                onClick={copyWhatsAppSummary}
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold border transition-colors whitespace-nowrap cursor-pointer ${
                  whatsappCopied
                    ? "bg-emerald-500/30 border-emerald-500/50 text-emerald-200"
                    : "bg-sky-500/15 border-sky-500/40 text-sky-300 hover:bg-sky-500/25 hover:text-sky-200"
                }`}
                title={whatsappCopied ? "Texto copiado!" : "Copiar resumo da PT para o WhatsApp"}
              >
                {whatsappCopied ? <Check size={12} /> : <ExternalLink size={12} />} {whatsappCopied ? "Copiado!" : "Copiar (WA)"}
              </button>
            </>
          )}
          <span className="h-5 w-px bg-white/10" />
          <div className="flex flex-wrap items-center gap-2 text-[10px] text-slate-400">
            <span className="font-semibold text-slate-300 whitespace-nowrap inline-flex items-center gap-1.5">
              Horário Combinado:{" "}
              <span className="text-emerald-400">{formatHorario(party)}</span>
              {/* Botão Alterar Horário - visível apenas quando permitido */}
              {canEditPT && !isLocked && !isQuestLocked && !(!!party.ptStartedAt && !isPausedActive) && (
                <button
                  type="button"
                  onClick={openEditHorario}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-sky-500/30 bg-sky-500/10 text-sky-300 hover:bg-sky-500/20 hover:border-sky-500/50 hover:text-sky-200 transition-colors text-[9px] font-bold uppercase tracking-wider cursor-pointer"
                  title="Alterar horário combinado"
                >
                  <Pencil size={9} /> Alterar
                </button>
              )}
            </span>
            {party.ptStartedAt && <span className="h-4 w-px bg-white/10" />}
            {party.ptStartedAt && (
              <span className="whitespace-nowrap">Iniciada as: <span className="text-white">{new Date(party.ptStartedAt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span></span>
            )}
            {party.ptStartedAt && <span className="h-4 w-px bg-white/10" />}
            {party.ptStartedAt && (
              <span className="whitespace-nowrap">
                Duração: <span className="text-sky-300 font-semibold tabular-nums">{formatDuration(party.questConcluida && party.ptDuration ? party.ptDuration : elapsedMs)}</span>
                {/* Pausada: deixa explícito que o relógio parou. */}
                {isPausedActive && !party.questConcluida && (
                  <span className="ml-1 text-amber-400 font-bold" title="A contagem está parada enquanto a PT estiver pausada.">(pausada)</span>
                )}
              </span>
            )}

            {/* ── BOSS DA PAUSA ATUAL ───────────────────────────────────────
                Os dados vêm da PT no Firestore, mas só aparecem enquanto ela
                está pausada. Retomar limpa o estado persistido, evitando que
                um badge antigo reapareça em refresh ou ao reabrir o painel. */}
            {cooldownInfo && (
              <>
                <span className="h-4 w-px bg-white/10" />
                <span
                  className="whitespace-nowrap"
                  title={cooldownInfo.ignored
                    ? `Pausada em ${cooldownInfo.label} sem aplicar cooldown.`
                    : `Pausada em ${cooldownInfo.label}. Cooldown até ${new Date(cooldownInfo.endsAt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}.`}
                >
                  {cooldownInfo.ignored || cooldownInfo.isDone ? (
                    <span className="inline-flex items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 font-bold text-emerald-300">
                      Cooldown: {cooldownInfo.label} — Disponível
                    </span>
                  ) : (
                    <>
                      Cooldown:{" "}
                      <span className="font-semibold text-amber-300">{cooldownInfo.label}</span>
                      <span className="text-slate-400"> — {formatCooldownRemaining(cooldownInfo.remaining)}</span>
                    </>
                  )}
                </span>
              </>
            )}
            {party.questConcluida && party.ptStartedAt && party.ptDuration && <span className="h-4 w-px bg-white/10" />}
            {party.questConcluida && party.ptStartedAt && party.ptDuration && (
              <span className="whitespace-nowrap">Concluída as: <span className="text-white">{new Date(party.ptStartedAt + party.ptDuration).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span></span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {party.visibility === "private" && (party.leaderUid === currentUser?.uid || party.LeaderPT === userName) && (
            <button
              onClick={() => setShowEditInvites(true)}
              disabled={isTrulyLockedForActions || isPausedActive}
              className="px-2 py-1 rounded hover:bg-amber-500/15 text-amber-400 hover:text-amber-300 text-xs flex items-center gap-1 border border-amber-500/20 disabled:opacity-30 disabled:pointer-events-none"
              title="Editar usuários autorizados a visualizar esta PT Privada"
            >
              <Users size={12} /> Convidados
            </button>
          )}
          {/* Botão Externo - visível apenas quando pode adicionar membros */}
          {(isLeaderPT || canEditPT) && canOrganizeParty && (
            <button onClick={() => setShowAddCustom(v => !v)} className="px-2 py-1 rounded hover:bg-emerald-500/15 text-emerald-400 hover:text-emerald-300 text-xs flex items-center gap-1 border border-emerald-500/20" title="Adicionar membro externo"><UserPlus size={12} /> Externo</button>
          )}
          {/* Botões +Slot/-Slot - visíveis apenas quando pode alterar slots */}
          {(isLeaderPT || canEditPT) && canOrganizeParty && (
            <>
              <button onClick={addSlot} className="px-2 py-1 rounded hover:bg-sky-500/15 text-sky-400 hover:text-sky-300 text-xs flex items-center gap-0.5 border border-sky-500/20"><Plus size={11} />Slot</button>
              {party.slots > 2 && (
                <button onClick={removeSlot} className="px-2 py-1 rounded hover:bg-rose-500/15 text-rose-400 hover:text-rose-300 text-xs flex items-center gap-0.5 border border-rose-500/20"><Minus size={11} />Slot</button>
              )}
            </>
          )}
          {/* Botão Excluir PT - visível apenas para líder antes do início */}
          {isLeaderPT && canOrganizeParty && (
            <button
              onClick={() => { onDelete(); }}
              className="px-2 py-1 rounded text-xs flex items-center gap-0.5 border transition-colors text-rose-400 hover:text-rose-300 bg-rose-500/10 hover:bg-rose-500/20 border-rose-500/30 ml-1"
              title="Excluir PT"
            >
              Excluir PT
            </button>
          )}
        </div>
      </div>

      {showTransferLeader && !party.questConcluida && (
        <div className="app-modal-overlay fixed inset-0 z-[50] flex items-center justify-center bg-black/75 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowTransferLeader(false); }}>
          <div className="app-modal-frame app-modal-size-xs app-modal-frame--scroll bg-[var(--th-n-hi)] border border-white/10 rounded-2xl shadow-2xl w-full max-w-sm">
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/5 bg-[var(--th-n-hi)]">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-red-500/20 border border-red-500/40 flex items-center justify-center">
                  <Users size={16} className="text-red-400" />
                </div>
                <h3 className="text-base font-bold text-white tracking-wide">Transferir Liderança</h3>
              </div>
              <button type="button" onClick={() => setShowTransferLeader(false)} className="text-slate-400 hover:text-white p-1.5 rounded-lg hover:bg-white/5 transition-colors cursor-pointer">
                <X size={16} />
              </button>
            </div>
            <div className="app-modal-body p-4 space-y-2">
              {(() => {
                const membersMap = new Map<string, string | undefined>();
                allMemberIds.forEach(id => {
                  const s = slotMembers.find(m => m.id === id);
                  const d = getSD(id);
                  if (s && s.type !== "empty") {
                    if (s.type === "custom") membersMap.set(s.custom.label, d.ownerUid || approvedUsers.find(u => u.nome === s.custom.label)?.uid);
                    else if (s.type === "waiting") membersMap.set(s.waiting.ownerName, (s.waiting as any).ownerUid || d.ownerUid || approvedUsers.find(u => u.nome === s.waiting.ownerName)?.uid);
                    else if (s.type === "char") membersMap.set(getCharOwner(s.char), s.char.ownerUid || d.ownerUid || approvedUsers.find(u => u.nome === getCharOwner(s.char))?.uid);
                  }
                });
                const membersList = Array.from(membersMap.entries()).filter(([name]) => name && name !== "—").sort((a, b) => a[0].localeCompare(b[0], "pt-BR", { sensitivity: "base" }));
                if (membersList.length === 0) {
                  return <p className="text-xs text-slate-500 text-center py-4 italic">Nenhum participante encontrado nesta PT.</p>;
                }
                return membersList.map(([name, uid]) => (
                  <button
                    key={name}
                    type="button"
                    onClick={() => {
                      customConfirm(`Transferir a liderança da PT "${party.name}" para ${name}?`, () => {
                        const targetLeaderUid = uid || approvedUsers.find(u => u.nome === name)?.uid;
                        if (!targetLeaderUid) {
                          customAlert("Não foi possível identificar o usuário selecionado para transferir a liderança.");
                          return;
                        }
                        onUpdate({ ...party, LeaderPT: name, leaderUid: targetLeaderUid });
                        setShowTransferLeader(false);
                      });
                    }}
                    className={`w-full px-3 py-2 rounded-lg border text-xs text-left transition-colors cursor-pointer ${
                      name === party.LeaderPT
                        ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
                        : "border-white/10 bg-white/[0.03] text-slate-300 hover:bg-white/5 hover:text-white"
                    }`}
                  >
                    {name}
                    {name === party.LeaderPT && <span className="ml-1 text-[9px] text-amber-400">(atual líder)</span>}
                  </button>
                ));
              })()}
            </div>
          </div>
        </div>
      )}

      {showAddCustom && (
        <div className="px-3 py-2 bg-violet-500/[0.06] border-b border-violet-500/20 flex flex-wrap items-end gap-2 flex-shrink-0">
          <div><div className="text-[10px] text-slate-500 uppercase mb-0.5">Nome</div><input type="text" value={customForm.label} onChange={e => setCustomForm(f => ({ ...f, label: e.target.value }))} placeholder="Nick" className="ipt py-1.5 px-2 text-sm w-36" maxLength={20} /></div>
          <div><div className="text-[10px] text-slate-500 uppercase mb-0.5">Dono <span className="text-violet-400" title="Campo obrigatório">*</span></div><input type="text" value={customForm.ownerName || ""} onChange={e => setCustomForm(f => ({ ...f, ownerName: e.target.value }))} placeholder="Nome do dono do personagem" className="ipt py-1.5 px-2 text-sm w-44" maxLength={20} /></div>
          <div><div className="text-[10px] text-slate-500 uppercase mb-0.5">Voc</div><select value={customForm.voc} onChange={e => setCustomForm(f => ({ ...f, voc: e.target.value as Vocation }))} className="filter-select h-[32px] w-16">{VOCATIONS.map(v => <option key={v} value={v}>{v}</option>)}</select></div>
          <div><div className="text-[10px] text-slate-500 uppercase mb-0.5">Level</div><input type="text" inputMode="numeric" value={customForm.level || ""} onChange={e => setCustomForm(f => ({ ...f, level: parseInt(e.target.value) || 0 }))} placeholder="0" className="ipt py-1.5 px-2 text-sm w-20 text-right" /></div>
          <button onClick={addCustomMemberToParty} disabled={!customForm.label.trim() || !(customForm.ownerName || "").trim() || isFull} className="px-3 py-1.5 rounded-lg bg-violet-500 hover:bg-violet-400 text-white text-xs font-semibold disabled:opacity-40">Adicionar</button>
          <button onClick={() => setShowAddCustom(false)} className="px-2 py-1.5 rounded-lg border border-white/10 text-slate-400 hover:text-white text-xs">Cancelar</button>
        </div>
      )}

      {showEditHorario && createPortal(
        <div
          className="app-modal-overlay fixed inset-0 z-[400] flex items-center justify-center bg-black/80 backdrop-blur-sm"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setShowEditHorario(false); }}
        >
          <div className="app-modal-frame app-modal-size-xs app-modal-frame--scroll bg-[var(--th-n-deep)] border border-[var(--th-line)] rounded-2xl shadow-[0_0_40px_color-mix(in_oklab,var(--th-brand)_30%,transparent)] w-full max-w-sm">
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-[var(--th-line)]/50 bg-[var(--th-n-deep)]">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-amber-900/25 border border-amber-700/40 flex items-center justify-center">
                  <Clock size={16} className="text-amber-500" />
                </div>
                <h3 className="text-base font-bold text-white tracking-wide">Alterar Horário</h3>
              </div>
              <button
                type="button"
                onClick={() => setShowEditHorario(false)}
                className="text-slate-400 hover:text-white p-1.5 rounded-lg hover:bg-red-900/20 transition-colors cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] text-red-400/80 uppercase tracking-wider mb-1.5 font-bold">Data</label>
                  <input
                    type="date"
                    value={editDataValue}
                    onChange={(e) => setEditDataValue(e.target.value)}
                    className="w-full bg-black/40 border border-red-900/30 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-red-700/60 text-sm [color-scheme:dark] transition-colors"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveEditHorario();
                      if (e.key === "Escape") setShowEditHorario(false);
                    }}
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-red-400/80 uppercase tracking-wider mb-1.5 font-bold">Hora</label>
                  <input
                    type="time"
                    value={editHoraValue}
                    onChange={(e) => setEditHoraValue(e.target.value)}
                    autoFocus
                    className="w-full bg-black/40 border border-red-900/30 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-red-700/60 text-sm [color-scheme:dark] transition-colors"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveEditHorario();
                      if (e.key === "Escape") setShowEditHorario(false);
                    }}
                  />
                </div>
              </div>
              <div>
                <div className="text-[10px] text-slate-500 mt-1.5">
                  {editHoraValue
                    ? "Todos os participantes da PT receberão uma notificação sobre a alteração."
                    : "Deixe a HORA em branco para remover o horário (\"Sem hora marcada\")."}
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2 border-t border-red-900/20">
                <button
                  type="button"
                  onClick={() => setShowEditHorario(false)}
                  className="px-4 py-2 rounded-lg border border-red-900/30 text-slate-400 hover:text-white hover:bg-red-900/20 text-xs font-semibold transition-colors cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={saveEditHorario}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-gradient-to-r from-[var(--th-brand-mid)] to-[var(--th-line)] hover:from-[var(--th-brand-bright)] hover:to-[var(--th-line-strong)] text-white text-xs font-bold shadow-lg shadow-red-900/20 transition-colors cursor-pointer border border-[var(--th-brand-mid)]/60"
                >
                  <Check size={13} /> Salvar
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {showEditInvites && createPortal(
        <div
          className="app-modal-overlay fixed inset-0 z-[400] flex items-center justify-center bg-black/70 backdrop-blur-sm"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setShowEditInvites(false); }}
        >
          <div className="app-modal-frame app-modal-size-xs app-modal-frame--scroll bg-[var(--th-n-hi)] border border-white/10 rounded-2xl shadow-2xl w-full max-w-sm">
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/5 bg-[var(--th-n-elev)] flex-shrink-0">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-amber-500/20 border border-amber-500/40 flex items-center justify-center">
                  <Users size={16} className="text-amber-400" />
                </div>
                <h3 className="text-sm font-bold text-white tracking-wide">Editar Convidados</h3>
              </div>
              <button
                type="button"
                onClick={() => setShowEditInvites(false)}
                className="text-slate-400 hover:text-white p-1.5 rounded-lg hover:bg-white/5 transition-colors cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>

            <div className="px-3 pt-3 pb-1 flex-shrink-0">
              <input
                type="text"
                value={inviteSearch}
                onChange={(e) => setInviteSearch(e.target.value)}
                placeholder="Pesquisar usuário..."
                className="w-full bg-[var(--th-n-panel)] border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-amber-500/50 placeholder-slate-650 transition-colors"
              />
            </div>
            <div className="app-modal-body p-3 space-y-1">
              {(() => {
                const sorted = [...approvedUsers].sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR", { sensitivity: "base" }));
                const filtered = inviteSearch.trim()
                  ? sorted.filter(u => u.nome.toLowerCase().includes(inviteSearch.toLowerCase()))
                  : sorted;
                if (filtered.length === 0) {
                  return <div className="p-4 text-center text-slate-500 text-sm italic">{approvedUsers.length === 0 ? "Nenhum usuário aprovado encontrado." : "Nenhum resultado para a pesquisa."}</div>;
                }
                return filtered.map(user => {
                  const isSelf = user.uid === currentUser?.uid;
                  const isChecked = isSelf || tempInvites.includes(user.uid);
                  return (
                    <label key={user.uid} className={`flex items-center gap-3 p-2 rounded-lg transition-colors ${isSelf ? "opacity-50 cursor-not-allowed bg-white/5" : "hover:bg-white/5 cursor-pointer"}`}>
                      <input
                        type="checkbox"
                        checked={isChecked}
                        disabled={isSelf}
                        onChange={(e) => {
                          if (isSelf) return;
                          if (e.target.checked) setTempInvites([...tempInvites, user.uid]);
                          else setTempInvites(tempInvites.filter(id => id !== user.uid));
                        }}
                        className="w-4 h-4 accent-amber-500 rounded cursor-pointer"
                      />
                      <span className="text-sm text-slate-300 font-medium truncate">{user.nome}</span>
                      {isSelf && <span className="text-[10px] text-amber-400 font-bold ml-auto">(Você)</span>}
                    </label>
                  );
                });
              })()}
            </div>

            <div className="p-4 border-t border-white/5 bg-[var(--th-n-elev)] space-y-3 flex-shrink-0">
              <div className="text-[10px] text-slate-500 leading-relaxed">
                <span className="text-amber-400 font-semibold">Atenção:</span> Desmarcar um usuário removerá automaticamente todos os personagens dele que estiverem na PT.
              </div>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setShowEditInvites(false)}
                  className="flex-1 py-2 rounded-lg border border-white/10 text-slate-400 hover:text-white hover:bg-white/5 text-xs font-semibold transition-colors cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={saveInvites}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-black text-xs font-bold shadow-lg shadow-amber-500/20 transition-colors cursor-pointer"
                >
                  <Check size={13} /> Salvar
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      <CharacterAcquisitionModal
        open={!!characterSalePrompt}
        context={characterSalePrompt as CharacterAcquisitionModalContext | null}
        onClose={() => setCharacterSalePrompt(null)}
        onConfirm={async ({ originalCharacterCost, personalFee }) => {
          const prompt = characterSalePrompt;
          if (!prompt || !onCreateCharacterAcquisition) return { ok: false, error: "A negociação não está disponível neste momento." };
          const result = await onCreateCharacterAcquisition({
            partyId: party.id,
            characterId: prompt.characterId,
            originalCharacterCost,
            personalFee,
          });
          if (result.ok) setCharacterSalePrompt(null);
          return result;
        }}
      />

      <CharacterAcquisitionPaymentModal
        open={!!acquisitionPaymentPrompt}
        context={acquisitionPaymentPrompt ? {
          title: "Aceitar aquisição",
          characterName: acquisitionPaymentPrompt.characterName,
          payerLabel: "Comprador / jogador",
          payerName: acquisitionPaymentPrompt.acquirerName,
          recipientLabel: "Vendedor / dono",
          recipientName: acquisitionPaymentPrompt.originalOwnerName,
          mainCharacterName: acquisitionPaymentPrompt.sellerMainCharacterName,
          amount: acquisitionPaymentPrompt.finalPaid,
          calculation: {
            characterValue: acquisitionPaymentPrompt.originalCharacterCost,
            personalFee: acquisitionPaymentPrompt.personalFee ?? acquisitionPaymentPrompt.additionalFee ?? 0,
            bazaarFee: acquisitionPaymentPrompt.bazaarFee,
            total: acquisitionPaymentPrompt.finalPaid,
          },
          instruction: `O proprietário deste personagem pré-aprovou a venda por ${formatRC(acquisitionPaymentPrompt.finalPaid)}. Revise o cálculo acima: você pagará esse valor diretamente ao vendedor, que receberá o mesmo total. Após enviar ao Main Character dele, confirme abaixo.`,
          confirmLabel: "Confirmar pagamento",
        } as CharacterAcquisitionPaymentModalContext : null}
        onClose={() => setAcquisitionPaymentPrompt(null)}
        onConfirm={async () => {
          if (!acquisitionPaymentPrompt || !onConfirmCharacterAcquisitionPayment) return { ok: false, error: "A confirmação não está disponível neste momento." };
          const result = await onConfirmCharacterAcquisitionPayment(acquisitionPaymentPrompt.id);
          if (result.ok) setAcquisitionPaymentPrompt(null);
          return result;
        }}
      />

      {/* Modal de confirmação de pagamento (PG) */}
      {/* ── ESCOLHA DO DESTINATÁRIO DA DIVISÃO ──────────────────────────────
          Aberto só quando DONO e JOGADOR divergem. Sem opção pré-selecionada
          e sem botão "confirmar": cada cartão É a escolha, então não há como
          fechar por engano com um valor default. Cancelar/Esc/clicar fora não
          marca nada — a caixa DIVIDIR continua desmarcada. */}
      {splitTargetPrompt && createPortal(
        <div
          className="app-modal-overlay fixed inset-0 z-[420] flex items-center justify-center bg-black/75 backdrop-blur-sm"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setSplitTargetPrompt(null); }}
        >
          <div className="app-modal-frame app-modal-size-sm app-modal-frame--scroll bg-[var(--th-n-hi)] border border-white/10 rounded-2xl shadow-2xl w-full max-w-md">
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/5 bg-[var(--th-n-elev)]">
              <h3 className="text-base font-bold text-emerald-400 tracking-wide">🤝 Destinatário da Divisão</h3>
              <button
                type="button"
                onClick={() => setSplitTargetPrompt(null)}
                className="text-slate-400 hover:text-white p-1.5 rounded-lg hover:bg-white/5 transition-colors cursor-pointer"
                title="Cancelar (não marca DIVIDIR)"
              >
                <X size={16} />
              </button>
            </div>

            <div className="app-modal-body p-4 sm:p-5 space-y-4">
              <p className="text-sm text-slate-300 leading-relaxed">
                O <span className="font-bold text-sky-300">dono</span> e o{" "}
                <span className="font-bold text-amber-300">jogador</span> deste personagem são
                diferentes. Para quem vai esta participação?
              </p>

              <div className="space-y-2">
                {(() => {
                  // Identificabilidade de cada candidato — MESMA cadeia do
                  // confirmSplitTarget (util splitBeneficiary). A opção sem
                  // UID resolvível fica desabilitada com o motivo à vista:
                  // clicar e "não acontecer nada" era justamente o bug.
                  const ctx = splitBeneficiaryContextFor(splitTargetPrompt.slotId);
                  const opcoes: Array<{ target: SplitTarget; rotulo: string; nome: string; cor: "sky" | "amber"; uid: string }> = [
                    { target: "owner" as SplitTarget, rotulo: "Dono", nome: splitTargetPrompt.ownerName, cor: "sky", uid: resolveSplitBeneficiaryCandidate(getSD(splitTargetPrompt.slotId), "owner", ctx) },
                    { target: "player" as SplitTarget, rotulo: "Jogador", nome: splitTargetPrompt.playerName, cor: "amber", uid: resolveSplitBeneficiaryCandidate(getSD(splitTargetPrompt.slotId), "player", ctx) },
                  ];
                  return opcoes.map(opcao => (
                    <button
                      key={opcao.target}
                      type="button"
                      disabled={!opcao.uid}
                      onClick={() => confirmSplitTarget(opcao.target)}
                      title={opcao.uid
                        ? `A divisão deste personagem será destinada a ${opcao.nome}`
                        : "Este destinatário não é um usuário identificável do app (sem UID). A divisão exige um destinatário identificado."}
                      className={`w-full flex items-center justify-between gap-3 px-4 py-3 rounded-xl border transition-all text-left ${
                        !opcao.uid
                          ? "opacity-40 cursor-not-allowed border-white/10 bg-white/[0.02]"
                          : opcao.cor === "sky"
                            ? "border-sky-500/40 bg-sky-500/10 hover:bg-sky-500/20 hover:border-sky-400/70 cursor-pointer"
                            : "border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 hover:border-amber-400/70 cursor-pointer"
                      }`}
                    >
                      <div className="min-w-0">
                        <div className={`text-[10px] font-bold uppercase tracking-wider ${opcao.cor === "sky" ? "text-sky-400/80" : "text-amber-400/80"}`}>
                          {opcao.rotulo}
                        </div>
                        <div className="text-sm font-bold text-white truncate">{opcao.nome}</div>
                        {!opcao.uid && (
                          <div className="text-[9px] leading-tight text-slate-500 mt-0.5">
                            Não é um usuário identificável do app — escolha o outro destinatário ou cancele.
                          </div>
                        )}
                      </div>
                      <span className={`text-[10px] font-bold uppercase tracking-wider flex-shrink-0 ${!opcao.uid ? "text-slate-600" : opcao.cor === "sky" ? "text-sky-300" : "text-amber-300"}`}>
                        {opcao.uid ? "Escolher" : "Indisponível"}
                      </span>
                    </button>
                  ));
                })()}
              </div>

              <p className="text-[10px] leading-relaxed text-slate-500">
                A divisão só é marcada depois da escolha. Cancelar mantém <strong className="text-slate-400">DIVIDIR</strong> desmarcado.
              </p>
            </div>

            <div className="app-modal-footer flex flex-wrap items-center justify-end gap-2 px-4 sm:px-5 py-3.5 border-t border-white/5 bg-[var(--th-n-elev)]">
              <button
                type="button"
                onClick={() => setSplitTargetPrompt(null)}
                className="px-4 py-2 rounded-lg text-xs font-bold text-slate-300 hover:text-white hover:bg-white/5 transition-colors cursor-pointer"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {paymentConfirmData && createPortal(
        <div
          className="app-modal-overlay fixed inset-0 z-[400] flex items-center justify-center bg-black/75 backdrop-blur-sm"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setPaymentConfirmData(null); }}
        >
          <div className="app-modal-frame app-modal-size-sm app-modal-frame--scroll bg-[var(--th-n-hi)] border border-white/10 rounded-2xl shadow-2xl w-full max-w-md">
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/5 bg-[var(--th-n-elev)]">
              <h3 className="text-base font-bold text-amber-400 tracking-wide">💰 Confirmar Pagamento</h3>
              <button
                type="button"
                onClick={() => setPaymentConfirmData(null)}
                className="text-slate-400 hover:text-white p-1.5 rounded-lg hover:bg-white/5 transition-colors cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>
            <div className="app-modal-body p-4 sm:p-5 space-y-4">
              <p className="text-sm text-slate-300 leading-relaxed">
                Envie{" "}
                <span className="font-bold text-emerald-400 font-mono">{formatRC(paymentConfirmData.value)}</span>
                {" "}para{" "}
                <span className="font-bold text-sky-300">{paymentConfirmData.ownerName}</span>
                {" "}através do personagem{" "}
                {paymentConfirmData.mainCharName ? (
                  <button
                    type="button"
                    onClick={() => {
                      try {
                        navigator.clipboard.writeText(paymentConfirmData.mainCharName);
                        setPgCopied(true);
                        setTimeout(() => setPgCopied(false), 2000);
                      } catch {}
                    }}
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-500/30 text-amber-300 font-bold hover:bg-amber-500/25 transition-colors cursor-pointer text-sm"
                    title="Clique para copiar o nome do personagem"
                  >
                    {paymentConfirmData.mainCharName}
                    {pgCopied ? (
                      <Check size={12} className="text-emerald-400" />
                    ) : (
                      <span className="text-[9px] text-amber-400/60 ml-0.5">📋</span>
                    )}
                  </button>
                ) : (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-slate-500/15 border border-slate-500/30 text-slate-400 font-bold text-sm cursor-not-allowed" title="Dono não configurou personagem principal">
                    A definir
                    <span className="text-[9px] text-slate-500 ml-0.5">📋</span>
                  </span>
                )}
                {" "}e confirme o envio.
              </p>

              {pgCopied && (
                <div className="text-[10px] text-emerald-400 font-bold text-center animate-in fade-in duration-200">
                  ✓ Nome copiado para a área de transferência!
                </div>
              )}

              <div className="sticky bottom-0 flex flex-wrap justify-end gap-2 pt-3 border-t border-white/5 bg-[var(--th-n-hi)]/95 backdrop-blur-sm">
                <button
                  type="button"
                  onClick={() => setPaymentConfirmData(null)}
                  className="px-4 py-2 rounded-lg border border-white/10 text-slate-400 hover:text-white hover:bg-white/5 text-xs font-semibold transition-colors cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const data = paymentConfirmData;
                    const paidAtMs = Date.now();
                    setSD(data.slotId, { pago: true, paidByUid: currentUser?.uid, paidByName: userName, paidAt: paidAtMs });
                    if (data.ownerUid && currentUser?.uid && data.ownerUid !== currentUser.uid) {
                      const notifId = "notif_" + Date.now() + Math.random().toString(36).slice(2);
                      const charPrincipal = data.mainCharName || "A definir";
                      const paidAtFormatted = new Date(paidAtMs).toLocaleString("pt-BR", {
                        day: "2-digit",
                        month: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                      });
                      setDoc(doc(db, "notifications", notifId), {
                        id: notifId,
                        userId: data.ownerUid,
                        senderName: userName,
                        type: "payment_received",
                        title: "💰 Pagamento confirmado!",
                        body: `${userName} confirmou o pagamento de ${formatRC(data.value)} referente à PT "${party.name}". Verifique em ${charPrincipal}, ${paidAtFormatted}.`,
                        partyId: party.id,
                        partyName: party.name,
                        paidAt: paidAtMs,
                        paidAtFormatted,
                        status: "pending",
                        read: false,
                        createdAt: Date.now()
                      }).catch(() => {});
                    }
                    setPaymentConfirmData(null);
                  }}
                  className="px-5 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-black text-xs font-bold shadow-lg shadow-amber-500/20 transition-colors cursor-pointer"
                >
                  Confirmar
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Quadro fixo da PT */}
      <div className="flex-shrink-0 overflow-x-auto">
        <div className={`border-b-2 ${isFull ? "border-emerald-500/40 bg-emerald-500/[0.02]" : "border-amber-500/30 bg-amber-500/[0.02]"} ${isLocked ? "relative" : ""}`}>
          {isLocked && (
            <div className="absolute inset-0 z-30 bg-black/30 pointer-events-auto cursor-not-allowed" title="PT finalizada" />
          )}
          <table className="border-collapse w-full">
            <colgroup>
              {slotCols.map(c => <col key={c.k} style={c.k === "_spacer" ? { width: "100%" } : undefined} />)}
            </colgroup>
            <thead>
              <tr>
                {slotCols.map(h => (
                  <th key={h.k} className={`bg-[var(--th-bg-raised)] px-2 py-1 border-b border-[var(--th-line)]/50 text-xs font-semibold uppercase tracking-wider text-slate-400 whitespace-nowrap ${h.al === "right" ? "text-right" : h.al === "center" ? "text-center" : "text-left"}`}>
                    {h.l}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {slotMembers.map((slot, i) => {
                if (slot.type === "empty") return (
                  <tr key={`e${i}`} className="border-b border-white/5 bg-black/20">
                    <td className="px-2 py-0.5 text-center font-mono text-slate-600 font-bold whitespace-nowrap">{i + 1}</td>
                    <td colSpan={totalSlotCols - 1} className="px-2 py-0.5 text-center text-slate-600 italic text-xs">— vazio —</td>
                  </tr>
                );
                const id = slot.id;
                const d = getSD(id);
                const isInOther = idsInOtherParties.has(id);
                const isCustom = slot.type === "custom";
                const isWaiting = slot.type === "waiting";
                // ORIGEM SERVICE: `slotData.isService` é dado da PRÓPRIA PT,
                // gravado na inclusão. Usá-lo (em vez de depender do slot ter
                // sido resolvido pela `waitingList`) mantém o selo "Service"
                // mesmo depois de o registro sumir de `sharedServices`.
                const isServiceMember = isWaiting || d.isService === true;
                const acc = slot.type === "char" ? slot.char.account : "";
                // Nome real da conta, resolvido LOCALMENTE e apenas para o dono.
                // Vazio para Service, externo e personagem de outro usuário.
                const ownAccountName = (!isCustom && !isServiceMember) ? (ownCharacterAccountById[id] || "") : "";
                const charName = isCustom ? slot.custom.label : isWaiting ? slot.waiting.personagem : slot.char.personagem;
                const srv = isCustom ? slot.custom.servidor : isWaiting ? slot.waiting.servidor : slot.char.servidor;
                const voc: Vocation = isCustom ? slot.custom.voc : isWaiting ? slot.waiting.voc : slot.char.voc;
                const lvl = isCustom ? slot.custom.level : isWaiting ? slot.waiting.level : slot.char.level;
                // `accountLabelFor` resolve pela identidade da conta e cai
                // para o próprio `account` quando o valor já é o código de um
                // snapshot antigo — o rótulo histórico não é reescrito.
                const lbl = isCustom ? `Ext${customs.findIndex(c => c.id === id) + 1}` : isServiceMember ? "" : (accountLabelFor(slot.type === "char" ? slot.char : null) || acc || "—");
                const dupKey = slot.type === "char" ? getCharacterAccountKey(slot.char) : null;
                const isDupAcc = !!dupKey && duplicateAccounts.has(dupKey);
                const rowBg = isFull ? "bg-emerald-500/[0.04]" : "bg-amber-500/[0.03]";

                // WhatsApp e Twitch: resolver UID do jogador (player)
                const playerUid = (() => {
                  if (!d.player) return null;
                  const playerUser = allUsers.find(u => u.nome.toLowerCase() === d.player.toLowerCase());
                  return playerUser?.uid || null;
                })();
                // WhatsApp do proprietário original do personagem:
                //   - Personagem normal → DONO (ownerPhone)
                //   - Personagem da Lista de Espera (Service) → WhatsApp do Service
                const waitingPhone = (() => {
                  if (!isWaiting) return null;
                  const phone = `${slot.waiting.whatsappCountry || ""}${slot.waiting.whatsappArea || ""}${slot.waiting.whatsappNumber || ""}`.replace(/\D/g, "");
                  return phone || null;
                })();
                const ownerPhone = d.ownerUid ? (ownerPhoneMap[d.ownerUid] || null) : null;
                const donoPhone = isWaiting ? waitingPhone : ownerPhone;
                const donoLabel = isWaiting ? `${charName || "—"} (Service)` : `${d.owner || "—"} (Dono)`;
                // Permissão para visualizar o WhatsApp do CLIENTE (apenas para Services):
                // Baseada no Serviceiro ORIGINALMENTE designado (slot.waiting.addedBy),
                // NÃO no jogador atualmente selecionado na coluna JOGADOR.
                // Regra: Boss vê sempre; Serviceiro específico vê; "Qualquer um" → só Boss.
                const canViewServiceClientWhats = (() => {
                  if (!isWaiting) return true;
                  if (userProfile?.role === "Boss") return true;
                  const assignedServiceiro = (slot.waiting.addedBy || "").trim().toLowerCase();
                  if (!assignedServiceiro || assignedServiceiro === "qualquer um") return false;
                  const viewerName = (userProfile?.nome || userName || "").trim().toLowerCase();
                  return assignedServiceiro === viewerName;
                })();
                const visibleDonoPhone = canViewServiceClientWhats ? donoPhone : null;
                const donoWhatsRestricted = isWaiting && !!donoPhone && !canViewServiceClientWhats;
                // WhatsApp do JOGADOR (usuário selecionado na coluna JOGADOR)
                const playerPhone = playerUid ? (ownerPhoneMap[playerUid] || null) : null;
                const playerLabel = `${d.player || "—"} (Jogador)`;
                // Verificar se DONO e JOGADOR são o mesmo UID
                const donoUid = isWaiting ? null : d.ownerUid;
                const isSamePerson = !!d.player && (
                  (donoUid && playerUid === donoUid) ||
                  (d.player.toLowerCase() === (d.owner || "").toLowerCase())
                );
                const sourceCharacter = !isWaiting && !isCustom
                  ? (characters.find(character => character.id === id) || party.memberSnapshots?.[id])
                  : null;
                const existingAcquisition = d.ownerUid
                  ? characterAcquisitions.find(acquisition => acquisition.characterId === id && acquisition.originalOwnerUid === d.ownerUid)
                  : undefined;
                // Pré-aprovação é EXCLUSIVA do dono original. O jogador só vê a
                // ação de aceitar depois de a proposta estar registrada.
                const canPreApproveAcquisition = !!onCreateCharacterAcquisition
                  && !!sourceCharacter
                  && !!d.ownerUid
                  && !!playerUid
                  && !isSamePerson
                  && !existingAcquisition
                  && currentUser?.uid === d.ownerUid
                  && questState !== "post_complete"
                  && !party.isLocked
                  && !isPausedActive;
                // ACEITE DO COMPRADOR: a conclusão da Quest NÃO bloqueia o
                // aceite de uma venda já pré-aprovada — o JOGADOR pode aceitar
                // até a PT ser efetivamente finalizada (`pagamentoFeito`,
                // refletido em `isLocked`). Trancamento manual e pausa seguem
                // bloqueando como antes.
                const canAcceptAcquisition = !!onConfirmCharacterAcquisitionPayment
                  && !!existingAcquisition
                  && existingAcquisition.status === "pre_approved"
                  && currentUser?.uid === playerUid
                  && !isLocked
                  && !party.isLocked
                  && !isPausedActive;
                // Troca do JOGADOR continua travada pós-Quest/trava/pausa —
                // apenas o SELETOR fica desabilitado; os botões de negociação
                // dentro da célula obedecem exclusivamente aos flags acima.
                // (Antes o `<td>` inteiro recebia pointer-events-none, o que
                // impedia indevidamente o aceite após a Quest concluída.)
                const playerSelectLocked = (questState !== "pre_start" && questState !== "in_progress")
                  || !!party.isLocked
                  || isPausedActive
                  || (!canEditPT && userProfile?.role !== "Boss");

                const srvText = (srv || "").trim();
                const ptSrvText = (party.servidor || "").trim();
                let srvCellClass = "px-2 py-0.5 text-center text-slate-300 whitespace-nowrap";
                if (srvText && srvText !== "—" && ptSrvText) {
                  if (srvText.toLowerCase() === ptSrvText.toLowerCase()) {
                    srvCellClass += " border border-emerald-800/80 bg-emerald-950/10";
                  } else {
                    srvCellClass += " border border-red-800/80 bg-red-950/10";
                  }
                }

                // --- Mini-calculadora kk -> RC ---
                const rateKkRaw = calcRateKkDrafts[id] !== undefined ? calcRateKkDrafts[id] : formatRateKkDisplay(d.calcRateKk);
                const totalKkRaw = calcTotalKkDrafts[id] !== undefined ? calcTotalKkDrafts[id] : (d.calcTotalKk ? String(d.calcTotalKk) : "");
                const liveCalcRC = computeItemRC(parseRateKk(rateKkRaw), parseInt(totalKkRaw, 10) || 0);
                // Valor exibido/usado: prioriza o cálculo ao vivo quando os campos kk estão preenchidos
                const slotNotesValue = slotNotesDrafts[id] !== undefined ? slotNotesDrafts[id] : (d.notes || "");

                return (
                  <tr key={id} className={`border-b border-white/5 ${rowBg} ${isInOther ? "ring-1 ring-inset ring-amber-500/30" : ""}`} title={isInOther ? "Este personagem está em outra PT" : ""}>
                    <td className="px-2 py-0.5 text-center font-mono text-slate-500 font-bold whitespace-nowrap">{i + 1}</td>
                    <td className={`px-2 py-0.5 text-center whitespace-nowrap ${isCustom ? "text-violet-300 italic" : "text-slate-400"}`}>
                      <span className="inline-flex items-center justify-center gap-1">
                        {/* CONTA — nome real só para o PROPRIETÁRIO.
                            `ownAccountName` só é preenchido quando o personagem
                            veio de PERSONAGENS DISPONÍVEIS e o `ownerUid` bate
                            com o UID do usuário atual. Services (`isWaiting`),
                            externos (`isCustom`) e personagens de terceiros
                            continuam exibindo exatamente o código de hoje. */}
                        {ownAccountName ? (
                          <button
                            type="button"
                            onClick={async () => {
                              const markCopied = () => {
                                setCopiedAccountId(id);
                                setTimeout(() => setCopiedAccountId(null), 1500);
                              };
                              try {
                                await navigator.clipboard.writeText(ownAccountName);
                                markCopied();
                              } catch {
                                const ta = document.createElement("textarea");
                                ta.value = ownAccountName;
                                ta.style.position = "fixed";
                                ta.style.opacity = "0";
                                document.body.appendChild(ta);
                                ta.select();
                                document.execCommand("copy");
                                document.body.removeChild(ta);
                                markCopied();
                              }
                            }}
                            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors cursor-pointer max-w-[140px] ${
                              copiedAccountId === id
                                ? "bg-emerald-500/20 text-emerald-300"
                                : "text-slate-300 font-medium hover:bg-white/10 hover:text-white"
                            }`}
                            title={`Copiar "${ownAccountName}" para a área de transferência`}
                          >
                            {copiedAccountId === id
                              ? <Check size={12} className="text-emerald-400" />
                              : <span className="truncate">{ownAccountName}</span>}
                          </button>
                        ) : (
                          <>{lbl}{isCustom ? " ✦" : ""}</>
                        )}
                        {isServiceMember && <span className="ml-1 px-1 py-0.5 rounded bg-cyan-900/30 text-cyan-400 text-[10px] font-mono border border-cyan-800/50" title="Personagem adicionado da Lista de Espera (Service)">Service</span>}
                        {isDupAcc && <span className="text-amber-400" title="Mesma conta">⚠</span>}
                      </span>
                    </td>
                    <td className="px-2 py-0.5 text-center whitespace-nowrap">
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(charName || "");
                            setCopiedCharId(id);
                            setTimeout(() => setCopiedCharId(null), 1500);
                          } catch {
                            const ta = document.createElement("textarea");
                            ta.value = charName || "";
                            ta.style.position = "fixed";
                            ta.style.opacity = "0";
                            document.body.appendChild(ta);
                            ta.select();
                            document.execCommand("copy");
                            document.body.removeChild(ta);
                            setCopiedCharId(id);
                            setTimeout(() => setCopiedCharId(null), 1500);
                          }
                        }}
                        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors cursor-pointer ${
                          copiedCharId === id
                            ? "bg-emerald-500/20 text-emerald-300"
                            : "text-slate-100 font-medium hover:bg-white/10 hover:text-white"
                        }`}
                        title={`Copiar "${charName}" para a área de transferência`}
                      >
                        {copiedCharId === id ? <Check size={12} className="text-emerald-400" /> : charName || "—"}
                      </button>
                    </td>
                    <td className={srvCellClass}>{srv || "—"}</td>
                    <td className="px-2 py-0.5 text-center whitespace-nowrap"><span className="font-bold" style={{ color: VOC_COLORS[voc!] }}>{voc}</span></td>
                    <td className="px-2 py-0.5 text-center tabular-nums whitespace-nowrap">{lvl}</td>
                    <td className="px-2 py-0.5 text-center text-sky-300 whitespace-nowrap font-medium">{d.owner || "—"}</td>
                    <td className="px-1 py-0.5 text-center">
                      {/* JOGADOR: participante (DONO/JOGADOR) ou líder alteram;
                          Boss preservado; externo (convidado/PT pública) só
                          visualiza + adiciona — nunca troca o JOGADOR.
                          O bloqueio pós-Quest/trava/pausa vale APENAS para o
                          seletor (`playerSelectLocked`): antes o <td> inteiro
                          recebia pointer-events-none e engolia o clique do
                          botão "Aceitar aquisição" após a Quest concluída. */}
                      <div className="flex w-full min-w-0 items-center gap-1 whitespace-nowrap">
                        <UserFilter
                          label="Jogador"
                          options={allUsers.filter(u => {
                            if (u.status !== "aprovado") return false;
                            // Incluir: próprio usuário, amigos aceitos, ou se o jogador já está selecionado
                            if (u.uid === currentUser?.uid) return true;
                            if (acceptedFriendUids.includes(u.uid)) return true;
                            if (d.player && u.nome.toLowerCase() === d.player.toLowerCase()) return true;
                            return false;
                          }).map(u => u.nome)}
                          selected={d.player ?? (d.owner || "")}
                          onSelect={(name) => handlePlayerSelect(id, name)}
                          disabled={playerSelectLocked}
                        />
                        <div className="ml-auto flex flex-shrink-0 items-center gap-1">
                        {existingAcquisition && (
                          <span
                            className="inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md border border-violet-500/25 bg-violet-500/[0.07] text-violet-200"
                            title={existingAcquisition.status === "pre_approved"
                              ? "Venda pré-aprovada pelo dono — aguardando aceite e pagamento do jogador"
                              : existingAcquisition.status === "sold"
                                ? "Negociação concluída: personagem vendido"
                                : existingAcquisition.status === "for_sale"
                                  ? "Negociação vinculada: personagem anunciado à venda"
                                  : existingAcquisition.status === "quest_completed"
                                    ? "Quest concluída — negociação pronta para venda"
                                    : "Aquisição confirmada para este jogador"}
                            aria-label="Negociação entre usuários vinculada"
                          >
                            {existingAcquisition.status === "pre_approved" ? <Clock size={10} /> : <Handshake size={10} />}
                          </span>
                        )}
                        {canPreApproveAcquisition && (
                          <button
                            type="button"
                            onClick={() => setCharacterSalePrompt({
                              characterId: id,
                              characterName: charName || sourceCharacter?.personagem || "Personagem",
                              server: sourceCharacter?.servidor || srv || "",
                              vocation: sourceCharacter?.voc || voc || "",
                              level: sourceCharacter?.level || lvl || 0,
                              originalOwnerName: d.owner || "Dono original",
                              acquirerName: d.player || "Jogador",
                              detectedOriginalCost: (sourceCharacter?.valorPago || 0) > 0 ? Number(sourceCharacter?.valorPago) : null,
                            })}
                            className="inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md border border-violet-500/40 bg-violet-500/12 text-violet-200 transition-colors hover:bg-violet-500/25 cursor-pointer"
                            title="Pré-aprovar venda para o jogador desta PT"
                            aria-label="Vender Char"
                          >
                            <Handshake size={11} />
                          </button>
                        )}
                        {canAcceptAcquisition && (
                          <button
                            type="button"
                            onClick={() => setAcquisitionPaymentPrompt(existingAcquisition)}
                            className="inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md border border-emerald-500/40 bg-emerald-500/12 text-emerald-200 transition-colors hover:bg-emerald-500/25 cursor-pointer"
                            title="Aceitar personagem e confirmar pagamento"
                            aria-label="Aceitar aquisição"
                          >
                            <Check size={11} />
                          </button>
                        )}
                        </div>
                      </div>
                    </td>
                    <td className={`px-1 py-0.5 whitespace-nowrap ${(questState !== "in_progress") || !!party.isLocked || isPausedActive ? "pointer-events-none opacity-50" : ""}`}>
                      <div className="flex items-center gap-0.5 justify-center">
                        <button disabled={(questState !== "in_progress") || !!party.isLocked || isPausedActive} onClick={() => setSD(id, { deaths: Math.max(0, d.deaths - 1) })} className="w-6 h-6 rounded border border-rose-500/40 bg-rose-500/15 text-rose-400 hover:bg-rose-500/25 text-xs font-bold flex items-center justify-center transition-colors disabled:opacity-50 disabled:cursor-not-allowed" title="Remover morte">−</button>
                        <span className="min-w-[28px] text-center tabular-nums font-bold text-slate-200">{d.deaths}</span>
                        <button disabled={(questState !== "in_progress") || !!party.isLocked || isPausedActive} onClick={() => setSD(id, { deaths: d.deaths + 1 })} className="w-6 h-6 rounded border border-emerald-500/40 bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 text-xs font-bold flex items-center justify-center transition-colors disabled:opacity-50 disabled:cursor-not-allowed" title="Adicionar morte">+</button>
                      </div>
                    </td>
                    <td className={`px-2 py-0.5 text-center whitespace-nowrap ${!canToggleSplit ? "pointer-events-none opacity-50" : ""}`}>
                      <input
                        type="checkbox"
                        disabled={!canToggleSplit}
                        checked={d.split}
                        onChange={e => handleSplitToggle(id, e.target.checked)}
                        title={canToggleSplitAfterQuest ? "Líder: ajustar DIVIDIR após Quest concluída" : "Participar da divisão"}
                        className={`w-4 h-4 accent-emerald-500 cursor-pointer appearance-none rounded-[3px] border ${d.split ? "border-emerald-400 bg-emerald-500/30" : "border-emerald-900"} bg-[var(--th-n-panel)] checked:bg-emerald-500/40 checked:border-emerald-400 relative checked:after:content-['✓'] checked:after:absolute checked:after:inset-0 checked:after:flex checked:after:items-center checked:after:justify-center checked:after:text-[9px] checked:after:text-emerald-300 checked:after:font-bold`}
                      />
                    </td>

                    <td className={`px-1 py-0.5 text-center ${(questState !== "post_complete") || !!party.isLocked || isPausedActive ? "pointer-events-none opacity-50" : ""}`}><ItemSelect value={d.itemDropado || ""} onChange={v => setSD(id, { itemDropado: v })} ptType={party.ptType} disabled={(questState !== "post_complete") || !!party.isLocked || isPausedActive || !!d.pago || !!d.dropLocked} /></td>
                    <td className={`px-1 py-0.5 text-center whitespace-nowrap ${(questState !== "post_complete") || !!party.isLocked || isPausedActive ? "pointer-events-none opacity-50" : ""}`}>
                      {/* === MINI-CALCULADORA kk -> RC (3 campos lado a lado) === */}
                      {(() => {
                        // --- Variáveis de controle de dependência ---
                        const hasItemDropado = !!d.itemDropado;
                        const pgGlobalDisabled = !!d.pago;
                        const extSlot = d as ExtendedPartySlotData;
                        const legacyCalcLocked = !!extSlot.calcLocked;
                        const rateLocked = legacyCalcLocked || !!extSlot.calcRateKkLocked;
                        const totalLocked = legacyCalcLocked || !!extSlot.calcTotalKkLocked;
                        const rcLocked = legacyCalcLocked || !!extSlot.itemVendidoLocked;
                        const questLocked = (questState !== "post_complete") || !!party.isLocked || isPausedActive;
                        // kk>RC E kk habilitados somente quando ITEM DROPADO está preenchido E a quest permite edição E o campo não está travado
                        const rateEnabled = hasItemDropado && !questLocked && !pgGlobalDisabled && !rateLocked;
                        const totalEnabled = hasItemDropado && !questLocked && !pgGlobalDisabled && !totalLocked;
                        // Campo RC fica readOnly quando a calculadora está ativa (ambos kk > 0)
                        const isCalcLocked = rateKkRaw !== "" && parseRateKk(rateKkRaw) > 0
                                           && totalKkRaw !== "" && parseInt(totalKkRaw, 10) > 0;
                        // RC editável manualmente: quando NÃO há cálculo ativo E não está bloqueado por PG/quest/trava
                        const rcEditable = !isCalcLocked && !questLocked && !pgGlobalDisabled && !rcLocked;

                        const rcDisplayValue = rcDrafts[id] !== undefined
                          ? rcDrafts[id]
                          : String(d.itemVendido || "");

                        return (
                          <div className="flex items-center justify-center gap-1" style={{ minWidth: 150 }}>
                            {/* Campo 1 — kk>RC (taxa em k que equivale a 1000 RC) */}
                            <div
                              className={`flex items-center rounded border bg-black/30 px-1 py-0.5 transition-opacity ${rateEnabled ? "border-red-500/40" : "border-red-500/15 opacity-50"}`}
                              title={rateLocked ? "Campo kk>RC salvo permanentemente — não pode ser alterado" : rateEnabled ? "kk > RC (taxa): valor em k que vale 1000 RC" : "Preencha ITEM DROPADO para habilitar"}
                            >
                              <input
                                type="text"
                                inputMode="decimal"
                                disabled={!rateEnabled}
                                value={rateKkRaw}
                                onFocus={() => setCalcFocused({ id, field: "rate" })}
                                onChange={e => {
                                  // Aceita UMA casa decimal (vírgula pt-BR; ponto é normalizado)
                                  const cleaned = sanitizeRateKkInput(e.target.value);
                                  setCalcRateKkDrafts(prev => ({ ...prev, [id]: cleaned }));
                                  scheduleDebounce(`calcRate_${id}`, () => commitCalcDrafts(id, cleaned, totalKkRaw));
                                }}
                                onBlur={() => {
                                  clearDebounce(`calcRate_${id}`);
                                  commitCalcDrafts(id, rateKkRaw, totalKkRaw);
                                  setCalcFocused(cur => (cur?.id === id && cur?.field === "rate" ? null : cur));
                                }}
                                placeholder="0"
                                className="w-8 bg-transparent text-right text-[11px] tabular-nums text-red-300 placeholder-slate-650 outline-none disabled:cursor-not-allowed"
                              />
                              {!(calcFocused?.id === id && calcFocused?.field === "rate") && rateKkRaw
                                ? <span className="text-red-400/70 text-[9px] font-bold ml-0.5 select-none">k</span>
                                : <span className="text-red-500/30 text-[9px] font-bold ml-0.5 select-none w-[6px]">&nbsp;</span>}
                            </div>

                            {/* Campo 2 — kk (total a ser convertido) */}
                            <div
                              className={`flex items-center rounded border bg-black/30 px-1 py-0.5 transition-opacity ${totalEnabled ? "border-sky-500/40" : "border-sky-500/15 opacity-50"}`}
                              title={totalLocked ? "Campo kk salvo permanentemente — não pode ser alterado" : totalEnabled ? "kk (total): valor total em kk a ser convertido em RC" : "Preencha ITEM DROPADO para habilitar"}
                            >
                              <input
                                type="text"
                                inputMode="numeric"
                                disabled={!totalEnabled}
                                value={totalKkRaw}
                                onFocus={() => setCalcFocused({ id, field: "total" })}
                                onChange={e => {
                                  const cleaned = e.target.value.replace(/[^\d]/g, "");
                                  setCalcTotalKkDrafts(prev => ({ ...prev, [id]: cleaned }));
                                  scheduleDebounce(`calcTotal_${id}`, () => commitCalcDrafts(id, rateKkRaw, cleaned));
                                }}
                                onBlur={() => {
                                  clearDebounce(`calcTotal_${id}`);
                                  commitCalcDrafts(id, rateKkRaw, totalKkRaw);
                                  setCalcFocused(cur => (cur?.id === id && cur?.field === "total" ? null : cur));
                                }}
                                placeholder="0"
                                className="w-8 bg-transparent text-right text-[11px] tabular-nums text-sky-300 placeholder-slate-650 outline-none disabled:cursor-not-allowed"
                              />
                              {!(calcFocused?.id === id && calcFocused?.field === "total") && totalKkRaw
                                ? <span className="text-sky-400/70 text-[9px] font-bold ml-0.5 select-none">kk</span>
                                : <span className="text-sky-500/30 text-[9px] font-bold ml-0.5 select-none w-[10px]">&nbsp;</span>}
                            </div>

                            {/* Campo 3 — RC: input editável OU display somente leitura */}
                            <div
                              className={`flex items-center rounded border px-1 py-0.5 ${
                                rcLocked
                                  ? "border-emerald-500/50 bg-emerald-500/[0.10]"
                                  : isCalcLocked
                                    ? "border-emerald-500/40 bg-emerald-500/[0.08]"
                                    : pgGlobalDisabled
                                      ? "border-emerald-500/25 bg-emerald-500/[0.04]"
                                      : "border-emerald-500/30 bg-emerald-500/[0.05]"
                              }`}
                              title={rcLocked
                                ? "Valor salvo permanentemente — não pode ser alterado"
                                : isCalcLocked
                                  ? "RC calculado = floor((total / taxa) × 1000 / 25) × 25"
                                  : pgGlobalDisabled
                                    ? "Pagamento confirmado — campos bloqueados"
                                    : "Campo editável — digite um valor de RC diretamente"
                              }
                            >
                              {rcLocked ? (
                                // Dados salvos/travados permanentemente: exibe valor salvo (somente leitura)
                                <span className={`text-[11px] tabular-nums font-bold min-w-[38px] text-right ${(d.itemVendido || 0) > 0 ? "text-emerald-300" : "text-emerald-400/40"}`}>
                                  {(d.itemVendido || 0) > 0 ? (d.itemVendido || 0).toLocaleString("de-DE") : "0"}
                                </span>
                              ) : isCalcLocked ? (
                                // Calculadora ativa: exibe valor calculated (somente leitura)
                                <span className={`text-[11px] tabular-nums font-bold min-w-[38px] text-right ${liveCalcRC > 0 ? "text-emerald-300" : "text-emerald-400/40"}`}>
                                  {liveCalcRC > 0 ? liveCalcRC.toLocaleString("de-DE") : "0"}
                                </span>
                              ) : (
                                // Calculadora inativa: input editável (ou desabilitado por PG)
                                <input
                                  type="text"
                                  inputMode="numeric"
                                  disabled={!rcEditable}
                                  value={rcDisplayValue}
                                  onFocus={() => setCalcFocused(null)}
                                  onChange={e => {
                                    const cleaned = e.target.value.replace(/[^\d]/g, "");
                                    setRcDrafts(prev => ({ ...prev, [id]: cleaned }));
                                    scheduleDebounce(`rcManual_${id}`, () => commitRcDraft(id, cleaned));
                                  }}
                                  onBlur={() => {
                                    clearDebounce(`rcManual_${id}`);
                                    commitRcDraft(id, rcDisplayValue);
                                  }}
                                  placeholder="0"
                                  className={`w-8 bg-transparent text-right text-[11px] tabular-nums outline-none ${rcEditable ? "text-emerald-300 placeholder-slate-650" : "text-emerald-400/50 placeholder-slate-650/50 cursor-not-allowed"} ${!rcEditable ? "opacity-50" : ""}`}
                                />
                              )}
                              <span className="text-emerald-400/70 text-[9px] font-bold ml-0.5 select-none">RC</span>
                            </div>
                          </div>
                        );
                      })()}
                    </td>
                    {(() => {
                      const extDPago = d as ExtendedPartySlotData;
                      const pgIsBoss = userProfile?.role === "Boss";
                      const pgSettlementEditor = !party.questConcluida || isLeaderPT || pgIsBoss;
                      const pgCanMark = d.split === true && !party.isLocked && !isPausedActive && pgSettlementEditor;
                      const pgIsMarkedByMe = !!extDPago.paidByUid && extDPago.paidByUid === currentUser?.uid;
                      const pgCanUnmark = pgSettlementEditor && (pgIsMarkedByMe || pgIsBoss || !extDPago.paidByUid);
                      const pgDisabled = d.pago ? !pgCanUnmark : !pgCanMark;
                      const pgTitle = d.pago
                        ? (pgCanUnmark ? "Desmarcar pagamento" : "Apenas o usuário que confirmou este pagamento (ou um Boss) pode desmarcá-lo.")
                        : (allSplitHaveRC ? "Marcar pagamento" : "Todos os participantes da divisão precisam ter valor em RC declarado.");
                      return (
                        <td className={`px-2 py-0.5 text-center whitespace-nowrap ${pgDisabled ? "pointer-events-none opacity-50" : ""}`}>
                          <input
                            type="checkbox"
                            checked={d.pago}
                            disabled={pgDisabled}
                            title={pgTitle}
                            onChange={() => {
                              if (!d.pago) {
                                if (!allSplitHaveRC) {
                                  customAlert("Todos os participantes da divisão precisam ter valor em RC declarado.");
                                  return;
                                }
                                const mainChar = d.ownerUid ? (ownerMainCharMap[d.ownerUid] || "") : "";
                                 // O pagamento vai para quem a divisão foi
                                 // destinada. Sem escolha (DONO == JOGADOR ou
                                 // PT antiga) `resolveSplitRecipient` devolve
                                 // o dono — o comportamento de sempre.
                                 const destinatario = resolveSplitRecipient(d, d.owner || charName || "?");
                                 const destinatarioEhJogador = resolveSplitTarget(d) === "player";
                                 // UID e personagem principal precisam seguir o
                                 // destinatário: pagar ao jogador exibindo o
                                 // char do dono mandaria o RC para a pessoa
                                 // errada.
                                 // PTs legadas podem ter o JOGADOR sem UID
                                 // persistido no slot — resolvemos pelo nome
                                 // (mesma normalização do resto do painel)
                                 // para o modal exibir o personagem correto
                                 // em vez de "A definir".
                                 const destinatarioUid = d.splitBeneficiaryUid
                                   || (destinatarioEhJogador ? d.playerUid : d.ownerUid)
                                   || (destinatario
                                     ? (allUsers.find(u => u.nome.trim().toLowerCase() === destinatario.trim().toLowerCase())?.uid || "")
                                     : "");
                                 const destinatarioMainChar = destinatarioEhJogador
                                   ? (destinatarioUid ? (ownerMainCharMap[destinatarioUid] || "") : "")
                                   : mainChar;
                                 setPaymentConfirmData({
                                   slotId: id,
                                   ownerName: destinatario,
                                   ownerUid: destinatarioUid,
                                   value: dropPerSplit || 0,
                                   mainCharName: destinatarioMainChar,
                                   charName: charName || "?"
                                 });
                                setPgCopied(false);
                              } else {
                                if (pgCanUnmark) {
                                  setSD(id, { pago: false, paidByUid: undefined, paidByName: undefined, paidAt: undefined });
                                } else {
                                  customAlert("Apenas o usuário que confirmou este pagamento (ou um Boss) pode desmarcá-lo.");
                                }
                              }
                            }}
                            className={`w-4 h-4 accent-amber-500 appearance-none rounded-[3px] border bg-[var(--th-n-panel)] ${pgDisabled ? "opacity-40 cursor-not-allowed border-amber-900" : "cursor-pointer"} ${d.pago ? "border-amber-400 bg-amber-500/30 relative after:content-['✓'] after:absolute after:inset-0 after:flex after:items-center after:justify-center after:text-[9px] after:text-amber-300 after:font-bold" : !pgDisabled ? "border-amber-900" : "border-amber-900/50"}`}
                          />
                        </td>
                      );
                    })()}
                    <td className={`px-1 py-0.5 text-center ${(questState !== "in_progress") || !!party.isLocked || isPausedActive ? "pointer-events-none opacity-50" : ""}`}><input type="text" disabled={(questState !== "in_progress") || !!party.isLocked || isPausedActive} value={slotNotesValue} onChange={e => { const nextValue = e.target.value; setSlotNotesDrafts(prev => ({ ...prev, [id]: nextValue })); scheduleDebounce(`slotNotes_${id}`, () => commitSlotNotesDraft(id, nextValue)); }} onBlur={() => { clearDebounce(`slotNotes_${id}`); commitSlotNotesDraft(id, slotNotesDrafts[id] !== undefined ? slotNotesDrafts[id] : (d.notes || "")); }} placeholder="—" className="w-full min-w-[200px] bg-transparent border-b border-white/10 focus:border-amber-500/50 outline-none px-1 py-1 text-center text-slate-300 placeholder-slate-650" maxLength={100} /></td>
                    {/* Coluna WhatsApp — DONO/Service + JOGADOR */}
                    <td className="px-2 py-0.5 text-center whitespace-nowrap">
                      <div className="flex items-center justify-center gap-1">
                        {/* Primeiro ícone: WhatsApp do proprietário original (DONO ou Service) */}
                        {/* Services têm restrição: visível apenas para Boss ou o Serviceiro originalmente designado */}
                        {/* Destinatário identificado pelo MESMO critério que decide o telefone:
                            - slot "waiting" → CLIENTE do Service → seletor de mensagens
                              pré-programadas (mesmo modal das guias de Services);
                            - caso contrário → usuário do próprio app → wa.me direto,
                              exatamente como antes (fluxo preservado). */}
                        {visibleDonoPhone ? (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (isWaiting) {
                                // Cliente de Service: abre o seletor de mensagens
                                // pré-programadas (o link é gerado pelo próprio modal,
                                // com a mensagem escolhida já preenchida).
                                setWaTarget(slot.waiting);
                              } else {
                                openExternalUrl(`https://wa.me/${visibleDonoPhone}`);
                              }
                            }}
                            className="inline-flex items-center justify-center w-5 h-5 rounded bg-emerald-500/15 hover:bg-emerald-500/30 text-emerald-400 hover:text-emerald-300 transition-colors cursor-pointer"
                            title={isWaiting
                              ? `Enviar mensagem ao cliente do Service ${charName || ""}`.trim()
                              : `Abrir WhatsApp de ${donoLabel}`}
                          >
                            <ExternalLink size={10} />
                          </button>
                        ) : donoWhatsRestricted ? (
                          <span className="text-slate-600 text-[11px]" title="WhatsApp do cliente visível apenas para o Serviceiro designado">🔒</span>
                        ) : playerPhone ? null : (
                          <span className="text-slate-600 text-[10px]">—</span>
                        )}
                        {/* Segundo ícone: WhatsApp do JOGADOR (se for diferente do proprietário) */}
                        {playerPhone && !isSamePerson && (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); openExternalUrl(`https://wa.me/${playerPhone}`); }}
                            className="inline-flex items-center justify-center w-5 h-5 rounded bg-emerald-500/15 hover:bg-emerald-500/30 text-emerald-400 hover:text-emerald-300 transition-colors cursor-pointer"
                            title={`Abrir WhatsApp de ${playerLabel}`}
                          >
                            <ExternalLink size={10} />
                          </button>
                        )}
                        {/* Exibir "—" quando não há nenhum WhatsApp disponível e não há Jogador */}
                        {((!visibleDonoPhone && !donoWhatsRestricted && !playerPhone) || (!visibleDonoPhone && !donoWhatsRestricted && !playerPhone && !isSamePerson)) && (
                          <span className="text-slate-600 text-[10px]">—</span>
                        )}
                      </div>
                    </td>
                    {/* Coluna Twitch — MESMO sistema da coluna WhatsApp: DONO + JOGADOR */}
                    <td className="px-2 py-0.5 text-center whitespace-nowrap">
                      {(() => {
                        // Espelha a coluna WhatsApp: primeiro ícone = DONO,
                        // segundo ícone = JOGADOR quando for pessoa diferente.
                        // Para Services (slot "waiting") não existe Twitch do
                        // cliente — vale apenas o canal do JOGADOR, igual ao
                        // critério do WhatsApp que separa cliente × usuários
                        // do app (aqui só usuários do app têm twitchChannel).
                        const donoTwitch = !isWaiting && d.ownerUid ? (ownerTwitchMap[d.ownerUid] || "") : "";
                        const playerTwitch = playerUid ? (ownerTwitchMap[playerUid] || "") : "";
                        const showPlayerTwitch = !!playerTwitch && !isSamePerson;
                        // Quando DONO = JOGADOR, um único botão (mesma pessoa,
                        // mesmo canal) — idêntico ao comportamento do WhatsApp.
                        if (!donoTwitch && !showPlayerTwitch && !(isSamePerson && playerTwitch)) {
                          return <span className="text-slate-700 text-[10px]">—</span>;
                        }
                        const firstUrl = donoTwitch || (isSamePerson ? playerTwitch : "");
                        const firstLabel = donoTwitch ? donoLabel : playerLabel;
                        return (
                          <div className="flex items-center justify-center gap-1">
                            {firstUrl && (
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); openExternalUrl(firstUrl); }}
                                className="inline-flex items-center justify-center w-6 h-6 rounded bg-violet-500/15 hover:bg-violet-500/30 text-violet-400 hover:text-violet-300 transition-colors cursor-pointer"
                                title={`Abrir Twitch de ${firstLabel}`}
                              >
                                <Tv size={12} />
                              </button>
                            )}
                            {showPlayerTwitch && (
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); openExternalUrl(playerTwitch); }}
                                className="inline-flex items-center justify-center w-6 h-6 rounded bg-violet-500/15 hover:bg-violet-500/30 text-violet-400 hover:text-violet-300 transition-colors cursor-pointer"
                                title={`Abrir Twitch de ${playerLabel}`}
                              >
                                <Tv size={12} />
                              </button>
                            )}
                          </div>
                        );
                      })()}
                    </td>
                    <td className="px-1 py-0.5 text-center whitespace-nowrap">
                      <button
                        onClick={() => removeFromParty(id)}
                        disabled={(!canEditPT && !isLeaderPT) || isLocked || !!party.isLocked || isQuestLocked || !!party.ptStartedAt || isPausedActive}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-rose-900/40 bg-rose-500/[0.06] text-rose-400/80 hover:bg-rose-500/15 hover:text-rose-300 hover:border-rose-700/50 text-[10px] font-semibold transition-all disabled:opacity-30 disabled:pointer-events-none cursor-pointer whitespace-nowrap"
                        title={(!canEditPT && !isLeaderPT) ? "Apenas integrantes da PT ou o líder podem remover" : !!party.ptStartedAt ? "Não é possível remover personagem após o início da quest" : "Remover da PT"}
                      >
                        Remover
                      </button>
                    </td>
                    <td></td>
                  </tr>
                );
              })}
              {/* Footer totals */}
              <tr className="bg-[var(--th-n-base)] border-t-2 border-[var(--th-line)]/50 relative z-40">
                <td colSpan={4} className="px-2 py-0.5 whitespace-nowrap relative z-40">
                  <div className="flex items-center gap-1 flex-shrink-0 relative z-40">
                    <button
                      type="button"
                      disabled={party.LeaderPT !== userName || !party.questConcluida || !!party.pagamentoFeito || !allSplitItemsSold || isPausedActive || isFinalizationRequested}
                      onClick={() => {
                        if (party.LeaderPT !== userName || !party.questConcluida || party.pagamentoFeito || !allSplitItemsSold) return;
                        const splitBlock = splitCount > 0 && !allSplitPaid;
                        if (splitBlock) {
                          customAlert("Realize o pagamento de todos os membros com DIVIDIR marcado antes de finalizar");
                          return;
                        }
                        customConfirm("Marcar o Pagamento como Realizado? O backend validará a última versão, criará os históricos privados e finalizará a PT.", () => {
                          void requestBackendFinalization("payment");
                        });
                      }}
                      className={`inline-flex items-center gap-1 px-2 py-1 rounded-md border text-[10px] font-bold transition-colors cursor-pointer whitespace-nowrap relative z-40 ${
                        party.LeaderPT !== userName || !party.questConcluida || !allSplitItemsSold || isFinalizationRequested
                          ? "opacity-40 cursor-not-allowed border-white/10 bg-white/5 text-slate-500"
                          : party.pagamentoFeito
                            ? "bg-emerald-500 text-black border-emerald-400 shadow-sm shadow-emerald-500/20 cursor-not-allowed"
                            : "bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 border-amber-500/30"
                      }`}
                    >
                      {isFinalizationRequested ? "PROCESSANDO FINALIZAÇÃO..." : party.pagamentoFeito ? "✓ PT FINALIZADA / PAGAMENTO REALIZADO" : "PAGAMENTO REALIZADO / FINALIZAR PT"}
                    </button>
                  </div>
                </td>
                <td colSpan={4} className="px-2 py-1 text-center text-sm font-black uppercase tracking-wider whitespace-nowrap bg-gradient-to-l from-amber-500/10 to-transparent text-amber-300 border-l border-amber-500/20">⚡ TOTAL:</td>
                <td className="px-2 py-1 text-center font-bold tabular-nums text-white whitespace-nowrap">{totalDeaths}</td>
                <td className="px-2 py-1 text-center font-bold tabular-nums text-emerald-400 whitespace-nowrap">{splitCount}/{allMemberIds.length}</td>
                <td className="px-2 py-1 text-center font-bold text-xs whitespace-nowrap" style={{ color: dropClassification.color }}>{dropClassification.label}</td>
                <td className="pl-2 pr-1 py-1.5 text-right font-bold tabular-nums whitespace-nowrap">
                  <span className="text-emerald-400">{formatRC(totalItemVendidoGeral)}</span>
                  <span className="mx-1 text-slate-500">→</span>
                  <span className="text-sky-300">{formatRC(dropPerSplit)}</span>
                  <span className="text-[10px] text-slate-500 ml-1">cada</span>
                </td>
                <td colSpan={5} className="pl-1 pr-2 py-1.5 text-xs text-slate-400 truncate max-w-[300px] text-left" title={splitNames.join(", ")}>
                  <span className="font-semibold text-sky-500">Dividir:</span> {splitNames.join(", ") || "—"}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Área inferior com os 3 painéis redimensionáveis */}
      <div ref={panelsRef} className="flex flex-col xl:flex-row gap-2 items-stretch px-2 pt-1 pb-0 w-full relative box-border flex-1 min-h-0" style={{ minHeight: "40px" }}>
        <div className="flex flex-col border border-[var(--th-brand-mid)]/40 rounded-xl bg-[var(--th-n-abyss)] self-stretch overflow-hidden min-w-0" style={{ flex: `0 0 calc(${panelWidths.p1}% - 14px)` }}>
          <AvailableCharacter
            onRefresh={onRefresh}
            handleRefresh={handleRefresh}
            isRefreshing={isRefreshing}
            refreshDone={refreshDone}
            thCls={thCls}
            hdr={hdr}
            toggleSort={toggleSort}
            SI={SI}
            resetAvailableFilters={resetAvailableFilters}
            unavailableAccountIds={unavailableSameAccountIds}
            showAccountConflictLegend
            filterPersonagem={filterPersonagem}
            setFilterPersonagem={setFilterPersonagem}
            serverOptions={serverOptions}
            filterServer={filterServer}
            setFilterServer={setFilterServer}
            serverLocked={serverFilterLocked}
            vocOptions={vocOptions}
            filterVoc={filterVoc}
            setFilterVoc={setFilterVoc}
            filterLevel={filterLevel}
            filterLevelOp={filterLevelOp}
            setFilterLevel={setFilterLevel}
            setFilterLevelOp={setFilterLevelOp}
            filterSW={filterSW}
            setFilterSW={setFilterSW}
            filterSG={filterSG}
            setFilterSG={setFilterSG}
            swLocked={swLocked}
            sgLocked={sgLocked}
            donoOptions={donoOptions}
            filterDonos={filterDonos}
            setFilterDonos={setFilterDonos}
            sortedAvailable={sortedAvailable}
            idsInOtherParties={idsInOtherParties}
            otherPartiesInfoFor={otherPartiesInfoFor}
            isFull={isFull}
            addToParty={addToParty}
            accountLabelFor={accountLabelFor}
            getCharOwner={getCharOwner}
          />
        </div>

        <div className="w-px bg-[var(--th-line)]/40 hover:bg-[var(--th-brand-mid)]/60 cursor-col-resize self-stretch transition-colors flex-shrink-0" title="Arraste para ajustar" onMouseDown={e => { e.preventDefault(); setDraggingPanel("left"); }} />

        <div className="self-stretch flex flex-col items-stretch overflow-hidden border border-[var(--th-line)]/20 rounded-xl bg-[var(--th-bg-abyss)]" style={{ flex: `0 0 calc(${panelWidths.p2}% - 14px)`, minWidth: "195px" }}>
          <ServersPyramidChart
            availableChars={serverChartAvailable}
            waitingItems={serverChartWaitingList}
            selectedSet={selectedSet}
            activeServer={serverChartActiveServer}
            onServerClick={handleServerChartClick}
            partyServer={serverChartPartyServer}
          />
        </div>

        {/* LISTA DE ESPERA */}
        {(
          <>
            <div className="w-px bg-[var(--th-line)]/40 hover:bg-[var(--th-brand-mid)]/60 cursor-col-resize self-stretch transition-colors flex-shrink-0" title="Arraste para ajustar" onMouseDown={e => { e.preventDefault(); setDraggingPanel("right"); }} />

            <div className="flex flex-col border border-[var(--th-brand-mid)]/40 rounded-xl bg-[var(--th-n-abyss)] self-stretch overflow-hidden min-w-0 flex-1">
              <div className="px-3 py-1 bg-[var(--th-bg-raised)] border-b border-[var(--th-brand-mid)]/40 text-[10px] uppercase tracking-wider text-amber-600 font-bold truncate flex-shrink-0">Lista de Espera (Services)</div>
              <div className="flex-1 min-h-0 overflow-y-auto" onWheel={e => e.stopPropagation()}>
                <WaitingServiceAvailableList items={visibleWaitingList} selectedIds={selectedSet} isFull={isFull} onAdd={addToParty} filters={wlFilters} setFilters={setWlFilters} swLocked={swLocked} sgLocked={sgLocked} serverLocked={serverFilterLocked} />
              </div>
            </div>
          </>
        )}
      </div>

      {/* Confirmação de incompatibilidade (Quest e/ou servidor).
          UM só modal cobre os dois casos — ver `addToParty`. Cancelar não
          adiciona nada; confirmar segue pelo fluxo normal de adição. */}
      <ConfirmModal
        open={!!pendingAdd}
        title="Personagem incompatível com a PT"
        message={
          <>
            <strong className="font-bold text-slate-100">{pendingAdd?.name}</strong>{" "}
            {pendingAdd?.questIssue && pendingAdd?.serverIssue ? (
              <>
                {pendingAdd.questIssue} e {pendingAdd.serverIssue}.
              </>
            ) : (
              <>{pendingAdd?.questIssue || pendingAdd?.serverIssue}.</>
            )}{" "}
            Deseja adicionar mesmo assim?
          </>
        }
        confirmLabel="Adicionar mesmo assim"
        cancelLabel="Cancelar"
        tone="neutral"
        onConfirm={() => {
          const target = pendingAdd;
          setPendingAdd(null);
          if (target) performAddToParty(target.id);
        }}
        onCancel={() => setPendingAdd(null)}
      />

      {/* Escolha do Boss ao pausar. Cancelar não pausa nada. */}
      <PausePartyModal
        open={isPauseModalOpen}
        ptType={party.ptType}
        onConfirm={confirmPause}
        onCancel={() => setIsPauseModalOpen(false)}
      />

      {/* SuggestPartyModal removido: o botão "Sugerir PT" foi movido para o
          PartyManager e agora cria uma NOVA PT a partir da sugestão, em vez
          de aplicar a sugestão à PT existente. */}

      {/* Contato com o CLIENTE de Service: seletor de mensagem padrão → link
          do WhatsApp com o texto pré-preenchido (?text=). Mesmo fluxo e
          mesmas mensagens das guias "Meus Services"/"Services" (preferência
          por usuário no localStorage). Só abre para clientes de Service —
          o WhatsApp de usuários do app segue direto pelo botão da linha. */}
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

      {/* Configuração das mensagens padrão (título/conteúdo), por usuário —
          a mesma edição das guias de Services. */}
      <WhatsappTemplateModal
        open={waTemplatesOpen}
        templates={waTemplates}
        onClose={() => setWaTemplatesOpen(false)}
        onSave={handleWaTemplatesSave}
      />
    </div>
  );
}