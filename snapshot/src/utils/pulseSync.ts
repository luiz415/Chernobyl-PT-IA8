// ============================================================================
// SINCRONIZAÇÃO GLOBAL DOS EFEITOS DE PULSAÇÃO
// ============================================================================
// Animações CSS começam a contar no instante em que a classe é aplicada ao
// elemento. Como cada botão/seletor monta (ou passa a pulsar) em momentos
// diferentes, dois elementos com o MESMO keyframe ficam fora de fase — cada
// um "respira" no seu próprio ritmo.
//
// Este módulo ancora todas as animações de pulso do app em UMA ÚNICA
// referência de tempo: a timeline do documento (Web Animations API). No
// evento `animationstart` de qualquer animação sincronizável, o
// `Animation.startTime` é rebobinado para 0 — o instante zero da página,
// compartilhado por todas as animações. Com a MESMA duração de ciclo
// (PULSE_PERIOD_MS, garantida no CSS), a fase de cada animação passa a ser
// exatamente `now % período`, idêntica para todos os elementos,
// independentemente de quando cada um montou ou começou a pulsar.
//
// Vantagens sobre alternativas:
//   • `animation-delay` negativo calculado no render: impreciso (diferença
//     render → paint) e frágil em re-renders;
//   • timers em JS: caros e sujeitos a drift;
//   • `startTime = 0`: exato, nativo, custo zero por frame — o navegador
//     continua conduzindo a animação; só o ponto de ancoragem muda.
//
// O listener é global (instalado uma vez em main.tsx) e passivo: animações
// que não estão na lista permanecem intocadas.

/** Período único de ciclo (ms) de TODOS os pulsos sincronizados — precisa
 *  bater com as durações declaradas em src/index.css. */
export const PULSE_PERIOD_MS = 1800;

/** Keyframes que participam da sincronização global:
 *   • pt-stage-border-pulse — seletores de estágio das PTs (PartyManager);
 *     também usado pelos botões do rodapé (App, container `.footer-pulse`). */
const SYNCED_ANIMATION_NAMES = new Set(["pt-stage-border-pulse"]);

let installed = false;

/**
 * Instala (uma única vez) o sincronizador global de pulsos.
 *
 * Além dos keyframes próprios do app, o `animate-pulse` do Tailwind
 * (keyframe "pulse") também é sincronizado QUANDO o elemento está dentro do
 * rodapé (`.footer-pulse`) — caso dos botões Boss/Amigos com pendências. O
 * CSS ajusta a duração desses casos para PULSE_PERIOD_MS; os demais
 * `animate-pulse` do app (fora do rodapé) não são alterados.
 */
export function installGlobalPulseSync(): void {
  if (installed) return;
  installed = true;
  document.addEventListener(
    "animationstart",
    (event: AnimationEvent) => {
      const name = event.animationName;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const isFooterTailwindPulse = name === "pulse" && !!target.closest(".footer-pulse");
      if (!SYNCED_ANIMATION_NAMES.has(name) && !isFooterTailwindPulse) return;
      try {
        // `subtree: true` inclui as animações de pseudo-elementos (::after do
        // anel do rodapé dispara o evento no botão hospedeiro).
        const animations = target.getAnimations({ subtree: true });
        for (const animation of animations) {
          if ((animation as CSSAnimation).animationName === name) {
            // Âncora única: t=0 da timeline do documento. Fase resultante =
            // (agora % duração) — a mesma para todo elemento sincronizado.
            animation.startTime = 0;
          }
        }
      } catch {
        // Web Animations API indisponível (improvável no Electron/Chromium):
        // as animações seguem funcionando, apenas sem sincronia perfeita.
      }
    },
    // Captura: `animationstart` não borbulha de forma confiável através de
    // shadow roots/portais; capture garante que o documento sempre veja.
    true,
  );
}
