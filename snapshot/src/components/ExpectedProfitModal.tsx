import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronLeft, Clock, Coins, Package, Percent, RefreshCw, Settings2, TrendingUp, X } from "lucide-react";
import { SERVER_OPTIONS } from "../constants/servers";
import { formatRC } from "../types";
import { SERVER_COIN_RATES_EVENT, coinRateText, getServerCoinRate, readLocalCoinRates, saveOfficialServerCoinRate } from "../utils/bazaarCoinRates";
import { computeItemRC, formatRateKkDisplay, parseRateKk, sanitizeRateKkInput } from "../utils/itemSale";
import { applyOfficialWatchedItemUpdate, formatWatchedUpdatedAt, seedExpectedProfitFromWatchedLists } from "../utils/bazaarWatchedItems";
import { readBazarPanelTimezoneOffsetMinutes } from "../utils/bazaarTime";
import {
  CRYPT_ITEMS,
  CRYPT_RUNES_REQUIRED,
  EXPECTED_PROFIT_VALUES_EVENT,
  EXPECTED_QUESTS,
  GB_REWARD_RUNES,
  computeCryptConversion,
  computeGroupStats,
  computeQuestOutcome,
  expectedHoursPerReward,
  expectedItemKey,
  getExpectedItemEntry,
  persistExpectedProfitEntryPatches,
  readLocalExpectedProfitValues,
  type ExpectedItemValueEntry,
  type ExpectedProfitEntryPatch,
  type ExpectedProfitValues,
} from "../utils/expectedProfit";

/**
 * MODAL "LUCRO ESPERADO" (115ª) — análise do retorno esperado das quests
 * Soul War / Sanguine / Graveborn e dos Itens Crypt, por servidor, em RC.
 *
 *   • TODOS os usuários consultam; SÓ o Boss cadastra/edita os "Valores
 *     Considerados" (por servidor e por item, Venda Direta / Venda
 *     Paciente) — persistidos em appSettings/global.expectedProfitItemValues
 *     (MESMO doc/listener/Rules do "RC Servidores": backend só aceita Boss;
 *     todos recebem em tempo real pelo onSnapshot que o App já mantém).
 *   • Conversão kk → RC SEMPRE pela cotação do PRÓPRIO servidor (fonte
 *     única bazaarCoinRates/computeItemRC) — em tempo real via evento.
 *   • Cálculos na fonte única utils/expectedProfit.ts (puros):
 *     SW 3h30 drop 100% (21 itens) · SG 1h30/rotação drop 20% → ~5
 *     rotações/7h30 por recompensa (16 itens) · GB 1h drop 100% (5 runas)
 *     · Crypt: 5 runas → 1 dos 7 itens (saldo = item − custo de
 *     oportunidade das runas; sem dupla contagem).
 *   • PREMISSA sinalizada: recompensas equiprováveis (sem confirmação
 *     oficial das taxas individuais); médias só sobre itens CONFIGURADOS.
 *   • 116ª: cada item exibe a ÚLTIMA ATUALIZAÇÃO do valor (epoch no banco,
 *     fuso do usuário na exibição; sem valor = "Não atualizado") e a Venda
 *     Direta é SINCRONIZADA bidirecionalmente com o valor BASE da Lista de
 *     Itens do Painel Bazaar (salvar aqui atualiza a lista local via
 *     applyOfficialWatchedItemUpdate; salvar lá espelha para cá pelo funil
 *     saveWatchedItemsByServer — sempre por diferença, sem loops). A Venda
 *     Paciente e as personalizações por usuário/personagem nunca são
 *     tocadas pela sincronização.
 *   • 117ª: IMPORTAÇÃO INICIAL automática — aberto por um Boss, os itens
 *     do catálogo ainda sem Venda Direta recebem o valor Base da Lista de
 *     Itens (persistido; aberturas seguintes não gravam nada) — e edição
 *     da COTAÇÃO RC do servidor selecionado no cabeçalho (fluxo único
 *     saveOfficialServerCoinRate do quadro "RC Servidores").
 */
interface Props {
  isBoss: boolean;
  onClose: () => void;
}

type View = "resumo" | "crypt" | "valores";

const GROUPS: { key: string; label: string; items: string[] }[] = [
  { key: "sw", label: "Soul War", items: EXPECTED_QUESTS[0].items },
  { key: "sg", label: "Sanguine", items: EXPECTED_QUESTS[1].items },
  { key: "gb", label: "Graveborn", items: GB_REWARD_RUNES },
  { key: "crypt", label: "Itens Crypt", items: CRYPT_ITEMS },
];

const fmtHours = (hours: number): string => {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return m > 0 ? `${h}h${String(m).padStart(2, "0")}min` : `${h}h`;
};

export default function ExpectedProfitModal({ isBoss, onClose }: Props) {
  const [view, setView] = useState<View>("resumo");
  const [server, setServer] = useState<string>(SERVER_OPTIONS[0] || "");
  // Espelhos locais (fonte única) — atualizados em TEMPO REAL pelos eventos
  // já existentes (snapshot do App/gravações locais disparam os dois).
  const [values, setValues] = useState<ExpectedProfitValues>(() => readLocalExpectedProfitValues());
  const [coinRates, setCoinRates] = useState(() => readLocalCoinRates());
  useEffect(() => {
    const refreshValues = () => setValues(readLocalExpectedProfitValues());
    const refreshRates = () => setCoinRates(readLocalCoinRates());
    window.addEventListener(EXPECTED_PROFIT_VALUES_EVENT, refreshValues);
    window.addEventListener(SERVER_COIN_RATES_EVENT, refreshRates);
    return () => {
      window.removeEventListener(EXPECTED_PROFIT_VALUES_EVENT, refreshValues);
      window.removeEventListener(SERVER_COIN_RATES_EVENT, refreshRates);
    };
  }, []);
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 117ª — IMPORTAÇÃO INICIAL dos valores Base: ao abrir como BOSS, itens do
  // catálogo SEM Venda Direta cadastrada recebem o valor Base da Lista de
  // Itens local (todos os servidores oficiais; `d` existente NUNCA é
  // sobrescrito; sem Base = segue não configurado). Persistida pelo MESMO
  // funil granular da sincronização — depois da primeira importação as
  // aberturas seguintes não geram NENHUMA gravação. O espelho/evento
  // atualiza este modal e os demais usuários em tempo real.
  useEffect(() => {
    if (!isBoss) return;
    void seedExpectedProfitFromWatchedLists();
  }, [isBoss]);

  const coinRate = getServerCoinRate(coinRates, server);

  // ── 117ª — edição da cotação RC do servidor (SÓ Boss) ────────────────────
  // Rascunho pré-preenchido com o valor OFICIAL vigente (consulta fácil);
  // re-semeado ao trocar de servidor ou quando a cotação muda por fora
  // (outro módulo/usuário) — tempo real sem clobber de dígitos: o valor só
  // é re-semeado quando a COTAÇÃO efetiva muda.
  const [rateDraft, setRateDraft] = useState<string>(() => coinRateText(getServerCoinRate(readLocalCoinRates(), SERVER_OPTIONS[0] || "")));
  const [savingRate, setSavingRate] = useState(false);
  const [rateFeedback, setRateFeedback] = useState<{ ok: boolean; message: string } | null>(null);
  const rateFeedbackTimerRef = useRef<number | null>(null);
  useEffect(() => () => { if (rateFeedbackTimerRef.current !== null) window.clearTimeout(rateFeedbackTimerRef.current); }, []);
  useEffect(() => {
    setRateDraft(coinRateText(coinRate));
  }, [server, coinRate]);

  async function handleSaveRate() {
    if (!isBoss || savingRate) return;
    setSavingRate(true);
    try {
      // Fluxo ÚNICO oficial (69ª/113ª): valida, ignora valor já vigente
      // ("Já atualizado", sem gravação), altera SÓ o servidor selecionado e
      // preserva o histórico de cotações; vendas registradas NUNCA são
      // recalculadas (os registros guardam a cotação da época).
      const result = await saveOfficialServerCoinRate(server, rateDraft);
      setRateFeedback({ ok: result.ok, message: result.message });
      if (rateFeedbackTimerRef.current !== null) window.clearTimeout(rateFeedbackTimerRef.current);
      rateFeedbackTimerRef.current = window.setTimeout(() => { setRateFeedback(null); rateFeedbackTimerRef.current = null; }, result.ok ? 2500 : 4000);
    } finally {
      setSavingRate(false);
    }
  }

  // ── Estatísticas por grupo (derivadas — recalculam a cada mudança) ───────
  const stats = useMemo(() => ({
    sw: computeGroupStats(EXPECTED_QUESTS[0].items, values, server, coinRate),
    sg: computeGroupStats(EXPECTED_QUESTS[1].items, values, server, coinRate),
    gb: computeGroupStats(EXPECTED_QUESTS[2].items, values, server, coinRate),
    crypt: computeGroupStats(CRYPT_ITEMS, values, server, coinRate),
  }), [values, server, coinRate]);

  // ── EDITOR "Valores Considerados" (rascunho por servidor+grupo) ───────────
  const [editGroup, setEditGroup] = useState("sw");
  const [draft, setDraft] = useState<Record<string, { d: string; p: string }>>({});
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(null);
  const feedbackTimerRef = useRef<number | null>(null);
  useEffect(() => () => { if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current); }, []);
  // Rascunho re-semeado ao trocar servidor/grupo/cadastro (os valores kk
  // cadastrados são a verdade; strings pt-BR nos inputs).
  const group = GROUPS.find(g => g.key === editGroup) || GROUPS[0];
  useEffect(() => {
    const seeded: Record<string, { d: string; p: string }> = {};
    for (const item of group.items) {
      const entry = getExpectedItemEntry(values, server, item);
      seeded[expectedItemKey(item)] = {
        d: entry.d !== undefined ? formatRateKkDisplay(entry.d) : "",
        p: entry.p !== undefined ? formatRateKkDisplay(entry.p) : "",
      };
    }
    setDraft(seeded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server, editGroup, values, view]);

  async function handleSave() {
    if (!isBoss || saving) return;
    setSaving(true);
    try {
      // 116ª — salvamento GRANULAR: um patch por item que MUDOU de fato
      // (campo vazio REMOVE o cadastro; demais itens/servidores intactos —
      // edições simultâneas de outros Boss nunca são sobrescritas) e `u`
      // (última atualização) carimbado SÓ nos itens alterados.
      const now = Date.now();
      const patches: ExpectedProfitEntryPatch[] = [];
      const directChanges: { itemName: string; valueKk: number }[] = [];
      for (const item of group.items) {
        const iKey = expectedItemKey(item);
        const existing = getExpectedItemEntry(values, server, item);
        const d = parseRateKk(draft[iKey]?.d || "");
        const p = parseRateKk(draft[iKey]?.p || "");
        const nextD = d > 0 ? d : undefined;
        const nextP = p > 0 ? p : undefined;
        if (nextD === existing.d && nextP === existing.p) continue; // sem mudança — data preservada
        if (nextD === undefined && nextP === undefined) {
          patches.push({ server, itemName: item, entry: null });
        } else {
          const entry: ExpectedItemValueEntry = { u: now };
          if (nextD !== undefined) entry.d = nextD;
          if (nextP !== undefined) entry.p = nextP;
          patches.push({ server, itemName: item, entry });
        }
        if (nextD !== undefined && nextD !== existing.d) directChanges.push({ itemName: item, valueKk: nextD });
      }
      if (patches.length === 0) {
        setFeedback({ ok: true, message: "Nenhuma alteração para salvar." });
        if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current);
        feedbackTimerRef.current = window.setTimeout(() => { setFeedback(null); feedbackTimerRef.current = null; }, 2500);
        return;
      }
      const { remoteOk } = await persistExpectedProfitEntryPatches(patches);
      // 116ª — Lucro Esperado → Painel Bazaar: cada Venda Direta ALTERADA
      // vira o valor BASE do item na Lista de Itens DESTE servidor, pelo
      // MESMO mecanismo oficial do "Atualizar Valores" (reprice da última
      // consulta + evento para a guia aberta; idempotente), com o MESMO
      // carimbo `now` — registro de atualização idêntico nas duas
      // interfaces. Como o espelho local já confere, a gravação da lista
      // NÃO regrava o cadastro compartilhado (guarda anti-loop).
      for (const change of directChanges) {
        applyOfficialWatchedItemUpdate({
          scope: "server",
          server,
          itemName: change.itemName,
          valueKk: change.valueKk,
          serverUniverse: SERVER_OPTIONS,
          atMs: now,
        });
      }
      setFeedback(remoteOk
        ? { ok: true, message: `Valores de ${group.label} salvos para ${server}.` }
        : { ok: false, message: "Falha ao sincronizar — valores aplicados neste dispositivo e reenviados na próxima gravação." });
      if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current);
      feedbackTimerRef.current = window.setTimeout(() => { setFeedback(null); feedbackTimerRef.current = null; }, remoteOk ? 2500 : 4000);
    } finally {
      setSaving(false);
    }
  }

  const rcText = (value: number | null): string => value === null ? "—" : formatRC(Math.round(value));
  // 116ª — fuso de exibição: o MESMO configurado no Painel Bazaar (fallback:
  // fuso do dispositivo do usuário). O armazenamento é sempre epoch (ms).
  const tzOffsetMinutes = readBazarPanelTimezoneOffsetMinutes();
  const inputCls = "w-20 bg-black/40 border rounded-md px-1.5 py-0.5 text-[10px] text-right tabular-nums outline-none transition-colors placeholder-slate-600";

  // ── Blocos de categoria (Venda Direta × Venda Paciente) ──────────────────
  function CategoryBox({ kind, questKey }: { kind: "direct" | "patient"; questKey: "sw" | "sg" | "gb" }) {
    const def = EXPECTED_QUESTS.find(q => q.key === questKey)!;
    const stat = stats[questKey][kind];
    const outcome = computeQuestOutcome(def, stat);
    const isDirect = kind === "direct";
    return (
      <div className={`flex-1 min-w-0 rounded-lg border px-2 py-1.5 ${isDirect ? "border-sky-500/30 bg-sky-500/[0.06]" : "border-violet-500/30 bg-violet-500/[0.06]"}`}>
        <div className={`text-[8.5px] font-black uppercase tracking-wide ${isDirect ? "text-sky-300" : "text-violet-300"}`}>
          {isDirect ? "Venda Direta (mín.)" : "Venda Paciente (méd.)"}
        </div>
        <div className={`text-sm font-black tabular-nums leading-tight ${isDirect ? "text-sky-200" : "text-violet-200"}`}>
          {rcText(outcome.perRewardRc)}
        </div>
        <div className="text-[8.5px] leading-snug text-slate-400 tabular-nums">
          {def.dropChance < 1 && <span className="block">por rotação: {rcText(outcome.perAttemptRc)}</span>}
          <span className="block">{outcome.rcPerHour === null ? "— RC/h" : `${outcome.rcPerHour.toLocaleString("pt-BR")} RC/h`}</span>
          <span className={`block ${stat.configured < stats[questKey].total ? "text-amber-400/90" : "text-slate-500"}`}>
            {stat.configured}/{stats[questKey].total} itens configurados
          </span>
        </div>
      </div>
    );
  }

  function QuestCard({ questKey }: { questKey: "sw" | "sg" | "gb" }) {
    const def = EXPECTED_QUESTS.find(q => q.key === questKey)!;
    const guaranteed = def.dropChance >= 1;
    return (
      <div className="rounded-xl border border-[var(--th-line)]/60 bg-black/20 p-2.5 space-y-1.5">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px] font-black text-amber-200">{def.label}</span>
          <span className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[8.5px] font-black ${guaranteed ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : "border-amber-500/40 bg-amber-500/10 text-amber-300"}`}>
            <Percent size={8} /> {guaranteed ? "Drop garantido — 100%" : `Drop de ${Math.round(def.dropChance * 100)}% por rotação`}
          </span>
          <span className="inline-flex items-center gap-1 text-[8.5px] font-bold text-slate-400">
            <Clock size={8} /> {def.timeLabel}
          </span>
          <span className="inline-flex items-center gap-1 text-[8.5px] font-bold text-slate-400">
            <Package size={8} /> {stats[questKey].total} recompensas possíveis
          </span>
        </div>
        {!guaranteed && (
          <div className="text-[8.5px] leading-snug text-amber-200/70">
            Estatisticamente ~{Math.round(1 / def.dropChance)} rotações ({fmtHours(expectedHoursPerReward(def))}) por recompensa — o drop NÃO é garantido por rotação.
          </div>
        )}
        <div className="flex gap-1.5">
          <CategoryBox kind="direct" questKey={questKey} />
          <CategoryBox kind="patient" questKey={questKey} />
        </div>
      </div>
    );
  }

  // ── ÁREA CRYPT ────────────────────────────────────────────────────────────
  function CryptConversionBox({ kind }: { kind: "direct" | "patient" }) {
    const conv = computeCryptConversion(stats.gb[kind], stats.crypt[kind]);
    const isDirect = kind === "direct";
    return (
      <div className={`flex-1 min-w-0 rounded-lg border px-2 py-1.5 ${isDirect ? "border-sky-500/30 bg-sky-500/[0.06]" : "border-violet-500/30 bg-violet-500/[0.06]"}`}>
        <div className={`text-[8.5px] font-black uppercase tracking-wide ${isDirect ? "text-sky-300" : "text-violet-300"}`}>
          {isDirect ? "Venda Direta (mín.)" : "Venda Paciente (méd.)"}
        </div>
        <div className="text-[9px] leading-snug text-slate-300 tabular-nums space-y-0.5 mt-0.5">
          <div className="flex items-center justify-between gap-2"><span>Item Crypt (média dos 7)</span><span className="font-bold">{rcText(conv.expectedCryptRc)}</span></div>
          <div className="flex items-center justify-between gap-2"><span>− {CRYPT_RUNES_REQUIRED} runas (custo de oportunidade)</span><span className="font-bold">{conv.runesCostRc === null ? "—" : `−${formatRC(Math.round(conv.runesCostRc))}`}</span></div>
          <div className={`flex items-center justify-between gap-2 border-t pt-0.5 ${isDirect ? "border-sky-500/20" : "border-violet-500/20"}`}>
            <span className="font-black">Saldo esperado da conversão</span>
            <span className={`font-black ${conv.netRc === null ? "text-slate-500" : conv.netRc >= 0 ? "text-emerald-300" : "text-red-300"}`}>{conv.netRc === null ? "—" : formatRC(Math.round(conv.netRc))}</span>
          </div>
        </div>
      </div>
    );
  }

  return createPortal(
    <div className="app-modal-overlay fixed inset-0 z-[900] flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div
        className="app-modal-frame app-modal-size-lg app-modal-frame--scroll w-full rounded-xl border border-emerald-500/30 bg-[var(--th-bg-raised)] shadow-2xl shadow-black/60"
        onClick={e => e.stopPropagation()}
      >
        {/* Cabeçalho */}
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-[var(--th-line)]/60 bg-[var(--th-bg-overlay)] flex-shrink-0 flex-wrap">
          <div className="flex items-center gap-2 min-w-0">
            <TrendingUp size={14} className="text-emerald-400 flex-shrink-0" />
            <span className="text-xs font-black text-emerald-200 truncate">Lucro Esperado — SW / SG / GB</span>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {/* Servidor + cotação (fonte única "RC Servidores", tempo real) */}
            <select
              value={server}
              onChange={e => setServer(e.target.value)}
              aria-label="Servidor"
              className="bg-black/40 border border-[var(--th-line)]/70 rounded-md px-1.5 py-0.5 text-[10px] font-bold text-slate-200 outline-none cursor-pointer"
            >
              {SERVER_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <span
              className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[9px] font-black tabular-nums ${coinRate > 0 ? "border-amber-500/35 bg-amber-500/10 text-amber-300" : "border-red-500/35 bg-red-500/10 text-red-300"}`}
              title={coinRate > 0 ? `Cotação do RC em ${server} (quadro "RC Servidores" do Painel Bazaar): ${coinRateText(coinRate)}k por 1000 RC` : `Servidor sem cotação de RC cadastrada no quadro "RC Servidores" — conversões indisponíveis`}
            >
              <Coins size={9} /> {coinRate > 0 ? `RC a ${coinRateText(coinRate)}k` : "sem cotação"}
            </span>
            {/* 117ª — edição da cotação RC (SÓ Boss; backend revalida): o
                MESMO fluxo único do quadro "RC Servidores"
                (saveOfficialServerCoinRate: validação, "Já atualizado" sem
                gravação, só o servidor selecionado, histórico preservado,
                evento em tempo real para o app inteiro). */}
            {isBoss && (
              <span className="inline-flex items-center gap-1">
                <input
                  type="text"
                  inputMode="decimal"
                  value={rateDraft}
                  onChange={e => setRateDraft(e.target.value)}
                  aria-label={`Cotação do RC em ${server} (k por 1000 RC)`}
                  placeholder="—"
                  className="w-12 bg-black/40 border border-amber-500/40 focus:border-amber-400/70 rounded-md px-1.5 py-0.5 font-mono text-[9px] font-black tabular-nums text-amber-200 text-right outline-none transition-colors placeholder-slate-600"
                  title={`Nova cotação do RC em ${server} (número > 0, até 1 casa decimal — ex.: 2,5)`}
                />
                <button
                  type="button"
                  disabled={savingRate}
                  onClick={() => { void handleSaveRate(); }}
                  className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-black text-amber-300 hover:bg-amber-500/20 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                  title={`Salvar a cotação de ${server} no quadro oficial "RC Servidores"`}
                >
                  {savingRate ? <RefreshCw size={9} className="animate-spin" /> : <Check size={9} />} Salvar RC
                </button>
                {rateFeedback && (
                  <span className={`text-[8.5px] font-bold ${rateFeedback.ok ? "text-emerald-300" : "text-red-300"}`}>{rateFeedback.message}</span>
                )}
              </span>
            )}
            {view === "resumo" ? (
              <>
                <button type="button" onClick={() => setView("crypt")} className="inline-flex items-center gap-1 rounded-md border border-violet-500/40 bg-violet-500/10 px-1.5 py-0.5 text-[9px] font-black text-violet-300 hover:bg-violet-500/20 transition-colors cursor-pointer">
                  <Package size={9} /> Itens Crypt
                </button>
                <button type="button" onClick={() => setView("valores")} className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-black text-amber-300 hover:bg-amber-500/20 transition-colors cursor-pointer">
                  <Settings2 size={9} /> Valores Considerados
                </button>
              </>
            ) : (
              <button type="button" onClick={() => setView("resumo")} className="inline-flex items-center gap-1 rounded-md border border-[var(--th-line)]/70 bg-black/30 px-1.5 py-0.5 text-[9px] font-black text-slate-300 hover:text-white transition-colors cursor-pointer">
                <ChevronLeft size={9} /> Voltar
              </button>
            )}
            <button type="button" onClick={onClose} className="text-slate-500 hover:text-white transition-colors cursor-pointer" title="Fechar">
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Miolo rolável — base global de modais (altura/rolagem) */}
        <div className="app-modal-body custom-scrollbar">
          {view === "resumo" && (
            <div className="flex flex-col gap-2 p-2.5">
              <QuestCard questKey="sw" />
              <QuestCard questKey="sg" />
              <QuestCard questKey="gb" />
              <div className="text-[8.5px] leading-snug text-slate-500 px-0.5">
                Premissa: recompensas equiprováveis dentro de cada quest (sem confirmação oficial das taxas individuais) — médias calculadas SOMENTE sobre os itens com valor cadastrado em {"\u201C"}Valores Considerados{"\u201D"}. Conversão kk → RC pela cotação de {server} do quadro {"\u201C"}RC Servidores{"\u201D"}.
              </div>
            </div>
          )}

          {view === "crypt" && (
            <div className="flex flex-col gap-2 p-2.5">
              <div className="rounded-xl border border-[var(--th-line)]/60 bg-black/20 p-2.5 space-y-1.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[11px] font-black text-amber-200">Conversão — {CRYPT_RUNES_REQUIRED} runas ➜ 1 item Crypt</span>
                  <span className="inline-flex items-center gap-1 rounded-md border border-violet-500/40 bg-violet-500/10 px-1.5 py-0.5 text-[8.5px] font-black text-violet-300">
                    <Package size={8} /> {CRYPT_ITEMS.length} itens possíveis
                  </span>
                </div>
                <div className="text-[8.5px] leading-snug text-slate-400">
                  Mecânica do Graveborn: {CRYPT_RUNES_REQUIRED} runas de recompensa viram 1 item Crypt aleatório. O saldo desconta o custo de oportunidade das runas gastas (média das runas configuradas) — runas e item NUNCA contam como duas recompensas.
                </div>
                <div className="flex gap-1.5">
                  <CryptConversionBox kind="direct" />
                  <CryptConversionBox kind="patient" />
                </div>
              </div>
              {/* Os 7 itens Crypt — valores individuais em RC */}
              <div className="rounded-xl border border-[var(--th-line)]/60 bg-black/20 p-2.5">
                <div className="text-[9px] font-black uppercase tracking-wide text-slate-400 mb-1.5">Itens Crypt em {server} (RC)</div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                  {CRYPT_ITEMS.map(item => {
                    const entry = getExpectedItemEntry(values, server, item);
                    const dRc = coinRate > 0 && entry.d ? computeItemRC(coinRate, entry.d) : null;
                    const pRc = coinRate > 0 && entry.p ? computeItemRC(coinRate, entry.p) : null;
                    return (
                      <div key={item} className="flex items-center justify-between gap-2 rounded-md border border-[var(--th-line)]/40 bg-black/25 px-2 py-1">
                        <span className="text-[9.5px] font-bold text-slate-200 truncate">{item}</span>
                        <span className="flex items-center gap-1.5 font-mono text-[9px] font-black tabular-nums flex-shrink-0">
                          <span className="text-sky-300" title="Venda Direta (mínimo)">D {dRc === null ? "—" : dRc.toLocaleString("pt-BR")}</span>
                          <span className="text-violet-300" title="Venda Paciente (média)">P {pRc === null ? "—" : pRc.toLocaleString("pt-BR")}</span>
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {view === "valores" && (
            <div className="flex flex-col gap-2 p-2.5">
              <div className="flex items-center gap-1 flex-wrap">
                {GROUPS.map(g => (
                  <button
                    key={g.key}
                    type="button"
                    onClick={() => setEditGroup(g.key)}
                    className={`rounded-md border px-2 py-0.5 text-[9px] font-black transition-colors cursor-pointer ${editGroup === g.key ? "border-amber-500/60 bg-amber-500/15 text-amber-200" : "border-[var(--th-line)]/60 bg-black/25 text-slate-400 hover:text-slate-200"}`}
                  >
                    {g.label}
                  </button>
                ))}
              </div>
              <div className="text-[8.5px] leading-snug text-slate-500">
                Valores em kk por item em <span className="font-bold text-slate-300">{server}</span> — <span className="text-sky-300 font-bold">Venda Direta</span> = mínimo alcançável (maior oferta de compra); <span className="text-violet-300 font-bold">Venda Paciente</span> = média esperada sem pressa. Campo vazio = não configurado (fica fora das médias).
                <span className="block mt-0.5">A <span className="text-sky-300 font-bold">Venda Direta</span> é o MESMO valor <span className="font-bold text-slate-300">Base</span> da Lista de Itens do Painel Bazaar (guia Personagens Com Itens): alterar e salvar em qualquer um dos dois atualiza o outro em tempo real, no servidor correspondente. A <span className="text-violet-300 font-bold">Venda Paciente</span> nunca é alterada pela sincronização.</span>
                {!isBoss && <span className="block text-amber-400/80 font-bold mt-0.5">Somente usuários Boss podem editar e salvar estes valores.</span>}
              </div>
              <div className="rounded-xl border border-[var(--th-line)]/60 bg-black/20 p-2 space-y-0.5">
                {group.items.map(item => {
                  const iKey = expectedItemKey(item);
                  const d = draft[iKey]?.d ?? "";
                  const p = draft[iKey]?.p ?? "";
                  const dRc = coinRate > 0 ? computeItemRC(coinRate, parseRateKk(d)) : 0;
                  const pRc = coinRate > 0 ? computeItemRC(coinRate, parseRateKk(p)) : 0;
                  // 116ª — última atualização do VALOR deste item neste
                  // servidor (epoch no banco; exibição no fuso do usuário).
                  const updatedAtMs = getExpectedItemEntry(values, server, item).u;
                  return (
                    <div key={item} className="flex items-center gap-1.5 py-0.5">
                      <span className="flex-1 min-w-0">
                        <span className="block text-[9.5px] font-bold text-slate-200 truncate leading-tight" title={item}>{item}</span>
                        <span className={`block text-[8px] leading-tight truncate ${updatedAtMs ? "text-slate-500" : "text-slate-600 italic"}`} title="Última atualização do valor deste item neste servidor">
                          {updatedAtMs ? `Atualizado ${formatWatchedUpdatedAt(updatedAtMs, tzOffsetMinutes)}` : "Não atualizado"}
                        </span>
                      </span>
                      {isBoss ? (
                        <>
                          <input type="text" inputMode="decimal" value={d} placeholder="—" aria-label={`Venda Direta de ${item} (kk)`}
                            onChange={e => setDraft(prev => ({ ...prev, [iKey]: { d: sanitizeRateKkInput(e.target.value), p: prev[iKey]?.p ?? "" } }))}
                            className={`${inputCls} border-sky-500/40 focus:border-sky-400/70 text-sky-200`} />
                          <input type="text" inputMode="decimal" value={p} placeholder="—" aria-label={`Venda Paciente de ${item} (kk)`}
                            onChange={e => setDraft(prev => ({ ...prev, [iKey]: { d: prev[iKey]?.d ?? "", p: sanitizeRateKkInput(e.target.value) } }))}
                            className={`${inputCls} border-violet-500/40 focus:border-violet-400/70 text-violet-200`} />
                        </>
                      ) : (
                        <>
                          <span className="w-20 text-right font-mono text-[10px] font-bold tabular-nums text-sky-300">{d === "" ? "—" : `${d}kk`}</span>
                          <span className="w-20 text-right font-mono text-[10px] font-bold tabular-nums text-violet-300">{p === "" ? "—" : `${p}kk`}</span>
                        </>
                      )}
                      <span className="w-24 text-right font-mono text-[8.5px] tabular-nums text-slate-500 hidden sm:block" title="Equivalente em RC pela cotação atual do servidor">
                        {dRc > 0 ? dRc.toLocaleString("pt-BR") : "—"} / {pRc > 0 ? pRc.toLocaleString("pt-BR") : "—"}
                      </span>
                    </div>
                  );
                })}
              </div>
              {isBoss && (
                <div className="flex items-center justify-between gap-2">
                  <span className={`text-[9px] font-bold ${feedback ? (feedback.ok ? "text-emerald-300" : "text-red-300") : "text-transparent"}`}>
                    {feedback?.message || "."}
                  </span>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => { void handleSave(); }}
                    className="inline-flex items-center gap-1 rounded-lg bg-emerald-500 hover:bg-emerald-400 px-3 py-1 text-[10px] font-black text-black transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {saving ? <RefreshCw size={11} className="animate-spin" /> : <Check size={11} />} Salvar valores
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
