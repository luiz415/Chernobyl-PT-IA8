import { useMemo, useState, useRef, useCallback, useEffect } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Trash2, Pencil, Eye, EyeOff, Check, RotateCcw, ChevronLeft, ChevronRight, Plus, Shield, Handshake, Lock, X } from "lucide-react";
import type { Character, PartyTab, ProbableMarkersMap } from "../types";
import { VOCATIONS, VOC_COLORS, calcTotal, formatRC, formatDateBR, customConfirm } from "../types";
import { FilterSelect, FilterToggle, FilterNumber, FilterInline, type ToggleState } from "./FilterTypes";
import { serverLabel } from "../constants/servers";

type NumericOp = "gte" | "lte";
type BooleanFilter = "Sim" | "Não" | "À Venda" | "";

interface NumericFilterState {
  value: string;
  op: NumericOp;
}

interface ColumnDef {
  key: string;
  label: string;
  align?: "left" | "right" | "center";
  get: (c: Character) => string | number;
  render?: (c: Character) => React.ReactNode;
}

interface Props {
  characters: Character[];
  activeParties?: PartyTab[];
  readOnly?: boolean;
  showSaleDate?: boolean;
  onAdd?: () => void;
  onEdit?: (c: Character) => void;
  onDelete?: (id: string) => void;
  onToggleShare?: (id: string, shared: boolean) => void;
  onToggleShareAll?: (shared: boolean, visibleIds: string[]) => void;
  onNoteChange?: (id: string, notes: string) => void;
  onCharacterInlineChange?: (c: Character) => void;
  probableMarkers?: ProbableMarkersMap;
  /** IDs de personagens com negociação vinculada; apenas altera a identificação visual. */
  negotiatedCharacterIds?: ReadonlySet<string>;
  /** Personagens do dono original cujos resultados de Quest pertencem ao comprador. */
  lockedQuestFinancialIds?: ReadonlySet<string>;
}

const NUMERIC_COLUMNS = new Set(["level", "valorPago", "dropSW", "dropBakra", "valorVenda", "total"]);
const BOOLEAN_COLUMNS = new Set(["soulwar", "sanguine", "vendido"]);
const TEXT_FILTER_COLUMNS = new Set(["personagem", "dataCompra", "dataVenda", "notes"]);

const COLLAPSED_WIDTH = 22;

const DEFAULT_COL_WIDTHS: Record<string, number> = {
  account: 95, personagem: 100, servidor: 65, voc: 42, level: 48,
  soulwar: 45, sanguine: 45, pt: 45, dropSW: 70, dropBakra: 75, total: 75,
  dataCompra: 80, valorPago: 75, dataVenda: 80, vendido: 55, shared: 40,
  itemDropadoSW: 140, itemDropadoSG: 140,
};

export const SOULWAR_ITEMS = [
  "Soulbleeder", "Soulkamas", "Soulshredder", "Pair of Soulwalkers", "Soulshell",
  "Pair of Soulstalkers", "Souleater", "Soulmaimer", "Soultainter", "Soulmantle",
  "Soulgarb", "Soulhexer", "Soulcrusher", "Soulshanks", "Soulstrider",
  "Soulsoles", "Soulcutter", "Soulpiercer", "Soulshroud", "Soulbastion", "Soulbiter",
];

export const SANGUINE_ITEMS = [
  "Grand Sanguine Bow", "Grand Sanguine Crossbow", "Grand Sanguine Rod",
  "Grand Sanguine Coil", "Grand Sanguine Claws", "Grand Sanguine Blade",
  "Grand Sanguine Battleaxe", "Grand Sanguine Bludgeon", "Grand Sanguine Razor",
  "Grand Sanguine Hatchet", "Grand Sanguine Cudgel",
  "Sanguine Bow", "Sanguine Legs", "Sanguine Greaves", "Sanguine Coil",
  "Sanguine Razor", "Sanguine Claws", "Sanguine Rod", "Sanguine Trousers",
  "Sanguine Boots", "Sanguine Galoshes", "Sanguine Bludgeon", "Sanguine Blade",
  "Sanguine Crossbow", "Sanguine Battleaxe", "Sanguine Hatchet", "Sanguine Cudgel",
];

/**
 * Cores oficiais por item (compartilhadas — importadas por outros módulos,
 * ex.: histórico privado). Antes de alterar aqui, lembre que PartyPanel e
 * StatsPanel mantêm cópias locais do MESMO mapa.
 */
export const ITEM_COLORS: Record<string, string> = {
  "Soulbleeder": "#22c55e", "Soulkamas": "#22c55e", "Soulshredder": "#22c55e",
  "Pair of Soulwalkers": "#4ade80", "Soulshell": "#4ade80",
  "Pair of Soulstalkers": "#86efac", "Souleater": "#86efac", "Soulmaimer": "#86efac",
  "Soultainter": "#a3e635", "Soulmantle": "#a3e635", "Soulgarb": "#a3e635",
  "Soulhexer": "#eab308", "Soulcrusher": "#eab308",
  "Soulshanks": "#f97316", "Soulstrider": "#f97316", "Soulsoles": "#f97316",
  "Soulcutter": "#ef4444", "Soulpiercer": "#ef4444",
  "Soulshroud": "#dc2626", "Soulbastion": "#dc2626", "Soulbiter": "#dc2626",
  "Grand Sanguine Bow": "#fbbf24", "Grand Sanguine Crossbow": "#fbbf24",
  "Grand Sanguine Rod": "#fbbf24", "Grand Sanguine Coil": "#fbbf24",
  "Grand Sanguine Claws": "#fbbf24", "Grand Sanguine Blade": "#fbbf24",
  "Grand Sanguine Battleaxe": "#fbbf24", "Grand Sanguine Bludgeon": "#fbbf24",
  "Grand Sanguine Razor": "#fbbf24", "Grand Sanguine Hatchet": "#fbbf24",
  "Grand Sanguine Cudgel": "#fbbf24",
  "Sanguine Bow": "#22c55e", "Sanguine Legs": "#22c55e",
  "Sanguine Greaves": "#4ade80", "Sanguine Coil": "#4ade80",
  "Sanguine Razor": "#86efac", "Sanguine Claws": "#86efac",
  "Sanguine Rod": "#a3e635", "Sanguine Trousers": "#a3e635",
  "Sanguine Boots": "#eab308", "Sanguine Galoshes": "#eab308",
  "Sanguine Bludgeon": "#f97316", "Sanguine Blade": "#f97316",
  "Sanguine Crossbow": "#ef4444", "Sanguine Battleaxe": "#ef4444",
  "Sanguine Hatchet": "#dc2626", "Sanguine Cudgel": "#dc2626",
};

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = ((h << 5) - h) + s.charCodeAt(i); h |= 0; }
  return Math.abs(h);
}
function acctBg(name: string): string {
  if (!name) return "transparent";
  return `hsla(${hashStr(name) % 360}, 40%, 50%, 0.10)`;
}
function acctBorder(name: string): string {
  if (!name) return "transparent";
  return `hsla(${hashStr(name) % 360}, 50%, 55%, 0.22)`;
}
function isForSale(c: Character): boolean { return !c.vendido && !!c.aVenda; }
function getSaleLabel(c: Character): "Sim" | "Não" | "À Venda" {
  if (c.vendido) return "Sim";
  if (isForSale(c)) return "À Venda";
  return "Não";
}
function displayRC(value: number): string { return value === 0 ? "—" : formatRC(value); }


function usePersistedState<T>(key: string, initial: T) {
  function readValue(): T {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : initial;
    } catch { return initial; }
  }
  const [val, setVal] = useState<T>(() => {
    return readValue();
  });
  const keyRef = useRef(key);
  useEffect(() => {
    if (keyRef.current === key) return;
    keyRef.current = key;
    setVal(readValue());
  }, [key]);
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} }, [key, val]);
  return [val, setVal] as const;
}

interface SortEntry { key: string; dir: "asc" | "desc"; }
interface ContextMenuState { colKey: string; label: string; x: number; y: number; }

import { createPortal } from "react-dom";

export function ItemSelect({ value, onChange, itemList, disabled = false, disabledReason }: { value: string; onChange: (v: string) => void | Promise<void>; itemList: string[]; disabled?: boolean; disabledReason?: string }) {
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0, maxHeight: 200 });
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  function updateMenuPosition() {
    if (!wrapRef.current) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom - 12;
    const spaceAbove = rect.top - 12;
    const maxHeight = Math.max(140, Math.min(240, Math.max(spaceBelow, spaceAbove)));
    const openUp = spaceBelow < 180 && spaceAbove > spaceBelow;
    setMenuPos({
      top: openUp ? Math.max(8, rect.top - maxHeight - 4) : rect.bottom + 4,
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 228)),
      maxHeight,
    });
  }

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const target = e.target as Node;
      if (wrapRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  useEffect(() => {
    if (!open) return;
    updateMenuPosition();
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
    return () => {
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [open]);

  const selectedColor = ITEM_COLORS[value] || "#e2e8f0";
  const isSelected = !!value && itemList.includes(value);

  return (
    <div
      ref={wrapRef}
      className="relative min-w-[110px]"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={(e) => { if (disabled) return; e.stopPropagation(); updateMenuPosition(); setOpen(prev => !prev); }}
        style={isSelected ? { color: selectedColor, fontWeight: 600 } : undefined}
        title={disabled ? (disabledReason || "Drop aguardando a conclusão da Quest") : undefined}
        className={`w-full min-w-[100px] bg-transparent border-b border-white/10 hover:border-cyan-500/50 ${open ? "border-cyan-500/50" : ""} outline-none px-1 py-1 text-[11px] text-left cursor-pointer transition-colors ${isSelected ? "" : "text-slate-600"} ${disabled ? "cursor-default opacity-75 hover:border-white/10" : ""}`}
      >
        {value || "Item..."}
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          className="fixed z-[500] w-[220px] overflow-auto bg-[var(--th-n-hi)] border border-white/10 rounded-lg shadow-2xl shadow-black/60"
          style={{ top: menuPos.top, left: menuPos.left, maxHeight: menuPos.maxHeight }}
        >
          <div
            onClick={() => { onChange(""); setOpen(false); }}
            className="px-2 py-1.5 text-[11px] cursor-pointer hover:bg-rose-500/15 transition-colors text-rose-400 font-bold border-b border-white/10 flex items-center gap-1"
          >
            <X size={11} /> Limpar
          </div>
          {itemList.map(item => (
            <div
              key={item}
              onClick={() => { onChange(item); setOpen(false); }}
              className={`px-2 py-1.5 text-[11px] cursor-pointer hover:bg-white/10 transition-colors ${item === value ? "bg-white/10 font-bold" : ""}`}
              style={{ color: ITEM_COLORS[item] || "#94a3b8" }}
            >
              {item}
            </div>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}

function NoteCellInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [localValue, setLocalValue] = useState(value);
  const prevValueRef = useRef(value);

  useEffect(() => {
    if (prevValueRef.current !== value) {
      setLocalValue(value);
      prevValueRef.current = value;
    }
  }, [value]);

  return (
    <input
      type="text"
      value={localValue}
      onChange={(e) => setLocalValue(e.target.value)}
      onBlur={() => {
        if (localValue !== value) {
          onChange(localValue);
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.currentTarget.blur();
        }
      }}
      placeholder="—"
      className="w-full bg-transparent border-b border-white/10 focus:border-amber-500/50 outline-none px-1 py-1 text-slate-300 placeholder-slate-600 text-[11px]"
      maxLength={100}
    />
  );
}

const EMPTY_NEGOTIATED_CHARACTER_IDS: ReadonlySet<string> = new Set();

export default function CharTable({ characters, activeParties = [], readOnly, showSaleDate, onAdd, onEdit, onDelete, onToggleShare, onToggleShareAll: _onToggleShareAll, onNoteChange, onCharacterInlineChange, probableMarkers = {}, negotiatedCharacterIds = EMPTY_NEGOTIATED_CHARACTER_IDS, lockedQuestFinancialIds = EMPTY_NEGOTIATED_CHARACTER_IDS }: Props) {
  const tableScope = showSaleDate ? "history" : "active";
  const storageKey = (key: string) => `table_${tableScope}_${key}`;
  const defaultSortStack: SortEntry[] = showSaleDate ? [{ key: "dataVenda", dir: "desc" }] : [{ key: "account", dir: "asc" }];

  const [sortStack, setSortStack] = usePersistedState<SortEntry[]>(storageKey("sortStack"), defaultSortStack);
  const [selected, setSelected] = useState<string | null>(null);
  const [resizingCol, setResizingCol] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copiedCharId, setCopiedCharId] = useState<string | null>(null);
  const resizeRef = useRef({ startX: 0, startW: 0 });

  const [textFilters, setTextFilters] = usePersistedState<Record<string, string>>(storageKey("textFilters"), {});
  const [choiceFilters, setChoiceFilters] = usePersistedState<Record<string, string>>(storageKey("choiceFilters"), {});
  const [numericFilters, setNumericFilters] = usePersistedState<Record<string, NumericFilterState>>(storageKey("numericFilters"), {});
  const [booleanFilters, setBooleanFilters] = usePersistedState<Record<string, BooleanFilter>>(storageKey("booleanFilters"), {});
  const [accountVisible, setAccountVisible] = usePersistedState(storageKey("accountVisible"), true);
  const [personagemVisible, setPersonagemVisible] = usePersistedState(storageKey("personagemVisible"), true);
  const [colWidths, setColWidths] = usePersistedState<Record<string, number>>(storageKey("colWidths_v2"), { ...DEFAULT_COL_WIDTHS });

  const [ptFilter, setPtFilter] = usePersistedState<boolean>(storageKey("ptFilter"), false);

  const [hiddenColumns, setHiddenColumns] = usePersistedState<string[]>(storageKey("hiddenColumns"), []);
  const hiddenSet = useMemo(() => new Set(hiddenColumns), [hiddenColumns]);

  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
  const [ctxWidthInput, setCtxWidthInput] = useState("");
  const ctxInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setSelected(null);
    setCtxMenu(null);
    setCopiedId(null);
    setCopiedCharId(null);
  }, [tableScope]);

  useEffect(() => {
    if (!ctxMenu) return;
    function handleClick() { setCtxMenu(null); }
    window.addEventListener("mousedown", handleClick);
    return () => window.removeEventListener("mousedown", handleClick);
  }, [ctxMenu]);

  useEffect(() => {
    if (ctxMenu) {
      setCtxWidthInput(String(colWidths[ctxMenu.colKey] ?? DEFAULT_COL_WIDTHS[ctxMenu.colKey] ?? 80));
      setTimeout(() => ctxInputRef.current?.select(), 30);
    }
  }, [ctxMenu]);

  function handleContextMenu(colKey: string, label: string, e: React.MouseEvent) {
    e.preventDefault(); e.stopPropagation();
    setCtxMenu({ colKey, label, x: e.clientX, y: e.clientY });
  }

  function applyCtxWidth() {
    if (!ctxMenu) return;
    const n = parseInt(ctxWidthInput, 10);
    if (Number.isFinite(n) && n >= 20) {
      setColWidths(prev => ({ ...prev, [ctxMenu.colKey]: n }));
    }
    setCtxMenu(null);
  }

  function toggleHideColumn(key: string) {
    setHiddenColumns((prev) => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);
  }

  const [columnsOrder, setColumnsOrder] = usePersistedState<string[]>(storageKey("columnsOrder_v7"), [
    "account", "personagem", "servidor", "voc", "level", "soulwar", "sanguine", "pt", "itemDropadoSW", "itemDropadoSG", "dropSW", "dropBakra", "total", "dataCompra", "valorPago", "dataVenda", "vendido", "shared"
  ]);

  const characterInParty = useMemo(() => {
    const map = new Map<string, string>();
    activeParties.forEach(party => {
      party.selectedIds.forEach(charId => {
        map.set(charId, party.name);
      });
    });
    return map;
  }, [activeParties]);

  const accountOptions = useMemo(
    () => Array.from(new Set(characters.map((c) => c.account).filter(Boolean))).sort((a, b) => a.localeCompare(b, "pt-BR")),
    [characters]
  );
  const serverOptions = useMemo(
    () => Array.from(new Set(characters.map((c) => serverLabel(c.servidor)).filter(Boolean))).sort((a, b) => a.localeCompare(b, "pt-BR")),
    [characters]
  );
  const vocOptions = useMemo(
    () => VOCATIONS.filter((v) => characters.some((c) => c.voc === v)),
    [characters]
  );

  async function copyAccount(text: string, id: string) {
    try { await navigator.clipboard.writeText(text); } catch { /* fallback */ }
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  }

  async function copyCharacterName(text: string, id: string) {
    try { await navigator.clipboard.writeText(text); } catch { /* fallback */ }
    setCopiedCharId(id);
    setTimeout(() => setCopiedCharId(null), 1500);
  }

  const handleResizeStart = useCallback((colKey: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = { startX: e.clientX, startW: colWidths[colKey] ?? DEFAULT_COL_WIDTHS[colKey] ?? 100 };
    setResizingCol(colKey);
  }, [colWidths]);

  useEffect(() => {
    if (!resizingCol) return;
    function onMove(e: MouseEvent) {
      const delta = e.clientX - resizeRef.current.startX;
      const min = (resizingCol === "account" || resizingCol === "level") ? 25 : 40;
      const w = Math.max(min, resizeRef.current.startW + delta);
      setColWidths(prev => ({ ...prev, [resizingCol!]: w }));
    }
    function onUp() {
      setResizingCol(null);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [resizingCol]);

  const columns: ColumnDef[] = useMemo(() => [
    {
      key: "account", label: "Account", align: "center",
      get: (c) => c.account,
      render: (c) => accountVisible
        ? (
          <button
            onClick={(e) => { e.stopPropagation(); copyAccount(c.account, c.id); }}
            className="w-full text-center group-hover:bg-white/5 rounded px-0.5 py-0.5 transition-colors flex items-center justify-center gap-1 min-w-0 cursor-pointer"
            title="Clique para copiar o nome da conta"
          >
            <span
              className="text-slate-300 truncate text-[10px]"
              style={c.account ? { backgroundColor: acctBg(c.account), padding: "1px 4px", borderRadius: "3px", borderLeft: `2px solid ${acctBorder(c.account)}` } : undefined}
            >
              {c.account}
            </span>
            {copiedId === c.id && <Check size={12} className="text-emerald-400 flex-shrink-0" />}
          </button>
        )
        : <span className="text-slate-600 tracking-[0.18em] select-none text-[10px]">••••••</span>,
    },
    {
      key: "personagem", label: "Personagem", align: "center",
      get: (c) => c.personagem,
      render: (c) => {
        const hasNegotiation = negotiatedCharacterIds.has(c.id);
        return personagemVisible
          ? (
            <button
              onClick={(e) => { e.stopPropagation(); copyCharacterName(c.personagem, c.id); }}
              className="w-full text-center rounded px-0.5 py-0.5 flex items-center justify-center gap-1 min-w-0 cursor-pointer hover:bg-white/5 transition-colors"
              title="Clique para copiar o nome do personagem"
            >
              <span className="font-medium text-slate-100 text-[11px] truncate">
                {c.personagem}
              </span>
              {hasNegotiation && <span className="inline-flex flex-shrink-0" title="Personagem com negociação entre usuários vinculada" aria-label="Negociação entre usuários vinculada"><Handshake size={11} className="text-violet-300" /></span>}
              {copiedCharId === c.id && <Check size={12} className="text-emerald-400 flex-shrink-0" />}
            </button>
          )
          : (
            <span className="inline-flex items-center gap-1 text-slate-600 tracking-[0.18em] select-none text-[10px]">
              ••••••
              {hasNegotiation && <span className="inline-flex flex-shrink-0" title="Personagem com negociação entre usuários vinculada" aria-label="Negociação entre usuários vinculada"><Handshake size={11} className="text-violet-400" /></span>}
            </span>
          );
      },
    },
    {
      key: "servidor", label: "Servidor", align: "center",
      // Nome canônico: um personagem gravado como "Spectrum" aparece (e é
      // filtrado/ordenado) como "Bellum". O dado salvo não muda.
      get: (c) => serverLabel(c.servidor),
    },
    {
      key: "voc", label: "Voc", align: "center",
      get: (c) => c.voc,
      render: (c) => (
        <span className="font-bold tracking-wider text-[11px]" style={{ color: VOC_COLORS[c.voc] }}>
          {c.voc}
        </span>
      ),
    },
    {
      key: "level", label: "Lv", align: "center",
      get: (c) => c.level,
      render: (c) => <span className="tabular-nums text-[11px]">{c.level}</span>,
    },
    {
      key: "soulwar", label: "SW", align: "center",
      get: (c) => (c.soulwar ? "Sim" : "Não"),
      render: (c) => {
        const hasProbableMarker = probableMarkers[c.id]?.soulwar === true;
        const showWarning = hasProbableMarker && c.soulwar;
        return (
          <span className={`inline-flex items-center gap-0.5 ${showWarning ? "relative" : ""}`} title={showWarning ? "Esse personagem provavelmente já fez Soulwar e precisa ser atualizado." : undefined}>
            <span className={`font-semibold text-[14px] ${c.soulwar ? "text-emerald-400" : "text-rose-400"}`}>
              {c.soulwar ? "✓" : "✕"}
            </span>
            {showWarning && (
              <span className="text-rose-500 text-[12px] animate-pulse leading-none" title="Esse personagem provavelmente já fez Soulwar e precisa ser atualizado.">⚠</span>
            )}
          </span>
        );
      },
    },
    {
      key: "sanguine", label: "SG", align: "center",
      get: (c) => (c.sanguine ? "Sim" : "Não"),
      render: (c) => {
        const hasProbableMarker = probableMarkers[c.id]?.sanguine === true;
        const showWarning = hasProbableMarker && c.sanguine;
        return (
          <span className={`inline-flex items-center gap-0.5 ${showWarning ? "relative" : ""}`} title={showWarning ? "Esse personagem provavelmente já fez Sanguine e precisa ser atualizado." : undefined}>
            <span className={`font-semibold text-[14px] ${c.sanguine ? "text-emerald-400" : "text-rose-400"}`}>
              {c.sanguine ? "✓" : "✕"}
            </span>
            {showWarning && (
              <span className="text-rose-500 text-[12px] animate-pulse leading-none" title="Esse personagem provavelmente já fez Sanguine e precisa ser atualizado.">⚠</span>
            )}
          </span>
        );
      },
    },
    {
      key: "pt", label: "PT", align: "center",
      get: (c) => characterInParty.has(c.id) ? 1 : 0,
      render: (c) => {
        const partyName = characterInParty.get(c.id);
        return (
          <div className="flex items-center justify-center" title={partyName ? `Em PT: ${partyName}` : ""}>
            {partyName ? (
              <Shield size={14} className="text-violet-400" />
            ) : (
              <span className="text-slate-600 text-[11px]">—</span>
            )}
          </div>
        );
      },
    },
    {
      key: "itemDropadoSW", label: "DROP SW", align: "center",
      get: (c) => c.itemDropadoSW || "",
      render: (c) => {
        const locked = lockedQuestFinancialIds.has(c.id);
        return (
          <ItemSelect
            value={c.itemDropadoSW || ""}
            onChange={(val) => onCharacterInlineChange?.({ ...c, itemDropadoSW: val })}
            itemList={SOULWAR_ITEMS}
            disabled={locked}
            disabledReason="Bloqueado: o Drop SW desta Quest pertence ao comprador da negociação"
          />
        );
      },
    },
    {
      key: "itemDropadoSG", label: "DROP SG", align: "center",
      get: (c) => c.itemDropadoSG || "",
      render: (c) => {
        const locked = lockedQuestFinancialIds.has(c.id);
        return (
          <ItemSelect
            value={c.itemDropadoSG || ""}
            onChange={(val) => onCharacterInlineChange?.({ ...c, itemDropadoSG: val })}
            itemList={SANGUINE_ITEMS}
            disabled={locked}
            disabledReason="Bloqueado: o Drop SG desta Quest pertence ao comprador da negociação"
          />
        );
      },
    },
    {
      key: "dropSW", label: "LUCRO SW", align: "center",
      get: (c) => c.dropSW,
      render: (c) => {
        const locked = lockedQuestFinancialIds.has(c.id);
        return <span title={locked ? "Bloqueado: o Lucro SW desta Quest pertence ao comprador da negociação" : undefined} className={`inline-flex items-center gap-1 tabular-nums text-[11px] ${locked ? "text-slate-500" : "text-slate-300"}`}>{locked && <Lock size={10} className="text-violet-300" />}{displayRC(c.dropSW)}</span>;
      },
    },
    {
      key: "dropBakra", label: "LUCRO SG", align: "center",
      get: (c) => c.dropBakra,
      render: (c) => {
        const locked = lockedQuestFinancialIds.has(c.id);
        return <span title={locked ? "Bloqueado: o Lucro SG desta Quest pertence ao comprador da negociação" : undefined} className={`inline-flex items-center gap-1 tabular-nums text-[11px] ${locked ? "text-slate-500" : "text-slate-300"}`}>{locked && <Lock size={10} className="text-violet-300" />}{displayRC(c.dropBakra)}</span>;
      },
    },
    {
      key: "total", label: "Total", align: "center",
      // A negociação transfere a perspectiva financeira ao comprador; o dono
      // original não pode ver nem usar um Total normal para esse Character.
      get: (c) => lockedQuestFinancialIds.has(c.id) ? 0 : calcTotal(c),
      render: (c) => {
        if (lockedQuestFinancialIds.has(c.id)) {
          return <span title="Total não se aplica ao dono original: os resultados financeiros pertencem ao comprador" className="inline-flex items-center gap-1 text-[11px] font-bold text-slate-500"><Lock size={10} className="text-violet-300" /> —</span>;
        }
        const t = calcTotal(c);
        return (
          <span className={`tabular-nums font-bold text-[11px] ${t === 0 ? "text-slate-500" : t > 0 ? "text-emerald-400" : "text-rose-400"}`}>
            {displayRC(t)}
          </span>
        );
      },
    },
    ...(!showSaleDate ? [{
      key: "dataCompra", label: "Compra", align: "center" as const,
      get: (c: Character) => c.dataCompra || "",
      render: (c: Character) => (
        <span className="tabular-nums text-slate-200 font-medium text-[10px]">{formatDateBR(c.dataCompra)}</span>
      ),
    }, {
      key: "valorPago", label: "Custo", align: "center" as const,
      get: (c: Character) => c.valorPago,
      render: (c: Character) => <span className="tabular-nums text-slate-300 text-[11px]">{displayRC(c.valorPago)}</span>,
    }] : []),
    ...(showSaleDate ? [{
      key: "dataVenda", label: "Venda", align: "center" as const,
      get: (c: Character) => c.dataVenda || "",
      render: (c: Character) => (
        <span className="tabular-nums text-slate-200 font-medium text-[10px]">{formatDateBR(c.dataVenda)}</span>
      ),
    }, {
      key: "valorVenda", label: "Valor Venda (RC)", align: "center" as const,
      get: (c: Character) => c.valorVenda,
      render: (c: Character) => (
        <span className="tabular-nums text-amber-400 font-medium text-[11px]">{displayRC(c.valorVenda)}</span>
      ),
    }, {
      key: "valorPago", label: "Custo", align: "center" as const,
      get: (c: Character) => c.valorPago,
      render: (c: Character) => <span className="tabular-nums text-slate-300 text-[11px]">{displayRC(c.valorPago)}</span>,
    }] : []),
    {
      key: "vendido", label: "Vendido", align: "center",
      get: (c) => getSaleLabel(c),
      render: (c) => {
        const label = getSaleLabel(c);
        return (
          <span
            className={`inline-flex px-1.5 py-0.5 rounded-md text-[10px] font-semibold ${
              label === "Sim"
                ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
                : label === "À Venda"
                  ? "bg-amber-500/15 text-amber-400 border border-amber-500/30"
                  : "bg-sky-500/15 text-sky-400 border border-sky-500/30"
            }`}
          >
            {label}
          </span>
        );
      },
    },
    ...(!showSaleDate ? [{
      key: "shared", label: "🔗", align: "center" as const,
      get: (c: Character) => (c.shared !== false ? "Sim" : "Não"),
      render: (c: Character) => {
        const isShared = c.shared !== false;
        return (
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (isShared) {
                customConfirm("Ao desativar o compartilhamento, este personagem NÃO ficará visível na lista de PT's para outros usuários.\n\nDeseja continuar?", () => {
                  onToggleShare?.(c.id, false);
                });
              } else {
                onToggleShare?.(c.id, true);
              }
            }}
            className={`inline-flex items-center justify-center w-6 h-6 rounded border text-[10px] font-bold transition-all ${
              isShared
                ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25"
                : "border-rose-500/40 bg-rose-500/15 text-rose-400 hover:bg-rose-500/25"
            }`}
            title={isShared ? "Compartilhando — visível nas PT's" : "Não compartilhado — oculto nas PT's"}
          >
            {isShared ? "✓" : "✕"}
          </button>
        );
      },
    }] : []),
  ], [accountVisible, personagemVisible, showSaleDate, copiedId, copiedCharId, onToggleShare, characterInParty, onCharacterInlineChange, probableMarkers, negotiatedCharacterIds, lockedQuestFinancialIds]);

  const orderedColumns = useMemo(() => {
    const baseCols = [...columns];
    const orderMap = new Map(columnsOrder.map((k, i) => [k, i]));
    return baseCols.sort((a, b) => (orderMap.get(a.key) ?? 999) - (orderMap.get(b.key) ?? 999));
  }, [columns, columnsOrder]);

  function moveColumn(fromIndex: number, toIndex: number) {
    if (toIndex < 0 || toIndex >= orderedColumns.length) return;
    const fromKey = orderedColumns[fromIndex].key;
    setColumnsOrder((prev) => {
      const arr = prev.includes(fromKey) ? [...prev] : orderedColumns.map(c => c.key);
      const curFrom = arr.indexOf(fromKey);
      const targetKey = orderedColumns[toIndex].key;
      const curTo = arr.indexOf(targetKey);
      if (curFrom !== -1 && curTo !== -1) {
        arr.splice(curFrom, 1);
        arr.splice(curTo, 0, fromKey);
      }
      return arr;
    });
  }

  const filtered = useMemo(() => {
    return characters.filter((c) => {
      for (const col of orderedColumns) {
        const key = col.key;

        if (TEXT_FILTER_COLUMNS.has(key)) {
          const f = textFilters[key]?.trim();
          if (!f) continue;
          const raw = String(col.get(c)).toLowerCase();
          const fmt = (key === "dataVenda" || key === "dataCompra") ? formatDateBR(String(col.get(c))).toLowerCase() : raw;
          if (!raw.includes(f.toLowerCase()) && !fmt.includes(f.toLowerCase())) return false;
          continue;
        }

        if (key === "account" || key === "servidor" || key === "voc" || key === "itemDropadoSW" || key === "itemDropadoSG") {
          const sel = choiceFilters[key];
          if (sel && String(col.get(c)) !== sel) return false;
          continue;
        }

        if (key === "shared") {
          const sel = choiceFilters["shared"];
          if (sel === "Sim" && c.shared === false) return false;
          if (sel === "Não" && c.shared !== false) return false;
          continue;
        }

        if (key === "pt") {
          if (ptFilter && !characterInParty.has(c.id)) return false;
          continue;
        }

        if (NUMERIC_COLUMNS.has(key)) {
          const st = numericFilters[key];
          if (!st?.value || st.value === "-") continue;
          const threshold = parseInt(st.value, 10);
          if (!Number.isFinite(threshold)) continue;
          const cur = Number(col.get(c));
          if (st.op === "gte" && cur < threshold) return false;
          if (st.op === "lte" && cur > threshold) return false;
          continue;
        }

        if (BOOLEAN_COLUMNS.has(key)) {
          const sel = booleanFilters[key];
          if (sel && String(col.get(c)) !== sel) return false;
        }
      }
      return true;
    });
  }, [characters, orderedColumns, textFilters, choiceFilters, numericFilters, booleanFilters, ptFilter, characterInParty]);

  const sorted = useMemo(() => {
    if (sortStack.length === 0) return filtered;

    const resolvedStack = sortStack
      .map((entry) => ({ col: orderedColumns.find((c) => c.key === entry.key), dir: entry.dir }))
      .filter((e) => e.col) as { col: ColumnDef; dir: "asc" | "desc" }[];

    if (resolvedStack.length === 0) return filtered;

    return [...filtered].sort((a, b) => {
      for (let i = resolvedStack.length - 1; i >= 0; i--) {
        const { col, dir } = resolvedStack[i];
        const av = col.get(a);
        const bv = col.get(b);
        let cmp = 0;
        if (typeof av === "number" && typeof bv === "number") {
          cmp = av - bv;
        } else {
          cmp = String(av).localeCompare(String(bv), "pt-BR", { sensitivity: "base" });
        }
        if (cmp !== 0) return dir === "asc" ? cmp : -cmp;
      }
      return 0;
    });
  }, [filtered, sortStack, orderedColumns]);

  function getSortEntry(key: string) { return sortStack.find((e) => e.key === key); }
  function getSortPriority(key: string) { const idx = sortStack.findIndex((e) => e.key === key); return idx === -1 ? -1 : sortStack.length - idx; }

  function toggleSort(key: string) {
    setSortStack((prev) => {
      const existing = prev.find((e) => e.key === key);

      if (!existing) {
        const baseStack = prev.length >= 2 ? prev.slice(1) : prev;
        return [...baseStack, { key, dir: "asc" }];
      }

      if (existing.dir === "asc") {
        return prev.map((e) => e.key === key ? { ...e, dir: "desc" as const } : e);
      }

      return prev.filter((e) => e.key !== key);
    });
  }


  function toggleBool(key: string, val: BooleanFilter) {
    setBooleanFilters((f) => ({ ...f, [key]: f[key] === val ? "" : val }));
  }

  function renderFilter(col: ColumnDef) {
    const key = col.key;

    // 1. Conta — FilterSelect searchable
    if (key === "account") {
      return (
        <div className="flex justify-center">
          <FilterSelect
            label="Conta"
            options={accountOptions}
            selected={choiceFilters.account || ""}
            onSelect={(v) => setChoiceFilters((f) => ({ ...f, account: v }))}
            searchable
            allLabel="Todas"
          />
        </div>
      );
    }

    // 2. Personagem — FilterInline (TEXT_FILTER_COLUMNS, handled below)
    // 3. Servidor — FilterSelect searchable
    if (key === "servidor") {
      return (
        <div className="flex justify-center">
          <FilterSelect
            label="Servidor"
            options={serverOptions}
            selected={choiceFilters.servidor || ""}
            onSelect={(v) => setChoiceFilters((f) => ({ ...f, servidor: v }))}
            searchable
          />
        </div>
      );
    }

    // 4. Vocação — FilterSelect sem searchable
    if (key === "voc") {
      return (
        <div className="flex justify-center">
          <FilterSelect
            label="Vocação"
            options={vocOptions}
            selected={choiceFilters.voc || ""}
            onSelect={(v) => setChoiceFilters((f) => ({ ...f, voc: v }))}
            allLabel="Todas"
          />
        </div>
      );
    }

    // 9. PT — FilterToggle com ícone de escudo
    if (key === "pt") {
      const ptState: ToggleState = ptFilter ? "yes" : "off";
      return (
        <div className="flex justify-center">
          <FilterToggle
            label=""
            state={ptState}
            onToggle={(s) => setPtFilter(s === "yes")}
            icon={<Shield size={11} />}
          />
        </div>
      );
    }

    // 10. Drop SW — FilterSelect searchable
    if (key === "itemDropadoSW") {
      return (
        <div className="flex justify-center">
          <FilterSelect
            label="Drop SW"
            options={SOULWAR_ITEMS}
            selected={choiceFilters.itemDropadoSW || ""}
            onSelect={(v) => setChoiceFilters((f) => ({ ...f, itemDropadoSW: v }))}
            searchable
          />
        </div>
      );
    }

    // 11. Drop SG — FilterSelect searchable
    if (key === "itemDropadoSG") {
      return (
        <div className="flex justify-center">
          <FilterSelect
            label="Drop SG"
            options={SANGUINE_ITEMS}
            selected={choiceFilters.itemDropadoSG || ""}
            onSelect={(v) => setChoiceFilters((f) => ({ ...f, itemDropadoSG: v }))}
            searchable
          />
        </div>
      );
    }

    // 12–16. Colunas numéricas — FilterNumber (level, dropSW, dropBakra, valorVenda, valorPago, total)
    if (NUMERIC_COLUMNS.has(key)) {
      const st = numericFilters[key] ?? { value: "", op: "gte" as NumericOp };
      return (
        <div className="flex justify-center">
          <FilterNumber
            label={col.label}
            value={st.value ? parseInt(st.value, 10) : null}
            operator={st.op}
            onChange={(v, op) => setNumericFilters((f) => ({ ...f, [key]: { value: v === null ? "" : String(v), op } }))}
          />
        </div>
      );
    }

    // 7–8. SW / SG — FilterToggle (✓/✕/−) via booleanFilters
    if (key === "soulwar" || key === "sanguine") {
      const sel = booleanFilters[key] || "";
      const state: ToggleState = sel === "Sim" ? "yes" : sel === "Não" ? "no" : "off";
      return (
        <div className="flex justify-center">
          <FilterToggle
            label=""
            state={state}
            onToggle={(s) => setBooleanFilters((f) => ({ ...f, [key]: s === "yes" ? "Sim" : s === "no" ? "Não" : "" }))}
          />
        </div>
      );
    }

    // 19. Vendido — manter exatamente o mesmo filtro
    if (key === "vendido") {
      const sel = booleanFilters[key] || "";
      return (
        <div className="grid grid-cols-2 gap-0.5">
          <button type="button" onClick={() => toggleBool(key, "À Venda")}
            className={`h-6 rounded border text-[9px] font-bold transition-colors ${
              sel === "À Venda" ? "border-amber-500/50 bg-amber-500/20 text-amber-300" : "border-amber-500/15 bg-black/20 text-amber-500/50 hover:bg-amber-500/10 hover:text-amber-300"
            }`}
            title="À Venda"
          >
            À Venda
          </button>
          <button type="button" onClick={() => toggleBool(key, "Não")}
            className={`h-6 rounded border text-[9px] font-bold transition-colors ${
              sel === "Não" ? "border-sky-500/50 bg-sky-500/20 text-sky-300" : "border-sky-500/15 bg-black/20 text-sky-500/50 hover:bg-sky-500/10 hover:text-sky-300"
            }`}
          >
            Não
          </button>
        </div>
      );
    }

    // 17. Compartilhar — FilterToggle (✓/✕/−) via choiceFilters.shared
    if (key === "shared") {
      const sel = choiceFilters["shared"] || "";
      const state: ToggleState = sel === "Sim" ? "yes" : sel === "Não" ? "no" : "off";
      return (
        <div className="flex justify-center">
          <FilterToggle
            label=""
            state={state}
            onToggle={(s) => setChoiceFilters((f) => ({ ...f, shared: s === "yes" ? "Sim" : s === "no" ? "Não" : "" }))}
          />
        </div>
      );
    }

    // 20. Compra — remover filtro
    if (key === "dataCompra") {
      return <div className="h-[22px]" />;
    }

    // 2. Personagem + 18. Anotações — FilterInline (TEXT_FILTER_COLUMNS)
    if (TEXT_FILTER_COLUMNS.has(key)) {
      if (key === "dataVenda") {
        return <input type="text" value={textFilters[key] || ""} onChange={(e) => setTextFilters((f) => ({ ...f, [key]: e.target.value }))} placeholder="…" className="filter-input text-center text-[10px]" />;
      }
      return (
        <div className="flex justify-center">
          <FilterInline
            value={textFilters[key] || ""}
            onChange={(v) => setTextFilters((f) => ({ ...f, [key]: v }))}
            maxWidth="90px"
          />
        </div>
      );
    }

    return <div className="h-[22px]" />;
  }

  const hasActiveFilters = useMemo(() => {
    return Object.values(textFilters).some(v => v.trim() !== "") ||
           Object.values(choiceFilters).some(v => v !== "") ||
           Object.values(numericFilters).some(v => v.value.trim() !== "") ||
           Object.values(booleanFilters).some(v => v !== "") ||
           ptFilter;
  }, [textFilters, choiceFilters, numericFilters, booleanFilters, ptFilter]);

  const totalW = orderedColumns.reduce((s, col) =>
    s + (hiddenSet.has(col.key) ? COLLAPSED_WIDTH : (colWidths[col.key] ?? DEFAULT_COL_WIDTHS[col.key] ?? 100))
  , 0) + 35 + (readOnly ? 0 : 50);

  return (
    <div className="h-full flex flex-col overflow-x-scroll overflow-y-auto bg-[var(--th-bg-base)] max-w-full min-w-0 relative border-t border-[var(--th-line)]/100">
      {/* Menu de contexto para definir largura */}
      {ctxMenu && (
        <div
          className="fixed z-[100] bg-[var(--th-n-hi)] border border-red-900/30 rounded-lg shadow-xl p-3 space-y-2 min-w-[180px]"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">
            Largura: <span className="text-white">{ctxMenu.label}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <input
              ref={ctxInputRef}
              type="text"
              inputMode="numeric"
              value={ctxWidthInput}
              onChange={(e) => setCtxWidthInput(e.target.value.replace(/\D/g, ""))}
              onKeyDown={(e) => {
                if (e.key === "Enter") applyCtxWidth();
                if (e.key === "Escape") setCtxMenu(null);
              }}
              className="ipt w-16 text-center tabular-nums text-xs py-1"
              maxLength={4}
            />
            <span className="text-[10px] text-slate-500">px</span>
            <button
              type="button"
              onClick={applyCtxWidth}
              className="px-2 py-1 rounded bg-[var(--th-line)]/40 hover:bg-[var(--th-brand-mid)]/30 border border-[var(--th-brand-mid)]/40 text-amber-600 text-[10px] font-bold transition-colors"
            >
              OK
            </button>
          </div>
          <button
            type="button"
            onClick={() => {
              setColWidths(prev => ({ ...prev, [ctxMenu.colKey]: DEFAULT_COL_WIDTHS[ctxMenu.colKey] ?? 80 }));
              setCtxMenu(null);
            }}
            className="w-full text-[10px] text-slate-500 hover:text-white py-1 rounded hover:bg-white/5 transition-colors text-left px-1"
          >
            Restaurar padrão ({DEFAULT_COL_WIDTHS[ctxMenu.colKey] ?? 80}px)
          </button>
        </div>
      )}

      <table className="text-sm border-separate border-spacing-0" style={{ minWidth: "100%", width: totalW }}>
        <colgroup>
          <col style={{ width: 35 }} />
          {orderedColumns.map((col) => (
            <col
              key={col.key}
              style={{ width: hiddenSet.has(col.key) ? COLLAPSED_WIDTH : (colWidths[col.key] ?? DEFAULT_COL_WIDTHS[col.key] ?? 100) }}
            />
          ))}
          {!readOnly && <col style={{ width: 50 }} />}
          {/* Coluna "Notas" — sem largura fixa para absorver o espaço restante automaticamente */}
          <col />
        </colgroup>

        <thead className="sticky top-0 z-30">
          {/* Header row */}
          <tr>
            <th className="bg-[var(--th-bg-raised)] text-center px-1 py-1.5 border-b border-r border-[var(--th-line)]/100 select-none font-bold text-[10px] text-slate-500 sticky left-0 z-40 shadow-[2px_0_5px_rgba(0,0,0,0.3)]">
              {!readOnly && onAdd && !showSaleDate ? (
                <button
                  onClick={onAdd}
                  className="
                    group/add relative inline-flex items-center justify-center
                    w-8 h-8 rounded-xl
                    bg-gradient-to-br from-amber-500 to-amber-600
                    text-white
                    shadow-lg shadow-amber-500/30
                    border border-amber-400/40
                    hover:from-amber-400 hover:to-amber-500
                    hover:shadow-xl hover:shadow-amber-500/40
                    hover:scale-110
                    active:scale-95
                    transition-all duration-200 ease-out
                    cursor-pointer
                  "
                  title="Adicionar personagem"
                >
                  {/* Glow ring effect */}
                  <span className="absolute inset-0 rounded-xl bg-amber-400/20 animate-ping opacity-40 pointer-events-none" style={{ animationDuration: '2.5s' }} />
                  {/* Inner glow */}
                  <span className="absolute inset-0 rounded-xl ring-2 ring-amber-400/0 group-hover/add:ring-amber-400/30 transition-all duration-300 pointer-events-none" />
                  <Plus size={18} strokeWidth={2.5} className="relative z-10 drop-shadow-sm" />
                </button>
              ) : (
                "#"
              )}
            </th>

            {orderedColumns.map((col, cIdx) => {
              const isHidden = hiddenSet.has(col.key);

              if (isHidden) {
                return (
                  <th
                    key={col.key}
                    className="bg-[var(--th-bg-raised)] border-b border-[var(--th-line)]/100 select-none p-0 align-middle"
                    title={`Coluna "${col.label}" oculta — clique para mostrar`}
                  >
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); toggleHideColumn(col.key); }}
                      className="w-full h-full flex items-center justify-center py-2 bg-sky-500/15 hover:bg-sky-500/25 border-sky-500/30 text-sky-400 hover:text-sky-300 transition-colors leading-none text-[11px] font-bold cursor-pointer"
                    >
                      ‹›
                    </button>
                  </th>
                );
              }

              return (
                <th
                  key={col.key}
                  className="bg-[var(--th-bg-overlay)] border-b border-[var(--th-line)]/100 select-none cursor-pointer hover:bg-[var(--th-bg-hover)] transition-colors relative group"
                  onClick={() => toggleSort(col.key)}
                  onContextMenu={(e) => handleContextMenu(col.key, col.label, e)}
                  title="Clique para ordenar • Botão direito para definir largura"
                >
                  {/* Topo: setas de movimentação + botão de ocultar (somente no hover) */}
                  <div className="flex items-center justify-center gap-0.5 px-1 pt-1">
                    <button
                      type="button"
                      disabled={cIdx === 0}
                      onClick={(e) => { e.stopPropagation(); moveColumn(cIdx, cIdx - 1); }}
                      className="p-0.5 hover:bg-white/10 text-slate-500 hover:text-white disabled:opacity-20 rounded"
                      title="Mover coluna para a esquerda"
                    >
                      <ChevronLeft size={9} />
                    </button>
                    <button
                      type="button"
                      disabled={cIdx === orderedColumns.length - 1}
                      onClick={(e) => { e.stopPropagation(); moveColumn(cIdx, cIdx + 1); }}
                      className="p-0.5 hover:bg-white/10 text-slate-500 hover:text-white disabled:opacity-20 rounded"
                      title="Mover coluna para a direita"
                    >
                      <ChevronRight size={9} />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); toggleHideColumn(col.key); }}
                      className="p-0.5 ml-0.5 rounded bg-rose-500/0 border border-rose-700/10 text-rose-700 hover:bg-rose-500/40 hover:text-rose-400 leading-none text-[10px] font-black flex items-center justify-center"
                      title={`Ocultar coluna "${col.label}"`}
                    >
                      <EyeOff size={9} />
                    </button>
                  </div>

                  {/* Baixo: label + sort + eye */}
                  <div
                    className={`flex items-center gap-0.5 px-1.5 pb-1.5 pt-0.5 text-[10px] uppercase font-semibold tracking-wider text-slate-300 ${
                      col.align === "right" ? "justify-end" : col.align === "center" ? "justify-center" : ""
                    }`}
                  >
                    <span className="truncate">{col.label}</span>
                    {col.key === "account" && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setAccountVisible((v) => !v); }}
                        className={`p-0.5 rounded border transition-colors flex-shrink-0 ${
                          accountVisible ? "border-[var(--th-brand-mid)]/40 bg-[var(--th-line)]/30 text-amber-600 hover:bg-[var(--th-line)]/50" : "border-rose-500/30 bg-rose-500/10 text-rose-400 hover:bg-rose-500/20"
                        }`}
                        title={accountVisible ? "Ocultar Account" : "Mostrar Account"}
                      >
                        {accountVisible ? <Eye size={11} /> : <EyeOff size={11} />}
                      </button>
                    )}
                    {col.key === "personagem" && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setPersonagemVisible((v) => !v); }}
                        className={`p-0.5 rounded border transition-colors flex-shrink-0 ${
                          personagemVisible ? "border-[var(--th-brand-mid)]/40 bg-[var(--th-line)]/30 text-amber-600 hover:bg-[var(--th-line)]/50" : "border-rose-500/30 bg-rose-500/10 text-rose-400 hover:bg-rose-500/20"
                        }`}
                        title={personagemVisible ? "Ocultar Personagem" : "Mostrar Personagem"}
                      >
                        {personagemVisible ? <Eye size={11} /> : <EyeOff size={11} />}
                      </button>
                    )}
                    {(() => {
                      const entry = getSortEntry(col.key);
                      const priority = getSortPriority(col.key);
                      if (!entry) return <ArrowUpDown size={9} className="opacity-30 flex-shrink-0" />;
                      return (
                        <span className="inline-flex items-center gap-0.5 flex-shrink-0">
                          {entry.dir === "asc"
                            ? <ArrowUp size={9} className="text-emerald-400" />
                            : <ArrowDown size={9} className="text-emerald-400" />
                          }
                          {sortStack.length > 1 && (
                            <span className="text-[8px] font-bold text-emerald-400/70 tabular-nums min-w-[10px] text-center leading-none">{priority}</span>
                          )}
                        </span>
                      );
                    })()}
                  </div>

                  <div
                    className="absolute top-0 right-0 w-[4px] h-full cursor-col-resize z-20"
                    onMouseDown={(e) => handleResizeStart(col.key, e)}
                    onClick={(e) => e.stopPropagation()}
                  />
                </th>
              );
            })}
            {!readOnly && <th className="bg-[var(--th-bg-overlay)] border-b border-[var(--th-line)]/100"></th>}
            {/* Cabeçalho da coluna "ANOTAÇÕES" (ou "NOTAS") */}
            <th className="bg-[var(--th-bg-raised)] border-b border-[var(--th-line)]/100 text-center text-[10px] uppercase font-semibold tracking-wider text-amber-600 px-2 py-1.5">ANOTAÇÕES</th>
          </tr>

          {/* Filter row */}
          <tr>
            <th className="bg-[var(--th-bg-base)] p-1 border-b border-r border-[var(--th-line)]/100 sticky left-0 z-40 shadow-[2px_0_5px_rgba(0,0,0,0.3)] text-center">
              <button
                type="button"
                onClick={() => {
                  setTextFilters({});
                  setChoiceFilters({});
                  setNumericFilters({});
                  setBooleanFilters({});
                  setPtFilter(false);
                }}
                className={`w-full h-6 rounded flex items-center justify-center transition-all cursor-pointer ${
                  hasActiveFilters
                    ? "bg-amber-500 text-black font-bold shadow-sm shadow-amber-500/20 animate-pulse"
                    : "bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white"
                }`}
                title="Limpar todos os filtros"
              >
                <RotateCcw size={11} />
              </button>
            </th>

            {orderedColumns.map((col) => {
              if (hiddenSet.has(col.key)) {
                return <th key={col.key} className="bg-[var(--th-bg-raised)] border-b border-[var(--th-line)]/100 p-0"></th>;
              }
              return (
                <th key={col.key} className="bg-[var(--th-bg-base)] px-1 py-1 border-b border-[var(--th-line)]/100 text-center">
                  {renderFilter(col)}
                </th>
              );
            })}
            {!readOnly && <th className="bg-[var(--th-bg-base)] border-b border-[var(--th-line)]/100"></th>}
            {/* Linha de filtro da coluna "ANOTAÇÕES" (vazia) */}
            <th className="bg-[var(--th-bg-base)] border-b border-[var(--th-line)]/100"></th>
          </tr>
        </thead>

        <tbody>
          {sorted.length === 0 && (
            <tr>
              <td colSpan={orderedColumns.length + (readOnly ? 2 : 3)} className="text-center py-16 text-slate-500">
                Nenhum personagem encontrado.
              </td>
            </tr>
          )}
          {sorted.map((c, idx) => (
            <tr
              key={c.id}
              onClick={() => setSelected(c.id)}
              onDoubleClick={() => !readOnly && onEdit?.(c)}
              className={`group transition-colors ${
                selected === c.id
                  ? "bg-red-500/10"
                  : idx % 2 === 0 ? "bg-[var(--th-n-deep)] hover:bg-[var(--th-n-raised)]" : "bg-[var(--th-n-base)] hover:bg-[var(--th-n-panel)]"
              }`}
            >
              <td className="px-1 py-1.5 border-b border-r border-[var(--th-line)]/100 text-center font-mono text-[10px] font-bold text-slate-500 sticky left-0 z-20 bg-[var(--th-bg-base)] group-hover:bg-[var(--th-bg-overlay)] shadow-[2px_0_5px_rgba(0,0,0,0.3)] select-none">
                {idx + 1}
              </td>

              {orderedColumns.map((col) => {
                if (hiddenSet.has(col.key)) {
                  return <td key={col.key} className="border-b border-white/5 bg-black/20 p-0"></td>;
                }

                const isInteractiveNoModal = col.key === "itemDropadoSW" || col.key === "itemDropadoSG";

                return (
                  <td
                    key={col.key}
                    className={`px-1.5 py-1 border-b border-white/5 text-center ${isInteractiveNoModal ? '' : 'overflow-hidden'}`}
                    style={col.key === "account" && accountVisible && c.account
                      ? { backgroundColor: acctBg(c.account), borderLeft: `2px solid ${acctBorder(c.account)}` }
                      : undefined
                    }
                    onClick={isInteractiveNoModal ? (e) => e.stopPropagation() : undefined}
                    onDoubleClick={isInteractiveNoModal ? (e) => e.stopPropagation() : undefined}
                  >
                    {col.render ? col.render(c) : <span className="text-slate-300">{col.get(c)}</span>}
                  </td>
                );
              })}
              {!readOnly && (
                <td className="px-1 py-1.5 border-b border-white/5 text-center whitespace-nowrap">
                  <div className="inline-flex gap-0.5 opacity-100 transition-opacity">
                    <button onClick={(e) => { e.stopPropagation(); onEdit?.(c); }} className="p-1 rounded-md bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-amber-400 hover:text-amber-300 transition-all hover:scale-110 cursor-pointer" title="Editar">
                      <Pencil size={12} />
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); onDelete?.(c.id); }} className="p-1 rounded-md bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 text-rose-400 hover:text-rose-300 transition-all hover:scale-110 cursor-pointer" title="Excluir">
                      <Trash2 size={12} />
                    </button>
                  </div>
                </td>
              )}
          {/* Coluna "NOTAS" editável com comportamento extraído de PartyPanel */}
          <td className="border-b border-white/5 px-1 py-1" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
            <NoteCellInput
              value={c.notes || ""}
              onChange={(val) => onNoteChange?.(c.id, val)}
            />
          </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}