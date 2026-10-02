import type { FocusPort } from './contracts';

/** Ordinary exit must not discard a retryable checkpoint. OS termination cannot be vetoed here. */
export function prepareQuit(focus: FocusPort | null): boolean {
  try { focus?.stop('应用已退出'); return (focus?.flushActivity?.() ?? true) && !focus?.state().running; }
  catch { return false; }
}
