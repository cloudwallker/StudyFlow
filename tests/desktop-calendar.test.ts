// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { mountDesktop } from '../src/desktop/renderer';
import { StudyStore } from '../src/desktop/store';
import { DesktopService } from '../src/desktop/service';

it('shows the selected day before overdue work, hides future tasks, and persists makeup completion', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 8, 10, 12));
  document.documentElement.innerHTML = readFileSync('desktop/index.html', 'utf8');
  const store = new StudyStore(':memory:');
  const first = store.createTask({ title: '第1天｜阅读', projectId: null, estimateMinutes: 10 });
  const second = store.createTask({ title: '第2天｜练习', projectId: null, estimateMinutes: 20 });
  const last = store.createTask({ title: '第14天｜验收', projectId: null, estimateMinutes: 10 });
  store.savePlan('2026-09-09', [{ taskId: first.id, minutes: 10 }]);
  store.savePlan('2026-09-10', [{ taskId: second.id, minutes: 20 }]);
  store.savePlan('2026-09-22', [{ taskId: last.id, minutes: 10 }]);
  const starts: unknown[] = [];
  const service = new DesktopService(store, { state: () => ({ running: false, taskId: null, remainingSeconds: 0, totalSeconds: 0, app: null, message: '', notification: 'none' }), start: id => { starts.push(id); }, stop() {} });
  const cleanup = mountDesktop(document, { request: async (cmd, payload) => ({ ok: true, value: service.execute(cmd, payload) }) });
  const flush = () => new Promise(r => setTimeout(r, 0));
  try {
    await flush();
    const text = document.getElementById('tasks')!.textContent!;
    expect(text).not.toContain('第14天');
    expect(text.indexOf('第2天')).toBeLessThan(text.indexOf('第1天'));
    const makeup = document.querySelector<HTMLButtonElement>('[data-makeup]'); expect(makeup).not.toBeNull();
    makeup!.click(); await flush();
    expect(store.daily('2026-09-09').comparison.find(t => t.taskId === first.id)?.done).toBe(true);
    expect(store.snapshot().tasks.find(t => t.id === first.id)?.done).toBe(false);
    expect(store.daily('2026-09-09').effectiveMs).toBe(0);
    expect(document.querySelector('[data-makeup]')).toBeNull();
    document.querySelector<HTMLButtonElement>('#tasks .task-play')!.click(); await flush();
    expect(starts).toEqual([second.id]);
    document.getElementById('calendar-expand')!.click();
    const day = document.querySelector<HTMLButtonElement>('[data-date="2026-09-22"]'); expect(day).not.toBeNull(); day!.click();
    expect(document.getElementById('tasks')!.textContent).toContain('第14天');
    document.getElementById('calendar-today')!.click();
    expect(document.getElementById('tasks')!.textContent).not.toContain('第14天');
    vi.setSystemTime(new Date(2026, 8, 11, 0, 1)); await new Promise(r => setTimeout(r, 1100));
    expect((document.getElementById('calendar-date') as HTMLInputElement).value).toBe('2026-09-11');
    expect(document.querySelector<HTMLButtonElement>('[data-makeup]')?.dataset.makeup).toBe(second.id);
  } finally { cleanup(); store.close(); vi.useRealTimers(); }
});

it('reads saved plans in date order instead of reverse task insertion order', () => {
  const store = new StudyStore(':memory:');
  try {
    const a = store.createTask({ title: 'first', projectId: null, estimateMinutes: 10 });
    store.savePlan('2026-09-11', [{ taskId: a.id, minutes: 10 }]);
    store.savePlan('2026-09-10', [{ taskId: a.id, minutes: 20 }]);
    expect(store.snapshot()).toHaveProperty('plans', [
      { date: '2026-09-10', entries: [{ taskId: a.id, title: 'first', minutes: 20 }] },
      { date: '2026-09-11', entries: [{ taskId: a.id, title: 'first', minutes: 10 }] },
    ]);
  } finally { store.close(); }
});
