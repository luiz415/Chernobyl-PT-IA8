import { createPortal } from "react-dom";
import {
  Crown,
  X,
  Wrench,
  Calculator,
  Trophy,
  Swords,
  ShoppingBag,
  Sparkles,
} from "lucide-react";

interface VipBenefitsModalProps {
  open: boolean;
  onClose: () => void;
}

const colorMap = {
  amber: {
    icon: "text-amber-400",
    border: "border-amber-500/20",
    bg: "bg-amber-500/5",
    bullet: "bg-amber-400/70",
  },
  emerald: {
    icon: "text-emerald-400",
    border: "border-emerald-500/20",
    bg: "bg-emerald-500/5",
    bullet: "bg-emerald-400/70",
  },
  violet: {
    icon: "text-violet-400",
    border: "border-violet-500/20",
    bg: "bg-violet-500/5",
    bullet: "bg-violet-400/70",
  },
  sky: {
    icon: "text-sky-400",
    border: "border-sky-500/20",
    bg: "bg-sky-500/5",
    bullet: "bg-sky-400/70",
  },
  rose: {
    icon: "text-rose-400",
    border: "border-rose-500/20",
    bg: "bg-rose-500/5",
    bullet: "bg-rose-400/70",
  },
} as const;

/** Informações completas reutilizadas pelos fluxos "VIP" e "Seja VIP". */
const VIP_BENEFITS = [
  {
    icon: ShoppingBag,
    color: "rose",
    title: "Painel Bazaar",
    description:
      "Acesse a lista oficial do Bazaar com filtros avançados, horários de encerramento, prioridades por servidor e personagens destacados por oportunidade.",
    highlight: "Marque interesses, acompanhe leilões e receba alertas para organizar compras com mais segurança.",
  },
  {
    icon: Wrench,
    color: "amber",
    title: "Services",
    description:
      "Gerencie seus Services de forma completa dentro do aplicativo. Cadastre personagens, organize seus serviços e disponibilize seu formulário público para que clientes agendem diretamente com você.",
    highlight: "Seu nome entra automaticamente na lista de Serviceiros, visível para todos os jogadores.",
  },
  {
    icon: Calculator,
    color: "emerald",
    title: "Calculadora RC / KK / R$",
    description:
      "Acesse a calculadora exclusiva do Chernobyl PT. Ela calcula em tempo real o valor de cada KK com base no preço atual da RC no Market do servidor selecionado.",
    highlight: "Ideal para negociações precisas e avaliações de mercado.",
  },
  {
    icon: Trophy,
    color: "violet",
    title: "Destaque no Ranking",
    description:
      "Seu perfil recebe um destaque visual exclusivo no Ranking do aplicativo, tornando-o facilmente reconhecível entre os demais jogadores.",
    highlight: "Uma identidade diferenciada que reforça seu prestígio na comunidade.",
  },
  {
    icon: Swords,
    color: "sky",
    title: "Visualização de PTs",
    description:
      "Veja de forma rápida e organizada todas as PTs disponíveis com vagas abertas, facilitando a busca por grupos para quests e eventos.",
    highlight: "Encontre seu grupo com muito mais agilidade.",
  },
] as const;

/**
 * Janela compartilhada de benefícios. Ela fica acima do modal que a abriu,
 * preservando-o abaixo para que o cliente retorne exatamente ao seu fluxo.
 */
export default function VipBenefitsModal({ open, onClose }: VipBenefitsModalProps) {
  if (!open) return null;

  return createPortal(
    <div
      className="app-modal-overlay fixed inset-0 z-[650] flex items-center justify-center bg-black/85 backdrop-blur-sm animate-in fade-in duration-200"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Benefícios Inclusos do VIP"
        className="app-modal-frame app-modal-size-md app-modal-frame--scroll w-full rounded-2xl border border-amber-500/35 bg-[var(--th-bg-base)] shadow-2xl shadow-amber-950/50 animate-in zoom-in-95 duration-200"
      >
        <header className="app-modal-header flex items-center justify-between gap-3 border-b border-amber-500/20 bg-gradient-to-r from-amber-950/45 via-amber-900/15 to-[var(--th-bg-base)] px-4 py-3 sm:px-5">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl border border-amber-500/35 bg-amber-500/15">
              <Crown size={16} className="text-amber-300" />
            </div>
            <div className="min-w-0">
              <h2 className="truncate text-sm font-black uppercase tracking-wide text-amber-200">Benefícios Inclusos</h2>
              <p className="text-[10px] text-slate-400">Tudo o que acompanha o seu acesso VIP.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar benefícios inclusos"
            className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-amber-500/10 hover:text-white cursor-pointer"
          >
            <X size={16} />
          </button>
        </header>

        <div className="app-modal-body space-y-2.5 p-3 sm:p-4">
          <div className="flex items-start gap-2.5 rounded-xl border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2.5 text-[11px] leading-relaxed text-slate-300">
            <Sparkles size={15} className="mt-0.5 flex-shrink-0 text-amber-300" />
            <p>Os recursos abaixo são apresentados de forma centralizada para você consultar quando precisar.</p>
          </div>

          {VIP_BENEFITS.map(benefit => {
            const Icon = benefit.icon;
            const colors = colorMap[benefit.color];
            return (
              <article key={benefit.title} className={`rounded-xl border ${colors.border} ${colors.bg} p-3 sm:p-3.5`}>
                <div className="flex items-start gap-2.5">
                  <div className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border ${colors.border} bg-black/25`}>
                    <Icon size={15} className={colors.icon} />
                  </div>
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <h3 className="text-xs font-black text-white">{benefit.title}</h3>
                    <p className="text-[11px] leading-relaxed text-slate-400">{benefit.description}</p>
                    <div className="flex items-start gap-1.5 pt-0.5 text-[10px] font-semibold leading-snug">
                      <span className={`mt-[3px] h-1.5 w-1.5 flex-shrink-0 rounded-full ${colors.bullet}`} />
                      <span className={colors.icon}>{benefit.highlight}</span>
                    </div>
                  </div>
                </div>
              </article>
            );
          })}
        </div>

        <footer className="app-modal-footer flex justify-end border-t border-amber-500/20 bg-black/30 px-4 py-3 sm:px-5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-amber-500/35 bg-amber-500/12 px-4 py-2 text-xs font-black text-amber-200 transition-colors hover:bg-amber-500/22 cursor-pointer"
          >
            Voltar
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}