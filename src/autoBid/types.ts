// ============================================================================
// AUTO BID — tipos
// ----------------------------------------------------------------------------
// Contratos compartilhados entre o store, o agendador e o modal. Fica em
// módulo próprio (`src/autoBid/*`) e não se acopla ao sistema de consulta do
// Bazaar. Estes tipos são usados apenas pelo Auto Bid.
// ============================================================================

/** Modo de execução do Auto Bid (isolados entre si). */
export type AutoBidMode = "cdp";

/** Estados globais de conexão com o navegador/sessão. */
export type AutoBidConnectionState =
  | "desconectado"   // sem navegador aberto ou sem sessão válida
  | "conectando"     // abrindo o navegador para login manual
  | "conectado"      // navegador aberto com sessão válida
  | "expirada";      // sessão venceu

/** Estados por personagem. */
export type AutoBidStatus =
  | "configurado"    // salvo/ativo, ainda aguardando
  | "aguardando"     // na fila agendada (recálculo do disparo)
  | "executando"     // IPC de execução em andamento
  | "concluido"      // Submit Bid confirmado
  | "falhou"         // falha na execução (não re-executa automaticamente)
  | "cancelado"      // desativado/removido/desconectado
  | "desconectado";  // sessão perdida (todos passam a este estado)

/** Configuração persistida de um personagem com Interesse. */
export interface AutoBidConfig {
  auctionId: string;
  bazaarVersion: string;
  name: string;
  server: string;
  vocation: string;
  url: string;
  /** Encerramento em epoch (segundos) — vindo da lista oficial. */
  auctionEndTs: number;
  /** Valor do lance (moedas). Deve passar em `parseBidAmount`. */
  bidAmount: number;
  /** Quantos segundos antes do encerramento o lance deve ser feito. */
  secondsBefore: number;
  active: boolean;
  /** Momento em que foi executado com sucesso (epoch ms). */
  executedAtMs?: number;
  /** Último erro/observação de execução. */
  lastResult?: string;
}

/** Estado derivado em tempo real para exibição no modal. */
export interface AutoBidItem {
  config: AutoBidConfig;
  status: AutoBidStatus;
  /** Contagem regressiva (ms) até o disparo. Negativo = já passou. */
  msUntilFire: number;
  msUntilEnd: number;
}

/** Payload de evento de conexão vindo do processo principal. */
export interface AutoBidConnectionEvent {
  state: AutoBidConnectionState;
  detail?: string;
  at: number;
}

/** Resultado do IPC `autobid-execute-bid`. */
export interface AutoBidExecuteResult {
  ok: boolean;
  status: AutoBidStatus;
  detail?: string;
  deduplicated?: boolean;
  how?: string;
}

/** Registro do quadro "Últimos Auto Bids". */
export interface AutoBidRecord {
  auctionId: string;
  name: string;
  server: string;
  bidAmount: number;
  /** Horário da tentativa (epoch ms). */
  atMs: number;
  status: AutoBidStatus;
  browser: string;
  detail?: string;
}