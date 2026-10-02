export interface Project { id: string; name: string }
export interface Task {
  id: string; projectId: string | null; title: string; done: boolean;
  estimateMinutes: number; spentMs: number;
  tags?: string[]; dependencies?: string[]; position?: number;
}
export interface Settings {
  planReminder?: import('./plan-reminder').PlanReminderSettings;
  longFocus?: import('../timer/long-focus').LongFocusConfig;
  sound?: import('../timer/pomodoro-sound').SoundConfig;
  recordAppActivity?: boolean; allDayActivity?: boolean; durationMinutes: number; whitelist: string[];
  mode?: import('../timer/contracts').TimerMode; idleMinutes?: number; policy?: import('../timer/contracts').PomodoroConfig;
}
export interface ScheduledDay { date: string; entries: import('./daily').PlanEntry[] }
export interface DataSnapshot { projects: Project[]; tasks: Task[]; settings: Settings; plans?: ScheduledDay[];
  archivedTasks?: Task[]; checkins?: Array<{ date: string; taskId: string; checkedAt: number | null }>;
  categories?: Array<{ app: string; category: string }>;
}
export interface TaskInput { title: string; projectId: string | null; estimateMinutes: number }
export interface ActivitySource { getCurrentApp(): Promise<string | null>; dispose(): void }
export interface FocusState {
  running: boolean; taskId: string | null; remainingSeconds: number; totalSeconds: number;
  app: string | null; message: string; notification: 'none' | 'sent' | 'failed';
  timer?: TimerState; learning?: LearningSummary;
}
export interface FocusPort {
  state(): FocusState;
  start(taskId: string | null, duration: number, whitelist: readonly string[], options?: unknown): void;
  stop(message?: string): void;
  pause?(): void;
  resume?(options?: unknown): void;
  previewSound?(options: unknown): void;
  configure?(settings: Settings): void;
  flushActivity?(): boolean;
}
export interface DesktopSnapshot extends DataSnapshot { focus: FocusState; daily?: import('./daily').DailyData; importPreview?: import('../import/json-plan').ImportPreview; importResult?: 'imported' | 'duplicate'; planReminder?: import('./plan-reminder').PlanReminderStatus }
export type Command = import('./management-commands').ManagementCommand | 'snapshot' | 'createProject' | 'createTask' | 'setTaskDone' | 'settings' | 'start' | 'stop' | 'pause' | 'resume' | 'deleteHistory' | 'daily' | 'savePlan' | 'saveReview' | 'classifyApp' | 'previewImport' | 'confirmImport' | 'cancelImport' | 'previewSound' | 'planReminderSettings';
export type Reply = { ok: true; value: DesktopSnapshot } | { ok: false; error: string };
export interface DesktopAPI { request(command: Command, payload?: unknown): Promise<Reply>; diagnostics?: import('./diagnostic-renderer').DiagnosticAPI; ambient?: import('./ambient-renderer').AmbientAudioAPI;
  focusMini?: { open(): Promise<{ ok: true } | { ok: false; error: string }> };
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效参数');
  return value as Record<string, unknown>;
}
export function textValue(value: unknown, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\u0000-\u001f]/.test(value)) throw new Error('请输入有效文本');
  return value.trim();
}
export function minutes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 240) throw new Error('时长须为 1—240 分钟的整数');
  return value;
}
import type { TimerState } from '../timer/contracts';
import type { LearningSummary } from '../activity/contracts';
