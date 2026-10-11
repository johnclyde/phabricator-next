import { isRevisionId } from './revision-dependencies';
import { isRevisionAuthor, isRevisionAuthorHead, isRevisionAuthorId } from './revision-authorship';
import type { RevisionAuthor, RevisionAuthorHead } from './revision-authorship';

export const NOTIFICATION_LIMITS = { page: 100, scan: 1000, unreadRevisions: 10000, readRows: 10000, recipients: 10000, projectRows: 20000 } as const;
export const NOTIFICATION_KINDS = ['created', 'source_updated', 'commented', 'replied', 'suggestion_applied', 'review_completed', 'reviewers_changed', 'lifecycle_changed', 'author_changed', 'metadata_changed', 'projects_changed', 'subscribers_changed'] as const;
export type NotificationKind = typeof NOTIFICATION_KINDS[number];
export interface NotificationEvent { id: string; revisionId: string; kind: NotificationKind; cause: { type: string; id: string }; actor: RevisionAuthor | null; createdAt: string; head: RevisionAuthorHead | null }
export interface NotificationItem { id: string; event: NotificationEvent; revision: { id: string; title: string; kind: 'code' | 'paper' | 'document' }; read: boolean; version: number }
export interface NotificationSummary { principalId: string; horizon: string; unreadCount: number; readVersion: number; accessEpoch: number }
export interface NotificationInbox extends NotificationSummary { items: NotificationItem[]; nextBefore: string | null }
export interface NotificationQuery { filter?: 'all' | 'unread' | 'read'; before?: string; limit?: number }
export type NotificationInput = { action: 'read' | 'unread'; notificationId: string; expectedVersion: number; expectedAccessEpoch: number } | { action: 'read_through'; horizon: string; expectedAccessEpoch: number } | { action: 'read_object'; revisionId: string; horizon: string; expectedAccessEpoch: number };
export interface NotificationReceipt { operationId: string; inputSha256: string; changed: boolean; accessEpoch: number }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).length === allowed.length && Object.keys(v).every(k => allowed.includes(k));
const natural = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const token = (v: unknown): v is string => typeof v === 'string' && v.length >= 32 && v.length <= 2048 && /^[A-Za-z0-9_-]+$/.test(v);
export function notificationInput(value: unknown): NotificationInput {
  if (!object(value) || !natural(value.expectedAccessEpoch)) throw new Error('Provide the inspected notification and access epoch.');
  if (value.action === 'read' || value.action === 'unread') {
    if (!keys(value, ['action', 'notificationId', 'expectedVersion', 'expectedAccessEpoch']) || !uuid(value.notificationId) || !natural(value.expectedVersion)) throw new Error('Provide the inspected notification and read version.');
    return { action: value.action, notificationId: value.notificationId, expectedVersion: value.expectedVersion, expectedAccessEpoch: value.expectedAccessEpoch };
  }
  if (value.action === 'read_through' && keys(value, ['action', 'horizon', 'expectedAccessEpoch']) && token(value.horizon)) return { action: value.action, horizon: value.horizon, expectedAccessEpoch: value.expectedAccessEpoch };
  if (value.action === 'read_object' && keys(value, ['action', 'revisionId', 'horizon', 'expectedAccessEpoch']) && isRevisionId(value.revisionId) && token(value.horizon)) return { action: value.action, revisionId: value.revisionId, horizon: value.horizon, expectedAccessEpoch: value.expectedAccessEpoch };
  throw new Error('Choose a notification read action and its inspected boundary.');
}
export function notificationQuery(value: unknown): Required<Pick<NotificationQuery, 'filter' | 'limit'>> & Pick<NotificationQuery, 'before'> {
  if (!object(value) || Object.keys(value).some(k => !['filter', 'limit', 'before'].includes(k))) throw new Error('Choose valid notification filters.');
  const filter = value.filter ?? 'all', limit = value.limit ?? 25;
  if (!['all', 'unread', 'read'].includes(String(filter)) || !natural(limit) || limit < 1 || limit > NOTIFICATION_LIMITS.page || value.before !== undefined && !token(value.before)) throw new Error('Choose valid notification pagination.');
  return { filter: filter as 'all' | 'unread' | 'read', limit, ...(value.before === undefined ? {} : { before: value.before as string }) };
}
export function isNotificationEvent(v: unknown): v is NotificationEvent {
  return object(v) && keys(v, ['id', 'revisionId', 'kind', 'cause', 'actor', 'createdAt', 'head']) && uuid(v.id) && isRevisionId(v.revisionId) && NOTIFICATION_KINDS.includes(v.kind as NotificationKind) && object(v.cause) && keys(v.cause, ['type', 'id']) && typeof v.cause.type === 'string' && /^[a-z_]{1,40}$/.test(v.cause.type) && typeof v.cause.id === 'string' && v.cause.id.length > 0 && v.cause.id.length <= 240 && !v.cause.id.includes('\0') && (v.actor === null || isRevisionAuthor(v.actor)) && typeof v.createdAt === 'string' && Number.isFinite(Date.parse(v.createdAt)) && (v.head === null || isRevisionAuthorHead(v.head));
}
export function isNotificationItem(v: unknown): v is NotificationItem {
  return object(v) && keys(v, ['id', 'event', 'revision', 'read', 'version']) && uuid(v.id) && isNotificationEvent(v.event) && object(v.revision) && keys(v.revision, ['id', 'title', 'kind']) && v.revision.id === v.event.revisionId && typeof v.revision.title === 'string' && v.revision.title.length <= 1000 && !v.revision.title.includes('\0') && ['code', 'paper', 'document'].includes(String(v.revision.kind)) && typeof v.read === 'boolean' && natural(v.version) && (v.version !== 0 || v.read === false);
}
function summary(v: Record<string, unknown>, principalId?: string): boolean { return isRevisionAuthorId(v.principalId) && (principalId === undefined || v.principalId === principalId) && token(v.horizon) && natural(v.unreadCount) && natural(v.readVersion) && natural(v.accessEpoch); }
export function isNotificationSummary(v: unknown, principalId?: string): v is NotificationSummary { return object(v) && keys(v, ['principalId', 'horizon', 'unreadCount', 'readVersion', 'accessEpoch']) && summary(v, principalId); }
export function isNotificationInbox(v: unknown, principalId?: string): v is NotificationInbox {
  return object(v) && keys(v, ['principalId', 'horizon', 'unreadCount', 'readVersion', 'accessEpoch', 'items', 'nextBefore']) && summary(v, principalId) && Array.isArray(v.items) && v.items.length <= NOTIFICATION_LIMITS.page && v.items.every(isNotificationItem) && new Set(v.items.map(i => i.id)).size === v.items.length && new Set(v.items.map(i => i.event.id)).size === v.items.length && (v.nextBefore === null || token(v.nextBefore));
}
export function validNotificationResult(v: unknown): v is NotificationReceipt { return object(v) && keys(v, ['operationId', 'inputSha256', 'changed', 'accessEpoch']) && uuid(v.operationId) && typeof v.inputSha256 === 'string' && /^[a-f0-9]{64}$/.test(v.inputSha256) && typeof v.changed === 'boolean' && natural(v.accessEpoch); }
export type NotificationReadInput = NotificationInput;
export const notificationReadInput = notificationInput;
export const validNotificationReadResult = validNotificationResult;
