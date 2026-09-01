// Utilitário para abrir links externos no navegador padrão do sistema.
//
// - Electron: usa shell.openExternal via IPC (abre no navegador padrão do SO,
//   em vez de criar uma nova janela do próprio aplicativo).
// - Navegador: usa window.open com target="_blank" (comportamento web padrão).
//
// Uso: openExternalUrl("https://www.twitch.tv/canal")
//      openExternalUrl("https://wa.me/5511999999999")

const _isElectron = typeof window !== "undefined" && !!(window as any).require;

export function openExternalUrl(url: string): void {
  if (!url) return;

  if (_isElectron) {
    try {
      const { shell } = (window as any).require("electron");
      shell.openExternal(url);
      return;
    } catch {
      // Fallback: se shell não estiver disponível (ex: contextIsolation),
      // tenta via ipcRenderer
      try {
        const { ipcRenderer } = (window as any).require("electron");
        ipcRenderer.invoke("open-external-url", url);
        return;
      } catch {
        // Último fallback: abre como web
      }
    }
  }

  // Navegador padrão ou fallback
  window.open(url, "_blank", "noopener,noreferrer");
}
