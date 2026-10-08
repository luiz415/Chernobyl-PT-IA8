import { useEffect, useMemo, useState } from "react";
import { X, Check, SlidersHorizontal, Server, AlertTriangle, Settings2 } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { db, isSimulationMode } from "../firebase/config";
import { doc } from "firebase/firestore";
import { getDoc, setDoc } from "../firebase/config";
import { getEffectiveUserRole } from "../utils/vipAccess";
import { SERVER_OPTIONS, serverKey } from "../constants/servers";
import { VOCATIONS, VOC_COLORS, VOC_LABEL } from "../types";
import type { Vocation } from "../types";
import type { PublicQuest } from "../utils/publicServiceLevels";
import {
  SERVICE_FORM_CONFIG_DEFAULTS,
  MAX_DISABLED_REASON_LEN,
  MIN_CONFIG_LEVEL,
  MAX_CONFIG_LEVEL,
  resolveServiceFormConfig,
  formatConfigRcLong,
  formatConfigPixLong,
  type ServiceFormConfig,
  type ResolvedServiceFormConfig,
} from "../utils/serviceFormConfig";

// ============================================================================
// CONFIGURAR MEU FORMULÁRIO — modal + botão (Meus Services)
//
// Permite ao serviceiro personalizar o PRÓPRIO formulário público (o link
// exclusivo #/servico/{slug}):
//
//   • habilitar/desabilitar os Services de Soul War e Sanguine — esta
//     configuração é a ÚNICA fonte da disponibilidade de cada Quest no
//     formulário (não há bloqueio fixo no código);
//   • motivo OPCIONAL da indisponibilidade de cada Quest desabilitada —
//     exibido no tooltip do formulário (vazio = aviso genérico);
//   • valores de cada Quest — Sanguine com 1ª rotação e rotação posterior
//     SEPARADAS (RC e Pix em cada caso);
//   • level mínimo POR VOCAÇÃO de cada Quest — exibido no formulário e
//     usado na validação do cadastro do personagem;
//   • servidores atendidos — os não selecionados continuam aparecendo no
//     formulário como "Nome (Indisponível)", sem poderem ser escolhidos.
//
// A configuração é gravada em `users/{uid}.serviceFormConfig` (escrita do
// PRÓPRIO documento — as regras do Firestore já permitem campos fora de
// role/status, mesmo padrão do twitchChannel/questMinLevels; nenhuma Cloud
// Function é necessária) e aplicada EM TEMPO REAL no link exclusivo: o
// PublicServiceForm a lê no mesmo carregamento da lista de elegíveis.
// Ao ABRIR, o modal relê o documento (1 read, padrão do TwitchModal) para
// refletir alterações feitas em outro dispositivo.
//
// As demais informações do formulário (termos, 50/50, refil, acesso 5kk,
// drops etc.) são institucionais e NÃO são editáveis aqui de propósito.
// ============================================================================

interface Props {
  open: boolean;
  onClose: () => void;
}

/** Converte número para o texto do input (Pix usa vírgula decimal pt-BR). */
function pixToInput(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(".", ",");
}

/** Parse do input de Pix ("91", "91,50"). NaN quando inválido. */
function parsePixInput(s: string): number {
  const cleaned = s.trim().replace(/\./g, "").replace(",", ".");
  if (!cleaned) return NaN;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}

/** Parse do input de RC (inteiro). NaN quando inválido. */
function parseRcInput(s: string): number {
  const cleaned = s.trim().replace(/\D/g, "");
  if (!cleaned) return NaN;
  const n = parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : NaN;
}

/** Parse do input de level (inteiro). NaN quando inválido. */
function parseLevelInput(s: string): number {
  const cleaned = s.trim().replace(/\D/g, "");
  if (!cleaned) return NaN;
  const n = parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : NaN;
}

/** O texto do input é um level mínimo válido? */
function levelInputValid(s: string): boolean {
  const n = parseLevelInput(s);
  return n >= MIN_CONFIG_LEVEL && n <= MAX_CONFIG_LEVEL;
}

/** Levels mínimos por vocação como strings de input. */
type MinLevelInputs = Record<Vocation, string>;

/** Converte a tabela resolvida de levels para os textos dos inputs. */
function minLevelsToInputs(levels: Record<Vocation, number>): MinLevelInputs {
  const out = {} as MinLevelInputs;
  VOCATIONS.forEach(voc => { out[voc] = String(levels[voc]); });
  return out;
}

/**
 * Grade de inputs de LEVEL MÍNIMO por vocação (uma Quest). Os valores são
 * exibidos no formulário público (Level Mínimo Exigido) e usados na
 * validação do cadastro do personagem daquela Quest.
 */
function MinLevelsGrid({
  idPrefix,
  values,
  onChange,
  disabled,
}: {
  idPrefix: string;
  values: MinLevelInputs;
  onChange: (voc: Vocation, v: string) => void;
  disabled: boolean;
}) {
  return (
    <div>
      <div className="text-[10px] font-black uppercase tracking-wider text-violet-400/80 mb-1.5">📊 Level mínimo no formulário (por vocação)</div>
      <div className="grid grid-cols-3 sm:grid-cols-5 gap-1.5">
        {VOCATIONS.map(voc => {
          const invalid = !disabled && !levelInputValid(values[voc]);
          return (
            <div key={voc}>
              <label
                htmlFor={`${idPrefix}-min-${voc}`}
                className="block text-[10px] font-black tracking-wider mb-1 text-center"
                style={{ color: disabled ? undefined : VOC_COLORS[voc] }}
                title={VOC_LABEL[voc]}
              >
                {voc}
              </label>
              <input
                id={`${idPrefix}-min-${voc}`}
                type="text"
                inputMode="numeric"
                value={values[voc]}
                onChange={e => onChange(voc, e.target.value.replace(/\D/g, "").slice(0, 5))}
                placeholder="Ex: 500"
                disabled={disabled}
                className={`w-full px-2 py-2 rounded-lg bg-black/40 border text-sm font-mono text-center tabular-nums transition-colors focus:outline-none ${
                  disabled
                    ? "border-white/10 text-slate-600 cursor-not-allowed"
                    : invalid
                      ? "border-rose-500/60 text-rose-200 focus:border-rose-400"
                      : "border-white/15 text-slate-200 hover:border-white/30 focus:border-violet-400/70"
                }`}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Campo de MOTIVO da indisponibilidade — exibido somente com a Quest
 * desabilitada. Opcional: vazio = o formulário usa o aviso genérico.
 */
function DisabledReasonField({
  idPrefix,
  value,
  onChange,
}: {
  idPrefix: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="animate-in fade-in slide-in-from-top-1 duration-200">
      <label htmlFor={`${idPrefix}-reason`} className="block text-[10px] font-black uppercase tracking-wider text-amber-400/90 mb-1">
        💬 Motivo da indisponibilidade (opcional)
      </label>
      <textarea
        id={`${idPrefix}-reason`}
        value={value}
        onChange={e => onChange(e.target.value.slice(0, MAX_DISABLED_REASON_LEN))}
        rows={2}
        maxLength={MAX_DISABLED_REASON_LEN}
        placeholder="Ex: estou de férias até o fim do mês; volto a atender em breve..."
        className="w-full px-3 py-2 rounded-lg bg-black/40 border border-white/15 hover:border-white/30 focus:border-amber-400/70 text-sm text-slate-200 placeholder-slate-600 transition-colors focus:outline-none resize-none"
      />
      <div className="flex items-center justify-between gap-2 mt-1">
        <p className="text-[10px] text-slate-500 leading-relaxed">
          Aparece no aviso da Quest bloqueada no seu formulário. Vazio = aviso genérico padrão.
        </p>
        <span className="text-[10px] text-slate-600 tabular-nums flex-shrink-0">{value.length}/{MAX_DISABLED_REASON_LEN}</span>
      </div>
    </div>
  );
}

/** Switch habilitar/desabilitar no padrão visual do app. */
function Toggle({ on, onChange, label }: { on: boolean; onChange: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onChange}
      role="switch"
      aria-checked={on}
      className={`inline-flex items-center gap-2 px-2.5 py-1.5 rounded-lg border transition-colors cursor-pointer flex-shrink-0 ${
        on
          ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20"
          : "border-white/15 bg-white/5 text-slate-400 hover:bg-white/10"
      }`}
      title={on ? `Desabilitar ${label} no seu formulário` : `Habilitar ${label} no seu formulário`}
    >
      <span className={`relative inline-flex w-8 h-[18px] rounded-full transition-colors ${on ? "bg-emerald-500/80" : "bg-slate-600/80"}`}>
        <span className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-all ${on ? "left-[16px]" : "left-[2px]"}`} />
      </span>
      <span className="text-[10px] font-black uppercase tracking-wider">{on ? "Habilitada" : "Desabilitada"}</span>
    </button>
  );
}

/** Par de inputs RC / Pix com preview do texto exibido no formulário. */
function ValuePair({
  idPrefix,
  rcValue,
  pixValue,
  onRcChange,
  onPixChange,
  disabled,
  invalidRc,
  invalidPix,
}: {
  idPrefix: string;
  rcValue: string;
  pixValue: string;
  onRcChange: (v: string) => void;
  onPixChange: (v: string) => void;
  disabled: boolean;
  invalidRc: boolean;
  invalidPix: boolean;
}) {
  const inputCls = (invalid: boolean) =>
    `w-full px-3 py-2 rounded-lg bg-black/40 border text-sm font-mono transition-colors focus:outline-none ${
      disabled
        ? "border-white/10 text-slate-600 cursor-not-allowed"
        : invalid
          ? "border-rose-500/60 text-rose-200 focus:border-rose-400"
          : "border-white/15 text-slate-200 hover:border-white/30 focus:border-emerald-400/70"
    }`;
  return (
    <div className="grid grid-cols-2 gap-2.5">
      <div>
        <label htmlFor={`${idPrefix}-rc`} className="block text-[10px] font-black uppercase tracking-wider text-amber-400/90 mb-1">🪙 Rubini Coins</label>
        <input
          id={`${idPrefix}-rc`}
          type="text"
          inputMode="numeric"
          value={rcValue}
          onChange={e => onRcChange(e.target.value.replace(/\D/g, "").slice(0, 7))}
          placeholder="Ex: 1000"
          disabled={disabled}
          className={inputCls(invalidRc)}
        />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-pix`} className="block text-[10px] font-black uppercase tracking-wider text-emerald-400/90 mb-1">💸 Pix (R$)</label>
        <input
          id={`${idPrefix}-pix`}
          type="text"
          inputMode="decimal"
          value={pixValue}
          onChange={e => onPixChange(e.target.value.replace(/[^\d,]/g, "").replace(/,(?=.*,)/g, "").slice(0, 10))}
          placeholder="Ex: 91 ou 91,50"
          disabled={disabled}
          className={inputCls(invalidPix)}
        />
      </div>
    </div>
  );
}

export default function ServiceFormConfigModal({ open, onClose }: Props) {
  const { currentUser } = useAuth();

  // Habilitação das quests
  const [swEnabled, setSwEnabled] = useState(true);
  const [sgEnabled, setSgEnabled] = useState(true);
  // Motivos da indisponibilidade (opcionais; exibidos com a Quest desabilitada)
  const [swReason, setSwReason] = useState("");
  const [sgReason, setSgReason] = useState("");
  // Valores (strings de input; parse no salvar)
  const [swRc, setSwRc] = useState("");
  const [swPix, setSwPix] = useState("");
  const [sgFirstRc, setSgFirstRc] = useState("");
  const [sgFirstPix, setSgFirstPix] = useState("");
  const [sgExtraRc, setSgExtraRc] = useState("");
  const [sgExtraPix, setSgExtraPix] = useState("");
  // Levels mínimos por vocação (strings de input; parse no salvar) — cada
  // Quest tem a PRÓPRIA grade, totalmente independente da outra.
  const [swMinLv, setSwMinLv] = useState<MinLevelInputs>(() => minLevelsToInputs(SERVICE_FORM_CONFIG_DEFAULTS.minLevels.soulwar));
  const [sgMinLv, setSgMinLv] = useState<MinLevelInputs>(() => minLevelsToInputs(SERVICE_FORM_CONFIG_DEFAULTS.minLevels.sanguine));
  // Servidores atendidos (chaves canônicas via serverKey)
  const [serverKeys, setServerKeys] = useState<Set<string>>(new Set());

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  /** Preenche os estados a partir de uma configuração resolvida. */
  function applyResolved(cfg: ResolvedServiceFormConfig) {
    setSwEnabled(cfg.soulwarEnabled);
    setSgEnabled(cfg.sanguineEnabled);
    setSwReason(cfg.soulwarDisabledReason);
    setSgReason(cfg.sanguineDisabledReason);
    setSwRc(String(cfg.swRc));
    setSwPix(pixToInput(cfg.swPix));
    setSgFirstRc(String(cfg.sgFirstRc));
    setSgFirstPix(pixToInput(cfg.sgFirstPix));
    setSgExtraRc(String(cfg.sgExtraRc));
    setSgExtraPix(pixToInput(cfg.sgExtraPix));
    setSwMinLv(minLevelsToInputs(cfg.minLevels.soulwar));
    setSgMinLv(minLevelsToInputs(cfg.minLevels.sanguine));
    setServerKeys(new Set(cfg.servers.map(s => serverKey(s))));
  }

  // Carregar a configuração salva ao abrir (relê o documento para refletir
  // alterações feitas em outro dispositivo — mesmo padrão do TwitchModal).
  useEffect(() => {
    if (!open || !currentUser?.uid) return;
    setSaved(false);
    setError("");

    if (isSimulationMode || !db) {
      try {
        const raw = localStorage.getItem("tibia_sim_users");
        const parsed: any[] = raw ? JSON.parse(raw) : [];
        const me = parsed.find(u => u.uid === currentUser.uid);
        applyResolved(resolveServiceFormConfig(me?.serviceFormConfig));
      } catch {
        applyResolved(SERVICE_FORM_CONFIG_DEFAULTS);
      }
      return;
    }

    let isMounted = true;
    setLoading(true);
    async function loadConfig() {
      try {
        const snap = await getDoc(doc(db, "users", currentUser.uid));
        if (!isMounted) return;
        applyResolved(resolveServiceFormConfig(snap.exists() ? (snap.data() as any).serviceFormConfig : undefined));
      } catch {
        if (isMounted) applyResolved(SERVICE_FORM_CONFIG_DEFAULTS);
      } finally {
        if (isMounted) setLoading(false);
      }
    }
    loadConfig();
    return () => { isMounted = false; };
  }, [open, currentUser?.uid]);

  // Validações derivadas (campos de quest DESABILITADA não bloqueiam o salvar)
  const swRcInvalid = swEnabled && !(parseRcInput(swRc) >= 1);
  const swPixInvalid = swEnabled && !(parsePixInput(swPix) > 0);
  const sgFirstRcInvalid = sgEnabled && !(parseRcInput(sgFirstRc) >= 1);
  const sgFirstPixInvalid = sgEnabled && !(parsePixInput(sgFirstPix) > 0);
  const sgExtraRcInvalid = sgEnabled && !(parseRcInput(sgExtraRc) >= 1);
  const sgExtraPixInvalid = sgEnabled && !(parsePixInput(sgExtraPix) > 0);
  const swMinInvalid = swEnabled && VOCATIONS.some(v => !levelInputValid(swMinLv[v]));
  const sgMinInvalid = sgEnabled && VOCATIONS.some(v => !levelInputValid(sgMinLv[v]));
  const noServers = serverKeys.size === 0;
  const hasInvalid = swRcInvalid || swPixInvalid || sgFirstRcInvalid || sgFirstPixInvalid || sgExtraRcInvalid || sgExtraPixInvalid || swMinInvalid || sgMinInvalid || noServers;

  // Preview dos textos exatamente como o formulário público exibirá
  const previews = useMemo(() => {
    const d = SERVICE_FORM_CONFIG_DEFAULTS;
    const rc = (s: string, fb: number) => formatConfigRcLong(parseRcInput(s) >= 1 ? parseRcInput(s) : fb);
    const pix = (s: string, fb: number) => formatConfigPixLong(parsePixInput(s) > 0 ? parsePixInput(s) : fb);
    return {
      sw: `${rc(swRc, d.swRc)} Rubini Coins ou Pix ${pix(swPix, d.swPix)} + 12kk de refil`,
      sgFirst: `${rc(sgFirstRc, d.sgFirstRc)} Rubini Coins ou Pix ${pix(sgFirstPix, d.sgFirstPix)} + 12kk de refil`,
      sgExtra: `${rc(sgExtraRc, d.sgExtraRc)} Rubini Coins ou Pix ${pix(sgExtraPix, d.sgExtraPix)}`,
    };
  }, [swRc, swPix, sgFirstRc, sgFirstPix, sgExtraRc, sgExtraPix]);

  if (!open) return null;

  function handleClose() {
    setSaved(false);
    setError("");
    onClose();
  }

  function toggleServer(server: string) {
    const key = serverKey(server);
    setServerKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
    if (error) setError("");
  }

  async function handleSave() {
    if (!currentUser?.uid || saving) return;

    if (noServers) {
      setError("Selecione pelo menos um servidor atendido.");
      return;
    }
    if (swMinInvalid || sgMinInvalid) {
      setError("Preencha os levels mínimos das quests habilitadas (números maiores que zero).");
      return;
    }
    if (hasInvalid) {
      setError("Preencha os valores das quests habilitadas (RC e Pix maiores que zero).");
      return;
    }

    // Monta a configuração completa. Campos de quest desabilitada são salvos
    // com o valor digitado se válido, senão com o padrão — nunca inválidos.
    // Os levels mínimos de cada Quest são montados de forma INDEPENDENTE
    // (alterar uma Quest nunca toca na configuração da outra).
    const d = SERVICE_FORM_CONFIG_DEFAULTS;
    const rcOr = (s: string, fb: number) => (parseRcInput(s) >= 1 ? parseRcInput(s) : fb);
    const pixOr = (s: string, fb: number) => (parsePixInput(s) > 0 ? parsePixInput(s) : fb);
    const minLevelsFor = (inputs: MinLevelInputs, quest: PublicQuest): Record<Vocation, number> => {
      const out = {} as Record<Vocation, number>;
      VOCATIONS.forEach(voc => {
        out[voc] = levelInputValid(inputs[voc]) ? parseLevelInput(inputs[voc]) : d.minLevels[quest][voc];
      });
      return out;
    };
    const cfg: ServiceFormConfig = {
      soulwarEnabled: swEnabled,
      sanguineEnabled: sgEnabled,
      soulwarDisabledReason: swReason.trim().slice(0, MAX_DISABLED_REASON_LEN),
      sanguineDisabledReason: sgReason.trim().slice(0, MAX_DISABLED_REASON_LEN),
      swRc: rcOr(swRc, d.swRc),
      swPix: pixOr(swPix, d.swPix),
      sgFirstRc: rcOr(sgFirstRc, d.sgFirstRc),
      sgFirstPix: pixOr(sgFirstPix, d.sgFirstPix),
      sgExtraRc: rcOr(sgExtraRc, d.sgExtraRc),
      sgExtraPix: pixOr(sgExtraPix, d.sgExtraPix),
      minLevels: {
        soulwar: minLevelsFor(swMinLv, "soulwar"),
        sanguine: minLevelsFor(sgMinLv, "sanguine"),
      },
      servers: SERVER_OPTIONS.filter(s => serverKeys.has(serverKey(s))),
      updatedAt: Date.now(),
    };

    setSaving(true);
    setError("");
    try {
      if (isSimulationMode || !db) {
        const raw = localStorage.getItem("tibia_sim_users");
        const parsed: any[] = raw ? JSON.parse(raw) : [];
        const next = parsed.map(u => (u.uid === currentUser.uid ? { ...u, serviceFormConfig: cfg } : u));
        localStorage.setItem("tibia_sim_users", JSON.stringify(next));
      } else {
        await setDoc(doc(db, "users", currentUser.uid), { serviceFormConfig: cfg }, { merge: true });
      }
      setSaved(true);
      setTimeout(() => { handleClose(); }, 1400);
    } catch {
      setError("Não foi possível salvar agora. Verifique a conexão e tente novamente.");
    } finally {
      setSaving(false);
    }
  }

  const allSelected = serverKeys.size === SERVER_OPTIONS.length;

  return (
    <div
      className="app-modal-overlay fixed inset-0 z-[350] flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === e.currentTarget) handleClose(); }}
    >
      <div className="app-modal-frame app-modal-frame--scroll w-full max-w-xl bg-[var(--th-n-base)] border border-[var(--th-line)]/100 rounded-2xl shadow-[0_0_40px_color-mix(in_oklab,var(--th-brand)_30%,transparent)]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[var(--th-line)]/60 bg-gradient-to-r from-[var(--th-bg-base)] to-[var(--th-n-base)] flex-shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg border border-emerald-500/40 bg-emerald-500/10 flex items-center justify-center">
              <SlidersHorizontal size={16} className="text-emerald-400" />
            </div>
            <h3 className="text-base font-bold text-white tracking-wide">Configurar Meu Formulário</h3>
          </div>
          <button
            onClick={handleClose}
            className="text-slate-500 hover:text-white p-1.5 rounded-lg hover:bg-[var(--th-line)]/25 transition-colors cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="app-modal-body">
          {saved ? (
            <div className="flex flex-col items-center justify-center py-14 px-6 gap-3">
              <div className="w-14 h-14 rounded-full bg-emerald-500/15 border border-emerald-500/40 flex items-center justify-center animate-in zoom-in duration-300 shadow-[0_0_20px_rgba(16,185,129,0.15)]">
                <Check size={28} className="text-emerald-400" />
              </div>
              <h4 className="text-lg font-bold text-white">Formulário atualizado!</h4>
              <p className="text-sm text-slate-500 text-center max-w-xs">
                As alterações já valem para quem abrir o seu link exclusivo agora.
              </p>
            </div>
          ) : (
            <div className="px-5 py-4 space-y-4">
              <p className="text-[11px] text-slate-500 leading-relaxed">
                Estas opções valem apenas para o <strong className="text-slate-300">seu link exclusivo</strong> (Formulário
                Pessoal) e são aplicadas <strong className="text-slate-300">em tempo real</strong>. Termos, regras, 50/50 e
                demais informações institucionais do formulário permanecem fixos.
              </p>

              {loading ? (
                <div className="py-10 text-center text-sm text-slate-500">Carregando configuração…</div>
              ) : (
                <>
                  {/* ── SOUL WAR ── */}
                  <div className={`rounded-2xl border p-4 space-y-3 transition-colors ${swEnabled ? "border-slate-400/30 bg-slate-500/[0.07]" : "border-white/10 bg-white/[0.03]"}`}>
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <div className="flex items-center gap-2">
                        <span className={`text-xl ${swEnabled ? "" : "grayscale opacity-60"}`}>⚔️</span>
                        <span className={`text-sm font-black tracking-wider ${swEnabled ? "text-slate-100" : "text-slate-500"}`}>SOUL WAR</span>
                      </div>
                      <Toggle on={swEnabled} onChange={() => { setSwEnabled(v => !v); if (error) setError(""); }} label="a Soul War" />
                    </div>
                    <ValuePair
                      idPrefix="sfc-sw"
                      rcValue={swRc}
                      pixValue={swPix}
                      onRcChange={v => { setSwRc(v); if (error) setError(""); }}
                      onPixChange={v => { setSwPix(v); if (error) setError(""); }}
                      disabled={!swEnabled}
                      invalidRc={swRcInvalid}
                      invalidPix={swPixInvalid}
                    />
                    <MinLevelsGrid
                      idPrefix="sfc-sw"
                      values={swMinLv}
                      onChange={(voc, v) => { setSwMinLv(prev => ({ ...prev, [voc]: v })); if (error) setError(""); }}
                      disabled={!swEnabled}
                    />
                    {swEnabled && (
                      <p className="text-[10px] text-slate-500 leading-relaxed">
                        No formulário: <span className="text-slate-300 font-semibold">{previews.sw}</span>
                      </p>
                    )}
                    {!swEnabled && (
                      <>
                        <p className="text-[10px] text-amber-400/80 leading-relaxed">
                          A Soul War aparecerá como <strong>indisponível</strong> no seu formulário.
                        </p>
                        <DisabledReasonField
                          idPrefix="sfc-sw"
                          value={swReason}
                          onChange={v => { setSwReason(v); if (error) setError(""); }}
                        />
                      </>
                    )}
                  </div>

                  {/* ── SANGUINE ── */}
                  <div className={`rounded-2xl border p-4 space-y-3 transition-colors ${sgEnabled ? "border-rose-500/30 bg-rose-500/[0.06]" : "border-white/10 bg-white/[0.03]"}`}>
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <div className="flex items-center gap-2">
                        <span className={`text-xl ${sgEnabled ? "" : "grayscale opacity-60"}`}>🩸</span>
                        <span className={`text-sm font-black tracking-wider ${sgEnabled ? "text-rose-200" : "text-slate-500"}`}>SANGUINE</span>
                      </div>
                      <Toggle on={sgEnabled} onChange={() => { setSgEnabled(v => !v); if (error) setError(""); }} label="a Sanguine" />
                    </div>
                    <div>
                      <div className="text-[10px] font-black uppercase tracking-wider text-sky-400/80 mb-1.5">Primeira Rotação</div>
                      <ValuePair
                        idPrefix="sfc-sg1"
                        rcValue={sgFirstRc}
                        pixValue={sgFirstPix}
                        onRcChange={v => { setSgFirstRc(v); if (error) setError(""); }}
                        onPixChange={v => { setSgFirstPix(v); if (error) setError(""); }}
                        disabled={!sgEnabled}
                        invalidRc={sgFirstRcInvalid}
                        invalidPix={sgFirstPixInvalid}
                      />
                    </div>
                    <div>
                      <div className="text-[10px] font-black uppercase tracking-wider text-rose-400/80 mb-1.5">Cada Rotação Posterior (sem drop)</div>
                      <ValuePair
                        idPrefix="sfc-sg2"
                        rcValue={sgExtraRc}
                        pixValue={sgExtraPix}
                        onRcChange={v => { setSgExtraRc(v); if (error) setError(""); }}
                        onPixChange={v => { setSgExtraPix(v); if (error) setError(""); }}
                        disabled={!sgEnabled}
                        invalidRc={sgExtraRcInvalid}
                        invalidPix={sgExtraPixInvalid}
                      />
                    </div>
                    <MinLevelsGrid
                      idPrefix="sfc-sg"
                      values={sgMinLv}
                      onChange={(voc, v) => { setSgMinLv(prev => ({ ...prev, [voc]: v })); if (error) setError(""); }}
                      disabled={!sgEnabled}
                    />
                    {sgEnabled && (
                      <p className="text-[10px] text-slate-500 leading-relaxed">
                        No formulário: <span className="text-slate-300 font-semibold">{previews.sgFirst}</span>
                        <br />
                        Rotação posterior: <span className="text-slate-300 font-semibold">{previews.sgExtra}</span>
                      </p>
                    )}
                    {!sgEnabled && (
                      <>
                        <p className="text-[10px] text-amber-400/80 leading-relaxed">
                          A Sanguine aparecerá como <strong>indisponível</strong> no seu formulário.
                        </p>
                        <DisabledReasonField
                          idPrefix="sfc-sg"
                          value={sgReason}
                          onChange={v => { setSgReason(v); if (error) setError(""); }}
                        />
                      </>
                    )}
                  </div>

                  {!swEnabled && !sgEnabled && (
                    <div className="flex items-start gap-2.5 bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3 text-[11px] text-amber-200/90 leading-relaxed">
                      <AlertTriangle size={15} className="flex-shrink-0 mt-0.5 text-amber-400" />
                      <span>Com as duas quests desabilitadas, o seu formulário não aceitará novos cadastros até você reativar pelo menos uma.</span>
                    </div>
                  )}

                  {/* ── SERVIDORES ATENDIDOS ── */}
                  <div className="rounded-2xl border border-cyan-500/25 bg-cyan-500/[0.05] p-4 space-y-3">
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <div className="flex items-center gap-2">
                        <Server size={15} className="text-cyan-400" />
                        <span className="text-sm font-black tracking-wider text-cyan-200">SERVIDORES ATENDIDOS</span>
                        <span className="text-[10px] font-bold text-slate-500">({serverKeys.size}/{SERVER_OPTIONS.length})</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => { setServerKeys(allSelected ? new Set() : new Set(SERVER_OPTIONS.map(s => serverKey(s)))); if (error) setError(""); }}
                        className="px-2.5 py-1 rounded-lg border border-cyan-500/40 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 text-[10px] font-black uppercase tracking-wider transition-colors cursor-pointer"
                      >
                        {allSelected ? "Desmarcar todos" : "Marcar todos"}
                      </button>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                      {SERVER_OPTIONS.map(server => {
                        const selected = serverKeys.has(serverKey(server));
                        return (
                          <button
                            key={server}
                            type="button"
                            onClick={() => toggleServer(server)}
                            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[11px] font-bold transition-colors cursor-pointer ${
                              selected
                                ? "border-cyan-500/50 bg-cyan-500/15 text-cyan-200 hover:bg-cyan-500/25"
                                : "border-white/10 bg-white/[0.04] text-slate-500 hover:bg-white/10 hover:text-slate-300"
                            }`}
                          >
                            <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 ${selected ? "border-cyan-400 bg-cyan-500/40" : "border-slate-600"}`}>
                              {selected && <Check size={10} className="text-white" />}
                            </span>
                            <span className="truncate">{server}</span>
                          </button>
                        );
                      })}
                    </div>
                    <p className="text-[10px] text-slate-500 leading-relaxed">
                      Servidores não selecionados continuam visíveis no formulário como
                      {" "}<span className="text-slate-400 font-semibold">"Nome (Indisponível)"</span> — o cliente não consegue escolhê-los.
                    </p>
                    {noServers && (
                      <p className="text-[10px] text-rose-400 font-semibold">Selecione pelo menos um servidor.</p>
                    )}
                  </div>

                  {error && (
                    <div className="flex items-start gap-2.5 bg-rose-500/10 border border-rose-500/40 rounded-xl px-4 py-3 text-[11px] text-rose-300 leading-relaxed">
                      <AlertTriangle size={15} className="flex-shrink-0 mt-0.5" />
                      <span>{error}</span>
                    </div>
                  )}

                  {/* Footer */}
                  <div className="flex items-center justify-end gap-2 pt-1">
                    <button
                      type="button"
                      onClick={handleClose}
                      className="px-4 py-2 rounded-lg border border-white/15 bg-white/5 hover:bg-white/10 text-slate-400 hover:text-slate-200 text-xs font-bold transition-colors cursor-pointer"
                    >
                      Cancelar
                    </button>
                    <button
                      type="button"
                      onClick={handleSave}
                      disabled={saving}
                      className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border text-xs font-black tracking-wide transition-colors ${
                        saving
                          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-500/60 cursor-wait"
                          : "border-emerald-500/60 bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 cursor-pointer"
                      }`}
                    >
                      <Check size={14} /> {saving ? "Salvando…" : "Salvar Configuração"}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Botão "Configurar Meu Formulário" — autocontido (gerencia o próprio modal).
 * Renderiza null para inelegíveis, com a MESMA regra de elegibilidade do
 * ExclusiveServiceFormLinkButton (Boss aprovado ou VIP ativo + serviceiro):
 * só quem tem link exclusivo tem formulário para configurar.
 */
export function ServiceFormConfigButton() {
  const { userProfile } = useAuth();
  const [configOpen, setConfigOpen] = useState(false);

  const isEligible = useMemo(() => {
    if (!userProfile || userProfile.status !== "aprovado") return false;
    const role = getEffectiveUserRole(userProfile);
    return role === "Boss" || (role === "VIP" && userProfile.serviceiro === true);
  }, [userProfile]);

  if (!isEligible) return null;

  return (
    <>
      <button
        onClick={() => setConfigOpen(true)}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/50 text-cyan-300 transition-colors whitespace-nowrap cursor-pointer"
        title="Configurar o seu formulário público: quests habilitadas, valores e servidores atendidos"
      >
        <Settings2 size={14} /> Configurar Meu Formulário
      </button>
      <ServiceFormConfigModal open={configOpen} onClose={() => setConfigOpen(false)} />
    </>
  );
}
