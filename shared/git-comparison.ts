import { GIT_LIMITS, isGitObjectId, isGitPath } from './repositories';
import type { GitCommit, GitComparison, GitComparisonChange, GitComparisonEntry, GitComparisonFile, GitComparisonFileQuery, GitComparisonIdentity, GitComparisonQuery, GitComparisonSide, GitObjectFormat } from './repositories';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const oid = (value: unknown, format: GitObjectFormat): value is string => typeof value === 'string' && isGitObjectId(value, format);
const size = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const entryTypes: Record<string, string> = { '040000': 'tree', '100644': 'file', '100755': 'file', '120000': 'symlink', '160000': 'submodule' };
function commit(value: unknown, id: string, format: GitObjectFormat): value is GitCommit {
  if (!record(value) || value.id !== id || !oid(value.treeId, format) || !Array.isArray(value.parentIds) || value.parentIds.some(parent => !oid(parent, format))
    || typeof value.message !== 'string' || typeof value.messageTruncated !== 'boolean') return false;
  return [value.author, value.committer].every(person => record(person) && typeof person.name === 'string' && typeof person.email === 'string' && typeof person.timestamp === 'string' && Number.isFinite(Date.parse(person.timestamp)));
}
function identity(value: unknown, repositoryId: string, query: GitComparisonQuery): value is GitComparisonIdentity {
  if (!record(value) || value.repositoryId !== repositoryId || (value.objectFormat !== 'sha1' && value.objectFormat !== 'sha256')) return false;
  const format = value.objectFormat;
  return isGitObjectId(query.target, format) && (query.base === null || isGitObjectId(query.base, format))
    && commit(value.targetCommit, query.target, format) && oid(value.targetTreeId, format) && value.targetTreeId === value.targetCommit.treeId
    && oid(value.baseTreeId, format) && (query.base === null ? value.baseCommit === null : commit(value.baseCommit, query.base, format) && value.baseTreeId === value.baseCommit.treeId)
    && size(value.accessEpoch);
}
function entry(value: unknown, format: GitObjectFormat): value is GitComparisonEntry {
  return record(value) && typeof value.path === 'string' && value.path !== '' && isGitPath(value.path) && oid(value.objectId, format)
    && typeof value.mode === 'string' && Object.hasOwn(entryTypes, value.mode) && value.type === entryTypes[value.mode]
    && (value.size === null || size(value.size)) && (!['tree', 'submodule'].includes(String(value.type)) || value.size === null);
}
function change(value: unknown, format: GitObjectFormat): value is GitComparisonChange {
  if (!record(value) || typeof value.id !== 'string' || !/^[a-f0-9]{64}$/.test(value.id)
    || !(value.before === null || entry(value.before, format)) || !(value.after === null || entry(value.after, format))) return false;
  const before = value.before, after = value.after;
  if (value.status === 'added') return before === null && after !== null && value.similarity === null;
  if (value.status === 'deleted') return after === null && before !== null && value.similarity === null;
  if (!before || !after) return false;
  if (value.status === 'renamed' || value.status === 'copied') return before.path !== after.path && size(value.similarity) && value.similarity <= 100;
  return ['modified', 'type_changed'].includes(String(value.status)) && before.path === after.path && value.similarity === null;
}
export function sameGitComparisonChange(left: GitComparisonChange, right: GitComparisonChange): boolean {
  const same = (a: GitComparisonEntry | null, b: GitComparisonEntry | null) => a === null || b === null ? a === b : a.path === b.path && a.objectId === b.objectId && a.mode === b.mode && a.type === b.type && a.size === b.size;
  return left.id === right.id && left.status === right.status && left.similarity === right.similarity && same(left.before, right.before) && same(left.after, right.after);
}
/** Bind a response to the ordered pair before rendering or retaining its source. */
export function validGitComparison(value: unknown, repositoryId: string, query: GitComparisonQuery): value is GitComparison {
  if (!identity(value, repositoryId, query) || !('algorithm' in value) || value.algorithm !== 'git-M50-C50' || !('changes' in value) || !Array.isArray(value.changes)
    || value.changes.length > GIT_LIMITS.comparisonChanges || value.changes.some(item => !change(item, value.objectFormat))) return false;
  const changes = value.changes as GitComparisonChange[];
  return new Set(changes.map(item => item.id)).size === changes.length
    && new Set(changes.map(item => JSON.stringify([item.before?.path ?? null, item.after?.path ?? null]))).size === changes.length
    && (query.base !== null || changes.every(item => item.before === null));
}
function side(value: unknown, expected: GitComparisonEntry | null, id: string, commitId: string | null, format: GitObjectFormat): value is GitComparisonSide | null {
  if (expected === null) return value === null;
  if (!record(value) || commitId === null || value.repositoryId !== id || value.objectFormat !== format || value.commitId !== commitId || value.path !== expected.path || value.objectId !== expected.objectId || value.mode !== expected.mode
    || (expected.size !== null && value.size !== expected.size)) return false;
  if (expected.type === 'tree' || expected.type === 'submodule') return value.state === expected.type && value.size === null && !('content' in value);
  if (!size(value.size)) return false;
  if (expected.type === 'symlink') return value.state === 'symlink' && !('content' in value);
  if (value.state === 'text') return typeof value.content === 'string' && value.size <= GIT_LIMITS.blobBytes && new TextEncoder().encode(value.content).length === value.size;
  return ['binary', 'oversized', 'unsupported_encoding'].includes(String(value.state)) && !('content' in value);
}
export function validGitComparisonFile(value: unknown, repositoryId: string, query: GitComparisonFileQuery, expected?: GitComparisonChange): value is GitComparisonFile {
  if (!identity(value, repositoryId, query) || !('change' in value) || !change(value.change, value.objectFormat) || !('before' in value) || !('after' in value)) return false;
  const item = value.change;
  return (item.before?.path ?? null) === query.beforePath && (item.after?.path ?? null) === query.afterPath
    && (!expected || sameGitComparisonChange(item, expected))
    && side(value.before, item.before, repositoryId, query.base, value.objectFormat) && side(value.after, item.after, repositoryId, query.target, value.objectFormat);
}
