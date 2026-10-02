import type { DatabaseSync } from 'node:sqlite';
import { minutes, record, textValue } from './contracts';
import { historyDate } from './history';
import { DailyStore, type DailyPlan } from './daily';
import { transaction } from './migration';
import { normalizeApp } from '../focus/normalize-app';

import type { ManagementCommand } from './management-commands';
function strings(value: unknown, limit: number, width: number): string[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error(`列表最多 ${limit} 项`);
  return [...new Set(value.map(v => textValue(v, width)))];
}
export class ManagementStore {
  constructor(private readonly db: DatabaseSync) {}
  private task(value: unknown) {
    const id = textValue(value, 80); const row = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    if (!row) throw new Error('任务不存在'); return row;
  }
  private active(value: unknown) {
    const task = this.task(value);
    if (this.db.prepare('SELECT archived FROM task_details WHERE taskId=?').get(String(task.id))?.archived === 1) throw new Error('请先恢复已删除任务');
    return task;
  }
  private details(id: string) { this.db.prepare('INSERT OR IGNORE INTO task_details(taskId,position) SELECT id,-rowid FROM tasks WHERE id=?').run(id); }
  private entries(date: string) {
    const row = this.db.prepare('SELECT data FROM daily_plans WHERE date=?').get(date);
    return row ? (JSON.parse(String(row.data)) as DailyPlan).entries : [];
  }
  assertReady(id: string): void {
    this.active(id);
    const row = this.db.prepare('SELECT dependencies FROM task_details WHERE taskId=?').get(id);
    const dependencies = row ? JSON.parse(String(row.dependencies)) as string[] : [];
    if (dependencies.some(dep => this.task(dep).done !== 1)) throw new Error('请先完成前置任务');
  }
  execute(command: ManagementCommand, value: unknown): void {
    const input = record(value);
    transaction(this.db, () => {
      switch (command) {
        case 'updateTask': {
          const id = String(this.active(input.id).id); const title = textValue(input.title);
          const projectId = input.projectId === null ? null : textValue(input.projectId, 80);
          if (projectId && !this.db.prepare('SELECT id FROM projects WHERE id=?').get(projectId)) throw new Error('项目不存在');
          const estimate = minutes(input.estimateMinutes); const tags = strings(input.tags ?? [], 20, 40);
          const dependencies = strings(input.dependencies ?? [], 100, 80);
          const reaches = (node: string, visited: Set<string>): boolean => {
            if (node === id) return true; if (visited.has(node)) return false; visited.add(node);
            const row = this.db.prepare('SELECT dependencies FROM task_details WHERE taskId=?').get(node);
            return row ? (JSON.parse(String(row.dependencies)) as string[]).some(dep => reaches(dep, visited)) : false;
          };
          for (const dep of dependencies) { this.active(dep); if (reaches(dep, new Set())) throw new Error('前置任务不能形成循环'); }
          this.db.prepare('UPDATE tasks SET title=?,projectId=?,estimateMinutes=? WHERE id=?').run(title, projectId, estimate, id);
          this.details(id); this.db.prepare('UPDATE task_details SET tags=?,dependencies=? WHERE taskId=?').run(JSON.stringify(tags), JSON.stringify(dependencies), id); break;
        }
        case 'archiveTask': {
          const id = String(this.task(input.id).id); if (typeof input.archived !== 'boolean') throw new Error('无效删除状态');
          if (input.archived) {
            const blocking = this.db.prepare('SELECT d.dependencies FROM task_details d JOIN tasks t ON t.id=d.taskId WHERE d.archived=0 AND t.done=0').all();
            if (blocking.some(row => (JSON.parse(String(row.dependencies)) as string[]).includes(id))) throw new Error('其他未完成任务依赖此任务，请先移除依赖');
          }
          this.details(id); this.db.prepare('UPDATE task_details SET archived=? WHERE taskId=?').run(input.archived ? 1 : 0, id); break;
        }
        case 'updateProject': {
          if (!this.db.prepare('UPDATE projects SET name=? WHERE id=?').run(textValue(input.name, 80), textValue(input.id, 80)).changes) throw new Error('项目不存在'); break;
        }
        case 'deleteProject': {
          const id = textValue(input.id, 80);
          this.db.prepare('UPDATE tasks SET projectId=NULL WHERE projectId=?').run(id);
          this.db.prepare('DELETE FROM project_order WHERE projectId=?').run(id);
          if (!this.db.prepare('DELETE FROM projects WHERE id=?').run(id).changes) throw new Error('项目不存在'); break;
        }
        case 'reorderTasks': case 'reorderProjects': {
          const ids = strings(input.ids, 10000, 80);
          const tasks = command === 'reorderTasks';
          const expected = this.db.prepare(tasks ? 'SELECT t.id FROM tasks t LEFT JOIN task_details d ON d.taskId=t.id WHERE COALESCE(d.archived,0)=0' : 'SELECT id FROM projects').all().map(row => String(row.id));
          if (ids.length !== expected.length || expected.some(id => !ids.includes(id))) throw new Error('列表已变化，请刷新后排序');
          ids.forEach((id, position) => {
            if (tasks) { this.details(id); this.db.prepare('UPDATE task_details SET position=? WHERE taskId=?').run(position, id); }
            else this.db.prepare('INSERT INTO project_order VALUES(?,?) ON CONFLICT(projectId) DO UPDATE SET position=excluded.position').run(id, position);
          }); break;
        }
        case 'checkIn': {
          const id = String(this.active(input.id).id); const date = historyDate(input.date);
          if (typeof input.done !== 'boolean') throw new Error('无效打卡状态');
          if (!this.entries(date).some(e => e.taskId === id)) throw new Error('该日期没有此任务安排');
          if (input.done) this.db.prepare('INSERT INTO daily_checkins VALUES(?,?,?) ON CONFLICT(date,taskId) DO NOTHING').run(date, id, Date.now());
          else this.db.prepare('DELETE FROM daily_checkins WHERE date=? AND taskId=?').run(date, id); break;
        }
        case 'movePlan': {
          const id = String(this.active(input.id).id); const from = historyDate(input.from); const to = historyDate(input.to);
          if (from === to) break;
          if (this.db.prepare('SELECT taskId FROM daily_checkins WHERE date=? AND taskId=?').get(from, id)) throw new Error('已打卡安排不能移动，请先撤销该日打卡');
          const previous = this.entries(from); const entry = previous.find(e => e.taskId === id);
          if (!entry) throw new Error('原日期没有此任务安排');
          const target = this.entries(to); if (target.some(e => e.taskId === id)) throw new Error('目标日期已安排此任务');
          const daily = new DailyStore(this.db); daily.savePlan(to, [...target, entry]); daily.savePlan(from, previous.filter(e => e.taskId !== id)); break;
        }
        case 'repeatPlan': {
          const id = String(this.active(input.id).id); const start = historyDate(input.startDate); const end = historyDate(input.endDate);
          const step = input.everyDays; const amount = minutes(input.minutes);
          if (typeof step !== 'number' || !Number.isInteger(step) || step < 1 || step > 365 || end < start) throw new Error('重复间隔须为 1—365 天，结束日期不能早于开始日期');
          const first = Date.parse(start + 'T00:00:00Z'); const last = Date.parse(end + 'T00:00:00Z');
          if ((last - first) / 86400000 > 366) throw new Error('一次重复计划最多覆盖 367 天');
          const daily = new DailyStore(this.db);
          for (let time = first; time <= last; time += step * 86400000) {
            const date = new Date(time).toISOString().slice(0, 10); const entries = this.entries(date);
            if (entries.some(e => e.taskId === id)) continue;
            daily.savePlan(date, [...entries, { taskId: id, minutes: amount }]);
          } break;
        }
        case 'manageCategories': {
          if (!Array.isArray(input.entries) || input.entries.length > 500) throw new Error('一次最多 500 条分类');
          const entries = input.entries.map(v => { const row = record(v); return { app: normalizeApp(textValue(row.app, 260)), category: textValue(row.category, 40) }; });
          const remove = strings(input.remove, 500, 260).map(normalizeApp);
          for (const app of remove) this.db.prepare('DELETE FROM app_categories WHERE app=?').run(app);
          for (const entry of entries) new DailyStore(this.db).classify(entry.app, entry.category); break;
        }
      }
    });
  }
}
