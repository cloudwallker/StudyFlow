// Official upstream PluginAPI lifecycle at b6ef6255c422ed96917d47ec9ccd0fb835a4fbc9.
// Published plugin-api 1.0.1 omits these optional extensions; no host internals used.
interface OfficialLifecycle {
  onReady(fn: () => void | Promise<void>): void;
  onUnload(fn: () => void | Promise<void>): void;
}

function hasLifecycle<K extends keyof OfficialLifecycle>(api: unknown, key: K): api is Pick<OfficialLifecycle, K> {
  return typeof api === 'object' && api !== null && key in api && typeof Reflect.get(api, key) === 'function';
}

export function attachLifecycle(api: unknown, ready: () => void, dispose: () => void): void {
  if (hasLifecycle(api, 'onUnload')) api.onUnload(dispose);
  // For old iframe hosts, UI navigation occurs after host initialization.
  // Frame destruction/pagehide supplies cleanup independently of optional hooks.
  if (hasLifecycle(api, 'onReady')) api.onReady(ready);
  else ready();
}
