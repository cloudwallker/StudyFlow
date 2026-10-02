import { build } from 'esbuild';
import { mkdir, copyFile, writeFile, readFile, cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const testBuild = process.argv.includes('--test-build');
const info = { test: testBuild, version: testBuild ? '0.3.0-test.1' : '0.5.0-local', id: new Date().toISOString() };
const define = { __STUDYFLOW_BUILD__: JSON.stringify(info) };
const out = resolve(testBuild ? 'dist/desktop-test' : 'dist/desktop');
await mkdir(join(out, 'native'), { recursive: true });
if (process.platform !== 'win32') throw new Error('Windows collector must be built on Windows');
const compiler = join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
execFileSync(compiler, ['/nologo', '/optimize+', '/target:winexe',
  `/out:${join(out, 'native', 'StudyFlowSound.exe')}`, resolve('native/StudyFlowSound.cs')], { windowsHide: true, stdio: 'inherit' });
execFileSync(compiler, ['/nologo', '/optimize+', '/target:exe', '/reference:System.Web.Extensions.dll',
  `/out:${join(out, 'native', 'StudyFlowSampler.exe')}`, resolve('native/WindowSampler.cs')], { windowsHide: true, stdio: 'inherit' });
if (testBuild) execFileSync(compiler, ['/nologo', '/optimize+', '/target:winexe', '/reference:System.Web.Extensions.dll',
  `/out:${join(out, 'native', 'StudyFlowWatchdog.exe')}`, resolve('native/StudyFlowWatchdog.cs')], { windowsHide: true, stdio: 'inherit' });
for (const name of ['main', 'preload', 'plan-reminder-preload', 'focus-mini-preload']) await build({ entryPoints: [`src/desktop/${name}.ts`], outfile: join(out, `${name}.cjs`), define, bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron', 'node:sqlite'] });
await build({ entryPoints: ['src/desktop/renderer.ts'], outfile: join(out, 'renderer.js'), bundle: true, platform: 'browser', target: 'chrome140' });
await build({ entryPoints: ['src/desktop/focus-mini-renderer.ts'], outfile: join(out, 'focus-mini-renderer.js'), bundle: true, platform: 'browser', target: 'chrome140' });
for (const file of ['focus-mini.html', 'focus-mini.css']) await copyFile(join('desktop', file), join(out, file));
const html = await readFile('desktop/index.html', 'utf8');
await writeFile(join(out, 'index.html'), testBuild ? html.replace('0.5 · 本地完整版', '专属测试版 · 本地诊断') : html);
await copyFile('desktop/style.css', join(out, 'style.css'));
await copyFile('desktop/workspace.css', join(out, 'workspace.css'));
await copyFile('examples/studyflow-plan.json', join(out, 'studyflow-plan.json'));
await copyFile('examples/studyflow-plan.xlsx', join(out, 'studyflow-plan.xlsx'));
await cp('third-party', join(out, 'third-party'), { recursive: true });
await copyFile('node_modules/fflate/LICENSE', join(out, 'third-party', 'fflate-MIT-LICENSE.txt'));
await copyFile('native/WindowSampler.cs', join(out, 'third-party', 'WindowSampler.cs'));
await copyFile('src/desktop/vendor/task-time.ts', join(out, 'third-party', 'task-time.ts'));
await writeFile(join(out, 'build-info.json'), JSON.stringify(info, null, 2));
await writeFile(join(out, 'package.json'), JSON.stringify({ name: testBuild ? 'studyflow-test' : 'studyflow-desktop', productName: testBuild ? 'StudyFlow Test' : 'StudyFlow', version: info.version, main: 'main.cjs', private: true }));
console.log(`Desktop built: ${out}`);
