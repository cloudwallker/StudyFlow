// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { localDate } from '../src/desktop/calendar-renderer';
import { mountDesktop } from '../src/desktop/renderer';
import { DesktopService } from '../src/desktop/service';
import { DesktopStudy } from '../src/desktop/study';
import { StudyStore } from '../src/desktop/store';

const cleanups: Array<() => void> = [];
const flush = async () => {
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
  else await new Promise(resolve => setTimeout(resolve, 0));
};

function setup() {
  document.documentElement.innerHTML = readFileSync('desktop/index.html', 'utf8');
  const store = new StudyStore(':memory:');
  const a = store.createTask({ title: '阅读', projectId: null, estimateMinutes: 20 });
  const b = store.createTask({ title: '练习', projectId: null, estimateMinutes: 30 });
  store.manage('reorderTasks', { ids: [a.id, b.id] });
  store.savePlan(localDate(), [{ taskId: a.id, minutes: 20 }, { taskId: b.id, minutes: 30 }]);
  const study = new DesktopStudy({
    clock: { read: () => ({ wallMs: 0, monotonicMs: 0, utcOffsetMinutes: 0 }) },
    makeId: () => 'task-menu-session', sampler: { sample: async () => ({ status: 'unknown', app: null, idleMs: null }) },
    notify: async () => {}, dismiss: () => {}, credit: (id, ms) => store.addFocusTime(id, ms),
  });
  const service = new DesktopService(store, study);
  const cleanup = mountDesktop(document, {
    request: async (command, payload) => {
      try { return { ok: true, value: service.execute(command, payload) }; }
      catch (error) { return { ok: false, error: String(error) }; }
    },
  });
  cleanups.push(() => { cleanup(); store.close(); });
  return { store, study, a, b };
}

function taskRow(id: string) {
  const row = document.querySelector<HTMLElement>(`#tasks [data-task-id="${id}"]`);
  expect(row).not.toBeNull();
  return row!;
}

function disclosure(row: HTMLElement) {
  const details = row.querySelector<HTMLDetailsElement>('details.task-action-more');
  expect(details, 'secondary actions need a keyboard and touch accessible disclosure').not.toBeNull();
  return details!;
}

afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.useRealTimers(); });

it.each(['day', 'all'] as const)('opens and closes secondary task actions without losing drafts in the %s view', async mode => {
  const { a, study } = setup(); await flush();
  document.getElementById(`task-view-${mode}`)!.click();
  const row = taskRow(a.id); const more = disclosure(row);
  const editor = document.getElementById('edit-task-form')!;
  const review = document.getElementById('review-accomplished') as HTMLTextAreaElement;
  review.value = '待保存的复盘';
  const edit = row.querySelector<HTMLButtonElement>('[data-edit-task]')!;
  expect(edit.closest('.task-action-menu')?.parentElement).toBe(more);
  expect(more.open).toBe(false);
  let parentClicks = 0; row.addEventListener('click', () => { parentClicks++; });
  const summary = more.querySelector('summary')!;
  expect(summary.getAttribute('aria-label')).toBe('更多任务操作');
  summary.click(); expect(more.open).toBe(true);
  edit.click();
  expect(more.open).toBe(false);
  expect(document.getElementById('task-editor')!.hidden).toBe(false);
  expect((document.getElementById('edit-task-title') as HTMLInputElement).value).toBe('阅读');
  expect(document.activeElement?.id).toBe('edit-task-title');
  expect(document.getElementById('edit-task-form')).toBe(editor);
  expect(review.value).toBe('待保存的复盘');
  expect(study.state().running).toBe(false);
  expect(parentClicks).toBe(0);
  expect(more.querySelector('[aria-label="下移 阅读"]') !== null).toBe(mode === 'all');
});

it('sorts from the all-task disclosure and closes the old menu without triggering the row', async () => {
  const { a, store, study } = setup(); await flush();
  document.getElementById('task-view-all')!.click();
  const row = taskRow(a.id); const more = disclosure(row);
  const up = more.querySelector<HTMLButtonElement>('[aria-label="上移 阅读"]')!;
  const down = more.querySelector<HTMLButtonElement>('[aria-label="下移 阅读"]')!;
  expect(up.disabled).toBe(true); expect(down.disabled).toBe(false);
  let parentClicks = 0; row.addEventListener('click', () => { parentClicks++; });
  more.querySelector('summary')!.click(); down.focus(); down.click();
  expect(more.open).toBe(false);
  expect(document.activeElement).toBe(taskRow(a.id).querySelector('summary'));
  expect(disclosure(taskRow(a.id)).open).toBe(false);
  await flush();
  expect(document.activeElement).toBe(taskRow(a.id).querySelector('summary'));
  expect(Array.from(document.querySelectorAll('#tasks .task-name'), node => node.textContent)).toEqual(['练习', '阅读']);
  expect(store.snapshot().tasks.map(task => task.title)).toEqual(['练习', '阅读']);
  expect(study.state().running).toBe(false); expect(parentClicks).toBe(0);
});

it.each(['day', 'all'] as const)('keeps focus and completion available outside the %s disclosure', async mode => {
  const { a, b, store, study } = setup(); await flush();
  document.getElementById(`task-view-${mode}`)!.click();
  const row = taskRow(a.id); const more = disclosure(row);
  const play = row.querySelector<HTMLButtonElement>('.task-play')!;
  const check = row.querySelector<HTMLButtonElement>('.task-check')!;
  expect(more.contains(play)).toBe(false); expect(more.contains(check)).toBe(false);
  play.click(); await flush();
  expect(study.state()).toMatchObject({ running: true, taskId: a.id });
  expect(taskRow(b.id).querySelector<HTMLButtonElement>('.task-play')!.disabled).toBe(true);
  taskRow(a.id).querySelector<HTMLButtonElement>('.task-check')!.click(); await flush();
  expect(study.state().running).toBe(false);
  expect(store.snapshot().tasks.find(task => task.id === a.id)?.done).toBe(mode === 'all');
  expect(store.daily(localDate()).comparison.find(task => task.taskId === a.id)?.done).toBe(mode === 'day');
});

it.each(['day', 'all'] as const)('keeps an open menu and its focused action during background updates in the %s view', async mode => {
  vi.useFakeTimers();
  const { a, store } = setup(); await flush();
  document.getElementById(`task-view-${mode}`)!.click();
  const more = disclosure(taskRow(a.id)); more.querySelector('summary')!.click();
  more.querySelector<HTMLButtonElement>('[data-edit-task]')!.focus();
  store.addFocusTime(a.id, 60000); await vi.advanceTimersByTimeAsync(1000);
  const refreshed = disclosure(taskRow(a.id));
  expect(refreshed.open).toBe(true);
  expect(document.activeElement).toBe(refreshed.querySelector('[data-edit-task]'));
  expect(taskRow(a.id).querySelector('.task-meta')!.textContent).toContain('剩余 19 分钟');
});

it('returns focus to the menu summary while a focused action is temporarily disabled', async () => {
  const { a } = setup(); await flush();
  disclosure(taskRow(a.id)).querySelector('summary')!.click();
  taskRow(a.id).querySelector<HTMLButtonElement>('[data-edit-task]')!.focus();
  document.getElementById('settings-form')!.dispatchEvent(new Event('submit', { cancelable: true }));
  const busyMenu = disclosure(taskRow(a.id));
  expect(busyMenu.querySelector<HTMLButtonElement>('[data-edit-task]')!.disabled).toBe(true);
  expect(busyMenu.open).toBe(true);
  expect(document.activeElement).toBe(busyMenu.querySelector('summary'));
  await flush();
  expect(disclosure(taskRow(a.id)).open).toBe(true);
  expect(document.activeElement).toBe(taskRow(a.id).querySelector('summary'));
});

it('preserves the correct daily occurrence when the same task also has an overdue plan', async () => {
  vi.useFakeTimers();
  const { a, store } = setup(); await flush();
  const previous = new Date(); previous.setDate(previous.getDate() - 1);
  const previousDate = localDate(previous);
  store.savePlan(previousDate, [{ taskId: a.id, minutes: 20 }]);
  await vi.advanceTimersByTimeAsync(1000);
  const occurrences = () => Array.from(document.querySelectorAll<HTMLElement>(`#tasks [data-task-id="${a.id}"]`));
  const overdueRow = () => occurrences().find(row => row.querySelector('.task-meta')!.textContent!.startsWith(previousDate))!;
  expect(occurrences()).toHaveLength(2);
  const more = disclosure(overdueRow()); more.querySelector('summary')!.click();
  more.querySelector<HTMLButtonElement>('[data-edit-task]')!.focus();
  store.addFocusTime(a.id, 60000); await vi.advanceTimersByTimeAsync(1000);
  expect(disclosure(overdueRow()).open).toBe(true);
  expect(disclosure(occurrences().find(row => row !== overdueRow())!).open).toBe(false);
  expect(document.activeElement).toBe(overdueRow().querySelector('[data-edit-task]'));
});

it('keeps the original editor focused during a background task refresh', async () => {
  vi.useFakeTimers();
  const { a, store } = setup(); await flush();
  const more = disclosure(taskRow(a.id)); more.querySelector('summary')!.click();
  more.querySelector<HTMLButtonElement>('[data-edit-task]')!.click();
  const title = document.getElementById('edit-task-title') as HTMLInputElement;
  title.value = '仍在编辑';
  store.addFocusTime(a.id, 60000); await vi.advanceTimersByTimeAsync(1000);
  expect(disclosure(taskRow(a.id)).open).toBe(false);
  expect(document.getElementById('edit-task-title')).toBe(title);
  expect(title.value).toBe('仍在编辑');
  expect(document.activeElement).toBe(title);
});

it('closes an open task menu with Escape and returns focus to its summary', async () => {
  const { a, study } = setup(); await flush();
  const row = taskRow(a.id); const more = disclosure(row);
  more.querySelector('summary')!.click();
  const edit = more.querySelector<HTMLButtonElement>('[data-edit-task]')!; edit.focus();
  let parentKeys = 0; row.addEventListener('keydown', () => { parentKeys++; });
  edit.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  expect(more.open).toBe(false);
  expect(document.activeElement).toBe(more.querySelector('summary'));
  expect(parentKeys).toBe(0); expect(study.state().running).toBe(false);
});
