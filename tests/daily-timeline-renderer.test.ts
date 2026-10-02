// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mountDaily } from '../src/desktop/daily-renderer';
import { StudyStore } from '../src/desktop/store';
import { DesktopService } from '../src/desktop/service';
import type { DailyData } from '../src/desktop/daily';

it('shows at most two rows per title across many fragments, sessions and states without losing time', async () => {
  document.documentElement.innerHTML = readFileSync('desktop/index.html', 'utf8');
  const store = new StudyStore(':memory:');
  const service = new DesktopService(store, { state: () => ({ running: false, taskId: null, remainingSeconds: 0, totalSeconds: 0, app: null, message: '', notification: 'none' }), start: () => {}, stop: () => {} });
  const start = Date.UTC(2026, 8, 10, 7);
  const timeline: DailyData['timeline'] = Array.from({ length: 100 }, (_, i) => ({
    start: start + i * 60000, end: start + i * 60000 + 1000, kind: 'work', offset: 480,
    title: '<b>同名任务</b>', durationMs: 1000, effectiveMs: 500, afkMs: 300, unknownMs: 200,
  }));
  for (const [i, kind] of ['pause', 'break', 'waiting', 'micro-break', 'unknown'].entries()) {
    timeline.push({ start: start + i * 60000, end: kind === 'unknown' ? null : start + i * 60000 + 6000, kind, offset: 480,
      title: '<b>同名任务</b>', durationMs: 6000, effectiveMs: 0, afkMs: 0, unknownMs: kind === 'unknown' ? 6000 : 0 });
  }
  timeline.push({ ...timeline[0]!, title: '另一个任务', durationMs: 1000 });
  // Unsorted input and different recorded offsets must not create additional title rows.
  timeline[99]!.offset = 540;
  timeline.reverse();
  const cleanup = mountDaily(document, { request: async (command, payload) => {
    const value = service.execute(command, payload);
    if (value.daily) value.daily.timeline = timeline;
    return { ok: true, value };
  } });
  try {
    await new Promise(resolve => setTimeout(resolve, 0));
    const rows = Array.from(document.querySelectorAll('#daily-timeline tbody tr')).map(row => row.textContent!);
    expect(rows).toHaveLength(3);
    const same = rows.filter(row => row.includes('<b>同名任务</b>'));
    expect(same).toHaveLength(2);
    expect(same.find(row => row.includes('学习汇总'))).toContain('1.7 / 0.8 / 0.5 / 0.3');
    expect(same.find(row => row.includes('休息 / 暂停等汇总'))).toContain('0.5 / 0 / 0 / 0.1');
    expect(same.find(row => row.includes('学习汇总'))).toContain('15:00:00 (UTC+8)');
    expect(same.find(row => row.includes('学习汇总'))).toContain('17:39:01 (UTC+9)');
    expect(same.find(row => row.includes('休息 / 暂停等汇总'))).toContain('时钟不连续');
    expect(document.querySelector('#daily-timeline')!.textContent).toContain('非连续时长');
    expect(rows.find(row => row.includes('另一个任务'))).toContain('<0.1');
    expect(document.querySelector('#daily-timeline b')).toBeNull();
    (document.getElementById('daily-load') as HTMLButtonElement).click();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(document.querySelectorAll('#daily-timeline tbody tr')).toHaveLength(3);
    expect(timeline).toHaveLength(106);
  } finally { cleanup(); store.close(); }
});
