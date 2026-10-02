/** One atomic reading. Offset is local time minus UTC, in minutes. */
export interface ClockReading { wallMs: number; monotonicMs: number; utcOffsetMinutes: number }
export interface Clock { read(): ClockReading }
export type TimerMode = 'stopwatch' | 'countdown' | 'pomodoro';
export type TimerPhase = 'work' | 'short-break' | 'long-break';
export type TimerStatus = 'idle' | 'running' | 'paused' | 'awaiting-next' | 'stopped';
export interface PomodoroConfig {
  workMinutes: number; shortBreakMinutes: number; longBreakMinutes: number; roundsBeforeLongBreak: number;
}
export type TimerInput = { taskId: string | null } & (
  { mode: 'stopwatch' } |
  { mode: 'countdown'; durationMinutes: number } |
  { mode: 'pomodoro'; policy?: Partial<PomodoroConfig>; longFocus?: Partial<import('./long-focus').LongFocusConfig> }
);

export interface TimerState {
  longFocus?: boolean; microResting?: boolean; microRemainingMs?: number | null; microBreakMs?: number;
  sessionId: string | null; taskId: string | null; mode: TimerMode | null; status: TimerStatus;
  phase: TimerPhase | null; nextPhase: TimerPhase | null;
  startedAt: number | null; endedAt: number | null;
  /** Monotonic elapsed time through the last explicit update, including pauses/waiting. */
  elapsedMs: number;
  /** Unclassified work time; MUST NOT be credited as effective learning before AFK reconciliation. */
  workMs: number;
  breakMs: number; pausedMs: number; waitingMs: number; unknownMs: number;
  phaseElapsedMs: number; remainingMs: number | null; completedPomodoros: number;
}
export type SliceKind = 'work' | 'break' | 'pause' | 'waiting' | 'unknown';
export type SliceReason = 'tick' | 'pause' | 'resume' | 'stop' | 'interrupt' | 'phase-end' | 'gap' | 'clock-change';
export interface TimerSlice {
  microBreak?: boolean;
  id: string; sessionId: string; taskId: string | null; phase: TimerPhase;
  kind: SliceKind; reason: SliceReason;
  /** Left-closed/right-open monotonic interval. These coordinates are session-local, not restartable. */
  monotonicStartMs: number; monotonicEndMs: number; durationMs: number;
  startedAt: number;
  /** Null when a wall-clock discontinuity prevents a trustworthy UTC interval. */
  endedAt: number | null;
  utcOffsetMinutes: number;
}
export interface TimerEvent {
  id: string; type: 'phase-completed' | 'micro-start' | 'micro-end'; sessionId: string; phase: TimerPhase;
  at: number; completedPomodoros: number;
}
export interface TimerSnapshot { state: TimerState; slices: TimerSlice[] }
