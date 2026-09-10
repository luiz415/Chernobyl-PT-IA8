// ============================================================================
// TUTORIAL — OVERLAY GLOBAL (spotlight + balão explicativo)
// ----------------------------------------------------------------------------
// Renderizado em portal no <body>, ACIMA de tudo (zIndex 10000 — o maior do
// app é 100). O escurecimento é feito por um único elemento "buraco": um div
// posicionado sobre o alvo com box-shadow gigantesco (100vmax) — o interior
// permanece transparente (interface real visível) e o resto da tela escurece.
// Como top/left/width/height transicionam via CSS, mover o spotlight entre
// cenas da mesma tela produz uma animação suave sem código extra.
//
// Medição e zoom: o overlay vive FORA dos containers com CSS `zoom` do app.
// Nos Chromium/Electron atuais (comportamento padronizado desde o Chrome 128)
// getBoundingClientRect() já devolve coordenadas do viewport visual COM o
// zoom aplicado — exatamente o sistema de coordenadas do overlay fixed. Por
// isso o rect é usado diretamente, e um re-medidor periódico (500ms) absorve
// mudanças de zoom/layout/animações enquanto a cena está aberta.
//
// Robustez: se o anchor da cena não aparecer em ~2s (elemento condicional,
// painel não montado), a cena degrada para o modo informativo — balão
// centralizado com `fallbackBody` (ou o próprio body). O tutorial nunca trava.
// ============================================================================
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, ListChecks, SkipForward, X, Check } from "lucide-react";
import { useTutorial } from "./TutorialContext";
import type { TourTone } from "./types";

/** Paleta por tom do tópico — classes literais completas (Tailwind JIT). */
const TONE_THEME: Record<TourTone, { ring: string; text: string; badge: string; btn: string; pulse: string }> = {
  emerald: { ring: "rgba(16,185,129,0.9)", text: "text-emerald-300", badge: "bg-emerald-500/15 border-emerald-500/40 text-emerald-300", btn: "bg-emerald-600 hover:bg-emerald-500 border-emerald-500/60", pulse: "pt-stage-pulse pt-stage-pulse--emerald" },
  violet: { ring: "rgba(139,92,246,0.9)", text: "text-violet-300", badge: "bg-violet-500/15 border-violet-500/40 text-violet-300", btn: "bg-violet-600 hover:bg-violet-500 border-violet-500/60", pulse: "pt-stage-pulse pt-stage-pulse--violet" },
  sky: { ring: "rgba(14,165,233,0.9)", text: "text-sky-300", badge: "bg-sky-500/15 border-sky-500/40 text-sky-300", btn: "bg-sky-600 hover:bg-sky-500 border-sky-500/60", pulse: "pt-stage-pulse pt-stage-pulse--sky" },
  amber: { ring: "rgba(245,158,11,0.9)", text: "text-amber-300", badge: "bg-amber-500/15 border-amber-500/40 text-amber-300", btn: "bg-amber-600 hover:bg-amber-500 border-amber-500/60", pulse: "pt-stage-pulse pt-stage-pulse--amber" },
  rose: { ring: "rgba(244,63,94,0.9)", text: "text-rose-300", badge: "bg-rose-500/15 border-rose-500/40 text-rose-300", btn: "bg-rose-600 hover:bg-rose-500 border-rose-500/60", pulse: "pt-stage-pulse pt-stage-pulse--amber" },
};

interface Rect { top: number; left: number; width: number; height: number }

// ── CORES NOS TEXTOS DAS CENAS ──────────────────────────────────────────────
// Mini-markup nos bodies dos tópicos: [[tom:texto]] vira um <span> colorido.
// Tons disponíveis (classes literais completas — Tailwind JIT):
//   emerald, violet, sky, amber, rose, slate — e "vip" (selo âmbar destacado
//   usado para marcar funcionalidades exclusivas de usuários VIP).
const INLINE_TONE: Record<string, string> = {
  emerald: "text-emerald-300 font-bold",
  violet: "text-violet-300 font-bold",
  sky: "text-sky-300 font-bold",
  amber: "text-amber-300 font-bold",
  rose: "text-rose-300 font-bold",
  slate: "text-slate-200 font-bold",
  vip: "text-amber-300 font-black px-1 py-px rounded border border-amber-500/40 bg-amber-500/10 text-[10px] uppercase tracking-wide",
};

/** Converte um parágrafo com [[tom:texto]] em nós React. */
function renderColoredText(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\[\[(emerald|violet|sky|amber|rose|slate|vip):([^\]]+)\]\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<span key={key++} className={INLINE_TONE[m[1]]}>{m[2]}</span>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const ANCHOR_TIMEOUT_MS = 2000;
// Cenas demonstrativas: prazo maior — a navegação delas espera o import
// dinâmico dos datasets fictícios (gate demoReadyRef, até 5s) ANTES de
// executar os comandos, então o anchor pode legitimamente demorar mais.
const ANCHOR_TIMEOUT_DEMO_MS = 6500;
const ANCHOR_POLL_MS = 100;
// Após degradar para o modo informativo, um poll lento continua procurando o
// anchor: se o painel terminar de montar depois do prazo (rede lenta, guia
// pesada), a cena é PROMOVIDA ao spotlight em vez de ficar presa no fallback.
const ANCHOR_RECOVER_POLL_MS = 500;
const REMEASURE_MS = 500;
const BALLOON_W = 380; // largura alvo do balão em telas normais

/**
 * Localiza o elemento VISÍVEL do anchor. O mesmo id pode existir em mais de
 * um elemento (ex.: barra de janelas desktop × mobile — uma delas sempre está
 * com display:none); elementos ocultos medem 0×0 e são descartados.
 */
function findVisibleTourEl(anchor: string): HTMLElement | null {
  const els = document.querySelectorAll<HTMLElement>(`[data-tour="${anchor}"]`);
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return el;
  }
  return null;
}

export default function TutorialOverlay() {
  const { activeTopic, sceneIndex, nextScene, prevScene, skipTopic, exitTour, backToMenu, fullTourQueue, topics, demo } = useTutorial();
  const scene = activeTopic?.scenes[sceneIndex];
  // rect: undefined = medindo; null = anchor ausente (modo informativo).
  const [rect, setRect] = useState<Rect | null | undefined>(undefined);
  const targetRef = useRef<HTMLElement | null>(null);
  const balloonRef = useRef<HTMLDivElement>(null);
  const [balloonPos, setBalloonPos] = useState<{ top: number; left: number } | null>(null);

  // ── LOCALIZAÇÃO DO ANCHOR ────────────────────────────────────────────────
  // Aguarda o elemento aparecer (a navegação da cena pode ter acabado de
  // trocar a guia — montagem preguiçosa). Depois rola até ele e mede.
  useEffect(() => {
    targetRef.current = null;
    setBalloonPos(null);
    if (!scene) { setRect(undefined); return; }
    if (!scene.anchor) { setRect(null); return; }
    setRect(undefined);
    let cancelled = false;
    const started = Date.now();
    const timeoutMs = scene.demo ? ANCHOR_TIMEOUT_DEMO_MS : ANCHOR_TIMEOUT_MS;
    function locate() {
      if (cancelled) return;
      const el = findVisibleTourEl(scene!.anchor!);
      if (el) {
        targetRef.current = el;
        try { el.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" }); } catch {}
        // Mede no frame seguinte, com o scroll já aplicado.
        requestAnimationFrame(() => {
          if (cancelled) return;
          const r = el.getBoundingClientRect();
          setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
        });
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        // Degrada para o modo informativo, mas SEGUE procurando em ritmo
        // lento: se o anchor montar depois, a cena recupera o spotlight.
        setRect(null);
        setTimeout(locate, ANCHOR_RECOVER_POLL_MS);
        return;
      }
      setTimeout(locate, ANCHOR_POLL_MS);
    }
    // Primeiro tick após um frame — dá tempo de a navegação da cena renderizar.
    requestAnimationFrame(locate);
    return () => { cancelled = true; };
  }, [scene]);

  // ── RASTREAMENTO CONTÍNUO ────────────────────────────────────────────────
  // Re-mede em resize/scroll (captura — inclui containers internos) + um
  // intervalo curto para absorver animações/zoom/layout dinâmico.
  useEffect(() => {
    if (!scene?.anchor) return;
    let raf = 0;
    function remeasure() {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const el = targetRef.current;
        if (!el || !el.isConnected) return;
        const r = el.getBoundingClientRect();
        setRect(prev => {
          if (prev && Math.abs(prev.top - r.top) < 0.5 && Math.abs(prev.left - r.left) < 0.5
            && Math.abs(prev.width - r.width) < 0.5 && Math.abs(prev.height - r.height) < 0.5) return prev;
          return { top: r.top, left: r.left, width: r.width, height: r.height };
        });
      });
    }
    window.addEventListener("resize", remeasure);
    window.addEventListener("scroll", remeasure, true);
    const timer = setInterval(remeasure, REMEASURE_MS);
    return () => {
      window.removeEventListener("resize", remeasure);
      window.removeEventListener("scroll", remeasure, true);
      clearInterval(timer);
      cancelAnimationFrame(raf);
    };
  }, [scene]);

  // ── POSICIONAMENTO DO BALÃO ──────────────────────────────────────────────
  // Flip automático: tenta abaixo → acima → direita → esquerda; clampa no
  // viewport. Em telas estreitas (<640px) vira folha fixa na base.
  //
  // CORREÇÃO DE TRAVAMENTO ENTRE CENAS: o efeito de localização do anchor
  // (acima) zera `balloonPos` a cada troca de cena — mas ele roda DEPOIS
  // deste layout effect no mesmo commit. Quando a transição não altera
  // `rect` (ex.: cena informativa → cena informativa, ambas com rect=null,
  // já que setRect(null) sobre null é no-op), nenhuma dependência antiga
  // ([rect, scene, sceneIndex]) mudava no re-render seguinte e o balão
  // ficava permanentemente em -9999px: tela esmaecida sem conteúdo até o
  // usuário apertar Esc. Incluir `balloonPos` nas dependências garante que
  // o reset para null SEMPRE dispare um novo posicionamento; o `place()`
  // abaixo faz bailout por VALOR (retorna o estado anterior quando top/left
  // não mudam), então o efeito converge em uma passada — sem loop.
  useLayoutEffect(() => {
    if (!scene) return;
    const balloon = balloonRef.current;
    if (!balloon) return;
    // Atualiza apenas quando a posição muda de fato — evita re-render em
    // cascata agora que `balloonPos` é dependência deste efeito.
    const place = (top: number, left: number) => {
      setBalloonPos(prev => (prev && Math.abs(prev.top - top) < 0.5 && Math.abs(prev.left - left) < 0.5) ? prev : { top, left });
    };
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (vw < 640) { setBalloonPos(null); return; } // modo folha (CSS cuida)
    const bw = Math.min(BALLOON_W, vw - 24);
    const bh = balloon.offsetHeight || 220;
    const gap = 14;
    if (!rect) {
      place(Math.max(12, (vh - bh) / 2), Math.max(12, (vw - bw) / 2));
      return;
    }
    const pad = scene.padding ?? 6;
    const r = { top: rect.top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 };
    let top: number; let left: number;
    if (r.top + r.height + gap + bh <= vh - 12) {          // abaixo
      top = r.top + r.height + gap;
      left = r.left + r.width / 2 - bw / 2;
    } else if (r.top - gap - bh >= 12) {                    // acima
      top = r.top - gap - bh;
      left = r.left + r.width / 2 - bw / 2;
    } else if (r.left + r.width + gap + bw <= vw - 12) {    // direita
      top = r.top + r.height / 2 - bh / 2;
      left = r.left + r.width + gap;
    } else if (r.left - gap - bw >= 12) {                   // esquerda
      top = r.top + r.height / 2 - bh / 2;
      left = r.left - gap - bw;
    } else {                                                // sem espaço: centro
      top = (vh - bh) / 2;
      left = (vw - bw) / 2;
    }
    place(
      Math.min(Math.max(12, top), Math.max(12, vh - bh - 12)),
      Math.min(Math.max(12, left), Math.max(12, vw - bw - 12)),
    );
    // `balloonPos` é dependência DELIBERADA: quando a troca de cena o zera
    // sem alterar `rect` (cena informativa → informativa), este efeito
    // precisa rodar de novo para reposicionar — ver comentário acima.
  }, [rect, scene, sceneIndex, balloonPos]);

  if (!activeTopic || !scene) return null;

  const theme = TONE_THEME[activeTopic.tone];
  const measuring = scene.anchor && rect === undefined;
  const informational = !scene.anchor || rect === null;
  const pad = scene.padding ?? 6;
  const totalScenes = activeTopic.scenes.length;
  const isLast = sceneIndex === totalScenes - 1;
  const topicPos = topics.findIndex(t => t.id === activeTopic.id) + 1;
  const bodyText = (rect === null && scene.anchor && scene.fallbackBody) ? scene.fallbackBody : scene.body;
  const isMobileSheet = typeof window !== "undefined" && window.innerWidth < 640;
  // CENA INTERATIVA: o contêiner raiz deixa de capturar eventos e o bloqueio
  // é feito por QUATRO faixas ao redor do spotlight — o interior vira um
  // "buraco" também para o mouse, permitindo interagir com o elemento real.
  const interactive = !!scene.interactive && !informational && !!rect;
  const holeRect = interactive && rect
    ? { top: rect.top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }
    : null;

  return createPortal(
    <div className="fixed inset-0" style={{ zIndex: 10000, pointerEvents: interactive ? "none" : undefined }} data-tutorial-overlay>
      {/* Bloqueador de cliques: tela inteira nas cenas normais; nas cenas
          interativas, quatro faixas que preservam o buraco do spotlight. */}
      {interactive && holeRect ? (
        <>
          <div className="absolute" style={{ pointerEvents: "auto", top: 0, left: 0, right: 0, height: Math.max(0, holeRect.top) }} />
          <div className="absolute" style={{ pointerEvents: "auto", top: holeRect.top + holeRect.height, left: 0, right: 0, bottom: 0 }} />
          <div className="absolute" style={{ pointerEvents: "auto", top: holeRect.top, left: 0, width: Math.max(0, holeRect.left), height: holeRect.height }} />
          <div className="absolute" style={{ pointerEvents: "auto", top: holeRect.top, left: holeRect.left + holeRect.width, right: 0, height: holeRect.height }} />
        </>
      ) : (
        <div className="absolute inset-0" style={{ background: informational ? "rgba(2,6,14,0.78)" : "transparent" }} />
      )}
      {/* Spotlight: interior transparente + escurecimento por box-shadow. */}
      {!informational && rect && (
        <div
          className="absolute rounded-xl pointer-events-none"
          style={{
            top: rect.top - pad,
            left: rect.left - pad,
            width: rect.width + pad * 2,
            height: rect.height + pad * 2,
            boxShadow: `0 0 0 100vmax rgba(2,6,14,0.78), 0 0 18px 2px ${theme.ring}`,
            border: `2px solid ${theme.ring}`,
            transition: "top 300ms ease, left 300ms ease, width 300ms ease, height 300ms ease",
          }}
        />
      )}
      {/* Enquanto mede, escurece tudo (evita "flash" da interface nua). */}
      {measuring && <div className="absolute inset-0" style={{ background: "rgba(2,6,14,0.6)" }} />}

      {/* Balão explicativo */}
      <div
        ref={balloonRef}
        className={`absolute bg-[var(--th-bg-raised,#0d1117)] border border-white/12 rounded-2xl shadow-2xl flex flex-col overflow-hidden ${isMobileSheet ? "left-2 right-2 bottom-2" : ""}`}
        style={isMobileSheet
          ? { maxHeight: "55vh", pointerEvents: "auto" }
          : { top: balloonPos?.top ?? -9999, left: balloonPos?.left ?? -9999, width: Math.min(BALLOON_W, window.innerWidth - 24), maxHeight: "70vh", transition: balloonPos ? "top 300ms ease, left 300ms ease" : undefined, pointerEvents: "auto" }}
      >
        {/* Cabeçalho: tópico + progresso + fechar */}
        <div className="flex items-center gap-2 px-3.5 pt-3 pb-2 border-b border-white/8 flex-shrink-0">
          <activeTopic.icon size={14} className={theme.text} />
          <span className={`text-[10px] font-black uppercase tracking-widest ${theme.text}`}>{activeTopic.title}</span>
          <span className={`ml-auto text-[9px] font-bold px-2 py-0.5 rounded-full border ${theme.badge}`}>
            Cena {sceneIndex + 1}/{totalScenes}
          </span>
          {fullTourQueue.length > 0 && (
            <span className="text-[9px] font-bold px-2 py-0.5 rounded-full border border-white/15 bg-white/5 text-slate-400" title="Tutorial Completo em andamento">
              Tópico {topicPos}/{topics.length}
            </span>
          )}
          <button type="button" onClick={exitTour} className="p-1 rounded-md text-slate-500 hover:text-white hover:bg-white/10 transition-colors cursor-pointer" title="Sair do tutorial (Esc)">
            <X size={13} />
          </button>
        </div>

        {/* Conteúdo */}
        <div className="px-3.5 py-2.5 overflow-y-auto min-h-0">
          {/* Selo do modo demonstrativo: deixa explícito que os dados na tela
              são fictícios e não pertencem à conta do usuário. */}
          {scene.demo && demo.active && (
            <div className="inline-flex items-center gap-1 mb-1.5 px-1.5 py-0.5 rounded border border-fuchsia-500/40 bg-fuchsia-500/10">
              <span className="w-1.5 h-1.5 rounded-full bg-fuchsia-400 animate-pulse" />
              <span className="text-[8px] font-black uppercase tracking-widest text-fuchsia-300">Dados demonstrativos — nada disto é real</span>
            </div>
          )}
          <h3 className="text-[13px] font-black text-white mb-1.5">{scene.title}</h3>
          {bodyText.split("\n\n").map((paragraph, i) => (
            <p key={i} className="text-[11px] text-slate-300 leading-relaxed mb-1.5 last:mb-0">{renderColoredText(paragraph)}</p>
          ))}
          {rect === null && scene.anchor && (
            <p className="text-[9px] text-slate-500 italic mt-1.5">
              O elemento desta cena não está visível no momento — a explicação acima descreve onde encontrá-lo.
            </p>
          )}
        </div>

        {/* Barra de progresso do tópico */}
        <div className="h-1 bg-white/5 flex-shrink-0">
          <div className="h-full rounded-r-full transition-all duration-300" style={{ width: `${((sceneIndex + 1) / totalScenes) * 100}%`, background: theme.ring }} />
        </div>

        {/* Rodapé: controles */}
        <div className="flex items-center gap-1.5 px-3 py-2.5 border-t border-white/8 flex-shrink-0 flex-wrap">
          <button type="button" onClick={backToMenu} className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg border border-white/12 bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white text-[9px] font-bold transition-colors cursor-pointer" title="Voltar à lista de tópicos">
            <ListChecks size={11} /> Tópicos
          </button>
          <button type="button" onClick={skipTopic} className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg border border-white/12 bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white text-[9px] font-bold transition-colors cursor-pointer" title="Pular este tópico">
            <SkipForward size={11} /> Pular
          </button>
          <div className="flex-1" />
          <button
            type="button"
            onClick={prevScene}
            disabled={sceneIndex === 0}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-white/12 bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white text-[10px] font-bold transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default"
            title="Cena anterior (←)"
          >
            <ChevronLeft size={12} /> Retroceder
          </button>
          <button
            type="button"
            onClick={nextScene}
            className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border text-white text-[10px] font-black transition-colors cursor-pointer ${theme.btn}`}
            title={isLast ? "Concluir o tópico" : "Próxima cena (→)"}
          >
            {isLast ? <>Concluir <Check size={12} /></> : <>Avançar <ChevronRight size={12} /></>}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
