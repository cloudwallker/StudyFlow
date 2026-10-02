import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
const require = createRequire(import.meta.url);
const executable = require('electron');
const output = execFileSync(resolve('dist/desktop/native/StudyFlowSampler.exe'), [], { input: 'sample\n', windowsHide: true, encoding: 'utf8', timeout: 8000 });
const native = JSON.parse(output.trim());
if (!['ok', 'unknown'].includes(native.status) || Object.keys(native).sort().join(',') !== 'app,idleMs,status' ||
  (native.status === 'ok' && (typeof native.app !== 'string' || !Number.isSafeInteger(native.idleMs) || native.idleMs < 0))) throw new Error('Unexpected native protocol');
console.log(`PASS: native protocol; foreground availability=${native.status}; no raw app metadata logged`);
await mkdir('.cache/m3-smoke', { recursive: true });
const root = await mkdtemp(resolve('.cache/m3-smoke/run-'));
const entry = join(root, 'driver.cjs');
const screenshot = resolve('dist/m3-desktop-preview.png');
await writeFile(entry, `
const { app, BrowserWindow, powerMonitor } = require('electron');
const { writeFileSync, readFileSync } = require('node:fs');
const assert = require('node:assert/strict');
require(${JSON.stringify(resolve('dist/desktop/main.cjs'))});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const timeout = setTimeout(() => app.exit(1), 35000);
(async () => {
  await app.whenReady(); let win;
  for (let i=0; i<100; i++) {
    win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('index.html'));
    if (win && !win.webContents.isLoading()) break;
    await delay(100);
  }
  assert(win); await delay(300);
  const run = source => win.webContents.executeJavaScript(source);
  const request = (command, payload = null) => run('window.studyflow.request(' + JSON.stringify(command) + ',' + JSON.stringify(payload) + ')');
  assert.equal(await run('typeof require'), 'undefined');
  let snapshot = await request('snapshot'); assert(snapshot.ok);
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(require('node:path').join(app.getPath('userData'), 'studyflow.sqlite'));
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5);
  if (process.env.STUDYFLOW_SMOKE_STAGE === 'read') {
    const expected = JSON.parse(readFileSync(${JSON.stringify(join(root, 'expected.json'))}, 'utf8'));
    assert.deepEqual(snapshot.value.tasks, expected);
    const daily = await request('daily', {date:'2000-01-02'});
    assert.equal(daily.value.daily.review.accomplished,'Fictional completed reading');
    assert.equal(daily.value.daily.plan.entries[0].minutes,40);
    console.log('PASS: daily plan and review survive real Electron restart');
    assert.equal(snapshot.value.focus.timer.status, 'idle');
    assert.equal(snapshot.value.settings.recordAppActivity, true);
    assert.equal(snapshot.value.settings.allDayActivity, true);
    assert.equal(snapshot.value.settings.mode, 'pomodoro');
    assert.equal(snapshot.value.settings.idleMinutes, 2);
    assert.deepEqual(snapshot.value.settings.policy, {workMinutes:40,shortBreakMinutes:7,longBreakMinutes:20,roundsBeforeLongBreak:3});
    assert.equal(await run("document.getElementById('pomo-work').value"), '40');
    console.log('PASS: all-day opt-in and timer preferences restore in real Electron and renderer');
    console.log('PASS: actual Electron restart retains tasks and settled totals; does not recover an open timer');
  } else {
    assert.equal(snapshot.value.settings.recordAppActivity, false);
    assert.equal((await request('settings', {allDayActivity:true})).ok,true);
    win.close(); await delay(7000);
    assert.equal(win.isDestroyed(),false); assert.equal(win.isVisible(),false);
    assert.equal((await request('snapshot')).value.focus.timer.status,'idle');
    assert.equal((await request('settings', {allDayActivity:false})).ok,true);
    assert(db.prepare('SELECT count(*) AS n FROM ambient_activity').get().n > 0);
    const ambientDay = db.prepare('SELECT date FROM ambient_activity LIMIT 1').get().date;
    const ambientDaily = (await request('daily',{date:ambientDay})).value.daily;
    assert(ambientDaily.activities.length > 0); assert.equal(ambientDaily.effectiveMs,0);
    console.log('PASS: real native collection with no timer, hidden in tray, flush and daily activity timeline');
    assert.equal((await request('start', {taskId:null,mode:'invalid'})).ok,false);
    assert.equal((await request('start', {taskId:null,mode:'pomodoro',policy:{workMinutes:0}})).ok,false);
    await request('createTask', {title:'M3 fictional verification',projectId:null,estimateMinutes:25});
    const taskId = (await request('snapshot')).value.tasks[0].id;
    await delay(1100);
    await run("document.getElementById('focus-mode').value='stopwatch';document.getElementById('focus-mode').dispatchEvent(new Event('change'));document.getElementById('focus-task').value=" + JSON.stringify(taskId) + ";document.getElementById('idle-minutes').value='240';document.getElementById('focus-toggle').click()");
    await delay(7000);
    snapshot = await request('snapshot'); assert.equal(snapshot.value.focus.timer.mode, 'stopwatch');
    await run("document.getElementById('focus-pause').click()"); await delay(200);
    assert.equal((await request('snapshot')).value.focus.timer.status,'paused');
    assert.equal((await request('start', {taskId:null})).ok,false);
    await request('resume'); win.close(); await delay(200);
    assert.equal(win.isDestroyed(),false); assert.equal(win.isVisible(),false);
    assert.equal((await request('snapshot')).value.focus.timer.status,'running');
    powerMonitor.emit('lock-screen');
    assert.equal((await request('snapshot')).value.focus.timer.status,'paused');
    powerMonitor.emit('resume'); assert.equal((await request('snapshot')).value.focus.timer.status,'paused');
    await request('resume'); await request('stop');
    const stopped = (await request('snapshot')).value.tasks;
    await request('stop'); assert.deepEqual((await request('snapshot')).value.tasks,stopped);
    await request('start', {taskId:null,mode:'pomodoro',policy:{workMinutes:1,shortBreakMinutes:1,longBreakMinutes:2,roundsBeforeLongBreak:2}});
    assert.equal((await request('snapshot')).value.focus.timer.remainingMs,60000);
    await request('stop');
    // The driver captures a hidden window; normal renderer timers are deliberately
    // throttled in the tray. Disable only in this external verification process.
    win.webContents.setBackgroundThrottling(false); await delay(1100);
    writeFileSync(${JSON.stringify(screenshot)}, (await win.webContents.capturePage()).toPNG());
    assert(db.prepare('SELECT count(*) AS n FROM timer_slices').get().n > 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM activity_intervals').get().n, 0);
    await run("document.getElementById('record-app-activity').checked=true;document.getElementById('settings-form').dispatchEvent(new Event('submit',{cancelable:true}))");
    await delay(200); assert.equal((await request('snapshot')).value.settings.recordAppActivity,true);
    await request('start',{taskId:null,mode:'stopwatch'}); await delay(4500); await request('stop');
    assert(db.prepare('SELECT count(*) AS n FROM activity_intervals').get().n > 0);
    const day = db.prepare('SELECT date FROM timer_slices LIMIT 1').get().date;
    await request('savePlan',{date:'2000-01-02',entries:[{taskId,minutes:40}]});
    await request('saveReview',{date:'2000-01-02',review:{accomplished:'Fictional completed reading',obstacles:'',adjustment:'Practice tomorrow'}});
    assert.equal((await request('daily',{date:'2000-01-02'})).value.daily.plan.entries[0].minutes,40);
    await run("document.getElementById('daily-date').value='2000-01-02';document.getElementById('daily-load').click()"); await delay(300);
    assert.equal(await run("document.getElementById('review-accomplished').value"),'Fictional completed reading');
    win.setSize(1180,1600);
    await run("document.getElementById('daily-panel').scrollIntoView({block:'start'})");
    await win.webContents.capturePage(undefined, {stayHidden:true, stayAwake:true}); await delay(500);
    writeFileSync(${JSON.stringify(resolve('dist/m3-daily-preview.png'))}, (await win.webContents.capturePage()).toPNG());
    console.log('PASS: real daily query, review and plan IPC; daily renderer');
    await run("document.getElementById('history-date').value=" + JSON.stringify(day) + ";document.getElementById('history-delete-form').dispatchEvent(new Event('submit',{cancelable:true}))");
    await delay(300);
    assert.equal(db.prepare('SELECT count(*) AS n FROM timer_slices WHERE date=?').get(day).n,0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM activity_intervals WHERE date=?').get(day).n,0);
    assert.deepEqual((await request('snapshot')).value.tasks,stopped);
    win.setSize(1180,1600); await delay(1100);
    await run("document.getElementById('history-delete-form').scrollIntoView({block:'end'})"); await delay(300);
    writeFileSync(${JSON.stringify(resolve('dist/m3-history-preview.png'))}, (await win.webContents.capturePage()).toPNG());
    writeFileSync(${JSON.stringify(join(root, 'expected.json'))}, JSON.stringify(stopped));
    console.log('PASS: real renderer/preload/IPC, mode controls, pause/resume, tray, injected power events, idempotent stop');
    assert.equal((await request('settings', {allDayActivity:true,mode:'pomodoro',idleMinutes:2,policy:{workMinutes:40,shortBreakMinutes:7,longBreakMinutes:20,roundsBeforeLongBreak:3}})).ok,true);
    console.log('PASS: schema v5, default privacy, persisted opt-in, real activity history and date deletion preserving totals');
  }
  db.close(); clearTimeout(timeout); app.quit();
})().catch(error => { console.error(error); clearTimeout(timeout); app.exit(1); });
`);
for (const stage of ['write', 'read']) {
  const env = { ...process.env, STUDYFLOW_DATA_DIR: join(root, 'data'), STUDYFLOW_HIDDEN: '1', STUDYFLOW_SMOKE_STAGE: stage };
  delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve, reject) => {
    const child = spawn(executable, ['--disable-gpu', entry], { env, windowsHide: true, stdio: 'inherit' });
    const watchdog = setTimeout(() => { child.kill(); reject(new Error('M3 smoke timed out')); }, 45000);
    child.on('error', error => { clearTimeout(watchdog); reject(error); });
    child.on('exit', code => { clearTimeout(watchdog); code === 0 ? resolve() : reject(new Error('M3 smoke failed: ' + code)); });
  });
}
console.log('M3 desktop smoke passed; screenshot: dist/m3-desktop-preview.png');
