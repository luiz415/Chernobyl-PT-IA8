import { Check, Palette } from "lucide-react";
import { useTheme } from "../theme/ThemeContext";
import type { ThemeDefinition } from "../theme/themes";

function Swatches({ theme }: { theme: ThemeDefinition }) {
  const { surface, line, brand, accent } = theme.swatches;
  return (
    <span
      className="inline-flex items-center rounded-md overflow-hidden border border-white/10 flex-shrink-0"
      aria-hidden="true"
    >
      {[surface, line, brand, accent].map((c, i) => (
        <span key={i} className="block w-4 h-6" style={{ background: c }} />
      ))}
    </span>
  );
}

/**
 * Seletor de tema. Aplica e persiste imediatamente ao clicar —
 * não existe botão "salvar" nem necessidade de reiniciar o app.
 */
export default function ThemeSelector() {
  const { theme, themes, setTheme } = useTheme();

  return (
    <div className="rounded-xl border border-red-900/10 bg-white/[0.01] overflow-hidden">
      <div className="px-3 py-2 bg-red-900/5 border-b border-red-900/5 flex items-center gap-1.5">
        <Palette size={11} className="text-red-200" />
        <span className="text-[11px] font-bold text-red-200 uppercase">Tema</span>
      </div>

      <div
        role="radiogroup"
        aria-label="Tema do aplicativo"
        className="p-2 space-y-1"
      >
        {themes.map((t) => {
          const selected = t.id === theme;
          return (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => setTheme(t.id)}
              title={t.description}
              className={`w-full flex items-center gap-2.5 p-2 rounded-lg border text-left transition-colors cursor-pointer ${
                selected
                  ? "border-amber-500/40 bg-amber-500/10"
                  : "border-white/[0.04] bg-white/[0.01] hover:bg-white/[0.04] hover:border-white/10"
              }`}
            >
              <Swatches theme={t} />
              <span className="min-w-0 flex-1">
                <span
                  className={`text-[12px] font-bold block truncate ${
                    selected ? "text-amber-200" : "text-slate-200"
                  }`}
                >
                  {t.label}
                </span>
                <span className="text-[10px] text-slate-500 leading-tight block truncate">
                  {t.description}
                </span>
              </span>
              <span
                className={`w-4 h-4 rounded-full border flex items-center justify-center flex-shrink-0 ${
                  selected
                    ? "border-amber-500/60 bg-amber-500/20 text-amber-300"
                    : "border-white/15 text-transparent"
                }`}
              >
                <Check size={10} strokeWidth={3} />
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
