// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { mountImport } from '../src/desktop/import-renderer';
import { DesktopService } from '../src/desktop/service';
import { StudyStore } from '../src/desktop/store';
import { MAX_IMPORT_BYTES, type ImportDocument } from '../src/import/json-plan';

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); });
function setup(delayPreview?: () => Promise<void>) {
  document.body.innerHTML = `<input id="import-file" type="file"><textarea id="import-json"></textarea>
    <button id="import-paste-preview">预览粘贴内容</button><input id="import-start-date" type="date">
    <p id="import-status"></p><div id="import-preview" hidden><p id="import-summary"></p>
    <p id="import-errors"></p><div id="import-projects"></div><h3>任务</h3><ul id="import-tasks"></ul><div id="import-days"></div></div>
    <button id="import-repreview">重新预览</button><button id="import-cancel">取消</button><button id="import-confirm">确认导入</button>`;
  const store = new StudyStore(':memory:');
  const service = new DesktopService(store, { state: () => ({ running: false, taskId: null, remainingSeconds: 0, totalSeconds: 0, app: null, message: '', notification: 'none' }), start() {}, stop() {} });
  const cleanup = mountImport(document, { request: async (command, payload) => {
    try {
      const value = service.execute(command, payload);
      if (command === 'previewImport') await delayPreview?.();
      return { ok: true, value };
    }
    catch (error) { return { ok: false, error: (error as Error).message }; }
  } }, () => {});
  cleanups.push(() => { cleanup(); store.close(); });
  return { store, service };
}
function element<T extends HTMLElement = HTMLElement>(id: string): T { return document.getElementById(id) as T; }
function paste(content: string) { const input = element<HTMLTextAreaElement>('import-json'); input.value = content; input.dispatchEvent(new Event('input', { bubbles: true })); }
function click(id: string) { element<HTMLButtonElement>(id).click(); }
function selectFile(content: string) {
  const input = element<HTMLInputElement>('import-file');
  Object.defineProperty(input, 'files', { configurable: true, value: [new File([content], 'plan.json')] });
  input.dispatchEvent(new Event('change'));
}
async function ready() { await vi.waitFor(() => expect(element('import-preview').hidden).toBe(false)); }
function simple(key = 'new', date = '2026-09-11'): ImportDocument {
  return { schemaVersion: 1, tasks: [{ taskKey: key, project: '', title: '<img src=x>学习任务', estimateMinutes: 30 }], plans: [{ date, taskKey: key, minutes: 30 }] };
}

it.each(['plain', 'json-fence', 'plain-fence'] as const)('previews %s pasted JSON safely and only writes on confirmation', async format => {
  const { store } = setup(); const raw = JSON.stringify(simple());
  paste(format === 'plain' ? raw : `\n\`\`\`${format === 'json-fence' ? 'json' : ''}\n${raw}\n\`\`\`\n`);
  expect(store.snapshot().tasks).toHaveLength(0); expect(element('import-preview').hidden).toBe(true);
  click('import-paste-preview'); await ready();
  expect(element('import-tasks').textContent).toContain('<img src=x>学习任务');
  expect(document.querySelector('#import-preview img')).toBeNull();
  expect(store.snapshot().tasks).toHaveLength(0);
  click('import-confirm');
  await vi.waitFor(() => expect(store.snapshot().tasks).toHaveLength(1));
  expect(element<HTMLTextAreaElement>('import-json').value).toBe('');
  expect(store.daily('2026-09-11').plan?.entries[0]?.minutes).toBe(30);
});

it('invalidates pasted previews on editing and requires another preview before saving', async () => {
  const { store } = setup(); paste(JSON.stringify(simple())); click('import-paste-preview'); await ready();
  const changed = simple(); changed.tasks[0]!.title = '编辑后的任务';
  paste(JSON.stringify(changed));
  expect(element<HTMLButtonElement>('import-confirm').disabled).toBe(true);
  expect(element('import-preview').hidden).toBe(true);
  click('import-confirm'); expect(store.snapshot().tasks).toHaveLength(0);
  click('import-paste-preview'); await ready(); click('import-confirm');
  await vi.waitFor(() => expect(store.snapshot().tasks[0]?.title).toBe('编辑后的任务'));
});

it('cancels pasted content and its choices without saving a draft or tasks', async () => {
  const { store } = setup(); paste(JSON.stringify(simple())); click('import-paste-preview'); await ready();
  click('import-cancel');
  expect(element<HTMLTextAreaElement>('import-json').value).toBe('');
  expect(element('import-preview').hidden).toBe(true);
  expect(element<HTMLButtonElement>('import-repreview').disabled).toBe(true);
  expect(element<HTMLButtonElement>('import-confirm').disabled).toBe(true);
  expect(store.snapshot().tasks).toHaveLength(0);
});

it.each(['file-to-paste', 'paste-to-file'] as const)('clears update and replacement choices when switching %s', async direction => {
  const { store, service } = setup(); const original = simple('old');
  const first = service.execute('previewImport', { content: JSON.stringify(original) }).importPreview!;
  service.execute('confirmImport', { token: first.token });
  const changed = simple('old'); changed.tasks[0]!.title = '需要确认的更新';
  if (direction === 'file-to-paste') selectFile(JSON.stringify(changed));
  else { paste(JSON.stringify(changed)); click('import-paste-preview'); }
  await ready();
  for (const checkbox of Array.from(document.querySelectorAll<HTMLInputElement>('#import-updates input, #import-days input'))) {
    checkbox.checked = true; checkbox.dispatchEvent(new Event('change', { bubbles: true }));
  }
  click('import-repreview');
  await vi.waitFor(() => expect(element<HTMLButtonElement>('import-confirm').disabled).toBe(false));
  const next = JSON.stringify(simple('new', '2026-09-12'));
  if (direction === 'file-to-paste') { paste(next); click('import-paste-preview'); }
  else selectFile(next);
  await vi.waitFor(() => expect(element('import-tasks').textContent).toContain('键 new'));
  expect(element('import-errors').textContent).toBe('');
  expect(document.querySelectorAll('#import-updates input')).toHaveLength(0);
  click('import-confirm'); await vi.waitFor(() => expect(store.snapshot().tasks).toHaveLength(2));
  expect(store.daily('2026-09-11').plan?.entries[0]?.title).toBe('<img src=x>学习任务');
});

it('discards an obsolete delayed preview after pasted content changes', async () => {
  let release = () => {};
  const { store } = setup(() => new Promise<void>(resolve => { release = resolve; }));
  paste(JSON.stringify(simple('old'))); click('import-paste-preview');
  const next = simple('new'); next.tasks[0]!.title = '新的草稿'; paste(JSON.stringify(next));
  release();
  await vi.waitFor(() => expect(element<HTMLTextAreaElement>('import-json').disabled).toBe(false));
  expect(element('import-preview').hidden).toBe(true);
  expect(element<HTMLButtonElement>('import-confirm').disabled).toBe(true);
  expect(element<HTMLTextAreaElement>('import-json').value).toContain('新的草稿');
  click('import-confirm'); expect(store.snapshot().tasks).toHaveLength(0);
  click('import-paste-preview'); release(); await ready(); click('import-confirm');
  await vi.waitFor(() => expect(store.snapshot().tasks[0]?.title).toBe('新的草稿'));
});

it('deduplicates a fenced paste of content already imported from a file', async () => {
  const { store } = setup(); const content = JSON.stringify(simple());
  selectFile(content); await ready(); click('import-confirm');
  await vi.waitFor(() => expect(store.snapshot().tasks).toHaveLength(1));
  paste(`\`\`\`json\n${content}\n\`\`\``); click('import-paste-preview'); await ready();
  expect(element('import-status').textContent).toContain('已导入');
  expect(element<HTMLButtonElement>('import-confirm').disabled).toBe(true);
  expect(store.snapshot().tasks).toHaveLength(1);
});

it('summarizes the incoming range and minutes and identifies unscheduled tasks', async () => {
  setup(); const value = simple();
  value.tasks.push({ taskKey: 'second', project: '', title: '第二个任务', estimateMinutes: 60 }, { taskKey: 'later', project: '', title: '暂不安排', estimateMinutes: 20 });
  value.plans.push({ date: '2026-09-13', taskKey: 'second', minutes: 60 });
  paste(JSON.stringify(value)); click('import-paste-preview'); await ready();
  const summary = element('import-summary').textContent!;
  expect(summary).toContain('3 个任务'); expect(summary).toContain('2 天计划');
  expect(summary).toContain('2026-09-11'); expect(summary).toContain('2026-09-13');
  expect(summary).toContain('90 分钟'); expect(summary).toContain('1 个任务未安排日期');
  expect(element('import-tasks').textContent).toContain('暂不安排 · 未安排日期');
});

it('shows a minutes change and the exact entries removed by replacing a day', async () => {
  const { store, service } = setup(); const original = simple('old');
  const first = service.execute('previewImport', { content: JSON.stringify(original) }).importPreview!;
  service.execute('confirmImport', { token: first.token });
  const task = store.snapshot().tasks[0]!; const kept = store.createTask({ title: '原有练习', projectId: null, estimateMinutes: 20 });
  store.savePlan('2026-09-11', [{ taskId: task.id, minutes: 30 }, { taskId: kept.id, minutes: 20 }]);
  const changed = simple('old'); changed.plans[0]!.minutes = 60;
  paste(JSON.stringify(changed)); click('import-paste-preview'); await ready();
  expect(element('import-days').textContent).toContain('30 → 60 分钟');
  expect(element('import-days').textContent).toContain('保留：原有练习');
  const replace = document.querySelector<HTMLInputElement>('#import-days input')!;
  replace.checked = true; replace.dispatchEvent(new Event('change', { bubbles: true })); click('import-repreview');
  await vi.waitFor(() => expect(element('import-days').textContent).toContain('移除：原有练习 · 20 分钟'));
  expect(store.daily('2026-09-11').plan?.entries).toHaveLength(2);
});

it.each(['prose-around-fence', 'incomplete-fence', 'oversized'] as const)('rejects invalid pasted %s without enabling an old confirmation', async kind => {
  const { store } = setup(); paste(JSON.stringify(simple())); click('import-paste-preview'); await ready();
  const content = kind === 'oversized' ? '中'.repeat(MAX_IMPORT_BYTES / 2)
    : `${kind === 'prose-around-fence' ? '这里是计划：\n' : ''}\`\`\`json\n${JSON.stringify(simple())}${kind === 'prose-around-fence' ? '\n```' : ''}`;
  paste(content); click('import-paste-preview');
  await vi.waitFor(() => expect(element('import-status').textContent).toMatch(kind === 'oversized' ? /1 MiB/ : /语法|JSON/));
  expect(element('import-preview').hidden).toBe(true);
  expect(element<HTMLButtonElement>('import-confirm').disabled).toBe(true);
  expect(store.snapshot().tasks).toHaveLength(0);
});
