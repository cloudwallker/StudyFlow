import { expect, it } from 'vitest';
import { StudyStore } from '../src/desktop/store';
import { DesktopStudy } from '../src/desktop/study';
import { TimerService } from '../src/timer/timer-service';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function timerAt(startedAt: number, prefix: string) {
  let elapsed = 0;
  let nextId = 0;
  const timer = new TimerService({ read: () => ({
    wallMs: startedAt + elapsed,
    monotonicMs: elapsed,
    utcOffsetMinutes: 0,
  }) }, () => `${prefix}-${++nextId}`);
  return { timer, advance(ms: number) { elapsed += ms; } };
}

it('adds earlier task focus and the current free-focus work for the selected day', () => {
  const store = new StudyStore(':memory:');
  try {
    const task = store.createTask({ title: 'Earlier task', projectId: null, estimateMinutes: 25 });
    const earlier = timerAt(Date.UTC(2026, 8, 12, 8), 'earlier');
    earlier.timer.start({ mode: 'stopwatch', taskId: task.id });
    earlier.advance(10_000); earlier.timer.stop();
    store.saveCheckpoint({ revision: 1, snapshot: earlier.timer.snapshot(), intervals: [] });

    const current = timerAt(Date.UTC(2026, 8, 12, 9), 'current');
    current.timer.start({ mode: 'stopwatch', taskId: null });
    current.advance(5_000); current.timer.tick();
    const snapshot = current.timer.snapshot();

    expect(store.focusTime('2026-09-12', {
      sessionId: snapshot.state.sessionId,
      retainedFrom: 0,
      slices: snapshot.slices,
    })).toBe(15_000);
  } finally { store.close(); }
});

it('counts only work while paused, waiting, pomodoro-resting or micro-resting time is excluded', () => {
  const store = new StudyStore(':memory:');
  try {
    const paused = timerAt(Date.UTC(2026, 8, 12, 8), 'paused');
    paused.timer.start({ mode: 'stopwatch', taskId: null });
    paused.advance(4_000); paused.timer.pause();
    paused.advance(3_000); paused.timer.resume();
    paused.advance(2_000); paused.timer.stop();
    store.saveCheckpoint({ revision: 1, snapshot: paused.timer.snapshot(), intervals: [] });

    const pomodoro = timerAt(Date.UTC(2026, 8, 12, 9), 'pomodoro');
    pomodoro.timer.start({ mode: 'pomodoro', taskId: null, policy: { workMinutes: 1, shortBreakMinutes: 1 } });
    pomodoro.advance(60_000); pomodoro.timer.tick();
    pomodoro.advance(7_000); pomodoro.timer.tick();
    pomodoro.timer.resume(); pomodoro.advance(20_000); pomodoro.timer.stop();
    store.saveCheckpoint({ revision: 1, snapshot: pomodoro.timer.snapshot(), intervals: [] });

    const interrupted = timerAt(Date.UTC(2026, 8, 12, 9, 30), 'unknown');
    interrupted.timer.start({ mode: 'stopwatch', taskId: null });
    interrupted.advance(1_000); interrupted.timer.tick();
    interrupted.advance(120_000); interrupted.timer.tick();
    store.saveCheckpoint({ revision: 1, snapshot: interrupted.timer.snapshot(), intervals: [] });

    const micro = timerAt(Date.UTC(2026, 8, 12, 10), 'micro');
    micro.timer.start({ mode: 'pomodoro', taskId: null, longFocus: {
      enabled: true, microEnabled: true, totalMinutes: 2, restMinutes: 1,
      minMinutes: 1, maxMinutes: 1, durationSeconds: 10,
    } });
    micro.advance(60_000); micro.timer.tick();
    micro.advance(10_000); micro.timer.tick();
    const current = micro.timer.snapshot();

    expect(store.focusTime('2026-09-12', {
      sessionId: current.state.sessionId,
      retainedFrom: 0,
      slices: current.slices,
    })).toBe(127_000);
  } finally { store.close(); }
});

it('splits live work at recorded local midnight', () => {
  const store = new StudyStore(':memory:');
  try {
    const current = timerAt(Date.UTC(2026, 8, 12, 15, 59, 55), 'midnight');
    current.timer.start({ mode: 'stopwatch', taskId: null });
    current.advance(10_000); current.timer.tick();
    const snapshot = current.timer.snapshot();
    const clock = { sessionId: snapshot.state.sessionId, retainedFrom: 0, slices: snapshot.slices };
    clock.slices[0]!.utcOffsetMinutes = 480;

    expect(store.focusTime('2026-09-12', clock)).toBe(5_000);
    expect(store.focusTime('2026-09-13', clock)).toBe(5_000);
  } finally { store.close(); }
});

it('does not double-count the current checkpoint and joins compacted history to retained live slices', () => {
  const store = new StudyStore(':memory:');
  try {
    const current = timerAt(Date.UTC(2026, 8, 12), 'retained');
    current.timer.start({ mode: 'stopwatch', taskId: null });
    current.advance(10_000); current.timer.tick();
    const first = current.timer.snapshot();
    store.saveCheckpoint({ revision: 1, snapshot: first, intervals: [], retainedFrom: 0, archivedEffectiveMs: 0 });
    expect(store.focusTime('2026-09-12', {
      sessionId: first.state.sessionId, retainedFrom: 0, slices: first.slices,
    })).toBe(10_000);

    current.advance(5_000); current.timer.tick();
    const full = current.timer.snapshot();
    const retained = full.slices.filter(slice => slice.monotonicStartMs >= 10_000);
    store.saveCheckpoint({ revision: 2, snapshot: { state: full.state, slices: retained }, intervals: [], retainedFrom: 10_000, archivedEffectiveMs: 0 });

    expect(store.focusTime('2026-09-12', {
      sessionId: full.state.sessionId, retainedFrom: 10_000, slices: retained,
    })).toBe(15_000);
  } finally { store.close(); }
});

it('uses complete live slices after a failed checkpoint without losing or duplicating prior saved work', () => {
  const directory = mkdtempSync(join(tmpdir(), 'focus-mini-failure-'));
  const path = join(directory, 'study.sqlite');
  const store = new StudyStore(path);
  let blocker: DatabaseSync | undefined;
  try {
    const current = timerAt(Date.UTC(2026, 8, 12), 'failure');
    current.timer.start({ mode: 'stopwatch', taskId: null });
    current.advance(5_000); current.timer.tick();
    store.saveCheckpoint({ revision: 1, snapshot: current.timer.snapshot(), intervals: [], retainedFrom: 0, archivedEffectiveMs: 0 });

    blocker = new DatabaseSync(path);
    blocker.exec("CREATE TRIGGER reject_focus_slice BEFORE INSERT ON timer_slices BEGIN SELECT RAISE(ABORT,'disk simulation'); END;");
    current.advance(5_000); current.timer.tick();
    const live = current.timer.snapshot();
    expect(() => store.saveCheckpoint({ revision: 2, snapshot: live, intervals: [], retainedFrom: 0, archivedEffectiveMs: 0 })).toThrow();

    expect(store.focusTime('2026-09-12', {
      sessionId: live.state.sessionId, retainedFrom: 0, slices: live.slices,
    })).toBe(10_000);
  } finally {
    blocker?.close(); store.close(); rmSync(directory, { recursive: true, force: true });
  }
});

it('retains only confirmed work after restart and never invents downtime', () => {
  const directory = mkdtempSync(join(tmpdir(), 'focus-mini-restart-'));
  const path = join(directory, 'study.sqlite');
  let store = new StudyStore(path);
  try {
    const current = timerAt(Date.UTC(2026, 8, 12, 8), 'restart');
    current.timer.start({ mode: 'stopwatch', taskId: null });
    current.advance(10_000); current.timer.tick();
    store.saveCheckpoint({ revision: 1, snapshot: current.timer.snapshot(), intervals: [], retainedFrom: 0, archivedEffectiveMs: 0 });
    store.close();

    current.advance(8 * 60 * 60 * 1000);
    store = new StudyStore(path);
    expect(store.recoveredSessions).toBe(1);
    expect(store.focusTime('2026-09-12')).toBe(10_000);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('exposes a side-effect-free current clock without advancing or checkpointing it', () => {
  let elapsed = 0;
  let checkpoints = 0;
  const study = new DesktopStudy({
    clock: { read: () => ({ wallMs: Date.UTC(2026, 8, 12) + elapsed, monotonicMs: elapsed, utcOffsetMinutes: 0 }) },
    makeId: () => 'current-clock', sampler: { sample: async () => ({ status: 'unknown', app: null, idleMs: null }) },
    notify: async () => {}, dismiss: () => {}, credit: () => {}, checkpoint: () => { checkpoints++; },
  });
  study.start(null, 25, [], { mode: 'stopwatch' });
  elapsed = 5_000;

  expect(study.currentFocusClock()).toEqual({ sessionId: 'current-clock', retainedFrom: 0, slices: [] });
  expect(study.currentFocusClock()).toEqual({ sessionId: 'current-clock', retainedFrom: 0, slices: [] });
  expect(checkpoints).toBe(1);
});

it('tracks real DesktopStudy compaction through stop, a new session and history deletion', async () => {
  let elapsed = 0;
  let nextId = 0;
  const date = '2026-09-12';
  const store = new StudyStore(':memory:');
  const study = new DesktopStudy({
    clock: { read: () => ({ wallMs: Date.UTC(2026, 8, 12) + elapsed, monotonicMs: elapsed, utcOffsetMinutes: 0 }) },
    makeId: () => `lifecycle-${++nextId}`,
    sampler: { sample: async () => ({ status: 'ok', app: 'code.exe', idleMs: 0 }) },
    notify: async () => {}, dismiss: () => {}, credit: () => {},
    checkpoint: checkpoint => store.saveCheckpoint(checkpoint),
  });
  try {
    study.start(null, 25, [], { mode: 'stopwatch', idleMinutes: 1 });
    await study.tick();
    for (let step = 0; step < 10; step++) { elapsed += 30_000; await study.tick(); }

    const compacted = study.currentFocusClock();
    expect(compacted.retainedFrom).toBeGreaterThan(0);
    expect(store.focusTime(date, compacted)).toBe(300_000);

    study.stop();
    expect(study.currentFocusClock().slices).toEqual([]);
    expect(store.focusTime(date, study.currentFocusClock())).toBe(300_000);

    study.start(null, 25, [], { mode: 'stopwatch', idleMinutes: 1 });
    elapsed += 60_000; await study.tick();
    expect(store.focusTime(date, study.currentFocusClock())).toBe(360_000);
    study.stop();
    expect(store.focusTime(date, study.currentFocusClock())).toBe(360_000);

    store.deleteHistory(date);
    expect(store.focusTime(date, study.currentFocusClock())).toBe(0);
  } finally { store.close(); }
});
