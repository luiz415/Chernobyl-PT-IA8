import { useMemo, useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { X, Coins, Copy, Check, PackageOpen, Users } from "lucide-react";
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
// ============================================================================

/** Um item dropado e ainda não vendido, com contexto do slot. */
export interface UnsoldSaleItem {
  slotId: string;
  itemName: string;
  /** Nome do personagem que dropou (snapshot -> fonte viva -> lista -> externo). */
  characterName: string;
  /** DONO do slot (coluna DONO). */
  ownerName: string;
  /** JOGADOR do slot, quando difere do dono. Vazio = mesmo que o dono. */
  playerName: string;
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
      const ownerName = String(slot?.owner || "").trim();
      const playerRaw = String(slot?.player || "").trim();
      const playerName =
        playerRaw && playerRaw.toLowerCase() !== ownerName.toLowerCase() ? playerRaw : "";

      items.push({
        slotId: id,
        itemName,
        characterName: characterName || ownerName || "?",
        ownerName,
        playerName,
        inSplit: !!slot?.split,
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
        const donoInfo = it.ownerName ? ` (Dono: ${it.ownerName}${it.playerName ? ` / Jogador: ${it.playerName}` : ""})` : "";
        linhas.push(`• 🗡️ ${it.itemName} — ${it.characterName}${donoInfo}${it.inSplit ? "" : " — fora da divisão"}`);
      });
    });
    linhas.push("");
    linhas.push(`📅 Documento gerado em: ${fmtDateHH(Date.now())}`);

    copyText(linhas.join("\n"));
    flagCopied("completo");
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[500] flex items-center justify-center bg-black/75 backdrop-blur-sm p-4"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-lg rounded-2xl border border-amber-500/30 bg-[var(--th-bg-base,#0b0b10)] shadow-2xl shadow-black/60 flex flex-col max-h-[82vh]">
        {/* Cabeçalho */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/5 flex-shrink-0">
          <div className="flex items-center gap-2">
            <span className="w-7 h-7 rounded-lg bg-amber-500/15 border border-amber-500/30 flex items-center justify-center">
              <Coins size={14} className="text-amber-300" />
            </span>
            <div>
              <h3 className="text-sm font-black text-amber-200 leading-tight">Itens a Venda</h3>
              <p className="text-[10px] text-slate-500 leading-tight">
                PTs em Aguardando Pagamento com itens ainda não vendidos
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

        {/* Corpo */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2.5">
          {groups.length === 0 ? (
            // Estado vazio elegante — o modal nunca fica em branco.
            <div className="flex flex-col items-center justify-center text-center py-10 gap-3">
              <span className="w-12 h-12 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center">
                <PackageOpen size={22} className="text-slate-500" />
              </span>
              <p className="text-sm font-semibold text-slate-300">
                Você não tem acesso a nenhum item à venda no momento.
              </p>
              <p className="text-[11px] text-slate-500 max-w-[300px]">
                Itens aparecem aqui quando uma PT sua entra em Aguardando Pagamento com itens dropados ainda não vendidos.
              </p>
            </div>
          ) : (
            groups.map(g => (
              <div
                key={g.partyId}
                className="rounded-xl border border-amber-500/20 bg-amber-500/[0.04] px-3 py-2.5"
              >
                {/* Contexto da PT */}
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-xs font-black text-amber-200 truncate max-w-[200px]">{g.partyName}</span>
                  {g.questSigla && (
                    <span className={`text-[8px] font-bold px-1 py-px rounded border flex-shrink-0 ${
                      g.questSigla === "SG"
                        ? "border-rose-500/30 bg-rose-500/10 text-rose-400"
                        : "border-slate-500/30 bg-slate-500/10 text-slate-400"
                    }`}>
                      {g.questSigla}
                    </span>
                  )}
                  {g.serverName && (
                    <span className="text-[9px] font-bold px-1.5 py-px rounded border border-sky-500/25 bg-sky-500/10 text-sky-300 flex-shrink-0">
                      {g.serverName}
                    </span>
                  )}
                </div>

                {/* Itens ainda não vendidos */}
                <div className="mt-1.5 space-y-1">
                  {g.items.map(it => (
                    <div key={it.slotId} className="flex items-baseline gap-1.5 text-[11px] leading-snug">
                      <span className="text-amber-400/70 flex-shrink-0">•</span>
                      <span className="font-bold text-slate-200">{it.itemName}</span>
                      <span className="text-slate-500 truncate">
                        — {it.characterName}
                        {it.ownerName && ` (${it.ownerName}${it.playerName ? ` / ${it.playerName}` : ""})`}
                        {!it.inSplit && <span className="text-slate-600"> · fora da divisão</span>}
                      </span>
                    </div>
                  ))}
                </div>

                {/* Participantes da divisão */}
                {g.splitParticipants.length > 0 && (
                  <div className="mt-1.5 pt-1.5 border-t border-white/5 flex items-start gap-1.5 text-[10px] text-slate-400">
                    <Users size={11} className="text-amber-400/60 flex-shrink-0 mt-px" />
                    <span className="leading-snug">
                      <span className="font-bold text-slate-300">Divisão ({g.splitParticipants.length}):</span>{" "}
                      {g.splitParticipants.join(", ")}
                    </span>
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {/* Rodapé */}
        <div className="flex items-center gap-2 px-4 py-3 border-t border-white/5 flex-shrink-0">
          <button
            type="button"
            onClick={copySummary}
            disabled={totalItems === 0}
            className="flex-1 py-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 text-[11px] font-bold hover:bg-emerald-500/20 transition-colors cursor-pointer inline-flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {copied === "resumo" ? <Check size={12} /> : <Copy size={12} />}
            {copied === "resumo" ? "Copiado!" : "Copiar Resumo (WA)"}
          </button>
          <button
            type="button"
            onClick={copyFull}
            disabled={totalItems === 0}
            className="flex-1 py-1.5 rounded-lg border border-sky-500/30 bg-sky-500/10 text-sky-300 text-[11px] font-bold hover:bg-sky-500/20 transition-colors cursor-pointer inline-flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {copied === "completo" ? <Check size={12} /> : <Copy size={12} />}
            {copied === "completo" ? "Copiado!" : "Copiar Completo (WA)"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg border border-white/10 bg-white/5 text-slate-300 text-[11px] font-bold hover:bg-white/10 transition-colors cursor-pointer"
          >
            Fechar
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
