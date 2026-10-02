import { longFocusConfig } from '../timer/long-focus';
import { soundKinds } from '../timer/pomodoro-sound';
import { mountDaily } from './daily-renderer';
import { mountImport } from './import-renderer';
import { mountDiagnostics } from './diagnostic-renderer';
import type { Command, DesktopAPI, DesktopSnapshot } from './contracts';
import { mountCalendar } from './calendar-renderer';
import { mountManagement } from './management-renderer';
import { mountAmbientAudio } from './ambient-renderer';
import { mountShell } from './shell-renderer';
import { mountPlanReminderSettings } from './plan-reminder-renderer';

declare global { interface Window { studyflow?: DesktopAPI } }

export function mountDesktop(doc: Document, api: DesktopAPI): () => void {
  let data: DesktopSnapshot | null = null;
  let selectedProject: string | null = null;
  let busy = false; let disposed = false; let revision = 0; let refreshing = false;
  let listKey = ''; let settingsKey = '';
  let nextPhaseKey = '';
  const listeners: Array<() => void> = [];
  const el = (id: string) => {
    const item = doc.getElementById(id); if (!item) throw new Error(`Missing UI: ${id}`); return item;
  };
  const field = (id: string) => el(id) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  const write = (id: string, value: string) => { el(id).textContent = value; };
  function bind(id: string, event: string, action: () => void) {
    const node = el(id); const listener = (e: Event) => { e.preventDefault(); action(); };
    node.addEventListener(event, listener); listeners.push(() => node.removeEventListener(event, listener));
  }
  function error(message: string) { write('error', message); el('error').hidden = !message; }
  function option(value: string, label: string) { const item = doc.createElement('option'); item.value = value; item.textContent = label; return item; }
  function fillSelect(id: string, choices: Array<{ id: string; name: string }>, empty: string) {
    const select = field(id) as HTMLSelectElement; const previous = select.value;
    select.replaceChildren(option('', empty), ...choices.map(item => option(item.id, item.name)));
    if (choices.some(item => item.id === previous)) select.value = previous;
  }
  const eventNames = { 'cue': '随机提示', 'focus-start': '专注开始', 'micro-start': '微休息开始', 'micro-end': '微休息结束', 'long-start': '长休息开始（整轮完成时由庆祝音替代）', 'work-end': '整轮完成', 'break-end': '长休息结束' };
  for (const kind of soundKinds) {
    const row = doc.createElement('div'); row.className = 'event-sound-row';
    const title = doc.createElement('strong'); title.textContent = eventNames[kind];
    const tone = doc.createElement('select'); tone.id = `sound-${kind}-tone`; tone.setAttribute('aria-label', `${eventNames[kind]}音色`);
    tone.append(option('soft', '柔和'), option('bell', '清铃'), option('wood', '木音'));
    const volume = doc.createElement('input'); volume.id = `sound-${kind}-volume`; volume.type = 'number'; volume.min = '0'; volume.max = '100'; volume.value = '40'; volume.setAttribute('aria-label', `${eventNames[kind]}音量（0—100）`);
    const preview = doc.createElement('button'); preview.type = 'button'; preview.id = `sound-${kind}-preview`; preview.textContent = '试听'; preview.className = 'secondary';
    row.append(title, tone, volume, preview); el('event-sound-options').append(row);
  }
  function longInput() {
    return { enabled: (el('long-enabled') as HTMLInputElement).checked, microEnabled: (el('micro-enabled') as HTMLInputElement).checked,
      totalMinutes: Number(field('long-total').value), restMinutes: Number(field('long-rest').value),
      minMinutes: Number(field('micro-min').value), maxMinutes: Number(field('micro-max').value), durationSeconds: Number(field('micro-duration').value) };
  }
  function soundInput() {
    return { ...((el('long-enabled') as HTMLInputElement).checked ? { events: Object.fromEntries(soundKinds.map(kind => [kind, { tone: field(`sound-${kind}-tone`).value, volume: Number(field(`sound-${kind}-volume`).value) }])) } : data?.settings.sound?.events ? { events: data.settings.sound.events } : {}), enabled: (el('pomo-sound-enabled') as HTMLInputElement).checked,
      minMinutes: Number(field('pomo-sound-min').value), maxMinutes: Number(field('pomo-sound-max').value),
      volume: Number(field('pomo-sound-volume').value), tone: field('pomo-sound-tone').value };
  }
  function startInput(taskId: string | null) {
    return { taskId, longFocus: longInput(), mode: field('focus-mode').value, idleMinutes: Number(field('idle-minutes').value), sound: soundInput(),
      policy: { workMinutes: Number(field('pomo-work').value), shortBreakMinutes: Number(field('pomo-short').value),
        longBreakMinutes: Number(field('pomo-long').value), roundsBeforeLongBreak: Number(field('pomo-rounds').value) } };
  }
  const management = mountManagement(doc, command);
  const shell = mountShell(doc);
  const planReminder = mountPlanReminderSettings(doc, value => command('planReminderSettings', value));
  const calendar = mountCalendar(doc,
    (task, done, date) => { void command(date ? 'checkIn' : 'setTaskDone', { id: task.id, done, ...(date ? { date } : {}) }); },
    task => { void command('start', startInput(task.id)); }, {
      edit: management.open, move: (id, from, to) => { void command('movePlan', { id, from, to }); },
      reorder: ids => { void command('reorderTasks', { ids }); },
    });
  function render() {
    if (!data || disposed) return;
    const { tasks, projects, focus, settings } = data;
    if (selectedProject && !projects.some(p => p.id === selectedProject)) selectedProject = null;
    management.render(data, busy);
    planReminder.render(data, busy);
    write('today', new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }));
    write('pending-count', String(tasks.filter(t => !t.done).length));
    write('done-count', String(tasks.filter(t => t.done).length));
    write('nav-count', String(tasks.length));
    write('focus-minutes', `${Math.floor(tasks.reduce((sum, t) => sum + t.spentMs, 0) / 60000)} 分钟`);
    shell.project(projects.find(p => p.id === selectedProject)?.name ?? '学习工作台');
    const key = JSON.stringify([projects, tasks, selectedProject, focus.running, focus.taskId]);
    if (key !== listKey) {
      listKey = key;
      const projectNav = el('projects'); projectNav.replaceChildren();
      for (const project of projects) {
        const button = doc.createElement('button'); button.className = `nav-item${selectedProject === project.id ? ' selected' : ''}`;
        button.textContent = `○　${project.name}`;
        button.onclick = () => { selectedProject = project.id; field('task-project').value = project.id; shell.workspace(); render(); };
        projectNav.append(button);
      }
      fillSelect('task-project', projects, '未分配项目');
      fillSelect('focus-task', tasks.filter(t => !t.done).map(t => ({ id: t.id, name: t.title })), '自由专注');
      if (focus.running) field('focus-task').value = focus.taskId ?? '';
    }
    calendar.render(data, selectedProject, busy);
    // The independent reminder form must not replace unsaved timer/whitelist drafts.
    const nextSettings = JSON.stringify({ ...settings, planReminder: undefined });
    if (nextSettings !== settingsKey) {
      settingsKey = nextSettings; field('duration').value = String(settings.durationMinutes);
      field('whitelist').value = settings.whitelist.join('\n');
      (el('record-app-activity') as HTMLInputElement).checked = settings.recordAppActivity === true;
      (el('all-day-activity') as HTMLInputElement).checked = settings.allDayActivity === true;
      field('focus-mode').value = settings.mode ?? 'countdown';
      field('idle-minutes').value = String(settings.idleMinutes ?? 5);
      field('pomo-work').value = String(settings.policy?.workMinutes ?? 25);
      field('pomo-short').value = String(settings.policy?.shortBreakMinutes ?? 5);
      field('pomo-long').value = String(settings.policy?.longBreakMinutes ?? 15);
      field('pomo-rounds').value = String(settings.policy?.roundsBeforeLongBreak ?? 4);
      (el('pomo-sound-enabled') as HTMLInputElement).checked = settings.sound?.enabled === true;
      field('pomo-sound-min').value = String(settings.sound?.minMinutes ?? 3);
      field('pomo-sound-max').value = String(settings.sound?.maxMinutes ?? 5);
      field('pomo-sound-volume').value = String(settings.sound?.volume ?? 40);
      field('pomo-sound-tone').value = settings.sound?.tone ?? 'soft';
      const long = longFocusConfig(settings.longFocus);
      (el('long-enabled') as HTMLInputElement).checked = long.enabled;
      (el('micro-enabled') as HTMLInputElement).checked = long.microEnabled;
      for (const [id, value] of [['long-total', long.totalMinutes], ['long-rest', long.restMinutes], ['micro-min', long.minMinutes], ['micro-max', long.maxMinutes], ['micro-duration', long.durationSeconds]] as const) field(id).value = String(value);
      for (const kind of soundKinds) {
        field(`sound-${kind}-tone`).value = settings.sound?.events?.[kind]?.tone ?? settings.sound?.tone ?? 'soft';
        field(`sound-${kind}-volume`).value = String(settings.sound?.events?.[kind]?.volume ?? settings.sound?.volume ?? 40);
      }
    }
    const timer = focus.timer;
    const started = timer && timer.status !== 'idle';
    const active = timer && focus.running;
    if (active && timer.mode) field('focus-mode').value = timer.mode;
    const mode = active ? timer.mode : field('focus-mode').value;
    const longEnabled = (el('long-enabled') as HTMLInputElement).checked;
    const microEnabled = (el('micro-enabled') as HTMLInputElement).checked;
    const seconds = active ? Math.ceil((timer.remainingMs ?? timer.phaseElapsedMs) / 1000) :
      mode === 'stopwatch' ? 0 : mode === 'pomodoro' ? Number(field(longEnabled ? 'long-total' : 'pomo-work').value) * 60 : focus.running ? focus.remainingSeconds : settings.durationMinutes * 60;
    write('timer', `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`);
    el('active-session').hidden = !focus.running;
    write('active-session', `${timer?.status === 'paused' ? '已暂停' : timer?.status === 'awaiting-next' ? '等待下一阶段' : '专注中'} · ${el('timer').textContent} · 返回专注 →`);
    write('focus-badge', timer?.status === 'paused' ? '已暂停' : timer?.status === 'awaiting-next' ? '等待确认' : focus.running ? '计时进行中' : '准备开始');
    write('timer-label', active && timer.longFocus && timer.phase === 'work' ? '本轮剩余时间' : active ? (timer.phase === 'work' ? mode === 'stopwatch' ? '正计时' : '工作阶段' : timer.phase === 'short-break' ? '短休息' : '长休息') : '一次只做一件事');
    el('micro-countdown').hidden = !active || !timer.longFocus || timer.microRemainingMs == null;
    write('micro-countdown', timer?.microRemainingMs != null ? `${timer.status === 'paused' ? '已暂停 · ' : ''}${timer.microResting ? '微休息剩余' : '距离微休息'} ${Math.ceil(timer.microRemainingMs / 1000)} 秒` : '');
    write('focus-toggle', focus.running ? '结束本次专注' : '开始专注');
    write('focus-message', focus.message + (focus.notification === 'failed' && focus.running ? ' · 居中提醒显示失败' : ''));
    write('current-app', focus.running ? focus.app ?? '等待有效采样' : settings.allDayActivity ? '全天活动记录中' : '未开始采集');
    el('focus-pause').hidden = !timer || !focus.running;
    write('focus-pause', timer?.status === 'awaiting-next' ? '开始下一阶段' : timer?.status === 'paused' ? '继续计时' : '暂停计时');
    (el('focus-pause') as HTMLButtonElement).disabled = busy;
    write('learning-summary', started && focus.learning ? `本次学习 ${Math.floor(focus.learning.effectiveMs / 1000)} 秒 · 空闲 ${Math.floor(focus.learning.afkMs / 1000)} 秒 · 未知 ${Math.floor(focus.learning.unknownMs / 1000)} 秒 · 微休息 ${Math.floor((timer?.microBreakMs ?? 0) / 1000)} 秒` : '');
    el('pomo-settings').hidden = field('focus-mode').value !== 'pomodoro';
    const waiting = timer?.status === 'awaiting-next';
    el('pomo-next-field').hidden = !waiting;
    const phaseKey = waiting ? `${timer.sessionId}:${timer.completedPomodoros}:${timer.nextPhase}` : '';
    if (phaseKey !== nextPhaseKey) {
      nextPhaseKey = phaseKey;
      field('pomo-next').value = String(timer?.nextPhase === 'work' ? timer.longFocus ? settings.longFocus?.totalMinutes ?? 60 : settings.policy?.workMinutes ?? 25 : timer?.nextPhase === 'long-break' ? settings.policy?.longBreakMinutes ?? 15 : settings.policy?.shortBreakMinutes ?? 5);
    }
    (el('pomo-next') as HTMLInputElement).disabled = busy || !waiting;
    el('long-options').hidden = !longEnabled;
    el('micro-options').hidden = !microEnabled;
    el('classic-pomo-options').hidden = longEnabled;
    el('random-sound-options').hidden = longEnabled && microEnabled;
    el('classic-sound-options').hidden = longEnabled;
    el('event-sound-options').hidden = !longEnabled;
    for (const id of ['long-enabled', 'long-total', 'long-rest', 'micro-enabled', 'micro-min', 'micro-max', 'micro-duration']) (el(id) as HTMLInputElement).disabled = focus.running || busy;
    const soundEnabled = (el('pomo-sound-enabled') as HTMLInputElement).checked;
    el('pomo-sound-options').hidden = !soundEnabled;
    for (const kind of soundKinds) {
      for (const suffix of ['tone', 'volume', 'preview']) (el(`sound-${kind}-${suffix}`) as HTMLInputElement).disabled = !soundEnabled || focus.running || busy;
      el(`sound-${kind}-tone`).parentElement!.hidden = kind === 'cue' && microEnabled;
    }
    (el('pomo-sound-enabled') as HTMLInputElement).disabled = focus.running || busy;
    for (const id of ['pomo-sound-min', 'pomo-sound-max', 'pomo-sound-volume', 'pomo-sound-tone', 'pomo-preview-cue', 'pomo-preview-work', 'pomo-preview-break']) {
      (el(id) as HTMLInputElement).disabled = !soundEnabled || focus.running || busy;
    }
    for (const id of ['all-day-activity', 'record-app-activity', 'history-date', 'delete-history', 'focus-task', 'duration', 'whitelist', 'save-settings', 'focus-mode', 'pomo-work', 'pomo-short', 'pomo-long', 'pomo-rounds', 'idle-minutes']) (el(id) as HTMLButtonElement).disabled = focus.running || busy;
    for (const id of ['focus-toggle', 'task-title', 'task-project', 'task-estimate', 'project-name']) (el(id) as HTMLButtonElement).disabled = busy;
  }
  async function command(name: Command, payload?: unknown): Promise<boolean> {
    if (busy || disposed) return false;
    if (!doc.dispatchEvent(new CustomEvent('studyflow-before-change', { detail: name, cancelable: true }))) { error('请先保存每日计划编辑，再修改任务或安排'); return false; }
    busy = true; revision++; error(''); render();
    let succeeded = false;
    try {
      const reply = await api.request(name, payload);
      if (disposed) return false;
      if (reply.ok) { data = reply.value; succeeded = true;
        if (['updateTask', 'archiveTask', 'deleteProject', 'movePlan', 'repeatPlan', 'checkIn', 'manageCategories'].includes(name)) doc.dispatchEvent(new CustomEvent('studyflow-data-changed', { detail: name }));
      }
      else error(reply.error);
    } catch { if (!disposed) error('无法连接本地服务，请重新打开应用'); }
    finally { busy = false; if (!disposed) { listKey = ''; render(); } }
    return succeeded;
  }
  async function refresh() {
    if (disposed || busy || refreshing) return;
    refreshing = true; const current = revision;
    try {
      const reply = await api.request('snapshot');
      if (!disposed && current === revision) {
        if (reply.ok) { data = reply.value; render(); } else error(reply.error);
      }
    } catch { if (!disposed) error('无法读取本地数据，请重新打开应用'); }
    finally { refreshing = false; }
  }
  bind('all-projects', 'click', () => { selectedProject = null; render(); });
  const openToday = () => {
    selectedProject = null; shell.workspace();
    if (doc.body.classList.contains('study-view')) el('focus-view').click();
    for (const [id, value] of [['task-search', ''], ['task-tag-filter', ''], ['task-status-filter', 'all']]) {
      field(id!).value = value!; el(id!).dispatchEvent(new Event(id === 'task-search' ? 'input' : 'change'));
    }
    el('calendar-today').click(); render();
  };
  doc.addEventListener('studyflow-open-today', openToday);
  listeners.push(() => doc.removeEventListener('studyflow-open-today', openToday));
  bind('project-form', 'submit', () => {
    void command('createProject', { name: field('project-name').value }).then(ok => { if (ok && !disposed) field('project-name').value = ''; });
  });
  bind('task-form', 'submit', () => {
    void command('createTask', { title: field('task-title').value, projectId: field('task-project').value || null, estimateMinutes: Number(field('task-estimate').value) })
      .then(ok => { if (ok && !disposed) field('task-title').value = ''; });
  });
  bind('settings-form', 'submit', () => {
    void command('settings', { ...startInput(null), allDayActivity: (el('all-day-activity') as HTMLInputElement).checked, recordAppActivity: (el('record-app-activity') as HTMLInputElement).checked, durationMinutes: Number(field('duration').value), whitelist: field('whitelist').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean) })
      .then(ok => { if (ok && !disposed) write('settings-status', '已保存'); });
  });
  bind('history-delete-form', 'submit', () => {
    void command('deleteHistory', { date: field('history-date').value }).then(ok => { if (ok && !disposed) write('history-status', '该日期历史已删除，任务累计用时保留'); });
  });
  bind('focus-mode', 'change', render);
  bind('pomo-work', 'input', render);
  bind('long-enabled', 'change', render); bind('micro-enabled', 'change', render); bind('long-total', 'input', render);
  for (const kind of soundKinds) bind(`sound-${kind}-preview`, 'click', () => { void command('previewSound', { sound: soundInput(), kind }); });
  bind('pomo-sound-enabled', 'change', render);
  for (const [id, kind] of [['pomo-preview-cue', 'cue'], ['pomo-preview-work', 'work-end'], ['pomo-preview-break', 'break-end']]) {
    bind(id!, 'click', () => { void command('previewSound', { sound: { ...soundInput(), events: undefined }, kind }); });
  }
  bind('focus-toggle', 'click', () => { void command(data?.focus.running ? 'stop' : 'start', startInput(field('focus-task').value || null)); });
  const miniButton = el('focus-mini-open') as HTMLButtonElement;
  miniButton.hidden = !api.focusMini;
  bind('focus-mini-open', 'click', () => {
    if (!api.focusMini || miniButton.disabled || disposed) return;
    miniButton.disabled = true; error('');
    void api.focusMini.open().then(reply => {
      if (!disposed && !reply.ok) error('专注小窗未能打开，请重试');
    }).catch(() => { if (!disposed) error('专注小窗未能打开，请重试'); })
      .finally(() => { if (!disposed) miniButton.disabled = false; });
  });
  bind('focus-pause', 'click', () => { void command(data?.focus.timer?.status === 'running' ? 'pause' : 'resume',
    data?.focus.timer?.status === 'awaiting-next' ? { durationMinutes: Number(field('pomo-next').value) } : undefined); });
  write('today', new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }));
  const cleanupDaily = mountDaily(doc, api);
  const cleanupAmbient = api.ambient ? mountAmbientAudio(doc, api.ambient, doc.querySelector('.focus-panel')!) : () => {};
  const cleanupImport = mountImport(doc, api, (snapshot, firstDate) => {
    revision++; selectedProject = null; data = snapshot; listKey = ''; render();
    if (firstDate) calendar.selectDate(firstDate);
    doc.dispatchEvent(new Event('studyflow-imported'));
  });
  void refresh();
  const timer = setInterval(() => { void refresh(); }, 1000);
  return () => { shell.dispose(); planReminder.dispose(); cleanupImport(); cleanupDaily(); cleanupAmbient(); calendar.dispose(); management.dispose(); disposed = true; clearInterval(timer); listeners.forEach(remove => remove()); };
}
if (typeof window !== 'undefined' && window.studyflow) {
  const reportError = (kind: 'renderer_error' | 'renderer_rejection', error: unknown) => {
    const stack = error instanceof Error ? error.stack ?? '' : '';
    const frames = [...stack.matchAll(/(?:[/\\( ])(renderer\.js):(\d+):(\d+)/g)].slice(0, 8).map(match => `${match[1]}:${match[2]}:${match[3]}`);
    window.studyflow?.diagnostics?.reportError?.(kind, frames);
  };
  const onError = (event: ErrorEvent) => reportError('renderer_error', event.error);
  const onRejection = (event: PromiseRejectionEvent) => reportError('renderer_rejection', event.reason);
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  const cleanupDiagnostics = window.studyflow.diagnostics ? mountDiagnostics(document, window.studyflow.diagnostics) : () => {};
  const cleanup = mountDesktop(document, window.studyflow);
  window.addEventListener('pagehide', () => {
    cleanup(); cleanupDiagnostics(); window.removeEventListener('error', onError); window.removeEventListener('unhandledrejection', onRejection);
  }, { once: true });
}
