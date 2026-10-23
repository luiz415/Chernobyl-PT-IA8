// ============================================================================
// ITENS DO BAZAAR DO PERSONAGEM — Meus Personagens → Disponíveis → Itens → Ver
// ----------------------------------------------------------------------------
// EXCLUSIVO DO BOSS (o App só monta a coluna/modal para role === "Boss").
// Exibe o SNAPSHOT dos itens importados na compra do personagem pela guia
// Bazaar → Itens (`Character.bazaarItems`) — os MESMOS dados da consulta de
// origem, sem nenhuma nova consulta ao Bazaar nem leitura do Firestore.
//
// VISUAL: espelho do modal "Detalhes" da guia Itens (mesmo cabeçalho, mesmas
// colunas, mesmo rodapé de totais), na versão SOMENTE LEITURA: o snapshot é
// um registro histórico da compra — editar preços aqui não faria sentido
// (as Listas de Itens por servidor continuam sendo editadas na guia Itens).
// Mesmos utilitários de cálculo (formatKkValue/computeItemRC) — nenhuma
// fórmula paralela.
//
// ÚNICA exceção de escrita (58ª tarefa): a coluna "À venda" — um controle
// discreto por item que o marca/desmarca para o modal "Itens à Venda" de
// Meus Personagens. A marcação grava `forSale`/`forSaleAt` no PRÓPRIO match
// do snapshot, pelo MESMO canal de persistência do personagem
// (onCharacterInlineChange do App); desmarcar NUNCA apaga o registro
// original do item nem a venda já registrada. Itens da compra não têm
// associação com SW/SG/GB.
// ============================================================================

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, Coins, Globe, Package, RefreshCw, X } from "lucide-react";
import type { Character } from "../types";
import { SERVER_OPTIONS } from "../constants/servers";
import { SERVER_COIN_RATES_EVENT, coinRateText, getServerCoinRate, readLocalCoinRates, saveOfficialServerCoinRate } from "../utils/bazaarCoinRates";
import { applyOfficialWatchedItemUpdate, parseTieredItemName } from "../utils/bazaarWatchedItems";
import { computeItemRC, formatKkValue as formatKkValueBase, isItemSaleConcluded } from "../utils/itemSale";

/**
 * Formatação de kk da modal de itens do personagem: valores têm até 1 casa decimal,
 * exibidos SEM zeros à direita ("1,5kk", nunca "1,50kk"; inteiros "210kk").
 * Mesma função base do restante do app (trimZeros opt-in — nada muda fora
 * do modo itens).
 */
function formatKkValue(value: number, suffix: "k" | "kk" = "kk"): string {
  return formatKkValueBase(value, suffix, true);
}

interface Props {
  character: Character | null;
  /**
   * Marca/desmarca um item do snapshot como "À venda" (58ª tarefa) — o App
   * persiste pelo MESMO canal do CharTable (handleCharacterInlineChange).
   * Ausente = coluna exibida sem ação (somente leitura).
   */
  onToggleForSale?: (matchIndex: number, forSale: boolean) => void;
  /**
   * Coluna "Atualizar" (66ª tarefa — EXCLUSIVA DO BOSS): o App passa
   * `role === "Boss"`. Dupla garantia: além de o modal só ser montado para o
   * Boss, a coluna e o handler só existem com esta prop ativa — para os
   * demais usuários o modal permanece EXATAMENTE como era.
   */
  canUpdateOfficialList?: boolean;
  onClose: () => void;
}

/** "dd/MM/aaaa às HH:mm" local — momento em que o snapshot foi capturado. */
function formatCapturedAt(ms: number): string {
  try {
    const date = new Date(ms);
    const day = String(date.getDate()).padStart(2, "0");
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const year = date.getFullYear();
    const hour = String(date.getHours()).padStart(2, "0");
    const minute = String(date.getMinutes()).padStart(2, "0");
    return `${day}/${month}/${year} às ${hour}:${minute}`;
  } catch {
    return "—";
  }
}

export default function CharacterBazaarItemsModal({ character, onToggleForSale, canUpdateOfficialList, onClose }: Props) {
  const snapshot = character?.bazaarItems;

  // ── COTAÇÃO DO RC EM TEMPO REAL (70ª tarefa) ───────────────────────────────
  // A cotação do servidor é lida do ESPELHO LOCAL da fonte oficial
  // (appSettings/global.serverCoinRates — a mesma da guia Itens/"RC
  // Servidores"), por render, exatamente como o App fazia ao montar o modal
  // (nenhuma fonte nova). O contador força re-render quando QUALQUER tela
  // grava uma cotação (SERVER_COIN_RATES_EVENT) ou quando o onSnapshot do
  // App realimenta o espelho com mudanças de outros dispositivos — o rodapé
  // de conversão reflete na hora, sem recarregamento e sem nenhuma leitura
  // nova ao Firestore.
  const [coinRatesVersion, setCoinRatesVersion] = useState(0);
  useEffect(() => {
    const bump = () => setCoinRatesVersion(v => v + 1);
    window.addEventListener(SERVER_COIN_RATES_EVENT, bump);
    return () => window.removeEventListener(SERVER_COIN_RATES_EVENT, bump);
  }, []);
  const coinRate = useMemo(
    () => getServerCoinRate(readLocalCoinRates(), snapshot?.server),
    [snapshot, coinRatesVersion] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // ── RC DO SERVIDOR — EDIÇÃO GLOBAL (70ª — EXCLUSIVA DO BOSS) ──────────────
  // Mesmo recurso do modal "Ver" do Painel Bazaar (69ª), pelo MESMO fluxo
  // único saveOfficialServerCoinRate (validação oficial, "Já atualizado"
  // sem gravar, altera SÓ o servidor deste personagem na fonte oficial).
  // Além de o modal só ser montado para o Boss, o campo/botão exigem
  // canUpdateOfficialList e o backend (Rules) revalida o cargo na gravação
  // — demais usuários não veem nem executam. Busy evita cliques
  // concorrentes; feedback de sucesso/erro no padrão da 69ª.
  const [rateInput, setRateInput] = useState("");
  const [rateSaving, setRateSaving] = useState(false);
  const [rateFeedback, setRateFeedback] = useState<{ ok: boolean; message: string } | null>(null);
  const rateTimerRef = useRef<number | null>(null);
  useEffect(() => () => { if (rateTimerRef.current !== null) window.clearTimeout(rateTimerRef.current); }, []);
  // Troca de personagem: campo re-semeado com a cotação vigente do servidor
  // dele ("" quando não configurada) e feedback pendente descartado.
  useEffect(() => {
    setRateInput(coinRateText(getServerCoinRate(readLocalCoinRates(), character?.bazaarItems?.server)));
    setRateFeedback(null);
  }, [character]);
  async function saveOfficialRate() {
    const server = String(character?.bazaarItems?.server || "").trim();
    // Dupla checagem de autorização (além da montagem Boss-only do App).
    if (!canUpdateOfficialList || rateSaving) return;
    setRateSaving(true);
    try {
      const result = await saveOfficialServerCoinRate(server, rateInput);
      setRateFeedback({ ok: result.ok, message: result.message });
      if (rateTimerRef.current !== null) window.clearTimeout(rateTimerRef.current);
      rateTimerRef.current = window.setTimeout(() => { setRateFeedback(null); rateTimerRef.current = null; }, result.ok ? 2500 : result.saved ? 5000 : 4000);
    } catch (error) {
      // saveOfficialServerCoinRate não lança; proteção extra — nada além do
      // espelho local pode ter mudado (demais servidores intactos).
      setRateFeedback({ ok: false, message: String((error as Error)?.message || "Falha ao salvar a cotação.") });
      if (rateTimerRef.current !== null) window.clearTimeout(rateTimerRef.current);
      rateTimerRef.current = window.setTimeout(() => { setRateFeedback(null); rateTimerRef.current = null; }, 5000);
    } finally {
      setRateSaving(false);
    }
  }

  // ── COLUNA "ATUALIZAR" (66ª tarefa — EXCLUSIVA DO BOSS) ────────────────────
  // Confirmação inline por linha/escopo (1º clique NUNCA executa), bloqueio
  // durante a operação e feedback de sucesso/erro — mesmo padrão do
  // "Atualizar" do modal Detalhes da guia Itens. A gravação usa o núcleo
  // único applyOfficialWatchedItemUpdate (Lista de Itens oficial da guia
  // Personagens com Itens + reprecificação da última consulta — nenhuma
  // fonte paralela). Hooks declarados ANTES de qualquer retorno condicional.
  const [updateConfirm, setUpdateConfirm] = useState<{ index: number; scope: "all" | "server" } | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateDone, setUpdateDone] = useState<{ index: number; ok: boolean; message: string } | null>(null);
  const updateTimerRef = useRef<number | null>(null);
  useEffect(() => () => { if (updateTimerRef.current !== null) window.clearTimeout(updateTimerRef.current); }, []);
  // Troca de personagem: descarta confirmação/feedback pendentes.
  useEffect(() => { setUpdateConfirm(null); setUpdateDone(null); }, [character]);

  if (!character || !snapshot) return null;

  function confirmOfficialUpdate() {
    const pending = updateConfirm;
    const snap = character?.bazaarItems;
    // Dupla checagem de autorização (além da montagem Boss-only do App).
    if (!pending || !snap || !canUpdateOfficialList || updateBusy) return;
    const match = snap.matches[pending.index];
    if (!match) { setUpdateConfirm(null); return; }
    setUpdateBusy(true);
    try {
      const result = applyOfficialWatchedItemUpdate({
        scope: pending.scope,
        server: snap.server || "",
        itemName: match.watchedName || parseTieredItemName(match.foundName).baseName,
        valueKk: Number(match.baseValueKk || 0),
        serverUniverse: SERVER_OPTIONS,
      });
      const touched = result.changedServers.length + result.addedServers.length;
      const message = !result.ok
        ? (result.error || "Falha ao atualizar a Lista de Itens.")
        : touched === 0
          ? "Já atualizado"
          : pending.scope === "all"
            ? `${touched} servidor(es)`
            : `${snap.server} atualizado`;
      setUpdateDone({ index: pending.index, ok: result.ok, message });
    } catch (error) {
      setUpdateDone({ index: pending.index, ok: false, message: String((error as Error)?.message || "Falha ao atualizar a Lista de Itens.") });
    } finally {
      setUpdateBusy(false);
      setUpdateConfirm(null);
      if (updateTimerRef.current !== null) window.clearTimeout(updateTimerRef.current);
      updateTimerRef.current = window.setTimeout(() => { setUpdateDone(null); updateTimerRef.current = null; }, 2500);
    }
  }

  // Valor EFETIVO: correção manual da consulta (quando havia) tem prioridade
  // sobre o calculado — mesma regra da tabela da guia Itens.
  const isManual = typeof snapshot.manualTotalKk === "number" && snapshot.manualTotalKk > 0;
  const effectiveKk = isManual ? (snapshot.manualTotalKk as number) : snapshot.totalKk;

  return (
    <div
      className="app-modal-overlay fixed inset-0 z-[1200] flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="app-modal-frame w-full max-w-xl max-h-[88vh] flex flex-col rounded-xl border border-fuchsia-500/30 bg-[var(--th-bg-raised)] shadow-2xl shadow-black/60 overflow-hidden">
        <div className="flex-shrink-0 flex items-center justify-between gap-2 px-4 py-3 border-b border-[var(--th-line)]/40">
          <div className="flex items-center gap-2 min-w-0">
            <Package size={16} className="text-fuchsia-400 flex-shrink-0" />
            <span className="text-sm font-bold text-fuchsia-300 truncate">{character.personagem || "Personagem"}</span>
            {snapshot.server && (
              <span className="inline-flex items-center gap-1 rounded border border-fuchsia-500/30 bg-fuchsia-500/10 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wide text-fuchsia-300 flex-shrink-0" title="Os valores desta tabela vieram da Lista de Itens deste servidor no momento da consulta">
                <Globe size={9} /> {snapshot.server}
              </span>
            )}
            <span className="inline-flex items-center rounded border border-white/15 bg-white/5 px-1.5 py-0.5 text-[9px] font-bold text-slate-400 flex-shrink-0" title="Snapshot capturado na compra — mesmos dados da consulta de origem, sem nova consulta ao Bazaar">
              Importado em {formatCapturedAt(snapshot.capturedAtMs)}
            </span>
          </div>
          <button type="button" onClick={onClose} className="p-1 rounded text-slate-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer flex-shrink-0" title="Fechar">
            <X size={15} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-auto custom-scrollbar px-4 py-3 space-y-2">
          <table className="w-full text-[10px]">
            <thead>
              <tr className="text-[8px] uppercase tracking-wider text-slate-400 border-b border-[var(--th-line)]/40">
                <th className="px-1.5 py-1.5 text-left">Item encontrado</th>
                <th className="px-1.5 py-1.5 text-left">Item da lista</th>
                <th className="px-1.5 py-1.5 text-right">Base (kk)</th>
                <th className="px-1.5 py-1.5 text-center">Tier</th>
                <th className="px-1.5 py-1.5 text-right">Pós-Tier (kk)</th>
                <th className="px-1.5 py-1.5 text-center">Qtd</th>
                <th className="px-1.5 py-1.5 text-right">Total (kk)</th>
                {/* À VENDA (58ª): controle discreto por item — vai para o
                    modal "Itens à Venda" de Meus Personagens, SEM Quest. */}
                <th className="px-1.5 py-1.5 text-center">À venda</th>
                {/* ATUALIZAR (66ª — EXCLUSIVO DO BOSS): grava o valor BASE
                    do item na Lista de Itens oficial (guia Personagens com
                    Itens) — todos os servidores ou só o do personagem. Para
                    os demais usuários o modal permanece inalterado. */}
                {canUpdateOfficialList && <th className="px-1.5 py-1.5 text-center">Atualizar</th>}
              </tr>
            </thead>
            <tbody>
              {snapshot.matches.length === 0 && (
                <tr>
                  {/* Personagem comprado só com Ouro relevante (> 1kk): sem
                      itens monitorados — o total vem exclusivamente do Ouro,
                      detalhado logo abaixo ("Inclui Ouro"). */}
                  <td colSpan={canUpdateOfficialList ? 9 : 8} className="px-1.5 py-2.5 text-center italic text-slate-500">
                    Nenhum item monitorado encontrado — o valor deste personagem vem apenas do Ouro.
                  </td>
                </tr>
              )}
              {snapshot.matches.map((match, index) => {
                // Coluna "Atualizar" (Boss): o snapshot da compra SEMPRE traz
                // watchedName/baseValueKk (copiados da consulta de origem) —
                // é esse valor BASE oficial que será gravado na Lista.
                const rowBaseKk = Number(match.baseValueKk || 0);
                const rowCanUpdate = rowBaseKk >= 0.1;
                const rowItemLabel = match.watchedName || parseTieredItemName(match.foundName).baseName;
                const rowConfirm = updateConfirm?.index === index ? updateConfirm : null;
                const rowDone = updateDone?.index === index ? updateDone : null;
                return (
                <Fragment key={`${match.foundName}-${index}`}>
                <tr className={`border-b border-[var(--th-line)]/25 ${rowConfirm ? "!border-b-0 bg-amber-500/5" : ""}`}>
                  <td className="px-1.5 py-1.5 text-left font-bold text-slate-100">{match.foundName}</td>
                  <td className="px-1.5 py-1.5 text-slate-300">{match.watchedName}</td>
                  <td className="px-1.5 py-1.5 text-right font-mono text-slate-200">{formatKkValue(match.baseValueKk, "kk")}</td>
                  <td className="px-1.5 py-1.5 text-center font-mono">
                    {match.tier > 0
                      ? <span className="text-fuchsia-300 font-bold" title={`+${match.tier * 30}% sobre o valor base`}>{match.tier}</span>
                      : <span className="text-slate-600">—</span>}
                  </td>
                  <td className="px-1.5 py-1.5 text-right font-mono text-slate-200">{formatKkValue(match.unitValueKk, "kk")}</td>
                  <td className="px-1.5 py-1.5 text-center font-mono text-slate-200">{match.amount}</td>
                  <td className="px-1.5 py-1.5 text-right font-mono font-bold text-amber-200">{formatKkValue(match.totalKk, "kk")}</td>
                  <td className="px-1.5 py-1.5 text-center">
                    <div className="inline-flex flex-col items-center gap-0.5">
                      <button
                        type="button"
                        onClick={() => onToggleForSale?.(index, !match.forSale)}
                        disabled={!onToggleForSale}
                        aria-pressed={!!match.forSale}
                        title={match.forSale
                          ? "Item marcado À VENDA — aparece em “Itens à Venda” de Meus Personagens (sem Quest associada). Clique para retirar da venda; o registro do item é preservado."
                          : "Colocar este item à venda — ele passa a aparecer em “Itens à Venda” de Meus Personagens (sem associação com SW/SG/GB)."}
                        className={`inline-flex items-center gap-0.5 rounded border px-1.5 py-0.5 text-[8px] font-black uppercase tracking-wide transition-colors ${
                          match.forSale
                            ? "border-amber-500/50 bg-amber-500/20 text-amber-300 hover:bg-amber-500/30"
                            : "border-white/10 bg-white/5 text-slate-400 hover:border-amber-500/35 hover:bg-amber-500/10 hover:text-amber-300"
                        } ${onToggleForSale ? "cursor-pointer" : "cursor-default opacity-60"}`}
                      >
                        <Coins size={8} /> {match.forSale ? "À venda" : "Vender"}
                      </button>
                      {isItemSaleConcluded(match.sale || null) && (
                        <span className="inline-flex items-center gap-0.5 text-[7px] font-black uppercase tracking-wide text-emerald-400/90" title="Venda registrada em “Itens à Venda” — o registro permanece mesmo se o item for desmarcado.">
                          <Check size={7} strokeWidth={3} /> Vendido
                        </span>
                      )}
                    </div>
                  </td>
                  {/* ATUALIZAR (66ª — Boss): 1º clique só abre a confirmação;
                      durante a operação os botões ficam bloqueados; o
                      feedback substitui os botões por 2,5s. */}
                  {canUpdateOfficialList && (
                    <td className="px-1.5 py-1.5 text-center">
                      {rowDone ? (
                        <span className={`inline-flex items-center gap-1 text-[8px] font-black uppercase tracking-wide ${rowDone.ok ? "text-emerald-300" : "text-rose-300"}`} title={rowDone.message}>
                          {rowDone.ok ? <Check size={10} className="flex-shrink-0" /> : <AlertTriangle size={10} className="flex-shrink-0" />}
                          <span className="max-w-[90px] truncate">{rowDone.message}</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center justify-center gap-1">
                          <button
                            type="button"
                            disabled={!rowCanUpdate || updateBusy}
                            onClick={() => setUpdateConfirm(prev => (prev?.index === index && prev.scope === "all" ? null : { index, scope: "all" }))}
                            className={`rounded border px-1 py-0.5 inline-flex items-center gap-0.5 text-[8px] font-black uppercase tracking-wide transition-colors cursor-pointer ${rowConfirm?.scope === "all" ? "border-amber-500/60 bg-amber-500/20 text-amber-200" : "border-amber-500/35 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20"} disabled:opacity-40 disabled:cursor-not-allowed`}
                            title={rowCanUpdate ? `Atualizar em todos os servidores: gravar ${formatKkValue(rowBaseKk, "kk")} como valor base de "${rowItemLabel}" na Lista de Itens (guia Personagens com Itens) de TODOS os servidores.` : "Valor base indisponível para este item — nada a atualizar."}
                          >
                            <Globe size={9} className="flex-shrink-0" /> Todos
                          </button>
                          <button
                            type="button"
                            disabled={!rowCanUpdate || updateBusy}
                            onClick={() => setUpdateConfirm(prev => (prev?.index === index && prev.scope === "server" ? null : { index, scope: "server" }))}
                            className={`rounded border px-1 py-0.5 inline-flex items-center gap-0.5 text-[8px] font-black uppercase tracking-wide transition-colors cursor-pointer ${rowConfirm?.scope === "server" ? "border-amber-500/60 bg-amber-500/20 text-amber-200" : "border-amber-500/35 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20"} disabled:opacity-40 disabled:cursor-not-allowed`}
                            title={rowCanUpdate ? `Atualizar neste servidor: gravar ${formatKkValue(rowBaseKk, "kk")} como valor base de "${rowItemLabel}" SOMENTE na lista de ${snapshot.server || "—"} — os demais servidores não são alterados.` : "Valor base indisponível para este item — nada a atualizar."}
                          >
                            <RefreshCw size={9} className="flex-shrink-0" /> Servidor
                          </button>
                        </span>
                      )}
                    </td>
                  )}
                </tr>
                {/* Confirmação inline (mesmo padrão do "Atualizar" do modal
                    Detalhes da guia Itens): 1º clique NUNCA executa — só
                    esta linha confirma. */}
                {canUpdateOfficialList && rowConfirm && !rowDone && (
                  <tr className="border-b border-[var(--th-line)]/25 bg-amber-500/5">
                    <td colSpan={9} className="px-1.5 pb-1.5 pt-0">
                      <span className="inline-flex flex-wrap items-center gap-1.5 text-[9px] text-amber-200">
                        <AlertTriangle size={10} className="flex-shrink-0 text-amber-300" />
                        <span>
                          Gravar <span className="font-mono font-bold">{formatKkValue(rowBaseKk, "kk")}</span> como valor base de <span className="font-bold">“{rowItemLabel}”</span> {rowConfirm.scope === "all" ? "na Lista de Itens de TODOS os servidores" : <>SOMENTE na lista de <span className="font-bold">{snapshot.server || "—"}</span> (demais servidores intactos)</>}?
                        </span>
                        <button
                          type="button"
                          disabled={updateBusy}
                          onClick={confirmOfficialUpdate}
                          className="rounded border border-emerald-500/40 bg-emerald-500/15 px-1.5 py-0.5 inline-flex items-center gap-1 font-black uppercase tracking-wide text-emerald-300 hover:bg-emerald-500/25 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {updateBusy ? <RefreshCw size={9} className="animate-spin flex-shrink-0" /> : <Check size={9} className="flex-shrink-0" />} {updateBusy ? "Atualizando…" : "Confirmar"}
                        </button>
                        <button
                          type="button"
                          disabled={updateBusy}
                          onClick={() => setUpdateConfirm(null)}
                          className="rounded border border-slate-500/40 bg-slate-500/10 px-1.5 py-0.5 inline-flex items-center gap-1 font-black uppercase tracking-wide text-slate-300 hover:bg-slate-500/20 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          <X size={9} className="flex-shrink-0" /> Cancelar
                        </button>
                      </span>
                    </td>
                  </tr>
                )}
                </Fragment>
                );
              })}
            </tbody>
          </table>

          <div className="rounded-lg border border-fuchsia-500/25 bg-fuchsia-500/5 px-3 py-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
            <span className="text-slate-300">
              Total do personagem: <span className="font-mono font-bold text-amber-200">{formatKkValue(effectiveKk, "kk")}</span>
              {isManual && (
                <span className="ml-1 rounded border border-fuchsia-500/40 bg-fuchsia-500/15 px-1 py-px text-[7px] font-black uppercase tracking-wide text-fuchsia-300" title={`Correção manual feita na consulta (calculado: ${formatKkValue(snapshot.totalKk, "kk")})`}>
                  manual
                </span>
              )}
            </span>
            {(snapshot.goldKk || 0) > 0 && (
              <span className="text-slate-300" title="Ouro lido na página do leilão, convertido para kk (1.000.000 gold = 1kk) e já somado ao total calculado — uma única vez.">
                Inclui Ouro: <span className="font-mono font-bold text-yellow-300">{formatKkValue(snapshot.goldKk || 0, "kk")}</span>
              </span>
            )}
            {coinRate > 0 ? (
              <span className="text-slate-300" title={`floor((${effectiveKk} / ${coinRate}) × 1000) — mesma fórmula de conversão do restante do aplicativo`}>
                Em RC (coin a {String(coinRate).replace(".", ",")}k): <span className="font-mono font-bold text-emerald-300">{computeItemRC(coinRate, effectiveKk).toLocaleString("de-DE")} RC</span>
              </span>
            ) : (
              <span className="text-slate-500">Sem cotação do RC para {snapshot.server || "este servidor"} — defina na guia Bazaar → Itens (Lista de Itens) para ver a conversão.</span>
            )}
            {/* RC GLOBAL DO SERVIDOR (70ª — EXCLUSIVO DO BOSS): edita a
                cotação OFICIAL do servidor deste personagem
                (appSettings/global.serverCoinRates — a MESMA fonte do modal
                "RC Servidores"/Lista de Itens e do modal "Ver" do Painel
                Bazaar): todos os cálculos do app passam a usá-la, em tempo
                real. Para os demais usuários o rodapé permanece inalterado
                (o modal nem é montado para eles). */}
            {canUpdateOfficialList && !!snapshot.server && (
              <span className="inline-flex flex-wrap items-center gap-1.5">
                <label className="inline-flex items-center gap-1.5" title="Cotação do Rubini Coin no Market: quantos k equivalem a 1000 RC. Mesma regra de conversão usada no restante do aplicativo — floor(kk ÷ cotação × 1000).">
                  <span className="text-[8px] font-black uppercase tracking-wide text-amber-300">RC de {snapshot.server}:</span>
                  <input
                    value={rateInput}
                    onChange={event => setRateInput(event.target.value)}
                    placeholder="ex: 2,5"
                    inputMode="decimal"
                    className="w-14 rounded border border-[var(--th-line)]/60 bg-black/40 px-1.5 py-0.5 text-[10px] font-mono text-amber-200 outline-none focus:border-amber-500/50"
                  />
                  <span className="text-[9px] text-slate-500">k = 1000 RC</span>
                </label>
                {rateFeedback ? (
                  <span className={`inline-flex items-center gap-1 text-[8px] font-black uppercase tracking-wide ${rateFeedback.ok ? "text-emerald-300" : "text-rose-300"}`} title={rateFeedback.message}>
                    {rateFeedback.ok ? <Check size={10} className="flex-shrink-0" /> : <AlertTriangle size={10} className="flex-shrink-0" />}
                    <span className="max-w-[220px] truncate">{rateFeedback.message}</span>
                  </span>
                ) : (
                  <button
                    type="button"
                    disabled={rateSaving}
                    onClick={() => { void saveOfficialRate(); }}
                    className="rounded border px-1.5 py-0.5 inline-flex items-center gap-1 text-[8px] font-black uppercase tracking-wide transition-colors cursor-pointer border-amber-500/35 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 disabled:opacity-40 disabled:cursor-not-allowed"
                    title={`Salvar o valor digitado como a cotação OFICIAL de ${snapshot.server} (a mesma do modal "RC Servidores") — vale para TODO o aplicativo e todos os usuários, em tempo real. Somente a cotação deste servidor é alterada.`}
                  >
                    {rateSaving
                      ? <><RefreshCw size={9} className="animate-spin flex-shrink-0" /> Salvando…</>
                      : <><Globe size={9} className="flex-shrink-0" /> Salvar p/ {snapshot.server}</>}
                  </button>
                )}
              </span>
            )}
            <span className="text-[9px] text-slate-500 basis-full">
              Tier: valor base × (1 + 0,3 × Tier). Conversão RC: floor((total ÷ coin) × 1000). Dados importados da consulta de origem — nenhuma nova consulta.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
