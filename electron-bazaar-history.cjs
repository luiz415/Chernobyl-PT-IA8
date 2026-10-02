// ============================================================================
// BAZAAR — CONSULTA DO HISTÓRICO OFICIAL (canal `rubinot-bazaar-history-v1`)
// ----------------------------------------------------------------------------
// Módulo ADITIVO e ISOLADO da tela "Estatísticas do Bazaar". Segue o desenho
// dos módulos irmãos (`electron-bazaar-new.cjs` e `electron-bazaar-items.cjs`):
// NÃO importa `electron-main.cjs` — recebe tudo por injeção; usa a MESMA
// sessão/cookies/fila global; é 100% API JSON (nenhuma página individual de
// personagem é renderizada e NÃO existe fallback de scraping).
//
// ── PÁGINA E ROTA DO HISTÓRICO ──────────────────────────────────────────────
// A página correta do histórico é `https://rubinot.com.br/bazaar/history`
// (SPA que lista os leilões ENCERRADOS dos últimos ~30 dias). Este módulo:
//
//   1. valida a sessão (mesmo mecanismo das demais consultas);
//   2. NAVEGA a página de sessão para `/bazaar/history` — nunca `/bazaar`
//      (a rota de leilões atuais NÃO serve para o histórico);
//   3. DESCOBRE a rota JSON real FAREJANDO as respostas de rede que a
//      própria SPA dispara ao carregar o histórico (Playwright
//      `page.on('response')`): a primeira resposta JSON de `/api/` cujo
//      conteúdo é uma lista de leilões majoritariamente JÁ ENCERRADOS é a
//      rota verdadeira — nada de formato assumido;
//   4. se o farejamento não capturar nada (ex.: resposta servida de cache),
//      sonda candidatas derivadas da rota real de listagem, agora COM o
//      contexto/Referer corretos de `/bazaar/history`;
//   5. pagina a listagem por COMPLETO dentro da janela pedida (até 30 dias),
//      usando a DATA DE TÉRMINO de cada leilão como critério central de
//      parada — nunca apenas a primeira página.
//
// ── CONSULTA INCREMENTAL ────────────────────────────────────────────────────
// O renderer envia `sinceEndTs` (última data de término já processada) e
// `knownIds` (ids já processados perto dessa fronteira). A listagem para de
// paginar assim que TODOS os leilões da página são mais antigos que o piso
// (`floorTs = max(agora-30d, sinceEndTs - margem)`), e leilões já conhecidos
// são pulados SEM nova consulta individual. A primeira carga (sem estado)
// percorre os 30 dias completos — demorada por natureza; NENHUM teto
// artificial pequeno é aplicado (apenas salva-vidas generosos contra loop).
//
// ── FILTRO OBRIGATÓRIO (Status Finalizado + Lance Vencedor) ────────────────
//   • FINALIZADO: campo textual de status quando existir (Cancelled /
//     Currently Processed descartados); sem campo, exige término no passado
//     e ausência de flag de cancelamento;
//   • LANCE VENCEDOR: `currentValue > 0` (mesma semântica da API real da
//     listagem: com 0 o site exibe o "Lance Mínimo" — ninguém deu lance).
//     Sem prova de lance o leilão é DESCARTADO, nunca incluído.
// ============================================================================

'use strict';

// Reuso explícito dos módulos irmãos — funções PURAS já validadas:
//   • walkJson / deriveQuestsFromApiPayload (método novo das quests);
//   • collectItemMatches / collectGoldAndSkills / buildAuctionApiUrl /
//     normalizeItemName (consulta de itens — regras de skills idênticas).
const { walkJson, deriveQuestsFromApiPayload } = require('./electron-bazaar-new.cjs');
const {
  collectItemMatches,
  collectGoldAndSkills,
  buildAuctionApiUrl,
  normalizeItemName,
} = require('./electron-bazaar-items.cjs');

// ============================================================================
// FUNÇÕES PURAS — extração, classificação e utilitários de URL (testáveis)
// ============================================================================

/** Janela do site: ~30 dias de histórico. */
const HISTORY_WINDOW_SECONDS = 30 * 24 * 3600;
/** Margem de segurança da consulta incremental (reprocessa a fronteira). */
const HISTORY_INCREMENTAL_MARGIN_SECONDS = 6 * 3600;

/** Origem do site a partir da base da API (`https://rubinot.com.br`). */
function siteOriginFromApiBase(apiBase) {
  try {
    return new URL(String(apiBase || '')).origin;
  } catch {
    return 'https://rubinot.com.br';
  }
}

/** URL correta da PÁGINA do histórico — nunca `/bazaar`. */
function historyPageUrlFromApiBase(apiBase) {
  return `${siteOriginFromApiBase(apiBase)}/bazaar/history`;
}

/** Extrai o array de leilões do payload de UMA página da listagem. */
function extractHistoryAuctions(payload) {
  if (Array.isArray(payload?.auctions)) return payload.auctions;
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    for (const value of Object.values(payload)) {
      if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object' && value[0] !== null
        && ('id' in value[0]) && (('name' in value[0]) || ('level' in value[0]))) {
        return value;
      }
    }
  }
  return null;
}

/** Total de páginas informado pela API (0 = desconhecido). */
function extractHistoryTotalPages(payload) {
  const candidates = [payload?.totalPages, payload?.total_pages, payload?.pages, payload?.pageCount];
  for (const value of candidates) {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) return Math.floor(num);
  }
  return 0;
}

/** Timestamp de encerramento em SEGUNDOS (aceita s ou ms; 0 = ausente). */
function normalizeEndTs(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return num > 1e11 ? Math.floor(num / 1000) : Math.floor(num);
}

/** endTs de um leilão bruto (cobre as variações de nome do campo). */
function auctionEndTsOf(auction) {
  return normalizeEndTs(auction?.auctionEnd ?? auction?.auctionEndTs ?? auction?.auction_end);
}

/**
 * Um payload JSON "parece" a listagem do HISTÓRICO? Validação SEMÂNTICA:
 * precisa conter uma lista de leilões cuja MAIORIA já encerrou — a listagem
 * de leilões ATUAIS (majoritariamente futuros) nunca passa por histórico.
 */
function looksLikeHistoryListingJson(payload, nowSec) {
  const auctions = extractHistoryAuctions(payload);
  if (!auctions || auctions.length === 0) return { ok: false, auctions: null, endedCount: 0 };
  const endedCount = auctions.filter(a => {
    const endTs = auctionEndTsOf(a);
    return endTs > 0 && endTs <= nowSec;
  }).length;
  return { ok: endedCount * 2 >= auctions.length, auctions, endedCount };
}

/** Substitui/insere o parâmetro `page` numa URL de listagem. */
function withPageParam(urlString, pageNum) {
  try {
    const url = new URL(urlString);
    url.searchParams.set('page', String(pageNum));
    return url.toString();
  } catch {
    return urlString;
  }
}

/** Ajusta um parâmetro APENAS se ele já existir na URL (não inventa API). */
function withParamIfPresent(urlString, name, value) {
  try {
    const url = new URL(urlString);
    if (!url.searchParams.has(name)) return urlString;
    url.searchParams.set(name, String(value));
    return url.toString();
  } catch {
    return urlString;
  }
}

/**
 * Ordenação da listagem pela data de término: 'desc' (mais novo primeiro),
 * 'asc' ou 'unknown'. Auditada EM TEMPO DE EXECUÇÃO na primeira página —
 * a estratégia de parada da paginação depende dela.
 */
function detectEndOrdering(auctions) {
  const stamps = (Array.isArray(auctions) ? auctions : [])
    .map(a => auctionEndTsOf(a))
    .filter(ts => ts > 0);
  if (stamps.length < 2) return 'unknown';
  let descVotes = 0;
  let ascVotes = 0;
  for (let i = 1; i < stamps.length; i++) {
    if (stamps[i] < stamps[i - 1]) descVotes += 1;
    else if (stamps[i] > stamps[i - 1]) ascVotes += 1;
  }
  if (descVotes > ascVotes * 3) return 'desc';
  if (ascVotes > descVotes * 3) return 'asc';
  return 'unknown';
}

/** Campos textuais candidatos a STATUS do leilão no histórico. */
const STATUS_FIELDS = ['status', 'state', 'auctionStatus', 'auction_status'];
const FINISHED_PATTERN = /^(finished|finalizado|finalizada|ended|encerrado|completed|complete)$/i;
const CANCELLED_PATTERN = /cancel/i;
const IN_PROGRESS_PATTERN = /(process|progress|andamento|current|active|ativo)/i;

/**
 * Classifica UM leilão do histórico:
 *   { finished, cancelled, hasWinningBid, winningBid, statusText }
 * Regras defensivas documentadas no cabeçalho do arquivo.
 */
function classifyHistoryAuction(auction, nowSec) {
  const now = Number.isFinite(nowSec) ? nowSec : Math.floor(Date.now() / 1000);
  let statusText = '';
  for (const field of STATUS_FIELDS) {
    const value = auction?.[field];
    if (typeof value === 'string' && value.trim()) { statusText = value.trim(); break; }
  }

  let finished = false;
  let cancelled = false;
  if (statusText) {
    cancelled = CANCELLED_PATTERN.test(statusText);
    finished = !cancelled && !IN_PROGRESS_PATTERN.test(statusText) && FINISHED_PATTERN.test(statusText);
  } else {
    cancelled = auction?.cancelled === true || auction?.canceled === true;
    const endTs = auctionEndTsOf(auction);
    finished = !cancelled && endTs > 0 && endTs <= now;
  }

  const winningBid = Number(
    auction?.currentValue ?? auction?.currentBid ?? auction?.current_bid ?? auction?.winningBid ?? auction?.winning_bid ?? 0,
  );
  const hasWinningBid = Number.isFinite(winningBid) && winningBid > 0;

  return { finished, cancelled, hasWinningBid, winningBid: hasWinningBid ? Math.floor(winningBid) : 0, statusText };
}

/** Filtro obrigatório da consulta: Finalizado + Lance Vencedor. */
function isApprovedHistoryAuction(auction, nowSec) {
  const info = classifyHistoryAuction(auction, nowSec);
  return info.finished && info.hasWinningBid;
}

/** Normaliza o leilão do histórico para o shape consumido pelo renderer. */
function normalizeHistoryAuction(auction, nowSec) {
  const info = classifyHistoryAuction(auction, nowSec);
  return {
    id: String(auction?.id || ''),
    name: String(auction?.name || ''),
    vocation: String(auction?.vocationName || auction?.vocation || ''),
    level: Number(auction?.level || 0) || 0,
    server: String(auction?.worldName || auction?.world || ''),
    winningBid: info.winningBid,
    auctionEndTs: auctionEndTsOf(auction) || null,
    statusText: info.statusText,
  };
}

/**
 * Seleção INCREMENTAL de uma página da listagem: devolve os leilões NOVOS
 * aprovados (Finalizado + Lance Vencedor, dentro da janela, não conhecidos e
 * não repetidos na execução) e contadores para o diagnóstico.
 */
function selectNewApprovedFromPage(auctions, { floorTs, nowSec, knownIds, seenIds }) {
  const approved = [];
  let knownSkipped = 0;
  let belowFloor = 0;
  let minEndTs = 0;
  for (const raw of Array.isArray(auctions) ? auctions : []) {
    const id = String(raw?.id || '');
    const endTs = auctionEndTsOf(raw);
    if (endTs > 0 && (minEndTs === 0 || endTs < minEndTs)) minEndTs = endTs;
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    if (endTs > 0 && endTs < floorTs) { belowFloor += 1; continue; }
    if (knownIds.has(id)) { knownSkipped += 1; continue; }
    if (!isApprovedHistoryAuction(raw, nowSec)) continue;
    approved.push(normalizeHistoryAuction(raw, nowSec));
  }
  return { approved, knownSkipped, belowFloor, minEndTs };
}

// ============================================================================
// EXTRATORES ADITIVOS DO PAYLOAD INDIVIDUAL (`/api/bazaar/{ID}`)
// ----------------------------------------------------------------------------
// Mesma postura defensiva de collectGoldAndSkills: o schema exato não é
// assumido; a varredura reconhece formatos plausíveis por CHAVE e por PAR
// rótulo/valor, e os caminhos encontrados vão para o diagnóstico (`paths`).
// Dado ausente = null — nunca zero inventado.
// ============================================================================

const CHARM_KEY_HINTS = /^(totalCharmPoints|total_charm_points|charmPoints|charm_points|charmsPoints|totalCharms)$/i;
const CHARM_LABEL_HINTS = /^total\s*charm\s*points$/i;
const AURA_PATH_HINTS = /aura/i;
const HIRELING_PATH_HINTS = /hireling/i;
const BATTLEPASS_PATH_HINTS = /(battlepass|battle_pass|passes|\bpass\b)/i;
const DELUXE_KEY_HINTS = /deluxe/i;

/**
 * Valor "afirmativo" da coluna Deluxe: true, 1, "sim", "yes", "true", "1".
 * Robusto a maiúsculas/minúsculas, espaços e acento ("Sim ", "SIM").
 */
function isAffirmative(value) {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') return /^(sim|yes|true|1)$/i.test(value.trim());
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    // Alguns payloads embrulham o valor: { value: "sim" } / { text: "yes" }.
    return isAffirmative(value.value ?? value.text ?? value.label);
  }
  return false;
}

/**
 * Valor "negativo" explícito da coluna Deluxe: false, 0, "não", "nao",
 * "no", "false", "0". Células vazias/desconhecidas NÃO são negativas nem
 * afirmativas — simplesmente não contam (mas provam que a coluna existe).
 */
function isNegative(value) {
  if (value === false || value === 0) return true;
  if (typeof value === 'string') return /^(n[aã]o|no|false|0)$/i.test(value.trim());
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return isNegative(value.value ?? value.text ?? value.label);
  }
  return false;
}

/**
 * PASSES DELUXE — conta quantas TEMPORADAS do Battlepass têm Deluxe = "sim".
 *
 * A seção "Battlepass" do personagem é uma tabela (Temporada / Deluxe /
 * Pontos / Pontos da Loja / Resgatado) e o JSON real pode representá-la de
 * formas diferentes. A varredura cobre, NESTA ordem de prioridade:
 *
 *   1. CONTAGEM DIRETA na raiz (`deluxeCount`, `totalDeluxe`, ...);
 *   2. OBJETOS DE TEMPORADA: qualquer objeto com uma chave ~/deluxe/i em
 *      QUALQUER caminho do payload (não só caminhos nomeados "battlepass" —
 *      era essa exigência de caminho que fazia o dado não ser encontrado).
 *      Conta 1 por objeto com valor afirmativo; valores negativos/vazios
 *      não contam, mas PROVAM que a coluna Deluxe existe (resultado 0, e
 *      não null = desconhecido);
 *   3. TABELA COM CABEÇALHO: objeto com `headers`/`columns` contendo um
 *      rótulo ~/deluxe/i e linhas em `rows`/`data` — conta as linhas cuja
 *      célula NA COLUNA DELUXE é afirmativa (nunca confunde com Pontos/
 *      Pontos da Loja/Resgatado, porque usa o índice exato da coluna).
 *
 * Retorno: { count, found, path } — `found=false` (count=null) somente
 * quando NENHUMA estrutura com Deluxe foi vista no payload.
 */
function collectBattlepassDeluxe(payload) {
  // 1) Contagem direta na raiz.
  const direct = readDirectCount(payload, /^(deluxeCount|deluxe_count|totalDeluxe|total_deluxe|deluxePasses|deluxe_passes)$/i);
  if (direct !== null) return { count: direct, found: true, path: '(raiz)' };

  let count = 0;
  let found = false;
  let where = '';

  walkJson(payload, (node, path) => {
    if (!node || typeof node !== 'object') return;

    if (!Array.isArray(node)) {
      // 2) Objeto de temporada com chave "deluxe".
      for (const [key, value] of Object.entries(node)) {
        if (!DELUXE_KEY_HINTS.test(key)) continue;
        // Chaves agregadas tipo deluxePoints/deluxeReward não são a coluna
        // sim/não — só contam valores claramente afirmativos/negativos.
        if (isAffirmative(value)) {
          count += 1; found = true; if (!where) where = `${path}.${key}`;
          break;
        }
        if (isNegative(value) || value === '' || value === null) {
          found = true; if (!where) where = `${path}.${key}`;
          break;
        }
      }

      // 3) Tabela com cabeçalho + linhas (headers/columns × rows/data).
      const headers = Array.isArray(node.headers) ? node.headers
        : Array.isArray(node.columns) ? node.columns : null;
      const rows = Array.isArray(node.rows) ? node.rows
        : Array.isArray(node.data) ? node.data : null;
      if (headers && rows) {
        const headerText = (header) => {
          if (typeof header === 'string') return header;
          if (header && typeof header === 'object') return String(header.label ?? header.name ?? header.title ?? '');
          return '';
        };
        const deluxeIndex = headers.findIndex(header => DELUXE_KEY_HINTS.test(headerText(header)));
        if (deluxeIndex >= 0) {
          found = true;
          if (!where) where = `${path}.headers[${deluxeIndex}]`;
          for (const row of rows) {
            // Só linhas POSICIONAIS (arrays): linhas-objeto com chave
            // "Deluxe" já são contadas pelo caso 2 (sem dupla contagem).
            if (!Array.isArray(row)) continue;
            if (isAffirmative(row[deluxeIndex])) count += 1;
          }
        }
      }
    }
  });

  return found ? { count, found: true, path: where } : { count: null, found: false, path: '' };
}

/** Chaves de contagem direta (ex.: `auraCount`, `hirelings: 3`). */
function readDirectCount(node, keyPattern) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
  for (const [key, value] of Object.entries(node)) {
    if (!keyPattern.test(key)) continue;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value);
    if (Array.isArray(value)) return value.length;
  }
  return null;
}

/**
 * Charm Points + Auras + Hirelings + Passes Deluxe do MESMO payload já
 * baixado — nenhuma chamada extra ao site.
 */
function collectHistoryExtras(payload) {
  let charmPoints = null;
  let auraCount = null;
  let hirelingCount = null;
  const paths = { charm: '', auras: '', hirelings: '', deluxe: '' };

  // Passes Deluxe — varredura dedicada (ver collectBattlepassDeluxe):
  // conta temporadas com Deluxe = "sim"; "não"/vazio não contam, mas
  // produzem 0 (coluna encontrada) em vez de null (desconhecido).
  const deluxe = collectBattlepassDeluxe(payload);
  const deluxePassCount = deluxe.found ? deluxe.count : null;
  paths.deluxe = deluxe.path;

  const rootAuras = readDirectCount(payload, /^(auraCount|aura_count|auras|totalAuras|total_auras)$/i);
  if (rootAuras !== null) { auraCount = rootAuras; paths.auras = '(raiz)'; }
  const rootHirelings = readDirectCount(payload, /^(hirelingCount|hireling_count|hirelings|totalHirelings|total_hirelings)$/i);
  if (rootHirelings !== null) { hirelingCount = rootHirelings; paths.hirelings = '(raiz)'; }

  walkJson(payload, (node, path) => {
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      if (charmPoints === null) {
        for (const [key, value] of Object.entries(node)) {
          const num = Number(value);
          if (CHARM_KEY_HINTS.test(key) && Number.isFinite(num) && num >= 0) {
            charmPoints = Math.floor(num);
            paths.charm = `${path}.${key}`;
            break;
          }
        }
      }
      if (charmPoints === null) {
        const label = typeof node.name === 'string' ? node.name : (typeof node.label === 'string' ? node.label : '');
        if (label && CHARM_LABEL_HINTS.test(label.trim())) {
          const num = Number(node.value ?? node.amount ?? node.total);
          if (Number.isFinite(num) && num >= 0) { charmPoints = Math.floor(num); paths.charm = path; }
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      if (auraCount === null && AURA_PATH_HINTS.test(path) && !BATTLEPASS_PATH_HINTS.test(path)) {
        auraCount = node.length;
        paths.auras = path;
      }
      if (hirelingCount === null && HIRELING_PATH_HINTS.test(path)) {
        hirelingCount = node.length;
        paths.hirelings = path;
      }
    }
  });

  return { charmPoints, auraCount, hirelingCount, deluxePassCount, paths };
}

// ============================================================================
// REGISTRO
// ============================================================================
function registerBazaarHistoryMethod(deps) {
  const {
    ipcMain,
    diag,
    runQueued,
    getContext,
    ensureSessionReady,
    getSessionPage,
    fetchJsonDetailed,
    resolveBrowserKey,
    isManualStopRequested,
    resetManualStop,
    sendProgress,
    buildProgress,
    finishProgress,
    getSelectedBrowser,
    getUseCleanProfile,
    apiBase,
  } = deps || {};

  if (!ipcMain) throw new Error('registerBazaarHistoryMethod: ipcMain é obrigatório.');

  // Mesmo ritmo adaptativo validado nos módulos irmãos.
  const API_GAP_BASE_MS = 350;
  const API_GAP_MAX_EXTRA_MS = 2000;
  const API_GAP_STEP_MS = 250;
  const API_SPEEDUP_STREAK = 8;
  const API_MAX_ATTEMPTS = 3;
  const API_BACKOFF_MS = 1200;
  // SALVA-VIDAS generosos (o volume real esperado é ~10 mil/mês; estes tetos
  // NÃO limitam a carga normal — só evitam loop infinito em falha do site).
  const LIST_PAGES_SAFETY_CAP = 1000;
  const DETAILS_SAFETY_CAP = 25000;
  /** Tempo máximo aguardando a SPA do histórico disparar sua chamada JSON. */
  const SNIFF_TIMEOUT_MS = 20000;

  let apiGapExtraMs = 0;
  let apiSuccessStreak = 0;
  const currentGapMs = () => API_GAP_BASE_MS + apiGapExtraMs;
  const registerRateLimited = () => {
    apiSuccessStreak = 0;
    apiGapExtraMs = Math.min(API_GAP_MAX_EXTRA_MS, apiGapExtraMs + API_GAP_STEP_MS);
  };
  const registerApiSuccess = () => {
    apiSuccessStreak += 1;
    if (apiSuccessStreak >= API_SPEEDUP_STREAK && apiGapExtraMs > 0) {
      apiSuccessStreak = 0;
      apiGapExtraMs = Math.max(0, apiGapExtraMs - API_GAP_STEP_MS);
    }
  };

  const base = String(apiBase || '').replace(/\/+$/, '');
  const historyPageUrl = historyPageUrlFromApiBase(base);
  const bazaarPageUrl = `${siteOriginFromApiBase(base)}/bazaar`;

  /** Candidatas de rota da listagem — usadas SÓ se o farejamento falhar. */
  function historyListUrlCandidates() {
    const params = new URLSearchParams({ sortBy: 'auction_end', sortOrder: 'desc', limit: 100, page: 1 });
    return [
      `${base}/history?${params.toString()}`,
      `${base}/history?${params.toString()}&status=all`,
      `${base}?${params.toString()}&history=true`,
      `${base}?${params.toString()}&state=history`,
    ];
  }

  /** Fetch JSON com tratamento de 429 — mesmo contrato dos módulos irmãos. */
  async function fetchJsonWithRetry(page, url, scopeLabel) {
    let lastStatus = 0;
    for (let attempt = 1; attempt <= API_MAX_ATTEMPTS; attempt++) {
      if (isManualStopRequested()) return { ok: false, reason: 'ENCERRAMENTO_MANUAL', status: lastStatus };
      let response = null;
      try {
        response = await fetchJsonDetailed(page, url);
      } catch (error) {
        return { ok: false, reason: 'ERRO_DE_REDE', status: 0, error: String(error?.message || error) };
      }
      lastStatus = Number(response?.status || 0);
      if (lastStatus === 429) {
        registerRateLimited();
        if (attempt < API_MAX_ATTEMPTS) {
          const retryAfterSec = Number(response?.retryAfter || 0);
          const backoff = retryAfterSec > 0 ? Math.min(retryAfterSec * 1000, 15000) : API_BACKOFF_MS * attempt;
          diag('history-v1', 'Limite de taxa (429); aguardando antes de repetir a mesma chamada.', {
            escopo: scopeLabel, tentativa: `${attempt}/${API_MAX_ATTEMPTS}`, esperaMs: backoff,
          });
          await page.waitForTimeout(backoff);
          continue;
        }
        return { ok: false, reason: 'LIMITE_DE_TAXA_429', status: lastStatus };
      }
      if (!response?.ok || !response?.isJson || !response?.data) {
        return {
          ok: false,
          reason: lastStatus === 404 ? 'ROTA_INEXISTENTE'
            : lastStatus === 403 ? 'ACESSO_NEGADO'
              : lastStatus === 401 ? 'NAO_AUTENTICADO'
                : lastStatus >= 500 ? 'ERRO_DO_SERVIDOR'
                  : 'RESPOSTA_NAO_JSON',
          status: lastStatus,
        };
      }
      registerApiSuccess();
      return { ok: true, status: lastStatus, data: response.data };
    }
    return { ok: false, reason: 'LIMITE_DE_TAXA_429', status: lastStatus };
  }

  /**
   * FASE DE DESCOBERTA: navega para a PÁGINA CORRETA do histórico
   * (`/bazaar/history`) farejando as respostas de rede da própria SPA.
   * Devolve `{ urlTemplate, firstPage }` ou null.
   */
  async function discoverHistoryRoute(page, nowSec) {
    const sniffed = [];
    const onResponse = (response) => {
      // Handler assíncrono deliberadamente NÃO aguardado: Playwright emite o
      // evento em paralelo; os resultados entram em `sniffed` quando prontos.
      (async () => {
        try {
          const url = response.url();
          if (!/\/api\//i.test(url)) return;
          const contentType = String((response.headers() || {})['content-type'] || '');
          if (!contentType.includes('json')) return;
          const data = await response.json().catch(() => null);
          if (!data) return;
          const check = looksLikeHistoryListingJson(data, nowSec);
          if (check.ok) sniffed.push({ url, data, total: check.auctions.length, endedCount: check.endedCount });
        } catch { /* resposta descartável (abortada/binária) */ }
      })();
    };

    page.on('response', onResponse);
    try {
      diag('history-v1', 'Navegando a página de sessão para o HISTÓRICO (rota correta).', { url: historyPageUrl });
      // Recarrega mesmo se já estiver na URL: força a SPA a refazer a chamada.
      await page.goto(historyPageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(error => {
        diag('history-v1', 'Falha tolerada na navegação para /bazaar/history.', { error: String(error?.message || error) });
      });
      const sniffStartedAt = Date.now();
      while (sniffed.length === 0 && Date.now() - sniffStartedAt < SNIFF_TIMEOUT_MS) {
        if (isManualStopRequested()) break;
        await page.waitForTimeout(250);
      }
    } finally {
      try { page.off('response', onResponse); } catch { /* página fechada */ }
    }

    if (sniffed.length > 0) {
      // Preferência: resposta cuja URL tem paginação explícita (page=...).
      const withPage = sniffed.find(item => /[?&]page=/i.test(item.url)) || sniffed[0];
      diag('history-v1', 'Rota JSON do histórico DESCOBERTA pela própria SPA.', {
        url: withPage.url, leiloes: withPage.total, encerrados: withPage.endedCount,
      });
      return { urlTemplate: withPage.url, firstPage: withPage.data, discoveredBy: 'sniff' };
    }

    // Fallback: sondagem de candidatas — agora emitida DA PÁGINA CORRETA
    // (Referer/contexto de /bazaar/history), o que corrige a sondagem cega
    // anterior feita do contexto de /bazaar.
    diag('history-v1', 'SPA não expôs a chamada JSON no tempo limite; sondando candidatas a partir de /bazaar/history.');
    for (const url of historyListUrlCandidates()) {
      const result = await fetchJsonWithRetry(page, url, 'sonda-historico');
      if (!result.ok) {
        diag('history-v1', 'Candidata rejeitada (resposta inválida).', { url, motivo: result.reason, status: result.status });
        continue;
      }
      const check = looksLikeHistoryListingJson(result.data, nowSec);
      if (!check.ok) {
        diag('history-v1', 'Candidata rejeitada (não é lista de leilões encerrados).', { url });
        continue;
      }
      diag('history-v1', 'Rota do histórico confirmada por sondagem.', { url, leiloes: check.auctions.length });
      return { urlTemplate: url, firstPage: result.data, discoveredBy: 'probe' };
    }
    return null;
  }

  // ==========================================================================
  // HANDLER — histórico por API JSON, paginação completa e incremental
  // ==========================================================================
  ipcMain.handle('rubinot-bazaar-history-v1', async (event, options = {}) => {
    const watchSet = new Set(
      (Array.isArray(options?.watchKeys) ? options.watchKeys : [])
        .map(key => normalizeItemName(key))
        .filter(Boolean),
    );
    const sinceEndTs = Math.max(0, Math.floor(Number(options?.sinceEndTs) || 0));
    const knownIds = new Set(
      (Array.isArray(options?.knownIds) ? options.knownIds : []).map(id => String(id || '')).filter(Boolean),
    );
    const fullReload = options?.fullReload === true;

    return runQueued('bazaar-history-v1', async () => {
      const startedAt = Date.now();
      const nowSec = Math.floor(startedAt / 1000);
      // Piso da janela: 30 dias; incremental encurta para a fronteira já
      // processada (com margem de reprocessamento coberta pelos knownIds).
      const windowFloor = nowSec - HISTORY_WINDOW_SECONDS;
      const floorTs = (!fullReload && sinceEndTs > 0)
        ? Math.max(windowFloor, sinceEndTs - HISTORY_INCREMENTAL_MARGIN_SECONDS)
        : windowFloor;

      // Navegador ESCOLHIDO NO MODAL (BazaarBrowserModal) — enviado pelo
      // renderer; o global só cobre chamadas legadas sem a opção.
      const browserKey = resolveBrowserKey(options?.browser || (getSelectedBrowser ? getSelectedBrowser() : ''));
      const cleanProfile = options?.cleanProfile === true || !!(getUseCleanProfile && getUseCleanProfile() && options?.cleanProfile !== false);

      // Consulta iniciada AGORA: um "Parar" de execução anterior não pode
      // encerrar esta (as demais consultas resetam no rubinot-bazaar-fetch;
      // o histórico não passa por aquele canal).
      if (typeof resetManualStop === 'function') resetManualStop();

      diag('history-v1', 'HISTÓRICO: iniciando consulta por API JSON.', {
        paginaCorreta: historyPageUrl,
        incremental: !fullReload && sinceEndTs > 0,
        sinceEndTs,
        floorTs,
        idsConhecidos: knownIds.size,
        itensMonitorados: watchSet.size,
        navegador: browserKey,
      });

      let page = null;
      try {
        const context = await getContext(browserKey, cleanProfile);
        const session = await ensureSessionReady(context, null, 'history-v1-session');
        if (!session.ok) {
          return {
            ok: false,
            error: session.message || 'Sessão Rubinot indisponível para a consulta do histórico.',
            needsHumanVerification: !!session.needsHumanVerification,
          };
        }
        page = session.page || await getSessionPage(context);
      } catch (error) {
        return { ok: false, error: String(error?.message || error) };
      }

      let stoppedManually = false;
      const failureReasons = {};

      try {
        sendProgress(event.sender, buildProgress('bazaar', 'Histórico: localizando a rota JSON...', 0, 0, {
          methodLabel: 'Histórico (API JSON)', scope: 'history',
        }));

        // ── FASE 1: página correta + descoberta da rota ────────────────────
        const discovery = await discoverHistoryRoute(page, nowSec);
        if (!discovery) {
          return {
            ok: false,
            error: 'Não foi possível localizar a rota JSON do histórico do Bazaar mesmo navegando em /bazaar/history. Detalhes no diagnóstico.',
          };
        }

        // Tentativa de acelerar a paginação: se o template tem `limit`,
        // eleva para 100. Validação real: a página 1 precisa continuar
        // respondendo com a listagem do histórico; senão, mantém o original.
        let urlTemplate = discovery.urlTemplate;
        let firstPageData = discovery.firstPage;
        const boosted = withParamIfPresent(withPageParam(urlTemplate, 1), 'limit', 100);
        if (boosted !== withPageParam(urlTemplate, 1)) {
          const probe = await fetchJsonWithRetry(page, boosted, 'limite-100');
          const check = probe.ok ? looksLikeHistoryListingJson(probe.data, nowSec) : { ok: false };
          if (check.ok && check.auctions.length > extractHistoryAuctions(firstPageData).length) {
            urlTemplate = boosted;
            firstPageData = probe.data;
            diag('history-v1', 'Paginação acelerada: limit=100 aceito pela rota do histórico.');
          } else {
            diag('history-v1', 'limit=100 não aceito; mantendo a paginação original da SPA.');
          }
        }

        // ── FASE 2: paginação COMPLETA da janela (data de término manda) ───
        const firstAuctions = extractHistoryAuctions(firstPageData) || [];
        const ordering = detectEndOrdering(firstAuctions);
        const totalPagesApi = extractHistoryTotalPages(firstPageData);
        diag('history-v1', 'Auditoria da listagem em tempo de execução.', {
          rota: urlTemplate, ordenacao: ordering, totalPagesApi, porPagina: firstAuctions.length,
        });

        const seenIds = new Set();
        const approvedNew = [];
        let listedCount = 0;
        let knownSkippedCount = 0;
        let pagesScanned = 0;

        const consumePage = (auctions) => {
          listedCount += auctions.length;
          const picked = selectNewApprovedFromPage(auctions, { floorTs, nowSec, knownIds, seenIds });
          approvedNew.push(...picked.approved);
          knownSkippedCount += picked.knownSkipped;
          return picked;
        };

        let stopListing = false;
        let pageNum = 1;
        let auctionsOfPage = firstAuctions;
        while (!stopListing) {
          pagesScanned = pageNum;
          const picked = consumePage(auctionsOfPage);
          sendProgress(event.sender, buildProgress(
            'bazaar',
            `Histórico: listagem página ${pageNum} — ${approvedNew.length} novo(s) leilão(ões) com lance vencedor...`,
            totalPagesApi > 0 ? Math.min(pageNum, totalPagesApi) : pageNum,
            totalPagesApi,
            { methodLabel: 'Histórico (API JSON)', scope: 'history' },
          ));

          // Critério CENTRAL de parada: a data de término. Com ordenação
          // decrescente, uma página cujo leilão mais antigo já está abaixo do
          // piso encerra a varredura — o resto é mais antigo ainda.
          if (ordering === 'desc' && picked.minEndTs > 0 && picked.minEndTs < floorTs) {
            diag('history-v1', 'Janela coberta: página alcançou leilões anteriores ao piso.', {
              pagina: pageNum, minEndTs: picked.minEndTs, floorTs,
            });
            break;
          }
          if (totalPagesApi > 0 && pageNum >= totalPagesApi) break;
          if (pageNum >= LIST_PAGES_SAFETY_CAP) {
            diag('history-v1', 'Salva-vidas de páginas atingido — verifique o diagnóstico.', { pagina: pageNum });
            break;
          }
          if (isManualStopRequested()) { stoppedManually = true; break; }

          // Próxima página.
          pageNum += 1;
          await page.waitForTimeout(currentGapMs());
          const result = await fetchJsonWithRetry(page, withPageParam(urlTemplate, pageNum), `pagina-${pageNum}`);
          if (!result.ok) {
            failureReasons[result.reason] = (failureReasons[result.reason] || 0) + 1;
            diag('history-v1', 'Página da listagem não respondeu; encerrando a varredura no ponto alcançado.', {
              pagina: pageNum, motivo: result.reason, status: result.status,
            });
            break;
          }
          auctionsOfPage = extractHistoryAuctions(result.data) || [];
          if (auctionsOfPage.length === 0) break; // fim real da listagem
        }

        // ── FASE 3: detalhes individuais SÓ dos leilões NOVOS aprovados ────
        // Ordem CRESCENTE de término: se a consulta for interrompida, tudo
        // até `processedMaxEndTs` está completo e a próxima execução retoma
        // exatamente da fronteira — nada é perdido nem refeito.
        approvedNew.sort((a, b) => (a.auctionEndTs || 0) - (b.auctionEndTs || 0));
        const detailTargets = approvedNew.slice(0, DETAILS_SAFETY_CAP);

        diag('history-v1', 'Listagem do histórico concluída.', {
          paginas: pagesScanned,
          listados: listedCount,
          jaConhecidos: knownSkippedCount,
          novosAprovados: approvedNew.length,
          analisar: detailTargets.length,
        });

        const entries = [];
        let analyzedCount = 0;
        let failedCount = 0;
        let processedMaxEndTs = 0;

        for (let index = 0; index < detailTargets.length; index++) {
          if (isManualStopRequested()) { stoppedManually = true; break; }
          const target = detailTargets[index];
          const url = buildAuctionApiUrl(base, target.id);
          const outcome = url
            ? await fetchJsonWithRetry(page, url, `detalhe-${target.id}`)
            : { ok: false, reason: 'ID_AUSENTE', status: 0 };

          if (outcome.ok) {
            analyzedCount += 1;
            const matches = watchSet.size > 0 ? collectItemMatches(outcome.data, watchSet) : [];
            const extra = collectGoldAndSkills(outcome.data);
            const quests = deriveQuestsFromApiPayload(outcome.data);
            const extras = collectHistoryExtras(outcome.data);
            entries.push({
              ...target,
              matches,
              gold: extra.gold,
              skills: extra.skills,
              soulwarCompleted: quests.soulwarCompleted,
              sanguineCompleted: quests.sanguineCompleted,
              charmPoints: extras.charmPoints,
              auraCount: extras.auraCount,
              hirelingCount: extras.hirelingCount,
              deluxePassCount: extras.deluxePassCount,
              extraPaths: extras.paths,
            });
          } else if (outcome.reason === 'ENCERRAMENTO_MANUAL') {
            stoppedManually = true;
            break; // NÃO grava o alvo: será reprocessado na próxima execução.
          } else {
            failedCount += 1;
            failureReasons[outcome.reason] = (failureReasons[outcome.reason] || 0) + 1;
            // Falha no detalhe NÃO descarta o leilão: os dados da LISTAGEM
            // (lance vencedor, level, vocação, servidor, término) são
            // válidos e entram na base com a marca do erro.
            entries.push({ ...target, detailError: outcome.reason });
          }
          if ((target.auctionEndTs || 0) > processedMaxEndTs) processedMaxEndTs = target.auctionEndTs || 0;

          sendProgress(event.sender, buildProgress('details', 'Histórico: analisando leilões finalizados...', index + 1, detailTargets.length, {
            methodLabel: 'Histórico (API JSON)', apiResolved: analyzedCount, scope: 'history',
          }));

          if (index < detailTargets.length - 1) await page.waitForTimeout(currentGapMs());
        }

        diag('history-v1', 'Consulta do histórico finalizada.', {
          listados: listedCount,
          jaConhecidos: knownSkippedCount,
          novosAprovados: approvedNew.length,
          analisados: analyzedCount,
          falhasDetalhe: failedCount,
          encerradoManualmente: stoppedManually,
          motivos: failureReasons,
          tempoTotalMs: Date.now() - startedAt,
        });

        return {
          ok: true,
          fetchedAt: startedAt,
          routeUsed: urlTemplate,
          discoveredBy: discovery.discoveredBy,
          orderingDetected: ordering,
          pagesScanned,
          floorTs,
          listedCount,
          approvedNewCount: approvedNew.length,
          knownSkippedCount,
          analyzedCount,
          failedCount,
          failureReasons,
          stoppedManually,
          entries,
          processedMaxEndTs,
          totalDurationMs: Date.now() - startedAt,
          primaryBrowser: browserKey,
        };
      } catch (error) {
        diag('history-v1', 'Erro na consulta do histórico.', { error: String(error?.message || error) });
        return { ok: false, error: String(error?.message || error) };
      } finally {
        // Devolve a página de sessão ao estado que as OUTRAS consultas
        // esperam (/bazaar) — a navegação para /bazaar/history é exclusiva
        // deste fluxo e não pode vazar para quests/itens.
        try {
          if (page && !page.isClosed()) {
            await page.goto(bazaarPageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
          }
        } catch { /* melhor esforço */ }
        try { if (finishProgress) finishProgress('history-finalizado'); } catch { /* sem progresso ativo */ }
      }
    });
  });

  diag('context', 'Consulta do HISTÓRICO do Bazaar registrada (canal rubinot-bazaar-history-v1).', {
    paginaHistorico: historyPageUrl,
  });
}

module.exports = {
  registerBazaarHistoryMethod,
  // Exportados para testes — funções puras, sem efeito colateral.
  HISTORY_WINDOW_SECONDS,
  HISTORY_INCREMENTAL_MARGIN_SECONDS,
  siteOriginFromApiBase,
  historyPageUrlFromApiBase,
  extractHistoryAuctions,
  extractHistoryTotalPages,
  looksLikeHistoryListingJson,
  withPageParam,
  withParamIfPresent,
  detectEndOrdering,
  classifyHistoryAuction,
  isApprovedHistoryAuction,
  normalizeHistoryAuction,
  selectNewApprovedFromPage,
  collectHistoryExtras,
  collectBattlepassDeluxe,
};
