import type { AutoBidConfig, AutoBidRecord, AutoBidStatus } from "./types";

// ============================================================================
// AUTO BID — persistência
// ----------------------------------------------------------------------------
// Salva as configurações de Auto Bid, o ledger anti-duplicado, a escolha de
// navegador e o histórico de tentativas em `localStorage`. NUNCA armazena
// senha, token de sessão ou valores de cookie — o login permanece 100% no
// navegador/perfil persistente do processo principal.
//
// A config sobrevive a troca de aba e a reinício do app; o ledger impede que um
// lance seja re-executado após reiniciar; o histórico alimenta o quadro
// "Últimos Auto Bids".
// ============================================================================

const CONFIG_KEY = "auto_bid_configs_v1";
const LEDGER_KEY = "auto_bid_ledger_v1";
const BROWSER_KEY = "auto_bid_browser_v1";
const HISTORY_KEY = "auto_bid_history_v1";
const MODE_KEY = "auto_bid_mode_v1";

/** Máximo de registros mantidos no quadro "Últimos Auto Bids". */
export const HISTORY_LIMIT = 30;

/**
 * Modos de execução do Auto Bid. Cada modo é isolado no processo principal e
 * pode ser testado manualmente. Inicialmente existe apenas o modo CDP.
 */
export const AUTO_BID_MODES: { key: string; label: string; description: string }[] = [
  {
    key: "cdp",
    label: "CDP",
    description: "Conecta a um navegador real (Chrome/Edge) já autenticado pelo usuário via DevTools Protocol.",
  },
];
export const AUTO_BID_DEFAULT_MODE = "cdp";

/** Persistência do último modo selecionado. */
export function loadMode(): string {
  const saved = storageGet(MODE_KEY);
  return AUTO_BID_MODES.some(m => m.key === saved) ? (saved as string) : AUTO_BID_DEFAULT_MODE;
}

export function saveMode(key: string): void {
  storageSet(MODE_KEY, AUTO_BID_MODES.some(m => m.key === key) ? key : AUTO_BID_DEFAULT_MODE);
}

/** Navegadores aceitos por um modo (CDP só funciona com Chromium). */
export function browsersForMode(mode: string): { key: string; label: string }[] {
  if (mode === "cdp") {
    return AUTO_BID_BROWSERS.filter(b => b.key === "chrome" || b.key === "edge");
  }
  return AUTO_BID_BROWSERS;
}

/** Navegadores realmente suportados pela arquitetura (mesmos do Bazaar). */
export const AUTO_BID_BROWSERS: { key: string; label: string }[] = [
  { key: "webkit", label: "WebKit" },
  { key: "firefox", label: "Firefox" },
  { key: "edge", label: "Microsoft Edge" },
  { key: "chrome", label: "Google Chrome" },
];
export const AUTO_BID_DEFAULT_BROWSER = "webkit";

/** Chave única de execução: versão + id + fim (segundos). */
export function executionKey(config: Pick<AutoBidConfig, "auctionId" | "auctionEndTs">): string {
  return `${config.auctionId}|${config.auctionEndTs}`;
}

/** Chave de identidade de um item (independente do fim, para merge). */
export function itemKey(config: Pick<AutoBidConfig, "auctionId">): string {
  return config.auctionId;
}

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Leitura de `localStorage` que nunca lança (ausente em Node/testes). */
function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // localStorage indisponível (quota / Node): segue sem persistir.
  }
}

// ---------------------------------------------------------------------------
// Configurações
// ---------------------------------------------------------------------------
export function loadConfigs(): AutoBidConfig[] {
  return safeParse<AutoBidConfig[]>(storageGet(CONFIG_KEY), []);
}

export function saveConfigs(configs: AutoBidConfig[]): void {
  storageSet(CONFIG_KEY, JSON.stringify(configs));
}

/**
 * Atualiza (upsert) a configuração de um personagem. Usa o `auctionId` como
 * identidade estável. Mantém `lastResult`/`executedAtMs` quando só o valor,
 * os segundos ou o estado mudam.
 */
export function upsertConfig(patch: Partial<AutoBidConfig> & { auctionId: string }): AutoBidConfig[] {
  const configs = loadConfigs();
  const index = configs.findIndex(c => c.auctionId === patch.auctionId);
  if (index >= 0) {
    configs[index] = { ...configs[index], ...patch };
  } else {
    configs.push(patch as AutoBidConfig);
  }
  saveConfigs(configs);
  return configs;
}

export function removeConfig(auctionId: string): AutoBidConfig[] {
  const configs = loadConfigs().filter(c => c.auctionId !== auctionId);
  saveConfigs(configs);
  return configs;
}

/**
 * Mescla a lista oficial (interesses) com as configs salvas, mantendo a config
 * do usuário mas atualizando horário final/nome/servidor/vocação/url quando a
 * lista oficial mudar.
 */
/**
 * Mescla a lista oficial (interesses) com as configs salvas, mantendo a config
 * do usuário mas atualizando horário final/nome/servidor/vocação/url quando a
 * lista oficial mudar.
 *
 * FUNÇÃO PURA — NÃO escreve no localStorage. (Antes ela chamava `saveConfigs`
 * em cada chamada, o que causava gravação + re-render a cada tecla/segundo.)
 * A persistência fica a cargo do chamador, que decide quando gravar.
 */
export function mergeWithOfficial(
  configs: AutoBidConfig[],
  official: Array<{ id: string; name: string; server: string; vocation: string; url: string; auctionEndTs: number | null }>,
  bazaarVersion: string,
): AutoBidConfig[] {
  const byId = new Map(configs.map(c => [itemKey(c), c]));
  official.forEach(o => {
    if (!o.id || !o.auctionEndTs) return;
    const existing = byId.get(o.id);
    if (!existing) {
      byId.set(o.id, {
        auctionId: o.id,
        bazaarVersion,
        name: o.name,
        server: o.server,
        vocation: o.vocation,
        url: o.url,
        auctionEndTs: o.auctionEndTs,
        bidAmount: 0,
        secondsBefore: 15,
        active: false,
      });
      return;
    }
    byId.set(o.id, {
      ...existing,
      auctionId: o.id,
      bazaarVersion,
      name: o.name,
      server: o.server,
      vocation: o.vocation,
      url: o.url,
      // Novo fim = novo leilão: zera o "já executado" deste fim via chave nova.
      auctionEndTs: o.auctionEndTs,
    });
  });
  return [...byId.values()];
}

// ---------------------------------------------------------------------------
// Ledger anti-duplicado
// ---------------------------------------------------------------------------
/**
 * O ledger guarda as chaves de execução já concluídas. Persistido para impedir
 * re-execução após reinício. Um item "prorrogado" (novo `auctionEndTs`) recebe
 * uma chave nova e é rearmado naturalmente.
 */
export function loadLedger(): Record<string, number> {
  return safeParse<Record<string, number>>(storageGet(LEDGER_KEY), {});
}

export function markExecuted(key: string, atMs = Date.now()): void {
  try {
    const ledger = loadLedger();
    ledger[key] = atMs;
    storageSet(LEDGER_KEY, JSON.stringify(ledger));
  } catch {
    // sem persistência: a guarda em memória do processo principal cobre.
  }
}

export function isExecuted(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(loadLedger(), key);
}

/** Limpa configurações e ledger (não exposto por padrão; útil para testes). */
export function clearAll(): void {
  try {
    localStorage.removeItem(CONFIG_KEY);
    localStorage.removeItem(LEDGER_KEY);
    localStorage.removeItem(BROWSER_KEY);
    localStorage.removeItem(HISTORY_KEY);
    localStorage.removeItem(MODE_KEY);
  } catch {
    // ignora
  }
}

// ---------------------------------------------------------------------------
// Navegador selecionado (persistido para as próximas aberturas)
// ---------------------------------------------------------------------------
export function loadBrowser(): string {
  const saved = storageGet(BROWSER_KEY);
  if (saved && AUTO_BID_BROWSERS.some(b => b.key === saved)) return saved;
  return AUTO_BID_DEFAULT_BROWSER;
}

export function saveBrowser(key: string): void {
  const normalized = AUTO_BID_BROWSERS.some(b => b.key === key) ? key : AUTO_BID_DEFAULT_BROWSER;
  storageSet(BROWSER_KEY, normalized);
}

export function browserLabel(key: string): string {
  const found = AUTO_BID_BROWSERS.find(b => b.key === key);
  return found ? found.label : key;
}

// ---------------------------------------------------------------------------
// Histórico de tentativas ("Últimos Auto Bids")
// ---------------------------------------------------------------------------
export function loadHistory(): AutoBidRecord[] {
  return safeParse<AutoBidRecord[]>(storageGet(HISTORY_KEY), []);
}

/**
 * Adiciona um registro ao histórico (mais recente primeiro) e limita a
 * `HISTORY_LIMIT` entradas.
 */
export function addHistory(record: AutoBidRecord): AutoBidRecord[] {
  const history = loadHistory();
  const entry: AutoBidRecord = {
    ...record,
    atMs: record.atMs || Date.now(),
    status: record.status,
    browser: record.browser,
  };
  const next = [entry, ...history].slice(0, HISTORY_LIMIT);
  storageSet(HISTORY_KEY, JSON.stringify(next));
  return next;
}

/** Estados que entram no histórico de tentativas (exclui "configurado"/"aguardando"). */
export const HISTORY_STATUSES: ReadonlySet<AutoBidStatus> = new Set([
  "concluido",
  "falhou",
  "cancelado",
  "desconectado",
  "executando",
]);