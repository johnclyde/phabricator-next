import type { GitObjectFormat } from './repositories';
import type { RevisionVersion } from './types';

/** Pins a complete immutable text-tree revision to its verified Git baseline. */
export interface RevisionPatchIdentity {
  revisionId: string;
  versionId: string;
  versionNumber: number;
  contentHash: string;
  baseVersionId: string | null;
  baseContentHash: string;
  baseCommitId: string;
  baseTreeId: string;
  targetTreeId: string;
  objectFormat: GitObjectFormat;
  patchSha256: string;
}

export interface RevisionPatchManifestEntry { path: string; mode: '100644' | '100755'; objectId: string }
export interface RevisionPatchFile { path: string; mode: '100644' | '100755'; content: string }

/** Only server-owned immutable versions may create this payload. It is a whole
 * text tree, so omitted baseline paths are deletions, not unobserved files. */
export interface RevisionPatchPayload extends RevisionPatchIdentity {
  format: 'revision-text-tree-v1';
  repositoryId: string;
  baseManifest: RevisionPatchManifestEntry[];
  files: RevisionPatchFile[];
}

export interface RevisionPatchChange {
  path: string;
  before: RevisionPatchManifestEntry | null;
  after: (RevisionPatchManifestEntry & { content: string }) | null;
}

/** Reject names which can alias Git's administrative directory on supported
 * filesystems, including HFS ignorable characters and NTFS short names. */
export function isPortableWorkingCopyPath(path: string): boolean {
  if (!path || path.length > 4096 || /[\uD800-\uDFFF]/u.test(path)) return false;
  return path.split('/').every(part => {
    const folded = part.replace(/[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g, '').toLowerCase();
    return Boolean(part) && part !== '.' && part !== '..' && folded !== '.git' && !/^git~[1-9]$/i.test(folded)
      && !/[\\\x00-\x1f\x7f:]/.test(part) && !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part);
  });
}

/** UI eligibility only. The server and worker additionally verify hashes,
 * portable paths, modes, complete manifests and actual Git object identities. */
export function revisionPatchBaseline(repositoryId: string | null, versions: readonly RevisionVersion[], versionId: string): { version: RevisionVersion | null; baseline: RevisionVersion | null; reason: string | null } {
  const version = versions.find(item => item.id === versionId) ?? null;
  if (!repositoryId || !version) return { version, baseline: null, reason: 'Choose a repository-backed revision version.' };
  if (version.docx || version.assets?.length) return { version, baseline: null, reason: 'Revision working copies currently require a complete text tree without Word sources or attached binary assets.' };
  const baseline = [...versions].filter(item => item.revisionId === version.revisionId && item.number <= version.number && item.gitSource?.repositoryId === repositoryId).sort((a, b) => b.number - a.number)[0] ?? null;
  if (!baseline) return { version, baseline: null, reason: 'Import a verified Git text tree before requesting a revision working copy.' };
  return { version, baseline, reason: null };
}
