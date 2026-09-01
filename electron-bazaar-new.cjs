// ============================================================================
// MÉTODO NOVO DE CONSULTA DO BAZAAR — módulo isolado
// ----------------------------------------------------------------------------
// Este arquivo é 100% ADITIVO. Ele não altera, não monkey-patcha e não
// reimplementa nada do método antigo: recebe por injeção as funções que já
// existem em `electron-main.cjs` e as USA como estão.
//
// O toque em `electron-main.cjs` é de apenas duas linhas (um `require` e uma
// chamada de registro), exatamente como combinado.
//
// ── O QUE MUDA EM RELAÇÃO AO MÉTODO ANTIGO ─────────────────────────────────
//
// A auditoria mostrou que a mensagem "Falha ao carregar leilão" nasce em UM
// único lugar: dentro da página renderizada `/bazaar/<id>`. Ela NÃO existe na
// fase de listagem, que já é JSON puro (`/api/bazaar?...`) nos dois métodos.
//
// Por isso o método novo mantém a listagem EXATAMENTE como está (é o mesmo
// endpoint, o mesmo código, o mesmo resultado) e troca apenas a FASE DE
// DETALHES:
//
//   ANTIGO:  page.goto('/bazaar/<id>')  ->  esperar SPA hidratar
//                                       ->  clicar na aba "Bosstiary"
//                                       ->  esperar o painel montar
//                                       ->  ler tabela / paginar / até 6 buscas
//
//   NOVO:    fetch('/api/bazaar/<id>')  ->  ler JSON
//
// Zero renderização, zero DOM, zero clique. Onde não havia render, não há como
// aparecer "Falha ao carregar leilão".
//
// ── HONESTIDADE SOBRE O QUE NÃO PUDE VERIFICAR ─────────────────────────────
// A rota `/api/bazaar/{ID}` foi relatada pelo usuário (descoberta por outra
// IA). Ela NÃO pôde ser confirmada no ambiente de desenvolvimento: o sandbox
// não alcança `rubinot.com.br`, e de fora o site responde `403 Access denied`
// para QUALQUER `/api/*` — inclusive para a rota de listagem que sabidamente
// funciona. Ou seja, o 403 não prova nem desmente nada.
//
// Como o schema da resposta é desconhecido, este módulo NÃO assume formato
// algum. Ele:
//   1. varre o JSON recursivamente atrás de estruturas reconhecíveis;
//   2. registra no diagnóstico o formato real que recebeu (`shape`);
//   3. quando não consegue concluir, NÃO inventa resultado — devolve o
//      personagem para o MÉTODO ANTIGO (fallback), que roda intacto.
//
// Consequência: o método novo nunca pode ser PIOR que o antigo. No pior caso
// (rota inexistente), todo mundo cai no fallback e o resultado é idêntico ao
// de hoje, com o custo de uma requisição JSON extra por personagem.
//
// ── SEM BURLAR NADA ────────────────────────────────────────────────────────
// Mesma sessão, mesmos cookies, mesmo navegador escolhido pelo usuário. Sem
// stealth, sem bypass de Cloudflare/Turnstile, sem rotação de IP. A chamada
// JSON sai de dentro da própria página do RubinOT, como o site já faz.
// ============================================================================

'use strict';

// ============================================================================
// BOSSES — espelham as constantes do método antigo
// ----------------------------------------------------------------------------
// Declarados aqui (e não importados) porque `electron-main.cjs` não exporta
// nada. Os valores são os mesmos, e o teste `bazaar-method-split.test.cjs`
// compara os dois conjuntos item a item para impedir que divirjam.
// ============================================================================
const NEW_SOUL_WAR_BOSSES = [
  "goshnar's cruelty",
  "goshnar's malice",
  "goshnar's greed",
  "goshnar's spite",
  "goshnar's hatred",
  "goshnar's megalomania",
];
const NEW_SANGUINE_BOSSES = [
  'murcion',
  'vemiath',
  'ichgahal',
  'chagorz',
  'bakragore',
];
const NEW_SOUL_WAR_FINAL_BOSS = "goshnar's megalomania";
const NEW_SANGUINE_FINAL_BOSS = 'bakragore';

/** Mesma normalização do método antigo (acentos, aspas curvas, hífens). */
function normalizeBossName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’`´]/g, "'")
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// ============================================================================
// EXTRAÇÃO DEFENSIVA DO JSON
// ----------------------------------------------------------------------------
// Nenhuma destas funções assume um schema. Todas são puras e testadas em
// `tools/bazaar-method-split-tests/`.
// ============================================================================

/** Profundidade máxima da varredura — trava contra JSON patológico. */
const MAX_SCAN_DEPTH = 12;
/** Teto de nós visitados, para a varredura nunca virar gargalo. */
const MAX_SCAN_NODES = 20000;

/**
 * Percorre o JSON e chama `visit(node, path)` em cada nó.
 * Protegido contra ciclos, profundidade excessiva e payloads gigantes.
 */
function walkJson(root, visit) {
  const seen = new WeakSet();
  let visited = 0;

  const walk = (node, path, depth) => {
    if (node === null || node === undefined) return;
    if (visited++ > MAX_SCAN_NODES) return;
    if (depth > MAX_SCAN_DEPTH) return;

    if (typeof node === 'object') {
      if (seen.has(node)) return;
      seen.add(node);
    }

    visit(node, path);

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) walk(node[i], `${path}[${i}]`, depth + 1);
    } else if (typeof node === 'object') {
      for (const key of Object.keys(node)) walk(node[key], path ? `${path}.${key}` : key, depth + 1);
    }
  };

  walk(root, '', 0);
}

/**
 * Todos os bosses conhecidos citados em QUALQUER string do JSON.
 *
 * Casamento por igualdade normalizada OU por conter o nome do boss. O segundo
 * caso cobre rótulos como "Goshnar's Malice (Brachio)".
 *
 * Devolve também `paths`: onde cada boss foi encontrado. Isso é diagnóstico —
 * é o que permite descobrir o schema real na primeira execução sem chutar.
 */
function collectBossMentions(payload) {
  const found = new Map();
  const allBosses = [...NEW_SOUL_WAR_BOSSES, ...NEW_SANGUINE_BOSSES];

  walkJson(payload, (node, path) => {
    if (typeof node !== 'string') return;
    const normalized = normalizeBossName(node);
    if (!normalized) return;
    for (const boss of allBosses) {
      if (normalized === boss || normalized.includes(boss)) {
        if (!found.has(boss)) found.set(boss, path);
      }
    }
  });

  return {
    bosses: Array.from(found.keys()),
    paths: Object.fromEntries(found),
  };
}

/**
 * Arrays que PARECEM uma Bosstiary: coleções de objetos com um campo de nome.
 *
 * Só serve para distinguir "a estrutura existe e está vazia" (resultado
 * VÁLIDO — personagem que nunca matou boss algum, o caso mais valioso do
 * filtro) de "a estrutura não veio nesta resposta" (inconclusivo).
 *
 * ATENÇÃO: essa distinção é a razão de a lição "Bosstiary vazia é resultado
 * VÁLIDO" continuar respeitada. Sem ela, um campo ausente viraria
 * silenciosamente "quest disponível".
 */
// CONFIRMADO EM EXECUÇÃO REAL (log de 208 personagens): a chave usada pelo
// RubinOT é `bosstiaries` — plural em "-ies", que o regex original NÃO cobria.
// Sintoma: `containersBosstiary: []` mesmo com bosses presentes em
// `bosstiaries[0].name`, e 8 personagens classificados como
// SEM_ESTRUTURA_DE_BOSSTIARY quando na verdade tinham a lista legitimamente
// VAZIA — justamente o caso mais valioso do filtro (Soul War disponível).
const BOSSTIARY_KEY_HINTS = /^(bosstiaries|bosstiary|bosses|bossProgress|bossesKilled|bossKills|killedBosses|bestiary)$/i;

function findBosstiaryContainers(payload) {
  const containers = [];

  walkJson(payload, (node, path) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    for (const key of Object.keys(node)) {
      if (!BOSSTIARY_KEY_HINTS.test(key)) continue;
      const value = node[key];
      if (Array.isArray(value)) {
        containers.push({ path: path ? `${path}.${key}` : key, key, length: value.length });
      }
    }
  });

  return containers;
}

/**
 * Entradas de storage no formato `{ storageId, value }`.
 *
 * Existe porque o usuário relatou que outra IA encontrou `storageId: 21216`
 * com `requiredValue: 1` para Soul War. NÃO consegui comprovar esses valores
 * (ver cabeçalho), então este módulo:
 *   • NÃO usa storage algum para decidir quest;
 *   • apenas COLETA o que existir e registra no diagnóstico.
 *
 * Assim, se a estrutura existir de verdade, você a verá no log com os IDs
 * REAIS — e aí sim poderemos decidir, com dado na mão, se vale usá-la.
 *
 * Motivo de não usar agora: uma storage key é um critério SEMANTICAMENTE
 * DIFERENTE do atual (hoje: 6 Goshnar's ou Megalomania na Bosstiary). Trocar
 * às cegas mudaria a regra de negócio da coluna Soul War — o que é proibido.
 */
function collectStorageEntries(payload) {
  const entries = [];

  walkJson(payload, (node, path) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    const keys = Object.keys(node);
    const idKey = keys.find(k => /^(storageId|storage_id|storagekey|key|id)$/i.test(k));
    const hasStorageWord = keys.some(k => /storage/i.test(k));
    if (!hasStorageWord || !idKey) return;
    const rawId = node[idKey];
    if (typeof rawId !== 'number' && typeof rawId !== 'string') return;
    const valueKey = keys.find(k => /^(value|requiredValue|required_value|amount|count)$/i.test(k));
    entries.push({
      path,
      storageId: rawId,
      value: valueKey ? node[valueKey] : undefined,
    });
  });

  return entries;
}

/**
 * Retrato do formato recebido — chaves de topo e tipos.
 *
 * É o que transforma a primeira execução real numa DESCOBERTA de schema em vez
 * de um chute. Vai inteiro para o log de diagnóstico.
 */
function summarizeJsonShape(payload) {
  if (!payload || typeof payload !== 'object') {
    return { type: typeof payload, keys: [] };
  }
  if (Array.isArray(payload)) {
    return { type: 'array', length: payload.length, sampleKeys: payload[0] && typeof payload[0] === 'object' ? Object.keys(payload[0]).slice(0, 40) : [] };
  }
  const keys = Object.keys(payload);
  const typed = {};
  for (const key of keys.slice(0, 60)) {
    const value = payload[key];
    typed[key] = Array.isArray(value) ? `array(${value.length})` : (value === null ? 'null' : typeof value);
  }
  return { type: 'object', keys: keys.slice(0, 60), types: typed };
}

/**
 * Conclui Soul War / Sanguine a partir do payload da API individual.
 *
 * ── REGRA DE NEGÓCIO: IDÊNTICA À DO MÉTODO ANTIGO ─────────────────────────
 *   • Soul War concluída  = os 6 Goshnar's presentes OU Megalomania presente
 *   • Sanguine concluída  = os 5 presentes OU Bakragore presente
 *   • Quest fora do escopo do filtro (`all`) => `null` (= "Não verificado"),
 *     nunca `false`, que significaria "disponível" e seria inventar resultado.
 *
 * `resolved: false` significa "esta resposta não permite concluir" — e nesse
 * caso o personagem vai para o FALLBACK no método antigo. Nunca chutamos.
 */
function deriveQuestsFromApiPayload(payload, quests = { soulwar: true, sanguine: true }) {
  const mentions = collectBossMentions(payload);
  const containers = findBosstiaryContainers(payload);
  const storages = collectStorageEntries(payload);

  const bossSet = new Set(mentions.bosses.map(normalizeBossName));

  // A estrutura de bosstiary existe nesta resposta?
  //   • algum boss conhecido citado  => existe, com conteúdo
  //   • container reconhecível       => existe (mesmo vazio: resultado VÁLIDO)
  // Sem nenhum dos dois, a resposta é INCONCLUSIVA — não dá para diferenciar
  // "nunca matou boss algum" de "este endpoint não traz bosstiary".
  const hasBosstiaryStructure = bossSet.size > 0 || containers.length > 0;

  if (!hasBosstiaryStructure) {
    return {
      resolved: false,
      reason: 'SEM_ESTRUTURA_DE_BOSSTIARY',
      soulwarCompleted: null,
      sanguineCompleted: null,
      evidence: { shape: summarizeJsonShape(payload), storages, containers, bossPaths: mentions.paths },
    };
  }

  const soulWarFoundBosses = NEW_SOUL_WAR_BOSSES.filter(boss => bossSet.has(normalizeBossName(boss)));
  const sanguineFoundBosses = NEW_SANGUINE_BOSSES.filter(boss => bossSet.has(normalizeBossName(boss)));
  const soulWarFinalFound = bossSet.has(normalizeBossName(NEW_SOUL_WAR_FINAL_BOSS));
  const sanguineFinalFound = bossSet.has(normalizeBossName(NEW_SANGUINE_FINAL_BOSS));

  return {
    resolved: true,
    reason: 'OK',
    soulwarCompleted: quests.soulwar
      ? (soulWarFoundBosses.length === NEW_SOUL_WAR_BOSSES.length || soulWarFinalFound)
      : null,
    sanguineCompleted: quests.sanguine
      ? (sanguineFoundBosses.length === NEW_SANGUINE_BOSSES.length || sanguineFinalFound)
      : null,
    soulWarFoundBosses,
    sanguineFoundBosses,
    soulWarBossCount: soulWarFoundBosses.length,
    sanguineBossCount: sanguineFoundBosses.length,
    totalBosstiaryBosses: bossSet.size,
    // `shape` também no caminho de SUCESSO: sem ele o log de descoberta
    // imprimia `{ type: 'object', keys: [] }` (o fallback), escondendo
    // justamente o formato real quando a leitura dava certo.
    evidence: { shape: summarizeJsonShape(payload), storages, containers, bossPaths: mentions.paths },
  };
}

/** URL da API individual. Rota informada pelo usuário; não inventada aqui. */
function buildAuctionApiUrl(apiBase, id) {
  const safeId = encodeURIComponent(String(id || '').trim());
  if (!safeId) return '';
  return `${String(apiBase || '').replace(/\/+$/, '')}/${safeId}`;
}

// ============================================================================
// REGISTRO DO MÉTODO NOVO
// ----------------------------------------------------------------------------
// Recebe por injeção tudo o que precisa. Não importa `electron-main.cjs` (o
// que criaria ciclo) e não redefine nada que já exista lá.
// ============================================================================
function registerBazaarNewMethod(deps) {
  const {
    ipcMain,
    diag,
    runQueued,
    getContext,
    ensureSessionReady,
    getSessionPage,
    fetchJsonDetailed,
    normalizeAuctionUrl,
    resolveQuestScope,
    resolveBrowserKey,
    isManualStopRequested,
    sendProgress,
    buildProgress,
    fetchDetailsWithPlaywright,
    getSelectedBrowser,
    getUseCleanProfile,
    apiBase,
  } = deps || {};

  if (!ipcMain) throw new Error('registerBazaarNewMethod: ipcMain é obrigatório.');

  // ==========================================================================
  // RITMO — corrigido após a primeira execução real
  // --------------------------------------------------------------------------
  // A primeira execução (208 personagens) mostrou `apiStatus: 429` já na
  // validação da sessão e 190 respostas não-JSON. O diagnóstico é direto: o
  // intervalo de 120ms que eu havia escolhido atropelou o limite de taxa do
  // servidor. Não era a rota que faltava — era ritmo.
  //
  // Correção em três frentes, espelhando o que o método antigo já faz na
  // listagem (`fetchRubinotBazaarPageResilient`):
  //   1. intervalo base maior;
  //   2. retentativa da MESMA chamada em caso de 429, com backoff que
  //      respeita o cabeçalho `Retry-After` quando o servidor o envia;
  //   3. desaceleração adaptativa: cada 429 aumenta o intervalo de todas as
  //      chamadas seguintes; sequências de sucesso o reduzem de volta.
  //
  // Mesmo assim continua MUITO mais barato que o método antigo: 1 requisição
  // JSON por personagem contra uma SPA inteira renderizada.
  const API_GAP_BASE_MS = 350;
  /** Teto do acréscimo adaptativo, para nunca virar uma consulta eterna. */
  const API_GAP_MAX_EXTRA_MS = 2000;
  /** Quanto cada 429 acrescenta ao intervalo das próximas chamadas. */
  const API_GAP_STEP_MS = 250;
  /** Sucessos seguidos necessários para acelerar de volta um degrau. */
  const API_SPEEDUP_STREAK = 8;
  /** Tentativas por personagem: 1 inicial + 2 retentativas em caso de 429. */
  const API_MAX_ATTEMPTS = 3;
  /** Base do backoff entre tentativas da MESMA chamada. */
  const API_BACKOFF_MS = 1200;

  /** Acréscimo adaptativo corrente e sequência de sucessos. */
  let apiGapExtraMs = 0;
  let apiSuccessStreak = 0;

  function currentApiGapMs() {
    return API_GAP_BASE_MS + apiGapExtraMs;
  }

  function registerRateLimited() {
    apiSuccessStreak = 0;
    apiGapExtraMs = Math.min(API_GAP_MAX_EXTRA_MS, apiGapExtraMs + API_GAP_STEP_MS);
  }

  function registerApiSuccess() {
    apiSuccessStreak += 1;
    if (apiSuccessStreak >= API_SPEEDUP_STREAK && apiGapExtraMs > 0) {
      apiSuccessStreak = 0;
      apiGapExtraMs = Math.max(0, apiGapExtraMs - API_GAP_STEP_MS);
    }
  }

  /**
   * Consulta os detalhes de UM personagem pela API individual.
   *
   * Nunca lança: qualquer problema vira `{ resolved: false }` e o personagem
   * segue para o fallback no método antigo.
   *
   * O 429 é tratado como TRANSITÓRIO (é ritmo, não ausência de dado), então
   * ele merece retentativa — ao contrário de 403/404, que são conclusivos e
   * saem na primeira resposta.
   */
  async function fetchOneByApi(page, auction, quests) {
    const id = auction?.id || '';
    const url = buildAuctionApiUrl(apiBase, id);
    if (!url) return { resolved: false, reason: 'ID_AUSENTE', status: 0 };

    let lastStatus = 0;
    let lastPreview = '';

    for (let attempt = 1; attempt <= API_MAX_ATTEMPTS; attempt++) {
      if (isManualStopRequested()) {
        return { resolved: false, reason: 'ENCERRAMENTO_MANUAL', status: lastStatus };
      }

      let response = null;
      try {
        response = await fetchJsonDetailed(page, url);
      } catch (error) {
        return { resolved: false, reason: 'ERRO_DE_REDE', status: 0, error: String(error?.message || error) };
      }

      lastStatus = Number(response?.status || 0);
      lastPreview = String(response?.textPreview || '').slice(0, 180);

      // ── 429: ritmo, não falta de dado. Espera e tenta de novo. ────────────
      if (lastStatus === 429) {
        registerRateLimited();
        if (attempt < API_MAX_ATTEMPTS) {
          const retryAfterSec = Number(response?.retryAfter || 0);
          const backoff = retryAfterSec > 0
            ? Math.min(retryAfterSec * 1000, 15000)
            : API_BACKOFF_MS * attempt;
          diag('details-v2', 'Limite de taxa (429); aguardando antes de repetir a mesma chamada.', {
            id, tentativa: `${attempt}/${API_MAX_ATTEMPTS}`, esperaMs: backoff, intervaloAtualMs: currentApiGapMs(),
          });
          await page.waitForTimeout(backoff);
          continue;
        }
        return { resolved: false, reason: 'LIMITE_DE_TAXA_429', status: lastStatus, preview: lastPreview };
      }

      if (!response?.ok || !response?.isJson || !response?.data) {
        return {
          resolved: false,
          reason: lastStatus === 404 ? 'ROTA_INEXISTENTE'
            : lastStatus === 403 ? 'ACESSO_NEGADO'
              : lastStatus === 401 ? 'NAO_AUTENTICADO'
                : lastStatus >= 500 ? 'ERRO_DO_SERVIDOR'
                  : 'RESPOSTA_NAO_JSON',
          status: lastStatus,
          preview: lastPreview,
        };
      }

      registerApiSuccess();
      const derived = deriveQuestsFromApiPayload(response.data, quests);
      return { ...derived, status: lastStatus };
    }

    return { resolved: false, reason: 'LIMITE_DE_TAXA_429', status: lastStatus, preview: lastPreview };
  }

  // ==========================================================================
  // HANDLER — detalhes pelo método novo
  // --------------------------------------------------------------------------
  // Mesmo contrato de entrada e de SAÍDA do handler antigo
  // (`rubinot-bazaar-details`): o renderer não precisa saber qual método rodou.
  // ==========================================================================
  ipcMain.handle('rubinot-bazaar-details-v2', async (event, auctions, options = {}) => {
    const list = Array.isArray(auctions) ? auctions : [];
    const merged = { ...(options || {}), cleanProfile: !!(getUseCleanProfile && getUseCleanProfile()) };

    return runQueued('bazaar-details-v2', async () => {
      const startedAt = Date.now();
      const quests = resolveQuestScope(merged);
      const browserKey = resolveBrowserKey(getSelectedBrowser ? getSelectedBrowser() : '');
      const details = {};

      diag('details-v2', 'MÉTODO NOVO: iniciando análise por API JSON (sem renderizar página individual).', {
        total: list.length, quests, navegador: browserKey, endpoint: `${apiBase}/{ID}`,
      });

      // ── Sessão ────────────────────────────────────────────────────────────
      // Mesma validação do método antigo: cookies + Cloudflare + API viva.
      // Reutiliza a função existente, sem alterá-la.
      let page = null;
      try {
        const context = await getContext(browserKey, merged.cleanProfile);
        const session = await ensureSessionReady(context, null, 'details-v2-session');
        if (!session.ok) {
          return {
            ok: false,
            error: session.message || 'Sessão Rubinot indisponível para o método novo.',
            needsHumanVerification: !!session.needsHumanVerification,
            details: {},
          };
        }
        page = session.page || await getSessionPage(context);
      } catch (error) {
        return { ok: false, error: String(error?.message || error), details: {} };
      }

      // ── Passada JSON ──────────────────────────────────────────────────────
      const unresolved = [];
      let resolvedCount = 0;
      let stoppedManually = false;
      // Retrato do primeiro payload recebido: é o que revela o schema real.
      let firstShapeLogged = false;
      const failureReasons = {};
      const failureStatuses = {};
      const failureSamples = {};

      sendProgress(event.sender, buildProgress('details', 'Método novo: consultando quests via API...', 0, list.length, {
        methodLabel: 'Novo (API JSON)',
      }));

      for (let index = 0; index < list.length; index++) {
        if (isManualStopRequested()) {
          stoppedManually = true;
          diag('details-v2', 'Encerramento manual durante a passada JSON.', { analisados: index, restantes: list.length - index });
          break;
        }

        const auction = list[index];
        const key = auction?.id || auction?.name || auction?.url;
        if (!key) continue;

        const outcome = await fetchOneByApi(page, auction, quests);

        // Diagnóstico rico da PRIMEIRA resposta: chaves, storages e onde os
        // bosses apareceram. É isto que responde, na prática, se a rota
        // existe e o que ela entrega.
        if (!firstShapeLogged && outcome.evidence) {
          firstShapeLogged = true;
          diag('details-v2', 'DESCOBERTA — formato real da resposta da API individual.', {
            id: key,
            resolvido: outcome.resolved,
            motivo: outcome.reason,
            shape: outcome.evidence.shape || summarizeJsonShape(null),
            containersBosstiary: outcome.evidence.containers,
            caminhosDosBosses: outcome.evidence.bossPaths,
            storagesEncontrados: outcome.evidence.storages,
          });
        }

        if (outcome.resolved) {
          resolvedCount += 1;
          details[key] = {
            id: key,
            method: 'api_json_v2',
            soulwarCompleted: outcome.soulwarCompleted,
            sanguineCompleted: outcome.sanguineCompleted,
            soulWarBossCount: outcome.soulWarBossCount,
            sanguineBossCount: outcome.sanguineBossCount,
            totalBosstiaryBosses: outcome.totalBosstiaryBosses,
            fetchedAt: Date.now(),
          };
        } else {
          failureReasons[outcome.reason] = (failureReasons[outcome.reason] || 0) + 1;
          // Status HTTP por motivo: sem isso, "RESPOSTA_NAO_JSON" some com a
          // causa real (429? 500? HTML de erro?) e o diagnóstico vira chute.
          if (outcome.status) {
            const bucket = `${outcome.reason}:${outcome.status}`;
            failureStatuses[bucket] = (failureStatuses[bucket] || 0) + 1;
          }
          // Amostra do corpo devolvido, uma única vez por motivo. É o que
          // permite distinguir um JSON de erro de uma página HTML.
          if (outcome.preview && !failureSamples[outcome.reason]) {
            failureSamples[outcome.reason] = outcome.preview;
          }
          unresolved.push(auction);
        }

        sendProgress(event.sender, buildProgress('details', 'Método novo: consultando quests via API...', index + 1, list.length, {
          methodLabel: 'Novo (API JSON)',
          apiResolved: resolvedCount,
          apiFallbackPending: unresolved.length,
        }));

        if (index < list.length - 1) await page.waitForTimeout(currentApiGapMs());
      }

      diag('details-v2', 'Passada JSON concluída.', {
        total: list.length,
        resolvidosPelaApi: resolvedCount,
        paraFallback: unresolved.length,
        motivos: failureReasons,
        statusHttpPorMotivo: failureStatuses,
        amostrasDeResposta: failureSamples,
        intervaloFinalMs: currentApiGapMs(),
        tempoMs: Date.now() - startedAt,
      });

      // ── FALLBACK — método antigo, intacto ─────────────────────────────────
      // Quem a API não resolveu é analisado EXATAMENTE como hoje, incluindo o
      // retry multi-navegador. É o que garante que o método novo nunca produza
      // um resultado pior que o antigo.
      let fallbackResult = null;
      if (unresolved.length > 0 && !stoppedManually) {
        diag('details-v2', 'Delegando ao MÉTODO ANTIGO os personagens que a API não resolveu.', {
          quantidade: unresolved.length,
        });
        fallbackResult = await fetchDetailsWithPlaywright(unresolved, merged, event.sender, browserKey);
        if (fallbackResult?.details) Object.assign(details, fallbackResult.details);
        if (fallbackResult?.stoppedManually) stoppedManually = true;
      }

      // ── Consolidação no MESMO contrato do handler antigo ───────────────────
      const analyzedCount = Object.values(details).filter(detail => detail && !detail.error).length;
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

      const successRate = list.length > 0 ? Math.round((analyzedCount / list.length) * 100) : 0;

      diag('resumo-v2', 'MÉTODO NOVO finalizado.', {
        total: list.length,
        resolvidosPelaApi: resolvedCount,
        resolvidosPeloFallback: Math.max(0, analyzedCount - resolvedCount),
        falhas: failedCount,
        taxaSucesso: `${successRate}%`,
        tempoTotalMs: Date.now() - startedAt,
      });

      return {
        ok: true,
        details,
        // Campos do contrato antigo, preenchidos a partir do fallback quando
        // ele rodou — o renderer exibe "Última Consulta" sem saber a origem.
        primaryBrowser: browserKey,
        retryBrowser: fallbackResult?.retryBrowser || '',
        retryStats: fallbackResult?.retryStats || [],
        retryBrowsers: fallbackResult?.retryBrowsers || [],
        totalRequested: list.length,
        analyzedCount,
        recoveredCount: fallbackResult?.recoveredCount || 0,
        failedCount,
        failedCharacterList,
        sessionExpired: fallbackResult?.sessionExpired === true,
        sessionStatus: fallbackResult?.sessionStatus || 'desconhecida',
        consecutiveFailures: fallbackResult?.consecutiveFailures || 0,
        stoppedManually,
        notAnalyzedCount: Math.max(0, list.length - Object.keys(details).length),
        successRate,
        totalDurationMs: Date.now() - startedAt,
        // ── Telemetria exclusiva do método novo ─────────────────────────────
        methodUsed: 'novo',
        apiResolvedCount: resolvedCount,
        apiFallbackCount: unresolved.length,
        apiFailureReasons: failureReasons,
      };
    });
  });

  diag('context', 'Método NOVO do Bazaar registrado (canal rubinot-bazaar-details-v2).', {
    endpoint: `${apiBase}/{ID}`,
  });
}

module.exports = {
  registerBazaarNewMethod,
  // Exportados para os testes — funções puras, sem efeito colateral.
  normalizeBossName,
  walkJson,
  collectBossMentions,
  findBosstiaryContainers,
  collectStorageEntries,
  summarizeJsonShape,
  deriveQuestsFromApiPayload,
  buildAuctionApiUrl,
  NEW_SOUL_WAR_BOSSES,
  NEW_SANGUINE_BOSSES,
};
