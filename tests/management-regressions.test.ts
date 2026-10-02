// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { mountDesktop } from '../src/desktop/renderer';
import { StudyStore } from '../src/desktop/store';
import { DesktopService } from '../src/desktop/service';
import { localDate } from '../src/desktop/calendar-renderer';
const cleanups: Array<() => void> = [];
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
function setup(prepare: (store: StudyStore) => void) {
  document.documentElement.innerHTML = readFileSync('desktop/index.html', 'utf8'); const store = new StudyStore(':memory:'); prepare(store);
  const service = new DesktopService(store, { state: () => ({ running: false, taskId: null, remainingSeconds: 0, totalSeconds: 0, app: null, message: '', notification: 'none' }), start() {}, stop() {} });
  const cleanup = mountDesktop(document, { request: async (command, payload) => { try { return { ok: true, value: service.execute(command, payload) }; } catch (error) { return { ok: false, error: String(error) }; } } });
  cleanups.push(() => { cleanup(); store.close(); }); return store;
}
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()));
it('moves according to visual order rather than reverse creation order', async () => {
  const store = setup(s => {
    const a = s.createTask({ title: 'A', projectId: null, estimateMinutes: 20 });
    const b = s.createTask({ title: 'B', projectId: null, estimateMinutes: 20 });
    s.savePlan('2026-09-10', [{ taskId: a.id, minutes: 20 }]); s.savePlan('2026-09-11', [{ taskId: b.id, minutes: 20 }]);
  });
  await flush(); document.getElementById('task-view-all')!.click();
  expect(document.querySelector('#tasks .task-name')!.textContent).toBe('A');
  const down = document.querySelector<HTMLButtonElement>('[aria-label="下移 A"]')!;
  expect(down.disabled).toBe(false); down.click(); await flush();
  expect(Array.from(document.querySelectorAll('#tasks .task-name')).map(node => node.textContent)).toEqual(['B', 'A']);
  expect(store.snapshot().tasks.map(t => t.title)).toEqual(['B', 'A']);
});
it('round trips a daily plan whose only task is archived', async () => {
  const date = localDate(); const store = setup(s => { const task = s.createTask({ title: '保留的历史任务', projectId: null, estimateMinutes: 20 }); s.savePlan(date, [{ taskId: task.id, minutes: 20 }]); s.manage('archiveTask', { id: task.id, archived: true }); });
  await flush(); expect(document.querySelector('#plan-entries input[type=checkbox]')).not.toBeNull();
  document.getElementById('daily-plan-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await flush();
  expect(store.daily(date).plan?.entries).toHaveLength(1);
});
it('keeps unsaved review writable after changing a category', async () => {
  const date = localDate(); const store = setup(() => {}); await flush();
  const notes = document.getElementById('review-accomplished') as HTMLTextAreaElement; notes.value = '尚未保存的复盘'; notes.dispatchEvent(new Event('input', { bubbles: true }));
  (document.getElementById('categories-batch') as HTMLTextAreaElement).value = 'fixture.exe,学习';
  document.getElementById('categories-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await flush();
  document.getElementById('daily-review-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await flush();
  expect(store.daily(date).review.accomplished).toBe('尚未保存的复盘');
});
