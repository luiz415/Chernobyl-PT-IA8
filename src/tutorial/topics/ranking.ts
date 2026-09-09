// ============================================================================
// TÓPICO: RANKING
// ----------------------------------------------------------------------------
// Janela "Ranking" (RankingPanel).
// ============================================================================
import { Trophy } from "lucide-react";
import type { TourTopic } from "../types";

const NAV_RK = [{ cmd: "window", arg: "ranking" }];

const ranking: TourTopic = {
  id: "ranking",
  title: "Ranking",
  description: "Comparação mensal entre usuários: Mês Atual e Último Mês.",
  tone: "amber",
  icon: Trophy,
  scenes: [
    {
      id: "visao-geral",
      demo: true,
      title: "O Ranking universal",
      anchor: "ranking-root",
      nav: NAV_RK,
      padding: 0,
      body: "O [[amber:Ranking]] compara todos os usuários do aplicativo em dois quadros:\n\n• [[emerald:Mês Atual]] — a disputa em andamento, atualizada conforme as PTs são concluídas;\n• [[sky:Último Mês]] — o resultado congelado do mês anterior.\n\nA cada virada de mês o quadro atual é arquivado e a disputa recomeça do zero.",
      fallbackBody: "Clique no botão [[amber:Ranking]] no cabeçalho para abrir a comparação mensal entre usuários.",
    },
    {
      id: "cards",
      demo: true,
      title: "Cards e ordenação",
      anchor: "ranking-root",
      nav: NAV_RK,
      padding: 0,
      body: "Cada usuário aparece num card com seus números do mês: [[emerald:PTs concluídas]], [[rose:mortes]], [[amber:doações]] e demais métricas.\n\nUse os [[sky:modos de ordenação]] para trocar o critério da classificação e dispute as melhores posições com seus [[emerald:amigos]].",
      fallbackBody: "No Ranking, cada usuário tem um card com as métricas do mês e a classificação pode ser reordenada por diferentes critérios.",
    },
    {
      id: "conclusao",
      demo: true,
      title: "Tópico concluído!",
      body: "Agora é competir: conclua PTs, evite [[rose:mortes]] e suba no quadro do [[emerald:Mês Atual]].\n\nSeus números individuais completos estão na janela [[sky:Stats]].",
    },
  ],
};

export default ranking;
