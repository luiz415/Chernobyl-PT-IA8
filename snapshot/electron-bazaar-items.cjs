// ============================================================================
// BAZAAR — CONSULTA DE ITENS (canal `rubinot-bazaar-items-v2`)
// ----------------------------------------------------------------------------
// Módulo ADITIVO do painel "Personagens com Itens". Segue o mesmo desenho do
// método novo das quests (`electron-bazaar-new.cjs`):
//
//   • NÃO importa `electron-main.cjs` — recebe tudo por injeção;
//   • usa a MESMA sessão/cookies/fila do restante do Bazaar;
//   • consulta cada personagem por `fetch('/api/bazaar/<id>')` JSON dentro da
//     página autenticada — ZERO renderização de página individual;
//   • NUNCA cai no método antigo (página-a-página). Requisito explícito da
//     funcionalidade: personagem que a API não resolver vira FALHA declarada,
//     nunca uma navegação DOM.
//
// O renderer envia a lista de nomes monitorados JÁ NORMALIZADOS (watchKeys) e
// recebe de volta apenas os MATCHES brutos — nome encontrado, chave base,
// Tier e quantidade. Todo o cálculo de valor (Tier +20%/nível, kk→RC) é feito
// no renderer, com as funções já existentes. Nada é persistido aqui.
// ============================================================================

'use strict';

// `walkJson` é exportado pelo módulo do método novo exatamente para reuso:
// varredura defensiva com trava de profundidade/nós e proteção contra ciclos.
const { walkJson } = require('./electron-bazaar-new.cjs');

/** Mesma normalização de `normalizeWatchedItemName` (src/utils/bazaarWatchedItems.ts). */
function normalizeItemName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’`´]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Padrão oficial do Tier no nome: "Falcon Coif [Tier 3]". */
const TIER_PATTERN = /\s*\[\s*tier\s*(\d+)\s*\]\s*/i;

/** Separa o Tier do nome. Sem o padrão -> tier 0 e base igual ao nome. */
function parseTieredName(raw) {
  const text = String(raw || '');
  const match = text.match(TIER_PATTERN);
  if (!match) return { baseName: text.trim(), tier: 0 };
  const tier = Number(match[1]);
  return {
    baseName: text.replace(TIER_PATTERN, ' ').replace(/\s+/g, ' ').trim(),
    tier: Number.isFinite(tier) && tier > 0 ? Math.floor(tier) : 0,
  };
}

/** Chaves de objeto que costumam carregar o NOME de um item. */
const ITEM_NAME_KEYS = ['name', 'item_name', 'itemName', 'itemname', 'title'];
/** Chaves que costumam carregar a QUANTIDADE. */
const ITEM_AMOUNT_KEYS = ['amount', 'count', 'quantity', 'stack', 'total'];
/** Chaves que costumam carregar o TIER como campo separado. */
const ITEM_TIER_KEYS = ['tier', 'upgradeTier', 'upgrade_tier', 'classificationTier'];

function readNumericField(node, keys) {
  for (const key of keys) {
    const value = Number(node[key]);
    if (Number.isFinite(value) && value > 0) return Math.floor(value);
  }
  return 0;
}

/**
 * Todos os itens monitorados citados no JSON do leilão.
 *
 * Estratégia defensiva (o schema real não é assumido):
 *   • OBJETOS com um campo de nome ({ name: "Falcon Coif [Tier 3]", amount: 1 })
 *     — cobre inventário/equipamentos/store no formato mais comum;
 *   • STRINGS que são elementos diretos de um array (["falcon coif", ...])
 *     — cobre listas simples de nomes. Strings em OUTRAS posições (ex.: a
 *     própria propriedade `name` de um objeto já contado) são ignoradas para
 *     não duplicar a contagem.
 *
 * Casamento SEMPRE por igualdade do nome normalizado SEM o sufixo de Tier —
 * exatamente a regra da Lista de Itens no renderer.
 *
 * Ocorrências idênticas (mesma chave base + tier + nome) são somadas.
 */
function collectItemMatches(payload, watchKeySet) {
  const found = new Map();

  const register = (rawName, amountField, tierField) => {
    const nameText = String(rawName || '').trim();
    if (!nameText || nameText.length > 120) return;
    const { baseName, tier: tierFromName } = parseTieredName(nameText);
    const baseKey = normalizeItemName(baseName);
    if (!baseKey || !watchKeySet.has(baseKey)) return;
    const tier = tierFromName > 0 ? tierFromName : (tierField > 0 ? tierField : 0);
    const amount = amountField > 0 ? amountField : 1;
    const mapKey = `${baseKey}|${tier}|${nameText.toLowerCase()}`;
    const existing = found.get(mapKey);
    if (existing) {
      existing.amount += amount;
    } else {
      found.set(mapKey, { foundName: nameText, baseKey, tier, amount });
    }
  };

  walkJson(payload, (node, path) => {
    if (typeof node === 'string') {
      // Somente elementos DIRETOS de arrays: o caminho termina em "[n]".
      if (/\]$/.test(path)) register(node, 0, 0);
      return;
    }
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    for (const nameKey of ITEM_NAME_KEYS) {
      const value = node[nameKey];
      if (typeof value !== 'string' || !value.trim()) continue;
      register(value, readNumericField(node, ITEM_AMOUNT_KEYS), readNumericField(node, ITEM_TIER_KEYS));
      break; // um nome por objeto — evita contar o mesmo nó duas vezes
    }
  });

  return Array.from(found.values());
}

/** URL da API individual — mesma rota do método novo das quests. */
function buildAuctionApiUrl(apiBase, id) {
  const safeId = encodeURIComponent(String(id || '').trim());
  if (!safeId) return '';
  return `${String(apiBase || '').replace(/\/+$/, '')}/${safeId}`;
}

// ============================================================================
// REGISTRO
// ============================================================================
function registerBazaarItemsMethod(deps) {
  const {
    ipcMain,
    diag,
    runQueued,
    getContext,
    ensureSessionReady,
    getSessionPage,
    fetchJsonDetailed,
    normalizeAuctionUrl,
    resolveBrowserKey,
    isManualStopRequested,
    sendProgress,
    buildProgress,
    finishProgress,
    getSelectedBrowser,
    getUseCleanProfile,
    apiBase,
  } = deps || {};

  if (!ipcMain) throw new Error('registerBazaarItemsMethod: ipcMain é obrigatório.');

  // Mesmo ritmo adaptativo validado no método novo das quests: intervalo base
  // + backoff em 429 com desaceleração progressiva e reaceleração por streak.
  const API_GAP_BASE_MS = 350;
  const API_GAP_MAX_EXTRA_MS = 2000;
  const API_GAP_STEP_MS = 250;
  const API_SPEEDUP_STREAK = 8;
  const API_MAX_ATTEMPTS = 3;
  const API_BACKOFF_MS = 1200;

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

  /** Consulta UM leilão pela API. Nunca lança: falha vira `{ ok: false, reason }`. */
  async function fetchOneAuctionJson(page, auction) {
    const id = auction?.id || '';
    const url = buildAuctionApiUrl(apiBase, id);
    if (!url) return { ok: false, reason: 'ID_AUSENTE', status: 0 };

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
          diag('items-v2', 'Limite de taxa (429); aguardando antes de repetir a mesma chamada.', {
            id, tentativa: `${attempt}/${API_MAX_ATTEMPTS}`, esperaMs: backoff, intervaloAtualMs: currentGapMs(),
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

  // ==========================================================================
  // HANDLER — itens por API JSON, sem fallback página-a-página
  // ==========================================================================
  ipcMain.handle('rubinot-bazaar-items-v2', async (event, auctions, options = {}) => {
    const list = Array.isArray(auctions) ? auctions : [];
    const watchSet = new Set(
      (Array.isArray(options?.watchKeys) ? options.watchKeys : [])
        .map(key => normalizeItemName(key))
        .filter(Boolean),
    );

    return runQueued('bazaar-items-v2', async () => {
      const startedAt = Date.now();
      const browserKey = resolveBrowserKey(getSelectedBrowser ? getSelectedBrowser() : '');
      const cleanProfile = !!(getUseCleanProfile && getUseCleanProfile());
      const details = {};

      if (watchSet.size === 0) {
        return { ok: false, error: 'Nenhum item monitorado informado para a consulta.', details: {} };
      }

      diag('items-v2', 'ITENS: iniciando análise por API JSON (sem renderizar página individual).', {
        total: list.length, itensMonitorados: watchSet.size, navegador: browserKey, endpoint: `${apiBase}/{ID}`,
      });

      // ── Sessão — mesma validação/reuso do método novo das quests ──────────
      let page = null;
      try {
        const context = await getContext(browserKey, cleanProfile);
        const session = await ensureSessionReady(context, null, 'items-v2-session');
        if (!session.ok) {
          return {
            ok: false,
            error: session.message || 'Sessão Rubinot indisponível para a consulta de itens.',
            needsHumanVerification: !!session.needsHumanVerification,
            details: {},
          };
        }
        page = session.page || await getSessionPage(context);
      } catch (error) {
        return { ok: false, error: String(error?.message || error), details: {} };
      }

      let analyzedCount = 0;
      let matchedCharacters = 0;
      let stoppedManually = false;
      const failureReasons = {};

      try {
        sendProgress(event.sender, buildProgress('details', 'Itens: consultando personagens via API...', 0, list.length, {
          methodLabel: 'Itens (API JSON)',
        }));

        for (let index = 0; index < list.length; index++) {
          if (isManualStopRequested()) {
            stoppedManually = true;
            diag('items-v2', 'Encerramento manual durante a consulta de itens.', { analisados: index, restantes: list.length - index });
            break;
          }

          const auction = list[index];
          const key = auction?.id || auction?.name || auction?.url;
          if (!key) continue;

          const outcome = await fetchOneAuctionJson(page, auction);

          if (outcome.ok) {
            const matches = collectItemMatches(outcome.data, watchSet);
            analyzedCount += 1;
            if (matches.length > 0) matchedCharacters += 1;
            details[key] = { id: key, method: 'items_api_json_v2', matches, fetchedAt: Date.now() };
          } else {
            failureReasons[outcome.reason] = (failureReasons[outcome.reason] || 0) + 1;
            details[key] = { id: key, error: outcome.reason, failureReason: outcome.reason, fetchedAt: Date.now() };
          }

          sendProgress(event.sender, buildProgress('details', 'Itens: consultando personagens via API...', index + 1, list.length, {
            methodLabel: 'Itens (API JSON)',
            apiResolved: analyzedCount,
          }));

          if (index < list.length - 1) await page.waitForTimeout(currentGapMs());
        }
      } catch (error) {
        diag('items-v2', 'Erro na consulta de itens.', { error: String(error?.message || error) });
        return { ok: false, error: String(error?.message || error), details };
      } finally {
        // Sem isto, o listener de progresso do renderer ficaria "preso" em
        // estágio ativo após a consulta de itens (o handler antigo limpa os
        // estados no próprio fluxo das quests; aqui o fluxo é outro).
        try { if (finishProgress) finishProgress('itens-finalizado'); } catch (_) {}
      }

      const failedCount = Math.max(0, list.length - analyzedCount);
      const failedCharacterList = list
        .filter(auction => {
          const key = auction?.id || auction?.name || auction?.url;
          return key && details[key] && details[key].error;
        })
        .map(auction => {
          const key = auction?.id || auction?.name || auction?.url;
          return {
            id: String(auction?.id || ''),
            name: String(auction?.name || ''),
            url: normalizeAuctionUrl(auction),
            reason: String(details[key]?.failureReason || ''),
          };
        })
        .filter(entry => entry.url);

      diag('items-v2', 'Consulta de itens finalizada.', {
        total: list.length,
        analisados: analyzedCount,
        comItensMonitorados: matchedCharacters,
        falhas: failedCount,
        motivos: failureReasons,
        tempoTotalMs: Date.now() - startedAt,
      });

      return {
        ok: true,
        details,
        totalRequested: list.length,
        analyzedCount,
        matchedCharacters,
        failedCount,
        failedCharacterList,
        failureReasons,
        stoppedManually,
        totalDurationMs: Date.now() - startedAt,
        methodUsed: 'itens-v2',
        primaryBrowser: browserKey,
      };
    });
  });

  diag('context', 'Consulta de ITENS do Bazaar registrada (canal rubinot-bazaar-items-v2).', {
    endpoint: `${apiBase}/{ID}`,
  });
}

module.exports = {
  registerBazaarItemsMethod,
  // Exportados para testes — funções puras, sem efeito colateral.
  normalizeItemName,
  parseTieredName,
  collectItemMatches,
  buildAuctionApiUrl,
};
