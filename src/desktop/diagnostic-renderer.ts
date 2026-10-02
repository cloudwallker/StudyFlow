export interface DiagnosticStatus {
  enabled: boolean;
  version: string;
  buildId: string;
  runId: string;
  elapsedSeconds: number;
  errors: number;
  warnings: number;
  marks: number;
  writeFailures: number;
  watchdog: boolean;
  lastSaveAt: string | null;
}

export type DiagnosticReply =
  | { ok: true; status: DiagnosticStatus; exported?: boolean }
  | { ok: false; error: string };

export interface DiagnosticAPI {
  request(command: 'status' | 'mark' | 'selfTest' | 'export', payload?: unknown): Promise<DiagnosticReply>;
  reportError?(kind: 'renderer_error' | 'renderer_rejection', frames: string[]): void;
}

/** Test-build controls, isolated from task content and desktop service commands. */
export function mountDiagnostics(doc: Document, api: DiagnosticAPI): () => void {
  let disposed = false;
  let pending = false;
  let enabled = false;
  const panel = doc.createElement('section');
  panel.id = 'diagnostics';
  panel.className = 'daily-panel';
  panel.setAttribute('aria-label', '测试版诊断');
  const heading = doc.createElement('h2'); heading.textContent = '测试版诊断';
  const summary = doc.createElement('p'); summary.id = 'diagnostic-status';
  const help = doc.createElement('p');
  help.textContent = '诊断自检会故意记录一条诊断错误，不修改任务；自检事件单独统计，不计入实际错误。问题详情请填写外部反馈表。';
  const categoryLabel = doc.createElement('label'); categoryLabel.textContent = '问题类别 ';
  const category = doc.createElement('select'); category.id = 'diagnostic-category';
  const categories = { ui: '界面', timer: '计时', reminder: '提醒', import: '导入', other: '其他' };
  for (const [value, label] of Object.entries(categories)) {
    const option = doc.createElement('option'); option.value = value; option.textContent = label; category.append(option);
  }
  categoryLabel.append(category);
  const feedback = doc.createElement('p'); feedback.id = 'diagnostic-feedback'; feedback.setAttribute('role', 'status');
  const mark = doc.createElement('button'); mark.type = 'button'; mark.textContent = '记录一个问题'; mark.id = 'diagnostic-mark';
  const selfTest = doc.createElement('button'); selfTest.type = 'button'; selfTest.textContent = '诊断自检'; selfTest.id = 'diagnostic-self-test';
  const exportButton = doc.createElement('button'); exportButton.type = 'button'; exportButton.textContent = '导出诊断包'; exportButton.id = 'diagnostic-export';
  const buttons = [mark, selfTest, exportButton];
  for (const button of buttons) button.className = 'secondary';
  panel.append(heading, summary, help, categoryLabel, ...buttons, feedback);

  function render(status: DiagnosticStatus): void {
    enabled = status.enabled;
    if (!enabled) { panel.remove(); return; }
    if (!panel.isConnected) (doc.querySelector('main') ?? doc.body).prepend(panel);
    const seconds = Math.max(0, Math.floor(status.elapsedSeconds));
    summary.textContent = `版本 ${status.version} · 构建 ${status.buildId} · 本次运行 ${status.runId} · 运行 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒 · 错误 ${status.errors} · 警告 ${status.warnings} · 问题标记 ${status.marks} · 日志写入失败 ${status.writeFailures} · 运行监测 ${status.watchdog ? '运行中' : '不可用'} · 最近保存 ${status.lastSaveAt ?? '尚未保存'}`;
  }

  async function request(command: 'status' | 'mark' | 'selfTest' | 'export'): Promise<void> {
    if (disposed || pending || (command !== 'status' && !enabled)) return;
    pending = true;
    for (const button of buttons) button.disabled = true;
    const failure = command === 'export' ? '导出失败，请重试。' : command === 'status' ? '诊断状态暂不可用。' : '诊断操作失败，请重试。';
    if (command !== 'status') feedback.textContent = '正在处理…';
    try {
      // Read from the fixed allowlist, never forward arbitrary DOM text.
      const selected = Object.hasOwn(categories, category.value) ? category.value : 'other';
      const reply = command === 'mark' ? await api.request(command, { category: selected }) : await api.request(command);
      if (disposed) return;
      if (!reply.ok) { feedback.textContent = failure; return; }
      render(reply.status);
      if (command === 'mark') feedback.textContent = '已记录问题标记。请在外部反馈表记下当前时间，并描述问题。';
      else if (command === 'selfTest') feedback.textContent = '诊断自检已完成：故意产生的诊断错误单独统计，不修改任务。';
      else if (command === 'export') feedback.textContent = reply.exported === true ? '诊断包已导出。' : '已取消导出。';
    } catch {
      if (!disposed) feedback.textContent = failure;
    } finally {
      pending = false;
      if (!disposed) for (const button of buttons) button.disabled = false;
    }
  }
  const onMark = () => { void request('mark'); };
  const onSelfTest = () => { void request('selfTest'); };
  const onExport = () => { void request('export'); };
  mark.addEventListener('click', onMark); selfTest.addEventListener('click', onSelfTest); exportButton.addEventListener('click', onExport);
  const timer = setInterval(() => { void request('status'); }, 10_000);
  void request('status');
  return () => {
    disposed = true;
    clearInterval(timer);
    mark.removeEventListener('click', onMark); selfTest.removeEventListener('click', onSelfTest); exportButton.removeEventListener('click', onExport);
    panel.remove();
  };
}
