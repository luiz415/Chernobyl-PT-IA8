import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// BUILD WEB (Firebase Hosting) — chunks com hash + carregamento sob demanda
// ----------------------------------------------------------------------------
// Antes da otimização de performance, este config usava vite-plugin-singlefile
// e TODO o app (JS+CSS ≈ 3,5 MB / 800 KB gzip) era embutido num único
// index.html — impossível de cachear (o HTML de um SPA precisa revalidar
// sempre) e sem divisão de código.
//
// Agora o build web é o padrão do Vite:
//   • index.html minúsculo (no-cache — atualizações chegam na hora);
//   • JS/CSS em /assets com HASH no nome → Cache-Control immutable de 1 ano
//     (firebase.json): revisitas não baixam nada que não mudou;
//   • React.lazy + import() dividem painéis/modais pesados em chunks
//     baixados apenas quando o usuário os abre;
//   • vendor split (react / firebase) — mudanças no código do app não
//     invalidam o cache das bibliotecas.
//
// O ELECTRON continua com o build de arquivo único (file:// bloqueia módulos
// externos por CORS) — ver vite.config.electron.ts, usado pelos scripts
// `electron`, `build:electron` e `publish`. Instalador e fluxo intactos.
// ============================================================================
export default defineConfig({
  // Caminhos RELATIVOS nos assets gerados — inofensivo na web e obrigatório
  // no Electron; mantido idêntico nos dois builds por consistência.
  base: "./",

  build: {
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          // Bibliotecas estáveis em chunks próprios: o hash só muda quando a
          // dependência muda, preservando o cache do usuário entre deploys.
          if (id.includes("node_modules/firebase") || id.includes("node_modules/@firebase")) return "firebase";
          if (
            id.includes("node_modules/react-dom") ||
            id.includes("node_modules/react/") ||
            id.includes("node_modules/scheduler")
          ) {
            return "react";
          }
          return undefined;
        },
      },
    },
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
