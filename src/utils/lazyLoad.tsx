import { Suspense, lazy, useEffect, useState } from "react";
import type { ComponentProps, ComponentType, ReactNode } from "react";

// ============================================================================
// CARREGAMENTO SOB DEMANDA (code-splitting) — otimização de performance
// ----------------------------------------------------------------------------
// O build web deixou de ser um arquivo único (vite-plugin-singlefile): cada
// área pesada vira um chunk próprio, baixado só quando o usuário a abre.
// Estes dois helpers preservam os PONTOS DE USO intactos — o componente
// continua sendo usado com o MESMO nome e as MESMAS props; muda apenas a
// forma de importar no topo do arquivo.
//
// No build do Electron (vite.config.electron.ts) os dynamic imports são
// EMBUTIDOS no arquivo único (inlineDynamicImports) — React.lazy resolve
// imediatamente e o comportamento instalado permanece o atual.
// ============================================================================

/** Spinner padrão exibido enquanto o chunk de um painel/guia carrega. */
export function PanelLoadingFallback() {
  return (
    <div className="flex items-center justify-center py-16" role="status" aria-label="Carregando...">
      <div className="w-6 h-6 border-2 border-slate-600 border-t-slate-300 rounded-full animate-spin" />
    </div>
  );
}

/**
 * Componente lazy para áreas renderizadas CONDICIONALMENTE (guias/painéis:
 * `{tab === "x" && <Painel/>}`). O chunk só é baixado quando o ponto de uso
 * monta; o fallback aparece apenas durante o primeiro carregamento (depois o
 * módulo fica em cache de módulo — trocas de guia seguintes são imediatas).
 */
export function lazyWithSuspense<T extends ComponentType<any>>(
  loader: () => Promise<{ default: T }>,
  fallback: ReactNode = null,
): ComponentType<ComponentProps<T>> {
  const Lazy = lazy(loader);
  return function LazyWithSuspense(props: ComponentProps<T>) {
    return (
      <Suspense fallback={fallback}>
        <Lazy {...(props as any)} />
      </Suspense>
    );
  };
}

/**
 * Componente lazy para MODAIS PERMANENTEMENTE MONTADOS com prop `open`
 * (`<Modal open={x}/>`). Antes, esses modais entravam no bundle inicial e
 * participavam de TODO re-render do App mesmo fechados. Agora:
 *   • antes da 1ª abertura: nada é montado e o chunk NEM É BAIXADO;
 *   • na 1ª abertura: o chunk carrega e o modal monta;
 *   • após a 1ª abertura: permanece montado para sempre (LATCH) — preserva
 *     EXATAMENTE a semântica anterior de estado interno entre aberturas
 *     (os efeitos desses modais já são todos condicionados a `open`).
 */
export function lazyModal<T extends ComponentType<any>>(
  loader: () => Promise<{ default: T }>,
): ComponentType<ComponentProps<T> & { open: boolean }> {
  const Lazy = lazy(loader);
  return function LazyModal(props: ComponentProps<T> & { open: boolean }) {
    const [everOpened, setEverOpened] = useState<boolean>(!!props.open);
    useEffect(() => {
      if (props.open && !everOpened) setEverOpened(true);
    }, [props.open, everOpened]);
    if (!props.open && !everOpened) return null;
    return (
      <Suspense fallback={null}>
        <Lazy {...(props as any)} />
      </Suspense>
    );
  };
}
