import { afterEach, expect, it } from 'vitest';
import { StudyStore } from '../src/desktop/store';
import { DesktopService } from '../src/desktop/service';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const stores: StudyStore[] = [];
function setup() {
  const store = new StudyStore(':memory:'); stores.push(store);
  const service = new DesktopService(store, { state: () => ({ running: false, taskId: null, remainingSeconds: 0, totalSeconds: 0, app: null, message: '', notification: 'none' }), start() {}, stop() {} });
  const task = store.createTask({ title: '阅读', projectId: null, estimateMinutes: 25 });
  return { store, service, task };
}
afterEach(() => stores.splice(0).forEach(s => s.close()));
it('edits and archives tasks without losing accumulated time; restores them', () => {
  const { store, service, task } = setup(); store.addFocusTime(task.id, 60000);
  const beforePosition = store.snapshot().tasks[0]?.position;
  service.execute('updateTask', { id: task.id, title: '练习', projectId: null, estimateMinutes: 45, tags: ['数学', '数学'], dependencies: [] });
  expect(store.snapshot().tasks[0]).toMatchObject({ title: '练习', spentMs: 60000, tags: ['数学'] });
  expect(store.snapshot().tasks[0]?.position).toBe(beforePosition);
  service.execute('archiveTask', { id: task.id, archived: true }); expect(store.snapshot().tasks).toHaveLength(0);
  service.execute('archiveTask', { id: task.id, archived: false }); expect(store.snapshot().tasks[0]?.spentMs).toBe(60000);
});
it('keeps per-day checkins independent and never fabricates learning time', () => {
  const { store, service, task } = setup();
  for (const date of ['2026-09-09', '2026-09-10']) store.savePlan(date, [{ taskId: task.id, minutes: 25 }]);
  service.execute('checkIn', { id: task.id, date: '2026-09-09', done: true });
  expect(store.daily('2026-09-09').comparison[0]?.done).toBe(true);
  expect(store.daily('2026-09-10').comparison[0]?.done).toBe(false);
  expect(store.snapshot().tasks[0]).toMatchObject({ done: false, spentMs: 0 });
  service.execute('checkIn', { id: task.id, date: '2026-09-09', done: false });
  expect(store.daily('2026-09-09').comparison[0]?.done).toBe(false);
});
it('rejects dependency cycles and prevents starting blocked tasks', () => {
  const { store, service, task } = setup();
  const next = store.createTask({ title: '复习', projectId: null, estimateMinutes: 25 });
  service.execute('updateTask', { ...next, tags: [], dependencies: [task.id] });
  expect(() => service.execute('start', { taskId: next.id })).toThrow(/前置/);
  expect(() => service.execute('updateTask', { ...task, tags: [], dependencies: [next.id] })).toThrow(/循环/);
  store.setTaskDone(task.id, true); expect(() => service.execute('start', { taskId: next.id })).not.toThrow();
});
it('creates repeated plans and moves a plan atomically, protecting checked-in entries', () => {
  const { store, service, task } = setup();
  service.execute('repeatPlan', { id: task.id, startDate: '2026-09-10', endDate: '2026-09-12', everyDays: 1, minutes: 25 });
  expect(store.snapshot().plans).toHaveLength(3);
  service.execute('movePlan', { id: task.id, from: '2026-09-10', to: '2026-09-13' });
  expect(store.daily('2026-09-10').plan?.entries).toHaveLength(0);
  expect(store.daily('2026-09-13').plan?.entries[0]?.taskId).toBe(task.id);
  service.execute('checkIn', { id: task.id, date: '2026-09-13', done: true });
  expect(() => service.execute('movePlan', { id: task.id, from: '2026-09-13', to: '2026-09-14' })).toThrow(/打卡/);
  expect(store.daily('2026-09-13').plan?.entries).toHaveLength(1);
});
it('removes projects without deleting their tasks and persists explicit ordering', () => {
  const { store, service, task } = setup(); const p = store.createProject('旧项目');
  service.execute('updateProject', { id: p.id, name: '新项目' });
  service.execute('updateTask', { ...task, projectId: p.id, tags: [], dependencies: [] });
  service.execute('deleteProject', { id: p.id });
  expect(store.snapshot().tasks[0]?.projectId).toBe(null);
  const next = store.createTask({ title: '后创建', projectId: null, estimateMinutes: 25 });
  service.execute('reorderTasks', { ids: [task.id, next.id] });
  expect(store.snapshot().tasks.map(t => t.id)).toEqual([task.id, next.id]);
});
it('validates whole category batches before saving and exposes category totals', () => {
  const { store, service } = setup();
  service.execute('manageCategories', { entries: [{ app: 'Code.exe', category: '学习' }], remove: [] });
  expect(store.snapshot().categories).toEqual([{ app: 'code.exe', category: '学习' }]);
  expect(() => service.execute('manageCategories', { entries: [{ app: 'x', category: '工作' }, { app: '', category: 'x' }], remove: [] })).toThrow();
  expect(store.snapshot().categories).toHaveLength(1);
  service.execute('manageCategories', { entries: [], remove: ['CODE.EXE'] });
  expect(store.snapshot().categories).toEqual([]);
});
it('backs up schema v5 and preserves old planned completion without inventing a timestamp', () => {
  const dir = mkdtempSync(join(tmpdir(), 'study-management-')); const path = join(dir, 'data.sqlite');
  let store = new StudyStore(path);
  try {
    const task = store.createTask({ title: '旧任务', projectId: null, estimateMinutes: 25 });
    store.savePlan('2026-09-09', [{ taskId: task.id, minutes: 25 }]); store.setTaskDone(task.id, true); store.close();
    const db = new DatabaseSync(path); db.exec('DROP TABLE daily_plan_reminders; DROP TABLE daily_checkins; DROP TABLE task_details; DROP TABLE project_order; PRAGMA user_version=5'); db.close();
    store = new StudyStore(path);
    expect(store.snapshot().checkins).toEqual([{ date: '2026-09-09', taskId: task.id, checkedAt: null }]);
    expect(store.daily('2026-09-09').effectiveMs).toBe(0);
    expect(readdirSync(dir).filter(file => file.endsWith('.v5.sqlite'))).toHaveLength(1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
it('rolls back earlier repeated dates if a later day exceeds capacity', () => {
  const { store, service, task } = setup(); const others = Array.from({ length: 6 }, (_, n) => store.createTask({ title: String(n), projectId: null, estimateMinutes: 240 }));
  store.savePlan('2026-09-11', others.map(t => ({ taskId: t.id, minutes: 240 })));
  expect(() => service.execute('repeatPlan', { id: task.id, startDate: '2026-09-10', endDate: '2026-09-11', everyDays: 1, minutes: 25 })).toThrow(/1440/);
  expect(store.daily('2026-09-10').plan).toBe(null);
  expect(store.daily('2026-09-11').plan?.entries).toHaveLength(6);
});
