import { isRevisionAuthorHead, isRevisionAuthorId, type RevisionAuthorHead } from './revision-authorship';
import { isRevisionId } from './revision-dependencies';
import type { RevisionReviewerStatus } from './revision-reviewers';
import { isRevisionStatus, revisionIsClosed, type RevisionStatus } from './revision-status';
import type { AppState, Revision, RevisionKind } from './types';

export const REVISION_ACTIVE_BUCKETS = [
  { key: 'must-review', label: 'Must Review' },
  { key: 'ready-to-review', label: 'Ready to Review' },
  { key: 'ready-to-land', label: 'Ready to Land' },
  { key: 'ready-to-update', label: 'Ready to Update' },
  { key: 'drafts', label: 'Drafts' },
  { key: 'waiting-on-review', label: 'Waiting on Review' },
  { key: 'waiting-on-authors', label: 'Waiting on Authors' },
  { key: 'waiting-on-other-reviewers', label: 'Waiting on Other Reviewers' },
] as const;
export type RevisionActiveBucketKey = typeof REVISION_ACTIVE_BUCKETS[number]['key'];
export interface RevisionActiveItem {
  revisionId: string; head: RevisionAuthorHead; status: RevisionStatus;
  authorVersion: number; lifecycleVersion: number; reviewerVersion: number;
  isAuthor: boolean; reviewerStatus: RevisionReviewerStatus | null; decisionCurrent: boolean | null;
}
export interface RevisionActiveSnapshot {
  format: 'revision-active.v1'; principalId: string; accessEpoch: number; closeOnAccept: boolean; items: RevisionActiveItem[];
}
export interface RevisionActiveGroup { key: RevisionActiveBucketKey; label: string; revisions: Revision[] }
export type RevisionActiveResult = { available: true; groups: RevisionActiveGroup[] } | { available: false; reason: string };
type ActiveState = Pick<AppState, 'revisions' | 'currentPrincipalId' | 'accessEpoch'>;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const keys = (value: Record<string, unknown>, expected: string[]) => Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

export function isRevisionActiveItem(value: unknown): value is RevisionActiveItem {
  if (!object(value) || !keys(value, ['revisionId', 'head', 'status', 'authorVersion', 'lifecycleVersion', 'reviewerVersion', 'isAuthor', 'reviewerStatus', 'decisionCurrent'])
    || !isRevisionId(value.revisionId) || !isRevisionAuthorHead(value.head) || !isRevisionStatus(value.status)
    || !integer(value.authorVersion) || !integer(value.lifecycleVersion) || !integer(value.reviewerVersion) || typeof value.isAuthor !== 'boolean'
    || !(value.reviewerStatus === null || typeof value.reviewerStatus === 'string' && ['added', 'blocking', 'accepted', 'rejected', 'resigned'].includes(value.reviewerStatus))) return false;
  return value.reviewerStatus === null || value.reviewerStatus === 'added' || value.reviewerStatus === 'blocking'
    ? value.decisionCurrent === null : typeof value.decisionCurrent === 'boolean';
}

/** A complete, current, viewer-bound projection is required; partial/legacy data is unavailable. */
export function validateRevisionActiveSnapshot(value: unknown, state: ActiveState): value is RevisionActiveSnapshot {
  if (!object(state) || !object(value) || !keys(value, ['format', 'principalId', 'accessEpoch', 'closeOnAccept', 'items']) || value.format !== 'revision-active.v1'
    || !isRevisionAuthorId(value.principalId) || value.principalId !== state.currentPrincipalId || !integer(value.accessEpoch) || value.accessEpoch !== state.accessEpoch
    || typeof value.closeOnAccept !== 'boolean' || !Array.isArray(value.items) || !Array.isArray(state.revisions) || value.items.length !== state.revisions.length) return false;
  // Runtime snapshots come from storage or transport. Validate the rows before
  // building a map or sorting; malformed input must not yield partial groups.
  for (const revision of state.revisions) {
    if (!object(revision) || !isRevisionId(revision.id) || !['code', 'paper', 'document'].includes(String(revision.kind))
      || revision.id[0] !== ({ code: 'D', paper: 'P', document: 'L' } as const)[revision.kind as RevisionKind]
      || typeof revision.title !== 'string' || typeof revision.summary !== 'string' || typeof revision.updatedAt !== 'string' || !Number.isFinite(Date.parse(revision.updatedAt))
      || !integer(revision.currentVersion) || revision.currentVersion < 1 || !isRevisionStatus(revision.status)
      || !integer(revision.authorVersion) || !integer(revision.lifecycleVersion) || !integer(revision.reviewerVersion)
      || !(revision.authorId === null || isRevisionAuthorId(revision.authorId))) return false;
  }
  const revisions = new Map(state.revisions.map(revision => [revision.id, revision]));
  if (revisions.size !== state.revisions.length) return false;
  const seen = new Set<string>();
  for (const item of value.items) {
    if (!isRevisionActiveItem(item) || seen.has(item.revisionId)) return false;
    const revision = revisions.get(item.revisionId);
    if (!revision || !integer(revision.authorVersion) || !integer(revision.lifecycleVersion) || !integer(revision.reviewerVersion)
      || !(revision.authorId === null || isRevisionAuthorId(revision.authorId)) || item.head.number !== revision.currentVersion || item.status !== revision.status
      || item.authorVersion !== revision.authorVersion || item.lifecycleVersion !== revision.lifecycleVersion || item.reviewerVersion !== revision.reviewerVersion
      || item.isAuthor !== (revision.authorId === state.currentPrincipalId)) return false;
    seen.add(item.revisionId);
  }
  return true;
}

/** Direct-user form of the pinned upstream required-action buckets; authors take precedence. */
export function classifyRevisionActive(item: RevisionActiveItem, closeOnAccept: boolean): RevisionActiveBucketKey | null {
  if (revisionIsClosed(item.status, closeOnAccept)) return null;
  if (item.isAuthor) {
    if (item.status === 'accepted') return 'ready-to-land';
    if (item.status === 'changes_requested' || item.status === 'changes_planned') return 'ready-to-update';
    if (item.status === 'draft') return 'drafts';
    return item.status === 'needs_review' ? 'waiting-on-review' : null;
  }
  if (item.reviewerStatus === null || item.reviewerStatus === 'resigned' || item.status === 'draft') return null;
  if (item.status === 'needs_review') {
    // A voided rejection still requires its reviewer to act. This deliberately
    // differs from whether that rejection currently vetoes acceptance.
    if (item.reviewerStatus === 'blocking' || item.reviewerStatus === 'rejected') return 'must-review';
    if (item.reviewerStatus === 'added' || item.reviewerStatus === 'accepted' && item.decisionCurrent === false) return 'ready-to-review';
    return 'waiting-on-other-reviewers';
  }
  return ['accepted', 'changes_requested', 'changes_planned'].includes(item.status) ? 'waiting-on-authors' : null;
}

export function evaluateRevisionActive(state: ActiveState & Pick<AppState, 'revisionActive'>, kind: RevisionKind, query = ''): RevisionActiveResult {
  if (!object(state) || !validateRevisionActiveSnapshot(state.revisionActive, state)) return { available: false, reason: 'Active revisions are unavailable until a complete current workspace snapshot is loaded.' };
  if (!['code', 'paper', 'document'].includes(kind) || typeof query !== 'string' || query.length > 512 || query.includes('\0') || /[\uD800-\uDFFF]/u.test(query)) return { available: false, reason: 'Use a supported revision kind and literal search of at most 512 characters.' };
  const groups: RevisionActiveGroup[] = REVISION_ACTIVE_BUCKETS.map(bucket => ({ ...bucket, revisions: [] }));
  const rows = new Map(state.revisions.map(revision => [revision.id, revision])), search = query.toLowerCase();
  for (const item of state.revisionActive.items) {
    const revision = rows.get(item.revisionId)!;
    if (revision.kind !== kind || !`${revision.id} ${revision.title} ${revision.summary}`.toLowerCase().includes(search)) continue;
    const key = classifyRevisionActive(item, state.revisionActive.closeOnAccept);
    if (key) groups.find(group => group.key === key)!.revisions.push(revision);
  }
  for (const group of groups) group.revisions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || Number(b.id.slice(1)) - Number(a.id.slice(1)));
  return { available: true, groups };
}
