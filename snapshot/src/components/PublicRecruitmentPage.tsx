import type { CSSProperties, ReactNode } from "react";
import publicFormBgUrl from "../assets/public-form-bg.jpg";
import {
  Award,
  BadgeCheck,
  BellRing,
  BrainCircuit,
  CalendarClock,
  ClipboardList,
  Clock3,
  Crosshair,
  FileCode2,
  Flame,
  Gauge,
  Gem,
  HandCoins,
  HeartHandshake,
  Landmark,
  LineChart,
  ListChecks,
  MessageCircle,
  Radar,
  Rocket,
  Scale,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Swords,
  Target,
  TrendingUp,
  Trophy,
  UserCheck,
  Users,
  Wallet,
  Wand2,
  Zap,
} from "lucide-react";
import ExoriLogo from "./ExoriLogo";
import { VOC_COLORS } from "../types";

// ============================================================================
// PÁGINA PÚBLICA DE RECRUTAMENTO — CHERNOBYL TEAM
// ----------------------------------------------------------------------------
// Rota: https://chernobyl-pt.web.app/#/serviceiro
//
// Mesmo conceito dos links públicos existentes (PublicServiceForm): a decisão
// de rota acontece em src/main.tsx ANTES do render, fora do Auth Gate — a
// página carrega sem login, sem Firestore e sem nenhuma dependência de dados.
// Conteúdo 100% estático e institucional.
//
// Identidade visual: reaproveita integralmente o tema premium já existente da
// página pública (classe `public-service-form` + psf-quadro/psf-card em
// src/index.css): tokens dark, tipografia fluida (clamp), neon/hover com
// suporte a touch e prefers-reduced-motion. Nenhum CSS novo foi necessário.
//
// Contato: reutiliza o ÚNICO mecanismo público de contato que já existe no
// projeto (WhatsApp do Suporte, o mesmo do rodapé do formulário público).
// Nenhum processo de candidatura/formulário novo foi inventado.
// ============================================================================

// Mesmo link público já usado no rodapé do PublicServiceForm.
const SUPPORT_WHATSAPP_URL = "https://wa.me/5535999349969";

// ── Premissas do cenário de ganhos (validadas matematicamente) ──────────────
//   • 800 RC por Quest/Service (valor médio de referência do Team);
//   • 1.000 RC = R$ 90,00  ⇒  1 RC = R$ 0,09  ⇒  800 RC = R$ 72,00;
//   • segunda a sábado ⇒ 26 dias trabalhados no mês de referência;
//   • 26 × R$ 72,00 = R$ 1.872,00 (×2 = 3.744,00; ×3 = 5.616,00) ✓ coerente.
const EARNING_SCENARIOS = [
  { perDay: 1, label: "1 Quest/Service por dia", value: "R$ 1.872,00", math: "26 dias × R$ 72,00", tone: "#38bdf8", icon: Target },
  { perDay: 2, label: "2 Quests/Services por dia", value: "R$ 3.744,00", math: "26 dias × 2 × R$ 72,00", tone: "#a78bfa", icon: TrendingUp },
  { perDay: 3, label: "3 Quests/Services por dia", value: "R$ 5.616,00", math: "26 dias × 3 × R$ 72,00", tone: "#f59e0b", icon: Flame, badge: "modo \u201Ccracudo\u201D" },
] as const;

// ── Pré-requisitos (conteúdo fornecido — não alterar sem necessidade) ───────
const REQUIREMENTS: { icon: typeof Zap; text: ReactNode }[] = [
  { icon: Rocket, text: <>Ser um jogador <strong className="text-white">proativo</strong>.</> },
  { icon: Swords, text: <>Dominar completamente <strong className="text-white">pelo menos 2 vocações</strong>, incluindo <strong className="text-white">refil e proteções de cada Quest</strong>.</> },
  { icon: Radar, text: <>Saber seguir <strong className="text-white">Call</strong>: quando alguém passar a call, saber executar com facilidade e precisão.</> },
  { icon: Users, text: <>Conhecer as <strong className="text-white">funções básicas de todas as vocações</strong>.</> },
  { icon: Crosshair, text: <>Dominar completamente as <strong className="text-white">mecânicas de todos os Bosses</strong> das Quests <strong className="text-white">Soul War</strong> e <strong className="text-white">Sanguine</strong>.</> },
  { icon: Gauge, text: <>Dominar completamente a <strong className="text-white">rodinha de habilidades</strong> das vocações que joga.</> },
  { icon: Wand2, text: <>Dominar e ter facilidade para <strong className="text-white">"Swapar" Amuletos e Anéis</strong>, principalmente <strong className="text-white">SSA</strong>, <strong className="text-white">Might Ring</strong> e <strong className="text-white">Sacred Tree Amulet</strong>.</> },
  { icon: ShieldCheck, text: <>Ter <strong className="text-white">calma e controle</strong> em situações extremas.</> },
  { icon: Award, text: <>Ter facilidade para realizar as Quests utilizando <strong className="text-white">personagens de nível baixo</strong>.</> },
  { icon: CalendarClock, text: <>Ter <strong className="text-white">compromisso com horários</strong> e cumprir os horários combinados.</> },
  { icon: HandCoins, text: <>Entender que <strong className="text-white">é investindo que se obtém lucro</strong>.</> },
];

// ── Níveis mínimos recomendados (conteúdo fornecido — não alterar) ──────────
// "Mage" cobre Sorcerer/Druid; "EM" = Exalted Monk (cor oficial MK).
const MAGE_COLOR = "#a855f7";
const MIN_LEVELS: { quest: string; accent: string; rows: { voc: string; sub: string; level: number; color: string }[] }[] = [
  {
    quest: "Soul War",
    accent: "#38bdf8",
    rows: [
      { voc: "EK", sub: "Elite Knight", level: 500, color: VOC_COLORS.EK },
      { voc: "RP", sub: "Royal Paladin", level: 500, color: VOC_COLORS.RP },
      { voc: "Mage", sub: "Sorcerer · Druid", level: 400, color: MAGE_COLOR },
      { voc: "EM", sub: "Exalted Monk", level: 550, color: VOC_COLORS.MK },
    ],
  },
  {
    quest: "Sanguine",
    accent: "#f43f5e",
    rows: [
      { voc: "EK", sub: "Elite Knight", level: 750, color: VOC_COLORS.EK },
      { voc: "RP", sub: "Royal Paladin", level: 750, color: VOC_COLORS.RP },
      { voc: "EM", sub: "Exalted Monk", level: 750, color: VOC_COLORS.MK },
      { voc: "Mage", sub: "Sorcerer · Druid", level: 650, color: MAGE_COLOR },
    ],
  },
];

// ── Diferenciais recomendáveis (não obrigatórios) ───────────────────────────
const DIFFERENTIALS: { icon: typeof Zap; title: string; text: string }[] = [
  { icon: Sparkles, title: "Lives na Twitch", text: "Fazer lives na Twitch aproxima clientes, gera confiança e fortalece a imagem do Team." },
  { icon: ShieldCheck, title: "Set básico próprio", text: "Ter seu próprio set básico em cada servidor agiliza a preparação e reduz a dependência de terceiros." },
  { icon: Wallet, title: "Reserva mínima em RC", text: "Ter uma reserva mínima em RC dá fôlego para investir nas oportunidades certas sem travar a operação." },
];

// ── Benefícios da estrutura ─────────────────────────────────────────────────
const BENEFITS: { icon: typeof Zap; tone: string; title: string; body: ReactNode }[] = [
  {
    icon: FileCode2,
    tone: "#22d3ee",
    title: "Seu próprio formulário de Service",
    body: <>Cada Serviceiro poderá ter seu <strong className="text-white">próprio formulário público</strong> através de um link dedicado — os clientes solicitam Services diretamente para você.</>,
  },
  {
    icon: BrainCircuit,
    tone: "#a78bfa",
    title: "Aplicativo completo para gerenciamento",
    body: <>Um aplicativo completo para toda a logística dos Services, incluindo <strong className="text-white">recursos de IA integrados</strong> para auxiliar no gerenciamento das PTs.</>,
  },
  {
    icon: Gem,
    tone: "#34d399",
    title: "Personagens já preparados para compra",
    body: (
      <>
        Possibilidade de escolher entre comprar <strong className="text-white">personagens baratos, já disponíveis e preparados para as Quests</strong>.
        <ul className="mt-2 space-y-1 text-slate-400">
          <li className="flex items-start gap-1.5"><span className="text-emerald-400 mt-0.5">•</span><span>Cada personagem possui seu próprio valor.</span></li>
          <li className="flex items-start gap-1.5"><span className="text-emerald-400 mt-0.5">•</span><span>O valor é exatamente o valor pago no <strong className="text-white">Bazaar do RubinOT</strong>.</span></li>
          <li className="flex items-start gap-1.5"><span className="text-emerald-400 mt-0.5">•</span><span>Os personagens disponíveis ficam entre <strong className="text-white">51 RC e 500 RC</strong>.</span></li>
        </ul>
        <p className="mt-2 text-slate-400">Alternativamente, é possível <strong className="text-white">combinar um valor para realizar o Service de um personagem</strong>, quando essa modalidade for utilizada.</p>
      </>
    ),
  },
  {
    icon: Landmark,
    tone: "#f59e0b",
    title: "Acompanhar o Bazaar oficial do RubinOT",
    body: <>Acompanhe a lista oficial do Bazaar com personagens <strong className="text-white">já filtrados de acordo com as Quests disponíveis</strong> e realize <strong className="text-white">BID</strong> nos próprios personagens.</>,
  },
  {
    icon: Gem,
    tone: "#f472b6",
    title: "Itens valiosos de cada personagem",
    body: <>O sistema permite verificar os <strong className="text-white">itens valiosos existentes em cada personagem</strong> encontrado no Bazaar — você enxerga o valor real antes de bidar.</>,
  },
  {
    icon: BellRing,
    tone: "#fb7185",
    title: "Alertas de BID",
    body: <>Sistema de alertas para <strong className="text-white">reduzir o risco de perder um BID importante</strong> nos leilões que você acompanha.</>,
  },
  {
    icon: ClipboardList,
    tone: "#38bdf8",
    title: "Códigos de import do RTC",
    body: <>Acesso facilitado aos <strong className="text-white">códigos utilizados para importação do RTC</strong>, organizados por vocação e perfil.</>,
  },
  {
    icon: Sparkles,
    tone: "#94a3b8",
    title: "Entre outros recursos",
    body: <>Esses são apenas alguns dos recursos disponíveis — a estrutura do aplicativo oferece <strong className="text-white">diversas outras ferramentas</strong> para facilitar a operação dos Serviceiros no dia a dia.</>,
  },
];

// ── Perfil ideal (resumo em pílulas) ────────────────────────────────────────
const IDEAL_PROFILE: { icon: typeof Zap; label: string; tone: string }[] = [
  { icon: BrainCircuit, label: "Conhecimento", tone: "#38bdf8" },
  { icon: Crosshair, label: "Técnica", tone: "#a78bfa" },
  { icon: Zap, label: "Velocidade", tone: "#f59e0b" },
  { icon: HeartHandshake, label: "Calma", tone: "#34d399" },
  { icon: BadgeCheck, label: "Compromisso", tone: "#22d3ee" },
  { icon: Landmark, label: "Estrutura", tone: "#f472b6" },
  { icon: ListChecks, label: "Disciplina", tone: "#fb7185" },
];

// ── Blocos auxiliares de layout ─────────────────────────────────────────────
function SectionShell({ accent, icon: Icon, title, subtitle, children }: {
  accent: string;
  icon: typeof Zap;
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <section
      className="psf-quadro bg-[var(--th-n-elev)] border rounded-3xl shadow-2xl"
      style={{ "--psf-quadro-accent": accent, borderColor: `${accent}55` } as CSSProperties}
    >
      <div
        className="psf-quadro-header border-b px-7 py-5 flex items-center gap-3"
        style={{
          borderColor: `${accent}33`,
          background: `linear-gradient(90deg, ${accent}14, ${accent}22, ${accent}14)`,
        }}
      >
        <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: `linear-gradient(135deg, ${accent}, color-mix(in oklab, ${accent} 55%, black))` }}>
          <Icon size={20} className="text-black" />
        </div>
        <div className="min-w-0">
          <h2 className="text-base font-black tracking-wide uppercase" style={{ color: `color-mix(in oklab, ${accent} 70%, white)` }}>{title}</h2>
          <p className="text-[11px] text-slate-500">{subtitle}</p>
        </div>
      </div>
      <div className="psf-quadro-inner px-4 py-6 sm:p-7">{children}</div>
    </section>
  );
}

// ============================================================================
// Componente principal
// ============================================================================
export default function PublicRecruitmentPage() {
  return (
    <div className="public-service-form min-h-screen w-full text-slate-200 font-sans relative overflow-x-hidden">
      {/* Imagem de fundo fixa — a mesma identidade da página pública de Service */}
      <div
        className="fixed inset-0 pointer-events-none bg-[var(--th-n-raised)]"
        style={{
          backgroundImage: `url(${publicFormBgUrl})`,
          backgroundSize: "cover",
          backgroundPosition: "50% 50%",
          backgroundRepeat: "no-repeat",
          zIndex: 0,
        }}
      />
      <div className="fixed inset-0 bg-[var(--th-n-raised)]/90 pointer-events-none" style={{ zIndex: 1 }} />
      <div className="fixed inset-0 overflow-hidden pointer-events-none" style={{ zIndex: 2 }}>
        <div className="absolute -top-[20%] -left-[10%] w-[60%] h-[60%] rounded-full bg-red-600/8 blur-[140px]" />
        <div className="absolute -bottom-[20%] -right-[10%] w-[60%] h-[60%] rounded-full bg-cyan-500/8 blur-[140px]" />
        <div className="absolute top-[30%] left-[40%] w-[40%] h-[40%] rounded-full bg-amber-500/5 blur-[120px]" />
      </div>

      {/* ===== CABEÇALHO FIXO — mesma marca das páginas públicas ===== */}
      <header className="fixed top-0 left-0 right-0 z-50 bg-[var(--th-n-raised)]/50 backdrop-blur-md border-b border-white/5 shadow-lg shadow-black/100">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-0 flex items-center justify-center gap-3">
          <ExoriLogo size={35} className="drop-shadow-[0_0_12px_color-mix(in_oklab,var(--color-red-600)_60%,transparent)] flex-shrink-0" />
          <div className="text-center">
            <h1 className="text-xl sm:text-3xl font-black bg-gradient-to-r from-red-600 via-orange-500 to-yellow-400 bg-clip-text text-transparent tracking-tight leading-none" style={{ filter: "drop-shadow(0 0 8px color-mix(in oklab, var(--color-red-600) 40%, transparent))" }}>
              Chernobyl PT
            </h1>
            <p className="text-left text-emerald-400 text-[6px] tracking-widest uppercase font-semibold leading-tight mt-0">By Exori Coins</p>
          </div>
        </div>
      </header>

      <div className="relative z-10 w-full max-w-3xl mx-auto px-3 sm:px-6 pt-28 pb-12 space-y-8">

        {/* ================================================================
            1. HERO / APRESENTAÇÃO
            ================================================================ */}
        <section className="text-center space-y-5 py-6 sm:py-10">
          <div className="inline-flex items-center gap-2 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-4 py-1.5 text-[10px] font-black uppercase tracking-[0.2em] text-cyan-300">
            <Radar size={12} className="flex-shrink-0" /> Recrutamento aberto
          </div>
          <div className="space-y-3">
            <h2 className="text-2xl sm:text-4xl font-black tracking-tight text-white leading-tight" style={{ filter: "drop-shadow(0 6px 24px rgb(0 0 0 / 0.6))" }}>
              Chernobyl Team
            </h2>
            <p className="mx-auto max-w-xl text-base sm:text-xl font-black leading-snug bg-gradient-to-r from-cyan-300 via-sky-300 to-violet-300 bg-clip-text text-transparent">
              Transforme sua experiência no Tibia em uma profissão.
            </p>
          </div>
          <p className="mx-auto max-w-2xl text-sm text-slate-400 leading-relaxed">
            O <strong className="text-white">Chernobyl Team</strong> busca pessoas que compartilham os mesmos
            interesses dos nossos Serviceiros e que desejam transformar essa atividade em uma
            <strong className="text-white"> profissão e fonte de renda</strong>. Procuramos jogadores
            comprometidos, habilidosos e interessados em trabalhar profissionalmente com
            <strong className="text-white"> Services e Quests</strong> — com organização, método e uma
            estrutura completa por trás.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
            {[
              { icon: Trophy, label: "Operação profissional" },
              { icon: BrainCircuit, label: "Estrutura + tecnologia" },
              { icon: Scale, label: "Transparência total" },
            ].map(({ icon: Icon, label }) => (
              <span key={label} className="inline-flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[11px] font-bold text-slate-300">
                <Icon size={13} className="text-cyan-400 flex-shrink-0" /> {label}
              </span>
            ))}
          </div>
        </section>

        {/* ================================================================
            2. O QUE PROCURAMOS
            ================================================================ */}
        <SectionShell accent="#22d3ee" icon={UserCheck} title="O que procuramos" subtitle="O perfil que buscamos para o Team">
          <div className="space-y-6">
            <div className="rounded-2xl border border-cyan-500/20 bg-cyan-500/[0.06] px-5 py-4">
              <p className="text-sm text-slate-300 leading-relaxed">
                Procuramos jogadores que tenham interesse em <strong className="text-white">trabalhar
                profissionalmente com Services</strong>, que sejam <strong className="text-white">comprometidos</strong>,
                tenham <strong className="text-white">domínio técnico do jogo</strong> e estejam dispostos a
                <strong className="text-white"> investir tempo, conhecimento e estrutura</strong> para obter resultados.
              </p>
            </div>

            {/* Pré-requisitos */}
            <div>
              <h3 className="flex items-center gap-2 text-sm font-black text-white uppercase tracking-wider mb-4">
                <span className="w-7 h-7 rounded-lg bg-cyan-500/15 border border-cyan-500/30 flex items-center justify-center"><ListChecks size={14} className="text-cyan-300" /></span>
                Pré-requisitos
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {REQUIREMENTS.map(({ icon: Icon, text }, i) => (
                  <div key={i} className="psf-card flex items-start gap-3 rounded-2xl border border-white/5 bg-[var(--th-n-panel)] px-4 py-3" style={{ "--psf-accent": "#22d3ee" } as CSSProperties}>
                    <span className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg border border-cyan-500/25 bg-cyan-500/10">
                      <Icon size={13} className="text-cyan-300" />
                    </span>
                    <span className="text-xs text-slate-300 leading-relaxed">{text}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Níveis mínimos recomendados */}
            <div>
              <h3 className="flex items-center gap-2 text-sm font-black text-white uppercase tracking-wider mb-1.5">
                <span className="w-7 h-7 rounded-lg bg-rose-500/15 border border-rose-500/30 flex items-center justify-center"><Gauge size={14} className="text-rose-300" /></span>
                Níveis mínimos recomendados
              </h3>
              <p className="text-[11px] text-slate-500 mb-4">Um dos pontos importantes da seleção — referência por Quest e vocação.</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {MIN_LEVELS.map(({ quest, accent, rows }) => (
                  <div key={quest} className="psf-card rounded-2xl border bg-[var(--th-n-panel)] p-4" style={{ "--psf-accent": accent, borderColor: `${accent}33` } as CSSProperties}>
                    <div className="mb-3 flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: accent, boxShadow: `0 0 10px ${accent}` }} />
                      <span className="text-sm font-black uppercase tracking-wider" style={{ color: `color-mix(in oklab, ${accent} 70%, white)` }}>{quest}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      {rows.map(({ voc, sub, level, color }) => (
                        <div key={`${quest}-${voc}`} className="psf-voc rounded-xl border bg-black/20 p-2.5 text-center" style={{ "--voc-color": color } as CSSProperties}>
                          <div className="psf-voc-letter text-sm font-black tracking-wider" style={{ color: `color-mix(in oklab, ${color} 62%, white)` }}>{voc}</div>
                          <div className="text-[8px] uppercase tracking-wider text-slate-500 mb-1">{sub}</div>
                          <div className="psf-voc-badge inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-black tabular-nums" style={{ color: `color-mix(in oklab, ${color} 62%, white)`, borderColor: `${color}44`, backgroundColor: `${color}11` }}>{level}+</div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Diferenciais recomendáveis */}
            <div>
              <h3 className="flex items-center gap-2 text-sm font-black text-white uppercase tracking-wider mb-1.5">
                <span className="w-7 h-7 rounded-lg bg-amber-500/15 border border-amber-500/30 flex items-center justify-center"><Sparkles size={14} className="text-amber-300" /></span>
                Diferenciais recomendáveis
              </h3>
              <p className="text-[11px] text-slate-500 mb-4">Não são obrigatórios — mas contam pontos importantes na seleção.</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                {DIFFERENTIALS.map(({ icon: Icon, title, text }) => (
                  <div key={title} className="psf-card rounded-2xl border border-amber-500/15 bg-[var(--th-n-panel)] p-4 text-center" style={{ "--psf-accent": "#f59e0b" } as CSSProperties}>
                    <span className="mx-auto mb-2 flex h-9 w-9 items-center justify-center rounded-xl border border-amber-500/25 bg-amber-500/10">
                      <Icon size={16} className="text-amber-300" />
                    </span>
                    <div className="text-xs font-black text-amber-200 uppercase tracking-wide mb-1">{title}</div>
                    <p className="text-[11px] text-slate-400 leading-relaxed">{text}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </SectionShell>

        {/* ================================================================
            3. BENEFÍCIOS
            ================================================================ */}
        <SectionShell accent="#34d399" icon={Gem} title="Benefícios do Chernobyl Team" subtitle="A estrutura completa que você recebe ao fazer parte">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {BENEFITS.map(({ icon: Icon, tone, title, body }, i) => (
              <div
                key={title}
                className={`psf-card rounded-2xl border bg-[var(--th-n-panel)] p-4 ${i === 2 ? "sm:col-span-2" : ""}`}
                style={{ "--psf-accent": tone, borderColor: `${tone}26` } as CSSProperties}
              >
                <div className="mb-2 flex items-center gap-2.5">
                  <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border" style={{ borderColor: `${tone}40`, backgroundColor: `${tone}14` }}>
                    <Icon size={15} style={{ color: `color-mix(in oklab, ${tone} 75%, white)` }} />
                  </span>
                  <span className="text-xs font-black uppercase tracking-wide" style={{ color: `color-mix(in oklab, ${tone} 70%, white)` }}>{title}</span>
                </div>
                <div className="text-xs text-slate-300 leading-relaxed">{body}</div>
              </div>
            ))}
          </div>
        </SectionShell>

        {/* ================================================================
            4. POTENCIAL DE GANHOS
            ================================================================ */}
        <SectionShell accent="#f59e0b" icon={LineChart} title="Potencial de ganhos" subtitle="Simulações de referência — não são promessa de ganho garantido">
          <div className="space-y-5">
            {/* Premissas do cálculo — matemática explícita e verificável */}
            <div className="rounded-2xl border border-white/10 bg-black/20 px-5 py-4">
              <div className="mb-3 flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.15em] text-slate-400">
                <ClipboardList size={13} className="text-amber-400" /> Premissas do cenário utilizado pelo Team
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-center">
                <div className="rounded-xl border border-white/5 bg-white/[0.03] px-3 py-2.5">
                  <div className="text-sm font-black text-white tabular-nums">800 RC</div>
                  <div className="text-[9px] uppercase tracking-wider text-slate-500">valor médio por Quest/Service</div>
                </div>
                <div className="rounded-xl border border-white/5 bg-white/[0.03] px-3 py-2.5">
                  <div className="text-sm font-black text-white tabular-nums">1.000 RC = R$ 90,00</div>
                  <div className="text-[9px] uppercase tracking-wider text-slate-500">conversão utilizada</div>
                </div>
                <div className="rounded-xl border border-white/5 bg-white/[0.03] px-3 py-2.5">
                  <div className="text-sm font-black text-white">Segunda a sábado</div>
                  <div className="text-[9px] uppercase tracking-wider text-slate-500">26 dias no mês de referência</div>
                </div>
              </div>
              <p className="mt-3 text-[11px] text-slate-500 leading-relaxed text-center">
                Pela conversão, <strong className="text-slate-300">800 RC ≈ R$ 72,00</strong> por Quest/Service.
                Trabalhando de segunda a sábado, o mês de referência soma <strong className="text-slate-300">26 dias</strong> — é daí que saem os valores abaixo.
              </p>
            </div>

            {/* Cenários */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {EARNING_SCENARIOS.map(({ perDay, label, value, math, tone, icon: Icon, ...rest }) => (
                <div key={perDay} className="psf-card relative rounded-2xl border bg-[var(--th-n-panel)] p-5 text-center" style={{ "--psf-accent": tone, borderColor: `${tone}33` } as CSSProperties}>
                  {"badge" in rest && rest.badge ? (
                    <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 rounded-full border border-amber-500/40 bg-[var(--th-n-elev)] px-2.5 py-0.5 text-[8px] font-black uppercase tracking-widest text-amber-300">{rest.badge}</span>
                  ) : null}
                  <span className="mx-auto mb-2.5 flex h-10 w-10 items-center justify-center rounded-xl border" style={{ borderColor: `${tone}40`, backgroundColor: `${tone}14` }}>
                    <Icon size={18} style={{ color: `color-mix(in oklab, ${tone} 75%, white)` }} />
                  </span>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1.5">{label}</div>
                  <div className="psf-pay-value text-xl font-black tabular-nums" style={{ color: `color-mix(in oklab, ${tone} 70%, white)` }}>{value}</div>
                  <div className="mt-1 text-[9px] font-mono text-slate-500">{math}</div>
                  <div className="mt-2 text-[9px] uppercase tracking-widest text-slate-600">alvo de referência mensal</div>
                </div>
              ))}
            </div>

            {/* Disclaimer — potencial, não promessa */}
            <div className="flex items-start gap-2.5 rounded-xl border border-amber-500/25 bg-amber-500/[0.07] px-4 py-3">
              <ShieldAlert size={15} className="mt-0.5 flex-shrink-0 text-amber-400" />
              <p className="text-[11px] text-amber-200/90 leading-relaxed">
                Os valores acima são <strong className="text-amber-100">simulações e alvos de referência</strong> baseados nas
                premissas apresentadas — eles mostram <strong className="text-amber-100">potencial de faturamento</strong>, e
                <strong className="text-amber-100"> não constituem promessa de ganho garantido</strong>. Os resultados reais
                dependem de demanda, desempenho, agenda e condições do jogo.
              </p>
            </div>
          </div>
        </SectionShell>

        {/* ================================================================
            5. A REALIDADE DO TRABALHO
            ================================================================ */}
        <SectionShell accent="#94a3b8" icon={Scale} title="A realidade do trabalho" subtitle="Transparência antes de qualquer expectativa">
          <div className="space-y-4">
            <div className="rounded-2xl border-l-4 border border-slate-500/30 bg-white/[0.03] px-5 py-4" style={{ borderLeftColor: "#94a3b8" }}>
              <p className="text-sm text-slate-200 font-bold leading-relaxed">
                Não se iluda com os números. O trabalho muitas vezes é cansativo e exige paciência para alcançar resultados.
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="psf-card rounded-2xl border border-white/5 bg-[var(--th-n-panel)] p-4" style={{ "--psf-accent": "#38bdf8" } as CSSProperties}>
                <div className="mb-2 flex items-center gap-2 text-sky-300 text-xs font-black uppercase tracking-wide">
                  <Clock3 size={14} className="flex-shrink-0" /> Cada minuto é valioso
                </div>
                <p className="text-xs text-slate-300 leading-relaxed">
                  Quanto menos tempo levar para concluir uma Quest, mais tempo teremos para realizar
                  outra Quest — ou simplesmente descansar.
                </p>
              </div>
              <div className="psf-card rounded-2xl border border-white/5 bg-[var(--th-n-panel)] p-4" style={{ "--psf-accent": "#a78bfa" } as CSSProperties}>
                <div className="mb-2 flex items-center gap-2 text-violet-300 text-xs font-black uppercase tracking-wide">
                  <Gauge size={14} className="flex-shrink-0" /> Resultado se constrói
                </div>
                <p className="text-xs text-slate-300 leading-relaxed">
                  Produtividade, organização, experiência, preparo e disciplina influenciam
                  <strong className="text-white"> diretamente</strong> os resultados de cada Serviceiro.
                </p>
              </div>
            </div>
          </div>
        </SectionShell>

        {/* ================================================================
            6. LIMITE DE GANHOS
            ================================================================ */}
        <SectionShell accent="#fb7185" icon={ShieldAlert} title="Limite de ganhos" subtitle="Comunicação transparente — sem pessimismo e sem promessa exagerada">
          <div className="space-y-4">
            <div className="rounded-2xl border-l-4 border border-rose-500/25 bg-rose-500/[0.05] px-5 py-4" style={{ borderLeftColor: "#fb7185" }}>
              <p className="text-sm text-slate-200 font-bold leading-relaxed">
                Todos devem entender que existe um teto máximo de ganhos.
              </p>
            </div>
            <p className="text-xs text-slate-300 leading-relaxed">
              A quantidade de Services que cabe em um dia é limitada — e, portanto, o faturamento também é.
              Essa atividade <strong className="text-white">não deve ser tratada como única fonte de renda garantida</strong>.
            </p>
            <div className="flex items-start gap-2.5 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
              <HeartHandshake size={15} className="mt-0.5 flex-shrink-0 text-rose-300" />
              <p className="text-[11px] text-slate-400 leading-relaxed">
                Por isso, recomendamos que todos tenham <strong className="text-slate-200">outras fontes de renda</strong> e
                não dependam exclusivamente dos Services realizados pelo Team.
              </p>
            </div>
          </div>
        </SectionShell>

        {/* ================================================================
            7. PERFIL IDEAL
            ================================================================ */}
        <SectionShell accent="#a78bfa" icon={Trophy} title="Perfil ideal" subtitle="O resumo de um bom integrante do Team">
          <div className="space-y-5">
            <div className="flex flex-wrap items-center justify-center gap-2">
              {IDEAL_PROFILE.map(({ icon: Icon, label, tone }, i) => (
                <span key={label} className="inline-flex items-center gap-2">
                  <span
                    className="psf-choice inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-[11px] font-black uppercase tracking-wide"
                    style={{ "--psf-accent": tone, borderColor: `${tone}40`, backgroundColor: `${tone}10`, color: `color-mix(in oklab, ${tone} 70%, white)` } as CSSProperties}
                  >
                    <Icon size={13} className="flex-shrink-0" /> {label}
                  </span>
                  {i < IDEAL_PROFILE.length - 1 && <span className="text-slate-600 font-black">+</span>}
                </span>
              ))}
            </div>
            <p className="text-center text-[11px] text-slate-500 leading-relaxed">
              Sete pilares, um resultado: uma operação <strong className="text-slate-300">rápida, segura e consistente</strong> — Quest após Quest.
            </p>
          </div>
        </SectionShell>

        {/* ================================================================
            8. ENCERRAMENTO / INTERESSE
            ================================================================ */}
        <section
          className="psf-quadro relative overflow-hidden rounded-3xl border border-cyan-500/30 bg-[var(--th-n-elev)] px-6 py-10 sm:px-10 sm:py-12 text-center shadow-2xl"
          style={{ "--psf-quadro-accent": "#22d3ee" } as CSSProperties}
        >
          {/* brilho decorativo interno */}
          <div className="pointer-events-none absolute inset-0">
            <div className="absolute -top-1/2 left-1/2 h-full w-[120%] -translate-x-1/2 rounded-full bg-cyan-500/10 blur-[90px]" />
          </div>
          <div className="relative space-y-5">
            <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-cyan-500/40 bg-cyan-500/10">
              <Swords size={26} className="text-cyan-300" />
            </span>
            <h2 className="text-xl sm:text-3xl font-black tracking-tight leading-tight">
              <span className="text-white">Você já possui a experiência.</span>
              <br />
              <span className="bg-gradient-to-r from-cyan-300 via-sky-300 to-violet-300 bg-clip-text text-transparent">Nós fornecemos a estrutura.</span>
            </h2>
            <p className="mx-auto max-w-xl text-sm text-slate-400 leading-relaxed">
              Se você se identifica com essa proposta, joga com seriedade e quer transformar seu domínio do jogo
              em uma operação profissional, o <strong className="text-white">Chernobyl Team</strong> quer conhecer você.
            </p>
            <div className="pt-1">
              <a
                href={SUPPORT_WHATSAPP_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="psf-submit inline-flex items-center justify-center gap-2.5 rounded-2xl bg-gradient-to-r from-cyan-400 to-sky-500 px-8 py-4 text-base font-black tracking-wide text-black shadow-xl shadow-cyan-500/25 transition-all duration-300 hover:from-cyan-300 hover:to-sky-400 hover:shadow-cyan-500/40 hover:scale-[1.02] active:scale-[0.98]"
              >
                <MessageCircle size={19} /> Falar com o Team no WhatsApp
              </a>
              <p className="mt-3 text-[10px] text-slate-600">
                Mesmo canal oficial de suporte do Chernobyl PT — sem formulários, sem burocracia.
              </p>
            </div>
          </div>
        </section>

        {/* ===== RODAPÉ — idêntico ao padrão das páginas públicas ===== */}
        <div className="text-center pt-2 space-y-2">
          <div className="flex items-center justify-center gap-2 text-[11px] text-slate-600">
            <MessageCircle size={12} className="text-emerald-500/60" />
            <span>Dúvidas? Fale conosco: <a href={SUPPORT_WHATSAPP_URL} target="_blank" rel="noopener noreferrer" className="text-emerald-400/80 hover:text-emerald-300 font-semibold">WhatsApp do Suporte</a></span>
          </div>
          <p className="text-[10px] text-slate-700">Chernobyl PT · By Exori Coins</p>
        </div>
      </div>
    </div>
  );
}
