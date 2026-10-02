import { describe, expect, it } from 'vitest';
import { decideFocus } from '../src/focus/focus-guard';
import { createSession } from '../src/focus/focus-session';

describe('focus decisions', () => {
  const session = { startedAt: 0, endsAt: 600_000, whitelist: ['Code.exe'] };
  it('creates an independent ten-minute session', () => {
    const whitelist = ['Code.exe'];
    const result = createSession(1000, whitelist);
    whitelist.push('Notepad');
    expect(result).toEqual({ startedAt: 1000, endsAt: 601000, whitelist: ['Code.exe'] });
  });
  it('does not notify without a session', () => {
    expect(decideFocus(null, 'Notepad', 1000, null)).toEqual({ shouldNotify: false, reason: 'no-session', remainingSeconds: 0 });
  });
  it.each([600000, 700000, -1])('does not notify outside session time at %s', now => {
    expect(decideFocus(session, 'Notepad', now, null).shouldNotify).toBe(false);
  });
  it('uses normalized whitelist', () => {
    expect(decideFocus(session, ' CODE.EXE ', 1001, null)).toEqual({ shouldNotify: false, reason: 'allowed', remainingSeconds: 599 });
  });
  it.each([null, '', '  '])('ignores missing/empty window app %s', app => {
    expect(decideFocus(session, app, 1000, null).reason).toBe('no-active-window');
  });
  it('notifies for non-whitelisted app with rounded-up remaining time', () => {
    expect(decideFocus(session, 'Notepad', 599001, null)).toEqual({ shouldNotify: true, reason: 'not-allowed', remainingSeconds: 1 });
  });
  it('blocks repeat notifications until exactly 60 seconds including timestamp zero', () => {
    expect(decideFocus(session, 'Notepad', 59999, 0).reason).toBe('cooldown');
    expect(decideFocus(session, 'Notepad', 60000, 0).shouldNotify).toBe(true);
  });
  it('returning to whitelist does not reset global cooldown', () => {
    expect(decideFocus(session, 'Code.exe', 10000, 0).reason).toBe('allowed');
    expect(decideFocus(session, 'Calculator', 20000, 0).reason).toBe('cooldown');
  });
});
