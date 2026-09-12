import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Copy, FileCode2, Library, Pencil, Plus, Trash2, X } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { VOCATIONS, VOC_COLORS, VOC_LABEL, customConfirm, type Vocation } from "../types";
import {
  RTC_CODE_HUES,
  RTC_CODE_MAX,
  RTC_DIVISIONS,
  RTC_MAX_PROFILES,
  RTC_PROFILE_NAME_MAX,
  RTC_QUEST_LABELS,
  RTC_SLOT_LABELS,
  buildRtcCombinationView,
  buildRtcKey,
  buildRtcProfileKey,
  newRtcProfileId,
  nextRtcColorIndex,
  rtcDivisionSlots,
  type RtcEntry,
  type RtcEntryMap,
  type RtcProfile,
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
// MODAL "IMPORT RTC" — perfis como FONTE ÚNICA ("Códigos Usados")
// ----------------------------------------------------------------------------
// Gerenciamento e importação de códigos RTC por Quest + Vocação, em DUAS
// GUIAS exclusivas:
//
//   • RECOMENDADO → doc global `rtcImports/recommended`; todos veem,
//                   só Boss edita (UI + regras do Firestore);
//   • MEU PERFIL  → doc `userRtcImports/{uid}`; perfis do próprio
//                   usuário, sincronizados entre dispositivos.
//
// NOVA ARQUITETURA DOS DADOS (por guia + Quest + Vocação):
//
//   ┌─ CÓDIGOS USADOS (card fixo) ──────────────────────────────┐
//   │  até 10 perfis: nome + código RTC + cor de identidade     │
//   └───────────────────────────────────────────────────────────┘
//                 ▲ fonte única dos códigos
//   ┌─ CARDS DOS BOSSES ────────────────────────────────────────┐
//   │  cada slot (Acesso/Boss) apenas SELECIONA um perfil       │
//   │  cadastrado acima; Importar copia o código do perfil      │
//   └───────────────────────────────────────────────────────────┘
//
//   • Perfis: chave "profile|quest|voc|id" no MESMO mapa `entries` dos
//     documentos existentes → persistência, permissões e custo intocados.
//   • Seleções: a chave de slot existente ("quest|voc|divisão|tipo") agora
//     guarda só { profileId } — editar o perfil reflete em TODOS os usos.
//   • LEGADO: slots antigos com código inline continuam visíveis/importáveis
//     (perfil "virtual"); regravar converge ao formato novo.
//   • CORES: cada perfil recebe um `colorIndex` persistido na criação
//     (primeira cor livre da paleta RTC_CODE_HUES) → o MESMO perfil tem a
//     MESMA cor em todos os usos, dispositivos e sessões.
//
// Decisões que importam:
//   • PORTAL em document.body — o app vive num container com CSS `zoom` que
//     quebra hit-testing de `position: fixed` (mesmo motivo do
//     ImbuementsModal/ConfirmModal).
//   • Listeners assinados SÓ com o modal aberto: 1 leitura por doc + deltas.
//   • Cores de vocação: exclusivamente `VOC_COLORS` (identidade oficial).
//   • CÓDIGO LITERAL: textarea sem transformação; o botão "Importar" copia
//     o valor armazenado byte a byte (mesma função de sempre).
//   • Esc fecha (mas primeiro cancela edição/seleção aberta, se houver).
// ============================================================================

interface Props {
  open: boolean;
  onClose: () => void;
}

/** Edição de um PERFIL do card "Códigos Usados" (uma por vez). */
interface ProfileEditingState {
  /** null = criação de perfil novo. */
  profileId: string | null;
  profileName: string;
  code: string;
  colorIndex: number;
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

/** Estilos de identidade de um perfil (cor persistida no colorIndex). */
function profileStyles(colorIndex: number) {
  const hue = RTC_CODE_HUES[colorIndex % RTC_CODE_HUES.length];
  return {
    hue,
    text: `color-mix(in oklab, ${hue} 80%, white)`,
    border: `color-mix(in oklab, ${hue} 55%, transparent)`,
    fill: `color-mix(in oklab, ${hue} 15%, transparent)`,
    glow: `color-mix(in oklab, ${hue} 25%, transparent)`,
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
  // Edição de perfil no card "Códigos Usados" (uma por vez).
  const [profileEditing, setProfileEditing] = useState<ProfileEditingState | null>(null);
  // Slot de Boss com o seletor de perfil aberto (chave da seleção).
  const [pickerKey, setPickerKey] = useState<string>("");
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

  // Esc: primeiro fecha edição/seletor aberto; sem nada aberto, fecha o modal.
  useEffect(() => {
    if (!open) return;
    function handleKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      let consumed = false;
      setProfileEditing(prev => {
        if (prev) consumed = true;
        return null;
      });
      setPickerKey(prev => {
        if (prev) consumed = true;
        return "";
      });
      if (!consumed) onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  // Estado transitório zerado ao fechar.
  useEffect(() => {
    if (open) return;
    setProfileEditing(null);
    setPickerKey("");
    setCopiedKey("");
    setSaveError("");
  }, [open]);

  const divisions = RTC_DIVISIONS[quest];
  const vs = useMemo(() => vocStyles(voc), [voc]);

  // Mapa da guia ativa + visão consolidada da combinação (perfis + seleções,
  // com absorção do legado). Recalculada a cada mudança de dado/combinação.
  const activeEntries = tab === "recommended" ? recommended : personal;
  const view = useMemo(
    () => buildRtcCombinationView(activeEntries, quest, voc),
    [activeEntries, quest, voc],
  );
  const canEditActive = tab === "recommended" ? isBoss : true;
  const profilesFull = view.profiles.length >= RTC_MAX_PROFILES;

  // Contadores das guias: slots com perfil selecionado na combinação atual.
  const slotKeys = useMemo(
    () => divisions.flatMap(d => rtcDivisionSlots(d).map(slot => buildRtcKey(quest, voc, d.id, slot))),
    [divisions, quest, voc],
  );
  const recommendedView = useMemo(() => buildRtcCombinationView(recommended, quest, voc), [recommended, quest, voc]);
  const personalView = useMemo(() => buildRtcCombinationView(personal, quest, voc), [personal, quest, voc]);
  const recommendedCount = useMemo(() => slotKeys.filter(k => recommendedView.selections[k]).length, [slotKeys, recommendedView]);
  const personalCount = useMemo(() => slotKeys.filter(k => personalView.selections[k]).length, [slotKeys, personalView]);

  function resetTransient() {
    setProfileEditing(null);
    setPickerKey("");
    setSaveError("");
  }

  async function copyCode(uniqueKey: string, code: string) {
    try {
      // Texto LITERAL: exatamente o que está armazenado.
      await navigator.clipboard.writeText(code);
      setCopiedKey(uniqueKey);
      window.setTimeout(() => setCopiedKey(prev => (prev === uniqueKey ? "" : prev)), 1600);
    } catch {}
  }

  /** Grava UMA entrada (perfil ou seleção) no escopo da guia ativa. */
  async function persistEntry(key: string, entry: RtcEntry | null): Promise<boolean> {
    return tab === "recommended"
      ? await saveRecommendedRtcEntry(key, entry)
      : await savePersonalRtcEntry(uid, key, entry, personal);
  }

  /** Reflete a escrita no estado local (modo simulação não tem listener). */
  function reflectLocally(key: string, entry: RtcEntry | null) {
    const apply = (prev: RtcEntryMap) => {
      const next = { ...prev };
      if (entry) next[key] = entry; else delete next[key];
      return next;
    };
    if (tab === "personal") setPersonal(apply);
    else setRecommended(apply);
  }

  // ── CÓDIGOS USADOS: salvar/excluir perfil ────────────────────────────────
  async function saveProfileEditing() {
    if (!profileEditing || saving) return;
    const profileName = profileEditing.profileName.trim().slice(0, RTC_PROFILE_NAME_MAX);
    // Código NÃO recebe trim — espaços podem ser parte legítima do conteúdo.
    const code = profileEditing.code.slice(0, RTC_CODE_MAX);
    if (!profileName || !code) {
      setSaveError("Informe o nome do perfil e o código RTC.");
      return;
    }
    const isNew = !profileEditing.profileId;
    if (isNew && profilesFull) {
      setSaveError(`Limite de ${RTC_MAX_PROFILES} perfis atingido nesta combinação.`);
      return;
    }
    const profileId = profileEditing.profileId || newRtcProfileId();
    const key = buildRtcProfileKey(quest, voc, profileId);
    const entry: RtcEntry = {
      profileName,
      code,
      colorIndex: profileEditing.colorIndex,
      updatedAtMs: isNew ? Date.now() : (view.profiles.find(p => p.id === profileId)?.updatedAtMs || Date.now()),
    };
    setSaving(true);
    const ok = await persistEntry(key, entry);
    setSaving(false);
    if (!ok) {
      setSaveError("Não foi possível salvar. Verifique sua conexão e permissões.");
      return;
    }
    reflectLocally(key, entry);
    setProfileEditing(null);
    setSaveError("");
  }

  function deleteProfileEditing() {
    if (!profileEditing?.profileId || saving) return;
    const profileId = profileEditing.profileId;
    // Usos do perfil nos Bosses — o aviso deixa claro que serão limpos junto.
    const usedIn = slotKeys.filter(k => activeEntries[k]?.profileId === profileId);
    // `customConfirm` do app é callback-based (dialog global) — o trabalho
    // real acontece dentro do onConfirm.
    customConfirm(
      usedIn.length > 0
        ? `Excluir este perfil de "Códigos Usados"? Ele está selecionado em ${usedIn.length} local(is), que ficará(ão) sem perfil.`
        : "Excluir este perfil de \"Códigos Usados\"?",
      () => { void performProfileDelete(profileId, usedIn); },
      "Excluir perfil",
    );
  }

  async function performProfileDelete(profileId: string, usedIn: string[]) {
    setSaving(true);
    // Remove o perfil e TODAS as seleções que o referenciam (nunca deixar
    // seleção apontando para perfil inexistente).
    let ok = await persistEntry(buildRtcProfileKey(quest, voc, profileId), null);
    for (const key of usedIn) {
      if (!ok) break;
      ok = await persistEntry(key, null);
    }
    setSaving(false);
    if (!ok) {
      setSaveError("Não foi possível excluir. Verifique sua conexão e permissões.");
      return;
    }
    reflectLocally(buildRtcProfileKey(quest, voc, profileId), null);
    usedIn.forEach(key => reflectLocally(key, null));
    setProfileEditing(null);
    setSaveError("");
  }

  // ── BOSSES: selecionar/limpar perfil de um slot ──────────────────────────
  async function selectProfileForSlot(key: string, profileId: string | null) {
    if (saving) return;
    const entry: RtcEntry | null = profileId ? { profileId, updatedAtMs: Date.now() } : null;
    setSaving(true);
    const ok = await persistEntry(key, entry);
    setSaving(false);
    if (!ok) {
      setSaveError("Não foi possível salvar a seleção. Verifique sua conexão e permissões.");
      return;
    }
    reflectLocally(key, entry);
    setPickerKey("");
    setSaveError("");
  }

  if (!open) return null;

  // ── Chip de identidade de um perfil (nome + cor persistida) ─────────────
  function renderProfileChip(profile: RtcProfile, compact = false) {
    const ps = profileStyles(profile.colorIndex);
    return (
      <span
        className={`inline-flex min-w-0 items-center gap-1 rounded-md border font-bold ${compact ? "px-1.5 py-px text-[9px]" : "px-2 py-0.5 text-[10px]"}`}
        style={{ borderColor: ps.border, background: ps.fill, color: ps.text }}
        title={profile.profileName}
      >
        <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full" style={{ background: ps.hue }} />
        <span className="truncate">{profile.profileName}</span>
      </span>
    );
  }

  // ── Botão IMPORTAR — cor de identidade do PERFIL selecionado ────────────
  function renderImportButton(uniqueKey: string, profile: RtcProfile) {
    const isCopied = copiedKey === uniqueKey;
    const ps = profileStyles(profile.colorIndex);
    return (
      <button
        type="button"
        onClick={() => copyCode(uniqueKey, profile.code)}
        className="flex-shrink-0 inline-flex h-6 w-[86px] items-center justify-center gap-1 rounded-md border text-[9px] font-black tracking-wide transition-all duration-150 cursor-pointer hover:brightness-125 active:scale-95"
        style={isCopied
          ? { borderColor: "rgba(16,185,129,0.6)", background: "rgba(16,185,129,0.18)", color: "#6ee7b7" }
          : { borderColor: ps.border, background: ps.fill, color: ps.text, boxShadow: `0 0 8px ${ps.glow}` }}
        title={isCopied ? "Código copiado!" : `Importar (copiar) o código do perfil "${profile.profileName}"`}
      >
        {isCopied
          ? <><Check size={10} strokeWidth={3} /> Copiado</>
          : <><Copy size={9} strokeWidth={2.5} /> Importar</>}
      </button>
    );
  }

  // ── Editor de perfil do card "Códigos Usados" (inline, um por vez) ──────
  function renderProfileEditor() {
    if (!profileEditing) return null;
    const isRecommended = tab === "recommended";
    const ps = profileStyles(profileEditing.colorIndex);
    return (
      <div
        className="rounded-lg border bg-[var(--th-bg-base)] p-2 space-y-1.5 shadow-lg shadow-black/40"
        style={{ borderColor: ps.border }}
      >
        <div className="flex items-center justify-between gap-2">
          <span className={`inline-flex items-center gap-1.5 text-[9px] font-black uppercase tracking-wider ${isRecommended ? "text-amber-300" : "text-sky-300"}`}>
            <span className="h-2 w-2 rounded-full" style={{ background: ps.hue }} />
            {profileEditing.profileId ? "Editar perfil" : "Novo perfil"}{isRecommended ? " (Boss)" : ""}
          </span>
          <button type="button" onClick={() => { setProfileEditing(null); setSaveError(""); }} className="text-slate-500 hover:text-slate-300 transition-colors cursor-pointer" title="Cancelar edição">
            <X size={12} />
          </button>
        </div>
        <input
          type="text"
          value={profileEditing.profileName}
          onChange={event => setProfileEditing(prev => prev ? { ...prev, profileName: event.target.value } : prev)}
          maxLength={RTC_PROFILE_NAME_MAX}
          placeholder="Nome do perfil (ex.: Full DPS)"
          className="w-full rounded-md border border-[var(--th-line)] bg-[var(--th-bg-raised)] px-2 py-1 text-[11px] font-bold text-slate-100 placeholder:text-slate-600 outline-none focus:border-[var(--th-brand)]/70"
          autoFocus
        />
        <textarea
          value={profileEditing.code}
          onChange={event => setProfileEditing(prev => prev ? { ...prev, code: event.target.value } : prev)}
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
          {profileEditing.profileId ? (
            <button
              type="button"
              onClick={deleteProfileEditing}
              disabled={saving}
              className="inline-flex items-center gap-1 rounded-md border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-[10px] font-bold text-rose-300 hover:bg-rose-500/20 transition-colors cursor-pointer disabled:opacity-50"
            >
              <Trash2 size={10} /> Excluir
            </button>
          ) : <span />}
          <button
            type="button"
            onClick={saveProfileEditing}
            disabled={saving}
            className="inline-flex items-center gap-1 rounded-md border border-emerald-500/50 bg-emerald-600/20 px-3 py-1 text-[10px] font-black text-emerald-300 hover:bg-emerald-600/35 transition-colors cursor-pointer disabled:opacity-50"
          >
            <Check size={11} /> {saving ? "Salvando..." : "Salvar"}
          </button>
        </div>
      </div>
    );
  }

  // ── CARD FIXO "CÓDIGOS USADOS" — fonte única dos perfis da combinação ───
  // Sempre visível no topo da guia. Lista compacta: chip colorido do perfil +
  // prévia do código + editar. "Adicionar perfil" respeita o limite de 10
  // (desabilitado com aviso claro ao atingir).
  function renderCodesUsedCard() {
    const isRecommended = tab === "recommended";
    const accent = isRecommended ? "#f59e0b" : "#38bdf8";
    return (
      <div
        className="mb-3 overflow-hidden rounded-xl border bg-[var(--th-bg-raised)]/60"
        style={{ borderColor: `color-mix(in oklab, ${accent} 40%, transparent)`, boxShadow: `0 0 14px color-mix(in oklab, ${accent} 10%, transparent)` }}
      >
        <div
          className="flex flex-wrap items-center gap-2 border-b px-3 py-2"
          style={{ borderColor: `color-mix(in oklab, ${accent} 30%, transparent)`, background: `color-mix(in oklab, ${accent} 8%, transparent)` }}
        >
          <Library size={13} style={{ color: accent }} className="flex-shrink-0" />
          <span className="text-[11px] font-black uppercase tracking-widest" style={{ color: `color-mix(in oklab, ${accent} 85%, white)` }}>
            Códigos Usados
          </span>
          <span className="rounded-full border border-[var(--th-line)] px-1.5 text-[9px] font-bold text-slate-500" title={`${view.profiles.length} de ${RTC_MAX_PROFILES} perfis cadastrados`}>
            {view.profiles.length}/{RTC_MAX_PROFILES}
          </span>
          <span className="hidden text-[9px] text-slate-500 sm:inline">
            — perfis desta combinação; selecione-os nos cards abaixo.
          </span>
          {canEditActive && (
            profilesFull ? (
              <span className="ml-auto rounded-md border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 text-[9px] font-black uppercase tracking-wide text-rose-300">
                Limite de {RTC_MAX_PROFILES} atingido
              </span>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setSaveError("");
                  setPickerKey("");
                  setProfileEditing({ profileId: null, profileName: "", code: "", colorIndex: nextRtcColorIndex(view.profiles) });
                }}
                className="ml-auto inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-black transition-all cursor-pointer hover:brightness-125"
                style={{ borderColor: `color-mix(in oklab, ${accent} 50%, transparent)`, background: `color-mix(in oklab, ${accent} 14%, transparent)`, color: `color-mix(in oklab, ${accent} 85%, white)` }}
              >
                <Plus size={11} /> Adicionar perfil
              </button>
            )
          )}
        </div>
        <div className="space-y-1 p-2">
          {view.profiles.length === 0 && !profileEditing && (
            <p className="px-1 py-1.5 text-[10px] italic text-slate-500">
              {canEditActive
                ? "Nenhum perfil cadastrado. Adicione um perfil (nome + código RTC) para poder selecioná-lo nos Bosses abaixo."
                : "Nenhum perfil recomendado cadastrado pelo Boss para esta combinação."}
            </p>
          )}
          {view.profiles.map(profile => {
            const ps = profileStyles(profile.colorIndex);
            const usedCount = slotKeys.filter(k => view.selections[k]?.id === profile.id).length;
            const uniqueKey = `${tab}:profile:${profile.id}`;
            if (profileEditing?.profileId === profile.id) {
              return <div key={profile.id}>{renderProfileEditor()}</div>;
            }
            return (
              <div
                key={profile.id}
                className="flex min-w-0 items-center gap-1.5 rounded-lg border border-[var(--th-line)]/50 bg-[var(--th-bg-base)]/60 px-2 py-1"
                style={{ borderLeft: `3px solid ${ps.hue}` }}
              >
                {renderProfileChip(profile)}
                <span className="min-w-0 flex-1 truncate font-mono text-[9px] text-slate-500" title="Prévia do código (armazenado na íntegra)">
                  {profile.code}
                </span>
                {usedCount > 0 && (
                  <span className="flex-shrink-0 rounded-full border border-[var(--th-line)] px-1.5 text-[8px] font-bold text-slate-500" title={`Selecionado em ${usedCount} local(is)`}>
                    {usedCount} uso{usedCount > 1 ? "s" : ""}
                  </span>
                )}
                {canEditActive && (
                  <button
                    type="button"
                    onClick={() => {
                      setSaveError("");
                      setPickerKey("");
                      setProfileEditing({ profileId: profile.id, profileName: profile.profileName, code: profile.code, colorIndex: profile.colorIndex });
                    }}
                    className="flex-shrink-0 inline-flex h-5 w-5 items-center justify-center rounded border border-transparent text-slate-500 hover:text-slate-200 hover:border-[var(--th-line)] transition-colors cursor-pointer"
                    title="Editar perfil"
                  >
                    <Pencil size={10} />
                  </button>
                )}
                {renderImportButton(uniqueKey, profile)}
              </div>
            );
          })}
          {profileEditing && !profileEditing.profileId && renderProfileEditor()}
        </div>
      </div>
    );
  }

  // ── SLOT de um tipo (Acesso/Boss) dentro do CARD da divisão ─────────────
  // O slot apenas SELECIONA um perfil de "Códigos Usados" (fonte única).
  // Conteúdo em UMA linha: rótulo do tipo · chip do perfil selecionado ·
  // seletor · Importar (cor de identidade do perfil, largura fixa).
  function renderSlot(slot: RtcSlotType, key: string, selected: RtcProfile | undefined) {
    const uniqueKey = `${tab}:${key}`;
    const isAccess = slot === "acesso";
    const isLegacy = !!selected && selected.id.startsWith("legacy|");
    const pickerOpen = pickerKey === key;
    const hasProfiles = view.profiles.length > 0;

    return (
      <div key={slot} className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5 rounded-lg border border-[var(--th-line)]/50 bg-[var(--th-bg-base)]/60 px-2 py-1.5">
          {/* Rótulo do tipo — identidade fixa: Acesso = teal, Boss = violeta.
              Largura fixa para os conteúdos de todos os cards alinharem. */}
          <span
            className={`flex-shrink-0 w-[46px] text-center rounded border px-1 py-px text-[8px] font-black uppercase tracking-widest ${isAccess
              ? "border-teal-500/40 bg-teal-500/10 text-teal-300"
              : "border-violet-500/40 bg-violet-500/10 text-violet-300"}`}
          >
            {RTC_SLOT_LABELS[slot]}
          </span>

          {/* Seleção atual (chip na cor do perfil) OU convite a selecionar. */}
          {canEditActive ? (
            <button
              type="button"
              onClick={() => {
                setSaveError("");
                setProfileEditing(null);
                setPickerKey(prev => (prev === key ? "" : key));
              }}
              className={`flex min-w-0 flex-1 items-center gap-1 rounded-md border px-1.5 py-0.5 text-left transition-colors cursor-pointer ${pickerOpen
                ? "border-[var(--th-brand)]/60 bg-[var(--th-bg-raised)]"
                : "border-transparent hover:border-[var(--th-line)] hover:bg-[var(--th-bg-raised)]/60"}`}
              title={selected ? `Perfil selecionado: ${selected.profileName} — clique para trocar` : "Selecionar um perfil de Códigos Usados"}
            >
              {selected ? (
                <>{renderProfileChip(selected, true)}{isLegacy && (
                  <span className="flex-shrink-0 rounded border border-[var(--th-line)] px-1 text-[8px] font-bold text-slate-500" title="Código do formato anterior — regrave escolhendo um perfil de Códigos Usados">
                    antigo
                  </span>
                )}</>
              ) : (
                <span className="truncate text-[9px] italic text-slate-500">
                  {hasProfiles ? "Selecionar perfil..." : "Cadastre um perfil em Códigos Usados"}
                </span>
              )}
              <ChevronDown size={10} className={`ml-auto flex-shrink-0 text-slate-500 transition-transform ${pickerOpen ? "rotate-180" : ""}`} />
            </button>
          ) : (
            <span className="flex min-w-0 flex-1 items-center gap-1 px-1.5 py-0.5">
              {selected
                ? renderProfileChip(selected, true)
                : <span className="truncate text-[9px] italic text-slate-600">Sem recomendação</span>}
            </span>
          )}

          {selected && renderImportButton(uniqueKey, selected)}
        </div>

        {/* Seletor de perfis — lista SOMENTE os perfis existentes em
            "Códigos Usados" (fonte única; impossível escolher inexistente). */}
        {pickerOpen && canEditActive && (
          <div className="mt-1 space-y-0.5 rounded-lg border border-[var(--th-brand)]/40 bg-[var(--th-bg-base)] p-1.5 shadow-lg shadow-black/40">
            {!hasProfiles ? (
              <p className="px-1 py-0.5 text-[9px] italic text-slate-500">
                Nenhum perfil disponível — cadastre em "Códigos Usados" acima.
              </p>
            ) : (
              view.profiles.map(profile => {
                const isCurrent = selected?.id === profile.id;
                const ps = profileStyles(profile.colorIndex);
                return (
                  <button
                    key={profile.id}
                    type="button"
                    disabled={saving}
                    onClick={() => { void selectProfileForSlot(key, profile.id); }}
                    className={`flex w-full min-w-0 items-center gap-1.5 rounded-md border px-1.5 py-1 text-left transition-colors cursor-pointer disabled:opacity-50 ${isCurrent
                      ? "border-emerald-500/50 bg-emerald-500/10"
                      : "border-transparent hover:bg-[var(--th-bg-raised)]"}`}
                  >
                    <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ background: ps.hue }} />
                    <span className="min-w-0 flex-1 truncate text-[10px] font-bold" style={{ color: ps.text }}>
                      {profile.profileName}
                    </span>
                    {isCurrent && <Check size={10} className="flex-shrink-0 text-emerald-400" />}
                  </button>
                );
              })
            )}
            {selected && !isLegacy && (
              <button
                type="button"
                disabled={saving}
                onClick={() => { void selectProfileForSlot(key, null); }}
                className="flex w-full items-center gap-1.5 rounded-md border border-transparent px-1.5 py-1 text-left text-[9px] font-bold text-slate-500 hover:text-rose-300 hover:bg-rose-500/5 transition-colors cursor-pointer disabled:opacity-50"
              >
                <X size={10} /> Remover seleção
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  // ── CARD de uma DIVISÃO (Boss) na guia ativa ─────────────────────────────
  // Grade 2×N de cards por etapa: faixa superior com número + nome na
  // identidade da vocação + badge x/y, e os SLOTS empilhados (Acesso/Boss).
  function renderDivisionCard(
    division: (typeof divisions)[number],
    index: number,
  ) {
    const slots = rtcDivisionSlots(division);
    const pickerHere = pickerKey && slots.some(slot => pickerKey === buildRtcKey(quest, voc, division.id, slot));
    const configured = slots.filter(slot => view.selections[buildRtcKey(quest, voc, division.id, slot)]).length;
    return (
      <div
        key={division.id}
        className="overflow-hidden rounded-xl bg-[var(--th-bg-raised)]/50"
        style={{
          border: `1px solid ${pickerHere ? `color-mix(in oklab, ${vs.hue} 60%, transparent)` : vs.border}`,
          boxShadow: pickerHere ? `0 0 12px ${vs.glow}` : "0 1px 6px rgba(0,0,0,0.25)",
        }}
      >
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
            title={`${configured} de ${slots.length} código(s) selecionado(s) nesta etapa`}
          >
            {configured}/{slots.length}
          </span>
        </div>
        {/* Slots da etapa — só os que EXISTEM (Last/Bakragore: apenas Boss). */}
        <div className="space-y-1 p-1.5">
          {slots.map(slot => {
            const key = buildRtcKey(quest, voc, division.id, slot);
            return renderSlot(slot, key, view.selections[key]);
          })}
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
                Cadastre os perfis em <span className="font-bold text-slate-300">Códigos Usados</span>, selecione-os nos Bosses e use <span className="font-bold text-slate-300">Importar</span> para copiar o código.
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

          {/* Seletores: Quest + Vocação — cápsulas com rótulo em chip ciano
              (identidade do título). Trocar seleção limpa estado transitório. */}
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
                    onClick={() => { setQuest(q); resetTransient(); }}
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
                    onClick={() => { setVoc(v); resetTransient(); }}
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

        {/* ── Conteúdo rolável: guias + Códigos Usados + cards dos Bosses ── */}
        <div className="app-modal-body flex-1 overflow-y-auto px-4 py-3">
          {/* GUIAS "Recomendado" / "Meu Perfil" + contexto da combinação.
              Cada guia exibe EXCLUSIVAMENTE a sua categoria — perfis e
              seleções de uma não interferem na outra. Trocar de guia limpa
              edição/seletor abertos. Contador = slots com perfil na
              combinação atual. */}
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
                    onClick={() => { setTab(t.id); resetTransient(); }}
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

          {/* CARD FIXO — fonte única dos perfis. */}
          {renderCodesUsedCard()}

          {/* Erro fora do editor (ex.: falha ao selecionar perfil). */}
          {saveError && !profileEditing && (
            <div className="mb-2 rounded-md border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-[10px] font-bold text-rose-300">{saveError}</div>
          )}

          {/* GRADE DE CARDS — um card por etapa, 2 colunas (1 em telas
              estreitas), na ordem da Quest. */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {divisions.map((division, index) => renderDivisionCard(division, index))}
          </div>

          {/* Legenda compacta. */}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[var(--th-line)]/40 pt-2 text-[9px] text-slate-600">
            <span><span className="font-black text-violet-300/80">{RTC_SLOT_LABELS.boss}</span> é o chefe da etapa; <span className="font-black text-teal-300/80">{RTC_SLOT_LABELS.acesso}</span> é o código de acesso, quando a etapa possui um.</span>
            <span>Cada perfil tem uma <span className="font-bold text-slate-400">cor fixa</span> — a mesma em Códigos Usados, nos Bosses e no botão Importar.</span>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
