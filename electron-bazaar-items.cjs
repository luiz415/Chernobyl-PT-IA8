// ============================================================================
// BAZAAR — CONSULTA DE ITENS (canal `rubinot-bazaar-items-v2`)
// ----------------------------------------------------------------------------
// Módulo ADITIVO do painel "Personagens com Itens". Segue o mesmo desenho do
// método novo das quests (`electron-bazaar-new.cjs`):
//
//   • NÃO importa `electron-main.cjs` — recebe tudo por injeção;
//   • usa a MESMA sessão/cookies/fila do restante do Bazaar;
//   • consulta cada personagem por `fetch('/api/bazaar/<id>')` JSON dentro da
//     página autenticada — ZERO renderização de página individual;
//   • NUNCA cai no método antigo (página-a-página). Requisito explícito da
//     funcionalidade: personagem que a API não resolver vira FALHA declarada,
//     nunca uma navegação DOM.
//
// O renderer envia a lista de nomes monitorados JÁ NORMALIZADOS (watchKeys) e
// recebe de volta apenas os MATCHES brutos — nome encontrado, chave base,
// Tier e quantidade. Todo o cálculo de valor (Tier +30%/nível, kk→RC) é feito
// no renderer, com as funções já existentes. Nada é persistido aqui.
// ============================================================================

'use strict';

// `walkJson` é exportado pelo módulo do método novo exatamente para reuso:
// varredura defensiva com trava de profundidade/nós e proteção contra ciclos.
// `deriveQuestsFromApiPayload` é a MESMA função usada pela consulta de quests:
// aqui ela roda sobre o payload JÁ BAIXADO de cada leilão (zero fetch extra)
// para o fluxo "Comprado" da guia Itens registrar as quests REAIS do
// personagem — nunca assumidas como disponíveis.
const { walkJson, deriveQuestsFromApiPayload } = require('./electron-bazaar-new.cjs');

/** Mesma normalização de `normalizeWatchedItemName` (src/utils/bazaarWatchedItems.ts). */
function normalizeItemName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’`´]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Padrão oficial do Tier no nome: "Falcon Coif [Tier 3]". */
const TIER_PATTERN = /\s*\[\s*tier\s*(\d+)\s*\]\s*/i;

/** Separa o Tier do nome. Sem o padrão -> tier 0 e base igual ao nome. */
function parseTieredName(raw) {
  const text = String(raw || '');
  const match = text.match(TIER_PATTERN);
  if (!match) return { baseName: text.trim(), tier: 0 };
  const tier = Number(match[1]);
  return {
    baseName: text.replace(TIER_PATTERN, ' ').replace(/\s+/g, ' ').trim(),
    tier: Number.isFinite(tier) && tier > 0 ? Math.floor(tier) : 0,
  };
}

/** Chaves de objeto que costumam carregar o NOME de um item. */
const ITEM_NAME_KEYS = ['name', 'item_name', 'itemName', 'itemname', 'title'];
/** Chaves que costumam carregar a QUANTIDADE. */
const ITEM_AMOUNT_KEYS = ['amount', 'count', 'quantity', 'stack', 'total'];
/** Chaves que costumam carregar o TIER como campo separado. */
const ITEM_TIER_KEYS = ['tier', 'upgradeTier', 'upgrade_tier', 'classificationTier'];

/**
 * Seções do payload que devem ser IGNORADAS por completo na contagem.
 *
 * `highlightItems` é a área de "itens destacados" que o proprietário da
 * oferta escolhe exibir no topo da página. Confirmado com o JSON real da
 * rota `/api/bazaar/{ID}` (leilão 283062): os itens dessa seção REPETEM
 * entradas que já constam na lista normal `items[]` (ex.: "soulshell"
 * tier 1 presente nas duas) — contá-los duplicava o valor do personagem.
 * Regra do negócio: o item só conta quando aparece na lista normal; o
 * destaque é apenas vitrine. `highlightAugments` é o complemento textual
 * da mesma vitrine ("1189 Level" etc.) e é ignorado pelo mesmo motivo.
 */
const IGNORED_SECTION_KEYS = new Set(['highlightItems', 'highlightAugments']);

/** Primeiro segmento do caminho gerado pelo walkJson ("a.b[0].c" -> "a"). */
function pathRootSegment(path) {
  const text = String(path || '');
  const cut = text.search(/[.[]/);
  return cut === -1 ? text : text.slice(0, cut);
}

function readNumericField(node, keys) {
  for (const key of keys) {
    const value = Number(node[key]);
    if (Number.isFinite(value) && value > 0) return Math.floor(value);
  }
  return 0;
}

/**
 * Todos os itens monitorados citados no JSON do leilão.
 *
 * Estratégia defensiva (o schema real não é assumido):
 *   • OBJETOS com um campo de nome ({ name: "Falcon Coif [Tier 3]", amount: 1 })
 *     — cobre inventário/equipamentos/store no formato mais comum;
 *   • STRINGS que são elementos diretos de um array (["falcon coif", ...])
 *     — cobre listas simples de nomes. Strings em OUTRAS posições (ex.: a
 *     própria propriedade `name` de um objeto já contado) são ignoradas para
 *     não duplicar a contagem.
 *
 * Casamento SEMPRE por igualdade do nome normalizado SEM o sufixo de Tier —
 * exatamente a regra da Lista de Itens no renderer.
 *
 * Ocorrências idênticas (mesma chave base + tier + nome) são somadas.
 *
 * EXCLUSÃO: nós dentro das seções de DESTAQUE (`highlightItems`/
 * `highlightAugments`) são pulados — são vitrine do proprietário e repetem
 * itens que já constam na lista normal (ver IGNORED_SECTION_KEYS).
 */
function collectItemMatches(payload, watchKeySet) {
  const found = new Map();

  const register = (rawName, amountField, tierField) => {
    const nameText = String(rawName || '').trim();
    if (!nameText || nameText.length > 120) return;
    const { baseName, tier: tierFromName } = parseTieredName(nameText);
    const baseKey = normalizeItemName(baseName);
    if (!baseKey || !watchKeySet.has(baseKey)) return;
    const tier = tierFromName > 0 ? tierFromName : (tierField > 0 ? tierField : 0);
    const amount = amountField > 0 ? amountField : 1;
    const mapKey = `${baseKey}|${tier}|${nameText.toLowerCase()}`;
    const existing = found.get(mapKey);
    if (existing) {
      existing.amount += amount;
    } else {
      found.set(mapKey, { foundName: nameText, baseKey, tier, amount });
    }
  };

  walkJson(payload, (node, path) => {
    // Seções de DESTAQUE ignoradas por inteiro: qualquer nó cujo caminho
    // comece em "highlightItems"/"highlightAugments" não conta. O walkJson
    // não permite podar a descida, então o corte é feito aqui, por caminho —
    // vale para o nó raiz da seção e para todos os descendentes.
    if (IGNORED_SECTION_KEYS.has(pathRootSegment(path))) return;
    if (typeof node === 'string') {
      // Somente elementos DIRETOS de arrays: o caminho termina em "[n]".
      if (/\]$/.test(path)) register(node, 0, 0);
      return;
    }
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    for (const nameKey of ITEM_NAME_KEYS) {
      const value = node[nameKey];
      if (typeof value !== 'string' || !value.trim()) continue;
      register(value, readNumericField(node, ITEM_AMOUNT_KEYS), readNumericField(node, ITEM_TIER_KEYS));
      break; // um nome por objeto — evita contar o mesmo nó duas vezes
    }
  });

  return Array.from(found.values());
}

/** URL da API individual — mesma rota do método novo das quests. */
function buildAuctionApiUrl(apiBase, id) {
  const safeId = encodeURIComponent(String(id || '').trim());
  if (!safeId) return '';
  return `${String(apiBase || '').replace(/\/+$/, '')}/${safeId}`;
}

// ============================================================================
// OURO E SKILLS DO PERSONAGEM (extração ADITIVA do mesmo payload JSON)
// ----------------------------------------------------------------------------
// O payload completo do leilão já chega em collectItemMatches — estas funções
// apenas LEEM mais dois grupos de informação do MESMO JSON, sem nenhuma
// chamada extra, sem tocar no fluxo de fetch/fila/sessão.
//
// O schema exato da rota `/api/bazaar/{ID}` não é assumido (mesma postura de
// collectItemMatches): a varredura é defensiva via walkJson, reconhecendo os
// formatos plausíveis por CHAVE DE OBJETO e por PAR rótulo/valor. Os caminhos
// onde cada dado foi encontrado são devolvidos em `paths` e registrados no
// diagnóstico — é o que permite confirmar o schema real na primeira execução
// e ajustar os hints com dado na mão, nunca com chute.
// ============================================================================

/**
 * Chaves de objeto que carregam o OURO da página do leilão.
 * "coins"/"coinAmount" NÃO entram aqui de propósito: no Bazaar isso é
 * Tibia/Rubini Coin (moeda da loja), não o ouro do personagem — usar essas
 * chaves duplicaria/contaminaria o valor.
 */
const GOLD_KEY_HINTS = /^(gold|goldAmount|gold_amount|goldCount|gold_count|totalGold|total_gold|money|balance)$/i;
/** Rótulos textuais que identificam o ouro num par rótulo/valor. */
const GOLD_LABEL_HINTS = /^(gold|ouro)$/i;

/** Skills reconhecidas: chave canônica -> hints de CHAVE e de RÓTULO. */
const SKILL_DEFS = [
  { key: 'axe', keyHint: /^(axe|axeFighting|axe_fighting|skillAxe|skill_axe)$/i, labelHint: /^axe(\s+fighting)?$/i },
  { key: 'club', keyHint: /^(club|clubFighting|club_fighting|skillClub|skill_club)$/i, labelHint: /^club(\s+fighting)?$/i },
  { key: 'sword', keyHint: /^(sword|swordFighting|sword_fighting|skillSword|skill_sword)$/i, labelHint: /^sword(\s+fighting)?$/i },
  // DISTANCE: hints ampliados ("dist", "distanceLevel", rótulos com sufixos
  // como "Distance Fighting Skill") — era a única skill sem retorno; as
  // demais permanecem com os hints originais (não alterar o que funciona).
  { key: 'distance', keyHint: /^(dist|distance|distFighting|dist_fighting|distanceFighting|distance_fighting|distanceLevel|distance_level|skillDistance|skill_distance|skillDist|skill_dist)$/i, labelHint: /^dist(ance)?([\s._-]*(fighting|level|skill))*$/i },
  { key: 'shielding', keyHint: /^(shielding|shield|skillShielding|skill_shielding)$/i, labelHint: /^shielding$/i },
  { key: 'fist', keyHint: /^(fist|fistFighting|fist_fighting|skillFist|skill_fist)$/i, labelHint: /^fist(\s+fighting)?$/i },
  { key: 'magic', keyHint: /^(magic|magicLevel|magic_level|magLevel|mag_level|mlevel|skillMagic|skill_magic)$/i, labelHint: /^magic(\s+level)?$/i },
];

/** Chaves que carregam o VALOR numérico num objeto de skill ({ name, level }). */
const SKILL_VALUE_KEYS = ['level', 'value', 'base', 'skillLevel', 'skill_level', 'amount'];
/** Chaves que carregam o RÓTULO num par rótulo/valor. */
const LABEL_KEYS = ['name', 'label', 'skill', 'type', 'title', 'key'];

/** Valor numérico >= 0 de um campo (aceita número ou string "1.100.000"). */
function parseLooseNumber(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return raw;
  if (typeof raw === 'string') {
    const cleaned = raw.replace(/[.,\s]/g, '');
    if (/^\d+$/.test(cleaned)) return Number(cleaned);
  }
  return null;
}

/**
 * Extrai OURO (inteiro, em gold) e SKILLS (inteiras) do payload do leilão.
 *
 * Dois formatos reconhecidos, nas seções NÃO ignoradas (a vitrine
 * `highlightItems`/`highlightAugments` é pulada como em collectItemMatches):
 *
 *   1. CAMPO DIRETO: `{ gold: 1100000 }`, `{ magicLevel: 112 }`,
 *      `{ skills: { axe: 119, ... } }` — casamento pelo NOME DA CHAVE;
 *   2. PAR RÓTULO/VALOR: `{ name: "Magic Level", level: 112 }`,
 *      `{ skill: "Axe Fighting", value: 119 }` — casamento pelo RÓTULO.
 *
 * Primeira ocorrência VÁLIDA vence (walk determinístico raiz→folhas); os
 * caminhos ficam em `paths` para diagnóstico. Skills são pisadas para
 * inteiro (a página pode trazer progresso fracionário).
 */
function collectGoldAndSkills(payload) {
  let gold = null;
  const skills = {};
  const paths = {};

  walkJson(payload, (node, path) => {
    if (IGNORED_SECTION_KEYS.has(pathRootSegment(path))) return;
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;

    const keys = Object.keys(node);

    // Formato 1 — campos diretos pelo nome da chave.
    for (const key of keys) {
      const value = parseLooseNumber(node[key]);
      if (value === null) continue;
      if (gold === null && GOLD_KEY_HINTS.test(key)) {
        gold = Math.floor(value);
        paths.gold = path ? `${path}.${key}` : key;
        continue;
      }
      for (const def of SKILL_DEFS) {
        if (skills[def.key] === undefined && def.keyHint.test(key) && value > 0) {
          skills[def.key] = Math.floor(value);
          paths[def.key] = path ? `${path}.${key}` : key;
        }
      }
    }

    // Formato 2 — par rótulo/valor ({ name: "Axe Fighting", level: 119 }).
    const labelKey = LABEL_KEYS.find(k => typeof node[k] === 'string' && node[k].trim());
    if (!labelKey) return;
    const label = node[labelKey].trim();
    const numeric = (() => {
      for (const vk of SKILL_VALUE_KEYS) {
        const v = parseLooseNumber(node[vk]);
        if (v !== null) return v;
      }
      return null;
    })();
    if (numeric === null) return;
    if (gold === null && GOLD_LABEL_HINTS.test(label)) {
      gold = Math.floor(numeric);
      paths.gold = `${path}(label)`;
      return;
    }
    for (const def of SKILL_DEFS) {
      if (skills[def.key] === undefined && def.labelHint.test(label) && numeric > 0) {
        skills[def.key] = Math.floor(numeric);
        paths[def.key] = `${path}(label)`;
      }
    }
  });

  return { gold: gold === null ? 0 : gold, skills, paths };
}

// ============================================================================
// REGISTRO
// ============================================================================
function registerBazaarItemsMethod(deps) {
  const {
    ipcMain,
    diag,
    runQueued,
    getContext,
    ensureSessionReady,
    getSessionPage,
    fetchJsonDetailed,
    normalizeAuctionUrl,
    resolveBrowserKey,
    isManualStopRequested,
    sendProgress,
    buildProgress,
    finishProgress,
    getSelectedBrowser,
    getUseCleanProfile,
    apiBase,
  } = deps || {};

  if (!ipcMain) throw new Error('registerBazaarItemsMethod: ipcMain é obrigatório.');

  // Mesmo ritmo adaptativo validado no método novo das quests: intervalo base
  // + backoff em 429 com desaceleração progressiva e reaceleração por streak.
  const API_GAP_BASE_MS = 350;
  const API_GAP_MAX_EXTRA_MS = 2000;
  const API_GAP_STEP_MS = 250;
  const API_SPEEDUP_STREAK = 8;
  const API_MAX_ATTEMPTS = 3;
  const API_BACKOFF_MS = 1200;

  let apiGapExtraMs = 0;
  let apiSuccessStreak = 0;

  const currentGapMs = () => API_GAP_BASE_MS + apiGapExtraMs;
  const registerRateLimited = () => {
    apiSuccessStreak = 0;
    apiGapExtraMs = Math.min(API_GAP_MAX_EXTRA_MS, apiGapExtraMs + API_GAP_STEP_MS);
  };
  const registerApiSuccess = () => {
    apiSuccessStreak += 1;
    if (apiSuccessStreak >= API_SPEEDUP_STREAK && apiGapExtraMs > 0) {
      apiSuccessStreak = 0;
      apiGapExtraMs = Math.max(0, apiGapExtraMs - API_GAP_STEP_MS);
    }
  };

  /** Consulta UM leilão pela API. Nunca lança: falha vira `{ ok: false, reason }`. */
  async function fetchOneAuctionJson(page, auction) {
    const id = auction?.id || '';
    const url = buildAuctionApiUrl(apiBase, id);
    if (!url) return { ok: false, reason: 'ID_AUSENTE', status: 0 };

    let lastStatus = 0;

    for (let attempt = 1; attempt <= API_MAX_ATTEMPTS; attempt++) {
      if (isManualStopRequested()) return { ok: false, reason: 'ENCERRAMENTO_MANUAL', status: lastStatus };

      let response = null;
      try {
        response = await fetchJsonDetailed(page, url);
      } catch (error) {
        return { ok: false, reason: 'ERRO_DE_REDE', status: 0, error: String(error?.message || error) };
      }

      lastStatus = Number(response?.status || 0);

      if (lastStatus === 429) {
        registerRateLimited();
        if (attempt < API_MAX_ATTEMPTS) {
          const retryAfterSec = Number(response?.retryAfter || 0);
          const backoff = retryAfterSec > 0 ? Math.min(retryAfterSec * 1000, 15000) : API_BACKOFF_MS * attempt;
          diag('items-v2', 'Limite de taxa (429); aguardando antes de repetir a mesma chamada.', {
            id, tentativa: `${attempt}/${API_MAX_ATTEMPTS}`, esperaMs: backoff, intervaloAtualMs: currentGapMs(),
          });
          await page.waitForTimeout(backoff);
          continue;
        }
        return { ok: false, reason: 'LIMITE_DE_TAXA_429', status: lastStatus };
      }

      if (!response?.ok || !response?.isJson || !response?.data) {
        return {
          ok: false,
          reason: lastStatus === 404 ? 'ROTA_INEXISTENTE'
            : lastStatus === 403 ? 'ACESSO_NEGADO'
              : lastStatus === 401 ? 'NAO_AUTENTICADO'
                : lastStatus >= 500 ? 'ERRO_DO_SERVIDOR'
                  : 'RESPOSTA_NAO_JSON',
          status: lastStatus,
        };
      }

      registerApiSuccess();
      return { ok: true, status: lastStatus, data: response.data };
    }

    return { ok: false, reason: 'LIMITE_DE_TAXA_429', status: lastStatus };
  }

  // ==========================================================================
  // HANDLER — itens por API JSON, sem fallback página-a-página
  // ==========================================================================
  ipcMain.handle('rubinot-bazaar-items-v2', async (event, auctions, options = {}) => {
    const list = Array.isArray(auctions) ? auctions : [];
    const watchSet = new Set(
      (Array.isArray(options?.watchKeys) ? options.watchKeys : [])
        .map(key => normalizeItemName(key))
        .filter(Boolean),
    );
    // ── GUIA DONA do progresso desta execução ───────────────────────────────
    // 'itens' (padrão, comportamento original): consulta disparada pela GUIA
    // ITENS — o progresso aparece só lá. 'quests': a MESMA análise rodando
    // como ETAPA da consulta de QUESTS (integração Quests+Itens) — o
    // progresso aparece na guia Quests ("analisando itens") e a guia Itens o
    // ignora. Parâmetro apenas de EXIBIÇÃO: a análise em si é idêntica.
    const progressScope = options?.progressScope === 'quests' ? 'quests' : 'itens';
    const progressMessage = progressScope === 'quests'
      ? 'Analisando itens dos personagens aprovados...'
      : 'Itens: consultando personagens via API...';

    return runQueued('bazaar-items-v2', async () => {
      const startedAt = Date.now();
      const browserKey = resolveBrowserKey(getSelectedBrowser ? getSelectedBrowser() : '');
      const cleanProfile = !!(getUseCleanProfile && getUseCleanProfile());
      const details = {};

      if (watchSet.size === 0) {
        return { ok: false, error: 'Nenhum item monitorado informado para a consulta.', details: {} };
      }

      diag('items-v2', 'ITENS: iniciando análise por API JSON (sem renderizar página individual).', {
        total: list.length, itensMonitorados: watchSet.size, navegador: browserKey, endpoint: `${apiBase}/{ID}`,
      });

      // ── Sessão — mesma validação/reuso do método novo das quests ──────────
      let page = null;
      try {
        const context = await getContext(browserKey, cleanProfile);
        const session = await ensureSessionReady(context, null, 'items-v2-session');
        if (!session.ok) {
          return {
            ok: false,
            error: session.message || 'Sessão Rubinot indisponível para a consulta de itens.',
            needsHumanVerification: !!session.needsHumanVerification,
            details: {},
          };
        }
        page = session.page || await getSessionPage(context);
      } catch (error) {
        return { ok: false, error: String(error?.message || error), details: {} };
      }

      let analyzedCount = 0;
      let matchedCharacters = 0;
      let stoppedManually = false;
      const failureReasons = {};

      try {
        sendProgress(event.sender, buildProgress('details', progressMessage, 0, list.length, {
          methodLabel: 'Itens (API JSON)',
          // Guia dona do progresso: 'itens' (consulta da guia Itens) ou
          // 'quests' (etapa de itens DENTRO da consulta de Quests) — o
          // renderer usa este carimbo para exibir cada consulta somente na
          // guia correta.
          scope: progressScope,
        }));

        for (let index = 0; index < list.length; index++) {
          if (isManualStopRequested()) {
            stoppedManually = true;
            diag('items-v2', 'Encerramento manual durante a consulta de itens.', { analisados: index, restantes: list.length - index });
            break;
          }

          const auction = list[index];
          const key = auction?.id || auction?.name || auction?.url;
          if (!key) continue;

          const outcome = await fetchOneAuctionJson(page, auction);

          if (outcome.ok) {
            const matches = collectItemMatches(outcome.data, watchSet);
            // ADITIVO: ouro e skills lidos do MESMO payload já baixado —
            // nenhuma chamada extra, nenhum efeito no fluxo existente.
            const extra = collectGoldAndSkills(outcome.data);
            // ADITIVO: quests derivadas do MESMO payload pela MESMA função da
            // consulta de quests (bosstiary) — nenhuma chamada extra. true =
            // quest JÁ FEITA; false = disponível; null = inconclusivo.
            const quests = deriveQuestsFromApiPayload(outcome.data);
            analyzedCount += 1;
            if (matches.length > 0) matchedCharacters += 1;
            details[key] = {
              id: key,
              method: 'items_api_json_v2',
              matches,
              gold: extra.gold,
              skills: extra.skills,
              extraPaths: extra.paths,
              soulwarCompleted: quests.soulwarCompleted,
              sanguineCompleted: quests.sanguineCompleted,
              // ADITIVO: contadores de bosses das quests — a MESMA função
              // (deriveQuestsFromApiPayload) já os calcula do MESMO payload;
              // aqui apenas deixamos de descartá-los, para a guia Itens
              // exibir o padrão "X/Y" idêntico ao da guia Quests. Nenhuma
              // chamada extra ao site. Inconclusivo => undefined (omitido).
              soulWarBossCount: quests.soulWarBossCount,
              sanguineBossCount: quests.sanguineBossCount,
              fetchedAt: Date.now(),
            };
          } else {
            failureReasons[outcome.reason] = (failureReasons[outcome.reason] || 0) + 1;
            details[key] = { id: key, error: outcome.reason, failureReason: outcome.reason, fetchedAt: Date.now() };
          }

          sendProgress(event.sender, buildProgress('details', progressMessage, index + 1, list.length, {
            methodLabel: 'Itens (API JSON)',
            apiResolved: analyzedCount,
            scope: progressScope,
          }));

          if (index < list.length - 1) await page.waitForTimeout(currentGapMs());
        }
      } catch (error) {
        diag('items-v2', 'Erro na consulta de itens.', { error: String(error?.message || error) });
        return { ok: false, error: String(error?.message || error), details };
      } finally {
        // Sem isto, o listener de progresso do renderer ficaria "preso" em
        // estágio ativo após a consulta de itens (o handler antigo limpa os
        // estados no próprio fluxo das quests; aqui o fluxo é outro).
        // EXCEÇÃO: quando esta análise roda como ETAPA da consulta de QUESTS
        // (progressScope 'quests'), quem encerra o progresso é o fluxo das
        // quests (fechamento do navegador no finally do renderer) — finalizar
        // aqui dispararia um evento active=false NO MEIO da consulta de
        // quests, zerando o painel de progresso antes da publicação.
        if (progressScope === 'itens') {
          try { if (finishProgress) finishProgress('itens-finalizado'); } catch (_) {}
        }
      }

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

      diag('items-v2', 'Consulta de itens finalizada.', {
        total: list.length,
        analisados: analyzedCount,
        comItensMonitorados: matchedCharacters,
        falhas: failedCount,
        motivos: failureReasons,
        tempoTotalMs: Date.now() - startedAt,
      });

      return {
        ok: true,
        details,
        totalRequested: list.length,
        analyzedCount,
        matchedCharacters,
        failedCount,
        failedCharacterList,
        failureReasons,
        stoppedManually,
        totalDurationMs: Date.now() - startedAt,
        methodUsed: 'itens-v2',
        primaryBrowser: browserKey,
      };
    });
  });

  diag('context', 'Consulta de ITENS do Bazaar registrada (canal rubinot-bazaar-items-v2).', {
    endpoint: `${apiBase}/{ID}`,
  });
}

module.exports = {
  registerBazaarItemsMethod,
  // Exportados para testes — funções puras, sem efeito colateral.
  normalizeItemName,
  parseTieredName,
  collectItemMatches,
  collectGoldAndSkills,
  buildAuctionApiUrl,
};
