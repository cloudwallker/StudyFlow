import { expect, it } from 'vitest';
import { ActivityRecorder } from '../src/activity/recorder';
import { IdlePolicy } from '../src/activity/idle-policy';
import { learningSummary } from '../src/activity/learning-summary';
import { TimerService } from '../src/timer/timer-service';
import type { ActivitySample } from '../src/activity/contracts';

function setup(threshold = 300000) {
  let time = 0; let sample: ActivitySample = { status: 'ok', app: 'Code.exe', idleMs: 0 };
  const clock = { read: () => ({ monotonicMs: time, wallMs: 1700000000000 + time, utcOffsetMinutes: 480 }) };
  const recorder = new ActivityRecorder({ sample: async () => sample }, clock, new IdlePolicy(threshold));
  return { recorder, clock, advance: (ms: number, idleMs = 0) => { time += ms; sample = { status: 'ok', app: 'Code.exe', idleMs }; },
    sample: (value: ActivitySample) => { sample = value; } };
}

it('retroactively replaces the idle tail with AFK at the threshold and restores activity at last input', async () => {
  const s = setup(); await s.recorder.poll();
  for (let i = 1; i < 5; i++) { s.advance(60000, i * 60000); await s.recorder.poll(); }
  expect(s.recorder.intervals()).toEqual([{ startMs: 0, endMs: 240000, state: 'active', app: 'Code.exe' }]);
  s.advance(60000, 300000); await s.recorder.poll();
  expect(s.recorder.intervals()).toEqual([{ startMs: 0, endMs: 300000, state: 'afk', app: null }]);
  s.advance(10000, 2000); await s.recorder.poll();
  expect(s.recorder.intervals()).toEqual([
    { startMs: 0, endMs: 308000, state: 'afk', app: null },
    { startMs: 308000, endMs: 310000, state: 'active', app: 'Code.exe' },
  ]);
});

it('preserves work before the last input and never corrects an unknown gap into AFK or work', async () => {
  const s = setup(60000); await s.recorder.poll(); s.advance(10000); await s.recorder.poll();
  s.advance(10000, 10000); await s.recorder.poll();
  s.advance(10000); s.sample({ status: 'unknown', app: null, idleMs: null }); await s.recorder.poll();
  s.advance(10000, 30000); await s.recorder.poll(); s.advance(30000, 60000); await s.recorder.poll();
  expect(s.recorder.intervals()).toEqual([
    { startMs: 0, endMs: 10000, state: 'active', app: 'Code.exe' },
    { startMs: 10000, endMs: 20000, state: 'afk', app: null },
    { startMs: 20000, endMs: 40000, state: 'unknown', app: null },
    { startMs: 40000, endMs: 70000, state: 'afk', app: null },
  ]);
});

it('marks long gaps unknown and does not stitch across interrupted collection', async () => {
  const s = setup(); await s.recorder.poll(); s.advance(1000); await s.recorder.poll();
  s.advance(120000); await s.recorder.poll();
  expect(s.recorder.intervals().at(-1)).toMatchObject({ startMs: 1000, endMs: 121000, state: 'unknown', app: null });
  s.recorder.interrupt(); s.advance(1000); await s.recorder.poll(); s.advance(1000); await s.recorder.poll();
  expect(s.recorder.intervals().at(-1)).toEqual({ startMs: 122000, endMs: 123000, state: 'active', app: 'Code.exe' });
});

it('serializes polling and invalidates a late result across reset', async () => {
  let resolve!: (sample: ActivitySample) => void; let calls = 0;
  const clock = { read: () => ({ wallMs: 0, monotonicMs: 0, utcOffsetMinutes: 0 }) };
  const recorder = new ActivityRecorder({ sample: () => { calls++; return new Promise(r => { resolve = r; }); } }, clock, new IdlePolicy());
  const pending = recorder.poll(); await recorder.poll(); expect(calls).toBe(1);
  recorder.reset(new IdlePolicy()); resolve({ status: 'ok', app: 'Game.exe', idleMs: 0 });
  expect(await pending).toBeNull(); expect(recorder.intervals()).toEqual([]);
});

it('handles failures and slow samples as unknown without retaining the old app', async () => {
  let time = 0;
  const recorder = new ActivityRecorder({ sample: async () => { time += 6000; return { status: 'ok', app: 'Code.exe', idleMs: 0 }; } },
    { read: () => ({ wallMs: time, monotonicMs: time, utcOffsetMinutes: 0 }) }, new IdlePolicy());
  expect(await recorder.poll()).toMatchObject({ state: 'unknown', app: null });
  expect(new IdlePolicy().classify({ status: 'unknown', app: null, idleMs: null })).toBe('unknown');
});

it('intersects classified intervals only with work, excluding pause, break and unobserved tails', async () => {
  const s = setup(60000); let id = 0; const timer = new TimerService(s.clock, () => String(++id));
  timer.start({ mode: 'stopwatch', taskId: null }); await s.recorder.poll();
  s.advance(10000); timer.pause(); await s.recorder.poll();
  s.advance(10000); timer.resume(); await s.recorder.poll();
  s.advance(10000); timer.tick(); await s.recorder.poll(); s.advance(5000); timer.stop();
  expect(learningSummary(timer.snapshot().slices, s.recorder.intervals())).toEqual({ effectiveMs: 20000, afkMs: 0, unknownMs: 5000 });
});

it.each([0, -1, NaN, Infinity, 1.5])('rejects invalid AFK thresholds: %s', threshold => {
  expect(() => new IdlePolicy(threshold)).toThrow();
});
