import { packager } from '@electron/packager';
import { readdir, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const version = '44.3.0';
const testBuild = process.argv.includes('--test-build');
const buildDirectory = resolve(testBuild ? 'dist/desktop-test' : 'dist/desktop');
const info = JSON.parse(await readFile(join(buildDirectory, 'build-info.json'), 'utf8'));
if (info.test !== testBuild) throw new Error('Build/package mode mismatch');
const filename = `electron-v${version}-win32-x64.zip`;
const cache = resolve('.cache/electron');
let electronZipDir;
for (const entry of await readdir(cache, { withFileTypes: true })) {
  if (entry.isDirectory() && (await readdir(join(cache, entry.name))).includes(filename)) electronZipDir = join(cache, entry.name);
}
if (!electronZipDir) throw new Error('Electron cache missing. Run install:electron with electron_config_cache pointing to .cache/electron.');
const checksums = JSON.parse(await readFile('node_modules/electron/checksums.json', 'utf8'));
const hash = createHash('sha256').update(await readFile(join(electronZipDir, filename))).digest('hex');
if (checksums[filename] !== hash) throw new Error('Electron archive checksum mismatch');
const out = resolve('release', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(out, { recursive: true });
const paths = await packager({ dir: buildDirectory, out, name: testBuild ? 'StudyFlow-Test' : 'StudyFlow', executableName: testBuild ? 'StudyFlow-Test' : 'StudyFlow',
  platform: 'win32', arch: 'x64', electronVersion: version, electronZipDir, asar: false,
  overwrite: false, prune: false, appVersion: info.version, buildVersion: info.version.split('-')[0],
  win32metadata: { CompanyName: 'StudyFlow', ProductName: 'StudyFlow', FileDescription: 'StudyFlow local study and focus' } });
await writeFile(join(paths[0], '开始使用.txt'), `双击 ${testBuild ? 'StudyFlow-Test' : 'StudyFlow'}.exe 启动。请保留同目录全部文件。\r\n版本 ${info.version}，构建 ${info.id}。\r\n不需要安装 Super Productivity、ActivityWatch、Node 或 Python。\r\n关闭窗口进入系统托盘；右键托盘选择退出。\r\n数据保存在 %APPDATA%\\${testBuild ? 'StudyFlow-Test' : 'StudyFlow'}\\studyflow.sqlite。\r\n活动历史默认关闭，用户可开启会话或全天记录；不保存窗口标题。\r\n真实锁屏、休眠恢复、跨机兼容性与 8 小时运行须按随包清单验收。\r\n第三方许可和改造源码位于 resources\\app\\third-party。\r\n${testBuild ? '诊断日志仅在本地保存，界面顶部可自检、标记问题、导出诊断 ZIP；诊断包不含任务数据库。\r\n' : ''}`);
await writeFile(testBuild ? 'dist/test-package-path.txt' : 'dist/desktop-package-path.txt', paths[0]);
if (!testBuild) execFileSync(process.execPath, ['scripts/local-delivery.mjs', 'prepare', '--package', paths[0], '--version', info.version, '--build-id', info.id], { windowsHide: true, stdio: 'inherit' });
console.log(`Windows portable package: ${paths[0]}`);
