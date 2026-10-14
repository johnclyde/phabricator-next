import type { Task, TaskInput } from './types';

export type TaskCustomValue = string | number | boolean | null;
export interface TaskStatusDefinition { key: string; name: string; closed: boolean; disabled: boolean }
export interface TaskPriorityDefinition { key: string; name: string; rank: number; disabled: boolean }
export interface TaskFieldDefinition { key: string; name: string; type: 'text' | 'integer' | 'boolean' | 'select'; required: boolean; disabled: boolean; options: string[] }
export interface TaskFormDefinition { key: string; name: string; description: string; fields: string[]; defaults: { status?: string; priority?: string; points?: number | null; customFields?: Record<string, TaskCustomValue> }; disabled: boolean }
export interface ManiphestConfig { version: number; statuses: TaskStatusDefinition[]; priorities: TaskPriorityDefinition[]; fields: TaskFieldDefinition[]; forms: TaskFormDefinition[] }
export interface ManiphestConfiguration { config: ManiphestConfig; canConfigure: boolean; accessEpoch: number }
export interface ManiphestBulkInput { expectedConfigVersion: number; expectedAccessEpoch: number; tasks: { id: string; expectedVersion: number }[]; changes: Partial<Pick<TaskInput, 'status' | 'priority' | 'ownerId' | 'points' | 'customFields'>> }
export interface ManiphestBulkPreview { input: ManiphestBulkInput; tasks: { id: string; title: string; before: Task; after: Task }[]; accessEpoch: number }
export interface ManiphestBulkReceipt { operationId: string; tasks: { id: string; version: number }[]; accessEpoch: number }
export interface ManiphestReportRow { key: string; label: string; tasks: number; open: number; closed: number; points: number; openPoints: number; closedPoints: number }
export interface ManiphestReport { groupBy: 'status' | 'priority' | 'owner' | 'project'; rows: ManiphestReportRow[]; totals: Omit<ManiphestReportRow, 'key' | 'label'>; accessEpoch: number }
export const DEFAULT_MANIPHEST_CONFIG: ManiphestConfig = {
  version: 1,
  statuses: [ { key: 'open', name: 'Open', closed: false, disabled: false }, { key: 'in_progress', name: 'In Progress', closed: false, disabled: false }, { key: 'resolved', name: 'Resolved', closed: true, disabled: false }, { key: 'duplicate', name: 'Duplicate', closed: true, disabled: false } ],
  priorities: [ { key: 'low', name: 'Low', rank: 10, disabled: false }, { key: 'normal', name: 'Normal', rank: 20, disabled: false }, { key: 'high', name: 'High', rank: 30, disabled: false }, { key: 'urgent', name: 'Urgent', rank: 40, disabled: false } ],
  fields: [], forms: [{ key: 'default', name: 'Create Task', description: '', fields: ['description', 'status', 'priority', 'ownerId', 'projectIds', 'points'], defaults: {}, disabled: false }],
};
export function taskStatusName(key: string, config = DEFAULT_MANIPHEST_CONFIG): string { return config.statuses.find(item => item.key === key)?.name ?? key; }
export function taskPriorityName(key: string, config = DEFAULT_MANIPHEST_CONFIG): string { return config.priorities.find(item => item.key === key)?.name ?? key; }
export function taskPriorityRank(key: string, config = DEFAULT_MANIPHEST_CONFIG): number { return config.priorities.find(item => item.key === key)?.rank ?? 0; }
export function taskFieldText(value: TaskCustomValue | undefined): string { return value === undefined || value === null ? 'None' : typeof value === 'boolean' ? value ? 'Yes' : 'No' : String(value); }
