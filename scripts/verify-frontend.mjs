import { build, stop as stopBuild } from 'esbuild';
import { spawn, execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Frontend-only verification: real renderer/preload, fictional services, no main,
// sampler executable, tray, notification, sound playback or real user database.
const require = createRequire(import.meta.url);
const runStartedAt = Date.now();
const appDirectory = resolve(process.argv[2] ?? 'dist/desktop');
await Promise.all(['index.html', 'preload.cjs', 'renderer.js'].map(name => access(join(appDirectory, name))));
await mkdir('.cache/frontend-smoke', { recursive: true });
await mkdir('dist', { recursive: true });
const root = await mkdtemp(resolve('.cache/frontend-smoke/run-'));
const dataDirectory = join(root, 'data');
await mkdir(dataDirectory, { recursive: true });
const fixture = join(root, 'fixture.cjs');
const entry = join(root, 'driver.cjs');
const reportPath = join(root, 'metrics.json');
const configuration = {
  fixture,
  dataDirectory,
  database: join(root, 'fictional-studyflow.sqlite'),
  preload: join(appDirectory, 'preload.cjs'),
  page: pathToFileURL(join(appDirectory, 'index.html')).href,
  screenshots: resolve('dist'),
  reportPath,
  matrix: [[1366, 768, 1], [1366, 768, 1.25], [1366, 768, 1.5],
    [1280, 720, 1], [1280, 720, 1.25], [1280, 720, 1.5], [1920, 1080, 1]],
};
await writeFile(reportPath, JSON.stringify({ status: 'preparing', configuration, checks: [], layouts: [] }, null, 2));
const fixtureDeadline = setTimeout(() => stopBuild(), 5000);
try {
  await build({
    stdin: {
      contents: "export { DesktopStudy } from './src/desktop/study'; export { DesktopService } from './src/desktop/service'; export { StudyStore } from './src/desktop/store';",
      resolveDir: process.cwd(),
    },
    outfile: fixture, bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'node:sqlite'],
  });
} catch (error) {
  await writeFile(reportPath, JSON.stringify({ status: 'failed', phase: 'fixture-build', configuration, checks: [], layouts: [], failures: [error.message] }, null, 2));
  throw error;
} finally { clearTimeout(fixtureDeadline); stopBuild(); }

// Serialized as the Electron entry point so all test code stays in this file.
async function runFrontendDriver(config) {
  const { app, BrowserWindow, ipcMain, session } = require('electron');
  const { writeFileSync } = require('node:fs');
  const { DesktopStudy, DesktopService, StudyStore } = require(config.fixture);
  app.disableHardwareAcceleration();
  app.setPath('userData', config.dataDirectory);
  const report = {
    status: 'starting', phase: 'electron-startup', startedAt: new Date().toISOString(),
    matrix: config.matrix, page: config.page, preload: config.preload, database: config.database,
    scope: 'Frontend only; real renderer/preload with fictional SQLite, sampler, notifications and audio.',
    security: { sandbox: true, contextIsolation: true, nodeIntegration: false, hidden: true, hardwareAcceleration: false },
    capturePolicy: { discardedFirstCapture: true, animationFrames: 2, frameTimeoutMs: 120, settleBeforeEachCaptureMs: 220, state: 'normal', resetScrollSelectors: ['.focus-panel', '.sidebar', '.table-scroll'] },
    interactionScope: 'Scroll reachability, center-point hit testing and DOM focusability; one hidden Chromium CDP task-menu Enter/Tab/Escape sequence, distinct from DOM focus preparation.',
    keyboard: { status: 'not-run', method: 'CDP Input.dispatchKeyEvent', protocol: '1.3', width: 1366, height: 768, zoom: 1, events: [] },
    checks: [], layouts: [], screenshots: [], failures: [],
  };
  let win; let store; let study; let finished = false;
  const delay = ms => new Promise(done => setTimeout(done, ms));
  const save = () => writeFileSync(config.reportPath, JSON.stringify(report, null, 2));
  const check = (name, passed, details) => {
    report.checks.push({ name, passed: Boolean(passed), ...(details === undefined ? {} : { details }) });
  };
  const finish = (error) => {
    if (finished) return;
    finished = true;
    clearTimeout(watchdog);
    if (error) report.failures.push(String(error.stack ?? error));
    try { study?.stop(); } catch (cleanupError) { report.failures.push('Timer cleanup: ' + cleanupError.message); }
    try { if (win && !win.isDestroyed()) win.destroy(); } catch (cleanupError) { report.failures.push('Window cleanup: ' + cleanupError.message); }
    for (const channel of ['studyflow:command', 'studyflow:ambient-audio', 'studyflow:focus-mini-open']) ipcMain.removeHandler(channel);
    try { store?.close(); } catch (cleanupError) { report.failures.push('SQLite cleanup: ' + cleanupError.message); }
    report.finishedAt = new Date().toISOString();
    report.status = report.failures.length || report.checks.some(item => !item.passed) ? 'failed' : 'passed';
    save();
    console.log(`${report.status === 'passed' ? 'PASS' : 'FAIL'}: frontend ${report.checks.filter(item => item.passed).length}/${report.checks.length} checks; ${report.layouts.length} layout states; ${report.screenshots.length} screenshots`);
    console.log('Report: ' + config.reportPath);
    app.exit(report.status === 'passed' ? 0 : 1);
  };
  const watchdog = setTimeout(() => finish(new Error('Frontend driver exceeded 52 seconds')), 52000);
  process.on('uncaughtException', finish);
  process.on('unhandledRejection', finish);
  save();
  try {
    await app.whenReady();
    store = new StudyStore(config.database);
    const startWall = Date.now();
    let now = 0; let serial = 0;
    study = new DesktopStudy({
      clock: { read: () => ({ wallMs: startWall + now, monotonicMs: now, utcOffsetMinutes: -new Date().getTimezoneOffset() }) },
      makeId: () => `frontend-fixture-${++serial}`,
      sampler: { sample: async () => ({ status: 'ok', app: 'FictionalReader.exe', idleMs: 0 }) },
      notify: async () => {}, dismiss: () => {},
      sound: { play: async () => {}, stop: () => {} },
      checkpoint: value => store.saveCheckpoint(value),
      activityCheckpoint: value => store.saveActivityCheckpoint(value),
      credit: (id, milliseconds) => store.addFocusTime(id, milliseconds),
      settings: store.snapshot().settings,
    });
    const service = new DesktopService(store, study);
    const project = store.createProject('虚构课程 · 期末复习');
    const titles = ['阅读第三章：理解概念与例题', '完成练习题，整理容易混淆的知识点', '复习单词并回顾昨日笔记'];
    const tasks = titles.map(title => store.createTask({ title, projectId: project.id, estimateMinutes: 25 }));
    const today = new Date();
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    store.savePlan(date, tasks.map(task => ({ taskId: task.id, minutes: 25 })));
    store.saveDailyReview(date, { accomplished: '虚构示例：完成阅读', obstacles: '', adjustment: '' });

    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
    win = new BrowserWindow({
      show: false, width: 1366, height: 768, useContentSize: true, autoHideMenuBar: true,
      webPreferences: { preload: config.preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.on('render-process-gone', (_event, details) => finish(new Error(`Renderer exited: ${details.reason}/${details.exitCode}`)));
    ipcMain.handle('studyflow:command', (event, command, payload) => {
      if (event.sender !== win.webContents) return { ok: false, error: '无效测试页面' };
      try { return { ok: true, value: service.execute(command, payload) }; }
      catch (error) { return { ok: false, error: error.message }; }
    });
    ipcMain.handle('studyflow:ambient-audio', () => ({ ok: true, value: {
      source: { type: 'noise', kind: 'white' }, volume: 30, loop: true, followFocus: false, status: 'stopped', message: '虚构验证：声音已关闭',
    } }));
    ipcMain.handle('studyflow:focus-mini-open', () => ({ ok: false, error: '前端夹具不打开小窗' }));
    const run = source => win.webContents.executeJavaScript(source);
    const waitForPaint = () => run(`new Promise(resolvePaint => {
      const started = performance.now(); let frames = 0; let frameId;
      const finishPaint = mode => {
        clearTimeout(timeout); cancelAnimationFrame(frameId);
        resolvePaint({ mode, frames, durationMs: Math.round(performance.now() - started) });
      };
      const timeout = setTimeout(() => finishPaint('timeout'), 120);
      const nextFrame = () => {
        frames++; if (frames === 2) finishPaint('two-animation-frames');
        else frameId = requestAnimationFrame(nextFrame);
      };
      frameId = requestAnimationFrame(nextFrame);
    })`);
    const resetDetails = () => run(`(() => {
      const timeline = document.getElementById('daily-timeline')?.closest('details');
      document.querySelectorAll('details').forEach(node => { node.open = node === timeline; });
    })()`);
    const resetNormalScroll = () => run(`(() => {
      document.querySelectorAll('.focus-panel,.sidebar,.table-scroll').forEach(node => {
        node.scrollTo({ left: 0, top: 0, behavior: 'instant' }); node.scrollTop = 0; node.scrollLeft = 0;
      });
      window.scrollTo({ left: 0, top: 0, behavior: 'instant' });
    })()`);
    const screenshotState = () => run(`(() => {
      const timeline = document.getElementById('daily-timeline')?.closest('details');
      return {
        page: document.body.dataset.page,
        studyView: document.body.classList.contains('study-view'),
        windowScroll: { left: scrollX, top: scrollY },
        scrollAreas: Array.from(document.querySelectorAll('.focus-panel,.sidebar,.table-scroll'), (node, index) => ({
          id: node.id || 'scroll-area-' + index, className: node.className, top: node.scrollTop, left: node.scrollLeft,
        })),
        details: Array.from(document.querySelectorAll('details'), (node, index) => ({
          id: node.id || 'details-' + index, className: node.className,
          summary: node.querySelector('summary')?.textContent.trim() ?? '',
          open: node.open, coreTimeline: node === timeline,
        })),
      };
    })()`);
    const until = async (source, label) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await run(source)) return;
        await delay(30);
      }
      throw new Error('UI condition timed out: ' + label);
    };
    const click = async id => {
      await run(`(() => { const node = document.getElementById(${JSON.stringify(id)}); if (!node) throw Error('Missing control'); node.click(); })()`);
      await delay(35);
    };
    const reveal = id => run(`(() => {
      const node = document.getElementById(${JSON.stringify(id)});
      if (!node) throw Error('Missing draft field');
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        if (parent instanceof HTMLDetailsElement) parent.open = true;
        if (parent.hidden && parent.id) {
          const tab = Array.from(document.querySelectorAll('#settings-page [aria-controls]')).find(item => item.getAttribute('aria-controls') === parent.id);
          if (tab) tab.click();
        }
      }
    })()`);
    const navigation = { workspace: 'all-projects', review: 'nav-review', settings: 'nav-settings' };
    const pages = { workspace: 'workspace-page', review: 'daily-panel', settings: 'settings-page' };
    const show = async (page, paint = true) => {
      if (await run("document.body.classList.contains('study-view')")) await click('focus-view');
      await click(navigation[page]);
      await until(`document.body.dataset.page === ${JSON.stringify(page)} && !document.getElementById(${JSON.stringify(pages[page])}).hidden`, 'navigate ' + page);
      const current = await run("Array.from(document.querySelectorAll('.main-nav [aria-current=page]'), node => node.id)");
      const selected = await run("Array.from(document.querySelectorAll('.main-nav .selected'), node => node.id)");
      check('Unique active navigation: ' + page, current.length === 1 && current[0] === navigation[page] && selected.length === 1 && selected[0] === navigation[page], { current, selected });
      const visiblePages = await run(`Object.entries(${JSON.stringify(pages)}).filter(([, id]) => !document.getElementById(id).hidden).map(([name]) => name)`);
      check('Only selected page is mounted visibly: ' + page, visiblePages.length === 1 && visiblePages[0] === page, visiblePages);
      if (paint) await waitForPaint();
    };
    report.phase = 'renderer-startup'; save();
    await win.loadURL(config.page);
    await until("typeof window.studyflow?.request === 'function' && document.getElementById('pending-count').textContent === '3' && !document.getElementById('daily-load').disabled", 'initial fictional data');
    check('Hidden sandboxed renderer', !win.isVisible() && await run("typeof require === 'undefined' && typeof window.studyflow.request === 'function'"));

    report.phase = 'draft-navigation';
    const drafts = { whitelist: 'DraftReader.exe', 'review-accomplished': '未保存的虚构学习总结', 'task-title': '未保存的虚构任务', 'import-json': '{"schemaVersion":1,"tasks":[{"taskKey":"unsaved","project":"","title":"虚构导入草稿","estimateMinutes":25}],"plans":[]}' };
    const fill = async id => {
      await reveal(id);
      await run(`(() => { const node = document.getElementById(${JSON.stringify(id)}); node.value = ${JSON.stringify(drafts[id])}; node.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    };
    await show('settings'); await fill('whitelist');
    await show('review'); await fill('review-accomplished');
    await click('quick-add');
    check('Quick add expands and focuses task input', await run("document.body.dataset.page === 'workspace' && document.getElementById('task-entry').open && document.activeElement.id === 'task-title'"));
    await fill('task-title');
    await show('review'); await click('quick-import');
    check('Quick import expands and focuses file input', await run("document.body.dataset.page === 'workspace' && document.getElementById('task-entry').open && document.getElementById('import-panel').open && document.activeElement.id === 'import-file'"));
    await fill('import-json');
    const checkDrafts = async label => {
      for (const [id, expected] of Object.entries(drafts)) {
        const actual = await run(`document.getElementById(${JSON.stringify(id)}).value`);
        check(`${label}: ${id}`, actual === expected);
      }
    };
    await show('settings'); await show('review'); await show('workspace');
    await delay(1100);
    await checkDrafts('Draft survives navigation and background refresh');
    check('Navigation does not save drafts', store.snapshot().tasks.length === 3 && !store.snapshot().settings.whitelist.includes(drafts.whitelist.toLowerCase()) && store.daily(date).review.accomplished !== drafts['review-accomplished']);
    await run("document.getElementById('task-entry').open = false; document.getElementById('import-panel').open = false; document.getElementById('task-view-all').click(); window.scrollTo(0, 0)");

    const measure = () => {
      const round = value => Math.round(value * 100) / 100;
      const box = node => {
        const rect = node.getBoundingClientRect();
        return { left: round(rect.left), right: round(rect.right), top: round(rect.top), bottom: round(rect.bottom), width: round(rect.width), height: round(rect.height) };
      };
      const controls = Array.from(document.querySelectorAll('button,input,select,textarea,summary')).filter(node => {
        const rect = node.getBoundingClientRect(); const style = getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.visibility !== 'collapse' && !node.closest('[hidden]');
      }).map(node => {
        const container = node.closest('form,section,main,aside') ?? node.parentElement;
        const rect = box(node); const parent = box(container);
        return {
          id: node.id || node.tagName.toLowerCase(), container: container.id || container.className || container.tagName.toLowerCase(), rect, containerRect: parent,
          insideContainerWidth: rect.left >= parent.left - 1 && rect.right <= parent.right + 1,
          insidePageWidth: rect.left >= -1 && rect.right <= innerWidth + 1,
          intentionalTableScroll: Boolean(node.closest('.table-scroll')),
        };
      });
      const containers = Array.from(document.querySelectorAll('#calendar-controls,#calendar-grid,#pomo-settings,#long-options,#micro-options,#pomo-sound-options,#event-sound-options,.event-sound-row,#import-preview,#import-projects,#import-tasks,#import-days,#import-summary,.import-source,.import-confirmation')).filter(node => {
        const rect = node.getBoundingClientRect(); const style = getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && !node.closest('[hidden]');
      }).map(node => {
        const parentNode = node.parentElement.closest('form,section,main,aside') ?? node.parentElement;
        const rect = box(node); const parent = box(parentNode);
        return {
          id: node.id || node.className, rect, containerRect: parent,
          insideContainerWidth: rect.left >= parent.left - 1 && rect.right <= parent.right + 1,
          insidePageWidth: rect.left >= -1 && rect.right <= innerWidth + 1,
          contentFits: node.scrollWidth <= node.clientWidth + 1,
          clientWidth: node.clientWidth, scrollWidth: node.scrollWidth,
        };
      });
      return {
        viewport: { innerWidth, innerHeight, devicePixelRatio, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth },
        documentFits: document.documentElement.scrollWidth <= innerWidth + 1,
        controls,
        violations: controls.filter(item => !item.intentionalTableScroll && (!item.insideContainerWidth || !item.insidePageWidth)),
        containers,
        containerViolations: containers.filter(item => !item.insideContainerWidth || !item.insidePageWidth || !item.contentFits),
      };
    };
    const layout = async (width, height, zoom, page, state) => {
      const metrics = await run(`(${measure.toString()})()`);
      report.layouts.push({ width, height, zoom, page, state, ...metrics });
      check(`Page width ${width}x${height}/${zoom}/${page}/${state}`, metrics.documentFits, metrics.viewport);
      check(`Control widths ${width}x${height}/${zoom}/${page}/${state}`, metrics.violations.length === 0, metrics.violations);
      check(`Visible container widths ${width}x${height}/${zoom}/${page}/${state}`, metrics.containerViolations.length === 0, metrics.containerViolations);
    };
    const checkVisible = async (name, ids) => {
      const states = await run(`(${JSON.stringify(ids)}).map(id => {
        const node = document.getElementById(id); const rect = node?.getBoundingClientRect();
        return { id, visible: Boolean(node && rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== 'hidden' && !node.closest('[hidden]')) };
      })`);
      check(name, states.every(item => item.visible), states);
    };
    const checkReachable = async (name, selector) => {
      const result = await run(`(() => {
        const node = document.getElementById(${JSON.stringify(selector)}) ?? document.querySelector(${JSON.stringify(selector)});
        if (!node) return { reachable: false, reason: 'missing control' };
        const originalScroll = { x: scrollX, y: scrollY }; const originalFocus = document.activeElement;
        const originalAreas = Array.from(document.querySelectorAll('.focus-panel,.sidebar,.table-scroll'), node => ({ node, top: node.scrollTop, left: node.scrollLeft }));
        node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
        const rect = node.getBoundingClientRect(); const x = (rect.left + rect.right) / 2; const y = (rect.top + rect.bottom) / 2;
        const hit = document.elementFromPoint(x, y);
        node.focus({ preventScroll: true });
        const result = {
          reachable: rect.width > 0 && rect.height > 0 && x >= 0 && x < innerWidth && y >= 0 && y < innerHeight,
          unobscured: Boolean(hit && (hit === node || node.contains(hit))),
          focusable: node.tabIndex >= 0 && document.activeElement === node,
          rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
          hit: hit?.id || hit?.tagName || null, scroll: { x: scrollX, y: scrollY },
        };
        if (originalFocus && originalFocus !== node) originalFocus.focus({ preventScroll: true });
        else node.blur();
        originalAreas.forEach(item => { item.node.scrollTo({ top: item.top, left: item.left, behavior: 'instant' }); });
        window.scrollTo({ left: originalScroll.x, top: originalScroll.y, behavior: 'instant' });
        return result;
      })()`);
      check(name, result.reachable && result.unobscured && result.focusable, result);
    };
    const verifyChromiumKeyboard = async () => {
      const keyboard = report.keyboard;
      keyboard.status = 'running';
      const baseline = await run("({ focusedId: document.activeElement?.id ?? '', x: scrollX, y: scrollY })");
      let attached = false;
      const menuState = () => run(`(() => {
        const details = document.querySelector('#tasks .task-action-more');
        const summary = details?.querySelector('summary'); const edit = details?.querySelector('[data-edit-task]');
        const active = document.activeElement;
        return { exists: Boolean(details && summary && edit), open: details?.open ?? false,
          focus: active === summary ? 'summary' : active === edit ? 'edit' : 'other',
          focusedTag: active?.tagName ?? null, documentHasFocus: document.hasFocus(), taskId: edit?.dataset.editTask ?? null };
      })()`);
      const key = async (name, virtualKeyCode) => {
        const before = await menuState();
        for (const type of ['keyDown', 'keyUp']) {
          let timeout;
          try {
            await Promise.race([
              win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
                type, key: name, code: name, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode,
                ...(name === 'Enter' && type === 'keyDown' ? { text: '\r', unmodifiedText: '\r' } : {}),
              }),
              new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('CDP keyboard command exceeded 1200 milliseconds: ' + name + '/' + type)), 1200); }),
            ]);
          } finally { clearTimeout(timeout); }
        }
        await delay(25);
        const after = await menuState();
        keyboard.events.push({ key: name, source: 'CDP Input.dispatchKeyEvent keyDown/keyUp', before, after });
        save();
        return after;
      };
      try {
        const prepared = await run(`(() => {
          const details = document.querySelector('#tasks .task-action-more'); const summary = details?.querySelector('summary');
          if (!summary) return false;
          summary.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
          summary.focus({ preventScroll: true }); return !details.open && document.activeElement === summary;
        })()`);
        keyboard.domFocusPreparation = { passed: prepared, method: 'summary.focus({preventScroll:true}); no DOM keyboard event' };
        check('CDP keyboard starts on closed task menu summary', prepared);
        if (!prepared) { keyboard.status = 'failed'; return; }
        win.webContents.debugger.attach('1.3'); attached = true;
        const entered = await key('Enter', 13);
        check('Chromium Enter opens native task details', entered.exists && entered.open);
        if (!entered.open) { keyboard.status = 'failed'; return; }
        const tabbed = await key('Tab', 9);
        check('Chromium Tab reaches first task edit action', tabbed.exists && tabbed.open && tabbed.focus === 'edit');
        const escaped = await key('Escape', 27);
        check('Chromium Escape closes task menu and restores summary focus', escaped.exists && !escaped.open && escaped.focus === 'summary');
        keyboard.status = tabbed.focus === 'edit' && !escaped.open && escaped.focus === 'summary' ? 'passed' : 'failed';
      } catch (error) {
        keyboard.status = 'unavailable'; keyboard.error = String(error.message ?? error);
        check('Chromium CDP keyboard dispatch available', false, keyboard.error);
      } finally {
        if (attached) {
          try { win.webContents.debugger.detach(); keyboard.detached = true; }
          catch (error) { keyboard.detachError = error.message; check('CDP keyboard debugger detaches', false, error.message); }
        }
        // Cleanup follows the Escape assertion, so it cannot make that assertion pass.
        await run(`(() => {
          const menu = document.querySelector('#tasks .task-action-more'); if (menu) menu.open = false;
          const previous = document.getElementById(${JSON.stringify(baseline.focusedId)}); if (previous) previous.focus({ preventScroll: true });
        })()`);
        await resetNormalScroll();
        keyboard.cleanupState = await screenshotState();
        check('Chromium keyboard verification retains hidden window', !win.isVisible());
        save();
      }
    };
    const setUi = (id, value, checkbox = false) => run(`(() => {
      const node = document.getElementById(${JSON.stringify(id)});
      if (!node) throw Error('Missing scene input');
      node.${checkbox ? 'checked' : 'value'} = ${JSON.stringify(value)};
      node.dispatchEvent(new Event(${JSON.stringify(id === 'import-json' ? 'input' : 'change')}, { bubbles: true }));
    })()`);
    const additionalScenes = async (width, height, zoom) => {
      const baseline = await run(`(() => ({
        mode: document.getElementById('focus-mode').value,
        long: document.getElementById('long-enabled').checked,
        micro: document.getElementById('micro-enabled').checked,
        sound: document.getElementById('pomo-sound-enabled').checked,
        json: document.getElementById('import-json').value,
        startDate: document.getElementById('import-start-date').value,
        taskView: document.getElementById('task-view-day').getAttribute('aria-pressed') === 'true' ? 'day' : 'all',
        monthExpanded: document.getElementById('calendar-expand').getAttribute('aria-expanded') === 'true',
      }))()`);
      const persisted = JSON.stringify(store.snapshot());
      let previewAttempted = false;
      try {
        // Geometry checks force layout directly; these extra scenes need no PNGs.
        await show('workspace', false); await resetDetails();
        await click('task-view-day');
        if (await run("document.getElementById('calendar-expand').getAttribute('aria-expanded') === 'true'")) await click('calendar-expand');
        await click('calendar-today');
        check(`Single-week day calendar ${width}/${zoom}`, await run("!document.getElementById('calendar-controls').hidden && document.querySelectorAll('#calendar-grid button').length === 7"));
        await checkVisible(`Day calendar visible ${width}/${zoom}`, ['calendar-controls', 'calendar-grid', 'calendar-expand']);
        await checkReachable(`Day calendar action reachable ${width}/${zoom}`, 'calendar-expand');
        await layout(width, height, zoom, 'workspace', 'day-single-week');

        await click('calendar-expand');
        check(`Expanded monthly calendar ${width}/${zoom}`, await run("document.getElementById('calendar-expand').getAttribute('aria-expanded') === 'true' && document.querySelectorAll('#calendar-grid button').length >= 28"));
        await checkReachable(`Month calendar last day reachable ${width}/${zoom}`, '#calendar-grid button:last-of-type');
        await layout(width, height, zoom, 'workspace', 'day-expanded-month');

        await setUi('focus-mode', 'pomodoro');
        await setUi('long-enabled', true, true);
        await setUi('micro-enabled', true, true);
        await reveal('long-total');
        await checkVisible(`Long focus and micro-rest controls visible ${width}/${zoom}`, ['pomo-settings', 'long-options', 'micro-options', 'long-total', 'long-rest', 'micro-min', 'micro-max', 'micro-duration']);
        await checkReachable(`Micro-rest final input reachable ${width}/${zoom}`, 'micro-duration');
        await layout(width, height, zoom, 'workspace', 'pomodoro-long-micro');

        await show('settings', false);
        await setUi('pomo-sound-enabled', true, true);
        await reveal('sound-focus-start-tone');
        await checkVisible(`Long focus event audio controls visible ${width}/${zoom}`, ['pomo-sound-options', 'event-sound-options', 'sound-focus-start-tone', 'sound-micro-start-volume', 'sound-long-start-preview']);
        await checkReachable(`Event sound final action reachable ${width}/${zoom}`, 'sound-break-end-preview');
        await layout(width, height, zoom, 'settings', 'long-focus-event-sound');

        await show('workspace', false); await resetDetails();
        await click('quick-import');
        const projectName = '虚构课程-' + 'LongProjectName'.repeat(4);
        const taskTitle = '虚构长标题任务：' + '理解关键概念并整理容易混淆的学习笔记'.repeat(8);
        const document = { schemaVersion: 1,
          tasks: [{ taskKey: 'frontend-preview-only', project: projectName, title: taskTitle, estimateMinutes: 25 }],
          plans: [{ date, taskKey: 'frontend-preview-only', minutes: 25 }],
        };
        await setUi('import-json', JSON.stringify(document));
        previewAttempted = true;
        await click('import-paste-preview');
        await until("!document.getElementById('import-preview').hidden && !document.getElementById('import-confirm').disabled && document.getElementById('import-errors').textContent === ''", 'validated fictional import preview');
        await checkVisible(`Validated import preview visible ${width}/${zoom}`, ['import-preview', 'import-projects', 'import-tasks', 'import-days', 'import-summary', 'import-cancel', 'import-confirm']);
        await checkReachable(`Import final confirmation reachable without activation ${width}/${zoom}`, 'import-confirm');
        check(`Preview displays long fictional task and today ${width}/${zoom}`, await run(`document.getElementById('import-tasks').textContent.includes(${JSON.stringify(taskTitle)}) && document.getElementById('import-projects').textContent.includes(${JSON.stringify(projectName)}) && document.getElementById('import-summary').textContent.includes(${JSON.stringify(date)})`));
        check(`Preview writes no task, plan or settings ${width}/${zoom}`, JSON.stringify(store.snapshot()) === persisted);
        await layout(width, height, zoom, 'workspace', 'validated-import-preview');
      } finally {
        if (previewAttempted) {
          await until("!document.getElementById('import-cancel').disabled", 'preview cancellation ready');
          await click('import-cancel');
          await until("document.getElementById('import-preview').hidden && document.getElementById('import-json').value === ''", 'preview cancelled without confirm');
        }
        await setUi('import-json', baseline.json);
        await run(`document.getElementById('import-start-date').value = ${JSON.stringify(baseline.startDate)}`);
        await setUi('pomo-sound-enabled', baseline.sound, true);
        await setUi('micro-enabled', baseline.micro, true);
        await setUi('long-enabled', baseline.long, true);
        await setUi('focus-mode', baseline.mode);
        if (await run("document.getElementById('calendar-expand').getAttribute('aria-expanded') === 'true'") !== baseline.monthExpanded) await click('calendar-expand');
        await click(baseline.taskView === 'day' ? 'task-view-day' : 'task-view-all');
        await resetDetails(); await run('window.scrollTo(0, 0)'); await waitForPaint();
        const restored = await run(`document.getElementById('focus-mode').value === ${JSON.stringify(baseline.mode)} && document.getElementById('long-enabled').checked === ${baseline.long} && document.getElementById('micro-enabled').checked === ${baseline.micro} && document.getElementById('pomo-sound-enabled').checked === ${baseline.sound} && document.getElementById('import-json').value === ${JSON.stringify(baseline.json)} && document.getElementById('import-preview').hidden`);
        check(`Extra scenes restore timer options and import draft ${width}/${zoom}`, restored);
        check(`Extra scenes leave persisted data unchanged ${width}/${zoom}`, JSON.stringify(store.snapshot()) === persisted);
        save();
      }
    };
    const captureNormal = async (width, height, zoom, page) => {
      const filename = `frontend-preview-${width}x${height}-${Math.round(zoom * 100)}-${page}.png`;
      // A hidden window can return the previous compositor frame while waking up.
      // Discard that capture, then wait for another paint before saving pixels.
      const beforeWake = await waitForPaint();
      await delay(220);
      await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      const afterWake = await waitForPaint();
      await delay(220);
      const domState = await screenshotState();
      report.pendingScreenshot = { width, height, zoom, page, state: 'normal', filename, domState, paintWaits: [beforeWake, afterWake] };
      save();
      const image = await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      const domStateAfter = await screenshotState();
      const expectedPage = page === 'study' ? 'workspace' : page;
      const paired = domState.page === expectedPage && domState.studyView === (page === 'study')
        && domState.windowScroll.left === 0 && domState.windowScroll.top === 0
        && domState.scrollAreas.every(node => node.top === 0 && node.left === 0)
        && domState.details.every(node => !node.open || node.coreTimeline)
        && JSON.stringify(domState) === JSON.stringify(domStateAfter);
      check(`Screenshot state pairing ${width}x${height}/${zoom}/${page}`, paired, { before: domState, after: domStateAfter });
      if (!paired) throw new Error('Screenshot DOM state changed or does not match filename: ' + filename);
      if (image.isEmpty()) throw new Error('Empty screenshot: ' + filename);
      writeFileSync(config.screenshots + '/' + filename, image.toPNG());
      report.screenshots.push({
        width, height, zoom, page, state: 'normal', path: config.screenshots + '/' + filename,
        pixels: image.getSize(), capturedAt: new Date().toISOString(), domState, domStateAfter, paintWaits: [beforeWake, afterWake],
      });
      delete report.pendingScreenshot;
      save();
    };
    report.phase = 'layout-matrix';
    for (const [width, height, zoom] of config.matrix) {
      win.setContentSize(width, height);
      win.webContents.setZoomFactor(zoom);
      await delay(70);
      for (const page of ['workspace', 'review', 'settings', 'study']) {
        await show(page === 'study' ? 'workspace' : page);
        if (page === 'study') await click('focus-view');
        await resetDetails();
        await resetNormalScroll();
        await waitForPaint();
        check(`Window stays hidden ${width}/${zoom}/${page}`, !win.isVisible());
        if (page === 'study') check(`Study mode hides sidebar ${width}/${zoom}`, await run("document.body.classList.contains('study-view') && getComputedStyle(document.querySelector('.sidebar')).display === 'none'"));
        await layout(width, height, zoom, page, 'normal');
        await captureNormal(width, height, zoom, page);
        if (page === 'workspace' && width === 1366 && zoom === 1) await verifyChromiumKeyboard();
        if (page === 'workspace') await checkReachable(`Normal task disclosure reachable ${width}/${zoom}`, '#task-entry > summary');
        await run(`(() => {
          const root = document.getElementById(${JSON.stringify(pages[page === 'study' ? 'workspace' : page])});
          root.querySelectorAll('details').forEach(node => { node.open = true; });
        })()`);
        await waitForPaint();
        await layout(width, height, zoom, page, 'expanded');
        await resetDetails();
        await waitForPaint();
        save();
      }
      await additionalScenes(width, height, zoom);
    }
    report.phase = 'running-session-navigation';
    win.setContentSize(1366, 768); win.webContents.setZoomFactor(1);
    await show('workspace'); await click('focus-toggle');
    await until("document.getElementById('focus-badge').textContent.includes('进行中')", 'start timer');
    const sessionId = study.state().timer?.sessionId;
    check('Timer starts through actual preload', study.state().running && Boolean(sessionId));
    for (const page of ['settings', 'review', 'workspace']) {
      now += 1000; await study.tick(); await show(page);
      check('Timer survives navigation: ' + page, study.state().running && study.state().timer?.sessionId === sessionId);
      if (page !== 'workspace') {
        await until("!document.getElementById('active-session').hidden", 'active session link');
        await click('active-session');
        check('Active session returns and focuses timer from ' + page, await run("document.body.dataset.page === 'workspace' && document.activeElement.id === 'focus-toggle'") && study.state().running && study.state().timer?.sessionId === sessionId);
      }
    }
    await delay(1100); await checkDrafts('Draft survives running timer navigation');
    await click('focus-toggle');
    await until("!document.getElementById('focus-badge').textContent.includes('进行中')", 'stop timer');
    check('Timer stops explicitly', !study.state().running);
    check('All screenshot states retain hidden window', !win.isVisible());
    finish();
  } catch (error) { finish(error); }
}

await writeFile(entry, `(${runFrontendDriver.toString()})(${JSON.stringify(configuration)});\n`);
const env = { ...process.env, STUDYFLOW_DATA_DIR: dataDirectory, STUDYFLOW_HIDDEN: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const startedAt = Date.now();
let log = '';
let result;
try {
  result = await new Promise((done, reject) => {
    const child = spawn(require('electron'), ['--disable-gpu', entry], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let timedOut = false;
    const stop = () => new Promise(resolveStop => {
      if (child.exitCode !== null) { resolveStop(); return; }
      if (process.platform === 'win32') execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 2000 }, () => resolveStop());
      else { child.kill('SIGKILL'); resolveStop(); }
    });
    const timeout = setTimeout(async () => { timedOut = true; await stop(); reject(new Error('Frontend verification exceeded its 55-second budget; its process tree was terminated')); }, Math.max(1000, 55000 - (Date.now() - runStartedAt)));
    child.stdout.on('data', chunk => { log += chunk.toString(); });
    child.stderr.on('data', chunk => { log += chunk.toString(); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timeout); done({ code, signal, timedOut }); });
  });
} catch (error) { result = { code: null, error: error.message }; }
await writeFile(join(root, 'process.log'), log);
const report = JSON.parse(await readFile(reportPath, 'utf8'));
report.process = { ...result, durationMs: Date.now() - startedAt, logPath: join(root, 'process.log') };
if (result.code !== 0 || result.timedOut || report.status !== 'passed') report.status = 'failed';
await writeFile(reportPath, JSON.stringify(report, null, 2));
console.log(`Frontend verification ${report.status}: ${report.checks.filter(item => item.passed).length}/${report.checks.length} checks, ${report.layouts.length} layout states, ${report.screenshots?.length ?? 0} screenshots.`);
console.log('Report: ' + reportPath);
if (report.status !== 'passed') {
  console.error(`Electron exit: ${result.code ?? result.error ?? result.signal ?? 'unknown'}`);
  for (const failure of report.checks.filter(item => !item.passed)) console.error('FAIL: ' + failure.name);
  for (const failure of report.failures ?? []) console.error(failure);
  process.exitCode = 1;
}
