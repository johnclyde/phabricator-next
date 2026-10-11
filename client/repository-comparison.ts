import type { GitComparison, GitComparisonChange, GitComparisonFile } from '../shared/repositories';
import { validGitComparison, validGitComparisonFile } from '../shared/git-comparison';
import type { RepositorySelection } from './repository-cache';

export const comparisonPair = (selection: RepositorySelection) => JSON.stringify([selection.baseCommitId ?? null, selection.commitId]);
export const comparisonCacheKey = (selection: RepositorySelection, file = false) => JSON.stringify(file ? ['comparison-file', selection.baseCommitId ?? null, selection.commitId, selection.beforePath ?? null, selection.afterPath ?? null] : ['comparison', selection.baseCommitId ?? null, selection.commitId]);
export function comparisonQuery(selection: RepositorySelection, file = false): string {
  const query = new URLSearchParams({ base: selection.baseCommitId ?? 'empty', target: selection.commitId });
  if (file) { if (selection.beforePath != null) query.set('beforePath', selection.beforePath); if (selection.afterPath != null) query.set('afterPath', selection.afterPath); }
  return query.toString();
}
export function selectedChange(comparison: GitComparison, selection: RepositorySelection): GitComparisonChange | undefined { return comparison.changes.find(change => (change.before?.path ?? null) === (selection.beforePath ?? null) && (change.after?.path ?? null) === (selection.afterPath ?? null)); }
export function validComparison(value: unknown, id: string, selection: RepositorySelection): value is GitComparison { return validGitComparison(value, id, { base: selection.baseCommitId ?? null, target: selection.commitId }); }
export function validComparisonFile(value: unknown, id: string, selection: RepositorySelection, inventory: GitComparison): value is GitComparisonFile {
  const selected = selectedChange(inventory, selection);
  return Boolean(selected) && validGitComparisonFile(value, id, { base: selection.baseCommitId ?? null, target: selection.commitId, beforePath: selection.beforePath ?? null, afterPath: selection.afterPath ?? null }, selected) && value.accessEpoch === inventory.accessEpoch && value.baseTreeId === inventory.baseTreeId && value.targetTreeId === inventory.targetTreeId;
}
