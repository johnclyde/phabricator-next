import type { ManiphestConfig } from './maniphest';
import type { Task, TaskStatus } from './types';

/** Closed tasks remain individually readable, including merged duplicates. */
export function isTaskClosed(task: TaskStatus | Pick<Task, 'status' | 'statusClosed'>, config?: ManiphestConfig): boolean {
  if (typeof task !== 'string' && typeof task.statusClosed === 'boolean') return task.statusClosed;
  const status = typeof task === 'string' ? task : task.status;
  const definition = config?.statuses.find(item => item.key === status);
  if (definition) return definition.closed;
  return status === 'resolved' || status === 'duplicate';
}

/** Read old saved task snapshots without inventing associations from live state. */
export function taskProjectIds(task: { projectIds?: string[]; projectId?: string | null }): string[] {
  if (Array.isArray(task.projectIds)) return task.projectIds;
  return typeof task.projectId === 'string' ? [task.projectId] : [];
}
