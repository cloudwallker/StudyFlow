// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { mountDesktop } from '../src/desktop/renderer';
import type { Command, DesktopSnapshot } from '../src/desktop/contracts';

it('打开小窗不改变专注，加载时防止重复请求，失败后可重试', async () => {
  document.documentElement.innerHTML = readFileSync('desktop/index.html', 'utf8');
  const data: DesktopSnapshot = { projects: [], tasks: [], settings: { durationMinutes: 25, whitelist: [] },
    focus: { running: false, taskId: null, remainingSeconds: 0, totalSeconds: 0, app: null, message: '', notification: 'none' } };
  let reject!: (reason: Error) => void;
  const open = vi.fn().mockImplementationOnce(() => new Promise((_resolve, no) => { reject = no; }))
    .mockResolvedValue({ ok: true });
  const request = vi.fn(async (_command: Command) => ({ ok: true as const, value: data }));
  const cleanup = mountDesktop(document, { request, focusMini: { open } });
  try {
    const button = document.querySelector<HTMLButtonElement>('#focus-mini-open');
    expect(button).not.toBeNull();
    button!.click(); button!.click();
    expect(open).toHaveBeenCalledTimes(1);
    expect(button!.disabled).toBe(true);
    reject(new Error('private native path'));
    await vi.waitFor(() => expect(button!.disabled).toBe(false));
    expect(document.getElementById('error')?.textContent).toContain('小窗');
    expect(document.getElementById('error')?.textContent).not.toContain('private');
    button!.click(); await vi.waitFor(() => expect(button!.disabled).toBe(false));
    expect(open).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.every(call => call[0] === 'snapshot' || call[0] === 'daily')).toBe(true);
  } finally { cleanup(); }
});
