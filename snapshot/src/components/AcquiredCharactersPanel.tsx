import { useEffect, useMemo, useRef, useState } from "react";
import { BriefcaseBusiness, Check, Clock3, Copy, Handshake, Pencil, RotateCcw, Send, UserRound } from "lucide-react";
import type { Character, CharacterAcquisition, CharacterAcquisitionBuyerDetails, NegotiationTimestamp, PtType } from "../types";
import { formatRC } from "../types";
import { CRYPT_ITEMS, ItemSelect, SANGUINE_ITEMS, SOULWAR_ITEMS } from "./CharTable";
import { FilterInline, FilterNumber, FilterSelect } from "./FilterTypes";
import { computeDeferredSettlement, getCharacterAcquisitionSellerReceived, isDeferredPaymentPending, isPaymentConfirmed } from "../services/characterAcquisitionService";
import { formatFirestoreLocalDateTime, toFirestoreMillis } from "../utils/firestoreTimestamp";
import CharacterAcquisitionPaymentModal, { type CharacterAcquisitionPaymentModalContext } from "./CharacterAcquisitionPaymentModal";

interface Props {
  acquisitions: CharacterAcquisition[];
  buyerDetails?: CharacterAcquisitionBuyerDetails[];
  /** Personagens locais do dono, usados somente como a fonte oficial da venda. */
  originalCharacters?: Character[];
  currentUserUid: string;
  onEditOriginalCharacter?: (characterId: string) => void;
  onConfirmSalePayout?: (acquisitionId: string) => Promise<{ ok: boolean; error?: string }>;
  onUpdateQuestDrop?: (input: { acquisitionId: string; questDrop: string }) => Promise<{ ok: boolean; error?: string }>;
  onUpdateQuestProfit?: (input: { acquisitionId: string; questProfit: number }) => Promise<{ ok: boolean; error?: string }>;
}

function formatDateTime(value?: NegotiationTimestamp): string {
  return formatFirestoreLocalDateTime(value);
}

function displayRC(value?: number): string {
  return !value ? "—" : formatRC(value);
}

function personalFee(record: CharacterAcquisition): number {
  const value = record.personalFee ?? record.additionalFee ?? 0;
  return value === 25 || value === 50 ? value : 0;
}


function resolveQuestType(record: CharacterAcquisition, detail?: CharacterAcquisitionBuyerDetails): PtType | undefined {
  const questType = detail?.questType || record.questType;
  return questType === "soulwar" || questType === "sanguine" || questType === "crypt" ? questType : undefined;
}

function resolveOfficialSaleValue(record: CharacterAcquisition, currentUserUid: string, originalCharactersById: Map<string, Character>): number | undefined {
  // Para o DONO, a tela lê sempre o valor do próprio Character. O campo
  // compartilhado da negociação é apenas o espelho de publicação que o
  // COMPRADOR recebe em tempo real e não substitui a fonte oficial.
  if (record.originalOwnerUid === currentUserUid) {
    const character = originalCharactersById.get(record.characterId);
    if (character?.vendido && Number.isFinite(character.valorVenda)) return character.valorVenda;
  }
  return Number.isFinite(record.saleValue) ? record.saleValue : undefined;
}

function SectionHeader({ children, count, tone }: { children: string; count: number; tone: "emerald" | "sky" }) {
  const classes = tone === "emerald"
    ? "border-emerald-500/35 bg-emerald-500/[0.08] text-emerald-200"
    : "border-sky-500/35 bg-sky-500/[0.08] text-sky-200";

  return (
    <header className={`flex flex-shrink-0 items-center justify-center gap-2 border-b px-3 py-2 text-[10px] font-black uppercase tracking-[0.16em] ${classes}`}>
      <Handshake size={13} />
      <span>{children}</span>
      <span className="rounded-full border border-white/15 bg-black/15 px-1.5 py-0.5 font-mono text-[9px] tracking-normal">{count}</span>
    </header>
  );
}

/** Copia o texto usando o mesmo caminho do "Copiar (WA)" do PartyPanel e do
 *  histórico de PT's (textarea + execCommand, com fallback para a API
 *  assíncrona de clipboard). */
function copyTextToClipboard(text: string): void {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
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
    navigator.clipboard.writeText(text).catch(() => {});
  }
}

function CharacterCell({ record }: { record: CharacterAcquisition }) {
  // Nome do personagem como botão que copia o nome EXATO — o mesmo padrão de
  // outras partes do app (histórico de PT's): ✓ verde por 2s após copiar e
  // ícone de copiar que aparece no hover.
  const [nameCopied, setNameCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
  }, []);
  function handleCopyName() {
    const name = String(record.characterName || "").trim();
    if (!name) return;
    copyTextToClipboard(name);
    setNameCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setNameCopied(false), 2000);
  }
  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={handleCopyName}
        title={nameCopied ? "Nome copiado" : `Copiar "${record.characterName || "Personagem"}"`}
        className={`group inline-flex min-w-0 cursor-copy items-center justify-center gap-1 rounded px-0.5 py-0.5 text-left font-black transition-colors ${
          nameCopied
            ? "bg-emerald-500/15 text-emerald-300"
            : "text-slate-100 hover:bg-white/[0.07] hover:text-white"
        }`}
      >
        <span className="truncate">{record.characterName || "—"}</span>
        {nameCopied
          ? <Check size={10} strokeWidth={3} className="flex-shrink-0 text-emerald-400" />
          : <Copy size={10} className="flex-shrink-0 text-slate-500 opacity-0 transition-opacity group-hover:opacity-80" />}
      </button>
      <div className="mt-0.5 truncate font-mono text-[9px] text-slate-500" title={`${record.server || "—"} · ${record.vocation || "—"} · Lv ${record.level || 0}`}>
        {record.server || "—"} · {record.vocation || "—"} · Lv {record.level || 0}
      </div>
    </div>
  );
}

function Perspective({ text, tone }: { text: string; tone: "emerald" | "sky" }) {
  const classes = tone === "emerald"
    ? "border-emerald-500/25 bg-emerald-500/[0.07] text-emerald-200"
    : "border-sky-500/25 bg-sky-500/[0.07] text-sky-200";
  return (
    <span className={`inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-1 text-[9px] font-bold ${classes}`} title={text}>
      <UserRound size={10} className="flex-shrink-0" />
      <span className="truncate">{text}</span>
    </span>
  );
}

function PaymentStamp({ value, confirmed, title }: { value: string; confirmed: boolean; title?: string }) {
  return (
    <span title={title || value} className={`inline-flex max-w-full items-center justify-center gap-1 rounded-md border px-1.5 py-1 text-[9px] font-bold ${confirmed ? "border-emerald-500/25 bg-emerald-500/[0.07] text-emerald-200" : "border-amber-500/25 bg-amber-500/[0.07] text-amber-200"}`}>
      <Clock3 size={10} className="flex-shrink-0" />
      <span className="truncate">{value}</span>
    </span>
  );
}

function QuestDropCell({
  record,
  detail,
  onUpdateQuestDrop,
}: {
  record: CharacterAcquisition;
  detail?: CharacterAcquisitionBuyerDetails;
  onUpdateQuestDrop?: Props["onUpdateQuestDrop"];
}) {
  const questType = resolveQuestType(record, detail);
  if (!detail || !questType) {
    return <span className="text-[9px] italic text-slate-500">Aguardando Quest</span>;
  }

  const itemList = questType === "soulwar" ? SOULWAR_ITEMS : questType === "crypt" ? CRYPT_ITEMS : SANGUINE_ITEMS;
  const selectedDrop = detail.questDrops?.[0] || "";
  return (
    <div className="mx-auto max-w-[165px]">
      <ItemSelect
        value={selectedDrop}
        itemList={itemList}
        disabled={!onUpdateQuestDrop}
        onChange={questDrop => {
          if (!onUpdateQuestDrop) return;
          void onUpdateQuestDrop({ acquisitionId: record.id, questDrop });
        }}
      />
    </div>
  );
}

function QuestProfitCell({
  record,
  detail,
  onUpdateQuestProfit,
}: {
  record: CharacterAcquisition;
  detail?: CharacterAcquisitionBuyerDetails;
  onUpdateQuestProfit?: Props["onUpdateQuestProfit"];
}) {
  const [draft, setDraft] = useState(detail ? String(detail.questProfit || "") : "");

  useEffect(() => {
    setDraft(detail ? String(detail.questProfit || "") : "");
  }, [detail?.acquisitionId, detail?.questProfit]);

  if (!detail) return <span className="tabular-nums text-[11px] text-slate-300">—</span>;
  if (!onUpdateQuestProfit) return <span className="tabular-nums text-[11px] text-slate-300">{displayRC(detail.questProfit)}</span>;

  const commit = () => {
    const value = draft === "" ? 0 : Number(draft);
    if (!Number.isSafeInteger(value) || value < 0 || value === detail.questProfit) return;
    void onUpdateQuestProfit({ acquisitionId: record.id, questProfit: value });
  };

  return (
    <div className="mx-auto flex max-w-[105px] items-center justify-center gap-1">
      <input
        type="text"
        inputMode="numeric"
        value={draft}
        onChange={event => setDraft(event.target.value.replace(/\D/g, "").slice(0, 12))}
        onBlur={commit}
        onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }}
        placeholder="0"
        aria-label="Editar Lucro Quest"
        title="Editar o Lucro Quest privado desta negociação"
        className="min-w-0 flex-1 border-b border-emerald-500/35 bg-transparent px-1 py-1 text-right font-mono text-[11px] font-bold text-emerald-200 outline-none transition-colors focus:border-emerald-300"
      />
      <span className="text-[9px] font-bold text-slate-500">RC</span>
    </div>
  );
}

function EmptyPerspective({ text }: { text: string }) {
  return <div className="flex min-h-[140px] flex-1 items-center justify-center px-5 text-center text-xs italic text-slate-500">{text}</div>;
}

// ── FILTROS POR COLUNA — mesmo conceito da guia "Disponíveis" (CharTable) ──
// Linha de filtros logo abaixo do cabeçalho, um filtro por coluna, com os
// MESMOS componentes (FilterInline/FilterSelect/FilterNumber) e o botão de
// limpar (RotateCcw, com pulso âmbar quando há filtro ativo). Filtragem 100%
// local (derivado puro sobre dados já carregados — zero Firestore).
type NumericOp = "gte" | "lte";
interface NumericFilterState { value: number | null; op: NumericOp }
const EMPTY_NUM: NumericFilterState = { value: null, op: "gte" };

function matchNumeric(value: number | null | undefined, st: NumericFilterState): boolean {
  if (st.value === null) return true;
  if (value === null || value === undefined || !Number.isFinite(value)) return false;
  return st.op === "gte" ? value >= st.value : value <= st.value;
}

function matchText(haystack: string, needle: string): boolean {
  const n = needle.trim().toLowerCase();
  if (!n) return true;
  return haystack.toLowerCase().includes(n);
}

/** Estado de pagamento da coluna PG, reduzido às duas situações reais. */
function pgStatus(record: CharacterAcquisition): "Pago" | "Aguardando" {
  return record.salePayoutStatus === "confirmed" ? "Pago" : "Aguardando";
}

/** Botão "limpar filtros" — mesmo visual do da guia Disponíveis. */
function ClearFiltersButton({ active, onClear }: { active: boolean; onClear: () => void }) {
  return (
    <button
      type="button"
      onClick={onClear}
      className={`h-6 w-6 flex-shrink-0 rounded flex items-center justify-center transition-all cursor-pointer ${
        active
          ? "bg-amber-500 text-black font-bold shadow-sm shadow-amber-500/20 animate-pulse"
          : "bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white"
      }`}
      title="Limpar todos os filtros"
    >
      <RotateCcw size={11} />
    </button>
  );
}

interface PurchasedFilters {
  name: string;
  owner: string;
  drop: string;
  profit: NumericFilterState;
  paid: NumericFilterState;
  sale: NumericFilterState;
  total: NumericFilterState;
  pg: string;
}
const EMPTY_PURCHASED_FILTERS: PurchasedFilters = { name: "", owner: "", drop: "", profit: EMPTY_NUM, paid: EMPTY_NUM, sale: EMPTY_NUM, total: EMPTY_NUM, pg: "" };

interface SoldFilters {
  name: string;
  buyer: string;
  received: NumericFilterState;
  sale: NumericFilterState;
  pg: string;
}
const EMPTY_SOLD_FILTERS: SoldFilters = { name: "", buyer: "", received: EMPTY_NUM, sale: EMPTY_NUM, pg: "" };

const PG_FILTER_OPTIONS = ["Pago", "Aguardando"];

export default function AcquiredCharactersPanel({
  acquisitions,
  buyerDetails = [],
  originalCharacters = [],
  currentUserUid,
  onEditOriginalCharacter,
  onConfirmSalePayout,
  onUpdateQuestDrop,
  onUpdateQuestProfit,
}: Props) {
  const [salePayoutPromptId, setSalePayoutPromptId] = useState<string | null>(null);
  const buyerDetailsByAcquisition = useMemo(() => new Map(buyerDetails.map(detail => [detail.acquisitionId, detail])), [buyerDetails]);
  const originalCharactersById = useMemo(() => new Map(originalCharacters.map(character => [character.id, character])), [originalCharacters]);
  // Defesa adicional de UI: uma pré-aprovação jamais é uma negociação exibível,
  // ainda que chegue por estado otimista antes da troca de listener.
  const purchased = useMemo(() => acquisitions
    .filter(record => record.acquirerUid === currentUserUid && isPaymentConfirmed(record))
    .sort((a, b) => toFirestoreMillis(b.updatedAt) - toFirestoreMillis(a.updatedAt)), [acquisitions, currentUserUid]);
  const sold = useMemo(() => acquisitions
    .filter(record => record.originalOwnerUid === currentUserUid && isPaymentConfirmed(record))
    .sort((a, b) => toFirestoreMillis(b.updatedAt) - toFirestoreMillis(a.updatedAt)), [acquisitions, currentUserUid]);
  const salePayoutPrompt = useMemo(() => sold.find(record => record.id === salePayoutPromptId) || null, [salePayoutPromptId, sold]);

  // ── Filtros por coluna (padrão da guia "Disponíveis") ────────────────────
  const [purchasedFilters, setPurchasedFilters] = useState<PurchasedFilters>(EMPTY_PURCHASED_FILTERS);
  const [soldFilters, setSoldFilters] = useState<SoldFilters>(EMPTY_SOLD_FILTERS);

  const hasPurchasedFilters = useMemo(() =>
    purchasedFilters.name.trim() !== "" || purchasedFilters.owner !== "" || purchasedFilters.drop !== "" || purchasedFilters.pg !== ""
    || purchasedFilters.profit.value !== null || purchasedFilters.paid.value !== null || purchasedFilters.sale.value !== null || purchasedFilters.total.value !== null,
  [purchasedFilters]);

  const hasSoldFilters = useMemo(() =>
    soldFilters.name.trim() !== "" || soldFilters.buyer !== "" || soldFilters.pg !== ""
    || soldFilters.received.value !== null || soldFilters.sale.value !== null,
  [soldFilters]);

  // Opções dos selects — derivadas dos próprios dados carregados (sem
  // consulta extra), como as opções de Conta/Servidor da guia Disponíveis.
  const purchasedOwnerOptions = useMemo(() => {
    const set = new Set<string>();
    purchased.forEach(record => { if (record.originalOwnerName) set.add(record.originalOwnerName); });
    return Array.from(set).sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [purchased]);

  const purchasedDropOptions = useMemo(() => {
    const set = new Set<string>();
    purchased.forEach(record => {
      const drop = buyerDetailsByAcquisition.get(record.id)?.questDrops?.[0];
      if (drop) set.add(drop);
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [purchased, buyerDetailsByAcquisition]);

  const soldBuyerOptions = useMemo(() => {
    const set = new Set<string>();
    sold.forEach(record => { if (record.acquirerName) set.add(record.acquirerName); });
    return Array.from(set).sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [sold]);

  // Filtragem LOCAL, combinando todos os filtros ativos (AND) e preservando
  // a ordenação existente (o filter mantém a ordem do array de origem).
  const filteredPurchased = useMemo(() => purchased.filter(record => {
    if (!matchText(record.characterName || "", purchasedFilters.name)) return false;
    if (purchasedFilters.owner && record.originalOwnerName !== purchasedFilters.owner) return false;
    const detail = buyerDetailsByAcquisition.get(record.id);
    if (purchasedFilters.drop && (detail?.questDrops?.[0] || "") !== purchasedFilters.drop) return false;
    if (!matchNumeric(detail?.questProfit ?? 0, purchasedFilters.profit)) return false;
    if (!matchNumeric(record.finalPaid, purchasedFilters.paid)) return false;
    const saleValue = resolveOfficialSaleValue(record, currentUserUid, originalCharactersById);
    if (!matchNumeric(saleValue, purchasedFilters.sale)) return false;
    const total = (detail?.questProfit || 0) + (saleValue || 0) - record.finalPaid;
    if (!matchNumeric(total, purchasedFilters.total)) return false;
    if (purchasedFilters.pg && pgStatus(record) !== purchasedFilters.pg) return false;
    return true;
  }), [purchased, purchasedFilters, buyerDetailsByAcquisition, currentUserUid, originalCharactersById]);

  const filteredSold = useMemo(() => sold.filter(record => {
    if (!matchText(record.characterName || "", soldFilters.name)) return false;
    if (soldFilters.buyer && record.acquirerName !== soldFilters.buyer) return false;
    if (!matchNumeric(getCharacterAcquisitionSellerReceived(record), soldFilters.received)) return false;
    const saleValue = resolveOfficialSaleValue(record, currentUserUid, originalCharactersById);
    if (!matchNumeric(saleValue, soldFilters.sale)) return false;
    if (soldFilters.pg && pgStatus(record) !== soldFilters.pg) return false;
    return true;
  }), [sold, soldFilters, currentUserUid, originalCharactersById]);
  const salePayoutValue = salePayoutPrompt ? resolveOfficialSaleValue(salePayoutPrompt, currentUserUid, originalCharactersById) : undefined;

  // PAGAMENTO POSTERIOR: o encerramento é a COMPENSAÇÃO ÚNICA da diferença
  // (venda − devido), não o repasse integral. O modal informa sem ambiguidade
  // quem paga, quem recebe e o valor — ou que nada resta a pagar.
  const deferredSettlement = salePayoutPrompt?.deferredPaymentChosen === true && salePayoutValue !== undefined
    ? computeDeferredSettlement(salePayoutPrompt, salePayoutValue)
    : null;

  const payoutContext: CharacterAcquisitionPaymentModalContext | null = salePayoutPrompt && salePayoutValue !== undefined ? (
    deferredSettlement ? {
      title: "Encerrar pendência da venda",
      characterName: salePayoutPrompt.characterName,
      payerLabel: deferredSettlement.direction === "buyer_pays" ? "Comprador / adquirente" : "Vendedor / dono",
      payerName: deferredSettlement.direction === "buyer_pays" ? salePayoutPrompt.acquirerName : salePayoutPrompt.originalOwnerName,
      recipientLabel: deferredSettlement.direction === "buyer_pays" ? "Vendedor / dono" : "Comprador / adquirente",
      recipientName: deferredSettlement.direction === "buyer_pays" ? salePayoutPrompt.originalOwnerName : salePayoutPrompt.acquirerName,
      mainCharacterName: deferredSettlement.direction === "buyer_pays" ? salePayoutPrompt.sellerMainCharacterName : salePayoutPrompt.buyerMainCharacterName,
      amount: deferredSettlement.amount,
      instruction: deferredSettlement.direction === "none"
        ? `Nenhum valor adicional a pagar: a venda (${formatRC(salePayoutValue)}) é igual ao valor devido (${formatRC(getCharacterAcquisitionSellerReceived(salePayoutPrompt))}). Confirme para encerrar a pendência.`
        : deferredSettlement.direction === "owner_pays"
          ? `Venda (${formatRC(salePayoutValue)}) maior que o devido (${formatRC(getCharacterAcquisitionSellerReceived(salePayoutPrompt))}): você deve pagar ${formatRC(deferredSettlement.amount)} para ${salePayoutPrompt.acquirerName}. Após enviar, confirme para encerrar a pendência.`
          : `Venda (${formatRC(salePayoutValue)}) menor que o devido (${formatRC(getCharacterAcquisitionSellerReceived(salePayoutPrompt))}): você deve receber ${formatRC(deferredSettlement.amount)} de ${salePayoutPrompt.acquirerName}. Após receber, confirme para encerrar a pendência.`,
      confirmLabel: "Encerrar pendência",
    } : {
      title: "Repassar valor da venda",
      characterName: salePayoutPrompt.characterName,
      payerLabel: "Vendedor / dono",
      payerName: salePayoutPrompt.originalOwnerName,
      recipientLabel: "Comprador / adquirente",
      recipientName: salePayoutPrompt.acquirerName,
      mainCharacterName: salePayoutPrompt.buyerMainCharacterName,
      amount: salePayoutValue,
      instruction: `Envie exatamente ${formatRC(salePayoutValue)} ao Main Character do comprador. Este valor é o mesmo valor de venda oficial salvo no personagem e pertence integralmente ao adquirente.`,
      confirmLabel: "Confirmar pagamento",
    }
  ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-[var(--th-line)]/60 bg-[var(--th-n-base)]/90">
      <div className="flex flex-shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[var(--th-line)]/60 bg-[var(--th-bg-raised)]/95 px-3 py-2 backdrop-blur-md">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg border border-violet-500/30 bg-violet-500/10 text-violet-300"><BriefcaseBusiness size={14} /></div>
          <div className="min-w-0">
            <div className="truncate text-[11px] font-black uppercase tracking-wider text-slate-100">Negociados entre usuários</div>
            <div className="truncate text-[9px] text-slate-500">Dono original, adquirente e direitos financeiros preservados.</div>
          </div>
        </div>
        <span className="rounded-full border border-violet-500/25 bg-violet-500/10 px-2 py-0.5 font-mono text-[10px] font-black text-violet-200">{purchased.length + sold.length}</span>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-2 gap-2 p-2 lg:grid-cols-2 lg:grid-rows-1">
        <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-emerald-500/20 bg-black/[0.08]">
          <SectionHeader tone="emerald" count={purchased.length}>COMPRADOS</SectionHeader>
          <div className="min-h-0 flex-1 overflow-auto custom-scrollbar">
            {purchased.length === 0 ? (
              <EmptyPerspective text="Nenhum personagem adquirido de outro usuário." />
            ) : (
              <table className="w-full min-w-[790px] table-fixed border-separate border-spacing-0 text-xs">
                <colgroup>
                  <col className="w-[19%]" /><col className="w-[15%]" /><col className="w-[15%]" /><col className="w-[10%]" />
                  <col className="w-[13%]" /><col className="w-[10%]" /><col className="w-[9%]" /><col className="w-[9%]" />
                </colgroup>
                <thead className="sticky top-0 z-10 bg-[var(--th-bg-base)] text-[8px] uppercase tracking-wider text-slate-500 shadow-[0_1px_0_rgba(255,255,255,0.06)]">
                  <tr>
                    {['Personagens', 'Perspectiva', 'Drop Quest', 'Lucro Quest', 'Valor Pago', 'Venda', 'Total', 'PG'].map(label => <th key={label} className="border-b border-[var(--th-line)]/60 px-2 py-2 text-center font-black whitespace-nowrap first:text-left">{label}</th>)}
                  </tr>
                  {/* Linha de filtros — mesmo padrão da guia Disponíveis. */}
                  <tr>
                    <th className="border-b border-[var(--th-line)]/60 px-1 py-1 bg-[var(--th-bg-base)]">
                      <div className="flex items-center gap-1">
                        <ClearFiltersButton active={hasPurchasedFilters} onClear={() => setPurchasedFilters(EMPTY_PURCHASED_FILTERS)} />
                        <FilterInline value={purchasedFilters.name} onChange={v => setPurchasedFilters(f => ({ ...f, name: v }))} maxWidth="90px" />
                      </div>
                    </th>
                    <th className="border-b border-[var(--th-line)]/60 px-1 py-1 bg-[var(--th-bg-base)]">
                      <div className="flex justify-center"><FilterSelect label="Perspectiva" options={purchasedOwnerOptions} selected={purchasedFilters.owner} onSelect={v => setPurchasedFilters(f => ({ ...f, owner: v }))} searchable /></div>
                    </th>
                    <th className="border-b border-[var(--th-line)]/60 px-1 py-1 bg-[var(--th-bg-base)]">
                      <div className="flex justify-center"><FilterSelect label="Drop Quest" options={purchasedDropOptions} selected={purchasedFilters.drop} onSelect={v => setPurchasedFilters(f => ({ ...f, drop: v }))} searchable /></div>
                    </th>
                    <th className="border-b border-[var(--th-line)]/60 px-1 py-1 bg-[var(--th-bg-base)]">
                      <div className="flex justify-center"><FilterNumber label="Lucro Quest" value={purchasedFilters.profit.value} operator={purchasedFilters.profit.op} onChange={(value, op) => setPurchasedFilters(f => ({ ...f, profit: { value, op } }))} /></div>
                    </th>
                    <th className="border-b border-[var(--th-line)]/60 px-1 py-1 bg-[var(--th-bg-base)]">
                      <div className="flex justify-center"><FilterNumber label="Valor Pago" value={purchasedFilters.paid.value} operator={purchasedFilters.paid.op} onChange={(value, op) => setPurchasedFilters(f => ({ ...f, paid: { value, op } }))} /></div>
                    </th>
                    <th className="border-b border-[var(--th-line)]/60 px-1 py-1 bg-[var(--th-bg-base)]">
                      <div className="flex justify-center"><FilterNumber label="Venda" value={purchasedFilters.sale.value} operator={purchasedFilters.sale.op} onChange={(value, op) => setPurchasedFilters(f => ({ ...f, sale: { value, op } }))} /></div>
                    </th>
                    <th className="border-b border-[var(--th-line)]/60 px-1 py-1 bg-[var(--th-bg-base)]">
                      <div className="flex justify-center"><FilterNumber label="Total" value={purchasedFilters.total.value} operator={purchasedFilters.total.op} onChange={(value, op) => setPurchasedFilters(f => ({ ...f, total: { value, op } }))} allowNegative /></div>
                    </th>
                    <th className="border-b border-[var(--th-line)]/60 px-1 py-1 bg-[var(--th-bg-base)]">
                      <div className="flex justify-center"><FilterSelect label="PG" options={PG_FILTER_OPTIONS} selected={purchasedFilters.pg} onSelect={v => setPurchasedFilters(f => ({ ...f, pg: v }))} /></div>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filteredPurchased.length === 0 && (
                    <tr><td colSpan={8} className="px-4 py-6 text-center text-xs italic text-slate-500">Nenhuma negociação corresponde aos filtros atuais.</td></tr>
                  )}
                  {filteredPurchased.map(record => {
                    const detail = buyerDetailsByAcquisition.get(record.id);
                    const initialPaymentConfirmed = isPaymentConfirmed(record);
                    const questProfit = detail?.questProfit || 0;
                    const saleValue = resolveOfficialSaleValue(record, currentUserUid, originalCharactersById);
                    const payoutReady = record.status === "sold" && saleValue !== undefined && saleValue > 0;
                    const total = questProfit + (saleValue || 0) - record.finalPaid;
                    // Pagamento posterior: o PG do comprador é a COMPENSAÇÃO da
                    // diferença — sempre sem ambiguidade sobre quem paga quem.
                    const deferredPending = isDeferredPaymentPending(record);
                    const settlementPreview = record.deferredPaymentChosen === true && saleValue !== undefined
                      ? computeDeferredSettlement(record, saleValue)
                      : null;
                    const payoutLabel = !payoutReady
                      ? (record.status === "sold" ? "Aguardando valor da venda" : "Aguardando venda")
                      : record.salePayoutStatus === "confirmed"
                        ? record.deferredPaymentChosen === true
                          ? `Compensado — ${formatDateTime(record.salePayoutConfirmedAt)}`
                          : `Pago — ${formatDateTime(record.salePayoutConfirmedAt)}`
                        : settlementPreview
                          ? settlementPreview.direction === "none"
                            ? "Nenhum valor adicional a pagar"
                            : settlementPreview.direction === "buyer_pays"
                              ? `Você deve pagar ${formatRC(settlementPreview.amount)} para ${record.originalOwnerName}`
                              : `Você deve receber ${formatRC(settlementPreview.amount)} de ${record.originalOwnerName}`
                          : "Aguardando pagamento";

                    return (
                      <tr key={record.id} className="align-middle transition-colors hover:bg-emerald-500/[0.035]">
                        <td className="border-b border-white/5 px-2 py-1.5"><CharacterCell record={record} /></td>
                        <td className="border-b border-white/5 px-2 py-1.5 text-center"><Perspective tone="emerald" text={`Comprado de ${record.originalOwnerName || "—"}`} /></td>
                        <td className="border-b border-white/5 px-2 py-1.5 text-center"><QuestDropCell record={record} detail={detail} onUpdateQuestDrop={onUpdateQuestDrop} /></td>
                        <td className="border-b border-white/5 px-2 py-1.5 text-center"><QuestProfitCell record={record} detail={detail} onUpdateQuestProfit={onUpdateQuestProfit} /></td>
                        <td className="border-b border-white/5 px-2 py-1.5 text-center" title={deferredPending
                          ? `Pagamento adiado até a venda do personagem. Valor devido: ${formatRC(record.finalPaid)} (base ${formatRC(record.originalCharacterCost)} + taxa pessoal ${formatRC(personalFee(record))} + taxa Bazaar ${formatRC(record.bazaarFee)}). A diferença será compensada em uma única transação.`
                          : `Base ${formatRC(record.originalCharacterCost)} + taxa pessoal ${formatRC(personalFee(record))} + taxa Bazaar ${formatRC(record.bazaarFee)}`}>
                          <span className={`font-mono text-[11px] font-black ${deferredPending ? "text-violet-300" : "text-amber-200"}`}>{formatRC(record.finalPaid)}</span>
                          {deferredPending && <span className="mt-0.5 block text-[8px] font-bold text-violet-300">Pendente — paga após a venda</span>}
                        </td>
                        <td className="border-b border-white/5 px-2 py-1.5 text-center"><span className={`font-mono text-[11px] font-bold ${saleValue !== undefined ? "text-violet-300" : "text-slate-500"}`}>{saleValue !== undefined ? formatRC(saleValue) : "Aguardando venda"}</span></td>
                        <td className={`border-b border-white/5 px-2 py-1.5 text-center font-mono text-[11px] font-black ${total >= 0 ? "text-emerald-300" : "text-rose-300"}`}>{initialPaymentConfirmed ? formatRC(total) : "—"}</td>
                        <td className="border-b border-white/5 px-2 py-1.5 text-center"><PaymentStamp value={payoutLabel} confirmed={record.salePayoutStatus === "confirmed"} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-sky-500/20 bg-black/[0.08]">
          <SectionHeader tone="sky" count={sold.length}>VENDIDOS</SectionHeader>
          <div className="min-h-0 flex-1 overflow-auto custom-scrollbar">
            {sold.length === 0 ? (
              <EmptyPerspective text="Nenhum personagem seu foi negociado com outro usuário." />
            ) : (
              <table className="w-full min-w-[560px] table-fixed border-separate border-spacing-0 text-xs">
                <colgroup>
                  <col className="w-[24%]" /><col className="w-[20%]" /><col className="w-[21%]" />
                  <col className="w-[17%]" /><col className="w-[18%]" />
                </colgroup>
                <thead className="sticky top-0 z-10 bg-[var(--th-bg-base)] text-[8px] uppercase tracking-wider text-slate-500 shadow-[0_1px_0_rgba(255,255,255,0.06)]">
                  <tr>
                    {['Personagem', 'Perspectiva', 'Valor Recebido', 'Venda', 'PG'].map(label => <th key={label} className="border-b border-[var(--th-line)]/60 px-2 py-2 text-center font-black whitespace-nowrap first:text-left">{label}</th>)}
                  </tr>
                  {/* Linha de filtros — mesmo padrão da guia Disponíveis. */}
                  <tr>
                    <th className="border-b border-[var(--th-line)]/60 px-1 py-1 bg-[var(--th-bg-base)]">
                      <div className="flex items-center gap-1">
                        <ClearFiltersButton active={hasSoldFilters} onClear={() => setSoldFilters(EMPTY_SOLD_FILTERS)} />
                        <FilterInline value={soldFilters.name} onChange={v => setSoldFilters(f => ({ ...f, name: v }))} maxWidth="90px" />
                      </div>
                    </th>
                    <th className="border-b border-[var(--th-line)]/60 px-1 py-1 bg-[var(--th-bg-base)]">
                      <div className="flex justify-center"><FilterSelect label="Perspectiva" options={soldBuyerOptions} selected={soldFilters.buyer} onSelect={v => setSoldFilters(f => ({ ...f, buyer: v }))} searchable /></div>
                    </th>
                    <th className="border-b border-[var(--th-line)]/60 px-1 py-1 bg-[var(--th-bg-base)]">
                      <div className="flex justify-center"><FilterNumber label="Valor Recebido" value={soldFilters.received.value} operator={soldFilters.received.op} onChange={(value, op) => setSoldFilters(f => ({ ...f, received: { value, op } }))} /></div>
                    </th>
                    <th className="border-b border-[var(--th-line)]/60 px-1 py-1 bg-[var(--th-bg-base)]">
                      <div className="flex justify-center"><FilterNumber label="Venda" value={soldFilters.sale.value} operator={soldFilters.sale.op} onChange={(value, op) => setSoldFilters(f => ({ ...f, sale: { value, op } }))} /></div>
                    </th>
                    <th className="border-b border-[var(--th-line)]/60 px-1 py-1 bg-[var(--th-bg-base)]">
                      <div className="flex justify-center"><FilterSelect label="PG" options={PG_FILTER_OPTIONS} selected={soldFilters.pg} onSelect={v => setSoldFilters(f => ({ ...f, pg: v }))} /></div>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSold.length === 0 && (
                    <tr><td colSpan={5} className="px-4 py-6 text-center text-xs italic text-slate-500">Nenhuma negociação corresponde aos filtros atuais.</td></tr>
                  )}
                  {filteredSold.map(record => {
                    const received = getCharacterAcquisitionSellerReceived(record);
                    const initialPaymentConfirmed = isPaymentConfirmed(record);
                    const saleValue = resolveOfficialSaleValue(record, currentUserUid, originalCharactersById);
                    const payoutReady = record.status === "sold" && saleValue !== undefined && saleValue > 0;
                    // Sem coluna "Total" nesta tabela: venda entre usuários não
                    // gera lucro ao vendedor (os 50 RC da taxa do Bazaar são
                    // taxa obrigatória do jogo, nunca lucro) — nenhum cálculo
                    // de lucro é exibido ou sugerido aqui.
                    const canEditSale = record.salePayoutStatus !== "confirmed" && !!onEditOriginalCharacter;
                    // Pagamento posterior: o valor NÃO foi transferido no aceite;
                    // fica pendente até a compensação única após a venda.
                    const deferredPending = isDeferredPaymentPending(record);
                    const settlementPreview = record.deferredPaymentChosen === true && saleValue !== undefined
                      ? computeDeferredSettlement(record, saleValue)
                      : null;

                    return (
                      <tr key={record.id} className="align-middle transition-colors hover:bg-sky-500/[0.035]">
                        <td className="border-b border-white/5 px-2 py-1.5"><CharacterCell record={record} /></td>
                        <td className="border-b border-white/5 px-2 py-1.5 text-center"><Perspective tone="sky" text={`Vendido para ${record.acquirerName || "—"}`} /></td>
                        <td className="border-b border-white/5 px-2 py-1.5 text-center" title={deferredPending
                          ? `Pagamento adiado a pedido do comprador (autorizado por você). Valor devido: ${formatRC(received)}. A diferença com a venda posterior será compensada em uma única transação.`
                          : "Valor integral que o comprador paga diretamente ao vendedor na aquisição."}>
                          <div className={`font-mono text-[11px] font-black ${deferredPending ? "text-violet-300" : initialPaymentConfirmed ? "text-sky-200" : "text-amber-200"}`}>{deferredPending ? formatRC(received) : initialPaymentConfirmed ? formatRC(received) : `A receber: ${formatRC(received)}`}</div>
                          {deferredPending
                            ? <span className="mt-1 inline-block text-[8px] font-bold text-violet-300">Pendente — comprador paga após a venda</span>
                            : initialPaymentConfirmed
                              ? <span className="mt-1 inline-flex items-center gap-1 text-[8px] font-medium text-emerald-200"><Clock3 size={9} /> {formatDateTime(record.paymentConfirmedAt || record.updatedAt)}</span>
                              : <span className="mt-1 inline-block text-[8px] font-medium text-amber-300">Aguardando confirmação</span>}
                        </td>
                        <td className="border-b border-white/5 px-2 py-1.5 text-center">
                          <div className={`font-mono text-[11px] font-bold ${saleValue !== undefined ? "text-violet-300" : "text-slate-500"}`}>{saleValue !== undefined ? formatRC(saleValue) : "Aguardando venda"}</div>
                          <div className="mt-1 flex items-center justify-center gap-1">
                            {saleValue !== undefined && <span className="text-[8px] text-violet-200">Direito do comprador</span>}
                            {canEditSale && <button type="button" onClick={() => onEditOriginalCharacter?.(record.characterId)} className="inline-flex h-4 w-4 items-center justify-center rounded border border-amber-500/30 bg-amber-500/10 text-amber-200 transition-colors hover:bg-amber-500/20" title="Editar o valor de venda no personagem original" aria-label="Editar valor da venda"><Pencil size={9} /></button>}
                          </div>
                        </td>
                        <td className="border-b border-white/5 px-2 py-1.5 text-center">
                          {!payoutReady ? (
                            <PaymentStamp value={record.status === "sold" ? "Aguardando valor da venda" : "Aguardando venda"} confirmed={false} />
                          ) : record.salePayoutStatus === "confirmed" ? (
                            <PaymentStamp value={`${record.deferredPaymentChosen === true ? "Compensado" : "Pago"} — ${formatDateTime(record.salePayoutConfirmedAt)}`} confirmed />
                          ) : settlementPreview ? (
                            // Pagamento posterior: rótulo direto de quem paga quem.
                            <div className="flex flex-col items-center gap-1">
                              <span className={`text-[8px] font-bold ${settlementPreview.direction === "none" ? "text-slate-400" : settlementPreview.direction === "owner_pays" ? "text-rose-300" : "text-emerald-300"}`}>
                                {settlementPreview.direction === "none"
                                  ? "Nenhum valor adicional a pagar"
                                  : settlementPreview.direction === "owner_pays"
                                    ? `Você deve pagar ${formatRC(settlementPreview.amount)} para ${record.acquirerName}`
                                    : `Você deve receber ${formatRC(settlementPreview.amount)} de ${record.acquirerName}`}
                              </span>
                              <button type="button" onClick={() => setSalePayoutPromptId(record.id)} className="inline-flex items-center gap-1 rounded-md border border-violet-500/35 bg-violet-500/10 px-2 py-1 text-[9px] font-black text-violet-200 transition-colors hover:bg-violet-500/20" title="Encerrar a pendência do pagamento posterior com a compensação única"><Send size={10} /> Encerrar</button>
                            </div>
                          ) : (
                            <button type="button" onClick={() => setSalePayoutPromptId(record.id)} className="inline-flex items-center gap-1 rounded-md border border-emerald-500/35 bg-emerald-500/10 px-2 py-1 text-[9px] font-black text-emerald-200 transition-colors hover:bg-emerald-500/20" title="Pagar o valor da venda ao Main Character do comprador"><Send size={10} /> Pagar</button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </div>

      <CharacterAcquisitionPaymentModal
        open={!!salePayoutPrompt}
        context={payoutContext}
        onClose={() => setSalePayoutPromptId(null)}
        onConfirm={async () => {
          if (!salePayoutPrompt || !onConfirmSalePayout) return { ok: false, error: "O repasse não está disponível neste momento." };
          const result = await onConfirmSalePayout(salePayoutPrompt.id);
          if (result.ok) setSalePayoutPromptId(null);
          return result;
        }}
      />
    </div>
  );
}