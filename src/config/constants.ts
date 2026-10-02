export const CONFIG = {
  activityWatchUrl: 'http://127.0.0.1:5600',
  requestTimeoutMs: 4000,
  pollIntervalMs: 3000,
  sessionDurationMs: 600000,
  notificationCooldownMs: 60000,
  maxEventAgeMs: 15000,
  futureToleranceMs: 5000,
} as const;

export const PROBE_TITLE = '[StudyFlow PoC] Plugin API probe';
