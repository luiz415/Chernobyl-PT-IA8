import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// BUILD DO ELECTRON — arquivo único (comportamento ORIGINAL preservado)
// ----------------------------------------------------------------------------
// O app instalado carrega a página via file:// (loadFile). Nesse protocolo,
// <script type="module" src="..."> externo é bloqueado por CORS no Chromium —
// por isso o Electron CONTINUA usando vite-plugin-singlefile (todo o JS
// embutido no index.html), exatamente como antes da otimização web.
//
// A otimização de performance separou os builds:
//   • Web (vite.config.ts / `npm run build`): chunks com hash + lazy loading
//     + cache de longa duração no Firebase Hosting;
//   • Electron (este arquivo): usado pelos scripts `electron`,
//     `build:electron` e `publish` — instalador e fluxo intactos.
//
// `inlineDynamicImports` é OBRIGATÓRIO aqui: o código agora usa React.lazy
// (import() dinâmico) para o carregamento sob demanda na web; no Electron
// esses imports são embutidos no bundle único e resolvem imediatamente.
// ============================================================================
export default defineConfig({
  // Caminhos RELATIVOS nos assets gerados (file:// resolve relativo ao
  // próprio index.html — ver comentário original em vite.config.ts).
  base: "./",

  // As imagens de fundo ficam como arquivos separados (sem base64 inline),
  // mantendo o HTML enxuto e cacheável por arquivo.
  build: {
    assetsInlineLimit: 0,
    // Sem subpasta: o Vite calcula os caminhos de `new URL(...)` relativos a
    // assetsDir. Mantendo-o vazio, não é gerado o prefixo "../".
    assetsDir: "",
    rollupOptions: {
      output: {
        // Assets na RAIZ do dist, ao lado do index.html (com o JS embutido
        // no HTML, `import.meta.url` passa a ser o próprio index.html e a
        // imagem precisa estar na MESMA pasta que ele).
        assetFileNames: "[name]-[hash][extname]",
        // Embute os import() dinâmicos (React.lazy) no bundle único.
        inlineDynamicImports: true,
      },
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    viteSingleFile({ useRecommendedBuildConfig: false, removeViteModuleLoader: true }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
