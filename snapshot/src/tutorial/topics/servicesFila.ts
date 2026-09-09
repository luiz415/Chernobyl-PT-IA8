// ============================================================================
// TÓPICO: SERVICES (FILA DE CLIENTES)
// ----------------------------------------------------------------------------
// Guia pública "Services" (WaitingListPanel). A guia é renderizada apenas
// para determinados perfis — o tópico é bossOnly (só aparece no menu para
// quem tem acesso), e o texto não menciona restrição de cargo, conforme
// diretriz do produto.
// ============================================================================
import { Clock } from "lucide-react";
import type { TourTopic } from "../types";

const NAV_SV = [
  { cmd: "window", arg: "characters" },
  { cmd: "tab", arg: "waitlist" },
];

const servicesFila: TourTopic = {
  id: "services-fila",
  title: "Services",
  description: "Fila de clientes aguardando service: cadastro, filtros e acompanhamento.",
  tone: "rose",
  icon: Clock,
  bossOnly: true,
  scenes: [
    {
      id: "visao-geral",
      demo: true,
      title: "A fila de Services",
      anchor: "services-root",
      nav: NAV_SV,
      padding: 0,
      body: "A guia [[rose:Services]] centraliza os clientes aguardando service: cada linha é um personagem de cliente com [[emerald:valor combinado]], [[sky:vocação]], [[sky:level]], [[violet:servidor]] e o [[emerald:WhatsApp]] de contato.\n\nEsta é a mesma [[rose:Lista de Espera]] que aparece nas PTs — gerenciada aqui de forma completa.",
      fallbackBody: "A guia [[rose:Services]], no grupo PÚBLICO do Hub, centraliza a fila completa de clientes aguardando service.",
    },
    {
      id: "cadastro",
      demo: true,
      title: "Cadastro e edição",
      anchor: "services-root",
      nav: NAV_SV,
      padding: 0,
      body: "Adicione clientes manualmente pelo botão de [[emerald:novo registro]] ou receba-os automaticamente pelo [[emerald:formulário público]] dos Serviceiros.\n\nCada registro guarda personagem, quest desejada ([[slate:Soulwar]]/[[rose:Sanguine]]), [[emerald:valor combinado]], anotações e o [[amber:responsável]] pelo atendimento.",
      fallbackBody: "Na guia Services é possível cadastrar clientes manualmente ou recebê-los pelo formulário público dos Serviceiros.",
    },
    {
      id: "filtros-status",
      demo: true,
      title: "Filtros e acompanhamento",
      anchor: "services-root",
      nav: NAV_SV,
      padding: 0,
      body: "A tabela oferece [[sky:filtros combinados]] (level, valor, quest, servidor, WhatsApp) e indicadores de status:\n\n• [[amber:⚠ EM PT]] — o personagem já está em uma PT ativa;\n• marcador de [[emerald:primeira mensagem enviada]] — controla quem já foi contatado;\n• ao concluir a quest, o registro sai da fila automaticamente e o service vira histórico.",
      fallbackBody: "A tabela de Services tem filtros combinados e indicadores: [[amber:EM PT]], primeira mensagem enviada e remoção automática ao concluir a quest.",
    },
    {
      id: "conclusao",
      demo: true,
      title: "Tópico concluído!",
      body: "Você conhece a gestão da fila de Services: cadastro, filtros, contato e o vínculo com as PTs.\n\nO fluxo do ponto de vista do Serviceiro está no tópico [[sky:\"Meus Services\"]].",
    },
  ],
};

export default servicesFila;
