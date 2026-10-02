import { describe, expect, it, vi } from 'vitest';
import { SuperProductivityAdapter } from '../src/adapters/super-productivity-adapter';

describe('Super Productivity adapter', () => {
  it('reads task summaries without leaking unrelated fields or mutating tasks', async () => {
    const tasks = Object.freeze([Object.freeze({ id: 'fictional-1', title: 'Study', notes: 'fictional private content', timeEstimate: 0, timeSpent: 0, isDone: false, projectId: null, tagIds: [], created: 0, subTaskIds: [] })]);
    const host = new SuperProductivityAdapter({ getTasks: async () => tasks });
    expect(await host.listTasks()).toEqual([{ id: 'fictional-1', title: 'Study' }]);
  });
  it('only creates the fixed probe when explicitly called and converts returned ID', async () => {
    const addTask = vi.fn().mockResolvedValue('probe-id');
    const host = new SuperProductivityAdapter({ addTask });
    expect(addTask).not.toHaveBeenCalled();
    expect(await host.createProbeTask()).toEqual({ id: 'probe-id', title: '[StudyFlow PoC] Plugin API probe' });
    expect(addTask).toHaveBeenCalledExactlyOnceWith({ title: '[StudyFlow PoC] Plugin API probe' });
  });
  it('passes official notification and snack object shapes', async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const showSnack = vi.fn();
    const host = new SuperProductivityAdapter({ notify, showSnack });
    await host.notify('Focus test', 'App: Fictional; Remaining: 09:59');
    await host.feedback('API checked');
    expect(notify).toHaveBeenCalledWith({ title: 'Focus test', body: 'App: Fictional; Remaining: 09:59' });
    expect(showSnack).toHaveBeenCalledWith({ msg: 'API checked', type: 'INFO' });
  });
  it('preserves method receiver', async () => {
    const api = { token: true, getTasks() { if (!this.token) throw Error(); return Promise.resolve([]); } };
    expect(await new SuperProductivityAdapter(api).listTasks()).toEqual([]);
  });
  it.each(['listTasks', 'createProbeTask', 'notify', 'feedback'] as const)('gracefully rejects missing API for %s', async method => {
    const host = new SuperProductivityAdapter(null);
    const call = { listTasks: () => host.listTasks(), createProbeTask: () => host.createProbeTask(), notify: () => host.notify('title', 'body'), feedback: () => host.feedback('checked') };
    await expect(call[method]()).rejects.toThrow('StudyFlow compatibility error');
  });
  it('redacts raw host errors', async () => {
    const host = new SuperProductivityAdapter({ getTasks: async () => { throw Error('fictional private task details'); } });
    await expect(host.listTasks()).rejects.toThrow('StudyFlow compatibility error: getTasks failed.');
  });
  it.each([null, [{}], [{ id: 1, title: 'bad' }]].map(result => ({ result })))('validates host task result', async ({ result }) => {
    await expect(new SuperProductivityAdapter({ getTasks: async () => result }).listTasks()).rejects.toThrow('compatibility error');
  });
  it('rejects malformed addTask result without retrying writes', async () => {
    const addTask = vi.fn().mockResolvedValue({ id: 'wrong-shape' });
    await expect(new SuperProductivityAdapter({ addTask }).createProbeTask()).rejects.toThrow('compatibility error');
    expect(addTask).toHaveBeenCalledTimes(1);
  });
});
