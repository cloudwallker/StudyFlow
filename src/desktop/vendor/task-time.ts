// Adapted from Super Productivity 18.21.2 src/app/util/get-time-left-for-task.ts.
// Copyright (c) 2018 Johannes Millan. MIT; see third-party/super-productivity-LICENSE.txt.
// StudyFlow has no subtasks: retain the non-negative estimate-minus-spent rule only.
export function remainingTaskMs(task: { estimateMinutes: number; spentMs: number }): number {
  return Math.max(0, task.estimateMinutes * 60000 - task.spentMs) || 0;
}
