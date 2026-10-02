import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
const require = createRequire(import.meta.url);
await mkdir('.cache/workspace-smoke', { recursive: true });
const root = await mkdtemp(resolve('.cache/workspace-smoke/run-'));
const entry = join(root, 'verify.cjs');
await writeFile(entry, `
const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const assert = require('node:assert/strict');
require(${JSON.stringify(resolve('dist/desktop/main.cjs'))});
const delay = ms => new Promise(r => setTimeout(r, ms));
const watchdog = setTimeout(() => app.exit(1), 45000);
(async () => {
  await app.whenReady(); let win;
  for (let i=0;i<100;i++) { win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('index.html')); if(win&&!win.webContents.isLoading()) break; await delay(100); }
  assert(win); win.webContents.setBackgroundThrottling(false); await delay(500);
  const run = source => win.webContents.executeJavaScript(source);
  const request = (cmd,payload) => run('window.studyflow.request('+JSON.stringify(cmd)+','+JSON.stringify(payload??null)+')');
  const shot = async name => { await delay(200); writeFileSync(${JSON.stringify(resolve('dist'))}+'/'+name+'.png',(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG()); };
  await request('createProject',{name:'期末学习'});
  const project=(await request('snapshot')).value.projects[0];
  for (const title of ['阅读第三章：理解概念与例题','完成练习题，整理容易混淆的知识点','复习单词并回顾昨日笔记']) await request('createTask',{title,projectId:project.id,estimateMinutes:25});
  await delay(1200);
  await run("document.getElementById('task-view-all').click()");
  win.setSize(1366,768); await shot('workspace-preview');
  for (const [width,height,zoom] of [[1366,768,1],[1366,768,1.25],[1366,768,1.5],[1920,1080,1]]) {
    win.setSize(width,height); win.webContents.setZoomFactor(zoom); await delay(150);
    for (const nav of ['all-projects','nav-settings','nav-review']) {
      await run('document.getElementById('+JSON.stringify(nav)+').click()');
      assert(await run('document.documentElement.scrollWidth <= innerWidth+1'),'horizontal overflow at '+width+'/'+zoom+'/'+nav);
    }
  }
  win.setSize(1366,768); win.webContents.setZoomFactor(1);
  await run("document.getElementById('nav-settings').click();document.getElementById('whitelist').value='Draft.exe'");
  await shot('workspace-settings-preview');
  await run("document.getElementById('nav-review').click();document.getElementById('review-accomplished').value='未保存的学习总结'");
  await shot('workspace-review-preview');
  await run("document.getElementById('all-projects').click();document.getElementById('focus-toggle').click()");
  await delay(1200); assert((await request('snapshot')).value.focus.running);
  await run("document.getElementById('nav-settings').click()");
  assert.equal(await run("document.getElementById('whitelist').value"),'Draft.exe');
  assert.equal(await run("document.getElementById('active-session').hidden"),false);
  await run("document.getElementById('active-session').click()");
  assert.equal(await run("document.getElementById('workspace-page').hidden"),false);
  assert((await request('snapshot')).value.focus.running);
  await request('stop');
  await run("document.getElementById('quick-import').click()");
  assert.equal(await run('document.activeElement.id'),'import-file');
  clearTimeout(watchdog); console.log('PASS: workspace, drafts, live session navigation, import shortcut and 100/125/150 percent layouts'); app.quit();
})().catch(e=>{console.error(e);clearTimeout(watchdog);app.exit(1)});
`);
const env = { ...process.env, STUDYFLOW_DATA_DIR: join(root, 'data'), STUDYFLOW_HIDDEN: '1' };
delete env.ELECTRON_RUN_AS_NODE;
await new Promise((done, reject) => {
  const child = spawn(require('electron'), [entry], { env, windowsHide: true, stdio: 'inherit' });
  const timeout = setTimeout(() => { child.kill(); reject(new Error('Workspace verification timed out')); }, 55000);
  child.on('error', error => { clearTimeout(timeout); reject(error); });
  child.on('exit', code => { clearTimeout(timeout); code === 0 ? done() : reject(new Error('Workspace verification failed: '+code)); });
});
