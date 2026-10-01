// ============================================================================
// HISTÓRICO OFICIAL DO BAZAAR — tipos, dimensões e MÉTRICAS agregadas
// ----------------------------------------------------------------------------
// Camada de dados da tela "Estatísticas do Bazaar", reprojetada para VOLUME
// (~10 mil personagens/mês, crescimento contínuo por anos). Duas
// responsabilidades EXPLICITAMENTE separadas:
//
//   • BASE HISTÓRICA (bruta): cada leilão aprovado (Finalizado + Lance
//     Vencedor) vira UM DOCUMENTO completo e auto-suficiente, cujo ID é o
//     identificador estável do leilão no RubinOT
//     (`bazaarHistoryRaw/{auctionId}` — ver serviço), com `day`/`ym`/
//     `endTs`/`server` no topo para reagregações futuras. Nenhum doc
//     cresce com o tempo e regravar é fisicamente idempotente.
//     Serve de fonte permanente/auditoria; a TELA NUNCA a lê.
//
//   • MÉTRICAS (agregadas): células dimensionais pré-processadas no momento
//     da ingestão, particionadas por MÊS de término e SERVIDOR
//     (`bazaarHistoryMetrics/{YYYY-MM__servidor}`). A tela lê SOMENTE esses
//     documentos — poucos, previsíveis e cacheáveis — e todos os filtros
//     são resolvidos localmente sobre as células, sem tocar na base bruta.
//
// ── DIMENSÕES DAS CÉLULAS (equilíbrio granularidade × leituras) ────────────
// Chave da célula: `vocação|faixaLevel|SW|SG|faixaLance` dentro do doc
// mês+servidor. Filtros EXATOS suportados: mês(es), servidor, vocação,
// faixa de level, Soul War, Sanguine e faixa de lance. Demais atributos
// (charm, auras, hirelings, deluxe, skills, itens) são MEDIDAS agregadas
// (somas/contagens/histogramas) dentro de cada célula — exibidos como
// médias/distribuições do conjunto filtrado. Combinações ilimitadas de
// range livre exigiriam explosão combinatória de documentos; esta é a
// partição deliberada (documentada) que atende os filtros da tela com
// pouquíssimas leituras e nenhuma duplicação da base bruta.
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

// ── Dimensões (faixas fixas — mudá-las exige reagregar a base bruta) ───────

export interface RangeBand { key: string; label: string; min: number; max: number }

export const LEVEL_BANDS: RangeBand[] = [
  { key: "L1", label: "1–249", min: 0, max: 249 },
  { key: "L2", label: "250–399", min: 250, max: 399 },
  { key: "L3", label: "400–549", min: 400, max: 549 },
  { key: "L4", label: "550–699", min: 550, max: 699 },
  { key: "L5", label: "700–999", min: 700, max: 999 },
  { key: "L6", label: "1000+", min: 1000, max: Infinity },
];

export const BID_BUCKETS: RangeBand[] = [
  { key: "B1", label: "1–249 RC", min: 0, max: 249 },
  { key: "B2", label: "250–499 RC", min: 250, max: 499 },
  { key: "B3", label: "500–999 RC", min: 500, max: 999 },
  { key: "B4", label: "1000–2499 RC", min: 1000, max: 2499 },
  { key: "B5", label: "2500–4999 RC", min: 2500, max: 4999 },
  { key: "B6", label: "5000+ RC", min: 5000, max: Infinity },
];

/** Histograma de charm (medida de exibição, não dimensão de filtro). */
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

export function levelBandKey(level: number): string { return bandKeyOf(LEVEL_BANDS, Math.max(0, level)); }
export function bidBucketKey(bidRc: number): string { return bandKeyOf(BID_BUCKETS, Math.max(0, bidRc)); }
export function charmBucketKey(charm: number): string { return bandKeyOf(CHARM_BUCKETS, Math.max(0, charm)); }

export function bandLabel(bands: RangeBand[], key: string): string {
  return bands.find(band => band.key === key)?.label || key;
}

/** Dimensão SW/SG: 'a' = disponível (false), 'c' = concluída, 'u' = sem dado. */
export type QuestDimKey = "a" | "c" | "u";
export function questDimKey(value: boolean | null | undefined): QuestDimKey {
  if (value === false) return "a";
  if (value === true) return "c";
  return "u";
}

// ── Célula de métricas ──────────────────────────────────────────────────────

/**
 * Medidas agregadas de UMA célula dimensional. Chaves curtas deliberadas
 * (milhares de células por documento). Tudo soma/contagem/min/max — a
 * fusão de deltas é associativa e a agregação é idempotente porque a
 * ingestão deduplica ANTES de agregar (cada leilão entra exatamente 1 vez).
 */
export interface MetricCell {
  /** Quantidade de leilões. */
  n: number;
  /** Lance vencedor: soma / mínimo / máximo (RC). */
  bS: number; bMn: number; bMx: number;
  /** Itens: soma RC / contagem de leilões COM itens avaliados > 0. */
  iS: number; iN: number;
  /** Soma de levels. */
  lS: number;
  /** Charm points: soma / contagem com dado. */
  cS: number; cN: number;
  /** Auras: soma / contagem com dado. */
  aS: number; aN: number;
  /** Hirelings: soma / contagem com dado. */
  hS: number; hN: number;
  /** Passes Deluxe: soma / contagem com dado. */
  dS: number; dN: number;
  /** Skills: soma/contagem por skill presente. */
  sk: Partial<Record<keyof ItemsCharacterSkills & string, { s: number; n: number }>>;
  /** Histograma de charm (contagens por faixa) — exibição. */
  cb: Record<string, number>;
}

export function emptyMetricCell(): MetricCell {
  return { n: 0, bS: 0, bMn: 0, bMx: 0, iS: 0, iN: 0, lS: 0, cS: 0, cN: 0, aS: 0, aN: 0, hS: 0, hN: 0, dS: 0, dN: 0, sk: {}, cb: {} };
}

/** Chave dimensional da célula: vocação|faixaLevel|SW|SG|faixaLance. */
export function metricCellKey(entry: Pick<BazaarHistoryEntry, "vocation" | "level" | "soulwar" | "sanguine" | "bidRc">): string {
  return [
    entry.vocation || "—",
    levelBandKey(entry.level),
    questDimKey(entry.soulwar),
    questDimKey(entry.sanguine),
    bidBucketKey(entry.bidRc),
  ].join("|");
}

export interface ParsedCellKey { vocation: string; levelBand: string; sw: QuestDimKey; sg: QuestDimKey; bidBucket: string }

export function parseMetricCellKey(key: string): ParsedCellKey {
  const [vocation = "—", levelBand = "L1", sw = "u", sg = "u", bidBucket = "B1"] = key.split("|");
  return { vocation, levelBand, sw: sw as QuestDimKey, sg: sg as QuestDimKey, bidBucket };
}

/** Acumula UMA entrada na célula (mutação local do delta em construção). */
export function addEntryToCell(cell: MetricCell, entry: BazaarHistoryEntry): void {
  cell.n += 1;
  cell.bS += entry.bidRc;
  cell.bMn = cell.bMn === 0 ? entry.bidRc : Math.min(cell.bMn, entry.bidRc);
  cell.bMx = Math.max(cell.bMx, entry.bidRc);
  if (entry.itemsRc > 0) { cell.iS += entry.itemsRc; cell.iN += 1; }
  cell.lS += entry.level;
  if (typeof entry.charmPoints === "number") {
    cell.cS += entry.charmPoints;
    cell.cN += 1;
    const bucket = charmBucketKey(entry.charmPoints);
    cell.cb[bucket] = (cell.cb[bucket] || 0) + 1;
  }
  if (typeof entry.auraCount === "number") { cell.aS += entry.auraCount; cell.aN += 1; }
  if (typeof entry.hirelingCount === "number") { cell.hS += entry.hirelingCount; cell.hN += 1; }
  if (typeof entry.deluxePassCount === "number") { cell.dS += entry.deluxePassCount; cell.dN += 1; }
  if (entry.skills) {
    for (const [key, value] of Object.entries(entry.skills)) {
      if (!Number.isFinite(value)) continue;
      const bucket = cell.sk[key as keyof ItemsCharacterSkills & string] || { s: 0, n: 0 };
      bucket.s += value as number;
      bucket.n += 1;
      cell.sk[key as keyof ItemsCharacterSkills & string] = bucket;
    }
  }
}

/** Funde `delta` DENTRO de `target` (fusão associativa de células). */
export function mergeCellInto(target: MetricCell, delta: MetricCell): void {
  target.n += delta.n;
  target.bS += delta.bS;
  target.bMn = target.bMn === 0 ? delta.bMn : (delta.bMn === 0 ? target.bMn : Math.min(target.bMn, delta.bMn));
  target.bMx = Math.max(target.bMx, delta.bMx);
  target.iS += delta.iS; target.iN += delta.iN;
  target.lS += delta.lS;
  target.cS += delta.cS; target.cN += delta.cN;
  target.aS += delta.aS; target.aN += delta.aN;
  target.hS += delta.hS; target.hN += delta.hN;
  target.dS += delta.dS; target.dN += delta.dN;
  for (const [key, bucket] of Object.entries(delta.sk)) {
    const existing = target.sk[key as keyof ItemsCharacterSkills & string] || { s: 0, n: 0 };
    existing.s += bucket?.s || 0;
    existing.n += bucket?.n || 0;
    target.sk[key as keyof ItemsCharacterSkills & string] = existing;
  }
  for (const [key, count] of Object.entries(delta.cb)) {
    target.cb[key] = (target.cb[key] || 0) + count;
  }
}

// ── Deltas de ingestão (agrupados por documento mês+servidor) ───────────────

/** Id do documento de métricas de um mês+servidor. */
export function metricsDocId(ym: string, server: string): string {
  return `${ym}__${String(server || "—").replace(/[\/\s]+/g, "_")}`;
}

export interface MetricsDelta {
  ym: string;
  server: string;
  docId: string;
  cells: Record<string, MetricCell>;
  count: number;
}

/** Agrega as entradas NOVAS em deltas por documento (mês × servidor). */
export function buildMetricsDeltas(entries: BazaarHistoryEntry[]): MetricsDelta[] {
  const byDoc = new Map<string, MetricsDelta>();
  for (const entry of entries) {
    if (!entry.endTs) continue;
    const ym = monthKeyFromTs(entry.endTs);
    const docId = metricsDocId(ym, entry.server);
    let delta = byDoc.get(docId);
    if (!delta) {
      delta = { ym, server: entry.server, docId, cells: {}, count: 0 };
      byDoc.set(docId, delta);
    }
    const key = metricCellKey(entry);
    if (!delta.cells[key]) delta.cells[key] = emptyMetricCell();
    addEntryToCell(delta.cells[key], entry);
    delta.count += 1;
  }
  return Array.from(byDoc.values());
}

// ── Filtros da tela (100% resolvidos nas células, sem base bruta) ──────────

export type HistoryQuestFilter = "any" | "available" | "completed";

export interface HistoryMetricsFilters {
  /** Meses 'YYYY-MM' selecionados; vazio = todos os disponíveis. */
  months: string[];
  servers: string[];
  vocations: string[];
  levelBands: string[];
  bidBuckets: string[];
  soulwar: HistoryQuestFilter;
  sanguine: HistoryQuestFilter;
}

export function defaultHistoryFilters(): HistoryMetricsFilters {
  return { months: [], servers: [], vocations: [], levelBands: [], bidBuckets: [], soulwar: "any", sanguine: "any" };
}

export function hasActiveHistoryFilters(filters: HistoryMetricsFilters): boolean {
  return JSON.stringify(filters) !== JSON.stringify(defaultHistoryFilters());
}

function matchQuestDim(dim: QuestDimKey, filter: HistoryQuestFilter): boolean {
  if (filter === "any") return true;
  if (filter === "available") return dim === "a";
  return dim === "c";
}

// ── Estatísticas calculadas a partir das células filtradas ─────────────────

export interface MetricsDocData {
  ym: string;
  server: string;
  cells: Record<string, MetricCell>;
}

export interface BazaarHistoryStats {
  count: number;
  avgWinningBidRc: number;
  minWinningBidRc: number;
  maxWinningBidRc: number;
  avgItemsRc: number;
  withItemsCount: number;
  avgLevel: number;
  avgCharmPoints: number;
  charmSampleCount: number;
  avgAuras: number;
  auraSampleCount: number;
  avgHirelings: number;
  hirelingSampleCount: number;
  avgDeluxePasses: number;
  deluxeSampleCount: number;
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
 * Consolida TODAS as estatísticas do conjunto de documentos de métricas,
 * aplicando os filtros dimensionais. Nenhuma leitura além dos docs já em
 * memória; nenhuma entrada bruta é percorrida.
 */
export function computeStatsFromMetricDocs(docs: MetricsDocData[], filters: HistoryMetricsFilters): BazaarHistoryStats {
  const total = emptyMetricCell();
  const byVocation = new Map<string, number>();
  const byServer = new Map<string, number>();
  const byMonth = new Map<string, { count: number; bidSum: number }>();
  const sw = { available: 0, completed: 0, unknown: 0 };
  const sg = { available: 0, completed: 0, unknown: 0 };
  const bidDist = new Map<string, number>();
  const skillsByVoc = new Map<string, { count: number; sk: Record<string, { s: number; n: number }> }>();

  for (const docData of docs) {
    if (filters.months.length > 0 && !filters.months.includes(docData.ym)) continue;
    if (filters.servers.length > 0 && !filters.servers.includes(docData.server)) continue;
    for (const [key, cell] of Object.entries(docData.cells || {})) {
      const dims = parseMetricCellKey(key);
      if (filters.vocations.length > 0 && !filters.vocations.includes(dims.vocation)) continue;
      if (filters.levelBands.length > 0 && !filters.levelBands.includes(dims.levelBand)) continue;
      if (filters.bidBuckets.length > 0 && !filters.bidBuckets.includes(dims.bidBucket)) continue;
      if (!matchQuestDim(dims.sw, filters.soulwar)) continue;
      if (!matchQuestDim(dims.sg, filters.sanguine)) continue;

      mergeCellInto(total, cell);
      byVocation.set(dims.vocation, (byVocation.get(dims.vocation) || 0) + cell.n);
      byServer.set(docData.server, (byServer.get(docData.server) || 0) + cell.n);
      const month = byMonth.get(docData.ym) || { count: 0, bidSum: 0 };
      month.count += cell.n;
      month.bidSum += cell.bS;
      byMonth.set(docData.ym, month);
      if (dims.sw === "a") sw.available += cell.n; else if (dims.sw === "c") sw.completed += cell.n; else sw.unknown += cell.n;
      if (dims.sg === "a") sg.available += cell.n; else if (dims.sg === "c") sg.completed += cell.n; else sg.unknown += cell.n;
      bidDist.set(dims.bidBucket, (bidDist.get(dims.bidBucket) || 0) + cell.n);

      const vocSkills = skillsByVoc.get(dims.vocation) || { count: 0, sk: {} };
      vocSkills.count += cell.n;
      for (const [skillKey, bucket] of Object.entries(cell.sk || {})) {
        const existing = vocSkills.sk[skillKey] || { s: 0, n: 0 };
        existing.s += bucket?.s || 0;
        existing.n += bucket?.n || 0;
        vocSkills.sk[skillKey] = existing;
      }
      skillsByVoc.set(dims.vocation, vocSkills);
    }
  }

  const sortedDist = (map: Map<string, number>) => Array.from(map.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "pt-BR"));

  return {
    count: total.n,
    avgWinningBidRc: total.n > 0 ? Math.round(total.bS / total.n) : 0,
    minWinningBidRc: total.bMn,
    maxWinningBidRc: total.bMx,
    avgItemsRc: total.iN > 0 ? Math.round(total.iS / total.iN) : 0,
    withItemsCount: total.iN,
    avgLevel: total.n > 0 ? Math.round(total.lS / total.n) : 0,
    avgCharmPoints: total.cN > 0 ? Math.round(total.cS / total.cN) : 0,
    charmSampleCount: total.cN,
    avgAuras: total.aN > 0 ? round1(total.aS / total.aN) : 0,
    auraSampleCount: total.aN,
    avgHirelings: total.hN > 0 ? round1(total.hS / total.hN) : 0,
    hirelingSampleCount: total.hN,
    avgDeluxePasses: total.dN > 0 ? round1(total.dS / total.dN) : 0,
    deluxeSampleCount: total.dN,
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
      .map(bucket => ({ label: bucket.label, count: total.cb[bucket.key] || 0 }))
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
