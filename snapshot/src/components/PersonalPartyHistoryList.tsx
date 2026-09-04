import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Archive, Check, Clock, Coins, Copy, Crown, ExternalLink, Lock, Pencil, RotateCcw, ShieldCheck, Swords, User, Users, X } from "lucide-react";
import type { PersonalPartyHistory, PersonalPartyHistorySlot } from "../types";
import { customAlert, formatRC } from "../types";
import { toFirestoreMillis } from "../utils/firestoreTimestamp";
import { ItemSelect, ITEM_COLORS, SANGUINE_ITEMS, SOULWAR_ITEMS } from "./CharTable";
import { FilterInline, FilterSelect } from "./FilterTypes";
import { savePartyHistoryOverrides, subscribePartyHistoryOverrides } from "../services/partyHistoryService";
import { classifyDroppedItems } from "../utils/profitClassification";
import {
  cardSlots,
  filterHistoryEntries,
  QUEST_FILTER_SANGUINE,
  QUEST_FILTER_SOULWAR,
  SORT_DATE_DESC,
  SORT_OPTIONS,
  sortHistoryEntries,
} from "../utils/historyQuery";
import {
  applySlotOverrides,
  MAX_MANUAL_PROFIT_RC,
  type PartyHistoryOverrides,
} from "../utils/historyOverrides";

interface Props {
  entries: PersonalPartyHistory[];
  /**
   * UID do usuário logado — habilita as correções de Drop/Lucro nos
   * personagens dele. Sem UID (ou com readOnly) o card fica somente leitura.
   */
  uid?: string;
  /** Nome de exibição do usuário — identifica os personagens em que ele é o DONO (edição de Lucro). */
  userName?: string;
  /** Sem persistência disponível (ex.: modo simulação): correções desativadas. */
  readOnly?: boolean;
  /**
   * partyId da PT a destacar — usado pela navegação do botão "Ver PT" das
   * notificações. Destaque TEMPORÁRIO de frontend (nada persistido): o card
   * pisca por alguns segundos e o estado é consumido no próprio clique,
   * mesmo padrão do antigo destaque da guia "Histórico de PT's".
   */
  highlightedPartyId?: string | null;
  /** Chamado quando o destaque é consumido (limpa o estado no App). */
  onClearHighlight?: () => void;
}

function formatDate(value: unknown): string {
  const millis = toFirestoreMillis(value as any);
  if (!millis) return "—";
  return new Date(millis).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Mesma forma compacta de duração do Histórico de PT's ("1h20m"). */
function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h <= 0) return `${m}m`;
  return `${h}h${m}m`;
}

/** Valor em RC ou "—" quando não existe/está vazio/é zero (padrão do app). */
function rcOrDash(value: number): string {
  return value > 0 ? formatRC(value) : "—";
}

/**
 * Lucro por personagem: sem valor informado NÃO se exibe "0 RC" nem vazio —
 * mostra "Não informado" (padrão desta guia para campos sem dado).
 */
function rcOrNotInformed(value: number): string {
  return value > 0 ? formatRC(value) : "Não informado";
}

/**
 * Estado do card — os DOIS momentos ficam visualmente distintos:
 *   • "Aguardando Pagamento" (quest_finalized): Quest concluída, mas a PT
 *     ainda não foi paga/finalizada — valores do resumo NÃO definitivos;
 *   • "Finalizada" (finalized): pagamento realizado, processo encerrado.
 */
function statusPresentation(status: PersonalPartyHistory["status"]) {
  if (status === "finalized") {
    return {
      label: "Finalizada",
      title: "PT Finalizada — pagamento realizado e processo definitivamente encerrado",
      className: "border-emerald-500/35 bg-emerald-500/10 text-emerald-300",
    };
  }
  if (status === "failed") {
    return {
      label: "Falhou",
      title: "PT encerrada como falha",
      className: "border-rose-500/35 bg-rose-500/10 text-rose-300",
    };
  }
  return {
    label: "Aguardando Pagamento",
    title: "Quest concluída — PT ainda aguardando pagamento/finalização (valores não definitivos)",
    className: "border-amber-500/35 bg-amber-500/10 text-amber-300",
  };
}

/** Asterisco de pendência dos valores (PT em "Aguardando Pagamento"). */
function PendingMark() {
  return <span className="font-black text-amber-300" aria-hidden="true">*</span>;
}

/**
 * Mesma regra de arredondamento do painel da PT e do backend
 * (`roundSplitTo25` em PartyPanel.tsx / partyLifecycleCore.ts): o valor
 * individual da divisão vai ao múltiplo de 25 pela regra do corte em 10 —
 * para baixo quando faltam MAIS de 10 unidades para o múltiplo superior, para
 * cima quando faltam 10 ou menos (389 -> 375 · 390 -> 400). Duplicada aqui
 * para não importar o módulo inteiro do PartyPanel por causa de poucas linhas.
 */
function roundSplitTo25(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const lower = Math.floor(value / 25) * 25;
  const excess = value - lower;
  if (excess === 0) return lower;
  return (25 - excess) <= 10 ? lower + 25 : lower;
}

/**
 * Nome de quem recebe a participação, no mesmo espírito do
 * `resolveSplitRecipient` do PartyPanel: a escolha explícita gravada no slot
 * (`splitTargetName`) prevalece; sem ela, o JOGADOR, depois o DONO, depois o
 * próprio personagem.
 */
function slotRecipientName(slot: PersonalPartyHistorySlot): string {
  return (slot.splitTargetName || slot.playerName || slot.ownerName || slot.characterName || "?").trim() || "?";
}

/** Copia o texto usando o mesmo caminho do "Copiar (WA)" do PartyPanel. */
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

/**
 * Resumo para WhatsApp com o MESMO formato do botão "Copiar (WA)" do painel
 * da PT, porém alimentado pelo snapshot congelado no histórico privado
 * (estado da PT no momento da conclusão da Quest). Recebe os slots JÁ
 * CORRIGIDOS pelo usuário (correções manuais de Drop/Lucro entram no texto).
 * Detalhes da calculadora kk/RC não fazem parte da projeção, então a linha de
 * venda usa a forma simples "Vendido por {RC}" — o único valor que de fato
 * existe no documento.
 */
function buildWhatsAppSummary(entry: PersonalPartyHistory, slots: PersonalPartyHistorySlot[]): string {
  const party = entry.party;

  const fmtDateHH = (ts: number) => {
    const dt = new Date(ts);
    const dia = String(dt.getDate()).padStart(2, "0");
    const mes = String(dt.getMonth() + 1).padStart(2, "0");
    const hh = String(dt.getHours()).padStart(2, "0");
    const mm = String(dt.getMinutes()).padStart(2, "0");
    return `${dia}/${mes}, ${hh}:${mm}`;
  };

  const linhas: string[] = [];

  // 1) Cabeçalho — Nome da PT (SW/SG)
  const questSigla = party.questType === "sanguine" ? "SG" : "SW";
  linhas.push(`📋 *Resumo da PT: ${party.name}* (${questSigla})`);

  // 2) Servidor da PT (omitido quando não gravado)
  if (party.server) linhas.push(`🌍 *Servidor:* ${party.server}`);

  // 3) Data da finalização (momento da conclusão congelado na projeção)
  const finalizadaTs = toFirestoreMillis(party.finalizedAt || party.questFinalizedAt || entry.updatedAt) || Date.now();
  linhas.push(`📅 PT Finalizada em: ${fmtDateHH(finalizadaTs)}`);

  // 4) Status — considera APENAS itens dropados pelos membros da DIVISÃO
  const splitSlots = slots.filter(slot => slot.split);
  const unsoldItemNames = splitSlots
    .filter(slot => !!slot.itemDropado && (!slot.itemVendido || slot.itemVendido <= 0))
    .map(slot => (slot.itemDropado || "").trim())
    .filter(Boolean);
  linhas.push(``);
  linhas.push(unsoldItemNames.length > 0
    ? `📌 Status: Ainda falta vender ${unsoldItemNames.join(", ")}`
    : `📌 Status: Todos os itens foram vendidos`);
  linhas.push(``);

  // 5) Total vendido + divisão entre os participantes
  const totalVendido = splitSlots.reduce((sum, slot) => sum + (slot.itemVendido || 0), 0);
  const splitCount = splitSlots.length;
  linhas.push(`👥 *Divisão entre ${splitCount} participante${splitCount === 1 ? "" : "s"}:*`);
  linhas.push(``);

  splitSlots.forEach(slot => {
    const jogador = slotRecipientName(slot);
    const itemDropado = (slot.itemDropado || "").trim();
    const itemVendido = slot.itemVendido || 0;
    if (itemDropado && itemVendido > 0) {
      linhas.push(`• ${jogador}: ${itemDropado} > Vendido por ${formatRC(itemVendido)}`);
    } else if (!itemDropado && itemVendido > 0) {
      linhas.push(`• ${jogador}: Service: ${formatRC(itemVendido)}`);
    } else if (itemDropado && itemVendido <= 0) {
      linhas.push(`• ${jogador}: O item ${itemDropado} ainda não foi vendido.`);
    } else {
      linhas.push(`• ${jogador}: Não declarou nenhum valor.`);
    }
  });
  linhas.push(``);

  // 6) Totais — o valor individual segue a MESMA regra exibida na PT
  // (roundSplitTo25 do total pela quantidade de participantes da divisão), então o
  // texto copiado mostra o mesmo número da tela mesmo para quem não é
  // beneficiário (cujo documento guarda valuePerMember = 0).
  const valorIndividual = splitCount > 0 ? roundSplitTo25(totalVendido / splitCount) : (entry.division?.valuePerMember || 0);
  linhas.push(`💰 *Total Vendido:* ${formatRC(totalVendido)}`);
  linhas.push(`🔹 *Valor Individual:* ${formatRC(valorIndividual)} para cada.`);
  linhas.push(``);

  // 7) Status do pagamento — SOMENTE quando não há item pendente de venda
  if (unsoldItemNames.length === 0) {
    const todosPagos = splitCount > 0 && splitSlots.every(slot => slot.paid === true);
    linhas.push(todosPagos
      ? `💳 *Status do pagamento:* Pago. ✅`
      : `💳 *Status do pagamento:* Falta pagar. ❌`);
    linhas.push(``);
  }

  // 8) Timestamp do documento
  linhas.push(`📅 Documento gerado em: ${fmtDateHH(Date.now())}`);

  return linhas.join("\n");
}

// ── Grid de personagens: trilhas FIXAS para alinhamento vertical perfeito ────
// Mesma folha de estilo para o cabeçalho de campos e para cada linha de
// personagem — nomes, donos, jogadores, drops, lucros e divisão ficam todos
// alinhados entre os personagens, nas duas colunas.
const CHAR_GRID_TEMPLATE = {
  gridTemplateColumns: "minmax(64px,1.1fr) minmax(48px,0.72fr) minmax(48px,0.72fr) minmax(112px,1.25fr) minmax(72px,0.9fr) 26px",
} as const;

/** Duração do destaque do "Ver PT": feedback visual temporário, nunca persistente. */
const FLASH_HIGHLIGHT_MS = 2000;

interface CardProps {
  entry: PersonalPartyHistory;
  /** Correções ativas desta PT (slotId → Drop/Lucro). */
  overrides: PartyHistoryOverrides;
  /** Edição habilitada (usuário logado + persistência disponível). */
  canEdit: boolean;
  /** Nome de exibição do usuário (comparado ao ownerName do slot). */
  userName: string;
  onOverridesChange: (
    partyId: string,
    next: PartyHistoryOverrides,
    previous: PartyHistoryOverrides | undefined,
  ) => void;
  /** Card destacado pela navegação do "Ver PT" (destaque temporário). */
  highlighted?: boolean;
}

/** Rótulo miúdo de campo da linha de personagem (identidade herdada das colunas). */
function FieldLabel({ children, tone = "slate", className = "" }: { children: ReactNode; tone?: "slate" | "amber" | "sky" | "emerald"; className?: string }) {
  const toneClass = tone === "amber"
    ? "text-amber-400/70"
    : tone === "sky"
      ? "text-sky-400/70"
      : tone === "emerald"
        ? "text-emerald-400/70"
        : "text-slate-500";
  return <span className={`text-[8px] font-black uppercase tracking-wide ${toneClass} ${className}`}>{children}</span>;
}

function PersonalPartyHistoryCard({ entry, overrides, canEdit, userName, onOverridesChange, highlighted }: CardProps) {
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [copiedSlotId, setCopiedSlotId] = useState<string | null>(null);
  const nameCopiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Rascunho do Lucro em edição (um slot por vez, por card). */
  const [profitDraft, setProfitDraft] = useState<{ slotId: string; value: string } | null>(null);

  useEffect(() => () => {
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    if (nameCopiedTimer.current) clearTimeout(nameCopiedTimer.current);
  }, []);

  function handleCopyWhatsApp() {
    try {
      copyTextToClipboard(buildWhatsAppSummary(entry, viewSlots));
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 2500);
    } catch {}
  }

  /** Copia EXATAMENTE o nome do personagem do slot (campo Personagem). */
  function handleCopyCharacterName(slot: PersonalPartyHistorySlot) {
    const name = String(slot.characterName || "").trim();
    if (!name) return;
    copyTextToClipboard(name);
    setCopiedSlotId(slot.slotId);
    if (nameCopiedTimer.current) clearTimeout(nameCopiedTimer.current);
    nameCopiedTimer.current = setTimeout(() => setCopiedSlotId(null), 2000);
  }

  // ── Correções locais (Drop/Lucro dos personagens do usuário) ─────────────
  // Permissões: Drop editável nos personagens do próprio usuário
  // (personalSlots); Lucro somente nos personagens em que ele é o DONO
  // (ownerName == nome de exibição — a projeção privada não expõe UIDs de
  // terceiros). O valor importado é o padrão; corrigir grava override
  // PRIVADO que nunca altera a PT nem o que outros veem.
  const originalSlots = cardSlots(entry);
  const ownSlotIds = new Set(entry.personalSlots.map(slot => slot.slotId));
  const normalizedUserName = userName.trim();
  const isSlotProfitEditable = (slot: PersonalPartyHistorySlot) =>
    canEdit && !!normalizedUserName && ownSlotIds.has(slot.slotId) && (slot.ownerName || "").trim() === normalizedUserName;

  function commitOverrides(next: PartyHistoryOverrides) {
    onOverridesChange(entry.partyId, next, overrides);
  }

  /** Corrige o Drop de um personagem do usuário (lista oficial de itens, igual à coluna DROP SW). */
  function handleDropChange(slot: PersonalPartyHistorySlot, value: string) {
    const original = (originalSlots.find(s => s.slotId === slot.slotId)?.itemDropado || "").trim();
    const drops = { ...(overrides.drops || {}) };
    if (value.trim() === original) {
      delete drops[slot.slotId]; // igual ao importado → volta ao padrão
    } else {
      drops[slot.slotId] = value;
    }
    commitOverrides({ drops, profits: { ...(overrides.profits || {}) } });
  }

  /** Corrige o Lucro (RC) de um personagem em que o usuário é o DONO. */
  function handleProfitChange(slot: PersonalPartyHistorySlot, raw: string) {
    const original = originalSlots.find(s => s.slotId === slot.slotId)?.itemVendido || 0;
    const parsed = Math.min(MAX_MANUAL_PROFIT_RC, Math.max(0, parseInt(raw.replace(/[^\d]/g, ""), 10) || 0));
    const profits = { ...(overrides.profits || {}) };
    if (parsed === original) {
      delete profits[slot.slotId]; // igual ao importado → volta ao padrão
    } else {
      profits[slot.slotId] = parsed;
    }
    commitOverrides({ drops: { ...(overrides.drops || {}) }, profits });
  }

  /** Remove a correção de uma célula (Drop ou Lucro), restaurando o valor importado. */
  function handleRevertOverride(slotId: string, field: "drops" | "profits") {
    if (field === "drops") {
      const drops = { ...(overrides.drops || {}) };
      delete drops[slotId];
      commitOverrides({ drops, profits: { ...(overrides.profits || {}) } });
    } else {
      const profits = { ...(overrides.profits || {}) };
      delete profits[slotId];
      commitOverrides({ drops: { ...(overrides.drops || {}) }, profits });
    }
  }

  const status = statusPresentation(entry.status);
  // PT em "Aguardando Pagamento": os valores do resumo ainda NÃO são o
  // resultado financeiro definitivo — os badges de valores exibem o indicador
  // de pendência (*) com tooltip. Some sozinho quando a PT é finalizada.
  const awaitingPayment = entry.status === "quest_finalized";
  const pendingSuffix = awaitingPayment
    ? " — aguardando pagamento/finalização da PT: valor ainda não definitivo"
    : "";
  const party = entry.party;
  const division = entry.division;
  const roles = entry.roles;

  // Slots efetivos (importados + correções manuais) — alimentam as linhas,
  // estatísticas e o texto do "Copiar (WA)".
  const viewSlots = originalSlots.map(slot => applySlotOverrides(slot, overrides));

  // ── Datas: dois momentos DISTINTOS, visualmente diferenciados ────────────
  // Quest = quando a Quest foi concluída (abre a liquidação); Finalizada =
  // encerramento definitivo da PT (histórico fechado). Só aparecem quando
  // existem no documento. Fallback legado: sem NENHUMA das duas, o updatedAt
  // segue sendo exibido como referência (comportamento anterior do card).
  const questMillis = toFirestoreMillis(party.questFinalizedAt);
  const finalMillis = toFirestoreMillis(party.finalizedAt);
  const questSource = questMillis ? party.questFinalizedAt : (!finalMillis ? entry.updatedAt : null);
  const questDateLabel = questSource && toFirestoreMillis(questSource) ? formatDate(questSource) : "";
  const finalDateLabel = finalMillis ? formatDate(party.finalizedAt) : "";
  const durationLabel = party.durationMs > 0 ? formatDuration(party.durationMs) : "";

  // ── Estatísticas consolidadas (com as correções aplicadas) ────────────────
  const totalDeaths = viewSlots.reduce((sum, slot) => sum + (slot.deaths || 0), 0);
  const splitCount = viewSlots.filter(slot => slot.split).length;
  const totalVendido = viewSlots.filter(slot => slot.split).reduce((sum, slot) => sum + (slot.itemVendido || 0), 0);
  const valorIndividual = entry.allSlots?.length && splitCount > 0 ? roundSplitTo25(totalVendido / splitCount) : (division.valuePerMember || 0);

  // Classificação de lucro pelos drops da PT — a MESMA função do rodapé do
  // PartyPanel (src/utils/profitClassification.ts), sobre TODOS os
  // personagens da PT, com as correções manuais aplicadas.
  const profitClass = classifyDroppedItems(viewSlots.map(slot => slot.itemDropado));

  // Lista oficial de itens por Quest — MESMA fonte da coluna DROP SW.
  const questItemOptions = party.questType === "soulwar"
    ? SOULWAR_ITEMS
    : party.questType === "sanguine"
      ? SANGUINE_ITEMS
      : [...SOULWAR_ITEMS, ...SANGUINE_ITEMS];

  // ── Seção 1: número no topo; Quest com destaque evidente (padrão do app) ─
  const questBadge = party.questType === "sanguine"
    ? { label: "Sanguine", className: "border-rose-400/70 bg-rose-500/20 text-rose-200 shadow-[0_0_12px_-2px_rgba(244,63,94,0.55)]", accent: "#fb7185" }
    : party.questType === "soulwar"
      ? { label: "Soul War", className: "border-slate-300/60 bg-slate-300/15 text-slate-100 shadow-[0_0_12px_-2px_rgba(226,232,240,0.45)]", accent: "#cbd5e1" }
      : { label: "Quest", className: "border-slate-500/60 bg-slate-500/15 text-slate-300", accent: "var(--th-line)" };

  // ── Distribuição 3+2: coluna esquerda recebe ceil(n/2) personagens ───────
  // (5 → 3+2, 4 → 2+2, 3 → 2+1, 6 → 3+3). Em containers estreitos as duas
  // colunas viram uma única coluna empilhada (container query @4xl).
  const leftCount = Math.ceil(viewSlots.length / 2);
  const leftChars = viewSlots.slice(0, leftCount);
  const rightChars = viewSlots.slice(leftCount);

  /** Uma linha de personagem no grid de trilhas fixas (alinhamento perfeito). */
  const renderCharacterRow = (slot: PersonalPartyHistorySlot) => {
    const own = ownSlotIds.has(slot.slotId);
    const nameCopied = copiedSlotId === slot.slotId;
    const dropEditable = canEdit && own;
    const profitEditable = isSlotProfitEditable(slot);
    const dropOverridden = overrides.drops?.[slot.slotId] !== undefined;
    const profitOverridden = overrides.profits?.[slot.slotId] !== undefined;
    return (
      <div
        key={slot.slotId}
        className={`grid items-center gap-x-2 rounded-md border-b border-white/[0.07] px-1 py-[3px] text-[10px] leading-none last:border-b-0 ${own ? "bg-sky-500/[0.07]" : ""}`}
        style={CHAR_GRID_TEMPLATE}
        title={own ? "Personagem seu" : undefined}
      >
        {/* Personagem — botão que copia o nome exatamente */}
        <div className="flex min-w-0 items-center justify-center gap-1">
          <button
            type="button"
            onClick={() => handleCopyCharacterName(slot)}
            title={nameCopied ? "Nome copiado" : `Copiar "${slot.characterName || "Personagem"}"`}
            className={`group inline-flex min-w-0 cursor-copy items-center justify-center gap-1 rounded px-0.5 py-0.5 font-bold transition-colors ${
              nameCopied
                ? "bg-emerald-500/15 text-emerald-300"
                : "text-slate-200 hover:bg-white/[0.07] hover:text-white"
            }`}
          >
            <span className="truncate">{slot.characterName || "Personagem"}</span>
            {nameCopied
              ? <Check size={10} strokeWidth={3} className="flex-shrink-0 text-emerald-400" />
              : <Copy size={10} className="flex-shrink-0 text-slate-500 opacity-0 transition-opacity group-hover:opacity-80" />}
          </button>
          {(slot.deaths || 0) > 0 && (
            <span className="flex-shrink-0 font-black tabular-nums text-rose-400" title={`${slot.deaths} morte(s)`}>☠{slot.deaths}</span>
          )}
        </div>

        {/* Dono */}
        <div className="min-w-0 truncate text-center font-semibold text-amber-200/80" title={slot.ownerName || undefined}>{slot.ownerName || "—"}</div>

        {/* Jogador */}
        <div className="min-w-0 truncate text-center font-semibold text-sky-200/80" title={slot.playerName || undefined}>{slot.playerName || "—"}</div>

        {/* Drop — cores oficiais por item; "Não informado" sem dado;
            editável (ItemSelect da DROP SW) nos personagens do usuário */}
        <div className="flex min-w-0 items-center justify-center gap-1">
          {dropEditable ? (
            <>
              <ItemSelect
                value={slot.itemDropado}
                onChange={value => handleDropChange(slot, value)}
                itemList={questItemOptions}
              />
              {dropOverridden && (
                <button
                  type="button"
                  onClick={() => handleRevertOverride(slot.slotId, "drops")}
                  className="flex-shrink-0 cursor-pointer text-amber-400/70 transition-colors hover:text-amber-300"
                  title="Drop corrigido manualmente — clique para restaurar o valor importado"
                >
                  <RotateCcw size={10} />
                </button>
              )}
            </>
          ) : slot.itemDropado ? (
            <span className="min-w-0 truncate text-center font-semibold" style={{ color: ITEM_COLORS[slot.itemDropado] || "#cbd5e1" }} title={slot.itemDropado + (dropOverridden ? " (corrigido por você)" : "")}>
              {slot.itemDropado}
            </span>
          ) : slot.isService ? (
            <span className="truncate text-center font-semibold text-violet-300/90" title="Service — valor cobrado pelo serviço, sem item dropado">Service</span>
          ) : (
            <span className="truncate text-center italic text-slate-500" title="Nenhum drop registrado para este personagem">Não informado</span>
          )}
        </div>

        {/* Lucro — "Não informado" sem valor; editável (RC) nos
            personagens em que o usuário é o DONO */}
        <div className="flex min-w-0 items-center justify-center gap-1">
          {profitEditable ? (
            profitDraft?.slotId === slot.slotId ? (
              /* Edição inline do Lucro — mesmo padrão de campo RC do
                 PartyPanel (dígitos, tabular-nums). */
              <span className="inline-flex items-center gap-1">
                <input
                  type="text"
                  inputMode="numeric"
                  autoFocus
                  value={profitDraft.value}
                  onChange={e => setProfitDraft({ slotId: slot.slotId, value: e.target.value.replace(/[^\d]/g, "") })}
                  onFocus={e => e.currentTarget.select()}
                  onBlur={() => {
                    if (profitDraft?.slotId === slot.slotId) handleProfitChange(slot, profitDraft.value);
                    setProfitDraft(null);
                  }}
                  onKeyDown={e => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    if (e.key === "Escape") setProfitDraft(null);
                  }}
                  placeholder="0"
                  title="Lucro em RC — Enter salva, Esc cancela"
                  className="w-[64px] rounded border border-emerald-500/40 bg-black/30 px-1 py-0.5 text-right text-[10px] tabular-nums text-emerald-200 outline-none focus:border-emerald-400/70"
                />
                <span className="text-[9px] font-bold text-emerald-400/70 select-none">RC</span>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setProfitDraft({ slotId: slot.slotId, value: String(slot.itemVendido || "") })}
                className="group inline-flex min-w-0 cursor-pointer items-center justify-center gap-1 rounded px-0.5 font-mono font-semibold text-emerald-300 transition-colors hover:text-emerald-200"
                title="Corrigir o lucro deste personagem (somente o DONO pode editar)"
              >
                <span className="truncate text-center">{rcOrNotInformed(slot.itemVendido || 0)}</span>
                <Pencil size={9} className="flex-shrink-0 text-emerald-500/60 opacity-0 transition-opacity group-hover:opacity-100" />
              </button>
            )
          ) : (
            <span className={`truncate text-center font-mono font-semibold ${slot.itemVendido > 0 ? "text-emerald-300" : "italic text-slate-500"}`} title={profitOverridden ? "Lucro corrigido manualmente" : undefined}>
              {rcOrNotInformed(slot.itemVendido || 0)}
            </span>
          )}
          {profitOverridden && profitDraft?.slotId !== slot.slotId && (
            <button
              type="button"
              onClick={() => handleRevertOverride(slot.slotId, "profits")}
              className="flex-shrink-0 cursor-pointer text-amber-400/70 transition-colors hover:text-amber-300"
              title="Lucro corrigido manualmente — clique para restaurar o valor importado"
            >
              <RotateCcw size={10} />
            </button>
          )}
        </div>

        {/* Divisão */}
        <div className="flex items-center justify-center">
          {slot.split ? (
            <span
              className="inline-flex items-center gap-0.5 font-black text-emerald-300"
              title={slot.isDivisionBeneficiary ? "Participa da divisão (valor destinado a você)" : "Participa da divisão"}
            >
              ✓{slot.isDivisionBeneficiary && <span className="text-amber-300" title="Você recebe esta divisão">★</span>}
            </span>
          ) : (
            <span className="text-slate-600" title="Não participa da divisão">—</span>
          )}
        </div>
      </div>
    );
  };

  /** Cabeçalho de campos de uma meia-coluna (mesmas trilhas → alinhamento). */
  const renderFieldHeader = () => (
    <div className="grid items-center gap-x-2 border-b border-white/[0.08] px-1 pb-[3px]" style={CHAR_GRID_TEMPLATE}>
      <FieldLabel className="text-center">Personagem</FieldLabel>
      <FieldLabel tone="amber" className="text-center">Dono</FieldLabel>
      <FieldLabel tone="sky" className="text-center">Jogador</FieldLabel>
      <FieldLabel className="text-center">Drop</FieldLabel>
      <FieldLabel tone="emerald" className="text-center">Lucro</FieldLabel>
      <FieldLabel tone="emerald" className="text-center">Div</FieldLabel>
    </div>
  );

  return (
    <article
      id={`personal_history_pt_${entry.partyId}`}
      className={`rounded-xl border p-2 transition-colors ${
        highlighted
          ? "border-amber-400 bg-amber-500/25 ring-2 ring-amber-400/60 shadow-[0_0_20px_color-mix(in_oklab,var(--color-amber-500)_35%,transparent)] animate-pulse"
          : "border-[var(--th-line)] bg-[var(--th-bg-raised)]/75 shadow-sm hover:border-[var(--th-brand)]/50"
      }`}
      style={{ borderLeft: `3px solid ${questBadge.accent}` }}
    >
      <div className="flex flex-col gap-1.5 lg:flex-row lg:gap-2">
        {/* ═══ SEÇÃO 1 — IDENTIFICAÇÃO (esquerda, centralizada) ══════════════
            Número da PT primeiro, isolado no topo (identificação principal do
            card); pequeno espaçamento visual; região central com Servidor e
            Quest alinhados e destacados (Quest nas cores padrão do app). */}
        <aside className="flex shrink-0 flex-col items-center gap-1 text-center lg:w-[116px] lg:border-r lg:border-white/5 lg:pr-2">
          <div className="w-full min-w-0">
            <div className="text-[8px] font-black uppercase tracking-widest text-slate-500">Número da PT</div>
            <div className="truncate text-lg font-black leading-tight text-white" title={party.name || "PT"}>{party.name || "PT"}</div>
          </div>
          <div className="mt-0.5 w-full border-t border-white/5 pt-1">
            <span
              className={`mb-1.5 inline-flex w-full flex-shrink-0 items-center justify-center truncate rounded border border-sky-500/30 bg-sky-500/10 px-2 py-[3px] text-[9px] font-black uppercase tracking-wider text-sky-300 ${party.server ? "" : "opacity-60"}`}
              title={`Servidor: ${party.server || "não informado"}`}
            >
              {party.server || "Servidor —"}
            </span>
            <span className={`inline-flex w-full flex-shrink-0 items-center justify-center gap-1 rounded border px-2 py-1 text-[10px] font-black uppercase tracking-widest ${questBadge.className}`}>
              <Swords size={11} strokeWidth={2.5} />{questBadge.label}
            </span>
          </div>
        </aside>

        {/* ═══ SEÇÃO 2 — INFORMAÇÕES DA PT (maior seção) ════════════════════
            Linha de contexto (status, Líder, datas, duração, participantes) e
            os personagens em DUAS COLUNAS EQUILIBRADAS (3+2 para PTs de 5),
            com trilhas fixas de grid — cada campo alinhado entre todos os
            personagens, sem ocupar altura desnecessária. */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[10px] leading-none text-slate-400">
            <span
              className={`flex-shrink-0 rounded border px-1.5 py-0.5 text-[8px] font-black uppercase tracking-wide ${status.className}`}
              title={status.title}
            >
              {status.label}
            </span>
            <span className="inline-flex items-center gap-1 whitespace-nowrap" title="Líder da PT">
              <User size={10} className="text-emerald-400" />
              <span>Líder <span className="font-semibold text-slate-200">{party.leaderName || "—"}</span></span>
            </span>
            {questDateLabel && (
              <span className="inline-flex items-center gap-1 whitespace-nowrap" title="Data e horário da conclusão da Quest">
                <Clock size={10} className="text-emerald-400" />
                <span>Quest <span className="font-mono font-semibold text-emerald-300">{questDateLabel}</span></span>
              </span>
            )}
            {finalDateLabel && (
              <span
                className="inline-flex items-center gap-1 whitespace-nowrap rounded border border-violet-500/30 bg-violet-500/10 px-1.5 py-[2px]"
                title="Data e horário da finalização definitiva da PT (histórico fechado)"
              >
                <Lock size={10} className="text-violet-300" />
                <span>Finalizada <span className="font-mono font-semibold text-violet-200">{finalDateLabel}</span></span>
              </span>
            )}
            {durationLabel && (
              <span className="inline-flex items-center gap-1 whitespace-nowrap font-semibold text-sky-300" title="Duração efetiva da Quest">
                {durationLabel}
              </span>
            )}
            <span className="inline-flex items-center gap-1 whitespace-nowrap" title={`${viewSlots.length} personagem(ns) na PT${totalDeaths > 0 ? ` · ${totalDeaths} morte(s)` : ""}${splitCount > 0 ? ` · ${splitCount} na divisão` : ""}`}>
              <Users size={10} className="text-slate-500" />
              <span className="font-bold text-slate-300 tabular-nums">{viewSlots.length}</span>
              {totalDeaths > 0 && <span className="font-black tabular-nums text-rose-400">☠{totalDeaths}</span>}
              {splitCount > 0 && <span className="font-bold text-slate-400">· {splitCount} div</span>}
            </span>
            <div className="ml-auto flex flex-shrink-0 items-center gap-1">
              {/* "SEU LUCRO" — participação do usuário na divisão desta PT
                  (valor oficial gravado pelo backend), em destaque verde no
                  cabeçalho do card, junto aos papéis e ao Copiar (WA). */}
              {division.participates && (
                <span
                  className="mr-1 inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-emerald-400/50 bg-emerald-500/20 px-2 py-0.5 shadow-[0_0_10px_-2px_rgba(16,185,129,0.55)]"
                  title={`Seu lucro nesta PT — participação na divisão (valor oficial gravado pelo backend)${pendingSuffix}`}
                >
                  <Coins size={11} className="flex-shrink-0 text-emerald-400" />
                  <span className="text-[9px] font-bold uppercase tracking-wide text-emerald-300">Seu Lucro{awaitingPayment && <PendingMark />}</span>
                  <span className="font-mono text-[11px] font-black leading-none text-emerald-100 tabular-nums">{rcOrDash(division.valuePerMember || 0)}</span>
                </span>
              )}
              {roles.leader && <span title="Líder" className="rounded border border-violet-500/30 bg-violet-500/10 p-1 text-violet-300"><Crown size={11} /></span>}
              {roles.owner && <span title="Dono de personagem" className="rounded border border-amber-500/30 bg-amber-500/10 p-1 text-amber-300"><Users size={11} /></span>}
              {roles.player && <span title="Jogador" className="rounded border border-sky-500/30 bg-sky-500/10 p-1 text-sky-300"><ShieldCheck size={11} /></span>}
              {/* BOTÃO "COPIAR (WA)" — mesmo visual/fluxo do painel da PT; PTs
                  falhadas não geram resumo de divisão, então o botão é omitido. */}
              {entry.status !== "failed" && (
                <button
                  type="button"
                  onClick={handleCopyWhatsApp}
                  className={`ml-1 inline-flex cursor-pointer items-center gap-1 whitespace-nowrap rounded border px-2 py-0.5 text-[10px] font-bold transition-colors ${
                    copied
                      ? "border-emerald-500/50 bg-emerald-500/30 text-emerald-200"
                      : "border-sky-500/40 bg-sky-500/15 text-sky-300 hover:bg-sky-500/25 hover:text-sky-200"
                  }`}
                  title={copied ? "Texto copiado!" : "Copiar resumo da PT para o WhatsApp"}
                >
                  {copied ? <Check size={12} /> : <ExternalLink size={12} />} {copied ? "Copiado!" : "Copiar (WA)"}
                </button>
              )}
            </div>
          </div>

          {/* Personagens em duas colunas equilibradas. Container query: as
              colunas ficam lado a lado quando há espaço real (@4xl) e
              empilham em telas estreitas — nada cortado, nada escondido. */}
          {viewSlots.length > 0 && (
            <div className="mt-1 @container">
              <div className="overflow-x-auto rounded-lg border border-white/5 bg-black/20 px-1.5 py-[3px]">
                <div className="min-w-[430px] @4xl:flex @4xl:min-w-0 @4xl:gap-3">
                  <div className="min-w-0 flex-1">
                    {renderFieldHeader()}
                    <div className="flex flex-col gap-[2px]">{leftChars.map(renderCharacterRow)}</div>
                  </div>
                  {/* Divisor vertical central — 1px, tom de linha interna da
                      tabela, esticado pela altura das colunas. Só existe com a
                      estrutura efetivamente dividida em dois lados (rightChars
                      preenchido E colunas lado a lado no @4xl); empilhado em
                      telas estreitas ele fica oculto (hidden). */}
                  {rightChars.length > 0 && (
                    <div aria-hidden="true" className="hidden @4xl:block @4xl:w-px @4xl:self-stretch @4xl:flex-shrink-0 @4xl:bg-white/[0.13]" />
                  )}
                  {rightChars.length > 0 && (
                    <div className="mt-2 min-w-0 flex-1 @4xl:mt-0">
                      {renderFieldHeader()}
                      <div className="flex flex-col gap-[2px]">{rightChars.map(renderCharacterRow)}</div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ═══ SEÇÃO 3 — RESUMO FINANCEIRO (lado direito) ════════════════════
           Badges destacados: Valor total, Por participante da divisão e a
           classificação de lucro (MESMA regra do rodapé do PartyPanel, via
           classifyDroppedItems) + a sua participação oficial. No espaço curto
           os badges fluem em linha; em telas largas formam a coluna direita. */}
        <div className="flex shrink-0 flex-row flex-wrap items-stretch gap-1 lg:w-[148px] lg:flex-col lg:border-l lg:border-white/5 lg:pl-2">
          <div className="flex-1 rounded border border-white/10 bg-black/30 px-2 py-[3px] lg:flex-none" title={`Total vendido pelos participantes da divisão${pendingSuffix}`}>
            <div className="text-[8px] font-bold uppercase tracking-widest text-slate-500">Valor total{awaitingPayment && <PendingMark />}</div>
            <div className="font-mono text-[12px] font-black leading-tight text-white tabular-nums">{rcOrDash(totalVendido)}</div>
          </div>
          {splitCount > 0 && (
            <div className="flex-1 rounded border border-emerald-500/25 bg-emerald-500/[0.08] px-2 py-[3px] lg:flex-none" title={`Valor destinado a quem participou da divisão (${splitCount} participante(s)) — mesma regra da PT: múltiplos de 25 para baixo${pendingSuffix}`}>
              <div className="text-[8px] font-bold uppercase tracking-widest text-emerald-400/80">Por participante{awaitingPayment && <PendingMark />}</div>
              <div className="font-mono text-[11px] font-black leading-tight text-emerald-300 tabular-nums">{rcOrDash(valorIndividual)}</div>
            </div>
          )}
          <div
            className="flex-1 rounded border px-2 py-[3px] lg:flex-none"
            style={{ borderColor: `${profitClass.color}55`, background: `${profitClass.color}14` }}
            title={`Classificação de lucro pelos drops da PT — a MESMA regra do rodapé do painel da PT${pendingSuffix}`}
          >
            <div className="text-[8px] font-bold uppercase tracking-widest" style={{ color: `${profitClass.color}cc` }}>Lucro da PT{awaitingPayment && <PendingMark />}</div>
            <div className="text-[11px] font-black leading-tight" style={{ color: profitClass.color }}>{profitClass.label}</div>
          </div>
        </div>
      </div>
    </article>
  );
}

/**
 * Histórico individual: lê exclusivamente os documentos privados do usuário
 * (projeção já assinada pela guia). Filtros e ordenação operam 100% sobre os
 * dados JÁ CARREGADOS — nenhuma leitura extra do Firestore.
 */
export default function PersonalPartyHistoryList({ entries, uid, userName, readOnly, highlightedPartyId, onClearHighlight }: Props) {
  const [overridesByParty, setOverridesByParty] = useState<Record<string, PartyHistoryOverrides>>({});

  // ── Filtros (combináveis) e ordenação (padrão: conclusão, recentes 1º) ────
  const [characterQuery, setCharacterQuery] = useState("");
  const [questFilter, setQuestFilter] = useState("");
  const [userQuery, setUserQuery] = useState("");
  const [serverFilter, setServerFilter] = useState("");
  const [sortOption, setSortOption] = useState<string>(SORT_DATE_DESC);

  // Correções locais: listener montado apenas enquanto a guia está aberta
  // (mesmo padrão do histórico privado em si).
  useEffect(() => {
    if (readOnly || !uid) {
      setOverridesByParty({});
      return;
    }
    return subscribePartyHistoryOverrides(uid, setOverridesByParty);
  }, [uid, readOnly]);

  /** Aplica a correção otimisticamente e persiste; em falha, REVERTE e avisa. */
  async function handleOverridesChange(
    partyId: string,
    next: PartyHistoryOverrides,
    previous: PartyHistoryOverrides | undefined,
  ) {
    setOverridesByParty(cur => ({ ...cur, [partyId]: next }));
    if (!uid) return;
    const result = await savePartyHistoryOverrides(uid, partyId, next);
    if (!result.ok) {
      setOverridesByParty(cur => ({ ...cur, [partyId]: previous ?? {} }));
      customAlert(result.error || "Não foi possível salvar a correção do histórico.", "Correção do histórico");
    }
  }

  // Servidores disponíveis: derivados dos dados já carregados (sem leituras).
  const serverOptions = useMemo(() => {
    const set = new Set<string>();
    entries.forEach(entry => {
      const server = String(entry.party.server || "").trim();
      if (server) set.add(server);
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [entries]);

  // Filtro + ordenação — tudo local, combinável (Quest + Servidor +
  // Personagem + Usuário participante).
  // Filtro + ordenação delegados ao util puro (src/utils/historyQuery.ts) —
  // tudo local sobre os dados já carregados.
  const visibleEntries = useMemo(
    () => sortHistoryEntries(
      filterHistoryEntries(entries, {
        characterQuery,
        questFilter,
        userQuery,
        serverFilter,
      }),
      sortOption,
      overridesByParty,
    ),
    [entries, characterQuery, questFilter, userQuery, serverFilter, sortOption, overridesByParty],
  );

  const hasActiveFilters = !!characterQuery.trim() || !!questFilter || !!userQuery.trim() || !!serverFilter;

  function clearFilters() {
    setCharacterQuery("");
    setQuestFilter("");
    setUserQuery("");
    setServerFilter("");
  }

  // ── Destaque temporário vindo do botão "Ver PT" (notificação) ─────────────
  // Feedback visual TEMPORÁRIO da navegação: o card é localizado (limpando
  // filtros que o escondam e rolando até ele), destaca por EXATAMENTE 2s e o
  // destaque some sozinho. Nada persiste — o estado do pai é consumido no
  // próprio uso — e reabrir o "Meu Histórico" normalmente nunca exibe card
  // destacado.
  const [flashingId, setFlashingId] = useState<string | null>(null);
  // O timer do brilho vive num ref FORA do ciclo do efeito: consumir o
  // destaque no pai (onClearHighlight) muda as dependências e dispararia o
  // cleanup — que cancelaria o timer e deixaria o card destacado para sempre
  // (era exatamente o bug do destaque "permanente").
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
  }, []);
  const highlightedEntryExists = !!highlightedPartyId
    && entries.some(entry => entry.partyId === highlightedPartyId);
  const highlightedEntryVisible = !!highlightedPartyId
    && visibleEntries.some(entry => entry.partyId === highlightedPartyId);
  useEffect(() => {
    if (!highlightedPartyId) return;
    // Filtros ativos escondendo a PT alvo? Limpa os filtros para garantir que
    // o card seja localizado (a ordenação nunca esconde ninguém — mantida).
    if (highlightedEntryExists && !highlightedEntryVisible) {
      if (hasActiveFilters) clearFilters();
      return;
    }
    if (!highlightedEntryVisible) return; // lista ainda carregando (listener sob demanda)
    setFlashingId(highlightedPartyId);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setFlashingId(null), FLASH_HIGHLIGHT_MS);
    // Scroll até o card assim que ele estiver na tela.
    const scrollTimer = setTimeout(() => {
      const el = document.getElementById(`personal_history_pt_${highlightedPartyId}`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
      // Consome o destaque no pai imediatamente após o uso (uso único).
      if (onClearHighlight) onClearHighlight();
    }, 100);
    // Só o scroll é cancelável: o brilho SEMPRE expira sozinho em 2s.
    return () => clearTimeout(scrollTimer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightedPartyId, highlightedEntryExists, highlightedEntryVisible, hasActiveFilters, onClearHighlight]);

  if (entries.length === 0) {
    return (
      <div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-[var(--th-line)]/50 bg-[var(--th-bg-raised)]/30 px-5 text-center text-slate-500">
        <Archive size={34} className="opacity-35" />
        <div>
          <p className="text-sm font-bold text-slate-400">Nenhuma PT no seu histórico privado</p>
          <p className="mt-1 text-[11px] leading-relaxed">As PTs novas aparecerão aqui automaticamente após a Quest ser processada.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-hidden">
      {/* ── CABEÇALHO DA GUIA — filtros combináveis + ordenação ──────────────
          Tudo opera sobre os dados já carregados (projeção assinada): zero
          leituras extras do Firestore. Padrão: Data de conclusão, mais
          recente primeiro. */}
      <header className="flex flex-wrap items-center gap-1.5 rounded-xl border border-[var(--th-line)]/80 bg-[var(--th-bg-raised)]/60 px-2 py-1.5 shadow-sm">
        <span className="mr-1 inline-flex items-center gap-1.5 whitespace-nowrap text-[11px] font-black uppercase tracking-wider text-slate-300">
          <Archive size={13} className="text-sky-400" />
          <span className="hidden sm:inline">Histórico</span>
        </span>
        <span
          className="whitespace-nowrap rounded border border-white/5 bg-black/25 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-slate-400"
          title="PTs exibidas / total no histórico"
        >
          {visibleEntries.length}/{entries.length}
        </span>
        <FilterInline
          value={characterQuery}
          onChange={setCharacterQuery}
          placeholder="Personagem"
          icon={<User size={11} className="text-slate-500" />}
          maxWidth="120px"
        />
        <FilterSelect
          label="Quest"
          options={[QUEST_FILTER_SOULWAR, QUEST_FILTER_SANGUINE]}
          selected={questFilter}
          onSelect={setQuestFilter}
          allLabel="Todas"
        />
        <FilterInline
          value={userQuery}
          onChange={setUserQuery}
          placeholder="Usuário participante"
          icon={<Users size={11} className="text-slate-500" />}
          maxWidth="150px"
        />
        <FilterSelect
          label="Servidor"
          options={serverOptions}
          selected={serverFilter}
          onSelect={setServerFilter}
          searchable
          allLabel="Todos"
          emptyMessage="Nenhum servidor registrado no histórico"
        />
        <FilterSelect
          label="Ordenar por"
          options={SORT_OPTIONS}
          selected={sortOption}
          onSelect={setSortOption}
          allLabel=""
        />
        {hasActiveFilters && (
          <button
            type="button"
            onClick={clearFilters}
            className="inline-flex cursor-pointer items-center gap-1 whitespace-nowrap rounded border border-rose-500/30 bg-rose-500/10 px-1.5 py-0.5 text-[10px] font-bold text-rose-300 transition-colors hover:bg-rose-500/20 hover:text-rose-200"
            title="Limpar todos os filtros"
          >
            <X size={11} /> Limpar filtros
          </button>
        )}
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto pr-1">
        {visibleEntries.length === 0 ? (
          <div className="flex min-h-[160px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--th-line)]/50 bg-[var(--th-bg-raised)]/30 px-5 text-center text-slate-500">
            <Archive size={26} className="opacity-35" />
            <p className="text-[12px] font-bold text-slate-400">Nenhuma PT corresponde aos filtros</p>
            <button
              type="button"
              onClick={clearFilters}
              className="cursor-pointer rounded border border-sky-500/40 bg-sky-500/15 px-2 py-0.5 text-[10px] font-bold text-sky-300 transition-colors hover:bg-sky-500/25 hover:text-sky-200"
            >
              Limpar filtros
            </button>
          </div>
        ) : (
          visibleEntries.map(entry => (
            <PersonalPartyHistoryCard
              key={entry.id}
              entry={entry}
              overrides={overridesByParty[entry.partyId] || {}}
              canEdit={!!uid && !readOnly}
              userName={userName || ""}
              onOverridesChange={handleOverridesChange}
              highlighted={flashingId === entry.partyId}
            />
          ))
        )}
      </div>
    </div>
  );
}