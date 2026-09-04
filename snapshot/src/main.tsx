import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { AuthProvider } from "./context/AuthContext";
import { GlobalDataProvider } from "./context/GlobalDataContext";
import { UserStatsProvider } from "./context/UserStatsContext";
import { ThemeProvider } from "./theme/ThemeContext";
import PublicServiceForm from "./components/PublicServiceForm";
import { installGlobalPulseSync } from "./utils/pulseSync";

// Sincroniza TODOS os efeitos de pulsação participantes (seletores de estágio
// das PTs + botões do rodapé) num único ciclo global ancorado em t=0 da
// página — elementos que começam a pulsar em momentos diferentes ainda assim
// pulsam em uníssono. Instalado uma única vez, antes do primeiro render.
installGlobalPulseSync();

//   https://SEU-DOMINIO.web.app/#/servico
//
// Qualquer outra URL renderiza o aplicativo normal (com Auth Gate).
// ============================================================================
const isPublicServicePage =
  window.location.hash.toLowerCase().startsWith("#/servico") ||
  new URLSearchParams(window.location.search).has("servico");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      {isPublicServicePage ? (
        <PublicServiceForm />
      ) : (
        <AuthProvider>
          <GlobalDataProvider>
            <UserStatsProvider>
              <App />
            </UserStatsProvider>
          </GlobalDataProvider>
        </AuthProvider>
      )}
    </ThemeProvider>
  </StrictMode>
);