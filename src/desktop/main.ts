import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, powerMonitor, dialog, session } from 'electron';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { StudyStore } from './store';
import { DesktopStudy } from './study';
import { WindowsActivitySource } from './activity';
import { DesktopService } from './service';
import { DesktopReminder } from './reminder';
import { DailyPlanReminder } from './plan-reminder';
import { PlanReminderWindow } from './plan-reminder-window';
import { FocusMiniWindow } from './focus-mini-window';
import { DesktopSound } from './sound';
import type { Reply } from './contracts';
import { prepareQuit } from './lifecycle';
import { buildInfo } from './build-info';
import { DiagnosticRuntime } from './diagnostic-runtime';
import { safeError, isExpectedRejection } from './diagnostics';
import { createElectronAmbientAudio, type AmbientAudioController } from './ambient-audio';

app.setName(buildInfo.test ? 'StudyFlow Test' : 'StudyFlow');
app.setAppUserModelId(buildInfo.test ? 'StudyFlow.Test' : 'StudyFlow.Desktop');
if (buildInfo.test) app.setPath('userData', join(app.getPath('appData'), 'StudyFlow-Test'));
// Tests use a dedicated database directory; production uses the user's app data.
if (process.env.STUDYFLOW_DATA_DIR) {
  const path = resolve(process.env.STUDYFLOW_DATA_DIR); mkdirSync(path, { recursive: true }); app.setPath('userData', path);
}
let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let store: StudyStore | null = null;
let focus: DesktopStudy | null = null;
let source: WindowsActivitySource | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
let planTimer: ReturnType<typeof setInterval> | undefined;
let planReminder: DailyPlanReminder | null = null;
let planWindow: PlanReminderWindow | null = null;
let focusMiniWindow: FocusMiniWindow | null = null;
let planRemindersEnabled = false;
let locked = false; let suspended = false;
let diagnostic: DiagnosticRuntime | null = null;
let fatal = false;
let ambient: AmbientAudioController | null = null;
let ambientWindow: BrowserWindow | null = null;
function syncAmbient(): void {
  const state = focus?.state();
  const active = state?.timer ? state.timer.status === 'running' && state.timer.phase === 'work' && !state.timer.microResting : state?.running === true;
  void ambient?.setFocusActive(active);
  syncPlanReminderState();
}
function syncPlanReminderState(): void {
  planReminder?.setBlocked(locked || suspended || !planRemindersEnabled || focus?.state().running === true);
}
const reminder = new DesktopReminder();
const sound = new DesktopSound(join(__dirname, 'native', 'StudyFlowSound.exe'));
function cleanup(force = false): boolean {
  if (quitting) return true;
  const saved = prepareQuit(focus);
  if (!saved && !force) return false;
  quitting = true; clearInterval(timer); clearInterval(planTimer); source?.dispose();
  planReminder?.dispose(); planWindow?.dispose();
  focusMiniWindow?.dispose();
  ipcMain.removeHandler('studyflow:focus-mini-open');
  reminder.dismiss();
  sound.stop();
  void ambient?.dispose();
  if (ambientWindow && !ambientWindow.isDestroyed()) ambientWindow.destroy();
  ipcMain.removeHandler('studyflow:ambient-audio');
  store?.close(); tray?.destroy(); tray = null;
  diagnostic?.finish(saved && !fatal);
  return true;
}

function showWindow(): void {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show(); window.focus();
}
async function openFocusMini(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    if (quitting || !focusMiniWindow) throw new Error('小窗不可用');
    await focusMiniWindow.show();
    return { ok: true };
  } catch {
    diagnostic?.log.record('focus_mini_open_failed');
    return { ok: false, error: '专注小窗未能打开，请重试' };
  }
}
function showSaveFailure(): void {
  showWindow();
  dialog.showErrorBox('尚未退出', '最后一次历史保存失败。待保存数据仍在内存中，请检查存储后重新结束计时或退出。');
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  if (buildInfo.test) {
    const fail = (event: string, error: unknown) => {
      diagnostic?.log.record(event, safeError(error));
      if (fatal) return;
      fatal = true; clearInterval(timer);
      source?.dispose(); diagnostic?.finish(false);
      // Do not keep using database or business state after an unexpected fatal error.
      app.exit(1);
    };
    process.on('uncaughtException', error => fail('uncaught_exception', error));
    process.on('unhandledRejection', error => fail('unhandled_rejection', error));
  }
  app.on('second-instance', showWindow);
  app.whenReady().then(async () => {
    const directory = app.getPath('userData'); mkdirSync(directory, { recursive: true });
    if (buildInfo.test) diagnostic = new DiagnosticRuntime(directory);
    store = new StudyStore(join(directory, 'studyflow.sqlite'));
    source = new WindowsActivitySource(join(__dirname, 'native', 'StudyFlowSampler.exe'), (event, fields) => diagnostic?.log.record(event, fields));
    const save = (area: 'history' | 'activity', operation: () => void) => {
      try { operation(); diagnostic?.log.record('save_ok', { area }); }
      catch (error) { diagnostic?.log.record('save_failed', { area, ...safeError(error) }); throw error; }
    };
    focus = new DesktopStudy({ sampler: source, sound, notify: async body => {
      try { await reminder.show(body); diagnostic?.log.record('notification_sent'); }
      catch (error) { diagnostic?.log.record('notification_failed', safeError(error)); throw error; }
    }, dismiss: () => reminder.dismiss(), makeId: randomUUID,
      checkpoint: cp => save('history', () => store!.saveCheckpoint(cp)), recoveredSessions: store.recoveredSessions,
      activityCheckpoint: cp => save('activity', () => store!.saveActivityCheckpoint(cp)), settings: store.snapshot().settings,
      credit: (id, ms) => store!.addFocusTime(id, ms), clock: { read: () => ({
        wallMs: Date.now(), monotonicMs: performance.now(), utcOffsetMinutes: -new Date().getTimezoneOffset(),
      }) } });
    const service = new DesktopService(store, focus);
    focusMiniWindow = new FocusMiniWindow({
      preloadPath: join(__dirname, 'focus-mini-preload.cjs'), pagePath: join(__dirname, 'focus-mini.html'),
      onOpenMain: showWindow,
      readSnapshot: () => {
        const now = new Date();
        const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
        const state = focus!.state(); const timer = state.timer;
        const status = !timer || timer.status === 'idle' ? 'idle' : timer.status === 'stopped' ? 'stopped'
          : timer.status === 'paused' ? 'paused' : timer.status === 'awaiting-next' ? 'waiting'
            : timer.phase !== 'work' || timer.microResting ? 'break' : 'running';
        return { date, elapsedMs: store!.focusTime(date, focus!.currentFocusClock()), status,
          taskTitle: state.taskId ? store!.snapshot().tasks.find(task => task.id === state.taskId)?.title ?? null : null };
      },
    });
    planRemindersEnabled = store.snapshot().settings.planReminder?.enabled === true;
    planWindow = new PlanReminderWindow({
      preloadPath: join(__dirname, 'plan-reminder-preload.cjs'),
      onAction: async (notice, action) => {
        store!.respondPlanReminder(notice.token, action, Date.now());
        if (action === 'open' && window && !window.isDestroyed()) {
          showWindow();
          // Persistence already succeeded; a renderer reload must not retry a consumed token.
          try { await window.webContents.executeJavaScript("document.dispatchEvent(new Event('studyflow-open-today'))"); }
          catch { diagnostic?.log.record('plan_reminder_navigation_failed'); }
        }
      },
    });
    planReminder = new DailyPlanReminder({
      clock: Date.now,
      claim: now => store!.claimPlanReminder(now),
      release: (token, now) => store!.releasePlanReminder(token, now),
      notify: notice => planWindow!.show(notice),
      dismiss: () => planWindow?.dismiss(),
    });
    syncPlanReminderState();
    const page = pathToFileURL(join(__dirname, 'index.html')).href;
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
    window = new BrowserWindow({ width: 1180, height: 940, minWidth: 900, minHeight: 650, show: false,
      title: buildInfo.test ? `StudyFlow 测试版 ${buildInfo.version}` : 'StudyFlow', backgroundColor: '#f5f6f3', autoHideMenuBar: true,
      webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: true },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.on('close', event => {
      if (quitting) return;
      if (tray) { event.preventDefault(); window?.hide(); }
      else if (!cleanup()) { event.preventDefault(); showSaveFailure(); }
    });
    diagnostic?.start(window, () => focus?.state());
    window.on('closed', () => { window = null; });
    // Windows logoff does not emit app.before-quit. Query may be cancelled by
    // another app, so settle the session there, but only close resources on end.
    window.on('query-session-end', () => { diagnostic?.log.record('query_session_end'); focus?.stop('系统会话即将结束，本次计时已结算'); });
    window.on('session-end', () => { diagnostic?.log.record('session_end'); cleanup(true); });
    const trusted = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => event.sender === window?.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === page;
    ipcMain.handle('studyflow:focus-mini-open', event => {
      if (!trusted(event)) return { ok: false, error: '无效请求来源' };
      return openFocusMini();
    });
    ambient = createElectronAmbientAudio({
      userDataPath: directory,
      createWindow: options => {
        const player = new BrowserWindow(options); ambientWindow = player;
        player.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        player.webContents.on('will-navigate', event => event.preventDefault());
        player.on('closed', () => { if (ambientWindow === player) ambientWindow = null; });
        return player;
      },
      showOpenDialog: () => dialog.showOpenDialog(window!, { title: '选择本地音乐', properties: ['openFile'], filters: [{ name: '本地音频', extensions: ['wav', 'mp3'] }] }),
    });
    ipcMain.handle('studyflow:ambient-audio', (event, command: unknown, payload: unknown) => {
      if (!trusted(event)) throw new Error('无效请求来源');
      return ambient!.execute(command, payload);
    });
    if (diagnostic) {
      ipcMain.handle('studyflow:diagnostic', (event, command: unknown, payload: unknown) => {
        if (!trusted(event)) return { ok: false, error: '无效请求来源' };
        return diagnostic!.request(command, payload);
      });
      ipcMain.on('studyflow:renderer-error', (event, kind: unknown, fields: unknown) => {
        if (!trusted(event) || (kind !== 'renderer_error' && kind !== 'renderer_rejection')) return;
        diagnostic?.log.record(kind, fields && typeof fields === 'object' && 'frames' in fields ? { frames: fields.frames } : {});
      });
    }
    ipcMain.handle('studyflow:command', (event, command: unknown, payload: unknown): Reply => {
      if (!trusted(event)) return { ok: false, error: '无效请求来源' };
      try {
        const value = service.execute(command, payload);
        planRemindersEnabled = value.settings.planReminder?.enabled === true;
        syncPlanReminderState();
        const reminderError = planReminder?.state().error;
        if (reminderError && value.planReminder) value.planReminder.error = reminderError;
        if (command !== 'snapshot' && command !== 'daily') syncAmbient();
        if (command !== 'snapshot' && command !== 'daily') diagnostic?.log.record('command_ok', { command });
        if (typeof command === 'string' && ['createProject', 'createTask', 'setTaskDone', 'settings', 'savePlan', 'saveReview', 'classifyApp', 'confirmImport', 'deleteHistory'].includes(command)) diagnostic?.log.record('save_ok', { area: 'database' });
        return { ok: true, value };
      }
      catch (error) {
        diagnostic?.log.record(isExpectedRejection(error) ? 'command_rejected' : 'command_failed', { command, ...safeError(error) });
        // Only domain errors without native error codes are safe for the local UI.
        return { ok: false, error: error instanceof Error && !('code' in error) ? error.message : '操作未保存，请检查本地数据目录' };
      }
    });
    const pixels = Buffer.alloc(16 * 16 * 4);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const i = (y * 16 + x) * 4; const mark = (x === 5 && y >= 4 && y <= 10) || (y === 10 && x >= 5 && x <= 11);
      pixels[i] = mark ? 240 : 61; pixels[i + 1] = mark ? 255 : 103; pixels[i + 2] = mark ? 250 : 38; pixels[i + 3] = 255;
    }
    try {
      tray = new Tray(nativeImage.createFromBitmap(pixels, { width: 16, height: 16 }));
      tray.setToolTip(buildInfo.test ? 'StudyFlow 测试版 · 本地诊断' : 'StudyFlow · 学习与专注');
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: '打开 StudyFlow', click: showWindow },
        { label: '打开专注小窗', click: () => { void openFocusMini().then(reply => {
          if (!reply.ok && !quitting) dialog.showErrorBox('专注小窗', reply.error);
        }); } },
        { label: '结束专注', click: () => focus?.stop() },
        { type: 'separator' }, { label: '退出 StudyFlow', click: () => app.quit() },
      ])); tray.on('double-click', showWindow);
    } catch (error) { tray = null; diagnostic?.log.record('tray_failed', safeError(error)); }
    Menu.setApplicationMenu(null);
    powerMonitor.on('lock-screen', () => { diagnostic?.log.record('lock'); locked = true; syncPlanReminderState(); focus?.suspendActivity(true); focus?.interrupt('电脑已锁屏，计时已暂停，返回后请点击继续'); });
    powerMonitor.on('unlock-screen', () => { diagnostic?.log.record('unlock'); locked = false; focus?.suspendActivity(suspended); syncPlanReminderState(); void planReminder?.tick(); });
    powerMonitor.on('suspend', () => { diagnostic?.log.record('suspend'); suspended = true; syncPlanReminderState(); focus?.suspendActivity(true); focus?.interrupt('电脑进入休眠，计时已暂停'); focus?.flushActivity(); });
    powerMonitor.on('resume', () => { diagnostic?.log.record('resume'); suspended = false; focus?.suspendActivity(locked); focus?.interrupt('电脑已唤醒，请点击继续恢复计时'); syncPlanReminderState(); void planReminder?.tick(); });
    timer = setInterval(() => { void focus?.tick().then(syncAmbient); }, 1000);
    await window.loadURL(page);
    planTimer = setInterval(() => { syncPlanReminderState(); void planReminder?.tick(); }, 10_000);
    void planReminder.tick();
    diagnostic?.log.record('ready');
    if (!process.env.STUDYFLOW_HIDDEN) window.show();
  }).catch(error => {
    fatal = true;
    diagnostic?.log.record('startup_failed', safeError(error));
    dialog.showErrorBox('StudyFlow 无法启动', '无法打开本地数据或桌面组件。原数据未清除，请检查文件权限和应用版本。');
    app.quit();
  });
  app.on('before-quit', event => {
    if (!cleanup()) {
      event.preventDefault(); showSaveFailure();
    }
  });
  app.on('window-all-closed', () => { if (!tray) app.quit(); });
  app.on('activate', showWindow);
}
