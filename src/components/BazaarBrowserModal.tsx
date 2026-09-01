import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Globe, X, AlertTriangle, Check, Play, ChevronUp, ChevronDown, RotateCcw, FlaskConical } from "lucide-react";
import { loadUIState, saveUIState } from "../storage";

// ============================================================================
// SELEÇÃO DE NAVEGADOR PARA A CONSULTA DO BAZAAR
//
// Aberto ao clicar em "Consultar Bazaar", ANTES de a consulta começar.
// Navegadores diferentes se comportam de forma diferente no RubinOT, então a
// escolha é do usuário.
//
// A disponibilidade de cada mecanismo é verificada no processo principal
// (sem abrir janela). Os indisponíveis aparecem desabilitados, com a instrução
// do que fazer — nunca há troca silenciosa por outro navegador.
//
// Exclusivo do Electron: no navegador Web este modal não é usado.
// ============================================================================

export const BAZAAR_BROWSER_KEY = "rubinot_bazaar_browser";
/** Ordem de preferência usada para escolher o navegador do retry. */
export const BAZAAR_BROWSER_ORDER_KEY = "rubinot_bazaar_browser_order";
export const DEFAULT_BROWSER_ORDER = ["webkit", "firefox", "edge", "chrome"];
/**
 * Navegadores marcados para os RETRIES finais.
 *
 * Vazio = comportamento antigo (um único retry, escolhido pela ordem de
 * preferência). Marcados = cadeia sequencial, na ordem da lista.
 */
export const BAZAAR_RETRY_BROWSERS_KEY = "rubinot_bazaar_retry_browsers";

/**
 * QUANTIDADE de retries de cada navegador.
 *
 * `{ webkit: 2, firefox: 1, edge: 0, chrome: 0 }` significa: dois retries com
 * o WebKit, um com o Firefox e nenhum com os demais. Cada tentativa recebe
 * apenas os personagens que AINDA estão falhando.
 *
 * `0` = aquele navegador não faz retry algum.
 */
export const BAZAAR_RETRY_COUNTS_KEY = "rubinot_bazaar_retry_counts";

/**
 * Teto por navegador. Espelha `RUBINOT_MAX_RETRIES_PER_BROWSER` do processo
 * principal, que trunca qualquer valor acima disso. Cada tentativa reabre
 * TODOS os links pendentes, então números altos multiplicam o tempo da
 * consulta sem ganho proporcional.
 */
export const BAZAAR_MAX_RETRIES_PER_BROWSER = 5;

export type BazaarRetryCounts = Record<string, number>;

/** Mapa completo (os 4 navegadores) com valores truncados em 0..MAX. */
export function normalizeRetryCounts(raw: unknown): BazaarRetryCounts {
  const source = (raw && typeof raw === "object" && !Array.isArray(raw)) ? raw as Record<string, unknown> : {};
  const result: BazaarRetryCounts = {};
  for (const key of DEFAULT_BROWSER_ORDER) {
    const value = Math.floor(Number(source[key]));
    result[key] = Number.isFinite(value) && value > 0
      ? Math.min(BAZAAR_MAX_RETRIES_PER_BROWSER, value)
      : 0;
  }
  return result;
}

/**
 * Modo de velocidade da consulta.
 *
 * "agressivo" reduz cada espera ao menor valor seguro e abandona rápido
 * páginas inválidas. "moderado" usa tempos mais folgados e prioriza
 * estabilidade. Os valores ficam centralizados no processo principal
 * (RUBINOT_SPEED_MODES).
 */
export const BAZAAR_SPEED_MODE_KEY = "rubinot_bazaar_speed_mode";
export type BazaarSpeedMode = "agressivo" | "moderado";

/**
 * MÉTODO DE CONSULTA — "antigo" (atual) ou "novo" (API JSON).
 *
 * Padrão `"antigo"`: quem não mexer em nada continua exatamente no fluxo de
 * hoje. O método novo troca APENAS a fase de detalhes (página individual
 * renderizada -> chamada JSON), mantendo listagem, filtros e resultados.
 */
export const BAZAAR_METHOD_KEY = "rubinot_bazaar_method";
export type BazaarMethod = "antigo" | "novo";
export const DEFAULT_BAZAAR_METHOD: BazaarMethod = "antigo";

/** Normaliza o valor persistido: qualquer coisa inesperada vira "antigo". */
export function normalizeBazaarMethod(raw: unknown): BazaarMethod {
  return raw === "novo" ? "novo" : "antigo";
}

export interface BazaarBrowserOption {
  key: string;
  label: string;
  engine: string;
  available: boolean;
  hint: string;
}

interface Props {
  open: boolean;
  onConfirm: (
    browserKey: string,
    browserOrder: string[],
    cleanProfile: boolean,
    retryBrowsers: string[],
    speedMode: BazaarSpeedMode,
    retryCounts: BazaarRetryCounts,
    method: BazaarMethod,
  ) => void;
  onCancel: () => void;
}

/**
 * Descrição curta de cada mecanismo. A ordem e os textos refletem os testes
 * reais feitos contra o RubinOT: WebKit teve o melhor resultado (>90% dos
 * personagens abrindo) e o Chrome, o pior.
 */
const BROWSER_NOTES: Record<string, string> = {
  webkit: "Recomendado — melhor desempenho nos testes (mais de 90% dos personagens).",
  firefox: "Boa alternativa. Motor independente do Chrome.",
  edge: "Mesmo motor do Chrome, com resultado um pouco melhor.",
  chrome: "Teve o pior desempenho nos testes. Use só se os outros falharem.",
};

/** Ordem de exibição, do mais eficaz para o menos eficaz. */
const BROWSER_ORDER = ["webkit", "firefox", "edge", "chrome"];

export default function BazaarBrowserModal({ open, onConfirm, onCancel }: Props) {
  const [browsers, setBrowsers] = useState<BazaarBrowserOption[]>([]);
  const [selected, setSelected] = useState<string>(() => loadUIState(BAZAAR_BROWSER_KEY, "webkit"));
  // Ordem de preferência para o RETRY (independente do navegador principal).
  const [order, setOrder] = useState<string[]>(() => {
    const saved = loadUIState<string[]>(BAZAAR_BROWSER_ORDER_KEY, DEFAULT_BROWSER_ORDER);
    const valid = (Array.isArray(saved) ? saved : []).filter(k => DEFAULT_BROWSER_ORDER.includes(k));
    // Completa com o que faltar, para a lista sempre cobrir os 4 navegadores.
    return [...valid, ...DEFAULT_BROWSER_ORDER.filter(k => !valid.includes(k))];
  });
  // Quantidade de retries de CADA navegador. Persistido entre consultas.
  //
  // Migração: quem já tinha navegadores marcados no formato antigo (lista de
  // chaves) começa com 1 retry em cada um — o comportamento que ele já tinha.
  const [retryCounts, setRetryCounts] = useState<BazaarRetryCounts>(() => {
    const savedCounts = loadUIState<BazaarRetryCounts | null>(BAZAAR_RETRY_COUNTS_KEY, null);
    if (savedCounts && typeof savedCounts === "object") return normalizeRetryCounts(savedCounts);
    const legacy = loadUIState<string[]>(BAZAAR_RETRY_BROWSERS_KEY, []);
    const migrated: BazaarRetryCounts = {};
    for (const key of DEFAULT_BROWSER_ORDER) {
      migrated[key] = Array.isArray(legacy) && legacy.includes(key) ? 1 : 0;
    }
    return migrated;
  });
  // Lista derivada (compatibilidade): navegadores com pelo menos 1 retry.
  const retryBrowsers = DEFAULT_BROWSER_ORDER.filter(key => (retryCounts[key] || 0) > 0);
  // Modo de velocidade, persistido entre consultas.
  const [speedMode, setSpeedMode] = useState<BazaarSpeedMode>(
    () => (loadUIState<BazaarSpeedMode>(BAZAAR_SPEED_MODE_KEY, "moderado") === "agressivo" ? "agressivo" : "moderado"),
  );
  // Método de consulta, persistido entre consultas. Padrão: "antigo".
  const [method, setMethod] = useState<BazaarMethod>(
    () => normalizeBazaarMethod(loadUIState<BazaarMethod>(BAZAAR_METHOD_KEY, DEFAULT_BAZAAR_METHOD)),
  );
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  // Perfil limpo: desativado por padrão, vale só para esta consulta.
  const [cleanProfile, setCleanProfile] = useState(false);
  const [clearState, setClearState] = useState<"idle" | "working" | "done">("idle");
  // Estado da sessão do RubinOT no perfil do navegador escolhido.
  // Apenas metadados — nenhum valor de cookie e nenhuma credencial.
  const [sessionStatus, setSessionStatus] = useState<"nao-validada" | "validada" | "expirada" | "desconhecida">("desconhecida");
  const [prepareState, setPrepareState] = useState<"idle" | "open" | "checking">("idle");
  // Metadados extras da sessão, usados só para orientar o usuário.
  const [hasCfClearance, setHasCfClearance] = useState(false);
  const [cfClearanceExpiresAt, setCfClearanceExpiresAt] = useState(0);
  // Consulta a disponibilidade sempre que o modal abre: o usuário pode ter
  // instalado um navegador desde a última vez.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    (async () => {
      setIsLoading(true);
      setLoadError("");
      setClearState("idle");
      setCleanProfile(false);
      setPrepareState("idle");
      try {
        const { ipcRenderer } = (window as any).require("electron");
        const response = await ipcRenderer.invoke("rubinot-bazaar-browsers");
        if (cancelled) return;
        const raw: BazaarBrowserOption[] = response?.browsers || [];
        // Ordena do mais eficaz para o menos eficaz, conforme os testes reais.
        const list = [...raw].sort((a, b) => BROWSER_ORDER.indexOf(a.key) - BROWSER_ORDER.indexOf(b.key));
        setBrowsers(list);

        // Pré-seleciona o último escolhido, se ainda estiver disponível.
        const saved = loadUIState(BAZAAR_BROWSER_KEY, "webkit");
        const savedOk = list.find(b => b.key === saved && b.available);
        const firstOk = list.find(b => b.available);
        setSelected(savedOk?.key || firstOk?.key || saved);
      } catch (error: any) {
        if (!cancelled) setLoadError(error?.message || "Não foi possível verificar os navegadores instalados.");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [open]);

  // Estado da sessão do navegador selecionado (só metadados).
  useEffect(() => {
    if (!open || !selected) return;
    let cancelled = false;
    (async () => {
      try {
        const { ipcRenderer } = (window as any).require("electron");
        const response = await ipcRenderer.invoke("rubinot-bazaar-session-state", { browser: selected });
        if (cancelled) return;
        setSessionStatus(response?.status || "desconhecida");
        setHasCfClearance(response?.hasCfClearance === true);
        setCfClearanceExpiresAt(Number(response?.cfClearanceExpiresAt || 0));
      } catch {
        if (!cancelled) {
          setSessionStatus("desconhecida");
          setHasCfClearance(false);
          setCfClearanceExpiresAt(0);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [open, selected, prepareState]);

  useEffect(() => {
    if (!open) return;
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onCancel]);

  if (!open) return null;

  const chosen = browsers.find(b => b.key === selected);
  const canStart = !isLoading && !!chosen?.available;

  function handleStart() {
    if (!canStart) return;
    saveUIState(BAZAAR_BROWSER_KEY, selected);
    saveUIState(BAZAAR_BROWSER_ORDER_KEY, order);
    // A lista antiga continua sendo gravada: o processo principal ainda a usa
    // como alternativa quando o mapa de quantidades não chega.
    saveUIState(BAZAAR_RETRY_BROWSERS_KEY, retryBrowsers);
    saveUIState(BAZAAR_RETRY_COUNTS_KEY, retryCounts);
    saveUIState(BAZAAR_SPEED_MODE_KEY, speedMode);
    saveUIState(BAZAAR_METHOD_KEY, method);
    onConfirm(selected, order, cleanProfile, retryBrowsers, speedMode, retryCounts, method);
  }

  /** Soma `delta` ao contador de um navegador, respeitando 0..MAX. */
  function changeRetryCount(key: string, delta: number) {
    setRetryCounts(prev => {
      const current = Number(prev[key] || 0);
      const next = Math.min(BAZAAR_MAX_RETRIES_PER_BROWSER, Math.max(0, current + delta));
      return { ...prev, [key]: next };
    });
  }

  /** Define o valor de todos os navegadores de uma vez. */
  function setAllRetryCounts(value: number) {
    const next: BazaarRetryCounts = {};
    for (const key of DEFAULT_BROWSER_ORDER) next[key] = value;
    setRetryCounts(next);
  }

  /** Total de passadas de retry configuradas (soma de todos os contadores). */
  const totalRetrySteps = DEFAULT_BROWSER_ORDER.reduce((sum, key) => sum + (retryCounts[key] || 0), 0);

  /**
   * Cadeia efetiva: ordem de preferência, sem o navegador principal.
   * Espelha `buildRubinotRetryChain` do processo principal — repetir o
   * principal abriria os mesmos links no motor que acabou de falhar.
   */
  const effectiveRetryChain = [
    ...(retryBrowsers.includes(selected) ? [selected] : []),
    ...order.filter(key => key !== selected && retryBrowsers.includes(key)),
  ];
  const allRetrySelected = DEFAULT_BROWSER_ORDER.every(key => retryBrowsers.includes(key));

  /**
   * PLANO efetivo: a cadeia acima expandida pela quantidade de cada navegador.
   * Espelha `buildRubinotRetryPlan` do processo principal — dois retries do
   * WebKit são DUAS entradas, na ordem em que vão rodar.
   */
  const effectiveRetryPlan = effectiveRetryChain.flatMap(key => {
    const attempts = retryCounts[key] || 0;
    return Array.from({ length: attempts }, (_, index) => ({ browser: key, attempt: index + 1, attempts }));
  });

  /** Validade restante do cf_clearance, em texto curto. "" quando não há. */
  function formatClearanceValidity(): string {
    if (!hasCfClearance) return "";
    if (!cfClearanceExpiresAt) return "verificação do Cloudflare válida nesta sessão";
    const minutes = Math.round((cfClearanceExpiresAt * 1000 - Date.now()) / 60000);
    if (minutes <= 0) return "verificação do Cloudflare vencida";
    if (minutes < 60) return `verificação do Cloudflare válida por ~${minutes} min`;
    return `verificação do Cloudflare válida por ~${Math.round(minutes / 60)} h`;
  }

  return createPortal(
    <div className="app-modal-overlay fixed inset-0 z-[1200] flex items-center justify-center bg-black/70 backdrop-blur-sm">
      {/* `max-h-[90vh]` + `flex-col` fazem o cabeçalho e o rodapé ficarem
          fixos, com apenas o miolo rolando. `overflow-hidden` impede que o
          conteúdo vaze pelos cantos arredondados. Em telas altas o modal
          continua com a altura natural — o teto só age quando necessário. */}
      <div className="app-modal-frame app-modal-size-sm app-modal-frame--scroll w-full max-w-md rounded-xl border border-[var(--th-line)]/60 bg-[var(--th-bg-raised)] shadow-2xl shadow-black/60">

        <div className="flex-shrink-0 flex items-center justify-between gap-2 px-4 py-3 border-b border-[var(--th-line)]/40">
          <div className="flex items-center gap-2 min-w-0">
            <Globe size={16} className="text-sky-400 flex-shrink-0" />
            <span className="text-sm font-bold text-sky-300 uppercase tracking-wider truncate">Navegador da consulta</span>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="p-1 rounded text-slate-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer flex-shrink-0"
            title="Cancelar (Esc)"
          >
            <X size={15} />
          </button>
        </div>

        {/* Único trecho rolável. `min-h-0` é obrigatório: sem ele um filho
            flex não encolhe abaixo do conteúdo e a rolagem nunca aparece. */}
        <div className="app-modal-body custom-scrollbar px-4 py-3 space-y-3">
          {/* ── MÉTODO DE CONSULTA ──────────────────────────────────────
              Escolha entre o fluxo atual e o novo (API JSON). O padrão é
              "Antigo": quem não mexer aqui continua exatamente como hoje. */}
          <div className="rounded-lg border border-[var(--th-line)]/50 bg-black/20 p-2.5 space-y-2">
            <div className="flex items-center gap-1.5">
              <FlaskConical size={13} className="text-[var(--th-accent)] flex-shrink-0" />
              <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--th-text)]">
                Método de consulta
              </span>
            </div>

            <div className="grid grid-cols-2 gap-1.5">
              {([
                {
                  key: "antigo" as BazaarMethod,
                  title: "Antigo",
                  subtitle: "Atual",
                  note: "Abre a página de cada personagem e lê a Bosstiary. Comportamento validado.",
                },
                {
                  key: "novo" as BazaarMethod,
                  title: "Novo",
                  subtitle: "Experimental",
                  note: "Consulta as quests por JSON, sem abrir a página. Cai no método antigo quando o dado não vier.",
                },
              ]).map(option => {
                const isSelected = method === option.key;
                return (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() => setMethod(option.key)}
                    className={`text-left rounded-lg border px-2.5 py-2 transition-colors cursor-pointer ${
                      isSelected
                        ? "border-[var(--th-accent)]/70 bg-[var(--th-accent)]/10"
                        : "border-[var(--th-line)]/50 bg-black/20 hover:border-[var(--th-line)]"
                    }`}
                    title={option.note}
                  >
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`w-3 h-3 rounded-full border-2 flex-shrink-0 ${
                          isSelected ? "border-[var(--th-accent)] bg-[var(--th-accent)]" : "border-slate-500"
                        }`}
                      />
                      <span className={`text-[11px] font-bold ${isSelected ? "text-[var(--th-accent)]" : "text-slate-300"}`}>
                        {option.title}
                      </span>
                      <span className="text-[9px] uppercase tracking-wider text-slate-500">{option.subtitle}</span>
                    </div>
                  </button>
                );
              })}
            </div>

            <p className="text-[10px] leading-relaxed text-slate-400">
              {method === "novo"
                ? "O método novo consulta as quests diretamente por JSON, sem renderizar a página de cada personagem — é onde surge a mensagem \"Falha ao carregar leilão\". Os filtros e as colunas são exatamente os mesmos. Quem o JSON não resolver é analisado pelo método antigo automaticamente."
                : "Fluxo atual, sem nenhuma alteração: abre a página de cada personagem, clica em Bosstiary e lê a tabela, com retry entre navegadores."}
            </p>
          </div>

          <p className="text-[11px] leading-relaxed text-slate-400">
            Navegadores diferentes podem apresentar <strong className="text-slate-300">resultados diferentes</strong> no
            RubinOT. Se muitos personagens falharem, tente outro navegador.
          </p>

          {isLoading && (
            <div className="flex items-center gap-2 py-6 justify-center text-slate-500">
              <div className="w-5 h-5 rounded-full border-2 border-sky-500/30 border-t-sky-500 animate-spin" />
              <span className="text-xs font-bold">Verificando navegadores instalados...</span>
            </div>
          )}

          {!!loadError && (
            <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-300 flex items-start gap-2">
              <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" /> {loadError}
            </div>
          )}

          {!isLoading && !loadError && (
            <div className="space-y-1.5">
              {browsers.map(browser => {
                const isSelected = browser.key === selected;
                return (
                  <button
                    key={browser.key}
                    type="button"
                    disabled={!browser.available}
                    onClick={() => setSelected(browser.key)}
                    className={`w-full flex items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors ${
                      !browser.available
                        ? "border-[var(--th-line)]/30 bg-white/[0.02] opacity-60 cursor-not-allowed"
                        : isSelected
                          ? "border-sky-500/60 bg-sky-500/10 cursor-pointer"
                          : "border-[var(--th-line)]/40 bg-white/[0.02] hover:bg-white/[0.05] hover:border-white/20 cursor-pointer"
                    }`}
                  >
                    <span className={`mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border ${
                      isSelected && browser.available ? "border-sky-400 bg-sky-500/30" : "border-slate-600"
                    }`}>
                      {isSelected && browser.available && <Check size={10} className="text-sky-300" />}
                    </span>

                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className={`text-xs font-bold ${browser.available ? "text-slate-100" : "text-slate-500"}`}>
                          {browser.label}
                        </span>
                        {browser.available && browser.key === "webkit" && (
                          <span className="text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-300">
                            recomendado
                          </span>
                        )}
                        {!browser.available && (
                          <span className="text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border border-amber-500/40 bg-amber-500/10 text-amber-300">
                            indisponível
                          </span>
                        )}
                      </span>
                      <span className="block text-[10px] leading-snug text-slate-500 mt-0.5">
                        {browser.available ? BROWSER_NOTES[browser.key] || "" : browser.hint}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {!isLoading && !loadError && browsers.length > 0 && !browsers.some(b => b.available) && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200 flex items-start gap-2">
              <AlertTriangle size={14} className="flex-shrink-0 mt-0.5 text-amber-400" />
              Nenhum navegador compatível foi encontrado. Instale o Google Chrome ou rode
              <span className="font-mono"> npx playwright install firefox</span>.
            </div>
          )}

          {/* MODO DE VELOCIDADE. Vale para a consulta inteira, incluindo os
              retries. Os tempos ficam centralizados no processo principal. */}
          {!isLoading && !loadError && (
            <div className="rounded-lg border border-[var(--th-line)]/40 bg-white/[0.02] px-3 py-2 space-y-1.5">
              <div className="text-[11px] font-bold text-slate-300">Modo da consulta</div>
              <div className="grid grid-cols-2 gap-1.5">
                {([
                  { key: "moderado" as const, title: "Moderado", note: "Mais estável. Tempos folgados, menos falso negativo." },
                  { key: "agressivo" as const, title: "Agressivo", note: "Mais rápido. Abandona logo páginas que não carregam." },
                ]).map(mode => {
                  const active = speedMode === mode.key;
                  return (
                    <button
                      key={mode.key}
                      type="button"
                      onClick={() => setSpeedMode(mode.key)}
                      className={`rounded-lg border px-2 py-1.5 text-left transition-colors cursor-pointer ${
                        active
                          ? "border-sky-500/60 bg-sky-500/10"
                          : "border-[var(--th-line)]/40 bg-white/[0.02] hover:bg-white/[0.05]"
                      }`}
                    >
                      <span className={`block text-[11px] font-bold ${active ? "text-sky-300" : "text-slate-300"}`}>
                        {mode.title}
                      </span>
                      <span className="block text-[9px] leading-snug text-slate-500">{mode.note}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* RETRIES: quais navegadores tentar e em que ordem.
              Marque vários para formar uma CADEIA — cada um recebe apenas os
              personagens que ainda estão falhando. O principal nunca se repete. */}
          {!isLoading && !loadError && (
            <div className="rounded-lg border border-[var(--th-line)]/40 bg-white/[0.02] px-3 py-2 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[11px] font-bold text-slate-300">Retries por navegador</div>
                <button
                  type="button"
                  onClick={() => setAllRetryCounts(allRetrySelected ? 0 : 1)}
                  className="flex-shrink-0 rounded border border-violet-500/40 bg-violet-500/10 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wider text-violet-300 hover:bg-violet-500/20 transition-colors cursor-pointer"
                >
                  {allRetrySelected ? "Zerar todos" : "1 em cada"}
                </button>
              </div>
              <p className="text-[10px] leading-snug text-slate-500">
                Defina <strong className="text-slate-400">quantas vezes</strong> cada
                navegador deve repetir os personagens que falharam.{" "}
                <span className="font-mono text-slate-400">0</span> = não faz retry.
                As tentativas rodam <strong className="text-slate-400">em sequência</strong> e
                cada uma recebe só quem <em>ainda</em> falhou. O principal também pode
                ter retries — nesse caso ele repete primeiro, sem trocar de motor.
                Máximo de {BAZAAR_MAX_RETRIES_PER_BROWSER} por navegador.
              </p>
              <div className="space-y-1">
                {order.map((key, index) => {
                  const info = browsers.find(b => b.key === key);
                  const isPrimary = key === selected;
                  const count = retryCounts[key] || 0;
                  // Posição da PRIMEIRA passada deste navegador no plano.
                  const chainPos = effectiveRetryPlan.findIndex(step => step.browser === key);
                  return (
                    <div
                      key={key}
                      className={`flex items-center gap-1.5 rounded border px-2 py-1 ${
                        count > 0 ? "border-violet-500/50 bg-violet-500/10" : "border-[var(--th-line)]/30 bg-white/[0.02]"
                      }`}
                    >
                      <span className="w-4 flex-shrink-0 text-center text-[10px] font-mono font-bold text-slate-500">
                        {chainPos >= 0 ? chainPos + 1 : "—"}
                      </span>
                      <span className={`flex-1 min-w-0 truncate text-[11px] font-semibold ${info?.available === false ? "text-slate-600" : "text-slate-200"}`}>
                        {info?.label || key}
                        {isPrimary && <span className="ml-1.5 text-[9px] font-black uppercase text-sky-400">principal</span>}
                        {info?.available === false && <span className="ml-1.5 text-[9px] font-black uppercase text-amber-400">indisponível</span>}
                      </span>

                      {/* Contador compacto [-] N [+]. O principal TAMBÉM pode
                          ter retries: uma segunda passada no mesmo motor
                          costuma recuperar falhas transitórias e é a tentativa
                          mais barata (o contexto já está aberto). Quando tem,
                          vem primeiro no plano. */}
                      <span className="flex flex-shrink-0 items-center gap-0.5" title={`Quantos retries com ${info?.label || key} (0 a ${BAZAAR_MAX_RETRIES_PER_BROWSER})`}>
                        <span className="text-[9px] font-black uppercase tracking-wider text-slate-500">Retry</span>
                        <button
                          type="button"
                          disabled={count <= 0}
                          onClick={() => changeRetryCount(key, -1)}
                          className="h-4 w-4 rounded border border-[var(--th-line)]/50 bg-white/[0.04] text-[11px] leading-none font-black text-slate-300 hover:bg-white/10 transition-colors cursor-pointer disabled:opacity-25 disabled:cursor-not-allowed"
                          title="Diminuir"
                        >
                          −
                        </button>
                        <span className={`w-4 text-center text-[11px] font-mono font-bold ${count > 0 ? "text-violet-300" : "text-slate-600"}`}>
                          {count}
                        </span>
                        <button
                          type="button"
                          disabled={count >= BAZAAR_MAX_RETRIES_PER_BROWSER}
                          onClick={() => changeRetryCount(key, 1)}
                          className="h-4 w-4 rounded border border-[var(--th-line)]/50 bg-white/[0.04] text-[11px] leading-none font-black text-slate-300 hover:bg-white/10 transition-colors cursor-pointer disabled:opacity-25 disabled:cursor-not-allowed"
                          title="Aumentar"
                        >
                          +
                        </button>
                      </span>
                      <button
                        type="button"
                        disabled={index === 0}
                        onClick={() => setOrder(prev => {
                          const next = [...prev];
                          [next[index - 1], next[index]] = [next[index], next[index - 1]];
                          return next;
                        })}
                        className="p-0.5 rounded text-slate-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer disabled:opacity-25 disabled:cursor-not-allowed"
                        title="Subir"
                      >
                        <ChevronUp size={13} />
                      </button>
                      <button
                        type="button"
                        disabled={index === order.length - 1}
                        onClick={() => setOrder(prev => {
                          const next = [...prev];
                          [next[index], next[index + 1]] = [next[index + 1], next[index]];
                          return next;
                        })}
                        className="p-0.5 rounded text-slate-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer disabled:opacity-25 disabled:cursor-not-allowed"
                        title="Descer"
                      >
                        <ChevronDown size={13} />
                      </button>
                    </div>
                  );
                })}
              </div>

              {/* Deixa explícito o que vai acontecer, já sem o principal. */}
              <p className="text-[10px] leading-snug text-slate-500">
                {effectiveRetryPlan.length === 0
                  ? "Nenhum retry configurado: a consulta termina na passada principal."
                  : `Sequência (${totalRetrySteps} tentativa${totalRetrySteps === 1 ? "" : "s"}): ${effectiveRetryPlan
                      .map(step => {
                        const label = browsers.find(b => b.key === step.browser)?.label || step.browser;
                        return step.attempts > 1 ? `${label} ${step.attempt}/${step.attempts}` : label;
                      })
                      .join(" → ")}`}
              </p>
            </div>
          )}

          {/* Sessão do RubinOT. O login é feito PELO USUÁRIO na janela real do
              navegador — o app nunca lê nem guarda credenciais, apenas
              reaproveita depois os cookies que o próprio site gravou. */}
          {!isLoading && !loadError && (
            <div className="rounded-lg border border-[var(--th-line)]/40 bg-white/[0.02] px-3 py-2 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-bold text-slate-300">Sessão RubinOT</span>
                <span className={`text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border ${
                  sessionStatus === "validada"
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                    : sessionStatus === "expirada"
                      ? "border-rose-500/40 bg-rose-500/10 text-rose-300"
                      : "border-slate-500/40 bg-slate-500/10 text-slate-400"
                }`}>
                  {sessionStatus === "validada" ? "Validada"
                    : sessionStatus === "expirada" ? "Expirada"
                      : sessionStatus === "nao-validada" ? "Não validada" : "Desconhecida"}
                </span>
              </div>

              <p className="text-[10px] leading-snug text-slate-500">
                Uma sessão logada tende a carregar mais páginas com sucesso.
                O login é feito por você, na janela do navegador — nenhuma
                credencial é lida ou armazenada pelo aplicativo.
              </p>

              {!!formatClearanceValidity() && (
                <p className="text-[10px] leading-snug text-emerald-400/80">
                  {formatClearanceValidity()}.
                </p>
              )}

              {/* Login com conta Google: bloqueado pelo próprio Google em
                  qualquer navegador controlado por automação. Avisar antes
                  evita que o usuário perca tempo tentando. */}
              <p className="text-[10px] leading-snug text-amber-400/80">
                Use o login por <strong className="font-bold">e-mail e senha</strong> do
                RubinOT. O Google recusa o login em navegadores controlados por
                automação ("Não foi possível fazer o login"), e isso não tem
                contorno legítimo do lado do aplicativo.
              </p>

              {prepareState === "open" ? (
                <div className="space-y-1.5">
                  <div className="rounded border border-sky-500/40 bg-sky-500/10 px-2 py-1.5 text-[10px] leading-snug text-sky-200">
                    O navegador foi aberto no RubinOT. Faça login normalmente,
                    resolva qualquer verificação e volte aqui.
                  </div>
                  <button
                    type="button"
                    onClick={async () => {
                      setPrepareState("checking");
                      try {
                        const { ipcRenderer } = (window as any).require("electron");
                        const response = await ipcRenderer.invoke("rubinot-bazaar-confirm-session", { browser: selected });
                        setSessionStatus(response?.status || "desconhecida");
                      } catch { /* mantém o estado anterior */ }
                      setPrepareState("idle");
                    }}
                    className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg border border-emerald-500/50 bg-emerald-500/15 px-2 py-1 text-[10px] font-bold text-emerald-300 hover:bg-emerald-500/25 transition-colors cursor-pointer"
                  >
                    <Check size={11} /> Já fiz login — verificar sessão
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={prepareState === "checking" || !chosen?.available}
                  onClick={async () => {
                    setPrepareState("checking");
                    try {
                      const { ipcRenderer } = (window as any).require("electron");
                      const response = await ipcRenderer.invoke("rubinot-bazaar-prepare-session", { browser: selected });
                      setPrepareState(response?.ok ? "open" : "idle");
                    } catch {
                      setPrepareState("idle");
                    }
                  }}
                  className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg border border-sky-500/40 bg-sky-500/10 px-2 py-1 text-[10px] font-bold text-sky-300 hover:bg-sky-500/20 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Globe size={11} /> {prepareState === "checking" ? "Abrindo..." : "Preparar sessão do RubinOT"}
                </button>
              )}
            </div>
          )}

          {/* Manutenção da sessão. Fica no fim porque é uso pontual, para
              quando o site começa a falhar por cache/cookies antigos. */}
          {!isLoading && !loadError && (
            <div className="rounded-lg border border-[var(--th-line)]/40 bg-white/[0.02] px-3 py-2 space-y-2">
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={cleanProfile}
                  onChange={event => setCleanProfile(event.target.checked)}
                  className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 accent-sky-500 cursor-pointer"
                />
                <span className="min-w-0">
                  <span className="block text-[11px] font-bold text-slate-300">Usar perfil limpo nesta consulta</span>
                  <span className="block text-[10px] leading-snug text-slate-500">
                    Abre o navegador sem cache nem cookies, em um perfil temporário
                    que é descartado ao terminar. Seu perfil normal não é alterado.
                  </span>
                </span>
              </label>

              <div className="flex items-center justify-between gap-2 border-t border-[var(--th-line)]/30 pt-2">
                <span className="min-w-0 text-[10px] leading-snug text-slate-500">
                  Muitas falhas? Limpar a sessão remove cache e cookies salvos
                  deste navegador.
                </span>
                <button
                  type="button"
                  disabled={clearState === "working"}
                  onClick={async () => {
                    const label = browsers.find(b => b.key === selected)?.label || selected;
                    if (!window.confirm(
                      `Limpar a sessão do Bazaar no ${label}?\n\n`
                      + `Cache, cookies e dados salvos desse perfil serão apagados.\n`
                      + `Na próxima consulta pode ser necessário resolver a verificação do site novamente.\n\n`
                      + `Seu navegador pessoal NÃO é afetado.`,
                    )) return;
                    setClearState("working");
                    try {
                      const { ipcRenderer } = (window as any).require("electron");
                      await ipcRenderer.invoke("rubinot-bazaar-clear-session", { browser: selected });
                      setClearState("done");
                    } catch {
                      setClearState("idle");
                    }
                  }}
                  className={`flex-shrink-0 inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[10px] font-bold transition-colors ${
                    clearState === "done"
                      ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300 cursor-default"
                      : "border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  }`}
                >
                  {clearState === "done"
                    ? <><Check size={11} /> Sessão limpa</>
                    : <><RotateCcw size={11} /> {clearState === "working" ? "Limpando..." : "Limpar sessão"}</>}
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="flex-shrink-0 flex items-center justify-end gap-2 px-4 py-3 border-t border-[var(--th-line)]/40">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 rounded-lg border border-[var(--th-line)]/50 bg-white/5 text-[11px] font-bold text-slate-300 hover:bg-white/10 hover:text-white transition-colors cursor-pointer"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleStart}
            disabled={!canStart}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[11px] font-bold transition-colors ${
              canStart
                ? "border-sky-500/50 bg-sky-500/20 text-sky-200 hover:bg-sky-500/30 cursor-pointer"
                : "border-[var(--th-line)]/40 bg-white/5 text-slate-600 cursor-not-allowed"
            }`}
            title={canStart ? "Iniciar a consulta" : "Escolha um navegador disponível"}
          >
            <Play size={12} /> Iniciar consulta
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}