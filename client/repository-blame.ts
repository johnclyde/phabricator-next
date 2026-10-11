import type { RepositorySelection } from './repository-cache';

export const BLAME_PAGE_LINES = 100;
export const blameCacheKey = (selection: Pick<RepositorySelection, 'commitId' | 'path'>) => JSON.stringify(['blame', selection.commitId, selection.path]);
export const blameQuery = (selection: Pick<RepositorySelection, 'commitId' | 'path'>) => new URLSearchParams({ commit: selection.commitId, path: selection.path }).toString();
export function blamePage(line: number, count: number): { start: number; end: number } {
  const start = Math.floor((Math.min(Math.max(1, line), Math.max(1, count)) - 1) / BLAME_PAGE_LINES) * BLAME_PAGE_LINES;
  return { start, end: Math.min(start + BLAME_PAGE_LINES, count) };
}
