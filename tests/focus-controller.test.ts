import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FocusController, type FocusState } from '../src/focus/focus-controller';
import type { ActiveWindow } from '../src/adapters/activitywatch-parsing';

const window = (app = 'Notepad'): ActiveWindow => ({ app, timestamp: '2026-01-01T00:00:00Z', durationSeconds: 0 });
const controllers: FocusController[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { controllers.forEach(c => c.dispose()); controllers.length = 0; vi.useRealTimers(); });
function setup(read: (signal?: AbortSignal) => Promise<ActiveWindow | null> = async () => window(), notify = vi.fn<(_: string, body: string) => Promise<void>>().mockResolvedValue(undefined)) {
  const getCurrentWindow = vi.fn(read);
  const states: FocusState[] = [];
  const controller = new FocusController({ isAvailable: async () => true, getCurrentWindow }, { notify }, state => states.push(state));
  controllers.push(controller);
  return { controller, getCurrentWindow, notify, states };
}

describe('Focus Test wiring and lifecycle', () => {
  it('starts only on demand and includes app and remaining time in notification', async () => {
    const { controller, getCurrentWindow, notify, states } = setup();
    expect(getCurrentWindow).not.toHaveBeenCalled();
    controller.start(['Code.exe']); await vi.advanceTimersByTimeAsync(0);
    expect(notify).toHaveBeenCalledExactlyOnceWith('StudyFlow 专注测试提醒', '当前检测到：Notepad\n本次专注还剩：10:00');
    expect(states.at(-1)).toMatchObject({ running: true, remainingSeconds: 600, app: 'Notepad' });
  });
  it('does not notify whitelist or missing app', async () => {
    const { controller, notify, getCurrentWindow } = setup(async () => window(' CODE.EXE '));
    controller.start(['Code.exe']); await vi.advanceTimersByTimeAsync(0);
    getCurrentWindow.mockResolvedValue(null); await vi.advanceTimersByTimeAsync(3000);
    expect(notify).not.toHaveBeenCalled();
  });
  it('waits 60 seconds before notifying again, even for another app', async () => {
    const { controller, notify, getCurrentWindow } = setup();
    controller.start([]); await vi.advanceTimersByTimeAsync(3000);
    getCurrentWindow.mockResolvedValue(window('Calculator'));
    await vi.advanceTimersByTimeAsync(56999);
    expect(notify).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(notify).toHaveBeenCalledTimes(2);
  });
  it('does not overlap reads when one is slow', async () => {
    let resolve!: (value: ActiveWindow) => void;
    const { controller, getCurrentWindow } = setup(() => new Promise(r => { resolve = r; }));
    controller.start([]); await vi.advanceTimersByTimeAsync(15000);
    expect(getCurrentWindow).toHaveBeenCalledTimes(1);
    resolve(window()); await vi.advanceTimersByTimeAsync(3000);
    expect(getCurrentWindow).toHaveBeenCalledTimes(2);
  });
  it('stop aborts read and suppresses a late result/notification', async () => {
    let resolve!: (value: ActiveWindow) => void;
    let signal: AbortSignal | undefined;
    const { controller, notify, getCurrentWindow } = setup(s => { signal = s; return new Promise(r => { resolve = r; }); });
    controller.start([]); controller.stop();
    expect(signal?.aborted).toBe(true);
    resolve(window()); await vi.advanceTimersByTimeAsync(70000);
    expect(notify).not.toHaveBeenCalled();
    expect(getCurrentWindow).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('restart ignores previous session result and never overlaps pending work', async () => {
    let resolve!: (value: ActiveWindow) => void;
    const { controller, notify, getCurrentWindow } = setup(() => new Promise(r => { resolve = r; }));
    controller.start([]); controller.stop(); controller.start(['Notepad']);
    expect(getCurrentWindow).toHaveBeenCalledTimes(1);
    resolve(window()); getCurrentWindow.mockResolvedValue(window());
    await vi.advanceTimersByTimeAsync(3000);
    expect(notify).not.toHaveBeenCalled();
    expect(getCurrentWindow).toHaveBeenCalledTimes(2);
  });
  it('natural expiry stops even while a read is hung', async () => {
    const { controller, states } = setup(() => new Promise(() => {}));
    controller.start([]); await vi.advanceTimersByTimeAsync(600000);
    expect(states.at(-1)).toMatchObject({ running: false, remainingSeconds: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('recovers after source error and redacts raw error', async () => {
    const { controller, getCurrentWindow, notify, states } = setup(async () => { throw Error('fictional secret title'); });
    controller.start([]); await vi.advanceTimersByTimeAsync(0);
    expect(states.at(-1)?.error).not.toContain('secret');
    getCurrentWindow.mockResolvedValue(window()); await vi.advanceTimersByTimeAsync(3000);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(states.at(-1)?.error).toBe('');
  });
  it('failed notifications also respect cooldown and do not leave unhandled rejection', async () => {
    const notify = vi.fn<(_: string, body: string) => Promise<void>>().mockRejectedValue(Error('private failure'));
    const { controller } = setup(undefined, notify);
    controller.start([]); await vi.advanceTimersByTimeAsync(59999);
    expect(notify).toHaveBeenCalledTimes(1);
  });
  it('dispose permanently stops controller and removes all timers', async () => {
    const { controller, getCurrentWindow } = setup();
    controller.start([]); await vi.advanceTimersByTimeAsync(0);
    controller.dispose(); controller.start([]); await vi.advanceTimersByTimeAsync(70000);
    expect(getCurrentWindow).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
