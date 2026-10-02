import { inputRecord, positiveInteger } from './pomodoro-policy';
import type { TimerState } from './contracts';

export const soundKinds = ['cue', 'focus-start', 'micro-start', 'micro-end', 'long-start', 'work-end', 'break-end'] as const;
export type SoundKind = typeof soundKinds[number];
export interface SoundConfig {
  events?: Partial<Record<SoundKind, { volume: number; tone: 'soft' | 'bell' | 'wood' }>>;
  enabled: boolean; minMinutes: number; maxMinutes: number; volume: number; tone: 'soft' | 'bell' | 'wood';
}
export interface SoundPort { play(kind: SoundKind, config: SoundConfig): Promise<void>; stop(): void }

export function soundConfig(value: unknown = {}): SoundConfig {
  const input = inputRecord(value);
  const enabled = input.enabled ?? false;
  if (typeof enabled !== 'boolean') throw new Error('声音开关须为布尔值');
  const minMinutes = positiveInteger(input.minMinutes ?? 3, 240);
  const maxMinutes = positiveInteger(input.maxMinutes ?? 5, 240);
  if (minMinutes > maxMinutes) throw new Error('提示音最小间隔不能大于最大间隔');
  const volume = input.volume ?? 40;
  if (typeof volume !== 'number' || !Number.isInteger(volume) || volume < 0 || volume > 100) throw new Error('音量须为 0—100 的整数');
  const tone = input.tone ?? 'soft';
  if (tone !== 'soft' && tone !== 'bell' && tone !== 'wood') throw new Error('无效提示音色');
  const result: SoundConfig = { enabled, minMinutes, maxMinutes, volume, tone };
  if (input.events !== undefined) {
    const events = inputRecord(input.events); result.events = {};
    for (const [key, value] of Object.entries(events)) {
      if (!soundKinds.includes(key as SoundKind)) throw new Error('无效声音事件');
      const item = inputRecord(value);
      const validated = soundConfig({ volume: item.volume ?? volume, tone: item.tone ?? tone });
      result.events[key as SoundKind] = { volume: validated.volume, tone: validated.tone };
    }
  }
  return result;
}

/** Counted phase time excludes gaps, clock jumps and pauses. Never catches up in bursts. */
export class PomodoroSound {
  private next = Infinity;
  constructor(private readonly random: () => number = Math.random) {}
  reset(state: TimerState, config: SoundConfig): void {
    const fraction = Math.max(0, Math.min(1, this.random()));
    this.next = state.phaseElapsedMs + (config.minMinutes + fraction * (config.maxMinutes - config.minMinutes)) * 60000;
  }
  due(state: TimerState, config: SoundConfig): boolean {
    if (state.longFocus && state.microRemainingMs != null) return false;
    if (!config.enabled || (config.events?.cue?.volume ?? config.volume) === 0 || state.mode !== 'pomodoro' || state.status !== 'running' || state.phase !== 'work') return false;
    if (state.phaseElapsedMs < this.next) return false;
    this.reset(state, config);
    return true;
  }
}
