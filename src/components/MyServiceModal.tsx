import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Clock, X, CheckCircle2 } from "lucide-react";
import type { ServicePaymentMethod, SharedService, Vocation } from "../types";
import { VOCATIONS, VOC_COLORS, VOC_LABEL, SERVICE_PAYMENT_LABELS, resolveServiceValue } from "../types";
import { SERVER_OPTIONS } from "../constants/servers";
import { FilterSelect } from "./FilterTypes";
import { toIsoDate } from "../services/sharedServicesService";

// ============================================================================
// MODAL DE "MEUS SERVICES" — layout compacto
//
// Diferenças em relação ao modal da Lista de Espera:
//   • SEM o campo "Serviceiro" — vínculo automático ao usuário autenticado;
//   • campo "Data" (hoje por padrão, editável);
//   • seleção exclusiva de forma de pagamento;
//   • "Valor Combinado" só aparece quando essa forma é escolhida;
//   • conclusão reduzida a um único botão (sem o quadro "Lucro do Service").
//
// O WaitingListPanel NÃO foi tocado.
// ============================================================================

export interface MyServiceFormData {
  /** No payload de `onSave` a vocação já está validada (nunca ""). */
  personagem: string;
  ownerName: string;
  servidor: string;
  /** "" = nenhuma vocação escolhida ainda (campo obrigatório). */
  voc: Vocation | "";
  level: number;
  valorCombinado: number;
  notes: string;
  whatsappCountry: string;
  whatsappArea: string;
  whatsappNumber: string;
  quest: "soulwar" | "sanguine";
  paymentMethod: ServicePaymentMethod;
  dataService: string;
  realizado: boolean;
}

export function blankServiceForm(): MyServiceFormData {
  return {
    personagem: "",
    ownerName: "",
    servidor: "",
    voc: "",
    level: 0,
    valorCombinado: 0,
    notes: "",
    whatsappCountry: "55",
    whatsappArea: "",
    whatsappNumber: "",
    quest: "soulwar",
    paymentMethod: "",
    // Data atual preenchida automaticamente ao criar.
    dataService: toIsoDate(),
    realizado: false,
  };
}

export function serviceToForm(service: SharedService): MyServiceFormData {
  return {
    personagem: service.personagem,
    ownerName: service.ownerName,
    servidor: service.servidor,
    voc: service.voc,
    level: service.level,
    valorCombinado: service.valorCombinado,
    notes: service.notes,
    whatsappCountry: service.whatsappCountry || "55",
    whatsappArea: service.whatsappArea,
    whatsappNumber: service.whatsappNumber,
    quest: service.quest,
    paymentMethod: service.paymentMethod,
    dataService: service.dataService || toIsoDate(service.createdAt),
    realizado: service.status === "realizado",
  };
}

/** Label compacto — bem menor que o do modal original. */
function Field({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`block min-w-0 ${className}`}>
      <span className="block text-[9px] font-bold uppercase tracking-wider text-slate-500 mb-1">{label}</span>
      {children}
    </label>
  );
}

const INPUT_CLS =
  "w-full px-2 py-1.5 bg-[var(--th-n-elev)] border border-white/[0.07] rounded-md text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-sky-500/50 transition-colors";

function NumInput({ value, onChange, className = "", placeholder = "0" }: { value: number; onChange: (n: number) => void; className?: string; placeholder?: string }) {
  return (
    <input
      type="text"
      inputMode="numeric"
      value={value === 0 ? "" : String(value)}
      placeholder={placeholder}
      onChange={e => {
        const cleaned = e.target.value.replace(/[^\d]/g, "");
        const parsed = parseInt(cleaned, 10);
        onChange(Number.isFinite(parsed) ? parsed : 0);
      }}
      className={`${INPUT_CLS} text-center font-mono ${className}`}
    />
  );
}

/** Vocação em pill compacta (antes eram cartões de 2 linhas). */
function VocPill({ voc, selected, onClick }: { voc: Vocation; selected: boolean; onClick: () => void }) {
  const color = VOC_COLORS[voc];
  return (
    <button
      type="button"
      onClick={onClick}
      title={VOC_LABEL[voc]}
      className={`flex-1 py-1.5 rounded-md border text-xs font-black tracking-wider transition-all cursor-pointer ${
        selected ? "bg-white/5" : "bg-white/[0.02] border-white/10 text-slate-500 hover:bg-white/5"
      }`}
      style={selected ? { borderColor: color, color, boxShadow: `0 0 0 2px ${color}26` } : undefined}
    >
      {voc}
    </button>
  );
}

/** Payload entregue ao salvar: vocação garantidamente escolhida. */
export type MyServiceSavePayload = Omit<MyServiceFormData, "voc"> & { voc: Vocation };

interface Props {
  open: boolean;
  initial?: SharedService | null;
  onClose: () => void;
  onSave: (data: MyServiceSavePayload) => void;
}

export default function MyServiceModal({ open, initial, onClose, onSave }: Props) {
  const [data, setData] = useState<MyServiceFormData>(blankServiceForm());
  const [error, setError] = useState("");
  const firstFieldRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setData(initial ? serviceToForm(initial) : blankServiceForm());
    setError("");
    const timer = window.setTimeout(() => firstFieldRef.current?.focus(), 80);
    return () => window.clearTimeout(timer);
  }, [open, initial]);

  useEffect(() => {
    if (!open) return;
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open) return null;

  function set<K extends keyof MyServiceFormData>(key: K, value: MyServiceFormData[K]) {
    setData(prev => ({ ...prev, [key]: value }));
  }

  // ── Obrigatórios: TODOS, exceto "Service Realizado" e "Anotações" ──────
  const isPersonagemValid = data.personagem.trim().length > 0;
  const isClienteValid = data.ownerName.trim().length > 0;
  const isDataValid = data.dataService.trim().length > 0;
  const isServidorValid = data.servidor.trim().length > 0;
  const isLevelValid = data.level > 0;
  const isVocValid = data.voc !== "";
  const isPagamentoValid = data.paymentMethod !== "";
  // Valor combinado só é exigido quando essa forma de pagamento é escolhida.
  const isValorCombinadoValid = data.paymentMethod !== "combinado" || data.valorCombinado > 0;
  const isPaisValid = data.whatsappCountry.trim().length > 0;
  const isDddValid = data.whatsappArea.trim().length > 0;
  const isWhatsappValid = data.whatsappNumber.trim().length > 0;

  const isFormValid =
    isPersonagemValid && isClienteValid && isDataValid && isServidorValid &&
    isLevelValid && isVocValid && isPagamentoValid && isValorCombinadoValid &&
    isPaisValid && isDddValid && isWhatsappValid;

  // Mesmo destaque do modal "Adicionar Personagem" (CharacterModal).
  const REQUIRED_PULSE_CLASS = "border-amber-400/70 shadow-[0_0_14px_color-mix(in_oklab,var(--color-amber-500)_22%,transparent)] animate-pulse";
  const req = (valid: boolean) => (valid ? "" : REQUIRED_PULSE_CLASS);

  function handleSave() {
    if (!isFormValid) return setError("Preencha todos os campos obrigatórios.");
    setError("");
    onSave({
      ...data,
      voc: data.voc as Vocation,
      personagem: data.personagem.trim(),
      ownerName: data.ownerName.trim(),
      notes: data.notes.trim(),
    });
  }

  const paymentOptions = Object.entries(SERVICE_PAYMENT_LABELS) as Array<[Exclude<ServicePaymentMethod, "">, string]>;
  // Prévia do que irá para a coluna VALOR — evita duplicar a regra aqui.
  const previewValue = resolveServiceValue(data.paymentMethod, data.valorCombinado);

  // PORTAL: o painel vive dentro de um container com CSS `zoom`, que quebra
  // o hit-testing de elementos `position: fixed` — cliques caem no elemento
  // errado e os campos nunca recebem foco. Renderizar em document.body
  // escapa do zoom, mesmo padrão já usado por CharTable e FilterTypes.
  return createPortal(
    <div
      className="app-modal-overlay fixed inset-0 z-[1000] flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="app-modal-frame app-modal-size-md app-modal-frame--scroll relative w-full max-w-xl bg-[var(--th-bg-base)] border border-[var(--th-line)]/100 rounded-xl shadow-2xl shadow-black/50">
        {/* Header compacto */}
        <div className="flex items-center justify-between px-4 py-2.5 bg-gradient-to-r from-[var(--th-bg-raised)] to-[var(--th-bg-base)] border-b border-[var(--th-line)]/60 flex-shrink-0">
          <div className="flex items-center gap-2">
            <Clock size={14} className="text-sky-400" />
            <h2 className="text-sm font-bold text-slate-100 tracking-tight">
              {initial ? "Editar Service" : "Adicionar Service"}
            </h2>
          </div>
          <button type="button" onClick={onClose} className="text-slate-500 hover:text-slate-200 transition-colors p-1 rounded-md hover:bg-white/[0.04] cursor-pointer">
            <X size={16} />
          </button>
        </div>

        <div className="app-modal-body custom-scrollbar px-4 py-3 space-y-3">
          {/* Identificação: personagem, cliente, data */}
          <div className="grid grid-cols-12 gap-2">
            <Field label="Personagem" className="col-span-5">
              <input
                ref={firstFieldRef}
                type="text"
                value={data.personagem}
                onChange={e => set("personagem", e.target.value)}
                className={`${INPUT_CLS} ${req(isPersonagemValid)}`}
                placeholder="Nome do personagem"
                maxLength={50}
              />
            </Field>
            <Field label="Cliente" className="col-span-4">
              <input
                type="text"
                value={data.ownerName}
                onChange={e => set("ownerName", e.target.value)}
                className={`${INPUT_CLS} ${req(isClienteValid)}`}
                placeholder="Quem solicitou"
                maxLength={50}
              />
            </Field>
            <Field label="Data" className="col-span-3">
              <input
                type="date"
                value={data.dataService}
                onChange={e => set("dataService", e.target.value)}
                className={`${INPUT_CLS} font-mono [color-scheme:dark] ${req(isDataValid)}`}
              />
            </Field>
          </div>

          {/* Servidor, level e quest na mesma faixa */}
          <div className="grid grid-cols-12 gap-2">
            <Field label="Servidor" className="col-span-5">
              <FilterSelect
                selected={data.servidor}
                onSelect={(value: string) => set("servidor", value)}
                options={SERVER_OPTIONS}
                placeholder="Selecione"
                searchable
                searchPlaceholder="Buscar servidor..."
                allLabel=""
                activeColor="cyan"
                // Este modal é z-[1000]; sem isso o dropdown (z-600 padrão)
                // ficaria atrás do overlay e a lista pareceria não abrir.
                dropdownZIndex={1050}
                className={`w-full flex items-center justify-between gap-1 px-2 py-1.5 rounded-md bg-[var(--th-n-elev)] border border-white/[0.07] hover:border-white/15 focus:border-sky-500/50 focus:outline-none transition-colors text-xs ${!data.servidor ? "text-slate-500" : "text-slate-200"} ${req(isServidorValid)}`}
              />
            </Field>
            <Field label="Level" className="col-span-2">
              <NumInput value={data.level} onChange={value => set("level", value)} className={req(isLevelValid)} />
            </Field>
            <Field label="Quest" className="col-span-5">
              <div className="grid grid-cols-2 gap-1">
                <button
                  type="button"
                  onClick={() => set("quest", "soulwar")}
                  className={`py-1.5 rounded-md border text-[11px] font-bold transition-colors cursor-pointer ${
                    data.quest === "soulwar"
                      ? "border-slate-400/60 bg-slate-500/10 text-slate-200"
                      : "border-white/10 bg-white/[0.02] text-slate-500 hover:bg-white/5"
                  }`}
                >
                  Soul War
                </button>
                <button
                  type="button"
                  onClick={() => set("quest", "sanguine")}
                  className={`py-1.5 rounded-md border text-[11px] font-bold transition-colors cursor-pointer ${
                    data.quest === "sanguine"
                      ? "border-rose-400/60 bg-rose-500/10 text-rose-200"
                      : "border-white/10 bg-white/[0.02] text-slate-500 hover:bg-white/5"
                  }`}
                >
                  Sanguine
                </button>
              </div>
            </Field>
          </div>

          {/* Vocação em linha única */}
          <Field label="Vocação">
            <div className={`flex gap-1 rounded-md ${isVocValid ? "" : `border ${REQUIRED_PULSE_CLASS} p-0.5`}`}>
              {VOCATIONS.map(voc => (
                <VocPill key={voc} voc={voc} selected={data.voc === voc} onClick={() => set("voc", voc)} />
              ))}
            </div>
          </Field>

          {/* Pagamento — seleção exclusiva. O campo de valor só aparece
              quando "Valor Combinado" está ativo. */}
          <Field label="Forma de Pagamento">
            <div className={`grid grid-cols-4 gap-1 rounded-md ${isPagamentoValid ? "" : `border ${REQUIRED_PULSE_CLASS} p-0.5`}`}>
              {paymentOptions.map(([value, label]) => {
                const selected = data.paymentMethod === value;
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => set("paymentMethod", selected ? "" : value)}
                    aria-pressed={selected}
                    className={`py-1.5 px-1 rounded-md border text-[10px] font-black tracking-tight transition-colors cursor-pointer truncate ${
                      selected
                        ? "border-sky-400/60 bg-sky-500/15 text-sky-200"
                        : "border-white/10 bg-white/[0.02] text-slate-500 hover:bg-white/5"
                    }`}
                    title={label}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </Field>

          {data.paymentMethod === "combinado" && (
            <Field label="Valor Combinado (RC)">
              <NumInput value={data.valorCombinado} onChange={value => set("valorCombinado", value)} placeholder="Informe o valor acordado" className={req(isValorCombinadoValid)} />
            </Field>
          )}

          {/* Feedback do que irá para a coluna VALOR. */}
          {data.paymentMethod !== "" && (
            <div className="flex items-center gap-1.5 text-[10px] text-slate-500 -mt-1">
              <span>Valor:</span>
              {previewValue > 0 ? (
                <span className="font-mono font-bold text-emerald-400">{previewValue.toLocaleString("pt-BR")} RC</span>
              ) : (
                <span className="italic">será informado na conclusão</span>
              )}
            </div>
          )}

          {/* WhatsApp — País e DDD estreitos, número ocupa o resto */}
          <div className="grid grid-cols-12 gap-2">
            <Field label="País" className="col-span-2">
              <input
                type="text"
                value={data.whatsappCountry}
                onChange={e => set("whatsappCountry", e.target.value.replace(/\D/g, "").slice(0, 4))}
                className={`${INPUT_CLS} text-center font-mono ${req(isPaisValid)}`}
                placeholder="55"
              />
            </Field>
            <Field label="DDD" className="col-span-2">
              <input
                type="text"
                value={data.whatsappArea}
                onChange={e => set("whatsappArea", e.target.value.replace(/\D/g, "").slice(0, 3))}
                className={`${INPUT_CLS} text-center font-mono ${req(isDddValid)}`}
                placeholder="92"
              />
            </Field>
            <Field label="WhatsApp" className="col-span-8">
              <input
                type="text"
                value={data.whatsappNumber}
                onChange={e => set("whatsappNumber", e.target.value.replace(/\D/g, "").slice(0, 12))}
                className={`${INPUT_CLS} font-mono ${req(isWhatsappValid)}`}
                placeholder="999999999"
              />
            </Field>
          </div>

          <Field label="Anotações">
            <textarea
              value={data.notes}
              onChange={e => set("notes", e.target.value)}
              rows={2}
              maxLength={300}
              className={`${INPUT_CLS} resize-none custom-scrollbar`}
              placeholder="Observações sobre o service"
            />
          </Field>

          {/* Conclusão — apenas o toggle, sem o antigo quadro de lucro. */}
          <button
            type="button"
            onClick={() => set("realizado", !data.realizado)}
            aria-pressed={data.realizado}
            className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-bold transition-colors cursor-pointer ${
              data.realizado
                ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-200"
                : "border-white/10 bg-white/[0.02] text-slate-400 hover:bg-white/5"
            }`}
          >
            <CheckCircle2 size={14} className={data.realizado ? "text-emerald-300" : "text-slate-600"} />
            Service Realizado
            <span className="ml-auto text-[9px] font-bold uppercase tracking-wider opacity-70">
              {data.realizado ? "Concluído" : "Pendente"}
            </span>
          </button>

          {error && (
            <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-2.5 py-1.5 text-[11px] font-semibold text-rose-300">
              {error}
            </div>
          )}
        </div>

        <div className="app-modal-footer flex flex-wrap items-center justify-end gap-2 px-4 py-2.5 border-t border-[var(--th-line)]/60 bg-[var(--th-bg-raised)]">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg border border-white/10 bg-white/5 text-slate-300 hover:text-white hover:bg-white/10 text-[11px] font-bold transition-colors cursor-pointer"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!isFormValid}
            title={isFormValid ? undefined : "Preencha todos os campos obrigatórios"}
            className="px-4 py-1.5 rounded-lg bg-gradient-to-r from-sky-600/90 to-sky-500/90 hover:from-sky-500 hover:to-sky-400 border border-sky-400/50 text-white text-[11px] font-black transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:from-sky-600/90 disabled:hover:to-sky-500/90"
          >
            {initial ? "Salvar" : "Adicionar"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}