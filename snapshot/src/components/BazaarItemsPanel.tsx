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

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Check, Coins, Copy, Download, ExternalLink, Eye, FlagTriangleRight, ListChecks, Package, Pencil, Plus, RefreshCw, Search, Sparkles, Square, Trash2, Upload, X } from "lucide-react";
import BazaarBrowserModal, { BAZAAR_BROWSER_KEY, BAZAAR_BROWSER_ORDER_KEY, BAZAAR_RETRY_BROWSERS_KEY, BAZAAR_RETRY_COUNTS_KEY, BAZAAR_SPEED_MODE_KEY, DEFAULT_BROWSER_ORDER, normalizeRetryCounts } from "./BazaarBrowserModal";
import type { BazaarRetryCounts, BazaarSpeedMode } from "./BazaarBrowserModal";
import { loadUIState } from "../storage";
import { computeItemRC, formatKkValue } from "../utils/itemSale";
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
  exportWatchlistJson,
  loadItemsCoinRate,
  loadItemsInterests,
  loadItemsLastQuery,
  loadWatchedItems,
  normalizeWatchedItemName,
  parseWatchlistImport,
  saveItemsCoinRate,
  saveItemsInterests,
  saveItemsLastQuery,
  saveWatchedItems,
  type BazaarItemsCharacterResult,
  type BazaarItemsLastQuery,
  type RawItemMatch,
  type WatchedItem,
} from "../utils/bazaarWatchedItems";
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
  const [watchedItems, setWatchedItems] = useState<WatchedItem[]>(() => loadWatchedItems());
  const [coinRateText, setCoinRateText] = useState<string>(() => {
    const rate = loadItemsCoinRate();
    return rate > 0 ? String(rate).replace(".", ",") : "";
  });
  const [endUntil, setEndUntil] = useState<string>(() => getDefaultBazarEndUntil(timezoneOffsetMinutes));
  const [lastQuery, setLastQuery] = useState<BazaarItemsLastQuery | null>(() => loadItemsLastQuery());

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
  const [importFeedback, setImportFeedback] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [detailResult, setDetailResult] = useState<BazaarItemsCharacterResult | null>(null);
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

  // ── Encaixe dos botões no quadro do TÍTULO (portal) ───────────────────────
  // O BazarPanel reserva o contêiner `#bazaar-items-title-actions` no quadro
  // do título quando o modo itens está ativo (mesma posição dos botões do
  // modo de quests). O contêiner só existe DEPOIS da montagem — por isso a
  // referência é resolvida em efeito, não durante o render.
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

  // ── Lista de Itens: CRUD local ─────────────────────────────────────────────
  function persistItems(next: WatchedItem[]) {
    setWatchedItems(next);
    saveWatchedItems(next);
  }

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
    const duplicated = watchedItems.some(item => item.id !== draft.id && normalizeWatchedItemName(item.name) === key);
    if (duplicated) { setDraftError("Este item já está na lista."); return; }
    const now = Date.now();
    if (draft.id) {
      persistItems(watchedItems.map(item => {
        if (item.id !== draft.id) return item;
        // "Atualizado dia..." só muda quando o VALOR muda de fato — renomear
        // sem alterar o valor preserva a data anterior.
        const valueChanged = item.valueKk !== valueKk;
        return { ...item, name, valueKk, updatedAtMs: valueChanged ? now : item.updatedAtMs };
      }));
    } else {
      persistItems([...watchedItems, { id: `wi_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`, name, valueKk, updatedAtMs: now }]);
    }
    setDraft(EMPTY_DRAFT);
    setDraftError(null);
  }

  function removeItem(id: string) {
    persistItems(watchedItems.filter(item => item.id !== id));
    if (draft.id === id) { setDraft(EMPTY_DRAFT); setDraftError(null); }
  }

  function handleExport() {
    try {
      const blob = new Blob([exportWatchlistJson(watchedItems)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `bazaar-lista-de-itens-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
    } catch {
      setImportFeedback("Não foi possível exportar a lista.");
    }
  }

  function handleImportFile(file: File | null) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const { items, error: importError } = parseWatchlistImport(String(reader.result || ""));
      if (importError) { setImportFeedback(importError); return; }
      // Mescla: itens do arquivo entram; nomes já existentes têm o valor
      // ATUALIZADO pelo arquivo (importação é a fonte mais recente).
      const merged = [...watchedItems];
      let added = 0;
      let updated = 0;
      const now = Date.now();
      for (const incoming of items) {
        const key = normalizeWatchedItemName(incoming.name);
        const existingIndex = merged.findIndex(item => normalizeWatchedItemName(item.name) === key);
        if (existingIndex >= 0) {
          if (merged[existingIndex].valueKk !== incoming.valueKk) {
            merged[existingIndex] = {
              ...merged[existingIndex],
              valueKk: incoming.valueKk,
              // Valor alterado pelo import também conta como atualização:
              // usa a data do arquivo quando presente, senão o momento atual.
              updatedAtMs: incoming.updatedAtMs || now,
            };
            updated += 1;
          }
        } else {
          merged.push(incoming);
          added += 1;
        }
      }
      persistItems(merged);
      setImportFeedback(`Importação concluída: ${added} novo(s), ${updated} atualizado(s).`);
    };
    reader.onerror = () => setImportFeedback("Não foi possível ler o arquivo.");
    reader.readAsText(file);
  }

  // ── Consulta ───────────────────────────────────────────────────────────────
  function requestItemsQuery() {
    if (!isBossUser) { setError("Apenas usuários Boss podem consultar itens no Bazaar."); return; }
    if (!isElectron) { setError("A consulta de itens precisa ser executada no aplicativo Desktop (Electron)."); return; }
    if (watchedItems.length === 0) { setError("Cadastre pelo menos um item na Lista de Itens antes de consultar."); return; }
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
      setStatusText(`Analisando itens de ${eligible.length} personagem(ns) elegível(is)...`);
      const watchKeys = watchedItems.map(item => normalizeWatchedItemName(item.name)).filter(Boolean);
      const detailsResponse = await ipcRenderer.invoke("rubinot-bazaar-items-v2", eligible, { watchKeys }) as ItemsDetailsResult;

      if (!detailsResponse?.ok) {
        setError(detailsResponse?.error || "Não foi possível analisar os itens dos personagens.");
        return;
      }

      // Etapa 4 — casamento com a Lista de Itens e totais (tudo local).
      const index = buildWatchlistIndex(watchedItems);
      const results: BazaarItemsCharacterResult[] = [];
      for (const auction of eligible) {
        const key = auction.id || auction.name || auction.url;
        const detail = key ? detailsResponse.details?.[key] : null;
        if (!detail || detail.error || !Array.isArray(detail.matches) || detail.matches.length === 0) continue;
        const { matches, totalKk } = buildCharacterMatches(detail.matches, index);
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

  // ── Derivados de exibição ──────────────────────────────────────────────────
  const filteredItems = itemsSearch.trim()
    ? watchedItems.filter(item => normalizeWatchedItemName(item.name).includes(normalizeWatchedItemName(itemsSearch)))
    : watchedItems;

  const results = lastQuery?.results || [];

  // ── Botões de ação do painel — vivem no QUADRO DO TÍTULO ──────────────────
  // Mesmo padrão do painel de quests ("Filtros Consulta"/"Consultar Bazaar"
  // no título): aqui são "Lista de Itens" e "Consultar Bazaar"/"Parar". A
  // lógica é a MESMA de antes — apenas o encaixe mudou (portal no contêiner
  // reservado pelo BazarPanel). Sem o contêiner (ex.: montagem isolada), os
  // botões caem no quadro "Última Consulta" como antes — nunca somem.
  const titleActions = (
    <>
      <button
        type="button"
        onClick={() => { setIsItemsModalOpen(true); setImportFeedback(null); }}
        className="inline-flex h-7 items-center gap-1 px-2.5 rounded-lg border border-fuchsia-500/25 bg-fuchsia-500/10 text-fuchsia-300 text-[10px] font-black transition-all cursor-pointer hover:bg-fuchsia-500/20"
        title="Itens monitorados na consulta: nome e valor base em kk"
      >
        <ListChecks size={12} /> Lista de Itens ({watchedItems.length})
      </button>
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
    </>
  );

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-1.5 overflow-hidden">
      {/* Botões no quadro do TÍTULO — portal para o contêiner do BazarPanel. */}
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
      <div className="flex-1 min-h-0 overflow-auto custom-scrollbar rounded-lg border border-[var(--th-line)]/60 bg-[var(--th-n-base)]/80">
        {results.length === 0 ? (
          <div className="h-full flex items-center justify-center p-6">
            <div className="text-center space-y-2 max-w-md">
              <Package size={28} className="mx-auto text-fuchsia-400/60" />
              <p className="text-xs text-slate-400 leading-relaxed">
                {lastQuery
                  ? "Nenhum personagem da última consulta possui itens da sua Lista de Itens."
                  : "Cadastre os itens desejados em \u201CLista de Itens\u201D, ajuste a data e a cotação do coin e clique em \u201CConsultar Bazaar\u201D."}
              </p>
            </div>
          </div>
        ) : (
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 bg-[var(--th-n-raised)]/95 backdrop-blur-sm z-10">
              <tr className="text-[9px] uppercase tracking-wider text-slate-400">
                <th className="px-2 py-2 text-left">Personagem</th>
                <th className="px-2 py-2 text-center">Servidor</th>
                <th className="px-2 py-2 text-center">Encerra</th>
                <th className="px-2 py-2 text-center">Valor</th>
                <th className="px-2 py-2 text-right">Valor Itens (KK)</th>
                <th className="px-2 py-2 text-right">Valor Itens (RC)</th>
                <th className="px-2 py-2 text-center">Detalhes</th>
                <th className="px-2 py-2 text-center">Tenho Interesse</th>
                <th className="px-2 py-2 text-center">Link</th>
              </tr>
            </thead>
            <tbody>
              {results.map(result => {
                const auctionKey = result.id || result.url || result.name;
                const copyKey = `res_${auctionKey}`;
                // "Tenho Interesse" — estado 100% LOCAL (localStorage por uid).
                const isInterested = itemInterests.includes(auctionKey);
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
                  <td className="px-2 py-1.5">
                    {/* Nome + level como botão de copiar — mesmo padrão visual
                        dos copiar de personagem do app (hover revela o ícone,
                        1,5s de "Copiado!"). Copia "Nome, Lv X". */}
                    <button
                      type="button"
                      onClick={() => copyText(copyKey, result.level ? `${result.name}, Lv ${result.level}` : result.name)}
                      className={`group inline-flex max-w-[220px] items-center gap-1 rounded px-1 py-0.5 font-bold transition-colors cursor-copy ${
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
                    <div className="text-[9px] text-slate-500 px-1">
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
                  <td className="px-2 py-1.5 text-right font-mono font-bold text-amber-200">{formatKkValue(result.totalKk, "kk")}</td>
                  <td className="px-2 py-1.5 text-right font-mono font-bold text-emerald-300">
                    {coinRate > 0 ? computeItemRC(coinRate, result.totalKk).toLocaleString("de-DE") : "—"}
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
                <span className="text-[10px] text-slate-500 font-mono">({watchedItems.length})</span>
              </div>
              <button type="button" onClick={() => setIsItemsModalOpen(false)} className="p-1 rounded text-slate-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer flex-shrink-0" title="Fechar">
                <X size={15} />
              </button>
            </div>

            <div className="flex-1 min-h-0 overflow-auto custom-scrollbar px-4 py-3 space-y-3">
              {/* Formulário: adicionar/editar */}
              <form
                onSubmit={event => { event.preventDefault(); submitDraft(); }}
                className="rounded-lg border border-[var(--th-line)]/50 bg-black/20 p-2.5 space-y-1.5"
              >
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                  {draft.id ? "Editar item" : "Adicionar item"}
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
                    <Plus size={12} /> {draft.id ? "Salvar" : "Adicionar"}
                  </button>
                  {draft.id && (
                    <button type="button" onClick={() => { setDraft(EMPTY_DRAFT); setDraftError(null); }} className="inline-flex h-8 items-center px-2 rounded-lg border border-[var(--th-line)]/60 text-slate-300 text-[10px] font-bold hover:bg-white/5 transition-all cursor-pointer">
                      Cancelar
                    </button>
                  )}
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
                <button type="button" onClick={handleExport} disabled={watchedItems.length === 0} className="inline-flex h-8 items-center gap-1 px-2.5 rounded-lg border border-sky-500/30 bg-sky-500/10 text-sky-300 text-[10px] font-black transition-all cursor-pointer hover:bg-sky-500/20 disabled:opacity-40 disabled:cursor-not-allowed" title="Baixa a lista em um arquivo JSON">
                  <Download size={12} /> Exportar
                </button>
                <button type="button" onClick={() => importInputRef.current?.click()} className="inline-flex h-8 items-center gap-1 px-2.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 text-[10px] font-black transition-all cursor-pointer hover:bg-emerald-500/20" title="Importa itens de um arquivo JSON exportado anteriormente">
                  <Upload size={12} /> Importar
                </button>
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

              {/* Lista */}
              {filteredItems.length === 0 ? (
                <p className="text-[11px] text-slate-500 text-center py-4">
                  {watchedItems.length === 0 ? "Nenhum item cadastrado ainda." : "Nenhum item corresponde à pesquisa."}
                </p>
              ) : (
                <div className="space-y-1">
                  {filteredItems.map(item => {
                    const copyKey = `item_${item.id}`;
                    return (
                    <div key={item.id} className="flex items-center gap-2 rounded-lg border border-[var(--th-line)]/40 bg-black/20 px-2.5 py-1.5">
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
                      <span className="font-mono text-[11px] text-amber-200 flex-shrink-0">{formatKkValue(item.valueKk, "kk")}</span>
                      <button type="button" onClick={() => { setDraft({ id: item.id, name: item.name, valueKk: String(item.valueKk) }); setDraftError(null); }} className="p-1 rounded text-sky-300 hover:bg-sky-500/15 transition-colors cursor-pointer flex-shrink-0" title="Editar">
                        <Pencil size={12} />
                      </button>
                      <button type="button" onClick={() => removeItem(item.id)} className="p-1 rounded text-rose-300 hover:bg-rose-500/15 transition-colors cursor-pointer flex-shrink-0" title="Remover">
                        <Trash2 size={12} />
                      </button>
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
                {detailResult.url && (
                  <a href={detailResult.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sky-300 hover:text-sky-200 font-bold text-[10px] underline flex-shrink-0">
                    <ExternalLink size={10} /> Abrir leilão
                  </a>
                )}
              </div>
              <button type="button" onClick={() => setDetailResult(null)} className="p-1 rounded text-slate-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer flex-shrink-0" title="Fechar">
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
                  {detailResult.matches.map((match, index) => (
                    <tr key={`${match.foundName}-${index}`} className="border-b border-[var(--th-line)]/25">
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
                      <td className="px-1.5 py-1.5 text-right font-mono font-bold text-amber-200">{formatKkValue(match.totalKk, "kk")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

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
