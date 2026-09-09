// ============================================================================
// TÓPICO: BAZAAR
// ----------------------------------------------------------------------------
// Janela "Bazaar" (BazarPanel) — painel premium exclusivo VIP. As cenas usam
// o MODO DEMONSTRATIVO (demo: true): leilões fictícios preenchem a lista e o
// gate VIP é ignorado durante o tutorial, então QUALQUER usuário — mesmo sem
// VIP e sem nunca ter usado o Bazaar — vê o painel por dentro, funcionando.
// As cenas descrevem apenas recursos disponíveis ao usuário comum (nenhuma
// função administrativa aparece no tutorial).
// ============================================================================
import { ShoppingBag } from "lucide-react";
import type { TourTopic } from "../types";

const NAV_BZ = [{ cmd: "window", arg: "bazar" }];

const bazaar: TourTopic = {
  id: "bazaar",
  title: "Bazaar",
  description: "Leilões oficiais: consulta, filtros, interesses e alertas.",
  tone: "rose",
  icon: ShoppingBag,
  scenes: [
    {
      id: "visao-geral",
      demo: true,
      title: "O Painel Bazaar",
      anchor: "bazar-root",
      nav: NAV_BZ,
      padding: 0,
      body: "O [[rose:Bazaar]] consulta os [[amber:leilões oficiais de personagens]] do jogo: lista atual, encerramentos, valores e detalhes de cada personagem.\n\nEste é um painel premium exclusivo [[vip:VIP]] — durante o tutorial você o vê preenchido com [[violet:dados demonstrativos]] para conhecer tudo por dentro, mesmo sem VIP ativo.",
      fallbackBody: "Clique no botão [[rose:Bazaar]] no cabeçalho para abrir o painel de leilões — recurso exclusivo [[vip:VIP]].",
    },
    {
      id: "consulta",
      demo: true,
      title: "Lista oficial e filtros",
      anchor: "bazar-root",
      nav: NAV_BZ,
      padding: 0,
      body: "A lista oficial traz os personagens em leilão com [[sky:vocação]], [[sky:level]], [[violet:servidor]], [[emerald:lance atual]] e [[amber:tempo restante]].\n\nAs colunas [[slate:SW]] e [[rose:SG]] mostram o progresso de bosses das quests ([[slate:0/6]] e [[rose:0/5]] = nenhum boss derrotado — quest completa disponível).\n\nUse os [[sky:filtros de pesquisa]] (vocação, level, servidor, valor...) para achar exatamente o que procura — os filtros usados ficam salvos para reaproveitar.",
      fallbackBody: "Dentro do Bazaar, a lista oficial mostra os leilões com filtros combinados de vocação, level, servidor e valor.",
    },
    {
      id: "interesses",
      demo: true,
      title: "Interesses e alertas",
      anchor: "bazar-root",
      nav: NAV_BZ,
      padding: 0,
      body: "Marque [[rose:interesse]] nos personagens que está acompanhando:\n\n• os marcados ganham destaque e entram em [[rose:\"Meus Interesses\"]];\n• perto do encerramento, você recebe [[amber:notificações de alerta]] para não perder o leilão;\n• os interesses também aparecem como chips de acompanhamento no próprio painel.",
      fallbackBody: "No Bazaar, marque interesse nos personagens para recebê-los em destaque e ser notificado perto do encerramento do leilão.",
    },
    {
      id: "compra",
      demo: true,
      title: "Da compra ao cadastro",
      body: "Arrematou? O Bazaar encurta o caminho: o personagem comprado pode ser [[emerald:cadastrado direto]] em \"Meus Personagens\" com os dados do leilão preenchidos.\n\nAssim ele já entra na sua base pronto para [[emerald:PTs]] e para o controle financeiro (valor pago, drops, venda futura).",
    },
    {
      id: "conclusao",
      demo: true,
      title: "Tópico concluído!",
      body: "Você conhece o ciclo do Bazaar: [[sky:consulta]] → [[rose:interesse]] → [[amber:alertas]] → [[emerald:compra e cadastro]].\n\nLembre-se: o painel é exclusivo [[vip:VIP]] — os detalhes do plano estão no tópico [[amber:\"VIP e Doações\"]].",
    },
  ],
};

export default bazaar;
