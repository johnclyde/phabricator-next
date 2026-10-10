import type { RevisionDetail, RevisionVersion } from '../shared/types';
import type { ComparisonMode } from '../shared/comparison';

export interface VersionIdentity { id: string; contentHash: string }
export interface ComparisonSelection {
  revisionId: string;
  base: VersionIdentity | null;
  target: VersionIdentity;
  filePath: string;
  mode: ComparisonMode;
  view: 'changes' | 'source' | 'structure';
}
export const versionIdentity = (version: RevisionVersion): VersionIdentity => ({ id: version.id, contentHash: version.contentHash });
export function comparisonPaths(base: RevisionVersion | null, target: RevisionVersion): string[] {
  return [...new Set([...target.files.map(file => file.path), ...(base?.files.map(file => file.path) || [])])];
}
export function defaultComparison(detail: RevisionDetail): ComparisonSelection | null {
  const target = detail.versions.find(version => version.number === detail.revision.currentVersion);
  if (!target) return null;
  const base = detail.versions.find(version => version.number === target.number - 1) || null;
  return { revisionId: detail.revision.id, base: base ? versionIdentity(base) : null, target: versionIdentity(target), filePath: comparisonPaths(base, target)[0] || '', mode: detail.revision.kind === 'code' ? 'lines' : 'words', view: 'changes' };
}
export function isComparisonSelection(value: unknown, revisionId: string): value is ComparisonSelection {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  const identity = (item: unknown) => Boolean(item && typeof item === 'object' && typeof (item as VersionIdentity).id === 'string' && (item as VersionIdentity).id.length > 0 && typeof (item as VersionIdentity).contentHash === 'string' && (item as VersionIdentity).contentHash.length > 0);
  return row.revisionId === revisionId && (row.base === null || identity(row.base)) && identity(row.target) && typeof row.filePath === 'string' && row.filePath.length > 0 && (row.mode === 'words' || row.mode === 'lines') && (row.view === 'changes' || row.view === 'source' || row.view === 'structure');
}
export function resolveComparison(detail: RevisionDetail, selection: ComparisonSelection): { base: RevisionVersion | null; target: RevisionVersion } | { error: string } {
  const find = (identity: VersionIdentity) => detail.versions.find(version => version.revisionId === detail.revision.id && version.id === identity.id && version.contentHash === identity.contentHash);
  const target = find(selection.target); const base = selection.base ? find(selection.base) || null : null;
  if (selection.revisionId !== detail.revision.id || !target || (selection.base && !base)) return { error: 'A selected immutable version is unavailable or its snapshot hash does not match. Choose versions explicitly, or show the current version.' };
  if (!comparisonPaths(base, target).includes(selection.filePath)) return { error: 'The selected file is unavailable in this pair. Choose a file explicitly.' };
  return { base, target };
}
/** The persisted record contains identities and presentation preferences, never source. */
export function comparisonMetadata(selection: ComparisonSelection): ComparisonSelection {
  return { revisionId: selection.revisionId, base: selection.base && { id: selection.base.id, contentHash: selection.base.contentHash }, target: { id: selection.target.id, contentHash: selection.target.contentHash }, filePath: selection.filePath, mode: selection.mode, view: selection.view };
}
