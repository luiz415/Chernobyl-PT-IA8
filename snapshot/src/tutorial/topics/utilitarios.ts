// ============================================================================
// TÓPICO: AMIGOS, NOTIFICAÇÕES E UTILITÁRIOS
// ----------------------------------------------------------------------------
// Recursos transversais: Amigos, Central de Notificações, Calculadora,
// Streaming (Twitch), Receber RC, Feedback, temas/zoom e backup local.
// ============================================================================
import { Layers } from "lucide-react";
import type { TourTopic } from "../types";

const utilitarios: TourTopic = {
  id: "utilitarios",
  title: "Amigos, Notificações e Utilitários",
  description: "Amigos, notificações, calculadora, Twitch, Receber RC, backup e visual.",
  tone: "violet",
  icon: Layers,
  scenes: [
    {
      id: "amigos",
      title: "Amigos",
      anchor: "footer-actions",
      body: "O botão [[emerald:Amigos]] gerencia suas amizades:\n\n• envie e aceite [[amber:solicitações]] (pendências pulsam em âmbar no botão);\n• amigos têm prioridade em recursos sociais, como PTs [[rose:privadas]] com amigos autorizados e o modo IA do [[amber:Sugerir PT]] considerando seus amigos.",
      fallbackBody: "O botão [[emerald:Amigos]], no rodapé, gerencia solicitações e a sua lista de amizades.",
    },
    {
      id: "notificacoes",
      title: "Central de Notificações",
      anchor: "app-logo-notif",
      body: "Clicando no [[rose:logo]], a Central reúne tudo o que pede sua atenção: convites de PT, [[amber:alterações de horário]], [[emerald:pagamentos]], avisos do [[rose:Bazaar]], amizades e mais.\n\nNas [[sky:configurações de notificação]] você escolhe o que recebe — inclusive [[violet:notificações desktop]] no Windows, que ao serem clicadas navegam direto para a PT relacionada.",
      fallbackBody: "O logo do aplicativo abre a Central de Notificações; as preferências (incluindo notificações desktop) são configuráveis.",
    },
    {
      id: "calculadora",
      title: "Calculadora de moedas",
      body: "A [[sky:Calculadora]] converte [[emerald:RC ⇄ KK ⇄ R$]] usando a taxa do servidor que você escolher — essencial para precificar vendas de itens e services.\n\nEla abre em janela própria e pode ficar visível enquanto você opera as PTs.",
    },
    {
      id: "streaming",
      title: "Streaming (Twitch)",
      anchor: "footer-actions",
      body: "Em [[violet:Streaming]] você vincula o seu canal da Twitch.\n\nCom o canal configurado, os demais participantes veem o ícone [[violet:Twitch]] ao lado do seu nome nas PTs e podem abrir sua transmissão com um clique — útil para acompanhar a quest ao vivo.",
      fallbackBody: "O botão [[violet:Streaming]] do rodapé vincula seu canal da Twitch, exibido nas PTs para os demais participantes.",
    },
    {
      id: "receber-rc",
      title: "Receber RC",
      anchor: "footer-actions",
      body: "Em [[emerald:Receber RC]] você define o seu [[emerald:personagem principal]] para receber pagamentos.\n\nNas divisões de PT, quem for pagar vê exatamente [[amber:para qual personagem enviar]] os RC — com botão de copiar o nome junto do valor, evitando erros de transferência.",
      fallbackBody: "O botão [[emerald:Receber RC]] define o personagem que receberá os pagamentos das divisões de PT.",
    },
    {
      id: "backup-visual",
      title: "Backup, zoom e temas",
      body: "Preferências e segurança dos seus dados:\n\n• [[emerald:Importar/Exportar]] — backup pessoal em JSON/CSV de personagens, notas e histórico local;\n• [[amber:Auto-Save]] — salvamento local automático e contínuo no seu dispositivo;\n• [[sky:Zoom]] — ajuste independente de cabeçalho e conteúdo, no rodapé;\n• [[violet:Temas]] — troque o visual do aplicativo;\n• [[slate:Feedback]] — fale com a equipe direto pelo app.",
    },
    {
      id: "conclusao",
      title: "Tutorial concluído!",
      body: "Você percorreu os recursos transversais do aplicativo.\n\nRevisite qualquer tópico quando quiser pelo botão [[amber:🎓 Tutorial]] no rodapé — o progresso de cada um fica salvo. Boas PTs! 🎉",
    },
  ],
};

export default utilitarios;
