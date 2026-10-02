import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
const require = createRequire(import.meta.url);
const executable = require('electron');
const xlsx = process.argv.includes('--xlsx');
await mkdir('.cache/json-import-smoke', { recursive: true });
const root = await mkdtemp(resolve('.cache/json-import-smoke/run-'));
const fixture = join(root, xlsx ? 'fictional-plan.xlsx' : 'fictional-plan.json');
await copyFile(xlsx ? 'examples/studyflow-plan.xlsx' : 'examples/studyflow-plan.json', fixture);
const entry = join(root, 'driver.cjs');
await writeFile(entry, `
const { app, BrowserWindow } = require('electron');
const { writeFileSync, readFileSync } = require('node:fs');
const assert = require('node:assert/strict');
require(${JSON.stringify(resolve('dist/desktop/main.cjs'))});
const delay = ms => new Promise(r => setTimeout(r, ms));
const watchdog = setTimeout(() => app.exit(1), 25000);
(async () => {
  await app.whenReady(); let win;
  for (let i=0; i<100; i++) {
    win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('index.html'));
    if (win && !win.webContents.isLoading()) break;
    await delay(100);
  }
  assert(win); win.webContents.setBackgroundThrottling(false); await delay(300);
  const run = source => win.webContents.executeJavaScript(source);
  const request = (cmd,payload) => run('window.studyflow.request('+JSON.stringify(cmd)+','+JSON.stringify(payload ?? null)+')');
  const until = async source => { for(let i=0;i<100;i++){ if(await run(source)) return; await delay(50); } throw new Error('UI condition timed out: '+source); };
  if (process.env.STUDYFLOW_IMPORT_STAGE === 'write') {
    assert.equal((await request('snapshot')).value.tasks.length,0);
    assert.equal((await request('confirmImport',{token:'forged'})).ok,false);
    win.webContents.debugger.attach('1.3');
    const rootNode = (await win.webContents.debugger.sendCommand('DOM.getDocument')).root.nodeId;
    const nodeId = (await win.webContents.debugger.sendCommand('DOM.querySelector',{nodeId:rootNode,selector:'#import-file'})).nodeId;
    await run("document.querySelector('.task-entry').open=true;document.querySelector('.import-panel').open=true");
    await win.webContents.debugger.sendCommand('DOM.setFileInputFiles',{nodeId,files:[${JSON.stringify(fixture)}]});
    await until("!document.getElementById('import-confirm').disabled");
    assert.equal((await request('snapshot')).value.tasks.length,0);
    await run("document.getElementById('import-cancel').click()"); await delay(150);
    assert.equal((await request('snapshot')).value.tasks.length,0);
    await win.webContents.debugger.sendCommand('DOM.setFileInputFiles',{nodeId,files:[${JSON.stringify(fixture)}]});
    await until("!document.getElementById('import-confirm').disabled");
    win.setSize(1180,1200); await run("document.querySelector('.import-panel').scrollIntoView({block:'start'})"); await delay(250);
    writeFileSync(${JSON.stringify(resolve(xlsx ? 'dist/xlsx-import-preview.png' : 'dist/json-import-preview.png'))}, (await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    await run("document.getElementById('import-confirm').click()");
    await until("document.getElementById('import-status').textContent.includes('导入成功')");
    assert.equal((await request('snapshot')).value.tasks.length,2);
    const day = (await request('daily',{date:'2026-09-11'})).value.daily;
    assert.equal(day.plan.entries[0].minutes,45);
    await run("document.getElementById('daily-date').value='2026-09-11';document.getElementById('daily-load').click()");
    await until("document.getElementById('daily-comparison').textContent.includes('45')");
    // Validate the bundled download with Electron's actual download event.
    const download = new Promise((resolve,reject) => {
      win.webContents.session.once('will-download',(_event,item) => {
        item.setSavePath(${JSON.stringify(join(root, 'downloaded-template.json'))});
        item.once('done',(_event,state) => state==='completed'?resolve():reject(new Error('Template download failed')));
      });
    });
    await run("document.querySelector('.import-panel a').click()"); await download;
    assert.equal(JSON.parse(readFileSync(${JSON.stringify(join(root, 'downloaded-template.json'))},'utf8')).schemaVersion,1);
    win.webContents.debugger.detach();
    console.log('PASS: actual ${xlsx ? 'XLSX' : 'JSON'} file selection, preview/cancel, confirmed IPC transaction, task UI, daily plan and template download');
  } else {
    const snapshot = (await request('snapshot')).value; assert.equal(snapshot.tasks.length,2);
    assert.equal((await request('daily',{date:'2026-09-12'})).value.daily.plan.entries[0].minutes,20);
    const p = (await request('previewImport',{content:readFileSync(${JSON.stringify(resolve('examples/studyflow-plan.json'))},'utf8')})).value.importPreview;
    assert.equal(p.duplicate,true);
    assert.equal((await request('confirmImport',{token:p.token})).value.importResult,'duplicate');
    assert.equal((await request('snapshot')).value.tasks.length,2);
    console.log('PASS: real Electron restart retains tasks/plans and skips repeated import');
  }
  clearTimeout(watchdog); app.quit();
})().catch(error=>{ console.error(error); clearTimeout(watchdog); app.exit(1); });
`);
for (const stage of ['write', 'read']) {
  const env = { ...process.env, STUDYFLOW_DATA_DIR: join(root, 'data'), STUDYFLOW_HIDDEN: '1', STUDYFLOW_IMPORT_STAGE: stage };
  delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve, reject) => {
    const child = spawn(executable, ['--disable-gpu', entry], { env, windowsHide: true, stdio: 'inherit' });
    const watchdog = setTimeout(() => { child.kill(); reject(new Error('JSON import verification timed out')); }, 35000);
    child.on('error', error => { clearTimeout(watchdog); reject(error); });
    child.on('exit', code => { clearTimeout(watchdog); code === 0 ? resolve() : reject(new Error('JSON import verification failed: ' + code)); });
  });
}
console.log(`${xlsx ? 'XLSX' : 'JSON'} import desktop verification passed; screenshot saved in dist`);
