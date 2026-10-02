import { expect, it } from 'vitest';
import { StudyStore } from '../src/desktop/store';
import { DesktopService } from '../src/desktop/service';

function run(titles: string[], plans: unknown[], startDate?: string) {
  const store = new StudyStore(':memory:');
  const service = new DesktopService(store, { state: () => ({ running: false, taskId: null, remainingSeconds: 0, totalSeconds: 0, app: null, message: '', notification: 'none' }), start() {}, stop() {} });
  try {
    return service.execute('previewImport', { content: JSON.stringify({ schemaVersion: 1,
      tasks: titles.map((title, i) => ({ taskKey: String(i), project: '学习', title, estimateMinutes: 10 })), plans }), startDate }).importPreview!;
  } finally { store.close(); }
}
it('resolves different day prefixes from an explicit day-one date across a month boundary', () => {
  const result = run(['第1天｜概念', '第 二 天：练习', 'Day 3 - 回顾', '4｜验收'], [], '2026-09-29');
  expect(result.plans).toEqual([
    { date: '2026-09-29', taskKey: '0', minutes: 10 },
    { date: '2026-09-30', taskKey: '1', minutes: 10 },
    { date: '2026-10-01', taskKey: '2', minutes: 10 },
    { date: '2026-10-02', taskKey: '3', minutes: 10 },
  ]);
});
it('uses explicit file dates first and derives the same project day-one anchor', () => {
  const result = run(['第1天｜概念', '第2天｜练习'], [{ date: '2026-10-01', taskKey: '0', minutes: 15 }]);
  expect(result.plans).toEqual([{ date: '2026-10-01', taskKey: '0', minutes: 15 }, { date: '2026-10-02', taskKey: '1', minutes: 10 }]);
});
it('requires a starting date when day labels have no calendar anchor', () => {
  expect(run(['第1天｜概念', '第14天｜验收'], []).errors.join()).toContain('第 1 天');
});
it('does not turn quantities in task text into day numbers', () => {
  expect(run(['阅读1篇论文', '10分钟复习', '1.5小时学习'], []).plans).toEqual([]);
});
it('recognizes day markers followed immediately by Chinese text', () => {
  const result = run(['第1天学习基础', '第二天学习练习', 'Day3基础'], [], '2026-09-10');
  expect(result.plans.map(p => p.date)).toEqual(['2026-09-10', '2026-09-11', '2026-09-12']);
});
it('does not silently choose between inconsistent anchors', () => {
  const result = run(['第1天｜概念', 'Day 2 - 练习', '第3天｜验收'], [
    { date: '2026-09-10', taskKey: '0', minutes: 10 }, { date: '2026-09-15', taskKey: '1', minutes: 10 },
  ]);
  expect(result.errors.join()).toContain('不一致');
});
