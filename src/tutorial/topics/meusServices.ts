// ============================================================================
// TÓPICO: MEUS SERVICES
// ----------------------------------------------------------------------------
// Guia privada "Meus Services" — área do Serviceiro (exclusiva VIP com
// serviceiro habilitado). Cena única de painel + cenas informativas sobre o
// fluxo, pois o conteúdo interno depende do papel do usuário.
// ============================================================================
import { Briefcase } from "lucide-react";
import type { TourTopic } from "../types";

const NAV_MS = [
  { cmd: "window", arg: "characters" },
  { cmd: "tab", arg: "meus_services" },
];

const meusServices: TourTopic = {
  id: "meus-services",
  title: "Meus Services",
  description: "Ofereça personagens como service e gerencie solicitações de clientes.",
  tone: "sky",
  icon: Briefcase,
  scenes: [
    {
      id: "visao-geral",
      title: "A área do Serviceiro",
      anchor: "myservices-root",
      nav: NAV_MS,
      padding: 0,
      body: "\"Meus Services\" é onde você atua como [[sky:Serviceiro]]: oferece personagens de clientes como service para PTs e acompanha cada etapa.\n\nEsta área é exclusiva para usuários [[vip:VIP]] com o perfil de Serviceiro habilitado — sem o acesso, o painel exibe as instruções para ativação.",
      fallbackBody: "Abra o [[emerald:Hub Principal]] e clique na guia [[sky:\"Meus Services\"]]. A área é exclusiva para usuários [[vip:VIP]] com perfil de Serviceiro habilitado.",
    },
    {
      id: "secoes",
      title: "Disponíveis e Realizados",
      anchor: "myservices-root",
      nav: NAV_MS,
      padding: 0,
      body: "O painel tem duas seções:\n\n• [[emerald:DISPONÍVEIS]] — services ativos aguardando PT, com as [[amber:solicitações pendentes]] de clientes no topo (aceite ou recuse cada uma);\n• [[sky:REALIZADOS]] — histórico dos services concluídos, com valores e datas.\n\nO contador da guia soma os disponíveis + solicitações pendentes.",
      fallbackBody: "Dentro de \"Meus Services\": seção [[emerald:DISPONÍVEIS]] (services ativos + solicitações pendentes) e [[sky:REALIZADOS]] (histórico concluído).",
    },
    {
      id: "link-publico",
      title: "Formulário público do cliente",
      body: "Clientes não precisam ter conta: você envia o [[emerald:link do formulário público]] e o cliente cadastra sozinho o personagem, vocação, level, valor combinado e o [[emerald:WhatsApp]] de contato.\n\nA solicitação chega em [[amber:\"Solicitações pendentes\"]] para você aceitar — ao aceitar, o service entra na sua lista e fica disponível para PTs.",
    },
    {
      id: "fluxo-pt",
      title: "Do service à PT",
      body: "O ciclo completo:\n\n1. Service aceito aparece na [[rose:Lista de Espera]] visível nas PTs;\n2. Um líder adiciona o personagem a uma PT — o service fica marcado [[amber:\"EM PT\"]];\n3. Na PT, a coluna [[emerald:WHATSAPP]] permite contato direto com o cliente;\n4. Quest concluída → o valor do service entra na coluna [[emerald:Item Vendido/Service (RC)]] da PT e o registro vai para [[sky:REALIZADOS]].",
    },
    {
      id: "conclusao",
      title: "Tópico concluído!",
      body: "Você conhece o fluxo do Serviceiro: [[emerald:link público]] → [[amber:solicitação]] → aceite → [[rose:Lista de Espera]] → PT → [[sky:realizado]].\n\nPara entender o lado das PTs, veja os tópicos [[emerald:\"Gerenciador de PTs\"]] e [[sky:\"Painel da PT\"]].",
    },
  ],
};

export default meusServices;
