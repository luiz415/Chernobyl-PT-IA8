// ============================================================================
// TUTORIAL — RAIZ DE MONTAGEM
// ----------------------------------------------------------------------------
// Envolve o <App/> (em main.tsx) com o TutorialProvider — alimentado pelo
// papel e uid do usuário logado — e monta o overlay do tour + o menu de
// tópicos (ambos portais para o <body>, sem impacto no layout do app).
//
// Fica ACIMA do App para que qualquer componente (rodapé, painéis) possa usar
// useTutorial() sem novos fios de props.
// ============================================================================
import type { ReactNode } from "react";
import { useAuth } from "../context/AuthContext";
import { TutorialProvider } from "./TutorialContext";
import TutorialOverlay from "./TutorialOverlay";
import TutorialMenu from "./TutorialMenu";

export default function TutorialRoot({ children }: { children: ReactNode }) {
  const { currentUser, userProfile } = useAuth();
  return (
    <TutorialProvider isBoss={userProfile?.role === "Boss"} uid={currentUser?.uid || ""}>
      {children}
      <TutorialOverlay />
      <TutorialMenu />
    </TutorialProvider>
  );
}
