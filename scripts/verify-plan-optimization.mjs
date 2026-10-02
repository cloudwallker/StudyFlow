import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
await mkdir('.cache/plan-optimization-smoke', { recursive: true });
const root = await mkdtemp(resolve('.cache/plan-optimization-smoke/run-'));
const build = resolve('dist/desktop');
const driver = join(root, 'driver.cjs');
await writeFile(driver, `
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const { writeFileSync } = require('node:fs');
const testNow = new Date(); testNow.setHours(12, process.env.STUDYFLOW_PLAN_STAGE === 'read' ? 10 : 0, 0, 0);
let clock = testNow.getTime(); Date.now = () => clock;
require(${JSON.stringify(join(build, 'main.cjs'))});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const watchdog = setTimeout(() => app.exit(1), 55000);
const until = async (read, label, timeout = 15000) => {
  const end = performance.now() + timeout;
  while (performance.now() < end) { const value = await read(); if (value) return value; await delay(100); }
  throw new Error('Timed out: ' + label);
};
(async () => {
  await app.whenReady();
  const win = await until(() => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('index.html') && !w.webContents.isLoading()), 'main window');
  win.webContents.setBackgroundThrottling(false);
  const run = source => win.webContents.executeJavaScript(source);
  const request = async (command, payload) => {
    const reply = await run('window.studyflow.request(' + JSON.stringify(command) + ',' + JSON.stringify(payload ?? null) + ')');
    assert(reply.ok, reply.error); return reply.value;
  };
  const popup = () => BrowserWindow.getAllWindows().find(w => w.getTitle() === 'StudyFlow 每日计划提醒' && w.isVisible());
  await until(() => run("document.getElementById('plan-reminder-status').textContent.includes('关闭') || document.getElementById('plan-reminder-status').textContent.includes('发送')"), 'renderer ready');
  const today = [testNow.getFullYear(), String(testNow.getMonth() + 1).padStart(2, '0'), String(testNow.getDate()).padStart(2, '0')].join('-');
  if (process.env.STUDYFLOW_PLAN_STAGE === 'write') {
    assert.equal((await request('snapshot')).tasks.length, 0);
    const doc = { schemaVersion: 1, tasks: [{ taskKey: 'optimization-fixture', project: '示例学习', title: '<img src=x> 示例阅读', estimateMinutes: 25 }], plans: [{ date: today, taskKey: 'optimization-fixture', minutes: 25 }] };
    await run("document.getElementById('quick-import').click(); document.querySelector('.import-paste').open=true");
    await run("document.getElementById('import-json').value=" + JSON.stringify(JSON.stringify(doc)) + ";document.getElementById('import-json').dispatchEvent(new Event('input'));document.getElementById('import-paste-preview').click()");
    await until(() => run("!document.getElementById('import-confirm').disabled"), 'paste preview');
    assert.equal((await request('snapshot')).tasks.length, 0);
    assert((await run("document.getElementById('import-summary').textContent")).includes('25'));
    await run("document.getElementById('import-json').dispatchEvent(new Event('input'))");
    assert(await run("document.getElementById('import-confirm').disabled"));
    await run("document.getElementById('import-paste-preview').click()");
    await until(() => run("!document.getElementById('import-confirm').disabled"), 'edited preview');
    await run("document.getElementById('import-confirm').click()");
    await until(() => run("document.getElementById('import-status').textContent.includes('导入成功')"), 'paste import');
    assert.equal((await request('snapshot')).tasks.length, 1);
    await run("document.getElementById('nav-settings').click();document.getElementById('plan-reminder-enabled').checked=true;document.getElementById('plan-reminder-enabled').dispatchEvent(new Event('change'));document.getElementById('plan-reminder-time').value='09:00';document.getElementById('plan-reminder-time').dispatchEvent(new Event('input'));document.getElementById('plan-reminder-form').requestSubmit()");
    await until(() => run("document.getElementById('plan-reminder-save-status').textContent.includes('已保存')"), 'reminder settings');
    writeFileSync(${JSON.stringify(join(root, 'reminder-settings.png'))}, (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
    win.close(); assert(!win.isDestroyed()); assert(!win.isVisible());
    let notice = await until(popup, 'tray reminder');
    assert.equal(await notice.webContents.executeJavaScript("document.querySelectorAll('img').length"), 0);
    assert((await notice.webContents.executeJavaScript('document.body.textContent')).includes('<img src=x> 示例阅读'));
    writeFileSync(${JSON.stringify(join(root, 'plan-reminder.png'))}, (await notice.webContents.capturePage()).toPNG());
    await notice.webContents.executeJavaScript("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('10 分钟')).click()");
    await until(() => !popup(), 'snooze closes');
    let data = await request('snapshot'); assert.equal(data.planReminder.state, 'snoozed'); assert.equal(data.planReminder.nextAt, clock + 600000);
    clock += 600000;
    notice = await until(popup, 'snoozed reminder');
    await notice.webContents.executeJavaScript("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('查看今天')).click()");
    await until(() => win.isVisible(), 'open main');
    await until(() => !popup(), 'action closes reminder');
    assert.equal(await run('document.body.dataset.page'), 'workspace');
    assert.equal(await run("document.getElementById('calendar-date').value"), today);
    data = await request('snapshot'); assert.equal(data.planReminder.state, 'notified');
    console.log('PASS: real Electron paste preview/edit/confirm; hidden-to-tray reminder; safe task text; snooze; open today');
  } else {
    const data = await request('snapshot');
    assert.equal(data.tasks.length, 1); assert.deepEqual(data.settings.planReminder, { enabled: true, time: '09:00' });
    assert.equal(data.planReminder.state, 'notified');
    await delay(11000); assert(!popup());
    console.log('PASS: real Electron restart preserves settings/tasks/plans and does not repeat today reminder');
  }
  clearTimeout(watchdog); app.quit();
})().catch(error => { console.error(error); clearTimeout(watchdog); app.exit(1); });
`);

for (const stage of ['write', 'read']) {
  const env = { ...process.env, STUDYFLOW_DATA_DIR: join(root, 'data'), STUDYFLOW_HIDDEN: '1', STUDYFLOW_PLAN_STAGE: stage };
  delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((done, reject) => {
    const child = spawn(require('electron'), ['--disable-gpu', driver], { env, windowsHide: true, stdio: 'inherit' });
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Plan optimization verification timed out')); }, 60000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('exit', code => { clearTimeout(timeout); code === 0 ? done() : reject(new Error('Plan optimization verification failed: ' + code)); });
  });
}
console.log('Evidence directory: ' + root);
