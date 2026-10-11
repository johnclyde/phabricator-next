import type { ActorAttribution } from './types';
import type { ObjectAccess } from './policy';
import { isRevisionStatus, revisionIsClosed, type RevisionStatus } from './revision-status';
import { isRevisionId } from './revision-dependencies';
import { isRevisionAuthor, isRevisionAuthorHead, type RevisionAuthor, type RevisionAuthorHead } from './revision-authorship';

export const REVISION_LIFECYCLE_ACTIONS = ['request_review', 'plan_changes', 'abandon', 'reclaim', 'close', 'reopen', 'accept_reviewed'] as const;
export type RevisionLifecycleAction = typeof REVISION_LIFECYCLE_ACTIONS[number];
export interface RevisionLifecycleConfig { allowReopen: boolean; alwaysAllowClose: boolean; alwaysAllowAbandon: boolean; closeOnAccept: boolean }
export const DEFAULT_REVISION_LIFECYCLE_CONFIG: Readonly<RevisionLifecycleConfig> = Object.freeze({ allowReopen: false, alwaysAllowClose: false, alwaysAllowAbandon: false, closeOnAccept: false });
export const REVISION_LIFECYCLE_LIMITS = { message: 10_000, page: 100, reviews: 1_000 } as const;
export interface RevisionLifecycle {
  revisionId: string; version: number; status: RevisionStatus; reviewStarted: boolean;
  closedFromAccepted: boolean | null; resumeAcceptanceHead: RevisionAuthorHead | null; updatedAt: string | null;
}
export interface RevisionLifecycleEvidence { sha256: string; reviewIds: string[]; errorCount: number }
export interface RevisionLifecycleActionOption { action: RevisionLifecycleAction; label: string; available: boolean; reason: string | null; targetStatus: RevisionStatus | null }
export interface RevisionLifecycleSnapshot {
  lifecycle: RevisionLifecycle; head: RevisionAuthorHead; authorship: { version: number; author: RevisionAuthor | null };
  evidence: RevisionLifecycleEvidence; config: RevisionLifecycleConfig; configId: string; access: ObjectAccess; accessEpoch: number;
  actions: RevisionLifecycleActionOption[];
}
export interface RevisionLifecycleInput {
  action: RevisionLifecycleAction; message: string; expectedLifecycleVersion: number; expectedAuthorVersion: number;
  expectedVersion: number; expectedVersionId: string; expectedContentHash: string; expectedAccessEpoch: number;
  expectedConfigId: string; expectedEvidenceSha256: string;
}
export interface RevisionLifecycleTransaction {
  id: string; revisionId: string; operationId: string | null; lifecycleVersion: number;
  action: RevisionLifecycleAction | 'source_updated' | 'review_invalidated'; fromStatus: RevisionStatus; toStatus: RevisionStatus;
  beforeHead: RevisionAuthorHead; head: RevisionAuthorHead; message: string; attribution: ActorAttribution | null;
  createdAt: string; evidenceSha256: string; reviewIds: string[];
}
export interface RevisionLifecycleReceipt { revisionId: string; operationId: string; inputSha256: string; transaction: RevisionLifecycleTransaction; accessEpoch: number }
export interface RevisionLifecycleHistory { revisionId: string; lifecycleVersion: number; transactions: RevisionLifecycleTransaction[]; nextBefore: number | null; accessEpoch: number }
export const revisionLifecycleActionLabel = (action: RevisionLifecycleAction): string => ({ request_review: 'Request Review', plan_changes: 'Plan Changes', abandon: 'Abandon Revision', reclaim: 'Reclaim Revision', close: 'Close Revision', reopen: 'Reopen Revision', accept_reviewed: 'Accept Reviewed Version' })[action];

/** Native lifecycle eligibility. Evidence acceptance is explicitly distinct from upstream reviewer votes. */
export function revisionLifecycleActions(snapshot: Omit<RevisionLifecycleSnapshot, 'actions' | 'access' | 'accessEpoch'> & { access?: ObjectAccess }, principalId: string): RevisionLifecycleActionOption[] {
  const { lifecycle: state, head, authorship, evidence, config, access } = snapshot;
  const owner = authorship.author?.principalId === principalId, terminal = revisionIsClosed(state.status, config.closeOnAccept);
  const canRestore = state.status === 'changes_planned' && state.resumeAcceptanceHead !== null && sameHead(state.resumeAcceptanceHead, head) && evidence.reviewIds.length > 0 && evidence.errorCount === 0;
  return REVISION_LIFECYCLE_ACTIONS.map(action => {
    let reason: string | null = access && (!access.capabilities.edit || !access.capabilities.view) ? 'Editing this revision is required.' : null;
    let targetStatus: RevisionStatus;
    switch (action) {
      case 'request_review': targetStatus = canRestore ? 'accepted' : 'needs_review'; reason ??= terminal ? 'Reclaim or reopen this revision first.' : state.status === 'needs_review' ? 'Review has already been requested.' : !owner && state.status !== 'draft' ? 'Only the current author can request review.' : null; break;
      case 'plan_changes': targetStatus = 'changes_planned'; reason ??= !owner ? 'Only the current author can plan changes.' : terminal || state.status === 'draft' ? 'Request review before planning changes.' : state.status === 'changes_planned' ? 'Changes are already planned.' : null; break;
      case 'abandon': targetStatus = 'abandoned'; reason ??= terminal ? 'This revision is already closed or abandoned.' : !owner && !config.alwaysAllowAbandon ? 'Only the current author can abandon this revision.' : null; break;
      case 'reclaim': targetStatus = state.reviewStarted ? 'needs_review' : 'draft'; reason ??= !owner ? 'Only the current author can reclaim this revision.' : state.status !== 'abandoned' ? 'Only abandoned revisions can be reclaimed.' : null; break;
      case 'close': targetStatus = 'closed'; reason ??= terminal ? 'This revision is already closed.' : state.status !== 'accepted' ? 'Accept the reviewed version before closing this revision.' : !owner && !config.alwaysAllowClose ? 'Only the current author can close this revision.' : null; break;
      case 'reopen': targetStatus = 'needs_review'; reason ??= !config.allowReopen ? 'Reopening is disabled by the operator.' : state.status !== 'closed' ? 'Only closed revisions can be reopened.' : null; break;
      case 'accept_reviewed': targetStatus = 'accepted'; reason ??= !['needs_review', 'changes_requested'].includes(state.status) ? 'Request review before accepting this version.' : evidence.reviewIds.length === 0 ? 'Run checks or an explicit AI review on this exact version first.' : evidence.errorCount > 0 ? 'Resolve the errors reported for this version first.' : null; break;
    }
    return { action, label: revisionLifecycleActionLabel(action), available: reason === null, reason, targetStatus: reason === null ? targetStatus : null };
  });
}
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const keys = (value: Record<string, unknown>, expected: string[]) => Object.keys(value).length === expected.length && Object.keys(value).every(key => expected.includes(key));
const integer = (value: unknown, min = 0): value is number => Number.isSafeInteger(value) && Number(value) >= min;
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const date = (value: unknown): value is string => text(value, 64) && Number.isFinite(Date.parse(value));
const message = (value: unknown): value is string => typeof value === 'string' && value.length <= REVISION_LIFECYCLE_LIMITS.message && !value.includes('\0');
const reviewIds = (value: unknown): value is string[] => Array.isArray(value) && value.length <= REVISION_LIFECYCLE_LIMITS.reviews && value.every(id => text(id, 240)) && new Set(value).size === value.length;
export const isRevisionLifecycleAction = (value: unknown): value is RevisionLifecycleAction => typeof value === 'string' && (REVISION_LIFECYCLE_ACTIONS as readonly string[]).includes(value);
export function sameHead(a: RevisionAuthorHead, b: RevisionAuthorHead): boolean { return a.versionId === b.versionId && a.number === b.number && a.contentHash === b.contentHash; }
export function isRevisionLifecycleConfig(value: unknown): value is RevisionLifecycleConfig { return object(value) && keys(value, ['allowReopen', 'alwaysAllowClose', 'alwaysAllowAbandon', 'closeOnAccept']) && Object.values(value).every(v => typeof v === 'boolean'); }
export function revisionLifecycleInput(value: unknown): RevisionLifecycleInput {
  if (!object(value) || !keys(value, ['action', 'message', 'expectedLifecycleVersion', 'expectedAuthorVersion', 'expectedVersion', 'expectedVersionId', 'expectedContentHash', 'expectedAccessEpoch', 'expectedConfigId', 'expectedEvidenceSha256'])
    || !isRevisionLifecycleAction(value.action) || !message(value.message) || !integer(value.expectedLifecycleVersion) || !integer(value.expectedAuthorVersion)
    || !integer(value.expectedVersion, 1) || !text(value.expectedVersionId, 240) || !hash(value.expectedContentHash) || !integer(value.expectedAccessEpoch) || !hash(value.expectedConfigId) || !hash(value.expectedEvidenceSha256)) throw new Error('Provide an exact lifecycle action, source, author, lifecycle, evidence, configuration and access snapshot.');
  return { action: value.action, message: value.message, expectedLifecycleVersion: value.expectedLifecycleVersion, expectedAuthorVersion: value.expectedAuthorVersion, expectedVersion: value.expectedVersion, expectedVersionId: value.expectedVersionId, expectedContentHash: value.expectedContentHash, expectedAccessEpoch: value.expectedAccessEpoch, expectedConfigId: value.expectedConfigId, expectedEvidenceSha256: value.expectedEvidenceSha256 };
}
export function isRevisionLifecycle(value: unknown, id?: string): value is RevisionLifecycle {
  return object(value) && keys(value, ['revisionId', 'version', 'status', 'reviewStarted', 'closedFromAccepted', 'resumeAcceptanceHead', 'updatedAt'])
    && isRevisionId(value.revisionId) && (id === undefined || id === value.revisionId) && integer(value.version) && isRevisionStatus(value.status) && typeof value.reviewStarted === 'boolean'
    && (value.closedFromAccepted === null || typeof value.closedFromAccepted === 'boolean') && (value.resumeAcceptanceHead === null || value.status === 'changes_planned' && isRevisionAuthorHead(value.resumeAcceptanceHead))
    && (value.version === 0 ? value.updatedAt === null : date(value.updatedAt));
}
export function isRevisionLifecycleEvidence(value: unknown): value is RevisionLifecycleEvidence { return object(value) && keys(value, ['sha256', 'reviewIds', 'errorCount']) && hash(value.sha256) && reviewIds(value.reviewIds) && integer(value.errorCount) && (value.reviewIds.length > 0 || value.errorCount === 0); }
export function isRevisionLifecycleSnapshot(value: unknown, id: string): value is RevisionLifecycleSnapshot {
  if (!object(value) || !keys(value, ['lifecycle', 'head', 'authorship', 'evidence', 'config', 'configId', 'access', 'accessEpoch', 'actions'])
    || !isRevisionLifecycle(value.lifecycle, id) || !isRevisionAuthorHead(value.head) || !object(value.authorship) || !keys(value.authorship, ['version', 'author']) || !integer(value.authorship.version) || value.authorship.author !== null && !isRevisionAuthor(value.authorship.author)
    || !isRevisionLifecycleEvidence(value.evidence) || !isRevisionLifecycleConfig(value.config) || !hash(value.configId) || !integer(value.accessEpoch)
    || !object(value.access) || !object(value.access.policy) || value.access.policy.objectId !== id || !object(value.access.capabilities) || !['view', 'edit', 'interact', 'managePolicy'].every(key => typeof ((value.access as Record<string, unknown>).capabilities as Record<string, unknown>)[key] === 'boolean')
    || !Array.isArray(value.actions) || value.actions.length !== REVISION_LIFECYCLE_ACTIONS.length) return false;
  return value.actions.every((option, index) => object(option) && keys(option, ['action', 'label', 'available', 'reason', 'targetStatus']) && option.action === REVISION_LIFECYCLE_ACTIONS[index]
    && option.label === revisionLifecycleActionLabel(REVISION_LIFECYCLE_ACTIONS[index]!) && typeof option.available === 'boolean' && (option.available ? option.reason === null && isRevisionStatus(option.targetStatus) : text(option.reason, 1_000) && option.targetStatus === null));
}
function actor(value: unknown): value is ActorAttribution { return object(value) && keys(value, ['principalId', 'displayName', 'credentialId', 'requestId']) && isRevisionAuthor({ principalId: value.principalId, displayName: value.displayName }) && (value.credentialId === null || text(value.credentialId, 240)) && text(value.requestId, 240); }
export function isRevisionLifecycleTransaction(value: unknown, id?: string): value is RevisionLifecycleTransaction {
  if (!object(value) || !keys(value, ['id', 'revisionId', 'operationId', 'lifecycleVersion', 'action', 'fromStatus', 'toStatus', 'beforeHead', 'head', 'message', 'attribution', 'createdAt', 'evidenceSha256', 'reviewIds'])
    || !text(value.id, 240) || !isRevisionId(value.revisionId) || id !== undefined && value.revisionId !== id || !integer(value.lifecycleVersion, 1)
    || !isRevisionStatus(value.fromStatus) || !isRevisionStatus(value.toStatus) || !isRevisionAuthorHead(value.beforeHead) || !isRevisionAuthorHead(value.head)
    || !message(value.message) || !date(value.createdAt) || !hash(value.evidenceSha256) || !reviewIds(value.reviewIds)) return false;
  if (value.action === 'source_updated') return value.operationId === null && (value.attribution === null || actor(value.attribution)) && value.head.number === value.beforeHead.number + 1 && value.head.versionId !== value.beforeHead.versionId;
  if (value.action === 'review_invalidated') return value.operationId === null && (value.attribution === null || actor(value.attribution)) && sameHead(value.head, value.beforeHead) && (value.fromStatus === 'accepted' && value.toStatus === 'changes_requested' || value.fromStatus === 'changes_planned' && value.toStatus === 'changes_planned');
  if (!isRevisionLifecycleAction(value.action) || !text(value.operationId, 240) || !actor(value.attribution) || !sameHead(value.head, value.beforeHead) || value.fromStatus === value.toStatus) return false;
  const targets: Record<RevisionLifecycleAction, RevisionStatus[]> = { request_review: ['needs_review', 'accepted'], plan_changes: ['changes_planned'], abandon: ['abandoned'], reclaim: ['needs_review', 'draft'], close: ['closed'], reopen: ['needs_review'], accept_reviewed: ['accepted'] };
  return targets[value.action].includes(value.toStatus) && (value.action !== 'accept_reviewed' || value.reviewIds.length > 0);
}
export function validRevisionLifecycleResult(value: unknown, id: string, input: RevisionLifecycleInput, principalId?: string): value is RevisionLifecycleReceipt {
  if (!object(value) || !keys(value, ['revisionId', 'operationId', 'inputSha256', 'transaction', 'accessEpoch']) || value.revisionId !== id || !text(value.operationId, 240) || !hash(value.inputSha256) || !integer(value.accessEpoch) || !isRevisionLifecycleTransaction(value.transaction, id)) return false;
  const t = value.transaction;
  return t.operationId === value.operationId && t.lifecycleVersion === input.expectedLifecycleVersion + 1 && t.action === input.action && t.message === input.message
    && t.head.versionId === input.expectedVersionId && t.head.number === input.expectedVersion && t.head.contentHash === input.expectedContentHash && t.evidenceSha256 === input.expectedEvidenceSha256
    && t.attribution !== null && (principalId === undefined || t.attribution.principalId === principalId);
}
export function isRevisionLifecycleHistory(value: unknown, id: string): value is RevisionLifecycleHistory {
  if (!object(value) || !keys(value, ['revisionId', 'lifecycleVersion', 'transactions', 'nextBefore', 'accessEpoch']) || value.revisionId !== id || !integer(value.lifecycleVersion) || !integer(value.accessEpoch) || !Array.isArray(value.transactions) || value.transactions.length > REVISION_LIFECYCLE_LIMITS.page || !(value.nextBefore === null || integer(value.nextBefore, 1))) return false;
  let previous = value.lifecycleVersion + 1;
  const ids = new Set<string>(), operations = new Set<string>();
  for (const t of value.transactions) { if (!isRevisionLifecycleTransaction(t, id) || t.lifecycleVersion >= previous || ids.has(t.id) || t.operationId !== null && operations.has(t.operationId)) return false; previous = t.lifecycleVersion; ids.add(t.id); if (t.operationId !== null) operations.add(t.operationId); }
  return value.nextBefore === null || value.transactions.length > 0 && value.nextBefore === value.transactions.at(-1)!.lifecycleVersion;
}

export type RevisionLifecycleState = RevisionLifecycle;
export const isRevisionLifecycleState = isRevisionLifecycle;
