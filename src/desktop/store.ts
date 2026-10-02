import { DailyStore } from './daily';
import { migrateV2, migrateV3, migrateV4, migrateV5, migrateV6, migrateV7 } from './migration';
import { PlanReminderStore } from './plan-reminder-store';
import { planReminderSettings } from './plan-reminder';
import { ManagementStore } from './management';
import type { ManagementCommand } from './management-commands';
import { ImportStore } from './import-store';
import type { ImportDocument, ImportChoices } from '../import/json-plan';
import { timerPreferences } from './preferences';
import { saveActivityCheckpoint, type ActivityCheckpoint } from './continuous';
import { HistoryStore, type CurrentFocusClock, type HistoryCheckpoint } from './history';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { minutes, record, textValue, type DataSnapshot, type Project, type Task, type Settings } from './contracts';
import { normalizeApp } from '../focus/normalize-app';

export class StudyStore {
  private db: DatabaseSync;
  private closed = false;
  private readonly histories: HistoryStore;
  readonly recoveredSessions: number;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    try {
      const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version);
      if (![0, 1, 2, 3, 4, 5, 6, 7].includes(version)) throw new Error('数据版本较新，请使用匹配版本的 StudyFlow；原数据未更改');
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
      if (version === 0) this.db.exec(`BEGIN;
        CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE tasks (id TEXT PRIMARY KEY, projectId TEXT REFERENCES projects(id), title TEXT NOT NULL,
          done INTEGER NOT NULL DEFAULT 0 CHECK(done IN (0,1)), estimateMinutes INTEGER NOT NULL,
          spentMs INTEGER NOT NULL DEFAULT 0 CHECK(spentMs >= 0));
        CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK(id=1), durationMinutes INTEGER NOT NULL, whitelist TEXT NOT NULL);
        INSERT INTO settings VALUES (1,25,'[]'); PRAGMA user_version = 1; COMMIT;`);
      if (version < 2) migrateV2(this.db, path, version === 1);
      if (version < 3) migrateV3(this.db, path, version === 2);
      if (version < 4) migrateV4(this.db, path, version === 3);
      if (version < 5) migrateV5(this.db, path, version === 4);
      if (version < 6) migrateV6(this.db, path, version === 5);
      if (version < 7) migrateV7(this.db, path, version === 6);
      this.db.exec('PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;');
      this.histories = new HistoryStore(this.db);
      this.recoveredSessions = this.histories.recover();
    } catch (error) { this.db.close(); this.closed = true; throw error; }
  }
  snapshot(): DataSnapshot {
    const projects = this.db.prepare('SELECT p.id,p.name FROM projects p LEFT JOIN project_order o ON o.projectId=p.id ORDER BY COALESCE(o.position,p.rowid),p.rowid').all().map(row => ({ id: String(row.id), name: String(row.name) }));
    const rows = this.db.prepare('SELECT t.*,d.tags,d.dependencies,d.archived,COALESCE(d.position,-t.rowid) AS position FROM tasks t LEFT JOIN task_details d ON d.taskId=t.id ORDER BY position,t.rowid DESC').all();
    const convert = (row: typeof rows[number]): Task => ({
      id: String(row.id), title: String(row.title), projectId: row.projectId === null ? null : String(row.projectId),
      done: row.done === 1, estimateMinutes: Number(row.estimateMinutes), spentMs: Number(row.spentMs),
      tags: row.tags ? JSON.parse(String(row.tags)) as string[] : [], dependencies: row.dependencies ? JSON.parse(String(row.dependencies)) as string[] : [], position: Number(row.position),
    });
    const row = this.db.prepare('SELECT * FROM settings WHERE id=1').get();
    if (!row) throw new Error('设置数据缺失，请恢复备份');
    const whitelist: unknown = JSON.parse(String(row.whitelist));
    const settings = this.validateSettings({ ...record(JSON.parse(String(row.preferences))), durationMinutes: Number(row.durationMinutes), whitelist, recordAppActivity: row.recordAppActivity === 1 });
    const plans = this.db.prepare('SELECT date,data FROM daily_plans ORDER BY date').all().map(row => ({
      date: String(row.date), entries: (JSON.parse(String(row.data)) as import('./daily').DailyPlan).entries,
    }));
    const tasks = rows.filter(row => row.archived !== 1).map(convert);
    const archivedTasks = rows.filter(row => row.archived === 1).map(convert);
    const checkins = this.db.prepare('SELECT date,taskId,checkedAt FROM daily_checkins ORDER BY date,taskId').all().map(row => ({ date: String(row.date), taskId: String(row.taskId), checkedAt: row.checkedAt === null ? null : Number(row.checkedAt) }));
    const categories = this.db.prepare('SELECT app,category FROM app_categories ORDER BY app').all().map(row => ({ app: String(row.app), category: String(row.category) }));
    return { projects, tasks, settings, plans, archivedTasks, checkins, categories };
  }
  createProject(name: unknown): Project {
    const project = { id: randomUUID(), name: textValue(name, 80) };
    this.db.prepare('INSERT INTO projects VALUES (?,?)').run(project.id, project.name);
    return project;
  }
  createTask(value: unknown): Task {
    const input = record(value);
    const projectId = input.projectId === null ? null : textValue(input.projectId, 80);
    if (projectId && !this.db.prepare('SELECT id FROM projects WHERE id=?').get(projectId)) throw new Error('项目不存在');
    const task: Task = { id: randomUUID(), title: textValue(input.title), projectId,
      estimateMinutes: minutes(input.estimateMinutes), done: false, spentMs: 0 };
    this.db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?)').run(task.id, projectId, task.title, 0, task.estimateMinutes, 0);
    return task;
  }
  setTaskDone(id: unknown, done: unknown): void {
    if (typeof done !== 'boolean') throw new Error('无效完成状态');
    if (!this.db.prepare('UPDATE tasks SET done=? WHERE id=?').run(done ? 1 : 0, textValue(id, 80)).changes) throw new Error('任务不存在');
  }
  addFocusTime(id: string, elapsedMs: number): void {
    if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0) throw new Error('无效专注时间');
    if (!this.db.prepare('UPDATE tasks SET spentMs=spentMs+? WHERE id=?').run(elapsedMs, id).changes) throw new Error('任务不存在');
  }
  private validateSettings(value: unknown): Settings {
    const input = record(value);
    if (!Array.isArray(input.whitelist) || input.whitelist.length > 100) throw new Error('白名单最多 100 个应用');
    if (input.recordAppActivity !== undefined && typeof input.recordAppActivity !== 'boolean') throw new Error('无效活动记录设置');
    if (input.allDayActivity !== undefined && typeof input.allDayActivity !== 'boolean') throw new Error('无效全天记录设置');
    return { ...timerPreferences(input), planReminder: planReminderSettings(input.planReminder), allDayActivity: input.allDayActivity === true, recordAppActivity: input.recordAppActivity === true, durationMinutes: minutes(input.durationMinutes), whitelist: [...new Set(input.whitelist.map(v => normalizeApp(textValue(v, 260))))] };
  }
  updateSettings(value: unknown): void {
    const settings = this.validateSettings({ ...this.snapshot().settings, ...record(value) });
    this.db.prepare('UPDATE settings SET durationMinutes=?,whitelist=?,recordAppActivity=?,preferences=? WHERE id=1').run(settings.durationMinutes, JSON.stringify(settings.whitelist), settings.recordAppActivity ? 1 : 0, JSON.stringify({ ...timerPreferences(settings), allDayActivity: settings.allDayActivity, planReminder: settings.planReminder }));
  }
  updatePlanReminderSettings(value: unknown): void { this.updateSettings({ planReminder: planReminderSettings(record(value)) }); }
  planReminderStatus(now = Date.now()) { return new PlanReminderStore(this.db).status(now); }
  claimPlanReminder(now: number) { return new PlanReminderStore(this.db).claim(now); }
  respondPlanReminder(token: unknown, action: unknown, now: number) { return new PlanReminderStore(this.db).respond(token, action, now); }
  releasePlanReminder(token: unknown, now: number): void { new PlanReminderStore(this.db).release(token, now); }
  saveActivityCheckpoint(cp: ActivityCheckpoint): void { saveActivityCheckpoint(this.db, cp); }
  manage(command: ManagementCommand, payload: unknown): void { new ManagementStore(this.db).execute(command, payload); }
  assertTaskReady(id: string): void { new ManagementStore(this.db).assertReady(id); }
  saveCheckpoint(checkpoint: HistoryCheckpoint): void { this.histories.save(checkpoint); }
  focusTime(date: string, current?: CurrentFocusClock): number { return this.histories.focusTime(date, current); }
  history(date: unknown) { return this.histories.read(date); }
  saveReview(date: unknown, notes: unknown): void { this.histories.review(date, notes); }
  deleteHistory(date: unknown): void { this.histories.delete(date); }
  daily(date: unknown) { return new DailyStore(this.db).read(date); }
  savePlan(date: unknown, entries: unknown): void { new DailyStore(this.db).savePlan(date, entries); }
  saveDailyReview(date: unknown, review: unknown): void { new DailyStore(this.db).review(date, review); }
  classifyApp(app: unknown, category: unknown): void { new DailyStore(this.db).classify(app, category); }
  previewImport(document: ImportDocument, choices: ImportChoices) { return new ImportStore(this.db).preview(document, choices); }
  commitImport(document: ImportDocument, choices: ImportChoices, revision: string): boolean { return new ImportStore(this.db).commit(document, choices, revision); }
  close(): void { if (!this.closed) { this.db.close(); this.closed = true; } }
}
