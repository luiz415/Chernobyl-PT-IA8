import { useLayoutEffect, type RefObject } from "react";

/**
 * Mantém os limites físicos ocupados pelo cabeçalho e pelo rodapé da aplicação
 * disponíveis para todos os modais, inclusive os renderizados em `document.body`
 * por React Portal. As variáveis ficam no `<html>` para que não dependam da
 * árvore React que originou cada modal.
 */
const TOP_INSET_VARIABLE = "--app-modal-top-inset";
const BOTTOM_INSET_VARIABLE = "--app-modal-bottom-inset";

function resetModalViewportBounds(root: HTMLElement) {
  root.style.removeProperty(TOP_INSET_VARIABLE);
  root.style.removeProperty(BOTTOM_INSET_VARIABLE);
}

function toCssPixels(value: number): string {
  // Evita ruído de subpixels sem perder a precisão visual necessária para zoom.
  return `${Math.round(value * 100) / 100}px`;
}

export function useModalViewportBounds(
  headerRef: RefObject<HTMLElement | null>,
  footerRef: RefObject<HTMLElement | null>,
  enabled: boolean,
) {
  useLayoutEffect(() => {
    const root = document.documentElement;
    let animationFrame: number | null = null;

    const syncBounds = () => {
      animationFrame = null;

      const header = headerRef.current;
      const footer = footerRef.current;
      if (!enabled || !header || !footer) {
        resetModalViewportBounds(root);
        return;
      }

      // `getBoundingClientRect()` e visualViewport usam as mesmas coordenadas
      // visuais de elementos fixed, inclusive quando há zoom do navegador.
      const viewportHeight = window.visualViewport?.height || window.innerHeight;
      if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) {
        resetModalViewportBounds(root);
        return;
      }

      const clampToViewport = (value: number) => Math.max(0, Math.min(viewportHeight, value));
      const headerBounds = header.getBoundingClientRect();
      const footerBounds = footer.getBoundingClientRect();
      const topInset = clampToViewport(headerBounds.bottom);
      const bottomInset = clampToViewport(viewportHeight - footerBounds.top);

      root.style.setProperty(TOP_INSET_VARIABLE, toCssPixels(topInset));
      root.style.setProperty(BOTTOM_INSET_VARIABLE, toCssPixels(bottomInset));
    };

    const scheduleSync = () => {
      if (animationFrame !== null) return;
      animationFrame = window.requestAnimationFrame(syncBounds);
    };

    syncBounds();

    const header = headerRef.current;
    const footer = footerRef.current;
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(scheduleSync);
    if (header) resizeObserver?.observe(header);
    if (footer) resizeObserver?.observe(footer);

    window.addEventListener("resize", scheduleSync);
    const visualViewport = window.visualViewport;
    visualViewport?.addEventListener("resize", scheduleSync);
    visualViewport?.addEventListener("scroll", scheduleSync);

    return () => {
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleSync);
      visualViewport?.removeEventListener("resize", scheduleSync);
      visualViewport?.removeEventListener("scroll", scheduleSync);
      resetModalViewportBounds(root);
    };
  }, [enabled, footerRef, headerRef]);
}