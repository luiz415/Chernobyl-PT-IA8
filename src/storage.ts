import type { Character, PartyTab, WaitingService, AppData } from "./types";

const PRIV_CHAR_KEY = "tibia_private_characters";
const PT_KEY = "tibia_parties";
const SHARED_CHAR_KEY = "tibia_shared_characters";
const NOTES_KEY = "tibia_notes";
const WAITING_LIST_KEY = "tibia_waiting_list";


export function loadPrivateCharacters(): Character[] {
  try {
    const raw = localStorage.getItem(PRIV_CHAR_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
export function savePrivateCharacters(chars: Character[]): void {
  localStorage.setItem(PRIV_CHAR_KEY, JSON.stringify(chars));
  saveSharedCharacters(chars.filter(c => c.shared));
}

// --- Characters (Shared) ---
export function loadSharedCharacters(): Character[] {
  try {
    const raw = localStorage.getItem(SHARED_CHAR_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
export function saveSharedCharacters(chars: Character[]): void {
  localStorage.setItem(SHARED_CHAR_KEY, JSON.stringify(chars));
}

// --- Parties ---
export function loadParties(): PartyTab[] {
  try {
    const raw = localStorage.getItem(PT_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
export function saveParties(parties: PartyTab[]): void {
  localStorage.setItem(PT_KEY, JSON.stringify(parties));
}

// --- Waiting List ---
export function loadWaitingList(): WaitingService[] {
  try {
    const raw = localStorage.getItem(WAITING_LIST_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
export function saveWaitingList(items: WaitingService[]): void {
  localStorage.setItem(WAITING_LIST_KEY, JSON.stringify(items));
}

// --- Notes ---
export function loadNotes(): string {
  return localStorage.getItem(NOTES_KEY) || "";
}
export function saveNotes(notes: string): void {
  localStorage.setItem(NOTES_KEY, notes);
}

// --- Wrappers para compatibilidade ---
export function loadData(): AppData {
  return {
    characters: loadPrivateCharacters(),
    parties: loadParties(),
    waitingList: loadWaitingList(),
    notes: loadNotes(),
  };
}
export function saveData(data: AppData): void {
  savePrivateCharacters(data.characters);
  saveParties(data.parties || []);
  saveWaitingList(data.waitingList || []);
  saveNotes(data.notes);
}

// ============================================================================
// AUTO-SAVE & EXPORTAÇÃO — RESPONSABILIDADES SEPARADAS
// ============================================================================
// Firestore é a fonte principal e permanente dos dados SINCRONIZADOS
// (PT's ativas/arquivadas, Lista de Espera, personagens compartilhados,
// notificações, estatísticas/ranking global, presença, etc.). Esses dados
// são recuperados automaticamente após o login e NÃO devem ser duplicados
// no Auto-Save nem na Exportação.
//
// Auto-Save  → camada de SEGURANÇA LOCAL, apenas dados PESSOAIS que ainda
//              não foram sincronizados (personagens, notas e histórico
//              pessoal do ranking). Arquivo enxuto.
// Exportação → backup MANUAL, também apenas dados pessoais úteis à
//              restauração (personagens, notas e ranking pessoal).
//
// Ambos compartilham a MESMA forma de payload (PersonalBackup) para manter
// consistência e permitir importação cruzada.
// ============================================================================

// Snapshot leve e pessoal do ranking do usuário (extraído de userStats/{uid}).
// Não contém dados de outros usuários — apenas os próprios contadores que
// compõem a pontuação, úteis como fallback local de exibição.
export interface PersonalRankingSnapshot {
  rankingScore?: number;
  totalPtsConcluidas?: number;
  totalPtsSoulwar?: number;
  totalPtsSanguine?: number;
  totalParticipacoes?: number;
  totalMortes?: number;
  totalDuracaoMs?: number;
  ptsSemMorte?: number;
  ptsComMorte?: number;
  sequenciaAtualSemMorte?: number;
  maxSequenciaSemMorte?: number;
}

// Estrutura única compartilhada por Auto-Save e Exportação.
// APENAS informações pessoais que fazem sentido restaurar manualmente e/ou
// que servem como backup permanente local. Tudo o que já é sincronizado
// continuamente pelo Firestore (Lista de Espera, PT's ativas, notificações,
// ranking global, personagens compartilhados) fica de fora.
export interface PersonalBackup {
  version: 3;
  kind: "personal_backup";
  exportedAt: string;
  ownerName?: string;
  // Personagens privados do usuário (inclui histórico de venda: campo `vendido`)
  characters: Character[];
  // Anotações pessoais (aba Notas)
  notes: string;
  // Histórico de PT's. Campo mantido por compatibilidade do formato v3:
  // novos backups sempre gravam [] — o histórico oficial vive no Firestore
  // (projeção privada users/{uid}/partyHistory, gravada pelo backend) e não
  // faz mais parte do backup local. O campo só é lido na importação de
  // arquivos antigos.
  archivedHistory: PartyTab[];
}

// Monta o payload pessoal usado tanto pelo Auto-Save quanto pela Exportação.
// `characters` deve conter a lista COMPLETA de personagens do usuário
// (ativos + histórico de vendidos). `notes` são as anotações pessoais.
// `archivedHistory` é sempre [] no fluxo atual (mantido por compatibilidade
// do formato v3).
export function buildPersonalBackup(
  characters: Character[],
  notes: string,
  archivedHistory?: PartyTab[],
  ownerName?: string
): PersonalBackup {
  return {
    version: 3,
    kind: "personal_backup",
    exportedAt: new Date().toISOString(),
    ownerName: ownerName || undefined,
    characters: Array.isArray(characters) ? characters : [],
    notes: notes || "",
    archivedHistory: Array.isArray(archivedHistory) ? archivedHistory : [],
  };
}

// --- Utils ---
// Exportação manual: grava APENAS o backup pessoal (personagens + notas +
// histórico de PT's). Lista de Espera, PT's ativas, ranking, notificações e
// dados compartilhados NÃO são exportados por já serem sincronizados
// permanentemente pelo Firestore.
export function exportJSON(backup: PersonalBackup): void {
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  triggerDownload(blob, `chernobyl-team-${dateStamp()}.json`);
}

// Normaliza qualquer arquivo importado (formatos novo v3 / v2 / legado) para o
// conjunto de dados PESSOAIS restauráveis. Ignora deliberadamente
// parties(ativas)/waitingList/ranking: esses dados vêm do Firestore e não
// devem sobrescrever o estado sincronizado. O histórico de PT's é aceito
// tanto do campo novo `archivedHistory` quanto de `parties` arquivadas
// presentes em backups legados (apenas as com `archived === true`).
export function normalizeImportedBackup(raw: any): { characters: Character[]; notes: string; archivedHistory: PartyTab[] } {
  const characters: Character[] = Array.isArray(raw?.characters) ? raw.characters : [];
  const notes: string = typeof raw?.notes === "string" ? raw.notes : "";
  let archivedHistory: PartyTab[] = [];
  if (Array.isArray(raw?.archivedHistory)) {
    archivedHistory = (raw.archivedHistory as PartyTab[]).map(p => ({ ...p, archived: true }));
  } else if (Array.isArray(raw?.parties)) {
    // Backup legado: aproveita apenas as PT's já arquivadas.
    archivedHistory = (raw.parties as PartyTab[]).filter(p => !!p.archived).map(p => ({ ...p, archived: true }));
  }
  return { characters, notes, archivedHistory };
}

export function importJSON(file: File): Promise<any> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try { resolve(JSON.parse(reader.result as string)); } catch (e) { reject(e); }
    };
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

function dateStamp(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function csvEscape(v: unknown): string {
  const s = String(v ?? "");
  if (/[",\n;]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function exportCSV(data: AppData): void {
  const headers = [
    "Account", "Personagem", "Servidor", "Voc", "Level",
    "SoulWar", "Sanguine", "Valor pago", "Drop SW", "Drop Bakra",
    "Valor de venda", "Total", "Data de compra", "Vendido", "Data de venda"
  ];
  const rows = (data.characters || []).map((c: Character) => {
    const total = (c.dropSW + c.dropBakra + c.valorVenda) - c.valorPago;
    return [
      c.account, c.personagem, c.servidor, c.voc, c.level,
      c.soulwar ? "Sim" : "Não",
      c.sanguine ? "Sim" : "Não",
      c.valorPago, c.dropSW, c.dropBakra, c.valorVenda, total,
      c.dataCompra || "", c.vendido ? "Sim" : "Não", c.dataVenda || "",
    ].map(csvEscape).join(",");
  });
  const csv = [headers.join(","), ...rows].join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  triggerDownload(blob, `tibia-chars-${dateStamp()}.csv`);
}

export function loadUIState<T>(key: string, defaultVal: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : defaultVal;
  } catch { return defaultVal; }
}

export function saveUIState<T>(key: string, val: T): void {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

const DB_NAME = "TibiaCharManagerDB";
function getDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore("handles"); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveAutoSaveHandle(handle: any): Promise<void> {
  try {
    const db = await getDB();
    const tx = db.transaction("handles", "readwrite");
    tx.objectStore("handles").put(handle, "autosave_handle");
    return new Promise((resolve) => { tx.oncomplete = () => resolve(); });
  } catch (e) { console.error("Erro ao salvar handle no IndexedDB", e); }
}

export async function loadAutoSaveHandle(): Promise<any | null> {
  try {
    const db = await getDB();
    return new Promise((resolve) => {
      const tx = db.transaction("handles", "readonly");
      const req = tx.objectStore("handles").get("autosave_handle");
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch { return null; }
}

import type { Notification } from "./types/notifications";

export function loadNotifications(): Notification[] {
  try {
    const raw = localStorage.getItem("tibia_notifications");
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

export function saveNotifications(n: Notification[]): void {
  try { localStorage.setItem("tibia_notifications", JSON.stringify(n)); window.dispatchEvent(new Event("storage")); } catch {}
}

export function loadNotificationHistory(): Notification[] {
  try {
    const raw = localStorage.getItem("tibia_notifications_history");
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

export function saveNotificationHistory(n: Notification[]): void {
  try { localStorage.setItem("tibia_notifications_history", JSON.stringify(n)); window.dispatchEvent(new Event("storage")); } catch {}
}

export function loadDesktopNotifyPref(): boolean {
  try { const raw = localStorage.getItem("tibia_notify_desktop"); return raw !== null ? JSON.parse(raw) : true; } catch { return true; }
}

export function saveDesktopNotifyPref(v: boolean): void {
  try { localStorage.setItem("tibia_notify_desktop", JSON.stringify(v)); window.dispatchEvent(new Event("storage")); } catch {}
}

export function loadCloseTray(): boolean {
  try { const raw = localStorage.getItem("tibia_close_to_tray"); return raw !== null ? JSON.parse(raw) : true; } catch { return true; }
}

export function saveCloseTray(v: boolean): void {
  try { localStorage.setItem("tibia_close_to_tray", JSON.stringify(v)); window.dispatchEvent(new Event("storage")); } catch {}
}

export function loadStartWithWindows(): boolean {
  try { const raw = localStorage.getItem("tibia_start_with_windows"); return raw !== null ? JSON.parse(raw) : false; } catch { return false; }
}

export function saveStartWithWindows(v: boolean): void {
  try { localStorage.setItem("tibia_start_with_windows", JSON.stringify(v)); window.dispatchEvent(new Event("storage")); } catch {}
}

export function loadLowCpuUsage(): boolean {
  try { const raw = localStorage.getItem("tibia_low_cpu_usage"); return raw !== null ? JSON.parse(raw) : false; } catch { return false; }
}

export function saveLowCpuUsage(v: boolean): void {
  try { localStorage.setItem("tibia_low_cpu_usage", JSON.stringify(v)); window.dispatchEvent(new Event("storage")); } catch {}
}

// ============================================================================
// CACHE COM TTL — Personagens Compartilhados (sharedCharacters)
// ============================================================================
// Substitui o listener global (onSnapshot) por carregamento sob demanda com
// cache local + TTL (Time To Live). Os dados são considerados "frescos" por
// até SHARED_CHARS_TTL_MS; após esse período, uma nova leitura (getDocs) é
// necessária. Reduz drasticamente as leituras no Firestore.
// ============================================================================
const SHARED_CHARS_CACHE_KEY = "cloud_cache_sharedCharacters";
const SHARED_CHARS_CACHE_TS_KEY = "cloud_cache_sharedCharacters_ts";
// TTL de 10 minutos (dentro da faixa solicitada de 5 a 15 minutos)
export const SHARED_CHARS_TTL_MS = 10 * 60 * 1000;

// Carrega o cache de personagens compartilhados.
// Retorna { data, fresh, age }:
//   - data: array de personagens em cache (ou [] se ausente)
//   - fresh: true se o cache ainda está dentro do TTL
//   - age: idade do cache em ms (Infinity se ausente)
export function loadSharedCharsCache(): { data: Character[]; fresh: boolean; age: number } {
  try {
    const raw = localStorage.getItem(SHARED_CHARS_CACHE_KEY);
    const tsRaw = localStorage.getItem(SHARED_CHARS_CACHE_TS_KEY);
    const data: Character[] = raw ? JSON.parse(raw) : [];
    const ts = tsRaw ? parseInt(tsRaw, 10) || 0 : 0;
    const age = ts > 0 ? Date.now() - ts : Infinity;
    const fresh = ts > 0 && age < SHARED_CHARS_TTL_MS;
    return { data: Array.isArray(data) ? data : [], fresh, age };
  } catch {
    return { data: [], fresh: false, age: Infinity };
  }
}

// Salva o cache de personagens compartilhados + carimbo de tempo (TTL).
export function saveSharedCharsCache(chars: Character[]): void {
  try {
    localStorage.setItem(SHARED_CHARS_CACHE_KEY, JSON.stringify(chars));
    localStorage.setItem(SHARED_CHARS_CACHE_TS_KEY, String(Date.now()));
  } catch {}
}

// Verifica se o cache de personagens compartilhados está válido (dentro do TTL).
export function isSharedCharsCacheFresh(): boolean {
  try {
    const tsRaw = localStorage.getItem(SHARED_CHARS_CACHE_TS_KEY);
    const ts = tsRaw ? parseInt(tsRaw, 10) || 0 : 0;
    return ts > 0 && (Date.now() - ts) < SHARED_CHARS_TTL_MS;
  } catch { return false; }
}

// Invalida o cache (força nova leitura no próximo acesso).
export function invalidateSharedCharsCache(): void {
  try {
    localStorage.removeItem(SHARED_CHARS_CACHE_TS_KEY);
  } catch {}
}