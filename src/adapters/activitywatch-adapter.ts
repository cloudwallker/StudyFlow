import { CONFIG } from '../config/constants';
import { ActivityWatchError, freshWindow, isFreshEventEnd, isRecord, parseWindowSample, selectWindowBucket, windowBuckets, type ActiveWindow, type WindowCandidate } from './activitywatch-parsing';

export interface ActivitySource {
  isAvailable(signal?: AbortSignal): Promise<boolean>;
  getCurrentWindow(signal?: AbortSignal): Promise<ActiveWindow | null>;
}

export interface ActivityWatchOptions {
  fetchFn?: typeof fetch;
  now?: () => number;
  hostname?: string;
}

export class ActivityWatchAdapter implements ActivitySource {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly hostname: string;

  constructor(options: ActivityWatchOptions = {}) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? Date.now;
    this.hostname = options.hostname?.trim() ?? '';
  }

  private async getJson(path: string, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new ActivityWatchError('ActivityWatch request cancelled.');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel = () => {};
    const interrupted = new Promise<never>((_resolve, reject) => {
      cancel = () => { reject(new ActivityWatchError('ActivityWatch request cancelled.')); controller.abort(); };
      signal?.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(() => {
        reject(new ActivityWatchError('ActivityWatch request timed out.'));
        controller.abort();
      }, CONFIG.requestTimeoutMs);
    });
    const request = async (): Promise<unknown> => {
      // Native browser fetch rejects an adapter instance as its receiver.
      const fetchFn = this.fetchFn;
      const response = await fetchFn(`${CONFIG.activityWatchUrl}${path}`, {
        method: 'GET', signal: controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store',
      });
      if (!response.ok) throw new ActivityWatchError(`ActivityWatch HTTP ${response.status}.`);
      try { return await response.json(); }
      catch { throw new ActivityWatchError('Invalid ActivityWatch JSON.'); }
    };
    try { return await Promise.race([request(), interrupted]); }
    catch (error) {
      if (error instanceof ActivityWatchError) throw error;
      throw new ActivityWatchError('ActivityWatch not available. Start ActivityWatch to enable Focus Guard.');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  }

  async isAvailable(signal?: AbortSignal): Promise<boolean> {
    try { return isRecord(await this.getJson('/api/0/buckets/', signal)); }
    catch { return false; }
  }

  async discoverWindowBucket(signal?: AbortSignal): Promise<WindowCandidate> {
    const buckets = windowBuckets(await this.getJson('/api/0/buckets/', signal), this.hostname);
    // Fail the sample if any candidate cannot be compared; never silently choose another machine.
    const candidates: WindowCandidate[] = [];
    for (const bucket of buckets) {
      const events = await this.getJson(`/api/0/buckets/${encodeURIComponent(bucket.id)}/events?limit=1`, signal);
      const sample = parseWindowSample(events);
      const now = this.now();
      candidates.push({
        bucket, window: freshWindow(sample.window, now),
        lastEventEnd: sample.lastEventEnd !== null && isFreshEventEnd(sample.lastEventEnd, now) ? sample.lastEventEnd : null,
      });
    }
    return selectWindowBucket(candidates, this.hostname);
  }

  async getCurrentWindow(signal?: AbortSignal): Promise<ActiveWindow | null> {
    return freshWindow((await this.discoverWindowBucket(signal)).window, this.now());
  }
}
