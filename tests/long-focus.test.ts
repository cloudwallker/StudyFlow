import { expect, it } from 'vitest';
import { TimerService } from '../src/timer/timer-service';
import { learningSummary } from '../src/activity/learning-summary';

function setup(longFocus: Record<string, unknown> = {}) {
  let time = 0; let id = 0;
  const timer = new TimerService({ read: () => ({ monotonicMs: time, wallMs: time, utcOffsetMinutes: 0 }) }, () => String(++id));
  timer.start({ taskId: null, mode: 'pomodoro', longFocus: { enabled: true, microEnabled: true, minMinutes: 1, maxMinutes: 1, ...longFocus } });
  return { timer, step(ms: number) { time += ms; return timer.tick(); } };
}

it('automatically slices micro breaks and excludes them from effective learning', () => {
  const s = setup();
  expect(s.step(65000)).toMatchObject({ remainingMs: 3535000, microResting: true, microRemainingMs: 5000, microBreakMs: 5000, workMs: 60000 });
  expect(s.step(10000)).toMatchObject({ microResting: false, microRemainingMs: 55000, microBreakMs: 10000, workMs: 65000 });
  expect(learningSummary(s.timer.snapshot().slices, [{ startMs: 0, endMs: 75000, state: 'active', app: 'Code.exe' }]).effectiveMs).toBe(65000);
});

it('freezes both countdowns during a manual pause, preserving the pending interval', () => {
  const s = setup(); s.step(63000); s.timer.pause(); s.step(30000); s.timer.resume();
  expect(s.timer.state()).toMatchObject({ remainingMs: 3537000, microRemainingMs: 7000, pausedMs: 30000 });
  expect(s.step(7000)).toMatchObject({ microResting: false, microRemainingMs: 60000, microBreakMs: 10000 });
});

it('clips a micro break at round end and automatically starts long rest only once', () => {
  const s = setup({ totalMinutes: 2, durationSeconds: 120, restMinutes: 1 });
  s.step(60000);
  expect(s.step(65000)).toMatchObject({ phase: 'long-break', remainingMs: 55000, microBreakMs: 60000, completedPomodoros: 1 });
  expect(s.step(55000)).toMatchObject({ status: 'awaiting-next', nextPhase: 'work', completedPomodoros: 1 });
  s.timer.resume(); expect(s.timer.state()).toMatchObject({ phase: 'work', remainingMs: 120000, microResting: false });
});

it('keeps long focus optional and validates settings before opening a session', () => {
  const s = setup({ enabled: false });
  expect(s.step(65000)).toMatchObject({ workMs: 65000, remainingMs: 1435000 });
  expect(() => setup({ minMinutes: 3, maxMinutes: 2 })).toThrow();
  expect(() => setup({ durationSeconds: 0 })).toThrow();
});

it('pauses on missing samples without advancing micro or round time', () => {
  const s = setup(); s.step(62000);
  expect(s.step(100000)).toMatchObject({ status: 'paused', remainingMs: 3538000, microRemainingMs: 8000 });
});


it('persists micro settings and keeps micro completion out of effective time but in round count', async () => {
  const { StudyStore } = await import('../src/desktop/store');
  const store = new StudyStore(':memory:');
  try {
    store.updateSettings({ longFocus: { enabled: true, microEnabled: true }, sound: { events: { 'micro-start': { tone: 'wood', volume: 17 } } } });
    expect(store.snapshot().settings).toMatchObject({ longFocus: { enabled: true, totalMinutes: 60 }, sound: { events: { 'micro-start': { volume: 17 } } } });
    const s = setup({ totalMinutes: 2, durationSeconds: 120 }); s.step(60000); s.step(60000); s.timer.stop();
    store.saveCheckpoint({ revision: 1, snapshot: s.timer.snapshot(), intervals: [{ startMs: 0, endMs: 120000, state: 'active', app: 'Code.exe' }] });
    expect(store.daily('1970-01-01')).toMatchObject({ effectiveMs: 60000, microBreakMs: 60000, breakMs: 60000, pomodoros: 1 });
  } finally { store.close(); }
});

it('uses event-specific sound settings, suppresses random cues and stops sound on pause', async () => {
  const { DesktopStudy } = await import('../src/desktop/study');
  let time = 0; let id = 0; let stops = 0;
  const sounds: Array<{ kind: string; volume: number }> = [];
  const study = new DesktopStudy({ clock: { read: () => ({ monotonicMs: time, wallMs: time, utcOffsetMinutes: 0 }) },
    makeId: () => String(++id), sampler: { sample: async () => ({ status: 'ok', app: 'Code.exe', idleMs: 0 }) },
    notify: async () => {}, dismiss: () => {}, credit: () => {},
    sound: { play: async (kind, config) => { sounds.push({ kind, volume: config.volume }); }, stop: () => { stops++; } } });
  study.start(null, 25, ['Code.exe'], { mode: 'pomodoro', longFocus: { enabled: true, microEnabled: true, totalMinutes: 2, minMinutes: 1, maxMinutes: 1, restMinutes: 1 },
    sound: { enabled: true, minMinutes: 1, maxMinutes: 1, events: { 'micro-start': { volume: 17, tone: 'wood' } } } });
  time = 60000; await study.tick();
  expect(sounds).toEqual([{ kind: 'focus-start', volume: 40 }, { kind: 'micro-start', volume: 17 }]);
  const before = stops; study.pause(); expect(stops).toBeGreaterThan(before);
  time += 20000; await study.tick(); study.resume(); time += 10000; await study.tick();
  expect(sounds.at(-1)?.kind).toBe('micro-end');
  time += 50000; await study.tick(); expect(sounds.map(s => s.kind)).toEqual(['focus-start', 'micro-start', 'micro-end', 'work-end']);
  time += 60000; await study.tick(); expect(sounds.at(-1)?.kind).toBe('break-end');
  study.stop();
});

it('finishes exactly one 60-minute round including 270 seconds of fixed micro breaks', () => {
  const s = setup({ minMinutes: 2, maxMinutes: 2 });
  for (let i = 0; i < 60; i++) s.step(60000);
  expect(s.timer.state()).toMatchObject({ phase: 'long-break', phaseElapsedMs: 0, remainingMs: 600000, workMs: 3330000, microBreakMs: 270000, completedPomodoros: 1 });
  expect(s.timer.takeEvents().filter(e => e.type === 'phase-completed')).toHaveLength(1);
});

it('draws each default interval between two and three minutes', () => {
  for (const fraction of [0, 0.5, 1]) {
    let time = 0; let id = 0;
    const timer = new TimerService({ read: () => ({ monotonicMs: time, wallMs: time, utcOffsetMinutes: 0 }) }, () => String(++id), () => fraction);
    timer.start({ mode: 'pomodoro', taskId: null, longFocus: { enabled: true, microEnabled: true } });
    expect(timer.state().microRemainingMs).toBe(fraction === 0 ? 120000 : fraction === 1 ? 180000 : 150000);
    for (let i = 0; i < 3; i++) { time += 60000; timer.tick(); }
    expect(timer.state().microBreakMs).toBe(10000 * (fraction < 1 ? 1 : 0));
  }
});

it('uses event volume in long focus and global volume in classic sessions', async () => {
  const { DesktopStudy } = await import('../src/desktop/study');
  for (const enabled of [true, false]) {
    let time = 0; let id = 0; const played: string[] = [];
    const study = new DesktopStudy({ clock: { read: () => ({ monotonicMs: time, wallMs: time, utcOffsetMinutes: 0 }) },
      makeId: () => String(++id), sampler: { sample: async () => ({ status: 'unknown', app: null, idleMs: null }) },
      notify: async () => {}, dismiss: () => {}, credit: () => {},
      sound: { play: async kind => { played.push(kind); }, stop: () => {} } });
    study.start(null, 25, [], { mode: 'pomodoro', policy: { workMinutes: 1 }, longFocus: { enabled },
      sound: { enabled: true, volume: 0, minMinutes: 1, maxMinutes: 1, events: { cue: { volume: 40 }, 'work-end': { volume: 40 } } } });
    time = 60000; await study.tick();
    expect(played).toEqual(enabled ? ['cue'] : []);
    study.stop();
  }
});
