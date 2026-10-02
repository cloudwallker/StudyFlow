import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const executable = require('electron');
const appPath = resolve('dist/desktop/main.cjs');
await mkdir('.cache/desktop-smoke', { recursive: true });
const root = await mkdtemp(resolve('.cache/desktop-smoke/run-'));
const screenshot = resolve('dist/desktop-preview.png');
const entry = join(root, 'smoke.cjs');
// This driver is outside the packaged app; it operates the real renderer/preload/IPC.
await writeFile(entry, `
const { app, BrowserWindow, powerMonitor } = require('electron');
const { writeFileSync } = require('node:fs');
const assert = require('node:assert/strict');
require(${JSON.stringify(appPath)});
const delay = ms => new Promise(r => setTimeout(r, ms));
const watchdog = setTimeout(() => { console.error('Smoke timed out'); app.exit(1); }, 25000);
(async () => {
  await app.whenReady();
  let win;
  for (let i=0; i<100; i++) {
    win = BrowserWindow.getAllWindows()[0];
    if (win && !win.webContents.isLoading() && win.webContents.getURL().endsWith('index.html')) break;
    await delay(100);
  }
  assert(win, 'Main window must load');
  await delay(200);
  const run = source => win.webContents.executeJavaScript(source);
  const request = (command, payload) => run('window.studyflow.request(' + JSON.stringify(command) + ',' + JSON.stringify(payload ?? null) + ')');
  const before = await request('snapshot'); assert(before.ok, JSON.stringify(before));
  assert.equal(await run('typeof require'), 'undefined');
  if (process.env.STUDYFLOW_SMOKE_STAGE === 'write') {
    assert.equal(before.value.tasks.length, 0);
    await run("document.getElementById('project-name').value='阅读与思考'; document.getElementById('project-form').requestSubmit()");
    await delay(300);
    const projects = (await request('snapshot')).value.projects; assert.equal(projects.length,1);
    await run("document.getElementById('task-title').value='阅读一章，整理三个关键观点'; document.getElementById('task-project').value=" + JSON.stringify(projects[0].id) + "; document.getElementById('task-form').requestSubmit()");
    await delay(300);
    const tasks = (await request('snapshot')).value.tasks; assert.equal(tasks.length,1);
    assert.equal(tasks[0].projectId, projects[0].id);
    const started = await request('start', { taskId: tasks[0].id }); assert(started.ok);
    win.close(); await delay(3300);
    assert.equal(win.isDestroyed(),false,'Closing to tray must retain window');
    assert.equal(win.isVisible(),false);
    assert.equal((await request('snapshot')).value.focus.running,true,'Background session continues');
    powerMonitor.emit('lock-screen');
    assert.equal((await request('snapshot')).value.focus.running,false,'Power handler stops focus');
    await request('createTask',{title:'完成今天的练习与复盘',projectId:projects[0].id,estimateMinutes:40});
    win.show(); await delay(1600);
    assert((await run("document.getElementById('tasks').textContent")).includes('阅读一章'),'Created task must be visible in the real UI');
    const image = await win.webContents.capturePage(); writeFileSync(${JSON.stringify(screenshot)},image.toPNG());
    const secondStarted = await request('start',{ taskId: tasks[0].id }); assert(secondStarted.ok);
    await delay(1200);
    win.emit('query-session-end', {});
    assert.equal((await request('snapshot')).value.focus.running,false,'Windows logoff query must settle focus');
    win.emit('session-end', {});
    console.log('PASS: renderer/preload/IPC, task/project writes, hidden-window focus, lock/logoff handlers');
  } else {
    assert.equal(before.value.tasks.length,2,'Tasks survive actual process restart');
    assert(before.value.tasks.some(t => t.spentMs > 0),'Focus time is durable');
    console.log('PASS: actual Electron restart persistence; node:sqlite '+process.versions.node);
  }
  clearTimeout(watchdog); app.quit();
})().catch(error => { console.error(error); clearTimeout(watchdog); app.exit(1); });
`);
for (const stage of ['write', 'read']) {
  const env = { ...process.env, STUDYFLOW_DATA_DIR: join(root, 'data'), STUDYFLOW_HIDDEN: '1', STUDYFLOW_SMOKE_STAGE: stage };
  delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((done, reject) => {
    const child = spawn(executable, [entry], { env, windowsHide: true, stdio: 'inherit' });
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Electron startup blocked or timed out')); }, 40000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('exit', code => { clearTimeout(timeout); code === 0 ? done() : reject(new Error(`Electron smoke failed: ${code}`)); });
  });
}
await readFile(screenshot);
console.log('Desktop smoke passed. Screenshot: dist/desktop-preview.png');
