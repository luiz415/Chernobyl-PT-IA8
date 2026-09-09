// ============================================================================
// TÓPICO: PAINEL DA PT
// ----------------------------------------------------------------------------
// Opera DENTRO de uma PT aberta. Estratégia dupla da auditoria: as cenas
// ancoram nos elementos reais do PartyPanel ("pp-*"), que só existem com uma
// PT aberta — quando não há PT aberta, cada cena degrada para o modo
// informativo via fallbackBody (o motor cuida disso automaticamente).
// O comando "ptOpenFirst" tenta abrir a primeira PT visível do estágio atual.
// ============================================================================
import { ClipboardList } from "lucide-react";
import type { TourTopic } from "../types";

/** Navegação: Hub → Gerenciador → tenta abrir a primeira PT visível.
 *  Nas cenas demonstrativas as PTs fictícias garantem que sempre exista uma
 *  PT em cada estágio; NAV_OPEN_PT_PAGA abre a "Aguardando Pagamento" (com
 *  drops/valores lançados) para as cenas de vendas, totais e pagamentos. */
const NAV_OPEN_PT = [
  { cmd: "window", arg: "characters" },
  { cmd: "tab", arg: "pts" },
  { cmd: "ptOpenFirst" },
];
const NAV_OPEN_PT_PAGA = [
  { cmd: "window", arg: "characters" },
  { cmd: "tab", arg: "pts" },
  { cmd: "ptOpenFirst", arg: "aguardando" },
];

const painelPt: TourTopic = {
  id: "painel-pt",
  title: "Painel da PT",
  description: "Slots, DONO/JOGADOR, divisão, drops, pagamentos e finalização.",
  tone: "sky",
  icon: ClipboardList,
  scenes: [
    {
      id: "visao-geral",
      demo: true,
      title: "Dentro de uma PT",
      anchor: "pp-root",
      nav: NAV_OPEN_PT,
      padding: 0,
      body: "Este é o painel completo de uma PT: cabeçalho com as [[amber:ações da equipe]], a [[emerald:tabela de slots]] com os participantes e, embaixo, os painéis de [[sky:apoio]] para completar a equipe.\n\nSe esta PT não for sua, alguns controles aparecem bloqueados — cada ação respeita as permissões de [[amber:líder]], [[emerald:participante]] e visitante.",
      fallbackBody: "Para ver este painel ao vivo, abra uma PT clicando na aba ou no card dela no Gerenciador de PT's. As próximas cenas explicam cada área do painel.",
    },
    {
      id: "cabecalho",
      demo: true,
      title: "Cabeçalho e ações da PT",
      anchor: "pp-header",
      nav: NAV_OPEN_PT,
      body: "O cabeçalho concentra o controle da PT:\n\n• selo da Quest ([[rose:SG]]/[[slate:SW]]) e [[violet:servidor]] (editável só enquanto \"Com Vagas\");\n• [[amber:líder]] da PT;\n• [[emerald:Iniciar Quest]] (com a PT cheia) → cronômetro; depois [[sky:Concluir Quest]];\n• [[amber:⏸ Pausar]] e [[rose:Falha]] durante a quest;\n• [[slate:Trancar/Liberar]] a edição;\n• [[amber:Horário Combinado]] com alteração notificada a todos;\n• [[emerald:Copiar (WA)]] — resumo completo pronto para WhatsApp;\n• [[rose:Excluir PT]] (antes do início).",
      fallbackBody: "Com uma PT aberta, o cabeçalho traz: selo da Quest, servidor, líder, [[emerald:Iniciar]]/[[sky:Concluir Quest]], [[amber:Pausar]], [[slate:Trancar]], [[amber:Horário]], [[emerald:Copiar (WA)]] e [[rose:Excluir PT]].",
    },
    {
      id: "slots",
      demo: true,
      title: "Tabela de slots",
      anchor: "pp-slots-table",
      nav: NAV_OPEN_PT,
      padding: 0,
      body: "Cada linha é um participante. As colunas principais:\n\n• [[emerald:Conta / Personagem / Servidor / Voc / Level]] — dados do personagem;\n• [[amber:DONO]] — proprietário real do personagem;\n• [[sky:JOGADOR]] — quem vai jogar com ele na quest;\n• [[rose:Mortes]] — contador individual;\n• [[violet:Anotações]] — observações por slot.\n\nA borda da tabela fica [[emerald:verde]] quando a PT está completa e [[amber:âmbar]] enquanto há vagas.",
      fallbackBody: "A tabela de slots lista os participantes com colunas de personagem, [[amber:DONO]], [[sky:JOGADOR]], mortes, divisão, drops e anotações.",
    },
    {
      id: "divisao",
      demo: true,
      title: "DIVIDIR — a divisão financeira",
      anchor: "pp-slots-table",
      nav: NAV_OPEN_PT,
      padding: 0,
      body: "A coluna [[emerald:DIVIDIR]] define quem participa da divisão dos lucros:\n\n• marcado = o slot entra na divisão do valor total;\n• o destino do valor segue o [[amber:DONO]] ou o [[sky:JOGADOR]], conforme configurado no slot;\n• a longo prazo a média se iguala entre dividir ou não — dividir apenas [[emerald:suaviza a variação]] dos rendimentos;\n• movimentações gerem [[rose:notificações]] automáticas e a PT só finaliza com [[amber:todos os pagamentos feitos]].",
      fallbackBody: "Na tabela de slots, a coluna [[emerald:DIVIDIR]] marca quem participa da divisão dos lucros; o destino do valor segue o DONO ou o JOGADOR do slot.",
    },
    {
      id: "drops",
      demo: true,
      title: "Itens dropados e vendas",
      anchor: "pp-slots-table",
      nav: NAV_OPEN_PT_PAGA,
      padding: 0,
      body: "Durante e após a quest, registre os resultados:\n\n• [[amber:Item Dropado]] — o que cada personagem dropou;\n• [[emerald:Item Vendido/Service (RC)]] — valor de venda do item (com taxa e conversão automática para RC) ou o valor do service;\n• com [[emerald:todos os itens vendidos]], a divisão fica completa e a PT pode ser finalizada.",
      fallbackBody: "As colunas [[amber:Item Dropado]] e [[emerald:Item Vendido/Service (RC)]] registram os drops e as vendas que alimentam a divisão.",
    },
    {
      id: "totais",
      demo: true,
      title: "Linha de TOTAIS e pagamentos",
      anchor: "pp-totals-row",
      nav: NAV_OPEN_PT_PAGA,
      body: "A última linha consolida a PT:\n\n• [[amber:⚡ TOTAL]] — soma de mortes, participantes na divisão e valores;\n• a coluna [[emerald:PG]] de cada slot marca os pagamentos individuais realizados;\n• o botão [[amber:PAGAMENTO REALIZADO / FINALIZAR PT]] conclui a PT quando a quest terminou, os itens da divisão foram vendidos e todos receberam — a PT é então arquivada e vira [[sky:histórico]].",
      fallbackBody: "Na base da tabela, a linha ⚡ TOTAL consolida os valores e o botão [[amber:FINALIZAR PT]] arquiva a PT quando todos os pagamentos foram concluídos.",
    },
    {
      id: "paineis-inferiores",
      demo: true,
      title: "Painéis de apoio",
      anchor: "pp-bottom-panels",
      nav: NAV_OPEN_PT,
      padding: 0,
      body: "Abaixo da tabela ficam três painéis para completar a equipe:\n\n• [[amber:Personagens Disponíveis]] — compartilhados pelos usuários, com filtros; um clique adiciona à PT;\n• [[rose:Lista de Espera]] — clientes de service que podem ocupar um slot;\n• [[sky:Oportunidade por Servidor]] — gráfico de onde há mais personagens aptos.\n\nOs divisores são [[emerald:arrastáveis]] e as larguras ficam salvas.",
      fallbackBody: "Abaixo da tabela de slots ficam os painéis [[amber:Personagens Disponíveis]], [[rose:Lista de Espera]] e [[sky:Oportunidade por Servidor]], com larguras ajustáveis.",
    },
    {
      id: "whatsapp-twitch",
      demo: true,
      title: "Contato: WhatsApp e Twitch",
      anchor: "pp-slots-table",
      nav: NAV_OPEN_PT,
      padding: 0,
      body: "A tabela também facilita a comunicação:\n\n• coluna [[emerald:WHATSAPP]] — abre conversa com o [[amber:DONO]] e/ou o [[sky:JOGADOR]] de cada slot (ícones separados quando são pessoas diferentes);\n• coluna [[violet:TWITCH]] — abre o canal de quem estiver transmitindo;\n• o botão [[emerald:Copiar (WA)]] do cabeçalho gera o resumo completo da PT para colar no grupo.",
      fallbackBody: "As colunas [[emerald:WHATSAPP]] e [[violet:TWITCH]] da tabela abrem o contato direto com cada participante.",
    },
    {
      id: "conclusao",
      demo: true,
      title: "Tópico concluído!",
      body: "Você domina o ciclo completo de uma PT: montar a equipe, [[emerald:iniciar]], registrar [[amber:drops]] e [[rose:mortes]], [[sky:concluir]], vender itens, dividir e [[amber:finalizar]].\n\nA PT finalizada vira registro permanente em [[amber:\"Meu Histórico de PT's\"]] — tema de outro tópico da lista.",
    },
  ],
};

export default painelPt;
