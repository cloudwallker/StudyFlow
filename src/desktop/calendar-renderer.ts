import type { DesktopSnapshot, Task } from './contracts';
import { dayNumber } from '../import/schedule';
import { remainingTaskMs } from './vendor/task-time';

export function localDate(date = new Date()): string {
  return `${date.getFullYear().toString().padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function mountCalendar(doc: Document, complete: (task: Task, done: boolean, date?: string) => void, start: (task: Task) => void,
  managementActions?: { edit(task: Task): void; move(id: string, from: string, to: string): void; reorder(ids: string[]): void }) {
  let selected = localDate(); let followToday = true; let mode: 'day' | 'all' = 'day';
  let monthExpanded = false;
  let query = ''; let tag = ''; let status = 'all';
  let dragged: { id: string; date?: string } | null = null;
  const filters = doc.createElement('div'); filters.className = 'task-filters';
  filters.innerHTML = '<label>搜索任务<input id="task-search" type="search" placeholder="标题、项目或标签"></label><label>标签<select id="task-tag-filter"><option value="">全部标签</option></select></label><label>状态<select id="task-status-filter"><option value="all">全部状态</option><option value="pending">未完成</option><option value="done">已完成</option></select></label>';
  doc.getElementById('tasks')!.before(filters);
  let current: DesktopSnapshot | null = null; let project: string | null = null; let busy = false; let key = '';
  const listeners: Array<() => void> = [];
  let actionMenus = new Map<string, { details: HTMLDetailsElement; controls: HTMLElement[] }>();
  function captureMenuState() {
    const focusedControl = doc.activeElement;
    const states = new Map<string, { open: boolean; focusedIndex: number }>();
    for (const [rowKey, menu] of actionMenus) {
      states.set(rowKey, { open: menu.details.open, focusedIndex: menu.controls.findIndex(control => control === focusedControl) });
    }
    return states;
  }
  const el = (id: string) => doc.getElementById(id)!;
  for (const id of ['task-search', 'task-tag-filter', 'task-status-filter']) {
    const handler = () => { query = (el('task-search') as HTMLInputElement).value.trim().toLocaleLowerCase(); tag = (el('task-tag-filter') as HTMLSelectElement).value; status = (el('task-status-filter') as HTMLSelectElement).value; key = ''; redraw(); };
    el(id).addEventListener(id === 'task-search' ? 'input' : 'change', handler);
    listeners.push(() => el(id).removeEventListener(id === 'task-search' ? 'input' : 'change', handler));
  }
  function on(id: string, action: () => void) {
    const listener = () => { action(); redraw(); };
    el(id).addEventListener('click', listener); listeners.push(() => el(id).removeEventListener('click', listener));
  }
  function select(date: string) { selected = date; followToday = date === localDate(); mode = 'day'; key = ''; }
  function moveMonth(direction: number) {
    const date = new Date(selected + 'T12:00:00'); date.setDate(1); date.setMonth(date.getMonth() + direction); select(localDate(date));
  }
  on('calendar-prev', () => moveMonth(-1)); on('calendar-next', () => moveMonth(1));
  on('calendar-today', () => select(localDate()));
  on('calendar-expand', () => { monthExpanded = !monthExpanded; });
  on('calendar-first', () => {
    const date = current?.plans?.find(day => day.entries.some(e => current?.tasks.some(t => t.id === e.taskId && (!project || t.projectId === project))))?.date;
    if (date) select(date);
  });
  on('task-view-day', () => { mode = 'day'; }); on('task-view-all', () => { mode = 'all'; });
  const dateInput = el('calendar-date') as HTMLInputElement;
  const changeDate = () => { if (dateInput.value) { select(dateInput.value); redraw(); } };
  dateInput.addEventListener('change', changeDate); listeners.push(() => dateInput.removeEventListener('change', changeDate));
  on('focus-view', () => {
    const focused = doc.body.classList.toggle('study-view');
    el('focus-view').textContent = focused ? '退出专注模式' : '进入专注模式';
    el('focus-view').setAttribute('aria-pressed', String(focused));
  });
  function redraw() {
    if (!current) return;
    if (followToday) selected = localDate();
    const { tasks, projects, focus } = current;
    const plans = current.plans ?? [];
    const nextKey = JSON.stringify([tasks, current.checkins, plans, projects, project, focus.running, focus.taskId, busy, selected, localDate(), mode, monthExpanded, query, tag, status]);
    if (key === nextKey) return; key = nextKey;
    // Row handlers retain this redraw scope, so keep only primitive state from old nodes.
    const previousMenuState = captureMenuState(); actionMenus = new Map();
    const tagFilter = el('task-tag-filter') as HTMLSelectElement; const selectedTag = tag;
    tagFilter.replaceChildren();
    for (const value of ['', ...new Set(tasks.flatMap(t => t.tags ?? []))]) { const option = doc.createElement('option'); option.value = value; option.textContent = value || '全部标签'; tagFilter.append(option); }
    tagFilter.value = selectedTag;
    const isDone = (task: Task, date?: string) => date && current?.checkins !== undefined ? current.checkins.some(c => c.date === date && c.taskId === task.id) : task.done;
    const visible = tasks.filter(t => (!project || t.projectId === project) && (!tag || t.tags?.includes(tag)) && (!query || [t.title, projects.find(p => p.id === t.projectId)?.name ?? '', ...(t.tags ?? [])].join(' ').toLocaleLowerCase().includes(query)));
    const byId = new Map(visible.map(t => [t.id, t]));
    const dateByTask = new Map<string, string>();
    for (const day of plans) for (const entry of day.entries) if (!dateByTask.has(entry.taskId)) dateByTask.set(entry.taskId, day.date);
    const manualOrder = tasks.some(t => (t.position ?? -1) >= 0);
    const orderedTasks = [...tasks].sort((a, b) => manualOrder ? (a.position ?? 0) - (b.position ?? 0) :
      (dateByTask.get(a.id) ?? '9999').localeCompare(dateByTask.get(b.id) ?? '9999') || (dayNumber(a.title) ?? 9999) - (dayNumber(b.title) ?? 9999));
    const orderedVisible = orderedTasks.filter(t => byId.has(t.id) && (status === 'all' || (status === 'done') === t.done));
    function reorderVisible(id: string, target: string) {
      const ids = orderedVisible.map(t => t.id); const from = ids.indexOf(id); const to = ids.indexOf(target);
      if (from < 0 || to < 0 || from === to) return;
      ids.splice(from, 1); ids.splice(to, 0, id);
      const included = new Set(ids); let index = 0;
      managementActions?.reorder(orderedTasks.map(t => included.has(t.id) ? ids[index++]! : t.id));
    }
    el('calendar-controls').hidden = mode !== 'day';
    el('task-view-day').setAttribute('aria-pressed', String(mode === 'day'));
    el('task-view-all').setAttribute('aria-pressed', String(mode === 'all'));
    dateInput.value = selected;
    el('calendar-month').textContent = `${Number(selected.slice(0, 4))} 年 ${Number(selected.slice(5, 7))} 月`;
    const grid = el('calendar-grid'); grid.replaceChildren();
    const first = new Date(selected.slice(0, 7) + '-01T12:00:00');
    const offset = (first.getDay() + 6) % 7;
    const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const weekStart = new Date(selected + 'T12:00:00'); weekStart.setDate(weekStart.getDate() - (weekStart.getDay() + 6) % 7);
    el('calendar-expand').textContent = monthExpanded ? '收起月历' : '展开月历'; el('calendar-expand').setAttribute('aria-expanded', String(monthExpanded));
    for (let n = 0; monthExpanded && n < offset; n++) { const blank = doc.createElement('span'); blank.setAttribute('aria-hidden', 'true'); grid.append(blank); }
    for (let day = 1; day <= (monthExpanded ? daysInMonth : 7); day++) {
      const weekDay = new Date(weekStart); weekDay.setDate(weekDay.getDate() + day - 1);
      const date = monthExpanded ? selected.slice(0, 8) + String(day).padStart(2, '0') : localDate(weekDay);
      const entries = plans.find(p => p.date === date)?.entries.filter(e => byId.has(e.taskId)) ?? [];
      const done = entries.filter(e => isDone(byId.get(e.taskId)!, date)).length;
      const button = doc.createElement('button'); button.type = 'button'; button.dataset.date = date;
      button.className = `calendar-day${date === selected ? ' selected' : ''}${date === localDate() ? ' today' : ''}${entries.length && done === entries.length ? ' completed' : ''}`;
      const number = doc.createElement('span'); number.textContent = String(Number(date.slice(8)));
      const count = doc.createElement('small'); count.textContent = entries.length ? done === entries.length ? '已完成' : `${done}/${entries.length}` : '·';
      button.append(number, count); button.setAttribute('aria-label', `${date}，${done}/${entries.length} 项完成`);
      button.setAttribute('aria-pressed', String(date === selected));
      if (date === localDate()) button.setAttribute('aria-current', 'date');
      button.onclick = () => { select(date); redraw(); };
      button.ondragover = event => { if (dragged?.date && !busy) event.preventDefault(); };
      button.ondrop = event => { event.preventDefault(); if (dragged?.date && !busy) managementActions?.move(dragged.id, dragged.date, date); dragged = null; };
      grid.append(button);
    }
    (el('calendar-first') as HTMLButtonElement).disabled = !visible.some(t => dateByTask.has(t.id));
    const list = el('tasks'); let restoreFocus: HTMLElement | undefined;
    list.replaceChildren(); let count = 0;
    function row(task: Task, container: HTMLElement, originalDate?: string, plannedMinutes?: number, makeup = false) {
      const done = isDone(task, mode === 'day' ? originalDate : undefined);
      if (status === 'pending' && done || status === 'done' && !done) return;
      count++;
      const item = doc.createElement('article'); item.className = `task-row${done ? ' done' : ''}`; item.dataset.taskId = task.id;
      item.draggable = !busy; item.ondragstart = event => { dragged = { id: task.id, ...(mode === 'day' && originalDate ? { date: originalDate } : {}) }; event.dataTransfer?.setData('text/plain', 'studyflow-task'); }; item.ondragend = () => { dragged = null; };
      item.ondragover = event => { if (dragged && mode === 'all' && !busy) event.preventDefault(); };
      item.ondrop = event => { event.preventDefault(); if (dragged && mode === 'all' && !busy) reorderVisible(dragged.id, task.id); dragged = null; };
      const body = doc.createElement('div'); body.className = 'task-body';
      const title = doc.createElement('div'); title.className = 'task-name'; title.textContent = task.title;
      const meta = doc.createElement('div'); meta.className = 'task-meta';
      meta.textContent = `${originalDate ? `${originalDate} · ` : ''}${plannedMinutes ?? task.estimateMinutes} 分钟${task.spentMs ? ` · 剩余 ${Math.ceil(remainingTaskMs(task) / 60000)} 分钟` : ''}`;
      if (task.tags?.length) meta.textContent += ` · ${task.tags.map(t => '#' + t).join(' ')}`;
      if (mode === 'all' && task.projectId) meta.textContent += ` · ${projects.find(p => p.id === task.projectId)?.name ?? ''}`;
      body.append(title, meta); item.append(body);
      const actions = doc.createElement('div'); actions.className = 'task-actions';
      if (!done && !task.done) {
        const play = doc.createElement('button'); play.type = 'button'; play.className = 'task-play';
        play.textContent = focus.running && focus.taskId === task.id ? '专注中' : '开始专注'; play.disabled = focus.running || busy;
        play.onclick = () => start(task); actions.append(play);
      }
      const check = doc.createElement('button'); check.type = 'button'; check.className = `task-check${makeup ? ' makeup' : ''}`;
      check.textContent = done ? '✓ 已完成 · 撤销' : makeup ? '补打卡' : mode === 'day' && originalDate ? '打卡完成' : '完成任务'; check.disabled = busy;
      check.setAttribute('aria-label', `${done ? '撤销完成' : makeup ? '补打卡' : '完成'} ${task.title}`);
      if (makeup) check.dataset.makeup = task.id;
      check.onclick = () => complete(task, !done, mode === 'day' ? originalDate : undefined); actions.append(check);
      const more = doc.createElement('details'); more.className = 'task-action-more';
      const summary = doc.createElement('summary'); summary.textContent = '更多'; summary.setAttribute('aria-label', '更多任务操作');
      const menu = doc.createElement('div'); menu.className = 'task-action-menu';
      more.append(summary, menu); more.addEventListener('click', event => event.stopPropagation());
      more.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || !more.open) return;
        event.preventDefault(); event.stopPropagation(); more.open = false; summary.focus({ preventScroll: true });
      });
      const edit = doc.createElement('button'); edit.type = 'button'; edit.textContent = '编辑'; edit.dataset.editTask = task.id; edit.disabled = busy;
      edit.onclick = () => { more.open = false; managementActions?.edit(task); }; menu.append(edit);
      const controls: HTMLElement[] = [summary, edit];
      if (mode === 'all') for (const [label, direction] of [['上移', -1], ['下移', 1]] as const) {
        const button = doc.createElement('button'); button.type = 'button'; button.textContent = label; button.setAttribute('aria-label', `${label} ${task.title}`);
        const index = orderedVisible.findIndex(t => t.id === task.id); const target = index + direction; button.disabled = busy || target < 0 || target >= orderedVisible.length;
        button.onclick = () => { more.open = false; summary.focus({ preventScroll: true }); if (orderedVisible[target]) reorderVisible(task.id, orderedVisible[target]!.id); }; menu.append(button); controls.push(button);
      }
      // A repeated task can appear once per date; restore only that occurrence's menu.
      const rowKey = JSON.stringify([mode, task.id, originalDate ?? null]); const previous = previousMenuState.get(rowKey);
      more.open = previous?.open ?? false;
      const focusedIndex = previous?.focusedIndex ?? -1;
      if (focusedIndex >= 0) {
        const next = controls[focusedIndex]; restoreFocus = next && !next.matches(':disabled') ? next : summary;
      }
      actionMenus.set(rowKey, { details: more, controls });
      actions.append(more);
      item.append(actions); container.append(item);
    }
    function group(title: string, entries: Array<{ task: Task; date?: string; minutes?: number }>, makeup = false) {
      if (!entries.length) return;
      const section = doc.createElement('section'); section.className = `agenda-group${makeup ? ' overdue-group' : ''}`;
      const heading = doc.createElement('h3'); heading.textContent = `${title} · ${entries.length} 项`; section.append(heading);
      if (mode === 'all') { for (const entry of entries) row(entry.task, section, entry.date, entry.minutes, makeup); list.append(section); return; }
      // Name the project once per group instead of repeating a long name on every task.
      const groups = new Map<string | null, typeof entries>();
      for (const entry of entries) { const items = groups.get(entry.task.projectId) ?? []; items.push(entry); groups.set(entry.task.projectId, items); }
      for (const [id, items] of groups) {
        const name = doc.createElement('p'); name.className = 'agenda-project'; name.textContent = projects.find(p => p.id === id)?.name ?? '未分配项目'; section.append(name);
        for (const entry of items) row(entry.task, section, entry.date, entry.minutes, makeup);
      }
      list.append(section);
    }
    if (mode === 'all') {
      group('全部任务', orderedVisible.map(task => ({ task, ...(dateByTask.has(task.id) ? { date: dateByTask.get(task.id)! } : {}) })));
    } else {
      const todayEntries = plans.find(p => p.date === selected)?.entries ?? [];
      const today = todayEntries.flatMap(e => byId.has(e.taskId) ? [{ task: byId.get(e.taskId)!, date: selected, minutes: e.minutes }] : []);
      const completed = today.filter(e => isDone(e.task, selected)).length;
      el('agenda-summary').textContent = `${selected === localDate() ? '今天' : selected} · ${completed}/${today.length} 项完成 · 计划 ${today.reduce((sum, e) => sum + e.minutes, 0)} 分钟`;
      group(selected === localDate() ? '今日任务' : `${selected} 的任务`, today);
      if (!today.length) { const empty = doc.createElement('p'); empty.className = 'agenda-empty'; empty.textContent = '这一天没有安排任务。可以查看其他日期，或在每日计划中添加安排。'; list.append(empty); }
      const overdue: Array<{ task: Task; date: string; minutes: number }> = [];
      for (const day of plans) {
        // Future date browsing does not make today's unfinished work overdue.
        if (day.date >= selected || day.date >= localDate()) continue;
        for (const entry of day.entries) {
          const task = byId.get(entry.taskId); if (!task || isDone(task, day.date)) continue;
          overdue.push({ task, date: day.date, minutes: entry.minutes });
        }
      }
      group('之前未完成 · 可补打卡', overdue, true);
      const unscheduled = visible.filter(t => !dateByTask.has(t.id)).sort((a, b) => (dayNumber(a.title) ?? 9999) - (dayNumber(b.title) ?? 9999));
      group('未安排日期', unscheduled.map(task => ({ task })));
    }
    if (mode === 'all') el('agenda-summary').textContent = '可拖动任务排序；此处完成操作标记整个任务，按日学习中的打卡仅影响当天。';
    el('task-count').textContent = `${count} 个任务`;
    el('empty').hidden = visible.length > 0;
    restoreFocus?.focus({ preventScroll: true });
  }
  return {
    render(data: DesktopSnapshot, selectedProject: string | null, isBusy: boolean) { current = data; project = selectedProject; busy = isBusy; redraw(); },
    selectDate(date: string) { select(date); redraw(); },
    dispose() { listeners.forEach(remove => remove()); actionMenus.clear(); filters.remove(); },
  };
}
