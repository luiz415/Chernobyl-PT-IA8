// ─────────────────────────────────────────────────────────────────────────────
// ÚLTIMOS BIDS (121ª tarefa) — histórico LOCAL dos últimos personagens
// marcados como "Tenho Interesse", exibido na guia "Últimos Bids" do modal
// "Próximo Bid" (NextBidTracker).
//
// PRINCÍPIOS (requisitos da tarefa):
//   • SNAPSHOT no instante da marcação: cada registro congela os dados do
//     personagem (nome, vocação, level, servidor, categoria Quest/Item,
//     valor dos itens em kk/RC quando aplicável, encerramento e link) no
//     momento em que o interesse foi registrado. NADA aqui relê dados
//     atuais: alterações posteriores no personagem NUNCA modificam um
//     snapshot já gravado (os campos são copiados por valor na gravação).
//   • GRAVAÇÃO SÓ NA AÇÃO EXPLÍCITA do usuário: quem chama
//     `recordLastBidSnapshot` são exclusivamente os handlers de "Tenho
//     Interesse" (guia de Quests do Painel Bazaar e guia de Itens).
//     Sincronizações automáticas, reprecificações e reabertura do modal
//     JAMAIS criam registros — por construção, não há caminho de escrita
//     fora da ação de marcar/desmarcar (zero duplicação por sync).
//   • SINCRONIA COM OS INTERESSES: desmarcar remove o(s) registro(s)
//     correspondente(s) (inclusive a remoção automática em lote do
//     "Atualizar Valores"); marcar novamente cria um snapshot NOVO (data/
//     hora novas — o anterior do MESMO personagem na MESMA categoria é
//     substituído, nunca reaproveitado). Registros de outros personagens
//     não são afetados.
//   • LIMITE: só os `LAST_BIDS_LIMIT` (10) registros mais recentes são
//     mantidos (poda na gravação E na leitura), ordenados do mais recente
//     para o mais antigo pela data da marcação.
//   • PERSISTÊNCIA: 100% LOCAL por uid (localStorage via loadUIState/
//     saveUIState — o MESMO mecanismo dos interesses da guia Itens e das
//     personalizações do modal "Ver"). ZERO leituras/escritas no Firebase:
//     nenhuma Cloud Function é necessária (não há dado compartilhado novo
//     nem regra de acesso a validar — o histórico é um espelho pessoal do
//     próprio dispositivo, como os demais caches locais do Bazaar).
//   • REATIVIDADE: toda gravação dispara BAZAAR_LAST_BIDS_UPDATED_EVENT
//     (CustomEvent local — o evento "storage" não dispara na janela que
//     gravou), no MESMO padrão dos eventos locais de bazaarWatchedItems.
// ─────────────────────────────────────────────────────────────────────────────
import { loadUIState, saveUIState } from "../storage";
import { canonicalServerKey } from "./bazaarWatchedItems";

/** Máximo de registros mantidos/exibidos (requisito: últimos 10). */
export const LAST_BIDS_LIMIT = 10;

/** Prefixo da chave local (uma lista por uid — mesma convenção das demais). */
export const BAZAAR_LAST_BIDS_KEY_PREFIX = "rubinot_bazaar_last_bids_";

/** Aviso LOCAL de que o histórico mudou (mesma janela — padrão do app). */
export const BAZAAR_LAST_BIDS_UPDATED_EVENT = "bazaar-last-bids-updated";

/** Chave local do histórico de um usuário. */
export function lastBidsStorageKey(uid: string | undefined): string {
  return `${BAZAAR_LAST_BIDS_KEY_PREFIX}${uid || "anon"}`;
}

/**
 * UM registro do histórico — snapshot IMUTÁVEL do instante da marcação.
 * `origin` é a categoria exibida no card: "quest" = guia Personagens Para
 * SW/SG/GB; "item" = guia Personagens Com Itens (Boss).
 */
export interface LastBidSnapshot {
  /** Chave do leilão NO MOMENTO da marcação (id > url > nome — a mesma
   *  getAuctionKey do painel); usada na remoção ao desmarcar. */
  auctionKey: string;
  /** Categoria do interesse (badge Quest/Item do card). */
  origin: "quest" | "item";
  name: string;
  vocation: string;
  level: number;
  server: string;
  /** Link do leilão no instante da marcação. */
  url: string;
  /** Encerramento normalizado (unix s) congelado; null = desconhecido. */
  endTs: number | null;
  /** Total dos itens (kk) exibido no instante da marcação; null = sem itens. */
  valueKk: number | null;
  /** Conversão em RC no instante da marcação (cotação da época); null = não
   *  aplicável (sem itens ou sem cotação válida — nunca inventada). */
  valueRc: number | null;
  /** Momento da marcação (ms época local) — ordenação e destaque do card. */
  markedAtMs: number;
}

/** Par nome+servidor normalizado — MESMA normalização dos interesses da guia
 *  Itens (nome caixa-insensível + canonicalServerKey caixa-insensível). */
export function lastBidPairKey(name: string | undefined, server: string | undefined): string {
  const nameKey = String(name || "").trim().toLowerCase();
  const serverPart = canonicalServerKey(String(server || "")).toLowerCase();
  return nameKey && serverPart ? `${nameKey}|${serverPart}` : "";
}

/** true quando o registro corresponde ao alvo (mesma categoria + mesmo leilão
 *  OU mesmo personagem nome+servidor — o leilão repostado ganha id novo, a
 *  MESMA regra dos interesses da guia Itens). */
function snapshotMatchesTarget(
  snapshot: LastBidSnapshot,
  target: { origin: "quest" | "item"; auctionKey?: string; name?: string; server?: string },
): boolean {
  if (snapshot.origin !== target.origin) return false;
  if (target.auctionKey && snapshot.auctionKey && snapshot.auctionKey === target.auctionKey) return true;
  const targetPair = lastBidPairKey(target.name, target.server);
  return !!targetPair && lastBidPairKey(snapshot.name, snapshot.server) === targetPair;
}

/** Saneamento defensivo do que veio do localStorage (dados antigos/corrompidos
 *  nunca quebram o modal); devolve já ORDENADO (recente → antigo) e PODADO. */
function sanitizeLastBidSnapshots(raw: unknown): LastBidSnapshot[] {
  if (!Array.isArray(raw)) return [];
  const list: LastBidSnapshot[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const origin = item.origin === "item" ? "item" : item.origin === "quest" ? "quest" : null;
    const name = typeof item.name === "string" ? item.name.trim() : "";
    const markedAtMs = Number(item.markedAtMs);
    if (!origin || !name || !Number.isFinite(markedAtMs) || markedAtMs <= 0) continue;
    list.push({
      auctionKey: typeof item.auctionKey === "string" ? item.auctionKey : "",
      origin,
      name,
      vocation: typeof item.vocation === "string" ? item.vocation : "",
      level: Number.isFinite(Number(item.level)) && Number(item.level) > 0 ? Number(item.level) : 0,
      server: typeof item.server === "string" ? item.server : "",
      url: typeof item.url === "string" ? item.url : "",
      endTs: Number.isFinite(Number(item.endTs)) && Number(item.endTs) > 0 ? Number(item.endTs) : null,
      // null/ausente permanece null (Number(null) seria 0 — valor inventado).
      valueKk: item.valueKk != null && Number.isFinite(Number(item.valueKk)) ? Number(item.valueKk) : null,
      valueRc: item.valueRc != null && Number.isFinite(Number(item.valueRc)) && Number(item.valueRc) >= 0 ? Number(item.valueRc) : null,
      markedAtMs,
    });
  }
  list.sort((a, b) => b.markedAtMs - a.markedAtMs);
  return list.slice(0, LAST_BIDS_LIMIT);
}

/** Lê o histórico do usuário — já ordenado (recente → antigo) e limitado a 10. */
export function loadLastBidSnapshots(uid: string | undefined): LastBidSnapshot[] {
  return sanitizeLastBidSnapshots(loadUIState<unknown>(lastBidsStorageKey(uid), []));
}

/** Grava + avisa a própria janela (o "storage" só dispara nas outras). */
function persistLastBidSnapshots(uid: string | undefined, snapshots: LastBidSnapshot[]): void {
  saveUIState(lastBidsStorageKey(uid), snapshots);
  try {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(BAZAAR_LAST_BIDS_UPDATED_EVENT));
    }
  } catch { /* ambiente sem window (testes) — gravação já concluída acima */ }
}

/**
 * REGISTRA o snapshot de UMA marcação "Tenho Interesse" (chamar SOMENTE do
 * handler da ação explícita do usuário, nunca de sincronizações):
 *   • remarcação do MESMO personagem na MESMA categoria substitui o registro
 *     anterior por um snapshot NOVO (data/hora novas — nada é reaproveitado);
 *   • a lista resultante fica ordenada (recente → antigo) e podada em 10.
 * Os campos são copiados por valor: mutações posteriores no objeto de origem
 * não alcançam o registro gravado.
 */
export function recordLastBidSnapshot(uid: string | undefined, snapshot: Omit<LastBidSnapshot, "markedAtMs"> & { markedAtMs?: number }): void {
  if (!String(snapshot.name || "").trim()) return;
  const record: LastBidSnapshot = {
    auctionKey: String(snapshot.auctionKey || ""),
    origin: snapshot.origin === "item" ? "item" : "quest",
    name: String(snapshot.name || "").trim(),
    vocation: String(snapshot.vocation || ""),
    level: Number(snapshot.level || 0) > 0 ? Number(snapshot.level) : 0,
    server: String(snapshot.server || ""),
    url: String(snapshot.url || ""),
    endTs: Number.isFinite(Number(snapshot.endTs)) && Number(snapshot.endTs) > 0 ? Number(snapshot.endTs) : null,
    // null = "não aplicável" e assim permanece (Number(null) seria 0 — um
    // valor inventado que violaria o requisito de fidelidade do snapshot).
    valueKk: snapshot.valueKk != null && Number.isFinite(Number(snapshot.valueKk)) ? Number(snapshot.valueKk) : null,
    valueRc: snapshot.valueRc != null && Number.isFinite(Number(snapshot.valueRc)) && Number(snapshot.valueRc) >= 0 ? Number(snapshot.valueRc) : null,
    markedAtMs: Number(snapshot.markedAtMs) > 0 ? Number(snapshot.markedAtMs) : Date.now(),
  };
  const current = loadLastBidSnapshots(uid);
  const next = [
    record,
    ...current.filter(existing => !snapshotMatchesTarget(existing, {
      origin: record.origin,
      auctionKey: record.auctionKey || undefined,
      name: record.name,
      server: record.server,
    })),
  ].slice(0, LAST_BIDS_LIMIT);
  persistLastBidSnapshots(uid, next);
}

/**
 * REMOVE o(s) registro(s) de um personagem DESMARCADO de "Tenho Interesse"
 * (mesmos critérios de correspondência da gravação: categoria + leilão OU
 * nome+servidor). Nada a remover = nenhuma gravação e nenhum evento.
 */
export function removeLastBidSnapshot(
  uid: string | undefined,
  target: { origin: "quest" | "item"; auctionKey?: string; name?: string; server?: string },
): void {
  const current = loadLastBidSnapshots(uid);
  const next = current.filter(snapshot => !snapshotMatchesTarget(snapshot, target));
  if (next.length === current.length) return;
  persistLastBidSnapshots(uid, next);
}

/** Remoção EM LOTE por chave de leilão (categoria Quest) — usada pelo "AUTO
 *  REMOVER INTERESSE" do Atualizar Valores, que desmarca vários de uma vez. */
export function removeLastBidSnapshotsByAuctionKeys(uid: string | undefined, auctionKeys: string[]): void {
  const keys = new Set(auctionKeys.filter(Boolean));
  if (keys.size === 0) return;
  const current = loadLastBidSnapshots(uid);
  const next = current.filter(snapshot => !(snapshot.origin === "quest" && snapshot.auctionKey && keys.has(snapshot.auctionKey)));
  if (next.length === current.length) return;
  persistLastBidSnapshots(uid, next);
}

/** "dd/MM às HH:mm" do MOMENTO DA MARCAÇÃO (horário local do dispositivo —
 *  mesmo formato "às" já usado nos timestamps locais do app). */
export function formatLastBidMarkedAt(markedAtMs: number): string {
  try {
    const date = new Date(markedAtMs);
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${pad(date.getDate())}/${pad(date.getMonth() + 1)} às ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  } catch {
    return "";
  }
}
