/**
 * ============================================================================
 * THEMES — fonte única de verdade (lado JS)
 * ----------------------------------------------------------------------------
 * As cores em si vivem em `src/theme.css`. Este arquivo apenas descreve os
 * temas disponíveis (id, rótulo e amostras para a UI de seleção).
 *
 * Para adicionar um tema novo:
 *   1. Adicione o bloco `[data-theme="<id>"]` em `src/theme.css`.
 *   2. Adicione uma entrada em THEMES abaixo com o mesmo id.
 * Nada mais precisa ser alterado em nenhum componente.
 * ============================================================================
 */

export const THEME_IDS = [
  "ember",
  "forest",
  "graphite",
  "ash",
  "cyberpunk",
  "frost",
  "coffee",
] as const;

export type ThemeId = (typeof THEME_IDS)[number];

export const DEFAULT_THEME: ThemeId = "ember";

/** Chave usada no localStorage. */
export const THEME_STORAGE_KEY = "chernobyl_theme";

/** Atributo aplicado em <html> que ativa a paleta no CSS. */
export const THEME_ATTRIBUTE = "data-theme";

export interface ThemeDefinition {
  id: ThemeId;
  /** Nome curto exibido na UI. */
  label: string;
  /** Descrição auxiliar exibida na UI. */
  description: string;
  /**
   * Cores apenas para as bolinhas de preview do seletor.
   * Não são usadas para renderizar o app — são espelhos estáticos dos
   * tokens correspondentes, para evitar depender de estado do DOM.
   */
  swatches: {
    surface: string;
    line: string;
    brand: string;
    accent: string;
  };
}

export const THEMES: readonly ThemeDefinition[] = [
  {
    id: "ember",
    label: "Vermelho Queimado",
    description: "Tema clássico do Chernobyl PT — vermelho queimado e dourado.",
    swatches: {
      surface: "oklch(14.6% 0.021 21)",
      line: "oklch(27.2% 0.091 21)",
      brand: "oklch(39.6% 0.141 25.7)",
      accent: "oklch(76.9% 0.188 70.1)",
    },
  },
  {
    id: "forest",
    label: "Verde Escuro",
    description: "Superfícies em verde profundo com destaques em lima.",
    swatches: {
      surface: "oklch(14.6% 0.017 155)",
      line: "oklch(27.2% 0.073 155)",
      brand: "oklch(39.6% 0.110 153.7)",
      accent: "oklch(76.9% 0.160 132.1)",
    },
  },
  {
    id: "graphite",
    label: "Grafite Monocromático",
    description: "Preto, grafite e prata — neutro e elegante, sem cor.",
    swatches: {
      surface: "oklch(14.77% 0.001 19.8)",
      line: "oklch(27.171% 0.005 25.7)",
      brand: "oklch(39.6% 0.014 25.7)",
      accent: "oklch(76.9% 0.019 70.1)",
    },
  },
  {
    id: "ash",
    label: "Sangue e Cinzas",
    description: "Preto acinzentado com vermelho escuro, discreto e sóbrio.",
    swatches: {
      surface: "oklch(14.77% 0.011 19.8)",
      line: "oklch(27.171% 0.050 25.7)",
      brand: "oklch(39.6% 0.102 25.7)",
      accent: "oklch(76.9% 0.079 50.1)",
    },
  },
  {
    id: "cyberpunk",
    label: "Cyberpunk",
    description: "Azul-violeta muito escuro com detalhes magenta.",
    swatches: {
      surface: "oklch(14.77% 0.015 284.8)",
      line: "oklch(27.171% 0.068 290.7)",
      brand: "oklch(39.6% 0.113 325.7)",
      accent: "oklch(76.9% 0.132 315.1)",
    },
  },
  {
    id: "frost",
    label: "Gelo Noturno",
    description: "Azul-marinho quase preto com detalhes em azul-claro frio.",
    swatches: {
      surface: "oklch(14.77% 0.014 249.8)",
      line: "oklch(27.171% 0.064 255.7)",
      brand: "oklch(39.6% 0.099 230.7)",
      accent: "oklch(76.9% 0.117 230.1)",
    },
  },
  {
    id: "coffee",
    label: "Café",
    description: "Marrom muito escuro com detalhes âmbar.",
    swatches: {
      surface: "oklch(14.77% 0.015 64.8)",
      line: "oklch(27.171% 0.068 70.7)",
      brand: "oklch(39.6% 0.087 55.7)",
      accent: "oklch(76.9% 0.179 65.1)",
    },
  },
] as const;

const THEME_ID_SET = new Set<string>(THEME_IDS);

/** Converte qualquer valor em um ThemeId válido. */
export function normalizeThemeId(value: unknown): ThemeId {
  return typeof value === "string" && THEME_ID_SET.has(value)
    ? (value as ThemeId)
    : DEFAULT_THEME;
}

export function getThemeDefinition(id: ThemeId): ThemeDefinition {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

/** Lê o tema salvo. Seguro em ambientes sem localStorage. */
export function readStoredTheme(): ThemeId {
  try {
    return normalizeThemeId(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME;
  }
}

/** Persiste o tema. Silencioso em caso de falha (modo privado/Electron). */
export function writeStoredTheme(id: ThemeId): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, id);
  } catch {
    /* ignora */
  }
}

/**
 * Aplica o tema no documento informado.
 * Recebe `doc` para que janelas externas (window.open / portais) possam ser
 * sincronizadas com a mesma função.
 */
export function applyThemeToDocument(id: ThemeId, doc: Document = document): void {
  doc.documentElement.setAttribute(THEME_ATTRIBUTE, id);
}
