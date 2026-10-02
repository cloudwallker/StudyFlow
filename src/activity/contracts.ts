import type { ClockReading } from '../timer/contracts';
export type ActivitySample = { status: 'ok'; app: string; idleMs: number } | { status: 'unknown'; app: null; idleMs: null };
export interface ActivitySampler { sample(): Promise<ActivitySample> }
export type ActivityState = 'active' | 'afk' | 'unknown';
export interface ActivityObservation { at: ClockReading; sample: ActivitySample; state: ActivityState; app: string | null }
export interface ActivityInterval { startMs: number; endMs: number; state: ActivityState; app: string | null }
export interface LearningSummary { effectiveMs: number; afkMs: number; unknownMs: number }
