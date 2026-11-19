import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ExternalLink, Gavel, Package, Swords, X } from "lucide-react";
// ─────────────────────────────────────────────────────────────────────────────
// PRÓXIMO BID (105ª tarefa; categorias + visual da 107ª) — badge no rodapé
// (ao lado do contador de usuários) + modal de acompanhamento dos interesses
// do Painel Bazaar.
//
// FONTE DE DADOS (zero consultas novas ao Firebase, nenhuma lista paralela):
//   • lista oficial  → espelho local `rubinot_bazaar_official_cache`
//     (readOfficialBazaarCache — o MESMO cache que alimenta o Painel Bazaar);
//   • interesses     → espelho local `rubinot_bazaar_interests_cache`
//     (readBazaarInterestsCache, validado contra a `version` da lista — a
//     MESMA regra do painel; um interesse é "meu" quando o uid do usuário
//     atual está em `interests[auctionKey]`, exatamente como no filtro
//     "Filtrar somente meus interesses");
//   • 107ª — usuário BOSS: também os "Tenho Interesse" da guia "Personagens
//     Com Itens" (loadItemsInterestRecords — 100% LOCAL por uid, ZERO
//     Firestore), cruzados com a ÚLTIMA CONSULTA local da guia Itens
//     (loadItemsLastQuery) pela MESMA regra da guia (isItemsInterestMarked:
//     id do leilão OU nome+servidor). Os resultados ficam em DUAS categorias:
//     "Personagens Para SW/SG/GB" e "Personagens Com Itens", cada uma em
//     ordem cronológica de encerramento; personagem marcado nas DUAS guias
//     aparece SÓ em "Personagens Com Itens" (decisão do usuário — zero
//     duplicação). Sem cargo Boss, comportamento anterior intacto (só a
//     categoria de quests, sem cabeçalhos extras).
//   • Valor dos Itens → MESMO núcleo da coluna "Valor Itens (kk)"/modal "Ver"
//     (utils/bazaarItemsDetailView): consulta LOCAL da guia Itens > campos
//     embutidos na lista; personalização LOCAL do modal "Ver" > automático;
//     cotação personalizada > cotação oficial do servidor (bazaarCoinRates);
//     conversão kk→RC pela fonte única formatItemRcText.
// ENCERRAMENTO (107ª): célula "Encerra" continua sendo a FONTE ÚNICA visual
// AuctionEndBadge (mesmos critérios do Painel Bazaar: ≤ 5 min = âmbar com
// alerta; encerrado = apagado/tachado) + tempo restante ("em Xh Ym") e
// destaque do card: encerrando em ≤ 5 min ganha borda/fundo âmbar, e o
// PRÓXIMO encerramento geral ganha o selo "Próximo". Leilão encerrado SAI
// da lista sozinho (decisão do usuário — modal só exibe interesses ATIVOS,
// como na 105ª); o relógio de 30s mantém tudo em dia.
// REATIVIDADE: eventos locais do service (gravação dos espelhos), evento das
// cotações, evento da última consulta de Itens, evento dos interesses da
// guia Itens (107ª) e "storage" (outras janelas) + relógio de 30s — o badge
// nunca exibe horário de leilão já encerrado.
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
  BAZAAR_ITEMS_INTERESTS_KEY_PREFIX,
  BAZAAR_ITEMS_INTERESTS_UPDATED_EVENT,
  BAZAAR_ITEMS_LAST_QUERY_UPDATED_EVENT,
  canonicalServerKey,
  isItemsInterestMarked,
  loadItemsInterestRecords,
  loadItemsLastQuery,
  type BazaarItemsCharacterResult,
} from "../utils/bazaarWatchedItems";
import {
  itemsViewFromAuction,
  itemsViewFromLocalResult,
  questsViewAdjustedTotalKk,
  questsViewOverridesKey,
  readQuestsViewOverrides,
  type QuestsItemsDetailView,
  type QuestsViewOverride,
} from "../utils/bazaarItemsDetailView";

/** Chaves locais observadas via evento "storage" (gravação em OUTRA janela). */
const WATCHED_STORAGE_KEYS = [
  "rubinot_bazaar_official_cache",
  "rubinot_bazaar_interests_cache",
  "rubinot_bazaar_items_last_query",
  "rubinot_bazaar_filters",
];

/**
 * Personagem exibido no modal — subconjunto ESTRUTURAL comum entre a lista
 * oficial (OfficialBazaarCharacter) e a última consulta da guia Itens
 * (BazaarItemsCharacterResult): são exatamente os campos que o card e a
 * buildBazaarCharacterDescription usam. Nada é armazenado.
 */
interface NextBidCharacter {
  id: string;
  name: string;
  vocation: string;
  level: number;
  server: string;
  auctionEndTs: number | null;
  url: string;
}

/** Linha derivada de UM interesse ativo do usuário (nada é armazenado). */
interface NextBidEntry {
  /** Chave do leilão — a MESMA getAuctionKey do painel (id > url > nome). */
  key: string;
  character: NextBidCharacter;
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

/** Ordem CRONOLÓGICA de encerramento (crescente); sem encerramento conhecido
 *  vai para o fim; empate decidido pelo nome (estável). */
function compareByAuctionEnd(a: NextBidEntry, b: NextBidEntry): number {
  const endA = a.endTs ?? Number.POSITIVE_INFINITY;
  const endB = b.endTs ?? Number.POSITIVE_INFINITY;
  if (endA !== endB) return endA - endB;
  return String(a.character.name || "").localeCompare(String(b.character.name || ""));
}

/** Par nome+servidor normalizado p/ deduplicação entre categorias — mesma
 *  normalização dos interesses da guia Itens (nome caixa-insensível +
 *  canonicalServerKey, com .toLowerCase() porque o fallback preserva caixa). */
function characterPairKey(name: string | undefined, server: string | undefined): string {
  const nameKey = String(name || "").trim().toLowerCase();
  const serverKey = canonicalServerKey(String(server || "")).toLowerCase();
  return nameKey && serverKey ? `${nameKey}|${serverKey}` : "";
}

/**
 * Tempo RESTANTE legível ("em 2d 3h" / "em 1h 05m" / "em 12m") — reforço
 * visual da 107ª ao lado do badge "Encerra". Os CRITÉRIOS de proximidade
 * continuam os do Painel Bazaar (isAuctionEndingSoon/isAuctionStillActive —
 * fonte única); isto é só formatação do mesmo timestamp.
 */
function formatTimeLeft(endTs: number | null, nowUnixTs: number): string | null {
  if (!endTs) return null;
  const secondsLeft = endTs - nowUnixTs;
  if (secondsLeft <= 0) return "Encerrado";
  const days = Math.floor(secondsLeft / 86400);
  const hours = Math.floor((secondsLeft % 86400) / 3600);
  const minutes = Math.floor((secondsLeft % 3600) / 60);
  if (days > 0) return `em ${days}d ${hours}h`;
  if (hours > 0) return `em ${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `em ${minutes}m`;
  return "em menos de 1m";
}

export default function NextBidTracker({ currentUserUid, isBoss = false }: { currentUserUid: string; isBoss?: boolean }) {
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
      if (event.key
        && !WATCHED_STORAGE_KEYS.includes(event.key)
        && !event.key.startsWith(questsViewOverridesKey(""))
        && !event.key.startsWith(BAZAAR_ITEMS_INTERESTS_KEY_PREFIX)) return;
      if (!event.key || event.key === "rubinot_bazaar_official_cache") setOfficialCache(readOfficialBazaarCache());
      setSourcesBump(v => v + 1);
    };
    window.addEventListener(BAZAAR_OFFICIAL_CACHE_UPDATED_EVENT, refreshOfficial);
    window.addEventListener(BAZAAR_INTERESTS_CACHE_UPDATED_EVENT, bump);
    window.addEventListener(SERVER_COIN_RATES_EVENT, bump);
    window.addEventListener(BAZAAR_ITEMS_LAST_QUERY_UPDATED_EVENT, bump);
    window.addEventListener(BAZAAR_ITEMS_INTERESTS_UPDATED_EVENT, bump);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(BAZAAR_OFFICIAL_CACHE_UPDATED_EVENT, refreshOfficial);
      window.removeEventListener(BAZAAR_INTERESTS_CACHE_UPDATED_EVENT, bump);
      window.removeEventListener(SERVER_COIN_RATES_EVENT, bump);
      window.removeEventListener(BAZAAR_ITEMS_LAST_QUERY_UPDATED_EVENT, bump);
      window.removeEventListener(BAZAAR_ITEMS_INTERESTS_UPDATED_EVENT, bump);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  // ── DERIVAÇÃO (fontes "Meus Interesses" — nenhuma lista paralela) ────────
  const { questsEntries, itemsEntries, timezoneOffsetMinutes } = useMemo(() => {
    const timezoneOffsetMinutes = readBazarPanelTimezoneOffsetMinutes();
    const empty = { questsEntries: [] as NextBidEntry[], itemsEntries: [] as NextBidEntry[], timezoneOffsetMinutes };
    if (!currentUserUid) return empty;
    const nowUnixTs = Math.floor(nowMs / 1000);
    // Fonte LOCAL da guia Itens (dispositivo do Boss) — prioridade sobre os
    // campos embutidos, exatamente como na coluna "Valor Itens (kk)".
    const localQueryResults = loadItemsLastQuery()?.results || [];
    const localResultByKey = new Map<string, BazaarItemsCharacterResult>();
    for (const result of localQueryResults) {
      const key = String(result.id || result.url || result.name || "");
      if (key) localResultByKey.set(key, result);
    }
    const overrides = readQuestsViewOverrides(currentUserUid);
    const coinRates = readLocalCoinRates();
    // Núcleo de VALOR compartilhado pelas duas categorias — o MESMO da 105ª
    // (personalização local > automático; cotação personalizada > servidor).
    const valueFields = (key: string, server: string, itemsView: QuestsItemsDetailView | null) => {
      const viewOverride: QuestsViewOverride | undefined = overrides[key];
      const adjustedTotal = itemsView ? questsViewAdjustedTotalKk(itemsView, viewOverride) : null;
      const rateIsOverride = typeof viewOverride?.coinRateKk === "number" && viewOverride.coinRateKk > 0;
      const coinRate = rateIsOverride ? Number(viewOverride?.coinRateKk) : getServerCoinRate(coinRates, server);
      return {
        displayKk: adjustedTotal ? adjustedTotal.kk : null,
        adjusted: adjustedTotal ? adjustedTotal.adjusted : false,
        isManual: itemsView ? itemsView.isManual : false,
        coinRate,
        rateIsOverride,
      };
    };

    // ── Categoria "Personagens Com Itens" (107ª — SÓ usuário Boss) ─────────
    // Interesses LOCAIS da guia Itens ∩ última consulta LOCAL da guia —
    // mesmo cruzamento da própria guia (isItemsInterestMarked: id do leilão
    // OU nome+servidor), só leilões ainda ATIVOS.
    const itemsList: NextBidEntry[] = [];
    if (isBoss) {
      const interestRecords = loadItemsInterestRecords(currentUserUid);
      if (interestRecords.length > 0) {
        for (const result of localQueryResults) {
          const key = String(result.id || result.url || result.name || "");
          if (!key) continue;
          if (!isItemsInterestMarked(interestRecords, { id: key, name: result.name, server: result.server })) continue;
          if (!isAuctionStillActive({ auctionEndTs: result.auctionEndTs ?? null }, nowUnixTs)) continue;
          itemsList.push({
            key,
            character: {
              id: String(result.id || ""),
              name: String(result.name || ""),
              vocation: String(result.vocation || ""),
              level: Number(result.level || 0),
              server: String(result.server || ""),
              auctionEndTs: result.auctionEndTs ?? null,
              url: String(result.url || ""),
            },
            endTs: normalizeAuctionEndTimestamp(result.auctionEndTs ?? null),
            ...valueFields(key, String(result.server || ""), itemsViewFromLocalResult(result)),
          });
        }
      }
    }
    itemsList.sort(compareByAuctionEnd);
    // Deduplicação entre categorias (decisão do usuário): personagem também
    // marcado na guia Quests aparece SÓ aqui — a categoria de Itens prevalece.
    const itemsKeys = new Set(itemsList.map(entry => entry.key));
    const itemsPairs = new Set(itemsList.map(entry => characterPairKey(entry.character.name, entry.character.server)).filter(Boolean));

    // ── Categoria "Personagens Para SW/SG/GB" (fonte da 105ª, intacta) ─────
    const questsList: NextBidEntry[] = [];
    if (officialCache) {
      // Interesses válidos SÓ para a versão atual da lista (mesma regra do
      // painel: versão divergente = consulta antiga, interesses descartados).
      const interests = readBazaarInterestsCache(officialCache.version)?.interests || {};
      for (const character of officialCache.characters || []) {
        const key = String(character.id || character.url || character.name || "");
        if (!key) continue;
        const interestUsers = interests[key] || [];
        if (!interestUsers.some(user => user.uid === currentUserUid)) continue;
        // Só interesses ATIVOS: leilão já encerrado não entra (nem no badge).
        if (!isAuctionStillActive({ auctionEndTs: character.auctionEndTs ?? null }, nowUnixTs)) continue;
        // Já exibido em "Personagens Com Itens"? Não repete (zero duplicação).
        if (itemsKeys.has(key)) continue;
        const pairKey = characterPairKey(character.name, character.server);
        if (pairKey && itemsPairs.has(pairKey)) continue;
        const localResult = localResultByKey.get(key);
        const itemsView = localResult ? itemsViewFromLocalResult(localResult) : itemsViewFromAuction(character);
        questsList.push({
          key,
          character: {
            id: String(character.id || ""),
            name: String(character.name || ""),
            vocation: String(character.vocation || ""),
            level: Number(character.level || 0),
            server: String(character.server || ""),
            auctionEndTs: character.auctionEndTs ?? null,
            url: String(character.url || ""),
          },
          endTs: normalizeAuctionEndTimestamp(character.auctionEndTs ?? null),
          ...valueFields(key, String(character.server || ""), itemsView),
        });
      }
    }
    questsList.sort(compareByAuctionEnd);
    return { questsEntries: questsList, itemsEntries: itemsList, timezoneOffsetMinutes };
  }, [currentUserUid, isBoss, officialCache, nowMs, sourcesBump]);

  const nowUnixTs = Math.floor(nowMs / 1000);
  const totalCount = questsEntries.length + itemsEntries.length;
  // Próximo encerramento GERAL = o mais cedo entre as duas categorias (cada
  // lista já está em ordem cronológica — basta comparar os primeiros com
  // horário conhecido). Alimenta o badge do rodapé e o selo "Próximo".
  const nextEntry = [questsEntries.find(entry => entry.endTs !== null), itemsEntries.find(entry => entry.endTs !== null)]
    .filter((entry): entry is NextBidEntry => !!entry)
    .sort(compareByAuctionEnd)[0] || null;
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
      ? `Próximo encerramento entre os seus interesses: ${nextEntry.character.name || "—"} — ${nextLabel}. Clique para ver todos (${totalCount}).`
      : "Você não tem interesses ativos no Bazaar. Marque \"Tenho Interesse\" nos personagens do Painel Bazaar para acompanhá-los aqui.";

  /**
   * CARD de um interesse (107ª — substitui a linha de tabela da 105ª, com as
   * MESMAS informações e interações): nome em destaque com as interações de
   * cópia do painel, badge de vocação, level, servidor, Valor dos Itens
   * (kk + RC, personalização local > automático), "Encerra" pela fonte única
   * AuctionEndBadge + tempo restante, e o botão "Abrir". Encerrando em
   * ≤ 5 min (critério do Painel Bazaar) o card inteiro fica âmbar; o
   * próximo encerramento GERAL ganha o selo "Próximo".
   */
  function renderEntryCard(entry: NextBidEntry, index: number) {
    const { character } = entry;
    const endingSoon = isAuctionEndingSoon({ auctionEndTs: entry.endTs }, nowUnixTs);
    const stillActive = isAuctionStillActive({ auctionEndTs: entry.endTs }, nowUnixTs);
    const isNext = nextEntry?.key === entry.key;
    const timeLeft = formatTimeLeft(entry.endTs, nowUnixTs);
    const selectionIndex = descSelection.findIndex(sel => sel.rowKey === entry.key);
    const isSelected = descSelectedKeys.has(entry.key);
    const feedbackHere = nameFeedback?.key === entry.key ? nameFeedback : null;
    return (
      <div
        key={entry.key}
        className={`flex items-center gap-2.5 rounded-lg border px-2.5 py-2 transition-colors ${
          endingSoon
            ? "border-amber-500/50 bg-amber-500/[0.08]"
            : isNext
              ? "border-amber-500/30 bg-black/25 hover:bg-white/[0.03]"
              : "border-[var(--th-line)]/50 bg-black/20 hover:bg-white/[0.03]"
        }`}
      >
        <span className="w-5 flex-shrink-0 text-center font-mono text-[9px] font-black tabular-nums text-slate-500">{index + 1}</span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-1.5 min-w-0">
            {/* Nome em destaque — interações IDÊNTICAS às do painel
                (esquerdo = nome; direito = resumo; Ctrl+direito = acumula);
                contextmenu padrão suprimido SÓ aqui. */}
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
            {isNext && (
              <span className="flex-shrink-0 rounded border border-amber-500/45 bg-amber-500/15 px-1 py-px text-[7px] font-black uppercase tracking-wider text-amber-300" title="Próximo encerramento entre todos os seus interesses ativos — é o horário exibido no badge do rodapé">
                Próximo
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="rounded border border-[var(--th-line)]/60 bg-black/25 px-1.5 py-px text-[8.5px] font-bold text-slate-300" title="Servidor do personagem">
              {character.server || "—"}
            </span>
            {entry.displayKk === null ? (
              <span className="font-mono text-[9.5px] font-bold text-slate-600" title="Personagem sem itens monitorados e sem Ouro relevante (acima de 1kk) na última consulta da guia Itens (ou consulta de itens ainda não realizada).">
                Itens: —
              </span>
            ) : (
              <>
                <span
                  className="font-mono text-[9.5px] font-black text-amber-200"
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
              </>
            )}
          </div>
        </div>
        <div className="flex flex-shrink-0 flex-col items-end gap-0.5 font-mono text-[10px] tabular-nums">
          <AuctionEndBadge auctionEndTs={character.auctionEndTs ?? null} nowUnixTs={nowUnixTs} timezoneOffsetMinutes={timezoneOffsetMinutes} />
          {timeLeft && (
            <span
              className={`text-[8.5px] font-bold ${endingSoon ? "text-amber-300 animate-pulse" : stillActive ? "text-slate-500" : "text-slate-600 line-through"}`}
              title={endingSoon ? "Leilão encerra em menos de 5 minutos" : stillActive ? "Tempo restante até o encerramento" : "Leilão já encerrado"}
            >
              {timeLeft}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => openExternalUrl(String(character.url || ""))}
          disabled={!character.url}
          title={character.url ? "Abrir o anúncio deste personagem no Bazaar" : "Link do anúncio indisponível"}
          className="inline-flex h-6 flex-shrink-0 items-center justify-center gap-1 rounded-md border border-cyan-500/25 bg-cyan-500/10 px-1.5 text-[9px] font-black text-cyan-300 hover:bg-cyan-500/20 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <ExternalLink size={10} /> Abrir
        </button>
      </div>
    );
  }

  /** Cabeçalho de categoria (107ª — SÓ usuário Boss vê as duas categorias). */
  function renderSectionHeader(kind: "quests" | "items", count: number) {
    const isQuests = kind === "quests";
    return (
      <div className={`flex items-center gap-2 rounded-md border-l-2 px-2.5 py-1.5 ${isQuests ? "border-amber-400 bg-gradient-to-r from-amber-500/10 to-transparent" : "border-cyan-400 bg-gradient-to-r from-cyan-500/10 to-transparent"}`}>
        {isQuests
          ? <Swords size={12} className="flex-shrink-0 text-amber-300" />
          : <Package size={12} className="flex-shrink-0 text-cyan-300" />}
        <span className={`text-[10px] font-black uppercase tracking-wider ${isQuests ? "text-amber-200" : "text-cyan-200"}`}>
          {isQuests ? "Personagens Para SW/SG/GB" : "Personagens Com Itens"}
        </span>
        <span className={`rounded-full border px-1.5 font-mono text-[8px] font-black leading-[14px] ${isQuests ? "border-amber-500/35 bg-amber-500/10 text-amber-300" : "border-cyan-500/35 bg-cyan-500/10 text-cyan-300"}`} title={`${count} interesse(s) ativo(s) nesta categoria`}>
          {count}
        </span>
      </div>
    );
  }

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
        {totalCount > 0 && (
          <span className="rounded-full bg-amber-500 px-1.5 font-mono text-[8px] font-black leading-[13px] text-black" title={`${totalCount} interesse(s) ativo(s)`}>
            {totalCount}
          </span>
        )}
      </button>

      {/* ── MODAL — interesses ativos em ordem cronológica de encerramento ──
          Renderizado via PORTAL no <body> (correção pós-105ª): o badge vive
          dentro do <footer>, que tem `backdrop-blur-md` — por especificação
          CSS, um ancestral com backdrop-filter vira o containing block de
          descendentes `position: fixed`, o que CONFINAVA o overlay à área do
          rodapé. No portal, o overlay é filho do <body> e cobre a tela
          inteira, como os demais modais do app. */}
      {isOpen && createPortal(
        /* 108ª — RESPONSIVIDADE pela BASE GLOBAL de modais (index.css), a
           MESMA dos demais modais do app:
           • `app-modal-overlay` confina o overlay à área útil medida pelo
             App (useModalViewportBounds publica os insets do cabeçalho e do
             RODAPÉ no <html> — vale para portais e acompanha zoom/resolução
             via visualViewport): o modal nunca cobre o rodapé nem as bordas;
           • `app-modal-frame--scroll` + `app-modal-body` = teto de altura
             global (`--app-modal-available-height`, com !important) e
             rolagem SÓ no miolo, apenas quando necessária — com poucos
             personagens o modal mantém a altura natural;
           • o `max-h-[85vh]` local foi REMOVIDO: ignorava o rodapé (85vh
             pode ser maior que a área útil) e era justamente o que deixava
             o modal ultrapassar os limites em telas baixas/zoom alto.
           Cabeçalho e barra de seleção são flex-shrink-0 — permanecem
           visíveis durante a rolagem. `fixed inset-0` continua como
           fallback declarativo (o CSS global prevalece), como nos demais. */
        <div className="app-modal-overlay fixed inset-0 z-[1200] flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => setIsOpen(false)}>
          <div
            className="app-modal-frame app-modal-size-lg app-modal-frame--scroll w-full rounded-xl border border-amber-500/30 bg-[var(--th-bg-raised)] shadow-2xl shadow-black/60"
            onClick={event => event.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-[var(--th-line)]/60 bg-[var(--th-bg-overlay)] flex-shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <Gavel size={14} className="text-amber-400 flex-shrink-0" />
                <span className="text-xs font-black text-amber-200 truncate">Próximo Bid — Meus Interesses</span>
                {totalCount > 0 && (
                  <span className="rounded-full border border-amber-500/35 bg-amber-500/10 px-1.5 font-mono text-[9px] font-black leading-[15px] text-amber-300">
                    {totalCount}
                  </span>
                )}
              </div>
              <button type="button" onClick={() => setIsOpen(false)} className="text-slate-500 hover:text-white transition-colors cursor-pointer" title="Fechar">
                <X size={14} />
              </button>
            </div>

            {/* Miolo rolável (108ª): `app-modal-body` é a fonte única da
                rolagem interna (flex:1 + min-height:0 + overflow:auto do CSS
                global) — a barra vertical só aparece quando o conteúdo passa
                da área útil; `custom-scrollbar` = barra discreta padrão. */}
            <div className="app-modal-body custom-scrollbar">
              {totalCount === 0 ? (
                <div className="flex flex-col items-center gap-1.5 px-4 py-8 text-center">
                  <span className="text-[11px] font-bold text-slate-300">Nenhum interesse ativo no momento.</span>
                  <span className="text-[9px] text-slate-500">
                    Marque {"\u201C"}Tenho Interesse{"\u201D"} nos personagens do Painel Bazaar
                    {isBoss ? " (guias de Quests e de Itens)" : ""} — os leilões ainda ativos aparecem aqui em ordem de encerramento.
                  </span>
                </div>
              ) : isBoss ? (
                /* BOSS (107ª): DUAS categorias, cada uma em ordem cronológica
                   própria; personagem marcado nas duas guias aparece só em
                   "Personagens Com Itens" (deduplicação na derivação). */
                <div className="flex flex-col gap-2 p-2.5">
                  {renderSectionHeader("quests", questsEntries.length)}
                  {questsEntries.length === 0 ? (
                    <span className="px-2 pb-1 text-[9px] text-slate-500">Nenhum interesse ativo nesta categoria.</span>
                  ) : (
                    <div className="flex flex-col gap-1.5">{questsEntries.map((entry, index) => renderEntryCard(entry, index))}</div>
                  )}
                  {renderSectionHeader("items", itemsEntries.length)}
                  {itemsEntries.length === 0 ? (
                    <span className="px-2 pb-1 text-[9px] text-slate-500">Nenhum interesse ativo nesta categoria.</span>
                  ) : (
                    <div className="flex flex-col gap-1.5">{itemsEntries.map((entry, index) => renderEntryCard(entry, index))}</div>
                  )}
                </div>
              ) : (
                /* SEM cargo Boss: comportamento anterior — só os interesses
                   do Painel Bazaar (quests), sem categoria adicional. */
                <div className="flex flex-col gap-1.5 p-2.5">
                  {questsEntries.map((entry, index) => renderEntryCard(entry, index))}
                </div>
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
        </div>,
        document.body,
      )}
    </>
  );
}
