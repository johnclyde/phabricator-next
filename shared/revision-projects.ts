import type { ActorAttribution } from './types';
import type { ObjectAccess } from './policy';
import { isRevisionId } from './revision-dependencies';
import { isRevisionMetadataAttribution } from './revision-metadata';

export const REVISION_PROJECT_LIMITS = { projects: 100, page: 100 } as const;
export type RevisionProjectAction = 'add' | 'remove' | 'set';
export interface RevisionProjectState { revisionId: string; version: number; projectIds: string[]; updatedAt: string | null }
export interface RevisionProjectInput { action: RevisionProjectAction; projectIds: string[]; expectedProjectVersion: number; expectedAccessEpoch: number }
export interface RevisionProjectSnapshot { tags: RevisionProjectState; access: ObjectAccess; accessEpoch: number }
export interface RevisionProjectTransaction { id: string; revisionId: string; operationId: string; projectVersion: number; before: RevisionProjectState; after: RevisionProjectState; attribution: ActorAttribution; createdAt: string }
export interface RevisionProjectReceipt { revisionId: string; operationId: string; inputSha256: string; changed: boolean; tags: RevisionProjectState; transaction: RevisionProjectTransaction | null; accessEpoch: number }
export interface RevisionProjectHistory { revisionId: string; projectVersion: number; transactions: RevisionProjectTransaction[]; nextBefore: number | null; accessEpoch: number }
const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const keys = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && Object.keys(v).every(k => names.includes(k));
const integer = (v: unknown, min = 0): v is number => Number.isSafeInteger(v) && Number(v) >= min;
const identifier = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 240 && !v.includes('\0') && !/[\uD800-\uDFFF]/u.test(v);
const date = (v: unknown): v is string => typeof v === 'string' && v.length <= 64 && Number.isFinite(Date.parse(v));
export const isRevisionProjectId = (v: unknown): v is string => typeof v === 'string' && /^PROJ[1-9]\d{0,14}$/.test(v);
export function revisionProjectIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > REVISION_PROJECT_LIMITS.projects || !value.every(isRevisionProjectId) || new Set(value).size !== value.length) throw new Error('Choose at most 100 distinct project tags.');
  return [...value];
}
/** Preserve absence and legacy wire shape for immutable creation retries. */
export function revisionProjectCreationInput(value: { projectId?: unknown; projectIds?: unknown }): { projectId?: string | null; projectIds?: string[] } {
  if (Object.hasOwn(value, 'projectId') && Object.hasOwn(value, 'projectIds')) throw new Error('Use projectIds or the legacy projectId field, not both.');
  if (Object.hasOwn(value, 'projectIds')) return { projectIds: revisionProjectIds(value.projectIds) };
  if (Object.hasOwn(value, 'projectId')) { if (value.projectId !== null && !isRevisionProjectId(value.projectId)) throw new Error('Choose a valid project tag.'); return { projectId: value.projectId }; }
  return {};
}
export function revisionProjectInput(value: unknown): RevisionProjectInput {
  if (!object(value) || !keys(value, ['action', 'projectIds', 'expectedProjectVersion', 'expectedAccessEpoch']) || !['add', 'remove', 'set'].includes(String(value.action)) || !integer(value.expectedProjectVersion) || !integer(value.expectedAccessEpoch)) throw new Error('Provide a project-tag action and exact project and access versions.');
  return { action: value.action as RevisionProjectAction, projectIds: revisionProjectIds(value.projectIds), expectedProjectVersion: value.expectedProjectVersion, expectedAccessEpoch: value.expectedAccessEpoch };
}
export function isRevisionProjectState(value: unknown, id?: string): value is RevisionProjectState {
  if (!object(value) || !keys(value, ['revisionId', 'version', 'projectIds', 'updatedAt']) || !isRevisionId(value.revisionId) || id !== undefined && value.revisionId !== id || !integer(value.version) || !(value.version === 0 ? value.updatedAt === null : date(value.updatedAt))) return false;
  try { const ids = revisionProjectIds(value.projectIds); return ids.every((v, i) => i === 0 || ids[i - 1]! < v); } catch { return false; }
}
export function isRevisionProjectTransaction(value: unknown, id?: string): value is RevisionProjectTransaction {
  if (!object(value) || !keys(value, ['id', 'revisionId', 'operationId', 'projectVersion', 'before', 'after', 'attribution', 'createdAt']) || !identifier(value.id) || !identifier(value.operationId) || !isRevisionId(value.revisionId) || id !== undefined && value.revisionId !== id || !integer(value.projectVersion, 1) || !isRevisionProjectState(value.before, value.revisionId) || !isRevisionProjectState(value.after, value.revisionId) || !isRevisionMetadataAttribution(value.attribution) || !date(value.createdAt)) return false;
  // Visibility filtering may make a real change's public before/after sets equal.
  return value.before.version + 1 === value.projectVersion && value.after.version === value.projectVersion && value.after.updatedAt === value.createdAt;
}
export function validRevisionProjectResult(value: unknown, id: string, input: RevisionProjectInput, principalId?: string): value is RevisionProjectReceipt {
  if (!object(value) || !keys(value, ['revisionId', 'operationId', 'inputSha256', 'changed', 'tags', 'transaction', 'accessEpoch']) || value.revisionId !== id || !identifier(value.operationId) || typeof value.inputSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.inputSha256) || typeof value.changed !== 'boolean' || !integer(value.accessEpoch) || !isRevisionProjectState(value.tags, id) || value.tags.version !== input.expectedProjectVersion + Number(value.changed)) return false;
  const selected = new Set(input.projectIds);
  if (input.action === 'set' && value.tags.projectIds.some(id => !selected.has(id)) || input.action === 'remove' && value.tags.projectIds.some(id => selected.has(id))) return false;
  if (!value.changed) return value.transaction === null;
  const t = value.transaction;
  if (!isRevisionProjectTransaction(t, id) || t.operationId !== value.operationId || t.before.version !== input.expectedProjectVersion || JSON.stringify(t.after) !== JSON.stringify(value.tags) || principalId !== undefined && t.attribution.principalId !== principalId) return false;
  const previous = new Set(t.before.projectIds);
  return input.action === 'set' || t.after.projectIds.every(id => previous.has(id) || input.action === 'add' && selected.has(id));
}
export function isRevisionProjectSnapshot(value: unknown, id: string): value is RevisionProjectSnapshot {
  return object(value) && keys(value, ['tags', 'access', 'accessEpoch']) && isRevisionProjectState(value.tags, id) && integer(value.accessEpoch) && object(value.access) && object(value.access.policy) && value.access.policy.objectId === id && object(value.access.capabilities) && ['view', 'edit', 'interact', 'managePolicy'].every(key => typeof (value.access as ObjectAccess).capabilities[key as keyof ObjectAccess['capabilities']] === 'boolean');
}
export function isRevisionProjectHistory(value: unknown, id: string): value is RevisionProjectHistory {
  if (!object(value) || !keys(value, ['revisionId', 'projectVersion', 'transactions', 'nextBefore', 'accessEpoch']) || value.revisionId !== id || !integer(value.projectVersion) || !integer(value.accessEpoch) || !Array.isArray(value.transactions) || value.transactions.length > REVISION_PROJECT_LIMITS.page || !(value.nextBefore === null || integer(value.nextBefore, 1))) return false;
  let previous = value.projectVersion + 1; const ids = new Set<string>(), operations = new Set<string>();
  for (const t of value.transactions) { if (!isRevisionProjectTransaction(t, id) || t.projectVersion >= previous || ids.has(t.id) || operations.has(t.operationId)) return false; previous = t.projectVersion; ids.add(t.id); operations.add(t.operationId); }
  return value.nextBefore === null || value.transactions.length > 0 && value.nextBefore === value.transactions.at(-1)!.projectVersion;
}
