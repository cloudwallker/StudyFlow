import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, unlinkSync, utimesSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

assert.equal(process.platform, 'win32', 'Windows integration test required');
const source = path.resolve('native/StudyFlowWatchdog.cs');
assert.ok(existsSync(source), 'Independent watchdog implementation is required');
const directory = path.resolve('.cache/watchdog-test', randomUUID());
mkdirSync(directory, { recursive: true });
const executable = path.join(directory, 'StudyFlowWatchdog.exe');
const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
const compiled = spawnSync(compiler, ['/nologo', '/target:winexe', '/r:System.Web.Extensions.dll', `/out:${executable}`, source], { windowsHide: true, encoding: 'utf8' });
assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);

async function until(predicate, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(100);
  }
  assert.fail('Timed out waiting for watchdog evidence');
}

async function scenario(clean, heartbeatTest = false, markerContent = clean ? 'clean' : null) {
  const runId = randomUUID();
  const heartbeat = path.join(directory, `${runId}.heartbeat`);
  const log = path.join(directory, `${runId}.watchdog.jsonl`);
  const expectedExitCode = clean ? 0 : 23;
  const parent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000); process.stdin.once("data", () => process.exit(Number(process.argv[1])));', String(expectedExitCode)], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  writeFileSync(heartbeat, '');
  // Existing full log must rotate instead of allowing unbounded growth.
  if (clean) writeFileSync(log, ' '.repeat(1024 * 1024));
  const watchdog = spawn(executable, [String(parent.pid), directory, runId], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  watchdog.stdout.on('data', value => { output += value; });
  watchdog.stderr.on('data', value => { output += value; });
  const records = () => {
    if (!existsSync(log)) return [];
    const text = readFileSync(log, 'utf8').trim();
    return text ? text.split('\n').map(line => JSON.parse(line)) : [];
  };
  try {
    await until(() => records().some(row => row.event === 'watchdog_start'));
    if (heartbeatTest) {
      await until(() => records().some(row => row.event === 'heartbeat_stale'), 43000);
      await delay(5500);
      assert.equal(records().filter(row => row.event === 'heartbeat_stale').length, 1);
      unlinkSync(heartbeat);
      await delay(5500);
      assert.equal(records().filter(row => row.event === 'heartbeat_recovered').length, 0, 'Missing heartbeat is not recovery');
      writeFileSync(heartbeat, '');
      await until(() => records().some(row => row.event === 'heartbeat_recovered'));
    }
    if (markerContent !== null) {
      const done = path.join(directory, `${runId}.done`);
      writeFileSync(done, markerContent);
      // Simulate clock rollback after process startup without changing machine time.
      if (clean) utimesSync(done, new Date('2000-01-01T00:00:00Z'), new Date('2000-01-01T00:00:00Z'));
    }
    parent.stdin.write('exit');
    await until(() => watchdog.exitCode !== null);
    assert.equal(watchdog.exitCode, 0);
    const exit = records().find(row => row.event === 'parent_exit');
    assert.equal(exit?.clean, clean);
    assert.equal(exit?.exitCode, expectedExitCode);
    assert.equal(output, '', 'Watchdog must not expose raw native output');
    assert.ok(statSync(log).size < 1024 * 1024);
    if (clean) assert.ok(existsSync(log + '.1'));
    for (const row of records()) {
      assert.ok(['watchdog_start', 'parent_exit', 'heartbeat_stale', 'heartbeat_recovered'].includes(row.event));
      assert.equal(JSON.stringify(row).includes(directory), false);
    }
  } finally {
    if (parent.exitCode === null) parent.kill();
    if (watchdog.exitCode === null) watchdog.kill();
  }
}

await scenario(true);
await scenario(false, false, '');
await scenario(false, false, 'unclean');
await scenario(false, true);
console.log('Watchdog verified: clock-independent clean exit, invalid marker rejection, abnormal parent exit, real 30-second stale/recovery, rotation, silent output and self-exit.');
