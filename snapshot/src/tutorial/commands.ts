// ============================================================================
// TUTORIAL — BARRAMENTO DE COMANDOS DE NAVEGAÇÃO
// ----------------------------------------------------------------------------
// O tutorial precisa navegar pelo app (trocar janela, guia, estágio de PT...)
// sem acoplar o motor aos componentes. Este módulo é um registro simples de
// handlers: cada componente que possui navegação registra seus comandos ao
// montar (e os remove ao desmontar). As cenas declaram `nav: [{ cmd, arg }]`
// e o motor executa via runTourCommand.
//
// Comandos registrados hoje:
//   App.tsx          → "window"  (activeWindow: null|characters|stats|...)
//                      "tab"     (guia do Hub: ativos|meus_services|...)
//   PartyManager.tsx → "ptStage"      (seletor: comVagas|prontas|...)
//                      "ptStandalone" (selectPrompt|overview|allChars)
//                      "ptClose"      (fecha a PT ativa → painel de cards)
//
// Um comando sem handler registrado (componente desmontado) é ignorado sem
// erro — a cena degrada para o fallback, nunca quebra.
// ============================================================================

type TourCommandHandler = (arg?: unknown) => void;

const handlers = new Map<string, TourCommandHandler>();

/** Registra um conjunto de comandos; retorna a função de limpeza (uso típico
 *  dentro de useEffect). Registrar de novo o mesmo cmd substitui o handler —
 *  comportamento correto para remontagens (StrictMode inclusive). */
export function registerTourCommands(cmds: Record<string, TourCommandHandler>): () => void {
  Object.entries(cmds).forEach(([cmd, fn]) => handlers.set(cmd, fn));
  return () => {
    Object.entries(cmds).forEach(([cmd, fn]) => {
      // Só remove se ainda for o MESMO handler (outra montagem pode já ter
      // substituído — não podemos apagar o registro da montagem mais nova).
      if (handlers.get(cmd) === fn) handlers.delete(cmd);
    });
  };
}

export function runTourCommand(cmd: string, arg?: unknown): boolean {
  const fn = handlers.get(cmd);
  if (!fn) return false;
  try { fn(arg); return true; } catch { return false; }
}
