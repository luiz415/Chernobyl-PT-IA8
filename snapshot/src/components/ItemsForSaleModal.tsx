import { useMemo, useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { X, Coins, Copy, Check, PackageOpen, Users, Swords, Globe } from "lucide-react";
import type { Character, PartyTab, WaitingService } from "../types";
import { serverLabel } from "../constants/servers";
import { resolveSplitRecipient, type ExtendedPartySlotData } from "./PartyPanel";

// ============================================================================
// MODAL "ITENS A VENDA" — Gerenciador de PT's
// ----------------------------------------------------------------------------
// Centraliza, em tempo real, os itens dropados que AINDA NÃO FORAM VENDIDOS
// nas PTs da categoria "Aguardando Pagamento" às quais o usuário atual tem
// acesso.
//
// FONTE DE DADOS — 100% local, nenhuma consulta nova ao Firestore:
//   • O PartyManager já escuta as PTs em tempo real; este modal recebe por
//     props APENAS as PTs "aguardando" que passaram pelas MESMAS regras de
//     acesso da lista (isPartyVisibleToViewer + participação p/ Normal).
//     Como cada usuário só recebe documentos que pode ver (reforçado pelas
//     Security Rules), a lista é individual por usuário — nunca global.
//   • Toda alteração nas PTs reflete aqui automaticamente (props -> useMemo).
//
// CRITÉRIO "AINDA NÃO VENDIDO" — estado real do dado, não aparência:
//   itemDropado preenchido E itemVendido <= 0 E sem registro de venda do
//   modal "Item Vendido" (itemSale.resultRC). É o MESMO critério canônico já
//   usado pelo PartyPanel no status do Copiar (WA) e no aviso de divisão
//   ("splitMembersWithUnsoldItems"). Registrou a venda -> some do modal.
//
// PARTICIPANTE POR ITEM — o dono do personagem NÃO importa aqui: o que
// identifica o item é o USUÁRIO PARTICIPANTE DA DIVISÃO daquele slot, ou
// seja, o destinatário real resolvido por `resolveSplitRecipient` (a mesma
// precedência do painel e do Copiar (WA) da PT: splitTarget explícito ->
// jogador; ausente -> dono). Slots fora da divisão são marcados como tal.
// ============================================================================

/** Um item dropado e ainda não vendido, com contexto do slot. */
export interface UnsoldSaleItem {
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
}

/** Itens à venda agrupados por PT (com o contexto da PT e da divisão). */
export interface PartySaleGroup {
  partyId: string;
  partyName: string;
  /** "SW" | "SG" | "" (PTs antigas sem tipo). */
  questSigla: string;
  /** Nome canônico do servidor (pós-merge); "" quando a PT não tem servidor. */
  serverName: string;
  /** Quem recebe a divisão (destinatário resolvido por slot, sem repetição). */
  splitParticipants: string[];
  items: UnsoldSaleItem[];
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
 * do usuário), os itens dropados ainda não vendidos — agrupados por PT.
 * Função pura: usada pelo modal e pelo contador do botão no PartyManager.
 */
export function collectUnsoldSaleGroups(
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

    const items: UnsoldSaleItem[] = [];
    for (const id of memberIds) {
      const slot = sd[id] as ExtendedPartySlotData | undefined;
      const itemName = String(slot?.itemDropado || "").trim();
      if (!itemName) continue;
      // Estado REAL da venda: valor em RC gravado (campo canônico) ou
      // registro completo do modal "Item Vendido" -> item já vendido.
      const sold = (slot?.itemVendido || 0) > 0 || (slot?.itemSale?.resultRC || 0) > 0;
      if (sold) continue;

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

interface Props {
  /** PTs "Aguardando Pagamento" ACESSÍVEIS ao usuário atual (o PartyManager
   *  aplica as regras de acesso ANTES de passar — o modal nunca vê PT sem
   *  permissão). */
  parties: PartyTab[];
  characters: Character[];
  waitingList: WaitingService[];
  onClose: () => void;
}

export default function ItemsForSaleModal({ parties, characters, waitingList, onClose }: Props) {
  // Recalculado a cada mudança nas PTs (props vivas do listener) — tempo real.
  const groups = useMemo(
    () => collectUnsoldSaleGroups(parties, characters, waitingList),
    [parties, characters, waitingList],
  );
  const totalItems = groups.reduce((s, g) => s + g.items.length, 0);

  const [copied, setCopied] = useState<"resumo" | "completo" | null>(null);

  // Esc fecha (padrão dos demais modais do app).
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function flagCopied(kind: "resumo" | "completo") {
    setCopied(kind);
    setTimeout(() => setCopied(c => (c === kind ? null : c)), 2500);
  }

  // ── Copiar Resumo (WA): somente servidor + item, agrupado por servidor ────
  function copySummary() {
    const byServer = new Map<string, string[]>();
    groups.forEach(g => {
      const key = g.serverName || "Sem servidor";
      const list = byServer.get(key) || [];
      g.items.forEach(it => list.push(it.itemName));
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

  // ── Copiar Completo (WA): item + servidor + PT + divisão, por PT ──────────
  // Cada item nomeia o USUÁRIO PARTICIPANTE DA DIVISÃO (destinatário real da
  // cota) — o dono do personagem não é citado.
  function copyFull() {
    const fmtDateHH = (ts: number) => {
      const dt = new Date(ts);
      const dia = String(dt.getDate()).padStart(2, "0");
      const mes = String(dt.getMonth() + 1).padStart(2, "0");
      const hh = String(dt.getHours()).padStart(2, "0");
      const mm = String(dt.getMinutes()).padStart(2, "0");
      return `${dia}/${mes}, ${hh}:${mm}`;
    };

    const linhas: string[] = [`🏷️ *Itens a Venda* (${totalItems} ite${totalItems === 1 ? "m" : "ns"})`];
    groups.forEach(g => {
      linhas.push("");
      linhas.push(`📋 *PT: ${g.partyName}*${g.questSigla ? ` (${g.questSigla})` : ""}`);
      if (g.serverName) linhas.push(`🌍 Servidor: ${g.serverName}`);
      if (g.splitParticipants.length > 0) {
        linhas.push(`👥 Divisão entre ${g.splitParticipants.length}: ${g.splitParticipants.join(", ")}`);
      }
      g.items.forEach(it => {
        // Linha enxuta: item + usuário participante da divisão (sem nome do
        // personagem e sem o rótulo "Participante").
        const participante = it.inSplit && it.splitRecipient
          ? ` — ${it.splitRecipient}`
          : " — fora da divisão";
        linhas.push(`• 🗡️ ${it.itemName}${participante}`);
      });
    });
    linhas.push("");
    linhas.push(`📅 Documento gerado em: ${fmtDateHH(Date.now())}`);

    copyText(linhas.join("\n"));
    flagCopied("completo");
  }

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
                  {totalItems > 0 && (
                    <span className="text-[10px] font-black px-1.5 py-px rounded-md bg-amber-500/20 border border-amber-500/40 text-amber-300 tabular-nums">
                      {totalItems} ite{totalItems === 1 ? "m" : "ns"}
                    </span>
                  )}
                </div>
                <p className="text-[10px] text-slate-400 leading-tight mt-0.5">
                  PTs em <span className="text-amber-400/90 font-semibold">Aguardando Pagamento</span> com itens ainda não vendidos
                </p>
              </div>
            </div>
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

        {/* Corpo */}
        <div className="flex-1 overflow-y-auto px-4 py-3.5 space-y-3">
          {groups.length === 0 ? (
            // Estado vazio elegante — o modal nunca fica em branco.
            <div className="flex flex-col items-center justify-center text-center py-12 gap-3.5">
              <span className="w-14 h-14 rounded-2xl bg-amber-500/[0.06] border border-amber-500/20 flex items-center justify-center">
                <PackageOpen size={26} className="text-amber-400/50" />
              </span>
              <p className="text-sm font-bold text-slate-200">
                Você não tem acesso a nenhum item à venda no momento.
              </p>
              <p className="text-[11px] text-slate-500 max-w-[320px] leading-relaxed">
                Itens aparecem aqui quando uma PT sua entra em <span className="text-amber-400/80">Aguardando Pagamento</span> com itens dropados ainda não vendidos.
              </p>
            </div>
          ) : (
            groups.map(g => (
              <div
                key={g.partyId}
                className="rounded-xl border border-amber-500/25 bg-gradient-to-b from-amber-500/[0.07] to-transparent overflow-hidden"
              >
                {/* Contexto da PT — faixa própria do card */}
                <div className="flex items-center gap-2 flex-wrap px-3 py-2 bg-amber-500/[0.07] border-b border-amber-500/15">
                  <span className="text-[13px] font-black text-amber-200 truncate max-w-[220px]">{g.partyName}</span>
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
                  <span className="ml-auto text-[9px] font-bold text-amber-400/70 tabular-nums flex-shrink-0">
                    {g.items.length} ite{g.items.length === 1 ? "m" : "ns"}
                  </span>
                </div>

                {/* Itens ainda não vendidos — o que identifica cada item é o
                    PARTICIPANTE DA DIVISÃO (destinatário real da cota). */}
                <div className="px-3 py-2 space-y-1.5">
                  {g.items.map(it => (
                    <div
                      key={it.slotId}
                      className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-black/25 px-2.5 py-1.5"
                    >
                      <Swords size={12} className="text-amber-400/80 flex-shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="text-[12px] font-bold text-slate-100 leading-tight truncate">{it.itemName}</div>
                        <div className="text-[10px] text-slate-500 leading-tight truncate">{it.characterName}</div>
                      </div>
                      {it.inSplit && it.splitRecipient ? (
                        <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-md border border-emerald-500/35 bg-emerald-500/12 text-emerald-300 flex-shrink-0 max-w-[45%]">
                          <Users size={10} className="flex-shrink-0" />
                          <span className="truncate">{it.splitRecipient}</span>
                        </span>
                      ) : (
                        <span className="text-[9px] font-semibold px-2 py-0.5 rounded-md border border-slate-500/25 bg-slate-500/10 text-slate-400 flex-shrink-0">
                          fora da divisão
                        </span>
                      )}
                    </div>
                  ))}
                </div>

                {/* Participantes da divisão da PT */}
                {g.splitParticipants.length > 0 && (
                  <div className="px-3 pb-2.5 pt-0.5 flex items-start gap-1.5 text-[10px] text-slate-400">
                    <Users size={11} className="text-emerald-400/70 flex-shrink-0 mt-px" />
                    <span className="leading-snug">
                      <span className="font-bold text-emerald-300/90">Divisão ({g.splitParticipants.length}):</span>{" "}
                      {g.splitParticipants.join(", ")}
                    </span>
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {/* Rodapé */}
        <div className="flex items-center gap-2 px-4 py-3 border-t border-amber-500/15 bg-black/30 flex-shrink-0">
          <button
            type="button"
            onClick={copySummary}
            disabled={totalItems === 0}
            className="flex-1 py-2 rounded-lg border border-emerald-500/40 bg-emerald-500/12 text-emerald-300 text-[11px] font-bold hover:bg-emerald-500/22 hover:border-emerald-500/60 transition-colors cursor-pointer inline-flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {copied === "resumo" ? <Check size={12} /> : <Copy size={12} />}
            {copied === "resumo" ? "Copiado!" : "Copiar Resumo (WA)"}
          </button>
          <button
            type="button"
            onClick={copyFull}
            disabled={totalItems === 0}
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
    </div>,
    document.body,
  );
}
