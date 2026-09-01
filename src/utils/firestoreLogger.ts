import type { Firestore } from "firebase/firestore";
import {
  onSnapshot as firebaseOnSnapshot,
  setDoc as firebaseSetDoc,
  updateDoc as firebaseUpdateDoc,
  addDoc as firebaseAddDoc,
  deleteDoc as firebaseDeleteDoc,
  getDoc as firebaseGetDoc,
  getDocs as firebaseGetDocs,
  doc as firebaseDoc,
} from "firebase/firestore";
import { recordFirestoreOp } from "./firestoreUsageMonitor";

export interface LogEntry {
  id: string;
  timestamp: number;
  type: "read" | "write" | "delete";
  operation: string;
  collection: string;
  docId: string | null;
  docsCount: number;
  details?: string;
}

const MAX_LOGS = 5000;
const REMOTE_LOGS_LIMIT = 100;
const _logs: LogEntry[] = [];
let _isPatched = false;
let _isLoggerPaused = false;
export type FirestoreLoggerDetailLevel = "complete" | "summary";
export interface FirestoreLoggerGovernance {
  paused: boolean;
  detailLevel: FirestoreLoggerDetailLevel;
  sendIntervalSeconds: 120 | 300 | 600;
}

let _loggerDetailLevel: FirestoreLoggerDetailLevel = "complete";
let _loggerSendIntervalSeconds: 120 | 300 | 600 = 120;
const _governanceListeners = new Set<(settings: FirestoreLoggerGovernance) => void>();

function notifyLoggerGovernance() {
  const settings = getLoggerGovernance();
  _governanceListeners.forEach(listener => {
    try { listener(settings); } catch {}
  });
}

export function getLoggerGovernance(): FirestoreLoggerGovernance {
  return {
    paused: _isLoggerPaused,
    detailLevel: _loggerDetailLevel,
    sendIntervalSeconds: _loggerSendIntervalSeconds,
  };
}

export function subscribeLoggerGovernance(listener: (settings: FirestoreLoggerGovernance) => void): () => void {
  _governanceListeners.add(listener);
  return () => { _governanceListeners.delete(listener); };
}

export function setLoggerPaused(paused: boolean): void {
  if (_isLoggerPaused === paused) return;
  _isLoggerPaused = paused;
  notifyLoggerGovernance();
}

export function setLoggerRemoteConfig(config: { detailLevel?: string; sendIntervalSeconds?: number }): void {
  const nextDetailLevel: FirestoreLoggerDetailLevel = config.detailLevel === "summary" ? "summary" : "complete";
  const nextInterval: 120 | 300 | 600 = config.sendIntervalSeconds === 300 || config.sendIntervalSeconds === 600 ? config.sendIntervalSeconds : 120;
  const changed = nextDetailLevel !== _loggerDetailLevel || nextInterval !== _loggerSendIntervalSeconds;
  _loggerDetailLevel = nextDetailLevel;
  _loggerSendIntervalSeconds = nextInterval;
  if (changed) notifyLoggerGovernance();
}

function generateId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {}
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function pushLog(entry: LogEntry) {
  if (_logs.length >= MAX_LOGS) {
    _logs.shift();
  }
  _logs.push(entry);
}

export function addLog(entry: Omit<LogEntry, "id" | "timestamp">): void {
  if (_isLoggerPaused) return; // Se pausado via appSettings, ignora registro
  
  // Ponto único de registro: alimenta o monitor de consumo em tempo real
  try { recordFirestoreOp(entry.type); } catch {}
  pushLog({
    id: generateId(),
    timestamp: Date.now(),
    ...entry,
  });
}

export function getLogs(): LogEntry[] {
  return [..._logs];
}

export function clearLogs(): void {
  _logs.length = 0;
}

export function getStats(): {
  totalReads: number;
  totalWrites: number;
  totalDeletes: number;
  byCollection: Record<string, { reads: number; writes: number; deletes: number }>;
  bySource: Record<string, { reads: number; writes: number; deletes: number }>;
} {
  let totalReads = 0;
  let totalWrites = 0;
  let totalDeletes = 0;
  const byCollection: Record<string, { reads: number; writes: number; deletes: number }> = {};
  const bySource: Record<string, { reads: number; writes: number; deletes: number }> = {};

  for (const log of _logs) {
    if (log.type === "read") {
      totalReads += log.operation === "getDoc" ? 1 : Math.max(0, log.docsCount || 0);
    }
    if (log.type === "write") totalWrites += 1;
    if (log.type === "delete") totalDeletes += 1;

    if (!byCollection[log.collection]) {
      byCollection[log.collection] = { reads: 0, writes: 0, deletes: 0 };
    }
    if (!bySource[log.operation]) {
      bySource[log.operation] = { reads: 0, writes: 0, deletes: 0 };
    }

    if (log.type === "read") {
      byCollection[log.collection].reads += 1;
      bySource[log.operation].reads += 1;
    }
    if (log.type === "write") {
      byCollection[log.collection].writes += 1;
      bySource[log.operation].writes += 1;
    }
    if (log.type === "delete") {
      byCollection[log.collection].deletes += 1;
      bySource[log.operation].deletes += 1;
    }
  }

  return { totalReads, totalWrites, totalDeletes, byCollection, bySource };
}

/** In-memory ops counter (past 60s window) exposed for rate limiting in AuthContext */
const _opsTimestamps: number[] = [];
const MAX_OPS_TRACKED = 200;

export function getOpsLastMinute(): number {
  const threshold = Date.now() - 60000;
  while (_opsTimestamps.length > 0 && _opsTimestamps[0] < threshold) {
    _opsTimestamps.shift();
  }
  return _opsTimestamps.length;
}

function trackOp() {
  _opsTimestamps.push(Date.now());
  if (_opsTimestamps.length > MAX_OPS_TRACKED) {
    _opsTimestamps.splice(0, _opsTimestamps.length - MAX_OPS_TRACKED);
  }
}

function extractPathInfo(ref: any): { collection: string; docId: string | null } {
  try {
    // Try multiple known extraction paths before falling back to "unknown".
    // Firestore Query objects do not always expose `.path` directly; most of
    // their useful path metadata lives under `_query.path` or `_queryPath`.
    let path = "";
    if (typeof ref === "string") {
      path = ref;
    } else if (ref?.path && typeof ref.path === "string") {
      path = ref.path;
    } else if (ref?._query?.path && typeof ref._query.path.canonicalString === "function") {
      path = ref._query.path.canonicalString();
    } else if (ref?._queryPath && typeof ref._queryPath.canonicalString === "function") {
      path = ref._queryPath.canonicalString();
    } else if (ref?._key?.path && typeof ref._key.path.canonicalString === "function") {
      path = ref._key.path.canonicalString();
    } else if (ref?._path && typeof ref._path.canonicalString === "function") {
      path = ref._path.canonicalString();
    } else if (typeof ref?.canonicalString === "function") {
      path = ref.canonicalString();
    } else if (ref?.converter === null && ref?._query?.collectionGroup) {
      path = ref._query.collectionGroup;
    } else if (ref?.constructor?.name === "DocumentReference" && ref?.id && ref?.parent?.id) {
      path = `${ref.parent.id}/${ref.id}`;
    } else if (ref?.constructor?.name === "CollectionReference" && ref?.id) {
      path = ref.id;
    }
    if (!path) return { collection: "unknown", docId: null };
    const segments = path.split("/").filter(Boolean);
    return {
      collection: segments[0] || "unknown",
      docId: segments.length >= 2 ? segments[1] : null,
    };
  } catch {
    return { collection: "unknown", docId: null };
  }
}

function extractSnapshotCount(snapshot: any): number {
  try {
    if (typeof snapshot?.size === "number") return snapshot.size;
    if (Array.isArray(snapshot?.docs)) return snapshot.docs.length;
    if (typeof snapshot?.exists === "function") return snapshot.exists() ? 1 : 0;
  } catch {}
  return 0;
}

function wrapReadLog(operation: string, ref: any, docsCount: number, details?: string) {
  trackOp();
  const { collection, docId } = extractPathInfo(ref);
  addLog({ type: "read", operation, collection, docId, docsCount, details });
}

function wrapWriteLog(type: "write" | "delete", operation: string, ref: any, docsCount = 1, details?: string) {
  trackOp();
  const { collection, docId } = extractPathInfo(ref);
  addLog({ type, operation, collection, docId, docsCount, details });
}

export const onSnapshot: typeof firebaseOnSnapshot = ((...args: any[]) => {
  const ref = args[0];
  const wrappedArgs = [...args];

  for (let i = 1; i < wrappedArgs.length; i += 1) {
    const candidate = wrappedArgs[i];

    if (typeof candidate === "function") {
      const originalCallback = candidate;
      wrappedArgs[i] = (snapshot: any) => {
        try {
          wrapReadLog("onSnapshot", ref, extractSnapshotCount(snapshot));
        } catch {}
        return originalCallback(snapshot);
      };
      break;
    }

    if (candidate && typeof candidate === "object" && typeof candidate.next === "function") {
      const originalNext = candidate.next;
      wrappedArgs[i] = {
        ...candidate,
        next: (snapshot: any) => {
          try {
            wrapReadLog("onSnapshot", ref, extractSnapshotCount(snapshot));
          } catch {}
          return originalNext(snapshot);
        },
      };
      break;
    }
  }

  return (firebaseOnSnapshot as any)(...wrappedArgs);
}) as typeof firebaseOnSnapshot;

export const setDoc: typeof firebaseSetDoc = ((...args: any[]) => {
  const ref = args[0];
  const result = (firebaseSetDoc as any)(...args);
  Promise.resolve(result).then(() => {
    try { wrapWriteLog("write", "setDoc", ref, 1); } catch {}
  }).catch(() => {});
  return result;
}) as typeof firebaseSetDoc;

export const updateDoc: typeof firebaseUpdateDoc = ((...args: any[]) => {
  const ref = args[0];
  const result = (firebaseUpdateDoc as any)(...args);
  Promise.resolve(result).then(() => {
    try { wrapWriteLog("write", "updateDoc", ref, 1); } catch {}
  }).catch(() => {});
  return result;
}) as typeof firebaseUpdateDoc;

export const addDoc: typeof firebaseAddDoc = ((...args: any[]) => {
  const ref = args[0];
  const result = (firebaseAddDoc as any)(...args);
  Promise.resolve(result).then((docRef: any) => {
    try {
      const info = extractPathInfo(ref);
      addLog({
        type: "write",
        operation: "addDoc",
        collection: info.collection,
        docId: docRef?.id || null,
        docsCount: 1,
      });
    } catch {}
  }).catch(() => {});
  return result;
}) as typeof firebaseAddDoc;

export const deleteDoc: typeof firebaseDeleteDoc = ((...args: any[]) => {
  const ref = args[0];
  const result = (firebaseDeleteDoc as any)(...args);
  Promise.resolve(result).then(() => {
    try { wrapWriteLog("delete", "deleteDoc", ref, 1); } catch {}
  }).catch(() => {});
  return result;
}) as typeof firebaseDeleteDoc;

export const getDoc: typeof firebaseGetDoc = ((...args: any[]) => {
  const ref = args[0];
  const result = (firebaseGetDoc as any)(...args);
  Promise.resolve(result).then((snapshot: any) => {
    try { wrapReadLog("getDoc", ref, extractSnapshotCount(snapshot)); } catch {}
  }).catch(() => {});
  return result;
}) as typeof firebaseGetDoc;

export const getDocs: typeof firebaseGetDocs = ((...args: any[]) => {
  const ref = args[0];
  const result = (firebaseGetDocs as any)(...args);
  Promise.resolve(result).then((snapshot: any) => {
    try { wrapReadLog("getDocs", ref, extractSnapshotCount(snapshot)); } catch {}
  }).catch(() => {});
  return result;
}) as typeof firebaseGetDocs;

// Mantido apenas por compatibilidade; agora não faz monkey-patch no módulo.
export function patchFirestore(_db: Firestore): void {
  if (_isPatched) return;
  _isPatched = true;
}

// Salva o resumo de consumo (getStats) de um usuário específico no Firestore.
// Usa `db` já inicializado externamente para evitar dependência circular.
export async function saveUserLogsToFirestore(
  db: Firestore,
  uid: string,
  stats: ReturnType<typeof getStats>,
  logs: LogEntry[]
): Promise<void> {
  try {
    const userRef = firebaseDoc(db, "user_logs", uid);
    const payload = {
      uid,
      updatedAt: new Date().toISOString(),
      stats: {
        totalReads: stats.totalReads,
        totalWrites: stats.totalWrites,
        totalDeletes: stats.totalDeletes,
        byCollection: stats.byCollection,
      },
      logs: _loggerDetailLevel === "summary" ? [] : logs
        .filter(l => !!l.collection)
        .slice(-REMOTE_LOGS_LIMIT)
        .map(l => ({
          id: l.id,
          timestamp: l.timestamp,
          type: l.type,
          operation: l.operation,
          collection: l.collection,
          docId: l.docId,
          docsCount: l.docsCount,
          details: l.details || null,
        })),
    };
    await firebaseSetDoc(userRef, payload, { merge: true });
  } catch {
    // Silencioso — não quebrar fluxo do app por falha de log
  }
}