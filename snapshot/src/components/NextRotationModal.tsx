import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { X, RotateCw, Clock, Lock, Globe } from "lucide-react";
import type { PartyTab } from "../types";
import { VOC_COLORS } from "../types";
import { SG_BAKRA_COOLDOWN_MS, describeSgCooldown, normalizeSgRot, sanguineSlotBaseRot } from "../utils/sanguineRotation";
import { toFirestoreMillis } from "../utils/firestoreTimestamp";

// ============================================================================
// SANGUINE — "PRÓXIMA ROTAÇÃO"
//
// Aberto pelo botão "Próxima Rotação" do PartyPanel (PT Sanguine concluída).
// Lista os personagens com Drop? = NÃO (pré-selecionados, pois são os
// disponíveis para a próxima rotação), permite desmarcar/selecionar, exibe o
// fim do cooldown de 72h do Bakragore (automático, editável) e a visibilidade
// da nova PT (Privada/Pública). Confirmar cria uma NOVA PT Sanguine pelo
// fluxo normal de criação (numeração, notificações, slots).
//
// Renderiza por portal em document.body — o painel vive dentro de um container
// com CSS `zoom`, que quebra o hit-testing de `position: fixed`. Mesmo motivo
// já documentado em ConfirmModal, ServiceValueModal e PausePartyModal.
// ============================================================================

interface Props {
  open: boolean;
  party: PartyTab;
  /** IDs dos slots com Drop? = NÃO (candidatos à próxima rotação). */
  candidateIds: string[];
  onConfirm: (selectedIds: string[], opts: { visibility: "public" | "private"; horarioTimestamp?: number }) => Promise<void> | void;
  onCancel: () => void;
}

/** Decompõe uma duração (ms) em dias/horas/minutos (clamp em 0). */
function splitDuration(ms: number): { days: number; hours: number; mins: number } {
  const total = Math.max(0, Math.ceil(ms / 60_000)); // minutos restantes (arredonda p/ cima)
  const days = Math.floor(total / (24 * 60));
  const hours = Math.floor((total % (24 * 60)) / 60);
  const mins = total % 60;
  return { days, hours, mins };
}

/**
 * Valida um campo do cooldown manual: inteiro dentro de [min, max].
 * Campo vazio é INVÁLIDO (o usuário deve digitar 0 explicitamente) — evita
 * criar a PT com um tempo diferente do que parece estar na tela.
 */
function parseCooldownField(value: string, min: number, max: number): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

export default function NextRotationModal({ open, party, candidateIds, onConfirm, onCancel }: Props) {
  // Fim AUTOMÁTICO do cooldown: 72h após a CONCLUSÃO da Quest (timestamp
  // absoluto gravado na PT — confiável entre dispositivos/fusos).
  const autoCooldownEnd = useMemo(() => {
    const concludedAt = toFirestoreMillis(party.questFinalizedAt);
    return concludedAt > 0 ? concludedAt + SG_BAKRA_COOLDOWN_MS : Date.now() + SG_BAKRA_COOLDOWN_MS;
  }, [party.questFinalizedAt]);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [visibility, setVisibility] = useState<"public" | "private">(party.visibility === "private" ? "private" : "public");
  // Cooldown: AUTOMÁTICO (72h da conclusão) ou MANUAL por TEMPO RESTANTE —
  // dias/horas/minutos digitados separadamente; o fim exato é calculado no
  // momento de criar a PT (agora + restante informado).
  const [cooldownMode, setCooldownMode] = useState<"auto" | "manual">("auto");
  const [cdDays, setCdDays] = useState("0");
  const [cdHours, setCdHours] = useState("0");
  const [cdMins, setCdMins] = useState("0");
  const [isCreating, setIsCreating] = useState(false);

  // Reinicia o estado SOMENTE quando o modal abre (mesmo padrão do
  // PausePartyModal: callbacks do PartyPanel mudam de referência a cada
  // render e não podem resetar as escolhas do usuário).
  useEffect(() => {
    if (!open) return;
    setSelected(new Set(candidateIds));
    setVisibility(party.visibility === "private" ? "private" : "public");
    setCooldownMode("auto");
    // Pré-preenche o modo manual com o restante do cooldown automático —
    // ponto de partida natural para quem só quer ajustar alguns minutos.
    const remaining = splitDuration(autoCooldownEnd - Date.now());
    setCdDays(String(remaining.days));
    setCdHours(String(remaining.hours));
    setCdMins(String(remaining.mins));
    setIsCreating(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onCancel]);

  if (!open) return null;

  // Validação do modo manual: cada campo precisa ser um inteiro válido no
  // intervalo (dias 0–365, horas 0–23, minutos 0–59). Combinações inválidas
  // desabilitam o Criar com mensagem clara.
  const manualDays = parseCooldownField(cdDays, 0, 365);
  const manualHours = parseCooldownField(cdHours, 0, 23);
  const manualMins = parseCooldownField(cdMins, 0, 59);
  const manualValid = manualDays !== null && manualHours !== null && manualMins !== null;
  const manualError = cooldownMode === "manual" && !manualValid
    ? (manualDays === null
      ? "Dias: número inteiro de 0 a 365."
      : manualHours === null
        ? "Horas: número inteiro de 0 a 23."
        : "Minutos: número inteiro de 0 a 59.")
    : "";
  const manualRemainingMs = manualValid
    ? ((manualDays as number) * 24 * 60 + (manualHours as number) * 60 + (manualMins as number)) * 60_000
    : 0;
  const cooldownBlocked = cooldownMode === "manual" && !manualValid;

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function confirm() {
    if (selected.size === 0 || isCreating || cooldownBlocked) return;
    // Fim do cooldown calculado NO MOMENTO da criação: automático = 72h
    // contadas da conclusão (timestamp absoluto); manual = agora + tempo
    // restante digitado (dias/horas/minutos) — cálculo preciso, sem depender
    // de quando o modal foi aberto.
    const horarioTimestamp = cooldownMode === "auto"
      ? autoCooldownEnd
      : Date.now() + manualRemainingMs;
    setIsCreating(true);
    try {
      await onConfirm(Array.from(selected), { visibility, horarioTimestamp });
    } finally {
      setIsCreating(false);
    }
  }

  return createPortal(
    <div
      className="app-modal-overlay fixed inset-0 z-[1100] flex items-center justify-center bg-black/85 backdrop-blur-sm"
      onMouseDown={event => { if (event.target === event.currentTarget) onCancel(); }}
    >
      <div className="app-modal-frame app-modal-size-xs app-modal-frame--scroll relative w-full max-w-md rounded-xl border border-[var(--th-line)]/100 bg-[var(--th-bg-base)] shadow-2xl shadow-black/60">

        <div className="flex-shrink-0 flex items-center justify-between px-4 py-2.5 bg-gradient-to-r from-[var(--th-bg-raised)] to-[var(--th-bg-base)] border-b border-[var(--th-line)]/60">
          <div className="flex items-center gap-2 min-w-0">
            <RotateCw size={14} className="text-rose-400 flex-shrink-0" />
            <h2 className="text-sm font-bold text-slate-100 truncate">Próxima Rotação — Sanguine</h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            title="Cancelar (Esc)"
            className="text-slate-500 hover:text-slate-200 p-1 rounded-md hover:bg-white/[0.04] transition-colors cursor-pointer flex-shrink-0"
          >
            <X size={16} />
          </button>
        </div>

        <div className="app-modal-body custom-scrollbar px-4 py-3 space-y-3">
          <p className="text-[11px] leading-snug text-slate-400">
            Personagens que <span className="font-bold text-rose-300">não droparam</span> o item nesta rotação
            (Drop? = Não) — pré-selecionados para a nova PT Sanguine. Desmarque quem não deve entrar.
          </p>

          {candidateIds.length === 0 ? (
            <p className="text-[11px] text-slate-500 italic">Nenhum personagem com Drop? = Não nesta PT.</p>
          ) : (
            <div className="space-y-1 max-h-60 overflow-y-auto custom-scrollbar pr-1">
              {candidateIds.map(id => {
                const snap = party.memberSnapshots?.[id];
                const slot = party.slotData?.[id];
                const name = snap?.personagem || slot?.owner || id;
                const voc = snap?.voc || "";
                const level = snap?.level || 0;
                const nextRot = normalizeSgRot(sanguineSlotBaseRot(party, id)) + 1;
                const isOn = selected.has(id);
                return (
                  <label
                    key={id}
                    className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 cursor-pointer transition-colors ${
                      isOn ? "border-rose-500/40 bg-rose-500/10" : "border-[var(--th-line)]/50 bg-white/[0.02] hover:bg-white/[0.04]"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={isOn}
                      onChange={() => toggle(id)}
                      className="h-4 w-4 accent-rose-500 cursor-pointer flex-shrink-0"
                    />
                    <span className="min-w-0 flex-1 flex items-center gap-2">
                      <span className="text-[12px] font-bold text-slate-100 truncate">{name}</span>
                      {voc && (
                        <span className="text-[10px] font-bold flex-shrink-0" style={{ color: VOC_COLORS[voc as keyof typeof VOC_COLORS] }}>
                          {voc}{level ? ` ${level}` : ""}
                        </span>
                      )}
                      <span className="ml-auto text-[10px] font-bold text-rose-300 flex-shrink-0" title="Rotação em que o personagem entrará">
                        {nextRot}ª Rot
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          )}

          {/* COOLDOWN DO BAKRAGORE — automático (72h após a conclusão), editável */}
          <div className="rounded-lg border border-[var(--th-line)]/50 bg-white/[0.02] px-3 py-2 space-y-1.5">
            <div className="flex items-center gap-1.5">
              <Clock size={12} className="text-amber-400 flex-shrink-0" />
              <span className="text-[11px] font-bold text-slate-200">Fim do cooldown do Bakragore (horário da nova PT)</span>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => setCooldownMode("auto")}
                className={`px-2 py-1 rounded-md border text-[10px] font-bold transition-colors cursor-pointer ${
                  cooldownMode === "auto"
                    ? "border-amber-500/50 bg-amber-500/20 text-amber-300"
                    : "border-[var(--th-line)]/50 bg-white/[0.02] text-slate-400 hover:bg-white/[0.05]"
                }`}
                title={describeSgCooldown(autoCooldownEnd)}
              >
                Automático (72h)
              </button>
              <button
                type="button"
                onClick={() => setCooldownMode("manual")}
                className={`px-2 py-1 rounded-md border text-[10px] font-bold transition-colors cursor-pointer ${
                  cooldownMode === "manual"
                    ? "border-amber-500/50 bg-amber-500/20 text-amber-300"
                    : "border-[var(--th-line)]/50 bg-white/[0.02] text-slate-400 hover:bg-white/[0.05]"
                }`}
                title="Informar quanto tempo FALTA para o cooldown acabar"
              >
                Tempo restante
              </button>
            </div>
            {cooldownMode === "manual" && (
              <div className="flex items-end gap-2 flex-wrap">
                {([
                  { label: "Dias", value: cdDays, set: setCdDays, max: 365 },
                  { label: "Horas", value: cdHours, set: setCdHours, max: 23 },
                  { label: "Min", value: cdMins, set: setCdMins, max: 59 },
                ] as const).map(({ label, value, set, max }) => (
                  <label key={label} className="flex flex-col gap-0.5">
                    <span className="text-[9px] font-bold uppercase tracking-wide text-slate-500">{label}</span>
                    <input
                      type="number"
                      min={0}
                      max={max}
                      step={1}
                      value={value}
                      onChange={event => set(event.target.value)}
                      className="w-16 bg-black/60 border border-[var(--th-line)]/60 rounded px-2 py-1 text-[11px] text-slate-200 text-center focus:outline-none focus:border-amber-500/50"
                    />
                  </label>
                ))}
              </div>
            )}
            {manualError ? (
              <p className="text-[10px] leading-snug font-bold text-rose-400">{manualError}</p>
            ) : (
              <p className="text-[10px] leading-snug text-slate-500">
                {cooldownMode === "auto"
                  ? "Usando o cooldown automático: 72h contadas da conclusão desta Quest."
                  : manualRemainingMs === 0
                    ? "Tempo restante zerado — a nova PT será criada com horário imediato."
                    : `Nova PT marcada para daqui a ${manualDays ? `${manualDays}d ` : ""}${manualHours ? `${manualHours}h ` : ""}${manualMins ? `${manualMins}m` : ""}`.trim()
                      + ` (≈ ${new Date(Date.now() + manualRemainingMs).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}; o fim exato é calculado ao criar).`}
              </p>
            )}
          </div>

          {/* VISIBILIDADE DA NOVA PT */}
          <div className="flex items-center gap-2">
            {([
              { value: "private" as const, label: "PT Privada", icon: Lock },
              { value: "public" as const, label: "PT Pública", icon: Globe },
            ]).map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                onClick={() => setVisibility(value)}
                className={`flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg border text-[11px] font-bold transition-colors cursor-pointer ${
                  visibility === value
                    ? "border-sky-500/50 bg-sky-500/15 text-sky-300"
                    : "border-[var(--th-line)]/50 bg-white/[0.02] text-slate-400 hover:bg-white/[0.05]"
                }`}
              >
                <Icon size={12} />
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-shrink-0 flex items-center justify-end gap-2 px-4 py-2.5 border-t border-[var(--th-line)]/60 bg-[var(--th-bg-raised)]/40">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 rounded-md border border-[var(--th-line)]/60 bg-white/[0.03] text-slate-300 text-[11px] font-bold hover:bg-white/[0.07] transition-colors cursor-pointer"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={() => { void confirm(); }}
            disabled={selected.size === 0 || isCreating || cooldownBlocked}
            title={cooldownBlocked ? "Corrija o tempo restante do cooldown (dias/horas/minutos)." : undefined}
            className="px-3 py-1.5 rounded-md border border-rose-500/50 bg-rose-500/15 text-rose-300 text-[11px] font-bold hover:bg-rose-500/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            {isCreating ? "Criando PT..." : `Criar PT (${selected.size})`}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
