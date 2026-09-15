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
// ============================================================================

import { Globe, Package, X } from "lucide-react";
import type { Character } from "../types";
import { computeItemRC, formatKkValue as formatKkValueBase } from "../utils/itemSale";

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
  /** Cotação do coin (k) — a mesma persistida pela guia Bazaar → Itens. */
  coinRate: number;
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

export default function CharacterBazaarItemsModal({ character, coinRate, onClose }: Props) {
  const snapshot = character?.bazaarItems;
  if (!character || !snapshot) return null;

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
              </tr>
            </thead>
            <tbody>
              {snapshot.matches.map((match, index) => (
                <tr key={`${match.foundName}-${index}`} className="border-b border-[var(--th-line)]/25">
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
                </tr>
              ))}
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
              <span className="text-slate-500">Informe o valor do coin na guia Bazaar → Itens para ver a conversão em RC.</span>
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
