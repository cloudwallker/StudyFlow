import { expect, it } from 'vitest';
import { DesktopStudy } from '../src/desktop/study';
import { StudyStore } from '../src/desktop/store';
import { DesktopService } from '../src/desktop/service';
import { prepareQuit } from '../src/desktop/lifecycle';
import { ContinuousActivity } from '../src/desktop/continuous';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

it('persists timer preferences and rejects invalid preference updates atomically', () => {
  const store = new StudyStore(':memory:');
  try {
    const settings = { durationMinutes: 40, whitelist: [], allDayActivity: true, mode: 'pomodoro', idleMinutes: 2,
      policy: { workMinutes: 40, shortBreakMinutes: 7, longBreakMinutes: 20, roundsBeforeLongBreak: 3 } };
    store.updateSettings(settings);
    expect(store.snapshot().settings).toMatchObject(settings);
    expect(() => store.updateSettings({ ...settings, idleMinutes: 0 })).toThrow();
    expect(store.snapshot().settings).toMatchObject(settings);
  } finally { store.close(); }
});

it('reopens preferences and preserves data while migrating a v3 database with a backup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'continuous-migration-')); const path = join(dir, 'test.sqlite');
  let store = new StudyStore(path);
  try {
    store.createTask({ title: 'Migration fixture', projectId: null, estimateMinutes: 25 }); store.close();
    const db = new DatabaseSync(path);
    db.exec('DROP TABLE daily_plan_reminders; DROP TABLE daily_checkins; DROP TABLE task_details; DROP TABLE project_order; DROP TABLE imported_tasks; DROP TABLE import_batches; DROP TABLE ambient_activity; DROP INDEX activity_monotonic; DROP INDEX slices_monotonic; ALTER TABLE activity_intervals DROP COLUMN monotonicStart; ALTER TABLE settings DROP COLUMN preferences; PRAGMA user_version=3;'); db.close();
    store = new StudyStore(path);
    expect(store.snapshot().settings).toMatchObject({ allDayActivity: false, mode: 'countdown', idleMinutes: 5 });
    store.updateSettings({ mode: 'pomodoro', idleMinutes: 2, allDayActivity: true, policy: { workMinutes: 45, shortBreakMinutes: 8, longBreakMinutes: 18, roundsBeforeLongBreak: 3 } });
    store.close(); store = new StudyStore(path);
    expect(store.snapshot().settings).toMatchObject({ mode: 'pomodoro', idleMinutes: 2, allDayActivity: true, policy: { workMinutes: 45, shortBreakMinutes: 8, longBreakMinutes: 18, roundsBeforeLongBreak: 3 } });
    expect(store.snapshot().tasks[0]?.title).toBe('Migration fixture');
    expect(readdirSync(dir).filter(file => file.endsWith('.v3.sqlite'))).toHaveLength(1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

it('bounds independent sampling, retries failed saves, and reconstructs midnight without duplicates', async () => {
  let time = 0; let fail = false; let largest = 0;
  const store = new StudyStore(':memory:');
  const collector = new ContinuousActivity({ sample: async () => ({ status: 'ok', app: String(time), idleMs: 0 }) },
    { read: () => ({ monotonicMs: time, wallMs: Date.parse('2026-09-09T23:30:00Z') + time, utcOffsetMinutes: 0 }) }, () => 'ambient',
    cp => { if (fail) throw new Error('disk'); largest = Math.max(largest, cp.intervals.length); store.saveActivityCheckpoint(cp); });
  try {
    collector.configure(true, 1); await collector.sample();
    for (let n = 0; n < 1200; n++) { time += 3000; await collector.sample(); }
    expect(largest).toBeLessThan(100);
    fail = true; time += 30000; await collector.sample(); expect(collector.flush()).toBe(false);
    expect(() => collector.configure(false, 1)).toThrow();
    fail = false; expect(collector.flush()).toBe(true); collector.configure(false, 1);
    expect(store.daily('2026-09-09').apps.reduce((sum, a) => sum + a.durationMs, 0)).toBe(1800000);
    expect(store.daily('2026-09-10').apps.reduce((sum, a) => sum + a.durationMs, 0)).toBe(1830000);
  } finally { store.close(); }
});

it('shares the sampler, avoids overlap with session activity, and flushes safely before deletion and quit', async () => {
  let time = 0; let id = 0; let calls = 0; let fail = false;
  const store = new StudyStore(':memory:');
  store.updateSettings({ allDayActivity: true, recordAppActivity: true, mode: 'stopwatch' });
  const study = new DesktopStudy({ clock: { read: () => ({ monotonicMs: time, wallMs: Date.parse('2026-09-10T00:00:00Z') + time, utcOffsetMinutes: 0 }) },
    makeId: () => String(++id), sampler: { sample: async () => { calls++; return { status: 'ok', app: 'code.exe', idleMs: 0 }; } },
    notify: async () => {}, dismiss: () => {}, credit: () => {}, checkpoint: cp => store.saveCheckpoint(cp),
    activityCheckpoint: cp => { if (fail) throw new Error('disk'); store.saveActivityCheckpoint(cp); }, settings: store.snapshot().settings });
  const service = new DesktopService(store, study);
  try {
    await study.tick(); time = 30000; await study.tick(); service.execute('start', { taskId: null });
    await study.tick(); time = 60000; await study.tick(); service.execute('stop');
    expect(calls).toBe(4);
    expect(store.daily('2026-09-10').apps[0]?.durationMs).toBe(60000);
    expect(store.daily('2026-09-10').effectiveMs).toBe(30000);
    expect(() => service.execute('deleteHistory', { date: '2026-09-10' })).toThrow(/全天/);
    fail = true; expect(prepareQuit(study)).toBe(false);
    fail = false; service.execute('settings', { allDayActivity: false });
    service.execute('deleteHistory', { date: '2026-09-10' });
    time = 90000; await study.tick(); expect(prepareQuit(study)).toBe(true);
    expect(store.daily('2026-09-10').activities).toEqual([]);
  } finally { store.close(); }
});

it('marks even a short suspend without intervening polls unknown', async () => {
  let time = 0;
  const store = new StudyStore(':memory:');
  const collector = new ContinuousActivity({ sample: async () => ({ status: 'ok', app: 'code.exe', idleMs: 0 }) },
    { read: () => ({ monotonicMs: time, wallMs: Date.parse('2026-09-10T00:00:00Z') + time, utcOffsetMinutes: 0 }) }, () => 'suspend', cp => store.saveActivityCheckpoint(cp));
  try {
    collector.configure(true, 1); await collector.sample();
    collector.setSuspended(true); time = 30000; collector.setSuspended(false); await collector.sample();
    expect(store.daily('2026-09-10').activities).toMatchObject([{ state: 'unknown', app: null }]);
    expect(store.daily('2026-09-10').apps).toEqual([]);
  } finally { store.close(); }
});

it('records all-day activity without a timer, includes AFK and unknown, and never credits tasks', async () => {
  let time = 0; let idleMs = 0; let failed = false; let id = 0;
  const store = new StudyStore(':memory:');
  store.updateSettings({ durationMinutes: 25, whitelist: [], allDayActivity: true, idleMinutes: 1 });
  const study = new DesktopStudy({ clock: { read: () => ({ wallMs: Date.parse('2026-09-10T00:00:00Z') + time, monotonicMs: time, utcOffsetMinutes: 0 }) },
    makeId: () => String(++id), sampler: { sample: async () => { if (failed) throw new Error('unavailable'); return { status: 'ok', app: 'code.exe', idleMs }; } },
    notify: async () => { throw new Error('idle collection must not notify'); }, dismiss: () => {}, credit: () => {},
    activityCheckpoint: cp => store.saveActivityCheckpoint(cp), settings: store.snapshot().settings,
  });
  try {
    await study.tick(); time = 30000; await study.tick();
    expect(store.daily('2026-09-10').apps).toMatchObject([{ app: 'code.exe', durationMs: 30000 }]);
    idleMs = 60000; time = 60000; await study.tick();
    failed = true; time = 90000; await study.tick();
    const daily = store.daily('2026-09-10');
    expect(daily.activities.map(a => a.state)).toEqual(['afk', 'unknown']);
    expect(daily.effectiveMs).toBe(0);
    expect(study.state().running).toBe(false);
  } finally { store.close(); }
});

it('bounds successful long-session checkpoints while preserving cumulative learning and AFK corrections', async () => {
  let time = 0; let id = 0; let largest = 0;
  const store = new StudyStore(':memory:');
  const task = store.createTask({ title: 'long fixture', projectId: null, estimateMinutes: 25 });
  const study = new DesktopStudy({ clock: { read: () => ({ wallMs: Date.parse('2026-09-10T00:00:00Z') + time, monotonicMs: time, utcOffsetMinutes: 0 }) },
    makeId: () => String(++id), sampler: { sample: async () => ({ status: 'ok', app: String(time), idleMs: 0 }) },
    notify: async () => {}, dismiss: () => {}, credit: () => {},
    checkpoint: cp => { largest = Math.max(largest, cp.snapshot.slices.length); store.saveCheckpoint(cp); },
  });
  try {
    study.start(task.id, 25, [], { mode: 'stopwatch', idleMinutes: 1 }); await study.tick();
    for (let n = 0; n < 1200; n++) { time += 3000; await study.tick(); }
    study.stop();
    expect(largest).toBeLessThan(100);
    expect(study.state().learning?.effectiveMs).toBe(3600000);
    expect(store.snapshot().tasks[0]?.spentMs).toBe(3600000);
    expect(store.daily('2026-09-10').effectiveMs).toBe(3600000);
  } finally { store.close(); }
});
