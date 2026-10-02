import type { TimerSlice } from '../timer/contracts';
import type { ActivityInterval, LearningSummary } from './contracts';

/** Both tracks are ordered non-overlapping monotonic intervals; overlap is counted once. */
export function learningSummary(slices: readonly TimerSlice[], intervals: readonly ActivityInterval[]): LearningSummary {
  let effectiveMs = 0; let afkMs = 0; let totalWorkMs = 0; let cursor = 0;
  for (const slice of slices) {
    if (slice.kind === 'unknown' && slice.phase === 'work') totalWorkMs += slice.durationMs;
    if (slice.kind !== 'work') continue;
    totalWorkMs += slice.durationMs;
    while (cursor < intervals.length && intervals[cursor]!.endMs <= slice.monotonicStartMs) cursor++;
    for (let i = cursor; i < intervals.length; i++) {
      const interval = intervals[i]!;
      if (interval.startMs >= slice.monotonicEndMs) break;
      const duration = Math.max(0, Math.min(interval.endMs, slice.monotonicEndMs) - Math.max(interval.startMs, slice.monotonicStartMs));
      if (interval.state === 'active') effectiveMs += duration;
      else if (interval.state === 'afk') afkMs += duration;
    }
  }
  return { effectiveMs, afkMs, unknownMs: Math.max(0, totalWorkMs - effectiveMs - afkMs) };
}
