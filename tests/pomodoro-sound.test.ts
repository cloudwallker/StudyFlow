import { expect, it } from 'vitest';
import { DesktopStudy } from '../src/desktop/study';
import { timerPreferences } from '../src/desktop/preferences';
import { StudyStore } from '../src/desktop/store';
import type { ActivitySample } from '../src/activity/contracts';

function setup(sound: unknown = { enabled: true, minMinutes: 1, maxMinutes: 1 }) {
  let time = 0; let id = 0;
  const played: string[] = [];
  const study = new DesktopStudy({
    clock: { read: () => ({ wallMs: time, monotonicMs: time, utcOffsetMinutes: 0 }) },
    makeId: () => String(++id), sampler: { sample: async () => ({ status: 'ok', app: 'Code.exe', idleMs: 0 }) },
    notify: async () => {}, dismiss: () => {}, credit: () => {},
    sound: { play: async kind => { played.push(kind); }, stop: () => {} }, random: () => 0.5,
  });
  study.start(null, 25, ['Code.exe'], { mode: 'pomodoro', policy: { workMinutes: 3, shortBreakMinutes: 1 }, sound });
  return { study, played, elapse: (ms: number) => { time += ms; }, advance: async (ms: number) => { time += ms; await study.tick(); } };
}

it('discards completion sounds discovered exactly at pause or lock boundaries', async () => {
  for (const action of ['pause', 'interrupt'] as const) {
    const s = setup(); await s.advance(60000); await s.advance(60000); s.played.length = 0;
    s.elapse(60000); s.study[action](); await s.study.tick();
    expect(s.study.state().timer?.status).toBe('awaiting-next');
    expect(s.played).toEqual([]);
    s.study.resume(); await s.study.tick(); expect(s.played).toEqual([]);
  }
});

it('plays cues only in running work and distinct completion sounds once', async () => {
  const s = setup();
  await s.advance(60000); expect(s.played).toEqual(['cue']);
  s.study.pause(); await s.advance(60000); expect(s.played).toHaveLength(1);
  s.study.resume(); await s.advance(60000); expect(s.played).toEqual(['cue', 'cue']);
  await s.advance(60000); expect(s.played).toEqual(['cue', 'cue', 'work-end']);
  await s.advance(60000); expect(s.played).toHaveLength(3);
  s.study.resume(); await s.advance(60000); expect(s.played.at(-1)).toBe('break-end');
  s.study.stop(); await s.advance(60000); expect(s.played).toHaveLength(4);
});

it('defaults off, respects volume zero, and does not catch up after an interrupted gap', async () => {
  for (const settings of [{}, { enabled: true, volume: 0 }]) {
    const s = setup(settings); await s.advance(60000); await s.advance(60000); await s.advance(60000);
    expect(s.played).toEqual([]);
  }
  const s = setup(); await s.advance(120000); expect(s.played).toEqual([]);
  s.study.resume(); await s.advance(59000); expect(s.played).toEqual([]);
  await s.advance(1000); expect(s.played).toEqual(['cue']);
});

it('draws intervals within the configured range and accepts a fresh next-stage duration', async () => {
  const s = setup({ enabled: true, minMinutes: 1, maxMinutes: 2 });
  await s.advance(60000); expect(s.played).toEqual([]);
  await s.advance(30000); expect(s.played).toEqual(['cue']);
  await s.advance(90000); expect(s.played).toEqual(['cue', 'work-end']);
  expect(() => s.study.resume({ durationMinutes: 0 })).toThrow();
  expect(s.study.state().timer?.status).toBe('awaiting-next');
  s.study.resume({ durationMinutes: 10 });
  expect(s.study.state().timer).toMatchObject({ phase: 'short-break', remainingMs: 600000 });
});

it('rejects malformed sound input and preserves preferences through storage serialization', () => {
  for (const sound of [{ enabled: 'yes' }, { minMinutes: 6, maxMinutes: 2 }, { volume: 101 }, { tone: 'file.exe' }, { minMinutes: 0 }, null]) {
    expect(() => timerPreferences({ sound })).toThrow();
  }
  const store = new StudyStore(':memory:');
  try {
    store.updateSettings({ sound: { enabled: true, minMinutes: 2, maxMinutes: 7, volume: 35, tone: 'bell' } });
    expect(store.snapshot().settings.sound).toEqual({ enabled: true, minMinutes: 2, maxMinutes: 7, volume: 35, tone: 'bell' });
    store.updateSettings({ durationMinutes: 40 });
    expect(store.snapshot().settings.sound?.enabled).toBe(true);
  } finally { store.close(); }
});

it('discards a completion waiting for a late sample when the computer locks', async () => {
  let time = 0; let resolve!: (sample: ActivitySample) => void; let id = 0;
  const played: string[] = [];
  const study = new DesktopStudy({ clock: { read: () => ({ wallMs: time, monotonicMs: time, utcOffsetMinutes: 0 }) },
    makeId: () => String(++id), sampler: { sample: () => new Promise(r => { resolve = r; }) },
    notify: async () => {}, dismiss: () => {}, credit: () => {},
    sound: { play: async kind => { played.push(kind); }, stop: () => {} } });
  study.start(null, 25, [], { mode: 'pomodoro', policy: { workMinutes: 1 }, sound: { enabled: true } });
  time = 60000; const pending = study.tick(); study.interrupt();
  resolve({ status: 'ok', app: 'Code.exe', idleMs: 0 }); await pending; await study.tick();
  expect(played).toEqual([]);
  expect(study.state().timer?.status).toBe('awaiting-next');
});

it('reports sound failure without rapid retries or affecting the timer', async () => {
  let time = 0; let attempts = 0; let id = 0;
  const study = new DesktopStudy({ clock: { read: () => ({ wallMs: time, monotonicMs: time, utcOffsetMinutes: 0 }) },
    makeId: () => String(++id), sampler: { sample: async () => ({ status: 'ok', app: 'Code.exe', idleMs: 0 }) },
    notify: async () => {}, dismiss: () => {}, credit: () => {},
    sound: { play: async () => { attempts++; throw new Error('private path'); }, stop: () => {} } });
  study.start(null, 25, ['Code.exe'], { mode: 'pomodoro', sound: { enabled: true, minMinutes: 1, maxMinutes: 1 } });
  time = 60000; await study.tick(); await Promise.resolve();
  expect(study.state().message).toContain('提示音播放失败');
  expect(study.state().message).not.toContain('private path');
  time = 61000; await study.tick(); expect(attempts).toBe(1);
  expect(study.state().timer?.status).toBe('running');
  study.stop();
  study.start(null, 1, ['Code.exe'], { mode: 'countdown', sound: { enabled: true, minMinutes: 1, maxMinutes: 1 } });
  time += 60000; await study.tick(); expect(attempts).toBe(1);
});
