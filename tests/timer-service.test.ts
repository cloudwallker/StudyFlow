import { expect, it } from 'vitest';
import { TimerService } from '../src/timer/timer-service';

function setup() {
  let monotonicMs = 0; let wallMs = Date.UTC(2026, 8, 9, 15, 59, 50); let nextId = 0;
  let utcOffsetMinutes = 480;
  const timer = new TimerService({ read: () => ({ monotonicMs, wallMs, utcOffsetMinutes }) }, () => `id-${++nextId}`);
  return { timer,
    advance(ms: number) { monotonicMs += ms; wallMs += ms; },
    jump(ms: number) { wallMs += ms; },
    monotonic(ms: number) { monotonicMs = ms; },
    offset(value: number) { utcOffsetMinutes = value; },
  };
}

it('excludes paused time, freezes the completed snapshot and stops idempotently', () => {
  const s = setup(); s.timer.start({ mode: 'stopwatch', taskId: 'task' });
  s.advance(10000); s.timer.pause(); s.advance(20000); s.timer.resume();
  s.advance(5000);
  expect(s.timer.stop()).toMatchObject({ status: 'stopped', workMs: 15000, pausedMs: 20000, elapsedMs: 35000 });
  const saved = s.timer.snapshot();
  s.advance(100000); s.timer.stop(); s.timer.tick();
  expect(s.timer.snapshot()).toEqual(saved);
  expect(saved.slices.map(slice => slice.kind)).toEqual(['work', 'pause', 'work']);
  expect(saved.slices.every(slice => slice.taskId === 'task')).toBe(true);
});

it('uses a single owner for task and free sessions, including paused and awaiting sessions', () => {
  const s = setup(); s.timer.start({ mode: 'stopwatch', taskId: null }); s.timer.pause();
  expect(() => s.timer.start({ mode: 'countdown', taskId: 'task', durationMinutes: 1 })).toThrow();
  s.timer.stop(); s.timer.start({ mode: 'pomodoro', taskId: 'task', policy: { workMinutes: 1 } });
  s.advance(60000); s.timer.tick();
  expect(() => s.timer.start({ mode: 'stopwatch', taskId: null })).toThrow();
  s.timer.stop(); s.timer.start({ mode: 'stopwatch', taskId: null });
  s.advance(1000); s.timer.stop();
  expect(s.timer.snapshot().slices[0]?.taskId).toBeNull();
  expect(s.timer.state().workMs).toBe(1000);
});

it('clips countdown overshoot and emits completion once', () => {
  const s = setup(); s.timer.start({ mode: 'countdown', taskId: null, durationMinutes: 1 });
  s.advance(65000);
  expect(s.timer.tick()).toMatchObject({ status: 'stopped', workMs: 60000, elapsedMs: 60000, remainingMs: 0 });
  expect(s.timer.takeEvents()).toMatchObject([{ type: 'phase-completed', phase: 'work', completedPomodoros: 0 }]);
  s.timer.tick(); s.timer.stop(); expect(s.timer.takeEvents()).toEqual([]);
  expect(s.timer.snapshot().slices[0]?.durationMs).toBe(60000);
});

it('retains unconsumed completion events across a new session without duplicate delivery', () => {
  const s = setup(); const first = s.timer.start({ mode: 'countdown', taskId: null, durationMinutes: 1 });
  s.advance(60000); s.timer.tick();
  const second = s.timer.start({ mode: 'countdown', taskId: 'task', durationMinutes: 1 });
  s.advance(60000); s.timer.tick();
  expect(s.timer.takeEvents().map(event => event.sessionId)).toEqual([first.sessionId, second.sessionId]);
  expect(s.timer.takeEvents()).toEqual([]);
});

it('freezes remaining time while paused and makes repeated pause/resume harmless', () => {
  const s = setup(); s.timer.start({ mode: 'countdown', taskId: null, durationMinutes: 1 });
  s.advance(10000); s.timer.pause(); s.advance(15000); s.timer.pause();
  expect(s.timer.state().remainingMs).toBe(50000);
  s.advance(5000); s.timer.resume(); s.timer.resume(); s.advance(50000); s.timer.tick();
  expect(s.timer.state()).toMatchObject({ status: 'stopped', workMs: 60000, pausedMs: 20000, elapsedMs: 80000 });
});

it('waits for confirmation between all pomodoro stages and selects the fourth long break', () => {
  const s = setup(); s.timer.start({ mode: 'pomodoro', taskId: null, policy: { workMinutes: 1, shortBreakMinutes: 1, longBreakMinutes: 2 } });
  for (let round = 1; round <= 4; round++) {
    s.advance(60000); s.timer.tick();
    expect(s.timer.state()).toMatchObject({ status: 'awaiting-next', completedPomodoros: round, nextPhase: round === 4 ? 'long-break' : 'short-break' });
    if (round < 4) { s.timer.resume(); s.advance(60000); s.timer.tick(); s.timer.resume(); }
  }
  s.advance(30000); s.timer.tick();
  expect(s.timer.state()).toMatchObject({ workMs: 240000, breakMs: 180000, waitingMs: 30000 });
  s.timer.resume(); s.timer.resume();
  expect(s.timer.state()).toMatchObject({ phase: 'long-break', remainingMs: 120000, status: 'running' });
  s.advance(60000); s.timer.tick(); s.advance(60000); s.timer.tick();
  expect(s.timer.state()).toMatchObject({ nextPhase: 'work', workMs: 240000, breakMs: 300000, completedPomodoros: 4 });
  expect(s.timer.takeEvents()).toHaveLength(8);
  s.timer.stop(); expect(s.timer.takeEvents()).toEqual([]);
});

it('puts delayed pomodoro boundary time in waiting, never in a second stage', () => {
  const s = setup(); s.timer.start({ mode: 'pomodoro', taskId: null, policy: { workMinutes: 1 } });
  s.advance(80000); s.timer.tick();
  expect(s.timer.state()).toMatchObject({ workMs: 60000, waitingMs: 20000, elapsedMs: 80000, breakMs: 0 });
  expect(s.timer.snapshot().slices.map(slice => slice.durationMs)).toEqual([60000, 20000]);
});

it('requires explicit resumption after lock/suspend and never credits the sleep as work', () => {
  const s = setup(); s.timer.start({ mode: 'stopwatch', taskId: null });
  s.advance(10000); s.timer.interrupt(); s.advance(600000); s.timer.interrupt(); s.timer.tick();
  expect(s.timer.state()).toMatchObject({ status: 'paused', workMs: 10000, pausedMs: 600000 });
  s.timer.resume(); s.advance(1000); s.timer.stop(); expect(s.timer.state().workMs).toBe(11000);
});

it.each(['tick', 'pause', 'resume', 'stop', 'interrupt'] as const)('does not credit a long unobserved gap when %s precedes the next tick', command => {
  const s = setup(); s.timer.start({ mode: 'stopwatch', taskId: null }); s.advance(10000); s.timer.tick();
  s.advance(120000); s.timer[command]();
  expect(s.timer.state()).toMatchObject({ workMs: 10000, unknownMs: 120000, elapsedMs: 130000, status: command === 'stop' ? 'stopped' : 'paused' });
  expect(s.timer.snapshot().slices.at(-1)).toMatchObject({ kind: 'unknown', reason: 'gap' });
});

it.each([-3600000, 3600000])('splits wall clock jumps (%i) without distorting measured duration', jump => {
  const s = setup(); s.timer.start({ mode: 'stopwatch', taskId: null });
  s.advance(5000); s.timer.tick(); s.jump(jump); s.advance(1000); s.timer.tick();
  s.advance(5000); s.timer.stop();
  expect(s.timer.state()).toMatchObject({ workMs: 10000, unknownMs: 1000, elapsedMs: 11000 });
  const slices = s.timer.snapshot().slices;
  expect(slices.map(slice => slice.kind)).toEqual(['work', 'unknown', 'work']);
  expect(slices[1]).toMatchObject({ reason: 'clock-change', endedAt: null });
  expect(slices[2]?.startedAt).toBe(Date.UTC(2026, 8, 9, 15, 59, 56) + jump);
});

it('rejects monotonic clock rollback atomically and can continue once the clock recovers', () => {
  const s = setup(); s.timer.start({ mode: 'stopwatch', taskId: null }); s.advance(1000); s.timer.tick();
  const saved = s.timer.snapshot(); s.monotonic(999);
  expect(() => s.timer.stop()).toThrow(); expect(s.timer.snapshot()).toEqual(saved);
  s.monotonic(1000); s.timer.stop(); expect(s.timer.state().workMs).toBe(1000);
});

it('keeps UTC slices contiguous through small clock drift and detects cumulative drift', () => {
  const s = setup(); s.timer.start({ mode: 'stopwatch', taskId: null });
  s.advance(1000); s.timer.tick();
  s.jump(-500); s.advance(1000); s.timer.tick();
  s.advance(1000); s.timer.tick();
  let slices = s.timer.snapshot().slices;
  expect(slices[1]?.startedAt).toBe(slices[0]?.endedAt);
  expect(slices[2]?.startedAt).toBe(slices[1]?.endedAt);
  for (let i = 0; i < 4; i++) { s.jump(-500); s.advance(1000); s.timer.tick(); }
  slices = s.timer.snapshot().slices;
  expect(slices.at(-1)).toMatchObject({ kind: 'unknown', reason: 'clock-change', endedAt: null });
  expect(s.timer.state()).toMatchObject({ workMs: 6000, unknownMs: 1000, elapsedMs: 7000 });
});

it('exports independent snapshots and stable fragment ids with recorded timezone offsets', () => {
  const s = setup(); s.timer.start({ mode: 'stopwatch', taskId: null }); s.advance(20000); s.timer.tick();
  const first = s.timer.snapshot(); first.state.workMs = 0; first.slices[0]!.durationMs = 0; first.slices.length = 0;
  expect(s.timer.state().workMs).toBe(20000);
  const id = s.timer.snapshot().slices[0]!.id;
  s.offset(420); s.advance(1000); s.timer.tick(); s.advance(1000); s.timer.stop();
  const slices = s.timer.snapshot().slices;
  expect(slices[0]).toMatchObject({ id, utcOffsetMinutes: 480, durationMs: 20000 });
  expect(slices.at(-1)?.utcOffsetMinutes).toBe(420);
  expect(new Set(slices.map(slice => slice.id)).size).toBe(slices.length);
});

it('supports stopwatch sessions beyond the countdown limit without a deadline', () => {
  const s = setup(); s.timer.start({ mode: 'stopwatch', taskId: null });
  for (let i = 0; i < 15000; i++) { s.advance(60000); s.timer.tick(); }
  expect(s.timer.state()).toMatchObject({ status: 'running', workMs: 900000000, remainingMs: null });
});

it.each([null, {}, { mode: 'invalid', taskId: null }, { mode: 'stopwatch', taskId: '' },
  { mode: 'stopwatch', taskId: 1 }, { mode: 'countdown', taskId: null, durationMinutes: 0 },
  { mode: 'countdown', taskId: null, durationMinutes: 1.5 }, { mode: 'countdown', taskId: null, durationMinutes: Infinity },
  { mode: 'pomodoro', taskId: null, policy: { workMinutes: 0 } },
])('rejects invalid start input without reserving a session: %j', input => {
  const s = setup(); expect(() => s.timer.start(input)).toThrow(); expect(s.timer.state().status).toBe('idle');
  s.timer.start({ mode: 'stopwatch', taskId: null }); expect(s.timer.state().status).toBe('running');
});

it('validates clock readings before any mutation', () => {
  const timer = new TimerService({ read: () => ({ wallMs: NaN, monotonicMs: 0, utcOffsetMinutes: 480 }) }, () => 'id');
  expect(() => timer.start({ mode: 'stopwatch', taskId: null })).toThrow();
  expect(timer.state().status).toBe('idle');
});

it('leaves idle operations inert and state reads free of clock side effects', () => {
  const s = setup(); s.timer.pause(); s.timer.resume(); s.timer.interrupt(); s.timer.stop();
  expect(s.timer.state().status).toBe('idle'); expect(s.timer.snapshot().slices).toEqual([]);
  s.timer.start({ mode: 'countdown', taskId: null, durationMinutes: 1 }); s.advance(60000);
  expect(s.timer.state().remainingMs).toBe(60000); expect(s.timer.takeEvents()).toEqual([]);
  s.timer.tick(); expect(s.timer.state().status).toBe('stopped');
});
