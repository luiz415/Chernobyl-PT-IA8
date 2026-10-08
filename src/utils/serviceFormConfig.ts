// ============================================================================
// CONFIGURAÇÃO DO FORMULÁRIO PÚBLICO INDIVIDUAL — fonte única
//
// Cada serviceiro elegível pode personalizar o PRÓPRIO formulário público
// (o link exclusivo #/servico/{slug}) pelo modal "Configurar Meu Formulário"
// em Meus Services:
//
//   • habilitar/desabilitar os Services de Soul War e Sanguine — a
//     configuração do usuário é a ÚNICA fonte desse estado no formulário
//     (não existe mais bloqueio global fixo de Quest no código);
//   • informar um MOTIVO opcional da indisponibilidade de cada Quest
//     desabilitada — exibido no tooltip do formulário; sem motivo, o
//     formulário usa o aviso genérico padrão;
//   • definir os valores de cada Quest (Sanguine com valor da 1ª rotação e
//     de cada rotação posterior SEPARADOS);
//   • habilitar/desabilitar o SERVICE 50/50 — desabilitado, a modalidade
//     SOME do formulário (quadros da etapa de Termos e opção de pagamento),
//     nas DUAS quests; independente das demais configurações;
//   • definir o LEVEL MÍNIMO por vocação de cada Quest — exibido no
//     formulário e usado na validação do cadastro do personagem;
//   • escolher quais servidores atende — os demais continuam VISÍVEIS no
//     formulário como "Nome (Indisponível)", sem poderem ser selecionados.
//
// A configuração vive em `users/{uid}.serviceFormConfig` (campo opcional do
// documento que o PublicServiceForm JÁ carrega ao montar a lista de
// elegíveis — zero leituras extras) e é aplicada SOMENTE quando o formulário
// foi aberto pelo link exclusivo do dono (lockedTarget). O formulário geral
// e links sem configuração salva usam os padrões abaixo, que reproduzem
// EXATAMENTE os textos/valores originais do formulário.
//
// As demais informações do formulário (termos, regras, drops, 50/50, refil,
// acesso da Sanguine etc.) são institucionais e permanecem FIXAS — este
// módulo não as torna editáveis de propósito.
// ============================================================================

import { SERVER_OPTIONS, serverKey } from "../constants/servers";
import { VOCATIONS, type Vocation } from "../types";
import { PUBLIC_MIN_LEVELS, type PublicQuest } from "./publicServiceLevels";

/** Levels mínimos por vocação como persistidos (parciais/não confiáveis). */
export type ServiceFormMinLevels = Partial<Record<PublicQuest, Partial<Record<Vocation, number>>>>;

/** Forma persistida em `users/{uid}.serviceFormConfig` (todos opcionais). */
export interface ServiceFormConfig {
  /** Service de Soul War oferecido? (ausente = sim) */
  soulwarEnabled?: boolean;
  /** Service de Sanguine oferecido? (ausente = sim) */
  sanguineEnabled?: boolean;
  /**
   * Service 50/50 oferecido? (ausente = sim) Desabilitado, a modalidade é
   * ocultada do formulário nas duas quests (Termos e Pagamento) e deixa de
   * ser aceita como forma de pagamento. Independente das demais opções.
   */
  fiftyFiftyEnabled?: boolean;
  /** Motivo (opcional) da Soul War desabilitada — tooltip do formulário. */
  soulwarDisabledReason?: string;
  /** Motivo (opcional) da Sanguine desabilitada — tooltip do formulário. */
  sanguineDisabledReason?: string;
  /**
   * Level mínimo por Quest + vocação exibido/validado no formulário.
   * Parcial: combinações ausentes caem nos padrões (PUBLIC_MIN_LEVELS).
   */
  minLevels?: ServiceFormMinLevels;
  /** Soul War — valor em Rubini Coins. */
  swRc?: number;
  /** Soul War — valor do Pix em reais. */
  swPix?: number;
  /** Sanguine — 1ª rotação em Rubini Coins. */
  sgFirstRc?: number;
  /** Sanguine — 1ª rotação em reais (Pix). */
  sgFirstPix?: number;
  /** Sanguine — cada rotação posterior (sem drop) em Rubini Coins. */
  sgExtraRc?: number;
  /** Sanguine — cada rotação posterior (sem drop) em reais (Pix). */
  sgExtraPix?: number;
  /** Servidores atendidos (nomes oficiais). Ausente/vazio = todos. */
  servers?: string[];
  /** Momento da última gravação (Date.now()). */
  updatedAt?: number;
}

/** Forma resolvida (todos os campos presentes e saneados) usada pela UI. */
export interface ResolvedServiceFormConfig {
  soulwarEnabled: boolean;
  sanguineEnabled: boolean;
  /** Service 50/50 oferecido? false = modalidade oculta no formulário. */
  fiftyFiftyEnabled: boolean;
  /** "" = sem motivo informado (o formulário usa o aviso genérico). */
  soulwarDisabledReason: string;
  /** "" = sem motivo informado (o formulário usa o aviso genérico). */
  sanguineDisabledReason: string;
  swRc: number;
  swPix: number;
  sgFirstRc: number;
  sgFirstPix: number;
  sgExtraRc: number;
  sgExtraPix: number;
  /** Levels mínimos COMPLETOS por Quest + vocação (saneados). */
  minLevels: Record<PublicQuest, Record<Vocation, number>>;
  /** Sempre não-vazia; sem configuração = todos os servidores oficiais. */
  servers: string[];
}

/** Cópia profunda da tabela padrão de levels (nunca compartilhar referência). */
function defaultMinLevels(): Record<PublicQuest, Record<Vocation, number>> {
  return {
    soulwar: { ...PUBLIC_MIN_LEVELS.soulwar },
    sanguine: { ...PUBLIC_MIN_LEVELS.sanguine },
  };
}

/**
 * Padrões = valores originais do formulário público. NÃO alterar sem
 * atualizar também os textos de referência dos termos (eles nascem daqui).
 */
export const SERVICE_FORM_CONFIG_DEFAULTS: ResolvedServiceFormConfig = {
  soulwarEnabled: true,
  sanguineEnabled: true,
  fiftyFiftyEnabled: true,
  soulwarDisabledReason: "",
  sanguineDisabledReason: "",
  swRc: 1000,
  swPix: 91,
  sgFirstRc: 1000,
  sgFirstPix: 91,
  sgExtraRc: 400,
  sgExtraPix: 37,
  minLevels: defaultMinLevels(),
  servers: [...SERVER_OPTIONS],
};

/** Sufixo exibido no seletor de servidor para servidores não atendidos. */
export const UNAVAILABLE_SERVER_SUFFIX = " (Indisponível)";

/** Limites de sanidade — valores fora deles caem no padrão. */
const MAX_RC = 1_000_000;
const MAX_PIX = 100_000;
/** Level mínimo configurável: inteiro neste intervalo; fora dele = padrão. */
export const MIN_CONFIG_LEVEL = 1;
export const MAX_CONFIG_LEVEL = 50_000;
/** Tamanho máximo do motivo de indisponibilidade exibido no tooltip. */
export const MAX_DISABLED_REASON_LEN = 300;

/** RC: inteiro positivo dentro dos limites; qualquer outra coisa = fallback. */
function sanitizeRc(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : NaN;
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.round(n);
  if (rounded < 1 || rounded > MAX_RC) return fallback;
  return rounded;
}

/** Pix: positivo com até 2 casas decimais; qualquer outra coisa = fallback. */
function sanitizePix(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : NaN;
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.round(n * 100) / 100;
  if (rounded <= 0 || rounded > MAX_PIX) return fallback;
  return rounded;
}

/** Level: inteiro dentro dos limites; qualquer outra coisa = fallback. */
function sanitizeLevel(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : NaN;
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.round(n);
  if (rounded < MIN_CONFIG_LEVEL || rounded > MAX_CONFIG_LEVEL) return fallback;
  return rounded;
}

/** Motivo: string aparada e limitada; qualquer outra coisa = "". */
function sanitizeReason(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, MAX_DISABLED_REASON_LEN);
}

/** Tabela completa de levels: por combinação, valor salvo válido ou padrão. */
function resolveMinLevels(raw: ServiceFormMinLevels | undefined): Record<PublicQuest, Record<Vocation, number>> {
  const out = defaultMinLevels();
  if (!raw || typeof raw !== "object") return out;
  (Object.keys(out) as PublicQuest[]).forEach(quest => {
    const q = raw[quest];
    if (!q || typeof q !== "object") return;
    VOCATIONS.forEach(voc => {
      out[quest][voc] = sanitizeLevel(q[voc], out[quest][voc]);
    });
  });
  return out;
}

/**
 * Resolve a configuração BRUTA (vinda do Firestore/localStorage, portanto
 * não confiável) para a forma completa e saneada. `undefined`/malformado
 * resolve para os padrões — o formulário nunca quebra por dado ruim.
 *
 * Servidores: somente nomes que casam com a lista oficial (comparação via
 * `serverKey`, tolerante a caixa/alias) são aceitos, na ORDEM OFICIAL e sem
 * duplicatas. Lista vazia após o filtro = todos (nunca deixa o formulário
 * sem opção por dado corrompido).
 */
export function resolveServiceFormConfig(raw: unknown): ResolvedServiceFormConfig {
  const d = SERVICE_FORM_CONFIG_DEFAULTS;
  if (!raw || typeof raw !== "object") return d;
  const cfg = raw as ServiceFormConfig;

  let servers = d.servers;
  if (Array.isArray(cfg.servers) && cfg.servers.length > 0) {
    const wantedKeys = new Set(
      cfg.servers
        .filter((s): s is string => typeof s === "string")
        .map(s => serverKey(s))
        .filter(k => k !== "")
    );
    const filtered = SERVER_OPTIONS.filter(official => wantedKeys.has(serverKey(official)));
    if (filtered.length > 0) servers = filtered;
  }

  return {
    soulwarEnabled: cfg.soulwarEnabled !== false,
    sanguineEnabled: cfg.sanguineEnabled !== false,
    fiftyFiftyEnabled: cfg.fiftyFiftyEnabled !== false,
    soulwarDisabledReason: sanitizeReason(cfg.soulwarDisabledReason),
    sanguineDisabledReason: sanitizeReason(cfg.sanguineDisabledReason),
    swRc: sanitizeRc(cfg.swRc, d.swRc),
    swPix: sanitizePix(cfg.swPix, d.swPix),
    sgFirstRc: sanitizeRc(cfg.sgFirstRc, d.sgFirstRc),
    sgFirstPix: sanitizePix(cfg.sgFirstPix, d.sgFirstPix),
    sgExtraRc: sanitizeRc(cfg.sgExtraRc, d.sgExtraRc),
    sgExtraPix: sanitizePix(cfg.sgExtraPix, d.sgExtraPix),
    minLevels: resolveMinLevels(cfg.minLevels),
    servers,
  };
}

/** O serviceiro atende este servidor? (comparação tolerante via serverKey) */
export function isServerAttended(cfg: ResolvedServiceFormConfig, server: string): boolean {
  const key = serverKey(server);
  if (!key) return false;
  return cfg.servers.some(s => serverKey(s) === key);
}

// ─── Formatadores ────────────────────────────────────────────────────────────
// Reproduzem EXATAMENTE os textos originais do formulário quando aplicados
// aos padrões: 1000 → "1k" / "1 K"; 91 → "R$ 91,00" / "R$ 91"; 400 → "400";
// 37 → "R$ 37,00". Valores personalizados seguem as mesmas convenções.

/** Decimal pt-BR sem zeros à direita (1.5 → "1,5"; 2 → "2"). */
function ptDecimal(n: number): string {
  return n.toLocaleString("pt-BR", { maximumFractionDigits: 2 });
}

/** RC em texto corrido: 1000 → "1k", 1500 → "1,5k", 400 → "400". */
export function formatConfigRcLong(n: number): string {
  if (n >= 1000 && n % 100 === 0) return `${ptDecimal(n / 1000)}k`;
  return n.toLocaleString("pt-BR");
}

/** RC no card de pagamento (etapa 4): 1000 → "1 K", 1500 → "1,5 K", 400 → "400". */
export function formatConfigRcCard(n: number): string {
  if (n >= 1000 && n % 100 === 0) return `${ptDecimal(n / 1000)} K`;
  return n.toLocaleString("pt-BR");
}

/** Pix por extenso: 91 → "R$ 91,00"; 120.5 → "R$ 120,50". */
export function formatConfigPixLong(n: number): string {
  return `R$ ${n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Pix no card de pagamento (etapa 4): 91 → "R$ 91"; 91.5 → "R$ 91,50". */
export function formatConfigPixCard(n: number): string {
  if (Number.isInteger(n)) return `R$ ${n.toLocaleString("pt-BR")}`;
  return formatConfigPixLong(n);
}
