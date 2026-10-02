import type { DatabaseSync } from 'node:sqlite';
import type { TimerSlice } from '../timer/contracts';
import { HistoryStore, historyDate } from './history';
import { record, textValue } from './contracts';
import { normalizeApp } from '../focus/normalize-app';

export interface PlanEntry { taskId: string; title: string; minutes: number }
export interface DailyReview { accomplished: string; obstacles: string; adjustment: string }
export interface DailyPlan { savedAt: number; entries: PlanEntry[] }
export interface Comparison { taskId: string | null; title: string; plannedMs: number; actualMs: number; deltaMs: number; rate: number | null; done: boolean }
export interface DailyData {
  microBreakMs?: number;
  date: string; effectiveMs: number; afkMs: number; unknownMs: number; breakMs: number; pomodoros: number;
  timeline: Array<{ start: number; end: number | null; kind: string; durationMs: number; effectiveMs: number; afkMs: number; unknownMs: number; offset: number; title: string }>;
  activities: Array<{ start: number; end: number; state: string; app: string | null }>;
  apps: Array<{ app: string; durationMs: number; category: string }>;
  categoryTotals?: Array<{ category: string; durationMs: number }>;
  review: DailyReview; plan: DailyPlan | null; comparison: Comparison[];
}
export class DailyStore {
  constructor(private readonly db: DatabaseSync) {}
  savePlan(date: unknown, value: unknown): void {
    const day = historyDate(date);
    const oldPlan = this.db.prepare('SELECT data FROM daily_plans WHERE date=?').get(day);
    const previousIds = new Set(oldPlan ? (JSON.parse(String(oldPlan.data)) as DailyPlan).entries.map(e => e.taskId) : []);
    if (!Array.isArray(value) || value.length > 500) throw new Error('计划最多 500 项');
    const ids = new Set<string>();
    const entries = value.map(item => {
      const input = record(item); const taskId = textValue(input.taskId, 80);
      if (ids.has(taskId)) throw new Error('计划任务不能重复'); ids.add(taskId);
      if (!Number.isInteger(input.minutes) || typeof input.minutes !== 'number' || input.minutes < 0 || input.minutes > 1440) throw new Error('分配时间须为 0—1440 分钟整数');
      const task = this.db.prepare('SELECT t.title,COALESCE(d.archived,0) AS archived FROM tasks t LEFT JOIN task_details d ON d.taskId=t.id WHERE t.id=?').get(taskId);
      if (!task || task.archived === 1 && !previousIds.has(taskId)) throw new Error('计划任务不存在');
      return { taskId, title: String(task.title), minutes: input.minutes };
    });
    if (entries.reduce((total, entry) => total + entry.minutes, 0) > 1440) throw new Error('每日计划不能超过 1440 分钟');
    const checked = this.db.prepare('SELECT taskId FROM daily_checkins WHERE date=?').all(day);
    if (checked.some(row => !ids.has(String(row.taskId)))) throw new Error('请先撤销要移除安排的每日打卡');
    this.db.prepare('INSERT INTO daily_plans VALUES(?,?) ON CONFLICT(date) DO UPDATE SET data=excluded.data').run(day, JSON.stringify({ savedAt: Date.now(), entries }));
  }
  review(date: unknown, value: unknown): void {
    const input = record(value); const result: DailyReview = { accomplished: '', obstacles: '', adjustment: '' };
    for (const key of ['accomplished', 'obstacles', 'adjustment'] as const) {
      if (typeof input[key] !== 'string' || input[key].length > 6000) throw new Error('每项复盘最多 6000 字');
      result[key] = input[key];
    }
    new HistoryStore(this.db).review(date, JSON.stringify(result));
  }
  classify(app: unknown, category: unknown): void {
    this.db.prepare('INSERT INTO app_categories VALUES(?,?) ON CONFLICT(app) DO UPDATE SET category=excluded.category')
      .run(normalizeApp(textValue(app, 260)), textValue(category, 40));
  }
  read(value: unknown): DailyData {
    const date = historyDate(value); const raw = new HistoryStore(this.db).read(date);
    const stored = this.db.prepare('SELECT data FROM daily_plans WHERE date=?').get(date);
    const plan: DailyPlan | null = stored ? JSON.parse(String(stored.data)) as DailyPlan : null;
    let review: DailyReview = { accomplished: '', obstacles: '', adjustment: '' };
    if (raw.review !== null) {
      try {
        const parsed = record(JSON.parse(String(raw.review)));
        if (['accomplished', 'obstacles', 'adjustment'].every(k => typeof parsed[k] === 'string')) review = parsed as unknown as DailyReview;
        else review.accomplished = String(raw.review);
      } catch { review.accomplished = String(raw.review); }
    }
    const tasks = this.db.prepare('SELECT id,title,done FROM tasks').all();
    const comparisons = new Map<string | null, Comparison>();
    const make = (id: string | null, title?: string): Comparison => ({ taskId: id, title: title ?? (id === null ? '自由专注' : String(tasks.find(t => t.id === id)?.title ?? '历史任务')), plannedMs: 0, actualMs: 0, deltaMs: 0, rate: null, done: tasks.find(t => t.id === id)?.done === 1 });
    const checked = new Set(this.db.prepare('SELECT taskId FROM daily_checkins WHERE date=?').all(date).map(row => String(row.taskId)));
    for (const entry of plan?.entries ?? []) comparisons.set(entry.taskId, { ...make(entry.taskId, entry.title), done: checked.has(entry.taskId), plannedMs: entry.minutes * 60000 });
    const result: DailyData = { date, microBreakMs: 0, effectiveMs: 0, afkMs: 0, unknownMs: 0, breakMs: 0, pomodoros: 0, timeline: [], activities: [], apps: [], review, plan, comparison: [] };
    const completions = new Set<string>();
    let previousSlice: TimerSlice | undefined;
    for (const row of raw.slices) {
      const slice = JSON.parse(String(row.data)) as TimerSlice;
      const actual = Number(row.effectiveMs);
      result.effectiveMs += actual; result.afkMs += Number(row.afkMs); result.unknownMs += Number(row.unknownMs);
      if (slice.kind === 'break') result.breakMs += slice.durationMs;
      if (slice.microBreak) result.microBreakMs = (result.microBreakMs ?? 0) + slice.durationMs;
      // Only the final midnight piece retains phase-end, independently of later deletion.
      if (slice.phase === 'work' && (slice.kind === 'work' || slice.microBreak) && slice.reason === 'phase-end' && raw.sessions.some(s => s.id === slice.sessionId && s.mode === 'pomodoro')) {
        completions.add(`${slice.sessionId}:${slice.id}`);
      }
      const comparison = comparisons.get(slice.taskId) ?? make(slice.taskId);
      if (actual > 0) { comparison.actualMs += actual; comparisons.set(slice.taskId, comparison); }
      const entry = { start: slice.startedAt, end: slice.endedAt, offset: slice.utcOffsetMinutes, kind: slice.microBreak ? 'micro-break' : slice.kind, durationMs: slice.durationMs, effectiveMs: actual, afkMs: Number(row.afkMs), unknownMs: Number(row.unknownMs), title: comparison.title };
      const previous = result.timeline.at(-1);
      // Aggregate only for display; preserve stored slices and explicit lifecycle boundaries.
      // Sub-millisecond tolerance accommodates floating-point wall-clock conversion.
      if (previous && previousSlice && previousSlice.reason === 'tick' &&
        previousSlice.sessionId === slice.sessionId && previousSlice.taskId === slice.taskId &&
        previousSlice.phase === slice.phase && previous.kind === entry.kind && previous.offset === entry.offset &&
        previous.end !== null && entry.end !== null && Math.abs(previous.end - entry.start) < 0.01 &&
        Math.abs(previousSlice.monotonicEndMs - slice.monotonicStartMs) < 0.001) {
        previous.end = entry.end;
        previous.durationMs += entry.durationMs; previous.effectiveMs += entry.effectiveMs;
        previous.afkMs += entry.afkMs; previous.unknownMs += entry.unknownMs;
      } else result.timeline.push(entry);
      previousSlice = slice;
    }
    result.pomodoros = completions.size;
    const apps = new Map<string, number>();
    const ambient = this.db.prepare('SELECT startedAt,endedAt,state,app FROM ambient_activity WHERE date=? ORDER BY startedAt').all(date);
    const convert = (a: typeof raw.activities[number]) => ({ start: Number(a.startedAt), end: Number(a.endedAt), state: String(a.state), app: a.app === null ? null : String(a.app) });
    const independent = ambient.map(convert);
    const combined = [...independent];
    // Independent collection owns overlapping wall time; retain older session-only history in the gaps.
    let cursor = 0;
    for (const row of raw.activities) {
      const a = convert(row); let start = a.start;
      while (cursor < independent.length && independent[cursor]!.end <= start) cursor++;
      for (let i = cursor; i < independent.length && independent[i]!.start < a.end; i++) {
        const other = independent[i]!;
        if (other.start > start) combined.push({ ...a, start, end: Math.min(a.end, other.start) });
        start = Math.max(start, other.end);
      }
      if (start < a.end) combined.push({ ...a, start });
    }
    for (const a of combined.sort((a, b) => a.start - b.start)) {
      const previous = result.activities.at(-1);
      const start = Math.max(a.start, previous?.end ?? -Infinity);
      if (a.end <= start) continue;
      if (previous && previous.end === start && previous.state === a.state && previous.app === a.app) previous.end = a.end;
      else result.activities.push({ ...a, start });
      if (a.state === 'active' && a.app) apps.set(a.app, (apps.get(a.app) ?? 0) + a.end - start);
    }
    result.apps = [...apps].map(([app, durationMs]) => ({ app, durationMs, category: String(this.db.prepare('SELECT category FROM app_categories WHERE app=?').get(normalizeApp(app))?.category ?? '未分类') }));
    const totals = new Map<string, number>();
    for (const app of result.apps) totals.set(app.category, (totals.get(app.category) ?? 0) + app.durationMs);
    result.categoryTotals = [...totals].map(([category, durationMs]) => ({ category, durationMs })).sort((a, b) => b.durationMs - a.durationMs);
    result.comparison = [...comparisons.values()].map(c => ({ ...c, deltaMs: c.actualMs - c.plannedMs, rate: c.plannedMs > 0 ? c.actualMs / c.plannedMs : null }));
    return result;
  }
}
