import { inputRecord, positiveInteger } from './pomodoro-policy';

export interface LongFocusConfig {
  enabled: boolean; microEnabled: boolean; totalMinutes: number; restMinutes: number;
  minMinutes: number; maxMinutes: number; durationSeconds: number;
}
export function longFocusConfig(value: unknown = {}): LongFocusConfig {
  const input = inputRecord(value);
  const enabled = input.enabled ?? false; const microEnabled = input.microEnabled ?? false;
  if (typeof enabled !== 'boolean' || typeof microEnabled !== 'boolean') throw new Error('长专注及微休息开关须为布尔值');
  const minMinutes = positiveInteger(input.minMinutes ?? 2, 240);
  const maxMinutes = positiveInteger(input.maxMinutes ?? 3, 240);
  if (minMinutes > maxMinutes) throw new Error('微休息最小间隔不能大于最大间隔');
  return { enabled, microEnabled, minMinutes, maxMinutes,
    totalMinutes: positiveInteger(input.totalMinutes ?? 60, 240), restMinutes: positiveInteger(input.restMinutes ?? 10, 240),
    durationSeconds: positiveInteger(input.durationSeconds ?? 10, 600) };
}
