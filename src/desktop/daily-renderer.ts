import type { Command, DesktopAPI, DesktopSnapshot } from './contracts';
import type { DailyData } from './daily';

function taskSummaryRows(timeline: DailyData['timeline']): string[][] {
  type Entry = DailyData['timeline'][number];
  const groups = new Map<string, {
    title: string; learning: boolean; first: Entry; last: Entry; discontinuous: boolean;
    durationMs: number; effectiveMs: number; afkMs: number; unknownMs: number;
  }>();
  for (const entry of timeline) {
    const learning = entry.kind === 'work';
    const key = JSON.stringify([entry.title, learning]);
    let group = groups.get(key);
    if (!group) {
      group = { title: entry.title, learning, first: entry, last: entry, discontinuous: false,
        durationMs: 0, effectiveMs: 0, afkMs: 0, unknownMs: 0 };
      groups.set(key, group);
    }
    if (entry.start < group.first.start) group.first = entry;
    if ((entry.end ?? entry.start) > (group.last.end ?? group.last.start)) group.last = entry;
    group.discontinuous ||= entry.end === null;
    group.durationMs += entry.durationMs; group.effectiveMs += entry.effectiveMs;
    group.afkMs += entry.afkMs; group.unknownMs += entry.unknownMs;
  }
  const clock = (ms: number, offset: number) => `${new Date(ms + offset * 60000).toISOString().slice(11, 19)} (UTC${offset >= 0 ? '+' : ''}${offset / 60})`;
  const minutes = (ms: number) => ms > 0 && ms < 3000 ? '<0.1' : `${Math.round(ms / 6000) / 10}`;
  return [...groups.values()].sort((a, b) => a.first.start - b.first.start || Number(b.learning) - Number(a.learning)).map(group => [
    `${clock(group.first.start, group.first.offset)} 至 ${clock(group.last.end ?? group.last.start, group.last.offset)}${group.discontinuous ? '（含时钟不连续记录）' : ''}`,
    `${group.learning ? '学习汇总' : '休息 / 暂停等汇总'} · ${group.title}`,
    [group.durationMs, group.effectiveMs, group.afkMs, group.unknownMs].map(minutes).join(' / '),
  ]);
}

export function mountDaily(doc: Document, api: DesktopAPI): () => void {
  const el = (id: string) => doc.getElementById(id)!;
  const field = (id: string) => el(id) as HTMLInputElement;
  let disposed = false; let busy = false; let currentDate = ''; let dirty = false; let importRevision = 0;
  let importBusy = false;
  let planDirty = false; let planStale = false;
  const listeners: Array<() => void> = [];
  function on(id: string, event: string, action: () => void) {
    const handler = (e: Event) => { if (event === 'submit' || event === 'click') e.preventDefault(); action(); };
    el(id).addEventListener(event, handler); listeners.push(() => el(id).removeEventListener(event, handler));
  }
  function text(id: string, value: string) { el(id).textContent = value; }
  function controls() {
    for (const control of Array.from(el('daily-panel').querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement>('input,button,textarea'))) control.disabled = busy || importBusy;
    if (planStale) for (const control of Array.from(el('daily-plan-form').querySelectorAll<HTMLInputElement>('input,button'))) control.disabled = true;
    el('daily-panel').setAttribute('aria-busy', String(busy || importBusy));
  }
  const minutes = (ms: number) => `${Math.round(ms / 6000) / 10}`;
  function table(id: string, headers: string[], rows: string[][]) {
    const node = el(id); node.replaceChildren();
    if (!rows.length) { node.textContent = '当天暂无记录'; return; }
    const table = doc.createElement('table'); const head = doc.createElement('tr');
    for (const label of headers) { const th = doc.createElement('th'); th.scope = 'col'; th.textContent = label; head.append(th); }
    const thead = doc.createElement('thead'); thead.append(head); table.append(thead);
    const body = doc.createElement('tbody');
    for (const row of rows) { const tr = doc.createElement('tr'); for (const value of row) { const td = doc.createElement('td'); td.textContent = value; tr.append(td); } body.append(tr); }
    table.append(body); node.append(table);
  }
  function render(data: DailyData, snapshot: DesktopSnapshot, reset: boolean) {
    currentDate = data.date;
    text('daily-loaded-date', `当前读取 / 保存日期：${currentDate}`);
    text('daily-summary', `有效学习 ${minutes(data.effectiveMs)} 分钟 · AFK ${minutes(data.afkMs)} 分钟 · 未知 ${minutes(data.unknownMs)} 分钟 · 休息 ${minutes(data.breakMs)} 分钟（其中微休息 ${minutes(data.microBreakMs ?? 0)} 分钟） · 完成番茄 ${data.pomodoros} 个`);
    const kinds: Record<string, string> = { 'micro-break': '微休息', work: '学习', break: '休息', pause: '暂停', waiting: '等待确认', unknown: '未知', active: '活动', afk: 'AFK' };
    table('daily-timeline', ['首末记录范围（记录时当地，非连续时长）', '同名任务每日汇总（最多两行）', '累计经过 / 有效 / AFK / 未知（分钟）'], taskSummaryRows(data.timeline));
    table('daily-activities', ['时间（UTC）', '应用 / 状态', '分钟'], data.activities.map(a => [
      `${new Date(a.start).toISOString().slice(11, 19)}–${new Date(a.end).toISOString().slice(11, 19)}`,
      a.app ?? kinds[a.state] ?? a.state, minutes(a.end - a.start)]));
    table('daily-apps', ['应用', '分钟', '手动分类'], data.apps.map(a => [a.app, minutes(a.durationMs), a.category]));
    let totals = doc.getElementById('daily-category-totals');
    if (!totals) { totals = doc.createElement('div'); totals.id = 'daily-category-totals'; el('daily-apps').after(totals); }
    table('daily-category-totals', ['分类汇总', '活动分钟'], (data.categoryTotals ?? []).map(c => [c.category, minutes(c.durationMs)]));
    table('daily-comparison', ['任务', '计划分钟', '实际分钟', '差值（实际−计划）', '时间完成率', '当前任务状态'], data.comparison.map(c => [
      c.title, minutes(c.plannedMs), minutes(c.actualMs), minutes(c.deltaMs), c.rate === null ? '无计划基准' : `${Math.round(c.rate * 100)}%`, c.taskId === null ? '自由专注' : c.done ? '已完成' : '未完成']));
    text('plan-saved', data.plan ? `快照保存于 ${new Date(data.plan.savedAt).toLocaleString('zh-CN')}` : '尚未保存当天计划');
    if (reset) {
      dirty = false;
      planDirty = false; planStale = false;
      for (const key of ['accomplished', 'obstacles', 'adjustment'] as const) field(`review-${key}`).value = data.review[key];
      const container = el('plan-entries'); container.replaceChildren();
      const entries = new Map(data.plan?.entries.map(p => [p.taskId, p]) ?? []);
      for (const task of [...snapshot.tasks, ...(snapshot.archivedTasks ?? []).filter(t => entries.has(t.id))]) {
        const saved = entries.get(task.id); const label = doc.createElement('label'); label.className = 'plan-entry';
        const check = doc.createElement('input'); check.type = 'checkbox'; check.checked = !!saved; check.dataset.taskId = task.id;
        const title = doc.createElement('span'); title.textContent = (saved?.title ?? task.title) + (snapshot.archivedTasks?.some(t => t.id === task.id) ? '（已删除，保留原计划）' : '');
        const input = doc.createElement('input'); input.type = 'number'; input.min = '0'; input.max = '1440'; input.step = '1'; input.value = String(saved?.minutes ?? task.estimateMinutes);
        input.setAttribute('aria-label', `${title.textContent} 当日分配分钟`);
        label.append(check, title, input, doc.createTextNode('分钟')); container.append(label);
      }
      if (!container.childElementCount) container.textContent = '先在上方添加任务，即可分配当天时间。';
    }
  }
  async function request(command: Command, payload: unknown, reset = false) {
    if (busy || importBusy || disposed) return;
    if (command === 'savePlan' && planStale) { text('daily-status', '计划已变化，请先重新读取日期；复盘编辑仍可保存'); return; }
    if (command !== 'daily' && field('daily-date').value !== currentDate) { text('daily-status', '请先读取所选日期，再保存'); return; }
    busy = true;
    const revision = importRevision;
    controls();
    text('daily-status', '正在处理…');
    try {
      const reply = await api.request(command, payload);
      if (disposed || revision !== importRevision) return;
      if (!reply.ok) { text('daily-status', reply.error); return; }
      if (command === 'savePlan') planDirty = false;
      if (reply.value.daily) render(reply.value.daily, reply.value, reset);
      text('daily-status', command === 'daily' ? '已读取保存的历史检查点' : '已保存');
    } catch { if (!disposed) text('daily-status', '无法连接本地服务，编辑内容已保留'); }
    finally { busy = false; if (!disposed) controls(); }
  }
  const today = new Date(); field('daily-date').value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  on('daily-review-form', 'input', () => { dirty = true; });
  on('daily-plan-form', 'input', () => { dirty = true; planDirty = true; });
  on('daily-load', 'click', () => {
    if (dirty && !doc.defaultView?.confirm('重新读取日期会丢弃未保存的计划和复盘编辑，继续吗？')) return;
    void request('daily', { date: field('daily-date').value }, true);
  });
  on('daily-review-form', 'submit', () => {
    void request('saveReview', { date: currentDate, review: { accomplished: field('review-accomplished').value, obstacles: field('review-obstacles').value, adjustment: field('review-adjustment').value } });
  });
  on('daily-plan-form', 'submit', () => {
    const entries = Array.from(el('plan-entries').querySelectorAll<HTMLInputElement>('input[type=checkbox]')).filter(c => c.checked)
      .map(c => ({ taskId: c.dataset.taskId, minutes: Number(c.parentElement!.querySelector<HTMLInputElement>('input[type=number]')!.value) }));
    void request('savePlan', { date: currentDate, entries });
  });
  on('app-category-form', 'submit', () => { void request('classifyApp', { date: currentDate, app: field('category-app').value, category: field('category-name').value }); });
  const planCommands = ['updateTask', 'archiveTask', 'deleteProject', 'movePlan', 'repeatPlan', 'checkIn', 'confirmImport'];
  const beforeChange = (event: Event) => {
    const name: unknown = (event as CustomEvent<unknown>).detail;
    if (name === 'confirmImport' && busy) { event.preventDefault(); text('daily-status', '请等待当前读取或保存完成，再确认导入'); return; }
    if (typeof name === 'string' && planCommands.includes(name) && planDirty) { event.preventDefault(); text('daily-status', '请先保存每日计划编辑，再修改任务或安排'); }
  };
  const managementChanged = (event: Event) => {
    const name: unknown = (event as CustomEvent<unknown>).detail;
    if (typeof name === 'string' && planCommands.includes(name)) { planStale = true; text('daily-status', '任务或计划已变化，请重新读取日期；未保存的复盘仍可保存'); controls(); }
  };
  doc.addEventListener('studyflow-before-change', beforeChange); doc.addEventListener('studyflow-data-changed', managementChanged);
  listeners.push(() => { doc.removeEventListener('studyflow-before-change', beforeChange); doc.removeEventListener('studyflow-data-changed', managementChanged); });
  const imported = () => { importRevision++; planStale = true; text('daily-status', '任务或计划已变化，请重新读取日期；未保存的复盘仍可保存'); controls(); };
  doc.addEventListener('studyflow-imported', imported); listeners.push(() => doc.removeEventListener('studyflow-imported', imported));
  // Invalidate even on a lost reply: the transaction may already have committed.
  const importStart = () => { importBusy = true; importRevision++; planStale = true; text('daily-status', '正在导入，计划需重新读取；结束后仍可保存当前日期的复盘'); controls(); };
  const importEnd = () => { importBusy = false; controls(); };
  doc.addEventListener('studyflow-import-start', importStart); doc.addEventListener('studyflow-import-end', importEnd);
  listeners.push(() => { doc.removeEventListener('studyflow-import-start', importStart); doc.removeEventListener('studyflow-import-end', importEnd); });
  void request('daily', { date: field('daily-date').value }, true);
  return () => { disposed = true; listeners.forEach(remove => remove()); };
}
