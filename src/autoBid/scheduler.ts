import type { AutoBidConfig, AutoBidItem, AutoBidStatus } from "./types";
import { executionKey, isExecuted } from "./store";

// ============================================================================
// AUTO BID — agendamento e máquina de estados (lógica pura)
// ----------------------------------------------------------------------------
// Funções puras, testáveis em Node. O renderer usa estas funções para decidir
// QUANDO chamar o IPC de execução e QUAL estado exibir. O processo principal é
// quem efetivamente executa o lance (e tem a guarda anti-duplicado final).
//
// Sincronização de horário: `auctionEndTs` vem da lista oficial como epoch de
// SEGUNDOS. Todos os cálculos usam epoch absoluto (`auctionEndTs * 1000`),
// portanto são independentes do fuso local — a comparação é sempre contra
// `Date.now()`.
// ============================================================================

/** Momento (epoch ms) em que o lance deve ser disparado. */
export function fireAtMs(config: Pick<AutoBidConfig, "auctionEndTs" | "secondsBefore">): number {
  const secondsBefore = Math.max(0, Math.min(3600, Number(config.secondsBefore) || 0));
  return config.auctionEndTs * 1000 - secondsBefore * 1000;
}

/** Momento (epoch ms) em que o leilão termina. */
export function endAtMs(config: Pick<AutoBidConfig, "auctionEndTs">): number {
  return config.auctionEndTs * 1000;
}

/** Já passou do momento de disparo (mas ainda antes do fim)? */
export function isDue(config: AutoBidConfig, nowMs: number): boolean {
  if (!config.active) return false;
  const fire = fireAtMs(config);
  const end = endAtMs(config);
  return nowMs >= fire && nowMs < end;
}

/** Já passou do fim do leilão. */
export function isEnded(config: AutoBidConfig, nowMs: number): boolean {
  return nowMs >= endAtMs(config);
}

/** O lance já consta no ledger (persistido) → não re-executar. */
export function alreadyExecuted(config: AutoBidConfig): boolean {
  return isExecuted(executionKey(config));
}

/**
 * Deriva o estado exibido de um item num instante `nowMs`.
 *
 * Ordem de precedência:
 *   1. já executado no ledger        → "concluido";
 *   2. inativo                        → "cancelado";
 *   3. sessão desconectada            → "desconectado";
 *   4. fim do leilão passado          → "cancelado" (encerrado);
 *   5. ativo e dentro da janela       → "aguardando";
 *   6. passou do disparo (atrasado)   → "executando" (pronto para disparar).
 */
export function deriveStatus(
  config: AutoBidConfig,
  nowMs: number,
  connection: "conectado" | "desconectado" | "conectando" | "expirada",
): AutoBidStatus {
  if (alreadyExecuted(config)) return "concluido";
  if (!config.active) return "cancelado";
  if (connection === "desconectado" || connection === "expirada") return "desconectado";
  if (isEnded(config, nowMs)) return "cancelado";
  if (isDue(config, nowMs)) return "aguardando";
  // Ainda não chegou o disparo.
  return "configurado";
}

/**
 * Monta a lista de exibição com contagens regressivas.
 *
 * Exibe TODOS os personagens com `auctionEndTs` válido (independente de já ter
 * valor de lance). É essencial: um personagem recém-marcado com Interesse entra
 * com `bidAmount = 0` e precisa APARECER para o usuário configurar o valor. A
 * restrição de valor válido vale apenas para a EXECUÇÃO (`dueItems`/`isDue`).
 */
export function buildItems(
  configs: AutoBidConfig[],
  nowMs: number,
  connection: "conectado" | "desconectado" | "conectando" | "expirada",
): AutoBidItem[] {
  return configs
    .filter(config => config.auctionEndTs)
    .map(config => {
      const status = deriveStatus(config, nowMs, connection);
      const msUntilFire = fireAtMs(config) - nowMs;
      const msUntilEnd = endAtMs(config) - nowMs;
      return { config, status, msUntilFire, msUntilEnd };
    });
}

/**
 * Retorna os itens que devem ser disparados AGORA (janela [disparo, fim)),
 * ainda não executados, e com VALOR de lance válido (> 0), ordenados pelo
 * horário de fim (mais urgentes primeiro). O processo principal fará a segunda
 * guarda anti-duplicado.
 */
export function dueItems(
  configs: AutoBidConfig[],
  nowMs: number,
): AutoBidConfig[] {
  return configs
    .filter(config => config.bidAmount > 0 && isDue(config, nowMs) && !alreadyExecuted(config))
    .sort((a, b) => endAtMs(a) - endAtMs(b));
}