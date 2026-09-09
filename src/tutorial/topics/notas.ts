// ============================================================================
// TÓPICO: NOTAS
// ----------------------------------------------------------------------------
// Janela "Notas" (NotesPanel).
// ============================================================================
import { StickyNote } from "lucide-react";
import type { TourTopic } from "../types";

const NAV_NT = [{ cmd: "window", arg: "notes" }];

const notas: TourTopic = {
  id: "notas",
  title: "Notas",
  description: "Bloco pessoal para lembretes, combinações e organização rápida.",
  tone: "violet",
  icon: StickyNote,
  scenes: [
    {
      id: "visao-geral",
      title: "Seu bloco de anotações",
      anchor: "notes-root",
      nav: NAV_NT,
      padding: 0,
      body: "A janela [[violet:Notas]] é um bloco pessoal e [[amber:privado]] para o que você precisar: lembretes, combinações de PT, valores acertados, listas de espera informais...\n\nO conteúdo é [[emerald:salvo automaticamente]] e entra no seu backup pessoal (Exportar/Auto-Save) junto com os personagens.",
      fallbackBody: "Clique no botão [[violet:Notas]] no cabeçalho para abrir o bloco de anotações pessoal, salvo automaticamente.",
    },
    {
      id: "conclusao",
      title: "Tópico concluído!",
      body: "Simples assim: escreva e está salvo.\n\nDica: use as Notas para rascunhar combinações antes de criar a PT no [[emerald:Gerenciador de PTs]].",
    },
  ],
};

export default notas;
