import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import bazarBgUrl from "../assets/bazar-bg.png";
import { AlertTriangle, ArrowDownUp, Check, CheckCircle2, ChevronDown, ChevronUp, Crown, ExternalLink, Filter, FlagTriangleRight, Flame, Plus, RefreshCw, RotateCcw, ShieldAlert, ShoppingBag, Sparkles, Star, Target, X } from "lucide-react";
import BazaarSearchFiltersModal from "./BazaarSearchFiltersModal";
import BazaarUsedFiltersModal from "./BazaarUsedFiltersModal";
import BazaarBrowserModal, { BAZAAR_BROWSER_KEY, BAZAAR_BROWSER_ORDER_KEY, BAZAAR_METHOD_KEY, BAZAAR_RETRY_BROWSERS_KEY, BAZAAR_RETRY_COUNTS_KEY, BAZAAR_SPEED_MODE_KEY, DEFAULT_BAZAAR_METHOD, DEFAULT_BROWSER_ORDER, normalizeBazaarMethod, normalizeRetryCounts } from "./BazaarBrowserModal";
import type { BazaarRetryCounts } from "./BazaarBrowserModal";
import type { BazaarSpeedMode } from "./BazaarBrowserModal";
import type { BazaarMethod } from "./BazaarBrowserModal";
import ConfirmModal from "./ConfirmModal";
import FriendsSummaryModal, { buildServerSummaries, buildVocationCountsByServer } from "./FriendsSummaryModal";
import AutoBidModal from "./AutoBidModal";
import OverviewFiltersModal from "./OverviewFiltersModal";
import { useOverviewFilters } from "../hooks/useOverviewFilters";
import { FilterDateMax, FilterInline, FilterMulti, FilterNumber } from "./FilterTypes";
import type { Character, PartyTab, WaitingService, Vocation } from "../types";
import { useAuth } from "../context/AuthContext";
import { getManualSyncCooldownRemainingMs, markManualSyncAttempt, publishOfficialBazaarList, readOfficialBazaarCache, removeBazaarInterest, setBazaarInterest, syncBazaarInterests, syncOfficialBazaarList, type BazaarInterestMap, type OfficialBazaarMetadata } from "../services/bazaarOfficialService";
import { BAZAR_NOTIFY_MINUTES_MAX, BAZAR_NOTIFY_MINUTES_MIN, clampBazarNotifyMinutes, getDeviceTimezoneOffsetMinutes, readBazarNotifyMinutes } from "../utils/bazaarTime";
import { syncNotificationPrefsToCloud } from "../services/notificationPrefsSyncService";
import { syncBazaarEndingAlerts } from "../services/bazaarInterestNotificationService";
import { buildBazaarBidUrl, extractBazaarAuctionId, parseBidAmount, sanitizeBidInput } from "../utils/bazaarBid";
import { readBazaarDefaultBid, resolveBazaarBid, saveBazaarDefaultBid } from "../utils/bazaarDefaultBid";
import { loadUIState, saveUIState, loadNotifications } from "../storage";
import { SERVER_OPTIONS, serverKey } from "../constants/servers";
import { computeUserPriority } from "../utils/bazaarUserPriority";
import { collectBusyIdsForQuest } from "../utils/questEligibility";

interface BazaarAuction {
  id: string;
  name: string;
  vocation: string;
  level: number;
  server: string;
  bid: number;
  currentValue: number;
  startingValue: number;
  hasBid: boolean;
  auctionEndTs: number | null;
  url: string;
  soulwarCompleted?: boolean | null;
  sanguineCompleted?: boolean | null;
  soulWarBossCount?: number;
  sanguineBossCount?: number;
  soulWarBossTotal?: number;
  sanguineBossTotal?: number;
}

interface BazaarDetails {
  id: string;
  soulwarCompleted: boolean | null;
  sanguineCompleted: boolean | null;
  soulWarBossCount?: number;
  sanguineBossCount?: number;
  soulWarBossTotal?: number;
  sanguineBossTotal?: number;
  fetchedAt: number;
  error?: string;
}

interface BazaarFetchResult {
  ok: boolean;
  fetchedAt: number;
  total: number;
  auctions: BazaarAuction[];
  error?: string;
  cancelled?: boolean;
  needsHumanVerification?: boolean;
  // Pré-validação de disponibilidade: servidor offline/manutenção ou com
  // menos de 1000 jogadores online. A consulta nem chegou a listar páginas.
  serverNotReady?: boolean;
  onlineCount?: number | null;
  // Navegador escolhido não pôde ser aberto (não instalado, por exemplo).
  browserUnavailable?: boolean;
  browserKey?: string;
  // ── Completude da listagem ────────────────────────────────────────────────
  // Preenchidos pelo processo principal. Quando `partial` é true, algumas
  // páginas da API do Rubinot não responderam nem após as retentativas: a
  // lista está correta, porém INCOMPLETA, e não pode substituir a lista
  // oficial sem confirmação explícita do Boss.
  partial?: boolean;
  totalPages?: number;
  loadedPageCount?: number;
  failedPageNumbers?: number[];
  failedPageDetails?: Record<string, { outcome?: string; status?: number; message?: string; attempts?: number }>;
  browserProfile?: { channel?: string; profile?: string; persistent?: boolean };
  // Telemetria da listagem: quantas páginas foram lidas e se houve parada
  // antecipada pelo limite de encerramento.
  pagesScanned?: number;
  stoppedEarly?: boolean;
  stoppedAtPage?: number;
}

/** Resume os números das páginas que falharam, agrupando faixas contíguas. */
function formatFailedPages(pages: number[]): string {
  if (!pages.length) return "";
  const sorted = [...pages].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    const current = sorted[i];
    if (current === prev + 1) { prev = current; continue; }
    ranges.push(start === prev ? String(start) : `${start}-${prev}`);
    start = current;
    prev = current;
  }
  return ranges.join(", ");
}

/** Retorno da análise individual, incluindo o resultado do retry final. */
interface BazaarDetailsResponse {
  ok: boolean;
  cancelled?: boolean;
  error?: string;
  details?: Record<string, BazaarDetails>;
  primaryBrowser?: string;
  retryBrowser?: string;
  // Cadeia de retries: quem tentou, quantos recebeu e quantos recuperou.
  retryStats?: { browser: string; attempted: number; recovered: number; attempt?: number; attempts?: number }[];
  retryBrowsers?: string[];
  totalRequested?: number;
  analyzedCount?: number;
  recoveredCount?: number;
  failedCount?: number;
  failedCharacterList?: { id: string; name: string; url: string; reason?: string }[];
  /** `true` quando a consulta foi encerrada pelo botão "Concluir agora". */
  stoppedManually?: boolean;
  /** Personagens que sequer chegaram a ser abertos por causa do encerramento. */
  notAnalyzedCount?: number;
  // Indício de que a sessão preparada não vale mais (muitas falhas seguidas,
  // cookies ausentes ou Cloudflare reaparecendo).
  sessionExpired?: boolean;
  sessionStatus?: string;
  consecutiveFailures?: number;
  // Métricas da consulta, para comparar execuções entre si.
  successRate?: number;
  totalDurationMs?: number;
}

/** Rótulo amigável do navegador, para o quadro "Última consulta". */
const BROWSER_LABELS: Record<string, string> = {
  chrome: "Chrome",
  edge: "Edge",
  firefox: "Firefox",
  webkit: "WebKit",
};
function browserLabel(key?: string): string {
  if (!key) return "";
  return BROWSER_LABELS[key] || key;
}

interface BazaarProgressEvent {
  stage: "bazaar" | "details";
  message: string;
  processed: number;
  total: number;
  percent: number;
  active?: boolean;
  startedAt?: number;
  updatedAt?: number;
  reason?: string;
  /** Falhas já detectadas que serão reenviadas ao segundo navegador. */
  retryPending?: number;
  /** true quando a passada em curso JÁ É o retry com o navegador secundário. */
  isRetryPass?: boolean;
  /** Progresso por navegador: analisados, falhas e taxa, ao vivo. */
  browserStats?: BazaarBrowserProgress[];
  /** Passadas de retry que ainda não começaram (uma entrada por tentativa). */
  pendingBrowsers?: { browser: string; label: string; attempt?: number; attempts?: number }[];
  /** Total de passadas de retry planejadas nesta consulta e quantas faltam. */
  retryStepsTotal?: number;
  retryStepsPending?: number;
  /** Modo de velocidade em vigor nesta consulta. */
  speedMode?: string;
  speedModeLabel?: string;
  /** Navegadores com retry e quantas tentativas cada um — fixo na execução. */
  retrySelection?: { browser: string; label: string; attempts?: number }[];
}

interface BazaarBrowserProgress {
  browser: string;
  label: string;
  isRetry: boolean;
  /** Número da tentativa deste navegador (1..N). 0 na passada principal. */
  attempt?: number;
  attempts?: number;
  total: number;
  analyzed: number;
  failed: number;
  done: boolean;
  /** falhas / analisados, em % — atualizado durante a análise. */
  failureRate: number;
}

interface BazarLastSummary {
  completedAtMs: number;
  durationMs: number;
  approvedCount: number;
  // ── Análise individual (opcionais: resumos antigos não os possuem) ────────
  primaryBrowser?: string;   // navegador usado na consulta principal
  retryBrowser?: string;     // navegador do retry final, se houve
  retryStats?: { browser: string; attempted: number; recovered: number; attempt?: number; attempts?: number }[]; // cadeia de retries
  totalRequested?: number;   // personagens que passaram nos filtros
  analyzedCount?: number;    // analisados com sucesso
  recoveredCount?: number;   // recuperados no retry final
  failedCount?: number;      // falhas definitivas
  failedCharacters?: { id: string; name: string; url: string }[]; // links das falhas
  isPartialRun?: boolean;    // listagem incompleta (páginas que não responderam)
  stoppedManually?: boolean; // encerrada pelo botão "Concluir agora"
  // ── Listagem inicial ──────────────────────────────────────────────────────
  filteredCount?: number;    // personagens que passaram nos filtros
  pagesScanned?: number;     // páginas da listagem efetivamente lidas
  stoppedEarly?: boolean;    // parou ao ultrapassar o limite de encerramento
}

interface BazaarOpenedLinksState {
  opened: Record<string, number>;
  lastOpenedAuctionId: string;
}

interface LocalBazaarNotification {
  id: string;
  title: string;
  body: string;
  url?: string;
  expiresAtMs?: number;
  /**
   * ID do leilão (mesma forma do getAuctionKey da lista) — usado para exibir
   * o status de abertura do link na própria notificação, reutilizando o
   * controle de aberturas da lista (openedLinksState).
   */
  auctionId?: string;
}

const BAZAR_CACHE_KEY = "rubinot_bazaar_last_result";
const BAZAR_DETAILS_CACHE_KEY = "rubinot_bazaar_details_cache";
const BAZAR_FILTERS_KEY = "rubinot_bazaar_filters";
const BAZAR_LAST_SUMMARY_KEY = "rubinot_bazaar_last_summary";
const BAZAR_TABLE_FILTERS_KEY = "rubinot_bazaar_table_filters";
const BAZAR_HIDE_ENDED_KEY = "rubinot_bazaar_hide_ended_auctions";
const BAZAR_OPENED_LINKS_KEY_PREFIX = "rubinot_bazaar_opened_links";
// Valor pessoal por usuário: guarda apenas a última conta escolhida no fluxo
// de compra inline, sem criar configuração de perfil nem estrutura de contas.
const BAZAR_LAST_PURCHASE_ACCOUNT_KEY_PREFIX = "rubinot_bazaar_last_purchase_account";
const BAZAR_ENDED_VISIBILITY_GRACE_SECONDS = 5 * 60;
const BAZAR_DETAILS_TTL_MS = 6 * 60 * 60 * 1000;
const BAZAR_DETAILS_ERROR_TTL_MS = 10 * 60 * 1000;

const VOCATIONS = ["Elite Knight", "Royal Paladin", "Master Sorcerer", "Elder Druid", "Exalted Monk"];
// Opções de fuso do seletor (UTC-12 a UTC+14). O VALOR INICIAL do seletor vem
// do fuso do DISPOSITIVO (getDeviceTimezoneOffsetMinutes) quando o usuário
// nunca configurou — não de uma constante fixa.
const BAZAR_TIMEZONE_OPTIONS = Array.from({ length: 27 }, (_, index) => {
  const hour = index - 12;
  const absHour = Math.abs(hour).toString().padStart(2, "0");
  return {
    value: hour * 60,
    label: `UTC${hour >= 0 ? "+" : "-"}${absHour}`,
  };
});

type ServerSelectionMode = "all" | "custom";
type QuestFilter = "all" | "available" | "completed";
type SortKey = "name" | "vocation" | "level" | "server" | "bid" | "auctionEndTs";
type SortDir = "asc" | "desc";

type VocationLevelFilters = Record<string, { min: string; max: string }>;

interface BazarSavedFilters {
  search?: string;
  serverFilter?: string;
  serverSelectionMode?: ServerSelectionMode;
  selectedServers?: string[];
  vocationLevels?: VocationLevelFilters;
  maxValue?: string;
  soulwarFilter?: QuestFilter;
  sanguineFilter?: QuestFilter;
  endUntil?: string;
  timezoneOffsetMinutes?: number;
  /** Minutos de antecedência da notificação de encerramento (1 a 60). */
  notifyBeforeMinutes?: number;
  // ── MODO DO "ENCERRA ATÉ" ─────────────────────────────────────────────────
  // "manual"     -> usa a data/hora fixa de `endUntil` (comportamento original).
  // "automatico" -> ignora `endUntil` e calcula, NO MOMENTO DA CONSULTA,
  //                 "amanhã às HH:MM" a partir de `endUntilAutoTime`.
  //
  // A DATA nunca é persistida no modo automático — só o horário. É isso que
  // impede o filtro de congelar num dia antigo.
  endUntilMode?: BazaarEndUntilMode;
  /** Horário do modo automático, no formato "HH:MM". */
  endUntilAutoTime?: string;
}

/** Modo do campo "Encerra até". Padrão `manual` (comportamento atual). */
type BazaarEndUntilMode = "manual" | "automatico";

/** Horário usado quando o modo automático é ativado sem configuração prévia. */
const DEFAULT_END_UNTIL_AUTO_TIME = "11:00";

interface BazarConsultationFilters {
  serverSelectionMode: ServerSelectionMode;
  selectedServers: string[];
  vocationLevels: VocationLevelFilters;
  maxValue: string;
  soulwarFilter: QuestFilter;
  sanguineFilter: QuestFilter;
  endUntil: string;
  timezoneOffsetMinutes: number;
}

interface BazaarTableFilters {
  name: string;
  vocations: string[];
  servers: string[];
  levelValue: number | null;
  levelOperator: "gte" | "lte";
  bidValue: number | null;
  bidOperator: "gte" | "lte";
  endUntil: string;
  /** Exibe apenas leilões marcados como interesse pelo usuário logado. */
  onlyMyInterests: boolean;
}

function defaultVocationFilters(): VocationLevelFilters {
  return VOCATIONS.reduce((acc, vocation) => {
    acc[vocation] = { min: "", max: "" };
    return acc;
  }, {} as VocationLevelFilters);
}

function readSavedBazarFilters(): BazarSavedFilters {
  try {
    const raw = localStorage.getItem(BAZAR_FILTERS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveBazarFilters(filters: BazarSavedFilters) {
  try {
    localStorage.setItem(BAZAR_FILTERS_KEY, JSON.stringify(filters));
  } catch {}
}

function readBazarLastSummary(): BazarLastSummary | null {
  try {
    const raw = localStorage.getItem(BAZAR_LAST_SUMMARY_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && Number.isFinite(parsed.completedAtMs) && Number.isFinite(parsed.durationMs) ? parsed : null;
  } catch {
    return null;
  }
}

function saveBazarLastSummary(summary: BazarLastSummary) {
  try {
    localStorage.setItem(BAZAR_LAST_SUMMARY_KEY, JSON.stringify(summary));
  } catch {}
}

function defaultBazaarOpenedLinksState(): BazaarOpenedLinksState {
  return { opened: {}, lastOpenedAuctionId: "" };
}

function getBazaarOpenedLinksKey(uid?: string): string {
  return `${BAZAR_OPENED_LINKS_KEY_PREFIX}_${uid || "local"}`;
}

function getBazaarLastPurchaseAccountKey(uid?: string): string {
  return uid ? `${BAZAR_LAST_PURCHASE_ACCOUNT_KEY_PREFIX}_${uid}` : "";
}

function readBazaarLastPurchaseAccount(uid?: string): string {
  const key = getBazaarLastPurchaseAccountKey(uid);
  if (!key) return "";
  const stored = loadUIState<unknown>(key, "");
  return typeof stored === "string" ? stored.trim().slice(0, 40) : "";
}

function saveBazaarLastPurchaseAccount(uid: string | undefined, account: string) {
  const key = getBazaarLastPurchaseAccountKey(uid);
  const normalized = String(account || "").trim().slice(0, 40);
  if (!key || !normalized) return;
  saveUIState(key, normalized);
}

function readBazaarOpenedLinksState(uid?: string): BazaarOpenedLinksState {
  try {
    const raw = localStorage.getItem(getBazaarOpenedLinksKey(uid));
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object") return defaultBazaarOpenedLinksState();
    return {
      opened: parsed.opened && typeof parsed.opened === "object" && !Array.isArray(parsed.opened) ? parsed.opened : {},
      lastOpenedAuctionId: typeof parsed.lastOpenedAuctionId === "string" ? parsed.lastOpenedAuctionId : "",
    };
  } catch {
    return defaultBazaarOpenedLinksState();
  }
}

function saveBazaarOpenedLinksState(uid: string | undefined, state: BazaarOpenedLinksState) {
  try {
    localStorage.setItem(getBazaarOpenedLinksKey(uid), JSON.stringify(state));
  } catch {}
}

// ============================================================================
// CABEÇALHO FIXO DA TABELA
//
// A tabela usa `border-separate` (border-spacing 0) para que o destaque neon
// das linhas (borda/glow/pulso via `box-shadow` no <tr>) seja renderizado —
// em `border-collapse` o navegador descarta sombras e fundo do elemento
// <thead>/<tr>, o que tornava o efeito das linhas imperceptível.
// O sticky continua aplicado diretamente em cada <th>, que também carrega o
// próprio background (senão as linhas do corpo aparecem por baixo ao rolar).
//
// São duas faixas fixas empilhadas verticalmente:
//   linha 1 (títulos):  top-0    → altura h-10 (40px)
//   linha 2 (filtros):  top-10   → começa exatamente onde a linha 1 termina
//
// O z-index (20) mantém o cabeçalho acima do corpo da tabela, mas abaixo dos
// menus de filtro, que são renderizados via portal com z-[600]/z-[700] em
// FilterTypes.tsx — por isso os dropdowns continuam abrindo por cima.
// ============================================================================
const STICKY_HEAD_CELL_CLASS = "sticky top-0 z-20 bg-[var(--th-bg-base)] shadow-[inset_0_-1px_0_color-mix(in_oklab,var(--th-brand)_80%,transparent)]";
const STICKY_FILTER_CELL_CLASS = "sticky top-10 z-20 bg-[var(--th-bg-base)] shadow-[inset_0_1px_0_color-mix(in_oklab,var(--th-brand)_50%,transparent),inset_0_-1px_0_color-mix(in_oklab,var(--th-brand)_80%,transparent)]";

function defaultBazarTableFilters(): BazaarTableFilters {
  return {
    name: "",
    vocations: [],
    servers: [],
    levelValue: null,
    levelOperator: "gte",
    bidValue: null,
    bidOperator: "lte",
    endUntil: "",
    onlyMyInterests: false,
  };
}

function readBazarTableFilters(): BazaarTableFilters {
  try {
    const raw = localStorage.getItem(BAZAR_TABLE_FILTERS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    const saved = parsed && typeof parsed === "object" ? parsed : {};
    return {
      ...defaultBazarTableFilters(),
      ...saved,
      // Migração segura dos filtros já salvos: só `true` ativa o filtro novo.
      onlyMyInterests: saved.onlyMyInterests === true,
    };
  } catch {
    return defaultBazarTableFilters();
  }
}

function saveBazarTableFilters(filters: BazaarTableFilters) {
  try {
    localStorage.setItem(BAZAR_TABLE_FILTERS_KEY, JSON.stringify(filters));
  } catch {}
}

function readHideEndedAuctionsPreference(): boolean {
  try {
    const raw = localStorage.getItem(BAZAR_HIDE_ENDED_KEY);
    return raw === null ? true : JSON.parse(raw) !== false;
  } catch {
    return true;
  }
}

function saveHideEndedAuctionsPreference(value: boolean) {
  try {
    localStorage.setItem(BAZAR_HIDE_ENDED_KEY, JSON.stringify(value));
  } catch {}
}

function mergeVocationFilters(saved?: VocationLevelFilters): VocationLevelFilters {
  const defaults = defaultVocationFilters();
  Object.entries(saved || {}).forEach(([vocation, value]) => {
    if (defaults[vocation]) defaults[vocation] = { min: value?.min || "", max: value?.max || "" };
  });
  return defaults;
}

function getVocationAbbreviation(vocation: string): string {
  const normalized = vocation.trim().toLowerCase();
  if (normalized === "elder druid" || normalized === "druid") return "ED";
  if (normalized === "elite knight" || normalized === "knight") return "EK";
  if (normalized === "master sorcerer" || normalized === "sorcerer") return "MS";
  if (normalized === "royal paladin" || normalized === "paladin") return "RP";
  if (normalized === "exalted monk" || normalized === "monk") return "MK";
  return vocation || "—";
}

function getVocationBadgeClass(vocation: string): string {
  const abbreviation = getVocationAbbreviation(vocation);
  if (abbreviation === "ED") return "bg-emerald-500/10 border-emerald-500/30 text-emerald-300";
  if (abbreviation === "EK") return "bg-slate-500/10 border-slate-400/30 text-slate-300";
  if (abbreviation === "MS") return "bg-rose-500/10 border-rose-500/30 text-rose-300";
  if (abbreviation === "RP") return "bg-yellow-500/10 border-yellow-500/30 text-yellow-300";
  if (abbreviation === "MK") return "bg-purple-500/10 border-purple-500/30 text-purple-300";
  return "bg-white/5 border-white/10 text-slate-300";
}

/**
 * Estilo da PÍLULA do contador "xN", na mesma paleta de
 * `getVocationBadgeClass`, porém em versão mais leve (fundo e borda mais
 * discretos). O contador precisa ser bem legível, mas o badge da vocação
 * continua sendo o elemento principal da coluna.
 */
function getVocationCountClass(vocation: string): string {
  const abbreviation = getVocationAbbreviation(vocation);
  if (abbreviation === "ED") return "bg-emerald-500/12 border-emerald-500/35 text-emerald-200";
  if (abbreviation === "EK") return "bg-slate-500/12 border-slate-400/35 text-slate-200";
  if (abbreviation === "MS") return "bg-rose-500/12 border-rose-500/35 text-rose-200";
  if (abbreviation === "RP") return "bg-yellow-500/12 border-yellow-500/35 text-yellow-200";
  if (abbreviation === "MK") return "bg-purple-500/12 border-purple-500/35 text-purple-200";
  return "bg-white/5 border-white/15 text-slate-200";
}

function getAuctionVocationCode(vocation: string): Vocation | null {
  const abbreviation = getVocationAbbreviation(vocation);
  return ["EK", "ED", "MS", "RP", "MK"].includes(abbreviation) ? abbreviation as Vocation : null;
}

function normalizeCharacterNameForCompare(name: string | undefined): string {
  return (name || "").trim().toLowerCase();
}

function getAuctionKey(auction: BazaarAuction): string {
  return String(auction.id || auction.url || auction.name || "");
}

/**
 * Valida os dois únicos campos complementados pelo usuário no fluxo inline.
 * `valorPago` é mantido como texto até a confirmação para distinguir campo
 * vazio de um valor informado explicitamente como zero.
 */
function getBazaarInlinePurchaseValidationError(account: string, valorPago: string): string | null {
  if (!account.trim()) return "Informe a conta do personagem.";
  if (!valorPago.trim()) return "Informe o valor pago em RC.";
  if (!/^\d+$/.test(valorPago)) return "O valor pago deve conter somente números.";
  const parsedValue = Number(valorPago);
  if (!Number.isSafeInteger(parsedValue) || parsedValue < 0) return "Informe um valor pago válido.";
  return null;
}

function normalizeAuctionEndTimestamp(ts: number | null): number | null {
  if (!ts || !Number.isFinite(ts)) return null;
  return ts > 1_000_000_000_000 ? Math.floor(ts / 1000) : Math.floor(ts);
}

function formatTimeZoneOffset(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absMinutes = Math.abs(offsetMinutes);
  const hours = Math.floor(absMinutes / 60).toString().padStart(2, "0");
  const minutes = (absMinutes % 60).toString().padStart(2, "0");
  return `UTC${sign}${hours}${minutes === "00" ? "" : `:${minutes}`}`;
}

function parseDateTimeLocalWithOffset(value: string, offsetMinutes: number): number {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) return 0;
  const [, year, month, day, hour, minute] = match;
  const utcMs = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  return Math.floor((utcMs - offsetMinutes * 60 * 1000) / 1000);
}

function formatDateTimeLocalFromConfiguredZoneDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

function getBazarEndUntilAtConfiguredTime(offsetMinutes: number, dayOffsetFromToday: number, hour: number, minute = 0, nowMs = Date.now()): string {
  const nowInConfiguredZone = new Date(nowMs + offsetMinutes * 60 * 1000);
  const target = new Date(Date.UTC(
    nowInConfiguredZone.getUTCFullYear(),
    nowInConfiguredZone.getUTCMonth(),
    nowInConfiguredZone.getUTCDate() + dayOffsetFromToday,
    hour,
    minute,
    0,
    0,
  ));
  return formatDateTimeLocalFromConfiguredZoneDate(target);
}

function getDefaultBazarEndUntil(offsetMinutes: number): string {
  const nowMs = Date.now();
  const nowInConfiguredZone = new Date(nowMs + offsetMinutes * 60 * 1000);
  const currentMinutes = nowInConfiguredZone.getUTCHours() * 60 + nowInConfiguredZone.getUTCMinutes();
  const targetDayOffset = currentMinutes >= 10 * 60 ? 1 : 0;
  return getBazarEndUntilAtConfiguredTime(offsetMinutes, targetDayOffset, 10, 0, nowMs);
}

function getAutoBazarEndUntil(offsetMinutes: number): string {
  return getBazarEndUntilAtConfiguredTime(offsetMinutes, 1, 11, 0);
}

// ============================================================================
// MODO AUTOMÁTICO DO "ENCERRA ATÉ"
// ----------------------------------------------------------------------------
// O usuário configura apenas o HORÁRIO (ex.: "11:00"); a data é sempre o DIA
// SEGUINTE ao de hoje, calculada no instante da consulta.
//
// Por que a data não pode ser persistida: se ela fosse salva junto, o filtro
// congelaria no dia em que foi configurado e, um dia depois, a consulta usaria
// um limite no passado — descartando silenciosamente todos os leilões.
//
// `nowMs` é parâmetro (e não `Date.now()` fixo) para o cálculo ser testável de
// forma determinística em qualquer data.
// ============================================================================

/** Valida e normaliza "HH:MM". Entrada inválida devolve o padrão. */
function normalizeEndUntilAutoTime(value: unknown): string {
  const text = String(value ?? "").trim();
  const match = text.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return DEFAULT_END_UNTIL_AUTO_TIME;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return DEFAULT_END_UNTIL_AUTO_TIME;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return DEFAULT_END_UNTIL_AUTO_TIME;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** Normaliza o modo persistido: qualquer valor inesperado vira "manual". */
function normalizeEndUntilMode(value: unknown): BazaarEndUntilMode {
  return value === "automatico" ? "automatico" : "manual";
}

/**
 * "Encerra até" do modo automático: SEMPRE o próximo dia, no horário dado.
 *
 * Reutiliza `getBazarEndUntilAtConfiguredTime` com `dayOffsetFromToday = 1`,
 * a mesma função que o restante do painel já usa — então o fuso configurado
 * pelo usuário é respeitado exatamente como nos demais cálculos.
 */
function computeAutoEndUntilFromTime(offsetMinutes: number, time: string, nowMs = Date.now()): string {
  const [hourText, minuteText] = normalizeEndUntilAutoTime(time).split(":");
  return getBazarEndUntilAtConfiguredTime(offsetMinutes, 1, Number(hourText), Number(minuteText), nowMs);
}

/**
 * Valor efetivo do "Encerra até", resolvido no momento da chamada.
 *
 * É o ÚNICO ponto que decide entre manual e automático. Tudo o que precisa do
 * limite de encerramento (consulta, parada antecipada, filtro da lista e o
 * resumo de filtros usados) passa por aqui, garantindo um só resultado.
 */
function resolveEffectiveEndUntil(
  mode: BazaarEndUntilMode,
  manualValue: string,
  autoTime: string,
  offsetMinutes: number,
  nowMs = Date.now(),
): string {
  return mode === "automatico"
    ? computeAutoEndUntilFromTime(offsetMinutes, autoTime, nowMs)
    : manualValue;
}

/** "2026-08-17T11:00" -> "17/08/2026 11:00". Vazio devolve "—". */
function formatEndUntilForDisplay(value: string): string {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) return "—";
  const [, year, month, day, hour, minute] = match;
  return `${day}/${month}/${year} ${hour}:${minute}`;
}

function formatAuctionEnd(ts: number | null, offsetMinutes: number): string {
  const normalizedTs = normalizeAuctionEndTimestamp(ts);
  if (!normalizedTs) return "—";
  try {
    const shifted = new Date(normalizedTs * 1000 + offsetMinutes * 60 * 1000);
    const day = String(shifted.getUTCDate()).padStart(2, "0");
    const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
    const hour = String(shifted.getUTCHours()).padStart(2, "0");
    const minute = String(shifted.getUTCMinutes()).padStart(2, "0");
    return `${day}/${month} ${hour}:${minute}`;
  } catch {
    return "—";
  }
}

function isAuctionStillActive(auction: BazaarAuction, nowUnixTs: number): boolean {
  const auctionEndTs = normalizeAuctionEndTimestamp(auction.auctionEndTs);
  if (!auctionEndTs) return true;
  return auctionEndTs > nowUnixTs;
}

function isAuctionVisibleWithEndedGrace(auction: BazaarAuction, nowUnixTs: number): boolean {
  const auctionEndTs = normalizeAuctionEndTimestamp(auction.auctionEndTs);
  if (!auctionEndTs) return true;
  return auctionEndTs + BAZAR_ENDED_VISIBILITY_GRACE_SECONDS > nowUnixTs;
}

function isAuctionEndingSoon(auction: BazaarAuction, nowUnixTs: number): boolean {
  const auctionEndTs = normalizeAuctionEndTimestamp(auction.auctionEndTs);
  if (!auctionEndTs) return false;
  const secondsLeft = auctionEndTs - nowUnixTs;
  return secondsLeft > 0 && secondsLeft <= 5 * 60;
}

function formatDuration(ms: number | null | undefined): string {
  if (!ms || ms < 0 || !Number.isFinite(ms)) return "--:--:--";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600).toString().padStart(2, "0");
  const minutes = Math.floor((totalSeconds % 3600) / 60).toString().padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function formatTimeOfDayWithOffset(ms: number | null | undefined, offsetMinutes: number): string {
  if (!ms || !Number.isFinite(ms)) return "--:--:--";
  const shifted = new Date(ms + offsetMinutes * 60 * 1000);
  const hours = String(shifted.getUTCHours()).padStart(2, "0");
  const minutes = String(shifted.getUTCMinutes()).padStart(2, "0");
  const seconds = String(shifted.getUTCSeconds()).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function formatDateTimeWithOffset(ms: number | null | undefined, offsetMinutes: number): string {
  if (!ms || !Number.isFinite(ms)) return "—";
  const shifted = new Date(ms + offsetMinutes * 60 * 1000);
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const year = shifted.getUTCFullYear();
  const hours = String(shifted.getUTCHours()).padStart(2, "0");
  const minutes = String(shifted.getUTCMinutes()).padStart(2, "0");
  const seconds = String(shifted.getUTCSeconds()).padStart(2, "0");
  return `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`;
}

function getInterestCreatedAtMs(user: any): number {
  // Prefere o carimbo do SERVIDOR (momento real da ação, gravado com
  // serverTimestamp no agregado); cai para o relógio local usado na UI
  // otimista quando o valor do servidor ainda não chegou.
  const seconds = user?.createdAt?.seconds;
  if (Number.isFinite(seconds)) return Number(seconds) * 1000;
  const dateValue = typeof user?.createdAt?.toDate === "function" ? user.createdAt.toDate() : null;
  if (dateValue instanceof Date && Number.isFinite(dateValue.getTime())) return dateValue.getTime();
  if (Number.isFinite(user?.createdAtMs)) return Number(user.createdAtMs);
  return 0;
}

function sortInterestUsers<T extends { createdAtMs?: number }>(users: T[]): T[] {
  return [...users].sort((a, b) => getInterestCreatedAtMs(a) - getInterestCreatedAtMs(b));
}

function openExternal(url: string) {
  try {
    const electronRequire = (window as any).require;
    if (electronRequire) {
      const { shell } = electronRequire("electron");
      shell.openExternal(url);
      return;
    }
  } catch {}
  window.open(url, "_blank", "noopener,noreferrer");
}

async function closeRubinotBrowserFromRenderer(reason: string) {
  try {
    const electronRequire = (window as any).require;
    if (!electronRequire) return;
    const { ipcRenderer } = electronRequire("electron");
    await ipcRenderer.invoke("rubinot-bazaar-close-browser", reason);
  } catch {}
}

function readBazarCache(): BazaarFetchResult | null {
  try {
    const raw = localStorage.getItem(BAZAR_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && Array.isArray(parsed.auctions) ? parsed : null;
  } catch {
    return null;
  }
}

function saveBazarCache(result: BazaarFetchResult) {
  try {
    localStorage.setItem(BAZAR_CACHE_KEY, JSON.stringify(result));
  } catch {}
}

function isDetailsCacheFresh(detail: BazaarDetails | undefined): boolean {
  if (!detail?.fetchedAt) return false;
  const ttl = detail.error ? BAZAR_DETAILS_ERROR_TTL_MS : BAZAR_DETAILS_TTL_MS;
  return Date.now() - detail.fetchedAt < ttl;
}

function readDetailsCache(): Record<string, BazaarDetails> {
  try {
    const raw = localStorage.getItem(BAZAR_DETAILS_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    const fresh: Record<string, BazaarDetails> = {};
    Object.entries(parsed || {}).forEach(([key, value]) => {
      const detail = value as BazaarDetails;
      if (isDetailsCacheFresh(detail)) {
        fresh[key] = detail;
      }
    });
    return fresh;
  } catch {
    return {};
  }
}

function saveDetailsCache(details: Record<string, BazaarDetails>) {
  try {
    localStorage.setItem(BAZAR_DETAILS_CACHE_KEY, JSON.stringify(details));
  } catch {}
}

function getAuctionEmbeddedDetails(auction: BazaarAuction): BazaarDetails | undefined {
  if (auction.soulwarCompleted === undefined && auction.sanguineCompleted === undefined) return undefined;
  return {
    id: getAuctionKey(auction),
    soulwarCompleted: auction.soulwarCompleted ?? null,
    sanguineCompleted: auction.sanguineCompleted ?? null,
    soulWarBossCount: auction.soulWarBossCount ?? 0,
    sanguineBossCount: auction.sanguineBossCount ?? 0,
    soulWarBossTotal: auction.soulWarBossTotal ?? 6,
    sanguineBossTotal: auction.sanguineBossTotal ?? 5,
    fetchedAt: Date.now(),
  };
}

function hydrateDetailsFromAuctions(auctions: BazaarAuction[]): Record<string, BazaarDetails> {
  const details: Record<string, BazaarDetails> = {};
  auctions.forEach(auction => {
    const embedded = getAuctionEmbeddedDetails(auction);
    if (embedded) details[getAuctionKey(auction)] = embedded;
  });
  return details;
}

function mergeAuctionWithQuestDetails(auction: BazaarAuction, detail: BazaarDetails | undefined): BazaarAuction {
  if (!detail) return auction;
  return {
    ...auction,
    soulwarCompleted: detail.soulwarCompleted,
    sanguineCompleted: detail.sanguineCompleted,
    soulWarBossCount: detail.soulWarBossCount ?? 0,
    sanguineBossCount: detail.sanguineBossCount ?? 0,
    soulWarBossTotal: detail.soulWarBossTotal ?? 6,
    sanguineBossTotal: detail.sanguineBossTotal ?? 5,
  };
}

function matchesQuestFilter(detail: BazaarDetails | undefined, filter: QuestFilter, field: "soulwarCompleted" | "sanguineCompleted") {
  if (filter === "all") return true;
  if (!detail || detail[field] === null) return false;
  return filter === "completed" ? detail[field] === true : detail[field] === false;
}

/**
 * Texto da coluna SW/SG.
 *
 * `questRequired` diz se ESTA quest foi exigida pelos filtros. Quando o filtro
 * está em "Todas", a quest nem é consultada — então o certo é "Não verificado",
 * e não "Indisp." (que sugeriria uma tentativa fracassada) nem "Disp." (que
 * seria inventar um resultado).
 */
function formatQuestStatus(
  detail: BazaarDetails | undefined,
  field: "soulwarCompleted" | "sanguineCompleted",
  needsQuestDetails: boolean,
  questRequired = true,
) {
  if (!questRequired) return "Não verificado";
  if (!detail) return needsQuestDetails ? "..." : "—";
  if (detail[field] === true) return "Concl.";
  if (detail[field] === false) return "Disp.";
  return "Indisp.";
}

function getQuestBossCount(detail: BazaarDetails | undefined, field: "soulwarCompleted" | "sanguineCompleted") {
  const current = field === "soulwarCompleted" ? detail?.soulWarBossCount : detail?.sanguineBossCount;
  const total = field === "soulwarCompleted" ? (detail?.soulWarBossTotal ?? 6) : (detail?.sanguineBossTotal ?? 5);
  return { current: Math.max(0, current ?? 0), total };
}

function formatQuestBossCount(detail: BazaarDetails | undefined, field: "soulwarCompleted" | "sanguineCompleted") {
  const { current, total } = getQuestBossCount(detail, field);
  return `${current}/${total}`;
}

function isQuestSuspicious(detail: BazaarDetails | undefined, field: "soulwarCompleted" | "sanguineCompleted"): boolean {
  if (!detail) return false;
  // Quest não verificada (filtro em "Todas") não pode ser suspeita: não houve
  // apuração. `null` aqui significa ausência de dado, não um resultado ruim.
  if (detail[field] === null || detail[field] === undefined) return false;
  const { current, total } = getQuestBossCount(detail, field);
  // FAIXA de suspeita, não um valor único.
  //
  //   Soul War  -> 3/6, 4/6 e 5/6
  //   Sanguine  -> 2/5, 3/5 e 4/5
  //
  // O limite superior é `total - 1` de propósito: com TODOS os bosses a quest
  // está concluída (resultado legítimo, não suspeito). O inferior é o ponto a
  // partir do qual o progresso parcial passa a indicar alta chance de a quest
  // estar indisponível.
  const minSuspicious = field === "soulwarCompleted" ? 3 : 2;
  const expectedTotal = field === "soulwarCompleted" ? 6 : 5;
  if (total !== expectedTotal) return false;
  return current >= minSuspicious && current <= total - 1;
}

function getQuestBossCountClass(detail: BazaarDetails | undefined, field: "soulwarCompleted" | "sanguineCompleted") {
  if (isQuestSuspicious(detail, field)) return "font-mono text-[9px] font-black text-rose-200";
  const { current } = getQuestBossCount(detail, field);
  return current > 0 ? "font-mono text-[9px] font-black text-amber-300" : "font-mono text-[9px] text-slate-500";
}

function QuestBossCounter({ detail, field }: { detail: BazaarDetails | undefined; field: "soulwarCompleted" | "sanguineCompleted" }) {
  if (!detail) return <div className="font-mono text-[9px] text-slate-500">—</div>;
  const { current } = getQuestBossCount(detail, field);
  const hasBosses = current > 0;
  const suspicious = isQuestSuspicious(detail, field);
  const questLabel = field === "soulwarCompleted" ? "Soul War" : "Sanguine";
  const title = suspicious
    ? `${questLabel} suspeita: contador ${formatQuestBossCount(detail, field)} indica alta chance de quest indisponível.`
    : hasBosses
      ? "Este personagem possui bosses encontrados nesta quest."
      : undefined;
  return (
    <div className={`inline-flex items-center justify-center gap-1 rounded px-1 py-0.5 ${suspicious ? "border border-rose-400/45 bg-rose-500/15 shadow-[0_0_10px_color-mix(in_oklab,var(--color-red-600)_18%,transparent)]" : ""} ${getQuestBossCountClass(detail, field)}`} title={title} aria-label={suspicious ? `${questLabel} suspeita: ${formatQuestBossCount(detail, field)}` : hasBosses ? `${formatQuestBossCount(detail, field)} bosses encontrados nesta quest` : formatQuestBossCount(detail, field)}>
      {hasBosses && <AlertTriangle size={10} className={`${suspicious ? "text-rose-200" : "text-amber-300"} flex-shrink-0`} aria-hidden="true" />}
      <span>{formatQuestBossCount(detail, field)}</span>
    </div>
  );
}

function formatProgressMessage(progress: BazaarProgressEvent): string {
  if (progress.total > 0) {
    return `${progress.message} ${progress.percent}% (${progress.processed}/${progress.total})`;
  }
  return progress.message;
}

function isActiveProgress(progress: BazaarProgressEvent | null | undefined): progress is BazaarProgressEvent {
  return !!progress?.active && !!progress.message && (progress.stage === "bazaar" || progress.stage === "details");
}

interface BazaarCharacterPurchase {
  name: string;
  level: number;
  server: string;
  vocation: string;
  account: string;
  valorPago: number;
}

interface BazaarInlinePurchaseDraft {
  auctionKey: string;
  account: string;
  valorPago: string;
  error: string;
  /**
   * Somente apresentação (a lógica de seleção/persistência não muda):
   * `accountPreset` marca a conta pré-preenchida automaticamente com a última
   * utilizada — o campo continua editável normalmente, mas exibe o aviso
   * "confira antes de confirmar" até o usuário tocar nele. `accountSelected`
   * marca a conta escolhida explicitamente na lista de contas.
   */
  accountPreset?: boolean;
  accountSelected?: boolean;
}

interface BazarPanelProps {
  sharedCharacters?: Character[];
  waitingList?: WaitingService[];
  activeParties?: PartyTab[];
  personalCharacters?: Character[];
  /** Contas existentes do usuário atual; derivadas em App.tsx de data.characters. */
  accounts?: string[];
  onAddCharacterFromBazaar?: (character: BazaarCharacterPurchase) => { ok: boolean; error?: string };
}

function BazarPanelContent({ sharedCharacters = [], waitingList = [], activeParties = [], personalCharacters = [], accounts = [], onAddCharacterFromBazaar }: BazarPanelProps) {
  const savedFiltersRef = useRef<BazarSavedFilters>(readSavedBazarFilters());
  const [isLoading, setIsLoading] = useState(false);
  const [isCheckingDetails, setIsCheckingDetails] = useState(false);
  // "Concluir agora": modal aberto e pedido já enviado ao processo principal.
  // `stopRequested` desabilita o botão para não enviar o pedido duas vezes.
  const [isStopConfirmOpen, setIsStopConfirmOpen] = useState(false);
  const [stopRequested, setStopRequested] = useState(false);
  const [result, setResult] = useState<BazaarFetchResult | null>(() => readBazarCache());
  const [detailsCache, setDetailsCache] = useState<Record<string, BazaarDetails>>(() => readDetailsCache());
  const [error, setError] = useState<string | null>(null);
  // Seleção de navegador (somente Electron): o modal abre ao clicar em
  // "Consultar Bazaar" e a consulta só começa após a confirmação.
  const [isBrowserModalOpen, setIsBrowserModalOpen] = useState(false);
  // Popover com os links dos personagens que falharam na última consulta.
  const [isFailuresOpen, setIsFailuresOpen] = useState(false);
  // Aviso de consulta parcial: quais páginas falharam e se a lista parcial
  // chegou a ser publicada. `null` = a última consulta foi completa.
  const [partialNotice, setPartialNotice] = useState<{
    summary: string;
    failedPages: number[];
    loadedPageCount: number;
    totalPages: number;
    published: boolean;
  } | null>(null);
  const [queryStatus, setQueryStatus] = useState("");
  const [queryProgress, setQueryProgress] = useState<BazaarProgressEvent | null>(null);
  // Falhas que irão para o retry, exibidas ao vivo no quadro de progresso.
  const [retryPending, setRetryPending] = useState(0);
  const [isRetryPass, setIsRetryPass] = useState(false);
  // Progresso por navegador e cadeia pendente, exibidos ao vivo.
  const [browserStats, setBrowserStats] = useState<BazaarBrowserProgress[]>([]);
  const [pendingBrowsers, setPendingBrowsers] = useState<{ browser: string; label: string; attempt?: number; attempts?: number }[]>([]);
  // Configuração da consulta, exibida do início ao fim (inclusive nos retries).
  const [speedModeLabel, setSpeedModeLabel] = useState("");
  const [retrySelection, setRetrySelection] = useState<{ browser: string; label: string; attempts?: number }[]>([]);
  const [queryStartMs, setQueryStartMs] = useState<number | null>(null);
  const [queryNowMs, setQueryNowMs] = useState(() => Date.now());
  const [lastSummary, setLastSummary] = useState<BazarLastSummary | null>(() => readBazarLastSummary());
  const [officialMetadata, setOfficialMetadata] = useState<OfficialBazaarMetadata | null>(() => readOfficialBazaarCache()?.metadata || null);
  const [bazaarInterests, setBazaarInterests] = useState<BazaarInterestMap>({});
  const [openedLinksState, setOpenedLinksState] = useState<BazaarOpenedLinksState>(() => defaultBazaarOpenedLinksState());
  // Valor de lance digitado por personagem (rascunho local; nunca persistido
  // e nunca enviado ao RubinOT — serve apenas para montar a URL oficial).
  const [bidDrafts, setBidDrafts] = useState<Record<string, string>>({});
  // Formulário compacto aberto logo abaixo da linha do personagem escolhido.
  // Só guarda os dois dados que não existem no Bazaar; o restante é importado.
  const [inlinePurchase, setInlinePurchase] = useState<BazaarInlinePurchaseDraft | null>(null);
  // Espelho em memória da última conta do usuário. O valor é carregado e salvo
  // por UID com `loadUIState`/`saveUIState`, sobrevivendo ao reinício do app.
  const [lastBazaarPurchaseAccount, setLastBazaarPurchaseAccount] = useState("");
  const [isInlineAccountMenuOpen, setIsInlineAccountMenuOpen] = useState(false);
  const [inlineAccountSearch, setInlineAccountSearch] = useState("");
  const inlineAccountPickerRef = useRef<HTMLDivElement | null>(null);
  const inlineAccountInputRef = useRef<HTMLInputElement | null>(null);
  const inlineValorPagoInputRef = useRef<HTMLInputElement | null>(null);
  const [localBazaarNotifications, setLocalBazaarNotifications] = useState<LocalBazaarNotification[]>([]);
  // ── BID PADRÃO ────────────────────────────────────────────────────────────
  // Valor de lance pré-configurado no quadro "Última consulta". Ativo somente
  // com a caixa marcada E um valor inteiro válido (parseBidAmount, o mesmo
  // gate do campo de lance da linha). Persistido no localStorage junto das
  // demais preferências do Bazaar — nada vai para o Firestore.
  const [defaultBid, setDefaultBid] = useState(() => readBazaarDefaultBid());
  const [defaultBidDraft, setDefaultBidDraft] = useState(() => {
    const saved = readBazaarDefaultBid();
    return saved.amount !== null ? String(saved.amount) : "";
  });
  const defaultBidActive = defaultBid.enabled && defaultBid.amount !== null;
  const [isOfficialSyncing, setIsOfficialSyncing] = useState(false);
  const [tableFilters, setTableFilters] = useState<BazaarTableFilters>(() => readBazarTableFilters());
  const [hideEndedAuctions, setHideEndedAuctions] = useState(() => readHideEndedAuctionsPreference());
  const [isFiltersModalOpen, setIsFiltersModalOpen] = useState(false);
  const [isUsedFiltersOpen, setIsUsedFiltersOpen] = useState(false);
  const [isFriendsSummaryOpen, setIsFriendsSummaryOpen] = useState(false);
  const [isAutoBidOpen, setIsAutoBidOpen] = useState(false);
  const [isFriendsSummaryFiltersOpen, setIsFriendsSummaryFiltersOpen] = useState(false);
  // Filtros compartilhados com a Visao Geral (OverviewPanel). Fonte unica em
  // src/hooks/useOverviewFilters.ts — alterar aqui reflete la na hora.
  const {
    filters: friendsSummaryFilters,
    questFilter: friendsSummaryQuestFilter, setQuestFilter: setFriendsSummaryQuestFilter,
    templateType: friendsSummaryTemplateType, setTemplateType: setFriendsSummaryTemplateType,
    minLevels: friendsSummaryMinLevels, setMinLevels: setFriendsSummaryMinLevels,
    userMode: friendsSummaryUserMode, setUserMode: setFriendsSummaryUserMode,
    selectedUsers: friendsSummarySelectedUsers, setSelectedUsers: setFriendsSummarySelectedUsers,
    useCharacters: friendsSummaryUseCharacters, setUseCharacters: setFriendsSummaryUseCharacters,
    useWaitingList: friendsSummaryUseWaitingList, setUseWaitingList: setFriendsSummaryUseWaitingList,
    resetFilters: resetFriendsSummaryFilters,
  } = useOverviewFilters();
  const [serverSelectionMode, setServerSelectionMode] = useState<ServerSelectionMode>(() => savedFiltersRef.current.serverSelectionMode || (savedFiltersRef.current.serverFilter ? "custom" : "all"));
  const [selectedServers, setSelectedServers] = useState<string[]>(() => savedFiltersRef.current.selectedServers || (savedFiltersRef.current.serverFilter ? [savedFiltersRef.current.serverFilter] : []));
  const [vocationLevels, setVocationLevels] = useState<VocationLevelFilters>(() => mergeVocationFilters(savedFiltersRef.current.vocationLevels));
  const [maxValue, setMaxValue] = useState(() => savedFiltersRef.current.maxValue || "");
  const [soulwarFilter, setSoulwarFilter] = useState<QuestFilter>(() => savedFiltersRef.current.soulwarFilter || "available");
  const [sanguineFilter, setSanguineFilter] = useState<QuestFilter>(() => savedFiltersRef.current.sanguineFilter || "available");
  const [endUntil, setEndUntil] = useState(() => savedFiltersRef.current.endUntil || "");
  // Modo do "Encerra até" e o horário do modo automático. Ambos persistidos;
  // a DATA do modo automático nunca é — ela é calculada a cada consulta.
  const [endUntilMode, setEndUntilMode] = useState<BazaarEndUntilMode>(() => normalizeEndUntilMode(savedFiltersRef.current.endUntilMode));
  const [endUntilAutoTime, setEndUntilAutoTime] = useState(() => normalizeEndUntilAutoTime(savedFiltersRef.current.endUntilAutoTime));
  const [timezoneOffsetMinutes, setTimezoneOffsetMinutes] = useState(() => Number.isFinite(savedFiltersRef.current.timezoneOffsetMinutes) ? Number(savedFiltersRef.current.timezoneOffsetMinutes) : getDeviceTimezoneOffsetMinutes());
  // Antecedência da notificação de encerramento.
  // `applied` é o valor persistido; `draft` é o que está nas setas e só vira
  // `applied` quando o usuário clica em "Aplicar".
  const [notifyBeforeMinutes, setNotifyBeforeMinutes] = useState(() => readBazarNotifyMinutes());
  const [notifyMinutesDraft, setNotifyMinutesDraft] = useState(() => readBazarNotifyMinutes());
  const [notifyMinutesSavedAt, setNotifyMinutesSavedAt] = useState(0);
  const [sortKey, setSortKey] = useState<SortKey>("auctionEndTs");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [checkingDetailsCount, setCheckingDetailsCount] = useState(0);
  const [currentUnixTs, setCurrentUnixTs] = useState(() => Math.floor(Date.now() / 1000));
  const autoBazaarNotificationInFlightRef = useRef<string | null>(null);
  const { currentUser, userProfile } = useAuth();
  // Esta é somente uma projeção visual da fonte de contas já existente no App.
  // Não há coleção/localStorage extra para o fluxo do Bazaar.
  const availableInlineAccounts = useMemo(() => {
    return Array.from(new Set(accounts.map(account => account.trim()).filter(Boolean)))
      .sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [accounts]);
  const filteredInlineAccounts = useMemo(() => {
    const query = inlineAccountSearch.trim().toLocaleLowerCase("pt-BR");
    if (!query) return availableInlineAccounts;
    return availableInlineAccounts.filter(account => account.toLocaleLowerCase("pt-BR").includes(query));
  }, [availableInlineAccounts, inlineAccountSearch]);
  const isElectron = typeof window !== "undefined" && !!(window as any).require;
  const isBossUser = userProfile?.role === "Boss";
  const needsQuestDetails = soulwarFilter !== "all" || sanguineFilter !== "all";
  // Quais quests os filtros atuais realmente exigem. Uma quest em "Todas" não
  // é consultada e a coluna correspondente mostra "Não verificado".
  const soulwarRequired = soulwarFilter !== "all";
  const sanguineRequired = sanguineFilter !== "all";

  useEffect(() => {
    setOpenedLinksState(readBazaarOpenedLinksState(currentUser?.uid));
  }, [currentUser?.uid]);

  // Troca de usuário nunca reaproveita a conta anterior: cada UID possui
  // uma chave própria, restaurada inclusive depois de reiniciar o aplicativo.
  useEffect(() => {
    setLastBazaarPurchaseAccount(readBazaarLastPurchaseAccount(currentUser?.uid));
    setInlinePurchase(null);
    setIsInlineAccountMenuOpen(false);
    setInlineAccountSearch("");
  }, [currentUser?.uid]);

  // O foco acompanha o fluxo: primeira inclusão começa na conta; inclusões
  // seguintes, com última conta preenchida, começam diretamente no valor pago.
  useEffect(() => {
    if (!inlinePurchase) return;
    const timer = window.setTimeout(() => {
      const target = inlinePurchase.account.trim()
        ? inlineValorPagoInputRef.current
        : inlineAccountInputRef.current;
      target?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [inlinePurchase?.auctionKey]);

  useEffect(() => {
    if (!isInlineAccountMenuOpen) return;
    function closeOnOutsidePointer(event: MouseEvent) {
      if (!inlineAccountPickerRef.current?.contains(event.target as Node)) {
        setIsInlineAccountMenuOpen(false);
        setInlineAccountSearch("");
      }
    }
    document.addEventListener("mousedown", closeOnOutsidePointer);
    return () => document.removeEventListener("mousedown", closeOnOutsidePointer);
  }, [isInlineAccountMenuOpen]);

  useEffect(() => {
    const officialCache = readOfficialBazaarCache();
    if (officialCache) {
      const embeddedDetails = hydrateDetailsFromAuctions(officialCache.characters);
      setOfficialMetadata(officialCache.metadata);
      setResult({ ok: true, fetchedAt: officialCache.loadedAtMs, total: officialCache.characters.length, auctions: officialCache.characters });
      setDetailsCache({ ...readDetailsCache(), ...embeddedDetails });
      return;
    }
    const cached = readBazarCache();
    if (cached) {
      setResult(cached);
      setDetailsCache({ ...readDetailsCache(), ...hydrateDetailsFromAuctions(cached.auctions || []) });
      return;
    }
    setDetailsCache(readDetailsCache());
  }, []);

  useEffect(() => {
    const updateCurrentTime = () => setCurrentUnixTs(Math.floor(Date.now() / 1000));
    updateCurrentTime();
    const interval = window.setInterval(updateCurrentTime, 15 * 1000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!queryStartMs) return;
    setQueryNowMs(Date.now());
    const interval = window.setInterval(() => setQueryNowMs(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [queryStartMs]);

  useEffect(() => {
    saveBazarFilters({
      serverSelectionMode,
      selectedServers,
      vocationLevels,
      maxValue,
      soulwarFilter,
      sanguineFilter,
      endUntil,
      timezoneOffsetMinutes,
      // Precisa ser reenviado aqui: saveBazarFilters reescreve o objeto inteiro,
      // então omitir este campo apagaria a preferência já salva.
      notifyBeforeMinutes,
      // Só o MODO e o HORÁRIO são persistidos. A data do modo automático fica
      // deliberadamente de fora, para nunca congelar num dia antigo.
      endUntilMode,
      endUntilAutoTime,
    });
  }, [serverSelectionMode, selectedServers, vocationLevels, maxValue, soulwarFilter, sanguineFilter, endUntil, timezoneOffsetMinutes, notifyBeforeMinutes, endUntilMode, endUntilAutoTime]);

  useEffect(() => {
    saveBazarTableFilters(tableFilters);
  }, [tableFilters]);

  // Esconde a confirmação discreta de "Aplicar" após alguns segundos.
  useEffect(() => {
    if (!notifyMinutesSavedAt) return;
    const timer = window.setTimeout(() => setNotifyMinutesSavedAt(0), 2600);
    return () => window.clearTimeout(timer);
  }, [notifyMinutesSavedAt]);

  // ── FUSO ALTERADO → SINCRONIZA COM O BACKEND ─────────────────────────────
  // O watcher de encerramento (Cloud Function) usa o fuso de
  // `userNotificationPrefs/{uid}.bazaarTimezoneOffsetMinutes` para montar o
  // "Encerra às HH:MM" da notificação. Sem este sync, o backend ficava com o
  // fuso antigo (ou com o default fixo -180) até o próximo login — a hora
  // exibida na notificação divergia da que o usuário vê no painel.
  const lastSyncedTimezoneRef = useRef<number | null>(null);
  useEffect(() => {
    if (lastSyncedTimezoneRef.current === null) {
      lastSyncedTimezoneRef.current = timezoneOffsetMinutes;
      return;
    }
    if (lastSyncedTimezoneRef.current === timezoneOffsetMinutes) return;
    lastSyncedTimezoneRef.current = timezoneOffsetMinutes;
    if (currentUser?.uid) {
      // O efeito de filtros persiste o fuso no localStorage no mesmo commit;
      // o timeout dá tempo dele gravar antes de o sincronizador ler.
      window.setTimeout(() => { void syncNotificationPrefsToCloud(currentUser!.uid); }, 0);
    }
  }, [timezoneOffsetMinutes, currentUser?.uid]);

  useEffect(() => {
    saveHideEndedAuctionsPreference(hideEndedAuctions);
  }, [hideEndedAuctions]);

  

  useEffect(() => {
    if (!isElectron) return;
    try {
      const { ipcRenderer } = (window as any).require("electron");
      const applyProgress = (progress: BazaarProgressEvent) => {
        if (progress && progress.active === false) {
          setIsLoading(false);
          setIsCheckingDetails(false);
          setCheckingDetailsCount(0);
          setQueryProgress(null);
          setQueryStatus("");
          setQueryStartMs(null);
          setRetryPending(0);
          setIsRetryPass(false);
          setBrowserStats([]);
          setPendingBrowsers([]);
          setSpeedModeLabel("");
          setRetrySelection([]);
          return;
        }
        if (!isActiveProgress(progress)) return;
        setQueryProgress(progress);
        // Modo e cadeia de retry chegam em TODO evento — inclusive na
        // listagem —, então ficam visíveis desde o início da consulta.
        if (progress.speedModeLabel) setSpeedModeLabel(progress.speedModeLabel);
        if (progress.retrySelection) setRetrySelection(progress.retrySelection);
        // Só a etapa de detalhes reporta falhas para retry; a listagem não.
        if (progress.stage === "details") {
          setRetryPending(Math.max(0, Number(progress.retryPending || 0)));
          setIsRetryPass(progress.isRetryPass === true);
          setBrowserStats(progress.browserStats || []);
          setPendingBrowsers(progress.pendingBrowsers || []);
        }
        setQueryStatus(formatProgressMessage(progress));
        setQueryStartMs(progress.startedAt || Date.now());
        setQueryNowMs(Date.now());
        setIsLoading(progress.stage === "bazaar");
        setIsCheckingDetails(progress.stage === "details");
        if (progress.total > 0) {
          setCheckingDetailsCount(progress.total);
        }
      };
      const handleProgress = (_event: unknown, progress: BazaarProgressEvent) => applyProgress(progress);
      ipcRenderer.on("rubinot-bazaar-progress", handleProgress);
      ipcRenderer.invoke("rubinot-bazaar-current-progress")
        .then((progress: BazaarProgressEvent) => applyProgress(progress))
        .catch(() => {});
      return () => {
        ipcRenderer.removeListener("rubinot-bazaar-progress", handleProgress);
      };
    } catch {
      return;
    }
  }, [isElectron]);

  useEffect(() => {
    syncOfficialBazaarList({ force: false }).then(response => {
      if (response.cache) {
        setOfficialMetadata(response.cache.metadata);
        setResult({ ok: true, fetchedAt: response.cache.loadedAtMs, total: response.cache.characters.length, auctions: response.cache.characters });
        setDetailsCache(prev => ({ ...prev, ...hydrateDetailsFromAuctions(response.cache?.characters || []) }));
        // Leitura única do documento agregado; respeita o cache de 1h.
        syncBazaarInterests(response.cache.version, { force: false }).then(interestResponse => {
          if (!interestResponse.error) {
            setBazaarInterests(interestResponse.interests);
            // Alimenta o agendador LOCAL de encerramento (dispositivo).
            syncBazaarEndingAlerts({
              characters: response.cache!.characters,
              interestsByAuctionId: interestResponse.interests,
              currentUserUid: currentUser?.uid || "",
              bazaarVersion: response.cache!.version,
            });
          }
        }).catch(() => {});
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const handleLocalNotification = (event: Event) => {
      const detail = (event as CustomEvent).detail || {};
      const notification: LocalBazaarNotification = {
        id: String(detail.id || detail.auctionId || `${Date.now()}_${Math.random().toString(36).slice(2)}`),
        title: detail.title || "Leilão encerrando",
        body: detail.body || "Um leilão de interesse está perto de encerrar.",
        url: detail.url,
        expiresAtMs: detail.expiresAtMs,
        // ID do leilão — alimenta o status de abertura do link na notificação
        // (mesma chave/controle da lista de personagens). Fallback: extrai o
        // ID da própria URL do leilão.
        auctionId: String(detail.auctionId || "") || extractBazaarAuctionId(detail.url, "") || undefined,
      };
      setLocalBazaarNotifications(prev => {
        const withoutSame = prev.filter(item => item.id !== notification.id);
        return [...withoutSame, notification].sort((a, b) => (a.expiresAtMs || 0) - (b.expiresAtMs || 0));
      });
    };
    window.addEventListener("bazaar-interest-local-notification", handleLocalNotification);

    // ── SEMEADURA NA MONTAGEM — recupera chips disparados com o painel FECHADO.
    //
    // O agendador local (bazaarInterestNotificationService) dispara o evento
    // "bazaar-interest-local-notification" no MINUTO do alerta. O BazarPanel,
    // porém, é montado condicionalmente (só na janela Bazaar): se o usuário
    // estava em outra janela naquele minuto, o evento se perdia (sem listener)
    // e o reencaminhador do App não repete o despacho (guard por id). A
    // notificação Desktop saía — o caminho do centro vive no App, sempre
    // montado — mas o chip interno nunca aparecia. Este era o defeito.
    //
    // A recuperação usa o que JÁ está persistido: as notificações pendentes
    // do centro (localStorage "tibia_notifications", gravadas pelo hook
    // useNotifications no momento do alerta). Filtra as de encerramento do
    // Bazaar ainda vigentes (leilão não encerrado) e materializa os chips com
    // o MESMO formato/dedup por id do evento normal — sem Firestore, sem
    // estado novo, sem tocar no fluxo Desktop.
    try {
      const nowMs = Date.now();
      const seeded: LocalBazaarNotification[] = loadNotifications()
        .filter(n => n?.type === "bazaar_interest_ending" && Number(n?.scheduledTime || 0) > nowMs)
        .map(n => ({
          id: String(n.id),
          title: n.title || "Leilão encerrando",
          body: n.body || "Um leilão de interesse está perto de encerrar.",
          url: n.url,
          expiresAtMs: Number(n.scheduledTime || 0) || undefined,
          auctionId: String(n.auctionId || "") || extractBazaarAuctionId(n.url || "", "") || undefined,
        }));
      if (seeded.length > 0) {
        setLocalBazaarNotifications(prev => {
          const byId = new Map<string, LocalBazaarNotification>();
          [...seeded, ...prev].forEach(item => byId.set(item.id, item));
          return Array.from(byId.values()).sort((a, b) => (a.expiresAtMs || 0) - (b.expiresAtMs || 0));
        });
      }
    } catch { /* semeadura é acessória — o listener segue funcionando */ }

    return () => {
      window.removeEventListener("bazaar-interest-local-notification", handleLocalNotification);
    };
  }, []);

  useEffect(() => {
    if (localBazaarNotifications.length === 0) return;
    const nowMs = Date.now();
    const nextExpirationMs = localBazaarNotifications.reduce((min, item) => {
      if (!item.expiresAtMs) return min;
      return Math.min(min, item.expiresAtMs);
    }, Number.POSITIVE_INFINITY);
    if (!Number.isFinite(nextExpirationMs)) return;
    const delay = Math.max(0, nextExpirationMs - nowMs);
    const timer = window.setTimeout(() => {
      const currentMs = Date.now();
      setLocalBazaarNotifications(prev => prev.filter(item => !item.expiresAtMs || item.expiresAtMs > currentMs));
    }, delay);
    return () => window.clearTimeout(timer);
  }, [localBazaarNotifications]);

  // Servidores dos "Filtros Consulta": vêm SEMPRE da constante oficial
  // (`src/constants/servers.ts`), na ordem definida lá. Antes a lista era
  // derivada do resultado da última consulta, o que exigia consultar o Bazaar
  // uma vez só para descobrir quais servidores existiam — e deixava o filtro
  // vazio na primeira execução.
  //
  // Servidores já selecionados que não estejam na constante (dados antigos)
  // são preservados no fim, para não sumirem silenciosamente da seleção.
  const serverOptions = useMemo(() => {
    const official = [...SERVER_OPTIONS];
    const extras = selectedServers.filter(server => server && !official.includes(server));
    return [...official, ...extras];
  }, [selectedServers]);

  const tableVocationOptions = useMemo(() => {
    const set = new Set<string>();
    (result?.auctions || []).forEach(auction => { if (auction.vocation) set.add(auction.vocation); });
    return Array.from(set).sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [result]);

  const tableServerOptions = useMemo(() => {
    const set = new Set<string>();
    (result?.auctions || []).forEach(auction => { if (auction.server) set.add(auction.server); });
    return Array.from(set).sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [result]);


  // Prioridade de compra por servidor, em dois níveis.
  // O cálculo vive em buildServerSummaries (fonte única, mesmos filtros do
  // Resumo de Amigos) e é sempre isolado por servidor.
  const priorityVocationsByServer = useMemo(() => {
    const map = new Map<string, { max: Set<Vocation>; normal: Set<Vocation> }>();
    buildServerSummaries(sharedCharacters, waitingList, activeParties, friendsSummaryFilters).forEach(summary => {
      const max = new Set<Vocation>(summary.maxPriorityVocations);
      const normal = new Set<Vocation>(summary.priorityVocations);
      if (max.size > 0 || normal.size > 0) map.set(summary.server, { max, normal });
    });
    return map;
  }, [sharedCharacters, waitingList, activeParties, friendsSummaryFilters]);

  // ============================================================================
  // CONTAGEM POR SERVIDOR + VOCAÇÃO (badge "xN" na coluna VOC)
  //
  // Reaproveita `buildVocationCountsByServer` — a MESMA coleta e os MESMOS
  // filtros que alimentam o Resumo de Amigos — em vez de recriar uma segunda
  // regra de filtragem que poderia divergir.
  //
  // Usa essa função, e NÃO `buildServerSummaries`, porque o Resumo descarta
  // servidores com menos de 3 personagens (`total >= 3`) para não poluir os
  // cards. Esse corte é correto lá, mas aqui produziria "x0" num servidor que
  // de fato tem 2 personagens daquela vocação. A filtragem é idêntica; só o
  // corte de exibição fica de fora.
  //
  // O cálculo roda UMA única vez e produz um mapa `servidor|vocação -> total`,
  // reutilizado por todas as linhas da tabela. Como várias linhas repetem a
  // mesma combinação, isso evita refiltrar a base por linha.
  //
  // A chave usa `serverKey` (nome COMPLETO e canônico): "Grimoria I" jamais se
  // mistura com "Grimoria II"/"III"/"IV", e nomenclaturas antigas do mesmo
  // servidor caem no mesmo balde. Nenhum `includes`/`startsWith` envolvido.
  // ============================================================================
  const vocationCountByServer = useMemo(() => {
    const map = new Map<string, number>();
    const { counts } = buildVocationCountsByServer(sharedCharacters, waitingList, activeParties, friendsSummaryFilters);
    counts.forEach((vocationCounts, server) => {
      const key = serverKey(server);
      if (!key) return;
      (Object.keys(vocationCounts) as Vocation[]).forEach(vocation => {
        map.set(`${key}|${vocation}`, vocationCounts[vocation]);
      });
    });
    return map;
  }, [sharedCharacters, waitingList, activeParties, friendsSummaryFilters]);

  /** Quantos personagens daquela vocação existem NAQUELE servidor, com os filtros atuais. */
  function getVocationCountForAuction(server: string, vocation: Vocation | null): number {
    if (!vocation) return 0;
    const key = serverKey(server);
    if (!key) return 0;
    return vocationCountByServer.get(`${key}|${vocation}`) || 0;
  }

  const personalCharacterNameSet = useMemo(() => {
    return new Set(personalCharacters.map(character => normalizeCharacterNameForCompare(character.personagem)).filter(Boolean));
  }, [personalCharacters]);

  // ============================================================================
  // PRIORIDADE PARA VOCÊ — destaque de compra específico do usuário atual
  // ----------------------------------------------------------------------------
  // Regra (ADITIVA, não interfere nas prioridades atuais do Bazaar):
  //   • a MAIORIA dos amigos filtrados no Resumo de Amigos tem personagem no servidor;
  //   • o usuário atual NÃO tem personagem válido no servidor.
  // Quando vale, o servidor ganha um glow próprio e as vocações mais escassas
  // entre os amigos são marcadas como prioritárias para o usuário comprar.
  //
  // Reutiliza `buildVocationCountsByServer` (a MESMA fonte filtrada do Resumo de
  // Amigos) para os candidatos, e o cálculo é derivado UMA vez por `useMemo` —
  // a tabela apenas consulta conjuntos pré-computados, sem refiltrar por linha.
  // ============================================================================

  // Personagens do usuário atual já alocados em PTs ativas — POR QUEST:
  // mesma regra do Resumo de Amigos (`collectBusyIdsForQuest`), sob o MESMO
  // `friendsSummaryQuestFilter` usado logo abaixo. Estar em PT de Sanguine
  // não "cobre" nem bloqueia o servidor para o alvo Soul War (e vice-versa).
  const activeBusyIds = useMemo(
    () => collectBusyIdsForQuest(activeParties, friendsSummaryQuestFilter),
    [activeParties, friendsSummaryQuestFilter],
  );

  const currentUserName = userProfile?.nome || "Anônimo";
  const currentUserUid = currentUser?.uid || null;

  // Candidatos do Resumo de Amigos — mesma fonte/coleta que alimenta o resumo.
  const friendsSummaryCandidates = useMemo(() => {
    return buildVocationCountsByServer(sharedCharacters, waitingList, activeParties, friendsSummaryFilters).candidates;
  }, [sharedCharacters, waitingList, activeParties, friendsSummaryFilters]);

  // Servidores onde o usuário ATUAL tem personagem válido sob os MESMOS filtros
  // do Resumo de Amigos (Quest + level + vendido + indisponível). É passado à
  // parte porque, com `userMode === "filter"`, os candidatos podem excluir o
  // próprio usuário — a presença dele não pode depender da seleção de amigos.
  const currentUserServerKeys = useMemo(() => {
    // Servidores onde o usuário ATUAL possui personagem VÁLIDO sob os MESMOS
    // filtros do Resumo de Amigos.
    //
    // IMPORTANTE: derivamos de `sharedCharacters` (availableCharactersForParty),
    // que já aplica probableMarkers (soulwar/sanguine → false quando a Quest já
    // foi concluída) e os critérios de visibilidade/disponibilidade — igual ao
    // que o Resumo de Amigos enxerga. Usar `personalCharacters` brutos faria um
    // personagem com Quest já feita "cobrir" o servidor indevidamente,
    // impedindo o destaque "Prioridade para você".
    const set = new Set<string>();
    sharedCharacters.forEach(character => {
      const isOwn = character.ownerUid === currentUserUid
        || (character.ownerName && character.ownerName === currentUserName);
      if (!isOwn) return;
      if (character.vendido || activeBusyIds.has(character.id)) return;
      // Personagem À VENDA não conta como "disponível" para cobrir o servidor.
      if (character.aVenda === true) return;
      if (friendsSummaryQuestFilter === "soulwar" && !character.soulwar) return;
      if (friendsSummaryQuestFilter === "sanguine" && !character.sanguine) return;
      if ((character.level || 0) < (friendsSummaryMinLevels[character.voc] || 0)) return;
      const key = serverKey(character.servidor);
      if (key) set.add(key);
    });
    return set;
  }, [sharedCharacters, currentUserUid, currentUserName, activeBusyIds, friendsSummaryQuestFilter, friendsSummaryMinLevels]);

  // Resultado pré-derivado: servidores em destaque + vocações prioritárias.
  // A decisão de destaque é baseada apenas nos personagens PRÓPRIOS do usuário:
  // servidores do Bazaar onde o usuário não possui personagem válido recebem o
  // destaque "Prioridade para você", independente dos amigos.
  const userPriority = useMemo(() => {
    const bazaarServerKeys = new Set<string>();
    (result?.auctions || []).forEach(auction => {
      if (!auction.server) return;
      const sk = serverKey(auction.server);
      if (sk) bazaarServerKeys.add(sk);
    });
    const resultPriority = computeUserPriority({
      candidates: friendsSummaryCandidates,
      currentUserName,
      currentUserUid,
      userMode: friendsSummaryUserMode,
      selectedUsers: friendsSummarySelectedUsers,
      currentUserServerKeys,
      bazaarServerKeys,
    });
    // DIAGNÓSTICO TEMPORÁRIO
    if (typeof window !== "undefined") {
      try {
        console.log("[UserPriority] diagnostic", {
          uid: currentUserUid,
          currentUserName,
          currentUserServerKeys: [...currentUserServerKeys],
          bazaarServerKeys: [...bazaarServerKeys],
          friendDonesEmBellum: friendsSummaryCandidates.filter(c => serverKey(c.servidor) === "bellum").map(c => c.dono),
          highlighted: [...resultPriority.highlightedServers],
        });
      } catch {}
    }
    return resultPriority;
  }, [friendsSummaryCandidates, currentUserName, currentUserUid, friendsSummaryUserMode, friendsSummarySelectedUsers, currentUserServerKeys, result?.auctions]);

  const baseFilteredAuctions = useMemo(() => {
    const list = result?.auctions || [];
    return list.filter(auction => !hideEndedAuctions || isAuctionVisibleWithEndedGrace(auction, currentUnixTs));
  }, [result, currentUnixTs, hideEndedAuctions]);

  // ── Lista oficial COMPLETA para o Auto Bid ───────────────────────────────
  // A fonte correta dos personagens com Interesse é a LISTA OFICIAL em cache
  // (`readOfficialBazaarCache`), NÃO `result.auctions`: este último reflete a
  // última CONSULTA (que pode estar filtrada por servidor/vocação/quest ou até
  // zerada), e personagens com Interesse fora desse subconjunto nunca
  // apareceriam no modal. A lista oficial contém TODOS os leilões e é a mesma
  // que o `bazaarInterests` referencia.
  const autoBidCharacters = useMemo(() => {
    const cache = readOfficialBazaarCache();
    if (cache?.characters?.length) return cache.characters;
    return result?.auctions || [];
  }, [result, officialMetadata]);

  // ── IDENTIFICAÇÃO NUMÉRICA DA LISTA GERADA (#1, #2, ...) ──────────────────
  // Atribuída na ORDEM da lista gerada (result.auctions) no momento em que a
  // lista chega. Vinculada à LISTA, não ao personagem: filtros, ordenação,
  // re-render e atualizações de dados/detalhes NÃO renumeram — o useMemo só
  // recalcula quando `result` é substituído (nova consulta/geração/nova lista
  // oficial), recomeçando em 1. Totalmente local (derivada da própria lista):
  // zero Firestore, zero Cloud Function.
  const listNumberByAuctionKey = useMemo(() => {
    const map = new Map<string, number>();
    (result?.auctions || []).forEach((auction, index) => {
      const key = getAuctionKey(auction);
      if (key && !map.has(key)) map.set(key, index + 1);
    });
    return map;
  }, [result]);

  const filteredAuctions = useMemo(() => {
    const tableEndLimit = tableFilters.endUntil ? parseDateTimeLocalWithOffset(tableFilters.endUntil, timezoneOffsetMinutes) : 0;
    const filtered = baseFilteredAuctions.filter(auction => {
      if (tableFilters.name.trim() && !auction.name.toLowerCase().includes(tableFilters.name.trim().toLowerCase())) return false;
      if (tableFilters.vocations.length > 0 && !tableFilters.vocations.includes(auction.vocation)) return false;
      if (tableFilters.servers.length > 0 && !tableFilters.servers.includes(auction.server)) return false;
      if (tableFilters.levelValue !== null) {
        if (tableFilters.levelOperator === "gte" && auction.level < tableFilters.levelValue) return false;
        if (tableFilters.levelOperator === "lte" && auction.level > tableFilters.levelValue) return false;
      }
      if (tableFilters.bidValue !== null) {
        if (tableFilters.bidOperator === "gte" && auction.bid < tableFilters.bidValue) return false;
        if (tableFilters.bidOperator === "lte" && auction.bid > tableFilters.bidValue) return false;
      }
      if (tableFilters.onlyMyInterests) {
        const currentUserUid = currentUser?.uid;
        if (!currentUserUid) return false;
        const interestUsers = bazaarInterests[getAuctionKey(auction)] || [];
        if (!interestUsers.some(user => user.uid === currentUserUid)) return false;
      }
      const auctionEndTs = normalizeAuctionEndTimestamp(auction.auctionEndTs);
      if (tableEndLimit > 0 && auctionEndTs && auctionEndTs > tableEndLimit) return false;
      return true;
    });

    filtered.sort((a, b) => {
      const av = a[sortKey] ?? 0;
      const bv = b[sortKey] ?? 0;
      let cmp = 0;
      if (typeof av === "string" || typeof bv === "string") {
        cmp = String(av).localeCompare(String(bv), "pt-BR");
      } else {
        cmp = Number(av || 0) - Number(bv || 0);
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return filtered;
  }, [baseFilteredAuctions, bazaarInterests, currentUser?.uid, sortKey, sortDir, tableFilters, timezoneOffsetMinutes]);

  function setVocationLevel(vocation: string, key: "min" | "max", value: string) {
    setVocationLevels(prev => ({
      ...prev,
      [vocation]: { ...prev[vocation], [key]: value.replace(/\D/g, "") },
    }));
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(prev => prev === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  function getCurrentConsultationFilters(): BazarConsultationFilters {
    return {
      serverSelectionMode,
      selectedServers,
      vocationLevels,
      maxValue,
      soulwarFilter,
      sanguineFilter,
      // ── LIMITE DE ENCERRAMENTO RESOLVIDO AGORA ──────────────────────────
      // No modo automático o valor é calculado NESTE INSTANTE ("amanhã às
      // HH:MM"). Como esta função é chamada no início de cada consulta, a
      // data nunca é reaproveitada de uma execução anterior.
      endUntil: resolveEffectiveEndUntil(endUntilMode, endUntil, endUntilAutoTime, timezoneOffsetMinutes),
      timezoneOffsetMinutes,
    };
  }

  function getApiFilteredAuctions(list: BazaarAuction[], filters: BazarConsultationFilters): BazaarAuction[] {
    const maxCoins = parseInt(filters.maxValue, 10);
    const endLimit = filters.endUntil ? parseDateTimeLocalWithOffset(filters.endUntil, filters.timezoneOffsetMinutes) : 0;

    const nowUnixTs = Math.floor(Date.now() / 1000);

    return list.filter(auction => {
      if (!isAuctionStillActive(auction, nowUnixTs)) return false;
      if (filters.serverSelectionMode === "custom" && !filters.selectedServers.includes(auction.server)) return false;
      const vocRule = filters.vocationLevels[auction.vocation];
      if (!vocRule) return false;
      const minLv = parseInt(vocRule.min, 10);
      const maxLv = parseInt(vocRule.max, 10);
      if (Number.isFinite(minLv) && auction.level < minLv) return false;
      if (Number.isFinite(maxLv) && auction.level > maxLv) return false;
      if (Number.isFinite(maxCoins) && auction.bid > maxCoins) return false;
      const auctionEndTs = normalizeAuctionEndTimestamp(auction.auctionEndTs);
      if (endLimit > 0 && auctionEndTs && auctionEndTs > endLimit) return false;
      return true;
    });
  }

  function getOfficialFiltersSnapshot(filters: BazarConsultationFilters = getCurrentConsultationFilters()) {
    return filters;
  }

  async function handleSyncOfficialBazaar(force = true) {
    const remaining = getManualSyncCooldownRemainingMs();
    if (force && remaining > 0) {
      setError(`Aguarde ${Math.ceil(remaining / 1000)}s para atualizar novamente.`);
      return;
    }
    if (isOfficialSyncing) return;
    setIsOfficialSyncing(true);
    setError(null);
    try {
      if (force) markManualSyncAttempt();
      const response = await syncOfficialBazaarList({ force });
      if (response.cache) {
        setOfficialMetadata(response.cache.metadata);
        setResult({ ok: true, fetchedAt: response.cache.loadedAtMs, total: response.cache.characters.length, auctions: response.cache.characters });
        setDetailsCache(prev => ({ ...prev, ...hydrateDetailsFromAuctions(response.cache?.characters || []) }));
        // "Atualizar" manual: 1 leitura do agregado (antes eram N+1).
        const interests = await syncBazaarInterests(response.cache.version, { force });
        if (!interests.error) {
          setBazaarInterests(interests.interests);
          syncBazaarEndingAlerts({
            characters: response.cache.characters,
            interestsByAuctionId: interests.interests,
            currentUserUid: currentUser?.uid || "",
            bazaarVersion: response.cache.version,
          });
        } else {
          setError(interests.error);
        }
      } else if (response.error) {
        setError(response.error);
      }
    } finally {
      setIsOfficialSyncing(false);
    }
  }

  function openSearchFiltersModal() {
    // O preenchimento automático da data só vale para o modo MANUAL. No modo
    // automático o campo de data nem é usado, e escrever nele aqui deixaria
    // um valor obsoleto pronto para ser exibido caso o usuário voltasse ao
    // manual mais tarde.
    if (endUntilMode === "manual" && !endUntil) {
      setEndUntil(getDefaultBazarEndUntil(timezoneOffsetMinutes));
    }
    setIsFiltersModalOpen(true);
  }

  /**
   * Clique em "Consultar Bazaar": abre o seletor de navegador em vez de
   * iniciar direto. A consulta só começa quando o usuário confirma.
   */
  function requestBazaarQuery() {
    if (!isBossUser) {
      setError("Apenas usuários Boss podem iniciar uma nova consulta do Bazaar.");
      return;
    }
    if (!isElectron) {
      setError("A consulta direta ao Rubinot precisa ser executada no aplicativo Desktop (Electron).");
      return;
    }
    setError(null);
    setIsBrowserModalOpen(true);
  }

  /**
   * Confirmação do "Concluir agora".
   *
   * Apenas SINALIZA o processo principal. Nada é abortado aqui: o laço da
   * consulta lê a bandeira no próximo ponto seguro, encerra sozinho e devolve
   * normalmente o que já analisou. O fluxo de publicação segue o mesmo de
   * sempre — inclusive a proteção da lista oficial.
   */
  async function confirmStopNow() {
    setIsStopConfirmOpen(false);
    if (!isElectron) return;
    try {
      const { ipcRenderer } = (window as any).require("electron");
      setStopRequested(true);
      await ipcRenderer.invoke("rubinot-bazaar-request-stop");
      setQueryStatus("Encerrando a consulta... aguardando o ponto seguro de parada.");
    } catch {
      // Falha ao sinalizar não pode quebrar a consulta em andamento: ela
      // continua normalmente e o botão volta a ficar disponível.
      setStopRequested(false);
    }
  }

  async function handleFetchBazaar(options?: { filtersOverride?: Partial<BazarConsultationFilters>; browserKey?: string; browserOrder?: string[]; cleanProfile?: boolean; retryBrowsers?: string[]; retryCounts?: BazaarRetryCounts; speedMode?: BazaarSpeedMode; method?: BazaarMethod; autoRun?: boolean }) {
    if (!isBossUser) {
      setError("Apenas usuários Boss podem iniciar uma nova consulta do Bazaar.");
      return;
    }
    if (!isElectron) {
      setError("A consulta direta ao Rubinot precisa ser executada no aplicativo Desktop (Electron).");
      return;
    }

    const activeFilters: BazarConsultationFilters = {
      ...getCurrentConsultationFilters(),
      ...(options?.filtersOverride || {}),
    };
    const activeNeedsQuestDetails = activeFilters.soulwarFilter !== "all" || activeFilters.sanguineFilter !== "all";

    // ── MÉTODO DE CONSULTA ────────────────────────────────────────────────
    // Escolhido no modal, antes da consulta. "antigo" (padrão) mantém o fluxo
    // atual byte a byte; "novo" apenas troca o CANAL da fase de detalhes.
    //
    // A listagem, os filtros e todo o tratamento do resultado são os MESMOS
    // nos dois métodos — por isso o fork se resume ao nome do canal IPC.
    const activeMethod: BazaarMethod = normalizeBazaarMethod(
      options?.method || loadUIState<BazaarMethod>(BAZAAR_METHOD_KEY, DEFAULT_BAZAAR_METHOD),
    );
    const detailsChannel = activeMethod === "novo" ? "rubinot-bazaar-details-v2" : "rubinot-bazaar-details";

    const startedAt = Date.now();
    setIsLoading(true);
    setIsCheckingDetails(false);
    setCheckingDetailsCount(0);
    setQueryStartMs(startedAt);
    setQueryNowMs(startedAt);
    setQueryProgress({ stage: "bazaar", message: "Consultando Bazaar...", processed: 0, total: 0, percent: 0 });
    setQueryStatus("Consultando Bazaar...");
    setRetryPending(0);
    setIsRetryPass(false);
    // Consulta nova nasce sem pedido de encerramento pendente.
    setIsStopConfirmOpen(false);
    setStopRequested(false);
    setBrowserStats([]);
    setPendingBrowsers([]);
    setSpeedModeLabel("");
    setRetrySelection([]);
    setError(null);
    setResult(null);
    setDetailsCache({});
    saveDetailsCache({});

    let ipcRenderer: any = null;
    let consultationSucceeded = false;
    try {
      ({ ipcRenderer } = (window as any).require("electron"));

      // Etapa 2: consulta principal do Bazaar. A validação Cloudflare e a fila
      // global ficam no processo principal/Electron.
      setQueryStatus("Buscando personagens...");
      // O navegador escolhido no modal vale para toda a consulta.
      // O limite de encerramento habilita a PARADA ANTECIPADA na listagem:
      // como a API ordena por auction_end asc, ao passar do limite não há mais
      // nada útil nas páginas seguintes.
      const earlyStopEndTs = activeFilters.endUntil
        ? parseDateTimeLocalWithOffset(activeFilters.endUntil, activeFilters.timezoneOffsetMinutes)
        : 0;
      const response = await ipcRenderer.invoke("rubinot-bazaar-fetch", {
        browser: options?.browserKey || loadUIState(BAZAAR_BROWSER_KEY, "webkit"),
        endUntilTs: earlyStopEndTs,
        // Perfil temporário só quando o usuário marcar no modal.
        cleanProfile: options?.cleanProfile === true,
        // Modo de velocidade: vale para a consulta inteira e para os retries.
        speedMode: options?.speedMode || loadUIState<BazaarSpeedMode>(BAZAAR_SPEED_MODE_KEY, "moderado"),
        // Repassados já aqui (e não só na etapa de detalhes) para que o painel
        // de progresso mostre a cadeia de retry desde a listagem.
        browserOrder: options?.browserOrder || loadUIState<string[]>(BAZAAR_BROWSER_ORDER_KEY, DEFAULT_BROWSER_ORDER),
        retryBrowsers: options?.retryBrowsers || loadUIState<string[]>(BAZAAR_RETRY_BROWSERS_KEY, []),
        // Quantidade de retries por navegador: é o que define o plano real.
        retryCounts: options?.retryCounts || normalizeRetryCounts(loadUIState<BazaarRetryCounts | null>(BAZAAR_RETRY_COUNTS_KEY, null)),
        // Auto-Bazaar: a pré-validação de disponibilidade aguarda o servidor
        // (recarga a cada 1 min) em vez de abortar; manual aborta e informa.
        autoRun: options?.autoRun === true,
      }) as BazaarFetchResult;
      // Qualquer falha aqui (rede, Cloudflare, janela fechada, cancelamento)
      // encerra o fluxo ANTES de qualquer escrita no Firestore.
      if (!response?.ok || response?.cancelled) {
        // Pré-validação de disponibilidade: o servidor/site ainda não está
        // pronto (manutenção, página sem carregar ou menos de 1000 jogadores
        // online). Mensagem específica para o Boss, com o número detectado.
        if (response?.serverNotReady) {
          const detected = typeof response.onlineCount === "number" && Number.isFinite(response.onlineCount)
            ? ` Jogadores online detectados: ${response.onlineCount}.`
            : "";
          setError((response.error || "O servidor/site do Bazaar ainda não está pronto para a consulta.") + detected);
          return;
        }
        setError(response?.error || "Não foi possível consultar o Bazaar do Rubinot.");
        // Navegador indisponível: reabre o seletor para escolher outro,
        // em vez de deixar o usuário preso num erro genérico.
        if (response?.browserUnavailable) setIsBrowserModalOpen(true);
        return;
      }
      if (!Array.isArray(response.auctions)) {
        setError("A consulta do Bazaar retornou um resultado incompleto. A lista oficial foi preservada.");
        return;
      }

      // ── Consulta PARCIAL ────────────────────────────────────────────────
      // Algumas páginas da listagem não responderam mesmo após as
      // retentativas. Os personagens coletados são válidos, mas a lista está
      // incompleta — então ela NUNCA substitui a lista oficial em silêncio.
      // Encerramento manual: definido pela resposta da análise individual.
      // Uma consulta encerrada à mão é SEMPRE tratada como parcial.
      let stoppedManuallyRun = false;
      // Parcial por páginas que não responderam. O encerramento manual pode
      // torná-la parcial mais adiante (a análise individual é que informa).
      const listingPartial = response.partial === true;
      let isPartialRun = listingPartial;
      const failedPages = response.failedPageNumbers || [];
      const loadedPageCount = response.loadedPageCount || 0;
      const totalPagesCount = response.totalPages || 0;
      let partialSummary = listingPartial
        ? `Consulta parcial concluída: ${loadedPageCount} de ${totalPagesCount} páginas carregadas. `
          + `${failedPages.length} página(s) não responderam (${formatFailedPages(failedPages)}).`
        : "";
      if (listingPartial) {
        setPartialNotice({
          summary: partialSummary,
          failedPages,
          loadedPageCount,
          totalPages: totalPagesCount,
          published: false,
        });
      } else {
        setPartialNotice(null);
      }

      // Etapa 2.1: lista intermediária apenas com filtros resolvíveis pela API.
      // Esta lista ainda não é exibida quando há filtro de quest ativo.
      const apiFilteredAuctions = getApiFilteredAuctions(response.auctions || [], activeFilters);
      let nextDetailsCache = readDetailsCache();
      let finalAuctions = apiFilteredAuctions;
      // Preenchido apenas quando a análise individual roda (filtros de quest).
      let detailsStats: {
        primaryBrowser: string; retryBrowser: string;
        retryStats: { browser: string; attempted: number; recovered: number; attempt?: number; attempts?: number }[];
        totalRequested: number;
        analyzedCount: number; recoveredCount: number; failedCount: number;
        failedCharacterList: { id: string; name: string; url: string }[];
      } | null = null;

      // Etapa 3: consultas individuais somente para quem passou nos filtros da API.
      if (activeNeedsQuestDetails && apiFilteredAuctions.length > 0) {
        setQueryStatus("Verificando disponibilidade das Quests...");
        setIsCheckingDetails(true);
        setCheckingDetailsCount(apiFilteredAuctions.length);
        // Só as quests realmente exigidas pelos filtros são apuradas. Uma quest
        // em "Todas" não influencia o resultado, então seus bosses nem são
        // consultados — e a coluna correspondente mostra "Não verificado".
        const detailsResponse = await ipcRenderer.invoke(detailsChannel, apiFilteredAuctions, {
          quests: {
            soulwar: activeFilters.soulwarFilter !== "all",
            sanguine: activeFilters.sanguineFilter !== "all",
          },
          // Ordem de preferência que decide a sequência do retry.
          browserOrder: options?.browserOrder || loadUIState<string[]>(BAZAAR_BROWSER_ORDER_KEY, DEFAULT_BROWSER_ORDER),
          // Navegadores marcados para a cadeia de retries. Vazio = retry único.
          retryBrowsers: options?.retryBrowsers || loadUIState<string[]>(BAZAAR_RETRY_BROWSERS_KEY, []),
          // Quantas vezes cada navegador repete os personagens pendentes.
          retryCounts: options?.retryCounts || normalizeRetryCounts(loadUIState<BazaarRetryCounts | null>(BAZAAR_RETRY_COUNTS_KEY, null)),
        }) as BazaarDetailsResponse;
        // Detalhes incompletos = consulta incompleta: nada é publicado.
        // ATENÇÃO: `stoppedManually` NÃO é erro — é encerramento limpo, com
        // `ok: true`, e o que já foi analisado segue o fluxo normal.
        if (!detailsResponse?.ok || detailsResponse?.cancelled) {
          setError(detailsResponse?.error || "Não foi possível concluir a consulta individual das quests.");
          return;
        }

        stoppedManuallyRun = detailsResponse.stoppedManually === true;
        if (stoppedManuallyRun) {
          // Encerramento manual = lista incompleta por definição: existem
          // personagens que sequer foram abertos. Marcar como PARCIAL faz a
          // proteção da lista oficial entrar em ação (confirmação antes de
          // substituir) e o selo de incompleta ser gravado.
          isPartialRun = true;
          const naoAnalisados = detailsResponse.notAnalyzedCount ?? 0;
          const manualSummary =
            `Consulta encerrada manualmente: ${detailsResponse.analyzedCount ?? 0} de `
            + `${detailsResponse.totalRequested ?? apiFilteredAuctions.length} personagens analisados`
            + (naoAnalisados > 0 ? `. ${naoAnalisados} não chegaram a ser verificados.` : ".");
          partialSummary = partialSummary ? `${partialSummary}\n${manualSummary}` : manualSummary;
          setPartialNotice({
            summary: partialSummary,
            failedPages,
            loadedPageCount,
            totalPages: totalPagesCount,
            published: false,
          });
        }

        // Estatísticas da análise individual, exibidas em "Última consulta".
        detailsStats = {
          primaryBrowser: detailsResponse.primaryBrowser || "",
          retryBrowser: detailsResponse.retryBrowser || "",
          retryStats: detailsResponse.retryStats || [],
          totalRequested: detailsResponse.totalRequested ?? apiFilteredAuctions.length,
          analyzedCount: detailsResponse.analyzedCount ?? 0,
          recoveredCount: detailsResponse.recoveredCount ?? 0,
          failedCount: detailsResponse.failedCount ?? 0,
          failedCharacterList: detailsResponse.failedCharacterList || [],
        };

        // ── DIAGNÓSTICO DE REDE ───────────────────────────────────────────
        // Resumo enxuto no console para comparar execuções entre si.
        // Só números; nada é publicado no Firestore.
        console.info("[Bazaar] Resumo da consulta", {
          navegador: detailsStats.primaryBrowser,
          navegadoresRetry: detailsStats.retryStats.length > 0
            ? detailsStats.retryStats.map(r => `${r.browser}:+${r.recovered}/${r.attempted}`).join(" ")
            : "(nenhum)",
          personagensAnalisados: detailsStats.analyzedCount,
          falhas: detailsStats.failedCount,
          taxaSucesso: `${detailsResponse.successRate ?? 0}%`,
          tempoTotalMs: detailsResponse.totalDurationMs ?? 0,
        });

        // Sessão possivelmente expirada: apenas AVISAMOS. O app nunca tenta
        // autenticar sozinho — quem prepara a sessão é o usuário.
        if (detailsResponse.sessionExpired) {
          setError(
            "A sessão do RubinOT parece ter expirado durante a consulta"
            + (detailsResponse.consecutiveFailures ? ` (${detailsResponse.consecutiveFailures} falhas seguidas)` : "")
            + '. Abra "Consultar Bazaar" e use "Preparar sessão do RubinOT" para entrar novamente.',
          );
        }

        nextDetailsCache = { ...nextDetailsCache, ...(detailsResponse.details || {}) };
        saveDetailsCache(nextDetailsCache);
        setDetailsCache(nextDetailsCache);

        finalAuctions = apiFilteredAuctions.filter(auction => {
          const detail = nextDetailsCache[getAuctionKey(auction)];
          if (!matchesQuestFilter(detail, activeFilters.soulwarFilter, "soulwarCompleted")) return false;
          if (!matchesQuestFilter(detail, activeFilters.sanguineFilter, "sanguineCompleted")) return false;
          return true;
        });
      } else {
        setDetailsCache(nextDetailsCache);
      }

      const finalAuctionsWithQuestDetails = finalAuctions.map(auction => mergeAuctionWithQuestDetails(auction, nextDetailsCache[getAuctionKey(auction)]));
      const finalResult: BazaarFetchResult = {
        ...response,
        total: finalAuctionsWithQuestDetails.length,
        auctions: finalAuctionsWithQuestDetails,
      };

      // Etapa 4: somente agora a tabela recebe o resultado final.
      setResult(finalResult);
      saveBazarCache(finalResult);
      const summary: BazarLastSummary = {
        completedAtMs: Date.now(),
        durationMs: Date.now() - startedAt,
        approvedCount: finalAuctionsWithQuestDetails.length,
        isPartialRun,
        stoppedManually: stoppedManuallyRun,
        failedCharacters: detailsStats?.failedCharacterList ?? [],
        filteredCount: apiFilteredAuctions.length,
        pagesScanned: response.pagesScanned ?? 0,
        stoppedEarly: response.stoppedEarly === true,
        ...(detailsStats || {}),
      };
      setLastSummary(summary);
      saveBazarLastSummary(summary);

      // Etapa 5: publicação + limpeza dos interesses. Só chega aqui quando a
      // consulta terminou 100%: lista, metadados e `bazaarInterests` são
      // atualizados num único commit (ver publishOfficialBazaarList).
      if (isBossUser) {
        // ── Proteção da lista oficial ─────────────────────────────────────
        // Consulta completa publica direto, como sempre. Consulta PARCIAL
        // exige confirmação explícita do Boss: a lista local já está na tela,
        // e a oficial permanece intacta se ele recusar. Assim nunca trocamos
        // uma lista completa por uma menor sem que alguém decida isso.
        let mayPublish = true;

        // ── LISTA VAZIA APÓS ENCERRAMENTO MANUAL ──────────────────────────
        // Nenhum personagem sobreviveu aos filtros/análise. Publicar isso
        // apagaria uma lista oficial válida e a trocaria por nada. Avisamos e
        // NÃO publicamos — o resultado (vazio) continua visível só aqui.
        if (finalAuctionsWithQuestDetails.length === 0) {
          mayPublish = false;
          const motivo = stoppedManuallyRun
            ? "A consulta foi encerrada antes que algum personagem fosse analisado com sucesso."
            : "Nenhum personagem passou pelos filtros desta consulta.";
          setError(
            `${motivo} A lista oficial atual`
            + (typeof officialMetadata?.totalCharacters === "number"
              ? ` (${officialMetadata.totalCharacters} personagens)`
              : "")
            + " foi preservada e nada foi publicado.",
          );
        } else if (isPartialRun) {
          mayPublish = window.confirm(
            `${partialSummary}\n\n`
            + `Publicar assim mesmo substituirá a lista oficial (${officialMetadata?.totalCharacters ?? "?"} personagens) `
            + `por esta lista parcial de ${finalAuctionsWithQuestDetails.length}.\n\n`
            + `• OK  = publicar como PARCIAL (fica marcada como incompleta)\n`
            + `• Cancelar = manter a lista oficial atual e ver esta apenas aqui\n\n`
            + `Recomendado: Cancelar e refazer a consulta mais tarde.`,
          );
        }

        if (!mayPublish) {
          // Lista oficial preservada; o resultado parcial segue visível só localmente.
          setPartialNotice(prev => (prev ? { ...prev, published: false } : prev));
        } else {
          const published = await publishOfficialBazaarList({
            characters: finalAuctionsWithQuestDetails,
            durationMs: summary.durationMs,
            generatedByUid: currentUser?.uid || "",
            generatedByName: userProfile?.nome || "Boss",
            filters: getOfficialFiltersSnapshot(activeFilters),
            partial: isPartialRun,
            loadedPageCount,
            totalPages: totalPagesCount,
            failedPageNumbers: failedPages,
            // Vai junto da lista oficial, no MESMO commit — sem consulta extra.
            failedCharacters: detailsStats?.failedCount ?? 0,
            failedCharacterList: detailsStats?.failedCharacterList ?? [],
          });
          if (published) {
            setOfficialMetadata(published.metadata);
            // Etapa 6: consulta nova nasce LIMPA — o agregado foi zerado no
            // MESMO commit da publicação (rotação diária: interesses da
            // consulta anterior morrem no publish; cada usuário remarca).
            setBazaarInterests({});
            // Nova consulta publicada: o agregado global foi zerado no mesmo
            // commit; o agendador local também recomeça vazio (a versão nova
            // zera o registro de alertas enviados deste dispositivo).
            syncBazaarEndingAlerts({
              characters: finalAuctionsWithQuestDetails,
              interestsByAuctionId: {},
              currentUserUid: currentUser?.uid || "",
              bazaarVersion: published.metadata.version,
            });
            consultationSucceeded = !isPartialRun;
            if (isPartialRun) setPartialNotice(prev => (prev ? { ...prev, published: true } : prev));
          }
        }
      }
    } catch (err: any) {
      setError(err?.message || "Erro ao consultar o Bazaar.");
    } finally {
      if (ipcRenderer) {
        await closeRubinotBrowserFromRenderer("consulta-bazar-finalizada");
      }
      setIsLoading(false);
      setIsCheckingDetails(false);
      setCheckingDetailsCount(0);
      setQueryStatus("");
      setQueryProgress(null);
      setQueryStartMs(null);
      // Botão "Concluir agora" volta ao estado inicial junto com o quadro de
      // progresso, que some quando `isLoading`/`isCheckingDetails` zeram.
      setIsStopConfirmOpen(false);
      setStopRequested(false);
      if (consultationSucceeded && autoBazaarNotificationInFlightRef.current) {
        window.dispatchEvent(new CustomEvent("auto-bazaar-success", { detail: { notificationId: autoBazaarNotificationInFlightRef.current } }));
      }
      autoBazaarNotificationInFlightRef.current = null;
    }
  }

  useEffect(() => {
    function handleAutoBazaarRun(event: Event) {
      if (!isBossUser || !isElectron || isLoading || isCheckingDetails) return;
      const notificationId = (event as CustomEvent).detail?.notificationId;
      if (!notificationId) return;
      autoBazaarNotificationInFlightRef.current = String(notificationId);
      handleFetchBazaar({
        filtersOverride: {
          endUntil: getAutoBazarEndUntil(timezoneOffsetMinutes),
        },
        // Consulta iniciada automaticamente: a pré-validação de disponibilidade
        // aguarda o servidor ficar pronto (recarga a cada 1 min) em vez de
        // abortar — nenhuma ação manual é necessária.
        autoRun: true,
      });
    }
    window.addEventListener("auto-bazaar-run-request", handleAutoBazaarRun);
    return () => window.removeEventListener("auto-bazaar-run-request", handleAutoBazaarRun);
  }, [isBossUser, isElectron, isLoading, isCheckingDetails, serverSelectionMode, selectedServers, vocationLevels, maxValue, soulwarFilter, sanguineFilter, endUntil, timezoneOffsetMinutes]);

  function updateTableFilters(patch: Partial<BazaarTableFilters>) {
    setTableFilters(prev => ({ ...prev, ...patch }));
  }

  function closeInlinePurchase() {
    setInlinePurchase(null);
    setIsInlineAccountMenuOpen(false);
    setInlineAccountSearch("");
  }

  function openInlinePurchase(auctionKey: string) {
    // O fallback de leitura cobre o primeiro clique que ocorrer antes de o
    // efeito de hidratação do usuário ter sido executado.
    const persistedAccount = lastBazaarPurchaseAccount || readBazaarLastPurchaseAccount(currentUser?.uid);
    setInlinePurchase({
      auctionKey,
      account: persistedAccount,
      valorPago: "",
      error: "",
      // A conta herdada da última compra fica marcada como pré-preenchida:
      // o campo pulsa suavemente e carrega o aviso "última usada" até o
      // usuário conferi-la/alterá-la (prevenção de conta incorreta).
      accountPreset: !!persistedAccount.trim(),
      accountSelected: false,
    });
    setIsInlineAccountMenuOpen(false);
    setInlineAccountSearch("");
  }

  function rememberBazaarPurchaseAccount(account: string) {
    const normalized = String(account || "").trim();
    if (!normalized) return;
    setLastBazaarPurchaseAccount(normalized);
    saveBazaarLastPurchaseAccount(currentUser?.uid, normalized);
  }

  function selectInlinePurchaseAccount(auctionKey: string, account: string) {
    const selectedAccount = account.trim();
    setInlinePurchase(current => current?.auctionKey === auctionKey
      ? { ...current, account: selectedAccount, error: "", accountPreset: false, accountSelected: true }
      : current);
    // Uma seleção é uma intenção explícita: persiste por usuário imediatamente,
    // sem precisar aguardar a confirmação da inclusão atual.
    rememberBazaarPurchaseAccount(selectedAccount);
    setIsInlineAccountMenuOpen(false);
    setInlineAccountSearch("");
    window.setTimeout(() => inlineValorPagoInputRef.current?.focus(), 0);
  }

  function resetTableFilters() {
    setTableFilters(defaultBazarTableFilters());
  }

  const isNotifyMinutesDirty = notifyMinutesDraft !== notifyBeforeMinutes;

  function stepNotifyMinutesDraft(delta: number) {
    setNotifyMinutesDraft(prev => clampBazarNotifyMinutes(prev + delta));
  }

  function applyNotifyMinutes() {
    const value = clampBazarNotifyMinutes(notifyMinutesDraft);
    setNotifyMinutesDraft(value);
    setNotifyBeforeMinutes(value);
    setNotifyMinutesSavedAt(Date.now());
    // A detecção de encerramento roda no BACKEND (Cloud Function a cada
    // minuto) — o novo tempo precisa valer lá. O sincronizador lê o
    // localStorage já persistido, então o setTimeout de antes não é preciso;
    // a gravação local acontece no efeito de filtros antes do próximo render.
    if (currentUser?.uid) {
      window.setTimeout(() => { void syncNotificationPrefsToCloud(currentUser!.uid); }, 0);
    }
  }

  function markBazaarLinkOpened(auctionKey: string) {
    if (!auctionKey) return;
    setOpenedLinksState(prev => {
      const next = {
        opened: { ...prev.opened, [auctionKey]: Date.now() },
        lastOpenedAuctionId: auctionKey,
      };
      saveBazaarOpenedLinksState(currentUser?.uid, next);
      return next;
    });
  }

  function getBazaarLinkState(auctionKey: string): "open" | "opened" | "last" {
    if (!auctionKey) return "open";
    if (openedLinksState.lastOpenedAuctionId === auctionKey) return "last";
    return openedLinksState.opened[auctionKey] ? "opened" : "open";
  }

  function openAuctionLink(auction: BazaarAuction) {
    const auctionKey = getAuctionKey(auction);
    markBazaarLinkOpened(auctionKey);
    openExternal(auction.url);
  }

  function setBidDraft(auctionKey: string, raw: string) {
    if (!auctionKey) return;
    const digits = sanitizeBidInput(raw);
    setBidDrafts(prev => {
      if ((prev[auctionKey] || "") === digits) return prev;
      const next = { ...prev };
      if (digits) next[auctionKey] = digits;
      else delete next[auctionKey];
      return next;
    });
  }

  // ── BID PADRÃO: handlers do quadro "Última consulta" ──────────────────────
  /** Marca/desmarca a caixa; o valor digitado é validado e persistido junto. */
  function toggleDefaultBid(nextEnabled: boolean) {
    const next = { enabled: nextEnabled, amount: parseBidAmount(defaultBidDraft) };
    saveBazaarDefaultBid(next);
    setDefaultBid(next);
  }

  /** Digitação do valor: apenas dígitos (mesma sanitização da linha). */
  function changeDefaultBidDraft(raw: string) {
    const digits = sanitizeBidInput(raw);
    setDefaultBidDraft(digits);
    setDefaultBid(prev => {
      const next = { enabled: prev.enabled, amount: parseBidAmount(digits) };
      saveBazaarDefaultBid(next);
      return next;
    });
  }

  /**
   * Abre a página oficial de lance do personagem com o valor já na URL.
   * Prioridade (resolveBazaarBid): valor INDIVIDUAL da linha, se preenchido
   * com valor válido; campo individual vazio cai para o Bid Padrão ativo
   * (fallback); sem valor válido, nada é aberto. O campo individual nunca é
   * bloqueado ou sobrescrito pelo padrão. Nenhum lance é executado aqui: o
   * usuário confirma no próprio site.
   */
  function openAuctionBidPage(auction: BazaarAuction) {
    const auctionKey = getAuctionKey(auction);
    const resolution = resolveBazaarBid(bidDrafts[auctionKey] || "", defaultBid);
    if (resolution.amount === null) return;
    const bidUrl = buildBazaarBidUrl(auction.url, auction.id, String(resolution.amount));
    if (!bidUrl) return;
    markBazaarLinkOpened(auctionKey);
    openExternal(bidUrl);
  }


  const hasActiveTableFilters = !!(
    tableFilters.name.trim() ||
    tableFilters.vocations.length > 0 ||
    tableFilters.servers.length > 0 ||
    tableFilters.levelValue !== null ||
    tableFilters.bidValue !== null ||
    !!tableFilters.endUntil ||
    tableFilters.onlyMyInterests
  );

  const activeElapsedMs = queryStartMs ? Math.max(0, queryNowMs - queryStartMs) : 0;
  const activeProcessed = queryProgress?.processed || 0;
  const activeTotal = queryProgress?.total || 0;
  const activePercent = activeTotal > 0 ? Math.min(100, Math.max(0, queryProgress?.percent ?? Math.round((activeProcessed / activeTotal) * 100))) : 0;
  const estimatedRemainingMs = queryStartMs && activeProcessed > 0 && activeTotal > activeProcessed
    ? (activeElapsedMs / activeProcessed) * (activeTotal - activeProcessed)
    : activeTotal > 0 && activeProcessed >= activeTotal
      ? 0
      : null;
  const estimatedCompletionMs = estimatedRemainingMs !== null ? queryNowMs + estimatedRemainingMs : null;

  // Quando há lista oficial, o quadro reflete os METADADOS publicados — é o
  // que todos os usuários recebem. Antes só 3 campos eram repassados aqui, e
  // as estatísticas da análise ficavam visíveis apenas para quem rodou a
  // consulta (via `lastSummary`, que é local). Agora `failedCharacters` vem do
  // Firestore, então a contagem de falhas aparece para todo mundo.
  const displayedLastSummary: BazarLastSummary | null = officialMetadata
    ? {
      completedAtMs: officialMetadata.generatedAtMs,
      durationMs: officialMetadata.durationMs,
      approvedCount: officialMetadata.totalCharacters,
      failedCount: officialMetadata.failedCharacters ?? 0,
      failedCharacters: officialMetadata.failedCharacterList ?? [],
      // Demais estatísticas seguem sendo locais (só de quem consultou).
      ...(lastSummary && lastSummary.completedAtMs === officialMetadata.generatedAtMs
        ? {
          primaryBrowser: lastSummary.primaryBrowser,
          retryBrowser: lastSummary.retryBrowser,
          retryStats: lastSummary.retryStats,
          totalRequested: lastSummary.totalRequested,
          recoveredCount: lastSummary.recoveredCount,
          filteredCount: lastSummary.filteredCount,
          pagesScanned: lastSummary.pagesScanned,
          stoppedEarly: lastSummary.stoppedEarly,
          stoppedManually: lastSummary.stoppedManually,
        }
        : {}),
    }
    : lastSummary;

  function SortHeader({ label, column }: { label: string; column: SortKey; align?: "left" | "center" | "right" }) {
    return (
      <th className={`${STICKY_HEAD_CELL_CLASS} h-10 px-1 py-2 text-center align-middle cursor-pointer select-none`} onClick={() => toggleSort(column)}>
        <span className="inline-flex w-full items-center justify-center gap-1 leading-none">
          {label}
          <ArrowDownUp size={10} className={sortKey === column ? "text-amber-400" : "text-slate-600"} />
        </span>
      </th>
    );
  }

  return (
    <div className="h-full w-full overflow-hidden relative bg-cover bg-center" style={{ backgroundImage: `url(${bazarBgUrl})` }}>
      <div className="absolute inset-0 bg-[var(--th-n-panel)]/85 pointer-events-none" />
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-[12%] left-[10%] w-[35%] h-[35%] rounded-full bg-amber-500/5 blur-[100px]" />
        <div className="absolute bottom-[10%] right-[12%] w-[35%] h-[35%] rounded-full bg-red-500/5 blur-[100px]" />
      </div>

      <div className="relative z-10 h-full flex flex-col p-1.5 gap-1.5">
        <div className="relative mx-auto w-full max-w-3xl flex items-center justify-center overflow-hidden rounded-2xl border border-amber-500/35 bg-[linear-gradient(135deg,color-mix(in_oklab,var(--th-brand)_94%,transparent),color-mix(in_oklab,var(--th-brand)_72%,transparent),color-mix(in_oklab,var(--th-brand)_94%,transparent))] backdrop-blur-md px-3 py-2 shadow-[0_14px_36px_rgba(0,0,0,0.34),0_0_28px_color-mix(in_oklab,var(--color-amber-500)_10%,transparent)] min-h-[46px] transition-all duration-500">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,color-mix(in_oklab,var(--color-amber-500)_18%,transparent),transparent_55%)]" />
          <div className="pointer-events-none absolute left-1/2 top-0 h-px w-2/3 -translate-x-1/2 bg-gradient-to-r from-transparent via-amber-300/60 to-transparent" />
          <div className="pointer-events-none absolute -inset-px rounded-2xl border border-amber-300/10 animate-pulse" style={{ animationDuration: "3.6s" }} />
          <div className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-8 h-8 rounded-xl bg-gradient-to-br from-amber-400/18 via-amber-800/18 to-red-950/55 border border-amber-400/35 flex items-center justify-center shadow-[0_0_18px_color-mix(in_oklab,var(--color-amber-500)_18%,transparent),inset_0_1px_0_rgba(255,255,255,0.08)]">
            <ShoppingBag size={16} className="text-amber-300 drop-shadow-[0_0_8px_color-mix(in_oklab,var(--color-amber-500)_45%,transparent)]" />
          </div>
          <h2 className="relative text-lg font-black bg-gradient-to-r from-amber-100 via-yellow-400 to-amber-300 bg-clip-text text-transparent tracking-[0.08em] truncate uppercase" style={{ filter: "drop-shadow(0 0 6px color-mix(in oklab, var(--color-amber-500) 32%, transparent))" }}>
            Painel Bazaar
          </h2>

          {isBossUser && (
            <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
              <button type="button" onClick={openSearchFiltersModal} disabled={isLoading || isCheckingDetails} className="inline-flex h-7 items-center gap-1 px-2.5 rounded-lg border border-amber-500/25 bg-amber-500/10 text-amber-300 text-[10px] font-black transition-all cursor-pointer hover:bg-amber-500/20 disabled:opacity-50 disabled:cursor-not-allowed">
                <Filter size={12} /> Filtros Consulta
              </button>
              {isElectron && (
                <button type="button" onClick={requestBazaarQuery} disabled={isLoading || isOfficialSyncing} className="inline-flex h-7 items-center gap-1 px-2.5 rounded-lg bg-gradient-to-r from-amber-700/80 to-amber-600/80 hover:from-amber-600 hover:to-amber-500 border border-amber-500/40 text-black text-[10px] font-black transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shadow-md shadow-amber-900/15">
                  <RefreshCw size={12} className={isLoading ? "animate-spin" : ""} />
                  {isLoading ? "Consultando..." : "Consultar Bazaar"}
                </button>
              )}
            </div>
          )}
        </div>

        {error && (
          <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300 flex items-center gap-2">
            <AlertTriangle size={15} /> {error}
          </div>
        )}

        {/* Consulta parcial: âmbar (aviso), não rosa (erro) — a lista exibida
            é válida, apenas não cobre todo o Bazaar. */}
        {partialNotice && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200 space-y-1">
            <div className="flex items-start gap-2">
              <AlertTriangle size={15} className="flex-shrink-0 mt-0.5 text-amber-400" />
              <div className="space-y-1 min-w-0">
                <div className="font-bold">{partialNotice.summary}</div>
                <div className="text-amber-300/80">
                  Páginas que não responderam:{" "}
                  <span className="font-mono">{formatFailedPages(partialNotice.failedPages)}</span>
                </div>
                <div className="text-amber-300/70">
                  {partialNotice.published
                    ? "Publicada como PARCIAL — a lista oficial está marcada como incompleta."
                    : "A lista oficial anterior foi preservada. Este resultado está visível apenas para você."}
                </div>
                <div className="text-amber-300/60">
                  Os personagens das páginas que falharam não foram analisados e não aparecem nesta lista.
                </div>
              </div>
            </div>
          </div>
        )}

        {localBazaarNotifications.length > 0 && (
          <div className="space-y-1">
            {localBazaarNotifications.map(notification => {
              // Status de abertura do link — MESMO controle da lista de
              // personagens (openedLinksState/getBazaarLinkState). Clicar
              // novamente atualiza o registro de última abertura.
              const notifAuctionKey = notification.auctionId || "";
              const notifLinkState = getBazaarLinkState(notifAuctionKey);
              const notifOpenedAtMs = notifAuctionKey ? openedLinksState.opened[notifAuctionKey] : undefined;
              const notifOpenedLabel = notifOpenedAtMs
                ? `Última abertura: ${new Date(notifOpenedAtMs).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`
                : "Link já aberto neste dispositivo";
              return (
                <button
                  key={notification.id}
                  type="button"
                  onClick={() => {
                    if (notifAuctionKey) markBazaarLinkOpened(notifAuctionKey);
                    openExternal(notification.url || "");
                  }}
                  className="w-full rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-left text-[11px] leading-tight text-amber-200 flex items-center justify-between gap-2 hover:bg-amber-500/20 transition-colors cursor-pointer"
                  title={notifLinkState === "open" ? "Abrir personagem no Bazaar" : notifOpenedLabel}
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
                        title={notifOpenedLabel}
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

        <div className="rounded-lg border border-[var(--th-line)]/60 bg-[var(--th-n-base)]/85 px-2.5 py-1 text-[11px] text-slate-400">
          <div className="flex flex-col gap-0.5 lg:flex-row lg:items-start lg:justify-between lg:gap-3">
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="inline-flex items-center gap-1.5 font-black text-amber-300 uppercase tracking-wide">
                <Sparkles size={12} /> Última consulta
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] leading-tight">
                {displayedLastSummary ? (
                  <>
                    <span>Concluída: <span className="font-mono text-slate-200">{formatDateTimeWithOffset(displayedLastSummary.completedAtMs, timezoneOffsetMinutes)}</span></span>
                    {isBossUser && <span>Duração: <span className="font-mono text-slate-200">{formatDuration(displayedLastSummary.durationMs)}</span></span>}
                    <span>Personagens: <span className="font-mono text-slate-200">{displayedLastSummary.approvedCount}</span></span>

                    {/* Selo de encerramento manual: deixa explícito que esta
                        lista não é o resultado de uma varredura completa. */}
                    {displayedLastSummary.stoppedManually && (
                      <span
                        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 border border-amber-500/40 bg-amber-500/10 font-bold text-amber-300"
                        title="A consulta foi encerrada manualmente pelo botão 'Concluir agora'. Apenas os personagens já analisados até aquele momento entraram na lista."
                      >
                        <FlagTriangleRight size={10} /> Encerrada manualmente
                      </span>
                    )}

                    {/* Falhas da análise individual. Vem dos METADADOS oficiais,
                        então aparece para todos os usuários — não só para quem
                        executou a consulta. Exibido mesmo quando é 0. */}
                    {typeof displayedLastSummary.failedCount === "number" && (() => {
                      const failedTotal = displayedLastSummary.failedCount || 0;
                      const failedLinks = displayedLastSummary.failedCharacters || [];
                      const canOpen = failedTotal > 0 && failedLinks.length > 0;
                      return (
                        <span className="relative inline-flex">
                          <button
                            type="button"
                            disabled={!canOpen}
                            onClick={() => canOpen && setIsFailuresOpen(open => !open)}
                            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors ${
                              failedTotal > 0
                                ? `border border-rose-500/40 bg-rose-500/10 font-bold text-rose-300 ${canOpen ? "hover:bg-rose-500/20 cursor-pointer" : "cursor-default"}`
                                : "cursor-default"
                            }`}
                            title={canOpen
                              ? "Ver os links dos personagens que falharam"
                              : "Personagens que não puderam ser analisados e não entraram na lista."}
                          >
                            {failedTotal > 0 && <AlertTriangle size={10} />}
                            Falhas:{" "}
                            <span className={failedTotal > 0 ? "font-mono" : "font-mono text-emerald-400"}>
                              {failedTotal} {failedTotal === 1 ? "personagem" : "personagens"}
                            </span>
                            {canOpen && <ChevronDown size={9} className={`transition-transform ${isFailuresOpen ? "rotate-180" : ""}`} />}
                          </button>

                          {/* Lista dos leilões que falharam. Os dados já vieram
                              com os metadados — nenhuma consulta adicional. */}
                          {canOpen && isFailuresOpen && (
                            <>
                              <button
                                type="button"
                                aria-label="Fechar"
                                className="fixed inset-0 z-[60] cursor-default"
                                onClick={() => setIsFailuresOpen(false)}
                              />
                              <div className="absolute left-0 top-full z-[61] mt-1 w-[280px] rounded-lg border border-[var(--th-line)]/60 bg-[var(--th-bg-raised)] shadow-2xl shadow-black/60">
                                <div className="flex items-center justify-between gap-2 border-b border-[var(--th-line)]/40 px-2.5 py-1.5">
                                  <span className="text-[10px] font-black uppercase tracking-wider text-rose-300">
                                    {failedTotal} {failedTotal === 1 ? "falha" : "falhas"}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => setIsFailuresOpen(false)}
                                    className="rounded p-0.5 text-slate-400 hover:bg-white/10 hover:text-white transition-colors cursor-pointer"
                                  >
                                    <X size={11} />
                                  </button>
                                </div>
                                <div className="max-h-[220px] overflow-y-auto custom-scrollbar py-1">
                                  {failedLinks.map((entry, index) => (
                                    <button
                                      key={entry.id || entry.url || index}
                                      type="button"
                                      onClick={() => openExternal(entry.url)}
                                      className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left hover:bg-white/5 transition-colors cursor-pointer"
                                      title={entry.url}
                                    >
                                      <span className="w-4 flex-shrink-0 text-right font-mono text-[9px] text-slate-600">{index + 1}</span>
                                      <span className="min-w-0 flex-1 truncate text-[10px] text-slate-200">{entry.name || entry.id || entry.url}</span>
                                      <ExternalLink size={10} className="flex-shrink-0 text-slate-500" />
                                    </button>
                                  ))}
                                </div>
                                {failedTotal > failedLinks.length && (
                                  <div className="border-t border-[var(--th-line)]/40 px-2.5 py-1 text-[9px] text-slate-500">
                                    Exibindo {failedLinks.length} de {failedTotal}.
                                  </div>
                                )}
                              </div>
                            </>
                          )}
                        </span>
                      );
                    })()}

                    {/* Listagem inicial: quantos passaram nos filtros e quantas
                        páginas foram realmente lidas. O selo "parada antecipada"
                        indica que o limite de encerramento evitou baixar o resto. */}
                    {isBossUser && typeof displayedLastSummary.filteredCount === "number" && (
                      <span title="Personagens que passaram nos filtros da listagem">
                        Filtrados: <span className="font-mono text-slate-200">{displayedLastSummary.filteredCount}</span>
                      </span>
                    )}
                    {isBossUser && !!displayedLastSummary.pagesScanned && (
                      <span title="Páginas da listagem efetivamente percorridas">
                        Páginas: <span className="font-mono text-slate-200">{displayedLastSummary.pagesScanned}</span>
                      </span>
                    )}
                    {isBossUser && displayedLastSummary.stoppedEarly && (
                      <span
                        className="inline-flex items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 font-bold text-emerald-300"
                        title="A leitura parou ao encontrar leilões que encerram depois do limite configurado — as páginas seguintes foram dispensadas."
                      >
                        <Sparkles size={10} /> parada antecipada
                      </span>
                    )}

                    {/* Resultado da análise individual: navegador usado, quantos
                        foram analisados, quantos o retry recuperou e as falhas
                        finais. Só aparece quando a análise chegou a rodar. */}
                    {isBossUser && typeof displayedLastSummary.totalRequested === "number" && displayedLastSummary.totalRequested > 0 && (
                      <>
                        <span title="Personagens analisados individualmente com sucesso">
                          Analisados:{" "}
                          <span className={`font-mono ${(displayedLastSummary.failedCount || 0) > 0 ? "text-amber-300" : "text-emerald-400"}`}>
                            {displayedLastSummary.analyzedCount ?? 0}/{displayedLastSummary.totalRequested}
                          </span>
                        </span>

                        {!!displayedLastSummary.primaryBrowser && (
                          <span title="Navegador usado na consulta principal">
                            Navegador: <span className="font-mono text-sky-300">{browserLabel(displayedLastSummary.primaryBrowser)}</span>
                          </span>
                        )}

                        {/* Cadeia de retries: cada navegador com quantos
                            personagens recuperou. Resumos antigos só têm
                            `retryBrowser`, então o formato antigo é mantido
                            como alternativa. */}
                        {(displayedLastSummary.retryStats?.length ?? 0) > 0 ? (
                          <span title="Navegadores usados nas tentativas finais e quantos personagens cada um recuperou">
                            Retry:{" "}
                            {displayedLastSummary.retryStats!.map((stat, index) => (
                              <span key={`${stat.browser}-${index}`}>
                                {index > 0 && <span className="text-slate-600"> → </span>}
                                <span className="font-mono text-violet-300">
                                  {browserLabel(stat.browser)}
                                  {(stat.attempts ?? 0) > 1 && (
                                    <span className="text-slate-500">{` ${stat.attempt}/${stat.attempts}`}</span>
                                  )}
                                </span>
                                <span className={stat.recovered > 0 ? "text-emerald-400" : "text-slate-500"}>
                                  {" "}(+{stat.recovered}/{stat.attempted})
                                </span>
                              </span>
                            ))}
                          </span>
                        ) : !!displayedLastSummary.retryBrowser && (
                          <span title="Navegador usado na tentativa final dos personagens que falharam">
                            Retry: <span className="font-mono text-violet-300">{browserLabel(displayedLastSummary.retryBrowser)}</span>
                            {(displayedLastSummary.recoveredCount || 0) > 0 && (
                              <span className="text-emerald-400"> (+{displayedLastSummary.recoveredCount} recuperados)</span>
                            )}
                          </span>
                        )}
                      </>
                    )}
                    {officialMetadata?.version && <span>Versão: <span className="font-mono text-slate-500">{officialMetadata.version}</span></span>}
                    {isBossUser && officialMetadata?.generatedByName && <span>Responsável: <span className="font-mono text-slate-200">{officialMetadata.generatedByName}</span></span>}
                    {/* Selo permanente: a lista oficial vigente foi gerada a
                        partir de uma consulta incompleta. Visível a todos. */}
                    {isBossUser && officialMetadata?.partial && (
                      <span
                        className="inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 font-bold text-amber-300"
                        title={`Lista gerada a partir de ${officialMetadata.loadedPageCount ?? "?"} de ${officialMetadata.totalPages ?? "?"} páginas.`
                          + (officialMetadata.failedPageNumbers?.length ? ` Páginas ausentes: ${formatFailedPages(officialMetadata.failedPageNumbers)}.` : "")}
                      >
                        <AlertTriangle size={10} /> PARCIAL
                        {typeof officialMetadata.loadedPageCount === "number" && typeof officialMetadata.totalPages === "number" && officialMetadata.totalPages > 0 && (
                          <span className="font-mono opacity-80">{officialMetadata.loadedPageCount}/{officialMetadata.totalPages}</span>
                        )}
                      </span>
                    )}
                  </>
                ) : (
                  <span className="text-slate-500">Nenhuma consulta oficial carregada ainda.</span>
                )}
              </div>
              {/* Legenda compacta dos indicadores da coluna Personagem */}
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[9px] leading-tight text-slate-500">
                <span className="font-black uppercase tracking-wide text-slate-600">Legenda:</span>
                <span className="inline-flex items-center gap-1"><span aria-label="Prioridade" title="Prioridade — menor quantidade desta vocação neste servidor" className="bazaar-badge bazaar-badge-priority"><Star size={11} strokeWidth={2.5} /></span> Prioridade</span>
                <span className="inline-flex items-center gap-1"><span aria-label="Prioridade Máxima" title="Prioridade Máxima — nenhum personagem desta vocação neste servidor" className="bazaar-badge bazaar-badge-max"><Flame size={12} strokeWidth={2.5} /></span> Prioridade Máxima</span>
                <span className="inline-flex items-center gap-1"><span aria-label="Prioridade para você" title="Prioridade para você — você não possui personagem neste servidor" className="bazaar-badge bazaar-badge-you"><Star size={11} strokeWidth={2.5} /></span> Prioridade p/ você</span>
                <span className="inline-flex items-center gap-1"><span aria-label="Quest suspeita" title="Quest suspeita — alta chance de quest indisponível" className="bazaar-badge bazaar-badge-suspicious"><ShieldAlert size={12} strokeWidth={2.5} /></span> Quest suspeita</span>
                <span className="inline-flex items-center gap-1"><span aria-label="Melhor vocação para você" title="Melhor vocação para você neste servidor" className="bazaar-badge bazaar-badge-bestvoc"><Target size={11} strokeWidth={2.5} /></span> Melhor vocação</span>
              </div>
              <div className="flex min-w-0 items-center gap-2 text-[11px] leading-tight">
                <span className="truncate text-slate-400">{queryStatus || (result?.ok ? `${filteredAuctions.length}/${result.total} personagem(ns) na lista oficial` : isBossUser && isElectron ? "Defina filtros de consulta e clique em Consultar Bazaar" : "Clique em Atualizar para sincronizar a lista oficial")}</span>
                <button type="button" onClick={() => setIsUsedFiltersOpen(true)} className="inline-flex h-6 flex-shrink-0 items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 text-[10px] font-black text-slate-300 hover:bg-white/10 hover:text-white transition-colors cursor-pointer">
                  Filtros Usados
                </button>
              </div>
            </div>

            <div className="flex flex-row flex-wrap items-start justify-end gap-1.5 lg:flex-nowrap">
              <div className="flex flex-wrap justify-end gap-1.5">
                <select value={timezoneOffsetMinutes} onChange={event => setTimezoneOffsetMinutes(Number(event.target.value))} title={`Fuso usado para exibir e filtrar encerramento (${formatTimeZoneOffset(timezoneOffsetMinutes)})`} className="h-7 rounded-md border border-[var(--th-line)]/70 bg-black/35 px-2 text-[11px] text-white outline-none focus:border-amber-600/60">
                  {BAZAR_TIMEZONE_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>

                {/* BID PADRÃO — caixa + valor inteiro. Ativo (caixa marcada E
                    valor válido), funciona como VALOR RESERVA: o botão "Bid"
                    usa este valor apenas quando o campo individual da linha
                    está vazio (o individual sempre tem prioridade); desativado,
                    cada linha usa o próprio valor digitado (comportamento
                    original). Persistido no localStorage junto das demais
                    preferências do Bazaar. */}
                <div
                  className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[var(--th-line)]/70 bg-black/35 px-2"
                  title="Valor de lance pré-configurado (reserva): com a caixa marcada e um valor válido, o botão Bid de uma linha usa este valor apenas quando o campo individual estiver vazio"
                >
                  <label className="inline-flex cursor-pointer items-center gap-1" title="Ativar o Bid Padrão como valor reserva (usado quando o campo individual da linha estiver vazio)">
                    <input
                      type="checkbox"
                      checked={defaultBid.enabled}
                      onChange={event => toggleDefaultBid(event.target.checked)}
                      className="h-3.5 w-3.5 cursor-pointer accent-amber-500"
                    />
                    <span className="text-[10px] leading-none text-slate-400">Bid Padrão</span>
                  </label>
                  <input
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={defaultBidDraft}
                    onChange={event => changeDefaultBidDraft(event.target.value)}
                    placeholder="500"
                    aria-label="Valor do Bid Padrão (apenas números inteiros)"
                    title={
                      defaultBid.enabled
                        ? defaultBidActive
                          ? `Bid Padrão ATIVO (${defaultBid.amount}) — usado pelo botão Bid quando o campo individual da linha estiver vazio`
                          : "Informe um número inteiro válido (maior que zero) para ativar o Bid Padrão"
                        : "Valor reserva usado quando a caixa Bid Padrão estiver marcada e o campo individual da linha estiver vazio (apenas números inteiros)"
                    }
                    className={`h-5 w-[58px] rounded border px-1 text-center font-mono text-[11px] font-black leading-none tabular-nums outline-none transition-colors ${
                      defaultBidActive
                        ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300"
                        : defaultBidDraft
                          ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
                          : "border-white/10 bg-white/5 text-slate-300 placeholder:font-bold placeholder:text-slate-600"
                    }`}
                  />
                </div>

                {/* Antecedência da notificação de encerramento (1 a 60 min).
                    Só é salva ao clicar em Aplicar. Valor não editável por
                    digitação — apenas pelas setas. */}
                <div className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[var(--th-line)]/70 bg-black/35 px-2" title="Minutos de antecedência para a notificação de encerramento do leilão">
                  <span className="text-[10px] leading-none text-slate-400">Notificar</span>
                  <div className="inline-flex items-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => stepNotifyMinutesDraft(-1)}
                      disabled={notifyMinutesDraft <= BAZAR_NOTIFY_MINUTES_MIN}
                      title="Diminuir 1 minuto"
                      aria-label="Diminuir minutos de antecedência"
                      className="inline-flex h-5 w-5 items-center justify-center rounded border border-white/10 bg-white/5 text-slate-300 transition-colors hover:bg-white/15 hover:text-white disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-white/5 cursor-pointer"
                    >
                      <ChevronDown size={11} strokeWidth={3} />
                    </button>
                    <span
                      role="spinbutton"
                      aria-valuemin={BAZAR_NOTIFY_MINUTES_MIN}
                      aria-valuemax={BAZAR_NOTIFY_MINUTES_MAX}
                      aria-valuenow={notifyMinutesDraft}
                      aria-label="Minutos de antecedência"
                      className="min-w-[18px] select-none text-center font-mono text-[12px] font-black leading-none text-amber-300 tabular-nums"
                    >
                      {notifyMinutesDraft}
                    </span>
                    <button
                      type="button"
                      onClick={() => stepNotifyMinutesDraft(1)}
                      disabled={notifyMinutesDraft >= BAZAR_NOTIFY_MINUTES_MAX}
                      title="Aumentar 1 minuto"
                      aria-label="Aumentar minutos de antecedência"
                      className="inline-flex h-5 w-5 items-center justify-center rounded border border-white/10 bg-white/5 text-slate-300 transition-colors hover:bg-white/15 hover:text-white disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-white/5 cursor-pointer"
                    >
                      <ChevronUp size={11} strokeWidth={3} />
                    </button>
                  </div>
                  <span className="text-[10px] leading-none text-slate-400">min antes</span>
                  <button
                    type="button"
                    onClick={applyNotifyMinutes}
                    disabled={!isNotifyMinutesDirty}
                    title={isNotifyMinutesDirty ? "Aplicar novo tempo de antecedência" : "Nenhuma alteração para aplicar"}
                    className={`inline-flex h-5 items-center justify-center rounded border px-1.5 text-[9px] font-black transition-colors ${
                      isNotifyMinutesDirty
                        ? "border-amber-500/40 bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 cursor-pointer"
                        : "border-white/10 bg-white/5 text-slate-600 cursor-not-allowed"
                    }`}
                  >
                    Aplicar
                  </button>
                  {notifyMinutesSavedAt > 0 && (
                    <span className="inline-flex items-center gap-0.5 text-[9px] font-black leading-none text-emerald-300" role="status">
                      <Check size={10} strokeWidth={3} /> Salvo
                    </span>
                  )}
                </div>
                <button type="button" onClick={() => setHideEndedAuctions(prev => !prev)} className={`inline-flex h-7 items-center gap-1 rounded-md border px-2.5 text-[10px] font-black transition-colors cursor-pointer ${hideEndedAuctions ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20" : "border-amber-500/25 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20"}`} title={hideEndedAuctions ? "Mostrar também leilões encerrados" : "Ocultar leilões encerrados"}>
                  {hideEndedAuctions ? "Ocultar encerrados" : "Exibir todos"}
                </button>
              </div>
              <div className="flex flex-col gap-1">
                <button type="button" onClick={() => setIsFriendsSummaryOpen(true)} className="inline-flex h-7 items-center justify-center gap-1 rounded-md border border-amber-500/25 bg-amber-500/10 px-2.5 text-[10px] font-black text-amber-300 hover:bg-amber-500/20 transition-colors cursor-pointer">
                  Resumo de Amigos
                </button>
                {isBossUser && isElectron && (
                  <button
                    type="button"
                    onClick={() => setIsAutoBidOpen(true)}
                    className="inline-flex h-7 items-center justify-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 text-[10px] font-black text-emerald-300 hover:bg-emerald-500/20 transition-colors cursor-pointer"
                    title="Auto Bid — lance automático nos personagens com interesse (apenas Boss no app de desktop)"
                  >
                    Auto Bid
                  </button>
                )}
                <button type="button" onClick={() => handleSyncOfficialBazaar(true)} disabled={isOfficialSyncing} className="inline-flex h-7 items-center justify-center gap-1 rounded-md border border-cyan-500/25 bg-cyan-500/10 px-2.5 text-[10px] font-black text-cyan-300 hover:bg-cyan-500/20 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">
                  Atualizar
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-auto custom-scrollbar rounded-xl border border-[var(--th-line)]/70 bg-[var(--th-n-deep)]/90">
          {isLoading || isCheckingDetails ? (
            <div className="h-full flex flex-col items-center justify-center text-center p-8 text-slate-500 gap-4">
              <div className="w-14 h-14 rounded-2xl border border-amber-500/30 bg-amber-500/10 flex items-center justify-center shadow-[0_0_28px_color-mix(in_oklab,var(--color-amber-500)_10%,transparent)]">
                <RefreshCw size={24} className="text-amber-300 animate-spin" />
              </div>
              <div className="w-full max-w-md space-y-3">
                <div className="text-sm font-black text-amber-200">{queryProgress?.message || queryStatus || "Consultando Bazaar..."}</div>
                <div className="space-y-1.5">
                  <div className="h-2 rounded-full bg-black/40 border border-white/10 overflow-hidden">
                    <div className="h-full rounded-full bg-gradient-to-r from-amber-600 to-amber-300 transition-all duration-300" style={{ width: `${activePercent}%` }} />
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-slate-400 font-mono">
                    <span>{activePercent}%</span>
                    <span>{activeTotal > 0 ? `${activeProcessed} / ${activeTotal} personagem(ns)` : checkingDetailsCount > 0 ? `0 / ${checkingDetailsCount} personagem(ns)` : "Preparando..."}</span>
                  </div>
                </div>
                {/* Configuração desta consulta: modo e cadeia de retry.
                    Chega em todo evento de progresso, então fica visível desde
                    a listagem e permanece durante os retries. */}
                {!!speedModeLabel && (
                  <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[10px]">
                    <span className="text-slate-500">
                      Modo: <span className="font-semibold text-sky-300">{speedModeLabel}</span>
                    </span>
                    <span className="text-slate-500">
                      Retry:{" "}
                      {retrySelection.length > 0 ? (
                        <span className="font-semibold text-violet-300">
                          {retrySelection
                            .map(b => ((b.attempts ?? 1) > 1 ? `${b.label} ×${b.attempts}` : b.label))
                            .join(", ")}
                        </span>
                      ) : (
                        <span className="text-slate-600">Nenhum</span>
                      )}
                    </span>
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[10px]">
                  <div className="rounded-lg border border-white/10 bg-black/25 px-3 py-2">
                    <div className="text-slate-500 uppercase tracking-wide">Tempo decorrido</div>
                    <div className="font-mono text-amber-200 text-xs mt-0.5">{formatDuration(activeElapsedMs)}</div>
                  </div>
                  <div className="rounded-lg border border-white/10 bg-black/25 px-3 py-2">
                    <div className="text-slate-500 uppercase tracking-wide">Restante estimado</div>
                    <div className="font-mono text-amber-200 text-xs mt-0.5">{estimatedRemainingMs === null ? "Calculando..." : formatDuration(estimatedRemainingMs)}</div>
                  </div>
                  <div className="rounded-lg border border-white/10 bg-black/25 px-3 py-2">
                    <div className="text-slate-500 uppercase tracking-wide">Conclusão prevista</div>
                    <div className="font-mono text-amber-200 text-xs mt-0.5">{estimatedCompletionMs === null ? "--:--:--" : formatTimeOfDayWithOffset(estimatedCompletionMs, timezoneOffsetMinutes)}</div>
                  </div>
                </div>

                {/* Progresso POR NAVEGADOR: taxa de falhas ao vivo de cada um
                    que já rodou, mais os que ainda faltam na cadeia de retry.
                    Sem cor fixa — usa a mesma paleta do restante do quadro. */}
                {isCheckingDetails && browserStats.length > 0 && (
                  <div className="rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-[10px] space-y-1">
                    {/* A chave inclui o índice: o MESMO navegador pode
                        aparecer várias vezes quando tem mais de um retry. */}
                    {browserStats.map((stat, statIndex) => (
                      <div key={`${stat.browser}-${statIndex}`} className="flex items-center justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className={`truncate font-semibold ${stat.done ? "text-slate-400" : "text-amber-200"}`}>
                            {stat.label}
                          </span>
                          {stat.isRetry && (
                            <span className="flex-shrink-0 text-[9px] font-black uppercase text-violet-400">
                              retry{(stat.attempts ?? 0) > 1 ? ` ${stat.attempt}/${stat.attempts}` : ""}
                            </span>
                          )}
                          {!stat.done && (
                            <span className="flex-shrink-0 text-[9px] font-black uppercase text-amber-400">em curso</span>
                          )}
                        </span>
                        <span className="flex-shrink-0 font-mono">
                          {stat.analyzed === 0 ? (
                            <span className="text-slate-500">aguardando</span>
                          ) : (
                            <>
                              <span className={stat.failureRate > 0 ? "text-rose-300" : "text-emerald-400"}>
                                {stat.failureRate}% falhas
                              </span>
                              <span className="text-slate-600"> ({stat.failed}/{stat.analyzed})</span>
                            </>
                          )}
                        </span>
                      </div>
                    ))}

                    {pendingBrowsers.length > 0 && (
                      <div className="border-t border-white/10 pt-1 text-slate-500">
                        Pendentes:{" "}
                        <span className="text-slate-400">
                          {pendingBrowsers
                            .map(b => ((b.attempts ?? 0) > 1 ? `${b.label} ${b.attempt}/${b.attempts}` : b.label))
                            .join(", ")}
                        </span>
                      </div>
                    )}
                  </div>
                )}

                {/* Falhas que irão para a segunda tentativa. Só aparece na
                    etapa de detalhes, que é a única que gera retry. Durante o
                    próprio retry o rótulo muda: ali os pendentes são os que
                    ainda não foram recuperados. Cores por token, sem valor
                    fixo, para funcionar nos 7 temas. */}
                {isCheckingDetails && (
                  <div className={`rounded-lg border px-3 py-2 text-[10px] ${
                    retryPending > 0
                      ? "border-rose-500/30 bg-rose-500/10"
                      : "border-white/10 bg-black/25"
                  }`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-500 uppercase tracking-wide">
                        {isRetryPass ? "Ainda com falha" : "Falhas para retry"}
                      </span>
                      <span className={`font-mono text-xs ${retryPending > 0 ? "text-rose-300" : "text-slate-400"}`}>
                        {retryPending} personagem{retryPending === 1 ? "" : "s"}
                      </span>
                    </div>
                    {retryPending > 0 && (
                      <div className="mt-1 leading-snug text-slate-500">
                        {isRetryPass
                          ? "Serão marcados como falha ao final desta etapa."
                          : "Serão reenviados ao segundo navegador ao final desta etapa."}
                      </div>
                    )}
                  </div>
                )}

                {/* ── CONCLUIR AGORA ──────────────────────────────────────
                    Encerra a consulta preservando o que já foi analisado.

                    Só existe no Electron (a consulta é exclusiva de lá) e só
                    enquanto há consulta em andamento — o quadro inteiro some
                    quando `isLoading`/`isCheckingDetails` zeram, então o botão
                    desaparece junto, sem precisar de condição extra.

                    Tom ÂMBAR, o mesmo do quadro de progresso: é uma ação
                    importante, mas não destrutiva — nada é apagado, apenas
                    encerrado mais cedo. Vermelho daria a impressão errada. */}
                {isElectron && (
                  <button
                    type="button"
                    onClick={() => setIsStopConfirmOpen(true)}
                    disabled={stopRequested}
                    className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-[11px] font-black text-amber-200 hover:bg-amber-500/20 hover:border-amber-400/60 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    title={stopRequested
                      ? "Encerramento já solicitado — aguardando o ponto seguro de parada."
                      : "Encerrar a consulta agora, mantendo os personagens já analisados"}
                  >
                    <FlagTriangleRight size={12} />
                    {stopRequested ? "Encerrando..." : "Concluir agora"}
                  </button>
                )}
              </div>
            </div>
          ) : !result?.ok ? (
            <div className="h-full flex flex-col items-center justify-center text-center p-8 text-slate-500 gap-3">
              <ShoppingBag size={40} className="text-amber-700/50" />
              <div className="text-sm font-bold text-slate-400">{isBossUser && isElectron ? "Clique em Consultar Bazaar para carregar os personagens." : "Clique em Atualizar para carregar a lista oficial."}</div>
              <p className="text-xs max-w-md leading-relaxed">
                Na primeira execução, caso o Cloudflare exija verificação humana, resolva a etapa no Chromium aberto. A sessão será reaproveitada nas próximas consultas.
              </p>
            </div>
          ) : (
            <table className="w-full min-w-[920px] table-fixed border-separate border-spacing-0 text-xs">
              {/* Distribuição responsiva (abordagem original restaurada):
                  table-fixed + colgroup percentual — as 11 colunas de dados
                  redistribuem o espaço de forma dinâmica conforme a largura
                  da janela (proporções fixas, largura total aproveitada).
                  Única exceção: a coluna "#" tem largura FIXA mínima (w-9),
                  suficiente para identificadores de até 3 dígitos ("#100"),
                  sem crescer junto com a janela. Os percentuais somam 96%:
                  somados ao w-9 da "#" a tabela nunca ultrapassa o
                  min-w-[920px] e o pequeno excedente é redistribuído. */}
              <colgroup>
                <col className="w-9" />
                <col className="w-[12%]" />
                <col className="w-[5%]" />
                <col className="w-[6%]" />
                <col className="w-[6%]" />
                <col className="w-[9%]" />
                <col className="w-[9%]" />
                <col className="w-[10%]" />
                <col className="w-[5%]" />
                <col className="w-[5%]" />
                <col className="w-[16%]" />
                <col className="w-[13%]" />
              </colgroup>
              <thead className="text-[10px] uppercase tracking-wider text-slate-400">
                <tr>
                  {/* Identificação da lista gerada (#1, #2, ...) — coluna
                      mínima, sem ordenação própria (a ordem vem da lista).
                      Largura fixa w-9 definida no colgroup (única exceção à
                      distribuição percentual das demais colunas). */}
                  <th className={`${STICKY_HEAD_CELL_CLASS} h-10 px-0.5 py-2 text-center align-middle text-[9px] leading-none text-slate-500`} title="Identificação do personagem nesta lista gerada (renumera apenas quando uma nova lista é gerada)">#</th>
                  <SortHeader label="Personagem" column="name" />
                  <th className={`${STICKY_HEAD_CELL_CLASS} h-10 px-1 py-2 text-center align-middle leading-none`}>Comprado</th>
                  <SortHeader label="Vocação" column="vocation" />
                  <SortHeader label="Level" column="level" align="center" />
                  <SortHeader label="Servidor" column="server" />
                  <SortHeader label="Valor" column="bid" align="right" />
                  <SortHeader label="Encerra" column="auctionEndTs" />
                  <th className={`${STICKY_HEAD_CELL_CLASS} h-10 px-1 py-2 text-center align-middle leading-none`}>SW</th>
                  <th className={`${STICKY_HEAD_CELL_CLASS} h-10 px-1 py-2 text-center align-middle leading-none`}>SG</th>
                  <th className={`${STICKY_HEAD_CELL_CLASS} h-10 px-1 py-2 text-center align-middle leading-none`}>Interessados</th>
                  <th className={`${STICKY_HEAD_CELL_CLASS} h-10 px-1 py-2 text-center align-middle leading-none`}>Link</th>
                </tr>
                <tr className="h-10 normal-case tracking-normal">
                  <th className={`${STICKY_FILTER_CELL_CLASS} h-10 px-0.5 py-1.5 text-center align-middle text-[10px] text-slate-600`}>—</th>
                  <th className={`${STICKY_FILTER_CELL_CLASS} h-10 px-1 py-1.5 align-middle`}>
                    <div className="flex w-full items-center justify-center gap-1">
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
                      <div className="flex min-w-0 flex-1 items-center justify-center [&>div]:w-full [&>div]:max-w-[112px]"><FilterInline value={tableFilters.name} onChange={value => updateTableFilters({ name: value })} placeholder="Personagem" maxWidth="100%" /></div>
                    </div>
                  </th>
                  <th className={`${STICKY_FILTER_CELL_CLASS} h-10 px-1 py-1.5 text-center align-middle text-[10px] text-slate-600`}>—</th>
                  <th className={`${STICKY_FILTER_CELL_CLASS} h-10 px-1 py-1.5 align-middle`}><div className="flex w-full items-center justify-center [&>button]:w-full [&>button]:max-w-[90px]"><FilterMulti label="Vocação" options={tableVocationOptions} selected={tableFilters.vocations} onApply={values => updateTableFilters({ vocations: values })} placeholder="Vocação" searchable /></div></th>
                  <th className={`${STICKY_FILTER_CELL_CLASS} h-10 px-1 py-1.5 align-middle`}><div className="flex w-full items-center justify-center [&>button]:w-full [&>button]:max-w-[74px]"><FilterNumber label="Level" value={tableFilters.levelValue} operator={tableFilters.levelOperator} onChange={(value, operator) => updateTableFilters({ levelValue: value, levelOperator: operator })} placeholder="Level" /></div></th>
                  <th className={`${STICKY_FILTER_CELL_CLASS} h-10 px-1 py-1.5 align-middle`}><div className="flex w-full items-center justify-center [&>button]:w-full [&>button]:max-w-[96px]"><FilterMulti label="Servidor" options={tableServerOptions} selected={tableFilters.servers} onApply={values => updateTableFilters({ servers: values })} placeholder="Servidor" searchable /></div></th>
                  <th className={`${STICKY_FILTER_CELL_CLASS} h-10 px-1 py-1.5 align-middle`}><div className="flex w-full items-center justify-center [&>button]:w-full [&>button]:max-w-[80px]"><FilterNumber label="Valor" value={tableFilters.bidValue} operator={tableFilters.bidOperator} onChange={(value, operator) => updateTableFilters({ bidValue: value, bidOperator: operator })} placeholder="Valor" /></div></th>
                  <th className={`${STICKY_FILTER_CELL_CLASS} h-10 px-1 py-1.5 align-middle`}><div className="flex w-full items-center justify-center [&>div]:w-full [&>div]:max-w-[122px]"><FilterDateMax label="Encerra até" value={tableFilters.endUntil} onChange={value => updateTableFilters({ endUntil: value })} placeholder="Encerra" /></div></th>
                  <th className={`${STICKY_FILTER_CELL_CLASS} h-10 px-1 py-1.5 text-center align-middle text-[10px] text-slate-600`}>—</th>
                  <th className={`${STICKY_FILTER_CELL_CLASS} h-10 px-1 py-1.5 text-center align-middle text-[10px] text-slate-600`}>—</th>
                  <th className={`${STICKY_FILTER_CELL_CLASS} h-10 px-1 py-1.5 text-center align-middle`}>
                    <button
                      type="button"
                      aria-label="Filtrar somente meus interesses"
                      aria-pressed={tableFilters.onlyMyInterests}
                      disabled={!currentUser?.uid}
                      onClick={() => updateTableFilters({ onlyMyInterests: !tableFilters.onlyMyInterests })}
                      title={tableFilters.onlyMyInterests
                        ? "Exibindo somente os personagens em que você marcou interesse"
                        : "Exibir somente os personagens em que você marcou interesse"}
                      className={`inline-flex h-7 items-center justify-center gap-1 rounded-md border px-2 text-[10px] font-black transition-all ${
                        tableFilters.onlyMyInterests
                          ? "border-cyan-400/55 bg-cyan-500/20 text-cyan-100 shadow-[0_0_12px_rgba(34,211,238,0.18)] cursor-pointer"
                          : currentUser?.uid
                            ? "border-white/10 bg-white/5 text-slate-400 hover:border-cyan-400/35 hover:bg-cyan-500/10 hover:text-cyan-200 cursor-pointer"
                            : "border-white/5 bg-white/[0.03] text-slate-600 cursor-not-allowed"
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
                {filteredAuctions.length === 0 && (
                  // Estado vazio renderizado DENTRO da tabela para que o cabeçalho e a
                  // linha de filtros continuem visíveis — caso contrário o usuário
                  // perderia o acesso ao botão de limpar justamente quando os filtros
                  // não retornam resultados.
                  <tr>
                    <td colSpan={12} className="px-4 py-10 text-center align-middle text-sm text-slate-500">
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
                {filteredAuctions.map(auction => {
                  const auctionKey = getAuctionKey(auction);
                  // Identificação #N da LISTA gerada (estável durante toda a
                  // vida desta lista — filtros/ordenação não renumeram).
                  const listNumber = listNumberByAuctionKey.get(auctionKey);
                  const isAlreadyAddedToPersonalList = personalCharacterNameSet.has(normalizeCharacterNameForCompare(auction.name));
                  const interestUsers = sortInterestUsers(bazaarInterests[auctionKey] || []);
                  const isCurrentUserInterested = !!currentUser?.uid && interestUsers.some(user => user.uid === currentUser.uid);
                  const detail = detailsCache[auctionKey] || getAuctionEmbeddedDetails(auction);
                  const auctionVocCode = getAuctionVocationCode(auction.vocation);
                  const sameVocOnServer = getVocationCountForAuction(auction.server, auctionVocCode);
                  const serverPriority = auctionVocCode ? priorityVocationsByServer.get(auction.server) : undefined;
                  const isMaxPriorityPurchase = !!auctionVocCode && !!serverPriority?.max.has(auctionVocCode);
                  const isPriorityPurchase = !!auctionVocCode && !!serverPriority?.normal.has(auctionVocCode);
                  // "Prioridade para você" — destaque ADITIVO, específico do usuário
                  // atual (não substitui Prioridade Máxima/Prioridade acima).
                  const auctionServerKey = serverKey(auction.server);
                  const isUserPriorityServer = userPriority.highlightedServers.has(auctionServerKey);
                  const isUserPriorityVocation = isUserPriorityServer
                    && !!auctionVocCode
                    && !!userPriority.priorityVocationsByServer.get(auctionServerKey)?.has(auctionVocCode);
                  const linkState = getBazaarLinkState(auctionKey);
                  const bidDraft = bidDrafts[auctionKey] || "";
                  const auctionBidId = extractBazaarAuctionId(auction.url, auction.id);
                  // Prioridade do Bid INDIVIDUAL (resolveBazaarBid): valor
                  // válido na linha habilita o botão; campo VAZIO com Bid
                  // Padrão ativo também habilita (fallback). Preenchido com
                  // valor INVÁLIDO, o padrão NÃO é usado — botão desabilitado.
                  const bidResolution = resolveBazaarBid(bidDraft, defaultBid);
                  const canOpenBidPage = !!auctionBidId && bidResolution.amount !== null;
                  const linkButtonLabel = linkState === "last" ? "Último Aberto" : linkState === "opened" ? "Aberto" : "Abrir";
                  const linkButtonClass = linkState === "last"
                    ? "border-amber-400/45 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25 shadow-[0_0_12px_color-mix(in_oklab,var(--color-amber-500)_16%,transparent)]"
                    : linkState === "opened"
                      ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/18"
                      : "border-amber-600/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20";
                  const isSuspiciousSoulWar = isQuestSuspicious(detail, "soulwarCompleted");
                  const isSuspiciousSanguine = isQuestSuspicious(detail, "sanguineCompleted");
                  const hasSuspiciousQuest = isSuspiciousSoulWar || isSuspiciousSanguine;
                  // ── Precedência visual da LINHA (maior primeiro) ───────────────
                  // Quest suspeita > Prioridade para você > Prioridade Máxima > Prioridade.
                  // A linha usa apenas a cor do indicador de maior prioridade.
                  let rowHighlightClass = "border-[var(--th-line)]/30 hover:bg-amber-500/[0.03]";
                  let rowHighlightTitle = "";
                  if (hasSuspiciousQuest) {
                    rowHighlightClass = "bazaar-row-suspicious";
                    rowHighlightTitle = "Quest suspeita";
                  } else if (isUserPriorityServer) {
                    rowHighlightClass = "bazaar-row-user-priority";
                    rowHighlightTitle = "Prioridade para você";
                  } else if (isMaxPriorityPurchase) {
                    rowHighlightClass = "bazaar-row-max-priority";
                    rowHighlightTitle = "Prioridade Máxima";
                  } else if (isPriorityPurchase) {
                    rowHighlightClass = "bazaar-row-priority";
                    rowHighlightTitle = "Prioridade";
                  }
                  const inlinePurchaseDraft = inlinePurchase?.auctionKey === auctionKey ? inlinePurchase : null;
                  const isInlinePurchaseOpen = !!inlinePurchaseDraft;
                  // Estados visuais dos campos Conta/Valor Pago (fluxo "Comprado").
                  // Matriz: vazio → pulso âmbar "obrigatória"; pré-preenchida pela
                  // última utilizada → pulso âmbar suave "última usada" (pede
                  // conferência, continua editável); lista aberta → "escolhendo";
                  // definida pelo usuário (digitada/selecionada) → esmeralda firme.
                  // "Pronto" exige conta definida pelo usuário + valor informado.
                  const inlineAccountValue = inlinePurchaseDraft?.account.trim() ?? "";
                  const inlineValorValue = inlinePurchaseDraft?.valorPago.trim() ?? "";
                  const inlineAccountEmpty = isInlinePurchaseOpen && !inlineAccountValue;
                  const inlineAccountPreset = isInlinePurchaseOpen && !!inlinePurchaseDraft?.accountPreset && !!inlineAccountValue;
                  const inlineAccountSelected = isInlinePurchaseOpen && !!inlinePurchaseDraft?.accountSelected && !!inlineAccountValue;
                  const inlineAccountChoosing = isInlinePurchaseOpen && isInlineAccountMenuOpen;
                  const inlineAccountConfirmed = isInlinePurchaseOpen && !!inlineAccountValue && !inlineAccountPreset;
                  const inlineValorEmpty = isInlinePurchaseOpen && !inlineValorValue;
                  const inlineFormReady = inlineAccountConfirmed && !!inlineValorValue;
                  return (
                    <Fragment key={`${auctionKey}_${auction.name}`}>
                    <tr className={`h-12 border-b transition-colors ${rowHighlightClass}`} title={rowHighlightTitle || undefined}>
                      {/* Identificação da lista gerada — coluna mínima: apenas
                          o padding px-0.5 ao redor; fonte maior/mais evidente
                          sem ampliar a largura (largura = 1 identificador). */}
                      <td className="h-12 px-0.5 py-2 text-center align-middle">
                        {listNumber !== undefined && (
                          <span
                            className="inline-block font-mono text-[12px] font-black leading-none tabular-nums text-slate-400"
                            title={`#${listNumber} nesta lista gerada — a numeração reinicia somente quando uma nova lista é gerada`}
                          >
                            #{listNumber}
                          </span>
                        )}
                      </td>
                      <td className="h-12 px-1.5 py-2 align-middle font-bold text-white"><div className="flex items-center gap-1.5 min-w-0"><span className="truncate" title={auction.name || ""}>{auction.name || "—"}</span>{hasSuspiciousQuest && <span aria-label="Quest suspeita" title="Quest suspeita — contador de bosses muito próximo do total: alta chance de quest indisponível" className="bazaar-badge bazaar-badge-suspicious"><ShieldAlert size={12} strokeWidth={2.5} /></span>}{isMaxPriorityPurchase && <span aria-label="Prioridade Máxima" title="Prioridade Máxima — nenhum personagem desta vocação neste servidor" className="bazaar-badge bazaar-badge-max"><Flame size={12} strokeWidth={2.5} /></span>}{isPriorityPurchase && <span aria-label="Prioridade" title="Prioridade — menor quantidade desta vocação neste servidor" className="bazaar-badge bazaar-badge-priority"><Star size={11} strokeWidth={2.5} /></span>}{isUserPriorityServer && <span aria-label="Prioridade para você" title="Prioridade para você — você não possui personagem neste servidor" className="bazaar-badge bazaar-badge-you"><Star size={11} strokeWidth={2.5} /></span>}</div></td>
                      {/* Comprado — fluxo de inclusão do personagem comprado
                          (mesma ação/botão, agora posicionado após Personagem). */}
                      <td className="h-12 px-1 py-2 text-center align-middle">
                        <button
                          type="button"
                          onClick={() => {
                            if (isAlreadyAddedToPersonalList) return;
                            if (isInlinePurchaseOpen) closeInlinePurchase();
                            else openInlinePurchase(auctionKey);
                          }}
                          disabled={isAlreadyAddedToPersonalList}
                          aria-expanded={isInlinePurchaseOpen}
                          title={isAlreadyAddedToPersonalList
                            ? "Personagem já adicionado à minha lista"
                            : isInlinePurchaseOpen
                              ? "Fechar formulário de inclusão"
                              : "Adicionar personagem comprado à minha lista"}
                          className={`inline-flex h-7 w-7 items-center justify-center rounded-lg border transition-colors shadow-[0_0_10px_rgba(16,185,129,0.08)] ${
                            isAlreadyAddedToPersonalList
                              ? "border-emerald-400/45 bg-emerald-500/18 text-emerald-200 cursor-default"
                              : isInlinePurchaseOpen
                                ? "border-amber-400/55 bg-amber-500/18 text-amber-200 hover:bg-amber-500/25 cursor-pointer"
                                : "border-emerald-500/35 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 hover:text-emerald-200 hover:border-emerald-400/55 cursor-pointer"
                          }`}
                        >
                          {isAlreadyAddedToPersonalList ? <Check size={14} strokeWidth={3} /> : isInlinePurchaseOpen ? <X size={14} strokeWidth={3} /> : <Plus size={14} strokeWidth={3} />}
                        </button>
                      </td>
                      <td className="h-12 px-1 py-2 text-center align-middle">
                        <span className="inline-flex items-center justify-center gap-0.5">
                          <span className={`inline-flex items-center justify-center min-w-7 px-1.5 py-0.5 rounded-md border text-[10px] font-black ${getVocationBadgeClass(auction.vocation)}`}>{getVocationAbbreviation(auction.vocation)}</span>
                          {auctionVocCode && (
                            <span
                              className={`inline-flex items-baseline gap-[1px] rounded-md border px-1 py-0.5 text-[10px] font-black tabular-nums leading-none ${sameVocOnServer === 0 ? "bg-white/[0.03] border-white/10 text-slate-500" : getVocationCountClass(auction.vocation)}`}
                              title={`${sameVocOnServer} ${getVocationAbbreviation(auction.vocation)} em ${auction.server} com os filtros atuais do Resumo de Amigos`}
                            >
                              <span className="text-[8px] font-bold opacity-60">x</span>
                              {sameVocOnServer}
                            </span>
                          )}
                          {isUserPriorityVocation && (
                            <span aria-label="Melhor vocação para você" title="Melhor vocação para você neste servidor (grupo dos amigos com menos desta vocação)" className="bazaar-badge bazaar-badge-bestvoc"><Target size={11} strokeWidth={2.5} /></span>
                          )}
                        </span>
                      </td>
                      <td className="h-12 px-1 py-2 text-center align-middle font-mono text-amber-300">{auction.level || 0}</td>
                      <td className="h-12 px-1 py-2 text-center align-middle text-slate-300">{auction.server || "—"}</td>
                      <td className="h-12 px-1 py-2 text-center align-middle font-mono text-emerald-300">{auction.bid?.toLocaleString("de-DE") || 0} coins</td>
                      <td className="h-12 px-1 py-2 text-center align-middle font-mono">
                        <span className={`inline-flex items-center justify-center gap-1 rounded-md px-1.5 py-0.5 ${isAuctionEndingSoon(auction, currentUnixTs) ? "border border-amber-500/35 bg-amber-500/10 text-amber-300 font-black" : isAuctionStillActive(auction, currentUnixTs) ? "text-slate-300" : "text-slate-600 line-through"}`} title={isAuctionEndingSoon(auction, currentUnixTs) ? "Leilão encerra em menos de 5 minutos" : undefined}>
                          {isAuctionEndingSoon(auction, currentUnixTs) && <AlertTriangle size={10} className="text-amber-300" />}
                          {formatAuctionEnd(auction.auctionEndTs, timezoneOffsetMinutes)}
                        </span>
                      </td>
                      <td className={`h-12 px-1 py-2 text-center align-middle text-[10px] ${isSuspiciousSoulWar ? "bg-rose-500/10 ring-1 ring-inset ring-rose-400/35" : ""} ${detail?.soulwarCompleted === true ? "text-rose-300" : detail?.soulwarCompleted === false ? "text-emerald-300" : "text-slate-500"}`} title={isSuspiciousSoulWar ? "Soul War suspeita: 3/6 bosses encontrados indica alta chance de quest indisponível." : undefined}><div className="font-bold">{formatQuestStatus(detail, "soulwarCompleted", needsQuestDetails, soulwarRequired)}</div>{soulwarRequired && <QuestBossCounter detail={detail} field="soulwarCompleted" />}</td>
                      <td className={`h-12 px-1 py-2 text-center align-middle text-[10px] ${isSuspiciousSanguine ? "bg-rose-500/10 ring-1 ring-inset ring-rose-400/35" : ""} ${detail?.sanguineCompleted === true ? "text-rose-300" : detail?.sanguineCompleted === false ? "text-emerald-300" : "text-slate-500"}`} title={isSuspiciousSanguine ? "Sanguine suspeita: 2/5 bosses encontrados indica alta chance de quest indisponível." : undefined}><div className="font-bold">{formatQuestStatus(detail, "sanguineCompleted", needsQuestDetails, sanguineRequired)}</div>{sanguineRequired && <QuestBossCounter detail={detail} field="sanguineCompleted" />}</td>
                      <td className="h-10 px-1 py-1.5 text-center align-middle">
                        <div className="flex max-h-24 flex-col items-center justify-start gap-1 overflow-y-auto custom-scrollbar text-center">
                          {officialMetadata?.version && currentUser?.uid && (
                            <button
                              type="button"
                              onClick={async () => {
                                const previous = bazaarInterests;
                                try {
                                  // Atualização otimista: a tela responde na hora.
                                  // A transação devolve o estado final autoritativo,
                                  // então NÃO é preciso reler a coleção depois.
                                  if (isCurrentUserInterested) {
                                    const next = { ...previous, [auctionKey]: interestUsers.filter(user => user.uid !== currentUser.uid) };
                                    setBazaarInterests(next);
                                    const confirmed = await removeBazaarInterest({ auctionId: auctionKey, uid: currentUser.uid, bazaarVersion: officialMetadata.version });
                                    setBazaarInterests(confirmed);
                                    syncBazaarEndingAlerts({ characters: autoBidCharacters, interestsByAuctionId: confirmed, currentUserUid: currentUser.uid, bazaarVersion: officialMetadata.version });
                                  } else {
                                    const user = { uid: currentUser.uid, name: userProfile?.nome || "Usuário", auctionId: auctionKey, bazaarVersion: officialMetadata.version, createdAtMs: Date.now() };
                                    const next = { ...previous, [auctionKey]: sortInterestUsers([...interestUsers, user]) };
                                    setBazaarInterests(next);
                                    const confirmed = await setBazaarInterest({ auctionId: auctionKey, bazaarVersion: officialMetadata.version, uid: currentUser.uid, name: user.name });
                                    setBazaarInterests(confirmed);
                                    syncBazaarEndingAlerts({ characters: autoBidCharacters, interestsByAuctionId: confirmed, currentUserUid: currentUser.uid, bazaarVersion: officialMetadata.version });
                                  }
                                } catch (error: any) {
                                  setBazaarInterests(previous);
                                  setError(error?.message || "Erro ao atualizar interesse.");
                                }
                              }}
                              className="mb-0.5 inline-flex items-center justify-center rounded border border-cyan-500/25 bg-cyan-500/10 px-2 py-1 text-[9px] font-black text-cyan-300 hover:bg-cyan-500/20 hover:text-cyan-200 transition-colors cursor-pointer"
                            >
                              {isCurrentUserInterested ? "Remover" : "Tenho interesse"}
                            </button>
                          )}
                          {interestUsers.length === 0 ? (
                            <div className="text-[9px] text-slate-600">Sem interessados</div>
                          ) : (
                            <div className="w-full space-y-0.5 text-center">
                              {interestUsers.map((user, index) => (
                                <div key={`${auctionKey}_${user.uid}_${index}`} className={`mx-auto truncate text-center text-[9px] ${index === 0 ? "font-black text-amber-300" : "text-slate-500"}`} title={`${index + 1}º ${user.name} — ${formatDateTimeWithOffset(getInterestCreatedAtMs(user), timezoneOffsetMinutes)}`}>
                                  <span className={index === 0 ? "inline-flex rounded bg-amber-500/10 px-1 text-amber-300" : "font-mono text-slate-500"}>{index + 1}º</span> {user.name} — {formatDateTimeWithOffset(getInterestCreatedAtMs(user), timezoneOffsetMinutes)}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="h-12 px-1 py-1 text-center align-middle">
                        <div className="flex w-full flex-col items-stretch gap-0.5">
                          <div className="flex w-full min-w-0 items-center gap-0.5">
                            <button type="button" onClick={() => openAuctionLink(auction)} title={linkState === "last" ? "Último personagem aberto" : linkState === "opened" ? "Este link já foi aberto neste dispositivo" : "Abrir personagem no Bazaar"} className={`inline-flex h-7 max-w-full min-w-0 items-center justify-center gap-0.5 rounded-lg px-1.5 py-1 border text-[9px] font-black transition-colors cursor-pointer ${linkButtonClass}`}><ExternalLink size={11} className="flex-shrink-0" /> <span className="truncate">{linkButtonLabel}</span></button>
                            <input
                              type="text"
                              inputMode="numeric"
                              pattern="[0-9]*"
                              value={bidDraft}
                              onChange={event => setBidDraft(auctionKey, event.target.value)}
                              onKeyDown={event => { if (event.key === "Enter" && canOpenBidPage) openAuctionBidPage(auction); }}
                              placeholder={defaultBidActive ? "Padrão" : "Valor"}
                              aria-label={`Valor do lance para ${auction.name}`}
                              title={defaultBidActive
                                ? `Bid individual — tem prioridade sobre o Bid Padrão (${defaultBid.amount}); vazio, o botão Bid usa o padrão`
                                : "Valor do lance (apenas números). O lance NÃO é enviado automaticamente."}
                              className="h-7 w-[46%] min-w-0 flex-shrink-0 rounded-lg border border-[var(--th-line)]/60 bg-[var(--th-bg)]/60 px-1 text-center text-[10px] font-black text-[var(--th-text)] outline-none transition-colors placeholder:font-bold placeholder:text-slate-500 focus:border-amber-500/60"
                            />
                          </div>
                          <button
                            type="button"
                            onClick={() => openAuctionBidPage(auction)}
                            disabled={!canOpenBidPage}
                            title={canOpenBidPage
                              ? bidResolution.source === "individual"
                                ? `Abrir a página oficial de lance com o valor individual (${bidResolution.amount})`
                                : `Abrir a página oficial de lance com o Bid Padrão (${bidResolution.amount}) — campo individual vazio`
                              : auctionBidId
                                ? bidResolution.invalidIndividual
                                  ? "Valor individual inválido — corrija ou limpe o campo para usar o Bid Padrão"
                                  : "Informe um valor numérico válido para habilitar o Bid"
                                : "Personagem sem ID de leilão disponível"}
                            className={`inline-flex h-6 max-w-full min-w-0 items-center justify-center gap-0.5 rounded-lg border px-1.5 text-[9px] font-black transition-colors ${canOpenBidPage
                              ? "border-emerald-500/35 bg-emerald-500/12 text-emerald-300 hover:bg-emerald-500/22 cursor-pointer"
                              : "border-[var(--th-line)]/40 bg-white/[0.03] text-slate-600 cursor-not-allowed"}`}
                          >
                            <FlagTriangleRight size={10} className="flex-shrink-0" /> <span className="truncate">Bid</span>
                          </button>
                        </div>
                      </td>
                    </tr>
                    {isInlinePurchaseOpen && !isAlreadyAddedToPersonalList && inlinePurchaseDraft && (
                      <tr className="border-b border-emerald-500/20 bg-emerald-500/[0.035]">
                        <td colSpan={12} className="px-2 py-2 sm:px-3">
                          <form
                            onSubmit={event => {
                              event.preventDefault();
                              const validationError = getBazaarInlinePurchaseValidationError(inlinePurchaseDraft.account, inlinePurchaseDraft.valorPago);
                              if (validationError) {
                                setInlinePurchase(current => current?.auctionKey === auctionKey ? { ...current, error: validationError } : current);
                                return;
                              }
                              const response = onAddCharacterFromBazaar?.({
                                name: auction.name || "",
                                level: auction.level || 0,
                                server: auction.server || "",
                                vocation: auction.vocation || "",
                                account: inlinePurchaseDraft.account.trim(),
                                valorPago: Number(inlinePurchaseDraft.valorPago),
                              });
                              if (!response?.ok) {
                                setInlinePurchase(current => current?.auctionKey === auctionKey
                                  ? { ...current, error: response?.error || "Não foi possível adicionar este personagem." }
                                  : current);
                                return;
                              }
                              rememberBazaarPurchaseAccount(inlinePurchaseDraft.account.trim());
                              closeInlinePurchase();
                            }}
                            className={`mx-auto flex w-full max-w-4xl flex-col gap-2 rounded-xl border bg-[var(--th-bg-raised)]/90 px-3 py-2.5 shadow-lg shadow-black/20 transition-colors sm:flex-row sm:flex-wrap sm:items-end ${inlineFormReady ? "border-emerald-400/50 shadow-emerald-500/10" : "border-emerald-400/25"}`}
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                <span className="text-[11px] font-black text-emerald-200">Adicionar {auction.name || "personagem"}</span>
                                <span className="rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[9px] text-slate-400">
                                  {auction.server || "—"} · {getVocationAbbreviation(auction.vocation)} · Lv {auction.level || 0}
                                </span>
                              </div>
                              <p className="mt-0.5 text-[10px] leading-tight text-slate-500">
                                {inlineAccountPreset ? (
                                  <>Os dados do Bazaar serão importados automaticamente. A conta foi <strong className="font-bold text-amber-300">pré-preenchida com a última utilizada</strong> — confira se é a correta antes de confirmar (pode alterar normalmente).</>
                                ) : (
                                  "Os dados do Bazaar serão importados automaticamente. Informe somente a conta e o valor pago."
                                )}
                              </p>
                            </div>
                            <label className="block min-w-0 sm:w-44">
                              <span className="mb-1 flex flex-wrap items-center gap-1 text-[9px] font-black uppercase tracking-wider text-slate-400">
                                Conta
                                {inlineAccountChoosing ? (
                                  <span className="inline-flex items-center gap-1 rounded border border-emerald-400/40 bg-emerald-500/10 px-1 py-px text-[8px] font-black uppercase tracking-wide text-emerald-300">escolhendo…</span>
                                ) : inlineAccountEmpty ? (
                                  <span className="inline-flex items-center gap-1 rounded border border-amber-400/40 bg-amber-500/10 px-1 py-px text-[8px] font-black uppercase tracking-wide text-amber-300" title="Selecione na lista ou digite a conta do personagem"><span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400" />obrigatória</span>
                                ) : inlineAccountPreset ? (
                                  <span className="inline-flex items-center gap-1 rounded border border-amber-400/40 bg-amber-500/10 px-1 py-px text-[8px] font-black uppercase tracking-wide text-amber-300" title="Pré-preenchida com a última conta utilizada — confira antes de confirmar. Você pode alterar normalmente."><span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400" />última usada — confira</span>
                                ) : inlineAccountSelected ? (
                                  <span className="inline-flex items-center gap-1 rounded border border-emerald-400/40 bg-emerald-500/10 px-1 py-px text-[8px] font-black uppercase tracking-wide text-emerald-300" title="Conta escolhida na lista de contas disponíveis">✓ selecionada</span>
                                ) : (
                                  <span className="inline-flex items-center gap-1 rounded border border-emerald-400/40 bg-emerald-500/10 px-1 py-px text-[8px] font-black uppercase tracking-wide text-emerald-300" title="Conta digitada manualmente">✓ preenchida</span>
                                )}
                              </span>
                              <div ref={inlineAccountPickerRef} className="relative">
                                <input
                                  ref={inlineAccountInputRef}
                                  type="text"
                                  role="combobox"
                                  aria-autocomplete="list"
                                  aria-expanded={isInlineAccountMenuOpen}
                                  aria-controls={`bazaar-account-options-${auctionKey}`}
                                  value={inlinePurchaseDraft.account}
                                  maxLength={40}
                                  onClick={() => {
                                    setInlineAccountSearch("");
                                    setIsInlineAccountMenuOpen(true);
                                  }}
                                  onChange={event => {
                                    const value = event.target.value;
                                    setInlinePurchase(current => current?.auctionKey === auctionKey ? { ...current, account: value, error: "", accountPreset: false, accountSelected: false } : current);
                                    setInlineAccountSearch(value);
                                    setIsInlineAccountMenuOpen(true);
                                  }}
                                  onKeyDown={event => {
                                    if (event.key === "Escape") {
                                      event.preventDefault();
                                      if (isInlineAccountMenuOpen) {
                                        setIsInlineAccountMenuOpen(false);
                                        setInlineAccountSearch("");
                                      } else {
                                        closeInlinePurchase();
                                      }
                                    }
                                    if (event.key === "ArrowDown") {
                                      event.preventDefault();
                                      setInlineAccountSearch("");
                                      setIsInlineAccountMenuOpen(true);
                                    }
                                  }}
                                  placeholder={availableInlineAccounts.length ? "Selecionar ou digitar" : "Digite uma conta"}
                                  aria-label={`Conta para ${auction.name}`}
                                  title={inlineAccountPreset
                                    ? "Pré-preenchida com a última conta utilizada — confira antes de confirmar. Você pode alterar normalmente."
                                    : inlineAccountEmpty
                                      ? "Selecione na lista ou digite a conta do personagem"
                                      : `Conta selecionada: ${inlineAccountValue}`}
                                  className={`h-8 w-full rounded-lg border bg-black/30 px-2 pr-7 text-xs outline-none transition-colors focus:border-emerald-400/60 ${
                                    inlinePurchaseDraft.error && !inlineAccountValue
                                      ? "border-rose-400/60 text-slate-100 placeholder:text-rose-400/70"
                                      : inlineAccountChoosing
                                        ? "border-emerald-400/70 bg-emerald-500/[0.06] text-emerald-100 shadow-[0_0_10px_rgba(16,185,129,0.20)] placeholder:text-emerald-400/60"
                                        : inlineAccountEmpty
                                          ? "bz-field-pulse border-amber-400/60 bg-amber-500/[0.04] text-slate-100 placeholder:text-amber-500/80"
                                          : inlineAccountPreset
                                            ? "bz-field-pulse bz-field-pulse--soft border-amber-400/50 bg-amber-500/[0.04] text-amber-100 placeholder:text-amber-500/80"
                                            : "border-emerald-400/55 bg-emerald-500/[0.05] text-emerald-100 font-bold shadow-[0_0_8px_rgba(16,185,129,0.16)] placeholder:text-slate-600"
                                  }`}
                                />
                                <button
                                  type="button"
                                  aria-label="Abrir lista de contas"
                                  aria-expanded={isInlineAccountMenuOpen}
                                  onClick={() => {
                                    setInlineAccountSearch("");
                                    setIsInlineAccountMenuOpen(open => !open);
                                  }}
                                  className="absolute inset-y-0 right-0 inline-flex w-7 items-center justify-center text-slate-500 transition-colors hover:text-emerald-200 cursor-pointer"
                                >
                                  <ChevronDown size={13} className={`transition-transform ${isInlineAccountMenuOpen ? "rotate-180" : ""}`} />
                                </button>
                                {isInlineAccountMenuOpen && (
                                  <div id={`bazaar-account-options-${auctionKey}`} role="listbox" className="absolute left-0 right-0 z-[80] mt-1 overflow-hidden rounded-lg border border-emerald-400/30 bg-[var(--th-bg-raised)]/95 shadow-xl shadow-black/45 backdrop-blur-md">
                                    <div className="border-b border-white/10 px-2 py-1 text-[9px] font-black uppercase tracking-wider text-slate-500">
                                      Contas disponíveis
                                    </div>
                                    <div className="max-h-40 overflow-y-auto custom-scrollbar py-1">
                                      {filteredInlineAccounts.length > 0 ? filteredInlineAccounts.map(account => (
                                        <button
                                          key={account}
                                          type="button"
                                          role="option"
                                          aria-selected={account === inlinePurchaseDraft.account}
                                          onClick={() => selectInlinePurchaseAccount(auctionKey, account)}
                                          className={`flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-[11px] transition-colors cursor-pointer ${
                                            account === inlinePurchaseDraft.account
                                              ? "bg-emerald-500/15 text-emerald-100 ring-1 ring-inset ring-emerald-400/30"
                                              : "text-slate-300 hover:bg-white/[0.06] hover:text-white"
                                          }`}
                                        >
                                          <span className="min-w-0 flex-1 truncate font-bold">{account}</span>
                                          {account === inlinePurchaseDraft.account && (
                                            <span className="flex flex-shrink-0 items-center gap-1 text-[8px] font-black uppercase tracking-wide text-emerald-300">
                                              <Check size={12} strokeWidth={3} /> Selecionada
                                            </span>
                                          )}
                                        </button>
                                      )) : (
                                        <div className="px-2.5 py-2 text-[10px] leading-tight text-slate-500">
                                          {availableInlineAccounts.length
                                            ? "Nenhuma conta cadastrada corresponde. Você pode usar a conta digitada."
                                            : "Nenhuma conta cadastrada ainda. Digite uma nova conta para continuar."}
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                )}
                              </div>
                            </label>
                            <label className="block min-w-0 sm:w-28">
                              <span className="mb-1 flex flex-wrap items-center gap-1 text-[9px] font-black uppercase tracking-wider text-slate-400">
                                Valor pago
                                {inlineValorEmpty ? (
                                  <span className="inline-flex items-center gap-1 rounded border border-amber-400/40 bg-amber-500/10 px-1 py-px text-[8px] font-black uppercase tracking-wide text-amber-300" title="Informe o valor pago em RC"><span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400" />obrigatório</span>
                                ) : (
                                  <span className="inline-flex items-center gap-1 rounded border border-emerald-400/40 bg-emerald-500/10 px-1 py-px text-[8px] font-black uppercase tracking-wide text-emerald-300" title="Valor informado">✓ informado</span>
                                )}
                              </span>
                              <input
                                ref={inlineValorPagoInputRef}
                                type="text"
                                inputMode="numeric"
                                pattern="[0-9]*"
                                value={inlinePurchaseDraft.valorPago}
                                maxLength={15}
                                onChange={event => {
                                  const value = event.target.value.replace(/\D/g, "");
                                  setInlinePurchase(current => current?.auctionKey === auctionKey ? { ...current, valorPago: value, error: "" } : current);
                                }}
                                onKeyDown={event => { if (event.key === "Escape") closeInlinePurchase(); }}
                                placeholder="0 RC"
                                aria-label={`Valor pago por ${auction.name}`}
                                title={inlineValorEmpty ? "Informe o valor pago em RC" : "Valor pago em RC"}
                                className={`h-8 w-full rounded-lg border bg-black/30 px-2 text-right font-mono text-xs outline-none transition-colors focus:border-emerald-400/60 ${
                                  inlinePurchaseDraft.error && !inlineValorValue
                                    ? "border-rose-400/60 text-slate-100 placeholder:text-rose-400/70"
                                    : inlineValorEmpty
                                      ? "bz-field-pulse border-amber-400/60 bg-amber-500/[0.04] text-slate-100 placeholder:text-amber-500/80"
                                      : "border-emerald-400/55 bg-emerald-500/[0.05] text-emerald-200 font-bold shadow-[0_0_8px_rgba(16,185,129,0.16)] placeholder:text-slate-600"
                                }`}
                              />
                            </label>
                            <div className="flex items-center gap-1.5 sm:flex-shrink-0">
                              <button
                                type="submit"
                                title={inlineFormReady
                                  ? "Adicionar o personagem à sua lista"
                                  : "Antes de confirmar, confira a conta selecionada e o valor pago"}
                                className={`inline-flex h-8 items-center justify-center gap-1 rounded-lg border px-2.5 text-[10px] font-black transition-colors cursor-pointer ${
                                  inlineFormReady
                                    ? "border-emerald-400/60 bg-emerald-500/25 text-emerald-100 shadow-[0_0_14px_rgba(16,185,129,0.28)] hover:bg-emerald-500/35"
                                    : "border-emerald-400/45 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25"
                                }`}
                              >
                                <Check size={12} strokeWidth={3} /> Confirmar
                              </button>
                              <button type="button" onClick={closeInlinePurchase} className="inline-flex h-8 items-center justify-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 text-[10px] font-black text-slate-400 transition-colors hover:bg-white/10 hover:text-white cursor-pointer">
                                <X size={12} strokeWidth={3} /> Cancelar
                              </button>
                            </div>
                            {inlinePurchaseDraft.error && <p role="alert" className="w-full basis-full text-[10px] font-medium text-rose-300">{inlinePurchaseDraft.error}</p>}
                          </form>
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <BazaarUsedFiltersModal
        isOpen={isUsedFiltersOpen}
        onClose={() => setIsUsedFiltersOpen(false)}
        filters={officialMetadata?.filters || null}
      />

      {/* Confirmação do "Concluir agora". Cancelar não faz NADA: a consulta
          segue rodando exatamente como estava, sem nenhum efeito colateral —
          o pedido só é enviado ao processo principal em `confirmStopNow`. */}
      <ConfirmModal
        open={isStopConfirmOpen}
        title="Concluir a consulta agora"
        message={
          <>
            A consulta será <strong className="font-bold text-slate-100">encerrada imediatamente</strong>.
            Somente os personagens já analisados com sucesso até este momento
            serão salvos
            {activeTotal > 0 && (
              <> — <strong className="font-bold text-slate-100">{activeProcessed} de {activeTotal}</strong> processados até agora</>
            )}
            .
          </>
        }
        detail={
          "Personagens com falha, ainda em análise ou não verificados ficam de fora. "
          + "Os retries e navegadores pendentes não serão executados. "
          + "A lista resultante é marcada como incompleta e, por isso, exige sua confirmação antes de substituir a lista oficial."
        }
        confirmLabel="Concluir agora"
        cancelLabel="Continuar consultando"
        tone="neutral"
        onConfirm={confirmStopNow}
        onCancel={() => setIsStopConfirmOpen(false)}
      />

      {/* Seleção do navegador — exclusivo do Electron. Cancelar não inicia
          consulta alguma; confirmar dispara o fluxo normal com o mecanismo
          escolhido. */}
      <BazaarBrowserModal
        open={isBrowserModalOpen}
        onCancel={() => setIsBrowserModalOpen(false)}
        onConfirm={(browserKey, browserOrder, cleanProfile, retryBrowsers, speedMode, retryCounts, method) => {
          setIsBrowserModalOpen(false);
          void handleFetchBazaar({ browserKey, browserOrder, cleanProfile, retryBrowsers, speedMode, retryCounts, method });
        }}
      />

      <FriendsSummaryModal
        isOpen={isFriendsSummaryOpen}
        onClose={() => setIsFriendsSummaryOpen(false)}
        characters={sharedCharacters}
        waitingList={waitingList}
        activeParties={activeParties}
        filters={friendsSummaryFilters}
        onOpenFilters={() => setIsFriendsSummaryFiltersOpen(true)}
      />

      {/* Auto Bid — somente Boss + Electron. Nenhum efeito na versão Web. */}
      {isBossUser && isElectron && (
        <AutoBidModal
          open={isAutoBidOpen}
          onClose={() => setIsAutoBidOpen(false)}
          characters={autoBidCharacters.map(auction => ({
            id: String(auction.id || ""),
            name: auction.name || "",
            server: auction.server || "",
            vocation: auction.vocation || "",
            url: auction.url || "",
            auctionEndTs: auction.auctionEndTs ?? null,
          }))}
          interests={bazaarInterests}
          currentUserUid={currentUser?.uid || null}
          bazaarVersion={officialMetadata?.version || ""}
        />
      )}

      <OverviewFiltersModal
        open={isFriendsSummaryFiltersOpen}
        // Acima do FriendsSummaryModal (z-[9999]) para abrir SOBRE ele.
        // Fechar aqui não fecha o Resumo de Amigos.
        zIndexClassName="z-[10000]"
        onClose={() => setIsFriendsSummaryFiltersOpen(false)}
        questFilter={friendsSummaryQuestFilter}
        setQuestFilter={setFriendsSummaryQuestFilter}
        templateType={friendsSummaryTemplateType}
        setTemplateType={setFriendsSummaryTemplateType}
        minLevels={friendsSummaryMinLevels}
        setMinLevels={setFriendsSummaryMinLevels}
        userMode={friendsSummaryUserMode}
        setUserMode={setFriendsSummaryUserMode}
        selectedUsers={friendsSummarySelectedUsers}
        setSelectedUsers={setFriendsSummarySelectedUsers}
        useCharacters={friendsSummaryUseCharacters}
        setUseCharacters={setFriendsSummaryUseCharacters}
        useWaitingList={friendsSummaryUseWaitingList}
        setUseWaitingList={setFriendsSummaryUseWaitingList}
        onReset={resetFriendsSummaryFilters}
      />

      <BazaarSearchFiltersModal
        isOpen={isFiltersModalOpen}
        onClose={() => setIsFiltersModalOpen(false)}
        vocations={VOCATIONS}
        vocationLevels={vocationLevels}
        onVocationLevelChange={setVocationLevel}
        serverOptions={serverOptions}
        serverSelectionMode={serverSelectionMode}
        selectedServers={selectedServers}
        onServerSelectionModeChange={setServerSelectionMode}
        onSelectedServersChange={setSelectedServers}
        maxValue={maxValue}
        onMaxValueChange={setMaxValue}
        soulwarFilter={soulwarFilter}
        onSoulwarFilterChange={setSoulwarFilter}
        sanguineFilter={sanguineFilter}
        onSanguineFilterChange={setSanguineFilter}
        endUntil={endUntil}
        onEndUntilChange={setEndUntil}
        endUntilMode={endUntilMode}
        onEndUntilModeChange={setEndUntilMode}
        endUntilAutoTime={endUntilAutoTime}
        onEndUntilAutoTimeChange={value => setEndUntilAutoTime(normalizeEndUntilAutoTime(value))}
        autoEndUntilPreview={formatEndUntilForDisplay(computeAutoEndUntilFromTime(timezoneOffsetMinutes, endUntilAutoTime))}
      />
    </div>
  );
}

function BazarVipAccessPanel() {
  const benefits = [
    "Busca automática dos melhores personagens do Character Bazaar",
    "Filtros avançados por servidor, level, vocação, quests, valor e encerramento",
    "Consulta automática de Soul War e Sanguine via Bosstiary",
    "Resumo inteligente dos servidores e recomendação de compras",
    "Lista oficial compartilhada, interesses e alertas de encerramento",
  ];
  const upcoming = [
    "Compra automática de personagens",
    "Histórico de oportunidades",
    "Ranking das melhores ofertas",
    "Comparativo de preços",
    "Estatísticas de mercado",
  ];

  return (
    <div className="h-full w-full overflow-hidden relative bg-cover bg-center" style={{ backgroundImage: `url(${bazarBgUrl})` }}>
      <div className="absolute inset-0 bg-[var(--th-n-deep)]/90 pointer-events-none" />
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-[8%] left-[12%] w-[35%] h-[35%] rounded-full bg-amber-500/10 blur-[110px]" />
        <div className="absolute bottom-[8%] right-[12%] w-[35%] h-[35%] rounded-full bg-purple-500/10 blur-[120px]" />
      </div>

      <div className="relative z-10 h-full flex items-center justify-center p-4">
        <div className="w-full max-w-4xl rounded-3xl border border-amber-500/25 bg-[var(--th-n-raised)]/92 backdrop-blur-md shadow-2xl shadow-black/60 overflow-hidden">
          <div className="px-6 py-6 border-b border-[var(--th-line)]/60 bg-gradient-to-r from-amber-950/20 via-[var(--th-bg-raised)] to-purple-950/20 text-center">
            <div className="mx-auto mb-3 w-16 h-16 rounded-2xl border border-amber-500/30 bg-amber-500/10 flex items-center justify-center shadow-[0_0_32px_color-mix(in_oklab,var(--color-amber-500)_14%,transparent)]">
              <Crown size={30} className="text-amber-300" />
            </div>
            <h2 className="text-2xl font-black bg-gradient-to-r from-amber-200 via-yellow-400 to-amber-500 bg-clip-text text-transparent tracking-tight">
              Painel Bazaar VIP
            </h2>
            <p className="mt-2 text-sm text-slate-400 max-w-2xl mx-auto leading-relaxed">
              Tenha acesso ao sistema inteligente de monitoramento do Character Bazaar e encontre oportunidades com filtros, quests, recomendações e alertas.
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 p-5">
            <section className="rounded-2xl border border-[var(--th-line)]/60 bg-black/25 p-4 space-y-3">
              <div className="flex items-center gap-2 text-amber-300 font-black uppercase tracking-wide text-xs">
                <Sparkles size={15} /> Benefícios VIP
              </div>
              <div className="space-y-2">
                {benefits.map(item => (
                  <div key={item} className="flex items-start gap-2 text-xs text-slate-300 leading-relaxed">
                    <CheckCircle2 size={14} className="text-emerald-400 flex-shrink-0 mt-0.5" />
                    <span>{item}</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-2xl border border-purple-500/20 bg-purple-500/[0.04] p-4 space-y-3">
              <div className="flex items-center gap-2 text-purple-300 font-black uppercase tracking-wide text-xs">
                <ShoppingBag size={15} /> Recursos futuros
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {upcoming.map(item => (
                  <div key={item} className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px] text-slate-300">
                    {item}
                  </div>
                ))}
              </div>
              <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-xs text-amber-200 leading-relaxed">
                O Painel Bazaar é uma ferramenta premium. Ative seu VIP para visualizar a lista oficial, interesses, alertas e recomendações de compra.
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function BazarPanel(props: BazarPanelProps) {
  const { userProfile } = useAuth();
  const hasAccess = userProfile?.role === "Boss" || userProfile?.role === "VIP";
  if (!hasAccess) return <BazarVipAccessPanel />;
  return <BazarPanelContent {...props} />;
}