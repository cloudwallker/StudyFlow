import { CONFIG } from '../config/constants';
import type { FocusSession } from './focus-session';
import { isAllowedApp, normalizeApp } from './normalize-app';

export interface FocusDecision {
  shouldNotify: boolean;
  reason: 'allowed' | 'not-allowed' | 'cooldown' | 'no-session' | 'no-active-window';
  remainingSeconds: number;
}

export function decideFocus(
  session: FocusSession | null,
  app: string | null,
  now: number,
  lastNotificationAt: number | null,
): FocusDecision {
  if (!session || now < session.startedAt || now >= session.endsAt) {
    return { shouldNotify: false, reason: 'no-session', remainingSeconds: 0 };
  }
  const remainingSeconds = Math.ceil((session.endsAt - now) / 1000);
  let reason: FocusDecision['reason'];
  if (!app || !normalizeApp(app)) reason = 'no-active-window';
  else if (isAllowedApp(app, session.whitelist)) reason = 'allowed';
  else if (lastNotificationAt !== null && now - lastNotificationAt < CONFIG.notificationCooldownMs) reason = 'cooldown';
  else reason = 'not-allowed';
  return { shouldNotify: reason === 'not-allowed', reason, remainingSeconds };
}
