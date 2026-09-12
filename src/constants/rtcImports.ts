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
  /**
   * Tipos de código que ESTA divisão realmente possui. Ausente = todos
   * (`RTC_SLOT_TYPES`). Divisões finais (Last da Soul War e Bakragore da
   * Sanguine) só têm configuração de Boss — a linha "Acesso" nem existe,
   * então o card não a exibe (exigência do produto). É metadado de
   * ESTRUTURA/EXIBIÇÃO: chaves, códigos e persistência não mudam.
   */
  slots?: RtcSlotType[];
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
    // LAST só possui o próprio chefe — não existe código de Acesso.
    { id: "sw_last", label: "Last", slots: ["boss"] },
  ],
  sanguine: [
    { id: "sg_murcion", label: "Murcion", sublabel: "Cogumelos" },
    { id: "sg_chagorz", label: "Chagorz", sublabel: "Pilar" },
    { id: "sg_vemiath", label: "Vemiath", sublabel: "DarkLight" },
    { id: "sg_ichgahal", label: "Ichgahal", sublabel: "Casulo" },
    // Bakragore (Final) só possui o próprio chefe — sem código de Acesso.
    { id: "sg_bakragore", label: "Bakragore", sublabel: "Final", slots: ["boss"] },
  ],
};

/** Tipos de código exibidos para uma divisão (ausente = todos). */
export function rtcDivisionSlots(division: RtcDivision): RtcSlotType[] {
  return division.slots && division.slots.length > 0 ? division.slots : RTC_SLOT_TYPES;
}

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
 * Uma ENTRADA armazenada no mapa `entries` (três formas possíveis):
 *
 *   • PERFIL (chave "profile|quest|voc|id"): { profileName, code, colorIndex }
 *     — cadastrado no card "Códigos Usados"; fonte única dos códigos.
 *   • SELEÇÃO (chave "quest|voc|divisão|tipo"): { profileId }
 *     — referência ao perfil escolhido para aquele Boss/Acesso. Editar o
 *     perfil reflete automaticamente em todos os usos (só o id é gravado).
 *   • LEGADO (chave "quest|voc|divisão|tipo"): { profileName, code }
 *     — formato antigo (código inline por slot); apresentado por
 *     `buildRtcCombinationView` como perfil VIRTUAL na seleção (o conteúdo
 *     antigo continua visível/importável; regravar converge ao formato novo).
 *
 * `code` é TEXTO LITERAL: vírgulas, pontos, pipes, ponto e vírgula e qualquer
 * caractere especial são armazenados e copiados exatamente como digitados —
 * nenhuma normalização em nenhum ponto do fluxo.
 */
export interface RtcEntry {
  /** Nome do perfil (perfis e legado). */
  profileName?: string;
  /** Código RTC literal (perfis e legado). */
  code?: string;
  /** Referência ao perfil selecionado (seleções). */
  profileId?: string;
  /** Índice da cor de identidade do perfil (perfis). */
  colorIndex?: number;
  /** Última alteração (ms) — informativo. */
  updatedAtMs: number;
}

/** Mapa `chave composta → entrada` como persistido no Firestore. */
export type RtcEntryMap = Record<string, RtcEntry>;

/** Limites de sanidade (espelhados nas regras do Firestore). */
export const RTC_PROFILE_NAME_MAX = 60;
export const RTC_CODE_MAX = 4000;

/** Máximo de perfis no card "Códigos Usados" por Quest + Vocação + guia. */
export const RTC_MAX_PROFILES = 10;

/**
 * Chave composta de uma combinação Quest + Vocação + Divisão + Tipo.
 * É o identificador da SELEÇÃO dentro de `entries` — estável e legível
 * (ex.: "soulwar|EK|sw_brachio|acesso").
 */
export function buildRtcKey(quest: RtcQuest, voc: Vocation, divisionId: string, slot: RtcSlotType): string {
  return `${quest}|${voc}|${divisionId}|${slot}`;
}

// ============================================================================
// CÓDIGOS USADOS — PERFIS COMO FONTE ÚNICA
// ----------------------------------------------------------------------------
// Os perfis vivem no MESMO mapa `entries` dos documentos existentes, sob o
// prefixo "profile|" (o separador "|" garante que nunca colidem com chaves de
// seleção, que começam com a quest). Assim a persistência, as regras do
// Firestore e o custo (1 doc por escopo) permanecem EXATAMENTE os mesmos.
//
//   chave do perfil:  "profile|<quest>|<voc>|<id>"
//   valor:            { profileName, code, colorIndex, updatedAtMs }
//
//   chave da seleção: "<quest>|<voc>|<divisão>|<tipo>"   (inalterada)
//   valor:            { profileId: "<id>", updatedAtMs }
//
// Editar um perfil altera UMA chave; todos os Bosses que o referenciam
// refletem na hora (guardam só o id). A cor de identidade é o `colorIndex`
// persistido → o MESMO perfil tem a MESMA cor em qualquer uso e dispositivo.
// ============================================================================

/** Prefixo das chaves de perfil dentro de `entries`. */
export const RTC_PROFILE_PREFIX = "profile";

/** Um perfil do card "Códigos Usados", pronto para exibição. */
export interface RtcProfile {
  /** Id estável do perfil (sufixo da chave). */
  id: string;
  /** Chave completa no mapa `entries`. */
  key: string;
  profileName: string;
  code: string;
  /** Cor de identidade persistida (índice em RTC_CODE_HUES). */
  colorIndex: number;
  updatedAtMs: number;
}

/** Chave de um perfil "Códigos Usados" (por Quest + Vocação). */
export function buildRtcProfileKey(quest: RtcQuest, voc: Vocation, profileId: string): string {
  return `${RTC_PROFILE_PREFIX}|${quest}|${voc}|${profileId}`;
}

/** Gera um id de perfil estável e único (timestamp + sufixo aleatório). */
export function newRtcProfileId(): string {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Visão consolidada de uma combinação Quest + Vocação dentro de um mapa
 * `entries`: perfis do card "Códigos Usados" + seleção efetiva por slot.
 */
export interface RtcCombinationView {
  /** Perfis da combinação, em ordem de criação (updatedAtMs asc, id desempata). */
  profiles: RtcProfile[];
  /** Perfil efetivo de cada chave de seleção ("quest|voc|divisão|tipo"). */
  selections: Record<string, RtcProfile>;
}

/**
 * Monta a visão da combinação a partir do mapa cru, ABSORVENDO O LEGADO:
 * entradas antigas de slot com { profileName, code } inline (sem profileId)
 * são apresentadas como um perfil "virtual" derivado — o usuário vê o mesmo
 * conteúdo de antes e, ao regravar, o dado converge para o formato novo.
 * Função PURA (testável em Node); não escreve nada.
 */
export function buildRtcCombinationView(entries: RtcEntryMap, quest: RtcQuest, voc: Vocation): RtcCombinationView {
  const profilePrefix = `${RTC_PROFILE_PREFIX}|${quest}|${voc}|`;
  const byId = new Map<string, RtcProfile>();

  Object.entries(entries).forEach(([key, entry]) => {
    if (!key.startsWith(profilePrefix)) return;
    const id = key.slice(profilePrefix.length);
    if (!id || !entry || typeof entry.profileName !== "string" || typeof entry.code !== "string") return;
    byId.set(id, {
      id,
      key,
      profileName: entry.profileName,
      code: entry.code,
      colorIndex: typeof entry.colorIndex === "number" && Number.isFinite(entry.colorIndex)
        ? Math.abs(Math.trunc(entry.colorIndex)) % RTC_CODE_HUES.length
        : 0,
      updatedAtMs: entry.updatedAtMs || 0,
    });
  });

  const selections: Record<string, RtcProfile> = {};
  const selectionPrefix = `${quest}|${voc}|`;
  Object.entries(entries).forEach(([key, entry]) => {
    if (!key.startsWith(selectionPrefix) || !entry) return;
    if (typeof entry.profileId === "string" && entry.profileId) {
      const profile = byId.get(entry.profileId);
      if (profile) selections[key] = profile; // referência viva: edições refletem
      return;
    }
    // LEGADO: código inline no slot → perfil virtual (id derivado da chave,
    // cor determinística pelo código para manter a identidade anterior).
    if (typeof entry.profileName === "string" && typeof entry.code === "string" && entry.code) {
      selections[key] = {
        id: `legacy|${key}`,
        key,
        profileName: entry.profileName,
        code: entry.code,
        colorIndex: rtcCodeColorIndex(entry.code),
        updatedAtMs: entry.updatedAtMs || 0,
      };
    }
  });

  const profiles = Array.from(byId.values()).sort(
    (a, b) => (a.updatedAtMs - b.updatedAtMs) || a.id.localeCompare(b.id),
  );
  return { profiles, selections };
}

/**
 * Menor índice de cor ainda livre na lista de perfis (novo perfil ganha a
 * primeira cor disponível; com as 12 ocupadas, recicla pela contagem).
 */
export function nextRtcColorIndex(profiles: RtcProfile[]): number {
  const used = new Set(profiles.map(p => p.colorIndex));
  for (let i = 0; i < RTC_CODE_HUES.length; i++) {
    if (!used.has(i)) return i;
  }
  return profiles.length % RTC_CODE_HUES.length;
}

/**
 * Valida/normaliza um mapa `entries` vindo do Firestore. Defensivo: ignora
 * chaves não-string, entradas sem forma esperada e trunca campos acima dos
 * limites (sem alterar o CONTEÚDO dentro do limite — código continua literal).
 * Aceita as três formas de entrada: perfil, seleção (profileId) e legado.
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
    const profileId = typeof entry.profileId === "string" ? entry.profileId.slice(0, 60) : "";
    if (!profileName && !code && !profileId) return;
    const sanitized: RtcEntry = {
      updatedAtMs: typeof entry.updatedAtMs === "number" && Number.isFinite(entry.updatedAtMs) ? entry.updatedAtMs : 0,
    };
    if (profileName) sanitized.profileName = profileName;
    if (code) sanitized.code = code;
    if (profileId) sanitized.profileId = profileId;
    if (typeof entry.colorIndex === "number" && Number.isFinite(entry.colorIndex)) {
      sanitized.colorIndex = Math.abs(Math.trunc(entry.colorIndex)) % RTC_CODE_HUES.length;
    }
    out[key] = sanitized;
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

/** Índice determinístico de cor para entradas LEGADAS (sem colorIndex). */
export function rtcCodeColorIndex(code: string): number {
  return fnv1a(code) % RTC_CODE_HUES.length;
}
