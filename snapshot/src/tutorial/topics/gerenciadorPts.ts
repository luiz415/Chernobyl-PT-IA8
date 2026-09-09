// ============================================================================
// TÓPICO: GERENCIADOR DE PTs
// ----------------------------------------------------------------------------
// Percorre o PartyManager: barra de abas, seletores de estágio (navegando de
// verdade por Com Vagas → Prontas → Iniciadas → Aguardando Pagamento), painel
// de cards, filtros, Itens a Venda, Visão Geral, Todos Personagens, Sugerir
// PT e Criar PT. As cenas de estágio usam o comando "ptStage" — o mesmo
// setPtStatusView dos seletores reais — então o conteúdo exibido é sempre o
// estado vivo do aplicativo. Textos com markup de cor [[tom:texto]].
// ============================================================================
import { Users } from "lucide-react";
import type { TourTopic } from "../types";

/** Navegação base: Hub Principal → guia Gerenciador de PT's, sem PT aberta. */
const NAV_PTS = [
  { cmd: "window", arg: "characters" },
  { cmd: "tab", arg: "pts" },
  { cmd: "ptClose" },
  { cmd: "ptStandalone", arg: "selectPrompt" },
];

const gerenciadorPts: TourTopic = {
  id: "gerenciador-pts",
  title: "Gerenciador de PTs",
  description: "Estágios das PTs, cards de seleção, filtros, Sugerir PT e Criar PT.",
  tone: "emerald",
  icon: Users,
  scenes: [
    {
      id: "visao-geral",
      demo: true,
      title: "O coração do aplicativo",
      anchor: "pm-root",
      nav: NAV_PTS,
      padding: 0,
      body: "O [[emerald:Gerenciador de PT's]] é onde as equipes nascem, se organizam e são concluídas.\n\nCada PT atravessa quatro estágios: [[violet:Com Vagas]] → [[emerald:Prontas]] → [[sky:Iniciadas]] → [[amber:Aguardando Pagamento]]. Este painel organiza tudo por estágio, com uma cor para cada um.",
      fallbackBody: "Abra o [[emerald:Hub Principal]] e clique na guia [[emerald:\"Gerenciador de PT's\"]] para acessar este painel.",
    },
    {
      id: "abas",
      demo: true,
      title: "Barra de abas de PTs",
      anchor: "pm-tabs-bar",
      nav: NAV_PTS,
      body: "Cada PT do estágio selecionado vira uma aba nesta barra. A [[amber:cor da aba]] acompanha o estágio da PT, e o selo [[rose:SG]]/[[slate:SW]] indica a Quest (Sanguine ou Soulwar).\n\nClicar numa aba [[emerald:abre a PT]]; clicar de novo [[sky:minimiza]]. Em \"Com Vagas\", a aba também mostra o contador de vagas ocupadas.",
      fallbackBody: "Quando existem PTs no estágio selecionado, elas aparecem como abas coloridas na barra superior do painel.",
    },
    {
      id: "seletores",
      demo: true,
      // Interativa: o clique nos seletores só troca estado local de UI
      // (setPtStatusView) — seguro liberar dentro do spotlight.
      interactive: true,
      title: "Seletores de estágio",
      anchor: "pm-stage-selectors",
      nav: NAV_PTS,
      body: "Estes quatro botões filtram as PTs por estágio — cada um com sua cor e um contador.\n\nQuando uma categoria tem novidades, a borda do seletor [[amber:pulsa]]: nos três primeiros, ao existir qualquer PT; em [[amber:\"Aguardando Pagamento\"]], apenas quando há pagamento pendente [[rose:COM VOCÊ]].\n\nNas próximas cenas vamos visitar cada estágio de verdade.\n\n[[emerald:Experimente]]: nesta cena os seletores estão liberados — clique neles para alternar os estágios ao vivo.",
      fallbackBody: "Os seletores [[violet:Com Vagas]] / [[emerald:Prontas]] / [[sky:Iniciadas]] / [[amber:Aguardando Pagamento]] ficam à direita da barra de abas e filtram as PTs por estágio.",
    },
    {
      id: "com-vagas",
      demo: true,
      title: "Estágio 1 — Com Vagas",
      anchor: "pm-cards-panel",
      nav: [...NAV_PTS, { cmd: "ptStage", arg: "comVagas" }],
      padding: 0,
      body: "PTs que ainda têm [[violet:slots em aberto]]. Você está vendo o estado REAL do aplicativo agora.\n\nSem nenhuma PT aberta, este painel exibe um card por PT: nome, Quest, servidor, líder, [[violet:vagas restantes]], [[amber:horário marcado]] e participantes. Clicar num card [[emerald:abre a PT]] — igual a clicar na aba.",
      fallbackBody: "Com o seletor [[violet:\"Com Vagas\"]] ativo e nenhuma PT aberta, o painel central exibe um card para cada PT com slots em aberto.",
    },
    {
      id: "prontas",
      demo: true,
      title: "Estágio 2 — Prontas",
      anchor: "pm-cards-panel",
      nav: [...NAV_PTS, { cmd: "ptStage", arg: "prontas" }],
      padding: 0,
      body: "Quando todos os slots são preenchidos, a PT muda automaticamente para [[emerald:\"Prontas\"]] — completa, aguardando o horário de início.\n\nOs cards deste estágio destacam a [[emerald:lotação completa]] e o [[amber:horário marcado]], para o grupo se organizar antes de começar.",
      fallbackBody: "O seletor [[emerald:\"Prontas\"]] (verde) exibe as PTs completas cuja Quest ainda não foi iniciada.",
    },
    {
      id: "iniciadas",
      demo: true,
      title: "Estágio 3 — Iniciadas",
      anchor: "pm-cards-panel",
      nav: [...NAV_PTS, { cmd: "ptStage", arg: "iniciadas" }],
      padding: 0,
      body: "PTs com a Quest [[sky:em andamento]]. Os cards mostram a [[sky:duração em tempo real]] e indicam se a PT está [[amber:pausada]].\n\nO controle de iniciar, pausar e concluir a Quest fica dentro do painel da própria PT — tema do tópico [[sky:\"Painel da PT\"]].",
      fallbackBody: "O seletor [[sky:\"Iniciadas\"]] (azul) exibe as PTs com Quest em andamento, com duração em tempo real e indicação de pausa.",
    },
    {
      id: "aguardando",
      demo: true,
      title: "Estágio 4 — Aguardando Pagamento",
      anchor: "pm-cards-panel",
      nav: [...NAV_PTS, { cmd: "ptStage", arg: "aguardando" }],
      padding: 0,
      body: "Depois da Quest concluída, a PT fica aqui até [[amber:TODOS os pagamentos]] da divisão serem realizados.\n\nOs cards mostram o andamento ([[amber:\"Pagos X/Y\"]]), avisam com [[amber:pulso âmbar]] quando há pagamento pendente com você e sinalizam quando [[emerald:todos os itens]] da PT já foram vendidos.",
      fallbackBody: "O seletor [[amber:\"Aguardando Pagamento\"]] (âmbar) reúne as PTs com Quest concluída e divisão ainda pendente.",
    },
    {
      id: "itens-a-venda",
      demo: true,
      title: "Itens a Venda",
      anchor: "pm-items-for-sale",
      nav: [...NAV_PTS, { cmd: "ptStage", arg: "aguardando" }],
      body: "Este botão centraliza os [[amber:itens dropados]] que ainda não foram vendidos nas PTs em \"Aguardando Pagamento\" acessíveis a você.\n\nQuando existe pelo menos um item pendente, o botão [[amber:pulsa em âmbar]] com o total — a venda dos itens destrava a [[emerald:divisão]] e a [[emerald:finalização]] da PT.",
      fallbackBody: "Ao lado do seletor \"Aguardando Pagamento\" existe o botão [[amber:\"Itens a Venda\"]], que centraliza os itens ainda não vendidos dessas PTs.",
    },
    {
      id: "filtros",
      demo: true,
      title: "Filtros de visualização",
      anchor: "pm-filters",
      nav: NAV_PTS,
      body: "Estes botões refinam quais PTs aparecem nas abas e nos cards:\n\n• [[rose:🔒 privadas]] / [[emerald:🔓 públicas]];\n• [[sky:✔ apenas PTs em que você participa]];\n• [[violet:filtro por servidor]];\n• [[slate:↺ limpa todos os filtros]].\n\nOs filtros combinam entre si e valem para todos os estágios.",
      fallbackBody: "O grupo de filtros (privadas, públicas, minhas PTs, servidor) fica na barra superior do Gerenciador, ao lado dos seletores de estágio.",
    },
    {
      id: "visao-geral-btn",
      demo: true,
      title: "Guia \"Visão Geral\"",
      anchor: "pm-overview-btn",
      nav: NAV_PTS,
      body: "Abre um [[amber:panorama estatístico]] dos personagens e services disponíveis: distribuição por vocação, level e servidor.\n\nÚtil para enxergar rapidamente onde há [[emerald:oportunidade]] de montar PTs.",
      fallbackBody: "O botão [[amber:\"Visão Geral\"]], na barra superior, abre o panorama estatístico dos personagens e services disponíveis.",
    },
    {
      id: "todos-personagens-btn",
      demo: true,
      title: "Guia \"Todos Personagens\"",
      anchor: "pm-allchars-btn",
      nav: NAV_PTS,
      body: "Abre três painéis lado a lado: [[amber:Personagens Disponíveis]], [[rose:Lista de Espera]] (services) e o gráfico de [[sky:Oportunidade por Servidor]].\n\nCada painel pode ser exibido/ocultado individualmente, e os divisores são [[emerald:arrastáveis]] para ajustar as larguras — a configuração fica salva.",
      fallbackBody: "O botão [[sky:\"Todos Personagens\"]], na barra superior, abre os painéis de Personagens Disponíveis, Lista de Espera e Oportunidade por Servidor.",
    },
    {
      id: "sugerir-pt",
      demo: true,
      title: "Sugerir PT (IA)",
      anchor: "pm-suggest-btn",
      nav: NAV_PTS,
      body: "O modo [[amber:IA]] monta automaticamente a [[emerald:melhor composição]] de PT possível com os personagens e services disponíveis, respeitando força da equipe, levels, amigos e servidor.\n\nVocê pode alternar para o modo [[sky:Manual]], pedir [[violet:\"Sugerir Outra Composição\"]] e, ao confirmar, a PT é criada já com todos os participantes.",
      fallbackBody: "O botão [[amber:\"Sugerir PT\"]] (✨), na barra superior, monta composições automaticamente com algoritmo inteligente.",
    },
    {
      id: "criar-pt",
      demo: true,
      title: "Criar PT manualmente",
      anchor: "pm-create-btn",
      nav: NAV_PTS,
      body: "Abre o formulário de criação manual: tipo de Quest ([[slate:Soulwar]]/[[rose:Sanguine]]), servidor, data e horário, visibilidade ([[emerald:pública]] ou [[rose:privada]]) e convidados.\n\nPTs públicas são visíveis a todos; privadas, apenas aos convidados. Depois de criada, a PT aparece em [[violet:\"Com Vagas\"]] para receber os participantes.",
      fallbackBody: "O botão [[emerald:\"+ Criar PT\"]], no canto superior direito, abre o formulário de criação manual de PT.",
    },
    {
      id: "conclusao",
      demo: true,
      title: "Tópico concluído!",
      body: "Você conhece agora o fluxo completo do Gerenciador: os [[amber:quatro estágios]], os cards de seleção rápida, os filtros e as duas formas de criar PTs.\n\nPara aprender a operar DENTRO de uma PT (slots, DONO/JOGADOR, divisão, drops, pagamentos), siga para o tópico [[sky:\"Painel da PT\"]].",
    },
  ],
};

export default gerenciadorPts;
