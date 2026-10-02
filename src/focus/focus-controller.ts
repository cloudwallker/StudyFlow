import type { ActivitySource } from '../adapters/activitywatch-adapter';
import type { TaskHost } from '../adapters/super-productivity-adapter';
import { safeError } from '../compat/safe-error';
import { CONFIG } from '../config/constants';
import { decideFocus, type FocusDecision } from './focus-guard';
import { createSession, type FocusSession } from './focus-session';

export interface FocusState {
  running: boolean;
  remainingSeconds: number;
  app: string | null;
  error: string;
}

export interface FocusDiagnostic {
  phase: 'stopped' | 'reading' | 'waiting' | 'notifying' | 'sample-failed';
  sampleCount: number;
  sampledAt: number | null;
  reason: FocusDecision['reason'] | 'not-sampled';
  notificationCount: number;
  notificationStatus: 'none' | 'pending' | 'returned' | 'failed';
  notificationAt: number | null;
  notificationApp: string | null;
}

function emptyDiagnostic(): FocusDiagnostic {
  return { phase: 'stopped', sampleCount: 0, sampledAt: null, reason: 'not-sampled',
    notificationCount: 0, notificationStatus: 'none', notificationAt: null, notificationApp: null };
}

export function formatRemaining(seconds: number): string {
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}

export class FocusController {
  private session: FocusSession | null = null;
  private lastNotificationAt: number | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private abort: AbortController | null = null;
  private busy = false;
  private disposed = false;
  private diagnostic = emptyDiagnostic();

  constructor(
    private readonly source: ActivitySource,
    private readonly host: Pick<TaskHost, 'notify'>,
    private readonly update: (state: FocusState) => void,
    private readonly now: () => number = Date.now,
    private readonly diagnose: (diagnostic: FocusDiagnostic) => void = () => {},
  ) {}

  start(whitelist: readonly string[]): void {
    if (this.disposed || this.session) return;
    this.session = createSession(this.now(), whitelist);
    this.lastNotificationAt = null;
    this.diagnostic = emptyDiagnostic();
    this.abort = new AbortController();
    this.update({ running: true, remainingSeconds: 600, app: null, error: '' });
    this.expiryTimer = setTimeout(() => this.stop(), CONFIG.sessionDurationMs);
    void this.tick();
  }

  stop(): void {
    this.session = null;
    this.abort?.abort();
    this.abort = null;
    clearTimeout(this.pollTimer);
    clearTimeout(this.expiryTimer);
    this.pollTimer = undefined;
    this.expiryTimer = undefined;
    this.lastNotificationAt = null;
    this.update({ running: false, remainingSeconds: 0, app: null, error: '' });
    this.report({ phase: 'stopped' });
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
  }

  private schedule(): void {
    if (this.session && !this.disposed) this.pollTimer = setTimeout(() => { void this.tick(); }, CONFIG.pollIntervalMs);
  }

  private report(change: Partial<FocusDiagnostic>): void {
    this.diagnostic = { ...this.diagnostic, ...change };
    this.diagnose({ ...this.diagnostic });
  }

  private async tick(): Promise<void> {
    const session = this.session;
    if (!session || this.disposed) return;
    if (this.now() >= session.endsAt) { this.stop(); return; }
    if (this.busy) { this.schedule(); return; }
    this.busy = true;
    this.report({ phase: 'reading' });
    let notifying = false;
    try {
      const window = await this.source.getCurrentWindow(this.abort?.signal);
      if (this.session !== session || this.disposed) return;
      const now = this.now();
      if (now >= session.endsAt) { this.stop(); return; }
      const decision = decideFocus(session, window?.app ?? null, now, this.lastNotificationAt);
      this.report({ phase: 'waiting', sampleCount: this.diagnostic.sampleCount + 1,
        sampledAt: now, reason: decision.reason });
      this.update({ running: true, remainingSeconds: decision.remainingSeconds, app: window?.app ?? null, error: '' });
      if (decision.shouldNotify) {
        // Reserve cooldown before awaiting the host; rejected deliveries must not spam retries.
        this.lastNotificationAt = now;
        notifying = true;
        this.report({ phase: 'notifying', notificationCount: this.diagnostic.notificationCount + 1,
          notificationStatus: 'pending', notificationAt: now, notificationApp: window!.app });
        await this.host.notify('StudyFlow 专注测试提醒', `当前检测到：${window!.app}\n本次专注还剩：${formatRemaining(decision.remainingSeconds)}`);
        if (this.session === session && !this.disposed) this.report({ phase: 'waiting', notificationStatus: 'returned' });
      }
    } catch (error) {
      if (this.session === session && !this.disposed) this.report(notifying
        ? { phase: 'waiting', notificationStatus: 'failed' }
        : { phase: 'sample-failed' });
      if (this.session === session && !this.disposed) this.update({
        running: true, remainingSeconds: Math.max(0, Math.ceil((session.endsAt - this.now()) / 1000)),
        app: null, error: safeError(error),
      });
    } finally {
      this.busy = false;
      if (this.session === session) this.schedule();
    }
  }
}
