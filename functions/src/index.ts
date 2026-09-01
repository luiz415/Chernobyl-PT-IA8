import { setGlobalOptions } from "firebase-functions/v2";

/**
 * Infraestrutura de Cloud Functions do Chernobyl PT.
 *
 * Região confirmada do Firestore do projeto `chernobyl-pt`: São Paulo.
 * Toda Function futura que acessar ou disparar Firestore deve permanecer nesta
 * região para evitar latência e tráfego entre regiões.
 *
 * A healthcheck temporária concluiu o ciclo de validação local e de produção
 * em 2026-08-26 e foi removida da produção.
 */
setGlobalOptions({
  region: "southamerica-east1",
  minInstances: 0,
  maxInstances: 1,
});

/**
 * Primeira Function real aprovada: reconcilia exclusivamente aquisições
 * negociadas já pagas após a conclusão de uma Quest. Ela não toca Stats,
 * pagamentos, Histórico, Services, notificações ou provável marcador.
 */
export { reconcileQuestCompletion } from "./questCompletion.js";
export { materializePartySettlement, finalizePartyHistory } from "./partyLifecycle.js";
export { notifyBossServiceWaiting } from "./serviceIntake.js";
export { scheduledRankingReset } from "./rankingReset.js";
// ── Notificações em tempo real (backend) ────────────────────────────────────
// Push unificado (toda notificação persistida → FCM), limpeza global da
// consulta anterior do Bazaar (disparada pela publicação) e
// lembretes/atualizações de PT — veja os cabeçalhos de cada módulo.
//
// O watcher de leilões (`scheduledBazaarAuctionWatch`) foi REMOVIDO: o alerta
// de "Tenho Interesse" voltou a ser agendado no DISPOSITIVO do usuário
// (services/bazaarInterestNotificationService.ts) — sem Cloud Function por
// usuário/leilão. O backend cuida apenas do que é global: publicar a lista
// (cliente do Boss) e limpar o resíduo da consulta anterior (bazaarListCleanup).
export { notificationPushTrigger } from "./notificationPush.js";
export { bazaarListCleanup } from "./bazaarListCleanup.js";
export { scheduledPtReminderWatch, onPartyUpdated } from "./ptWatch.js";