import { build } from 'esbuild';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const appDirectory = resolve(process.argv[2] ?? 'dist/desktop');
await mkdir('.cache/pomodoro-smoke', { recursive: true });
const root = await mkdtemp(resolve('.cache/pomodoro-smoke/run-'));
const fixture = join(root, 'fixture.cjs');
await build({ stdin: { contents: "export { DesktopStudy } from './src/desktop/study'; export { DesktopService } from './src/desktop/service'; export { StudyStore } from './src/desktop/store'; export { DesktopSound } from './src/desktop/sound'; export { createElectronAmbientAudio, installAmbientAudioIpc } from './src/desktop/ambient-audio';", resolveDir: process.cwd() },
  outfile: fixture, bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'node:sqlite'] });
const entry = join(root, 'driver.cjs');
await writeFile(entry, `
const { app, BrowserWindow, ipcMain } = require('electron');
const { writeFileSync } = require('node:fs');
const assert = require('node:assert/strict');
const { DesktopStudy, DesktopService, StudyStore, DesktopSound, createElectronAmbientAudio, installAmbientAudioIpc } = require(${JSON.stringify(fixture)});
app.setPath('userData', ${JSON.stringify(join(root, 'data'))});
const delay = ms => new Promise(r => setTimeout(r, ms));
const watchdog = setTimeout(() => app.exit(1), 25000);
app.whenReady().then(async () => {
  const filename = ${JSON.stringify(join(root, 'studyflow.sqlite'))};
  const store = new StudyStore(filename);
  const sound = new DesktopSound(${JSON.stringify(join(appDirectory, 'native/StudyFlowSound.exe'))});
  const played = []; const playback = [];
  let now = 0, id = 0;
  const study = new DesktopStudy({ clock: { read: () => ({ wallMs: now, monotonicMs: now, utcOffsetMinutes: 0 }) },
    makeId: () => String(++id), sampler: { sample: async () => ({ status: 'ok', app: 'Code.exe', idleMs: 0 }) },
    notify: async () => {}, dismiss: () => {}, credit: () => {},
    sound: { play: (kind, config) => { played.push(kind); const pending = sound.play(kind, config); playback.push(pending); return pending; }, stop: () => sound.stop() } });
  const service = new DesktopService(store, study);
  const win = new BrowserWindow({ show: false, width: 1180, height: 1050, webPreferences: {
    preload: ${JSON.stringify(join(appDirectory, 'preload.cjs'))}, contextIsolation: true, nodeIntegration: false, sandbox: true } });
  ipcMain.handle('studyflow:command', (event, command, payload) => {
    assert.equal(event.sender, win.webContents);
    try { return { ok: true, value: service.execute(command, payload) }; }
    catch(error) { return { ok: false, error: error.message }; }
  });
  const ambient = createElectronAmbientAudio({ createWindow: options => new BrowserWindow(options), userDataPath: app.getPath('userData'), showOpenDialog: async () => ({ canceled: true, filePaths: [] }) });
  const removeAmbient = installAmbientAudioIpc(ipcMain, ambient, event => event.sender === win.webContents);
  await win.loadURL(${JSON.stringify(pathToFileURL(join(appDirectory, 'index.html')).href)}); await delay(300);
  await win.webContents.executeJavaScript([
    "const e = id => document.getElementById(id);",
    "e('focus-mode').value = 'pomodoro'; e('focus-mode').dispatchEvent(new Event('change'));",
    "e('pomo-work').value = '2'; e('pomo-short').value = '1';",
    "e('pomo-sound-enabled').click(); e('pomo-sound-min').value = '1'; e('pomo-sound-max').value = '1';",
    "e('pomo-sound-tone').value = 'bell'; e('pomo-sound-volume').value = '15';",
    "e('settings-form').requestSubmit();"
  ].join('')); await delay(150);
  assert.equal(store.snapshot().settings.sound.enabled, true);
  assert.equal(store.snapshot().settings.sound.tone, 'bell');
  await win.webContents.executeJavaScript("document.getElementById('pomo-preview-cue').click()"); await delay(700);
  await Promise.all(playback); assert.deepEqual(played, ['cue']); played.length = 0;
  await win.webContents.executeJavaScript("document.getElementById('focus-toggle').click()"); await delay(150);
  assert.equal(study.state().timer.status, 'running'); assert.equal(win.isVisible(), false);
  now = 60000; await study.tick(); await Promise.all(playback); assert.deepEqual(played, ['cue']);
  now = 120000; await study.tick(); await Promise.all(playback); assert.deepEqual(played, ['cue', 'work-end']);
  await delay(1100);
  await win.webContents.executeJavaScript("document.getElementById('pomo-next').value = '1'; document.getElementById('focus-pause').click()"); await delay(150);
  assert.equal(study.state().timer.phase, 'short-break');
  now = 180000; await study.tick(); await Promise.all(playback); assert.deepEqual(played, ['cue', 'work-end', 'break-end']);
  study.stop(); await delay(1100);
  win.showInactive();
  await win.webContents.executeJavaScript("document.querySelector('.session-options').open = true; document.querySelector('.pomo-sound-card').scrollIntoView({ block: 'center' })");
  await delay(300);
  writeFileSync(${JSON.stringify(resolve('dist/pomodoro-preview.png'))}, (await win.webContents.capturePage()).toPNG());
  win.hide();
  const pending = sound.play('break-end', { enabled: true, minMinutes: 1, maxMinutes: 1, volume: 15, tone: 'soft' });
  sound.stop(); await pending;
  await assert.rejects(new DesktopSound(${JSON.stringify(join(root, 'missing.exe'))}).play('cue', { enabled: true, minMinutes: 1, maxMinutes: 1, volume: 15, tone: 'soft' }));
  win.destroy(); removeAmbient(); await ambient.dispose(); store.close();
  const reopened = new StudyStore(filename); assert.equal(reopened.snapshot().settings.sound.volume, 15); reopened.close();
  console.log('PASS: Electron settings/preview/start/next phase, hidden-window native playback completion, cancellation, missing helper failure, SQLite reopen. Audibility and real lock/sleep are not verified.');
  clearTimeout(watchdog); app.quit();
}).catch(error => { console.error(error); clearTimeout(watchdog); app.exit(1); });
`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
await new Promise((done, reject) => {
  let passed = false;
  const child = spawn(require('electron'), [entry], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
  const timeout = setTimeout(() => { child.kill(); reject(new Error('Pomodoro verification timed out')); }, 30000);
  child.stdout.on('data', chunk => { process.stdout.write(chunk); if (chunk.toString().includes('PASS: Electron settings')) passed = true; });
  child.once('error', error => { clearTimeout(timeout); reject(error); });
  child.once('exit', code => { clearTimeout(timeout); code === 0 && passed ? done() : reject(new Error('Pomodoro verification failed: ' + code)); });
});
