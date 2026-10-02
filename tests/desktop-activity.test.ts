import { expect, it } from 'vitest';
import { parseActivitySample, parseSample, WindowsActivitySource } from '../src/desktop/activity';

it('extracts only the app and rejects malformed or oversized samples', () => {
  expect(parseSample('{"app":"Code.exe","title":"private"}')).toBe('Code.exe');
  expect(parseSample('{"app":null}')).toBeNull();
  expect(() => parseSample('{"app":12}')).toThrow();
  expect(() => parseSample('x'.repeat(4097))).toThrow();
  expect(() => parseSample('{"app":"x\\ncommand"}')).toThrow();
});
it('validates idle protocol and strips metadata before the shared sampler sees it', () => {
  expect(parseActivitySample('{"status":"ok","app":"Code.exe","idleMs":300000,"title":"private"}')).toEqual({ status: 'ok', app: 'Code.exe', idleMs: 300000 });
  expect(parseActivitySample('{"status":"unknown","app":null,"idleMs":null}')).toEqual({ status: 'unknown', app: null, idleMs: null });
  for (const value of [
    { status: 'ok', app: 'Code.exe', idleMs: -1 }, { status: 'ok', app: 'Code.exe', idleMs: 1.5 },
    { status: 'ok', app: 'Code.exe', idleMs: '0' }, { app: 'Code.exe' },
    { status: 'unknown', app: 'Code.exe', idleMs: 0 }, { status: 'ok', app: null, idleMs: 0 },
  ]) expect(() => parseActivitySample(JSON.stringify(value))).toThrow();
});
it('fails cleanly if the bundled collector cannot start and can be disposed repeatedly', async () => {
  const source = new WindowsActivitySource('missing-studyflow-collector.exe');
  await expect(source.getCurrentApp()).rejects.toThrow(/采集/);
  source.dispose(); source.dispose();
  await expect(source.getCurrentApp()).rejects.toThrow();
});
