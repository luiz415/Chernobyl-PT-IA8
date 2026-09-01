import { CheckCircle2, Bold, Italic, Underline, AlignLeft, AlignCenter, AlignRight, Merge, SplitSquareHorizontal, Plus, Minus, Paintbrush, Type, Undo2, Redo2, StickyNote, Table2 } from "lucide-react";
import { useEffect, useState, useRef, useMemo } from "react";

interface Props {
  value: string;
  onChange: (v: string) => void;
}

interface CellData {
  v: string;
  bg?: string;
  fg?: string;
  b?: boolean;
  i?: boolean;
  u?: boolean;
  al?: "l" | "c" | "r";
}

interface MergedRegion {
  r1: number; c1: number; r2: number; c2: number;
}

interface SheetData {
  cells: Record<string, CellData>;
  merges: MergedRegion[];
  rows: number;
  cols: number;
}

interface CombinedData {
  _v: number;       // versão do formato
  sheet: SheetData;
  notes: string;    // texto livre do bloco de notas
}

const DEFAULT_ROWS = 30;
const DEFAULT_COLS = 10;
const FORMAT_VERSION = 2;

function cellKey(r: number, c: number): string {
  return `${r},${c}`;
}

function emptySheet(): SheetData {
  return { cells: {}, merges: [], rows: DEFAULT_ROWS, cols: DEFAULT_COLS };
}

function emptyCombined(): CombinedData {
  return { _v: FORMAT_VERSION, sheet: emptySheet(), notes: "" };
}

function parseCombined(raw: string): CombinedData {
  if (!raw) return emptyCombined();
  try {
    const parsed = JSON.parse(raw);
    // Novo formato combinado (v2+)
    if (parsed && typeof parsed === "object" && parsed._v && parsed.sheet) {
      return {
        _v: parsed._v,
        sheet: {
          cells: parsed.sheet.cells || {},
          merges: Array.isArray(parsed.sheet.merges) ? parsed.sheet.merges : [],
          rows: parsed.sheet.rows || DEFAULT_ROWS,
          cols: parsed.sheet.cols || DEFAULT_COLS,
        },
        notes: typeof parsed.notes === "string" ? parsed.notes : "",
      };
    }
    // Formato anterior (apenas planilha)
    if (parsed && typeof parsed === "object" && parsed.cells) {
      return {
        _v: FORMAT_VERSION,
        sheet: {
          cells: parsed.cells || {},
          merges: Array.isArray(parsed.merges) ? parsed.merges : [],
          rows: parsed.rows || DEFAULT_ROWS,
          cols: parsed.cols || DEFAULT_COLS,
        },
        notes: "",
      };
    }
  } catch {}
  // Legado: texto puro — coloca no bloco de notas
  if (raw.trim()) {
    return { _v: FORMAT_VERSION, sheet: emptySheet(), notes: raw };
  }
  return emptyCombined();
}

function serializeCombined(data: CombinedData): string {
  return JSON.stringify(data);
}

const COLORS = [
  "#ffffff", "#e2e8f0", "#94a3b8", "#64748b",
  "#ef4444", "#f97316", "#eab308", "#22c55e",
  "#3b82f6", "#8b5cf6", "#ec4899", "#06b6d4",
  "#000000", "#1e293b", "#dc2626", "#16a34a",
];

export default function NotesPanel({ value, onChange }: Props) {
  const initial = useMemo(() => parseCombined(value), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [sheet, setSheet] = useState<SheetData>(initial.sheet);
  const [notes, setNotes] = useState<string>(initial.notes);
  const [selection, setSelection] = useState<{ r1: number; c1: number; r2: number; c2: number } | null>(null);
  const [editing, setEditing] = useState<{ r: number; c: number } | null>(null);
  const [editValue, setEditValue] = useState("");
  const [saved, setSaved] = useState(true);
  const [showBgPicker, setShowBgPicker] = useState(false);
  const [showFgPicker, setShowFgPicker] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [selStart, setSelStart] = useState<{ r: number; c: number } | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const editRef = useRef<HTMLInputElement>(null);
  const skipSave = useRef(false);

  // Sincroniza quando o pai muda o valor externamente (ex: importação)
  useEffect(() => {
    const parsed = parseCombined(value);
    setSheet(parsed.sheet);
    setNotes(parsed.notes);
  }, [value]);

  // Salva no pai (debounced)
  useEffect(() => {
    if (skipSave.current) { skipSave.current = false; return; }
    const combined: CombinedData = { _v: FORMAT_VERSION, sheet, notes };
    const serialized = serializeCombined(combined);
    if (serialized !== value) {
      setSaved(false);
      const t = setTimeout(() => { onChange(serialized); setSaved(true); }, 400);
      return () => clearTimeout(t);
    }
  }, [sheet, notes]); // eslint-disable-line react-hooks/exhaustive-deps

  function pushHistory() {
    const snap = serializeCombined({ _v: FORMAT_VERSION, sheet, notes });
    setHistory(prev => {
      const next = [...prev.slice(0, historyIdx + 1), snap];
      if (next.length > 50) next.shift();
      return next;
    });
    setHistoryIdx(prev => Math.min(prev + 1, 49));
  }

  function undo() {
    if (historyIdx <= 0) return;
    const newIdx = historyIdx - 1;
    const snap = history[newIdx];
    if (snap) {
      skipSave.current = true;
      const parsed = parseCombined(snap);
      setSheet(parsed.sheet);
      setNotes(parsed.notes);
      setHistoryIdx(newIdx);
      onChange(snap);
    }
  }

  function redo() {
    if (historyIdx >= history.length - 1) return;
    const newIdx = historyIdx + 1;
    const snap = history[newIdx];
    if (snap) {
      skipSave.current = true;
      const parsed = parseCombined(snap);
      setSheet(parsed.sheet);
      setNotes(parsed.notes);
      setHistoryIdx(newIdx);
      onChange(snap);
    }
  }

  function updateSheet(fn: (s: SheetData) => SheetData) {
    pushHistory();
    setSheet(fn);
  }

  function getCell(r: number, c: number): CellData {
    return sheet.cells[cellKey(r, c)] || { v: "" };
  }

  function setCell(r: number, c: number, data: Partial<CellData>) {
    updateSheet(s => {
      const key = cellKey(r, c);
      const existing = s.cells[key] || { v: "" };
      const merged = { ...existing, ...data };
      const newCells = { ...s.cells, [key]: merged };
      return { ...s, cells: newCells };
    });
  }

  function findMerge(r: number, c: number): MergedRegion | null {
    return sheet.merges.find(m => r >= m.r1 && r <= m.r2 && c >= m.c1 && c <= m.c2) || null;
  }

  function isHiddenByMerge(r: number, c: number): boolean {
    const m = findMerge(r, c);
    return m ? (r !== m.r1 || c !== m.c1) : false;
  }

  function getMergeSpan(r: number, c: number): { rowSpan: number; colSpan: number } | null {
    const m = findMerge(r, c);
    if (!m || r !== m.r1 || c !== m.c1) return null;
    return { rowSpan: m.r2 - m.r1 + 1, colSpan: m.c2 - m.c1 + 1 };
  }

  function forEachSelected(fn: (r: number, c: number) => void) {
    if (!selection) return;
    const { r1, c1, r2, c2 } = normalizeSelection(selection);
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        fn(r, c);
      }
    }
  }

  function normalizeSelection(sel: { r1: number; c1: number; r2: number; c2: number }) {
    return {
      r1: Math.min(sel.r1, sel.r2),
      c1: Math.min(sel.c1, sel.c2),
      r2: Math.max(sel.r1, sel.r2),
      c2: Math.max(sel.c1, sel.c2),
    };
  }

  function isSelected(r: number, c: number): boolean {
    if (!selection) return false;
    const s = normalizeSelection(selection);
    return r >= s.r1 && r <= s.r2 && c >= s.c1 && c <= s.c2;
  }

  function commitEdit() {
    if (editing) {
      setCell(editing.r, editing.c, { v: editValue });
      setEditing(null);
    }
  }

  function startEdit(r: number, c: number) {
    commitEdit();
    const cell = getCell(r, c);
    setEditing({ r, c });
    setEditValue(cell.v);
    setTimeout(() => editRef.current?.focus(), 0);
  }

  function handleCellMouseDown(r: number, c: number, e: React.MouseEvent) {
    commitEdit();
    setShowBgPicker(false);
    setShowFgPicker(false);
    if (e.shiftKey && selection) {
      setSelection({ ...selection, r2: r, c2: c });
    } else {
      setSelection({ r1: r, c1: c, r2: r, c2: c });
      setSelStart({ r, c });
    }
  }

  function handleCellMouseEnter(r: number, c: number) {
    if (selStart) {
      setSelection({ r1: selStart.r, c1: selStart.c, r2: r, c2: c });
    }
  }

  function handleMouseUp() {
    setSelStart(null);
  }

  useEffect(() => {
    window.addEventListener("mouseup", handleMouseUp);
    return () => window.removeEventListener("mouseup", handleMouseUp);
  }, []);

  function toggleBold() {
    pushHistory();
    forEachSelected((r, c) => {
      const cell = getCell(r, c);
      setSheet(s => ({ ...s, cells: { ...s.cells, [cellKey(r, c)]: { ...cell, b: !cell.b } } }));
    });
  }

  function toggleItalic() {
    pushHistory();
    forEachSelected((r, c) => {
      const cell = getCell(r, c);
      setSheet(s => ({ ...s, cells: { ...s.cells, [cellKey(r, c)]: { ...cell, i: !cell.i } } }));
    });
  }

  function toggleUnderline() {
    pushHistory();
    forEachSelected((r, c) => {
      const cell = getCell(r, c);
      setSheet(s => ({ ...s, cells: { ...s.cells, [cellKey(r, c)]: { ...cell, u: !cell.u } } }));
    });
  }

  function setAlign(al: "l" | "c" | "r") {
    pushHistory();
    forEachSelected((r, c) => {
      const cell = getCell(r, c);
      setSheet(s => ({ ...s, cells: { ...s.cells, [cellKey(r, c)]: { ...cell, al } } }));
    });
  }

  function setBgColor(color: string) {
    pushHistory();
    forEachSelected((r, c) => {
      const cell = getCell(r, c);
      setSheet(s => ({ ...s, cells: { ...s.cells, [cellKey(r, c)]: { ...cell, bg: color === "transparent" ? undefined : color } } }));
    });
    setShowBgPicker(false);
  }

  function setFgColor(color: string) {
    pushHistory();
    forEachSelected((r, c) => {
      const cell = getCell(r, c);
      setSheet(s => ({ ...s, cells: { ...s.cells, [cellKey(r, c)]: { ...cell, fg: color } } }));
    });
    setShowFgPicker(false);
  }

  function mergeCells() {
    if (!selection) return;
    const s = normalizeSelection(selection);
    if (s.r1 === s.r2 && s.c1 === s.c2) return;

    pushHistory();
    const newMerges = sheet.merges.filter(m => {
      return !(m.r1 >= s.r1 && m.r2 <= s.r2 && m.c1 >= s.c1 && m.c2 <= s.c2);
    });
    newMerges.push({ r1: s.r1, c1: s.c1, r2: s.r2, c2: s.c2 });

    let combined = "";
    for (let r = s.r1; r <= s.r2; r++) {
      for (let c = s.c1; c <= s.c2; c++) {
        const cell = getCell(r, c);
        if (cell.v) {
          if (combined) combined += " ";
          combined += cell.v;
        }
      }
    }

    const newCells = { ...sheet.cells };
    for (let r = s.r1; r <= s.r2; r++) {
      for (let c = s.c1; c <= s.c2; c++) {
        if (r === s.r1 && c === s.c1) continue;
        delete newCells[cellKey(r, c)];
      }
    }
    const topLeft = newCells[cellKey(s.r1, s.c1)] || { v: "" };
    newCells[cellKey(s.r1, s.c1)] = { ...topLeft, v: combined || topLeft.v };

    setSheet(prev => ({ ...prev, cells: newCells, merges: newMerges }));
  }

  function unmergeCells() {
    if (!selection) return;
    const s = normalizeSelection(selection);
    pushHistory();
    const newMerges = sheet.merges.filter(m => {
      return !(m.r1 >= s.r1 && m.r2 <= s.r2 && m.c1 >= s.c1 && m.c2 <= s.c2);
    });
    setSheet(prev => ({ ...prev, merges: newMerges }));
  }

  function addRow() { updateSheet(s => ({ ...s, rows: s.rows + 1 })); }
  function addCol() { updateSheet(s => ({ ...s, cols: s.cols + 1 })); }
  function removeRow() {
    if (sheet.rows <= 3) return;
    updateSheet(s => ({ ...s, rows: s.rows - 1 }));
  }
  function removeCol() {
    if (sheet.cols <= 3) return;
    updateSheet(s => ({ ...s, cols: s.cols - 1 }));
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (editing) {
      if (e.key === "Escape") { setEditing(null); return; }
      if (e.key === "Enter") { commitEdit(); moveSelection(1, 0); return; }
      if (e.key === "Tab") { e.preventDefault(); commitEdit(); moveSelection(0, e.shiftKey ? -1 : 1); return; }
      return;
    }
    if (!selection) return;
    if (e.key === "Enter" || e.key === "F2") { e.preventDefault(); startEdit(selection.r1, selection.c1); return; }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      pushHistory();
      forEachSelected((r, c) => {
        const key = cellKey(r, c);
        setSheet(s => {
          const newCells = { ...s.cells };
          if (newCells[key]) { newCells[key] = { ...newCells[key], v: "" }; }
          return { ...s, cells: newCells };
        });
      });
      return;
    }
    if (e.key === "ArrowUp") { e.preventDefault(); moveSelection(-1, 0); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); moveSelection(1, 0); return; }
    if (e.key === "ArrowLeft") { e.preventDefault(); moveSelection(0, -1); return; }
    if (e.key === "ArrowRight") { e.preventDefault(); moveSelection(0, 1); return; }
    if (e.key === "Tab") { e.preventDefault(); moveSelection(0, e.shiftKey ? -1 : 1); return; }
    if (e.ctrlKey && e.key === "z") { e.preventDefault(); undo(); return; }
    if (e.ctrlKey && e.key === "y") { e.preventDefault(); redo(); return; }
    if (e.ctrlKey && e.key === "b") { e.preventDefault(); toggleBold(); return; }
    if (e.ctrlKey && e.key === "i") { e.preventDefault(); toggleItalic(); return; }
    if (e.ctrlKey && e.key === "u") { e.preventDefault(); toggleUnderline(); return; }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      startEdit(selection.r1, selection.c1);
      setEditValue(e.key);
    }
  }

  function moveSelection(dr: number, dc: number) {
    if (!selection) return;
    const nr = Math.max(0, Math.min(sheet.rows - 1, selection.r1 + dr));
    const nc = Math.max(0, Math.min(sheet.cols - 1, selection.c1 + dc));
    setSelection({ r1: nr, c1: nc, r2: nr, c2: nc });
  }

  const selHasMerge = useMemo(() => {
    if (!selection) return false;
    const s = normalizeSelection(selection);
    return sheet.merges.some(m => m.r1 >= s.r1 && m.r2 <= s.r2 && m.c1 >= s.c1 && m.c2 <= s.c2);
  }, [selection, sheet.merges]);

  const selIsMulti = selection ? (normalizeSelection(selection).r1 !== normalizeSelection(selection).r2 || normalizeSelection(selection).c1 !== normalizeSelection(selection).c2) : false;

  function colLabel(c: number): string {
    let label = "";
    let n = c;
    while (n >= 0) { label = String.fromCharCode(65 + (n % 26)) + label; n = Math.floor(n / 26) - 1; }
    return label;
  }

  function handleNotesChange(v: string) {
    pushHistory();
    setNotes(v);
  }

  return (
    <div className="h-full flex flex-col">
      {/* Indicador de salvamento global */}
      <div className="flex items-center justify-end gap-1 px-2 py-1 bg-[var(--th-n-base)] border-b border-[var(--th-line)]/100 flex-shrink-0">
        <span className={`text-[10px] flex items-center gap-1 transition-opacity ${saved ? "text-emerald-400 opacity-100" : "text-slate-500 opacity-60"}`}>
          <CheckCircle2 size={10} /> {saved ? "Salvo" : "Salvando…"}
        </span>
      </div>

      {/* Duas colunas: planilha (esquerda) + bloco de notas (direita) */}
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-0">
        {/* COLUNA 1 - PLANILHA */}
        <div
          className="flex flex-col h-full border-r border-[var(--th-line)]/100 min-w-0"
          onKeyDown={handleKeyDown}
          tabIndex={0}
          style={{ outline: "none" }}
        >
          <div className="flex items-center gap-1.5 px-2 py-1.5 bg-gradient-to-r from-[var(--th-bg-base)] to-[var(--th-n-base)] border-b border-[var(--th-line)]/50 flex-shrink-0">
            <Table2 size={13} className="text-amber-500/90" />
            <span className="text-[11px] font-bold uppercase tracking-wider text-amber-300/90">Planilha</span>
            <span className="text-[9px] text-slate-500 ml-1">({sheet.rows} linhas × {sheet.cols} colunas)</span>
          </div>

          {/* Toolbar */}
          <div className="flex items-center gap-1 px-2 py-1.5 bg-[var(--th-n-base)] border-b border-[var(--th-line)]/80 flex-shrink-0 flex-wrap">
            <ToolBtn icon={<Undo2 size={13} />} title="Desfazer (Ctrl+Z)" onClick={undo} />
            <ToolBtn icon={<Redo2 size={13} />} title="Refazer (Ctrl+Y)" onClick={redo} />
            <div className="w-px h-5 bg-[var(--th-line)]/40 mx-1" />
            <ToolBtn icon={<Bold size={13} />} title="Negrito (Ctrl+B)" onClick={toggleBold} />
            <ToolBtn icon={<Italic size={13} />} title="Itálico (Ctrl+I)" onClick={toggleItalic} />
            <ToolBtn icon={<Underline size={13} />} title="Sublinhado (Ctrl+U)" onClick={toggleUnderline} />
            <div className="w-px h-5 bg-[var(--th-line)]/40 mx-1" />
            <ToolBtn icon={<AlignLeft size={13} />} title="Alinhar à esquerda" onClick={() => setAlign("l")} />
            <ToolBtn icon={<AlignCenter size={13} />} title="Centralizar" onClick={() => setAlign("c")} />
            <ToolBtn icon={<AlignRight size={13} />} title="Alinhar à direita" onClick={() => setAlign("r")} />
            <div className="w-px h-5 bg-[var(--th-line)]/40 mx-1" />

            <div className="relative">
              <button
                onClick={() => { setShowBgPicker(!showBgPicker); setShowFgPicker(false); }}
                className="p-1.5 rounded hover:bg-[var(--th-line)]/25 text-slate-500 hover:text-white transition-colors flex items-center gap-1"
                title="Cor de fundo da célula"
              >
                <Paintbrush size={13} />
                <span className="text-[9px]">Fundo</span>
              </button>
              {showBgPicker && (
                <ColorPicker onSelect={setBgColor} onClose={() => setShowBgPicker(false)} showTransparent />
              )}
            </div>

            <div className="relative">
              <button
                onClick={() => { setShowFgPicker(!showFgPicker); setShowBgPicker(false); }}
                className="p-1.5 rounded hover:bg-[var(--th-line)]/25 text-slate-500 hover:text-white transition-colors flex items-center gap-1"
                title="Cor do texto"
              >
                <Type size={13} />
                <span className="text-[9px]">Texto</span>
              </button>
              {showFgPicker && (
                <ColorPicker onSelect={setFgColor} onClose={() => setShowFgPicker(false)} />
              )}
            </div>

            <div className="w-px h-5 bg-[var(--th-line)]/40 mx-1" />
            <ToolBtn icon={<Merge size={13} />} title="Mesclar células selecionadas" onClick={mergeCells} disabled={!selIsMulti} />
            <ToolBtn icon={<SplitSquareHorizontal size={13} />} title="Desfazer mesclagem" onClick={unmergeCells} disabled={!selHasMerge} />
            <div className="w-px h-5 bg-[var(--th-line)]/40 mx-1" />
            <ToolBtn icon={<Plus size={11} />} title="Adicionar linha" onClick={addRow} label="+Lin" />
            <ToolBtn icon={<Minus size={11} />} title="Remover última linha" onClick={removeRow} label="-Lin" />
            <ToolBtn icon={<Plus size={11} />} title="Adicionar coluna" onClick={addCol} label="+Col" />
            <ToolBtn icon={<Minus size={11} />} title="Remover última coluna" onClick={removeCol} label="-Col" />
          </div>

          {/* Grid */}
          <div ref={tableRef} className="flex-1 overflow-auto bg-[var(--th-n-deep)] min-h-0" onMouseUp={handleMouseUp}>
            <table className="border-collapse select-none" style={{ tableLayout: "fixed" }}>
              <thead className="sticky top-0 z-10">
                <tr>
                  <th className="bg-[var(--th-bg-base)] border border-[var(--th-line)]/90 w-10 min-w-[40px] text-[10px] text-slate-600 font-normal sticky left-0 z-20" />
                  {Array.from({ length: sheet.cols }, (_, c) => (
                    <th
                      key={c}
                      className="bg-[var(--th-bg-base)] border border-[var(--th-line)]/90 text-[10px] text-slate-600 font-medium px-1 py-1 min-w-[80px] w-[100px]"
                    >
                      {colLabel(c)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: sheet.rows }, (_, r) => (
                  <tr key={r}>
                    <td className="bg-[var(--th-bg-base)] border border-[var(--th-line)]/90 text-[10px] text-slate-600 text-center py-1 font-medium sticky left-0 z-10 min-w-[40px]">
                      {r + 1}
                    </td>
                    {Array.from({ length: sheet.cols }, (_, c) => {
                      if (isHiddenByMerge(r, c)) return null;
                      const span = getMergeSpan(r, c);
                      const cell = getCell(r, c);
                      const sel = isSelected(r, c);
                      const isEditing = editing?.r === r && editing?.c === c;
                      const align = cell.al === "c" ? "center" : cell.al === "r" ? "right" : "left";

                      return (
                        <td
                          key={c}
                          rowSpan={span?.rowSpan}
                          colSpan={span?.colSpan}
                          className={`border border-[var(--th-line)]/50 px-1.5 py-1 text-xs relative transition-colors ${sel ? "outline outline-2 outline-red-500/70 outline-offset-[-2px] z-[5]" : ""}`}
                          style={{
                            backgroundColor: cell.bg || "transparent",
                            color: cell.fg || "#e2e8f0",
                            fontWeight: cell.b ? 700 : 400,
                            fontStyle: cell.i ? "italic" : "normal",
                            textDecoration: cell.u ? "underline" : "none",
                            textAlign: align,
                            minWidth: 80,
                            cursor: "cell",
                          }}
                          onMouseDown={(e) => handleCellMouseDown(r, c, e)}
                          onMouseEnter={() => handleCellMouseEnter(r, c)}
                          onDoubleClick={() => startEdit(r, c)}
                        >
                          {isEditing ? (
                            <input
                              ref={editRef}
                              type="text"
                              value={editValue}
                              onChange={(e) => setEditValue(e.target.value)}
                              onBlur={commitEdit}
                              className="w-full bg-transparent outline-none text-xs"
                              style={{
                                color: cell.fg || "#fff",
                                fontWeight: cell.b ? 700 : 400,
                                fontStyle: cell.i ? "italic" : "normal",
                                textDecoration: cell.u ? "underline" : "none",
                                textAlign: align,
                              }}
                            />
                          ) : (
                            <span className="block truncate">{cell.v}</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* COLUNA 2 - BLOCO DE NOTAS */}
        <div className="flex flex-col h-full min-w-0">
          <div className="flex items-center gap-1.5 px-2 py-1.5 bg-gradient-to-r from-[var(--th-bg-base)] to-[var(--th-n-base)] border-b border-[var(--th-line)]/50 flex-shrink-0">
            <StickyNote size={13} className="text-red-400/80" />
            <span className="text-[11px] font-bold uppercase tracking-wider text-red-300/80">Bloco de Notas</span>
            <span className="text-[9px] text-slate-500 ml-1">({notes.length} caracteres)</span>
          </div>
          <div className="flex-1 p-3 bg-[var(--th-n-deep)] min-h-0 flex flex-col">
            <textarea
              value={notes}
              onChange={(e) => handleNotesChange(e.target.value)}
              placeholder="Escreva aqui suas anotações, lembretes, links, planos de PT, observações sobre personagens... Tudo digitado no painel NOTAS é PRIVADO e salvo automaticamente, fora da núvem!"
              className="flex-1 w-full bg-[var(--th-n-base)] border border-[var(--th-line)]/100 rounded-lg p-3 text-sm text-slate-200 placeholder-slate-600 resize-none focus:outline-none focus:border-red-700/50 leading-relaxed font-mono"
              spellCheck={true}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function ToolBtn({ icon, title, onClick, disabled, label }: {
  icon: React.ReactNode;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="p-1.5 rounded hover:bg-[var(--th-line)]/25 text-slate-500 hover:text-white transition-colors disabled:opacity-30 disabled:pointer-events-none flex items-center gap-0.5"
      title={title}
    >
      {icon}
      {label && <span className="text-[9px]">{label}</span>}
    </button>
  );
}

function ColorPicker({ onSelect, onClose, showTransparent }: {
  onSelect: (color: string) => void;
  onClose: () => void;
  showTransparent?: boolean;
}) {
  return (
    <div className="absolute top-full left-0 mt-1 p-2 bg-[var(--th-bg-base)] border border-[var(--th-line)]/600 rounded-xl shadow-[0_0_20px_color-mix(in_oklab,var(--th-brand)_25%,transparent)] z-50 w-[160px]">
      <div className="grid grid-cols-4 gap-1.5">
        {showTransparent && (
          <button
            onClick={() => onSelect("transparent")}
            className="w-8 h-8 rounded border border-[var(--th-line)]/40 bg-[var(--th-n-deep)] text-[8px] text-slate-500 hover:border-[var(--th-line)]/70"
            title="Sem cor"
          >
            ✕
          </button>
        )}
        {COLORS.map(color => (
          <button
            key={color}
            onClick={() => onSelect(color)}
            className="w-8 h-8 rounded border border-[var(--th-line)]/30 hover:border-amber-500/60 hover:scale-110 transition-all"
            style={{ backgroundColor: color }}
            title={color}
          />
        ))}
      </div>
      <button
        onClick={onClose}
        className="w-full mt-2 text-[10px] text-slate-600 hover:text-white py-1 rounded hover:bg-[var(--th-line)]/20"
      >
        Fechar
      </button>
    </div>
  );
}
