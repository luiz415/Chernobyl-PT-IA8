import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowDown, ArrowUp, Check, Clock, Coins, Crown, Lock, Package, Percent, RefreshCw, Settings2, Sparkles, TrendingUp, Trophy, X } from "lucide-react";
import { SERVER_OPTIONS } from "../constants/servers";
import { useAuth } from "../context/AuthContext";
import { getEffectiveUserRole } from "../utils/vipAccess";
import BecomeVIPModal from "./BecomeVIPModal";
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
  QUEST_RANKING_COLUMNS,
  computeCryptConversion,
  computeCryptRankingRows,
  computeGroupStats,
  computeQuestOutcome,
  computeQuestRankingRows,
  expectedHoursPerReward,
  expectedItemKey,
  getExpectedItemEntry,
  persistExpectedProfitEntryPatches,
  questRankingPositions,
  readLocalExpectedProfitValues,
  sortQuestRankingRows,
  type ExpectedItemValueEntry,
  type ExpectedProfitEntryPatch,
  type ExpectedProfitValues,
  type QuestRankingColumnKey,
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

type View = "resumo" | "crypt" | "valores" | "ranking";

/** Guia interna da área Ranking (123ª). */
type RankingTab = "quests" | "cryptRank";

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
  // ── RESTRIÇÃO VIP (124ª) — MESMO mecanismo de validação do app ──────────
  // Fonte única utils/vipAccess (getEffectiveUserRole): considera a
  // EXPIRAÇÃO real do VIP (vipExpiresAt/compat vipDays) — perfil com role
  // "VIP" vencido conta como "Normal". O gate é validado AQUI DENTRO, pelo
  // perfil do AuthContext (não pela prop/botão): qualquer caminho que monte
  // este modal cai na MESMA checagem, e sem acesso NENHUM dado do módulo é
  // materializado (estados vazios, listeners não registrados, nada computado
  // nem renderizado). Convenção do app (VipAccessButton/Calculadora): Boss
  // tem o VIP incluso no cargo — "Normal" é o único perfil sem acesso.
  const { userProfile } = useAuth();
  const effectiveRole = getEffectiveUserRole(userProfile);
  const hasVipAccess = effectiveRole !== "Normal";
  // Edição continua EXCLUSIVA do Boss (e só com o acesso validado acima):
  // a prop sozinha não basta — o perfil real do AuthContext precisa conferir
  // (anti-manipulação de interface; o backend/Rules revalida de toda forma).
  const canEditAsBoss = isBoss && hasVipAccess && effectiveRole === "Boss";
  const [becomeVipOpen, setBecomeVipOpen] = useState(false);
  const [view, setView] = useState<View>("resumo");
  const [server, setServer] = useState<string>(SERVER_OPTIONS[0] || "");
  // Espelhos locais (fonte única) — atualizados em TEMPO REAL pelos eventos
  // já existentes (snapshot do App/gravações locais disparam os dois).
  // 124ª — SEM acesso VIP os espelhos NÃO são lidos nem observados (dados
  // não entram no componente); ao ganhar acesso (perfil carrega/atualiza),
  // o efeito sincroniza na hora e registra os listeners de tempo real.
  const [values, setValues] = useState<ExpectedProfitValues>(() => hasVipAccess ? readLocalExpectedProfitValues() : {});
  const [coinRates, setCoinRates] = useState(() => hasVipAccess ? readLocalCoinRates() : {});
  useEffect(() => {
    if (!hasVipAccess) return;
    const refreshValues = () => setValues(readLocalExpectedProfitValues());
    const refreshRates = () => setCoinRates(readLocalCoinRates());
    refreshValues();
    refreshRates();
    window.addEventListener(EXPECTED_PROFIT_VALUES_EVENT, refreshValues);
    window.addEventListener(SERVER_COIN_RATES_EVENT, refreshRates);
    return () => {
      window.removeEventListener(EXPECTED_PROFIT_VALUES_EVENT, refreshValues);
      window.removeEventListener(SERVER_COIN_RATES_EVENT, refreshRates);
    };
  }, [hasVipAccess]);
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
    if (!canEditAsBoss) return;
    void seedExpectedProfitFromWatchedLists();
  }, [canEditAsBoss]);

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
    if (!canEditAsBoss || savingRate) return;
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

  // ── RANKING (123ª) — todos os servidores, derivado em tempo real ─────────
  // Recalculado automaticamente a cada mudança de valores/cotações (os
  // eventos acima já atualizam `values`/`coinRates`); consulta aberta a
  // todos os usuários — não há nada editável aqui (Boss edita nos fluxos
  // já existentes: "Valores Considerados", Lista de Itens e cotação RC).
  const [rankingTab, setRankingTab] = useState<RankingTab>("quests");
  const [rankSort, setRankSort] = useState<{ col: QuestRankingColumnKey; dir: "desc" | "asc" }>({ col: "sw_d", dir: "desc" });
  const questRankingRows = useMemo(
    () => computeQuestRankingRows(SERVER_OPTIONS, values, s => getServerCoinRate(coinRates, s)),
    [values, coinRates],
  );
  const sortedQuestRanking = useMemo(
    () => sortQuestRankingRows(questRankingRows, rankSort.col, rankSort.dir),
    [questRankingRows, rankSort],
  );
  // Posições por coluna (1 = melhor RC/h) — destaque independente da
  // ordenação escolhida; células não configuradas ficam sem posição.
  const questColumnPositions = useMemo(() => {
    const map = {} as Record<QuestRankingColumnKey, Record<string, number>>;
    for (const col of QUEST_RANKING_COLUMNS) map[col.key] = questRankingPositions(questRankingRows, col.key);
    return map;
  }, [questRankingRows]);
  const cryptRankingRows = useMemo(
    () => computeCryptRankingRows(SERVER_OPTIONS, values, s => getServerCoinRate(coinRates, s)),
    [values, coinRates],
  );

  /** Alterna a ordenação da coluna (nova coluna = melhor primeiro). */
  function toggleRankSort(col: QuestRankingColumnKey) {
    setRankSort(prev => prev.col === col ? { col, dir: prev.dir === "desc" ? "asc" : "desc" } : { col, dir: "desc" });
  }

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
    if (!canEditAsBoss || saving) return;
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
  // 118ª (visual): valor principal maior, RC/h em selo próprio e linhas de
  // detalhe alinhadas — MESMOS cálculos/textos de antes, só apresentação.
  function CategoryBox({ kind, questKey }: { kind: "direct" | "patient"; questKey: "sw" | "sg" | "gb" }) {
    const def = EXPECTED_QUESTS.find(q => q.key === questKey)!;
    const stat = stats[questKey][kind];
    const outcome = computeQuestOutcome(def, stat);
    const isDirect = kind === "direct";
    return (
      <div className={`min-w-0 rounded-lg border px-2.5 py-2 ${isDirect ? "border-sky-500/30 bg-sky-500/[0.07]" : "border-violet-500/30 bg-violet-500/[0.07]"}`}>
        <div className="flex items-center justify-between gap-2">
          <span className={`inline-flex items-center gap-1.5 text-[8.5px] font-black uppercase tracking-wider ${isDirect ? "text-sky-300" : "text-violet-300"}`}>
            <span className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${isDirect ? "bg-sky-400" : "bg-violet-400"}`} />
            {isDirect ? "Venda Direta (mín.)" : "Venda Paciente (méd.)"}
          </span>
          {/* RC/h em DESTAQUE — comparador principal de rentabilidade */}
          <span
            className={`inline-flex items-baseline gap-1 rounded-lg border px-2 py-0.5 font-mono font-black tabular-nums flex-shrink-0 shadow-sm ${isDirect ? "border-sky-400/50 bg-sky-500/20 text-sky-100 shadow-sky-500/20" : "border-violet-400/50 bg-violet-500/20 text-violet-100 shadow-violet-500/20"}`}
            title="RC por hora — comparador de rentabilidade entre as quests"
          >
            <span className="text-[11.5px] leading-none">{outcome.rcPerHour === null ? "—" : outcome.rcPerHour.toLocaleString("pt-BR")}</span>
            <span className={`text-[8px] font-black uppercase tracking-wide ${isDirect ? "text-sky-300/90" : "text-violet-300/90"}`}>RC/h</span>
          </span>
        </div>
        <div className={`mt-1.5 text-base font-black tabular-nums leading-none ${isDirect ? "text-sky-100" : "text-violet-100"}`} title="Valor esperado de 1 recompensa (média dos itens configurados)">
          {rcText(outcome.perRewardRc)}
        </div>
        <div className="mt-1.5 space-y-0.5 text-[8.5px] leading-snug tabular-nums">
          {def.dropChance < 1 && (
            <div className="flex items-center justify-between gap-2 text-slate-400">
              <span>por rotação ({Math.round(def.dropChance * 100)}%)</span>
              <span className="font-bold text-slate-300">{rcText(outcome.perAttemptRc)}</span>
            </div>
          )}
          <div className={`flex items-center justify-between gap-2 ${stat.configured < stats[questKey].total ? "text-amber-400/90" : "text-slate-500"}`}>
            <span>{stat.configured}/{stats[questKey].total} itens configurados</span>
            {stat.configured < stats[questKey].total && <span className="font-bold">parcial</span>}
          </div>
        </div>
      </div>
    );
  }

  function QuestCard({ questKey }: { questKey: "sw" | "sg" | "gb" }) {
    const def = EXPECTED_QUESTS.find(q => q.key === questKey)!;
    const guaranteed = def.dropChance >= 1;
    return (
      <div className="rounded-xl border border-[var(--th-line)]/60 bg-black/25 overflow-hidden">
        {/* Faixa-título da quest: nome à esquerda, condições à direita */}
        <div className="flex items-center justify-between gap-2 flex-wrap px-2.5 py-1.5 border-b border-[var(--th-line)]/40 bg-white/[0.02]">
          <span className="text-[11.5px] font-black tracking-wide text-amber-200">{def.label}</span>
          <span className="flex items-center gap-1.5 flex-wrap">
            <span className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[8.5px] font-black ${guaranteed ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : "border-amber-500/40 bg-amber-500/10 text-amber-300"}`}>
              <Percent size={8} /> {guaranteed ? "Drop garantido — 100%" : `Drop de ${Math.round(def.dropChance * 100)}% por rotação`}
            </span>
            <span className="inline-flex items-center gap-1 rounded-md border border-[var(--th-line)]/50 bg-black/30 px-1.5 py-0.5 text-[8.5px] font-bold text-slate-300">
              <Clock size={8} className="text-slate-400" /> {def.timeLabel}
            </span>
            <span className="inline-flex items-center gap-1 rounded-md border border-[var(--th-line)]/50 bg-black/30 px-1.5 py-0.5 text-[8.5px] font-bold text-slate-300">
              <Package size={8} className="text-slate-400" /> {stats[questKey].total} recompensas possíveis
            </span>
          </span>
        </div>
        <div className="p-2.5 space-y-1.5">
          {!guaranteed && (
            <div className="rounded-md border border-amber-500/20 bg-amber-500/[0.06] px-2 py-1 text-[8.5px] leading-snug text-amber-200/80">
              Estatisticamente ~{Math.round(1 / def.dropChance)} rotações ({fmtHours(expectedHoursPerReward(def))}) por recompensa — o drop NÃO é garantido por rotação.
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            <CategoryBox kind="direct" questKey={questKey} />
            <CategoryBox kind="patient" questKey={questKey} />
          </div>
        </div>
      </div>
    );
  }

  // ── ÁREA CRYPT ────────────────────────────────────────────────────────────
  // 118ª (visual): extrato alinhado (item − runas = saldo) com o saldo em
  // destaque — MESMOS cálculos/textos de antes, só apresentação.
  function CryptConversionBox({ kind }: { kind: "direct" | "patient" }) {
    const conv = computeCryptConversion(stats.gb[kind], stats.crypt[kind]);
    const isDirect = kind === "direct";
    return (
      <div className={`min-w-0 rounded-lg border px-2.5 py-2 ${isDirect ? "border-sky-500/30 bg-sky-500/[0.07]" : "border-violet-500/30 bg-violet-500/[0.07]"}`}>
        <div className={`inline-flex items-center gap-1.5 text-[8.5px] font-black uppercase tracking-wider ${isDirect ? "text-sky-300" : "text-violet-300"}`}>
          <span className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${isDirect ? "bg-sky-400" : "bg-violet-400"}`} />
          {isDirect ? "Venda Direta (mín.)" : "Venda Paciente (méd.)"}
        </div>
        <div className="text-[9px] leading-snug text-slate-300 tabular-nums space-y-1 mt-1.5">
          <div className="flex items-center justify-between gap-2"><span className="text-slate-400">Item Crypt (média dos 7)</span><span className="font-bold text-slate-200">{rcText(conv.expectedCryptRc)}</span></div>
          <div className="flex items-center justify-between gap-2"><span className="text-slate-400">− {CRYPT_RUNES_REQUIRED} runas (custo de oportunidade)</span><span className="font-bold text-slate-200">{conv.runesCostRc === null ? "—" : `−${formatRC(Math.round(conv.runesCostRc))}`}</span></div>
          <div className={`flex items-center justify-between gap-2 border-t pt-1 ${isDirect ? "border-sky-500/20" : "border-violet-500/20"}`}>
            <span className="font-black text-slate-200">Saldo esperado da conversão</span>
            <span className={`rounded-md px-1.5 py-px font-mono text-[10px] font-black tabular-nums ${conv.netRc === null ? "text-slate-500" : conv.netRc >= 0 ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300"}`}>{conv.netRc === null ? "—" : formatRC(Math.round(conv.netRc))}</span>
          </div>
        </div>
      </div>
    );
  }

  // ── 118ª (visual) — navegação do quadro principal (sempre visível) ───────
  const navButtons: { key: View; label: string; icon: ReactNode; title: string; highlight?: boolean }[] = [
    { key: "resumo", label: "Resumo", icon: <TrendingUp size={10} />, title: "Retorno esperado das quests Soul War, Sanguine e Graveborn" },
    { key: "crypt", label: "Itens Crypt", icon: <Package size={10} />, title: "Conversão 5 runas ➜ 1 item Crypt e valores dos 7 itens" },
    { key: "valores", label: "Valores Considerados", icon: <Settings2 size={10} />, title: "Valores por item e servidor (Venda Direta / Venda Paciente)" },
    // 123ª — botão em DESTAQUE (dourado): classificação dos servidores.
    { key: "ranking", label: "Ranking", icon: <Trophy size={10} />, title: "Ranking dos servidores — quests (Venda Direta/Paciente) e troca de runas por Itens Crypt", highlight: true },
  ];

  // ── 124ª — SEM acesso VIP: tela informativa no lugar do módulo ───────────
  // (todos os hooks acima já rodaram — nenhum hook é declarado após este
  // retorno condicional). Conteúdo, dados e controles do módulo NÃO são
  // renderizados nem computados; a tela apresenta o benefício e convida o
  // usuário a se tornar VIP pelo fluxo oficial já existente (Seja VIP).
  if (!hasVipAccess) {
    return createPortal(
      <div className="app-modal-overlay fixed inset-0 z-[900] flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
        <div
          className="app-modal-frame app-modal-size-md app-modal-frame--scroll w-full rounded-2xl border border-amber-500/35 bg-[var(--th-bg-raised)] shadow-2xl shadow-amber-950/50"
          onClick={e => e.stopPropagation()}
        >
          <div className="app-modal-header flex items-center justify-between gap-3 px-3.5 py-2.5 border-b border-amber-500/20 bg-gradient-to-r from-amber-950/45 via-amber-900/15 to-[var(--th-bg-overlay)] rounded-t-2xl">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-amber-500/40 bg-amber-500/15 flex-shrink-0">
                <Crown size={14} className="text-amber-300" />
              </span>
              <span className="min-w-0">
                <span className="block text-[13px] font-black leading-tight text-amber-200 truncate">Lucro Esperado — Conteúdo Exclusivo</span>
                <span className="block text-[8.5px] font-bold leading-tight text-slate-400 truncate">Benefício exclusivo para membros VIP</span>
              </span>
            </div>
            <button type="button" onClick={onClose} title="Fechar" className="flex h-6 w-6 items-center justify-center rounded-md text-slate-500 hover:text-white hover:bg-white/10 transition-colors cursor-pointer flex-shrink-0">
              <X size={15} />
            </button>
          </div>
          <div className="app-modal-body custom-scrollbar">
            <div className="flex flex-col items-center gap-4 px-5 py-7 text-center">
              {/* Chamada visual de exclusividade */}
              <span className="relative flex items-center justify-center">
                <span className="absolute h-24 w-24 rounded-full" style={{ background: "radial-gradient(circle, color-mix(in oklab, var(--color-amber-500) 20%, transparent) 0%, transparent 70%)", animation: "vipPulse 2.5s ease-in-out infinite" }} />
                <span className="relative flex h-16 w-16 items-center justify-center rounded-full border-2 border-amber-500/40 bg-gradient-to-br from-amber-500/25 to-amber-500/10 shadow-lg shadow-amber-500/20">
                  <Lock size={26} className="text-amber-300" />
                </span>
              </span>
              <div className="space-y-1">
                <div className="text-lg font-black tracking-wide bg-gradient-to-r from-amber-300 via-amber-500 to-amber-600 bg-clip-text text-transparent">Módulo exclusivo para membros VIP</div>
                <p className="text-[11px] leading-relaxed text-slate-400 max-w-md">
                  O <span className="font-bold text-slate-200">Lucro Esperado</span> é um benefício do acesso VIP: análises de rentabilidade das quests <span className="font-bold text-slate-200">Soul War, Sanguine e Graveborn</span>, valores considerados por servidor e os <span className="font-bold text-slate-200">rankings de rentabilidade</span> — incluindo a análise da troca de runas por <span className="font-bold text-slate-200">Itens Crypt</span>.
                </p>
              </div>
              <span className="inline-flex items-center gap-2 rounded-xl border border-amber-500/50 px-5 py-2 shadow-lg shadow-amber-500/20" style={{ background: "linear-gradient(135deg, color-mix(in oklab, var(--color-amber-500) 25%, transparent) 0%, color-mix(in oklab, var(--color-amber-500) 18%, transparent) 50%, color-mix(in oklab, var(--color-amber-500) 22%, transparent) 100%)" }}>
                <Crown size={16} className="text-amber-300" style={{ filter: "drop-shadow(0 0 6px color-mix(in oklab, var(--color-amber-500) 90%, transparent))" }} />
                <span className="text-[13px] font-black uppercase tracking-widest bg-gradient-to-r from-amber-300 via-amber-400 to-amber-300 bg-clip-text text-transparent">Membro VIP</span>
              </span>
              <button
                type="button"
                onClick={() => setBecomeVipOpen(true)}
                title="Conhecer os planos e benefícios do acesso VIP"
                className="inline-flex items-center gap-1.5 rounded-xl border border-violet-400/60 bg-gradient-to-r from-violet-500/25 to-violet-600/20 px-5 py-2 text-[11px] font-black uppercase tracking-wider text-violet-200 shadow-lg shadow-violet-500/20 hover:from-violet-500/35 hover:to-violet-600/30 transition-colors cursor-pointer"
              >
                <Sparkles size={13} /> Quero ser VIP
              </button>
              <p className="text-[9px] leading-relaxed text-slate-600 max-w-sm">
                Torne-se um membro VIP para desbloquear este e todos os demais recursos exclusivos do aplicativo.
              </p>
            </div>
          </div>
          <style>{`@keyframes vipPulse { 0%, 100% { opacity: 0.6; transform: scale(1); } 50% { opacity: 1; transform: scale(1.1); } }`}</style>
        </div>
        {/* Fluxo OFICIAL de contratação (reuso integral do Seja VIP) */}
        <BecomeVIPModal open={becomeVipOpen} onClose={() => setBecomeVipOpen(false)} userProfile={userProfile} />
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div className="app-modal-overlay fixed inset-0 z-[900] flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div
        className="app-modal-frame app-modal-size-xl app-modal-frame--scroll w-full rounded-2xl border border-emerald-500/25 bg-[var(--th-bg-raised)] shadow-2xl shadow-black/60"
        onClick={e => e.stopPropagation()}
      >
        {/* Cabeçalho — identidade do módulo + fechar */}
        <div className="app-modal-header flex items-center justify-between gap-3 px-3.5 py-2.5 border-b border-[var(--th-line)]/60 bg-gradient-to-r from-emerald-500/[0.08] via-[var(--th-bg-overlay)] to-[var(--th-bg-overlay)] rounded-t-2xl">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-emerald-500/40 bg-emerald-500/15 flex-shrink-0">
              <TrendingUp size={14} className="text-emerald-300" />
            </span>
            <span className="min-w-0">
              <span className="block text-[13px] font-black leading-tight text-emerald-200 truncate">Lucro Esperado — SW / SG / GB</span>
              <span className="block text-[8.5px] font-bold leading-tight text-slate-400 truncate">Retorno esperado por servidor, em RC — Soul War · Sanguine · Graveborn · Itens Crypt</span>
            </span>
          </div>
          <button type="button" onClick={onClose} title="Fechar" className="flex h-6 w-6 items-center justify-center rounded-md text-slate-500 hover:text-white hover:bg-white/10 transition-colors cursor-pointer flex-shrink-0">
            <X size={15} />
          </button>
        </div>

        {/* QUADRO PRINCIPAL — navegação à esquerda; servidor + cotação RC à
            direita (controles agrupados, fixos acima do conteúdo rolável) */}
        <div className="flex-shrink-0 flex items-center justify-between gap-x-3 gap-y-1.5 flex-wrap px-3.5 py-2 border-b border-[var(--th-line)]/60 bg-black/25">
          <div className="inline-flex items-center gap-0.5 rounded-lg border border-[var(--th-line)]/60 bg-black/30 p-0.5">
            {navButtons.map(nav => (
              <button
                key={nav.key}
                type="button"
                onClick={() => setView(nav.key)}
                title={nav.title}
                className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[9px] font-black transition-colors cursor-pointer ${nav.highlight
                  ? (view === nav.key
                    ? "bg-amber-400/25 text-amber-100 border border-amber-400/60 shadow-inner shadow-amber-500/20"
                    : "bg-amber-500/10 text-amber-300 border border-amber-500/40 hover:bg-amber-500/20 hover:text-amber-200 shadow-sm shadow-amber-500/10")
                  : (view === nav.key ? "bg-emerald-500/20 text-emerald-200 shadow-inner" : "text-slate-400 hover:text-slate-200 hover:bg-white/5")}`}
              >
                {nav.icon} {nav.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {/* Servidor + cotação (fonte única "RC Servidores", tempo real) */}
            <label className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--th-line)]/60 bg-black/30 pl-2 pr-1 py-0.5">
              <span className="text-[8px] font-black uppercase tracking-wider text-slate-500">Servidor</span>
              <select
                value={server}
                onChange={e => setServer(e.target.value)}
                aria-label="Servidor"
                className="bg-transparent text-[10.5px] font-black text-slate-100 outline-none cursor-pointer py-0.5"
              >
                {SERVER_OPTIONS.map(s => <option key={s} value={s} className="bg-[var(--th-bg-raised)]">{s}</option>)}
              </select>
            </label>
            <span
              className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 font-mono text-[9px] font-black tabular-nums ${coinRate > 0 ? "border-amber-500/35 bg-amber-500/10 text-amber-300" : "border-red-500/35 bg-red-500/10 text-red-300"}`}
              title={coinRate > 0 ? `Cotação do RC em ${server} (quadro "RC Servidores" do Painel Bazaar): ${coinRateText(coinRate)}k por 1000 RC` : `Servidor sem cotação de RC cadastrada no quadro "RC Servidores" — conversões indisponíveis`}
            >
              <Coins size={9} /> {coinRate > 0 ? `RC a ${coinRateText(coinRate)}k` : "sem cotação"}
            </span>
            {/* 117ª — edição da cotação RC (SÓ Boss; backend revalida): o
                MESMO fluxo único do quadro "RC Servidores"
                (saveOfficialServerCoinRate: validação, "Já atualizado" sem
                gravação, só o servidor selecionado, histórico preservado,
                evento em tempo real para o app inteiro). */}
            {canEditAsBoss && (
              <span className="inline-flex items-center gap-1">
                <input
                  type="text"
                  inputMode="decimal"
                  value={rateDraft}
                  onChange={e => setRateDraft(e.target.value)}
                  aria-label={`Cotação do RC em ${server} (k por 1000 RC)`}
                  placeholder="—"
                  className="w-12 bg-black/40 border border-amber-500/40 focus:border-amber-400/70 rounded-lg px-1.5 py-1 font-mono text-[9px] font-black tabular-nums text-amber-200 text-right outline-none transition-colors placeholder-slate-600"
                  title={`Nova cotação do RC em ${server} (número > 0, até 1 casa decimal — ex.: 2,5)`}
                />
                <button
                  type="button"
                  disabled={savingRate}
                  onClick={() => { void handleSaveRate(); }}
                  className="inline-flex items-center gap-1 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[9px] font-black text-amber-300 hover:bg-amber-500/20 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                  title={`Salvar a cotação de ${server} no quadro oficial "RC Servidores"`}
                >
                  {savingRate ? <RefreshCw size={9} className="animate-spin" /> : <Check size={9} />} Salvar RC
                </button>
                {rateFeedback && (
                  <span className={`text-[8.5px] font-bold ${rateFeedback.ok ? "text-emerald-300" : "text-red-300"}`}>{rateFeedback.message}</span>
                )}
              </span>
            )}
          </div>
        </div>

        {/* Miolo rolável — base global de modais (altura/rolagem) */}
        <div className="app-modal-body custom-scrollbar">
          {view === "resumo" && (
            <div className="flex flex-col gap-2.5 p-3">
              <QuestCard questKey="sw" />
              <QuestCard questKey="sg" />
              <QuestCard questKey="gb" />
              <div className="rounded-lg border border-[var(--th-line)]/40 bg-black/20 px-2.5 py-1.5 text-[8.5px] leading-snug text-slate-500">
                Premissa: recompensas equiprováveis dentro de cada quest (sem confirmação oficial das taxas individuais) — médias calculadas SOMENTE sobre os itens com valor cadastrado em {"\u201C"}Valores Considerados{"\u201D"}. Conversão kk → RC pela cotação de {server} do quadro {"\u201C"}RC Servidores{"\u201D"}.
              </div>
            </div>
          )}

          {view === "crypt" && (
            <div className="flex flex-col gap-2.5 p-3">
              <div className="rounded-xl border border-[var(--th-line)]/60 bg-black/25 overflow-hidden">
                <div className="flex items-center justify-between gap-2 flex-wrap px-2.5 py-1.5 border-b border-[var(--th-line)]/40 bg-white/[0.02]">
                  <span className="text-[11.5px] font-black tracking-wide text-amber-200">Conversão — {CRYPT_RUNES_REQUIRED} runas ➜ 1 item Crypt</span>
                  <span className="inline-flex items-center gap-1 rounded-md border border-violet-500/40 bg-violet-500/10 px-1.5 py-0.5 text-[8.5px] font-black text-violet-300">
                    <Package size={8} /> {CRYPT_ITEMS.length} itens possíveis
                  </span>
                </div>
                <div className="p-2.5 space-y-1.5">
                  <div className="rounded-md border border-[var(--th-line)]/40 bg-black/20 px-2 py-1 text-[8.5px] leading-snug text-slate-400">
                    Mecânica do Graveborn: {CRYPT_RUNES_REQUIRED} runas de recompensa viram 1 item Crypt aleatório. O saldo desconta o custo de oportunidade das runas gastas (média das runas configuradas) — runas e item NUNCA contam como duas recompensas.
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                    <CryptConversionBox kind="direct" />
                    <CryptConversionBox kind="patient" />
                  </div>
                </div>
              </div>
              {/* Os 7 itens Crypt — valores individuais em RC */}
              <div className="rounded-xl border border-[var(--th-line)]/60 bg-black/25 overflow-hidden">
                <div className="px-2.5 py-1.5 border-b border-[var(--th-line)]/40 bg-white/[0.02] text-[9px] font-black uppercase tracking-wider text-slate-400">Itens Crypt em {server} (RC)</div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 p-2.5">
                  {CRYPT_ITEMS.map(item => {
                    const entry = getExpectedItemEntry(values, server, item);
                    const dRc = coinRate > 0 && entry.d ? computeItemRC(coinRate, entry.d) : null;
                    const pRc = coinRate > 0 && entry.p ? computeItemRC(coinRate, entry.p) : null;
                    return (
                      <div key={item} className="flex items-center justify-between gap-2 rounded-md border border-[var(--th-line)]/40 bg-black/25 px-2 py-1.5">
                        <span className="text-[9.5px] font-bold text-slate-200 truncate">{item}</span>
                        <span className="flex items-center gap-1 font-mono text-[9px] font-black tabular-nums flex-shrink-0">
                          <span className="rounded bg-sky-500/15 px-1.5 py-px text-sky-300" title="Venda Direta (mínimo)">D {dRc === null ? "—" : dRc.toLocaleString("pt-BR")}</span>
                          <span className="rounded bg-violet-500/15 px-1.5 py-px text-violet-300" title="Venda Paciente (média)">P {pRc === null ? "—" : pRc.toLocaleString("pt-BR")}</span>
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* ── RANKING (123ª) — classificação dos servidores ─────────────
              Consulta aberta a todos (nada editável aqui); derivado 100%
              das fontes únicas (valores considerados + cotações RC) e
              recalculado em tempo real pelos MESMOS eventos do modal. */}
          {view === "ranking" && (
            <div className="flex flex-col gap-2 p-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                {/* Guias internas: Quests × Itens Crypt */}
                <div className="inline-flex items-center gap-0.5 rounded-lg border border-[var(--th-line)]/60 bg-black/30 p-0.5">
                  <button
                    type="button"
                    onClick={() => setRankingTab("quests")}
                    title="Ranking dos servidores pelas três quests, em Venda Direta e Venda Paciente (RC/h)"
                    className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[9px] font-black transition-colors cursor-pointer ${rankingTab === "quests" ? "bg-amber-500/20 text-amber-200 shadow-inner" : "text-slate-400 hover:text-slate-200 hover:bg-white/5"}`}
                  >
                    <TrendingUp size={10} /> Ranking das Quests
                  </button>
                  <button
                    type="button"
                    onClick={() => setRankingTab("cryptRank")}
                    title={`Servidores mais vantajosos para trocar ${CRYPT_RUNES_REQUIRED} runas Graveborn por 1 item Crypt`}
                    className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[9px] font-black transition-colors cursor-pointer ${rankingTab === "cryptRank" ? "bg-amber-500/20 text-amber-200 shadow-inner" : "text-slate-400 hover:text-slate-200 hover:bg-white/5"}`}
                  >
                    <Package size={10} /> Itens Crypt
                  </button>
                </div>
                <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/[0.07] px-1.5 py-0.5 text-[8px] font-bold text-emerald-300/90" title="O ranking recalcula automaticamente quando o Boss altera valores de itens ou cotações RC — mesmos eventos em tempo real do restante do modal">
                  <RefreshCw size={8} /> atualização automática
                </span>
              </div>

              {rankingTab === "quests" && (
                <>
                  <div className="rounded-lg border border-[var(--th-line)]/40 bg-black/20 px-2.5 py-1.5 text-[8.5px] leading-snug text-slate-500">
                    Classificação de TODOS os servidores cadastrados pelo retorno esperado em <span className="font-bold text-slate-300">RC/h</span> — valores dos itens, chance de drop e tempo médio de cada quest (mesmos cálculos do Resumo), com a cotação RC <span className="font-bold text-slate-300">do próprio servidor</span>. Clique no cabeçalho de uma coluna para ordenar por ela. <span className="text-slate-400">Célula {"\u201C"}—{"\u201D"} = servidor sem cotação ou sem item configurado na categoria (nenhum valor é inventado); itens parciais são sinalizados.</span>
                  </div>
                  <div className="rounded-xl border border-[var(--th-line)]/60 bg-black/25 overflow-hidden">
                    <div className="overflow-x-auto custom-scrollbar">
                      <table className="w-full min-w-[660px] border-collapse text-[9px]">
                        <thead>
                          <tr className="border-b border-[var(--th-line)]/40 bg-white/[0.02]">
                            <th rowSpan={2} className="sticky left-0 z-[1] bg-[var(--th-bg-raised)] px-2.5 py-1.5 text-left text-[8px] font-black uppercase tracking-wider text-slate-500 border-r border-[var(--th-line)]/40">Servidor</th>
                            {EXPECTED_QUESTS.map(def => (
                              <th key={def.key} colSpan={2} className="px-1.5 pt-1.5 pb-0.5 text-center text-[8.5px] font-black tracking-wide text-amber-200 border-l border-[var(--th-line)]/30">
                                {def.label}
                                <span className="block text-[7px] font-bold text-slate-500 normal-case tracking-normal">{def.dropChance >= 1 ? "drop 100%" : `drop ${Math.round(def.dropChance * 100)}%/rotação`} · {def.timeLabel}</span>
                              </th>
                            ))}
                          </tr>
                          <tr className="border-b border-[var(--th-line)]/40 bg-white/[0.02]">
                            {QUEST_RANKING_COLUMNS.map(col => {
                              const isDirect = col.category === "direct";
                              const active = rankSort.col === col.key;
                              return (
                                <th key={col.key} className={`px-1 pb-1 pt-0.5 text-center ${isDirect ? "border-l border-[var(--th-line)]/30" : ""}`}>
                                  <button
                                    type="button"
                                    onClick={() => toggleRankSort(col.key)}
                                    aria-label={`Ordenar por ${EXPECTED_QUESTS.find(q => q.key === col.quest)?.label} — ${isDirect ? "Venda Direta" : "Venda Paciente"}`}
                                    title={`Ordenar os servidores por esta coluna (${active ? (rankSort.dir === "desc" ? "melhor primeiro — clique para inverter" : "pior primeiro — clique para inverter") : "melhor primeiro"})`}
                                    className={`inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[7.5px] font-black uppercase tracking-wide transition-colors cursor-pointer border ${active
                                      ? (isDirect ? "border-sky-400/60 bg-sky-500/20 text-sky-100" : "border-violet-400/60 bg-violet-500/20 text-violet-100")
                                      : (isDirect ? "border-sky-500/25 bg-sky-500/[0.06] text-sky-300/80 hover:bg-sky-500/15" : "border-violet-500/25 bg-violet-500/[0.06] text-violet-300/80 hover:bg-violet-500/15")}`}
                                  >
                                    {isDirect ? "Direta" : "Paciente"}
                                    {active ? (rankSort.dir === "desc" ? <ArrowDown size={8} /> : <ArrowUp size={8} />) : null}
                                  </button>
                                </th>
                              );
                            })}
                          </tr>
                        </thead>
                        <tbody>
                          {sortedQuestRanking.map(row => (
                            <tr key={row.server} className={`border-b border-[var(--th-line)]/20 last:border-b-0 transition-colors hover:bg-white/[0.03] ${row.hasAnyData ? "" : "opacity-50"}`}>
                              <td className="sticky left-0 z-[1] bg-[var(--th-bg-raised)] px-2.5 py-1.5 border-r border-[var(--th-line)]/40">
                                <span className="block text-[9.5px] font-black text-slate-100 leading-tight whitespace-nowrap">{row.server}</span>
                                <span className={`block text-[7.5px] font-bold leading-tight ${row.coinRate > 0 ? "text-slate-500" : "text-red-400/80"}`}>
                                  {row.coinRate > 0 ? `RC a ${coinRateText(row.coinRate)}k` : "sem cotação RC"}
                                </span>
                              </td>
                              {QUEST_RANKING_COLUMNS.map(col => {
                                const cell = row.cells[col.key];
                                const pos = questColumnPositions[col.key][row.server];
                                const partial = cell.configured > 0 && cell.configured < cell.total;
                                const posCls = pos === 1
                                  ? "border-amber-400/70 bg-amber-400/20 text-amber-100 shadow-sm shadow-amber-500/20"
                                  : pos === 2
                                    ? "border-slate-300/50 bg-slate-300/15 text-slate-100"
                                    : pos === 3
                                      ? "border-orange-400/50 bg-orange-500/15 text-orange-200"
                                      : "border-transparent text-slate-300";
                                return (
                                  <td key={col.key} className={`px-1 py-1 text-center ${col.category === "direct" ? "border-l border-[var(--th-line)]/30" : ""}`}>
                                    {cell.rcPerHour === null ? (
                                      <span className="font-mono text-[9px] text-slate-600" title={row.coinRate > 0 ? "Nenhum item desta categoria configurado neste servidor" : "Servidor sem cotação RC cadastrada"}>—</span>
                                    ) : (
                                      <span
                                        className={`inline-flex items-baseline gap-0.5 rounded-md border px-1.5 py-0.5 font-mono font-black tabular-nums ${posCls}`}
                                        title={`${row.server} — ${EXPECTED_QUESTS.find(q => q.key === col.quest)?.label} (${col.category === "direct" ? "Venda Direta" : "Venda Paciente"})${pos ? ` · ${pos}º lugar da coluna` : ""}\n1 recompensa: ${formatRC(Math.round(cell.perRewardRc ?? 0))} · ${cell.configured}/${cell.total} itens configurados${partial ? " (parcial)" : ""}`}
                                      >
                                        {pos === 1 && <Trophy size={8} className="self-center" />}
                                        <span className="text-[9.5px]">{cell.rcPerHour.toLocaleString("pt-BR")}</span>
                                        <span className="text-[6.5px] font-black uppercase opacity-80">RC/h</span>
                                        {partial && <span className="self-center h-1 w-1 rounded-full bg-amber-400" title={`Parcial: ${cell.configured}/${cell.total} itens configurados`} />}
                                      </span>
                                    )}
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                  <div className="rounded-lg border border-[var(--th-line)]/40 bg-black/20 px-2.5 py-1.5 text-[8px] leading-snug text-slate-500 flex items-center gap-2 flex-wrap">
                    <span className="inline-flex items-center gap-1"><span className="inline-flex items-center gap-0.5 rounded-md border border-amber-400/70 bg-amber-400/20 px-1 py-px text-amber-100 font-black"><Trophy size={7} /> 1º</span> melhor da coluna</span>
                    <span className="inline-flex items-center gap-1"><span className="rounded-md border border-slate-300/50 bg-slate-300/15 px-1 py-px text-slate-100 font-black">2º</span><span className="rounded-md border border-orange-400/50 bg-orange-500/15 px-1 py-px text-orange-200 font-black">3º</span> demais destaques</span>
                    <span className="inline-flex items-center gap-1"><span className="h-1 w-1 rounded-full bg-amber-400 inline-block" /> itens parciais na categoria</span>
                    <span>Premissa: recompensas equiprováveis (médias só dos itens configurados).</span>
                  </div>
                </>
              )}

              {rankingTab === "cryptRank" && (
                <>
                  <div className="rounded-lg border border-[var(--th-line)]/40 bg-black/20 px-2.5 py-1.5 text-[8.5px] leading-snug text-slate-500">
                    Troca de <span className="font-bold text-slate-300">{CRYPT_RUNES_REQUIRED} runas Graveborn</span> por <span className="font-bold text-slate-300">1 item Crypt aleatório</span>, por servidor — do melhor para o pior resultado. <span className="text-violet-300 font-bold">Custo</span> = soma das {CRYPT_RUNES_REQUIRED} runas na <span className="text-violet-300 font-bold">Venda Paciente</span> (custo de oportunidade: as runas gastas deixam de ser vendidas — NUNCA contam como recompensa). <span className="text-sky-300 font-bold">Recompensa</span> = valor esperado dos {CRYPT_ITEMS.length} itens Crypt na <span className="text-sky-300 font-bold">Venda Direta</span>. Premissa do módulo (sem distribuição individual confirmada): os {CRYPT_ITEMS.length} itens são <span className="font-bold text-slate-300">equiprováveis</span> — valor esperado = média dos itens configurados. Resultado = recompensa − custo; Rentabilidade = resultado ÷ custo × 100.
                  </div>
                  <div className="rounded-xl border border-[var(--th-line)]/60 bg-black/25 overflow-hidden">
                    <div className="overflow-x-auto custom-scrollbar">
                      <table className="w-full min-w-[620px] border-collapse text-[9px]">
                        <thead>
                          <tr className="border-b border-[var(--th-line)]/40 bg-white/[0.02] text-[8px] font-black uppercase tracking-wider text-slate-500">
                            <th className="px-2 py-1.5 text-center w-8">#</th>
                            <th className="px-2 py-1.5 text-left">Servidor</th>
                            <th className="px-2 py-1.5 text-right text-violet-300/90" title={`Soma em RC das ${CRYPT_RUNES_REQUIRED} runas Graveborn na Venda Paciente do servidor`}>Custo {CRYPT_RUNES_REQUIRED} runas (P)</th>
                            <th className="px-2 py-1.5 text-right text-sky-300/90" title={`Valor esperado em RC do item Crypt recebido — média equiprovável dos ${CRYPT_ITEMS.length} itens na Venda Direta do servidor`}>Item Crypt esperado (D)</th>
                            <th className="px-2 py-1.5 text-right" title="Resultado = valor esperado Crypt − custo das 5 runas">Resultado</th>
                            <th className="px-2 py-1.5 text-right" title="Rentabilidade (%) = Resultado ÷ Custo das 5 runas × 100">Rentab.</th>
                          </tr>
                        </thead>
                        <tbody>
                          {cryptRankingRows.map((row, index) => {
                            const ranked = row.netRc !== null;
                            const pos = ranked ? index + 1 : null;
                            const missingReason = row.coinRate <= 0
                              ? "Servidor sem cotação RC cadastrada"
                              : row.runesConfigured === 0
                                ? "Nenhuma runa com Venda Paciente cadastrada"
                                : "Nenhum item Crypt com Venda Direta cadastrada";
                            const partial = ranked && (row.runesConfigured < CRYPT_RUNES_REQUIRED || row.cryptConfigured < CRYPT_ITEMS.length);
                            return (
                              <tr key={row.server} className={`border-b border-[var(--th-line)]/20 last:border-b-0 transition-colors hover:bg-white/[0.03] ${ranked ? "" : "opacity-50"} ${pos === 1 ? "bg-amber-400/[0.07]" : ""}`}>
                                <td className="px-2 py-1.5 text-center">
                                  {pos === null ? (
                                    <span className="text-slate-600">—</span>
                                  ) : (
                                    <span className={`inline-flex items-center justify-center gap-0.5 rounded-md border px-1 py-px font-mono font-black tabular-nums ${pos === 1 ? "border-amber-400/70 bg-amber-400/20 text-amber-100" : pos === 2 ? "border-slate-300/50 bg-slate-300/15 text-slate-100" : pos === 3 ? "border-orange-400/50 bg-orange-500/15 text-orange-200" : "border-transparent text-slate-400"}`}>
                                      {pos === 1 && <Trophy size={8} />}{pos}º
                                    </span>
                                  )}
                                </td>
                                <td className="px-2 py-1.5">
                                  <span className="block text-[9.5px] font-black text-slate-100 leading-tight whitespace-nowrap">{row.server}</span>
                                  <span className={`block text-[7.5px] font-bold leading-tight ${row.coinRate > 0 ? "text-slate-500" : "text-red-400/80"}`}>
                                    {row.coinRate > 0 ? `RC a ${coinRateText(row.coinRate)}k` : "sem cotação RC"}
                                    {ranked && <span className={partial ? "text-amber-400/90" : ""}> · runas {row.runesConfigured}/{CRYPT_RUNES_REQUIRED} · crypt {row.cryptConfigured}/{CRYPT_ITEMS.length}{partial ? " (parcial)" : ""}</span>}
                                  </span>
                                </td>
                                {ranked ? (
                                  <>
                                    <td className="px-2 py-1.5 text-right font-mono font-bold tabular-nums text-violet-300" title={`Média das runas configuradas × ${CRYPT_RUNES_REQUIRED} (Venda Paciente de ${row.server})`}>{formatRC(Math.round(row.runesCostRc ?? 0))}</td>
                                    <td className="px-2 py-1.5 text-right font-mono font-bold tabular-nums text-sky-300" title={`Média equiprovável dos ${row.cryptConfigured} itens Crypt configurados (Venda Direta de ${row.server})`}>{formatRC(Math.round(row.expectedCryptRc ?? 0))}</td>
                                    <td className="px-2 py-1.5 text-right">
                                      <span className={`inline-block rounded-md px-1.5 py-px font-mono font-black tabular-nums ${(row.netRc ?? 0) >= 0 ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300"}`}>
                                        {(row.netRc ?? 0) >= 0 ? "+" : "−"}{formatRC(Math.abs(Math.round(row.netRc ?? 0)))}
                                      </span>
                                    </td>
                                    <td className={`px-2 py-1.5 text-right font-mono font-black tabular-nums ${(row.profitPct ?? 0) >= 0 ? "text-emerald-300" : "text-red-300"}`}>
                                      {(row.profitPct ?? 0) >= 0 ? "+" : "−"}{Math.abs(row.profitPct ?? 0).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%
                                    </td>
                                  </>
                                ) : (
                                  <td colSpan={4} className="px-2 py-1.5 text-right text-[8px] font-bold text-slate-600 italic" title={missingReason}>
                                    não configurado — {missingReason.toLowerCase()}
                                  </td>
                                )}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {view === "valores" && (
            <div className="flex flex-col gap-2 p-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="inline-flex items-center gap-0.5 rounded-lg border border-[var(--th-line)]/60 bg-black/30 p-0.5">
                  {GROUPS.map(g => (
                    <button
                      key={g.key}
                      type="button"
                      onClick={() => setEditGroup(g.key)}
                      className={`rounded-md px-2 py-1 text-[9px] font-black transition-colors cursor-pointer ${editGroup === g.key ? "bg-amber-500/20 text-amber-200 shadow-inner" : "text-slate-400 hover:text-slate-200 hover:bg-white/5"}`}
                    >
                      {g.label}
                    </button>
                  ))}
                </div>
                <span className="text-[8.5px] font-bold text-slate-500">{group.items.length} itens em <span className="text-slate-300">{server}</span></span>
              </div>
              <div className="rounded-lg border border-[var(--th-line)]/40 bg-black/20 px-2.5 py-1.5 text-[8.5px] leading-snug text-slate-500">
                Valores em kk por item em <span className="font-bold text-slate-300">{server}</span> — <span className="text-sky-300 font-bold">Venda Direta</span> = mínimo alcançável (maior oferta de compra); <span className="text-violet-300 font-bold">Venda Paciente</span> = média esperada sem pressa. Campo vazio = não configurado (fica fora das médias).
                <span className="block mt-0.5">A <span className="text-sky-300 font-bold">Venda Direta</span> é o MESMO valor <span className="font-bold text-slate-300">Base</span> da Lista de Itens do Painel Bazaar (guia Personagens Com Itens): alterar e salvar em qualquer um dos dois atualiza o outro em tempo real, no servidor correspondente. A <span className="text-violet-300 font-bold">Venda Paciente</span> nunca é alterada pela sincronização.</span>
                {!canEditAsBoss && <span className="block text-amber-400/80 font-bold mt-0.5">Somente usuários Boss podem editar e salvar estes valores.</span>}
              </div>
              <div className="rounded-xl border border-[var(--th-line)]/60 bg-black/25 overflow-hidden">
                {/* Cabeçalho das colunas */}
                <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-[var(--th-line)]/40 bg-white/[0.02] text-[8px] font-black uppercase tracking-wider text-slate-500">
                  <span className="flex-1 min-w-0">Item · última atualização</span>
                  <span className="w-20 text-right text-sky-300/90">Direta (kk)</span>
                  <span className="w-20 text-right text-violet-300/90">Paciente (kk)</span>
                  <span className="w-24 text-right hidden sm:block">RC (D / P)</span>
                </div>
                <div className="p-1.5 space-y-px">
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
                      <div key={item} className="flex items-center gap-1.5 rounded-md px-1 py-1 hover:bg-white/[0.03] transition-colors">
                        <span className="flex-1 min-w-0">
                          <span className="block text-[9.5px] font-bold text-slate-200 truncate leading-tight" title={item}>{item}</span>
                          <span className={`block text-[8px] leading-tight truncate ${updatedAtMs ? "text-slate-500" : "text-slate-600 italic"}`} title="Última atualização do valor deste item neste servidor">
                            {updatedAtMs ? `Atualizado ${formatWatchedUpdatedAt(updatedAtMs, tzOffsetMinutes)}` : "Não atualizado"}
                          </span>
                        </span>
                        {canEditAsBoss ? (
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
              </div>
              {canEditAsBoss && (
                <div className="flex items-center justify-between gap-2 rounded-lg border border-[var(--th-line)]/40 bg-black/20 px-2.5 py-1.5">
                  <span className={`text-[9px] font-bold ${feedback ? (feedback.ok ? "text-emerald-300" : "text-red-300") : "text-transparent"}`}>
                    {feedback?.message || "."}
                  </span>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => { void handleSave(); }}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 px-3.5 py-1.5 text-[10px] font-black text-black transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
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
