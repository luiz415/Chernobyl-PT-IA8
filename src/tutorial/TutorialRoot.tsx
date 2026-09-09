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
import TutorialWelcome from "./TutorialWelcome";

export default function TutorialRoot({ children }: { children: ReactNode }) {
  const { currentUser, userProfile } = useAuth();
  // O uid só é repassado com o perfil APROVADO — garante que o modal de
  // boas-vindas nunca abre por cima da tela de login/aprovação pendente.
  const approvedUid = currentUser?.uid && userProfile?.status === "aprovado" ? currentUser.uid : "";
  return (
    <TutorialProvider isBoss={userProfile?.role === "Boss"} uid={approvedUid} userName={userProfile?.nome || currentUser?.displayName || ""}>
      {children}
      <TutorialOverlay />
      <TutorialMenu />
      <TutorialWelcome />
    </TutorialProvider>
  );
}
