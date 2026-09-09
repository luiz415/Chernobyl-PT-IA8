// ============================================================================
// TÓPICO: MEUS PERSONAGENS
// ----------------------------------------------------------------------------
// Guia privada "Meus Personagens": alternância Disponíveis/Vendidos/
// Negociados (comando charsView), tabela CharTable, cadastro, controle de
// quests, compartilhamento, vendas e resultado financeiro.
// ============================================================================
import { Swords } from "lucide-react";
import type { TourTopic } from "../types";

const NAV_CHARS = [
  { cmd: "window", arg: "characters" },
  { cmd: "tab", arg: "ativos" },
];

const meusPersonagens: TourTopic = {
  id: "meus-personagens",
  title: "Meus Personagens",
  description: "Cadastro, quests, compartilhamento, vendas e resultado financeiro.",
  tone: "emerald",
  icon: Swords,
  scenes: [
    {
      id: "visao-geral",
      title: "Sua base de personagens",
      anchor: "chars-table",
      nav: [...NAV_CHARS, { cmd: "charsView", arg: "disponiveis" }],
      padding: 0,
      body: "\"Meus Personagens\" é a sua guia [[amber:PRIVADA]] de gestão: aqui você cadastra e controla todos os seus personagens.\n\nA tabela mostra [[emerald:conta]], [[emerald:personagem]], [[violet:servidor]], [[sky:vocação]], [[sky:level]], as quests [[slate:Soulwar]] e [[rose:Sanguine]], drops, valores e anotações — tudo editável.",
      fallbackBody: "Abra o [[emerald:Hub Principal]] e clique na guia [[emerald:\"Meus Personagens\"]] para ver a tabela dos seus personagens.",
    },
    {
      id: "sub-visoes",
      title: "Disponíveis · Vendidos · Negociados",
      anchor: "chars-view-toggle",
      nav: NAV_CHARS,
      body: "Três sub-visões organizam seus personagens:\n\n• [[emerald:DISPONÍVEIS]] — os personagens ativos, prontos para PTs;\n• [[amber:VENDIDOS]] — histórico de vendas com datas, valores e resultado financeiro;\n• [[violet:NEGOCIADOS ENTRE USUÁRIOS]] — personagens com uso financeiro negociado com outros usuários (aquisições).",
      fallbackBody: "No topo da guia \"Meus Personagens\" ficam os botões [[emerald:DISPONÍVEIS]], [[amber:VENDIDOS]] e [[violet:NEGOCIADOS ENTRE USUÁRIOS]].",
    },
    {
      id: "cadastro",
      title: "Cadastrar e editar",
      anchor: "chars-table",
      nav: [...NAV_CHARS, { cmd: "charsView", arg: "disponiveis" }],
      padding: 0,
      body: "Use o botão [[emerald:+ (Adicionar personagem)]] na tabela para cadastrar: conta, nome, servidor, vocação, level, status das quests e valores.\n\nClique em qualquer personagem para [[sky:editar]]. Vários campos aceitam [[amber:edição direta na própria tabela]] (level, drops, anotações), sem abrir o formulário.",
      fallbackBody: "Na visão DISPONÍVEIS, o botão [[emerald:+]] adiciona personagens e o clique em uma linha abre a edição completa.",
    },
    {
      id: "quests",
      title: "Controle de Quests",
      anchor: "chars-table",
      nav: [...NAV_CHARS, { cmd: "charsView", arg: "disponiveis" }],
      padding: 0,
      body: "As colunas [[slate:SOULWAR]] e [[rose:SANGUINE]] controlam a elegibilidade de cada personagem:\n\n• marcado = personagem [[emerald:APTO]] a fazer a quest (aparece para PTs);\n• o marcador de [[amber:provável conclusão]] avisa quando o personagem provavelmente já fez a quest em outra ocasião;\n• após concluir a quest numa PT, o registro é atualizado automaticamente.",
      fallbackBody: "As colunas SOULWAR e SANGUINE da tabela controlam quais quests cada personagem pode fazer.",
    },
    {
      id: "compartilhar",
      title: "Compartilhamento",
      anchor: "chars-table",
      nav: [...NAV_CHARS, { cmd: "charsView", arg: "disponiveis" }],
      padding: 0,
      body: "A coluna [[sky:COMPARTILHAR]] publica o personagem para os demais usuários montarem PTs com ele:\n\n• personagem [[emerald:compartilhado]] aparece em \"Personagens Disponíveis\" para todos;\n• personagem [[slate:não compartilhado]] fica visível apenas para você;\n• a coluna [[amber:PT]] indica quando o personagem já está em alguma PT ativa.",
      fallbackBody: "A coluna COMPARTILHAR publica o personagem para os demais usuários; a coluna PT mostra quando ele já está em uma PT ativa.",
    },
    {
      id: "vendidos",
      title: "Histórico de vendas",
      anchor: "chars-table",
      nav: [...NAV_CHARS, { cmd: "charsView", arg: "vendidos" }],
      padding: 0,
      body: "A visão [[amber:VENDIDOS]] guarda o histórico dos personagens vendidos: [[amber:data da venda]], [[emerald:valor pago]], [[emerald:valor de venda]], drops obtidos e o [[emerald:resultado financeiro total]] de cada um.\n\nAssim os personagens ativos nunca se misturam com o histórico.",
      fallbackBody: "A visão [[amber:VENDIDOS]] mostra o histórico completo de vendas com datas, valores e resultado financeiro.",
    },
    {
      id: "negociados",
      title: "Negociados entre usuários",
      anchor: "chars-table",
      nav: [...NAV_CHARS, { cmd: "charsView", arg: "adquiridos" }],
      padding: 0,
      body: "A visão [[violet:NEGOCIADOS ENTRE USUÁRIOS]] acompanha as [[violet:aquisições]]: negociações em que um usuário cede o uso financeiro de um personagem a outro para uma quest.\n\nAqui ficam o status do pagamento, o [[amber:Drop Quest]], o [[emerald:lucro]] e a confirmação do repasse da venda — com notificações automáticas a cada etapa.",
      fallbackBody: "A visão [[violet:NEGOCIADOS ENTRE USUÁRIOS]] acompanha as negociações de uso financeiro de personagens entre usuários.",
    },
    {
      id: "conclusao",
      title: "Tópico concluído!",
      body: "Você já sabe gerenciar seus personagens: cadastro, quests, compartilhamento, vendas e negociações.\n\nPróximo passo recomendado: o tópico [[emerald:\"Gerenciador de PTs\"]] para colocar seus personagens em equipe — ou [[sky:\"Painel da PT\"]] para dominar a operação de uma PT aberta.",
    },
  ],
};

export default meusPersonagens;
