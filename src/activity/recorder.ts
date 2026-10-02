import type { Clock } from '../timer/contracts';
import type { ActivityInterval, ActivityObservation, ActivitySample, ActivitySampler, ActivityState } from './contracts';
import { IdlePolicy } from './idle-policy';

const UNKNOWN: ActivitySample = { status: 'unknown', app: null, idleMs: null };

/** Serial, session-local observation buffer. It never writes application history. */
export class ActivityRecorder {
  private ranges: ActivityInterval[] = [];
  private previous: ActivityObservation | null = null;
  private generation = 0;
  private busy = false;
  private epochStart = 0;
  private mergeFloor = 0;
  constructor(private readonly sampler: ActivitySampler, private readonly clock: Clock, private policy = new IdlePolicy()) {}
  intervals(): ActivityInterval[] { return this.ranges.map(range => ({ ...range })); }
  invalidateObservation(): void {
    this.generation++;
    if (this.previous) this.previous = { ...this.previous, state: 'unknown', app: null, sample: UNKNOWN };
    this.mergeFloor = this.ranges.length;
  }
  discardBefore(at: number): void {
    const removed = this.ranges.filter(range => range.endMs <= at).length;
    this.ranges = this.ranges.filter(range => range.endMs > at).map(range => ({ ...range, startMs: Math.max(at, range.startMs) }));
    this.mergeFloor = Math.max(0, this.mergeFloor - removed); this.epochStart = Math.max(at, this.epochStart);
  }
  interrupt(): void { this.generation++; this.previous = null; this.mergeFloor = this.ranges.length; }
  reset(policy = new IdlePolicy()): void { this.interrupt(); this.ranges = []; this.mergeFloor = 0; this.policy = policy; }

  async poll(): Promise<ActivityObservation | null> {
    if (this.busy) return null;
    this.busy = true;
    const generation = this.generation;
    try {
      const requestedAt = this.clock.read();
      let sample: ActivitySample;
      try { sample = await this.sampler.sample(); } catch { sample = UNKNOWN; }
      if (generation !== this.generation) return null;
      const at = this.clock.read();
      if (at.monotonicMs - requestedAt.monotonicMs > 5000 || at.monotonicMs < requestedAt.monotonicMs) sample = UNKNOWN;
      const state = this.policy.classify(sample);
      const current: ActivityObservation = { at, sample, state, app: state === 'active' ? sample.app : null };
      const previous = this.previous;
      if (!previous) this.epochStart = at.monotonicMs;
      else {
        const start = previous.at.monotonicMs; const end = at.monotonicMs;
        if (end < start) { this.interrupt(); return null; }
        const gap = end - start > 90000 || Math.abs(at.wallMs - previous.at.wallMs - (end - start)) > 2000;
        if (gap || state === 'unknown' || previous.state === 'unknown') this.append(start, end, 'unknown', null);
        else if (previous.state === 'afk' && state === 'active' && sample.status === 'ok') {
          const returnedAt = Math.max(start, end - sample.idleMs);
          this.append(start, returnedAt, 'afk', null); this.append(returnedAt, end, 'active', sample.app);
        } else this.append(start, end, previous.state, previous.app);
        if (state === 'afk' && sample.status === 'ok') this.markIdle(Math.max(this.epochStart, end - sample.idleMs), end);
        if (gap) { this.epochStart = end; this.mergeFloor = this.ranges.length; }
      }
      this.previous = current;
      return current;
    } finally { this.busy = false; }
  }

  private append(startMs: number, endMs: number, state: ActivityState, app: string | null): void {
    if (endMs <= startMs) return;
    const last = this.ranges.at(-1);
    if (this.ranges.length > this.mergeFloor && last && last.endMs === startMs && last.state === state && last.app === app) last.endMs = endMs;
    else this.ranges.push({ startMs, endMs, state, app });
  }

  private markIdle(start: number, end: number): void {
    const ranges = this.ranges; this.ranges = ranges.slice(0, this.mergeFloor);
    for (const range of ranges.slice(this.mergeFloor)) {
      if (range.state !== 'active' || range.endMs <= start || range.startMs >= end) this.append(range.startMs, range.endMs, range.state, range.app);
      else {
        this.append(range.startMs, Math.max(range.startMs, start), 'active', range.app);
        this.append(Math.max(range.startMs, start), Math.min(range.endMs, end), 'afk', null);
        this.append(Math.min(range.endMs, end), range.endMs, 'active', range.app);
      }
    }
  }
}
