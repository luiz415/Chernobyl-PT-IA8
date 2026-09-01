import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Minus, Search, X } from "lucide-react";

type ToggleState = "off" | "yes" | "no";

interface FilterSelectProps {
  label?: string;
  options: string[];
  selected: string;
  onSelect: (value: string) => void;
  icon?: React.ReactNode;
  placeholder?: string;
  searchable?: boolean;
  allLabel?: string;
  allValue?: string;
  disabled?: boolean;
  className?: string;
  activeColor?: "red" | "cyan";
  searchPlaceholder?: string;
  emptyMessage?: string;
  /**
   * z-index do dropdown. O padrão (600) atende os painéis, mas dentro de um
   * modal — que usa z-index bem mais alto — a lista ficaria PINTADA ATRÁS do
   * overlay e pareceria não abrir. Nesse caso passe um valor acima do modal.
   */
  dropdownZIndex?: number;
}

interface FilterMultiProps {
  label: string;
  options: string[];
  selected: string[];
  onApply: (values: string[]) => void;
  icon?: React.ReactNode;
  placeholder?: string;
  searchable?: boolean;
  disabled?: boolean;
}

interface FilterToggleProps {
  label: string;
  state: ToggleState;
  onToggle: (newState: ToggleState) => void;
  icon?: React.ReactNode;
  disabled?: boolean;
}

interface FilterNumberProps {
  label: string;
  value: number | null;
  operator: "gte" | "lte";
  onChange: (value: number | null, op: "gte" | "lte") => void;
  icon?: React.ReactNode;
  placeholder?: string;
  disabled?: boolean;
}

interface FilterInlineProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  icon?: React.ReactNode;
  disabled?: boolean;
  maxWidth?: string;
}

interface FilterDateMaxProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  icon?: React.ReactNode;
  placeholder?: string;
  disabled?: boolean;
}

type DropPos = { top: number; left: number; width: number; openUp: boolean };

function useFilterDropdown(minWidth = 180, maxHeight = 220) {
  const [open, setOpen] = useState(false);
  const [dropPos, setDropPos] = useState<DropPos>({ top: 0, left: 0, width: 0, openUp: false });
  const btnRef = useRef<HTMLButtonElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  function updatePosition() {
    if (!btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom - 12;
    const spaceAbove = rect.top - 12;
    const openUp = spaceBelow < maxHeight && spaceAbove > spaceBelow;

    setDropPos({
      top: openUp ? rect.top - 4 : rect.bottom + 4,
      left: Math.max(8, Math.min(rect.left, window.innerWidth - Math.max(rect.width, minWidth) - 8)),
      width: Math.max(rect.width, minWidth),
      openUp,
    });
  }

  useEffect(() => {
    if (!open) return;
    function handleOutside(e: MouseEvent) {
      const target = e.target as Node;
      if (btnRef.current?.contains(target)) return;
      if (dropRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  return { open, setOpen, dropPos, btnRef, dropRef, updatePosition };
}

function dropdownStyle(pos: DropPos): React.CSSProperties {
  return {
    top: pos.openUp ? "auto" : pos.top,
    bottom: pos.openUp ? `${window.innerHeight - pos.top}px` : "auto",
    left: pos.left,
    width: pos.width,
  };
}

function buttonClass(active: boolean, disabled?: boolean) {
  if (disabled) return "opacity-40 cursor-not-allowed border-white/5 bg-white/[0.02] text-slate-500";
  if (active) return "border-red-500/40 bg-[var(--th-n-elev)] text-red-300 hover:bg-white/5 hover:border-red-500/50";
  return "border-white/10 bg-[var(--th-n-elev)] text-slate-300 hover:bg-white/5 hover:border-red-500/30";
}

function SearchInput({ value, onChange, inputRef, placeholder = "Buscar...", activeColor = "red" }: { value: string; onChange: (value: string) => void; inputRef?: React.RefObject<HTMLInputElement | null>; placeholder?: string; activeColor?: "red" | "cyan" }) {
  const focusBorder = activeColor === "cyan" ? "focus:border-cyan-500/50" : "focus:border-red-500/50";
  return (
    <div className="p-1.5 border-b border-white/5 relative">
      <Search size={11} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full bg-[var(--th-n-panel)] border border-white/10 rounded pl-7 pr-2 py-1.5 text-[11px] text-white placeholder-slate-500 focus:outline-none ${focusBorder} transition-colors`}
      />
    </div>
  );
}

function FilterSelect({
  label = "",
  options,
  selected,
  onSelect,
  icon,
  placeholder = "Filtro",
  searchable = false,
  allLabel = "Todos",
  allValue = "",
  disabled = false,
  className,
  activeColor = "red",
  searchPlaceholder = "Buscar...",
  emptyMessage = "Nenhuma opção encontrada",
  dropdownZIndex,
}: FilterSelectProps) {
  const { open, setOpen, dropPos, btnRef, dropRef, updatePosition } = useFilterDropdown();
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open && searchable) setTimeout(() => searchRef.current?.focus(), 50);
  }, [open, searchable]);

  const filteredOptions = useMemo(() => {
    if (!search.trim()) return options;
    const lowerSearch = search.toLowerCase();
    return options.filter(opt => opt.toLowerCase().includes(lowerSearch));
  }, [options, search]);

  function handleToggle() {
    if (disabled) return;
    if (!open) updatePosition();
    else setSearch("");
    setOpen(prev => !prev);
  }

  function handleSelect(value: string) {
    onSelect(value);
    setOpen(false);
    setSearch("");
  }

  const hasSelection = !!selected && selected !== allValue;
  const displayText = selected ? selected : placeholder;
  const isCyan = activeColor === "cyan";

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={handleToggle}
        disabled={disabled}
        className={className || `inline-flex items-center gap-1 px-2 py-1 rounded-md border text-[11px] font-medium transition-all whitespace-nowrap cursor-pointer ${buttonClass(hasSelection, disabled)}`}
        title={label}
      >
        {className ? (
          <>
            <span className="truncate">{displayText}</span>
            <ChevronDown size={14} className={`flex-shrink-0 transition-transform duration-150 ${open ? "rotate-180" : ""} text-slate-500`} />
          </>
        ) : (
          <>
            {icon && <span className="flex-shrink-0">{icon}</span>}
            <span className="truncate max-w-[120px]">{displayText}</span>
            <ChevronDown size={10} className={`flex-shrink-0 transition-transform ${open ? "rotate-180" : ""} ${hasSelection ? "text-red-400" : "text-slate-500"}`} />
          </>
        )}
      </button>

      {open && createPortal(
        <div
          ref={dropRef}
          className={`fixed rounded-lg border ${isCyan ? "border-cyan-500/30" : "border-red-500/30"} bg-[var(--th-n-hi)] shadow-2xl shadow-black/60 overflow-hidden ${dropdownZIndex ? "" : "z-[600]"}`}
          style={dropdownZIndex ? { ...dropdownStyle(dropPos), zIndex: dropdownZIndex } : dropdownStyle(dropPos)}
        >
          {searchable && <SearchInput value={search} onChange={setSearch} inputRef={searchRef} placeholder={searchPlaceholder} activeColor={activeColor} />}
          <div className="max-h-[200px] overflow-y-auto">
            {allLabel !== "" && allLabel !== null && (
              <div
                onMouseDown={(e) => { e.preventDefault(); handleSelect(allValue); }}
                className={`px-3 py-1.5 text-[11px] cursor-pointer transition-colors border-b border-white/5 ${selected === allValue || (!selected && allValue === "") ? (isCyan ? "text-cyan-200 bg-cyan-500/15 font-semibold" : "text-slate-300 bg-white/5 font-medium") : (isCyan ? "text-slate-300 hover:bg-cyan-500/10 hover:text-cyan-300" : "text-slate-500 hover:bg-red-500/10 hover:text-red-300")}`}
              >
                {allLabel}
              </div>
            )}
            {filteredOptions.length === 0 ? (
              <div className="px-3 py-3 text-[10px] text-slate-500 text-center italic">{emptyMessage}</div>
            ) : (
              filteredOptions.map(opt => (
                <div
                  key={opt}
                  onMouseDown={(e) => { e.preventDefault(); handleSelect(opt); }}
                  className={`px-3 py-1.5 text-[11px] cursor-pointer transition-colors ${opt === selected ? (isCyan ? "bg-cyan-500/15 text-cyan-200 font-semibold border-l-2 border-cyan-500" : "bg-red-500/15 text-red-300 font-bold border-l-2 border-red-500") : (isCyan ? "text-slate-300 hover:bg-cyan-500/10 hover:text-cyan-300" : "text-slate-300 hover:bg-red-500/10 hover:text-red-300")}`}
                >
                  {opt}
                </div>
              ))
            )}
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

function FilterMulti({
  label,
  options,
  selected,
  onApply,
  icon,
  placeholder = "Filtro",
  searchable = false,
  disabled = false,
}: FilterMultiProps) {
  const { open, setOpen, dropPos, btnRef, dropRef, updatePosition } = useFilterDropdown(220, 260);
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<string[]>(selected);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) setDraft(selected);
  }, [open, selected]);

  useEffect(() => {
    if (open && searchable) setTimeout(() => searchRef.current?.focus(), 50);
  }, [open, searchable]);

  const filteredOptions = useMemo(() => {
    if (!search.trim()) return options;
    const lowerSearch = search.toLowerCase();
    return options.filter(opt => opt.toLowerCase().includes(lowerSearch));
  }, [options, search]);

  function handleToggle() {
    if (disabled) return;
    if (!open) updatePosition();
    else setSearch("");
    setOpen(prev => !prev);
  }

  function toggleValue(value: string) {
    setDraft(prev => prev.includes(value) ? prev.filter(v => v !== value) : [...prev, value]);
  }

  const allSelected = options.length > 0 && options.every(opt => draft.includes(opt));
  const active = selected.length > 0;
  const displayText = active ? `${label} (${selected.length})` : placeholder;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={handleToggle}
        disabled={disabled}
        className={`inline-flex items-center gap-1 px-2 py-1 rounded-md border text-[11px] font-medium transition-all whitespace-nowrap cursor-pointer ${buttonClass(active, disabled)}`}
        title={label}
      >
        {icon && <span className="flex-shrink-0">{icon}</span>}
        <span className="truncate max-w-[120px]">{displayText}</span>
        <ChevronDown size={10} className={`flex-shrink-0 transition-transform ${open ? "rotate-180" : ""} ${active ? "text-red-400" : "text-slate-500"}`} />
      </button>

      {open && createPortal(
        <div ref={dropRef} className="fixed z-[700] rounded-lg border border-red-500/30 bg-[var(--th-n-hi)] shadow-2xl shadow-black/60 overflow-hidden" style={dropdownStyle(dropPos)}>
          {searchable && <SearchInput value={search} onChange={setSearch} inputRef={searchRef} />}
          <div className="p-1.5 border-b border-white/5">
            <button
              type="button"
              onClick={() => setDraft(allSelected ? [] : [...options])}
              className="w-full px-2 py-1.5 rounded bg-white/5 hover:bg-white/10 text-[11px] font-bold text-slate-300 hover:text-white transition-colors text-left"
            >
              {allSelected ? "Desmarcar Tudo" : "Marcar Tudo"}
            </button>
          </div>
          <div className="max-h-[200px] overflow-y-auto">
            {filteredOptions.length === 0 ? (
              <div className="px-3 py-3 text-[10px] text-slate-500 text-center italic">Nenhuma opção encontrada</div>
            ) : (
              filteredOptions.map(opt => {
                const checked = draft.includes(opt);
                return (
                  <label key={opt} className={`flex items-center gap-2 px-3 py-1.5 text-[11px] cursor-pointer transition-colors ${checked ? "bg-red-500/10 text-red-300" : "text-slate-300 hover:bg-red-500/10 hover:text-red-300"}`}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleValue(opt)}
                      className="w-3.5 h-3.5 accent-red-500 cursor-pointer"
                    />
                    <span className="truncate">{opt}</span>
                  </label>
                );
              })
            )}
          </div>
          <div className="flex justify-end gap-2 p-2 border-t border-white/5 bg-[var(--th-n-elev)]">
            <button type="button" onClick={() => { setOpen(false); setSearch(""); }} className="px-3 py-1.5 rounded border border-white/10 text-slate-400 hover:text-white hover:bg-white/5 text-[11px] font-semibold transition-colors">Cancelar</button>
            <button type="button" onClick={() => { onApply(draft); setOpen(false); setSearch(""); }} className="px-3 py-1.5 rounded bg-red-500 hover:bg-red-400 text-black text-[11px] font-bold transition-colors">Aplicar</button>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

function FilterToggle({ label, state, onToggle, icon, disabled = false }: FilterToggleProps) {
  function nextState(): ToggleState {
    if (state === "off") return "yes";
    if (state === "yes") return "no";
    return "off";
  }

  const stateClass = disabled
    ? "opacity-40 cursor-not-allowed border-white/5 bg-white/[0.02] text-slate-500"
    : state === "yes"
      ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
      : state === "no"
        ? "border-rose-500/40 bg-rose-500/15 text-rose-300 hover:bg-rose-500/25"
        : "border-white/10 bg-[var(--th-n-elev)] text-slate-300 hover:bg-white/5 hover:border-red-500/30";

  return (
    <button
      type="button"
      onClick={() => !disabled && onToggle(nextState())}
      disabled={disabled}
      className={`inline-flex items-center gap-1 px-2 py-1 rounded-md border text-[11px] font-medium transition-all whitespace-nowrap cursor-pointer ${stateClass}`}
      title={label}
    >
      {icon && <span className="flex-shrink-0">{icon}</span>}
      <span className="truncate max-w-[90px]">{label}</span>
      <span className="font-black">{state === "yes" ? <Check size={12} /> : state === "no" ? <X size={12} /> : <Minus size={12} />}</span>
    </button>
  );
}

function FilterNumber({
  label,
  value,
  operator,
  onChange,
  icon,
  placeholder = "Filtro",
  disabled = false,
}: FilterNumberProps) {
  const { open, setOpen, dropPos, btnRef, dropRef, updatePosition } = useFilterDropdown(220, 180);
  const active = value !== null && Number.isFinite(value);
  const opLabel = operator === "gte" ? "≥" : "≤";
  const displayText = active ? `${opLabel} ${value}` : placeholder;
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  function handleToggle() {
    if (disabled) return;
    if (!open) updatePosition();
    setOpen(prev => !prev);
  }

  function handleValueChange(raw: string) {
    const cleaned = raw.replace(/[^\d-]/g, "");
    if (!cleaned || cleaned === "-") {
      onChange(null, operator);
      return;
    }
    const parsed = parseInt(cleaned, 10);
    onChange(Number.isFinite(parsed) ? parsed : null, operator);
  }

  const isGte = operator === "gte";

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={handleToggle}
        disabled={disabled}
        className={`inline-flex items-center gap-1 px-2 py-1 rounded-md border text-[11px] font-medium transition-all whitespace-nowrap cursor-pointer ${buttonClass(active, disabled)}`}
        title={label}
      >
        {icon && <span className="flex-shrink-0">{icon}</span>}
        <span className="truncate max-w-[100px]">{displayText}</span>
        <ChevronDown size={10} className={`flex-shrink-0 transition-transform ${open ? "rotate-180" : ""} ${active ? "text-red-400" : "text-slate-500"}`} />
      </button>

      {open && createPortal(
        <div
          ref={dropRef}
          className="fixed z-[700] rounded-lg border border-red-500/30 bg-[var(--th-n-hi)] shadow-2xl shadow-black/60 overflow-hidden"
          style={{ ...dropdownStyle(dropPos), minWidth: 220 }}
        >
          {/* Cabeçalho */}
          <div className="px-3 pt-2.5 pb-1.5 border-b border-white/5">
            <div className="text-[10px] text-slate-400 uppercase tracking-wider font-bold">{label}</div>
          </div>

          {/* Seletor de operador */}
          <div className="px-3 pt-2 pb-1">
            <div className="text-[9px] text-slate-500 uppercase tracking-wider mb-1.5 font-semibold">Condição</div>
            <div className="grid grid-cols-2 gap-1">
              <button
                type="button"
                onClick={() => onChange(value, "gte")}
                className={`flex items-center justify-center gap-1.5 px-2 py-1.5 rounded border text-[11px] font-bold transition-colors cursor-pointer ${
                  isGte
                    ? "border-emerald-500/60 bg-emerald-500/20 text-emerald-300 shadow-sm shadow-emerald-500/10"
                    : "border-white/10 bg-white/[0.03] text-slate-400 hover:bg-white/5 hover:text-slate-300"
                }`}
                title="Maior ou igual ao valor"
              >
                <span className="text-base leading-none">≥</span>
                <span>Acima</span>
              </button>
              <button
                type="button"
                onClick={() => onChange(value, "lte")}
                className={`flex items-center justify-center gap-1.5 px-2 py-1.5 rounded border text-[11px] font-bold transition-colors cursor-pointer ${
                  !isGte
                    ? "border-rose-500/60 bg-rose-500/20 text-rose-300 shadow-sm shadow-rose-500/10"
                    : "border-white/10 bg-white/[0.03] text-slate-400 hover:bg-white/5 hover:text-slate-300"
                }`}
                title="Menor ou igual ao valor"
              >
                <span className="text-base leading-none">≤</span>
                <span>Abaixo</span>
              </button>
            </div>
          </div>

          {/* Input de valor */}
          <div className="px-3 pb-2.5 pt-1">
            <div className="text-[9px] text-slate-500 uppercase tracking-wider mb-1.5 font-semibold">Valor</div>
            <div className="flex items-center gap-1.5">
              <span className={`text-base font-black w-5 text-center flex-shrink-0 ${isGte ? "text-emerald-400" : "text-rose-400"}`}>
                {opLabel}
              </span>
              <input
                ref={inputRef}
                type="text"
                inputMode="numeric"
                value={value ?? ""}
                onChange={e => handleValueChange(e.target.value)}
                placeholder="Digite um número..."
                className="flex-1 bg-[var(--th-n-panel)] border border-white/10 rounded px-2 py-1.5 text-[11px] text-white placeholder-slate-600 focus:outline-none focus:border-red-500/50 tabular-nums min-w-0"
              />
              {active && (
                <button
                  type="button"
                  onClick={() => onChange(null, operator)}
                  className="w-7 h-7 flex-shrink-0 flex items-center justify-center rounded border border-white/10 bg-white/5 text-slate-400 hover:text-red-300 hover:bg-red-500/10 hover:border-red-500/30 transition-colors"
                  title="Limpar filtro"
                >
                  <X size={12} />
                </button>
              )}
            </div>
            {active && (
              <div className={`mt-1.5 text-[9px] font-semibold ${isGte ? "text-emerald-400" : "text-rose-400"}`}>
                {isGte ? `Mostrando valores ≥ ${value}` : `Mostrando valores ≤ ${value}`}
              </div>
            )}
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

function FilterInline({ value, onChange, placeholder = "Filtro", icon, disabled = false, maxWidth = "160px" }: FilterInlineProps) {
  return (
    <div className={`inline-flex items-center gap-1 rounded-md border border-white/10 bg-[var(--th-n-elev)] px-2 py-1 text-[11px] transition-all ${disabled ? "opacity-40 cursor-not-allowed" : "focus-within:border-red-500/50 hover:border-red-500/30"}`} style={{ maxWidth }}>
      {icon && <span className="flex-shrink-0 text-slate-500">{icon}</span>}
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="min-w-0 flex-1 bg-transparent text-slate-200 placeholder-slate-500 focus:outline-none disabled:cursor-not-allowed"
      />
      {value && !disabled && (
        <button type="button" onClick={() => onChange("")} className="text-slate-500 hover:text-red-300 transition-colors flex-shrink-0">
          <X size={11} />
        </button>
      )}
    </div>
  );
}

function FilterDateMax({ label, value, onChange, icon, placeholder = "Data máx", disabled = false }: FilterDateMaxProps) {
  const active = !!value;
  return (
    <div className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-all ${disabled ? "opacity-40 cursor-not-allowed border-white/5 bg-white/[0.02]" : active ? "border-red-500/40 bg-[var(--th-n-elev)] text-red-300 hover:bg-white/5" : "border-white/10 bg-[var(--th-n-elev)] text-slate-300 hover:bg-white/5 hover:border-red-500/30"}`} title={label}>
      {icon && <span className="flex-shrink-0 text-slate-500">{icon}</span>}
      <input
        type="datetime-local"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="min-w-0 max-w-[150px] bg-transparent text-slate-200 placeholder-slate-500 focus:outline-none disabled:cursor-not-allowed [color-scheme:dark]"
      />
      {value && !disabled && (
        <button type="button" onClick={() => onChange("")} className="text-slate-500 hover:text-red-300 transition-colors flex-shrink-0">
          <X size={11} />
        </button>
      )}
    </div>
  );
}

interface UserFilterProps {
  label: string;
  options: string[];
  selected: string;
  onSelect: (value: string) => void;
  icon?: React.ReactNode;
  placeholder?: string;
  disabled?: boolean;
}

function UserFilter({
  label,
  options,
  selected,
  onSelect,
  icon,
  placeholder = "N/A",
  disabled = false,
}: UserFilterProps) {
  const { open, setOpen, dropPos, btnRef, dropRef, updatePosition } = useFilterDropdown(220, 280);
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setSearch("");
      setTimeout(() => searchRef.current?.focus(), 50);
    }
  }, [open]);

  const filteredOptions = useMemo(() => {
    const lowerSearch = search.toLowerCase();
    return options.filter(opt => opt.toLowerCase().includes(lowerSearch));
  }, [options, search]);

  function handleToggle() {
    if (disabled) return;
    if (!open) updatePosition();
    else setSearch("");
    setOpen(prev => !prev);
  }

  function handleSelect(value: string) {
    onSelect(value);
    setOpen(false);
    setSearch("");
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && filteredOptions.length > 0) {
      e.preventDefault();
      handleSelect(filteredOptions[0]);
    }
    if (e.key === "Escape") {
      setOpen(false);
      setSearch("");
    }
  }

  const hasSelection = !!selected;
  const displayText = hasSelection ? selected : placeholder;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={handleToggle}
        disabled={disabled}
        className={`inline-flex items-center gap-1 px-2 py-1 rounded-md border text-[11px] font-medium transition-all whitespace-nowrap cursor-pointer ${buttonClass(hasSelection, disabled)}`}
        title={label}
      >
        {icon && <span className="flex-shrink-0">{icon}</span>}
        <span className="truncate max-w-[120px]">{displayText}</span>
        <ChevronDown size={10} className={`flex-shrink-0 transition-transform ${open ? "rotate-180" : ""} ${hasSelection ? "text-red-400" : "text-slate-500"}`} />
      </button>

      {open && createPortal(
        <div
          ref={dropRef}
          className="fixed z-[700] rounded-lg border border-red-500/30 bg-[var(--th-n-hi)] shadow-2xl shadow-black/60 overflow-hidden"
          style={{ ...dropdownStyle(dropPos), minWidth: 220 }}
        >
          {/* Campo de busca */}
          <div className="p-1.5 border-b border-white/5 relative">
            <Search size={11} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Buscar ou digitar nome..."
              className="w-full bg-[var(--th-n-panel)] border border-white/10 rounded pl-7 pr-2 py-1.5 text-[11px] text-white placeholder-slate-500 focus:outline-none focus:border-red-500/50 transition-colors"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white"
              >
                <X size={10} />
              </button>
            )}
          </div>

          {/* Lista de opções */}
          <div className="max-h-[220px] overflow-y-auto">
            {/* Opção sem usuário do aplicativo */}
            <div
              onClick={() => handleSelect("")}
              className={`px-3 py-1.5 text-[11px] cursor-pointer transition-colors border-b border-white/5 ${!selected ? "text-slate-300 bg-white/5 font-medium" : "text-slate-500 hover:bg-red-500/10 hover:text-red-300"}`}
            >
              Nenhum usuário
            </div>

            {filteredOptions.length === 0 ? (
              <div className="px-3 py-3 text-[10px] text-slate-500 text-center italic">
                Nenhum nome encontrado
              </div>
            ) : (
              filteredOptions.map((opt, idx) => {
                const isSelected = opt === selected;
                return (
                  <div
                    key={opt + idx}
                    onClick={() => handleSelect(opt)}
                    className={`px-3 py-1.5 text-[11px] cursor-pointer transition-colors flex items-center gap-2 ${
                      isSelected
                        ? "bg-red-500/15 text-red-300 font-bold border-l-2 border-red-500"
                        : "text-slate-300 hover:bg-red-500/10 hover:text-red-300"
                    }`}
                  >
                    <span className="truncate">{opt}</span>
                  </div>
                );
              })
            )}
          </div>

          {/* Rodapé com dica */}
          <div className="px-3 py-1.5 border-t border-white/5 bg-[var(--th-n-elev)]">
            <p className="text-[9px] text-slate-500">
              {search.trim()
                ? "Enter ou clique para filtrar • Esc para fechar"
                : "Digite para buscar ou selecione da lista"}
            </p>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

export { FilterSelect, FilterMulti, FilterToggle, FilterNumber, FilterInline, FilterDateMax, UserFilter };
export type { FilterSelectProps, FilterMultiProps, FilterToggleProps, FilterNumberProps, FilterInlineProps, FilterDateMaxProps, UserFilterProps, ToggleState };