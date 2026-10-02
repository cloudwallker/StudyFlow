import { SuperProductivityAdapter } from './adapters/super-productivity-adapter';
import { ActivityWatchAdapter, type ActivitySource } from './adapters/activitywatch-adapter';
import { attachLifecycle } from './compat/lifecycle';
import { safeError } from './compat/safe-error';
import { FocusController, formatRemaining } from './focus/focus-controller';

export function mountPlugin(doc: Document, api: unknown, fetchFn: typeof fetch = fetch): () => void {
  const host = new SuperProductivityAdapter(api);
  const listeners: Array<() => void> = [];
  let disposed = false;
  let ready = false;
  let running = false;
  let checkAbort: AbortController | null = null;
  const pending = new Set<string>();
  const element = (id: string) => {
    const result = doc.getElementById(id);
    if (!result) throw new Error(`StudyFlow UI element missing: ${id}`);
    return result;
  };
  const write = (id: string, text: string) => { if (!disposed) element(id).textContent = text; };
  const button = (id: string) => element(id) as HTMLButtonElement;
  const input = (id: string) => element(id) as HTMLInputElement | HTMLTextAreaElement;
  const caps = host.capabilities;
  function refreshControls() {
    const blocked = disposed || !ready;
    button('check-api').disabled = blocked || !caps.getTasks || pending.has('check-api');
    button('create-probe').disabled = blocked || !caps.addTask || pending.has('create-probe');
    button('check-aw').disabled = blocked || running || pending.has('check-aw');
    button('start-focus').disabled = blocked || !caps.notify || running || pending.has('check-aw');
    button('stop-focus').disabled = blocked || !running;
    input('hostname').disabled = blocked || running || pending.has('check-aw');
    input('whitelist').disabled = blocked || running;
  }
  function bind(id: string, action: () => Promise<void> | void) {
    const button = element(id) as HTMLButtonElement;
    const listener = () => {
      if (disposed || button.disabled) return;
      pending.add(id);
      refreshControls();
      write('last-error', '');
      // Execute synchronously so Stop cancels work immediately, then handle async errors.
      try {
        void Promise.resolve(action()).catch(error => {
          write('last-error', safeError(error));
        }).finally(() => { pending.delete(id); if (!disposed) refreshControls(); });
      } catch (error) { pending.delete(id); write('last-error', safeError(error)); refreshControls(); }
    };
    button.addEventListener('click', listener);
    listeners.push(() => button.removeEventListener('click', listener));
  }

  write('capabilities', Object.entries(caps).map(([name, available]) => `${name}: ${available ? 'available' : 'unavailable'}`).join('\n'));
  if (Object.values(caps).some(value => !value)) write('last-error', 'StudyFlow compatibility error: some API capabilities are unavailable.');
  bind('check-api', async () => {
    const tasks = await host.listTasks();
    if (disposed) return;
    write('tasks', `已读取 ${tasks.length} 个任务（不显示或记录任务内容）`);
    if (caps.showSnack) await host.feedback('StudyFlow API checked.');
  });
  bind('create-probe', async () => {
    await host.createProbeTask();
    write('tasks', '已创建 [StudyFlow PoC] Plugin API probe');
  });
  const adapter = () => new ActivityWatchAdapter({ fetchFn, hostname: input('hostname').value });
  const source: ActivitySource = {
    isAvailable: signal => adapter().isAvailable(signal),
    getCurrentWindow: signal => adapter().getCurrentWindow(signal),
  };
  const focus = new FocusController(source, host, state => {
    if (disposed) return;
    running = state.running;
    write('focus-status', state.running ? `Running · ${formatRemaining(state.remainingSeconds)}` : 'Stopped');
    write('current-app', state.app ?? '—');
    if (state.running) write('aw-status', state.error ? 'Sample failed' : state.app ? 'Connected' : 'No fresh window event');
    write('last-error', state.error);
    refreshControls();
  }, Date.now, diagnostic => {
    const time = (value: number | null) => value === null ? '—' : new Date(value).toLocaleTimeString();
    write('focus-diagnostic', [
      `阶段：${diagnostic.phase} | 采样次数：${diagnostic.sampleCount} | 最近采样：${time(diagnostic.sampledAt)}`,
      `判断：${diagnostic.reason}`,
      `通知调用次数：${diagnostic.notificationCount} | 通知状态：${diagnostic.notificationStatus}`,
      `最近通知：${time(diagnostic.notificationAt)} | 最近通知 app：${diagnostic.notificationApp ?? '—'}`,
      '通知状态 returned 仅表示宿主 API 已返回，不代表 Windows 已显示',
    ].join('\n'));
  });
  bind('check-aw', async () => {
    checkAbort = new AbortController();
    write('aw-status', 'Checking…');
    try {
      const current = await source.getCurrentWindow(checkAbort.signal);
      write('current-app', current?.app ?? '—');
      write('aw-status', current ? 'Connected' : 'Connected · No fresh window event');
    } catch (error) {
      write('aw-status', 'Unavailable / no usable window data');
      write('current-app', '—');
      throw error;
    } finally { checkAbort = null; }
  });
  bind('start-focus', () => focus.start(input('whitelist').value.split('\n').map(app => app.trim()).filter(Boolean)));
  bind('stop-focus', () => focus.stop());
  const dispose = () => {
    if (disposed) return;
    focus.dispose();
    checkAbort?.abort();
    disposed = true;
    listeners.forEach(remove => remove());
    refreshControls();
  };
  doc.defaultView?.addEventListener('pagehide', dispose);
  listeners.push(() => doc.defaultView?.removeEventListener('pagehide', dispose));
  refreshControls();
  try {
    attachLifecycle(api, () => { if (!disposed) { ready = true; refreshControls(); } }, dispose);
  } catch { write('last-error', 'StudyFlow compatibility error: lifecycle registration failed.'); }
  return dispose;
}
