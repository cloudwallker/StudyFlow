import { app, dialog, type BrowserWindow } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { Diagnostics, safeError } from './diagnostics';
import { buildInfo } from './build-info';
import type { DiagnosticReply } from './diagnostic-renderer';
import type { FocusState } from './contracts';

export class DiagnosticRuntime {
  readonly log: Diagnostics;
  private watchdog: ChildProcess | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastBeat = performance.now();
  private lastHealth = -Infinity;
  private exporting = false;
  constructor(directory: string) {
    this.log = new Diagnostics(join(directory, 'diagnostics'), { version: buildInfo.version, buildId: buildInfo.id });
  }
  start(window: BrowserWindow, state: () => FocusState | undefined): void {
    const log = this.log;
    window.webContents.on('render-process-gone', (_event, details) => log.record('renderer_gone', { reason: details.reason, exitCode: details.exitCode }));
    window.on('unresponsive', () => log.record('renderer_unresponsive'));
    window.on('responsive', () => log.record('renderer_responsive'));
    window.on('hide', () => log.record('window_hidden'));
    window.on('show', () => log.record('window_shown'));
    app.on('child-process-gone', (_event, details) => log.record('child_gone', { reason: details.reason, exitCode: details.exitCode }));
    // Windows libuv otherwise places children in a kill-on-parent-exit job.
    // The watchdog must survive just long enough to observe the parent's exit;
    // it retains the parent handle and terminates itself, never auto-restarting.
    const helper = spawn(join(__dirname, 'native', 'StudyFlowWatchdog.exe'), [String(process.pid), log.directory, log.runId], { detached: true, windowsHide: true, stdio: 'ignore' });
    this.watchdog = helper;
    helper.on('spawn', () => { log.setWatchdog(true); log.record('watchdog_started'); });
    helper.on('error', error => { log.setWatchdog(false); log.record('watchdog_failed', safeError(error)); });
    helper.on('exit', code => { this.watchdog = null; log.setWatchdog(false); log.record(code === 0 ? 'watchdog_exit' : 'watchdog_failed', { exitCode: code ?? -1 }); });
    this.timer = setInterval(() => {
      const now = performance.now();
      if (now - this.lastBeat > 20000) log.record('observation_gap', { durationMs: Math.round(now - this.lastBeat) });
      this.lastBeat = now;
      if (now - this.lastHealth >= 60000) {
        this.lastHealth = now;
        const metrics = app.getAppMetrics(); const focus = state();
        log.record('health', { rssMB: Math.round(metrics.reduce((sum, item) => sum + item.memory.workingSetSize, 0) / 1024), cpuPercent: Math.round(metrics.reduce((sum, item) => sum + item.cpu.percentCPUUsage, 0) * 100) / 100,
          processCount: metrics.length, timerStatus: focus?.timer?.status ?? 'idle', remainingSeconds: focus?.remainingSeconds ?? 0 });
      }
      log.heartbeat();
    }, 5000);
  }
  async request(command: unknown, payload: unknown): Promise<DiagnosticReply> {
    const log = this.log;
    if (command === 'status') return { ok: true, status: log.status() };
    if (command === 'mark') {
      if (!payload || typeof payload !== 'object' || !('category' in payload) || typeof payload.category !== 'string' || !['ui', 'timer', 'reminder', 'import', 'other'].includes(payload.category)) return { ok: false, error: '请选择有效的问题类型' };
      log.record('issue_mark', { category: payload.category }); log.heartbeat();
      return { ok: true, status: log.status() };
    }
    if (command === 'selfTest') {
      log.record('self_test', safeError(new Error('Controlled diagnostic self test'))); log.heartbeat();
      return log.status().writeFailures > 0 ? { ok: false, error: '日志写入失败，请检查测试数据目录的可用空间和权限' } : { ok: true, status: log.status() };
    }
    if (command !== 'export') return { ok: false, error: '不支持的诊断操作' };
    if (this.exporting) return { ok: false, error: '正在导出，请稍候' };
    this.exporting = true;
    try {
      const result = await dialog.showSaveDialog({ title: '导出本地诊断包（不含任务数据库）', defaultPath: `StudyFlow-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`, filters: [{ name: 'ZIP', extensions: ['zip'] }] });
      if (result.canceled || !result.filePath) return { ok: true, exported: false, status: log.status() };
      writeFileSync(result.filePath, log.exportZip()); log.record('export_ok');
      return { ok: true, exported: true, status: log.status() };
    } catch (error) { log.record('export_failed', safeError(error)); return { ok: false, error: '诊断包导出失败，请检查保存位置的权限和空间' }; }
    finally { this.exporting = false; }
  }
  finish(clean: boolean): void {
    clearInterval(this.timer); this.log.finish(clean);
    // The watchdog owns a parent process handle and exits after this process exits.
    this.watchdog?.unref();
  }
}
