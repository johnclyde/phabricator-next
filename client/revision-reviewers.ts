import { revisionRefreshDirection, type RevisionCounters } from './revision-lifecycle';
import { isRevisionReviewerSnapshot, isRevisionReviewerTransaction, revisionReviewerInput, validRevisionReviewerResult, type RevisionReviewerAction, type RevisionReviewerHistory, type RevisionReviewerInput, type RevisionReviewerReceipt, type RevisionReviewerSnapshot } from '../shared/revision-reviewers';

export const REVIEWER_HISTORY_LIMIT = 500;
export interface ReviewerReading { snapshot: RevisionReviewerSnapshot; history: RevisionReviewerHistory }
export interface ReviewerIntent { id: string; revisionId: string; body: RevisionReviewerInput; draft: RevisionReviewerInput }
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const integer = (value: unknown, minimum = 0): value is number => Number.isSafeInteger(value) && Number(value) >= minimum;
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
export function reviewerSnapshot(value: unknown, id: string): value is RevisionReviewerSnapshot {
  return isRevisionReviewerSnapshot(value, id) && value.access.capabilities.view && typeof value.access.policy.spaceId === 'string' && integer(value.access.policy.version, 1);
}
export function reviewerHistory(value: unknown, id: string): value is RevisionReviewerHistory {
  if (!record(value) || Object.keys(value).length !== 5 || value.revisionId !== id || !integer(value.reviewerVersion) || !integer(value.accessEpoch) || !Array.isArray(value.transactions) || value.transactions.length > REVIEWER_HISTORY_LIMIT || !(value.nextBefore === null || integer(value.nextBefore, 1))) return false;
  let previous = value.reviewerVersion + 1;
  const ids = new Set<string>(), operations = new Set<string>();
  for (const item of value.transactions) {
    if (!isRevisionReviewerTransaction(item, id) || item.reviewerVersion >= previous || ids.has(item.id) || item.operationId !== null && operations.has(item.operationId)) return false;
    previous = item.reviewerVersion; ids.add(item.id); if (item.operationId !== null) operations.add(item.operationId);
  }
  return value.nextBefore === null || value.nextBefore === value.transactions.at(-1)?.reviewerVersion;
}
export function reviewerReading(value: unknown, id: string): ReviewerReading | null {
  return record(value) && Object.keys(value).length === 2 && reviewerSnapshot(value.snapshot, id) && reviewerHistory(value.history, id) && value.snapshot.reviewers.version === value.history.reviewerVersion && value.snapshot.accessEpoch === value.history.accessEpoch ? { snapshot: value.snapshot, history: value.history } : null;
}
export function mergeReviewerHistory(previous: RevisionReviewerHistory, next: RevisionReviewerHistory): RevisionReviewerHistory {
  if (!reviewerHistory(previous, previous.revisionId) || !reviewerHistory(next, previous.revisionId) || previous.nextBefore === null || previous.reviewerVersion !== next.reviewerVersion || previous.accessEpoch !== next.accessEpoch || next.transactions.some(item => item.reviewerVersion >= previous.nextBefore! || previous.transactions.some(old => old.id === item.id || item.operationId !== null && old.operationId === item.operationId)) || previous.transactions.length + next.transactions.length > REVIEWER_HISTORY_LIMIT) throw new Error('Reviewer history changed. Reload Reviewers before continuing.');
  return { ...next, transactions: [...previous.transactions, ...next.transactions] };
}
export function reviewerDraft(value: unknown): RevisionReviewerInput | null { try { return revisionReviewerInput(value); } catch { return null; } }
export function reviewerIntent(value: unknown, revisionId: string): ReviewerIntent | null {
  if (!record(value) || value.revisionId !== revisionId || !uuid(value.id) || Object.keys(value).length !== 4) return null;
  const body = reviewerDraft(value.body), draft = reviewerDraft(value.draft);
  return body && draft && JSON.stringify(body) === JSON.stringify(draft) ? { id: value.id, revisionId, body, draft: value.draft as RevisionReviewerInput } : null;
}
export function reviewerAuthority(value: unknown): 'edit' | 'interact' | null {
  const input = reviewerDraft(record(value) && 'body' in value ? value.body : value);
  return input ? (['add', 'remove', 'block', 'unblock'].includes(input.action) ? 'edit' : 'interact') : null;
}
export function prepareReviewerDraft(snapshot: RevisionReviewerSnapshot, action: RevisionReviewerAction, reviewerId?: string): RevisionReviewerInput {
  return revisionReviewerInput({ action, ...(['add', 'remove', 'block', 'unblock'].includes(action) ? { reviewerId } : {}), message: '', expectedReviewerVersion: snapshot.reviewers.version, expectedLifecycleVersion: snapshot.lifecycle.version, expectedAuthorVersion: snapshot.authorship.version, expectedVersion: snapshot.head.number, expectedVersionId: snapshot.head.versionId, expectedContentHash: snapshot.head.contentHash, expectedAccessEpoch: snapshot.accessEpoch, expectedConfigId: snapshot.configId, expectedEvidenceSha256: snapshot.evidence.sha256 });
}
export function reviewerDraftMatches(draft: RevisionReviewerInput, snapshot: RevisionReviewerSnapshot): boolean {
  const fresh = prepareReviewerDraft(snapshot, draft.action, 'reviewerId' in draft ? draft.reviewerId : undefined);
  return JSON.stringify({ ...draft, message: '' }) === JSON.stringify(fresh);
}
export function reviewerStatusLabel(status: string): string { return ({ added: 'Awaiting Review', blocking: 'Blocking Review', accepted: 'Accepted', rejected: 'Changes Requested', resigned: 'Resigned' } as Record<string, string>)[status] ?? status; }
export async function verifiedReviewerResult(value: unknown, id: string, input: RevisionReviewerInput, principalId: string): Promise<RevisionReviewerReceipt> {
  if (!validRevisionReviewerResult(value, id, input, principalId)) throw new Error('The reviewer receipt does not match this exact request. Keep the request and retry it explicitly.');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(revisionReviewerInput(input))))), byte => byte.toString(16).padStart(2, '0')).join('');
  if (value.inputSha256 !== hash) throw new Error('The reviewer receipt belongs to a different request. Keep this request for exact recovery.');
  return value;
}

/** A saved response may be older than metadata or review evidence already learned in this tab. */
export function reviewerReadingCurrent(reading: ReviewerReading, known: RevisionCounters | undefined, headVersionId: string, evidenceKey: string): boolean {
  const snapshot = reading.snapshot;
  return revisionRefreshDirection(known, { currentVersion: snapshot.head.number, authorVersion: snapshot.authorship.version, lifecycleVersion: snapshot.lifecycle.version, reviewerVersion: snapshot.reviewers.version, status: snapshot.lifecycle.status }) !== 'revision'
    && (snapshot.head.versionId !== headVersionId || JSON.stringify([...snapshot.evidence.reviewIds].sort()) === evidenceKey);
}
