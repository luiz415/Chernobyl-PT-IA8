/**
 * bazaarCharacterDescription.ts
 * -----------------------------
 * MINI DESCRIÇÃO do personagem do Bazaar (81ª tarefa) — texto copiado ao
 * CLICAR COM O BOTÃO DIREITO sobre o nome do personagem no Painel Bazaar
 * (guias "Personagens Para SW/SG/GB" e "Personagens Com Itens").
 *
 * FORMATO (pontuação/espaços/quebra conforme definição do produto):
 *
 *   King Slayer, EK 845, Lunarian, encerra às 09:45 30/10.
 *
 *   https://rubinot.com.br/bazaar/304397
 *
 * FONTE ÚNICA: as duas guias montam o texto por esta função — mesmos dados
 * reais da linha (nome, vocação, level, servidor, encerramento e ID do
 * anúncio), nenhuma consulta nova.
 *
 * REGRAS:
 *   • O link usa SEMPRE o ID REAL do anúncio (extractBazaarAuctionId sobre a
 *     URL da consulta, com o id da linha como fallback) — NUNCA derivado do
 *     nome. Sem ID ⇒ a geração FALHA (nenhum link inválido é copiado).
 *   • Sem nome ⇒ falha (não há o que descrever).
 *   • Demais partes (vocação/level, servidor, encerramento) são OMITIDAS
 *     quando indisponíveis — nenhum dado é inventado ("—", "?", etc.).
 *   • Encerramento em "HH:MM DD/MM" no MESMO fuso configurado do painel
 *     (offsetMinutes) — mesma matemática do formatAuctionEnd da coluna
 *     "Encerra" (normalizeAuctionEndTimestamp + deslocamento em UTC).
 *
 * FUNÇÕES PURAS — testáveis em Node. A cópia em si usa o helper único
 * copyTextToClipboard (src/utils/clipboard) nos componentes.
 */

import { normalizeAuctionEndTimestamp } from "./bazaarTime";
import { extractBazaarAuctionId } from "./bazaarBid";

/** Base do link direto do anúncio — o ID real é concatenado ao final. */
export const BAZAAR_CHARACTER_PAGE_BASE_URL = "https://rubinot.com.br/bazaar/";

/**
 * Abreviação da vocação (mesma tabela do badge da coluna Vocação do Painel
 * Bazaar — o BazarPanel delega para cá; vocação não reconhecida volta como
 * veio, vazio vira vazio: a descrição simplesmente omite o segmento).
 */
export function vocationAbbreviation(vocation: string): string {
  const normalized = String(vocation || "").trim().toLowerCase();
  if (!normalized) return "";
  if (normalized === "elder druid" || normalized === "druid") return "ED";
  if (normalized === "elite knight" || normalized === "knight") return "EK";
  if (normalized === "master sorcerer" || normalized === "sorcerer") return "MS";
  if (normalized === "royal paladin" || normalized === "paladin") return "RP";
  if (normalized === "exalted monk" || normalized === "monk") return "MK";
  return String(vocation).trim();
}

/**
 * "HH:MM DD/MM" do encerramento no fuso configurado — MESMA matemática do
 * formatAuctionEnd (coluna "Encerra"), só com a ordem hora/data invertida.
 * Timestamp ausente/inválido ⇒ "" (o chamador omite o segmento).
 */
export function formatAuctionEndShort(ts: number | null | undefined, offsetMinutes: number): string {
  const normalizedTs = normalizeAuctionEndTimestamp(ts ?? null);
  if (!normalizedTs) return "";
  try {
    const shifted = new Date(normalizedTs * 1000 + offsetMinutes * 60 * 1000);
    const day = String(shifted.getUTCDate()).padStart(2, "0");
    const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
    const hour = String(shifted.getUTCHours()).padStart(2, "0");
    const minute = String(shifted.getUTCMinutes()).padStart(2, "0");
    return `${hour}:${minute} ${day}/${month}`;
  } catch {
    return "";
  }
}

/** Dados reais da linha do personagem — shape mínimo comum às duas guias. */
export interface BazaarCharacterDescriptionInput {
  name: string;
  vocation?: string;
  level?: number;
  server?: string;
  auctionEndTs?: number | null;
  url?: string;
  id?: string;
}

export type BazaarCharacterDescriptionResult =
  | { ok: true; text: string; auctionId: string }
  | { ok: false; error: string };

/**
 * Monta a mini descrição + link. Falha (sem copiar nada) quando o nome ou o
 * ID REAL do anúncio não estão disponíveis — nunca gera link inválido.
 */
export function buildBazaarCharacterDescription(
  input: BazaarCharacterDescriptionInput,
  offsetMinutes: number,
): BazaarCharacterDescriptionResult {
  const name = String(input?.name || "").trim();
  if (!name) return { ok: false, error: "Nome do personagem indisponível." };
  // ID REAL do anúncio: extraído da URL da consulta (último segmento
  // numérico), com o id da linha como fallback — NUNCA derivado do nome.
  const auctionId = extractBazaarAuctionId(input?.url, input?.id);
  if (!auctionId) return { ok: false, error: "ID do anúncio indisponível — link não gerado." };

  const abbreviation = vocationAbbreviation(String(input?.vocation || ""));
  const level = Number(input?.level || 0);
  const levelText = Number.isFinite(level) && level > 0 ? String(Math.floor(level)) : "";
  // "EK 845" (vocação + level); com só um dos dois disponíveis, usa o que há.
  const vocationSegment = [abbreviation, levelText].filter(Boolean).join(" ");
  const server = String(input?.server || "").trim();
  const endShort = formatAuctionEndShort(input?.auctionEndTs ?? null, offsetMinutes);

  const segments = [name];
  if (vocationSegment) segments.push(vocationSegment);
  if (server) segments.push(server);
  if (endShort) segments.push(`encerra às ${endShort}`);

  return {
    ok: true,
    auctionId,
    text: `${segments.join(", ")}.\n\n${BAZAAR_CHARACTER_PAGE_BASE_URL}${auctionId}`,
  };
}
