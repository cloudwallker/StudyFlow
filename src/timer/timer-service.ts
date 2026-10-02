import { longFocusConfig } from './long-focus';
import type { Clock, ClockReading, SliceKind, SliceReason, TimerEvent, TimerMode, TimerPhase, TimerSlice, TimerSnapshot, TimerState } from './contracts';
import { inputRecord, PomodoroPolicy, positiveInteger } from './pomodoro-policy';

const MAX_GAP_MS = 90000;
const CLOCK_DRIFT_MS = 2000;

function emptyState(): TimerState {
  return {
    sessionId: null, taskId: null, mode: null, status: 'idle', phase: null, nextPhase: null,
    startedAt: null, endedAt: null, elapsedMs: 0, workMs: 0, breakMs: 0, pausedMs: 0,
    waitingMs: 0, unknownMs: 0, phaseElapsedMs: 0, remainingMs: null, completedPomodoros: 0,
  };
}

/** Owned once by the application lifecycle. Does not schedule, sample, notify, or write storage. */
export class TimerService {
  private value = emptyState();
  private longFocus = longFocusConfig();
  private last: ClockReading | null = null;
  private policy = new PomodoroPolicy();
  private phaseDurationMs: number | null = null;
  private slices: TimerSlice[] = [];
  private events: TimerEvent[] = [];

  constructor(private readonly clock: Clock, private readonly makeId: () => string, private readonly random: () => number = Math.random) {}

  state(): TimerState { return { ...this.value }; }
  snapshot(): TimerSnapshot { return { state: this.state(), slices: this.slices.map(slice => ({ ...slice })) }; }
  takeEvents(): TimerEvent[] { const events = this.events; this.events = []; return events; }
  discardBefore(at: number): void { this.slices = this.slices.filter(slice => slice.monotonicEndMs > at); }

  start(value: unknown): TimerState {
    if (this.isOpen()) throw new Error('请先结束当前计时');
    const input = inputRecord(value);
    if (input.mode !== 'stopwatch' && input.mode !== 'countdown' && input.mode !== 'pomodoro') throw new Error('无效计时模式');
    const mode: TimerMode = input.mode;
    const taskId = input.taskId;
    if (taskId !== null && (typeof taskId !== 'string' || !taskId.trim() || taskId.length > 80 || /[\u0000-\u001f]/.test(taskId))) throw new Error('无效任务标识');
    const policy = mode === 'pomodoro' ? new PomodoroPolicy(input.policy) : new PomodoroPolicy();
    const longFocus = longFocusConfig(input.longFocus);
    const duration = mode === 'pomodoro' && longFocus.enabled ? longFocus.totalMinutes * 60000 : mode === 'countdown' ? positiveInteger(input.durationMinutes, 240) * 60000 : mode === 'pomodoro' ? policy.durationMs('work') : null;
    const at = this.readClock();
    const sessionId = this.makeId();
    this.longFocus = longFocus;
    this.policy = policy; this.phaseDurationMs = duration; this.last = at; this.slices = [];
    this.value = { ...emptyState(), sessionId, taskId, mode, status: 'running', phase: 'work', startedAt: at.wallMs, remainingMs: duration, longFocus: mode === 'pomodoro' && longFocus.enabled, microBreakMs: 0 };
    this.resetMicro();
    return this.state();
  }

  tick(): TimerState { this.advance('tick'); return this.state(); }

  pause(): TimerState {
    this.advance('pause');
    if (this.value.status === 'running') this.value.status = 'paused';
    return this.state();
  }

  interrupt(): TimerState {
    this.advance('interrupt');
    if (this.value.status === 'running') this.value.status = 'paused';
    return this.state();
  }

  resume(durationMinutes?: unknown): TimerState {
    const duration = durationMinutes === undefined ? undefined : positiveInteger(durationMinutes, 240) * 60000;
    if (duration !== undefined && this.value.status !== 'awaiting-next') throw new Error('仅在阶段结束后可调整下一阶段时长');
    // A resume arriving before a tick must not automatically restart a newly discovered gap.
    const before = this.value.status;
    this.advance('resume');
    if (before === 'paused' && this.value.status === 'paused') this.value.status = 'running';
    else if (before === 'awaiting-next' && this.value.status === 'awaiting-next') {
      const next = this.value.nextPhase;
      if (!next) throw new Error('缺少下一计时阶段');
      this.phaseDurationMs = duration ?? (this.value.longFocus ? this.longFocus.totalMinutes * 60000 : this.policy.durationMs(next));
      this.value.phase = next; this.value.nextPhase = null; this.value.phaseElapsedMs = 0;
      this.value.remainingMs = this.phaseDurationMs; this.value.status = 'running'; this.resetMicro();
    }
    return this.state();
  }

  stop(): TimerState {
    this.advance('stop');
    if (this.isOpen()) { this.value.status = 'stopped'; this.value.endedAt = this.last!.wallMs; this.value.nextPhase = null; }
    return this.state();
  }

  private isOpen(): boolean { return this.value.status !== 'idle' && this.value.status !== 'stopped'; }

  private readClock(): ClockReading {
    const reading = this.clock.read();
    if (!Number.isFinite(reading.monotonicMs) || reading.monotonicMs < 0 ||
      !Number.isSafeInteger(reading.wallMs) || Math.abs(reading.wallMs) > 8640000000000000 ||
      !Number.isInteger(reading.utcOffsetMinutes) || Math.abs(reading.utcOffsetMinutes) > 840) throw new Error('无效时钟读数');
    return { ...reading };
  }

  private advance(reason: SliceReason): void {
    if (!this.isOpen()) return;
    const at = this.readClock();
    const from = this.last!;
    const delta = at.monotonicMs - from.monotonicMs;
    if (delta < 0) throw new Error('单调时钟发生回退');
    const clockChanged = Math.abs(at.wallMs - from.wallMs - delta) > CLOCK_DRIFT_MS;
    if (this.value.status === 'running' && delta > MAX_GAP_MS) {
      this.append(from, delta, 'unknown', 'gap', clockChanged);
      this.value.status = 'paused';
    } else if (this.value.status !== 'running') {
      this.append(from, delta, this.value.status === 'paused' ? 'pause' : 'waiting', clockChanged ? 'clock-change' : reason, clockChanged);
    } else if (clockChanged) {
      // No trustworthy wall interval spans a clock jump. Re-anchor the next slice at the new reading.
      this.append(from, delta, 'unknown', 'clock-change', true);
    } else {
      let consumed = 0;
      while (consumed < delta && this.value.status === 'running') {
        const point = { ...from, monotonicMs: from.monotonicMs + consumed, wallMs: from.wallMs + consumed };
        const remaining = this.phaseDurationMs === null ? delta - consumed : this.phaseDurationMs - this.value.phaseElapsedMs;
        const used = Math.min(delta - consumed, remaining, this.value.microRemainingMs ?? Infinity);
        const completed = this.phaseDurationMs !== null && used >= remaining;
        this.append(point, used, this.value.phase === 'work' && !this.value.microResting ? 'work' : 'break', completed ? 'phase-end' : reason);
        this.value.phaseElapsedMs += used;
        this.value.remainingMs = this.phaseDurationMs === null ? null : Math.max(0, this.phaseDurationMs - this.value.phaseElapsedMs);
        if (this.value.microRemainingMs != null) this.value.microRemainingMs -= used;
        consumed += used;
        if (completed) this.completePhase(from.wallMs + consumed);
        else if (this.value.microRemainingMs === 0) {
          this.value.microResting = !this.value.microResting;
          this.value.microRemainingMs = this.value.microResting ? this.longFocus.durationSeconds * 1000 : this.interval();
          this.events.push({ id: this.makeId(), type: this.value.microResting ? 'micro-start' : 'micro-end', sessionId: this.value.sessionId!, phase: 'work', at: from.wallMs + consumed, completedPomodoros: this.value.completedPomodoros });
        }
      }
      if (consumed < delta && this.value.mode === 'pomodoro') {
        this.append({ ...from, monotonicMs: from.monotonicMs + consumed, wallMs: from.wallMs + consumed }, delta - consumed, 'waiting', reason);
      }
    }
    // Preserve the monotonic-to-wall mapping across normal clock jitter. Reading
    // Date.now() afresh as each slice's start would introduce overlaps or holes.
    // Comparing against this mapping also catches a series of small adjustments.
    this.last = clockChanged ? at : { ...at, wallMs: from.wallMs + delta };
  }

  private interval(): number {
    const fraction = Math.max(0, Math.min(1, this.random()));
    return (this.longFocus.minMinutes + fraction * (this.longFocus.maxMinutes - this.longFocus.minMinutes)) * 60000;
  }
  private resetMicro(): void {
    this.value.microResting = false;
    this.value.microRemainingMs = this.value.longFocus && this.longFocus.microEnabled && this.value.phase === 'work' ? this.interval() : null;
  }
  private completePhase(at: number): void {
    const phase = this.value.phase as TimerPhase;
    if (this.value.mode === 'pomodoro') {
      if (phase === 'work') this.value.completedPomodoros++;
      this.value.nextPhase = this.policy.after(phase, this.value.completedPomodoros);
      this.value.status = 'awaiting-next';
      if (this.value.longFocus && phase === 'work') {
        this.value.phase = 'long-break'; this.value.nextPhase = null; this.value.status = 'running';
        this.phaseDurationMs = this.longFocus.restMinutes * 60000;
        this.value.phaseElapsedMs = 0; this.value.remainingMs = this.phaseDurationMs;
      }
      this.resetMicro();
    } else { this.value.status = 'stopped'; this.value.endedAt = at; }
    this.events.push({ id: this.makeId(), type: 'phase-completed', sessionId: this.value.sessionId!, phase, at, completedPomodoros: this.value.completedPomodoros });
  }

  private append(from: ClockReading, durationMs: number, kind: SliceKind, reason: SliceReason, clockChanged = false): void {
    if (durationMs <= 0) return;
    this.slices.push({
      id: this.makeId(), sessionId: this.value.sessionId!, taskId: this.value.taskId, phase: this.value.phase!, kind, reason,
      ...(this.value.microResting && kind === 'break' ? { microBreak: true } : {}),
      monotonicStartMs: from.monotonicMs, monotonicEndMs: from.monotonicMs + durationMs, durationMs,
      startedAt: from.wallMs, endedAt: clockChanged ? null : from.wallMs + durationMs, utcOffsetMinutes: from.utcOffsetMinutes,
    });
    this.value.elapsedMs += durationMs;
    switch (kind) {
      case 'work': this.value.workMs += durationMs; break;
      case 'break': this.value.breakMs += durationMs; if (this.value.microResting) this.value.microBreakMs = (this.value.microBreakMs ?? 0) + durationMs; break;
      case 'pause': this.value.pausedMs += durationMs; break;
      case 'waiting': this.value.waitingMs += durationMs; break;
      case 'unknown': this.value.unknownMs += durationMs; break;
    }
  }
}
