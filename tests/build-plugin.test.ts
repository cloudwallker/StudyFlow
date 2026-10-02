import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('builds the same ZIP bytes across developer timezones', () => {
  const archives = ['UTC', 'Asia/Shanghai', 'America/New_York'].map(TZ => {
    execFileSync(process.execPath, ['scripts/build-plugin.mjs'], { env: { ...process.env, TZ } });
    return readFileSync('dist/studyflow-phase0.zip');
  });
  expect(archives[1]!.equals(archives[0]!)).toBe(true);
  expect(archives[2]!.equals(archives[0]!)).toBe(true);
});
