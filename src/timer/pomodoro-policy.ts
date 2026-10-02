import type { PomodoroConfig, TimerPhase } from './contracts';

export function inputRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效计时参数');
  return value as Record<string, unknown>;
}

export function positiveInteger(value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) throw new Error(`计时配置须为 1—${max} 的整数`);
  return value;
}

export class PomodoroPolicy {
  private readonly config: PomodoroConfig;
  constructor(value: unknown = {}) {
    const input = inputRecord(value);
    const configured = (key: string, fallback: number, max = 240): number => positiveInteger(input[key] === undefined ? fallback : input[key], max);
    this.config = {
      workMinutes: configured('workMinutes', 25), shortBreakMinutes: configured('shortBreakMinutes', 5),
      longBreakMinutes: configured('longBreakMinutes', 15), roundsBeforeLongBreak: configured('roundsBeforeLongBreak', 4, 100),
    };
  }
  durationMs(phase: TimerPhase): number {
    switch (phase) {
      case 'work': return this.config.workMinutes * 60000;
      case 'short-break': return this.config.shortBreakMinutes * 60000;
      case 'long-break': return this.config.longBreakMinutes * 60000;
    }
  }
  after(phase: TimerPhase, completedPomodoros: number): TimerPhase {
    if (phase !== 'work') return 'work';
    return completedPomodoros % this.config.roundsBeforeLongBreak === 0 ? 'long-break' : 'short-break';
  }
}
