import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
const require = createRequire(import.meta.url);
await mkdir('.cache/management-smoke', { recursive: true });
const root = await mkdtemp(resolve('.cache/management-smoke/run-'));
const build = resolve(process.argv[2] ?? 'dist/desktop');
const entry = join(root, 'driver.cjs');
await writeFile(entry, `
const {app,BrowserWindow}=require('electron');
const {writeFileSync}=require('node:fs'); const assert=require('node:assert/strict');
require(${JSON.stringify(join(build, 'main.cjs'))});
const delay=ms=>new Promise(r=>setTimeout(r,ms)); const watchdog=setTimeout(()=>app.exit(1),35000);
(async()=>{await app.whenReady();let win;
for(let i=0;i<100;i++){win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('index.html'));if(win&&!win.webContents.isLoading())break;await delay(100)}
assert(win); win.webContents.setBackgroundThrottling(false); await delay(300);
const run=s=>win.webContents.executeJavaScript(s);
const request=async(c,p)=>{const r=await run('window.studyflow.request('+JSON.stringify(c)+','+JSON.stringify(p??null)+')');assert(r.ok,r.error);return r.value};
const until=async s=>{for(let i=0;i<100;i++){if(await run(s))return;await delay(60)}throw Error('UI condition: '+s)};
if(process.env.STUDYFLOW_MANAGEMENT_STAGE==='write'){
let data=await request('createProject',{name:'示例管理项目'});const project=data.projects[0];
const imported={schemaVersion:1,tasks:[{taskKey:'management-fixture',title:'示例阅读',project:project.name,estimateMinutes:20}],plans:[]};
let preview=await request('previewImport',{content:JSON.stringify(imported)});
data=await request('confirmImport',{token:preview.importPreview.token}); const task=data.tasks[0];
await until("document.querySelector('[data-edit-task]')!==null");
await run("document.querySelector('[data-edit-task]').click();document.getElementById('edit-task-title').value='示例新标题';document.getElementById('edit-task-tags').value='阅读,考试';document.getElementById('edit-task-form').requestSubmit()");
await until("document.getElementById('tasks').textContent.includes('示例新标题')");
data=await request('snapshot');assert.deepEqual(data.tasks[0].tags,['阅读','考试']);
imported.tasks[0].title='示例新标题'; imported.tasks[0].estimateMinutes=30;
preview=await request('previewImport',{content:JSON.stringify(imported)});assert(preview.importPreview.errors.length>0);
preview=await request('previewImport',{content:JSON.stringify(imported),choices:{projectIds:{},replaceDates:[],updateTaskKeys:['management-fixture']}});
assert.equal(preview.importPreview.errors.length,0);assert.equal(preview.importPreview.taskUpdates[0].before.title,'示例新标题');
data=await request('confirmImport',{token:preview.importPreview.token});assert.equal(data.tasks[0].id,task.id);assert.equal(data.tasks[0].estimateMinutes,30);assert.deepEqual(data.tasks[0].tags,['阅读','考试']);
await run("document.getElementById('task-search').value='不匹配';document.getElementById('task-search').dispatchEvent(new Event('input'))");
assert.equal(await run("document.querySelectorAll('#tasks [data-task-id]').length"),0);
await run("document.getElementById('task-search').value='';document.getElementById('task-search').dispatchEvent(new Event('input'))");
await request('repeatPlan',{id:task.id,startDate:'2026-09-10',endDate:'2026-09-12',everyDays:1,minutes:20});
await request('checkIn',{id:task.id,date:'2026-09-10',done:true});
assert((await request('daily',{date:'2026-09-10'})).daily.comparison[0].done);
assert(!(await request('daily',{date:'2026-09-11'})).daily.comparison[0].done);
await request('movePlan',{id:task.id,from:'2026-09-11',to:'2026-09-13'});
await request('manageCategories',{entries:[{app:'fixture.exe',category:'学习'}],remove:[]});
await request('archiveTask',{id:task.id,archived:true}); data=await request('snapshot');assert.equal(data.tasks.length,0);assert.equal(data.archivedTasks.length,1);
await until("document.querySelector('[data-restore-task]')!==null");await run("document.querySelector('[data-restore-task]').click()");await until("document.querySelector('[data-edit-task]')!==null");
win.setSize(1180,1000);await run("document.querySelector('.management-panel').open=true;window.scrollTo(0,0)");await delay(100);
writeFileSync(${JSON.stringify(resolve('dist/management-preview.png'))},(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
console.log('PASS: packaged UI edit/search/restore, independent checkins, repeated plans, date move, categories');
}else{const data=await request('snapshot');assert.equal(data.tasks[0].title,'示例新标题');assert.equal(data.checkins.length,1);assert(data.plans.some(p=>p.date==='2026-09-13'));assert.equal(data.categories[0].category,'学习');console.log('PASS: real Electron restart retains task metadata, plans, checkins and classification')}
clearTimeout(watchdog);app.quit();})().catch(e=>{console.error(e);clearTimeout(watchdog);app.exit(1)});
`);
for (const stage of ['write', 'read']) {
  const env = { ...process.env, STUDYFLOW_DATA_DIR: join(root, 'data'), STUDYFLOW_HIDDEN: '1', STUDYFLOW_MANAGEMENT_STAGE: stage }; delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((done, reject) => {
    const child = spawn(require('electron'), [entry], { env, windowsHide: true, stdio: 'inherit' });
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Management verification timed out')); }, 40000);
    child.on('error', e => { clearTimeout(timeout); reject(e); });
    child.on('exit', code => { clearTimeout(timeout); code === 0 ? done() : reject(new Error('Management verification failed: ' + code)); });
  });
}
