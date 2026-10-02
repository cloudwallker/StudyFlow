export const MAX_IMPORT_BYTES = 1024 * 1024;
export interface ImportTask { taskKey: string; project: string; title: string; estimateMinutes: number }
export interface ImportPlan { date: string; taskKey: string; minutes: number }
export interface ImportDocument { schemaVersion: 1; tasks: ImportTask[]; plans: ImportPlan[] }
export interface ImportChoices { projectIds: Record<string, string>; replaceDates: string[]; updateTaskKeys: string[] }
export interface ImportTaskUpdate {
  taskKey: string; taskId: string; selected: boolean;
  before: { project: string; title: string; estimateMinutes: number };
  after: { project: string; title: string; estimateMinutes: number };
}
export interface ImportPlanChange {
  taskId?: string; taskKey?: string;
  before: { title: string; minutes: number } | null;
  after: { title: string; minutes: number } | null;
}
export interface ImportPreview {
  token: string; duplicate: boolean; tasks: ImportTask[];
  taskUpdates: ImportTaskUpdate[];
  projects: Array<{ name: string; candidates: Array<{ id: string; name: string }>; selectedId: string | null }>;
  days: Array<{ date: string; existingCount: number; incomingCount: number; totalMinutes: number; replace: boolean; changes?: ImportPlanChange[] }>;
  plans: ImportPlan[]; errors: string[];
  inferredPlans?: number;
}

export class ImportValidationError extends Error {}
function fail(path: string, message: string): never { throw new ImportValidationError(`${path}: ${message}`); }
function object(value: unknown, keys: string[], path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, '须为对象');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(k => !keys.includes(k))) fail(path, '含不支持的字段');
  return input;
}
function text(value: unknown, max: number, path: string, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.trim().length > max || /[\u0000-\u001f]/.test(value)) fail(path, `须为${empty ? '可空' : '非空'}文本，最多 ${max} 字符`);
  return value.trim();
}
function integer(value: unknown, max: number, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) fail(path, `须为 1—${max} 的整数`);
  return value;
}
function list(value: unknown, max: number, path: string): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail(path, `须为数组，最多 ${max} 项`);
  return value;
}
export function parseImport(content: unknown): ImportDocument {
  if (typeof content !== 'string') fail('$', '请选择 UTF-8 JSON 文件');
  if (content.length > MAX_IMPORT_BYTES || new TextEncoder().encode(content).length > MAX_IMPORT_BYTES) fail('$', '文件不能超过 1 MiB');
  let value: unknown;
  try { value = JSON.parse(content.replace(/^\uFEFF/, '')); }
  catch { fail('$', 'JSON 语法错误，请检查文件格式'); }
  const root = object(value, ['schemaVersion', 'tasks', 'plans'], '$');
  if (root.schemaVersion !== 1) fail('schemaVersion', '仅支持版本 1');
  const keys = new Set<string>();
  const tasks = list(root.tasks, 1000, 'tasks').map((value, index) => {
    const path = `tasks[${index}]`; const row = object(value, ['taskKey', 'project', 'title', 'estimateMinutes'], path);
    const taskKey = text(row.taskKey, 80, `${path}.taskKey`);
    if (keys.has(taskKey)) fail(`${path}.taskKey`, '任务键重复'); keys.add(taskKey);
    return { taskKey, project: text(row.project, 80, `${path}.project`, true), title: text(row.title, 200, `${path}.title`), estimateMinutes: integer(row.estimateMinutes, 240, `${path}.estimateMinutes`) };
  });
  if (!tasks.length) fail('tasks', '至少需要一个任务');
  const pairs = new Set<string>(); const days = new Map<string, { count: number; minutes: number }>();
  const plans = list(root.plans, 5000, 'plans').map((value, index) => {
    const path = `plans[${index}]`; const row = object(value, ['date', 'taskKey', 'minutes'], path);
    const date = text(row.date, 10, `${path}.date`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < '0001-01-01' || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) fail(`${path}.date`, '须为有效 YYYY-MM-DD 日期');
    const taskKey = text(row.taskKey, 80, `${path}.taskKey`);
    if (!keys.has(taskKey)) fail(`${path}.taskKey`, '未引用本文件中的任务');
    const pair = JSON.stringify([date, taskKey]);
    if (pairs.has(pair)) fail(path, '同日同一任务不能重复'); pairs.add(pair);
    const minutes = integer(row.minutes, 1440, `${path}.minutes`);
    const day = days.get(date) ?? { count: 0, minutes: 0 }; day.count++; day.minutes += minutes; days.set(date, day);
    if (day.count > 500 || day.minutes > 1440) fail(path, '单日最多 500 项、1440 分钟');
    return { date, taskKey, minutes };
  });
  return { schemaVersion: 1, tasks, plans };
}

export function importChoices(value: unknown, document: ImportDocument): ImportChoices {
  if (value === undefined) return { projectIds: {}, replaceDates: [], updateTaskKeys: [] };
  const input = object(value, ['projectIds', 'replaceDates', 'updateTaskKeys'], 'choices');
  const names = [...new Set(document.tasks.map(t => t.project).filter(Boolean))];
  const ids = object(input.projectIds, names, 'choices.projectIds');
  const projectIds = Object.fromEntries(Object.entries(ids).map(([name, id]) => [name, text(id, 80, 'choices.projectIds')]));
  const dates = new Set(document.plans.map(p => p.date));
  const replaceDates = list(input.replaceDates, dates.size, 'choices.replaceDates').map(date => {
    if (typeof date !== 'string' || !dates.has(date)) fail('choices.replaceDates', '日期不在导入文件中');
    return date;
  });
  const taskKeys = new Set(document.tasks.map(task => task.taskKey));
  const updateTaskKeys = list(input.updateTaskKeys ?? [], taskKeys.size, 'choices.updateTaskKeys').map(taskKey => {
    if (typeof taskKey !== 'string' || !taskKeys.has(taskKey)) fail('choices.updateTaskKeys', '任务键不在导入文件中');
    return taskKey;
  });
  return { projectIds, replaceDates: [...new Set(replaceDates)], updateTaskKeys: [...new Set(updateTaskKeys)] };
}
