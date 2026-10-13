import type { ActorAttribution } from './types';
import type { GitObjectFormat, GitPerson } from './repositories';
import type { RevisionPatchIdentity } from './revision-patch';

export interface RevisionLandingBinding { key: string; repositoryId: string; branches: string[] }
export interface RevisionLandingPins {
  expectedVersion: number;
  expectedVersionId: string;
  expectedContentHash: string;
  expectedLifecycleVersion: number;
  expectedAuthorVersion: number;
  expectedReviewerVersion: number;
  expectedMetadataVersion: number;
  expectedEvidenceSha256: string;
  expectedConfigId: string;
  expectedAccessEpoch: number;
}
export interface RevisionLandingPrepareInput extends RevisionLandingPins {
  binding: string;
  branch: string;
  baseCommitId: string;
  expectedTargetCommitId: string;
}
/** The commit is a squash of the exact reviewed tree onto one explicit base. */
export interface GitLandingPrepared {
  operationId: string;
  binding: string;
  repositoryId: string;
  branch: string;
  expectedTargetCommitId: string;
  commitId: string;
  treeId: string;
  objectFormat: GitObjectFormat;
  markerRef: string;
  repositoryFingerprint: string;
  createdAt: string;
  message: string;
  author: GitPerson;
  committer: GitPerson;
}
export type RevisionLandingState = 'prepared' | 'landed' | 'conflict' | 'cancelled';
export interface LandingGateProof { receiptId: string; allowed: true; evidenceSha256: string }
export interface RevisionLandingOperation {
  id: string;
  revisionId: string;
  version: number;
  state: RevisionLandingState;
  input: RevisionLandingPrepareInput;
  patch: RevisionPatchIdentity;
  prepared: GitLandingPrepared;
  attribution: ActorAttribution;
  reviewIds: string[];
  gateProof: LandingGateProof | null;
  createdAt: string;
  updatedAt: string;
  landedAt: string | null;
  message: string;
}
export interface RevisionLandingCommand { command: 'land' | 'cancel'; expectedVersion: number }
export interface RevisionLandingEvent { id: string; operationId: string; version: number; state: RevisionLandingState; message: string; createdAt: string; actorId: string }
export interface RevisionLandingDetail { operation: RevisionLandingOperation; events: RevisionLandingEvent[]; accessEpoch?: number; canLand?: boolean; canCancel?: boolean; canRecover?: boolean }
export interface RevisionLandingSnapshot {
  revisionId: string;
  repositoryId: string | null;
  pins: RevisionLandingPins;
  canPrepare: boolean;
  reason: string | null;
  suggestedBaseCommitId: string | null;
  bindings: RevisionLandingBinding[];
  operations: RevisionLandingOperation[];
  accessEpoch: number;
}

export function isLandingBranch(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('refs/heads/') && value.length <= 255
    && !/[\x00-\x20\x7f~^:?*\[\\]/.test(value) && !value.includes('..') && !value.includes('@{')
    && value.split('/').every(part => Boolean(part) && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock'));
}
const hash = (value: unknown, git = false): value is string => typeof value === 'string' && (git ? /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/ : /^[a-f0-9]{64}$/).test(value);
export function revisionLandingPrepareInput(input: unknown): RevisionLandingPrepareInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Provide a pinned revision landing request.');
  const value = input as Record<string, unknown>;
  const numbers = ['expectedVersion','expectedLifecycleVersion','expectedAuthorVersion','expectedReviewerVersion','expectedMetadataVersion','expectedAccessEpoch'];
  const expected = [...numbers,'binding','branch','baseCommitId','expectedTargetCommitId','expectedVersionId','expectedContentHash','expectedEvidenceSha256','expectedConfigId'];
  if (Object.keys(value).length !== expected.length || Object.keys(value).some(key => !expected.includes(key))
    || numbers.some(key => !Number.isSafeInteger(value[key]) || Number(value[key]) < (key === 'expectedVersion' ? 1 : 0))
    || typeof value.binding !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(value.binding)
    || !isLandingBranch(value.branch) || !hash(value.baseCommitId,true) || !hash(value.expectedTargetCommitId,true) || value.baseCommitId !== value.expectedTargetCommitId
    || typeof value.expectedVersionId !== 'string' || !value.expectedVersionId || value.expectedVersionId.length > 240 || value.expectedVersionId.includes('\0')
    || !hash(value.expectedContentHash) || !hash(value.expectedEvidenceSha256) || !hash(value.expectedConfigId)) throw new Error('Pin the exact reviewed version, acceptance, and target branch base.');
  return value as unknown as RevisionLandingPrepareInput;
}
export function revisionLandingCommand(input: unknown): RevisionLandingCommand {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Choose a landing command.');
  const value = input as Record<string,unknown>;
  if (Object.keys(value).length !== 2 || !['land','cancel'].includes(String(value.command)) || !Number.isSafeInteger(value.expectedVersion) || Number(value.expectedVersion) < 1) throw new Error('Choose a landing command and exact operation version.');
  return value as unknown as RevisionLandingCommand;
}
