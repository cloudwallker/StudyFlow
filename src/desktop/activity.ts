import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { record, textValue, type ActivitySource } from './contracts';
import type { ActivitySample, ActivitySampler } from '../activity/contracts';

export function parseSample(line: string): string | null {
  if (line.length > 4096) throw new Error('采集消息过长');
  const value = record(JSON.parse(line));
  return value.app === null ? null : textValue(value.app, 260);
}
export function parseActivitySample(line: string): ActivitySample {
  if (line.length > 4096) throw new Error('采集消息过长');
  const value = record(JSON.parse(line));
  if (value.status === 'unknown' && value.app === null && value.idleMs === null) return { status: 'unknown', app: null, idleMs: null };
  if (value.status !== 'ok' || typeof value.idleMs !== 'number' || !Number.isSafeInteger(value.idleMs) || value.idleMs < 0 || value.idleMs > 2147483647) throw new Error('无效空闲采样');
  return { status: 'ok', app: textValue(value.app, 260), idleMs: value.idleMs };
}
export class WindowsActivitySource implements ActivitySource, ActivitySampler {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending: { resolve(sample: ActivitySample): void; reject(error: Error): void } | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private buffer = '';
  private disposed = false;
  constructor(private readonly executable: string, private readonly report?: (event: string, fields?: Record<string, unknown>) => void) {}
  private fail(reason: string = 'unknown'): void {
    if (!this.disposed) this.report?.('sample_failed', { reason });
    const child = this.child; this.child = null;
    clearTimeout(this.timer); this.buffer = '';
    const pending = this.pending; this.pending = null;
    pending?.reject(new Error('Windows 采集暂不可用'));
    child?.kill();
  }
  async getCurrentApp(): Promise<string | null> { return (await this.sample()).app; }
  async sample(): Promise<ActivitySample> {
    if (this.disposed || this.pending) throw new Error('采集已停止或正在进行');
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.timer = setTimeout(() => this.fail('timeout'), 4000);
      if (!this.child) {
        const child = spawn(this.executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        this.child = child;
        this.report?.('sample_started');
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          if (this.child !== child) return;
          this.buffer += chunk;
          if (this.buffer.length > 4096) { this.fail('protocol'); return; }
          const newline = this.buffer.indexOf('\n');
          if (newline < 0) return;
          const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
          try {
            const app = parseActivitySample(line);
            this.report?.(app.status === 'ok' ? 'sample_ok' : 'sample_unknown');
            const pending = this.pending; this.pending = null; clearTimeout(this.timer);
            pending?.resolve(app);
          } catch { this.fail('protocol'); }
        });
        child.stderr.resume(); // Never forward native errors or window metadata to logs.
        child.on('error', () => { if (this.child === child) this.fail('spawn'); });
        child.on('exit', code => { this.report?.('sample_exit', { exitCode: code ?? -1 }); if (this.child === child) this.fail('exit'); });
        child.stdin.on('error', () => { if (this.child === child) this.fail('pipe'); });
      }
      this.child.stdin.write('sample\n');
    });
  }
  dispose(): void { this.disposed = true; this.fail(); }
}
