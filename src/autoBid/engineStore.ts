import { useSyncExternalStore } from "react";
import type { AutoBidConnectionState } from "./types";

// ============================================================================
// AUTO BID — store compartilhado (renderer)
// ----------------------------------------------------------------------------
// Estado compartilhado entre o `AutoBidEngine` (sempre montado, roda em segundo
// plano) e o `AutoBidModal` (UI). Mantém apenas o estado VOLÁTIL de conexão e
// um contador de revisão para configs/histórico — os dados em si ficam no
// `localStorage` (fonte de verdade persistida).
//
// O modal e o engine sobem o contador de revisão quando alteram configs ou o
// histórico, e cada um relê do `localStorage` conforme necessário.
// ============================================================================

interface AutoBidSnapshot {
  connection: AutoBidConnectionState;
  detail: string;
  /** Incrementa sempre que configs mudam (para o modal/engine relerem). */
  configsRevision: number;
  /** Incrementa sempre que o histórico muda. */
  historyRevision: number;
}

let snapshot: AutoBidSnapshot = {
  connection: "desconectado",
  detail: "",
  configsRevision: 0,
  historyRevision: 0,
};

const listeners = new Set<() => void>();

function emit() {
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getSnapshot(): AutoBidSnapshot {
  return snapshot;
}

/** Hook usado por modal e engine. */
export function useAutoBidStore(): AutoBidSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function getAutoBidSnapshot(): AutoBidSnapshot {
  return snapshot;
}

export function setAutoBidConnection(connection: AutoBidConnectionState, detail = "") {
  // Evita re-render global desnecessário quando o estado não mudou (ex.: o
  // polling de sessão a cada 2s chamaria emit() com o mesmo valor).
  if (snapshot.connection === connection && snapshot.detail === detail) return;
  snapshot = { ...snapshot, connection, detail };
  emit();
}

export function bumpConfigsRevision() {
  snapshot = { ...snapshot, configsRevision: snapshot.configsRevision + 1 };
  emit();
}

export function bumpHistoryRevision() {
  snapshot = { ...snapshot, historyRevision: snapshot.historyRevision + 1 };
  emit();
}