// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { mountPlugin } from '../src/plugin';

const html = readFileSync('plugin/index.html', 'utf8');
let dispose = () => {};
afterEach(() => { dispose(); document.body.innerHTML = ''; vi.restoreAllMocks(); vi.useRealTimers(); });
function setup(api: unknown, fetchFn?: typeof fetch) {
  document.documentElement.innerHTML = html;
  dispose = mountPlugin(document, api, fetchFn);
}
const click = (id: string) => document.getElementById(id)!.click();

it('does not create tasks on load; only probe button writes once while pending', async () => {
  let resolve!: (id: string) => void;
  const addTask = vi.fn(() => new Promise<string>(r => { resolve = r; }));
  setup({ addTask });
  expect(addTask).not.toHaveBeenCalled();
  click('create-probe'); click('create-probe');
  expect(addTask).toHaveBeenCalledExactlyOnceWith({ title: '[StudyFlow PoC] Plugin API probe' });
  resolve('fictional-id');
  await vi.waitFor(() => expect(document.getElementById('tasks')!.textContent).toContain('已创建'));
});
it('shows task count without rendering raw task titles', async () => {
  const showSnack = vi.fn();
  setup({ getTasks: async () => [{ id: '1', title: '<img src=x onerror=alert(1)>' }], showSnack });
  click('check-api');
  await vi.waitFor(() => expect(document.getElementById('tasks')!.textContent).toContain('1'));
  expect(document.querySelector('img')).toBeNull();
  expect(showSnack).toHaveBeenCalled();
});
it('loads without host API, marks compatibility error, disables corresponding controls', () => {
  setup(undefined);
  expect(document.getElementById('capabilities')!.textContent).toContain('getTasks: unavailable');
  expect(document.getElementById('last-error')!.textContent).toContain('compatibility error');
  expect((document.getElementById('create-probe') as HTMLButtonElement).disabled).toBe(true);
});
it('disposal removes click listeners', () => {
  const addTask = vi.fn();
  setup({ addTask }); dispose(); click('create-probe');
  expect(addTask).not.toHaveBeenCalled();
});

function activityFetch(app = 'Fictional Notepad') {
  return vi.fn<typeof fetch>(async input => new Response(JSON.stringify(String(input).includes('/events?')
    ? [{ id: 1, timestamp: new Date(Date.now()).toISOString(), duration: 0, data: { app, title: 'Private fictional title' } }]
    : { custom: { id: 'custom', type: 'currentwindow', client: 'aw-watcher-window', hostname: 'fictional-pc' } })));
}
it('wires real AW adapter, guard, and host notification through Start/Stop buttons', async () => {
  vi.useFakeTimers();
  const notify = vi.fn().mockResolvedValue(undefined);
  const fetchFn = activityFetch();
  setup({ notify }, fetchFn);
  click('start-focus'); await vi.advanceTimersByTimeAsync(0);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(document.getElementById('current-app')!.textContent).toBe('Fictional Notepad');
  expect((document.getElementById('start-focus') as HTMLButtonElement).disabled).toBe(true);
  click('stop-focus'); const calls = fetchFn.mock.calls.length;
  await vi.advanceTimersByTimeAsync(65000);
  expect(fetchFn).toHaveBeenCalledTimes(calls);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(document.getElementById('focus-status')!.textContent).toBe('Stopped');
});
it('uses editable exact whitelist and renders untrusted app only as text', async () => {
  vi.useFakeTimers();
  const notify = vi.fn().mockResolvedValue(undefined);
  setup({ notify }, activityFetch('<img src=x onerror=alert(1)>'));
  (document.getElementById('whitelist') as HTMLTextAreaElement).value = ' <IMG SRC=X ONERROR=ALERT(1)> ';
  click('start-focus'); await vi.advanceTimersByTimeAsync(0);
  expect(notify).not.toHaveBeenCalled();
  expect(document.querySelector('img')).toBeNull();
  expect(document.getElementById('current-app')!.textContent).toContain('<img');
});
it('checks AW independently when task host is missing and displays safe network errors', async () => {
  setup(null, async () => { throw Error('private raw network detail'); });
  click('check-aw');
  await vi.waitFor(() => expect(document.getElementById('last-error')!.textContent).toContain('ActivityWatch not available'));
  expect(document.body.textContent).not.toContain('private raw');
});
it('waits for official ready and registers unload cleanup', async () => {
  vi.useFakeTimers();
  let ready = () => {}; let unload = () => {};
  const notify = vi.fn().mockResolvedValue(undefined);
  const fetchFn = activityFetch();
  setup({ notify, onReady: (fn: () => void) => { ready = fn; }, onUnload: (fn: () => void) => { unload = fn; } }, fetchFn);
  click('start-focus'); expect(fetchFn).not.toHaveBeenCalled();
  ready(); click('start-focus'); await vi.advanceTimersByTimeAsync(0);
  expect(notify).toHaveBeenCalledTimes(1);
  unload(); const calls = fetchFn.mock.calls.length;
  await vi.advanceTimersByTimeAsync(65000);
  expect(fetchFn).toHaveBeenCalledTimes(calls);
  expect(vi.getTimerCount()).toBe(0);
});
it('pagehide aborts pending AW reads and ignores their late results', async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | null | undefined;
  const fetchFn = vi.fn<typeof fetch>((_url, init) => { signal = init?.signal; return new Promise(() => {}); });
  const notify = vi.fn();
  setup({ notify }, fetchFn);
  click('start-focus'); window.dispatchEvent(new Event('pagehide'));
  await vi.advanceTimersByTimeAsync(65000);
  expect(signal?.aborted).toBe(true);
  expect(fetchFn).toHaveBeenCalledTimes(1);
  expect(notify).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('diagnoses whitelist transitions and cooldown without claiming visible notification delivery', async () => {
  vi.useFakeTimers();
  const notify = vi.fn().mockResolvedValue(undefined);
  const fetchFn = activityFetch('Super Productivity.exe');
  setup({ notify }, fetchFn);
  (document.getElementById('whitelist') as HTMLTextAreaElement).value = 'Super Productivity.exe';
  click('start-focus'); await vi.advanceTimersByTimeAsync(0);
  const diagnostic = () => document.getElementById('focus-diagnostic')?.textContent ?? '';
  expect(diagnostic()).toContain('判断：allowed');
  expect(diagnostic()).toContain('采样次数：1');
  expect(notify).not.toHaveBeenCalled();
  fetchFn.mockImplementation(activityFetch('Fictional Notepad'));
  await vi.advanceTimersByTimeAsync(3000);
  expect(diagnostic()).toContain('判断：not-allowed');
  expect(diagnostic()).toContain('通知调用次数：1');
  expect(diagnostic()).toContain('通知状态：returned');
  expect(diagnostic()).toContain('不代表 Windows 已显示');
  await vi.advanceTimersByTimeAsync(3000);
  expect(diagnostic()).toContain('判断：cooldown');
  expect(diagnostic()).toContain('最近通知 app：Fictional Notepad');
  expect(notify).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).not.toContain('Private fictional title');
});

it('exposes pending notification and ignores its completion after Stop', async () => {
  vi.useFakeTimers();
  let resolve!: () => void;
  const notify = vi.fn(() => new Promise<void>(r => { resolve = r; }));
  setup({ notify }, activityFetch());
  click('start-focus'); await vi.advanceTimersByTimeAsync(0);
  expect(document.getElementById('focus-diagnostic')?.textContent).toContain('通知状态：pending');
  click('stop-focus');
  const stopped = document.getElementById('focus-diagnostic')?.textContent;
  expect(stopped).toContain('阶段：stopped');
  resolve(); await vi.advanceTimersByTimeAsync(65000);
  expect(document.getElementById('focus-diagnostic')?.textContent).toBe(stopped);
  expect(vi.getTimerCount()).toBe(0);
});

it('retains failed notification evidence across cooldown without exposing raw errors', async () => {
  vi.useFakeTimers();
  const notify = vi.fn().mockRejectedValue(Error('fictional private host detail'));
  setup({ notify }, activityFetch());
  click('start-focus'); await vi.advanceTimersByTimeAsync(3000);
  expect(document.getElementById('focus-diagnostic')?.textContent).toContain('通知状态：failed');
  expect(document.getElementById('focus-diagnostic')?.textContent).toContain('判断：cooldown');
  expect(document.body.textContent).not.toContain('fictional private host detail');
  expect(notify).toHaveBeenCalledTimes(1);
});
