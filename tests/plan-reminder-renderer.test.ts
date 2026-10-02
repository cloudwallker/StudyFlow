// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { mountDesktop } from '../src/desktop/renderer';
import { StudyStore } from '../src/desktop/store';
import { DesktopService } from '../src/desktop/service';

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.reverse().forEach(fn => fn()); cleanup.length = 0; vi.useRealTimers(); });
const field = (id: string) => document.getElementById(id) as HTMLInputElement;

async function setup(running = true) {
  document.documentElement.innerHTML = readFileSync('desktop/index.html', 'utf8');
  const store = new StudyStore(':memory:'); cleanup.push(() => store.close());
  const service = new DesktopService(store, {
    state: () => ({ running, taskId: null, remainingSeconds: 60, totalSeconds: 60, app: null, message: '', notification: 'none' }),
    start: () => {}, stop: () => {},
  });
  cleanup.push(mountDesktop(document, { request: async (command, payload) => {
    try { return { ok: true, value: service.execute(command, payload) }; }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : '失败' }; }
  } }));
  await new Promise(resolve => setTimeout(resolve, 0));
  return store;
}

it('saves daily reminders during focus and preserves a draft across background refreshes', async () => {
  const store = await setup();
  expect(field('plan-reminder-enabled')).not.toBeNull();
  expect(field('plan-reminder-enabled').checked).toBe(false);
  field('plan-reminder-enabled').checked = true;
  field('plan-reminder-enabled').dispatchEvent(new Event('change'));
  field('plan-reminder-time').value = '20:30';
  field('plan-reminder-time').dispatchEvent(new Event('input'));
  await new Promise(resolve => setTimeout(resolve, 1050));
  expect(field('plan-reminder-time').value).toBe('20:30');
  expect(field('plan-reminder-save').disabled).toBe(false);
  document.getElementById('plan-reminder-form')!.dispatchEvent(new Event('submit', { cancelable: true }));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(store.snapshot().settings).toMatchObject({ planReminder: { enabled: true, time: '20:30' } });
  expect(document.getElementById('plan-reminder-save-status')!.textContent).toContain('已保存');
  expect(store.snapshot().settings.durationMinutes).toBe(25);
});

it('keeps unsaved timer preferences when only daily reminder settings are saved', async () => {
  await setup(false);
  field('duration').value = '45';
  field('whitelist').value = 'new-draft.exe';
  field('focus-mode').value = 'stopwatch';
  field('focus-mode').dispatchEvent(new Event('change'));
  field('plan-reminder-enabled').checked = true;
  field('plan-reminder-enabled').dispatchEvent(new Event('change'));
  field('plan-reminder-time').value = '20:30';
  field('plan-reminder-time').dispatchEvent(new Event('input'));
  document.getElementById('plan-reminder-form')!.dispatchEvent(new Event('submit', { cancelable: true }));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(field('duration').value).toBe('45');
  expect(field('whitelist').value).toBe('new-draft.exe');
  expect(field('focus-mode').value).toBe('stopwatch');
});

it('rejects an empty reminder time and opens today from the reminder event', async () => {
  const store = await setup();
  expect(field('plan-reminder-time')).not.toBeNull();
  field('plan-reminder-enabled').checked = true;
  field('plan-reminder-enabled').dispatchEvent(new Event('change'));
  field('plan-reminder-time').value = '';
  document.getElementById('plan-reminder-form')!.dispatchEvent(new Event('submit', { cancelable: true }));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(store.snapshot().settings.planReminder?.enabled).toBe(false);
  expect(document.getElementById('plan-reminder-save-status')!.textContent).toContain('时间');
  field('nav-settings').click();
  expect(document.body.dataset.page).toBe('settings');
  document.dispatchEvent(new Event('studyflow-open-today'));
  expect(document.body.dataset.page).toBe('workspace');
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  expect(field('calendar-date').value).toBe(today);
});
