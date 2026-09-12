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
// Tipo (Acesso/Boss), organizados em DUAS GUIAS exclusivas:
//
//   • RECOMENDADO → doc global `rtcImports/recommended`; todos veem,
//                   só Boss edita (UI + regras do Firestore);
//   • MEU PERFIL  → doc `userRtcImports/{uid}`; perfis do próprio
//                   usuário, sincronizados entre dispositivos.
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
//   • LAYOUT (guias + cards): fluxo Quest → Vocação → guia → Importar. Cada
//     guia mostra SOMENTE a sua categoria, numa GRADE de CARDS por etapa
//     (2 colunas; 1 em telas estreitas). Cada card tem faixa de identidade
//     da vocação (número + nome + apelido + badge x/y de preenchimento) e
//     os SLOTS empilhados com rótulo próprio (Acesso = teal, Boss =
//     violeta) — sem cabeçalho de tabela distante nem colunas vazias nas
//     etapas finais (Last/Bakragore só exibem Boss). Botões "Importar" têm
//     largura fixa (alinhados na vertical dentro de cada coluna). As guias
//     carregam contadores de perfis configurados na combinação atual.
//     Identidades de cor preservadas: âmbar = Recomendado, céu = Meu Perfil,
//     cor da vocação nos cards.
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
  // Guia ativa: cada uma exibe EXCLUSIVAMENTE a sua categoria de códigos.
  const [tab, setTab] = useState<"recommended" | "personal">("recommended");
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

  // Contadores das guias: perfis configurados na combinação Quest+Vocação
  // atual (ex.: "3/11"). Ajudam a saber onde há código sem trocar de guia.
  const slotKeys = useMemo(
    () => divisions.flatMap(d => rtcDivisionSlots(d).map(slot => buildRtcKey(quest, voc, d.id, slot))),
    [divisions, quest, voc],
  );
  const recommendedCount = useMemo(() => slotKeys.filter(k => recommended[k]).length, [slotKeys, recommended]);
  const personalCount = useMemo(() => slotKeys.filter(k => personal[k]).length, [slotKeys, personal]);

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

  // ── SLOT de um tipo (Acesso/Boss) dentro do CARD da divisão ─────────────
  // O escopo vem da GUIA ativa — cada guia mostra só a sua categoria.
  // Cada slot é um bloco autocontido com rótulo próprio ("Acesso"/"Boss"),
  // eliminando a dependência de um cabeçalho de tabela distante: o olho
  // nunca precisa subir para saber o que está lendo. Conteúdo em UMA linha:
  //   ACESSO/BOSS · nome do perfil (truncado)  [✎]  [ Importar — largura FIXA ]
  // A largura fixa do botão mantém TODOS os "Importar" alinhados na
  // vertical. Slot sem perfil: "Adicionar" (quem pode editar) ou marcação
  // discreta (quem não pode).
  function renderSlot(scope: "recommended" | "personal", slot: RtcSlotType, key: string, entry: RtcEntry | undefined) {
    const isRecommended = scope === "recommended";
    const canEdit = isRecommended ? isBoss : true;
    const uniqueKey = `${scope}:${key}`;
    const isCopied = copiedKey === uniqueKey;
    const isAccess = slot === "acesso";

    return (
      <div
        key={slot}
        className="flex min-w-0 items-center gap-1.5 rounded-lg border border-[var(--th-line)]/50 bg-[var(--th-bg-base)]/60 px-2 py-1.5"
      >
        {/* Rótulo do tipo — identidade fixa: Acesso = teal, Boss = violeta.
            Largura fixa para os conteúdos de todos os cards alinharem. */}
        <span
          className={`flex-shrink-0 w-[46px] text-center rounded border px-1 py-px text-[8px] font-black uppercase tracking-widest ${isAccess
            ? "border-teal-500/40 bg-teal-500/10 text-teal-300"
            : "border-violet-500/40 bg-violet-500/10 text-violet-300"}`}
        >
          {RTC_SLOT_LABELS[slot]}
        </span>

        {!entry ? (
          canEdit ? (
            <button
              type="button"
              onClick={() => startEdit(scope, key, undefined)}
              className="inline-flex h-6 min-w-0 flex-1 items-center justify-center gap-1 rounded-md border border-dashed border-[var(--th-line)] text-[9px] font-bold text-slate-500 hover:text-slate-300 hover:border-slate-500/70 transition-colors cursor-pointer"
              title={isRecommended ? "Configurar recomendação (Boss)" : "Adicionar meu perfil"}
            >
              <Plus size={10} /> Adicionar
            </button>
          ) : (
            <span className="inline-flex h-6 min-w-0 flex-1 items-center justify-center rounded-md text-[9px] italic text-slate-600">
              Sem recomendação
            </span>
          )
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate text-[10px] font-bold leading-tight text-slate-200" title={entry.profileName}>
              {entry.profileName}
            </span>
            {canEdit && (
              <button
                type="button"
                onClick={() => startEdit(scope, key, entry)}
                className="flex-shrink-0 inline-flex h-5 w-5 items-center justify-center rounded border border-transparent text-slate-500 hover:text-slate-200 hover:border-[var(--th-line)] transition-colors cursor-pointer"
                title={isRecommended ? "Editar perfil recomendado (Boss)" : "Editar meu perfil"}
              >
                <Pencil size={10} />
              </button>
            )}
            {/* Botão IMPORTAR — copia o código literal (mesma função de
                sempre); identidade visual POR CÓDIGO (mesmo código = mesma
                cor em qualquer lugar). Largura fixa = alinhamento perfeito. */}
            <button
              type="button"
              onClick={() => copyCode(uniqueKey, entry.code)}
              className="flex-shrink-0 inline-flex h-6 w-[86px] items-center justify-center gap-1 rounded-md border text-[9px] font-black tracking-wide transition-all duration-150 cursor-pointer hover:brightness-125 active:scale-95"
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

  // ── CARD de uma DIVISÃO na guia ativa ────────────────────────────────────
  // Cada etapa é um CARD independente numa grade de 2 colunas (1 coluna em
  // telas estreitas): faixa superior com número + nome da etapa na identidade
  // da vocação, e abaixo os SLOTS empilhados (Acesso e/ou Boss), cada um com
  // rótulo próprio. Vantagens sobre a tabela anterior:
  //   • sem cabeçalho distante — cada informação é rotulada onde está;
  //   • etapas finais (só Boss) não carregam coluna vazia com traço;
  //   • a grade 2×N usa melhor o espaço horizontal do modal (cards curtos
  //     lado a lado em vez de linhas compridas e rasas);
  //   • botões "Importar" com largura fixa seguem alinhados dentro de cada
  //     coluna de cards — comparação e localização continuam imediatas.
  // O editor inline abre DENTRO do card da etapa em edição.
  function renderDivisionCard(
    division: (typeof divisions)[number],
    index: number,
    entries: RtcEntryMap,
  ) {
    const slots = rtcDivisionSlots(division);
    const editingHere = editing && slots.some(slot => editing.key === buildRtcKey(quest, voc, division.id, slot));
    const configured = slots.filter(slot => entries[buildRtcKey(quest, voc, division.id, slot)]).length;
    return (
      <div
        key={division.id}
        className="overflow-hidden rounded-xl bg-[var(--th-bg-raised)]/50"
        style={{
          border: `1px solid ${editingHere ? `color-mix(in oklab, ${vs.hue} 60%, transparent)` : vs.border}`,
          boxShadow: editingHere ? `0 0 12px ${vs.glow}` : "0 1px 6px rgba(0,0,0,0.25)",
        }}
      >
        {/* Faixa da etapa — número, nome e (quando houver) apelido, na
            identidade da vocação; badge discreta com o preenchimento. */}
        <div
          className="flex items-center gap-2 border-b px-2.5 py-1.5"
          style={{ borderColor: vs.border, background: `color-mix(in oklab, ${vs.hue} 9%, transparent)` }}
        >
          <span
            className="flex h-4.5 w-4.5 flex-shrink-0 items-center justify-center rounded font-mono text-[9px] font-black"
            style={{ background: `color-mix(in oklab, ${vs.hue} 22%, transparent)`, color: vs.text }}
          >
            {index + 1}
          </span>
          <span className="truncate text-[11px] font-black uppercase tracking-wide" style={{ color: vs.text }}>
            {division.label}
          </span>
          {division.sublabel && (
            <span className="truncate text-[9px] font-bold text-slate-500">· {division.sublabel}</span>
          )}
          <span
            className="ml-auto flex-shrink-0 rounded-full border px-1.5 text-[8px] font-bold"
            style={configured === slots.length
              ? { borderColor: "rgba(16,185,129,0.4)", color: "#34d399" }
              : { borderColor: "var(--th-line)", color: "#64748b" }}
            title={`${configured} de ${slots.length} código(s) configurado(s) nesta etapa`}
          >
            {configured}/{slots.length}
          </span>
        </div>
        {/* Slots da etapa — só os que EXISTEM (Last/Bakragore: apenas Boss). */}
        <div className="space-y-1 p-1.5">
          {slots.map(slot => {
            const key = buildRtcKey(quest, voc, division.id, slot);
            return renderSlot(tab, slot, key, entries[key]);
          })}
          {editingHere && renderEditor()}
        </div>
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
                Selecione a Quest e a vocação, escolha entre <span className="text-amber-300 font-bold">Recomendado</span> e <span className="text-sky-300 font-bold">Meu Perfil</span> e importe o código da etapa desejada.
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

        {/* ── Conteúdo rolável: guias + lista de divisões ─────────────────── */}
        <div className="app-modal-body flex-1 overflow-y-auto px-4 py-3">
          {/* GUIAS "Recomendado" / "Meu Perfil" + contexto da combinação.
              Cada guia exibe EXCLUSIVAMENTE a sua categoria de códigos —
              mesma persistência/permissões de sempre, só muda a exibição.
              Trocar de guia cancela edição aberta (o editor pertence a um
              escopo). Contador = perfis configurados na combinação atual. */}
          <div className="mb-2.5 flex flex-wrap items-end justify-between gap-2 border-b border-[var(--th-line)]/60">
            <div className="flex items-end gap-1">
              {([
                { id: "recommended" as const, label: "Recomendado", count: recommendedCount, activeClass: "border-amber-500/60 bg-amber-500/10 text-amber-300", dotClass: "bg-amber-400" },
                { id: "personal" as const, label: "Meu Perfil", count: personalCount, activeClass: "border-sky-500/60 bg-sky-500/10 text-sky-300", dotClass: "bg-sky-400" },
              ]).map(t => {
                const active = tab === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => { setTab(t.id); setEditing(null); setSaveError(""); }}
                    className={`inline-flex items-center gap-1.5 rounded-t-lg border border-b-0 px-3.5 py-1.5 text-[11px] font-black tracking-wide transition-all cursor-pointer -mb-px ${active
                      ? `${t.activeClass} shadow-[0_-2px_10px_rgba(0,0,0,0.25)]`
                      : "border-transparent text-slate-500 hover:text-slate-300"}`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${active ? t.dotClass : "bg-slate-600"}`} />
                    {t.label}
                    <span className={`rounded-full border px-1.5 text-[9px] font-bold ${active ? "border-current/40 opacity-80" : "border-[var(--th-line)] text-slate-600"}`}>
                      {t.count}/{slotKeys.length}
                    </span>
                  </button>
                );
              })}
            </div>
            {/* Contexto atual — reforço da combinação selecionada. */}
            <span
              className="mb-1 rounded-md border px-2 py-0.5 text-[10px] font-black"
              style={{ borderColor: vs.border, background: vs.fill, color: vs.text }}
            >
              {RTC_QUEST_LABELS[quest]} · {voc} — {VOC_LABEL[voc]}
            </span>
          </div>

          {/* Descrição curta da guia ativa — quem configura o que se vê. */}
          <p className="mb-2 text-[10px] leading-snug text-slate-500">
            {tab === "recommended"
              ? <>Perfis <span className="font-black text-amber-400/90">recomendados pelo app</span> para esta Quest e vocação{isBoss ? " — você pode editá-los por ser Boss" : ", configurados pelo Boss"}.</>
              : <>Seus <span className="font-black text-sky-400/90">perfis pessoais</span> para esta Quest e vocação — sincronizados em todos os seus dispositivos.</>}
          </p>

          {/* GRADE DE CARDS — um card por etapa, 2 colunas (1 em telas
              estreitas), na ordem da Quest. Cada card carrega a própria
              identificação e os slots rotulados — nada depende de cabeçalho
              de tabela ou de colunas vazias. */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {divisions.map((division, index) =>
              renderDivisionCard(division, index, tab === "recommended" ? recommended : personal)
            )}
          </div>

          {/* Legenda compacta. */}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[var(--th-line)]/40 pt-2 text-[9px] text-slate-600">
            <span><span className="font-black text-violet-300/80">{RTC_SLOT_LABELS.boss}</span> é o chefe da etapa; <span className="font-black text-teal-300/80">{RTC_SLOT_LABELS.acesso}</span> é o código de acesso, quando a etapa possui um.</span>
            <span>Botões <span className="font-bold text-slate-400">Importar</span> com a mesma cor indicam códigos idênticos.</span>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
