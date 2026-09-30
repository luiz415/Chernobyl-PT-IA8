// ============================================================================
// HISTÓRICO OFICIAL DO BAZAAR — publicação e sincronização (Firestore)
// ----------------------------------------------------------------------------
// A tela "Estatísticas do Bazaar" é acessível a TODOS os usuários do painel
// (VIP/Boss), mas somente o Boss consegue CONSULTAR o histórico (Electron +
// sessão). Para os demais dispositivos/usuários verem as estatísticas, a
// última consulta é publicada num ÚNICO documento (`bazaar/history`) — o
// mesmo padrão de doc único da lista oficial (`bazaar/current`).
//
// CUSTO SOB CONTROLE:
//   • 1 escrita por consulta do histórico (setDoc de doc único);
//   • 1 leitura por dispositivo, com cache local + intervalo mínimo entre
//     verificações (o cache responde na hora; a releitura só acontece após
//     o TTL ou com `force`).
//
// Este serviço é INDEPENDENTE do bazaarOfficialService: o histórico nunca
// toca `bazaar/current`/`bazaar/metadata` nem os interesses/notificações.
//
// ATENÇÃO (deploy manual): `firestore.rules` precisa permitir a escrita do
// Boss no docId 'history' (whitelist do match /bazaar/{docId}).
// ============================================================================

import { doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "../firebase/config";
import type { BazaarHistoryLastQuery } from "../utils/bazaarHistoryStats";

const HISTORY_DOC_PATH = ["bazaar", "history"] as const;
const HISTORY_CACHE_KEY = "rubinot_bazaar_history_official_cache";
const HISTORY_CHECK_KEY = "rubinot_bazaar_history_official_checked_at";
/** Intervalo mínimo entre releituras automáticas do doc publicado. */
const HISTORY_SYNC_TTL_MS = 10 * 60 * 1000;

export interface OfficialBazaarHistoryCache {
  query: BazaarHistoryLastQuery;
  /** Momento em que este dispositivo baixou o doc publicado. */
  loadedAtMs: number;
}

function now(): number {
  return Date.now();
}

function readNumber(key: string): number {
  try {
    const value = Number(localStorage.getItem(key) || 0);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function writeNumber(key: string, value: number): void {
  try { localStorage.setItem(key, String(value)); } catch { /* storage cheio/indisponível */ }
}

export function readOfficialHistoryCache(): OfficialBazaarHistoryCache | null {
  try {
    const raw = localStorage.getItem(HISTORY_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.query || !Array.isArray(parsed.query.entries)) return null;
    return parsed as OfficialBazaarHistoryCache;
  } catch {
    return null;
  }
}

function writeOfficialHistoryCache(cache: OfficialBazaarHistoryCache): void {
  try { localStorage.setItem(HISTORY_CACHE_KEY, JSON.stringify(cache)); } catch { /* storage cheio */ }
}

/**
 * Publica a última consulta do histórico (Boss). Documento ÚNICO, sobrescrito
 * a cada consulta — 1 escrita, nenhum dado redundante além do necessário para
 * a tela de estatísticas.
 */
export async function publishBazaarHistory(query: BazaarHistoryLastQuery): Promise<{ ok: boolean; error?: string }> {
  if (!db) return { ok: false, error: "Firestore indisponível." };
  try {
    await setDoc(doc(db, HISTORY_DOC_PATH[0], HISTORY_DOC_PATH[1]), {
      ...query,
      publishedAtMs: now(),
    });
    // O dispositivo que publicou já tem o dado mais novo: atualiza o cache
    // local do doc publicado para não reler o que acabou de escrever.
    writeOfficialHistoryCache({ query, loadedAtMs: now() });
    writeNumber(HISTORY_CHECK_KEY, now());
    return { ok: true };
  } catch (error: any) {
    return { ok: false, error: String(error?.message || error) };
  }
}

/**
 * Sincroniza o histórico publicado. Cache local responde imediatamente;
 * a releitura do Firestore só acontece após o TTL (ou com `force`).
 */
export async function syncBazaarHistory(options: { force?: boolean } = {}): Promise<{ cache: OfficialBazaarHistoryCache | null; changed: boolean; error?: string }> {
  const local = readOfficialHistoryCache();
  if (!db) return { cache: local, changed: false, error: "Firestore indisponível." };
  if (!options.force && local && now() - readNumber(HISTORY_CHECK_KEY) < HISTORY_SYNC_TTL_MS) {
    return { cache: local, changed: false };
  }
  try {
    const snap = await getDoc(doc(db, HISTORY_DOC_PATH[0], HISTORY_DOC_PATH[1]));
    writeNumber(HISTORY_CHECK_KEY, now());
    if (!snap.exists()) return { cache: local, changed: false };
    const data = snap.data() as any;
    if (!data || !Array.isArray(data.entries)) return { cache: local, changed: false };
    // Mesmo carimbo da consulta = nada mudou; evita reescrever o cache.
    if (local && Number(local.query?.fetchedAtMs || 0) === Number(data.fetchedAtMs || 0)) {
      return { cache: local, changed: false };
    }
    const query: BazaarHistoryLastQuery = {
      schemaVersion: Number(data.schemaVersion || 1),
      fetchedAtMs: Number(data.fetchedAtMs || 0),
      durationMs: Number(data.durationMs || 0),
      listedCount: Number(data.listedCount || 0),
      approvedCount: Number(data.approvedCount || 0),
      analyzedCount: Number(data.analyzedCount || 0),
      failedCount: Number(data.failedCount || 0),
      stoppedManually: data.stoppedManually === true,
      coinRateKk: Number(data.coinRateKk || 0),
      entries: data.entries,
    };
    const cache: OfficialBazaarHistoryCache = { query, loadedAtMs: now() };
    writeOfficialHistoryCache(cache);
    return { cache, changed: true };
  } catch (error: any) {
    return { cache: local, changed: false, error: String(error?.message || error) };
  }
}
