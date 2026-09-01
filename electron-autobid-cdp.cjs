// ============================================================================
// AUTO BID — MODO CDP (módulo isolado do processo principal)
// ----------------------------------------------------------------------------
// Executa o Bid conectando a um NAVEGADOR REAL (Chrome/Edge) que o usuário
// abriu e autenticou manualmente, via Chrome DevTools Protocol (CDP).
//
// Fluxo:
//   1. "Abrir navegador / Conectar" → o app inicia o Chrome/Edge real com uma
//      porta de depuração remota (--remote-debugging-port) e um perfil próprio.
//      NENHUMA navegação automática acontece: a janela abre em branco.
//   2. O USUÁRIO navega até o RubinOT, resolve a verificação e faz o login
//      manualmente (sessão real, sem nenhuma técnica de stealth/bypass).
//   3. O app conecta via CDP (`chromium.connectOverCDP`) à porta de depuração
//      e reutiliza a sessão já autenticada.
//   4. No momento configurado, navega para a URL oficial de Bid (via CDP) e
//      aciona o botão "Submit Bid" pelo DOM da página real.
//
// Apenas navegadores Chromium (Chrome/Edge) suportam CDP. Firefox/WebKit não.
// ============================================================================

'use strict';

const { spawn } = require('child_process');
const path = require('path');

let deps = null;

// ============================================================================
// Estado do modo CDP
// ============================================================================
let cdpBrowser = null;        // Browser conectado via connectOverCDP
let cdpContext = null;        // contexto padrão (persistente) do navegador
let cdpChild = null;          // processo filho do navegador iniciado por nós
let cdpPort = 0;              // porta de depuração em uso
let cdpBrowserKey = '';       // chrome | edge
let cdpProfiledir = '';       // perfil próprio do Auto Bid CDP
const cdpExecutingKeys = new Set();   // lances em execução AGORA
const cdpExecutedKeys = new Set();    // lances já executados nesta sessão

function diag(scope, message, data = {}) {
  try { deps.diag(`AutoBid:Cdp:${scope}`, message, data); }
  catch (_) { try { deps.diag(`AutoBid:Cdp:${scope}`, message); } catch (__) {} }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function resolveKey(value) {
  const key = String(value || '').trim().toLowerCase();
  return (key === 'chrome' || key === 'edge') ? key : 'chrome';
}

function isSessionValid(state) {
  return state && state.status === 'validada' && state.looksAuthenticated === true;
}

// ============================================================================
// Inicialização do navegador com porta de depuração
// ============================================================================
function resolvePort() {
  // Porta de depuração: fixa por padrão, mas se estiver ocupada tenta a
  // próxima. Evita colidir com outro app de depuração.
  const base = Number(deps.defaultPort || 9222);
  return base;
}

function execPathFor(key) {
  const info = deps.resolveExecutable(key);
  return info || null;
}

async function launchBrowser(key) {
  const normalized = resolveKey(key);
  const exe = deps.resolveExecutable(normalized);
  if (!exe) {
    throw new Error(`Navegador ${normalized} não encontrado para o modo CDP.`);
  }

  const port = resolvePort();
  const profileDir = path.join(deps.getUserDataPath(), `rubinot-autobid-cdp-${normalized}`);
  deps.ensureDir(profileDir);

  diag('launch', 'Iniciando navegador real para CDP (porta de depuração).', { browser: normalized, port, profileDir });

  // Inicia o Chrome/Edge real com depuração remota. Não navega para lugar
  // nenhum: a janela abre em branco/inicial e o usuário faz tudo manualmente.
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-infobars',
    'about:blank',
  ];

  cdpChild = spawn(exe, args, { stdio: 'ignore', detached: false });
  cdpChild.on('error', (error) => {
    diag('launch', 'Erro ao iniciar navegador CDP.', { error: String(error?.message || error) });
    deps.notify('desconectado', `Falha ao iniciar o navegador: ${String(error?.message || error)}`);
    cdpChild = null;
  });
  cdpChild.on('exit', () => {
    diag('launch', 'Navegador CDP encerrado.', { browser: cdpBrowserKey });
    cdpChild = null;
    cdpBrowser = null;
    cdpContext = null;
    deps.notify('desconectado', 'Navegador CDP foi fechado.');
  });

  cdpPort = port;
  cdpBrowserKey = normalized;
  cdpProfiledir = profileDir;
  return { port };
}

async function waitForCdpEndpoint(port, timeoutMs = 20000) {
  const startedAt = Date.now();
  // O endpoint do CDP fica em http://127.0.0.1:<port>/json/version.
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await deps.fetchText(`http://127.0.0.1:${port}/json/version`);
      if (res) return true;
    } catch (_) { /* ainda não está pronto */ }
    await sleep(500);
  }
  return false;
}

async function connectToCdp(key) {
  const normalized = resolveKey(key);

  // Se já está conectado ao mesmo navegador, reutiliza.
  if (cdpBrowser && cdpBrowserKey === normalized) return { ok: true, already: true };

  // Encerra conexão anterior se o navegador for outro.
  if (cdpBrowser) await disconnectCdp('troca-de-navegador');

  // Inicia o navegador (se ainda não estiver em execução) e conecta.
  if (!cdpChild) {
    await launchBrowser(normalized);
  }
  const ready = await waitForCdpEndpoint(cdpPort);
  if (!ready) {
    throw new Error(`Não foi possível conectar ao CDP na porta ${cdpPort}.`);
  }

  const playwright = require('playwright');
  cdpBrowser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);

  // Escolhe o contexto PERSISTENTE (o primeiro com páginas reais), em vez de
  // criar um contexto novo que não teria os cookies do perfil. Nenhum
  // `newContext()` é usado aqui — um contexto novo seria EPHEMERAL e perderia a
  // sessão do usuário.
  const contexts = cdpBrowser.contexts();
  cdpContext = contexts.find(ctx => ctx.pages().length > 0) || contexts[0] || null;

  cdpBrowser.on('disconnected', () => {
    diag('cdp', 'Conexão CDP perdida.', { browser: cdpBrowserKey });
    cdpBrowser = null;
    cdpContext = null;
    deps.notify('desconectado', 'Conexão CDP perdida.');
  });

  diag('cdp', 'Conectado ao navegador via CDP.', { browser: normalized, port: cdpPort });
  return { ok: true };
}

// ============================================================================
// Estado da sessão
// ============================================================================
/**
 * Lê os cookies do domínio do RubinOT diretamente via CDP (browser-level).
 *
 * Motivo: ao conectar a um navegador real com `connectOverCDP`, a API
 * `context.cookies()` do Playwright pode não refletir os cookies do perfil
 * persistente do navegador. Ler via `Network.getAllCookies` do protocolo CDP
 * (que espelha os cookies reais do navegador) é mais confiável para detectar o
 * login manual.
 */
async function readCdpCookies() {
  if (!cdpBrowser) return { ok: false, cookies: [] };
  try {
    const session = await cdpBrowser.newBrowserCDPSession();
    const { cookies } = await session.send('Network.getAllCookies');
    // Filtro AMPLO: qualquer domínio que contenha "rubinot" (inclui subdomínios
    // como www.rubinot.com.br, auth.rubinot.com.br, etc.).
    return {
      ok: true,
      cookies: (cookies || []).filter(c =>
        String(c.domain || '').includes('rubinot.com')
      ),
    };
  } catch (error) {
    diag('session', 'Falha ao ler cookies via CDP.', { error: String(error?.message || error) });
    return { ok: false, cookies: [] };
  }
}

/** Nomes de cookie que indicam sessão de aplicação (mesmos hints do main). */
const SESSION_HINT_RE = /session|laravel|remember|auth|token|sid|login|user/i;
const CLOUDFLARE_RE = /^cf_|^__cf/i;

/**
 * Normaliza uma lista de cookies CDP para um estado de sessão.
 */
function stateFromCookies(cookieList, nowSec) {
  const names = (cookieList || []).map(c => String(c.name || ''));
  const sessionNames = names.filter(n => SESSION_HINT_RE.test(n) && !CLOUDFLARE_RE.test(n));
  const clearance = (cookieList || []).find(c => c.name === 'cf_clearance');
  const isExpired = (c) => typeof c.expires === 'number' && c.expires > 0 && c.expires < nowSec;
  const expiredSession = sessionNames.length > 0 && (cookieList || []).filter(c => sessionNames.includes(c.name)).every(isExpired);

  let status = 'nao-validada';
  if (sessionNames.length > 0 && !expiredSession) status = 'validada';
  else if (expiredSession || (clearance && isExpired(clearance) && sessionNames.length > 0)) status = 'expirada';

  return {
    status,
    hasAnyCookie: (cookieList || []).length > 0,
    totalCookies: (cookieList || []).length,
    hasCfClearance: !!clearance && !isExpired(clearance),
    cfClearanceExpiresAt: clearance && typeof clearance.expires === 'number' && clearance.expires > 0 ? Math.round(clearance.expires) : 0,
    sessionCookiePersistent: (cookieList || []).some(c => sessionNames.includes(c.name) && typeof c.expires === 'number' && c.expires > 0),
    looksAuthenticated: sessionNames.length > 0 && !expiredSession,
    cookieNames: names.slice(0, 30),
    sessionCookieNames: sessionNames.slice(0, 30),
  };
}

/**
 * Detecta autenticação pela DOM da página aberta do RubinOT.
 *
 * Esta é a fonte MAIS confiável e independente de suposição de cookies: avalia,
 * na página real que o usuário deixou aberta, marcadores que só existem quando
 * há uma conta autenticada (ex.: link/menu de logout, nome de usuário, avatar,
 * "Minha conta") — e que NÃO existem quando deslogado (que costuma mostrar
 * "Entrar"/"Cadastrar").
 *
 * Não lê valores sensíveis: apenas textos e atributos de navegação.
 */
async function detectAuthViaDom() {
  const result = {
    ok: false,
    foundPage: false,
    markers: { logout: false, account: false, loginForm: false, userName: '' },
    url: '',
    pageCount: 0,
  };
  try {
    if (!cdpBrowser) return result;

    // Reúne todas as páginas de todos os contextos do navegador conectado.
    let pages = [];
    try {
      const contexts = cdpBrowser.contexts();
      contexts.forEach(ctx => { pages = pages.concat(ctx.pages()); });
    } catch (_) {}
    result.pageCount = pages.length;

    // Procura a primeira página aberta do RubinOT (não-cloudflare).
    const target = pages.find(p => {
      try {
        const u = p.url() || '';
        return u.includes('rubinot.com') && !u.includes('/cdn-cgi/');
      } catch { return false; }
    });

    if (!target) {
      diag('session', 'Detecção DOM: nenhuma página do RubinOT aberta para inspecionar.', { pageCount: pages.length });
      return result;
    }

    try { result.url = target.url(); } catch (_) {}
    result.foundPage = true;

    // Avalia marcadores comuns de conta autenticada. Nenhum valor sensível.
    const markers = await target.evaluate(() => {
      const bodyText = (document.body?.innerText || '').toLowerCase();
      const hrefs = Array.from(document.querySelectorAll('a[href]')).map(a => (a.getAttribute('href') || '').toLowerCase());
      const hasLogoutHref = hrefs.some(h => h.includes('/logout') || h.includes('sair') || h.includes('signout') || h.includes('logoff'));
      const textLogout = /\b(logout|log out|sair|sign out|encerrar sessão)\b/.test(bodyText);
      const textAccount = /(minha conta|my account|account|perfil|dashboard)/.test(bodyText);
      const textLoginForm = /\b(entrar|login|sign in|log in|acessar conta)\b/.test(bodyText);
      return {
        logout: hasLogoutHref || textLogout,
        account: textAccount,
        loginForm: textLoginForm,
      };
    }).catch(() => ({ logout: false, account: false, loginForm: false }));

    result.markers = markers;
    diag('session', 'Detecção DOM — marcadores da página do RubinOT.', { url: result.url, markers });
    return result;
  } catch (error) {
    diag('session', 'Falha na detecção DOM.', { error: String(error?.message || error) });
    return result;
  }
}

async function currentSessionState() {
  if (!cdpBrowser) {
    return { ok: true, status: 'nao-validada', looksAuthenticated: false, hasCfClearance: false, cfClearanceExpiresAt: 0, sessionCookiePersistent: false, cookieNames: [], sessionCookieNames: [] };
  }

  const nowSec = Math.floor(Date.now() / 1000);

  // ── A) DETECÇÃO VIA DOM (fonte mais confiável e independente de cookie) ──
  const dom = await detectAuthViaDom();
  diag('session', 'Verificação de sessão (DOM).', {
    foundPage: dom.foundPage, url: dom.url, markers: dom.markers, pageCount: dom.pageCount,
  });
  if (dom.foundPage) {
    // Autenticado se houver marcador de logout/conta E não houver formulário de
    // login dominante. Se houver logout/account explícito → CONECTADO.
    const authed = (dom.markers.logout || dom.markers.account) && !dom.markers.loginForm;
    const status = authed ? 'validada' : 'nao-validada';
    if (status === 'validada') deps.notify('conectado', '');
    else deps.notify('desconectado', '');
    return {
      ok: true,
      browser: cdpBrowserKey,
      status,
      source: 'dom',
      foundPage: dom.foundPage,
      url: dom.url,
      markers: dom.markers,
      hasAnyCookie: false, totalCookies: 0, hasCfClearance: false, cfClearanceExpiresAt: 0,
      sessionCookiePersistent: false, looksAuthenticated: authed, cookieNames: [], sessionCookieNames: [],
    };
  }

  // ── B) Cookies (fallback — quando não há página aberta do RubinOT) ──────
  // Lê TODOS os cookies do contexto (sem restringir a um domínio exato), pois o
  // cookie de sessão pode estar em subdomínio (www., auth., etc.).
  let best = null;
  if (cdpContext) {
    try {
      const all = await cdpContext.cookies();
      const rubinot = (all || []).filter(c => String(c.domain || '').includes('rubinot.com'));
      if (rubinot.length > 0) {
        const mapped = rubinot.map(c => ({ name: c.name, domain: c.domain, expires: typeof c.expires === 'number' ? c.expires : -1 }));
        best = stateFromCookies(mapped, nowSec);
        diag('session', 'Cookies do contexto (RubinOT).', {
          count: rubinot.length,
          domains: [...new Set(mapped.map(c => c.domain))],
          sessionNames: best.sessionCookieNames,
        });
      }
    } catch (_) {}
  }

  // Suplemento: Network.getAllCookies via CDP (cookies do browser inteiro).
  if (!best || !best.looksAuthenticated) {
    const cdp = await readCdpCookies();
    if (cdp.ok && cdp.cookies.length > 0) {
      const s = stateFromCookies(cdp.cookies, nowSec);
      if (s.looksAuthenticated) best = s;
      diag('session', 'Cookies via CDP getAllCookies.', { count: cdp.cookies.length, sessionNames: s.sessionCookieNames });
    }
  }

  if (!best) {
    if (cdpContext) {
      try { best = await deps.inspectSessionState(cdpContext); } catch (_) {}
    }
    if (!best) {
      return { ok: true, status: 'nao-validada', looksAuthenticated: false, hasCfClearance: false, cfClearanceExpiresAt: 0, sessionCookiePersistent: false, cookieNames: [], sessionCookieNames: [] };
    }
  }

  if (best.status === 'expirada') deps.notify('expirada', 'Sessão expirada.');
  else if (best.status === 'validada') deps.notify('conectado', '');
  else deps.notify('desconectado', '');
  return { ok: true, browser: cdpBrowserKey, source: 'cookie', ...best };
}

// ============================================================================
// Execução do lance
// ============================================================================
async function tryClickSubmitBid(page) {
  const candidates = [
    () => page.getByRole('button', { name: /submit/i }).first(),
    () => page.locator('button:has-text("Submit Bid")').first(),
    () => page.locator('input[type="submit"]').first(),
    () => page.locator('button[type="submit"]').first(),
  ];
  for (const make of candidates) {
    let locator = null;
    try { locator = make(); } catch (_) { continue; }
    try {
      if (await locator.isVisible({ timeout: 2500 }).catch(() => false)) {
        await locator.scrollIntoViewIfNeeded({ timeout: 2500 }).catch(() => {});
        await locator.click({ timeout: 5000 });
        return { clicked: true, how: locator.toString() };
      }
    } catch (_) {}
  }
  return { clicked: false, how: '' };
}

async function executeBid({ bidUrl, auctionId, auctionEndTs, browser }) {
  const key = resolveKey(browser);
  const execKey = `${key}|${auctionId}|${auctionEndTs}`;

  // Anti-duplicado em memória (o renderer também tem ledger persistido).
  if (cdpExecutingKeys.has(execKey)) return { ok: false, status: 'executando', detail: 'Já em execução.' };
  if (cdpExecutedKeys.has(execKey)) return { ok: false, status: 'concluido', detail: 'Lance já executado.', deduplicated: true };

  cdpExecutingKeys.add(execKey);
  try {
    if (!cdpBrowser || !cdpContext) {
      // Tenta reconectar (o navegador pode ter sido aberto depois do app).
      const conn = await connectToCdp(key);
      if (!conn.ok) return { ok: false, status: 'desconectado', detail: 'Sem conexão CDP.' };
    }

    // Confirma sessão válida antes de qualquer navegação (usando a mesma lógica
    // robusta de `currentSessionState` — cookies do contexto real).
    const session = await currentSessionState();
    if (!isSessionValid(session)) {
      deps.notify('desconectado', 'Sessão inválida no momento do lance.');
      return { ok: false, status: 'desconectado', detail: 'Sessão não autenticada. Lance NÃO foi enviado.', sessionStatus: session.status };
    }

    if (!bidUrl) {
      return { ok: false, status: 'falhou', detail: 'URL de Bid ausente.' };
    }

    diag('bid', 'Executando lance via CDP na URL oficial.', { auctionId, auctionEndTs, bidUrl });
    const page = cdpContext.pages().find(p => !p.isClosed()) || await cdpContext.newPage();
    await page.goto(bidUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // Pequena espera para o formulário de lance montar.
    await sleep(1800);

    const attempt = await tryClickSubmitBid(page);
    if (attempt.clicked) {
      await sleep(1500);
      cdpExecutedKeys.add(execKey);
      diag('bid', 'Submit Bid clicado via CDP.', { auctionId, how: attempt.how });
      return { ok: true, status: 'concluido', detail: 'Submit Bid clicado (CDP).', how: attempt.how, mode: 'cdp' };
    }

    return { ok: false, status: 'falhou', detail: 'Botão Submit Bid não encontrado na página de lance.', url: bidUrl, mode: 'cdp' };
  } catch (error) {
    diag('bid', 'Falha ao executar lance via CDP.', { error: String(error?.message || error) });
    return { ok: false, status: 'falhou', detail: String(error?.message || error), mode: 'cdp' };
  } finally {
    cdpExecutingKeys.delete(execKey);
  }
}

async function disconnectCdp(reason = 'usuario-solicitou') {
  diag('cdp', 'Encerrando conexão CDP.', { reason });
  try { if (cdpBrowser) await cdpBrowser.close(); } catch (_) {}
  cdpBrowser = null;
  cdpContext = null;
  // Fecha o navegador iniciado pelo app (o usuário decide fechar o próprio).
  if (cdpChild) {
    try { cdpChild.kill(); } catch (_) {}
    cdpChild = null;
  }
  deps.notify('desconectado', reason === 'usuario-solicitou' ? 'Desconectado pelo usuário.' : reason);
}

// ============================================================================
// Registro
// ============================================================================
function registerCdpMode(registration) {
  deps = {
    diag: registration.diag,
    notify: registration.notify,
    inspectSessionState: registration.inspectSessionState,
    resolveExecutable: registration.resolveExecutable,
    getUserDataPath: registration.getUserDataPath,
    ensureDir: registration.ensureDir,
    fetchText: registration.fetchText || (async (url) => {
      try {
        const res = await fetch(url);
        return res.ok ? await res.text() : '';
      } catch (_) { return ''; }
    }),
    defaultPort: registration.defaultPort || 9222,
  };
  return {
    key: 'cdp',
    label: 'CDP',
    connect: (payload) => connectToCdp(payload?.browser || payload?.browserKey),
    sessionState: () => currentSessionState(),
    executeBid: (payload) => executeBid(payload),
    disconnect: (payload) => disconnectCdp(payload?.reason),
    // Sinal leve de "navegador aberto/conectado" — apenas lê a referência em
    // memória, SEM consultar cookies/DOM/CDP. Permite que o renderer decida se
    // há motivo para monitorar a sessão (sob demanda).
    isOpen: () => !!cdpBrowser,
  };
}

module.exports = { registerCdpMode };