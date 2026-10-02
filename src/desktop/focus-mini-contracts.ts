export const FOCUS_MINI_CHANNEL = 'studyflow:focus-mini';

export type FocusMiniStatus = 'idle' | 'running' | 'paused' | 'waiting' | 'break' | 'stopped';
export type FocusMiniAction = 'open-main' | 'close';

export interface FocusMiniSnapshot {
  date: string;
  elapsedMs: number;
  status: FocusMiniStatus;
  taskTitle: string | null;
}

export type FocusMiniReply =
  | { ok: true; snapshot: FocusMiniSnapshot }
  | { ok: true }
  | { ok: false; error: string };

export interface FocusMiniAPI {
  snapshot(): Promise<FocusMiniReply>;
  act(action: FocusMiniAction): Promise<FocusMiniReply>;
}

declare global {
  interface Window { studyflowFocusMini: FocusMiniAPI }
}
