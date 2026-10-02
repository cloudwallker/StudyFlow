// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mountDiagnostics, type DiagnosticAPI, type DiagnosticReply, type DiagnosticStatus } from '../src/desktop/diagnostic-renderer';

const status: DiagnosticStatus = { enabled: true, version: '0.0.1-test', buildId: 'build-1', runId: 'run-1', elapsedSeconds: 65, errors: 2, warnings: 3, marks: 4, writeFailures: 1, watchdog: true, lastSaveAt: '2026-09-10T10:00:00Z' };
let cleanup = () => {};
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const button = (text: string) => { const found = Array.from(document.querySelectorAll('button')).find(b => b.textContent === text); expect(found).toBeDefined(); return found!; };
beforeEach(() => { vi.useFakeTimers(); document.body.innerHTML = '<main><p>Tasks</p></main>'; });
afterEach(() => { cleanup(); vi.useRealTimers(); });

it('renders enabled test status before tasks and leaves ordinary builds unchanged', async () => {
  cleanup = mountDiagnostics(document, { request: async () => ({ ok: true, status: { ...status, enabled: false } }) });
  await flush(); expect(document.querySelector('section')).toBeNull(); cleanup();
  cleanup = mountDiagnostics(document, { request: async () => ({ ok: true, status }) });
  await flush();
  const panel = document.querySelector('main')!.firstElementChild!;
  expect(panel.tagName).toBe('SECTION');
  for (const text of ['0.0.1-test', 'build-1', '运行 1 分 5 秒', '错误 2', '警告 3', '问题标记 4', '日志写入失败 1', '运行中', status.lastSaveAt!]) expect(panel.textContent).toContain(text);
});

it('sends only an enumerated problem category and explains external feedback', async () => {
  const requests: unknown[] = [];
  cleanup = mountDiagnostics(document, { request: async (command, payload) => { requests.push({ command, payload }); return { ok: true, status }; } });
  await flush();
  document.querySelector('select')!.value = 'reminder'; button('记录一个问题').click(); await flush();
  expect(requests.at(-1)).toEqual({ command: 'mark', payload: { category: 'reminder' } });
  expect(document.body.textContent).toContain('反馈表'); expect(document.body.textContent).toContain('时间');
  expect(document.querySelector('textarea,input')).toBeNull();
});

it('distinguishes export cancellation, success, and sanitized failure', async () => {
  let reply: DiagnosticReply = { ok: true, status, exported: false };
  cleanup = mountDiagnostics(document, { request: async command => command === 'status' ? { ok: true, status } : reply });
  await flush(); button('导出诊断包').click(); await flush(); expect(document.body.textContent).toContain('已取消导出');
  reply = { ok: true, status, exported: true }; button('导出诊断包').click(); await flush(); expect(document.body.textContent).toContain('诊断包已导出');
  reply = { ok: false, error: 'secret path and task content' }; button('导出诊断包').click(); await flush();
  expect(document.body.textContent).toContain('导出失败'); expect(document.body.textContent).not.toContain('secret');
});

it('describes intentional self-test errors separately from ordinary errors', async () => {
  const commands: string[] = [];
  cleanup = mountDiagnostics(document, { request: async command => { commands.push(command); return { ok: true, status }; } });
  await flush(); expect(document.body.textContent).toContain('不修改任务');
  button('诊断自检').click(); await flush();
  expect(commands.at(-1)).toBe('selfTest'); expect(document.body.textContent).toContain('单独统计');
});

it('polls without overlapping requests and ignores late status after disposal', async () => {
  let resolve: (reply: DiagnosticReply) => void = () => {};
  let calls = 0;
  const api: DiagnosticAPI = { request: () => { calls++; return new Promise(r => { resolve = r; }); } };
  cleanup = mountDiagnostics(document, api);
  await vi.advanceTimersByTimeAsync(30_000); expect(calls).toBe(1);
  resolve({ ok: true, status }); await flush();
  await vi.advanceTimersByTimeAsync(10_000); expect(calls).toBe(2);
  cleanup(); resolve({ ok: true, status }); await flush(); await vi.advanceTimersByTimeAsync(30_000);
  expect(document.querySelector('section')).toBeNull(); expect(calls).toBe(2);
});

it('removes handlers and prevents late action replies from modifying detached nodes', async () => {
  let resolve: (reply: DiagnosticReply) => void = () => {}; let actions = 0;
  cleanup = mountDiagnostics(document, { request: command => command === 'status' ? Promise.resolve({ ok: true, status }) : new Promise(r => { actions++; resolve = r; }) });
  await flush(); const panel = document.querySelector('section')!; const mark = button('记录一个问题'); mark.click();
  const before = panel.textContent; cleanup(); resolve({ ok: true, status }); await flush(); mark.click();
  expect(actions).toBe(1); expect(panel.textContent).toBe(before); expect(document.querySelector('section')).toBeNull();
});
