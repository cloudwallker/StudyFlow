import { longFocusConfig, type LongFocusConfig } from '../timer/long-focus';
import type { PomodoroConfig, TimerMode } from '../timer/contracts';
import { inputRecord, positiveInteger } from '../timer/pomodoro-policy';
import { soundConfig, type SoundConfig } from '../timer/pomodoro-sound';

export function timerPreferences(value: unknown): { mode: TimerMode; idleMinutes: number; policy: PomodoroConfig; sound: SoundConfig; longFocus: LongFocusConfig } {
  const input = inputRecord(value);
  const mode = input.mode ?? 'countdown';
  if (mode !== 'countdown' && mode !== 'stopwatch' && mode !== 'pomodoro') throw new Error('无效计时模式');
  const policy = inputRecord(input.policy ?? {});
  return { mode, longFocus: longFocusConfig(input.longFocus), sound: soundConfig(input.sound), idleMinutes: positiveInteger(input.idleMinutes ?? 5, 240), policy: {
    workMinutes: positiveInteger(policy.workMinutes ?? 25, 240), shortBreakMinutes: positiveInteger(policy.shortBreakMinutes ?? 5, 240),
    longBreakMinutes: positiveInteger(policy.longBreakMinutes ?? 15, 240), roundsBeforeLongBreak: positiveInteger(policy.roundsBeforeLongBreak ?? 4, 100),
  } };
}
