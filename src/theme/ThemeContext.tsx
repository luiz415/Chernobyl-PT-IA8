import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  DEFAULT_THEME,
  THEMES,
  applyThemeToDocument,
  getThemeDefinition,
  readStoredTheme,
  writeStoredTheme,
  type ThemeDefinition,
  type ThemeId,
} from "./themes";

interface ThemeContextValue {
  /** Tema ativo. */
  theme: ThemeId;
  /** Definição completa do tema ativo. */
  definition: ThemeDefinition;
  /** Todos os temas disponíveis (para renderizar o seletor). */
  themes: readonly ThemeDefinition[];
  /** Troca o tema — aplica e persiste imediatamente. */
  setTheme: (id: ThemeId) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Lista de documentos secundários (janelas abertas via window.open) que também
 * precisam refletir o tema. Registrada por `useSyncExternalDocumentTheme`.
 */
const externalDocuments = new Set<Document>();

/** Registra um documento externo para receber o tema. Retorna o cleanup. */
export function registerExternalDocument(doc: Document, theme: ThemeId): () => void {
  externalDocuments.add(doc);
  applyThemeToDocument(theme, doc);
  return () => {
    externalDocuments.delete(doc);
  };
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Inicializa já com o valor persistido para não haver "flash" de tema.
  const [theme, setThemeState] = useState<ThemeId>(() => readStoredTheme());

  const setTheme = useCallback((id: ThemeId) => {
    setThemeState(id);
    writeStoredTheme(id);
  }, []);

  // Aplica no documento principal e em todas as janelas externas registradas.
  useEffect(() => {
    applyThemeToDocument(theme);
    externalDocuments.forEach((doc) => {
      try {
        applyThemeToDocument(theme, doc);
      } catch {
        /* janela já fechada */
      }
    });
  }, [theme]);

  // Mantém múltiplas janelas/abas do app em sincronia.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== "chernobyl_theme") return;
      setThemeState(readStoredTheme());
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      definition: getThemeDefinition(theme),
      themes: THEMES,
      setTheme,
    }),
    [theme, setTheme]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (ctx) return ctx;
  // Fallback seguro: componentes renderizados fora do provider (ex.: telas
  // públicas) continuam funcionando com o tema padrão.
  return {
    theme: DEFAULT_THEME,
    definition: getThemeDefinition(DEFAULT_THEME),
    themes: THEMES,
    setTheme: () => {},
  };
}
