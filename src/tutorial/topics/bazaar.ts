// ============================================================================
// TÓPICO: BAZAAR
// ----------------------------------------------------------------------------
// Janela "Bazaar" (BazarPanel) — painel premium exclusivo VIP. As cenas
// ancoram no contêiner da janela; sem VIP o painel real mostra a tela de
// contratação, e os textos explicam o que existe dentro.
// ============================================================================
import { ShoppingBag } from "lucide-react";
import type { TourTopic } from "../types";

const NAV_BZ = [{ cmd: "window", arg: "bazar" }];

const bazaar: TourTopic = {
  id: "bazaar",
  title: "Bazaar",
  description: "Leilões oficiais: consulta, filtros, interesses, alertas e Auto Bid.",
  tone: "rose",
  icon: ShoppingBag,
  scenes: [
    {
      id: "visao-geral",
      title: "O Painel Bazaar",
      anchor: "bazar-root",
      nav: NAV_BZ,
      padding: 0,
      body: "O [[rose:Bazaar]] consulta os [[amber:leilões oficiais de personagens]] do jogo: lista atual, encerramentos, valores e detalhes de cada personagem.\n\nEste é um painel premium exclusivo [[vip:VIP]] — sem VIP ativo, a janela exibe a apresentação dos benefícios e a contratação.",
      fallbackBody: "Clique no botão [[rose:Bazaar]] no cabeçalho para abrir o painel de leilões — recurso exclusivo [[vip:VIP]].",
    },
    {
      id: "consulta",
      title: "Lista oficial e filtros",
      anchor: "bazar-root",
      nav: NAV_BZ,
      padding: 0,
      body: "A lista oficial traz os personagens em leilão com [[sky:vocação]], [[sky:level]], [[violet:servidor]], [[emerald:lance atual]] e [[amber:tempo restante]].\n\nUse os [[sky:filtros de pesquisa]] (vocação, level, servidor, valor...) para achar exatamente o que procura — os filtros usados ficam salvos para reaproveitar.",
      fallbackBody: "Dentro do Bazaar, a lista oficial mostra os leilões com filtros combinados de vocação, level, servidor e valor.",
    },
    {
      id: "interesses",
      title: "Interesses e alertas",
      anchor: "bazar-root",
      nav: NAV_BZ,
      padding: 0,
      body: "Marque [[rose:interesse]] nos personagens que está acompanhando:\n\n• os marcados ganham destaque e entram em [[rose:\"Meus Interesses\"]];\n• perto do encerramento, você recebe [[amber:notificações de alerta]] para não perder o leilão;\n• os interesses também aparecem como chips de acompanhamento no próprio painel.",
      fallbackBody: "No Bazaar, marque interesse nos personagens para recebê-los em destaque e ser notificado perto do encerramento do leilão.",
    },
    {
      id: "autobid",
      title: "Auto Bid",
      anchor: "bazar-root",
      nav: NAV_BZ,
      padding: 0,
      body: "O [[amber:Auto Bid]] dá lances automaticamente por você:\n\n• defina o [[emerald:valor máximo]] para cada personagem de interesse;\n• o motor acompanha o leilão em segundo plano e cobre lances até o seu teto;\n• você recebe [[rose:notificações]] do resultado — arrematado ou superado.",
      fallbackBody: "O botão [[amber:Auto Bid]] do Bazaar programa lances automáticos até o valor máximo que você definir.",
    },
    {
      id: "compra",
      title: "Da compra ao cadastro",
      body: "Arrematou? O Bazaar encurta o caminho: o personagem comprado pode ser [[emerald:cadastrado direto]] em \"Meus Personagens\" com os dados do leilão preenchidos.\n\nAssim ele já entra na sua base pronto para [[emerald:PTs]] e para o controle financeiro (valor pago, drops, venda futura).",
    },
    {
      id: "conclusao",
      title: "Tópico concluído!",
      body: "Você conhece o ciclo do Bazaar: [[sky:consulta]] → [[rose:interesse]] → [[amber:alertas/Auto Bid]] → [[emerald:compra e cadastro]].\n\nLembre-se: o painel é exclusivo [[vip:VIP]] — os detalhes do plano estão no tópico [[amber:\"VIP e Doações\"]].",
    },
  ],
};

export default bazaar;
