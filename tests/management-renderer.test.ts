// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { mountDesktop } from '../src/desktop/renderer';
import { StudyStore } from '../src/desktop/store';
import { DesktopService } from '../src/desktop/service';
it('edits, searches, archives and restores through real controls', async () => {
  document.documentElement.innerHTML = readFileSync('desktop/index.html', 'utf8');
  const store = new StudyStore(':memory:'); const task = store.createTask({ title: '阅读', projectId: null, estimateMinutes: 20 });
  const service = new DesktopService(store, { state: () => ({ running: false, taskId: null, remainingSeconds: 0, totalSeconds: 0, app: null, message: '', notification: 'none' }), start() {}, stop() {} });
  const cleanup = mountDesktop(document, { request: async (cmd, payload) => { try { return { ok: true, value: service.execute(cmd, payload) }; } catch (e) { return { ok: false, error: String(e) }; } } });
  const flush = () => new Promise(resolve => setTimeout(resolve, 0));
  const field = (id: string) => document.getElementById(id) as HTMLInputElement;
  try {
    await flush(); expect(document.querySelector('[data-edit-task]')).not.toBeNull();
    document.querySelector<HTMLButtonElement>('[data-edit-task]')!.click();
    field('edit-task-title').value = '数学练习'; field('edit-task-tags').value = '数学, 考试';
    document.getElementById('edit-task-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await flush();
    expect(store.snapshot().tasks[0]).toMatchObject({ title: '数学练习', tags: ['数学', '考试'] });
    field('task-search').value = '不存在'; field('task-search').dispatchEvent(new Event('input'));
    expect(document.querySelector('#tasks [data-task-id]')).toBeNull();
    field('task-search').value = '考试'; field('task-search').dispatchEvent(new Event('input'));
    expect(document.querySelector('#tasks [data-task-id]')).not.toBeNull();
    document.querySelector<HTMLButtonElement>('[data-edit-task]')!.click();
    document.getElementById('edit-task-archive')!.click(); await flush();
    expect(store.snapshot().tasks).toHaveLength(0);
    document.querySelector<HTMLButtonElement>(`[data-restore-task="${task.id}"]`)!.click(); await flush();
    expect(store.snapshot().tasks).toHaveLength(1);
  } finally { cleanup(); store.close(); }
});
it('moves an uncompleted scheduled task with a calendar drop and keeps repeated day checkins independent', async () => {
  document.documentElement.innerHTML = readFileSync('desktop/index.html', 'utf8');
  const store = new StudyStore(':memory:'); const task = store.createTask({ title: '每日练习', projectId: null, estimateMinutes: 20 });
  const d = new Date(); const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const next = new Date(d); next.setDate(next.getDate() + 1); const target = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
  store.savePlan(day, [{ taskId: task.id, minutes: 20 }]);
  const service = new DesktopService(store, { state: () => ({ running: false, taskId: null, remainingSeconds: 0, totalSeconds: 0, app: null, message: '', notification: 'none' }), start() {}, stop() {} });
  const cleanup = mountDesktop(document, { request: async (cmd, payload) => ({ ok: true, value: service.execute(cmd, payload) }) });
  const flush = () => new Promise(resolve => setTimeout(resolve, 0));
  try {
    await flush(); const article = document.querySelector<HTMLElement>('#tasks [data-task-id]')!;
    article.dispatchEvent(new Event('dragstart', { bubbles: true }));
    // Keep the source mounted while selecting the destination date.
    const date = document.getElementById('calendar-date') as HTMLInputElement; date.value = target; date.dispatchEvent(new Event('change'));
    document.querySelector<HTMLElement>(`[data-date="${target}"]`)!.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true })); await flush();
    expect(store.daily(day).plan?.entries).toHaveLength(0);
    expect(store.daily(target).plan?.entries[0]?.taskId).toBe(task.id);
    document.querySelector<HTMLButtonElement>('#tasks .task-check')!.click(); await flush();
    expect(store.daily(target).comparison[0]?.done).toBe(true); expect(store.snapshot().tasks[0]?.done).toBe(false);
  } finally { cleanup(); store.close(); }
});
