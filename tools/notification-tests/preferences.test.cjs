// ============================================================================
// TESTES DO REGISTRO CENTRAL DE PREFERÊNCIAS DE NOTIFICAÇÃO
//
// Sem rede, sem navegador, sem Firestore. Lê os arquivos-fonte reais e valida
// que o registro (`src/utils/notificationPreferences.ts`) continua cobrindo
// TODOS os tipos declarados em `src/types/notifications.ts`.
//
// O objetivo principal é detectar DRIFT: se alguém adicionar um tipo novo de
// notificação e esquecer de registrá-lo, este teste falha.
//
// Executar: node tools/notification-tests/preferences.test.cjs
// ============================================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`  ${pass ? '✅' : '❌'} ${name}${!pass && detail ? ` — ${detail}` : ''}`);
}

const TYPES_SRC = read('src/types/notifications.ts');
const PREFS_SRC = read('src/utils/notificationPreferences.ts');
const MODAL_SRC = read('src/components/NotificationSettingsModal.tsx');
const CENTER_SRC = read('src/components/NotificationCenter.tsx');
const HOOK_SRC = read('src/hooks/useNotifications.ts');
const CONTEXT_SRC = read('src/context/NotificationsContext.tsx');

/** Tipos declarados na união `type:` de types/notifications.ts. */
function extractDeclaredTypes() {
  const match = TYPES_SRC.match(/type:\s*((?:"[a-z_]+"\s*\|?\s*)+)/);
  if (!match) return [];
  return (match[1].match(/"([a-z_]+)"/g) || []).map(s => s.replace(/"/g, ''));
}

/** Tipos registrados como `id: "..."` dentro de NOTIFICATION_PREFERENCES. */
function extractRegisteredTypes() {
  const block = PREFS_SRC.split('NOTIFICATION_PREFERENCES: NotificationPreferenceItem[] = [')[1] || '';
  const body = block.split('\n];')[0];
  return (body.match(/^\s{4}id:\s*"([a-z_]+)"/gm) || [])
    .map(s => s.replace(/.*"([a-z_]+)".*/, '$1'));
}

/** Entradas completas do registro, com os campos que interessam. */
function extractRegistryEntries() {
  const block = PREFS_SRC.split('NOTIFICATION_PREFERENCES: NotificationPreferenceItem[] = [')[1] || '';
  const body = block.split('\n];')[0];
  return body
    .split(/\n  \{\n/)
    .slice(1)
    .map(chunk => ({
      id: (chunk.match(/id:\s*"([a-z_]+)"/) || [])[1] || '',
      category: (chunk.match(/category:\s*"([a-z]+)"/) || [])[1] || '',
      storageKey: (chunk.match(/storageKey:\s*[`"]([^`"$]*)/) || [])[1]
        || (chunk.match(/storageKey:\s*`\$\{TYPE_KEY_PREFIX\}([a-z_]+)`/) || [])[1]
        || '',
      rawStorageKey: (chunk.match(/storageKey:\s*(.+),/) || [])[1] || '',
      bossOnly: /bossOnly:\s*true/.test(chunk),
      electronOnly: /electronOnly:\s*true/.test(chunk),
      mandatory: /mandatory:\s*true/.test(chunk),
      mandatoryReason: /mandatoryReason:/.test(chunk),
      hasChildren: /children:\s*\[/.test(chunk),
    }))
    .filter(e => e.id);
}

(function run() {
  console.log('='.repeat(64));
  console.log('PREFERÊNCIAS DE NOTIFICAÇÃO — auditoria e regressão');
  console.log('='.repeat(64));

  const declared = extractDeclaredTypes();
  const registered = extractRegisteredTypes();
  const entries = extractRegistryEntries();

  // ── [1] Cobertura total dos tipos ───────────────────────────────────────
  console.log('\n[1] Cobertura: todo tipo declarado está registrado');
  {
    check('a união de tipos foi lida', declared.length > 0, `encontrados=${declared.length}`);
    check('há 13 tipos declarados', declared.length === 13, `obtido=${declared.length}`);
    check('registro tem o mesmo tamanho', registered.length === declared.length,
      `declarados=${declared.length} registrados=${registered.length}`);

    for (const type of declared) {
      check(`tipo "${type}" está no registro`, registered.includes(type));
    }
    for (const type of registered) {
      check(`tipo registrado "${type}" existe de fato`, declared.includes(type));
    }
    check('sem tipos duplicados no registro', new Set(registered).size === registered.length);
  }

  // ── [2] Chaves de armazenamento ─────────────────────────────────────────
  console.log('\n[2] Chaves: as antigas foram preservadas');
  {
    // As chaves LEGADAS não podem mudar, senão a preferência já salva do
    // usuário é perdida silenciosamente.
    check('chave legada do aviso de 30 min', PREFS_SRC.includes('LEGACY_PT_30 = "notif_pt_30"'));
    check('chave legada do aviso de 15 min', PREFS_SRC.includes('LEGACY_PT_15 = "notif_pt_15"'));
    check('chave legada do aviso de 5 min', PREFS_SRC.includes('LEGACY_PT_5 = "notif_pt_5"'));
    check('chave legada do som', PREFS_SRC.includes('LEGACY_SOUND = "tibia_notify_sound"'));
    check('chave legada do desktop', PREFS_SRC.includes('LEGACY_DESKTOP = "tibia_notify_desktop"'));

    // O som usa a MESMA chave que `utils/notificationSound.ts` já usava.
    const soundSrc = read('src/utils/notificationSound.ts');
    check('som reaproveita a chave do módulo de áudio',
      soundSrc.includes('NOTIFICATION_SOUND_KEY = "tibia_notify_sound"'));
    // O desktop usa a MESMA chave que `storage.ts` já usava.
    const storageSrc = read('src/storage.ts');
    check('desktop reaproveita a chave do storage', storageSrc.includes('"tibia_notify_desktop"'));

    check('todas as entradas têm storageKey', entries.every(e => e.rawStorageKey.length > 0));
    const keys = entries.map(e => e.rawStorageKey);
    check('sem storageKey duplicada', new Set(keys).size === keys.length);
    check('chaves novas usam prefixo próprio', PREFS_SRC.includes('TYPE_KEY_PREFIX = "notif_type_"'));
  }

  // ── [3] Categorias ──────────────────────────────────────────────────────
  console.log('\n[3] Agrupamento por categoria');
  {
    const catIds = (PREFS_SRC.match(/\{ id: "([a-z]+)", label: "/g) || [])
      .map(s => s.replace(/.*"([a-z]+)".*/, '$1'));
    for (const expected of ['pt', 'bazaar', 'services', 'vip', 'system', 'admin']) {
      check(`categoria "${expected}" existe`, catIds.includes(expected));
    }
    check('toda entrada tem categoria válida', entries.every(e => catIds.includes(e.category)),
      entries.filter(e => !catIds.includes(e.category)).map(e => e.id).join(','));
    // Nenhuma categoria pode ficar sem item — seria um cabeçalho vazio.
    for (const cat of catIds) {
      check(`categoria "${cat}" tem ao menos um item`, entries.some(e => e.category === cat));
    }
  }

  // ── [4] Permissões de Boss ──────────────────────────────────────────────
  console.log('\n[4] Itens exclusivos do Boss');
  {
    const bossOnly = entries.filter(e => e.bossOnly).map(e => e.id).sort();
    const expected = ['bazaar_daily_available', 'rate_limit_block', 'request_entry'];
    check('conjunto exato de itens Boss', JSON.stringify(bossOnly) === JSON.stringify(expected),
      `obtido=${bossOnly.join(',')}`);

    // As administrativas são realmente restritas ao Boss no Firestore:
    // ambas são gravadas com targetRole "Boss".
    const authSrc = read('src/context/AuthContext.tsx');
    check('request_entry é direcionada ao Boss', authSrc.includes('targetRole: "Boss"'));
    check('rate_limit_block é direcionada ao Boss', authSrc.includes('type: "rate_limit_block"'));

    // A filtragem por papel acontece no registro, não no JSX — assim a
    // categoria inteira some quando fica vazia.
    check('filtro por papel existe', PREFS_SRC.includes('if (item.bossOnly && !isBoss) return false;'));
    check('filtro por ambiente existe', PREFS_SRC.includes('if (item.electronOnly && !isElectron) return false;'));
    check('categorias vazias são removidas', PREFS_SRC.includes('.filter(group => group.items.length > 0)'));
    check('modal usa as categorias já filtradas', MODAL_SRC.includes('getVisibleCategories(isBoss, isElectron)'));
    check('modal recebe o papel do usuário', CENTER_SRC.includes('isBoss={userRole === "Boss"}'));
  }

  // ── [5] Notificações obrigatórias ───────────────────────────────────────
  console.log('\n[5] Notificações obrigatórias');
  {
    const mandatory = entries.filter(e => e.mandatory).map(e => e.id).sort();
    check('exatamente duas obrigatórias', mandatory.length === 2, `obtido=${mandatory.join(',')}`);
    check('request_entry é obrigatória', mandatory.includes('request_entry'));
    check('rate_limit_block é obrigatória', mandatory.includes('rate_limit_block'));
    check('toda obrigatória explica o motivo',
      entries.filter(e => e.mandatory).every(e => e.mandatoryReason));
    check('obrigatória nunca é bloqueada pelo portão', PREFS_SRC.includes('if (item.mandatory) return true;'));
    check('modal mostra cadeado no lugar do interruptor', MODAL_SRC.includes('item.mandatory ? ('));
    check('atalho "nenhuma" pula as obrigatórias', MODAL_SRC.includes('if (item.mandatory) continue;'));
  }

  // ── [6] Portão de entrega ───────────────────────────────────────────────
  console.log('\n[6] Portão único de entrega');
  {
    check('portão existe', PREFS_SRC.includes('export function isNotificationTypeEnabled'));
    check('tipo desconhecido nunca é bloqueado', PREFS_SRC.includes('if (!item) return true;'));
    check('tipo ausente nunca é bloqueado', PREFS_SRC.includes('if (!type) return true;'));

    // Aplicado nos DOIS caminhos de entrega do app.
    check('hook aplica o portão', HOOK_SRC.includes('if (!isNotificationTypeEnabled(notif.type)) return;'));
    check('context aplica o portão', CONTEXT_SRC.includes('if (!isNotificationTypeEnabled(notif.type)) return;'));
    check('hook importa do registro', HOOK_SRC.includes('from "../utils/notificationPreferences"'));
    check('context importa do registro', CONTEXT_SRC.includes('from "../utils/notificationPreferences"'));

    // O portão fica no INÍCIO de addNotification: bloqueia o centro, o som e
    // o desktop de uma vez só.
    const hookGate = HOOK_SRC.indexOf('isNotificationTypeEnabled(notif.type)');
    const hookSound = HOOK_SRC.indexOf('playNotificationSound()');
    const hookDesktop = HOOK_SRC.indexOf('sendDesktopNotification(');
    check('portão vem antes do som', hookGate > 0 && hookGate < hookSound);
    check('portão vem antes do desktop', hookGate > 0 && hookGate < hookDesktop);
  }

  // ── [7] Leitura tolerante dos dois formatos gravados ────────────────────
  console.log('\n[7] Compatibilidade de formato no localStorage');
  {
    // As chaves antigas de PT gravavam a STRING "false"; som e desktop
    // gravavam JSON. O leitor precisa aceitar os dois.
    check('aceita a string "false"', PREFS_SRC.includes('if (raw === "false") return false;'));
    check('aceita a string "true"', PREFS_SRC.includes('if (raw === "true") return true;'));
    check('aceita JSON', PREFS_SRC.includes('JSON.parse(raw)'));
    check('ausência = ligado (padrão preservado)', PREFS_SRC.includes('if (raw === null) return defaultValue;'));
    check('padrão do leitor é true', PREFS_SRC.includes('defaultValue = true'));
    check('grava sempre em JSON', PREFS_SRC.includes('localStorage.setItem(storageKey, JSON.stringify(value))'));
    check('avisa a aplicação ao gravar', PREFS_SRC.includes('window.dispatchEvent(new Event("storage"))'));

    // Simulação do leitor com os dois formatos.
    const readPref = raw => {
      if (raw === null) return true;
      if (raw === 'false') return false;
      if (raw === 'true') return true;
      try { return JSON.parse(raw) !== false; } catch { return true; }
    };
    check('legado "false" desliga', readPref('false') === false);
    check('JSON false desliga', readPref(JSON.stringify(false)) === false);
    check('JSON true liga', readPref(JSON.stringify(true)) === true);
    check('ausente liga', readPref(null) === true);
    check('lixo liga (não bloqueia por engano)', readPref('???') === true);
  }

  // ── [8] Lembrete de PT com sub-opções ───────────────────────────────────
  console.log('\n[8] Lembrete de PT e suas janelas');
  {
    const reminder = entries.find(e => e.id === 'pt_reminder');
    check('pt_reminder tem sub-opções', !!reminder && reminder.hasChildren);
    check('as três janelas continuam existindo',
      PREFS_SRC.includes('storageKey: LEGACY_PT_30') &&
      PREFS_SRC.includes('storageKey: LEGACY_PT_15') &&
      PREFS_SRC.includes('storageKey: LEGACY_PT_5'));
    // Desligar as três equivale a desligar o lembrete.
    check('pai desligado quando toda janela está desligada',
      PREFS_SRC.includes('return item.children.some(child => readBooleanPref(child.storageKey));'));
    // A lógica de disparo do lembrete NÃO foi alterada.
    check('disparo do lembrete preservado', HOOK_SRC.includes('const pref30 = localStorage.getItem("notif_pt_30") !== "false"'));
    check('janelas de tempo preservadas', HOOK_SRC.includes('{ min: 28, max: 32, label: "30"'));
  }

  // ── [9] Sem controles duplicados fora do modal ──────────────────────────
  console.log('\n[9] Centralização: nada duplicado na aba Ajustes');
  {
    check('botão "Configurar Notificações" existe', CENTER_SRC.includes('Configurar Notificações'));
    check('modal é montado pelo centro', CENTER_SRC.includes('<NotificationSettingsModal'));

    // Os controles antigos saíram da aba Ajustes.
    check('bloco "Alertas de PT" removido', !CENTER_SRC.includes('Alertas de PT'));
    check('toggle de som removido dos Ajustes', !CENTER_SRC.includes('Som das notificações'));
    check('estado local de som removido', !CENTER_SRC.includes('loadNotificationSoundPref'));
    check('handler de som removido', !CENTER_SRC.includes('handleToggleNotificationSound'));
    check('handler das janelas de PT removido', !CENTER_SRC.includes('handleTogglePtAlert'));
    check('chaves de PT não são mais lidas no centro', !CENTER_SRC.includes('"notif_pt_30"'));

    // Ajustes preserva o que NÃO é notificação.
    check('ajuste de bandeja preservado', CENTER_SRC.includes('Fechar para bandeja'));
    check('ajuste de inicialização preservado', CENTER_SRC.includes('Iniciar com Windows'));
    check('ajuste de CPU preservado', CENTER_SRC.includes('Poupar CPU'));
    check('seletor de tema preservado', CENTER_SRC.includes('<ThemeSelector />'));

    // O som passou a ser gerenciado pelo registro.
    check('som está no modal como canal', PREFS_SRC.includes('id: "sound"'));
    check('desktop está no modal como canal', PREFS_SRC.includes('id: "desktop"'));
  }

  // ── [10] Interface e compatibilidade de temas ───────────────────────────
  console.log('\n[10] Interface');
  {
    check('modal renderiza por portal', MODAL_SRC.includes('createPortal('));
    check('modal fecha com Esc', MODAL_SRC.includes('event.key === "Escape"'));
    check('modal rola só no miolo', MODAL_SRC.includes('flex-1 min-h-0 overflow-y-auto'));
    check('modal tem teto de altura', MODAL_SRC.includes('max-h-[88vh]'));
    check('modal recarrega ao abrir', MODAL_SRC.includes('if (!open) return;'));
    check('modal tem busca', MODAL_SRC.includes('matchesSearch'));
    check('modal tem ativar/desativar em massa', MODAL_SRC.includes('function setAll('));
    check('interruptor acessível', MODAL_SRC.includes('role="switch"') && MODAL_SRC.includes('aria-checked'));

    // Nenhuma cor fixa: tudo por token ou utilitário do Tailwind.
    check('sem cor hexadecimal no modal', !/#[0-9a-fA-F]{6}/.test(MODAL_SRC));
    check('sem cor hexadecimal no registro', !/#[0-9a-fA-F]{6}/.test(PREFS_SRC));
    check('usa tokens de tema', MODAL_SRC.includes('var(--th-'));

    // O clique-fora do painel precisa ficar suspenso com o modal aberto,
    // senão um clique no modal (que vive em document.body) fecharia os dois.
    check('clique-fora suspenso com o modal aberto', CENTER_SRC.includes('if (notifSettingsOpen) return;'));
    check('efeito depende do estado do modal', CENTER_SRC.includes('}, [onClose, notifSettingsOpen]);'));
  }

  // ── [11] Nada da lógica de disparo mudou ────────────────────────────────
  console.log('\n[11] Preservações');
  {
    const appSrc = read('src/App.tsx');
    check('disparo de pt_added preservado', appSrc.includes('type: "pt_added"'));
    check('disparo de quest_completed_donation preservado', appSrc.includes('type: "quest_completed_donation"'));
    check('disparo de schedule_changed preservado', appSrc.includes('type: "schedule_changed"'));
    check('disparo de update_available preservado', appSrc.includes('type: "update_available"'));
    check('disparo de bazaar_interest_ending preservado', appSrc.includes('type: "bazaar_interest_ending"'));
    check('disparo de bazaar_daily_available preservado', appSrc.includes('type: "bazaar_daily_available"'));
    check('disparo de pt_updated preservado', HOOK_SRC.includes('type: "pt_updated"'));
    check('disparo de pt_reminder preservado', HOOK_SRC.includes('type: "pt_reminder"'));
    check('disparo de service_request preservado', read('src/services/sharedServicesService.ts').includes('type: "service_request"'));
    check('disparo de vip_approved preservado', read('src/components/BossAdminPanel.tsx').includes('type: "vip_approved"'));
    check('disparo de payment_received preservado', read('src/components/BossAdminPanel.tsx').includes('type: "payment_received"'));

    // As administrativas continuam fora do centro de notificações do usuário.
    check('administrativas seguem filtradas do centro',
      HOOK_SRC.includes('if (data.type === "request_entry" || data.type === "rate_limit_block") return;'));
    check('centro continua ocultando administrativas',
      CENTER_SRC.includes('n.type !== "request_entry" && n.type !== "rate_limit_block"'));
    // Nenhum tipo foi removido da união.
    check('nenhum tipo foi removido', declared.length === 13);
  }

  const failed = results.filter(r => !r.pass);
  console.log('\n' + '='.repeat(64));
  console.log(`RESULTADO: ${results.length - failed.length}/${results.length} verificações passaram`);
  if (failed.length) { failed.forEach(f => console.log(`  ❌ ${f.name}`)); process.exit(1); }
  console.log('Todos os cenários automatizáveis passaram.');
})();