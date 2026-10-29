import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AlignLeft, Check, FileText, RotateCcw, X } from "lucide-react";
import {
  DEFAULT_SALE_TEXT_CONFIG,
  buildSaleAnnouncement,
  sanitizeSaleTextConfig,
  type SaleTextConfig,
  type SaleTextHighlight,
  type SaleTextItemInput,
  type SaleTextLayout,
} from "../utils/saleAnnouncement";

// ============================================================================
// CONFIGURAR TEXTO DE VENDA (75ª) — modal "Itens à Venda" de Meus Personagens
// ----------------------------------------------------------------------------
// Personaliza o anúncio gerado pelo botão "Gerar Texto de Venda" de cada
// servidor: Introdução (texto livre), opções dos Itens à venda e
// Encerramento (texto livre). A PRÉVIA usa o núcleo REAL de geração
// (buildSaleAnnouncement) com itens reais do usuário quando existem —
// o que se vê é exatamente o que será copiado. "Salvar" devolve a config ao
// modal pai, que a persiste POR USUÁRIO (localStorage) — nada vai ao
// Firestore. Emojis, caracteres especiais e quebras de linha são aceitos
// nos campos livres (textarea nativa) e preservados no texto final.
// ============================================================================

interface Props {
  /** Config atual (persistida) — ponto de partida da edição. */
  initial: SaleTextConfig;
  /** Itens REAIS para a prévia (ex.: do 1º servidor com itens à venda). */
  sampleItems: SaleTextItemInput[];
  /** Rótulo da amostra exibida na prévia (ex.: nome do servidor). */
  sampleLabel: string;
  /** Persiste a config (o pai grava via saveSaleTextConfig) e fecha. */
  onSave: (config: SaleTextConfig) => void;
  onClose: () => void;
}

/** Itens FICTÍCIOS para a prévia quando o usuário ainda não tem itens. */
const FALLBACK_SAMPLE_ITEMS: SaleTextItemInput[] = [
  { name: "Falcon Coif", valueKk: 25, amount: 1 },
  { name: "Spiritthorn Helmet [Tier 2]", valueKk: 40.5, amount: 1 },
  { name: "Gold Token", valueKk: 1.5, amount: 3 },
];

export default function SaleTextConfigModal({ initial, sampleItems, sampleLabel, onSave, onClose }: Props) {
  const [draft, setDraft] = useState<SaleTextConfig>(() => sanitizeSaleTextConfig(initial));
  const patch = (changes: Partial<SaleTextConfig>) => setDraft(prev => ({ ...prev, ...changes }));

  // Esc fecha SEM salvar (o modal pai ignora o próprio Esc enquanto este
  // estiver aberto — nada fecha em cascata).
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Prévia AO VIVO — mesmo núcleo real usado na cópia (nenhum gerador paralelo).
  const previewItems = sampleItems.length > 0 ? sampleItems : FALLBACK_SAMPLE_ITEMS;
  const preview = useMemo(() => buildSaleAnnouncement(draft, previewItems), [draft, previewItems]);

  const inputCls = "w-full bg-black/40 border border-white/10 rounded-lg px-2.5 py-1.5 text-[11px] text-slate-200 outline-none transition-colors focus:border-amber-500/50 placeholder-slate-600";
  const labelCls = "text-[9px] font-black uppercase tracking-wider text-slate-500";

  return createPortal(
    <div
      className="fixed inset-0 z-[560] flex items-center justify-center bg-black/80 backdrop-blur-sm p-2 sm:p-4"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-2xl rounded-2xl border border-amber-500/40 bg-gradient-to-b from-[#141017] to-[#0b0a10] shadow-[0_0_60px_rgba(245,158,11,0.08)] shadow-black/70 flex flex-col max-h-[90vh] sm:max-h-[86vh] overflow-hidden">
        {/* Cabeçalho — mesma identidade âmbar do "Itens à Venda" */}
        <div className="relative px-4 py-3.5 border-b border-amber-500/20 bg-gradient-to-r from-amber-500/[0.12] via-amber-500/[0.05] to-transparent flex-shrink-0 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="w-9 h-9 rounded-xl bg-amber-500/15 border border-amber-500/40 flex items-center justify-center flex-shrink-0">
              <FileText size={17} className="text-amber-300" />
            </span>
            <div className="min-w-0">
              <h3 className="text-[15px] font-black text-amber-200 leading-tight tracking-tight truncate">Configurar Texto de Venda</h3>
              <p className="text-[10px] text-slate-400 leading-snug truncate">
                Personalize o anúncio copiado pelo botão "Gerar Texto de Venda" de cada servidor
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white p-1.5 rounded-lg hover:bg-white/5 transition-colors cursor-pointer flex-shrink-0" title="Fechar sem salvar">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3">
          {/* ── 1) INTRODUÇÃO — texto livre (emojis/quebras preservados) ── */}
          <section className="rounded-xl border border-white/10 bg-white/[0.02] p-3 space-y-1.5">
            <h4 className="text-[10px] font-black uppercase tracking-wider text-amber-300">Introdução</h4>
            <textarea
              value={draft.intro}
              onChange={e => patch({ intro: e.target.value })}
              rows={3}
              placeholder="Texto de abertura do anúncio (aceita emojis, caracteres especiais e quebras de linha)…"
              aria-label="Texto de introdução do anúncio"
              className={`${inputCls} resize-y leading-snug`}
            />
          </section>

          {/* ── 2) ITENS À VENDA — organização e formatação ─────────────── */}
          <section className="rounded-xl border border-white/10 bg-white/[0.02] p-3 space-y-2">
            <h4 className="text-[10px] font-black uppercase tracking-wider text-amber-300">Itens à venda</h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <label className="space-y-1">
                <span className={labelCls}>Organização</span>
                <select
                  value={draft.layout}
                  onChange={e => patch({ layout: e.target.value as SaleTextLayout })}
                  aria-label="Organização dos itens"
                  className={`${inputCls} cursor-pointer [color-scheme:dark]`}
                >
                  <option value="lines">Um abaixo do outro (uma linha por item)</option>
                  <option value="inline">Lado a lado (separados por delimitador)</option>
                </select>
              </label>
              <label className="space-y-1">
                <span className={labelCls}>Separador entre itens (lado a lado)</span>
                <input
                  type="text"
                  value={draft.separator}
                  onChange={e => patch({ separator: e.target.value })}
                  disabled={draft.layout !== "inline"}
                  placeholder="ex.: | , • , ·"
                  aria-label="Separador entre os itens no modo lado a lado"
                  title={draft.layout === "inline" ? "Caracteres colocados ENTRE os itens (espaços contam)" : "Disponível na organização lado a lado"}
                  className={`${inputCls} font-mono ${draft.layout !== "inline" ? "opacity-40 cursor-not-allowed" : ""}`}
                />
              </label>
              <label className="space-y-1">
                <span className={labelCls}>Destaque do nome</span>
                <select
                  value={draft.highlight}
                  onChange={e => patch({ highlight: e.target.value as SaleTextHighlight })}
                  aria-label="Destaque aplicado ao nome do item"
                  title="O destaque é gerado em CARACTERES compatíveis com o destino — a formatação visual depende do aplicativo onde o texto for colado."
                  className={`${inputCls} cursor-pointer [color-scheme:dark]`}
                >
                  <option value="none">Sem destaque</option>
                  <option value="asterisks">Negrito WhatsApp — *item*</option>
                  <option value="double-asterisks">Negrito Discord/Telegram — **item**</option>
                  <option value="caps">MAIÚSCULAS (vale em qualquer destino)</option>
                </select>
              </label>
              <label className="space-y-1">
                <span className={labelCls}>Linhas em branco entre as seções</span>
                <select
                  value={String(draft.sectionBlankLines)}
                  onChange={e => patch({ sectionBlankLines: Number(e.target.value) })}
                  aria-label="Linhas em branco entre Introdução, itens e Encerramento"
                  className={`${inputCls} cursor-pointer [color-scheme:dark]`}
                >
                  <option value="0">Nenhuma (seções coladas)</option>
                  <option value="1">1 linha em branco</option>
                  <option value="2">2 linhas em branco</option>
                  <option value="3">3 linhas em branco</option>
                </select>
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 pt-0.5">
              <label className="inline-flex items-center gap-1.5 cursor-pointer text-[10px] text-slate-300" title="Inclui o valor considerado (kk) de cada item, quando conhecido — itens sem valor saem só com o nome.">
                <input type="checkbox" checked={draft.includeValue} onChange={e => patch({ includeValue: e.target.checked })} className="accent-amber-500" />
                Incluir valor (kk)
              </label>
              <label className="inline-flex items-center gap-1.5 cursor-pointer text-[10px] text-slate-300" title="Inclui a quantidade (xN) quando o item tem mais de uma unidade.">
                <input type="checkbox" checked={draft.includeAmount} onChange={e => patch({ includeAmount: e.target.checked })} className="accent-amber-500" />
                Incluir quantidade (xN)
              </label>
              <label className={`inline-flex items-center gap-1.5 text-[10px] text-slate-300 ${draft.layout === "lines" ? "cursor-pointer" : "opacity-40 cursor-not-allowed"}`} title={draft.layout === "lines" ? "Deixa uma linha em branco entre um item e o seguinte." : "Disponível na organização um abaixo do outro"}>
                <input type="checkbox" checked={draft.blankLineBetweenItems} disabled={draft.layout !== "lines"} onChange={e => patch({ blankLineBetweenItems: e.target.checked })} className="accent-amber-500" />
                Linha em branco entre itens
              </label>
            </div>
          </section>

          {/* ── 3) ENCERRAMENTO — texto livre (emojis/quebras preservados) ─ */}
          <section className="rounded-xl border border-white/10 bg-white/[0.02] p-3 space-y-1.5">
            <h4 className="text-[10px] font-black uppercase tracking-wider text-amber-300">Encerramento</h4>
            <textarea
              value={draft.outro}
              onChange={e => patch({ outro: e.target.value })}
              rows={3}
              placeholder="Texto de fechamento do anúncio (aceita emojis, caracteres especiais e quebras de linha)…"
              aria-label="Texto de encerramento do anúncio"
              className={`${inputCls} resize-y leading-snug`}
            />
          </section>

          {/* ── PRÉVIA — gerada pelo MESMO núcleo usado na cópia ──────────── */}
          <section className="rounded-xl border border-amber-500/25 bg-amber-500/[0.04] p-3 space-y-1.5">
            <h4 className="text-[10px] font-black uppercase tracking-wider text-amber-300 flex items-center gap-1.5">
              <AlignLeft size={11} /> Prévia
              <span className="text-slate-500 normal-case font-semibold tracking-normal">
                — {sampleItems.length > 0 ? `itens reais de ${sampleLabel}` : "exemplo (você ainda não tem itens à venda)"}
              </span>
            </h4>
            <pre className="whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-slate-200 bg-black/40 border border-white/10 rounded-lg px-2.5 py-2 max-h-48 overflow-y-auto" aria-label="Prévia do texto gerado">
              {preview || "— (anúncio vazio) —"}
            </pre>
          </section>
        </div>

        {/* Rodapé */}
        <div className="px-4 py-2.5 border-t border-white/5 bg-black/30 flex items-center justify-between gap-2 flex-shrink-0 flex-wrap">
          <button
            type="button"
            onClick={() => setDraft({ ...DEFAULT_SALE_TEXT_CONFIG })}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-white/10 bg-white/[0.03] text-slate-300 hover:text-amber-300 hover:border-amber-500/40 text-[10px] font-bold transition-colors cursor-pointer"
            title="Volta todos os campos para os valores padrão (nada é salvo até clicar em Salvar)"
          >
            <RotateCcw size={11} /> Restaurar padrão
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg border border-white/10 bg-white/[0.03] text-slate-300 hover:text-white text-[10px] font-bold transition-colors cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={() => onSave(sanitizeSaleTextConfig(draft))}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-gradient-to-r from-amber-700/80 to-amber-600/80 hover:from-amber-600 hover:to-amber-500 border border-amber-500/40 text-black text-[10px] font-black transition-all cursor-pointer"
              title="Salva a configuração para o seu usuário (fica disponível após recarregar/reabrir o aplicativo)"
            >
              <Check size={11} strokeWidth={3} /> Salvar
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
