// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FocusMiniAPI, FocusMiniReply, FocusMiniSnapshot } from '../src/desktop/focus-mini-contracts';
import { formatFocusElapsed, mountFocusMini } from '../src/desktop/focus-mini-renderer';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

function page() {
  document.body.innerHTML = `<main><span id="focus-mini-status"></span><time id="focus-mini-time"></time><p id="focus-mini-date"></p><p id="focus-mini-task"></p><p id="focus-mini-error"></p><button id="focus-mini-open-main"></button><button id="focus-mini-close"></button></main>`;
}

const snapshot: FocusMiniSnapshot = { date: '2026-09-12', elapsedMs: 3_661_000, status: 'running', taskTitle: '<b>高等数学</b>' };
const disposers: Array<() => void> = [];
function setup(api: FocusMiniAPI) { const mounted = mountFocusMini(document, api); disposers.push(mounted.dispose); return mounted; }

beforeEach(() => { vi.useFakeTimers(); page(); });
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); vi.useRealTimers(); });

describe('专注小窗渲染', () => {
  it.each([[0, '00:00:00'], [3_661_000, '01:01:01'], [360_000_000, '100:00:00']] as const)('将 %i 毫秒格式化为 %s', (value, expected) => {
    expect(formatFocusElapsed(value)).toBe(expected);
  });

  it('立即渲染今天累计、任务与状态，所有外部文字均作为文本', async () => {
    const api: FocusMiniAPI = { snapshot: vi.fn(async (): Promise<FocusMiniReply> => ({ ok: true, snapshot })), act: vi.fn(async (): Promise<FocusMiniReply> => ({ ok: true })) };
    setup(api); await vi.waitFor(() => expect(api.snapshot).toHaveBeenCalledOnce());
    expect(document.getElementById('focus-mini-time')?.textContent).toBe('01:01:01');
    expect(document.getElementById('focus-mini-date')?.textContent).toBe('2026-09-12 · 今日累计');
    expect(document.getElementById('focus-mini-task')?.textContent).toBe(snapshot.taskTitle);
    expect(document.querySelector('b')).toBeNull();
    expect(document.getElementById('focus-mini-status')?.textContent).toBe('专注中');
    expect(document.body.dataset.status).toBe('running');
  });

  it('每秒轮询且上一次未结束时不重叠', async () => {
    const first = deferred<FocusMiniReply>();
    const api: FocusMiniAPI = { snapshot: vi.fn(() => first.promise), act: vi.fn(async (): Promise<FocusMiniReply> => ({ ok: true })) };
    setup(api); expect(api.snapshot).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(3_000); expect(api.snapshot).toHaveBeenCalledOnce();
    first.resolve({ ok: true, snapshot }); await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000); expect(api.snapshot).toHaveBeenCalledTimes(2);
  });

  it('轮询失败保留上次时间并显示通用错误，恢复后清除错误', async () => {
    const api: FocusMiniAPI = { snapshot: vi.fn<() => Promise<FocusMiniReply>>()
      .mockResolvedValueOnce({ ok: true, snapshot })
      .mockRejectedValueOnce(new Error('private failure'))
      .mockResolvedValueOnce({ ok: true, snapshot: { ...snapshot, elapsedMs: 3_662_000, status: 'paused' } }),
      act: vi.fn(async (): Promise<FocusMiniReply> => ({ ok: true })) };
    setup(api); await vi.waitFor(() => expect(api.snapshot).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(1_000); await Promise.resolve();
    expect(document.getElementById('focus-mini-time')?.textContent).toBe('01:01:01');
    expect(document.getElementById('focus-mini-error')?.textContent).toBe('暂时无法更新，正在重试');
    await vi.advanceTimersByTimeAsync(1_000); await Promise.resolve();
    expect(document.getElementById('focus-mini-time')?.textContent).toBe('01:01:02');
    expect(document.getElementById('focus-mini-status')?.textContent).toBe('已暂停');
    expect(document.getElementById('focus-mini-error')?.textContent).toBe('');
  });

  it('按钮调用主进程动作，重复点击不会并发，失败会恢复按钮', async () => {
    const action = deferred<FocusMiniReply>();
    const api: FocusMiniAPI = { snapshot: vi.fn(async (): Promise<FocusMiniReply> => ({ ok: true, snapshot })), act: vi.fn(() => action.promise) };
    setup(api); const open = document.getElementById('focus-mini-open-main') as HTMLButtonElement;
    open.click(); open.click(); expect(api.act).toHaveBeenCalledExactlyOnceWith('open-main'); expect(open.disabled).toBe(true);
    action.resolve({ ok: false, error: '失败' }); await Promise.resolve(); await Promise.resolve();
    expect(open.disabled).toBe(false); expect(document.getElementById('focus-mini-error')?.textContent).toBe('操作未完成，请重试');
    document.getElementById('focus-mini-close')?.click(); expect(api.act).toHaveBeenLastCalledWith('close');
  });

  it('页面卸载后停止轮询并移除按钮监听', async () => {
    const api: FocusMiniAPI = { snapshot: vi.fn(async (): Promise<FocusMiniReply> => ({ ok: true, snapshot })), act: vi.fn(async (): Promise<FocusMiniReply> => ({ ok: true })) };
    setup(api); await vi.waitFor(() => expect(api.snapshot).toHaveBeenCalledOnce()); window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(3_000); document.getElementById('focus-mini-open-main')?.click();
    expect(api.snapshot).toHaveBeenCalledOnce(); expect(api.act).not.toHaveBeenCalled();
  });
});
