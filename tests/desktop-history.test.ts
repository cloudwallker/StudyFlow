import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { StudyStore } from '../src/desktop/store';
import { TimerService } from '../src/timer/timer-service';
import { migrateV2 } from '../src/desktop/migration';

const dirs: string[] = []; const stores: StudyStore[] = [];
afterEach(() => { stores.splice(0).forEach(s => s.close()); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
function path() { const dir = mkdtempSync(join(tmpdir(), 'study-history-')); dirs.push(dir); return join(dir, 'test.sqlite'); }
function open(file = path()) { const s = new StudyStore(file); stores.push(s); return s; }
function v1(file: string, conflict = false) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,projectId TEXT,title TEXT,done INTEGER,estimateMinutes INTEGER,spentMs INTEGER);
    CREATE TABLE settings(id INTEGER PRIMARY KEY,durationMinutes INTEGER,whitelist TEXT);
    INSERT INTO settings VALUES(1,25,'[]'); INSERT INTO tasks VALUES('old',NULL,'fiction',0,25,1234);
    PRAGMA user_version=1; ${conflict ? 'CREATE TABLE timer_slices(id TEXT);' : ''}`); db.close();
}
function checkpoint(taskId: string | null) {
  let t = 0; let id = 0;
  const timer = new TimerService({ read: () => ({ wallMs: Date.UTC(2026, 8, 9, 15, 59, 50) + t, monotonicMs: t, utcOffsetMinutes: 480 }) }, () => `id-${++id}`);
  timer.start({ mode: 'stopwatch', taskId }); t = 20000; timer.tick();
  return { revision: 1, snapshot: timer.snapshot(), intervals: [{ startMs: 0, endMs: t, state: 'active' as const, app: 'code.exe' }] };
}
it('backs up v1 with a verified hash before migrating without losing task totals', () => {
  const file = path(); v1(file); const s = open(file);
  expect(s.snapshot().tasks[0]?.spentMs).toBe(1234);
  expect(s.snapshot().settings.recordAppActivity).toBe(false);
  const dir = join(file, '..'); const backup = readdirSync(dir).find(n => n.endsWith('.v1.sqlite'))!;
  expect(backup).toBeTruthy();
  expect(readFileSync(join(dir, backup + '.sha256'), 'utf8').trim()).toBe(createHash('sha256').update(readFileSync(join(dir, backup))).digest('hex'));
  const db = new DatabaseSync(join(dir, backup)); expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(1); db.close();
});
it('rolls back all DDL on a real migration conflict', () => {
  const file = path(); v1(file, true); expect(() => open(file)).toThrow();
  const db = new DatabaseSync(file);
  expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name='sessions'").get()).toBeUndefined();
  expect(db.prepare('SELECT spentMs FROM tasks').get()?.spentMs).toBe(1234); db.close();
});
it('atomically checkpoints, deduplicates retries, corrects AFK and splits local midnight', () => {
  const s = open(); const task = s.createTask({ title: 'fiction', projectId: null, estimateMinutes: 25 }); const cp = checkpoint(task.id);
  s.saveCheckpoint(cp); s.saveCheckpoint(cp);
  expect(s.snapshot().tasks[0]?.spentMs).toBe(20000);
  expect(s.history('2026-09-09').slices[0]?.durationMs).toBe(10000);
  expect(s.history('2026-09-10').slices[0]?.durationMs).toBe(10000);
  expect(s.history('2026-09-09').activities).toEqual([]);
  s.saveCheckpoint({ ...cp, revision: 2, intervals: [{ ...cp.intervals[0]!, state: 'afk', app: null }] });
  expect(s.snapshot().tasks[0]?.spentMs).toBe(0);
  expect(() => s.saveCheckpoint(cp)).toThrow();
  expect(() => s.saveCheckpoint({ ...cp, revision: 2 })).toThrow();
});
it('recovers only confirmed history, closes interrupted sessions and deletes one date without changing totals', () => {
  const file = path(); const s = open(file); const task = s.createTask({ title: 'fiction', projectId: null, estimateMinutes: 25 });
  s.updateSettings({ durationMinutes: 25, whitelist: [], recordAppActivity: true });
  const cp = checkpoint(task.id); s.saveCheckpoint(cp); s.close();
  const again = open(file);
  expect(again.history('2026-09-09').activities[0]?.app).toBe('code.exe');
  expect(again.history('2026-09-09').sessions[0]?.status).toBe('interrupted');
  expect(again.snapshot().tasks[0]?.spentMs).toBe(20000);
  again.saveReview('2026-09-09', 'fictional review');
  again.deleteHistory('2026-09-09');
  expect(again.history('2026-09-09')).toMatchObject({ slices: [], activities: [], review: null });
  expect(again.history('2026-09-10').slices).toHaveLength(1);
  expect(again.snapshot().tasks[0]?.spentMs).toBe(20000);
  expect(() => again.saveCheckpoint({ ...cp, revision: 2 })).toThrow();
  again.saveCheckpoint(cp);
  expect(again.history('2026-09-09').slices).toEqual([]);
  expect(() => again.deleteHistory('2026-02-30')).toThrow();
});

it('rolls back both history and task credit if a slice insert fails after the task update', () => {
  const file = path(); const s = open(file); const task = s.createTask({ title: 'fiction', projectId: null, estimateMinutes: 25 });
  const cp = checkpoint(task.id); s.saveCheckpoint(cp);
  const db = new DatabaseSync(file);
  db.exec("CREATE TRIGGER reject_slice BEFORE INSERT ON timer_slices BEGIN SELECT RAISE(ABORT,'disk simulation'); END;");
  const corrected = { ...cp, revision: 2, intervals: [{ ...cp.intervals[0]!, state: 'afk' as const, app: null }] };
  expect(() => s.saveCheckpoint(corrected)).toThrow();
  expect(s.snapshot().tasks[0]?.spentMs).toBe(20000);
  expect(s.history('2026-09-09').slices[0]?.effectiveMs).toBe(10000);
  db.exec('DROP TRIGGER reject_slice'); db.close();
  s.saveCheckpoint(corrected); expect(s.snapshot().tasks[0]?.spentMs).toBe(0);
});

it('leaves v1 unchanged if the backup destination cannot be written', () => {
  const file = path(); v1(file); const db = new DatabaseSync(file);
  try {
    expect(() => migrateV2(db, join(file, 'missing', 'backup'), true)).toThrow();
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='sessions'").get()).toBeUndefined();
  } finally { db.close(); }
});
it('does not migrate when backup cannot obtain a consistent database lock', () => {
  const file = path(); v1(file); const lock = new DatabaseSync(file); lock.exec('BEGIN EXCLUSIVE');
  try { expect(() => open(file)).toThrow(); }
  finally { lock.exec('ROLLBACK'); lock.close(); }
  const db = new DatabaseSync(file); expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(1); db.close();
});
it('rejects overlapping intervals and blocks deletion of an open session', () => {
  const s = open(); const cp = checkpoint(null);
  expect(() => s.saveCheckpoint({ ...cp, intervals: [...cp.intervals, ...cp.intervals] })).toThrow();
  s.saveCheckpoint(cp); expect(() => s.deleteHistory('2026-09-09')).toThrow();
  expect(s.history('2026-09-09').slices).toHaveLength(1);
});

it('recovers committed data after abrupt child exit and discards an uncommitted task update', async () => {
  const { buildSync } = await import('esbuild');
  const { spawnSync } = await import('node:child_process');
  const file = path(); const entry = join(file, '..', 'store.cjs');
  buildSync({ entryPoints: ['src/desktop/store.ts'], outfile: entry, platform: 'node', format: 'cjs', bundle: true });
  const cp = checkpoint('crash-task');
  const result = spawnSync(process.execPath, ['-e', `
    const { StudyStore } = require(${JSON.stringify(entry)});
    const { DatabaseSync } = require('node:sqlite');
    const s = new StudyStore(${JSON.stringify(file)});
    const task = s.createTask({ title: 'crash fixture', projectId: null, estimateMinutes: 25 });
    const cp = ${JSON.stringify(cp)}; cp.snapshot.state.taskId = task.id;
    cp.snapshot.slices.forEach(slice => slice.taskId = task.id);
    s.saveCheckpoint(cp);
    const db = new DatabaseSync(${JSON.stringify(file)});
    db.exec('BEGIN IMMEDIATE; UPDATE tasks SET spentMs=999999;');
    process.exit(17);
  `], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(17);
  const s = open(file); expect(s.recoveredSessions).toBe(1);
  expect(s.snapshot().tasks[0]?.spentMs).toBe(20000);
  expect(s.history('2026-09-10').slices[0]?.durationMs).toBe(10000);
  s.close(); const again = open(file); expect(again.recoveredSessions).toBe(0);
  expect(again.snapshot().tasks[0]?.spentMs).toBe(20000);
});
it('includes committed WAL data in the v1 backup', () => {
  const file = path(); v1(file);
  const writer = new DatabaseSync(file); writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; UPDATE tasks SET spentMs=9876;');
  try {
    const s = open(file); expect(s.snapshot().tasks[0]?.spentMs).toBe(9876);
    const dir = join(file, '..'); const backup = readdirSync(dir).find(n => n.endsWith('.v1.sqlite'))!;
    const db = new DatabaseSync(join(dir, backup));
    expect(db.prepare('SELECT spentMs FROM tasks').get()?.spentMs).toBe(9876); db.close();
  } finally { writer.close(); }
});

it('merges one continuous application observation across timer ticks without crossing a date', () => {
  const s = open(); s.updateSettings({ durationMinutes: 25, whitelist: [], recordAppActivity: true });
  const cp = checkpoint(null); const original = cp.snapshot.slices[0]!;
  const start = original.startedAt - 3600000;
  cp.snapshot.slices = [
    { ...original, startedAt: start, endedAt: start + 10000, durationMs: 10000, monotonicEndMs: 10000 },
    { ...original, id: 'second', startedAt: start + 10000, endedAt: start + 20000, durationMs: 10000, monotonicStartMs: 10000 },
  ];
  s.saveCheckpoint(cp);
  expect(s.history('2026-09-09').activities).toHaveLength(1);
  expect(s.history('2026-09-09').activities[0]).toMatchObject({ startedAt: start, endedAt: start + 20000 });
});
