import { expect, it } from 'vitest';
import { StudyStore } from '../src/desktop/store';
import { DesktopFocus } from '../src/desktop/focus';
import { DesktopService } from '../src/desktop/service';
import { DesktopStudy } from '../src/desktop/study';

it('routes task commands to real storage and prevents focus on missing or finished tasks', () => {
  const store = new StudyStore(':memory:');
  const focus = new DesktopFocus({ sample: async () => null, notify: async () => {}, credit: (id, ms) => store.addFocusTime(id, ms), now: () => 1000 });
  const service = new DesktopService(store, focus);
  try {
    expect(() => service.execute('start', { taskId: 'missing' })).toThrow();
    service.execute('createTask', { title: 'Fictional task', projectId: null, estimateMinutes: 25 });
    const id = store.snapshot().tasks[0]!.id;
    service.execute('setTaskDone', { id, done: true });
    expect(() => service.execute('start', { taskId: id })).toThrow();
    service.execute('setTaskDone', { id, done: false });
    service.execute('start', { taskId: id });
    expect(service.execute('snapshot').focus.running).toBe(true);
    expect(() => service.execute('settings', { durationMinutes: 10, whitelist: [] })).toThrow();
    service.execute('setTaskDone', { id, done: true });
    expect(service.execute('snapshot').focus.running).toBe(false);
    expect(() => service.execute('unknown')).toThrow();
  } finally { store.close(); }
});

it('routes the new timer modes and pause/resume with validation and task completion', () => {
  const store = new StudyStore(':memory:'); let id = 0;
  const study = new DesktopStudy({ clock: { read: () => ({ wallMs: 0, monotonicMs: 0, utcOffsetMinutes: 0 }) },
    makeId: () => String(++id), sampler: { sample: async () => ({ status: 'unknown', app: null, idleMs: null }) },
    notify: async () => {}, dismiss: () => {}, credit: (taskId, ms) => store.addFocusTime(taskId, ms) });
  const service = new DesktopService(store, study);
  try {
    for (const options of [{ mode: 'bad' }, { idleMinutes: -1 }, { mode: 'pomodoro', policy: { workMinutes: 0 } }]) {
      expect(() => service.execute('start', { taskId: null, ...options })).toThrow();
    }
    expect(service.execute('start', { taskId: null, mode: 'stopwatch' }).focus.timer?.mode).toBe('stopwatch');
    expect(service.execute('pause').focus.timer?.status).toBe('paused');
    expect(() => service.execute('start', { taskId: null })).toThrow();
    expect(() => service.execute('settings', { durationMinutes: 1, whitelist: [] })).toThrow();
    expect(service.execute('resume').focus.timer?.status).toBe('running'); service.execute('stop');
    const task = store.createTask({ title: 'Fictional', projectId: null, estimateMinutes: 25 });
    service.execute('start', { taskId: task.id, mode: 'pomodoro', policy: { workMinutes: 1 } }); service.execute('pause');
    expect(service.execute('setTaskDone', { id: task.id, done: true }).focus.timer?.status).toBe('stopped');
  } finally { store.close(); }
});
