import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { StudyStore } from '../src/desktop/store';
import { remainingTaskMs } from '../src/desktop/vendor/task-time';

const dirs: string[] = [];
const stores: StudyStore[] = [];
function open() {
  const dir = mkdtempSync(join(tmpdir(), 'studyflow-test-')); dirs.push(dir);
  const path = join(dir, 'test.sqlite');
  const store = new StudyStore(path); stores.push(store);
  return { store, path };
}
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

it('persists task completion, focus time and settings across database reopen', () => {
  const { store, path } = open();
  const project = store.createProject(' 示例 ');
  const task = store.createTask({ title: ' 阅读 ', projectId: project.id, estimateMinutes: 25 });
  store.setTaskDone(task.id, true);
  store.addFocusTime(task.id, 12000);
  store.updateSettings({ durationMinutes: 30, whitelist: [' Code.exe ', 'code.exe'] });
  store.close();
  const again = new StudyStore(path); stores.push(again);
  expect(again.snapshot()).toMatchObject({
    projects: [{ name: '示例' }],
    tasks: [{ title: '阅读', done: true, spentMs: 12000, estimateMinutes: 25 }],
    settings: { durationMinutes: 30, whitelist: ['code.exe'] },
  });
});
it('rejects malformed writes without partially changing the database', () => {
  const { store } = open();
  expect(() => store.createProject('  ')).toThrow();
  expect(() => store.createTask({ title: 'x', projectId: 'missing', estimateMinutes: 25 })).toThrow();
  expect(() => store.createTask({ title: 'x', projectId: null, estimateMinutes: NaN })).toThrow();
  expect(() => store.updateSettings({ durationMinutes: 0, whitelist: [] })).toThrow();
  expect(() => store.setTaskDone('missing', true)).toThrow();
  expect(store.snapshot().tasks).toEqual([]);
});
it('refuses a newer schema without rewriting it', () => {
  const { store, path } = open(); store.close();
  const db = new DatabaseSync(path); db.exec('PRAGMA user_version = 99'); db.close();
  expect(() => new StudyStore(path)).toThrow(/版本/);
  const verify = new DatabaseSync(path);
  expect(verify.prepare('PRAGMA user_version').get()?.user_version).toBe(99); verify.close();
});
it('remaining estimate never becomes negative', () => {
  expect(remainingTaskMs({ estimateMinutes: 25, spentMs: 60000 })).toBe(1440000);
  expect(remainingTaskMs({ estimateMinutes: 1, spentMs: 120000 })).toBe(0);
});
