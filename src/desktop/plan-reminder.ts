import { record } from './contracts';

export interface PlanReminderSettings { enabled: boolean; time: string }
export interface PlanReminderNotice {
  token: string; date: string;
  tasks: Array<{ taskId: string; title: string; minutes: number }>;
}
export type PlanReminderAction = 'open' | 'snooze' | 'dismiss';
export interface PlanReminderStatus {
  date: string;
  state: 'disabled' | 'waiting' | 'empty' | 'notified' | 'snoozed' | 'dismissed';
  pendingCount: number; nextAt: number | null; error?: string;
}

export function planReminderSettings(value: unknown): PlanReminderSettings {
  if (value === undefined) return { enabled: false, time: '09:00' };
  const input = record(value);
  if (typeof input.enabled !== 'boolean') throw new Error('无效每日提醒开关');
  if (typeof input.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time)) throw new Error('提醒时间须为有效 HH:mm');
  return { enabled: input.enabled, time: input.time };
}

/** Calendar reminders follow the computer's current local date, never UTC date. */
export function reminderLocalDate(now: number): string {
  const date = new Date(now);
  if (!Number.isSafeInteger(now) || !Number.isFinite(date.getTime()) || date.getFullYear() < 1 || date.getFullYear() > 9999) throw new Error('无效提醒时间');
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function reminderDueAt(now: number, time: string): number {
  const date = new Date(now); const [hour, minute] = time.split(':').map(Number);
  date.setHours(hour!, minute!, 0, 0);
  return date.getTime();
}

interface ReminderDependencies {
  clock(): number;
  claim(now: number): PlanReminderNotice | null;
  release(token: string, now: number): void;
  /** Resolves when shown, rejects for a failed or cancelled load. */
  notify(notice: PlanReminderNotice): Promise<void>;
  dismiss(): void;
}

/** The main process owns polling; no renderer, Electron, or timer dependency. */
export class DailyPlanReminder {
  private blocked = false;
  private busy = false;
  private disposed = false;
  private generation = 0;
  private loading: PlanReminderNotice | null = null;
  private shownDate: string | null = null;
  private retryAfter = -Infinity;
  private lastObserved = -Infinity;
  private error: string | null = null;
  private readFailed = false;
  constructor(private readonly deps: ReminderDependencies) {}
  state(): { blocked: boolean; busy: boolean; error: string | null } {
    return { blocked: this.blocked, busy: this.busy, error: this.error };
  }
  setBlocked(value: boolean): void {
    if (this.disposed || this.blocked === value) return;
    this.blocked = value;
    if (value) this.cancel();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.cancel();
  }
  private cancel(): void {
    this.generation++;
    const loading = this.loading; this.loading = null;
    if (loading) {
      // Release synchronously while the database is still open during shutdown.
      try { this.deps.release(loading.token, this.deps.clock()); }
      catch { this.error = '每日提醒取消记录保存失败，请检查本地存储'; this.retryAfter = this.deps.clock() + 60000; }
    }
    this.dismissShown();
  }
  private dismissShown(): void {
    this.shownDate = null;
    try { this.deps.dismiss(); }
    catch { this.error = '每日提醒窗口关闭失败'; }
  }
  private dismissExpired(now: number): void {
    if (this.shownDate !== null && this.shownDate !== reminderLocalDate(now)) this.dismissShown();
  }
  async tick(): Promise<void> {
    if (this.disposed || this.blocked || this.busy) return;
    const now = this.deps.clock();
    // An old window must disappear even while today's reminder is not due.
    this.dismissExpired(now);
    if (now < this.lastObserved) this.retryAfter = -Infinity;
    this.lastObserved = now;
    if (now < this.retryAfter) return;
    this.busy = true;
    const generation = this.generation;
    try {
      let notice: PlanReminderNotice | null;
      try {
        notice = this.deps.claim(now);
        if (this.readFailed) { this.readFailed = false; this.error = null; }
      } catch {
        this.readFailed = true; this.error = '每日提醒读取或记录失败，稍后重试'; this.retryAfter = now + 60000; return;
      }
      if (!notice) return;
      this.loading = notice;
      try {
        await this.deps.notify(notice);
        if (generation === this.generation) {
          this.error = null; this.shownDate = notice.date;
          this.dismissExpired(this.deps.clock());
        }
      } catch {
        if (generation === this.generation) this.error = '每日提醒显示失败，本次不自动重试';
      } finally { if (this.loading === notice) this.loading = null; }
    } finally { this.busy = false; }
  }
}
