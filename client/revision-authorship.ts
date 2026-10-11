import { isRevisionAuthorshipSnapshot, isRevisionAuthorTransaction, revisionAuthorInput, validRevisionAuthorResult, type RevisionAuthorHistory, type RevisionAuthorInput, type RevisionAuthorResult, type RevisionAuthorshipSnapshot } from '../shared/revision-authorship';

export const AUTHOR_HISTORY_LIMIT = 500;
export interface AuthorReading { snapshot: RevisionAuthorshipSnapshot; history: RevisionAuthorHistory }
export interface AuthorIntent { id: string; revisionId: string; body: RevisionAuthorInput; draft: RevisionAuthorInput }
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const integer = (value: unknown, minimum = 0): value is number => Number.isSafeInteger(value) && Number(value) >= minimum;
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
export function authorSnapshot(value: unknown, id: string): value is RevisionAuthorshipSnapshot {
  return isRevisionAuthorshipSnapshot(value, id) && value.access.capabilities.view && typeof value.access.policy.spaceId === 'string' && integer(value.access.policy.version, 1);
}
export function authorHistory(value: unknown, id: string): value is RevisionAuthorHistory {
  if (!record(value) || Object.keys(value).length !== 5 || value.revisionId !== id || !integer(value.authorVersion) || !integer(value.accessEpoch) || !Array.isArray(value.transactions) || value.transactions.length > AUTHOR_HISTORY_LIMIT || !(value.nextBefore === null || integer(value.nextBefore, 1))) return false;
  const transactions = value.transactions;
  return new Set(transactions.map(item => record(item) ? item.id : null)).size === transactions.length && new Set(transactions.map(item => record(item) ? item.operationId : null)).size === transactions.length && transactions.every((item, index) => isRevisionAuthorTransaction(item, id) && item.authorVersion <= Number(value.authorVersion) && (!index || item.authorVersion < transactions[index - 1].authorVersion))
    && (value.nextBefore === null || value.nextBefore === transactions.at(-1)?.authorVersion);
}
export function authorReading(value: unknown, id: string): AuthorReading | null {
  return record(value) && Object.keys(value).length === 2 && authorSnapshot(value.snapshot, id) && authorHistory(value.history, id) && value.snapshot.authorship.version === value.history.authorVersion && value.snapshot.accessEpoch === value.history.accessEpoch ? { snapshot: value.snapshot, history: value.history } : null;
}
export function mergeAuthorHistory(previous: RevisionAuthorHistory, next: RevisionAuthorHistory): RevisionAuthorHistory {
  if (!authorHistory(previous, previous.revisionId) || !authorHistory(next, previous.revisionId) || previous.nextBefore === null || previous.authorVersion !== next.authorVersion || previous.accessEpoch !== next.accessEpoch || next.transactions.some(item => item.authorVersion >= previous.nextBefore! || previous.transactions.some(old => old.id === item.id || old.operationId === item.operationId)) || previous.transactions.length + next.transactions.length > AUTHOR_HISTORY_LIMIT) throw new Error('Authorship history changed. Reload Current Author before continuing.');
  return { ...next, transactions: [...previous.transactions, ...next.transactions] };
}
export function authorDraft(value: unknown): RevisionAuthorInput | null { try { return revisionAuthorInput(value); } catch { return null; } }
export function authorIntent(value: unknown, revisionId: string): AuthorIntent | null {
  if (!record(value) || value.revisionId !== revisionId || !uuid(value.id) || Object.keys(value).length !== 4) return null;
  const body = authorDraft(value.body), draft = authorDraft(value.draft);
  return body && draft && JSON.stringify(body) === JSON.stringify(draft) ? { id: value.id, revisionId, body, draft: value.draft as RevisionAuthorInput } : null;
}
export function prepareAuthorDraft(snapshot: RevisionAuthorshipSnapshot, action: 'commandeer' | { authorId: string }): RevisionAuthorInput {
  return revisionAuthorInput({ ...(action === 'commandeer' ? { action } : { action: 'assign', authorId: action.authorId }), expectedAuthorVersion: snapshot.authorship.version, expectedVersion: snapshot.head.number, expectedVersionId: snapshot.head.versionId, expectedContentHash: snapshot.head.contentHash, expectedAccessEpoch: snapshot.accessEpoch, message: '' });
}
export function authorDraftMatches(draft: RevisionAuthorInput, snapshot: RevisionAuthorshipSnapshot): boolean {
  return draft.expectedAuthorVersion === snapshot.authorship.version && draft.expectedVersion === snapshot.head.number && draft.expectedVersionId === snapshot.head.versionId && draft.expectedContentHash === snapshot.head.contentHash && draft.expectedAccessEpoch === snapshot.accessEpoch;
}
export async function verifiedAuthorResult(value: unknown, id: string, input: RevisionAuthorInput, principalId: string): Promise<RevisionAuthorResult> {
  if (!validRevisionAuthorResult(value, id, input, principalId)) throw new Error('The authorship receipt does not match this exact request. Keep the request and retry it explicitly.');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(revisionAuthorInput(input))))), byte => byte.toString(16).padStart(2, '0')).join('');
  if (value.inputSha256 !== hash) throw new Error('The authorship receipt belongs to a different request. Keep this request for exact recovery.');
  return value;
}
