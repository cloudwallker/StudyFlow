import type { DesktopSnapshot } from './contracts';

/** Reminder drafts are independent of timer settings and survive snapshot polling. */
export function mountPlanReminderSettings(doc: Document, save: (value: { enabled: boolean; time: string }) => Promise<boolean>) {
  const enabled = doc.getElementById('plan-reminder-enabled') as HTMLInputElement;
  const time = doc.getElementById('plan-reminder-time') as HTMLInputElement;
  const button = doc.getElementById('plan-reminder-save') as HTMLButtonElement;
  const form = doc.getElementById('plan-reminder-form')!;
  const message = doc.getElementById('plan-reminder-save-status')!;
  const status = doc.getElementById('plan-reminder-status')!;
  let dirty = false; let saving = false; let disposed = false; let settingsKey = '';
  const edit = () => { dirty = true; message.textContent = '提醒设置尚未保存'; time.disabled = !enabled.checked; };
  const submit = (event: Event) => {
    event.preventDefault();
    if (saving || disposed || button.disabled) return;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time.value)) { message.textContent = '请选择有效的提醒时间'; return; }
    const value = { enabled: enabled.checked, time: time.value };
    saving = true; button.disabled = true; enabled.disabled = true; time.disabled = true;
    message.textContent = '正在保存提醒…';
    void save(value).then(ok => {
      if (disposed) return;
      if (ok) { dirty = false; settingsKey = JSON.stringify(value); message.textContent = '提醒设置已保存'; }
      else message.textContent = '提醒设置未保存，请检查提示后重试';
    }).catch(() => { if (!disposed) message.textContent = '无法保存提醒，请重试'; }).finally(() => {
      saving = false;
      if (!disposed) { enabled.disabled = false; time.disabled = !enabled.checked; button.disabled = false; }
    });
  };
  enabled.addEventListener('change', edit); time.addEventListener('input', edit); form.addEventListener('submit', submit);
  return {
    render(snapshot: DesktopSnapshot, busy: boolean) {
      if (disposed) return;
      const settings = snapshot.settings.planReminder ?? { enabled: false, time: '09:00' };
      const key = JSON.stringify(settings);
      if (!dirty && !saving && key !== settingsKey) { settingsKey = key; enabled.checked = settings.enabled; time.value = settings.time; }
      enabled.disabled = busy || saving; time.disabled = busy || saving || !enabled.checked; button.disabled = busy || saving;
      const state = snapshot.planReminder;
      const count = state?.pendingCount ?? 0;
      const next = state?.nextAt ? new Date(state.nextAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : settings.time;
      if (!settings.enabled) status.textContent = '提醒已关闭。';
      else if (state?.error) status.textContent = state.error;
      else if (state?.state === 'snoozed') status.textContent = `已稍后提醒，今天 ${next} 再提醒；还有 ${count} 项待完成。`;
      else if (state?.state === 'dismissed') status.textContent = '今天的提醒已处理，明天继续。';
      else if (state?.state === 'notified') status.textContent = '今天的提醒已发送；不会重复自动弹出。';
      else if (state?.state === 'empty') status.textContent = '今天没有待完成计划，有新计划后会按设置提醒。';
      else status.textContent = `每天 ${settings.time} 提醒；今天还有 ${count} 项待完成。${snapshot.focus.running ? '本次专注结束后再提醒。' : ''}`;
    },
    dispose() { disposed = true; enabled.removeEventListener('change', edit); time.removeEventListener('input', edit); form.removeEventListener('submit', submit); },
  };
}
