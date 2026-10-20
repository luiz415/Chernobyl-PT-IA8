// ============================================================================
// COTAÇÃO DO RUBINI COIN POR SERVIDOR — fonte única GLOBAL do aplicativo
// ----------------------------------------------------------------------------
// A RC tem valor DIFERENTE em cada servidor, então a conversão kk → RC deixa
// de depender de uma taxa fixa única: cada servidor tem a SUA cotação,
// configurada pelo Boss no modal "RC Servidores" do cabeçalho OU no modal
// "Lista de Itens" do Bazaar (ou no modal "Ver" de um personagem) — TODOS
// gravam o MESMO armazenamento; não existem taxas independentes por tela.
//
// SEMÂNTICA (inalterada): a cotação segue a convenção histórica do app —
// "Coin (k)" = quantos k equivalem a 1000 RC — e a conversão continua sendo
// feita EXCLUSIVAMENTE pela função canônica `computeItemRC` de
// `utils/itemSale.ts` (floor(kk ÷ cotação × 1000)). Nenhuma fórmula nova.
//
// PERSISTÊNCIA (53ª tarefa — GLOBAL): campo `serverCoinRates` no documento
// `appSettings/global` (mapa chave-do-servidor → cotação). As Security Rules
// JÁ DEPLOYADAS desse caminho garantem no BACKEND que somente o Boss grava
// (`allow create, update, delete: if isBoss()`); todos os usuários aprovados
// leem. O listener onSnapshot de `appSettings/global` que o App já mantém
// para TODOS os usuários entrega as cotações em tempo real (dispositivos
// sincronizados) SEM nenhuma leitura adicional ao Firestore. Um ESPELHO
// local (localStorage, único/global) garante leitura síncrona nos cálculos
// e funcionamento no modo simulação — o Firestore é a fonte durável.
//
// LEGADO (45ª tarefa): as cotações viviam em `users/{uid}.bazaarCoinRates`.
// MIGRAÇÃO SEGURA: quando o doc global ainda NÃO tem cotações e o usuário
// possui o mapa legado, ele é reutilizado e (se o usuário for Boss — as
// rules decidem) promovido ao doc global UMA vez. Um mapa global já
// preenchido NUNCA é sobrescrito pelo legado.
//
// SEM FALLBACK DE VALOR: servidor sem cotação configurada retorna 0 — os
// cálculos exibem "—" (dado indisponível). NUNCA herdamos a taxa de outro
// servidor nem a taxa fixa legada (`rubinot_bazaar_items_coin_rate`).
// ============================================================================

import { loadUIState, saveUIState } from "../storage";
import { serverKey } from "../constants/servers";
import { db, isSimulationMode, getDoc, updateDoc, setDoc } from "../firebase/config";
import { doc } from "firebase/firestore";

/** Mapa chave-do-servidor (serverKey) → cotação em k por 1000 RC. */
export type BazaarCoinRates = Record<string, number>;

/** Espelho local GLOBAL (as cotações valem para o app inteiro, não por uid). */
const SERVER_COIN_RATES_LOCAL_KEY = "rubinot_server_coin_rates_global";
/** Chave do espelho LEGADO por usuário (45ª) — lida apenas como migração. */
const LEGACY_LOCAL_KEY_PREFIX = "rubinot_bazaar_coin_rates_";
/** Durabilidade no modo simulação (sem Firestore). */
const SIM_STORE_KEY = "tibia_sim_server_coin_rates";

/**
 * Evento DOM disparado sempre que o espelho local muda (gravação local ou
 * snapshot do Firestore via listener do App). Componentes com estado próprio
 * (ex.: BazaarItemsPanel) escutam para refletir em tempo real alterações
 * feitas em OUTRO modal — sem nenhuma consulta nova.
 */
export const SERVER_COIN_RATES_EVENT = "rubinot:server-coin-rates";

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

/** Espelho local (leitura síncrona para os cálculos de QUALQUER usuário). */
export function readLocalCoinRates(): BazaarCoinRates {
  return sanitizeCoinRates(loadUIState<unknown>(SERVER_COIN_RATES_LOCAL_KEY, null));
}

/** Espelho LEGADO por usuário (45ª) — usado somente na migração de leitura. */
export function readLegacyLocalCoinRates(uid?: string): BazaarCoinRates {
  return sanitizeCoinRates(loadUIState<unknown>(`${LEGACY_LOCAL_KEY_PREFIX}${uid || "anon"}`, null));
}

/**
 * Atualiza o espelho local e NOTIFICA os componentes abertos (evento DOM).
 * Chamado pelo listener de `appSettings/global` do App e pelas gravações.
 */
export function writeLocalCoinRates(rates: BazaarCoinRates): void {
  saveUIState(SERVER_COIN_RATES_LOCAL_KEY, sanitizeCoinRates(rates));
  try {
    window.dispatchEvent(new CustomEvent(SERVER_COIN_RATES_EVENT));
  } catch { /* ambientes sem window/CustomEvent (testes) — espelho já gravado */ }
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
 * Carrega as cotações GLOBAIS persistidas (appSettings/global.serverCoinRates
 * ou, no modo simulação, o armazenamento local) e atualiza o espelho.
 * `uid` é usado APENAS para a migração do mapa legado por usuário (45ª):
 * se o global ainda estiver vazio e o legado tiver cotações, o legado é
 * reutilizado e promovido ao global (a promoção só é aceita pelo backend
 * quando o usuário é Boss — as rules decidem; nunca sobrescreve um global
 * já preenchido). Falha de rede → devolve o espelho local (nunca lança).
 */
export async function fetchCoinRates(uid?: string): Promise<BazaarCoinRates> {
  try {
    if (isSimulationMode || !db) {
      let rates = sanitizeCoinRates(loadUIState<unknown>(SIM_STORE_KEY, null));
      if (Object.keys(rates).length === 0) {
        // Migração sim: legado por usuário (tibia_sim_users.bazaarCoinRates).
        try {
          const raw = localStorage.getItem("tibia_sim_users");
          const parsed: Array<{ uid?: string; bazaarCoinRates?: unknown }> = raw ? JSON.parse(raw) : [];
          const me = parsed.find(u => u.uid === uid);
          rates = sanitizeCoinRates(me?.bazaarCoinRates);
          if (Object.keys(rates).length > 0) saveUIState(SIM_STORE_KEY, rates);
        } catch { /* sem legado sim */ }
      }
      writeLocalCoinRates(rates);
      return rates;
    }
    const globalSnap = await getDoc(doc(db, "appSettings", "global"));
    let rates = sanitizeCoinRates(globalSnap.exists() ? (globalSnap.data() as { serverCoinRates?: unknown }).serverCoinRates : undefined);
    if (Object.keys(rates).length === 0 && uid) {
      // Global vazio → reutiliza o mapa LEGADO do usuário (45ª) e tenta
      // promovê-lo ao doc global (gravação única; aceita apenas para Boss).
      let legacy = readLegacyLocalCoinRates(uid);
      if (Object.keys(legacy).length === 0) {
        try {
          const userSnap = await getDoc(doc(db, "users", uid));
          legacy = sanitizeCoinRates(userSnap.exists() ? (userSnap.data() as { bazaarCoinRates?: unknown }).bazaarCoinRates : undefined);
        } catch { /* sem legado remoto */ }
      }
      if (Object.keys(legacy).length > 0) {
        rates = legacy;
        try {
          await updateDoc(doc(db, "appSettings", "global"), { serverCoinRates: legacy });
        } catch { /* não-Boss (rules) ou offline — segue com a leitura local */ }
      }
    }
    writeLocalCoinRates(rates);
    return rates;
  } catch {
    return readLocalCoinRates();
  }
}

/**
 * PERSISTE o mapa completo de cotações GLOBAIS: espelho local na hora
 * (cálculos e modais refletem imediatamente, via evento) + Firestore
 * (`appSettings/global.serverCoinRates`) como fonte durável. O campo é
 * gravado por inteiro (substituição) para que remoções de cotação também
 * sejam persistidas. No backend, as Security Rules de `appSettings` só
 * aceitam a gravação de usuários Boss — chamadas de outros perfis falham
 * silenciosamente no servidor (e a UI de edição nem é exibida a eles).
 */
export async function persistCoinRates(rates: BazaarCoinRates): Promise<void> {
  const clean = sanitizeCoinRates(rates);
  writeLocalCoinRates(clean);
  if (isSimulationMode || !db) {
    try { saveUIState(SIM_STORE_KEY, clean); } catch { /* espelho local já garante a sessão */ }
    return;
  }
  try {
    await updateDoc(doc(db, "appSettings", "global"), { serverCoinRates: clean });
  } catch {
    // Doc inexistente (cenário raro) — cria/mescla sem tocar outros campos.
    // Falha aqui também não pode derrubar a UI: o espelho local já foi
    // gravado e a próxima gravação bem-sucedida reenvia o mapa completo.
    try {
      await setDoc(doc(db, "appSettings", "global"), { serverCoinRates: clean }, { merge: true });
    } catch { /* silencioso — espelho local garante esta sessão */ }
  }
}
