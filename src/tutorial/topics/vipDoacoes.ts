// ============================================================================
// TÓPICO: VIP E DOAÇÕES
// ----------------------------------------------------------------------------
// Botão de acesso VIP do rodapé + benefícios + botão Doação. Cenas ancoradas
// no rodapé (sempre visível), com textos explicando os modais.
// ============================================================================
import { Crown } from "lucide-react";
import type { TourTopic } from "../types";

const vipDoacoes: TourTopic = {
  id: "vip-doacoes",
  title: "VIP e Doações",
  description: "Benefícios VIP, contratação, dias de acesso e apoio ao projeto.",
  tone: "amber",
  icon: Crown,
  scenes: [
    {
      id: "acesso",
      title: "O botão VIP",
      anchor: "vip-access-btn",
      body: "No rodapé fica o acesso [[vip:VIP]]:\n\n• membros veem o botão [[amber:VIP]] — abre o Painel VIP com os [[emerald:dias restantes]], data de expiração e benefícios ativos;\n• demais usuários veem [[violet:SEJA VIP]] — abre a contratação com planos e formas de pagamento.",
      fallbackBody: "No canto esquerdo do rodapé, o botão [[vip:VIP]] (ou [[violet:SEJA VIP]]) abre o painel de acesso VIP.",
    },
    {
      id: "beneficios",
      title: "Benefícios exclusivos VIP",
      body: "O que o [[vip:VIP]] libera:\n\n• [[rose:Painel Bazaar]] completo — lista oficial, filtros, interesses, alertas de encerramento e [[amber:Auto Bid]];\n• atuação como [[sky:Serviceiro]] em \"Meus Services\" (com o perfil habilitado), incluindo o [[emerald:formulário público]] de clientes;\n• demais vantagens listadas em [[amber:Benefícios VIP]] dentro do painel.\n\nOs dias VIP são [[emerald:cumulativos]]: novas contratações somam ao saldo atual.",
    },
    {
      id: "doacoes",
      title: "Doações — apoie o projeto",
      anchor: "footer-actions",
      body: "O botão [[amber:Doação]] do rodapé abre a colaboração com o projeto:\n\n• sua [[amber:média atual]] (RC por PT concluída) aparece no próprio botão;\n• doações são registradas nas suas [[sky:estatísticas]] e reconhecidas no [[amber:Ranking]];\n• doar também é caminho para [[emerald:créditos VIP]] — os detalhes estão no modal de doação.",
      fallbackBody: "O botão [[amber:Doação]] do rodapé abre a colaboração com o projeto; sua média RC/PT aparece no próprio botão.",
    },
    {
      id: "conclusao",
      title: "Tópico concluído!",
      body: "Resumo: [[vip:VIP]] libera o [[rose:Bazaar]] e o perfil de [[sky:Serviceiro]]; doações apoiam o projeto e contam nas suas métricas.\n\nQualquer dúvida, os modais [[amber:VIP]] e [[amber:Doação]] têm as informações completas e atualizadas.",
    },
  ],
};

export default vipDoacoes;
