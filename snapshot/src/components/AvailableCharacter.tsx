import { useState, type MouseEvent } from "react";
import { Check, CircleAlert, Copy } from "lucide-react";
import type { Character } from "../types";
import { VOC_COLORS } from "../types";
import { FilterSelect, FilterMulti, FilterToggle, FilterNumber, FilterInline, type ToggleState } from "./FilterTypes";
import RefreshButton from "./RefreshButton";
import { serverLabel } from "../constants/servers";
import { useAuth } from "../context/AuthContext";

/**
 * Informações de uma PT na qual o personagem já está — alimenta o tooltip do
 * indicador ⚠ "em outra PT" da lista PERSONAGENS DISPONÍVEIS.
 */
export interface OtherPartyInfo {
  /** Nome da PT. */
  name: string;
  /** Quest da PT: "Soul War", "Sanguine" ou "Quest não definida". */
  questLabel: string;
  /** Nota de status para PTs arquivadas: "finalizada" / "falhou". */
  statusNote?: string;
}

interface Props {
  onRefresh?: () => Promise<void>;
  handleRefresh: () => void;
  isRefreshing: boolean;
  refreshDone: boolean;
  thCls: string;
  hdr: string;
  toggleSort: (key: string) => void;
  SI: React.ComponentType<{ col: string }>;
  resetAvailableFilters: () => void;
  /** Compatibilidade visual da Visão Geral, onde não há conflito de PT atual. */
  smartAccountFilter?: boolean;
  setSmartAccountFilter?: React.Dispatch<React.SetStateAction<boolean>>;
  /** IDs que pertencem à mesma conta de um personagem já incluído nesta PT. */
  unavailableAccountIds?: ReadonlySet<string>;
  /** Exibe a legenda explicativa somente dentro de uma PT selecionada. */
  showAccountConflictLegend?: boolean;
  filterPersonagem: string;
  setFilterPersonagem: (v: string) => void;
  serverOptions: string[];
  filterServer: string;
  setFilterServer: (v: string) => void;
  serverLocked?: boolean;
  vocOptions: string[];
  filterVoc: string;
  setFilterVoc: (v: string) => void;
  filterLevel: string;
  filterLevelOp: "gte" | "lte";
  setFilterLevel: (v: string) => void;
  setFilterLevelOp: (v: "gte" | "lte") => void;
  filterSW: ToggleState;
  setFilterSW: (v: ToggleState) => void;
  filterSG: ToggleState;
  setFilterSG: (v: ToggleState) => void;
  swLocked?: boolean;
  sgLocked?: boolean;
  donoOptions: string[];
  filterDonos: string[];
  setFilterDonos: (v: string[]) => void;
  sortedAvailable: Character[];
  idsInOtherParties: Set<string>;
  /**
   * Informa as PT's (nome + quest) em que o personagem já está, para o
   * tooltip do indicador ⚠ "em outra PT". Opcional: sem a função, o tooltip
   * estático original é mantido. O chamador deriva tudo das PT's que já
   * estão em memória — nenhuma leitura adicional é feita aqui.
   */
  otherPartiesInfoFor?: (characterId: string) => OtherPartyInfo[] | undefined;
  isFull: boolean;
  addToParty: (id: string) => void;
  /**
   * Resolve o código fictício da conta de um personagem.
   *
   * Recebe a FUNÇÃO em vez do mapa porque o código passou a ser indexado pela
   * identidade da conta (`ownerUid + nome`) — indexar por `c.account` daria o
   * mesmo rótulo para contas homônimas de usuários diferentes.
   */
  accountLabelFor: (character: Character) => string;
  getCharOwner: (c: Character) => string;
}
export default function AvailableCharacter({
  onRefresh,
  handleRefresh,
  isRefreshing,
  refreshDone,
  thCls,
  hdr,
  toggleSort,
  SI,
  resetAvailableFilters,
  smartAccountFilter = false,
  setSmartAccountFilter,
  unavailableAccountIds,
  showAccountConflictLegend = false,
  filterPersonagem,
  setFilterPersonagem,
  serverOptions,
  filterServer,
  setFilterServer,
  serverLocked = false,
  vocOptions,
  filterVoc,
  setFilterVoc,
  filterLevel,
  filterLevelOp,
  setFilterLevel,
  setFilterLevelOp,
  filterSW,
  setFilterSW,
  filterSG,
  setFilterSG,
  swLocked = false,
  sgLocked = false,
  donoOptions,
  filterDonos,
  setFilterDonos,
  sortedAvailable,
  idsInOtherParties,
  otherPartiesInfoFor,
  isFull,
  addToParty,
  accountLabelFor,
  getCharOwner,
}: Props) {
  const { currentUser } = useAuth();
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

  return (
    <>
      <div className="px-2 py-1 bg-[var(--th-bg-raised)] border-b border-[var(--th-brand-mid)]/40 text-[10px] uppercase tracking-wider text-amber-600 font-bold flex-shrink-0 flex items-center justify-between gap-2">
        <span className="truncate">Personagens disponíveis</span>
        {onRefresh && (
          <RefreshButton
            onRefresh={handleRefresh}
            isRefreshing={isRefreshing}
            refreshDone={refreshDone}
            title="Recarregar lista de personagens disponíveis"
          />
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto" onWheel={e => e.stopPropagation()}>
        <table className="border-collapse w-full select-none text-xs" style={{ tableLayout: "auto" }}>
          <colgroup>
            <col className="w-[28px]" /><col /><col /><col /><col /><col /><col /><col /><col />
          </colgroup>
          <thead className="sticky top-0 z-10">
            <tr>
              <th className={`${thCls} text-center whitespace-nowrap w-[28px]`}><div className={hdr + " justify-center"}>#</div></th>
              <th className={`${thCls} text-center whitespace-nowrap`} onClick={() => toggleSort("account")}><div className={`${hdr} justify-center`}>Conta <SI col="account" /></div></th>
              <th className={`${thCls} text-center whitespace-nowrap`}><div className={`${hdr} justify-center`}>Personagem</div></th>
              <th className={`${thCls} text-center whitespace-nowrap`} onClick={() => toggleSort("servidor")}><div className={`${hdr} justify-center`}>Servidor <SI col="servidor" /></div></th>
              <th className={`${thCls} text-center whitespace-nowrap`} onClick={() => toggleSort("voc")}><div className={`${hdr} justify-center`}>Voc <SI col="voc" /></div></th>
              <th className={`${thCls} text-center whitespace-nowrap`} onClick={() => toggleSort("level")}><div className={`${hdr} justify-center`}>Level <SI col="level" /></div></th>
              <th className={`${thCls} text-center whitespace-nowrap`}><div className={`${hdr} justify-center`}>SW</div></th>
              <th className={`${thCls} text-center whitespace-nowrap`}><div className={`${hdr} justify-center`}>SG</div></th>
              <th className={`${thCls} text-center whitespace-nowrap`}><div className={`${hdr} justify-center`}>Dono</div></th>
            </tr>
            <tr>
              <th className="bg-[var(--th-bg-base)] px-1 py-1 border-b border-[var(--th-line)]/80 text-center"><button type="button" onClick={resetAvailableFilters} className="w-full h-6 rounded bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white text-[8px] font-bold cursor-pointer flex items-center justify-center" title="Resetar todos os filtros">↺</button></th>
              <th className="bg-[var(--th-bg-base)] px-1 py-1 border-b border-[var(--th-line)]/80 text-center">
                {showAccountConflictLegend ? (
                  <span
                    className="inline-flex items-center gap-1 rounded border border-rose-500/25 bg-rose-500/[0.06] px-1.5 py-0.5 text-[8px] font-bold text-rose-300"
                    title="Personagens da mesma conta de um membro da PT permanecem visíveis, mas não podem ser adicionados."
                  >
                    <CircleAlert size={10} /> Conta em uso
                  </span>
                ) : setSmartAccountFilter ? (
                  <button
                    type="button"
                    onClick={() => setSmartAccountFilter(value => !value)}
                    className={`px-1.5 py-0.5 rounded border text-[9px] font-bold transition-colors cursor-pointer ${
                      smartAccountFilter
                        ? "border-emerald-500/50 bg-emerald-500/20 text-emerald-300"
                        : "border-white/10 bg-white/5 text-slate-400 hover:bg-white/10 hover:text-slate-300"
                    }`}
                    title="Ocultar contas que já participam desta PT"
                  >
                    Smart
                  </button>
                ) : (
                  <span className="text-[9px] text-slate-600">—</span>
                )}
              </th>
              <th className="bg-[var(--th-bg-base)] px-1 py-1 border-b border-[var(--th-line)]/80">
                <div className="flex justify-center">
                  <FilterInline
                    value={filterPersonagem}
                    onChange={setFilterPersonagem}
                    maxWidth="90px"
                  />
                </div>
              </th>
              <th className="bg-[var(--th-bg-base)] px-1 py-1 border-b border-[var(--th-line)]/80">
                <div className="flex justify-center">
                  <FilterSelect
                    label="Servidor"
                    options={serverOptions}
                    selected={filterServer}
                    onSelect={setFilterServer}
                    searchable
                    disabled={serverLocked}
                  />
                </div>
              </th>
              <th className="bg-[var(--th-bg-base)] px-1 py-1 border-b border-[var(--th-line)]/80">
                <div className="flex justify-center">
                  <FilterSelect
                    label="Vocação"
                    options={vocOptions}
                    selected={filterVoc}
                    onSelect={setFilterVoc}
                    allLabel="Todas"
                  />
                </div>
              </th>
              <th className="bg-[var(--th-bg-base)] px-1 py-1 border-b border-[var(--th-line)]/80">
                <div className="flex justify-center">
                  <FilterNumber
                    label="Level"
                    value={filterLevel ? parseInt(filterLevel, 10) : null}
                    operator={filterLevelOp}
                    onChange={(v, op) => { setFilterLevel(v === null ? "" : String(v)); setFilterLevelOp(op); }}
                  />
                </div>
              </th>
              <th className="bg-[var(--th-bg-base)] px-1 py-1 border-b border-[var(--th-line)]/80 text-center">
                <div className="flex justify-center">
                  <FilterToggle
                    label="SW"
                    state={filterSW}
                    onToggle={setFilterSW}
                    disabled={swLocked}
                  />
                </div>
              </th>
              <th className="bg-[var(--th-bg-base)] px-1 py-1 border-b border-[var(--th-line)]/80 text-center">
                <div className="flex justify-center">
                  <FilterToggle
                    label="SG"
                    state={filterSG}
                    onToggle={setFilterSG}
                    disabled={sgLocked}
                  />
                </div>
              </th>
              <th className="bg-[var(--th-bg-base)] px-1 py-1 border-b border-[var(--th-line)]/80 text-center">
                <div className="flex justify-center">
                  <FilterMulti
                    label="Dono"
                    options={donoOptions}
                    selected={filterDonos}
                    onApply={setFilterDonos}
                    searchable
                  />
                </div>
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedAvailable.length === 0 && (<tr><td colSpan={9} className="text-center py-6 text-slate-500 text-xs">Nenhum personagem disponível.</td></tr>)}
            {sortedAvailable.map((c, idx) => {
              const isInOther = idsInOtherParties.has(c.id);
              const isSameAccountUnavailable = unavailableAccountIds?.has(c.id) === true;
              const isUnavailable = isFull || isSameAccountUnavailable;
              // Tooltip do ⚠: além do aviso, nomeia a PT (ou PT's) e a Quest
              // correspondente, com os dados que o chamador já mantém em
              // memória. Sem `otherPartiesInfoFor`, cai no texto original.
              const otherPartyInfos = isInOther ? otherPartiesInfoFor?.(c.id) : undefined;
              // Formato pedido: nomear a Quest configurada na PT em que o
              // personagem participa — "… faz parte de uma PT — Quest: X".
              const otherPartyTooltipTitle = otherPartyInfos?.length
                ? `Este personagem faz parte de ${otherPartyInfos.length > 1 ? "PT's" : "uma PT"}:\n\n${otherPartyInfos.map(info => `• ${info.name} — ${info.questLabel === "Quest não definida" ? info.questLabel : `Quest: ${info.questLabel}`}${info.statusNote ? ` (${info.statusNote})` : ""}`).join("\n")}`
                : "Este personagem já está em outra PT";
              const unavailableTitle = isSameAccountUnavailable
                ? "Outro personagem da mesma conta já participa desta PT"
                : isFull
                  ? "PT cheia"
                  : isInOther
                    ? otherPartyTooltipTitle
                    : "Clique para adicionar à PT";
              // A conta real só é liberada quando o UID do personagem é o UID
              // da pessoa que visualiza esta lista. Sem fallback por nome: isso
              // preserva a privacidade de personagens compartilhados/terceiros.
              const ownAccount = currentUser?.uid && c.ownerUid === currentUser.uid
                ? String(c.account || "").trim()
                : "";
              const accountLabel = ownAccount || accountLabelFor(c) || "—";
              return (
                <tr
                  key={c.id}
                  onClick={() => { if (!isUnavailable) addToParty(c.id); }}
                  className={`transition-colors ${
                    isSameAccountUnavailable
                      ? "bg-rose-950/18 ring-1 ring-inset ring-rose-500/20"
                      : idx % 2 === 0
                        ? "bg-[var(--th-bg-base)]"
                        : "bg-[var(--th-bg-raised)]"
                  } ${
                    isUnavailable
                      ? isSameAccountUnavailable
                        ? "cursor-not-allowed hover:bg-rose-950/25"
                        : "opacity-40 cursor-not-allowed"
                      : "cursor-pointer hover:bg-[var(--th-bg-overlay)]"
                  } ${isInOther && !isSameAccountUnavailable ? "ring-1 ring-inset ring-amber-500/20" : ""}`}
                  title={unavailableTitle}
                >
                  <td className="px-1 py-1.5 text-center font-mono text-slate-500 font-bold whitespace-nowrap">{idx + 1}</td>
                  <td className="px-2 py-1.5 text-center text-slate-400 whitespace-nowrap">
                    <span className="inline-flex items-center justify-center gap-1">
                      <span className={ownAccount ? "font-medium text-slate-200" : ""} title={ownAccount ? "Conta real do seu personagem" : undefined}>{accountLabel}</span>
                      {isSameAccountUnavailable && (
                        <span title="Outra personagem da mesma conta já está nesta PT">
                          <CircleAlert size={12} className="text-rose-400/70" />
                        </span>
                      )}
                      {isInOther && <span className="text-amber-400" title={otherPartyTooltipTitle}>⚠</span>}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-center whitespace-nowrap">
                    <button
                      type="button"
                      onClick={event => copyCharacterName(event, c.id, c.personagem)}
                      onMouseDown={event => event.stopPropagation()}
                      className={`group inline-flex max-w-[180px] items-center gap-1 rounded px-1 py-0.5 font-medium transition-colors cursor-copy ${
                        copiedCharacterId === c.id
                          ? "bg-emerald-500/20 text-emerald-300"
                          : isSameAccountUnavailable
                            ? "text-rose-200/80 hover:bg-rose-500/[0.06] hover:text-rose-100"
                            : "text-slate-100 hover:bg-white/10 hover:text-white"
                      }`}
                      title={copiedCharacterId === c.id ? "Nome copiado" : `Copiar "${c.personagem || ""}" para a área de transferência`}
                    >
                      {copiedCharacterId === c.id ? (
                        <><Check size={12} className="flex-shrink-0 text-emerald-400" /><span>Copiado!</span></>
                      ) : (
                        <><span className="truncate">{c.personagem || "—"}</span><Copy size={11} className="flex-shrink-0 opacity-0 group-hover:opacity-70 transition-opacity" /></>
                      )}
                    </button>
                  </td>
                  <td className="px-2 py-1.5 text-center text-slate-300 whitespace-nowrap">{serverLabel(c.servidor)}</td>
                  <td className="px-2 py-1.5 text-center whitespace-nowrap"><span className="font-bold" style={{ color: VOC_COLORS[c.voc!] }}>{c.voc}</span></td>
                  <td className="px-2 py-1.5 text-center tabular-nums whitespace-nowrap">{c.level}</td>
                  <td className="px-2 py-1.5 text-center whitespace-nowrap">{c.soulwar ? <span className="text-emerald-400 font-bold text-[10px]">✓</span> : <span className="text-rose-500 font-bold text-[10px]">✕</span>}</td>
                  <td className="px-2 py-1.5 text-center whitespace-nowrap">{c.sanguine ? <span className="text-emerald-400 font-bold text-[10px]">✓</span> : <span className="text-rose-500 font-bold text-[10px]">✕</span>}</td>
                  <td className="px-2 py-1.5 text-center text-sky-300 whitespace-nowrap">{getCharOwner(c)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}