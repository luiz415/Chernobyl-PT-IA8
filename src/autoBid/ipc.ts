import type { AutoBidExecuteResult, AutoBidMode } from "./types";

// ============================================================================
// AUTO BID — ponte IPC (renderer ↔ processo principal)
// ----------------------------------------------------------------------------
// Envolve `window.require("electron").ipcRenderer`. Retorna `null` quando não
// há Electron (versão Web) — nesse caso o Auto Bid nunca é oferecido.
//
// Todas as chamadas enviam o `mode` selecionado, que é roteado no processo
// principal para o modo isolado correspondente.
// ============================================================================

function ipc(): any | null {
  try {
    const electronRequire = (window as any).require;
    if (!electronRequire) return null;
    const { ipcRenderer } = electronRequire("electron");
    return ipcRenderer || null;
  } catch {
    return null;
  }
}

export function isElectronRuntime(): boolean {
  return ipc() !== null;
}

export async function getModes(): Promise<{ modes: { key: string; label: string }[]; defaultMode: string } | null> {
  const r = ipc();
  if (!r) return null;
  return r.invoke("autobid-modes");
}

export async function connectBrowser(mode: AutoBidMode, browser: string): Promise<{ ok: boolean; error?: string } | null> {
  const r = ipc();
  if (!r) return null;
  return r.invoke("autobid-connect", { mode, browser });
}

export async function sessionState(mode: AutoBidMode, browser: string): Promise<any | null> {
  const r = ipc();
  if (!r) return null;
  return r.invoke("autobid-session-state", { mode, browser });
}

/** Consulta leve: o navegador do Auto Bid está aberto/conectado? Não toca
 *  cookies/DOM/CDP — apenas lê a referência do navegador no processo principal.
 *  Usado pelo engine para decidir se há motivo para monitorar a sessão. */
export async function isBrowserOpen(mode: AutoBidMode, browser: string): Promise<boolean> {
  const r = ipc();
  if (!r) return false;
  try {
    const res = await r.invoke("autobid-browser-open", { mode, browser });
    return !!(res && res.open);
  } catch {
    return false;
  }
}

export async function disconnectBrowser(mode: AutoBidMode, reason?: string): Promise<void> {
  const r = ipc();
  if (!r) return;
  await r.invoke("autobid-disconnect", { mode, reason });
}

export async function executeBid(payload: {
  mode: AutoBidMode;
  browser: string;
  bidUrl: string;
  auctionId: string;
  auctionEndTs: number;
}): Promise<AutoBidExecuteResult | null> {
  const r = ipc();
  if (!r) return null;
  return r.invoke("autobid-execute-bid", payload);
}

/** Assina eventos de conexão vindos do processo principal. */
export function onConnection(listener: (event: any) => void): () => void {
  const r = ipc();
  if (!r) return () => {};
  r.on("autobid-connection", listener);
  return () => {
    try { r.removeListener("autobid-connection", listener); } catch { /* ignora */ }
  };
}