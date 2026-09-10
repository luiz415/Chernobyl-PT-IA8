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
  RTC_SLOT_TYPES,
  buildRtcKey,
  rtcCodeHue,
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
//   • LAYOUT DOS CARDS: uma caixa por divisão; dentro, só tipografia e
//     alinhamento em colunas (rótulo fixo | nome flexível | ações à
//     direita), com "Recomendado" e "Meu perfil" empilhados e tabulados
//     para comparação imediata — sem caixas aninhadas.
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

  // ── Linha de um perfil (recomendado OU pessoal) dentro de uma seção ──────
  // Layout em colunas alinhadas para leitura rápida e comparação direta
  // entre "Recomendado" e "Meu perfil":
  //
  //   [rótulo fixo]  [nome do perfil ................]  [✎] [Importar]
  //
  // O rótulo tem largura fixa (as linhas ficam tabuladas), o nome ocupa o
  // espaço restante e as ações ficam SEMPRE à direita — os botões
  // "Importar" das duas linhas se alinham verticalmente. Sem pills nem
  // caixas: só texto colorido (âmbar = recomendado, azul = pessoal).
  function renderProfileRow(scope: "recommended" | "personal", key: string, entry: RtcEntry | undefined) {
    const isRecommended = scope === "recommended";
    const canEdit = isRecommended ? isBoss : true;
    const uniqueKey = `${scope}:${key}`;
    const isCopied = copiedKey === uniqueKey;
    const rowLabel = isRecommended ? "Recomendado" : "Meu perfil";
    const labelClass = isRecommended ? "text-amber-400/90" : "text-sky-400/90";

    return (
      <div className="flex h-7 items-center gap-2 min-w-0">
        <span className={`w-[84px] flex-shrink-0 text-[9px] font-black uppercase tracking-wide ${labelClass}`}>
          {rowLabel}
        </span>
        {entry ? (
          <>
            <span className="min-w-0 flex-1 truncate text-[11px] font-bold text-slate-200" title={entry.profileName}>
              {entry.profileName}
            </span>
            {canEdit && (
              <button
                type="button"
                onClick={() => startEdit(scope, key, entry)}
                className="flex-shrink-0 inline-flex h-6 w-6 items-center justify-center rounded-md border border-transparent text-slate-500 hover:text-slate-200 hover:border-[var(--th-line)] transition-colors cursor-pointer"
                title={isRecommended ? "Editar perfil recomendado (Boss)" : "Editar meu perfil"}
              >
                <Pencil size={11} />
              </button>
            )}
            {/* Botão IMPORTAR — copia o código literal (mesma função de
                sempre); identidade visual POR CÓDIGO (mesmo código = mesma
                cor de botão em qualquer lugar do modal). */}
            <button
              type="button"
              onClick={() => copyCode(uniqueKey, entry.code)}
              className="flex-shrink-0 inline-flex h-6 w-[86px] items-center justify-center gap-1 rounded-md border text-[10px] font-black tracking-wide transition-all duration-150 cursor-pointer hover:brightness-125 active:scale-95"
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
                ? <><Check size={11} strokeWidth={3} /> Copiado</>
                : <><Copy size={10} strokeWidth={2.5} /> Importar</>}
            </button>
          </>
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate text-[10px] italic text-slate-600">
              {isRecommended ? "Sem recomendação" : "Não configurado"}
            </span>
            {canEdit && (
              <button
                type="button"
                onClick={() => startEdit(scope, key, undefined)}
                className="flex-shrink-0 inline-flex h-6 w-[86px] items-center justify-center gap-1 rounded-md border border-dashed border-[var(--th-line)] text-[9px] font-bold text-slate-500 hover:text-slate-300 hover:border-slate-500/70 transition-colors cursor-pointer"
                title={isRecommended ? "Configurar recomendação (Boss)" : "Adicionar meu perfil"}
              >
                <Plus size={10} /> Adicionar
              </button>
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

  // ── Seção (Acesso ou Boss) de uma divisão ────────────────────────────────
  // Sem caixa própria: apenas o título da seção (na cor da vocação) seguido
  // das duas linhas tabuladas (Recomendado / Meu perfil). A hierarquia fica
  // por tipografia e alinhamento, não por bordas aninhadas.
  function renderSlot(divisionId: string, slot: RtcSlotType) {
    const key = buildRtcKey(quest, voc, divisionId, slot);
    const isEditingHere = editing?.key === key;
    return (
      <div key={slot} className="min-w-0">
        <div className="mb-0.5 flex items-center gap-1.5">
          <span className="text-[9px] font-black uppercase tracking-widest" style={{ color: vs.text }}>
            {RTC_SLOT_LABELS[slot]}
          </span>
          <span className="h-px flex-1" style={{ background: `color-mix(in oklab, ${vs.hue} 22%, transparent)` }} />
        </div>
        {renderProfileRow("recommended", key, recommended[key])}
        {renderProfileRow("personal", key, personal[key])}
        {isEditingHere && renderEditor()}
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

          {/* Seletores: Quest + Vocação */}
          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
            <div className="flex items-center gap-1.5">
              <span className="text-[9px] font-black uppercase tracking-widest text-slate-500">Quest</span>
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
            <div className="flex items-center gap-1.5">
              <span className="text-[9px] font-black uppercase tracking-widest text-slate-500">Vocação</span>
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

          {/* Cards de divisão — UMA caixa por divisão; dentro dela apenas
              tipografia e alinhamento (nenhuma caixa aninhada). Hierarquia:
              Divisão → Acesso/Boss → Recomendado/Meu perfil → Importar. */}
          <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
            {divisions.map((division, index) => (
              <div
                key={division.id}
                className="rounded-xl border border-[var(--th-line)]/70 bg-[var(--th-bg-raised)]/40 px-3 py-2"
                style={{ borderLeft: `3px solid ${vs.border}` }}
              >
                <div className="flex items-baseline gap-1.5 border-b border-[var(--th-line)]/50 pb-1">
                  <span className="font-mono text-[9px] font-black text-slate-600">{index + 1}.</span>
                  <h3 className="text-[12px] font-black uppercase tracking-wider text-slate-100">{division.label}</h3>
                  {division.sublabel && <span className="text-[10px] font-bold text-slate-500">— {division.sublabel}</span>}
                </div>
                <div className="mt-1.5 space-y-2">
                  {RTC_SLOT_TYPES.map(slot => renderSlot(division.id, slot))}
                </div>
              </div>
            ))}
          </div>

          {/* Legenda compacta. */}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[var(--th-line)]/40 pt-2 text-[9px] text-slate-600">
            <span><span className="font-black text-amber-400/80">Recomendado</span> — configuração oficial do app{isBoss ? " (você pode editar por ser Boss)" : ""}.</span>
            <span><span className="font-black text-sky-400/80">Meu perfil</span> — seus perfis, disponíveis em todos os seus dispositivos.</span>
            <span>Botões <span className="font-bold text-slate-400">Importar</span> com a mesma cor indicam códigos idênticos.</span>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
