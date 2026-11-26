// ============================================================================
// IDENTIDADE VISUAL DE SERVIDORES (125ª) — componentes compartilhados
// ----------------------------------------------------------------------------
// Fonte única de APRESENTAÇÃO dos servidores em todo o aplicativo, em cima da
// fonte única de DADOS (src/constants/servers.ts — SERVER_META/cores):
//
//   • <ServerNameBadge>: nome colorido pela categoria de PVP (PVP = rosa,
//     Retro PVP = âmbar, Non PVP = esmeralda) + ícone pequeno e discreto de
//     transferência (cadeado aberto/fechado) com tooltip explicativo.
//   • <ServerSelectOptions>: opções para <select> nativo, agrupadas por
//     categoria de PVP (<optgroup> colorido) e com o indicador compacto de
//     transferência no rótulo (▲ aberta / 🔒 fechada via caracteres, já que
//     <option> não renderiza SVG).
//
// Servidores inválidos/aposentados NUNCA aparecem aqui (serverLabel devolve
// vazio para eles) — o badge mostra "—".
// ============================================================================
import { Lock, Unlock } from "lucide-react";
import type { CSSProperties } from "react";
import {
  SERVER_OPTIONS,
  SERVER_PVP_TYPE_COLORS,
  SERVER_PVP_TYPE_ORDER,
  getServerMeta,
  serverLabel,
} from "../constants/servers";

/** Sufixo compacto de transferência para <option> nativo (sem SVG). */
const OPTION_TRANSFER_SUFFIX = { open: " ·🔓", closed: " ·🔒" } as const;

/**
 * Nome do servidor com a cor da categoria + cadeado discreto da
 * transferência. Valor inválido/aposentado → "—" (nome antigo nunca
 * aparece). `plainColor` desliga a cor (contextos com cor própria),
 * mantendo só o ícone.
 */
export function ServerNameBadge({ server, className = "", nameClassName = "", iconSize = 9, plainColor = false }: {
  server: string | null | undefined;
  className?: string;
  nameClassName?: string;
  iconSize?: number;
  plainColor?: boolean;
}) {
  const label = serverLabel(server);
  if (!label) {
    return <span className={`text-slate-600 ${className}`} title="Servidor não definido — edite o cadastro e selecione um servidor da lista oficial">—</span>;
  }
  const meta = getServerMeta(label);
  const colors = meta ? SERVER_PVP_TYPE_COLORS[meta.pvpType] : null;
  return (
    <span
      className={`inline-flex items-center gap-1 min-w-0 ${className}`}
      title={meta ? `${label} — ${meta.pvpType} · transferência ${meta.transferOpen ? "aberta" : "fechada"}` : label}
    >
      <span className={`truncate ${plainColor ? "" : colors ? colors.text : ""} ${nameClassName}`}>{label}</span>
      {meta && (meta.transferOpen
        ? <Unlock size={iconSize} className="flex-shrink-0 text-emerald-400/80" aria-label="Transferência aberta" />
        : <Lock size={iconSize} className="flex-shrink-0 text-red-400/70" aria-label="Transferência fechada" />)}
    </span>
  );
}

/**
 * Opções de servidor para <select> nativo: um <optgroup> por categoria de
 * PVP (ordem canônica: PVP, Retro PVP, Non PVP), cada grupo com a cor da
 * categoria e cada opção com o indicador compacto de transferência.
 *
 * `servers` restringe a lista (padrão: todos os oficiais); `labelOf`
 * permite sufixos por contexto (ex.: contagem de itens); `optionStyle`
 * complementa o estilo das <option> (ex.: fundo escuro de um tema).
 */
export function ServerSelectOptions({ servers = SERVER_OPTIONS, labelOf, optionClassName = "", optionStyle }: {
  servers?: string[];
  labelOf?: (server: string) => string;
  optionClassName?: string;
  optionStyle?: CSSProperties;
}) {
  // Só servidores oficiais entram (inválidos/aposentados ficam de fora).
  const official = servers.map(s => serverLabel(s)).filter(Boolean);
  return (
    <>
      {SERVER_PVP_TYPE_ORDER.map(pvpType => {
        const group = official.filter(s => getServerMeta(s)?.pvpType === pvpType);
        if (group.length === 0) return null;
        const hex = SERVER_PVP_TYPE_COLORS[pvpType].optionHex;
        return (
          <optgroup key={pvpType} label={`— ${pvpType} —`} style={{ color: hex, ...optionStyle }}>
            {group.map(server => {
              const meta = getServerMeta(server);
              return (
                <option
                  key={server}
                  value={server}
                  className={optionClassName}
                  style={{ color: hex, ...optionStyle }}
                  title={meta ? `${server} — ${pvpType} · transferência ${meta.transferOpen ? "aberta" : "fechada"}` : server}
                >
                  {(labelOf ? labelOf(server) : server) + (meta ? (meta.transferOpen ? OPTION_TRANSFER_SUFFIX.open : OPTION_TRANSFER_SUFFIX.closed) : "")}
                </option>
              );
            })}
          </optgroup>
        );
      })}
    </>
  );
}
