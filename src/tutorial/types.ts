// ============================================================================
// TUTORIAL INTERATIVO — CONTRATOS CENTRAIS
// ----------------------------------------------------------------------------
// O tutorial é 100% declarativo: cada painel do aplicativo vira um TÓPICO
// (arquivo próprio em src/tutorial/topics/) composto por CENAS. O motor
// (TutorialContext + TutorialOverlay) interpreta essas estruturas — adicionar
// um painel novo no futuro é criar um arquivo de tópico e registrá-lo em
// registry.ts, sem tocar no motor.
//
// Ancoragem: cada cena aponta para um elemento REAL da interface através de um
// id estável gravado no atributo `data-tour` do componente (mesmo padrão já
// usado no projeto com data-party-tab-id / data-waiting-id). Se o elemento não
// existir no momento da cena (ex.: painel condicional), a cena degrada para o
// modo "informativo" (balão central, sem spotlight) usando `fallbackBody` —
// o tutorial NUNCA quebra por causa de um anchor ausente.
// ============================================================================
import type { ComponentType } from "react";

/** Comando de navegação declarativo executado ANTES de medir o anchor da cena.
 *  Os handlers são registrados pelos próprios componentes (App/PartyManager)
 *  via registerTourCommands — o tutorial nunca importa setters diretamente. */
export interface TourNavCommand {
  cmd: string;
  arg?: unknown;
}

export interface TourScene {
  /** Id estável da cena (progresso/depuração). */
  id: string;
  title: string;
  /**
   * Texto detalhado. Parágrafos separados por "\n\n".
   * Suporta cores inline via [[tom:texto]] — tons: emerald, violet, sky,
   * amber, rose, slate e "vip" (selo para funcionalidades exclusivas VIP).
   * Renderizado por renderColoredText no TutorialOverlay.
   */
  body: string;
  /**
   * Id do elemento real destacado: casa com `[data-tour="<anchor>"]`.
   * Ausente → cena informativa (balão centralizado, sem spotlight).
   */
  anchor?: string;
  /** Navegação necessária para a cena (troca de janela/guia/estágio etc.). */
  nav?: TourNavCommand[];
  /** Texto exibido quando o anchor não aparece (elemento condicional). */
  fallbackBody?: string;
  /** Folga do spotlight ao redor do elemento, em px (padrão 6). */
  padding?: number;
  /**
   * MODO DEMONSTRATIVO: enquanto esta cena está aberta, os painéis exibem os
   * dados fictícios de src/tutorial/demo (personagens, PTs, leilões...) no
   * lugar dos dados reais — e todos os callbacks de persistência viram no-op.
   * Permite ensinar qualquer funcionalidade mesmo para usuários sem dados
   * reais e sem VIP, com isolamento total (nada é lido/gravado no Firestore).
   */
  demo?: boolean;
  /**
   * CENA INTERATIVA: libera cliques APENAS dentro do spotlight (o resto da
   * tela continua bloqueado). Usar somente em cenas cujo alvo executa apenas
   * estado local de interface (trocar seletor, alternar filtro) — nunca em
   * elementos com efeitos externos (Firestore, WhatsApp, consultas).
   */
  interactive?: boolean;
}

/** Paleta do tópico — chaves do mapa TONE_THEME (classes literais completas,
 *  necessárias para o Tailwind JIT enxergá-las). */
export type TourTone = "emerald" | "violet" | "sky" | "amber" | "rose";

export interface TourTopic {
  id: string;
  title: string;
  /** Descrição curta exibida no menu de tópicos. */
  description: string;
  tone: TourTone;
  icon: ComponentType<{ size?: number | string; className?: string }>;
  /** Tópico exclusivo do papel Boss (ex.: Services / Boss Admin Panel). */
  bossOnly?: boolean;
  scenes: TourScene[];
}

/** Progresso persistido por tópico (localStorage — preferência local,
 *  deliberadamente fora do Firestore). */
export interface TourTopicProgress {
  lastScene: number;
  completed: boolean;
}

export type TourProgressMap = Record<string, TourTopicProgress>;
