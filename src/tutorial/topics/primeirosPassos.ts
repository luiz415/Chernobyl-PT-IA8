// ============================================================================
// TÓPICO: PRIMEIROS PASSOS
// ----------------------------------------------------------------------------
// Apresenta a estrutura geral do aplicativo: cabeçalho, janelas principais,
// guias privadas/públicas do Hub, notificações e o rodapé de ações.
// Textos usam o markup de cor [[tom:texto]] (ver types.ts).
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
      body: "Este tutorial interativo apresenta as funcionalidades do aplicativo destacando os elementos [[emerald:REAIS]] da interface, cena por cena.\n\nUse os botões [[emerald:Avançar]] e [[sky:Retroceder]] (ou as setas ← → do teclado) para navegar. Você pode sair a qualquer momento com [[rose:Esc]] ou pelo botão ✕, e o seu progresso fica salvo por tópico.",
    },
    {
      id: "cabecalho",
      title: "Cabeçalho do aplicativo",
      anchor: "app-header",
      nav: [{ cmd: "window", arg: "characters" }],
      body: "O cabeçalho está sempre visível e concentra a identidade do app, o acesso às [[amber:janelas principais]] e os avisos de [[rose:notificações pendentes]].\n\nÉ a partir dele que você alterna entre as grandes áreas do aplicativo.",
      fallbackBody: "O cabeçalho fica no topo da tela, sempre visível, e concentra o logo, o acesso às [[amber:janelas principais]] e os avisos de [[rose:notificações pendentes]].",
    },
    {
      id: "janelas",
      title: "Janelas principais",
      anchor: "app-window-toggles",
      nav: [{ cmd: "window", arg: "characters" }],
      body: "Estes botões alternam entre as janelas do aplicativo:\n\n• [[emerald:Hub Principal]] — personagens, PTs, services e histórico;\n• [[sky:Stats]] — suas estatísticas de desempenho;\n• [[amber:Ranking]] — comparação mensal entre usuários;\n• [[violet:Notas]] — bloco de anotações pessoal;\n• [[rose:Bazaar]] — consulta de leilões de personagens (painel exclusivo [[vip:VIP]]).",
      fallbackBody: "Em telas maiores, os botões de janelas ([[emerald:Hub Principal]], [[sky:Stats]], [[amber:Ranking]], [[violet:Notas]] e [[rose:Bazaar]]) ficam no cabeçalho; em telas menores, aparecem numa barra logo abaixo dele.",
    },
    {
      id: "notificacoes",
      title: "Central de Notificações",
      anchor: "app-logo-notif",
      body: "Clicar no logo abre a [[rose:Central de Notificações]]: convites de PT, alterações de horário, pagamentos, avisos do Bazaar e muito mais.\n\nQuando houver notificações pendentes, um [[amber:contador]] aparece sobre o logo — e um aviso também surge no centro do cabeçalho.",
      fallbackBody: "O logo do aplicativo (canto superior esquerdo) abre a [[rose:Central de Notificações]]; um [[amber:contador]] aparece sobre ele quando há avisos pendentes.",
    },
    {
      id: "guias-privadas",
      title: "Guias PRIVADAS do Hub",
      anchor: "hub-tabs-private",
      nav: [{ cmd: "window", arg: "characters" }],
      body: "As guias [[amber:PRIVADAS]] mostram apenas os SEUS dados:\n\n• [[emerald:Meus Personagens]] — cadastro e gestão dos seus personagens;\n• [[sky:Meus Services]] — seus personagens oferecidos como service;\n• [[amber:Meu Histórico de PT's]] — registro pessoal das PTs concluídas.\n\nO botão de ajuda (?) ao lado traz um resumo rápido de cada guia.",
      fallbackBody: "Dentro do Hub Principal, o grupo de guias [[amber:PRIVADO]] ([[emerald:Meus Personagens]], [[sky:Meus Services]] e [[amber:Meu Histórico de PT's]]) mostra apenas os seus dados.",
    },
    {
      id: "guias-publicas",
      title: "Guias PÚBLICAS do Hub",
      anchor: "hub-tabs-public",
      nav: [{ cmd: "window", arg: "characters" }],
      body: "As guias [[emerald:PÚBLICAS]] são compartilhadas entre os usuários — é aqui que fica o [[emerald:Gerenciador de PT's]], onde as equipes são criadas e acompanhadas.\n\nO tópico [[emerald:\"Gerenciador de PTs\"]] deste tutorial explora essa área em detalhes.",
      fallbackBody: "Dentro do Hub Principal, o grupo de guias [[emerald:PÚBLICO]] concentra o [[emerald:Gerenciador de PT's]].",
    },
    {
      id: "rodape",
      title: "Rodapé de ações",
      anchor: "footer-actions",
      body: "O rodapé reúne as ações de conta e utilitários:\n\n• [[amber:Tutorial]] — reabre este tutorial quando quiser;\n• [[slate:Feedback]] — envie sugestões e reporte problemas;\n• [[amber:Doação]] — colabore com o projeto (sua média atual aparece no botão);\n• [[emerald:Receber RC]] — configure o personagem principal para receber pagamentos;\n• [[violet:Streaming]] — vincule seu canal da Twitch;\n• [[emerald:Amigos]] — gerencie amizades (solicitações pendentes pulsam em âmbar);\n• [[rose:Sair]] — desconecta a conta.\n\nÀ esquerda ficam os ajustes de [[sky:zoom]] do cabeçalho e do conteúdo.",
      fallbackBody: "O rodapé, na base da tela, reúne [[amber:Tutorial]], [[slate:Feedback]], [[amber:Doação]], [[emerald:Receber RC]], [[violet:Streaming]], [[emerald:Amigos]], [[rose:Sair]] e os ajustes de [[sky:zoom]].",
    },
    {
      id: "vip-acesso",
      title: "Acesso VIP",
      anchor: "vip-access-btn",
      body: "No canto esquerdo do rodapé fica o botão de acesso [[vip:VIP]]:\n\n• Se você já é VIP, abre o [[amber:Painel VIP]] com seus dias restantes e benefícios;\n• Caso contrário, abre a contratação [[amber:SEJA VIP]].\n\nRecursos exclusivos [[vip:VIP]] incluem o [[rose:Painel Bazaar]] (leilões, interesses e alertas) e a área [[sky:Meus Services]] como Serviceiro.",
      fallbackBody: "No canto esquerdo do rodapé fica o botão [[vip:VIP]] — abre o Painel VIP (para membros) ou a contratação SEJA VIP. Recursos exclusivos [[vip:VIP]]: [[rose:Painel Bazaar]] e atuação como Serviceiro em [[sky:Meus Services]].",
    },
    {
      id: "conclusao",
      title: "Pronto para começar!",
      body: "Você já conhece a estrutura geral do aplicativo.\n\nVolte à lista de tópicos e explore os tutoriais de cada painel — o próximo passo recomendado é o tópico [[emerald:\"Gerenciador de PTs\"]], o coração do aplicativo.",
    },
  ],
};

export default primeirosPassos;
