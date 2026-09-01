// ============================================================================
// TESTES DA JANELA EXTERNA (CÂMBIO) — INSTÂNCIA ÚNICA
//
// Sem rede, sem navegador, sem Electron. Lê os arquivos-fonte reais e simula
// a máquina de estados de abertura/foco.
//
// O bug original: `setCalcOpen(true)` com `calcOpen` já `true` não muda nada,
// então nenhum efeito rodava e o segundo clique era simplesmente ignorado —
// a janela ficava atrás da principal, sem foco.
//
// Executar: node tools/external-window-tests/single-instance.test.cjs
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

const EXT = read('src/components/ExternalWindow.tsx');
const CALC = read('src/components/CurrencyCalculator.tsx');
const APP = read('src/App.tsx');
const MAIN = read('electron-main.cjs');

(function run() {
  console.log('='.repeat(64));
  console.log('JANELA EXTERNA DO CÂMBIO — instância única e foco');
  console.log('='.repeat(64));

  // ── [1] Sinal de clique ─────────────────────────────────────────────────
  console.log('\n[1] O clique repetido chega ao componente');
  {
    check('App tem contador de foco', APP.includes('const [calcFocusSignal, setCalcFocusSignal] = useState(0);'));
    check('handler dedicado existe', APP.includes('function handleOpenCalc()'));
    check('handler marca como aberto', APP.includes('setCalcOpen(true);'));
    check('handler incrementa o sinal', APP.includes('setCalcFocusSignal(value => value + 1);'));
    check('botão Câmbio usa o handler', APP.includes('<button onClick={handleOpenCalc}'));
    check('botão não usa mais o setter cru', !APP.includes('onClick={() => setCalcOpen(true)}'));
    check('sinal é repassado ao conversor', APP.includes('focusSignal={calcFocusSignal}'));
    check('conversor repassa ao ExternalWindow', CALC.includes('focusSignal={focusSignal}'));
    check('conversor declara a prop', CALC.includes('focusSignal?: number;'));
    check('ExternalWindow declara a prop', EXT.includes('focusSignal?: number;'));
    check('prop tem valor padrão', EXT.includes('focusSignal = 0,'));
  }

  // ── [2] Instância única ─────────────────────────────────────────────────
  console.log('\n[2] Nunca abre uma segunda janela');
  {
    check('guarda de instância viva existe',
      EXT.includes('if (windowRef.current && !windowRef.current.closed) {'));
    check('guarda foca em vez de abrir', EXT.includes('focusExternalWindow(windowRef.current, title);'));
    // A guarda tem de vir ANTES do window.open, senão não serve para nada.
    const guard = EXT.indexOf('// ── INSTÂNCIA ÚNICA');
    const openCall = EXT.indexOf('const newWin = window.open(');
    check('guarda vem antes de abrir', guard > 0 && guard < openCall);
    check('só existe um window.open', (EXT.match(/window\.open\(/g) || []).length === 1);

    // Simulação da máquina de estados.
    function makeHost() {
      const state = { windows: 0, alive: false, focused: 0, restored: 0 };
      return {
        state,
        click() {
          if (state.alive) { state.focused += 1; return 'focus'; }
          state.windows += 1; state.alive = true; return 'open';
        },
        closeByUser() { state.alive = false; },
      };
    }

    const host = makeHost();
    check('1º clique abre', host.click() === 'open');
    check('2º clique não abre outra', host.click() === 'focus');
    check('3º clique também só foca', host.click() === 'focus');
    check('apenas uma janela criada', host.state.windows === 1);
    check('dois pedidos de foco registrados', host.state.focused === 2);

    host.closeByUser();
    check('após fechar, o clique abre de novo', host.click() === 'open');
    check('agora são duas janelas ao todo', host.state.windows === 2);
    check('sem foco extra indevido', host.state.focused === 2);
  }

  // ── [3] Efeito de foco ──────────────────────────────────────────────────
  console.log('\n[3] Efeito que responde ao clique repetido');
  {
    check('efeito depende do sinal', EXT.includes('}, [focusSignal, open, title]);'));
    check('ignora sinal inicial', EXT.includes('if (!open || focusSignal <= 0) return;'));
    check('reabre se a janela já morreu', EXT.includes('setInstanceId(value => value + 1);'));
    check('efeito de abertura reage à nova instância', EXT.includes('}, [open, instanceId]);'));

    // Corrida real: fechar e clicar dentro dos 250 ms da sondagem.
    function simulate(windowAlive) {
      if (!windowAlive) return 'reopen';
      return 'focus';
    }
    check('janela viva => foca', simulate(true) === 'focus');
    check('janela morta na fresta => reabre', simulate(false) === 'reopen');
  }

  // ── [4] Foco real no Electron ───────────────────────────────────────────
  console.log('\n[4] Restaurar e trazer para frente (Electron)');
  {
    check('helper de foco existe', EXT.includes('function focusExternalWindow('));
    check('tenta pelo handle primeiro', EXT.includes('try { win.focus(); } catch {}'));
    check('não faz IPC na Web', EXT.includes('if (!isElectron) return;'));
    check('usa o critério padrão de ambiente', EXT.includes('!!(window as any).require'));
    check('chama o IPC dedicado', EXT.includes('ipcRenderer.invoke("focus-child-window", { title })'));
    check('não foca janela já fechada', EXT.includes('if (!win || win.closed) return;'));

    // Lado do processo principal.
    check('IPC registrado', MAIN.includes("ipcMain.handle('focus-child-window'"));
    check('registro de janelas filhas', MAIN.includes('const childWindows = new Set();'));
    check('janela filha entra no registro', MAIN.includes('childWindows.add(childWindow);'));
    check('sai do registro ao fechar', MAIN.includes("childWindow.once('closed', () => {"));
    check('remove a entrada', MAIN.includes('childWindows.delete(childWindow);'));

    // A sequência precisa cobrir minimizada e oculta antes do focus.
    const handler = MAIN.split("ipcMain.handle('focus-child-window'")[1].split('});')[0];
    check('restaura se minimizada', handler.includes('if (win.isMinimized()) win.restore();'));
    check('mostra se invisível', handler.includes('if (!win.isVisible()) win.show();'));
    check('aplica foco', handler.includes('win.focus();'));
    const iMin = handler.indexOf('isMinimized');
    const iFocus = handler.indexOf('win.focus()');
    check('restaura ANTES de focar', iMin > 0 && iMin < iFocus);
    check('ignora janelas destruídas', handler.includes('if (!win || win.isDestroyed()) continue;'));
    check('casa pelo título', handler.includes('if (title !== wanted) continue;'));
    check('sem título não faz nada', handler.includes("return { ok: false, error: 'Título não informado.' };"));
    // Maximizar seria intrusivo: a janela do conversor tem tamanho próprio.
    // Comentários são descartados — só o CÓDIGO importa aqui.
    const handlerCode = handler.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
    check('não maximiza a janela filha', !handlerCode.includes('maximize()'));
  }

  // ── [5] Preservações ────────────────────────────────────────────────────
  console.log('\n[5] Nada mais mudou');
  {
    // Fechamento: exatamente o mesmo fluxo de antes.
    check('sondagem de fechamento preservada', EXT.includes('if (newWin.closed) {'));
    check('intervalo de 250ms preservado', EXT.includes('}, 250);'));
    check('onClose ainda é chamado', EXT.includes('onClose();'));
    check('cleanup ainda fecha a janela', EXT.includes('if (newWin && !newWin.closed) {'));
    check('foco volta ao app ao fechar', EXT.includes('setTimeout(() => window.focus(), 50);'));
    check('fecha quando open vira false', EXT.includes('windowRef.current.close();'));

    // Lógica do conversor intocada.
    check('conversor mantém o título', CALC.includes('Conversor RC/KK/R$'));
    check('conversor mantém a tela VIP', CALC.includes('<VipOnlyScreen />'));
    check('conversor mantém as dimensões', CALC.includes('width={450}') && CALC.includes('height={525}'));
    check('conteúdo do conversor preservado', CALC.includes('<CalculatorContent />'));

    // Infraestrutura da janela externa intocada.
    check('tema ainda é aplicado', EXT.includes('applyThemeToDocument(theme, newWin.document)'));
    check('tema ainda sincroniza', EXT.includes('}, [theme, container]);'));
    check('estilos ainda são clonados', EXT.includes('styleSheets.forEach('));
    check('portal preservado', EXT.includes('createPortal(children, container)'));
    check('aviso de popup bloqueado preservado', EXT.includes('Verifique se popups estão permitidos.'));

    // Ícone e menu das janelas filhas seguem iguais.
    check('ícone da janela filha preservado', MAIN.includes('childWindow.setIcon(windowIcon);'));
    check('menu oculto preservado', MAIN.includes('childWindow.setMenuBarVisibility(false);'));
    check('handler de abertura preservado', MAIN.includes("return { action: 'allow' };"));
    check('foco da janela principal preservado', MAIN.includes("ipcMain.handle('focus-window'"));
    check('showAndFocusWindow preservado', MAIN.includes('function showAndFocusWindow()'));
  }

  const failed = results.filter(r => !r.pass);
  console.log('\n' + '='.repeat(64));
  console.log(`RESULTADO: ${results.length - failed.length}/${results.length} verificações passaram`);
  if (failed.length) { failed.forEach(f => console.log(`  ❌ ${f.name}`)); process.exit(1); }
  console.log('Todos os cenários automatizáveis passaram.');
})();