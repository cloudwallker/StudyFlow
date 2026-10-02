import type { PluginAPI } from '@super-productivity/plugin-api';

export type Capability = 'getTasks' | 'addTask' | 'notify' | 'showSnack';
export type Capabilities = Record<Capability, boolean>;

export function hasMethod<K extends Capability>(api: unknown, key: K): api is Pick<PluginAPI, K> {
  return typeof api === 'object' && api !== null && key in api && typeof Reflect.get(api, key) === 'function';
}

export function detectCapabilities(api: unknown): Capabilities {
  return {
    getTasks: hasMethod(api, 'getTasks'),
    addTask: hasMethod(api, 'addTask'),
    notify: hasMethod(api, 'notify'),
    showSnack: hasMethod(api, 'showSnack'),
  };
}
