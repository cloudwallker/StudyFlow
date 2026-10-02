import type { Command, DesktopSnapshot, Task } from './contracts';
import { localDate } from './calendar-renderer';

export function mountManagement(doc: Document, command: (name: Command, payload?: unknown) => Promise<boolean>) {
  const panel = doc.createElement('details'); panel.className = 'management-panel';
  // Static trusted markup only. All task/project/user text below uses textContent/value.
  panel.innerHTML = `<summary>任务、项目与分类管理</summary>
    <p class="hint">点击任务旁的编辑可修改、安排重复计划或删除。删除可在此恢复，历史时长保留。</p>
    <form id="manage-project-form"><label>项目<select id="manage-project"></select></label><label>名称<input id="manage-project-name" maxlength="80" required></label><button>保存名称</button><button id="manage-project-up" type="button">上移</button><button id="manage-project-down" type="button">下移</button><button id="manage-project-delete" type="button">删除项目，保留任务</button></form>
    <h3>已删除任务</h3><div id="archived-tasks"></div>
    <h3>应用分类</h3><div id="category-mappings"></div>
    <form id="categories-form"><label>批量分类（每行：应用名,分类）<textarea id="categories-batch" rows="4" placeholder="Code.exe,学习"></textarea></label><button>保存批量分类</button></form>`;
  doc.querySelector('.tasks-panel')!.append(panel);
  const editor = doc.createElement('section'); editor.id = 'task-editor'; editor.hidden = true; editor.className = 'task-editor';
  editor.innerHTML = `<h3>编辑任务</h3><form id="edit-task-form">
    <label>标题<input id="edit-task-title" maxlength="200" required></label>
    <label>所属项目<select id="edit-task-project"></select></label><label>预计分钟<input id="edit-task-minutes" type="number" min="1" max="240" required></label>
    <label>标签（逗号分隔）<input id="edit-task-tags" maxlength="820"></label>
    <label>前置任务（可多选）<select id="edit-task-dependencies" multiple size="4"></select></label>
    <div><button>保存任务</button><button id="edit-task-close" type="button">取消</button><button id="edit-task-archive" type="button">删除任务（可恢复）</button></div></form>
    <form id="repeat-plan-form"><h4>安排单次或重复计划</h4><label>开始日期<input id="repeat-start" type="date" required></label><label>结束日期<input id="repeat-end" type="date" required></label><label>间隔<select id="repeat-every"><option value="1">每天</option><option value="7">每周</option><option value="14">每两周</option><option value="30">每30天</option></select></label><label>每天分钟<input id="repeat-minutes" type="number" min="1" max="240" required></label><button>添加计划</button><p class="hint">相同起止日期为单次安排；最多覆盖一年。每次打卡独立，已有日期不重复添加。</p></form>
    <form id="move-plan-form"><h4>移动已有安排</h4><label>原日期<input id="move-from" type="date" required></label><label>目标日期<input id="move-to" type="date" required></label><button>移动日期</button><p class="hint">也可将日历任务拖到日期格。已打卡安排须先撤销打卡。</p></form>`;
  doc.getElementById('tasks')!.before(editor);
  let snapshot: DesktopSnapshot | null = null; let selected: Task | null = null; let disposed = false; let key = '';
  const input = (id: string) => doc.getElementById(id) as HTMLInputElement;
  const select = (id: string) => doc.getElementById(id) as HTMLSelectElement;
  const on = (id: string, event: string, fn: () => void) => { doc.getElementById(id)!.addEventListener(event, e => { e.preventDefault(); if (!disposed) fn(); }); };
  function choices(node: HTMLSelectElement, options: Array<{ id: string; name: string }>, empty?: string) {
    node.replaceChildren();
    for (const option of [...(empty !== undefined ? [{ id: '', name: empty }] : []), ...options]) {
      const el = doc.createElement('option'); el.value = option.id; el.textContent = option.name; node.append(el);
    }
  }
  function open(task: Task) {
    if (!snapshot) return; selected = task; editor.hidden = false;
    input('edit-task-title').value = task.title; input('edit-task-minutes').value = String(task.estimateMinutes); input('edit-task-tags').value = (task.tags ?? []).join(', ');
    choices(select('edit-task-project'), snapshot.projects, '未分配项目'); select('edit-task-project').value = task.projectId ?? '';
    choices(select('edit-task-dependencies'), snapshot.tasks.filter(t => t.id !== task.id).map(t => ({ id: t.id, name: t.title })));
    for (const option of Array.from(select('edit-task-dependencies').options)) option.selected = task.dependencies?.includes(option.value) ?? false;
    input('repeat-start').value = input('repeat-end').value = localDate(); input('repeat-minutes').value = String(task.estimateMinutes);
    input('move-from').value = snapshot.plans?.find(day => day.entries.some(e => e.taskId === task.id))?.date ?? localDate(); input('move-to').value = localDate();
    input('edit-task-title').focus();
  }
  on('edit-task-close', 'click', () => { editor.hidden = true; selected = null; });
  on('edit-task-form', 'submit', () => {
    if (!selected) return;
    void command('updateTask', { id: selected.id, title: input('edit-task-title').value, projectId: select('edit-task-project').value || null,
      estimateMinutes: Number(input('edit-task-minutes').value), tags: input('edit-task-tags').value.split(/[,，]/).map(t => t.trim()).filter(Boolean),
      dependencies: Array.from(select('edit-task-dependencies').selectedOptions).map(o => o.value) }).then(ok => { if (ok) editor.hidden = true; });
  });
  on('edit-task-archive', 'click', () => { if (selected) void command('archiveTask', { id: selected.id, archived: true }).then(ok => { if (ok) editor.hidden = true; }); });
  on('repeat-plan-form', 'submit', () => { if (selected) void command('repeatPlan', { id: selected.id, startDate: input('repeat-start').value, endDate: input('repeat-end').value, everyDays: Number(select('repeat-every').value), minutes: Number(input('repeat-minutes').value) }); });
  on('move-plan-form', 'submit', () => { if (selected) void command('movePlan', { id: selected.id, from: input('move-from').value, to: input('move-to').value }); });
  on('manage-project', 'change', () => { input('manage-project-name').value = snapshot?.projects.find(p => p.id === select('manage-project').value)?.name ?? ''; });
  on('manage-project-form', 'submit', () => { void command('updateProject', { id: select('manage-project').value, name: input('manage-project-name').value }); });
  on('manage-project-delete', 'click', () => { void command('deleteProject', { id: select('manage-project').value }); });
  for (const [id, direction] of [['manage-project-up', -1], ['manage-project-down', 1]] as const) on(id, 'click', () => {
    const ids = snapshot?.projects.map(p => p.id) ?? []; const index = ids.indexOf(select('manage-project').value); const target = index + direction;
    if (index < 0 || target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!]; void command('reorderProjects', { ids });
  });
  on('categories-form', 'submit', () => {
    const entries = input('categories-batch').value.split(/\r?\n/).filter(t => t.trim()).map(line => { const parts = line.split(/[,，]/); return { app: parts.length === 2 ? parts[0] : '', category: parts[1] ?? '' }; });
    void command('manageCategories', { entries, remove: [] });
  });
  return {
    open,
    render(data: DesktopSnapshot, busy: boolean) {
      snapshot = data;
      const next = JSON.stringify([data.projects, data.archivedTasks, data.categories]);
      if (next !== key) {
        key = next; const prior = select('manage-project').value; choices(select('manage-project'), data.projects);
        if (data.projects.some(p => p.id === prior)) select('manage-project').value = prior;
        input('manage-project-name').value = data.projects.find(p => p.id === select('manage-project').value)?.name ?? '';
        const archived = doc.getElementById('archived-tasks')!; archived.replaceChildren();
        for (const task of data.archivedTasks ?? []) {
          const button = doc.createElement('button'); button.type = 'button'; button.dataset.restoreTask = task.id; button.textContent = `恢复：${task.title}`;
          button.onclick = () => { void command('archiveTask', { id: task.id, archived: false }); }; archived.append(button);
        }
        if (!archived.childElementCount) archived.textContent = '没有已删除任务';
        const mappings = doc.getElementById('category-mappings')!; mappings.replaceChildren();
        for (const row of data.categories ?? []) {
          const line = doc.createElement('p'); line.textContent = `${row.app} → ${row.category} `;
          const button = doc.createElement('button'); button.type = 'button'; button.textContent = '删除分类'; button.onclick = () => { void command('manageCategories', { entries: [], remove: [row.app] }); };
          line.append(button); mappings.append(line);
        }
      }
      for (const root of [panel, editor]) for (const node of Array.from(root.querySelectorAll<HTMLInputElement>('input,select,textarea,button'))) node.disabled = busy;
    },
    dispose() { disposed = true; panel.remove(); editor.remove(); },
  };
}
