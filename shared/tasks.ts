import type { TaskStatus } from './types';

/** Closed tasks remain individually readable, including merged duplicates. */
export function isTaskClosed(status: TaskStatus): boolean {
  return status === 'resolved' || status === 'duplicate';
}

/** Read old saved task snapshots without inventing associations from live state. */
export function taskProjectIds(task: { projectIds?: string[]; projectId?: string | null }): string[] {
  if (Array.isArray(task.projectIds)) return task.projectIds;
  return typeof task.projectId === 'string' ? [task.projectId] : [];
}
