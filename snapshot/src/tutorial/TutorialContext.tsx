// ============================================================================
// TUTORIAL — ESTADO GLOBAL E MOTOR DE CENAS
// ----------------------------------------------------------------------------
// Mantém o estado do tour (menu aberto, tópico/cena atual, fila do "Tutorial
// Completo") e o progresso por tópico persistido em localStorage (preferência
// local — deliberadamente sem Firestore/Cloud Functions: progresso de
// tutorial não é dado de negócio; gravar na nuvem só adicionaria custo).
//
// Fluxo de uma cena:
//   goTo(topic, sceneIdx) → executa os comandos nav da cena (runTourCommand)
//   → o TutorialOverlay aguarda o anchor aparecer no DOM (polling curto)
//   → rola até o elemento, mede e posiciona spotlight + balão.
// ============================================================================
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { runTourCommand } from "./commands";
import { loadDemoData, type TutorialDemoData } from "./demo";
import { getTourTopics } from "./registry";
import type { TourProgressMap, TourTopic } from "./types";

interface TutorialState {
  /** Modal de boas-vindas (recomendação do tutorial no login) visível? */
  welcomeOpen: boolean;
  /** Fecha o modal de boas-vindas; opcionalmente grava "nunca mais exibir". */
  dismissWelcome: (neverShowAgain: boolean) => void;
  /** Menu de tópicos visível? */
  menuOpen: boolean;
  /** Tópico em execução (null = nenhum tour ativo). */
  activeTopic: TourTopic | null;
  sceneIndex: number;
  /** Modo "Tutorial Completo": fila de ids de tópicos restantes. */
  fullTourQueue: string[];
  progress: TourProgressMap;
  /** Tópicos disponíveis para o papel atual. */
  topics: TourTopic[];
  /** Modo demonstrativo (cena atual com `demo: true` + dados carregados). */
  demo: TutorialDemoState;
  openMenu: () => void;
  closeMenu: () => void;
  startTopic: (topicId: string, fromScene?: number) => void;
  startFullTour: () => void;
  nextScene: () => void;
  prevScene: () => void;
  skipTopic: () => void;
  exitTour: () => void;
  backToMenu: () => void;
  resetProgress: () => void;
}

/**
 * MODO DEMONSTRATIVO — estado consumido pelos painéis (via useTutorialDemo).
 *
 * `active` fica true enquanto a cena atual do tour declara `demo: true` E o
 * conjunto de dados fictícios já foi carregado (import dinâmico). Os painéis
 * então substituem SOMENTE as props/estados de renderização pelos datasets
 * de `data` — os estados reais do App permanecem intocados, e todos os
 * callbacks de persistência viram no-op enquanto o modo está ativo.
 */
export interface TutorialDemoState {
  active: boolean;
  data: TutorialDemoData | null;
}

const TutorialCtx = createContext<TutorialState | null>(null);

function loadProgress(uid: string): TourProgressMap {
  try {
    const raw = localStorage.getItem(`tutorial_progress_${uid || "anon"}`);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

export function TutorialProvider({ children, isBoss, uid, userName = "" }: { children: ReactNode; isBoss: boolean; uid: string; userName?: string }) {
  const [menuOpen, setMenuOpen] = useState(false);
  // ── MODAL DE BOAS-VINDAS OBRIGATÓRIO NO LOGIN ───────────────────────────
  // Ao entrar no aplicativo (uid definido), o modal que recomenda o tutorial
  // abre automaticamente — exceto se o usuário marcou "Nunca mais exibir"
  // (flag local tutorial_welcome_dismissed_{uid}). Abre apenas UMA vez por
  // sessão (welcomeShownRef) para não reaparecer em re-renders/idle.
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const welcomeShownRef = useRef<string | null>(null);
  useEffect(() => {
    if (!uid || welcomeShownRef.current === uid) return;
    welcomeShownRef.current = uid;
    try {
      if (localStorage.getItem(`tutorial_welcome_dismissed_${uid}`) === "1") return;
    } catch {}
    setWelcomeOpen(true);
  }, [uid]);
  const dismissWelcome = useCallback((neverShowAgain: boolean) => {
    setWelcomeOpen(false);
    if (neverShowAgain && uid) {
      try { localStorage.setItem(`tutorial_welcome_dismissed_${uid}`, "1"); } catch {}
    }
  }, [uid]);
  const [activeTopicId, setActiveTopicId] = useState<string | null>(null);
  const [sceneIndex, setSceneIndex] = useState(0);
  const [fullTourQueue, setFullTourQueue] = useState<string[]>([]);
  const [progress, setProgress] = useState<TourProgressMap>(() => loadProgress(uid));

  // Recarrega o progresso quando o usuário logado muda.
  useEffect(() => { setProgress(loadProgress(uid)); }, [uid]);
  useEffect(() => {
    try { localStorage.setItem(`tutorial_progress_${uid || "anon"}`, JSON.stringify(progress)); } catch {}
  }, [progress, uid]);

  const topics = useMemo(() => getTourTopics(isBoss), [isBoss]);
  const activeTopic = useMemo(
    () => topics.find(t => t.id === activeTopicId) || null,
    [topics, activeTopicId],
  );

  // ── MODO DEMONSTRATIVO ───────────────────────────────────────────────────
  // Ativo enquanto a cena atual declara `demo: true`. Os datasets fictícios
  // são carregados por import dinâmico UMA vez por sessão (cache no módulo
  // demo/index.ts); até a promessa resolver, `active` permanece false e a
  // cena se comporta como as demais (o anchor pode degradar para fallback).
  // Sair do tour ou navegar para uma cena sem `demo` desativa na hora.
  const demoReadyRef = useRef(false);
  const [demoData, setDemoData] = useState<TutorialDemoData | null>(null);
  const currentScene = activeTopic?.scenes[sceneIndex] || null;
  const demoWanted = !!currentScene?.demo;
  useEffect(() => {
    if (!demoWanted || demoData) return;
    let cancelled = false;
    loadDemoData(uid, userName).then(data => { if (!cancelled) setDemoData(data); }).catch(() => {});
    return () => { cancelled = true; };
  }, [demoWanted, demoData, uid, userName]);
  const demo = useMemo<TutorialDemoState>(
    () => ({ active: demoWanted && !!demoData, data: demoWanted ? demoData : null }),
    [demoWanted, demoData],
  );
  // Marca "demo pronto" APÓS o commit em que os consumidores (App/painéis) já
  // renderizaram com os dados fictícios — os comandos de navegação das cenas
  // demo (ex.: ptOpenFirst) então operam sobre as listas certas.
  useEffect(() => { demoReadyRef.current = demo.active; }, [demo.active]);

  // Executa os comandos de navegação da cena EM ORDEM, com retry curto:
  // um comando pode depender de um componente que só monta depois do comando
  // anterior renderizar (ex.: "tab: pts" monta o PartyManager, e só então
  // "ptStage" tem handler registrado). Comandos que continuam sem handler ao
  // fim da janela são descartados — a cena degrada para o fallback.
  const navRunRef = useRef(0);
  // O loop abaixo consulta demoReadyRef (declarado junto do bloco demo):
  // cenas demonstrativas só navegam DEPOIS que os dados fictícios chegaram
  // aos painéis — senão comandos como ptOpenFirst rodariam sobre a lista
  // real (possivelmente vazia) e a cena degradaria à toa.
  const runSceneNav = useCallback((topic: TourTopic, idx: number) => {
    const scene = topic.scenes[idx];
    const pending = [...(scene?.nav || [])];
    if (pending.length === 0) return;
    const runId = ++navRunRef.current;
    // Cena demo: prazo maior — inclui o import dinâmico dos datasets.
    const deadline = Date.now() + (scene?.demo ? 6000 : 2500);
    // Prazo EXTRA além do gate: comandos que dependem de componentes recém-
    // montados pela própria navegação (ex.: "tab pts" monta o PartyManager e
    // só então "ptOpenFirst" tem handler) precisam de janela de retry DEPOIS
    // que o gate liberar — senão a cena abre na tela errada e o usuário vê o
    // "Avançar" falhar.
    const execDeadline = deadline + 3000;
    function tick() {
      if (navRunRef.current !== runId) return; // outra cena assumiu
      if (scene?.demo && !demoReadyRef.current && Date.now() < deadline) {
        // Aguarda os dados fictícios chegarem aos painéis. Se o gate expirar
        // (import falhou/rede lenta), os comandos executam mesmo assim —
        // navegar para a tela certa é sempre melhor do que ficar parado.
        setTimeout(tick, 100);
        return;
      }
      while (pending.length > 0) {
        const { cmd, arg } = pending[0];
        if (!runTourCommand(cmd, arg)) break; // handler ainda não registrado
        pending.shift();
      }
      if (pending.length > 0 && Date.now() < execDeadline) setTimeout(tick, 100);
    }
    tick();
  }, []);

  const saveSceneProgress = useCallback((topicId: string, idx: number, completed: boolean) => {
    setProgress(prev => {
      const cur = prev[topicId];
      return {
        ...prev,
        [topicId]: {
          lastScene: idx,
          completed: completed || !!cur?.completed,
        },
      };
    });
  }, []);

  const startTopic = useCallback((topicId: string, fromScene = 0) => {
    const topic = topics.find(t => t.id === topicId);
    if (!topic || topic.scenes.length === 0) return;
    const idx = Math.min(Math.max(0, fromScene), topic.scenes.length - 1);
    setMenuOpen(false);
    setActiveTopicId(topicId);
    setSceneIndex(idx);
    runSceneNav(topic, idx);
  }, [topics, runSceneNav]);

  const startFullTour = useCallback(() => {
    if (topics.length === 0) return;
    const [first, ...rest] = topics.map(t => t.id);
    setFullTourQueue(rest);
    const topic = topics[0];
    setMenuOpen(false);
    setActiveTopicId(first);
    setSceneIndex(0);
    runSceneNav(topic, 0);
  }, [topics, runSceneNav]);

  /** Conclui o tópico atual: marca progresso e encadeia o próximo da fila
   *  (Tutorial Completo) ou volta ao menu. */
  const finishTopic = useCallback(() => {
    if (activeTopic) saveSceneProgress(activeTopic.id, activeTopic.scenes.length - 1, true);
    if (fullTourQueue.length > 0) {
      const [next, ...rest] = fullTourQueue;
      setFullTourQueue(rest);
      const topic = topics.find(t => t.id === next);
      if (topic) {
        setActiveTopicId(next);
        setSceneIndex(0);
        runSceneNav(topic, 0);
        return;
      }
    }
    setActiveTopicId(null);
    setSceneIndex(0);
    setFullTourQueue([]);
    setMenuOpen(true);
  }, [activeTopic, fullTourQueue, topics, runSceneNav, saveSceneProgress]);

  const nextScene = useCallback(() => {
    if (!activeTopic) return;
    const next = sceneIndex + 1;
    if (next >= activeTopic.scenes.length) { finishTopic(); return; }
    setSceneIndex(next);
    saveSceneProgress(activeTopic.id, next, false);
    runSceneNav(activeTopic, next);
  }, [activeTopic, sceneIndex, finishTopic, runSceneNav, saveSceneProgress]);

  const prevScene = useCallback(() => {
    if (!activeTopic || sceneIndex === 0) return;
    const prev = sceneIndex - 1;
    setSceneIndex(prev);
    runSceneNav(activeTopic, prev);
  }, [activeTopic, sceneIndex, runSceneNav]);

  const skipTopic = useCallback(() => { finishTopic(); }, [finishTopic]);

  const exitTour = useCallback(() => {
    if (activeTopic) saveSceneProgress(activeTopic.id, sceneIndex, false);
    setActiveTopicId(null);
    setSceneIndex(0);
    setFullTourQueue([]);
    setMenuOpen(false);
  }, [activeTopic, sceneIndex, saveSceneProgress]);

  const backToMenu = useCallback(() => {
    if (activeTopic) saveSceneProgress(activeTopic.id, sceneIndex, false);
    setActiveTopicId(null);
    setSceneIndex(0);
    setFullTourQueue([]);
    setMenuOpen(true);
  }, [activeTopic, sceneIndex, saveSceneProgress]);

  const resetProgress = useCallback(() => { setProgress({}); }, []);

  // Teclado: ←/→ navegam, Esc sai. Só com tour ativo.
  const stateRef = useRef({ nextScene, prevScene, exitTour, active: !!activeTopic });
  stateRef.current = { nextScene, prevScene, exitTour, active: !!activeTopic };
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!stateRef.current.active) return;
      if (e.key === "ArrowRight") { e.preventDefault(); stateRef.current.nextScene(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); stateRef.current.prevScene(); }
      else if (e.key === "Escape") { e.preventDefault(); stateRef.current.exitTour(); }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const value = useMemo<TutorialState>(() => ({
    welcomeOpen, dismissWelcome,
    menuOpen, activeTopic, sceneIndex, fullTourQueue, progress, topics, demo,
    openMenu: () => setMenuOpen(true),
    closeMenu: () => setMenuOpen(false),
    startTopic, startFullTour, nextScene, prevScene, skipTopic, exitTour, backToMenu, resetProgress,
  }), [welcomeOpen, dismissWelcome, menuOpen, activeTopic, sceneIndex, fullTourQueue, progress, topics, demo, startTopic, startFullTour, nextScene, prevScene, skipTopic, exitTour, backToMenu, resetProgress]);

  return <TutorialCtx.Provider value={value}>{children}</TutorialCtx.Provider>;
}

export function useTutorial(): TutorialState {
  const ctx = useContext(TutorialCtx);
  if (!ctx) throw new Error("useTutorial deve ser usado dentro de TutorialProvider");
  return ctx;
}

/** Atalho para os painéis: apenas o estado do modo demonstrativo. */
export function useTutorialDemo(): TutorialDemoState {
  return useTutorial().demo;
}
