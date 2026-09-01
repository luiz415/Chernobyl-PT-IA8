// ============================================================================
// AUTO BID — orquestrador de modos (processo principal)
// ----------------------------------------------------------------------------
// Exclusivo da função Auto Bid do Bazaar. Totalmente independente do sistema
// de consulta (método antigo/novo), filtros, Interesse, coluna Bid, lista
// oficial, Firestore e da versão Web.
//
// Este arquivo é um DESPACHADOR: registra os handlers IPC e roteia cada
// operação para o MODO de execução selecionado (atualmente apenas "cdp").
// Cada modo é um módulo isolado, permitindo testar manualmente um por um.
//
// Responsabilidades comuns (independentes do modo):
//   • executor serial (um lance por vez);
//   • anti-duplicado em memória;
//   • notificação de estado de conexão ao renderer.
//
// O login é sempre MANUAL, feito pelo usuário no navegador real. Nenhuma
// credencial é lida, digitada ou armazenada. Nenhuma técnica de stealth/bypass.
//
// O registro no `electron-main.cjs` é de um `require` + uma chamada
// (`registerAutoBid`).
// ============================================================================

'use strict';

let deps = null;

// ============================================================================
// Estado do orquestrador
// ============================================================================
let connectionSender = null;
let autoBidQueue = Promise.resolve();
const executingKeys = new Set();
const executedKeys = new Set();

// ============================================================================
// Helpers
// ============================================================================
function diag(scope, message, data = {}) {
  try { deps.diag(`AutoBid:${scope}`, message, data); }
  catch (_) { try { deps.diag(`AutoBid:${scope}`, message); } catch (__) {} }
}

function notifyConnection(state, detail = '') {
  try {
    if (connectionSender && !connectionSender.isDestroyed()) {
      connectionSender.send('autobid-connection', { state, detail, at: Date.now() });
    }
  } catch (_) {}
}

function normalizeMode(value) {
  const key = String(value || '').trim().toLowerCase();
  return key === 'cdp' ? 'cdp' : deps.defaultMode || 'cdp';
}

function getMode(key) {
  const normalized = normalizeMode(key);
  const mode = deps.modes[normalized];
  if (!mode) throw new Error(`Modo de Auto Bid "${normalized}" não disponível.`);
  return mode;
}

function resolveExecKey(modeKey, payload) {
  return `${modeKey}|${String(payload?.browser || payload?.browserKey || '')}|${String(payload?.auctionId || '')}|${String(payload?.auctionEndTs ?? '')}`;
}

// ============================================================================
// Registro
// ============================================================================
function registerAutoBid(registration) {
  deps = {
    ipcMain: registration.ipcMain,
    diag: registration.diag,
    defaultMode: registration.defaultMode || 'cdp',
    modes: registration.modes || {},
    notify: notifyConnection,
    inspectSessionState: registration.inspectSessionState,
  };

  const { ipcMain } = deps;

  // ── Lista de modos disponíveis ──────────────────────────────────────────
  ipcMain.handle('autobid-modes', async () => {
    return { ok: true, modes: Object.values(deps.modes).map(m => ({ key: m.key, label: m.label })), defaultMode: deps.defaultMode };
  });

  // ── Abrir navegador / Conectar ──────────────────────────────────────────
  ipcMain.handle('autobid-connect', async (event, payload = {}) => {
    connectionSender = event.sender;
    const modeKey = normalizeMode(payload?.mode);
    const mode = getMode(modeKey);
    try {
      notifyConnection('conectando', 'Abrindo navegador...');
      const result = await mode.connect(payload);
      // A sessão define o estado final após abrir.
      const state = await mode.sessionState();
      const isConnected = state?.status === 'validada';
      notifyConnection(isConnected ? 'conectado' : 'desconectado', isConnected ? '' : 'Navegador aberto. Faça o login na janela.');
      return { ok: true, mode: modeKey, ...result, ...state };
    } catch (error) {
      const friendly = String(error?.message || error);
      notifyConnection('desconectado', friendly);
      return { ok: false, mode: modeKey, error: friendly };
    }
  });

  // ── Navegador aberto (sinal leve, sem tocar cookies/DOM/CDP) ───────────
  // Permite que o renderer só monitore a sessão quando houver navegador
  // aberto/conectando ou Auto Bid ativo — evita polling desnecessário.
  ipcMain.handle('autobid-browser-open', async (event, payload = {}) => {
    const modeKey = normalizeMode(payload?.mode);
    try {
      const mode = getMode(modeKey);
      const isOpen = typeof mode.isOpen === 'function' ? mode.isOpen() : false;
      return { ok: true, mode: modeKey, open: !!isOpen };
    } catch (error) {
      return { ok: false, mode: modeKey, open: false, error: String(error?.message || error) };
    }
  });

  // ── Estado da sessão ────────────────────────────────────────────────────
  ipcMain.handle('autobid-session-state', async (event, payload = {}) => {
    connectionSender = event.sender;
    const modeKey = normalizeMode(payload?.mode);
    try {
      const mode = getMode(modeKey);
      const state = await mode.sessionState();
      const connState = state?.status === 'validada' ? 'conectado'
        : state?.status === 'expirada' ? 'expirada'
          : 'desconectado';
      diag('session', 'Estado de sessão enviado ao renderer.', {
        connState, status: state?.status, source: state?.source || 'unknown',
        foundPage: state?.foundPage, markers: state?.markers, sessionCookies: state?.sessionCookieNames,
      });
      notifyConnection(connState, connState === 'validada' ? '' : '');
      return { ok: true, mode: modeKey, ...state };
    } catch (error) {
      return { ok: false, mode: modeKey, error: String(error?.message || error) };
    }
  });

  // ── Desconectar / cancelar ──────────────────────────────────────────────
  ipcMain.handle('autobid-disconnect', async (event, payload = {}) => {
    connectionSender = event.sender;
    const modeKey = normalizeMode(payload?.mode);
    try {
      const mode = getMode(modeKey);
      await mode.disconnect(payload);
      notifyConnection('desconectado', payload?.reason === 'usuario-solicitou' ? 'Desconectado pelo usuário.' : 'Desconectado.');
      return { ok: true, mode: modeKey };
    } catch (error) {
      return { ok: false, mode: modeKey, error: String(error?.message || error) };
    }
  });

  // ── Executar um lance (serial + anti-duplicado) ─────────────────────────
  ipcMain.handle('autobid-execute-bid', async (event, payload = {}) => {
    connectionSender = event.sender;
    const modeKey = normalizeMode(payload?.mode);
    const execKey = resolveExecKey(modeKey, payload);

    if (executingKeys.has(execKey)) return { ok: false, status: 'executando', detail: 'Já em execução.', mode: modeKey };
    if (executedKeys.has(execKey)) return { ok: false, status: 'concluido', detail: 'Lance já executado.', deduplicated: true, mode: modeKey };

    const task = async () => {
      executingKeys.add(execKey);
      try {
        const mode = getMode(modeKey);
        const result = await mode.executeBid(payload);
        if (result?.status === 'concluido') executedKeys.add(execKey);
        return result;
      } catch (error) {
        return { ok: false, status: 'falhou', detail: String(error?.message || error), mode: modeKey };
      } finally {
        executingKeys.delete(execKey);
      }
    };

    const queued = autoBidQueue.then(task, task);
    autoBidQueue = queued.catch(() => {});
    return queued;
  });

  diag('module', 'Auto Bid registrado (modo CDP).');
}

module.exports = { registerAutoBid };