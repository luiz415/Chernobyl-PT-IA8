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
import { getTourTopics } from "./registry";
import type { TourProgressMap, TourTopic } from "./types";

interface TutorialState {
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

const TutorialCtx = createContext<TutorialState | null>(null);

function loadProgress(uid: string): TourProgressMap {
  try {
    const raw = localStorage.getItem(`tutorial_progress_${uid || "anon"}`);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

export function TutorialProvider({ children, isBoss, uid }: { children: ReactNode; isBoss: boolean; uid: string }) {
  const [menuOpen, setMenuOpen] = useState(false);
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

  // Executa os comandos de navegação da cena EM ORDEM, com retry curto:
  // um comando pode depender de um componente que só monta depois do comando
  // anterior renderizar (ex.: "tab: pts" monta o PartyManager, e só então
  // "ptStage" tem handler registrado). Comandos que continuam sem handler ao
  // fim da janela são descartados — a cena degrada para o fallback.
  const navRunRef = useRef(0);
  const runSceneNav = useCallback((topic: TourTopic, idx: number) => {
    const scene = topic.scenes[idx];
    const pending = [...(scene?.nav || [])];
    if (pending.length === 0) return;
    const runId = ++navRunRef.current;
    const deadline = Date.now() + 2500;
    function tick() {
      if (navRunRef.current !== runId) return; // outra cena assumiu
      while (pending.length > 0) {
        const { cmd, arg } = pending[0];
        if (!runTourCommand(cmd, arg)) break; // handler ainda não registrado
        pending.shift();
      }
      if (pending.length > 0 && Date.now() < deadline) setTimeout(tick, 100);
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
    menuOpen, activeTopic, sceneIndex, fullTourQueue, progress, topics,
    openMenu: () => setMenuOpen(true),
    closeMenu: () => setMenuOpen(false),
    startTopic, startFullTour, nextScene, prevScene, skipTopic, exitTour, backToMenu, resetProgress,
  }), [menuOpen, activeTopic, sceneIndex, fullTourQueue, progress, topics, startTopic, startFullTour, nextScene, prevScene, skipTopic, exitTour, backToMenu, resetProgress]);

  return <TutorialCtx.Provider value={value}>{children}</TutorialCtx.Provider>;
}

export function useTutorial(): TutorialState {
  const ctx = useContext(TutorialCtx);
  if (!ctx) throw new Error("useTutorial deve ser usado dentro de TutorialProvider");
  return ctx;
}
