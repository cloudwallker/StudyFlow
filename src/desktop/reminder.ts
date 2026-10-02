import { BrowserWindow, screen } from 'electron';
import { randomBytes } from 'node:crypto';

/** A local reminder window: independent of Windows toast delivery/settings. */
export class DesktopReminder {
  private window: BrowserWindow | null = null;

  dismiss(): void {
    const window = this.window;
    this.window = null;
    if (window && !window.isDestroyed()) window.destroy();
  }

  show(body: string): Promise<void> {
    this.dismiss();
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const width = Math.min(460, area.width);
    const height = Math.min(260, area.height);
    const window = new BrowserWindow({
      width, height, x: area.x + Math.round((area.width - width) / 2),
      y: area.y + Math.round((area.height - height) / 2),
      title: 'StudyFlow 专注提醒', show: false, alwaysOnTop: true,
      focusable: true, frame: false, skipTaskbar: true, resizable: false,
      minimizable: false, maximizable: false, autoHideMenuBar: true,
      backgroundColor: '#f5f6f3',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    this.window = window;
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    const escaped = body.replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[value]!);
    const nonce = randomBytes(18).toString('base64');
    const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'">
      <style>body{margin:0;padding:26px 30px;background:#f5f6f3;color:#24392f;font:15px 'Microsoft YaHei',sans-serif}
      h1{font-size:23px;margin:10px 0 16px}p{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7;margin:0;max-height:95px;overflow:auto}
      footer{margin-top:18px;font-size:12px;color:#65756c}button{position:absolute;right:14px;top:12px;border:0;border-radius:6px;padding:8px 12px;background:#e3eadf;color:#24392f;cursor:pointer;font:inherit}
      #reminder-seconds{font-variant-numeric:tabular-nums}</style>
      <button id="reminder-close" type="button" aria-label="关闭提醒">关闭 ×</button>
      <h1>回到本次学习任务</h1><p>${escaped}</p><footer>提醒将在 <span id="reminder-seconds">8</span> 秒后关闭 · 每 60 秒最多提醒一次</footer>
      <script nonce="${nonce}">
        document.getElementById('reminder-close').addEventListener('click', () => window.close());
        document.addEventListener('keydown', event => { if (event.key === 'Escape') window.close(); });
        window.addEventListener('studyflow-reminder-shown', () => {
          const deadline = performance.now() + 8000;
          const timer = setInterval(() => {
            document.getElementById('reminder-seconds').textContent = String(Math.max(0, Math.ceil((deadline - performance.now()) / 1000)));
          }, 100);
          window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
        }, { once: true });
      </script></html>`;
    return new Promise((resolve, reject) => {
      let settled = false;
      let autoClose: ReturnType<typeof setTimeout> | undefined;
      const fail = () => {
        if (!settled) { settled = true; reject(new Error('居中提醒未能显示')); }
        if (!window.isDestroyed()) window.destroy();
      };
      const loading = setTimeout(fail, 5000);
      window.once('closed', () => {
        clearTimeout(loading); clearTimeout(autoClose);
        if (this.window === window) this.window = null;
        // Cancellation before loading must also settle the pending notification.
        if (!settled) { settled = true; resolve(); }
      });
      window.once('ready-to-show', () => {
        if (window.isDestroyed() || this.window !== window) return;
        clearTimeout(loading);
        window.showInactive();
        void window.webContents.executeJavaScript("window.dispatchEvent(new Event('studyflow-reminder-shown'))").catch(fail);
        settled = true; resolve();
        autoClose = setTimeout(() => { if (!window.isDestroyed()) window.destroy(); }, 8000);
      });
      void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(fail);
    });
  }
}
