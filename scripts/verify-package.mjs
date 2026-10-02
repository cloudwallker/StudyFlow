import { spawn } from 'node:child_process';
import { readFile, mkdtemp, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const testBuild = process.argv.includes('--test-build');
const packagePath = (await readFile(testBuild ? 'dist/test-package-path.txt' : 'dist/desktop-package-path.txt', 'utf8')).trim();
await mkdir('.cache/package-smoke', { recursive: true });
const data = await mkdtemp(resolve('.cache/package-smoke/run-'));
const env = { ...process.env, STUDYFLOW_DATA_DIR: data, STUDYFLOW_HIDDEN: '1' }; delete env.ELECTRON_RUN_AS_NODE;
if (process.argv.includes('--reminder')) delete env.STUDYFLOW_HIDDEN;
const child = spawn(join(packagePath, testBuild ? 'StudyFlow-Test.exe' : 'StudyFlow.exe'), ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
const watchdog = setTimeout(() => { console.error('Package verification exceeded 60 seconds'); child.kill(); socket?.close(); }, 60000);
let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk.toString(); });
const exited = new Promise(resolveExit => { child.on('exit', resolveExit); child.on('error', resolveExit); });
const delay = ms => new Promise(r => setTimeout(r, ms));
let socket;
let verificationPassed = false;
const pending = new Map(); let serial = 0;
try {
  let port;
  for (let i=0; i<100; i++) {
    try { port = Number((await readFile(join(data, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); if (port) break; } catch {}
    await delay(100);
  }
  assert(port, 'Packaged app must start debugging endpoint');
  let target;
  for (let i=0; i<100; i++) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = targets.find(t => t.type === 'page' && t.url.endsWith('/index.html'));
    if (target) break; await delay(100);
  }
  assert(target, 'Packaged page must load');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, fail) => { socket.addEventListener('open', ok, { once: true }); socket.addEventListener('error', fail, { once: true }); });
  socket.addEventListener('message', event => { const message = JSON.parse(event.data); const item = pending.get(message.id); if (item) { pending.delete(message.id); clearTimeout(item.timer); message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result); } });
  const send = (method, params) => new Promise((resolveCall, reject) => {
    const id = ++serial; const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout')); }, 8000);
    pending.set(id, { resolve: resolveCall, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error('Packaged renderer evaluation failed');
    return result.result.value;
  };
  await delay(300);
  assert.equal(await evaluate('typeof window.studyflow.request'),'function');
  assert.equal(await evaluate('typeof require'),'undefined');
  if (testBuild) {
    const status = await evaluate("window.studyflow.diagnostics.request('status')");
    assert(status.ok && status.status.enabled && status.status.version === '0.3.0-test.1');
    const check = await evaluate("window.studyflow.diagnostics.request('selfTest')"); assert(check.ok);
  }
  const added = await evaluate(`window.studyflow.request('createTask',{title:'Packaged smoke fixture',projectId:null,estimateMinutes:1})`);
  assert(added.ok); assert.equal(added.value.tasks.length,1);
  if (process.argv.includes('--calendar')) {
    const dateString = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
    const today = new Date(); const yesterday = new Date(today); yesterday.setDate(yesterday.getDate()-1);
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate()+1);
    const titles = ['Previous day fixture','Current day fixture','Future day fixture'];
    const content = JSON.stringify({ schemaVersion:1, tasks:titles.map((title,i)=>({taskKey:`calendar-${i}`,project:'Packaged calendar',title,estimateMinutes:10})),
      plans:[yesterday,today,tomorrow].map((date,i)=>({date:dateString(date),taskKey:`calendar-${i}`,minutes:10})) });
    const preview = await evaluate(`window.studyflow.request('previewImport',{content:${JSON.stringify(content)}})`); assert(preview.ok);
    const imported = await evaluate(`window.studyflow.request('confirmImport',{token:${JSON.stringify(preview.value.importPreview.token)}})`); assert(imported.ok);
    let text = '';
    for(let i=0;i<30;i++) { text = await evaluate("document.getElementById('tasks').textContent"); if(text.includes('Current day fixture')) break; await delay(100); }
    assert(text.includes('Current day fixture')); assert(text.indexOf('Current day fixture')<text.indexOf('Previous day fixture')); assert(!text.includes('Future day fixture'));
    assert.equal(await evaluate("document.querySelectorAll('#calendar-grid button').length"),7);
    await evaluate("document.querySelector('[data-makeup]').click()");
    for(let i=0;i<30;i++) { if(!(await evaluate("document.querySelector('[data-makeup]')!==null"))) break; await delay(100); }
    const checked = await evaluate("window.studyflow.request('snapshot')"); assert(checked.value.checkins.some(c=>c.taskId===checked.value.tasks.find(t=>t.title==='Previous day fixture').id));
    await evaluate("document.getElementById('focus-view').click()");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.sidebar')).display"),'none');
    console.log('PASS: final exe calendar, today/overdue ordering, makeup persistence and focus layout');
  }
  // Collector runs from the final package path. Allow actual app but avoid notifications.
  const configured = await evaluate(`window.studyflow.request('settings',{durationMinutes:1,idleMinutes:240,whitelist:['Code.exe','StudyFlow.exe','StudyFlow-Test.exe','electron.exe','powershell.exe','pwsh.exe']})`);
  assert(configured.ok);
  await evaluate(`window.studyflow.request('start',{taskId:${JSON.stringify(added.value.tasks[0].id)}})`);
  let state;
  // First poll starts at 3s and native timeout is 4s. Do not pass while the
  // first request is still pending and the initial session message is present.
  for (let i = 0; i < 24; i++) {
    await delay(500);
    state = await evaluate(`window.studyflow.request('snapshot')`);
    if (state.ok && !state.value.focus.message.startsWith('专注进行中')) break;
  }
  assert(state.ok && state.value.focus.running);
  assert(!state.value.focus.message.startsWith('专注进行中'), 'Wait for a completed native sample');
  assert(state.value.focus.app === null || typeof state.value.focus.app === 'string');
  assert.notEqual(state.value.focus.message, '采集暂不可用，计时继续；稍后自动重试', 'Bundled collector must respond');
  await evaluate(`window.studyflow.request('stop')`);
  if (process.argv.includes('--timeline')) {
    const duplicate = await evaluate(`window.studyflow.request('createTask',{title:'Packaged smoke fixture',projectId:null,estimateMinutes:1})`);
    assert(duplicate.ok);
    for (let i = 0; i < 3; i++) {
      const taskId = duplicate.value.tasks[i % duplicate.value.tasks.length].id;
      assert((await evaluate(`window.studyflow.request('start',{taskId:${JSON.stringify(taskId)},mode:'stopwatch'})`)).ok);
      await delay(200);
      assert((await evaluate(`window.studyflow.request('pause')`)).ok);
      await delay(200);
      assert((await evaluate(`window.studyflow.request('resume')`)).ok);
      await delay(200);
      assert((await evaluate(`window.studyflow.request('stop')`)).ok);
    }
    await evaluate("document.getElementById('nav-review').click();document.getElementById('daily-load').click()");
    let rows = [];
    for (let i = 0; i < 50; i++) {
      rows = await evaluate("Array.from(document.querySelectorAll('#daily-timeline tbody tr'),r=>r.textContent)");
      if (rows.length === 2) break;
      await delay(100);
    }
    assert.equal(rows.length, 2, 'Repeated sessions and identical titles must display only two daily rows');
    assert(rows.every(row => row.includes('Packaged smoke fixture')));
    assert(rows.some(row => row.includes('学习汇总')));
    assert(rows.some(row => row.includes('休息 / 暂停等汇总')));
    console.log('PASS: final exe daily timeline caps same-title tasks at two rows across repeated sessions and pauses');
  }
  if (testBuild) {
    const status = await evaluate("window.studyflow.diagnostics.request('status')");
    assert.equal(status.status.watchdog, true); assert.equal(status.status.writeFailures, 0);
    assert.equal(status.status.errors, 0);
    console.log('PASS: final test exe version, diagnostic self-test, watchdog, zero unexpected errors');
  }
  console.log('PASS: final StudyFlow.exe, sandboxed renderer, SQLite task write, bundled collector response, focus stop');
  console.log('Collector returned a named app:', state.value.focus.app !== null);
  if (process.argv.includes('--reminder')) {
    const configured = await evaluate(`window.studyflow.request('settings',{durationMinutes:1,idleMinutes:240,whitelist:[]})`);
    assert(configured.ok);
    await evaluate(`window.studyflow.request('start',{taskId:null})`);
    let reminderTarget;
    for (let i = 0; i < 30; i++) {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      reminderTarget = targets.find(t => t.type === 'page' && t.url.startsWith('data:text/html'));
      if (reminderTarget) break;
      await delay(200);
    }
    assert(reminderTarget, 'Final package must create a reminder for a real non-whitelisted app');
    await delay(300);
    const notified = await evaluate(`window.studyflow.request('snapshot')`);
    assert.equal(notified.value.focus.notification, 'sent');
    await evaluate(`window.studyflow.request('stop')`);
    const after = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    assert(!after.some(t => t.id === reminderTarget.id), 'Stop closes the packaged reminder');
    console.log('PASS: packaged native sampling -> focus guard -> centered reminder -> stop cleanup');
  }
  if (process.argv.includes('--abnormal-exit')) child.kill();
  else try { await send('Browser.close', {}); } catch { /* Closing the browser may close CDP first. */ }
  verificationPassed = true;
} catch (error) {
  console.error(stderr.slice(-2000)); throw error;
} finally {
  clearTimeout(watchdog);
  socket?.close();
  for (const item of pending.values()) clearTimeout(item.timer);
  await Promise.race([exited, delay(1500)]);
  if (child.exitCode === null) child.kill();
  if (testBuild && verificationPassed) {
    const runId = (await readFile(join(data, 'diagnostics', 'active-run.txt'), 'utf8')).trim();
    let exit;
    for (let i = 0; i < 70; i++) {
      const content = await readFile(join(data, 'diagnostics', `${runId}.watchdog.jsonl`), 'utf8');
      exit = content.trim().split('\n').map(line => JSON.parse(line)).find(event => event.event === 'parent_exit');
      if (exit) break;
      await delay(100);
    }
    assert(exit, 'Watchdog records final exe exit before verifier ends');
    assert.equal(exit.clean, !process.argv.includes('--abnormal-exit'), 'Watchdog distinguishes clean and forced exit');
    console.log(`PASS: external watchdog recorded final exe ${exit.clean ? 'clean' : 'abnormal'} exit`);
  }
}
