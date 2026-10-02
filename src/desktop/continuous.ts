import type { DatabaseSync } from 'node:sqlite';
import type { ActivityInterval, ActivitySample, ActivitySampler } from '../activity/contracts';
import type { Clock, ClockReading } from '../timer/contracts';
import { ActivityRecorder } from '../activity/recorder';
import { IdlePolicy } from '../activity/idle-policy';
import { transaction } from './migration';

export interface ActivityCheckpoint {
  runId: string; from: number; intervals: ActivityInterval[]; anchors: ClockReading[];
}

/** Independent history, with a bounded mutable tail for retrospective AFK classification. */
export class ContinuousActivity {
  private recorder: ActivityRecorder;
  private enabled = false;
  private idleMinutes = 5;
  private runId = '';
  private from = 0;
  private anchors: ClockReading[] = [];
  private lastSave = -Infinity;
  private generation = 0;
  private suspended = false;
  failed = false;
  constructor(private readonly sampler: ActivitySampler, private readonly clock: Clock,
    private readonly makeId: () => string, private readonly save?: (cp: ActivityCheckpoint) => void) {
    this.recorder = new ActivityRecorder({ sample: async () => this.suspended ? { status: 'unknown', app: null, idleMs: null } : sampler.sample() }, clock);
  }
  configure(enabled: boolean, idleMinutes: number): void {
    if (enabled === this.enabled && idleMinutes === this.idleMinutes) return;
    if (!this.flush()) throw new Error('全天活动保存失败，请重试后再修改设置');
    this.enabled = enabled; this.idleMinutes = idleMinutes; this.generation++;
    this.recorder.reset(new IdlePolicy(idleMinutes * 60000));
    this.anchors = []; this.from = 0; this.runId = this.makeId(); this.lastSave = -Infinity;
  }
  setSuspended(value: boolean): void {
    if (this.suspended !== value) { this.generation++; this.recorder.invalidateObservation(); }
    this.suspended = value;
  }
  async sample(): Promise<ActivitySample> {
    if (!this.enabled) return this.sampler.sample();
    const generation = this.generation;
    const observation = await this.recorder.poll();
    if (!observation || generation !== this.generation) return { status: 'unknown', app: null, idleMs: null };
    const at = observation.at; const last = this.anchors.at(-1);
    if (!last || Math.abs(at.wallMs - last.wallMs - (at.monotonicMs - last.monotonicMs)) > 2000 || at.utcOffsetMinutes !== last.utcOffsetMinutes) this.anchors.push({ ...at });
    if (at.monotonicMs - this.lastSave >= 30000) this.flush();
    return observation.sample;
  }
  flush(): boolean {
    if (!this.enabled || !this.save) return true;
    this.lastSave = this.clock.read().monotonicMs;
    const intervals = this.recorder.intervals();
    try {
      this.save({ runId: this.runId, from: this.from, intervals, anchors: this.anchors });
      const limit = this.lastSave - this.idleMinutes * 60000 - 90000;
      const end = intervals.filter(i => i.endMs <= limit).at(-1)?.endMs;
      if (end !== undefined) {
        this.from = end; this.recorder.discardBefore(end);
        const preceding = this.anchors.filter(a => a.monotonicMs <= end).at(-1);
        this.anchors = [...(preceding ? [preceding] : []), ...this.anchors.filter(a => a.monotonicMs > end)];
      }
      this.failed = false; return true;
    } catch { this.failed = true; return false; }
  }
}

export function saveActivityCheckpoint(db: DatabaseSync, cp: ActivityCheckpoint): void {
  if (!cp.runId || !Number.isFinite(cp.from) || cp.from < 0) throw new Error('无效全天活动检查点');
  let end = cp.from;
  for (const range of cp.intervals) {
    if (!Number.isFinite(range.startMs) || !Number.isFinite(range.endMs) || range.startMs < end || range.endMs <= range.startMs ||
      !['active', 'afk', 'unknown'].includes(range.state) || (range.app !== null && (typeof range.app !== 'string' || range.app.length > 260 || /[\u0000-\u001f]/.test(range.app)))) throw new Error('无效全天活动区间');
    end = range.endMs;
  }
  for (const anchor of cp.anchors) if (![anchor.wallMs, anchor.monotonicMs, anchor.utcOffsetMinutes].every(Number.isFinite) || !Number.isInteger(anchor.utcOffsetMinutes) || Math.abs(anchor.utcOffsetMinutes) > 840) throw new Error('无效全天活动时钟');
  transaction(db, () => {
    db.prepare('DELETE FROM ambient_activity WHERE runId=? AND startMono>=?').run(cp.runId, cp.from);
    const insert = db.prepare('INSERT INTO ambient_activity VALUES(?,?,?,?,?,?,?,?)');
    for (const range of cp.intervals) {
      let start = range.startMs;
      while (start < range.endMs) {
        const anchor = cp.anchors.filter(a => a.monotonicMs <= start).at(-1);
        if (!anchor) throw new Error('全天活动缺少时钟锚点');
        const next = cp.anchors.find(a => a.monotonicMs > start);
        const wallStart = anchor.wallMs + start - anchor.monotonicMs;
        const date = new Date(wallStart + anchor.utcOffsetMinutes * 60000).toISOString().slice(0, 10);
        const midnight = Date.parse(date) + 86400000 - anchor.utcOffsetMinutes * 60000;
        const stop = Math.min(range.endMs, next?.monotonicMs ?? Infinity, start + midnight - wallStart);
        insert.run(cp.runId, start, stop, date, wallStart, wallStart + stop - start, range.state, range.state === 'active' ? range.app : null);
        start = stop;
      }
    }
  });
}
