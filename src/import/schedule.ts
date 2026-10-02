import { parseImport, type ImportDocument, type ImportPlan } from './json-plan';

/** Only recognize a day marker at the beginning, never a quantity inside prose. */
export function dayNumber(title: string): number | null {
  const normalized = title.normalize('NFKC').trim();
  const marked = /^(?:第\s*([\d零〇一二两三四五六七八九十百\s]+)\s*天|day\s*(\d+)(?=$|[^\da-z.]))/i.exec(normalized);
  const bare = /^(\d{1,3})(?:$|\s*[｜|:：、\-]|\.(?!\d)|\s+\D)/.exec(normalized);
  const value = (marked?.[1] ?? marked?.[2] ?? bare?.[1])?.replace(/\s/g, '');
  if (!value) return null;
  let number = Number(value);
  if (!Number.isFinite(number)) {
    const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    let sum = 0; let digit = 0;
    for (const char of value) {
      if (char === '十' || char === '百') { sum += (digit || 1) * (char === '十' ? 10 : 100); digit = 0; }
      else digit = digits[char] ?? 0;
    }
    number = sum + digit;
  }
  return Number.isInteger(number) && number >= 1 && number <= 366 ? number : null;
}

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= '0001-01-01' &&
    Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
}
function shift(date: string, days: number): string {
  const result = new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
  if (!validDate(result)) throw new Error('推导日期超出支持范围，请调整第 1 天日期');
  return result;
}

/** Explicit plans always win. Inference is shown in a preview before any write. */
export function resolveSchedule(document: ImportDocument, value?: unknown): {
  document: ImportDocument; errors: string[]; inferred: number;
} {
  if (value !== undefined && value !== '' && (typeof value !== 'string' || !validDate(value))) throw new Error('第 1 天须为有效 YYYY-MM-DD 日期');
  const startDate = typeof value === 'string' && value ? value : null;
  const tasks = new Map(document.tasks.map(t => [t.taskKey, t]));
  const anchors = new Map<string, Set<string>>();
  const scheduled = new Set(document.plans.map(p => p.taskKey));
  const plans: ImportPlan[] = [...document.plans];
  // A date prefix in a task title is also explicit; plans.date still takes priority.
  for (const task of document.tasks) {
    if (scheduled.has(task.taskKey)) continue;
    const date = /^(\d{4}-\d{2}-\d{2})(?=$|[\s｜|:：、])/u.exec(task.title)?.[1];
    if (date && validDate(date)) { plans.push({ date, taskKey: task.taskKey, minutes: task.estimateMinutes }); scheduled.add(task.taskKey); }
  }
  for (const plan of plans) {
    const task = tasks.get(plan.taskKey)!; const day = dayNumber(task.title);
    if (day === null) continue;
    const dates = anchors.get(task.project) ?? new Set<string>();
    dates.add(shift(plan.date, 1 - day)); anchors.set(task.project, dates);
  }
  const errors = new Set<string>();
  for (const task of document.tasks) {
    if (scheduled.has(task.taskKey)) continue;
    const day = dayNumber(task.title); if (day === null) continue;
    const candidates = anchors.get(task.project);
    if (candidates && candidates.size > 1) { errors.add(`项目「${task.project || '未分配项目'}」的天数与日期不一致，请在 JSON 的 plans 中明确安排日期`); continue; }
    const anchor = candidates?.values().next().value ?? startDate;
    if (!anchor) { errors.add('识别到按天学习任务，请选择第 1 天日期并重新预览，或在合规 JSON 的 plans 中填写明确日期'); continue; }
    plans.push({ date: shift(anchor, day - 1), taskKey: task.taskKey, minutes: task.estimateMinutes });
  }
  const resolved = parseImport(JSON.stringify({ ...document, plans }));
  return { document: resolved, errors: [...errors], inferred: plans.length - document.plans.length };
}
