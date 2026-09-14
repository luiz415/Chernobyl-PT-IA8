// ============================================================================
// PERSONAGENS COM ITENS — corpo do modo "itens" do Painel Bazaar
// ----------------------------------------------------------------------------
// Painel EXCLUSIVO do Boss (o gate real está no BazarPanel e é reconferido
// aqui). Tudo é LOCAL: Lista de Itens, cotação do coin e resultados vivem no
// localStorage — NADA é gravado no Firestore.
//
// Fluxo da consulta (espelha a estratégia do método novo das quests):
//   1. listagem via `rubinot-bazaar-fetch` com early-stop pelo "Encerra até";
//   2. filtro de DATA aplicado AQUI, antes da fase individual — personagens
//      fora do prazo nunca chegam ao navegador;
//   3. `rubinot-bazaar-items-v2`: 1 fetch JSON por personagem elegível
//      (exclusivamente API — sem método antigo página-a-página);
//   4. casamento com a Lista de Itens + Tier (+20%/nível) + kk→RC locais.
// ============================================================================

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, ArrowDownUp, Check, Coins, Copy, Download, ExternalLink, Eye, FlagTriangleRight, Globe, ListChecks, Package, Pencil, Plus, RefreshCw, RotateCcw, Search, Sparkles, Square, Star, Trash2, Upload, X } from "lucide-react";
import BazaarBrowserModal, { BAZAAR_BROWSER_KEY, BAZAAR_BROWSER_ORDER_KEY, BAZAAR_RETRY_BROWSERS_KEY, BAZAAR_RETRY_COUNTS_KEY, BAZAAR_SPEED_MODE_KEY, DEFAULT_BROWSER_ORDER, normalizeRetryCounts } from "./BazaarBrowserModal";
// Mesmos componentes de filtro da tabela de QUESTS (FilterTypes é a fonte
// única — nenhuma implementação paralela) e as MESMAS classes de célula
// sticky do cabeçalho exportadas pelo BazarPanel (fonte única de estilo).
import { FilterDateMax, FilterInline, FilterMulti, FilterNumber } from "./FilterTypes";
import { STICKY_FILTER_CELL_CLASS, STICKY_HEAD_CELL_CLASS, closeRubinotBrowserFromRenderer, isAuctionVisibleWithEndedGrace } from "./BazarPanel";
import type { BazaarRetryCounts, BazaarSpeedMode } from "./BazaarBrowserModal";
import { loadUIState } from "../storage";
import { computeItemRC, formatKkValue } from "../utils/itemSale";
// "Atualizar Valores" — MESMO mecanismo das quests: os helpers puros do
// overlay (cruzamento lista antiga × listagem nova) são reutilizados como
// estão; aqui a aplicação é sobre os resultados LOCAIS da última consulta.
import { applyValueOverlay, buildValueOverlay } from "../utils/bazaarValueRefresh";
import {
  formatAuctionEnd,
  formatDateTimeWithOffset,
  formatDuration,
  formatTimeZoneOffset,
  getDefaultBazarEndUntil,
  normalizeAuctionEndTimestamp,
  parseDateTimeLocalWithOffset,
} from "../utils/bazaarTime";
import { openExternalUrl } from "../utils/openExternal";
import {
  buildCharacterMatches,
  buildWatchlistIndex,
  canonicalServerKey,
  collectAllWatchKeys,
  exportWatchlistByServerJson,
  exportWatchlistJson,
  getServerWatchedItems,
  loadItemsCoinRate,
  loadItemsInterests,
  loadItemsLastQuery,
  loadWatchedItemsByServer,
  mergeWatchedLists,
  normalizeWatchedItemName,
  parseWatchlistImportAny,
  repriceQueryResultsForServerItem,
  saveItemsCoinRate,
  saveItemsInterests,
  saveItemsLastQuery,
  saveWatchedItemsByServer,
  type BazaarItemsCharacterResult,
  type BazaarItemsLastQuery,
  type RawItemMatch,
  type WatchedItem,
  type WatchedItemsByServer,
} from "../utils/bazaarWatchedItems";
// Fonte ÚNICA de servidores (mesma lista/normalização do restante do app):
// as Listas de Itens agora são POR SERVIDOR, chaveadas pelo nome oficial.
import { SERVER_OPTIONS } from "../constants/servers";
import { syncBazaarItemsEndingAlerts } from "../services/bazaarInterestNotificationService";
import { useAuth } from "../context/AuthContext";

// ── Tipos mínimos do IPC (mesmo contrato dos handlers existentes) ───────────
interface ItemsAuction {
  id: string;
  name: string;
  vocation: string;
  level: number;
  server: string;
  bid: number;
  auctionEndTs: number | null;
  url: string;
}

interface ItemsFetchResult {
  ok: boolean;
  auctions: ItemsAuction[];
  total: number;
  error?: string;
  cancelled?: boolean;
  serverNotReady?: boolean;
  browserUnavailable?: boolean;
}

interface ItemsDetailsResult {
  ok: boolean;
  error?: string;
  details: Record<string, { id: string; matches?: RawItemMatch[]; error?: string }>;
  analyzedCount?: number;
  failedCount?: number;
  stoppedManually?: boolean;
  totalDurationMs?: number;
}

interface ItemsProgressEvent {
  active?: boolean;
  stage?: string;
  message?: string;
  processed?: number;
  total?: number;
  percent?: number;
}

interface Props {
  isBossUser: boolean;
  isElectron: boolean;
  timezoneOffsetMinutes: number;
  /**
   * Reuso do botão "Link" do painel de quests: estado de abertura por leilão
   * ("open" | "opened" | "last") vindo do MESMO openedLinksState do BazarPanel.
   */
  getLinkState?: (auctionKey: string) => "open" | "opened" | "last";
  /** Marca o leilão como aberto e abre no navegador padrão (mesmo fluxo das quests). */
  openLink?: (auctionKey: string, url: string) => void;
}

/** Entrada em edição no modal da Lista de Itens. */
interface ItemDraft {
  id: string | null;
  name: string;
  valueKk: string;
}

const EMPTY_DRAFT: ItemDraft = { id: null, name: "", valueKk: "" };

// ── Filtros/ordenação da TABELA de resultados — mesmo padrão das QUESTS ─────
// Cópia fiel do desenho de BazaarTableFilters/SortKey do BazarPanel, com os
// campos ADAPTADOS às colunas desta tabela (Personagem, Servidor, Encerra,
// Valor, Valor Itens em KK e em RC). Mesmo comportamento: filtros persistidos
// no localStorage (chave própria do modo itens), ordenação volátil por sessão.
type ItemsSortKey = "name" | "server" | "auctionEndTs" | "bid" | "totalKk" | "rc" | "potential";
type ItemsSortDir = "asc" | "desc";

interface ItemsTableFilters {
  name: string;
  servers: string[];
  endUntil: string;
  bidValue: number | null;
  bidOperator: "gte" | "lte";
  kkValue: number | null;
  kkOperator: "gte" | "lte";
  rcValue: number | null;
  rcOperator: "gte" | "lte";
  /** Exibe apenas leilões marcados como "Tenho Interesse" (estado LOCAL). */
  onlyMyInterests: boolean;
}

const ITEMS_TABLE_FILTERS_KEY = "rubinot_bazaar_items_table_filters";

function defaultItemsTableFilters(): ItemsTableFilters {
  return {
    name: "",
    servers: [],
    endUntil: "",
    bidValue: null,
    bidOperator: "lte",
    kkValue: null,
    kkOperator: "gte",
    rcValue: null,
    rcOperator: "gte",
    onlyMyInterests: false,
  };
}

function readItemsTableFilters(): ItemsTableFilters {
  try {
    const raw = localStorage.getItem(ITEMS_TABLE_FILTERS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    const saved = parsed && typeof parsed === "object" ? parsed : {};
    return {
      ...defaultItemsTableFilters(),
      ...saved,
      // Mesma migração segura das quests: só `true` ativa o filtro.
      onlyMyInterests: saved.onlyMyInterests === true,
    };
  } catch {
    return defaultItemsTableFilters();
  }
}

function saveItemsTableFilters(filters: ItemsTableFilters) {
  try {
    localStorage.setItem(ITEMS_TABLE_FILTERS_KEY, JSON.stringify(filters));
  } catch {}
}

// ── "Ocultar encerrados / Exibir todos" — mesma preferência das QUESTS ──────
// Mesmo comportamento/persistência de readHideEndedAuctionsPreference do
// BazarPanel (default = ocultar), em chave própria do modo itens. A regra de
// visibilidade é a MESMA função exportada pelo BazarPanel (carência de 5
// minutos após o encerramento).
const ITEMS_HIDE_ENDED_KEY = "rubinot_bazaar_items_hide_ended";

function readItemsHideEndedPreference(): boolean {
  try {
    const raw = localStorage.getItem(ITEMS_HIDE_ENDED_KEY);
    return raw === null ? true : JSON.parse(raw) !== false;
  } catch {
    return true;
  }
}

function saveItemsHideEndedPreference(value: boolean) {
  try { localStorage.setItem(ITEMS_HIDE_ENDED_KEY, JSON.stringify(value)); } catch {}
}

// ── Servidor selecionado no modal "Lista de Itens" ──────────────────────────
// Cada servidor tem a SUA lista de preços; o seletor do modal define qual
// lista está sendo exibida/editada (e o alvo do escopo "Apenas Este
// Servidor" no exportar/importar). Preferência persistida por dispositivo.
const ITEMS_SELECTED_SERVER_KEY = "rubinot_bazaar_items_selected_server";

function readItemsSelectedServer(): string {
  try {
    const raw = localStorage.getItem(ITEMS_SELECTED_SERVER_KEY);
    const value = raw ? String(JSON.parse(raw) || "") : "";
    if (value && SERVER_OPTIONS.includes(value)) return value;
  } catch {}
  return SERVER_OPTIONS[0] || "";
}

function saveItemsSelectedServer(value: string) {
  try { localStorage.setItem(ITEMS_SELECTED_SERVER_KEY, JSON.stringify(value)); } catch {}
}

/**
 * Valor EFETIVO do "Valor Itens (KK)" de um personagem: a correção MANUAL
 * (quando presente e válida) tem prioridade sobre o total calculado pela
 * consulta. Fonte única — exibição, filtros, ordenação e o cálculo de RC
 * passam todos por aqui.
 */
function effectiveTotalKk(result: BazaarItemsCharacterResult): number {
  const manual = Number(result.manualTotalKk);
  return Number.isFinite(manual) && manual > 0 ? manual : result.totalKk;
}

/** true quando o personagem tem correção manual ativa no KK. */
function hasManualTotalKk(result: BazaarItemsCharacterResult): boolean {
  const manual = Number(result.manualTotalKk);
  return Number.isFinite(manual) && manual > 0;
}

// ── Coluna "POTENCIAL" ───────────────────────────────────────────────────────
// Compara o VALOR DOS ITENS com o PREÇO DO PERSONAGEM na mesma unidade (kk).
// O bid do leilão é em coins; a conversão coins→kk usa a MESMA cotação do
// coin já usada pelo kk→RC do painel (computeItemRC é kk→coins; aqui é o
// caminho inverso: coins × cotação ÷ 1000). Nenhuma regra nova de conversão.

/** Valor do personagem (bid em coins) convertido para kk pela cotação. */
function bidValueKk(result: BazaarItemsCharacterResult, coinRate: number): number {
  const bid = Number(result.bid || 0);
  if (!Number.isFinite(bid) || bid <= 0 || coinRate <= 0) return 0;
  return Math.round(bid * coinRate) / 1000;
}

/**
 * Diferença do potencial em kk (Valor Itens EFETIVO − personagem em kk) —
 * usada como informação complementar no tooltip da coluna.
 */
function potentialScoreKk(result: BazaarItemsCharacterResult, coinRate: number): number | null {
  if (coinRate <= 0) return null;
  return Math.round((effectiveTotalKk(result) - bidValueKk(result, coinRate)) * 100) / 100;
}

/**
 * PERCENTUAL do potencial: (Valor Itens EFETIVO − personagem) ÷ personagem.
 * É o retorno sobre o preço pago — a fórmula dos exemplos do requisito:
 * personagem 100kk / itens 150kk → +50%; personagem 150kk / itens 100kk →
 * −33,3%. Positivo = itens valem mais que o preço (verde); negativo =
 * personagem custa mais que os itens (vermelho). Usa o MESMO valor efetivo
 * da coluna KK (correção manual > calculado). É este número real que a
 * ordenação da coluna usa.
 *
 * Sem cotação do coin (não dá para pôr bid e kk na mesma unidade) ou sem
 * valor de personagem > 0 (divisão inválida) → null: a coluna exibe "—"
 * (dado indisponível), nunca um número enganoso. 1 casa decimal.
 */
function potentialPercent(result: BazaarItemsCharacterResult, coinRate: number): number | null {
  if (coinRate <= 0) return null;
  const bidKk = bidValueKk(result, coinRate);
  if (bidKk <= 0) return null;
  return Math.round(((effectiveTotalKk(result) - bidKk) / bidKk) * 1000) / 10;
}

/** "+50%" / "-33,3%" / "0%" — vírgula pt-BR, sem casa decimal desnecessária. */
function formatPotentialPercent(percent: number): string {
  const sign = percent > 0 ? "+" : percent < 0 ? "-" : "";
  const abs = Math.abs(percent);
  const text = Number.isInteger(abs) ? String(abs) : abs.toFixed(1).replace(".", ",");
  return `${sign}${text}%`;
}

/**
 * Prefixo dos ids de alerta do canal de ITENS (definido no serviço de
 * alertas). Distingue os chips deste painel dos chips do painel de quests —
 * cada painel exibe SOMENTE os seus.
 */
const ITEMS_ALERT_ID_PREFIX = "bazaar_items_ending_";

/** Chip local de "leilão encerrando" — mesmo formato do painel de quests. */
interface ItemsLocalNotification {
  id: string;
  title: string;
  body: string;
  url?: string;
  expiresAtMs?: number;
  auctionId?: string;
}

export default function BazaarItemsPanel({ isBossUser, isElectron, timezoneOffsetMinutes, getLinkState, openLink }: Props) {
  const { currentUser } = useAuth();
  const currentUid = currentUser?.uid || "";

  // ── Configurações locais ───────────────────────────────────────────────────
  // LISTAS DE PREÇOS POR SERVIDOR: `watchedByServer` é a fonte oficial
  // (Servidor → itens/valores/datas próprios). `selectedServer` define qual
  // lista o modal "Lista de Itens" exibe/edita. `watchedItems` é DERIVADO —
  // a lista do servidor selecionado — para que todo o CRUD/pesquisa/modal
  // existente continue operando sem lógica paralela.
  const [watchedByServer, setWatchedByServer] = useState<WatchedItemsByServer>(() => loadWatchedItemsByServer());
  const [selectedServer, setSelectedServer] = useState<string>(() => readItemsSelectedServer());
  const watchedItems = getServerWatchedItems(watchedByServer, selectedServer);

  useEffect(() => {
    saveItemsSelectedServer(selectedServer);
  }, [selectedServer]);
  const [coinRateText, setCoinRateText] = useState<string>(() => {
    const rate = loadItemsCoinRate();
    return rate > 0 ? String(rate).replace(".", ",") : "";
  });
  const [endUntil, setEndUntil] = useState<string>(() => getDefaultBazarEndUntil(timezoneOffsetMinutes));
  const [lastQuery, setLastQuery] = useState<BazaarItemsLastQuery | null>(() => loadItemsLastQuery());
  // "Pesquisar Item" do quadro "Última Consulta": filtro LOCAL e derivado
  // sobre os resultados já obtidos — nunca dispara nova consulta nem altera
  // os dados persistidos (lastQuery/localStorage permanecem intactos).
  const [resultsSearch, setResultsSearch] = useState("");

  // ── Filtros/ordenação da tabela — mesmo funcionamento das QUESTS ──────────
  // Filtros persistidos (localStorage) e ordenação por sessão, exatamente
  // como tableFilters/sortKey/sortDir do BazarPanel. Tudo derivado/local:
  // nenhum efeito sobre a consulta, os cálculos ou os dados persistidos.
  const [tableFilters, setTableFilters] = useState<ItemsTableFilters>(() => readItemsTableFilters());
  // ORDENAÇÃO PADRÃO — mesma das QUESTS: "Encerra" crescente (cronológica)
  // na abertura do painel; clicar em outra coluna passa a ordenar
  // EXCLUSIVAMENTE por ela (a prioridade permanente de "Encerra" foi
  // removida — comportamento idêntico ao sortKey/sortDir do BazarPanel).
  const [sortKey, setSortKey] = useState<ItemsSortKey>("auctionEndTs");
  const [sortDir, setSortDir] = useState<ItemsSortDir>("asc");

  // ── "Ocultar encerrados / Exibir todos" — mesmo comportamento das QUESTS ──
  // Preferência persistida por dispositivo (default oculta) + relógio de 15s
  // (mesmo intervalo do BazarPanel) para a lista reagir a encerramentos sem
  // interação do usuário. Regra de visibilidade = MESMA função das quests.
  const [hideEndedResults, setHideEndedResults] = useState(() => readItemsHideEndedPreference());
  const [currentUnixTs, setCurrentUnixTs] = useState(() => Math.floor(Date.now() / 1000));

  // ── "Atualizar Valores" — mesmo fluxo das QUESTS, sobre a lista local ─────
  const [isValueRefreshing, setIsValueRefreshing] = useState(false);
  const [valueRefreshStatus, setValueRefreshStatus] = useState("");

  // ── Edição MANUAL do "Valor Itens (KK)" — modal por personagem ────────────
  const [kkEdit, setKkEdit] = useState<{ auctionKey: string; value: string } | null>(null);

  useEffect(() => {
    saveItemsTableFilters(tableFilters);
  }, [tableFilters]);

  useEffect(() => {
    saveItemsHideEndedPreference(hideEndedResults);
  }, [hideEndedResults]);

  useEffect(() => {
    const updateCurrentTime = () => setCurrentUnixTs(Math.floor(Date.now() / 1000));
    updateCurrentTime();
    const interval = window.setInterval(updateCurrentTime, 15 * 1000);
    return () => window.clearInterval(interval);
  }, []);

  function updateTableFilters(patch: Partial<ItemsTableFilters>) {
    setTableFilters(prev => ({ ...prev, ...patch }));
  }

  function resetTableFilters() {
    setTableFilters(defaultItemsTableFilters());
  }

  /** Mesma alternância das quests: 1º clique ordena asc, 2º inverte. */
  function toggleSort(key: ItemsSortKey) {
    if (sortKey === key) {
      setSortDir(prev => prev === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  // ── Estado da consulta ─────────────────────────────────────────────────────
  const [isBrowserModalOpen, setIsBrowserModalOpen] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [progress, setProgress] = useState<ItemsProgressEvent | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ── Modais ─────────────────────────────────────────────────────────────────
  const [isItemsModalOpen, setIsItemsModalOpen] = useState(false);
  const [itemsSearch, setItemsSearch] = useState("");
  const [draft, setDraft] = useState<ItemDraft>(EMPTY_DRAFT);
  const [draftError, setDraftError] = useState<string | null>(null);
  // ── Edição INLINE do valor (modal Lista de Itens) ──────────────────────────
  // O botão "Editar" transforma o VALOR do item em um campo editável na
  // própria linha — o formulário "Adicionar item" é exclusivo para NOVOS
  // itens. Apenas uma linha em edição por vez; o nome não é alterado aqui.
  const [inlineEdit, setInlineEdit] = useState<{ id: string; valueKk: string } | null>(null);
  const [inlineEditError, setInlineEditError] = useState<string | null>(null);
  const [importFeedback, setImportFeedback] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  // ── Escopo do Exportar/Importar ────────────────────────────────────────────
  // Clicar em Exportar/Importar abre uma ETAPA compacta de escolha do escopo
  // ("Todos Servidores" | "Apenas Este Servidor") no lugar dos botões — o
  // fluxo original continua o mesmo, apenas com esta etapa antes de executar.
  const [scopePicker, setScopePicker] = useState<"export" | "import" | null>(null);
  // Escopo escolhido para a importação — consumido quando o arquivo chega.
  const importScopeRef = useRef<"all" | "current">("current");
  const [detailResult, setDetailResult] = useState<BazaarItemsCharacterResult | null>(null);
  // ── Edição de valor no modal "Detalhes" ────────────────────────────────────
  // Lápis na coluna "Total (kk)": edita o valor BASE do item NA LISTA DO
  // SERVIDOR do personagem visualizado (fonte única de preço) e reprecifica
  // os personagens DESSE servidor na última consulta.
  const [detailEdit, setDetailEdit] = useState<{ matchIndex: number; value: string } | null>(null);
  const [detailEditError, setDetailEditError] = useState<string | null>(null);
  // Feedback "Copiado!" (1,5s) — mesmo padrão dos demais botões de copiar do
  // aplicativo (AvailableCharacter/CharTable). Uma chave por origem da cópia.
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // ── "Tenho Interesse" — 100% LOCAL (localStorage por uid, ZERO Firestore) ─
  const [itemInterests, setItemInterests] = useState<string[]>(() => loadItemsInterests(currentUid));
  // Chips locais de "leilão encerrando" — mesmo formato/comportamento do
  // painel de quests, alimentados pelo canal de ITENS do agendador local.
  const [itemsNotifications, setItemsNotifications] = useState<ItemsLocalNotification[]>([]);

  const coinRate = parseCoinRate(coinRateText);

  // Recarrega o interesse local quando o usuário muda (mesma chave por uid).
  useEffect(() => {
    setItemInterests(loadItemsInterests(currentUid));
  }, [currentUid]);

  // ── Agendador de alertas do canal de ITENS ────────────────────────────────
  // Alimenta a fila local SEPARADA das quests com os resultados da última
  // consulta LOCAL + interesses LOCAIS. Notificações saem pelo MESMO caminho
  // das quests (centro/som/desktop + chip) — nada disso passa pelo Firestore.
  useEffect(() => {
    if (!currentUid || !lastQuery) return;
    syncBazaarItemsEndingAlerts({
      characters: (lastQuery.results || []).map(result => ({
        id: result.id || result.url || result.name,
        name: result.name,
        server: result.server,
        auctionEndTs: result.auctionEndTs ?? null,
        url: result.url,
      })),
      interestedAuctionIds: itemInterests,
      currentUserUid: currentUid,
      bazaarVersion: `items_${lastQuery.completedAtMs}`,
    });
  }, [currentUid, lastQuery, itemInterests]);

  // Chips do painel — mesmo evento/formato do painel de quests, filtrado
  // pelo prefixo do canal de itens (cada painel exibe somente os seus).
  useEffect(() => {
    const handleLocalNotification = (event: Event) => {
      const detail = (event as CustomEvent).detail || {};
      const id = String(detail.id || "");
      if (!id.startsWith(ITEMS_ALERT_ID_PREFIX)) return;
      const notification: ItemsLocalNotification = {
        id,
        title: detail.title || "Leilão encerrando",
        body: detail.body || "Um leilão de interesse está perto de encerrar.",
        url: detail.url,
        expiresAtMs: detail.expiresAtMs,
        auctionId: String(detail.auctionId || "") || undefined,
      };
      setItemsNotifications(prev => {
        const withoutSame = prev.filter(item => item.id !== notification.id);
        return [...withoutSame, notification].sort((a, b) => (a.expiresAtMs || 0) - (b.expiresAtMs || 0));
      });
    };
    window.addEventListener("bazaar-interest-local-notification", handleLocalNotification);
    return () => window.removeEventListener("bazaar-interest-local-notification", handleLocalNotification);
  }, []);

  // Expiração dos chips — mesmo mecanismo do painel de quests: remove o chip
  // no momento em que o leilão encerra.
  useEffect(() => {
    if (itemsNotifications.length === 0) return;
    const nowMs = Date.now();
    const nextExpirationMs = itemsNotifications.reduce((min, item) => {
      if (!item.expiresAtMs) return min;
      return Math.min(min, item.expiresAtMs);
    }, Number.POSITIVE_INFINITY);
    if (!Number.isFinite(nextExpirationMs)) return;
    const delay = Math.max(0, nextExpirationMs - nowMs);
    const timer = window.setTimeout(() => {
      const currentMs = Date.now();
      setItemsNotifications(prev => prev.filter(item => !item.expiresAtMs || item.expiresAtMs > currentMs));
    }, delay);
    return () => window.clearTimeout(timer);
  }, [itemsNotifications]);

  // ── Encaixe dos botões nas AÇÕES DO CABEÇALHO (portal) ────────────────────
  // O BazarPanel reserva o contêiner `#bazaar-items-title-actions` no canto
  // superior DIREITO da linha do cabeçalho, FORA do quadro do título (mesma
  // posição das ações do modo de quests). O contêiner só existe DEPOIS da
  // montagem — por isso a referência é resolvida em efeito, não no render.
  const [titleActionsHost, setTitleActionsHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setTitleActionsHost(document.getElementById("bazaar-items-title-actions"));
    return () => setTitleActionsHost(null);
  }, []);

  /** Marca/desmarca "Tenho Interesse" — grava SOMENTE no localStorage. */
  function toggleItemInterest(auctionKey: string) {
    const key = String(auctionKey || "").trim();
    if (!key) return;
    setItemInterests(prev => {
      const next = prev.includes(key) ? prev.filter(id => id !== key) : [...prev, key];
      saveItemsInterests(currentUid, next);
      return next;
    });
  }

  // ── Chips visíveis = notificações locais ∩ "Tenho Interesse" ──────────────
  // Mesma regra do painel de quests: remover o interesse remove o chip na
  // hora. Sem auctionId não há como cruzar — o chip permanece (expira só).
  const visibleItemsNotifications = itemsNotifications.filter(item => {
    if (!item.auctionId) return true;
    return itemInterests.includes(item.auctionId);
  });

  /** Copia texto e marca o feedback — mesmo mecanismo dos copiar existentes. */
  async function copyText(key: string, text: string) {
    const value = String(text || "").trim();
    if (!value) return;
    try { await navigator.clipboard.writeText(value); } catch { /* fallback silencioso */ }
    setCopiedKey(key);
    window.setTimeout(() => setCopiedKey(current => (current === key ? null : current)), 1500);
  }

  // Progresso do processo principal — o mesmo canal usado pelas quests. Só é
  // exibido enquanto ESTA consulta roda (isRunning), então não interfere no
  // modo de quests.
  useEffect(() => {
    if (!isElectron) return;
    try {
      const { ipcRenderer } = (window as any).require("electron");
      const handleProgress = (_event: unknown, event: ItemsProgressEvent) => {
        if (!event || event.active === false) {
          setProgress(null);
          return;
        }
        setProgress(event);
      };
      ipcRenderer.on("rubinot-bazaar-progress", handleProgress);
      return () => {
        ipcRenderer.removeListener("rubinot-bazaar-progress", handleProgress);
      };
    } catch {
      return;
    }
  }, [isElectron]);

  // ── Lista de Itens: CRUD local (sempre na lista do servidor SELECIONADO) ──
  function persistItems(next: WatchedItem[]) {
    persistServerItems(selectedServer, next);
  }

  /** Grava a lista de UM servidor no mapa oficial (fonte única de preços). */
  function persistServerItems(server: string, next: WatchedItem[]) {
    const key = canonicalServerKey(server);
    if (!key) return;
    const map: WatchedItemsByServer = { ...watchedByServer };
    if (next.length > 0) map[key] = next;
    else delete map[key];
    saveWatchedItemsByServer(map);
    setWatchedByServer(map);
  }

  /** Grava o mapa COMPLETO (importação "Todos Servidores"). */
  function persistAllServerItems(map: WatchedItemsByServer) {
    saveWatchedItemsByServer(map);
    setWatchedByServer(map);
  }

  /** Formulário superior — EXCLUSIVO para ADICIONAR novos itens. */
  function submitDraft() {
    const name = draft.name.trim();
    // Valores em kk são INTEIROS: o input já bloqueia não-dígitos, mas a
    // validação re-confere (colar texto, itens legados etc.).
    const rawValue = draft.valueKk.trim();
    if (!name) { setDraftError("Informe o nome do item."); return; }
    if (!/^\d+$/.test(rawValue)) { setDraftError("Informe o valor em kk usando somente números inteiros."); return; }
    const valueKk = Number(rawValue);
    if (!Number.isSafeInteger(valueKk) || valueKk <= 0) { setDraftError("Informe o valor em kk (inteiro, maior que zero)."); return; }
    const key = normalizeWatchedItemName(name);
    const duplicated = watchedItems.some(item => normalizeWatchedItemName(item.name) === key);
    if (duplicated) { setDraftError("Este item já está na lista."); return; }
    const now = Date.now();
    persistItems([...watchedItems, { id: `wi_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`, name, valueKk, updatedAtMs: now }]);
    setDraft(EMPTY_DRAFT);
    setDraftError(null);
  }

  /** Abre a edição INLINE do valor na linha do item (uma linha por vez). */
  function startInlineEdit(item: WatchedItem) {
    setInlineEdit({ id: item.id, valueKk: String(item.valueKk) });
    setInlineEditError(null);
  }

  function cancelInlineEdit() {
    setInlineEdit(null);
    setInlineEditError(null);
  }

  /**
   * Salva o valor editado inline. Mesmas regras do fluxo anterior de edição:
   * kk inteiro > 0; "Atualizado dia..." só muda quando o VALOR muda de fato
   * (salvar sem alterar preserva a data anterior). O nome NUNCA muda aqui.
   */
  function saveInlineEdit() {
    if (!inlineEdit) return;
    const rawValue = inlineEdit.valueKk.trim();
    if (!/^\d+$/.test(rawValue)) { setInlineEditError("Informe o valor em kk usando somente números inteiros."); return; }
    const valueKk = Number(rawValue);
    if (!Number.isSafeInteger(valueKk) || valueKk <= 0) { setInlineEditError("Informe o valor em kk (inteiro, maior que zero)."); return; }
    const now = Date.now();
    persistItems(watchedItems.map(item => {
      if (item.id !== inlineEdit.id) return item;
      const valueChanged = item.valueKk !== valueKk;
      return { ...item, valueKk, updatedAtMs: valueChanged ? now : item.updatedAtMs };
    }));
    setInlineEdit(null);
    setInlineEditError(null);
  }

  function removeItem(id: string) {
    persistItems(watchedItems.filter(item => item.id !== id));
    if (inlineEdit?.id === id) cancelInlineEdit();
  }

  /** Baixa um JSON — mesmo mecanismo de download usado desde a v1. */
  function downloadJsonFile(content: string, filename: string) {
    const blob = new Blob([content], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }

  /**
   * EXPORTAR com escopo:
   *  • "all" — UM único arquivo (v2) com a lista de CADA servidor, estrutura
   *    Servidor → Item → Valor preservada;
   *  • "current" — apenas a lista do servidor selecionado (formato v1
   *    compatível, com o campo informativo `server`).
   */
  function handleExport(scope: "all" | "current") {
    setScopePicker(null);
    try {
      const dateLabel = new Date().toISOString().slice(0, 10);
      if (scope === "all") {
        downloadJsonFile(
          exportWatchlistByServerJson(watchedByServer),
          `bazaar-lista-de-itens-todos-servidores-${dateLabel}.json`,
        );
      } else {
        const serverSlug = selectedServer.toLowerCase().replace(/\s+/g, "-");
        downloadJsonFile(
          exportWatchlistJson(watchedItems, selectedServer),
          `bazaar-lista-de-itens-${serverSlug}-${dateLabel}.json`,
        );
      }
    } catch {
      setImportFeedback("Não foi possível exportar a lista.");
    }
  }

  /**
   * IMPORTAR com escopo (escolhido ANTES de abrir o seletor de arquivo):
   *  • "all" — arquivo v2 restaura cada lista no servidor CORRESPONDENTE
   *    (mesma mescla de sempre, servidor a servidor); arquivo antigo (v1)
   *    não tem servidores embutidos → orienta a usar "Apenas Este Servidor";
   *  • "current" — o conteúdo entra SOMENTE na lista do servidor selecionado
   *    (de um v2, usa a lista desse mesmo servidor no arquivo), sem tocar
   *    nos demais.
   */
  function handleImportFile(file: File | null) {
    if (!file) return;
    const scope = importScopeRef.current;
    const reader = new FileReader();
    reader.onload = () => {
      const parsed = parseWatchlistImportAny(String(reader.result || ""));
      if (parsed.kind === "error") { setImportFeedback(parsed.error); return; }
      const now = Date.now();
      if (scope === "all") {
        if (parsed.kind !== "multi") {
          setImportFeedback("Este arquivo contém uma única lista (sem servidores). Use \u201CApenas Este Servidor\u201D para importá-lo no servidor selecionado.");
          return;
        }
        const map: WatchedItemsByServer = { ...watchedByServer };
        let added = 0;
        let updated = 0;
        let serversTouched = 0;
        for (const [server, incoming] of Object.entries(parsed.servers)) {
          const result = mergeWatchedLists(map[server] || [], incoming, now);
          map[server] = result.merged;
          added += result.added;
          updated += result.updated;
          serversTouched += 1;
        }
        persistAllServerItems(map);
        setImportFeedback(`Importação concluída (${serversTouched} servidor(es)): ${added} novo(s), ${updated} atualizado(s).`);
        return;
      }
      // Escopo "current": somente a lista do servidor selecionado muda.
      const incoming = parsed.kind === "multi"
        ? getServerWatchedItems(parsed.servers, selectedServer)
        : parsed.items;
      if (incoming.length === 0) {
        setImportFeedback(`O arquivo não contém itens para ${selectedServer}.`);
        return;
      }
      const { merged, added, updated } = mergeWatchedLists(watchedItems, incoming, now);
      persistItems(merged);
      setImportFeedback(`Importação concluída em ${selectedServer}: ${added} novo(s), ${updated} atualizado(s).`);
    };
    reader.onerror = () => setImportFeedback("Não foi possível ler o arquivo.");
    reader.readAsText(file);
  }

  // Total de itens cadastrados somando TODAS as listas por servidor —
  // usado no gate da consulta e no contador do botão "Lista de Itens".
  const totalWatchedCount = useMemo(
    () => Object.values(watchedByServer).reduce((sum, list) => sum + list.length, 0),
    [watchedByServer],
  );

  // ── Consulta ───────────────────────────────────────────────────────────────
  function requestItemsQuery() {
    if (!isBossUser) { setError("Apenas usuários Boss podem consultar itens no Bazaar."); return; }
    if (!isElectron) { setError("A consulta de itens precisa ser executada no aplicativo Desktop (Electron)."); return; }
    if (totalWatchedCount === 0) { setError("Cadastre pelo menos um item na Lista de Itens antes de consultar."); return; }
    if (!endUntil || !parseDateTimeLocalWithOffset(endUntil, timezoneOffsetMinutes)) {
      setError("Informe o filtro de data (Encerra até) antes de consultar.");
      return;
    }
    setError(null);
    setIsBrowserModalOpen(true);
  }

  async function requestStop() {
    if (!isElectron) return;
    try {
      const { ipcRenderer } = (window as any).require("electron");
      await ipcRenderer.invoke("rubinot-bazaar-request-stop");
      setStatusText("Encerramento solicitado — aguardando o personagem atual...");
    } catch {}
  }

  async function executeItemsQuery(options: {
    browserKey: string;
    browserOrder: string[];
    cleanProfile: boolean;
    retryBrowsers: string[];
    speedMode: BazaarSpeedMode;
    retryCounts: BazaarRetryCounts;
  }) {
    // Reconferência do gate: o painel nunca deveria estar montado sem Boss,
    // mas a restrição é REAL, não apenas visual.
    if (!isBossUser || !isElectron || isRunning) return;

    const endLimit = parseDateTimeLocalWithOffset(endUntil, timezoneOffsetMinutes);
    if (!endLimit) { setError("Filtro de data inválido."); return; }

    const startedAt = Date.now();
    setIsRunning(true);
    setError(null);
    setStatusText("Consultando a listagem do Bazaar...");
    setProgress(null);

    try {
      const { ipcRenderer } = (window as any).require("electron");

      // Etapa 1 — listagem (mesma infraestrutura das quests, com early-stop
      // pela data: a API ordena por encerramento crescente).
      const response = await ipcRenderer.invoke("rubinot-bazaar-fetch", {
        browser: options.browserKey || loadUIState(BAZAAR_BROWSER_KEY, "webkit"),
        endUntilTs: endLimit,
        cleanProfile: options.cleanProfile === true,
        speedMode: options.speedMode || loadUIState<BazaarSpeedMode>(BAZAAR_SPEED_MODE_KEY, "moderado"),
        browserOrder: options.browserOrder || loadUIState<string[]>(BAZAAR_BROWSER_ORDER_KEY, DEFAULT_BROWSER_ORDER),
        retryBrowsers: options.retryBrowsers || loadUIState<string[]>(BAZAAR_RETRY_BROWSERS_KEY, []),
        retryCounts: options.retryCounts || normalizeRetryCounts(loadUIState<BazaarRetryCounts | null>(BAZAAR_RETRY_COUNTS_KEY, null)),
      }) as ItemsFetchResult;

      if (!response?.ok || response?.cancelled) {
        setError(response?.error || "Não foi possível consultar o Bazaar do Rubinot.");
        return;
      }

      const listed = Array.isArray(response.auctions) ? response.auctions : [];

      // Etapa 2 — FILTRO DE DATA antes da fase individual: só personagens que
      // encerram até o limite seguem para a análise de itens.
      const nowUnixTs = Math.floor(Date.now() / 1000);
      const eligible = listed.filter(auction => {
        const endTs = normalizeAuctionEndTimestamp(auction.auctionEndTs);
        if (!endTs) return false;
        if (endTs <= nowUnixTs) return false;
        return endTs <= endLimit;
      });

      if (eligible.length === 0) {
        const summary: BazaarItemsLastQuery = {
          completedAtMs: Date.now(),
          durationMs: Date.now() - startedAt,
          listedCount: listed.length,
          eligibleCount: 0,
          analyzedCount: 0,
          failedCount: 0,
          stoppedManually: false,
          endUntilLabel: endUntil,
          results: [],
        };
        saveItemsLastQuery(summary);
        setLastQuery(summary);
        setStatusText("");
        return;
      }

      // Etapa 3 — itens por API JSON (canal exclusivo, sem método antigo).
      // Os watchKeys são a UNIÃO dos itens de TODOS os servidores: a consulta
      // ENCONTRA os itens normalmente (script inalterado); o preço aplicado
      // na etapa 4 é sempre o da lista do servidor do personagem.
      setStatusText(`Analisando itens de ${eligible.length} personagem(ns) elegível(is)...`);
      const watchKeys = collectAllWatchKeys(watchedByServer);
      const detailsResponse = await ipcRenderer.invoke("rubinot-bazaar-items-v2", eligible, { watchKeys }) as ItemsDetailsResult;

      if (!detailsResponse?.ok) {
        setError(detailsResponse?.error || "Não foi possível analisar os itens dos personagens.");
        return;
      }

      // Etapa 4 — casamento com a Lista de Itens DO SERVIDOR do personagem.
      // Um índice por servidor (cache local): item sem preço na lista do
      // servidor do personagem NÃO é contabilizado — sem fallback de preço
      // de outro servidor.
      const indexByServer = new Map<string, Map<string, WatchedItem>>();
      const getServerIndex = (server: string) => {
        const serverKey = canonicalServerKey(server);
        let index = indexByServer.get(serverKey);
        if (!index) {
          index = buildWatchlistIndex(getServerWatchedItems(watchedByServer, serverKey));
          indexByServer.set(serverKey, index);
        }
        return index;
      };
      const results: BazaarItemsCharacterResult[] = [];
      for (const auction of eligible) {
        const key = auction.id || auction.name || auction.url;
        const detail = key ? detailsResponse.details?.[key] : null;
        if (!detail || detail.error || !Array.isArray(detail.matches) || detail.matches.length === 0) continue;
        const { matches, totalKk } = buildCharacterMatches(detail.matches, getServerIndex(String(auction.server || "")));
        if (matches.length === 0) continue;
        results.push({
          id: String(auction.id || ""),
          name: String(auction.name || ""),
          url: String(auction.url || ""),
          level: Number(auction.level || 0),
          vocation: String(auction.vocation || ""),
          server: String(auction.server || ""),
          matches,
          totalKk,
          // Dados de EXIBIÇÃO da listagem no momento da consulta (valor do
          // personagem e encerramento) — nenhum efeito no cálculo dos itens.
          bid: Number(auction.bid || 0),
          auctionEndTs: auction.auctionEndTs ?? null,
        });
      }
      results.sort((a, b) => b.totalKk - a.totalKk);

      const summary: BazaarItemsLastQuery = {
        completedAtMs: Date.now(),
        durationMs: Date.now() - startedAt,
        listedCount: listed.length,
        eligibleCount: eligible.length,
        analyzedCount: Number(detailsResponse.analyzedCount || 0),
        failedCount: Number(detailsResponse.failedCount || 0),
        stoppedManually: detailsResponse.stoppedManually === true,
        endUntilLabel: endUntil,
        results,
      };
      saveItemsLastQuery(summary);
      setLastQuery(summary);
      setStatusText("");
    } catch (err) {
      setError(String((err as Error)?.message || err));
    } finally {
      setIsRunning(false);
      setProgress(null);
      setStatusText("");
    }
  }

  /**
   * ATUALIZAR VALORES — MESMA função/comportamento/lógica das QUESTS
   * (handleRefreshValues do BazarPanel), aplicada à lista LOCAL de itens:
   *
   *   • relê SOMENTE a listagem do Bazaar (`rubinot-bazaar-fetch`, mesma
   *     infraestrutura/fila/navegador; SEM nova análise de itens);
   *   • cruza com os personagens da última consulta usando os MESMOS
   *     helpers puros das quests (buildValueOverlay/applyValueOverlay);
   *   • atualiza os valores (bid) apenas dos leilões reencontrados;
   *     não reencontrados (encerrados) mantêm os valores originais;
   *   • persiste no próprio lastQuery local (este modo é 100% local — o
   *     análogo do overlay por versão das quests; NADA no Firestore).
   *
   * Itens/Tier/KK/RC NÃO são retocados: só o valor do personagem.
   */
  async function handleRefreshItemValues() {
    if (!isBossUser) { setError("Apenas usuários Boss podem atualizar os valores do Bazaar."); return; }
    if (!isElectron) { setError("A atualização de valores precisa ser executada no aplicativo Desktop (Electron)."); return; }
    if (isRunning || isValueRefreshing) return;
    const current = lastQuery;
    if (!current || current.results.length === 0) {
      setError("Não há consulta de itens carregada para atualizar valores.");
      return;
    }
    setError(null);
    setIsValueRefreshing(true);
    setValueRefreshStatus("Relendo a listagem do Bazaar...");
    try {
      const { ipcRenderer } = (window as any).require("electron");
      // Parada antecipada — mesma otimização das quests: a listagem é
      // ordenada por encerramento; o maior encerramento da lista local
      // (+ folga de 5 min) cobre todos os personagens que interessam.
      let maxEndTs = 0;
      current.results.forEach(result => {
        const ts = normalizeAuctionEndTimestamp(result.auctionEndTs ?? null);
        if (ts && ts > maxEndTs) maxEndTs = ts;
      });
      const response = await ipcRenderer.invoke("rubinot-bazaar-fetch", {
        browser: loadUIState(BAZAAR_BROWSER_KEY, "webkit"),
        endUntilTs: maxEndTs > 0 ? maxEndTs + 5 * 60 : 0,
        cleanProfile: false,
        speedMode: loadUIState<BazaarSpeedMode>(BAZAAR_SPEED_MODE_KEY, "moderado"),
        browserOrder: loadUIState<string[]>(BAZAAR_BROWSER_ORDER_KEY, DEFAULT_BROWSER_ORDER),
        retryBrowsers: loadUIState<string[]>(BAZAAR_RETRY_BROWSERS_KEY, []),
        retryCounts: normalizeRetryCounts(loadUIState<BazaarRetryCounts | null>(BAZAAR_RETRY_COUNTS_KEY, null)),
        autoRun: false,
      }) as ItemsFetchResult;
      if (!response?.ok || response?.cancelled || !Array.isArray(response.auctions)) {
        setError(response?.error || "Não foi possível reler a listagem do Bazaar. Os valores atuais foram mantidos.");
        return;
      }

      // MESMOS helpers das quests: overlay {auctionKey → novo bid} apenas
      // dos personagens reencontrados; aplicação devolve novos objetos só
      // onde houve mudança.
      const { values, matchedCount } = buildValueOverlay(current.results, response.auctions);
      const updatedResults = applyValueOverlay(current.results, values);
      const updated: BazaarItemsLastQuery = { ...current, results: updatedResults };
      saveItemsLastQuery(updated);
      setLastQuery(updated);
      setValueRefreshStatus(`Valores atualizados localmente: ${matchedCount} de ${current.results.length} leilões reencontrados.`);
    } catch (err) {
      setError(String((err as Error)?.message || err) || "Erro ao atualizar os valores do Bazaar.");
    } finally {
      await closeRubinotBrowserFromRenderer("atualizar-valores-itens-finalizado");
      setIsValueRefreshing(false);
    }
  }

  /**
   * CORREÇÃO MANUAL do "Valor Itens (KK)": grava `manualTotalKk` no
   * personagem dentro do lastQuery local (persistido). O total calculado
   * (`totalKk`) NUNCA é tocado — valor vazio/zero REMOVE a correção e o
   * personagem volta ao automático. RC/filtros/ordenação usam o efetivo.
   */
  function applyManualKk(auctionKey: string, rawValue: string) {
    if (!lastQuery) return;
    const clean = rawValue.trim();
    const manual = clean === "" ? null : Number(clean);
    if (manual !== null && (!Number.isSafeInteger(manual) || manual < 0)) return;
    const updated: BazaarItemsLastQuery = {
      ...lastQuery,
      results: lastQuery.results.map(result => {
        const key = result.id || result.url || result.name;
        if (key !== auctionKey) return result;
        return { ...result, manualTotalKk: manual && manual > 0 ? manual : null };
      }),
    };
    saveItemsLastQuery(updated);
    setLastQuery(updated);
    setKkEdit(null);
  }

  /**
   * EDIÇÃO PELO MODAL "DETALHES": salva o novo valor BASE do item na Lista
   * de Itens do SERVIDOR do personagem visualizado (MESMA fonte de preço do
   * modal Lista de Itens — nenhuma tabela paralela) e reprecifica na hora os
   * personagens DESSE servidor na última consulta (Tier +20%/nível e RC
   * derivam normalmente do novo valor). Outros servidores não mudam.
   */
  function saveDetailEdit() {
    if (!detailResult || !detailEdit) return;
    const match = detailResult.matches[detailEdit.matchIndex];
    if (!match) { setDetailEdit(null); return; }
    const rawValue = detailEdit.value.trim();
    if (!/^\d+$/.test(rawValue)) { setDetailEditError("Informe o valor em kk usando somente números inteiros."); return; }
    const valueKk = Number(rawValue);
    if (!Number.isSafeInteger(valueKk) || valueKk <= 0) { setDetailEditError("Informe o valor em kk (inteiro, maior que zero)."); return; }

    const server = String(detailResult.server || "");
    const serverKey = canonicalServerKey(server);
    const nameKey = normalizeWatchedItemName(match.watchedName);
    const now = Date.now();

    // 1) Fonte oficial: a Lista de Itens DO SERVIDOR do personagem. Item já
    //    listado tem o valor atualizado (data só muda se o valor mudou);
    //    item ainda sem preço neste servidor é ADICIONADO à lista dele.
    const serverItems = getServerWatchedItems(watchedByServer, serverKey);
    const existingIndex = serverItems.findIndex(item => normalizeWatchedItemName(item.name) === nameKey);
    let nextServerItems: WatchedItem[];
    if (existingIndex >= 0) {
      nextServerItems = serverItems.map((item, index) => {
        if (index !== existingIndex) return item;
        const valueChanged = item.valueKk !== valueKk;
        return { ...item, valueKk, updatedAtMs: valueChanged ? now : item.updatedAtMs };
      });
    } else {
      nextServerItems = [
        ...serverItems,
        { id: `wi_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`, name: match.watchedName, valueKk, updatedAtMs: now },
      ];
    }
    persistServerItems(serverKey, nextServerItems);

    // 2) Reprecifica a última consulta SOMENTE para personagens deste
    //    servidor (correções manuais de KK permanecem intactas).
    if (lastQuery) {
      const repricedResults = repriceQueryResultsForServerItem(lastQuery.results, serverKey, match.watchedName, valueKk);
      const updated: BazaarItemsLastQuery = { ...lastQuery, results: repricedResults };
      saveItemsLastQuery(updated);
      setLastQuery(updated);
      // Mantém o modal aberto já com os números novos do personagem.
      const detailKey = detailResult.id || detailResult.url || detailResult.name;
      const refreshed = repricedResults.find(result => (result.id || result.url || result.name) === detailKey);
      if (refreshed) setDetailResult(refreshed);
    }
    setDetailEdit(null);
    setDetailEditError(null);
  }

  // ── Derivados de exibição ──────────────────────────────────────────────────
  const filteredItems = itemsSearch.trim()
    ? watchedItems.filter(item => normalizeWatchedItemName(item.name).includes(normalizeWatchedItemName(itemsSearch)))
    : watchedItems;

  const results = lastQuery?.results || [];

  // ── "Pesquisar Item" — filtro LOCAL sobre os resultados já obtidos ────────
  // Derivado puro: filtra a lista em memória a cada digitação, sem nova
  // consulta ao Bazaar, sem Firestore e sem tocar nos dados persistidos
  // (lastQuery permanece intacto). Pesquisa parcial e sem distinção de
  // caixa/acentos — mesma normalização do casamento de itens
  // (normalizeWatchedItemName). Compara com o nome ENCONTRADO no personagem
  // (foundName, ex.: "Falcon Coif [Tier 3]") e com o nome monitorado
  // (watchedName) — qualquer um dos dois casa.
  const resultsSearchTerm = normalizeWatchedItemName(resultsSearch);
  const visibleResults = resultsSearchTerm
    ? results.filter(result => (result.matches || []).some(match =>
        normalizeWatchedItemName(match.foundName).includes(resultsSearchTerm)
        || normalizeWatchedItemName(match.watchedName).includes(resultsSearchTerm)))
    : results;

  // ── Filtros de coluna + ordenação — MESMA lógica de filteredAuctions das
  // QUESTS, adaptada às colunas desta tabela. Composta SOBRE o "Pesquisar
  // Item" (visibleResults): os dois convivem, como múltiplos filtros nas
  // quests. Derivado puro — resultados originais/persistidos intactos.
  const serverOptions = useMemo(() => {
    const set = new Set<string>();
    results.forEach(result => { if (result.server) set.add(result.server); });
    return Array.from(set).sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [results]);

  const filteredResults = useMemo(() => {
    const tableEndLimit = tableFilters.endUntil ? parseDateTimeLocalWithOffset(tableFilters.endUntil, timezoneOffsetMinutes) : 0;
    const filtered = visibleResults.filter(result => {
      // "Ocultar encerrados" — MESMA regra das quests (carência de 5 min).
      if (hideEndedResults && !isAuctionVisibleWithEndedGrace(result, currentUnixTs)) return false;
      if (tableFilters.name.trim() && !result.name.toLowerCase().includes(tableFilters.name.trim().toLowerCase())) return false;
      if (tableFilters.servers.length > 0 && !tableFilters.servers.includes(result.server)) return false;
      const bid = Number(result.bid || 0);
      if (tableFilters.bidValue !== null) {
        if (tableFilters.bidOperator === "gte" && bid < tableFilters.bidValue) return false;
        if (tableFilters.bidOperator === "lte" && bid > tableFilters.bidValue) return false;
      }
      // Filtros de KK/RC usam o valor EFETIVO: correção manual > calculado.
      const kk = effectiveTotalKk(result);
      if (tableFilters.kkValue !== null) {
        if (tableFilters.kkOperator === "gte" && kk < tableFilters.kkValue) return false;
        if (tableFilters.kkOperator === "lte" && kk > tableFilters.kkValue) return false;
      }
      if (tableFilters.rcValue !== null) {
        // RC depende da cotação atual do coin — sem cotação não há valor de
        // RC exibido (coluna mostra "—"), então o filtro não elimina nada.
        if (coinRate > 0) {
          const rc = computeItemRC(coinRate, kk);
          if (tableFilters.rcOperator === "gte" && rc < tableFilters.rcValue) return false;
          if (tableFilters.rcOperator === "lte" && rc > tableFilters.rcValue) return false;
        }
      }
      if (tableFilters.onlyMyInterests) {
        const auctionKey = result.id || result.url || result.name;
        if (!itemInterests.includes(auctionKey)) return false;
      }
      const auctionEndTs = normalizeAuctionEndTimestamp(result.auctionEndTs ?? null);
      if (tableEndLimit > 0 && auctionEndTs && auctionEndTs > tableEndLimit) return false;
      return true;
    });

    // ORDENAÇÃO — MESMO comportamento da guia de QUESTS: a coluna ativa é o
    // ÚNICO critério (strings por localeCompare pt-BR, números por
    // subtração; asc/desc pela direção escolhida). "Encerra" continua sendo
    // a ordenação PADRÃO na abertura do painel (sortKey inicial), mas clicar
    // em outra coluna passa a ordenar EXCLUSIVAMENTE por ela — a prioridade
    // permanente de "Encerra" foi removida a pedido.
    const sorted = [...filtered];
    const endTsOf = (r: BazaarItemsCharacterResult) => normalizeAuctionEndTimestamp(r.auctionEndTs ?? null) || 0;
    sorted.sort((a, b) => {
      if (sortKey === "auctionEndTs") {
        const endCmp = endTsOf(a) - endTsOf(b);
        return sortDir === "asc" ? endCmp : -endCmp;
      }
      let av: string | number;
      let bv: string | number;
      if (sortKey === "rc") {
        av = coinRate > 0 ? computeItemRC(coinRate, effectiveTotalKk(a)) : 0;
        bv = coinRate > 0 ? computeItemRC(coinRate, effectiveTotalKk(b)) : 0;
      } else if (sortKey === "potential") {
        // Ordena pelo VALOR NUMÉRICO real do percentual, nunca pela cor.
        // Sem percentual (cotação/valor ausente), empata no fundo:
        // sentinela finita — evita o NaN de (-Inf) − (-Inf) no comparador.
        av = potentialPercent(a, coinRate) ?? -1e15;
        bv = potentialPercent(b, coinRate) ?? -1e15;
      } else if (sortKey === "totalKk") {
        av = effectiveTotalKk(a);
        bv = effectiveTotalKk(b);
      } else {
        av = a[sortKey] ?? 0;
        bv = b[sortKey] ?? 0;
      }
      let cmp = 0;
      if (typeof av === "string" || typeof bv === "string") {
        cmp = String(av).localeCompare(String(bv), "pt-BR");
      } else {
        cmp = Number(av || 0) - Number(bv || 0);
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [visibleResults, tableFilters, sortKey, sortDir, coinRate, itemInterests, timezoneOffsetMinutes, hideEndedResults, currentUnixTs]);

  const hasActiveTableFilters = !!(
    tableFilters.name.trim() ||
    tableFilters.servers.length > 0 ||
    tableFilters.bidValue !== null ||
    tableFilters.kkValue !== null ||
    tableFilters.rcValue !== null ||
    !!tableFilters.endUntil ||
    tableFilters.onlyMyInterests
  );

  /** Cabeçalho ordenável — mesmo componente/visual/comportamento do
   *  SortHeader das quests: a seta âmbar indica APENAS a coluna ativa (o
   *  único critério de ordenação). "Encerra" é só o padrão inicial — clicar
   *  em outra coluna transfere a ordenação exclusivamente para ela.
   *  `align="left"` — EXCLUSIVO da coluna "Personagem", a única da tabela
   *  alinhada à esquerda (cabeçalho, filtro e células); as demais seguem
   *  centralizadas. `title` permite tooltip explicativo (ex.: Potencial). */
  function SortHeader({ label, column, align = "center", title }: { label: string; column: ItemsSortKey; align?: "center" | "left"; title?: string }) {
    const isActive = sortKey === column;
    const isLeft = align === "left";
    return (
      <th
        className={`${STICKY_HEAD_CELL_CLASS} h-10 py-2 align-middle cursor-pointer select-none ${isLeft ? "px-2 text-left" : "px-1 text-center"}`}
        onClick={() => toggleSort(column)}
        title={title}
      >
        <span className={`inline-flex w-full items-center gap-1 leading-none ${isLeft ? "justify-start" : "justify-center"}`}>
          {label}
          <ArrowDownUp size={10} className={isActive ? "text-amber-400" : "text-slate-600"} />
        </span>
      </th>
    );
  }

  // ── Botões de ação do painel — canto superior DIREITO do cabeçalho ────────
  // Injetados via portal no cartão reservado pelo BazarPanel FORA do quadro
  // do título (mesma linha, espelho do seletor de painéis à esquerda).
  // Ordem exigida: "Consultar Bazaar" e depois "Lista de Itens". A lógica é
  // a MESMA de antes — apenas o encaixe mudou. Sem o contêiner (ex.:
  // montagem isolada), os botões caem no quadro "Última Consulta" — nunca
  // somem.
  const titleActions = (
    <>
      {isElectron && (isRunning ? (
        <button
          type="button"
          onClick={() => void requestStop()}
          className="inline-flex h-7 items-center gap-1 px-2.5 rounded-lg border border-rose-500/40 bg-rose-500/15 text-rose-300 text-[10px] font-black transition-all cursor-pointer hover:bg-rose-500/25"
          title="Encerra a consulta após o personagem atual. Os resultados já analisados são mantidos."
        >
          <Square size={11} /> Parar
        </button>
      ) : (
        <button
          type="button"
          onClick={requestItemsQuery}
          className="inline-flex h-7 items-center gap-1 px-2.5 rounded-lg bg-gradient-to-r from-fuchsia-700/80 to-fuchsia-600/80 hover:from-fuchsia-600 hover:to-fuchsia-500 border border-fuchsia-500/40 text-white text-[10px] font-black transition-all cursor-pointer shadow-md shadow-fuchsia-900/15"
        >
          <RefreshCw size={12} /> Consultar Bazaar
        </button>
      ))}
      <button
        type="button"
        onClick={() => { setIsItemsModalOpen(true); setImportFeedback(null); setScopePicker(null); cancelInlineEdit(); }}
        className="inline-flex h-7 items-center gap-1 px-2.5 rounded-lg border border-fuchsia-500/25 bg-fuchsia-500/10 text-fuchsia-300 text-[10px] font-black transition-all cursor-pointer hover:bg-fuchsia-500/20"
        title="Itens monitorados na consulta: nome e valor base em kk, por servidor"
      >
        <ListChecks size={12} /> Lista de Itens ({totalWatchedCount})
      </button>
    </>
  );

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-1.5 overflow-hidden">
      {/* Botões nas AÇÕES DO CABEÇALHO (canto superior direito, fora do
          quadro do título) — portal para o contêiner do BazarPanel. */}
      {titleActionsHost && createPortal(titleActions, titleActionsHost)}

      {error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300 flex items-center gap-2">
          <AlertTriangle size={15} /> {error}
        </div>
      )}

      {/* ── Chips "leilão encerrando" — MESMO visual/comportamento do painel
          de quests (sem "Abrir todos"/"Bidar todos", exclusivos das quests).
          Clique = abre o link com o MESMO registro compartilhado. */}
      {visibleItemsNotifications.length > 0 && (
        <div className="space-y-1">
          {visibleItemsNotifications.map(notification => {
            const notifAuctionKey = notification.auctionId || "";
            const notifLinkState = notifAuctionKey && getLinkState ? getLinkState(notifAuctionKey) : "open";
            return (
              <button
                key={notification.id}
                type="button"
                onClick={() => {
                  if (!notification.url) return;
                  if (openLink && notifAuctionKey) openLink(notifAuctionKey, notification.url);
                  else openExternalUrl(notification.url);
                }}
                className="w-full rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-left text-[11px] leading-tight text-amber-200 flex items-center justify-between gap-2 hover:bg-amber-500/20 transition-colors cursor-pointer"
                title={notifLinkState === "open" ? "Abrir personagem no Bazaar" : "Link já aberto neste dispositivo"}
              >
                <span className="inline-flex items-center gap-1.5 min-w-0">
                  <AlertTriangle size={12} className="flex-shrink-0" />
                  <strong className="truncate">{notification.title}</strong>
                  <span className="truncate text-amber-200/80">{notification.body}</span>
                </span>
                <span className="inline-flex flex-shrink-0 items-center gap-1">
                  {notifLinkState !== "open" && (
                    <span
                      className={`inline-flex items-center gap-0.5 rounded border px-1 py-0.5 text-[8px] font-black uppercase tracking-wide ${
                        notifLinkState === "last"
                          ? "border-amber-400/45 bg-amber-500/15 text-amber-200"
                          : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                      }`}
                    >
                      <Check size={9} strokeWidth={3} />{notifLinkState === "last" ? "Último aberto" : "Aberto"}
                    </span>
                  )}
                  <span className="text-[9px] font-black underline">Abrir</span>
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* ── Quadro "Última Consulta" do modo itens ─────────────────────────── */}
      <div className="rounded-lg border border-fuchsia-500/25 bg-[var(--th-n-base)]/85 px-2.5 py-1.5 text-[11px] text-slate-400 space-y-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <div className="inline-flex items-center gap-1.5 font-black text-fuchsia-300 uppercase tracking-wide">
            <Sparkles size={12} /> Última consulta
          </div>

          {/* Parâmetros da consulta, direto no quadro (sem "Filtros Consulta") */}
          <label className="inline-flex items-center gap-1 text-[10px]">
            <span className="font-bold text-slate-300">Encerra até</span>
            <input
              type="datetime-local"
              value={endUntil}
              onChange={event => setEndUntil(event.target.value)}
              disabled={isRunning}
              title={`Somente personagens cujo leilão encerra até este momento serão analisados (${formatTimeZoneOffset(timezoneOffsetMinutes)}). O filtro é aplicado ANTES da análise individual.`}
              className="h-7 rounded-md border border-[var(--th-line)]/70 bg-black/35 px-1.5 text-[10px] text-white outline-none focus:border-fuchsia-600/60 disabled:opacity-50"
            />
          </label>

          <label className="inline-flex items-center gap-1 text-[10px]" title="Cotação do Rubini Coin no Market: quantos k equivalem a 1000 RC. Mesma regra de conversão usada no restante do aplicativo.">
            <Coins size={11} className="text-amber-300" />
            <span className="font-bold text-slate-300">Coin (k)</span>
            <input
              type="text"
              inputMode="decimal"
              value={coinRateText}
              onChange={event => {
                setCoinRateText(event.target.value);
                saveItemsCoinRate(parseCoinRate(event.target.value));
              }}
              placeholder="90"
              className="h-7 w-16 rounded-md border border-[var(--th-line)]/70 bg-black/35 px-1.5 text-[10px] text-white outline-none focus:border-fuchsia-600/60"
            />
          </label>

          {/* ── Pesquisar Item — filtro LOCAL da lista de personagens ─────
              Filtra dinamicamente sobre os resultados JÁ obtidos (pesquisa
              parcial, sem distinção de caixa/acentos). Nunca dispara nova
              consulta nem altera os dados persistidos; campo vazio = todos
              os personagens de volta. */}
          <label className="relative inline-flex items-center gap-1 text-[10px]" title="Filtra os personagens da última consulta: somente quem possui o item pesquisado entre os itens encontrados. Pesquisa local — não refaz a consulta.">
            <Search size={11} className="absolute left-1.5 text-slate-500 pointer-events-none" />
            <input
              type="text"
              value={resultsSearch}
              onChange={event => setResultsSearch(event.target.value)}
              placeholder="Pesquisar item..."
              className="h-7 w-40 rounded-md border border-[var(--th-line)]/70 bg-black/35 pl-6 pr-6 text-[10px] text-white outline-none focus:border-fuchsia-600/60 placeholder:text-slate-600"
            />
            {resultsSearch && (
              <button
                type="button"
                onClick={() => setResultsSearch("")}
                className="absolute right-1 p-0.5 rounded text-slate-500 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
                title="Limpar pesquisa"
              >
                <X size={11} />
              </button>
            )}
          </label>
          {resultsSearchTerm && (
            <span className="text-[9px] font-bold text-fuchsia-300">
              {visibleResults.length} de {results.length} {results.length === 1 ? "personagem" : "personagens"}
            </span>
          )}

          {/* OCULTAR ENCERRADOS / EXIBIR TODOS — mesmo botão das quests
              (mesmo visual/alternância/carência de 5 min), aplicado à lista
              local de itens. Preferência persistida por dispositivo. */}
          <button
            type="button"
            onClick={() => setHideEndedResults(prev => !prev)}
            className={`inline-flex h-7 items-center gap-1 rounded-md border px-2.5 text-[10px] font-black transition-colors cursor-pointer ${hideEndedResults ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20" : "border-amber-500/25 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20"}`}
            title={hideEndedResults ? "Mostrar também leilões encerrados" : "Ocultar leilões encerrados"}
          >
            {hideEndedResults ? "Ocultar encerrados" : "Exibir todos"}
          </button>

          {/* ATUALIZAR VALORES — mesma função das quests: relê SÓ a listagem
              do Bazaar e atualiza os valores dos leilões APENAS localmente
              (nenhuma nova análise de itens; nada no Firestore). */}
          {isElectron && isBossUser && (
            <button
              type="button"
              onClick={() => { void handleRefreshItemValues(); }}
              disabled={isValueRefreshing || isRunning}
              className="inline-flex h-7 items-center justify-center gap-1 rounded-md border border-sky-500/30 bg-sky-500/10 px-2.5 text-[10px] font-black text-sky-300 hover:bg-sky-500/20 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              title="Relê a listagem do Bazaar e atualiza os valores dos leilões da última consulta apenas neste dispositivo"
            >
              {isValueRefreshing && <RefreshCw size={11} className="animate-spin" />}
              {isValueRefreshing ? "Atualizando..." : "Atualizar Valores"}
            </button>
          )}
          {valueRefreshStatus && (
            <span className="max-w-[260px] text-[8px] font-bold leading-tight text-sky-300/80" role="status">
              {valueRefreshStatus}
            </span>
          )}

          {/* Fallback: sem o contêiner do título (montagem isolada), os
              botões permanecem aqui — o comportamento nunca se perde. */}
          {!titleActionsHost && (
            <div className="ml-auto flex items-center gap-1.5">
              {titleActions}
            </div>
          )}
        </div>

        {/* Resumo da última execução (persistido localmente) */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] leading-tight">
          {lastQuery ? (
            <>
              <span>Concluída: <span className="font-mono text-slate-200">{formatDateTimeWithOffset(lastQuery.completedAtMs, timezoneOffsetMinutes)}</span></span>
              <span>Duração: <span className="font-mono text-slate-200">{formatDuration(lastQuery.durationMs)}</span></span>
              <span>Listados: <span className="font-mono text-slate-200">{lastQuery.listedCount}</span></span>
              <span>Elegíveis (data): <span className="font-mono text-slate-200">{lastQuery.eligibleCount}</span></span>
              <span>Analisados: <span className="font-mono text-slate-200">{lastQuery.analyzedCount}</span></span>
              <span>Com itens: <span className="font-mono text-fuchsia-200">{lastQuery.results.length}</span></span>
              {lastQuery.failedCount > 0 && (
                <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 border border-rose-500/40 bg-rose-500/10 font-bold text-rose-300">
                  <AlertTriangle size={10} /> Falhas: <span className="font-mono">{lastQuery.failedCount}</span>
                </span>
              )}
              {lastQuery.stoppedManually && (
                <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 border border-amber-500/40 bg-amber-500/10 font-bold text-amber-300">
                  <FlagTriangleRight size={10} /> Encerrada manualmente
                </span>
              )}
            </>
          ) : (
            <span className="text-slate-500">Nenhuma consulta de itens realizada neste dispositivo.</span>
          )}
        </div>

        {/* Progresso ao vivo — apenas enquanto ESTA consulta roda */}
        {isRunning && (
          <div className="space-y-0.5">
            <div className="flex items-center gap-2 text-[10px] text-fuchsia-200">
              <RefreshCw size={11} className="animate-spin" />
              <span className="truncate">{progress?.message || statusText || "Consultando..."}</span>
              {(progress?.total || 0) > 0 && (
                <span className="font-mono flex-shrink-0">{progress?.processed}/{progress?.total}</span>
              )}
            </div>
            {(progress?.total || 0) > 0 && (
              <div className="h-1 rounded bg-black/40 overflow-hidden">
                <div className="h-full bg-gradient-to-r from-fuchsia-600 to-fuchsia-400 transition-all" style={{ width: `${progress?.percent || 0}%` }} />
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Resultados compactos ────────────────────────────────────────────── */}
      {/* A tabela exibe `visibleResults` — o derivado do "Pesquisar Item".
          Sem pesquisa, visibleResults === results (todos os personagens). */}
      <div className="flex-1 min-h-0 overflow-auto custom-scrollbar rounded-lg border border-[var(--th-line)]/60 bg-[var(--th-n-base)]/80">
        {visibleResults.length === 0 ? (
          <div className="h-full flex items-center justify-center p-6">
            <div className="text-center space-y-2 max-w-md">
              <Package size={28} className="mx-auto text-fuchsia-400/60" />
              <p className="text-xs text-slate-400 leading-relaxed">
                {resultsSearchTerm && results.length > 0
                  ? `Nenhum personagem da última consulta possui um item com \u201C${resultsSearch.trim()}\u201D. Limpe a pesquisa para ver todos.`
                  : lastQuery
                    ? "Nenhum personagem da última consulta possui itens da sua Lista de Itens."
                    : "Cadastre os itens desejados em \u201CLista de Itens\u201D, ajuste a data e a cotação do coin e clique em \u201CConsultar Bazaar\u201D."}
              </p>
            </div>
          </div>
        ) : (
          <table className="w-full text-[11px]">
            {/* Cabeçalho em DUAS linhas fixas — MESMO padrão da tabela de
                quests: linha 1 = títulos ordenáveis (SortHeader, seta âmbar
                na coluna ativa), linha 2 = filtros por coluna (mesmos
                componentes de FilterTypes). Classes sticky compartilhadas
                com o BazarPanel — fonte única de estilo. */}
            <thead className="text-[10px] uppercase tracking-wider text-slate-400">
              <tr>
                {/* "Personagem" é a ÚNICA coluna alinhada à esquerda
                    (cabeçalho, filtro e células) — todas as demais seguem
                    a regra de centralização da tabela. */}
                <SortHeader label="Personagem" column="name" align="left" />
                <SortHeader label="Servidor" column="server" />
                <SortHeader label="Encerra" column="auctionEndTs" />
                <SortHeader label="Valor" column="bid" />
                <SortHeader label="Valor Itens (KK)" column="totalKk" />
                <SortHeader label="Valor Itens (RC)" column="rc" />
                <SortHeader label="Potencial" column="potential" title="Percentual da oportunidade: (Valor Itens efetivo − valor do personagem) ÷ valor do personagem, na mesma unidade (kk, pela cotação do coin). Positivo (verde) = itens valem mais que o preço; negativo (vermelho) = personagem custa mais que os itens." />
                <th className={`${STICKY_HEAD_CELL_CLASS} h-10 px-1 py-2 text-center align-middle leading-none`}>Detalhes</th>
                <th className={`${STICKY_HEAD_CELL_CLASS} h-10 px-1 py-2 text-center align-middle leading-none`}>Tenho Interesse</th>
                <th className={`${STICKY_HEAD_CELL_CLASS} h-10 px-1 py-2 text-center align-middle leading-none`}>Link</th>
              </tr>
              <tr className="h-10 normal-case tracking-normal">
                {/* Filtro da coluna Personagem — ALINHADO À ESQUERDA, como
                    todo o conteúdo da coluna (única exceção à centralização). */}
                <th className={`${STICKY_FILTER_CELL_CLASS} h-10 px-2 py-1.5 align-middle text-left`}>
                  <div className="flex w-full items-center justify-start gap-1">
                    <button
                      type="button"
                      onClick={resetTableFilters}
                      disabled={!hasActiveTableFilters}
                      className={`h-6 w-6 flex-shrink-0 rounded flex items-center justify-center transition-all ${
                        hasActiveTableFilters
                          ? "bg-amber-500 text-black font-bold shadow-sm shadow-amber-500/20 animate-pulse cursor-pointer"
                          : "bg-white/5 text-slate-600 cursor-default"
                      }`}
                      title="Limpar todos os filtros"
                    >
                      <RotateCcw size={11} />
                    </button>
                    <div className="flex min-w-0 flex-1 items-center justify-start [&>div]:w-full [&>div]:max-w-[112px]"><FilterInline value={tableFilters.name} onChange={value => updateTableFilters({ name: value })} placeholder="Personagem" maxWidth="100%" /></div>
                  </div>
                </th>
                <th className={`${STICKY_FILTER_CELL_CLASS} h-10 px-1 py-1.5 align-middle`}><div className="flex w-full items-center justify-center [&>button]:w-full [&>button]:max-w-[96px]"><FilterMulti label="Servidor" options={serverOptions} selected={tableFilters.servers} onApply={values => updateTableFilters({ servers: values })} placeholder="Servidor" searchable /></div></th>
                <th className={`${STICKY_FILTER_CELL_CLASS} h-10 px-1 py-1.5 align-middle`}><div className="flex w-full items-center justify-center [&>div]:w-full [&>div]:max-w-[122px]"><FilterDateMax label="Encerra até" value={tableFilters.endUntil} onChange={value => updateTableFilters({ endUntil: value })} placeholder="Encerra" /></div></th>
                <th className={`${STICKY_FILTER_CELL_CLASS} h-10 px-1 py-1.5 align-middle`}><div className="flex w-full items-center justify-center [&>button]:w-full [&>button]:max-w-[80px]"><FilterNumber label="Valor" value={tableFilters.bidValue} operator={tableFilters.bidOperator} onChange={(value, operator) => updateTableFilters({ bidValue: value, bidOperator: operator })} placeholder="Valor" /></div></th>
                <th className={`${STICKY_FILTER_CELL_CLASS} h-10 px-1 py-1.5 align-middle`}><div className="flex w-full items-center justify-center [&>button]:w-full [&>button]:max-w-[80px]"><FilterNumber label="Valor Itens (KK)" value={tableFilters.kkValue} operator={tableFilters.kkOperator} onChange={(value, operator) => updateTableFilters({ kkValue: value, kkOperator: operator })} placeholder="KK" /></div></th>
                <th className={`${STICKY_FILTER_CELL_CLASS} h-10 px-1 py-1.5 align-middle`}><div className="flex w-full items-center justify-center [&>button]:w-full [&>button]:max-w-[80px]"><FilterNumber label="Valor Itens (RC)" value={tableFilters.rcValue} operator={tableFilters.rcOperator} onChange={(value, operator) => updateTableFilters({ rcValue: value, rcOperator: operator })} placeholder="RC" /></div></th>
                {/* Potencial: sem filtro próprio (ordenação pelo cabeçalho). */}
                <th className={`${STICKY_FILTER_CELL_CLASS} h-10 px-1 py-1.5 text-center align-middle text-[10px] text-slate-600`}>—</th>
                <th className={`${STICKY_FILTER_CELL_CLASS} h-10 px-1 py-1.5 text-center align-middle text-[10px] text-slate-600`}>—</th>
                <th className={`${STICKY_FILTER_CELL_CLASS} h-10 px-1 py-1.5 text-center align-middle`}>
                  <button
                    type="button"
                    aria-label="Filtrar somente meus interesses"
                    aria-pressed={tableFilters.onlyMyInterests}
                    onClick={() => updateTableFilters({ onlyMyInterests: !tableFilters.onlyMyInterests })}
                    title={tableFilters.onlyMyInterests
                      ? "Exibindo somente os personagens em que você marcou interesse"
                      : "Exibir somente os personagens em que você marcou interesse"}
                    className={`inline-flex h-7 items-center justify-center gap-1 rounded-md border px-2 text-[10px] font-black transition-all cursor-pointer ${
                      tableFilters.onlyMyInterests
                        ? "border-cyan-400/55 bg-cyan-500/20 text-cyan-100 shadow-[0_0_12px_rgba(34,211,238,0.18)]"
                        : "border-white/10 bg-white/5 text-slate-400 hover:border-cyan-400/35 hover:bg-cyan-500/10 hover:text-cyan-200"
                    }`}
                  >
                    <Star size={11} fill={tableFilters.onlyMyInterests ? "currentColor" : "none"} />
                    <span>Meus</span>
                  </button>
                </th>
                <th className={`${STICKY_FILTER_CELL_CLASS} h-10 px-1 py-1.5 text-center align-middle`}>{hasActiveTableFilters && <button type="button" onClick={resetTableFilters} className="inline-flex h-7 items-center justify-center rounded border border-white/10 bg-white/5 px-2 text-[10px] text-slate-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer">Resetar</button>}</th>
              </tr>
            </thead>
            <tbody>
              {filteredResults.length === 0 && (
                // Estado vazio DENTRO da tabela — mesmo desenho das quests:
                // cabeçalho e linha de filtros seguem visíveis para que o
                // usuário não perca o acesso ao botão de limpar justamente
                // quando os filtros não retornam resultados.
                <tr>
                  <td colSpan={10} className="px-4 py-10 text-center align-middle text-sm text-slate-500">
                    <div className="flex flex-col items-center justify-center gap-3">
                      <span>Nenhum personagem encontrado para os filtros atuais.</span>
                      {hasActiveTableFilters && (
                        <button
                          type="button"
                          onClick={resetTableFilters}
                          className="inline-flex h-7 items-center justify-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 text-[10px] font-black text-amber-300 hover:bg-amber-500/20 transition-colors cursor-pointer"
                          title="Limpar todos os filtros"
                        >
                          <RotateCcw size={11} /> Limpar filtros
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              )}
              {filteredResults.map(result => {
                const auctionKey = result.id || result.url || result.name;
                const copyKey = `res_${auctionKey}`;
                // "Tenho Interesse" — estado 100% LOCAL (localStorage por uid).
                const isInterested = itemInterests.includes(auctionKey);
                // KK EFETIVO: correção manual (quando ativa) > calculado.
                // RC/exibição/badge derivam deste valor.
                const effectiveKk = effectiveTotalKk(result);
                const isManualKk = hasManualTotalKk(result);
                // POTENCIAL: percentual real ((itens − personagem) ÷
                // personagem) e diferença em kk para o tooltip. Recalculado
                // a cada render — correção manual do KK, edição de preço e
                // "Atualizar Valores" refletem na hora.
                const potentialPct = potentialPercent(result, coinRate);
                const potentialDiffKk = potentialScoreKk(result, coinRate);
                // Estado do link — MESMO mecanismo do painel de quests
                // (openedLinksState compartilhado via props).
                const linkState = getLinkState ? getLinkState(auctionKey) : "open";
                const linkButtonLabel = linkState === "last" ? "Último Aberto" : linkState === "opened" ? "Aberto" : "Abrir";
                const linkButtonClass = linkState === "last"
                  ? "border-amber-400/45 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25 shadow-[0_0_12px_color-mix(in_oklab,var(--color-amber-500)_16%,transparent)]"
                  : linkState === "opened"
                    ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/18"
                    : "border-amber-600/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20";
                return (
                <tr key={auctionKey} className="border-t border-[var(--th-line)]/40 hover:bg-white/[0.03]">
                  {/* CENTRALIZAÇÃO: todas as células da tabela são
                      text-center (cabeçalho, filtros e dados) — EXCETO a
                      coluna "Personagem", a ÚNICA alinhada à esquerda
                      (cabeçalho, filtro, nome, level e demais elementos). */}
                  <td className="px-2 py-1.5 text-left">
                    {/* Nome + level como botão de copiar — mesmo padrão visual
                        dos copiar de personagem do app (hover revela o ícone,
                        1,5s de "Copiado!"). Copia "Nome, Lv X". */}
                    <button
                      type="button"
                      onClick={() => copyText(copyKey, result.level ? `${result.name}, Lv ${result.level}` : result.name)}
                      className={`group inline-flex max-w-[220px] items-center justify-start gap-1 rounded px-1 py-0.5 font-bold transition-colors cursor-copy ${
                        copiedKey === copyKey ? "bg-emerald-500/20 text-emerald-300" : "text-slate-100 hover:bg-white/10 hover:text-white"
                      }`}
                      title={copiedKey === copyKey ? "Copiado" : `Copiar "${result.name}${result.level ? `, Lv ${result.level}` : ""}"`}
                    >
                      {copiedKey === copyKey ? (
                        <><Check size={11} className="flex-shrink-0 text-emerald-400" /><span>Copiado!</span></>
                      ) : (
                        <><span className="truncate">{result.name || "—"}</span><Copy size={10} className="flex-shrink-0 opacity-0 group-hover:opacity-70 transition-opacity" /></>
                      )}
                    </button>
                    <div className="text-[9px] text-slate-500 px-1 text-left">
                      {[result.vocation, result.level ? `Lv ${result.level}` : ""].filter(Boolean).join(" · ")}
                    </div>
                  </td>
                  <td className="px-2 py-1.5 text-center text-slate-300">{result.server || "—"}</td>
                  <td className="px-2 py-1.5 text-center font-mono text-slate-300">
                    {formatAuctionEnd(result.auctionEndTs ?? null, timezoneOffsetMinutes)}
                  </td>
                  <td className="px-2 py-1.5 text-center font-mono text-emerald-300" title="Valor do personagem no momento da consulta">
                    {Number.isFinite(result.bid) && (result.bid || 0) > 0 ? `${(result.bid || 0).toLocaleString("de-DE")} coins` : "—"}
                  </td>
                  <td className="px-2 py-1.5 text-center font-mono font-bold text-amber-200">
                    {/* VALOR ITENS (KK) — correção MANUAL tem prioridade sobre
                        o calculado. Em edição: input inline + ✓/✗ (Enter/Esc).
                        Fora dela: valor efetivo + lápis; quando manual, badge
                        "manual" (título mostra o calculado) + botão de reset
                        para voltar ao automático. */}
                    {kkEdit?.auctionKey === auctionKey ? (
                      <span className="inline-flex items-center justify-center gap-1">
                        <input
                          type="text"
                          inputMode="numeric"
                          autoFocus
                          value={kkEdit.value}
                          onChange={event => setKkEdit(prev => (prev ? { ...prev, value: event.target.value.replace(/\D+/g, "").slice(0, 9) } : prev))}
                          onKeyDown={event => {
                            if (event.key === "Enter") { event.preventDefault(); applyManualKk(auctionKey, kkEdit.value); }
                            if (event.key === "Escape") { event.preventDefault(); setKkEdit(null); }
                          }}
                          placeholder="kk"
                          title="Correção manual em kk inteiros. Vazio = volta ao valor calculado. Enter salva, Esc cancela."
                          className="h-6 w-16 rounded-md border border-fuchsia-500/60 bg-black/35 px-1.5 text-center font-mono text-[11px] text-amber-200 outline-none focus:border-fuchsia-400"
                        />
                        <button type="button" onClick={() => applyManualKk(auctionKey, kkEdit.value)} className="p-0.5 rounded text-emerald-300 hover:bg-emerald-500/15 transition-colors cursor-pointer" title="Salvar correção manual">
                          <Check size={12} strokeWidth={3} />
                        </button>
                        <button type="button" onClick={() => setKkEdit(null)} className="p-0.5 rounded text-slate-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer" title="Cancelar">
                          <X size={12} />
                        </button>
                      </span>
                    ) : (
                      <span className="inline-flex items-center justify-center gap-1">
                        <span title={isManualKk ? `Valor corrigido manualmente (calculado pela consulta: ${formatKkValue(result.totalKk, "kk")})` : "Valor calculado pela consulta"}>
                          {formatKkValue(effectiveKk, "kk")}
                        </span>
                        {isManualKk && (
                          <span className="rounded border border-fuchsia-500/40 bg-fuchsia-500/15 px-1 py-px text-[7px] font-black uppercase tracking-wide text-fuchsia-300" title={`Correção manual ativa (calculado: ${formatKkValue(result.totalKk, "kk")})`}>
                            manual
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => setKkEdit({ auctionKey, value: isManualKk ? String(effectiveKk) : "" })}
                          className="p-0.5 rounded text-sky-300 hover:bg-sky-500/15 transition-colors cursor-pointer"
                          title="Editar: corrigir manualmente o Valor Itens (KK) deste personagem (prioridade sobre o calculado; o RC passa a usar o valor corrigido)"
                        >
                          <Pencil size={11} />
                        </button>
                        {isManualKk && (
                          <button
                            type="button"
                            onClick={() => applyManualKk(auctionKey, "")}
                            className="p-0.5 rounded text-slate-500 hover:text-amber-300 hover:bg-amber-500/10 transition-colors cursor-pointer"
                            title={`Remover correção manual e voltar ao valor calculado (${formatKkValue(result.totalKk, "kk")})`}
                          >
                            <RotateCcw size={11} />
                          </button>
                        )}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-center font-mono font-bold text-emerald-300" title={isManualKk ? "RC calculado sobre o valor corrigido manualmente" : undefined}>
                    {coinRate > 0 ? computeItemRC(coinRate, effectiveKk).toLocaleString("de-DE") : "—"}
                  </td>
                  <td className="px-2 py-1.5 text-center">
                    {/* POTENCIAL — o PERCENTUAL é o destaque principal:
                        positivo (itens > personagem) em VERDE, negativo
                        (personagem > itens) em VERMELHO, com um ponto de
                        cor compacto como reforço visual. O tooltip traz a
                        conta completa (kk). Sem cotação do coin ou sem
                        valor do personagem não há percentual honesto →
                        "—" (dado indisponível), nunca um número enganoso. */}
                    {potentialPct !== null ? (
                      <span
                        aria-label={`Potencial: ${formatPotentialPercent(potentialPct)}`}
                        title={`Potencial: ${formatPotentialPercent(potentialPct)} — Valor Itens ${formatKkValue(effectiveKk, "kk")}${isManualKk ? " (manual)" : ""} vs personagem ${formatKkValue(bidValueKk(result, coinRate), "kk")}${potentialDiffKk !== null ? ` (diferença ${potentialDiffKk >= 0 ? "+" : "−"}${formatKkValue(Math.abs(potentialDiffKk), "kk")})` : ""}`}
                        className={`inline-flex items-center justify-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] font-black ${
                          potentialPct > 0
                            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                            : potentialPct < 0
                              ? "border-rose-500/30 bg-rose-500/10 text-rose-300"
                              : "border-slate-500/30 bg-slate-500/10 text-slate-300"
                        }`}
                      >
                        <span className={`inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full ${potentialPct > 0 ? "bg-emerald-400" : potentialPct < 0 ? "bg-rose-400" : "bg-slate-400"}`} />
                        {formatPotentialPercent(potentialPct)}
                      </span>
                    ) : (
                      <span
                        aria-label="Potencial indisponível"
                        title="Sem dados para calcular o potencial: informe a cotação do coin no quadro e verifique se o personagem tem valor de leilão."
                        className="font-mono text-[10px] font-bold text-slate-600"
                      >
                        —
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-center">
                    <button
                      type="button"
                      onClick={() => setDetailResult(result)}
                      className="inline-flex items-center gap-1 rounded border border-fuchsia-500/30 bg-fuchsia-500/10 px-1.5 py-0.5 text-[9px] font-black text-fuchsia-300 hover:bg-fuchsia-500/20 transition-colors cursor-pointer"
                    >
                      <Eye size={10} /> Ver
                    </button>
                  </td>
                  <td className="px-2 py-1.5 text-center">
                    {/* "Tenho Interesse" — MESMO padrão visual do botão das
                        quests (borda/fundo ciano, "Tenho interesse"/"Remover"),
                        com marcação visível quando ativo. Gravação SOMENTE
                        local — nada no Firestore. */}
                    <div className="flex flex-col items-center gap-0.5">
                      <button
                        type="button"
                        onClick={() => toggleItemInterest(auctionKey)}
                        className={`inline-flex items-center justify-center gap-1 rounded border px-2 py-1 text-[9px] font-black transition-colors cursor-pointer ${
                          isInterested
                            ? "border-cyan-400/45 bg-cyan-500/20 text-cyan-200 hover:bg-cyan-500/30"
                            : "border-cyan-500/25 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20 hover:text-cyan-200"
                        }`}
                        title={isInterested ? "Remover interesse (somente neste dispositivo)" : "Marcar interesse (somente neste dispositivo)"}
                      >
                        {isInterested ? "Remover" : "Tenho interesse"}
                      </button>
                      {isInterested && (
                        <span className="inline-flex items-center gap-0.5 text-[8px] font-black uppercase tracking-wide text-cyan-300">
                          <Check size={9} strokeWidth={3} /> Interessado
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-2 py-1.5 text-center">
                    {/* Botão Link — MESMO método/visual do painel de quests:
                        marca a abertura no openedLinksState compartilhado e
                        abre no navegador padrão via openExternal. */}
                    {result.url ? (
                      <button
                        type="button"
                        onClick={() => (openLink ? openLink(auctionKey, result.url) : openExternalUrl(result.url))}
                        title={linkState === "last" ? "Último personagem aberto" : linkState === "opened" ? "Este link já foi aberto neste dispositivo" : "Abrir personagem no Bazaar"}
                        className={`inline-flex h-7 max-w-full min-w-0 items-center justify-center gap-0.5 rounded-lg px-1.5 py-1 border text-[9px] font-black transition-colors cursor-pointer ${linkButtonClass}`}
                      >
                        <ExternalLink size={11} className="flex-shrink-0" /> <span className="truncate">{linkButtonLabel}</span>
                      </button>
                    ) : <span className="text-slate-600">—</span>}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Modal: Lista de Itens (CRUD + exportar/importar) ───────────────── */}
      {isItemsModalOpen && (
        <div className="app-modal-overlay fixed inset-0 z-[1200] flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="app-modal-frame w-full max-w-lg max-h-[88vh] flex flex-col rounded-xl border border-fuchsia-500/30 bg-[var(--th-bg-raised)] shadow-2xl shadow-black/60 overflow-hidden">
            <div className="flex-shrink-0 flex items-center justify-between gap-2 px-4 py-3 border-b border-[var(--th-line)]/40">
              <div className="flex items-center gap-2 min-w-0">
                <ListChecks size={16} className="text-fuchsia-400 flex-shrink-0" />
                <span className="text-sm font-bold text-fuchsia-300 uppercase tracking-wider truncate">Lista de Itens</span>
                <span className="text-[10px] text-slate-500 font-mono" title={`${watchedItems.length} item(ns) em ${selectedServer} · ${totalWatchedCount} no total (todos os servidores)`}>({watchedItems.length})</span>
              </div>
              <button type="button" onClick={() => setIsItemsModalOpen(false)} className="p-1 rounded text-slate-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer flex-shrink-0" title="Fechar">
                <X size={15} />
              </button>
            </div>

            {/* CABEÇALHO FIXO do corpo do modal: formulário de adicionar +
                pesquisa/exportar/importar ficam SEMPRE visíveis — a rolagem
                vertical pertence exclusivamente à área da lista, abaixo. */}
            <div className="flex-shrink-0 px-4 pt-3 pb-2 space-y-3 border-b border-[var(--th-line)]/30">
              {/* ── SELETOR DE SERVIDOR — cada servidor tem a SUA lista ─────
                  Define qual lista está sendo exibida/editada abaixo (e o
                  alvo do escopo "Apenas Este Servidor" no exportar/importar).
                  O cálculo dos personagens usa SEMPRE a lista do servidor de
                  cada personagem, independente do selecionado aqui. */}
              <label className="flex items-center gap-2 text-[10px]">
                <span className="inline-flex items-center gap-1 font-black uppercase tracking-wider text-slate-400 flex-shrink-0">
                  <Globe size={11} className="text-fuchsia-400" /> Servidor
                </span>
                <select
                  value={selectedServer}
                  onChange={event => { setSelectedServer(event.target.value); cancelInlineEdit(); setImportFeedback(null); setScopePicker(null); }}
                  title="Cada servidor tem a própria Lista de Itens (preços independentes). O cálculo de cada personagem usa sempre a lista do servidor dele."
                  className="h-8 flex-1 min-w-0 rounded-md border border-fuchsia-500/40 bg-black/35 px-2 text-[11px] font-bold text-fuchsia-200 outline-none focus:border-fuchsia-400 cursor-pointer"
                >
                  {SERVER_OPTIONS.map(server => {
                    const count = getServerWatchedItems(watchedByServer, server).length;
                    return (
                      <option key={server} value={server}>
                        {server}{count > 0 ? ` (${count})` : ""}
                      </option>
                    );
                  })}
                </select>
              </label>

              {/* Formulário: EXCLUSIVO para adicionar novos itens — a edição
                  de itens existentes é INLINE, na própria linha da lista. */}
              <form
                onSubmit={event => { event.preventDefault(); submitDraft(); }}
                className="rounded-lg border border-[var(--th-line)]/50 bg-black/20 p-2.5 space-y-1.5"
              >
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                  Adicionar item
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <input
                    type="text"
                    value={draft.name}
                    onChange={event => setDraft(prev => ({ ...prev, name: event.target.value }))}
                    placeholder="Nome do item (sem [Tier x])"
                    className="h-8 flex-1 min-w-[160px] rounded-md border border-[var(--th-line)]/70 bg-black/35 px-2 text-[11px] text-white outline-none focus:border-fuchsia-600/60"
                  />
                  <input
                    type="text"
                    inputMode="numeric"
                    value={draft.valueKk}
                    onChange={event => setDraft(prev => ({ ...prev, valueKk: sanitizeIntegerKk(event.target.value) }))}
                    placeholder="Valor (kk)"
                    title="Somente números inteiros (sem casas decimais)"
                    className="h-8 w-24 rounded-md border border-[var(--th-line)]/70 bg-black/35 px-2 text-[11px] text-white outline-none focus:border-fuchsia-600/60"
                  />
                  <button type="submit" className="inline-flex h-8 items-center gap-1 px-2.5 rounded-lg border border-fuchsia-500/40 bg-fuchsia-600/70 hover:bg-fuchsia-500/70 text-white text-[10px] font-black transition-all cursor-pointer">
                    <Plus size={12} /> Adicionar
                  </button>
                </div>
                {draftError && <p role="alert" className="text-[10px] font-medium text-rose-300">{draftError}</p>}
                <p className="text-[9px] text-slate-500 leading-relaxed">
                  O valor cadastrado é a BASE do cálculo, em kk <strong className="text-slate-400">inteiros</strong> (sem casas decimais). Itens com <span className="font-mono text-slate-400">[Tier x]</span> no Bazaar valem +20% por nível de Tier sobre esta base.
                </p>
              </form>

              {/* Pesquisa + exportar/importar */}
              <div className="flex flex-wrap items-center gap-1.5">
                <div className="relative flex-1 min-w-[140px]">
                  <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500" />
                  <input
                    type="text"
                    value={itemsSearch}
                    onChange={event => setItemsSearch(event.target.value)}
                    placeholder="Pesquisar item..."
                    className="h-8 w-full rounded-md border border-[var(--th-line)]/70 bg-black/35 pl-7 pr-2 text-[11px] text-white outline-none focus:border-fuchsia-600/60"
                  />
                </div>
                {/* ETAPA DE ESCOPO — clicar em Exportar/Importar troca o par
                    de botões pelo seletor compacto "Todos Servidores" |
                    "Apenas Este Servidor" (mesmo lugar, mesmo fluxo; o ✗
                    cancela e volta aos botões originais). */}
                {scopePicker ? (
                  <span className="inline-flex items-center gap-1">
                    <span className={`inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wide ${scopePicker === "export" ? "text-sky-300" : "text-emerald-300"}`}>
                      {scopePicker === "export" ? <Download size={11} /> : <Upload size={11} />}
                      {scopePicker === "export" ? "Exportar:" : "Importar:"}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        if (scopePicker === "export") { handleExport("all"); }
                        else { importScopeRef.current = "all"; setScopePicker(null); importInputRef.current?.click(); }
                      }}
                      disabled={scopePicker === "export" && totalWatchedCount === 0}
                      className="inline-flex h-8 items-center gap-1 px-2 rounded-lg border border-fuchsia-500/35 bg-fuchsia-500/10 text-fuchsia-300 text-[10px] font-black transition-all cursor-pointer hover:bg-fuchsia-500/20 disabled:opacity-40 disabled:cursor-not-allowed"
                      title={scopePicker === "export"
                        ? "Um único arquivo com as listas de TODOS os servidores (estrutura Servidor → Item → Valor)"
                        : "Restaura cada item na lista do servidor correspondente do arquivo"}
                    >
                      <Globe size={11} /> Todos Servidores
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (scopePicker === "export") { handleExport("current"); }
                        else { importScopeRef.current = "current"; setScopePicker(null); importInputRef.current?.click(); }
                      }}
                      disabled={scopePicker === "export" && watchedItems.length === 0}
                      className="inline-flex h-8 items-center gap-1 px-2 rounded-lg border border-amber-500/35 bg-amber-500/10 text-amber-300 text-[10px] font-black transition-all cursor-pointer hover:bg-amber-500/20 disabled:opacity-40 disabled:cursor-not-allowed"
                      title={scopePicker === "export"
                        ? `Somente os itens e valores de ${selectedServer}`
                        : `Importa somente para ${selectedServer} — os demais servidores não são alterados`}
                    >
                      Apenas Este Servidor ({selectedServer})
                    </button>
                    <button type="button" onClick={() => setScopePicker(null)} className="p-1 rounded text-slate-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer" title="Cancelar">
                      <X size={13} />
                    </button>
                  </span>
                ) : (
                  <>
                    <button type="button" onClick={() => setScopePicker("export")} disabled={totalWatchedCount === 0} className="inline-flex h-8 items-center gap-1 px-2.5 rounded-lg border border-sky-500/30 bg-sky-500/10 text-sky-300 text-[10px] font-black transition-all cursor-pointer hover:bg-sky-500/20 disabled:opacity-40 disabled:cursor-not-allowed" title="Baixa a lista em um arquivo JSON (todos os servidores ou apenas o selecionado)">
                      <Download size={12} /> Exportar
                    </button>
                    <button type="button" onClick={() => setScopePicker("import")} className="inline-flex h-8 items-center gap-1 px-2.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 text-[10px] font-black transition-all cursor-pointer hover:bg-emerald-500/20" title="Importa itens de um arquivo JSON exportado anteriormente (todos os servidores ou apenas o selecionado)">
                      <Upload size={12} /> Importar
                    </button>
                  </>
                )}
                <input
                  ref={importInputRef}
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={event => {
                    handleImportFile(event.target.files?.[0] || null);
                    event.target.value = "";
                  }}
                />
              </div>
              {importFeedback && <p className="text-[10px] font-medium text-amber-300">{importFeedback}</p>}
            </div>

            {/* ÚNICA região com rolagem vertical: a lista de itens ocupa o
                espaço restante do modal (flex-1) e rola sozinha — cabeçalho,
                formulário e pesquisa acima permanecem parados. */}
            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-4 py-2.5">
              {/* Lista */}
              {filteredItems.length === 0 ? (
                <p className="text-[11px] text-slate-500 text-center py-4">
                  {watchedItems.length === 0 ? `Nenhum item cadastrado ainda em ${selectedServer}.` : "Nenhum item corresponde à pesquisa."}
                </p>
              ) : (
                <div className="space-y-1">
                  {filteredItems.map(item => {
                    const copyKey = `item_${item.id}`;
                    // Linha em edição INLINE: o valor vira campo editável na
                    // própria linha (borda fúcsia destaca o estado).
                    const isEditing = inlineEdit?.id === item.id;
                    return (
                    <div key={item.id} className={`rounded-lg border bg-black/20 px-2.5 py-1.5 ${isEditing ? "border-fuchsia-500/50" : "border-[var(--th-line)]/40"}`}>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 min-w-0 flex items-center gap-1">
                        {/* Nome = botão de copiar (SOMENTE o nome exato, sem
                            valor/Tier/data). Mesmo padrão visual dos demais
                            copiar do app: hover revela o ícone, 1,5s de
                            "Copiado!". */}
                        <button
                          type="button"
                          onClick={() => copyText(copyKey, item.name)}
                          className={`group inline-flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-[11px] font-bold transition-colors cursor-copy ${
                            copiedKey === copyKey ? "bg-emerald-500/20 text-emerald-300" : "text-slate-100 hover:bg-white/10 hover:text-white"
                          }`}
                          title={copiedKey === copyKey ? "Nome copiado" : `Copiar "${item.name}"`}
                        >
                          {copiedKey === copyKey ? (
                            <><Check size={11} className="flex-shrink-0 text-emerald-400" /><span>Copiado!</span></>
                          ) : (
                            <><span className="truncate">{item.name}</span><Copy size={10} className="flex-shrink-0 opacity-0 group-hover:opacity-70 transition-opacity" /></>
                          )}
                        </button>
                        {/* Data da última alteração de VALOR — NA MESMA LINHA,
                            à frente do nome, em AMARELO (destacada e compacta). */}
                        {item.updatedAtMs ? (
                          <span className="flex-shrink-0 text-[8px] font-bold leading-tight text-amber-300 whitespace-nowrap">
                            {`(Atualizado dia ${formatItemUpdatedAt(item.updatedAtMs, timezoneOffsetMinutes)} horas)`}
                          </span>
                        ) : (
                          <span className="flex-shrink-0 text-[8px] leading-tight text-slate-500 whitespace-nowrap">(Sem registro de atualização)</span>
                        )}
                      </div>
                      {isEditing ? (
                        <>
                          {/* Valor em EDIÇÃO INLINE: input compacto no lugar do
                              valor + ✓ salvar (verde) e ✗ cancelar (cinza) —
                              mesmos ícones/cores dos demais confirmar/fechar
                              do app. Enter salva, Esc cancela. */}
                          <input
                            type="text"
                            inputMode="numeric"
                            autoFocus
                            value={inlineEdit.valueKk}
                            onChange={event => { setInlineEdit(prev => (prev ? { ...prev, valueKk: sanitizeIntegerKk(event.target.value) } : prev)); setInlineEditError(null); }}
                            onKeyDown={event => {
                              if (event.key === "Enter") { event.preventDefault(); saveInlineEdit(); }
                              if (event.key === "Escape") { event.preventDefault(); cancelInlineEdit(); }
                            }}
                            placeholder="Valor (kk)"
                            title="Somente números inteiros (sem casas decimais). Enter salva, Esc cancela."
                            className="h-7 w-20 flex-shrink-0 rounded-md border border-fuchsia-500/60 bg-black/35 px-1.5 text-right font-mono text-[11px] text-amber-200 outline-none focus:border-fuchsia-400"
                          />
                          <button type="button" onClick={saveInlineEdit} className="p-1 rounded text-emerald-300 hover:bg-emerald-500/15 transition-colors cursor-pointer flex-shrink-0" title="Salvar novo valor">
                            <Check size={13} strokeWidth={3} />
                          </button>
                          <button type="button" onClick={cancelInlineEdit} className="p-1 rounded text-slate-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer flex-shrink-0" title="Cancelar edição">
                            <X size={13} />
                          </button>
                        </>
                      ) : (
                        <>
                          <span className="font-mono text-[11px] text-amber-200 flex-shrink-0">{formatKkValue(item.valueKk, "kk")}</span>
                          <button type="button" onClick={() => startInlineEdit(item)} className="p-1 rounded text-sky-300 hover:bg-sky-500/15 transition-colors cursor-pointer flex-shrink-0" title="Editar valor nesta linha">
                            <Pencil size={12} />
                          </button>
                          <button type="button" onClick={() => removeItem(item.id)} className="p-1 rounded text-rose-300 hover:bg-rose-500/15 transition-colors cursor-pointer flex-shrink-0" title="Remover">
                            <Trash2 size={12} />
                          </button>
                        </>
                      )}
                    </div>
                    {/* Erro de validação da edição inline — dentro da própria
                        linha, compacto, mesmo tom dos erros do modal. */}
                    {isEditing && inlineEditError && (
                      <p role="alert" className="mt-1 text-[10px] font-medium text-rose-300">{inlineEditError}</p>
                    )}
                    </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Modal: detalhes do personagem (botão Ver) ──────────────────────── */}
      {detailResult && (
        <div className="app-modal-overlay fixed inset-0 z-[1200] flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="app-modal-frame w-full max-w-xl max-h-[88vh] flex flex-col rounded-xl border border-fuchsia-500/30 bg-[var(--th-bg-raised)] shadow-2xl shadow-black/60 overflow-hidden">
            <div className="flex-shrink-0 flex items-center justify-between gap-2 px-4 py-3 border-b border-[var(--th-line)]/40">
              <div className="flex items-center gap-2 min-w-0">
                <Package size={16} className="text-fuchsia-400 flex-shrink-0" />
                <span className="text-sm font-bold text-fuchsia-300 truncate">{detailResult.name || "Personagem"}</span>
                {detailResult.server && (
                  <span className="inline-flex items-center gap-1 rounded border border-fuchsia-500/30 bg-fuchsia-500/10 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wide text-fuchsia-300 flex-shrink-0" title="Os valores desta tabela vêm da Lista de Itens deste servidor">
                    <Globe size={9} /> {detailResult.server}
                  </span>
                )}
                {detailResult.url && (
                  <a href={detailResult.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sky-300 hover:text-sky-200 font-bold text-[10px] underline flex-shrink-0">
                    <ExternalLink size={10} /> Abrir leilão
                  </a>
                )}
              </div>
              <button type="button" onClick={() => { setDetailResult(null); setDetailEdit(null); setDetailEditError(null); }} className="p-1 rounded text-slate-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer flex-shrink-0" title="Fechar">
                <X size={15} />
              </button>
            </div>

            <div className="flex-1 min-h-0 overflow-auto custom-scrollbar px-4 py-3 space-y-2">
              <table className="w-full text-[10px]">
                <thead>
                  <tr className="text-[8px] uppercase tracking-wider text-slate-400 border-b border-[var(--th-line)]/40">
                    <th className="px-1.5 py-1.5 text-left">Item encontrado</th>
                    <th className="px-1.5 py-1.5 text-left">Item da lista</th>
                    <th className="px-1.5 py-1.5 text-right">Base (kk)</th>
                    <th className="px-1.5 py-1.5 text-center">Tier</th>
                    <th className="px-1.5 py-1.5 text-right">Pós-Tier (kk)</th>
                    <th className="px-1.5 py-1.5 text-center">Qtd</th>
                    <th className="px-1.5 py-1.5 text-right">Total (kk)</th>
                  </tr>
                </thead>
                <tbody>
                  {detailResult.matches.map((match, index) => {
                    const isEditingMatch = detailEdit?.matchIndex === index;
                    return (
                    <tr key={`${match.foundName}-${index}`} className={`border-b border-[var(--th-line)]/25 ${isEditingMatch ? "bg-fuchsia-500/5" : ""}`}>
                      <td className="px-1.5 py-1.5 font-bold text-slate-100">{match.foundName}</td>
                      <td className="px-1.5 py-1.5 text-slate-300">{match.watchedName}</td>
                      <td className="px-1.5 py-1.5 text-right font-mono text-slate-200">{formatKkValue(match.baseValueKk, "kk")}</td>
                      <td className="px-1.5 py-1.5 text-center font-mono">
                        {match.tier > 0
                          ? <span className="text-fuchsia-300 font-bold" title={`+${match.tier * 20}% sobre o valor base`}>{match.tier}</span>
                          : <span className="text-slate-600">—</span>}
                      </td>
                      <td className="px-1.5 py-1.5 text-right font-mono text-slate-200">{formatKkValue(match.unitValueKk, "kk")}</td>
                      <td className="px-1.5 py-1.5 text-center font-mono text-slate-200">{match.amount}</td>
                      <td className="px-1.5 py-1.5 text-right font-mono font-bold text-amber-200">
                        {/* EDITAR VALOR DO ITEM (por servidor) — o lápis edita
                            o valor BASE deste item na Lista de Itens do
                            SERVIDOR deste personagem (fonte única de preço).
                            Salvar atualiza a lista do servidor e reprecifica
                            na hora os personagens dele; outros servidores
                            permanecem intactos. Enter salva, Esc cancela. */}
                        {isEditingMatch ? (
                          <span className="inline-flex items-center justify-end gap-1">
                            <input
                              type="text"
                              inputMode="numeric"
                              autoFocus
                              value={detailEdit.value}
                              onChange={event => { setDetailEdit(prev => (prev ? { ...prev, value: sanitizeIntegerKk(event.target.value) } : prev)); setDetailEditError(null); }}
                              onKeyDown={event => {
                                if (event.key === "Enter") { event.preventDefault(); saveDetailEdit(); }
                                if (event.key === "Escape") { event.preventDefault(); setDetailEdit(null); setDetailEditError(null); }
                              }}
                              placeholder="Base (kk)"
                              title={`Novo valor BASE (kk inteiros) de "${match.watchedName}" em ${detailResult.server}. Enter salva, Esc cancela.`}
                              className="h-6 w-16 rounded-md border border-fuchsia-500/60 bg-black/35 px-1.5 text-right font-mono text-[10px] text-amber-200 outline-none focus:border-fuchsia-400"
                            />
                            <button type="button" onClick={saveDetailEdit} className="p-0.5 rounded text-emerald-300 hover:bg-emerald-500/15 transition-colors cursor-pointer" title={`Salvar novo valor base na Lista de Itens de ${detailResult.server}`}>
                              <Check size={12} strokeWidth={3} />
                            </button>
                            <button type="button" onClick={() => { setDetailEdit(null); setDetailEditError(null); }} className="p-0.5 rounded text-slate-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer" title="Cancelar">
                              <X size={12} />
                            </button>
                          </span>
                        ) : (
                          <span className="inline-flex items-center justify-end gap-1">
                            <span>{formatKkValue(match.totalKk, "kk")}</span>
                            <button
                              type="button"
                              onClick={() => { setDetailEdit({ matchIndex: index, value: String(match.baseValueKk) }); setDetailEditError(null); }}
                              className="p-0.5 rounded text-sky-300 hover:bg-sky-500/15 transition-colors cursor-pointer"
                              title={`Editar o valor base de "${match.watchedName}" na Lista de Itens de ${detailResult.server} (atualiza a lista do servidor e os cálculos dos personagens dele)`}
                            >
                              <Pencil size={10} />
                            </button>
                          </span>
                        )}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>

              {detailEditError && (
                <p role="alert" className="text-[10px] font-medium text-rose-300">{detailEditError}</p>
              )}

              <div className="rounded-lg border border-fuchsia-500/25 bg-fuchsia-500/5 px-3 py-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
                <span className="text-slate-300">Total do personagem: <span className="font-mono font-bold text-amber-200">{formatKkValue(detailResult.totalKk, "kk")}</span></span>
                {coinRate > 0 ? (
                  <span className="text-slate-300" title={`floor((${detailResult.totalKk} / ${coinRate}) × 1000) — mesma fórmula de conversão do restante do aplicativo`}>
                    Em RC (coin a {coinRateText}k): <span className="font-mono font-bold text-emerald-300">{computeItemRC(coinRate, detailResult.totalKk).toLocaleString("de-DE")} RC</span>
                  </span>
                ) : (
                  <span className="text-slate-500">Informe o valor do coin no quadro para ver a conversão em RC.</span>
                )}
                <span className="text-[9px] text-slate-500 basis-full">
                  Tier: valor base × (1 + 0,2 × Tier). Conversão RC: floor((total ÷ coin) × 1000).
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Seleção do navegador — método TRAVADO no novo (API JSON) ───────── */}
      <BazaarBrowserModal
        open={isBrowserModalOpen}
        forcedMethod="novo"
        onCancel={() => setIsBrowserModalOpen(false)}
        onConfirm={(browserKey, browserOrder, cleanProfile, retryBrowsers, speedMode, retryCounts) => {
          setIsBrowserModalOpen(false);
          void executeItemsQuery({ browserKey, browserOrder, cleanProfile, retryBrowsers, speedMode, retryCounts });
        }}
      />
    </div>
  );
}

/** Cotação digitada ("90" ou "2,5") -> número em k. Inválido = 0. */
function parseCoinRate(text: string): number {
  const value = Number(String(text || "").trim().replace(",", "."));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Mantém somente dígitos — campos de valor em kk aceitam apenas inteiros. */
function sanitizeIntegerKk(raw: string): string {
  return String(raw || "").replace(/\D+/g, "").slice(0, 9);
}

/** "dd/MM às HH:mm" da última atualização do item, no fuso configurado. */
function formatItemUpdatedAt(ms: number, offsetMinutes: number): string {
  try {
    const shifted = new Date(ms + offsetMinutes * 60 * 1000);
    const day = String(shifted.getUTCDate()).padStart(2, "0");
    const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
    const hour = String(shifted.getUTCHours()).padStart(2, "0");
    const minute = String(shifted.getUTCMinutes()).padStart(2, "0");
    return `${day}/${month} às ${hour}:${minute}`;
  } catch {
    return "—";
  }
}
