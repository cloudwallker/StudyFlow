// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mountDesktop } from '../src/desktop/renderer';
import { StudyStore } from '../src/desktop/store';
import { DesktopService } from '../src/desktop/service';
import { localDate } from '../src/desktop/calendar-renderer';

it.each(['success', 'lost-reply'] as const)('keeps review drafts writable after import %s', async outcome => {
  document.documentElement.innerHTML = readFileSync('desktop/index.html', 'utf8');
  const store = new StudyStore(':memory:');
  const service = new DesktopService(store, { state: () => ({ running: false, taskId: null, remainingSeconds: 0, totalSeconds: 0, app: null, message: '', notification: 'none' }), start() {}, stop() {} });
  const cleanup = mountDesktop(document, { request: async (cmd, payload) => {
    const value = service.execute(cmd, payload);
    if (cmd === 'confirmImport' && outcome === 'lost-reply') throw new Error('reply lost');
    return { ok: true, value };
  } });
  const wait = () => new Promise(r => setTimeout(r, 40));
  try {
    await wait();
    const notes = document.getElementById('review-accomplished') as HTMLTextAreaElement;
    notes.value = '导入前未保存的复盘'; notes.dispatchEvent(new Event('input', { bubbles: true }));
    const input = document.querySelector<HTMLInputElement>('#import-file')!;
    const content = JSON.stringify({ schemaVersion: 1, tasks: [{ taskKey: 'draft', project: '', title: '导入任务', estimateMinutes: 25 }], plans: [] });
    Object.defineProperty(input, 'files', { value: [new File([content], 'plan.json')] });
    input.dispatchEvent(new Event('change')); await wait();
    document.getElementById('import-confirm')!.click(); await wait();
    document.getElementById('daily-review-form')!.dispatchEvent(new Event('submit', { cancelable: true })); await wait();
    expect(store.daily(localDate()).review.accomplished).toBe('导入前未保存的复盘');
    expect(store.snapshot().tasks).toHaveLength(1);
  } finally { cleanup(); store.close(); }
});

it('blocks import for an edited daily plan and keeps that plan savable', async () => {
  document.documentElement.innerHTML = readFileSync('desktop/index.html', 'utf8');
  const store = new StudyStore(':memory:');
  const task = store.createTask({ title: '原计划任务', projectId: null, estimateMinutes: 20 });
  const service = new DesktopService(store, { state: () => ({ running: false, taskId: null, remainingSeconds: 0, totalSeconds: 0, app: null, message: '', notification: 'none' }), start() {}, stop() {} });
  const cleanup = mountDesktop(document, { request: async (cmd, payload) => ({ ok: true, value: service.execute(cmd, payload) }) });
  const wait = () => new Promise(r => setTimeout(r, 40));
  try {
    await wait();
    const check = document.querySelector<HTMLInputElement>('#plan-entries input[type=checkbox]')!;
    check.checked = true; check.dispatchEvent(new Event('input', { bubbles: true }));
    const input = document.querySelector<HTMLInputElement>('#import-file')!;
    const content = JSON.stringify({ schemaVersion: 1, tasks: [{ taskKey: 'new', project: '', title: '新任务', estimateMinutes: 25 }], plans: [] });
    Object.defineProperty(input, 'files', { value: [new File([content], 'plan.json')] });
    input.dispatchEvent(new Event('change')); await wait();
    document.getElementById('import-confirm')!.click(); await wait();
    expect(store.snapshot().tasks).toHaveLength(1);
    document.getElementById('daily-plan-form')!.dispatchEvent(new Event('submit', { cancelable: true })); await wait();
    expect(store.daily(localDate()).plan?.entries).toMatchObject([{ taskId: task.id, minutes: 20 }]);
    document.getElementById('import-repreview')!.click(); await wait();
    document.getElementById('import-confirm')!.click(); await wait();
    expect(store.snapshot().tasks).toHaveLength(2);
  } finally { cleanup(); store.close(); }
});

it('selects a JSON file, safely previews, cancels and confirms through the desktop UI', async () => {
  document.documentElement.innerHTML = readFileSync('desktop/index.html', 'utf8');
  const store = new StudyStore(':memory:');
  store.createProject('原有项目');
  const service = new DesktopService(store, { state: () => ({ running: false, taskId: null, remainingSeconds: 0, totalSeconds: 0, app: null, message: '', notification: 'none' }), start() {}, stop() {} });
  const cleanup = mountDesktop(document, { request: async (cmd, payload) => {
    try { return { ok: true, value: service.execute(cmd, payload) }; } catch (e) { return { ok: false, error: (e as Error).message }; }
  } });
  const wait = () => new Promise(r => setTimeout(r, 40));
  try {
    await wait();
    document.querySelector<HTMLButtonElement>('#projects button')!.click();
    const input = document.querySelector<HTMLInputElement>('#import-file'); expect(input).not.toBeNull();
    const content = JSON.stringify({ schemaVersion: 1, tasks: [{ taskKey: 'x', project: '', title: '<img src=x>', estimateMinutes: 25 }], plans: [{ date: '2026-09-11', taskKey: 'x', minutes: 25 }] });
    Object.defineProperty(input, 'files', { configurable: true, value: [new File([content], 'plan.json', { type: 'application/json' })] });
    input!.dispatchEvent(new Event('change')); await wait();
    expect(document.querySelector('#import-preview')?.textContent).toContain('<img src=x>');
    expect(document.querySelector('#import-preview img')).toBeNull(); expect(store.snapshot().tasks).toHaveLength(0);
    document.getElementById('import-cancel')!.click(); await wait();
    expect(store.snapshot().tasks).toHaveLength(0); expect(document.getElementById('import-preview')?.hidden).toBe(true);
    input!.dispatchEvent(new Event('change')); await wait();
    document.getElementById('import-confirm')!.click(); await wait();
    expect(store.snapshot().tasks).toHaveLength(1);
    expect(document.getElementById('tasks')?.textContent).toContain('<img src=x>');
    expect(document.getElementById('daily-status')?.textContent).toContain('重新读取');
    input!.dispatchEvent(new Event('change')); await wait();
    expect(document.getElementById('import-status')?.textContent).toContain('已导入');
    expect((document.getElementById('import-confirm') as HTMLButtonElement).disabled).toBe(true);
  } finally { cleanup(); store.close(); }
});

it('blocks stale daily writes while the import confirmation reply is pending', async () => {
  document.documentElement.innerHTML = readFileSync('desktop/index.html', 'utf8');
  const store = new StudyStore(':memory:'); store.createTask({ title: 'Old task', projectId: null, estimateMinutes: 20 });
  const service = new DesktopService(store, { state: () => ({ running: false, taskId: null, remainingSeconds: 0, totalSeconds: 0, app: null, message: '', notification: 'none' }), start() {}, stop() {} });
  let release = () => {}; let saves = 0;
  const cleanup = mountDesktop(document, { request: async (cmd, payload) => {
    if (cmd === 'savePlan') saves++;
    const value = service.execute(cmd, payload);
    if (cmd === 'confirmImport') await new Promise<void>(resolve => { release = resolve; });
    return { ok: true, value };
  } });
  const wait = () => new Promise(r => setTimeout(r, 40));
  try {
    await wait();
    (document.getElementById('daily-date') as HTMLInputElement).value = '2026-09-11'; document.getElementById('daily-load')!.click(); await wait();
    (document.querySelector('#plan-entries input[type=checkbox]') as HTMLInputElement).checked = true;
    const input = document.querySelector<HTMLInputElement>('#import-file')!;
    const content = JSON.stringify({ schemaVersion: 1, tasks: [{ taskKey: 'new', project: '', title: 'New task', estimateMinutes: 25 }], plans: [{ date: '2026-09-11', taskKey: 'new', minutes: 25 }] });
    Object.defineProperty(input, 'files', { value: [new File([content], 'plan.json')] }); input.dispatchEvent(new Event('change')); await wait();
    document.getElementById('import-confirm')!.click(); await wait();
    document.getElementById('daily-plan-form')!.dispatchEvent(new Event('submit', { cancelable: true })); await wait();
    expect(saves).toBe(0); expect(store.daily('2026-09-11').plan?.entries[0]?.title).toBe('New task');
    release(); await wait();
    document.getElementById('daily-plan-form')!.dispatchEvent(new Event('submit', { cancelable: true })); await wait();
    expect(saves).toBe(0);
  } finally { release(); cleanup(); store.close(); }
});

it('requires an explicit per-task update choice and shows the before/after preview', async () => {
  document.documentElement.innerHTML = readFileSync('desktop/index.html', 'utf8');
  const store = new StudyStore(':memory:');
  const service = new DesktopService(store, { state: () => ({ running: false, taskId: null, remainingSeconds: 0, totalSeconds: 0, app: null, message: '', notification: 'none' }), start() {}, stop() {} });
  const original = JSON.stringify({ schemaVersion: 1, tasks: [{ taskKey: 'same', project: '', title: '旧标题', estimateMinutes: 20 }], plans: [] });
  const first = service.execute('previewImport', { content: original }).importPreview!;
  service.execute('confirmImport', { token: first.token });
  store.createProject('导航项目');
  const cleanup = mountDesktop(document, { request: async (cmd, payload) => {
    try { return { ok: true, value: service.execute(cmd, payload) }; } catch (e) { return { ok: false, error: (e as Error).message }; }
  } });
  const wait = () => new Promise(r => setTimeout(r, 40));
  try {
    await wait(); document.querySelector<HTMLButtonElement>('#projects button')!.click();
    const input = document.querySelector<HTMLInputElement>('#import-file')!;
    const changed = JSON.stringify({ schemaVersion: 1, tasks: [{ taskKey: 'same', project: '', title: '新标题', estimateMinutes: 35 }], plans: [] });
    Object.defineProperty(input, 'files', { configurable: true, value: [new File([changed], 'update.json')] });
    input.dispatchEvent(new Event('change')); await wait();
    const update = document.querySelector<HTMLInputElement>('#import-updates input[value="same"]')!;
    expect(update.checked).toBe(false); expect(document.getElementById('import-confirm')).toHaveProperty('disabled', true);
    update.checked = true; update.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('import-repreview')!.click(); await wait();
    expect(document.getElementById('import-updates')?.textContent).toContain('旧标题');
    expect(document.getElementById('import-updates')?.textContent).toContain('新标题');
    expect(document.getElementById('import-confirm')).toHaveProperty('disabled', false);
    document.getElementById('import-confirm')!.click(); await wait();
    expect(store.snapshot().tasks[0]).toMatchObject({ title: '新标题', estimateMinutes: 35 });
  } finally { cleanup(); store.close(); }
});
