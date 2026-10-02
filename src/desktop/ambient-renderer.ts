import type { AmbientAudioCommand, AmbientAudioReply, AmbientState } from './ambient-audio';

export interface AmbientAudioAPI {
  request(command: AmbientAudioCommand, payload?: unknown): Promise<AmbientAudioReply>;
}

function appendControl(doc: Document, parent: HTMLElement, labelText: string, control: HTMLElement): void {
  const label = doc.createElement('label');
  label.append(doc.createTextNode(labelText), control);
  parent.append(label);
}

export function mountAmbientAudio(doc: Document, api: AmbientAudioAPI, parent: HTMLElement): () => void {
  const panel = doc.createElement('section');
  panel.id = 'ambient-audio-panel';
  panel.setAttribute('aria-labelledby', 'ambient-audio-title');
  const title = doc.createElement('h2'); title.id = 'ambient-audio-title'; title.textContent = '本地白噪音与音乐';
  const privacy = doc.createElement('p'); privacy.textContent = '默认关闭，仅播放你通过系统选择器选取的本地 WAV 或 MP3；文件不会上传。';
  const source = doc.createElement('p'); source.id = 'ambient-source'; source.textContent = '当前：白噪音';
  const controls = doc.createElement('div'); controls.className = 'ambient-controls';
  const noise = doc.createElement('select'); noise.id = 'ambient-noise'; noise.setAttribute('aria-label', '噪音类型');
  for (const [value, text] of [['white', '白噪音'], ['pink', '粉红噪音'], ['brown', '棕噪音']] as const) {
    const option = doc.createElement('option'); option.value = value; option.textContent = text; noise.append(option);
  }
  appendControl(doc, controls, '噪音类型', noise);
  const volume = doc.createElement('input'); volume.id = 'ambient-volume'; volume.type = 'range'; volume.min = '0'; volume.max = '100'; volume.step = '1';
  appendControl(doc, controls, '音量', volume);
  const volumeValue = doc.createElement('output'); volumeValue.id = 'ambient-volume-value'; volumeValue.htmlFor = 'ambient-volume'; controls.append(volumeValue);
  const loop = doc.createElement('input'); loop.id = 'ambient-loop'; loop.type = 'checkbox';
  appendControl(doc, controls, '本地音乐循环播放', loop);
  const follow = doc.createElement('input'); follow.id = 'ambient-follow-focus'; follow.type = 'checkbox';
  appendControl(doc, controls, '跟随专注开始与暂停', follow);
  const actions = doc.createElement('div'); actions.className = 'ambient-actions';
  const buttons = new Map<string, HTMLButtonElement>();
  for (const [id, text] of [['ambient-pick', '选择本地音乐'], ['ambient-play', '播放 / 继续'], ['ambient-pause', '暂停'], ['ambient-stop', '停止']] as const) {
    const button = doc.createElement('button'); button.id = id; button.type = 'button'; button.textContent = text; buttons.set(id, button); actions.append(button);
  }
  const status = doc.createElement('p'); status.id = 'ambient-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  panel.append(title, privacy, source, controls, actions, status); parent.append(panel);

  let disposed = false;
  let requestId = 0;
  let renderedId = 0;
  const listeners: Array<() => void> = [];
  const on = (element: Element, event: string, handler: () => void) => {
    const listener = () => { if (!disposed) handler(); };
    element.addEventListener(event, listener); listeners.push(() => element.removeEventListener(event, listener));
  };
  function render(value: AmbientState): void {
    if (value.source.type === 'noise') {
      noise.value = value.source.kind;
      source.textContent = `当前：${value.source.kind === 'white' ? '白噪音' : value.source.kind === 'pink' ? '粉红噪音' : '棕噪音'}`;
    } else source.textContent = `当前本地音乐：${value.source.name}`;
    volume.value = String(value.volume); volumeValue.value = `${value.volume}%`;
    loop.checked = value.loop; follow.checked = value.followFocus;
    buttons.get('ambient-play')!.disabled = value.status === 'playing';
    buttons.get('ambient-pause')!.disabled = value.status !== 'playing';
    buttons.get('ambient-stop')!.disabled = value.status === 'stopped';
    status.textContent = value.message ?? (value.status === 'playing' ? '正在后台播放' : value.status === 'paused' ? '已暂停' : '已停止');
  }
  async function request(command: AmbientAudioCommand, payload?: unknown): Promise<void> {
    const id = ++requestId;
    try {
      const reply = await api.request(command, payload);
      if (disposed || id < renderedId) return;
      renderedId = id;
      render(reply.value);
      if (!reply.ok) status.textContent = reply.error;
    } catch {
      if (!disposed && id >= renderedId) { renderedId = id; status.textContent = '无法连接本地声音服务'; }
    }
  }
  on(noise, 'change', () => { void request('setNoise', { kind: noise.value }); });
  on(volume, 'change', () => { void request('setVolume', { volume: Number(volume.value) }); });
  on(loop, 'change', () => { void request('setLoop', { loop: loop.checked }); });
  on(follow, 'change', () => { void request('setFollowFocus', { enabled: follow.checked }); });
  on(buttons.get('ambient-pick')!, 'click', () => { void request('selectFile'); });
  on(buttons.get('ambient-play')!, 'click', () => { void request('play'); });
  on(buttons.get('ambient-pause')!, 'click', () => { void request('pause'); });
  on(buttons.get('ambient-stop')!, 'click', () => { void request('stop'); });
  void request('snapshot');
  const poll = doc.defaultView?.setInterval(() => { void request('snapshot'); }, 1000);
  return () => {
    if (disposed) return;
    disposed = true;
    if (poll !== undefined) doc.defaultView?.clearInterval(poll);
    listeners.forEach(remove => remove());
    panel.remove();
  };
}
