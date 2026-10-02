import type { FocusMiniAPI, FocusMiniSnapshot, FocusMiniStatus } from './focus-mini-contracts';

const statusLabels: Record<FocusMiniStatus, string> = {
  idle: '未在专注', running: '专注中', paused: '已暂停', waiting: '等待下一阶段', break: '休息中', stopped: '本次已结束',
};

export function formatFocusElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor(seconds % 3_600 / 60);
  const rest = seconds % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

export function mountFocusMini(doc: Document, api: FocusMiniAPI) {
  const time = doc.getElementById('focus-mini-time')!;
  const date = doc.getElementById('focus-mini-date')!;
  const task = doc.getElementById('focus-mini-task')!;
  const status = doc.getElementById('focus-mini-status')!;
  const error = doc.getElementById('focus-mini-error')!;
  const openMain = doc.getElementById('focus-mini-open-main') as HTMLButtonElement;
  const close = doc.getElementById('focus-mini-close') as HTMLButtonElement;
  let polling = false;
  let acting = false;
  let disposed = false;

  const render = (snapshot: FocusMiniSnapshot) => {
    time.textContent = formatFocusElapsed(snapshot.elapsedMs);
    date.textContent = `${snapshot.date} · 今日累计`;
    task.textContent = snapshot.taskTitle?.trim() || '自由专注';
    status.textContent = statusLabels[snapshot.status];
    doc.body.dataset.status = snapshot.status;
    error.textContent = '';
  };
  const refresh = async () => {
    if (disposed || polling) return;
    polling = true;
    try {
      const reply = await api.snapshot();
      if (disposed) return;
      if (reply.ok && 'snapshot' in reply) render(reply.snapshot);
      else error.textContent = '暂时无法更新，正在重试';
    } catch {
      if (!disposed) error.textContent = '暂时无法更新，正在重试';
    } finally { polling = false; }
  };
  const act = async (action: 'open-main' | 'close') => {
    if (disposed || acting) return;
    acting = true; openMain.disabled = true; close.disabled = true;
    try {
      const reply = await api.act(action);
      if (!disposed && !reply.ok) error.textContent = '操作未完成，请重试';
    } catch {
      if (!disposed) error.textContent = '操作未完成，请重试';
    } finally {
      acting = false;
      if (!disposed) { openMain.disabled = false; close.disabled = false; }
    }
  };
  const onOpen = () => { void act('open-main'); };
  const onClose = () => { void act('close'); };
  openMain.addEventListener('click', onOpen);
  close.addEventListener('click', onClose);
  const timer = setInterval(() => { void refresh(); }, 1_000);
  void refresh();

  const dispose = () => {
    if (disposed) return;
    disposed = true; clearInterval(timer);
    openMain.removeEventListener('click', onOpen); close.removeEventListener('click', onClose);
    doc.defaultView?.removeEventListener('pagehide', dispose);
  };
  doc.defaultView?.addEventListener('pagehide', dispose, { once: true });
  return { dispose };
}

if (typeof window !== 'undefined' && window.studyflowFocusMini) mountFocusMini(document, window.studyflowFocusMini);
