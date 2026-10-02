import { afterEach, expect, it } from 'vitest';
import { StudyStore } from '../src/desktop/store';
import { DesktopService } from '../src/desktop/service';
import { parseImport, MAX_IMPORT_BYTES } from '../src/import/json-plan';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const stores: StudyStore[] = [];
const sample = { schemaVersion: 1, tasks: [{ taskKey: 'read', project: '阅读', title: '第一章', estimateMinutes: 45 }], plans: [{ date: '2026-09-11', taskKey: 'read', minutes: 45 }] };
const dirs: string[] = [];
function setup(path = ':memory:') {
  const store = new StudyStore(path); stores.push(store);
  const service = new DesktopService(store, { state: () => ({ running: false, taskId: null, remainingSeconds: 0, totalSeconds: 0, app: null, message: '', notification: 'none' }), start() {}, stop() {} });
  return { store, service };
}
afterEach(() => { stores.splice(0).forEach(s => s.close()); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
function preview(service: DesktopService, value: unknown = sample, choices?: unknown) {
  return service.execute('previewImport', { content: JSON.stringify(value), choices }).importPreview!;
}
function confirm(service: DesktopService, token: string) { return service.execute('confirmImport', { token }); }
it('previews a JSON plan without writing any tasks or plans', () => {
  const { store, service } = setup();
  const result = service.execute('previewImport', { content: JSON.stringify(sample) });
  expect(result).toHaveProperty('importPreview');
  expect(store.snapshot().tasks).toEqual([]);
  expect(store.daily('2026-09-11').plan).toBeNull();
});

it('commits projects, tasks and plans, survives reopening and skips equivalent JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'studyflow-import-')); dirs.push(dir); const path = join(dir, 'test.sqlite');
  const { store, service } = setup(path); const existing = store.createProject('阅读');
  const p = preview(service); expect(p.projects[0]?.selectedId).toBe(existing.id);
  expect(confirm(service, p.token).importResult).toBe('imported');
  const task = store.snapshot().tasks[0]!;
  expect(task).toMatchObject({ title: '第一章', projectId: existing.id, done: false, spentMs: 0 }); expect(task.id).not.toBe('read');
  expect(task.position).toBeLessThan(0);
  store.setTaskDone(task.id, true); store.addFocusTime(task.id, 12345); store.close();
  const again = setup(path);
  expect(again.store.daily('2026-09-11').plan?.entries).toEqual([{ taskId: task.id, title: '第一章', minutes: 45 }]);
  const duplicate = again.service.execute('previewImport', { content: '\uFEFF' + JSON.stringify(sample, null, 2) }).importPreview!;
  expect(duplicate.duplicate).toBe(true); expect(confirm(again.service, duplicate.token).importResult).toBe('duplicate');
  expect(again.store.snapshot().tasks).toEqual([{ ...task, done: true, spentMs: 12345 }]);
});

it('cancels previews, rejects forged/reused tokens and invalidates the old preview after a parse failure', () => {
  const { service, store } = setup(); const p = preview(service);
  expect(() => confirm(service, 'forged')).toThrow(/失效/);
  service.execute('cancelImport'); expect(() => confirm(service, p.token)).toThrow(/失效/);
  const next = preview(service);
  expect(() => service.execute('previewImport', { content: '{' })).toThrow(/语法/);
  expect(() => confirm(service, next.token)).toThrow(/失效/);
  const final = preview(service); confirm(service, final.token); expect(() => confirm(service, final.token)).toThrow(/失效/);
  expect(store.snapshot().tasks).toHaveLength(1);
});

it('blocks reused external keys from changed files and requires an explicit project choice on ambiguity', () => {
  const { store, service } = setup(); store.createProject('阅读'); const selected = store.createProject('阅读');
  const ambiguous = preview(service); expect(ambiguous.errors.join()).toContain('同名');
  expect(() => confirm(service, ambiguous.token)).toThrow(/冲突/); expect(store.snapshot().tasks).toHaveLength(0);
  const chosen = preview(service, sample, { projectIds: { 阅读: selected.id }, replaceDates: [] });
  confirm(service, chosen.token); expect(store.snapshot().tasks[0]?.projectId).toBe(selected.id);
  const conflict = preview(service, { ...sample, plans: [] }); expect(conflict.errors.join()).toContain('taskKey');
  expect(() => confirm(service, conflict.token)).toThrow(/冲突/);
});

it('updates only explicitly selected imported tasks while preserving progress and metadata', () => {
  const dir = mkdtempSync(join(tmpdir(), 'studyflow-import-update-')); dirs.push(dir); const path = join(dir, 'test.sqlite');
  const { store, service } = setup(path); const first = preview(service); confirm(service, first.token);
  const task = store.snapshot().tasks[0]!; store.setTaskDone(task.id, true); store.addFocusTime(task.id, 12345);
  const db = new DatabaseSync(path);
  db.prepare('INSERT OR REPLACE INTO task_details(taskId,tags,dependencies,position,archived) VALUES(?,?,?,?,0)')
    .run(task.id, JSON.stringify(['保留标签']), JSON.stringify(['dependency-id']), 7);
  db.close();
  const changed = { schemaVersion: 1, tasks: [{ taskKey: 'read', project: '进阶阅读', title: '第二章', estimateMinutes: 60 }], plans: [{ date: '2026-09-11', taskKey: 'read', minutes: 60 }] };
  const conflict = preview(service, changed);
  expect(conflict.errors.join()).toContain('明确选择更新');
  expect(conflict.taskUpdates).toEqual([{ taskKey: 'read', taskId: task.id, selected: false,
    before: { project: '阅读', title: '第一章', estimateMinutes: 45 },
    after: { project: '进阶阅读', title: '第二章', estimateMinutes: 60 } }]);
  const selected = preview(service, changed, { projectIds: {}, replaceDates: [], updateTaskKeys: ['read'] });
  expect(selected.errors).toEqual([]); expect(selected.taskUpdates[0]?.selected).toBe(true);
  confirm(service, selected.token);
  expect(store.snapshot().tasks[0]).toMatchObject({ id: task.id, title: '第二章', estimateMinutes: 60, done: true, spentMs: 12345 });
  const saved = new DatabaseSync(path);
  expect(saved.prepare('SELECT tags,dependencies,position,archived FROM task_details WHERE taskId=?').get(task.id)).toEqual({
    tags: '["保留标签"]', dependencies: '["dependency-id"]', position: 7, archived: 0,
  });
  saved.close();
});

it('does not allow an archived imported task to be updated or recreated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'studyflow-import-archive-')); dirs.push(dir); const path = join(dir, 'test.sqlite');
  const { store, service } = setup(path); confirm(service, preview(service).token); const task = store.snapshot().tasks[0]!;
  const db = new DatabaseSync(path);
  db.prepare('UPDATE task_details SET archived=1 WHERE taskId=?').run(task.id); db.close();
  const changed = { ...sample, tasks: [{ ...sample.tasks[0]!, title: '不得恢复的标题' }] };
  const result = preview(service, changed, { projectIds: {}, replaceDates: [], updateTaskKeys: ['read'] });
  expect(result.errors.join()).toContain('已归档');
  expect(() => confirm(service, result.token)).toThrow(/冲突/);
  const saved = new DatabaseSync(path); expect(saved.prepare('SELECT title FROM tasks WHERE id=?').get(task.id)?.title).toBe('第一章'); saved.close();
});

it('invalidates an update preview when the original task changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'studyflow-import-revision-')); dirs.push(dir); const path = join(dir, 'test.sqlite');
  const { store, service } = setup(path); confirm(service, preview(service).token); const task = store.snapshot().tasks[0]!;
  const db = new DatabaseSync(path);
  const changed = { ...sample, tasks: [{ ...sample.tasks[0]!, title: '预览标题' }] };
  const result = preview(service, changed, { projectIds: {}, replaceDates: [], updateTaskKeys: ['read'] });
  db.prepare('UPDATE tasks SET title=? WHERE id=?').run('并发修改', task.id);
  db.close(); expect(() => confirm(service, result.token)).toThrow(/数据已变化/);
});

it('merges an updated task into the same day by replacing its minutes once', () => {
  const { store, service } = setup(); confirm(service, preview(service).token); const task = store.snapshot().tasks[0]!;
  const changed = { ...sample, tasks: [{ ...sample.tasks[0]!, title: '更新标题', estimateMinutes: 60 }], plans: [{ ...sample.plans[0]!, minutes: 60 }] };
  const result = preview(service, changed, { projectIds: {}, replaceDates: [], updateTaskKeys: ['read'] });
  expect(result.days[0]).toMatchObject({ existingCount: 1, incomingCount: 1, totalMinutes: 60, replace: false });
  confirm(service, result.token);
  expect(store.daily('2026-09-11').plan?.entries).toEqual([{ taskId: task.id, title: '更新标题', minutes: 60 }]);
});

it('replaces minutes for the same task on the same day instead of duplicating the plan entry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'studyflow-import-plan-')); dirs.push(dir); const path = join(dir, 'test.sqlite');
  const { store, service } = setup(path); confirm(service, preview(service).token); const task = store.snapshot().tasks[0]!;
  const other = store.createTask({ title: '保留任务', projectId: null, estimateMinutes: 10 });
  store.savePlan('2026-09-11', [{ taskId: task.id, minutes: 20 }, { taskId: other.id, minutes: 10 }]);
  const changed = { ...sample, tasks: [{ ...sample.tasks[0]!, title: '更新标题' }], plans: [{ ...sample.plans[0]!, minutes: 55 }] };
  const result = preview(service, changed, { projectIds: {}, replaceDates: [], updateTaskKeys: ['read'] });
  expect(result.days[0]).toMatchObject({ existingCount: 2, incomingCount: 1, totalMinutes: 65 });
  confirm(service, result.token);
  expect(store.daily('2026-09-11').plan?.entries).toEqual([
    { taskId: task.id, title: '更新标题', minutes: 55 },
    { taskId: other.id, title: '保留任务', minutes: 10 },
  ]);
});

it('reports before confirmation when replacing a day would remove a checked-in task', () => {
  const { store, service } = setup(); confirm(service, preview(service).token); const task = store.snapshot().tasks[0]!;
  service.execute('checkIn', { id: task.id, date: '2026-09-11', done: true });
  const other = { schemaVersion: 1, tasks: [{ taskKey: 'other', project: '', title: '其他任务', estimateMinutes: 10 }], plans: [{ date: '2026-09-11', taskKey: 'other', minutes: 10 }] };
  const result = preview(service, other, { projectIds: {}, replaceDates: ['2026-09-11'] });
  expect(result.errors.join()).toContain('已打卡');
  expect(() => confirm(service, result.token)).toThrow(/冲突/);
});

it('invalidates a plan preview when a daily check-in changes', () => {
  const { store, service } = setup(); confirm(service, preview(service).token); const task = store.snapshot().tasks[0]!;
  const other = { schemaVersion: 1, tasks: [{ taskKey: 'other', project: '', title: '其他任务', estimateMinutes: 10 }], plans: [{ date: '2026-09-11', taskKey: 'other', minutes: 10 }] };
  const result = preview(service, other);
  service.execute('checkIn', { id: task.id, date: '2026-09-11', done: true });
  expect(() => confirm(service, result.token)).toThrow(/数据已变化/);
});

it('preserves existing plans by default, checks combined limits and replaces only explicitly selected days', () => {
  const { store, service } = setup();
  const old = store.createTask({ title: '原任务', projectId: null, estimateMinutes: 20 }); store.addFocusTime(old.id, 500);
  store.savePlan('2026-09-11', [{ taskId: old.id, minutes: 1400 }]);
  store.savePlan('2026-09-12', [{ taskId: old.id, minutes: 20 }]);
  const over = preview(service); expect(over.errors.join()).toContain('1440');
  expect(() => confirm(service, over.token)).toThrow();
  const replace = preview(service, sample, { projectIds: {}, replaceDates: ['2026-09-11'] }); confirm(service, replace.token);
  expect(store.daily('2026-09-11').plan?.entries).toHaveLength(1);
  expect(store.daily('2026-09-12').plan?.entries[0]?.taskId).toBe(old.id);
  expect(store.snapshot().tasks.find(t => t.id === old.id)?.spentMs).toBe(500);
  const other = { schemaVersion: 1, tasks: [{ ...sample.tasks[0]!, taskKey: 'other' }], plans: [{ date: '2026-09-11', taskKey: 'other', minutes: 10 }] };
  confirm(service, preview(service, other).token); expect(store.daily('2026-09-11').plan?.entries).toHaveLength(2);
});

it('rejects stale previews when plans or project candidates change', () => {
  const { store, service } = setup(); const p = preview(service);
  store.savePlan('2026-09-11', []); expect(() => confirm(service, p.token)).toThrow(/数据已变化/);
  const next = preview(service); store.createProject('阅读'); expect(() => confirm(service, next.token)).toThrow(/数据已变化/);
  expect(store.snapshot().tasks).toHaveLength(0);
});

it('rolls back every write when plan persistence fails midway', () => {
  const dir = mkdtempSync(join(tmpdir(), 'studyflow-import-')); dirs.push(dir); const path = join(dir, 'test.sqlite');
  const { store, service } = setup(path); const db = new DatabaseSync(path);
  try {
    db.exec("CREATE TRIGGER fail_import BEFORE INSERT ON daily_plans BEGIN SELECT RAISE(ABORT, 'injected failure'); END;");
    const p = preview(service); expect(() => confirm(service, p.token)).toThrow();
    expect(store.snapshot().tasks).toHaveLength(0); expect(store.snapshot().projects).toHaveLength(0);
    expect(db.prepare('SELECT count(*) AS n FROM import_batches').get()?.n).toBe(0);
    expect(db.prepare('SELECT count(*) AS n FROM imported_tasks').get()?.n).toBe(0);
    db.exec('DROP TRIGGER fail_import'); confirm(service, preview(service).token);
  } finally { db.close(); }
});

it('backs up schema v4 before migration and preserves tasks, plans and accumulated time', () => {
  const dir = mkdtempSync(join(tmpdir(), 'studyflow-import-')); dirs.push(dir); const path = join(dir, 'test.sqlite');
  const { store } = setup(path); const task = store.createTask({ title: '历史任务', projectId: null, estimateMinutes: 10 });
  store.addFocusTime(task.id, 1000); store.savePlan('2026-09-11', [{ taskId: task.id, minutes: 10 }]); store.close();
  const db = new DatabaseSync(path); db.exec('DROP TABLE daily_plan_reminders; DROP TABLE daily_checkins; DROP TABLE task_details; DROP TABLE project_order; DROP TABLE imported_tasks; DROP TABLE import_batches; PRAGMA user_version=4'); db.close();
  const again = setup(path); expect(again.store.snapshot().tasks[0]?.spentMs).toBe(1000);
  expect(again.store.daily('2026-09-11').plan?.entries[0]?.taskId).toBe(task.id);
  const backup = readdirSync(dir).find(f => f.endsWith('.v4.sqlite'))!; expect(backup).toBeTruthy();
  const saved = new DatabaseSync(join(dir, backup));
  try { expect(saved.prepare('PRAGMA user_version').get()?.user_version).toBe(4); expect(saved.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok'); } finally { saved.close(); }
});

it.each([
  [{ ...sample, schemaVersion: 2 }, 'schemaVersion'],
  [{ ...sample, extra: true }, '$'],
  [{ ...sample, tasks: [] }, 'tasks'],
  [{ ...sample, tasks: [sample.tasks[0], sample.tasks[0]] }, 'tasks[1].taskKey'],
  [{ ...sample, tasks: [{ ...sample.tasks[0], spentMs: 1 }] }, 'tasks[0]'],
  [{ ...sample, tasks: [{ ...sample.tasks[0], estimateMinutes: 1.5 }] }, 'estimateMinutes'],
  [{ ...sample, plans: [{ ...sample.plans[0], date: '2026-02-29' }] }, 'date'],
  [{ ...sample, plans: [{ ...sample.plans[0], taskKey: 'missing' }] }, 'taskKey'],
  [{ ...sample, plans: [sample.plans[0], sample.plans[0]] }, 'plans[1]'],
  [{ ...sample, plans: [{ ...sample.plans[0], minutes: 0 }] }, 'minutes'],
])('rejects malformed document %# with a field location', (value, path) => { expect(() => parseImport(JSON.stringify(value))).toThrow(String(path)); });

it('accepts leap dates and hostile text as plain data and bounds bytes and rows', () => {
  expect(parseImport(JSON.stringify({ ...sample, tasks: [{ ...sample.tasks[0], title: '<img src=x>' }], plans: [{ ...sample.plans[0], date: '2024-02-29' }] })).plans[0]?.date).toBe('2024-02-29');
  expect(() => parseImport('中'.repeat(MAX_IMPORT_BYTES / 2))).toThrow(/1 MiB/);
  expect(() => parseImport(JSON.stringify({ ...sample, tasks: Array.from({ length: 1001 }, (_, i) => ({ ...sample.tasks[0], taskKey: String(i) })) }))).toThrow(/1000/);
});

it.each(['before-preview', 'before-confirm'] as const)('protects a focused task from import updates started %s', timing => {
  const store = new StudyStore(':memory:'); stores.push(store);
  let focusedId: string | null = null;
  const service = new DesktopService(store, { state: () => ({ running: focusedId !== null, taskId: focusedId, remainingSeconds: 60, totalSeconds: 60, app: null, message: '', notification: 'none' }), start() {}, stop() {} });
  confirm(service, preview(service).token);
  const task = store.snapshot().tasks[0]!;
  if (timing === 'before-preview') focusedId = task.id;
  const changed = { ...sample, tasks: [{ ...sample.tasks[0]!, title: '不得覆盖专注中的任务' }] };
  const result = preview(service, changed, { projectIds: {}, replaceDates: [], updateTaskKeys: ['read'] });
  if (timing === 'before-preview') expect(result.errors.join()).toContain('专注');
  else { expect(result.errors).toEqual([]); focusedId = task.id; }
  expect(() => confirm(service, result.token)).toThrow(/专注/);
  expect(store.snapshot().tasks[0]?.title).toBe('第一章');
  expect(store.daily('2026-09-11').plan?.entries[0]?.title).toBe('第一章');
});

it('keeps an import preview valid while its task gains focus time', () => {
  const { store, service } = setup(); confirm(service, preview(service).token);
  const task = store.snapshot().tasks[0]!;
  const changed = { ...sample, tasks: [{ ...sample.tasks[0]!, title: '更新后的标题' }] };
  const result = preview(service, changed, { projectIds: {}, replaceDates: [], updateTaskKeys: ['read'] });
  store.addFocusTime(task.id, 30000);
  expect(confirm(service, result.token).importResult).toBe('imported');
  expect(store.snapshot().tasks[0]).toMatchObject({ title: '更新后的标题', spentMs: 30000 });
});

it('allows importing unrelated tasks while a focus session is running', () => {
  const store = new StudyStore(':memory:'); stores.push(store);
  const active = store.createTask({ title: '正在专注的任务', projectId: null, estimateMinutes: 20 });
  const service = new DesktopService(store, { state: () => ({ running: true, taskId: active.id, remainingSeconds: 60, totalSeconds: 60, app: null, message: '', notification: 'none' }), start() {}, stop() {} });
  const result = preview(service);
  expect(result.errors).toEqual([]);
  store.addFocusTime(active.id, 30000);
  expect(confirm(service, result.token).importResult).toBe('imported');
  expect(store.snapshot().tasks).toHaveLength(2);
});

it('does not invalidate an independent import when another imported task changes', () => {
  const { store, service } = setup(); confirm(service, preview(service).token);
  const task = store.snapshot().tasks[0]!;
  const other = { schemaVersion: 1, tasks: [{ taskKey: 'new', project: '', title: '独立任务', estimateMinutes: 15 }], plans: [] };
  const result = preview(service, other);
  store.addFocusTime(task.id, 30000);
  store.manage('updateTask', { id: task.id, title: '无关的修改', projectId: task.projectId, estimateMinutes: 30 });
  expect(confirm(service, result.token).importResult).toBe('imported');
  expect(store.snapshot().tasks).toHaveLength(2);
});

it('keeps an import token valid when saving independent daily reminder settings', () => {
  const { store, service } = setup(); const result = preview(service);
  const saved = service.execute('planReminderSettings', { enabled: true, time: '09:30' });
  expect(saved.settings.planReminder).toEqual({ enabled: true, time: '09:30' });
  expect(saved.planReminder).toBeDefined();
  expect(confirm(service, result.token).importResult).toBe('imported');
  expect(store.snapshot().tasks).toHaveLength(1);
});

it.each(['archive', 'project', 'estimate'] as const)('still invalidates a target import after a relevant %s change', field => {
  const { store, service } = setup(); confirm(service, preview(service).token);
  const task = store.snapshot().tasks[0]!; const otherProject = store.createProject('其他项目');
  const changed = { ...sample, tasks: [{ ...sample.tasks[0]!, title: '预览中的更新' }] };
  const result = preview(service, changed, { projectIds: {}, replaceDates: [], updateTaskKeys: ['read'] });
  if (field === 'archive') store.manage('archiveTask', { id: task.id, archived: true });
  else store.manage('updateTask', { id: task.id, title: task.title, projectId: field === 'project' ? otherProject.id : task.projectId, estimateMinutes: field === 'estimate' ? 60 : task.estimateMinutes });
  expect(() => confirm(service, result.token)).toThrow(/数据已变化/);
});

it.each([false, true])('previews exact daily plan changes before replacement=%s', replace => {
  const { store, service } = setup(); confirm(service, preview(service).token);
  const task = store.snapshot().tasks[0]!;
  const old = store.createTask({ title: '原有练习', projectId: null, estimateMinutes: 20 });
  store.savePlan('2026-09-11', [{ taskId: task.id, minutes: 45 }, { taskId: old.id, minutes: 20 }]);
  const changed = { ...sample, tasks: [...sample.tasks, { taskKey: 'new', project: '', title: '新练习', estimateMinutes: 15 }], plans: [{ date: '2026-09-11', taskKey: 'read', minutes: 60 }, { date: '2026-09-11', taskKey: 'new', minutes: 15 }] };
  const result = preview(service, changed, { projectIds: {}, replaceDates: replace ? ['2026-09-11'] : [], updateTaskKeys: ['read'] });
  expect(result.days[0]).toMatchObject({ changes: [
    { taskId: task.id, before: { title: '第一章', minutes: 45 }, after: { title: '第一章', minutes: 60 } },
    { taskId: old.id, before: { title: '原有练习', minutes: 20 }, after: replace ? null : { title: '原有练习', minutes: 20 } },
    { taskKey: 'new', before: null, after: { title: '新练习', minutes: 15 } },
  ] });
  confirm(service, result.token);
  expect(store.daily('2026-09-11').plan?.entries.map(entry => [entry.title, entry.minutes])).toEqual(replace
    ? [['第一章', 60], ['新练习', 15]] : [['第一章', 60], ['原有练习', 20], ['新练习', 15]]);
});

it('previews a retained plan using the selected task update even without an incoming entry for that task', () => {
  const { store, service } = setup(); confirm(service, preview(service).token);
  const task = store.snapshot().tasks[0]!;
  const changed = { ...sample, tasks: [
    { ...sample.tasks[0]!, title: '本次更新后的标题', estimateMinutes: 60 },
    { taskKey: 'new', project: '', title: '新练习', estimateMinutes: 15 },
  ], plans: [{ date: '2026-09-11', taskKey: 'new', minutes: 15 }] };
  const result = preview(service, changed, { projectIds: {}, replaceDates: [], updateTaskKeys: ['read'] });
  expect(result.errors).toEqual([]);
  expect(result.days[0]?.changes?.find(change => change.taskId === task.id)).toMatchObject({
    before: { title: '第一章', minutes: 45 }, after: { title: '本次更新后的标题', minutes: 45 },
  });
  expect(store.daily('2026-09-11').plan?.entries[0]?.title).toBe('第一章');
  confirm(service, result.token);
  expect(store.daily('2026-09-11').plan?.entries).toMatchObject([
    { taskId: task.id, title: '本次更新后的标题', minutes: 45 }, { title: '新练习', minutes: 15 },
  ]);
});
