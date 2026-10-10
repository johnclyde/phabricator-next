import type { TaskStatus } from './types';

/** Closed tasks remain individually readable, including merged duplicates. */
export function isTaskClosed(status: TaskStatus): boolean {
  return status === 'resolved' || status === 'duplicate';
}
