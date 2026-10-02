import type { DesktopAPI, DesktopSnapshot } from './contracts';
import { MAX_IMPORT_BYTES, type ImportPreview, type ImportChoices } from '../import/json-plan';
import { parseXlsxImport } from '../import/xlsx-plan';
import { ImportValidationError } from '../import/json-plan';

export function mountImport(doc: Document, api: DesktopAPI, onImported: (snapshot: DesktopSnapshot, firstDate?: string) => void): () => void {
  const el = (id: string) => doc.getElementById(id)!;
  const file = el('import-file') as HTMLInputElement;
  const json = el('import-json') as HTMLTextAreaElement;
  const pastePreview = el('import-paste-preview') as HTMLButtonElement;
  const confirm = el('import-confirm') as HTMLButtonElement;
  const retry = el('import-repreview') as HTMLButtonElement;
  const updates = doc.createElement('div'); updates.id = 'import-updates';
  el('import-tasks').parentElement!.insertBefore(updates, el('import-tasks').previousElementSibling);
  let content = ''; let preview: ImportPreview | null = null; let busy = false; let disposed = false; let generation = 0;
  let source: 'file' | 'paste' | null = null;
  let reader: FileReader | null = null;
  const listeners: Array<() => void> = [];
  const status = (message: string) => { el('import-status').textContent = message; };
  function on(id: string, event: string, action: () => void) {
    const handler = () => { if (!disposed) action(); };
    el(id).addEventListener(event, handler); listeners.push(() => el(id).removeEventListener(event, handler));
  }
  function controls() {
    file.disabled = busy; json.disabled = busy; pastePreview.disabled = busy || !json.value.trim();
    retry.disabled = busy || (source === 'paste' ? !json.value.trim() : !content);
    (el('import-start-date') as HTMLInputElement).disabled = busy;
    confirm.disabled = busy || !preview || preview.duplicate || !!preview.errors.length;
    for (const input of Array.from(el('import-preview').querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select'))) input.disabled = busy;
    (el('import-cancel') as HTMLButtonElement).disabled = busy;
  }
  function clearPreview() {
    preview = null; el('import-preview').hidden = true;
    for (const id of ['import-projects', 'import-days', 'import-tasks', 'import-errors', 'import-summary']) el(id).replaceChildren();
    updates.replaceChildren();
  }
  function changeSource(next: 'file' | 'paste' | null) {
    if (source !== next) (el('import-start-date') as HTMLInputElement).value = '';
    source = next; generation++; content = ''; clearPreview();
    if (next !== 'file') file.value = '';
    if (next !== 'paste') json.value = '';
  }
  function choices(): ImportChoices {
    const projectIds = Object.fromEntries(Array.from(el('import-projects').querySelectorAll('select')).filter(s => s.value).map(s => [s.dataset.project!, s.value]));
    const replaceDates = Array.from(el('import-days').querySelectorAll<HTMLInputElement>('input:checked')).map(i => i.value);
    const updateTaskKeys = Array.from(updates.querySelectorAll<HTMLInputElement>('input:checked')).map(input => input.value);
    return { projectIds, replaceDates, updateTaskKeys };
  }
  function render(value: ImportPreview) {
    preview = value; el('import-preview').hidden = false;
    el('import-errors').textContent = value.errors.join('\n');
    const scheduled = new Set(value.plans.map(plan => plan.taskKey));
    const unscheduled = value.tasks.filter(task => !scheduled.has(task.taskKey));
    const dates = value.days.map(day => day.date).sort();
    const range = dates.length ? `${dates[0]} 至 ${dates.at(-1)}` : '尚未安排日期';
    const minutes = value.plans.reduce((total, plan) => total + plan.minutes, 0);
    el('import-summary').textContent = `${value.tasks.length} 个任务 · ${dates.length} 天计划 · ${range} · 本次计划共 ${minutes} 分钟 · ${unscheduled.length} 个任务未安排日期`;
    const projects = el('import-projects'); projects.replaceChildren();
    for (const project of value.projects) {
      const row = doc.createElement('div');
      row.textContent = `${project.name}：${project.candidates.length ? '复用已有项目' : '创建新项目'}`;
      if (project.candidates.length > 1) {
        const select = doc.createElement('select'); select.dataset.project = project.name; select.setAttribute('aria-label', `${project.name} 选择项目`);
        const empty = doc.createElement('option'); empty.value = ''; empty.textContent = '请选择同名项目'; select.append(empty);
        for (const item of project.candidates) {
          const option = doc.createElement('option'); option.value = item.id; option.textContent = `${item.name}（ID: ${item.id}）`; select.append(option);
        }
        select.value = project.selectedId ?? ''; row.append(select);
      }
      projects.append(row);
    }
    if (!value.projects.length) projects.textContent = '任务均不分配项目';
    updates.replaceChildren();
    if (value.taskUpdates.length) {
      const heading = doc.createElement('h3'); heading.textContent = '更新已有任务'; updates.append(heading);
      for (const update of value.taskUpdates) {
        const label = doc.createElement('label'); const checkbox = doc.createElement('input');
        checkbox.type = 'checkbox'; checkbox.value = update.taskKey; checkbox.checked = update.selected;
        const before = `${update.before.title} / ${update.before.project || '未分配项目'} / ${update.before.estimateMinutes} 分钟`;
        const after = `${update.after.title} / ${update.after.project || '未分配项目'} / ${update.after.estimateMinutes} 分钟`;
        label.append(checkbox, doc.createTextNode(`更新键 ${update.taskKey}：${before} → ${after}`)); updates.append(label);
      }
    }
    const tasks = el('import-tasks'); tasks.replaceChildren();
    for (const task of value.tasks) {
      const row = doc.createElement('li'); row.textContent = `${task.title}${scheduled.has(task.taskKey) ? '' : ' · 未安排日期'} · ${task.project || '未分配项目'} · 预计 ${task.estimateMinutes} 分钟 · 键 ${task.taskKey}`; tasks.append(row);
    }
    const days = el('import-days'); days.replaceChildren();
    const titles = new Map(value.tasks.map(t => [t.taskKey, t.title]));
    for (const day of value.days) {
      const row = doc.createElement('div'); row.className = 'import-day';
      const heading = doc.createElement('p'); heading.textContent = `${day.date}：已有 ${day.existingCount} 项，导入 ${day.incomingCount} 项，${day.replace ? '替换后' : '合并后'} ${day.totalMinutes} 分钟`; row.append(heading);
      if (day.existingCount) {
        const label = doc.createElement('label'); const checkbox = doc.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = day.date; checkbox.checked = day.replace;
        label.append(checkbox, doc.createTextNode('替换该日全部计划（保留任务及实际用时）')); row.append(label);
      }
      const list = doc.createElement('ul');
      if (day.changes) for (const change of day.changes) {
        const item = doc.createElement('li'); const { before, after } = change;
        if (!before && after) item.textContent = `新增：${after.title} · ${after.minutes} 分钟`;
        else if (before && !after) item.textContent = `移除：${before.title} · ${before.minutes} 分钟`;
        else if (before && after) {
          const changed = before.title !== after.title || before.minutes !== after.minutes;
          const title = before.title === after.title ? after.title : `${before.title} → ${after.title}`;
          item.textContent = changed ? `修改：${title} · ${before.minutes} → ${after.minutes} 分钟` : `保留：${after.title} · ${after.minutes} 分钟`;
        }
        list.append(item);
      }
      else for (const plan of value.plans.filter(p => p.date === day.date)) {
        const item = doc.createElement('li'); item.textContent = `${titles.get(plan.taskKey)} · ${plan.minutes} 分钟`; list.append(item);
      }
      row.append(list); days.append(row);
    }
    if (!value.days.length) days.textContent = '仅导入任务，不安排日期';
    status(value.duplicate ? '此内容已导入，已跳过，不会重复创建。' : value.errors.length ? '请处理下方问题，修改选择后重新预览。' : `校验通过：${value.tasks.length} 个任务、${value.days.length} 天计划。${value.inferredPlans ? `其中 ${value.inferredPlans} 条日期由标题与第 1 天日期推导，请核对。` : ''}确认后才会保存。`);
  }
  async function requestPreview() {
    if (busy || disposed || !content) return;
    const selected = choices(); const current = generation;
    busy = true; preview = null; el('import-preview').hidden = true; controls(); status('正在校验…');
    try {
      const reply = await api.request('previewImport', { content, choices: selected, startDate: (el('import-start-date') as HTMLInputElement).value });
      if (disposed || current !== generation) return;
      if (reply.ok && reply.value.importPreview) render(reply.value.importPreview);
      else { el('import-preview').hidden = true; status(reply.ok ? '未收到预览，请重试' : reply.error); }
    } catch { if (!disposed && current === generation) status('无法读取本地导入预览，请重试'); }
    finally { busy = false; if (!disposed) controls(); }
  }
  function previewPaste() {
    if (busy || disposed) return;
    if (source !== 'paste') changeSource('paste');
    const draft = json.value;
    if (draft.length > MAX_IMPORT_BYTES || new TextEncoder().encode(draft).length > MAX_IMPORT_BYTES) {
      content = ''; clearPreview(); status('粘贴内容不能超过 1 MiB'); controls(); return;
    }
    const trimmed = draft.trim();
    const fenced = /^```(?:json)?[\t ]*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
    content = fenced ? fenced[1]! : trimmed;
    if (!content) { clearPreview(); status('请先粘贴 JSON 内容'); controls(); return; }
    void requestPreview();
  }
  on('import-json', 'input', () => {
    changeSource('paste');
    status('粘贴内容已修改，请预览后再确认导入'); controls();
  });
  on('import-paste-preview', 'click', previewPaste);
  on('import-file', 'change', () => {
    if (busy) return;
    const selected = file.files?.[0]; changeSource('file'); const current = generation;
    (el('import-start-date') as HTMLInputElement).value = '';
    controls();
    if (!selected) return;
    if (!/\.(json|xlsx)$/i.test(selected.name)) { status('请选择 .json 或 .xlsx 文件'); return; }
    if (selected.size > MAX_IMPORT_BYTES) { status('文件不能超过 1 MiB'); return; }
    busy = true; controls(); status('正在读取文件…');
    reader = new FileReader();
    reader.onload = () => {
      if (disposed || current !== generation) return;
      busy = false;
      try {
        if (!reader?.result || typeof reader.result === 'string') throw new Error('读取失败');
        content = /\.xlsx$/i.test(selected.name)
          ? JSON.stringify(parseXlsxImport(new Uint8Array(reader.result)))
          : new TextDecoder('utf-8', { fatal: true }).decode(reader.result);
      } catch (error) {
        content = '';
        status(error instanceof ImportValidationError ? error.message : /\.xlsx$/i.test(selected.name) ? '无法读取 XLSX，请使用未加密的模板文件' : '文件须使用有效 UTF-8 编码');
        controls(); return;
      }
      if (!content) { status('文件为空，请检查内容'); controls(); return; }
      void requestPreview();
    };
    reader.onerror = () => { if (!disposed && current === generation) { busy = false; status('无法读取文件，请重新选择'); controls(); } };
    reader.readAsArrayBuffer(selected);
  });
  on('import-preview', 'change', () => { preview = null; status('选择已修改，请点击「重新预览」检查结果'); controls(); });
  on('import-start-date', 'change', () => {
    preview = null; el('import-days').replaceChildren();
    status('第 1 天日期已修改，请重新预览并核对；文件中已有的明确日期保持优先。'); controls();
  });
  on('import-repreview', 'click', () => { if (source === 'paste') previewPaste(); else void requestPreview(); });
  on('import-cancel', 'click', () => {
    if (busy) return;
    changeSource(null); status('已取消，没有写入数据'); controls();
    void api.request('cancelImport').catch(() => {});
  });
  on('import-confirm', 'click', () => {
    if (busy || !preview || preview.errors.length || preview.duplicate) return;
    if (!doc.dispatchEvent(new CustomEvent('studyflow-before-change', { detail: 'confirmImport', cancelable: true }))) {
      status('请先保存每日计划编辑或等待当前保存完成，再确认导入'); return;
    }
    const token = preview.token; const firstDate = preview.days[0]?.date;
    preview = null; busy = true; controls(); status('正在导入…');
    doc.dispatchEvent(new Event('studyflow-import-start'));
    void (async () => {
      try {
        const reply = await api.request('confirmImport', { token });
        if (disposed) return;
        if (!reply.ok) { status(reply.error + '；请重新预览后重试'); return; }
        changeSource(null);
        status(reply.value.importResult === 'duplicate' ? '此内容已导入，已跳过。' : firstDate ? '导入成功。已打开计划首日，可通过日历逐日学习；点击「今天」回到当天任务。' : '导入成功。任务尚未安排日期，可在每日计划中添加。');
        if (reply.value.importResult === 'imported') onImported(reply.value, firstDate);
      } catch { if (!disposed) status('未能确认导入结果，请重新预览；已保存的内容会自动去重'); }
      finally { busy = false; if (!disposed) { controls(); doc.dispatchEvent(new Event('studyflow-import-end')); } }
    })();
  });
  controls();
  return () => { disposed = true; generation++; reader?.abort(); listeners.forEach(remove => remove()); };
}
