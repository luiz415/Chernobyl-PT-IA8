import { useMemo, useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { X, Coins, Copy, Check, PackageOpen, Users, Swords, Globe, ExternalLink } from "lucide-react";
import type { Character, ItemSaleRecord, PartyTab, WaitingService } from "../types";
import { formatRC } from "../types";
import { serverLabel } from "../constants/servers";
import { formatItemSaleSummary } from "../utils/itemSale";
import ItemSoldModal from "./ItemSoldModal";
import {
  buildItemSaleCommitPatch,
  buildPartyWhatsAppSummaryText,
  getVendidoButtonState,
  resolveSplitRecipient,
  type ExtendedPartySlotData,
} from "./PartyPanel";

// ============================================================================
// MODAL "ITENS A VENDA" — Gerenciador de PT's
// ----------------------------------------------------------------------------
// Centraliza, em tempo real, os itens dropados — pendentes E já vendidos —
// das PTs da categoria "Aguardando Pagamento" às quais o usuário atual tem
// acesso, e permite registrar a venda ("Vendido") sem sair do modal.
//
// FONTE DE DADOS — 100% local, nenhuma consulta nova ao Firestore:
//   • O PartyManager já escuta as PTs em tempo real; este modal recebe por
//     props APENAS as PTs "aguardando" que passaram pelas MESMAS regras de
//     acesso da lista (isPartyVisibleToViewer + participação p/ Normal).
//     Como cada usuário só recebe documentos que pode ver (reforçado pelas
//     Security Rules), a lista é individual por usuário — nunca global.
//   • Toda alteração nas PTs reflete aqui automaticamente (props -> useMemo).
//   • A GRAVAÇÃO da venda usa `onUpdateParty` — o MESMO `updateParty` do App
//     (optimistic update + debounce): a PT reflete a mudança imediatamente
//     e o Firestore recebe UMA escrita consolidada. Nenhum listener novo.
//
// LÓGICA REUTILIZADA (fonte única no PartyPanel — nada é reimplementado):
//   • getVendidoButtonState  — regras EXATAS do botão "Vendido" da coluna
//     ITEM VENDIDO/SERVICE (item dropado, quest concluída, sem travas/PG);
//   • buildItemSaleCommitPatch — patch EXATO gravado pelo commit do modal
//     "Item Vendido" na PT (registro completo + espelhos legados);
//   • buildPartyWhatsAppSummaryText — texto OFICIAL do "Copiar (WA)" da PT
//     (o painel usa a mesma função, então futuras mudanças valem nos dois);
//   • ItemSoldModal — o MESMO componente do fluxo da PT.
//
// CRITÉRIO "VENDIDO" — estado real do dado, não aparência:
//   itemVendido > 0 OU itemSale.resultRC > 0 (mesmo critério canônico do
//   status do Copiar (WA) e do aviso de divisão do PartyPanel).
// ============================================================================

/** Um item dropado (pendente ou vendido), com contexto do slot. */
export interface SaleModalItem {
  slotId: string;
  itemName: string;
  /** Nome do personagem que dropou (snapshot -> fonte viva -> lista -> externo). */
  characterName: string;
  /**
   * USUÁRIO PARTICIPANTE DA DIVISÃO deste item — o destinatário real da cota
   * (resolveSplitRecipient). Vazio apenas quando o slot está fora da divisão.
   */
  splitRecipient: string;
  /** O slot participa da divisão? */
  inSplit: boolean;
  /** Já vendido? (estado real: itemVendido > 0 ou itemSale.resultRC > 0). */
  sold: boolean;
  /** Valor registrado da venda, em RC (0 enquanto não vendido). */
  soldValueRC: number;
  /** Resumo da operação do modal "Item Vendido", quando registrado ("" sem). */
  saleSummary: string;
}

/** Itens agrupados por PT (com o contexto da PT e da divisão). */
export interface PartySaleGroup {
  partyId: string;
  partyName: string;
  /** "SW" | "SG" | "" (PTs antigas sem tipo). */
  questSigla: string;
  /** Nome canônico do servidor (pós-merge); "" quando a PT não tem servidor. */
  serverName: string;
  /** Quem recebe a divisão (destinatário resolvido por slot, sem repetição). */
  splitParticipants: string[];
  items: SaleModalItem[];
}

/** Nome do participante de um slot: snapshot da PT é a fonte primária
 *  (mesma precedência do PartyPanel), com quedas para fonte viva, Lista de
 *  Espera e membros externos. */
function resolveMemberName(
  party: PartyTab,
  id: string,
  characters: Character[],
  waitingList: WaitingService[],
): string {
  const snap = party.memberSnapshots?.[id];
  if (snap?.personagem) return snap.personagem;
  const live = characters.find(c => c.id === id);
  if (live?.personagem) return live.personagem;
  const wt = waitingList.find(w => w.id === id);
  if (wt?.personagem) return wt.personagem;
  const cm = (party.customMembers || []).find(m => m.id === id);
  if (cm?.label) return cm.label;
  return "";
}

/**
 * Extrai, das PTs recebidas (já filtradas por estágio "aguardando" + acesso
 * do usuário), TODOS os itens dropados — pendentes e vendidos — agrupados
 * por PT. Função pura: usada pelo modal e pelo contador do PartyManager
 * (que soma apenas os NÃO vendidos).
 */
export function collectSaleGroups(
  parties: PartyTab[],
  characters: Character[],
  waitingList: WaitingService[],
): PartySaleGroup[] {
  const groups: PartySaleGroup[] = [];

  for (const party of parties) {
    const sd = party.slotData || {};
    // Mesma composição de participantes usada pelo estágio da PT:
    // personagens selecionados + membros externos.
    const memberIds = [
      ...party.selectedIds,
      ...(party.customMembers || []).map(m => m.id),
    ];

    const items: SaleModalItem[] = [];
    for (const id of memberIds) {
      const slot = sd[id] as ExtendedPartySlotData | undefined;
      const itemName = String(slot?.itemDropado || "").trim();
      if (!itemName) continue;
      // Estado REAL da venda: valor em RC gravado (campo canônico) ou
      // registro completo do modal "Item Vendido".
      const soldValueRC = Math.max(slot?.itemVendido || 0, slot?.itemSale?.resultRC || 0);
      const sold = soldValueRC > 0;

      const characterName = resolveMemberName(party, id, characters, waitingList);
      const inSplit = !!slot?.split;
      // O que importa é o PARTICIPANTE DA DIVISÃO do item — destinatário
      // real da cota, resolvido exatamente como o painel resolve
      // (splitTarget explícito -> jogador; ausente -> dono).
      const fallback = String(slot?.owner || "").trim() || characterName;
      const splitRecipient = inSplit ? resolveSplitRecipient(slot, fallback || "?") : "";

      items.push({
        slotId: id,
        itemName,
        characterName: characterName || fallback || "?",
        splitRecipient,
        inSplit,
        sold,
        soldValueRC,
        saleSummary: slot?.itemSale && (slot.itemSale.resultRC || 0) > 0
          ? formatItemSaleSummary(slot.itemSale)
          : "",
      });
    }

    if (items.length === 0) continue;

    // Participantes da divisão da PT: destinatário REAL de cada slot com
    // DIVIDIR marcado (resolveSplitRecipient — a mesma resolução do painel
    // e do Copiar (WA) da PT), sem nomes repetidos.
    const splitParticipants: string[] = [];
    const seen = new Set<string>();
    for (const id of memberIds) {
      const slot = sd[id] as ExtendedPartySlotData | undefined;
      if (!slot?.split) continue;
      const fallback = String(slot.owner || "").trim() || resolveMemberName(party, id, characters, waitingList);
      const recipient = resolveSplitRecipient(slot, fallback || "?");
      const key = recipient.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      splitParticipants.push(recipient);
    }

    groups.push({
      partyId: party.id,
      partyName: party.name,
      questSigla: party.ptType === "sanguine" ? "SG" : party.ptType === "soulwar" ? "SW" : "",
      serverName: serverLabel(party.servidor) || "",
      splitParticipants,
      items,
    });
  }

  return groups;
}

/** Total de itens AINDA NÃO VENDIDOS (contador do botão no PartyManager). */
export function countUnsoldItems(groups: PartySaleGroup[]): number {
  return groups.reduce((s, g) => s + g.items.filter(i => !i.sold).length, 0);
}

/** Cópia p/ clipboard no MESMO padrão do PartyPanel (textarea + execCommand,
 *  com fallback assíncrono para navigator.clipboard). */
function copyText(texto: string) {
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
}

// ── PREFERÊNCIA "EXIBIR VENDIDOS" ───────────────────────────────────────────
// Persistida em localStorage (MESMO padrão do `usePersistedState` já usado no
// PartyManager para larguras/preferências de painel): estado local, leve e
// sem NENHUMA leitura/escrita no Firestore. Padrão: marcada (true).
const SHOW_SOLD_STORAGE_KEY = "itemsForSaleModal_showSold";

function readShowSoldPreference(): boolean {
  try {
    const v = localStorage.getItem(SHOW_SOLD_STORAGE_KEY);
    return v === null ? true : JSON.parse(v) === true;
  } catch {
    return true;
  }
}

interface Props {
  /** PTs "Aguardando Pagamento" ACESSÍVEIS ao usuário atual (o PartyManager
   *  aplica as regras de acesso ANTES de passar — o modal nunca vê PT sem
   *  permissão). */
  parties: PartyTab[];
  characters: Character[];
  waitingList: WaitingService[];
  /** MESMO canal de persistência da PT (updateParty do App: optimistic
   *  update + debounce -> uma escrita consolidada no Firestore). */
  onUpdateParty: (party: PartyTab) => void;
  onClose: () => void;
}

export default function ItemsForSaleModal({ parties, characters, waitingList, onUpdateParty, onClose }: Props) {
  // Recalculado a cada mudança nas PTs (props vivas do listener) — tempo real.
  const groups = useMemo(
    () => collectSaleGroups(parties, characters, waitingList),
    [parties, characters, waitingList],
  );
  const unsoldCount = countUnsoldItems(groups);
  const soldCount = groups.reduce((s, g) => s + g.items.filter(i => i.sold).length, 0);

  // ── "Exibir Vendidos" — preferência persistente (localStorage) ────────────
  // Marcada por padrão; sobrevive a fechar/reabrir o modal e ao próprio app.
  const [showSold, setShowSold] = useState<boolean>(readShowSoldPreference);
  useEffect(() => {
    try { localStorage.setItem(SHOW_SOLD_STORAGE_KEY, JSON.stringify(showSold)); } catch {}
  }, [showSold]);

  // Grupos VISÍVEIS conforme o filtro: com "Exibir Vendidos" desmarcada, os
  // itens vendidos saem de cada PT e PTs que ficarem sem itens saem da lista.
  // É um filtro derivado (useMemo sobre dados já em memória) — nenhuma
  // reconstrução além do necessário e nenhum acesso novo ao Firestore.
  // A EXIBIÇÃO e o "Copiar Completo (WA)" usam esta MESMA lista, então o
  // texto copiado corresponde exatamente ao que está na tela no clique.
  const visibleGroups = useMemo(() => {
    if (showSold) return groups;
    return groups
      .map(g => ({ ...g, items: g.items.filter(it => !it.sold) }))
      .filter(g => g.items.length > 0);
  }, [groups, showSold]);
  const visibleSoldCount = showSold ? soldCount : 0;

  const [copied, setCopied] = useState<"resumo" | "completo" | null>(null);
  const [copiedPartyId, setCopiedPartyId] = useState<string | null>(null);
  // Item com o modal "Item Vendido" aberto (dados derivados das props vivas).
  const [saleTarget, setSaleTarget] = useState<{ partyId: string; slotId: string } | null>(null);

  // Esc fecha (padrão dos demais modais do app) — mas NÃO enquanto o modal
  // "Item Vendido" está aberto por cima (ele mesmo trata o próprio Esc).
  useEffect(() => {
    if (saleTarget) return;
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, saleTarget]);

  function flagCopied(kind: "resumo" | "completo") {
    setCopied(kind);
    setTimeout(() => setCopied(c => (c === kind ? null : c)), 2500);
  }

  // ── Copiar Resumo (WA): somente servidor + item, SÓ itens não vendidos ────
  // (estrutura anterior preservada; vendidos são excluídos automaticamente).
  function copySummary() {
    const byServer = new Map<string, string[]>();
    groups.forEach(g => {
      const pendentes = g.items.filter(it => !it.sold);
      if (pendentes.length === 0) return;
      const key = g.serverName || "Sem servidor";
      const list = byServer.get(key) || [];
      pendentes.forEach(it => list.push(it.itemName));
      byServer.set(key, list);
    });

    const linhas: string[] = ["🏷️ *Itens a Venda:*"];
    byServer.forEach((itens, servidor) => {
      linhas.push("");
      linhas.push(`🌍 *${servidor}:*`);
      itens.forEach(item => linhas.push(`• ${item}`));
    });

    copyText(linhas.join("\n"));
    flagCopied("resumo");
  }

  // ── Copiar Completo (WA): EXATAMENTE os itens exibidos no momento ─────────
  // Usa `visibleGroups` (a mesma lista renderizada): com "Exibir Vendidos"
  // marcada inclui pendentes E vendidos (com valores); desmarcada, somente
  // pendentes — itens ocultos pelo filtro nunca entram no texto.
  function copyFull() {
    const fmtDateHH = (ts: number) => {
      const dt = new Date(ts);
      const dia = String(dt.getDate()).padStart(2, "0");
      const mes = String(dt.getMonth() + 1).padStart(2, "0");
      const hh = String(dt.getHours()).padStart(2, "0");
      const mm = String(dt.getMinutes()).padStart(2, "0");
      return `${dia}/${mes}, ${hh}:${mm}`;
    };

    const linhas: string[] = [
      showSold
        ? `🏷️ *Itens a Venda* (${unsoldCount} pendente${unsoldCount === 1 ? "" : "s"} · ${soldCount} vendido${soldCount === 1 ? "" : "s"})`
        : `🏷️ *Itens a Venda* (${unsoldCount} pendente${unsoldCount === 1 ? "" : "s"})`,
    ];
    visibleGroups.forEach(g => {
      linhas.push("");
      linhas.push(`📋 *PT: ${g.partyName}*${g.questSigla ? ` (${g.questSigla})` : ""}`);
      if (g.serverName) linhas.push(`🌍 Servidor: ${g.serverName}`);
      if (g.splitParticipants.length > 0) {
        linhas.push(`👥 Divisão entre ${g.splitParticipants.length}: ${g.splitParticipants.join(", ")}`);
      }
      g.items.forEach(it => {
        const participante = it.inSplit && it.splitRecipient ? ` — ${it.splitRecipient}` : " — fora da divisão";
        if (it.sold) {
          // Vendido: 🗡️ no item (como todos) + ✅ antes de "Vendido" com o
          // valor registrado (e a operação do modal, quando existir).
          const operacao = it.saleSummary ? ` (${it.saleSummary})` : "";
          linhas.push(`• 🗡️ ${it.itemName}${participante} — ✅ Vendido: ${formatRC(it.soldValueRC)}${operacao}`);
        } else {
          // Pendente: estado explícito após o nome do usuário.
          linhas.push(`• 🗡️ ${it.itemName}${participante} — Não vendido`);
        }
      });
    });
    linhas.push("");
    linhas.push(`📅 Documento gerado em: ${fmtDateHH(Date.now())}`);

    copyText(linhas.join("\n"));
    flagCopied("completo");
  }

  // ── Copiar (WA) de UMA PT: o texto OFICIAL do botão da própria PT ─────────
  // (buildPartyWhatsAppSummaryText é a MESMA função usada pelo PartyPanel —
  // mudanças futuras no texto oficial valem automaticamente aqui).
  function copyPartySummary(partyId: string) {
    const party = parties.find(p => p.id === partyId);
    if (!party) return;
    copyText(buildPartyWhatsAppSummaryText(party, characters, waitingList));
    setCopiedPartyId(partyId);
    setTimeout(() => setCopiedPartyId(c => (c === partyId ? null : c)), 2500);
  }

  // ── Salvar venda do modal "Item Vendido" ──────────────────────────────────
  // MESMO patch do commit da PT (buildItemSaleCommitPatch) gravado pelo MESMO
  // canal (onUpdateParty = updateParty do App): a PT reflete na hora
  // (optimistic update) e o Firestore recebe uma única escrita debounced.
  function commitSaleFromModal(sale: ItemSaleRecord) {
    if (!saleTarget) return;
    const party = parties.find(p => p.id === saleTarget.partyId);
    const sd = party?.slotData || {};
    const cur = sd[saleTarget.slotId];
    if (!party || !cur) { setSaleTarget(null); return; }
    onUpdateParty({
      ...party,
      slotData: { ...sd, [saleTarget.slotId]: { ...cur, ...buildItemSaleCommitPatch(sale) } },
    });
    setSaleTarget(null);
  }

  // Dados vivos do item em edição (deriva das props para o ItemSoldModal).
  const saleTargetData = useMemo(() => {
    if (!saleTarget) return null;
    const party = parties.find(p => p.id === saleTarget.partyId);
    const slot = (party?.slotData || {})[saleTarget.slotId] as ExtendedPartySlotData | undefined;
    if (!party || !slot) return null;
    return {
      itemName: slot.itemDropado || "Item",
      contextLabel: resolveMemberName(party, saleTarget.slotId, characters, waitingList) || party.name,
      initial: slot.itemSale || null,
    };
  }, [saleTarget, parties, characters, waitingList]);

  return createPortal(
    <div
      className="fixed inset-0 z-[500] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-xl rounded-2xl border border-amber-500/40 bg-gradient-to-b from-[#141017] to-[#0b0a10] shadow-[0_0_60px_rgba(245,158,11,0.08)] shadow-black/70 flex flex-col max-h-[84vh] overflow-hidden">
        {/* Cabeçalho — faixa com identidade âmbar (Aguardando Pagamento) */}
        <div className="relative px-4 py-3.5 border-b border-amber-500/20 bg-gradient-to-r from-amber-500/[0.12] via-amber-500/[0.05] to-transparent flex-shrink-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <span className="w-9 h-9 rounded-xl bg-amber-500/15 border border-amber-500/40 flex items-center justify-center shadow-[0_0_12px_rgba(245,158,11,0.15)]">
                <Coins size={17} className="text-amber-300" />
              </span>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-[15px] font-black text-amber-200 leading-tight tracking-tight">Itens a Venda</h3>
                  {unsoldCount > 0 && (
                    <span className="text-[10px] font-black px-1.5 py-px rounded-md bg-amber-500/20 border border-amber-500/40 text-amber-300 tabular-nums">
                      {unsoldCount} pendente{unsoldCount === 1 ? "" : "s"}
                    </span>
                  )}
                  {soldCount > 0 && (
                    <span className="text-[10px] font-black px-1.5 py-px rounded-md bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 tabular-nums">
                      {soldCount} vendido{soldCount === 1 ? "" : "s"}
                    </span>
                  )}
                </div>
                <p className="text-[10px] text-slate-400 leading-tight mt-0.5">
                  PTs em <span className="text-amber-400/90 font-semibold">Aguardando Pagamento</span> — itens pendentes e vendidos
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2.5">
              {/* ☑ Exibir Vendidos — preferência persistente (localStorage).
                  Controla a exibição E o conteúdo do Copiar Completo (WA). */}
              <label
                className="inline-flex items-center gap-1.5 cursor-pointer select-none text-[10px] font-bold text-slate-300 hover:text-emerald-300 transition-colors"
                title={showSold
                  ? "Ocultar os itens já vendidos (exibir somente os ainda à venda)"
                  : "Exibir também os itens já vendidos, com seus valores"}
              >
                <input
                  type="checkbox"
                  checked={showSold}
                  onChange={e => setShowSold(e.target.checked)}
                  className={`w-3.5 h-3.5 accent-emerald-500 cursor-pointer appearance-none rounded-[3px] border ${showSold ? "border-emerald-400 bg-emerald-500/30" : "border-slate-600 bg-black/40"} checked:bg-emerald-500/40 checked:border-emerald-400 relative checked:after:content-['✓'] checked:after:absolute checked:after:inset-0 checked:after:flex checked:after:items-center checked:after:justify-center checked:after:text-[8px] checked:after:text-emerald-300 checked:after:font-bold`}
                />
                Exibir Vendidos
              </label>
              <button
                type="button"
                onClick={onClose}
                className="w-7 h-7 rounded-lg border border-white/10 bg-white/5 text-slate-400 hover:text-white hover:bg-white/10 flex items-center justify-center transition-colors cursor-pointer"
                title="Fechar"
              >
                <X size={14} />
              </button>
            </div>
          </div>
        </div>

        {/* Corpo */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2.5">
          {visibleGroups.length === 0 ? (
            // Estado vazio elegante — o modal nunca fica em branco. Quando o
            // filtro está ocultando vendidos existentes, a mensagem explica.
            <div className="flex flex-col items-center justify-center text-center py-12 gap-3.5">
              <span className="w-14 h-14 rounded-2xl bg-amber-500/[0.06] border border-amber-500/20 flex items-center justify-center">
                <PackageOpen size={26} className="text-amber-400/50" />
              </span>
              <p className="text-sm font-bold text-slate-200">
                {!showSold && soldCount > 0
                  ? "Nenhum item pendente de venda no momento."
                  : "Você não tem acesso a nenhum item à venda no momento."}
              </p>
              <p className="text-[11px] text-slate-500 max-w-[320px] leading-relaxed">
                {!showSold && soldCount > 0
                  ? <>Todos os {soldCount} ite{soldCount === 1 ? "m" : "ns"} já foram vendidos — marque <span className="text-emerald-400/90">Exibir Vendidos</span> para vê-los com seus valores.</>
                  : <>Itens aparecem aqui quando uma PT sua entra em <span className="text-amber-400/80">Aguardando Pagamento</span> com itens dropados.</>}
              </p>
            </div>
          ) : (
            visibleGroups.map(g => {
              const party = parties.find(p => p.id === g.partyId);
              // "Copiar (WA)" da PT: MESMA condição de visibilidade do botão
              // no painel (quest finalizada e não falhada).
              const canCopyParty = !!party && !!party.questConcluida && !party.questFalha;
              return (
                <div
                  key={g.partyId}
                  className="rounded-xl border border-amber-500/25 bg-gradient-to-b from-amber-500/[0.07] to-transparent overflow-hidden"
                >
                  {/* Contexto da PT — faixa própria do card */}
                  <div className="flex items-center gap-2 flex-wrap px-3 py-1.5 bg-amber-500/[0.07] border-b border-amber-500/15">
                    <span className="text-[13px] font-black text-amber-200 truncate max-w-[190px]">{g.partyName}</span>
                    {g.questSigla && (
                      <span className={`text-[9px] font-bold px-1.5 py-px rounded-md border flex-shrink-0 ${
                        g.questSigla === "SG"
                          ? "border-rose-500/40 bg-rose-500/15 text-rose-300"
                          : "border-slate-400/30 bg-slate-500/15 text-slate-300"
                      }`}>
                        {g.questSigla}
                      </span>
                    )}
                    {g.serverName && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-px rounded-md border border-sky-500/35 bg-sky-500/15 text-sky-300 flex-shrink-0">
                        <Globe size={9} className="flex-shrink-0" />
                        {g.serverName}
                      </span>
                    )}
                    {/* Copiar (WA) da PT — mesmo texto/comportamento do botão da PT */}
                    {canCopyParty && (
                      <button
                        type="button"
                        onClick={() => copyPartySummary(g.partyId)}
                        className={`ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold border transition-colors whitespace-nowrap cursor-pointer flex-shrink-0 ${
                          copiedPartyId === g.partyId
                            ? "bg-emerald-500/30 border-emerald-500/50 text-emerald-200"
                            : "bg-sky-500/15 border-sky-500/40 text-sky-300 hover:bg-sky-500/25 hover:text-sky-200"
                        }`}
                        title={copiedPartyId === g.partyId ? "Texto copiado!" : "Copiar resumo da PT para o WhatsApp"}
                      >
                        {copiedPartyId === g.partyId ? <Check size={11} /> : <ExternalLink size={11} />}
                        {copiedPartyId === g.partyId ? "Copiado!" : "Copiar (WA)"}
                      </button>
                    )}
                  </div>

                  {/* Itens — pendentes e vendidos, diferenciados visualmente. */}
                  <div className="px-2.5 py-1.5 space-y-1">
                    {g.items.map(it => {
                      const slot = (party?.slotData || {})[it.slotId] as ExtendedPartySlotData | undefined;
                      // MESMAS regras do botão "Vendido" da PT (fonte única).
                      const vendidoEnabled = !!party && getVendidoButtonState(party, slot).enabled;
                      return (
                        <div
                          key={it.slotId}
                          className={`flex items-center gap-2 rounded-lg border px-2 py-1 ${
                            it.sold
                              ? "border-emerald-500/20 bg-emerald-500/[0.05]"
                              : "border-white/[0.06] bg-black/25"
                          }`}
                        >
                          {it.sold
                            ? <Check size={12} className="text-emerald-400 flex-shrink-0" />
                            : <Swords size={12} className="text-amber-400/80 flex-shrink-0" />}
                          <div className="min-w-0 flex-1">
                            <div className={`text-[12px] font-bold leading-tight truncate ${it.sold ? "text-emerald-200" : "text-slate-100"}`}>
                              {it.itemName}
                            </div>
                            <div className="text-[10px] text-slate-500 leading-tight truncate" title={it.saleSummary || undefined}>
                              {it.characterName}
                              {it.sold && it.saleSummary && <span className="text-slate-600"> · {it.saleSummary}</span>}
                            </div>
                          </div>
                          {it.sold && (
                            <span className="text-[11px] font-black tabular-nums text-emerald-300 flex-shrink-0" title="Valor registrado da venda">
                              {formatRC(it.soldValueRC)}
                            </span>
                          )}
                          {it.inSplit && it.splitRecipient ? (
                            <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded-md border flex-shrink-0 max-w-[32%] ${
                              it.sold
                                ? "border-emerald-500/25 bg-emerald-500/[0.08] text-emerald-300/80"
                                : "border-emerald-500/35 bg-emerald-500/12 text-emerald-300"
                            }`}>
                              <Users size={10} className="flex-shrink-0" />
                              <span className="truncate">{it.splitRecipient}</span>
                            </span>
                          ) : (
                            <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-md border border-slate-500/25 bg-slate-500/10 text-slate-400 flex-shrink-0">
                              fora da divisão
                            </span>
                          )}
                          {/* Botão "Vendido" — só quando as regras da PT permitem. */}
                          {!it.sold && vendidoEnabled && (
                            <button
                              type="button"
                              onClick={() => setSaleTarget({ partyId: g.partyId, slotId: it.slotId })}
                              title="Registrar a venda deste item (valor, cotação do RC e Taxa Market)"
                              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-bold transition-colors whitespace-nowrap border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/25 cursor-pointer flex-shrink-0"
                            >
                              <Coins size={10} /> Vender
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {/* Participantes da divisão da PT */}
                  {g.splitParticipants.length > 0 && (
                    <div className="px-3 pb-2 pt-0.5 flex items-start gap-1.5 text-[10px] text-slate-400">
                      <Users size={11} className="text-emerald-400/70 flex-shrink-0 mt-px" />
                      <span className="leading-snug">
                        <span className="font-bold text-emerald-300/90">Divisão ({g.splitParticipants.length}):</span>{" "}
                        {g.splitParticipants.join(", ")}
                      </span>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Rodapé */}
        <div className="flex items-center gap-2 px-4 py-3 border-t border-amber-500/15 bg-black/30 flex-shrink-0">
          <button
            type="button"
            onClick={copySummary}
            disabled={unsoldCount === 0}
            className="flex-1 py-2 rounded-lg border border-emerald-500/40 bg-emerald-500/12 text-emerald-300 text-[11px] font-bold hover:bg-emerald-500/22 hover:border-emerald-500/60 transition-colors cursor-pointer inline-flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {copied === "resumo" ? <Check size={12} /> : <Copy size={12} />}
            {copied === "resumo" ? "Copiado!" : "Copiar Resumo (WA)"}
          </button>
          <button
            type="button"
            onClick={copyFull}
            disabled={unsoldCount === 0 && visibleSoldCount === 0}
            className="flex-1 py-2 rounded-lg border border-sky-500/40 bg-sky-500/12 text-sky-300 text-[11px] font-bold hover:bg-sky-500/22 hover:border-sky-500/60 transition-colors cursor-pointer inline-flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {copied === "completo" ? <Check size={12} /> : <Copy size={12} />}
            {copied === "completo" ? "Copiado!" : "Copiar Completo (WA)"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="px-3.5 py-2 rounded-lg border border-white/10 bg-white/5 text-slate-300 text-[11px] font-bold hover:bg-white/10 transition-colors cursor-pointer"
          >
            Fechar
          </button>
        </div>
      </div>

      {/* Modal "Item Vendido" — o MESMO componente do fluxo da PT, aberto por
          cima deste modal com os dados vivos do slot. */}
      {saleTarget && saleTargetData && (
        <ItemSoldModal
          itemName={saleTargetData.itemName}
          contextLabel={saleTargetData.contextLabel}
          initial={saleTargetData.initial}
          onCancel={() => setSaleTarget(null)}
          onSave={commitSaleFromModal}
        />
      )}
    </div>,
    document.body,
  );
}
