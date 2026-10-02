import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { arch, release } from 'node:os';
import { zipSync, strToU8 } from 'fflate';
import { ImportValidationError } from '../import/json-plan';

const expectedMessages = new Set(['请选择未完成的任务', '请先结束当前计时', '请结束专注后再修改设置', '请结束计时后再删除历史', '请先关闭并保存全天活动记录设置，再删除历史', '导入预览已失效，请重新选择文件或预览', '预览后数据已变化，请重新预览后确认', '请解决导入预览中的冲突', '项目不存在', '任务不存在', '无效完成状态', '白名单最多 100 个应用', '无效活动记录设置', '无效全天记录设置', '计划最多 500 项', '计划任务不能重复', '分配时间须为 0—1440 分钟整数', '计划任务不存在', '每项复盘最多 6000 字', '无效参数', '请输入有效文本', '时长须为 1—240 分钟的整数', '不支持的操作']);
export function isExpectedRejection(error: unknown): boolean {
  return error instanceof ImportValidationError || (error instanceof Error && error.name === 'Error' && !('code' in error) && expectedMessages.has(error.message));
}

const errors = new Set(['command_failed', 'sample_failed', 'save_failed', 'notification_failed', 'startup_failed', 'renderer_error', 'renderer_rejection', 'renderer_gone', 'child_gone', 'uncaught_exception', 'unhandled_rejection', 'tick_failed', 'watchdog_failed', 'export_failed']);
const warnings = new Set(['previous_unclean', 'renderer_unresponsive', 'observation_gap', 'tray_failed']);
const events = new Set([...errors, ...warnings, 'startup', 'ready', 'clean_exit', 'command_ok', 'command_rejected', 'sample_ok', 'sample_unknown', 'sample_started', 'sample_exit', 'sample_recovered', 'save_ok', 'notification_sent', 'notification_dismissed', 'window_hidden', 'window_shown', 'lock', 'unlock', 'suspend', 'resume', 'session_end', 'query_session_end', 'health', 'self_test', 'issue_mark', 'watchdog_started', 'watchdog_exit', 'renderer_responsive', 'export_ok', 'fatal_exit']);
const labels: Record<string, ReadonlySet<string>> = {
  command: new Set(['snapshot', 'createProject', 'createTask', 'setTaskDone', 'settings', 'start', 'stop', 'pause', 'resume', 'deleteHistory', 'daily', 'savePlan', 'saveReview', 'classifyApp', 'previewImport', 'confirmImport', 'cancelImport']),
  category: new Set(['ui', 'timer', 'reminder', 'import', 'other']),
  reason: new Set(['timeout', 'protocol', 'spawn', 'exit', 'pipe', 'disposed', 'busy', 'crashed', 'killed', 'oom', 'clean-exit', 'abnormal-exit', 'launch-failed', 'integrity-failure', 'unknown']),
  kind: new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError', 'EvalError', 'Unknown']),
  code: new Set(['SQLITE_BUSY', 'SQLITE_FULL', 'SQLITE_CORRUPT', 'SQLITE_READONLY', 'ERR_SQLITE_ERROR', 'EACCES', 'EPERM', 'ENOENT', 'ENOSPC', 'EIO', 'UNKNOWN']),
  area: new Set(['history', 'activity', 'database', 'main', 'renderer']),
  timerStatus: new Set(['idle', 'running', 'paused', 'stopped', 'awaiting-next']),
};
const numbers = new Set(['durationMs', 'rssMB', 'cpuPercent', 'processCount', 'remainingSeconds', 'lagMs', 'exitCode', 'elapsedSeconds', 'samplingSuccess', 'samplingUnknown', 'samplingFailures']);
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const runFile = new RegExp(`^(${uuid})\\.(summary\\.json(?:\\.tmp)?|heartbeat|done|watchdog\\.jsonl(?:\\.1)?)$`);

/** Error messages and full stacks can contain imported content and paths. Keep only safe codes and bundled frame positions. */
export function safeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { kind: 'Unknown' };
  const code = 'code' in error && typeof error.code === 'string' && labels.code!.has(error.code) ? error.code : 'UNKNOWN';
  const frames = [...(error.stack ?? '').matchAll(/(?:[/\\( ])((?:main|preload)\.cjs|renderer\.js):(\d+):(\d+)/g)]
    .slice(0, 8).map(match => `${match[1]}:${match[2]}:${match[3]}`);
  return { kind: labels.kind!.has(error.name) ? error.name : 'Unknown', code, frames };
}
function fields(input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (numbers.has(key) && typeof value === 'number' && Number.isFinite(value)) result[key] = value;
    else if (labels[key]?.has(typeof value === 'string' ? value : '')) result[key] = value;
    else if (key === 'frames' && Array.isArray(value)) result[key] = value.filter((v): v is string => typeof v === 'string' && /^(main\.cjs|preload\.cjs|renderer\.js):\d+:\d+$/.test(v)).slice(0, 8);
  }
  return result;
}

export class Diagnostics {
  readonly runId = randomUUID();
  private readonly startedAt = Date.now();
  private counts: Record<string, number> = {};
  private writeFailures = 0;
  private ended = false;
  private watchdog = false;
  private lastSaveAt: string | null = null;
  private readonly maxBytes: number;
  constructor(readonly directory: string, private readonly options: { version: string; buildId: string; maxBytes?: number }) {
    this.maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
    mkdirSync(directory, { recursive: true });
    this.retainRuns();
    const active = join(directory, 'active-run.txt');
    if (existsSync(active)) {
      const previous = readFileSync(active, 'utf8').trim();
      if (new RegExp(`^${uuid}$`).test(previous) && !existsSync(join(directory, `${previous}.done`))) this.record('previous_unclean');
    }
    writeFileSync(active, this.runId, 'utf8');
    this.record('startup'); this.heartbeat();
  }
  private retainRuns(): void {
    const files = readdirSync(this.directory).filter(name => runFile.test(name));
    const summaries = files.filter(name => name.endsWith('.summary.json')).sort((a, b) => lstatSync(join(this.directory, b)).mtimeMs - lstatSync(join(this.directory, a)).mtimeMs);
    const keep = new Set(summaries.slice(0, 7).map(name => name.split('.')[0]));
    for (const name of files) if (!keep.has(name.split('.')[0])) unlinkSync(join(this.directory, name));
  }
  record(event: string, input: Record<string, unknown> = {}): void {
    if (!events.has(event) || this.ended) return;
    this.counts[event] = (this.counts[event] ?? 0) + 1;
    if (event === 'health') input = { ...input, samplingSuccess: this.counts.sample_ok ?? 0, samplingUnknown: this.counts.sample_unknown ?? 0, samplingFailures: this.counts.sample_failed ?? 0 };
    if (event === 'save_ok') this.lastSaveAt = new Date().toISOString();
    // Successful samples are aggregated in health snapshots, not activity history.
    if (event === 'sample_ok' || event === 'sample_unknown') return;
    const line = JSON.stringify({ timestamp: new Date().toISOString(), runId: this.runId, event, level: errors.has(event) ? 'error' : warnings.has(event) ? 'warning' : 'info', ...fields(input) }) + '\n';
    try {
      const path = join(this.directory, 'events.jsonl');
      if (existsSync(path) && lstatSync(path).size + Buffer.byteLength(line) > this.maxBytes) {
        const oldest = `${path}.4`; if (existsSync(oldest)) unlinkSync(oldest);
        for (let index = 3; index >= 1; index--) if (existsSync(`${path}.${index}`)) renameSync(`${path}.${index}`, `${path}.${index + 1}`);
        renameSync(path, `${path}.1`);
      }
      appendFileSync(path, line, 'utf8');
    } catch { this.writeFailures++; }
  }
  setWatchdog(running: boolean): void { this.watchdog = running; }
  status() {
    return { enabled: true, version: this.options.version, buildId: this.options.buildId, runId: this.runId,
      elapsedSeconds: Math.max(0, Math.floor((Date.now() - this.startedAt) / 1000)),
      errors: [...errors].reduce((sum, key) => sum + (this.counts[key] ?? 0), 0),
      warnings: [...warnings].reduce((sum, key) => sum + (this.counts[key] ?? 0), 0), marks: this.counts.issue_mark ?? 0,
      writeFailures: this.writeFailures, watchdog: this.watchdog, lastSaveAt: this.lastSaveAt };
  }
  private summary() {
    return { ...this.status(), startedAt: new Date(this.startedAt).toISOString(), updatedAt: new Date().toISOString(),
      cleanExit: this.ended, counts: this.counts, environment: { platform: process.platform, arch: arch(), osRelease: release(), node: process.versions.node, electron: process.versions.electron ?? null },
      limitations: ['运行时长包含锁屏和休眠，不代表有效学习时间。', 'CPU 和内存为 Electron 进程合计，不包含原生采集与监测器。', '自检和输入校验拒绝不计为程序错误。', '无日志不等于无错误；突然断电可能丢失最近日志。', '报告不包含数据库、任务、原始活动、窗口标题或截图。'] };
  }
  heartbeat(): void {
    try {
      writeFileSync(join(this.directory, `${this.runId}.heartbeat`), 'alive', 'utf8');
      const path = join(this.directory, `${this.runId}.summary.json`);
      writeFileSync(`${path}.tmp`, JSON.stringify(this.summary(), null, 2), 'utf8'); renameSync(`${path}.tmp`, path);
    } catch { this.writeFailures++; }
  }
  finish(clean = true): void {
    if (this.ended) return;
    this.record(clean ? 'clean_exit' : 'fatal_exit'); this.ended = clean; this.heartbeat();
    if (clean) { try { writeFileSync(join(this.directory, `${this.runId}.done`), 'clean', 'utf8'); } catch { this.writeFailures++; } }
  }
  exportZip(): Uint8Array {
    this.heartbeat();
    const files: Record<string, Uint8Array> = { 'report.json': strToU8(JSON.stringify(this.summary(), null, 2)) };
    let bytes = 0;
    for (const name of readdirSync(this.directory).sort()) {
      if (!/^events\.jsonl(?:\.[1-4])?$/.test(name) && !(runFile.test(name) && (name.endsWith('.summary.json') || name.includes('.watchdog.jsonl')))) continue;
      const path = join(this.directory, name); const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      bytes += stat.size;
      if (stat.size > 5 * 1024 * 1024 || bytes > 50 * 1024 * 1024) throw new Error('诊断文件超出导出上限');
      files[name] = readFileSync(path);
    }
    return zipSync(files, { level: 6 });
  }
}
