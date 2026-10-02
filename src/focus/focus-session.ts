import { CONFIG } from '../config/constants';

export interface FocusSession {
  readonly startedAt: number;
  readonly endsAt: number;
  readonly whitelist: readonly string[];
}

export function createSession(now: number, whitelist: readonly string[]): FocusSession {
  return { startedAt: now, endsAt: now + CONFIG.sessionDurationMs, whitelist: [...whitelist] };
}
