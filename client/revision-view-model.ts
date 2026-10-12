import { isRevisionSavedView, isRevisionViewId, revisionViewFilters, revisionViewInput, type RevisionSavedView, type RevisionViewAction, type RevisionViewFilters, type RevisionViewInput } from '../shared/revision-views';
import type { RevisionKind } from '../shared/types';

export type RevisionBuiltinView = 'all' | 'authored' | 'following';
export interface RevisionViewDraft { filters: RevisionViewFilters; name: string; builtin: RevisionBuiltinView; base: RevisionSavedView | null }
export interface RevisionViewIntent { id: string; principalId: string; action: RevisionViewAction; viewId: string | null; input: RevisionViewInput; draft: RevisionViewDraft }
export const revisionKind = (view: string): RevisionKind | null => view === 'reviews' ? 'code' : view === 'papers' ? 'paper' : view === 'drafts' ? 'document' : null;
export function builtinRevisionView(kind: RevisionKind, builtin: RevisionBuiltinView = 'all'): RevisionViewDraft {
  return { filters: { kind, query: '', status: 'all', projectId: null, following: builtin === 'following', authored: builtin === 'authored' }, name: '', builtin, base: null };
}
export function savedRevisionView(view: RevisionSavedView): RevisionViewDraft { return { filters: revisionViewFilters(view.filters), name: view.name, builtin: 'all', base: view }; }
export function revisionViewDraft(value: unknown, kind: RevisionKind): RevisionViewDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as RevisionViewDraft;
  try {
    const filters = revisionViewFilters(row.filters);
    if (filters.kind !== kind || typeof row.name !== 'string' || row.name.length > 80 || !['all', 'authored', 'following'].includes(row.builtin) || row.base !== null && (!isRevisionSavedView(row.base) || row.base.filters.kind !== kind)) return null;
    return { filters, name: row.name, builtin: row.builtin, base: row.base };
  } catch { return null; }
}
export function revisionViewDirty(draft: RevisionViewDraft): boolean {
  const base = draft.base ? savedRevisionView(draft.base) : builtinRevisionView(draft.filters.kind, draft.builtin);
  return draft.name !== base.name || JSON.stringify(draft.filters) !== JSON.stringify(base.filters);
}
export function revisionViewIntent(value: unknown, principalId: string): RevisionViewIntent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as RevisionViewIntent;
  if (typeof row.id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(row.id) || row.principalId !== principalId || !['create', 'edit', 'delete'].includes(row.action) || (row.action === 'create' ? row.viewId !== null : !isRevisionViewId(row.viewId))) return null;
  try {
    const input = revisionViewInput(row.action, row.input), draft = revisionViewDraft(row.draft, row.draft?.filters?.kind);
    if (!draft || row.action !== 'create' && (draft.base?.id !== row.viewId || draft.base.version !== ('expectedVersion' in input ? input.expectedVersion : null)) || row.action !== 'delete' && (!('filters' in input) || JSON.stringify(input.filters) !== JSON.stringify(draft.filters) || input.name !== draft.name.trim())) return null;
    return { id: row.id, principalId, action: row.action, viewId: row.viewId, input, draft };
  } catch { return null; }
}
export function matchRevisionViews(views: readonly RevisionSavedView[], kind: RevisionKind, name: string): RevisionSavedView[] {
  const exact = name.trim().toLowerCase();
  return views.filter(view => view.filters.kind === kind && (view.id.toLowerCase() === exact || view.name.toLowerCase() === exact));
}
