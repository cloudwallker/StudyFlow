// @vitest-environment jsdom
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { contextBridge, ipcMain, ipcRenderer } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlanReminderWindow } from '../src/desktop/plan-reminder-window';

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(function (options: Electron.BrowserWindowConstructorOptions) { return new MockWindow(options); }),
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn() },
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class MockWindow extends EventEmitter {
  static instances: MockWindow[] = [];
  destroyed = false;
  shown = false;
  focused = false;
  url = '';
  readonly loading = deferred<void>();
  readonly webContents = Object.assign(new EventEmitter(), {
    mainFrame: { url: '' },
    getURL: () => this.url,
    setWindowOpenHandler: vi.fn(),
  });
  constructor(readonly options: Electron.BrowserWindowConstructorOptions) { super(); MockWindow.instances.push(this); }
  isDestroyed() { return this.destroyed; }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed'); } }
  showInactive() { this.shown = true; }
  show() { this.shown = true; this.focused = true; }
  loadURL(url: string) { this.url = url; this.webContents.mainFrame.url = url; return this.loading.promise; }
}

const notice = { token: 'notice-1', date: '2026-09-12', tasks: [
  { taskId: '1', title: '<img src="https://invalid.example/x" onerror="window.hacked=true"> & "复习"', minutes: 25 },
  { taskId: '2', title: '阅读', minutes: 15 }, { taskId: '3', title: '练习', minutes: 10 },
  { taskId: '4', title: '笔记', minutes: 5 }, { taskId: '5', title: '总结', minutes: 5 },
  { taskId: '6', title: '额外任务', minutes: 30 },
] };
const owned: PlanReminderWindow[] = [];
function setup(onAction = vi.fn<(value: typeof notice, action: 'open' | 'snooze' | 'dismiss') => Promise<void> | void>()) {
  const reminder = new PlanReminderWindow({ preloadPath: 'C:\\studyflow\\plan-reminder-preload.cjs', onAction });
  owned.push(reminder);
  return { reminder, onAction };
}
function current() { return MockWindow.instances.at(-1)!; }
function trusted(window = current()) {
  return { sender: window.webContents, senderFrame: window.webContents.mainFrame } as unknown as Electron.IpcMainInvokeEvent;
}
async function action(value: unknown, event = trusted()) {
  const handler = vi.mocked(ipcMain.handle).mock.calls.at(-1)?.[1];
  expect(handler).toBeTypeOf('function');
  return await handler!(event, value);
}
async function shown(reminder: PlanReminderWindow, value = notice) {
  const pending = reminder.show(value);
  const window = current(); window.loading.resolve(); window.emit('ready-to-show');
  await pending;
  return window;
}
function mountPage(window = current(), request = (value: string) => action(value)) {
  document.documentElement.innerHTML = decodeURIComponent(window.url.slice(window.url.indexOf(',') + 1));
  const scripts = Array.from(document.querySelectorAll('script'));
  const pageWindow = { studyflowPlanReminder: { act: request }, close: () => window.destroy() };
  for (const script of scripts) runInNewContext(script.textContent ?? '', { document, window: pageWindow });
  return document;
}

beforeEach(() => { vi.clearAllMocks(); MockWindow.instances = []; });
afterEach(() => { for (const reminder of owned.splice(0)) reminder.dispose(); vi.useRealTimers(); });

describe('每日计划提醒窗口', () => {
  it('注册独立动作接口并在释放时移除', () => {
    const { reminder } = setup();
    expect(ipcMain.handle).toHaveBeenCalledWith('studyflow:plan-reminder-action', expect.any(Function));
    reminder.dispose();
    expect(ipcMain.removeHandler).toHaveBeenCalledWith('studyflow:plan-reminder-action');
  });

  it('只有实际展示后才完成，并保持后台弹出不抢焦点及安全沙盒', async () => {
    const { reminder } = setup();
    let finished = false;
    const pending = reminder.show(notice).then(() => { finished = true; });
    const window = current(); window.loading.resolve();
    await Promise.resolve(); expect(finished).toBe(false); expect(window.shown).toBe(false);
    window.emit('ready-to-show'); await pending;
    expect(window.shown).toBe(true); expect(window.focused).toBe(false);
    expect(window.options).toMatchObject({ title: 'StudyFlow 每日计划提醒', show: false, focusable: true,
      webPreferences: { preload: 'C:\\studyflow\\plan-reminder-preload.cjs', contextIsolation: true, nodeIntegration: false, sandbox: true } });
    const navigate = { preventDefault: vi.fn() }; window.webContents.emit('will-navigate', navigate);
    expect(navigate.preventDefault).toHaveBeenCalledOnce();
    expect(window.webContents.setWindowOpenHandler.mock.calls[0]![0]()).toEqual({ action: 'deny' });
  });

  it('汇总所有待办时长，只展示五条并将标题作为文本处理', async () => {
    const { reminder } = setup(); await shown(reminder); const page = mountPage();
    expect(page.body.textContent).toContain('6 项'); expect(page.body.textContent).toContain('90 分钟');
    expect(page.querySelectorAll('li')).toHaveLength(5);
    expect(page.querySelector('li')?.textContent).toContain(notice.tasks[0]!.title);
    expect(page.querySelector('img')).toBeNull(); expect(page.body.textContent).toContain('还有 1 项');
    expect(page.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')).toContain("default-src 'none'");
  });

  it.each(['load', 'timeout', 'dismiss', 'dispose'] as const)('在展示前 %s 时结束等待并销毁窗口，晚到事件不会展示', async mode => {
    vi.useFakeTimers(); const { reminder } = setup();
    const pending = expect(reminder.show(notice)).rejects.toThrow(); const window = current();
    if (mode === 'load') window.loading.reject(new Error('private load details'));
    if (mode === 'timeout') await vi.advanceTimersByTimeAsync(5001);
    if (mode === 'dismiss') reminder.dismiss();
    if (mode === 'dispose') reminder.dispose();
    await pending; expect(window.destroyed).toBe(true);
    window.emit('ready-to-show'); expect(window.shown).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('替换提醒时取消旧加载，旧窗口动作不能操作新提醒', async () => {
    const { reminder, onAction } = setup();
    const oldPending = expect(reminder.show(notice)).rejects.toThrow(); const old = current();
    await shown(reminder, { ...notice, token: 'notice-2' }); await oldPending;
    expect((await action('snooze', trusted(old))).ok).toBe(false); expect(onAction).not.toHaveBeenCalled();
    expect(current().destroyed).toBe(false);
  });

  it('展示前动作不写入，底层展示异常会拒绝等待而不是报告成功', async () => {
    const { reminder, onAction } = setup();
    const pending = expect(reminder.show(notice)).rejects.toThrow(); const window = current();
    expect((await action('open')).ok).toBe(false); expect(onAction).not.toHaveBeenCalled();
    window.showInactive = () => { throw new Error('show failed'); };
    window.emit('ready-to-show'); await pending; expect(window.destroyed).toBe(true);
  });

  it.each(['sender', 'frame', 'page', 'command'] as const)('拒绝伪造 %s 的 IPC 动作', async invalid => {
    const { reminder, onAction } = setup(); const window = await shown(reminder);
    const event = trusted();
    if (invalid === 'sender') Object.assign(event, { sender: {} });
    if (invalid === 'frame') Object.assign(event, { senderFrame: { url: window.url } });
    if (invalid === 'page') window.webContents.mainFrame.url = 'https://invalid.example/';
    const result = await action(invalid === 'command' ? { action: 'open' } : 'open', event);
    expect(result.ok).toBe(false); expect(onAction).not.toHaveBeenCalled(); expect(window.destroyed).toBe(false);
  });

  it.each(['open', 'snooze', 'dismiss'] as const)('%s 等保存成功后关闭，重复动作不会并发写入', async value => {
    const saving = deferred<void>(); const onAction = vi.fn(() => saving.promise); const { reminder } = setup(onAction);
    const window = await shown(reminder); const pending = action(value);
    expect(window.destroyed).toBe(false); expect((await action(value)).ok).toBe(false);
    expect(onAction).toHaveBeenCalledExactlyOnceWith(notice, value);
    saving.resolve(); expect((await pending).ok).toBe(true); expect(window.destroyed).toBe(true);
  });

  it('保存失败保留窗口并恢复按钮，显示通用错误后用户可重试', async () => {
    const saving = deferred<void>();
    const onAction = vi.fn().mockImplementationOnce(() => saving.promise).mockResolvedValue(undefined);
    const { reminder } = setup(onAction); const window = await shown(reminder); const page = mountPage();
    const snooze = page.querySelector<HTMLButtonElement>('[data-action="snooze"]')!;
    snooze.click(); expect(snooze.disabled).toBe(true); snooze.click(); expect(onAction).toHaveBeenCalledOnce();
    saving.reject(new Error('C:\\private\\database.sqlite secret task'));
    await vi.waitFor(() => expect(snooze.disabled).toBe(false));
    expect(window.destroyed).toBe(false); expect(page.querySelector('[role="alert"]')?.textContent).toContain('重试');
    expect(page.body.textContent).not.toContain('private');
    snooze.click(); await vi.waitFor(() => expect(window.destroyed).toBe(true)); expect(onAction).toHaveBeenCalledTimes(2);
  });

  it('保存回调关闭已展示的提醒仍成功，旧保存返回不会关闭新窗口', async () => {
    const saving = deferred<void>(); const onAction = vi.fn().mockImplementationOnce(() => saving.promise);
    const { reminder } = setup(onAction); const first = await shown(reminder);
    const pending = action('snooze'); reminder.dismiss();
    expect(first.destroyed).toBe(true);
    const second = await shown(reminder, { ...notice, token: 'notice-2' });
    saving.resolve(); expect((await pending).ok).toBe(true); expect(second.destroyed).toBe(false);
    onAction.mockImplementationOnce(() => reminder.dismiss());
    expect((await action('open')).ok).toBe(true); expect(second.destroyed).toBe(true);
  });

  it('渲染进程崩溃清理窗口和展示等待，没有自动重复弹窗', async () => {
    vi.useFakeTimers(); const { reminder } = setup();
    const pending = expect(reminder.show(notice)).rejects.toThrow(); const window = current();
    window.webContents.emit('render-process-gone', {}, { reason: 'crashed' }); await pending;
    expect(window.destroyed).toBe(true); await vi.advanceTimersByTimeAsync(60_000);
    expect(MockWindow.instances).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
  });

  it('关闭按钮和 Escape 仅关闭本次提醒，释放 IPC 后不能再显示', async () => {
    const { reminder, onAction } = setup();
    const first = await shown(reminder); mountPage().getElementById('plan-reminder-close')!.click();
    expect(first.destroyed).toBe(true); expect(onAction).not.toHaveBeenCalled();
    const second = await shown(reminder); mountPage().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(second.destroyed).toBe(true); expect(onAction).not.toHaveBeenCalled();
    reminder.dispose(); expect(ipcMain.removeHandler).toHaveBeenCalledWith('studyflow:plan-reminder-action');
    await expect(reminder.show(notice)).rejects.toThrow();
  });
});

it('专属 preload 只暴露三个动作，不提供通用 IPC 或任意通道', async () => {
  vi.mocked(ipcRenderer.invoke).mockResolvedValue({ ok: true });
  await import('../src/desktop/plan-reminder-preload');
  const [name, exposed] = vi.mocked(contextBridge.exposeInMainWorld).mock.calls[0]!;
  expect(name).toBe('studyflowPlanReminder'); expect(Object.keys(exposed)).toEqual(['act']);
  const api = exposed as { act: (value: unknown) => Promise<{ ok: boolean }> };
  expect((await api.act('deleteHistory')).ok).toBe(false);
  expect((await api.act({ action: 'open' })).ok).toBe(false);
  expect(ipcRenderer.invoke).not.toHaveBeenCalled();
  for (const value of ['open', 'snooze', 'dismiss']) {
    expect((await api.act(value)).ok).toBe(true);
    expect(ipcRenderer.invoke).toHaveBeenLastCalledWith('studyflow:plan-reminder-action', value);
  }
});
