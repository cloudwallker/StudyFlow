import { describe, expect, it } from 'vitest';
import { normalizeApp, isAllowedApp } from '../src/focus/normalize-app';

describe('app normalization and exact whitelist', () => {
  it.each(['Code.exe', 'code.exe', ' CODE.EXE '])('normalizes %s', app => {
    expect(normalizeApp(app)).toBe('code.exe');
  });
  it('matches normalized exact names only', () => {
    expect(isAllowedApp(' CODE.EXE ', ['Code.exe'])).toBe(true);
    expect(isAllowedApp('code.exe extra', ['Code.exe'])).toBe(false);
    expect(isAllowedApp('notepad.exe', ['Code.exe'])).toBe(false);
    expect(isAllowedApp('code.exe', ['*.exe'])).toBe(false);
  });
  it('never treats an empty app as whitelisted', () => {
    expect(isAllowedApp(' ', ['', ' '])).toBe(false);
  });
});
