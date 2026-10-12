import type { ActorAttribution } from './types';
import type { ObjectAccess } from './policy';
import { isRevisionId } from './revision-dependencies';
import { isRevisionAuthor, isRevisionAuthorId } from './revision-authorship';
import { isRevisionMetadataAttribution } from './revision-metadata';

export const REVISION_SUBSCRIPTION_LIMITS = { people: 1000, page: 100 } as const;
export type RevisionSubscriptionAction = 'subscribe' | 'unsubscribe' | 'mute' | 'unmute';
export type RevisionSubscriptionExplicitState = 'subscribed' | 'unsubscribed';
export type RevisionSubscriptionAutomaticRole = 'author' | 'reviewer';
export interface RevisionSubscriptionStatus { revisionId: string; principalId: string; displayName: string | null; version: number; state: RevisionSubscriptionExplicitState | null; automatic: RevisionSubscriptionAutomaticRole[]; following: boolean; updatedAt: string | null }
export interface RevisionMuteState { revisionId: string; principalId: string; version: number; muted: boolean; updatedAt: string | null }
interface Pins { principalId: string; expectedAuthorVersion: number; expectedReviewerVersion: number; expectedAccessEpoch: number }
export type RevisionSubscriptionInput = (Pins & { action: 'subscribe' | 'unsubscribe'; expectedSubscriptionVersion: number }) | (Pins & { action: 'mute' | 'unmute'; expectedMuteVersion: number });
export interface RevisionSubscriptionSnapshot { revisionId: string; subscriptionVersion: number; authorVersion: number; reviewerVersion: number; roleDigest: string; subscribers: RevisionSubscriptionStatus[]; viewer: RevisionSubscriptionStatus; mute: RevisionMuteState; nextAfter: string | null; access: ObjectAccess; accessEpoch: number }
export interface RevisionSubscriptionPerson { status: RevisionSubscriptionStatus; authorVersion: number; reviewerVersion: number; roleDigest: string; accessEpoch: number }
export interface RevisionSubscriptionTransaction { id: string; revisionId: string; operationId: string | null; subscriptionVersion: number; principalId: string; displayName: string; version: number; before: RevisionSubscriptionExplicitState | null; after: RevisionSubscriptionExplicitState; reason: 'explicit' | 'comment' | 'mention'; commentId: string | null; mentionCommentId?: string; authorVersion: number; reviewerVersion: number; attribution: ActorAttribution; createdAt: string }
export interface RevisionMuteTransaction { id: string; revisionId: string; operationId: string; principalId: string; version: number; before: boolean; after: boolean; attribution: ActorAttribution; createdAt: string }
interface Receipt { revisionId: string; operationId: string; inputSha256: string; changed: boolean; accessEpoch: number }
export type RevisionSubscriptionReceipt = (Receipt & { kind: 'subscription'; subscriptionVersion: number; status: RevisionSubscriptionStatus; transaction: RevisionSubscriptionTransaction | null }) | (Receipt & { kind: 'mute'; mute: RevisionMuteState; transaction: RevisionMuteTransaction | null });
export interface RevisionSubscriptionHistory { revisionId: string; subscriptionVersion: number; transactions: RevisionSubscriptionTransaction[]; nextBefore: number | null; accessEpoch: number }
export interface RevisionMuteHistory { revisionId: string; principalId: string; muteVersion: number; transactions: RevisionMuteTransaction[]; nextBefore: number | null; accessEpoch: number }

const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const keys = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && Object.keys(v).every(k => names.includes(k));
const integer = (v: unknown, min = 0): v is number => Number.isSafeInteger(v) && Number(v) >= min;
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 240 && !v.includes('\0') && !/[\uD800-\uDFFF]/u.test(v);
const date = (v: unknown): v is string => text(v) && Number.isFinite(Date.parse(v));
const state = (v: unknown): v is RevisionSubscriptionExplicitState => v === 'subscribed' || v === 'unsubscribed';
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function revisionSubscriptionInput(value: unknown): RevisionSubscriptionInput {
  if (!object(value) || !['subscribe', 'unsubscribe', 'mute', 'unmute'].includes(String(value.action))) throw new Error('Choose follow, unfollow, mute or unmute.');
  const subscription = value.action === 'subscribe' || value.action === 'unsubscribe', counter = subscription ? 'expectedSubscriptionVersion' : 'expectedMuteVersion';
  if (!keys(value, ['action', 'principalId', counter, 'expectedAuthorVersion', 'expectedReviewerVersion', 'expectedAccessEpoch']) || !isRevisionAuthorId(value.principalId) || !integer(value[counter]) || !integer(value.expectedAuthorVersion) || !integer(value.expectedReviewerVersion) || !integer(value.expectedAccessEpoch)) throw new Error('Provide the inspected person, preference version, automatic-role versions and access epoch.');
  const common = { principalId: value.principalId, expectedAuthorVersion: value.expectedAuthorVersion, expectedReviewerVersion: value.expectedReviewerVersion, expectedAccessEpoch: value.expectedAccessEpoch };
  return subscription ? { action: value.action as 'subscribe' | 'unsubscribe', ...common, expectedSubscriptionVersion: value.expectedSubscriptionVersion as number } : { action: value.action as 'mute' | 'unmute', ...common, expectedMuteVersion: value.expectedMuteVersion as number };
}
export function isRevisionSubscriptionStatus(v: unknown, id?: string): v is RevisionSubscriptionStatus {
  if (!object(v) || !keys(v, ['revisionId', 'principalId', 'displayName', 'version', 'state', 'automatic', 'following', 'updatedAt']) || !isRevisionId(v.revisionId) || id !== undefined && v.revisionId !== id || !isRevisionAuthorId(v.principalId) || !(v.displayName === null || isRevisionAuthor({ principalId: v.principalId, displayName: v.displayName })) || !integer(v.version) || !(v.state === null || state(v.state)) || !Array.isArray(v.automatic) || ![[], ['author'], ['reviewer'], ['author', 'reviewer']].some(roles => same(roles, v.automatic)) || typeof v.following !== 'boolean') return false;
  return v.following === (v.state === 'subscribed' || v.automatic.length > 0) && (v.version === 0 ? v.state === null && v.updatedAt === null : state(v.state) && v.displayName !== null && date(v.updatedAt));
}
export function isRevisionMuteState(v: unknown, id?: string, principalId?: string): v is RevisionMuteState {
  return object(v) && keys(v, ['revisionId', 'principalId', 'version', 'muted', 'updatedAt']) && isRevisionId(v.revisionId) && (id === undefined || v.revisionId === id) && isRevisionAuthorId(v.principalId) && (principalId === undefined || v.principalId === principalId) && integer(v.version) && typeof v.muted === 'boolean' && (v.version === 0 ? v.muted === false && v.updatedAt === null : date(v.updatedAt));
}
export function isRevisionSubscriptionTransaction(v: unknown, id?: string): v is RevisionSubscriptionTransaction {
  if (!object(v) || !keys(v, ['id', 'revisionId', 'operationId', 'subscriptionVersion', 'principalId', 'displayName', 'version', 'before', 'after', 'reason', 'commentId', 'authorVersion', 'reviewerVersion', 'attribution', 'createdAt', ...(v.reason === 'mention' ? ['mentionCommentId'] : [])]) || !text(v.id) || !isRevisionId(v.revisionId) || id !== undefined && v.revisionId !== id || !integer(v.subscriptionVersion, 1) || !isRevisionAuthor({ principalId: v.principalId, displayName: v.displayName }) || !integer(v.version, 1) || !(v.before === null || state(v.before)) || !state(v.after) || v.before === v.after || !integer(v.authorVersion) || !integer(v.reviewerVersion) || !isRevisionMetadataAttribution(v.attribution) || !date(v.createdAt) || (v.version === 1) !== (v.before === null)) return false;
  if (v.reason === 'mention') return v.operationId === null && v.commentId === null && text(v.mentionCommentId) && v.after === 'subscribed';
  return v.reason === 'explicit' ? text(v.operationId) && v.commentId === null : v.reason === 'comment' && v.operationId === null && text(v.commentId) && v.before === null && v.after === 'subscribed' && v.principalId === v.attribution.principalId;
}
export function isRevisionMuteTransaction(v: unknown, id?: string, principalId?: string): v is RevisionMuteTransaction {
  return object(v) && keys(v, ['id', 'revisionId', 'operationId', 'principalId', 'version', 'before', 'after', 'attribution', 'createdAt']) && text(v.id) && text(v.operationId) && isRevisionId(v.revisionId) && (id === undefined || v.revisionId === id) && isRevisionAuthorId(v.principalId) && (principalId === undefined || v.principalId === principalId) && integer(v.version, 1) && typeof v.before === 'boolean' && typeof v.after === 'boolean' && v.before !== v.after && (v.version !== 1 || v.before === false) && isRevisionMetadataAttribution(v.attribution) && v.attribution.principalId === v.principalId && date(v.createdAt);
}
export function isRevisionSubscriptionPerson(v: unknown, id: string, principalId?: string): v is RevisionSubscriptionPerson {
  return object(v) && keys(v, ['status', 'authorVersion', 'reviewerVersion', 'roleDigest', 'accessEpoch']) && isRevisionSubscriptionStatus(v.status, id) && (principalId === undefined || v.status.principalId === principalId) && integer(v.authorVersion) && integer(v.reviewerVersion) && typeof v.roleDigest === 'string' && /^[a-f0-9]{64}$/.test(v.roleDigest) && integer(v.accessEpoch);
}
export function isRevisionSubscriptionSnapshot(v: unknown, id: string, principalId?: string): v is RevisionSubscriptionSnapshot {
  if (!object(v) || !keys(v, ['revisionId', 'subscriptionVersion', 'authorVersion', 'reviewerVersion', 'roleDigest', 'subscribers', 'viewer', 'mute', 'nextAfter', 'access', 'accessEpoch']) || v.revisionId !== id || !integer(v.subscriptionVersion) || !integer(v.authorVersion) || !integer(v.reviewerVersion) || typeof v.roleDigest !== 'string' || !/^[a-f0-9]{64}$/.test(v.roleDigest) || !integer(v.accessEpoch) || !isRevisionSubscriptionStatus(v.viewer, id) || v.viewer.version > v.subscriptionVersion || principalId !== undefined && v.viewer.principalId !== principalId || !isRevisionMuteState(v.mute, id, v.viewer.principalId) || !Array.isArray(v.subscribers) || v.subscribers.length > REVISION_SUBSCRIPTION_LIMITS.page || !(v.nextAfter === null || isRevisionAuthorId(v.nextAfter))) return false;
  let prior = ''; for (const item of v.subscribers) { if (!isRevisionSubscriptionStatus(item, id) || !item.following || item.principalId <= prior || item.version > v.subscriptionVersion) return false; prior = item.principalId; if (item.principalId === v.viewer.principalId && !same(item, v.viewer)) return false; }
  return (v.nextAfter === null || v.subscribers.length > 0 && v.nextAfter === prior) && object(v.access) && object(v.access.policy) && v.access.policy.objectId === id && object(v.access.capabilities) && ['view', 'edit', 'interact', 'managePolicy'].every(k => typeof (v.access as ObjectAccess).capabilities[k as keyof ObjectAccess['capabilities']] === 'boolean');
}
export function validRevisionSubscriptionResult(v: unknown, id: string, input: RevisionSubscriptionInput, principalId?: string): v is RevisionSubscriptionReceipt {
  if (!object(v) || v.revisionId !== id || !text(v.operationId) || typeof v.inputSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(v.inputSha256) || typeof v.changed !== 'boolean' || !integer(v.accessEpoch)) return false;
  if (input.action === 'subscribe' || input.action === 'unsubscribe') {
    if (!keys(v, ['revisionId', 'operationId', 'inputSha256', 'changed', 'accessEpoch', 'kind', 'subscriptionVersion', 'status', 'transaction']) || v.kind !== 'subscription' || !integer(v.subscriptionVersion) || !isRevisionSubscriptionStatus(v.status, id) || v.status.principalId !== input.principalId || v.status.version !== input.expectedSubscriptionVersion + Number(v.changed) || v.status.version > v.subscriptionVersion || v.status.state !== (input.action === 'subscribe' ? 'subscribed' : 'unsubscribed')) return false;
    if (!v.changed) return v.transaction === null;
    const t = v.transaction; return isRevisionSubscriptionTransaction(t, id) && t.operationId === v.operationId && t.reason === 'explicit' && t.subscriptionVersion === v.subscriptionVersion && t.principalId === input.principalId && t.version === v.status.version && t.displayName === v.status.displayName && t.after === v.status.state && t.createdAt === v.status.updatedAt && t.authorVersion === input.expectedAuthorVersion && t.reviewerVersion >= input.expectedReviewerVersion && (principalId === undefined || t.attribution.principalId === principalId);
  }
  if (!('expectedMuteVersion' in input)) return false;
  if (!keys(v, ['revisionId', 'operationId', 'inputSha256', 'changed', 'accessEpoch', 'kind', 'mute', 'transaction']) || v.kind !== 'mute' || !isRevisionMuteState(v.mute, id, input.principalId) || v.mute.version !== input.expectedMuteVersion + Number(v.changed) || v.mute.muted !== (input.action === 'mute') || principalId !== undefined && principalId !== input.principalId) return false;
  if (!v.changed) return v.transaction === null;
  const t = v.transaction; return isRevisionMuteTransaction(t, id, input.principalId) && t.operationId === v.operationId && t.version === v.mute.version && t.after === v.mute.muted && t.createdAt === v.mute.updatedAt;
}
export function isRevisionSubscriptionHistory(v: unknown, id: string): v is RevisionSubscriptionHistory {
  if (!object(v) || !keys(v, ['revisionId', 'subscriptionVersion', 'transactions', 'nextBefore', 'accessEpoch']) || v.revisionId !== id || !integer(v.subscriptionVersion) || !integer(v.accessEpoch) || !Array.isArray(v.transactions) || v.transactions.length > REVISION_SUBSCRIPTION_LIMITS.page || !(v.nextBefore === null || integer(v.nextBefore, 1))) return false;
  let previous = v.subscriptionVersion + 1; const ids = new Set<string>(), operations = new Set<string>();
  for (const t of v.transactions) { if (!isRevisionSubscriptionTransaction(t, id) || t.subscriptionVersion >= previous || ids.has(t.id) || t.operationId !== null && operations.has(t.operationId)) return false; previous = t.subscriptionVersion; ids.add(t.id); if (t.operationId !== null) operations.add(t.operationId); }
  return v.nextBefore === null || v.transactions.length > 0 && v.nextBefore === previous;
}
export function isRevisionMuteHistory(v: unknown, id: string, principalId?: string): v is RevisionMuteHistory {
  if (!object(v) || !keys(v, ['revisionId', 'principalId', 'muteVersion', 'transactions', 'nextBefore', 'accessEpoch']) || v.revisionId !== id || !isRevisionAuthorId(v.principalId) || principalId !== undefined && v.principalId !== principalId || !integer(v.muteVersion) || !integer(v.accessEpoch) || !Array.isArray(v.transactions) || v.transactions.length > REVISION_SUBSCRIPTION_LIMITS.page || !(v.nextBefore === null || integer(v.nextBefore, 1))) return false;
  let previous = v.muteVersion + 1; const ids = new Set<string>(), operations = new Set<string>();
  for (const t of v.transactions) { if (!isRevisionMuteTransaction(t, id, v.principalId) || t.version >= previous || ids.has(t.id) || operations.has(t.operationId)) return false; previous = t.version; ids.add(t.id); operations.add(t.operationId); }
  return v.nextBefore === null || v.transactions.length > 0 && v.nextBefore === previous;
}
