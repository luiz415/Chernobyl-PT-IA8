// ============================================================================
// TÓPICO: STATS (ESTATÍSTICAS)
// ----------------------------------------------------------------------------
// Janela "Stats" (StatsPanel).
// ============================================================================
import { BarChart3 } from "lucide-react";
import type { TourTopic } from "../types";

const NAV_ST = [{ cmd: "window", arg: "stats" }];

const stats: TourTopic = {
  id: "stats",
  title: "Stats",
  description: "Seu desempenho: PTs, mortes, duração média, parceiros e doações.",
  tone: "sky",
  icon: BarChart3,
  scenes: [
    {
      id: "visao-geral",
      demo: true,
      title: "Suas estatísticas",
      anchor: "stats-root",
      nav: NAV_ST,
      padding: 0,
      body: "A janela [[sky:Stats]] consolida o seu desempenho no aplicativo: [[emerald:PTs concluídas]], [[rose:mortes]], [[sky:duração média]] das quests, [[amber:doações]] e muito mais.\n\nOs números nascem automaticamente do seu [[amber:histórico de PTs]] — nada precisa ser preenchido manualmente.",
      fallbackBody: "Clique no botão [[sky:Stats]] no cabeçalho para abrir a janela de estatísticas.",
    },
    {
      id: "indicadores",
      demo: true,
      title: "O que você encontra aqui",
      anchor: "stats-root",
      nav: NAV_ST,
      padding: 0,
      body: "Entre os indicadores disponíveis:\n\n• [[emerald:PTs concluídas]] por quest ([[slate:SW]]/[[rose:SG]]) e no total;\n• [[rose:mortes]] acumuladas e por PT;\n• [[sky:duração média]] das quests;\n• [[violet:parceiros]] mais frequentes de equipe;\n• [[amber:services]] realizados e [[amber:média de doação]] (RC/PT) — a mesma exibida no botão Doação do rodapé.",
      fallbackBody: "A janela Stats reúne PTs concluídas, mortes, duração média, parceiros frequentes, services e média de doação.",
    },
    {
      id: "conclusao",
      demo: true,
      title: "Tópico concluído!",
      body: "Acompanhe suas estatísticas para medir a evolução — e compare-se com os demais no [[amber:Ranking]], tema do próximo tópico.",
    },
  ],
};

export default stats;
