/**
 * Testes de regressão contra o PAYLOAD REAL da API do RubinOT
 * (amostras/Exemplo1.json — resposta de /api/bazaar/{id}, leilão 292172,
 * personagem "Dios Zeus", EK 1356, Lunarian; capturada pelo usuário).
 *
 * Objetivo: garantir que os extratores dos métodos Bosstiary (Personagens),
 * Itens e Histórico leem EXATAMENTE os campos que existem na resposta real
 * — e que o modo Quests permanece honesto (inconclusivo) enquanto o payload
 * não traz dados de quests.
 *
 * Fatos do payload real usados como oráculo (conferidos contra a própria
 * página pública do leilão):
 *   - general.balance = "2867149" (STRING) — Gold exibido no site;
 *   - general.skills usa a chave `dist` (não "distance") e magLevel fica
 *     FORA de skills;
 *   - general.charmPoints = 15 = availableCharmPoints (NÃO USADO);
 *     "Total Charm Points" do site = spentCharmPoints + availableCharmPoints;
 *   - general.hirelingCount = 0; hirelingSkills/Wardrobe são listas de
 *     skills/roupas, nunca contagem de hirelings;
 *   - auras é lista na RAIZ;
 *   - bosstiaries lista 100 bosses mas bosstiariosTotal = 115 (lista pode
 *     vir truncada); Megalomania e Bakragore PRESENTES → SW/SG concluídas;
 *   - NÃO existe chave de quests no payload: a guia Quests do site é
 *     computada no FRONTEND a partir de `storages` (regras oficiais em
 *     amostras/1ys-zgp1x3uhc.js: Soul War = storage 21216 >= 1;
 *     Rotten Blood = storage 10301 >= 4) — modo Quests deriva dos storages
 *     do MESMO payload, sem requisição extra.
 *
 * Execução: node tools/bazaar-tests/real-payload.test.cjs
 * (sem dependências externas; pula com aviso se a amostra não existir)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SAMPLE = path.join(__dirname, '..', '..', 'amostras', 'Exemplo1.json');
if (!fs.existsSync(SAMPLE)) {
  console.log('SKIP: amostras/Exemplo1.json ausente — testes de payload real pulados.');
  process.exit(0);
}

const payload = JSON.parse(fs.readFileSync(SAMPLE, 'utf8'));
const nm = require(path.join(__dirname, '..', '..', 'electron-bazaar-new.cjs'));
const im = require(path.join(__dirname, '..', '..', 'electron-bazaar-items.cjs'));
const hm = require(path.join(__dirname, '..', '..', 'electron-bazaar-history.cjs'));

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed += 1; console.log(`PASS  ${name}`); }
  else { failed += 1; console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ''}`); }
}

// ---------------------------------------------------------------------------
// 1) PERSONAGENS (método Bosstiary, passada JSON) — deriveQuestsFromApiPayload
// ---------------------------------------------------------------------------
const b = nm.deriveQuestsFromApiPayload(payload);
check('bosstiary: payload real resolve', b.resolved === true, `reason=${b.reason}`);
check('bosstiary: SW concluída (Megalomania presente)', b.soulwarCompleted === true);
check('bosstiary: SG concluída (Bakragore presente)', b.sanguineCompleted === true);
check('bosstiary: contagens SW/SG do payload real', b.soulWarBossCount === 5 && b.sanguineBossCount === 4,
  `sw=${b.soulWarBossCount} sg=${b.sanguineBossCount}`);
// CRYPT via Bosstiary: 4 dos 5 bosses presentes, final (bonelord's
// phylactery) AUSENTE => NÃO concluída — CONCORDA com a fonte storages.
check('crypt: bosstiary do payload real => NÃO concluída (4/5, sem o final)',
  b.cryptCompleted === false && b.cryptBossCount === 4,
  `crypt=${b.cryptCompleted} count=${b.cryptBossCount}`);
// Regras unitárias da Crypt via bosses (mesma lógica de SW/SG):
const onlyFinal = nm.deriveQuestsFromApiPayload({ bosstiaries: [{ name: "bonelord's phylactery" }] });
check('crypt: boss FINAL presente => concluída', onlyFinal.cryptCompleted === true);
const allFive = nm.deriveQuestsFromApiPayload({ bosstiaries: ['adventurer group', 'eldritch dragon lord', 'ice horror', 'the gravedigger', "bonelord's phylactery"].map(name => ({ name })) });
check('crypt: os 5 bosses presentes => concluída', allFive.cryptCompleted === true);
const fourNoFinal = nm.deriveQuestsFromApiPayload({ bosstiaries: ['adventurer group', 'eldritch dragon lord', 'ice horror', 'the gravedigger'].map(name => ({ name })) });
check('crypt: 4/5 sem o final => DISPONÍVEL', fourNoFinal.cryptCompleted === false);
check('crypt: SW/SG não mudam com a presença dos bosses da Crypt',
  fourNoFinal.soulwarCompleted === false && fourNoFinal.sanguineCompleted === false);

// ---------------------------------------------------------------------------
// 2) MODO QUESTS — derivação OFICIAL por storages (regras do frontend do
//    site, amostras/1ys-zgp1x3uhc.js: SW storage 21216 >= 1; SG 10301 >= 4)
// ---------------------------------------------------------------------------
const q = nm.deriveQuestsFromQuestEntries(payload);
check('quests: payload real CONCLUSIVO via storages', q.resolved === true, `reason=${q.reason}`);
check('quests: SW concluída (storage 21216 = 2 >= 1)', q.soulwarCompleted === true);
check('quests: SG concluída (storage 10301 = 4 >= 4)', q.sanguineCompleted === true);
check('quests: coincide com a derivação Bosstiary (validação cruzada)',
  q.soulwarCompleted === b.soulwarCompleted && q.sanguineCompleted === b.sanguineCompleted);
check('quests: evidência registra os storages lidos',
  q.evidence?.storages?.soulwarStorage === '2' && q.evidence?.storages?.sanguineStorage === '4',
  JSON.stringify(q.evidence?.storages));
// CRYPT ("The Roost of the Graveborn", storage 3291 >= 16 — QUEST_REWARDS
// oficial). Dios Zeus: storage 3291 = 13 < 16 => NÃO concluída (disponível).
check('crypt: payload real => DISPONÍVEL (storage 3291 = 13 < 16)',
  q.cryptCompleted === false && q.evidence?.storages?.cryptStorage === '13',
  JSON.stringify({ crypt: q.cryptCompleted, storage: q.evidence?.storages?.cryptStorage }));
check('crypt: validação CRUZADA bosstiary × storages coincide',
  b.cryptCompleted === q.cryptCompleted);

// Predicado oficial isolado + fronteiras (sintético)
const qa = nm.deriveQuestsFromQuestEntries({ storages: [[999, '1'], [10301, '3']] });
check('quests: ausente/abaixo do requerido => DISPONÍVEL (conclusivo, como no site)',
  qa.resolved === true && qa.soulwarCompleted === false && qa.sanguineCompleted === false);
const qb = nm.deriveQuestsFromQuestEntries({ storages: [[21216, '1'], [10301, '4']] });
check('quests: valores exatamente no limite => concluídas',
  qb.soulwarCompleted === true && qb.sanguineCompleted === true);
const qc = nm.deriveQuestsFromQuestEntries({ general: {} });
check('quests: payload SEM storages => inconclusivo honesto ("?")',
  qc.resolved === false && qc.soulwarCompleted === null && qc.sanguineCompleted === null);
const qd = nm.deriveQuestsFromQuestEntries({ storages: [] });
check('quests: storages VAZIO => inconclusivo (nunca presume)', qd.resolved === false);
const qe = nm.deriveQuestsFromQuestEntries({ quests: [{ name: 'Soul War', completed: true }, { name: 'Rotten Blood', completed: false }] }, { soulwar: true, sanguine: true, crypt: false });
check('quests: fallback textual preservado quando não há storages',
  qe.resolved === true && qe.soulwarCompleted === true && qe.sanguineCompleted === false && qe.cryptCompleted === null);
// Com a Crypt no escopo padrão e sem dado dela, SW/SG seguem conclusivas
// e a Crypt fica "?" (pendente) — nunca presumida.
const qeDefault = nm.deriveQuestsFromQuestEntries({ quests: [{ name: 'Soul War', completed: true }, { name: 'Rotten Blood', completed: false }] });
check('quests: Crypt sem dado => "?" sem perder SW/SG conclusivas',
  qeDefault.resolved === false && qeDefault.soulwarCompleted === true && qeDefault.sanguineCompleted === false && qeDefault.cryptCompleted === null);

// ---------------------------------------------------------------------------
// 3) ITENS — collectItemMatches + collectGoldAndSkills
// ---------------------------------------------------------------------------
const watch = new Set(
  ['sanguine bludgeon', 'spiritthorn helmet', 'dragon backpack', 'item inexistente xyz']
    .map(im.normalizeItemName)
);
const matches = im.collectItemMatches(payload, watch);
const byBase = new Map(matches.map(m => [m.baseKey, m]));
check('itens: encontra 3 itens reais e ignora inexistente', matches.length === 3,
  `encontrados=${matches.map(m => m.foundName).join(',')}`);
check('itens: tier real preservado (sanguine bludgeon T1)', byBase.get('sanguine bludgeon')?.tier === 1);
check('itens: quantidade real (dragon backpack ×3)', byBase.get('dragon backpack')?.amount === 3);

const gs = im.collectGoldAndSkills(payload);
check('itens: ouro lido de general.balance (string → número)', gs.gold === 2867149,
  `gold=${gs.gold} path=${gs.paths?.gold}`);
check('itens: skills reais (dist→distance, magLevel→magic)',
  gs.skills.magic === 14 && gs.skills.distance === 36 && gs.skills.axe === 130
  && gs.skills.club === 131 && gs.skills.sword === 95 && gs.skills.shielding === 127
  && gs.skills.fist === 46,
  JSON.stringify(gs.skills));

// ---------------------------------------------------------------------------
// 4) HISTÓRICO — collectHistoryExtras (charm/auras/hirelings/deluxe)
// ---------------------------------------------------------------------------
const ex = hm.collectHistoryExtras(payload);
check('histórico: charm TOTAL = spent+available (10560+15)', ex.charmPoints === 10575,
  `charm=${ex.charmPoints} path=${ex.paths?.charm}`);
check('histórico: charm NÃO usa general.charmPoints isolado (campo "não usado")',
  ex.paths?.charm !== 'general.charmPoints');
check('histórico: hirelings de general.hirelingCount', ex.hirelingCount === 0
  && ex.paths?.hirelings === 'general.hirelingCount', `path=${ex.paths?.hirelings}`);
check('histórico: auras pela lista da raiz', ex.auraCount === 0 && ex.paths?.auras === '(raiz)');
// Deluxe: battlepassSeasons[].active — confirmado pelo usuário na aba
// Battlepass do site (temporada 3 única com Deluxe = "sim" = única active:1).
check('histórico: deluxe = temporadas com active afirmativo (1)',
  ex.deluxePassCount === 1 && ex.paths?.deluxe === 'battlepassSeasons[].active',
  `deluxe=${ex.deluxePassCount} path=${ex.paths?.deluxe}`);
const noDeluxe = hm.collectHistoryExtras({ battlepassSeasons: [{ season: 1, active: 0 }, { season: 2, active: 0 }] });
check('histórico: temporadas sem Deluxe → 0 (coluna encontrada), não null', noDeluxe.deluxePassCount === 0);
const unknownDeluxe = hm.collectHistoryExtras({ general: {} });
check('histórico: sem battlepass e sem campo deluxe → null honesto', unknownDeluxe.deluxePassCount === null);

// ---------------------------------------------------------------------------
// 5) COMPATIBILIDADE — formatos antigos continuam aceitos (fallbacks)
// ---------------------------------------------------------------------------
const legacy = hm.collectHistoryExtras({ general: { charmPoints: 123 }, hirelings: [{}, {}], auras: [1] });
check('fallback: charmPoints simples quando spent/available ausentes', legacy.charmPoints === 123);
check('fallback: lista hirelings genérica continua contando', legacy.hirelingCount === 2);
const skillsOnly = hm.collectHistoryExtras({ hirelingSkills: [1, 2, 3] });
check('proteção: hirelingSkills NUNCA vira contagem de hirelings', skillsOnly.hirelingCount === null);

console.log(`\n${passed} PASS / ${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);
