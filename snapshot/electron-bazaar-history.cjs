// ============================================================================
// BAZAAR — CONSULTA DO HISTÓRICO OFICIAL (canal `rubinot-bazaar-history-v1`)
// ----------------------------------------------------------------------------
// Módulo ADITIVO e ISOLADO da tela "Estatísticas do Bazaar". Segue exatamente
// o desenho dos módulos irmãos (`electron-bazaar-new.cjs` para quests e
// `electron-bazaar-items.cjs` para itens):
//
//   • NÃO importa `electron-main.cjs` — recebe tudo por injeção;
//   • usa a MESMA sessão/cookies/fila global do restante do Bazaar;
//   • é 100% API JSON: a listagem do histórico e os detalhes individuais são
//     lidos por `fetch(...)` de dentro da página autenticada — ZERO
//     renderização de página individual e ZERO fallback de scraping
//     (requisito explícito da funcionalidade);
//   • responsabilidade ÚNICA: histórico oficial. A consulta atual de
//     personagens/quests e a consulta de itens continuam nos seus módulos.
//
// ── ENDPOINT DO HISTÓRICO ───────────────────────────────────────────────────
// A página pública é `https://rubinot.com.br/bazaar/history` (SPA). A rota
// JSON correspondente NÃO pôde ser confirmada do ambiente de desenvolvimento
// (todo `/api/*` responde "Access denied" fora da sessão do site — inclusive
// a rota de listagem que sabidamente funciona; o 403 não prova nada).
//
// Por isso este módulo NÃO assume uma única rota: ele SONDA os candidatos
// plausíveis (derivados da rota de listagem real `/api/bazaar`) dentro da
// sessão autenticada, valida a resposta e registra no diagnóstico a rota e o
// shape reais. A validação é semântica: uma rota só é aceita se devolver uma
// lista de leilões majoritariamente JÁ ENCERRADOS — o que impede a listagem
// de leilões ATUAIS de ser confundida com o histórico caso o servidor ignore
// parâmetros desconhecidos.
//
// ── FILTRO OBRIGATÓRIO (Status Finalizado + Lance Vencedor) ────────────────
// Um leilão do histórico só é aproveitado quando:
//   1. o status indica FINALIZADO (campo textual quando existir; na ausência
//      de campo, encerramento no passado sem indicação de cancelamento);
//   2. houve LANCE VENCEDOR. Na API real da listagem, `currentValue > 0`
//      significa "recebeu lance" (o site exibe "Lance Vencedor"); com
//      `currentValue = 0` o site exibe o "Lance Mínimo" (`startingValue`) —
//      ninguém deu lance, e o leilão é DESCARTADO.
// ============================================================================

'use strict';

// Reuso explícito dos módulos irmãos — funções PURAS já testadas:
//   • walkJson / deriveQuestsFromApiPayload (método novo das quests);
//   • collectItemMatches / collectGoldAndSkills / buildAuctionApiUrl /
//     normalizeItemName (consulta de itens).
// Nenhuma segunda implementação de extração de itens/skills/quests.
const { walkJson, deriveQuestsFromApiPayload } = require('./electron-bazaar-new.cjs');
const {
  collectItemMatches,
  collectGoldAndSkills,
  buildAuctionApiUrl,
  normalizeItemName,
} = require('./electron-bazaar-items.cjs');

// ============================================================================
// LISTAGEM DO HISTÓRICO — extração e classificação defensivas (funções puras)
// ============================================================================

/** Extrai o array de leilões do payload de UMA página da listagem. */
function extractHistoryAuctions(payload) {
  if (Array.isArray(payload?.auctions)) return payload.auctions;
  if (Array.isArray(payload)) return payload;
  // Defensivo: primeira propriedade que seja um array de objetos com cara de
  // leilão (id + name/level). Não desce além do primeiro nível — a listagem
  // real (`/api/bazaar`) entrega `auctions` na raiz.
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

/** Campos textuais candidatos a STATUS do leilão no histórico. */
const STATUS_FIELDS = ['status', 'state', 'auctionStatus', 'auction_status'];
const FINISHED_PATTERN = /^(finished|finalizado|finalizada|ended|encerrado|completed|complete)$/i;
const CANCELLED_PATTERN = /cancel/i;
const IN_PROGRESS_PATTERN = /(process|progress|andamento|current|active|ativo)/i;

/**
 * Classifica UM leilão do histórico. Retorna:
 *   { finished, cancelled, hasWinningBid, winningBid, statusText }
 *
 * REGRAS (defensivas, documentadas acima):
 *   • status textual manda quando existe;
 *   • sem campo de status, "finalizado" = encerramento no PASSADO;
 *   • lance vencedor = `currentValue > 0` (mesma semântica da listagem real,
 *     onde o site exibe "Lance Vencedor" vs "Lance Mínimo").
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
    // Sem campo de status: histórico com encerramento no passado e sem flag
    // de cancelamento é tratado como finalizado.
    cancelled = auction?.cancelled === true || auction?.canceled === true;
    const endTs = normalizeEndTs(auction?.auctionEnd ?? auction?.auctionEndTs ?? auction?.auction_end);
    finished = !cancelled && endTs > 0 && endTs <= now;
  }

  // Lance vencedor: currentValue > 0 (recebeu lance). Campos alternativos
  // cobertos por robustez, sempre com a mesma exigência de valor POSITIVO.
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
    auctionEndTs: normalizeEndTs(auction?.auctionEnd ?? auction?.auctionEndTs ?? auction?.auction_end) || null,
    statusText: info.statusText,
  };
}

// ============================================================================
// EXTRATORES ADITIVOS DO PAYLOAD INDIVIDUAL (`/api/bazaar/{ID}`)
// ----------------------------------------------------------------------------
// Mesma postura defensiva de collectGoldAndSkills: o schema exato NÃO é
// assumido; a varredura reconhece formatos plausíveis por CHAVE e por PAR
// rótulo/valor, e os caminhos encontrados vão para o diagnóstico (`paths`) —
// o que permite confirmar o schema real na primeira execução com dado na mão.
// ============================================================================

/** Chaves numéricas que carregam o TOTAL de Charm Points. */
const CHARM_KEY_HINTS = /^(totalCharmPoints|total_charm_points|charmPoints|charm_points|charmsPoints|totalCharms)$/i;
/** Rótulo textual do total de charms num par rótulo/valor. */
const CHARM_LABEL_HINTS = /^total\s*charm\s*points$/i;

/** Segmentos de caminho que denunciam a seção de AURAS. */
const AURA_PATH_HINTS = /aura/i;
/** Segmentos de caminho que denunciam a seção de HIRELINGS. */
const HIRELING_PATH_HINTS = /hireling/i;
/** Segmentos de caminho que denunciam a seção de BATTLEPASS/PASSE. */
const BATTLEPASS_PATH_HINTS = /(battlepass|battle_pass|passes|\bpass\b)/i;
/** Chave/valor que marca um passe como DELUXE ("Sim"/true/"yes"). */
const DELUXE_KEY_HINTS = /deluxe/i;

/** Valor "afirmativo" de deluxe: true, "sim", "yes", 1. */
function isAffirmative(value) {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') return /^(sim|yes|true|1)$/i.test(value.trim());
  return false;
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
 *
 * Contagens de seção (auras/hirelings): preferem o ARRAY da seção (conta os
 * elementos); aceitam contagem numérica direta quando o payload trouxer o
 * número pronto. Passes Deluxe: elementos de uma seção de battlepass cujo
 * campo `deluxe` (ou equivalente) seja afirmativo ("Sim"/true).
 */
function collectHistoryExtras(payload) {
  let charmPoints = null;
  let auraCount = null;
  let hirelingCount = null;
  let deluxePassCount = null;
  const paths = { charm: '', auras: '', hirelings: '', deluxe: '' };

  // Contagens diretas na raiz (ex.: { auraCount: 12, hirelings: 2 }).
  const rootAuras = readDirectCount(payload, /^(auraCount|aura_count|auras|totalAuras|total_auras)$/i);
  if (rootAuras !== null) { auraCount = rootAuras; paths.auras = '(raiz)'; }
  const rootHirelings = readDirectCount(payload, /^(hirelingCount|hireling_count|hirelings|totalHirelings|total_hirelings)$/i);
  if (rootHirelings !== null) { hirelingCount = rootHirelings; paths.hirelings = '(raiz)'; }

  walkJson(payload, (node, path) => {
    // ── Charm Points: chave numérica OU par rótulo/valor ───────────────────
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
      // ── Passe Deluxe: nó de seção battlepass com campo deluxe = "Sim" ───
      if (BATTLEPASS_PATH_HINTS.test(path)) {
        for (const [key, value] of Object.entries(node)) {
          if (DELUXE_KEY_HINTS.test(key) && isAffirmative(value)) {
            deluxePassCount = (deluxePassCount === null ? 0 : deluxePassCount) + 1;
            if (!paths.deluxe) paths.deluxe = path;
            break;
          }
        }
      }
      return;
    }
    // ── Auras/Hirelings: ARRAY cuja seção é denunciada pelo caminho ────────
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

  return {
    charmPoints,
    auraCount,
    hirelingCount,
    deluxePassCount,
    paths,
  };
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
  /** Teto rígido de páginas da listagem do histórico por consulta. */
  const MAX_HISTORY_PAGES = 50;
  /** Teto rígido de personagens analisados individualmente por consulta. */
  const MAX_HISTORY_DETAILS = 1500;

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

  /** Candidatos de rota da LISTAGEM do histórico (ver cabeçalho do arquivo). */
  function historyListUrlCandidates(pageNum) {
    const params = new URLSearchParams({ sortBy: 'auction_end', sortOrder: 'desc', limit: 100, page: pageNum });
    return [
      `${base}/history?${params.toString()}`,
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
   * SONDA a rota do histórico: a primeira candidata que devolver uma lista de
   * leilões MAJORITARIAMENTE encerrados vence. Rota que devolve leilões
   * futuros é a listagem ATUAL respondendo com parâmetros ignorados — é
   * rejeitada (validação semântica, ver cabeçalho).
   */
  async function probeHistoryRoute(page) {
    const nowSec = Math.floor(Date.now() / 1000);
    for (const url of historyListUrlCandidates(1)) {
      const result = await fetchJsonWithRetry(page, url, 'sonda-historico');
      if (!result.ok) {
        diag('history-v1', 'Candidata de rota do histórico rejeitada (resposta inválida).', {
          url, motivo: result.reason, status: result.status,
        });
        continue;
      }
      const auctions = extractHistoryAuctions(result.data);
      if (!auctions || auctions.length === 0) {
        diag('history-v1', 'Candidata de rota do histórico rejeitada (sem lista de leilões).', { url });
        continue;
      }
      const endedCount = auctions.filter(a => {
        const endTs = normalizeEndTs(a?.auctionEnd ?? a?.auctionEndTs ?? a?.auction_end);
        return endTs > 0 && endTs <= nowSec;
      }).length;
      if (endedCount * 2 < auctions.length) {
        diag('history-v1', 'Candidata de rota do histórico rejeitada (leilões majoritariamente futuros — é a listagem atual).', {
          url, total: auctions.length, encerrados: endedCount,
        });
        continue;
      }
      diag('history-v1', 'Rota do histórico confirmada.', {
        url, total: auctions.length, encerrados: endedCount, totalPages: extractHistoryTotalPages(result.data),
      });
      // O template da rota (sem o valor da página) é reconstituído trocando
      // apenas `page=1` — as candidatas são geradas com page=1.
      return { urlTemplate: url, firstPage: result.data };
    }
    return null;
  }

  // ==========================================================================
  // HANDLER — histórico por API JSON, sem fallback página-a-página
  // ==========================================================================
  ipcMain.handle('rubinot-bazaar-history-v1', async (event, options = {}) => {
    const maxPages = Math.min(MAX_HISTORY_PAGES, Math.max(1, Math.floor(Number(options?.maxPages) || 10)));
    const watchSet = new Set(
      (Array.isArray(options?.watchKeys) ? options.watchKeys : [])
        .map(key => normalizeItemName(key))
        .filter(Boolean),
    );

    return runQueued('bazaar-history-v1', async () => {
      const startedAt = Date.now();
      const nowSec = Math.floor(startedAt / 1000);
      const browserKey = resolveBrowserKey(getSelectedBrowser ? getSelectedBrowser() : '');
      const cleanProfile = !!(getUseCleanProfile && getUseCleanProfile());

      diag('history-v1', 'HISTÓRICO: iniciando consulta por API JSON (sem renderizar página individual).', {
        maxPages, itensMonitorados: watchSet.size, navegador: browserKey, endpointBase: base,
      });

      // ── Sessão — mesma validação/reuso dos módulos irmãos ─────────────────
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
        // ── FASE 1: listagem do histórico ────────────────────────────────────
        sendProgress(event.sender, buildProgress('bazaar', 'Histórico: consultando listagem...', 0, maxPages, {
          methodLabel: 'Histórico (API JSON)', scope: 'history',
        }));

        const probe = await probeHistoryRoute(page);
        if (!probe) {
          return {
            ok: false,
            error: 'Não foi possível localizar a rota JSON do histórico do Bazaar. Nenhuma candidata respondeu com uma lista de leilões encerrados (detalhes no diagnóstico).',
          };
        }

        const rawAuctions = [];
        const firstAuctions = extractHistoryAuctions(probe.firstPage) || [];
        rawAuctions.push(...firstAuctions);
        const totalPagesApi = extractHistoryTotalPages(probe.firstPage);
        const pagesToFetch = totalPagesApi > 0 ? Math.min(maxPages, totalPagesApi) : maxPages;

        for (let pageNum = 2; pageNum <= pagesToFetch; pageNum++) {
          if (isManualStopRequested()) { stoppedManually = true; break; }
          await page.waitForTimeout(currentGapMs());
          const url = probe.urlTemplate.replace(/([?&]page=)1\b/, `$1${pageNum}`);
          const result = await fetchJsonWithRetry(page, url, `pagina-${pageNum}`);
          if (!result.ok) {
            failureReasons[result.reason] = (failureReasons[result.reason] || 0) + 1;
            diag('history-v1', 'Página da listagem do histórico não respondeu; seguindo com o que já foi coletado.', {
              pagina: pageNum, motivo: result.reason, status: result.status,
            });
            continue;
          }
          const pageAuctions = extractHistoryAuctions(result.data);
          if (!pageAuctions || pageAuctions.length === 0) break; // fim real da listagem
          rawAuctions.push(...pageAuctions);
          sendProgress(event.sender, buildProgress('bazaar', 'Histórico: consultando listagem...', pageNum, pagesToFetch, {
            methodLabel: 'Histórico (API JSON)', scope: 'history',
          }));
        }

        // ── FILTRO OBRIGATÓRIO: Finalizado + Lance Vencedor ─────────────────
        // Dedupe por id: uma mesma oferta nunca entra duas vezes (páginas
        // podem deslizar entre uma chamada e outra).
        const seenIds = new Set();
        const approved = [];
        for (const raw of rawAuctions) {
          const id = String(raw?.id || '');
          if (!id || seenIds.has(id)) continue;
          seenIds.add(id);
          if (!isApprovedHistoryAuction(raw, nowSec)) continue;
          approved.push(normalizeHistoryAuction(raw, nowSec));
        }
        const detailTargets = approved.slice(0, MAX_HISTORY_DETAILS);

        diag('history-v1', 'Listagem do histórico concluída.', {
          paginasLidas: pagesToFetch,
          leiloesListados: rawAuctions.length,
          unicos: seenIds.size,
          aprovados: approved.length,
          analisar: detailTargets.length,
        });

        // ── FASE 2: detalhes individuais (API JSON, um fetch por aprovado) ──
        const entries = [];
        let analyzedCount = 0;
        let failedCount = 0;

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
          } else {
            failedCount += 1;
            failureReasons[outcome.reason] = (failureReasons[outcome.reason] || 0) + 1;
            // Falha no detalhe NÃO descarta o registro do histórico: os dados
            // da LISTAGEM (lance vencedor, level, voc, servidor) são válidos.
            entries.push({ ...target, detailError: outcome.reason });
          }

          sendProgress(event.sender, buildProgress('details', 'Histórico: analisando personagens finalizados...', index + 1, detailTargets.length, {
            methodLabel: 'Histórico (API JSON)', apiResolved: analyzedCount, scope: 'history',
          }));

          if (index < detailTargets.length - 1) await page.waitForTimeout(currentGapMs());
        }

        diag('history-v1', 'Consulta do histórico finalizada.', {
          listados: rawAuctions.length,
          aprovados: approved.length,
          analisados: analyzedCount,
          falhasDetalhe: failedCount,
          encerradoManualmente: stoppedManually,
          motivos: failureReasons,
          tempoTotalMs: Date.now() - startedAt,
        });

        return {
          ok: true,
          fetchedAt: startedAt,
          listedCount: rawAuctions.length,
          approvedCount: approved.length,
          analyzedCount,
          failedCount,
          failureReasons,
          stoppedManually,
          entries,
          totalDurationMs: Date.now() - startedAt,
          primaryBrowser: browserKey,
        };
      } catch (error) {
        diag('history-v1', 'Erro na consulta do histórico.', { error: String(error?.message || error) });
        return { ok: false, error: String(error?.message || error) };
      } finally {
        // O progresso desta consulta pertence SOMENTE ao scope 'history';
        // finalizar aqui nunca interfere nas guias Quests/Itens (elas ignoram
        // este scope) — mesmo padrão do módulo de itens.
        try { if (finishProgress) finishProgress('history-finalizado'); } catch (_) {}
      }
    });
  });

  diag('context', 'Consulta do HISTÓRICO do Bazaar registrada (canal rubinot-bazaar-history-v1).', {
    endpointBase: base,
  });
}

module.exports = {
  registerBazaarHistoryMethod,
  // Exportados para testes — funções puras, sem efeito colateral.
  extractHistoryAuctions,
  extractHistoryTotalPages,
  classifyHistoryAuction,
  isApprovedHistoryAuction,
  normalizeHistoryAuction,
  collectHistoryExtras,
};
