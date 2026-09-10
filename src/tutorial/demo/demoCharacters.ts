// ============================================================================
// TUTORIAL — PERSONAGENS DEMONSTRATIVOS
// ----------------------------------------------------------------------------
// Dados 100% fictícios usados SOMENTE pelo modo demonstrativo do tutorial
// (cenas com `demo:`). Nunca são gravados no Firestore nem misturados aos
// dados reais: o App apenas os injeta nas props dos painéis enquanto a cena
// demonstrativa está ativa. Ids sempre com o prefixo reservado "demo-".
//
// MATEMÁTICA DO STATS (não alterar sem recalcular — validada por simulação):
// o StatsPanel (filtros padrão: período Tudo, Ativos+Histórico, todos os
// valores ativos, "Apenas personagens completos" LIGADO) calcula
//   resultado do personagem = dropSW + dropBakra + valorVenda − valorPago.
// Personagens SEM drop (a15/a16) ficam fora pelo filtro "completos".
//   • 14 ativos completos  → soma 16.935
//   •  7 vendidos          → soma 10.365
//   → 21 resultados, soma 27.300, média 1.300 RC EXATA (exigência do demo).
// Combinado com as negociações de demoAcquisitions (net −2.100 em 7
// entradas): 28 entradas, soma 25.200 → Resultado Líquido 25.200 RC e
// Resultado Médio/Personagem 900 RC EXATOS.
// ============================================================================
import type { Character } from "../../types";

function dayISO(now: number, minusDays: number): string {
  return new Date(now - minusDays * 86400000).toISOString().slice(0, 10);
}

/** Personagens ativos (guia "Meus Personagens" → DISPONÍVEIS). */
export function buildDemoCharacters(now: number): Character[] {
  const base = { ownerUid: "demo-uid-you", ownerName: "Você", vendido: false, aVenda: false, shared: false, createdAt: now - 40 * 86400000, updatedAt: now - 86400000 };
  return [
    // ── Completos (custo + drop) — entram nas métricas do Stats ───────────
    { ...base, id: "demo-char-1", account: "Conta 1", personagem: "Demo Knight", servidor: "Mystian", voc: "EK", level: 412, soulwar: true, sanguine: false, soulwarDone: true, valorPago: 320, dropSW: 2150, dropBakra: 0, valorVenda: 0, itemDropadoSW: "Soulcutter", dataCompra: dayISO(now, 26), notes: "Personagem demonstrativo do tutorial.", shared: true },
    { ...base, id: "demo-char-2", account: "Conta 1", personagem: "Demo Paladin", servidor: "Mystian", voc: "RP", level: 388, soulwar: true, sanguine: true, soulwarDone: true, valorPago: 280, dropSW: 1475, dropBakra: 0, valorVenda: 0, itemDropadoSW: "Soulpiercer", dataCompra: dayISO(now, 24), notes: "" },
    { ...base, id: "demo-char-3", account: "Conta 2", personagem: "Demo Sorcerer", servidor: "Elysian", voc: "MS", level: 356, soulwar: true, sanguine: true, sanguineDone: true, valorPago: 250, dropSW: 0, dropBakra: 1900, valorVenda: 0, itemDropadoSG: "Sanguine Rod", dataCompra: dayISO(now, 22), notes: "Drop da Sanguine já vendido.", shared: true },
    { ...base, id: "demo-char-4", account: "Conta 2", personagem: "Demo Druid", servidor: "Lunarian", voc: "ED", level: 341, soulwar: true, sanguine: true, soulwarDone: true, valorPago: 230, dropSW: 975, dropBakra: 0, valorVenda: 0, itemDropadoSW: "Soulshanks", dataCompra: dayISO(now, 20), notes: "" },
    { ...base, id: "demo-char-5", account: "Conta 1", personagem: "Demo Blocker", servidor: "Solarian", voc: "EK", level: 297, soulwar: true, sanguine: true, sanguineDone: true, valorPago: 200, dropSW: 0, dropBakra: 1225, valorVenda: 0, itemDropadoSG: "Sanguine Coil", dataCompra: dayISO(now, 19), notes: "" },
    // level 490 (≥ RP 480): cobre Lunarian nos filtros padrão do Resumo de
    // Amigos — Lunarian NÃO recebe "Prioridade para você" no Bazaar demo.
    { ...base, id: "demo-char-6", account: "Conta 2", personagem: "Demo Ranger", servidor: "Lunarian", voc: "RP", level: 490, soulwar: true, sanguine: true, soulwarDone: true, valorPago: 310, dropSW: 1650, dropBakra: 0, valorVenda: 0, itemDropadoSW: "Soulbleeder", dataCompra: dayISO(now, 17), notes: "", shared: true },
    { ...base, id: "demo-char-7", account: "Conta 3", personagem: "Demo Warlock", servidor: "Solarian", voc: "MS", level: 402, soulwar: true, sanguine: true, sanguineDone: true, valorPago: 260, dropSW: 0, dropBakra: 2325, valorVenda: 0, itemDropadoSG: "Grand Sanguine Rod", dataCompra: dayISO(now, 15), notes: "Grand drop na Sanguine!" },
    { ...base, id: "demo-char-8", account: "Conta 3", personagem: "Demo Scout", servidor: "Auroria", voc: "RP", level: 305, soulwar: true, sanguine: false, soulwarDone: true, valorPago: 240, dropSW: 550, dropBakra: 0, valorVenda: 0, itemDropadoSW: "Soulsoles", dataCompra: dayISO(now, 14), notes: "" },
    { ...base, id: "demo-char-9", account: "Conta 1", personagem: "Demo Templar", servidor: "Mystian", voc: "EK", level: 375, soulwar: true, sanguine: true, soulwarDone: true, valorPago: 335, dropSW: 1225, dropBakra: 0, valorVenda: 0, itemDropadoSW: "Soulshell", dataCompra: dayISO(now, 12), notes: "" },
    { ...base, id: "demo-char-10", account: "Conta 2", personagem: "Demo Mystic", servidor: "Solarian", voc: "ED", level: 348, soulwar: true, sanguine: true, sanguineDone: true, valorPago: 275, dropSW: 0, dropBakra: 1750, valorVenda: 0, itemDropadoSG: "Sanguine Blade", dataCompra: dayISO(now, 11), notes: "", shared: true },
    { ...base, id: "demo-char-11", account: "Conta 3", personagem: "Demo Rogue", servidor: "Lunarian", voc: "RP", level: 318, soulwar: true, sanguine: true, soulwarDone: true, valorPago: 215, dropSW: 775, dropBakra: 0, valorVenda: 0, itemDropadoSW: "Soulstrider", dataCompra: dayISO(now, 9), notes: "" },
    { ...base, id: "demo-char-12", account: "Conta 1", personagem: "Demo Berserker", servidor: "Mystian", voc: "EK", level: 429, soulwar: true, sanguine: false, soulwarDone: true, valorPago: 305, dropSW: 2025, dropBakra: 0, valorVenda: 0, itemDropadoSW: "Soulcrusher", dataCompra: dayISO(now, 8), notes: "" },
    { ...base, id: "demo-char-13", account: "Conta 2", personagem: "Demo Oracle", servidor: "Solarian", voc: "MS", level: 337, soulwar: true, sanguine: true, sanguineDone: true, valorPago: 285, dropSW: 0, dropBakra: 1435, valorVenda: 0, itemDropadoSG: "Sanguine Bow", dataCompra: dayISO(now, 6), notes: "" },
    { ...base, id: "demo-char-14", account: "Conta 3", personagem: "Demo Sentinel", servidor: "Auroria", voc: "ED", level: 352, soulwar: true, sanguine: false, soulwarDone: true, valorPago: 295, dropSW: 1275, dropBakra: 0, valorVenda: 0, itemDropadoSW: "Soulmantle", dataCompra: dayISO(now, 5), notes: "" },
    // ── Incompletos (sem drop ainda) — fora do Stats com o filtro padrão ──
    { ...base, id: "demo-char-15", account: "Conta 3", personagem: "Demo Monk", servidor: "Elysian", voc: "MK", level: 305, soulwar: true, sanguine: false, valorPago: 180, dropSW: 0, dropBakra: 0, valorVenda: 0, dataCompra: dayISO(now, 3), notes: "Ainda sem quests concluídas." },
    { ...base, id: "demo-char-16", account: "Conta 1", personagem: "Demo Guardian", servidor: "Elysian", voc: "EK", level: 331, soulwar: true, sanguine: true, valorPago: 350, dropSW: 0, dropBakra: 0, valorVenda: 0, dataCompra: dayISO(now, 2), notes: "Comprado esta semana." },
  ];
}

// ============================================================================
// PERSONAGENS DE AMIGOS (exclusivos do Bazaar demonstrativo)
// ----------------------------------------------------------------------------
// Usados SOMENTE como reforço de `sharedCharacters` do BazarPanel em modo
// demo — nunca entram em "Meus Personagens" nem no Stats (a matemática
// validada acima não os considera). Existem para os DESTAQUES DE PRIORIDADE
// da tabela do Bazaar acenderem de verdade no tutorial, sob os filtros
// padrão do Resumo de Amigos (EK 480 / ED 360 / MS 360 / RP 480 / MK 500,
// Quest Alvo "Todas" = exige Soul War E Sanguine disponíveis):
//
//   • ELYSIAN — 3 amigos válidos (EK/ED/MS), usuário SEM personagem válido
//     (os demo-chars de Elysian ficam abaixo dos levels mínimos): linhas RP
//     = Prioridade Máxima + servidor inteiro em "Prioridade para você".
//   • LUNARIAN — usuário COBERTO (Demo Ranger RP 490) + 2 amigos (ED/MS):
//     EK vira Prioridade Máxima SEM o glow "para você" (contraste didático).
//   • MYSTIAN — 1 amigo (EK 510), usuário sem personagem válido lá:
//     servidor em "Prioridade para você".
//   • AURORIA/SOLARIAN — sem amigos válidos: linhas neutras (contraste).
//
// Nenhum deles participa de PT demo (não podem contar como "ocupados").
// ============================================================================
export function buildDemoFriendCharacters(now: number): Character[] {
  const base = { vendido: false, aVenda: false, shared: true, soulwar: true, sanguine: true, valorPago: 0, dropSW: 0, dropBakra: 0, valorVenda: 0, createdAt: now - 30 * 86400000, updatedAt: now - 2 * 86400000 };
  return [
    { ...base, id: "demo-friend-1", account: "•••", personagem: "Ana Soulblade", servidor: "Elysian", voc: "EK", level: 495, ownerUid: "demo-uid-ana", ownerName: "Demo Ana" },
    { ...base, id: "demo-friend-2", account: "•••", personagem: "Bruno Wildheart", servidor: "Elysian", voc: "ED", level: 400, ownerUid: "demo-uid-bruno", ownerName: "Demo Bruno" },
    { ...base, id: "demo-friend-3", account: "•••", personagem: "Carla Spellweaver", servidor: "Elysian", voc: "MS", level: 385, ownerUid: "demo-uid-carla", ownerName: "Demo Carla" },
    { ...base, id: "demo-friend-4", account: "•••", personagem: "Ana Thornroot", servidor: "Lunarian", voc: "ED", level: 385, ownerUid: "demo-uid-ana", ownerName: "Demo Ana" },
    { ...base, id: "demo-friend-5", account: "•••", personagem: "Sofia Frostcall", servidor: "Lunarian", voc: "MS", level: 370, ownerUid: "demo-uid-sofia", ownerName: "Demo Sofia" },
    { ...base, id: "demo-friend-6", account: "•••", personagem: "Bruno Ironwall", servidor: "Mystian", voc: "EK", level: 510, ownerUid: "demo-uid-bruno", ownerName: "Demo Bruno" },
  ];
}

/** Personagens vendidos (guia "Meus Personagens" → VENDIDOS). */
export function buildDemoSoldCharacters(now: number): Character[] {
  const base = { ownerUid: "demo-uid-you", ownerName: "Você", vendido: true, aVenda: false, shared: false, soulwar: true, sanguine: false, soulwarDone: true, createdAt: now - 120 * 86400000, updatedAt: now - 10 * 86400000 };
  return [
    { ...base, id: "demo-sold-1", account: "Conta 1", personagem: "Demo Veteran", servidor: "Auroria", voc: "EK", level: 445, valorPago: 300, dropSW: 1180, dropBakra: 0, valorVenda: 640, valorVendaOriginal: 640, taxaAplicada: 0, dataCompra: dayISO(now, 110), dataVenda: dayISO(now, 20), itemDropadoSW: "Soulshredder", notes: "Venda demonstrativa concluída." },
    { ...base, id: "demo-sold-2", account: "Conta 2", personagem: "Demo Archer", servidor: "Mystian", voc: "RP", level: 402, soulwar: false, sanguine: true, soulwarDone: false, sanguineDone: true, valorPago: 260, dropSW: 0, dropBakra: 890, valorVenda: 560, dataCompra: dayISO(now, 95), dataVenda: dayISO(now, 17), itemDropadoSG: "Sanguine Coil", notes: "" },
    { ...base, id: "demo-sold-3", account: "Conta 1", personagem: "Demo Champion", servidor: "Elysian", voc: "EK", level: 438, valorPago: 380, dropSW: 1730, dropBakra: 0, valorVenda: 700, dataCompra: dayISO(now, 88), dataVenda: dayISO(now, 14), itemDropadoSW: "Soulshroud", notes: "" },
    { ...base, id: "demo-sold-4", account: "Conta 3", personagem: "Demo Curandeiro", servidor: "Lunarian", voc: "ED", level: 366, soulwar: false, sanguine: true, soulwarDone: false, sanguineDone: true, valorPago: 220, dropSW: 0, dropBakra: 640, valorVenda: 480, dataCompra: dayISO(now, 76), dataVenda: dayISO(now, 12), itemDropadoSG: "Sanguine Blade", notes: "" },
    { ...base, id: "demo-sold-5", account: "Conta 2", personagem: "Demo Lanceiro", servidor: "Solarian", voc: "RP", level: 391, valorPago: 290, dropSW: 840, dropBakra: 0, valorVenda: 525, dataCompra: dayISO(now, 64), dataVenda: dayISO(now, 9), itemDropadoSW: "Soulmaimer", notes: "" },
    { ...base, id: "demo-sold-6", account: "Conta 3", personagem: "Demo Colosso", servidor: "Mystian", voc: "EK", level: 419, valorPago: 310, dropSW: 1425, dropBakra: 0, valorVenda: 525, dataCompra: dayISO(now, 52), dataVenda: dayISO(now, 6), itemDropadoSW: "Soulbiter", notes: "" },
    { ...base, id: "demo-sold-7", account: "Conta 1", personagem: "Demo Feiticeira", servidor: "Auroria", voc: "MS", level: 384, soulwar: false, sanguine: true, soulwarDone: false, sanguineDone: true, valorPago: 335, dropSW: 0, dropBakra: 1650, valorVenda: 675, dataCompra: dayISO(now, 45), dataVenda: dayISO(now, 4), itemDropadoSG: "Grand Sanguine Claws", notes: "Grand drop — venda rápida." },
  ];
}
