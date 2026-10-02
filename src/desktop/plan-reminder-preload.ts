import { contextBridge, ipcRenderer } from 'electron';
import type { PlanReminderAction } from './plan-reminder';
import type { PlanReminderReply } from './plan-reminder-window';

contextBridge.exposeInMainWorld('studyflowPlanReminder', {
  act: (action: PlanReminderAction): Promise<PlanReminderReply> => {
    if (action !== 'open' && action !== 'snooze' && action !== 'dismiss') {
      return Promise.resolve({ ok: false, error: '不支持的提醒操作' });
    }
    return ipcRenderer.invoke('studyflow:plan-reminder-action', action) as Promise<PlanReminderReply>;
  },
});
