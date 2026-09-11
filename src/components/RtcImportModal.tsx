import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, FileCode2, Pencil, Plus, Trash2, X } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { VOCATIONS, VOC_COLORS, VOC_LABEL, customConfirm, type Vocation } from "../types";
import {
  RTC_CODE_MAX,
  RTC_DIVISIONS,
  RTC_PROFILE_NAME_MAX,
  RTC_QUEST_LABELS,
  RTC_SLOT_LABELS,
  buildRtcKey,
  rtcCodeHue,
  rtcDivisionSlots,
  type RtcEntry,
  type RtcEntryMap,
  type RtcQuest,
  type RtcSlotType,
} from "../constants/rtcImports";
import {
  savePersonalRtcEntry,
  saveRecommendedRtcEntry,
  subscribePersonalRtc,
  subscribeRecommendedRtc,
} from "../services/rtcImportsService";

// ============================================================================
// MODAL "IMPORT RTC"
// ----------------------------------------------------------------------------
// Gerenciamento e importação de códigos RTC por Quest + Vocação + Divisão +
// Tipo (Acesso/Boss), em duas áreas exibidas SIMULTANEAMENTE por divisão:
//
//   • RECOMENDADO        → doc global `rtcImports/recommended`; todos veem,
//                          só Boss edita (UI + regras do Firestore);
//   • MINHAS IMPORTAÇÕES → doc `userRtcImports/{uid}`; perfis do próprio
//                          usuário, sincronizados entre dispositivos.
//
// Decisões que importam:
//   • PORTAL em document.body — o app vive num container com CSS `zoom` que
//     quebra hit-testing de `position: fixed` (mesmo motivo do
//     ImbuementsModal/ConfirmModal).
//   • Listeners assinados SÓ com o modal aberto: 1 leitura por doc + deltas.
//   • Cores de vocação: exclusivamente `VOC_COLORS` (identidade oficial).
//   • CÓDIGO LITERAL: textarea sem transformação; o botão "Importar" copia
//     o valor armazenado byte a byte (é a MESMA função de copiar de sempre,
//     apenas com rótulo "Importar").
//   • IDENTIDADE POR CÓDIGO: botões "Importar" coloridos por hash do código
//     (rtcCodeHue) — códigos IGUAIS têm botões IGUAIS em qualquer lugar do
//     modal; códigos diferentes tendem a cores diferentes.
//   • LAYOUT DOS CARDS: uma caixa por divisão contendo uma TABELA compacta —
//     colunas "Recomendado" / "Meu Perfil", linhas "Acesso" / "Boss". Cada
//     célula traz o nome do perfil + botão "Importar" (e lápis de edição),
//     com linhas de grade finas para alinhamento perfeito e comparação
//     imediata entre as duas colunas.
//   • Esc fecha (mas primeiro cancela uma edição aberta, se houver).
// ============================================================================

interface Props {
  open: boolean;
  onClose: () => void;
}

/** Identifica a edição em andamento (uma por vez). */
interface EditingState {
  scope: "recommended" | "personal";
  key: string;
  profileName: string;
  code: string;
  /** true = criação (não existia perfil nesta combinação). */
  isNew: boolean;
}

/** Estilos derivados da cor da vocação (mesma técnica do ImbuementsModal). */
function vocStyles(voc: Vocation) {
  const hue = VOC_COLORS[voc];
  return {
    hue,
    text: `color-mix(in oklab, ${hue} 80%, white)`,
    border: `color-mix(in oklab, ${hue} 55%, transparent)`,
    fill: `color-mix(in oklab, ${hue} 16%, transparent)`,
    glow: `color-mix(in oklab, ${hue} 35%, transparent)`,
  };
}

export default function RtcImportModal({ open, onClose }: Props) {
  const { currentUser, userProfile } = useAuth();
  const isBoss = userProfile?.role === "Boss";
  const uid = currentUser?.uid || "";

  const [quest, setQuest] = useState<RtcQuest>("soulwar");
  const [voc, setVoc] = useState<Vocation>("EK");
  const [recommended, setRecommended] = useState<RtcEntryMap>({});
  const [personal, setPersonal] = useState<RtcEntryMap>({});
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [copiedKey, setCopiedKey] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  // ── Assinaturas Firestore — apenas com o modal aberto ────────────────────
  useEffect(() => {
    if (!open) return;
    const unsubRec = subscribeRecommendedRtc(setRecommended);
    const unsubPers = subscribePersonalRtc(uid, setPersonal);
    return () => {
      unsubRec();
      unsubPers();
    };
  }, [open, uid]);

  // Esc: primeiro cancela edição aberta; sem edição, fecha o modal.
  useEffect(() => {
    if (!open) return;
    function handleKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setEditing(prev => {
        if (prev) return null;
        onClose();
        return prev;
      });
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  // Estado transitório zerado ao fechar.
  useEffect(() => {
    if (open) return;
    setEditing(null);
    setCopiedKey("");
    setSaveError("");
  }, [open]);

  const divisions = RTC_DIVISIONS[quest];
  const vs = useMemo(() => vocStyles(voc), [voc]);

  async function copyCode(uniqueKey: string, code: string) {
    try {
      // Texto LITERAL: exatamente o que está armazenado.
      await navigator.clipboard.writeText(code);
      setCopiedKey(uniqueKey);
      window.setTimeout(() => setCopiedKey(prev => (prev === uniqueKey ? "" : prev)), 1600);
    } catch {}
  }

  function startEdit(scope: "recommended" | "personal", key: string, existing: RtcEntry | undefined) {
    setSaveError("");
    setEditing({
      scope,
      key,
      profileName: existing?.profileName || "",
      code: existing?.code || "",
      isNew: !existing,
    });
  }

  async function saveEditing() {
    if (!editing || saving) return;
    const profileName = editing.profileName.trim().slice(0, RTC_PROFILE_NAME_MAX);
    // Código NÃO recebe trim — espaços podem ser parte legítima do conteúdo.
    const code = editing.code.slice(0, RTC_CODE_MAX);
    if (!profileName || !code) {
      setSaveError("Informe o nome do perfil e o código RTC.");
      return;
    }
    const entry: RtcEntry = { profileName, code, updatedAtMs: Date.now() };
    setSaving(true);
    const ok = editing.scope === "recommended"
      ? await saveRecommendedRtcEntry(editing.key, entry)
      : await savePersonalRtcEntry(uid, editing.key, entry, personal);
    setSaving(false);
    if (!ok) {
      setSaveError("Não foi possível salvar. Verifique sua conexão e permissões.");
      return;
    }
    // Modo simulação não tem listener: reflete localmente na hora.
    if (editing.scope === "personal") setPersonal(prev => ({ ...prev, [editing.key]: entry }));
    else setRecommended(prev => ({ ...prev, [editing.key]: entry }));
    setEditing(null);
    setSaveError("");
  }

  function deleteEditing() {
    if (!editing || saving) return;
    // `customConfirm` do app é callback-based (dialog global) — o trabalho
    // real acontece dentro do onConfirm.
    customConfirm(
      `Excluir o perfil ${editing.scope === "recommended" ? "recomendado" : "pessoal"} desta combinação?`,
      () => { void performDelete(); },
      "Excluir perfil",
    );
  }

  async function performDelete() {
    if (!editing || saving) return;
    setSaving(true);
    const ok = editing.scope === "recommended"
      ? await saveRecommendedRtcEntry(editing.key, null)
      : await savePersonalRtcEntry(uid, editing.key, null, personal);
    setSaving(false);
    if (!ok) {
      setSaveError("Não foi possível excluir. Verifique sua conexão e permissões.");
      return;
    }
    const clear = (prev: RtcEntryMap) => {
      const next = { ...prev };
      delete next[editing.key];
      return next;
    };
    if (editing.scope === "personal") setPersonal(clear);
    else setRecommended(clear);
    setEditing(null);
    setSaveError("");
  }

  if (!open) return null;

  // ── Célula da tabela (interseção linha Acesso/Boss × coluna
  //    Recomendado/Meu Perfil) ────────────────────────────────────────────
  // Conteúdo empilhado e enxuto:
  //   nome do perfil  [✎]
  //   [ Importar ─ largura total da célula ]
  // O botão "Importar" ocupa a largura da célula — todos ficam perfeitamente
  // alinhados entre linhas e colunas, e a comparação Recomendado × Meu
  // Perfil é lado a lado. Célula vazia mostra "—" + "Adicionar" (se puder).
  function renderCell(scope: "recommended" | "personal", key: string, entry: RtcEntry | undefined) {
    const isRecommended = scope === "recommended";
    const canEdit = isRecommended ? isBoss : true;
    const uniqueKey = `${scope}:${key}`;
    const isCopied = copiedKey === uniqueKey;

    return (
      <div className="flex min-w-0 flex-col justify-center gap-0.5 px-1 py-1">
        {entry ? (
          <>
            <div className="flex min-w-0 items-center gap-0.5">
              <span className="min-w-0 flex-1 truncate text-[10px] font-bold leading-tight text-slate-200" title={entry.profileName}>
                {entry.profileName}
              </span>
              {canEdit && (
                <button
                  type="button"
                  onClick={() => startEdit(scope, key, entry)}
                  className="flex-shrink-0 inline-flex h-4 w-4 items-center justify-center rounded border border-transparent text-slate-500 hover:text-slate-200 hover:border-[var(--th-line)] transition-colors cursor-pointer"
                  title={isRecommended ? "Editar perfil recomendado (Boss)" : "Editar meu perfil"}
                >
                  <Pencil size={9} />
                </button>
              )}
            </div>
            {/* Botão IMPORTAR — copia o código literal (mesma função de
                sempre); identidade visual POR CÓDIGO (mesmo código = mesma
                cor de botão em qualquer lugar do modal). */}
            <button
              type="button"
              onClick={() => copyCode(uniqueKey, entry.code)}
              className="inline-flex h-5 w-full items-center justify-center gap-1 rounded border text-[9px] font-black tracking-wide transition-all duration-150 cursor-pointer hover:brightness-125 active:scale-95"
              style={isCopied
                ? { borderColor: "rgba(16,185,129,0.6)", background: "rgba(16,185,129,0.18)", color: "#6ee7b7" }
                : {
                    borderColor: `color-mix(in oklab, ${rtcCodeHue(entry.code)} 55%, transparent)`,
                    background: `color-mix(in oklab, ${rtcCodeHue(entry.code)} 15%, transparent)`,
                    color: `color-mix(in oklab, ${rtcCodeHue(entry.code)} 80%, white)`,
                    boxShadow: `0 0 8px color-mix(in oklab, ${rtcCodeHue(entry.code)} 25%, transparent)`,
                  }}
              title={isCopied ? "Código copiado!" : `Importar (copiar) o código do perfil "${entry.profileName}"`}
            >
              {isCopied
                ? <><Check size={10} strokeWidth={3} /> Copiado</>
                : <><Copy size={9} strokeWidth={2.5} /> Importar</>}
            </button>
          </>
        ) : (
          <>
            {canEdit ? (
              <button
                type="button"
                onClick={() => startEdit(scope, key, undefined)}
                className="inline-flex h-5 w-full items-center justify-center gap-1 rounded border border-dashed border-[var(--th-line)] text-[9px] font-bold text-slate-500 hover:text-slate-300 hover:border-slate-500/70 transition-colors cursor-pointer"
                title={isRecommended ? "Configurar recomendação (Boss)" : "Adicionar meu perfil"}
              >
                <Plus size={10} /> Adicionar
              </button>
            ) : (
              <span className="inline-flex h-5 w-full items-center justify-center rounded border border-transparent text-[9px] italic text-slate-700">
                {isRecommended ? "Sem recomendação" : "Não configurado"}
              </span>
            )}
          </>
        )}
      </div>
    );
  }

  // ── Formulário inline de edição (um por vez, dentro do slot) ─────────────
  function renderEditor() {
    if (!editing) return null;
    const isRecommended = editing.scope === "recommended";
    return (
      <div className="mt-1.5 rounded-lg border border-[var(--th-brand)]/40 bg-[var(--th-bg-base)] p-2 space-y-1.5 shadow-lg shadow-black/40">
        <div className="flex items-center justify-between gap-2">
          <span className={`text-[9px] font-black uppercase tracking-wider ${isRecommended ? "text-amber-300" : "text-sky-300"}`}>
            {isRecommended ? "Editar recomendado (Boss)" : "Editar meu perfil"}
          </span>
          <button type="button" onClick={() => { setEditing(null); setSaveError(""); }} className="text-slate-500 hover:text-slate-300 transition-colors cursor-pointer" title="Cancelar edição">
            <X size={12} />
          </button>
        </div>
        <input
          type="text"
          value={editing.profileName}
          onChange={event => setEditing(prev => prev ? { ...prev, profileName: event.target.value } : prev)}
          maxLength={RTC_PROFILE_NAME_MAX}
          placeholder="Nome do perfil (ex.: Full DPS)"
          className="w-full rounded-md border border-[var(--th-line)] bg-[var(--th-bg-raised)] px-2 py-1 text-[11px] font-bold text-slate-100 placeholder:text-slate-600 outline-none focus:border-[var(--th-brand)]/70"
          autoFocus
        />
        <textarea
          value={editing.code}
          onChange={event => setEditing(prev => prev ? { ...prev, code: event.target.value } : prev)}
          maxLength={RTC_CODE_MAX}
          placeholder="Código RTC (colado exatamente como exportado do jogo)"
          rows={3}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          className="w-full resize-y rounded-md border border-[var(--th-line)] bg-[var(--th-bg-raised)] px-2 py-1 font-mono text-[10px] leading-snug text-slate-200 placeholder:text-slate-600 outline-none focus:border-[var(--th-brand)]/70"
        />
        {saveError && <div className="text-[10px] font-bold text-rose-400">{saveError}</div>}
        <div className="flex items-center justify-between gap-2">
          {!editing.isNew ? (
            <button
              type="button"
              onClick={deleteEditing}
              disabled={saving}
              className="inline-flex items-center gap-1 rounded-md border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-[10px] font-bold text-rose-300 hover:bg-rose-500/20 transition-colors cursor-pointer disabled:opacity-50"
            >
              <Trash2 size={10} /> Excluir
            </button>
          ) : <span />}
          <button
            type="button"
            onClick={saveEditing}
            disabled={saving}
            className="inline-flex items-center gap-1 rounded-md border border-emerald-500/50 bg-emerald-600/20 px-3 py-1 text-[10px] font-black text-emerald-300 hover:bg-emerald-600/35 transition-colors cursor-pointer disabled:opacity-50"
          >
            <Check size={11} /> {saving ? "Salvando..." : "Salvar"}
          </button>
        </div>
      </div>
    );
  }

  // ── Linha da tabela (Acesso ou Boss) de uma divisão ──────────────────────
  // Grade de 3 colunas: rótulo da linha (na cor da vocação) | célula
  // Recomendado | célula Meu Perfil. O editor inline, quando aberto para a
  // combinação desta linha, aparece logo abaixo dela ocupando a largura
  // total da tabela.
  function renderTableRow(divisionId: string, slot: RtcSlotType, isLast: boolean) {
    const key = buildRtcKey(quest, voc, divisionId, slot);
    const isEditingHere = editing?.key === key;
    return (
      <div key={slot} className={isLast && !isEditingHere ? "" : "border-b border-[var(--th-line)]/40"}>
        <div className="grid grid-cols-[44px_1fr_1fr]">
          <div className="flex items-center border-r border-[var(--th-line)]/40 px-1">
            <span className="text-[8px] font-black uppercase tracking-wider" style={{ color: vs.text }}>
              {RTC_SLOT_LABELS[slot]}
            </span>
          </div>
          <div className="border-r border-[var(--th-line)]/40">
            {renderCell("recommended", key, recommended[key])}
          </div>
          <div>
            {renderCell("personal", key, personal[key])}
          </div>
        </div>
        {isEditingHere && <div className="px-1.5 pb-1.5">{renderEditor()}</div>}
      </div>
    );
  }

  return createPortal(
    <div
      className="app-modal-overlay fixed inset-0 z-[1100] flex items-center justify-center bg-black/85 backdrop-blur-sm"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Import RTC"
        className="app-modal-frame app-modal-size-wide app-modal-frame--scroll relative w-full max-w-4xl rounded-2xl border border-[var(--th-line)]/100 bg-[var(--th-bg-base)] shadow-2xl shadow-black/70"
      >
        {/* ── Cabeçalho fixo: título + seletores ─────────────────────────── */}
        <div className="flex-shrink-0 border-b border-[var(--th-line)]/70 bg-gradient-to-r from-[var(--th-bg-raised)] via-[var(--th-bg-base)] to-[var(--th-bg-raised)] px-5 py-3.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2
                className="flex items-center gap-2 text-lg font-black tracking-wide text-cyan-200"
                style={{ textShadow: "0 0 16px color-mix(in oklab, #22d3ee 45%, transparent)" }}
              >
                <FileCode2 size={18} className="flex-shrink-0 text-cyan-300" />
                Import RTC
              </h2>
              <p className="mt-0.5 text-[11px] leading-snug text-slate-400">
                Códigos de importação por Quest, vocação e etapa — <span className="text-amber-300 font-bold">recomendados</span> pelo app e os <span className="text-sky-300 font-bold">seus perfis</span>, sincronizados entre dispositivos.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="flex-shrink-0 rounded-lg border border-[var(--th-line)]/70 bg-[var(--th-bg-raised)] p-1.5 text-slate-400 hover:text-white hover:border-slate-500 transition-colors cursor-pointer"
              title="Fechar (Esc)"
            >
              <X size={16} />
            </button>
          </div>

          {/* Seletores: Quest + Vocação — rótulos em DESTAQUE: cada grupo é
              uma cápsula com borda própria e o nome ("Quest"/"Vocação") vira
              um chip ciano (identidade do título do modal), muito mais
              visível que o texto cinza anterior. Mesma altura de linha —
              o cabeçalho não cresce; seletores/lógica intocados. */}
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
            <div className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-500/25 bg-cyan-500/[0.05] p-1">
              <span className="inline-flex items-center self-stretch rounded-md border border-cyan-400/40 bg-cyan-500/15 px-2 text-[9px] font-black uppercase tracking-widest text-cyan-200 shadow-[0_0_8px_rgba(34,211,238,0.15)]">
                Quest
              </span>
              {(Object.keys(RTC_QUEST_LABELS) as RtcQuest[]).map(q => {
                const active = quest === q;
                const isSw = q === "soulwar";
                // Identidade existente do app: Soul War = slate, Sanguine = rose.
                const activeClass = isSw
                  ? "border-slate-400/60 bg-slate-500/20 text-slate-100 shadow-[0_0_10px_rgba(148,163,184,0.25)]"
                  : "border-rose-500/60 bg-rose-500/20 text-rose-200 shadow-[0_0_10px_rgba(244,63,94,0.3)]";
                return (
                  <button
                    key={q}
                    type="button"
                    onClick={() => { setQuest(q); setEditing(null); setSaveError(""); }}
                    className={`rounded-lg border px-2.5 py-1 text-[11px] font-black tracking-wide transition-all cursor-pointer ${active ? activeClass : "border-[var(--th-line)]/70 bg-[var(--th-bg-raised)] text-slate-500 hover:text-slate-300"}`}
                  >
                    {RTC_QUEST_LABELS[q]}
                  </button>
                );
              })}
            </div>
            <div className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-500/25 bg-cyan-500/[0.05] p-1">
              <span className="inline-flex items-center self-stretch rounded-md border border-cyan-400/40 bg-cyan-500/15 px-2 text-[9px] font-black uppercase tracking-widest text-cyan-200 shadow-[0_0_8px_rgba(34,211,238,0.15)]">
                Vocação
              </span>
              {VOCATIONS.map(v => {
                const active = voc === v;
                const styles = vocStyles(v);
                return (
                  <button
                    key={v}
                    type="button"
                    onClick={() => { setVoc(v); setEditing(null); setSaveError(""); }}
                    className="rounded-lg border px-2.5 py-1 text-[11px] font-black tracking-wide transition-all cursor-pointer"
                    style={active
                      ? { borderColor: styles.border, background: styles.fill, color: styles.text, boxShadow: `0 0 10px ${styles.glow}` }
                      : { borderColor: "var(--th-line)", background: "var(--th-bg-raised)", color: "#64748b" }}
                    title={VOC_LABEL[v]}
                  >
                    {v}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* ── Conteúdo rolável: divisões da combinação selecionada ────────── */}
        <div className="app-modal-body flex-1 overflow-y-auto px-4 py-3">
          {/* Contexto atual — reforço visual da combinação selecionada. */}
          <div className="mb-2.5 flex items-center gap-2 text-[10px] font-bold text-slate-500">
            <span
              className="rounded-md border px-2 py-0.5 font-black"
              style={{ borderColor: vs.border, background: vs.fill, color: vs.text }}
            >
              {RTC_QUEST_LABELS[quest]} · {voc} — {VOC_LABEL[voc]}
            </span>
            <span className="hidden sm:inline">Cada vocação possui códigos próprios e independentes.</span>
          </div>

          {/* Cards de divisão — UMA caixa por divisão contendo a TABELA:
              colunas Recomendado / Meu Perfil, linhas conforme os tipos que a
              divisão realmente possui (rtcDivisionSlots — Last e Bakragore
              não têm "Acesso", então a linha nem é renderizada). COMPACTO:
              3 colunas em telas largas, espaçamentos reduzidos. DESTAQUE:
              borda contínua na cor da vocação + faixa lateral, separando
              claramente cada Boss sem decoração excessiva. */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {divisions.map((division, index) => (
              <div
                key={division.id}
                className="overflow-hidden rounded-lg bg-[var(--th-bg-raised)]/40"
                style={{
                  border: `1px solid ${vs.border}`,
                  borderLeft: `3px solid ${vs.border}`,
                  boxShadow: `0 0 0 1px color-mix(in oklab, ${vs.hue} 12%, transparent), 0 2px 10px rgba(0,0,0,0.35)`,
                }}
              >
                {/* Título da divisão — faixa levemente tingida pela vocação. */}
                <div
                  className="flex items-baseline gap-1 border-b px-2 py-1"
                  style={{ borderColor: vs.border, background: `color-mix(in oklab, ${vs.hue} 8%, var(--th-bg-raised))` }}
                >
                  <span className="font-mono text-[8px] font-black text-slate-500">{index + 1}.</span>
                  <h3 className="truncate text-[11px] font-black uppercase tracking-wider text-slate-100">{division.label}</h3>
                  {division.sublabel && <span className="truncate text-[9px] font-bold text-slate-500">— {division.sublabel}</span>}
                </div>
                {/* Cabeçalho da tabela: coluna vazia (rótulos) + Recomendado + Meu Perfil */}
                <div className="grid grid-cols-[44px_1fr_1fr] border-b border-[var(--th-line)]/40 bg-[var(--th-bg-base)]/40">
                  <div className="border-r border-[var(--th-line)]/40" />
                  <div className="border-r border-[var(--th-line)]/40 px-1 py-0.5 text-center text-[8px] font-black uppercase tracking-wide text-amber-400/90">
                    Recomendado
                  </div>
                  <div className="px-1 py-0.5 text-center text-[8px] font-black uppercase tracking-wide text-sky-400/90">
                    Meu Perfil
                  </div>
                </div>
                {/* Linhas: somente os tipos que a divisão possui. */}
                {rtcDivisionSlots(division).map((slot, slotIndex, slots) =>
                  renderTableRow(division.id, slot, slotIndex === slots.length - 1)
                )}
              </div>
            ))}
          </div>

          {/* Legenda compacta. */}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[var(--th-line)]/40 pt-2 text-[9px] text-slate-600">
            <span><span className="font-black text-amber-400/80">Recomendado</span> — configuração oficial do app{isBoss ? " (você pode editar por ser Boss)" : ""}.</span>
            <span><span className="font-black text-sky-400/80">Meu Perfil</span> — seus perfis, disponíveis em todos os seus dispositivos.</span>
            <span>Botões <span className="font-bold text-slate-400">Importar</span> com a mesma cor indicam códigos idênticos.</span>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
