// ============================================================================
// LINKS OFICIAIS DO RUBINOT
// ----------------------------------------------------------------------------
// Fonte única da URL da página oficial de um personagem no RubinOT, usada
// pelos botões "Link" (ServiceList do Gerenciador de PT's, guia Services e
// guia Meus Services).
//
// O nome é sempre codificado com encodeURIComponent, que cobre espaços,
// acentos, apóstrofos e demais caracteres especiais permitidos em nomes de
// personagem — ex.: "Redrix Arquero" →
// https://rubinot.com.br/characters?name=Redrix%20Arquero
// ============================================================================

const RUBINOT_CHARACTERS_URL = "https://rubinot.com.br/characters";

/**
 * Monta a URL da página oficial do personagem no RubinOT a partir do nome
 * real. Retorna string vazia quando não há nome — o chamador decide não
 * renderizar/abrir nada nesse caso.
 */
export function rubinotCharacterUrl(characterName: string | null | undefined): string {
  const name = String(characterName ?? "").trim();
  if (!name) return "";
  return `${RUBINOT_CHARACTERS_URL}?name=${encodeURIComponent(name)}`;
}
