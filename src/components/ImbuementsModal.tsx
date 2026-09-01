import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Sparkles, X } from "lucide-react";
import {
  IMBUEMENTS,
  IMBUEMENT_CATEGORIES,
  type ImbuementAccent,
  type ImbuementCategoryId,
} from "../constants/imbuements";

// ============================================================================
// GUIA DE IMBUEMENTS
//
// Consulta rápida dos materiais necessários para levar cada Imbuement até o
// Powerful. É um guia somente-leitura: não toca em Firestore, não altera dados
// e não conversa com nenhum outro fluxo do aplicativo.
//
// Decisões que importam:
//   • PORTAL em document.body — o painel do app vive dentro de um container
//     com CSS `zoom`, que quebra o hit-testing de `position: fixed`. Mesmo
//     motivo já documentado em ConfirmModal, ServiceValueModal e CharTable.
//   • Esc e clique no fundo fecham.
//   • Cabeçalho e categorias ficam FORA da área rolável, então continuam
//     acessíveis enquanto a lista rola.
//   • REDIMENSIONAMENTO: o modal usa `max-h-[90vh]` + `overflow-y-auto` e é
//     portado para `document.body` (fora dos containers com `zoom` do app),
//     portanto NÃO comprime fontes nem cards para caber na tela — o conteúdo
//     rola verticalmente. Legibilidade tem prioridade sobre "encaixar tudo".
//   • As cores vêm de `ACCENT_HUE` e são aplicadas via `color-mix(in oklab)`
//     sobre os tokens do tema. Assim cada função tem identidade própria (fogo
//     quente, gelo frio, morte roxa...) sem quebrar nos 7 temas.
// ============================================================================

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * Cor base de cada token semântico. São as únicas cores literais do arquivo:
 * funcionam como a "paleta de elementos" do guia, do mesmo modo que
 * `VOC_COLORS` faz para as vocações. Tudo o mais deriva daqui por color-mix.
 */
const ACCENT_HUE: Record<ImbuementAccent, string> = {
  fire: "#ff6b35",       // 🔥 tons quentes
  ice: "#4fc3f7",        // ❄️ tons frios
  energy: "#ffd54f",     // ⚡ destaque elétrico
  death: "#a855f7",      // 💀 roxo
  earth: "#6abf4b",      // 🌿 verde
  holy: "#ffd700",       // ✨ dourado
  life: "#ef4444",       // ❤️ vermelho
  mana: "#3b82f6",       // 💧 azul
  physical: "#f97316",   // ⚔️ força física
  magic: "#c084fc",      // 🔮 mágico
  distance: "#34d399",   // 🏹 destaque próprio
  shield: "#94a3b8",     // 🛡️ defensivo
  speed: "#22d3ee",      // 💨 ágil
};

/** Conjunto de estilos derivados de um token de cor. */
function accentStyles(accent: ImbuementAccent) {
  const hue = ACCENT_HUE[accent];
  return {
    hue,
    text: `color-mix(in oklab, ${hue} 78%, white)`,
    textSoft: `color-mix(in oklab, ${hue} 48%, white)`,
    border: `color-mix(in oklab, ${hue} 45%, transparent)`,
    borderStrong: `color-mix(in oklab, ${hue} 80%, transparent)`,
    glow: `color-mix(in oklab, ${hue} 32%, transparent)`,
    glowStrong: `color-mix(in oklab, ${hue} 55%, transparent)`,
    fill: `color-mix(in oklab, ${hue} 13%, transparent)`,
    fillStrong: `color-mix(in oklab, ${hue} 22%, transparent)`,
  };
}

export default function ImbuementsModal({ open, onClose }: Props) {
  const [category, setCategory] = useState<ImbuementCategoryId>("skill");

  useEffect(() => {
    if (!open) return;
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  const visible = useMemo(
    () => IMBUEMENTS.filter(imbuement => imbuement.category === category),
    [category],
  );

  if (!open) return null;

  return createPortal(
    <div
      className="app-modal-overlay fixed inset-0 z-[1100] flex items-center justify-center bg-black/85 backdrop-blur-sm"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Guia de Imbuements"
        className="app-modal-frame app-modal-size-wide app-modal-frame--scroll relative w-full max-w-5xl rounded-2xl border border-[var(--th-line)]/100 bg-[var(--th-bg-base)] shadow-2xl shadow-black/70"
      >
        {/* ── Cabeçalho (fixo) ─────────────────────────────────────────── */}
        <div className="flex flex-shrink-0 items-start justify-between gap-3 border-b border-[var(--th-line)]/70 bg-gradient-to-r from-[var(--th-bg-raised)] via-[var(--th-bg-base)] to-[var(--th-bg-raised)] px-5 py-4">
          <div className="min-w-0">
            <h2
              className="flex items-center gap-2.5 text-xl font-black tracking-wide text-amber-200"
              style={{ textShadow: "0 0 16px color-mix(in oklab, var(--th-brand) 50%, transparent)" }}
            >
              <Sparkles size={20} className="flex-shrink-0 text-amber-300" />
              ✨ Guia de Imbuements
            </h2>
            <p className="mt-1 text-[12px] leading-snug text-slate-400">
              Materiais necessários para completar cada Imbuement até o Powerful.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="Fechar (Esc)"
            aria-label="Fechar o guia de Imbuements"
            className="flex-shrink-0 cursor-pointer rounded-md p-1.5 text-slate-500 transition-colors hover:bg-white/[0.08] hover:text-slate-200"
          >
            <X size={18} />
          </button>
        </div>

        {/* ── Categorias (fixas) ───────────────────────────────────────── */}
        <div className="flex flex-shrink-0 flex-wrap gap-2 border-b border-[var(--th-line)]/60 bg-[var(--th-n-base)] px-5 py-3">
          {IMBUEMENT_CATEGORIES.map(item => {
            const active = item.id === category;
            const s = accentStyles(item.accent);
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setCategory(item.id)}
                aria-pressed={active}
                className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-[12px] font-black tracking-wide transition-all duration-200 cursor-pointer ${
                  active ? "scale-[1.03]" : "opacity-60 hover:opacity-100"
                }`}
                style={active ? {
                  color: s.text,
                  backgroundColor: s.fillStrong,
                  borderColor: s.borderStrong,
                  boxShadow: `0 0 18px ${s.glowStrong}, inset 0 0 14px ${s.fill}`,
                } : {
                  color: s.textSoft,
                  backgroundColor: "transparent",
                  borderColor: s.border,
                }}
              >
                <span className="text-[15px] leading-none">{item.emoji}</span>
                <span className="whitespace-nowrap">{item.label}</span>
              </button>
            );
          })}
        </div>

        {/* ── Lista rolável ────────────────────────────────────────────── */}
        <div className="app-modal-body imbue-scroll px-4 sm:px-5 py-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {visible.map(imbuement => {
              const s = accentStyles(imbuement.accent);
              return (
                <div
                  key={imbuement.id}
                  className="group flex flex-col gap-2.5 rounded-xl border p-3.5 transition-all duration-300 ease-out hover:scale-[1.03] hover:z-10 hover:shadow-[0_0_18px_var(--card-glow)]"
                  style={{
                    ["--card-glow" as any]: s.glowStrong,
                    backgroundColor: "color-mix(in oklab, var(--th-n-base) 92%, transparent)",
                    borderColor: s.border,
                    boxShadow: `0 0 12px ${s.glow}`,
                  }}
                >
                  {/* Cabeçalho do card: emoji + nome + descrição */}
                  <div className="flex items-center gap-3">
                    <span
                      className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl text-[22px] leading-none"
                      style={{
                        backgroundColor: s.fill,
                        border: `1.5px solid ${s.borderStrong}`,
                        boxShadow: `inset 0 0 12px ${s.glow}, 0 0 10px ${s.glow}`,
                      }}
                      aria-hidden="true"
                    >{imbuement.emoji}</span>
                    <div className="min-w-0">
                      <div
                        className="truncate text-[15px] font-black tracking-wide"
                        style={{ color: s.text, textShadow: `0 0 12px ${s.glow}` }}
                      >{imbuement.name}</div>
                      <div className="truncate text-[11px] font-semibold text-slate-400">
                        {imbuement.description}
                      </div>
                    </div>
                  </div>

                  {/* Materiais: um por linha, com quantidade em destaque */}
                  <div
                    className="flex flex-col gap-1.5 rounded-lg px-2.5 py-2"
                    style={{ backgroundColor: "color-mix(in oklab, var(--th-bg-base) 72%, transparent)" }}
                  >
                    {imbuement.materials.map(material => (
                      <div key={material.item} className="flex items-center gap-2.5">
                        {/* Quantidade — destaque forte */}
                        <span
                          className="inline-flex h-6 min-w-[3.2rem] flex-shrink-0 items-center justify-center rounded-md border px-1.5 text-[13px] font-black tabular-nums"
                          style={{
                            color: s.text,
                            borderColor: s.borderStrong,
                            backgroundColor: s.fillStrong,
                            textShadow: `0 0 10px ${s.glow}`,
                            boxShadow: `inset 0 0 8px ${s.glow}`,
                          }}
                        >{material.qty}×</span>
                        {/* Nome do item — legível e destacado */}
                        <span
                          className="min-w-0 flex-1 truncate text-[13px] font-bold text-slate-100"
                          title={material.item}
                        >{material.item}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Rodapé ───────────────────────────────────────────────────── */}
        <div className="app-modal-footer flex flex-wrap items-center justify-between gap-2 border-t border-[var(--th-line)]/70 bg-[var(--th-bg-raised)] px-4 sm:px-5 py-2.5">
          <span className="text-[11px] font-semibold text-slate-500">
            {visible.length} Imbuement{visible.length === 1 ? "" : "s"} · quantidades para o nível Powerful
          </span>
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-lg border border-[var(--th-line)]/100 px-3.5 py-1.5 text-[12px] font-bold text-slate-300 transition-colors hover:bg-[var(--th-line)]/20 hover:text-white"
          >
            Fechar
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}