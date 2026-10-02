import { readFileSync } from 'node:fs';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';

export const AMBIENT_AUDIO_CHANNEL = 'studyflow:ambient-audio';
export const ambientNoiseKinds = ['white', 'pink', 'brown'] as const;
export type AmbientNoiseKind = typeof ambientNoiseKinds[number];
export type AmbientStatus = 'stopped' | 'playing' | 'paused';
export type AmbientPublicSource =
  | { type: 'noise'; kind: AmbientNoiseKind }
  | { type: 'file'; name: string };
export type AmbientState = {
  status: AmbientStatus;
  source: AmbientPublicSource;
  volume: number;
  loop: boolean;
  followFocus: boolean;
  message: string | null;
};

export type AmbientSettings = {
  noiseKind: AmbientNoiseKind;
  volume: number;
  loop: boolean;
  followFocus: boolean;
};

const DEFAULT_AMBIENT_SETTINGS: AmbientSettings = { noiseKind: 'white', volume: 35, loop: true, followFocus: false };

function ambientSettings(value: unknown): AmbientSettings {
  const input = record(value);
  exactKeys(input, ['schemaVersion', 'noiseKind', 'volume', 'loop', 'followFocus']);
  if (input.schemaVersion !== 1 || typeof input.noiseKind !== 'string' || !ambientNoiseKinds.includes(input.noiseKind as AmbientNoiseKind)
    || !Number.isSafeInteger(input.volume) || (input.volume as number) < 0 || (input.volume as number) > 100
    || typeof input.loop !== 'boolean' || typeof input.followFocus !== 'boolean') throw new Error('无效的环境声音设置');
  return { noiseKind: input.noiseKind as AmbientNoiseKind, volume: input.volume as number, loop: input.loop, followFocus: input.followFocus };
}

export class AmbientSettingsFile {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly path: string) {}
  load(): AmbientSettings {
    try {
      const source = readFileSync(this.path, 'utf8');
      if (source.length > 4096) return { ...DEFAULT_AMBIENT_SETTINGS };
      return ambientSettings(JSON.parse(source));
    } catch { return { ...DEFAULT_AMBIENT_SETTINGS }; }
  }
  save(settings: AmbientSettings): Promise<void> {
    const source = JSON.stringify({ schemaVersion: 1, ...settings });
    const temporary = `${this.path}.tmp`;
    const operation = this.queue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(temporary, source, { encoding: 'utf8' });
      await rename(temporary, this.path);
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}

type AmbientPrivateSource =
  | { type: 'noise'; kind: AmbientNoiseKind }
  | { type: 'file'; path: string; name: string };

export type AmbientEngineCommand =
  | { action: 'set-source'; generation: number; source: AmbientPrivateSource }
  | { action: 'play'; generation: number; source: AmbientPrivateSource; volume: number; loop: boolean; resume: boolean }
  | { action: 'pause'; generation: number }
  | { action: 'stop'; generation: number }
  | { action: 'set-volume'; generation: number; volume: number }
  | { action: 'set-loop'; generation: number; loop: boolean }
  | { action: 'set-follow-focus'; generation: number; enabled: boolean };

export type AmbientEngineEvent =
  | { type: 'ended'; generation: number }
  | { type: 'failed'; generation: number };

export interface AmbientPlaybackEngine {
  setEventListener?(listener: (event: AmbientEngineEvent) => void): void;
  apply(command: AmbientEngineCommand): Promise<void>;
  dispose(): Promise<void>;
}

export type AmbientAudioCommand =
  | 'snapshot'
  | 'selectFile'
  | 'setNoise'
  | 'setVolume'
  | 'setLoop'
  | 'setFollowFocus'
  | 'play'
  | 'pause'
  | 'stop';

export type AmbientAudioReply =
  | { ok: true; value: AmbientState }
  | { ok: false; value: AmbientState; error: string };

export type ParsedAmbientAudioRequest =
  | { command: 'snapshot' | 'selectFile' | 'play' | 'pause' | 'stop' }
  | { command: 'setNoise'; payload: { kind: AmbientNoiseKind } }
  | { command: 'setVolume'; payload: { volume: number } }
  | { command: 'setLoop'; payload: { loop: boolean } }
  | { command: 'setFollowFocus'; payload: { enabled: boolean } };

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('无效的环境声音请求');
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some(key => !expected.includes(key))) throw new Error('无效的环境声音请求');
}

export function parseAmbientAudioRequest(command: unknown, payload?: unknown): ParsedAmbientAudioRequest {
  if (typeof command !== 'string') throw new Error('无效的环境声音命令');
  if (['snapshot', 'selectFile', 'play', 'pause', 'stop'].includes(command)) {
    if (payload !== undefined) throw new Error('该环境声音命令不接受参数');
    return { command: command as 'snapshot' | 'selectFile' | 'play' | 'pause' | 'stop' };
  }
  const input = record(payload);
  if (command === 'setNoise') {
    exactKeys(input, ['kind']);
    if (typeof input.kind !== 'string' || !ambientNoiseKinds.includes(input.kind as AmbientNoiseKind)) throw new Error('无效的噪音类型');
    return { command, payload: { kind: input.kind as AmbientNoiseKind } };
  }
  if (command === 'setVolume') {
    exactKeys(input, ['volume']);
    if (!Number.isSafeInteger(input.volume) || (input.volume as number) < 0 || (input.volume as number) > 100) throw new Error('音量必须是 0 到 100 的整数');
    return { command, payload: { volume: input.volume as number } };
  }
  if (command === 'setLoop') {
    exactKeys(input, ['loop']);
    if (typeof input.loop !== 'boolean') throw new Error('无效的循环设置');
    return { command, payload: { loop: input.loop } };
  }
  if (command === 'setFollowFocus') {
    exactKeys(input, ['enabled']);
    if (typeof input.enabled !== 'boolean') throw new Error('无效的专注联动设置');
    return { command, payload: { enabled: input.enabled } };
  }
  throw new Error('无效的环境声音命令');
}

function publicSource(source: AmbientPrivateSource): AmbientPublicSource {
  return source.type === 'noise' ? { type: 'noise', kind: source.kind } : { type: 'file', name: source.name };
}

function safeFileName(path: string): string {
  return win32.basename(path).replace(/[\u0000-\u001f\u007f]/g, '�').slice(0, 260);
}

function validSelectedPath(path: string): boolean {
  if (!/^[A-Za-z]:\\/.test(path) || path.length > 32767 || /[\u0000-\u001f]/.test(path) || path.slice(2).includes(':')) return false;
  const extension = win32.extname(path).toLocaleLowerCase('en-US');
  return extension === '.wav' || extension === '.mp3';
}

export class AmbientAudioController {
  private source: AmbientPrivateSource = { type: 'noise', kind: 'white' };
  private noiseKind: AmbientNoiseKind = 'white';
  private status: AmbientStatus = 'stopped';
  private volume = 35;
  private loop = true;
  private followFocus = false;
  private focusActive = false;
  private message: string | null = null;
  private generation = 0;
  private selectionRevision = 0;
  private disposed = false;

  constructor(private readonly dependencies: {
    engine: AmbientPlaybackEngine;
    chooseFile(): Promise<{ canceled: boolean; filePaths: string[] }>;
    inspectFile(path: string): Promise<boolean>;
    initialSettings?: AmbientSettings;
    saveSettings?(settings: AmbientSettings): Promise<void>;
  }) {
    const settings = dependencies.initialSettings ?? DEFAULT_AMBIENT_SETTINGS;
    this.source = { type: 'noise', kind: settings.noiseKind };
    this.volume = settings.volume;
    this.loop = settings.loop;
    this.followFocus = settings.followFocus;
    dependencies.engine.setEventListener?.(event => {
      if (this.disposed || event.generation !== this.generation || this.status !== 'playing') return;
      this.status = 'stopped';
      this.message = event.type === 'failed' ? '环境声音播放失败，请检查文件或音频设备' : null;
    });
    this.noiseKind = settings.noiseKind;
  }

  snapshot(): AmbientState {
    return {
      status: this.status,
      source: publicSource(this.source),
      volume: this.volume,
      loop: this.loop,
      followFocus: this.followFocus,
      message: this.message,
    };
  }

  private success(): AmbientAudioReply { return { ok: true, value: this.snapshot() }; }
  private failure(message: string): AmbientAudioReply { return { ok: false, value: this.snapshot(), error: message }; }

  private settings(): AmbientSettings {
    return {
      noiseKind: this.noiseKind,
      volume: this.volume,
      loop: this.loop,
      followFocus: this.followFocus,
    };
  }

  private async persist(reply: AmbientAudioReply): Promise<AmbientAudioReply> {
    if (!reply.ok || !this.dependencies.saveSettings) return reply;
    try { await this.dependencies.saveSettings(this.settings()); return reply; }
    catch {
      this.message = '环境声音设置保存失败';
      return this.failure('环境声音设置保存失败');
    }
  }

  private async apply(command: AmbientEngineCommand, failedStatus: AmbientStatus = this.status): Promise<AmbientAudioReply> {
    const expected = command.generation;
    try {
      await this.dependencies.engine.apply(command);
      if (!this.disposed && expected === this.generation) this.message = null;
      return this.success();
    } catch {
      if (!this.disposed && expected === this.generation) {
        this.status = failedStatus;
        this.message = '环境声音播放失败，请检查文件或音频设备';
      }
      return expected === this.generation && !this.disposed
        ? this.failure('环境声音播放失败，请检查文件或音频设备')
        : this.success();
    }
  }

  private async play(): Promise<AmbientAudioReply> {
    const resume = this.status === 'paused';
    this.status = 'playing';
    this.message = null;
    const generation = ++this.generation;
    return this.apply({ action: 'play', generation, source: this.source, volume: this.volume, loop: this.loop, resume }, 'stopped');
  }

  private async pause(): Promise<AmbientAudioReply> {
    this.status = 'paused';
    this.message = null;
    const generation = ++this.generation;
    return this.apply({ action: 'pause', generation }, 'stopped');
  }

  private async stop(): Promise<AmbientAudioReply> {
    this.status = 'stopped';
    this.message = null;
    const generation = ++this.generation;
    return this.apply({ action: 'stop', generation }, 'stopped');
  }

  async execute(command: unknown, payload?: unknown): Promise<AmbientAudioReply> {
    if (this.disposed) return this.failure('环境声音服务已关闭');
    let request: ParsedAmbientAudioRequest;
    try { request = parseAmbientAudioRequest(command, payload); }
    catch { return this.failure('无效的环境声音请求'); }
    if (request.command === 'snapshot') return this.success();
    if (request.command === 'play') return this.play();
    if (request.command === 'pause') return this.pause();
    if (request.command === 'stop') return this.stop();
    if (request.command === 'selectFile') {
      const selectionRevision = ++this.selectionRevision;
      const playbackGeneration = this.generation;
      const selectionIsCurrent = () => !this.disposed && selectionRevision === this.selectionRevision && playbackGeneration === this.generation;
      let result: { canceled: boolean; filePaths: string[] };
      try { result = await this.dependencies.chooseFile(); }
      catch { return selectionIsCurrent() ? this.failure('无法打开本地音乐选择器') : this.success(); }
      if (!selectionIsCurrent() || result.canceled) return this.success();
      if (result.filePaths.length !== 1 || !validSelectedPath(result.filePaths[0]!)) return this.failure('请选择 WAV 或 MP3 音频文件');
      const selectedPath = result.filePaths[0]!;
      let isFile = false;
      try { isFile = await this.dependencies.inspectFile(selectedPath); }
      catch { isFile = false; }
      if (!selectionIsCurrent()) return this.success();
      if (!isFile) return this.failure('所选本地音乐文件不可读取');
      const name = safeFileName(selectedPath);
      if (!name) return this.failure('所选本地音乐文件无效');
      this.source = { type: 'file', path: selectedPath, name };
      this.status = 'stopped';
      this.message = null;
      return this.apply({ action: 'set-source', generation: ++this.generation, source: this.source }, 'stopped');
    }
    if (request.command === 'setNoise') {
      this.noiseKind = request.payload.kind;
      this.source = { type: 'noise', kind: request.payload.kind };
      this.status = 'stopped';
      this.message = null;
      const generation = ++this.generation;
      return this.persist(await this.apply({ action: 'set-source', generation, source: this.source }, 'stopped'));
    }
    if (request.command === 'setVolume') {
      this.volume = request.payload.volume;
      return this.persist(await this.apply({ action: 'set-volume', generation: this.generation, volume: this.volume }));
    }
    if (request.command === 'setLoop') {
      this.loop = request.payload.loop;
      return this.persist(await this.apply({ action: 'set-loop', generation: this.generation, loop: this.loop }));
    }
    if (request.command === 'setFollowFocus') {
      this.followFocus = request.payload.enabled;
      const linked = await this.persist(await this.apply({ action: 'set-follow-focus', generation: this.generation, enabled: this.followFocus }));
      if (!linked.ok || !this.followFocus) return linked;
      return this.focusActive ? this.play() : this.status === 'playing' ? this.pause() : linked;
    }
    return this.failure('无效的环境声音请求');
  }

  async setFocusActive(active: boolean): Promise<AmbientAudioReply> {
    if (this.disposed) return this.failure('环境声音服务已关闭');
    if (active === this.focusActive) return this.success();
    this.focusActive = active;
    if (!this.followFocus) return this.success();
    return active ? this.play() : this.status === 'playing' ? this.pause() : this.success();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.status = 'stopped';
    this.message = null;
    this.generation++;
    await this.dependencies.engine.dispose();
  }
}

type AmbientIpcMain = {
  handle(channel: string, handler: (event: unknown, command: unknown, payload?: unknown) => unknown): void;
  removeHandler(channel: string): void;
};

export function installAmbientAudioIpc(
  ipcMain: AmbientIpcMain,
  controller: AmbientAudioController,
  trustedSender: (event: unknown) => boolean,
): () => void {
  ipcMain.handle(AMBIENT_AUDIO_CHANNEL, (event, command, payload) => {
    if (!trustedSender(event)) throw new Error('已拒绝未经授权的环境声音请求');
    return controller.execute(command, payload);
  });
  return () => ipcMain.removeHandler(AMBIENT_AUDIO_CHANNEL);
}

type BrowserWindowLike = {
  isDestroyed(): boolean;
  loadFile(path: string): Promise<void>;
  once(event: 'closed', listener: () => void): void;
  destroy(): void;
  webContents: {
    executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
    on?(event: 'ipc-message' | 'render-process-gone', listener: (...args: unknown[]) => void): void;
  };
};

type CreateHiddenWindow = (options: {
  show: false;
  width: number;
  height: number;
  skipTaskbar: true;
  webPreferences: {
    backgroundThrottling: false;
    contextIsolation: true;
    nodeIntegration: false;
    preload: string;
    sandbox: true;
  };
}) => BrowserWindowLike;

const PLAYER_PRELOAD = String.raw`'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('__studyflowAmbientHost', Object.freeze({
  emit(value) {
    if (!value || (value.type !== 'ended' && value.type !== 'failed') || !Number.isSafeInteger(value.generation) || value.generation < 0) return;
    ipcRenderer.send('studyflow:ambient-internal', { type: value.type, generation: value.generation });
  }
}));
`;

const PLAYER_DOCUMENT = String.raw`<!doctype html>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; media-src file:; script-src 'unsafe-inline'">
<title>StudyFlow ambient player</title>
<script>
(() => {
  'use strict';
  let context = null, gain = null, noise = null, audio = null, sourceKey = '', generation = -1, unlistenAudio = null;
  const bindAudioEvents = expectedGeneration => {
    if (unlistenAudio) unlistenAudio();
    const currentAudio = audio;
    const emit = type => {
      if (audio === currentAudio && generation === expectedGeneration) globalThis.__studyflowAmbientHost.emit({ type, generation: expectedGeneration });
    };
    const ended = () => emit('ended'), failed = () => emit('failed');
    currentAudio.addEventListener('ended', ended, { once: true });
    currentAudio.addEventListener('error', failed, { once: true });
    unlistenAudio = () => {
      currentAudio.removeEventListener('ended', ended);
      currentAudio.removeEventListener('error', failed);
      unlistenAudio = null;
    };
  };
  const ensureContext = () => {
    if (!context) { context = new AudioContext(); gain = context.createGain(); gain.connect(context.destination); }
    return context;
  };
  const volume = value => {
    if (gain) gain.gain.value = value / 100;
    if (audio) audio.volume = value / 100;
  };
  const stop = reset => {
    if (reset && unlistenAudio) unlistenAudio();
    if (noise) { try { noise.stop(); } catch {} noise.disconnect(); noise = null; }
    if (audio) { audio.pause(); if (reset) { audio.removeAttribute('src'); audio.load(); audio = null; } }
    if (reset) sourceKey = '';
  };
  const noiseBuffer = kind => {
    const ctx = ensureContext(), length = ctx.sampleRate * 4, buffer = ctx.createBuffer(1, length, ctx.sampleRate), data = buffer.getChannelData(0);
    let brown = 0, pinkSum = 0, pinkCounter = 0;
    const pinkRows = Array.from({ length: 16 }, () => 0);
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      if (kind === 'white') data[i] = white * 0.32;
      else if (kind === 'brown') { brown = Math.max(-1, Math.min(1, (brown + white * 0.02) * 0.995)); data[i] = brown * 0.65; }
      else {
        pinkCounter = (pinkCounter + 1) & 65535;
        let bits = pinkCounter, row = 0;
        while ((bits & 1) === 0 && row < pinkRows.length) {
          pinkSum -= pinkRows[row]; pinkRows[row] = Math.random() * 2 - 1; pinkSum += pinkRows[row];
          bits >>= 1; row++;
        }
        data[i] = ((pinkSum + white) / (pinkRows.length + 1)) * 0.7;
      }
    }
    return buffer;
  };
  globalThis.__studyflowAmbient = async command => {
    if (!command || !Number.isSafeInteger(command.generation) || command.generation < generation) return { ok: true };
    if (['play', 'pause', 'stop', 'set-source'].includes(command.action)) generation = command.generation;
    try {
      if (command.action === 'set-volume') { volume(command.volume); return { ok: true }; }
      if (command.action === 'set-loop') { if (audio) audio.loop = command.loop; return { ok: true }; }
      if (command.action === 'set-follow-focus') return { ok: true };
      if (command.action === 'pause') { if (audio) audio.pause(); if (context && noise) await context.suspend(); return { ok: true }; }
      if (command.action === 'stop' || command.action === 'set-source') { stop(true); return { ok: true }; }
      const key = command.source.type === 'noise' ? 'noise:' + command.source.kind : 'file:' + command.source.url;
      if (command.resume && key === sourceKey) {
        volume(command.volume);
        if (audio) { audio.loop = command.loop; bindAudioEvents(command.generation); await audio.play(); }
        else if (context && noise) await context.resume();
        return { ok: true };
      }
      stop(true); sourceKey = key;
      if (command.source.type === 'noise') {
        const ctx = ensureContext(); noise = ctx.createBufferSource(); noise.buffer = noiseBuffer(command.source.kind); noise.loop = true; noise.connect(gain); volume(command.volume); noise.start(); await ctx.resume();
      } else {
        audio = new Audio(); audio.preload = 'auto'; audio.loop = command.loop; audio.volume = command.volume / 100;
        bindAudioEvents(command.generation);
        audio.src = command.source.url; await audio.play();
      }
      return { ok: true };
    } catch { if (command.generation === generation) stop(true); return { ok: false }; }
  };
})();
</script>`;

export class HiddenBrowserAmbientEngine implements AmbientPlaybackEngine {
  private window: BrowserWindowLike | null = null;
  private opening: Promise<BrowserWindowLike> | null = null;
  private disposed = false;
  private listener: ((event: AmbientEngineEvent) => void) | null = null;
  private lastGeneration = 0;
  private readonly pendingCancellations = new Set<() => void>();

  constructor(private readonly createWindow: CreateHiddenWindow, private readonly playerFile: string) {}

  setEventListener(listener: (event: AmbientEngineEvent) => void): void { this.listener = listener; }

  private async bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel!: () => void;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          cancel = () => reject(new Error('环境声音请求已取消'));
          this.pendingCancellations.add(cancel);
          timer = setTimeout(() => reject(new Error('环境声音播放器响应超时')), timeoutMs);
        }),
      ]);
    } finally { clearTimeout(timer); this.pendingCancellations.delete(cancel); }
  }

  private async open(): Promise<BrowserWindowLike> {
    if (this.disposed) throw new Error('环境声音引擎已关闭');
    if (this.window && !this.window.isDestroyed()) return this.window;
    if (this.opening) return this.opening;
    this.opening = (async () => {
      await mkdir(dirname(this.playerFile), { recursive: true });
      await writeFile(this.playerFile, PLAYER_DOCUMENT, { encoding: 'utf8' });
      const preloadFile = join(dirname(this.playerFile), 'ambient-player-preload.cjs');
      await writeFile(preloadFile, PLAYER_PRELOAD, { encoding: 'utf8' });
      if (this.disposed) throw new Error('环境声音引擎已关闭');
      const window = this.createWindow({
        show: false,
        width: 1,
        height: 1,
        skipTaskbar: true,
        webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, preload: preloadFile, sandbox: true },
      });
      this.window = window;
      window.once('closed', () => {
        if (this.window !== window) return;
        this.window = null;
        if (!this.disposed) this.listener?.({ type: 'failed', generation: this.lastGeneration });
      });
      window.webContents.on?.('render-process-gone', () => {
        if (!this.disposed && this.window === window) this.listener?.({ type: 'failed', generation: this.lastGeneration });
      });
      window.webContents.on?.('ipc-message', (...args: unknown[]) => {
        const channel = args[1]; const payload = args[2];
        if (channel !== 'studyflow:ambient-internal' || typeof payload !== 'object' || payload === null || Array.isArray(payload)) return;
        const value = payload as Record<string, unknown>; const keys = Object.keys(value);
        if (keys.length !== 2 || !keys.includes('type') || !keys.includes('generation')) return;
        if ((value.type !== 'ended' && value.type !== 'failed') || !Number.isSafeInteger(value.generation) || (value.generation as number) < 0) return;
        this.listener?.({ type: value.type, generation: value.generation as number });
      });
      try { await this.bounded(window.loadFile(this.playerFile), 5000); }
      catch (error) {
        if (this.window === window) this.window = null;
        if (!window.isDestroyed()) window.destroy();
        throw error;
      }
      if (this.disposed || window.isDestroyed()) throw new Error('环境声音引擎已关闭');
      return window;
    })();
    try { return await this.opening; }
    finally { this.opening = null; }
  }

  async apply(command: AmbientEngineCommand): Promise<void> {
    this.lastGeneration = command.generation;
    const window = await this.open();
    const rendererCommand = command.action === 'play' && command.source.type === 'file'
      ? { ...command, source: { type: 'file', url: pathToFileURL(command.source.path).href } }
      : command;
    const encoded = JSON.stringify(rendererCommand).replace(/[\u2028\u2029]/g, character => character === '\u2028' ? '\\u2028' : '\\u2029');
    let result: unknown;
    try { result = await this.bounded(window.webContents.executeJavaScript(`globalThis.__studyflowAmbient(${encoded})`, true), 5000); }
    catch (error) {
      if (this.window === window) this.window = null;
      if (!window.isDestroyed()) window.destroy();
      throw error;
    }
    if (typeof result !== 'object' || result === null || (result as { ok?: unknown }).ok !== true) throw new Error('环境声音播放器拒绝命令');
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const cancel of this.pendingCancellations) cancel();
    this.pendingCancellations.clear();
    const window = this.window;
    this.window = null;
    if (window && !window.isDestroyed()) {
      try { await this.bounded(window.webContents.executeJavaScript("globalThis.__studyflowAmbient({action:'stop',generation:Number.MAX_SAFE_INTEGER})", false), 250); }
      catch { /* The window may already be closing. */ }
      if (!window.isDestroyed()) window.destroy();
    }
  }
}

export function createElectronAmbientAudio(dependencies: {
  createWindow: CreateHiddenWindow;
  userDataPath: string;
  showOpenDialog(): Promise<{ canceled: boolean; filePaths: string[] }>;
}): AmbientAudioController {
  const settings = new AmbientSettingsFile(join(dependencies.userDataPath, 'ambient-settings.json'));
  return new AmbientAudioController({
    engine: new HiddenBrowserAmbientEngine(dependencies.createWindow, join(dependencies.userDataPath, 'ambient-player.html')),
    chooseFile: dependencies.showOpenDialog,
    inspectFile: async path => (await stat(path)).isFile(),
    initialSettings: settings.load(),
    saveSettings: value => settings.save(value),
  });
}
