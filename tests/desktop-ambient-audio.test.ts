// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import {
  AMBIENT_AUDIO_CHANNEL,
  AmbientAudioController,
  AmbientSettingsFile,
  HiddenBrowserAmbientEngine,
  installAmbientAudioIpc,
  parseAmbientAudioRequest,
  type AmbientEngineCommand,
  type AmbientEngineEvent,
  type AmbientPlaybackEngine,
} from '../src/desktop/ambient-audio';
import { mountAmbientAudio } from '../src/desktop/ambient-renderer';

class FakeEngine implements AmbientPlaybackEngine {
  readonly commands: AmbientEngineCommand[] = [];
  disposed = 0;
  private listener: ((event: AmbientEngineEvent) => void) | null = null;
  setEventListener(listener: (event: AmbientEngineEvent) => void): void { this.listener = listener; }
  emit(event: AmbientEngineEvent): void { this.listener?.(event); }
  apply(command: AmbientEngineCommand): Promise<void> {
    this.commands.push(command);
    return Promise.resolve();
  }
  dispose(): Promise<void> { this.disposed++; return Promise.resolve(); }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup(options: {
  engine?: AmbientPlaybackEngine;
  chooseFile?: () => Promise<{ canceled: boolean; filePaths: string[] }>;
  inspectFile?: (path: string) => Promise<boolean>;
  initialSettings?: { noiseKind: 'white' | 'pink' | 'brown'; volume: number; loop: boolean; followFocus: boolean };
  saveSettings?: (settings: { noiseKind: 'white' | 'pink' | 'brown'; volume: number; loop: boolean; followFocus: boolean }) => Promise<void>;
} = {}) {
  const engine = options.engine ?? new FakeEngine();
  const controller = new AmbientAudioController({
    engine,
    chooseFile: options.chooseFile ?? (async () => ({ canceled: true, filePaths: [] })),
    inspectFile: options.inspectFile ?? (async () => true),
    ...(options.initialSettings ? { initialSettings: options.initialSettings } : {}),
    ...(options.saveSettings ? { saveSettings: options.saveSettings } : {}),
  });
  return { controller, engine };
}

describe('本地环境声音主进程控制器', () => {
  it.each(['cancel', 'picker-error', 'invalid', 'unreadable'] as const)('播放中选择文件 %s 后仍处理原播放结束事件', async outcome => {
    const engine = new FakeEngine();
    const { controller } = setup({
      engine,
      chooseFile: async () => {
        if (outcome === 'picker-error') throw new Error('picker failed');
        return { canceled: outcome === 'cancel', filePaths: [outcome === 'invalid' ? 'C:\\track.txt' : 'C:\\track.mp3'] };
      },
      inspectFile: async () => false,
    });
    await controller.execute('play');
    const generation = engine.commands.at(-1)!.generation;
    await controller.execute('selectFile');
    engine.emit({ type: 'ended', generation });
    expect(controller.snapshot()).toMatchObject({ status: 'stopped', message: null });
  });

  it.each(['stop', 'pause', 'play', 'setNoise'] as const)('%s 使在途文件选择失效', async command => {
    const picker = deferred<{ canceled: boolean; filePaths: string[] }>();
    const { controller } = setup({ chooseFile: () => picker.promise });
    const pending = controller.execute('selectFile');
    await controller.execute(command, command === 'setNoise' ? { kind: 'brown' } : undefined);
    const expected = controller.snapshot();
    picker.resolve({ canceled: false, filePaths: ['C:\\late.mp3'] });
    await pending;
    expect(controller.snapshot()).toEqual(expected);
  });

  it('较早的文件检查不能覆盖较新的选择，待选期间原播放仍能结束', async () => {
    const inspection = deferred<boolean>();
    const inspecting = deferred<void>();
    let selected = 0;
    const engine = new FakeEngine();
    const { controller } = setup({
      engine,
      chooseFile: async () => ({ canceled: false, filePaths: [++selected === 1 ? 'C:\\old.mp3' : 'C:\\new.mp3'] }),
      inspectFile: path => {
        if (path === 'C:\\old.mp3') { inspecting.resolve(); return inspection.promise; }
        return Promise.resolve(true);
      },
    });
    await controller.execute('play');
    const generation = engine.commands.at(-1)!.generation;
    const pending = controller.execute('selectFile');
    await inspecting.promise;
    engine.emit({ type: 'ended', generation });
    expect(controller.snapshot().status).toBe('stopped');
    await controller.execute('selectFile');
    await controller.execute('play');
    inspection.resolve(true);
    await pending;
    engine.emit({ type: 'failed', generation });
    expect(controller.snapshot()).toMatchObject({ status: 'playing', source: { type: 'file', name: 'new.mp3' }, message: null });
  });

  it('默认关闭，并严格拒绝 IPC 中的路径、额外字段和越界值', () => {
    const { controller } = setup();
    expect(controller.snapshot()).toMatchObject({
      status: 'stopped',
      source: { type: 'noise', kind: 'white' },
      volume: 35,
      loop: true,
      followFocus: false,
    });
    expect(() => parseAmbientAudioRequest('selectFile', { path: 'C:\\private.mp3' })).toThrow();
    expect(() => parseAmbientAudioRequest('setNoise', { kind: 'violet' })).toThrow();
    expect(() => parseAmbientAudioRequest('setVolume', { volume: 101 })).toThrow();
    expect(() => parseAmbientAudioRequest('setLoop', { loop: 1 })).toThrow();
    expect(() => parseAmbientAudioRequest('play', {})).toThrow();
    expect(parseAmbientAudioRequest('setNoise', { kind: 'pink' })).toEqual({ command: 'setNoise', payload: { kind: 'pink' } });
  });

  it('切换三种噪音、音量、循环并执行播放暂停停止', async () => {
    const { controller, engine } = setup();
    await controller.execute('setNoise', { kind: 'brown' });
    await controller.execute('setVolume', { volume: 62 });
    await controller.execute('setLoop', { loop: false });
    expect((await controller.execute('play')).value).toMatchObject({ status: 'playing', source: { type: 'noise', kind: 'brown' }, volume: 62, loop: false });
    expect((await controller.execute('pause')).value.status).toBe('paused');
    expect((await controller.execute('play')).value.status).toBe('playing');
    expect((await controller.execute('stop')).value.status).toBe('stopped');
    expect((engine as FakeEngine).commands.map(command => command.action)).toEqual([
      'set-source', 'set-volume', 'set-loop', 'play', 'pause', 'play', 'stop',
    ]);
  });

  it('本地音乐只能由系统选择器提供，公共状态只保留文件名', async () => {
    let inspected = '';
    const { controller, engine } = setup({
      chooseFile: async () => ({ canceled: false, filePaths: ['C:\\Users\\Fictional\\study track.MP3'] }),
      inspectFile: async path => { inspected = path; return true; },
    });
    const selected = await controller.execute('selectFile');
    expect(inspected).toBe('C:\\Users\\Fictional\\study track.MP3');
    expect(selected.value).toMatchObject({ status: 'stopped', source: { type: 'file', name: 'study track.MP3' } });
    expect(JSON.stringify(selected)).not.toContain('Fictional');
    await controller.execute('play');
    const play = (engine as FakeEngine).commands.at(-1);
    expect(play).toMatchObject({ action: 'play', source: { type: 'file', path: 'C:\\Users\\Fictional\\study track.MP3' } });
  });

  it('取消选择不改变来源，无效文件给出不含真实路径的失败信息', async () => {
    const canceled = setup();
    expect((await canceled.controller.execute('selectFile')).value.source).toEqual({ type: 'noise', kind: 'white' });

    const invalid = setup({
      chooseFile: async () => ({ canceled: false, filePaths: ['C:\\Users\\Private\\secret.txt'] }),
      inspectFile: async () => true,
    });
    const reply = await invalid.controller.execute('selectFile');
    expect(reply.ok).toBe(false);
    expect(JSON.stringify(reply)).not.toContain('Private');
    if (!reply.ok) expect(reply.error).toContain('WAV');
  });

  it('停止后忽略旧播放失败，退出时取消晚到的文件选择并释放引擎', async () => {
    const play = deferred<void>();
    const picker = deferred<{ canceled: boolean; filePaths: string[] }>();
    const engine = new FakeEngine();
    engine.apply = command => {
      engine.commands.push(command);
      return command.action === 'play' ? play.promise : Promise.resolve();
    };
    const { controller } = setup({ engine, chooseFile: () => picker.promise });
    const pendingPlay = controller.execute('play');
    await Promise.resolve();
    await controller.execute('stop');
    play.reject(new Error('C:\\Users\\Private\\decoder details'));
    await pendingPlay;
    expect(controller.snapshot()).toMatchObject({ status: 'stopped', message: null });

    const pendingPicker = controller.execute('selectFile');
    const disposed = controller.dispose();
    picker.resolve({ canceled: false, filePaths: ['C:\\Users\\Fictional\\late.mp3'] });
    await Promise.all([pendingPicker, disposed]);
    expect(engine.disposed).toBe(1);
    expect(JSON.stringify(controller.snapshot())).not.toContain('late.mp3');
  });

  it('专注联动只在专注边沿自动播放和暂停，手动暂停不会被同一状态反复覆盖', async () => {
    const { controller, engine } = setup();
    await controller.execute('setFollowFocus', { enabled: true });
    await controller.setFocusActive(true);
    await controller.execute('pause');
    await controller.setFocusActive(true);
    expect(controller.snapshot().status).toBe('paused');
    await controller.setFocusActive(false);
    await controller.setFocusActive(true);
    expect(controller.snapshot().status).toBe('playing');
    expect((engine as FakeEngine).commands.map(command => command.action)).toEqual([
      'set-follow-focus', 'play', 'pause', 'play',
    ]);
  });

  it('拒绝网络路径、设备路径和 NTFS 备用数据流', async () => {
    const selected = [
      '\\\\server\\share\\track.mp3',
      '\\\\?\\C:\\music\\track.mp3',
      'C:\\music\\track.mp3:alternate',
    ];
    for (const path of selected) {
      const { controller } = setup({ chooseFile: async () => ({ canceled: false, filePaths: [path] }) });
      const reply = await controller.execute('selectFile');
      expect(reply.ok).toBe(false);
      expect(JSON.stringify(reply)).not.toContain(path);
    }
  });

  it('专注结束不会把用户已经停止的声音改成暂停', async () => {
    const { controller } = setup();
    await controller.execute('setFollowFocus', { enabled: true });
    await controller.setFocusActive(true);
    await controller.execute('stop');
    await controller.setFocusActive(false);
    expect(controller.snapshot().status).toBe('stopped');
  });

  it('自然播放结束和隐藏窗口崩溃会回写状态，旧代事件不会覆盖新播放', async () => {
    const engine = new FakeEngine();
    const { controller } = setup({ engine });
    await controller.execute('setLoop', { loop: false });
    await controller.execute('play');
    const firstGeneration = engine.commands.at(-1)!.generation;
    engine.emit({ type: 'ended', generation: firstGeneration });
    expect(controller.snapshot()).toMatchObject({ status: 'stopped', message: null });
    await controller.execute('play');
    const secondGeneration = engine.commands.at(-1)!.generation;
    engine.emit({ type: 'failed', generation: firstGeneration });
    expect(controller.snapshot().status).toBe('playing');
    engine.emit({ type: 'failed', generation: secondGeneration });
    expect(controller.snapshot()).toMatchObject({ status: 'stopped', message: '环境声音播放失败，请检查文件或音频设备' });
  });

  it('切到本地音乐后保存其他偏好不会保存路径或丢失上次噪音类型', async () => {
    const saved: unknown[] = [];
    const { controller } = setup({
      initialSettings: { noiseKind: 'brown', volume: 35, loop: true, followFocus: false },
      chooseFile: async () => ({ canceled: false, filePaths: ['C:\\Music\\fictional.mp3'] }),
      saveSettings: async settings => { saved.push(settings); },
    });
    await controller.execute('selectFile');
    await controller.execute('setVolume', { volume: 44 });
    expect(saved.at(-1)).toEqual({ noiseKind: 'brown', volume: 44, loop: true, followFocus: false });
    expect(JSON.stringify(saved)).not.toContain('Music');
  });
});

it('IPC 只接受主窗口发送者，并在清理时移除处理器', async () => {
  const handlers = new Map<string, (event: unknown, command: unknown, payload?: unknown) => unknown>();
  const ipc = {
    handle: (channel: string, handler: (event: unknown, command: unknown, payload?: unknown) => unknown) => { handlers.set(channel, handler); },
    removeHandler: (channel: string) => { handlers.delete(channel); },
  };
  const { controller } = setup();
  const trusted = {};
  const cleanup = installAmbientAudioIpc(ipc, controller, event => event === trusted);
  expect(AMBIENT_AUDIO_CHANNEL).toBe('studyflow:ambient-audio');
  expect(() => handlers.get(AMBIENT_AUDIO_CHANNEL)!({}, 'snapshot')).toThrow(/拒绝/);
  const reply = await handlers.get(AMBIENT_AUDIO_CHANNEL)!(trusted, 'snapshot');
  expect(reply).toMatchObject({ ok: true, value: { status: 'stopped' } });
  cleanup();
  expect(handlers.has(AMBIENT_AUDIO_CHANNEL)).toBe(false);
});

describe('隐藏 Electron 播放窗口', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  function playerSetup() {
    const dir = mkdtempSync(join(tmpdir(), 'studyflow-ambient-')); dirs.push(dir);
    const audios: TestAudio[] = [];
    class TestAudio extends EventTarget {
      src = ''; preload = ''; loop = false; volume = 0; paused = true;
      nextPlay: Promise<void> = Promise.resolve();
      constructor() { super(); audios.push(this); }
      play() { this.paused = false; return this.nextPlay; }
      pause() { this.paused = true; }
      removeAttribute() { this.src = ''; }
      load() {}
    }
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const scope = {
      Audio: TestAudio,
      __studyflowAmbientHost: { emit: (event: AmbientEngineEvent) => handlers.get('ipc-message')?.({}, 'studyflow:ambient-internal', event) },
    };
    const engine = new HiddenBrowserAmbientEngine(() => ({
      isDestroyed: () => false,
      loadFile: async path => {
        const script = readFileSync(path, 'utf8').match(/<script>([\s\S]*?)<\/script>/)![1]!;
        runInNewContext(script, scope);
      },
      once: () => {}, destroy: () => {},
      webContents: {
        on: (event, listener) => { handlers.set(event, listener); },
        executeJavaScript: async code => runInNewContext(code, scope),
      },
    }), join(dir, 'player.html'));
    const { controller } = setup({ engine, chooseFile: async () => ({ canceled: false, filePaths: ['C:\\fictional.mp3'] }) });
    return { controller, audios };
  }

  it.each(['ended', 'error'])('文件暂停继续后 %s 事件更新控制器状态', async event => {
    const { controller, audios } = playerSetup();
    await controller.execute('selectFile');
    await controller.execute('play');
    await controller.execute('pause');
    await controller.execute('play');
    expect(audios).toHaveLength(1);
    audios[0]!.dispatchEvent(new Event(event));
    expect(controller.snapshot()).toMatchObject({ status: 'stopped', message: event === 'ended' ? null : '环境声音播放失败，请检查文件或音频设备' });
    await controller.dispose();
  });

  it('停止和切源后的旧音频事件不能影响新播放', async () => {
    const { controller, audios } = playerSetup();
    await controller.execute('selectFile');
    await controller.execute('play');
    await controller.execute('stop');
    await controller.execute('play');
    const first = audios[0]!;
    first.dispatchEvent(new Event('ended'));
    first.dispatchEvent(new Event('error'));
    expect(controller.snapshot().status).toBe('playing');
    await controller.execute('selectFile');
    await controller.execute('play');
    audios[1]!.dispatchEvent(new Event('ended'));
    audios[1]!.dispatchEvent(new Event('error'));
    expect(controller.snapshot()).toMatchObject({ status: 'playing', message: null });
    await controller.dispose();
  });

  it('旧播放的迟到失败不能停止已经替换的新音频', async () => {
    const { controller, audios } = playerSetup();
    await controller.execute('selectFile');
    await controller.execute('play');
    await controller.execute('pause');
    const late = deferred<void>();
    audios[0]!.nextPlay = late.promise;
    const pending = controller.execute('play');
    await Promise.resolve();
    await controller.execute('stop');
    await controller.execute('play');
    late.reject(new Error('old decoder failure'));
    await pending;
    expect(audios[1]!.paused).toBe(false);
    expect(controller.snapshot()).toMatchObject({ status: 'playing', message: null });
    await controller.dispose();
  });

  it('使用隔离且不节流的隐藏窗口，复用窗口并在退出时销毁', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'studyflow-ambient-')); dirs.push(dir);
    let options: unknown;
    let destroyed = false;
    let loaded = '';
    const scripts: string[] = [];
    const window = {
      isDestroyed: () => destroyed,
      loadFile: async (path: string) => { loaded = path; },
      once: (_event: 'closed', _listener: () => void) => {},
      destroy: () => { destroyed = true; },
      webContents: { executeJavaScript: async (code: string) => { scripts.push(code); return { ok: true }; } },
    };
    let created = 0;
    const engine = new HiddenBrowserAmbientEngine(value => { options = value; created++; return window; }, join(dir, 'player.html'));
    await engine.apply({ action: 'play', generation: 1, source: { type: 'noise', kind: 'pink' }, volume: 40, loop: true, resume: false });
    await engine.apply({ action: 'set-volume', generation: 1, volume: 20 });
    expect(created).toBe(1);
    expect(loaded).toBe(join(dir, 'player.html'));
    expect(options).toMatchObject({ show: false, skipTaskbar: true, webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true } });
    await engine.dispose();
    expect(destroyed).toBe(true);
    expect(scripts.at(-1)).toContain("action:'stop'");
  });

  it('播放器页面加载失败时销毁残留窗口，避免下次复用半初始化资源', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'studyflow-ambient-')); dirs.push(dir);
    let destroyed = false;
    const window = {
      isDestroyed: () => destroyed,
      loadFile: async () => { throw new Error('load failed'); },
      once: (_event: 'closed', _listener: () => void) => {},
      destroy: () => { destroyed = true; },
      webContents: { executeJavaScript: async () => ({ ok: true }) },
    };
    const engine = new HiddenBrowserAmbientEngine(() => window, join(dir, 'player.html'));
    await expect(engine.apply({ action: 'play', generation: 1, source: { type: 'noise', kind: 'white' }, volume: 35, loop: true, resume: false })).rejects.toThrow();
    expect(destroyed).toBe(true);
  });

  it('验证并转发播放器结束事件与渲染进程崩溃，不转发伪造消息', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'studyflow-ambient-')); dirs.push(dir);
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const events: AmbientEngineEvent[] = [];
    const window = {
      isDestroyed: () => false,
      loadFile: async () => {},
      once: (_event: 'closed', _listener: () => void) => {},
      destroy: () => {},
      webContents: {
        executeJavaScript: async () => ({ ok: true }),
        on: (event: 'ipc-message' | 'render-process-gone', listener: (...args: unknown[]) => void) => { handlers.set(event, listener); },
      },
    };
    const engine = new HiddenBrowserAmbientEngine(() => window, join(dir, 'player.html'));
    engine.setEventListener(event => events.push(event));
    await engine.apply({ action: 'play', generation: 7, source: { type: 'noise', kind: 'white' }, volume: 35, loop: true, resume: false });
    handlers.get('ipc-message')!({}, 'other-channel', { type: 'ended', generation: 7 });
    handlers.get('ipc-message')!({}, 'studyflow:ambient-internal', { type: 'ended', generation: 7, path: 'private' });
    handlers.get('ipc-message')!({}, 'studyflow:ambient-internal', { type: 'ended', generation: 7 });
    handlers.get('render-process-gone')!({});
    expect(events).toEqual([{ type: 'ended', generation: 7 }, { type: 'failed', generation: 7 }]);
    await engine.dispose();
  });

  it('退出不会等待永久挂起的播放器调用，并取消在途命令', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'studyflow-ambient-')); dirs.push(dir);
    const started = deferred<void>();
    let destroyed = false;
    const never = new Promise<unknown>(() => {});
    const window = {
      isDestroyed: () => destroyed,
      loadFile: async () => {},
      once: (_event: 'closed', _listener: () => void) => {},
      destroy: () => { destroyed = true; },
      webContents: { executeJavaScript: () => { started.resolve(); return never; } },
    };
    const engine = new HiddenBrowserAmbientEngine(() => window, join(dir, 'player.html'));
    const pending = engine.apply({ action: 'play', generation: 1, source: { type: 'noise', kind: 'white' }, volume: 35, loop: true, resume: false }).then(() => false, () => true);
    await started.promise;
    await engine.dispose();
    const canceled = await Promise.race([pending, new Promise<boolean>(resolve => setTimeout(() => resolve(false), 500))]);
    expect(canceled).toBe(true);
    expect(destroyed).toBe(true);
  });
});

describe('环境声音偏好存储', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  it('只保存非敏感偏好，重新加载时仍默认停止', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'studyflow-ambient-settings-')); dirs.push(dir);
    const path = join(dir, 'ambient-settings.json');
    const store = new AmbientSettingsFile(path);
    expect(store.load()).toEqual({ noiseKind: 'white', volume: 35, loop: true, followFocus: false });
    await store.save({ noiseKind: 'brown', volume: 67, loop: false, followFocus: true });
    const encoded = readFileSync(path, 'utf8');
    expect(JSON.parse(encoded)).toEqual({ schemaVersion: 1, noiseKind: 'brown', volume: 67, loop: false, followFocus: true });
    expect(encoded).not.toContain('path');
    expect(new AmbientSettingsFile(path).load()).toEqual({ noiseKind: 'brown', volume: 67, loop: false, followFocus: true });
  });

  it('设置文件损坏或字段越界时回退默认值而不启动声音', () => {
    const dir = mkdtempSync(join(tmpdir(), 'studyflow-ambient-settings-')); dirs.push(dir);
    const path = join(dir, 'ambient-settings.json');
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, noiseKind: 'white', volume: 200, loop: true, followFocus: true }));
    expect(new AmbientSettingsFile(path).load()).toEqual({ noiseKind: 'white', volume: 35, loop: true, followFocus: false });
  });
});

describe('本地环境声音界面', () => {
  it('创建完整控件，按状态更新且清理后忽略晚到响应', async () => {
    document.body.innerHTML = '<main id="settings"></main>';
    const requests: Array<{ command: string; payload?: unknown }> = [];
    const late = deferred<{ ok: true; value: { status: 'stopped'; source: { type: 'noise'; kind: 'white' }; volume: number; loop: boolean; followFocus: boolean; message: null } }>();
    const cleanup = mountAmbientAudio(document, {
      request: (command, payload) => {
        requests.push(payload === undefined ? { command } : { command, payload });
        if (command === 'snapshot') return late.promise;
        return Promise.resolve({ ok: true as const, value: { status: 'playing' as const, source: { type: 'noise' as const, kind: 'pink' as const }, volume: 55, loop: true, followFocus: true, message: null } });
      },
    }, document.getElementById('settings')!);
    const doc = document;
    expect(doc.getElementById('ambient-audio-panel')).not.toBeNull();
    (doc.getElementById('ambient-noise') as HTMLSelectElement).value = 'pink';
    doc.getElementById('ambient-noise')!.dispatchEvent(new Event('change'));
    (doc.getElementById('ambient-volume') as HTMLInputElement).value = '55';
    doc.getElementById('ambient-volume')!.dispatchEvent(new Event('change'));
    (doc.getElementById('ambient-follow-focus') as HTMLInputElement).checked = true;
    doc.getElementById('ambient-follow-focus')!.dispatchEvent(new Event('change'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(requests).toContainEqual({ command: 'setNoise', payload: { kind: 'pink' } });
    expect(requests).toContainEqual({ command: 'setVolume', payload: { volume: 55 } });
    expect(requests).toContainEqual({ command: 'setFollowFocus', payload: { enabled: true } });

    cleanup();
    late.resolve({ ok: true, value: { status: 'stopped', source: { type: 'noise', kind: 'white' }, volume: 35, loop: true, followFocus: false, message: null } });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(doc.getElementById('ambient-audio-panel')).toBeNull();
  });
});
