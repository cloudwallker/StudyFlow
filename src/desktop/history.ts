import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type { TimerSnapshot, TimerSlice } from '../timer/contracts';
import type { ActivityInterval } from '../activity/contracts';
import { learningSummary } from '../activity/learning-summary';
import { transaction } from './migration';

export interface HistoryCheckpoint { revision: number; snapshot: TimerSnapshot; intervals: ActivityInterval[]; retainedFrom?: number; archivedEffectiveMs?: number }
export interface CurrentFocusClock { sessionId: string | null; retainedFrom: number; slices: TimerSlice[] }
export function historyDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error('无效历史日期');
  return value;
}
function localDate(at: number, offset: number): string { return new Date(at + offset * 60000).toISOString().slice(0, 10); }
function split(slice: TimerSlice): TimerSlice[] {
  if (slice.endedAt === null) return [{ ...slice }];
  const result: TimerSlice[] = []; let start = slice.startedAt; let mono = slice.monotonicStartMs;
  while (start < slice.endedAt) {
    const date = localDate(start, slice.utcOffsetMinutes);
    const midnight = Date.parse(date) + 86400000 - slice.utcOffsetMinutes * 60000;
    const end = Math.min(slice.endedAt, midnight); const duration = end - start;
    result.push({ ...slice, reason: end < slice.endedAt ? 'tick' : slice.reason, startedAt: start, endedAt: end, monotonicStartMs: mono, monotonicEndMs: mono + duration, durationMs: duration });
    start = end; mono += duration;
  }
  return result;
}
function validate(cp: HistoryCheckpoint): void {
  if (cp.retainedFrom !== undefined && (!Number.isFinite(cp.retainedFrom) || cp.retainedFrom < 0 || !Number.isFinite(cp.archivedEffectiveMs) || cp.archivedEffectiveMs! < 0)) throw new Error('无效历史保留边界');
  const { state, slices } = cp.snapshot;
  if (!Number.isSafeInteger(cp.revision) || cp.revision < 1 || !state.sessionId || !state.mode || state.startedAt === null || !Number.isFinite(state.startedAt)) throw new Error('无效会话检查点');
  const ids = new Set<string>(); let end = -Infinity;
  for (const s of slices) {
    if (s.sessionId !== state.sessionId || s.taskId !== state.taskId || ids.has(s.id) || !s.id ||
      ![s.durationMs, s.monotonicStartMs, s.monotonicEndMs, s.startedAt, s.utcOffsetMinutes].every(Number.isFinite) ||
      s.durationMs <= 0 || s.monotonicStartMs < end || Math.abs(s.monotonicEndMs - s.monotonicStartMs - s.durationMs) > 0.001 ||
      !Number.isInteger(s.utcOffsetMinutes) || Math.abs(s.utcOffsetMinutes) > 840 ||
      (s.endedAt !== null && (!Number.isFinite(s.endedAt) || Math.abs(s.endedAt - s.startedAt - s.durationMs) > 0.01))) throw new Error('无效计时片段');
    ids.add(s.id); end = s.monotonicEndMs;
  }
  end = -Infinity;
  for (const a of cp.intervals) {
    if (![a.startMs, a.endMs].every(Number.isFinite) || a.startMs < end || a.endMs <= a.startMs ||
      !['active', 'afk', 'unknown'].includes(a.state) || (a.app !== null && (typeof a.app !== 'string' || a.app.length > 260 || /[\u0000-\u001f]/.test(a.app)))) throw new Error('无效活动区间');
    end = a.endMs;
  }
}
export class HistoryStore {
  constructor(private readonly db: DatabaseSync) {}
  recover(): number {
    return Number(this.db.prepare("UPDATE sessions SET status='interrupted' WHERE status NOT IN ('stopped','interrupted')").run().changes);
  }
  focusTime(value: unknown, current?: CurrentFocusClock): number {
    const date = historyDate(value);
    const stored = current?.sessionId === null || current === undefined
      ? this.db.prepare("SELECT COALESCE(SUM(durationMs),0) AS total FROM timer_slices WHERE date=? AND json_extract(data,'$.kind')='work'").get(date)
      : this.db.prepare(`SELECT COALESCE(SUM(durationMs),0) AS total FROM timer_slices
          WHERE date=? AND json_extract(data,'$.kind')='work'
          AND (sessionId<>? OR json_extract(data,'$.monotonicStartMs')<?)`).get(date, current.sessionId, current.retainedFrom);
    let total = Number(stored?.total ?? 0);
    for (const slice of current?.slices ?? []) {
      if (slice.kind !== 'work') continue;
      for (const part of split(slice)) if (localDate(part.startedAt, part.utcOffsetMinutes) === date) total += part.durationMs;
    }
    return total;
  }
  save(cp: HistoryCheckpoint): void {
    validate(cp);
    const { state, slices } = cp.snapshot; const id = state.sessionId!;
    // Store only a digest of the input, never raw application observations in state.
    const digest = createHash('sha256').update(JSON.stringify(cp)).digest('hex');
    transaction(this.db, () => {
      const old = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id);
      if (old && cp.revision === old.revision && digest === old.digest) return;
      if (old && (cp.revision <= Number(old.revision) || old.status === 'stopped' || old.status === 'interrupted' || old.taskId !== state.taskId)) throw new Error('检查点已过期或会话已结束');
      const credited = Math.floor((cp.archivedEffectiveMs ?? 0) + learningSummary(slices, cp.intervals).effectiveMs);
      const delta = credited - Number(old?.creditedMs ?? 0);
      const confirmedAt = slices.at(-1)?.endedAt ?? slices.at(-1)?.startedAt ?? Number(old?.confirmedAt ?? state.startedAt!);
      this.db.prepare(`INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        status=excluded.status,confirmedAt=excluded.confirmedAt,revision=excluded.revision,digest=excluded.digest,creditedMs=excluded.creditedMs,state=excluded.state`)
        .run(id, state.taskId, state.mode!, state.status, state.startedAt!, confirmedAt, cp.revision, digest, credited, JSON.stringify(state));
      if (state.taskId !== null) {
        if (!this.db.prepare('UPDATE tasks SET spentMs=spentMs+? WHERE id=? AND spentMs+? >= 0 AND spentMs+? <= 9007199254740991').run(delta, state.taskId, delta, delta).changes) throw new Error('任务累计保存失败');
      }
      if (cp.retainedFrom === undefined) {
        this.db.prepare('DELETE FROM timer_slices WHERE sessionId=?').run(id);
        this.db.prepare('DELETE FROM activity_intervals WHERE sessionId=?').run(id);
      } else {
        this.db.prepare("DELETE FROM timer_slices WHERE sessionId=? AND json_extract(data,'$.monotonicStartMs')>=?").run(id, cp.retainedFrom);
        this.db.prepare('DELETE FROM activity_intervals WHERE sessionId=? AND monotonicStart>=?').run(id, cp.retainedFrom);
      }
      const recordApps = this.db.prepare('SELECT recordAppActivity FROM settings WHERE id=1').get()?.recordAppActivity === 1;
      const insert = this.db.prepare('INSERT INTO timer_slices VALUES(?,?,?,?,?,?,?,?,?,?)');
      const activity = this.db.prepare('INSERT INTO activity_intervals VALUES(?,?,?,?,?,?,?,?)');
      const activities: { date: string; start: number; end: number; range: number; monoEnd: number;
        offset: number; kind: string; mergeAfter: boolean; state: string; app: string | null }[] = [];
      for (const original of slices) for (const slice of split(original)) {
        const date = localDate(slice.startedAt, slice.utcOffsetMinutes);
        const summary = learningSummary([slice], cp.intervals);
        insert.run(id, slice.id, date, slice.startedAt, slice.endedAt, slice.durationMs, summary.effectiveMs, summary.afkMs, summary.unknownMs, JSON.stringify(slice));
        if (recordApps && slice.endedAt !== null) for (const [index, range] of cp.intervals.entries()) {
          const start = Math.max(range.startMs, slice.monotonicStartMs); const end = Math.min(range.endMs, slice.monotonicEndMs);
          if (end <= start) continue;
          const wallStart = slice.startedAt + start - slice.monotonicStartMs;
          const wallEnd = slice.startedAt + end - slice.monotonicStartMs;
          if (cp.retainedFrom !== undefined) {
            activity.run(`${id}:${slice.id}:${date}:${index}`, id, date, wallStart, wallEnd, range.state, range.state === 'active' ? range.app : null, slice.monotonicStartMs);
            continue;
          }
          const previous = activities.at(-1);
          const mergeAfter = slice.reason === 'tick';
          if (previous && previous.range === index && previous.date === date && previous.end === wallStart &&
            previous.monoEnd === start && previous.offset === slice.utcOffsetMinutes && previous.kind === slice.kind && previous.mergeAfter) {
            previous.end = wallEnd; previous.monoEnd = end; previous.mergeAfter = mergeAfter;
          } else activities.push({ date, start: wallStart, end: wallEnd, range: index, monoEnd: end,
            offset: slice.utcOffsetMinutes, kind: slice.kind, mergeAfter, state: range.state, app: range.state === 'active' ? range.app : null });
        }
      }
      activities.forEach((a, index) => activity.run(`${id}:${index}`, id, a.date, a.start, a.end, a.state, a.app, null));
    });
  }
  read(value: unknown) {
    const date = historyDate(value);
    return {
      slices: this.db.prepare('SELECT * FROM timer_slices WHERE date=? ORDER BY startedAt').all(date),
      activities: this.db.prepare('SELECT * FROM activity_intervals WHERE date=? ORDER BY startedAt').all(date),
      sessions: this.db.prepare('SELECT id,taskId,mode,status,startedAt,confirmedAt,creditedMs FROM sessions WHERE id IN (SELECT sessionId FROM timer_slices WHERE date=?)').all(date),
      review: this.db.prepare('SELECT notes FROM daily_reviews WHERE date=?').get(date)?.notes ?? null,
    };
  }
  review(date: unknown, notes: unknown): void {
    if (typeof notes !== 'string' || notes.length > 20000) throw new Error('无效复盘内容');
    this.db.prepare('INSERT INTO daily_reviews VALUES(?,?) ON CONFLICT(date) DO UPDATE SET notes=excluded.notes').run(historyDate(date), notes);
  }
  delete(date: unknown): void {
    const day = historyDate(date);
    transaction(this.db, () => {
      if (this.db.prepare("SELECT id FROM sessions WHERE status NOT IN ('stopped','interrupted') LIMIT 1").get()) throw new Error('请结束计时后再删除历史');
      this.db.prepare('DELETE FROM timer_slices WHERE date=?').run(day);
      this.db.prepare('DELETE FROM activity_intervals WHERE date=?').run(day);
      this.db.prepare('DELETE FROM ambient_activity WHERE date=?').run(day);
      this.db.prepare('DELETE FROM daily_reviews WHERE date=?').run(day);
      // Keep minimal idempotency receipts; remove session details once no history remains.
      this.db.exec("UPDATE sessions SET taskId=NULL,mode='deleted',status='interrupted',startedAt=0,confirmedAt=0,creditedMs=0,state='{}' WHERE id NOT IN (SELECT sessionId FROM timer_slices)");
    });
  }
}
