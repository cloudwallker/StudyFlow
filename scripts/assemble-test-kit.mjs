import { readFile, writeFile, mkdir, copyFile, readdir } from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const directory = (await readFile('dist/test-package-path.txt', 'utf8')).trim();
if (!directory.startsWith(resolve('release') + '\\')) throw new Error('Unexpected package directory');
await copyFile('docs/eight-hour-test-checklist.md', join(directory, '8小时测试清单.md'));
await writeFile(join(directory, '问题记录表.tsv'), '\uFEFF时间\t版本\t问题类别\t操作步骤\t预期结果\t实际结果\t能否重现\t问题标记时间\r\n', 'utf8');
const fixtures = join(directory, '测试文件'); await mkdir(fixtures, { recursive: true });
const plan = JSON.parse(await readFile('examples/studyflow-plan.json', 'utf8'));
const today = new Date(); const date = [today.getFullYear(), String(today.getMonth() + 1).padStart(2, '0'), String(today.getDate()).padStart(2, '0')].join('-');
for (const item of plan.plans) item.date = date;
await writeFile(join(fixtures, '正常计划.json'), JSON.stringify(plan, null, 2));
await writeFile(join(fixtures, '错误计划.json'), JSON.stringify({ schemaVersion: 1, tasks: [{ taskKey: 'invalid-fixture', title: '虚构无效任务', estimateMinutes: -1 }], plans: [] }, null, 2));
const checksums = [];
async function visit(folder, relative = '') {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name); const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await visit(path, name);
    else if (entry.isFile() && name !== 'SHA256SUMS.txt') checksums.push(`${createHash('sha256').update(await readFile(path)).digest('hex')}  ${name}`);
  }
}
await visit(directory); await writeFile(join(directory, 'SHA256SUMS.txt'), checksums.sort().join('\n') + '\n');
const archive = join(dirname(directory), 'StudyFlow-0.3.0-test.1-win-x64.zip');
const quote = text => `'${text.replaceAll("'", "''")}'`;
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Compress-Archive -LiteralPath ${quote(directory)} -DestinationPath ${quote(archive)} -CompressionLevel Optimal -Force`], { windowsHide: true, stdio: 'inherit' });
const sha = createHash('sha256').update(await readFile(archive)).digest('hex');
await writeFile(`${archive}.sha256`, `${sha}  ${basename(archive)}\n`);
await writeFile('dist/test-kit-path.txt', archive);
console.log(`Test kit: ${archive}\nSHA-256: ${sha}`);
