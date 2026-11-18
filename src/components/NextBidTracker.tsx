import { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Gavel, X } from "lucide-react";
// ─────────────────────────────────────────────────────────────────────────────
// PRÓXIMO BID (105ª tarefa) — badge no rodapé (ao lado do contador de
// usuários) + modal de acompanhamento dos "Meus Interesses" do Painel Bazaar.
//
// FONTE DE DADOS (zero consultas novas ao Firebase, nenhuma lista paralela):
//   • lista oficial  → espelho local `rubinot_bazaar_official_cache`
//     (readOfficialBazaarCache — o MESMO cache que alimenta o Painel Bazaar);
//   • interesses     → espelho local `rubinot_bazaar_interests_cache`
//     (readBazaarInterestsCache, validado contra a `version` da lista — a
//     MESMA regra do painel; um interesse é "meu" quando o uid do usuário
//     atual está em `interests[auctionKey]`, exatamente como no filtro
//     "Filtrar somente meus interesses");
//   • Valor dos Itens → MESMO núcleo da coluna "Valor Itens (kk)"/modal "Ver"
//     (utils/bazaarItemsDetailView): consulta LOCAL da guia Itens > campos
//     embutidos na lista; personalização LOCAL do modal "Ver" > automático;
//     cotação personalizada > cotação oficial do servidor (bazaarCoinRates);
//     conversão kk→RC pela fonte única formatItemRcText.
// REATIVIDADE: eventos locais do service (gravação dos espelhos), evento das
// cotações, evento da última consulta de Itens e "storage" (outras janelas)
// + relógio de 30s para o encerramento "vencer" sozinho — o badge nunca
// exibe horário de leilão já encerrado.
// INTERAÇÕES DO NOME — idênticas às do Painel Bazaar (fontes únicas
// buildBazaarCharacterDescription / appendDescriptionSelection):
//   • clique ESQUERDO  → copia SÓ o nome;
//   • clique DIREITO   → copia a mini descrição + link (formato existente);
//   • Ctrl/Cmd+DIREITO → ACUMULA vários personagens na ordem dos cliques (o
//     acumulado completo já vai ao clipboard a cada adição; barra com
//     contagem, "Copiar" e "Limpar" — mesma finalização do painel);
//   • menu de contexto do navegador suprimido SÓ no nome.
// ─────────────────────────────────────────────────────────────────────────────
import {
  BAZAAR_INTERESTS_CACHE_UPDATED_EVENT,
  BAZAAR_OFFICIAL_CACHE_UPDATED_EVENT,
  readBazaarInterestsCache,
  readOfficialBazaarCache,
  type OfficialBazaarCache,
  type OfficialBazaarCharacter,
} from "../services/bazaarOfficialService";
import { AuctionEndBadge, isAuctionEndingSoon, isAuctionStillActive } from "./AuctionEndBadge";
import { normalizeAuctionEndTimestamp, readBazarPanelTimezoneOffsetMinutes } from "../utils/bazaarTime";
import {
  appendDescriptionSelection,
  buildBazaarCharacterDescription,
  formatAuctionEndShort,
  getVocationAbbreviation,
  getVocationBadgeClass,
  joinDescriptionSelection,
  type BazaarDescriptionSelectionEntry,
} from "../utils/bazaarCharacterDescription";
import { copyTextToClipboard } from "../utils/clipboard";
import { openExternalUrl } from "../utils/openExternal";
import { SERVER_COIN_RATES_EVENT, getServerCoinRate, readLocalCoinRates } from "../utils/bazaarCoinRates";
import { formatItemRcText, formatKkValue } from "../utils/itemSale";
import {
  BAZAAR_ITEMS_LAST_QUERY_UPDATED_EVENT,
  loadItemsLastQuery,
  type BazaarItemsCharacterResult,
} from "../utils/bazaarWatchedItems";
import {
  itemsViewFromAuction,
  itemsViewFromLocalResult,
  questsViewAdjustedTotalKk,
  questsViewOverridesKey,
  readQuestsViewOverrides,
} from "../utils/bazaarItemsDetailView";

/** Chaves locais observadas via evento "storage" (gravação em OUTRA janela). */
const WATCHED_STORAGE_KEYS = [
  "rubinot_bazaar_official_cache",
  "rubinot_bazaar_interests_cache",
  "rubinot_bazaar_items_last_query",
  "rubinot_bazaar_filters",
];

/** Linha derivada de UM interesse ativo do usuário (nada é armazenado). */
interface NextBidEntry {
  /** Chave do leilão — a MESMA getAuctionKey do painel (id > url > nome). */
  key: string;
  character: OfficialBazaarCharacter;
  /** Encerramento normalizado (unix s) — null quando a lista não o trouxe. */
  endTs: number | null;
  /** Total efetivo (kk) com a personalização local aplicada; null = sem itens. */
  displayKk: number | null;
  /** true quando o total veio recalculado por personalização do modal "Ver". */
  adjusted: boolean;
  /** true quando o total efetivo é a correção manual da guia Itens (Boss). */
  isManual: boolean;
  /** Cotação usada na conversão p/ RC (personalizada > servidor); 0 = sem. */
  coinRate: number;
  rateIsOverride: boolean;
}

export default function NextBidTracker({ currentUserUid }: { currentUserUid: string }) {
  const [isOpen, setIsOpen] = useState(false);
  // Relógio de 30s: suficiente para o minuto do badge e para a janela de
  // 5 min do AuctionEndBadge; leilões encerrados saem sozinhos da lista.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 30 * 1000);
    return () => window.clearInterval(timer);
  }, []);
  // Espelho da lista oficial em estado (é o parse mais pesado — só relê
  // quando os eventos avisam que o cache mudou, nunca a cada tick).
  const [officialCache, setOfficialCache] = useState<OfficialBazaarCache | null>(() => readOfficialBazaarCache());
  // Interesses/última consulta de Itens/cotações/overrides são leituras
  // leves: um contador único invalida o useMemo quando qualquer uma muda.
  const [sourcesBump, setSourcesBump] = useState(0);
  useEffect(() => {
    const refreshOfficial = () => { setOfficialCache(readOfficialBazaarCache()); setSourcesBump(v => v + 1); };
    const bump = () => setSourcesBump(v => v + 1);
    const onStorage = (event: StorageEvent) => {
      if (event.key && !WATCHED_STORAGE_KEYS.includes(event.key) && !event.key.startsWith(questsViewOverridesKey(""))) return;
      if (!event.key || event.key === "rubinot_bazaar_official_cache") setOfficialCache(readOfficialBazaarCache());
      setSourcesBump(v => v + 1);
    };
    window.addEventListener(BAZAAR_OFFICIAL_CACHE_UPDATED_EVENT, refreshOfficial);
    window.addEventListener(BAZAAR_INTERESTS_CACHE_UPDATED_EVENT, bump);
    window.addEventListener(SERVER_COIN_RATES_EVENT, bump);
    window.addEventListener(BAZAAR_ITEMS_LAST_QUERY_UPDATED_EVENT, bump);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(BAZAAR_OFFICIAL_CACHE_UPDATED_EVENT, refreshOfficial);
      window.removeEventListener(BAZAAR_INTERESTS_CACHE_UPDATED_EVENT, bump);
      window.removeEventListener(SERVER_COIN_RATES_EVENT, bump);
      window.removeEventListener(BAZAAR_ITEMS_LAST_QUERY_UPDATED_EVENT, bump);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  // ── DERIVAÇÃO (fonte "Meus Interesses" — nenhuma lista paralela) ─────────
  const { entries, timezoneOffsetMinutes } = useMemo(() => {
    const timezoneOffsetMinutes = readBazarPanelTimezoneOffsetMinutes();
    if (!currentUserUid || !officialCache) return { entries: [] as NextBidEntry[], timezoneOffsetMinutes };
    // Interesses válidos SÓ para a versão atual da lista (mesma regra do
    // painel: versão divergente = consulta antiga, interesses descartados).
    const interests = readBazaarInterestsCache(officialCache.version)?.interests || {};
    const nowUnixTs = Math.floor(nowMs / 1000);
    // Fonte LOCAL da guia Itens (dispositivo do Boss) — prioridade sobre os
    // campos embutidos, exatamente como na coluna "Valor Itens (kk)".
    const localResultByKey = new Map<string, BazaarItemsCharacterResult>();
    for (const result of loadItemsLastQuery()?.results || []) {
      const key = String(result.id || result.url || result.name || "");
      if (key) localResultByKey.set(key, result);
    }
    const overrides = readQuestsViewOverrides(currentUserUid);
    const coinRates = readLocalCoinRates();
    const list: NextBidEntry[] = [];
    for (const character of officialCache.characters || []) {
      const key = String(character.id || character.url || character.name || "");
      if (!key) continue;
      const interestUsers = interests[key] || [];
      if (!interestUsers.some(user => user.uid === currentUserUid)) continue;
      // Só interesses ATIVOS: leilão já encerrado não entra (nem no badge).
      if (!isAuctionStillActive({ auctionEndTs: character.auctionEndTs ?? null }, nowUnixTs)) continue;
      const localResult = localResultByKey.get(key);
      const itemsView = localResult ? itemsViewFromLocalResult(localResult) : itemsViewFromAuction(character);
      const viewOverride = overrides[key];
      const adjustedTotal = itemsView ? questsViewAdjustedTotalKk(itemsView, viewOverride) : null;
      const rateIsOverride = typeof viewOverride?.coinRateKk === "number" && viewOverride.coinRateKk > 0;
      const coinRate = rateIsOverride ? Number(viewOverride?.coinRateKk) : getServerCoinRate(coinRates, String(character.server || ""));
      list.push({
        key,
        character,
        endTs: normalizeAuctionEndTimestamp(character.auctionEndTs ?? null),
        displayKk: adjustedTotal ? adjustedTotal.kk : null,
        adjusted: adjustedTotal ? adjustedTotal.adjusted : false,
        isManual: itemsView ? itemsView.isManual : false,
        coinRate,
        rateIsOverride,
      });
    }
    // Ordem CRONOLÓGICA de encerramento (crescente); sem encerramento
    // conhecido vai para o fim; empate decidido pelo nome (estável).
    list.sort((a, b) => {
      const endA = a.endTs ?? Number.POSITIVE_INFINITY;
      const endB = b.endTs ?? Number.POSITIVE_INFINITY;
      if (endA !== endB) return endA - endB;
      return String(a.character.name || "").localeCompare(String(b.character.name || ""));
    });
    return { entries: list, timezoneOffsetMinutes };
  }, [currentUserUid, officialCache, nowMs, sourcesBump]);

  const nowUnixTs = Math.floor(nowMs / 1000);
  // Próximo encerramento = primeiro com horário conhecido (lista já ordenada).
  const nextEntry = entries.find(entry => entry.endTs !== null) || null;
  const nextLabel = nextEntry ? formatAuctionEndShort(nextEntry.endTs, timezoneOffsetMinutes) : "";
  const nextEndingSoon = nextEntry ? isAuctionEndingSoon({ auctionEndTs: nextEntry.endTs }, nowUnixTs) : false;

  // ── FEEDBACK de cópia no lugar do nome (mesmo padrão do painel) ──────────
  const [nameFeedback, setNameFeedback] = useState<{ key: string; ok: boolean; message: string } | null>(null);
  const nameFeedbackTimerRef = useRef<number | null>(null);
  useEffect(() => () => { if (nameFeedbackTimerRef.current !== null) window.clearTimeout(nameFeedbackTimerRef.current); }, []);
  function flashNameFeedback(key: string, ok: boolean, message: string) {
    setNameFeedback({ key, ok, message });
    if (nameFeedbackTimerRef.current !== null) window.clearTimeout(nameFeedbackTimerRef.current);
    nameFeedbackTimerRef.current = window.setTimeout(() => { setNameFeedback(null); nameFeedbackTimerRef.current = null; }, ok ? 1500 : 2500);
  }
  // ── SELEÇÃO MÚLTIPLA (Ctrl + botão direito) — mesma finalização do painel ─
  const [descSelection, setDescSelection] = useState<BazaarDescriptionSelectionEntry[]>([]);
  const descSelectedKeys = useMemo(() => new Set(descSelection.map(entry => entry.rowKey)), [descSelection]);
  const [descBarCopied, setDescBarCopied] = useState(false);
  const descBarTimerRef = useRef<number | null>(null);
  useEffect(() => () => { if (descBarTimerRef.current !== null) window.clearTimeout(descBarTimerRef.current); }, []);
  async function copyDescSelectionAll() {
    if (descSelection.length === 0) return;
    const copied = await copyTextToClipboard(joinDescriptionSelection(descSelection));
    setDescBarCopied(copied);
    if (descBarTimerRef.current !== null) window.clearTimeout(descBarTimerRef.current);
    descBarTimerRef.current = window.setTimeout(() => { setDescBarCopied(false); descBarTimerRef.current = null; }, 1500);
  }

  /** Clique ESQUERDO no nome: copia SÓ o nome (feedback no próprio lugar). */
  async function copyCharacterName(entry: NextBidEntry) {
    const name = String(entry.character.name || "").trim();
    if (!name) return;
    const copied = await copyTextToClipboard(name);
    flashNameFeedback(entry.key, copied, copied ? "Nome copiado!" : "Falha ao copiar.");
  }
  /** Clique DIREITO (puro = individual; Ctrl/Cmd = acumula) — formato do painel. */
  async function copyCharacterDescription(entry: NextBidEntry, accumulate: boolean) {
    const { character } = entry;
    const built = buildBazaarCharacterDescription(
      { name: character.name, vocation: character.vocation, level: character.level, server: character.server, auctionEndTs: character.auctionEndTs, url: character.url, id: character.id },
      timezoneOffsetMinutes,
    );
    let ok = false;
    let message = "";
    if (!built.ok) {
      message = built.error;
    } else if (accumulate) {
      const { selection, added } = appendDescriptionSelection(
        descSelection,
        { auctionId: built.auctionId, rowKey: entry.key, text: built.text },
      );
      setDescSelection(selection);
      const copied = await copyTextToClipboard(joinDescriptionSelection(selection));
      ok = copied;
      message = !copied ? "Falha ao copiar." : added ? `Seleção copiada (${selection.length})!` : `Já na seleção (${selection.length}).`;
    } else {
      const copied = await copyTextToClipboard(built.text);
      ok = copied;
      message = copied ? "Descrição copiada!" : "Falha ao copiar.";
    }
    flashNameFeedback(entry.key, ok, message);
  }

  const badgeTitle = !currentUserUid
    ? "Próximo Bid — acompanhe aqui os encerramentos dos seus interesses do Painel Bazaar (indisponível no modo atual)."
    : nextEntry
      ? `Próximo encerramento entre os seus interesses: ${nextEntry.character.name || "—"} — ${nextLabel}. Clique para ver todos (${entries.length}).`
      : "Você não tem interesses ativos no Bazaar. Marque \"Tenho Interesse\" nos personagens do Painel Bazaar para acompanhá-los aqui.";

  return (
    <>
      {/* ── BADGE (botão) — texto EXATO "Próximo Bid: hh:mm dd/mm" ─────────── */}
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        title={badgeTitle}
        className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[9px] font-black transition-colors cursor-pointer ${
          nextEndingSoon
            ? "border-amber-500/60 bg-amber-500/15 text-amber-300 animate-pulse"
            : nextEntry
              ? "border-amber-500/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20"
              : "border-[var(--th-line)]/60 bg-black/20 text-slate-500 hover:text-slate-300"
        }`}
      >
        <Gavel size={11} className={nextEntry ? "text-amber-400" : "text-slate-500"} />
        <span className="font-mono tabular-nums">{nextEntry ? `Próximo Bid: ${nextLabel}` : "Próximo Bid: —"}</span>
        {entries.length > 0 && (
          <span className="rounded-full bg-amber-500 px-1.5 font-mono text-[8px] font-black leading-[13px] text-black" title={`${entries.length} interesse(s) ativo(s)`}>
            {entries.length}
          </span>
        )}
      </button>

      {/* ── MODAL — interesses ativos em ordem cronológica de encerramento ── */}
      {isOpen && (
        <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={() => setIsOpen(false)}>
          <div
            className="app-modal-frame app-modal-size-lg w-full max-h-[85vh] flex flex-col rounded-xl border border-amber-500/30 bg-[var(--th-bg-raised)] shadow-2xl shadow-black/60 overflow-hidden"
            onClick={event => event.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-[var(--th-line)]/60 bg-[var(--th-bg-overlay)] flex-shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <Gavel size={14} className="text-amber-400 flex-shrink-0" />
                <span className="text-xs font-black text-amber-200 truncate">Próximo Bid — Meus Interesses</span>
                {entries.length > 0 && (
                  <span className="rounded-full border border-amber-500/35 bg-amber-500/10 px-1.5 font-mono text-[9px] font-black leading-[15px] text-amber-300">
                    {entries.length}
                  </span>
                )}
              </div>
              <button type="button" onClick={() => setIsOpen(false)} className="text-slate-500 hover:text-white transition-colors cursor-pointer" title="Fechar">
                <X size={14} />
              </button>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto">
              {entries.length === 0 ? (
                <div className="flex flex-col items-center gap-1.5 px-4 py-8 text-center">
                  <span className="text-[11px] font-bold text-slate-300">Nenhum interesse ativo no momento.</span>
                  <span className="text-[9px] text-slate-500">
                    Marque {"\u201C"}Tenho Interesse{"\u201D"} nos personagens do Painel Bazaar — os leilões ainda ativos aparecem aqui em ordem de encerramento.
                  </span>
                </div>
              ) : (
                <table className="w-full text-[10px]">
                  <thead className="sticky top-0 z-10 bg-[var(--th-bg-overlay)]">
                    <tr className="text-[8px] font-black uppercase tracking-wider text-slate-400">
                      <th className="px-2 py-1.5 text-center w-7">#</th>
                      <th className="px-2 py-1.5 text-left">Personagem</th>
                      <th className="px-2 py-1.5 text-center">Servidor</th>
                      <th className="px-2 py-1.5 text-center">Valor Itens</th>
                      <th className="px-2 py-1.5 text-center">Encerra</th>
                      <th className="px-2 py-1.5 text-center">Anúncio</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((entry, index) => {
                      const { character } = entry;
                      const selectionIndex = descSelection.findIndex(sel => sel.rowKey === entry.key);
                      const isSelected = descSelectedKeys.has(entry.key);
                      const feedbackHere = nameFeedback?.key === entry.key ? nameFeedback : null;
                      return (
                        <tr key={entry.key} className="border-t border-[var(--th-line)]/40 hover:bg-white/[0.03] transition-colors">
                          <td className="px-2 py-1.5 text-center align-middle font-mono text-[9px] font-black tabular-nums text-slate-500">{index + 1}</td>
                          <td className="px-2 py-1.5 align-middle">
                            <div className="flex items-center gap-1.5 min-w-0">
                              {/* Nome em destaque — interações IDÊNTICAS às do painel
                                  (esquerdo = nome; direito = resumo; Ctrl+direito =
                                  acumula); contextmenu padrão suprimido SÓ aqui. */}
                              <span
                                className={`truncate text-[11px] font-black cursor-pointer ${feedbackHere ? (feedbackHere.ok ? "text-emerald-300" : "text-rose-300") : isSelected ? "text-sky-300" : "text-white hover:text-amber-200"}`}
                                title={feedbackHere
                                  ? feedbackHere.message
                                  : isSelected
                                    ? `${character.name || ""} — na seleção (#${selectionIndex + 1}). Clique: copia só o nome. Clique direito copia só este resumo; Ctrl + clique direito acumula vários.`
                                    : `${character.name || ""} — clique: copia só o nome; clique direito: copia a mini descrição + link do anúncio; Ctrl + clique direito: acumula vários personagens num texto só`}
                                onClick={() => { void copyCharacterName(entry); }}
                                onContextMenu={event => { event.preventDefault(); void copyCharacterDescription(entry, event.ctrlKey || event.metaKey); }}
                              >
                                {feedbackHere ? feedbackHere.message : (character.name || "—")}
                              </span>
                              <span className={`inline-flex items-center justify-center min-w-7 px-1.5 py-0.5 rounded-md border text-[10px] font-black flex-shrink-0 ${getVocationBadgeClass(character.vocation || "")}`} title={`${character.vocation || "Vocação desconhecida"}${character.level ? ` — level ${character.level}` : ""}`}>
                                {getVocationAbbreviation(character.vocation || "")}
                              </span>
                              {Number(character.level || 0) > 0 && (
                                <span className="font-mono text-[9px] font-bold tabular-nums text-slate-400 flex-shrink-0" title={`Level ${character.level}`}>
                                  {character.level}
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-2 py-1.5 text-center align-middle">
                            <span className="text-[10px] font-bold text-slate-300">{character.server || "—"}</span>
                          </td>
                          <td className="px-2 py-1.5 text-center align-middle">
                            {entry.displayKk === null ? (
                              <span className="font-mono text-[10px] font-bold text-slate-600" title="Personagem sem itens monitorados e sem Ouro relevante (acima de 1kk) na última consulta da guia Itens (ou consulta de itens ainda não realizada).">—</span>
                            ) : (
                              <div className="flex flex-col items-center gap-0.5">
                                <span
                                  className="font-mono text-[10px] font-black text-amber-200"
                                  title={entry.adjusted
                                    ? "Total recalculado com os seus valores locais do modal \"Ver\" (Painel Bazaar) — a personalização local prevalece sobre o automático"
                                    : entry.isManual
                                      ? "Valor corrigido manualmente na guia Itens"
                                      : "Valor total dos itens monitorados — mesma regra de cálculo/Tier da guia Itens (última consulta)"}
                                >
                                  {formatKkValue(entry.displayKk, "kk", true)}
                                  {(entry.adjusted || entry.isManual) && (
                                    <span className="ml-0.5 align-middle rounded border border-fuchsia-500/40 bg-fuchsia-500/15 px-1 py-px text-[7px] font-black uppercase tracking-wide text-fuchsia-300">
                                      {entry.adjusted ? "local" : "manual"}
                                    </span>
                                  )}
                                </span>
                                {entry.coinRate > 0 && (
                                  <span
                                    className="font-mono text-[9px] font-bold text-emerald-300"
                                    title={`Equivalente em RC pela cotação ${entry.rateIsOverride ? "personalizada no modal \"Ver\"" : `de ${character.server || "—"}`} (${String(entry.coinRate).replace(".", ",")}k por 1000 RC) — mesma conversão do restante do aplicativo: floor(kk ÷ cotação × 1000)`}
                                  >
                                    {formatItemRcText(entry.coinRate, entry.displayKk)}
                                  </span>
                                )}
                              </div>
                            )}
                          </td>
                          <td className="px-2 py-1.5 text-center align-middle font-mono text-[10px] tabular-nums">
                            <AuctionEndBadge auctionEndTs={character.auctionEndTs ?? null} nowUnixTs={nowUnixTs} timezoneOffsetMinutes={timezoneOffsetMinutes} />
                          </td>
                          <td className="px-2 py-1.5 text-center align-middle">
                            <button
                              type="button"
                              onClick={() => openExternalUrl(String(character.url || ""))}
                              disabled={!character.url}
                              title={character.url ? "Abrir o anúncio deste personagem no Bazaar" : "Link do anúncio indisponível"}
                              className="inline-flex h-6 items-center justify-center gap-1 rounded-md border border-cyan-500/25 bg-cyan-500/10 px-1.5 text-[9px] font-black text-cyan-300 hover:bg-cyan-500/20 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              <ExternalLink size={10} /> Abrir
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {/* Barra da seleção acumulada (Ctrl + clique direito) — mesma
                finalização do painel: contagem + Copiar (refinaliza) + Limpar. */}
            {descSelection.length > 0 && (
              <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-t border-sky-500/25 bg-sky-500/[0.06] flex-shrink-0">
                <span className="text-[9px] font-bold text-sky-300">
                  {descSelection.length} personagem(ns) na seleção — o acumulado já está na área de transferência.
                </span>
                <div className="flex items-center gap-1.5">
                  <button type="button" onClick={() => { void copyDescSelectionAll(); }} className="inline-flex h-6 items-center justify-center rounded-md border border-sky-500/30 bg-sky-500/10 px-2 text-[9px] font-black text-sky-300 hover:bg-sky-500/20 transition-colors cursor-pointer">
                    {descBarCopied ? "Copiado!" : "Copiar"}
                  </button>
                  <button type="button" onClick={() => setDescSelection([])} className="inline-flex h-6 items-center justify-center rounded-md border border-[var(--th-line)]/60 bg-black/20 px-2 text-[9px] font-black text-slate-400 hover:text-slate-200 transition-colors cursor-pointer">
                    Limpar
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
