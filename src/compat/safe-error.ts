import { ActivityWatchError } from '../adapters/activitywatch-parsing';
import { CompatibilityError } from '../adapters/super-productivity-adapter';

export function safeError(error: unknown): string {
  return error instanceof ActivityWatchError || error instanceof CompatibilityError
    ? error.message : 'StudyFlow operation failed.';
}
