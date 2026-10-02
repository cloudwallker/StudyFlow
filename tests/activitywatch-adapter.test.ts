import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActivityWatchAdapter } from '../src/adapters/activitywatch-adapter';

const now = Date.parse('2026-01-01T00:00:10Z');
const bucket = (id: string, hostname = 'fictional-pc') => ({ id, type: 'currentwindow', client: 'aw-watcher-window', hostname, created: '2026-01-01T00:00:00Z' });
const events = [{ id: 1, timestamp: '2026-01-01T00:00:00Z', duration: 10, data: { app: 'Code.exe', title: 'Fictional notes' } }];
function setup(buckets: unknown = { custom: bucket('custom') }, eventData: unknown = events) {
  const fetchFn = vi.fn<typeof fetch>(async input => new Response(JSON.stringify(String(input).includes('/events?') ? eventData : buckets)));
  return { source: new ActivityWatchAdapter({ fetchFn, now: () => now }), fetchFn };
}
afterEach(() => vi.useRealTimers());

describe('ActivityWatch HTTP adapter', () => {
  it('calls fetch without an adapter receiver, as required by browser fetch', async () => {
    // Chromium rejects a native Window.fetch invoked with an adapter as `this`.
    const fetchFn: typeof fetch = async function (this: unknown, input) {
      if (this !== undefined) throw new TypeError('Illegal invocation');
      return new Response(JSON.stringify(String(input).includes('/events?') ? events : { custom: bucket('custom') }));
    };
    const source = new ActivityWatchAdapter({ fetchFn, now: () => now });
    await expect(source.getCurrentWindow()).resolves.toEqual({
      app: 'Code.exe', timestamp: '2026-01-01T00:00:00Z', durationSeconds: 10,
    });
  });
  it('reads official endpoints with GET only and no redirects/credentials', async () => {
    const { source, fetchFn } = setup({ 'custom/name': bucket('custom/name') });
    expect(await source.isAvailable()).toBe(true);
    expect(await source.getCurrentWindow()).toEqual({ app: 'Code.exe', timestamp: '2026-01-01T00:00:00Z', durationSeconds: 10 });
    expect(fetchFn.mock.calls.map(c => c[0])).toEqual(['http://127.0.0.1:5600/api/0/buckets/', 'http://127.0.0.1:5600/api/0/buckets/', 'http://127.0.0.1:5600/api/0/buckets/custom%2Fname/events?limit=1']);
    for (const [, init] of fetchFn.mock.calls) expect(init).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store' });
  });
  it('does not require window watcher to report server availability', async () => {
    const { source } = setup({});
    expect(await source.isAvailable()).toBe(true);
    await expect(source.getCurrentWindow()).rejects.toThrow('Window watcher data was not found');
  });
  it('returns null for empty/stale events', async () => {
    expect(await setup(undefined, []).source.getCurrentWindow()).toBeNull();
    expect(await setup(undefined, [{ ...events[0], duration: 0, timestamp: '2025-01-01T00:00:00Z' }]).source.getCurrentWindow()).toBeNull();
  });
  it('selects only explicitly specified host candidates', async () => {
    const fetchFn = vi.fn<typeof fetch>(async input => new Response(JSON.stringify(String(input).includes('/events?') ? events : { a: bucket('a', 'local'), b: bucket('b', 'remote') })));
    const source = new ActivityWatchAdapter({ fetchFn, now: () => now, hostname: 'LOCAL' });
    expect((await source.discoverWindowBucket()).bucket.id).toBe('a');
    expect(fetchFn.mock.calls.map(c => String(c[0]))).not.toContain('http://127.0.0.1:5600/api/0/buckets/b/events?limit=1');
  });
  it('surfaces ambiguous candidates instead of random selection', async () => {
    await expect(setup({ a: bucket('a'), b: bucket('b') }).source.getCurrentWindow()).rejects.toThrow('Ambiguous');
  });
  it('honors explicit local hostname before metadata preference removes legacy candidate', async () => {
    const fetchFn = vi.fn<typeof fetch>(async input => new Response(JSON.stringify(String(input).includes('/events?') ? events : {
      remote: bucket('remote', 'REMOTE'),
      'aw-watcher-window_LOCAL': { id: 'aw-watcher-window_LOCAL', hostname: 'LOCAL' },
    })));
    const source = new ActivityWatchAdapter({ fetchFn, now: () => now, hostname: 'LOCAL' });
    expect((await source.discoverWindowBucket()).bucket.id).toBe('aw-watcher-window_LOCAL');
  });
  it('retains recency when newest machine event is missing app rather than using older remote app', async () => {
    const fetchFn = vi.fn<typeof fetch>(async input => new Response(JSON.stringify(String(input).includes('/events?')
      ? String(input).includes('/local/') ? [{ ...events[0], data: {} }]
        : [{ ...events[0], duration: 5, data: { app: 'Remote Notepad' } }]
      : { local: bucket('local', 'LOCAL'), remote: bucket('remote', 'REMOTE') })));
    const source = new ActivityWatchAdapter({ fetchFn, now: () => now });
    expect((await source.discoverWindowBucket()).bucket.id).toBe('local');
    expect(await source.getCurrentWindow()).toBeNull();
  });
  it('rejects malformed server JSON safely', async () => {
    const source = new ActivityWatchAdapter({ fetchFn: async () => new Response('private invalid response') });
    expect(await source.isAvailable()).toBe(false);
    await expect(source.getCurrentWindow()).rejects.toThrow('Invalid ActivityWatch JSON');
  });
  it('reports server errors without raw response details', async () => {
    const source = new ActivityWatchAdapter({ fetchFn: async () => new Response('private response', { status: 500 }) });
    expect(await source.isAvailable()).toBe(false);
    await expect(source.getCurrentWindow()).rejects.toThrow('HTTP 500');
  });
  it('handles unavailable server without leaking raw error', async () => {
    const source = new ActivityWatchAdapter({ fetchFn: async () => { throw Error('fictional private network detail'); } });
    expect(await source.isAvailable()).toBe(false);
    await expect(source.getCurrentWindow()).rejects.toThrow('ActivityWatch not available');
  });
  it('times out even when fetch ignores abort; aborts signal and cleans timer', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    const source = new ActivityWatchAdapter({ fetchFn: (_url, init) => { signal = init?.signal; return new Promise(() => {}); } });
    const pending = source.getCurrentWindow();
    const assertion = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(4000);
    await assertion;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('timeout covers response body consumption', async () => {
    vi.useFakeTimers();
    const response = new Response('{}');
    vi.spyOn(response, 'json').mockImplementation(() => new Promise(() => {}));
    const source = new ActivityWatchAdapter({ fetchFn: async () => response });
    const assertion = expect(source.getCurrentWindow()).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(4000); await assertion;
  });
  it('supports stop/unload cancellation and never fetches with pre-aborted signal', async () => {
    const fetchFn = vi.fn<typeof fetch>(() => new Promise(() => {}));
    const source = new ActivityWatchAdapter({ fetchFn });
    const controller = new AbortController();
    const assertion = expect(source.getCurrentWindow(controller.signal)).rejects.toThrow('cancelled');
    controller.abort(); await assertion;
    await expect(source.getCurrentWindow(controller.signal)).rejects.toThrow('cancelled');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
