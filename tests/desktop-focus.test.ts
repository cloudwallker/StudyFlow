import { expect, it } from 'vitest';
import { DesktopFocus } from '../src/desktop/focus';

function setup() {
  let time = 1000; let app: string | null = 'Code.exe';
  const notices: string[] = []; const credits: number[] = [];
  const focus = new DesktopFocus({
    sample: async () => app, notify: async body => { notices.push(body); },
    credit: (_id, ms) => { credits.push(ms); }, now: () => time,
  });
  return { focus, notices, credits, advance: (ms: number) => { time += ms; }, app: (value: string | null) => { app = value; } };
}
it('applies whitelist and global cooldown without resetting it on allowed samples', async () => {
  const s = setup(); s.focus.start('task', 25, ['code.exe']);
  await s.focus.tick(); expect(s.notices).toHaveLength(0);
  s.app('Game.exe'); await s.focus.tick(); expect(s.notices).toHaveLength(1);
  s.advance(30000); s.app('Code.exe'); await s.focus.tick();
  s.app('Game.exe'); await s.focus.tick(); expect(s.notices).toHaveLength(1);
  s.advance(30000); await s.focus.tick(); expect(s.notices).toHaveLength(2);
});
it('finishes on the monotonic deadline and credits only once', async () => {
  const s = setup(); s.focus.start('task', 1, []); s.advance(61000);
  await s.focus.tick(); s.focus.stop();
  expect(s.focus.state().running).toBe(false);
  expect(s.credits).toEqual([60000]);
});
it('dismisses a visible reminder on returning to an allowed app, unknown app, or stopping', async () => {
  let app: string | null = 'Game.exe'; let visible = false;
  const dependencies = {
    sample: async () => app, notify: async () => { visible = true; },
    dismiss: () => { visible = false; }, credit: () => {}, now: () => 1000,
  };
  const focus = new DesktopFocus(dependencies);
  for (const next of [' CODE.EXE ', null, 'stop']) {
    app = 'Game.exe'; focus.start(null, 25, ['code.exe']); await focus.tick();
    expect(visible).toBe(true);
    if (next === 'stop') focus.stop();
    else { app = next; await focus.tick(); }
    expect(visible).toBe(false);
    focus.stop();
  }
});
it('drops old asynchronous samples after stop and never overlaps sampling', async () => {
  let resolve!: (app: string) => void; let calls = 0; let notifications = 0;
  const focus = new DesktopFocus({ sample: () => { calls++; return new Promise(r => { resolve = r; }); },
    notify: async () => { notifications++; }, credit: () => {}, now: () => 1000 });
  focus.start(null, 25, []);
  const pending = focus.tick(); await focus.tick(); expect(calls).toBe(1);
  focus.stop(); resolve('Game.exe'); await pending;
  expect(notifications).toBe(0); expect(focus.state().app).toBeNull();
});
it('interrupts on power events and prevents repeat accounting', () => {
  const s = setup(); s.focus.start('task', 25, []); s.advance(10000);
  s.focus.interrupt('电脑已锁屏'); s.advance(900000); s.focus.interrupt('休眠');
  expect(s.credits).toEqual([10000]); expect(s.focus.state().running).toBe(false);
});
it('reserves cooldown after a failed notification and clears unknown samples', async () => {
  let count = 0;
  const focus = new DesktopFocus({ sample: async () => 'Game.exe', now: () => 1000,
    notify: async () => { count++; throw new Error('private'); }, credit: () => {} });
  focus.start(null, 25, []); await focus.tick(); await focus.tick();
  expect(count).toBe(1); expect(focus.state().notification).toBe('failed');
  expect(JSON.stringify(focus.state())).not.toContain('private');
});
it('does not credit a long unobserved gap as productive focus', async () => {
  const s = setup(); s.focus.start('task', 25, []); await s.focus.tick();
  s.advance(120000); await s.focus.tick();
  expect(s.focus.state().running).toBe(false); expect(s.credits).toEqual([0]);
});
it.each(['stop', 'resume'] as const)('clamps unobserved gaps when %s happens before the timer tick', async operation => {
  const s = setup(); s.focus.start('task', 25, []); await s.focus.tick();
  s.advance(120000);
  if (operation === 'stop') s.focus.stop(); else s.focus.interrupt('电脑已唤醒');
  expect(s.credits).toEqual([0]);
});
