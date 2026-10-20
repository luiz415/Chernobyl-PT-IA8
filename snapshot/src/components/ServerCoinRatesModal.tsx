import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { X, Coins, Globe, Check, RotateCcw } from "lucide-react";
import { SERVER_OPTIONS, serverKey } from "../constants/servers";
import {
  SERVER_COIN_RATES_EVENT,
  getServerCoinRate,
  persistCoinRates,
  readLocalCoinRateHistory,
  readLocalCoinRates,
  type BazaarCoinRates,
  type ServerCoinRateHistory,
} from "../utils/bazaarCoinRates";

// ============================================================================
// MODAL "RC SERVIDORES" — configuração GLOBAL da cotação do RC por servidor
// ----------------------------------------------------------------------------
// Aberto pelo botão "RC Servidores" do cabeçalho (visível SOMENTE para Boss).
// Edita a MESMA configuração persistente usada pela "Lista de Itens" do
// Bazaar e por todos os cálculos kk ⇄ RC do app (fonte única:
// appSettings/global.serverCoinRates — ver utils/bazaarCoinRates.ts).
//
// • Lista de servidores: SERVER_OPTIONS (a mesma do restante do app).
// • "Coin (k)" = quantos k equivalem a 1000 RC (convenção histórica).
// • Campo vazio = cotação NÃO CONFIGURADA (os cálculos exibem "—"; nunca
//   inventamos conversão nem herdamos de outro servidor).
// • Salvar grava o mapa COMPLETO uma única vez (uma gravação por clique —
//   sem writes redundantes); o backend (Security Rules de appSettings)
//   garante que apenas o Boss consegue gravar.
// ============================================================================

/** Mesma validação da cotação usada na Lista de Itens: > 0, até 1 casa. */
function parseDecimalKk(raw: string): number | null {
  const text = String(raw || "").trim().replace(",", ".");
  if (!/^\d+(\.\d)?$/.test(text)) return null;
  const value = Math.round(Number(text) * 10) / 10;
  return Number.isFinite(value) && value > 0 ? value : null;
}

function rateText(rate: number): string {
  return rate > 0 ? String(rate).replace(".", ",") : "";
}

/** Data/hora da alteração (dd/mm/aaaa hh:mm) — "—" quando não registrada. */
function historyDateText(ms: number | undefined): string {
  if (!ms || ms <= 0) return "—";
  return new Date(ms).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Valor do histórico: "2,5k", "removida" (0 registrado) ou "—" (sem dado). */
function historyRateText(rate: number | undefined): string {
  if (rate === undefined) return "—";
  return rate > 0 ? `${rateText(rate)}k` : "removida";
}

interface Props {
  onClose: () => void;
}

export default function ServerCoinRatesModal({ onClose }: Props) {
  // Cotações persistidas (espelho local, mantido vivo pelo listener de
  // appSettings/global do App). O evento cobre alterações feitas em OUTRO
  // local (ex.: Lista de Itens aberta em paralelo ou outro dispositivo).
  const [savedRates, setSavedRates] = useState<BazaarCoinRates>(() => readLocalCoinRates());
  // Histórico de alterações por servidor (54ª) — mesma fonte/espelho; o
  // MESMO evento das taxas sinaliza a releitura dos dois.
  const [savedHistory, setSavedHistory] = useState<ServerCoinRateHistory>(() => readLocalCoinRateHistory());
  useEffect(() => {
    const refresh = () => {
      setSavedRates(readLocalCoinRates());
      setSavedHistory(readLocalCoinRateHistory());
    };
    window.addEventListener(SERVER_COIN_RATES_EVENT, refresh);
    return () => window.removeEventListener(SERVER_COIN_RATES_EVENT, refresh);
  }, []);

  // Rascunho de edição por servidor (texto pt-BR). Inicializado UMA vez com
  // os valores salvos; o que o Boss digitar prevalece até Salvar/Restaurar.
  const [drafts, setDrafts] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    const rates = readLocalCoinRates();
    for (const server of SERVER_OPTIONS) initial[server] = rateText(getServerCoinRate(rates, server));
    return initial;
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  // Esc fecha (padrão dos demais modais do app).
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const setDraft = (server: string, value: string) => {
    setDrafts(d => ({ ...d, [server]: value }));
    setErrors(e => {
      if (!e[server]) return e;
      const next = { ...e };
      delete next[server];
      return next;
    });
  };

  // Há alterações pendentes? (comparação com o que está salvo)
  const isDirty = useMemo(
    () => SERVER_OPTIONS.some(server => (drafts[server] ?? "").trim() !== rateText(getServerCoinRate(savedRates, server))),
    [drafts, savedRates],
  );

  /** Restaura os rascunhos para os valores salvos (descarta edições). */
  const resetDrafts = () => {
    const next: Record<string, string> = {};
    for (const server of SERVER_OPTIONS) next[server] = rateText(getServerCoinRate(savedRates, server));
    setDrafts(next);
    setErrors({});
  };

  /**
   * Valida TODAS as linhas e grava o mapa completo UMA única vez (fonte
   * única; remoções também persistem). Linha inválida bloqueia o salvar e
   * fica marcada — nada é gravado parcialmente.
   */
  const handleSave = async () => {
    const nextErrors: Record<string, string> = {};
    const nextRates: BazaarCoinRates = {};
    for (const server of SERVER_OPTIONS) {
      const text = (drafts[server] ?? "").trim();
      if (!text) continue; // vazio = sem cotação (remove)
      const parsed = parseDecimalKk(text);
      if (parsed === null) {
        nextErrors[server] = "Número > 0 com até 1 casa decimal (ex.: 2,5)";
        continue;
      }
      nextRates[serverKey(server)] = parsed;
    }
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }
    setSaving(true);
    try {
      await persistCoinRates(nextRates);
      setSavedRates(readLocalCoinRates());
      setSavedHistory(readLocalCoinRateHistory());
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1800);
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[500] flex items-center justify-center bg-black/80 backdrop-blur-sm p-2 sm:p-4"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-md rounded-2xl border border-amber-500/40 bg-gradient-to-b from-[#141017] to-[#0b0a10] shadow-[0_0_60px_rgba(245,158,11,0.08)] shadow-black/70 flex flex-col max-h-[90vh] sm:max-h-[84vh] overflow-hidden">
        {/* Cabeçalho */}
        <div className="relative px-4 py-3.5 border-b border-amber-500/20 bg-gradient-to-r from-amber-500/[0.12] via-amber-500/[0.05] to-transparent flex-shrink-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="w-9 h-9 rounded-xl bg-amber-500/15 border border-amber-500/40 flex items-center justify-center shadow-[0_0_12px_rgba(245,158,11,0.15)] flex-shrink-0">
                <Coins size={17} className="text-amber-300" />
              </span>
              <div className="min-w-0">
                <h3 className="text-[15px] font-black text-amber-200 leading-tight tracking-tight truncate">RC Servidores</h3>
                <p className="text-[10px] text-slate-400 leading-snug truncate">
                  Cotação do RC por servidor — Coin (k) por 1000 RC
                </p>
              </div>
            </div>
            <button onClick={onClose} className="text-slate-400 hover:text-white p-1.5 rounded-lg hover:bg-white/5 transition-colors cursor-pointer flex-shrink-0">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Lista de servidores */}
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
          <ul className="divide-y divide-white/5 rounded-xl border border-white/10 bg-white/[0.02] overflow-hidden">
            {SERVER_OPTIONS.map(server => {
              const saved = getServerCoinRate(savedRates, server);
              const draft = drafts[server] ?? "";
              const error = errors[server];
              const dirty = draft.trim() !== rateText(saved);
              // Histórico do servidor: entrada ausente = taxa migrada/nunca
              // configurada — datas e valor anterior exibem "—" (nunca se
              // inventa data nem valor).
              const hist = savedHistory[serverKey(server)];
              const currentDate = hist && hist.rate === saved ? hist.updatedAt : undefined;
              const prevRate = hist && hist.rate === saved ? hist.prevRate : undefined;
              const prevDate = hist && hist.rate === saved ? hist.prevUpdatedAt : undefined;
              return (
                <li key={server} className="px-3 py-1.5">
                  {/* Linha principal: servidor + campo de edição (o valor
                      atual aparece UMA única vez, no bloco de histórico). */}
                  <div className="flex items-center gap-2">
                    <Globe size={11} className="text-sky-400 flex-shrink-0" />
                    <span className="text-[11px] font-bold text-slate-200 truncate flex-1" title={server}>{server}</span>
                    <div className="relative flex-shrink-0">
                      <input
                        type="text"
                        inputMode="decimal"
                        value={draft}
                        onChange={e => setDraft(server, e.target.value.replace(/[^\d.,]/g, ""))}
                        placeholder="—"
                        aria-label={`Cotação do RC em ${server} (k por 1000 RC)`}
                        className={`w-20 bg-black/40 border rounded-lg pl-2 pr-6 py-1 text-right text-[11px] font-mono tabular-nums outline-none transition-colors placeholder-slate-600 ${
                          error
                            ? "border-red-500/60 text-red-300 focus:border-red-400"
                            : dirty
                              ? "border-amber-500/60 text-amber-200 focus:border-amber-400"
                              : "border-white/10 text-slate-200 focus:border-amber-500/50"
                        }`}
                      />
                      <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[9px] font-bold text-slate-500 select-none pointer-events-none">k</span>
                    </div>
                  </div>
                  {/* Histórico — ÚNICO lugar que exibe o valor atual e o
                      anterior, cada um com a data da sua definição ("—"
                      quando não registrado; nada é inventado). Duas colunas
                      alinhadas para leitura rápida. */}
                  <div className="mt-1 pl-[19px] grid grid-cols-2 gap-x-3 text-[8px] leading-snug tabular-nums">
                    <span className="flex items-baseline gap-1 min-w-0">
                      <span className="uppercase tracking-wider font-bold text-slate-500/80 flex-shrink-0">Atual</span>
                      <span className={`font-bold ${saved > 0 ? "text-amber-300/90" : "text-slate-600"}`}>{saved > 0 ? `${rateText(saved)}k` : "—"}</span>
                      <span className="text-slate-600 truncate">{currentDate ? `· ${historyDateText(currentDate)}` : "· —"}</span>
                    </span>
                    <span className="flex items-baseline gap-1 min-w-0">
                      <span className="uppercase tracking-wider font-bold text-slate-500/80 flex-shrink-0">Anterior</span>
                      <span className={`font-bold ${prevRate !== undefined && prevRate > 0 ? "text-slate-300" : "text-slate-600"}`}>{historyRateText(prevRate)}</span>
                      <span className="text-slate-600 truncate">{prevDate ? `· ${historyDateText(prevDate)}` : "· —"}</span>
                    </span>
                  </div>
                  {error && <p className="mt-0.5 pl-[19px] text-[9px] text-red-400 leading-snug">{error}</p>}
                </li>
              );
            })}
          </ul>
        </div>

        {/* Rodapé — ações */}
        <div className="px-4 py-2.5 border-t border-white/5 bg-black/30 flex items-center gap-2 flex-shrink-0">
          <p className="flex-1 text-[9px] text-slate-500 leading-snug">
            Salvar grava tudo de uma vez e sincroniza todos os dispositivos.
          </p>
          <button
            type="button"
            onClick={resetDrafts}
            disabled={!isDirty || saving}
            title="Descartar as edições e voltar aos valores salvos"
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-white/10 bg-white/5 text-slate-300 text-[10px] font-bold hover:bg-white/10 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
          >
            <RotateCcw size={11} /> Restaurar
          </button>
          <button
            type="button"
            onClick={() => { void handleSave(); }}
            disabled={saving || (!isDirty && !savedFlash)}
            className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-[10px] font-black transition-all cursor-pointer flex-shrink-0 disabled:cursor-not-allowed ${
              savedFlash
                ? "bg-emerald-500 text-black"
                : "bg-gradient-to-r from-amber-700/80 to-amber-600/80 hover:from-amber-600 hover:to-amber-500 border border-amber-500/40 text-black disabled:opacity-40"
            }`}
          >
            <Check size={11} /> {savedFlash ? "Salvo!" : saving ? "Salvando..." : "Salvar"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
