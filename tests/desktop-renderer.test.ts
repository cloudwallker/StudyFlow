// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { mountDesktop } from '../src/desktop/renderer';
import type { DesktopSnapshot } from '../src/desktop/contracts';
import { DesktopService } from '../src/desktop/service';
import { DesktopStudy } from '../src/desktop/study';
import { StudyStore } from '../src/desktop/store';

it('saves sound controls and overrides the next phase through the real desktop service', async () => {
  document.documentElement.innerHTML = readFileSync('desktop/index.html', 'utf8');
  let time = 0; let id = 0;
  const store = new StudyStore(':memory:');
  const study = new DesktopStudy({ clock: { read: () => ({ monotonicMs: time, wallMs: time, utcOffsetMinutes: 0 }) },
    makeId: () => String(++id), sampler: { sample: async () => ({ status: 'unknown', app: null, idleMs: null }) },
    notify: async () => {}, dismiss: () => {}, credit: () => {} });
  const service = new DesktopService(store, study);
  const cleanup = mountDesktop(document, { request: async (command, payload) => {
    try { return { ok: true, value: service.execute(command, payload) }; }
    catch (error) { return { ok: false, error: String(error) }; }
  } });
  const flush = () => new Promise(r => setTimeout(r, 0));
  const input = (id: string) => document.getElementById(id) as HTMLInputElement;
  try {
    await flush();
    expect(input('pomo-sound-enabled')).not.toBeNull();
    input('focus-mode').value = 'pomodoro'; input('focus-mode').dispatchEvent(new Event('change'));
    input('pomo-work').value = '1';
    input('pomo-sound-enabled').checked = true; input('pomo-sound-enabled').dispatchEvent(new Event('change'));
    input('pomo-sound-min').value = '2'; input('pomo-sound-max').value = '7'; input('pomo-sound-volume').value = '35';
    document.getElementById('settings-form')!.dispatchEvent(new Event('submit', { cancelable: true })); await flush();
    expect(store.snapshot().settings.sound).toMatchObject({ enabled: true, minMinutes: 2, maxMinutes: 7, volume: 35 });
    input('focus-toggle').click(); await flush(); time = 60000; await study.tick();
    // Request a snapshot through the existing command path, avoiding a real one-second wait.
    input('focus-mode').dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 1050));
    expect(input('pomo-next').disabled).toBe(false);
    input('pomo-next').value = '10'; input('focus-pause').click(); await flush();
    expect(study.state().timer).toMatchObject({ phase: 'short-break', remainingMs: 600000 });
  } finally { cleanup(); study.stop(); store.close(); }
});

it('saves and reloads daily review and a task allocation through the UI', async () => {
  document.documentElement.innerHTML = readFileSync('desktop/index.html', 'utf8');
  const store = new StudyStore(':memory:');
  store.createTask({ title: '<b>Daily task</b>', projectId: null, estimateMinutes: 25 });
  const service = new DesktopService(store, { state: () => ({ running: false, taskId: null, remainingSeconds: 0, totalSeconds: 0, app: null, message: '', notification: 'none' }), start: () => {}, stop: () => {} });
  const cleanup = mountDesktop(document, { request: async (command, payload) => ({ ok: true, value: service.execute(command, payload) }) });
  const flush = () => new Promise(r => setTimeout(r, 0));
  try {
    await flush();
    expect(document.querySelector('#daily-date')).not.toBeNull();
    expect(document.querySelector('#daily-panel h2')?.textContent).toBe('每日学习与复盘');
    expect(document.querySelector('#daily-review-form')?.textContent).toContain('明天调整');
    (document.querySelector('#daily-date') as HTMLInputElement).value = '2026-09-10';
    document.querySelector('#daily-load')!.dispatchEvent(new Event('click')); await flush();
    (document.querySelector('#review-accomplished') as HTMLTextAreaElement).value = '完成阅读';
    document.querySelector('#daily-review-form')!.dispatchEvent(new Event('submit', { cancelable: true })); await flush();
    expect(store.daily('2026-09-10').review.accomplished).toBe('完成阅读');
    (document.querySelector('#plan-entries input[type=checkbox]') as HTMLInputElement).checked = true;
    (document.querySelector('#plan-entries input[type=number]') as HTMLInputElement).value = '40';
    document.querySelector('#daily-plan-form')!.dispatchEvent(new Event('submit', { cancelable: true })); await flush();
    expect(store.daily('2026-09-10').plan?.entries[0]?.minutes).toBe(40);
    expect(document.querySelector('#daily-comparison')?.textContent).toContain('40');
    expect(document.querySelector('#plan-entries b')).toBeNull();
  } finally { cleanup(); store.close(); }
});

it('renders untrusted task text safely and submits explicit task input', async () => {
  document.documentElement.innerHTML = readFileSync('desktop/index.html', 'utf8');
  const data: DesktopSnapshot = { projects: [], tasks: [{ id: '1', title: '<img src=x onerror=alert(1)>', done: false, projectId: null, estimateMinutes: 25, spentMs: 0 }],
    settings: { durationMinutes: 25, whitelist: [] }, focus: { running: false, taskId: null, remainingSeconds: 0, totalSeconds: 0, app: null, message: 'Ready', notification: 'none' } };
  const writes: unknown[] = [];
  const cleanup = mountDesktop(document, { request: async (command, payload) => { if (command === 'createTask') writes.push(payload); return { ok: true, value: data }; } });
  await new Promise(r => setTimeout(r, 0));
  expect(document.querySelector('#tasks img')).toBeNull();
  expect(document.getElementById('tasks')?.textContent).toContain('<img');
  (document.getElementById('task-title') as HTMLInputElement).value = 'Read';
  document.getElementById('task-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await new Promise(r => setTimeout(r, 0));
  expect(writes).toEqual([{ title: 'Read', projectId: null, estimateMinutes: 25 }]);
  cleanup();
});

it('starts selected modes, pauses/resumes, and requires confirmation of the next pomodoro phase', async () => {
  document.documentElement.innerHTML = readFileSync('desktop/index.html', 'utf8');
  let time = 0; let id = 0;
  const store = new StudyStore(':memory:');
  const study = new DesktopStudy({ clock: { read: () => ({ wallMs: time, monotonicMs: time, utcOffsetMinutes: 0 }) },
    makeId: () => String(++id), sampler: { sample: async () => ({ status: 'ok', app: 'Code.exe', idleMs: 0 }) },
    notify: async () => {}, dismiss: () => {}, credit: (taskId, ms) => store.addFocusTime(taskId, ms) });
  const service = new DesktopService(store, study);
  const cleanup = mountDesktop(document, { request: async (command, payload) => {
    try { return { ok: true, value: service.execute(command, payload) }; }
    catch (error) { return { ok: false, error: (error as Error).message }; }
  } });
  const flush = () => new Promise(r => setTimeout(r, 0));
  const field = (name: string) => document.getElementById(name) as HTMLInputElement;
  const click = async (name: string) => { document.getElementById(name)!.click(); await flush(); };
  try {
    await flush(); expect(field('focus-mode')).not.toBeNull();
    field('focus-mode').value = 'stopwatch'; field('focus-mode').dispatchEvent(new Event('change'));
    await click('focus-toggle'); expect(study.state().timer?.mode).toBe('stopwatch');
    await click('focus-pause'); expect(study.state().timer?.status).toBe('paused'); expect(field('focus-mode').disabled).toBe(true);
    await click('focus-pause'); expect(study.state().timer?.status).toBe('running'); await click('focus-toggle');
    field('focus-mode').value = 'pomodoro'; field('focus-mode').dispatchEvent(new Event('change')); field('pomo-work').value = '1';
    await click('focus-toggle'); await study.tick(); time = 60000; await study.tick();
    // The main-process tick is reflected by the renderer's normal snapshot polling.
    await new Promise(r => setTimeout(r, 1100));
    expect(document.getElementById('focus-pause')?.textContent).toContain('下一阶段');
    await click('focus-pause'); expect(study.state().timer).toMatchObject({ phase: 'short-break', status: 'running' });
    await click('focus-toggle');
    field('idle-minutes').value = '-1'; await click('focus-toggle');
    expect(document.getElementById('error')?.hidden).toBe(false); expect(study.state().timer?.status).toBe('stopped');
    field('focus-mode').value = 'stopwatch'; field('focus-mode').dispatchEvent(new Event('change'));
    expect(document.getElementById('timer')?.textContent).toBe('00:00');
  } finally { cleanup(); store.close(); }
});

it('persists application recording opt-in and deletes reviews through the desktop UI', async () => {
  document.documentElement.innerHTML = readFileSync('desktop/index.html', 'utf8');
  const store = new StudyStore(':memory:');
  const focus = new DesktopStudy({ clock: { read: () => ({ wallMs: 0, monotonicMs: 0, utcOffsetMinutes: 0 }) },
    makeId: () => 'ui-session', sampler: { sample: async () => ({ status: 'unknown', app: null, idleMs: null }) },
    notify: async () => {}, dismiss: () => {}, credit: () => {} });
  const service = new DesktopService(store, focus);
  const cleanup = mountDesktop(document, { request: async (command, payload) => ({ ok: true, value: service.execute(command, payload) }) });
  const flush = () => new Promise(r => setTimeout(r, 0));
  try {
    await flush(); const checkbox = document.getElementById('record-app-activity') as HTMLInputElement;
    expect(checkbox.checked).toBe(false); checkbox.checked = true;
    document.getElementById('settings-form')!.dispatchEvent(new Event('submit', { cancelable: true })); await flush();
    expect(store.snapshot().settings.recordAppActivity).toBe(true);
    store.saveReview('2026-09-09', 'fiction');
    (document.getElementById('history-date') as HTMLInputElement).value = '2026-09-09';
    document.getElementById('history-delete-form')!.dispatchEvent(new Event('submit', { cancelable: true })); await flush();
    expect(store.history('2026-09-09').review).toBeNull();
    expect(document.getElementById('history-status')!.textContent).toContain('已删除');
  } finally { cleanup(); store.close(); }
});


it('saves long-focus controls, previews event volume, and renders both paused countdowns', async () => {
  document.documentElement.innerHTML = readFileSync('desktop/index.html', 'utf8');
  const store = new StudyStore(':memory:'); let time = 0; let id = 0;
  const played: number[] = [];
  const study = new DesktopStudy({ clock: { read: () => ({ monotonicMs: time, wallMs: time, utcOffsetMinutes: 0 }) },
    makeId: () => String(++id), sampler: { sample: async () => ({ status: 'unknown', app: null, idleMs: null }) },
    notify: async () => {}, dismiss: () => {}, credit: () => {}, sound: { play: async (_kind, config) => { played.push(config.volume); }, stop: () => {} } });
  const service = new DesktopService(store, study);
  const cleanup = mountDesktop(document, { request: async (command, payload) => {
    try { return { ok: true, value: service.execute(command, payload) }; }
    catch (error) { return { ok: false, error: String(error) }; }
  } });
  const flush = () => new Promise(r => setTimeout(r, 0));
  const input = (id: string) => document.getElementById(id) as HTMLInputElement;
  try {
    await flush();
    input('focus-mode').value = 'pomodoro'; input('focus-mode').dispatchEvent(new Event('change'));
    expect(input('long-enabled')).not.toBeNull();
    input('long-enabled').checked = true; input('long-enabled').dispatchEvent(new Event('change'));
    input('micro-enabled').checked = true; input('micro-enabled').dispatchEvent(new Event('change'));
    input('micro-min').value = '1'; input('micro-max').value = '1';
    input('pomo-sound-enabled').checked = true; input('pomo-sound-enabled').dispatchEvent(new Event('change'));
    input('sound-micro-start-volume').value = '19'; input('sound-micro-start-preview').click(); await flush();
    expect(played).toEqual([19]);
    document.getElementById('settings-form')!.dispatchEvent(new Event('submit', { cancelable: true })); await flush();
    expect(store.snapshot().settings).toMatchObject({ longFocus: { enabled: true, microEnabled: true, minMinutes: 1, maxMinutes: 1 }, sound: { events: { 'micro-start': { volume: 19 } } } });
    input('focus-toggle').click(); await flush(); time = 65000; await study.tick();
    input('focus-pause').click(); await flush();
    expect(document.getElementById('timer')!.textContent).toBe('58:55');
    expect(document.getElementById('micro-countdown')!.textContent).toContain('微休息剩余 5 秒');
    expect(document.getElementById('learning-summary')!.textContent).toContain('微休息 5 秒');
    expect(input('micro-min').disabled).toBe(true);
  } finally { cleanup(); study.stop(); store.close(); }
});
