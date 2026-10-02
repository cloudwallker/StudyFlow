import { mountPlugin } from './plugin';

mountPlugin(document, Reflect.get(window, 'PluginAPI'));
