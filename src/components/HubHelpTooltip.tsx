import { createPortal } from "react-dom";
import type { RefObject } from "react";

type HelpType = "privado" | "publico";

interface HelpItem {
  title: string;
  text: string;
  tone: "emerald" | "orange" | "sky" | "violet" | "amber" | "rose" | "slate";
}

interface HubHelpTooltipProps {
  type: HelpType;
  tooltipRef: RefObject<HTMLDivElement | null>;
  position: { top: number; left: number };
}

const toneClass: Record<HelpItem["tone"], string> = {
  emerald: "text-emerald-400 border-emerald-500/20 bg-emerald-500/5",
  orange: "text-orange-400 border-orange-500/20 bg-orange-500/5",
  sky: "text-sky-400 border-sky-500/20 bg-sky-500/5",
  violet: "text-violet-400 border-violet-500/20 bg-violet-500/5",
  amber: "text-amber-400 border-amber-500/20 bg-amber-500/5",
  rose: "text-rose-400 border-rose-500/20 bg-rose-500/5",
  slate: "text-slate-300 border-slate-500/20 bg-slate-500/5",
};

const privateItems: HelpItem[] = [
  { title: "Meus Personagens", text: "Cadastre, edite, marque como vendidos, controle quests, drops, lucro, anotações e compartilhamento.", tone: "emerald" },
  { title: "Meu Histórico de PT's", text: "Consulte o histórico privado das PT's em que você participou, com todos os personagens, donos, jogadores, drops, lucros e participação na divisão no momento da conclusão, atualizado em tempo real e com resumo pronto para WhatsApp via Copiar (WA).", tone: "orange" },
  { title: "Disponíveis / Vendidos", text: "Dentro de Meus Personagens, alterne entre os personagens disponíveis e os vendidos. Em VENDIDOS você consulta datas, valores e resultado financeiro sem misturar com os ativos.", tone: "orange" },
  { title: "Estatísticas", text: "Acompanhe PTs concluídas, mortes, duração média, parceiros, services, doações e desempenho geral.", tone: "sky" },
  { title: "Ranking", text: "Compare ranking universal por Mês Atual e Último Mês, com modos de ordenação e cards completos. Dispute com seus amigos as melhores posições.", tone: "amber" },
  { title: "Notas", text: "Use um bloco pessoal para lembretes, combinações, registros e organização rápida.", tone: "violet" },
  { title: "Bazaar", text: "Consulte personagens, use filtros, acompanhe encerramentos, marque interesse em personagens, receba informações e notificações dos leilões.", tone: "rose" },
  { title: "Importar / Exportar", text: "Gere backup pessoal em JSON/CSV e restaure personagens, notas e histórico local quando necessário.", tone: "emerald" },
  { title: "Auto-Save", text: "Configure salvamento local automático para manter um backup pessoal sempre atualizado em tempo real no dispositivo.", tone: "amber" },
  { title: "Calculadoras", text: "Use o conversor RC>KK>R$ para saber quanto vale em R$ cada RC no servidor que deseja negociar. Calculadora do windowns disponivel apenas pelo aplicativo.", tone: "sky" },
  { title: "Notificações Desktop", text: "Ative as notificações para serem exibidas no seu Windows, facilitando visualização, que ao ser clicada, navega automaticamente para a PT relacionada.", tone: "orange" },
  { title: "Preferências locais", text: "Ajuste zoom, baixo uso de CPU, auto-login e visual. Suas preferências ficam salvas no navegador/app.", tone: "slate" },
];

const publicItems: HelpItem[] = [
  { title: "Gerenciador de PTs", text: "Crie PTs públicas/privadas, adicione membros, defina servidor, líder, quest e controle andamento.", tone: "emerald" },
  { title: "Sugerir PT (Recomendado usar o Modo IA)", text: "Monte composições usando modo IA (Auto) ou Manual, configure força, levels, amigos, services e filtros do servidor feito por IA.", tone: "amber" },
  { title: "Sugerir Outra Composição (Apenas no Modo IA)", text: "Navegue por composições alternativas válidas seguindo a prioridade da Inteligencia Artificial que calcula em tempo real as melhores composições.", tone: "violet" },
  { title: "PT Pública / Privada", text: "Públicas são visíveis amplamente; privadas respeitam convidados e amigos autorizados.", tone: "sky" },
  { title: "Horário da PT", text: "Defina ou edite horário; participantes recebem notificação persistente quando houver alteração.", tone: "orange" },
  { title: "Drops e Split", text: "Registre drops e valores vendidos para realizar divisões com total segurança, garantida por notificações a cada movimentação, bloqueio de PTs até que todos sejam pagos e mecanismos antifraude, sendo uma opção recomendada para quem busca estabilidade nos lucros por cada quest feita, já que, a longo prazo, a média matemática se iguala entre quem divide ou não, restando como única diferença a suavização da variação de rendimentos.", tone: "emerald" },
  { title: "Pagamentos", text: "Essa opção será usada apenas para quem optar por dividir. Existem controles de pagamentos por membro, botões que facilitam na hora de copiar o personagem para enviar os RC de cada usuário, contendo a quantidade a ser enviada. Finalize a PT após splits e valores estarem resolvidos. Notificações são enviadas a cada movimentação.", tone: "amber" },
  { title: "Att Chars", text: "Atualize personagens após Quest Concluída com base nos dados atuais da PT ativa ou arquivada. Atualiza automaticamente caso ", tone: "sky" },
  { title: "Auto-Att", text: "Quando ativo, executa Att Chars automaticamente uma única vez por notificação persistida.", tone: "violet" },
  { title: "Histórico de PTs", text: "Consulte PTs arquivadas de forma resumida com os principais dados a disposição. Recomendado manter histórico local de backup pois PT's Arquivadas são limpas periodicamente da núvem.", tone: "orange" },
  { title: "Services", text: "Cadastre e gerencie personagens de service com contato, triagem, valor combinado e quest. Envie o formulário público para que o seu cliente adicione o personagem dele optando por você ser o serviceiro, ou qualquer outro usuário. Para ser adicionado como um Serviceiro e poder ser escolhido por clientes, fale com um administrador.", tone: "sky" },
  { title: "Formulário Público", text: "Clientes podem enviar solicitações de Service por link público, com dados padronizados e exibidos automaticamente na janela de Services.", tone: "emerald" },
  { title: "Friends", text: "Busque usuários, envie/aceite pedidos e use amizades para visibilidade e filtros de personagens.", tone: "amber" },
  { title: "VIP", text: "Solicite planos VIP, acompanhe dias restantes e libere recursos exclusivos para VIP, incluindo a função de Services.", tone: "violet" },
  { title: "Doações", text: "Registre envio de RC, copie personagem recebedor e acompanhe média de colaboração por PT.", tone: "rose" },
  { title: "Personagens Compartilhados", text: "Use personagens próprios e de amigos autorizados com cache e atualização manual quando necessário.", tone: "emerald" },
  { title: "Sistema de Notificações", text: "Você recebe notificações quando for adicionado em uma PT, horário alterado, pagamento, VIP, Quest Concluída e histórico de notificações.", tone: "amber" },
];

export default function HubHelpTooltip({ type, tooltipRef, position }: HubHelpTooltipProps) {
  const isPrivate = type === "privado";
  const items = isPrivate ? privateItems : publicItems;
  const title = isPrivate ? "Guia rápido — Área Privada" : "Guia rápido — Área Pública";
  const subtitle = isPrivate
    ? "Recursos pessoais, métricas e preferências do seu aplicativo."
    : "Recursos compartilhados para PTs, services, amigos, VIP e notificações.";

  return createPortal(
    <div
      ref={tooltipRef}
      className="fixed w-[min(440px,calc(100vw-16px))] max-h-[72vh] overflow-hidden bg-[var(--th-bg-base)]/95 border border-[var(--th-line)]/80 rounded-xl shadow-2xl shadow-black/70 z-[9999]"
      style={{ top: position.top, left: position.left, backdropFilter: "blur(10px)" }}
    >
      <div className="p-4 border-b border-[var(--th-line)]/60 bg-gradient-to-r from-[var(--th-bg-raised)] to-[var(--th-bg-deep)]">
        <div className="text-sm font-black text-amber-300 tracking-wide">{title}</div>
        <p className="text-[10px] text-slate-500 mt-1 leading-relaxed">{subtitle}</p>
      </div>
      <div className="p-3 max-h-[calc(72vh-74px)] overflow-y-auto custom-scrollbar space-y-2">
        {items.map(item => (
          <div key={item.title} className={`rounded-lg border px-3 py-2 ${toneClass[item.tone]}`}>
            <div className="text-[11px] font-black uppercase tracking-wider mb-0.5">{item.title}</div>
            <div className="text-[10px] leading-relaxed text-slate-300">{item.text}</div>
          </div>
        ))}
      </div>
    </div>,
    document.body
  );
}