import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
const require = createRequire(import.meta.url);
await mkdir('.cache/calendar-smoke', { recursive: true });
const root = await mkdtemp(resolve('.cache/calendar-smoke/run-'));
const first = new Date(); first.setDate(first.getDate() - 1);
const dateString = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const startDate = dateString(first), today = dateString(new Date());
const document = { schemaVersion: 1, tasks: [], plans: [] };
for (let day = 1; day <= 14; day++) {
  const date = new Date(first); date.setDate(first.getDate() + day - 1);
  for (const [suffix, minutes] of [['学习', 20], ['验收', 10]]) {
    const taskKey = `day-${day}-${minutes}`;
    document.tasks.push({ taskKey, project: '示例课程 · 第一阶段', title: `第${day}天｜${suffix}：理解概念并整理学习笔记`, estimateMinutes: minutes });
    document.plans.push({ date: dateString(date), taskKey, minutes });
  }
}
const fixture = join(root, 'fictional-calendar.json'); await writeFile(fixture, JSON.stringify(document));
const entry = join(root, 'driver.cjs');
await writeFile(entry, `
const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const assert = require('node:assert/strict');
require(${JSON.stringify(resolve('dist/desktop/main.cjs'))});
const delay = ms => new Promise(r => setTimeout(r, ms));
const watchdog = setTimeout(() => app.exit(1), 30000);
(async () => {
  await app.whenReady(); let win;
  for (let i=0; i<100; i++) { win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('index.html')); if(win && !win.webContents.isLoading()) break; await delay(100); }
  assert(win); win.webContents.setBackgroundThrottling(false); await delay(300);
  const run = source => win.webContents.executeJavaScript(source);
  const request = (cmd,payload) => run('window.studyflow.request('+JSON.stringify(cmd)+','+JSON.stringify(payload ?? null)+')');
  const until = async source => { for(let i=0;i<100;i++){ if(await run(source)) return; await delay(50); } throw new Error('UI condition timed out: '+source); };
  if (process.env.STUDYFLOW_CALENDAR_STAGE === 'write') {
    win.webContents.debugger.attach('1.3');
    const node = (await win.webContents.debugger.sendCommand('DOM.getDocument')).root.nodeId;
    const file = (await win.webContents.debugger.sendCommand('DOM.querySelector',{nodeId:node,selector:'#import-file'})).nodeId;
    await run("document.querySelector('.task-entry').open=true;document.querySelector('.import-panel').open=true");
    await win.webContents.debugger.sendCommand('DOM.setFileInputFiles',{nodeId:file,files:[${JSON.stringify(fixture)}]});
    await until("!document.getElementById('import-confirm').disabled");
    assert.equal((await request('snapshot')).value.tasks.length,0);
    await run("document.getElementById('import-confirm').click()");
    await until("document.getElementById('import-status').textContent.includes('导入成功')");
    assert.equal(await run("document.getElementById('calendar-date').value"),${JSON.stringify(startDate)});
    await run("document.querySelector('.task-entry').open=false;document.getElementById('calendar-today').click();window.scrollTo(0,0)");
    assert.equal(await run("document.getElementById('calendar-date').value"),${JSON.stringify(today)});
    const text = await run("document.getElementById('tasks').textContent");
    assert(text.indexOf('第2天') < text.indexOf('第1天')); assert(!text.includes('第14天'));
    assert.equal(await run("document.querySelectorAll('[data-makeup]').length"),2);
    win.setSize(1180,1100); await delay(200);
    writeFileSync(${JSON.stringify(resolve('dist/calendar-desktop-preview.png'))},(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    const taskId = await run("document.querySelector('[data-makeup]').dataset.makeup");
    await run("document.querySelector('[data-makeup]').click()");
    await until("document.querySelectorAll('[data-makeup]').length===1");
    assert((await request('snapshot')).value.checkins.some(c=>c.taskId===taskId && c.date===${JSON.stringify(startDate)}));
    assert.equal((await request('daily',{date:${JSON.stringify(startDate)}})).value.daily.effectiveMs,0);
    await run("document.getElementById('focus-view').click();window.scrollTo(0,0)");
    assert.equal(await run("getComputedStyle(document.querySelector('.sidebar')).display"),'none');
    await delay(150);
    writeFileSync(${JSON.stringify(resolve('dist/calendar-focus-preview.png'))},(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    await run("document.querySelector('#tasks .task-play').click()");
    await until("document.getElementById('focus-badge').textContent.includes('进行中')");
    const focus=(await request('snapshot')).value.focus; assert(focus.running); assert(focus.taskId);
    await request('stop');
    win.webContents.debugger.detach();
    console.log('PASS: real file import, first-day navigation, today before overdue, makeup without invented time, focus view and task start');
  } else {
    const data=(await request('snapshot')).value;
    assert.equal(data.tasks.length,28); assert.equal(data.plans.length,14); assert.equal(data.checkins.length,1); assert.equal(data.tasks.filter(t=>t.done).length,0);
    await until("document.querySelectorAll('[data-makeup]').length===1");
    console.log('PASS: real Electron restart retains plan dates and makeup task completion');
  }
  clearTimeout(watchdog); app.quit();
})().catch(error=>{console.error(error);clearTimeout(watchdog);app.exit(1)});
`);
for (const stage of ['write','read']) {
  const env = { ...process.env, STUDYFLOW_DATA_DIR: join(root, 'data'), STUDYFLOW_HIDDEN: '1', STUDYFLOW_CALENDAR_STAGE: stage }; delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((done, reject) => {
    const child = spawn(require('electron'), [entry], { env, windowsHide: true, stdio: 'inherit' });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Calendar verification timed out')); }, 35000);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('exit', code => { clearTimeout(timer); code === 0 ? done() : reject(new Error('Calendar verification failed: ' + code)); });
  });
}
