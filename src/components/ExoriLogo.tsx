import { useState, useEffect } from 'react';
import exoriShieldImg from './exori-shield.webp'; // 219 KB → ~11 KB (160px, 2× o maior uso de 80px)
import { loadLowCpuUsage } from '../storage';

interface Props {
  size?: number;
  className?: string;
  onClick?: () => void;
  onMouseDown?: (event: React.MouseEvent<HTMLDivElement>) => void;
  notificationCount?: number;
  isNotificationOpen?: boolean;
}

// ============================================================================
// PERFORMANCE (auditoria pós-deploy): a versão anterior animava GEOMETRIA
// (rx/ry via SMIL) de elipses sob um filtro feGaussianBlur e o raio dos
// drop-shadows da imagem — cada frame forçava re-rasterização dos filtros na
// main thread (parcela relevante do custo contínuo de Style & Layout/
// Rendering medido em produção). Esta versão preserva o MESMO efeito visual
// (respiração do glow, brilho, sparks, hover, sincronização e lowCpu)
// trocando a técnica:
//   • glow central: filtro de blur substituído por gradientes radiais com
//     falloff suave equivalente (pré-preparados, estáticos); a respiração é
//     feita SÓ com transform:scale + opacity (propriedades compositáveis);
//   • brilho da imagem: drop-shadows ESTÁTICOS (rasterizados uma única vez)
//     em duas camadas — base no tom do vale e overlay no tom do pico — com o
//     overlay respirando via opacity; a escala respira num wrapper próprio
//     (transform puro);
//   • sparks: filtro de blur do grupo substituído por gradientes radiais por
//     cor (halo embutido); trajetória/tamanho/brilho convertidos de SMIL
//     (cx/cy/r/opacity) para UM keyframe CSS dirigido por variáveis,
//     animando apenas transform (translate+scale) e opacity.
// Valores de cor/intensidade/duração/atraso idênticos aos originais.
// ============================================================================

/** Trajetórias dos sparks — mesmos pontos/tempos da versão SMIL original.
 *  from/to em unidades do viewBox (0-100); mid = ponto médio (interpolação
 *  linear idêntica à do SMIL de 2 valores); r = tamanho no início/pico/fim
 *  (vira scale — o núcleo sólido do gradiente tem o MESMO raio do círculo
 *  original); op = opacidade de pico; dur/delay em segundos. */
interface SparkDef {
  from: [number, number];
  to: [number, number];
  r: [number, number, number];
  op: number;
  dur: number;
  delay: number;
  fill: string; // id do gradiente (cor original do spark)
}

const SPARKS: SparkDef[] = [
  { from: [25, 30], to: [15, 8],    r: [0.8, 1.4, 0.3], op: 1,    dur: 1.8, delay: 0,   fill: "exoriSparkAmber" },
  { from: [75, 32], to: [88, 5],    r: [0.7, 1.3, 0.2], op: 0.9,  dur: 2.1, delay: 0.3, fill: "exoriSparkCream" },
  { from: [15, 50], to: [-15, 45],  r: [0.9, 1.5, 0.3], op: 1,    dur: 2.4, delay: 0.6, fill: "exoriSparkOrange" },
  { from: [85, 52], to: [115, 48],  r: [0.8, 1.4, 0.2], op: 0.95, dur: 2,   delay: 0.9, fill: "exoriSparkOrange" },
  { from: [30, 75], to: [15, 105],  r: [0.7, 1.2, 0.2], op: 0.85, dur: 2.3, delay: 0.4, fill: "exoriSparkAmber" },
  { from: [70, 72], to: [88, 102],  r: [0.8, 1.3, 0.2], op: 0.9,  dur: 1.9, delay: 0.7, fill: "exoriSparkCream" },
  { from: [50, 20], to: [50, -12],  r: [1, 1.6, 0.3],   op: 1,    dur: 1.7, delay: 0.2, fill: "exoriSparkAmber" },
  { from: [50, 82], to: [50, 118],  r: [1, 1.5, 0.3],   op: 0.95, dur: 2.2, delay: 0.5, fill: "exoriSparkOrange" },
  { from: [15, 20], to: [-5, -8],   r: [0.8, 0.8, 0.8], op: 0.8,  dur: 2.5, delay: 0.1, fill: "exoriSparkCream" },
  { from: [88, 22], to: [108, -5],  r: [0.8, 0.8, 0.8], op: 0.85, dur: 2.3, delay: 0.8, fill: "exoriSparkAmber" },
  { from: [18, 85], to: [-5, 115],  r: [0.9, 0.9, 0.9], op: 0.9,  dur: 1.9, delay: 0.6, fill: "exoriSparkOrange" },
  { from: [85, 82], to: [110, 112], r: [0.9, 0.9, 0.9], op: 0.88, dur: 2.6, delay: 0.9, fill: "exoriSparkCream" },
];

/** Sparks extras quando há notificações pendentes (quadruplicação) — mesmas
 *  trajetórias/durações fixas da versão original (não escalam com sMult). */
const ACTIVE_SPARKS: SparkDef[] = [
  { from: [35, 35], to: [5, 5],   r: [1.2, 1.2, 1.2], op: 1, dur: 0.45, delay: 0, fill: "exoriSparkAmber" },
  { from: [65, 35], to: [95, 5],  r: [1.2, 1.2, 1.2], op: 1, dur: 0.52, delay: 0, fill: "exoriSparkCream" },
  { from: [35, 65], to: [5, 95],  r: [1.2, 1.2, 1.2], op: 1, dur: 0.58, delay: 0, fill: "exoriSparkOrange" },
  { from: [65, 65], to: [95, 95], r: [1.2, 1.2, 1.2], op: 1, dur: 0.48, delay: 0, fill: "exoriSparkCream" },
];

/** Estilo de um spark: variáveis CSS lidas pelo keyframe exoriSparkFly.
 *  Só transform (translate+scale) e opacity — nada de layout/pintura/filtro
 *  por frame. O círculo é estático em (0,0) com r=2: o núcleo sólido do
 *  gradiente ocupa 50% (raio efetivo = scale, igual ao r original) e o halo
 *  externo substitui o antigo feGaussianBlur(1.5). */
function sparkStyle(s: SparkDef, durMult: number): React.CSSProperties {
  const mid: [number, number] = [(s.from[0] + s.to[0]) / 2, (s.from[1] + s.to[1]) / 2];
  return {
    "--sp-x0": `${s.from[0]}px`, "--sp-y0": `${s.from[1]}px`,
    "--sp-xm": `${mid[0]}px`,    "--sp-ym": `${mid[1]}px`,
    "--sp-x1": `${s.to[0]}px`,   "--sp-y1": `${s.to[1]}px`,
    "--sp-r0": s.r[0], "--sp-r1": s.r[1], "--sp-r2": s.r[2],
    "--sp-op": s.op,
    transformBox: "fill-box",
    transformOrigin: "center",
    animation: `exoriSparkFly ${s.dur * durMult}s linear ${s.delay}s infinite`,
  } as React.CSSProperties;
}

function ExoriLogo({ size = 20, className = "", onClick, onMouseDown, notificationCount = 0, isNotificationOpen = false }: Props) {
  const [isHovered, setIsHovered] = useState(false);
  const [lowCpu, setLowCpu] = useState(() => loadLowCpuUsage());

  useEffect(() => {
    const handleStorage = () => setLowCpu(loadLowCpuUsage());
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const activeSparks = notificationCount > 0 && !isNotificationOpen;
  const sMult = activeSparks ? 0.25 : 1;

  const handleContainerClick = () => {
    if (onClick) onClick();
  };

  const handleContainerMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (onClick) event.stopPropagation();
    if (onMouseDown) onMouseDown(event);
  };

  return (
    <div
      className={className}
      onClick={handleContainerClick}
      onMouseDown={handleContainerMouseDown}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={{
        width: size,
        height: size,
        position: "relative",
        display: "inline-block",
        cursor: onClick ? "pointer" : "default",
      }}
    >
      {/* Badge de Notificações */}
      {notificationCount > 0 && (
        <div
          className="absolute -top-1.5 -right-1.5 z-50 bg-[#ef4444] text-black font-black font-mono rounded-full flex items-center justify-center text-[10px] min-w-[18px] h-[18px] px-1 shadow-lg shadow-red-500/50 border border-black"
          style={{ pointerEvents: "none" }}
        >
          {notificationCount}
        </div>
      )}

      {/* === BACKGROUND SUBTLE PULSE (behind the PNG) ===
          Geometria ESTÁTICA; o falloff suave vem dos gradientes (equivalente
          ao antigo blur) e a respiração usa apenas scale+opacity. */}
      <svg
        width="160%"
        height="160%"
        viewBox="0 0 100 100"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          zIndex: 1,
          pointerEvents: "none",
          overflow: "visible",
        }}
      >
        <defs>
          {/* Falloff alongado (antes: gradiente + feGaussianBlur 5): os stops
              intermediários reproduzem a suavização que o blur dava. */}
          <radialGradient id="centerPulse" cx="50%" cy="50%" r="50%">
            <stop offset="0%" style={{ stopColor: "var(--color-red-500)" }} stopOpacity="0.55" />
            <stop offset="30%" style={{ stopColor: "var(--color-red-600)" }} stopOpacity="0.26" />
            <stop offset="65%" style={{ stopColor: "var(--color-red-700)" }} stopOpacity="0.10" />
            <stop offset="100%" style={{ stopColor: "var(--color-red-800)" }} stopOpacity="0" />
          </radialGradient>
          {/* Glow quente: antes era elipse sólida #FBBF24 borrada pelo filtro;
              o gradiente reproduz núcleo cheio + halo. */}
          <radialGradient id="exoriWarmGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#FBBF24" stopOpacity="1" />
            <stop offset="45%" stopColor="#FBBF24" stopOpacity="0.85" />
            <stop offset="75%" stopColor="#FBBF24" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#FBBF24" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* Main subtle center pulse — rx/ry +2 compensam o espalhamento que o
            blur removido dava; scale(1→1.1) replica o antigo rx 28→31. */}
        <ellipse
          cx="50" cy="52" rx="30" ry="35"
          fill="url(#centerPulse)"
          style={lowCpu ? undefined : {
            transformBox: "fill-box",
            transformOrigin: "center",
            animation: `exoriGlowA ${2.8 * sMult}s linear infinite`,
          }}
        />

        {/* Secondary warm pulse — opacity base 0.08 (estado lowCpu, idêntico
            ao original); animação defasada em 0.15s como antes. */}
        <ellipse
          cx="50" cy="52" rx="23.5" ry="28.5"
          fill="url(#exoriWarmGlow)"
          opacity="0.08"
          style={lowCpu ? undefined : {
            transformBox: "fill-box",
            transformOrigin: "center",
            animation: `exoriGlowB ${2.8 * sMult}s linear 0.15s infinite`,
          }}
        />
      </svg>

      {/* === BASE IMAGE - PNG in foreground === */}
      <div
        style={{
          width: "145%",
          height: "145%",
          position: "absolute",
          top: "50%",
          left: "50%",
          zIndex: 2,
          transformOrigin: "center center",
          transform: isHovered ? "translate(-50%, -50%) scale(1.28)" : "translate(-50%, -50%) scale(1)",
          transition: "transform 420ms cubic-bezier(0.16, 1, 0.3, 1)",
          userSelect: "none",
          pointerEvents: "none",
        }}
      >
        {/* Respiração de ESCALA isolada num wrapper (transform puro). */}
        <div
          style={{
            width: "100%",
            height: "100%",
            position: "relative",
            transformOrigin: "center center",
            animation: lowCpu ? "none" : isHovered
              ? `exoriHoverScale ${1.15 * sMult}s ease-in-out infinite`
              : `exoriPulseScale ${2.8 * sMult}s ease-in-out infinite`,
          }}
        >
          {/* Camada base: drop-shadow ESTÁTICO no tom do vale do ciclo
              (lowCpu mantém exatamente o filtro único original). */}
          <img
            src={exoriShieldImg}
            alt="Exori Team Shield"
            draggable={false}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "contain",
              display: "block",
              filter: lowCpu
                ? "drop-shadow(0 0 8px color-mix(in oklab, var(--color-red-600) 78%, transparent))"
                : isHovered
                  ? "drop-shadow(0 0 12px color-mix(in oklab, var(--color-red-600) 95%, transparent)) drop-shadow(0 0 24px color-mix(in oklab, var(--color-red-600) 45%, transparent))"
                  : "drop-shadow(0 0 8px color-mix(in oklab, var(--color-red-600) 72%, transparent)) drop-shadow(0 0 16px color-mix(in oklab, var(--color-red-600) 28%, transparent))",
              transformOrigin: "center center",
              userSelect: "none",
              pointerEvents: "none",
            }}
          />
          {/* Camada de brilho do PICO: drop-shadow estático (rasterizado uma
              vez) respirando via opacity — substitui a antiga animação do
              RAIO dos drop-shadows, que re-filtrava a imagem a cada frame. */}
          {!lowCpu && (
            <img
              src={exoriShieldImg}
              alt=""
              aria-hidden="true"
              draggable={false}
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                objectFit: "contain",
                display: "block",
                opacity: 0,
                willChange: "opacity",
                animation: isHovered
                  ? `exoriGlowFade ${1.15 * sMult}s ease-in-out infinite`
                  : `exoriGlowFade ${2.8 * sMult}s ease-in-out infinite`,
                filter: isHovered
                  ? "drop-shadow(0 0 18px color-mix(in oklab, var(--color-red-600) 80%, transparent)) drop-shadow(0 0 34px color-mix(in oklab, var(--color-amber-500) 55%, transparent))"
                  : "drop-shadow(0 0 11px color-mix(in oklab, var(--color-red-600) 60%, transparent)) drop-shadow(0 0 22px color-mix(in oklab, var(--color-amber-500) 32%, transparent))",
                userSelect: "none",
                pointerEvents: "none",
              }}
            />
          )}
        </div>
      </div>

      {/* === FOREGROUND EFFECTS - Outward Sparks (on top of PNG) === */}
      {!lowCpu && (
        <svg
          width="180%"
          height="180%"
          viewBox="0 0 100 100"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            zIndex: 4,
            pointerEvents: "none",
            overflow: "visible",
          }}
        >
          <defs>
            {/* Halo embutido por cor (substitui o feGaussianBlur do grupo):
                núcleo sólido até 50% (mesmo raio do círculo original) e
                falloff suave até a borda. */}
            <radialGradient id="exoriSparkAmber" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#FBBF24" stopOpacity="1" />
              <stop offset="50%" stopColor="#FBBF24" stopOpacity="0.95" />
              <stop offset="78%" stopColor="#FBBF24" stopOpacity="0.4" />
              <stop offset="100%" stopColor="#FBBF24" stopOpacity="0" />
            </radialGradient>
            <radialGradient id="exoriSparkCream" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#FEF3C7" stopOpacity="1" />
              <stop offset="50%" stopColor="#FEF3C7" stopOpacity="0.95" />
              <stop offset="78%" stopColor="#FEF3C7" stopOpacity="0.4" />
              <stop offset="100%" stopColor="#FEF3C7" stopOpacity="0" />
            </radialGradient>
            <radialGradient id="exoriSparkOrange" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#F97316" stopOpacity="1" />
              <stop offset="50%" stopColor="#F97316" stopOpacity="0.95" />
              <stop offset="78%" stopColor="#F97316" stopOpacity="0.4" />
              <stop offset="100%" stopColor="#F97316" stopOpacity="0" />
            </radialGradient>
          </defs>

          {/* === OUTWARD SPARKS === */}
          <g>
            {SPARKS.map((s, i) => (
              <circle key={i} cx="0" cy="0" r="2" fill={`url(#${s.fill})`} opacity="0" style={sparkStyle(s, sMult)} />
            ))}

            {/* Quadrupled sparks when active */}
            {activeSparks && ACTIVE_SPARKS.map((s, i) => (
              <circle key={`a${i}`} cx="0" cy="0" r="2" fill={`url(#${s.fill})`} opacity="0" style={sparkStyle(s, 1)} />
            ))}
          </g>
        </svg>
      )}

      <style>{`
        /* Glow central: mesma amplitude do SMIL original (opacity .12→.34,
           tamanho +~10% no pico — rx 28→31 virou scale 1→1.1). */
        @keyframes exoriGlowA {
          0%, 100% { opacity: 0.12; transform: scale(1); }
          50% { opacity: 0.34; transform: scale(1.1); }
        }
        /* Glow quente: opacity .03→.12, rx 22→24.5 ≈ scale 1→1.11. */
        @keyframes exoriGlowB {
          0%, 100% { opacity: 0.03; transform: scale(1); }
          50% { opacity: 0.12; transform: scale(1.11); }
        }
        /* Respiração de escala da imagem (antes parte de exoriPulse). */
        @keyframes exoriPulseScale {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.018); }
        }
        @keyframes exoriHoverScale {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.045); }
        }
        /* Respiração do brilho do pico (camada overlay). */
        @keyframes exoriGlowFade {
          0%, 100% { opacity: 0; }
          50% { opacity: 1; }
        }
        /* Trajetória dos sparks — translate+scale+opacity dirigidos por
           variáveis definidas inline em cada círculo. */
        @keyframes exoriSparkFly {
          0% {
            transform: translate(var(--sp-x0), var(--sp-y0)) scale(var(--sp-r0));
            opacity: 0;
          }
          50% {
            transform: translate(var(--sp-xm), var(--sp-ym)) scale(var(--sp-r1));
            opacity: var(--sp-op);
          }
          100% {
            transform: translate(var(--sp-x1), var(--sp-y1)) scale(var(--sp-r2));
            opacity: 0;
          }
        }
      `}</style>
    </div>
  );
}

export default ExoriLogo;
