import { useEffect, useMemo, useRef, useState } from "react";
import { BriefcaseBusiness, Check, Clock3, Copy, Handshake, Pencil, Send, UserRound } from "lucide-react";
import type { Character, CharacterAcquisition, CharacterAcquisitionBuyerDetails, NegotiationTimestamp, PtType } from "../types";
import { formatRC } from "../types";
import { ItemSelect, SANGUINE_ITEMS, SOULWAR_ITEMS } from "./CharTable";
import { getCharacterAcquisitionSellerReceived, isPaymentConfirmed } from "../services/characterAcquisitionService";
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
  return questType === "soulwar" || questType === "sanguine" ? questType : undefined;
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

  const itemList = questType === "soulwar" ? SOULWAR_ITEMS : SANGUINE_ITEMS;
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
  const salePayoutValue = salePayoutPrompt ? resolveOfficialSaleValue(salePayoutPrompt, currentUserUid, originalCharactersById) : undefined;

  const payoutContext: CharacterAcquisitionPaymentModalContext | null = salePayoutPrompt && salePayoutValue !== undefined ? {
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
  } : null;

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
                </thead>
                <tbody>
                  {purchased.map(record => {
                    const detail = buyerDetailsByAcquisition.get(record.id);
                    const initialPaymentConfirmed = isPaymentConfirmed(record);
                    const questProfit = detail?.questProfit || 0;
                    const saleValue = resolveOfficialSaleValue(record, currentUserUid, originalCharactersById);
                    const payoutReady = record.status === "sold" && saleValue !== undefined && saleValue > 0;
                    const total = questProfit + (saleValue || 0) - record.finalPaid;
                    const payoutLabel = !payoutReady
                      ? (record.status === "sold" ? "Aguardando valor da venda" : "Aguardando venda")
                      : record.salePayoutStatus === "confirmed"
                        ? `Pago — ${formatDateTime(record.salePayoutConfirmedAt)}`
                        : "Aguardando pagamento";

                    return (
                      <tr key={record.id} className="align-middle transition-colors hover:bg-emerald-500/[0.035]">
                        <td className="border-b border-white/5 px-2 py-1.5"><CharacterCell record={record} /></td>
                        <td className="border-b border-white/5 px-2 py-1.5 text-center"><Perspective tone="emerald" text={`Comprado de ${record.originalOwnerName || "—"}`} /></td>
                        <td className="border-b border-white/5 px-2 py-1.5 text-center"><QuestDropCell record={record} detail={detail} onUpdateQuestDrop={onUpdateQuestDrop} /></td>
                        <td className="border-b border-white/5 px-2 py-1.5 text-center"><QuestProfitCell record={record} detail={detail} onUpdateQuestProfit={onUpdateQuestProfit} /></td>
                        <td className="border-b border-white/5 px-2 py-1.5 text-center" title={`Base ${formatRC(record.originalCharacterCost)} + taxa pessoal ${formatRC(personalFee(record))} + taxa Bazaar ${formatRC(record.bazaarFee)}`}><span className="font-mono text-[11px] font-black text-amber-200">{formatRC(record.finalPaid)}</span></td>
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
              <table className="w-full min-w-[650px] table-fixed border-separate border-spacing-0 text-xs">
                <colgroup>
                  <col className="w-[22%]" /><col className="w-[18%]" /><col className="w-[19%]" />
                  <col className="w-[15%]" /><col className="w-[12%]" /><col className="w-[14%]" />
                </colgroup>
                <thead className="sticky top-0 z-10 bg-[var(--th-bg-base)] text-[8px] uppercase tracking-wider text-slate-500 shadow-[0_1px_0_rgba(255,255,255,0.06)]">
                  <tr>
                    {['Personagem', 'Perspectiva', 'Valor Recebido', 'Venda', 'Total', 'PG'].map(label => <th key={label} className="border-b border-[var(--th-line)]/60 px-2 py-2 text-center font-black whitespace-nowrap first:text-left">{label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {sold.map(record => {
                    const received = getCharacterAcquisitionSellerReceived(record);
                    const initialPaymentConfirmed = isPaymentConfirmed(record);
                    const saleValue = resolveOfficialSaleValue(record, currentUserUid, originalCharactersById);
                    const payoutReady = record.status === "sold" && saleValue !== undefined && saleValue > 0;
                    const total = received - record.originalCharacterCost;
                    const canEditSale = record.salePayoutStatus !== "confirmed" && !!onEditOriginalCharacter;

                    return (
                      <tr key={record.id} className="align-middle transition-colors hover:bg-sky-500/[0.035]">
                        <td className="border-b border-white/5 px-2 py-1.5"><CharacterCell record={record} /></td>
                        <td className="border-b border-white/5 px-2 py-1.5 text-center"><Perspective tone="sky" text={`Vendido para ${record.acquirerName || "—"}`} /></td>
                        <td className="border-b border-white/5 px-2 py-1.5 text-center" title="Valor integral que o comprador paga diretamente ao vendedor na aquisição.">
                          <div className={`font-mono text-[11px] font-black ${initialPaymentConfirmed ? "text-sky-200" : "text-amber-200"}`}>{initialPaymentConfirmed ? formatRC(received) : `A receber: ${formatRC(received)}`}</div>
                          {initialPaymentConfirmed
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
                        <td className={`border-b border-white/5 px-2 py-1.5 text-center font-mono text-[11px] font-black ${total >= 0 ? "text-sky-200" : "text-rose-300"}`}>{initialPaymentConfirmed ? formatRC(total) : "—"}</td>
                        <td className="border-b border-white/5 px-2 py-1.5 text-center">
                          {!payoutReady ? (
                            <PaymentStamp value={record.status === "sold" ? "Aguardando valor da venda" : "Aguardando venda"} confirmed={false} />
                          ) : record.salePayoutStatus === "confirmed" ? (
                            <PaymentStamp value={`Pago — ${formatDateTime(record.salePayoutConfirmedAt)}`} confirmed />
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