import type { Vocation } from "../types";

// ============================================================================
// IMPORT RTC — CATÁLOGO DE QUESTS, DIVISÕES E TIPOS
// ----------------------------------------------------------------------------
// Fonte única da ESTRUTURA do sistema Import RTC (modal "Import RTC" no
// cabeçalho do app). Os CÓDIGOS em si vivem no Firestore:
//
//   • rtcImports/recommended  → perfis RECOMENDADOS (todos leem, só Boss edita);
//   • userRtcImports/{uid}    → perfis PESSOAIS (cada usuário lê/edita os seus).
//
// MODELAGEM (escalável, exigência do produto):
//   Quest → Vocação → Divisão → Tipo (Acesso/Boss) → Perfil → Código
//
// Cada combinação vira UMA chave composta plana ("quest|voc|divisão|tipo") num
// mapa `entries` dentro do documento. Vantagens:
//   • 1 leitura carrega TODAS as combinações (nada de N docs);
//   • 1 escrita com merge atualiza só a chave alterada;
//   • adicionar Quest/vocação/divisão nova = acrescentar itens NESTE catálogo,
//     sem migração de dados nem coleção nova.
//
// O separador "|" é seguro: ids de divisão são gerados aqui (slug fixo) e
// quest/voc/tipo são enums — nenhum vem de entrada livre do usuário.
//
// Módulo puro (sem Firebase/JSX) — compilável e testável em Node.
// ============================================================================

/** Quests suportadas. Mesmo domínio de `PtType` (types.ts). */
export type RtcQuest = "soulwar" | "sanguine";

/**
 * Tipo do código dentro de uma divisão.
 * "boss" aqui é o CHEFE DO JOGO (Goshnar's, Bakragore...), nunca o cargo
 * Boss do aplicativo.
 */
export type RtcSlotType = "acesso" | "boss";

/** Uma divisão (etapa) de uma Quest no modal Import RTC. */
export interface RtcDivision {
  /** Identificador estável, gravado nas chaves do Firestore. NUNCA renomear. */
  id: string;
  /** Nome exibido. */
  label: string;
  /** Complemento/apelido da etapa (ex.: "Cogumelos"). */
  sublabel?: string;
}

/**
 * Divisões por Quest — ordem de exibição é a ordem do array.
 *
 * Soul War: nomes/na ordem definidos pelo produto (Brachio, Dark Thais,
 * Piranha, Rotten, Cloak, Last). Sanguine: nome do chefe + apelido da etapa.
 */
export const RTC_DIVISIONS: Record<RtcQuest, RtcDivision[]> = {
  soulwar: [
    { id: "sw_brachio", label: "Brachio" },
    { id: "sw_darkthais", label: "Dark Thais" },
    { id: "sw_piranha", label: "Piranha" },
    { id: "sw_rotten", label: "Rotten" },
    { id: "sw_cloak", label: "Cloak" },
    { id: "sw_last", label: "Last" },
  ],
  sanguine: [
    { id: "sg_murcion", label: "Murcion", sublabel: "Cogumelos" },
    { id: "sg_chagorz", label: "Chagorz", sublabel: "Pilar" },
    { id: "sg_vemiath", label: "Vemiath", sublabel: "DarkLight" },
    { id: "sg_ichgahal", label: "Ichgahal", sublabel: "Casulo" },
    { id: "sg_bakragore", label: "Bakragore", sublabel: "Final" },
  ],
};

/** Rótulos das Quests no modal. */
export const RTC_QUEST_LABELS: Record<RtcQuest, string> = {
  soulwar: "Soul War",
  sanguine: "Sanguine",
};

/** Rótulos dos tipos de código. */
export const RTC_SLOT_LABELS: Record<RtcSlotType, string> = {
  acesso: "Acesso",
  boss: "Boss",
};

/** Ordem fixa dos tipos dentro de cada divisão. */
export const RTC_SLOT_TYPES: RtcSlotType[] = ["acesso", "boss"];

/**
 * Um perfil configurado (recomendado ou pessoal) para uma combinação.
 * `code` é TEXTO LITERAL: vírgulas, pontos, pipes, ponto e vírgula e qualquer
 * caractere especial são armazenados e copiados exatamente como digitados —
 * nenhuma normalização em nenhum ponto do fluxo.
 */
export interface RtcEntry {
  /** Nome do perfil (ex.: "Full DPS", "Tank padrão"). */
  profileName: string;
  /** Código RTC literal. */
  code: string;
  /** Última alteração (ms) — informativo. */
  updatedAtMs: number;
}

/** Mapa `chave composta → perfil` como persistido no Firestore. */
export type RtcEntryMap = Record<string, RtcEntry>;

/** Limites de sanidade (espelhados nas regras do Firestore). */
export const RTC_PROFILE_NAME_MAX = 60;
export const RTC_CODE_MAX = 4000;

/**
 * Chave composta de uma combinação Quest + Vocação + Divisão + Tipo.
 * É o identificador do perfil dentro de `entries` — estável e legível
 * (ex.: "soulwar|EK|sw_brachio|acesso").
 */
export function buildRtcKey(quest: RtcQuest, voc: Vocation, divisionId: string, slot: RtcSlotType): string {
  return `${quest}|${voc}|${divisionId}|${slot}`;
}

/**
 * Valida/normaliza um mapa `entries` vindo do Firestore. Defensivo: ignora
 * chaves não-string, entradas sem forma esperada e trunca campos acima dos
 * limites (sem alterar o CONTEÚDO dentro do limite — código continua literal).
 */
export function sanitizeRtcEntryMap(raw: unknown): RtcEntryMap {
  const out: RtcEntryMap = {};
  if (!raw || typeof raw !== "object") return out;
  Object.entries(raw as Record<string, unknown>).forEach(([key, value]) => {
    if (typeof key !== "string" || !key || key.length > 120) return;
    if (!value || typeof value !== "object") return;
    const entry = value as Partial<RtcEntry>;
    const profileName = typeof entry.profileName === "string" ? entry.profileName.slice(0, RTC_PROFILE_NAME_MAX) : "";
    const code = typeof entry.code === "string" ? entry.code.slice(0, RTC_CODE_MAX) : "";
    if (!profileName && !code) return;
    out[key] = {
      profileName,
      code,
      updatedAtMs: typeof entry.updatedAtMs === "number" && Number.isFinite(entry.updatedAtMs) ? entry.updatedAtMs : 0,
    };
  });
  return out;
}

// ============================================================================
// IDENTIDADE VISUAL POR CÓDIGO
// ----------------------------------------------------------------------------
// Exigência do produto: quando o MESMO código RTC aparece em mais de um lugar
// do modal, os botões de copiar devem ter a MESMA cor/identidade — permitindo
// reconhecer visualmente códigos iguais. Códigos diferentes tendem a receber
// cores diferentes.
//
// Implementação: hash determinístico (FNV-1a) do código literal → índice numa
// paleta fixa de matizes bem distintos. O mesmo código SEMPRE cai na mesma
// cor, em qualquer parte do modal, em qualquer dispositivo.
// ============================================================================

/** Paleta de matizes dos botões de copiar (cores visualmente distintas). */
export const RTC_CODE_HUES: string[] = [
  "#f59e0b", // âmbar
  "#22d3ee", // ciano
  "#a855f7", // violeta
  "#34d399", // esmeralda
  "#f43f5e", // rosa
  "#3b82f6", // azul
  "#eab308", // amarelo
  "#fb923c", // laranja
  "#2dd4bf", // teal
  "#c084fc", // lilás
  "#84cc16", // lima
  "#38bdf8", // céu
];

/** Hash FNV-1a de 32 bits — determinístico e barato. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Cor de identidade de um código RTC (mesmo código → mesma cor, sempre). */
export function rtcCodeHue(code: string): string {
  return RTC_CODE_HUES[fnv1a(code) % RTC_CODE_HUES.length];
}
