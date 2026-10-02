import { BrowserWindow, ipcMain, screen } from 'electron';
import { randomBytes } from 'node:crypto';
import type { PlanReminderAction, PlanReminderNotice } from './plan-reminder';

export type PlanReminderReply = { ok: true } | { ok: false; error: string };
interface PlanReminderWindowOptions {
  preloadPath: string;
  onAction: (notice: PlanReminderNotice, action: PlanReminderAction) => Promise<void> | void;
}

interface ActiveReminder {
  window: BrowserWindow;
  notice: PlanReminderNotice;
  page: string;
  ready: boolean;
  busy: boolean;
}

const channel = 'studyflow:plan-reminder-action';
const retryMessage = '提醒操作未能保存，请重试。';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

function reminderPage(notice: PlanReminderNotice): string {
  const nonce = randomBytes(18).toString('base64');
  const minutes = notice.tasks.reduce((total, task) => total + task.minutes, 0);
  const items = notice.tasks.slice(0, 5).map(task => `<li><span>${escapeHtml(task.title)}</span><small>${task.minutes} 分钟</small></li>`).join('');
  const remaining = notice.tasks.length > 5 ? `<p class="remaining">还有 ${notice.tasks.length - 5} 项，查看今天可见完整计划。</p>` : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'">
    <title>StudyFlow 每日计划提醒</title>
    <style>
      *{box-sizing:border-box}body{margin:0;padding:26px 28px;background:#f5f6f3;color:#24392f;font:14px 'Microsoft YaHei',sans-serif}
      h1{font-size:23px;margin:14px 0 8px}p{line-height:1.6;margin:0}.eyebrow,.remaining{color:#65756c;font-size:12px}
      .summary{font-size:15px}ul{padding:0;margin:16px 0 10px;list-style:none;max-height:215px;overflow:auto}
      li{display:flex;gap:12px;justify-content:space-between;align-items:baseline;padding:8px 0;border-bottom:1px solid #dfe6dc}
      li span{overflow-wrap:anywhere;min-width:0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}small{flex-shrink:0;color:#65756c}
      footer{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}button{border:0;border-radius:7px;padding:9px 13px;background:#e3eadf;color:#24392f;cursor:pointer;font:inherit}
      button[data-action="open"]{background:#315d48;color:white}button:disabled{cursor:wait;opacity:.55}button:focus-visible{outline:2px solid #315d48;outline-offset:3px}
      #plan-reminder-close{position:absolute;right:14px;top:12px;padding:6px 10px;font-size:12px}
      #plan-reminder-error{margin-top:12px;color:#9d342f;font-size:12px;min-height:20px}
    </style></head><body>
    <button id="plan-reminder-close" type="button" aria-label="关闭提醒">关闭 ×</button>
    <p class="eyebrow">STUDYFLOW · ${escapeHtml(notice.date)}</p><h1>今天的计划，准备开始</h1>
    <p class="summary">今天还有 ${notice.tasks.length} 项未完成 · ${minutes} 分钟</p><ul>${items}</ul>${remaining}
    <footer><button type="button" data-action="open">查看今天</button><button type="button" data-action="snooze">10 分钟后</button><button type="button" data-action="dismiss">今日忽略</button></footer>
    <p id="plan-reminder-error" role="alert" aria-live="polite"></p>
    <script nonce="${nonce}">
      const buttons = Array.from(document.querySelectorAll('[data-action]'));
      const error = document.getElementById('plan-reminder-error');
      let busy = false;
      for (const button of buttons) button.addEventListener('click', async () => {
        if (busy) return;
        busy = true; error.textContent = ''; buttons.forEach(item => { item.disabled = true; });
        try {
          const reply = await window.studyflowPlanReminder.act(button.dataset.action);
          if (!reply || !reply.ok) throw new Error('save failed');
        } catch {
          error.textContent = '${retryMessage}';
          busy = false; buttons.forEach(item => { item.disabled = false; });
        }
      });
      document.getElementById('plan-reminder-close').addEventListener('click', () => window.close());
      document.addEventListener('keydown', event => { if (event.key === 'Escape') window.close(); });
    </script></body></html>`;
}

/** Owns one local plan reminder; persisted scheduling remains in PlanReminder. */
export class PlanReminderWindow {
  private active: ActiveReminder | null = null;
  private disposed = false;

  constructor(private readonly options: PlanReminderWindowOptions) {
    ipcMain.handle(channel, (event, action: unknown) => this.act(event, action));
  }

  async show(notice: PlanReminderNotice): Promise<void> {
    if (this.disposed) throw new Error('每日计划提醒已停止');
    this.dismiss();
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const width = Math.min(500, area.width);
    const height = Math.min(490, area.height);
    const window = new BrowserWindow({
      width, height, x: area.x + Math.round((area.width - width) / 2), y: area.y + Math.round((area.height - height) / 2),
      title: 'StudyFlow 每日计划提醒', show: false, alwaysOnTop: true,
      focusable: true, frame: false, skipTaskbar: true, resizable: false,
      minimizable: false, maximizable: false, autoHideMenuBar: true, backgroundColor: '#f5f6f3',
      webPreferences: { preload: this.options.preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    const page = `data:text/html;charset=utf-8,${encodeURIComponent(reminderPage(notice))}`;
    const active: ActiveReminder = { window, notice, page, ready: false, busy: false };
    this.active = active;
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = () => {
        if (!settled) { settled = true; reject(new Error('每日计划提醒未能显示')); }
        clearTimeout(loading);
        if (!window.isDestroyed()) window.destroy();
      };
      const loading = setTimeout(fail, 5000);
      window.once('closed', () => {
        clearTimeout(loading);
        if (this.active === active) this.active = null;
        if (!settled) { settled = true; reject(new Error('每日计划提醒已取消')); }
      });
      window.webContents.once('render-process-gone', fail);
      window.webContents.on('did-fail-load', (_event, _code, _description, _url, isMainFrame) => { if (isMainFrame) fail(); });
      window.once('ready-to-show', () => {
        if (window.isDestroyed() || this.active !== active) return;
        try {
          window.showInactive();
          active.ready = true;
          clearTimeout(loading);
          settled = true; resolve();
        } catch { fail(); }
      });
      try { void window.loadURL(page).catch(fail); } catch { fail(); }
    });
  }

  dismiss(): void {
    const active = this.active;
    this.active = null;
    if (active && !active.window.isDestroyed()) active.window.destroy();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.dismiss();
    ipcMain.removeHandler(channel);
  }

  private async act(event: Electron.IpcMainInvokeEvent, action: unknown): Promise<PlanReminderReply> {
    const active = this.active;
    if (!active || this.disposed || !active.ready || active.window.isDestroyed()
      || event.sender !== active.window.webContents
      || event.senderFrame !== active.window.webContents.mainFrame
      || event.senderFrame.url !== active.page || event.sender.getURL() !== active.page
      || (action !== 'open' && action !== 'snooze' && action !== 'dismiss')) {
      return { ok: false, error: '提醒操作已失效' };
    }
    if (active.busy) return { ok: false, error: '提醒操作正在处理中，请稍候。' };
    active.busy = true;
    try {
      await this.options.onAction(active.notice, action);
      if (this.active === active) this.dismiss();
      return { ok: true };
    } catch {
      return { ok: false, error: retryMessage };
    } finally { active.busy = false; }
  }
}
