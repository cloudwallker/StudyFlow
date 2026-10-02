import { CONFIG } from '../config/constants';

export interface ActiveWindow {
  app: string;
  timestamp: string;
  durationSeconds: number;
}

export interface WindowBucket {
  id: string;
  hostname: string;
}

export class ActivityWatchError extends Error {}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(): never {
  throw new ActivityWatchError('Invalid ActivityWatch response.');
}

export function windowBuckets(json: unknown, hostname = ''): WindowBucket[] {
  if (!isRecord(json)) invalid();
  const primary: WindowBucket[] = [];
  const fallback: WindowBucket[] = [];
  for (const [id, value] of Object.entries(json)) {
    if (!id || !isRecord(value) || (value.id !== undefined && value.id !== id)) invalid();
    for (const key of ['type', 'client', 'hostname']) {
      if (value[key] !== undefined && typeof value[key] !== 'string') invalid();
    }
    const bucket = { id, hostname: typeof value.hostname === 'string' ? value.hostname : '' };
    if (hostname.trim() && bucket.hostname.toLowerCase() !== hostname.trim().toLowerCase()) continue;
    if (value.type === 'currentwindow' || (!value.type && value.client === 'aw-watcher-window')) {
      primary.push(bucket);
    } else if (!value.type && id.startsWith('aw-watcher-window_')) {
      fallback.push(bucket);
    }
  }
  const result = primary.length ? primary : fallback;
  if (!result.length) throw new ActivityWatchError(hostname.trim() ? 'Window watcher for the specified hostname was not found.' : 'Window watcher data was not found.');
  return result;
}

export function eventEnd(window: ActiveWindow): number {
  return Date.parse(window.timestamp) + window.durationSeconds * 1000;
}

export function parseWindowEvents(json: unknown): ActiveWindow | null {
  return parseWindowSample(json).window;
}

export function parseWindowSample(json: unknown): { window: ActiveWindow | null; lastEventEnd: number | null } {
  if (!Array.isArray(json)) invalid();
  let newest: ActiveWindow | null = null;
  let latestEnd = -Infinity;
  for (const value of json) {
    if (!isRecord(value) || !isRecord(value.data) || typeof value.timestamp !== 'string'
      || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value.timestamp)
      || !Number.isFinite(Date.parse(value.timestamp))
      || typeof value.duration !== 'number' || !Number.isFinite(value.duration) || value.duration < 0) invalid();
    const app = value.data.app;
    if (app !== undefined && typeof app !== 'string') invalid();
    const end = Date.parse(value.timestamp) + value.duration * 1000;
    if (!Number.isFinite(end)) invalid();
    if (end > latestEnd) {
      latestEnd = end;
      newest = typeof app === 'string' && app.trim()
        ? { app: app.trim(), timestamp: value.timestamp, durationSeconds: value.duration }
        : null;
    }
  }
  return { window: newest, lastEventEnd: latestEnd === -Infinity ? null : latestEnd };
}

export function isFreshEventEnd(end: number, now: number): boolean {
  return now - end <= CONFIG.maxEventAgeMs && end - now <= CONFIG.futureToleranceMs;
}

export function freshWindow(window: ActiveWindow | null, now: number): ActiveWindow | null {
  if (!window) return null;
  const end = eventEnd(window);
  return isFreshEventEnd(end, now) ? window : null;
}

export interface WindowCandidate {
  bucket: WindowBucket;
  window: ActiveWindow | null;
  lastEventEnd?: number | null;
}

export function selectWindowBucket(candidates: WindowCandidate[], hostname = ''): WindowCandidate {
  const wanted = hostname.trim().toLowerCase();
  const pool = wanted ? candidates.filter(c => c.bucket.hostname.toLowerCase() === wanted) : candidates;
  if (!pool.length) throw new ActivityWatchError('Window watcher for the specified hostname was not found.');
  if (pool.length === 1) return pool[0]!;
  const recency = (candidate: WindowCandidate) => candidate.lastEventEnd ?? (candidate.window ? eventEnd(candidate.window) : -Infinity);
  const ranked = [...pool].sort((a, b) => recency(b) - recency(a));
  const first = ranked[0]!;
  const second = ranked[1]!;
  if (recency(first) === -Infinity || recency(first) === recency(second)) {
    throw new ActivityWatchError('Ambiguous window watchers. Specify the current Windows hostname.');
  }
  return first;
}
