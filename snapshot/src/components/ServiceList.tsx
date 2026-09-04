import { useMemo, useState, type MouseEvent } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Check, Copy, ExternalLink } from "lucide-react";
import type { WaitingService } from "../types";
import { VOCATIONS, VOC_COLORS, formatRC, formatDateBR, customAlert } from "../types";
import { FilterSelect, FilterInline, FilterNumber } from "./FilterTypes";
import { useAuth } from "../context/AuthContext";
import { openExternalUrl } from "../utils/openExternal";
import { rubinotCharacterUrl } from "../utils/rubinotLinks";
export default function WaitingServiceAvailableList({ items, selectedIds, isFull, onAdd, filters, setFilters, swLocked = false, sgLocked = false, serverLocked = false }: {
  items: WaitingService[];
  selectedIds: Set<string>;
  isFull: boolean;
  onAdd: (id: string) => void;
  filters: Record<string, string>;
  setFilters: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  swLocked?: boolean;
  sgLocked?: boolean;
  serverLocked?: boolean;
}) {
  const { userProfile } = useAuth();
  // ── ORDENAÇÃO ──────────────────────────────────────────────────────────
  // "Add em" (dataAdicionado) é o CRITÉRIO PRINCIPAL FIXO da lista: sempre
  // da data mais antiga para a mais recente. O usuário ainda pode ordenar
  // pelas demais colunas, mas elas atuam apenas como critério SECUNDÁRIO
  // (desempate entre registros com o mesmo "Add em").
  const [sortKey, setSortKey] = useState<keyof WaitingService | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [copiedCharacterId, setCopiedCharacterId] = useState<string | null>(null);

  async function copyCharacterName(event: MouseEvent<HTMLButtonElement>, id: string, name: string) {
    event.stopPropagation();
    const text = String(name || "").trim();
    if (!text) return;
    const markCopied = () => {
      setCopiedCharacterId(id);
      window.setTimeout(() => setCopiedCharacterId(current => current === id ? null : current), 1500);
    };
    try {
      await navigator.clipboard.writeText(text);
      markCopied();
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      area.style.pointerEvents = "none";
      document.body.appendChild(area);
      area.focus();
      area.select();
      document.execCommand("copy");
      document.body.removeChild(area);
      markCopied();
    }
  }

  function cleanPhone(item: WaitingService) {
    return `${item.whatsappCountry || ""}${item.whatsappArea || ""}${item.whatsappNumber || ""}`.replace(/\D/g, "");
  }
  function canViewServiceWhats(item: WaitingService): boolean {
    if (userProfile?.role === "Boss") return true;
    const assignedServiceiro = (item.addedBy || "").trim().toLowerCase();
    if (!assignedServiceiro || assignedServiceiro === "qualquer um") return false;
    const viewerName = (userProfile?.nome || "").trim().toLowerCase();
    return assignedServiceiro === viewerName;
  }
  // Verifica se o usuário atual pode adicionar este service à PT
  function canAddServiceToPT(item: WaitingService): boolean {
    // Boss pode adicionar qualquer service
    if (userProfile?.role === "Boss") return true;
    // Se não há serviceiro definido, qualquer um pode
    const assignedServiceiro = (item.addedBy || "").trim();
    if (!assignedServiceiro || assignedServiceiro.toLowerCase() === "qualquer um") return true;
    // Apenas o serviceiro designado pode adicionar
    const viewerName = (userProfile?.nome || "").trim();
    return assignedServiceiro.toLowerCase() === viewerName.toLowerCase();
  }
  function openWhats(item: WaitingService, e: React.MouseEvent) {
    e.stopPropagation();
    if (!canViewServiceWhats(item)) return;
    const phone = cleanPhone(item);
    if (phone) window.open(`https://wa.me/${phone}`, "_blank", "noopener,noreferrer");
  }
  function toggleSort(key: keyof WaitingService) {
    if (sortKey !== key) { setSortKey(key); setSortDir("asc"); }
    else setSortDir(d => d === "asc" ? "desc" : "asc");
  }
  function updateFilter(key: string, value: string) { setFilters(f => ({ ...f, [key]: value })); }
  const wlServidorOptions = useMemo(() => Array.from(new Set(items.map(i => i.servidor).filter(Boolean))).sort(), [items]);
  const wlVocOptions = useMemo(() => VOCATIONS.filter(v => items.some(i => i.voc === v)), [items]);
  const wlDonoOptions = useMemo(() => Array.from(new Set(items.map(i => i.ownerName).filter(Boolean))).sort(), [items]);
  const wlAddedByOptions = useMemo(() => Array.from(new Set(items.map(i => i.addedBy).filter(Boolean))).sort(), [items]);
  const filtered = useMemo(() => {
    return items.filter(i => {
      if (selectedIds.has(i.id)) return false;
      if (filters.personagem && !i.personagem.toLowerCase().includes(filters.personagem.toLowerCase())) return false;
      if (filters.servidor && i.servidor !== filters.servidor) return false;
      if (filters.voc && i.voc !== filters.voc) return false;
      if (filters.ownerName && i.ownerName !== filters.ownerName) return false;
      if (filters.quest && i.quest !== filters.quest) return false;
      if (filters.addedBy && (i.addedBy || "") !== filters.addedBy) return false;
      if (filters.notes && !(i.notes || "").toLowerCase().includes(filters.notes.toLowerCase())) return false;
      if (filters.level) {
        const t = parseInt(filters.level, 10);
        if (Number.isFinite(t)) {
          const op = filters.levelOp || "gte";
          if (op === "gte" && (i.level || 0) < t) return false;
          if (op === "lte" && (i.level || 0) > t) return false;
        }
      }
      return true;
    });
  }, [items, selectedIds, filters]);
  const sorted = useMemo(() => {
    const arr = [...filtered];
    // Critério PRINCIPAL fixo: "Add em" da data mais antiga para a mais
    // recente. `dataAdicionado` é ISO curto (YYYY-MM-DD) — comparação
    // lexicográfica equivale à cronológica; `createdAt` (ms) desempata
    // dentro do mesmo dia preservando a cronologia real.
    const primaryCmp = (a: WaitingService, b: WaitingService) => {
      const cmpDate = String(a.dataAdicionado || "").localeCompare(String(b.dataAdicionado || ""));
      if (cmpDate !== 0) return cmpDate;
      return (a.createdAt || 0) - (b.createdAt || 0);
    };
    arr.sort((a, b) => {
      const main = primaryCmp(a, b);
      if (main !== 0) return main;
      // Critério SECUNDÁRIO: a coluna escolhida pelo usuário só desempata
      // registros com o mesmo "Add em" (sort estável preserva o restante).
      if (!sortKey) return 0;
      const av = a[sortKey];
      const bv = b[sortKey];
      let cmp = 0;
      if (typeof av === "number" && typeof bv === "number") cmp = av - bv;
      else cmp = String(av || "").localeCompare(String(bv || ""), "pt-BR", { sensitivity: "base" });
      return sortDir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [filtered, sortKey, sortDir]);
  function SI({ col }: { col: keyof WaitingService }) {
    if (sortKey !== col) return <ArrowUpDown size={11} className="opacity-30" />;
    return sortDir === "asc" ? <ArrowUp size={11} className="text-emerald-400" /> : <ArrowDown size={11} className="text-emerald-40 match" />;
  }
  const th = "bg-[var(--th-bg-overlay)] px-2 py-2 border-b border-[var(--th-line)]/80 cursor-pointer hover:bg-[var(--th-bg-hover)] select-none whitespace-nowrap text-[11px] uppercase tracking-wider text-slate-300 font-semibold text-center";

  return (
    <div className="h-full">
      <table className="border-collapse w-full select-none text-xs" style={{ tableLayout: "auto" }}>
        <thead className="sticky top-0 z-10">
          <tr>
            <th className={th + " w-[28px] cursor-default"}>#</th>
            <th className={th + " cursor-default"}><div className="flex items-center justify-center gap-0.5">Link</div></th>
            <th className={th} onClick={() => toggleSort("personagem")}><div className="flex items-center justify-center gap-0.5">Personagem <SI col="personagem" /></div></th>
            <th className={th} onClick={() => toggleSort("servidor")}><div className="flex items-center justify-center gap-0.5">Servidor <SI col="servidor" /></div></th>
            <th className={th} onClick={() => toggleSort("voc")}><div className="flex items-center justify-center gap-0.5">Voc <SI col="voc" /></div></th>
            <th className={th} onClick={() => toggleSort("level")}><div className="flex items-center justify-center gap-0.5">Lv <SI col="level" /></div></th>
            <th className={th} onClick={() => toggleSort("ownerName")}><div className="flex items-center justify-center gap-0.5">Dono <SI col="ownerName" /></div></th>
            <th className={th} onClick={() => toggleSort("valorCombinado")}><div className="flex items-center justify-center gap-0.5">Valor <SI col="valorCombinado" /></div></th>
            {/* "Add em" é o critério PRINCIPAL fixo (mais antigo → mais
                recente); clicar não altera — as demais colunas desempatam. */}
            <th className={th + " cursor-default"} title="Ordenação fixa: da data mais antiga para a mais recente (critério principal da lista)"><div className="flex items-center justify-center gap-0.5">Add em <ArrowUp size={11} className="text-emerald-400" /></div></th>
            <th className={th + " cursor-default"}>WA</th>
            <th className={th + " cursor-default"}>Quest</th>
            <th className={th} onClick={() => toggleSort("addedBy")}><div className="flex items-center justify-center gap-0.5">Serviceiro <SI col="addedBy" /></div></th>
            <th className={th + " cursor-default"}>Notas</th>
          </tr>
          <tr>
            <th className="bg-[var(--th-bg-base)] px-1 py-1 border-b border-[var(--th-line)]/80 text-center"><button type="button" onClick={() => setFilters({})} className="w-full h-6 rounded bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white text-[8px] font-bold cursor-pointer flex items-center justify-center" title="Resetar todos os filtros da lista de espera">↺</button></th>
            <th className="bg-[var(--th-bg-base)] px-1 py-1 border-b border-[var(--th-line)]/80 text-center" />
            <th className="bg-[var(--th-bg-base)] px-1 py-1 border-b border-[var(--th-line)]/80">
              <div className="flex justify-center">
                <FilterInline
                  value={filters.personagem || ""}
                  onChange={(v) => updateFilter("personagem", v)}
                  maxWidth="90px"
                />
              </div>
            </th>
            <th className="bg-[var(--th-bg-base)] px-1 py-1 border-b border-[var(--th-line)]/80">
              <div className="flex justify-center">
                <FilterSelect
                  label="Servidor"
                  options={wlServidorOptions}
                  selected={filters.servidor || ""}
                  onSelect={(v) => updateFilter("servidor", v)}
                  searchable
                  disabled={serverLocked}
                />
              </div>
            </th>
            <th className="bg-[var(--th-bg-base)] px-1 py-1 border-b border-[var(--th-line)]/80">
              <div className="flex justify-center">
                <FilterSelect
                  label="Vocação"
                  options={wlVocOptions}
                  selected={filters.voc || ""}
                  onSelect={(v) => updateFilter("voc", v)}
                  allLabel="Todas"
                />
              </div>
            </th>
            <th className="bg-[var(--th-bg-base)] px-1 py-1 border-b border-[var(--th-line)]/80">
              <div className="flex justify-center">
                <FilterNumber
                  label="Level"
                  value={filters.level ? parseInt(filters.level, 10) : null}
                  operator={(filters.levelOp as "gte" | "lte") || "gte"}
                  onChange={(v, op) => {
                    setFilters(f => ({ ...f, level: v === null ? "" : String(v), levelOp: op }));
                  }}
                />
              </div>
            </th>
            <th className="bg-[var(--th-bg-base)] px-1 py-1 border-b border-[var(--th-line)]/80">
              <div className="flex justify-center">
                <FilterSelect
                  label="Cliente"
                  options={wlDonoOptions}
                  selected={filters.ownerName || ""}
                  onSelect={(v) => updateFilter("ownerName", v)}
                  searchable
                />
              </div>
            </th>
            <th className="bg-[var(--th-bg-base)] px-1 py-1 border-b border-[var(--th-line)]/80" />
            <th className="bg-[var(--th-bg-base)] px-1 py-1 border-b border-[var(--th-line)]/80" />
            <th className="bg-[var(--th-bg-base)] px-1 py-1 border-b border-[var(--th-line)]/80" />
            <th className="bg-[var(--th-bg-base)] px-1 py-1 border-b border-[var(--th-line)]/80">
              <div className="flex justify-center">
                <FilterSelect
                  label="Quest"
                  options={["soulwar", "sanguine"]}
                  selected={filters.quest || ""}
                  onSelect={(v) => updateFilter("quest", v)}
                  allLabel="Todas"
                  disabled={swLocked || sgLocked}
                />
              </div>
            </th>
            <th className="bg-[var(--th-bg-base)] px-1 py-1 border-b border-[var(--th-line)]/80">
              <div className="flex justify-center">
                <FilterSelect
                  label="Serviceiro"
                  options={wlAddedByOptions}
                  selected={filters.addedBy || ""}
                  onSelect={(v) => updateFilter("addedBy", v)}
                  searchable
                />
              </div>
            </th>
            <th className="bg-[var(--th-bg-base)] px-1 py-1 border-b border-[var(--th-line)]/80">
              <div className="flex justify-center">
                <FilterInline
                  value={filters.notes || ""}
                  onChange={(v) => updateFilter("notes", v)}
                  maxWidth="90px"
                />
              </div>
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 && <tr><td colSpan={13} className="text-center py-6 text-slate-500 text-xs">Nenhum service disponível.</td></tr>}
          {sorted.map((w, idx) => {
            const canViewWhats = canViewServiceWhats(w);
            const hasVisibleWhats = canViewWhats && !!cleanPhone(w);
            const whatsappRestricted = !!cleanPhone(w) && !canViewWhats;
            return (
              <tr
                key={w.id}
                onClick={() => {
                  if (isFull) return;
                  // Verificar permissão de serviceiro
                  if (!canAddServiceToPT(w)) {
                    customAlert(`Somente o Serviceiro "${w.addedBy}" pode adicionar este personagem à PT.`);
                    return;
                  }
                  onAdd(w.id);
                }}
                className={`transition-colors ${idx % 2 === 0 ? "bg-[var(--th-bg-base)]" : "bg-[var(--th-bg-raised)]"} ${isFull ? "opacity-40 cursor-not-allowed" : "cursor-pointer hover:bg-[var(--th-bg-overlay)]"}`}
                title={!canAddServiceToPT(w) ? `Somente o Serviceiro "${w.addedBy}" pode adicionar este personagem` : ""}
              >
                <td className="px-2 py-1.5 text-center font-mono text-slate-500 font-bold whitespace-nowrap">{idx + 1}</td>
                <td className="px-2 py-1.5 text-center whitespace-nowrap">
                  {w.personagem ? (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); openExternalUrl(rubinotCharacterUrl(w.personagem)); }}
                      onMouseDown={(e) => e.stopPropagation()}
                      className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-sky-300 hover:text-sky-200 hover:bg-sky-500/10 transition-colors cursor-pointer"
                      title={`Abrir a página oficial de "${w.personagem}" no RubinOT`}
                    >
                      <ExternalLink size={11} />
                    </button>
                  ) : <span className="text-slate-600">—</span>}
                </td>
                <td className="px-2 py-1.5 text-center whitespace-nowrap">
                  <button
                    type="button"
                    onClick={event => copyCharacterName(event, w.id, w.personagem)}
                    onMouseDown={event => event.stopPropagation()}
                    className={`group inline-flex max-w-[180px] items-center gap-1 rounded px-1 py-0.5 font-medium transition-colors cursor-copy ${
                      copiedCharacterId === w.id
                        ? "bg-emerald-500/20 text-emerald-300"
                        : "text-slate-100 hover:bg-white/10 hover:text-white"
                    }`}
                    title={copiedCharacterId === w.id ? "Nome copiado" : `Copiar "${w.personagem || ""}" para a área de transferência`}
                  >
                    {copiedCharacterId === w.id ? (
                      <><Check size={12} className="flex-shrink-0 text-emerald-400" /><span>Copiado!</span></>
                    ) : (
                      <><span className="truncate">{w.personagem || "—"}</span><Copy size={11} className="flex-shrink-0 opacity-0 group-hover:opacity-70 transition-opacity" /></>
                    )}
                  </button>
                </td>
                <td className="px-2 py-1.5 text-center whitespace-nowrap">{w.servidor || "—"}</td>
                <td className="px-2 py-1.5 text-center whitespace-nowrap"><span className="font-bold" style={{ color: VOC_COLORS[w.voc!] }}>{w.voc}</span></td>
                <td className="px-2 py-1.5 text-center tabular-nums whitespace-nowrap">{w.level || "—"}</td>
                <td className="px-2 py-1.5 text-center whitespace-nowrap">{w.ownerName || "—"}</td>
                <td className="px-2 py-1.5 text-center tabular-nums whitespace-nowrap">{formatRC(w.valorCombinado || 0)}</td>
                <td className="px-2 py-1.5 text-center whitespace-nowrap">{formatDateBR(w.dataAdicionado)}</td>
                <td className="px-2 py-1.5 text-center whitespace-nowrap">
                  {hasVisibleWhats ? (
                    <button onClick={(e) => openWhats(w, e)} className="inline-flex items-center gap-1 text-emerald-300 hover:text-emerald-200"><ExternalLink size={11} />WA</button>
                  ) : whatsappRestricted ? (
                    <span className="text-slate-600 text-[11px]">🔒</span>
                  ) : "—"}
                </td>
                <td className="px-2 py-1.5 text-center whitespace-nowrap">
                  {w.quest === "sanguine"
                    ? <span className="text-rose-500 font-bold text-[10px] tracking-wider">SANGUINE</span>
                    : <span className="text-slate-400 font-bold text-[10px] tracking-wider">SOULWAR</span>
                  }
                </td>
                <td className="px-2 py-1.5 text-center whitespace-nowrap">{w.addedBy || "—"}</td>
                <td className="px-2 py-1.5 text-center truncate max-w-[160px] text-slate-400" title={w.notes}>{w.notes || "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}