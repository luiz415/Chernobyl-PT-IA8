import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { X, Package, Globe, Search, User, Coins, Check, Trash2, Swords } from "lucide-react";
import type { Character, ItemSaleRecord } from "../types";
import { formatRC } from "../types";
import { serverLabel } from "../constants/servers";
import { formatItemSaleSummary, formatKkValue as formatKkValueBase, isItemSaleConcluded } from "../utils/itemSale";
import ItemSoldModal from "./ItemSoldModal";

// ============================================================================
// MODAL "ITENS ENCONTRADOS" — Meus Personagens (59ª tarefa)
// ----------------------------------------------------------------------------
// Reúne em UM lugar os itens encontrados em TODOS os personagens do usuário
// (os MESMOS dados do botão "Ver" de cada personagem — snapshot
// `Character.bazaarItems` importado na compra), sem precisar abrir cada
// modal individualmente. EXCLUSIVO DO BOSS (o App só monta o botão/modal
// para role === "Boss", a mesma regra da coluna Itens/"Ver").
//
// FONTE DE DADOS — 100% local, nenhuma consulta nova: deriva de
// `data.characters` (a MESMA lista viva do CharTable); qualquer alteração
// reflete aqui, no modal "Ver" e em "Itens à Venda" na hora, via props.
//
// AÇÕES POR ITEM — nenhum mecanismo paralelo, nenhum registro duplicado:
//   • À VENDA — grava `forSale`/`forSaleAt` no PRÓPRIO match do snapshot
//     (MESMO patch do modal "Ver"/58ª tarefa); o item passa a aparecer em
//     "Itens à Venda" como origem "bazaar" (sem Quest — SW/SG/GB nunca);
//   • VENDIDO — abre o ItemSoldModal OFICIAL (mesma calculadora/regras:
//     cotação do servidor pré-preenchida, Taxa Market 1%/3%, "não informar
//     valor") e grava o ItemSaleRecord no match — marcando-o à venda para
//     constar na aba Vendidos de "Itens à Venda";
//   • REMOVER — exclui o match do snapshot (confirmação em 2 cliques) e
//     RECALCULA o total automático (matches restantes + ouro); a correção
//     manual (`manualTotalKk`), quando existe, é preservada. O modal "Ver"
//     exibe imediatamente a lista sem o item.
//
// PERSISTÊNCIA — exclusivamente pelo canal EXISTENTE do CharTable
// (`onCharacterInlineChange` → setData do App → persistência local + sync),
// exatamente como o modal "Ver" e o "Itens à Venda" já fazem. Personagens
// com lucro de Quest transferido por negociação (lockedQuestFinancialIds)
// ficam FORA — o mesmo canal os bloqueia (consistente com a 58ª tarefa).
// ============================================================================

/** kk com até 1 casa, sem zeros à direita — mesmo formato do modal "Ver". */
function formatKk(value: number): string {
  return formatKkValueBase(value, "kk", true);
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

/** Um item encontrado (match do snapshot), com o estado de venda derivado. */
export interface FoundItemEntry {
  /** Índice do item em `bazaarItems.matches` — identifica o match exato. */
  matchIndex: number;
  foundName: string;
  watchedName: string;
  tier: number;
  amount: number;
  unitValueKk: number;
  /** VALOR CONSIDERADO do item (kk) — o mesmo da consulta/modal "Ver". */
  totalKk: number;
  forSale: boolean;
  sold: boolean;
  soldValueRC: number;
  saleSummary: string;
  sale: ItemSaleRecord | null;
}

/** Itens encontrados de UM personagem (conjunto exibido em grupo). */
export interface FoundItemGroup {
  characterId: string;
  personagem: string;
  account: string;
  serverName: string;
  /** Personagem está na guia Vendidos (badge informativo). */
  vendido: boolean;
  /** Total considerado do personagem (correção manual > calculado). */
  effectiveTotalKk: number;
  isManualTotal: boolean;
  goldKk: number;
  items: FoundItemEntry[];
}

/**
 * Agrupa os itens encontrados por personagem — função PURA (usada pelo modal
 * e pelo contador do botão no App). Mesmos dados do modal "Ver"; personagens
 * sem snapshot (ou sem itens) ficam de fora, assim como os travados por
 * negociação (as ações usariam um canal bloqueado).
 */
export function collectFoundItemGroups(
  characters: Character[],
  lockedQuestFinancialIds: ReadonlySet<string>,
): FoundItemGroup[] {
  const groups: FoundItemGroup[] = [];
  for (const c of characters) {
    if (lockedQuestFinancialIds.has(c.id)) continue;
    const snap = c.bazaarItems;
    if (!snap || !Array.isArray(snap.matches) || snap.matches.length === 0) continue;
    const isManualTotal = typeof snap.manualTotalKk === "number" && snap.manualTotalKk > 0;
    groups.push({
      characterId: c.id,
      personagem: String(c.personagem || "").trim() || "Personagem",
      account: String(c.account || "").trim(),
      serverName: serverLabel(snap.server) || String(snap.server || c.servidor || "").trim(),
      vendido: !!c.vendido,
      effectiveTotalKk: isManualTotal ? (snap.manualTotalKk as number) : snap.totalKk,
      isManualTotal,
      goldKk: snap.goldKk || 0,
      items: snap.matches.map((m, matchIndex) => {
        const sale = m.sale || null;
        const concluded = isItemSaleConcluded(sale);
        return {
          matchIndex,
          foundName: m.foundName,
          watchedName: m.watchedName,
          tier: m.tier,
          amount: m.amount,
          unitValueKk: m.unitValueKk,
          totalKk: m.totalKk,
          forSale: !!m.forSale,
          sold: concluded,
          soldValueRC: Math.max(0, Number(sale?.resultRC || 0)),
          saleSummary: concluded && sale ? formatItemSaleSummary(sale) : "",
          sale,
        };
      }),
    });
  }
  return groups.sort((a, b) => a.personagem.localeCompare(b.personagem, "pt-BR"));
}

interface Props {
  /** TODOS os personagens do usuário (Disponíveis + Vendidos) — data.characters. */
  characters: Character[];
  /** Personagens com lucro de Quest transferido (mesmo conjunto do CharTable). */
  lockedQuestFinancialIds: ReadonlySet<string>;
  /** MESMO canal do CharTable: setData do App → persistência existente. */
  onCharacterInlineChange: (character: Character) => void;
  onClose: () => void;
}

export default function FoundItemsModal({
  characters,
  lockedQuestFinancialIds,
  onCharacterInlineChange,
  onClose,
}: Props) {
  // Recalculado a cada mudança na lista viva do App — tempo real.
  const groups = useMemo(
    () => collectFoundItemGroups(characters, lockedQuestFinancialIds),
    [characters, lockedQuestFinancialIds],
  );
  const totalItems = useMemo(() => groups.reduce((sum, g) => sum + g.items.length, 0), [groups]);

  // ── Filtros locais (busca + servidor) ─────────────────────────────────────
  const [search, setSearch] = useState("");
  const [serverFilter, setServerFilter] = useState("");
  const serverOptions = useMemo(
    () => [...new Set(groups.map(g => g.serverName).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR")),
    [groups],
  );
  const filteredGroups = useMemo(() => {
    const text = normalizeSearchText(search);
    return groups
      .filter(g => !serverFilter || g.serverName === serverFilter)
      .map(g => {
        if (!text) return g;
        // Busca casa personagem/conta (grupo inteiro) OU itens individuais.
        if (normalizeSearchText(g.personagem).includes(text) || normalizeSearchText(g.account).includes(text)) return g;
        return { ...g, items: g.items.filter(i => normalizeSearchText(i.foundName).includes(text) || normalizeSearchText(i.watchedName).includes(text)) };
      })
      .filter(g => g.items.length > 0);
  }, [groups, search, serverFilter]);

  // ── Venda via ItemSoldModal (calculadora oficial) — dados VIVOS ───────────
  const [saleTarget, setSaleTarget] = useState<{ characterId: string; matchIndex: number } | null>(null);
  const liveSaleTarget = useMemo(() => {
    if (!saleTarget) return null;
    const group = groups.find(g => g.characterId === saleTarget.characterId);
    const item = group?.items.find(i => i.matchIndex === saleTarget.matchIndex);
    return group && item ? { group, item } : null;
  }, [saleTarget, groups]);

  // ── Remoção: confirmação em 2 cliques (expira sozinha) ────────────────────
  const [confirmRemoveKey, setConfirmRemoveKey] = useState<string | null>(null);
  useEffect(() => {
    if (!confirmRemoveKey) return;
    const timer = setTimeout(() => setConfirmRemoveKey(null), 4000);
    return () => clearTimeout(timer);
  }, [confirmRemoveKey]);

  // Esc fecha (padrão do app) — não enquanto a calculadora está por cima.
  useEffect(() => {
    if (saleTarget) return;
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, saleTarget]);

  /** Aplica um patch ao snapshot do personagem pelo canal EXISTENTE. */
  function updateSnapshot(
    characterId: string,
    updater: (snap: NonNullable<Character["bazaarItems"]>) => NonNullable<Character["bazaarItems"]>,
  ) {
    const character = characters.find(c => c.id === characterId);
    const snap = character?.bazaarItems;
    if (!character || !snap) return;
    onCharacterInlineChange({ ...character, bazaarItems: updater(snap) });
  }

  /** À VENDA — MESMO patch do modal "Ver" (58ª): forSaleAt só na 1ª marcação. */
  function handleToggleForSale(characterId: string, matchIndex: number, forSale: boolean) {
    updateSnapshot(characterId, snap => ({
      ...snap,
      matches: snap.matches.map((m, i) => i === matchIndex
        ? { ...m, forSale, ...(forSale && !((m.forSaleAt || 0) > 0) ? { forSaleAt: Date.now() } : {}) }
        : m),
    }));
  }

  /** VENDIDO — grava o registro no match E o marca à venda (consta na aba
   *  Vendidos de "Itens à Venda"); campos de Quest NUNCA são tocados. */
  function handleConfirmSale(sale: ItemSaleRecord) {
    const ids = saleTarget;
    setSaleTarget(null);
    if (!ids) return;
    updateSnapshot(ids.characterId, snap => ({
      ...snap,
      matches: snap.matches.map((m, i) => i === ids.matchIndex
        ? { ...m, sale, forSale: true, ...(!((m.forSaleAt || 0) > 0) ? { forSaleAt: Date.now() } : {}) }
        : m),
    }));
  }

  /** REMOVER — exclui o match e recalcula o total automático (restantes +
   *  ouro); `manualTotalKk` é preservado. O modal "Ver" reflete na hora. */
  function handleRemove(characterId: string, matchIndex: number) {
    setConfirmRemoveKey(null);
    updateSnapshot(characterId, snap => {
      const matches = snap.matches.filter((_, i) => i !== matchIndex);
      const autoTotal = Math.round((matches.reduce((sum, m) => sum + (Number(m.totalKk) || 0), 0) + (snap.goldKk || 0)) * 100) / 100;
      return { ...snap, matches, totalKk: autoTotal };
    });
  }

  const inputCls = "w-full bg-black/40 border border-white/10 rounded-lg px-2.5 py-1.5 text-[11px] text-slate-200 outline-none transition-colors focus:border-fuchsia-500/50 placeholder-slate-600";

  return createPortal(
    <div
      className="fixed inset-0 z-[500] flex items-center justify-center bg-black/80 backdrop-blur-sm p-2 sm:p-4"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-2xl rounded-2xl border border-fuchsia-500/40 bg-gradient-to-b from-[#141017] to-[#0b0a10] shadow-[0_0_60px_rgba(217,70,239,0.08)] shadow-black/70 flex flex-col max-h-[90vh] sm:max-h-[84vh] overflow-hidden">
        {/* Cabeçalho — identidade FÚCSIA (mesma da guia Itens/modal "Ver") */}
        <div className="relative px-4 py-3.5 border-b border-fuchsia-500/20 bg-gradient-to-r from-fuchsia-500/[0.12] via-fuchsia-500/[0.05] to-transparent flex-shrink-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="w-9 h-9 rounded-xl bg-fuchsia-500/15 border border-fuchsia-500/40 flex items-center justify-center shadow-[0_0_12px_rgba(217,70,239,0.15)] flex-shrink-0">
                <Package size={17} className="text-fuchsia-300" />
              </span>
              <div className="min-w-0">
                <h3 className="text-[15px] font-black text-fuchsia-200 leading-tight tracking-tight truncate">Itens Encontrados</h3>
                <p className="text-[10px] text-slate-400 leading-snug truncate">
                  Itens importados na compra dos seus personagens — os mesmos do botão "Ver", em um só lugar
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <span className="text-[9px] font-bold text-slate-500 tabular-nums" title="Personagens com itens × total de itens encontrados">
                {groups.length} pers. · {totalItems} ite{totalItems === 1 ? "m" : "ns"}
              </span>
              <button onClick={onClose} className="text-slate-400 hover:text-white p-1.5 rounded-lg hover:bg-white/5 transition-colors cursor-pointer">
                <X size={16} />
              </button>
            </div>
          </div>
        </div>

        {/* Filtros — busca (item/personagem/conta) + servidor */}
        <div className="px-4 pt-2.5 pb-1 grid grid-cols-1 sm:grid-cols-[1fr_200px] gap-1.5 flex-shrink-0">
          <label className="relative">
            <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Buscar item, personagem ou conta..."
              aria-label="Buscar por item, personagem ou conta"
              className={`${inputCls} pl-6`}
            />
          </label>
          <select
            value={serverFilter}
            onChange={e => setServerFilter(e.target.value)}
            aria-label="Filtrar por servidor"
            className={`${inputCls} cursor-pointer [color-scheme:dark]`}
          >
            <option value="">Todos os servidores</option>
            {serverOptions.map(server => <option key={server} value={server}>{server}</option>)}
          </select>
        </div>

        {/* Lista agrupada por personagem */}
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3">
          {filteredGroups.length === 0 ? (
            <div className="py-10 text-center">
              <Package size={28} className="mx-auto text-slate-600 mb-2" />
              <p className="text-xs text-slate-500 italic">
                {totalItems === 0
                  ? "Nenhum personagem com itens do Bazaar importados na compra."
                  : "Nenhum item corresponde aos filtros atuais."}
              </p>
            </div>
          ) : (
            filteredGroups.map(group => (
              <section key={group.characterId} className="rounded-xl border border-white/10 bg-white/[0.02] overflow-hidden">
                {/* Cabeçalho do personagem: Personagem · Conta · Servidor · Total */}
                <header className="flex items-center gap-x-2.5 gap-y-1 px-3 py-1.5 bg-white/[0.04] border-b border-white/5 flex-wrap">
                  <span className="inline-flex items-center gap-1.5 min-w-0">
                    <Swords size={11} className="text-fuchsia-400 flex-shrink-0" />
                    <span className="text-[11px] font-black text-fuchsia-200 truncate" title={group.personagem}>{group.personagem}</span>
                    {group.vendido && (
                      <span className="text-[7px] font-black uppercase tracking-wide px-1 py-px rounded border border-white/15 bg-white/5 text-slate-400 flex-shrink-0" title="Personagem está na guia Vendidos">vendido</span>
                    )}
                  </span>
                  {group.account && (
                    <span className="inline-flex items-center gap-1 text-[9px] font-semibold text-slate-400 min-w-0" title={`Conta: ${group.account}`}>
                      <User size={9} className="flex-shrink-0" /> <span className="truncate">{group.account}</span>
                    </span>
                  )}
                  <span className="inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider text-sky-300" title="Servidor do snapshot — os valores vieram da Lista de Itens deste servidor">
                    <Globe size={9} className="flex-shrink-0" /> {group.serverName || "—"}
                  </span>
                  <span className="ml-auto inline-flex items-center gap-1.5 text-[9px] text-slate-400 tabular-nums flex-shrink-0">
                    {group.items.length} ite{group.items.length === 1 ? "m" : "ns"}
                    <span className="text-slate-600">·</span>
                    <span title={group.goldKk > 0 ? `Total considerado do personagem (inclui Ouro: ${formatKk(group.goldKk)})` : "Total considerado do personagem"}>
                      Total <span className="font-mono font-bold text-amber-200">{formatKk(group.effectiveTotalKk)}</span>
                    </span>
                    {group.isManualTotal && (
                      <span className="rounded border border-fuchsia-500/40 bg-fuchsia-500/15 px-1 py-px text-[7px] font-black uppercase tracking-wide text-fuchsia-300" title="Correção manual feita na consulta">manual</span>
                    )}
                  </span>
                </header>
                <ul className="divide-y divide-white/5">
                  {group.items.map(item => {
                    const itemKey = `${group.characterId}:${item.matchIndex}`;
                    return (
                      <li key={itemKey} className="px-3 py-2 flex items-center gap-2 flex-wrap">
                        <div className="flex items-center gap-1.5 min-w-0 flex-1 basis-40">
                          <Package size={11} className="text-slate-500 flex-shrink-0" />
                          <span className="text-[11px] text-slate-200 font-semibold truncate" title={`${item.foundName} — item da lista: ${item.watchedName}`}>{item.foundName}</span>
                          {item.tier > 0 && (
                            <span className="text-[8px] font-black px-1 py-px rounded border border-fuchsia-500/40 bg-fuchsia-500/15 text-fuchsia-300 flex-shrink-0" title={`Tier ${item.tier} — +${item.tier * 30}% sobre o valor base`}>T{item.tier}</span>
                          )}
                          {item.amount > 1 && (
                            <span className="text-[9px] font-bold text-slate-500 tabular-nums flex-shrink-0" title={`${item.amount} unidades × ${formatKk(item.unitValueKk)}`}>×{item.amount}</span>
                          )}
                        </div>
                        {/* VALOR CONSIDERADO — o mesmo kk da consulta/"Ver" */}
                        <span className="text-[10px] font-mono font-bold text-amber-200 tabular-nums flex-shrink-0" title={item.amount > 1 ? `Valor considerado: ${item.amount} × ${formatKk(item.unitValueKk)} = ${formatKk(item.totalKk)}` : "Valor considerado do item (da consulta de origem)"}>
                          {formatKk(item.totalKk)}
                        </span>
                        <div className="flex items-center gap-1.5 ml-auto flex-shrink-0">
                          {/* À VENDA — mesmo toggle do modal "Ver" */}
                          <button
                            type="button"
                            onClick={() => handleToggleForSale(group.characterId, item.matchIndex, !item.forSale)}
                            aria-pressed={item.forSale}
                            title={item.forSale
                              ? "Item marcado À VENDA — presente em “Itens à Venda” (sem Quest associada). Clique para retirar da venda; o registro do item é preservado."
                              : "Colocar o item à venda — passa a aparecer em “Itens à Venda” (sem associação com SW/SG/GB)."}
                            className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border text-[9px] font-bold transition-colors cursor-pointer ${
                              item.forSale
                                ? "border-amber-500/50 bg-amber-500/20 text-amber-300 hover:bg-amber-500/30"
                                : "border-white/10 bg-white/5 text-slate-400 hover:border-amber-500/35 hover:bg-amber-500/10 hover:text-amber-300"
                            }`}
                          >
                            <Coins size={9} /> À venda
                          </button>
                          {/* VENDIDO — calculadora oficial (registro no match) */}
                          {item.sold ? (
                            <button
                              type="button"
                              onClick={() => setSaleTarget({ characterId: group.characterId, matchIndex: item.matchIndex })}
                              title={item.saleSummary ? `Venda registrada (${item.saleSummary}) — clique para revisar` : "Venda registrada — clique para revisar"}
                              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border border-emerald-500/50 bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 text-[9px] font-bold transition-colors cursor-pointer"
                            >
                              <Check size={9} /> {item.soldValueRC > 0 ? formatRC(item.soldValueRC) : "Vendido"}
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setSaleTarget({ characterId: group.characterId, matchIndex: item.matchIndex })}
                              title="Registrar a venda do item (valor, cotação do RC e Taxa Market) — mesmo fluxo de “Itens à Venda”"
                              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border border-emerald-600/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 text-[9px] font-bold transition-colors cursor-pointer"
                            >
                              <Check size={9} /> Vendido
                            </button>
                          )}
                          {/* REMOVER — confirmação em 2 cliques */}
                          <button
                            type="button"
                            onClick={() => (confirmRemoveKey === itemKey ? handleRemove(group.characterId, item.matchIndex) : setConfirmRemoveKey(itemKey))}
                            title={confirmRemoveKey === itemKey
                              ? "Clique novamente para CONFIRMAR a remoção do item deste personagem (o modal “Ver” e os totais refletem na hora)."
                              : "Remover o item dos itens encontrados deste personagem (pede confirmação)."}
                            className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border text-[9px] font-bold transition-colors cursor-pointer ${
                              confirmRemoveKey === itemKey
                                ? "border-red-500/60 bg-red-500/25 text-red-200"
                                : "border-white/10 bg-white/5 text-slate-400 hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-300"
                            }`}
                          >
                            <Trash2 size={9} /> {confirmRemoveKey === itemKey ? "Confirmar?" : "Remover"}
                          </button>
                        </div>
                        {item.sold && item.saleSummary && (
                          <p className="w-full text-[9px] text-slate-500 leading-snug pl-[18px]" title={item.saleSummary}>{item.saleSummary}</p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))
          )}
        </div>

        {/* Rodapé */}
        <div className="px-4 py-2.5 border-t border-white/5 bg-black/30 flex items-center justify-between gap-2 flex-shrink-0">
          <p className="text-[9px] text-slate-500 leading-snug">
            Tudo é gravado no snapshot do próprio personagem — o modal "Ver" e o "Itens à Venda" refletem na hora.
          </p>
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg bg-gradient-to-r from-fuchsia-700/80 to-fuchsia-600/80 hover:from-fuchsia-600 hover:to-fuchsia-500 border border-fuchsia-500/40 text-white text-[10px] font-black transition-all cursor-pointer flex-shrink-0"
          >
            Fechar
          </button>
        </div>
      </div>

      {/* Calculadora OFICIAL — mesma do "Itens à Venda" (origem bazaar):
          contexto "Item do Bazaar" (sem Quest), cotação do servidor do
          snapshot pré-preenchida, venda sem valor permitida. */}
      {liveSaleTarget && (
        <ItemSoldModal
          itemName={liveSaleTarget.item.foundName}
          contextLabel={`${liveSaleTarget.group.serverName || "Sem servidor"} — Item do Bazaar`}
          initial={liveSaleTarget.item.sale}
          allowNoValue
          server={liveSaleTarget.group.serverName}
          onCancel={() => setSaleTarget(null)}
          onSave={sale => handleConfirmSale(sale)}
        />
      )}
    </div>,
    document.body,
  );
}
