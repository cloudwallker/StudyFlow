import { expect, it } from 'vitest';
import { StudyStore } from '../src/desktop/store';
import { TimerService } from '../src/timer/timer-service';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type { TimerSlice } from '../src/timer/contracts';

it.each<{ name: string; first?: Partial<TimerSlice>; second?: Partial<TimerSlice> }>([
  { name: 'phase completion', first: { reason: 'phase-end' } },
  { name: 'instant pause and resume', first: { reason: 'pause' } },
  { name: 'rest', second: { kind: 'break', phase: 'short-break' } },
  { name: 'micro rest', second: { kind: 'break', microBreak: true } },
  { name: 'offset change', second: { utcOffsetMinutes: 60 } },
  { name: 'clock discontinuity', first: { endedAt: null, reason: 'clock-change' } },
  { name: 'wall time gap', second: { startedAt: Date.UTC(2026, 8, 10) + 2000, endedAt: Date.UTC(2026, 8, 10) + 3000 } },
  { name: 'monotonic gap', second: { monotonicStartMs: 2000, monotonicEndMs: 3000 } },
])('does not merge across $name', ({ first, second }) => {
  const s = new StudyStore(':memory:');
  try {
    let time = 0; let id = 0;
    const timer = new TimerService({ read: () => ({ wallMs: Date.UTC(2026, 8, 10) + time, monotonicMs: time, utcOffsetMinutes: 0 }) }, () => `edge-${++id}`);
    timer.start({ mode: 'stopwatch', taskId: null }); time = 1000; timer.tick(); time = 2000; timer.stop();
    const snapshot = timer.snapshot();
    Object.assign(snapshot.slices[0]!, first); Object.assign(snapshot.slices[1]!, second);
    s.saveCheckpoint({ revision: 1, snapshot, intervals: [] });
    expect(s.daily('2026-09-10').timeline).toHaveLength(2);
  } finally { s.close(); }
});

it('merges consecutive timer ticks for display while retaining stored slices and totals', () => {
  const s = new StudyStore(':memory:');
  try {
    let time = 0; let id = 0;
    const start = Date.UTC(2026, 8, 10, 7, 13, 2);
    const timer = new TimerService({ read: () => ({ wallMs: start + time, monotonicMs: time, utcOffsetMinutes: 480 }) }, () => `merge-${++id}`);
    timer.start({ mode: 'stopwatch', taskId: null });
    for (const at of [100, 1000, 1100]) { time = at; timer.tick(); }
    time = 2000; timer.stop();
    s.saveCheckpoint({ revision: 1, snapshot: timer.snapshot(), intervals: [
      { startMs: 0, endMs: 1000, state: 'active', app: null },
      { startMs: 1000, endMs: 1500, state: 'afk', app: null },
      { startMs: 1500, endMs: 2000, state: 'unknown', app: null },
    ] });
    const daily = s.daily('2026-09-10');
    expect(daily.timeline).toEqual([{ start, end: start + 2000, offset: 480, kind: 'work', title: '自由专注', durationMs: 2000, effectiveMs: 1000, afkMs: 500, unknownMs: 500 }]);
    expect(daily).toMatchObject({ effectiveMs: 1000, afkMs: 500, unknownMs: 500 });
    expect(s.daily('2026-09-10').timeline).toEqual(daily.timeline);
    expect(timer.snapshot().slices).toHaveLength(4);
  } finally { s.close(); }
});

it('keeps pause, resume and separate sessions distinct even for the same task', () => {
  const s = new StudyStore(':memory:');
  try {
    let time = 0; let id = 0;
    const timer = new TimerService({ read: () => ({ wallMs: Date.UTC(2026, 8, 10) + time, monotonicMs: time, utcOffsetMinutes: 0 }) }, () => `boundary-${++id}`);
    timer.start({ mode: 'stopwatch', taskId: null });
    time = 1000; timer.tick(); time = 2000; timer.pause();
    time = 3000; timer.resume(); time = 4000; timer.tick(); time = 5000; timer.stop();
    s.saveCheckpoint({ revision: 1, snapshot: timer.snapshot(), intervals: [] });
    timer.start({ mode: 'stopwatch', taskId: null }); time = 6000; timer.stop();
    s.saveCheckpoint({ revision: 1, snapshot: timer.snapshot(), intervals: [] });
    expect(s.daily('2026-09-10').timeline.map(t => [t.kind, t.durationMs])).toEqual([
      ['work', 2000], ['pause', 1000], ['work', 2000], ['work', 1000],
    ]);
  } finally { s.close(); }
});

it('keeps activity and learning on separate tracks and subtracts AFK and unknown time', () => {
  const s = new StudyStore(':memory:');
  try {
    s.updateSettings({ durationMinutes: 25, whitelist: ['Code.exe'], recordAppActivity: true });
    let time = 0; let id = 0;
    const timer = new TimerService({ read: () => ({ wallMs: Date.UTC(2026, 8, 10) + time, monotonicMs: time, utcOffsetMinutes: 0 }) }, () => `track-${++id}`);
    timer.start({ mode: 'stopwatch', taskId: null }); time = 20000; timer.stop();
    s.saveCheckpoint({ revision: 1, snapshot: timer.snapshot(), intervals: [
      { startMs: 0, endMs: 10000, state: 'active', app: 'Code.exe' },
      { startMs: 10000, endMs: 15000, state: 'afk', app: null },
      { startMs: 15000, endMs: 20000, state: 'unknown', app: null },
    ] });
    expect(s.daily('2026-09-10')).toMatchObject({ effectiveMs: 10000, afkMs: 5000, unknownMs: 5000, apps: [{ app: 'Code.exe', durationMs: 10000, category: '未分类' }] });
    s.classifyApp('code.exe', '学习');
    expect(s.daily('2026-09-10').apps[0]?.category).toBe('学习');
    expect(s.daily('2026-09-10').activities).toHaveLength(3);
  } finally { s.close(); }
});

it('does not move a midnight pomodoro completion when deleting its final day', () => {
  const s = new StudyStore(':memory:');
  try {
    let time = 0; let id = 0;
    const timer = new TimerService({ read: () => ({ wallMs: Date.UTC(2026, 8, 9, 23, 59, 30) + time, monotonicMs: time, utcOffsetMinutes: 0 }) }, () => `p-${++id}`);
    timer.start({ mode: 'pomodoro', taskId: null, policy: { workMinutes: 1 } }); time = 60000; timer.tick(); timer.stop();
    s.saveCheckpoint({ revision: 1, snapshot: timer.snapshot(), intervals: [] });
    expect(s.daily('2026-09-09').pomodoros).toBe(0);
    expect(s.daily('2026-09-10').pomodoros).toBe(1);
    s.deleteHistory('2026-09-10');
    expect(s.daily('2026-09-09').pomodoros).toBe(0);
  } finally { s.close(); }
});

it('backs up v2 and retains snapshots across restart and later task edits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'study-daily-')); const path = join(dir, 'test.sqlite');
  let s = new StudyStore(path);
  try {
    const task = s.createTask({ title: 'Original', projectId: null, estimateMinutes: 25 });
    s.close();
    const old = new DatabaseSync(path);
    old.exec('DROP TABLE daily_plan_reminders; DROP TABLE daily_checkins; DROP TABLE task_details; DROP TABLE project_order; DROP TABLE imported_tasks; DROP TABLE import_batches; DROP TABLE ambient_activity; DROP INDEX activity_monotonic; DROP INDEX slices_monotonic; ALTER TABLE activity_intervals DROP COLUMN monotonicStart; ALTER TABLE settings DROP COLUMN preferences; DROP TABLE daily_plans; DROP TABLE app_categories; PRAGMA user_version=2;'); old.close();
    s = new StudyStore(path);
    const backup = readdirSync(dir).find(n => n.endsWith('.v2.sqlite'))!;
    expect(backup).toBeTruthy();
    expect(readFileSync(join(dir, backup + '.sha256'), 'utf8').trim()).toBe(createHash('sha256').update(readFileSync(join(dir, backup))).digest('hex'));
    s.savePlan('2026-09-10', [{ taskId: task.id, minutes: 30 }]);
    s.saveDailyReview('2026-09-10', { accomplished: 'Stored', obstacles: '', adjustment: '' });
    s.close();
    const db = new DatabaseSync(path); db.prepare('UPDATE tasks SET title=?,estimateMinutes=100 WHERE id=?').run('Renamed', task.id); db.close();
    s = new StudyStore(path);
    expect(s.daily('2026-09-10')).toMatchObject({ plan: { entries: [{ title: 'Original', minutes: 30 }] }, review: { accomplished: 'Stored' }, comparison: [{ actualMs: 0, plannedMs: 1800000 }] });
    expect(readdirSync(dir).filter(n => n.endsWith('.v2.sqlite'))).toHaveLength(1);
  } finally { s.close(); rmSync(dir, { recursive: true, force: true }); }
});

it.each([[-300, -240, 23], [-240, -300, 25]])('uses recorded offsets for a %s to %s date with %s hours', (before, after, hours) => {
  const s = new StudyStore(':memory:');
  try {
    const midnight = Date.UTC(2026, 8, 10) - before * 60000;
    const timer = new TimerService({ read: () => ({ wallMs: midnight, monotonicMs: 0, utcOffsetMinutes: before }) }, () => 'dst');
    timer.start({ mode: 'stopwatch', taskId: null });
    const snapshot = timer.snapshot(); snapshot.state.status = 'stopped';
    const first = 2 * 3600000; const total = hours * 3600000;
    snapshot.slices = [{ id: 'a', sessionId: 'dst', taskId: null, phase: 'work', kind: 'work', reason: 'tick', monotonicStartMs: 0, monotonicEndMs: first, durationMs: first, startedAt: midnight, endedAt: midnight + first, utcOffsetMinutes: before },
      { id: 'b', sessionId: 'dst', taskId: null, phase: 'work', kind: 'work', reason: 'stop', monotonicStartMs: first, monotonicEndMs: total, durationMs: total - first, startedAt: midnight + first, endedAt: midnight + total, utcOffsetMinutes: after }];
    s.saveCheckpoint({ revision: 1, snapshot, intervals: [{ startMs: 0, endMs: total, state: 'active', app: null }] });
    expect(s.daily('2026-09-10').effectiveMs).toBe(total);
    expect(s.daily('2026-09-11').effectiveMs).toBe(0);
    expect(s.daily('2026-09-10').comparison[0]?.title).toBe('自由专注');
  } finally { s.close(); }
});

it('compares immutable daily allocations with only that day effective time', () => {
  const s = new StudyStore(':memory:');
  try {
    const task = s.createTask({ title: 'Reading', projectId: null, estimateMinutes: 25 });
    s.addFocusTime(task.id, 999999);
    s.savePlan('2026-09-10', [{ taskId: task.id, minutes: 10 }]);
    let time = 0;
    const timer = new TimerService({ read: () => ({ wallMs: Date.UTC(2026, 8, 9, 15, 59, 50) + time, monotonicMs: time, utcOffsetMinutes: 480 }) }, () => 'session');
    timer.start({ mode: 'stopwatch', taskId: task.id }); time = 20000; timer.stop();
    s.saveCheckpoint({ revision: 1, snapshot: timer.snapshot(), intervals: [{ startMs: 0, endMs: time, state: 'active', app: 'Code.exe' }] });
    expect(s.daily('2026-09-10')).toMatchObject({ effectiveMs: 10000, comparison: [{ title: 'Reading', plannedMs: 600000, actualMs: 10000, deltaMs: -590000 }] });
    expect(s.daily('2026-09-09')).toMatchObject({ effectiveMs: 10000, comparison: [{ plannedMs: 0, actualMs: 10000, rate: null }] });
    expect(() => s.savePlan('2026-09-10', [{ taskId: task.id, minutes: -1 }])).toThrow();
    expect(() => s.savePlan('2026-09-10', [{ taskId: task.id, minutes: 1 }, { taskId: task.id, minutes: 2 }])).toThrow();
    expect(s.daily('2026-09-10').plan?.entries[0]?.minutes).toBe(10);
    s.deleteHistory('2026-09-10');
    expect(s.daily('2026-09-10').plan?.entries).toHaveLength(1);
    expect(s.daily('2026-09-10').effectiveMs).toBe(0);
  } finally { s.close(); }
});

it('round trips review fields, empty plans and manual app classification', () => {
  const s = new StudyStore(':memory:');
  try {
    s.saveDailyReview('2026-09-10', { accomplished: '读完', obstacles: '难点\n笔记', adjustment: '明天练习' });
    s.savePlan('2026-09-10', []);
    s.classifyApp('Code.exe', '学习');
    expect(s.daily('2026-09-10')).toMatchObject({ review: { accomplished: '读完', obstacles: '难点\n笔记', adjustment: '明天练习' }, plan: { entries: [] }, effectiveMs: 0 });
    expect(() => s.daily('2026-02-30')).toThrow();
    expect(() => s.saveDailyReview('2026-09-10', { accomplished: 1 })).toThrow();
  } finally { s.close(); }
});
