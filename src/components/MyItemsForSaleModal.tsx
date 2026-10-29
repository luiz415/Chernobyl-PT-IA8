import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, X, Coins, Check, PackageOpen, Globe, Megaphone, Pencil, Search, Swords, Briefcase, ArrowDownAZ, ArrowUpAZ, CalendarPlus, FileText } from "lucide-react";
import type { Character, CharacterAcquisition, CharacterAcquisitionBuyerDetails, ItemSaleRecord } from "../types";
import { formatRC } from "../types";
import { SERVER_OPTIONS, serverLabel } from "../constants/servers";
import {
  BAZAAR_WATCHED_ITEMS_UPDATED_EVENT,
  applyOfficialWatchedItemUpdate,
  findServerWatchedItem,
  loadWatchedItemsByServer,
  parseDecimalKkText,
  sanitizeDecimalKkText,
  updateSnapshotMatchTotalKk,
} from "../utils/bazaarWatchedItems";
import { formatItemSaleSummary, formatKkValue as formatKkValueBase, isItemSaleConcluded } from "../utils/itemSale";
import {
  buildSaleAnnouncement,
  loadSaleTextConfig,
  saveSaleTextConfig,
  type SaleTextConfig,
  type SaleTextItemInput,
} from "../utils/saleAnnouncement";
import SaleTextConfigModal from "./SaleTextConfigModal";
import { questBadgeColorBySigla } from "../constants/questBadges";
import { isPaymentConfirmed } from "../services/characterAcquisitionService";
import ItemSoldModal from "./ItemSoldModal";

// ============================================================================
// MODAL "ITENS À VENDA" — MEUS PERSONAGENS
// ----------------------------------------------------------------------------
// Centraliza TODOS os itens de Quest declarados nos personagens do usuário —
// pendentes E já vendidos — independentemente da guia (Disponíveis, Vendidos)
// e incluindo os personagens NEGOCIADOS COMPRADOS pelo usuário atual, e
// permite registrar/revisar a venda sem sair do modal.
//
// ITENS DO BAZAAR (58ª tarefa): itens que VIERAM NA COMPRA do personagem
// (snapshot `Character.bazaarItems`) e foram marcados "À venda" no modal
// "Ver" entram aqui como TERCEIRA origem (`source: "bazaar"`), com o MESMO
// padrão de exibição/edição/confirmação dos demais — porém SEM associação
// com SW/SG/GB (não vieram de Quest): badge próprio "Bazaar" no lugar da
// sigla. A venda grava o ItemSaleRecord no PRÓPRIO match do snapshot, pelo
// MESMO canal `onCharacterInlineChange` (nenhum campo de Quest é tocado).
//
// FONTE DE DADOS — 100% local, nenhuma consulta nova ao Firestore:
//   • `characters` = data.characters do App (Disponíveis + Vendidos), a MESMA
//     lista viva do CharTable; toda alteração reflete aqui via props/useMemo.
//   • `acquisitions`/`buyerDetails` = os MESMOS listeners dos Negociados;
//     entram apenas as negociações COMPRADAS pelo usuário atual
//     (acquirerUid === uid && isPaymentConfirmed — critério idêntico ao da
//     guia "Negociados entre Usuários").
//
// PROPRIEDADE DOS ITENS (quem pode gerenciar o quê):
//   • Personagens do usuário cujo lucro de Quest foi TRANSFERIDO por
//     negociação (lockedQuestFinancialIds, o mesmo conjunto que trava o
//     CharTable) ficam FORA da lista: aqueles itens pertencem ao comprador —
//     que os vê, por sua vez, pela via da própria negociação. Isso também
//     elimina qualquer duplicidade entre as duas origens.
//
// LÓGICA REUTILIZADA (nada de cálculo novo):
//   • ItemSoldModal — o MESMO modal/calculadora do PartyPanel e do CharTable
//     (valor em kk, cotação do RC, Taxa Market 1%/3%, resultado em RC);
//   • Personagens: a venda grava EXATAMENTE o patch do CharTable
//     (itemSaleX + dropX = resultRC) pelo MESMO canal `onCharacterInlineChange`
//     (setData do App → persistência local + sync Firestore existentes) —
//     CharTable, Overview e demais telas refletem na hora, sem duplicação;
//   • Negociados: o resultado da calculadora grava o `questProfit` privado do
//     comprador pelo MESMO `updateCharacterAcquisitionQuestProfit` da guia
//     Negociados (validação de adquirente no App e nas Security Rules). O
//     schema da negociação guarda somente o lucro (número) — o registro
//     completo da operação não é persistido lá, por isso a calculadora
//     reabre em branco para esses itens.
//
// CRITÉRIO "VENDIDO" — estado real do dado, não aparência (o mesmo canônico
// do CharTable/ItemsForSaleModal): lucro registrado > 0 OU venda registrada
// no itemSale (resultRC > 0 ou venda confirmada SEM valor — `noValue`).
// Pendente = item declarado sem venda registrada.
// ============================================================================

/** Origem temática do item: Quests (SW/SG/GB) ou item do Bazaar (SEM Quest). */
export type MySaleItemQuest = "soulwar" | "sanguine" | "crypt" | "bazaar";

/** Um item de Quest do usuário (pendente ou vendido), com contexto de origem. */
export interface MySaleItem {
  /** Chave estável: `char:<characterId>:<quest>`, `acq:<acquisitionId>` ou
   *  `char:<characterId>:bazaar:<matchIndex>`. */
  key: string;
  /** Origem do registro — define COMO a venda é persistida. */
  source: "character" | "acquisition" | "bazaar";
  /** Id do personagem (source=character|bazaar) ou da negociação (source=acquisition). */
  sourceId: string;
  /** Índice do item no snapshot `bazaarItems.matches` (só source=bazaar). */
  matchIndex?: number;
  quest: MySaleItemQuest;
  /** Sigla exibida: SW | SG | GB — "" para itens do Bazaar (sem Quest). */
  questSigla: string;
  itemName: string;
  /** Nome canônico do servidor (serverLabel); "" quando desconhecido. */
  serverName: string;
  /** Guia de origem do personagem (badge informativo — sem expor o nome). */
  origin: "disponivel" | "vendido" | "negociado";
  /** Já vendido? (lucro > 0, itemSale.resultRC > 0 ou venda sem valor). */
  sold: boolean;
  /** Valor registrado da venda, em RC (0 enquanto pendente ou sem valor). */
  soldValueRC: number;
  /** Data de INCLUSÃO do item (epoch ms) — null para registros antigos sem a
   *  data e para negociados (o schema da negociação não a armazena); exibida
   *  como "—" (NUNCA se inventa data histórica). */
  addedAtMs: number | null;
  /** Data da VENDA registrada (itemSale.soldAt, epoch ms) — null sem registro. */
  soldAtMs: number | null;
  /** Resumo da operação (modal "Item Vendido"), quando registrada ("" sem). */
  saleSummary: string;
  /** Registro completo persistido (só source=character) — edição com initial. */
  saleRecord: ItemSaleRecord | null;
  /** Nome do item na Lista de Itens (só source=bazaar) — lookup/edição da base. */
  watchedName?: string;
  /** Tier do match do snapshot (só source=bazaar). */
  tier?: number;
  /** Quantidade do match do snapshot (só source=bazaar). */
  amount?: number;
  /** Valor BASE registrado na compra (kk, só source=bazaar) — fallback de
   *  exibição quando o item não está (mais) na Lista de Itens do servidor. */
  snapshotBaseKk?: number;
  /** Valor CONSIDERADO atual do item (kk, só source=bazaar) — o totalKk do
   *  match do snapshot (editável; null/ausente nas demais origens). */
  consideredKk?: number | null;
}

/** kk com até 1 casa, sem zeros à direita — mesmo formato do modal "Ver". */
function formatKk(value: number): string {
  return formatKkValueBase(value, "kk", true);
}

const QUEST_FIELDS: Array<{
  quest: MySaleItemQuest;
  sigla: string;
  item: "itemDropadoSW" | "itemDropadoSG" | "itemDropadoCrypt";
  itemAt: "itemDropadoSWAt" | "itemDropadoSGAt" | "itemDropadoCryptAt";
  sale: "itemSaleSW" | "itemSaleSG" | "itemSaleCrypt";
  drop: "dropSW" | "dropBakra" | "dropCrypt";
}> = [
  { quest: "soulwar", sigla: "SW", item: "itemDropadoSW", itemAt: "itemDropadoSWAt", sale: "itemSaleSW", drop: "dropSW" },
  { quest: "sanguine", sigla: "SG", item: "itemDropadoSG", itemAt: "itemDropadoSGAt", sale: "itemSaleSG", drop: "dropBakra" },
  { quest: "crypt", sigla: "GB", item: "itemDropadoCrypt", itemAt: "itemDropadoCryptAt", sale: "itemSaleCrypt", drop: "dropCrypt" },
];

function questSiglaOf(quest: MySaleItemQuest): string {
  return quest === "soulwar" ? "SW" : quest === "sanguine" ? "SG" : "GB";
}

/**
 * Reúne TODOS os itens de Quest do usuário — função pura, usada pelo modal e
 * pelo contador do botão em Meus Personagens. Nenhum acesso ao Firestore:
 * apenas deriva das listas que o App já mantém vivas.
 */
export function collectMySaleItems(
  characters: Character[],
  acquisitions: CharacterAcquisition[],
  buyerDetails: CharacterAcquisitionBuyerDetails[],
  currentUserUid: string,
  lockedQuestFinancialIds: ReadonlySet<string>,
): MySaleItem[] {
  const items: MySaleItem[] = [];

  // ── Personagens do usuário (Disponíveis + Vendidos) ───────────────────────
  for (const c of characters) {
    // Lucro de Quest transferido por negociação: os itens pertencem ao
    // COMPRADOR (mesma trava do CharTable) — fora do gerenciamento do dono.
    if (lockedQuestFinancialIds.has(c.id)) continue;
    for (const field of QUEST_FIELDS) {
      const itemName = String(c[field.item] || "").trim();
      if (!itemName) continue;
      const sale = c[field.sale] || null;
      // Estado REAL: lucro gravado (campo canônico) ou registro completo —
      // inclui venda confirmada SEM valor (`noValue`), que encerra o item.
      const soldValueRC = Math.max(Number(c[field.drop] || 0), Number(sale?.resultRC || 0));
      const addedAtRaw = Number(c[field.itemAt] || 0);
      items.push({
        key: `char:${c.id}:${field.quest}`,
        source: "character",
        sourceId: c.id,
        quest: field.quest,
        questSigla: field.sigla,
        itemName,
        serverName: serverLabel(c.servidor) || String(c.servidor || "").trim(),
        origin: c.vendido ? "vendido" : "disponivel",
        sold: soldValueRC > 0 || isItemSaleConcluded(sale),
        soldValueRC,
        addedAtMs: addedAtRaw > 0 ? addedAtRaw : null,
        soldAtMs: sale && isItemSaleConcluded(sale) && (sale.soldAt || 0) > 0 ? sale.soldAt ?? null : null,
        saleSummary: sale && isItemSaleConcluded(sale) ? formatItemSaleSummary(sale) : "",
        saleRecord: sale,
      });
    }

    // ── Itens do BAZAAR do personagem marcados "À venda" (58ª) ──────────────
    // Snapshot da compra (`bazaarItems.matches`): entra SOMENTE o item com
    // `forSale` — desmarcado sai da lista sem apagar o registro original.
    // SEM Quest associada (sigla vazia; badge "Bazaar" na exibição).
    const snap = c.bazaarItems;
    if (snap && Array.isArray(snap.matches)) {
      snap.matches.forEach((match, matchIndex) => {
        if (!match.forSale) return;
        const itemName = String(match.foundName || "").trim();
        if (!itemName) return;
        const sale = match.sale || null;
        const concluded = isItemSaleConcluded(sale);
        items.push({
          key: `char:${c.id}:bazaar:${matchIndex}`,
          source: "bazaar",
          sourceId: c.id,
          matchIndex,
          quest: "bazaar",
          questSigla: "",
          itemName,
          serverName: serverLabel(snap.server) || String(snap.server || "").trim(),
          origin: c.vendido ? "vendido" : "disponivel",
          sold: concluded,
          soldValueRC: Math.max(0, Number(sale?.resultRC || 0)),
          // Data em que o item foi COLOCADO À VENDA (1ª marcação) — nunca
          // inventada; marcações antigas sem o campo exibem "—".
          addedAtMs: (match.forSaleAt || 0) > 0 ? match.forSaleAt ?? null : null,
          soldAtMs: concluded && (sale?.soldAt || 0) > 0 ? sale?.soldAt ?? null : null,
          saleSummary: concluded && sale ? formatItemSaleSummary(sale) : "",
          saleRecord: sale,
          // Valores do match do snapshot (73ª): base da compra (fallback de
          // exibição) e total CONSIDERADO atual (editável no modal).
          watchedName: String(match.watchedName || "").trim(),
          tier: Number(match.tier || 0),
          amount: Number(match.amount || 0),
          snapshotBaseKk: Number(match.baseValueKk || 0),
          consideredKk: Number(match.totalKk || 0),
        });
      });
    }
  }

  // ── Negociados COMPRADOS pelo usuário atual ───────────────────────────────
  // Mesmo critério da guia "Negociados entre Usuários" (perspectiva de
  // comprador): adquirente é o usuário E pagamento confirmado.
  const detailByAcquisition = new Map(buyerDetails.map(d => [d.acquisitionId, d]));
  for (const record of acquisitions) {
    if (record.acquirerUid !== currentUserUid || !isPaymentConfirmed(record)) continue;
    const detail = detailByAcquisition.get(record.id);
    const itemName = String(detail?.questDrops?.[0] || "").trim();
    if (!itemName) continue;
    const questType = detail?.questType || record.questType;
    const quest: MySaleItemQuest = questType === "sanguine" ? "sanguine" : questType === "crypt" ? "crypt" : "soulwar";
    const soldValueRC = Math.max(0, Number(detail?.questProfit || 0));
    items.push({
      key: `acq:${record.id}`,
      source: "acquisition",
      sourceId: record.id,
      quest,
      questSigla: questSiglaOf(quest),
      itemName,
      serverName: serverLabel(record.server) || String(record.server || "").trim(),
      origin: "negociado",
      sold: soldValueRC > 0,
      soldValueRC,
      // O schema da negociação não guarda a data de inclusão nem o registro
      // completo da venda — sem data real disponível, exibimos "—".
      addedAtMs: null,
      soldAtMs: null,
      saleSummary: "",
      saleRecord: null,
    });
  }

  return items;
}

/** Total de itens AINDA NÃO VENDIDOS (contador do botão em Meus Personagens). */
export function countMyUnsoldSaleItems(items: MySaleItem[]): number {
  return items.reduce((sum, item) => sum + (item.sold ? 0 : 1), 0);
}

// ── Filtros do modal (combinados por E; preservados ao alternar de aba) ─────
interface SaleFilters {
  /** Busca por nome do item (contém, sem acento/caixa). */
  text: string;
  /** Servidor exato ("" = todos). */
  server: string;
  /** Quest ("" = todas). */
  quest: "" | MySaleItemQuest;
  /** Faixa de valor em RC — aplicada apenas aos VENDIDOS (pendentes não têm valor). */
  minRC: string;
  maxRC: string;
}

const EMPTY_FILTERS: SaleFilters = { text: "", server: "", quest: "", minRC: "", maxRC: "" };

// ── Ordenação (combinável com os filtros; agrupamento por servidor mantido) ─
// "server" ordena os GRUPOS de servidor; os demais critérios ordenam os itens
// DENTRO de cada grupo (com desempate pelo nome). Datas/valores ausentes vão
// sempre para o fim, em qualquer direção — nunca se inventa valor para ordenar.
type SaleSortKey = "item" | "server" | "value" | "added" | "sold";
type SaleSortDir = "asc" | "desc";

const SORT_OPTIONS: Array<{ key: SaleSortKey; label: string }> = [
  { key: "item", label: "Nome do item" },
  { key: "server", label: "Servidor" },
  { key: "value", label: "Valor registrado" },
  { key: "added", label: "Data de inclusão" },
  { key: "sold", label: "Data de venda" },
];

/** Comparador dos itens DENTRO de um grupo (desempate: nome asc). */
function compareSaleItems(a: MySaleItem, b: MySaleItem, key: SaleSortKey, dir: SaleSortDir): number {
  const flip = dir === "desc" ? -1 : 1;
  const byName = a.itemName.localeCompare(b.itemName, "pt-BR");
  if (key === "item") return flip * byName;
  if (key === "value") {
    const diff = a.soldValueRC - b.soldValueRC;
    return diff !== 0 ? flip * diff : byName;
  }
  if (key === "added" || key === "sold") {
    const av = key === "added" ? a.addedAtMs : a.soldAtMs;
    const bv = key === "added" ? b.addedAtMs : b.soldAtMs;
    // Sem data registrada -> sempre ao final, independentemente da direção.
    if (av === null && bv === null) return byName;
    if (av === null) return 1;
    if (bv === null) return -1;
    const diff = av - bv;
    return diff !== 0 ? flip * diff : byName;
  }
  // "server": os grupos já são ordenados fora; dentro, nome asc.
  return byName;
}

/** Data de inclusão/venda exibida SÓ com o dia (DD/MM/AAAA). */
function formatDayBR(ms: number | null): string {
  if (!ms || ms <= 0) return "—";
  return new Date(ms).toLocaleDateString("pt-BR");
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

function parseRCFilter(raw: string): number | null {
  const digits = raw.replace(/\D+/g, "");
  if (!digits) return null;
  const value = Number(digits);
  return Number.isSafeInteger(value) ? value : null;
}

interface Props {
  /** TODOS os personagens do usuário (Disponíveis + Vendidos) — data.characters. */
  characters: Character[];
  /** Negociações (mesmo listener da guia Negociados). */
  acquisitions: CharacterAcquisition[];
  buyerDetails: CharacterAcquisitionBuyerDetails[];
  currentUserUid: string;
  /** Personagens com lucro de Quest transferido (mesmo conjunto do CharTable). */
  lockedQuestFinancialIds: ReadonlySet<string>;
  /** MESMO canal do CharTable: setData do App → persistência existente. */
  onCharacterInlineChange: (character: Character) => void;
  /** MESMO canal da guia Negociados (updateCharacterAcquisitionQuestProfit). */
  onUpdateQuestProfit: (input: { acquisitionId: string; questProfit: number }) => Promise<{ ok: boolean; error?: string }>;
  /**
   * Edição do valor BASE na Lista de Itens (73ª — EXCLUSIVA DO BOSS): o App
   * passa `role === "Boss"`. Sem a prop, os demais usuários apenas VEEM os
   * valores base — mas podem ajustar o valor considerado dos itens do
   * Bazaar dos próprios personagens.
   */
  canUpdateOfficialList?: boolean;
  onClose: () => void;
}

export default function MyItemsForSaleModal({
  characters,
  acquisitions,
  buyerDetails,
  currentUserUid,
  lockedQuestFinancialIds,
  onCharacterInlineChange,
  onUpdateQuestProfit,
  canUpdateOfficialList,
  onClose,
}: Props) {
  // Recalculado a cada mudança nas listas vivas do App — tempo real.
  const items = useMemo(
    () => collectMySaleItems(characters, acquisitions, buyerDetails, currentUserUid, lockedQuestFinancialIds),
    [characters, acquisitions, buyerDetails, currentUserUid, lockedQuestFinancialIds],
  );
  const unsoldCount = useMemo(() => countMyUnsoldSaleItems(items), [items]);
  const soldCount = items.length - unsoldCount;

  // ── Abas (À Venda / Vendidos) + filtros combinados ────────────────────────
  // Os filtros são um estado ÚNICO compartilhado pelas duas abas: alternar
  // entre elas nunca descarta o contexto da consulta.
  const [tab, setTab] = useState<"avenda" | "vendidos">("avenda");
  const [filters, setFilters] = useState<SaleFilters>(EMPTY_FILTERS);
  // Ordenação — também compartilhada entre as abas (nunca descarta filtros).
  const [sortKey, setSortKey] = useState<SaleSortKey>("item");
  const [sortDir, setSortDir] = useState<SaleSortDir>("asc");

  // Servidores disponíveis para o filtro — somente os presentes nos dados.
  const serverOptions = useMemo(() => {
    const set = new Set<string>();
    items.forEach(item => { if (item.serverName) set.add(item.serverName); });
    return [...set].sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [items]);

  // Itens da aba atual com TODOS os filtros aplicados (derivação pura).
  const filteredItems = useMemo(() => {
    const text = normalizeSearchText(filters.text);
    const minRC = parseRCFilter(filters.minRC);
    const maxRC = parseRCFilter(filters.maxRC);
    return items.filter(item => {
      if (tab === "avenda" ? item.sold : !item.sold) return false;
      if (text && !normalizeSearchText(item.itemName).includes(text)) return false;
      if (filters.server && item.serverName !== filters.server) return false;
      if (filters.quest && item.quest !== filters.quest) return false;
      // Faixa de valor: só faz sentido sobre valor registrado (aba Vendidos).
      if (tab === "vendidos") {
        if (minRC !== null && item.soldValueRC < minRC) return false;
        if (maxRC !== null && item.soldValueRC > maxRC) return false;
      }
      return true;
    });
  }, [items, tab, filters]);

  // Agrupamento por servidor — SEMPRE preservado. "Servidor" ordena os
  // grupos (asc/desc); os demais critérios mantêm os grupos alfabéticos e
  // ordenam os ITENS dentro de cada grupo (desempate pelo nome).
  const groupedByServer = useMemo(() => {
    const map = new Map<string, MySaleItem[]>();
    for (const item of filteredItems) {
      const key = item.serverName || "Sem servidor";
      const list = map.get(key) || [];
      list.push(item);
      map.set(key, list);
    }
    const groupFlip = sortKey === "server" && sortDir === "desc" ? -1 : 1;
    return [...map.entries()]
      .sort((a, b) => groupFlip * a[0].localeCompare(b[0], "pt-BR"))
      .map(([server, list]) => [server, [...list].sort((a, b) => compareSaleItems(a, b, sortKey, sortDir))] as const);
  }, [filteredItems, sortKey, sortDir]);

  // ── Resumo financeiro da aba VENDIDOS — calculado SOMENTE sobre os itens
  // EXIBIDOS (pós-filtros) e recalculado a cada mudança de filtro/ordenação.
  // Vendas sem valor registrado (ex.: "Não informar valor") ficam FORA do
  // total e da média — contadas à parte para não distorcer as métricas.
  const soldSummary = useMemo(() => {
    if (tab !== "vendidos") return null;
    const valued = filteredItems.filter(item => item.soldValueRC > 0);
    const totalRC = valued.reduce((sum, item) => sum + item.soldValueRC, 0);
    return {
      shownCount: filteredItems.length,
      valuedCount: valued.length,
      noValueCount: filteredItems.length - valued.length,
      totalRC,
      averageRC: valued.length > 0 ? Math.round(totalRC / valued.length) : 0,
    };
  }, [tab, filteredItems]);

  // ── Copiar nome do item (73ª) — MESMO padrão do CharTable/"Itens
  //    Encontrados": clique copia SÓ o nome exato, ✓ verde por 1,5s. ───────
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  async function copyText(text: string, key: string) {
    try { await navigator.clipboard.writeText(text); } catch { /* fallback */ }
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1500);
  }

  // ── VALOR BASE vivo da Lista de Itens por servidor (73ª) ─────────────────
  // Mesma fonte oficial da guia Itens; o evento recarrega o mapa quando
  // QUALQUER tela grava um valor — a base exibida reflete na hora.
  const [watchedVersion, setWatchedVersion] = useState(0);
  useEffect(() => {
    const bump = () => setWatchedVersion(v => v + 1);
    window.addEventListener(BAZAAR_WATCHED_ITEMS_UPDATED_EVENT, bump);
    return () => window.removeEventListener(BAZAAR_WATCHED_ITEMS_UPDATED_EVENT, bump);
  }, []);
  const watchedByServer = useMemo(() => loadWatchedItemsByServer(), [watchedVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Edição inline de valores (73ª) ────────────────────────────────────────
  // `baseEdit` (SÓ Boss): novo valor BASE → Lista de Itens do SERVIDOR do
  // item (núcleo único applyOfficialWatchedItemUpdate — demais servidores
  // intactos). `totalEdit` (TODOS; só itens do Bazaar): novo valor
  // CONSIDERADO → match do snapshot do próprio personagem
  // (updateSnapshotMatchTotalKk, canal existente onCharacterInlineChange).
  const [baseEdit, setBaseEdit] = useState<{ key: string; value: string } | null>(null);
  const [totalEdit, setTotalEdit] = useState<{ key: string; value: string } | null>(null);
  const [editDone, setEditDone] = useState<{ key: string; ok: boolean; message: string } | null>(null);
  const editTimerRef = useRef<number | null>(null);
  useEffect(() => () => { if (editTimerRef.current !== null) window.clearTimeout(editTimerRef.current); }, []);
  function flashEditDone(key: string, ok: boolean, message: string) {
    setEditDone({ key, ok, message });
    if (editTimerRef.current !== null) window.clearTimeout(editTimerRef.current);
    editTimerRef.current = window.setTimeout(() => { setEditDone(null); editTimerRef.current = null; }, ok ? 2500 : 4000);
  }

  /** BASE (Boss): grava na Lista de Itens SÓ do servidor do item. */
  function confirmBaseEdit(item: MySaleItem, fieldKey: string) {
    // Dupla checagem de autorização (o backend não é tocado: a Lista de
    // Itens é a mesma fonte local/compartilhada já usada pela guia Itens).
    if (!canUpdateOfficialList || !baseEdit || baseEdit.key !== fieldKey) return;
    const valueKk = parseDecimalKkText(baseEdit.value);
    if (valueKk === null) { flashEditDone(fieldKey, false, "Valor base inválido — kk maior que zero, com até 1 casa decimal (ex.: 1,5)."); return; }
    const result = applyOfficialWatchedItemUpdate({
      scope: "server",
      server: item.serverName,
      itemName: item.watchedName || item.itemName,
      valueKk,
      serverUniverse: SERVER_OPTIONS,
    });
    setBaseEdit(null);
    const touched = result.changedServers.length + result.addedServers.length;
    flashEditDone(fieldKey, result.ok, !result.ok
      ? (result.error || "Falha ao atualizar a Lista de Itens.")
      : touched === 0 ? "Já atualizado" : `${item.serverName} atualizado`);
  }

  /** CONSIDERADO (todos; só itens do Bazaar): grava no snapshot do personagem. */
  function confirmTotalEdit(item: MySaleItem, fieldKey: string) {
    if (item.source !== "bazaar" || item.matchIndex === undefined || !totalEdit || totalEdit.key !== fieldKey) return;
    const valueKk = parseDecimalKkText(totalEdit.value);
    if (valueKk === null) { flashEditDone(fieldKey, false, "Valor inválido — kk maior que zero, com até 1 casa decimal (ex.: 1,5)."); return; }
    const character = characters.find(c => c.id === item.sourceId);
    const snap = character?.bazaarItems;
    const next = snap ? updateSnapshotMatchTotalKk(snap, item.matchIndex, valueKk) : null;
    if (!character || !snap || !next) { flashEditDone(fieldKey, false, "Não foi possível atualizar o valor deste item."); return; }
    if (next !== snap) onCharacterInlineChange({ ...character, bazaarItems: next });
    setTotalEdit(null);
    flashEditDone(fieldKey, true, next === snap ? "Já atualizado" : "Valor atualizado");
  }

  /** Valor CONSIDERADO de um item (kk) — MESMA regra da exibição (73ª):
   *  Bazaar = total do snapshot da compra; Quest/negociado = valor da Lista
   *  de Itens do servidor (sem Tier/quantidade); desconhecido = null. É a
   *  fonte ÚNICA usada pelos chips de valor E pelo Texto de Venda. */
  function itemConsideredKkOf(item: MySaleItem): number | null {
    if (item.source === "bazaar") return item.consideredKk ?? null;
    const listed = item.serverName ? findServerWatchedItem(watchedByServer, item.serverName, item.watchedName || item.itemName) : null;
    return listed ? listed.valueKk : null;
  }

  // ── TEXTO DE VENDA POR SERVIDOR (75ª) ─────────────────────────────────────
  // Config persistida POR USUÁRIO (localStorage — sobrevive a recarregar/
  // reabrir); padrões úteis quando nunca configurado. O botão de cada
  // servidor gera o anúncio SÓ com os itens AINDA À VENDA daquele servidor
  // (itens vendidos e de outros servidores NUNCA entram), na MESMA ordenação
  // exibida, e copia para a área de transferência com feedback visual.
  const [saleTextConfig, setSaleTextConfig] = useState<SaleTextConfig>(() => loadSaleTextConfig(currentUserUid));
  useEffect(() => { setSaleTextConfig(loadSaleTextConfig(currentUserUid)); }, [currentUserUid]);
  const [isSaleTextConfigOpen, setIsSaleTextConfigOpen] = useState(false);
  const [saleTextDone, setSaleTextDone] = useState<{ server: string; ok: boolean; message: string } | null>(null);
  const saleTextTimerRef = useRef<number | null>(null);
  useEffect(() => () => { if (saleTextTimerRef.current !== null) window.clearTimeout(saleTextTimerRef.current); }, []);

  /** Itens AINDA À VENDA (não vendidos) agrupados por servidor — conjunto
   *  REAL do anúncio, independente de filtros/aba (deriva da lista viva). */
  const pendingItemsByServer = useMemo(() => {
    const map = new Map<string, MySaleItem[]>();
    for (const item of items) {
      if (item.sold) continue;
      const key = item.serverName || "Sem servidor";
      const list = map.get(key) || [];
      list.push(item);
      map.set(key, list);
    }
    return map;
  }, [items]);

  /** Itens do anúncio de UM servidor, na MESMA ordenação exibida no modal. */
  function saleTextInputsOf(serverKey: string): SaleTextItemInput[] {
    const pending = [...(pendingItemsByServer.get(serverKey) || [])].sort((a, b) => compareSaleItems(a, b, sortKey, sortDir));
    return pending.map(item => ({
      name: item.itemName,
      valueKk: itemConsideredKkOf(item),
      amount: Number(item.amount) || 0,
    }));
  }

  // Amostra da PRÉVIA do modal de configuração: itens reais do 1º servidor
  // (alfabético) com itens à venda — o usuário vê o resultado de verdade.
  const sampleServer = useMemo(() => {
    const keys = [...pendingItemsByServer.keys()].sort((a, b) => a.localeCompare(b, "pt-BR"));
    return keys[0] || "";
  }, [pendingItemsByServer]);

  async function generateSaleText(serverKey: string) {
    const text = buildSaleAnnouncement(saleTextConfig, saleTextInputsOf(serverKey));
    let ok = true;
    let message = "Texto copiado!";
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      ok = false;
      message = "Falha ao copiar — o navegador bloqueou a área de transferência; tente novamente.";
    }
    setSaleTextDone({ server: serverKey, ok, message });
    if (saleTextTimerRef.current !== null) window.clearTimeout(saleTextTimerRef.current);
    saleTextTimerRef.current = window.setTimeout(() => { setSaleTextDone(null); saleTextTimerRef.current = null; }, ok ? 2000 : 4000);
  }

  // ── Venda/edição via ItemSoldModal (calculadora oficial) ──────────────────
  const [saleTarget, setSaleTarget] = useState<MySaleItem | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [error, setError] = useState("");

  // Dados VIVOS do alvo (as props podem mudar enquanto o modal está aberto).
  const liveSaleTarget = useMemo(
    () => (saleTarget ? items.find(item => item.key === saleTarget.key) || null : null),
    [saleTarget, items],
  );

  // Esc fecha (padrão do app) — mas NÃO enquanto a calculadora ou o
  // "Configurar Texto de Venda" estão abertos por cima (cada um trata o
  // próprio Esc).
  useEffect(() => {
    if (saleTarget || isSaleTextConfigOpen) return;
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, saleTarget, isSaleTextConfigOpen]);

  async function commitSale(sale: ItemSaleRecord) {
    const target = liveSaleTarget;
    setSaleTarget(null);
    if (!target) return;
    setError("");
    if (target.source === "bazaar") {
      // Item do Bazaar (58ª): grava o registro COMPLETO no próprio match do
      // snapshot — MESMO canal do CharTable (onCharacterInlineChange).
      // NENHUM campo de Quest (itemSaleX/dropX) é tocado: o item não tem
      // associação com SW/SG/GB.
      const character = characters.find(c => c.id === target.sourceId);
      const snap = character?.bazaarItems;
      if (!character || !snap || target.matchIndex === undefined || !snap.matches[target.matchIndex]) return;
      onCharacterInlineChange({
        ...character,
        bazaarItems: {
          ...snap,
          matches: snap.matches.map((m, i) => (i === target.matchIndex ? { ...m, sale } : m)),
        },
      });
      return;
    }
    if (target.source === "character") {
      // MESMO patch do CharTable: registro completo + lucro da Quest no
      // contexto correto (SW -> itemSaleSW/dropSW; SG -> itemSaleSG/dropBakra;
      // GB -> itemSaleCrypt/dropCrypt) — nunca misturados.
      const character = characters.find(c => c.id === target.sourceId);
      if (!character) return;
      onCharacterInlineChange({
        ...character,
        ...(target.quest === "soulwar"
          ? { itemSaleSW: sale, dropSW: sale.resultRC }
          : target.quest === "sanguine"
            ? { itemSaleSG: sale, dropBakra: sale.resultRC }
            : { itemSaleCrypt: sale, dropCrypt: sale.resultRC }),
      });
      return;
    }
    // Negociado comprado: o registro correto é o Lucro Quest PRIVADO do
    // comprador — persistido pelo MESMO canal da guia Negociados.
    setSavingKey(target.key);
    try {
      const result = await onUpdateQuestProfit({ acquisitionId: target.sourceId, questProfit: sale.resultRC });
      if (!result.ok) setError(result.error || "Não foi possível registrar a venda.");
    } finally {
      setSavingKey(null);
    }
  }

  // Badge de origem — o modal trata dos ITENS do usuário, então o status do
  // personagem (Vendido/Disponível) NÃO é exibido; apenas "Negociado"
  // permanece, por indicar uma origem com persistência própria.
  const originBadge = (item: MySaleItem) => {
    if (item.origin === "negociado") {
      return <span className="inline-flex items-center gap-0.5 text-[8px] font-black px-1 py-px rounded border border-violet-500/40 bg-violet-500/15 text-violet-300 uppercase tracking-wide" title="Personagem negociado entre usuários, comprado por você"><Briefcase size={8} /> Negociado</span>;
    }
    return null;
  };

  const inputCls = "w-full bg-black/40 border border-white/10 rounded-lg px-2.5 py-1.5 text-[11px] text-slate-200 outline-none transition-colors focus:border-amber-500/50 placeholder-slate-600";

  return createPortal(
    <div
      className="fixed inset-0 z-[500] flex items-center justify-center bg-black/80 backdrop-blur-sm p-2 sm:p-4"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-2xl rounded-2xl border border-amber-500/40 bg-gradient-to-b from-[#141017] to-[#0b0a10] shadow-[0_0_60px_rgba(245,158,11,0.08)] shadow-black/70 flex flex-col max-h-[90vh] sm:max-h-[84vh] overflow-hidden">
        {/* Cabeçalho — mesma identidade âmbar do "Itens a Venda" das PTs */}
        <div className="relative px-4 py-3.5 border-b border-amber-500/20 bg-gradient-to-r from-amber-500/[0.12] via-amber-500/[0.05] to-transparent flex-shrink-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="w-9 h-9 rounded-xl bg-amber-500/15 border border-amber-500/40 flex items-center justify-center shadow-[0_0_12px_rgba(245,158,11,0.15)] flex-shrink-0">
                <Coins size={17} className="text-amber-300" />
              </span>
              <div className="min-w-0">
                <h3 className="text-[15px] font-black text-amber-200 leading-tight tracking-tight truncate">Itens à Venda</h3>
                <p className="text-[10px] text-slate-400 leading-snug truncate">
                  Itens de Quest e itens do Bazaar dos seus personagens — Disponíveis, Vendidos e Negociados comprados
                </p>
              </div>
            </div>
            <button onClick={onClose} className="text-slate-400 hover:text-white p-1.5 rounded-lg hover:bg-white/5 transition-colors cursor-pointer flex-shrink-0">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Abas À VENDA / VENDIDOS + Configurar Texto de Venda (75ª) */}
        <div className="flex items-center gap-1.5 px-4 pt-3 flex-shrink-0 flex-wrap">
          <button
            type="button"
            onClick={() => setTab("avenda")}
            aria-pressed={tab === "avenda"}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[10px] font-black uppercase tracking-wide transition-colors cursor-pointer ${
              tab === "avenda"
                ? "border-amber-500/50 bg-amber-500/20 text-amber-200"
                : "border-white/10 bg-white/[0.03] text-slate-400 hover:text-slate-200"
            }`}
          >
            <PackageOpen size={11} /> À Venda
            <span className="tabular-nums font-mono">({unsoldCount})</span>
          </button>
          <button
            type="button"
            onClick={() => setTab("vendidos")}
            aria-pressed={tab === "vendidos"}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[10px] font-black uppercase tracking-wide transition-colors cursor-pointer ${
              tab === "vendidos"
                ? "border-emerald-500/50 bg-emerald-500/20 text-emerald-200"
                : "border-white/10 bg-white/[0.03] text-slate-400 hover:text-slate-200"
            }`}
          >
            <Check size={11} /> Vendidos
            <span className="tabular-nums font-mono">({soldCount})</span>
          </button>
          {/* CONFIGURAR TEXTO DE VENDA (75ª): personaliza o anúncio copiado
              pelo botão "Gerar Texto de Venda" de cada servidor — config
              persistida POR USUÁRIO (local), com prévia ao vivo. */}
          <button
            type="button"
            onClick={() => setIsSaleTextConfigOpen(true)}
            className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-amber-500/35 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 text-[10px] font-black uppercase tracking-wide transition-colors cursor-pointer"
            title="Personalizar o anúncio gerado pelo botão “Gerar Texto de Venda” de cada servidor (Introdução, formato dos itens e Encerramento) — salvo para o seu usuário."
          >
            <FileText size={11} /> Configurar Texto de Venda
          </button>
        </div>

        {/* Filtros — combinados; preservados ao alternar de aba */}
        <div className="px-4 pt-2.5 pb-1 grid grid-cols-2 sm:grid-cols-4 gap-1.5 flex-shrink-0">
          <label className="relative col-span-2 sm:col-span-1">
            <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
            <input
              type="text"
              value={filters.text}
              onChange={e => setFilters(f => ({ ...f, text: e.target.value }))}
              placeholder="Buscar item..."
              aria-label="Buscar por nome do item"
              className={`${inputCls} pl-6`}
            />
          </label>
          <select
            value={filters.server}
            onChange={e => setFilters(f => ({ ...f, server: e.target.value }))}
            aria-label="Filtrar por servidor"
            className={`${inputCls} cursor-pointer [color-scheme:dark]`}
          >
            <option value="">Todos os servidores</option>
            {serverOptions.map(server => <option key={server} value={server}>{server}</option>)}
          </select>
          <select
            value={filters.quest}
            onChange={e => setFilters(f => ({ ...f, quest: e.target.value as SaleFilters["quest"] }))}
            aria-label="Filtrar por Quest"
            className={`${inputCls} cursor-pointer [color-scheme:dark]`}
          >
            <option value="">Todas as origens</option>
            <option value="soulwar">Soul War (SW)</option>
            <option value="sanguine">Sanguine (SG)</option>
            <option value="crypt">Graveborn (GB)</option>
            <option value="bazaar">Itens do Bazaar (sem Quest)</option>
          </select>
          {/* Faixa de valor: valores registrados existem só nos VENDIDOS. */}
          <div className={`flex items-center gap-1 ${tab === "vendidos" ? "" : "opacity-40 pointer-events-none"}`} title={tab === "vendidos" ? "Faixa de valor registrado (RC)" : "Disponível na aba Vendidos (pendentes não têm valor registrado)"}>
            <input
              type="text"
              inputMode="numeric"
              value={filters.minRC}
              onChange={e => setFilters(f => ({ ...f, minRC: e.target.value.replace(/\D+/g, "") }))}
              placeholder="RC mín."
              aria-label="Valor mínimo em RC"
              className={inputCls}
            />
            <span className="text-slate-600 text-[10px]">–</span>
            <input
              type="text"
              inputMode="numeric"
              value={filters.maxRC}
              onChange={e => setFilters(f => ({ ...f, maxRC: e.target.value.replace(/\D+/g, "") }))}
              placeholder="RC máx."
              aria-label="Valor máximo em RC"
              className={inputCls}
            />
          </div>
          {/* Ordenação — combinável com os filtros; agrupamento mantido */}
          <div className="col-span-2 sm:col-span-4 flex items-center gap-1.5">
            <span className="text-[9px] font-bold uppercase tracking-wider text-slate-500 flex-shrink-0">Ordenar por</span>
            <select
              value={sortKey}
              onChange={e => setSortKey(e.target.value as SaleSortKey)}
              aria-label="Critério de ordenação"
              className={`${inputCls} cursor-pointer [color-scheme:dark] flex-1`}
            >
              {SORT_OPTIONS.map(opt => <option key={opt.key} value={opt.key}>{opt.label}</option>)}
            </select>
            <button
              type="button"
              onClick={() => setSortDir(d => (d === "asc" ? "desc" : "asc"))}
              aria-label={sortDir === "asc" ? "Ordem crescente (clique para decrescente)" : "Ordem decrescente (clique para crescente)"}
              title={sortDir === "asc" ? "Crescente — clique para decrescente" : "Decrescente — clique para crescente"}
              className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg border border-white/10 bg-white/[0.03] text-slate-300 hover:text-amber-300 hover:border-amber-500/40 text-[10px] font-bold transition-colors cursor-pointer flex-shrink-0"
            >
              {sortDir === "asc" ? <ArrowDownAZ size={12} /> : <ArrowUpAZ size={12} />}
              {sortDir === "asc" ? "Cresc." : "Decresc."}
            </button>
          </div>
        </div>

        {/* Resumo financeiro — SÓ aba Vendidos, SÓ itens exibidos (pós-filtros);
            vendas sem valor ficam fora do total/média (contadas à parte). */}
        {soldSummary && soldSummary.shownCount > 0 && (
          <div className="mx-4 mt-2 px-3 py-2 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.06] flex items-center gap-x-4 gap-y-1 flex-wrap flex-shrink-0">
            <span className="inline-flex items-baseline gap-1.5">
              <span className="text-[9px] font-bold uppercase tracking-wider text-emerald-400/80">Total</span>
              <span className="text-[13px] font-black tabular-nums text-emerald-300">{formatRC(soldSummary.totalRC)}</span>
            </span>
            <span className="inline-flex items-baseline gap-1.5">
              <span className="text-[9px] font-bold uppercase tracking-wider text-emerald-400/80">Média</span>
              <span className="text-[13px] font-black tabular-nums text-emerald-300">{soldSummary.valuedCount > 0 ? formatRC(soldSummary.averageRC) : "—"}</span>
            </span>
            <span className="text-[9px] text-slate-500 ml-auto tabular-nums">
              {soldSummary.valuedCount} ite{soldSummary.valuedCount === 1 ? "m" : "ns"} com valor
              {soldSummary.noValueCount > 0 ? ` · ${soldSummary.noValueCount} sem valor informado` : ""}
            </span>
          </div>
        )}

        {error && (
          <div className="mx-4 mt-1 px-3 py-1.5 rounded-lg border border-red-500/40 bg-red-500/10 text-[10px] text-red-300 flex-shrink-0">
            {error}
          </div>
        )}

        {/* Lista agrupada por servidor */}
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3">
          {groupedByServer.length === 0 ? (
            <div className="py-10 text-center">
              <PackageOpen size={28} className="mx-auto text-slate-600 mb-2" />
              <p className="text-xs text-slate-500 italic">
                {items.length === 0
                  ? "Nenhum item de Quest declarado nem item do Bazaar marcado à venda nos seus personagens."
                  : tab === "avenda"
                    ? "Nenhum item pendente corresponde aos filtros atuais."
                    : "Nenhum item vendido corresponde aos filtros atuais."}
              </p>
            </div>
          ) : (
            groupedByServer.map(([server, list]) => (
              <section key={server} className="rounded-xl border border-white/10 bg-white/[0.02] overflow-hidden">
                <header className="flex items-center gap-1.5 px-3 py-1.5 bg-white/[0.04] border-b border-white/5 flex-wrap">
                  <Globe size={11} className="text-sky-400 flex-shrink-0" />
                  <span className="text-[10px] font-black uppercase tracking-wider text-sky-300 truncate">{server}</span>
                  {/* GERAR TEXTO DE VENDA (75ª): anúncio SÓ com os itens
                      AINDA À VENDA deste servidor (vendidos e outros
                      servidores ficam de fora), no formato configurado —
                      copiado direto para a área de transferência. */}
                  {(pendingItemsByServer.get(server)?.length || 0) > 0 && (
                    saleTextDone?.server === server ? (
                      <span className={`inline-flex items-center gap-1 text-[8px] font-black uppercase tracking-wide ${saleTextDone.ok ? "text-emerald-300" : "text-rose-300"}`} title={saleTextDone.message}>
                        {saleTextDone.ok ? <Check size={10} className="flex-shrink-0" /> : <AlertTriangle size={10} className="flex-shrink-0" />}
                        <span className="max-w-[220px] truncate">{saleTextDone.message}</span>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => { void generateSaleText(server); }}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-amber-500/35 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 text-[8px] font-black uppercase tracking-wide transition-colors cursor-pointer"
                        title={`Gerar e copiar o anúncio com os ${pendingItemsByServer.get(server)?.length || 0} ite${(pendingItemsByServer.get(server)?.length || 0) === 1 ? "m" : "ns"} à venda de ${server} — usa o Texto de Venda configurado; itens já vendidos e de outros servidores NÃO entram.`}
                      >
                        <Megaphone size={9} className="flex-shrink-0" /> Gerar Texto de Venda
                      </button>
                    )
                  )}
                  <span className="text-[9px] text-slate-500 tabular-nums ml-auto flex-shrink-0">
                    {list.length} ite{list.length === 1 ? "m" : "ns"}
                  </span>
                </header>
                <ul className="divide-y divide-white/5">
                  {list.map(item => {
                    const saving = savingKey === item.key;
                    // Valores do item (73ª): BASE vivo da Lista de Itens do
                    // SERVIDOR do item (fallback: base da compra, só Bazaar);
                    // CONSIDERADO = total do snapshot (Bazaar, editável) ou o
                    // próprio valor da lista (itens de Quest — sem Tier/qtd).
                    const listedItem = item.serverName ? findServerWatchedItem(watchedByServer, item.serverName, item.watchedName || item.itemName) : null;
                    const liveBaseKk = listedItem ? listedItem.valueKk : null;
                    const shownBaseKk = liveBaseKk !== null ? liveBaseKk : (item.source === "bazaar" && (item.snapshotBaseKk || 0) > 0 ? (item.snapshotBaseKk as number) : null);
                    const canEditConsidered = item.source === "bazaar" && item.matchIndex !== undefined;
                    // Fonte ÚNICA do considerado (mesma usada pelo Texto de Venda).
                    const consideredKk = itemConsideredKkOf(item);
                    const baseKey = `${item.key}:base`;
                    const totalKey = `${item.key}:total`;
                    const rowDone = editDone && (editDone.key === baseKey || editDone.key === totalKey) ? editDone : null;
                    return (
                      <li key={item.key} className="px-3 py-2 flex items-center gap-2 flex-wrap">
                        <div className="flex items-center gap-1.5 min-w-0 flex-1 basis-40">
                          <Swords size={11} className="text-slate-500 flex-shrink-0" />
                          {/* Nome do item — botão de COPIAR (73ª; mesmo padrão
                              do CharTable: clique copia SÓ o nome exato do
                              item, ✓ verde por 1,5s) */}
                          <button
                            type="button"
                            onClick={() => copyText(item.itemName, `${item.key}:name`)}
                            className="inline-flex items-center gap-1 min-w-0 rounded px-0.5 py-0.5 hover:bg-white/5 transition-colors cursor-pointer"
                            title="Clique para copiar o nome do item"
                          >
                            <span className="text-[11px] text-slate-200 font-semibold truncate">{item.itemName}</span>
                            {copiedKey === `${item.key}:name` && <Check size={12} className="text-emerald-400 flex-shrink-0" />}
                          </button>
                          {(item.tier || 0) > 0 && (
                            <span className="text-[8px] font-black px-1 py-px rounded border border-fuchsia-500/40 bg-fuchsia-500/15 text-fuchsia-300 flex-shrink-0" title={`Tier ${item.tier} — +${(item.tier || 0) * 30}% sobre o valor base`}>T{item.tier}</span>
                          )}
                          {(item.amount || 0) > 1 && (
                            <span className="text-[9px] font-bold text-slate-500 tabular-nums flex-shrink-0" title={`${item.amount} unidades`}>×{item.amount}</span>
                          )}
                        </div>
                        {/* VALOR BASE (73ª) — Lista de Itens do servidor do
                            item (vivo). O lápis (SÓ Boss) grava na lista SÓ
                            deste servidor; demais usuários apenas veem. */}
                        <span className="inline-flex items-center gap-1 flex-shrink-0 text-[10px] tabular-nums">
                          <span className="text-[8px] font-black uppercase tracking-wide text-slate-500">Base</span>
                          {canUpdateOfficialList && baseEdit?.key === baseKey ? (
                            <span className="inline-flex items-center gap-1">
                              <input
                                type="text"
                                inputMode="numeric"
                                autoFocus
                                value={baseEdit.value}
                                onChange={e => setBaseEdit(prev => (prev ? { ...prev, value: sanitizeDecimalKkText(e.target.value) } : prev))}
                                onKeyDown={e => {
                                  if (e.key === "Enter") { e.preventDefault(); confirmBaseEdit(item, baseKey); }
                                  if (e.key === "Escape") { e.preventDefault(); setBaseEdit(null); }
                                }}
                                placeholder="Base (kk)"
                                title={`Novo valor BASE (kk, até 1 casa decimal) de "${item.watchedName || item.itemName}" na Lista de Itens de ${item.serverName || "—"}. Enter salva, Esc cancela.`}
                                className="h-6 w-16 rounded-md border border-sky-500/60 bg-black/35 px-1.5 text-right font-mono text-[10px] text-sky-200 outline-none focus:border-sky-400"
                              />
                              <button type="button" onClick={() => confirmBaseEdit(item, baseKey)} className="p-0.5 rounded text-emerald-300 hover:bg-emerald-500/15 transition-colors cursor-pointer" title={`Salvar o novo valor base na Lista de Itens de ${item.serverName || "—"} — SOMENTE este servidor é alterado`}>
                                <Check size={12} strokeWidth={3} />
                              </button>
                              <button type="button" onClick={() => setBaseEdit(null)} className="p-0.5 rounded text-slate-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer" title="Cancelar">
                                <X size={12} />
                              </button>
                            </span>
                          ) : (
                            <>
                              <span
                                className="font-mono font-bold text-sky-200"
                                title={liveBaseKk !== null
                                  ? `Valor BASE de "${item.watchedName || item.itemName}" na Lista de Itens de ${item.serverName || "—"} — reflete edições na hora`
                                  : shownBaseKk !== null
                                    ? `Valor base registrado na compra — o item não está (mais) na Lista de Itens de ${item.serverName || "—"}`
                                    : `Sem valor base — o item não está na Lista de Itens de ${item.serverName || "este servidor"}`}
                              >
                                {shownBaseKk !== null ? formatKk(shownBaseKk) : "—"}
                              </span>
                              {liveBaseKk === null && shownBaseKk !== null && (
                                <span className="rounded border border-white/15 bg-white/5 px-1 py-px text-[7px] font-black uppercase tracking-wide text-slate-400" title={`Base registrada na compra — o item não está na Lista de Itens de ${item.serverName || "—"}`}>compra</span>
                              )}
                              {canUpdateOfficialList && !!item.serverName && (
                                <button
                                  type="button"
                                  onClick={() => setBaseEdit({ key: baseKey, value: shownBaseKk !== null ? String(shownBaseKk).replace(".", ",") : "" })}
                                  className="p-0.5 rounded text-sky-300 hover:bg-sky-500/15 transition-colors cursor-pointer"
                                  title={`Editar o valor BASE de "${item.watchedName || item.itemName}" na Lista de Itens de ${item.serverName} — grava SOMENTE neste servidor (os demais não mudam).`}
                                >
                                  <Pencil size={10} />
                                </button>
                              )}
                            </>
                          )}
                        </span>
                        {/* VALOR CONSIDERADO (73ª) — itens do Bazaar: total do
                            snapshot da compra, ajustável por QUALQUER usuário
                            (grava no registro do próprio personagem); itens de
                            Quest: o valor da lista do servidor (sem Tier/qtd). */}
                        <span className="inline-flex items-center gap-1 flex-shrink-0 text-[10px] tabular-nums">
                          <span className="text-[8px] font-black uppercase tracking-wide text-slate-500">Consid.</span>
                          {canEditConsidered && totalEdit?.key === totalKey ? (
                            <span className="inline-flex items-center gap-1">
                              <input
                                type="text"
                                inputMode="numeric"
                                autoFocus
                                value={totalEdit.value}
                                onChange={e => setTotalEdit(prev => (prev ? { ...prev, value: sanitizeDecimalKkText(e.target.value) } : prev))}
                                onKeyDown={e => {
                                  if (e.key === "Enter") { e.preventDefault(); confirmTotalEdit(item, totalKey); }
                                  if (e.key === "Escape") { e.preventDefault(); setTotalEdit(null); }
                                }}
                                placeholder="Total (kk)"
                                title={`Novo valor CONSIDERADO (kk, até 1 casa decimal) de "${item.itemName}" para este personagem. Enter salva, Esc cancela.`}
                                className="h-6 w-16 rounded-md border border-amber-500/60 bg-black/35 px-1.5 text-right font-mono text-[10px] text-amber-200 outline-none focus:border-amber-400"
                              />
                              <button type="button" onClick={() => confirmTotalEdit(item, totalKey)} className="p-0.5 rounded text-emerald-300 hover:bg-emerald-500/15 transition-colors cursor-pointer" title="Salvar o valor considerado no registro deste personagem (o modal “Ver” e os totais refletem na hora)">
                                <Check size={12} strokeWidth={3} />
                              </button>
                              <button type="button" onClick={() => setTotalEdit(null)} className="p-0.5 rounded text-slate-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer" title="Cancelar">
                                <X size={12} />
                              </button>
                            </span>
                          ) : (
                            <>
                              <span
                                className="font-mono font-bold text-amber-200"
                                title={item.source === "bazaar"
                                  ? "Valor considerado do item para este personagem (snapshot da compra)"
                                  : consideredKk !== null
                                    ? `Valor considerado = valor da Lista de Itens de ${item.serverName || "—"} (item de Quest — sem Tier/quantidade)`
                                    : `Sem valor considerado — o item não está na Lista de Itens de ${item.serverName || "este servidor"}`}
                              >
                                {consideredKk !== null && consideredKk > 0 ? formatKk(consideredKk) : "—"}
                              </span>
                              {canEditConsidered && (
                                <button
                                  type="button"
                                  onClick={() => setTotalEdit({ key: totalKey, value: consideredKk !== null && consideredKk > 0 ? String(consideredKk).replace(".", ",") : "" })}
                                  className="p-0.5 rounded text-amber-300 hover:bg-amber-500/15 transition-colors cursor-pointer"
                                  title={`Ajustar o valor CONSIDERADO de "${item.itemName}" para este personagem — gravado no registro do próprio personagem (o modal “Ver” e os totais refletem na hora; a Lista de Itens não muda).`}
                                >
                                  <Pencil size={10} />
                                </button>
                              )}
                            </>
                          )}
                        </span>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          {item.quest === "bazaar" ? (
                            /* Item do Bazaar (58ª): veio na COMPRA do
                               personagem — SEM Quest associada (nunca exibe
                               SW/SG/GB). Fúcsia = identidade da guia Itens. */
                            <span className="text-[8px] font-black px-1 py-px rounded border border-fuchsia-500/40 bg-fuchsia-500/15 text-fuchsia-300 uppercase tracking-wide" title="Item do Bazaar — veio na compra do personagem; sem Quest associada (SW/SG/GB)">Bazaar</span>
                          ) : (
                            <span className={`text-[8px] font-black px-1 py-px rounded border ${questBadgeColorBySigla(item.questSigla)}`} title={item.quest === "soulwar" ? "Soul War" : item.quest === "sanguine" ? "Sanguine" : "Graveborn"}>{item.questSigla}</span>
                          )}
                          {originBadge(item)}
                          {/* Data de INCLUSÃO do item — somente o dia; registros
                              antigos (ou negociados) sem a data exibem "—". */}
                          <span className="inline-flex items-center gap-0.5 text-[8px] font-semibold text-slate-500 tabular-nums" title="Data de inclusão do item no personagem">
                            <CalendarPlus size={8} className="flex-shrink-0" /> {formatDayBR(item.addedAtMs)}
                          </span>
                          {item.sold && item.soldAtMs !== null && (
                            <span className="inline-flex items-center gap-0.5 text-[8px] font-semibold text-emerald-500/70 tabular-nums" title="Data em que a venda foi registrada">
                              <Check size={8} className="flex-shrink-0" /> {formatDayBR(item.soldAtMs)}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 ml-auto flex-shrink-0">
                          {item.sold ? (
                            <>
                              {item.soldValueRC > 0 ? (
                                <span className="text-[11px] font-bold text-emerald-300 tabular-nums" title={item.saleSummary || undefined}>
                                  {formatRC(item.soldValueRC)}
                                </span>
                              ) : (
                                <span className="text-[9px] font-bold text-slate-400" title="Venda confirmada sem valor informado">
                                  sem valor
                                </span>
                              )}
                              <button
                                type="button"
                                disabled={saving}
                                onClick={() => setSaleTarget(item)}
                                title={item.saleSummary ? `Venda registrada (${item.saleSummary}) — clique para revisar` : "Venda registrada — clique para revisar o valor"}
                                className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border border-emerald-500/50 bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 text-[9px] font-bold transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-wait"
                              >
                                <Check size={9} /> Vendido
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              disabled={saving}
                              onClick={() => setSaleTarget(item)}
                              title="Registrar a venda do item (valor, cotação do RC e Taxa Market)"
                              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/25 text-[9px] font-bold transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-wait"
                            >
                              <Coins size={9} /> Vender
                            </button>
                          )}
                        </div>
                        {/* Feedback das edições de valor (73ª) — some sozinho */}
                        {rowDone && (
                          <p className={`w-full text-[9px] leading-snug pl-[18px] flex items-center gap-1 ${rowDone.ok ? "text-emerald-300" : "text-rose-300"}`} title={rowDone.message}>
                            {rowDone.ok ? <Check size={9} className="flex-shrink-0" /> : <AlertTriangle size={9} className="flex-shrink-0" />} {rowDone.message}
                          </p>
                        )}
                        {item.sold && item.saleSummary && (
                          <p className="w-full text-[9px] text-slate-500 leading-snug pl-[18px]" title={item.saleSummary}>
                            {item.saleSummary}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))
          )}
        </div>

        {/* Rodapé */}
        <div className="px-4 py-2.5 border-t border-white/5 bg-black/30 flex items-center justify-between gap-2 flex-shrink-0">
          <p className="text-[9px] text-slate-500 leading-snug">
            Vendas e valores são gravados no registro do próprio personagem (ou no Lucro Quest da negociação) — tudo reflete em Meus Personagens na hora.
          </p>
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg bg-gradient-to-r from-amber-700/80 to-amber-600/80 hover:from-amber-600 hover:to-amber-500 border border-amber-500/40 text-black text-[10px] font-black transition-all cursor-pointer flex-shrink-0"
          >
            Fechar
          </button>
        </div>
      </div>

      {/* CONFIGURAR TEXTO DE VENDA (75ª) — prévia com itens REAIS do 1º
          servidor com itens à venda; "Salvar" persiste POR USUÁRIO (local). */}
      {isSaleTextConfigOpen && (
        <SaleTextConfigModal
          initial={saleTextConfig}
          sampleItems={sampleServer ? saleTextInputsOf(sampleServer) : []}
          sampleLabel={sampleServer}
          onSave={config => {
            saveSaleTextConfig(currentUserUid, config);
            setSaleTextConfig(config);
            setIsSaleTextConfigOpen(false);
          }}
          onClose={() => setIsSaleTextConfigOpen(false)}
        />
      )}

      {/* Calculadora OFICIAL (mesmo modal do PartyPanel/CharTable), com os
          dados VIVOS do item. Para negociados não há registro completo
          persistido (o schema guarda só o lucro), então abre em branco. */}
      {liveSaleTarget && (
        <ItemSoldModal
          itemName={liveSaleTarget.itemName}
          contextLabel={`${liveSaleTarget.serverName || "Sem servidor"} — ${liveSaleTarget.quest === "bazaar" ? "Item do Bazaar" : liveSaleTarget.questSigla}`}
          initial={liveSaleTarget.saleRecord}
          /* Fonte local completa (personagem OU match do snapshot) comporta
             venda sem valor; só a negociação (schema = lucro numérico) não. */
          allowNoValue={liveSaleTarget.source !== "acquisition"}
          server={liveSaleTarget.serverName}
          onCancel={() => setSaleTarget(null)}
          onSave={sale => { void commitSale(sale); }}
        />
      )}
    </div>,
    document.body,
  );
}
