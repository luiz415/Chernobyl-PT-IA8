import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { customAlert } from "../types";
import { useTheme } from "../theme/ThemeContext";
import { applyThemeToDocument } from "../theme/themes";

interface Props {
  open: boolean;
  onClose: () => void;
  title?: string;
  width?: number;
  height?: number;
  children: React.ReactNode;
  /**
   * Muda a cada clique no botão que abriu esta janela.
   *
   * Quando `open` já é `true`, alternar `open` não dispara efeito algum — o
   * React não re-executa um efeito cujo valor de dependência não mudou. Este
   * contador é o sinal de "o usuário pediu de novo", e é o que permite trazer
   * a janela existente para frente em vez de ignorar o clique.
   */
  focusSignal?: number;
}

// Só o Electron expõe `window.require` — mesmo critério usado em App.tsx,
// BazarPanel.tsx e utils/openExternal.ts.
const isElectron = typeof window !== "undefined" && !!(window as any).require;

/**
 * Traz a janela externa para frente.
 *
 * `win.focus()` sozinho é insuficiente no Electron/Windows: ele não restaura
 * uma janela minimizada nem a levanta acima de outros programas. Por isso,
 * no Electron, pedimos ao processo principal — que tem o objeto BrowserWindow
 * real e pode chamar `restore()`/`show()`/`focus()` de verdade.
 *
 * Na Web fica só o `win.focus()`, que é tudo que o navegador permite.
 */
function focusExternalWindow(win: Window | null, title: string) {
  if (!win || win.closed) return;

  // Sempre tenta pelo handle: na Web é o único caminho e no Electron não
  // atrapalha.
  try { win.focus(); } catch {}

  if (!isElectron) return;
  try {
    const { ipcRenderer } = (window as any).require("electron");
    ipcRenderer.invoke("focus-child-window", { title });
  } catch {}
}

export default function ExternalWindow({
  open,
  onClose,
  title = "Tibia Char Manager",
  width = 560,
  height = 620,
  children,
  focusSignal = 0,
}: Props) {
  const windowRef = useRef<Window | null>(null);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const { theme } = useTheme();
  /**
   * Identifica a instância atual da janela.
   *
   * Incrementá-lo re-executa o efeito de abertura, criando uma janela nova.
   * Serve para um caso de corrida real: o fechamento é detectado por sondagem
   * a cada 250 ms, então entre o usuário fechar a janela e o app perceber há
   * uma fresta em que `open` ainda é `true` mas a janela já morreu. Um clique
   * nessa fresta se perderia — aqui ele reabre.
   */
  const [instanceId, setInstanceId] = useState(0);

  useEffect(() => {
    if (!open) {
      if (windowRef.current && !windowRef.current.closed) {
        windowRef.current.close();
      }
      windowRef.current = null;
      setContainer(null);
      return;
    }

    // ── INSTÂNCIA ÚNICA ───────────────────────────────────────────────────
    // Se já existe uma janela viva, NÃO abrimos outra: só a trazemos para
    // frente. Sem esta guarda, qualquer re-execução do efeito (troca de tema,
    // StrictMode em desenvolvimento, remontagem) criaria uma segunda janela.
    if (windowRef.current && !windowRef.current.closed) {
      focusExternalWindow(windowRef.current, title);
      return;
    }

    const left = window.screenX + Math.round((window.outerWidth - width) / 2);
    const top = window.screenY + Math.round((window.outerHeight - height) / 2);

    const features = `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`;
    const newWin = window.open("", "", features);

    if (!newWin) {
      customAlert("Não foi possível abrir a janela da calculadora. Verifique se popups estão permitidos.");
      onClose();
      return;
    }

    windowRef.current = newWin;

    newWin.document.title = title;

    // Aplica o tema atual na janela externa antes de injetar os estilos,
    // para que os tokens (--th-*) resolvam já na primeira pintura.
    applyThemeToDocument(theme, newWin.document);

    const styleSheets = document.querySelectorAll('style, link[rel="stylesheet"]');
    styleSheets.forEach((node) => {
      newWin.document.head.appendChild(node.cloneNode(true));
    });

    const baseStyle = newWin.document.createElement("style");
    baseStyle.textContent = `
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body {
        background-color: var(--th-n-base);
        color: #e2e8f0;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        height: 100%;
        overflow: auto;
      }
      #calc-root { height: 100%; }
      ::-webkit-scrollbar { width: 8px; height: 8px; }
      ::-webkit-scrollbar-track { background: var(--th-n-panel); }
      ::-webkit-scrollbar-thumb { background: var(--th-n-track); border-radius: 4px; }
      ::-webkit-scrollbar-thumb:hover { background: var(--th-n-thumb); }

      .ipt {
        width: 100%;
        padding: 0.5rem 0.75rem;
        background: rgba(0,0,0,0.4);
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 0.5rem;
        font-size: 0.875rem;
        color: #e2e8f0;
        outline: none;
        transition: all 0.15s;
      }
      .ipt::placeholder { color: #475569; }
      .ipt:focus {
        border-color: rgba(16,185,129,0.5);
        box-shadow: 0 0 0 1px rgba(16,185,129,0.2);
      }

      input[type="date"] { color-scheme: dark; }
      input[type="date"]::-webkit-calendar-picker-indicator {
        filter: invert(0.7);
        cursor: pointer;
        padding: 0;
        margin-left: 4px;
      }
    `;
    newWin.document.head.appendChild(baseStyle);

    const div = newWin.document.createElement("div");
    div.id = "calc-root";
    newWin.document.body.appendChild(div);
    setContainer(div);

    const checkInterval = setInterval(() => {
      if (newWin.closed) {
        clearInterval(checkInterval);
        windowRef.current = null;
        setContainer(null);
        onClose();
        setTimeout(() => window.focus(), 50);
      }
    }, 250);

    return () => {
      clearInterval(checkInterval);
      if (newWin && !newWin.closed) {
        newWin.close();
      }
      windowRef.current = null;
      setContainer(null);
      setTimeout(() => window.focus(), 50);
    };
  }, [open, instanceId]);

  // ── CLIQUE REPETIDO NO BOTÃO ────────────────────────────────────────────
  // `focusSignal` muda a cada clique, inclusive quando `open` já era `true`.
  // É o único gatilho possível nesse caso: `open` continua `true`, então o
  // efeito de abertura não roda de novo.
  //
  // O `focusSignal > 0` evita focar na montagem inicial, quando ninguém
  // clicou em nada ainda.
  useEffect(() => {
    if (!open || focusSignal <= 0) return;

    // Janela já morreu, mas a sondagem ainda não percebeu: em vez de perder o
    // clique, reabre. `instanceId` novo força o efeito de abertura a rodar.
    const win = windowRef.current;
    if (!win || win.closed) {
      setInstanceId(value => value + 1);
      return;
    }

    focusExternalWindow(win, title);
  }, [focusSignal, open, title]);

  // Mantém a janela externa sincronizada quando o tema muda com ela aberta.
  useEffect(() => {
    const win = windowRef.current;
    if (!win || win.closed) return;
    try {
      applyThemeToDocument(theme, win.document);
    } catch {
      /* janela já fechada */
    }
  }, [theme, container]);

  if (!open || !container) return null;

  return createPortal(children, container);
}
