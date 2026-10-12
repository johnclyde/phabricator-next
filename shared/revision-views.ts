import type { AppState, Revision, RevisionKind } from './types';
import { isRevisionStatus, type RevisionStatus } from './revision-status';
import { visibleProjectScope } from './project-hierarchy';
import { isRevisionProjectId } from './revision-projects';

export const REVISION_VIEW_LIMITS = { views: 100, name: 80, query: 512 } as const;
export interface RevisionViewFilters { kind: RevisionKind; query: string; status: 'all' | RevisionStatus; projectId: string | null; following: boolean; authored: boolean }
export interface RevisionSavedView { id: string; version: number; name: string; filters: RevisionViewFilters; createdAt: string; updatedAt: string }
export interface RevisionViewsSnapshot { views: RevisionSavedView[]; accessEpoch: number }
export interface RevisionViewSnapshot { view: RevisionSavedView; accessEpoch: number }
export interface RevisionViewCreateInput { name: string; filters: RevisionViewFilters; expectedAccessEpoch: number }
export interface RevisionViewEditInput extends RevisionViewCreateInput { expectedVersion: number }
export interface RevisionViewDeleteInput { expectedVersion: number; expectedAccessEpoch: number }
export type RevisionViewInput = RevisionViewCreateInput | RevisionViewEditInput | RevisionViewDeleteInput;
export type RevisionViewAction = 'create' | 'edit' | 'delete';
export interface RevisionViewResult extends RevisionViewSnapshot { deleted: boolean }
const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const keys = (v: Record<string, unknown>, expected: string[]) => Object.keys(v).length === expected.length && expected.every(key => Object.hasOwn(v, key));
const integer = (v: unknown, minimum = 0): v is number => Number.isSafeInteger(v) && Number(v) >= minimum;
const text = (v: unknown, maximum: number): v is string => typeof v === 'string' && v.length <= maximum && !v.includes('\0') && !/[\uD800-\uDFFF]/u.test(v);
const date = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
export const isRevisionViewId = (v: unknown): v is string => typeof v === 'string' && /^RV[1-9]\d{0,14}$/.test(v);
export const revisionViewNameKey = (name: string): string => name.toLowerCase();
function name(v: unknown): string {
  if (!text(v, REVISION_VIEW_LIMITS.name) || !v.trim() || /[\u0000-\u001f\u007f-\u009f]/u.test(v)) throw new Error('Use a saved-view name of 1–80 characters.');
  return v.trim();
}
export function revisionViewFilters(v: unknown): RevisionViewFilters {
  if (!object(v) || !keys(v, ['kind', 'query', 'status', 'projectId', 'following', 'authored']) || !['code', 'paper', 'document'].includes(String(v.kind))
    || !text(v.query, REVISION_VIEW_LIMITS.query) || !(v.status === 'all' || isRevisionStatus(v.status))
    || !(v.projectId === null || isRevisionProjectId(v.projectId)) || typeof v.following !== 'boolean' || typeof v.authored !== 'boolean') throw new Error('Provide exact supported revision filters.');
  return { kind: v.kind as RevisionKind, query: v.query, status: v.status, projectId: v.projectId, following: v.following, authored: v.authored };
}
export function revisionViewCreateInput(v: unknown): RevisionViewCreateInput {
  if (!object(v) || !keys(v, ['name', 'filters', 'expectedAccessEpoch']) || !integer(v.expectedAccessEpoch)) throw new Error('Provide a saved-view name, filters and access version.');
  return { name: name(v.name), filters: revisionViewFilters(v.filters), expectedAccessEpoch: v.expectedAccessEpoch };
}
export function revisionViewEditInput(v: unknown): RevisionViewEditInput {
  if (!object(v) || !keys(v, ['name', 'filters', 'expectedVersion', 'expectedAccessEpoch']) || !integer(v.expectedVersion, 1)) throw new Error('Provide the exact saved-view version, name, filters and access version.');
  return { ...revisionViewCreateInput({ name: v.name, filters: v.filters, expectedAccessEpoch: v.expectedAccessEpoch }), expectedVersion: v.expectedVersion };
}
export function revisionViewDeleteInput(v: unknown): RevisionViewDeleteInput {
  if (!object(v) || !keys(v, ['expectedVersion', 'expectedAccessEpoch']) || !integer(v.expectedVersion, 1) || !integer(v.expectedAccessEpoch)) throw new Error('Provide the exact saved-view and access versions.');
  return { expectedVersion: v.expectedVersion, expectedAccessEpoch: v.expectedAccessEpoch };
}
export function revisionViewInput(action: RevisionViewAction, v: unknown): RevisionViewInput {
  return action === 'create' ? revisionViewCreateInput(v) : action === 'edit' ? revisionViewEditInput(v) : revisionViewDeleteInput(v);
}
export function isRevisionSavedView(v: unknown): v is RevisionSavedView {
  if (!object(v) || !keys(v, ['id', 'version', 'name', 'filters', 'createdAt', 'updatedAt']) || !isRevisionViewId(v.id) || !integer(v.version, 1) || !date(v.createdAt) || !date(v.updatedAt) || v.createdAt > v.updatedAt) return false;
  try { revisionViewFilters(v.filters); return name(v.name) === v.name; } catch { return false; }
}
export function isRevisionViewsSnapshot(v: unknown): v is RevisionViewsSnapshot {
  if (!object(v) || !keys(v, ['views', 'accessEpoch']) || !integer(v.accessEpoch) || !Array.isArray(v.views) || v.views.length > REVISION_VIEW_LIMITS.views || !v.views.every(isRevisionSavedView)) return false;
  return new Set(v.views.map(view => view.id)).size === v.views.length && new Set(v.views.map(view => `${view.filters.kind}:${revisionViewNameKey(view.name)}`)).size === v.views.length;
}
export function isRevisionViewSnapshot(v: unknown): v is RevisionViewSnapshot { return object(v) && keys(v, ['view', 'accessEpoch']) && isRevisionSavedView(v.view) && integer(v.accessEpoch); }
export function validRevisionViewResult(value: unknown, action: RevisionViewAction, input: RevisionViewInput, id?: string): value is RevisionViewResult {
  if (!object(value) || !keys(value, ['view', 'deleted', 'accessEpoch']) || !isRevisionSavedView(value.view) || !integer(value.accessEpoch) || value.deleted !== (action === 'delete') || id !== undefined && value.view.id !== id) return false;
  try {
    const request = revisionViewInput(action, input);
    if (value.view.version !== (action === 'create' ? 1 : (request as RevisionViewEditInput | RevisionViewDeleteInput).expectedVersion + 1)) return false;
    if (action !== 'delete') { const saved = request as RevisionViewCreateInput; if (value.view.name !== saved.name || JSON.stringify(revisionViewFilters(value.view.filters)) !== JSON.stringify(saved.filters)) return false; }
    return action !== 'create' || value.view.createdAt === value.view.updatedAt;
  } catch { return false; }
}

/** Evaluate only an already authorized snapshot. Missing role or project data never broadens a view. */
export function evaluateRevisionView(filters: RevisionViewFilters, snapshot: Pick<AppState, 'revisions' | 'projects' | 'followingRevisionIds' | 'currentPrincipalId'>): Revision[] {
  const f = revisionViewFilters(filters), query = f.query.toLowerCase();
  const projects = f.projectId === null ? null : new Set(visibleProjectScope(f.projectId, snapshot.projects));
  const following = new Set(snapshot.followingRevisionIds ?? []);
  return snapshot.revisions.filter(revision => revision.kind === f.kind && (f.status === 'all' || revision.status === f.status)
    && `${revision.id} ${revision.title} ${revision.summary}`.toLowerCase().includes(query)
    && (!f.authored || Boolean(snapshot.currentPrincipalId) && revision.authorId === snapshot.currentPrincipalId)
    && (!f.following || following.has(revision.id))
    && (projects === null || (revision.projectIds ?? (revision.projectId ? [revision.projectId] : [])).some(id => projects.has(id))));
}
