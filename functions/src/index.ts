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
// Aceite da compra APÓS a Quest concluída (PT ainda não finalizada): o
// comprador comum não pode gravar `parties` pós-Quest (Rules restringem a
// Líder/Boss), então o reflexo da negociação no slot é materializado pelo
// backend a partir do documento canônico da aquisição.
export { materializeAcquisitionAcceptance } from "./acquisitionAcceptance.js";
// Remoção de personagem da PT com pré-venda pendente: cancela e reseta a
// pré-aprovação automaticamente. Centralizado no backend porque quem remove
// pode não ser o dono da pré-venda (Rules só permitem o delete ao dono/Boss).
export { cleanupRemovedSlotPreApprovals } from "./acquisitionCleanup.js";
// Contador de usuários online: presença bruta no RTDB (status/{uid}, com
// onDisconnect no servidor), trigger abaixo mantém o doc Firestore
// presence/count escrevendo SÓ quando o total muda. Clientes leem por
// polling de 10 min — sem listener. REGIÃO: us-central1 (obrigatória — o
// trigger deve rodar na região da instância RTDB; RTDB não existe em
// southamerica-east1).
export { presenceSync } from "./presenceSync.js";