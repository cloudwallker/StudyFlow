import type { CurrentFocusClock, HistoryCheckpoint } from './history';
import { ContinuousActivity, type ActivityCheckpoint } from './continuous';
import type { Clock } from '../timer/contracts';
import type { ActivityObservation, ActivitySampler } from '../activity/contracts';
import { TimerService } from '../timer/timer-service';
import { inputRecord, positiveInteger } from '../timer/pomodoro-policy';
import { ActivityRecorder } from '../activity/recorder';
import { IdlePolicy } from '../activity/idle-policy';
import { learningSummary } from '../activity/learning-summary';
import { decideFocus } from '../focus/focus-guard';
import type { FocusPort, FocusState, Settings } from './contracts';
import { PomodoroSound, soundConfig, soundKinds, type SoundKind, type SoundPort } from '../timer/pomodoro-sound';

interface Dependencies {
  sound?: SoundPort; random?(): number;
  checkpoint?(checkpoint: HistoryCheckpoint): void; recoveredSessions?: number;
  activityCheckpoint?(checkpoint: ActivityCheckpoint): void; settings?: Settings;
  clock: Clock; makeId(): string; sampler: ActivitySampler;
  notify(body: string): Promise<void>; dismiss(): void; credit(taskId: string, ms: number): void;
}

/** One application-owned timer and one sampler; renderer lifetime is irrelevant. */
export class DesktopStudy implements FocusPort {
  private soundSettings = soundConfig();
  private readonly soundSchedule: PomodoroSound;
  private soundFailed = false;
  private readonly timer: TimerService;
  private readonly recorder: ActivityRecorder;
  private readonly continuous: ContinuousActivity;
  private allDay = false;
  private backgroundPoll = -Infinity;
  private retainedFrom = 0;
  private idleMinutes = 5;
  private archived = { effectiveMs: 0, afkMs: 0, unknownMs: 0 };
  private whitelist: readonly string[] = [];
  private generation = 0;
  private busy = false;
  private lastPoll: number | null = null;
  private lastNotification: number | null = null;
  private settled = false;
  private saveError = false;
  private revision = 0;
  private lastCheckpoint = 0;
  private app: string | null = null;
  private message = '准备好后，开始一段专注';
  private notification: FocusState['notification'] = 'none';

  constructor(private readonly deps: Dependencies) {
    this.soundSchedule = new PomodoroSound(deps.random);
    if (deps.recoveredSessions) this.message = '已恢复上次确认的历史；未结束会话已中断，停机时间未计入，请开始新的计时';
    this.timer = new TimerService(deps.clock, deps.makeId, deps.random);
    this.continuous = new ContinuousActivity(deps.sampler, deps.clock, deps.makeId, deps.activityCheckpoint);
    this.recorder = new ActivityRecorder({ sample: () => this.continuous.sample() }, deps.clock);
    if (deps.settings) this.configure(deps.settings);
  }
  configure(settings: Settings): void {
    this.continuous.configure(settings.allDayActivity === true, settings.idleMinutes ?? 5);
    this.allDay = settings.allDayActivity === true;
  }
  flushActivity(): boolean { return this.continuous.flush(); }
  suspendActivity(value: boolean): void { this.continuous.setSuspended(value); }
  currentFocusClock(): CurrentFocusClock {
    const snapshot = this.timer.snapshot();
    return { sessionId: snapshot.state.sessionId, retainedFrom: this.retainedFrom, slices: snapshot.slices };
  }
  private summary() {
    const recent = learningSummary(this.timer.snapshot().slices, this.recorder.intervals());
    return { effectiveMs: this.archived.effectiveMs + recent.effectiveMs, afkMs: this.archived.afkMs + recent.afkMs, unknownMs: this.archived.unknownMs + recent.unknownMs };
  }
  state(): FocusState {
    const timer = this.timer.state();
    return { running: timer.status !== 'idle' && (timer.status !== 'stopped' || !this.settled), taskId: timer.taskId,
      remainingSeconds: Math.ceil((timer.remainingMs ?? 0) / 1000), totalSeconds: Math.ceil((timer.phaseElapsedMs + (timer.remainingMs ?? 0)) / 1000),
      app: this.app, message: this.message + (this.soundFailed ? ' · 提示音播放失败，请检查音频设备或重试试听' : '') + (this.saveError ? ' · 历史保存失败，未保存数据仅在内存中；请检查存储后重试结束计时' : '') + (this.continuous.failed ? ' · 全天活动保存失败，请检查存储后重试' : ''), notification: this.notification, timer,
      learning: this.summary() };
  }
  start(taskId: string | null, duration: number, whitelist: readonly string[], options: unknown = {}): void {
    if (this.timer.state().status === 'stopped' && !this.settled) throw new Error('上一段计时正在结算，请稍候');
    const input = inputRecord(options);
    const sound = soundConfig(input.sound);
    const idleMinutes = input.idleMinutes === undefined ? 5 : positiveInteger(input.idleMinutes, 240);
    const policy = new IdlePolicy(idleMinutes * 60000);
    this.timer.start({ mode: input.mode === undefined ? 'countdown' : input.mode, taskId, durationMinutes: duration, policy: input.policy, longFocus: input.longFocus });
    this.cancelPending(); this.recorder.reset(policy); this.whitelist = [...whitelist];
    this.soundSettings = { ...sound };
    if (!this.timer.state().longFocus) delete this.soundSettings.events;
    this.soundFailed = false; this.soundSchedule.reset(this.timer.state(), this.soundSettings);
    this.idleMinutes = idleMinutes; this.retainedFrom = 0; this.archived = { effectiveMs: 0, afkMs: 0, unknownMs: 0 };
    this.lastNotification = null; this.lastPoll = null; this.settled = false;
    this.message = '专注进行中，等待有效采样'; this.notification = 'none';
    this.revision = 0; this.persist();
    if (this.timer.state().longFocus && sound.enabled) void this.playSound('focus-start', this.generation);
  }
  pause(): void {
    this.timer.pause(); this.cancelPending(); this.timer.takeEvents(); this.settle();
    if (this.timer.state().status === 'paused') { this.message = '计时已暂停，点击继续恢复'; this.persist(); }
    if (this.timer.state().status === 'awaiting-next') { this.message = '本阶段已完成，点击开始下一阶段'; this.persist(); }
  }
  interrupt(message = '计时已暂停，返回后请点击继续'): void {
    this.timer.interrupt(); this.cancelPending(); this.timer.takeEvents(); this.settle();
    if (this.timer.state().status === 'paused') { this.message = message; this.persist(); }
    if (this.timer.state().status === 'awaiting-next') { this.message = '本阶段已完成，返回后请手动开始下一阶段'; this.persist(); }
  }
  resume(options: unknown = {}): void {
    const before = this.timer.state().status;
    this.timer.resume(inputRecord(options).durationMinutes);
    if (before === 'paused' || before === 'awaiting-next') {
      this.cancelPending(); this.lastPoll = null; this.message = '计时继续，等待有效采样'; this.persist();
      this.soundSchedule.reset(this.timer.state(), this.soundSettings);
      if (before === 'awaiting-next' && this.timer.state().longFocus && this.soundSettings.enabled) void this.playSound('focus-start', this.generation);
    }
  }
  stop(message = '本次计时已结束'): void {
    const open = this.state().running;
    this.timer.stop(); this.cancelPending(); this.timer.takeEvents();
    if (open) this.message = message;
    this.settle();
  }
  private cancelPending(): void { this.generation++; this.recorder.interrupt(); this.app = null; this.deps.dismiss(); this.deps.sound?.stop(); }
  previewSound(options: unknown): void {
    if (this.state().running) throw new Error('请结束计时后再试听');
    const input = inputRecord(options); const config = soundConfig(input.sound);
    const kind = input.kind;
    if (typeof kind !== 'string' || !soundKinds.includes(kind as SoundKind)) throw new Error('无效提示音类型');
    this.soundFailed = false;
    void this.playSound(kind as SoundKind, this.generation, config);
  }
  private async playSound(kind: SoundKind, generation: number, config = this.soundSettings): Promise<void> {
    config = { ...config, ...config.events?.[kind] };
    if (generation !== this.generation || config.volume === 0) return;
    try {
      if (!this.deps.sound) throw new Error('声音组件不可用');
      await this.deps.sound.play(kind, config);
      if (generation === this.generation) this.soundFailed = false;
    } catch { if (generation === this.generation) this.soundFailed = true; }
  }
  private persist(): boolean {
    if (!this.deps.checkpoint) return true;
    this.lastCheckpoint = this.deps.clock.read().monotonicMs;
    try {
      const snapshot = this.timer.snapshot(); const intervals = this.recorder.intervals();
      this.deps.checkpoint({ revision: this.revision + 1, snapshot, intervals, retainedFrom: this.retainedFrom, archivedEffectiveMs: this.archived.effectiveMs });
      const limit = snapshot.state.status === 'stopped' ? Infinity : this.lastCheckpoint - this.idleMinutes * 60000 - 90000;
      const released = snapshot.slices.filter(slice => slice.monotonicEndMs <= limit);
      const end = released.at(-1)?.monotonicEndMs;
      if (end !== undefined) {
        const summary = learningSummary(released, intervals);
        this.archived.effectiveMs += summary.effectiveMs; this.archived.afkMs += summary.afkMs; this.archived.unknownMs += summary.unknownMs;
        this.retainedFrom = end; this.timer.discardBefore(end); this.recorder.discardBefore(end);
      }
      this.revision++; this.saveError = false; return true;
    } catch { this.saveError = true; return false; }
  }
  private settle(): void {
    const state = this.timer.state();
    if (state.status !== 'stopped' || this.settled) return;
    if (this.deps.checkpoint) { this.settled = this.persist(); return; }
    this.settled = true;
    if (!state.taskId) return;
    const ms = Math.floor(learningSummary(this.timer.snapshot().slices, this.recorder.intervals()).effectiveMs);
    try { this.deps.credit(state.taskId, ms); }
    catch { this.message = '计时已结束，但学习时间保存失败；请检查本地存储'; }
  }
  private async notify(body: string, generation: number): Promise<void> {
    if (generation !== this.generation) return;
    try { await this.deps.notify(body); if (generation === this.generation) this.notification = 'sent'; }
    catch { if (generation === this.generation) this.notification = 'failed'; }
  }
  async tick(): Promise<void> {
    const before = this.timer.state();
    if (this.allDay && before.status !== 'running' && !this.busy && this.deps.clock.read().monotonicMs - this.backgroundPoll >= 3000) {
      this.busy = true; this.backgroundPoll = this.deps.clock.read().monotonicMs;
      try { await this.continuous.sample(); } finally { this.busy = false; }
      // A start command may arrive while the background sample is pending.
      if (this.timer.state().status !== before.status) return;
    }
    if (before.status === 'idle') return;
    if (before.status === 'stopped') {
      if (!this.busy && !this.settled && this.deps.clock.read().monotonicMs - this.lastCheckpoint >= 30000) this.settle();
      return;
    }
    this.timer.tick();
    if (this.busy) return;
    this.busy = true;
    const generation = this.generation;
    try {
      const now = this.deps.clock.read().monotonicMs;
      let observation: ActivityObservation | null = null;
      if (before.status === 'running' && (this.lastPoll === null || now - this.lastPoll >= 3000 || this.timer.state().status !== 'running')) {
        this.lastPoll = now; observation = await this.recorder.poll();
        if (generation !== this.generation) return;
        this.timer.tick();
      }
      const state = this.timer.state();
      const events = this.timer.takeEvents();
      if (state.status !== 'stopped' && (events.length || this.deps.clock.read().monotonicMs - this.lastCheckpoint >= 30000)) this.persist();
      const completed = events.filter(event => event.type === 'phase-completed');
      if (completed.length) {
        this.recorder.interrupt(); this.app = null; this.deps.dismiss();
        this.message = state.status === 'awaiting-next' ? '本阶段已完成，点击开始下一阶段' : state.phase === 'long-break' ? '本轮完成，长休息进行中' : '本次计时已完成';
        this.settle();
        const phase = completed.at(-1)!.phase;
        if (state.mode === 'pomodoro' && state.status !== 'paused' && this.soundSettings.enabled) {
          void this.playSound(phase === 'work' ? 'work-end' : 'break-end', generation);
        }
        await this.notify(phase === 'work' ? '工作阶段已完成，休息一下吧' : '休息已结束，准备好后开始下一阶段', generation);
      } else if (events.length && state.status === 'running') {
        this.app = null; this.deps.dismiss();
        this.message = state.microResting ? '微休息中，不累计学习时间' : '微休息结束，继续专注';
        // A delayed poll may cross both boundaries. Only signal the current state, never replay a burst.
        const event = events.at(-1)!;
        if (this.soundSettings.enabled && this.deps.clock.read().wallMs - event.at <= 5000) {
          void this.playSound(state.microResting ? 'micro-start' : 'micro-end', generation);
        }
      } else if (state.status !== 'running') {
        if (before.status === 'running') this.deps.sound?.stop();
        this.app = null;
        if (before.status === 'running') { this.deps.dismiss(); this.recorder.interrupt(); this.message = '检测到计时中断，请点击继续'; }
      } else if (observation) await this.handleObservation(observation, generation);
      if (generation === this.generation) {
        if (this.soundSchedule.due(this.timer.state(), this.soundSettings)) void this.playSound('cue', generation);
        this.settle();
      }
    } finally { this.busy = false; }
  }
  private async handleObservation(observation: ActivityObservation, generation: number): Promise<void> {
    const timer = this.timer.state();
    this.app = observation.app;
    if (timer.microResting || timer.phase !== 'work' || observation.state !== 'active') {
      this.deps.dismiss();
      this.message = timer.microResting ? '微休息中，不累计学习时间' : timer.phase !== 'work' ? '休息阶段，不累计学习时间' : observation.state === 'afk' ? '已进入空闲状态，不累计学习时间' : '采样未知，暂不累计学习时间';
      return;
    }
    const now = observation.at.monotonicMs;
    const decision = decideFocus({ startedAt: now, endsAt: now + (timer.remainingMs ?? 86400000), whitelist: this.whitelist }, observation.app, now, this.lastNotification);
    if (decision.reason === 'allowed') { this.deps.dismiss(); this.message = '当前应用在白名单内'; }
    else this.message = '请回到本次学习任务';
    if (decision.shouldNotify) {
      this.lastNotification = now;
      await this.notify(`当前应用：${observation.app}\n请回到本次学习任务`, generation);
    }
  }
}
