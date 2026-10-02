import { describe, expect, it } from 'vitest';
import { parseWindowEvents, windowBuckets, selectWindowBucket, freshWindow } from '../src/adapters/activitywatch-parsing';

const stamp = '2026-01-01T00:00:00Z';
const event = { id: 1, timestamp: stamp, duration: 10, data: { app: 'Code.exe', title: 'Fictional study notes' } };
const meta = (id: string, hostname = 'fictional-pc') => ({ id, type: 'currentwindow', client: 'aw-watcher-window', hostname, created: stamp });

describe('ActivityWatch parsing', () => {
  it('validates and strips window title', () => {
    expect(parseWindowEvents([event])).toEqual({ app: 'Code.exe', timestamp: stamp, durationSeconds: 10 });
  });
  it.each([[], [{ ...event, data: {} }], [{ ...event, data: { app: '  ' } }]].map(data => ({ data })))('returns null without app/event', ({ data }) => {
    expect(parseWindowEvents(data)).toBeNull();
  });
  it.each([null, {}, [null], [{ ...event, timestamp: 'bad' }], [{ ...event, duration: -1 }], [{ ...event, data: { app: 2 } }]].map(data => ({ data })))('rejects invalid shape', ({ data }) => {
    expect(() => parseWindowEvents(data)).toThrow('Invalid ActivityWatch');
  });
  it('uses latest event end time, not array order or start alone', () => {
    expect(parseWindowEvents([{ ...event, duration: 30 }, { ...event, timestamp: '2026-01-01T00:00:20Z', duration: 1, data: { app: 'Other' } }])?.app).toBe('Code.exe');
  });
  it('does not revive previous app if newest event has no app', () => {
    expect(parseWindowEvents([event, { ...event, duration: 20, data: {} }])).toBeNull();
  });
  it('freshness uses event end and rejects stale/future events', () => {
    const window = parseWindowEvents([event]);
    expect(freshWindow(window, Date.parse(stamp) + 25000)).toEqual(window);
    expect(freshWindow(window, Date.parse(stamp) + 25001)).toBeNull();
    expect(freshWindow(window, Date.parse(stamp) - 10000)).toBeNull();
  });
});

describe('window bucket discovery', () => {
  it('prefers metadata over legacy id prefix and ignores AFK', () => {
    expect(windowBuckets({ custom: meta('custom'), 'aw-watcher-window_old': { id: 'aw-watcher-window_old' }, afk: { id: 'afk', type: 'afkstatus' } }).map(x => x.id)).toEqual(['custom']);
  });
  it('uses verified prefix only without contradictory type', () => {
    expect(windowBuckets({ 'aw-watcher-window_old': { id: 'aw-watcher-window_old' }, 'aw-watcher-window_fake': { type: 'afkstatus' } }).map(x => x.id)).toEqual(['aw-watcher-window_old']);
  });
  it('reports no window bucket', () => {
    expect(() => windowBuckets({ afk: { type: 'afkstatus' } })).toThrow('Window watcher data was not found');
  });
  it.each([null, [], { x: null }, { x: { id: 'mismatch', type: 'currentwindow' } }].map(data => ({ data })))('rejects malformed metadata', ({ data }) => {
    expect(() => windowBuckets(data)).toThrow('Invalid ActivityWatch');
  });
  it('selects local hostname first, otherwise uniquely most recent candidate', () => {
    const buckets = windowBuckets({ a: meta('a', 'LOCAL'), b: meta('b', 'remote') });
    const candidates = buckets.map((bucket, index) => ({ bucket, window: parseWindowEvents([{ ...event, duration: index + 1 }]) }));
    expect(selectWindowBucket(candidates, ' local ').bucket.id).toBe('a');
    expect(selectWindowBucket(candidates).bucket.id).toBe('b');
    expect(() => selectWindowBucket(candidates, 'unknown')).toThrow('hostname');
  });
  it('does not randomly select tied or empty multiple buckets', () => {
    const buckets = windowBuckets({ a: meta('a'), b: meta('b') });
    expect(() => selectWindowBucket(buckets.map(bucket => ({ bucket, window: null })))).toThrow('Ambiguous');
    expect(() => selectWindowBucket(buckets.map(bucket => ({ bucket, window: parseWindowEvents([event]) })))).toThrow('Ambiguous');
    expect(selectWindowBucket([{ bucket: buckets[0]!, window: null }]).window).toBeNull();
  });
});
