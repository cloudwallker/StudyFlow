import { expect, it } from 'vitest';
import { DesktopStudy } from '../src/desktop/study';
import { StudyStore } from '../src/desktop/store';
import type { ActivitySample } from '../src/activity/contracts';

function setup() {
  let time = 0; let idleMs = 0; let app = 'Code.exe'; let id = 0;
  const store = new StudyStore(':memory:');
  const task = store.createTask({ title: 'Fictional study', projectId: null, estimateMinutes: 25 });
  const notices: string[] = []; let visible = false;
  const study = new DesktopStudy({ clock: { read: () => ({ wallMs: 1700000000000 + time, monotonicMs: time, utcOffsetMinutes: 480 }) },
    makeId: () => String(++id), sampler: { sample: async () => ({ status: 'ok', app, idleMs }) },
    notify: async body => { notices.push(body); visible = true; }, dismiss: () => { visible = false; },
    credit: (taskId, ms) => store.addFocusTime(taskId, ms),
  });
  return { study, store, task, notices, visible: () => visible,
    advance: (ms: number, idle = 0) => { time += ms; idleMs = idle; }, app: (value: string) => { app = value; } };
}

it('credits only observed work once after AFK tail correction and excludes the unobserved stop tail', async () => {
  const s = setup();
  try {
    s.study.start(s.task.id, 25, ['Code.exe'], { mode: 'stopwatch', idleMinutes: 1 }); await s.study.tick();
    s.advance(10000); await s.study.tick();
    s.advance(30000, 30000); await s.study.tick();
    expect(s.study.state().learning?.effectiveMs).toBe(40000);
    s.advance(30000, 60000); await s.study.tick();
    expect(s.study.state().learning).toMatchObject({ effectiveMs: 10000, afkMs: 60000 });
    s.advance(10000); await s.study.tick(); s.advance(3000); await s.study.tick();
    s.advance(1000); s.study.stop(); s.study.stop();
    expect(s.store.snapshot().tasks[0]?.spentMs).toBe(13000);
    expect(s.study.state().learning?.unknownMs).toBe(1000);
  } finally { s.store.close(); }
});

it('keeps paused sessions exclusive and never counts pause or break as task work', async () => {
  const s = setup();
  try {
    s.study.start(s.task.id, 25, ['Code.exe'], { mode: 'pomodoro', policy: { workMinutes: 1, shortBreakMinutes: 1 } }); await s.study.tick();
    s.advance(30000); await s.study.tick(); s.study.pause();
    expect(s.study.state()).toMatchObject({ running: true, timer: { status: 'paused' } });
    expect(() => s.study.start(null, 25, [])).toThrow();
    s.advance(60000); s.study.resume(); await s.study.tick();
    s.advance(30000); await s.study.tick();
    expect(s.study.state().timer).toMatchObject({ status: 'awaiting-next', completedPomodoros: 1 });
    s.study.resume(); await s.study.tick(); s.advance(60000); await s.study.tick(); s.study.stop();
    expect(s.store.snapshot().tasks[0]?.spentMs).toBe(60000);
    expect(s.study.state().timer).toMatchObject({ workMs: 60000, breakMs: 60000, pausedMs: 60000 });
  } finally { s.store.close(); }
});

it('uses the same sample for AFK suppression and preserves sixty second cooldown through allowed apps', async () => {
  const s = setup();
  try {
    s.study.start(null, 25, ['Code.exe'], { mode: 'stopwatch', idleMinutes: 1 }); await s.study.tick();
    s.app('Game.exe'); s.advance(3000); await s.study.tick(); expect(s.notices).toHaveLength(1);
    s.app('Code.exe'); s.advance(3000); await s.study.tick(); expect(s.visible()).toBe(false);
    s.app('Game.exe'); s.advance(54000, 60000); await s.study.tick(); expect(s.notices).toHaveLength(1);
    s.advance(3000); await s.study.tick(); expect(s.notices).toHaveLength(2);
    s.study.pause(); expect(s.visible()).toBe(false); s.advance(60000); await s.study.tick(); expect(s.notices).toHaveLength(2);
  } finally { s.store.close(); }
});

it('drops late samples across stop/start and never overlaps sampler calls', async () => {
  let resolve!: (sample: ActivitySample) => void; let calls = 0; let nextId = 0; let time = 0;
  const notices: string[] = [];
  const study = new DesktopStudy({ clock: { read: () => ({ monotonicMs: time, wallMs: time, utcOffsetMinutes: 0 }) },
    makeId: () => String(++nextId), sampler: { sample: () => { calls++; return new Promise(r => { resolve = r; }); } },
    notify: async body => { notices.push(body); }, dismiss: () => {}, credit: () => {},
  });
  study.start(null, 25, []); const pending = study.tick(); time = 1000; await study.tick(); expect(calls).toBe(1);
  study.stop(); study.start(null, 25, []); resolve({ status: 'ok', app: 'Game.exe', idleMs: 0 }); await pending;
  expect(study.state().app).toBeNull(); expect(notices).toEqual([]); expect(study.state().learning?.effectiveMs).toBe(0);
});

it('reports credit failure without rapid retries or disclosing storage details', async () => {
  let time = 0; let attempts = 0;
  const study = new DesktopStudy({ clock: { read: () => ({ monotonicMs: time, wallMs: time, utcOffsetMinutes: 0 }) }, makeId: () => 'id',
    sampler: { sample: async () => ({ status: 'ok', app: 'Code.exe', idleMs: 0 }) },
    notify: async () => {}, dismiss: () => {}, credit: () => { attempts++; throw new Error('private path'); } });
  study.start('task', 1, ['Code.exe']); await study.tick(); time = 60000; await study.tick(); study.stop();
  expect(attempts).toBe(1); expect(study.state().message).toContain('保存失败'); expect(JSON.stringify(study.state())).not.toContain('private path');
});

it('keeps the phase notification visible while waiting and sends no distraction notices in a break', async () => {
  const s = setup();
  try {
    s.study.start(null, 25, ['Code.exe'], { mode: 'pomodoro', policy: { workMinutes: 1 } }); await s.study.tick();
    s.advance(60000); await s.study.tick(); expect(s.visible()).toBe(true);
    s.advance(1000); await s.study.tick(); expect(s.visible()).toBe(true);
    s.study.resume(); expect(s.visible()).toBe(false); s.app('Game.exe');
    await s.study.tick(); s.advance(3000); await s.study.tick(); expect(s.notices).toHaveLength(1);
  } finally { s.store.close(); }
});

it('settles a completed task before allowing restart while its completion notification is pending', async () => {
  let time = 0; let id = 0; let finishNotice!: () => void;
  const credits: number[] = [];
  const study = new DesktopStudy({ clock: { read: () => ({ monotonicMs: time, wallMs: time, utcOffsetMinutes: 0 }) },
    makeId: () => String(++id), sampler: { sample: async () => ({ status: 'ok', app: 'Code.exe', idleMs: 0 }) },
    notify: () => new Promise(resolve => { finishNotice = resolve; }), dismiss: () => {}, credit: (_task, ms) => { credits.push(ms); } });
  study.start('task', 1, ['Code.exe']); await study.tick(); time = 60000;
  const pending = study.tick(); await new Promise(r => setTimeout(r, 0));
  expect(credits).toEqual([60000]);
  study.start(null, 25, ['Code.exe']); finishNotice(); await pending;
  expect(study.state().timer?.status).toBe('running'); expect(credits).toEqual([60000]);
});

it('does not expose restart while a final sample still owns the completed task', async () => {
  let time = 0; let id = 0; let finishSample!: (sample: ActivitySample) => void; let samples = 0;
  const credits: number[] = [];
  const study = new DesktopStudy({ clock: { read: () => ({ monotonicMs: time, wallMs: time, utcOffsetMinutes: 0 }) }, makeId: () => String(++id),
    sampler: { sample: () => ++samples === 1 ? Promise.resolve({ status: 'ok', app: 'Code.exe', idleMs: 0 }) : new Promise(resolve => { finishSample = resolve; }) },
    notify: async () => {}, dismiss: () => {}, credit: (_task, ms) => { credits.push(ms); } });
  study.start('task', 1, ['Code.exe']); await study.tick(); time = 59000; const pending = study.tick();
  time = 60000; await study.tick();
  expect(study.state().running).toBe(true); expect(() => study.start(null, 25, [])).toThrow();
  finishSample({ status: 'ok', app: 'Code.exe', idleMs: 0 }); await pending;
  expect(credits).toEqual([60000]); expect(study.state().running).toBe(false);
});

it('checkpoints before stop and keeps a failed final save retryable', async () => {
  let t = 0; let id = 0; let fail = false;
  const store = new StudyStore(':memory:');
  const task = store.createTask({ title: 'checkpoint fixture', projectId: null, estimateMinutes: 25 });
  const study = new DesktopStudy({ clock: { read: () => ({ wallMs: 1700000000000 + t, monotonicMs: t, utcOffsetMinutes: 480 }) },
    makeId: () => String(++id), sampler: { sample: async () => ({ status: 'ok', app: 'code.exe', idleMs: 0 }) },
    notify: async () => {}, dismiss: () => {}, credit: () => { throw new Error('legacy credit must not run'); },
    checkpoint: cp => { if (fail) throw new Error('disk failure'); store.saveCheckpoint(cp); },
  });
  try {
    study.start(task.id, 25, [], { mode: 'stopwatch' }); await study.tick();
    t = 30000; await study.tick(); expect(store.snapshot().tasks[0]?.spentMs).toBe(30000);
    fail = true; t = 33000; await study.tick(); study.stop();
    expect(study.state().running).toBe(true);
    expect(() => study.start(task.id, 25, [])).toThrow();
    fail = false; t += 30000; await study.tick();
    expect(study.state().running).toBe(false);
    expect(store.snapshot().tasks[0]?.spentMs).toBe(33000);
    study.stop(); expect(store.snapshot().tasks[0]?.spentMs).toBe(33000);
  } finally { store.close(); }
});

it('keeps checkpoint failures visible through subsequent activity messages and clears them after retry', async () => {
  let time = 0; let id = 0; let fail = true;
  const study = new DesktopStudy({ clock: { read: () => ({ wallMs: time, monotonicMs: time, utcOffsetMinutes: 0 }) },
    makeId: () => String(++id), sampler: { sample: async () => ({ status: 'ok', app: 'code.exe', idleMs: 0 }) },
    notify: async () => {}, dismiss: () => {}, credit: () => {}, checkpoint: () => { if (fail) throw new Error('disk'); } });
  study.start(null, 25, ['code.exe']); await study.tick();
  expect(study.state().message).toContain('历史保存失败');
  fail = false; time = 30000; await study.tick();
  expect(study.state().message).not.toContain('历史保存失败');
});
