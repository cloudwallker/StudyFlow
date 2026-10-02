import { expect, it } from 'vitest';
import { detectCapabilities } from '../src/compat/capabilities';

const api = { getTasks() {}, addTask() {}, notify() {}, showSnack() {} };
it('detects all called host capabilities', () => {
  expect(detectCapabilities(api)).toEqual({ getTasks: true, addTask: true, notify: true, showSnack: true });
});
it.each(['getTasks', 'addTask', 'notify', 'showSnack'])('disables missing/non-function %s independently', key => {
  expect(detectCapabilities({ ...api, [key]: undefined })[key as keyof typeof api]).toBe(false);
  expect(detectCapabilities({ ...api, [key]: 'function' })[key as keyof typeof api]).toBe(false);
});
it.each([null, undefined, 1])('handles absent host %s', api => {
  expect(Object.values(detectCapabilities(api))).toEqual([false, false, false, false]);
});
