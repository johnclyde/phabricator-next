import { isRevisionLifecycleSnapshot, isRevisionLifecycleTransaction, revisionLifecycleInput, validRevisionLifecycleResult, type RevisionLifecycleAction, type RevisionLifecycleHistory, type RevisionLifecycleInput, type RevisionLifecycleReceipt, type RevisionLifecycleSnapshot } from '../shared/revision-lifecycle';

export const LIFECYCLE_HISTORY_LIMIT = 500;
export interface LifecycleReading { snapshot: RevisionLifecycleSnapshot; history: RevisionLifecycleHistory }
export interface LifecycleIntent { id: string; revisionId: string; body: RevisionLifecycleInput; draft: RevisionLifecycleInput }
export interface RevisionCounters { currentVersion: number; authorVersion?: number; lifecycleVersion?: number; status: string }
/** Counters are monotonic. A fresh read must never be overwritten by older workspace metadata. */
export function revisionRefreshDirection(known: RevisionCounters | undefined, read: RevisionCounters): 'workspace' | 'revision' | null {
  if (!known) return 'workspace';
  const counters = ['currentVersion', 'authorVersion', 'lifecycleVersion'] as const;
  if (counters.some(key => read[key] !== undefined && (known[key] === undefined || read[key]! > known[key]!))) return 'workspace';
  if (counters.some(key => known[key] !== undefined && (read[key] === undefined || known[key]! > read[key]!))) return 'revision';
  return (known.lifecycleVersion === undefined || read.lifecycleVersion === undefined) && known.status !== read.status ? 'revision' : null;
}
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const integer = (value: unknown, minimum = 0): value is number => Number.isSafeInteger(value) && Number(value) >= minimum;
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
export function lifecycleSnapshot(value: unknown, id: string): value is RevisionLifecycleSnapshot {
  return isRevisionLifecycleSnapshot(value, id) && value.access.capabilities.view && typeof value.access.policy.spaceId === 'string' && integer(value.access.policy.version, 1);
}
export function lifecycleHistory(value: unknown, id: string): value is RevisionLifecycleHistory {
  if (!record(value) || Object.keys(value).length !== 5 || value.revisionId !== id || !integer(value.lifecycleVersion) || !integer(value.accessEpoch) || !Array.isArray(value.transactions) || value.transactions.length > LIFECYCLE_HISTORY_LIMIT || !(value.nextBefore === null || integer(value.nextBefore, 1))) return false;
  let previous = value.lifecycleVersion + 1;
  const ids = new Set<string>(), operations = new Set<string>();
  for (const item of value.transactions) {
    if (!isRevisionLifecycleTransaction(item, id) || item.lifecycleVersion >= previous || ids.has(item.id) || item.operationId !== null && operations.has(item.operationId)) return false;
    previous = item.lifecycleVersion; ids.add(item.id); if (item.operationId !== null) operations.add(item.operationId);
  }
  return value.nextBefore === null || value.nextBefore === value.transactions.at(-1)?.lifecycleVersion;
}
export function lifecycleReading(value: unknown, id: string): LifecycleReading | null {
  return record(value) && Object.keys(value).length === 2 && lifecycleSnapshot(value.snapshot, id) && lifecycleHistory(value.history, id) && value.snapshot.lifecycle.version === value.history.lifecycleVersion && value.snapshot.accessEpoch === value.history.accessEpoch ? { snapshot: value.snapshot, history: value.history } : null;
}
export function mergeLifecycleHistory(previous: RevisionLifecycleHistory, next: RevisionLifecycleHistory): RevisionLifecycleHistory {
  if (!lifecycleHistory(previous, previous.revisionId) || !lifecycleHistory(next, previous.revisionId) || previous.nextBefore === null || previous.lifecycleVersion !== next.lifecycleVersion || previous.accessEpoch !== next.accessEpoch || next.transactions.some(item => item.lifecycleVersion >= previous.nextBefore! || previous.transactions.some(old => old.id === item.id || item.operationId !== null && old.operationId === item.operationId)) || previous.transactions.length + next.transactions.length > LIFECYCLE_HISTORY_LIMIT) throw new Error('Lifecycle history changed. Reload Lifecycle before continuing.');
  return { ...next, transactions: [...previous.transactions, ...next.transactions] };
}
export function lifecycleDraft(value: unknown): RevisionLifecycleInput | null { try { return revisionLifecycleInput(value); } catch { return null; } }
export function lifecycleIntent(value: unknown, revisionId: string): LifecycleIntent | null {
  if (!record(value) || value.revisionId !== revisionId || !uuid(value.id) || Object.keys(value).length !== 4) return null;
  const body = lifecycleDraft(value.body), draft = lifecycleDraft(value.draft);
  return body && draft && JSON.stringify(body) === JSON.stringify(draft) ? { id: value.id, revisionId, body, draft: value.draft as RevisionLifecycleInput } : null;
}
export function prepareLifecycleDraft(snapshot: RevisionLifecycleSnapshot, action: RevisionLifecycleAction): RevisionLifecycleInput {
  return revisionLifecycleInput({ action, message: '', expectedLifecycleVersion: snapshot.lifecycle.version, expectedAuthorVersion: snapshot.authorship.version, expectedVersion: snapshot.head.number, expectedVersionId: snapshot.head.versionId, expectedContentHash: snapshot.head.contentHash, expectedAccessEpoch: snapshot.accessEpoch, expectedConfigId: snapshot.configId, expectedEvidenceSha256: snapshot.evidence.sha256 });
}
export function lifecycleDraftMatches(draft: RevisionLifecycleInput, snapshot: RevisionLifecycleSnapshot): boolean {
  return draft.expectedLifecycleVersion === snapshot.lifecycle.version && draft.expectedAuthorVersion === snapshot.authorship.version && draft.expectedVersion === snapshot.head.number && draft.expectedVersionId === snapshot.head.versionId && draft.expectedContentHash === snapshot.head.contentHash && draft.expectedAccessEpoch === snapshot.accessEpoch && draft.expectedConfigId === snapshot.configId && draft.expectedEvidenceSha256 === snapshot.evidence.sha256;
}
export async function verifiedLifecycleResult(value: unknown, id: string, input: RevisionLifecycleInput, principalId: string): Promise<RevisionLifecycleReceipt> {
  if (!validRevisionLifecycleResult(value, id, input, principalId)) throw new Error('The lifecycle receipt does not match this exact request. Keep the request and retry it explicitly.');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(revisionLifecycleInput(input))))), byte => byte.toString(16).padStart(2, '0')).join('');
  if (value.inputSha256 !== hash) throw new Error('The lifecycle receipt belongs to a different request. Keep this request for exact recovery.');
  return value;
}
