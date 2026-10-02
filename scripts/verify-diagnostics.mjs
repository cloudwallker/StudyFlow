import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
await mkdir('.cache/diagnostic-smoke', { recursive: true });
const root = await mkdtemp(resolve('.cache/diagnostic-smoke/run-'));
const entry = join(root, 'driver.cjs'); const archive = join(root, 'diagnostics.zip');
await mkdir(join(root, 'StudyFlow'), { recursive: true });
await writeFile(join(root, 'StudyFlow', 'sentinel.txt'), 'UNTOUCHED_NORMAL_DATA');
await writeFile(entry, `
const { app, BrowserWindow, dialog } = require('electron');
const { writeFileSync, readFileSync, existsSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const assert = require('node:assert/strict');
dialog.showSaveDialog = async () => ({canceled:false,filePath:${JSON.stringify(archive)}});
app.setPath('appData',${JSON.stringify(root)});
require(${JSON.stringify(resolve('dist/desktop-test/main.cjs'))});
assert.equal(app.getPath('userData'),${JSON.stringify(join(root, 'StudyFlow-Test'))},'Test build defaults to its separate data directory');
const delay = ms => new Promise(r => setTimeout(r,ms));
const timeout = setTimeout(()=>app.exit(2),30000);
(async()=>{
 await app.whenReady(); let win;
 for(let i=0;i<100;i++){
   win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('index.html'));
   if(win&&!win.webContents.isLoading())break; await delay(100);
 }
 assert(win); win.webContents.setBackgroundThrottling(false);
 const run=s=>win.webContents.executeJavaScript(s);
 const req=(command,payload)=>run('window.studyflow.request('+JSON.stringify(command)+','+JSON.stringify(payload??null)+')');
 const diag=(command,payload)=>run('window.studyflow.diagnostics.request('+JSON.stringify(command)+','+JSON.stringify(payload??null)+')');
 for(let i=0;i<50;i++){if(await run("!!document.getElementById('diagnostic-self-test')"))break; await delay(100);}
 assert.equal(await run('typeof require'),'undefined');
 if(process.env.STUDYFLOW_DIAGNOSTIC_STAGE==='write'){
   assert.equal((await req('snapshot')).value.tasks.length,0);
   assert((await req('createTask',{title:'DIAGNOSTIC_PRIVATE_TASK',projectId:null,estimateMinutes:1})).ok);
   assert.equal((await req('previewImport',{content:'invalid DIAGNOSTIC_PRIVATE_TASK'})).ok,false);
   assert.equal((await diag('status')).status.errors,0,'Expected input validation is not an application error');
   await run("document.getElementById('diagnostic-self-test').click()"); await delay(150);
   await run("document.getElementById('diagnostic-category').value='timer';document.getElementById('diagnostic-mark').click()"); await delay(150);
   assert.equal((await diag('status')).status.marks,1);
   assert.equal((await diag('mark',{category:'DIAGNOSTIC_PRIVATE_TASK'})).ok,false);
   // An actual renderer error traverses the preload listener and trusted IPC.
   await run("window.__observedErrors=0;window.addEventListener('error',()=>window.__observedErrors++)");
   await run("setTimeout(()=>{throw new Error('DIAGNOSTIC_PRIVATE_TASK')},0); true"); await delay(300);
   assert.equal(await run('window.__observedErrors'),1,'Main world observes the synthetic fault');
   assert.equal((await diag('status')).status.errors,1,'Renderer error must be captured');
   await req('settings',{durationMinutes:1,whitelist:[]});
   assert((await req('start',{taskId:null})).ok); await delay(6500);
   await req('stop');
   assert.equal((await diag('status')).status.watchdog,true);
   assert.equal((await diag('status')).status.writeFailures,0);
   assert((await diag('status')).status.lastSaveAt);
   await run("document.getElementById('diagnostic-export').click()");
   for(let i=0;i<100&&!existsSync(${JSON.stringify(archive)});i++)await delay(50);
   assert(existsSync(${JSON.stringify(archive)}),'UI export writes a ZIP');
   writeFileSync(${JSON.stringify(resolve('dist/diagnostic-preview.png'))},(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
 }else{
   assert.equal((await req('snapshot')).value.tasks.length,1);
   assert.equal((await diag('status')).status.warnings,0,'Clean restart must not be marked abnormal');
   const dir=join(app.getPath('userData'),'diagnostics');
   assert(readdirSync(dir).some(name=>name.endsWith('.done')));
   assert((await diag('export')).exported);
 }
 clearTimeout(timeout); app.quit();
})().catch(error=>{console.error(error);clearTimeout(timeout);app.exit(1);});
`);
for (const stage of ['write', 'read']) {
  const env = { ...process.env, STUDYFLOW_HIDDEN: '1', STUDYFLOW_DIAGNOSTIC_STAGE: stage }; delete env.ELECTRON_RUN_AS_NODE; delete env.STUDYFLOW_DATA_DIR;
  await new Promise((ok, fail) => {
    const child = spawn(require('electron'), ['--disable-gpu', entry], { env, windowsHide: true, stdio: 'inherit' });
    const timer = setTimeout(() => { child.kill(); fail(new Error('Diagnostic integration timeout')); }, 35000);
    child.on('error', error => { clearTimeout(timer); fail(error); });
    child.on('exit', code => { clearTimeout(timer); code === 0 ? ok() : fail(new Error(`Diagnostic integration failed: ${code}`)); });
  });
}
const files = unzipSync(await readFile(archive));
const content = Object.values(files).map(bytes => strFromU8(bytes)).join('\n');
assert.equal(await readFile(join(root, 'StudyFlow', 'sentinel.txt'), 'utf8'), 'UNTOUCHED_NORMAL_DATA');
assert(!content.includes('DIAGNOSTIC_PRIVATE_TASK'), 'No private task or error text in archive');
assert(Object.keys(files).every(name => !name.includes('sqlite') && !name.includes('heartbeat')), 'Only diagnostic records exported');
for (const event of ['self_test', 'issue_mark', 'renderer_error', 'command_rejected', 'health', 'save_ok', 'clean_exit']) assert(content.includes(event), `Missing ${event}`);
assert(Object.keys(files).some(name => name.endsWith('.watchdog.jsonl')));
console.log('PASS: diagnostic UI, controlled self-test, real renderer error, validation classification, sampler, watchdog, private-free ZIP export and clean restart');
console.log('Save dialog destination automated; screenshot: dist/diagnostic-preview.png');
