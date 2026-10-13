import type { GitCommit, GitObjectFormat } from './repositories';
import type { HeraldSnapshot } from './herald';

/** These facts may only be submitted by an operator-configured receive hook.
 * They are not a request format for ordinary users to supply repository source. */
export interface GitReceiveFile { path: string; content: string; added: string; removed: string }
export interface GitReceiveCommit { commit: GitCommit; files: GitReceiveFile[]; inspectionComplete: true }
export interface GitReceiveUpdate {
  refName: string; oldId: string | null; newId: string | null;
  oldCommitId: string | null; newCommitId: string | null; forced: boolean;
  commits: GitReceiveCommit[];
}
export interface GitReceiveFacts {
  repositoryId: string; objectFormat: GitObjectFormat; phase: 'pre' | 'post';
  requestId: string; pusherId: string; inspectionComplete: true; updates: GitReceiveUpdate[];
}
export interface GitReceiveReceipt {
  id: string; repositoryId: string; phase: 'pre' | 'post'; requestId: string;
  allowed: boolean; reasons: string[]; transcriptIds: string[]; commitIds: string[]; createdAt: string;
}
export interface GitAutomationObject {
  id: string; repositoryId: string; kind: 'commit' | 'push-ref' | 'push-content';
  snapshot: HeraldSnapshot; commit: GitReceiveCommit | null; objectFormat: GitObjectFormat;
}

/** Git automation subjects inherit the repository's current access policy. */
export function heraldPolicyObjectId(snapshot: HeraldSnapshot): string {
  if (!['commit', 'push-ref', 'push-content'].includes(snapshot.contentType)) return snapshot.objectId;
  if (!snapshot.repositoryId || !/^R[1-9]\d{0,14}$/.test(snapshot.repositoryId)) throw new Error('Git automation evidence requires a repository.');
  return snapshot.repositoryId;
}
