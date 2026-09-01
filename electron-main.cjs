const { app, BrowserWindow, Notification, screen, ipcMain, shell, dialog, Tray, Menu, session } = require('electron');
const path = require('path');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const { autoUpdater } = require('electron-updater');

// ============================================================================
// IDENTIDADE DO APP — deve ficar antes de app.whenReady()
// ============================================================================
app.setName('Chernobyl PT');
app.setAppUserModelId('com.chernobyl.pt');

// ============================================================================
// ESTADO GLOBAL
// ============================================================================
let mainWindow = null;
let tray = null;
/**
 * Janelas filhas abertas via `window.open` (Câmbio, etc.).
 *
 * Só serve para localizá-las depois e trazê-las para frente. O ciclo de vida
 * continua sendo do renderer: nada aqui abre nem fecha janela.
 */
const childWindows = new Set();
let closeToTray = true;      // padrão: fechar para a bandeja
let startMinimized = false;  // true quando iniciado pelo login automático do Windows

// Flag para diferenciar "Sair de verdade" de "fechar para bandeja"
app.isQuitting = false;

// Garante instância única. Cliques em notificações/atalhos não devem abrir uma segunda janela.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showAndFocusWindow();
  });
}

// ============================================================================
// ÍCONES — caminhos separados por uso
//
// BrowserWindow (barra de tarefas do Windows): OBRIGATÓRIO usar .ico no Windows.
// Tray (bandeja do sistema): aceita .png com boa qualidade (recomendado 16x16 ou 32x32).
// ============================================================================
function getIconDir() {
  // Tanto em dev quanto empacotado (app.asar), o caminho relativo resolve corretamente
  return path.join(__dirname, 'build');
}

function resolveWindowIcon() {
  const dir = getIconDir();
  // Windows exige .ico para aparecer corretamente na barra de tarefas
  const ico = path.join(dir, 'icon.ico');
  if (fs.existsSync(ico)) return ico;
  // Fallback para .png (aparece na barra de tarefas apenas no Linux/macOS)
  const png = path.join(dir, 'icon.png');
  if (fs.existsSync(png)) return png;
  return undefined;
}

function resolveTrayIcon() {
  const dir = getIconDir();
  // Bandeja do sistema: prefere .png (melhor qualidade no Windows 10/11)
  const png = path.join(dir, 'icon.png');
  if (fs.existsSync(png)) return png;
  // Fallback para .ico
  const ico = path.join(dir, 'icon.ico');
  if (fs.existsSync(ico)) return ico;
  return undefined;
}

// ============================================================================
// ALERTAS DE PT — lê/grava no localStorage do renderer via webContents
// ============================================================================

// Lê um valor do localStorage do renderer de forma assíncrona
async function getLocalStorage(key) {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return null;
    const result = await mainWindow.webContents.executeJavaScript(
      `localStorage.getItem(${JSON.stringify(key)})`
    );
    return result;
  } catch {
    return null;
  }
}

// Grava um valor no localStorage do renderer
async function setLocalStorage(key, value) {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    await mainWindow.webContents.executeJavaScript(
      `localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(String(value))}); window.dispatchEvent(new Event('storage'));`
    );
  } catch {}
}

// Lê o estado atual dos 3 alertas de PT
async function getAlertStates() {
  const [a30, a15, a5] = await Promise.all([
    getLocalStorage('notif_pt_30'),
    getLocalStorage('notif_pt_15'),
    getLocalStorage('notif_pt_5'),
  ]);
  return {
    pt30: a30 !== 'false',   // padrão true (ativo) se nunca foi alterado
    pt15: a15 !== 'false',
    pt5:  a5  !== 'false',
  };
}

// ============================================================================
// MENU DE CONTEXTO DO TRAY — reconstruído dinamicamente
// ============================================================================
async function rebuildTrayMenu() {
  if (!tray || tray.isDestroyed()) return;

  const alerts = await getAlertStates();

  const menu = Menu.buildFromTemplate([
    // ── Grupo 1: Alertas de PT ───────────────────────────────────────────────
    { label: 'Alertas de PT', enabled: false },  // cabeçalho do grupo (desabilitado = só título)
    {
      label: alerts.pt30 ? '✅  30 minutos (ativo)' : '❌  30 minutos (inativo)',
      click: async () => {
        const next = !alerts.pt30;
        await setLocalStorage('notif_pt_30', next ? 'true' : 'false');
        if (next) {
          // Remover chave = ativo (padrão)
          try { if (mainWindow && !mainWindow.isDestroyed()) await mainWindow.webContents.executeJavaScript(`localStorage.removeItem('notif_pt_30'); window.dispatchEvent(new Event('storage'));`); } catch {}
        }
        rebuildTrayMenu();
      }
    },
    {
      label: alerts.pt15 ? '✅  15 minutos (ativo)' : '❌  15 minutos (inativo)',
      click: async () => {
        const next = !alerts.pt15;
        await setLocalStorage('notif_pt_15', next ? 'true' : 'false');
        if (next) {
          try { if (mainWindow && !mainWindow.isDestroyed()) await mainWindow.webContents.executeJavaScript(`localStorage.removeItem('notif_pt_15'); window.dispatchEvent(new Event('storage'));`); } catch {}
        }
        rebuildTrayMenu();
      }
    },
    {
      label: alerts.pt5 ? '✅  5 minutos (ativo)' : '❌  5 minutos (inativo)',
      click: async () => {
        const next = !alerts.pt5;
        await setLocalStorage('notif_pt_5', next ? 'true' : 'false');
        if (next) {
          try { if (mainWindow && !mainWindow.isDestroyed()) await mainWindow.webContents.executeJavaScript(`localStorage.removeItem('notif_pt_5'); window.dispatchEvent(new Event('storage'));`); } catch {}
        }
        rebuildTrayMenu();
      }
    },

    { type: 'separator' },

    // ── Grupo 2: PT's ────────────────────────────────────────────────────────
    { label: "PT's", enabled: false },  // cabeçalho do grupo
    {
      label: '➕  Criar PT',
      click: () => {
        showAndFocusWindow();
        // Envia evento para o renderer abrir o modal de criação de PT
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('tray-action', 'create-pt');
        }
      }
    },
    {
      label: "📋  Ver PT's",
      click: () => {
        showAndFocusWindow();
        // Envia evento para o renderer navegar para a aba PT's
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('tray-action', 'navigate-pts');
        }
      }
    },

    { type: 'separator' },

    // ── Controles da janela ────────────────────────────────────────────────
    {
      label: 'Abrir Chernobyl PT',
      click: () => showAndFocusWindow()
    },
    { type: 'separator' },
    {
      label: 'Sair',
      click: () => {
        app.isQuitting = true;
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(menu);
}

// ============================================================================
// MOSTRAR E FOCAR A JANELA — corrige o bug de janela minimizada
// ============================================================================
function showAndFocusWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  // Se está minimizada na barra de tarefas (minimize), restaura primeiro
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  // Se estava oculta (hide — fechar para bandeja), mostra
  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }

  // Garante que continua maximizada (como estava antes de ser ocultada/minimizada)
  if (!mainWindow.isMaximized()) {
    mainWindow.maximize();
  }

  mainWindow.focus();
}

// ============================================================================
// SYSTEM TRAY (BANDEJA DO SISTEMA)
// ============================================================================
function createTray() {
  if (tray) return; // já existe

  const iconPath = resolveTrayIcon();
  if (!iconPath) {
    console.warn('[Tray] Ícone não encontrado em build/icon.png ou build/icon.ico — bandeja não será criada.');
    return;
  }

  tray = new Tray(iconPath);
  tray.setToolTip('Chernobyl PT');

  // Clique esquerdo: mostrar/ocultar janela (corrigido)
  tray.on('click', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isVisible() && mainWindow.isFocused()) {
      mainWindow.hide();
    } else {
      showAndFocusWindow();
    }
  });

  // Constrói o menu inicial
  rebuildTrayMenu();
}

// ============================================================================
// JANELA PRINCIPAL
// ============================================================================
function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();

  const width = Math.min(1400, workArea.width - 40);
  const height = Math.min(900, workArea.height - 40);

  const windowIcon = resolveWindowIcon(); // .ico para Windows (barra de tarefas)

  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: 1000,
    minHeight: 700,
    show: false, // Oculto até ready-to-show para evitar "pulo" na tela
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    // Cor de fundo da janela antes do primeiro paint. Mantida propositalmente
    // quase preta e neutra: é comum aos três temas (--th-bg-abyss), evitando
    // qualquer "flash" perceptível na abertura, independente do tema salvo.
    backgroundColor: '#0a0404',
    autoHideMenuBar: true,
    title: 'Chernobyl PT',
    fullscreen: false,
    kiosk: false,
    useContentSize: false,
    icon: windowIcon, // .ico garante ícone correto na barra de tarefas do Windows
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      // ── NOTIFICAÇÕES EM TEMPO REAL ──────────────────────────────────────
      // Por padrão o Chromium AGRUPA (throttle) os timers de janelas ocultas
      // — minimizadas ou escondidas na BANDEJA — chegando a 1 wakeup/minuto
      // após 5 minutos ocultas (intensive throttling). O canal Firestore
      // (WebChannel) depende de timers de heartbeat/reconexão: com throttle,
      // a entrega em segundo plano/Idle atrasa ou morre.
      // Desligar o throttling mantém o renderer — e o listener de
      // notificações — totalmente vivo com a janela na bandeja. É o padrão
      // de apps que vivem na bandeja (chat, etc.).
      backgroundThrottling: false,
    }
  });

  // Maximiza a janela imediatamente (antes de show)
  mainWindow.maximize();

  // Exibe a janela maximizada de forma fluida quando estiver 100% renderizada
  mainWindow.once('ready-to-show', () => {
    if (startMinimized) {
      // Iniciou com o Windows → fica oculto na bandeja
      mainWindow.hide();
      startMinimized = false;
    } else {
      mainWindow.show();
    }
  });

  // ========================================================================
  // INTERCEPTAR O FECHAMENTO — Fechar para bandeja ou fechar de verdade
  // ========================================================================
  mainWindow.on('close', (e) => {
    if (app.isQuitting) return; // saindo de verdade (menu da bandeja)

    if (closeToTray) {
      e.preventDefault();
      mainWindow.hide(); // oculta mas mantém o estado da sessão intacto
    }
    // closeToTray === false → fecha normalmente
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // ========================================================================
  // APLICAR ÍCONE A JANELAS FILHAS (window.open) — Calculadora, etc.
  // ========================================================================
  mainWindow.webContents.setWindowOpenHandler(() => {
    return { action: 'allow' };
  });

  mainWindow.webContents.on('did-create-window', (childWindow) => {
    const windowIcon = resolveWindowIcon();
    if (windowIcon) {
      try {
        childWindow.setIcon(windowIcon);
      } catch (_) {}
    }
    childWindow.setMenuBarVisibility(false);

    // Registro das janelas filhas vivas. É o que permite ao renderer pedir
    // "traga a janela do Câmbio para frente": do lado do renderer só existe
    // um handle `Window`, cujo `focus()` NÃO restaura uma janela nativa
    // minimizada nem a traz para cima de outros programas.
    // A entrada sai do registro sozinha quando a janela fecha, então o
    // comportamento de fechamento continua exatamente o mesmo.
    childWindows.add(childWindow);
    childWindow.once('closed', () => {
      childWindows.delete(childWindow);
    });
  });

  // ========================================================================
  // CARREGAR A APLICAÇÃO — Dev (localhost) ou Empacotado (dist/index.html)
  // ========================================================================
  if (app.isPackaged) {
    mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
  } else {
    mainWindow.loadURL('http://localhost:5173');
  }
}


// ============================================================================
// RUBINOT BAZAAR — Consulta manual via Playwright (Electron main process)
// ============================================================================
const RUBINOT_BAZAAR_URL = 'https://rubinot.com.br/bazaar';
const RUBINOT_BAZAAR_API = 'https://rubinot.com.br/api/bazaar';
const RUBINOT_BAZAAR_PARAMS = { sortBy: 'auction_end', sortOrder: 'asc', limit: 100 };
const RUBINOT_CONTEXT_TTL_MS = 10 * 60 * 1000;

let rubinotContext = null;
let rubinotContextLastUsedAt = 0;
let rubinotCloseTimer = null;
let rubinotFetchInFlight = null;
let rubinotSessionPage = null;
let rubinotSessionReadyAt = 0;
// Navegador e perfil realmente em uso — usados nos logs de diagnóstico
// para diferenciar Chrome oficial de Chromium do Playwright.
let rubinotContextChannel = '';
let rubinotContextProfileDir = '';
// Navegador escolhido pelo usuário na última consulta (chrome|edge|firefox|webkit).
let rubinotSelectedBrowser = 'webkit';
let rubinotContextBrowserKey = '';
// Perfil limpo (temporário) desta execução, quando solicitado pelo usuário.
let rubinotContextIsClean = false;
let rubinotUseCleanProfile = false;
let rubinotCleanProfileDir = '';
let rubinotQueue = Promise.resolve();
let rubinotProgressState = { active: false, stage: '', message: '', processed: 0, total: 0, percent: 0, startedAt: 0, updatedAt: 0, reason: '' };
const rubinotDetailsCache = new Map();
const rubinotDetailsInFlight = new Map();
const RUBINOT_DETAILS_TTL_MS = 6 * 60 * 60 * 1000;
const RUBINOT_DETAILS_ERROR_TTL_MS = 10 * 60 * 1000;
const RUBINOT_DETAILS_METHOD = 'bosstiary_single_two_or_search_v3';


function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function runRubinotQueued(label, task) {
  const run = async () => {
    const startedAt = Date.now();
    rubinotDiag('queue', `Iniciando rotina: ${label}`);
    try {
      const result = await task();
      rubinotDiag('queue', `Rotina finalizada: ${label}`, { elapsedMs: Date.now() - startedAt, ok: result?.ok });
      return result;
    } catch (error) {
      rubinotDiag('queue', `Rotina falhou: ${label}`, { elapsedMs: Date.now() - startedAt, error: String(error?.message || error) });
      throw error;
    }
  };

  const queued = rubinotQueue.then(run, run);
  rubinotQueue = queued.catch(() => {});
  return queued;
}

function rubinotDiag(scope, message, data = {}) {
  try {
    const safeData = { ...data };
    if (safeData.cookies) safeData.cookies = safeData.cookies.map(cookie => cookie.name);
    console.log(`[Rubinot:${scope}] ${message}`, safeData);
  } catch (_) {
    console.log(`[Rubinot:${scope}] ${message}`);
  }
}

function sendRubinotProgress(sender, payload) {
  const now = Date.now();
  const progress = {
    processed: 0,
    total: 0,
    percent: 0,
    // Configuração da consulta em TODO evento de progresso — inclusive na
    // listagem, que roda antes da análise. `payload` pode sobrescrever.
    speedMode: rubinotSpeedMode,
    speedModeLabel: RUBINOT_SPEED_MODES[rubinotSpeedMode]?.label || rubinotSpeedMode,
    retrySelection: summarizeRubinotRetryPlan(rubinotRunRetryPlan).map(entry => ({
      browser: entry.browser,
      label: RUBINOT_BROWSERS[entry.browser]?.label || entry.browser,
      attempts: entry.attempts,
    })),
    ...payload,
    active: true,
    startedAt: rubinotProgressState.active && rubinotProgressState.startedAt ? rubinotProgressState.startedAt : now,
    updatedAt: now,
    reason: '',
  };
  rubinotProgressState = progress;
  try {
    if (sender && !sender.isDestroyed()) {
      sender.send('rubinot-bazaar-progress', progress);
    }
  } catch (_) {}
}

function finishRubinotProgress(reason = 'finalizado') {
  rubinotProgressState = {
    ...rubinotProgressState,
    active: false,
    updatedAt: Date.now(),
    reason,
  };
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('rubinot-bazaar-progress', rubinotProgressState);
    }
  } catch (_) {}
}

function buildRubinotProgress(stage, message, processed, total, extra = {}) {
  const safeProcessed = Math.max(0, Number(processed || 0));
  const safeTotal = Math.max(0, Number(total || 0));
  const percent = safeTotal > 0 ? Math.min(100, Math.max(0, Math.round((safeProcessed / safeTotal) * 100))) : 0;
  // `extra` carrega dados informativos do progresso (ex.: falhas que irão para
  // o retry). Nunca influencia a lógica da consulta — é só exibição.
  return { stage, message, processed: safeProcessed, total: safeTotal, percent, ...extra };
}

function scheduleRubinotContextClose() {
  // Durante a fase de robustez do Bazaar, a sessão Rubinot deve permanecer viva
  // enquanto o aplicativo estiver aberto. Mantemos a função por compatibilidade,
  // mas ela não fecha mais o contexto por TTL.
  if (rubinotCloseTimer) {
    clearTimeout(rubinotCloseTimer);
    rubinotCloseTimer = null;
  }
}

// ============================================================================
// SELEÇÃO DE NAVEGADOR
// ----------------------------------------------------------------------------
// O usuário escolhe o mecanismo antes de cada consulta. Navegadores diferentes
// se comportam de forma diferente no RubinOT, então a escolha é dele.
//
// Cada mecanismo usa um PERFIL PRÓPRIO: Chromium, Firefox e WebKit gravam
// formatos incompatíveis no diretório de perfil, e compartilhar a mesma pasta
// corromperia a sessão.
//
// Não há fallback silencioso: se o navegador escolhido não estiver disponível,
// a consulta não começa e o usuário é avisado para escolher outro.
// ============================================================================
const RUBINOT_BROWSERS = {
  chrome:  { label: 'Google Chrome',  engine: 'chromium', channel: 'chrome',  profile: 'rubinot-profile-chrome' },
  edge:    { label: 'Microsoft Edge', engine: 'chromium', channel: 'msedge',  profile: 'rubinot-profile-edge' },
  firefox: { label: 'Firefox',        engine: 'firefox',  channel: '',        profile: 'rubinot-profile-firefox' },
  webkit:  { label: 'WebKit',         engine: 'webkit',   channel: '',        profile: 'rubinot-profile-webkit' },
};
const RUBINOT_DEFAULT_BROWSER = 'webkit';

/**
 * Caminhos onde Chrome/Edge costumam ser instalados, por plataforma.
 * Mesmos locais que o Playwright usa para resolver os canais.
 */
const RUBINOT_CHANNEL_PATHS = {
  chrome: {
    win32: [
      path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    ],
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    linux: ['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'],
  },
  msedge: {
    win32: [
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Microsoft\\Edge\\Application\\msedge.exe'),
    ],
    darwin: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    linux: ['/opt/microsoft/msedge/msedge', '/usr/bin/microsoft-edge'],
  },
};

/**
 * Verifica se o mecanismo está disponível SEM abrir janela.
 *   • Chrome/Edge  -> procura o executável instalado no sistema.
 *   • Firefox/WebKit -> confere o binário baixado pelo Playwright.
 * Nunca lança: a indisponibilidade é um estado normal exibido no modal.
 */
/**
 * Resolve o CAMINHO do executável de um navegador (Chrome/Edge reais) para o
 * modo CDP do Auto Bid. Devolve `null` quando não encontrado. Diferente do
 * `probeRubinotBrowserAvailability`, retorna o caminho em si, não apenas se
 * existe.
 */
function resolveRubinotBrowserExecutablePath(key) {
  const normalized = resolveRubinotBrowserKey(key);
  const info = RUBINOT_BROWSERS[normalized];
  if (!info) return null;
  try {
    if (info.channel) {
      const candidates = (RUBINOT_CHANNEL_PATHS[info.channel] || {})[process.platform] || [];
      return candidates.find(candidate => candidate && fs.existsSync(candidate)) || null;
    }
    const engine = require('playwright')[info.engine];
    const exe = engine.executablePath();
    return exe && fs.existsSync(exe) ? exe : null;
  } catch (_) {
    return null;
  }
}

function probeRubinotBrowserAvailability(key, info) {
  try {
    if (info.channel) {
      const candidates = (RUBINOT_CHANNEL_PATHS[info.channel] || {})[process.platform] || [];
      const found = candidates.find(candidate => candidate && fs.existsSync(candidate));
      return found
        ? { available: true, hint: '' }
        : { available: false, hint: `${info.label} não foi encontrado neste computador.` };
    }
    const engine = require('playwright')[info.engine];
    const executablePath = engine.executablePath();
    return executablePath && fs.existsSync(executablePath)
      ? { available: true, hint: '' }
      : { available: false, hint: `Não instalado. Rode: npx playwright install ${key}` };
  } catch (error) {
    return {
      available: false,
      hint: info.channel
        ? `${info.label} não foi encontrado neste computador.`
        : `Não instalado. Rode: npx playwright install ${key}`,
    };
  }
}

/** Normaliza a escolha vinda do renderer. */
function resolveRubinotBrowserKey(value) {
  const key = String(value || '').trim().toLowerCase();
  return RUBINOT_BROWSERS[key] ? key : RUBINOT_DEFAULT_BROWSER;
}

/** Mensagem amigável quando o mecanismo escolhido não está disponível. */
function buildRubinotBrowserUnavailableMessage(browserKey, rawError) {
  const info = RUBINOT_BROWSERS[browserKey];
  const label = info?.label || browserKey;
  const detail = String(rawError || '');
  const notInstalled = /executable doesn't exist|not found|no such file|failed to launch|channel .* is not|browserType\.launch/i.test(detail);

  if (browserKey === 'chrome' || browserKey === 'edge') {
    return notInstalled
      ? `${label} não foi encontrado neste computador. Instale o navegador ou escolha outro na lista.`
      : `Não foi possível iniciar o ${label}. Feche as janelas abertas dele e tente novamente, ou escolha outro navegador.`;
  }
  return notInstalled
    ? `${label} não está instalado para automação. Instale com o comando "npx playwright install ${browserKey}" ou escolha outro navegador.`
    : `Não foi possível iniciar o ${label}. Escolha outro navegador e tente novamente.`;
}

/**
 * Abre o contexto persistente do navegador escolhido.
 * Lança um erro já traduzido quando o mecanismo não está disponível.
 */
async function launchRubinotPersistentContext(browserKey, userDataDir, options) {
  const playwright = require('playwright');
  const info = RUBINOT_BROWSERS[browserKey];
  const engine = playwright[info.engine];

  rubinotContextProfileDir = userDataDir;

  // Firefox e WebKit não aceitam as flags de linha de comando do Chromium.
  const launchOptions = { ...options };
  if (info.engine !== 'chromium') delete launchOptions.args;
  if (info.channel) launchOptions.channel = info.channel;

  if (info.engine === 'chromium') {
    // Impede que o Chromium reduza timers e renderização de janelas ocultas
    // ou em segundo plano — o que travaria a consulta ao trocar de aplicativo.
    launchOptions.args = [
      ...(launchOptions.args || []),
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=CalculateNativeWinOcclusion',
    ];
  }

  if (info.engine === 'firefox') {
    // O Firefox é o mais agressivo em segundo plano: reduz timers, congela o
    // agendador de abas ocultas e trata a janela sem foco como inativa. Estas
    // preferências desligam esse comportamento, permitindo que a consulta
    // continue enquanto o usuário trabalha em outro aplicativo.
    launchOptions.firefoxUserPrefs = {
      ...(launchOptions.firefoxUserPrefs || {}),
      'dom.min_background_timeout_value': 0,
      'dom.timeout.enable_budget_timer_throttling': false,
      'dom.timeout.background_throttling_max_budget': -1,
      'dom.timeout.throttling_delay': 0,
      'dom.suspend_inactive.enabled': false,
      'browser.tabs.unloadOnLowMemory': false,
      'browser.sessionstore.idleDelay': 3600,
      'privacy.reduceTimerPrecision': false,
    };
  }

  rubinotDiag('context', 'Iniciando navegador escolhido pelo usuário.', {
    browser: browserKey, label: info.label, engine: info.engine, channel: info.channel || '(padrão)', userDataDir,
  });

  try {
    const context = await engine.launchPersistentContext(userDataDir, launchOptions);
    rubinotContextChannel = info.channel || info.engine;
    rubinotContextBrowserKey = browserKey;
    return context;
  } catch (error) {
    const message = buildRubinotBrowserUnavailableMessage(browserKey, error?.message || error);
    rubinotDiag('context', 'Navegador escolhido indisponível.', { browser: browserKey, error: String(error?.message || error) });
    const friendly = new Error(message);
    friendly.browserUnavailable = true;
    friendly.browserKey = browserKey;
    throw friendly;
  }
}

async function getRubinotContext(browserKey = rubinotSelectedBrowser, useCleanProfile = false) {
  const requested = resolveRubinotBrowserKey(browserKey);
  const wantsClean = !!useCleanProfile;

  // Trocar de navegador — ou alternar entre perfil normal e limpo — exige um
  // contexto novo: os perfis são incompatíveis entre si.
  if (rubinotContext && ((rubinotContextBrowserKey && rubinotContextBrowserKey !== requested) || rubinotContextIsClean !== wantsClean)) {
    rubinotDiag('context', 'Contexto atual não corresponde ao solicitado; reiniciando.', {
      atual: rubinotContextBrowserKey, solicitado: requested,
      perfilAtualLimpo: rubinotContextIsClean, perfilSolicitadoLimpo: wantsClean,
    });
    await closeRubinotBrowser('troca-de-contexto');
  }

  if (rubinotContext) {
    rubinotContextLastUsedAt = Date.now();
    return rubinotContext;
  }

  const info = RUBINOT_BROWSERS[requested];
  // Perfil separado por mecanismo — Chromium, Firefox e WebKit gravam formatos
  // incompatíveis e não podem dividir o mesmo diretório.
  //
  // PERFIL LIMPO: diretório temporário, descartado ao final. Serve para
  // diagnosticar suspeita de cache/cookies corrompidos SEM tocar no perfil
  // persistente do usuário.
  const userDataDir = wantsClean
    ? fs.mkdtempSync(path.join(os.tmpdir(), `rubinot-clean-${requested}-`))
    : path.join(app.getPath('userData'), info.profile);
  rubinotContextIsClean = wantsClean;
  rubinotCleanProfileDir = wantsClean ? userDataDir : '';
  if (wantsClean) rubinotDiag('context', 'Usando PERFIL LIMPO temporário nesta consulta.', { userDataDir });

  const contextOptions = {
    headless: false,
    acceptDownloads: false,
    // Service Workers podem servir respostas de um cache antigo — o "cache
    // corrompido" citado pelo suporte do site. Bloqueá-los garante que toda
    // requisição chegue de fato ao servidor.
    //
    // NÃO TROCAR PARA 'allow' SEM MEDIR. Já foi tentado e a validação
    // automática do Cloudflare parou de concluir.
    serviceWorkers: 'block',
    args: [
      // Aplicada só a Chrome/Edge: `launchRubinotPersistentContext` remove
      // `args` quando o motor não é Chromium.
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-default-browser-check',
      '--disable-infobars',
      '--lang=pt-BR',
      '--window-size=1366,850',
    ],
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    colorScheme: 'dark',
    // VIEWPORT FIXO — mantido de propósito (estado estável já validado).
    viewport: { width: 1366, height: 850 },
    screen: { width: 1366, height: 850 },
    deviceScaleFactor: 1,
    extraHTTPHeaders: {
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  };

  rubinotContext = await launchRubinotPersistentContext(requested, userDataDir, contextOptions);

  // ==========================================================================
  // RESTAURAÇÃO DO ESTADO ESTÁVEL DA CONSULTA BAZAAR — NÃO REMOVER
  // --------------------------------------------------------------------------
  // Esta configuração é a que faz a CONSULTA BAZAAR (getRubinotContext) passar
  // automaticamente pela verificação do site e carregar a listagem — o fluxo
  // de produção que já funcionava ANTES das alterações do Auto Bid.
  //
  // O AUTO BID é independente: usa o MODO CDP (electron-autobid-cdp.cjs), que
  // conecta a um navegador real do usuário e NÃO usa esta função. Portanto,
  // restaurar este estado NÃO afeta o Auto Bid.
  //
  // Nota de conformidade: isto não resolve CAPTCHA nem burla decisão do site;
  // apenas restitui o estado de navegador que a própria consulta já usava.
  // ==========================================================================
  await rubinotContext.addInitScript(() => {
    try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch (_) {}
    try { Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt', 'en-US', 'en'] }); } catch (_) {}
  });

  rubinotContext.on('close', () => {
    rubinotDiag('context', 'Contexto/navegador Rubinot fechado. Limpando referências internas.');
    rubinotContext = null;
    rubinotSessionPage = null;
    rubinotSessionReadyAt = 0;
    rubinotContextLastUsedAt = 0;
    rubinotContextBrowserKey = '';
    rubinotDetailsInFlight.clear();
    if (rubinotCloseTimer) clearTimeout(rubinotCloseTimer);
  });

  rubinotContextLastUsedAt = Date.now();
  rubinotDiag('context', 'Contexto Rubinot persistente inicializado.', {
    browser: requested, label: info.label, userDataDir, perfilLimpo: wantsClean,
  });
  return rubinotContext;
}

/** Apaga o diretório do perfil limpo. Nunca lança. */
function removeRubinotCleanProfile(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    rubinotDiag('context', 'Perfil limpo temporário descartado.', { dir });
  } catch (error) {
    rubinotDiag('context', 'Falha tolerada ao descartar o perfil limpo.', { dir, error: String(error?.message || error) });
  }
}

/**
 * Encerramento GRACIOSO do contexto.
 *
 * Por que isso importa para a sessão: Chromium e Firefox mantêm os cookies
 * persistentes em SQLite com escrita adiada. Matar o processo (ou fechar a
 * janela na marra enquanto o site ainda está gravando) pode descartar a última
 * transação — e é justamente aí que mora o `cf_clearance` recém-emitido, além
 * do cookie de sessão do login. O resultado percebido pelo usuário é o
 * clássico "resolvi a verificação, mas na próxima vez ela voltou".
 *
 * Antes de fechar, portanto:
 *   1) lemos os cookies do contexto (força o flush do lado do navegador);
 *   2) registramos no diagnóstico o que sobreviveu — só NOMES, nunca valores;
 *   3) só então fechamos as páginas e o contexto.
 */
async function flushRubinotSessionBeforeClose(context, reason) {
  if (!context) return;
  try {
    const state = await inspectRubinotSessionState(context);
    rubinotDiag('session', 'Estado da sessão imediatamente antes de encerrar o navegador.', {
      reason,
      status: state.status,
      totalCookies: state.totalCookies,
      hasCfClearance: state.hasCfClearance,
      // Só nomes — nunca valores.
      cookies: state.cookieNames,
    });
  } catch (error) {
    if (isRubinotBrowserClosedError(error)) return;
    rubinotDiag('session', 'Falha tolerada ao inspecionar a sessão antes de encerrar.', { reason, error: String(error?.message || error) });
  }
}

async function closeRubinotBrowser(reason = 'consulta-finalizada') {
  // TROCA DE NAVEGADOR NÃO ENCERRA A CONSULTA.
  //
  // A cadeia de retries fecha o navegador entre um motor e outro. Chamar
  // `finishRubinotProgress` aqui zerava `startedAt`, e o "Tempo decorrido"
  // recomeçava do zero a cada troca — como se fossem consultas separadas.
  // Agora só o encerramento REAL finaliza o progresso.
  if (reason !== 'troca-de-contexto') finishRubinotProgress(reason);
  const context = rubinotContext;
  rubinotDiag('context', 'Encerrando navegador Rubinot completo.', { reason, hasContext: !!context, pages: context ? context.pages().length : 0 });

  // Garante que os cookies gravados durante a verificação/login cheguem ao
  // disco antes de o processo do navegador morrer.
  await flushRubinotSessionBeforeClose(context, reason);

  rubinotFetchInFlight = null;
  rubinotDetailsInFlight.clear();
  rubinotSessionPage = null;
  rubinotSessionReadyAt = 0;
  // O pedido de encerramento vale só para a consulta que o recebeu. Deixá-lo
  // ligado abortaria a PRÓXIMA consulta logo no primeiro personagem.
  // (Trocar de navegador na cadeia de retries não passa por aqui com este
  // motivo, então a parada em curso não é perdida no meio do caminho.)
  if (reason !== 'troca-de-contexto') resetRubinotManualStop();
  rubinotContextLastUsedAt = 0;
  // Perfil limpo é descartável: some junto com o contexto.
  const cleanDirToRemove = rubinotCleanProfileDir;
  rubinotContextIsClean = false;
  rubinotCleanProfileDir = '';
  if (rubinotCloseTimer) {
    clearTimeout(rubinotCloseTimer);
    rubinotCloseTimer = null;
  }

  if (!context) return { ok: true, closed: false };

  try {
    const pages = context.pages();
    await Promise.allSettled(pages.map(page => page.isClosed() ? Promise.resolve() : page.close({ runBeforeUnload: false }).catch(() => {})));
  } catch (_) {}

  try {
    await context.close();
  } catch (error) {
    if (!isRubinotBrowserClosedError(error)) {
      rubinotContext = null;
      if (cleanDirToRemove) removeRubinotCleanProfile(cleanDirToRemove);
      return { ok: false, closed: false, error: String(error?.message || error) };
    }
  } finally {
    if (cleanDirToRemove) removeRubinotCleanProfile(cleanDirToRemove);
    rubinotContext = null;
    rubinotSessionPage = null;
    rubinotSessionReadyAt = 0;
    rubinotDetailsInFlight.clear();
  }

  rubinotDiag('context', 'Navegador Rubinot encerrado com sucesso.', { reason });
  return { ok: true, closed: true };
}

/**
 * Heurística de DESAFIO do Cloudflare.
 *
 * ATENÇÃO — FALSO POSITIVO JÁ CORRIGIDO AQUI. NÃO REINTRODUZIR.
 * ---------------------------------------------------------------------------
 * Esta função recebe o HTML COMPLETO da página (`page.content()`), não só um
 * texto visível. O RubinOT serve o script padrão do Cloudflare
 * (`/cdn-cgi/challenge-platform/...`) em TODA página do domínio, inclusive
 * quando ela carrega perfeitamente e NENHUM desafio é exigido.
 *
 * As marcas abaixo, portanto, aparecem no HTML de uma página 100% saudável:
 *   • 'challenge-platform'  → caminho do script sempre presente;
 *   • 'cloudflare'          → aparece em URL de script, comentário ou header;
 *   • 'turnstile'           → o widget pode estar apenas pré-carregado;
 *   • 'cdn-cgi'             → prefixo de qualquer asset do Cloudflare.
 *
 * Casá-las contra o HTML fazia `cloudflareDetected` virar SEMPRE verdadeiro.
 * Consequências observadas: a chamada da API era pulada (`skipped: true`),
 * `sessionReady` nunca era satisfeito, a janela era trazida ao topo como se
 * exigisse interação e, após 180s, a sessão falhava com
 * `needsHumanVerification` — exatamente a "tela de verificação que aparece e
 * impede o fluxo", mesmo com a página tendo carregado normalmente.
 *
 * A detecção agora usa apenas marcas de INTERSTICIAL REAL — frases que só
 * existem quando o Cloudflare está de fato bloqueando o conteúdo — ou a URL
 * do próprio desafio.
 */
function isLikelyCloudflarePage(content, url) {
  const text = String(content || '').toLowerCase();

  // Só a URL do INTERSTICIAL conta. Um asset em /cdn-cgi/ (script, imagem,
  // beacon) não significa bloqueio algum.
  const currentUrl = String(url || '').toLowerCase();
  if (currentUrl.includes('/cdn-cgi/challenge-platform') || currentUrl.includes('/cdn-cgi/l/chk_jschl')) return true;

  // Frases exibidas ao usuário apenas na página de bloqueio.
  return text.includes('checking your browser') ||
    text.includes('just a moment') ||
    text.includes('sou humano') ||
    text.includes('confirme que') ||
    text.includes('verificação de segurança') ||
    text.includes('complete a verificação') ||
    text.includes('security verification') ||
    text.includes('enable javascript and cookies to continue') ||
    text.includes('verify you are human') ||
    text.includes('attention required');
}

function isRubinotPageUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    return parsed.hostname === 'rubinot.com.br' || parsed.hostname.endsWith('.rubinot.com.br');
  } catch (_) {
    return false;
  }
}

function normalizeRubinotAuctionUrl(auction) {
  const rawUrl = String(auction?.url || '').trim();
  const id = String(auction?.id || '').trim();

  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl, RUBINOT_BAZAAR_URL);
      if (isRubinotPageUrl(parsed.href)) return parsed.href;
    } catch (_) {}
  }

  if (id) return `https://rubinot.com.br/bazaar/${encodeURIComponent(id)}`;
  return '';
}

function isRubinotBrowserClosedError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('target page, context or browser has been closed') ||
    message.includes('browser has been closed') ||
    message.includes('context has been closed') ||
    message.includes('page has been closed') ||
    message.includes('target closed');
}

function throwIfRubinotRunCancelled(page, runState) {
  if (runState?.cancelled) {
    throw new Error(runState.reason || 'Consulta cancelada: navegador fechado.');
  }
  if (!page || page.isClosed()) {
    throw new Error('Consulta cancelada: página do Rubinot fechada.');
  }
}

async function fetchRubinotJsonDetailed(page, url) {
  try {
    return await page.evaluate(async ({ targetUrl, referer }) => {
      try {
        const response = await fetch(targetUrl, {
          credentials: 'include',
          headers: {
            Accept: 'application/json, text/plain, */*',
            Referer: referer,
            'X-Requested-With': 'XMLHttpRequest',
          },
        });
        const contentType = response.headers.get('content-type') || '';
        const text = await response.text();
        let json = null;
        if (contentType.includes('application/json') || text.trim().startsWith('{') || text.trim().startsWith('[')) {
          try { json = JSON.parse(text); } catch (_) {}
        }
        return {
          ok: response.ok,
          status: response.status,
          contentType,
          isJson: !!json,
          data: json,
          textPreview: json ? '' : text.slice(0, 180),
          // Cabeçalhos úteis ao diagnóstico e ao backoff da listagem.
          retryAfter: response.headers.get('retry-after') || '',
          cfRay: response.headers.get('cf-ray') ? 'yes' : 'no',
        };
      } catch (error) {
        return { ok: false, status: 0, contentType: '', isJson: false, data: null, error: String(error?.message || error) };
      }
    }, { targetUrl: url, referer: RUBINOT_BAZAAR_URL });
  } catch (error) {
    if (isRubinotBrowserClosedError(error)) throw error;
    return { ok: false, status: 0, contentType: '', isJson: false, data: null, error: String(error?.message || error) };
  }
}

async function fetchRubinotJson(page, url) {
  const result = await fetchRubinotJsonDetailed(page, url);
  return result?.ok && result?.isJson ? result.data : null;
}

// ============================================================================
// SESSÃO DO RUBINOT — preparação manual e verificação segura
// ----------------------------------------------------------------------------
// O app NUNCA autentica sozinho e NUNCA lê credenciais. Quem faz login é o
// usuário, manualmente, na janela real do navegador. Aqui só inspecionamos
// METADADOS de cookies (nome, domínio, validade) — jamais os valores.
// ============================================================================

/** Nomes que indicam sessão de aplicação (não são cookies do Cloudflare). */
const RUBINOT_SESSION_COOKIE_HINTS = /session|laravel|remember|auth|token|sid/i;
const RUBINOT_CLOUDFLARE_COOKIE = /^cf_|^__cf/i;

/**
 * Estado da sessão do RubinOT no perfil atual.
 *
 * Retorna apenas metadados seguros: NOMES de cookies, presença de
 * `cf_clearance`, indício de autenticação e expiração. Nenhum valor de cookie
 * é lido, registrado ou transmitido.
 */
async function inspectRubinotSessionState(context) {
  try {
    const cookies = await context.cookies('https://rubinot.com.br');
    const nowSec = Math.floor(Date.now() / 1000);

    const names = cookies.map(cookie => cookie.name);
    const sessionCookies = cookies.filter(cookie =>
      RUBINOT_SESSION_COOKIE_HINTS.test(cookie.name) && !RUBINOT_CLOUDFLARE_COOKIE.test(cookie.name));
    const clearance = cookies.find(cookie => cookie.name === 'cf_clearance');

    // Um cookie com `expires` no passado já venceu. `-1` = cookie de sessão.
    const isExpired = (cookie) => typeof cookie.expires === 'number' && cookie.expires > 0 && cookie.expires < nowSec;
    const expiredSession = sessionCookies.length > 0 && sessionCookies.every(isExpired);
    const clearanceExpired = !!clearance && isExpired(clearance);

    let status = 'nao-validada';
    if (sessionCookies.length > 0 && !expiredSession) status = 'validada';
    else if (expiredSession || (clearanceExpired && sessionCookies.length > 0)) status = 'expirada';

    // Cookie de SESSÃO (expires = -1) morre quando o navegador fecha; cookie
    // PERSISTENTE sobrevive. Distinguir os dois explica por que uma sessão
    // "validada" some ao reiniciar o navegador sem que nada esteja quebrado.
    const persistentSession = sessionCookies.some(cookie => typeof cookie.expires === 'number' && cookie.expires > 0);
    const clearanceExpiresAt = clearance && typeof clearance.expires === 'number' && clearance.expires > 0
      ? Math.round(clearance.expires) : 0;

    return {
      status,
      hasAnyCookie: cookies.length > 0,
      totalCookies: cookies.length,
      hasCfClearance: !!clearance && !clearanceExpired,
      // Momento em que o `cf_clearance` vence (epoch em segundos, 0 = sem
      // validade declarada). Serve para o modal avisar quando a verificação
      // vai precisar ser refeita — não é o valor do cookie.
      cfClearanceExpiresAt: clearanceExpiresAt,
      // false = o cookie de sessão do site é volátil e some ao fechar o
      // navegador; nesse caso o login precisa ser refeito por desenho do site.
      sessionCookiePersistent: persistentSession,
      looksAuthenticated: sessionCookies.length > 0 && !expiredSession,
      // Só nomes — nunca valores.
      cookieNames: names.slice(0, 30),
      sessionCookieNames: sessionCookies.map(cookie => cookie.name),
    };
  } catch (error) {
    if (isRubinotBrowserClosedError(error)) throw error;
    return { status: 'desconhecida', hasAnyCookie: false, totalCookies: 0, hasCfClearance: false, cfClearanceExpiresAt: 0, sessionCookiePersistent: false, looksAuthenticated: false, cookieNames: [], sessionCookieNames: [] };
  }
}

async function getRubinotCloudflareCookies(context) {
  try {
    const cookies = await context.cookies('https://rubinot.com.br');
    return cookies.filter(cookie => /^cf_|^__cf_|cf/i.test(cookie.name));
  } catch (_) {
    return [];
  }
}

/**
 * Fecha a aba exclusiva de sessão.
 *
 * A sessão em si (cookies, cf_clearance, storage) pertence ao CONTEXTO do
 * navegador e sobrevive ao fechamento da aba. Fechá-la antes da análise
 * individual garante que só exista UMA aba do Bazaar ativa por vez, como
 * orienta o suporte do site. Se for necessária de novo, `getRubinotSessionPage`
 * a recria sob demanda.
 */
async function closeRubinotSessionPage(reason = 'nao-informado') {
  const page = rubinotSessionPage;
  rubinotSessionPage = null;
  rubinotSessionReadyAt = 0;
  if (!page || page.isClosed()) return;
  try {
    await page.close({ runBeforeUnload: false });
    rubinotDiag('session', 'Aba de sessão fechada para manter apenas uma aba do Bazaar.', { reason });
  } catch (error) {
    if (isRubinotBrowserClosedError(error)) return;
    rubinotDiag('session', 'Falha tolerada ao fechar a aba de sessão.', { reason, error: String(error?.message || error) });
  }
}

async function getRubinotSessionPage(context) {
  if (rubinotSessionPage && !rubinotSessionPage.isClosed()) return rubinotSessionPage;

  rubinotSessionPage = context.pages().find(page => !page.isClosed() && isRubinotPageUrl(page.url()) && page.url().includes('/bazaar')) ||
    context.pages().find(page => !page.isClosed() && isRubinotPageUrl(page.url())) ||
    context.pages().find(page => !page.isClosed() && page.url() === 'about:blank') ||
    await context.newPage();

  rubinotSessionPage.on('close', () => {
    rubinotDiag('session', 'Página exclusiva de sessão fechada. Será recriada na próxima consulta.');
    if (rubinotSessionPage?.isClosed()) rubinotSessionPage = null;
    rubinotSessionReadyAt = 0;
  });

  return rubinotSessionPage;
}

async function inspectRubinotBazaarDom(page) {
  try {
    return await page.evaluate(() => {
      const bodyText = String(document.body?.innerText || '').toLowerCase();
      // Só conta como desafio o que BLOQUEIA a página. O seseletor antigo
      // ('[class*="cf-"], [id*="cf-"]') casava com classes utilitárias comuns
      // e o texto 'cloudflare' aparece em rodapé/script de página saudável —
      // ambos geravam falso positivo permanente. Ver isLikelyCloudflarePage.
      const challengeEl = document.querySelector('input[name="cf-turnstile-response"], [class*="cf-challenge" i], [id*="cf-challenge" i], #challenge-form, #challenge-running');
      // Um iframe do Turnstile só indica bloqueio se estiver VISÍVEL: o
      // Cloudflare pré-carrega o widget invisível em páginas normais.
      const turnstileFrame = document.querySelector('iframe[src*="turnstile"]');
      const turnstileVisible = !!turnstileFrame && !!turnstileFrame.getBoundingClientRect &&
        turnstileFrame.getBoundingClientRect().height > 0 && turnstileFrame.getBoundingClientRect().width > 0;
      const hasCloudflareDom = !!challengeEl || turnstileVisible ||
        bodyText.includes('checking your browser') ||
        bodyText.includes('confirme que') ||
        bodyText.includes('sou humano') ||
        bodyText.includes('verificação de segurança') ||
        bodyText.includes('verify you are human');
      const hasBazaarDom = bodyText.includes('current auctions') ||
        bodyText.includes('char bazaar') ||
        bodyText.includes('browse characters') ||
        bodyText.includes('loading auctions') ||
        !!document.querySelector('input[placeholder*="Search" i], select, button');
      return { hasCloudflareDom, hasBazaarDom, title: document.title || '', textLength: document.documentElement?.innerHTML?.length || 0 };
    });
  } catch (error) {
    if (isRubinotBrowserClosedError(error)) throw error;
    return { hasCloudflareDom: true, hasBazaarDom: false, title: '', textLength: 0, error: String(error?.message || error) };
  }
}

async function inspectRubinotChallengeOnPage(page) {
  try {
    const currentUrl = page.url();
    const state = await page.evaluate(() => {
      const bodyText = String(document.body?.innerText || '').toLowerCase();
      const title = String(document.title || '').toLowerCase();
      // '[id*="challenge" i]' e '[class*="challenge-platform" i]' casavam com
      // o script que o Cloudflare injeta em TODA página do domínio, mesmo sem
      // bloqueio — falso positivo. Aqui ficam só marcas de intersticial real.
      const challengeEl = document.querySelector([
        'input[name="cf-turnstile-response"]',
        '[class*="cf-challenge" i]',
        '[id*="cf-challenge" i]',
        '#challenge-form',
        '#challenge-running',
      ].join(','));
      // O widget do Turnstile só conta quando está VISÍVEL na tela.
      const turnstileFrame = document.querySelector('iframe[src*="turnstile"]');
      const rect = turnstileFrame && turnstileFrame.getBoundingClientRect ? turnstileFrame.getBoundingClientRect() : null;
      const turnstileVisible = !!rect && rect.height > 0 && rect.width > 0;
      const selectorHit = !!challengeEl || turnstileVisible;
      const textHit = bodyText.includes('confirme que') ||
        bodyText.includes('sou humano') ||
        bodyText.includes('checking your browser') ||
        bodyText.includes('verificação de segurança') ||
        bodyText.includes('complete a verificação') ||
        bodyText.includes('security verification') ||
        title.includes('just a moment');
      return {
        selectorHit,
        textHit,
        title,
        textPreview: bodyText.slice(0, 180),
        textLength: document.documentElement?.innerHTML?.length || 0,
      };
    });
    // Só a URL do intersticial conta; um asset em /cdn-cgi/ não é bloqueio.
    const lowerUrl = String(currentUrl || '').toLowerCase();
    const urlHit = lowerUrl.includes('/cdn-cgi/challenge-platform') || lowerUrl.includes('/cdn-cgi/l/chk_jschl');
    return { ...state, currentUrl, hasChallenge: !!(urlHit || state.selectorHit || state.textHit) };
  } catch (error) {
    if (isRubinotBrowserClosedError(error)) throw error;
    return { currentUrl: '', hasChallenge: true, error: String(error?.message || error) };
  }
}

async function waitForRubinotChallengeToClear(page, context, runState, label, expectedUrl) {
  const startedAt = Date.now();
  let lastUrl = '';
  let stableSince = Date.now();
  let lastDiagAt = 0;

  // ÚNICO ponto que traz a janela ao topo de propósito: aqui o Cloudflare já
  // exigiu verificação humana e o usuário PRECISA ver a caixa para resolvê-la.
  // Nos demais pontos do fluxo a consulta roda em segundo plano.
  try { await page.bringToFront(); } catch (_) {}

  while (Date.now() - startedAt < 180000) {
    throwIfRubinotRunCancelled(page, runState);
    const currentUrl = page.url();
    if (currentUrl !== lastUrl) {
      lastUrl = currentUrl;
      stableSince = Date.now();
      rubinotDiag(label, 'URL alterada durante nova validação Cloudflare individual.', { currentUrl, expectedUrl });
    }

    const challenge = await inspectRubinotChallengeOnPage(page);
    const cookies = await getRubinotCloudflareCookies(context);
    const stableMs = Date.now() - stableSince;
    const cleared = !challenge.hasChallenge && isRubinotPageUrl(page.url()) && stableMs >= 2500;

    if (Date.now() - lastDiagAt > 3000 || cleared) {
      lastDiagAt = Date.now();
      rubinotDiag(label, 'Estado da validação Cloudflare em página individual.', {
        url: page.url(),
        elapsedMs: Date.now() - startedAt,
        stableMs,
        hasChallenge: challenge.hasChallenge,
        selectorHit: challenge.selectorHit,
        textHit: challenge.textHit,
        cloudflareCookies: cookies.map(cookie => cookie.name),
      });
    }

    if (cleared) return { ok: true, elapsedMs: Date.now() - startedAt };
    await page.waitForTimeout(challenge.hasChallenge ? 1500 : 2000);
  }

  return { ok: false, error: 'Timeout aguardando nova verificação Cloudflare da página individual ser concluída.' };
}

async function ensureRubinotSessionReady(context, runState = null, label = 'session') {
  const page = await getRubinotSessionPage(context);
  const startedAt = Date.now();
  let lastUrl = '';
  let stableSince = Date.now();
  let initialNavigationDone = false;
  let lastDiagAt = 0;
  // A janela só é trazida ao topo se o Cloudflare realmente pedir interação
  // humana (ver `focusedForChallenge` abaixo). Em condições normais a sessão
  // é validada em segundo plano, sem atrapalhar o usuário.
  let focusedForChallenge = false;

  while (Date.now() - startedAt < 180000) {
    throwIfRubinotRunCancelled(page, runState);

    const currentUrl = page.url();
    if (currentUrl !== lastUrl) {
      lastUrl = currentUrl;
      stableSince = Date.now();
      rubinotDiag(label, 'URL alterada durante validação da sessão.', { currentUrl });
    }

    if (!initialNavigationDone && (currentUrl === 'about:blank' || currentUrl === 'chrome://new-tab-page/' || !isRubinotPageUrl(currentUrl))) {
      initialNavigationDone = true;
      rubinotDiag(label, 'Navegação inicial da página exclusiva de sessão para o Bazaar.', { currentUrl });
      await page.goto(RUBINOT_BAZAAR_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(error => {
        if (isRubinotBrowserClosedError(error)) throw error;
        rubinotDiag(label, 'Falha tolerada na navegação inicial.', { error: String(error?.message || error) });
      });
      await page.waitForTimeout(400);
      continue;
    }

    const content = await page.content().catch(error => {
      if (isRubinotBrowserClosedError(error)) throw error;
      return '';
    });
    const dom = await inspectRubinotBazaarDom(page);
    const cookies = await getRubinotCloudflareCookies(context);
    const hasCloudflareClearance = cookies.some(cookie => cookie.name === 'cf_clearance');
    const cloudflareSignal = isLikelyCloudflarePage(content, page.url()) || dom.hasCloudflareDom;
    const cloudflareDetected = cloudflareSignal && !(dom.hasBazaarDom && hasCloudflareClearance);

    // Só agora, e uma única vez: se o Cloudflare exige interação humana, a
    // janela precisa aparecer para o usuário resolver. Sem desafio, a consulta
    // segue em segundo plano sem tomar o foco.
    if (cloudflareDetected && !focusedForChallenge) {
      focusedForChallenge = true;
      rubinotDiag(label, 'Cloudflare exige interação: trazendo a janela ao topo.');
      try { await page.bringToFront(); } catch (_) {}
    }

    if (!cloudflareDetected && isRubinotPageUrl(page.url()) && !page.url().includes('/bazaar')) {
      rubinotDiag(label, 'Página de sessão não estava no Bazaar. Redirecionando após confirmar ausência de Cloudflare.', { currentUrl: page.url() });
      await page.goto(RUBINOT_BAZAAR_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(error => {
        if (isRubinotBrowserClosedError(error)) throw error;
        rubinotDiag(label, 'Falha tolerada ao reposicionar página de sessão no Bazaar.', { error: String(error?.message || error) });
      });
      await page.waitForTimeout(1200);
      continue;
    }

    const apiUrl = `${RUBINOT_BAZAAR_API}?${new URLSearchParams({ ...RUBINOT_BAZAAR_PARAMS, page: 1 }).toString()}`;
    const api = cloudflareDetected ? { ok: false, status: 0, isJson: false, data: null, skipped: true } : await fetchRubinotJsonDetailed(page, apiUrl);
    const apiReady = !!(api?.ok && api?.isJson && api?.data && Array.isArray(api.data.auctions));
    const stableMs = Date.now() - stableSince;
    // A exigência de estabilidade existe para não declarar a sessão pronta no
    // meio de um redirect do Cloudflare. Quando a API já respondeu JSON válido
    // e não há sinal algum de desafio, esperar mais é tempo morto — o piso cai
    // de 3500ms para 800ms, economizando ~4s em toda consulta.
    const sessionReady = isRubinotPageUrl(page.url()) && !cloudflareDetected && dom.hasBazaarDom && apiReady && stableMs >= 800;

    if (Date.now() - lastDiagAt > 3000 || sessionReady) {
      lastDiagAt = Date.now();
      rubinotDiag(label, 'Estado da validação Rubinot.', {
        url: page.url(),
        elapsedMs: Date.now() - startedAt,
        stableMs,
        cloudflareDetected,
        cloudflareSignal,
        hasCloudflareClearance,
        hasBazaarDom: dom.hasBazaarDom,
        domTextLength: dom.textLength,
        apiStatus: api?.status,
        apiReady,
        cloudflareCookies: cookies.map(cookie => cookie.name),
      });
    }

    if (sessionReady) {
      rubinotSessionReadyAt = Date.now();
      rubinotContextLastUsedAt = Date.now();
      return { ok: true, page, apiData: api.data, cookies };
    }

    // Enquanto há qualquer indício de Cloudflare, não interrompemos com goto/reload.
    // Aguardamos o fluxo natural para preservar Turnstile/cookies/redirects.
    // Sem desafio, a repetição é curta: só precisamos cruzar o piso de estabilidade.
    await page.waitForTimeout(cloudflareDetected ? 1500 : 400);
  }

  const cookies = await getRubinotCloudflareCookies(context);
  const dom = await inspectRubinotBazaarDom(page).catch(() => ({ hasCloudflareDom: false, hasBazaarDom: false, textLength: 0 }));
  const content = await page.content().catch(() => '');
  const cloudflareDetected = isLikelyCloudflarePage(content, page.url()) || dom.hasCloudflareDom;
  const message = cloudflareDetected
    ? 'O Rubinot/Cloudflare ainda exige verificação humana nesta sessão. Resolva a caixa no navegador aberto e consulte novamente; a sessão persistente será reutilizada.'
    : 'Timeout aguardando sessão Rubinot estável com Bazaar e API disponíveis.';

  rubinotDiag(label, 'Falha na validação da sessão Rubinot.', {
    url: page.url(),
    elapsedMs: Date.now() - startedAt,
    cloudflareDetected,
    hasBazaarDom: dom.hasBazaarDom,
    cloudflareCookies: cookies.map(cookie => cookie.name),
    message,
  });

  return { ok: false, needsHumanVerification: cloudflareDetected, message, page, cookies };
}

async function waitForRubinotReady(page, runState = null) {
  // Compatibilidade com chamadas antigas: a readiness real agora é feita na página
  // exclusiva de sessão via ensureRubinotSessionReady(). Para uma página avulsa,
  // apenas validamos se a página segue aberta.
  throwIfRubinotRunCancelled(page, runState);
  return { ok: true, apiData: null };
}

function normalizeRubinotAuction(auction) {
  const id = auction?.id || '';
  const currentValue = auction?.currentValue || 0;
  const startingValue = auction?.startingValue || 0;
  const hasBid = currentValue > 0;
  return {
    id,
    name: auction?.name || '',
    vocation: auction?.vocationName || auction?.vocation || '',
    level: auction?.level || 0,
    server: auction?.worldName || auction?.world || '',
    bid: hasBid ? currentValue : startingValue,
    currentValue,
    startingValue,
    hasBid,
    auctionEndTs: auction?.auctionEnd || null,
    url: id ? `https://rubinot.com.br/bazaar/${id}` : RUBINOT_BAZAAR_URL,
  };
}

async function fetchRubinotBazaarPage(page, pageNum) {
  const params = new URLSearchParams({
    ...RUBINOT_BAZAAR_PARAMS,
    page: pageNum,
  });
  return fetchRubinotJson(page, `${RUBINOT_BAZAAR_API}?${params.toString()}`);
}

// ============================================================================
// RESILIÊNCIA DA LISTAGEM — ritmo, retentativa por página e diagnóstico
// ----------------------------------------------------------------------------
// Antes: as ~61 páginas da API eram pedidas em rajada, sem nenhuma pausa entre
// as bem-sucedidas, e o resultado de cada chamada era reduzido a `data | null`
// (fetchRubinotJson descarta status HTTP). Uma única página que falhasse
// abortava a consulta inteira e nada explicava o motivo.
//
// Agora: intervalo entre páginas, retentativa isolada só da página que falhou,
// backoff progressivo (respeitando Retry-After quando o servidor envia) e
// classificação do erro a partir do status HTTP real.
// ============================================================================

// A LISTAGEM É SÓ JSON: sem render, sem DOM, sem esperar SPA. Ela precisa ser
// rápida. Os testes reais mostraram que a causa das falhas era o NAVEGADOR, não
// o ritmo das requisições — então NÃO há pausa entre páginas bem-sucedidas.
// A pausa só entra depois de uma falha, onde de fato ajuda.
/** Sem pausa entre páginas que responderam bem: a listagem volta a ser rápida. */
const RUBINOT_PAGE_INTERVAL_MS = 0;

// ── Parada antecipada por tempo de encerramento ─────────────────────────────
// A API é pedida com `sortBy=auction_end&sortOrder=asc`, ou seja, os leilões
// vêm do que encerra PRIMEIRO para o que encerra POR ÚLTIMO. Logo, ao topar com
// o primeiro leilão que encerra depois do limite configurado, todos os
// seguintes também estarão fora — e não há motivo para baixar o resto.
//
// Com um filtro de 1 dia isso costuma reduzir de ~61 páginas para ~3-6.
//
// A parada só é permitida quando a ordenação é EXATAMENTE a esperada; qualquer
// outra ordenação desliga a otimização e a listagem é percorrida inteira.
const RUBINOT_EARLY_STOP_SORT = { sortBy: 'auction_end', sortOrder: 'asc' };

/** true quando a ordenação vigente garante ordem crescente de encerramento. */
function canUseRubinotEarlyStop() {
  return RUBINOT_BAZAAR_PARAMS.sortBy === RUBINOT_EARLY_STOP_SORT.sortBy &&
    RUBINOT_BAZAAR_PARAMS.sortOrder === RUBINOT_EARLY_STOP_SORT.sortOrder;
}

/** Normaliza o carimbo do leilão para segundos (a API às vezes manda ms). */
function normalizeRubinotAuctionEnd(value) {
  const ts = Number(value || 0);
  if (!Number.isFinite(ts) || ts <= 0) return 0;
  return ts > 1_000_000_000_000 ? Math.floor(ts / 1000) : Math.floor(ts);
}

/**
 * Decide se a leitura pode parar após esta página.
 *
 * Só para quando encontra um leilão ALÉM do limite: como a lista é crescente,
 * isso prova que o corte foi alcançado. Leilões sem data (ts = 0) nunca
 * disparam a parada — na dúvida, continuamos lendo.
 */
function shouldStopRubinotListing(auctions, endLimitTs) {
  if (!endLimitTs || !canUseRubinotEarlyStop()) return false;
  for (const auction of auctions) {
    const endTs = normalizeRubinotAuctionEnd(auction?.auctionEndTs);
    if (endTs > 0 && endTs > endLimitTs) return true;
  }
  return false;
}
/** Pausa aplicada só na passada de recuperação das páginas que falharam. */
const RUBINOT_PAGE_RECOVERY_INTERVAL_MS = 900;
/** Tentativas por página: 1 inicial + 2 retentativas. */
const RUBINOT_PAGE_MAX_ATTEMPTS = 3;
/** Base do backoff progressivo entre tentativas da MESMA página (ms). */
const RUBINOT_PAGE_BACKOFF_MS = 1500;

// ── Análise individual: orçamento real de renderização da SPA ───────────────
// A página do leilão monta o botão "Bosstiary" só depois de hidratar. Esperar
// de verdade (waitFor) é o que corrige a falha na maioria dos personagens.
// Na recarga o HTML já vem do cache, então o orçamento é menor.
// ── Orçamento de tempo da página individual ─────────────────────────────────
// A decisão sai de uma corrida de três estados (Bosstiary / erro / timeout).
// Confirmada a falha, NÃO recarregamos: os testes reais mostraram que o reload
// nunca recuperou uma página com "Falha ao carregar leilão". O que recupera
// esses casos é o retry final com OUTRO NAVEGADOR.
//
// ============================================================================
// MODOS DE VELOCIDADE — todos os tempos da análise individual ficam AQUI
// ----------------------------------------------------------------------------
// Dois perfis, escolhidos pelo usuário no modal:
//
//   • AGRESSIVO — menor valor seguro em cada etapa. Abandona rápido páginas
//     inválidas e não gasta tempo com o que não vai dar certo. Preserva apenas
//     o mínimo para uma página VÁLIDA conseguir montar a Bosstiary.
//   • MODERADO  — tempos mais folgados. Prioriza estabilidade e reduz o risco
//     de falso negativo por carregamento lento.
//
// O que NÃO muda entre os modos (é correção, não velocidade):
//   • a detecção de "Falha ao carregar leilão" continua imediata nos dois;
//   • a Bosstiary, uma vez encontrada, é analisada com o tempo que precisar.
//
// Lição de campo preservada: o que degrada o site é o encadeamento de
// NAVEGAÇÕES (uma página completa por personagem). Já as ações DENTRO da
// Bosstiary — abrir a aba, pesquisar, limpar a busca — não geram requisições,
// pois a página já está carregada e o filtro roda no cliente. Por isso os
// intervalos internos são curtos nos dois modos.
//
// Ajuste fino: mexa APENAS nesta tabela.
// ============================================================================

const RUBINOT_SPEED_MODES = {
  agressivo: {
    label: 'Agressivo',
    // Teto para a página se tornar utilizável (aba Bosstiary presente).
    bosstiaryWaitMs: 700,
    // Espera pelo PAINEL depois do clique na aba (página já é válida aqui).
    bosstiaryPanelWaitMs: 4000,
    // Assentamento antes de ler as linhas.
    bosstiarySettleMs: 200,
    // Intervalo BASE entre personagens.
    detailsGapMs: 300,
    // Pausas internas da Bosstiary (sem requisição ao servidor).
    bosstiaryOpenGapMs: 80,
    bosstiarySearchGapMs: 80,
    bosstiaryPageGapMs: 300,
    // Trégua após falha confirmada, para não emendar a próxima navegação.
    failureCooldownMs: 500,
    // Timeout da navegação até a página individual.
    navTimeoutMs: 7000,
    // Desaceleração adaptativa (sequências de falha).
    paceFailureTrigger: 3,
    paceStepMs: 400,
    paceMaxExtraMs: 2000,
    paceRecoverMs: 400,
  },
  moderado: {
    label: 'Moderado',
    bosstiaryWaitMs: 1500,
    bosstiaryPanelWaitMs: 6000,
    bosstiarySettleMs: 400,
    detailsGapMs: 800,
    bosstiaryOpenGapMs: 150,
    bosstiarySearchGapMs: 150,
    bosstiaryPageGapMs: 500,
    failureCooldownMs: 1500,
    navTimeoutMs: 9000,
    paceFailureTrigger: 2,
    paceStepMs: 700,
    paceMaxExtraMs: 3500,
    paceRecoverMs: 250,
  },
};

/** Modo padrão: equilíbrio já validado em campo. */
const RUBINOT_DEFAULT_SPEED_MODE = 'moderado';

/** Modo em vigor nesta consulta (vale também para os retries). */
let rubinotSpeedMode = RUBINOT_DEFAULT_SPEED_MODE;

/** Normaliza a escolha vinda do renderer. */
function resolveRubinotSpeedMode(value) {
  const key = String(value || '').trim().toLowerCase();
  return RUBINOT_SPEED_MODES[key] ? key : RUBINOT_DEFAULT_SPEED_MODE;
}

/**
 * Tempos do modo ATUAL.
 *
 * Lido a cada uso (e não capturado numa constante) para que o modo escolhido
 * valha imediatamente — inclusive nas passadas de retry, que rodam depois.
 */
function speed() {
  return RUBINOT_SPEED_MODES[rubinotSpeedMode] || RUBINOT_SPEED_MODES[RUBINOT_DEFAULT_SPEED_MODE];
}

// ── Desaceleração adaptativa ────────────────────────────────────────────────
// Os valores vêm do modo em vigor (ver tabela acima).

/** Acréscimo de ritmo em vigor e sequência de falhas atual. */
let rubinotPaceExtraMs = 0;
let rubinotPaceFailureStreak = 0;

// ── PROGRESSO POR NAVEGADOR (apenas exibição) ───────────────────────────────
// Acompanha, ao vivo, o que cada navegador já analisou e quantas falhas teve.
// Vive fora de `runRubinotDetailsPass` porque precisa SOBREVIVER à troca de
// navegador — é o que permite mostrar o histórico completo da execução.
//
// `rubinotRunBrowserStats` é uma lista ordenada: cada entrada é um navegador
// que já rodou ou está rodando. Nunca há duas entradas para o mesmo navegador
// numa passada, então não existe risco de contagem duplicada.
let rubinotRunBrowserStats = [];
/** Navegadores da cadeia que ainda não começaram. */
let rubinotRunPendingBrowsers = [];
/**
 * Navegadores MARCADOS para retry nesta consulta.
 *
 * Diferente de `rubinotRunPendingBrowsers`, que encolhe conforme cada um roda,
 * esta lista é fixa durante toda a execução — é a configuração escolhida pelo
 * usuário, exibida no painel de progresso do início ao fim.
 */
let rubinotRunRetrySelection = [];
/**
 * PLANO de retries desta consulta: a cadeia JÁ EXPANDIDA pela quantidade de
 * tentativas de cada navegador (ver `buildRubinotRetryPlan`).
 *
 * Cada item é uma passada real — dois retries do WebKit são DOIS itens. Fica
 * fixo do início ao fim; quem encolhe conforme as passadas rodam é
 * `rubinotRunPendingSteps`.
 */
let rubinotRunRetryPlan = [];
/** Passadas do plano que ainda não começaram (mesmos itens de `rubinotRunRetryPlan`). */
let rubinotRunPendingSteps = [];

// ── ENCERRAMENTO MANUAL ("Concluir agora") ──────────────────────────────────
//
// Diferente do cancelamento por navegador fechado, que DESCARTA o resultado,
// este é um encerramento LIMPO: a consulta para de abrir novas páginas, mas
// tudo que já foi analisado com sucesso é preservado e devolvido normalmente.
//
// A parada é COOPERATIVA: nada é abortado no meio. O laço termina o personagem
// atual (ou nem o inicia) e sai pela porta da frente, com `ok: true`. É isso
// que impede estado corrompido e escrita pela metade.
let rubinotManualStopRequested = false;

/** Liga o pedido de encerramento. O laço decide QUANDO parar, com segurança. */
function requestRubinotManualStop() {
  rubinotManualStopRequested = true;
  rubinotDiag('stop', 'Encerramento manual solicitado. A consulta será finalizada no próximo ponto seguro.');
}

/** Zera o pedido. Chamado no início de CADA consulta. */
function resetRubinotManualStop() {
  rubinotManualStopRequested = false;
}

/** `true` quando o usuário pediu para concluir agora. */
function isRubinotManualStopRequested() {
  return rubinotManualStopRequested === true;
}

/** Zera o acompanhamento. Chamado no início de CADA consulta. */
function resetRubinotRunProgress() {
  rubinotRunBrowserStats = [];
  rubinotRunPendingBrowsers = [];
  rubinotRunPendingSteps = [];
}

/** Abre a entrada do navegador que está começando a rodar. */
function startRubinotBrowserStats(browserKey, total, isRetry, attempt = 0, attempts = 0) {
  rubinotRunBrowserStats.push({
    browser: browserKey,
    label: RUBINOT_BROWSERS[browserKey]?.label || browserKey,
    isRetry: !!isRetry,
    // Qual tentativa deste navegador está rodando (1..N). 0 na passada
    // principal, que não é retry. Serve para diferenciar as várias entradas do
    // MESMO navegador no quadro de progresso.
    attempt: Math.max(0, Number(attempt) || 0),
    attempts: Math.max(0, Number(attempts) || 0),
    total: Math.max(0, Number(total) || 0),
    analyzed: 0,
    failed: 0,
    done: false,
  });
  // A passada que começou sai da fila de pendentes. Só UMA ocorrência é
  // removida: um navegador com 2 retries tem 2 itens na fila.
  const index = rubinotRunPendingSteps.findIndex(step => step.browser === browserKey);
  if (index >= 0) rubinotRunPendingSteps.splice(index, 1);
  rubinotRunPendingBrowsers = rubinotRunPendingSteps.map(step => step.browser);
}

/** Atualiza a entrada ATUAL (a última aberta) após cada personagem. */
function updateRubinotBrowserStats(analyzed, failed) {
  const current = rubinotRunBrowserStats[rubinotRunBrowserStats.length - 1];
  if (!current) return;
  current.analyzed = analyzed;
  current.failed = failed;
}

/** Marca a entrada atual como concluída. */
function finishRubinotBrowserStats() {
  const current = rubinotRunBrowserStats[rubinotRunBrowserStats.length - 1];
  if (current) current.done = true;
}

/**
 * Fotografia do progresso por navegador, para o renderer.
 * `failureRate` = falhas / analisados até agora (0 quando nada foi analisado).
 */
function buildRubinotBrowserProgress() {
  return {
    // Configuração desta consulta — fixa do início ao fim, inclusive durante
    // os retries. Só exibição: nada aqui influencia a lógica.
    speedMode: rubinotSpeedMode,
    speedModeLabel: RUBINOT_SPEED_MODES[rubinotSpeedMode]?.label || rubinotSpeedMode,
    // `attempts` = quantas passadas aquele navegador fará nesta consulta.
    retrySelection: summarizeRubinotRetryPlan(rubinotRunRetryPlan).map(entry => ({
      browser: entry.browser,
      label: RUBINOT_BROWSERS[entry.browser]?.label || entry.browser,
      attempts: entry.attempts,
    })),
    /** Total de passadas de retry planejadas e quantas ainda faltam. */
    retryStepsTotal: rubinotRunRetryPlan.length,
    retryStepsPending: rubinotRunPendingSteps.length,
    browserStats: rubinotRunBrowserStats.map(stat => ({
      browser: stat.browser,
      label: stat.label,
      isRetry: stat.isRetry,
      attempt: stat.attempt,
      attempts: stat.attempts,
      total: stat.total,
      analyzed: stat.analyzed,
      failed: stat.failed,
      done: stat.done,
      failureRate: stat.analyzed > 0 ? Math.round((stat.failed / stat.analyzed) * 100) : 0,
    })),
    // Uma entrada por PASSADA ainda não iniciada, com o número da tentativa.
    pendingBrowsers: rubinotRunPendingSteps.map(step => ({
      browser: step.browser,
      label: RUBINOT_BROWSERS[step.browser]?.label || step.browser,
      attempt: step.attempt,
      attempts: step.attempts,
    })),
  };
}

/** Zera o ritmo. Chamado no início de cada passada (principal e retry). */
function resetRubinotPace() {
  rubinotPaceExtraMs = 0;
  rubinotPaceFailureStreak = 0;
  rubinotPendingCooldownMs = 0;
}

/**
 * Atualiza o ritmo conforme o resultado do personagem.
 *
 * Falhas isoladas não mudam nada: uma página ruim é normal. A desaceleração só
 * entra quando as falhas viram SEQUÊNCIA — sinal de que o site está sob
 * pressão. A recuperação é gradual, para não voltar a acelerar de uma vez e
 * reabrir o mesmo problema.
 */
function registerRubinotPaceOutcome(succeeded) {
  if (succeeded) {
    rubinotPaceFailureStreak = 0;
    rubinotPaceExtraMs = Math.max(0, rubinotPaceExtraMs - speed().paceRecoverMs);
    return;
  }
  rubinotPaceFailureStreak += 1;
  if (rubinotPaceFailureStreak >= speed().paceFailureTrigger) {
    rubinotPaceExtraMs = Math.min(speed().paceMaxExtraMs, rubinotPaceExtraMs + speed().paceStepMs);
  }
}

/**
 * Trégua pendente após uma falha confirmada.
 *
 * Em vez de bloquear o personagem que acabou de falhar, a trégua vira uma
 * "dívida" que o intervalo NORMAL entre personagens absorve. O site recebe o
 * mesmo respiro, sem espera duplicada.
 */
let rubinotPendingCooldownMs = 0;

/** Agenda a trégua para o próximo intervalo entre personagens. */
function scheduleRubinotFailureCooldown(ms) {
  const value = Number(ms) || 0;
  if (value > rubinotPendingCooldownMs) rubinotPendingCooldownMs = value;
}

/** Consome a trégua pendente (uma única vez). */
function consumeRubinotPendingCooldownMs() {
  const pending = rubinotPendingCooldownMs;
  rubinotPendingCooldownMs = 0;
  return pending;
}

/**
 * Intervalo efetivo entre personagens neste momento.
 *
 * A trégua pendente NÃO se soma ao intervalo: ela é absorvida por ele. Se a
 * trégua for maior, o intervalo cresce até ela; se for menor, nada muda.
 */
function getRubinotPaceGapMs() {
  const base = speed().detailsGapMs + rubinotPaceExtraMs;
  return Math.max(base, consumeRubinotPendingCooldownMs());
}
/** Timeout da navegação até a página individual. */
const RUBINOT_DETAILS_NAV_TIMEOUT_MS = 8000;

/**
 * Diagnostica por que a página do leilão não apresentou o botão Bosstiary.
 * Diferencia Cloudflare, erro do próprio RubinOT, página vazia e SPA lenta —
 * evitando recarregar às cegas e permitindo classificar a falha no log.
 */
/**
 * Detecta o erro que o PRÓPRIO RubinOT exibe na página do leilão:
 *
 *   <p class="text-sm font-medium mb-2">Falha ao carregar leilão</p>
 *
 * A detecção é por TEXTO, não pela cadeia CSS (`body > div.min-h-screen > ...`),
 * que quebraria a cada ajuste de layout do site. Comparamos sem acentos e sem
 * caixa, cobrindo também as variantes em inglês.
 *
 * Resolve assim que o texto aparece — é isso que torna o tratamento rápido.
 * Retorna `false` no timeout, sem lançar.
 */
/**
 * Detecta o estado "personagem nunca matou boss algum" na Bosstiary.
 *
 * O RubinOT renderiza, quando NÃO há progresso algum:
 *   <p class="...">Nenhum progresso de bosstiary.</p>
 *
 * Isso é prova POSITIVA de que a Bosstiary carregou e está legitimamente
 * vazia — logo, Soul War e Sanguine estão AMBAS disponíveis.
 *
 * CUIDADO (motivo de a checagem ser tão específica): a Bosstiary também exibe
 * mensagens de BUSCA sem resultado, como:
 *   Nenhum boss encontrado com "Gosh".
 * Essa segunda mensagem significa apenas que aquele termo não retornou nada —
 * o personagem pode ter dezenas de outros bosses. Confundir as duas marcaria
 * quests como disponíveis sem base.
 *
 * Por isso exigimos a frase "nenhum progresso de bosstiary" e rejeitamos
 * explicitamente qualquer texto de "nenhum boss encontrado".
 */
async function detectRubinotBosstiaryNoProgress(page) {
  try {
    return await page.evaluate(() => {
      const strip = (value) => String(value || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

      // Frase exata do estado "sem progresso algum".
      const NO_PROGRESS = 'nenhum progresso de bosstiary';
      // Frase de busca sem resultado — NÃO indica ausência total de progresso.
      const SEARCH_EMPTY = 'nenhum boss encontrado';

      for (const element of document.querySelectorAll('p, span, div')) {
        const text = strip(element.textContent);
        if (!text || text.length > 120) continue;
        if (text.includes(SEARCH_EMPTY)) continue;      // ignora resultado de busca
        if (text.includes(NO_PROGRESS)) return true;
      }
      return false;
    });
  } catch (error) {
    if (isRubinotBrowserClosedError(error)) throw error;
    return false;
  }
}

/**
 * VALIDAÇÃO FINAL da página do leilão, executada logo ANTES de salvar o
 * resultado do personagem.
 *
 * Existe um caso raro em que a página abre bem, a análise começa e só então ela
 * degrada para "Falha ao carregar leilão". Como a leitura da Bosstiary pode
 * levar segundos (paginação, buscas), essa janela permite que a tabela suma no
 * meio do caminho. Sem esta checagem, o resultado seria uma Bosstiary VAZIA —
 * e uma tabela vazia vira `soulwarCompleted: false`, que o filtro interpreta
 * como "quest disponível". Ou seja: um falso positivo entrando na lista final.
 *
 * Retorna `{ ok: true }` só quando a página continua íntegra.
 */
async function validateRubinotAuctionPageAfterAnalysis(page) {
  try {
    const state = await page.evaluate(() => {
      const strip = (value) => String(value || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      const bodyText = String(document.body?.innerText || '');
      const lower = strip(bodyText);

      const errorPatterns = ['falha ao carregar', 'failed to load', 'erro ao carregar'];
      const hasErrorText = errorPatterns.some(pattern => lower.includes(pattern));

      const cloudflarePatterns = ['just a moment', 'checking your browser', 'verificacao de seguranca', 'sou humano'];
      const hasCloudflare = cloudflarePatterns.some(pattern => lower.includes(pattern)) ||
        !!document.querySelector('iframe[src*="turnstile"], input[name="cf-turnstile-response"]');

      // Marcas de que o PAINEL da Bosstiary está montado.
      //
      // IMPORTANTE: não exigimos LINHAS na tabela. Um personagem que nunca
      // matou boss algum tem a Bosstiary legitimamente vazia — e é o caso mais
      // valioso do filtro (as duas quests disponíveis). O que precisamos provar
      // é que o painel foi RENDERIZADO, não que ele tem conteúdo.
      const hasBosstiaryTab = Array.from(document.querySelectorAll('button, a, [role="tab"]'))
        .some(element => strip(element.textContent).includes('bosstiary'));

      // Estrutura da tabela (o <table>/<tbody> existe mesmo sem linhas).
      const hasTableStructure = !!document.querySelector('table tbody, table thead, [role="table"]');
      // Campo de busca da Bosstiary — presente mesmo com a lista vazia.
      const hasBossSearch = Array.from(document.querySelectorAll('input'))
        .some(input => String(input.getAttribute('placeholder') || '').toLowerCase().includes('boss'));
      // Indicador de paginação ("Page X of Y").
      const hasPageIndicator = Array.from(document.querySelectorAll('span, div, p'))
        .some(element => /^page\s+\d+\s+of\s+\d+$/i.test(String(element.textContent || '').trim()));
      // Mensagem explícita de lista vazia — prova positiva de leitura bem-sucedida.
      // "nenhum progresso de bosstiary" é o texto REAL do RubinOT para um
      // personagem sem bosses; os demais cobrem variações e o inglês.
      const hasEmptyState = ['nenhum progresso de bosstiary', 'nenhum boss', 'no bosses', 'sem registros', 'no results', 'nenhum resultado']
        .some(pattern => lower.includes(pattern));
      // Linhas de verdade.
      const hasBossRows = !!document.querySelector('tbody tr td:nth-child(3)');

      return {
        hasErrorText, hasCloudflare, hasBosstiaryTab,
        hasBossRows, hasEmptyState,
        // Painel montado = qualquer evidência estrutural, COM ou SEM linhas.
        hasBosstiaryContent: hasBossRows || hasTableStructure || hasBossSearch || hasPageIndicator || hasEmptyState,
        bodyLength: bodyText.length,
        currentUrl: String(location.href || '').slice(0, 200),
      };
    });

    if (state.hasErrorText) return { ok: false, reason: 'RUBINOT_ERRO_APP', stage: 'pos-analise', state };
    if (state.hasCloudflare) return { ok: false, reason: 'CLOUDFLARE', stage: 'pos-analise', state };
    if (state.bodyLength < 50) return { ok: false, reason: 'PAGINA_VAZIA', stage: 'pos-analise', state };

    // REGRA PRINCIPAL: com a aba Bosstiary presente e sem erro/Cloudflare, o
    // personagem NÃO é descartado. Antes exigíamos também `hasBosstiaryContent`,
    // e uma página boa cujo painel ainda estivesse montando era jogada fora
    // mesmo com a aba disponível — o personagem ia para o retry sem motivo.
    //
    // A ausência do painel deixa de ser falha e passa a ser apenas um aviso: a
    // leitura da Bosstiary já terminou neste ponto, e o que ela encontrou (ou
    // não) é o resultado legítimo.
    if (!state.hasBosstiaryTab) {
      return { ok: false, reason: 'PAGINA_OK_SEM_BOSSTIARY', stage: 'pos-analise', state };
    }
    return { ok: true, state, panelMissing: !state.hasBosstiaryContent };
  } catch (error) {
    if (isRubinotBrowserClosedError(error)) throw error;
    // Na dúvida, considerar falha: nunca publicar um personagem sem confirmação.
    return { ok: false, reason: 'DIAGNOSTICO_FALHOU', stage: 'pos-analise', error: String(error?.message || error).slice(0, 160) };
  }
}

/**
 * Preenche um campo sem depender de foco da janela.
 *
 * `locator.fill()` foca o elemento e simula digitação; com a janela em segundo
 * plano isso pode falhar. O fallback escreve o valor direto no DOM e dispara
 * `input`/`change`, que é o que os componentes React escutam.
 */
// ============================================================================
// SENTINELA DE FALHA — estado TERMINAL observado durante toda a análise
//
// A RACE CONDITION QUE ISTO RESOLVE
// ---------------------------------------------------------------------------
// As corridas por `waitForFunction` já cobriam as ESPERAS POR ELEMENTO. O que
// ficava desprotegido eram as AÇÕES do Playwright sobre um locator:
//
//     clickWithoutFocus  → locator.click()   3.000ms + elementHandle 500ms
//     fillWithoutFocus   → locator.fill()    1.500ms + elementHandle 500ms
//     scrollIntoViewIfNeeded                 1.500ms
//     input.isVisible()                        700ms
//
// Quando a página degrada para "Falha ao carregar leilão" DEPOIS de já ter
// parecido válida, o React desmonta o painel e esses elementos somem. O
// Playwright então re-tenta a ação até o timeout inteiro, porque para ele
// "elemento ainda não apareceu" é indistinguível de "elemento nunca virá".
//
// Medido: clique perdido = 3.505ms; cada busca perdida = 5.507ms. No pior caso
// (falha logo após clicar em Bosstiary, com Sanguine exigida) são
// 3.505 + 6 × 5.507 ≈ 36.500ms de espera inútil — exatamente o "fica parado
// muito tempo" relatado.
//
// A SOLUÇÃO
// ---------------------------------------------------------------------------
// Um SENTINELA por personagem: um único `waitForFunction` com polling por
// temporizador (`RUBINOT_DOM_POLL_MS`) que resolve APENAS quando a falha aparece.
// Ele roda em paralelo à análise inteira, do carregamento até a validação final.
//
// Toda ação passa por `runWithFailureSentinel`, que faz `Promise.race` entre a
// ação e o sentinela. Se a falha vencer, a ação é abandonada na hora — não
// esperamos o timeout dela.
//
// Por que `Promise.race` aqui é seguro (e não foi nas esperas por elemento):
// o ramo perdedor é UMA promessa do Playwright que será descartada junto com a
// página; não é um laço de polling nosso varrendo o DOM indefinidamente. O
// sentinela é único e explicitamente encerrado no `finally` do personagem.
//
// FALSO POSITIVO: o sentinela SÓ resolve com o texto de falha real. Página
// lenta, ainda carregando ou sem um elemento momentaneamente NUNCA o dispara —
// ele não tem timeout próprio de "desistência", apenas observa.
// ============================================================================

/**
 * Chave do token de cancelamento injetado na página.
 *
 * A versão anterior observava em JANELAS de 1s renovadas em laço. Isso evitava
 * o vazamento do `timeout: 0`, mas custava caro no caminho normal: numa
 * análise de ~8s o Playwright injetava e descartava ~8 `waitForFunction`
 * seguidos, cada um reiniciando o polling na página — trabalho puro em cima do
 * renderer justamente enquanto a análise precisava dele.
 *
 * Agora usamos UMA única espera, cancelável: o predicado também observa este
 * token. `dispose()` marca o token e a espera resolve no ciclo seguinte,
 * encerrando de verdade — sem recriação e sem vazamento.
 */
const RUBINOT_SENTINEL_CANCEL_KEY = '__rubinotSentinelCancelled';

/**
 * Cria o observador de falha da página do personagem.
 *
 * Devolve um objeto com:
 *   • `promise`   — resolve (uma única vez) quando a falha aparece;
 *   • `fired()`   — se a falha já foi observada;
 *   • `firstSeenAt` / `elapsedSinceValid()` — métricas para diagnóstico;
 *   • `markValid()` — registra o instante em que a página pareceu válida;
 *   • `dispose()` — encerra o observador. SEMPRE chamado no `finally`.
 *
 * `dispose()` não deixa nada pendurado: o `waitForFunction` é cancelado pelo
 * fechamento da página ou simplesmente rejeitado e engolido, e nenhum timer
 * nosso permanece ativo.
 */
function createRubinotFailureSentinel(page, id) {
  const startedAt = Date.now();
  let disposed = false;
  let firedAt = 0;
  let validAt = 0;

  let resolveFailure;
  const promise = new Promise(resolve => { resolveFailure = resolve; });

  // ESPERA ÚNICA e cancelável.
  //
  // O predicado resolve em dois casos: falha na tela ('load-error') ou token
  // de cancelamento marcado ('cancelled'). Assim `dispose()` encerra a espera
  // de imediato, sem recriá-la a cada segundo e sem deixar polling órfão.
  const watcher = page.waitForFunction(({ patterns, cancelKey }) => {
    if (window[cancelKey]) return 'cancelled';
    const strip = (value) => String(value || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    for (const element of document.querySelectorAll('p, span, div, h1, h2, h3')) {
      const text = strip(element.textContent);
      if (text.length > 0 && text.length <= 120 && patterns.some(pattern => text.includes(pattern))) {
        return 'load-error';
      }
    }
    return null;
  }, { patterns: RUBINOT_LOAD_FAILURE_PATTERNS, cancelKey: RUBINOT_SENTINEL_CANCEL_KEY },
  { timeout: 0, polling: RUBINOT_DOM_POLL_MS })
    .then(async handle => {
      const value = await handle.jsonValue().catch(() => 'cancelled');
      if (disposed || value !== 'load-error') return;
      firedAt = Date.now();
      resolveFailure('load-error');
    })
    .catch(() => { /* página fechada/navegou: nada a fazer */ });

  return {
    promise,
    fired: () => firedAt > 0,
    firstSeenAt: () => firedAt,
    markValid: () => { if (!validAt) validAt = Date.now(); },
    elapsedSincePageOpen: () => Date.now() - startedAt,
    elapsedSinceValid: () => (validAt ? Date.now() - validAt : null),
    validAt: () => validAt,
    dispose() {
      if (disposed) return;
      disposed = true;
      // 1) Libera quem aguardava — SÍNCRONO, o personagem termina na hora.
      resolveFailure(undefined);
      // 2) Marca o token na página para a espera encerrar sozinha. É
      //    fire-and-forget de propósito: o próximo personagem NÃO espera por
      //    isto. Se a página já fechou/navegou, o erro é irrelevante.
      try {
        page.evaluate((key) => { window[key] = true; }, RUBINOT_SENTINEL_CANCEL_KEY)
          .catch(() => {});
      } catch (_) { /* página indisponível: a espera morre com ela */ }
      watcher.catch(() => {});
    },
    id,
  };
}

/**
 * Executa uma ação do Playwright competindo com o sentinela.
 *
 * A falha vence imediatamente e lança `RubinotLoadFailureError`, cortando o
 * timeout da ação. Sem sentinela (ou já descartado), a ação roda normalmente —
 * nenhuma chamada existente muda de comportamento.
 */
async function runWithFailureSentinel(sentinel, stage, action) {
  if (!sentinel) return action();
  if (sentinel.fired()) throw new RubinotLoadFailureError(stage);

  // A ação é iniciada UMA única vez; a corrida apenas escolhe quem responde
  // primeiro. Reexecutar a ação aqui dispararia cliques/preenchimentos
  // duplicados na página.
  const running = action().then(value => ({ value }), error => ({ error }));
  const watching = sentinel.promise.then(signal => ({ signal }));

  const outcome = await Promise.race([running, watching]);

  // Falha venceu: abandona a ação em andamento (a promessa é descartada junto
  // com a página do personagem, sem ficar pendurada num laço nosso).
  if (outcome.signal === 'load-error') throw new RubinotLoadFailureError(stage);

  // O sentinela foi DESCARTADO (fim do personagem) antes de a ação terminar:
  // não há falha, então apenas aguardamos a ação já iniciada.
  const settled = outcome.signal === undefined && 'signal' in outcome
    ? await running
    : outcome;

  if (settled.error) throw settled.error;
  return settled.value;
}

async function fillWithoutFocus(page, locator, value, timeoutMs = 1500) {
  try {
    await locator.fill(value, { timeout: timeoutMs });
    return true;
  } catch (_) {
    try {
      const handle = await locator.elementHandle({ timeout: 500 });
      if (!handle) return false;
      await handle.evaluate((element, text) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(element, text); else element.value = text;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }, value);
      await handle.dispose();
      return true;
    } catch (_) {
      return false;
    }
  }
}

/**
 * Clique que NÃO depende de foco nem de posição na tela.
 *
 * `locator.click()` faz verificações de "actionability" e injeta um evento de
 * mouse nas coordenadas do elemento — com a janela em segundo plano (sobretudo
 * no Firefox) isso pode não chegar ao alvo. `element.click()` do DOM dispara o
 * mesmo evento que o React escuta, sem exigir viewport visível nem foco.
 *
 * Mantemos `locator.click()` como primeira opção porque ele espera o elemento
 * ficar estável; só caímos para o DOM se ele falhar.
 */
async function clickWithoutFocus(page, locator, timeoutMs = 3000) {
  try {
    await locator.click({ timeout: timeoutMs });
    return true;
  } catch (_) {
    try {
      const handle = await locator.elementHandle({ timeout: 500 });
      if (!handle) return false;
      await handle.evaluate((element) => element.click());
      await handle.dispose();
      return true;
    } catch (_) {
      return false;
    }
  }
}

/**
 * Checagem INSTANTÂNEA (uma avaliação, sem espera) do texto de erro do RubinOT.
 * Usada logo após navegar: se o erro já está no DOM, pulamos direto para a
 * confirmação em vez de entrar na corrida e gastar o orçamento.
 */
async function hasRubinotAuctionLoadErrorNow(page) {
  try {
    return await page.evaluate(() => {
      const strip = (value) => String(value || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      const patterns = ['falha ao carregar', 'failed to load', 'erro ao carregar'];
      for (const element of document.querySelectorAll('p, span, div, h1, h2, h3')) {
        const text = strip(element.textContent);
        if (text.length > 0 && text.length <= 120 && patterns.some(pattern => text.includes(pattern))) return true;
      }
      return false;
    });
  } catch (_) {
    return false;
  }
}


/**
 * A página do leilão está VIVA (apenas lenta) ou está morta/quebrada?
 *
 * Chamada quando a corrida inicial estoura sem a aba Bosstiary e sem texto de
 * erro. É o que separa os dois casos que antes eram tratados como um só:
 *
 *   • VIVA   -> o HTML do leilão já chegou (nome/nível/lances/abas), a SPA só
 *               ainda não montou a aba Bosstiary. Merece prorrogação.
 *   • MORTA  -> corpo vazio, erro do site ou Cloudflare. Descartar na hora,
 *               sem gastar mais tempo.
 *
 * Sem esta distinção, uma página boa e lenta era descartada exatamente como
 * uma página quebrada — era essa a causa dos personagens pulados.
 */
/**
 * Intervalo de polling das esperas da análise individual.
 *
 * CAUSA RAIZ DAS PÁGINAS VÁLIDAS IGNORADAS NO WEBKIT
 * ---------------------------------------------------------------------------
 * `locator.waitFor()` e `page.waitForFunction()` SEM a opção `polling` são
 * avaliados dentro de `requestAnimationFrame` (confirmado no bundle do
 * Playwright: `if (typeof polling !== "number") requestAnimationFrame(next)`).
 *
 * A análise individual roda de propósito com a janela em SEGUNDO PLANO — não
 * chamamos `bringToFront()` por personagem para não roubar o foco do usuário.
 * O WebKit suspende agressivamente o `requestAnimationFrame` de janelas
 * ocultas/sem foco, e — ao contrário do Chromium e do Firefox — não aceita
 * flags nem preferências para desligar isso (`launchOptions.args` é descartado
 * para motores não-Chromium).
 *
 * Resultado: a espera pelo botão Bosstiary simplesmente NÃO ERA AVALIADA e
 * estourava por timeout, mesmo com o botão visível na tela. Já a detecção de
 * "Falha ao carregar leilão" usava `polling: 120` (base em `setTimeout`) e
 * continuava funcionando. Daí a assimetria observada: as falhas eram
 * detectadas, os sucessos não — e páginas boas eram descartadas.
 *
 * Usar polling por temporizador elimina a dependência de rAF. Isto NÃO é
 * contorno de proteção alguma: é apenas escolher o modo de polling correto
 * para uma janela em segundo plano.
 */
const RUBINOT_DOM_POLL_MS = 100;

/**
 * Espera o botão/aba "Bosstiary" ficar VISÍVEL E UTILIZÁVEL.
 *
 * Feito com polling por temporizador (ver RUBINOT_DOM_POLL_MS) e checagem de
 * usabilidade direto no DOM — sem depender de rAF nem das verificações de
 * estabilidade do Playwright, que também são baseadas em rAF.
 *
 * Regra do fluxo: assim que este predicado for verdadeiro, o personagem é
 * considerado VÁLIDO e a análise prossegue, mesmo que o resto da página ainda
 * esteja carregando.
 */
/**
 * Corrida ATÔMICA entre "aba Bosstiary" e "Falha ao carregar leilão".
 *
 * POR QUE UMA ÚNICA ESPERA, E NÃO UM Promise.race DE DUAS
 * ---------------------------------------------------------------------------
 * Antes eram duas esperas independentes dentro de um `Promise.race`. O
 * problema: `Promise.race` resolve com a primeira, mas NÃO cancela a outra.
 * Quando o erro era detectado em ~200ms, a espera pela aba Bosstiary continuava
 * varrendo o DOM da página a cada 100ms por até 5,5s — já com o script seguindo
 * adiante. Isso disputava CPU com o personagem seguinte e mantinha uma promessa
 * órfã presa à página que estava prestes a ser abandonada.
 *
 * Agora um ÚNICO `waitForFunction` avalia os dois sinais no mesmo laço e
 * devolve qual deles ocorreu. Não existe ramo perdedor: quando a função
 * retorna, nenhuma verificação continua pendente naquela página.
 *
 * Retorna 'bosstiary' | 'load-error' | 'timeout'.
 */
// ============================================================================
// DETECÇÃO CENTRALIZADA DE "Falha ao carregar leilão"
//
// AUDITORIA — o que estava segurando o script
// ---------------------------------------------------------------------------
// A corrida inicial (`waitForRubinotAuctionOutcome`) já detectava o erro em
// ~100ms. O problema estava DEPOIS dela: uma página podia abrir bem e degradar
// no meio da análise, e a partir daí NENHUMA das esperas seguintes observava a
// mensagem de falha. Cada uma ia até o teto:
//
//   • painel da Bosstiary ......... waitForFunction  4.000–6.000 ms
//   • indicador "Page X of Y" ..... waitForFunction  2.500 ms
//   • campo de busca .............. waitForFunction  4.000 ms
//   • leitura da tabela ........... waitForSelector  250–3.000 ms (×2 páginas)
//   • busca "gosh" ................ 1 × campo + confirmação
//   • buscas Sanguine ............. 5 × (campo + confirmação + gap)
//
// No pior caso — falha logo após abrir a Bosstiary, com o filtro pedindo
// Sanguine — somavam-se ~4s (painel) + 2,5s (paginação) + 6 × ~4s (buscas) e o
// personagem só era descartado na validação final, passando de 30 segundos.
// Nada disso era necessário: o site já havia declarado a falha no primeiro
// instante.
//
// SOLUÇÃO
// ---------------------------------------------------------------------------
// 1. `detectRubinotLoadFailure(page)` — verificação única e barata (~1 ms),
//    reutilizada por todo o fluxo. Uma implementação só, um só conjunto de
//    padrões de texto.
// 2. `raceRubinotWaitAgainstFailure(...)` — faz a espera do elemento competir
//    com o polling da mensagem de falha DENTRO do mesmo laço do navegador:
//    elemento esperado OU falha OU timeout. Sem `Promise.race` de duas esperas
//    independentes (o ramo perdedor continuaria varrendo o DOM da página que
//    está prestes a ser abandonada — problema já documentado logo abaixo).
// 3. `RubinotLoadFailureError` — sinal de abandono propagado para cima, para
//    que a análise pare de clicar/pesquisar imediatamente.
//
// Nada aqui reduz timeouts globais: páginas apenas LENTAS continuam com os
// mesmos prazos. O que muda é que uma página já declarada como falha não
// consome mais nenhum deles.
// ============================================================================

/** Padrões de texto que caracterizam a falha declarada pelo próprio RubinOT. */
const RUBINOT_LOAD_FAILURE_PATTERNS = ['falha ao carregar', 'failed to load', 'erro ao carregar'];

/** Erro-sentinela: interrompe a análise do personagem sem confundir com bug. */
class RubinotLoadFailureError extends Error {
  constructor(stage) {
    super('RUBINOT_ERRO_APP');
    this.name = 'RubinotLoadFailureError';
    this.isRubinotLoadFailure = true;
    this.stage = stage || 'desconhecida';
  }
}

function isRubinotLoadFailureError(error) {
  return !!error && error.isRubinotLoadFailure === true;
}

/**
 * A página está exibindo "Falha ao carregar leilão" AGORA?
 *
 * Verificação por TEXTO (não por cadeia CSS, que quebraria a cada ajuste de
 * layout), sem acentos e sem caixa, cobrindo as variantes em inglês. Limita o
 * comprimento do nó para não casar com um parágrafo longo que apenas cite a
 * expressão.
 *
 * Custo típico ~1ms. Nunca lança por conta da página — só propaga o erro de
 * navegador fechado, que precisa subir.
 */
async function detectRubinotLoadFailure(page) {
  try {
    return await page.evaluate((patterns) => {
      const strip = (value) => String(value || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      for (const element of document.querySelectorAll('p, span, div, h1, h2, h3')) {
        const text = strip(element.textContent);
        if (text.length > 0 && text.length <= 120 && patterns.some(pattern => text.includes(pattern))) {
          return true;
        }
      }
      return false;
    }, RUBINOT_LOAD_FAILURE_PATTERNS);
  } catch (error) {
    if (isRubinotBrowserClosedError(error)) throw error;
    return false;
  }
}

/**
 * Ponto de checagem entre etapas: lança `RubinotLoadFailureError` se a página
 * já falhou. Usado logo após cada ação relevante do fluxo.
 */
async function assertRubinotPageNotFailed(page, id, stage) {
  if (await detectRubinotLoadFailure(page)) {
    rubinotDiag('details', 'Falha ao carregar leilão detectada; abandonando personagem.', { id, etapa: stage });
    throw new RubinotLoadFailureError(stage);
  }
}

/**
 * Espera um predicado do DOM competindo com a mensagem de falha.
 *
 *   predicado satisfeito  → { outcome: 'ready' }
 *   falha na tela         → { outcome: 'load-error' }   (encerra na hora)
 *   teto de segurança     → { outcome: 'timeout' }
 *
 * Os dois sinais são avaliados no MESMO laço de polling dentro do navegador, e
 * a falha é testada PRIMEIRO — por isso a desistência é imediata (~1 ciclo de
 * polling, 100ms) em vez de esperar o timeout inteiro.
 *
 * `predicateSource` é o CORPO de uma função JS, em texto, que devolve boolean.
 * Precisa ser string porque a função é serializada para o contexto da página.
 */
async function raceRubinotWaitAgainstFailure(page, predicateSource, timeoutMs) {
  try {
    const handle = await page.waitForFunction(({ source, patterns }) => {
      const strip = (value) => String(value || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

      // 1) FALHA PRIMEIRO: se o site já declarou o erro, é conclusivo. Avaliar
      //    nesta ordem é o que torna a desistência imediata.
      for (const element of document.querySelectorAll('p, span, div, h1, h2, h3')) {
        const text = strip(element.textContent);
        if (text.length > 0 && text.length <= 120 && patterns.some(pattern => text.includes(pattern))) {
          return 'load-error';
        }
      }

      // 2) O elemento/estado esperado.
      try {
        // eslint-disable-next-line no-new-func
        const predicate = new Function(source);
        return predicate() ? 'ready' : null;
      } catch (_) {
        return null;
      }
    }, { source: predicateSource, patterns: RUBINOT_LOAD_FAILURE_PATTERNS }, { timeout: timeoutMs, polling: RUBINOT_DOM_POLL_MS });

    const outcome = await handle.jsonValue().catch(() => 'timeout');
    return { outcome };
  } catch (error) {
    if (isRubinotBrowserClosedError(error)) throw error;
    return { outcome: 'timeout' };
  }
}

// ============================================================================
// FALHA TRANSITÓRIA — janela curta de recuperação (cenário B: falha → válido)
//
// Existe o caso inverso da race condition anterior: a página abre exibindo
// "Falha ao carregar leilão", mas a SPA ainda está montando e em menos de
// ~500ms o conteúdo válido aparece. Tratar essa falha como definitiva mandaria
// para o retry um personagem perfeitamente analisável.
//
// Esta janela existe SOMENTE quando a falha é detectada. Página que já abre
// bem nunca passa por aqui e não ganha atraso algum.
//
// Ela NÃO se contenta com "o texto de falha sumiu": exige EVIDÊNCIA POSITIVA
// de estado válido — a aba Bosstiary visível e utilizável, o mesmo sinal que o
// restante do fluxo usa. Sem isso, um DOM momentaneamente vazio seria lido
// como recuperação.
//
// Orientada a evento: se o estado válido aparecer em 80ms, retorna em 80ms.
// O teto é apenas o limite de segurança.
// ============================================================================

/** Teto da janela de confirmação. Só se aplica após detectar a falha. */
const RUBINOT_TRANSIENT_FAILURE_WINDOW_MS = 500;

/**
 * Observa, por no máximo `RUBINOT_TRANSIENT_FAILURE_WINDOW_MS`, se a página
 * sai do estado de falha e entra num estado VÁLIDO confiável.
 *
 * Retorna 'recovered' | 'failure-confirmed'.
 */
async function waitForRubinotTransientFailureOutcome(page, timeoutMs) {
  try {
    const handle = await page.waitForFunction((patterns) => {
      const strip = (value) => String(value || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

      // Evidência POSITIVA de recuperação: aba Bosstiary visível e utilizável.
      const isUsable = (element) => {
        if (!element) return false;
        if (element.disabled === true || element.getAttribute('aria-disabled') === 'true') return false;
        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      for (const element of document.querySelectorAll('button, a, [role="tab"]')) {
        if (strip(element.textContent).includes('bosstiary') && isUsable(element)) return 'recovered';
      }

      // Ainda em falha: segue observando até o teto.
      for (const element of document.querySelectorAll('p, span, div, h1, h2, h3')) {
        const text = strip(element.textContent);
        if (text.length > 0 && text.length <= 120 && patterns.some(pattern => text.includes(pattern))) {
          return null;
        }
      }

      // Sem falha e sem sinal válido: inconclusivo, continua até o teto.
      return null;
    }, RUBINOT_LOAD_FAILURE_PATTERNS, { timeout: timeoutMs, polling: RUBINOT_DOM_POLL_MS });

    const value = await handle.jsonValue().catch(() => null);
    return value === 'recovered' ? 'recovered' : 'failure-confirmed';
  } catch (_) {
    // Teto atingido sem recuperação: a falha é real.
    return 'failure-confirmed';
  }
}

async function waitForRubinotAuctionOutcome(page, timeoutMs) {
  try {
    const result = await page.waitForFunction(() => {
      const strip = (value) => String(value || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

      // 1) FALHA primeiro: se o site já declarou o erro, é conclusivo e não há
      //    razão para procurar a aba. Avaliar nesta ordem faz a desistência
      //    ser imediata.
      const patterns = ['falha ao carregar', 'failed to load', 'erro ao carregar'];
      for (const element of document.querySelectorAll('p, span, div, h1, h2, h3')) {
        const text = strip(element.textContent);
        if (text.length > 0 && text.length <= 120 && patterns.some(pattern => text.includes(pattern))) {
          return 'load-error';
        }
      }

      // 2) Aba Bosstiary visível E utilizável.
      const isUsable = (element) => {
        if (!element) return false;
        if (element.disabled === true || element.getAttribute('aria-disabled') === 'true') return false;
        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      for (const element of document.querySelectorAll('button, a, [role="tab"]')) {
        if (strip(element.textContent).includes('bosstiary') && isUsable(element)) return 'bosstiary';
      }

      // Nenhum dos dois ainda: continua o polling.
      return null;
    }, { timeout: timeoutMs, polling: RUBINOT_DOM_POLL_MS });

    return await result.jsonValue().catch(() => 'timeout');
  } catch (_) {
    return 'timeout';
  }
}

async function isRubinotAuctionPageAlive(page) {
  try {
    return await page.evaluate(() => {
      const strip = (value) => String(value || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      const bodyText = String(document.body?.innerText || '');
      const lower = strip(bodyText);

      // Sinais NEGATIVOS: nada disso merece prorrogação.
      const hasErrorText = ['falha ao carregar', 'failed to load', 'erro ao carregar']
        .some(pattern => lower.includes(pattern));
      const hasCloudflare = ['just a moment', 'checking your browser', 'verificacao de seguranca', 'sou humano']
        .some(pattern => lower.includes(pattern)) ||
        !!document.querySelector('iframe[src*="turnstile"], input[name="cf-turnstile-response"]');
      if (hasErrorText || hasCloudflare || bodyText.trim().length < 50) {
        return { alive: false, hasErrorText, hasCloudflare, bodyLength: bodyText.length };
      }

      // Sinais POSITIVOS de que é mesmo a página de um leilão em construção.
      const hasAuctionVocabulary = ['bosstiary', 'auction', 'leilao', 'bid', 'lance', 'vocation', 'vocacao', 'level', 'skills']
        .some(pattern => lower.includes(pattern));
      const hasInteractiveChrome = !!document.querySelector('button, [role="tab"], table, input');
      // A SPA ainda pode estar montando: spinner/esqueleto conta como vida.
      const hasLoadingIndicator = !!document.querySelector('[class*="animate-"], [class*="skeleton" i], [class*="spinner" i], [aria-busy="true"]') ||
        ['carregando', 'loading'].some(pattern => lower.includes(pattern));

      return {
        alive: hasAuctionVocabulary || hasInteractiveChrome || hasLoadingIndicator,
        hasErrorText: false,
        hasCloudflare: false,
        bodyLength: bodyText.length,
        hasAuctionVocabulary,
        hasInteractiveChrome,
        hasLoadingIndicator,
      };
    });
  } catch (error) {
    if (isRubinotBrowserClosedError(error)) throw error;
    // Na dúvida NÃO prorrogamos: prorrogar às cegas atrasaria as falhas reais.
    return { alive: false, error: String(error?.message || error).slice(0, 160) };
  }
}

async function diagnoseRubinotAuctionPage(page) {
  try {
    const info = await page.evaluate(() => {
      const bodyText = String(document.body?.innerText || '');
      const lower = bodyText.toLowerCase();
      const errorText = ['falha ao carregar', 'failed to load', 'erro ao carregar', 'nao foi possivel carregar']
        .find(pattern => lower.includes(pattern)) || '';
      const cloudflareText = ['just a moment', 'checking your browser', 'verificacao de seguranca', 'sou humano', 'cloudflare']
        .find(pattern => lower.includes(pattern) || String(document.title || '').toLowerCase().includes(pattern)) || '';
      return {
        title: String(document.title || '').slice(0, 120),
        readyState: document.readyState,
        bodyLength: bodyText.length,
        errorText,
        cloudflareText,
        hasTurnstile: !!document.querySelector('iframe[src*="turnstile"], input[name="cf-turnstile-response"]'),
        hasAnyTab: !!document.querySelector('button, [role="tab"]'),
        hasTable: !!document.querySelector('tbody tr td'),
        snippet: bodyText.replace(/\s+/g, ' ').trim().slice(0, 200),
      };
    });

    let reason = 'SPA_NAO_RENDERIZOU';
    if (info.hasTurnstile || info.cloudflareText) reason = 'CLOUDFLARE';
    else if (info.errorText) reason = 'RUBINOT_ERRO_APP';
    else if (info.bodyLength < 50) reason = 'PAGINA_VAZIA';
    else if (info.hasAnyTab) reason = 'PAGINA_OK_SEM_BOSSTIARY';

    return { reason, currentUrl: String(page.url() || '').slice(0, 200), ...info };
  } catch (error) {
    if (isRubinotBrowserClosedError(error)) throw error;
    return { reason: 'DIAGNOSTICO_FALHOU', error: String(error?.message || error).slice(0, 160) };
  }
}

/**
 * Classifica o desfecho de uma tentativa de página a partir da resposta crua.
 * Serve tanto para o log quanto para decidir se vale a pena tentar de novo.
 */
function classifyRubinotPageOutcome(res) {
  if (!res) return { kind: 'SEM_RESPOSTA', retryable: true };
  if (res.status === 429) return { kind: 'RATE_LIMIT_429', retryable: true };
  if (res.status === 403) return { kind: 'BLOQUEIO_403', retryable: true };
  if (res.status === 503) return { kind: 'INDISPONIVEL_503', retryable: true };
  if (res.status >= 500) return { kind: `ERRO_SERVIDOR_${res.status}`, retryable: true };
  if (res.status === 0) return { kind: 'ERRO_REDE', retryable: true };
  if (res.status >= 400) return { kind: `ERRO_HTTP_${res.status}`, retryable: false };
  if (res.ok && !res.isJson) {
    // 200 com HTML normalmente significa desafio/intersticial do Cloudflare.
    const preview = String(res.textPreview || '').toLowerCase();
    if (isLikelyCloudflarePage(preview, '')) return { kind: 'CLOUDFLARE_INTERSTICIAL', retryable: true };
    return { kind: 'RESPOSTA_NAO_JSON', retryable: true };
  }
  if (res.ok && res.isJson && !Array.isArray(res.data?.auctions)) {
    return { kind: 'JSON_SEM_AUCTIONS', retryable: true };
  }
  if (res.ok && res.isJson) return { kind: 'OK', retryable: false };
  return { kind: 'DESCONHECIDO', retryable: true };
}

/**
 * Busca UMA página da listagem com até `RUBINOT_PAGE_MAX_ATTEMPTS` tentativas.
 *
 * Retorna sempre um relatório — nunca lança por falha de página — para que o
 * chamador decida entre seguir adiante ou marcar a consulta como parcial.
 * O laço é estritamente limitado: não há possibilidade de loop infinito.
 */
async function fetchRubinotBazaarPageResilient(page, pageNum, runState = null) {
  const params = new URLSearchParams({ ...RUBINOT_BAZAAR_PARAMS, page: pageNum });
  const url = `${RUBINOT_BAZAAR_API}?${params.toString()}`;
  const attempts = [];

  for (let attempt = 1; attempt <= RUBINOT_PAGE_MAX_ATTEMPTS; attempt++) {
    throwIfRubinotRunCancelled(page, runState);
    const startedAt = Date.now();
    const res = await fetchRubinotJsonDetailed(page, url);
    const elapsedMs = Date.now() - startedAt;
    const outcome = classifyRubinotPageOutcome(res);

    attempts.push({
      attempt,
      status: res?.status ?? 0,
      elapsedMs,
      outcome: outcome.kind,
      contentType: res?.contentType || '',
      message: String(res?.error || res?.textPreview || '').slice(0, 160),
    });

    rubinotDiag('bazaar', 'Tentativa de leitura de página da listagem.', {
      pageNum,
      url,
      attempt,
      maxAttempts: RUBINOT_PAGE_MAX_ATTEMPTS,
      status: res?.status ?? 0,
      elapsedMs,
      outcome: outcome.kind,
      contentType: res?.contentType || '',
      pageMessage: String(res?.error || res?.textPreview || '').slice(0, 160),
    });

    if (outcome.kind === 'OK') {
      return { ok: true, pageNum, url, data: res.data, attempts, attemptsUsed: attempt, outcome: 'OK' };
    }

    // Erro definitivo (ex.: 404) não melhora com retentativa.
    if (!outcome.retryable) break;

    if (attempt < RUBINOT_PAGE_MAX_ATTEMPTS) {
      // Backoff progressivo. Se o servidor mandou Retry-After, ele tem prioridade.
      const retryAfterSec = Number(res?.retryAfter || 0);
      const backoff = retryAfterSec > 0
        ? Math.min(retryAfterSec * 1000, 15000)
        : RUBINOT_PAGE_BACKOFF_MS * attempt;
      rubinotDiag('bazaar', 'Aguardando antes de nova tentativa da mesma página.', { pageNum, attempt, backoffMs: backoff, reason: outcome.kind });
      await sleep(backoff);
    }
  }

  const last = attempts[attempts.length - 1] || {};
  return {
    ok: false,
    pageNum,
    url,
    data: null,
    attempts,
    attemptsUsed: attempts.length,
    outcome: last.outcome || 'SEM_RESPOSTA',
    status: last.status || 0,
    message: last.message || '',
  };
}

async function ensureRubinotNavigationStarted(page) {
  const currentUrl = page.url();
  if (currentUrl === 'about:blank' || currentUrl === 'chrome://new-tab-page/' || !isRubinotPageUrl(currentUrl)) {
    await page.goto(RUBINOT_BAZAAR_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  }
}

const RUBINOT_SOUL_WAR_BOSSES = [
  "goshnar's cruelty",
  "goshnar's malice",
  "goshnar's greed",
  "goshnar's spite",
  "goshnar's hatred",
  "goshnar's megalomania",
];
const RUBINOT_SANGUINE_BOSSES = [
  'murcion',
  'vemiath',
  'ichgahal',
  'chagorz',
  'bakragore',
];
const RUBINOT_SOUL_WAR_FINAL_BOSS = "goshnar's megalomania";
const RUBINOT_SANGUINE_FINAL_BOSS = 'bakragore';

function normalizeRubinotBossName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’`´]/g, "'")
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

async function readRubinotBosstiaryBossesFromCurrentPage(page, timeoutMs = 250) {
  try {
    // A espera pelas linhas compete com a falha. Chamada até 2× por personagem
    // com 3.000ms cada na leitura direta de duas páginas.
    const rowsRace = await raceRubinotWaitAgainstFailure(page, `
      return !!document.querySelector('tbody tr td:nth-child(3)');
    `, timeoutMs);
    if (rowsRace.outcome === 'load-error') throw new RubinotLoadFailureError('leitura-tabela-bosstiary');
    return await page.evaluate(() => {
      function normalize(value) {
        return String(value || '')
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[’`´]/g, "'")
          .replace(/[_-]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase();
      }

      const bosses = [];
      for (const row of Array.from(document.querySelectorAll('tbody tr'))) {
        const cells = Array.from(row.querySelectorAll('td'));
        if (cells.length < 3) continue;
        const bossName = normalize(cells[2]?.innerText || cells[2]?.textContent || '');
        if (bossName && bossName.length >= 3 && bossName.length <= 120) bosses.push(bossName);
      }
      return bosses;
    });
  } catch (error) {
    if (isRubinotBrowserClosedError(error)) throw error;
    if (isRubinotLoadFailureError(error)) throw error;
    return [];
  }
}

function getRubinotBosstiarySearchInput(page) {
  return page.locator([
    'input[placeholder="Buscar boss..."]',
    'input[placeholder*="Buscar boss" i]',
    'input[placeholder*="boss" i][type="text"]',
  ].join(',')).first();
}

async function getRubinotBosstiaryPageCount(page, id = '') {
  try {
    const readPageIndicator = async () => page.evaluate(() => {
      function isVisible(element) {
        if (!(element instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity || '1') > 0 &&
          rect.width > 0 &&
          rect.height > 0;
      }

      const table = document.querySelector('tbody tr td:nth-child(3)')?.closest('table');
      const tableRect = table?.getBoundingClientRect();
      const candidates = Array.from(document.querySelectorAll('span, div, p'))
        .filter(isVisible)
        .map((element) => {
          const text = String(element.textContent || '').trim();
          const rect = element.getBoundingClientRect();
          let score = 0;
          if (/^Page\s+\d+\s+of\s+\d+$/i.test(text)) score += 1000;
          if (tableRect) {
            const belowTable = rect.top >= tableRect.bottom - 80 && rect.top <= tableRect.bottom + 180;
            const horizontallyNear = rect.left >= tableRect.left - 80 && rect.right <= tableRect.right + 80;
            if (belowTable) score += 500;
            if (horizontallyNear) score += 200;
          }
          return { text, score };
        })
        .filter(candidate => /^Page\s+\d+\s+of\s+\d+$/i.test(candidate.text))
        .sort((a, b) => b.score - a.score);

      const selected = candidates[0];
      if (!selected) return null;
      const match = selected.text.match(/^Page\s+(\d+)\s+of\s+(\d+)$/i);
      if (!match) return null;
      return {
        currentPage: Number(match[1]),
        totalPages: Number(match[2]),
        sourceText: selected.text,
      };
    });

    let pageInfo = await readPageIndicator();

    if (!pageInfo) {
      const hasPaginationControls = await page.evaluate(() => {
        function isVisible(element) {
          if (!(element instanceof HTMLElement)) return false;
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            Number(style.opacity || '1') > 0 &&
            rect.width > 0 &&
            rect.height > 0;
        }
        function isRightChevronButton(button) {
          const svg = button.querySelector('svg');
          const path = button.querySelector('path');
          const svgClass = String(svg?.getAttribute('class') || '');
          const pathD = String(path?.getAttribute('d') || '');
          return svgClass.includes('chevron-right') || pathD.includes('6-6-6-6') || pathD.includes('6-6-6');
        }
        const table = document.querySelector('tbody tr td:nth-child(3)')?.closest('table');
        const tableRect = table?.getBoundingClientRect();
        return Array.from(document.querySelectorAll('button')).some(button => {
          if (!isVisible(button) || !isRightChevronButton(button)) return false;
          if (!tableRect) return false;
          const rect = button.getBoundingClientRect();
          const nearTable = rect.top >= tableRect.top - 20 && rect.top <= tableRect.bottom + 240;
          const horizontallyNear = rect.left >= tableRect.left - 100 && rect.right <= tableRect.right + 100;
          return nearTable && horizontallyNear;
        });
      });

      // Comportamento real do Rubinot: quando há somente 1 página, a paginação
      // não é exibida. Assim, ausência de indicador e ausência de botões = 1 página.
      if (!hasPaginationControls) {
        rubinotDiag('details', 'Bosstiary sem indicador Page X of Y e sem botões de paginação; tratando como página única.', { id });
        return 1;
      }

      // A espera pelo indicador compete com a falha: 2,5s viravam tempo morto
      // quando a página já havia degradado.
      const indicatorRace = await raceRubinotWaitAgainstFailure(page, `
        return Array.from(document.querySelectorAll('span, div, p'))
          .some(element => {
            const style = window.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== 'none' &&
              style.visibility !== 'hidden' &&
              rect.width > 0 &&
              rect.height > 0 &&
              /^Page\\s+\\d+\\s+of\\s+\\d+$/i.test(String(element.textContent || '').trim());
          });
      `, 2500);
      if (indicatorRace.outcome === 'load-error') throw new RubinotLoadFailureError('aguardando-paginacao-bosstiary');
      pageInfo = await readPageIndicator();
    }

    if (!pageInfo) {
      rubinotDiag('details', 'Bosstiary possui paginação, mas indicador Page X of Y não foi lido; usando busca por segurança.', { id });
      return 3;
    }

    const totalPages = Number(pageInfo.totalPages || 1);
    const safeTotalPages = Number.isFinite(totalPages) && totalPages > 0 ? totalPages : 1;
    rubinotDiag('details', 'Paginação da Bosstiary detectada pelo indicador Page X of Y.', {
      id,
      currentPage: pageInfo.currentPage || 1,
      totalPages: safeTotalPages,
      sourceText: pageInfo.sourceText || '',
    });
    return safeTotalPages;
  } catch (error) {
    if (isRubinotBrowserClosedError(error)) throw error;
    rubinotDiag('details', 'Falha ao detectar paginação da Bosstiary; assumindo página única por segurança.', { id, error: String(error?.message || error) });
    return 1;
  }
}

async function resetRubinotBosstiarySearchBeforeDecision(page, id, sentinel = null) {
  try {
    const input = getRubinotBosstiarySearchInput(page);
    const visible = await runWithFailureSentinel(sentinel, 'limpar-busca-visivel',
      () => input.isVisible({ timeout: 700 }).catch(() => false));
    if (visible) {
      await runWithFailureSentinel(sentinel, 'limpar-busca',
        () => fillWithoutFocus(page, input, '', 1000));
      await page.waitForTimeout(speed().bosstiarySearchGapMs);
    }
  } catch (error) {
    if (isRubinotBrowserClosedError(error)) throw error;
    rubinotDiag('details', 'Falha tolerada ao limpar busca antes da decisão da Bosstiary.', { id, error: String(error?.message || error) });
  }
}


async function getRubinotBosstiaryTableSnapshot(page) {
  try {
    return await page.evaluate(() => Array.from(document.querySelectorAll('tbody tr'))
      .map(row => Array.from(row.querySelectorAll('td'))[2]?.textContent?.trim() || '')
      .join('|'));
  } catch (error) {
    if (isRubinotBrowserClosedError(error)) throw error;
    return '';
  }
}

async function clickRubinotBosstiaryNextPageForTwoPages(page, id) {
  try {
    const candidates = await page.evaluate(() => {
      function isVisible(element) {
        if (!(element instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      }
      function isDisabled(button) {
        return !!button.disabled || button.getAttribute('aria-disabled') === 'true' || button.matches(':disabled');
      }
      const table = document.querySelector('tbody tr td:nth-child(3)')?.closest('table');
      const tableRect = table?.getBoundingClientRect();
      return Array.from(document.querySelectorAll('button'))
        .map((button, buttonIndex) => {
          const svg = button.querySelector('svg');
          const path = button.querySelector('path');
          const svgClass = String(svg?.getAttribute('class') || '');
          const pathD = String(path?.getAttribute('d') || '');
          const rightChevron = svgClass.includes('chevron-right') || pathD.includes('6-6-6-6') || pathD.includes('6-6-6');
          const rect = button.getBoundingClientRect();
          let score = rect.left / 100;
          if (tableRect) {
            if (rect.top >= tableRect.bottom - 120) score += 500;
            if (rect.left >= tableRect.left + tableRect.width * 0.45) score += 250;
          }
          return { buttonIndex, rightChevron, visible: isVisible(button), disabled: isDisabled(button), center: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }, score };
        })
        .filter(candidate => candidate.rightChevron && candidate.visible && !candidate.disabled)
        .sort((a, b) => b.score - a.score);
    });

    if (!candidates.length) {
      rubinotDiag('details', 'Botão próximo da Bosstiary não encontrado para leitura de 2 páginas.', { id });
      return false;
    }

    for (const candidate of candidates.slice(0, 3)) {
      const before = await getRubinotBosstiaryTableSnapshot(page);

      // Clique PROGRAMÁTICO pelo índice do botão, sem coordenadas de mouse.
      //
      // Antes usávamos `page.mouse.click(x, y)`, que injeta um evento de mouse
      // real na viewport. Esse caminho depende da janela estar visível/ativa —
      // no Firefox, com a janela em segundo plano, o clique não chegava ao
      // elemento e a paginação travava. `element.click()` no DOM não depende
      // de foco, de posição na tela nem de a janela estar em primeiro plano.
      const clicked = await page.evaluate((buttonIndex) => {
        const button = Array.from(document.querySelectorAll('button'))[buttonIndex];
        if (!button) return false;
        button.click();
        return true;
      }, candidate.buttonIndex).catch(() => false);

      if (!clicked) continue;

      await page.waitForTimeout(speed().bosstiaryPageGapMs);
      const after = await getRubinotBosstiaryTableSnapshot(page);
      if (after && after !== before) {
        rubinotDiag('details', 'Bosstiary avançou para a segunda página.', { id, buttonIndex: candidate.buttonIndex });
        return true;
      }
    }
    rubinotDiag('details', 'Clique no próximo da Bosstiary não alterou a tabela.', { id });
    return false;
  } catch (error) {
    if (isRubinotBrowserClosedError(error)) throw error;
    rubinotDiag('details', 'Falha ao avançar para segunda página da Bosstiary.', { id, error: String(error?.message || error) });
    return false;
  }
}

async function searchRubinotBosstiaryBosses(page, id, query, sentinel = null) {
  const searchInput = getRubinotBosstiarySearchInput(page);
  const startedAt = Date.now();

  try {
    // Polling por temporizador: `searchInput.waitFor` depende de rAF e ficava
    // suspenso no WebKit com a janela em segundo plano (ver RUBINOT_DOM_POLL_MS).
    const searchRace = await raceRubinotWaitAgainstFailure(page, `
      const input = Array.from(document.querySelectorAll('input'))
        .find(candidate => String(candidate.getAttribute('placeholder') || '').toLowerCase().includes('boss'));
      if (!input) return false;
      const rect = input.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    `, 4000);
    // ETAPA 5/7 — antes de pesquisar "Gosh" e cada boss da Sanguine. Sem esta
    // corrida, uma falha aqui custava 4s POR BUSCA (1 + 5 = 6 buscas).
    if (searchRace.outcome === 'load-error') throw new RubinotLoadFailureError('aguardando-campo-busca-bosstiary');
    if (searchRace.outcome !== 'ready') {
      rubinotDiag('details', 'Campo de busca da Bosstiary não ficou disponível.', { id, query });
      return [];
    }
    // Estas TRÊS ações eram o pior ofensor: se a página degradou, o campo
    // some e o Playwright re-tenta até o timeout (1.500ms cada, ×6 buscas).
    await runWithFailureSentinel(sentinel, `busca-scroll:${query}`,
      () => searchInput.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {}));
    await runWithFailureSentinel(sentinel, `busca-limpar:${query}`,
      () => fillWithoutFocus(page, searchInput, '', 1500));
    await runWithFailureSentinel(sentinel, `busca-digitar:${query}`,
      () => fillWithoutFocus(page, searchInput, query, 1500));
    await page.waitForFunction((expected) => {
      const input = Array.from(document.querySelectorAll('input'))
        .find(candidate => String(candidate.getAttribute('placeholder') || '').toLowerCase().includes('boss'));
      return input && String(input.value || '').toLowerCase() === String(expected || '').toLowerCase();
    }, query, { timeout: 500, polling: RUBINOT_DOM_POLL_MS }).catch(() => {});
    // Espaça as buscas: a Sanguine dispara 5 seguidas por personagem, e cada
    // uma é uma consulta na SPA. 80ms encadeava requisições demais.
    await page.waitForTimeout(speed().bosstiarySearchGapMs);
  } catch (error) {
    if (isRubinotBrowserClosedError(error)) throw error;
    if (isRubinotLoadFailureError(error)) throw error;   // abandono deve subir
    rubinotDiag('details', 'Falha ao pesquisar boss na Bosstiary.', { id, query, error: String(error?.message || error) });
    return [];
  }

  const bosses = await readRubinotBosstiaryBossesFromCurrentPage(page);
  rubinotDiag('details', 'Pesquisa na Bosstiary concluída.', { id, query, elapsedMs: Date.now() - startedAt, resultCount: bosses.length, bosses });
  return bosses;
}

function findRubinotBossesInSearchResult(targetBosses, resultBosses) {
  const resultSet = new Set(resultBosses.map(normalizeRubinotBossName));
  return targetBosses.filter(boss => resultSet.has(normalizeRubinotBossName(boss)));
}

async function collectRubinotBosstiaryBosses(page, id, quests = { soulwar: true, sanguine: true }, sentinel = null) {
  // Nenhuma quest exigida: não há o que apurar. Evita paginar/pesquisar à toa.
  if (!quests.soulwar && !quests.sanguine) {
    rubinotDiag('details', 'Nenhuma quest exigida pelos filtros; Bosstiary não percorrida.', { id });
    return { bosses: [], strategy: 'skipped-no-quest-required', pageCount: 0, searchSummaries: [] };
  }

  await resetRubinotBosstiarySearchBeforeDecision(page, id, sentinel);

  // ETAPA 4 — antes de interpretar a Bosstiary. "Bosstiary vazia" só é um
  // resultado VÁLIDO numa página íntegra; numa página falha seria um falso
  // positivo (as duas quests apareceriam como disponíveis).
  await assertRubinotPageNotFailed(page, id, 'antes-de-interpretar-bosstiary');

  // "Nenhum progresso de bosstiary." => o personagem nunca matou boss algum.
  // É um resultado CONCLUSIVO: não há o que paginar nem pesquisar, e as duas
  // quests estão disponíveis. A checagem vem depois de limpar a busca, para
  // não confundir com "Nenhum boss encontrado com ..." de uma pesquisa ativa.
  if (await detectRubinotBosstiaryNoProgress(page)) {
    rubinotDiag('details', 'Bosstiary sem nenhum progresso; Soul War e Sanguine disponíveis.', { id });
    return { bosses: [], strategy: 'empty-no-progress', pageCount: 0, searchSummaries: [], noProgress: true };
  }

  const pageCount = await getRubinotBosstiaryPageCount(page, id);
  rubinotDiag('details', 'Estratégia da Bosstiary decidida individualmente para o personagem.', { id, pageCount, strategy: pageCount === 1 ? 'direct' : pageCount === 2 ? 'direct-two-pages' : 'search' });

  if (pageCount === 1) {
    const directBosses = await readRubinotBosstiaryBossesFromCurrentPage(page, 3000);
    const directBossSet = new Set(directBosses.map(normalizeRubinotBossName));
    rubinotDiag('details', 'Bosstiary possui uma única página; usando leitura direta da tabela.', { id, pageCount, bosses: directBossSet.size });
    return {
      bosses: Array.from(directBossSet),
      strategy: 'direct-table-1-page',
      pageCount,
      searchSummaries: [],
    };
  }

  if (pageCount === 2) {
    const directBossSet = new Set();
    const firstPageBosses = await readRubinotBosstiaryBossesFromCurrentPage(page, 3000);
    firstPageBosses.forEach(boss => directBossSet.add(normalizeRubinotBossName(boss)));

    const advanced = await clickRubinotBosstiaryNextPageForTwoPages(page, id);
    if (!advanced) {
      rubinotDiag('details', 'Não foi possível abrir a segunda página da Bosstiary; usando busca como fallback seguro.', { id, pageCount });
      return collectRubinotBosstiaryBossesBySearch(page, id, pageCount, quests, sentinel);
    }

    const secondPageBosses = await readRubinotBosstiaryBossesFromCurrentPage(page, 3000);
    secondPageBosses.forEach(boss => directBossSet.add(normalizeRubinotBossName(boss)));
    rubinotDiag('details', 'Bosstiary possui duas páginas; leitura direta das duas páginas concluída.', { id, pageCount, firstPageBosses: firstPageBosses.length, secondPageBosses: secondPageBosses.length, bosses: directBossSet.size });
    return {
      bosses: Array.from(directBossSet),
      strategy: 'direct-table-2-pages',
      pageCount,
      searchSummaries: [],
    };
  }

  return collectRubinotBosstiaryBossesBySearch(page, id, pageCount, quests, sentinel);
}

async function collectRubinotBosstiaryBossesBySearch(page, id, pageCount = 0, quests = { soulwar: true, sanguine: true }, sentinel = null) {
  const foundBosses = new Set();
  const searchSummaries = [];
  rubinotDiag('details', 'Bosstiary possui múltiplas páginas; usando pesquisa interna.', {
    id, pageCount, verificando: { soulwar: !!quests.soulwar, sanguine: !!quests.sanguine },
  });

  // Uma única busca por "gosh" cobre os 6 bosses de Soul War.
  if (quests.soulwar) {
    const soulWarSearchResults = await searchRubinotBosstiaryBosses(page, id, 'gosh', sentinel);
    // ETAPA 6 — após pesquisar "Gosh", antes de interpretar o resultado.
    // Resultado lido de uma página que falhou não pode virar conclusão:
    // "nenhum boss encontrado" seria confundido com quest disponível.
    await assertRubinotPageNotFailed(page, id, 'apos-pesquisa-gosh');
    const soulWarFoundBosses = findRubinotBossesInSearchResult(RUBINOT_SOUL_WAR_BOSSES, soulWarSearchResults);
    soulWarFoundBosses.forEach(boss => foundBosses.add(normalizeRubinotBossName(boss)));
    searchSummaries.push({ query: 'gosh', results: soulWarSearchResults.length, matchedBosses: soulWarFoundBosses });
  }

  // Sanguine exige uma busca por boss (5 no total). Pular quando o filtro está
  // em "Todas" economiza 5 buscas por personagem.
  if (quests.sanguine) {
    for (const boss of RUBINOT_SANGUINE_BOSSES) {
      // ETAPA 7 — checagem barata (~1ms) antes de CADA busca da Sanguine.
      // Sem ela, uma falha no meio do loop custaria até 5 buscas inúteis.
      await assertRubinotPageNotFailed(page, id, `pesquisa-sanguine:${boss}`);
      const results = await searchRubinotBosstiaryBosses(page, id, boss, sentinel);
      const found = findRubinotBossesInSearchResult([boss], results);
      found.forEach(foundBoss => foundBosses.add(normalizeRubinotBossName(foundBoss)));
      searchSummaries.push({ query: boss, results: results.length, matchedBosses: found });
    }
  }

  try {
    const searchInput = getRubinotBosstiarySearchInput(page);
    await fillWithoutFocus(page, searchInput, '', 1500);
  } catch (_) {}

  return { bosses: Array.from(foundBosses), strategy: 'search', pageCount, searchSummaries };
}

function getCachedRubinotDetails(id) {
  const cached = rubinotDetailsCache.get(id);
  if (!cached) return null;
  if (cached.method !== RUBINOT_DETAILS_METHOD) {
    rubinotDetailsCache.delete(id);
    return null;
  }
  const hasUnavailableInfo = cached.soulwarCompleted === null || cached.sanguineCompleted === null;
  const ttl = cached.error || hasUnavailableInfo ? RUBINOT_DETAILS_ERROR_TTL_MS : RUBINOT_DETAILS_TTL_MS;
  if (Date.now() - cached.fetchedAt > ttl) {
    rubinotDetailsCache.delete(id);
    return null;
  }
  return cached;
}

function cacheRubinotDetails(id, result) {
  rubinotDetailsCache.set(id, result);
  return result;
}

async function fetchRubinotCharacterDetails(page, auction, options = {}, runState = null) {
  const id = auction?.id || auction?.name || auction?.url;
  const quests = resolveRubinotQuestScope(options);
  if (options.forceRefresh) {
    rubinotDetailsCache.delete(id);
  } else {
    const cached = getCachedRubinotDetails(id);
    // O cache só serve se cobrir as quests exigidas AGORA. Um resultado obtido
    // quando a Sanguine estava em "Todas" traz `sanguineCompleted: null` e não
    // pode ser reaproveitado numa consulta que exige a Sanguine.
    if (cached) {
      const covers =
        (!quests.soulwar || cached.soulwarCompleted !== null || !!cached.error) &&
        (!quests.sanguine || cached.sanguineCompleted !== null || !!cached.error);
      if (covers) return cached;
      rubinotDetailsCache.delete(id);
    }
  }
  if (rubinotDetailsInFlight.has(id)) return rubinotDetailsInFlight.get(id);

  const request = fetchRubinotCharacterDetailsUncached(page, auction, runState, quests)
    .finally(() => rubinotDetailsInFlight.delete(id));
  rubinotDetailsInFlight.set(id, request);
  return request;
}

async function fetchRubinotCharacterDetailsUncached(page, auction, runState = null, quests = { soulwar: true, sanguine: true }) {
  const id = auction?.id || auction?.name || auction?.url;
  const url = normalizeRubinotAuctionUrl(auction);
  if (!url) {
    return cacheRubinotDetails(id, { id, method: RUBINOT_DETAILS_METHOD, soulwarCompleted: null, sanguineCompleted: null, fetchedAt: Date.now(), error: 'URL do personagem ausente ou inválida.' });
  }

  // Observador de falha vivo durante TODA a análise deste personagem. É
  // encerrado no `finally` — sucesso, falha, timeout ou "Concluir agora".
  const sentinel = createRubinotFailureSentinel(page, id);

  try {
    const context = page.context();
    let navigationReady = false;

    for (let attempt = 1; attempt <= 3 && !navigationReady; attempt++) {
      throwIfRubinotRunCancelled(page, runState);
      // Sem `bringToFront()` aqui: trazer a janela ao topo a cada personagem
      // roubava o foco do usuário durante toda a consulta. A navegação e a
      // leitura do DOM não dependem de a janela estar em primeiro plano.
      rubinotDiag('details', 'Abrindo página individual do personagem.', { id, url, attempt });
      // `domcontentloaded` e nada mais: quem decide o estado da página é a
      // corrida (Bosstiary vs. erro vs. timeout) executada logo abaixo.
      // Esperar `load` ou `networkidle` aqui era tempo morto — a SPA mantém
      // conexões abertas e raramente fica ociosa.
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: speed().navTimeoutMs });
      throwIfRubinotRunCancelled(page, runState);
      throwIfRubinotRunCancelled(page, runState);

      const challenge = await inspectRubinotChallengeOnPage(page);
      if (challenge.hasChallenge) {
        rubinotDiag('details', 'Cloudflare reapareceu durante a página individual. Pausando e aguardando validação.', { id, url, attempt, currentUrl: challenge.currentUrl });
        const cleared = await waitForRubinotChallengeToClear(page, context, runState, 'details-challenge', url);
        if (!cleared.ok) {
          return cacheRubinotDetails(id, { id, method: RUBINOT_DETAILS_METHOD, soulwarCompleted: null, sanguineCompleted: null, fetchedAt: Date.now(), error: cleared.error || 'Cloudflare não liberou a página individual.' });
        }
        const session = await ensureRubinotSessionReady(context, runState, 'details-session-recheck');
        if (!session.ok) {
          return cacheRubinotDetails(id, { id, method: RUBINOT_DETAILS_METHOD, soulwarCompleted: null, sanguineCompleted: null, fetchedAt: Date.now(), error: session.message || 'Sessão Rubinot não foi revalidada após Cloudflare individual.' });
        }
        rubinotDiag('details', 'Sessão revalidada após Cloudflare individual. Retomando o mesmo personagem.', { id, url, attempt });
        continue;
      }

      navigationReady = true;
    }

    if (!navigationReady) {
      return cacheRubinotDetails(id, { id, method: RUBINOT_DETAILS_METHOD, soulwarCompleted: null, sanguineCompleted: null, fetchedAt: Date.now(), error: 'Não foi possível abrir a página individual após revalidações do Cloudflare.' });
    }

    // ==========================================================================
    // BOTÃO "BOSSTIARY" — passagem ÚNICA, sem recarregar
    // --------------------------------------------------------------------------
    // Os testes reais mostraram que recarregar a página após "Falha ao carregar
    // leilão" NUNCA resolveu: a falha se repetia em todas as recargas. O reload
    // só somava segundos à consulta.
    //
    // Agora: uma única passagem. A decisão sai de uma corrida entre
    //   • o botão Bosstiary aparecer  -> sucesso;
    //   • o texto de erro aparecer    -> falha;
    //   • o timeout curto estourar    -> falha.
    //
    // Ao detectar a falha, aguardamos apenas um breve período de confirmação
    // (para não descartar uma página que ainda estava montando) e seguimos
    // imediatamente para o próximo personagem. O personagem entra na lista de
    // retry final, que é feito com OUTRO NAVEGADOR — a estratégia que de fato
    // recupera esses casos.
    // ==========================================================================
    let bosstiaryReady = false;
    // Motivo da falha, para que o erro final seja específico em vez de genérico.
    let lastPageDiagnosis = null;

    try {
      const bosstiaryTab = page.locator("button:has-text('Bosstiary'), a:has-text('Bosstiary'), [role='tab']:has-text('Bosstiary')").first();
      const startedAt = Date.now();

      // Atalho: o erro já está no DOM? Então nem entra na corrida.
      // `explicitFailure` distingue "o site DISSE que falhou" (conclusivo) de
      // "a Bosstiary não apareceu a tempo" (pode ser só lentidão).
      // Atalho: o erro já está no DOM? Uma única leitura, sem espera alguma.
      let failedNow = await hasRubinotAuctionLoadErrorNow(page);
      let explicitFailure = failedNow;
      // Página inspecionada e comprovadamente morta (vazia/erro/Cloudflare).
      // Tão conclusivo quanto o texto de erro — não merece confirmação.
      let deadPage = false;
      // Motivo já apurado por `isRubinotAuctionPageAlive`, reaproveitado para
      // não repetir a leitura do DOM na saída.
      let deadPageDiagnosis = null;

      if (!failedNow) {
        // Corrida ATÔMICA: um único laço de polling avalia os dois sinais e
        // devolve o que ocorreu primeiro. Não há ramo perdedor pendente —
        // ver waitForRubinotAuctionOutcome(). O erro é avaliado ANTES da aba,
        // então uma falha explícita encerra a espera no primeiro ciclo.
        //
        // Polling por TEMPORIZADOR: `locator.waitFor` depende de
        // requestAnimationFrame, suspenso pelo WebKit em segundo plano.
        const runRace = (timeoutMs) => waitForRubinotAuctionOutcome(page, timeoutMs);

        let outcome = await runRace(speed().bosstiaryWaitMs);

        // ── TETO ATINGIDO: PÁGINA INUTILIZÁVEL ────────────────────────────
        // Passado 1 segundo sem a aba Bosstiary e sem texto de erro, a página
        // é considerada inutilizável. NÃO há prorrogação nem nova espera: uma
        // única leitura do DOM classifica o motivo (para o log e para o retry)
        // e o script segue adiante.
        //
        // `deadPage = true` marca a falha como CONCLUSIVA, o que pula a fase
        // de confirmação mais adiante — é o que mantém o teto em 1 segundo.
        if (outcome === 'timeout') {
          const liveness = await isRubinotAuctionPageAlive(page);
          deadPage = true;
          deadPageDiagnosis = {
            reason: liveness.hasErrorText ? 'RUBINOT_ERRO_APP'
              : liveness.hasCloudflare ? 'CLOUDFLARE'
                : liveness.alive ? 'SPA_NAO_RENDERIZOU'
                  : 'PAGINA_VAZIA',
            currentUrl: String(page.url() || '').slice(0, 200),
          };
          rubinotDiag('details', 'Página não ficou utilizável dentro do teto; descartando.', {
            id, aguardadoMs: Date.now() - startedAt, tetoMs: speed().bosstiaryWaitMs, modo: rubinotSpeedMode,
            viva: liveness.alive, erro: liveness.hasErrorText, cloudflare: liveness.hasCloudflare,
            motivo: deadPageDiagnosis.reason,
          });
        }

        if (outcome === 'load-error') {
          // CENÁRIO B — a falha pode ser transitória. Confirmação curta e
          // orientada a evento, aplicada SÓ aqui (nunca no caminho normal).
          const failureSeenAt = Date.now();
          rubinotDiag('details', '[Bazaar] Falha detectada inicialmente.', {
            id, aposMs: failureSeenAt - startedAt,
          });
          const verdict = await waitForRubinotTransientFailureOutcome(page, RUBINOT_TRANSIENT_FAILURE_WINDOW_MS);
          if (verdict === 'recovered') {
            // A página se recuperou: NÃO é falha e não vai para o retry.
            outcome = 'bosstiary';
            rubinotDiag('details', '[Bazaar] Falha transitória recuperada.', {
              id, emMs: Date.now() - failureSeenAt,
            });
          } else {
            explicitFailure = true;
            rubinotDiag('details', '[Bazaar] Falha confirmada.', {
              id, aposMs: Date.now() - failureSeenAt,
            });
          }
        }

        if (outcome === 'bosstiary') {
          // A página pareceu VÁLIDA aqui. Isso NÃO é definitivo: o sentinela
          // segue observando até a validação final.
          sentinel.markValid();
          rubinotDiag('details', '[Bazaar] Página inicialmente válida.', {
            id, aposMs: Date.now() - startedAt,
          });
        }

        if (outcome === 'bosstiary') {
          // O clique também compete com o sentinela: se a página degradou
          // entre "aba encontrada" e "clique", a aba já não existe e o
          // Playwright re-tentaria por 3,5s.
          sentinel.markValid();
          await runWithFailureSentinel(sentinel, 'clique-bosstiary',
            () => clickWithoutFocus(page, bosstiaryTab));
          // O PAINEL precisa montar antes da leitura. Se este wait estourar, a
          // Bosstiary seria lida de um painel inexistente e o personagem
          // acabaria descartado por `validateRubinotAuctionPageAfterAnalysis`
          // mesmo com a página boa — outra fonte de personagens pulados.
          // ETAPA 3 — logo após clicar em Bosstiary.
          // A espera pelo painel compete com a mensagem de falha: se a página
          // degradou no clique, saímos em ~100ms em vez de esperar 4–6s.
          const panelRace = await raceRubinotWaitAgainstFailure(page, `
            const hasBossCell = !!document.querySelector('tbody tr td:nth-child(3)');
            const hasPageIndicator = Array.from(document.querySelectorAll('span, div, p'))
              .some(element => /^Page\\s+\\d+\\s+of\\s+\\d+$/i.test(String(element.textContent || '').trim()));
            const hasSearchInput = Array.from(document.querySelectorAll('input'))
              .some(input => String(input.getAttribute('placeholder') || '').toLowerCase().includes('boss'));
            // Estado vazio explícito também é painel montado — personagem sem
            // boss algum é resultado VÁLIDO, não falha.
            const hasEmptyState = Array.from(document.querySelectorAll('p, span, div'))
              .some(element => String(element.textContent || '').toLowerCase().includes('nenhum progresso de bosstiary'));
            const hasTableStructure = !!document.querySelector('table tbody, table thead, [role="table"]');
            return hasBossCell || hasPageIndicator || hasSearchInput || hasEmptyState || hasTableStructure;
          `, speed().bosstiaryPanelWaitMs);

          if (panelRace.outcome === 'load-error') {
            rubinotDiag('details', 'Falha ao carregar leilão detectada; abandonando personagem.', {
              id, etapa: 'aguardando-painel-bosstiary', waitedMs: Date.now() - startedAt,
            });
            explicitFailure = true;
            failedNow = true;
          } else {
            const panelReady = panelRace.outcome === 'ready';
            await page.waitForTimeout(speed().bosstiarySettleMs);
            // ETAPA 4 — painel montado, antes de qualquer leitura.
            await assertRubinotPageNotFailed(page, id, 'painel-bosstiary-montado');
            bosstiaryReady = true;
            rubinotDiag('details', 'Aba Bosstiary pronta.', { id, waitedMs: Date.now() - startedAt, painelMontado: panelReady });
          }
        } else {
          failedNow = true;
        }
      }

      if (!bosstiaryReady && failedNow) {
        // ── FALHA CONFIRMADA ──────────────────────────────────────────────
        // "Falha ao carregar leilão" na tela é definitivo — o site já decidiu.
        // Página comprovadamente morta (vazia/Cloudflare) idem: o DOM acabou de
        // ser inspecionado. Nenhum dos dois precisa de RE-VERIFICAÇÃO.
        //
        // Só a suspeita por TIMEOUT (nenhum sinal em nenhum sentido) ainda
        // merece confirmação: ali a página pode estar apenas lenta.
        //
        // O que TODOS os casos recebem é a trégua de `failureCooldownMs`
        // aplicada no fim deste bloco — ver "REGRA DOS 3 SEGUNDOS".
        // Toda falha que chega aqui é CONCLUSIVA: ou o site declarou o erro,
        // ou o teto de 1 segundo foi atingido e a página já foi inspecionada.
        // Não há nova espera nem re-verificação — seria justamente o tipo de
        // wait oculto que este teto existe para eliminar.
        throwIfRubinotRunCancelled(page, runState);

        if (explicitFailure) {
          // Motivo já é conhecido: o site declarou a falha. Poupamos um
          // `evaluate` extra e saímos na hora.
          lastPageDiagnosis = { reason: 'RUBINOT_ERRO_APP', currentUrl: String(page.url() || '').slice(0, 200) };
          rubinotDiag('details', 'Falha explícita do site; seguindo imediatamente para o próximo personagem.', {
            id, url, elapsedMs: Date.now() - startedAt, esperaAposFalhaMs: 0,
          });
        } else if (deadPage) {
          // `isRubinotAuctionPageAlive` já leu este DOM e classificou o
          // motivo. Repetir `diagnoseRubinotAuctionPage` seria um `evaluate`
          // extra na mesma página morta, sem informação nova.
          lastPageDiagnosis = deadPageDiagnosis || { reason: 'SPA_NAO_RENDERIZOU', currentUrl: String(page.url() || '').slice(0, 200) };
          rubinotDiag('details', 'Página morta; seguindo imediatamente para o próximo personagem.', {
            id, url, elapsedMs: Date.now() - startedAt, reason: lastPageDiagnosis?.reason, esperaAposFalhaMs: 0,
          });
        } else {
          // Sem texto de erro: descobrir o motivo (Cloudflare, SPA lenta...).
          lastPageDiagnosis = await diagnoseRubinotAuctionPage(page);
          rubinotDiag('details', 'Falha confirmada; personagem enviado ao retry com outro navegador.', {
            id, url, elapsedMs: Date.now() - startedAt, reason: lastPageDiagnosis?.reason,
          });
        }

        // ── TRÉGUA APÓS FALHA — AGENDADA, NÃO BLOQUEANTE ──────────────────
        // A trégua continua existindo (não emendar a próxima navegação logo
        // após um erro do site), mas NÃO é mais cumprida aqui.
        //
        // Antes, `await page.waitForTimeout(failureCooldownMs)` rodava depois
        // de a falha já estar confirmada e SEGURAVA o personagem atual —
        // 500ms (agressivo) a 1.500ms (moderado) de espera pura, somados aos
        // 300–800ms do intervalo normal entre personagens. O log chegava a
        // registrar `esperaAposFalhaMs: 0` logo antes de esperar de verdade.
        //
        // Agora apenas ANOTAMOS a dívida: o loop principal já espera entre
        // personagens e simplesmente estende esse intervalo até cobrir a
        // trégua. O respiro para o site é o mesmo; o que desaparece é a espera
        // duplicada. O personagem é registrado e liberado imediatamente.
        if (!bosstiaryReady) {
          scheduleRubinotFailureCooldown(speed().failureCooldownMs);
          rubinotDiag('details', '[Bazaar] Falha confirmada; trégua agendada para o intervalo entre personagens.', {
            id, treguaMs: speed().failureCooldownMs, motivo: lastPageDiagnosis?.reason,
            bloqueouPersonagemMs: 0,
          });
        }
      }
    } catch (error) {
      rubinotDiag('details', 'Falha tolerada ao tentar abrir a aba Bosstiary.', { id, url, error: String(error?.message || error) });
    }

    // Sem o botão: a análise NÃO é concluída. Retornar aqui impede que a
    // Bosstiary seja lida de uma página quebrada e que o personagem entre na
    // lista final com dados incorretos. A consulta segue para o próximo.
    if (!bosstiaryReady) {
      const reason = lastPageDiagnosis?.reason || 'RUBINOT_ERRO_APP';
      const reasonText = {
        CLOUDFLARE: 'Cloudflare exigiu verificação na página do personagem.',
        RUBINOT_ERRO_APP: 'O RubinOT exibiu "Falha ao carregar leilão" nesta página.',
        PAGINA_VAZIA: 'A página do personagem voltou vazia.',
        PAGINA_OK_SEM_BOSSTIARY: 'A página abriu, mas não expõe a aba Bosstiary.',
        SPA_NAO_RENDERIZOU: 'A página não terminou de renderizar dentro do tempo.',
      }[reason] || 'Botão Bosstiary não encontrado.';
      rubinotDiag('details', 'Personagem descartado: Bosstiary indisponível.', { id, url, reason, diagnosis: lastPageDiagnosis });
      return cacheRubinotDetails(id, {
        id, method: RUBINOT_DETAILS_METHOD, soulwarCompleted: null, sanguineCompleted: null,
        fetchedAt: Date.now(), failureReason: reason,
        error: reasonText,
      });
    }

    // Pausa após abrir a Bosstiary: a SPA acabou de montar o painel e emitir
    // as requisições dele. Emendar a leitura/pesquisa aqui é justamente o tipo
    // de encadeamento rápido que degradava o site.
    await page.waitForTimeout(speed().bosstiaryOpenGapMs);
    const bosstiary = await collectRubinotBosstiaryBosses(page, id, quests, sentinel);

    // ── VALIDAÇÃO FINAL (antes de salvar) ─────────────────────────────────
    // A página pode ter degradado DURANTE a leitura da Bosstiary. Confirmamos
    // que ela continua íntegra antes de aceitar qualquer resultado.
    const finalCheck = await validateRubinotAuctionPageAfterAnalysis(page);
    if (finalCheck.ok && finalCheck.panelMissing) {
      // Aba presente, painel não confirmado: resultado ACEITO (ver regra
      // principal em validateRubinotAuctionPageAfterAnalysis). Registrado
      // apenas para diagnóstico.
      rubinotDiag('details', 'Aba Bosstiary presente sem painel confirmado; personagem mantido.', { id, url });
    }
    if (!finalCheck.ok) {
      rubinotDiag('details', 'Falha detectada após carregamento inicial', {
        id,
        url,
        navegador: rubinotContextBrowserKey || rubinotSelectedBrowser,
        etapa: finalCheck.stage || 'pos-analise',
        motivo: finalCheck.reason,
        destino: 'retry com outro navegador (ou falha definitiva)',
        estado: finalCheck.state,
      });
      // `failureReason` recuperável faz o personagem entrar no retry final.
      return cacheRubinotDetails(id, {
        id, method: RUBINOT_DETAILS_METHOD,
        soulwarCompleted: null, sanguineCompleted: null,
        fetchedAt: Date.now(), failureReason: finalCheck.reason,
        error: 'A página falhou durante a análise da Bosstiary; resultado descartado.',
      });
    }

    const bossSet = new Set(bosstiary.bosses.map(normalizeRubinotBossName));
    const soulWarFoundBosses = RUBINOT_SOUL_WAR_BOSSES.filter(boss => bossSet.has(normalizeRubinotBossName(boss)));
    const sanguineFoundBosses = RUBINOT_SANGUINE_BOSSES.filter(boss => bossSet.has(normalizeRubinotBossName(boss)));
    const soulWarFinalFound = bossSet.has(normalizeRubinotBossName(RUBINOT_SOUL_WAR_FINAL_BOSS));
    const sanguineFinalFound = bossSet.has(normalizeRubinotBossName(RUBINOT_SANGUINE_FINAL_BOSS));

    // Quest NÃO exigida pelo filtro => `null` (= "Não verificado").
    // Nunca um boolean: `false` significaria "quest disponível", o que seria
    // inventar um resultado que não foi apurado.
    // "Nenhum progresso de bosstiary." é conclusivo: zero bosses mortos, logo
    // NENHUMA quest está concluída — ambas disponíveis (`false`). O resultado
    // continua respeitando o escopo: quest não exigida permanece `null`.
    const noProgress = bosstiary.noProgress === true;

    const details = {
      soulwarCompleted: quests.soulwar
        ? (noProgress ? false : (soulWarFoundBosses.length === RUBINOT_SOUL_WAR_BOSSES.length || soulWarFinalFound))
        : null,
      sanguineCompleted: quests.sanguine
        ? (noProgress ? false : (sanguineFoundBosses.length === RUBINOT_SANGUINE_BOSSES.length || sanguineFinalFound))
        : null,
      soulWarFoundBosses,
      sanguineFoundBosses,
      soulWarBossCount: soulWarFoundBosses.length,
      sanguineBossCount: sanguineFoundBosses.length,
      totalBosstiaryBosses: bossSet.size,
      bosstiaryStrategy: bosstiary.strategy,
      bosstiaryPageCount: bosstiary.pageCount,
      bosstiarySearchSummaries: bosstiary.searchSummaries,
    };

    // ── BOSSTIARY VAZIA É UM RESULTADO VÁLIDO ─────────────────────────────
    // ATENÇÃO: zero bosses NÃO é falha.
    //
    // Um personagem que nunca matou boss algum tem a Bosstiary legitimamente
    // vazia — e é justamente o caso mais valioso do filtro, porque significa
    // Soul War e Sanguine AMBAS DISPONÍVEIS.
    //
    // O que diferencia "vazia de verdade" de "não carregou" NÃO é a contagem
    // de bosses, e sim se o painel da Bosstiary chegou a ser montado na página.
    // Essa distinção é feita por `validateRubinotAuctionPageAfterAnalysis()`,
    // executada logo acima: ela exige a aba + o painel montado (tabela OU campo
    // de busca OU estado-vazio explícito). Se o painel está lá e não há linhas,
    // a leitura foi bem-sucedida e o resultado é confiável.
    //
    // Por isso não existe aqui nenhuma guarda por `bossSet.size === 0`.

    // Só é "indisponível" quando a quest FOI exigida mas não pôde ser apurada.
    // Um `null` por filtro em "Todas" é intencional, não uma falha.
    const hasUnavailableInfo =
      (quests.soulwar && details.soulwarCompleted === null) ||
      (quests.sanguine && details.sanguineCompleted === null);
    rubinotDiag('details', 'Bosstiary lida para disponibilidade de quests.', {
      id,
      totalBosstiaryBosses: details.totalBosstiaryBosses,
      bosstiaryStrategy: details.bosstiaryStrategy,
      bosstiaryPageCount: details.bosstiaryPageCount,
      bosstiarySearchSummaries: details.bosstiarySearchSummaries,
      soulWarBossCount: details.soulWarBossCount,
      sanguineBossCount: details.sanguineBossCount,
      soulWarFoundBosses: details.soulWarFoundBosses,
      sanguineFoundBosses: details.sanguineFoundBosses,
      soulwarCompleted: details.soulwarCompleted,
      sanguineCompleted: details.sanguineCompleted,
    });
    const result = {
      id,
      method: RUBINOT_DETAILS_METHOD,
      soulwarCompleted: details.soulwarCompleted,
      sanguineCompleted: details.sanguineCompleted,
      soulWarBossCount: details.soulWarBossCount,
      sanguineBossCount: details.sanguineBossCount,
      fetchedAt: Date.now(),
      ...(hasUnavailableInfo ? { error: 'Informação de Bosstiary indisponível no DOM atual do personagem.' } : {}),
    };
    return cacheRubinotDetails(id, result);
  } catch (error) {
    if (isRubinotBrowserClosedError(error) || runState?.cancelled) throw error;

    // ── ABANDONO POR "Falha ao carregar leilão" ───────────────────────────
    // Sinal levantado por qualquer etapa do fluxo (ver
    // `assertRubinotPageNotFailed` / `raceRubinotWaitAgainstFailure`). Não é
    // um bug: é a desistência antecipada funcionando.
    //
    // Entra no MESMO caminho de falha já existente — `failureReason:
    // 'RUBINOT_ERRO_APP'` é reconhecido por `isRubinotRecoverableFailure`, o
    // que coloca o personagem na fila de retry com outro navegador. Nenhuma
    // regra de retry, métrica ou progresso foi alterada.
    if (isRubinotLoadFailureError(error)) {
      // Diagnóstico da race condition: onde a falha apareceu, quanto tempo
      // depois de abrir a página e quanto tempo depois de ela parecer válida.
      const desdeValido = sentinel.elapsedSinceValid();
      rubinotDiag('details', '[Bazaar] Falha detectada posteriormente; análise abortada e enviada para retry.', {
        id, url, etapa: error.stage,
        navegador: rubinotContextBrowserKey || rubinotSelectedBrowser,
        desdeAberturaMs: sentinel.elapsedSincePageOpen(),
        paginaPareceuValida: sentinel.validAt() > 0,
        falhaAposEstadoValidoMs: desdeValido,
        detectadaPeloSentinela: sentinel.fired(),
        destino: 'retry com outro navegador (ou falha definitiva)',
      });
      return cacheRubinotDetails(id, {
        id, method: RUBINOT_DETAILS_METHOD,
        soulwarCompleted: null, sanguineCompleted: null,
        fetchedAt: Date.now(), failureReason: 'RUBINOT_ERRO_APP',
        failureStage: error.stage,
        error: 'O RubinOT exibiu "Falha ao carregar leilão" durante a análise.',
      });
    }

    return cacheRubinotDetails(id, { id, method: RUBINOT_DETAILS_METHOD, soulwarCompleted: null, sanguineCompleted: null, fetchedAt: Date.now(), error: String(error?.message || error) });
  } finally {
    // Limpeza garantida: nenhum observador, timer ou promessa sobrevive ao
    // personagem, qualquer que tenha sido o desfecho.
    //
    // `dispose()` é SÍNCRONO no que importa (libera a promessa) e dispara o
    // cancelamento na página em fire-and-forget: o próximo personagem não
    // espera por nada aqui.
    const cleanupStartedAt = Date.now();
    sentinel.dispose();
    rubinotDiag('details', '[Bazaar] Consulta concluída; cleanup finalizado.', {
      id, cleanupMs: Date.now() - cleanupStartedAt,
      totalMs: sentinel.elapsedSincePageOpen(),
    });
  }
}

// ============================================================================
// RETRY FINAL COM OUTRO NAVEGADOR
// ----------------------------------------------------------------------------
// Os testes reais mostraram que a taxa de sucesso depende fortemente do
// mecanismo: WebKit > Firefox > Edge > Chrome. Então, ao final da consulta
// principal, os personagens que falharam com "Falha ao carregar leilão" (ou
// equivalente) são tentados UMA vez com o próximo navegador da ordem.
//
// Apenas UM navegador extra — nunca todos em sequência.
// ============================================================================
const RUBINOT_BROWSER_FALLBACK_ORDER = ['webkit', 'firefox', 'edge', 'chrome'];

/**
 * Sanitiza a ordem de preferência vinda do renderer.
 *
 * Mantém só chaves válidas, remove duplicatas e completa com os navegadores
 * que faltarem (na ordem padrão), garantindo que a lista sempre cubra os 4.
 */
function normalizeRubinotBrowserOrder(order) {
  const seen = new Set();
  const result = [];
  for (const key of Array.isArray(order) ? order : []) {
    const normalized = String(key || '').trim().toLowerCase();
    if (RUBINOT_BROWSERS[normalized] && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  for (const key of RUBINOT_BROWSER_FALLBACK_ORDER) {
    if (!seen.has(key)) { seen.add(key); result.push(key); }
  }
  return result;
}

/**
 * Navegador do retry: o PRIMEIRO da ordem de preferência que seja diferente
 * do principal.
 *
 * Exemplo com a ordem [webkit, firefox, edge, chrome]:
 *   principal firefox -> retry webkit  (webkit é o 1º e não é o principal)
 *   principal webkit  -> retry firefox (webkit é o principal, pula para o 2º)
 *
 * Note que NÃO é "o próximo da lista": é sempre o mais preferido disponível.
 */
function getRubinotFallbackBrowser(currentKey, order = RUBINOT_BROWSER_FALLBACK_ORDER) {
  const current = resolveRubinotBrowserKey(currentKey);
  const preference = normalizeRubinotBrowserOrder(order);
  return preference.find(key => key !== current) || '';
}

/**
 * CADEIA de navegadores para os retries finais.
 *
 * O usuário marca quais navegadores quer usar; a ordem de preferência define a
 * sequência. O navegador PRINCIPAL pode ser marcado: uma segunda passada no
 * mesmo motor costuma recuperar falhas transitórias (página que não montou,
 * oscilação do site), e é o próprio usuário quem decide se vale a pena.
 *
 * Quando o principal está marcado, ele vem PRIMEIRO na cadeia: é a tentativa
 * mais barata, pois o contexto daquele navegador já está aberto e não há troca
 * de motor. Só depois entram os demais, na ordem de preferência.
 *
 * `selection` vazia/ausente => cai no comportamento anterior (um único retry
 * com OUTRO navegador), preservando quem não configurar nada.
 */
function buildRubinotRetryChain(primaryKey, selection, order = RUBINOT_BROWSER_FALLBACK_ORDER) {
  const primary = resolveRubinotBrowserKey(primaryKey);
  const preference = normalizeRubinotBrowserOrder(order);

  const chosen = new Set();
  for (const key of Array.isArray(selection) ? selection : []) {
    const normalized = String(key || '').trim().toLowerCase();
    if (RUBINOT_BROWSERS[normalized]) chosen.add(normalized);
  }

  // Sem seleção explícita: mantém o retry único de antes.
  if (chosen.size === 0) {
    const single = getRubinotFallbackBrowser(primary, order);
    return single ? [single] : [];
  }

  const others = preference.filter(key => key !== primary && chosen.has(key));
  // Principal marcado => primeira tentativa, sem trocar de navegador.
  return chosen.has(primary) ? [primary, ...others] : others;
}

/**
 * Teto de retries POR NAVEGADOR.
 *
 * O usuário escolhe quantas vezes cada navegador deve repetir a análise dos
 * personagens que ainda estão falhando. O limite existe para evitar valores
 * exagerados: cada tentativa reabre TODOS os links pendentes, então um número
 * alto multiplica o tempo da consulta e a pressão sobre o site.
 */
const RUBINOT_MAX_RETRIES_PER_BROWSER = 5;

/**
 * Normaliza o mapa de retries vindo do renderer.
 *
 * Devolve `null` quando o renderer NÃO mandou configuração alguma — é o que
 * distingue "não configurado" (cai no comportamento antigo, por seleção de
 * navegadores) de "configurado com zeros" (nenhum retry, por decisão
 * explícita do usuário). Valores fora da faixa são truncados para 0..MAX.
 */
function normalizeRubinotRetryCounts(counts) {
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) return null;
  const normalized = {};
  let sawKey = false;
  for (const key of Object.keys(RUBINOT_BROWSERS)) {
    if (!Object.prototype.hasOwnProperty.call(counts, key)) continue;
    sawKey = true;
    const raw = Math.floor(Number(counts[key]));
    if (!Number.isFinite(raw) || raw <= 0) { normalized[key] = 0; continue; }
    normalized[key] = Math.min(RUBINOT_MAX_RETRIES_PER_BROWSER, raw);
  }
  if (!sawKey) return null;
  // Chaves ausentes valem 0: quem não foi configurado não faz retry.
  for (const key of Object.keys(RUBINOT_BROWSERS)) {
    if (typeof normalized[key] !== 'number') normalized[key] = 0;
  }
  return normalized;
}

/**
 * PLANO de retries: a cadeia de navegadores EXPANDIDA pela quantidade de
 * tentativas configurada para cada um.
 *
 * Cada item é uma passada real:
 *   { browser: 'webkit', attempt: 1, attempts: 2 }
 *
 * Exemplo — principal WebKit, WebKit:2 e Firefox:1, ordem [webkit, firefox,
 * edge, chrome]:
 *   consulta principal (WebKit)
 *   -> webkit 1/2 -> webkit 2/2 -> firefox 1/1
 *
 * O navegador PRINCIPAL, quando tem retries configurados, vem primeiro: é a
 * tentativa mais barata (o contexto já está aberto, não há troca de motor).
 * Os demais seguem a ordem de preferência do usuário.
 *
 * Compatibilidade: sem `counts` (renderer antigo) o plano é a cadeia de antes,
 * com UMA tentativa por navegador marcado.
 */
function buildRubinotRetryPlan(primaryKey, selection, counts, order = RUBINOT_BROWSER_FALLBACK_ORDER) {
  const primary = resolveRubinotBrowserKey(primaryKey);
  const preference = normalizeRubinotBrowserOrder(order);
  const normalized = normalizeRubinotRetryCounts(counts);

  // Sem mapa de quantidades: uma tentativa por navegador da cadeia antiga.
  if (!normalized) {
    return buildRubinotRetryChain(primary, selection, order)
      .map(browser => ({ browser, attempt: 1, attempts: 1 }));
  }

  // Com mapa: a sequência é o principal (se tiver retries) e depois os demais
  // com retries, na ordem de preferência.
  const sequence = [];
  if (normalized[primary] > 0) sequence.push(primary);
  for (const key of preference) {
    if (key !== primary && normalized[key] > 0) sequence.push(key);
  }

  const plan = [];
  for (const browser of sequence) {
    const attempts = normalized[browser];
    for (let attempt = 1; attempt <= attempts; attempt++) {
      plan.push({ browser, attempt, attempts });
    }
  }
  return plan;
}

/** Navegadores distintos de um plano, na ordem em que aparecem. */
function summarizeRubinotRetryPlan(plan) {
  const summary = [];
  const seen = new Map();
  for (const step of Array.isArray(plan) ? plan : []) {
    if (seen.has(step.browser)) continue;
    seen.set(step.browser, true);
    summary.push({ browser: step.browser, attempts: step.attempts });
  }
  return summary;
}

/**
 * Um resultado só é "recuperável" quando a página não abriu por um motivo
 * transitório. Erros conclusivos (ex.: URL inválida) não vão para o retry.
 */
function isRubinotRecoverableFailure(detail) {
  if (!detail || !detail.error) return false;
  const reason = String(detail.failureReason || '');
  return reason === 'RUBINOT_ERRO_APP' ||
    reason === 'SPA_NAO_RENDERIZOU' ||
    reason === 'PAGINA_VAZIA' ||
    reason === 'PAGINA_OK_SEM_BOSSTIARY' ||
    reason === 'CLOUDFLARE' ||
    // Falha detectada DEPOIS do carregamento inicial: a página degradou no meio
    // da análise. Transitória — o outro navegador costuma resolver.
    reason === 'DIAGNOSTICO_FALHOU' ||
    reason === 'DESCONHECIDO';
}

/**
 * Quais quests precisam ser apuradas nesta consulta.
 *
 * Espelha os "Filtros Consulta": uma quest em "Todas" (`all`) não influencia o
 * resultado, então não há motivo para consultar os bosses dela. Pular isso
 * elimina buscas inteiras na Bosstiary — 5 delas no caso da Sanguine.
 */
function resolveRubinotQuestScope(options = {}) {
  const scope = options?.quests;
  // Sem informação explícita, mantém o comportamento antigo (verifica tudo).
  if (!scope || typeof scope !== 'object') return { soulwar: true, sanguine: true };
  return { soulwar: scope.soulwar !== false, sanguine: scope.sanguine !== false };
}

/** Falhas consecutivas a partir das quais suspeitamos de sessão expirada. */
const RUBINOT_SESSION_EXPIRED_STREAK = 8;

/** Maior sequência de falhas seguidas na ordem em que foram processadas. */
function countRubinotConsecutiveFailures(list, details) {
  let longest = 0;
  let current = 0;
  for (const auction of list) {
    const key = auction?.id || auction?.name || auction?.url;
    const detail = key ? details[key] : null;
    if (detail && detail.error) {
      current += 1;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  return longest;
}

/** Executa a análise individual de uma lista usando UM navegador. */
async function runRubinotDetailsPass(auctions = [], options = {}, progressSender = null, browserKey = rubinotSelectedBrowser, progressLabel = 'Verificando disponibilidade das Quests...') {
  const runState = { cancelled: false, reason: '' };
  const markCancelled = (reason) => {
    runState.cancelled = true;
    runState.reason = reason || 'Consulta cancelada: navegador fechado.';
  };

  let context = null;
  let detailPage = null;
  let onContextClose = null;
  let onPageClose = null;

  try {
    context = await getRubinotContext(browserKey, !!options.cleanProfile);
    onContextClose = () => markCancelled('Consulta cancelada: navegador Rubinot fechado manualmente.');
    context.once('close', onContextClose);

    // ── Retry final: sessão leve ──────────────────────────────────────────
    // `ensureRubinotSessionReady` navega até /bazaar e chama a API da listagem
    // para provar que a sessão está válida. Isso faz sentido na consulta
    // principal, mas no RETRY seria trabalho duplicado: a listagem já foi lida
    // e os filtros já foram aplicados. Aqui só precisamos abrir os links
    // individuais que falharam, então pulamos essa validação.
    if (options.skipSessionWarmup) {
      rubinotDiag('details', 'Retry: abrindo apenas os links pendentes, sem repetir a listagem.', {
        browser: browserKey, totalAuctions: Array.isArray(auctions) ? auctions.length : 0,
      });
    } else {
      const session = await ensureRubinotSessionReady(context, runState, 'details-session');
      if (!session.ok) {
        return { ok: false, error: session.message || 'Sessão Rubinot indisponível para detalhes.', needsHumanVerification: !!session.needsHumanVerification, details: {} };
      }
      rubinotDiag('details', 'Sessão validada; iniciando análise individual.', { totalAuctions: Array.isArray(auctions) ? auctions.length : 0 });

      // APENAS UMA ABA DO BAZAAR: a aba de sessão já cumpriu seu papel (provar
      // que os cookies valem e que o Cloudflare liberou). Mantê-la aberta em
      // /bazaar deixaria a SPA com polling ativo em paralelo à análise — o
      // suporte do site recomenda explicitamente uma única aba. Os cookies
      // vivem no CONTEXTO, não na aba, então fechá-la não invalida a sessão.
      await closeRubinotSessionPage('analise-individual');
    }

    detailPage = await context.newPage();
    onPageClose = () => markCancelled('Consulta cancelada: página de detalhes do Rubinot fechada manualmente.');
    detailPage.once('close', onPageClose);

    const details = {};
    const list = Array.isArray(auctions) ? auctions : [];
    // Cada passada (principal ou retry) começa no ritmo base.
    resetRubinotPace();
    rubinotDiag('details', 'Iniciando consulta individual de quests.', {
      total: list.length, forceRefresh: !!options.forceRefresh, modo: rubinotSpeedMode, intervaloBaseMs: speed().detailsGapMs,
    });

    // ── CONTAGEM AO VIVO DE FALHAS QUE IRÃO PARA O RETRY ──────────────────
    // Conta apenas quem REALMENTE será reenviado: usa `isRubinotRecoverableFailure`,
    // exatamente o mesmo critério que monta `failedAuctions` em
    // `fetchRubinotDetailsWithPlaywright`. Assim o número exibido nunca diverge
    // do que de fato acontece depois.
    //
    // O Set por chave garante que reprocessar um personagem não conte duas
    // vezes. `isRetryPass` distingue a passada principal do retry: durante o
    // retry, esta lista JÁ É a das falhas, então o rótulo muda de sentido.
    const retryCandidates = new Set();
    const isRetryPass = options.skipSessionWarmup === true;

    // Abre a entrada deste navegador no acompanhamento por navegador.
    // Uma entrada por passada: nenhuma contagem é somada duas vezes.
    startRubinotBrowserStats(
      resolveRubinotBrowserKey(browserKey), list.length, isRetryPass,
      Number(options.retryAttempt || 0), Number(options.retryAttempts || 0),
    );
    let passAnalyzed = 0;
    let passFailed = 0;

    const progressExtra = () => ({
      retryPending: retryCandidates.size,
      isRetryPass,
      ...buildRubinotBrowserProgress(),
    });

    sendRubinotProgress(progressSender, buildRubinotProgress('details', progressLabel, 0, list.length, progressExtra()));

    let stoppedManually = false;

    for (let index = 0; index < list.length; index++) {
      // ── PONTO SEGURO DE PARADA ────────────────────────────────────────
      // Verificado ANTES de abrir o próximo personagem: nunca no meio de uma
      // análise. Quem já foi analisado está em `details` e será devolvido;
      // quem ainda não começou simplesmente não entra. Não há resultado
      // parcial de um personagem — ou ele foi concluído, ou não existe.
      if (isRubinotManualStopRequested()) {
        stoppedManually = true;
        rubinotDiag('details', 'Encerramento manual: interrompendo antes do próximo personagem.', {
          analisados: passAnalyzed, restantes: list.length - index,
        });
        break;
      }

      const auction = list[index];
      throwIfRubinotRunCancelled(detailPage, runState);
      const key = auction?.id || auction?.name || auction?.url;
      if (!key) continue;
      rubinotDiag('details', 'Consultando página individual do personagem.', { key, name: auction?.name, url: normalizeRubinotAuctionUrl(auction) });
      details[key] = await fetchRubinotCharacterDetails(detailPage, auction, options, runState);
      throwIfRubinotRunCancelled(detailPage, runState);

      // Atualiza a contagem ANTES de enviar o progresso, para o número refletir
      // o personagem que acabou de ser processado. Um Set evita duplicidade e
      // permite que um personagem saia da lista se for recuperado.
      if (isRubinotRecoverableFailure(details[key])) retryCandidates.add(key);
      else retryCandidates.delete(key);

      // Taxa de falhas AO VIVO deste navegador: falhas / analisados até agora.
      passAnalyzed += 1;
      if (details[key]?.error) passFailed += 1;
      updateRubinotBrowserStats(passAnalyzed, passFailed);

      sendRubinotProgress(progressSender, buildRubinotProgress('details', progressLabel, index + 1, list.length, progressExtra()));

      // Ritmo adaptativo: sequências de falha desaceleram a consulta; a
      // estabilidade acelera de volta, aos poucos. Ver a seção RITMO.
      registerRubinotPaceOutcome(!details[key]?.error);

      // Sem pausa depois do ÚLTIMO personagem: não há próxima navegação para
      // espaçar, seria só tempo morto no fim da consulta.
      // Pedido de parada durante a análise: sai sem cumprir a pausa. Esperar
      // até 3,5s de ritmo depois de o usuário pedir para concluir seria uma
      // demora sem propósito.
      if (isRubinotManualStopRequested()) {
        stoppedManually = true;
        rubinotDiag('details', 'Encerramento manual: pausa entre personagens dispensada.');
        break;
      }

      if (index < list.length - 1) {
        const gap = getRubinotPaceGapMs();
        if (rubinotPaceExtraMs > 0) {
          rubinotDiag('details', 'Ritmo reduzido após falhas consecutivas.', {
            falhasSeguidas: rubinotPaceFailureStreak, intervaloMs: gap, acrescimoMs: rubinotPaceExtraMs,
          });
        }
        await detailPage.waitForTimeout(gap);
      }
    }

    finishRubinotBrowserStats();
    rubinotContextLastUsedAt = Date.now();
    // `stoppedManually` sobe para o orquestrador, que então NÃO inicia os
    // retries pendentes. O resultado segue válido (`ok: true`).
    return { ok: true, details, stoppedManually };
  } catch (error) {
    if (runState.cancelled || isRubinotBrowserClosedError(error)) {
      rubinotDiag('details', 'Consulta de detalhes cancelada.', { reason: runState.reason, error: String(error?.message || error) });
      if (isRubinotBrowserClosedError(error)) {
        rubinotContext = null;
        rubinotSessionPage = null;
        rubinotSessionReadyAt = 0;
      }
      rubinotDetailsInFlight.clear();
      return { ok: false, cancelled: true, error: runState.reason || 'Consulta cancelada: navegador fechado.', details: {} };
    }
    rubinotDiag('details', 'Erro na consulta de detalhes.', { error: String(error?.message || error) });
    rubinotDetailsInFlight.clear();
    return { ok: false, error: String(error?.message || error), details: {} };
  } finally {
    try { if (context && onContextClose) context.off('close', onContextClose); } catch (_) {}
    try { if (detailPage && onPageClose && !detailPage.isClosed()) detailPage.off('close', onPageClose); } catch (_) {}
    try { if (detailPage && !detailPage.isClosed()) await detailPage.close(); } catch (_) {}
  }
}

/**
 * Orquestra a análise individual: passada principal com o navegador escolhido
 * e, se sobrarem falhas recuperáveis, UMA passada extra com o próximo
 * navegador da ordem de preferência.
 *
 * Personagens já analisados com sucesso NÃO são reprocessados, e o retry
 * nunca duplica entradas: o mapa é indexado pela mesma chave.
 */
async function fetchRubinotDetailsWithPlaywright(auctions = [], options = {}, progressSender = null, browserKey = rubinotSelectedBrowser) {
  const primaryBrowser = resolveRubinotBrowserKey(browserKey);
  const list = Array.isArray(auctions) ? auctions : [];
  const detailsStartedAt = Date.now();
  // Zera o acompanhamento por navegador desta execução.
  resetRubinotRunProgress();
  // Cadeia de retry JÁ na primeira atualização de progresso: o usuário vê a
  // configuração desde o começo, e não só quando os retries começam.
  rubinotRunRetrySelection = buildRubinotRetryChain(primaryBrowser, options?.retryBrowsers, options?.browserOrder);
  // Plano expandido: cada passada configurada vira um item. É ele que comanda
  // o laço de retries daqui para baixo.
  rubinotRunRetryPlan = buildRubinotRetryPlan(
    primaryBrowser, options?.retryBrowsers, options?.retryCounts, options?.browserOrder,
  );

  const primary = await runRubinotDetailsPass(list, options, progressSender, primaryBrowser);
  if (!primary.ok) {
    return { ...primary, primaryBrowser, retryBrowser: '', retryStats: [], retryBrowsers: [], totalRequested: list.length, analyzedCount: 0, recoveredCount: 0, failedCount: list.length };
  }

  const details = { ...(primary.details || {}) };

  // Só voltam ao retry os que falharam por motivo transitório.
  const failedAuctions = list.filter(auction => {
    const key = auction?.id || auction?.name || auction?.url;
    return key && isRubinotRecoverableFailure(details[key]);
  });

  // ── CADEIA DE RETRIES ───────────────────────────────────────────────────
  // Os navegadores marcados pelo usuário são tentados EM SEQUÊNCIA, cada um
  // recebendo apenas quem AINDA está falhando. Um personagem recuperado sai da
  // lista na hora e não é reaberto nos navegadores seguintes — é o que evita
  // trabalho inútil e garante que ninguém seja analisado duas vezes.
  // Mesmo plano já calculado no início (entradas idênticas => mesmo valor).
  const retryPlan = rubinotRunRetryPlan;
  // Os pendentes só existem se ainda houver personagens para reprocessar.
  // Cada PASSADA sai desta fila assim que começa a rodar — um navegador com
  // 2 retries ocupa 2 posições.
  rubinotRunPendingSteps = failedAuctions.length > 0 ? [...retryPlan] : [];
  rubinotRunPendingBrowsers = rubinotRunPendingSteps.map(step => step.browser);
  // Quem cada passada recuperou, para a "Última Consulta".
  const retryStats = [];
  let recoveredCount = 0;
  // Fila de pendentes: encolhe a cada passada que recupera alguém.
  let pending = failedAuctions;

  if (pending.length > 0 && retryPlan.length > 0) {
    rubinotDiag('details', 'Iniciando cadeia de retries.', {
      primaryBrowser,
      plano: retryPlan.map(step => `${step.browser} ${step.attempt}/${step.attempts}`),
      passadas: retryPlan.length,
      pendentes: pending.length,
    });
  }

  // Parada manual na passada principal: NENHUM retry começa. A fila de
  // pendentes é esvaziada para o painel não anunciar navegadores que não vão
  // rodar.
  let stoppedManually = primary.stoppedManually === true;
  if (stoppedManually && rubinotRunPendingSteps.length > 0) {
    rubinotDiag('details', 'Encerramento manual: retries pendentes cancelados.', {
      cancelados: rubinotRunPendingSteps.map(step => `${step.browser} ${step.attempt}/${step.attempts}`),
    });
    rubinotRunPendingSteps = [];
    rubinotRunPendingBrowsers = [];
  }

  for (const step of retryPlan) {
    if (stoppedManually) break;        // usuário pediu para concluir agora
    if (pending.length === 0) break;   // todos recuperados: encerra a cadeia

    const chainBrowser = step.browser;
    const baseLabel = RUBINOT_BROWSERS[chainBrowser]?.label || chainBrowser;
    // Rótulo com o número da tentativa quando o navegador repete mais de uma
    // vez — sem isso o usuário veria "WebKit" duas vezes seguidas sem saber
    // qual das duas está rodando.
    const retryLabel = step.attempts > 1 ? `${baseLabel} (${step.attempt}/${step.attempts})` : baseLabel;
    rubinotDiag('details', 'Retry com navegador da cadeia.', {
      navegador: chainBrowser, tentativa: `${step.attempt}/${step.attempts}`, pendentes: pending.length,
    });

    // `forceRefresh` é obrigatório: sem ele o cache devolveria o erro anterior.
    // `skipSessionWarmup`: o retry NÃO repete a listagem nem os filtros —
    // abre direto os links dos personagens pendentes.
    const retry = await runRubinotDetailsPass(
      pending,
      { ...options, forceRefresh: true, skipSessionWarmup: true, retryAttempt: step.attempt, retryAttempts: step.attempts },
      progressSender,
      chainBrowser,
      `Tentando novamente ${pending.length} personagem(ns) com ${retryLabel}...`,
    );

    if (!retry.ok) {
      // Navegador indisponível não invalida a consulta nem interrompe a
      // cadeia: seguimos para o próximo marcado.
      rubinotDiag('details', 'Navegador da cadeia indisponível; seguindo para o próximo.', {
        navegador: chainBrowser, tentativa: `${step.attempt}/${step.attempts}`, error: retry.error,
      });
      continue;
    }

    let recoveredHere = 0;
    const stillFailing = [];
    for (const auction of pending) {
      const key = auction?.id || auction?.name || auction?.url;
      if (!key) continue;
      const value = (retry.details || {})[key];

      // Sucesso: substitui o resultado e REMOVE da fila — não será reaberto
      // nos navegadores seguintes.
      if (value && !value.error) {
        details[key] = value;
        recoveredHere += 1;
        recoveredCount += 1;
        continue;
      }

      // Continua falhando: guarda o erro mais recente e segue na fila.
      if (value?.error) details[key] = { ...value, retriedWith: chainBrowser };
      stillFailing.push(auction);
    }

    if (retry.stoppedManually === true) stoppedManually = true;

    retryStats.push({
      browser: chainBrowser, attempted: pending.length, recovered: recoveredHere,
      attempt: step.attempt, attempts: step.attempts,
    });
    rubinotDiag('details', 'Retry deste navegador concluído.', {
      navegador: chainBrowser, tentativa: `${step.attempt}/${step.attempts}`,
      tentados: pending.length, recuperados: recoveredHere, restantes: stillFailing.length,
    });

    pending = stillFailing;
  }

  // Compatibilidade: `retryBrowser` (singular) segue existindo para quem lê o
  // campo antigo — aponta o primeiro navegador que efetivamente rodou.
  // Cadeia encerrada: ninguém mais pendente (inclusive se a fila esvaziou
  // antes de todas as passadas rodarem).
  rubinotRunPendingSteps = [];
  rubinotRunPendingBrowsers = [];

  const retryBrowser = retryStats.length > 0 ? retryStats[0].browser : '';

  // ── SESSÃO POSSIVELMENTE EXPIRADA ──────────────────────────────────────
  // Muitas falhas seguidas, sumiço dos cookies esperados ou reaparecimento do
  // Cloudflare sugerem que a sessão preparada não vale mais. Apenas AVISAMOS:
  // nunca tentamos autenticar sozinhos.
  let sessionExpired = false;
  let sessionState = null;
  try {
    if (rubinotContext) sessionState = await inspectRubinotSessionState(rubinotContext);
  } catch (_) {}

  const consecutive = countRubinotConsecutiveFailures(list, details);
  const cloudflareHits = Object.values(details).filter(d => d?.failureReason === 'CLOUDFLARE').length;
  if (list.length > 0) {
    sessionExpired =
      consecutive >= RUBINOT_SESSION_EXPIRED_STREAK ||
      sessionState?.status === 'expirada' ||
      cloudflareHits >= RUBINOT_SESSION_EXPIRED_STREAK;
    if (sessionExpired) {
      rubinotDiag('session', 'Indícios de sessão expirada durante a consulta.', {
        falhasConsecutivas: consecutive, cloudflare: cloudflareHits, statusSessao: sessionState?.status,
      });
    }
  }

  const analyzedCount = Object.values(details).filter(detail => detail && !detail.error).length;
  const failedCount = list.length - analyzedCount;

  // Identificação dos personagens que NÃO puderam ser analisados. Serve para o
  // usuário abrir manualmente cada leilão no navegador — por isso guardamos
  // nome e URL, não só a contagem.
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
        url: normalizeRubinotAuctionUrl(auction),
        reason: String(details[key]?.failureReason || ''),
      };
    })
    .filter(entry => entry.url);

  // ── RESUMO DA CONSULTA ─────────────────────────────────────────────────
  // Métricas para comparar execuções entre si. Nada é publicado no Firestore.
  const successRate = list.length > 0 ? Math.round((analyzedCount / list.length) * 100) : 0;
  rubinotDiag('resumo', 'Consulta individual finalizada.', {
    navegador: primaryBrowser,
    navegadoresRetry: retryStats.length > 0
      ? retryStats.map(r => `${r.browser}#${r.attempt}:+${r.recovered}/${r.attempted}`).join(' ')
      : '(nenhum)',
    personagensAnalisados: analyzedCount,
    falhas: failedCount,
    taxaSucesso: `${successRate}%`,
    tempoTotalMs: Date.now() - detailsStartedAt,
  });

  return {
    ok: true,
    details,
    primaryBrowser,
    retryBrowser,
    // Cadeia completa: navegador, quantos recebeu e quantos recuperou.
    retryStats,
    // Navegadores DISTINTOS que rodaram no retry (sem repetir quem fez várias
    // tentativas) — é o formato que o campo sempre teve.
    retryBrowsers: [...new Set(retryStats.map(r => r.browser))],
    totalRequested: list.length,
    analyzedCount,
    recoveredCount,
    failedCount,
    failedCharacterList,
    // Sinaliza ao renderer que vale pedir uma nova preparação de sessão.
    sessionExpired,
    sessionStatus: sessionState?.status || 'desconhecida',
    consecutiveFailures: consecutive,
    // Encerrada pelo botão "Concluir agora": o renderer usa isso para marcar
    // a "Última Consulta" e para tratar a lista como parcial.
    stoppedManually,
    // Quantos personagens sequer chegaram a ser abertos.
    notAnalyzedCount: Math.max(0, list.length - Object.keys(details).length),
    // ── Métricas da consulta ──────────────────────────────────────────────
    successRate,
    totalDurationMs: Date.now() - detailsStartedAt,
  };
}

async function fetchRubinotBazaarWithPlaywright(progressSender = null, browserKey = rubinotSelectedBrowser, endUntilTs = 0, cleanProfile = false) {
  if (rubinotFetchInFlight) return rubinotFetchInFlight;

  rubinotFetchInFlight = (async () => {
    try {
      sendRubinotProgress(progressSender, buildRubinotProgress('bazaar', 'Buscando personagens...', 0, 0));
      const context = await getRubinotContext(browserKey, cleanProfile);
      const session = await ensureRubinotSessionReady(context, null, 'bazaar-session');
      if (!session.ok) {
        return {
          ok: false,
          error: session.message || 'Não foi possível validar a sessão Rubinot.',
          needsHumanVerification: !!session.needsHumanVerification,
          auctions: [],
          total: 0,
          fetchedAt: Date.now(),
        };
      }

      const page = session.page;
      // Mapa pageNum -> leilões daquela página. Usar um Map (em vez de empurrar
      // num array) garante que reprocessar uma página SUBSTITUA o conteúdo
      // anterior, tornando a retentativa idempotente e impedindo duplicação.
      const pageResults = new Map();
      const failedPages = new Map();
      let totalPages = 1;
      let firstData = session.apiData;

      const browserProfile = {
        channel: rubinotContextChannel,
        profile: rubinotContextProfileDir ? path.basename(rubinotContextProfileDir) : '',
        persistent: true,
      };

      /** Guarda o resultado de uma página, sobrescrevendo tentativas anteriores. */
      const storePage = (pageNum, data) => {
        const auctions = Array.isArray(data?.auctions) ? data.auctions : [];
        pageResults.set(pageNum, auctions.map(normalizeRubinotAuction));
        const reported = Number(data?.pagination?.totalPages || 0);
        if (reported > 0) totalPages = reported;
      };

      const collectedCount = () => {
        let sum = 0;
        for (const list of pageResults.values()) sum += list.length;
        return sum;
      };

      const emitProgress = () => {
        const collected = collectedCount();
        const estimated = Math.max(collected, totalPages * Number(RUBINOT_BAZAAR_PARAMS.limit || 100));
        sendRubinotProgress(progressSender, buildRubinotProgress('bazaar', 'Buscando personagens...', collected, estimated));
      };

      // Limite de encerramento vindo dos filtros do usuário (segundos, epoch).
      // Habilita a parada antecipada; ausente, a listagem é percorrida inteira.
      const endLimitTs = Number(endUntilTs || 0);
      const earlyStopEnabled = endLimitTs > 0 && canUseRubinotEarlyStop();
      let stoppedEarlyAtPage = 0;

      /** Processa uma página e registra o resultado. */
      const processPage = async (pageNum, label) => {
        const startedAt = Date.now();
        const result = await fetchRubinotBazaarPageResilient(page, pageNum, null);
        const elapsedMs = Date.now() - startedAt;

        if (result.ok) {
          storePage(pageNum, result.data);
          failedPages.delete(pageNum);
        } else {
          failedPages.set(pageNum, { outcome: result.outcome, status: result.status, message: result.message, attempts: result.attemptsUsed });
          rubinotDiag('bazaar', `Página falhou (${label}).`, {
            pageNum, totalPages, outcome: result.outcome, status: result.status, elapsedMs, browserProfile,
          });
        }
        emitProgress();
        return result.ok;
      };

      // ── Passada 1: sequencial, sem pausa e com parada antecipada ───────────
      // Cada iteração é um único fetch JSON. Com o filtro de encerramento, a
      // leitura para assim que a lista (ordenada por auction_end asc) ultrapassa
      // o limite — normalmente poucas páginas em vez de dezenas.
      for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
        // Encerramento manual durante a listagem: para de pedir páginas. As já
        // coletadas são válidas e seguem para a análise; a consulta é tratada
        // como PARCIAL, exatamente como quando uma página não responde.
        if (isRubinotManualStopRequested()) {
          rubinotDiag('bazaar', 'Encerramento manual: interrompendo a listagem.', {
            paginaAtual: pageNum, totalPages, coletados: collectedCount(),
          });
          break;
        }

        if (pageNum === 1 && firstData) {
          // A página 1 já veio da validação de sessão: não repetimos a chamada.
          storePage(1, firstData);
          firstData = null;
          emitProgress();
        } else {
          await processPage(pageNum, 'primeira passada');
          if (RUBINOT_PAGE_INTERVAL_MS > 0) await sleep(RUBINOT_PAGE_INTERVAL_MS);
        }

        // A checagem usa os leilões JÁ COLETADOS desta página: ela é feita
        // depois de guardar, então nenhum personagem válido é descartado.
        if (earlyStopEnabled && shouldStopRubinotListing(pageResults.get(pageNum) || [], endLimitTs)) {
          stoppedEarlyAtPage = pageNum;
          rubinotDiag('bazaar', 'Parada antecipada: leilões além do limite de encerramento.', {
            pageNum, totalPages, endLimitTs, paginasEvitadas: Math.max(0, totalPages - pageNum),
          });
          break;
        }
      }

      // ── Passada 2: recuperação apenas das páginas que falharam ─────────────
      if (failedPages.size > 0 && !isRubinotManualStopRequested()) {
        const pending = Array.from(failedPages.keys()).sort((a, b) => a - b);
        rubinotDiag('bazaar', 'Iniciando passada de recuperação das páginas que falharam.', { pending, totalPages });
        sendRubinotProgress(progressSender, buildRubinotProgress('bazaar', `Reprocessando ${pending.length} página(s) que falharam...`, collectedCount(), Math.max(collectedCount(), totalPages * Number(RUBINOT_BAZAAR_PARAMS.limit || 100))));

        for (const pageNum of pending) {
          // Intervalo maior na recuperação: se a causa foi ritmo/limite, dar
          // mais folga aumenta a chance de sucesso.
          await sleep(RUBINOT_PAGE_RECOVERY_INTERVAL_MS);
          const recovered = await processPage(pageNum, 'recuperação');
          if (recovered) rubinotDiag('bazaar', 'Página recuperada na segunda passada.', { pageNum });
        }
      }

      // ── Consolidação: ordem estável e sem duplicatas ───────────────────────
      const loadedPages = Array.from(pageResults.keys()).sort((a, b) => a - b);
      const failedPageNumbers = Array.from(failedPages.keys()).sort((a, b) => a - b);
      const seenIds = new Set();
      const allAuctions = [];
      for (const pageNum of loadedPages) {
        for (const auction of pageResults.get(pageNum)) {
          // Blindagem extra contra duplicatas: a mesma id pode aparecer em duas
          // páginas se a paginação do site deslocar entre as chamadas.
          const key = auction?.id || auction?.url || auction?.name;
          if (key && seenIds.has(key)) continue;
          if (key) seenIds.add(key);
          allAuctions.push(auction);
        }
      }

      const isPartial = failedPageNumbers.length > 0;

      // Falha grave: nada (ou quase nada) foi carregado. Preserva a lista oficial.
      if (loadedPages.length === 0) {
        rubinotDiag('bazaar', 'Nenhuma página da listagem pôde ser carregada.', { totalPages, failedPages: failedPageNumbers, browserProfile });
        return {
          ok: false,
          error: `Consulta falhou: nenhuma das ${totalPages} páginas do Bazaar respondeu. A lista oficial anterior foi mantida.`,
          auctions: [],
          total: 0,
          fetchedAt: Date.now(),
        };
      }

      sendRubinotProgress(progressSender, buildRubinotProgress('bazaar', 'Buscando personagens...', allAuctions.length, allAuctions.length));
      rubinotContextLastUsedAt = Date.now();
      rubinotDiag('bazaar', isPartial ? 'Consulta principal concluída de forma PARCIAL.' : 'Consulta principal concluída.', {
        total: allAuctions.length,
        totalPages,
        loadedPages: loadedPages.length,
        failedPages: failedPageNumbers,
        failureDetail: Object.fromEntries(failedPages),
        browserProfile,
      });

      return {
        ok: true,
        fetchedAt: Date.now(),
        total: allAuctions.length,
        auctions: allAuctions,
        // Metadados de completude — consumidos pelo renderer para decidir se a
        // lista pode substituir a oficial e o que mostrar ao Boss.
        partial: isPartial,
        totalPages,
        loadedPageCount: loadedPages.length,
        failedPageNumbers,
        failedPageDetails: Object.fromEntries(failedPages),
        browserProfile,
        // Telemetria da listagem, exibida em "Última consulta".
        pagesScanned: loadedPages.length,
        stoppedEarly: stoppedEarlyAtPage > 0,
        stoppedAtPage: stoppedEarlyAtPage,
      };
    } catch (error) {
      if (isRubinotBrowserClosedError(error)) {
        rubinotContext = null;
        rubinotSessionPage = null;
        rubinotSessionReadyAt = 0;
      }
      rubinotDiag('bazaar', 'Erro na consulta principal.', { error: String(error?.message || error) });
      return {
        ok: false,
        error: String(error?.message || error),
        // Sinaliza ao renderer que a causa foi o navegador escolhido, para que
        // ele reabra o seletor em vez de mostrar um erro genérico.
        browserUnavailable: !!error?.browserUnavailable,
        browserKey: error?.browserKey || '',
        auctions: [], total: 0, fetchedAt: Date.now(),
      };
    } finally {
      rubinotFetchInFlight = null;
    }
  })();

  return rubinotFetchInFlight;
}

// ============================================================================
// IPC HANDLERS — Comunicação React ↔ Electron
// ============================================================================


// --- Notificação desktop nativa: clique deve reutilizar a janela principal ---
// ANTI-DUPLICIDADE: a notificação da Web usa `tag` (o SO substitui a bolha de
// mesma tag). O Notification do processo MAIN do Electron não tem `tag` —
// então o dedup é feito AQUI, pelo `actionId` (= id da notificação): se uma
// notificação com o MESMO actionId já está em tela, ela é FECHADA antes da
// nova aparecer. Assim um reenvio do mesmo evento substitui a bolha em vez de
// empilhar, com o mesmo comportamento da Web.
const activeNotificationsByActionId = new Map();

ipcMain.handle('show-desktop-notification', async (event, payload = {}) => {
  try {
    if (!Notification.isSupported()) return { ok: false, error: 'Notificações não suportadas neste sistema.' };
    const title = String(payload.title || 'Chernobyl PT');
    const body = String(payload.body || '');
    const actionId = String(payload.actionId || '');
    const notification = new Notification({ title, body, silent: false });

    // Substitui a bolha anterior do MESMO evento (id estável), se houver.
    if (actionId) {
      const previous = activeNotificationsByActionId.get(actionId);
      if (previous && !previous.isDestroyed()) {
        try { previous.close(); } catch (_) {}
      }
      activeNotificationsByActionId.set(actionId, notification);
      notification.on('close', () => {
        // Só remove se ainda for ESTA notificação (uma mais nova pode ter
        // assumido a chave no meio tempo).
        if (activeNotificationsByActionId.get(actionId) === notification) {
          activeNotificationsByActionId.delete(actionId);
        }
      });
    }

    notification.on('click', () => {
      showAndFocusWindow();
      try {
        const target = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : event.sender;
        if (target && !target.isDestroyed()) {
          target.send('desktop-notification-click', { actionId });
        }
      } catch (_) {}
    });

    notification.show();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
});

// --- Rubinot Bazaar: navegadores disponíveis para o seletor ---
// Consultado pelo modal antes da consulta. Verifica cada mecanismo SEM abrir
// janela: para Chromium usa executablePath(), para Firefox/WebKit confirma que
// o binário do Playwright foi instalado.
ipcMain.handle('rubinot-bazaar-browsers', async () => {
  const list = [];
  for (const [key, info] of Object.entries(RUBINOT_BROWSERS)) {
    const probe = probeRubinotBrowserAvailability(key, info);
    list.push({ key, label: info.label, engine: info.engine, ...probe });
  }
  rubinotDiag('context', 'Navegadores disponíveis consultados pelo seletor.', {
    disponiveis: list.filter(b => b.available).map(b => b.key),
  });
  return { ok: true, browsers: list, selected: rubinotSelectedBrowser };
});

// --- Rubinot Bazaar: estado da sessão (somente metadados) ---
// Consultado pelo modal para exibir "Validada / Não validada / Expirada".
// Nunca lê valores de cookies nem credenciais.
ipcMain.handle('rubinot-bazaar-session-state', async (_event, payload = {}) => {
  const browserKey = resolveRubinotBrowserKey(payload?.browser);
  const info = RUBINOT_BROWSERS[browserKey];
  if (!info) return { ok: false, error: 'Navegador inválido.' };

  // Se o contexto já está aberto neste navegador, consulta direto.
  if (rubinotContext && rubinotContextBrowserKey === browserKey) {
    const state = await inspectRubinotSessionState(rubinotContext);
    return { ok: true, browser: browserKey, label: info.label, ...state };
  }

  // Sem contexto aberto: um perfil inexistente significa sessão não preparada.
  const profileDir = path.join(app.getPath('userData'), info.profile);
  if (!fs.existsSync(profileDir)) {
    return { ok: true, browser: browserKey, label: info.label, status: 'nao-validada', totalCookies: 0, looksAuthenticated: false, hasCfClearance: false, cfClearanceExpiresAt: 0, sessionCookiePersistent: false, cookieNames: [], sessionCookieNames: [] };
  }
  // O perfil existe, mas só dá para inspecionar cookies com o navegador aberto.
  return { ok: true, browser: browserKey, label: info.label, status: 'desconhecida', profileExists: true, totalCookies: 0, looksAuthenticated: false, hasCfClearance: false, cfClearanceExpiresAt: 0, sessionCookiePersistent: false, cookieNames: [], sessionCookieNames: [] };
});

// --- Rubinot Bazaar: preparar a sessão manualmente (rotina ÚNICA) ---
// Abre o navegador no RubinOT e DEIXA ABERTO para o usuário fazer login por
// conta própria. O app não digita, não lê e não guarda credencial alguma —
// apenas reaproveita, depois, os cookies que o próprio site gravou no perfil.
//
// ESTA é a rotina comprovadamente funcional de abertura do navegador para o
// RubinOT. Ela é usada PELO MENOS em dois pontos:
//   • IPC 'rubinot-bazaar-prepare-session' (BazaarBrowserModal);
//   • IPC 'autobid-connect' (AutoBidModal) — via injeção `prepareSession`.
// Centralizar evita que dois fluxos "de login manual" divirjam em comportamento
// (ex.: um abrir o navegador sem o init script e ficar preso no Cloudflare).
async function prepareRubinotSession(browserKey) {
  const normalized = resolveRubinotBrowserKey(browserKey);
  const info = RUBINOT_BROWSERS[normalized];
  if (!info) throw new Error('Navegador inválido.');

  // Abre o navegador no perfil PERSISTENTE e navega até o Bazaar — o fluxo
  // original de preparação de sessão do BazaarBrowserModal.
  //
  // Durante a implementação do Auto Bid, esta função passou a abrir em branco
  // sem navegar, e isso afetou a preparação de sessão da Consulta Bazaar. Com a
  // configuração de produção restaurada em getRubinotContext (init script +
  // opções estáveis), o fluxo original volta a navegar normalmente.
  const context = await getRubinotContext(normalized, false);
  const page = await getRubinotSessionPage(context);
  await page.goto(RUBINOT_BAZAAR_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  try { await page.bringToFront(); } catch (_) {}

  rubinotDiag('session', 'Navegador aberto para o usuário preparar a sessão manualmente.', { browser: normalized });
  return { ok: true, browser: normalized, label: info.label };
}

ipcMain.handle('rubinot-bazaar-prepare-session', async (_event, payload = {}) => {
  const browserKey = resolveRubinotBrowserKey(payload?.browser);
  try {
    return await prepareRubinotSession(browserKey);
  } catch (error) {
    const info = RUBINOT_BROWSERS[browserKey];
    const friendly = error?.browserUnavailable
      ? error.message
      : `Não foi possível abrir o ${info?.label || 'navegador'}: ${String(error?.message || error)}`;
    rubinotDiag('session', 'Falha ao abrir o navegador para preparar a sessão.', { browser: browserKey, error: String(error?.message || error) });
    return { ok: false, error: friendly, browserUnavailable: !!error?.browserUnavailable };
  }
});

// --- Rubinot Bazaar: confirmar a sessão preparada ---
// Chamado quando o usuário avisa que terminou o login. Só verifica metadados.
ipcMain.handle('rubinot-bazaar-confirm-session', async (_event, payload = {}) => {
  const browserKey = resolveRubinotBrowserKey(payload?.browser);
  if (!rubinotContext || rubinotContextBrowserKey !== browserKey) {
    return { ok: false, error: 'O navegador da preparação não está mais aberto.' };
  }
  const state = await inspectRubinotSessionState(rubinotContext);
  rubinotDiag('session', 'Sessão confirmada pelo usuário.', {
    browser: browserKey, status: state.status,
    // Só nomes, nunca valores.
    cookies: state.cookieNames.length, autenticada: state.looksAuthenticated,
    cfClearance: state.hasCfClearance,
  });
  return { ok: true, browser: browserKey, ...state };
});

// --- Rubinot Bazaar: limpar a sessão (cookies/cache/storage) de um navegador ---
// Só roda mediante confirmação explícita do usuário na interface. Apaga apenas
// o diretório de perfil DAQUELE mecanismo — nunca dados do navegador pessoal.
ipcMain.handle('rubinot-bazaar-clear-session', async (_event, payload = {}) => {
  const browserKey = resolveRubinotBrowserKey(payload?.browser);
  const info = RUBINOT_BROWSERS[browserKey];
  if (!info) return { ok: false, error: 'Navegador inválido.' };

  try {
    // O perfil não pode ser apagado com o navegador aberto.
    await closeRubinotBrowser('limpar-sessao');

    const profileDir = path.join(app.getPath('userData'), info.profile);
    if (!fs.existsSync(profileDir)) {
      rubinotDiag('context', 'Nada a limpar: o perfil ainda não existe.', { browser: browserKey, profileDir });
      return { ok: true, cleared: false, browser: browserKey, label: info.label };
    }

    fs.rmSync(profileDir, { recursive: true, force: true });
    rubinotDiag('context', 'Sessão do Bazaar limpa a pedido do usuário.', { browser: browserKey, profileDir });
    return { ok: true, cleared: true, browser: browserKey, label: info.label };
  } catch (error) {
    rubinotDiag('context', 'Falha ao limpar a sessão do Bazaar.', { browser: browserKey, error: String(error?.message || error) });
    return { ok: false, error: String(error?.message || error) };
  }
});

// --- Rubinot Bazaar: consulta manual via Playwright ---
ipcMain.handle('rubinot-bazaar-fetch', async (event, payload = {}) => {
  // O navegador escolhido no modal vale para toda a consulta (listagem +
  // detalhes), então é guardado no estado do processo principal.
  rubinotSelectedBrowser = resolveRubinotBrowserKey(payload?.browser);
  // Limite de encerramento (epoch em segundos) que habilita a parada antecipada.
  const endUntilTs = Number(payload?.endUntilTs || 0);
  // Perfil limpo vale para toda a consulta (listagem + detalhes).
  rubinotUseCleanProfile = payload?.cleanProfile === true;
  // Modo de velocidade vale para TODA a consulta, inclusive os retries.
  rubinotSpeedMode = resolveRubinotSpeedMode(payload?.speedMode);
  // Cadeia de retry já resolvida aqui: assim o painel de progresso mostra a
  // configuração desde a listagem, antes da análise individual começar.
  rubinotRunRetrySelection = buildRubinotRetryChain(
    rubinotSelectedBrowser, payload?.retryBrowsers, payload?.browserOrder,
  );
  // Plano com a QUANTIDADE de retries de cada navegador — é ele que o painel
  // de progresso exibe e que a análise individual executa depois.
  rubinotRunRetryPlan = buildRubinotRetryPlan(
    rubinotSelectedBrowser, payload?.retryBrowsers, payload?.retryCounts, payload?.browserOrder,
  );
  rubinotRunPendingSteps = [];
  // Consulta nova começa sempre sem pedido de encerramento pendente.
  resetRubinotManualStop();
  rubinotDiag('context', 'Configuração desta consulta.', {
    modo: rubinotSpeedMode,
    intervaloEntrePersonagensMs: speed().detailsGapMs,
    retry: rubinotRunRetryPlan.length > 0
      ? rubinotRunRetryPlan.map(step => `${step.browser} ${step.attempt}/${step.attempts}`)
      : '(nenhum)',
  });
  return runRubinotQueued('bazaar-fetch', () => fetchRubinotBazaarWithPlaywright(event.sender, rubinotSelectedBrowser, endUntilTs, rubinotUseCleanProfile));
});

// --- Rubinot Bazaar: detalhes sob demanda por personagem ---
ipcMain.handle('rubinot-bazaar-details', async (event, auctions, options = {}) => {
  const merged = { ...(options || {}), cleanProfile: rubinotUseCleanProfile };
  return runRubinotQueued('bazaar-details', () => fetchRubinotDetailsWithPlaywright(Array.isArray(auctions) ? auctions : [], merged, event.sender, rubinotSelectedBrowser));
});

// ============================================================================
// MÉTODO NOVO DE CONSULTA — registro do módulo isolado
// ----------------------------------------------------------------------------
// Único ponto de contato com o método novo. Tudo o que ele faz vive em
// `electron-bazaar-new.cjs`; aqui apenas INJETAMOS as funções que já existem
// acima, sem alterar nenhuma delas.
//
// O handler antigo (`rubinot-bazaar-details`, logo acima) permanece
// byte-a-byte como estava. Com o método "Antigo" selecionado, nada deste
// módulo é executado.
// ============================================================================
require('./electron-bazaar-new.cjs').registerBazaarNewMethod({
  ipcMain,
  diag: rubinotDiag,
  runQueued: runRubinotQueued,
  getContext: getRubinotContext,
  ensureSessionReady: ensureRubinotSessionReady,
  getSessionPage: getRubinotSessionPage,
  fetchJsonDetailed: fetchRubinotJsonDetailed,
  normalizeAuctionUrl: normalizeRubinotAuctionUrl,
  resolveQuestScope: resolveRubinotQuestScope,
  resolveBrowserKey: resolveRubinotBrowserKey,
  isManualStopRequested: isRubinotManualStopRequested,
  sendProgress: sendRubinotProgress,
  buildProgress: buildRubinotProgress,
  fetchDetailsWithPlaywright: fetchRubinotDetailsWithPlaywright,
  getSelectedBrowser: () => rubinotSelectedBrowser,
  getUseCleanProfile: () => rubinotUseCleanProfile,
  apiBase: RUBINOT_BAZAAR_API,
});

// ============================================================================
// AUTO BID — registro do módulo isolado
// ----------------------------------------------------------------------------
// Único ponto de contato com a função Auto Bid. Tudo o que ela faz vive em
// `electron-autobid.cjs`; aqui apenas INJETAMOS a inspeção segura de sessão
// que já existe acima. Nada do fluxo de consulta é alterado.
// ============================================================================
require('./electron-autobid.cjs').registerAutoBid({
  ipcMain,
  diag: rubinotDiag,
  inspectSessionState: inspectRubinotSessionState,
  defaultMode: 'cdp',
  modes: {
    cdp: require('./electron-autobid-cdp.cjs').registerCdpMode({
      diag: rubinotDiag,
      inspectSessionState: inspectRubinotSessionState,
      resolveExecutable: resolveRubinotBrowserExecutablePath,
      getUserDataPath: () => app.getPath('userData'),
      ensureDir: (dir) => { try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {} },
      defaultPort: 9222,
    }),
  },
});

// --- Rubinot Bazaar: estado atual do progresso para reconstruir UI após trocar de painel ---
ipcMain.handle('rubinot-bazaar-current-progress', async () => {
  return rubinotProgressState;
});

// --- Rubinot Bazaar: encerramento completo do navegador Playwright ---
// --- Rubinot Bazaar: encerrar a consulta AGORA, preservando o que já foi feito ---
//
// NÃO fecha o navegador nem aborta nada aqui: apenas liga uma bandeira. O laço
// da análise a consulta no próximo ponto seguro e encerra sozinho, devolvendo
// `ok: true` com os personagens já analisados. É o que garante que nenhuma
// gravação seja cortada pela metade e que o estado não fique corrompido.
ipcMain.handle('rubinot-bazaar-request-stop', async () => {
  try {
    requestRubinotManualStop();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
});

ipcMain.handle('rubinot-bazaar-close-browser', async (_event, reason = 'renderer-finally') => {
  return runRubinotQueued('bazaar-close-browser', () => closeRubinotBrowser(reason));
});

// --- Preferência: Fechar para a bandeja ---
ipcMain.handle('set-close-to-tray', (_event, value) => {
  closeToTray = !!value;
  return { ok: true };
});

// --- Preferência: Iniciar com o Windows ---
ipcMain.handle('set-start-with-windows', (_event, enabled) => {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      args: enabled ? ['--start-minimized'] : [],
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
});

// --- Abre a calculadora padrão do Windows ---
ipcMain.handle('open-windows-calc', async () => {
  try {
    if (process.platform === 'win32') {
      execFile('calc.exe', [], (error) => {
        if (error) console.error('Erro ao abrir calculadora:', error);
      });
      return { ok: true };
    }
    return { ok: false, error: 'Disponível apenas no Windows.' };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
});

// --- Trazer a janela principal para frente ---
ipcMain.handle('focus-window', async () => {
  try {
    showAndFocusWindow();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
});

// --- Trazer uma JANELA FILHA (Câmbio, etc.) para frente ---
//
// Chamado quando o usuário clica de novo no botão que abriu a janela. O
// `window.focus()` do renderer não dá conta sozinho: ele não restaura uma
// janela minimizada nem a levanta acima de outros programas no Windows.
//
// A janela é identificada pelo TÍTULO, o mesmo que o renderer gravou em
// `document.title`. Sem título casando, nada acontece — nunca focamos uma
// janela ao acaso.
ipcMain.handle('focus-child-window', async (_event, payload = {}) => {
  const wanted = String(payload?.title || '').trim();
  if (!wanted) return { ok: false, error: 'Título não informado.' };

  try {
    for (const win of childWindows) {
      if (!win || win.isDestroyed()) continue;

      let title = '';
      try { title = String(win.getTitle() || '').trim(); } catch (_) { continue; }
      if (title !== wanted) continue;

      // Mesma sequência de `showAndFocusWindow`, sem o `maximize()`: a janela
      // do conversor tem tamanho próprio e maximizá-la seria intrusivo.
      if (win.isMinimized()) win.restore();
      if (!win.isVisible()) win.show();
      win.focus();
      return { ok: true };
    }
    return { ok: false, error: 'Janela não encontrada.' };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
});

// --- Escolher onde salvar o arquivo de auto-save ---
ipcMain.handle('configure-autosave', async (_event, defaultPath = 'ChernobylTeam-AutoSave.json') => {
  const result = await dialog.showSaveDialog({
    title: 'Configurar Auto-Save',
    defaultPath,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (result.canceled || !result.filePath) return null;
  return result.filePath;
});

// --- Salvar dados no arquivo de auto-save ---
ipcMain.handle('write-autosave', async (_event, filePath, content) => {
  try {
    fs.writeFileSync(filePath, content, 'utf-8');
    return true;
  } catch {
    return false;
  }
});

// --- Abrir a pasta do arquivo no explorador ---
ipcMain.handle('open-file-location', (_event, filePath) => {
  if (filePath) shell.showItemInFolder(filePath);
});

// --- Versão atual do aplicativo ---
ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

// ============================================================================
// AUTO-UPDATER — Verificação de atualizações via GitHub Releases
// ============================================================================
autoUpdater.logger = console;
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

// --- Eventos do autoUpdater — envia progresso para o renderer ---
autoUpdater.on('checking-for-update', () => {
  try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-status', { status: 'checking' }); } catch {}
});

autoUpdater.on('update-available', (info) => {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-status', {
        status: 'available',
        version: info.version,
      });
    }
  } catch {}
});

autoUpdater.on('update-not-available', () => {
  try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-status', { status: 'up-to-date' }); } catch {}
});

autoUpdater.on('download-progress', (progress) => {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-status', {
        status: 'downloading',
        version: autoUpdater.updateInfo?.version,
        percent: Math.floor(progress.percent),
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond,
      });
    }
  } catch {}
});

autoUpdater.on('update-downloaded', () => {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-status', {
        status: 'downloaded',
        version: autoUpdater.updateInfo?.version,
      });
    }
  } catch {}
});

autoUpdater.on('error', (err) => {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-status', {
        status: 'error',
        message: err?.message || 'Erro desconhecido ao verificar atualização.',
      });
    }
  } catch {}
});

// --- IPC: Instalar atualização e reiniciar ---
ipcMain.handle('install-update', async () => {
  try {
    autoUpdater.quitAndInstall();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
});

// ============================================================================
// CICLO DE VIDA DO APP
// ============================================================================

// Detectar se foi iniciado com --start-minimized (login automático do Windows)
if (process.argv.includes('--start-minimized')) {
  startMinimized = true;
}

app.on('before-quit', () => {
  app.isQuitting = true;
});

app.whenReady().then(() => {
  // OBS.: aqui existia um protocol.interceptFileProtocol('file', ...) que
  // reescrevia caminhos absolutos ("/bazar-bg.png") para dentro de dist/.
  // Era um paliativo e não era confiável dentro do app.asar, pois dependia
  // de fs.existsSync sobre um caminho empacotado.
  //
  // A causa raiz foi corrigida na origem: as imagens passaram a ser
  // importadas pelo Vite e o bundle usa base "./", gerando caminhos
  // relativos válidos tanto em http:// quanto em file://. Interceptar o
  // protocolo deixou de ser necessário e só mascararia regressões.

  // ── PERMISSÃO DE NOTIFICAÇÕES DO RENDERER ─────────────────────────────
  // Sem handler explícito, o Chromium pode reportar 'denied' para
  // Notification.permission no renderer — o que fazia checkPermission() e
  // registerPushForUser() desistirem silenciosamente e o FALLBACK de
  // exibição (new Notification no renderer) nunca rodar. Como TODO o
  // conteúdo do app é nosso, aprovar as permissões (o comportamento do
  // Electron sem handler é aprovar; aqui garantimos também as
  // notificações). O caminho PRIMÁRIO segue sendo o IPC
  // 'show-desktop-notification' (Notification do processo principal).
  try {
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(true);
    });
    session.defaultSession.setPermissionCheckHandler((_webContents, _permission) => true);
  } catch (error) {
    console.warn('[Permissões] falha ao configurar handlers de permissão:', error);
  }

  createTray();
  createWindow();

  // Verificar atualizações automaticamente ao abrir (apenas em produção)
  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});