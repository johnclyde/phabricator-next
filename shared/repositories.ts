import type { ObjectAccess } from './policy';
import type { Repository, RevisionKind, SourceFile } from './types';

/** Limits bound a single observed result; an exceeded limit is never an empty result. */
export const GIT_LIMITS = Object.freeze({
  blobBytes: 256_000, outputBytes: 2_000_000, refs: 1_000, treeEntries: 1_000,
  historyDefault: 25, historyPage: 100, historyOffset: 100_000,
  messageBytes: 16_000, pathLength: 4_096, timeoutMs: 10_000,
  concurrency: 4, queued: 16,
});
export type GitObjectFormat = 'sha1' | 'sha256';
export function isGitObjectId(value: string, format?: GitObjectFormat): boolean {
  return (format === 'sha1' ? /^[0-9a-f]{40}$/ : format === 'sha256' ? /^[0-9a-f]{64}$/ : /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/).test(value);
}
/** Paths address Git trees only. They are never interpreted as host filesystem paths. */
export function isGitPath(value: string): boolean {
  return value.length <= GIT_LIMITS.pathLength && !value.includes('\0') && (value === '' || value.split('/').every(part => part !== '' && part !== '.' && part !== '..'));
}
export type GitObserverInfo = { state: 'unconfigured' | 'unavailable'; message: string } | { state: 'ready'; objectFormat: GitObjectFormat };
export interface RepositoryDetail { repository: Repository; observer: GitObserverInfo; access?: ObjectAccess; accessEpoch?: number }
export interface GitResponse { repositoryId: string; objectFormat: GitObjectFormat; accessEpoch?: number }
export interface GitRef { name: string; kind: 'branch' | 'tag'; objectId: string; commitId: string | null }
export interface GitRefs extends GitResponse { observedAt: string; headCommit: string | null; refs: GitRef[] }
export interface GitPerson { name: string; email: string; timestamp: string }
export interface GitCommit { id: string; treeId: string; parentIds: string[]; author: GitPerson; committer: GitPerson; message: string; messageTruncated: boolean }
export interface GitCommitResult extends GitResponse { commit: GitCommit }
export type GitEntryType = 'tree' | 'file' | 'symlink' | 'submodule';
export interface GitTreeEntry { name: string; path: string; objectId: string; mode: string; type: GitEntryType; size: number | null }
export interface GitTree extends GitResponse { commitId: string; path: string; treeId: string; entries: GitTreeEntry[] }
interface GitBlobIdentity extends GitResponse { commitId: string; path: string; objectId: string; mode: string }
export type GitBlob = GitBlobIdentity & ({ state: 'text'; content: string; size: number } | { state: 'binary' | 'oversized' | 'unsupported_encoding' | 'symlink'; size: number } | { state: 'submodule'; size: null });
export interface GitHistoryQuery { commit: string; path?: string; after?: number; limit?: number }
export interface GitHistory extends GitResponse { commitId: string; path: string; commits: GitCommit[]; nextAfter: number | null }

/** Original Git identity of a complete imported text tree, never inherited by edited versions. */
export interface GitSourceProvenance {
  kind: 'git'; repositoryId: string; objectFormat: GitObjectFormat;
  commitId: string; treeId: string; scope: 'complete-text-tree';
  manifest: { path: string; mode: '100644' | '100755'; objectId: string }[];
}
/** Internal verified collector output. Import APIs accept commit selectors and metadata, never this source payload. */
export interface GitImportSnapshot extends GitResponse { files: SourceFile[]; provenance: GitSourceProvenance }
export interface GitImportInput { commitId: string; kind: RevisionKind; title: string; summary?: string; projectId?: string | null }

/** Explicit whole-tree replacement pinned to the current immutable review version. */
export interface GitVersionImportInput {
  commitId: string;
  expectedVersion: number;
  expectedVersionId: string;
  expectedContentHash: string;
  message: string;
}
