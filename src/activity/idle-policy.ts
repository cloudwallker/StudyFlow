import type { ActivitySample, ActivityState } from './contracts';

export class IdlePolicy {
  constructor(readonly thresholdMs = 300000) {
    if (!Number.isSafeInteger(thresholdMs) || thresholdMs < 1 || thresholdMs > 14400000) throw new Error('无效空闲阈值');
  }
  classify(sample: ActivitySample): ActivityState {
    return sample.status !== 'ok' ? 'unknown' : sample.idleMs >= this.thresholdMs ? 'afk' : 'active';
  }
}
