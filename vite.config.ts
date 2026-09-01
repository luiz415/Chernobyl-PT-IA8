import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// https://vite.dev/config/
export default defineConfig({
  // Caminhos RELATIVOS nos assets gerados.
  //
  // No Electron instalado a página é carregada via file:// (loadFile), e nesse
  // protocolo um caminho absoluto como "/favicon.png" resolve para a RAIZ DO
  // DISCO (file:///C:/favicon.png) em vez da pasta do app — por isso as imagens
  // sumiam apenas na versão instalada.
  //
  // "./" mantém tudo funcionando em Web/Firebase e no Electron (dev e
  // instalado), pois o navegador resolve relativo ao próprio index.html.
  base: "./",

  // As imagens de fundo são grandes (~1,9 MB cada). Sem isto o
  // vite-plugin-singlefile as embutiria em base64 dentro do index.html,
  // inflando o arquivo de ~2,6 MB para ~13,5 MB. Mantendo-as como arquivos
  // separados, o HTML segue enxuto e o navegador consegue cachear cada imagem.
  build: {
    assetsInlineLimit: 0,
    // Sem subpasta: o Vite calcula os caminhos de `new URL(...)` relativos a
    // assetsDir. Mantendo-o vazio, não é gerado o prefixo "../".
    assetsDir: "",
    rollupOptions: {
      output: {
        // Assets na RAIZ do dist, ao lado do index.html.
        //
        // Motivo: com o JS embutido no HTML (vite-plugin-singlefile), o Vite
        // gera `new URL("arquivo-hash.png", import.meta.url)` — sempre só o
        // nome do arquivo. Como `import.meta.url` passa a ser o próprio
        // index.html, a imagem precisa estar na MESMA pasta que ele.
        // Se fosse para dist/assets/, o caminho não bateria.
        assetFileNames: "[name]-[hash][extname]",
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
