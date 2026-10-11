import { isRevisionMuteHistory, isRevisionMuteTransaction, isRevisionSubscriptionHistory, isRevisionSubscriptionSnapshot, isRevisionSubscriptionStatus, isRevisionSubscriptionTransaction, revisionSubscriptionInput, validRevisionSubscriptionResult, type RevisionMuteHistory, type RevisionSubscriptionAction, type RevisionSubscriptionHistory, type RevisionSubscriptionInput, type RevisionSubscriptionPerson, type RevisionSubscriptionReceipt, type RevisionSubscriptionSnapshot, type RevisionSubscriptionStatus } from '../shared/revision-subscriptions';
import { REVISION_SUBSCRIPTION_LIMITS } from '../shared/revision-subscriptions';
import { REVISION_REVIEWER_LIMITS } from '../shared/revision-reviewers';

export const FOLLOW_HISTORY_LIMIT = 500, FOLLOW_PEOPLE_LIMIT = REVISION_SUBSCRIPTION_LIMITS.people + REVISION_REVIEWER_LIMITS.members + 1;
export interface SubscriptionReading { snapshot: RevisionSubscriptionSnapshot; history: RevisionSubscriptionHistory; muteHistory: RevisionMuteHistory }
export interface SubscriptionDraft { input: RevisionSubscriptionInput; roleDigest: string }
export interface SubscriptionIntent { id: string; revisionId: string; body: RevisionSubscriptionInput; draft: SubscriptionDraft }
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
export function subscriptionSnapshot(value: unknown, id: string, principalId?: string): value is RevisionSubscriptionSnapshot {
  if (!record(value) || !Array.isArray(value.subscribers) || value.subscribers.length > FOLLOW_PEOPLE_LIMIT || !isRevisionSubscriptionSnapshot({ ...value, subscribers: [], nextAfter: null }, id, principalId)) return false;
  const snapshot = value as unknown as RevisionSubscriptionSnapshot;
  if (!snapshot.access.capabilities.view) return false;
  let previous = '';
  for (const person of snapshot.subscribers) { if (!isRevisionSubscriptionStatus(person, id) || !person.following || person.principalId <= previous || person.version > snapshot.subscriptionVersion || person.principalId === snapshot.viewer.principalId && !same(person, snapshot.viewer)) return false; previous = person.principalId; }
  return snapshot.nextAfter === null || snapshot.subscribers.length > 0 && snapshot.nextAfter === previous;
}
export function subscriptionHistory(value: unknown, id: string): value is RevisionSubscriptionHistory {
  if (!record(value) || !Array.isArray(value.transactions) || value.transactions.length > FOLLOW_HISTORY_LIMIT || !isRevisionSubscriptionHistory({ ...value, transactions: [], nextBefore: null }, id)) return false;
  const history = value as unknown as RevisionSubscriptionHistory, ids = new Set<string>(), operations = new Set<string>(); let previous = history.subscriptionVersion + 1;
  for (const item of history.transactions) { if (!isRevisionSubscriptionTransaction(item, id) || item.subscriptionVersion >= previous || ids.has(item.id) || item.operationId !== null && operations.has(item.operationId)) return false; previous = item.subscriptionVersion; ids.add(item.id); if (item.operationId !== null) operations.add(item.operationId); }
  return history.nextBefore === null || history.transactions.length > 0 && history.nextBefore === previous;
}
export function muteHistory(value: unknown, id: string, principalId?: string): value is RevisionMuteHistory {
  if (!record(value) || !Array.isArray(value.transactions) || value.transactions.length > FOLLOW_HISTORY_LIMIT || !isRevisionMuteHistory({ ...value, transactions: [], nextBefore: null }, id, principalId)) return false;
  const history = value as unknown as RevisionMuteHistory, ids = new Set<string>(), operations = new Set<string>(); let previous = history.muteVersion + 1;
  for (const item of history.transactions) { if (!isRevisionMuteTransaction(item, id, history.principalId) || item.version >= previous || ids.has(item.id) || operations.has(item.operationId)) return false; previous = item.version; ids.add(item.id); operations.add(item.operationId); }
  return history.nextBefore === null || history.transactions.length > 0 && history.nextBefore === previous;
}
export function subscriptionReading(value: unknown, id: string, principalId?: string): SubscriptionReading | null {
  return record(value) && Object.keys(value).length === 3 && subscriptionSnapshot(value.snapshot, id, principalId) && subscriptionHistory(value.history, id) && muteHistory(value.muteHistory, id, value.snapshot.viewer.principalId) && value.snapshot.subscriptionVersion === value.history.subscriptionVersion && value.snapshot.mute.version === value.muteHistory.muteVersion && value.snapshot.accessEpoch === value.history.accessEpoch && value.snapshot.accessEpoch === value.muteHistory.accessEpoch ? { snapshot: value.snapshot, history: value.history, muteHistory: value.muteHistory } : null;
}
export function mergeSubscribers(before: RevisionSubscriptionSnapshot, next: RevisionSubscriptionSnapshot): RevisionSubscriptionSnapshot {
  if (!subscriptionSnapshot(before, before.revisionId) || !subscriptionSnapshot(next, before.revisionId, before.viewer.principalId) || before.nextAfter === null || before.subscriptionVersion !== next.subscriptionVersion || before.authorVersion !== next.authorVersion || before.reviewerVersion !== next.reviewerVersion || before.roleDigest !== next.roleDigest || before.accessEpoch !== next.accessEpoch || !same(before.viewer, next.viewer) || !same(before.mute, next.mute) || next.subscribers.some(person => person.principalId <= before.nextAfter!) || before.subscribers.length + next.subscribers.length > FOLLOW_PEOPLE_LIMIT) throw new Error('Following changed. Reload Following before continuing.');
  return { ...next, subscribers: [...before.subscribers, ...next.subscribers] };
}
export function mergeSubscriptionHistory(before: RevisionSubscriptionHistory, next: RevisionSubscriptionHistory): RevisionSubscriptionHistory {
  if (!subscriptionHistory(before, before.revisionId) || !subscriptionHistory(next, before.revisionId) || before.nextBefore === null || before.subscriptionVersion !== next.subscriptionVersion || before.accessEpoch !== next.accessEpoch || next.transactions.some(item => item.subscriptionVersion >= before.nextBefore! || before.transactions.some(old => old.id === item.id || item.operationId !== null && old.operationId === item.operationId)) || before.transactions.length + next.transactions.length > FOLLOW_HISTORY_LIMIT) throw new Error('Following history changed. Reload Following before continuing.');
  return { ...next, transactions: [...before.transactions, ...next.transactions] };
}
export function mergeMuteHistory(before: RevisionMuteHistory, next: RevisionMuteHistory): RevisionMuteHistory {
  if (!muteHistory(before, before.revisionId) || !muteHistory(next, before.revisionId, before.principalId) || before.nextBefore === null || before.muteVersion !== next.muteVersion || before.accessEpoch !== next.accessEpoch || next.transactions.some(item => item.version >= before.nextBefore! || before.transactions.some(old => old.id === item.id || old.operationId === item.operationId)) || before.transactions.length + next.transactions.length > FOLLOW_HISTORY_LIMIT) throw new Error('Your mute history changed. Reload Following before continuing.');
  return { ...next, transactions: [...before.transactions, ...next.transactions] };
}
export function subscriptionDraft(value: unknown): SubscriptionDraft | null { if (!record(value) || Object.keys(value).length !== 2 || !digest(value.roleDigest)) return null; try { return { input: revisionSubscriptionInput(value.input), roleDigest: value.roleDigest }; } catch { return null; } }
export function subscriptionIntent(value: unknown, id: string): SubscriptionIntent | null {
  if (!record(value) || Object.keys(value).length !== 4 || value.revisionId !== id || !uuid(value.id)) return null;
  try { const body = revisionSubscriptionInput(value.body), draft = subscriptionDraft(value.draft); return draft && same(body, draft.input) ? { id: value.id, revisionId: id, body, draft: value.draft as SubscriptionDraft } : null; } catch { return null; }
}
export function subscriptionAuthority(value: unknown, principalId: string): 'view' | 'interact_or_edit' | 'edit' | null {
  try { const input = revisionSubscriptionInput(record(value) && 'body' in value ? value.body : record(value) && 'input' in value ? value.input : value); return input.principalId === principalId ? 'view' : input.action === 'subscribe' ? 'interact_or_edit' : input.action === 'unsubscribe' ? 'edit' : null; } catch { return null; }
}
export function prepareSubscriptionDraft(snapshot: RevisionSubscriptionSnapshot, action: RevisionSubscriptionAction, person: RevisionSubscriptionStatus = snapshot.viewer, inspected?: RevisionSubscriptionPerson): SubscriptionDraft {
  const pins = { principalId: action === 'mute' || action === 'unmute' ? snapshot.viewer.principalId : person.principalId, expectedAuthorVersion: inspected?.authorVersion ?? snapshot.authorVersion, expectedReviewerVersion: inspected?.reviewerVersion ?? snapshot.reviewerVersion, expectedAccessEpoch: inspected?.accessEpoch ?? snapshot.accessEpoch };
  return { input: revisionSubscriptionInput({ action, ...pins, ...(action === 'mute' || action === 'unmute' ? { expectedMuteVersion: snapshot.mute.version } : { expectedSubscriptionVersion: person.version }) }), roleDigest: inspected?.roleDigest ?? snapshot.roleDigest };
}
export function subscriptionDraftMatches(draft: SubscriptionDraft, snapshot: RevisionSubscriptionSnapshot): boolean {
  const input = draft.input;
  if (input.expectedAccessEpoch !== snapshot.accessEpoch) return false;
  if ('expectedMuteVersion' in input) return input.principalId === snapshot.viewer.principalId && input.expectedMuteVersion === snapshot.mute.version;
  const person = input.principalId === snapshot.viewer.principalId ? snapshot.viewer : snapshot.subscribers.find(item => item.principalId === input.principalId);
  return draft.roleDigest === snapshot.roleDigest && input.expectedAuthorVersion === snapshot.authorVersion && input.expectedReviewerVersion <= snapshot.reviewerVersion && (!person || input.expectedSubscriptionVersion === person.version);
}
export function subscriptionLabel(action: RevisionSubscriptionAction): string { return ({ subscribe: 'Follow Revision', unsubscribe: 'Unfollow Revision', mute: 'Mute Revision', unmute: 'Unmute Revision' })[action]; }
export async function verifiedSubscriptionResult(value: unknown, id: string, input: RevisionSubscriptionInput, principalId: string): Promise<RevisionSubscriptionReceipt> {
  if (!validRevisionSubscriptionResult(value, id, input, principalId)) throw new Error('The following receipt does not match this request. Keep it for explicit retry.');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(revisionSubscriptionInput(input))))), byte => byte.toString(16).padStart(2, '0')).join('');
  if (value.inputSha256 !== hash) throw new Error('The following receipt belongs to a different request. Keep this request for recovery.');
  return value;
}
