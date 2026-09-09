// ============================================================================
// TÓPICO: MEU HISTÓRICO DE PTs
// ----------------------------------------------------------------------------
// Guia privada "Meu Histórico de PT's" (PersonalPartyHistoryList).
// ============================================================================
import { History } from "lucide-react";
import type { TourTopic } from "../types";

const NAV_HIST = [
  { cmd: "window", arg: "characters" },
  { cmd: "tab", arg: "meu_historico" },
];

const meuHistorico: TourTopic = {
  id: "meu-historico",
  title: "Meu Histórico de PTs",
  description: "Registro permanente das suas PTs concluídas, com valores e resumo WA.",
  tone: "amber",
  icon: History,
  scenes: [
    {
      id: "visao-geral",
      title: "Seu registro permanente",
      anchor: "history-root",
      nav: NAV_HIST,
      padding: 0,
      body: "\"Meu Histórico de PT's\" é o registro [[amber:PRIVADO]] e permanente das PTs em que você participou.\n\nCada entrada preserva a foto do momento da conclusão: [[emerald:personagens]], [[amber:donos]], [[sky:jogadores]], [[rose:mortes]], drops, valores e a sua [[emerald:participação na divisão]] — atualizada em tempo real enquanto a PT ainda está em pagamento.",
      fallbackBody: "Abra o [[emerald:Hub Principal]] e clique na guia [[amber:\"Meu Histórico de PT's\"]] para ver o registro das suas PTs concluídas.",
    },
    {
      id: "detalhes",
      title: "O que cada entrada guarda",
      anchor: "history-root",
      nav: NAV_HIST,
      padding: 0,
      body: "Em cada PT do histórico você encontra:\n\n• Quest ([[slate:SW]]/[[rose:SG]]), [[violet:servidor]], data e [[sky:duração]];\n• a equipe completa com [[amber:DONO]] e [[sky:JOGADOR]] de cada slot;\n• [[amber:drops]] e [[emerald:valores vendidos]];\n• o [[emerald:resultado financeiro]] da sua participação;\n• o botão [[emerald:Copiar (WA)]] com o resumo pronto para compartilhar no WhatsApp.",
      fallbackBody: "Cada entrada do histórico guarda a equipe completa, drops, valores, duração e o botão [[emerald:Copiar (WA)]] com o resumo da PT.",
    },
    {
      id: "origem",
      title: "Como o histórico é gerado",
      body: "O histórico é [[emerald:automático]]: quando uma PT é concluída e finalizada no [[emerald:Gerenciador de PTs]], o registro é materializado para cada participante — ninguém precisa anotar nada.\n\nEle também alimenta as suas [[sky:Estatísticas]] e o [[amber:Ranking]]: PTs concluídas, mortes, duração média e parceiros frequentes saem daqui.",
    },
    {
      id: "conclusao",
      title: "Tópico concluído!",
      body: "Seu histórico funciona sozinho: conclua PTs e consulte aqui os registros completos com valores e resumo para WhatsApp.\n\nVeja também os tópicos [[sky:\"Stats\"]] e [[amber:\"Ranking\"]] — os números deles nascem deste histórico.",
    },
  ],
};

export default meuHistorico;
