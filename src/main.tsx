import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { AuthProvider } from "./context/AuthContext";
import { GlobalDataProvider } from "./context/GlobalDataContext";
import { UserStatsProvider } from "./context/UserStatsContext";
import { ThemeProvider } from "./theme/ThemeContext";
import PublicServiceForm from "./components/PublicServiceForm";

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