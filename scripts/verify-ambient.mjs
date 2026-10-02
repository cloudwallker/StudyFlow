import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const application = resolve(process.argv[2] ?? 'dist/desktop');
await mkdir('.cache/ambient-smoke', { recursive: true });
const root = await mkdtemp(resolve('.cache/ambient-smoke/run-'));
const entry = join(root, 'driver.cjs');
// Synthetic fixtures only. FFMPEG_PATH can select an already installed encoder;
// no media download, dependency installation, or user music access is performed.
const wav = join(root, 'synthetic-tone.wav');
const mp3 = join(root, 'synthetic-tone.mp3');
const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg';
const encoders = spawnSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8', windowsHide: true });
if (encoders.error || encoders.status !== 0) throw new Error('Local ffmpeg is required; set FFMPEG_PATH to an installed executable');
const mp3Encoder = encoders.stdout.includes('libmp3lame') ? 'libmp3lame' : 'mp3_mf';
for (const [file, codec] of [[wav, 'pcm_s16le'], [mp3, mp3Encoder]]) {
  const encoded = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=44100:duration=3', '-c:a', codec, '-y', file], { encoding: 'utf8', windowsHide: true });
  if (encoded.error || encoded.status !== 0) throw new Error('Synthetic audio encoding failed: ' + (encoded.error?.message ?? encoded.stderr));
}
console.log('STAGE: synthetic-wav-mp3-created (' + mp3Encoder + ')');

await writeFile(entry, `
const { app, BrowserWindow, dialog } = require('electron');
const assert = require('node:assert/strict');
const { basename } = require('node:path');
const fixtures = ${JSON.stringify([wav, mp3])};
let selectedFile = null;
// Only the system chooser result is substituted. Public IPC, path validation,
// file inspection, file URLs, decoding and the hidden player remain real.
dialog.showOpenDialog = async () => selectedFile === null
  ? { canceled: true, filePaths: [] }
  : { canceled: false, filePaths: [selectedFile] };
require(${JSON.stringify(join(application, 'main.cjs'))});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const watchdog = setTimeout(() => app.exit(1), 60000);
(async () => {
  await app.whenReady();
  console.log('STAGE: app-ready');
  let main;
  for (let i = 0; i < 100; i++) {
    main = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('index.html'));
    if (main && !main.webContents.isLoading()) break;
    await delay(100);
  }
  assert(main, 'StudyFlow main window did not load');
  console.log('STAGE: main-window', main.webContents.getURL(), main.webContents.isLoading());
  console.log('STAGE: main-window-ready');
  const run = source => main.webContents.executeJavaScript(source, true);
  const ambient = (command, payload) => run(payload === undefined
    ? 'window.studyflow.ambient.request(' + JSON.stringify(command) + ')'
    : 'window.studyflow.ambient.request(' + JSON.stringify(command) + ',' + JSON.stringify(payload) + ')');
  const request = (command, payload) => run(payload === undefined
    ? 'window.studyflow.request(' + JSON.stringify(command) + ')'
    : 'window.studyflow.request(' + JSON.stringify(command) + ',' + JSON.stringify(payload) + ')');
  const until = async predicate => {
    for (let i = 0; i < 100; i++) { if (await predicate()) return; await delay(50); }
    throw new Error('Ambient verification timed out');
  };

  const initial = await ambient('snapshot');
  console.log('STAGE: initial-snapshot');
  console.log('STAGE: ambient-snapshot');
  assert.deepEqual(initial.value, { status: 'stopped', source: { type: 'noise', kind: 'white' }, volume: 35, loop: true, followFocus: false, message: null });
  assert.equal((await ambient('setVolume', { volume: 101 })).ok, false, 'Volume validation must run in the real IPC path');
  assert.equal((await ambient('selectFile', { path: 'C:\\\\private.mp3' })).ok, false, 'Renderer must not inject a local path');

  for (const kind of ['white', 'pink', 'brown']) {
    console.log('STAGE: noise', kind);
    console.log('STAGE: noise-' + kind);
    assert.equal((await ambient('setNoise', { kind })).ok, true);
    assert.equal((await ambient('setVolume', { volume: 0 })).ok, true);
    assert.equal((await ambient('play')).value.status, 'playing');
    const player = BrowserWindow.getAllWindows().find(window => window !== main && window.webContents.getURL().endsWith('ambient-player.html'));
    assert(player, 'Hidden ambient player window was not created');
    assert.equal(player.isVisible(), false, 'Ambient player must stay hidden');
    assert.equal(await player.webContents.executeJavaScript('typeof require'), 'undefined', 'Player renderer must not expose Node');
    assert.equal(await player.webContents.executeJavaScript('typeof globalThis.__studyflowAmbient'), 'function');
    assert.equal((await ambient('pause')).value.status, 'paused');
  }

  await ambient('stop');
  console.log('STAGE: manual-noise-complete');
  const player = BrowserWindow.getAllWindows().find(window => window !== main && window.webContents.getURL().endsWith('ambient-player.html'));
  assert(player, 'Missing real audio player');
  const inspect = source => player.webContents.executeJavaScript(source);
  // Observe the native media instances without replacing play/pause, dispatching
  // events, changing currentTime, or altering the product command handler.
  await inspect(\`(() => {
    const NativeAudio = globalThis.Audio;
    globalThis.__ambientObserved = [];
    globalThis.Audio = new Proxy(NativeAudio, {
      construct(target, args) {
        const audio = Reflect.construct(target, args);
        const record = { audio, ended: 0, wraps: 0, lastTime: 0 };
        audio.addEventListener('ended', () => record.ended++);
        audio.addEventListener('timeupdate', () => {
          if (audio.loop && record.lastTime > audio.currentTime + 0.5) record.wraps++;
          record.lastTime = audio.currentTime;
        });
        globalThis.__ambientObserved.push(record);
        return audio;
      }
    });
  })()\`);
  const media = () => inspect(\`(() => {
    const record = globalThis.__ambientObserved.at(-1);
    if (!record) return null;
    const a = record.audio;
    return { time: a.currentTime, duration: a.duration, paused: a.paused,
      ended: a.ended, endedEvents: record.ended, wraps: record.wraps,
      loop: a.loop, ready: a.readyState, error: a.error?.code ?? null,
      hasSource: a.hasAttribute('src'), local: a.currentSrc.startsWith('file:') };
  })()\`);
  for (const file of fixtures) {
    selectedFile = file;
    const selected = await ambient('selectFile');
    assert.equal(selected.ok, true);
    assert.deepEqual(selected.value.source, { type: 'file', name: basename(file) });
    assert.equal((await ambient('setLoop', { loop: false })).ok, true);
    assert.equal((await ambient('play')).value.status, 'playing');
    await until(async () => (await media()).time > 0.25);
    const playing = await media();
    assert(playing.local && playing.ready >= 2 && !playing.paused && playing.error === null);
    assert(playing.duration >= 2.8 && playing.duration < 4, 'Decoded fixture duration is unexpected');
    assert.equal((await ambient('pause')).value.status, 'paused');
    const paused = await media();
    await delay(300);
    assert.equal((await media()).paused, true);
    assert(Math.abs((await media()).time - paused.time) < 0.08, 'Paused media clock advanced');
    assert.equal((await ambient('play')).value.status, 'playing');
    assert((await media()).time >= paused.time - 0.08, 'Resume reset media position');
    await until(async () => (await media()).time > paused.time + 0.15);
    // Canceling a chooser must not detach end events from the active playback.
    selectedFile = null;
    assert.equal((await ambient('selectFile')).value.status, 'playing');
    await until(async () => (await media()).endedEvents === 1);
    assert.equal((await media()).ended, true);
    await until(async () => (await ambient('snapshot')).value.status === 'stopped');
    assert.equal((await ambient('snapshot')).value.message, null);
    console.log('STAGE: file-pause-resume-cancel-ended-' + basename(file));

    assert.equal((await ambient('setLoop', { loop: true })).ok, true);
    assert.equal((await ambient('play')).value.status, 'playing');
    await until(async () => (await media()).wraps >= 1);
    const looping = await media();
    assert(looping.loop && !looping.paused && !looping.ended && looping.endedEvents === 0);
    assert.equal((await ambient('snapshot')).value.status, 'playing');
    assert.equal((await ambient('stop')).value.status, 'stopped');
    assert.equal((await media()).paused, true);
    assert.equal((await media()).hasSource, false, 'Stop must release the file source');
    console.log('STAGE: file-loop-stop-' + basename(file));
  }
  console.log('STAGE: focus-link');
  await ambient('setFollowFocus', { enabled: true });
  const started = await request('start', { taskId: null, mode: 'stopwatch', idleMinutes: 5 });
  console.log('STAGE: focus-start');
  assert.equal(started.ok, true, 'Focus session did not start');
  await until(async () => (await ambient('snapshot')).value.status === 'playing');
  console.log('STAGE: focus-playing');
  assert.equal(main.isVisible(), false, 'Verification starts without showing the real app window');
  main.show();
  main.close();
  await delay(200);
  assert.equal(main.isDestroyed(), false, 'Closing the UI should keep the tray lifecycle alive');
  assert.equal(main.isVisible(), false, 'Closing the UI should hide it to tray');
  assert.equal((await ambient('snapshot')).value.status, 'playing', 'Ambient audio must remain active with the UI hidden');
  const trayTime = (await media()).time;
  await delay(350);
  assert.notEqual((await media()).time, trayTime, 'File playback clock must continue while hidden to tray');
  assert.equal((await media()).paused, false);
  console.log('STAGE: tray-playing');

  await request('stop');
  await until(async () => (await ambient('snapshot')).value.status === 'paused');
  assert.equal((await media()).paused, true, 'Focus stop must pause the actual media');
  assert.equal((await ambient('stop')).value.status, 'stopped');
  console.log('STAGE: stopped');
  // Quit while actively playing to exercise product teardown, not just idle exit.
  assert.equal((await ambient('setFollowFocus', { enabled: false })).ok, true);
  assert.equal((await ambient('play')).value.status, 'playing');
  await until(async () => (await media()).time > 0.1);
  app.once('will-quit', () => {
    try {
      assert.equal(player.isDestroyed(), true, 'Quit must destroy the hidden audio window');
      assert.equal(BrowserWindow.getAllWindows().length, 0, 'Quit must leave no application windows');
      console.log('PASS: real Electron IPC, white/pink/brown playback, synthetic WAV/MP3 decoding, pause/resume, chooser cancellation, natural ended events, loops, focus/tray playback and active-player quit cleanup');
      console.log('LIMIT: chooser result stubbed; native chooser interaction, audible output and physical device compatibility are not verified');
      clearTimeout(watchdog);
    } catch (error) { console.error(error); app.exit(1); }
  });
  app.quit();
})().catch(error => { console.error(error); clearTimeout(watchdog); app.exit(1); });
`);

const env = { ...process.env, STUDYFLOW_DATA_DIR: join(root, 'data'), STUDYFLOW_HIDDEN: '1' };
delete env.ELECTRON_RUN_AS_NODE;
await new Promise((resolvePromise, rejectPromise) => {
  let passed = false;
  const child = spawn(require('electron'), [entry], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
  child.stdout.on('data', chunk => {
    process.stdout.write(chunk);
    if (chunk.toString().includes('PASS: real Electron IPC')) passed = true;
  });
  const timeout = setTimeout(() => { child.kill(); rejectPromise(new Error('Ambient verification timed out')); }, 65000);
  child.on('error', error => { clearTimeout(timeout); rejectPromise(error); });
  child.on('exit', code => {
    clearTimeout(timeout);
    code === 0 && passed ? resolvePromise() : rejectPromise(new Error('Ambient verification incomplete or failed: ' + code));
  });
});
