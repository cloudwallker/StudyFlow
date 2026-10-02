import { expect, it } from 'vitest';
import { PomodoroPolicy } from '../src/timer/pomodoro-policy';

it('uses the default durations and long break every fourth completed work phase', () => {
  const policy = new PomodoroPolicy();
  expect(policy.durationMs('work')).toBe(1500000);
  expect(policy.durationMs('short-break')).toBe(300000);
  expect(policy.durationMs('long-break')).toBe(900000);
  expect(policy.after('work', 1)).toBe('short-break');
  expect(policy.after('work', 4)).toBe('long-break');
  expect(policy.after('work', 8)).toBe('long-break');
  expect(policy.after('short-break', 1)).toBe('work');
  expect(policy.after('long-break', 4)).toBe('work');
});

it('validates and copies custom policy so caller mutations cannot change a running cycle', () => {
  const input = { workMinutes: 50, shortBreakMinutes: 10, longBreakMinutes: 20, roundsBeforeLongBreak: 2 };
  const policy = new PomodoroPolicy(input); input.workMinutes = 1;
  expect(policy.durationMs('work')).toBe(3000000);
  expect(policy.durationMs('short-break')).toBe(600000);
  expect(policy.durationMs('long-break')).toBe(1200000);
  expect(policy.after('work', 2)).toBe('long-break');
});

it.each([null, [], { workMinutes: 0 }, { shortBreakMinutes: -1 }, { longBreakMinutes: 241 },
  { workMinutes: '25' }, { roundsBeforeLongBreak: 0 }, { roundsBeforeLongBreak: 1.5 },
  { roundsBeforeLongBreak: Infinity }, { workMinutes: NaN },
])('rejects invalid policy: %j', input => { expect(() => new PomodoroPolicy(input)).toThrow(); });
