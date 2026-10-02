import { decideFocus } from '../focus/focus-guard';
import type { FocusSession } from '../focus/focus-session';
import { minutes, type FocusState } from './contracts';

interface Dependencies {
  sample(): Promise<string | null>;
  notify(body: string): Promise<void>;
  dismiss?(): void;
  credit(taskId: string, ms: number): void;
  now(): number;
}
export class DesktopFocus {
  private session: FocusSession | null = null;
  private value: FocusState = { running: false, taskId: null, remainingSeconds: 0, totalSeconds: 0, app: null, message: '准备好后，开始一段专注', notification: 'none' };
  private lastNotify: number | null = null;
  private observedAt = 0;
  private busy = false;
  constructor(private readonly deps: Dependencies) {}
  state(): FocusState {
    const remainingSeconds = this.session ? Math.max(0, Math.ceil((this.session.endsAt - this.deps.now()) / 1000)) : 0;
    return { ...this.value, remainingSeconds };
  }
  start(taskId: string | null, duration: number, whitelist: readonly string[]): void {
    if (this.session) throw new Error('请先结束当前专注');
    const totalSeconds = minutes(duration) * 60;
    const now = this.deps.now();
    this.session = { startedAt: now, endsAt: now + totalSeconds * 1000, whitelist: [...whitelist] };
    this.observedAt = now; this.lastNotify = null;
    this.value = { running: true, taskId, remainingSeconds: totalSeconds, totalSeconds, app: null, message: '专注进行中', notification: 'none' };
  }
  stop(message = '本次专注已结束', at = this.deps.now()): void {
    const session = this.session;
    if (!session) return;
    this.session = null;
    this.deps.dismiss?.();
    this.value = { ...this.value, running: false, remainingSeconds: 0, app: null, message };
    const observedEnd = at - this.observedAt > 90000 || at < this.observedAt ? this.observedAt : at;
    const elapsed = Math.max(0, Math.floor(Math.min(observedEnd, session.endsAt) - session.startedAt));
    if (this.value.taskId) {
      try { this.deps.credit(this.value.taskId, elapsed); }
      catch { this.value.message = '专注已停止，但时间保存失败；请检查本地存储'; }
    }
  }
  interrupt(message: string): void { this.stop(message); }
  async tick(): Promise<void> {
    const session = this.session;
    if (!session) return;
    const now = this.deps.now();
    // Long gaps can mean sleep or an unresponsive process; don't invent observed time.
    if (now - this.observedAt > 90000 || now < this.observedAt) {
      this.stop('检测到采样中断，本次专注已停止，请重新开始', this.observedAt); return;
    }
    this.observedAt = now;
    if (now >= session.endsAt) { this.stop('这段专注已完成，休息一下吧'); return; }
    if (this.busy) return;
    this.busy = true;
    try {
      const app = await this.deps.sample();
      if (this.session !== session) return;
      const sampledAt = this.deps.now();
      if (sampledAt >= session.endsAt) { this.stop('这段专注已完成，休息一下吧'); return; }
      const decision = decideFocus(session, app, sampledAt, this.lastNotify);
      if (decision.reason === 'allowed' || decision.reason === 'no-active-window') this.deps.dismiss?.();
      this.value.app = app;
      this.value.message = app ? (decision.reason === 'allowed' ? '当前应用在白名单内' : '请回到本次学习任务') : '暂时无法读取前台应用，不触发提醒';
      if (decision.shouldNotify) {
        this.lastNotify = sampledAt;
        try {
          await this.deps.notify(`当前应用：${app}\n本次专注还剩 ${Math.ceil(decision.remainingSeconds / 60)} 分钟`);
          if (this.session === session) this.value.notification = 'sent';
        } catch { if (this.session === session) this.value.notification = 'failed'; }
      }
    } catch {
      if (this.session === session) { this.deps.dismiss?.(); this.value.app = null; this.value.message = '采集暂不可用，计时继续；稍后自动重试'; }
    } finally { this.busy = false; }
  }
}
