import { isRevisionAuthorId } from './revision-authorship';
import { isRevisionMetadataAttribution } from './revision-metadata';
import type { ActorAttribution } from './types';

export interface TaskMuteState { muted: boolean; version: number; updatedAt: string | null }
export interface TaskMuteSnapshot extends TaskMuteState { taskId: string; principalId: string; accessEpoch: number }
export interface TaskMuteInput { action: 'mute' | 'unmute'; expectedMuteVersion: number; expectedAccessEpoch: number }
export interface TaskMuteReceipt { taskId: string; operationId: string; inputSha256: string; changed: boolean; accessEpoch: number }
export interface TaskMuteTransaction { id: string; taskId: string; principalId: string; version: number; before: boolean; after: boolean; createdAt: string; attribution: ActorAttribution }
export interface TaskMuteHistory { taskId: string; principalId: string; version: number; entries: TaskMuteTransaction[]; nextBefore: number | null; accessEpoch: number }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export const isTaskNotificationId = (value: unknown): value is string => typeof value === 'string' && /^T[1-9]\d{0,14}$/.test(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const instant = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
export function taskMuteInput(value: unknown): TaskMuteInput {
  if (!record(value) || !exact(value, ['action', 'expectedMuteVersion', 'expectedAccessEpoch']) || !['mute', 'unmute'].includes(String(value.action)) || !natural(value.expectedMuteVersion) || !natural(value.expectedAccessEpoch)) throw new Error('Provide a task mute action and the inspected preference version and access epoch.');
  return { action: value.action as TaskMuteInput['action'], expectedMuteVersion: value.expectedMuteVersion, expectedAccessEpoch: value.expectedAccessEpoch };
}
export function isTaskMuteState(value: unknown): value is TaskMuteState {
  return record(value) && exact(value, ['muted', 'version', 'updatedAt']) && typeof value.muted === 'boolean' && natural(value.version) && (value.version === 0 ? value.muted === false && value.updatedAt === null : instant(value.updatedAt));
}
export function isTaskMuteSnapshot(value: unknown, taskId?: string, principalId?: string): value is TaskMuteSnapshot {
  if (!record(value) || !exact(value, ['taskId', 'principalId', 'muted', 'version', 'updatedAt', 'accessEpoch']) || !isTaskNotificationId(value.taskId) || taskId !== undefined && taskId !== value.taskId || !isRevisionAuthorId(value.principalId) || principalId !== undefined && principalId !== value.principalId || !natural(value.accessEpoch)) return false;
  return isTaskMuteState({ muted: value.muted, version: value.version, updatedAt: value.updatedAt });
}
export function isTaskMuteTransaction(value: unknown): value is TaskMuteTransaction {
  return record(value) && exact(value, ['id', 'taskId', 'principalId', 'version', 'before', 'after', 'createdAt', 'attribution']) && uuid(value.id) && isTaskNotificationId(value.taskId) && isRevisionAuthorId(value.principalId) && natural(value.version) && value.version > 0 && typeof value.before === 'boolean' && typeof value.after === 'boolean' && value.before !== value.after && instant(value.createdAt) && isRevisionMetadataAttribution(value.attribution) && value.attribution.principalId === value.principalId;
}
export function isTaskMuteHistory(value: unknown, taskId?: string, principalId?: string): value is TaskMuteHistory {
  if (!record(value) || !exact(value, ['taskId', 'principalId', 'version', 'entries', 'nextBefore', 'accessEpoch']) || !isTaskNotificationId(value.taskId) || taskId !== undefined && taskId !== value.taskId || !isRevisionAuthorId(value.principalId) || principalId !== undefined && principalId !== value.principalId || !natural(value.version) || !natural(value.accessEpoch) || !Array.isArray(value.entries) || value.entries.length > 100 || !(value.nextBefore === null || natural(value.nextBefore) && value.nextBefore > 0)) return false;
  const entries = value.entries;
  return entries.every((entry, index) => isTaskMuteTransaction(entry) && entry.taskId === value.taskId && entry.principalId === value.principalId && entry.version <= Number(value.version) && (!index || entries[index - 1].version > entry.version)) && new Set(entries.map(entry => entry.id)).size === entries.length && (value.nextBefore === null || entries.at(-1)?.version === value.nextBefore);
}
export function validTaskMuteResult(value: unknown, taskId?: string): value is TaskMuteReceipt {
  return record(value) && exact(value, ['taskId', 'operationId', 'inputSha256', 'changed', 'accessEpoch']) && isTaskNotificationId(value.taskId) && (taskId === undefined || value.taskId === taskId) && uuid(value.operationId) && typeof value.inputSha256 === 'string' && /^[a-f0-9]{64}$/.test(value.inputSha256) && typeof value.changed === 'boolean' && natural(value.accessEpoch);
}
