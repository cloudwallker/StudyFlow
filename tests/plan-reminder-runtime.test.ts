import { afterEach, expect, it } from 'vitest';
import { StudyStore } from '../src/desktop/store';
import { DailyPlanReminder, type PlanReminderNotice } from '../src/desktop/plan-reminder';

const stores: StudyStore[] = [];
const at = (day: number, hour = 9, minute = 0) => new Date(2026, 8, day, hour, minute).getTime();
function setup(notify?: (notice: PlanReminderNotice) => Promise<void>) {
  const store = new StudyStore(':memory:'); stores.push(store);
  const task = store.createTask({ title: '虚构计划', projectId: null, estimateMinutes: 25 });
  for (const date of ['2026-09-12', '2026-09-13']) store.savePlan(date, [{ taskId: task.id, minutes: 25 }]);
  store.updatePlanReminderSettings({ enabled: true, time: '09:00' });
  let now = at(12); let visible = false; const notices: PlanReminderNotice[] = [];
  const runtime = new DailyPlanReminder({ clock: () => now, claim: time => store.claimPlanReminder(time),
    release: (token, time) => store.releasePlanReminder(token, time),
    notify: async notice => { notices.push(notice); if (notify) await notify(notice); visible = true; }, dismiss: () => { visible = false; } });
  return { store, runtime, notices, visible: () => visible, time: (value: number) => { now = value; } };
}
afterEach(() => stores.splice(0).forEach(store => store.close()));

it('defers a locked or focused day without consuming it and catches up only today on unblock', async () => {
  const s = setup(); s.runtime.setBlocked(true); await s.runtime.tick();
  expect(s.notices).toHaveLength(0); expect(s.store.planReminderStatus(at(12)).state).toBe('waiting');
  s.time(at(13, 11)); s.runtime.setBlocked(false); await s.runtime.tick(); await s.runtime.tick();
  expect(s.notices.map(n => n.date)).toEqual(['2026-09-13']);
  s.runtime.setBlocked(true); expect(s.visible()).toBe(false);
  s.runtime.setBlocked(false); await s.runtime.tick(); expect(s.notices).toHaveLength(1);
  s.runtime.dispose(); s.time(at(14)); await s.runtime.tick(); expect(s.notices).toHaveLength(1);
});

it('does not overlap loading windows or let a late result clear newer lifecycle state', async () => {
  let finish!: () => void;
  const s = setup(() => new Promise(resolve => { finish = resolve; }));
  const pending = s.runtime.tick(); await s.runtime.tick();
  expect(s.notices).toHaveLength(1); expect(s.runtime.state().busy).toBe(true);
  finish(); await pending; expect(s.visible()).toBe(true); expect(s.runtime.state().busy).toBe(false);
  s.runtime.dispose(); expect(s.visible()).toBe(false);
});

it('releases a claim cancelled during loading, then shows today once after resuming', async () => {
  let cancel!: (error: Error) => void; let attempts = 0;
  const s = setup(() => ++attempts === 1 ? new Promise((_resolve, reject) => { cancel = reject; }) : Promise.resolve());
  const loading = s.runtime.tick(); s.runtime.setBlocked(true); cancel(new Error('cancelled'));
  await loading;
  expect(s.runtime.state().error).toBeNull();
  expect(s.store.planReminderStatus(at(12))).toMatchObject({ state: 'waiting', nextAt: at(12) });
  s.runtime.setBlocked(false); await s.runtime.tick(); await s.runtime.tick();
  expect(s.notices).toHaveLength(2); expect(s.notices[1]?.token).not.toBe(s.notices[0]?.token);
  expect(s.store.planReminderStatus(at(12)).state).toBe('notified');
});

it('releases an unseen claim synchronously before disposal closes the store', async () => {
  let cancel!: (error: Error) => void;
  const s = setup(() => new Promise((_resolve, reject) => { cancel = reject; }));
  const loading = s.runtime.tick(); s.runtime.dispose();
  expect(s.store.planReminderStatus(at(12)).state).toBe('waiting');
  s.store.close(); cancel(new Error('cancelled')); await loading;
  expect(s.runtime.state().error).toBeNull();
});

it('consumes an actual delivery failure without rapid retries or private details in status', async () => {
  const s = setup(async () => { throw new Error('secret path and content'); });
  await s.runtime.tick(); s.time(at(12, 9, 1)); await s.runtime.tick(); s.time(at(12, 18)); await s.runtime.tick();
  expect(s.notices).toHaveLength(1); expect(s.store.planReminderStatus(at(12)).state).toBe('notified');
  expect(s.runtime.state().error).toMatch(/显示失败/); expect(s.runtime.state().error).not.toContain('secret');
});

it('backs off failed reads for a minute, reports them and resumes after storage recovers', async () => {
  let now = at(12); let reads = 0; let fail = true;
  const runtime = new DailyPlanReminder({ clock: () => now, claim: () => { reads++; if (fail) throw new Error('private db'); return null; },
    notify: async () => {}, release: () => {}, dismiss: () => {} });
  await runtime.tick(); for (let i = 0; i < 5; i++) { now += 10000; await runtime.tick(); }
  expect(reads).toBe(1); expect(runtime.state().error).toMatch(/读取|记录/); expect(runtime.state().error).not.toContain('private');
  now += 10000; fail = false; await runtime.tick(); expect(reads).toBe(2); expect(runtime.state().error).toBeNull();
});

it('does not stall indefinitely after a backward clock change during storage backoff', async () => {
  let now = at(12); let fail = true; let attempts = 0;
  const runtime = new DailyPlanReminder({ clock: () => now, claim: () => { attempts++; if (fail) throw new Error('disk'); return null; },
    notify: async () => {}, release: () => {}, dismiss: () => {} });
  await runtime.tick(); now = at(12, 8); fail = false; await runtime.tick();
  expect(attempts).toBe(2); expect(runtime.state().error).toBeNull();
});

it('makes cancellation record failures visible while still dismissing the window', async () => {
  let reject!: (reason: Error) => void; let dismissed = 0;
  const runtime = new DailyPlanReminder({ clock: () => at(12), claim: () => ({ token: 't', date: '2026-09-12', tasks: [] }),
    notify: () => new Promise((_resolve, no) => { reject = no; }), release: () => { throw new Error('private db'); }, dismiss: () => { dismissed++; } });
  const loading = runtime.tick(); runtime.setBlocked(true); reject(new Error('cancelled')); await loading;
  expect(dismissed).toBe(1); expect(runtime.state().error).toMatch(/记录/); expect(runtime.state().error).not.toContain('private');
});

it('closes yesterday visible reminder at midnight without resetting its record or consuming today early', async () => {
  const s = setup(); s.time(at(12, 23, 59)); await s.runtime.tick();
  expect(s.visible()).toBe(true);
  s.time(at(13, 0, 1)); await s.runtime.tick();
  expect(s.visible()).toBe(false);
  expect(s.store.planReminderStatus(at(12, 23, 59)).state).toBe('notified');
  expect(s.store.planReminderStatus(at(13, 0, 1))).toMatchObject({ state: 'waiting', nextAt: at(13) });
  expect(s.notices).toHaveLength(1);
  s.time(at(13)); await s.runtime.tick(); await s.runtime.tick();
  expect(s.visible()).toBe(true); expect(s.notices.map(n => n.date)).toEqual(['2026-09-12', '2026-09-13']);
});

it('immediately closes a notice whose loading finishes on the following local date', async () => {
  let finish!: () => void;
  const s = setup(() => new Promise(resolve => { finish = resolve; }));
  s.time(at(12, 23, 59)); const loading = s.runtime.tick();
  s.time(at(13, 0, 1)); finish(); await loading;
  expect(s.visible()).toBe(false);
  expect(s.store.planReminderStatus(at(12, 23, 59)).state).toBe('notified');
  expect(s.store.planReminderStatus(at(13, 0, 1)).state).toBe('waiting');
  expect(s.runtime.state().error).toBeNull();
});
