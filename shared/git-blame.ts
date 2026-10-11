import { GIT_LIMITS, isGitObjectId, isGitPath } from './repositories';
import type { GitBlame, GitBlob, GitCommit, GitObjectFormat } from './repositories';

/** Git logical lines exclude only LF. Preserve CR, BOM and an unterminated final line. */
export function gitSourceLines(content: string): string[] {
  if (content === '') return [];
  const lines = content.split('\n');
  if (content.endsWith('\n')) lines.pop();
  return lines;
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const oid = (value: unknown, format: GitObjectFormat): value is string => typeof value === 'string' && isGitObjectId(value, format);
function validCommit(value: unknown, format: GitObjectFormat): value is GitCommit {
  return record(value) && oid(value.id, format) && oid(value.treeId, format) && Array.isArray(value.parentIds) && value.parentIds.every(id => oid(id, format))
    && typeof value.message === 'string' && typeof value.messageTruncated === 'boolean'
    && [value.author, value.committer].every(person => record(person) && typeof person.name === 'string' && typeof person.email === 'string' && typeof person.timestamp === 'string' && Number.isFinite(Date.parse(person.timestamp)));
}
function validBlob(value: unknown, id: string, commitId: string, path: string, format: GitObjectFormat, epoch: number): value is GitBlob {
  if (!record(value) || value.repositoryId !== id || value.objectFormat !== format || value.commitId !== commitId || value.path !== path || !oid(value.objectId, format)
    || ('accessEpoch' in value && value.accessEpoch !== epoch)) return false;
  if (value.mode === '160000') return value.state === 'submodule' && value.size === null && !('content' in value);
  if (!integer(value.size)) return false;
  if (value.mode === '120000') return value.state === 'symlink' && !('content' in value);
  if (!['100644', '100755'].includes(String(value.mode))) return false;
  if (value.state === 'oversized') return value.size > GIT_LIMITS.blobBytes && !('content' in value);
  if (value.size > GIT_LIMITS.blobBytes) return false;
  if (value.state === 'binary' || value.state === 'unsupported_encoding') return !('content' in value);
  if (value.state !== 'text' || typeof value.content !== 'string' || value.content.includes('\0')) return false;
  const bytes = new TextEncoder().encode(value.content);
  return bytes.length === value.size && new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes) === value.content;
}

/** Validate exact identity and complete attribution before rendering or retaining source. */
export function validGitBlame(value: unknown, id: string, commitId: string, path: string): value is GitBlame {
  if (!path || !isGitPath(path) || !record(value) || value.repositoryId !== id || !['sha1', 'sha256'].includes(String(value.objectFormat))
    || value.algorithm !== 'git-blame-root' || !integer(value.accessEpoch)) return false;
  const format = value.objectFormat as GitObjectFormat;
  if (!isGitObjectId(commitId, format) || !validCommit(value.commit, format) || value.commit.id !== commitId
    || !validBlob(value.blob, id, commitId, path, format, value.accessEpoch) || !Array.isArray(value.commits) || value.commits.length > GIT_LIMITS.blameOrigins
    || !value.commits.every(commit => validCommit(commit, format))) return false;
  // Cache input and mocked providers are untrusted too; retain the HTTP response bound.
  try { if (new TextEncoder().encode(JSON.stringify(value)).length > GIT_LIMITS.outputBytes) return false; } catch { return false; }
  if (value.blob.state !== 'text') return value.lines === null && value.commits.length === 0;
  if (!Array.isArray(value.lines) || value.lines.length > GIT_LIMITS.blameLines || value.lines.length !== gitSourceLines(value.blob.content).length) return false;
  const origins = new Set(value.commits.map(commit => (commit as GitCommit).id));
  if (origins.size !== value.commits.length) return false;
  const used = new Set<string>();
  const paths = new Set<string>();
  for (const [index, line] of value.lines.entries()) {
    if (!record(line) || line.lineNumber !== index + 1 || !oid(line.commitId, format) || !origins.has(line.commitId)
      || !integer(line.originalLine) || line.originalLine < 1 || typeof line.path !== 'string' || !line.path || !isGitPath(line.path)) return false;
    used.add(line.commitId);
    paths.add(JSON.stringify([line.commitId, line.path]));
  }
  return used.size === origins.size && paths.size <= GIT_LIMITS.blameOrigins;
}
