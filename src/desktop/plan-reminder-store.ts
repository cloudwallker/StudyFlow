import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { record, textValue } from './contracts';
import { transaction } from './migration';
import { planReminderSettings, reminderDueAt, reminderLocalDate, type PlanReminderNotice, type PlanReminderStatus } from './plan-reminder';

/** One durable occurrence per local calendar day. Snoozing never changes a plan. */
export class PlanReminderStore {
  constructor(private readonly db: DatabaseSync) {}

  private settings() {
    const row = this.db.prepare('SELECT preferences FROM settings WHERE id=1').get();
    if (!row) throw new Error('设置数据缺失，请恢复备份');
    return planReminderSettings(record(JSON.parse(String(row.preferences))).planReminder);
  }

  private pending(date: string): PlanReminderNotice['tasks'] {
    return this.db.prepare(`SELECT t.id,t.title,json_extract(e.value,'$.minutes') AS minutes
      FROM daily_plans p,json_each(p.data,'$.entries') e
      JOIN tasks t ON t.id=json_extract(e.value,'$.taskId')
      LEFT JOIN task_details d ON d.taskId=t.id
      LEFT JOIN daily_checkins c ON c.date=p.date AND c.taskId=t.id
      WHERE p.date=? AND t.done=0 AND COALESCE(d.archived,0)=0 AND c.taskId IS NULL
      ORDER BY CAST(e.key AS INTEGER)`).all(date).map(row => ({ taskId: String(row.id), title: String(row.title), minutes: Number(row.minutes) }));
  }

  status(now: number): PlanReminderStatus {
    const date = reminderLocalDate(now); const settings = this.settings();
    const pendingCount = this.pending(date).length;
    const base = { date, pendingCount, nextAt: null };
    if (!settings.enabled) return { ...base, state: 'disabled' };
    if (!pendingCount) return { ...base, state: 'empty' };
    const row = this.db.prepare('SELECT state,nextAt FROM daily_plan_reminders WHERE date=?').get(date);
    if (row) {
      if (row.state === 'snoozed') return { ...base, state: 'snoozed', nextAt: Number(row.nextAt) };
      if (row.state === 'deferred') return { ...base, state: 'waiting', nextAt: Number(row.nextAt) };
      return { ...base, state: row.state === 'dismissed' ? 'dismissed' : 'notified' };
    }
    return { ...base, state: 'waiting', nextAt: reminderDueAt(now, settings.time) };
  }

  claim(now: number): PlanReminderNotice | null {
    return transaction(this.db, () => {
      const status = this.status(now);
      if ((status.state !== 'waiting' && status.state !== 'snoozed') || status.nextAt === null || now < status.nextAt) return null;
      const tasks = this.pending(status.date); const token = randomUUID();
      // Reserve before display: a crash or failed window cannot replay this occurrence.
      this.db.prepare(`INSERT INTO daily_plan_reminders(date,token,state,attemptedAt,nextAt) VALUES(?,?,'notified',?,NULL)
        ON CONFLICT(date) DO UPDATE SET token=excluded.token,state='notified',attemptedAt=excluded.attemptedAt,nextAt=NULL`).run(status.date, token, now);
      return { token, date: status.date, tasks };
    });
  }

  respond(value: unknown, action: unknown, now: number): PlanReminderStatus {
    const date = reminderLocalDate(now); const token = textValue(value, 80);
    if (action !== 'open' && action !== 'snooze' && action !== 'dismiss') throw new Error('无效提醒操作');
    return transaction(this.db, () => {
      const row = this.db.prepare('SELECT token,state FROM daily_plan_reminders WHERE date=?').get(date);
      if (!this.settings().enabled || !row || row.token !== token || row.state !== 'notified') throw new Error('此提醒已失效');
      const later = now + 10 * 60000;
      const snoozed = action === 'snooze' && reminderLocalDate(later) === date;
      const state = snoozed ? 'snoozed' : action === 'open' ? 'notified' : 'dismissed';
      this.db.prepare('UPDATE daily_plan_reminders SET token=NULL,state=?,nextAt=? WHERE date=?').run(state, snoozed ? later : null, date);
      return this.status(now);
    });
  }

  release(value: unknown, now: number): void {
    const date = reminderLocalDate(now); const token = textValue(value, 80);
    // A stale callback must not undo a user's action or another displayed occurrence.
    this.db.prepare(`UPDATE daily_plan_reminders SET token=NULL,state='deferred',nextAt=?
      WHERE date=? AND token=? AND state='notified'`).run(now, date, token);
  }
}
