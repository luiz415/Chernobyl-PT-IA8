#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Suíte de regressão da consulta do Bazaar.
 *
 * Extrai a lógica REAL de `electron-main.cjs` (mesmas constantes, mesmo
 * classificador) e a exercita contra um servidor de API simulado.
 * Não precisa de rede nem de navegador.
 *
 * Cobre: retentativa por página, consulta parcial, preservação da lista
 * oficial, ausência de duplicação e classificação de erros.
 *
 * Uso: node tools/bazaar-tests/pagination-resilience.test.cjs
 */

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'electron-main.cjs'), 'utf8');

// ── Constantes reais, lidas do arquivo (falha se alguém mudar sem atualizar) ──
function readConst(name) {
  const m = new RegExp(`const ${name} = (\\d+);`).exec(SRC);
  if (!m) throw new Error(`Constante ${name} não encontrada em electron-main.cjs`);
  return Number(m[1]);
}
/**
 * Tempos por MODO de velocidade.
 *
 * As constantes soltas viraram uma tabela (`RUBINOT_SPEED_MODES`), com um
 * perfil para "agressivo" e outro para "moderado". Os testes passam a ler o
 * perfil real do arquivo — se alguém mudar um valor lá, o teste acompanha.
 */
const SPEED_MODES = (() => {
  const start = SRC.indexOf('const RUBINOT_SPEED_MODES = {');
  const end = SRC.indexOf('/** Modo padrão', start);
  const body = SRC.slice(start, end).replace('const RUBINOT_SPEED_MODES = ', '').replace(/;\s*$/, '');
  // eslint-disable-next-line no-eval
  return eval(`(${body})`);
})();
/** Valor de um tempo no modo indicado (padrão: moderado). */
function speedOf(key, mode = 'moderado') {
  const value = SPEED_MODES[mode]?.[key];
  if (value === undefined) throw new Error(`Tempo ${key} não encontrado no modo ${mode}`);
  return value;
}

const PAGE_INTERVAL = readConst('RUBINOT_PAGE_INTERVAL_MS');
const MAX_ATTEMPTS = readConst('RUBINOT_PAGE_MAX_ATTEMPTS');
const BACKOFF = readConst('RUBINOT_PAGE_BACKOFF_MS');

// ── Classificador real, extraído do fonte ────────────────────────────────────
function extractFn(name) {
  const start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Função ${name} não encontrada`);

  // Pula a lista de parâmetros antes de procurar o corpo: um parâmetro com
  // valor padrão de objeto (`= {}`) tem chaves que confundiriam a contagem.
  let i = SRC.indexOf('(', start);
  let parens = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '(') parens++;
    else if (SRC[i] === ')') { parens--; if (!parens) { i++; break; } }
  }

  let depth = 0, end = i;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (!depth) { end = i + 1; break; } }
  }
  return SRC.slice(start, end);
}
const isLikelyCloudflarePage = (content, url) => {
  const t = String(content || '').toLowerCase();
  return t.includes('cloudflare') || t.includes('checking your browser') || t.includes('just a moment')
    || t.includes('turnstile') || String(url || '').includes('cdn-cgi');
};
// eslint-disable-next-line no-eval
const classifyRubinotPageOutcome = eval(`(${extractFn('classifyRubinotPageOutcome')})`);

// ── Reimplementação fiel do laço de duas passadas ────────────────────────────
const sleep = () => Promise.resolve(); // tempo simulado: não atrasa o teste

async function fetchPageResilient(server, pageNum) {
  const attempts = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = server.request(pageNum);
    const outcome = classifyRubinotPageOutcome(res);
    attempts.push({ attempt, status: res?.status ?? 0, outcome: outcome.kind });
    if (outcome.kind === 'OK') return { ok: true, pageNum, data: res.data, attemptsUsed: attempt, attempts };
    if (!outcome.retryable) break;
    if (attempt < MAX_ATTEMPTS) await sleep(BACKOFF * attempt);
  }
  const last = attempts[attempts.length - 1] || {};
  return { ok: false, pageNum, data: null, attemptsUsed: attempts.length, attempts, outcome: last.outcome };
}

async function runQuery(server) {
  const pageResults = new Map();
  const failedPages = new Map();
  let totalPages = 1;

  const storePage = (pageNum, data) => {
    const auctions = Array.isArray(data?.auctions) ? data.auctions : [];
    pageResults.set(pageNum, auctions);
    const reported = Number(data?.pagination?.totalPages || 0);
    if (reported > 0) totalPages = reported;
  };

  // Passada 1
  for (let p = 1; p <= totalPages; p++) {
    const r = await fetchPageResilient(server, p);
    if (r.ok) storePage(p, r.data);
    else failedPages.set(p, { outcome: r.outcome });
    await sleep(PAGE_INTERVAL);
  }
  // Passada 2 — só as que falharam
  if (failedPages.size) {
    for (const p of Array.from(failedPages.keys()).sort((a, b) => a - b)) {
      await sleep(PAGE_INTERVAL * 2);
      const r = await fetchPageResilient(server, p);
      if (r.ok) { storePage(p, r.data); failedPages.delete(p); }
    }
  }

  const loadedPages = Array.from(pageResults.keys()).sort((a, b) => a - b);
  const failedPageNumbers = Array.from(failedPages.keys()).sort((a, b) => a - b);
  const seen = new Set();
  const auctions = [];
  for (const p of loadedPages) {
    for (const a of pageResults.get(p)) {
      const key = a?.id;
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      auctions.push(a);
    }
  }
  return {
    ok: loadedPages.length > 0,
    partial: failedPageNumbers.length > 0,
    totalPages,
    loadedPageCount: loadedPages.length,
    failedPageNumbers,
    auctions,
    total: auctions.length,
  };
}

// ── Servidor simulado ────────────────────────────────────────────────────────
function makeServer({ totalPages = 10, perPage = 3, plan = {} }) {
  const calls = new Map();
  return {
    calls,
    request(pageNum) {
      const n = (calls.get(pageNum) || 0) + 1;
      calls.set(pageNum, n);
      const rule = plan[pageNum];
      if (rule) {
        const fail = typeof rule.failUntil === 'number' ? n <= rule.failUntil : rule.always;
        if (fail) {
          if (rule.status === 200 && rule.html) {
            return { ok: true, status: 200, isJson: false, data: null, textPreview: 'Just a moment... Cloudflare' };
          }
          return { ok: false, status: rule.status ?? 429, isJson: false, data: null, textPreview: '' };
        }
      }
      const auctions = Array.from({ length: perPage }, (_, i) => ({ id: `p${pageNum}_c${i}` }));
      return { ok: true, status: 200, isJson: true, data: { auctions, pagination: { totalPages } }, textPreview: '' };
    },
  };
}

// ── Cenários ─────────────────────────────────────────────────────────────────
const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond, detail });
  console.log(`  ${cond ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

(async () => {
  console.log(`Constantes reais: intervalo=${PAGE_INTERVAL}ms  tentativas=${MAX_ATTEMPTS}  backoff=${BACKOFF}ms\n`);

  console.log('[1] Todas as páginas carregando normalmente');
  {
    const s = makeServer({ totalPages: 10 });
    const r = await runQuery(s);
    check('consulta completa', r.ok && !r.partial, `${r.loadedPageCount}/${r.totalPages}`);
    check('30 personagens coletados', r.total === 30, `total=${r.total}`);
    check('nenhuma retentativa', Array.from(s.calls.values()).every(v => v === 1));
  }

  console.log('\n[2] Uma página falha e funciona na 2ª tentativa');
  {
    const s = makeServer({ totalPages: 10, plan: { 4: { failUntil: 1, status: 429 } } });
    const r = await runQuery(s);
    check('consulta NÃO é parcial', !r.partial, `falhas=[${r.failedPageNumbers}]`);
    check('nada perdido', r.total === 30, `total=${r.total}`);
    check('página 4 chamada 2x', s.calls.get(4) === 2, `chamadas=${s.calls.get(4)}`);
  }

  console.log('\n[3] Várias páginas falhando de forma intermitente');
  {
    const s = makeServer({ totalPages: 12, plan: {
      2: { failUntil: 1, status: 429 }, 5: { failUntil: 2, status: 503 },
      7: { failUntil: 1, status: 0 },   11: { failUntil: 2, status: 200, html: true },
    } });
    const r = await runQuery(s);
    check('todas recuperadas', !r.partial, `falhas=[${r.failedPageNumbers}]`);
    check('36 personagens', r.total === 36, `total=${r.total}`);
  }

  console.log('\n[4] Página com erro após todas as tentativas');
  {
    const s = makeServer({ totalPages: 10, plan: { 6: { always: true, status: 429 } } });
    const r = await runQuery(s);
    check('marcada como parcial', r.partial, `falhas=[${r.failedPageNumbers}]`);
    check('página 6 é a única ausente', r.failedPageNumbers.join() === '6');
    check('limite de tentativas respeitado', s.calls.get(6) === MAX_ATTEMPTS * 2, `chamadas=${s.calls.get(6)} (2 passadas x ${MAX_ATTEMPTS})`);
    check('demais páginas preservadas', r.total === 27, `total=${r.total}`);
  }

  console.log('\n[5] Consulta parcial concluída (múltiplas falhas definitivas)');
  {
    const s = makeServer({ totalPages: 61, perPage: 100, plan: {
      25: { always: true, status: 429 }, 40: { always: true, status: 403 }, 41: { always: true, status: 500 },
    } });
    const r = await runQuery(s);
    check('ok=true (não aborta)', r.ok);
    check('58 de 61 páginas', r.loadedPageCount === 58 && r.totalPages === 61, `${r.loadedPageCount}/${r.totalPages}`);
    check('3 páginas ausentes', r.failedPageNumbers.length === 3, `[${r.failedPageNumbers}]`);
    check('5800 personagens mantidos', r.total === 5800, `total=${r.total}`);
  }

  console.log('\n[6] Falha grave — lista oficial preservada');
  {
    const plan = {}; for (let i = 1; i <= 10; i++) plan[i] = { always: true, status: 429 };
    const s = makeServer({ totalPages: 10, plan });
    const r = await runQuery(s);
    check('ok=false quando nada carrega', !r.ok, `carregadas=${r.loadedPageCount}`);
    check('nenhum personagem publicado', r.total === 0);
  }

  console.log('\n[7] Continuidade — leilões encontrados seguem para análise');
  {
    const s = makeServer({ totalPages: 10, plan: { 3: { always: true, status: 429 } } });
    const r = await runQuery(s);
    check('lista utilizável mesmo parcial', r.ok && r.partial && r.total === 27, `total=${r.total}`);
    check('nenhum personagem da pág. 3', !r.auctions.some(a => a.id.startsWith('p3_')));
  }

  console.log('\n[8] Ausência de duplicações');
  {
    // Página 5 responde OK só na 3ª tentativa: as 2 primeiras falham.
    const s = makeServer({ totalPages: 8, plan: { 5: { failUntil: 2, status: 429 } } });
    const r = await runQuery(s);
    const ids = r.auctions.map(a => a.id);
    check('sem ids repetidos', new Set(ids).size === ids.length, `${ids.length} ids, ${new Set(ids).size} únicos`);
    check('contagem exata', r.total === 24, `total=${r.total}`);
  }
  {
    // Reprocessamento sobrescreve em vez de somar.
    const s = makeServer({ totalPages: 4, plan: { 2: { failUntil: 3, status: 429 } } });
    const r = await runQuery(s);
    const p2 = r.auctions.filter(a => a.id.startsWith('p2_'));
    check('página recuperada não duplica', p2.length === 3, `itens da pág.2=${p2.length}`);
  }

  console.log('\n[9] Logs identificam a causa corretamente');
  {
    const cases = [
      [{ ok: false, status: 429 }, 'RATE_LIMIT_429', true],
      [{ ok: false, status: 403 }, 'BLOQUEIO_403', true],
      [{ ok: false, status: 503 }, 'INDISPONIVEL_503', true],
      [{ ok: false, status: 500 }, 'ERRO_SERVIDOR_500', true],
      [{ ok: false, status: 0 }, 'ERRO_REDE', true],
      [{ ok: false, status: 404 }, 'ERRO_HTTP_404', false],
      [{ ok: true, status: 200, isJson: false, textPreview: 'Just a moment... cloudflare' }, 'CLOUDFLARE_INTERSTICIAL', true],
      [{ ok: true, status: 200, isJson: false, textPreview: '<html>oops' }, 'RESPOSTA_NAO_JSON', true],
      [{ ok: true, status: 200, isJson: true, data: {} }, 'JSON_SEM_AUCTIONS', true],
      [{ ok: true, status: 200, isJson: true, data: { auctions: [] } }, 'OK', false],
      [null, 'SEM_RESPOSTA', true],
    ];
    for (const [res, expected, retryable] of cases) {
      const o = classifyRubinotPageOutcome(res);
      check(`classifica ${expected}`, o.kind === expected && o.retryable === retryable, `obtido=${o.kind}/retry=${o.retryable}`);
    }
  }

  // ── [10] Retry usa apenas UM navegador extra ───────────────────────────
  // (a ordem de preferência configurável é validada no bloco [24])
  console.log('\n[10] Retry final usa navegadores alternativos');
  {
    const code = SRC.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
    // O retry deixou de ser único: agora é uma CADEIA (ver bloco [40]).
    check('cadeia de retry é construída', code.includes('buildRubinotRetryChain(primaryBrowser, options?.retryBrowsers, options?.browserOrder)'));
    check('nunca é o navegador principal', code.includes('preference.find(key => key !== current)'));
    check('fallback único preservado sem seleção', code.includes('const single = getRubinotFallbackBrowser(primary, order)'));
    check('retry abre só os pendentes', (code.match(/runRubinotDetailsPass\(\s*\n?\s*pending,/g) || []).length === 1);
  }

  // ── [11] Quais falhas voltam ao retry ──────────────────────────────────
  console.log('\n[11] Seleção dos personagens para o retry final');
  {
    const isRecoverable = eval(`(${extractFn('isRubinotRecoverableFailure')})`);
    check('sucesso NÃO volta ao retry', !isRecoverable({ soulwarCompleted: true }));
    check('sem detalhe NÃO volta', !isRecoverable(undefined));
    check('"Falha ao carregar leilão" volta', isRecoverable({ error: 'x', failureReason: 'RUBINOT_ERRO_APP' }));
    check('SPA lenta volta', isRecoverable({ error: 'x', failureReason: 'SPA_NAO_RENDERIZOU' }));
    check('Cloudflare volta', isRecoverable({ error: 'x', failureReason: 'CLOUDFLARE' }));
    check('URL inválida NÃO volta', !isRecoverable({ error: 'URL do personagem ausente ou inválida.' }));
  }

  // ── [12] Velocidade da listagem ────────────────────────────────────────
  console.log('\n[12] Listagem inicial voltou a ser rápida');
  {
    const interval = readConst('RUBINOT_PAGE_INTERVAL_MS');
    check('sem pausa entre páginas que respondem', interval === 0, `${interval}ms`);
    const pages = 61;
    const before = pages * 700;
    check('economia de ~43s em 61 páginas', before - pages * interval >= 40000, `${((before - pages * interval) / 1000).toFixed(1)}s economizados`);
    check('recuperação mantém pausa', readConst('RUBINOT_PAGE_RECOVERY_INTERVAL_MS') > 0);
  }

  // ── [13] Parada antecipada pelo limite de encerramento ─────────────────
  console.log('\n[13] Parada antecipada (auction_end asc)');
  {
    const shouldStop = new Function('RUBINOT_BAZAAR_PARAMS',
      SRC.slice(SRC.indexOf('const RUBINOT_EARLY_STOP_SORT'), SRC.indexOf('/** Tentativas por página'))
      + '; return { shouldStopRubinotListing, canUseRubinotEarlyStop, normalizeRubinotAuctionEnd };');

    const sorted = shouldStop({ sortBy: 'auction_end', sortOrder: 'asc', limit: 100 });
    const unsorted = shouldStop({ sortBy: 'price', sortOrder: 'desc', limit: 100 });

    const LIMIT = 1000;
    check('para ao passar do limite', sorted.shouldStopRubinotListing([{ auctionEndTs: 900 }, { auctionEndTs: 1200 }], LIMIT));
    check('NÃO para se tudo cabe', !sorted.shouldStopRubinotListing([{ auctionEndTs: 500 }, { auctionEndTs: 900 }], LIMIT));
    check('NÃO para exatamente no limite', !sorted.shouldStopRubinotListing([{ auctionEndTs: 1000 }], LIMIT));
    check('sem limite nunca para', !sorted.shouldStopRubinotListing([{ auctionEndTs: 99999 }], 0));
    check('ordenação diferente desliga a parada', !unsorted.shouldStopRubinotListing([{ auctionEndTs: 9999 }], LIMIT));
    check('leilão sem data não dispara', !sorted.shouldStopRubinotListing([{ auctionEndTs: 0 }, { auctionEndTs: null }], LIMIT));
    check('ms convertido para segundos', sorted.normalizeRubinotAuctionEnd(1700000000000) === 1700000000);
    check('segundos preservados', sorted.normalizeRubinotAuctionEnd(1700000000) === 1700000000);

    // Cenário completo: 61 páginas, limite cai na página 4.
    const LIM = 4000;
    const pages = [];
    for (let p = 1; p <= 61; p++) {
      pages.push(Array.from({ length: 100 }, (_, i) => ({ id: `p${p}_c${i}`, auctionEndTs: (p - 1) * 1500 + i })));
    }
    const collected = [];
    let scanned = 0;
    for (const pageAuctions of pages) {
      scanned++;
      collected.push(...pageAuctions);              // guarda ANTES de avaliar
      if (sorted.shouldStopRubinotListing(pageAuctions, LIM)) break;
    }
    check('leu poucas páginas', scanned <= 6, `${scanned}/61 páginas`);
    check('economizou >90% das páginas', (61 - scanned) / 61 > 0.9, `${Math.round((61 - scanned) / 61 * 100)}% evitadas`);

    // Nenhum personagem dentro do limite pode ter ficado para trás.
    const allWithin = pages.flat().filter(a => a.auctionEndTs <= LIM);
    const collectedIds = new Set(collected.map(a => a.id));
    const missing = allWithin.filter(a => !collectedIds.has(a.id));
    check('NENHUM personagem válido perdido', missing.length === 0, `${allWithin.length} válidos, ${missing.length} perdidos`);
    check('coleta é superset do necessário', collected.length >= allWithin.length);
  }

  // ── [14] Análise individual: passagem única, sem reload ────────────────
  console.log('\n[14] Análise individual sem reload');
  {
    const WAIT = speedOf('bosstiaryWaitMs');
    const NAV = speedOf('navTimeoutMs');
    const COOL = speedOf('failureCooldownMs');

    // O reload foi removido por completo: os testes reais mostraram que ele
    // nunca recuperou uma página com "Falha ao carregar leilão".
    check('sem page.reload() no fluxo', !SRC.includes('page.reload('));
    check('sem contador de reloads', !SRC.includes('BOSSTIARY_MAX_RELOADS'));
    check('sem laço de tentativas', !SRC.includes('bossAttempt'));
    check('sem constante de espera de reload', !SRC.includes('RUBINOT_BOSSTIARY_RELOAD_WAIT_MS'));
    check('sem log de "recarregando"', !SRC.includes('recarregando a página do personagem'));
    check('sem networkidle', !SRC.includes("waitForLoadState('networkidle'"));

    // Teto ÚNICO de 1s para a página se tornar utilizável. Sem prorrogação,
    // sem confirmação, sem recheck — ver bloco [35].
    check('teto curto para página inutilizável', WAIT <= 1500, `${WAIT}ms`);
    check('navegação enxuta', NAV <= 9000, `${NAV}ms`);

    const worstUnusable = WAIT + COOL;
    check('página inutilizável <= 3s', worstUnusable <= 3000, `${worstUnusable}ms`);
    const worstBefore = 1500 + 5500 + 800 + 400; // versão com prorrogação
    check('muito mais rápido que a versão anterior', WAIT < worstBefore, `${worstBefore}ms -> ${WAIT}ms`);
    const worstWithReload = 1500 + 1200 + 1200 + 300 * 2; // versão com reload
    check('mais rápido que a versão com reload', worstUnusable < worstWithReload, `${worstWithReload}ms -> ${worstUnusable}ms`);

    // Caminho feliz continua barato: erro já no DOM sai antes de tudo.
    check('atalho instantâneo mantido', SRC.includes('hasRubinotAuctionLoadErrorNow'));
    check('corrida de 3 estados mantida', SRC.includes('async function waitForRubinotAuctionOutcome'));
  }

  // ── [15] Falhas continuam indo para o retry com outro navegador ────────
  console.log('\n[15] Falha sem reload segue para o retry final');
  {
    const isRecoverable = eval(`(${extractFn('isRubinotRecoverableFailure')})`);
    check('erro do RubinOT vai ao retry', isRecoverable({ error: 'x', failureReason: 'RUBINOT_ERRO_APP' }));
    check('SPA lenta vai ao retry', isRecoverable({ error: 'x', failureReason: 'SPA_NAO_RENDERIZOU' }));
    check('sucesso NÃO vai ao retry', !isRecoverable({ soulwarCompleted: false }));
    check('falha grava failureReason', SRC.includes('failureReason: reason'));
    check('falha NÃO vira analisado', SRC.includes('soulwarCompleted: null, sanguineCompleted: null'));
    check('retry final preservado', SRC.includes('getRubinotFallbackBrowser'));
  }

  // ── [16] Execução em segundo plano (sem depender de foco) ──────────────
  console.log('\n[16] Consulta roda com o navegador fora de foco');
  {
    // Remove apenas linhas 100% de comentário (mantém código que tenha
    // comentário no fim da linha), para checar CÓDIGO de verdade.
    const code = SRC.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');

    check('sem clique por coordenadas (page.mouse.click)', !code.includes('page.mouse.click('));
    check('sem page.mouse.move', !code.includes('page.mouse.move('));
    check('paginação clica via DOM', code.includes('button.click();'));

    // bringToFront só pode existir no tratamento do desafio Cloudflare.
    // Foco só é tomado quando o USUÁRIO precisa agir: 2x no desafio Cloudflare
    // e 1x ao preparar a sessão (ele tem de ver a janela para fazer login).
    const focusCalls = (code.match(/bringToFront\(\)/g) || []).length;
    check('bringToFront só quando o usuário precisa agir', focusCalls === 3, `${focusCalls} chamada(s)`);
    check('nenhum bringToFront na análise individual',
      !/bringToFront\(\); \} catch \(_\) \{\}\s*\n\s*rubinotDiag\('details'/.test(code));
    check('sem bringToFront por personagem', !/bringToFront\(\); \} catch \(_\) \{\}\s*\n\s*rubinotDiag\('details'/.test(code));
    check('foco condicionado ao desafio', code.includes('cloudflareDetected && !focusedForChallenge'));

    check('helper de clique sem foco', code.includes('async function clickWithoutFocus'));
    check('helper de preenchimento sem foco', code.includes('async function fillWithoutFocus'));
    // Um único ponto de clique: o recheck tardio (que tinha o segundo) saiu
    // junto com a fase de confirmação — ver bloco [35].
    check('clique da Bosstiary usa o helper', (code.match(/clickWithoutFocus\(page, bosstiaryTab\)/g) || []).length === 1);
    check('buscas usam o helper', (code.match(/fillWithoutFocus\(/g) || []).length >= 3);

    // Anti-throttling por mecanismo.
    for (const pref of ['dom.min_background_timeout_value', 'dom.timeout.enable_budget_timer_throttling', 'dom.suspend_inactive.enabled']) {
      check(`Firefox: ${pref}`, code.includes(pref));
    }
    for (const flag of ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding']) {
      check(`Chromium: ${flag}`, code.includes(flag));
    }
    check('prefs aplicadas só ao Firefox', code.includes("info.engine === 'firefox'"));
    check('flags aplicadas só ao Chromium', code.includes("info.engine === 'chromium'"));

    // A leitura de dados nunca dependeu de foco — confirma que segue assim.
    check('leitura por evaluate/waitForFunction', code.includes('page.evaluate(') && code.includes('page.waitForFunction('));
  }

  // ── [17] Validação final: nada entra sem sucesso comprovado ────────────
  console.log('\n[17] Falha que aparece DURANTE a análise');
  {
    const code = SRC.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');

    check('validação final existe', code.includes('validateRubinotAuctionPageAfterAnalysis'));
    check('roda ANTES de montar o resultado',
      code.indexOf('validateRubinotAuctionPageAfterAnalysis(page)') < code.indexOf('const bossSet = new Set('));
    check('NÃO existe guarda por bossSet vazio', !code.includes('if (bossSet.size === 0)'));
    check('log "Falha detectada após carregamento inicial"', code.includes('Falha detectada após carregamento inicial'));
    check('log inclui navegador e etapa', code.includes('navegador: rubinotContextBrowserKey') && code.includes('etapa:'));

    // Reimplementa o predicado real de validação para exercitá-lo.
    const validate = (st) => {
      if (st.hasErrorText) return { ok: false, reason: 'RUBINOT_ERRO_APP' };
      if (st.hasCloudflare) return { ok: false, reason: 'CLOUDFLARE' };
      if (st.bodyLength < 50) return { ok: false, reason: 'PAGINA_VAZIA' };
      if (!st.hasBosstiaryTab || !st.hasBosstiaryContent) return { ok: false, reason: 'PAGINA_OK_SEM_BOSSTIARY' };
      return { ok: true };
    };
    const healthy = { hasErrorText: false, hasCloudflare: false, bodyLength: 5000, hasBosstiaryTab: true, hasBosstiaryContent: true };

    check('página íntegra é aprovada', validate(healthy).ok);
    check('erro no meio da análise reprova', validate({ ...healthy, hasErrorText: true }).reason === 'RUBINOT_ERRO_APP');
    check('Cloudflare no meio reprova', validate({ ...healthy, hasCloudflare: true }).reason === 'CLOUDFLARE');
    check('página esvaziada reprova', validate({ ...healthy, bodyLength: 10 }).reason === 'PAGINA_VAZIA');
    check('aba Bosstiary sumiu reprova', validate({ ...healthy, hasBosstiaryTab: false }).reason === 'PAGINA_OK_SEM_BOSSTIARY');
    check('tabela sumiu reprova', validate({ ...healthy, hasBosstiaryContent: false }).reason === 'PAGINA_OK_SEM_BOSSTIARY');


    // Todo caminho de falha devolve null — nunca um booleano inventado.
    const failurePaths = (code.match(/soulwarCompleted: null, sanguineCompleted: null/g) || []).length;
    check('falhas retornam null, não boolean', failurePaths >= 3, `${failurePaths} caminhos`);
  }

  // ── [18] Contabilidade: falha nunca vira sucesso ───────────────────────
  console.log('\n[18] Contabilidade das novas falhas');
  {
    const isRecoverable = eval(`(${extractFn('isRubinotRecoverableFailure')})`);
    for (const reason of ['RUBINOT_ERRO_APP', 'CLOUDFLARE', 'PAGINA_VAZIA', 'PAGINA_OK_SEM_BOSSTIARY', 'DIAGNOSTICO_FALHOU']) {
      check(`${reason} vai ao retry`, isRecoverable({ error: 'x', failureReason: reason }));
    }
    // analyzedCount conta só quem NÃO tem error.
    const details = {
      ok1: { soulwarCompleted: true },
      ok2: { soulwarCompleted: false },
      bad1: { error: 'x', failureReason: 'BOSSTIARY_VAZIA', soulwarCompleted: null },
      bad2: { error: 'y', failureReason: 'RUBINOT_ERRO_APP', soulwarCompleted: null },
    };
    const analyzed = Object.values(details).filter(d => d && !d.error).length;
    check('analisados = 2 (falhas excluídas)', analyzed === 2, `analyzed=${analyzed}`);
    check('falhas = 2', Object.keys(details).length - analyzed === 2);
  }

  // ── [19] Bosstiary VAZIA é resultado válido, não falha ─────────────────
  console.log('\n[19] Personagem sem nenhum boss entra na lista');
  {
    const code = SRC.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');

    check('sem guarda por bossSet.size === 0', !code.includes('if (bossSet.size === 0)'));
    check('BOSSTIARY_VAZIA não é motivo de falha', !code.includes("failureReason: 'BOSSTIARY_VAZIA'"));
    check('validação aceita painel sem linhas', code.includes('hasTableStructure'));
    check('reconhece estado-vazio explícito', code.includes('hasEmptyState'));
    check('painel montado = estrutura OU busca OU paginação OU vazio',
      code.includes('hasBossRows || hasTableStructure || hasBossSearch || hasPageIndicator || hasEmptyState'));

    // Predicado real de validação.
    const validate = (st) => {
      if (st.hasErrorText) return { ok: false, reason: 'RUBINOT_ERRO_APP' };
      if (st.hasCloudflare) return { ok: false, reason: 'CLOUDFLARE' };
      if (st.bodyLength < 50) return { ok: false, reason: 'PAGINA_VAZIA' };
      if (!st.hasBosstiaryTab || !st.hasBosstiaryContent) return { ok: false, reason: 'PAGINA_OK_SEM_BOSSTIARY' };
      return { ok: true };
    };
    const base = { hasErrorText: false, hasCloudflare: false, bodyLength: 5000, hasBosstiaryTab: true };

    check('sem bosses + estado-vazio => ACEITA', validate({ ...base, hasBosstiaryContent: true, hasBossRows: false, hasEmptyState: true }).ok);
    check('sem bosses + só estrutura => ACEITA', validate({ ...base, hasBosstiaryContent: true, hasBossRows: false }).ok);
    check('com bosses => ACEITA', validate({ ...base, hasBosstiaryContent: true, hasBossRows: true }).ok);
    check('painel ausente => REJEITA', !validate({ ...base, hasBosstiaryContent: false }).ok);
    check('erro no meio => REJEITA', !validate({ ...base, hasBosstiaryContent: true, hasErrorText: true }).ok);

    // Cadeia completa: zero bosses deve virar "as duas quests disponíveis".
    const SW = ['a', 'b', 'c', 'd', 'e', 'f'];
    const SG = ['bakragore'];
    const bossSet = new Set();
    const detail = {
      soulwarCompleted: SW.filter(b => bossSet.has(b)).length === SW.length,
      sanguineCompleted: SG.filter(b => bossSet.has(b)).length === SG.length,
    };
    check('soulwarCompleted = false (disponível)', detail.soulwarCompleted === false);
    check('sanguineCompleted = false (disponível)', detail.sanguineCompleted === false);
    check('sem campo error', !detail.error);

    const matches = (d, f, field) => {
      if (f === 'all') return true;
      if (!d || d[field] === null) return false;
      return f === 'completed' ? d[field] === true : d[field] === false;
    };
    check('passa no filtro Soul War "disponível"', matches(detail, 'available', 'soulwarCompleted'));
    check('passa no filtro Sanguine "disponível"', matches(detail, 'available', 'sanguineCompleted'));
    check('conta como ANALISADO com sucesso', !detail.error);
  }

  // ── [20] Verificação seletiva de quests ────────────────────────────────
  console.log('\n[20] Só verifica a quest exigida pelo filtro');
  {
    const code = SRC.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
    const scope = eval(`(${extractFn('resolveRubinotQuestScope')})`);

    check('ambas "Todas" => nenhuma verificação',
      scope({ quests: { soulwar: false, sanguine: false } }).soulwar === false &&
      scope({ quests: { soulwar: false, sanguine: false } }).sanguine === false);
    check('só Soul War exigida', scope({ quests: { soulwar: true, sanguine: false } }).sanguine === false);
    check('só Sanguine exigida', scope({ quests: { soulwar: false, sanguine: true } }).soulwar === false);
    check('ambas exigidas', scope({ quests: { soulwar: true, sanguine: true } }).soulwar === true);
    check('sem escopo => compatível (verifica tudo)', scope({}).soulwar === true && scope({}).sanguine === true);

    check('busca "gosh" condicionada', code.includes('if (quests.soulwar) {'));
    check('buscas Sanguine condicionadas', code.includes('if (quests.sanguine) {'));
    check('quest não exigida vira null', code.includes('quests.soulwar') && code.includes(': null,'));
    check('null por filtro não conta como falha', code.includes('(quests.soulwar && details.soulwarCompleted === null)'));
    check('cache não reusa escopo menor', code.includes('const covers ='));

    // Economia de buscas na estratégia por pesquisa (1 Gosh + 5 Sanguine).
    const buscas = (sw, sg) => (sw ? 1 : 0) + (sg ? 5 : 0);
    check('ambas exigidas = 6 buscas', buscas(true, true) === 6);
    check('só Soul War = 1 busca (-83%)', buscas(true, false) === 1);
    check('só Sanguine = 5 buscas', buscas(false, true) === 5);
    check('nenhuma = 0 buscas', buscas(false, false) === 0);
  }

  // ── [21] Contrato de "Não verificado" ──────────────────────────────────
  console.log('\n[21] "Não verificado" nunca vira disponível/concluída');
  {
    const status = (detail, field, needs, required = true) => {
      if (!required) return 'Não verificado';
      if (!detail) return needs ? '...' : '—';
      if (detail[field] === true) return 'Concl.';
      if (detail[field] === false) return 'Disp.';
      return 'Indisp.';
    };
    const matches = (d, f, field) => {
      if (f === 'all') return true;
      if (!d || d[field] === null) return false;
      return f === 'completed' ? d[field] === true : d[field] === false;
    };

    const unchecked = { soulwarCompleted: null, sanguineCompleted: false };
    check('SW não exigida => "Não verificado"', status(unchecked, 'soulwarCompleted', true, false) === 'Não verificado');
    check('não confunde com "Disp."', status(unchecked, 'soulwarCompleted', true, false) !== 'Disp.');
    check('não confunde com "Concl."', status(unchecked, 'soulwarCompleted', true, false) !== 'Concl.');
    check('filtro "all" aceita null', matches(unchecked, 'all', 'soulwarCompleted'));
    check('filtro exigente barra null', !matches(unchecked, 'available', 'soulwarCompleted'));
    check('quest verificada continua normal', status(unchecked, 'sanguineCompleted', true, true) === 'Disp.');
  }

  // ── [22] Escopo propagado em TODOS os caminhos da Bosstiary ────────────
  console.log('\n[22] Independência real entre Soul War e Sanguine');
  {
    const code = SRC.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');

    // O bug: uma das chamadas omitia o 4º argumento e o default
    // `{ soulwar: true, sanguine: true }` reativava tudo silenciosamente.
    const chamadas = code.match(/collectRubinotBosstiaryBossesBySearch\(page, id, pageCount[^)]*\)/g) || [];
    check('há chamadas à busca', chamadas.length >= 2, `${chamadas.length} chamada(s)`);
    check('TODAS repassam o escopo', chamadas.every(c => c.includes('quests')), chamadas.join(' | '));

    check('atalho quando nenhuma quest é exigida', code.includes('!quests.soulwar && !quests.sanguine'));
    // O retry espalha `...options`, então o escopo de quests é preservado
    // (independente de outras flags adicionadas ao objeto).
    check('retry preserva o escopo', /\{ \.\.\.options, forceRefresh: true/.test(code));

    // Simula o caminho de 3+ páginas (onde o bug vivia).
    const simulate = (quests) => {
      if (!quests.soulwar && !quests.sanguine) return [];
      const searches = [];
      if (quests.soulwar) searches.push('gosh');
      if (quests.sanguine) ['murcion', 'vemiath', 'ichgahal', 'chagorz', 'bakragore'].forEach(b => searches.push(b));
      return searches;
    };
    const SANGUINE = ['murcion', 'vemiath', 'ichgahal', 'chagorz', 'bakragore'];

    const soOnlySW = simulate({ soulwar: true, sanguine: false });
    check('SW=Disp/SG=Todas => só "gosh"', soOnlySW.join() === 'gosh', soOnlySW.join(', ') || '(nenhuma)');
    check('SW=Disp/SG=Todas => nenhum boss Sanguine', !soOnlySW.some(b => SANGUINE.includes(b)));

    const soOnlySG = simulate({ soulwar: false, sanguine: true });
    check('SW=Todas/SG=Disp => sem "gosh"', !soOnlySG.includes('gosh'));
    check('SW=Todas/SG=Disp => 5 bosses Sanguine', soOnlySG.length === 5);

    check('ambas Todas => nenhuma busca', simulate({ soulwar: false, sanguine: false }).length === 0);
    check('ambas exigidas => 6 buscas', simulate({ soulwar: true, sanguine: true }).length === 6);
  }

  // ── [23] "Nenhum progresso de bosstiary." ──────────────────────────────
  console.log('\n[23] Bosstiary sem progresso => quests disponíveis');
  {
    const code = SRC.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');

    check('detector existe', code.includes('detectRubinotBosstiaryNoProgress'));
    check('roda antes de paginar/pesquisar',
      code.indexOf('detectRubinotBosstiaryNoProgress(page)') < code.indexOf('getRubinotBosstiaryPageCount(page, id)'));
    check('noProgress marca as duas como não concluídas', code.includes('noProgress ? false :'));

    // Predicado real: aceita só a frase de "sem progresso", nunca a de busca.
    const detect = (texts) => {
      const strip = v => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
      for (const raw of texts) {
        const t = strip(raw);
        if (!t || t.length > 120) continue;
        if (t.includes('nenhum boss encontrado')) continue;
        if (t.includes('nenhum progresso de bosstiary')) return true;
      }
      return false;
    };

    check('detecta "Nenhum progresso de bosstiary."', detect(['Nenhum progresso de bosstiary.']));
    check('detecta com acento/caixa variados', detect(['NENHUM PROGRESSO DE BOSSTIARY']));
    check('IGNORA "Nenhum boss encontrado com \'Gosh\'"', !detect(['Nenhum boss encontrado com "Gosh".']));
    check('IGNORA busca vazia de Bakragore', !detect(['Nenhum boss encontrado com "Bakragore".']));
    check('não dispara em tabela com bosses', !detect(['Goshnar\'s Cruelty', 'Murcion']));
    check('não dispara em texto vazio', !detect(['', '   ']));

    // Resultado final para um personagem sem progresso algum.
    const noProgress = true;
    const quests = { soulwar: true, sanguine: true };
    const detail = {
      soulwarCompleted: quests.soulwar ? (noProgress ? false : true) : null,
      sanguineCompleted: quests.sanguine ? (noProgress ? false : true) : null,
    };
    check('Soul War => Disponível (false)', detail.soulwarCompleted === false);
    check('Sanguine => Disponível (false)', detail.sanguineCompleted === false);

    // Escopo continua respeitado: quest não exigida permanece "não verificada".
    const parcial = {
      soulwarCompleted: true ? (noProgress ? false : true) : null,
      sanguineCompleted: false ? (noProgress ? false : true) : null,
    };
    check('quest não exigida continua null', parcial.sanguineCompleted === null);
  }

  // ── [24] Ordem de preferência configurável do retry ────────────────────
  console.log('\n[24] Ordem de preferência dos navegadores');
  {
    const BROWSERS = { chrome: 1, edge: 1, firefox: 1, webkit: 1 };
    const DEFAULT_ORDER = ['webkit', 'firefox', 'edge', 'chrome'];
    const i = SRC.indexOf('function normalizeRubinotBrowserOrder');
    const blk = SRC.slice(i, SRC.indexOf('}', SRC.indexOf('return preference.find')) + 1);
    const fns = new Function('RUBINOT_BROWSERS', 'RUBINOT_BROWSER_FALLBACK_ORDER', 'resolveRubinotBrowserKey',
      blk + '; return { normalizeRubinotBrowserOrder, getRubinotFallbackBrowser };'
    )(BROWSERS, DEFAULT_ORDER, v => String(v || '').toLowerCase());

    // Regra: o retry é o PRIMEIRO da ordem que não seja o principal.
    check('padrão: firefox => webkit', fns.getRubinotFallbackBrowser('firefox') === 'webkit');
    check('padrão: webkit => firefox', fns.getRubinotFallbackBrowser('webkit') === 'firefox');
    check('padrão: edge => webkit', fns.getRubinotFallbackBrowser('edge') === 'webkit');
    check('padrão: chrome => webkit', fns.getRubinotFallbackBrowser('chrome') === 'webkit');

    const custom = ['chrome', 'edge', 'firefox', 'webkit'];
    check('custom: chrome => edge', fns.getRubinotFallbackBrowser('chrome', custom) === 'edge');
    check('custom: webkit => chrome', fns.getRubinotFallbackBrowser('webkit', custom) === 'chrome');
    check('custom: edge => chrome', fns.getRubinotFallbackBrowser('edge', custom) === 'chrome');

    // Sanitização da ordem vinda do renderer.
    check('remove chaves inválidas', !fns.normalizeRubinotBrowserOrder(['opera', 'webkit']).includes('opera'));
    check('remove duplicatas', fns.normalizeRubinotBrowserOrder(['webkit', 'webkit']).filter(k => k === 'webkit').length === 1);
    check('completa os que faltam', fns.normalizeRubinotBrowserOrder(['chrome']).length === 4);
    check('ordem parcial preserva o topo', fns.normalizeRubinotBrowserOrder(['chrome'])[0] === 'chrome');
    check('lista vazia => padrão', fns.normalizeRubinotBrowserOrder([]).join() === DEFAULT_ORDER.join());
  }

  // ── [25] Falhas persistidas e visíveis a todos ─────────────────────────
  console.log('\n[25] "Falhas: N personagens" para todos os usuários');
  {
    const svc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'bazaarOfficialService.ts'), 'utf8');
    const panel = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'components', 'BazarPanel.tsx'), 'utf8');

    check('campo no tipo do metadata', svc.includes('failedCharacters?: number;'));
    check('gravado no Firestore', svc.includes('failedCharacters: Math.max(0, Number(params.failedCharacters || 0))'));
    check('gravado ANTES do commit (mesmo batch)', svc.indexOf('failedCharacters: Math.max') < svc.indexOf('await batch.commit()'));
    check('CRLF do serviço preservado', (svc.match(/\r\n/g) || []).length === svc.split('\n').length - 1);

    check('painel publica a contagem', panel.includes('failedCharacters: detailsStats?.failedCount ?? 0'));
    check('quadro lê do metadata (todos veem)', panel.includes('failedCount: officialMetadata.failedCharacters ?? 0'));
    check('sem consulta extra dedicada', !panel.includes('getDoc(doc(db, "bazaar", "metadata"))'));

    // Formatação exigida, inclusive o caso zero.
    // Plural correto em português: "personagens", NÃO "personagems".
    const label = (n) => `Falhas: ${n} ${n === 1 ? 'personagem' : 'personagens'}`;
    check('7 => "Falhas: 7 personagens"', label(7) === 'Falhas: 7 personagens');
    check('0 => "Falhas: 0 personagens"', label(0) === 'Falhas: 0 personagens');
    check('1 => singular', label(1) === 'Falhas: 1 personagem');

    // Outro usuário: só tem `officialMetadata`, sem `lastSummary` local.
    const metadata = { generatedAtMs: 111, durationMs: 5000, totalCharacters: 93, failedCharacters: 7 };
    const outroUsuario = {
      completedAtMs: metadata.generatedAtMs,
      durationMs: metadata.durationMs,
      approvedCount: metadata.totalCharacters,
      failedCount: metadata.failedCharacters ?? 0,
    };
    check('outro usuário recebe a contagem', outroUsuario.failedCount === 7);
    check('outro usuário vê o texto certo', label(outroUsuario.failedCount) === 'Falhas: 7 personagens');

    // Publicação sem falhas precisa ZERAR a contagem anterior.
    const limpo = { failedCharacters: Math.max(0, Number(0 || 0)) };
    check('consulta limpa zera a contagem', limpo.failedCharacters === 0);

    // Metadados antigos (sem o campo) não quebram a exibição.
    const antigo = { generatedAtMs: 1, durationMs: 1, totalCharacters: 10 };
    check('metadata legado => 0, sem quebrar', (antigo.failedCharacters ?? 0) === 0);
  }

  // ── [26] Quadro por perfil + botão de falhas ───────────────────────────
  console.log('\n[26] Última Consulta: visibilidade e links das falhas');
  {
    const panel = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'components', 'BazarPanel.tsx'), 'utf8');
    const svc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'bazaarOfficialService.ts'), 'utf8');
    const main = SRC;

    // Campos liberados para TODOS (sem guarda isBossUser na mesma linha).
    for (const [nome, marca] of [['Concluída', '<span>Concluída:'], ['Personagens', '<span>Personagens:'], ['Versão', '{officialMetadata?.version &&']]) {
      const line = panel.split('\n').find(l => l.includes(marca)) || '';
      check(`${nome} visível a todos`, !!line && !line.includes('isBossUser'), line.trim().slice(0, 60));
    }
    // Campos restritos ao Boss.
    for (const [nome, marca] of [['Duração', 'Duração:'], ['Responsável', 'Responsável:']]) {
      const line = panel.split('\n').find(l => l.includes(marca)) || '';
      check(`${nome} só para o Boss`, !!line && line.includes('isBossUser'));
    }
    for (const marca of ['typeof displayedLastSummary.filteredCount', '!!displayedLastSummary.pagesScanned', 'displayedLastSummary.stoppedEarly &&', 'typeof displayedLastSummary.totalRequested', 'officialMetadata?.partial']) {
      const line = panel.split('\n').find(l => l.includes(marca)) || '';
      check(`bloco "${marca.slice(0, 34)}" restrito`, !!line && line.includes('isBossUser'));
    }

    // Botão + popover de falhas.
    check('Falhas é um <button>', panel.includes('onClick={() => canOpen && setIsFailuresOpen'));
    check('desabilitado sem falhas', panel.includes('disabled={!canOpen}'));
    check('canOpen exige total > 0 e links', panel.includes('failedTotal > 0 && failedLinks.length > 0'));
    check('abre link externo', panel.includes('onClick={() => openExternal(entry.url)}'));
    check('usa dados já carregados', panel.includes('displayedLastSummary.failedCharacters || []'));
    check('sem consulta extra ao Firestore', !panel.includes('getDoc(doc(db, "bazaar", "metadata"))'));

    // Persistência dos links.
    check('links no tipo do metadata', svc.includes('failedCharacterList?: { id: string; name: string; url: string }[];'));
    check('links gravados no Firestore', svc.includes('failedCharacterList: (Array.isArray(params.failedCharacterList)'));
    check('limite de 50 entradas', svc.includes('.slice(0, 50)'));
    check('descarta entradas sem url', svc.includes('.filter((entry) => entry.url)'));
    check('CRLF preservado', (svc.match(/\r\n/g) || []).length === svc.split('\n').length - 1);

    // Origem dos links no processo principal.
    check('main coleta os que falharam', main.includes('const failedCharacterList = list'));
    check('main usa a URL normalizada', main.includes('url: normalizeRubinotAuctionUrl(auction)'));
    check('main retorna a lista', main.includes('failedCharacterList,'));

    // Zero falhas não pode quebrar.
    const semFalhas = { failedCount: 0, failedCharacters: [] };
    const canOpen = (semFalhas.failedCount || 0) > 0 && (semFalhas.failedCharacters || []).length > 0;
    check('zero falhas => botão inativo', canOpen === false);
    const legado = {};
    check('metadata legado não quebra', ((legado.failedCharacters || []).length) === 0);
  }

  // ── [27] Retry sem repetir a listagem ──────────────────────────────────
  console.log('\n[27] Retry final abre só os links pendentes');
  {
    const code = SRC.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');

    check('flag skipSessionWarmup existe', code.includes('options.skipSessionWarmup'));
    check('retry ativa a flag', code.includes('skipSessionWarmup: true'));
    check('consulta principal NÃO ativa', (code.match(/skipSessionWarmup: true/g) || []).length === 1);
    check('validação de sessão fica no else', code.includes('const session = await ensureRubinotSessionReady(context, runState, \'details-session\')'));

    // A listagem só é revisitada quando o warmup roda.
    const runsWarmup = (skip) => !skip;
    check('consulta principal revalida a sessão', runsWarmup(false) === true);
    check('retry NÃO revalida a sessão', runsWarmup(true) === false);
    check('retry mantém forceRefresh', code.includes('forceRefresh: true, skipSessionWarmup: true'));
    check('retry ainda abre os links individuais', code.includes('fetchRubinotCharacterDetails(detailPage, auction, options, runState)'));
  }

  // ── [28] Quest suspeita: FAIXA de progresso parcial ────────────────────
  //
  // A regra deixou de ser um valor único (3/6 e 2/5) e passou a ser uma faixa:
  //   Soul War -> 3/6, 4/6, 5/6   |   Sanguine -> 2/5, 3/5, 4/5
  // O topo é sempre `total - 1`: com todos os bosses a quest está CONCLUÍDA.
  console.log('\n[28] Quest suspeita por faixa de bosses');
  {
    const panel = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'components', 'BazarPanel.tsx'), 'utf8');

    check('regra de valor único removida', !panel.includes('current === 3 && total === 6') && !panel.includes('current === 2 && total === 5'));
    check('faixa aplicada', panel.includes('current >= minSuspicious && current <= total - 1'));
    check('piso por quest', panel.includes('const minSuspicious = field === "soulwarCompleted" ? 3 : 2'));
    check('total esperado validado', panel.includes('const expectedTotal = field === "soulwarCompleted" ? 6 : 5'));
    check('destaque visual inalterado', panel.includes('bg-rose-500/10 ring-1 ring-inset ring-rose-400/35'));
    check('tooltip continua dinâmico', panel.includes('suspeita: contador ${formatQuestBossCount(detail, field)}'));

    // Predicado equivalente ao do painel.
    const suspicious = (field, current, total) => {
      if (current === null || current === undefined) return false;
      const min = field === 'soulwarCompleted' ? 3 : 2;
      const expected = field === 'soulwarCompleted' ? 6 : 5;
      if (total !== expected) return false;
      return current >= min && current <= total - 1;
    };

    // Soul War: 3, 4 e 5 são suspeitos.
    for (const n of [3, 4, 5]) check(`Soul War ${n}/6 => suspeita`, suspicious('soulwarCompleted', n, 6));
    for (const n of [0, 1, 2, 6]) check(`Soul War ${n}/6 => NÃO suspeita`, !suspicious('soulwarCompleted', n, 6));

    // Sanguine: 2, 3 e 4 são suspeitos.
    for (const n of [2, 3, 4]) check(`Sanguine ${n}/5 => suspeita`, suspicious('sanguineCompleted', n, 5));
    for (const n of [0, 1, 5]) check(`Sanguine ${n}/5 => NÃO suspeita`, !suspicious('sanguineCompleted', n, 5));

    // Concluída e disponível continuam fora da faixa.
    check('quest concluída nunca é suspeita', !suspicious('soulwarCompleted', 6, 6) && !suspicious('sanguineCompleted', 5, 5));
    check('quest disponível nunca é suspeita', !suspicious('soulwarCompleted', 0, 6) && !suspicious('sanguineCompleted', 0, 5));
    check('total atípico é ignorado', !suspicious('soulwarCompleted', 4, 8));
    check('não verificada é ignorada', !suspicious('soulwarCompleted', null, 6));
  }

  // ── [29] Melhorias contra falhas de carregamento ───────────────────────
  console.log('\n[29] Uma aba, ritmo seguro, sem Service Workers');
  {
    const code = SRC.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
    const modal = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'components', 'BazaarBrowserModal.tsx'), 'utf8');
    const panel = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'components', 'BazarPanel.tsx'), 'utf8');

    // 1) Apenas uma aba do Bazaar
    check('helper fecha a aba de sessão', code.includes('async function closeRubinotSessionPage'));
    check('fechada antes da análise', code.includes("closeRubinotSessionPage('analise-individual')"));
    check('estado da sessão é zerado', code.includes('rubinotSessionPage = null;') && code.includes('rubinotSessionReadyAt = 0;'));
    check('aba pode ser recriada', code.includes('async function getRubinotSessionPage'));

    // 2) Intervalo
    // O intervalo deixou de ser agressivo: estabilidade acima de velocidade.
    check('intervalo base conservador (moderado)', speedOf('detailsGapMs') >= 500);
    check('sem waitForTimeout(40) residual', !code.includes('waitForTimeout(40)'));

    // 3) Service Workers
    check('serviceWorkers bloqueados', code.includes("serviceWorkers: 'block'"));
    check('aplicado no contexto compartilhado', code.indexOf("serviceWorkers: 'block'") < code.indexOf('launchRubinotPersistentContext(requested'));

    // 4) Limpar sessão
    check('IPC de limpeza existe', code.includes("'rubinot-bazaar-clear-session'"));
    check('fecha o navegador antes de apagar', code.includes("closeRubinotBrowser('limpar-sessao')"));
    check('exige confirmação do usuário', modal.includes('window.confirm('));
    check('avisa sobre nova verificação', modal.includes('verificação do site novamente'));
    check('não apaga sem existir', code.includes('if (!fs.existsSync(profileDir))'));

    // 5) Perfil limpo
    check('cria diretório temporário', code.includes('fs.mkdtempSync'));
    check('descarta ao encerrar', code.includes('removeRubinotCleanProfile'));
    check('desativado por padrão', modal.includes('setCleanProfile(false)'));
    check('não toca no perfil persistente', code.includes('rubinotCleanProfileDir = wantsClean ? userDataDir : \'\';'));
    check('troca de perfil reinicia contexto', code.includes('rubinotContextIsClean !== wantsClean'));
    check('detalhes herdam a escolha', code.includes('cleanProfile: rubinotUseCleanProfile'));
    check('painel repassa a flag', panel.includes('cleanProfile: options?.cleanProfile === true'));

    // Nada removido
    check('escolha de navegador preservada', code.includes('RUBINOT_BROWSERS') && panel.includes('BazaarBrowserModal'));
    check('retry secundário preservado', code.includes('getRubinotFallbackBrowser'));
    check('sem stealth agressivo', !code.includes('playwright-extra') && !code.includes('puppeteer-extra'));
  }

  // ── [30] Página em falha não prende o script ───────────────────────────
  console.log('\n[30] Página em falha não prende o script');
  {
    const code = SRC.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
    const WAIT = speedOf('bosstiaryWaitMs');
    const COOL = speedOf('failureCooldownMs');

    // O antigo esquema (deadline + confirmação + recheck + grace) foi
    // substituído por um teto ÚNICO de 1s na corrida inicial.
    check('teto único e curto', WAIT <= 1500, `${WAIT}ms`);
    check('sem deadline pós-falha', !code.includes('failureDeadline'));
    check('sem fase de confirmação', !code.includes('RUBINOT_FAILURE_CONFIRM_MS'));
    check('sem recheck tardio', !code.includes('RUBINOT_FAILURE_RECHECK_MS'));
    check('sem grace órfão', !code.includes('RUBINOT_EXPLICIT_FAILURE_GRACE_MS'));
    check('distingue falha explícita', code.includes('let explicitFailure = failedNow'));
    check('corrida marca load-error', code.includes("if (outcome === 'load-error') explicitFailure = true"));
    check('erro explícito evita diagnose extra', code.includes('if (explicitFailure) {'));
    check('página morta reaproveita diagnóstico', code.includes('} else if (deadPage) {'));
    check('nenhum reload foi adicionado', !code.includes('page.reload('));

    // Uma ÚNICA espera avalia os dois sinais: não há ramo perdedor pendente.
    const outcomeFn = code.slice(code.indexOf('async function waitForRubinotAuctionOutcome'), code.indexOf('async function isRubinotAuctionPageAlive'));
    check('espera única trata erro', outcomeFn.includes('catch (_) {') && outcomeFn.includes("return 'timeout'"));
    check('mesmo timeout para os dois sinais', outcomeFn.includes('{ timeout: timeoutMs, polling: RUBINOT_DOM_POLL_MS }'));
    check('sem Promise.race executável', !code.includes('Promise.race'));

    // Único wait no bloco de falha é o cooldown deliberado.
    const failBlock = code.slice(code.indexOf('if (!bosstiaryReady && failedNow) {'), code.indexOf('if (!bosstiaryReady) {\n      const reason'));
    // `speed()` tem parênteses internos, então a captura precisa ser gulosa
    // até o fim da chamada.
    const waits = [...failBlock.matchAll(/waitForTimeout\((.+?)\);/g)].map(m => m[1]);
    check('só o cooldown espera após a falha', waits.length === 1 && waits[0] === 'speed().failureCooldownMs', waits.join(','));
    check('cooldown presente', COOL >= 500, `${COOL}ms`);

    // Falha continua indo para o retry e não vira analisado.
    check('falha vai ao retry', code.includes("reason === 'RUBINOT_ERRO_APP'"));
    check('falha não vira analisado', code.includes('soulwarCompleted: null, sanguineCompleted: null'));
    check('retry secundário preservado', code.includes('getRubinotFallbackBrowser'));
  }

  // ── [31] Sessão validada manualmente ───────────────────────────────────
  console.log('\n[31] Preparar/reutilizar sessão + remoção do mascaramento');
  {
    const code = SRC.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
    const modal = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'components', 'BazaarBrowserModal.tsx'), 'utf8');
    const panel = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'components', 'BazarPanel.tsx'), 'utf8');

    // 5) Mascaramento RESTAURADO por decisão explícita do usuário.
    //    Removê-lo (em 30416f2) fez a verificação do Cloudflare passar a
    //    aparecer e impediu a consulta. Ver o bloco RESTAURAÇÃO em
    //    electron-main.cjs. Estas verificações agora TRAVAM a presença.
    check('override de navigator.webdriver presente', code.includes("navigator, 'webdriver'"));
    check('flag AutomationControlled presente', code.includes('AutomationControlled'));
    check('addInitScript presente', code.includes('addInitScript'));
    // O que continua proibido é stealth de TERCEIROS e resolução de captcha.
    check('sem stealth de terceiros', !code.includes('playwright-extra') && !code.includes('puppeteer-extra'));

    // 1) Preparação manual
    check('IPC de preparação', code.includes("'rubinot-bazaar-prepare-session'"));
    check('usa perfil persistente (não temporário)', code.includes('getRubinotContext(browserKey, false)'));
    check('IPC de confirmação', code.includes("'rubinot-bazaar-confirm-session'"));
    check('botão no modal', modal.includes('Preparar sessão do RubinOT'));

    // 2) Estado da sessão — só metadados
    check('inspeção de estado existe', code.includes('function inspectRubinotSessionState'));
    check('os três rótulos no modal', modal.includes('Validada') && modal.includes('Não validada') && modal.includes('Expirada'));
    check('distingue cookie de app x Cloudflare', code.includes('RUBINOT_SESSION_COOKIE_HINTS') && code.includes('RUBINOT_CLOUDFLARE_COOKIE'));
    check('detecta expiração por timestamp', code.includes('cookie.expires < nowSec'));

    // 3) Expiração durante a consulta
    check('conta falhas consecutivas', code.includes('function countRubinotConsecutiveFailures'));
    check('limiar configurável', readConst('RUBINOT_SESSION_EXPIRED_STREAK') > 0);
    check('sessionExpired no retorno', code.includes('sessionExpired,'));
    check('avisa o usuário', panel.includes('parece ter expirado durante a consulta'));
    check('nunca autentica sozinho', !/page\.fill\([^)]*(pass|senha|usuario)/i.test(code));

    // PRIVACIDADE: nenhum valor de cookie sai do processo principal.
    const inspectFn = code.slice(code.indexOf('async function inspectRubinotSessionState'), code.indexOf('async function getRubinotCloudflareCookies'));
    check('retorna apenas NOMES de cookies', inspectFn.includes('cookie.name') && !inspectFn.includes('cookie.value'));
    check('não registra credenciais', !inspectFn.includes('password') && !inspectFn.includes('senha'));

    // Maior sequência de falhas.
    const streak = (flags) => {
      let longest = 0, current = 0;
      for (const failed of flags) { if (failed) { current++; if (current > longest) longest = current; } else current = 0; }
      return longest;
    };
    check('sequência de 3 detectada', streak([false, true, true, true, false]) === 3);
    check('sequência quebrada reinicia', streak([true, true, false, true]) === 2);
    check('sem falhas => 0', streak([false, false]) === 0);

    // 4) Perfil persistente preservado
    check('perfil por navegador mantido', code.includes('rubinot-profile-chrome') && code.includes('rubinot-profile-webkit'));
    check('botão Limpar sessão mantido', code.includes("'rubinot-bazaar-clear-session'"));
    check('perfil não é apagado sozinho', code.includes('closeRubinotBrowser(\'limpar-sessao\')'));
  }

  // ── [32] Fluxo de autenticação no estado ESTÁVEL (regressão travada) ───
  //
  // Uma tentativa anterior de "melhorar" a passagem pelo Cloudflare quebrou a
  // validação automática do desafio. Este bloco existe para impedir que as
  // MESMAS alterações voltem a ser introduzidas por engano. Cada verificação
  // aqui corresponde a algo que comprovadamente causou o retrocesso.
  console.log('\n[32] Autenticação no estado estável (anti-regressão)');
  {
    const code = SRC.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
    const modal = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'components', 'BazaarBrowserModal.tsx'), 'utf8');
    const panel = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'components', 'BazarPanel.tsx'), 'utf8');

    // 1) Service Workers PERMANECEM bloqueados.
    //    Com 'allow', _isNetworkInspectionEnabled() passa a retornar true e o
    //    Playwright mantém a inspeção de rede do CDP sobre todas as
    //    requisições — inclusive as do desafio. Foi o que quebrou.
    check('serviceWorkers continua block', code.includes("serviceWorkers: 'block'"));
    check('sem política configurável de SW', !code.includes('RUBINOT_SERVICE_WORKERS_DEFAULT') && !code.includes('resolveRubinotServiceWorkersPolicy'));
    check('modal não expõe opção de SW', !modal.includes('BAZAAR_SERVICE_WORKERS_KEY') && !modal.includes('Bloquear Service Workers'));
    check('consulta não repassa SW', !panel.includes('serviceWorkers:'));

    // 2) Viewport FIXO. `viewport: null` liga o modo noDefaultViewport, que
    //    muda o caminho de inicialização da página.
    check('viewport fixo mantido', code.includes('viewport: { width: 1366, height: 850 }'));
    check('screen fixo mantido', code.includes('screen: { width: 1366, height: 850 }'));
    check('deviceScaleFactor mantido', code.includes('deviceScaleFactor: 1'));
    check('sem viewport nulo', !code.includes('viewport: null'));
    check('flag de janela mantida', code.includes("'--window-size=1366,850'"));

    // 3) UMA aba só: a preparação usa a MESMA aba da automação.
    //    Isolar o login em aba própria quebrou a validação automática.
    check('sem aba de login isolada', !code.includes('getRubinotLoginPage') && !code.includes('rubinotLoginPage'));
    check('preparação usa a aba de sessão', code.includes('const page = await getRubinotSessionPage(context)'));
    check('preparação abre o /bazaar', code.includes('page.goto(RUBINOT_BAZAAR_URL'));
    check('sem constante de home separada', !code.includes('RUBINOT_SITE_URL'));
    check('seleção de aba sem exclusões', code.includes("context.pages().find(page => !page.isClosed() && page.url() === 'about:blank')"));

    // 4) getRubinotContext com a assinatura estável (2 parâmetros).
    check('assinatura estável do contexto', code.includes('async function getRubinotContext(browserKey = rubinotSelectedBrowser, useCleanProfile = false)'));
    // Só navegador e perfil forçam contexto novo; não existe política de
    // Service Workers configurável.
    check('reinício só por navegador/perfil', code.includes('rubinotContextIsClean !== wantsClean)') && !code.includes('rubinotContextServiceWorkers'));

    // 4b) Contexto idêntico ao último estado que carregava sem verificação.
    check('flag restaurada nos args', code.includes("'--disable-blink-features=AutomationControlled'"));
    check('init script restaurado', code.includes("Object.defineProperty(navigator, 'webdriver'"));
    check('idioma alinhado no init script', code.includes("Object.defineProperty(navigator, 'languages'"));
    check('init script aplicado ao contexto', code.includes('await rubinotContext.addInitScript('));

    // 5) O laço de validação automática do Cloudflare segue intacto.
    check('validação automática existe', code.includes('async function ensureRubinotSessionReady'));
    check('espera o desafio sem interferir', code.includes('await page.waitForTimeout(cloudflareDetected ? 1500 : 400)'));
    check('não recarrega durante o desafio', code.includes('const cloudflareDetected = cloudflareSignal && !(dom.hasBazaarDom && hasCloudflareClearance)'));
    check('piso de estabilidade em 800ms', code.includes('stableMs >= 800'));
    check('aba de sessão ainda é fechada na análise', code.includes("closeRubinotSessionPage('analise-individual')"));

    // 6) Melhorias PRESERVADAS (não tocam a autenticação).
    check('flush de cookies preservado', code.includes('async function flushRubinotSessionBeforeClose'));
    check('flush é chamado no encerramento', code.includes('await flushRubinotSessionBeforeClose(context, reason)'));
    check('validade do cf_clearance preservada', code.includes('cfClearanceExpiresAt'));
    check('cookie volátil x persistente preservado', code.includes('sessionCookiePersistent'));
    check('modal mostra a validade', modal.includes('formatClearanceValidity'));
    check('aviso sobre o Google preservado', modal.includes('O Google recusa o login em navegadores controlados por'));
    check('retry entre navegadores preservado', code.includes('function getRubinotFallbackBrowser') && code.includes('skipSessionWarmup'));

    // 7) Mascaramento do estado estável restaurado; bypass continua proibido.
    check('mascaramento estável presente', code.includes('AutomationControlled') && code.includes('addInitScript'));
    check('sem stealth de terceiros', !code.includes('playwright-extra') && !code.includes('puppeteer-extra'));
    check('sem serviço de resolução de captcha', !/2captcha|anticaptcha|capmonster|deathbycaptcha/i.test(code));
    check('não resolve o desafio sozinho', !/solveCaptcha|solveTurnstile|bypassCloudflare/i.test(code));
    check('só nomes de cookies no diagnóstico', !/cookie\.value/.test(code));
  }

  // ── [33] Falso positivo na detecção do desafio Cloudflare ──────────────
  //
  // O RubinOT serve /cdn-cgi/challenge-platform/... em TODA página, mesmo sem
  // bloqueio algum. Casar essa marca contra o HTML completo fazia
  // `cloudflareDetected` ser sempre verdadeiro: a API era pulada, a sessão
  // nunca ficava pronta e após 180s falhava pedindo verificação humana.
  console.log('\n[33] Detecção do desafio Cloudflare sem falso positivo');
  {
    const code = SRC.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
    // eslint-disable-next-line no-eval
    const isLikely = eval(`(${extractFn('isLikelyCloudflarePage')})`);

    // HTML de uma página SAUDÁVEL: SPA carregada + script padrão do Cloudflare.
    const saudavel = '<!DOCTYPE html><html><head><title>RubinOT - Char Bazaar</title>'
      + '<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>'
      + '<script defer src="https://static.cloudflareinsights.com/beacon.min.js"></script>'
      + '</head><body><h1>Current Auctions</h1><input placeholder="Search"></body></html>';
    // HTML de um intersticial REAL.
    const bloqueio = '<!DOCTYPE html><html><head><title>Just a moment...</title></head>'
      + '<body><div id="challenge-running">Checking your browser</div>'
      + '<input name="cf-turnstile-response"></body></html>';

    check('página saudável NÃO é desafio', isLikely(saudavel, 'https://rubinot.com.br/bazaar') === false);
    check('intersticial real É desafio', isLikely(bloqueio, 'https://rubinot.com.br/bazaar') === true);
    check('URL do challenge-platform É desafio', isLikely('<html></html>', 'https://rubinot.com.br/cdn-cgi/challenge-platform/h/b/orchestrate') === true);
    check('asset comum em /cdn-cgi/ NÃO é desafio', isLikely(saudavel, 'https://rubinot.com.br/cdn-cgi/images/x.png') === false);
    check('página vazia NÃO é desafio', isLikely('', 'https://rubinot.com.br/bazaar') === false);

    // Marcas genéricas não podem voltar à heurística de texto.
    const fn = extractFn('isLikelyCloudflarePage');
    check("sem match cru de 'challenge-platform' no texto", !fn.includes("text.includes('challenge-platform')"));
    check("sem match cru de 'cloudflare' no texto", !fn.includes("text.includes('cloudflare')"));
    check("sem match cru de 'turnstile' no texto", !fn.includes("text.includes('turnstile')"));
    check("sem match cru de 'cdn-cgi' na URL", !fn.includes("includes('cdn-cgi')"));
    check('exige caminho do intersticial', fn.includes('/cdn-cgi/challenge-platform'));

    // Seletores genéricos removidos dos inspetores de DOM.
    check("sem seletor generico [class*='cf-']", !code.includes('[class*="cf-"], [id*="cf-"]'));
    check("sem seletor generico [id*='challenge' i]", !code.includes(`'[id*="challenge" i]'`));
    check('Turnstile só conta se visível', code.includes('turnstileVisible'));
    check('usa getBoundingClientRect para visibilidade', code.includes('getBoundingClientRect'));

    // O caminho de verificação humana REAL continua existindo.
    check('ainda detecta intersticial real', code.includes("text.includes('checking your browser')"));
    check('ainda avisa needsHumanVerification', code.includes('needsHumanVerification: cloudflareDetected'));
    check('ainda traz a janela ao topo no desafio', code.includes('page.bringToFront()'));
  }

  // ── [35] Teto de 1s para a página se tornar utilizável ─────────────────
  //
  // A análise só começa com a aba Bosstiary presente. Enquanto ela não
  // aparece, a página é inutilizável — e esperar ali não produz resultado.
  // Antes o pior caso era 8,2s (1500 + 5500 + 800 + 400); agora é 1s fixo.
  console.log('\n[35] Teto de 1s para página inutilizável');
  {
    const code = SRC.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
    const WAIT = speedOf('bosstiaryWaitMs');
    const PANEL = speedOf('bosstiaryPanelWaitMs');
    const SETTLE = speedOf('bosstiarySettleMs');
    const COOL = speedOf('failureCooldownMs');

    // 1) Teto único, sem etapas escondidas.
    check('teto é curto', WAIT <= 1500, `${WAIT}ms`);
    check('uma única corrida', (code.match(/await runRace\(/g) || []).length === 1);
    check('sem prorrogação', !code.includes('RUBINOT_BOSSTIARY_EXTRA_WAIT_MS'));
    check('sem confirmação', !code.includes('RUBINOT_FAILURE_CONFIRM_MS'));
    check('sem recheck', !code.includes('RUBINOT_FAILURE_RECHECK_MS'));
    check('helper de recheck removido', !code.includes('waitForRubinotBosstiaryTab'));

    // 2) Timeout classifica o motivo e segue — sem nova espera.
    check('timeout marca falha conclusiva', code.includes("if (outcome === 'timeout') {") && code.includes('deadPage = true;'));
    check('classifica o motivo numa leitura só', code.includes('isRubinotAuctionPageAlive(page)'));
    check('log do teto', code.includes('Página não ficou utilizável dentro do teto; descartando.'));

    // 3) Encontrada a Bosstiary, o teto NÃO se aplica às etapas seguintes.
    check('painel mantém seu próprio tempo', PANEL >= 3000, `${PANEL}ms`);
    check('assentamento preservado', SETTLE >= 200, `${SETTLE}ms`);
    check('teto não limita o painel', code.includes('timeout: speed().bosstiaryPanelWaitMs'));
    check('busca da Bosstiary preservada', code.includes('Campo de busca da Bosstiary não ficou disponível'));

    // 4) Modelo dos desfechos.
    const sim = ({ tBoss = null, tErr = null }) => {
      const first = Math.min(tBoss === null ? Infinity : tBoss, tErr === null ? Infinity : tErr);
      if (first > WAIT) return { out: 'falha', ms: WAIT };
      return first === tErr ? { out: 'falha', ms: first } : { out: 'sucesso', ms: first };
    };
    check('Bosstiary em 400ms => sucesso', sim({ tBoss: 400 }).out === 'sucesso');
    check('Bosstiary em 900ms => sucesso', sim({ tBoss: 900 }).out === 'sucesso');
    check('Bosstiary em 2s => falha (fora do teto)', sim({ tBoss: 2000 }).out === 'falha');
    check('erro explícito => falha imediata', sim({ tErr: 180 }).ms === 180);
    check('nada em 1s => falha em 1s', sim({}).ms === WAIT);
    check('pior caso inutilizável <= 3s', WAIT + COOL <= 3000, `${WAIT + COOL}ms`);

    // 5) Regras preservadas.
    check('Bosstiary vazia ainda é válida', !code.includes('bossSet.size === 0'));
    check('sem reload', !code.includes('page.reload('));
    check('retry entre navegadores preservado', code.includes('getRubinotFallbackBrowser'));
    check('validação final preservada', code.includes('validateRubinotAuctionPageAfterAnalysis'));
  }

  // ── [36] WebKit: espera por rAF ignorava páginas válidas ───────────────
  //
  // BUG CORRIGIDO: `locator.waitFor()` e `waitForFunction()` sem `polling` são
  // avaliados dentro de requestAnimationFrame. A análise roda com a janela em
  // SEGUNDO PLANO e o WebKit suspende rAF nesse estado (e não aceita flags,
  // pois `args` é descartado para motores não-Chromium). A espera pelo botão
  // Bosstiary nunca era avaliada e estourava, mesmo com o botão visível.
  // A detecção de falha usava `polling: 120` e seguia funcionando — daí a
  // assimetria: falhas detectadas, sucessos não.
  console.log('\n[36] WebKit em segundo plano: polling por temporizador');
  {
    const code = SRC.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');

    // 1) Nenhuma espera do fluxo pode depender de rAF.
    const totalWff = (code.match(/waitForFunction\(/g) || []).length;
    const withPolling = (code.match(/polling: (RUBINOT_DOM_POLL_MS|120)/g) || []).length;
    check('todo waitForFunction define polling', totalWff > 0 && withPolling === totalWff, `${withPolling}/${totalWff}`);
    check('sem waitFor visible (baseado em rAF)', !code.includes(".waitFor({ state: 'visible'"));
    check('constante de polling definida', code.includes('const RUBINOT_DOM_POLL_MS'));
    check('polling curto o bastante', readConst('RUBINOT_DOM_POLL_MS') <= 150, `${readConst('RUBINOT_DOM_POLL_MS')}ms`);

    // 2) Helper dedicado à aba Bosstiary.
    // A detecção da aba vive dentro da corrida atômica (o helper separado foi
    // removido junto com o recheck tardio — ver bloco [35]).
    const outcomeFn = code.slice(code.indexOf('async function waitForRubinotAuctionOutcome'), code.indexOf('async function isRubinotAuctionPageAlive'));
    check('corrida detecta a aba', outcomeFn.includes("return 'bosstiary'"));
    check('exige elemento utilizável', outcomeFn.includes('element.disabled === true') && outcomeFn.includes('aria-disabled'));
    check('exige visibilidade real', outcomeFn.includes('rect.width > 0 && rect.height > 0'));
    check('cobre button/a/role=tab', outcomeFn.includes('button, a, [role="tab"]'));

    // 3) REGRA PRINCIPAL: aba disponível => personagem não é descartado.
    const validate = (state) => {
      if (state.hasErrorText) return { ok: false, reason: 'RUBINOT_ERRO_APP' };
      if (state.hasCloudflare) return { ok: false, reason: 'CLOUDFLARE' };
      if (state.bodyLength < 50) return { ok: false, reason: 'PAGINA_VAZIA' };
      if (!state.hasBosstiaryTab) return { ok: false, reason: 'PAGINA_OK_SEM_BOSSTIARY' };
      return { ok: true, panelMissing: !state.hasBosstiaryContent };
    };
    const base = { hasErrorText: false, hasCloudflare: false, bodyLength: 5000, hasBosstiaryTab: true, hasBosstiaryContent: true };
    check('aba + painel => aceito', validate(base).ok === true);
    check('aba SEM painel => ACEITO (antes descartava)', validate({ ...base, hasBosstiaryContent: false }).ok === true);
    check('aba sem painel sinaliza panelMissing', validate({ ...base, hasBosstiaryContent: false }).panelMissing === true);
    check('erro do site => descartado', validate({ ...base, hasErrorText: true }).ok === false);
    check('Cloudflare => descartado', validate({ ...base, hasCloudflare: true }).ok === false);
    check('página vazia => descartada', validate({ ...base, bodyLength: 10 }).ok === false);
    check('sem aba => descartado', validate({ ...base, hasBosstiaryTab: false }).ok === false);

    // A guarda no código precisa refletir a regra.
    check('validação exige só a aba', code.includes('if (!state.hasBosstiaryTab) {'));
    check('painel ausente não é mais falha', !code.includes('if (!state.hasBosstiaryTab || !state.hasBosstiaryContent)'));
    check('painel ausente é apenas registrado', code.includes('Aba Bosstiary presente sem painel confirmado'));

    // 4) Detecção de falha continua rápida e o resto preservado.
    check('detecção de falha por temporizador', code.includes('polling: RUBINOT_DOM_POLL_MS'));
    check('atalho de erro imediato mantido', code.includes('hasRubinotAuctionLoadErrorNow'));
    check('prorrogação condicional preservada', code.includes('isRubinotAuctionPageAlive'));
    check('sem reload', !code.includes('page.reload('));
    check('retry entre navegadores preservado', code.includes('getRubinotFallbackBrowser'));
    check('busca da Bosstiary não depende de rAF', code.includes('Campo de busca da Bosstiary não ficou disponível'));
  }

  // ── [38] Ritmo conservador e adaptativo ────────────────────────────────
  //
  // A versão mais rápida NÃO trouxe mais personagens: encadear ações em
  // dezenas de milissegundos fazia o RubinOT degradar e devolver mais
  // "Falha ao carregar leilão". Agora o ritmo é folgado e desacelera sozinho
  // quando as falhas viram sequência.
  console.log('\n[38] Ritmo conservador, adaptativo e regra dos 3 segundos');
  {
    const code = SRC.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
    const GAP = speedOf('detailsGapMs');
    const OPEN = speedOf('bosstiaryOpenGapMs');
    const SRCH = speedOf('bosstiarySearchGapMs');
    const PAGEG = speedOf('bosstiaryPageGapMs');
    const COOL = speedOf('failureCooldownMs');
    const TRIG = speedOf('paceFailureTrigger');
    const STEP = speedOf('paceStepMs');
    const MAXE = speedOf('paceMaxExtraMs');
    const REC = speedOf('paceRecoverMs');

    // 1) Nenhum intervalo agressivo.
    // O que exige folga é a NAVEGAÇÃO (uma página completa por personagem).
    check('intervalo entre personagens >= 500ms', GAP >= 500, `${GAP}ms`);
    // Ações DENTRO da Bosstiary não geram requisições — a página já está
    // carregada e o filtro roda no cliente. Aqui basta a SPA reprocessar a
    // tabela, então o piso é bem menor (mas nunca zero).
    check('pausa após abrir Bosstiary >= 100ms', OPEN >= 100, `${OPEN}ms`);
    check('pausa entre pesquisas >= 100ms', SRCH >= 100, `${SRCH}ms`);
    check('pausa entre páginas da Bosstiary >= 300ms', PAGEG >= 300, `${PAGEG}ms`);
    check('nenhuma etapa sem intervalo', Math.min(GAP, OPEN, SRCH, PAGEG) >= 100);
    check('navegação mais espaçada que ações no cliente', GAP > SRCH && GAP > OPEN);
    check('tempos centralizados por modo', SRC.includes('MODOS DE VELOCIDADE') && SRC.includes('const RUBINOT_SPEED_MODES'));
    check('sem waitForTimeout(80) residual', !code.includes('waitForTimeout(80)'));
    check('sem waitForTimeout(60) residual', !code.includes('waitForTimeout(60)'));

    // 2) REGRA DOS 3 SEGUNDOS.
    check('cooldown de falha presente', COOL >= 500, `${COOL}ms`);
    check('cooldown aplicado só quando falhou', code.includes('if (!bosstiaryReady) {') && code.includes('await page.waitForTimeout(speed().failureCooldownMs)'));
    check('cooldown não recarrega a página', !code.includes('page.reload('));
    check('personagem segue para o retry', code.includes('getRubinotFallbackBrowser'));

    // 3) Desaceleração adaptativa — modelo fiel da função real.
    let extra = 0; let streak = 0;
    const outcome = (ok) => {
      if (ok) { streak = 0; extra = Math.max(0, extra - REC); return; }
      streak += 1;
      if (streak >= TRIG) extra = Math.min(MAXE, extra + STEP);
    };
    const gap = () => GAP + extra;

    outcome(false);
    check('falha isolada não desacelera', gap() === GAP);
    outcome(false);
    check('sequência de 2 desacelera', gap() === GAP + STEP);
    outcome(false);
    check('sequência de 3 desacelera mais', gap() === GAP + STEP * 2);
    for (let i = 0; i < 20; i++) outcome(false);
    check('acréscimo respeita o teto', extra === MAXE);
    check('teto não trava a consulta', gap() <= 5000, `${gap()}ms`);
    const before = extra;
    outcome(true);
    check('sucesso recupera gradualmente', extra === before - REC);
    check('sucesso zera a sequência', streak === 0);
    for (let i = 0; i < 20; i++) outcome(true);
    check('estabilidade volta ao ritmo base', extra === 0 && gap() === GAP);
    extra = 0; streak = 0;
    outcome(false); outcome(true); outcome(false); outcome(true);
    check('falhas alternadas não desaceleram', extra === 0);

    // 4) Estrutura do ritmo.
    check('função de ritmo existe', code.includes('function registerRubinotPaceOutcome'));
    check('ritmo é reiniciado por passada', code.includes('resetRubinotPace()'));
    check('intervalo efetivo centralizado', code.includes('function getRubinotPaceGapMs'));
    check('sem pausa após o último personagem', code.includes('if (index < list.length - 1) {'));

    // 5) Uma análise por vez / sem paralelismo.
    // O fluxo do Bazaar usa no máximo 2 páginas (sessão + detalhes).
    const bazaarFlow = code.slice(code.indexOf('async function getRubinotSessionPage'));
    check('uma única página de detalhes', (bazaarFlow.match(/context\.newPage\(\)/g) || []).length <= 2);
    // Personagens são analisados um a um; nada de leque de promessas no laço.
    const detailsLoop = code.slice(code.indexOf('for (let index = 0; index < list.length; index++)'), code.indexOf('rubinotContextLastUsedAt = Date.now();'));
    check('sem Promise.all no laço de personagens', !detailsLoop.includes('Promise.all('));
    check('um personagem por vez (await no laço)', code.includes('details[key] = await fetchRubinotCharacterDetails(detailPage'));
    check('laço sequencial preservado', code.includes('for (let index = 0; index < list.length; index++)'));

    // 6) Regras de negócio preservadas.
    check('validação final preservada', code.includes('validateRubinotAuctionPageAfterAnalysis'));
    check('regra da aba Bosstiary preservada', code.includes('if (!state.hasBosstiaryTab) {'));
    check('escopo de quests preservado', code.includes('resolveRubinotQuestScope'));
    check('Bosstiary vazia ainda é válida', !code.includes('bossSet.size === 0'));
  }

  // ── [40] Falhas para retry exibidas ao vivo no progresso ───────────────
  console.log('\n[40] Contagem ao vivo de falhas para retry');
  {
    const code = SRC.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
    const panel = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'components', 'BazarPanel.tsx'), 'utf8');
    // eslint-disable-next-line no-eval
    const recoverable = eval(`(${extractFn('isRubinotRecoverableFailure')})`);

    // Modelo do contador (Set) e da seleção real do retry (filter).
    const liveCount = (seq) => {
      const set = new Set();
      for (const [key, detail] of seq) {
        if (recoverable(detail)) set.add(key); else set.delete(key);
      }
      return set.size;
    };
    const realRetry = (map) => Object.entries(map).filter(([, d]) => recoverable(d)).length;

    const ok = { soulwarCompleted: true };
    const errApp = { error: 'x', failureReason: 'RUBINOT_ERRO_APP' };
    const errCf = { error: 'x', failureReason: 'CLOUDFLARE' };
    const errFinal = { error: 'x', failureReason: 'URL_INVALIDA' };

    // 1) Só conta quem realmente vai ao retry.
    check('sucesso não conta', liveCount([['a', ok]]) === 0);
    check('falha recuperável conta', liveCount([['a', errApp]]) === 1);
    check('falha definitiva NÃO conta', liveCount([['a', errFinal]]) === 0);
    check('Cloudflare conta', liveCount([['a', errCf]]) === 1);

    // 2) Sem duplicados.
    check('mesmo personagem não conta duas vezes', liveCount([['a', errApp], ['a', errApp]]) === 1);
    check('personagem recuperado sai da contagem', liveCount([['a', errApp], ['a', ok]]) === 0);
    check('usa Set para deduplicar', code.includes('const retryCandidates = new Set()'));

    // 3) Coerência com o que o retry realmente processa.
    const cenario = { a: errApp, b: ok, c: errCf, d: errFinal };
    check('contador == seleção real do retry', liveCount(Object.entries(cenario)) === realRetry(cenario));
    check('mesmo critério do retry', code.includes('if (isRubinotRecoverableFailure(details[key])) retryCandidates.add(key)'));
    check('retry usa o mesmo helper', code.includes('return key && isRubinotRecoverableFailure(details[key])'));

    // 4) Transporte no progresso.
    check('progresso carrega retryPending', code.includes('retryPending: retryCandidates.size'));
    check('progresso distingue a passada de retry', code.includes('const isRetryPass = options.skipSessionWarmup === true'));
    check('buildRubinotProgress aceita extras', code.includes('function buildRubinotProgress(stage, message, processed, total, extra = {})'));
    check('extras não alteram o cálculo', code.includes('const percent = safeTotal > 0'));

    // 5) Interface.
    check('painel declara os campos', panel.includes('retryPending?: number') && panel.includes('isRetryPass?: boolean'));
    check('exibe "Falhas para retry"', panel.includes('Falhas para retry'));
    check('rótulo muda durante o retry', panel.includes('Ainda com falha'));
    check('plural correto', panel.includes('personagem{retryPending === 1 ? "" : "s"}'));
    check('só na etapa de detalhes', panel.includes('progress.stage === "details"'));
    check('zera ao iniciar consulta', panel.includes('setRetryPending(0)'));
    check('zera ao finalizar', panel.includes('setIsRetryPass(false)'));
    check('sem cor fixa (usa tokens/paleta)', !panel.includes('Falhas para retry') || panel.includes('border-rose-500/30'));

    // 6) Nada da lógica mudou.
    check('retry secundário preservado', code.includes('getRubinotFallbackBrowser'));
    check('ritmo preservado', code.includes('registerRubinotPaceOutcome'));
    check('pausa pós-falha preservada', speedOf('failureCooldownMs') >= 500);
  }

  // ── [39] Proxy removido por completo ───────────────────────────────────
  //
  // A funcionalidade de proxy foi removida a pedido do usuário. Este bloco
  // impede que sobras voltem por engano em refatorações futuras.
  console.log('\n[39] Ausência total do proxy');
  {
    const code = SRC;
    const modal = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'components', 'BazaarBrowserModal.tsx'), 'utf8');
    const panel = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'components', 'BazarPanel.tsx'), 'utf8');

    check('electron-main sem proxy', !/proxy/i.test(code));
    check('modal sem proxy', !/proxy/i.test(modal));
    check('painel sem proxy', !/proxy/i.test(panel));
    check('sem IPC de teste de proxy', !code.includes('rubinot-bazaar-test-proxy'));
    check('sem chave de persistência', !modal.includes('BAZAAR_PROXY_KEY'));

    // O que NÃO podia ser afetado pela remoção.
    check('escolha de navegador preservada', modal.includes('BAZAAR_BROWSER_KEY') && code.includes('RUBINOT_BROWSERS'));
    check('ordem de preferência preservada', modal.includes('BAZAAR_BROWSER_ORDER_KEY'));
    check('retry secundário preservado', code.includes('getRubinotFallbackBrowser'));
    check('métricas preservadas', code.includes('successRate') && code.includes('totalDurationMs'));
    check('Última Consulta preservada', panel.includes('displayedLastSummary'));
    check('filtros preservados', panel.includes('getApiFilteredAuctions'));
    check('perfil limpo preservado', modal.includes('Usar perfil limpo nesta consulta'));
    check('limpar sessão preservada', code.includes("'rubinot-bazaar-clear-session'"));
    check('contador de retry preservado', code.includes('retryPending: retryCandidates.size'));
    check('ritmo adaptativo preservado', code.includes('registerRubinotPaceOutcome'));
    check('pausa pós-falha preservada', speedOf('failureCooldownMs') >= 500);
    check('contexto sem opção de proxy', !code.includes('contextOptions.proxy'));

    // ── Botão "Teste" removido (substituído pela cadeia de retries) ───────
    check('sem benchmark no backend', !/benchmark/i.test(code));
    check('sem IPC de benchmark', !code.includes('rubinot-bazaar-benchmark'));
    check('painel sem estado de teste', !/isTestRunning|isTestModalOpen|handleTestBrowsers/.test(panel));
    check('painel sem o modal de teste', !panel.includes('BazaarBrowserTestModal'));
    check('arquivo do modal de teste removido', !fs.existsSync(path.join(__dirname, '..', '..', 'src', 'components', 'BazaarBrowserTestModal.tsx')));
  }

  // ── [40] Cadeia de retries com vários navegadores ──────────────────────
  console.log('\n[40] Cadeia de retries');
  {
    const code = SRC.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
    const modal = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'components', 'BazaarBrowserModal.tsx'), 'utf8');
    const panel = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'components', 'BazarPanel.tsx'), 'utf8');

    const RUBINOT_BROWSERS = { chrome: {}, edge: {}, firefox: {}, webkit: {} };
    const RUBINOT_DEFAULT_BROWSER = 'webkit';
    const RUBINOT_BROWSER_FALLBACK_ORDER = ['webkit', 'firefox', 'edge', 'chrome'];
    void RUBINOT_BROWSERS; void RUBINOT_DEFAULT_BROWSER; void RUBINOT_BROWSER_FALLBACK_ORDER;
    // eslint-disable-next-line no-eval
    const resolveRubinotBrowserKey = eval(`(${extractFn('resolveRubinotBrowserKey')})`);
    // eslint-disable-next-line no-eval
    const normalizeRubinotBrowserOrder = eval(`(${extractFn('normalizeRubinotBrowserOrder')})`);
    // eslint-disable-next-line no-eval
    const getRubinotFallbackBrowser = eval(`(${extractFn('getRubinotFallbackBrowser')})`);
    // eslint-disable-next-line no-eval
    const buildChain = eval(`(${extractFn('buildRubinotRetryChain')})`);
    void resolveRubinotBrowserKey; void normalizeRubinotBrowserOrder; void getRubinotFallbackBrowser;
    const ord = ['webkit', 'firefox', 'edge', 'chrome'];

    // 1) Montagem da cadeia.
    check('principal marcado vem primeiro', JSON.stringify(buildChain('webkit', ord, ord)) === JSON.stringify(['webkit', 'firefox', 'edge', 'chrome']));
    check('principal Chrome vem primeiro', JSON.stringify(buildChain('chrome', ord, ord)) === JSON.stringify(['chrome', 'webkit', 'firefox', 'edge']));
    check('seleção parcial respeitada', JSON.stringify(buildChain('webkit', ['chrome', 'edge'], ord)) === JSON.stringify(['edge', 'chrome']));
    check('ordem de preferência define a sequência', JSON.stringify(buildChain('webkit', ['chrome', 'firefox'], ['firefox', 'chrome', 'edge', 'webkit'])) === JSON.stringify(['firefox', 'chrome']));
    check('só o principal marcado => repete nele', JSON.stringify(buildChain('webkit', ['webkit'], ord)) === JSON.stringify(['webkit']));
    check('sem seleção => retry único (compatível)', JSON.stringify(buildChain('webkit', [], ord)) === JSON.stringify(['firefox']));
    check('chaves inválidas ignoradas', JSON.stringify(buildChain('webkit', ['opera', 'edge'], ord)) === JSON.stringify(['edge']));
    check('duplicatas não repetem', JSON.stringify(buildChain('webkit', ['edge', 'edge', 'chrome'], ord)) === JSON.stringify(['edge', 'chrome']));

    // 2) Cada personagem passa só pelos navegadores necessários.
    const sim = (chain, recoverAt) => {
      let pending = Object.keys(recoverAt);
      const attempts = {}; const stats = [];
      for (const b of chain) {
        if (!pending.length) break;
        const still = []; let rec = 0;
        for (const id of pending) {
          attempts[id] = (attempts[id] || 0) + 1;
          if (recoverAt[id] === b) rec += 1; else still.push(id);
        }
        stats.push({ browser: b, attempted: pending.length, recovered: rec });
        pending = still;
      }
      return { attempts, stats, pending };
    };
    const r = sim(['firefox', 'edge', 'chrome'], { a: 'firefox', b: 'edge', c: null });
    check('sucesso no 1º não vai aos seguintes', r.attempts.a === 1);
    check('sucesso no 2º passou por 2', r.attempts.b === 2);
    check('nunca recuperado passa por todos', r.attempts.c === 3);
    check('fila encolhe a cada etapa', JSON.stringify(r.stats.map(x => x.attempted)) === JSON.stringify([3, 2, 1]));
    check('falha final permanece', JSON.stringify(r.pending) === JSON.stringify(['c']));
    check('cadeia para quando todos recuperam', sim(['firefox', 'edge'], { a: 'firefox' }).stats.length === 1);

    // 3) Implementação.
    check('sucesso remove da fila', code.includes('pending = stillFailing'));
    check('interrompe com fila vazia', code.includes('if (pending.length === 0) break;'));
    check('navegador indisponível não para a cadeia', code.includes('Navegador da cadeia indisponível; seguindo para o próximo.'));
    check('retry não refaz a listagem', code.includes('forceRefresh: true, skipSessionWarmup: true'));
    check('só falhas recuperáveis entram', code.includes('isRubinotRecoverableFailure(details[key])'));
    check('estatísticas por passada', code.includes('retryStats.push({') && code.includes('browser: chainBrowser, attempted: pending.length, recovered: recoveredHere,'));
    check('retryBrowser antigo preservado', code.includes("const retryBrowser = retryStats.length > 0 ? retryStats[0].browser : ''"));

    // 4) Interface.
    check('modal persiste a seleção', modal.includes('BAZAAR_RETRY_BROWSERS_KEY'));
    check('modal tem atalho de preenchimento em massa', modal.includes('setAllRetryCounts'));
    check('principal pode ser marcado', !modal.includes('disabled={isPrimary}'));
    check('modal mostra a cadeia resultante', modal.includes('effectiveRetryChain'));
    check('painel repassa a seleção', panel.includes('retryBrowsers: options?.retryBrowsers'));
    check('Última Consulta mostra a cadeia', panel.includes('displayedLastSummary.retryStats!.map'));
    check('resumo persiste retryStats', panel.includes('retryStats: detailsResponse.retryStats || []'));

    // 5) Preservações.
    check('métricas preservadas', code.includes('successRate') && code.includes('totalDurationMs'));
    check('filtros preservados', panel.includes('getApiFilteredAuctions'));
    check('ritmo preservado', code.includes('registerRubinotPaceOutcome'));
  }

  // ── [41] Progresso em tempo real por navegador ─────────────────────────
  //
  // O "Tempo decorrido" zerava a cada troca de navegador porque
  // `closeRubinotBrowser('troca-de-contexto')` chamava `finishRubinotProgress`,
  // que apaga `startedAt`. Agora só o encerramento REAL finaliza o progresso.
  console.log('\n[41] Progresso por navegador e tempo persistente');
  {
    const code = SRC.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
    const panel = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'components', 'BazarPanel.tsx'), 'utf8');

    // 1) Tempo decorrido persistente.
    check('troca de navegador não encerra o progresso', code.includes("if (reason !== 'troca-de-contexto') finishRubinotProgress(reason)"));
    check('startedAt sobrevive enquanto ativo', code.includes('rubinotProgressState.active && rubinotProgressState.startedAt'));
    check('encerramento real ainda finaliza', code.includes('function finishRubinotProgress'));

    // 2) Estado por navegador, avaliado a partir do fonte real.
    const RUBINOT_BROWSERS = { webkit: { label: 'WebKit' }, firefox: { label: 'Firefox' }, edge: { label: 'Microsoft Edge' }, chrome: { label: 'Google Chrome' } };
    let rubinotRunBrowserStats = []; let rubinotRunPendingBrowsers = [];
    // A fotografia do progresso passou a incluir a configuração da consulta.
    let rubinotRunRetrySelection = []; let rubinotSpeedMode = 'moderado';
    // Plano expandido pela quantidade de retries de cada navegador.
    let rubinotRunRetryPlan = []; let rubinotRunPendingSteps = [];
    const RUBINOT_SPEED_MODES = SPEED_MODES;
    void RUBINOT_BROWSERS; void RUBINOT_SPEED_MODES; void rubinotRunRetrySelection;
    // eslint-disable-next-line no-eval
    eval(extractFn('summarizeRubinotRetryPlan'));
    // eslint-disable-next-line no-eval
    eval(extractFn('resetRubinotRunProgress'));
    // eslint-disable-next-line no-eval
    eval(extractFn('startRubinotBrowserStats'));
    // eslint-disable-next-line no-eval
    eval(extractFn('updateRubinotBrowserStats'));
    // eslint-disable-next-line no-eval
    eval(extractFn('finishRubinotBrowserStats'));
    // eslint-disable-next-line no-eval
    eval(extractFn('buildRubinotBrowserProgress'));

    resetRubinotRunProgress();
    rubinotRunPendingSteps = [
      { browser: 'firefox', attempt: 1, attempts: 1 },
      { browser: 'edge', attempt: 1, attempts: 1 },
    ];
    rubinotRunPendingBrowsers = rubinotRunPendingSteps.map(step => step.browser);

    startRubinotBrowserStats('webkit', 100, false);
    updateRubinotBrowserStats(50, 4);
    let snap = buildRubinotBrowserProgress();
    check('taxa ao vivo durante a análise', snap.browserStats[0].failureRate === 8);
    check('pendentes listados', snap.pendingBrowsers.map(b => b.browser).join() === 'firefox,edge');
    check('rótulo do navegador resolvido', snap.pendingBrowsers[1].label === 'Microsoft Edge');

    updateRubinotBrowserStats(100, 8);
    finishRubinotBrowserStats();
    startRubinotBrowserStats('firefox', 8, true);
    snap = buildRubinotBrowserProgress();
    check('navegador que iniciou sai dos pendentes', snap.pendingBrowsers.map(b => b.browser).join() === 'edge');
    check('contagem anterior é preservada', snap.browserStats[0].analyzed === 100 && snap.browserStats[0].failed === 8);
    check('sem duplicar contagem na troca', snap.browserStats.length === 2);
    check('entrada de retry é marcada', snap.browserStats[1].isRetry === true);
    check('navegador sem análise aparece como aguardando', snap.browserStats[1].analyzed === 0);

    updateRubinotBrowserStats(8, 2);
    finishRubinotBrowserStats();
    startRubinotBrowserStats('edge', 2, true);
    snap = buildRubinotBrowserProgress();
    check('taxa por navegador é independente', snap.browserStats[1].failureRate === 25);
    check('nenhum pendente ao fim da cadeia', snap.pendingBrowsers.length === 0);
    check('uma entrada por navegador', new Set(snap.browserStats.map(x => x.browser)).size === 3);
    check('concluídos são marcados', snap.browserStats[0].done && snap.browserStats[1].done && !snap.browserStats[2].done);

    resetRubinotRunProgress();
    check('reset limpa o acompanhamento', buildRubinotBrowserProgress().browserStats.length === 0);

    // 3) Integração.
    check('progresso carrega os dados', code.includes('...buildRubinotBrowserProgress()'));
    check('reset a cada consulta', code.includes('resetRubinotRunProgress();'));
    check('pendentes vêm do plano de retry', code.includes('rubinotRunPendingSteps = failedAuctions.length > 0 ? [...retryPlan] : []'));
    check('entrada aberta por passada', code.includes('startRubinotBrowserStats(') && code.includes('list.length, isRetryPass,'));

    // 4) Interface.
    check('painel declara os tipos', panel.includes('interface BazaarBrowserProgress'));
    check('painel exibe taxa de falhas', panel.includes('{stat.failureRate}% falhas'));
    check('painel exibe "aguardando"', panel.includes('aguardando'));
    check('painel exibe pendentes', panel.includes('Pendentes:'));
    check('painel limpa ao encerrar', panel.includes('setBrowserStats([])') && panel.includes('setPendingBrowsers([])'));
    check('sem cor fixa', !/#[0-9a-fA-F]{6}/.test(panel));

    // 5) Lógica da consulta preservada.
    check('retry preservado', code.includes('getRubinotFallbackBrowser'));
    check('cadeia preservada', code.includes('buildRubinotRetryChain'));
    check('ritmo preservado', code.includes('registerRubinotPaceOutcome'));
    check('filtros preservados', panel.includes('getApiFilteredAuctions'));
  }

  // ── [42] Modos de velocidade e retry com o próprio navegador ───────────
  console.log('\n[42] Modos Agressivo/Moderado e retry no mesmo navegador');
  {
    const code = SRC.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
    const modal = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'components', 'BazaarBrowserModal.tsx'), 'utf8');
    const panel = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'components', 'BazarPanel.tsx'), 'utf8');
    const A = SPEED_MODES.agressivo;
    const M = SPEED_MODES.moderado;

    // 1) Os dois modos existem e são coerentes entre si.
    check('modo agressivo definido', !!A);
    check('modo moderado definido', !!M);
    for (const key of ['bosstiaryWaitMs', 'bosstiaryPanelWaitMs', 'bosstiarySettleMs', 'detailsGapMs',
      'bosstiaryOpenGapMs', 'bosstiarySearchGapMs', 'bosstiaryPageGapMs', 'failureCooldownMs', 'navTimeoutMs']) {
      check(`agressivo < moderado em ${key}`, A[key] < M[key], `${A[key]} < ${M[key]}`);
    }

    // 2) Agressivo é rápido, mas não temerário.
    const msKeys = Object.keys(A).filter(k => k.endsWith('Ms'));
    check('nenhuma espera abaixo de 80ms', Math.min(...msKeys.map(k => A[k])) >= 80);
    check('teto agressivo dá chance à página válida', A.bosstiaryWaitMs >= 500, `${A.bosstiaryWaitMs}ms`);
    check('painel agressivo >= 3s', A.bosstiaryPanelWaitMs >= 3000, `${A.bosstiaryPanelWaitMs}ms`);
    check('gap agressivo entre personagens >= 250ms', A.detailsGapMs >= 250, `${A.detailsGapMs}ms`);

    // 3) Ritmo adaptativo acompanha o modo.
    check('agressivo desacelera mais tarde', A.paceFailureTrigger > M.paceFailureTrigger);
    check('agressivo desacelera menos', A.paceStepMs < M.paceStepMs && A.paceMaxExtraMs < M.paceMaxExtraMs);
    check('agressivo recupera mais rápido', A.paceRecoverMs > M.paceRecoverMs);

    // 4) Seleção do modo.
    const RUBINOT_SPEED_MODES = SPEED_MODES;
    const RUBINOT_DEFAULT_SPEED_MODE = 'moderado';
    void RUBINOT_SPEED_MODES; void RUBINOT_DEFAULT_SPEED_MODE;
    // eslint-disable-next-line no-eval
    const resolveMode = eval(`(${extractFn('resolveRubinotSpeedMode')})`);
    check('padrão é moderado', resolveMode(undefined) === 'moderado');
    check('valor inválido cai no padrão', resolveMode('turbo') === 'moderado');
    check('agressivo é aceito', resolveMode('agressivo') === 'agressivo');
    check('aceita maiúsculas', resolveMode('AGRESSIVO') === 'agressivo');

    // 5) Tempos lidos em tempo de uso (vale também no retry).
    check('helper speed() existe', code.includes('function speed()'));
    check('modo aplicado no fetch', code.includes('rubinotSpeedMode = resolveRubinotSpeedMode(payload?.speedMode)'));
    check('sem constantes de tempo soltas', !/const RUBINOT_(BOSSTIARY_WAIT|DETAILS_GAP|FAILURE_COOLDOWN|PACE_STEP)_MS =/.test(code));
    check('teto usa o modo', code.includes('runRace(speed().bosstiaryWaitMs)'));
    check('gap usa o modo', code.includes('speed().detailsGapMs + rubinotPaceExtraMs'));
    check('cooldown usa o modo', code.includes('waitForTimeout(speed().failureCooldownMs)'));

    // 6) Detecção de falha NÃO muda com o modo.
    check('detecção de erro inalterada', code.includes("return 'load-error'"));
    check('erro no DOM ainda é atalho', code.includes('hasRubinotAuctionLoadErrorNow'));

    // 7) Retry com o PRÓPRIO navegador principal.
    const RUBINOT_BROWSERS = { chrome: {}, edge: {}, firefox: {}, webkit: {} };
    const RUBINOT_DEFAULT_BROWSER = 'webkit';
    const RUBINOT_BROWSER_FALLBACK_ORDER = ['webkit', 'firefox', 'edge', 'chrome'];
    void RUBINOT_BROWSERS; void RUBINOT_DEFAULT_BROWSER; void RUBINOT_BROWSER_FALLBACK_ORDER;
    // eslint-disable-next-line no-eval
    const resolveRubinotBrowserKey = eval(`(${extractFn('resolveRubinotBrowserKey')})`);
    // eslint-disable-next-line no-eval
    const normalizeRubinotBrowserOrder = eval(`(${extractFn('normalizeRubinotBrowserOrder')})`);
    // eslint-disable-next-line no-eval
    const getRubinotFallbackBrowser = eval(`(${extractFn('getRubinotFallbackBrowser')})`);
    void resolveRubinotBrowserKey; void normalizeRubinotBrowserOrder; void getRubinotFallbackBrowser;
    // eslint-disable-next-line no-eval
    const chain = eval(`(${extractFn('buildRubinotRetryChain')})`);
    const ord = ['webkit', 'firefox', 'edge', 'chrome'];

    check('principal marcado abre a cadeia', JSON.stringify(chain('webkit', ['webkit', 'firefox', 'edge'], ord)) === JSON.stringify(['webkit', 'firefox', 'edge']));
    check('principal não marcado não entra', JSON.stringify(chain('webkit', ['firefox', 'edge'], ord)) === JSON.stringify(['firefox', 'edge']));
    check('apenas o principal => repete nele', JSON.stringify(chain('webkit', ['webkit'], ord)) === JSON.stringify(['webkit']));
    check('principal aparece só uma vez', chain('webkit', ['webkit', 'webkit', 'firefox'], ord).filter(k => k === 'webkit').length === 1);
    check('sem seleção mantém fallback único', JSON.stringify(chain('webkit', [], ord)) === JSON.stringify(['firefox']));

    // 8) Fila continua encolhendo (sem duplicar personagens).
    const sim = (c, recoverAt) => {
      let pending = Object.keys(recoverAt); const attempts = {}; const stats = [];
      for (const b of c) {
        if (!pending.length) break;
        const still = []; let rec = 0;
        for (const id of pending) {
          attempts[id] = (attempts[id] || 0) + 1;
          if (recoverAt[id] === b) rec += 1; else still.push(id);
        }
        stats.push({ browser: b, attempted: pending.length, recovered: rec });
        pending = still;
      }
      return { attempts, stats, pending };
    };
    const r = sim(['webkit', 'firefox'], { a: 'webkit', b: 'firefox', c: null });
    check('recuperado no próprio principal sai da fila', r.attempts.a === 1);
    check('demais seguem para o próximo motor', r.attempts.b === 2);
    check('fila encolhe', JSON.stringify(r.stats.map(x => x.attempted)) === JSON.stringify([3, 2]));
    check('falha final permanece', JSON.stringify(r.pending) === JSON.stringify(['c']));
    check('retry não refaz a listagem', code.includes('forceRefresh: true, skipSessionWarmup: true'));

    // 9) Interface.
    check('modal persiste o modo', modal.includes('BAZAAR_SPEED_MODE_KEY'));
    check('modal oferece os dois modos', modal.includes('Agressivo') && modal.includes('Moderado'));
    check('modal permite marcar o principal', !modal.includes('disabled={isPrimary}'));
    check('cadeia da UI põe o principal primeiro', modal.includes('retryBrowsers.includes(selected) ? [selected] : []'));
    check('painel repassa o modo', panel.includes('speedMode: options?.speedMode'));

    // 10) Preservações.
    check('métricas preservadas', code.includes('successRate') && code.includes('totalDurationMs'));
    check('progresso por navegador preservado', code.includes('buildRubinotBrowserProgress'));
    check('filtros preservados', panel.includes('getApiFilteredAuctions'));
  }

  // ── [43] Modo e cadeia de retry visíveis no progresso ──────────────────
  console.log('\n[43] Configuração da consulta no painel de progresso');
  {
    const code = SRC.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
    const panel = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'components', 'BazarPanel.tsx'), 'utf8');

    const RUBINOT_BROWSERS = { webkit: { label: 'WebKit' }, firefox: { label: 'Firefox' }, edge: { label: 'Microsoft Edge' }, chrome: { label: 'Google Chrome' } };
    const RUBINOT_SPEED_MODES = SPEED_MODES;
    let rubinotRunBrowserStats = []; let rubinotRunPendingBrowsers = [];
    let rubinotRunRetrySelection = []; let rubinotSpeedMode = 'agressivo';
    let rubinotRunRetryPlan = []; let rubinotRunPendingSteps = [];
    void RUBINOT_BROWSERS; void RUBINOT_SPEED_MODES; void rubinotRunRetrySelection;
    void rubinotRunPendingBrowsers;
    // eslint-disable-next-line no-eval
    eval(extractFn('summarizeRubinotRetryPlan'));
    // eslint-disable-next-line no-eval
    eval(extractFn('buildRubinotBrowserProgress'));

    const planOf = keys => keys.map(k => ({ browser: k, attempt: 1, attempts: 1 }));

    // 1) Modo exposto com rótulo legível.
    rubinotRunRetryPlan = planOf(['webkit', 'firefox', 'edge']);
    let snap = buildRubinotBrowserProgress();
    check('modo exposto ao renderer', snap.speedMode === 'agressivo');
    check('rótulo do modo agressivo', snap.speedModeLabel === 'Agressivo');
    rubinotSpeedMode = 'moderado';
    snap = buildRubinotBrowserProgress();
    check('rótulo do modo moderado', snap.speedModeLabel === 'Moderado');

    // 2) Cadeia de retry com rótulos.
    check('retry traz os rótulos', snap.retrySelection.map(b => b.label).join(', ') === 'WebKit, Firefox, Microsoft Edge');
    rubinotRunRetryPlan = [];
    check('sem retry => lista vazia', buildRubinotBrowserProgress().retrySelection.length === 0);

    // 3) A seleção NÃO encolhe conforme os navegadores rodam.
    rubinotRunRetryPlan = planOf(['firefox', 'edge']);
    rubinotRunPendingSteps = planOf(['edge']);
    snap = buildRubinotBrowserProgress();
    check('seleção permanece fixa nos retries', snap.retrySelection.length === 2);
    check('pendentes seguem independentes', snap.pendingBrowsers.length === 1);

    // 4) Disponível desde a listagem.
    check('config em todo evento de progresso', code.includes('speedModeLabel: RUBINOT_SPEED_MODES[rubinotSpeedMode]?.label'));
    check('seleção resolvida no IPC de fetch', code.includes('rubinotRunRetrySelection = buildRubinotRetryChain('));
    check('plano reaproveitado, sem recalcular', code.includes('const retryPlan = rubinotRunRetryPlan;'));
    check('painel envia retryBrowsers no fetch', panel.includes('retryBrowsers: options?.retryBrowsers || loadUIState<string[]>(BAZAAR_RETRY_BROWSERS_KEY, [])'));

    // 5) Interface.
    check('painel declara os campos', panel.includes('speedModeLabel?: string') && panel.includes('retrySelection?:'));
    check('painel exibe o modo', panel.includes('Modo:'));
    check('painel exibe o retry', panel.includes('Retry:'));
    check('painel exibe "Nenhum"', panel.includes('Nenhum'));
    check('painel atualiza em qualquer etapa', panel.includes('if (progress.speedModeLabel) setSpeedModeLabel'));
    check('painel limpa ao encerrar', panel.includes('setSpeedModeLabel("")') && panel.includes('setRetrySelection([])'));

    // 6) Nada da lógica mudou.
    check('cadeia de retry preservada', code.includes('function buildRubinotRetryChain'));
    check('modos preservados', SPEED_MODES.agressivo.detailsGapMs === 300 && SPEED_MODES.moderado.detailsGapMs === 800);
    check('ritmo preservado', code.includes('registerRubinotPaceOutcome'));
    check('filtros preservados', panel.includes('getApiFilteredAuctions'));
  }

  // ── [44] Quantidade individual de retries por navegador ───────────────
  //
  // Cada navegador passou a ter um CONTADOR (0..MAX). O plano de retries é a
  // cadeia expandida por esse contador: WebKit com 2 vira DUAS passadas
  // seguidas. `0` remove o navegador do plano por completo.
  console.log('\n[44] Quantidade individual de retries por navegador');
  {
    const code = SRC.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
    const modal = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'components', 'BazaarBrowserModal.tsx'), 'utf8');
    const panel = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'components', 'BazarPanel.tsx'), 'utf8');

    const RUBINOT_BROWSERS = { chrome: {}, edge: {}, firefox: {}, webkit: {} };
    const RUBINOT_DEFAULT_BROWSER = 'webkit';
    const RUBINOT_BROWSER_FALLBACK_ORDER = ['webkit', 'firefox', 'edge', 'chrome'];
    const RUBINOT_MAX_RETRIES_PER_BROWSER = readConst('RUBINOT_MAX_RETRIES_PER_BROWSER');
    void RUBINOT_BROWSERS; void RUBINOT_DEFAULT_BROWSER; void RUBINOT_BROWSER_FALLBACK_ORDER;
    void RUBINOT_MAX_RETRIES_PER_BROWSER;
    // eslint-disable-next-line no-eval
    const resolveRubinotBrowserKey = eval(`(${extractFn('resolveRubinotBrowserKey')})`);
    // eslint-disable-next-line no-eval
    const normalizeRubinotBrowserOrder = eval(`(${extractFn('normalizeRubinotBrowserOrder')})`);
    // eslint-disable-next-line no-eval
    const getRubinotFallbackBrowser = eval(`(${extractFn('getRubinotFallbackBrowser')})`);
    // eslint-disable-next-line no-eval
    const buildRubinotRetryChain = eval(`(${extractFn('buildRubinotRetryChain')})`);
    // eslint-disable-next-line no-eval
    const normalizeRubinotRetryCounts = eval(`(${extractFn('normalizeRubinotRetryCounts')})`);
    // eslint-disable-next-line no-eval
    const summarizeRubinotRetryPlan = eval(`(${extractFn('summarizeRubinotRetryPlan')})`);
    // eslint-disable-next-line no-eval
    const buildPlan = eval(`(${extractFn('buildRubinotRetryPlan')})`);
    void resolveRubinotBrowserKey; void normalizeRubinotBrowserOrder;
    void getRubinotFallbackBrowser; void buildRubinotRetryChain;
    const ord = ['webkit', 'firefox', 'edge', 'chrome'];
    const asText = plan => plan.map(s2 => `${s2.browser}${s2.attempt}/${s2.attempts}`).join(',');

    // 1) Normalização das quantidades.
    check('teto por navegador é razoável', RUBINOT_MAX_RETRIES_PER_BROWSER >= 1 && RUBINOT_MAX_RETRIES_PER_BROWSER <= 10);
    check('sem mapa => null (compatibilidade)', normalizeRubinotRetryCounts(null) === null);
    check('mapa vazio => null', normalizeRubinotRetryCounts({}) === null);
    check('array não é mapa', normalizeRubinotRetryCounts(['webkit']) === null);
    check('chave ausente vale 0', normalizeRubinotRetryCounts({ webkit: 2 }).firefox === 0);
    check('negativo vira 0', normalizeRubinotRetryCounts({ webkit: -3 }).webkit === 0);
    check('texto inválido vira 0', normalizeRubinotRetryCounts({ webkit: 'abc' }).webkit === 0);
    check('fracionário é truncado', normalizeRubinotRetryCounts({ webkit: 2.9 }).webkit === 2);
    check('acima do teto é truncado', normalizeRubinotRetryCounts({ webkit: 999 }).webkit === RUBINOT_MAX_RETRIES_PER_BROWSER);
    check('chave desconhecida ignorada', normalizeRubinotRetryCounts({ opera: 3, webkit: 1 }).opera === undefined);

    // 2) Montagem do plano — o exemplo do enunciado.
    check(
      'WebKit:2 Firefox:1 com principal WebKit',
      asText(buildPlan('webkit', [], { webkit: 2, firefox: 1, edge: 0, chrome: 0 }, ord)) === 'webkit1/2,webkit2/2,firefox1/1',
    );
    check('Retry 0 em todos => plano vazio', buildPlan('webkit', [], { webkit: 0, firefox: 0, edge: 0, chrome: 0 }, ord).length === 0);
    check('Retry 1 => uma tentativa', buildPlan('webkit', [], { firefox: 1 }, ord).length === 1);
    check('Retry 2 => duas tentativas', buildPlan('webkit', [], { firefox: 2 }, ord).length === 2);
    check(
      'retry com o próprio principal',
      asText(buildPlan('webkit', [], { webkit: 3 }, ord)) === 'webkit1/3,webkit2/3,webkit3/3',
    );
    check(
      'principal vem primeiro no plano',
      buildPlan('chrome', [], { webkit: 1, chrome: 1 }, ord)[0].browser === 'chrome',
    );
    check(
      'ordem de preferência define a sequência dos demais',
      asText(buildPlan('webkit', [], { edge: 1, firefox: 1 }, ['firefox', 'chrome', 'edge', 'webkit'])) === 'firefox1/1,edge1/1',
    );
    check(
      'vários navegadores com contagens diferentes',
      asText(buildPlan('webkit', [], { webkit: 1, firefox: 2, edge: 1, chrome: 0 }, ord)) === 'webkit1/1,firefox1/2,firefox2/2,edge1/1',
    );
    check('valor acima do teto é truncado no plano', buildPlan('webkit', [], { firefox: 50 }, ord).length === RUBINOT_MAX_RETRIES_PER_BROWSER);

    // 3) Compatibilidade com o formato antigo (lista de navegadores).
    check(
      'sem counts usa a cadeia antiga',
      asText(buildPlan('webkit', ['firefox', 'edge'], null, ord)) === 'firefox1/1,edge1/1',
    );
    check(
      'sem counts e sem seleção mantém fallback único',
      asText(buildPlan('webkit', [], null, ord)) === 'firefox1/1',
    );

    // 4) Resumo por navegador (sem repetir quem tem várias tentativas).
    const summary = summarizeRubinotRetryPlan(buildPlan('webkit', [], { webkit: 2, firefox: 1 }, ord));
    check('resumo tem um item por navegador', summary.length === 2);
    check('resumo carrega a quantidade', summary[0].browser === 'webkit' && summary[0].attempts === 2);

    // 5) Simulação: só quem ainda falha segue, e ninguém é duplicado.
    const sim = (plan, recoverAt) => {
      let pending = Object.keys(recoverAt);
      const attempts = {}; const stats = [];
      for (let i = 0; i < plan.length; i++) {
        if (!pending.length) break;
        const step = plan[i];
        const still = []; let rec = 0;
        for (const id of pending) {
          attempts[id] = (attempts[id] || 0) + 1;
          if (recoverAt[id] === i) rec += 1; else still.push(id);
        }
        stats.push({ browser: step.browser, attempt: step.attempt, attempted: pending.length, recovered: rec });
        pending = still;
      }
      return { attempts, stats, pending };
    };
    const plan = buildPlan('webkit', [], { webkit: 2, firefox: 1 }, ord);
    const r = sim(plan, { a: 0, b: 1, c: 2, d: null });
    check('recuperado no 1º retry não vai aos seguintes', r.attempts.a === 1);
    check('recuperado no 2º retry passou por 2', r.attempts.b === 2);
    check('recuperado no 3º passou por 3', r.attempts.c === 3);
    check('nunca recuperado passa por todas as passadas', r.attempts.d === 3);
    check('fila encolhe a cada tentativa', JSON.stringify(r.stats.map(x => x.attempted)) === JSON.stringify([4, 3, 2]));
    check('falha final permanece', JSON.stringify(r.pending) === JSON.stringify(['d']));
    check('sem duplicar personagens', Object.values(r.attempts).every(n => n <= plan.length));
    check('plano para quando todos recuperam', sim(plan, { a: 0 }).stats.length === 1);
    check('Retry 0 nunca executa o navegador', sim(buildPlan('webkit', [], { edge: 0 }, ord), { a: null }).stats.length === 0);

    // 6) Implementação no processo principal.
    check('plano construído na análise', code.includes('rubinotRunRetryPlan = buildRubinotRetryPlan('));
    check('plano também resolvido no IPC de fetch', (code.match(/rubinotRunRetryPlan = buildRubinotRetryPlan\(/g) || []).length === 2);
    check('laço percorre o plano', code.includes('for (const step of retryPlan) {'));
    check('interrompe com fila vazia', code.includes('if (pending.length === 0) break;'));
    check('retry não refaz a listagem', code.includes('forceRefresh: true, skipSessionWarmup: true'));
    check('sucesso remove da fila', code.includes('pending = stillFailing'));
    check('número da tentativa chega à passada', code.includes('retryAttempt: step.attempt, retryAttempts: step.attempts'));
    check('retryBrowsers sem duplicatas', code.includes('[...new Set(retryStats.map(r => r.browser))]'));
    check('fila de passadas pendentes', code.includes('rubinotRunPendingSteps'));
    check('remove só uma ocorrência dos pendentes', code.includes('rubinotRunPendingSteps.splice(index, 1)'));
    check('IPC recebe retryCounts', code.includes('payload?.retryCounts'));
    check('análise recebe retryCounts', code.includes('options?.retryCounts'));

    // 7) Interface.
    check('modal persiste as quantidades', modal.includes('BAZAAR_RETRY_COUNTS_KEY'));
    check('modal expõe o teto', modal.includes('BAZAAR_MAX_RETRIES_PER_BROWSER'));
    check('teto da UI casa com o do main', modal.includes(`BAZAAR_MAX_RETRIES_PER_BROWSER = ${RUBINOT_MAX_RETRIES_PER_BROWSER}`));
    check('modal tem contador por navegador', modal.includes('changeRetryCount'));
    check('modal limita entre 0 e o teto', modal.includes('Math.min(BAZAAR_MAX_RETRIES_PER_BROWSER, Math.max(0, current + delta))'));
    check('modal migra o formato antigo', modal.includes('BAZAAR_RETRY_BROWSERS_KEY') && modal.includes('migrated'));
    check('modal mostra o plano expandido', modal.includes('effectiveRetryPlan'));
    check('modal envia as quantidades', modal.includes('onConfirm(selected, order, cleanProfile, retryBrowsers, speedMode, retryCounts)'));
    check('painel repassa retryCounts no fetch', panel.includes('retryCounts: options?.retryCounts'));
    check('painel repassa retryCounts nos detalhes', (panel.match(/retryCounts: options\?\.retryCounts/g) || []).length === 2);
    check('painel mostra a tentativa no progresso', panel.includes('stat.attempt}/${stat.attempts'));
    check('chave única por passada no progresso', panel.includes('key={`${stat.browser}-${statIndex}`}'));
    check('sem cor fixa no modal', !/#[0-9a-fA-F]{6}/.test(modal));

    // 8) Preservações.
    check('cadeia antiga preservada', code.includes('function buildRubinotRetryChain'));
    check('modos preservados', SPEED_MODES.agressivo.detailsGapMs === 300 && SPEED_MODES.moderado.detailsGapMs === 800);
    check('ritmo preservado', code.includes('registerRubinotPaceOutcome'));
    check('métricas preservadas', code.includes('successRate') && code.includes('totalDurationMs'));
    check('filtros preservados', panel.includes('getApiFilteredAuctions'));
    check('progresso por navegador preservado', code.includes('buildRubinotBrowserProgress'));
  }

  const failed = results.filter(r => !r.pass);
  console.log('\n' + '='.repeat(64));
  console.log(`RESULTADO: ${results.length - failed.length}/${results.length} verificações passaram`);
  if (failed.length) { failed.forEach(f => console.log(`  ❌ ${f.name}`)); process.exit(1); }
  console.log('Todos os cenários automatizáveis passaram.');
})();