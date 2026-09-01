import { useState, useEffect } from 'react';
import exoriShieldImg from './exori-shield.png';
import { loadLowCpuUsage } from '../storage';

interface Props {
  size?: number;
  className?: string;
  onClick?: () => void;
  onMouseDown?: (event: React.MouseEvent<HTMLDivElement>) => void;
  notificationCount?: number;
  isNotificationOpen?: boolean;
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

      {/* === BACKGROUND SUBTLE PULSE (behind the PNG) === */}
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
          <radialGradient id="centerPulse" cx="50%" cy="50%" r="50%">
            <stop offset="0%" style={{ stopColor: "var(--color-red-500)" }} stopOpacity="0.55" />
            <stop offset="35%" style={{ stopColor: "var(--color-red-600)" }} stopOpacity="0.22" />
            <stop offset="100%" style={{ stopColor: "var(--color-red-800)" }} stopOpacity="0" />
          </radialGradient>
          <filter id="softGlow" x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur stdDeviation="5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Main subtle center pulse */}
        <ellipse cx="50" cy="52" rx="28" ry="33" fill="url(#centerPulse)" filter="url(#softGlow)">
          {!lowCpu && (
            <>
              <animate attributeName="opacity" values="0.12;0.34;0.12" dur={`${2.8 * sMult}s`} repeatCount="indefinite" />
              <animate attributeName="rx" values="28;31;28" dur={`${2.8 * sMult}s`} repeatCount="indefinite" />
              <animate attributeName="ry" values="33;37;33" dur={`${2.8 * sMult}s`} repeatCount="indefinite" />
            </>
          )}
        </ellipse>

        {/* Secondary warm pulse */}
        <ellipse cx="50" cy="52" rx="22" ry="27" fill="#FBBF24" opacity={lowCpu ? "0.08" : "0.08"} filter="url(#softGlow)">
          {!lowCpu && (
            <>
              <animate attributeName="opacity" values="0.03;0.12;0.03" dur={`${2.8 * sMult}s`} repeatCount="indefinite" begin="0.15s" />
              <animate attributeName="rx" values="22;24.5;22" dur={`${2.8 * sMult}s`} repeatCount="indefinite" begin="0.15s" />
              <animate attributeName="ry" values="27;30;27" dur={`${2.8 * sMult}s`} repeatCount="indefinite" begin="0.15s" />
            </>
          )}
        </ellipse>
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
        <img
          src={exoriShieldImg}
          alt="Exori Team Shield"
          draggable={false}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "contain",
            display: "block",
            animation: lowCpu ? "none" : isHovered
              ? `exoriHoverPulse ${1.15 * sMult}s ease-in-out infinite`
              : `exoriPulse ${2.8 * sMult}s ease-in-out infinite`,
            filter: "drop-shadow(0 0 8px color-mix(in oklab, var(--color-red-600) 78%, transparent))",
            transformOrigin: "center center",
            userSelect: "none",
            pointerEvents: "none",
          }}
        />
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
            <filter id="sparkGlow" x="-200%" y="-200%" width="500%" height="500%">
              <feGaussianBlur stdDeviation="1.5" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* === OUTWARD SPARKS === */}
          <g filter="url(#sparkGlow)">
            {/* Spark 1 */}
            <circle cx="25" cy="25" r="1" fill="#FBBF24" opacity="0">
              <animate attributeName="opacity" values="0;1;0" dur={`${1.8 * sMult}s`} repeatCount="indefinite" />
              <animate attributeName="cy" values="30;8" dur={`${1.8 * sMult}s`} repeatCount="indefinite" />
              <animate attributeName="cx" values="25;15" dur={`${1.8 * sMult}s`} repeatCount="indefinite" />
              <animate attributeName="r" values="0.8;1.4;0.3" dur={`${1.8 * sMult}s`} repeatCount="indefinite" />
            </circle>

            {/* Spark 2 */}
            <circle cx="75" cy="28" r="1" fill="#FEF3C7" opacity="0">
              <animate attributeName="opacity" values="0;0.9;0" dur={`${2.1 * sMult}s`} repeatCount="indefinite" begin="0.3s" />
              <animate attributeName="cy" values="32;5" dur={`${2.1 * sMult}s`} repeatCount="indefinite" begin="0.3s" />
              <animate attributeName="cx" values="75;88" dur={`${2.1 * sMult}s`} repeatCount="indefinite" begin="0.3s" />
              <animate attributeName="r" values="0.7;1.3;0.2" dur={`${2.1 * sMult}s`} repeatCount="indefinite" begin="0.3s" />
            </circle>

            {/* Spark 3 */}
            <circle cx="10" cy="50" r="1.1" fill="#F97316" opacity="0">
              <animate attributeName="opacity" values="0;1;0" dur={`${2.4 * sMult}s`} repeatCount="indefinite" begin="0.6s" />
              <animate attributeName="cx" values="15;-15" dur={`${2.4 * sMult}s`} repeatCount="indefinite" begin="0.6s" />
              <animate attributeName="cy" values="50;45" dur={`${2.4 * sMult}s`} repeatCount="indefinite" begin="0.6s" />
              <animate attributeName="r" values="0.9;1.5;0.3" dur={`${2.4 * sMult}s`} repeatCount="indefinite" begin="0.6s" />
            </circle>

            {/* Spark 4 */}
            <circle cx="90" cy="52" r="1.1" fill="#F97316" opacity="0">
              <animate attributeName="opacity" values="0;0.95;0" dur={`${2 * sMult}s`} repeatCount="indefinite" begin="0.9s" />
              <animate attributeName="cx" values="85;115" dur={`${2 * sMult}s`} repeatCount="indefinite" begin="0.9s" />
              <animate attributeName="cy" values="52;48" dur={`${2 * sMult}s`} repeatCount="indefinite" begin="0.9s" />
              <animate attributeName="r" values="0.8;1.4;0.2" dur={`${2 * sMult}s`} repeatCount="indefinite" begin="0.9s" />
            </circle>

            {/* Spark 5 */}
            <circle cx="30" cy="78" r="0.9" fill="#FBBF24" opacity="0">
              <animate attributeName="opacity" values="0;0.85;0" dur={`${2.3 * sMult}s`} repeatCount="indefinite" begin="0.4s" />
              <animate attributeName="cy" values="75;105" dur={`${2.3 * sMult}s`} repeatCount="indefinite" begin="0.4s" />
              <animate attributeName="cx" values="30;15" dur={`${2.3 * sMult}s`} repeatCount="indefinite" begin="0.4s" />
              <animate attributeName="r" values="0.7;1.2;0.2" dur={`${2.3 * sMult}s`} repeatCount="indefinite" begin="0.4s" />
            </circle>

            {/* Spark 6 */}
            <circle cx="70" cy="75" r="0.9" fill="#FEF3C7" opacity="0">
              <animate attributeName="opacity" values="0;0.9;0" dur={`${1.9 * sMult}s`} repeatCount="indefinite" begin="0.7s" />
              <animate attributeName="cy" values="72;102" dur={`${1.9 * sMult}s`} repeatCount="indefinite" begin="0.7s" />
              <animate attributeName="cx" values="70;88" dur={`${1.9 * sMult}s`} repeatCount="indefinite" begin="0.7s" />
              <animate attributeName="r" values="0.8;1.3;0.2" dur={`${1.9 * sMult}s`} repeatCount="indefinite" begin="0.7s" />
            </circle>

            {/* Spark 7 */}
            <circle cx="50" cy="18" r="1.2" fill="#FBBF24" opacity="0">
              <animate attributeName="opacity" values="0;1;0" dur={`${1.7 * sMult}s`} repeatCount="indefinite" begin="0.2s" />
              <animate attributeName="cy" values="20;-12" dur={`${1.7 * sMult}s`} repeatCount="indefinite" begin="0.2s" />
              <animate attributeName="r" values="1;1.6;0.3" dur={`${1.7 * sMult}s`} repeatCount="indefinite" begin="0.2s" />
            </circle>

            {/* Spark 8 */}
            <circle cx="50" cy="85" r="1.2" fill="#F97316" opacity="0">
              <animate attributeName="opacity" values="0;0.95;0" dur={`${2.2 * sMult}s`} repeatCount="indefinite" begin="0.5s" />
              <animate attributeName="cy" values="82;118" dur={`${2.2 * sMult}s`} repeatCount="indefinite" begin="0.5s" />
              <animate attributeName="r" values="1;1.5;0.3" dur={`${2.2 * sMult}s`} repeatCount="indefinite" begin="0.5s" />
            </circle>

            {/* Spark 9 */}
            <circle cx="10" cy="15" r="0.8" fill="#FEF3C7" opacity="0">
              <animate attributeName="opacity" values="0;0.8;0" dur={`${2.5 * sMult}s`} repeatCount="indefinite" begin="0.1s" />
              <animate attributeName="cy" values="20;-8" dur={`${2.5 * sMult}s`} repeatCount="indefinite" begin="0.1s" />
              <animate attributeName="cx" values="15;-5" dur={`${2.5 * sMult}s`} repeatCount="indefinite" begin="0.1s" />
            </circle>

            {/* Spark 10 */}
            <circle cx="90" cy="18" r="0.8" fill="#FBBF24" opacity="0">
              <animate attributeName="opacity" values="0;0.85;0" dur={`${2.3 * sMult}s`} repeatCount="indefinite" begin="0.8s" />
              <animate attributeName="cy" values="22;-5" dur={`${2.3 * sMult}s`} repeatCount="indefinite" begin="0.8s" />
              <animate attributeName="cx" values="88;108" dur={`${2.3 * sMult}s`} repeatCount="indefinite" begin="0.8s" />
            </circle>

            {/* Spark 11 */}
            <circle cx="12" cy="88" r="0.9" fill="#F97316" opacity="0">
              <animate attributeName="opacity" values="0;0.9;0" dur={`${1.9 * sMult}s`} repeatCount="indefinite" begin="0.6s" />
              <animate attributeName="cy" values="85;115" dur={`${1.9 * sMult}s`} repeatCount="indefinite" begin="0.6s" />
              <animate attributeName="cx" values="18;-5" dur={`${1.9 * sMult}s`} repeatCount="indefinite" begin="0.6s" />
            </circle>

            {/* Spark 12 */}
            <circle cx="88" cy="85" r="0.9" fill="#FEF3C7" opacity="0">
              <animate attributeName="opacity" values="0;0.88;0" dur={`${2.6 * sMult}s`} repeatCount="indefinite" begin="0.9s" />
              <animate attributeName="cy" values="82;112" dur={`${2.6 * sMult}s`} repeatCount="indefinite" begin="0.9s" />
              <animate attributeName="cx" values="85;110" dur={`${2.6 * sMult}s`} repeatCount="indefinite" begin="0.9s" />
            </circle>

            {/* Quadrupled sparks when active */}
            {activeSparks && (
              <>
                <circle cx="35" cy="35" r="1.2" fill="#FBBF24" opacity="0">
                  <animate attributeName="opacity" values="0;1;0" dur="0.45s" repeatCount="indefinite" />
                  <animate attributeName="cy" values="35;5" dur="0.45s" repeatCount="indefinite" />
                  <animate attributeName="cx" values="35;5" dur="0.45s" repeatCount="indefinite" />
                </circle>
                <circle cx="65" cy="35" r="1.2" fill="#FEF3C7" opacity="0">
                  <animate attributeName="opacity" values="0;1;0" dur="0.52s" repeatCount="indefinite" />
                  <animate attributeName="cy" values="35;5" dur="0.52s" repeatCount="indefinite" />
                  <animate attributeName="cx" values="65;95" dur="0.52s" repeatCount="indefinite" />
                </circle>
                <circle cx="35" cy="65" r="1.2" fill="#F97316" opacity="0">
                  <animate attributeName="opacity" values="0;1;0" dur="0.58s" repeatCount="indefinite" />
                  <animate attributeName="cy" values="65;95" dur="0.58s" repeatCount="indefinite" />
                  <animate attributeName="cx" values="35;5" dur="0.58s" repeatCount="indefinite" />
                </circle>
                <circle cx="65" cy="65" r="1.2" fill="#FEF3C7" opacity="0">
                  <animate attributeName="opacity" values="0;1;0" dur="0.48s" repeatCount="indefinite" />
                  <animate attributeName="cy" values="65;95" dur="0.48s" repeatCount="indefinite" />
                  <animate attributeName="cx" values="65;95" dur="0.48s" repeatCount="indefinite" />
                </circle>
              </>
            )}
          </g>
        </svg>
      )}

      <style>{`
        @keyframes exoriPulse {
          0%, 100% {
            transform: scale(1);
            filter: drop-shadow(0 0 8px color-mix(in oklab, var(--color-red-600) 72%, transparent)) drop-shadow(0 0 16px color-mix(in oklab, var(--color-red-600) 28%, transparent));
          }
          50% {
            transform: scale(1.018);
            filter: drop-shadow(0 0 11px color-mix(in oklab, var(--color-red-600) 88%, transparent)) drop-shadow(0 0 22px color-mix(in oklab, var(--color-amber-500) 32%, transparent));
          }
        }

        @keyframes exoriHoverPulse {
          0%, 100% {
            transform: scale(1);
            filter: drop-shadow(0 0 12px color-mix(in oklab, var(--color-red-600) 95%, transparent)) drop-shadow(0 0 24px color-mix(in oklab, var(--color-red-600) 45%, transparent));
          }
          50% {
            transform: scale(1.045);
            filter: drop-shadow(0 0 18px var(--color-red-600)) drop-shadow(0 0 34px color-mix(in oklab, var(--color-amber-500) 55%, transparent));
          }
        }
      `}</style>
    </div>
  );
}

export default ExoriLogo;
