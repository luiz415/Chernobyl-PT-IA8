import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, Coins, Percent, RotateCcw, Check, Minus, Plus, Globe, RefreshCw } from "lucide-react";
import type { ItemSaleRecord } from "../types";
import { formatRC } from "../types";
import { SERVER_COIN_RATES_EVENT, getServerCoinRate, readLocalCoinRates, saveOfficialServerCoinRate } from "../utils/bazaarCoinRates";
// 122ª — Valor BASE global do item (Lista de Itens do Painel Bazaar): leitura
// viva + edição pelo Boss pelo MESMO núcleo oficial de sempre (escopo
// servidor). Nenhuma fonte nova — o modal apenas espelha e delega.
import {
  BAZAAR_WATCHED_ITEMS_UPDATED_EVENT,
  applyOfficialWatchedItemUpdate,
  findServerWatchedItem,
  loadWatchedItemsByServer,
  parseDecimalKkText,
  sanitizeDecimalKkText,
} from "../utils/bazaarWatchedItems";
import { SERVER_OPTIONS } from "../constants/servers";
import { useAuth } from "../context/AuthContext";
import {
  OFFER_TAX_CAP_KK,
  OFFER_TAX_PERCENT,
  SALE_TAX_CAP_KK,
  SALE_TAX_PERCENT,
  buildItemSaleNoValueRecord,
  buildItemSaleRecord,
  computeItemRC,
  computeMarketTaxTotalKk,
  computeOfferTaxPerOfferKk,
  computeOfferTaxTotalKk,
  computeSaleTaxKk,
  formatKkValue,
  formatRateKkDisplay,
  parseRateKk,
  sanitizeRateKkInput,
} from "../utils/itemSale";

/**
 * MODAL "ITEM VENDIDO"
 * --------------------
 * Fluxo único e claro: valor vendido do item + valor do RC no Market +
 * quantidade de OFERTAS CRIADAS -> resultado em RC, com as DUAS taxas
 * vigentes do Market (regra em src/utils/itemSale.ts):
 *   • criação: 1% por oferta criada, máx. 1kk cada;
 *   • venda concluída: 3% uma única vez, máx. 5kk.
 *
 * Compartilhado entre o PartyPanel (coluna ITEM VENDIDO/SERVICE) e a guia
 * Meus Personagens (Lucro SW / Lucro SG) — mesma operação, mesmo registro.
 */
interface Props {
  /** Nome do item dropado (contexto no cabeçalho). */
  itemName: string;
  /** Rótulo do contexto: nome do personagem/jogador ou da Quest. */
  contextLabel?: string;
  /** Registro existente (reabrir para editar antes do salvamento permanente). */
  initial?: ItemSaleRecord | null;
  /**
   * Exibe a opção "Não informar valor" (padrão: true). Desligada onde o
   * destino da persistência só armazena o LUCRO numérico (ex.: negociados
   * entre usuários) e não comporta uma venda sem valor.
   */
  allowNoValue?: boolean;
  /**
   * SERVIDOR do item (53ª tarefa): usado APENAS para pré-preencher o campo
   * "RC no Market" com a cotação GLOBAL configurada pelo Boss para esse
   * servidor (modal "RC Servidores"/Lista de Itens — fonte única). O
   * usuário pode editar o valor livremente para ESTA operação; a edição
   * nunca altera a configuração global. Servidor sem cotação (ou prop
   * ausente) → campo vazio, como sempre (nunca inventamos conversão).
   */
  server?: string | null;
  /**
   * 122ª — Nome do item na LISTA DE ITENS do Painel Bazaar (lookup/edição do
   * Valor Base). Ausente, o lookup usa o próprio `itemName` (itens de Quest/
   * PT, cujo nome encontrado é o nome da lista).
   */
  watchedItemName?: string | null;
  /**
   * 122ª — Valor CONSIDERADO (kk) do item: snapshot HISTÓRICO registrado no
   * momento da compra do personagem (ou a personalização atual do usuário).
   * `undefined` = contexto sem o conceito (a linha nem aparece); `null` =
   * contexto com o conceito, mas sem valor conhecido ("—"). O modal apenas
   * EXIBE o valor recebido — nunca o recalcula nem o regrava.
   */
  consideredKk?: number | null;
  /**
   * 122ª — true quando `consideredKk` é o valor BASE atual usado como
   * FALLBACK (compra antiga sem o snapshot) — o modal sinaliza que não é um
   * registro histórico (nenhum valor histórico é inventado).
   */
  consideredIsFallback?: boolean;
  onCancel: () => void;
  onSave: (record: ItemSaleRecord) => void;
}

export default function ItemSoldModal({ itemName, contextLabel, initial, allowNoValue = true, server, watchedItemName, consideredKk, consideredIsFallback = false, onCancel, onSave }: Props) {
  // ── 113ª — ATUALIZAÇÃO DO RC OFICIAL DO SERVIDOR (EXCLUSIVA DO BOSS) ──────
  // O cargo vem do MESMO AuthContext que o app inteiro já mantém (nenhuma
  // leitura nova no Firebase). Quando o Boss digita no campo "RC no Market"
  // um valor DIFERENTE da cotação oficial cadastrada para o servidor do
  // item, aparece a opção de confirmar a atualização — que usa o MESMO
  // fluxo único do quadro "RC Servidores"/modais "Ver" (69ª/70ª):
  // saveOfficialServerCoinRate → persistCoinRates → appSettings/global
  // .serverCoinRates + histórico + espelho local + evento (as Security
  // Rules revalidam o cargo no backend). Para quem não é Boss NADA muda —
  // o campo continua valendo só para ESTA venda, como sempre. Vendas já
  // registradas carregam o próprio rateKk no registro e NUNCA são
  // retocadas por uma mudança de cotação.
  const { userProfile } = useAuth();
  const canUpdateOfficialRate = userProfile?.role === "Boss" && !!String(server || "").trim();
  const [officialRate, setOfficialRate] = useState(() => getServerCoinRate(readLocalCoinRates(), server));
  useEffect(() => {
    const refresh = () => setOfficialRate(getServerCoinRate(readLocalCoinRates(), server));
    refresh();
    // Mesmo evento do quadro "RC Servidores": alterações feitas em QUALQUER
    // modal (inclusive a confirmação abaixo) refletem aqui na hora.
    window.addEventListener(SERVER_COIN_RATES_EVENT, refresh);
    return () => window.removeEventListener(SERVER_COIN_RATES_EVENT, refresh);
  }, [server]);
  const [rateSaving, setRateSaving] = useState(false);
  const [rateFeedback, setRateFeedback] = useState<{ ok: boolean; message: string } | null>(null);
  const rateTimerRef = useRef<number | null>(null);
  useEffect(() => () => { if (rateTimerRef.current !== null) window.clearTimeout(rateTimerRef.current); }, []);

  // ── 122ª — VALORES DE REFERÊNCIA DO ITEM (Base global × Considerado) ─────
  // VALOR BASE: espelho VIVO da Lista de Itens do SERVIDOR do item (mesma
  // fonte única de todo o app), re-renderizado pelo evento oficial. O Boss
  // edita em campo PRÓPRIO (separado do valor de venda) e salvar grava pelo
  // MESMO núcleo applyOfficialWatchedItemUpdate — SÓ o servidor deste item;
  // demais servidores, Valor Considerado e vendas registradas ficam
  // intocados. Usuário comum: somente visualização.
  const serverName = String(server || "").trim();
  const baseLookupName = String(watchedItemName || itemName || "").trim();
  const [watchedVersion, setWatchedVersion] = useState(0);
  useEffect(() => {
    const bump = () => setWatchedVersion(v => v + 1);
    window.addEventListener(BAZAAR_WATCHED_ITEMS_UPDATED_EVENT, bump);
    return () => window.removeEventListener(BAZAAR_WATCHED_ITEMS_UPDATED_EVENT, bump);
  }, []);
  const liveBaseKk = useMemo(() => {
    if (!serverName || !baseLookupName) return null;
    const listed = findServerWatchedItem(loadWatchedItemsByServer(), serverName, baseLookupName);
    return listed ? listed.valueKk : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverName, baseLookupName, watchedVersion]);
  const canEditBase = userProfile?.role === "Boss" && !!serverName && !!baseLookupName;
  // Rascunho do Base (padrão 120ª): sem rascunho, o campo ESPELHA o valor
  // vivo da lista; "sujo" = difere do oficial → botão salvar habilita.
  const liveBaseText = liveBaseKk !== null ? String(liveBaseKk).replace(".", ",") : "";
  const [baseDraft, setBaseDraft] = useState<string | undefined>(undefined);
  const baseValue = baseDraft ?? liveBaseText;
  const baseDirty = baseDraft !== undefined && baseDraft !== liveBaseText;
  const [baseFeedback, setBaseFeedback] = useState<{ ok: boolean; message: string } | null>(null);
  const baseTimerRef = useRef<number | null>(null);
  useEffect(() => () => { if (baseTimerRef.current !== null) window.clearTimeout(baseTimerRef.current); }, []);
  function confirmBaseUpdate() {
    if (!canEditBase || !baseDirty) return;
    const valueKk = parseDecimalKkText(baseValue);
    const result = valueKk === null
      ? { ok: false as const, error: "Valor base inválido — kk maior que zero, com até 1 casa decimal (ex.: 1,5).", changedServers: [] as string[], addedServers: [] as string[] }
      : applyOfficialWatchedItemUpdate({ scope: "server", server: serverName, itemName: baseLookupName, valueKk, serverUniverse: SERVER_OPTIONS });
    const touched = result.changedServers.length + result.addedServers.length;
    setBaseFeedback({
      ok: result.ok,
      message: !result.ok
        ? (result.error || "Falha ao atualizar a Lista de Itens.")
        : touched === 0 ? "Já atualizado" : `${serverName} atualizado`,
    });
    if (result.ok) setBaseDraft(undefined); // volta a espelhar o oficial (novo)
    if (baseTimerRef.current !== null) window.clearTimeout(baseTimerRef.current);
    baseTimerRef.current = window.setTimeout(() => { setBaseFeedback(null); baseTimerRef.current = null; }, result.ok ? 2500 : 4000);
  }
  // VALOR CONSIDERADO exibido (> 0) — snapshot recebido por prop, nunca
  // recalculado aqui; alimenta também a comparação com a venda.
  const shownConsideredKk = typeof consideredKk === "number" && consideredKk > 0 ? consideredKk : null;

  // ── Estado dos campos (strings de digitação, pt-BR) ───────────────────────
  const [vendaRaw, setVendaRaw] = useState(() => initial && initial.vendaKk > 0 ? formatRateKkDisplay(initial.vendaKk) : "");
  // "RC no Market": o registro em edição tem precedência; sem registro, o
  // campo abre com a cotação GLOBAL do servidor (quando configurada) — a
  // edição aqui vale só para ESTA venda e nunca regrava a configuração.
  const [rateRaw, setRateRaw] = useState(() => {
    if (initial && initial.rateKk > 0) return formatRateKkDisplay(initial.rateKk);
    const serverRate = getServerCoinRate(readLocalCoinRates(), server);
    return serverRate > 0 ? formatRateKkDisplay(serverRate) : "";
  });
  // Quantidade de OFERTAS CRIADAS no Market para este item (0 = venda direta
  // para oferta de compra, sem criar oferta própria).
  const [offerCount, setOfferCount] = useState(() => initial?.taxCount || 0);
  // "Não informar valor": confirma a venda SEM preço — o item é encerrado
  // com os campos financeiros zerados (nunca entra em métricas). Reabrir um
  // registro sem valor volta com a opção marcada.
  const [noValue, setNoValue] = useState(() => allowNoValue && initial?.noValue === true);

  // Esc fecha sem salvar (padrão dos demais modais do app).
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onCancel(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  // ── Valores numéricos derivados ───────────────────────────────────────────
  // `parseRateKk` aceita vírgula pt-BR; venda também tolera decimais.
  const vendaKk = parseRateKk(vendaRaw);
  const rateKk = parseRateKk(rateRaw);

  // 113ª — oferta de atualização: Boss + servidor conhecido + valor válido
  // digitado DIFERENTE da cotação oficial vigente (mesmo epsilon da
  // idempotência do fluxo oficial; cobre também servidor ainda SEM cotação).
  const officialRateDiffers = canUpdateOfficialRate && !noValue && rateKk > 0 && Math.abs(rateKk - officialRate) >= 0.0001;
  async function confirmOfficialRateUpdate() {
    if (!canUpdateOfficialRate || rateSaving) return;
    setRateSaving(true);
    try {
      // MESMO fluxo único do quadro "RC Servidores"/modais "Ver": validação
      // oficial (número > 0, 1 casa), "Já atualizado" sem gravar, altera SÓ
      // a chave DESTE servidor e preserva as demais; nunca lança.
      const result = await saveOfficialServerCoinRate(String(server || ""), rateRaw);
      setRateFeedback({ ok: result.ok, message: result.message });
      if (rateTimerRef.current !== null) window.clearTimeout(rateTimerRef.current);
      rateTimerRef.current = window.setTimeout(() => { setRateFeedback(null); rateTimerRef.current = null; }, result.ok ? 2500 : 4000);
      // Espelho local já disparou o SERVER_COIN_RATES_EVENT; o refresh aqui
      // é só cinto de segurança para ambientes sem o evento.
      setOfficialRate(getServerCoinRate(readLocalCoinRates(), server));
    } finally {
      setRateSaving(false);
    }
  }

  const readyForTax = vendaKk > 0 && rateKk > 0;
  const preview = useMemo(() => {
    const offerPerKk = offerCount > 0 ? computeOfferTaxPerOfferKk(vendaKk) : 0;
    const offerTotalKk = computeOfferTaxTotalKk(vendaKk, offerCount);
    const saleTaxKk = computeSaleTaxKk(vendaKk);
    const taxKk = computeMarketTaxTotalKk(vendaKk, offerCount);
    const netKk = Math.max(0, Math.round((vendaKk - taxKk) * 100) / 100);
    return { offerPerKk, offerTotalKk, saleTaxKk, taxKk, netKk, resultRC: computeItemRC(rateKk, netKk) };
  }, [vendaKk, rateKk, offerCount]);

  // Tetos atingidos — só para os textos explicativos.
  const offerCapped = vendaKk > 0 && (vendaKk * OFFER_TAX_PERCENT) / 100 > OFFER_TAX_CAP_KK;
  const saleCapped = vendaKk > 0 && (vendaKk * SALE_TAX_PERCENT) / 100 > SALE_TAX_CAP_KK;

  function handleSave() {
    // Venda sem valor: registro próprio (tudo zerado + noValue) — o fluxo
    // com valor permanece EXATAMENTE o atual quando a opção está desmarcada.
    if (noValue) { onSave(buildItemSaleNoValueRecord()); return; }
    if (!readyForTax) return;
    onSave(buildItemSaleRecord(vendaKk, rateKk, offerCount));
  }

  const inputCls = "w-full bg-black/40 border rounded-lg px-2.5 py-1.5 text-sm text-right tabular-nums outline-none transition-colors placeholder-slate-600";

  return createPortal(
    <div
      className="fixed inset-0 z-[500] flex items-center justify-center bg-black/75 backdrop-blur-sm p-4"
      onMouseDown={e => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="w-full max-w-sm bg-[var(--th-n-elev,#0f1219)] border border-emerald-500/25 rounded-2xl shadow-2xl shadow-black/60 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/5 bg-emerald-500/[0.06]">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-7 h-7 rounded-lg bg-emerald-500/15 border border-emerald-500/40 flex items-center justify-center flex-shrink-0">
              <Coins size={14} className="text-emerald-400" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-bold text-white leading-tight">Item Vendido</h3>
              <p className="text-[10px] text-slate-400 truncate">
                {itemName}{contextLabel ? ` — ${contextLabel}` : ""}
              </p>
            </div>
          </div>
          <button onClick={onCancel} className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-white/5 transition-colors cursor-pointer flex-shrink-0">
            <X size={15} />
          </button>
        </div>

        <div className="p-4 space-y-3 max-h-[calc(100dvh-8rem)] overflow-y-auto custom-scrollbar">
          {/* 122ª — VALORES DO ITEM: quadro de REFERÊNCIA (separado dos
              campos da venda): Valor BASE global do item na Lista de Itens
              do servidor (vivo; Boss edita em campo próprio — usuário comum
              só visualiza) e Valor CONSIDERADO (snapshot histórico/
              personalizado recebido do chamador — NUNCA recalculado aqui).
              Com venda digitada, a última linha compara venda × considerado. */}
          {serverName && !!baseLookupName && (liveBaseKk !== null || consideredKk !== undefined || canEditBase) && (
            <div className="rounded-xl border border-sky-500/25 bg-sky-500/[0.04] px-3 py-2 space-y-1.5">
              <div className="flex items-center justify-between gap-2 min-h-6">
                <span
                  className="text-[9px] font-black uppercase tracking-wider text-sky-300 flex-shrink-0"
                  title={`Valor BASE global de "${baseLookupName}" cadastrado na Lista de Itens de ${serverName} (Painel Bazaar) — referência compartilhada por todo o aplicativo. Não é o valor desta venda.`}
                >
                  Valor Base — {serverName}
                </span>
                {canEditBase ? (
                  baseFeedback ? (
                    <span className={`text-right text-[9px] font-bold leading-snug ${baseFeedback.ok ? "text-emerald-300" : "text-red-300"}`}>{baseFeedback.message}</span>
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      <input
                        type="text"
                        inputMode="decimal"
                        value={baseValue}
                        onChange={e => setBaseDraft(sanitizeDecimalKkText(e.target.value))}
                        onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); confirmBaseUpdate(); } }}
                        placeholder="—"
                        aria-label={`Valor Base de ${baseLookupName} (kk)`}
                        title={liveBaseKk !== null
                          ? `Valor Base atual de "${baseLookupName}" em ${serverName}: ${formatKkValue(liveBaseKk, "kk", true)}. Edite e salve para atualizar a Lista de Itens SOMENTE deste servidor — campo separado do valor de venda; o Valor Considerado histórico e as vendas registradas não mudam.`
                          : `"${baseLookupName}" ainda não está na Lista de Itens de ${serverName} — informe um valor Base e salve para cadastrar (somente neste servidor).`}
                        className={`h-6 w-16 rounded-md border bg-black/40 px-1.5 text-right font-mono text-[10px] font-bold text-sky-200 outline-none transition-colors ${baseDirty ? "border-amber-500/60 focus:border-amber-400/80" : "border-sky-500/30 focus:border-sky-400/60"}`}
                      />
                      <span className="text-[9px] font-bold text-sky-400/70 select-none">kk</span>
                      <button
                        type="button"
                        disabled={!baseDirty || parseDecimalKkText(baseValue) === null}
                        onClick={confirmBaseUpdate}
                        title={baseDirty ? `Salvar ${baseValue}kk como Valor Base de "${baseLookupName}" na Lista de Itens de ${serverName} — os demais servidores não mudam.` : "Edite o valor para salvar na Lista de Itens."}
                        className="w-6 h-6 inline-flex items-center justify-center rounded-md border border-sky-500/40 bg-sky-500/10 text-sky-300 hover:bg-sky-500/20 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <Check size={11} strokeWidth={3} />
                      </button>
                    </span>
                  )
                ) : (
                  <span
                    className="font-mono text-[11px] font-black tabular-nums text-sky-200"
                    title={liveBaseKk !== null
                      ? `Valor Base global de "${baseLookupName}" em ${serverName} (Lista de Itens do Painel Bazaar). Somente usuários Boss podem alterá-lo.`
                      : `"${baseLookupName}" não está na Lista de Itens de ${serverName}.`}
                  >
                    {liveBaseKk !== null ? formatKkValue(liveBaseKk, "kk", true) : "—"}
                  </span>
                )}
              </div>
              {consideredKk !== undefined && (
                <div className="flex items-center justify-between gap-2">
                  <span
                    className="text-[9px] font-black uppercase tracking-wider text-amber-300 flex-shrink-0"
                    title="Valor CONSIDERADO do item: referência histórica/personalizada registrada para ESTE item (snapshot do momento da compra do personagem, quando existe). Alterações no Valor Base ou na cotação NÃO mudam este valor."
                  >
                    Valor Considerado
                  </span>
                  <span className="inline-flex items-center gap-1">
                    {consideredIsFallback && shownConsideredKk !== null && (
                      <span
                        className="rounded border border-white/15 bg-white/5 px-1 py-px text-[7px] font-black uppercase tracking-wide text-slate-400"
                        title="Esta compra não tem Valor Considerado registrado — exibindo o valor BASE atual do servidor apenas como referência (fallback). Nenhum valor histórico foi inventado."
                      >
                        base atual
                      </span>
                    )}
                    <span
                      className="font-mono text-[11px] font-black tabular-nums text-amber-200"
                      title={shownConsideredKk !== null
                        ? (consideredIsFallback
                          ? "Fallback: valor Base atual do servidor (compra sem snapshot registrado)."
                          : "Snapshot registrado para este item — preservado mesmo que o Valor Base mude depois.")
                        : "Sem Valor Considerado conhecido para este item (nenhum valor é inventado)."}
                    >
                      {shownConsideredKk !== null ? formatKkValue(shownConsideredKk, "kk", true) : "—"}
                    </span>
                  </span>
                </div>
              )}
              {shownConsideredKk !== null && !noValue && vendaKk > 0 && (
                <div className="flex items-center justify-between gap-2 border-t border-sky-500/15 pt-1 text-[9px]">
                  <span className="text-slate-400" title="Diferença entre o valor que você está registrando na venda e o Valor Considerado do item (referência da compra).">Venda × Considerado</span>
                  <span className={`font-mono font-black tabular-nums ${vendaKk >= shownConsideredKk ? "text-emerald-300" : "text-red-300"}`}>
                    {vendaKk >= shownConsideredKk ? "+" : "−"}{formatKkValue(Math.abs(Math.round((vendaKk - shownConsideredKk) * 100) / 100), "kk", true)}
                    {" "}({vendaKk >= shownConsideredKk ? "+" : "−"}{(Math.abs((vendaKk - shownConsideredKk) / shownConsideredKk) * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%)
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Valor vendido + Cotação RC */}
          <div className="grid grid-cols-2 gap-2.5">
            <label className="block">
              <span className="text-[10px] font-bold uppercase tracking-wider text-sky-300">Valor vendido</span>
              <div className="relative mt-1">
                <input
                  type="text"
                  inputMode="decimal"
                  value={vendaRaw}
                  onChange={e => setVendaRaw(sanitizeRateKkInput(e.target.value))}
                  placeholder="0"
                  autoFocus
                  disabled={noValue}
                  className={`${inputCls} pr-8 border-sky-500/40 focus:border-sky-400/70 text-sky-200 disabled:opacity-40 disabled:cursor-not-allowed`}
                />
                <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] font-bold text-sky-400/70 select-none pointer-events-none">kk</span>
              </div>
            </label>
            <label className="block">
              <span className="text-[10px] font-bold uppercase tracking-wider text-red-300">RC no Market</span>
              <div className="relative mt-1">
                <input
                  type="text"
                  inputMode="decimal"
                  value={rateRaw}
                  onChange={e => setRateRaw(sanitizeRateKkInput(e.target.value))}
                  placeholder="0"
                  title="Cotação: quantos k equivalem a 1000 RC"
                  disabled={noValue}
                  className={`${inputCls} pr-7 border-red-500/40 focus:border-red-400/70 text-red-200 disabled:opacity-40 disabled:cursor-not-allowed`}
                />
                <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] font-bold text-red-400/70 select-none pointer-events-none">k</span>
              </div>
            </label>
          </div>

          {/* 113ª — ATUALIZAR RC OFICIAL DO SERVIDOR (SÓ Boss): aparece
              quando o valor digitado difere da cotação oficial vigente do
              servidor do item. Confirmar grava pelo MESMO mecanismo do
              quadro "RC Servidores" (appSettings/global.serverCoinRates +
              histórico + espelho/evento); a venda em si continua usando o
              valor do campo, e vendas já registradas não mudam. */}
          {canUpdateOfficialRate && (officialRateDiffers || rateFeedback) && (
            <div className="rounded-xl border border-red-500/25 bg-red-500/[0.05] px-3 py-2">
              {rateFeedback ? (
                <span className={`block text-[10px] font-bold leading-snug ${rateFeedback.ok ? "text-emerald-300" : "text-red-300"}`}>
                  {rateFeedback.message}
                </span>
              ) : (
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 flex-1 text-[9px] leading-snug text-red-200/80">
                    <span className="font-bold text-red-200">RC de {String(server || "").trim()}</span>: cadastrado{" "}
                    <span className="font-bold tabular-nums">{officialRate > 0 ? `${formatRateKkDisplay(officialRate)}k` : "—"}</span>
                    {" "}→ informado <span className="font-bold tabular-nums text-red-100">{formatRateKkDisplay(rateKk)}k</span>
                  </span>
                  <button
                    type="button"
                    disabled={rateSaving}
                    onClick={() => { void confirmOfficialRateUpdate(); }}
                    title={`Atualiza a cotação OFICIAL do RC exclusivamente para ${String(server || "").trim()} — mesma gravação do quadro "RC Servidores" do Painel Bazaar (compartilhada com todos os usuários). Vendas já registradas não são alteradas.`}
                    className="inline-flex h-6 items-center gap-1 flex-shrink-0 rounded-lg border border-red-500/40 bg-red-500/15 px-2 text-[9px] font-black text-red-200 hover:bg-red-500/25 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {rateSaving ? <RefreshCw size={10} className="animate-spin" /> : <Globe size={10} />}
                    Atualizar servidor
                  </button>
                </div>
              )}
            </div>
          )}

          {/* "Não informar valor" — confirma a venda SEM preço: o item é
              encerrado (sai de "À Venda") com os campos financeiros zerados
              e fica FORA de qualquer métrica. Desmarcada = fluxo atual. */}
          {allowNoValue && (
          <label className={`flex items-start gap-2 rounded-xl border px-3 py-2 cursor-pointer transition-colors ${noValue ? "border-violet-500/50 bg-violet-500/10" : "border-white/10 bg-white/[0.03] hover:bg-white/[0.06]"}`}>
            <input
              type="checkbox"
              checked={noValue}
              onChange={e => setNoValue(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 accent-violet-500 cursor-pointer"
            />
            <span className="flex-1">
              <span className={`block text-[11px] font-bold ${noValue ? "text-violet-300" : "text-slate-300"}`}>Não informar valor</span>
              <span className="block text-[9px] leading-snug text-slate-500">
                Confirma a venda sem preço: o item deixa de aparecer como "À Venda" e não entra em nenhum cálculo financeiro.
              </span>
            </span>
          </label>
          )}

          {/* Taxas do Market — regra vigente: criação (1%/1kk por oferta) +
              venda concluída (3%/5kk, uma vez). */}
          <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.05] p-2.5 space-y-1.5">
            {/* Ofertas criadas: stepper − N + */}
            <div className="flex items-center gap-2">
              <span className="flex-1 inline-flex items-center gap-1.5 text-xs font-bold text-amber-300">
                <Percent size={12} /> Ofertas criadas
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={noValue || !readyForTax || offerCount === 0}
                  onClick={() => setOfferCount(c => Math.max(0, c - 1))}
                  title="Uma oferta criada a menos"
                  className="w-6 h-6 inline-flex items-center justify-center rounded-lg border border-amber-500/40 bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <Minus size={11} strokeWidth={3} />
                </button>
                <span className="w-8 text-center px-1 py-0.5 rounded bg-amber-500 text-black text-[11px] font-black font-mono tabular-nums select-none">{offerCount}</span>
                <button
                  type="button"
                  disabled={noValue || !readyForTax}
                  onClick={() => setOfferCount(c => c + 1)}
                  title={readyForTax
                    ? `Cada oferta criada no Market paga ${OFFER_TAX_PERCENT}% do valor anunciado (máx. ${OFFER_TAX_CAP_KK}kk por oferta), mesmo sem venda. 0 = venda direta para oferta de compra.`
                    : "Preencha o valor vendido e o RC no Market para habilitar"}
                  className="w-6 h-6 inline-flex items-center justify-center rounded-lg border border-amber-500/40 bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Plus size={11} strokeWidth={3} />
                </button>
                <button
                  type="button"
                  disabled={noValue || offerCount === 0}
                  onClick={() => setOfferCount(0)}
                  title="Zerar ofertas criadas (venda direta)"
                  className="p-1.5 rounded-lg border border-white/10 bg-white/5 text-slate-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed flex-shrink-0"
                >
                  <RotateCcw size={12} />
                </button>
              </div>
            </div>
            {/* Detalhamento das DUAS taxas — sempre visível quando há valor. */}
            <div className="space-y-0.5 text-[9px] leading-snug tabular-nums">
              <div className="flex items-center justify-between gap-2 text-amber-200/70">
                <span>
                  Criação: {offerCount}× {OFFER_TAX_PERCENT}%{offerCapped ? ` (teto ${OFFER_TAX_CAP_KK}kk/oferta)` : ""}
                  {offerCount > 0 && vendaKk > 0 ? ` — ${formatKkValue(preview.offerPerKk, "kk")}/oferta` : ""}
                </span>
                <span className="font-bold text-amber-200">−{formatKkValue(preview.offerTotalKk, "kk")}</span>
              </div>
              <div className="flex items-center justify-between gap-2 text-amber-200/70">
                <span>Venda concluída: {SALE_TAX_PERCENT}% (1×){saleCapped ? ` (teto ${SALE_TAX_CAP_KK}kk)` : ""}</span>
                <span className="font-bold text-amber-200">−{formatKkValue(preview.saleTaxKk, "kk")}</span>
              </div>
              <div className="flex items-center justify-between gap-2 border-t border-amber-500/20 pt-0.5 text-amber-300">
                <span className="font-bold">Taxa total</span>
                <span className="font-black">−{formatKkValue(preview.taxKk, "kk")}</span>
              </div>
            </div>
          </div>

          {/* Resultado */}
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/[0.07] px-3 py-2.5">
            <div className="flex items-center justify-between text-[10px] text-slate-400">
              <span>Valor líquido (venda − taxas)</span>
              <span className="tabular-nums font-bold text-slate-200">{formatKkValue(preview.netKk, "kk")}</span>
            </div>
            <div className="flex items-center justify-between mt-1">
              <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-400">Resultado em RC</span>
              <span className={`text-lg font-black tabular-nums ${preview.resultRC > 0 ? "text-emerald-300" : "text-emerald-400/40"}`}>
                {preview.resultRC > 0 ? formatRC(preview.resultRC) : "0"}
              </span>
            </div>
          </div>

          {/* Ações */}
          <div className="flex items-center gap-2 pt-0.5">
            <button
              type="button"
              onClick={onCancel}
              className="flex-1 py-1.5 rounded-lg border border-white/10 bg-white/5 text-slate-300 text-xs font-bold hover:bg-white/10 transition-colors cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="button"
              disabled={!noValue && (!readyForTax || preview.resultRC <= 0)}
              onClick={handleSave}
              className="flex-1 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-black text-xs font-black inline-flex items-center justify-center gap-1 transition-colors cursor-pointer shadow-lg shadow-emerald-500/10 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Check size={13} /> Salvar venda
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
