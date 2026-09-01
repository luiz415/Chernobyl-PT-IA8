#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * ============================================================================
 * PoC 1/2 — DESCOBERTA de endpoints da página individual do leilão
 * ----------------------------------------------------------------------------
 * ISOLADO. Não é importado pelo app, não vai para o build, não altera nada.
 *
 * OBJETIVO
 *   A listagem já funciona por JSON (`/api/bazaar`). A análise individual, não:
 *   ela renderiza a SPA inteira e faz scraping do DOM. Se a página individual
 *   também se alimentar de um endpoint JSON, dá para trocar render por fetch.
 *
 *   Este script NÃO adivinha o endpoint. Ele ABRE uma página de leilão e
 *   INTERCEPTA todas as chamadas XHR/fetch que a própria página faz, gravando
 *   quais retornam JSON e quais contêm dados de boss/bosstiary.
 *
 * O QUE ELE RESPONDE
 *   • existe endpoint JSON para o leilão individual? qual a URL?
 *   • a Bosstiary vem em JSON ou só é montada no DOM?
 *   • quais cabeçalhos/cookies são exigidos?
 *   • existe dado embutido no HTML (__NEXT_DATA__, __NUXT__, etc.)?
 *   • a Cloudflare bloqueia o fetch direto ou só a navegação?
 *
 * USO (na SUA máquina, com internet e Chrome instalado):
 *   node tools/bazaar-poc/01-discover-endpoints.cjs --ids=<id1,id2>
 *
 * SEGURANÇA
 *   • Só observa o tráfego que o próprio site gera. Não burla nada.
 *   • Amostra pequena (2-3 ids) e sequencial.
 *   • Reutiliza o MESMO perfil persistente do app, para herdar cf_clearance.
 * ============================================================================
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = /^--([^=]+)=?(.*)$/.exec(a); return m ? [m[1], m[2]] : [a, '1'];
}));

const IDS = String(argv.ids || '').split(',').map(s => s.trim()).filter(Boolean);
if (!IDS.length) {
  console.error('ERRO: informe --ids=<id1,id2>  (2 ou 3 leilões ATIVOS bastam)');
  process.exit(1);
}

const OUT_DIR = path.resolve(argv.out || './bazaar-poc-out');
fs.mkdirSync(OUT_DIR, { recursive: true });
const REPORT = path.join(OUT_DIR, `discovery-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

// Mesmo perfil do app: herda a sessão/cf_clearance já validada.
const DEFAULT_PROFILE = process.platform === 'win32'
  ? path.join(os.homedir(), 'AppData', 'Roaming', 'Chernobyl PT', 'rubinot-playwright-profile')
  : path.join(os.homedir(), '.config', 'Chernobyl PT', 'rubinot-playwright-profile');
const PROFILE = argv.profile || DEFAULT_PROFILE;

const BOSS_HINTS = ['bosstiary', 'boss', 'goshnar', 'bakragore', 'kills', 'creature'];

(async () => {
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch { console.error('ERRO: rode na raiz do projeto (playwright não encontrado).'); process.exit(1); }

  console.log(`Perfil: ${PROFILE}`);
  console.log(`Amostra: ${IDS.join(', ')}\n`);

  const launchOpts = {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--lang=pt-BR', '--window-size=1366,850'],
    locale: 'pt-BR', timezoneId: 'America/Sao_Paulo', viewport: { width: 1366, height: 850 },
  };

  let context;
  try { context = await chromium.launchPersistentContext(PROFILE, { ...launchOpts, channel: 'chrome' }); }
  catch { context = await chromium.launchPersistentContext(PROFILE, launchOpts); }

  const report = { profile: PROFILE, generatedAt: new Date().toISOString(), auctions: [] };

  for (const id of IDS) {
    const url = `https://rubinot.com.br/bazaar/${encodeURIComponent(id)}`;
    console.log(`\n=== Leilão ${id} ===`);
    const page = await context.newPage();
    const captured = [];

    page.on('response', async (res) => {
      try {
        const rurl = res.url();
        const req = res.request();
        const type = req.resourceType();
        // Só XHR/fetch: é onde vivem as APIs internas.
        if (type !== 'xhr' && type !== 'fetch') return;
        const ct = res.headers()['content-type'] || '';
        const entry = {
          url: rurl.slice(0, 300), method: req.method(), status: res.status(),
          contentType: ct.slice(0, 60), isJson: ct.includes('json'),
        };
        if (entry.isJson) {
          let body = null;
          try { body = await res.json(); } catch (_) {}
          if (body) {
            const text = JSON.stringify(body).toLowerCase();
            entry.jsonSizeBytes = JSON.stringify(body).length;
            entry.topLevelKeys = Array.isArray(body) ? ['<array>'] : Object.keys(body).slice(0, 25);
            entry.mentionsBoss = BOSS_HINTS.filter(h => text.includes(h));
            entry.looksLikeAuctionDetail = /\/bazaar\/[^/?]+$/.test(rurl.split('?')[0]) || text.includes('"auction"');
            // Amostra MÍNIMA, só para identificar o formato.
            entry.sample = JSON.stringify(body).slice(0, 600);
          }
        }
        captured.push(entry);
      } catch (_) {}
    });

    const t0 = Date.now();
    let navError = '';
    try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }); }
    catch (e) { navError = String(e && e.message || e).slice(0, 160); }

    // Dá tempo para a SPA disparar suas chamadas.
    await page.waitForTimeout(6000);

    // Tenta abrir a aba Bosstiary — as chamadas dela são as mais importantes.
    let bosstiaryClicked = false;
    try {
      const tab = page.locator("button:has-text('Bosstiary'), a:has-text('Bosstiary'), [role='tab']:has-text('Bosstiary')").first();
      if (await tab.waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false)) {
        await tab.click();
        bosstiaryClicked = true;
        await page.waitForTimeout(4000);
      }
    } catch (_) {}

    // Dados embutidos no HTML (SSR/hidratação) — alternativa ao endpoint.
    const embedded = await page.evaluate(() => {
      const out = {};
      for (const key of ['__NEXT_DATA__', '__NUXT__', '__INITIAL_STATE__', '__APP_STATE__']) {
        if (window[key]) { try { out[key] = JSON.stringify(window[key]).length; } catch (_) { out[key] = 'presente'; } }
      }
      const jsonScripts = Array.from(document.querySelectorAll('script[type="application/json"], script[id*="data" i]'))
        .map(s => ({ id: s.id || '(sem id)', length: (s.textContent || '').length }));
      return { globals: out, jsonScripts, htmlLength: document.documentElement.innerHTML.length };
    }).catch(() => ({}));

    const jsonCalls = captured.filter(c => c.isJson);
    const bossCalls = jsonCalls.filter(c => (c.mentionsBoss || []).length > 0);

    console.log(`  navegação: ${navError || 'ok'}  (${Date.now() - t0}ms)`);
    console.log(`  Bosstiary clicada: ${bosstiaryClicked}`);
    console.log(`  XHR/fetch capturados: ${captured.length}  | JSON: ${jsonCalls.length}  | com dados de boss: ${bossCalls.length}`);
    for (const c of jsonCalls) {
      const flag = (c.mentionsBoss || []).length ? '  <== BOSS' : '';
      console.log(`    [${c.status}] ${c.method} ${c.url}${flag}`);
    }
    if (embedded.globals && Object.keys(embedded.globals).length) {
      console.log(`  dados embutidos no HTML: ${JSON.stringify(embedded.globals)}`);
    }

    report.auctions.push({ id, url, navError, bosstiaryClicked, elapsedMs: Date.now() - t0, embedded, captured });
    await page.close();
    await new Promise(r => setTimeout(r, 1500));
  }

  await context.close();
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2), 'utf8');

  // ── Veredito ───────────────────────────────────────────────────────────
  const all = report.auctions.flatMap(a => a.captured.filter(c => c.isJson));
  const bossEndpoints = [...new Set(all.filter(c => (c.mentionsBoss || []).length).map(c => c.url.split('?')[0]))];
  console.log('\n' + '='.repeat(70));
  console.log('VEREDITO');
  if (bossEndpoints.length) {
    console.log('  ✅ EXISTE endpoint JSON com dados de boss:');
    bossEndpoints.forEach(u => console.log(`     ${u}`));
    console.log('\n  => Rode o PoC 2 para validar o fetch direto (sem render).');
  } else if (all.length) {
    console.log('  ⚠️  Há endpoints JSON, mas nenhum com dados de boss.');
    console.log('     A Bosstiary pode ser montada só no cliente. Verifique o');
    console.log('     JSON de detalhe do leilão no relatório.');
  } else {
    console.log('  ❌ Nenhuma chamada JSON capturada. A página pode ser SSR pura;');
    console.log('     nesse caso a alternativa é ler os dados embutidos no HTML.');
  }
  console.log(`\nRelatório completo: ${REPORT}`);
})();