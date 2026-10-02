import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
const archive = (await readFile('dist/test-kit-path.txt', 'utf8')).trim();
const bytes = await readFile(archive);
const sha = createHash('sha256').update(bytes).digest('hex');
assert.equal((await readFile(`${archive}.sha256`, 'utf8')).split(' ')[0], sha);
const entries = Object.fromEntries(Object.entries(unzipSync(bytes)).map(([name, value]) => [name.replaceAll('\\', '/'), value]));
const root = 'StudyFlow-Test-win32-x64/';
for (const name of Object.keys(entries)) {
  assert(name.startsWith(root) && !name.split('/').includes('..'), 'Unexpected archive path');
  assert(!/\.(sqlite|db|log)$/.test(name), 'No runtime database/log in delivery');
}
const manifest = strFromU8(entries[`${root}SHA256SUMS.txt`]);
let checked = 0;
const expected = new Set([`${root}SHA256SUMS.txt`]);
for (const line of manifest.trim().split('\n')) {
  const match = /^([0-9a-f]{64})  (.+)$/.exec(line); assert(match, 'Valid manifest');
  const name = root + match[2]; const data = entries[name]; assert(data, `Missing ${name}`);
  assert.equal(createHash('sha256').update(data).digest('hex'), match[1], `Hash ${name}`);
  expected.add(name); checked++;
}
assert(Object.keys(entries).every(name => name.endsWith('/') || expected.has(name)), 'All files covered by manifest');
for (const name of ['StudyFlow-Test.exe', '8小时测试清单.md', '问题记录表.tsv', '测试文件/正常计划.json', '测试文件/错误计划.json', 'resources/app/native/StudyFlowSampler.exe', 'resources/app/native/StudyFlowWatchdog.exe', 'resources/app/third-party/fflate-MIT-LICENSE.txt']) assert(entries[root + name], `Required ${name}`);
const info = JSON.parse(strFromU8(entries[root + 'resources/app/build-info.json']));
assert.equal(info.test, true); assert.equal(info.version, '0.3.0-test.1');
const finalDirectory = (await readFile('dist/test-package-path.txt', 'utf8')).trim();
for (const file of ['main.cjs', 'preload.cjs', 'renderer.js', 'native/StudyFlowWatchdog.exe']) {
  assert.deepEqual(entries[root + 'resources/app/' + file], new Uint8Array(await readFile(join(finalDirectory, 'resources/app', file))), 'ZIP equals verified directory');
  assert.deepEqual(entries[root + 'resources/app/' + file], new Uint8Array(await readFile(join('dist/desktop-test', file))), 'ZIP equals latest build');
}
console.log(`PASS: ZIP SHA-256, ${checked} file hashes, materials, native binaries, license, current build identity, no database/logs`);
console.log(`Size: ${(bytes.length / 1024 / 1024).toFixed(1)} MiB\nSHA-256: ${sha}\nBuild: ${info.id}`);
