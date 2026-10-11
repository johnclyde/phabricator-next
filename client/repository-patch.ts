import type { GitComparisonQuery } from '../shared/repositories';
import type { RepositorySelection } from './repository-cache';

export const patchPair = (selection: Pick<RepositorySelection, 'baseCommitId' | 'commitId'>): GitComparisonQuery => ({ base: selection.baseCommitId ?? null, target: selection.commitId });
export const patchCacheKey = (query: GitComparisonQuery) => JSON.stringify(['patch', 'git-binary-patch-v1', query.base, query.target]);
export const patchQuery = (query: GitComparisonQuery) => new URLSearchParams({ base: query.base ?? 'empty', target: query.target }).toString();

export function patchAccessMatches(patchEpoch: number | undefined, sessionEpoch: number | undefined, localOffline: boolean, savedEpoch?: number): boolean {
  if (!Number.isSafeInteger(patchEpoch) || Number(patchEpoch) < 0) return false;
  return patchEpoch === sessionEpoch || sessionEpoch === -1 && localOffline && savedEpoch === patchEpoch;
}
