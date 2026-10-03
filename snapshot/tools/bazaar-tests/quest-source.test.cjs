// ============================================================================
// TESTES — identificação das quests pela guia "Quests" (modo novo do API JSON)
// ----------------------------------------------------------------------------
// Roda com `node tools/bazaar-tests/quest-source.test.cjs`. Exercita apenas
// as funções PURAS exportadas por `electron-bazaar-new.cjs` — nenhum browser,
// nenhuma rede, nenhum Electron.
//
// Cenários obrigatórios do prompt:
//   • Soul War marcada  + Rotten Blood desmarcada  → SW indisp. / SG disp.
//   • Soul War desmarcada + Rotten Blood marcada   → SW disp.  / SG indisp.
//   • Ambas marcadas / ambas desmarcadas.
//   • Independência total entre as duas quests.
//   • Sem flag claro / flags contraditórios → INCONCLUSIVO (nunca chute).
//   • Método Bosstiary preservado (regressão de deriveQuestsFromApiPayload).
// ============================================================================

'use strict';

const assert = require('node:assert');
const {
  resolveQuestSource,
  interpretQuestCompletionFlag,
  collectQuestEntries,
  deriveQuestsFromQuestEntries,
  deriveQuestsFromApiPayload,
  extractQuestRowsInPage,
  decideQuestsFromDomRows,
  mergeQuestOutcomes,
} = require('../../electron-bazaar-new.cjs');

let pass = 0;
const check = (name, fn) => {
  try { fn(); pass += 1; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}`); console.error(error.message); process.exitCode = 1; }
};

// ── resolveQuestSource ──────────────────────────────────────────────────────
check('resolveQuestSource: padrão e normalização', () => {
  assert.equal(resolveQuestSource({}), 'bosstiary');
  assert.equal(resolveQuestSource(undefined), 'bosstiary');
  assert.equal(resolveQuestSource({ questSource: 'qualquer' }), 'bosstiary');
  assert.equal(resolveQuestSource({ questSource: 'quests' }), 'quests');
});

// ── interpretQuestCompletionFlag ────────────────────────────────────────────
check('flag: booleano, 0/1, "true"/"false" e status textual', () => {
  assert.equal(interpretQuestCompletionFlag({ completed: true }), true);
  assert.equal(interpretQuestCompletionFlag({ isCompleted: false }), false);
  assert.equal(interpretQuestCompletionFlag({ finished: 1 }), true);
  assert.equal(interpretQuestCompletionFlag({ done: 0 }), false);
  assert.equal(interpretQuestCompletionFlag({ completed: 'true' }), true);
  assert.equal(interpretQuestCompletionFlag({ status: 'Completed' }), true);
  assert.equal(interpretQuestCompletionFlag({ status: 'In Progress' }), false);
  assert.equal(interpretQuestCompletionFlag({ name: 'Soul War' }), null);
  assert.equal(interpretQuestCompletionFlag(null), null);
  assert.equal(interpretQuestCompletionFlag({ status: 'algo-desconhecido' }), null);
});

// ── Cenários do prompt (payload JSON com flags booleanos) ──────────────────
const payloadOf = (swCompleted, rbCompleted) => ({
  character: { name: 'Teste' },
  quests: [
    { name: 'Soul War', completed: swCompleted },
    { name: 'The Rotten Blood Quest', completed: rbCompleted },
    { name: 'The Roost of the Graveborn', completed: true },
  ],
});

check('SW marcada + RB desmarcada → SW concluída (indisp.) / SG disponível', () => {
  const out = deriveQuestsFromQuestEntries(payloadOf(true, false));
  assert.equal(out.resolved, true);
  assert.equal(out.soulwarCompleted, true);
  assert.equal(out.sanguineCompleted, false);
});

check('SW desmarcada + RB marcada → SW disponível / SG concluída (indisp.)', () => {
  const out = deriveQuestsFromQuestEntries(payloadOf(false, true));
  assert.equal(out.resolved, true);
  assert.equal(out.soulwarCompleted, false);
  assert.equal(out.sanguineCompleted, true);
});

check('ambas marcadas', () => {
  const out = deriveQuestsFromQuestEntries(payloadOf(true, true));
  assert.deepEqual([out.soulwarCompleted, out.sanguineCompleted], [true, true]);
});

check('ambas desmarcadas', () => {
  const out = deriveQuestsFromQuestEntries(payloadOf(false, false));
  assert.deepEqual([out.soulwarCompleted, out.sanguineCompleted], [false, false]);
});

check('escopo: quest fora do escopo fica null (nunca false)', () => {
  const out = deriveQuestsFromQuestEntries(payloadOf(true, false), { soulwar: true, sanguine: false });
  assert.equal(out.resolved, true);
  assert.equal(out.soulwarCompleted, true);
  assert.equal(out.sanguineCompleted, null);
});

// ── Formatos alternativos de schema (defensivo) ────────────────────────────
check('status textual decide; aninhamento profundo é alcançado', () => {
  // Escopo SW/SG explícito: valida o contrato original sem exigir a Crypt
  // (payload textual sem entrada da Crypt). Com o escopo padrão (3 quests),
  // o caso é coberto pelo teste seguinte.
  const out = deriveQuestsFromQuestEntries({
    data: { character: { questlines: [
      { title: 'Soul War', status: 'Finished' },
      { title: 'Rotten Blood', status: 'Open' },
    ] } },
  }, { soulwar: true, sanguine: true, crypt: false });
  assert.equal(out.resolved, true);
  assert.equal(out.soulwarCompleted, true);
  assert.equal(out.sanguineCompleted, false);
  assert.equal(out.cryptCompleted, null);
});

check('CRYPT: sem dado da Crypt no escopo padrão → SW/SG preservadas e Crypt null', () => {
  const out = deriveQuestsFromQuestEntries({
    data: { character: { questlines: [
      { title: 'Soul War', status: 'Finished' },
      { title: 'Rotten Blood', status: 'Open' },
    ] } },
  });
  // As TRÊS quests estão no escopo padrão; sem storages nem entrada da
  // Crypt, o personagem segue pendente (resolved=false) mas NUNCA perde o
  // que foi conclusivo — e a Crypt fica "?" (null), nunca presumida.
  assert.equal(out.resolved, false);
  assert.equal(out.soulwarCompleted, true);
  assert.equal(out.sanguineCompleted, false);
  assert.equal(out.cryptCompleted, null);
  assert.equal(out.questStatuses.crypt, 'SEM_FLAG_CLARO');
});

check('CRYPT: storages oficiais decidem as 3 quests (16 = concluída; 13 = disponível)', () => {
  const done = deriveQuestsFromQuestEntries({ storages: [[21216, '2'], [10301, '4'], [3291, '16']] });
  assert.equal(done.resolved, true);
  assert.deepEqual([done.soulwarCompleted, done.sanguineCompleted, done.cryptCompleted], [true, true, true]);
  const open = deriveQuestsFromQuestEntries({ storages: [[21216, '2'], [10301, '4'], [3291, '13']] });
  assert.equal(open.resolved, true);
  assert.deepEqual([open.soulwarCompleted, open.sanguineCompleted, open.cryptCompleted], [true, true, false]);
});

check('CRYPT: guia Quests (DOM) decide a Crypt de forma independente', () => {
  const rows = [
    { text: 'soul war', checked: true },
    { text: 'rotten blood', checked: false },
    { text: 'the roost of the graveborn', checked: true },
  ];
  const out = decideQuestsFromDomRows(rows);
  assert.equal(out.resolved, true);
  assert.deepEqual([out.soulwarCompleted, out.sanguineCompleted, out.cryptCompleted], [true, false, true]);
  // Linha da Crypt ausente: SW/SG continuam conclusivas; Crypt "?" e pendente.
  const semCrypt = decideQuestsFromDomRows(rows.slice(0, 2));
  assert.equal(semCrypt.resolved, false);
  assert.deepEqual([semCrypt.soulwarCompleted, semCrypt.sanguineCompleted, semCrypt.cryptCompleted], [true, false, null]);
});

check('lista de strings SEM flag → inconclusivo (vai para a leitura DOM)', () => {
  const out = deriveQuestsFromQuestEntries({ completedQuests: ['Soul War', 'Rotten Blood'] });
  assert.equal(out.resolved, false);
  assert.equal(out.reason, 'QUESTS_INCONCLUSIVAS_NO_JSON');
  assert.equal(out.soulwarCompleted, null);
  assert.equal(out.sanguineCompleted, null);
});

check('uma quest sem entrada → inconclusivo (nunca inventa a ausente)', () => {
  const out = deriveQuestsFromQuestEntries({ quests: [{ name: 'Soul War', completed: true }] });
  assert.equal(out.resolved, false);
  assert.equal(out.questStatuses.soulwar, 'OK');
  assert.equal(out.questStatuses.sanguine, 'SEM_FLAG_CLARO');
});

check('flags contraditórios para a MESMA quest → inconclusivo', () => {
  const out = deriveQuestsFromQuestEntries({
    quests: [
      { name: 'Soul War', completed: true },
      { name: 'Soul War', completed: false },
      { name: 'Rotten Blood', completed: false },
    ],
  });
  assert.equal(out.resolved, false);
  assert.equal(out.questStatuses.soulwar, 'CONFLITO');
  assert.equal(out.questStatuses.sanguine, 'OK');
});

check('independência: estado de uma quest nunca contamina a outra', () => {
  const entries = collectQuestEntries(payloadOf(true, false));
  const sw = entries.filter(e => e.quest === 'soulwar');
  const sg = entries.filter(e => e.quest === 'sanguine');
  assert.ok(sw.length >= 1 && sg.length >= 1);
  assert.ok(sw.every(e => e.completed === true));
  assert.ok(sg.every(e => e.completed === false));
});

check('"soulwarrior" (sem espaço) NÃO casa com "soul war"', () => {
  const entries = collectQuestEntries({ titles: ['Revered Soulwarrior'] });
  assert.equal(entries.length, 0);
});

// ── Decisão a partir das LINHAS da guia Quests (camada DOM, parte pura) ────
const row = (checked, text) => ({ checked, text });

check('DOM: SW marcada + RB desmarcada', () => {
  const out = decideQuestsFromDomRows([
    row(true, 'soul war'),
    row(false, 'rotten blood'),
    row(true, 'the roost of the graveborn'),
  ]);
  assert.equal(out.resolved, true);
  assert.equal(out.soulwarCompleted, true);
  assert.equal(out.sanguineCompleted, false);
});

check('DOM: SW desmarcada + RB marcada', () => {
  const out = decideQuestsFromDomRows([row(false, 'soul war'), row(true, 'rotten blood')]);
  assert.deepEqual([out.soulwarCompleted, out.sanguineCompleted], [false, true]);
});

check('DOM: ambas marcadas / ambas desmarcadas', () => {
  const both = decideQuestsFromDomRows([row(true, 'soul war'), row(true, 'the rotten blood quest')]);
  assert.deepEqual([both.soulwarCompleted, both.sanguineCompleted], [true, true]);
  const none = decideQuestsFromDomRows([row(false, 'soul war'), row(false, 'rotten blood')]);
  assert.deepEqual([none.soulwarCompleted, none.sanguineCompleted], [false, false]);
});

check('DOM: quest ausente das linhas → inconclusivo (QUEST_NAO_LISTADA)', () => {
  const out = decideQuestsFromDomRows([row(true, 'soul war')]);
  assert.equal(out.resolved, false);
  assert.equal(out.reason, 'QUEST_NAO_LISTADA');
});

check('DOM: linhas contraditórias → inconclusivo (CONFLITO)', () => {
  const out = decideQuestsFromDomRows([
    row(true, 'soul war'), row(false, 'soul war'), row(false, 'rotten blood'),
  ]);
  assert.equal(out.resolved, false);
  assert.equal(out.reason, 'CONFLITO');
});

// ── Extração DOM com as estruturas REAIS de ícone (precisa de jsdom) ───────
// Usa EXATAMENTE os elementos enviados da página do RubinOT. Se o jsdom não
// estiver instalado no ambiente, esta seção é pulada com aviso (as demais
// validações acima continuam obrigatórias).
let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch { /* ambiente sem jsdom */ }
if (JSDOM) {
  const html = `<!DOCTYPE html><html><body><div id="quests">
    <div class="flex items-center gap-2">
      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-check-big inline-block w-4 h-4 text-[var(--color-success)]" aria-hidden="true"><path d="M21.801 10A10 10 0 1 1 17 3.335"></path><path d="m9 11 3 3L22 4"></path></svg>
      <span>Soul War</span>
    </div>
    <div class="flex items-center gap-2">
      <div class="inline-block w-4 h-4 rounded-full border-2 border-[var(--text-muted)]"></div>
      <span>Rotten Blood</span>
    </div>
    <div class="flex items-center gap-2">
      <svg class="lucide lucide-circle-check-big inline-block w-4 h-4 text-[var(--color-success)]"><path d="M21.801 10A10 10 0 1 1 17 3.335"></path></svg>
      <span>The Roost of the Graveborn</span>
    </div>
  </div></body></html>`;
  const dom = new JSDOM(html);
  const prevDocument = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    check('jsdom: extração com os ícones REAIS associa ícone→nome corretamente', () => {
      const { ready, rows } = extractQuestRowsInPage();
      assert.equal(ready, true);
      const sw = rows.find(r => r.text.includes('soul war'));
      const rb = rows.find(r => r.text.includes('rotten blood'));
      const roost = rows.find(r => r.text.includes('roost of the graveborn'));
      assert.ok(sw && rb && roost, 'as três linhas devem ser extraídas');
      assert.equal(sw.checked, true, 'Soul War marcada');
      assert.equal(rb.checked, false, 'Rotten Blood desmarcada');
      assert.equal(roost.checked, true, 'Roost marcada');
    });

    check('jsdom: extração + decisão → SW indisponível / SG disponível', () => {
      const { rows } = extractQuestRowsInPage();
      const out = decideQuestsFromDomRows(rows);
      assert.equal(out.resolved, true);
      assert.equal(out.soulwarCompleted, true);
      assert.equal(out.sanguineCompleted, false);
    });
  } finally {
    globalThis.document = prevDocument;
  }
} else {
  console.log('SKIP extração DOM: jsdom não instalado neste ambiente.');
}

// ── Regressão: método Bosstiary intacto ────────────────────────────────────
check('Bosstiary preservada: Megalomania presente → SW concluída', () => {
  const out = deriveQuestsFromApiPayload({
    bosstiaries: [{ name: "Goshnar's Megalomania" }],
  });
  assert.equal(out.resolved, true);
  assert.equal(out.soulwarCompleted, true);
  assert.equal(out.sanguineCompleted, false);
});

check('Bosstiary preservada: lista vazia é resultado VÁLIDO (tudo disponível)', () => {
  const out = deriveQuestsFromApiPayload({ bosstiaries: [] });
  assert.equal(out.resolved, true);
  assert.equal(out.soulwarCompleted, false);
  assert.equal(out.sanguineCompleted, false);
});

check('Bosstiary preservada: payload sem estrutura → inconclusivo (fallback)', () => {
  const out = deriveQuestsFromApiPayload({ foo: 'bar' });
  assert.equal(out.resolved, false);
  assert.equal(out.reason, 'SEM_ESTRUTURA_DE_BOSSTIARY');
});

// ── Mesclagem POR QUEST (requisito "?": parcial nunca é descartado) ────────
check('merge: SW conclusiva no JSON + SG conclusiva no DOM → ambas preservadas', () => {
  const out = mergeQuestOutcomes(
    { soulwarCompleted: true, sanguineCompleted: null },
    { soulwarCompleted: null, sanguineCompleted: false },
  );
  assert.equal(out.soulwarCompleted, true);
  assert.equal(out.sanguineCompleted, false);
});

check('merge: uma conclusiva (JSON) + outra sem dado em lugar nenhum → preserva a conclusiva e "?" (null) só na outra', () => {
  const out = mergeQuestOutcomes(
    { soulwarCompleted: false, sanguineCompleted: null },
    { soulwarCompleted: null, sanguineCompleted: null },
  );
  assert.equal(out.soulwarCompleted, false);
  assert.strictEqual(out.sanguineCompleted, null);
});

check('merge: DOM conclusivo tem prioridade sobre o JSON na MESMA quest', () => {
  const out = mergeQuestOutcomes(
    { soulwarCompleted: false, sanguineCompleted: true },
    { soulwarCompleted: true, sanguineCompleted: null },
  );
  assert.equal(out.soulwarCompleted, true); // guia Quests (indicador oficial) vence
  assert.equal(out.sanguineCompleted, true); // JSON preservado onde o DOM não concluiu
});

check('merge: nada conclusivo → null/null (nunca um estado presumido)', () => {
  const out = mergeQuestOutcomes(
    { soulwarCompleted: null, sanguineCompleted: null },
    { soulwarCompleted: null, sanguineCompleted: null },
  );
  assert.strictEqual(out.soulwarCompleted, null);
  assert.strictEqual(out.sanguineCompleted, null);
});

check('merge: entradas ausentes (undefined) são tratadas como sem dado', () => {
  const out = mergeQuestOutcomes(undefined, { soulwarCompleted: true, sanguineCompleted: undefined });
  assert.equal(out.soulwarCompleted, true);
  assert.strictEqual(out.sanguineCompleted, null);
});

console.log(`\n${pass} testes PASS${process.exitCode ? ' (com falhas acima)' : ''}`);
