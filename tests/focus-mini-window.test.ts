import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { BrowserWindow, contextBridge, ipcMain, ipcRenderer } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FOCUS_MINI_CHANNEL, type FocusMiniSnapshot } from '../src/desktop/focus-mini-contracts';
import { FocusMiniWindow } from '../src/desktop/focus-mini-window';

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(function (options: Electron.BrowserWindowConstructorOptions) { return new MockWindow(options); }),
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn() },
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
  readonly loading = deferred<void>();
  readonly webContents = Object.assign(new EventEmitter(), {
    mainFrame: { url: '' },
    getURL: () => this.webContents.mainFrame.url,
    setWindowOpenHandler: vi.fn(),
  });
  constructor(readonly options: Electron.BrowserWindowConstructorOptions) { super(); MockWindow.instances.push(this); }
  isDestroyed() { return this.destroyed; }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed'); } }
  showInactive() { this.shown = true; }
  loadFile(path: string) {
    this.webContents.mainFrame.url = pathToFileURL(path).href;
    return this.loading.promise;
  }
}

const pagePath = 'C:\\StudyFlow\\focus-mini.html';
const snapshot: FocusMiniSnapshot = {
  date: '2026-09-12', elapsedMs: 3_661_000, status: 'running', taskTitle: '线性代数',
};
const owned: FocusMiniWindow[] = [];
function setup(overrides: Partial<ConstructorParameters<typeof FocusMiniWindow>[0]> = {}) {
  const options = {
    preloadPath: 'C:\\StudyFlow\\focus-mini-preload.cjs', pagePath,
    onOpenMain: vi.fn(), readSnapshot: vi.fn(() => snapshot), ...overrides,
  };
  const controller = new FocusMiniWindow(options);
  owned.push(controller);
  return { controller, options };
}
function current() { return MockWindow.instances.at(-1)!; }
function trusted(window = current()) {
  return { sender: window.webContents, senderFrame: window.webContents.mainFrame } as unknown as Electron.IpcMainInvokeEvent;
}
async function invoke(command: unknown, event = trusted()) {
  const handler = vi.mocked(ipcMain.handle).mock.calls.at(-1)?.[1];
  expect(handler).toBeTypeOf('function');
  return await handler!(event, command);
}
async function shown(controller: FocusMiniWindow) {
  const pending = controller.show();
  const window = current(); window.loading.resolve(); window.emit('ready-to-show');
  await pending;
  return window;
}

beforeEach(() => { vi.clearAllMocks(); MockWindow.instances = []; });
afterEach(() => { for (const controller of owned.splice(0)) controller.dispose(); vi.useRealTimers(); });

describe('专注小窗主进程', () => {
  it('preload 只暴露快照与受限动作', async () => {
    vi.resetModules();
    await import('../src/desktop/focus-mini-preload');
    expect(contextBridge.exposeInMainWorld).toHaveBeenCalledWith('studyflowFocusMini', expect.any(Object));
    const api = vi.mocked(contextBridge.exposeInMainWorld).mock.calls.at(-1)?.[1] as import('../src/desktop/focus-mini-contracts').FocusMiniAPI;
    await api.snapshot(); await api.act('open-main'); await api.act('close');
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(1, FOCUS_MINI_CHANNEL, 'snapshot');
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(2, FOCUS_MINI_CHANNEL, 'open-main');
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(3, FOCUS_MINI_CHANNEL, 'close');
    const unsafeAct = api.act as (action: string) => Promise<import('../src/desktop/focus-mini-contracts').FocusMiniReply>;
    await expect(unsafeAct('invalid')).resolves.toEqual({ ok: false, error: '不支持的小窗操作' });
  });

  it('注册独立 IPC，并以安全配置创建一个无焦点置顶窗口', async () => {
    const { controller } = setup();
    expect(ipcMain.handle).toHaveBeenCalledWith(FOCUS_MINI_CHANNEL, expect.any(Function));
    const pending = controller.show(); const window = current();
    expect(BrowserWindow).toHaveBeenCalledOnce();
    expect(window.options).toMatchObject({ width: 320, height: 260, frame: false, alwaysOnTop: true,
      show: false, resizable: false, webPreferences: { preload: 'C:\\StudyFlow\\focus-mini-preload.cjs', contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    expect(window.shown).toBe(false);
    window.loading.resolve(); await Promise.resolve(); expect(window.shown).toBe(false);
    window.emit('ready-to-show'); await pending;
    expect(window.shown).toBe(true); expect(window.focused).toBe(false);
    const navigate = { preventDefault: vi.fn() }; const webview = { preventDefault: vi.fn() };
    window.webContents.emit('will-navigate', navigate); window.webContents.emit('will-attach-webview', webview);
    expect(navigate.preventDefault).toHaveBeenCalledOnce(); expect(webview.preventDefault).toHaveBeenCalledOnce();
    expect(window.webContents.setWindowOpenHandler.mock.calls[0]![0]()).toEqual({ action: 'deny' });
  });

  it('重复打开复用窗口，关闭后可重新创建', async () => {
    const { controller } = setup(); const first = await shown(controller);
    await controller.show(); expect(BrowserWindow).toHaveBeenCalledOnce();
    first.destroy(); await shown(controller); expect(BrowserWindow).toHaveBeenCalledTimes(2);
  });

  it('仅向当前页面返回经过校验的快照', async () => {
    const { controller, options } = setup(); const window = await shown(controller);
    expect(await invoke('snapshot')).toEqual({ ok: true, snapshot });
    expect(options.readSnapshot).toHaveBeenCalledOnce();
    for (const invalid of ['sender', 'frame', 'url', 'command'] as const) {
      const event = trusted();
      if (invalid === 'sender') Object.assign(event, { sender: {} });
      if (invalid === 'frame') Object.assign(event, { senderFrame: { url: window.webContents.mainFrame.url } });
      if (invalid === 'url') window.webContents.mainFrame.url = 'https://invalid.example/';
      const result = await invoke(invalid === 'command' ? { type: 'snapshot' } : 'snapshot', event);
      expect(result.ok).toBe(false);
      window.webContents.mainFrame.url = pathToFileURL(pagePath).href;
    }
    expect(options.readSnapshot).toHaveBeenCalledOnce();
  });

  it('打开主界面与关闭动作只接受可信页面调用', async () => {
    const onOpenMain = vi.fn(); const { controller } = setup({ onOpenMain }); const window = await shown(controller);
    expect(await invoke('open-main')).toEqual({ ok: true }); expect(onOpenMain).toHaveBeenCalledOnce();
    expect(window.destroyed).toBe(false);
    expect(await invoke('close')).toEqual({ ok: true }); expect(window.destroyed).toBe(true);
  });

  it('读取异常或无效快照返回通用失败且不泄漏细节', async () => {
    const readSnapshot = vi.fn<() => FocusMiniSnapshot>(() => { throw new Error('C:\\private\\data.db'); });
    const { controller } = setup({ readSnapshot }); await shown(controller);
    expect(await invoke('snapshot')).toEqual({ ok: false, error: '专注小窗暂时无法更新' });
    readSnapshot.mockReturnValue({ ...snapshot, elapsedMs: -1 });
    expect(await invoke('snapshot')).toEqual({ ok: false, error: '专注小窗暂时无法更新' });
    readSnapshot.mockReturnValue({ ...snapshot, elapsedMs: 1000.5 });
    expect(await invoke('snapshot')).toEqual({ ok: true, snapshot: { ...snapshot, elapsedMs: 1000.5 } });
  });

  it.each(['load', 'timeout', 'dispose'] as const)('在 %s 时拒绝未完成的显示并销毁窗口', async mode => {
    vi.useFakeTimers(); const { controller } = setup(); const pending = expect(controller.show()).rejects.toThrow(); const window = current();
    if (mode === 'load') window.loading.reject(new Error('private load details'));
    if (mode === 'timeout') await vi.advanceTimersByTimeAsync(5001);
    if (mode === 'dispose') controller.dispose();
    await pending; expect(window.destroyed).toBe(true); window.emit('ready-to-show'); expect(window.shown).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });

  it('释放时销毁窗口并移除 IPC handler，之后不能再次显示', async () => {
    const { controller } = setup(); const window = await shown(controller);
    controller.dispose(); expect(window.destroyed).toBe(true);
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(FOCUS_MINI_CHANNEL);
    await expect(controller.show()).rejects.toThrow('已释放');
  });
});
