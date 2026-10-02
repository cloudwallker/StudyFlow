import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { Script } from 'node:vm';

const require = createRequire(import.meta.url);
const executable = require('electron');
const appPath = resolve('dist/desktop/main.cjs');
await mkdir('.cache/focus-mini-smoke', { recursive: true });
const root = await mkdtemp(resolve('.cache/focus-mini-smoke/run-'));
const entry = join(root, 'driver.cjs');
const expectedPath = join(root, 'expected.json');
const entryScreenshot = join(root, 'focus-mini-entry.png');
const miniScreenshot = join(root, 'focus-mini.png');

const driverSource = `
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const { readFileSync, writeFileSync } = require('node:fs');
require(${JSON.stringify(appPath)});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const watchdog = setTimeout(() => {
  console.error('Focus mini verification timed out');
  app.exit(1);
}, 55000);
const until = async (read, label, timeout = 15000) => {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    const value = await read();
    if (value) return value;
    await delay(100);
  }
  throw new Error('Timed out: ' + label);
};
const parseClock = value => {
  assert.match(value, /^[0-9]{2,}:[0-9]{2}:[0-9]{2}$/, 'Mini clock must use HH:mm:ss');
  const [hours, minutes, seconds] = value.split(':').map(Number);
  assert(minutes < 60 && seconds < 60, 'Mini clock contains an invalid minute or second');
  return hours * 3600 + minutes * 60 + seconds;
};
const waitForPaint = target => target.webContents.executeJavaScript(
  'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');

(async () => {
  console.log('STAGE: app-ready');
  await app.whenReady();
  const win = await until(() => BrowserWindow.getAllWindows().find(candidate =>
    candidate.webContents.getURL().endsWith('index.html') && !candidate.webContents.isLoading()), 'main window');
  win.webContents.setBackgroundThrottling(false);
  const run = source => win.webContents.executeJavaScript(source);
  await until(() => run("typeof window.studyflow?.request === 'function' && typeof window.studyflow?.focusMini?.open === 'function' && !!document.getElementById('focus-mini-open')"), 'main renderer');
  console.log('STAGE: main-renderer-ready');
  assert.equal(win.isVisible(), false, 'The main window starts hidden');
  const request = async (command, payload) => {
    const reply = await run('window.studyflow.request(' + JSON.stringify(command) + ',' + (JSON.stringify(payload) ?? 'undefined') + ')');
    assert(reply.ok, reply.error);
    return reply.value;
  };
  const visibleMini = () => BrowserWindow.getAllWindows().find(candidate =>
    candidate !== win && !candidate.isDestroyed() && candidate.isVisible()
      && candidate.getTitle() === 'StudyFlow 专注小窗'
      && candidate.webContents.getURL().endsWith('focus-mini.html'));
  const openMini = async () => {
    const reply = await run('window.studyflow.focusMini.open()');
    assert.deepEqual(reply, { ok: true });
    const mini = await until(() => {
      const candidate = visibleMini();
      return candidate && !candidate.webContents.isLoading() ? candidate : null;
    }, 'focus mini window');
    await until(() => mini.webContents.executeJavaScript("typeof window.studyflowFocusMini?.snapshot === 'function' && /^[0-9]{2,}:[0-9]{2}:[0-9]{2}$/.test(document.getElementById('focus-mini-time')?.textContent ?? '')"), 'focus mini renderer');
    return mini;
  };
  const readMini = async mini => {
    const view = await mini.webContents.executeJavaScript(` + "`" + `(() => ({
      elapsed: document.getElementById('focus-mini-time')?.textContent?.trim() ?? '',
      date: document.getElementById('focus-mini-date')?.textContent?.trim() ?? '',
      status: document.getElementById('focus-mini-status')?.textContent?.trim() ?? '',
      task: document.getElementById('focus-mini-task')?.textContent?.trim() ?? ''
    }))()` + "`" + `);
    return { ...view, seconds: parseClock(view.elapsed) };
  };
  const miniSnapshot = async mini => {
    const reply = await mini.webContents.executeJavaScript('window.studyflowFocusMini.snapshot()');
    assert(reply.ok, reply.error);
    assert(reply.snapshot, 'Mini snapshot reply must include a snapshot');
    return reply.snapshot;
  };
  const waitForSeconds = (mini, predicate, label) => until(async () => {
    const view = await readMini(mini);
    return predicate(view.seconds, view) ? view : null;
  }, label);

  assert.equal(await run('typeof require'), 'undefined');
  assert.equal(await run("document.getElementById('focus-mini-open').hidden"), false);
  // windowsHide supplies SW_HIDE startup information, consumed by the first
  // Windows ShowWindow call. Normalize this test-only launch in both stages.
  win.show();
  if (!win.isVisible()) win.show();
  await until(() => win.isVisible(), 'main window shown for test launch');

  if (process.env.STUDYFLOW_FOCUS_MINI_STAGE === 'write') {
    console.log('STAGE: entry-screenshot-show');
    await run("document.getElementById('focus-mini-open').scrollIntoView({ block: 'center' })");
    await waitForPaint(win);
    console.log('STAGE: entry-screenshot-capture');
    writeFileSync(${JSON.stringify(entryScreenshot)}, (await win.webContents.capturePage()).toPNG());
    console.log('STAGE: entry-screenshot-saved');
    win.hide();
    const before = await request('snapshot');
    assert.equal(before.focus.timer.status, 'idle');
    console.log('STAGE: mini-open-from-entry');
    await run("document.getElementById('focus-mini-open').click()");
    let mini = await until(() => {
      const candidate = visibleMini();
      return candidate && !candidate.webContents.isLoading() ? candidate : null;
    }, 'focus mini opened from button');
    await until(() => mini.webContents.executeJavaScript("typeof window.studyflowFocusMini?.snapshot === 'function' && /^[0-9]{2,}:[0-9]{2}:[0-9]{2}$/.test(document.getElementById('focus-mini-time')?.textContent ?? '')"), 'focus mini renderer');
    assert.equal(mini.isAlwaysOnTop(), true);
    assert.deepEqual({
      contextIsolation: mini.webContents.getLastWebPreferences().contextIsolation,
      nodeIntegration: mini.webContents.getLastWebPreferences().nodeIntegration,
      sandbox: mini.webContents.getLastWebPreferences().sandbox,
    }, { contextIsolation: true, nodeIntegration: false, sandbox: true });
    assert.equal(await mini.webContents.executeJavaScript('typeof require'), 'undefined');
    const initialSnapshot = await miniSnapshot(mini);
    const initialView = await readMini(mini);
    assert.equal(initialSnapshot.elapsedMs, 0, 'A fresh data directory must start at zero');
    assert.equal(initialView.elapsed, '00:00:00');
    assert(initialView.date.includes(initialSnapshot.date), 'Mini must label the current local date');
    assert.equal(initialView.task, '自由专注');
    const layout = await mini.webContents.executeJavaScript(` + "`" + `(() => {
      const footer = document.querySelector('footer').getBoundingClientRect();
      return { footerBottom: footer.bottom, innerHeight, scrollHeight: document.documentElement.scrollHeight };
    })()` + "`" + `);
    assert(layout.footerBottom <= layout.innerHeight, 'Mini footer must fit inside the viewport');
    assert(layout.scrollHeight <= layout.innerHeight, 'Mini content must not need vertical scrolling');
    console.log('STAGE: mini-layout-ready');
    await mini.webContents.executeJavaScript("document.getElementById('focus-mini-open-main').click()");
    await until(() => win.isVisible(), 'open main from mini');
    win.hide();
    const firstId = mini.id;
    assert.equal((await openMini()).id, firstId, 'Repeated open must reuse the visible mini window');
    assert.equal(BrowserWindow.getAllWindows().filter(candidate => candidate.getTitle() === 'StudyFlow 专注小窗').length, 1);

    console.log('STAGE: stopwatch-start');
    await request('start', { taskId: null, mode: 'stopwatch', idleMinutes: 240 });
    await until(async () => (await miniSnapshot(mini)).elapsedMs >= 2_000, 'running snapshot growth');
    const running = await waitForSeconds(mini, seconds => seconds >= 2, 'running clock growth');
    assert.match(running.status, /专注|运行|计时/);
    assert.equal(running.task, '自由专注');
    await waitForPaint(mini);
    console.log('STAGE: mini-screenshot-capture');
    writeFileSync(${JSON.stringify(miniScreenshot)}, (await mini.webContents.capturePage()).toPNG());
    console.log('STAGE: mini-screenshot-saved');

    console.log('STAGE: stopwatch-pause');
    await request('pause');
    const paused = await until(async () => {
      const snapshot = await miniSnapshot(mini);
      return snapshot.status === 'paused' ? snapshot : null;
    }, 'paused mini state');
    await until(async () => /暂停/.test((await readMini(mini)).status), 'paused mini render');
    await delay(2200);
    assert.equal((await miniSnapshot(mini)).elapsedMs, paused.elapsedMs, 'Paused clock must remain fixed');

    console.log('STAGE: stopwatch-resume');
    await request('resume');
    const resumed = await until(async () => {
      const snapshot = await miniSnapshot(mini);
      return snapshot.elapsedMs > paused.elapsedMs ? snapshot : null;
    }, 'resumed clock growth');
    const sessionId = (await request('snapshot')).focus.timer.sessionId;
    console.log('STAGE: mini-close');
    await mini.webContents.executeJavaScript("document.getElementById('focus-mini-close').click()");
    await until(() => mini.isDestroyed() || !mini.isVisible(), 'mini close');
    await delay(1600);
    let snapshot = await request('snapshot');
    assert.equal(snapshot.focus.timer.status, 'running', 'Closing the mini window must not stop focus');
    assert.equal(snapshot.focus.timer.sessionId, sessionId);

    console.log('STAGE: main-close-to-tray');
    const beforeTray = snapshot.focus.timer.phaseElapsedMs;
    win.close();
    await until(() => !win.isVisible(), 'main window hidden to tray');
    assert.equal(win.isDestroyed(), false, 'Closing the main window must retain the tray lifecycle');
    await delay(2200);
    snapshot = await request('snapshot');
    assert.equal(snapshot.focus.timer.status, 'running');
    assert(snapshot.focus.timer.phaseElapsedMs > beforeTray, 'Focus must continue while the main window is hidden');

    console.log('STAGE: mini-reopen');
    mini = await openMini();
    const reopened = await until(async () => {
      const current = await miniSnapshot(mini);
      return current.elapsedMs > resumed.elapsedMs ? current : null;
    }, 'reopened mini reads current session');
    assert.equal((await request('snapshot')).focus.timer.sessionId, sessionId);
    console.log('STAGE: first-session-stop');
    await request('stop');
    const stopped = await until(async () => {
      const current = await miniSnapshot(mini);
      return current.status === 'stopped' ? current : null;
    }, 'stopped mini state');
    await until(async () => /结束|停止/.test((await readMini(mini)).status), 'stopped mini render');
    await delay(2200);
    assert.equal((await miniSnapshot(mini)).elapsedMs, stopped.elapsedMs, 'Stopped clock must remain fixed');

    console.log('STAGE: second-session-start');
    await request('start', { taskId: null, mode: 'stopwatch', idleMinutes: 240 });
    const nextSession = await until(async () => {
      const current = await miniSnapshot(mini);
      return current.elapsedMs > stopped.elapsedMs ? current : null;
    }, 'new session adds to today total');
    assert(nextSession.elapsedMs > stopped.elapsedMs, 'A new session must not reset today total');
    console.log('STAGE: second-session-stop');
    await request('stop');
    const final = await until(async () => {
      const current = await miniSnapshot(mini);
      return current.status === 'stopped' ? current : null;
    }, 'second session stopped');
    await delay(1200);
    assert.equal((await miniSnapshot(mini)).elapsedMs, final.elapsedMs);
    const finalView = await until(async () => {
      const view = await readMini(mini);
      return view.seconds === Math.floor(final.elapsedMs / 1_000) ? view : null;
    }, 'final elapsed render');
    writeFileSync(${JSON.stringify(expectedPath)}, JSON.stringify({ elapsedMs: final.elapsedMs, text: finalView.elapsed, firstSessionId: sessionId }));
    console.log('STAGE: persistence-checkpoint-saved');
    console.log('PASS: focus mini entry/API/singleton, always-on-top isolation, real stopwatch growth, pause/resume, mini close, tray lifecycle, same-session reopen, stop freeze, cumulative new session');
  } else {
    win.hide();
    console.log('STAGE: restart-read');
    const expected = JSON.parse(readFileSync(${JSON.stringify(expectedPath)}, 'utf8'));
    const snapshot = await request('snapshot');
    assert.equal(snapshot.focus.timer.status, 'idle', 'A stopped timer must not be restored as running');
    const mini = await openMini();
    const restored = await readMini(mini);
    assert.equal(restored.elapsed, expected.text);
    assert.equal((await miniSnapshot(mini)).elapsedMs, expected.elapsedMs, 'Today total must survive an actual app restart');
    await delay(2200);
    assert.equal((await miniSnapshot(mini)).elapsedMs, expected.elapsedMs, 'Restarted idle clock must remain fixed');
    console.log('STAGE: restart-persistence-verified');
    console.log('PASS: app.quit restart preserves today total without restoring or advancing a stopped session');
  }
  clearTimeout(watchdog);
  app.quit();
})().catch(error => {
  console.error(error);
  clearTimeout(watchdog);
  app.exit(1);
});
`;
new Script(driverSource, { filename: entry });
await writeFile(entry, driverSource);

if (process.env.STUDYFLOW_VERIFY_PREPARE_ONLY === '1') {
  console.log('Generated focus mini driver syntax is valid: ' + entry);
  process.exit(0);
}

for (const stage of ['write', 'read']) {
  const env = {
    ...process.env,
    STUDYFLOW_DATA_DIR: join(root, 'data'),
    STUDYFLOW_HIDDEN: '1',
    STUDYFLOW_FOCUS_MINI_STAGE: stage,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((done, reject) => {
    let passed = false;
    const child = spawn(executable, ['--disable-gpu', entry], {
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Focus mini verification timed out'));
    }, 60000);
    child.stdout.on('data', chunk => {
      process.stdout.write(chunk);
      if (chunk.toString().includes('PASS:')) passed = true;
    });
    child.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', code => {
      clearTimeout(timeout);
      code === 0 && passed ? done() : reject(new Error('Focus mini verification failed: ' + code));
    });
  });
}

await Promise.all([readFile(entryScreenshot), readFile(miniScreenshot), readFile(expectedPath)]);
console.log('Focus mini smoke passed. Evidence directory: ' + root);
