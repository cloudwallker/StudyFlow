import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { StudyStore } from '../src/desktop/store';

const root = resolve('.cache/plan-reminder-tests');
const dirs: string[] = []; const stores: StudyStore[] = [];
const at = (day: number, hour = 9, minute = 0) => new Date(2026, 8, day, hour, minute).getTime();
function setup(disk = false) {
  let path = ':memory:';
  if (disk) { mkdirSync(root, { recursive: true }); const dir = mkdtempSync(join(root, 'run-')); dirs.push(dir); path = join(dir, 'test.sqlite'); }
  const store = new StudyStore(path); stores.push(store);
  const task = store.createTask({ title: '虚构阅读计划', projectId: null, estimateMinutes: 25 });
  store.savePlan('2026-09-12', [{ taskId: task.id, minutes: 25 }]);
  return { store, path, task };
}
afterEach(() => {
  stores.splice(0).forEach(store => store.close());
  for (const dir of dirs.splice(0)) { if (!resolve(dir).startsWith(root + sep)) throw new Error('测试清理路径越界'); rmSync(dir, { recursive: true, force: true }); }
});

it('defaults to an opt-in reminder and does not consume a day before its local due time', () => {
  const { store } = setup();
  expect(store.snapshot().settings.planReminder).toEqual({ enabled: false, time: '09:00' });
  expect(store.claimPlanReminder(at(12, 10))).toBeNull();
  expect(store.planReminderStatus(at(12)).state).toBe('disabled');
  store.updatePlanReminderSettings({ enabled: true, time: '09:30' });
  expect(store.claimPlanReminder(at(12, 9, 29))).toBeNull();
  expect(store.planReminderStatus(at(12))).toMatchObject({ date: '2026-09-12', state: 'waiting', pendingCount: 1, nextAt: at(12, 9, 30) });
  expect(store.claimPlanReminder(at(12, 9, 30))?.tasks).toHaveLength(1);
  expect(store.claimPlanReminder(at(12, 9, 31))).toBeNull();
});

it('persists settings and today consumption across restart without altering focus preferences', () => {
  const { store, path } = setup(true);
  store.updateSettings({ durationMinutes: 40, whitelist: ['code.exe'] });
  store.updatePlanReminderSettings({ enabled: true, time: '08:45' });
  expect(store.claimPlanReminder(at(12))).not.toBeNull(); store.close();
  const again = new StudyStore(path); stores.push(again);
  expect(again.snapshot().settings).toMatchObject({ durationMinutes: 40, whitelist: ['code.exe'], planReminder: { enabled: true, time: '08:45' } });
  expect(again.claimPlanReminder(at(12, 12))).toBeNull();
  again.updateSettings({ durationMinutes: 30 });
  expect(again.snapshot().settings.planReminder).toEqual({ enabled: true, time: '08:45' });
  expect(again.planReminderStatus(at(12, 12)).state).toBe('notified');
});

it.each([
  { enabled: 'yes', time: '09:00' }, { enabled: true, time: '9:00' },
  { enabled: true, time: '24:00' }, { enabled: true, time: '09:60' },
  { enabled: true, time: ' 09:00' }, { enabled: true }, null,
])('rejects malformed reminder settings without changing saved preferences: %j', invalid => {
  const { store } = setup();
  expect(() => store.updatePlanReminderSettings(invalid)).toThrow();
  expect(store.snapshot().settings.planReminder).toEqual({ enabled: false, time: '09:00' });
});

it('summarizes only today active unfinished and unchecked plan entries, then rechecks after edits', () => {
  const { store, task } = setup();
  const done = store.createTask({ title: '已完成', projectId: null, estimateMinutes: 10 });
  const checked = store.createTask({ title: '已打卡', projectId: null, estimateMinutes: 10 });
  const archived = store.createTask({ title: '已归档', projectId: null, estimateMinutes: 10 });
  const otherDay = store.createTask({ title: '昨天', projectId: null, estimateMinutes: 10 });
  store.savePlan('2026-09-12', [task, done, checked, archived].map(t => ({ taskId: t.id, minutes: 10 })));
  store.savePlan('2026-09-11', [{ taskId: otherDay.id, minutes: 10 }]);
  store.setTaskDone(done.id, true);
  store.manage('checkIn', { id: checked.id, date: '2026-09-12', done: true });
  store.manage('archiveTask', { id: archived.id, archived: true });
  store.updatePlanReminderSettings({ enabled: true, time: '09:00' });
  const notice = store.claimPlanReminder(at(12));
  expect(notice?.tasks).toEqual([{ taskId: task.id, title: task.title, minutes: 10 }]);
  store.respondPlanReminder(notice!.token, 'snooze', at(12));
  store.manage('checkIn', { id: task.id, date: '2026-09-12', done: true });
  expect(store.claimPlanReminder(at(12, 9, 10))).toBeNull();
  expect(store.planReminderStatus(at(12, 9, 10))).toMatchObject({ state: 'empty', pendingCount: 0, nextAt: null });
});

it('does not consume an empty day before a plan is added and never backfills previous days', () => {
  const { store, task } = setup(); store.updatePlanReminderSettings({ enabled: true, time: '09:00' });
  expect(store.claimPlanReminder(at(13))).toBeNull();
  store.savePlan('2026-09-13', [{ taskId: task.id, minutes: 15 }]);
  expect(store.claimPlanReminder(at(13))?.date).toBe('2026-09-13');
  expect(store.claimPlanReminder(at(13, 18))).toBeNull();
});

it('persists ten minute snooze and rejects reused tokens after snoozing or a new occurrence', () => {
  const { store, path } = setup(true); store.updatePlanReminderSettings({ enabled: true, time: '09:00' });
  const first = store.claimPlanReminder(at(12))!;
  expect(store.respondPlanReminder(first.token, 'snooze', at(12, 9, 1))).toMatchObject({ state: 'snoozed', nextAt: at(12, 9, 11) });
  expect(() => store.respondPlanReminder(first.token, 'dismiss', at(12, 9, 2))).toThrow(/失效/);
  store.close(); const again = new StudyStore(path); stores.push(again);
  expect(again.claimPlanReminder(at(12, 9, 10))).toBeNull();
  const second = again.claimPlanReminder(at(12, 9, 11))!;
  expect(second.token).not.toBe(first.token);
  expect(() => again.respondPlanReminder(first.token, 'dismiss', at(12, 9, 11))).toThrow(/失效/);
  expect(again.respondPlanReminder(second.token, 'dismiss', at(12, 9, 11)).state).toBe('dismissed');
  expect(again.claimPlanReminder(at(12, 22))).toBeNull();
});

it('makes open a one-time action, rejects unknown actions and keeps the day consumed after settings change', () => {
  const { store } = setup(); store.updatePlanReminderSettings({ enabled: true, time: '09:00' });
  const notice = store.claimPlanReminder(at(12))!;
  expect(() => store.respondPlanReminder(notice.token, 'unknown', at(12))).toThrow();
  store.respondPlanReminder(notice.token, 'open', at(12));
  expect(() => store.respondPlanReminder(notice.token, 'snooze', at(12))).toThrow(/失效/);
  store.updatePlanReminderSettings({ enabled: false, time: '18:00' });
  store.updatePlanReminderSettings({ enabled: true, time: '07:00' });
  expect(store.claimPlanReminder(at(12, 18))).toBeNull();
  expect(store.claimPlanReminder(at(12, 8))).toBeNull();
});

it('expires cross-midnight snooze and stale-day actions while allowing the new day once', () => {
  const { store, task } = setup(); store.updatePlanReminderSettings({ enabled: true, time: '09:00' });
  store.savePlan('2026-09-13', [{ taskId: task.id, minutes: 25 }]);
  const first = store.claimPlanReminder(at(12, 23, 55))!;
  expect(store.respondPlanReminder(first.token, 'snooze', at(12, 23, 55))).toMatchObject({ state: 'dismissed', nextAt: null });
  expect(store.claimPlanReminder(at(13, 0, 5))).toBeNull();
  expect(() => store.respondPlanReminder(first.token, 'open', at(13))).toThrow(/失效/);
  expect(store.claimPlanReminder(at(13))?.date).toBe('2026-09-13');
});

it('backs up genuine schema v6 before migration, preserving plans, checkins and settings', () => {
  const { store, path, task } = setup(true);
  store.manage('checkIn', { id: task.id, date: '2026-09-12', done: true });
  store.close();
  const old = new DatabaseSync(path); try { old.exec('DROP TABLE daily_plan_reminders; PRAGMA user_version=6;'); } finally { old.close(); }
  const again = new StudyStore(path); stores.push(again);
  expect(again.snapshot().checkins).toHaveLength(1);
  expect(again.snapshot().plans?.[0]?.entries[0]?.taskId).toBe(task.id);
  const backups = readdirSync(resolve(path, '..')).filter(file => file.endsWith('.v6.sqlite'));
  expect(backups).toHaveLength(1);
  const backup = join(resolve(path, '..'), backups[0]!);
  expect(createHash('sha256').update(readFileSync(backup)).digest('hex')).toBe(readFileSync(backup + '.sha256', 'utf8').trim());
  const verify = new DatabaseSync(backup, { readOnly: true });
  try { expect(verify.prepare('PRAGMA user_version').get()?.user_version).toBe(6); expect(verify.prepare('SELECT COUNT(*) AS n FROM daily_checkins').get()?.n).toBe(1); } finally { verify.close(); }
});
