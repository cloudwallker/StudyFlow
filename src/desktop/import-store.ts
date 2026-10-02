import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ImportChoices, ImportDocument, ImportPlanChange, ImportPreview } from '../import/json-plan';
import type { DailyPlan } from './daily';
import { DailyStore } from './daily';
import { transaction } from './migration';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
interface ImportedTaskRow {
  taskKey: string; taskId: string; projectId: string | null; project: string; title: string;
  estimateMinutes: number; archived: number;
}

export class ImportStore {
  constructor(private readonly db: DatabaseSync) {}
  preview(document: ImportDocument, choices: ImportChoices): { preview: ImportPreview; revision: string } {
    const hash = digest(document);
    const duplicate = !!this.db.prepare('SELECT digest FROM import_batches WHERE digest=?').get(hash);
    const errors: string[] = [];
    const projects = [...new Set(document.tasks.map(t => t.project).filter(Boolean))].map(name => {
      const candidates = this.db.prepare('SELECT id,name FROM projects WHERE name=? ORDER BY id').all(name).map(row => ({ id: String(row.id), name: String(row.name) }));
      const selected = Object.hasOwn(choices.projectIds, name) ? choices.projectIds[name] : undefined;
      const selectedId = selected ?? (candidates.length === 1 ? candidates[0]!.id : null);
      if (selected && !candidates.some(p => p.id === selected)) errors.push(`项目「${name}」的选择已失效，请重新选择`);
      else if (candidates.length > 1 && !selectedId) errors.push(`项目「${name}」有多个同名项目，请选择要复用的项目`);
      return { name, candidates, selectedId };
    });
    const documentKeys = new Set(document.tasks.map(task => task.taskKey));
    const importedKeys = this.db.prepare(`SELECT i.taskKey,i.taskId,t.projectId,COALESCE(p.name,'') AS project,
      t.title,t.estimateMinutes,COALESCE(d.archived,0) AS archived
      FROM imported_tasks i JOIN tasks t ON t.id=i.taskId LEFT JOIN projects p ON p.id=t.projectId
      LEFT JOIN task_details d ON d.taskId=t.id ORDER BY i.taskKey`).all().filter(row => documentKeys.has(String(row.taskKey))).map(row => ({
        taskKey: String(row.taskKey), taskId: String(row.taskId),
        projectId: row.projectId === null ? null : String(row.projectId), project: String(row.project),
        title: String(row.title), estimateMinutes: Number(row.estimateMinutes), archived: Number(row.archived),
      } satisfies ImportedTaskRow));
    const importedByKey = new Map(importedKeys.map(row => [row.taskKey, row]));
    const selectedUpdates = new Set(choices.updateTaskKeys);
    const taskUpdates: ImportPreview['taskUpdates'] = [];
    if (!duplicate) document.tasks.forEach((task, index) => {
      const previous = importedByKey.get(task.taskKey);
      if (!previous) {
        if (selectedUpdates.has(task.taskKey)) errors.push(`tasks[${index}].taskKey: 只有已导入且未归档的任务可以更新`);
        return;
      }
      if (previous.archived === 1) {
        errors.push(`tasks[${index}].taskKey: 对应任务已归档，不能通过导入更新或重新创建`);
        return;
      }
      const selected = selectedUpdates.has(task.taskKey);
      taskUpdates.push({ taskKey: task.taskKey, taskId: previous.taskId, selected,
        before: { project: previous.project, title: previous.title, estimateMinutes: previous.estimateMinutes },
        after: { project: task.project, title: task.title, estimateMinutes: task.estimateMinutes } });
      if (!selected) errors.push(`tasks[${index}].taskKey: 已由其他文件导入，请明确选择更新该任务或使用新的唯一键`);
    });
    const documentTasks = new Map(document.tasks.map(task => [task.taskKey, task]));
    const updatedTitles = new Map(taskUpdates.filter(update => update.selected).map(update => [update.taskId, update.after.title]));
    const storedDays: Array<{ date: string; data: string | null; checkins: Array<{ taskId: string; checkedAt: number | null }> }> = [];
    const days = [...new Set(document.plans.map(p => p.date))].sort().map(date => {
      const raw = this.db.prepare('SELECT data FROM daily_plans WHERE date=?').get(date);
      const checkins = this.db.prepare('SELECT taskId,checkedAt FROM daily_checkins WHERE date=? ORDER BY taskId').all(date)
        .map(row => ({ taskId: String(row.taskId), checkedAt: row.checkedAt === null ? null : Number(row.checkedAt) }));
      storedDays.push({ date, data: raw ? String(raw.data) : null, checkins });
      const existing = raw ? (JSON.parse(String(raw.data)) as DailyPlan).entries : [];
      const incoming = document.plans.filter(p => p.date === date);
      const replace = choices.replaceDates.includes(date);
      const incomingIds = new Map(incoming.map(plan => [importedByKey.get(plan.taskKey)?.taskId ?? `new:${plan.taskKey}`, plan.minutes]));
      const incomingById = new Map(incoming.map(plan => [importedByKey.get(plan.taskKey)?.taskId ?? `new:${plan.taskKey}`, plan]));
      const existingIds = new Set(existing.map(entry => entry.taskId));
      const changes: ImportPlanChange[] = existing.map(entry => {
        const plan = incomingById.get(entry.taskId);
        const before = { title: entry.title, minutes: entry.minutes };
        const after = plan ? { title: documentTasks.get(plan.taskKey)!.title, minutes: plan.minutes }
          : replace ? null : { title: updatedTitles.get(entry.taskId) ?? String(this.db.prepare('SELECT title FROM tasks WHERE id=?').get(entry.taskId)?.title ?? entry.title), minutes: entry.minutes };
        return { taskId: entry.taskId, ...(plan ? { taskKey: plan.taskKey } : {}), before, after };
      });
      for (const [id, plan] of incomingById) if (!existingIds.has(id)) changes.push({
        ...(importedByKey.has(plan.taskKey) ? { taskId: id } : {}), taskKey: plan.taskKey,
        before: null, after: { title: documentTasks.get(plan.taskKey)!.title, minutes: plan.minutes },
      });
      const kept = replace ? [] : existing.filter(entry => !incomingIds.has(entry.taskId));
      const totalMinutes = kept.reduce((sum, p) => sum + p.minutes, 0) + [...incomingIds.values()].reduce((sum, minutes) => sum + minutes, 0);
      if (!duplicate && replace && checkins.some(checkin => !incomingIds.has(checkin.taskId))) errors.push(`${date}: 替换会移除已打卡任务，请先撤销该日打卡或保留该任务`);
      if (!duplicate && (kept.length + incomingIds.size > 500 || totalMinutes > 1440)) errors.push(`${date}: 合并后超过 500 项或 1440 分钟，请调整文件或明确选择替换当日计划`);
      return { date, existingCount: existing.length, incomingCount: incoming.length, totalMinutes, replace, changes };
    });
    // Only data that affects the reviewed write belongs in the revision. Focus time and
    // untouched tasks remain live; the UPDATE below deliberately preserves their fields.
    return { preview: { token: '', duplicate, projects, tasks: document.tasks, taskUpdates, plans: document.plans, days, errors: duplicate ? [] : errors }, revision: digest([projects, importedKeys, storedDays, days, duplicate]) };
  }
  commit(document: ImportDocument, choices: ImportChoices, revision: string): boolean {
    return transaction(this.db, () => {
      const current = this.preview(document, choices);
      if (current.revision !== revision) throw new Error('预览后数据已变化，请重新预览后确认');
      if (current.preview.duplicate) return false;
      if (current.preview.errors.length) throw new Error('请解决导入预览中的冲突');
      const hash = digest(document);
      this.db.prepare('INSERT INTO import_batches VALUES(?,?)').run(hash, Date.now());
      const projects = new Map<string, string>();
      for (const project of current.preview.projects) {
        const id = project.selectedId ?? randomUUID();
        if (!project.selectedId) this.db.prepare('INSERT INTO projects VALUES(?,?)').run(id, project.name);
        projects.set(project.name, id);
      }
      const tasks = new Map<string, string>();
      for (const task of document.tasks) {
        const update = current.preview.taskUpdates.find(item => item.taskKey === task.taskKey);
        if (update?.selected) {
          tasks.set(task.taskKey, update.taskId);
          this.db.prepare('UPDATE tasks SET projectId=?,title=?,estimateMinutes=? WHERE id=?')
            .run(projects.get(task.project) ?? null, task.title, task.estimateMinutes, update.taskId);
        } else {
          const id = randomUUID(); tasks.set(task.taskKey, id);
          this.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?)').run(id, projects.get(task.project) ?? null, task.title, 0, task.estimateMinutes, 0);
          this.db.prepare('INSERT INTO task_details(taskId,position) SELECT id,-rowid FROM tasks WHERE id=?').run(id);
          this.db.prepare('INSERT INTO imported_tasks VALUES(?,?,?)').run(task.taskKey, id, hash);
        }
      }
      for (const day of current.preview.days) {
        const raw = this.db.prepare('SELECT data FROM daily_plans WHERE date=?').get(day.date);
        const previous = !day.replace && raw ? (JSON.parse(String(raw.data)) as DailyPlan).entries : [];
        const incoming = document.plans.filter(p => p.date === day.date).map(p => ({ taskId: tasks.get(p.taskKey)!, minutes: p.minutes }));
        const incomingByTask = new Map(incoming.map(entry => [entry.taskId, entry]));
        const merged = previous.map(entry => incomingByTask.get(entry.taskId) ?? entry);
        for (const entry of incomingByTask.values()) if (!previous.some(old => old.taskId === entry.taskId)) merged.push(entry);
        new DailyStore(this.db).savePlan(day.date, merged);
      }
      return true;
    });
  }
}
