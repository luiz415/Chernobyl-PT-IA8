// ============================================================================
// COTAÇÃO DO RUBINI COIN POR SERVIDOR — fonte única do módulo Bazaar
// ----------------------------------------------------------------------------
// A RC tem valor DIFERENTE em cada servidor, então a conversão kk → RC deixa
// de depender de uma taxa fixa única: cada servidor tem a SUA cotação,
// configurada pelo Boss no modal "Lista de Itens" (ou no modal "Ver" de um
// personagem — mesmo armazenamento).
//
// SEMÂNTICA (inalterada): a cotação segue a convenção histórica do app —
// "Coin (k)" = quantos k equivalem a 1000 RC — e a conversão continua sendo
// feita EXCLUSIVAMENTE pela função canônica `computeItemRC` de
// `utils/itemSale.ts` (floor(kk ÷ cotação × 1000)). Nenhuma fórmula nova.
//
// PERSISTÊNCIA: `users/{uid}.bazaarCoinRates` no Firestore (mapa
// chave-do-servidor → cotação), gravado pelo próprio usuário (mesma
// permissão já usada por `serviceFormConfig`). Um ESPELHO local
// (localStorage, por usuário) garante leitura síncrona nos cálculos e
// funcionamento no modo simulação — o Firestore é a fonte durável.
//
// SEM FALLBACK: servidor sem cotação configurada retorna 0 — os cálculos
// exibem "—" (dado indisponível), exatamente como o app sempre tratou a
// ausência de cotação. NUNCA herdamos a taxa de outro servidor nem a taxa
// fixa legada (`rubinot_bazaar_items_coin_rate`).
// ============================================================================

import { loadUIState, saveUIState } from "../storage";
import { serverKey } from "../constants/servers";
import { db, isSimulationMode, getDoc, updateDoc, setDoc } from "../firebase/config";
import { doc } from "firebase/firestore";

/** Mapa chave-do-servidor (serverKey) → cotação em k por 1000 RC. */
export type BazaarCoinRates = Record<string, number>;

const BAZAAR_COIN_RATES_KEY_PREFIX = "rubinot_bazaar_coin_rates_";

function localKey(uid?: string): string {
  return `${BAZAAR_COIN_RATES_KEY_PREFIX}${uid || "anon"}`;
}

/** Arredonda a 1 casa decimal (mesma precisão da cotação histórica). */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Sanitiza um valor cru (Firestore/localStorage): somente pares
 * chave-string → número finito > 0 sobrevivem; qualquer lixo é descartado.
 */
export function sanitizeCoinRates(raw: unknown): BazaarCoinRates {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const clean: BazaarCoinRates = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const rate = Number(value);
    if (typeof key === "string" && key.trim() && Number.isFinite(rate) && rate > 0) {
      clean[key] = round1(rate);
    }
  }
  return clean;
}

/** Espelho local (leitura síncrona para os cálculos). */
export function readLocalCoinRates(uid?: string): BazaarCoinRates {
  return sanitizeCoinRates(loadUIState<unknown>(localKey(uid), null));
}

/** Atualiza o espelho local (chamado após carregar/gravar no Firestore). */
export function writeLocalCoinRates(uid: string | undefined, rates: BazaarCoinRates): void {
  saveUIState(localKey(uid), sanitizeCoinRates(rates));
}

/**
 * Cotação do servidor (k por 1000 RC). 0 = NÃO CONFIGURADA — o chamador
 * exibe "—"/mensagem, nunca inventa conversão (sem fallback entre
 * servidores, sem taxa fixa legada).
 */
export function getServerCoinRate(rates: BazaarCoinRates, server: string | undefined | null): number {
  if (!server) return 0;
  const rate = rates[serverKey(String(server))];
  return Number.isFinite(rate) && (rate as number) > 0 ? (rate as number) : 0;
}

/** Aplica (rate > 0) ou REMOVE (rate inválida/<= 0) a cotação de um servidor. */
export function withServerCoinRate(rates: BazaarCoinRates, server: string, rate: number | null): BazaarCoinRates {
  const key = serverKey(String(server || ""));
  const next: BazaarCoinRates = { ...sanitizeCoinRates(rates) };
  if (!key) return next;
  if (rate !== null && Number.isFinite(rate) && rate > 0) next[key] = round1(rate);
  else delete next[key];
  return next;
}

/**
 * Carrega as cotações persistidas do usuário (Firestore ou, no modo
 * simulação, `tibia_sim_users`) e atualiza o espelho local. Falha de rede →
 * devolve o espelho local (nunca lança).
 */
export async function fetchCoinRates(uid: string | undefined): Promise<BazaarCoinRates> {
  if (!uid) return {};
  try {
    if (isSimulationMode || !db) {
      const raw = localStorage.getItem("tibia_sim_users");
      const parsed: Array<{ uid?: string; bazaarCoinRates?: unknown }> = raw ? JSON.parse(raw) : [];
      const me = parsed.find(u => u.uid === uid);
      const rates = sanitizeCoinRates(me?.bazaarCoinRates);
      writeLocalCoinRates(uid, rates);
      return rates;
    }
    const snap = await getDoc(doc(db, "users", uid));
    const rates = sanitizeCoinRates(snap.exists() ? (snap.data() as { bazaarCoinRates?: unknown }).bazaarCoinRates : undefined);
    writeLocalCoinRates(uid, rates);
    return rates;
  } catch {
    return readLocalCoinRates(uid);
  }
}

/**
 * PERSISTE o mapa completo de cotações do usuário: espelho local na hora
 * (cálculos refletem imediatamente) + Firestore/`tibia_sim_users` como
 * fonte durável. O campo é gravado por inteiro (substituição) para que
 * remoções de cotação também sejam persistidas.
 */
export async function persistCoinRates(uid: string | undefined, rates: BazaarCoinRates): Promise<void> {
  const clean = sanitizeCoinRates(rates);
  writeLocalCoinRates(uid, clean);
  if (!uid) return;
  if (isSimulationMode || !db) {
    try {
      const raw = localStorage.getItem("tibia_sim_users");
      const parsed: Array<Record<string, unknown>> = raw ? JSON.parse(raw) : [];
      const next = parsed.map(u => (u.uid === uid ? { ...u, bazaarCoinRates: clean } : u));
      localStorage.setItem("tibia_sim_users", JSON.stringify(next));
    } catch { /* espelho local já garante o funcionamento nesta sessão */ }
    return;
  }
  try {
    await updateDoc(doc(db, "users", uid), { bazaarCoinRates: clean });
  } catch {
    // Doc inexistente (cenário raro) — cria/mescla sem tocar outros campos.
    // Falha aqui também não pode derrubar a UI: o espelho local já foi
    // gravado e a próxima gravação bem-sucedida reenvia o mapa completo.
    try {
      await setDoc(doc(db, "users", uid), { bazaarCoinRates: clean }, { merge: true });
    } catch { /* silencioso — espelho local garante esta sessão */ }
  }
}
