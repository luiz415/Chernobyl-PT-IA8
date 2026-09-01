#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * ============================================================================
 * PoC 2/2 — VALIDAÇÃO do fetch direto vs. render da SPA
 * ----------------------------------------------------------------------------
 * ISOLADO. Não conectado ao fluxo de produção.
 *
 * OBJETIVO
 *   Comparar, sobre a MESMA amostra, as duas estratégias:
 *
 *     A) ATUAL   — page.goto() + esperar SPA + clicar Bosstiary + scraping DOM
 *     B) NOVA    — page.evaluate(fetch) no endpoint JSON, sem render
 *
 *   Mede taxa de sucesso, tempo médio e nº de requisições de cada uma.
 *   É a evidência que decide se vale migrar.
 *
 * USO
 *   1) Rode primeiro o PoC 1 para descobrir o endpoint.
 *   2) node tools/bazaar-poc/02-validate-direct-fetch.cjs \
 *        --ids=<id1,id2,id3,id4,id5> \
 *        --endpoint="https://rubinot.com.br/api/bazaar/{id}"
 *
 *   `{id}` é substituído pelo id do leilão.
 *   Sem --endpoint, só a estratégia A é medida (linha de base).
 *
 * SEGURANÇA
 *   • Usa a MESMA técnica já em produção na listagem: fetch de dentro da
 *     página, herdando cookies/cf_clearance. Não burla nada.
 *   • Amostra pequena, sequencial, com intervalo.
 * ============================================================================
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = /^--([^=]+)=?(.*)$/.exec(a); return m ? [m[1], m[2]] : [a, '1'];
}));

const IDS = String(argv.ids || '').split(',').map(s => s.trim()).filter(Boolean);
const ENDPOINT = String(argv.endpoint || '').trim();
const DELAY = Number(argv.delay || 1200);

if (!IDS.length) {
  console.error('ERRO: informe --ids=<id1,id2,...> (use os MESMOS ids nas duas estratégias)');
  process.exit(1);
}

const OUT_DIR = path.resolve(argv.out || './bazaar-poc-out');
fs.mkdirSync(OUT_DIR, { recursive: true });
const REPORT = path.join(OUT_DIR, `compare-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

const DEFAULT_PROFILE = process.platform === 'win32'
  ? path.join(os.homedir(), 'AppData', 'Roaming', 'Chernobyl PT', 'rubinot-playwright-profile')
  : path.join(os.homedir(), '.config', 'Chernobyl PT', 'rubinot-playwright-profile');
const PROFILE = argv.profile || DEFAULT_PROFILE;

const BAZAAR_URL = 'https://rubinot.com.br/bazaar';

/** Estratégia A: exatamente o que o app faz hoje. */
async function strategyRender(page, id) {
  const url = `https://rubinot.com.br/bazaar/${encodeURIComponent(id)}`;
  const t0 = Date.now();
  let requests = 0;
  const count = () => { requests++; };
  page.on('request', count);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
    const tab = page.locator("button:has-text('Bosstiary'), a:has-text('Bosstiary'), [role='tab']:has-text('Bosstiary')").first();
    const appeared = await tab.waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false);
    if (!appeared) return { ok: false, reason: 'BOSSTIARY_NAO_APARECEU', elapsedMs: Date.now() - t0, requests };
    await tab.click();
    await page.waitForFunction(() => !!document.querySelector('tbody tr td:nth-child(3)'), { timeout: 8000 }).catch(() => {});
    const bosses = await page.evaluate(() => Array.from(document.querySelectorAll('tbody tr'))
      .map(r => (r.querySelectorAll('td')[2]?.textContent || '').trim()).filter(Boolean));
    return { ok: bosses.length > 0, bossCount: bosses.length, elapsedMs: Date.now() - t0, requests, reason: bosses.length ? 'OK' : 'TABELA_VAZIA' };
  } catch (e) {
    return { ok: false, reason: String(e && e.message || e).slice(0, 120), elapsedMs: Date.now() - t0, requests };
  } finally {
    page.off('request', count);
  }
}

/** Estratégia B: fetch JSON direto, sem renderizar a página do leilão. */
async function strategyFetch(page, id) {
  const target = ENDPOINT.replace('{id}', encodeURIComponent(id));
  const t0 = Date.now();
  const res = await page.evaluate(async ({ targetUrl, referer }) => {
    try {
      const r = await fetch(targetUrl, {
        credentials: 'include',
        headers: { Accept: 'application/json, text/plain, */*', Referer: referer, 'X-Requested-With': 'XMLHttpRequest' },
      });
      const ct = r.headers.get('content-type') || '';
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch (_) {}
      return { ok: r.ok, status: r.status, contentType: ct, isJson: !!json, raw: json ? JSON.stringify(json) : text.slice(0, 200) };
    } catch (e) { return { ok: false, status: 0, error: String(e && e.message || e) }; }
  }, { targetUrl: target, referer: BAZAAR_URL });

  const elapsedMs = Date.now() - t0;
  if (!res.ok || !res.isJson) {
    return { ok: false, reason: res.status === 403 ? 'BLOQUEIO_403' : res.status === 429 ? 'RATE_LIMIT' : `HTTP_${res.status}`, status: res.status, elapsedMs, requests: 1 };
  }
  // Procura nomes de boss no JSON, sem assumir o formato exato.
  const lower = String(res.raw || '').toLowerCase();
  const hasBossData = ['bosstiary', 'goshnar', 'bakragore', 'boss'].some(h => lower.includes(h));
  return { ok: true, reason: 'OK', hasBossData, jsonBytes: (res.raw || '').length, status: res.status, elapsedMs, requests: 1 };
}

(async () => {
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch { console.error('ERRO: rode na raiz do projeto.'); process.exit(1); }

  const launchOpts = {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--lang=pt-BR', '--window-size=1366,850'],
    locale: 'pt-BR', timezoneId: 'America/Sao_Paulo', viewport: { width: 1366, height: 850 },
  };
  let context;
  try { context = await chromium.launchPersistentContext(PROFILE, { ...launchOpts, channel: 'chrome' }); }
  catch { context = await chromium.launchPersistentContext(PROFILE, launchOpts); }

  const page = context.pages()[0] || await context.newPage();
  // A estratégia B exige estar num contexto do domínio (para herdar cookies).
  await page.goto(BAZAAR_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(3000);

  const results = { render: [], fetch: [] };

  console.log(`\n=== [A] Estratégia ATUAL (render + scraping) — ${IDS.length} leilões ===`);
  for (const id of IDS) {
    const r = await strategyRender(page, id);
    results.render.push({ id, ...r });
    console.log(`  ${String(id).padEnd(10)} ${r.ok ? 'OK ' : 'FALHA'}  ${String(r.elapsedMs).padStart(6)}ms  reqs=${r.requests}  ${r.reason}`);
    await page.waitForTimeout(DELAY);
  }

  if (ENDPOINT) {
    console.log(`\n=== [B] Estratégia NOVA (fetch JSON direto) — ${ENDPOINT} ===`);
    await page.goto(BAZAAR_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(2000);
    for (const id of IDS) {
      const r = await strategyFetch(page, id);
      results.fetch.push({ id, ...r });
      console.log(`  ${String(id).padEnd(10)} ${r.ok ? 'OK ' : 'FALHA'}  ${String(r.elapsedMs).padStart(6)}ms  reqs=1  ${r.reason}${r.hasBossData ? '  (contém boss)' : ''}`);
      await page.waitForTimeout(DELAY);
    }
  } else {
    console.log('\n[B] pulada: informe --endpoint="..." (descoberto pelo PoC 1).');
  }

  await context.close();

  const summarize = (list) => {
    if (!list.length) return null;
    const ok = list.filter(r => r.ok).length;
    return {
      total: list.length, ok, rate: Math.round((ok / list.length) * 100),
      avgMs: Math.round(list.reduce((s, r) => s + r.elapsedMs, 0) / list.length),
      totalRequests: list.reduce((s, r) => s + (r.requests || 0), 0),
    };
  };
  const sr = summarize(results.render);
  const sf = summarize(results.fetch);

  console.log('\n' + '='.repeat(70));
  console.log('RESUMO COMPARATIVO');
  console.log('  estratégia                 OK/total   taxa    tempo médio   requisições');
  console.log('  ' + '-'.repeat(68));
  if (sr) console.log(`  A) render + scraping       ${String(sr.ok + '/' + sr.total).padEnd(10)} ${String(sr.rate + '%').padEnd(7)} ${String(sr.avgMs + 'ms').padEnd(13)} ${sr.totalRequests}`);
  if (sf) console.log(`  B) fetch JSON direto       ${String(sf.ok + '/' + sf.total).padEnd(10)} ${String(sf.rate + '%').padEnd(7)} ${String(sf.avgMs + 'ms').padEnd(13)} ${sf.totalRequests}`);
  if (sr && sf) {
    console.log('');
    if (sf.rate > sr.rate) console.log(`  ✅ MIGRAR: +${sf.rate - sr.rate} pontos de taxa, ${Math.round(sr.avgMs / Math.max(1, sf.avgMs))}x mais rápido, ${Math.round(sr.totalRequests / Math.max(1, sf.totalRequests))}x menos requisições.`);
    else console.log('  ⚠️  A estratégia B não superou a atual. Não migrar ainda.');
  }
  fs.writeFileSync(REPORT, JSON.stringify({ endpoint: ENDPOINT, ids: IDS, results, summary: { render: sr, fetch: sf } }, null, 2), 'utf8');
  console.log(`\nRelatório: ${REPORT}`);
})();