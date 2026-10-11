import { isGitObjectId, isGitPath } from '../shared/repositories';

export interface RepositorySelection { commitId: string; path: string; view: 'tree' | 'file' | 'history' | 'changes' | 'blame'; historyFrom?: 'tree' | 'file'; baseCommitId?: string | null; beforePath?: string | null; afterPath?: string | null; selectedLine?: number }
export function repositorySelection(value: unknown): RepositorySelection | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  if (typeof item.commitId !== 'string' || !isGitObjectId(item.commitId) || typeof item.path !== 'string' || !isGitPath(item.path) || !['tree', 'file', 'history', 'changes', 'blame'].includes(String(item.view)) || typeof item.view !== 'string') return null;
  if (item.view === 'blame') {
    if (!item.path || item.selectedLine !== undefined && (!Number.isSafeInteger(item.selectedLine) || Number(item.selectedLine) < 1)) return null;
    return { commitId: item.commitId, path: item.path, view: 'blame', ...(item.selectedLine === undefined ? {} : { selectedLine: Number(item.selectedLine) }) };
  }
  if (item.view === 'changes') {
    if (item.baseCommitId !== null && (typeof item.baseCommitId !== 'string' || !isGitObjectId(item.baseCommitId) || item.baseCommitId.length !== item.commitId.length)) return null;
    for (const key of ['beforePath', 'afterPath']) if (item[key] !== null && item[key] !== undefined && (typeof item[key] !== 'string' || !item[key] || !isGitPath(item[key]))) return null;
    if (item.baseCommitId === null && item.beforePath != null) return null;
    return { commitId: item.commitId, path: '', view: 'changes', baseCommitId: item.baseCommitId, beforePath: item.beforePath as string | null ?? null, afterPath: item.afterPath as string | null ?? null };
  }
  if (item.historyFrom !== undefined && item.historyFrom !== 'tree' && item.historyFrom !== 'file') return null;
  return { commitId: item.commitId, path: item.path, view: item.view as RepositorySelection['view'], ...(item.view === 'history' && item.historyFrom ? { historyFrom: item.historyFrom } : {}) };
}
export interface RepositoryCache { accessEpoch?: number; entries: { key: string; value: unknown }[] }
export const REPOSITORY_CACHE_LIMITS = { entries: 16, bytes: 2_000_000 } as const;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
export function repositoryCache(value: unknown): RepositoryCache {
  if (!value || typeof value !== 'object' || !('entries' in value) || !Array.isArray(value.entries)) return { entries: [] };
  if (value.entries.length && (!('accessEpoch' in value) || !Number.isSafeInteger(value.accessEpoch) || Number(value.accessEpoch) < 0)) return { entries: [] };
  try { if (bytes(value) > REPOSITORY_CACHE_LIMITS.bytes || value.entries.length > REPOSITORY_CACHE_LIMITS.entries) return { entries: [] }; } catch { return { entries: [] }; }
  return { ...('accessEpoch' in value && Number.isSafeInteger(value.accessEpoch) && Number(value.accessEpoch) >= 0 ? { accessEpoch: Number(value.accessEpoch) } : {}), entries: value.entries.filter((entry): entry is { key: string; value: unknown } => Boolean(entry && typeof entry === 'object' && typeof entry.key === 'string' && 'value' in entry)) };
}
export function putRepositoryCache(cache: RepositoryCache, key: string, value: unknown): RepositoryCache {
  const accessEpoch = value && typeof value === 'object' && 'accessEpoch' in value && Number.isSafeInteger(value.accessEpoch) ? Number(value.accessEpoch) : cache.accessEpoch;
  const previous = (cache.accessEpoch === accessEpoch ? cache.entries : []).filter(entry => entry.key !== key);
  if (bytes({ accessEpoch, entries: [{ key, value }] }) > REPOSITORY_CACHE_LIMITS.bytes) return { accessEpoch, entries: previous };
  const entries = [...previous, { key, value }].slice(-REPOSITORY_CACHE_LIMITS.entries);
  while (entries.length && bytes({ accessEpoch, entries }) > REPOSITORY_CACHE_LIMITS.bytes) entries.shift();
  return { accessEpoch, entries };
}
