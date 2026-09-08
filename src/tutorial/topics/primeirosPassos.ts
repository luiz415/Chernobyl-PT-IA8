// ============================================================================
// TÓPICO: PRIMEIROS PASSOS
// ----------------------------------------------------------------------------
// Apresenta a estrutura geral do aplicativo: cabeçalho, janelas principais,
// guias privadas/públicas do Hub, notificações e o rodapé de ações.
// ============================================================================
import { Compass } from "lucide-react";
import type { TourTopic } from "../types";

const primeirosPassos: TourTopic = {
  id: "primeiros-passos",
  title: "Primeiros Passos",
  description: "Estrutura geral: cabeçalho, janelas, guias do Hub, notificações e rodapé.",
  tone: "amber",
  icon: Compass,
  scenes: [
    {
      id: "boas-vindas",
      title: "Bem-vindo ao Chernobyl PT!",
      body: "Este tutorial interativo apresenta as funcionalidades do aplicativo destacando os elementos REAIS da interface, cena por cena.\n\nUse os botões Avançar e Retroceder (ou as setas ← → do teclado) para navegar. Você pode sair a qualquer momento com Esc ou pelo botão ✕, e o seu progresso fica salvo por tópico.",
    },
    {
      id: "cabecalho",
      title: "Cabeçalho do aplicativo",
      anchor: "app-header",
      nav: [{ cmd: "window", arg: "characters" }],
      body: "O cabeçalho está sempre visível e concentra a identidade do app, o acesso às janelas principais e os avisos de notificações pendentes.\n\nÉ a partir dele que você alterna entre as grandes áreas do aplicativo.",
      fallbackBody: "O cabeçalho fica no topo da tela, sempre visível, e concentra o logo, o acesso às janelas principais e os avisos de notificações pendentes.",
    },
    {
      id: "janelas",
      title: "Janelas principais",
      anchor: "app-window-toggles",
      nav: [{ cmd: "window", arg: "characters" }],
      body: "Estes botões alternam entre as janelas do aplicativo:\n\n• Hub Principal — personagens, PTs, services e histórico;\n• Stats — suas estatísticas de desempenho;\n• Ranking — comparação mensal entre usuários;\n• Notas — bloco de anotações pessoal;\n• Bazaar — consulta de leilões de personagens.",
      fallbackBody: "Em telas maiores, os botões de janelas (Hub Principal, Stats, Ranking, Notas e Bazaar) ficam no cabeçalho; em telas menores, aparecem numa barra logo abaixo dele.",
    },
    {
      id: "notificacoes",
      title: "Central de Notificações",
      anchor: "app-logo-notif",
      body: "Clicar no logo abre a Central de Notificações: convites de PT, alterações de horário, pagamentos, avisos do Bazaar e muito mais.\n\nQuando houver notificações pendentes, um contador aparece sobre o logo — e um aviso também surge no centro do cabeçalho.",
      fallbackBody: "O logo do aplicativo (canto superior esquerdo) abre a Central de Notificações; um contador aparece sobre ele quando há avisos pendentes.",
    },
    {
      id: "guias-privadas",
      title: "Guias PRIVADAS do Hub",
      anchor: "hub-tabs-private",
      nav: [{ cmd: "window", arg: "characters" }],
      body: "As guias PRIVADAS mostram apenas os SEUS dados:\n\n• Meus Personagens — cadastro e gestão dos seus personagens;\n• Meus Services — seus personagens oferecidos como service;\n• Meu Histórico de PT's — registro pessoal das PTs concluídas.\n\nO botão de ajuda (?) ao lado traz um resumo rápido de cada guia.",
      fallbackBody: "Dentro do Hub Principal, o grupo de guias PRIVADO (Meus Personagens, Meus Services e Meu Histórico de PT's) mostra apenas os seus dados.",
    },
    {
      id: "guias-publicas",
      title: "Guias PÚBLICAS do Hub",
      anchor: "hub-tabs-public",
      nav: [{ cmd: "window", arg: "characters" }],
      body: "As guias PÚBLICAS são compartilhadas entre os usuários:\n\n• Gerenciador de PT's — criação e acompanhamento das PTs;\n• Services — fila de clientes aguardando service (exclusiva do Boss).\n\nO tópico \"Gerenciador de PTs\" deste tutorial explora essa área em detalhes.",
      fallbackBody: "Dentro do Hub Principal, o grupo de guias PÚBLICO concentra o Gerenciador de PT's e, para o Boss, a fila de Services.",
    },
    {
      id: "rodape",
      title: "Rodapé de ações",
      anchor: "footer-actions",
      body: "O rodapé reúne as ações de conta e utilitários:\n\n• Feedback — envie sugestões e reporte problemas;\n• Doação — colabore com o projeto (sua média atual aparece no botão);\n• Receber RC — configure o personagem principal para receber pagamentos;\n• Streaming — vincule seu canal da Twitch;\n• Amigos — gerencie amizades (solicitações pendentes pulsam em âmbar);\n• Sair — desconecta a conta.\n\nÀ esquerda ficam os ajustes de zoom do cabeçalho e do conteúdo.",
      fallbackBody: "O rodapé, na base da tela, reúne Feedback, Doação, Receber RC, Streaming, Amigos, Sair e os ajustes de zoom.",
    },
    {
      id: "conclusao",
      title: "Pronto para começar!",
      body: "Você já conhece a estrutura geral do aplicativo.\n\nVolte à lista de tópicos e explore os tutoriais de cada painel — o próximo passo recomendado é o tópico \"Gerenciador de PTs\", o coração do aplicativo.",
    },
  ],
};

export default primeirosPassos;
