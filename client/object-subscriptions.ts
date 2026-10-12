import { isObjectMuteHistory, isObjectMuteTransaction, isObjectSubscriptionHistory, isObjectSubscriptionSnapshot, isObjectSubscriptionStatus, isObjectSubscriptionTransaction, objectSubscriptionInput, validObjectSubscriptionResult, type ObjectMuteHistory, type ObjectSubscriptionAction, type ObjectSubscriptionHistory, type ObjectSubscriptionInput, type ObjectSubscriptionPerson, type ObjectSubscriptionReceipt, type ObjectSubscriptionSnapshot, type ObjectSubscriptionStatus } from '../shared/object-subscriptions';
import { isSubscriptionObjectId, OBJECT_SUBSCRIPTION_LIMITS } from '../shared/object-subscriptions';

export const FOLLOW_HISTORY_LIMIT = 500, FOLLOW_PEOPLE_LIMIT = OBJECT_SUBSCRIPTION_LIMITS.people + 1;
export interface SubscriptionReading { snapshot: ObjectSubscriptionSnapshot; history: ObjectSubscriptionHistory; muteHistory: ObjectMuteHistory }
export interface SubscriptionDraft { input: ObjectSubscriptionInput; objectId: string }
export interface SubscriptionIntent { id: string; objectId: string; body: ObjectSubscriptionInput; draft: SubscriptionDraft }
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
export function subscriptionSnapshot(value: unknown, id: string, principalId?: string): value is ObjectSubscriptionSnapshot {
  if (!record(value) || !Array.isArray(value.subscribers) || value.subscribers.length > FOLLOW_PEOPLE_LIMIT || !isObjectSubscriptionSnapshot({ ...value, subscribers: [], nextAfter: null }, id, principalId)) return false;
  const snapshot = value as unknown as ObjectSubscriptionSnapshot;
  if (!snapshot.access.capabilities.view) return false;
  let previous = '';
  for (const person of snapshot.subscribers) { if (!isObjectSubscriptionStatus(person, id) || !person.following || person.principalId <= previous || person.version > snapshot.subscriptionVersion || person.principalId === snapshot.viewer.principalId && !same(person, snapshot.viewer)) return false; previous = person.principalId; }
  return snapshot.nextAfter === null || snapshot.subscribers.length > 0 && snapshot.nextAfter === previous;
}
export function subscriptionHistory(value: unknown, id: string): value is ObjectSubscriptionHistory {
  if (!record(value) || !Array.isArray(value.transactions) || value.transactions.length > FOLLOW_HISTORY_LIMIT || !isObjectSubscriptionHistory({ ...value, transactions: [], nextBefore: null }, id)) return false;
  const history = value as unknown as ObjectSubscriptionHistory, ids = new Set<string>(), operations = new Set<string>(); let previous = history.subscriptionVersion + 1;
  for (const item of history.transactions) { if (!isObjectSubscriptionTransaction(item, id) || item.subscriptionVersion >= previous || ids.has(item.id) || item.operationId !== null && operations.has(item.operationId)) return false; previous = item.subscriptionVersion; ids.add(item.id); if (item.operationId !== null) operations.add(item.operationId); }
  return history.nextBefore === null || history.transactions.length > 0 && history.nextBefore === previous;
}
export function muteHistory(value: unknown, id: string, principalId?: string): value is ObjectMuteHistory {
  if (!record(value) || !Array.isArray(value.transactions) || value.transactions.length > FOLLOW_HISTORY_LIMIT || !isObjectMuteHistory({ ...value, transactions: [], nextBefore: null }, id, principalId)) return false;
  const history = value as unknown as ObjectMuteHistory, ids = new Set<string>(), operations = new Set<string>(); let previous = history.muteVersion + 1;
  for (const item of history.transactions) { if (!isObjectMuteTransaction(item, id, history.principalId) || item.version >= previous || ids.has(item.id) || operations.has(item.operationId)) return false; previous = item.version; ids.add(item.id); operations.add(item.operationId); }
  return history.nextBefore === null || history.transactions.length > 0 && history.nextBefore === previous;
}
export function subscriptionReading(value: unknown, id: string, principalId?: string): SubscriptionReading | null {
  return record(value) && Object.keys(value).length === 3 && subscriptionSnapshot(value.snapshot, id, principalId) && subscriptionHistory(value.history, id) && muteHistory(value.muteHistory, id, value.snapshot.viewer.principalId) && value.snapshot.subscriptionVersion === value.history.subscriptionVersion && value.snapshot.mute.version === value.muteHistory.muteVersion && value.snapshot.accessEpoch === value.history.accessEpoch && value.snapshot.accessEpoch === value.muteHistory.accessEpoch ? { snapshot: value.snapshot, history: value.history, muteHistory: value.muteHistory } : null;
}
export function mergeSubscribers(before: ObjectSubscriptionSnapshot, next: ObjectSubscriptionSnapshot): ObjectSubscriptionSnapshot {
  if (!subscriptionSnapshot(before, before.objectId) || !subscriptionSnapshot(next, before.objectId, before.viewer.principalId) || before.nextAfter === null || before.subscriptionVersion !== next.subscriptionVersion || before.accessEpoch !== next.accessEpoch || !same(before.viewer, next.viewer) || !same(before.mute, next.mute) || next.subscribers.some(person => person.principalId <= before.nextAfter!) || before.subscribers.length + next.subscribers.length > FOLLOW_PEOPLE_LIMIT) throw new Error('Following changed. Reload Following before continuing.');
  return { ...next, subscribers: [...before.subscribers, ...next.subscribers] };
}
export function mergeSubscriptionHistory(before: ObjectSubscriptionHistory, next: ObjectSubscriptionHistory): ObjectSubscriptionHistory {
  if (!subscriptionHistory(before, before.objectId) || !subscriptionHistory(next, before.objectId) || before.nextBefore === null || before.subscriptionVersion !== next.subscriptionVersion || before.accessEpoch !== next.accessEpoch || next.transactions.some(item => item.subscriptionVersion >= before.nextBefore! || before.transactions.some(old => old.id === item.id || item.operationId !== null && old.operationId === item.operationId)) || before.transactions.length + next.transactions.length > FOLLOW_HISTORY_LIMIT) throw new Error('Following history changed. Reload Following before continuing.');
  return { ...next, transactions: [...before.transactions, ...next.transactions] };
}
export function mergeMuteHistory(before: ObjectMuteHistory, next: ObjectMuteHistory): ObjectMuteHistory {
  if (!muteHistory(before, before.objectId) || !muteHistory(next, before.objectId, before.principalId) || before.nextBefore === null || before.muteVersion !== next.muteVersion || before.accessEpoch !== next.accessEpoch || next.transactions.some(item => item.version >= before.nextBefore! || before.transactions.some(old => old.id === item.id || old.operationId === item.operationId)) || before.transactions.length + next.transactions.length > FOLLOW_HISTORY_LIMIT) throw new Error('Your mute history changed. Reload Following before continuing.');
  return { ...next, transactions: [...before.transactions, ...next.transactions] };
}
export function subscriptionDraft(value: unknown, id: string): SubscriptionDraft | null { if (!record(value) || Object.keys(value).length !== 2 || value.objectId !== id || !isSubscriptionObjectId(id)) return null; try { return { objectId: id, input: objectSubscriptionInput(value.input) }; } catch { return null; } }
export function subscriptionIntent(value: unknown, id: string): SubscriptionIntent | null {
  if (!record(value) || Object.keys(value).length !== 4 || value.objectId !== id || !uuid(value.id)) return null;
  try { const body = objectSubscriptionInput(value.body), draft = subscriptionDraft(value.draft, id); return draft && same(body, draft.input) ? { id: value.id, objectId: id, body, draft } : null; } catch { return null; }
}
export function subscriptionAuthority(value: unknown, principalId: string): 'view' | 'interact_or_edit' | 'edit' | null {
  try { const input = objectSubscriptionInput(record(value) && 'body' in value ? value.body : record(value) && 'input' in value ? value.input : value); return input.principalId === principalId ? 'view' : input.action === 'subscribe' ? 'interact_or_edit' : input.action === 'unsubscribe' ? 'edit' : null; } catch { return null; }
}
export function prepareSubscriptionDraft(snapshot: ObjectSubscriptionSnapshot, action: ObjectSubscriptionAction, person: ObjectSubscriptionStatus = snapshot.viewer, inspected?: ObjectSubscriptionPerson): SubscriptionDraft {
  const pins = { principalId: action === 'mute' || action === 'unmute' ? snapshot.viewer.principalId : person.principalId, expectedAccessEpoch: inspected?.accessEpoch ?? snapshot.accessEpoch };
  return { objectId: snapshot.objectId, input: objectSubscriptionInput({ action, ...pins, ...(action === 'mute' || action === 'unmute' ? { expectedMuteVersion: snapshot.mute.version } : { expectedSubscriptionVersion: person.version }) }) };
}
export function subscriptionDraftMatches(draft: SubscriptionDraft, snapshot: ObjectSubscriptionSnapshot): boolean {
  const input = draft.input;
  if (draft.objectId !== snapshot.objectId || input.expectedAccessEpoch !== snapshot.accessEpoch) return false;
  if ('expectedMuteVersion' in input) return input.principalId === snapshot.viewer.principalId && input.expectedMuteVersion === snapshot.mute.version;
  const person = input.principalId === snapshot.viewer.principalId ? snapshot.viewer : snapshot.subscribers.find(item => item.principalId === input.principalId);
  return !person || input.expectedSubscriptionVersion === person.version;
}
export function subscriptionLabel(action: ObjectSubscriptionAction, noun: string): string { return ({ subscribe: `Follow ${noun}`, unsubscribe: `Unfollow ${noun}`, mute: `Mute ${noun}`, unmute: `Unmute ${noun}` })[action]; }
export async function verifiedSubscriptionResult(value: unknown, id: string, input: ObjectSubscriptionInput, principalId: string): Promise<ObjectSubscriptionReceipt> {
  if (!validObjectSubscriptionResult(value, id, input, principalId)) throw new Error('The following receipt does not match this request. Keep it for explicit retry.');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(objectSubscriptionInput(input))))), byte => byte.toString(16).padStart(2, '0')).join('');
  if (value.inputSha256 !== hash) throw new Error('The following receipt belongs to a different request. Keep this request for recovery.');
  return value;
}
