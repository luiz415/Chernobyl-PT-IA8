import { useState, useEffect, useCallback, useRef } from "react";
import { ArrowRight, Check, Copy, Crown, HelpCircle, RotateCcw } from "lucide-react";
import ExternalWindow from "./ExternalWindow";
import { useAuth } from "../context/AuthContext";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Incrementa a cada clique em "Câmbio" — traz a janela existente à frente. */
  focusSignal?: number;
}

interface RefData {
  rc: string;
  kk: string;
  rs: string;
}

interface ConvData {
  rc: string;
  kk: string;
  rs: string;
}

const STORAGE_KEY = "tibia_calc_regra3";

function loadCalcData(): { ref: RefData; conv: ConvData } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      return {
        ref: { rc: d.ref?.rc ?? "1000", kk: d.ref?.kk ?? "", rs: d.ref?.rs ?? "" },
        conv: { rc: d.conv?.rc ?? "", kk: d.conv?.kk ?? "", rs: d.conv?.rs ?? "" },
      };
    }
  } catch {}
  return {
    ref: { rc: "1000", kk: "", rs: "" },
    conv: { rc: "", kk: "", rs: "" },
  };
}

function saveCalcData(ref: RefData, conv: ConvData) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ref, conv }));
  } catch {}
}

function parseNum(s: string): number {
  if (!s) return 0;
  const cleaned = s.replace(/,/g, ".");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function parsePtBR(s: string): number {
  if (!s) return 0;
  // Remove separadores de milhares (pontos) e converte a vírgula decimal para ponto
  const cleaned = s.replace(/\./g, "").replace(",", ".");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function fmtDec(n: number, decimals: number): string {
  return n.toLocaleString("pt-BR", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function removeTrailingZeros(s: string): string {
  if (!s.includes(",")) return s;
  return s.replace(/0+$/, "").replace(/,$/, "");
}

function fmtKK(n: number): string {
  if (n >= 1000) {
    const kkk = n / 1000;
    const formatted = kkk.toLocaleString("pt-BR", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
    return `${removeTrailingZeros(formatted)} KKK`;
  }
  const formatted = n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${removeTrailingZeros(formatted)} KK`;
}

function sanitizeNumeric(v: string): string {
  let s = v.replace(/[^0-9.,]/g, "").replace(",", ".");
  const parts = s.split(".");
  if (parts.length > 2) s = parts[0] + "." + parts.slice(1).join("");
  if (parts.length === 2 && parts[1].length > 2) s = parts[0] + "." + parts[1].slice(0, 2);
  return s;
}

export default function CurrencyCalculator({ open, onClose, focusSignal }: Props) {
  const { userProfile } = useAuth();
  const isNormalUser = userProfile?.role === "Normal";

  return (
    <ExternalWindow
      open={open}
      onClose={onClose}
      focusSignal={focusSignal}
      title={isNormalUser ? "Conteúdo Exclusivo" : "Conversor RC/KK/R$"}
      width={450}
      height={525}
    >
      {isNormalUser ? <VipOnlyScreen /> : <CalculatorContent />}
    </ExternalWindow>
  );
}

function VipOnlyScreen() {
  return (
    <div
      style={{
        minHeight: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--th-n-base)",
        fontFamily: "system-ui, -apple-system, sans-serif",
        padding: 40,
        gap: 28,
      }}
    >
      {/* Crown decoration */}
      <div
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            position: "absolute",
            width: 120,
            height: 120,
            borderRadius: "50%",
            background:
              "radial-gradient(circle, color-mix(in oklab, var(--color-amber-500) 20%, transparent) 0%, transparent 70%)",
            animation: "vipPulse 2.5s ease-in-out infinite",
          }}
        />
        <div
          style={{
            width: 72,
            height: 72,
            borderRadius: "50%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background:
              "linear-gradient(135deg, color-mix(in oklab, var(--color-amber-500) 25%, transparent), color-mix(in oklab, var(--color-amber-500) 15%, transparent))",
            border: "2px solid color-mix(in oklab, var(--color-amber-500) 40%, transparent)",
            boxShadow:
              "0 0 30px color-mix(in oklab, var(--color-amber-500) 25%, transparent), inset 0 0 20px color-mix(in oklab, var(--color-amber-500) 10%, transparent)",
          }}
        >
          <Crown
            size={36}
            style={{
              color: "#fbbf24",
              filter:
                "drop-shadow(0 0 8px color-mix(in oklab, var(--color-amber-500) 80%, transparent)) drop-shadow(0 0 16px color-mix(in oklab, var(--color-amber-500) 40%, transparent))",
            }}
          />
        </div>
      </div>

      {/* Title */}
      <div
        style={{
          textAlign: "center",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div
          style={{
            fontSize: 20,
            fontWeight: 800,
            letterSpacing: "0.02em",
            background:
              "linear-gradient(135deg, #fbbf24, #f59e0b, #d97706)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            backgroundClip: "text",
          }}
        >
          Conteúdo Exclusivo
        </div>
        <div
          style={{
            fontSize: 12,
            color: "#a1a1aa",
            lineHeight: 1.6,
          }}
        >
          Este conteúdo está disponível apenas para
        </div>
      </div>

      {/* VIP Badge */}
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 24px",
          borderRadius: 12,
          background:
            "linear-gradient(135deg, color-mix(in oklab, var(--color-amber-500) 25%, transparent) 0%, color-mix(in oklab, var(--color-amber-500) 18%, transparent) 50%, color-mix(in oklab, var(--color-amber-500) 22%, transparent) 100%)",
          border: "1px solid color-mix(in oklab, var(--color-amber-500) 50%, transparent)",
          boxShadow:
            "0 0 20px color-mix(in oklab, var(--color-amber-500) 30%, transparent), inset 0 0 12px color-mix(in oklab, var(--color-amber-500) 10%, transparent)",
        }}
      >
        <div style={{ position: "relative" }}>
          <Crown
            size={22}
            className="relative z-10"
            style={{
              color: "#fbbf24",
              filter:
                "drop-shadow(0 0 6px color-mix(in oklab, var(--color-amber-500) 90%, transparent)) drop-shadow(0 0 12px color-mix(in oklab, var(--color-amber-500) 50%, transparent))",
            }}
          />
          <div
            style={{
              position: "absolute",
              inset: -4,
              borderRadius: "50%",
              background:
                "radial-gradient(circle, color-mix(in oklab, var(--color-amber-500) 30%, transparent) 0%, transparent 70%)",
              animation: "vipPulse 2.5s ease-in-out infinite",
            }}
          />
        </div>
        <span
          style={{
            fontSize: 14,
            fontWeight: 800,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            background:
              "linear-gradient(90deg, #fbbf24, #f59e0b, #fbbf24)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            backgroundClip: "text",
            filter: "drop-shadow(0 0 4px color-mix(in oklab, var(--color-amber-500) 40%, transparent))",
          }}
        >
          MEMBRO VIP
        </span>
      </div>

      {/* Bottom text */}
      <div
        style={{
          textAlign: "center",
          fontSize: 11,
          color: "#52525b",
          lineHeight: 1.6,
          maxWidth: 340,
        }}
      >
        Se você possui interesse em se tornar um membro VIP e ter acesso a todos os recursos exclusivos, entre em contato com o suporte.
      </div>

      {/* Shimmer animation */}
      <style>{`
        @keyframes vipPulse {
          0%, 100% { opacity: 0.6; transform: scale(1); }
          50% { opacity: 1; transform: scale(1.1); }
        }
      `}</style>
    </div>
  );
}

function CalculatorContent() {
  const [ref, setRef] = useState<RefData>({ rc: "1000", kk: "", rs: "" });
  const [conv, setConv] = useState<ConvData>({ rc: "", kk: "", rs: "" });
  const [error, setError] = useState("");
  const [lastCalc, setLastCalc] = useState<"rc" | "kk" | "rs" | null>(null);
  const [copiedField, setCopiedField] = useState<"rc" | "kk" | "rs" | null>(null);
  const [helpOpen, setHelpOpen] = useState<"tabela" | "conversor" | null>(null);

  useEffect(() => {
    const data = loadCalcData();
    setRef(data.ref);
    setConv(data.conv);
  }, []);

  // Fechar tooltip ao clicar fora dos botões "?"
  useEffect(() => {
    if (!helpOpen) return;
    function handleDocumentClick(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-help-button]") && !target.closest("[data-help-tooltip]")) {
        setHelpOpen(null);
      }
    }
    document.addEventListener("mousedown", handleDocumentClick);
    return () => document.removeEventListener("mousedown", handleDocumentClick);
  }, [helpOpen]);

  const persist = useCallback((r: RefData, c: ConvData) => {
    saveCalcData(r, c);
  }, []);

  function updateRef(field: keyof RefData, value: string) {
    const next = { ...ref, [field]: value };
    setRef(next);
    persist(next, conv);
  }

  function updateConv(field: keyof ConvData, value: string) {
    const next = { ...conv, [field]: value };
    setConv(next);
    persist(ref, next);
  }

  function validateRef(): { rc: number; kk: number; rs: number } | null {
    const rc = parseNum(ref.rc);
    const kk = parseNum(ref.kk);
    const rs = parseNum(ref.rs);
    if (rc <= 0 || kk <= 0 || rs <= 0) {
      setError("Preencha os 3 campos da Tabela com valores maiores que zero.");
      return null;
    }
    setError("");
    return { rc, kk, rs };
  }

  function calcViaRC() {
    const r = validateRef();
    if (!r) return;
    const inputRC = parseNum(conv.rc);
    const novoKK = (inputRC * r.kk) / r.rc;
    const novoRS = (inputRC * r.rs) / r.rc;
    const next = { ...conv, kk: fmtDec(novoKK, 2), rs: fmtDec(novoRS, 2) };
    setConv(next);
    setLastCalc("rc");
    setCopiedField(null);
    persist(ref, next);
  }

  function calcViaKK() {
    const r = validateRef();
    if (!r) return;
    const inputKK = parseNum(conv.kk);
    const novoRC = (inputKK * r.rc) / r.kk;
    const novoRS = (inputKK * r.rs) / r.kk;
    const next = { ...conv, rc: fmtDec(novoRC, 0), rs: fmtDec(novoRS, 2) };
    setConv(next);
    setLastCalc("kk");
    setCopiedField(null);
    persist(ref, next);
  }

  function calcViaRS() {
    const r = validateRef();
    if (!r) return;
    const inputRS = parseNum(conv.rs);
    const novoRC = (inputRS * r.rc) / r.rs;
    const novoKK = (inputRS * r.kk) / r.rs;
    const next = { ...conv, rc: fmtDec(novoRC, 0), kk: fmtDec(novoKK, 2) };
    setConv(next);
    setLastCalc("rs");
    setCopiedField(null);
    persist(ref, next);
  }

  function resetRef() {
    const nextRef = { rc: "1000", kk: "", rs: "" };
    setRef(nextRef);
    setError("");
    persist(nextRef, conv);
  }

  function resetConv() {
    const next = { rc: "", kk: "", rs: "" };
    setConv(next);
    setLastCalc(null);
    setCopiedField(null);
    persist(ref, next);
  }

  function getClipboardText(field: "rc" | "kk" | "rs"): string {
    const value = conv[field];
    if (!value) return "";
    if (field === "rc") return `${value} RC`;
    if (field === "kk") return fmtKK(parsePtBR(value));
    return `R$ ${value}`;
  }

  function handleCopyResult(field: "rc" | "kk" | "rs", sourceDoc?: Document) {
    const text = getClipboardText(field);
    if (!text) return;

    function markCopied() {
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 2000);
    }

    function copyViaTextarea(targetDoc: Document): boolean {
      const ta = targetDoc.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.top = "0";
      ta.style.left = "0";
      ta.style.opacity = "0";
      ta.style.pointerEvents = "none";
      targetDoc.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, text.length);
      let copied = false;
      try {
        copied = targetDoc.execCommand("copy");
      } catch {}
      targetDoc.body.removeChild(ta);
      return copied;
    }

    const targetDoc = sourceDoc || document;
    const targetNavigator = targetDoc.defaultView?.navigator || navigator;

    if (copyViaTextarea(targetDoc)) {
      markCopied();
      return;
    }

    if (targetNavigator.clipboard && targetNavigator.clipboard.writeText) {
      targetNavigator.clipboard.writeText(text).then(markCopied).catch(() => {});
    }
  }

  return (
    <div
      style={{
        minHeight: "100%",
        display: "flex",
        flexDirection: "column",
        background: "var(--th-n-base)",
        fontFamily: "system-ui, -apple-system, sans-serif",
        border: "1px solid color-mix(in oklab, var(--color-red-600) 55%, transparent)",
        boxShadow:
          "0 0 14px color-mix(in oklab, var(--color-red-600) 35%, transparent), inset 0 0 10px color-mix(in oklab, var(--color-red-600) 6%, transparent)",
        boxSizing: "border-box",
      }}
    >
      {/* Título */}
      <div
        style={{
          width: "100%",
          flexShrink: 0,
        }}
      >
        <div
          style={{
            padding: "16px 24px 12px",
            borderBottom: "1px solid rgba(255,255,255,0.05)",
            background:
              "linear-gradient(135deg, rgba(30,20,28,0.95), rgba(20,12,18,0.95)) padding-box, linear-gradient(90deg, color-mix(in oklab, var(--color-amber-500) 40%, transparent), rgba(56,189,248,0.4), rgba(52,211,153,0.4)) border-box",
            textAlign: "center",
            boxShadow:
              "0 0 20px rgba(56,189,248,0.08), 0 4px 12px rgba(0,0,0,0.4), inset 0 0 40px rgba(0,0,0,0.35)",
            position: "relative",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              position: "absolute",
              inset: 0,
              background:
                "radial-gradient(circle at 20% 50%, color-mix(in oklab, var(--color-amber-500) 18%, transparent), transparent 50%), radial-gradient(circle at 80% 50%, rgba(52,211,153,0.18), transparent 50%), radial-gradient(circle at 50% 50%, rgba(56,189,248,0.12), transparent 60%)",
              pointerEvents: "none",
            }}
          />
          <div style={{ position: "relative", zIndex: 1 }}>
          <div
            style={{
              fontSize: 19,
              fontWeight: 700,
              letterSpacing: "0.02em",
              color: "#fafafa",
              marginBottom: 6,
              textShadow: "0 0 12px rgba(255,255,255,0.15)",
            }}
          >
            Conversor
          </div>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              fontSize: 14,
              fontWeight: 600,
            }}
          >
            <span style={{ color: "#fbbf24", textShadow: "0 0 8px color-mix(in oklab, var(--color-amber-500) 50%, transparent)" }}>RC</span>
            <ArrowRight size={12} color="#a1a1aa" strokeWidth={2.5} />
            <span style={{ color: "#38bdf8", textShadow: "0 0 8px rgba(56,189,248,0.5)" }}>KK</span>
            <ArrowRight size={12} color="#a1a1aa" strokeWidth={2.5} />
            <span style={{ color: "#34d399", textShadow: "0 0 8px rgba(52,211,153,0.5)" }}>R$</span>
          </div>
          </div>
        </div>
      </div>

      <div style={{ minHeight: 14, flexShrink: 0 }} />

      <div style={{ padding: "0 24px 18px", display: "flex", flexDirection: "column", gap: 14, flex: 1 }}>
        {/* Erro */}
        {error && (
          <div
            style={{
              padding: "10px 14px",
              borderRadius: 10,
              background: "color-mix(in oklab, var(--color-red-600) 8%, transparent)",
              border: "1px solid color-mix(in oklab, var(--color-red-600) 20%, transparent)",
              color: "#fda4af",
              fontSize: 12,
            }}
          >
            {error}
          </div>
        )}

        {/* TABELA */}
        <Card
          title="Tabela"
          onReset={resetRef}
          helpId="tabela"
          helpOpen={helpOpen}
          setHelpOpen={setHelpOpen}
          helpContent={
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#e4e4e7", marginBottom: 2 }}>
                Como usar a Tabela
              </div>
              <div>
                <span style={{ color: "#fbbf24", fontWeight: 700 }}>RC</span>{" "}
                — Preencha com o valor base (geralmente{" "}
                <span style={{ color: "#fbbf24" }}>1000</span>).
              </div>
              <div>
                <span style={{ color: "#38bdf8", fontWeight: 700 }}>KK</span>{" "}
                — Preencha com o valor atual do Rubini Coin no seu servidor. Ex: No market o valor do Rubini Coin (Piece Price) está 70k, então preencha com{" "}
                <span style={{ color: "#38bdf8" }}>"70"</span>.
              </div>
              <div>
                <span style={{ color: "#34d399", fontWeight: 700 }}>R$</span>{" "}
                — Preencha com o valor que você compra/vende Rubini Coins com base no valor que você preencheu no campo "RC". Ex: Se você preencheu 1000 RC, você deve preencher em R$ o valor que você compra/vende os{" "}
                <span style={{ color: "#34d399" }}>1000 RC</span>.
              </div>
            </div>
          }
        >
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
            <RefInput label="RC" value={ref.rc} onChange={(v) => updateRef("rc", v)} color="#fbbf24" />
            <RefInput label="KK" value={ref.kk} onChange={(v) => updateRef("kk", v)} color="#38bdf8" />
            <RefInput label="R$" value={ref.rs} onChange={(v) => updateRef("rs", v)} color="#34d399" />
          </div>
        </Card>

        {/* CONVERSOR */}
        <Card
          title="Conversor"
          onReset={resetConv}
          helpId="conversor"
          helpOpen={helpOpen}
          setHelpOpen={setHelpOpen}
          helpContent={
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#e4e4e7", marginBottom: 2 }}>
                Como usar o Conversor
              </div>
              <div>
                Apenas preencha o valor que você quer converter.
              </div>
              <div>
                Cada botão <span style={{ fontWeight: 700, color: "#38bdf8" }}>Calcular</span> usa o valor preenchido como referência.
              </div>
              <div>
                <strong>Exemplo:</strong> Quero saber quanto vale <span style={{ color: "#38bdf8", fontWeight: 700 }}>70 KK</span> em reais (<span style={{ color: "#34d399", fontWeight: 700 }}>R$</span>), apenas preencha o campo <span style={{ color: "#38bdf8", fontWeight: 700 }}>"KK"</span> com <span style={{ color: "#38bdf8" }}>70</span> e clique em <span style={{ color: "#38bdf8", fontWeight: 700 }}>Calcular</span>. O valor convertido será exibido no campo <span style={{ color: "#34d399", fontWeight: 700 }}>"R$"</span>.
              </div>
            </div>
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <ConvRow
              label="RC"
              field="rc"
              value={conv.rc}
              onChange={(v) => updateConv("rc", v)}
              onCalc={calcViaRC}
              color="#fbbf24"
              highlight={lastCalc === "rc"}
              copiedField={copiedField}
              onCopy={handleCopyResult}
            />
            <ConvRow
              label="KK"
              field="kk"
              value={conv.kk}
              onChange={(v) => updateConv("kk", v)}
              onCalc={calcViaKK}
              color="#38bdf8"
              highlight={lastCalc === "kk"}
              copiedField={copiedField}
              onCopy={handleCopyResult}
            />
            <ConvRow
              label="R$"
              field="rs"
              value={conv.rs}
              onChange={(v) => updateConv("rs", v)}
              onCalc={calcViaRS}
              color="#34d399"
              highlight={lastCalc === "rs"}
              copiedField={copiedField}
              onCopy={handleCopyResult}
            />
          </div>
        </Card>
      </div>

      {/* Footer */}
      <div
        style={{
          padding: "12px 24px",
          borderTop: "1px solid color-mix(in oklab, var(--color-red-600) 55%, transparent)",
          boxShadow: "0 -4px 10px -2px color-mix(in oklab, var(--color-red-600) 25%, transparent)",
          fontSize: 10,
          color: "rgb(163, 163, 173)",
          textAlign: "center",
          flexShrink: 0,
          letterSpacing: "0.1em",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
        }}
      >
        <span>Dados salvos automaticamente</span>
        <span
          style={{
            width: 1,
            height: 12,
            background: "rgba(255,255,255,0.08)",
          }}
        />
        <span>Conteúdo exclusivo</span>
        <div
          className="relative inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[9px] font-black tracking-wider uppercase border border-amber-400/60 text-amber-200 overflow-hidden cursor-default select-none"
          style={{
            background:
              "linear-gradient(135deg, color-mix(in oklab, var(--color-amber-500) 25%, transparent) 0%, color-mix(in oklab, var(--color-amber-500) 18%, transparent) 50%, color-mix(in oklab, var(--color-amber-500) 22%, transparent) 100%)",
            boxShadow: "0 0 12px color-mix(in oklab, var(--color-amber-500) 35%, transparent), inset 0 0 8px color-mix(in oklab, var(--color-amber-500) 15%, transparent)",
          }}
          title="Membro VIP"
        >
          <span
            className="pointer-events-none absolute inset-0 -translate-x-full"
            style={{
              background: "linear-gradient(110deg, transparent 30%, rgba(255,255,255,0.45) 50%, transparent 70%)",
              animation: "vipShimmer 2.6s ease-in-out infinite",
            }}
          />
          <Crown
            size={11}
            className="relative z-10 text-amber-300"
            style={{ filter: "drop-shadow(0 0 4px color-mix(in oklab, var(--color-amber-500) 90%, transparent)) drop-shadow(0 0 8px color-mix(in oklab, var(--color-amber-500) 55%, transparent))" }}
          />
          <span
            className="relative z-10 bg-gradient-to-r from-amber-200 via-yellow-100 to-amber-300 bg-clip-text text-transparent"
            style={{ filter: "drop-shadow(0 0 3px color-mix(in oklab, var(--color-amber-500) 50%, transparent))" }}
          >
            VIP
          </span>
          <style>{`
            @keyframes vipShimmer {
              0% { transform: translateX(-100%); }
              60%, 100% { transform: translateX(200%); }
            }
          `}</style>
        </div>
      </div>
    </div>
  );
}

function Card({
  title,
  onReset,
  helpId,
  helpOpen,
  setHelpOpen,
  helpContent,
  children,
}: {
  title: string;
  onReset: () => void;
  helpId?: "tabela" | "conversor";
  helpOpen?: "tabela" | "conversor" | null;
  setHelpOpen?: React.Dispatch<React.SetStateAction<"tabela" | "conversor" | null>>;
  helpContent?: React.ReactNode;
  children: React.ReactNode;
}) {
  const helpRef = useRef<HTMLDivElement>(null);
  const showHelp = helpId ? helpOpen === helpId : false;

  useEffect(() => {
    if (!showHelp || !setHelpOpen) return;
    const closeHelp = setHelpOpen;
    const targetDoc = helpRef.current?.ownerDocument || document;

    function handleOutsideClick(e: MouseEvent) {
      if (helpRef.current && !helpRef.current.contains(e.target as Node)) {
        closeHelp(null);
      }
    }

    targetDoc.addEventListener("mousedown", handleOutsideClick, true);
    return () => targetDoc.removeEventListener("mousedown", handleOutsideClick, true);
  }, [showHelp, setHelpOpen]);

  function toggleHelp() {
    if (!helpId || !setHelpOpen) return;
    setHelpOpen(showHelp ? null : helpId);
  }

  return (
    <div
      style={{
        borderRadius: 10,
        border: "1px solid color-mix(in oklab, var(--color-red-600) 55%, transparent)",
        background:
          "linear-gradient(135deg, color-mix(in oklab, var(--color-red-600) 6%, transparent), color-mix(in oklab, var(--th-brand) 4%, transparent))",
        padding: 12,
        boxShadow:
          "0 0 10px color-mix(in oklab, var(--color-red-600) 30%, transparent), inset 0 0 12px color-mix(in oklab, var(--color-red-600) 8%, transparent)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 10,
        }}
      >
        <div
          style={{
            fontSize: 10,
            fontWeight: 600,
            color: "#a1a1aa",
            textTransform: "uppercase",
            letterSpacing: "0.14em",
          }}
        >
          {title}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {helpContent && (
            <div ref={helpRef} style={{ position: "relative" }}>
              <button
                type="button"
                data-help-button
                onClick={toggleHelp}
                style={{
                  width: 24,
                  height: 24,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: 6,
                  border: "1px solid rgba(255,255,255,0.05)",
                  background: "transparent",
                  color: "#71717a",
                  cursor: "pointer",
                  transition: "all 0.15s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = "#38bdf8";
                  e.currentTarget.style.borderColor = "rgba(56,189,248,0.3)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = "#71717a";
                  e.currentTarget.style.borderColor = "rgba(255,255,255,0.05)";
                }}
              >
                <HelpCircle size={11} />
              </button>
              {showHelp && (
                <div
                  data-help-tooltip
                  style={{
                    position: "absolute",
                    top: "100%",
                    right: 0,
                    marginTop: 6,
                    width: 320,
                    padding: "12px 14px",
                    borderRadius: 10,
                    background: "var(--th-n-hi)",
                    border: "1px solid rgba(255,255,255,0.1)",
                    boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
                    zIndex: 100,
                    color: "#a1a1aa",
                    fontSize: 11,
                    lineHeight: 1.6,
                  }}
                >
                  {helpContent}
                </div>
              )}
            </div>
          )}
          <button
            type="button"
            onClick={onReset}
            title="Resetar"
            style={{
              width: 24,
              height: 24,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 6,
              border: "1px solid rgba(255,255,255,0.05)",
              background: "transparent",
              color: "#71717a",
              cursor: "pointer",
              transition: "all 0.15s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "#e4e4e7";
              e.currentTarget.style.borderColor = "rgba(255,255,255,0.15)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "#71717a";
              e.currentTarget.style.borderColor = "rgba(255,255,255,0.05)";
            }}
          >
            <RotateCcw size={11} />
          </button>
        </div>
      </div>
      {children}
    </div>
  );
}

function RefInput({
  label,
  value,
  onChange,
  color,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  color: string;
}) {
  return (
    <div>
      <div
        style={{
          fontSize: 9,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.14em",
          marginBottom: 5,
          color,
          textAlign: "center",
        }}
      >
        {label}
      </div>
      <input
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(sanitizeNumeric(e.target.value))}
        placeholder="0"
        style={{
          width: "100%",
          background: "rgba(0,0,0,0.3)",
          border: "1px solid color-mix(in oklab, var(--color-red-600) 45%, transparent)",
          borderRadius: 7,
          padding: "8px 10px",
          fontSize: 13,
          color: "#fff",
          textAlign: "center",
          fontVariantNumeric: "tabular-nums",
          fontWeight: 500,
          outline: "none",
          boxSizing: "border-box",
          boxShadow: "inset 0 0 4px color-mix(in oklab, var(--color-red-600) 10%, transparent)",
        }}
      />
    </div>
  );
}

function ConvRow({
  label,
  field,
  value,
  onChange,
  onCalc,
  color,
  highlight,
  copiedField,
  onCopy,
}: {
  label: string;
  field: "rc" | "kk" | "rs";
  value: string;
  onChange: (v: string) => void;
  onCalc: () => void;
  color: string;
  highlight: boolean;
  copiedField: "rc" | "kk" | "rs" | null;
  onCopy: (field: "rc" | "kk" | "rs", sourceDoc?: Document) => void;
}) {
  const isCopied = copiedField === field;
  const hasValue = !!value;

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      onCalc();
    }
  }

  function handleCopyClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    onCopy(field, e.currentTarget.ownerDocument);
  }

  function getCopyText(): string {
    if (!value) return "";
    if (field === "rc") return `${value} RC`;
    if (field === "kk") return fmtKK(parsePtBR(value));
    return `R$ ${value}`;
  }

  const copyText = getCopyText();

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        transition: "all 0.2s",
      }}
    >
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          color,
          width: 24,
          textAlign: "right",
          flexShrink: 0,
        }}
      >
        {label}
      </div>

      {/* Container: input (~65%) + botão copiar (~35%) */}
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "stretch",
          background: "rgba(0,0,0,0.3)",
          border: `1px solid ${highlight ? color + "55" : "color-mix(in oklab, var(--color-red-600) 45%, transparent)"}`,
          borderRadius: 8,
          overflow: "hidden",
          transition: "border-color 0.15s",
          boxShadow: "inset 0 0 4px color-mix(in oklab, var(--color-red-600) 10%, transparent)",
        }}
      >
        <input
          type="text"
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(sanitizeNumeric(e.target.value))}
          onKeyDown={handleKeyDown}
          placeholder="0"
          style={{
            flex: 1,
            minWidth: 0,
            background: "transparent",
            border: "none",
            padding: "8px 10px",
            fontSize: 13,
            color: "#fff",
            fontVariantNumeric: "tabular-nums",
            fontWeight: 500,
            outline: "none",
            cursor: "text",
          }}
        />
        <button
          type="button"
          onClick={handleCopyClick}
          disabled={!hasValue}
          title={hasValue ? `Copiar: ${copyText}` : "Sem valor para copiar"}
          style={{
            width: "35%",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 2,
            padding: "4px 6px",
            background: hasValue
              ? isCopied
                ? "linear-gradient(135deg, rgba(52,211,153,0.12), rgba(52,211,153,0.06))"
                : "linear-gradient(135deg, rgba(16,185,129,0.08), rgba(16,185,129,0.03))"
              : "rgba(255,255,255,0.015)",
            border: "none",
            borderLeft: hasValue ? "1px solid rgba(16,185,129,0.2)" : "1px solid rgba(255,255,255,0.04)",
            color: isCopied ? "#34d399" : hasValue ? "#86efac" : "var(--th-n-thumb)",
            cursor: hasValue ? "pointer" : "not-allowed",
            fontSize: 9,
            fontWeight: 600,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            whiteSpace: "nowrap",
            transition: "all 0.15s",
            flexShrink: 0,
          }}
          onMouseEnter={(e) => {
            if (hasValue && !isCopied) {
              e.currentTarget.style.color = "#bbf7d0";
              e.currentTarget.style.background = "linear-gradient(135deg, rgba(16,185,129,0.14), rgba(16,185,129,0.06))";
            }
          }}
          onMouseLeave={(e) => {
            if (hasValue && !isCopied) {
              e.currentTarget.style.color = "#86efac";
              e.currentTarget.style.background = "linear-gradient(135deg, rgba(16,185,129,0.08), rgba(16,185,129,0.03))";
            }
          }}
        >
          {isCopied ? <Check size={14} strokeWidth={2.5} /> : <Copy size={13} strokeWidth={2} />}
          <span style={{ maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis" }}>
            {hasValue ? copyText : "Copiar"}
          </span>
        </button>
      </div>

      <button
        type="button"
        onClick={onCalc}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          padding: "7px 10px",
          borderRadius: 7,
          fontSize: 11,
          fontWeight: 600,
          border: `1px solid ${color}33`,
          background: color + "12",
          color,
          cursor: "pointer",
          whiteSpace: "nowrap",
          transition: "all 0.15s",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = color + "22";
          e.currentTarget.style.borderColor = color + "55";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = color + "12";
          e.currentTarget.style.borderColor = color + "33";
        }}
      >
        Calcular <ArrowRight size={11} />
      </button>
    </div>
  );
}
