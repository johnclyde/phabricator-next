import type { ActorAttribution } from './types';
import type { ObjectAccess } from './policy';
import { isRevisionAuthor, isRevisionAuthorId } from './revision-authorship';
import { isRevisionMetadataAttribution } from './revision-metadata';

export const OBJECT_SUBSCRIPTION_LIMITS = { people: 1000, page: 100 } as const;
export function isSubscriptionObjectId(value: unknown): value is string { return typeof value === 'string' && /^(?:W|PA)[1-9]\d{0,14}$/.test(value); }
export const isObjectSubscriptionId = isSubscriptionObjectId;
export type ObjectSubscriptionAction = 'subscribe' | 'unsubscribe' | 'mute' | 'unmute';
export type ObjectSubscriptionExplicitState = 'subscribed' | 'unsubscribed';
export type ObjectSubscriptionAutomaticRole = 'author';
export interface ObjectSubscriptionStatus { objectId: string; principalId: string; displayName: string | null; version: number; state: ObjectSubscriptionExplicitState | null; automatic: ObjectSubscriptionAutomaticRole[]; following: boolean; updatedAt: string | null }
export interface ObjectMuteState { objectId: string; principalId: string; version: number; muted: boolean; updatedAt: string | null }
interface Pins { principalId: string; expectedAccessEpoch: number }
export type ObjectSubscriptionInput = (Pins & { action: 'subscribe' | 'unsubscribe'; expectedSubscriptionVersion: number }) | (Pins & { action: 'mute' | 'unmute'; expectedMuteVersion: number });
export interface ObjectSubscriptionSnapshot { objectId: string; subscriptionVersion: number; subscribers: ObjectSubscriptionStatus[]; viewer: ObjectSubscriptionStatus; mute: ObjectMuteState; nextAfter: string | null; access: ObjectAccess; accessEpoch: number }
export interface ObjectSubscriptionPerson { status: ObjectSubscriptionStatus; accessEpoch: number }
export interface ObjectSubscriptionTransaction { id: string; objectId: string; operationId: string | null; subscriptionVersion: number; principalId: string; displayName: string; version: number; before: ObjectSubscriptionExplicitState | null; after: ObjectSubscriptionExplicitState; reason: 'explicit' | 'comment' | 'mention'; commentId: string | null; mentionCommentId?: string; attribution: ActorAttribution; createdAt: string }
export interface ObjectMuteTransaction { id: string; objectId: string; operationId: string; principalId: string; version: number; before: boolean; after: boolean; attribution: ActorAttribution; createdAt: string }
interface Receipt { objectId: string; operationId: string; inputSha256: string; changed: boolean; accessEpoch: number }
export type ObjectSubscriptionReceipt = (Receipt & { kind: 'subscription'; subscriptionVersion: number; status: ObjectSubscriptionStatus; transaction: ObjectSubscriptionTransaction | null }) | (Receipt & { kind: 'mute'; mute: ObjectMuteState; transaction: ObjectMuteTransaction | null });
export interface ObjectSubscriptionHistory { objectId: string; subscriptionVersion: number; transactions: ObjectSubscriptionTransaction[]; nextBefore: number | null; accessEpoch: number }
export interface ObjectMuteHistory { objectId: string; principalId: string; muteVersion: number; transactions: ObjectMuteTransaction[]; nextBefore: number | null; accessEpoch: number }

const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const keys = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && Object.keys(v).every(k => names.includes(k));
const integer = (v: unknown, min = 0): v is number => Number.isSafeInteger(v) && Number(v) >= min;
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 240 && !v.includes('\0') && !/[\uD800-\uDFFF]/u.test(v);
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const date = (v: unknown): v is string => text(v) && Number.isFinite(Date.parse(v));
const state = (v: unknown): v is ObjectSubscriptionExplicitState => v === 'subscribed' || v === 'unsubscribed';
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function objectSubscriptionInput(value: unknown): ObjectSubscriptionInput {
  if (!object(value) || !['subscribe', 'unsubscribe', 'mute', 'unmute'].includes(String(value.action))) throw new Error('Choose follow, unfollow, mute or unmute.');
  const subscription = value.action === 'subscribe' || value.action === 'unsubscribe', counter = subscription ? 'expectedSubscriptionVersion' : 'expectedMuteVersion';
  if (!keys(value, ['action', 'principalId', counter, 'expectedAccessEpoch']) || !isRevisionAuthorId(value.principalId) || !integer(value[counter]) || !integer(value.expectedAccessEpoch)) throw new Error('Provide the inspected person, preference version and access epoch.');
  const common = { principalId: value.principalId, expectedAccessEpoch: value.expectedAccessEpoch };
  return subscription ? { action: value.action as 'subscribe' | 'unsubscribe', ...common, expectedSubscriptionVersion: value.expectedSubscriptionVersion as number } : { action: value.action as 'mute' | 'unmute', ...common, expectedMuteVersion: value.expectedMuteVersion as number };
}
export function isObjectSubscriptionStatus(v: unknown, id?: string): v is ObjectSubscriptionStatus {
  if (!object(v) || !keys(v, ['objectId', 'principalId', 'displayName', 'version', 'state', 'automatic', 'following', 'updatedAt']) || !isSubscriptionObjectId(v.objectId) || id !== undefined && v.objectId !== id || !isRevisionAuthorId(v.principalId) || !(v.displayName === null || isRevisionAuthor({ principalId: v.principalId, displayName: v.displayName })) || !integer(v.version) || !(v.state === null || state(v.state)) || !Array.isArray(v.automatic) || ![[], ['author']].some(roles => same(roles, v.automatic)) || (String(v.objectId).startsWith('W') && v.automatic.length !== 0) || (v.automatic.length > 0 && v.displayName === null) || typeof v.following !== 'boolean') return false;
  return v.following === (v.state === 'subscribed' || v.automatic.length > 0) && (v.version === 0 ? v.state === null && v.updatedAt === null : state(v.state) && v.displayName !== null && date(v.updatedAt));
}
export function isObjectMuteState(v: unknown, id?: string, principalId?: string): v is ObjectMuteState {
  return object(v) && keys(v, ['objectId', 'principalId', 'version', 'muted', 'updatedAt']) && isSubscriptionObjectId(v.objectId) && (id === undefined || v.objectId === id) && isRevisionAuthorId(v.principalId) && (principalId === undefined || v.principalId === principalId) && integer(v.version) && typeof v.muted === 'boolean' && (v.version === 0 ? v.muted === false && v.updatedAt === null : date(v.updatedAt));
}
export function isObjectSubscriptionTransaction(v: unknown, id?: string): v is ObjectSubscriptionTransaction {
  if (!object(v) || !keys(v, ['id', 'objectId', 'operationId', 'subscriptionVersion', 'principalId', 'displayName', 'version', 'before', 'after', 'reason', 'commentId', 'attribution', 'createdAt', ...(v.reason === 'mention' ? ['mentionCommentId'] : [])]) || !uuid(v.id) || !isSubscriptionObjectId(v.objectId) || id !== undefined && v.objectId !== id || !integer(v.subscriptionVersion, 1) || !isRevisionAuthor({ principalId: v.principalId, displayName: v.displayName }) || !integer(v.version, 1) || v.version > v.subscriptionVersion || !(v.before === null || state(v.before)) || !state(v.after) || v.before === v.after || !isRevisionMetadataAttribution(v.attribution) || !date(v.createdAt) || (v.version === 1) !== (v.before === null)) return false;
  if (v.reason === 'mention') return String(v.objectId).startsWith('PA') && v.operationId === null && v.commentId === null && uuid(v.mentionCommentId) && v.after === 'subscribed';
  return v.reason === 'explicit' ? uuid(v.operationId) && v.commentId === null : v.reason === 'comment' && String(v.objectId).startsWith('PA') && v.operationId === null && uuid(v.commentId) && v.before === null && v.after === 'subscribed' && v.principalId === v.attribution.principalId;
}
export function isObjectMuteTransaction(v: unknown, id?: string, principalId?: string): v is ObjectMuteTransaction {
  return object(v) && keys(v, ['id', 'objectId', 'operationId', 'principalId', 'version', 'before', 'after', 'attribution', 'createdAt']) && uuid(v.id) && uuid(v.operationId) && isSubscriptionObjectId(v.objectId) && (id === undefined || v.objectId === id) && isRevisionAuthorId(v.principalId) && (principalId === undefined || v.principalId === principalId) && integer(v.version, 1) && typeof v.before === 'boolean' && typeof v.after === 'boolean' && v.before !== v.after && (v.version !== 1 || v.before === false) && isRevisionMetadataAttribution(v.attribution) && v.attribution.principalId === v.principalId && date(v.createdAt);
}
export function isObjectSubscriptionPerson(v: unknown, id: string, principalId?: string): v is ObjectSubscriptionPerson {
  return object(v) && keys(v, ['status', 'accessEpoch']) && isObjectSubscriptionStatus(v.status, id) && (principalId === undefined || v.status.principalId === principalId) && integer(v.accessEpoch);
}
export function isObjectSubscriptionSnapshot(v: unknown, id: string, principalId?: string): v is ObjectSubscriptionSnapshot {
  if (!object(v) || !keys(v, ['objectId', 'subscriptionVersion', 'subscribers', 'viewer', 'mute', 'nextAfter', 'access', 'accessEpoch']) || v.objectId !== id || !integer(v.subscriptionVersion) || !integer(v.accessEpoch) || !isObjectSubscriptionStatus(v.viewer, id) || v.viewer.version > v.subscriptionVersion || principalId !== undefined && v.viewer.principalId !== principalId || !isObjectMuteState(v.mute, id, v.viewer.principalId) || !Array.isArray(v.subscribers) || v.subscribers.length > OBJECT_SUBSCRIPTION_LIMITS.page || !(v.nextAfter === null || isRevisionAuthorId(v.nextAfter))) return false;
  let prior = ''; for (const item of v.subscribers) { if (!isObjectSubscriptionStatus(item, id) || !item.following || item.principalId <= prior || item.version > v.subscriptionVersion) return false; prior = item.principalId; if (item.principalId === v.viewer.principalId && !same(item, v.viewer)) return false; }
  return (v.nextAfter === null || v.subscribers.length > 0 && v.nextAfter === prior) && object(v.access) && object(v.access.policy) && v.access.policy.objectId === id && object(v.access.capabilities) && ['view', 'edit', 'interact', 'managePolicy'].every(k => typeof (v.access as ObjectAccess).capabilities[k as keyof ObjectAccess['capabilities']] === 'boolean');
}
export function validObjectSubscriptionResult(v: unknown, id: string, input: ObjectSubscriptionInput, principalId?: string): v is ObjectSubscriptionReceipt {
  if (!object(v) || v.objectId !== id || !uuid(v.operationId) || typeof v.inputSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(v.inputSha256) || typeof v.changed !== 'boolean' || !integer(v.accessEpoch)) return false;
  if (input.action === 'subscribe' || input.action === 'unsubscribe') {
    if (!keys(v, ['objectId', 'operationId', 'inputSha256', 'changed', 'accessEpoch', 'kind', 'subscriptionVersion', 'status', 'transaction']) || v.kind !== 'subscription' || !integer(v.subscriptionVersion) || !isObjectSubscriptionStatus(v.status, id) || v.status.principalId !== input.principalId || v.status.version !== input.expectedSubscriptionVersion + Number(v.changed) || v.status.version > v.subscriptionVersion || v.status.state !== (input.action === 'subscribe' ? 'subscribed' : 'unsubscribed')) return false;
    if (!v.changed) return v.transaction === null;
    const t = v.transaction; return isObjectSubscriptionTransaction(t, id) && t.operationId === v.operationId && t.reason === 'explicit' && t.subscriptionVersion === v.subscriptionVersion && t.principalId === input.principalId && t.version === v.status.version && t.displayName === v.status.displayName && t.after === v.status.state && t.createdAt === v.status.updatedAt && (principalId === undefined || t.attribution.principalId === principalId);
  }
  if (!('expectedMuteVersion' in input)) return false;
  if (!keys(v, ['objectId', 'operationId', 'inputSha256', 'changed', 'accessEpoch', 'kind', 'mute', 'transaction']) || v.kind !== 'mute' || !isObjectMuteState(v.mute, id, input.principalId) || v.mute.version !== input.expectedMuteVersion + Number(v.changed) || v.mute.muted !== (input.action === 'mute') || principalId !== undefined && principalId !== input.principalId) return false;
  if (!v.changed) return v.transaction === null;
  const t = v.transaction; return isObjectMuteTransaction(t, id, input.principalId) && t.operationId === v.operationId && t.version === v.mute.version && t.after === v.mute.muted && t.createdAt === v.mute.updatedAt;
}
export function isObjectSubscriptionHistory(v: unknown, id: string): v is ObjectSubscriptionHistory {
  if (!object(v) || !keys(v, ['objectId', 'subscriptionVersion', 'transactions', 'nextBefore', 'accessEpoch']) || v.objectId !== id || !integer(v.subscriptionVersion) || !integer(v.accessEpoch) || !Array.isArray(v.transactions) || v.transactions.length > OBJECT_SUBSCRIPTION_LIMITS.page || !(v.nextBefore === null || integer(v.nextBefore, 1))) return false;
  let previous = v.subscriptionVersion + 1; const ids = new Set<string>(), operations = new Set<string>();
  for (const t of v.transactions) { if (!isObjectSubscriptionTransaction(t, id) || t.subscriptionVersion >= previous || ids.has(t.id) || t.operationId !== null && operations.has(t.operationId)) return false; previous = t.subscriptionVersion; ids.add(t.id); if (t.operationId !== null) operations.add(t.operationId); }
  return v.nextBefore === null || v.transactions.length > 0 && v.nextBefore === previous;
}
export function isObjectMuteHistory(v: unknown, id: string, principalId?: string): v is ObjectMuteHistory {
  if (!object(v) || !keys(v, ['objectId', 'principalId', 'muteVersion', 'transactions', 'nextBefore', 'accessEpoch']) || v.objectId !== id || !isRevisionAuthorId(v.principalId) || principalId !== undefined && v.principalId !== principalId || !integer(v.muteVersion) || !integer(v.accessEpoch) || !Array.isArray(v.transactions) || v.transactions.length > OBJECT_SUBSCRIPTION_LIMITS.page || !(v.nextBefore === null || integer(v.nextBefore, 1))) return false;
  let previous = v.muteVersion + 1; const ids = new Set<string>(), operations = new Set<string>();
  for (const t of v.transactions) { if (!isObjectMuteTransaction(t, id, v.principalId) || t.version >= previous || ids.has(t.id) || operations.has(t.operationId)) return false; previous = t.version; ids.add(t.id); operations.add(t.operationId); }
  return v.nextBefore === null || v.transactions.length > 0 && v.nextBefore === previous;
}
