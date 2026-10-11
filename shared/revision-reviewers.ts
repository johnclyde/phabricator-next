import type { ActorAttribution } from './types';
import type { ObjectAccess } from './policy';
import { isRevisionAuthor, isRevisionAuthorId, isRevisionAuthorHead, type RevisionAuthor, type RevisionAuthorHead } from './revision-authorship';
import { isRevisionId } from './revision-dependencies';
import { isRevisionStatus, revisionIsClosed, type RevisionStatus } from './revision-status';
import { isRevisionLifecycle, isRevisionLifecycleEvidence, type RevisionLifecycle, type RevisionLifecycleConfig, type RevisionLifecycleEvidence } from './revision-lifecycle';

export const REVISION_REVIEWER_ACTIONS = ['add', 'remove', 'block', 'unblock', 'accept', 'request_changes', 'resign'] as const;
export type RevisionReviewerAction = typeof REVISION_REVIEWER_ACTIONS[number];
export const REVISION_REVIEWER_LIMITS = { members: 100, message: 10_000, page: 100 } as const;
export interface RevisionReviewerConfig { allowSelfAccept: boolean }
export const DEFAULT_REVISION_REVIEWER_CONFIG: Readonly<RevisionReviewerConfig> = Object.freeze({ allowSelfAccept: false });
export type RevisionReviewerConfiguration = RevisionLifecycleConfig & RevisionReviewerConfig;
export type RevisionReviewerStatus = 'added' | 'blocking' | 'accepted' | 'rejected' | 'resigned';
export type RevisionReviewerInvalidationReason = 'source_updated' | 'request_review' | 'review_error';
export interface RevisionReviewerInvalidation { reason: RevisionReviewerInvalidationReason; head: RevisionAuthorHead; attribution: ActorAttribution | null; createdAt: string }
export interface RevisionReviewerDecision { head: RevisionAuthorHead; attribution: ActorAttribution; createdAt: string; invalidated: RevisionReviewerInvalidation | null }
export interface RevisionReviewerMember extends RevisionAuthor { status: RevisionReviewerStatus; decision: RevisionReviewerDecision | null }
export type RevisionReviewerAcceptance = { kind: 'legacy'; head: null; transactionId: null } | { kind: 'evidence' | 'reviewers'; head: RevisionAuthorHead; transactionId: string };
export interface RevisionReviewerState { revisionId: string; version: number; members: RevisionReviewerMember[]; acceptance: RevisionReviewerAcceptance | null; updatedAt: string | null }
export interface RevisionReviewerSummary { version: number; accepting: number; rejecting: number; olderRejecting: number; blocking: number; acceptance: RevisionReviewerAcceptance | null }
export interface RevisionReviewerActionOption { action: RevisionReviewerAction; label: string; available: boolean; reason: string | null }
export interface RevisionReviewerSnapshot {
  reviewers: RevisionReviewerState; head: RevisionAuthorHead; lifecycle: RevisionLifecycle;
  authorship: { version: number; author: RevisionAuthor | null }; evidence: RevisionLifecycleEvidence;
  config: RevisionReviewerConfiguration; configId: string; actions: RevisionReviewerActionOption[]; access: ObjectAccess; accessEpoch: number;
}
export interface RevisionReviewerPins {
  expectedReviewerVersion: number; expectedLifecycleVersion: number; expectedAuthorVersion: number;
  expectedVersion: number; expectedVersionId: string; expectedContentHash: string; expectedAccessEpoch: number;
  expectedConfigId: string; expectedEvidenceSha256: string;
}
export type RevisionReviewerInput = RevisionReviewerPins & { message: string } & (
  { action: 'add' | 'remove' | 'block' | 'unblock'; reviewerId: string } | { action: 'accept' | 'request_changes' | 'resign' }
);
export interface RevisionReviewerTransaction {
  id: string; revisionId: string; operationId: string | null; reviewerVersion: number;
  action: RevisionReviewerAction | 'source_updated' | 'request_review' | 'review_error' | 'author_changed' | 'evidence_accepted';
  reviewerId: string | null; before: RevisionReviewerMember[]; after: RevisionReviewerMember[];
  beforeAcceptance: RevisionReviewerAcceptance | null; acceptance: RevisionReviewerAcceptance | null;
  head: RevisionAuthorHead; fromStatus: RevisionStatus; toStatus: RevisionStatus; lifecycleVersion: number;
  message: string; attribution: ActorAttribution | null; createdAt: string;
}
export interface RevisionReviewerReceipt { revisionId: string; operationId: string; inputSha256: string; transaction: RevisionReviewerTransaction; accessEpoch: number }
export interface RevisionReviewerHistory { revisionId: string; reviewerVersion: number; transactions: RevisionReviewerTransaction[]; nextBefore: number | null; accessEpoch: number }

const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const keys = (value: Record<string, unknown>, expected: string[]) => Object.keys(value).length === expected.length && Object.keys(value).every(key => expected.includes(key));
const integer = (value: unknown, minimum = 0): value is number => Number.isSafeInteger(value) && Number(value) >= minimum;
const text = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= maximum && !value.includes('\0');
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const date = (value: unknown): value is string => text(value, 64) && Number.isFinite(Date.parse(value));
const message = (value: unknown): value is string => typeof value === 'string' && value.length <= REVISION_REVIEWER_LIMITS.message && !value.includes('\0');
const sameHead = (a: RevisionAuthorHead, b: RevisionAuthorHead) => a.versionId === b.versionId && a.number === b.number && a.contentHash === b.contentHash;
export const isRevisionReviewerAction = (value: unknown): value is RevisionReviewerAction => typeof value === 'string' && (REVISION_REVIEWER_ACTIONS as readonly string[]).includes(value);
export const revisionReviewerPermission = (action: RevisionReviewerAction): 'edit' | 'interact' => ['add', 'remove', 'block', 'unblock'].includes(action) ? 'edit' : 'interact';
export const revisionReviewerActionLabel = (action: RevisionReviewerAction): string => ({ add: 'Add Reviewer', remove: 'Remove Reviewer', block: 'Require Review', unblock: 'Make Review Optional', accept: 'Accept Version', request_changes: 'Request Changes', resign: 'Resign Review' })[action];
export function revisionReviewerInput(value: unknown): RevisionReviewerInput {
  const fields = ['action', 'message', 'expectedReviewerVersion', 'expectedLifecycleVersion', 'expectedAuthorVersion', 'expectedVersion', 'expectedVersionId', 'expectedContentHash', 'expectedAccessEpoch', 'expectedConfigId', 'expectedEvidenceSha256'];
  if (!object(value) || !isRevisionReviewerAction(value.action) || !keys(value, [...fields, ...(revisionReviewerPermission(value.action) === 'edit' ? ['reviewerId'] : [])])
    || !message(value.message) || !integer(value.expectedReviewerVersion) || !integer(value.expectedLifecycleVersion) || !integer(value.expectedAuthorVersion)
    || !integer(value.expectedVersion, 1) || !text(value.expectedVersionId, 240) || !hash(value.expectedContentHash) || !integer(value.expectedAccessEpoch) || !hash(value.expectedConfigId) || !hash(value.expectedEvidenceSha256)
    || revisionReviewerPermission(value.action) === 'edit' && !isRevisionAuthorId(value.reviewerId)) throw new Error('Provide an exact reviewer action, source, reviewer, lifecycle, ownership, evidence, configuration and access snapshot.');
  const pins = { message: value.message, expectedReviewerVersion: value.expectedReviewerVersion, expectedLifecycleVersion: value.expectedLifecycleVersion, expectedAuthorVersion: value.expectedAuthorVersion, expectedVersion: value.expectedVersion, expectedVersionId: value.expectedVersionId, expectedContentHash: value.expectedContentHash, expectedAccessEpoch: value.expectedAccessEpoch, expectedConfigId: value.expectedConfigId, expectedEvidenceSha256: value.expectedEvidenceSha256 };
  return revisionReviewerPermission(value.action) === 'edit' ? { action: value.action as 'add' | 'remove' | 'block' | 'unblock', reviewerId: value.reviewerId as string, ...pins } : { action: value.action as 'accept' | 'request_changes' | 'resign', ...pins };
}
export function isRevisionReviewerAttribution(value: unknown): value is ActorAttribution { return object(value) && keys(value, ['principalId', 'displayName', 'credentialId', 'requestId']) && isRevisionAuthor({ principalId: value.principalId, displayName: value.displayName }) && (value.credentialId === null || text(value.credentialId, 240)) && text(value.requestId, 240); }
export function isRevisionReviewerAcceptance(value: unknown): value is RevisionReviewerAcceptance {
  return object(value) && keys(value, ['kind', 'head', 'transactionId']) && (value.kind === 'legacy' ? value.head === null && value.transactionId === null : (value.kind === 'evidence' || value.kind === 'reviewers') && isRevisionAuthorHead(value.head) && text(value.transactionId, 240));
}
export function isRevisionReviewerMember(value: unknown): value is RevisionReviewerMember {
  if (!object(value) || !keys(value, ['principalId', 'displayName', 'status', 'decision']) || !isRevisionAuthor({ principalId: value.principalId, displayName: value.displayName }) || !['added', 'blocking', 'accepted', 'rejected', 'resigned'].includes(String(value.status))) return false;
  if (value.decision === null) return value.status === 'added' || value.status === 'blocking';
  const decision = value.decision;
  if (!object(decision) || !keys(decision, ['head', 'attribution', 'createdAt', 'invalidated']) || !isRevisionAuthorHead(decision.head) || !isRevisionReviewerAttribution(decision.attribution) || decision.attribution.principalId !== value.principalId || !date(decision.createdAt) || !['accepted', 'rejected', 'resigned'].includes(String(value.status))) return false;
  return decision.invalidated === null || object(decision.invalidated) && keys(decision.invalidated, ['reason', 'head', 'attribution', 'createdAt']) && ['source_updated', 'request_review', 'review_error'].includes(String(decision.invalidated.reason)) && isRevisionAuthorHead(decision.invalidated.head) && (decision.invalidated.attribution === null || isRevisionReviewerAttribution(decision.invalidated.attribution)) && date(decision.invalidated.createdAt);
}
function members(value: unknown): value is RevisionReviewerMember[] { return Array.isArray(value) && value.length <= REVISION_REVIEWER_LIMITS.members && value.every((item, index) => isRevisionReviewerMember(item) && (!index || value[index - 1].principalId < item.principalId)); }
export function isRevisionReviewerState(value: unknown, id?: string): value is RevisionReviewerState { return object(value) && keys(value, ['revisionId', 'version', 'members', 'acceptance', 'updatedAt']) && isRevisionId(value.revisionId) && (id === undefined || value.revisionId === id) && integer(value.version) && members(value.members) && (value.acceptance === null || isRevisionReviewerAcceptance(value.acceptance)) && (value.version === 0 ? value.updatedAt === null : date(value.updatedAt)); }
export function revisionReviewerSummary(state: RevisionReviewerState, head: RevisionAuthorHead): RevisionReviewerSummary {
  let accepting = 0, rejecting = 0, olderRejecting = 0, blocking = 0;
  for (const member of state.members) {
    if (member.status === 'blocking') blocking++;
    const decision = member.decision;
    if (member.status === 'accepted' && decision && !decision.invalidated && sameHead(decision.head, head)) accepting++;
    if (member.status === 'rejected' && decision && decision.invalidated?.reason !== 'request_review') { if (!decision.invalidated && sameHead(decision.head, head)) rejecting++; else olderRejecting++; }
  }
  return { version: state.version, accepting, rejecting, olderRejecting, blocking, acceptance: state.acceptance };
}
export function isRevisionReviewerSummary(value: unknown): value is RevisionReviewerSummary { return object(value) && keys(value, ['version', 'accepting', 'rejecting', 'olderRejecting', 'blocking', 'acceptance']) && ['version', 'accepting', 'rejecting', 'olderRejecting', 'blocking'].every(key => integer(value[key])) && (value.acceptance === null || isRevisionReviewerAcceptance(value.acceptance)); }
export function revisionReviewerActions(snapshot: Omit<RevisionReviewerSnapshot, 'actions' | 'access' | 'accessEpoch'> & { access?: ObjectAccess }, principalId: string): RevisionReviewerActionOption[] {
  const self = snapshot.reviewers.members.find(member => member.principalId === principalId), author = snapshot.authorship.author?.principalId === principalId;
  return REVISION_REVIEWER_ACTIONS.map(action => {
    const permission = revisionReviewerPermission(action); let reason: string | null = snapshot.access && (!snapshot.access.capabilities.view || !snapshot.access.capabilities[permission]) ? `${permission === 'edit' ? 'Editing' : 'Interacting'} permission is required.` : null;
    if (permission === 'interact') {
      reason ??= revisionIsClosed(snapshot.lifecycle.status, snapshot.config.closeOnAccept) ? 'Closed or abandoned revisions cannot receive reviewer decisions.' : null;
      if (action !== 'resign') reason ??= snapshot.lifecycle.status === 'draft' || !snapshot.lifecycle.reviewStarted ? 'Request review before recording a decision.' : author && (action === 'request_changes' || !snapshot.config.allowSelfAccept) ? 'The current author cannot make this reviewer decision.' : null;
      if (action === 'resign') reason ??= !self || self.status === 'resigned' ? 'Only a current reviewer can resign.' : null;
      else if (self?.status === (action === 'accept' ? 'accepted' : 'rejected') && self.decision && !self.decision.invalidated && sameHead(self.decision.head, snapshot.head)) reason ??= 'This exact decision is already recorded.';
    }
    return { action, label: revisionReviewerActionLabel(action), available: reason === null, reason };
  });
}
export function isRevisionReviewerTransaction(value: unknown, id?: string): value is RevisionReviewerTransaction {
  if (!object(value) || !keys(value, ['id', 'revisionId', 'operationId', 'reviewerVersion', 'action', 'reviewerId', 'before', 'after', 'beforeAcceptance', 'acceptance', 'head', 'fromStatus', 'toStatus', 'lifecycleVersion', 'message', 'attribution', 'createdAt']) || !text(value.id, 240) || !isRevisionId(value.revisionId) || id !== undefined && value.revisionId !== id || !integer(value.reviewerVersion, 1) || !integer(value.lifecycleVersion)
    || !isRevisionAuthorHead(value.head) || !members(value.before) || !members(value.after) || !(value.beforeAcceptance === null || isRevisionReviewerAcceptance(value.beforeAcceptance)) || !(value.acceptance === null || isRevisionReviewerAcceptance(value.acceptance)) || !isRevisionStatus(value.fromStatus) || !isRevisionStatus(value.toStatus) || !message(value.message) || !date(value.createdAt)) return false;
  if (isRevisionReviewerAction(value.action)) return text(value.operationId, 240) && isRevisionAuthorId(value.reviewerId) && isRevisionReviewerAttribution(value.attribution) && (revisionReviewerPermission(value.action) === 'edit' || value.reviewerId === value.attribution.principalId);
  return ['source_updated', 'request_review', 'review_error', 'author_changed', 'evidence_accepted'].includes(String(value.action)) && value.operationId === null && value.reviewerId === null && (value.attribution === null || isRevisionReviewerAttribution(value.attribution));
}
export function validRevisionReviewerResult(value: unknown, id: string, input: RevisionReviewerInput, principalId?: string): value is RevisionReviewerReceipt {
  if (!object(value) || !keys(value, ['revisionId', 'operationId', 'inputSha256', 'transaction', 'accessEpoch']) || value.revisionId !== id || !text(value.operationId, 240) || !hash(value.inputSha256) || !integer(value.accessEpoch) || !isRevisionReviewerTransaction(value.transaction, id)) return false;
  const transaction = value.transaction;
  return transaction.operationId === value.operationId && transaction.reviewerVersion === input.expectedReviewerVersion + 1 && (transaction.lifecycleVersion === input.expectedLifecycleVersion || transaction.lifecycleVersion === input.expectedLifecycleVersion + 1) && transaction.action === input.action && transaction.message === input.message && transaction.head.number === input.expectedVersion && transaction.head.versionId === input.expectedVersionId && transaction.head.contentHash === input.expectedContentHash && transaction.attribution !== null && (principalId === undefined || transaction.attribution.principalId === principalId) && transaction.reviewerId === ('reviewerId' in input ? input.reviewerId : transaction.attribution.principalId);
}
export function isRevisionReviewerHistory(value: unknown, id: string): value is RevisionReviewerHistory {
  if (!object(value) || !keys(value, ['revisionId', 'reviewerVersion', 'transactions', 'nextBefore', 'accessEpoch']) || value.revisionId !== id || !integer(value.reviewerVersion) || !integer(value.accessEpoch) || !Array.isArray(value.transactions) || value.transactions.length > REVISION_REVIEWER_LIMITS.page || !(value.nextBefore === null || integer(value.nextBefore, 1))) return false;
  let previous = value.reviewerVersion + 1; const ids = new Set<string>(), operations = new Set<string>();
  for (const transaction of value.transactions) { if (!isRevisionReviewerTransaction(transaction, id) || transaction.reviewerVersion >= previous || ids.has(transaction.id) || transaction.operationId !== null && operations.has(transaction.operationId)) return false; previous = transaction.reviewerVersion; ids.add(transaction.id); if (transaction.operationId !== null) operations.add(transaction.operationId); }
  return value.nextBefore === null || value.transactions.length > 0 && value.nextBefore === value.transactions.at(-1)!.reviewerVersion;
}
export function isRevisionReviewerSnapshot(value: unknown, id: string): value is RevisionReviewerSnapshot {
  if (!object(value) || !keys(value, ['reviewers', 'head', 'lifecycle', 'authorship', 'evidence', 'config', 'configId', 'actions', 'access', 'accessEpoch']) || !isRevisionReviewerState(value.reviewers, id) || !isRevisionAuthorHead(value.head) || !isRevisionLifecycle(value.lifecycle, id)
    || !object(value.authorship) || !keys(value.authorship, ['version', 'author']) || !integer(value.authorship.version) || !(value.authorship.author === null || isRevisionAuthor(value.authorship.author)) || !isRevisionLifecycleEvidence(value.evidence)
    || !object(value.config) || !keys(value.config, ['allowReopen', 'alwaysAllowClose', 'alwaysAllowAbandon', 'closeOnAccept', 'allowSelfAccept']) || Object.values(value.config).some(item => typeof item !== 'boolean') || !hash(value.configId) || !integer(value.accessEpoch)
    || !object(value.access) || !object(value.access.policy) || value.access.policy.objectId !== id || !object(value.access.capabilities) || !['view', 'edit', 'interact', 'managePolicy'].every(key => typeof (value.access as ObjectAccess).capabilities[key as keyof ObjectAccess['capabilities']] === 'boolean') || !Array.isArray(value.actions) || value.actions.length !== REVISION_REVIEWER_ACTIONS.length) return false;
  return value.actions.every((action, index) => object(action) && keys(action, ['action', 'label', 'available', 'reason']) && action.action === REVISION_REVIEWER_ACTIONS[index] && action.label === revisionReviewerActionLabel(REVISION_REVIEWER_ACTIONS[index]!) && typeof action.available === 'boolean' && (action.available ? action.reason === null : text(action.reason, 1000)));
}
