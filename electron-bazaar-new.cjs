// ============================================================================
// MÉTODO NOVO DE CONSULTA DO BAZAAR — módulo isolado
// ----------------------------------------------------------------------------
// Este arquivo é 100% ADITIVO. Ele não altera, não monkey-patcha e não
// reimplementa nada do método antigo: recebe por injeção as funções que já
// existem em `electron-main.cjs` e as USA como estão.
//
// O toque em `electron-main.cjs` é de apenas duas linhas (um `require` e uma
// chamada de registro), exatamente como combinado.
//
// ── O QUE MUDA EM RELAÇÃO AO MÉTODO ANTIGO ─────────────────────────────────
//
// A auditoria mostrou que a mensagem "Falha ao carregar leilão" nasce em UM
// único lugar: dentro da página renderizada `/bazaar/<id>`. Ela NÃO existe na
// fase de listagem, que já é JSON puro (`/api/bazaar?...`) nos dois métodos.
//
// Por isso o método novo mantém a listagem EXATAMENTE como está (é o mesmo
// endpoint, o mesmo código, o mesmo resultado) e troca apenas a FASE DE
// DETALHES:
//
//   ANTIGO:  page.goto('/bazaar/<id>')  ->  esperar SPA hidratar
//                                       ->  clicar na aba "Bosstiary"
//                                       ->  esperar o painel montar
//                                       ->  ler tabela / paginar / até 6 buscas
//
//   NOVO:    fetch('/api/bazaar/<id>')  ->  ler JSON
//
// Zero renderização, zero DOM, zero clique. Onde não havia render, não há como
// aparecer "Falha ao carregar leilão".
//
// ── HONESTIDADE SOBRE O QUE NÃO PUDE VERIFICAR ─────────────────────────────
// A rota `/api/bazaar/{ID}` foi relatada pelo usuário (descoberta por outra
// IA). Ela NÃO pôde ser confirmada no ambiente de desenvolvimento: o sandbox
// não alcança `rubinot.com.br`, e de fora o site responde `403 Access denied`
// para QUALQUER `/api/*` — inclusive para a rota de listagem que sabidamente
// funciona. Ou seja, o 403 não prova nem desmente nada.
//
// Como o schema da resposta é desconhecido, este módulo NÃO assume formato
// algum. Ele:
//   1. varre o JSON recursivamente atrás de estruturas reconhecíveis;
//   2. registra no diagnóstico o formato real que recebeu (`shape`);
//   3. quando não consegue concluir, NÃO inventa resultado — devolve o
//      personagem para o MÉTODO ANTIGO (fallback), que roda intacto.
//
// Consequência: o método novo nunca pode ser PIOR que o antigo. No pior caso
// (rota inexistente), todo mundo cai no fallback e o resultado é idêntico ao
// de hoje, com o custo de uma requisição JSON extra por personagem.
//
// ── SEM BURLAR NADA ────────────────────────────────────────────────────────
// Mesma sessão, mesmos cookies, mesmo navegador escolhido pelo usuário. Sem
// stealth, sem bypass de Cloudflare/Turnstile, sem rotação de IP. A chamada
// JSON sai de dentro da própria página do RubinOT, como o site já faz.
// ============================================================================

'use strict';

// ============================================================================
// BOSSES — espelham as constantes do método antigo
// ----------------------------------------------------------------------------
// Declarados aqui (e não importados) porque `electron-main.cjs` não exporta
// nada. Os valores são os mesmos, e o teste `bazaar-method-split.test.cjs`
// compara os dois conjuntos item a item para impedir que divirjam.
// ============================================================================
const NEW_SOUL_WAR_BOSSES = [
  "goshnar's cruelty",
  "goshnar's malice",
  "goshnar's greed",
  "goshnar's spite",
  "goshnar's hatred",
  "goshnar's megalomania",
];
const NEW_SANGUINE_BOSSES = [
  'murcion',
  'vemiath',
  'ichgahal',
  'chagorz',
  'bakragore',
];
const NEW_SOUL_WAR_FINAL_BOSS = "goshnar's megalomania";
const NEW_SANGUINE_FINAL_BOSS = 'bakragore';

/** Mesma normalização do método antigo (acentos, aspas curvas, hífens). */
function normalizeBossName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’`´]/g, "'")
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// ============================================================================
// EXTRAÇÃO DEFENSIVA DO JSON
// ----------------------------------------------------------------------------
// Nenhuma destas funções assume um schema. Todas são puras e testadas em
// `tools/bazaar-method-split-tests/`.
// ============================================================================

/** Profundidade máxima da varredura — trava contra JSON patológico. */
const MAX_SCAN_DEPTH = 12;
/** Teto de nós visitados, para a varredura nunca virar gargalo. */
const MAX_SCAN_NODES = 20000;

/**
 * Percorre o JSON e chama `visit(node, path)` em cada nó.
 * Protegido contra ciclos, profundidade excessiva e payloads gigantes.
 */
function walkJson(root, visit) {
  const seen = new WeakSet();
  let visited = 0;

  const walk = (node, path, depth) => {
    if (node === null || node === undefined) return;
    if (visited++ > MAX_SCAN_NODES) return;
    if (depth > MAX_SCAN_DEPTH) return;

    if (typeof node === 'object') {
      if (seen.has(node)) return;
      seen.add(node);
    }

    visit(node, path);

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) walk(node[i], `${path}[${i}]`, depth + 1);
    } else if (typeof node === 'object') {
      for (const key of Object.keys(node)) walk(node[key], path ? `${path}.${key}` : key, depth + 1);
    }
  };

  walk(root, '', 0);
}

/**
 * Todos os bosses conhecidos citados em QUALQUER string do JSON.
 *
 * Casamento por igualdade normalizada OU por conter o nome do boss. O segundo
 * caso cobre rótulos como "Goshnar's Malice (Brachio)".
 *
 * Devolve também `paths`: onde cada boss foi encontrado. Isso é diagnóstico —
 * é o que permite descobrir o schema real na primeira execução sem chutar.
 */
function collectBossMentions(payload) {
  const found = new Map();
  const allBosses = [...NEW_SOUL_WAR_BOSSES, ...NEW_SANGUINE_BOSSES];

  walkJson(payload, (node, path) => {
    if (typeof node !== 'string') return;
    const normalized = normalizeBossName(node);
    if (!normalized) return;
    for (const boss of allBosses) {
      if (normalized === boss || normalized.includes(boss)) {
        if (!found.has(boss)) found.set(boss, path);
      }
    }
  });

  return {
    bosses: Array.from(found.keys()),
    paths: Object.fromEntries(found),
  };
}

/**
 * Arrays que PARECEM uma Bosstiary: coleções de objetos com um campo de nome.
 *
 * Só serve para distinguir "a estrutura existe e está vazia" (resultado
 * VÁLIDO — personagem que nunca matou boss algum, o caso mais valioso do
 * filtro) de "a estrutura não veio nesta resposta" (inconclusivo).
 *
 * ATENÇÃO: essa distinção é a razão de a lição "Bosstiary vazia é resultado
 * VÁLIDO" continuar respeitada. Sem ela, um campo ausente viraria
 * silenciosamente "quest disponível".
 */
// CONFIRMADO EM EXECUÇÃO REAL (log de 208 personagens): a chave usada pelo
// RubinOT é `bosstiaries` — plural em "-ies", que o regex original NÃO cobria.
// Sintoma: `containersBosstiary: []` mesmo com bosses presentes em
// `bosstiaries[0].name`, e 8 personagens classificados como
// SEM_ESTRUTURA_DE_BOSSTIARY quando na verdade tinham a lista legitimamente
// VAZIA — justamente o caso mais valioso do filtro (Soul War disponível).
const BOSSTIARY_KEY_HINTS = /^(bosstiaries|bosstiary|bosses|bossProgress|bossesKilled|bossKills|killedBosses|bestiary)$/i;

function findBosstiaryContainers(payload) {
  const containers = [];

  walkJson(payload, (node, path) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    for (const key of Object.keys(node)) {
      if (!BOSSTIARY_KEY_HINTS.test(key)) continue;
      const value = node[key];
      if (Array.isArray(value)) {
        containers.push({ path: path ? `${path}.${key}` : key, key, length: value.length });
      }
    }
  });

  return containers;
}

/**
 * Entradas de storage no formato `{ storageId, value }`.
 *
 * Existe porque o usuário relatou que outra IA encontrou `storageId: 21216`
 * com `requiredValue: 1` para Soul War. NÃO consegui comprovar esses valores
 * (ver cabeçalho), então este módulo:
 *   • NÃO usa storage algum para decidir quest;
 *   • apenas COLETA o que existir e registra no diagnóstico.
 *
 * Assim, se a estrutura existir de verdade, você a verá no log com os IDs
 * REAIS — e aí sim poderemos decidir, com dado na mão, se vale usá-la.
 *
 * Motivo de não usar agora: uma storage key é um critério SEMANTICAMENTE
 * DIFERENTE do atual (hoje: 6 Goshnar's ou Megalomania na Bosstiary). Trocar
 * às cegas mudaria a regra de negócio da coluna Soul War — o que é proibido.
 */
function collectStorageEntries(payload) {
  const entries = [];

  walkJson(payload, (node, path) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    const keys = Object.keys(node);
    const idKey = keys.find(k => /^(storageId|storage_id|storagekey|key|id)$/i.test(k));
    const hasStorageWord = keys.some(k => /storage/i.test(k));
    if (!hasStorageWord || !idKey) return;
    const rawId = node[idKey];
    if (typeof rawId !== 'number' && typeof rawId !== 'string') return;
    const valueKey = keys.find(k => /^(value|requiredValue|required_value|amount|count)$/i.test(k));
    entries.push({
      path,
      storageId: rawId,
      value: valueKey ? node[valueKey] : undefined,
    });
  });

  return entries;
}

/**
 * Retrato do formato recebido — chaves de topo e tipos.
 *
 * É o que transforma a primeira execução real numa DESCOBERTA de schema em vez
 * de um chute. Vai inteiro para o log de diagnóstico.
 */
function summarizeJsonShape(payload) {
  if (!payload || typeof payload !== 'object') {
    return { type: typeof payload, keys: [] };
  }
  if (Array.isArray(payload)) {
    return { type: 'array', length: payload.length, sampleKeys: payload[0] && typeof payload[0] === 'object' ? Object.keys(payload[0]).slice(0, 40) : [] };
  }
  const keys = Object.keys(payload);
  const typed = {};
  for (const key of keys.slice(0, 60)) {
    const value = payload[key];
    typed[key] = Array.isArray(value) ? `array(${value.length})` : (value === null ? 'null' : typeof value);
  }
  return { type: 'object', keys: keys.slice(0, 60), types: typed };
}

/**
 * Conclui Soul War / Sanguine a partir do payload da API individual.
 *
 * ── REGRA DE NEGÓCIO: IDÊNTICA À DO MÉTODO ANTIGO ─────────────────────────
 *   • Soul War concluída  = os 6 Goshnar's presentes OU Megalomania presente
 *   • Sanguine concluída  = os 5 presentes OU Bakragore presente
 *   • Quest fora do escopo do filtro (`all`) => `null` (= "Não verificado"),
 *     nunca `false`, que significaria "disponível" e seria inventar resultado.
 *
 * `resolved: false` significa "esta resposta não permite concluir" — e nesse
 * caso o personagem vai para o FALLBACK no método antigo. Nunca chutamos.
 */
function deriveQuestsFromApiPayload(payload, quests = { soulwar: true, sanguine: true }) {
  const mentions = collectBossMentions(payload);
  const containers = findBosstiaryContainers(payload);
  const storages = collectStorageEntries(payload);

  const bossSet = new Set(mentions.bosses.map(normalizeBossName));

  // A estrutura de bosstiary existe nesta resposta?
  //   • algum boss conhecido citado  => existe, com conteúdo
  //   • container reconhecível       => existe (mesmo vazio: resultado VÁLIDO)
  // Sem nenhum dos dois, a resposta é INCONCLUSIVA — não dá para diferenciar
  // "nunca matou boss algum" de "este endpoint não traz bosstiary".
  const hasBosstiaryStructure = bossSet.size > 0 || containers.length > 0;

  if (!hasBosstiaryStructure) {
    return {
      resolved: false,
      reason: 'SEM_ESTRUTURA_DE_BOSSTIARY',
      soulwarCompleted: null,
      sanguineCompleted: null,
      evidence: { shape: summarizeJsonShape(payload), storages, containers, bossPaths: mentions.paths },
    };
  }

  const soulWarFoundBosses = NEW_SOUL_WAR_BOSSES.filter(boss => bossSet.has(normalizeBossName(boss)));
  const sanguineFoundBosses = NEW_SANGUINE_BOSSES.filter(boss => bossSet.has(normalizeBossName(boss)));
  const soulWarFinalFound = bossSet.has(normalizeBossName(NEW_SOUL_WAR_FINAL_BOSS));
  const sanguineFinalFound = bossSet.has(normalizeBossName(NEW_SANGUINE_FINAL_BOSS));

  return {
    resolved: true,
    reason: 'OK',
    soulwarCompleted: quests.soulwar
      ? (soulWarFoundBosses.length === NEW_SOUL_WAR_BOSSES.length || soulWarFinalFound)
      : null,
    sanguineCompleted: quests.sanguine
      ? (sanguineFoundBosses.length === NEW_SANGUINE_BOSSES.length || sanguineFinalFound)
      : null,
    soulWarFoundBosses,
    sanguineFoundBosses,
    soulWarBossCount: soulWarFoundBosses.length,
    sanguineBossCount: sanguineFoundBosses.length,
    totalBosstiaryBosses: bossSet.size,
    // `shape` também no caminho de SUCESSO: sem ele o log de descoberta
    // imprimia `{ type: 'object', keys: [] }` (o fallback), escondendo
    // justamente o formato real quando a leitura dava certo.
    evidence: { shape: summarizeJsonShape(payload), storages, containers, bossPaths: mentions.paths },
  };
}

// ============================================================================
// IDENTIFICAÇÃO PELA GUIA "QUESTS" — novo modo do método API JSON
// ----------------------------------------------------------------------------
// A página oficial do personagem tem uma guia "Quests" com linhas no formato
// [ícone][nome da quest]:
//   • círculo MARCADO    (svg lucide-circle-check-big text-[var(--color-success)])
//     = quest CONCLUÍDA  → indisponível para o comprador;
//   • círculo DESMARCADO (div rounded-full border-2 border-[var(--text-muted)])
//     = quest NÃO concluída → DISPONÍVEL, conforme o indicador do site.
//
// Mapeamento obrigatório (cada quest decidida de forma INDEPENDENTE):
//   • "Soul War"     → coluna SW
//   • "Rotten Blood" → coluna SG (Sanguine)
//
// Estratégia em duas camadas, na MESMA filosofia do restante do módulo:
//   1. JSON primeiro: o payload da API individual (o mesmo já baixado) é
//      varrido defensivamente atrás de entradas de quest com um flag CLARO de
//      conclusão. Schema não confirmado => nada é assumido; a primeira
//      resposta real vai para o log de DESCOBERTA (questEntries).
//   2. Quem o JSON não resolver é lido DIRETO na guia Quests da página
//      renderizada (estruturas de ícone fornecidas pelo site real).
//   3. Sem conclusão confiável nas duas camadas, o personagem é reportado
//      como FALHA — nunca cai silenciosamente no critério Bosstiary (que o
//      usuário explicitamente NÃO escolheu) e nunca recebe resultado chutado.
// ============================================================================
const NEW_QUEST_NAME_SOULWAR = 'soul war';
const NEW_QUEST_NAME_SANGUINE = 'rotten blood';

/** Flags booleanos de conclusão aceitos num objeto de quest do JSON. */
const QUEST_DONE_FLAG_KEYS = /^(isCompleted|completed|complete|isComplete|finished|isFinished|done|isDone|claimed|concluded|isConcluded)$/i;
/** Campos de status textual aceitos num objeto de quest do JSON. */
const QUEST_STATUS_KEYS = /^(status|state|progress)$/i;
const QUEST_STATUS_DONE = new Set(['completed', 'complete', 'finished', 'done', 'concluded', 'claimed']);
const QUEST_STATUS_OPEN = new Set(['incomplete', 'not completed', 'in progress', 'in_progress', 'open', 'available', 'not started', 'pending', 'unfinished', 'locked']);

/**
 * Interpreta o flag de conclusão de UM objeto que representa uma quest.
 * Só aceita evidência CLARA (booleano, 0/1, "true"/"false" ou status textual
 * conhecido). Qualquer outra coisa => null (inconclusivo) — nunca chute.
 */
function interpretQuestCompletionFlag(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  for (const key of Object.keys(entry)) {
    if (!QUEST_DONE_FLAG_KEYS.test(key)) continue;
    const value = entry[key];
    if (typeof value === 'boolean') return value;
    if (value === 1 || value === '1' || value === 'true') return true;
    if (value === 0 || value === '0' || value === 'false') return false;
  }
  for (const key of Object.keys(entry)) {
    if (!QUEST_STATUS_KEYS.test(key)) continue;
    const value = entry[key];
    if (typeof value !== 'string') continue;
    const normalized = normalizeBossName(value);
    if (QUEST_STATUS_DONE.has(normalized)) return true;
    if (QUEST_STATUS_OPEN.has(normalized)) return false;
  }
  return null;
}

/**
 * Varre o payload atrás de QUALQUER string que cite "Soul War" ou
 * "Rotten Blood" e tenta interpretar o flag de conclusão no objeto PAI.
 * Caminhada própria (não a walkJson) porque aqui o PAI importa.
 * Entradas sem flag claro são coletadas mesmo assim — viram diagnóstico.
 */
function collectQuestEntries(payload) {
  const entries = [];
  const seen = new WeakSet();
  let visited = 0;

  const visit = (node, path, depth, parent) => {
    if (node === null || node === undefined) return;
    if (visited++ > MAX_SCAN_NODES) return;
    if (depth > MAX_SCAN_DEPTH) return;

    if (typeof node === 'string') {
      const normalized = normalizeBossName(node);
      let quest = '';
      if (normalized === NEW_QUEST_NAME_SOULWAR || normalized.includes(NEW_QUEST_NAME_SOULWAR)) quest = 'soulwar';
      else if (normalized === NEW_QUEST_NAME_SANGUINE || normalized.includes(NEW_QUEST_NAME_SANGUINE)) quest = 'sanguine';
      if (!quest) return;
      const completed = parent && typeof parent === 'object' && !Array.isArray(parent)
        ? interpretQuestCompletionFlag(parent)
        : null;
      entries.push({ quest, path, name: String(node).slice(0, 80), completed });
      return;
    }

    if (typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) visit(node[i], `${path}[${i}]`, depth + 1, node);
    } else {
      for (const key of Object.keys(node)) visit(node[key], path ? `${path}.${key}` : key, depth + 1, node);
    }
  };

  visit(payload, '', 0, null);
  return entries;
}

/**
 * REGRAS OFICIAIS da guia "Quests" do site — extraídas do PRÓPRIO frontend
 * do RubinOT (amostras/1ys-zgp1x3uhc.js, obtido pelo usuário via busca
 * global no DevTools). O chunk define o array QUEST_REWARDS e o predicado:
 *
 *   toStoragesMap(storages) { const m = new Map();
 *     for (const [id, valor] of storages || []) try { m.set(id, BigInt(valor)) } catch {}
 *     return m; }
 *   isQuestCompleted(map, q) { const v = map.get(q.storageId);
 *     return v !== undefined && v >= BigInt(q.requiredValue); }
 *
 * Ou seja: a guia Quests é computada NO FRONTEND a partir de
 * `payload.storages` (pares [storageId, valor]) — o MESMO payload que já
 * baixamos. Nada é presumido: storageIds e requiredValues abaixo são os
 * valores literais do QUEST_REWARDS do site.
 */
const QUEST_STORAGE_RULES = {
  soulwar: { name: 'Soul War', storageId: 21216, requiredValue: 1n },
  sanguine: { name: 'Rotten Blood', storageId: 10301, requiredValue: 4n },
};

/** Réplica fiel do toStoragesMap do site (chaves normalizadas p/ Number). */
function toStoragesMap(storages) {
  const map = new Map();
  for (const pair of Array.isArray(storages) ? storages : []) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const id = Number(pair[0]);
    if (!Number.isFinite(id)) continue;
    try { map.set(id, BigInt(pair[1])); } catch { /* valor não numérico: ignora, como o site */ }
  }
  return map;
}

/**
 * Decide Soul War / Rotten Blood pelos STORAGES do payload, usando o
 * predicado oficial do site. Com a lista de storages presente e válida, o
 * estado é CONCLUSIVO nos dois sentidos (é exatamente assim que a guia
 * Quests do site marca/desmarca cada quest):
 *   • valor >= requiredValue  => concluída (indisponível);
 *   • ausente ou valor menor  => NÃO concluída (disponível).
 * Payload sem lista de storages utilizável => inconclusivo (nunca presume).
 */
function deriveQuestsFromStorages(payload) {
  const raw = Array.isArray(payload?.storages) ? payload.storages
    : (Array.isArray(payload?.data?.storages) ? payload.data.storages : null);
  const map = toStoragesMap(raw);
  // Lista ausente/vazia/inválida: sem base para afirmar nada — "?" honesto.
  // (Qualquer personagem real tem centenas de storages; vazio = anômalo.)
  if (!raw || raw.length === 0 || map.size === 0) {
    return { usable: false, soulwar: { value: null, status: 'SEM_STORAGES' }, sanguine: { value: null, status: 'SEM_STORAGES' }, evidence: { present: !!raw, pares: raw ? raw.length : 0 } };
  }
  const decide = (questKey) => {
    const rule = QUEST_STORAGE_RULES[questKey];
    const value = map.get(rule.storageId);
    return { value: value !== undefined && value >= rule.requiredValue, status: 'OK' };
  };
  return {
    usable: true,
    soulwar: decide('soulwar'),
    sanguine: decide('sanguine'),
    evidence: {
      present: true,
      pares: raw.length,
      soulwarStorage: map.has(QUEST_STORAGE_RULES.soulwar.storageId) ? String(map.get(QUEST_STORAGE_RULES.soulwar.storageId)) : null,
      sanguineStorage: map.has(QUEST_STORAGE_RULES.sanguine.storageId) ? String(map.get(QUEST_STORAGE_RULES.sanguine.storageId)) : null,
    },
  };
}

/**
 * Conclui Soul War / Sanguine pelo modo QUESTS a partir do payload JSON.
 *
 * FONTE PRIMÁRIA (oficial): `payload.storages` + predicado do próprio site
 * (deriveQuestsFromStorages acima) — é como a guia Quests é renderizada.
 * FALLBACK: entradas textuais com flag claro (collectQuestEntries), mantido
 * para formatos futuros em que a API embuta a lista de quests diretamente.
 *
 * Regras (cada quest é INDEPENDENTE, exatamente como na guia do site):
 *   • concluída  => indisponível;  não concluída => DISPONÍVEL;
 *   • sem storages utilizáveis E sem entrada textual com flag claro (ou
 *     entradas CONTRADITÓRIAS) => aquela quest fica inconclusiva e o
 *     personagem segue para a leitura DOM (se houver retries).
 *   • quest fora do escopo => null ("Não verificado"), nunca false.
 */
function deriveQuestsFromQuestEntries(payload, quests = { soulwar: true, sanguine: true }) {
  const storages = deriveQuestsFromStorages(payload);
  const entries = collectQuestEntries(payload);

  const decideByEntries = (questKey) => {
    const flagged = entries.filter(entry => entry.quest === questKey && entry.completed !== null);
    if (flagged.length === 0) return { value: null, status: 'SEM_FLAG_CLARO' };
    const hasTrue = flagged.some(entry => entry.completed === true);
    const hasFalse = flagged.some(entry => entry.completed === false);
    if (hasTrue && hasFalse) return { value: null, status: 'CONFLITO' };
    return { value: hasTrue, status: 'OK' };
  };

  // Storages (fonte oficial) decide primeiro; entradas textuais só entram
  // quando não há storages utilizáveis.
  const decide = (questKey) => (
    storages[questKey].status === 'OK' ? storages[questKey] : decideByEntries(questKey)
  );

  const soulwar = decide('soulwar');
  const sanguine = decide('sanguine');
  const needSoulwar = quests.soulwar !== false;
  const needSanguine = quests.sanguine !== false;
  const resolved = (!needSoulwar || soulwar.status === 'OK') && (!needSanguine || sanguine.status === 'OK');

  return {
    resolved,
    reason: resolved ? 'OK' : 'QUESTS_INCONCLUSIVAS_NO_JSON',
    soulwarCompleted: needSoulwar && soulwar.status === 'OK' ? soulwar.value : null,
    sanguineCompleted: needSanguine && sanguine.status === 'OK' ? sanguine.value : null,
    questStatuses: { soulwar: soulwar.status, sanguine: sanguine.status },
    // `questEntries` no diagnóstico: é o log de DESCOBERTA que revela, na
    // primeira execução real, se/como o payload traz a lista de quests.
    // `storages` registra a fonte oficial usada (pares e valores lidos).
    evidence: { shape: summarizeJsonShape(payload), questEntries: entries.slice(0, 20), storages: storages.evidence },
  };
}

/** URL da API individual. Rota informada pelo usuário; não inventada aqui. */
function buildAuctionApiUrl(apiBase, id) {
  const safeId = encodeURIComponent(String(id || '').trim());
  if (!safeId) return '';
  return `${String(apiBase || '').replace(/\/+$/, '')}/${safeId}`;
}

/**
 * Identificação das quests pedida pelo renderer:
 *   • "bosstiary" (padrão/qualquer valor inesperado) = comportamento ATUAL;
 *   • "quests" = NOVO modo pela guia Quests da página oficial.
 */
function resolveQuestSource(options = {}) {
  return options?.questSource === 'quests' ? 'quests' : 'bosstiary';
}

/**
 * EXECUTA NO NAVEGADOR (via page.evaluate): extrai as linhas [ícone][nome]
 * da guia Quests. AUTOCONTIDA de propósito — o Playwright serializa a função
 * e ela não pode referenciar nada do módulo. Também é exportada e testada em
 * jsdom com as estruturas REAIS de ícone enviadas da página do RubinOT:
 *   • marcado    = <svg class="... lucide-circle-check-big ... text-[var(--color-success)]">
 *   • desmarcado = <div class="... rounded-full border-2 border-[var(--text-muted)]">
 * A associação ícone→nome não depende de posição global: sobe do ícone até o
 * primeiro ancestral com texto curto (a linha da quest).
 */
function extractQuestRowsInPage() {
  const strip = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const checkedIcons = Array.from(document.querySelectorAll('svg.lucide-circle-check-big'));
  // Classe com colchetes (`border-[var(--text-muted)]`) não entra em
  // querySelector — seleciona o par estável e filtra pelo className bruto.
  const uncheckedIcons = Array.from(document.querySelectorAll('div.rounded-full.border-2'))
    .filter(el => String(el.className || '').includes('border-[var(--text-muted)]'));
  const rowTextOf = (icon) => {
    let el = icon.parentElement;
    let hops = 0;
    while (el && hops < 5) {
      const text = strip(el.textContent);
      if (text && text.length <= 160) return text;
      el = el.parentElement;
      hops += 1;
    }
    return '';
  };
  const rows = [];
  checkedIcons.forEach(icon => { const text = rowTextOf(icon); if (text) rows.push({ checked: true, text }); });
  uncheckedIcons.forEach(icon => { const text = rowTextOf(icon); if (text) rows.push({ checked: false, text }); });
  return { ready: rows.length > 0, rows: rows.slice(0, 120) };
}

/**
 * Decide Soul War / Sanguine a partir das linhas extraídas da guia Quests.
 * PURA (exportada para testes). Cada quest é independente:
 *   • linha com círculo MARCADO    → quest CONCLUÍDA (indisponível);
 *   • linha com círculo DESMARCADO → quest DISPONÍVEL;
 *   • quest ausente das linhas, ou linhas contraditórias → inconclusivo.
 */
function decideQuestsFromDomRows(rows, quests = { soulwar: true, sanguine: true }) {
  const list = Array.isArray(rows) ? rows : [];
  const decide = (needle) => {
    const matches = list.filter(row => row && typeof row.text === 'string' && row.text.includes(needle));
    if (matches.length === 0) return { value: null, status: 'QUEST_NAO_LISTADA' };
    const hasChecked = matches.some(row => row.checked === true);
    const hasUnchecked = matches.some(row => row.checked !== true);
    if (hasChecked && hasUnchecked) return { value: null, status: 'CONFLITO' };
    return { value: hasChecked, status: 'OK' };
  };
  const soulwar = decide(NEW_QUEST_NAME_SOULWAR);
  const sanguine = decide(NEW_QUEST_NAME_SANGUINE);
  const needSoulwar = quests.soulwar !== false;
  const needSanguine = quests.sanguine !== false;
  const resolved = (!needSoulwar || soulwar.status === 'OK') && (!needSanguine || sanguine.status === 'OK');
  const failStatus = [
    ...(needSoulwar ? [soulwar.status] : []),
    ...(needSanguine ? [sanguine.status] : []),
  ].find(status => status !== 'OK') || 'QUEST_NAO_LISTADA';
  return {
    resolved,
    reason: resolved ? 'OK' : failStatus,
    soulwarCompleted: needSoulwar && soulwar.status === 'OK' ? soulwar.value : null,
    sanguineCompleted: needSanguine && sanguine.status === 'OK' ? sanguine.value : null,
  };
}

/**
 * Mescla, POR QUEST, o resultado parcial do JSON com o da guia Quests (DOM).
 * PURA (exportada para testes). Regra do requisito "nunca presumir":
 *   • para cada quest vale o primeiro dado CONCLUSIVO (true/false) — o da
 *     guia Quests (indicador oficial renderizado) tem prioridade; na ausência
 *     dele, preserva-se o que o JSON já tinha concluído;
 *   • sem nenhum dado conclusivo, fica `null` (o renderer exibe "?");
 *   • SW e SG são INDEPENDENTES: uma quest conclusiva NUNCA é descartada
 *     porque a outra ficou sem dado.
 */
function mergeQuestOutcomes(jsonOutcome, domOutcome) {
  const pick = (domValue, jsonValue) => {
    if (domValue === true || domValue === false) return domValue;
    if (jsonValue === true || jsonValue === false) return jsonValue;
    return null;
  };
  return {
    soulwarCompleted: pick(domOutcome?.soulwarCompleted, jsonOutcome?.soulwarCompleted),
    sanguineCompleted: pick(domOutcome?.sanguineCompleted, jsonOutcome?.sanguineCompleted),
  };
}

// ============================================================================
// REGISTRO DO MÉTODO NOVO
// ----------------------------------------------------------------------------
// Recebe por injeção tudo o que precisa. Não importa `electron-main.cjs` (o
// que criaria ciclo) e não redefine nada que já exista lá.
// ============================================================================
function registerBazaarNewMethod(deps) {
  const {
    ipcMain,
    diag,
    runQueued,
    getContext,
    ensureSessionReady,
    getSessionPage,
    fetchJsonDetailed,
    normalizeAuctionUrl,
    resolveQuestScope,
    resolveBrowserKey,
    isManualStopRequested,
    sendProgress,
    buildProgress,
    fetchDetailsWithPlaywright,
    // Plano de retries (navegador × tentativas, na ordem de preferência) —
    // a MESMA função do método Paginação (buildRubinotRetryPlan), injetada
    // para o modo Quests respeitar os "Retries por navegador" do modal sem
    // duplicar a lógica. Opcional: sem ela, o modo Quests simplesmente não
    // executa retries pelo navegador.
    buildRetryPlan,
    getSelectedBrowser,
    getUseCleanProfile,
    apiBase,
  } = deps || {};

  if (!ipcMain) throw new Error('registerBazaarNewMethod: ipcMain é obrigatório.');

  // ==========================================================================
  // RITMO — corrigido após a primeira execução real
  // --------------------------------------------------------------------------
  // A primeira execução (208 personagens) mostrou `apiStatus: 429` já na
  // validação da sessão e 190 respostas não-JSON. O diagnóstico é direto: o
  // intervalo de 120ms que eu havia escolhido atropelou o limite de taxa do
  // servidor. Não era a rota que faltava — era ritmo.
  //
  // Correção em três frentes, espelhando o que o método antigo já faz na
  // listagem (`fetchRubinotBazaarPageResilient`):
  //   1. intervalo base maior;
  //   2. retentativa da MESMA chamada em caso de 429, com backoff que
  //      respeita o cabeçalho `Retry-After` quando o servidor o envia;
  //   3. desaceleração adaptativa: cada 429 aumenta o intervalo de todas as
  //      chamadas seguintes; sequências de sucesso o reduzem de volta.
  //
  // Mesmo assim continua MUITO mais barato que o método antigo: 1 requisição
  // JSON por personagem contra uma SPA inteira renderizada.
  const API_GAP_BASE_MS = 350;
  /** Teto do acréscimo adaptativo, para nunca virar uma consulta eterna. */
  const API_GAP_MAX_EXTRA_MS = 2000;
  /** Quanto cada 429 acrescenta ao intervalo das próximas chamadas. */
  const API_GAP_STEP_MS = 250;
  /** Sucessos seguidos necessários para acelerar de volta um degrau. */
  const API_SPEEDUP_STREAK = 8;
  /** Tentativas por personagem: 1 inicial + 2 retentativas em caso de 429. */
  const API_MAX_ATTEMPTS = 3;
  /** Base do backoff entre tentativas da MESMA chamada. */
  const API_BACKOFF_MS = 1200;

  /** Acréscimo adaptativo corrente e sequência de sucessos. */
  let apiGapExtraMs = 0;
  let apiSuccessStreak = 0;

  function currentApiGapMs() {
    return API_GAP_BASE_MS + apiGapExtraMs;
  }

  function registerRateLimited() {
    apiSuccessStreak = 0;
    apiGapExtraMs = Math.min(API_GAP_MAX_EXTRA_MS, apiGapExtraMs + API_GAP_STEP_MS);
  }

  function registerApiSuccess() {
    apiSuccessStreak += 1;
    if (apiSuccessStreak >= API_SPEEDUP_STREAK && apiGapExtraMs > 0) {
      apiSuccessStreak = 0;
      apiGapExtraMs = Math.max(0, apiGapExtraMs - API_GAP_STEP_MS);
    }
  }

  // ==========================================================================
  // LEITURA DOM DA GUIA "QUESTS" — segunda camada do modo Quests
  // --------------------------------------------------------------------------
  // Usada apenas para quem o JSON não resolveu no modo "quests". Reaproveita a
  // MESMA sessão/página da validação (nenhum navegador novo) e lê as linhas
  // [ícone][nome] descritas pelo site real:
  //   • marcado   = svg com classe `lucide-circle-check-big`;
  //   • desmarcado = div `rounded-full border-2` com `border-[var(--text-muted)]`
  //     (classe com colchetes não entra em querySelector — filtra por className).
  // A associação ícone→nome NÃO depende de posição global: sobe do ícone até o
  // primeiro ancestral com texto curto (a linha da quest) e compara o texto
  // normalizado com "soul war" / "rotten blood".
  // ==========================================================================
  const QUESTS_DOM_PAGE_TIMEOUT_MS = 30000;
  const QUESTS_DOM_TAB_WAIT_MS = 12000;
  const QUESTS_DOM_PANEL_WAIT_MS = 8000;
  const QUESTS_DOM_POLL_MS = 300;
  const QUESTS_DOM_SETTLE_MS = 250;
  /** Pausa entre personagens da passada DOM (renderização é mais pesada). */
  const QUESTS_DOM_GAP_MS = 600;

  /** Texto amigável de cada motivo de falha da leitura da guia Quests. */
  const QUESTS_DOM_REASON_TEXT = {
    URL_AUSENTE: 'Personagem sem URL de leilão.',
    NAVEGACAO_FALHOU: 'A página do personagem não abriu.',
    RUBINOT_ERRO_APP: 'O RubinOT exibiu "Falha ao carregar leilão" nesta página.',
    ABA_QUESTS_NAO_ENCONTRADA: 'A página abriu, mas não expõe a aba Quests.',
    ABA_QUESTS_NAO_CLICAVEL: 'A aba Quests não respondeu ao clique.',
    LISTA_DE_QUESTS_NAO_MONTOU: 'A lista da guia Quests não terminou de montar.',
    QUEST_NAO_LISTADA: 'A guia Quests montou, mas não lista Soul War/Rotten Blood.',
    CONFLITO: 'A guia Quests apresentou estados conflitantes para a mesma quest.',
    QUESTS_INCONCLUSIVAS_NO_JSON: 'O JSON não trouxe a situação das quests.',
  };

  /**
   * Motivos ESTRUTURAIS da leitura da guia Quests: a consulta em si falhou
   * (página não abriu, aba ausente, lista não montou). Só eles podem marcar o
   * personagem como FALHA (`error`) — e apenas quando NENHUMA quest ficou
   * conclusiva nem pelo JSON. Já QUEST_NAO_LISTADA/CONFLITO significam que a
   * leitura FUNCIONOU e o dado é que não existe/não é confiável: o resultado
   * honesto é "?" (null), sem erro e sem presumir disponível/indisponível.
   */
  const QUESTS_DOM_STRUCTURAL_REASONS = new Set([
    'URL_AUSENTE',
    'NAVEGACAO_FALHOU',
    'RUBINOT_ERRO_APP',
    'ABA_QUESTS_NAO_ENCONTRADA',
    'ABA_QUESTS_NAO_CLICAVEL',
    'LISTA_DE_QUESTS_NAO_MONTOU',
  ]);

  /**
   * Motivos de TRANSPORTE da passada JSON: a consulta individual nem chegou a
   * entregar uma resposta JSON legível (rota/permissão/limite/servidor).
   * Diferem de QUESTS_INCONCLUSIVAS_NO_JSON (resposta veio, mas as quests não
   * estavam interpretáveis): transporte falho SEM nenhum retry que leia a
   * página e SEM nada conclusivo é FALHA real (`error`); resposta legível
   * porém inconclusiva é resultado honesto "?" (sem `error`).
   */
  const QUESTS_JSON_TRANSPORT_REASONS = new Set([
    'ID_AUSENTE',
    'ROTA_INEXISTENTE',
    'ACESSO_NEGADO',
    'NAO_AUTENTICADO',
    'ERRO_DO_SERVIDOR',
    'RESPOSTA_NAO_JSON',
    'LIMITE_DE_TAXA_429',
  ]);

  async function readQuestsTabViaDom(page, auction, quests) {
    const url = normalizeAuctionUrl(auction);
    if (!url) return { resolved: false, reason: 'URL_AUSENTE' };

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: QUESTS_DOM_PAGE_TIMEOUT_MS });
    } catch (error) {
      return { resolved: false, reason: 'NAVEGACAO_FALHOU', error: String(error?.message || error) };
    }

    // ── 1) Esperar a SPA hidratar: aba Quests presente OU erro da página ──
    const tabDeadline = Date.now() + QUESTS_DOM_TAB_WAIT_MS;
    let tabState = { hasError: false, hasTab: false };
    while (Date.now() < tabDeadline) {
      tabState = await page.evaluate(() => {
        const strip = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
        const bodyText = strip(document.body ? document.body.innerText || '' : '');
        const hasError = bodyText.includes('falha ao carregar leilao') || bodyText.includes('failed to load auction');
        const candidates = Array.from(document.querySelectorAll('button, a, [role="tab"]'));
        const hasTab = candidates.some(el => {
          const text = strip(el.textContent);
          return text === 'quests' || text === 'quest';
        });
        return { hasError, hasTab };
      }).catch(() => ({ hasError: false, hasTab: false }));
      if (tabState.hasError || tabState.hasTab) break;
      await page.waitForTimeout(QUESTS_DOM_POLL_MS);
    }
    if (tabState.hasError) return { resolved: false, reason: 'RUBINOT_ERRO_APP' };
    if (!tabState.hasTab) return { resolved: false, reason: 'ABA_QUESTS_NAO_ENCONTRADA' };

    // ── 2) Clicar na aba Quests (clique dentro da própria página) ─────────
    const clicked = await page.evaluate(() => {
      const strip = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
      const candidates = Array.from(document.querySelectorAll('button, a, [role="tab"]'));
      const tab = candidates.find(el => {
        const text = strip(el.textContent);
        return text === 'quests' || text === 'quest';
      });
      if (!tab) return false;
      tab.click();
      return true;
    }).catch(() => false);
    if (!clicked) return { resolved: false, reason: 'ABA_QUESTS_NAO_CLICAVEL' };
    await page.waitForTimeout(QUESTS_DOM_SETTLE_MS);

    // ── 3) Esperar a lista montar e extrair as linhas [ícone][nome] ───────
    // `extractQuestRowsInPage` é função de MÓDULO autocontida: o Playwright
    // a serializa para rodar na página; a mesma função é testada em jsdom.
    const panelDeadline = Date.now() + QUESTS_DOM_PANEL_WAIT_MS;
    let extraction = { ready: false, rows: [] };
    while (Date.now() < panelDeadline) {
      extraction = await page.evaluate(extractQuestRowsInPage).catch(() => ({ ready: false, rows: [] }));
      if (extraction.ready) break;
      await page.waitForTimeout(QUESTS_DOM_POLL_MS);
    }
    if (!extraction.ready) return { resolved: false, reason: 'LISTA_DE_QUESTS_NAO_MONTOU' };

    // ── 4) Decidir cada quest de forma INDEPENDENTE (função pura testada) ──
    const decision = decideQuestsFromDomRows(extraction.rows, quests);
    return {
      ...decision,
      evidence: { rowsSample: extraction.rows.slice(0, 40) },
    };
  }

  /**
   * Consulta os detalhes de UM personagem pela API individual.
   *
   * Nunca lança: qualquer problema vira `{ resolved: false }` e o personagem
   * segue para o fallback no método antigo.
   *
   * O 429 é tratado como TRANSITÓRIO (é ritmo, não ausência de dado), então
   * ele merece retentativa — ao contrário de 403/404, que são conclusivos e
   * saem na primeira resposta.
   */
  async function fetchOneByApi(page, auction, quests, questSource = 'bosstiary') {
    const id = auction?.id || '';
    const url = buildAuctionApiUrl(apiBase, id);
    if (!url) return { resolved: false, reason: 'ID_AUSENTE', status: 0 };

    let lastStatus = 0;
    let lastPreview = '';

    for (let attempt = 1; attempt <= API_MAX_ATTEMPTS; attempt++) {
      if (isManualStopRequested()) {
        return { resolved: false, reason: 'ENCERRAMENTO_MANUAL', status: lastStatus };
      }

      let response = null;
      try {
        response = await fetchJsonDetailed(page, url);
      } catch (error) {
        return { resolved: false, reason: 'ERRO_DE_REDE', status: 0, error: String(error?.message || error) };
      }

      lastStatus = Number(response?.status || 0);
      lastPreview = String(response?.textPreview || '').slice(0, 180);

      // ── 429: ritmo, não falta de dado. Espera e tenta de novo. ────────────
      if (lastStatus === 429) {
        registerRateLimited();
        if (attempt < API_MAX_ATTEMPTS) {
          const retryAfterSec = Number(response?.retryAfter || 0);
          const backoff = retryAfterSec > 0
            ? Math.min(retryAfterSec * 1000, 15000)
            : API_BACKOFF_MS * attempt;
          diag('details-v2', 'Limite de taxa (429); aguardando antes de repetir a mesma chamada.', {
            id, tentativa: `${attempt}/${API_MAX_ATTEMPTS}`, esperaMs: backoff, intervaloAtualMs: currentApiGapMs(),
          });
          await page.waitForTimeout(backoff);
          continue;
        }
        return { resolved: false, reason: 'LIMITE_DE_TAXA_429', status: lastStatus, preview: lastPreview };
      }

      if (!response?.ok || !response?.isJson || !response?.data) {
        return {
          resolved: false,
          reason: lastStatus === 404 ? 'ROTA_INEXISTENTE'
            : lastStatus === 403 ? 'ACESSO_NEGADO'
              : lastStatus === 401 ? 'NAO_AUTENTICADO'
                : lastStatus >= 500 ? 'ERRO_DO_SERVIDOR'
                  : 'RESPOSTA_NAO_JSON',
          status: lastStatus,
          preview: lastPreview,
        };
      }

      registerApiSuccess();
      // Identificação escolhida no modal: "bosstiary" mantém a derivação
      // ATUAL (bosses do payload); "quests" procura a lista de quests com
      // flag claro de conclusão no MESMO payload (zero chamadas extras).
      const derived = questSource === 'quests'
        ? deriveQuestsFromQuestEntries(response.data, quests)
        : deriveQuestsFromApiPayload(response.data, quests);
      return { ...derived, status: lastStatus };
    }

    return { resolved: false, reason: 'LIMITE_DE_TAXA_429', status: lastStatus, preview: lastPreview };
  }

  // ==========================================================================
  // HANDLER — detalhes pelo método novo
  // --------------------------------------------------------------------------
  // Mesmo contrato de entrada e de SAÍDA do handler antigo
  // (`rubinot-bazaar-details`): o renderer não precisa saber qual método rodou.
  // ==========================================================================
  ipcMain.handle('rubinot-bazaar-details-v2', async (event, auctions, options = {}) => {
    const list = Array.isArray(auctions) ? auctions : [];
    const merged = { ...(options || {}), cleanProfile: !!(getUseCleanProfile && getUseCleanProfile()) };

    return runQueued('bazaar-details-v2', async () => {
      const startedAt = Date.now();
      const quests = resolveQuestScope(merged);
      // Identificação das quests: "bosstiary" (atual, padrão) ou "quests"
      // (guia Quests da página oficial). Decide SOMENTE como SW/SG são
      // identificadas — listagem, filtros e contrato de saída não mudam.
      const questSource = resolveQuestSource(merged);
      const methodLabel = questSource === 'quests' ? 'API JSON (Quests)' : 'API JSON (Bosstiary)';
      const browserKey = resolveBrowserKey(getSelectedBrowser ? getSelectedBrowser() : '');
      const details = {};

      diag('details-v2', 'MÉTODO API JSON: iniciando análise (sem renderizar página individual).', {
        total: list.length, quests, identificacao: questSource, navegador: browserKey, endpoint: `${apiBase}/{ID}`,
      });

      // ── Sessão ────────────────────────────────────────────────────────────
      // Mesma validação do método antigo: cookies + Cloudflare + API viva.
      // Reutiliza a função existente, sem alterá-la.
      let page = null;
      try {
        const context = await getContext(browserKey, merged.cleanProfile);
        const session = await ensureSessionReady(context, null, 'details-v2-session');
        if (!session.ok) {
          return {
            ok: false,
            error: session.message || 'Sessão Rubinot indisponível para o método novo.',
            needsHumanVerification: !!session.needsHumanVerification,
            details: {},
          };
        }
        page = session.page || await getSessionPage(context);
      } catch (error) {
        return { ok: false, error: String(error?.message || error), details: {} };
      }

      // ── Passada JSON ──────────────────────────────────────────────────────
      const unresolved = [];
      // Modo QUESTS: resultado PARCIAL do JSON por personagem (ex.: Soul War
      // conclusiva e Sanguine sem flag). É preservado e mesclado POR QUEST com
      // a leitura da guia Quests — um dado conclusivo NUNCA é descartado
      // porque a outra quest ficou inconclusiva (requisito do "?").
      const jsonPartialByKey = {};
      let resolvedCount = 0;
      let stoppedManually = false;
      // Retrato do primeiro payload recebido: é o que revela o schema real.
      let firstShapeLogged = false;
      const failureReasons = {};
      const failureStatuses = {};
      const failureSamples = {};

      sendProgress(event.sender, buildProgress('details', 'API JSON: consultando quests...', 0, list.length, {
        methodLabel,
      }));

      for (let index = 0; index < list.length; index++) {
        if (isManualStopRequested()) {
          stoppedManually = true;
          diag('details-v2', 'Encerramento manual durante a passada JSON.', { analisados: index, restantes: list.length - index });
          break;
        }

        const auction = list[index];
        const key = auction?.id || auction?.name || auction?.url;
        if (!key) continue;

        const outcome = await fetchOneByApi(page, auction, quests, questSource);

        // Diagnóstico rico da PRIMEIRA resposta: chaves, storages e onde os
        // bosses/quests apareceram. É isto que responde, na prática, se a
        // rota existe e o que ela entrega.
        if (!firstShapeLogged && outcome.evidence) {
          firstShapeLogged = true;
          diag('details-v2', 'DESCOBERTA — formato real da resposta da API individual.', {
            id: key,
            resolvido: outcome.resolved,
            motivo: outcome.reason,
            identificacao: questSource,
            shape: outcome.evidence.shape || summarizeJsonShape(null),
            containersBosstiary: outcome.evidence.containers,
            caminhosDosBosses: outcome.evidence.bossPaths,
            storagesEncontrados: outcome.evidence.storages,
            // Modo "quests": entradas de quest encontradas no payload (com
            // flag interpretado) — o mapa real do schema das quests.
            entradasDeQuests: outcome.evidence.questEntries,
          });
        }

        if (outcome.resolved) {
          resolvedCount += 1;
          details[key] = questSource === 'quests'
            ? {
              id: key,
              method: 'api_json_quests_v1',
              // Marca a origem: o renderer oculta o contador de bosses
              // ("X/Y"), que não se aplica à identificação pela guia Quests.
              questSource: 'quests',
              soulwarCompleted: outcome.soulwarCompleted,
              sanguineCompleted: outcome.sanguineCompleted,
              fetchedAt: Date.now(),
            }
            : {
              id: key,
              method: 'api_json_v2',
              soulwarCompleted: outcome.soulwarCompleted,
              sanguineCompleted: outcome.sanguineCompleted,
              soulWarBossCount: outcome.soulWarBossCount,
              sanguineBossCount: outcome.sanguineBossCount,
              totalBosstiaryBosses: outcome.totalBosstiaryBosses,
              fetchedAt: Date.now(),
            };
        } else {
          failureReasons[outcome.reason] = (failureReasons[outcome.reason] || 0) + 1;
          // Status HTTP por motivo: sem isso, "RESPOSTA_NAO_JSON" some com a
          // causa real (429? 500? HTML de erro?) e o diagnóstico vira chute.
          if (outcome.status) {
            const bucket = `${outcome.reason}:${outcome.status}`;
            failureStatuses[bucket] = (failureStatuses[bucket] || 0) + 1;
          }
          // Amostra do corpo devolvido, uma única vez por motivo. É o que
          // permite distinguir um JSON de erro de uma página HTML.
          if (outcome.preview && !failureSamples[outcome.reason]) {
            failureSamples[outcome.reason] = outcome.preview;
          }
          // Modo QUESTS: guarda o que o JSON CONCLUIU (pode ser só uma das
          // quests) e o MOTIVO da inconclusão — base da mesclagem por quest
          // e da classificação final (inconclusivo honesto × falha real).
          if (questSource === 'quests') {
            jsonPartialByKey[key] = {
              soulwarCompleted: outcome.soulwarCompleted === true || outcome.soulwarCompleted === false ? outcome.soulwarCompleted : null,
              sanguineCompleted: outcome.sanguineCompleted === true || outcome.sanguineCompleted === false ? outcome.sanguineCompleted : null,
              reason: outcome.reason || 'QUESTS_INCONCLUSIVAS_NO_JSON',
            };
          }
          unresolved.push(auction);
        }

        sendProgress(event.sender, buildProgress('details', 'API JSON: consultando quests...', index + 1, list.length, {
          methodLabel,
          apiResolved: resolvedCount,
          apiFallbackPending: unresolved.length,
        }));

        if (index < list.length - 1) await page.waitForTimeout(currentApiGapMs());
      }

      diag('details-v2', 'Passada JSON concluída.', {
        total: list.length,
        resolvidosPelaApi: resolvedCount,
        paraFallback: unresolved.length,
        motivos: failureReasons,
        statusHttpPorMotivo: failureStatuses,
        amostrasDeResposta: failureSamples,
        intervaloFinalMs: currentApiGapMs(),
        tempoMs: Date.now() - startedAt,
      });

      // ── SEGUNDA CAMADA — depende da identificação escolhida ──────────────
      //
      //   • "bosstiary" (ATUAL, intacto): quem a API não resolveu é analisado
      //     EXATAMENTE como hoje pelo método Paginação (Bosstiary renderizada),
      //     incluindo o retry multi-navegador.
      //
      //   • "quests": a consulta é JSON-PRIMEIRO e o navegador SÓ entra como
      //     RETRY EXPLÍCITO. Sem NENHUM "Retries por navegador" selecionado no
      //     modal, a consulta TERMINA nos resultados do JSON — nenhuma página
      //     de personagem é aberta e o que ficou sem dado vira "?" honesto.
      //     Com retries selecionados, SOMENTE os personagens inconclusivos ou
      //     falhos são lidos na guia Quests da página oficial, seguindo o
      //     MESMO plano de navegadores/quantidades do método Paginação
      //     (`buildRetryPlan` injetado do processo principal — fonte única).
      //     Resultados conclusivos do JSON são PRESERVADOS e nunca
      //     reconsultados; a mesclagem é POR QUEST (SW/SG independentes).
      //     NUNCA cai no critério Bosstiary, que o usuário não escolheu, e
      //     nunca recebe resultado inventado.
      let fallbackResult = null;
      let domResolvedCount = 0;
      let domInconclusiveCount = 0;
      let partialPreservedCount = 0;
      const domFailureReasons = {};
      const questsRetryStats = [];
      const questsRetryBrowsers = [];
      if (questSource === 'quests') {
        // Pendentes da passada JSON, com o parcial acumulado por quest e o
        // motivo da inconclusão (classificação final honesta).
        const pendingByKey = new Map();
        for (const auction of unresolved) {
          const key = auction?.id || auction?.name || auction?.url;
          if (!key || details[key]) continue;
          const partial = jsonPartialByKey[key] || { soulwarCompleted: null, sanguineCompleted: null, reason: 'QUESTS_INCONCLUSIVAS_NO_JSON' };
          pendingByKey.set(key, {
            auction,
            partial: { soulwarCompleted: partial.soulwarCompleted, sanguineCompleted: partial.sanguineCompleted },
            hadJsonData: partial.soulwarCompleted !== null || partial.sanguineCompleted !== null,
            jsonReason: partial.reason || 'QUESTS_INCONCLUSIVAS_NO_JSON',
            domReadable: false,
            lastReason: partial.reason || 'QUESTS_INCONCLUSIVAS_NO_JSON',
          });
        }

        // Plano de retries: o MESMO formato do método Paginação (navegador ×
        // quantidade, na ordem de preferência do usuário). REQUISITO: sem
        // seleção explícita de retries o plano é VAZIO — o "retry único"
        // legado do método antigo NÃO se aplica ao modo Quests.
        const wantsRetries = (Array.isArray(merged.retryBrowsers) && merged.retryBrowsers.length > 0)
          || (merged.retryCounts && typeof merged.retryCounts === 'object' && !Array.isArray(merged.retryCounts)
            && Object.values(merged.retryCounts).some(value => Number(value) > 0));
        const retryPlan = (wantsRetries && typeof buildRetryPlan === 'function')
          ? (buildRetryPlan(browserKey, merged.retryBrowsers, merged.retryCounts, merged.browserOrder) || [])
          : [];
        diag('details-v2', 'Modo QUESTS: pendências da passada JSON e plano de retries pelo navegador.', {
          pendentes: pendingByKey.size,
          retriesSelecionados: wantsRetries,
          passadas: retryPlan.map(step => `${step.browser} ${step.attempt}/${step.attempts}`),
        });

        if (pendingByKey.size > 0 && retryPlan.length > 0 && !stoppedManually) {
          let retryPage = page;
          let currentRetryBrowser = browserKey;
          let stopAll = false;
          for (const step of retryPlan) {
            if (stopAll || pendingByKey.size === 0) break;
            if (isManualStopRequested()) { stoppedManually = true; break; }

            // Troca de motor quando a passada pede outro navegador — mesma
            // mecânica do método Paginação (getContext fecha o anterior na
            // troca). Sessão indisponível no motor => passada é PULADA, sem
            // derrubar a consulta nem descartar o que já foi apurado.
            if (step.browser !== currentRetryBrowser) {
              try {
                const retryContext = await getContext(step.browser, merged.cleanProfile);
                const retrySession = await ensureSessionReady(retryContext, null, `details-v2-retry-${step.browser}`);
                if (!retrySession.ok) {
                  diag('details-v2', 'Retry PULADO: sessão indisponível neste navegador.', {
                    navegador: step.browser, tentativa: `${step.attempt}/${step.attempts}`, motivo: retrySession.message || '',
                  });
                  continue;
                }
                retryPage = retrySession.page || await getSessionPage(retryContext);
                currentRetryBrowser = step.browser;
              } catch (error) {
                diag('details-v2', 'Retry PULADO: falha ao abrir o navegador da passada.', {
                  navegador: step.browser, error: String(error?.message || error),
                });
                continue;
              }
            }

            if (!questsRetryBrowsers.includes(step.browser)) questsRetryBrowsers.push(step.browser);
            const stat = { browser: step.browser, attempted: pendingByKey.size, recovered: 0, attempt: step.attempt, attempts: step.attempts };
            questsRetryStats.push(stat);
            diag('details-v2', 'Retry pelo navegador: lendo a guia Quests SOMENTE dos pendentes.', {
              navegador: step.browser, tentativa: `${step.attempt}/${step.attempts}`, pendentes: pendingByKey.size,
            });

            const stepTargets = Array.from(pendingByKey.entries());
            for (let index = 0; index < stepTargets.length; index++) {
              if (isManualStopRequested()) {
                stoppedManually = true;
                stopAll = true;
                diag('details-v2', 'Encerramento manual durante o retry da guia Quests.', { analisados: index, restantes: stepTargets.length - index });
                break;
              }
              const [key, entry] = stepTargets[index];
              sendProgress(event.sender, buildProgress('details', `Retry ${step.browser} ${step.attempt}/${step.attempts}: lendo a guia Quests dos pendentes...`, index, stepTargets.length, {
                methodLabel,
                apiResolved: resolvedCount,
                domResolved: domResolvedCount,
              }));

              const outcome = await readQuestsTabViaDom(retryPage, entry.auction, quests);
              // Mesclagem POR QUEST: guia Quests (quando conclusiva) >
              // parcial já acumulado > `null` ("?"). SW/SG independentes.
              entry.partial = mergeQuestOutcomes(entry.partial, outcome);
              const structuralFailure = !outcome.resolved && QUESTS_DOM_STRUCTURAL_REASONS.has(outcome.reason);
              if (!structuralFailure) entry.domReadable = true;
              if (outcome.reason && outcome.reason !== 'OK') entry.lastReason = outcome.reason;

              const needSoulwar = quests.soulwar !== false;
              const needSanguine = quests.sanguine !== false;
              const complete = (!needSoulwar || entry.partial.soulwarCompleted !== null)
                && (!needSanguine || entry.partial.sanguineCompleted !== null);
              if (complete) {
                domResolvedCount += 1;
                stat.recovered += 1;
                if (entry.hadJsonData) partialPreservedCount += 1;
                details[key] = {
                  id: key,
                  method: 'quests_tab_dom_v1',
                  questSource: 'quests',
                  soulwarCompleted: entry.partial.soulwarCompleted,
                  sanguineCompleted: entry.partial.sanguineCompleted,
                  fetchedAt: Date.now(),
                };
                pendingByKey.delete(key);
              } else {
                domFailureReasons[outcome.reason] = (domFailureReasons[outcome.reason] || 0) + 1;
                // Amostra das linhas lidas, uma vez por motivo — diagnóstico
                // de seletor/estrutura sem poluir o log.
                if (outcome.evidence?.rowsSample && !failureSamples[`DOM_${outcome.reason}`]) {
                  failureSamples[`DOM_${outcome.reason}`] = outcome.evidence.rowsSample
                    .slice(0, 10)
                    .map(row => `${row.checked ? '[x]' : '[ ]'} ${row.text}`)
                    .join(' | ')
                    .slice(0, 400);
                }
              }

              if (index < stepTargets.length - 1) await retryPage.waitForTimeout(QUESTS_DOM_GAP_MS);
            }
          }
          diag('details-v2', 'Retries da guia Quests concluídos.', {
            recuperados: domResolvedCount,
            aindaPendentes: pendingByKey.size,
            passadas: questsRetryStats.map(item => `${item.browser} ${item.attempt}/${item.attempts}: +${item.recovered}/${item.attempted}`),
            motivos: domFailureReasons,
          });
        }

        // ── FECHO do modo QUESTS: quem restou pendente vira resultado HONESTO ─
        // Classificação (requisito "manter ?"):
        //   • qualquer dado conclusivo preservado, OU resposta JSON legível
        //     (quests apenas inconclusivas), OU guia Quests lida em algum
        //     retry → detail SEM `error`; o que faltou fica `null` → "?";
        //   • transporte JSON falhou E nenhum retry leu a página E nada
        //     conclusivo → FALHA real (`error` + `failureReason`), quests
        //     `null` ("?"), nunca presumidas.
        for (const [key, entry] of pendingByKey) {
          const hasAnyConclusive = entry.partial.soulwarCompleted !== null || entry.partial.sanguineCompleted !== null;
          const jsonReadable = !QUESTS_JSON_TRANSPORT_REASONS.has(entry.jsonReason);
          const attemptedDom = questsRetryStats.length > 0;
          if (hasAnyConclusive || jsonReadable || entry.domReadable) {
            domInconclusiveCount += 1;
            if (entry.hadJsonData) partialPreservedCount += 1;
            details[key] = {
              id: key,
              method: attemptedDom ? 'quests_tab_dom_v1' : 'api_json_quests_v1',
              questSource: 'quests',
              soulwarCompleted: entry.partial.soulwarCompleted,
              sanguineCompleted: entry.partial.sanguineCompleted,
              fetchedAt: Date.now(),
              // Diagnóstico (NÃO é falha): por que restou "?" neste
              // personagem. O renderer ignora o campo.
              inconclusiveReason: entry.lastReason,
            };
          } else {
            details[key] = {
              id: key,
              method: attemptedDom ? 'quests_tab_dom_v1' : 'api_json_quests_v1',
              questSource: 'quests',
              soulwarCompleted: null,
              sanguineCompleted: null,
              fetchedAt: Date.now(),
              failureReason: entry.lastReason,
              error: QUESTS_DOM_REASON_TEXT[entry.lastReason]
                || `A consulta JSON deste personagem falhou (${entry.lastReason}) e nenhum retry pelo navegador leu a guia Quests.`,
            };
          }
        }
        diag('details-v2', 'Modo QUESTS consolidado.', {
          total: list.length,
          resolvidosPelaApi: resolvedCount,
          recuperadosPorRetry: domResolvedCount,
          inconclusivosHonestos: domInconclusiveCount,
          parciaisDoJsonPreservados: partialPreservedCount,
          motivosDom: domFailureReasons,
        });
      } else if (unresolved.length > 0 && !stoppedManually) {
        diag('details-v2', 'Delegando ao método PAGINAÇÃO os personagens que a API não resolveu.', {
          quantidade: unresolved.length,
        });
        fallbackResult = await fetchDetailsWithPlaywright(unresolved, merged, event.sender, browserKey);
        if (fallbackResult?.details) Object.assign(details, fallbackResult.details);
        if (fallbackResult?.stoppedManually) stoppedManually = true;
      }

      // ── Consolidação no MESMO contrato do handler antigo ───────────────────
      const analyzedCount = Object.values(details).filter(detail => detail && !detail.error).length;
      const failedCount = Math.max(0, list.length - analyzedCount);
      const failedCharacterList = list
        .filter(auction => {
          const key = auction?.id || auction?.name || auction?.url;
          return key && details[key] && details[key].error;
        })
        .map(auction => {
          const key = auction?.id || auction?.name || auction?.url;
          return {
            id: String(auction?.id || ''),
            name: String(auction?.name || ''),
            url: normalizeAuctionUrl(auction),
            reason: String(details[key]?.failureReason || ''),
          };
        })
        .filter(entry => entry.url);

      const successRate = list.length > 0 ? Math.round((analyzedCount / list.length) * 100) : 0;

      diag('resumo-v2', 'MÉTODO API JSON finalizado.', {
        total: list.length,
        identificacao: questSource,
        resolvidosPelaApi: resolvedCount,
        resolvidosPelaGuiaQuests: domResolvedCount,
        // Inconclusivos honestos ("?") NÃO são "resolvidos pelo fallback" —
        // ficam fora da conta para o resumo não inflar números.
        inconclusivosHonestos: domInconclusiveCount,
        resolvidosPeloFallback: questSource === 'quests'
          ? 0
          : Math.max(0, analyzedCount - resolvedCount - domResolvedCount),
        falhas: failedCount,
        taxaSucesso: `${successRate}%`,
        tempoTotalMs: Date.now() - startedAt,
      });

      return {
        ok: true,
        details,
        // Campos do contrato antigo, preenchidos a partir do fallback quando
        // ele rodou — o renderer exibe "Última Consulta" sem saber a origem.
        // No modo QUESTS, as passadas de retry da guia Quests alimentam os
        // MESMOS campos (browser × tentados × recuperados) do método antigo.
        primaryBrowser: browserKey,
        retryBrowser: fallbackResult?.retryBrowser || questsRetryBrowsers[0] || '',
        retryStats: questsRetryStats.length > 0 ? questsRetryStats : (fallbackResult?.retryStats || []),
        retryBrowsers: questsRetryBrowsers.length > 0 ? questsRetryBrowsers : (fallbackResult?.retryBrowsers || []),
        totalRequested: list.length,
        analyzedCount,
        recoveredCount: questSource === 'quests' ? domResolvedCount : (fallbackResult?.recoveredCount || 0),
        failedCount,
        failedCharacterList,
        sessionExpired: fallbackResult?.sessionExpired === true,
        sessionStatus: fallbackResult?.sessionStatus || 'desconhecida',
        consecutiveFailures: fallbackResult?.consecutiveFailures || 0,
        stoppedManually,
        notAnalyzedCount: Math.max(0, list.length - Object.keys(details).length),
        successRate,
        totalDurationMs: Date.now() - startedAt,
        // ── Telemetria exclusiva do método novo ─────────────────────────────
        methodUsed: 'novo',
        questSource,
        apiResolvedCount: resolvedCount,
        apiFallbackCount: unresolved.length,
        apiFailureReasons: failureReasons,
        domResolvedCount,
        domInconclusiveCount,
        partialPreservedCount,
        domFailureReasons,
      };
    });
  });

  diag('context', 'Método NOVO do Bazaar registrado (canal rubinot-bazaar-details-v2).', {
    endpoint: `${apiBase}/{ID}`,
  });
}

module.exports = {
  registerBazaarNewMethod,
  // Exportados para os testes — funções puras, sem efeito colateral.
  normalizeBossName,
  walkJson,
  collectBossMentions,
  findBosstiaryContainers,
  collectStorageEntries,
  summarizeJsonShape,
  deriveQuestsFromApiPayload,
  buildAuctionApiUrl,
  NEW_SOUL_WAR_BOSSES,
  NEW_SANGUINE_BOSSES,
  // Modo QUESTS (identificação pela guia Quests) — também funções puras.
  resolveQuestSource,
  interpretQuestCompletionFlag,
  collectQuestEntries,
  deriveQuestsFromQuestEntries,
  // Fonte oficial: storages + predicado do frontend do site.
  QUEST_STORAGE_RULES,
  toStoragesMap,
  deriveQuestsFromStorages,
  extractQuestRowsInPage,
  decideQuestsFromDomRows,
  mergeQuestOutcomes,
  NEW_QUEST_NAME_SOULWAR,
  NEW_QUEST_NAME_SANGUINE,
};
