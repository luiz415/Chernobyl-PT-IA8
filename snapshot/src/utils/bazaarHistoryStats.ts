// ============================================================================
// HISTÓRICO OFICIAL DO BAZAAR — tipos, tuplas analíticas e MÉTRICAS (v2)
// ----------------------------------------------------------------------------
// Camada de dados da tela "Estatísticas do Bazaar", reprojetada para VOLUME
// (~10 mil personagens/mês) E para FILTROS COMBINADOS POR FAIXA LIVRE.
// Duas responsabilidades EXPLICITAMENTE separadas:
//
//   • BASE HISTÓRICA (bruta): cada leilão aprovado (Finalizado + Lance
//     Vencedor) vira UM DOCUMENTO completo e auto-suficiente, cujo ID é o
//     identificador estável do leilão no RubinOT
//     (`bazaarHistoryRaw/{auctionId}` — ver serviço), com `day`/`ym`/
//     `endTs`/`server` no topo para reagregações futuras. Serve de fonte
//     permanente/auditoria; a TELA NUNCA a lê.
//
//   • MÉTRICAS v2 (tuplas analíticas): 1 documento por MÊS × SERVIDOR
//     (`bazaarHistoryMetrics/{YYYY-MM__servidor}`) com um mapa `a` de
//     TUPLAS COMPACTAS por leilão (`a[auctionId] = {v,l,b,i,...}`). A tela
//     lê SOMENTE esses documentos — poucos, previsíveis e cacheáveis
//     (meses passados são imutáveis) — e calcula TODAS as estatísticas em
//     memória sobre as tuplas filtradas.
//
// ── POR QUE TUPLAS E NÃO CÉLULAS AGREGADAS (v1)? ───────────────────────────
// A v1 pré-agregava células `vocação|faixaLevel|SW|SG|faixaLance`: filtros
// só funcionavam nas FAIXAS FIXAS dessas dimensões, e intervalos livres
// (ex.: Charm 800–1500, skills mín/máx, Level 737–912, Deluxe 0/1/vários)
// eram matematicamente impossíveis sem explosão combinatória de células.
// A v2 troca a pré-agregação por tuplas de ~60-100 bytes por leilão dentro
// dos MESMOS documentos mês×servidor:
//   • LEITURAS: idênticas (os mesmos poucos docs, mesmo cache local por
//     `updatedAtMs`) — mudar filtro continua custando ZERO leituras;
//   • ESCRITAS: idênticas (mesmos docs na ingestão) e ainda REPARADORAS —
//     regravar um leilão conhecido SOBRESCREVE a tupla (corrige dados
//     históricos, ex.: Passe Deluxe) sem jamais contar duas vezes
//     (idempotência pelo próprio mapa por id);
//   • BYTES: crescem (~1-2 MB/mês no total), o que é explicitamente o
//     custo aceito do projeto (prioridade = reads/writes, não bytes);
//   • PRECISÃO: toda estatística é EXATA para o conjunto filtrado — nunca
//     uma média de subconjunto incompatível com os filtros.
// Documentos v1 (com `cells`, sem `a`) são detectados como LEGADO: ficam
// FORA das estatísticas (para não misturar números não-filtráveis) e a
// tela orienta rodar "30 dias completos" para convertê-los.
//
// A DATA DE TÉRMINO é o elemento central: particiona a base (dia), as
// métricas (mês), o incremental (fronteira `lastEndTs`) e a janela de 30
// dias do site. Os cortes de mês/dia usam UTC — determinístico em qualquer
// dispositivo (o fuso do aparelho não muda a partição).
// ============================================================================

import type { ItemsCharacterSkills, RawItemMatch } from "./bazaarWatchedItems";

// ── Janela e fronteiras ─────────────────────────────────────────────────────
export const HISTORY_WINDOW_DAYS = 30;
/** Margem da fronteira incremental (deve espelhar o módulo Electron). */
export const HISTORY_INCREMENTAL_MARGIN_SECONDS = 6 * 3600;

/** 'YYYY-MM' (UTC) do timestamp de término — partição das métricas. */
export function monthKeyFromTs(endTs: number): string {
  const date = new Date(endTs * 1000);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** 'YYYY-MM-DD' (UTC) do timestamp de término — campo `day` da base bruta. */
export function dayKeyFromTs(endTs: number): string {
  const date = new Date(endTs * 1000);
  return `${monthKeyFromTs(endTs)}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

/** Rótulo pt-BR de um mês 'YYYY-MM' ("set/2026"). */
export function monthLabel(ym: string): string {
  const [year, month] = ym.split("-").map(Number);
  const names = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  if (!year || !month || month < 1 || month > 12) return ym;
  return `${names[month - 1]}/${year}`;
}

// ── Entrada da BASE HISTÓRICA (completa — bytes não são o problema) ────────

/** Resultado bruto de um leilão devolvido pelo canal Electron. */
export interface BazaarHistoryRawEntry {
  id: string;
  name: string;
  vocation: string;
  level: number;
  server: string;
  /** Lance Vencedor em RC (o lance do Bazaar já é em Rubini Coins). */
  winningBid: number;
  /** Data de término (segundos epoch) — ELEMENTO CENTRAL da arquitetura. */
  auctionEndTs: number | null;
  statusText?: string;
  matches?: RawItemMatch[];
  gold?: number;
  skills?: ItemsCharacterSkills;
  soulwarCompleted?: boolean | null;
  sanguineCompleted?: boolean | null;
  charmPoints?: number | null;
  auraCount?: number | null;
  hirelingCount?: number | null;
  deluxePassCount?: number | null;
  detailError?: string;
}

/** Resposta completa do canal `rubinot-bazaar-history-v1`. */
export interface BazaarHistoryQueryResponse {
  ok: boolean;
  error?: string;
  needsHumanVerification?: boolean;
  fetchedAt?: number;
  routeUsed?: string;
  discoveredBy?: string;
  orderingDetected?: string;
  pagesScanned?: number;
  floorTs?: number;
  listedCount?: number;
  approvedNewCount?: number;
  knownSkippedCount?: number;
  analyzedCount?: number;
  failedCount?: number;
  stoppedManually?: boolean;
  entries?: BazaarHistoryRawEntry[];
  processedMaxEndTs?: number;
  totalDurationMs?: number;
  primaryBrowser?: string;
}

/**
 * Entrada PERSISTIDA na base histórica: o leilão completo, já precificado.
 * Auto-suficiente — nenhuma releitura externa é necessária no futuro.
 */
export interface BazaarHistoryEntry {
  id: string;
  name: string;
  vocation: string;
  level: number;
  server: string;
  /** Data de término (segundos epoch). Obrigatória — organiza TUDO. */
  endTs: number;
  /** Lance Vencedor em RC. */
  bidRc: number;
  /** Valor dos itens monitorados em kk (lista do servidor, sem fallback). */
  itemsKk: number;
  /** Valor dos itens em RC pela cotação vigente NA INGESTÃO. */
  itemsRc: number;
  /** Cotação kk/coin usada na conversão (auditoria). */
  coinRateKk: number;
  /** Matches de itens (nome/tier/qtde/valor) — auditoria futura. */
  matches?: { foundName: string; tier: number; amount: number; totalKk: number }[];
  goldKk?: number;
  skills?: ItemsCharacterSkills;
  soulwar: boolean | null;
  sanguine: boolean | null;
  charmPoints: number | null;
  auraCount: number | null;
  hirelingCount: number | null;
  deluxePassCount: number | null;
  statusText?: string;
  detailError?: string;
}

// ── Faixas de HISTOGRAMA (exibição das distribuições, NÃO de filtro) ───────

export interface RangeBand { key: string; label: string; min: number; max: number }

export const BID_BUCKETS: RangeBand[] = [
  { key: "B1", label: "1–249 RC", min: 0, max: 249 },
  { key: "B2", label: "250–499 RC", min: 250, max: 499 },
  { key: "B3", label: "500–999 RC", min: 500, max: 999 },
  { key: "B4", label: "1000–2499 RC", min: 1000, max: 2499 },
  { key: "B5", label: "2500–4999 RC", min: 2500, max: 4999 },
  { key: "B6", label: "5000+ RC", min: 5000, max: Infinity },
];

export const CHARM_BUCKETS: RangeBand[] = [
  { key: "C1", label: "0–249", min: 0, max: 249 },
  { key: "C2", label: "250–499", min: 250, max: 499 },
  { key: "C3", label: "500–999", min: 500, max: 999 },
  { key: "C4", label: "1000–1999", min: 1000, max: 1999 },
  { key: "C5", label: "2000+", min: 2000, max: Infinity },
];

function bandKeyOf(bands: RangeBand[], value: number): string {
  for (const band of bands) {
    if (value >= band.min && value <= band.max) return band.key;
  }
  return bands[bands.length - 1].key;
}

export function bidBucketKey(bidRc: number): string { return bandKeyOf(BID_BUCKETS, Math.max(0, bidRc)); }
export function charmBucketKey(charm: number): string { return bandKeyOf(CHARM_BUCKETS, Math.max(0, charm)); }

// ── TUPLA ANALÍTICA (métricas v2) ───────────────────────────────────────────

/**
 * Tupla compacta de UM leilão dentro do doc de métricas (`a[auctionId]`).
 * Chaves curtas deliberadas (milhares de tuplas por documento). Campos
 * OPCIONAIS ausentes = "sem dado" (nunca um valor fictício):
 *   v vocação · l level · b lance RC · i itens RC (0 = sem itens avaliados)
 *   w soulwar (1 concluída / 0 disponível / ausente sem dado) · g sanguine
 *   c charm points · u auras · h hirelings · d passes Deluxe (0 é VÁLIDO:
 *   personagem com Battlepass todo "não") · s skills presentes (inteiras).
 */
export interface AuctionTuple {
  v: string;
  l: number;
  b: number;
  i: number;
  w?: 0 | 1;
  g?: 0 | 1;
  c?: number;
  u?: number;
  h?: number;
  d?: number;
  s?: Record<string, number>;
}

/** Converte a entrada persistida na tupla analítica do doc de métricas. */
export function entryToTuple(entry: BazaarHistoryEntry): AuctionTuple {
  const tuple: AuctionTuple = {
    v: entry.vocation || "—",
    l: Math.max(0, Math.floor(entry.level || 0)),
    b: Math.max(0, Math.floor(entry.bidRc || 0)),
    i: Math.max(0, Math.floor(entry.itemsRc || 0)),
  };
  if (entry.soulwar === true) tuple.w = 1; else if (entry.soulwar === false) tuple.w = 0;
  if (entry.sanguine === true) tuple.g = 1; else if (entry.sanguine === false) tuple.g = 0;
  if (typeof entry.charmPoints === "number" && Number.isFinite(entry.charmPoints)) tuple.c = Math.max(0, Math.floor(entry.charmPoints));
  if (typeof entry.auraCount === "number" && Number.isFinite(entry.auraCount)) tuple.u = Math.max(0, Math.floor(entry.auraCount));
  if (typeof entry.hirelingCount === "number" && Number.isFinite(entry.hirelingCount)) tuple.h = Math.max(0, Math.floor(entry.hirelingCount));
  if (typeof entry.deluxePassCount === "number" && Number.isFinite(entry.deluxePassCount)) tuple.d = Math.max(0, Math.floor(entry.deluxePassCount));
  if (entry.skills) {
    const skills: Record<string, number> = {};
    for (const [key, value] of Object.entries(entry.skills)) {
      if (Number.isFinite(value)) skills[key] = Math.floor(value as number);
    }
    if (Object.keys(skills).length > 0) tuple.s = skills;
  }
  return tuple;
}

/** Id do documento de métricas de um mês+servidor. */
export function metricsDocId(ym: string, server: string): string {
  return `${ym}__${String(server || "—").replace(/[\/\s]+/g, "_")}`;
}

/** Documento de métricas em memória (já normalizado pela camada de serviço). */
export interface MetricsDocData {
  ym: string;
  server: string;
  /** Tuplas por auctionId (métricas v2). */
  auctions: Record<string, AuctionTuple>;
  /**
   * Doc no formato ANTERIOR (células agregadas, sem tuplas): fica FORA das
   * estatísticas até ser convertido por uma consulta "30 dias completos".
   */
  legacy?: boolean;
  /** Contagem informada pelo doc legado (exibida no aviso de conversão). */
  legacyCount?: number;
}

// ── Filtros da análise (100% resolvidos nas tuplas em memória) ─────────────

export type HistoryQuestFilter = "any" | "available" | "completed";

/** Faixa numérica mín/máx — null = sem limite naquele lado. */
export interface NumberRange { min: number | null; max: number | null }

export function emptyRange(): NumberRange { return { min: null, max: null }; }
export function rangeActive(range: NumberRange | undefined): boolean {
  return !!range && (range.min !== null || range.max !== null);
}
function inRange(value: number, range: NumberRange): boolean {
  if (range.min !== null && value < range.min) return false;
  if (range.max !== null && value > range.max) return false;
  return true;
}

export interface HistoryMetricsFilters {
  /** Meses 'YYYY-MM' selecionados; vazio = todos os disponíveis. */
  months: string[];
  /** Seleção MÚLTIPLA de servidores; vazio = todos. */
  servers: string[];
  /** Seleção MÚLTIPLA de vocações; vazio = todas. */
  vocations: string[];
  /** Faixas numéricas livres (null/null = inativo). */
  level: NumberRange;
  bid: NumberRange;
  items: NumberRange;
  charm: NumberRange;
  auras: NumberRange;
  hirelings: NumberRange;
  deluxe: NumberRange;
  soulwar: HistoryQuestFilter;
  sanguine: HistoryQuestFilter;
  /**
   * Faixas por SKILL (chave = skill da guia Itens: axe/club/sword/fist/
   * distance/magic/shielding). Uma skill com faixa ativa só aceita
   * personagens cuja VOCAÇÃO tem essa skill nas regras da guia Itens E que
   * têm o dado coletado — sem valores fictícios nem descarte indevido.
   */
  skills: Record<string, NumberRange>;
}

export function defaultHistoryFilters(): HistoryMetricsFilters {
  return {
    months: [], servers: [], vocations: [],
    level: emptyRange(), bid: emptyRange(), items: emptyRange(),
    charm: emptyRange(), auras: emptyRange(), hirelings: emptyRange(), deluxe: emptyRange(),
    soulwar: "any", sanguine: "any",
    skills: {},
  };
}

/** Quantidade de filtros ATIVOS (para o selo do quadro de filtros). */
export function countActiveHistoryFilters(filters: HistoryMetricsFilters): number {
  let active = 0;
  if (filters.months.length > 0) active += 1;
  if (filters.servers.length > 0) active += 1;
  if (filters.vocations.length > 0) active += 1;
  for (const range of [filters.level, filters.bid, filters.items, filters.charm, filters.auras, filters.hirelings, filters.deluxe]) {
    if (rangeActive(range)) active += 1;
  }
  if (filters.soulwar !== "any") active += 1;
  if (filters.sanguine !== "any") active += 1;
  for (const range of Object.values(filters.skills)) {
    if (rangeActive(range)) active += 1;
  }
  return active;
}

export function hasActiveHistoryFilters(filters: HistoryMetricsFilters): boolean {
  return countActiveHistoryFilters(filters) > 0;
}

function matchQuest(value: 0 | 1 | undefined, filter: HistoryQuestFilter): boolean {
  if (filter === "any") return true;
  if (filter === "available") return value === 0;
  return value === 1;
}

/**
 * Resolve as skills RELEVANTES de uma vocação — assinatura de
 * `skillDefsForVocation` da guia Itens (injetada pela tela para reutilizar
 * as regras ÚNICAS do app sem criar import circular entre camadas).
 */
export type SkillDefsResolver = (vocation: string) => { key: string }[] | null;

/**
 * Uma tupla passa nos filtros? TODAS as condições valem EM CONJUNTO.
 * Campos "sem dado" (ausentes) NUNCA passam em uma faixa ativa — uma
 * média/contagem filtrada jamais inclui quem não tem o dado comparável.
 * SKILLS seguem as regras POR VOCAÇÃO da guia Itens: faixa ativa numa
 * skill que a vocação do personagem NÃO tem → personagem fora do conjunto.
 */
export function tupleMatchesFilters(
  tuple: AuctionTuple,
  filters: HistoryMetricsFilters,
  skillDefs: SkillDefsResolver,
): boolean {
  if (filters.vocations.length > 0 && !filters.vocations.includes(tuple.v)) return false;
  if (!inRange(tuple.l, filters.level)) return false;
  if (!inRange(tuple.b, filters.bid)) return false;
  if (!inRange(tuple.i, filters.items)) return false;
  if (!matchQuest(tuple.w, filters.soulwar)) return false;
  if (!matchQuest(tuple.g, filters.sanguine)) return false;
  if (rangeActive(filters.charm) && (tuple.c === undefined || !inRange(tuple.c, filters.charm))) return false;
  if (rangeActive(filters.auras) && (tuple.u === undefined || !inRange(tuple.u, filters.auras))) return false;
  if (rangeActive(filters.hirelings) && (tuple.h === undefined || !inRange(tuple.h, filters.hirelings))) return false;
  // Deluxe: `d = 0` é um valor REAL (todas as temporadas "não") e compara
  // normalmente; ausente = desconhecido e não passa em faixa ativa.
  if (rangeActive(filters.deluxe) && (tuple.d === undefined || !inRange(tuple.d, filters.deluxe))) return false;

  for (const [skillKey, range] of Object.entries(filters.skills)) {
    if (!rangeActive(range)) continue;
    const defs = skillDefs(tuple.v);
    if (!defs || !defs.some(def => def.key === skillKey)) return false; // skill não se aplica à vocação
    const value = tuple.s?.[skillKey];
    if (!Number.isFinite(value)) return false; // sem dado coletado — nunca inventar valor
    if (!inRange(value as number, range)) return false;
  }
  return true;
}

// ── Estatísticas calculadas das tuplas filtradas ────────────────────────────

export interface BazaarHistoryStats {
  count: number;
  avgWinningBidRc: number;
  minWinningBidRc: number;
  maxWinningBidRc: number;
  avgItemsRc: number;
  withItemsCount: number;
  avgLevel: number;
  minLevel: number;
  maxLevel: number;
  avgCharmPoints: number;
  charmSampleCount: number;
  avgAuras: number;
  auraSampleCount: number;
  avgHirelings: number;
  hirelingSampleCount: number;
  avgDeluxePasses: number;
  deluxeSampleCount: number;
  /** Soma de passes Deluxe no conjunto filtrado. */
  totalDeluxePasses: number;
  /** Distribuição 0 / 1 / 2+ passes Deluxe (entre quem tem o dado). */
  deluxeDistribution: { label: string; count: number }[];
  byVocation: { label: string; count: number }[];
  byServer: { label: string; count: number }[];
  byMonth: { label: string; count: number; avgBid: number }[];
  soulwar: { available: number; completed: number; unknown: number };
  sanguine: { available: number; completed: number; unknown: number };
  bidDistribution: { label: string; count: number }[];
  charmDistribution: { label: string; count: number }[];
  /** Médias de skills por vocação (somente skills presentes). */
  skillsByVocation: { vocation: string; count: number; skills: { key: string; avg: number; n: number }[] }[];
}

function round1(value: number): number { return Math.round(value * 10) / 10; }

/**
 * Consolida TODAS as estatísticas a partir das TUPLAS dos documentos de
 * métricas, aplicando os filtros combinados. Nenhuma leitura além dos docs
 * já em memória; nenhuma entrada bruta é percorrida. Docs LEGADO (v1) são
 * ignorados — a tela avisa e orienta a conversão.
 */
export function computeStatsFromMetricDocs(
  docs: MetricsDocData[],
  filters: HistoryMetricsFilters,
  skillDefs: SkillDefsResolver,
): BazaarHistoryStats {
  let count = 0;
  let bidSum = 0; let bidMin = 0; let bidMax = 0;
  let itemsSum = 0; let itemsN = 0;
  let levelSum = 0; let levelMin = 0; let levelMax = 0;
  let charmSum = 0; let charmN = 0;
  let auraSum = 0; let auraN = 0;
  let hireSum = 0; let hireN = 0;
  let deluxeSum = 0; let deluxeN = 0;
  const deluxeDist = { zero: 0, one: 0, multi: 0 };
  const byVocation = new Map<string, number>();
  const byServer = new Map<string, number>();
  const byMonth = new Map<string, { count: number; bidSum: number }>();
  const sw = { available: 0, completed: 0, unknown: 0 };
  const sg = { available: 0, completed: 0, unknown: 0 };
  const bidDist = new Map<string, number>();
  const charmDist = new Map<string, number>();
  const skillsByVoc = new Map<string, { count: number; sk: Record<string, { s: number; n: number }> }>();

  for (const docData of docs) {
    if (docData.legacy) continue; // formato antigo: fora das estatísticas
    if (filters.months.length > 0 && !filters.months.includes(docData.ym)) continue;
    if (filters.servers.length > 0 && !filters.servers.includes(docData.server)) continue;
    for (const tuple of Object.values(docData.auctions || {})) {
      if (!tupleMatchesFilters(tuple, filters, skillDefs)) continue;

      count += 1;
      bidSum += tuple.b;
      bidMin = bidMin === 0 ? tuple.b : Math.min(bidMin, tuple.b);
      bidMax = Math.max(bidMax, tuple.b);
      if (tuple.i > 0) { itemsSum += tuple.i; itemsN += 1; }
      levelSum += tuple.l;
      levelMin = levelMin === 0 ? tuple.l : Math.min(levelMin, tuple.l);
      levelMax = Math.max(levelMax, tuple.l);
      if (tuple.c !== undefined) {
        charmSum += tuple.c; charmN += 1;
        const bucket = charmBucketKey(tuple.c);
        charmDist.set(bucket, (charmDist.get(bucket) || 0) + 1);
      }
      if (tuple.u !== undefined) { auraSum += tuple.u; auraN += 1; }
      if (tuple.h !== undefined) { hireSum += tuple.h; hireN += 1; }
      if (tuple.d !== undefined) {
        deluxeSum += tuple.d; deluxeN += 1;
        if (tuple.d === 0) deluxeDist.zero += 1;
        else if (tuple.d === 1) deluxeDist.one += 1;
        else deluxeDist.multi += 1;
      }

      byVocation.set(tuple.v, (byVocation.get(tuple.v) || 0) + 1);
      byServer.set(docData.server, (byServer.get(docData.server) || 0) + 1);
      const month = byMonth.get(docData.ym) || { count: 0, bidSum: 0 };
      month.count += 1;
      month.bidSum += tuple.b;
      byMonth.set(docData.ym, month);
      if (tuple.w === 0) sw.available += 1; else if (tuple.w === 1) sw.completed += 1; else sw.unknown += 1;
      if (tuple.g === 0) sg.available += 1; else if (tuple.g === 1) sg.completed += 1; else sg.unknown += 1;
      const bidBucket = bidBucketKey(tuple.b);
      bidDist.set(bidBucket, (bidDist.get(bidBucket) || 0) + 1);

      const vocSkills = skillsByVoc.get(tuple.v) || { count: 0, sk: {} };
      vocSkills.count += 1;
      if (tuple.s) {
        for (const [skillKey, value] of Object.entries(tuple.s)) {
          if (!Number.isFinite(value)) continue;
          const existing = vocSkills.sk[skillKey] || { s: 0, n: 0 };
          existing.s += value;
          existing.n += 1;
          vocSkills.sk[skillKey] = existing;
        }
      }
      skillsByVoc.set(tuple.v, vocSkills);
    }
  }

  const sortedDist = (map: Map<string, number>) => Array.from(map.entries())
    .map(([label, total]) => ({ label, count: total }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "pt-BR"));

  return {
    count,
    avgWinningBidRc: count > 0 ? Math.round(bidSum / count) : 0,
    minWinningBidRc: bidMin,
    maxWinningBidRc: bidMax,
    avgItemsRc: itemsN > 0 ? Math.round(itemsSum / itemsN) : 0,
    withItemsCount: itemsN,
    avgLevel: count > 0 ? Math.round(levelSum / count) : 0,
    minLevel: levelMin,
    maxLevel: levelMax,
    avgCharmPoints: charmN > 0 ? Math.round(charmSum / charmN) : 0,
    charmSampleCount: charmN,
    avgAuras: auraN > 0 ? round1(auraSum / auraN) : 0,
    auraSampleCount: auraN,
    avgHirelings: hireN > 0 ? round1(hireSum / hireN) : 0,
    hirelingSampleCount: hireN,
    avgDeluxePasses: deluxeN > 0 ? round1(deluxeSum / deluxeN) : 0,
    deluxeSampleCount: deluxeN,
    totalDeluxePasses: deluxeSum,
    deluxeDistribution: [
      { label: "0 passes", count: deluxeDist.zero },
      { label: "1 passe", count: deluxeDist.one },
      { label: "2+ passes", count: deluxeDist.multi },
    ].filter(row => row.count > 0),
    byVocation: sortedDist(byVocation),
    byServer: sortedDist(byServer),
    byMonth: Array.from(byMonth.entries())
      .map(([ym, data]) => ({ label: ym, count: data.count, avgBid: data.count > 0 ? Math.round(data.bidSum / data.count) : 0 }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    soulwar: sw,
    sanguine: sg,
    bidDistribution: BID_BUCKETS
      .map(bucket => ({ label: bucket.label, count: bidDist.get(bucket.key) || 0 }))
      .filter(row => row.count > 0),
    charmDistribution: CHARM_BUCKETS
      .map(bucket => ({ label: bucket.label, count: charmDist.get(bucket.key) || 0 }))
      .filter(row => row.count > 0),
    skillsByVocation: Array.from(skillsByVoc.entries())
      .map(([vocation, data]) => ({
        vocation,
        count: data.count,
        skills: Object.entries(data.sk)
          .filter(([, bucket]) => bucket.n > 0)
          .map(([key, bucket]) => ({ key, avg: round1(bucket.s / bucket.n), n: bucket.n })),
      }))
      .filter(group => group.skills.length > 0)
      .sort((a, b) => b.count - a.count || a.vocation.localeCompare(b.vocation, "pt-BR")),
  };
}
