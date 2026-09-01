import { useState, useEffect, useRef, useMemo } from "react";
import { X, Save, Swords, Ban, Percent, Search, Check, ChevronDown, Link2, Lock } from "lucide-react";
import type { Character } from "../types";
import { VOCATIONS, VOC_COLORS, todayISO } from "../types";
import { SERVER_OPTIONS, normalizeServerName } from "../constants/servers";

interface Props {
  open: boolean;
  /**
   * Personagem carregado no modal. Aceita DraftCharacter para representar o
   * estado de criação antes de uma vocação ser selecionada (voc: "").
   */
  initial: Character | DraftCharacter | null;
  accounts: string[];
  servers: string[];
  onSave: (c: Character) => void | Promise<void>;
  onClose: () => void;
  mode?: "create" | "edit";
  highlightFields?: Array<"account" | "valorPago">;
  /** Drop/Lucro pertencem ao comprador em uma negociação entre usuários. */
  lockedQuestFinancialFields?: boolean;
}

type SaleStatus = "ativo" | "a_venda" | "vendido";

// ============================================================================
// VOCAÇÃO NÃO SELECIONADA
//
// `Character.voc` é tipado como `Vocation` (não aceita null), e alterar o tipo
// global afetaria todo o projeto. Para representar "nenhuma vocação escolhida"
// sem quebrar contratos, o estado interno do modal usa `voc: ""`.
//
// O valor "" nunca chega ao onSave: a validação impede o envio enquanto a
// vocação não for escolhida, e o cast ocorre só no submit, quando já existe
// uma vocação válida garantida.
// ============================================================================
export type DraftCharacter = Omit<Character, "voc"> & { voc: Character["voc"] | "" };

function newId() {
  return "char_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function emptyCharacter(): DraftCharacter {
  return {
    id: newId(),
    account: "",
    personagem: "",
    servidor: "",
    voc: "",
    level: 0,
    soulwar: true,
    sanguine: true,
    valorPago: 0,
    dropSW: 0,
    dropBakra: 0,
    valorVenda: 0,
    vendido: false,
    aVenda: false,
    shared: true,
    dataCompra: todayISO(),
    dataVenda: "",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export default function CharacterModal({ open, initial, accounts, servers, onSave, onClose, mode, highlightFields = [], lockedQuestFinancialFields = false }: Props) {
  const [data, setData] = useState<DraftCharacter>(emptyCharacter);
  const firstInputRef = useRef<HTMLInputElement>(null);
  const [taxPercent, setTaxPercent] = useState(8.0);
  const [taxApplied, setTaxApplied] = useState(false);
  const [previousValue, setPreviousValue] = useState<number | null>(null);
  const [focusedField, setFocusedField] = useState<"account" | "valorPago" | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // O modal usa limite de viewport e rolagem interna compartilhados; não
  // reduz campos via scale em telas menores ou zoom alto.

  useEffect(() => {
    if (open) {
      setFocusedField(null);
      setIsSaving(false);
      if (initial) {
        setData({ ...initial });
        if (initial.taxaAplicada != null && initial.valorVendaOriginal != null) {
          setTaxPercent(initial.taxaAplicada);
          setTaxApplied(true);
          setPreviousValue(initial.valorVendaOriginal);
        } else {
          setTaxApplied(false);
          setPreviousValue(null);
          setTaxPercent(8.0);
        }
      } else {
        setData(emptyCharacter());
        setTaxApplied(false);
        setPreviousValue(null);
        setTaxPercent(8.0);
      }
      setTimeout(() => firstInputRef.current?.focus(), 50);
    }
  }, [open, initial]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!open) return;
      if (e.key === "Escape" && !isSaving) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, isSaving]);

  if (!open) return null;

  function set<K extends keyof DraftCharacter>(k: K, v: DraftCharacter[K]) {
    setData((d) => ({ ...d, [k]: v }));
  }

  function getSaleStatus(c: Pick<Character, "vendido" | "aVenda">): SaleStatus {
    if (c.vendido) return "vendido";
    if (c.aVenda) return "a_venda";
    return "ativo";
  }

  function setSaleStatus(status: SaleStatus) {
    setData((d) => ({
      ...d,
      vendido: status === "vendido",
      aVenda: status === "a_venda",
      dataVenda: status === "vendido" ? (d.dataVenda || todayISO()) : "",
      shared: status === "ativo",
    }));
  }

  function shouldHighlightField(field: "account" | "valorPago"): boolean {
    if (!highlightFields.includes(field) || focusedField === field) return false;
    if (field === "account") return !data.account.trim();
    return data.valorPago <= 0;
  }

  // ==========================================================================
  // CAMPOS OBRIGATÓRIOS
  //
  // Um personagem só pode ser salvo com os cinco campos abaixo preenchidos.
  // Cada flag é independente para que a borda pulsante suma individualmente
  // assim que o respectivo campo ficar válido.
  //
  // Regras de invalidez:
  //   - texto só com espaços  → inválido (por isso o .trim())
  //   - servidor não escolhido → inválido
  //   - level vazio, não numérico ou <= 0 → inválido
  //     (o input já converte não numérico para 0, então level <= 0 cobre os
  //      três casos e mantém a regra de level que o modal sempre teve)
  //   - vocação não escolhida → inválido
  // ==========================================================================
  const isAccountValid = data.account.trim().length > 0;
  const isPersonagemValid = data.personagem.trim().length > 0;
  const isServidorValid = data.servidor.trim().length > 0;
  const isLevelValid = Number.isFinite(data.level) && data.level > 0;
  const isVocValid = data.voc !== "" && VOCATIONS.includes(data.voc as Character["voc"]);

  const isFormValid = isAccountValid && isPersonagemValid && isServidorValid && isLevelValid && isVocValid;

  // Padrão visual reutilizado exatamente como já existia no modal.
  const REQUIRED_PULSE_CLASS = "border-amber-400/70 shadow-[0_0_14px_color-mix(in_oklab,var(--color-amber-500)_22%,transparent)] animate-pulse";

  // O destaque de "account" combina o destaque explícito recebido por props
  // com a regra geral de obrigatoriedade do formulário.
  const accountHighlightClass = (shouldHighlightField("account") || !isAccountValid) ? REQUIRED_PULSE_CLASS : "border-red-900/30";
  const valorPagoHighlightClass = shouldHighlightField("valorPago") ? REQUIRED_PULSE_CLASS : "border-red-900/30";
  const personagemHighlightClass = !isPersonagemValid ? REQUIRED_PULSE_CLASS : "border-red-900/30";
  const levelHighlightClass = !isLevelValid ? REQUIRED_PULSE_CLASS : "border-red-900/30";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Revalida no salvamento para impedir o cadastro mesmo que o submit seja
    // disparado por outro meio (Enter, submit programático, etc.).
    if (!isFormValid || isSaving) return;
    setIsSaving(true);
    try {
      await onSave({
        ...data,
        voc: data.voc as Character["voc"],
        account: data.account.trim(),
        personagem: data.personagem.trim(),
        servidor: data.servidor.trim(),
        aVenda: data.vendido ? false : !!data.aVenda,
        taxaAplicada: taxApplied ? taxPercent : undefined,
        valorVendaOriginal: taxApplied && previousValue != null ? previousValue : undefined,
        updatedAt: Date.now(),
      });
    } finally {
      setIsSaving(false);
    }
  }

  function applyTax() {
    const original = data.valorVenda;
    if (original <= 0) return;
    const discounted = Math.round(original * (1 - taxPercent / 100));
    setPreviousValue(original);
    setData(d => ({
      ...d,
      valorVenda: discounted,
      vendido: true,
      aVenda: false,
      dataVenda: d.dataVenda || todayISO(),
      shared: false,
    }));
    setTaxApplied(true);
  }

  const saleStatus = getSaleStatus(data);
  const questFinancialLockTitle = "Bloqueado: Drop e Lucro desta Quest pertencem ao comprador da negociação.";

  return (
    <div
      className="app-modal-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !isSaving) onClose();
      }}
    >
      <form
        onSubmit={handleSubmit}
        className="app-modal-frame app-modal-size-lg app-modal-frame--scroll relative w-full max-w-2xl bg-[var(--th-bg-base)] border border-[var(--th-line)]/100 rounded-2xl shadow-xl"
      >
        <div className="flex items-center justify-between px-6 py-4 bg-gradient-to-r from-[var(--th-bg-raised)] to-[var(--th-bg-base)] border-b border-[var(--th-line)]/40 flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-[var(--th-line)] to-[var(--th-brand-mid)]/40 border border-[var(--th-brand-mid)]/40 flex items-center justify-center">
              <Swords size={18} className="text-amber-600" />
            </div>
            <h2 className="text-lg font-bold text-white tracking-wide">
              {mode === "create" || !initial ? "Adicionar Personagem" : "Editar Personagem"}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSaving}
            className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-red-900/20 transition-colors disabled:cursor-wait disabled:opacity-40"
          >
            <X size={20} />
          </button>
        </div>

        <div className="app-modal-body p-4 sm:p-6 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-red-400/80 mb-1.5">
                Nome da Conta (Account)
              </label>
              <input
                type="text"
                list="accounts-list"
                value={data.account}
                onChange={(e) => set("account", e.target.value)}
                onFocus={() => setFocusedField("account")}
                onBlur={() => setFocusedField(null)}
                placeholder="Ex: chernobyl@gmail.com"
                className={`w-full bg-black/40 border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-700/50 placeholder-slate-600 transition-colors ${accountHighlightClass}`}
                maxLength={40}
              />
              <datalist id="accounts-list">
                {accounts.map((acc) => (
                  <option key={acc} value={acc} />
                ))}
              </datalist>
            </div>

            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-red-400/80 mb-1.5">
                Nome do Personagem *
              </label>
              <input
                ref={firstInputRef}
                type="text"
                value={data.personagem}
                onChange={(e) => set("personagem", e.target.value)}
                placeholder="Ex: Bubble"
                className={`w-full bg-black/40 border rounded-lg px-3 py-2 text-sm font-medium text-white focus:outline-none focus:border-red-700/50 placeholder-slate-600 transition-colors ${personagemHighlightClass}`}
                required
                maxLength={40}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <ServerField
              value={data.servidor}
              onChange={(v) => set("servidor", v)}
              existingServers={servers}
              highlightClass={!isServidorValid ? REQUIRED_PULSE_CLASS : ""}
            />

            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-red-400/80 mb-1.5">
                Level *
              </label>
              <input
                type="text"
                inputMode="numeric"
                value={data.level === 0 ? "" : data.level}
                onChange={(e) => {
                  const n = parseInt(e.target.value.replace(/\D/g, ""), 10);
                  set("level", Number.isFinite(n) ? n : 0);
                }}
                placeholder="0"
                className={`w-full bg-black/40 border rounded-lg px-3 py-2 text-sm text-left tabular-nums font-bold text-white focus:outline-none focus:border-red-700/50 placeholder-slate-600 transition-colors ${levelHighlightClass}`}
              />
            </div>
          </div>

          <div>
            <label className="block text-[10px] font-bold uppercase tracking-wider text-red-400/80 mb-2">
              Vocação *
            </label>
            <div className="grid grid-cols-5 gap-2">
              {VOCATIONS.map((v) => {
                const color = VOC_COLORS[v];
                const selected = data.voc === v;
                return (
                  <button
                    key={v}
                    type="button"
                    onClick={() => set("voc", v)}
                    className={`flex flex-col items-center justify-center p-2.5 rounded-xl border-2 transition-all cursor-pointer ${
                      selected
                        ? "bg-white/10 shadow-md"
                        : isVocValid
                          ? "bg-black/20 border-red-900/20 hover:bg-red-900/20"
                          : `bg-black/20 hover:bg-red-900/20 ${REQUIRED_PULSE_CLASS}`
                    }`}
                    style={selected ? { borderColor: color } : undefined}
                  >
                    <span className="text-base font-bold tracking-wider" style={{ color }}>
                      {v}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 pt-2 border-t border-red-900/20">
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-red-400/80 mb-1.5">
                SoulWar Disponível?
              </label>
              <div className="grid grid-cols-2 gap-1 h-[38px]">
                <button
                  type="button"
                  onClick={() => set("soulwar", true)}
                  className={`rounded-lg border text-xs font-bold transition-all cursor-pointer ${
                    data.soulwar
                      ? "border-emerald-500/50 bg-emerald-500/20 text-emerald-300 shadow-sm"
                      : "border-red-900/30 bg-black/20 text-slate-500 hover:bg-red-900/20 hover:text-slate-300"
                  }`}
                >
                  SIM
                </button>
                <button
                  type="button"
                  onClick={() => set("soulwar", false)}
                  className={`rounded-lg border text-xs font-bold transition-all cursor-pointer ${
                    !data.soulwar
                      ? "border-rose-500/50 bg-rose-500/20 text-rose-300 shadow-sm"
                      : "border-red-900/30 bg-black/20 text-slate-500 hover:bg-red-900/20 hover:text-slate-300"
                  }`}
                >
                  NÃO
                </button>
              </div>
            </div>

            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-red-400/80 mb-1.5">
                Sanguine Disponível?
              </label>
              <div className="grid grid-cols-2 gap-1 h-[38px]">
                <button
                  type="button"
                  onClick={() => set("sanguine", true)}
                  className={`rounded-lg border text-xs font-bold transition-all cursor-pointer ${
                    data.sanguine
                      ? "border-emerald-500/50 bg-emerald-500/20 text-emerald-300 shadow-sm"
                      : "border-red-900/30 bg-black/20 text-slate-500 hover:bg-red-900/20 hover:text-slate-300"
                  }`}
                >
                  SIM
                </button>
                <button
                  type="button"
                  onClick={() => set("sanguine", false)}
                  className={`rounded-lg border text-xs font-bold transition-all cursor-pointer ${
                    !data.sanguine
                      ? "border-rose-500/50 bg-rose-500/20 text-rose-300 shadow-sm"
                      : "border-red-900/30 bg-black/20 text-slate-500 hover:bg-red-900/20 hover:text-slate-300"
                  }`}
                >
                  NÃO
                </button>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 pt-2 border-t border-red-900/20">
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-red-400/80 mb-1.5" title="Custo de compra ou investimento">
                Valor Pago (RC)
              </label>
              <input
                type="text"
                inputMode="numeric"
                value={data.valorPago === 0 ? "" : data.valorPago}
                onChange={(e) => {
                  const n = parseInt(e.target.value.replace(/[^\d-]/g, ""), 10);
                  set("valorPago", Number.isFinite(n) ? n : 0);
                }}
                onFocus={() => setFocusedField("valorPago")}
                onBlur={() => setFocusedField(null)}
                placeholder="0"
                className={`w-full bg-black/40 border rounded-lg px-3 py-2 text-sm text-left tabular-nums text-slate-300 font-medium focus:outline-none focus:border-red-700/50 placeholder-slate-600 transition-colors ${valorPagoHighlightClass}`}
              />
            </div>

            <div>
              <label className="mb-1.5 flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-red-400/80" title={lockedQuestFinancialFields ? questFinancialLockTitle : undefined}>
                Drop SW (RC) {lockedQuestFinancialFields && <Lock size={10} className="text-violet-300" />}
              </label>
              <input
                type="text"
                inputMode="numeric"
                disabled={lockedQuestFinancialFields}
                value={data.dropSW === 0 ? "" : data.dropSW}
                onChange={(e) => {
                  const n = parseInt(e.target.value.replace(/[^\d-]/g, ""), 10);
                  set("dropSW", Number.isFinite(n) ? n : 0);
                }}
                placeholder="0"
                title={lockedQuestFinancialFields ? questFinancialLockTitle : undefined}
                className="w-full bg-black/40 border border-red-900/30 rounded-lg px-3 py-2 text-sm text-left tabular-nums text-emerald-400 font-medium focus:outline-none focus:border-red-700/50 placeholder-slate-600 transition-colors disabled:cursor-not-allowed disabled:opacity-45"
              />
            </div>

            <div>
              <label className="mb-1.5 flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-red-400/80" title={lockedQuestFinancialFields ? questFinancialLockTitle : undefined}>
                Drop SG (RC) {lockedQuestFinancialFields && <Lock size={10} className="text-violet-300" />}
              </label>
              <input
                type="text"
                inputMode="numeric"
                disabled={lockedQuestFinancialFields}
                value={data.dropBakra === 0 ? "" : data.dropBakra}
                onChange={(e) => {
                  const n = parseInt(e.target.value.replace(/[^\d-]/g, ""), 10);
                  set("dropBakra", Number.isFinite(n) ? n : 0);
                }}
                placeholder="0"
                title={lockedQuestFinancialFields ? questFinancialLockTitle : undefined}
                className="w-full bg-black/40 border border-red-900/30 rounded-lg px-3 py-2 text-sm text-left tabular-nums text-emerald-400 font-medium focus:outline-none focus:border-red-700/50 placeholder-slate-600 transition-colors disabled:cursor-not-allowed disabled:opacity-45"
              />
            </div>

            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-red-400/80 mb-1.5">
                Valor Venda (RC) {taxPercent}%
              </label>
              <div className="flex items-center gap-1.5">
                <div className="relative flex-1">
                  <input
                    type="text"
                    inputMode="numeric"
                    value={data.valorVenda === 0 ? "" : data.valorVenda}
                    onChange={(e) => {
                      const n = parseInt(e.target.value.replace(/[^\d-]/g, ""), 10);
                      set("valorVenda", Number.isFinite(n) ? n : 0);
                      if (taxApplied) {
                        setTaxApplied(false);
                        setPreviousValue(null);
                      }
                    }}
                    placeholder="0"
                    className="w-full bg-black/40 border border-red-900/30 rounded-lg px-3 py-2 text-sm text-left tabular-nums text-amber-400 font-medium pr-8 focus:outline-none focus:border-red-700/50 placeholder-slate-600 transition-colors"
                  />
                  {taxApplied && previousValue !== null && (
                    <span className="absolute right-1 top-1/2 -translate-y-1/2 text-[9px] text-sky-400 font-semibold pointer-events-none">
                      ✓
                    </span>
                  )}
                </div>
                <div className="flex flex-col gap-0.5">
                  <button
                    type="button"
                    disabled={taxApplied}
                    onClick={() => setTaxPercent(Math.min(99.9, parseFloat((taxPercent + 0.5).toFixed(1))))}
                    className="w-5 h-4 flex items-center justify-center rounded border border-red-900/30 text-[10px] text-slate-400 hover:text-white hover:bg-red-900/20 transition-colors leading-none disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    +
                  </button>
                  <button
                    type="button"
                    disabled={taxApplied}
                    onClick={() => setTaxPercent(Math.max(0, parseFloat((taxPercent - 0.5).toFixed(1))))}
                    className="w-5 h-4 flex items-center justify-center rounded border border-red-900/30 text-[10px] text-slate-400 hover:text-white hover:bg-red-900/20 transition-colors leading-none disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    −
                  </button>
                </div>
              </div>
              {taxApplied && previousValue !== null && (
                <div className="text-[10px] text-sky-400 mt-0.5 whitespace-nowrap flex flex-col leading-tight">
                  <span>Taxa aplicada (-{taxPercent}%)</span>
                  <span>Valor anterior: {previousValue} RC</span>
                </div>
              )}
            </div>
          </div>

          {lockedQuestFinancialFields && (
            <p className="flex items-start gap-1.5 rounded-lg border border-violet-500/20 bg-violet-500/[0.055] px-3 py-2 text-[10px] leading-relaxed text-violet-100">
              <Lock size={12} className="mt-0.5 flex-shrink-0 text-violet-300" />
              Drop SW, Drop SG, Lucro SW e Lucro SG desta Quest são privados do comprador e não podem ser alterados pelo dono original.
            </p>
          )}

          <div className="flex justify-end">
            <button
              type="button"
              disabled={taxApplied || data.valorVenda <= 0}
              onClick={applyTax}
              className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-[10px] font-bold border transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                taxApplied
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                  : "border-amber-500/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20"
              }`}
              title={taxApplied ? `Taxa de ${taxPercent}% já aplicada. Anterior: ${previousValue} RC` : `Aplicar desconto de ${taxPercent}%`}
            >
              <Percent size={12} />
              {taxApplied ? "✓ Taxa Aplicada" : `Aplicar Taxa (-${taxPercent}%)`}
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2 border-t border-red-900/20 items-center">
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-red-400/80 mb-1.5">
                Vendido?
              </label>
              <div className="grid grid-cols-3 gap-1 h-[38px]">
                <button
                  type="button"
                  onClick={() => setSaleStatus("ativo")}
                  className={`rounded-lg border text-[11px] font-bold transition-colors cursor-pointer ${
                    saleStatus === "ativo"
                      ? "border-sky-500/50 bg-sky-500/20 text-sky-300"
                      : "border-red-900/30 bg-black/20 text-slate-500 hover:bg-red-900/20 hover:text-slate-300"
                  }`}
                >
                  Não
                </button>
                <button
                  type="button"
                  onClick={() => setSaleStatus("a_venda")}
                  className={`rounded-lg border text-[11px] font-bold transition-colors cursor-pointer ${
                    saleStatus === "a_venda"
                      ? "border-amber-500/50 bg-amber-500/20 text-amber-300"
                      : "border-red-900/30 bg-black/20 text-slate-500 hover:bg-red-900/20 hover:text-slate-300"
                  }`}
                >
                  À Venda
                </button>
                <button
                  type="button"
                  onClick={() => setSaleStatus("vendido")}
                  className={`rounded-lg border text-[11px] font-bold transition-colors cursor-pointer ${
                    saleStatus === "vendido"
                      ? "border-emerald-500/50 bg-emerald-500/20 text-emerald-300"
                      : "border-red-900/30 bg-black/20 text-slate-500 hover:bg-red-900/20 hover:text-slate-300"
                  }`}
                >
                  Sim
                </button>
              </div>
            </div>

            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-red-400/80 mb-1.5">
                Data de Compra
              </label>
              <input
                type="date"
                value={data.dataCompra || ""}
                onChange={(e) => set("dataCompra", e.target.value)}
                className="w-full bg-black/40 border border-red-900/30 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-700/50 [color-scheme:dark] h-[38px]"
              />
            </div>

            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-red-400/80 mb-1.5">
                Data de Venda
              </label>
              <input
                type="date"
                disabled={!data.vendido}
                value={data.dataVenda || ""}
                onChange={(e) => set("dataVenda", e.target.value)}
                className="w-full bg-black/40 border border-red-900/30 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-700/50 [color-scheme:dark] h-[38px] disabled:opacity-30"
              />
            </div>
          </div>

          <div className="pt-2 border-t border-red-900/20">
            <label className="group flex items-center gap-2.5 text-xs select-none cursor-pointer py-1 transition-colors">
              <input
                type="checkbox"
                checked={data.shared !== false}
                onChange={(e) => set("shared", e.target.checked)}
                className="sr-only peer"
              />
              <div className={`relative w-[18px] h-[18px] rounded-[5px] border-2 flex-shrink-0 flex items-center justify-center transition-all duration-200 ${
                data.shared !== false
                  ? "bg-gradient-to-br from-[var(--th-brand-mid)] to-[var(--th-brand-deep)] border-amber-600/50 shadow-[0_0_8px_color-mix(in_oklab,var(--th-brand)_40%,transparent),inset_0_1px_1px_rgba(255,255,255,0.08)]"
                  : "bg-[var(--th-n-deep)] border-[var(--th-line)]/100 group-hover:border-[var(--th-brand)]/100 group-hover:bg-[var(--th-bg-base)]"
              }`}>
                {data.shared !== false && (
                  <svg width="10" height="8" viewBox="0 0 10 8" fill="none" className="drop-shadow-sm">
                    <path d="M1.5 4L3.8 6.5L8.5 1.5" stroke="#f6c96e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                )}
              </div>
              <Link2 size={12} className={`transition-colors duration-200 ${data.shared !== false ? "text-amber-400/90" : "text-amber-500/40 group-hover:text-amber-500/60"}`} />
              <span className={`transition-colors duration-200 ${data.shared !== false ? "text-slate-300" : "text-slate-500 group-hover:text-slate-400"}`}>
                <strong className={`transition-colors duration-200 ${data.shared !== false ? "text-white" : "text-slate-400 group-hover:text-slate-300"}`}>Compartilhar:</strong> Disponível para PT's e visível para outros usuários.
              </span>
            </label>
          </div>
        </div>

        <div className="app-modal-footer flex flex-wrap items-center justify-end gap-3 px-4 sm:px-6 py-4 bg-gradient-to-r from-[var(--th-bg-raised)] to-[var(--th-bg-base)] border-t border-[var(--th-line)]/40">
          <button
            type="button"
            onClick={onClose}
            disabled={isSaving}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold text-slate-300 hover:text-white bg-[var(--th-bg-base)] hover:bg-[var(--th-line)]/20 border border-[var(--th-line)]/100 transition-colors cursor-pointer disabled:cursor-wait disabled:opacity-40"
          >
            <Ban size={14} /> Cancelar
          </button>
          <button
            type="submit"
            disabled={!isFormValid || isSaving}
            title={isSaving ? "Salvando personagem" : isFormValid ? "Salvar personagem" : "Preencha Account, Personagem, Servidor, Level e Vocação para salvar"}
            className={`inline-flex items-center gap-1.5 px-5 py-2 rounded-lg text-xs font-bold border transition-colors ${
              isFormValid && !isSaving
                ? "bg-gradient-to-r from-[var(--th-brand-mid)] to-[var(--th-line)] hover:from-[var(--th-brand-bright)] hover:to-[var(--th-line-strong)] text-white border-[var(--th-brand-mid)]/60 cursor-pointer"
                : "bg-[var(--th-line-subtle)] text-slate-500 border-[var(--th-line)]/60 cursor-wait opacity-60"
            }`}
          >
            <Save size={14} /> {isSaving ? "Salvando..." : "Salvar Personagem"}
          </button>
        </div>
      </form>
    </div>
  );
}

// ── Server Selector (elegant dropdown) ──
// Lista oficial centralizada em src/constants/servers.ts
const BUILTIN_SERVERS = SERVER_OPTIONS;

function ServerField({ value, onChange, existingServers, highlightClass = "" }: {
  value: string;
  onChange: (v: string) => void;
  existingServers: string[];
  /** Classe de borda pulsante aplicada enquanto o servidor não estiver selecionado. */
  highlightClass?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const allServers = useMemo(() => {
    // Normaliza os servidores vindos dos dados salvos para que nomenclaturas
    // antigas ("Grimoria 1", "Grimoria 01", "Tormentum") não apareçam
    // duplicadas ao lado do nome oficial correspondente.
    const normalizedExisting = existingServers.map(normalizeServerName);
    return Array.from(new Set([...BUILTIN_SERVERS, ...normalizedExisting]))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [existingServers]);

  const filtered = useMemo(() => {
    if (!search.trim()) return allServers;
    const q = search.toLowerCase();
    return allServers.filter(s => s.toLowerCase().includes(q));
  }, [allServers, search]);

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => searchRef.current?.focus(), 80);
    function handleClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch("");
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [open]);

  function handleSelect(srv: string) {
    onChange(srv);
    setOpen(false);
    setSearch("");
  }

  const isPlaceholder = !value;
  const displayLabel = isPlaceholder ? "Selecione o servidor" : value;

  return (
    <div>
      <label className="block text-[10px] font-bold uppercase tracking-wider text-red-400/80 mb-1.5">
        Servidor *
      </label>
      <div ref={wrapRef} className="relative">
        <button
          type="button"
          onClick={() => { setOpen(o => !o); if (open) setSearch(""); }}
          className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg border transition-colors text-sm h-[38px] ${
            isPlaceholder
              ? `bg-black/40 text-slate-500 ${highlightClass || "border-red-900/30"}`
              : "bg-black/40 border-red-700/50 text-red-300 font-medium"
          } hover:border-red-700/60 focus:outline-none`}
        >
          <span className="truncate">{displayLabel}</span>
          <ChevronDown size={14} className={`text-slate-500 flex-shrink-0 transition-transform duration-150 ${open ? "rotate-180 text-red-400" : ""}`} />
        </button>
        {open && (
          <div className="absolute z-20 mt-1 w-full bg-[var(--th-bg-base)] border border-[var(--th-line)]/100 rounded-lg shadow-xl overflow-hidden">
            <div className="p-2 border-b border-red-900/20">
              <div className="relative">
                <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
                <input
                  ref={searchRef}
                  type="text"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Escape") { setOpen(false); setSearch(""); } }}
                  placeholder="Buscar servidor..."
                  className="w-full pl-7 pr-3 py-1.5 bg-black/40 border border-red-900/30 rounded text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-red-700/50"
                />
              </div>
            </div>
            <div className="max-h-44 overflow-y-auto">
              {filtered.length === 0 ? (
                <div className="px-3 py-3 text-xs text-slate-500 italic text-center">Nenhum servidor encontrado</div>
              ) : (
                filtered.map(srv => (
                  <button
                    key={srv}
                    type="button"
                    onClick={(e) => { e.preventDefault(); handleSelect(srv); }}
                    className={`w-full px-3 py-2 text-xs text-left cursor-pointer transition-colors flex items-center justify-between gap-2 ${
                      srv === value
                        ? "bg-red-900/30 text-red-300 font-semibold border-l-2 border-red-500"
                        : "text-slate-300 hover:bg-red-900/20 hover:text-white"
                    }`}
                  >
                    <span className="truncate">{srv}</span>
                    {srv === value && <Check size={12} className="text-red-400 flex-shrink-0" />}
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}