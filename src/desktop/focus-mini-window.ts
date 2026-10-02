import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserWindow, ipcMain } from 'electron';
import { FOCUS_MINI_CHANNEL, type FocusMiniReply, type FocusMiniSnapshot, type FocusMiniStatus } from './focus-mini-contracts';

export interface FocusMiniWindowOptions {
  preloadPath: string;
  pagePath: string;
  onOpenMain: () => Promise<void> | void;
  readSnapshot: () => FocusMiniSnapshot;
}

const statuses: readonly FocusMiniStatus[] = ['idle', 'running', 'paused', 'waiting', 'break', 'stopped'];

function snapshot(value: FocusMiniSnapshot): FocusMiniSnapshot {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.date)
    || typeof value.elapsedMs !== 'number' || !Number.isFinite(value.elapsedMs) || value.elapsedMs < 0
    || !statuses.includes(value.status)
    || (value.taskTitle !== null && (typeof value.taskTitle !== 'string' || value.taskTitle.length > 200))) {
    throw new Error('无效的专注小窗快照');
  }
  return { ...value };
}

/** Owns one optional focus mini window and its trusted IPC boundary. */
export class FocusMiniWindow {
  private window: BrowserWindow | null = null;
  private opening: Promise<BrowserWindow> | null = null;
  private disposed = false;
  private readonly pageUrl: string;

  constructor(private readonly options: FocusMiniWindowOptions) {
    this.pageUrl = pathToFileURL(resolve(options.pagePath)).href;
    ipcMain.handle(FOCUS_MINI_CHANNEL, (event, command: unknown) => this.request(event, command));
  }

  async show(): Promise<void> {
    if (this.disposed) throw new Error('专注小窗已释放');
    const current = this.window;
    if (current && !current.isDestroyed() && !this.opening) { current.showInactive(); return; }
    const window = await (this.opening ?? this.open());
    if (this.window === window && !window.isDestroyed()) window.showInactive();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const window = this.window;
    this.window = null;
    if (window && !window.isDestroyed()) window.destroy();
    ipcMain.removeHandler(FOCUS_MINI_CHANNEL);
  }

  private open(): Promise<BrowserWindow> {
    const window = new BrowserWindow({
      width: 320, height: 260, minWidth: 320, minHeight: 260,
      title: 'StudyFlow 专注小窗', show: false, alwaysOnTop: true,
      focusable: true, frame: false, skipTaskbar: true, resizable: false,
      minimizable: false, maximizable: false, autoHideMenuBar: true,
      backgroundColor: '#f5f6f3',
      webPreferences: { preload: this.options.preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    this.window = window;
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-attach-webview', event => event.preventDefault());

    const opening = new Promise<BrowserWindow>((yes, no) => {
      let settled = false;
      const fail = () => {
        if (!settled) { settled = true; clearTimeout(timeout); no(new Error('专注小窗未能显示')); }
        if (!window.isDestroyed()) window.destroy();
      };
      const ready = () => {
        if (settled || this.disposed || this.window !== window || window.isDestroyed()) return;
        settled = true; clearTimeout(timeout); yes(window);
      };
      const timeout = setTimeout(fail, 5_000);
      window.once('closed', () => {
        if (this.window === window) this.window = null;
        if (!settled) fail();
      });
      window.once('ready-to-show', ready);
      window.webContents.once('render-process-gone', fail);
      window.webContents.on('did-fail-load', (_event, _code, _description, _url, isMainFrame) => { if (isMainFrame) fail(); });
      try { void window.loadFile(this.options.pagePath).catch(fail); } catch { fail(); }
    });
    this.opening = opening;
    void opening.finally(() => { if (this.opening === opening) this.opening = null; }).catch(() => undefined);
    return opening;
  }

  private async request(event: Electron.IpcMainInvokeEvent, command: unknown): Promise<FocusMiniReply> {
    const window = this.window;
    if (this.disposed || !window || window.isDestroyed()
      || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
      || event.senderFrame.url !== this.pageUrl || event.sender.getURL() !== this.pageUrl) {
      return { ok: false, error: '无效请求来源' };
    }
    if (command === 'snapshot') {
      try { return { ok: true, snapshot: snapshot(this.options.readSnapshot()) }; }
      catch { return { ok: false, error: '专注小窗暂时无法更新' }; }
    }
    if (command === 'open-main') {
      try { await this.options.onOpenMain(); return { ok: true }; }
      catch { return { ok: false, error: '主界面未能打开' }; }
    }
    if (command === 'close') {
      this.window = null;
      window.destroy();
      return { ok: true };
    }
    return { ok: false, error: '不支持的小窗操作' };
  }
}
