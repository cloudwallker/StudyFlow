import { expect, it } from 'vitest';
import { prepareQuit } from '../src/desktop/lifecycle';
import { DesktopStudy } from '../src/desktop/study';

it('keeps a failed final checkpoint available until ordinary quit can persist it', () => {
  let fail = false; let id = 0;
  const study = new DesktopStudy({ clock: { read: () => ({ wallMs: 0, monotonicMs: 0, utcOffsetMinutes: 0 }) },
    makeId: () => String(++id), sampler: { sample: async () => ({ status: 'unknown', app: null, idleMs: null }) },
    notify: async () => {}, dismiss: () => {}, credit: () => {}, checkpoint: () => { if (fail) throw new Error('disk'); } });
  study.start(null, 25, []); fail = true;
  expect(prepareQuit(study)).toBe(false);
  expect(study.state().running).toBe(true);
  fail = false; expect(prepareQuit(study)).toBe(true);
  expect(study.state().running).toBe(false);
});
