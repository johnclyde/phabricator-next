import { isRevisionId } from './revision-dependencies';
import { isRevisionAuthor, isRevisionAuthorHead, isRevisionAuthorId } from './revision-authorship';
import type { RevisionAuthor, RevisionAuthorHead } from './revision-authorship';

export const NOTIFICATION_LIMITS = { page: 100, scan: 1000, unreadObjects: 10000, unreadRevisions: 10000, readRows: 10000, recipients: 10000, projectRows: 20000 } as const;
export const REVISION_NOTIFICATION_KINDS = ['created', 'source_updated', 'commented', 'replied', 'suggestion_applied', 'review_completed', 'reviewers_changed', 'lifecycle_changed', 'author_changed', 'metadata_changed', 'projects_changed', 'subscribers_changed'] as const;
export const TASK_NOTIFICATION_KINDS = ['created', 'task_updated', 'task_commented', 'task_owner_changed', 'task_projects_changed', 'task_subscribers_changed', 'task_dependencies_changed', 'task_subtask_status_changed', 'task_merged', 'task_column_changed'] as const;
export const WIKI_NOTIFICATION_KINDS = ['created', 'wiki_updated', 'wiki_title_changed', 'wiki_published', 'wiki_deleted', 'wiki_restored', 'wiki_policy_changed', 'wiki_subscribers_changed'] as const;
export const PASTE_NOTIFICATION_KINDS = ['created', 'paste_updated', 'paste_commented', 'paste_archived', 'paste_reactivated', 'paste_subscribers_changed'] as const;
export const NOTIFICATION_KINDS = [...REVISION_NOTIFICATION_KINDS, ...TASK_NOTIFICATION_KINDS.filter(kind => kind !== 'created'), ...WIKI_NOTIFICATION_KINDS.filter(kind => kind !== 'created'), ...PASTE_NOTIFICATION_KINDS.filter(kind => kind !== 'created')] as const;
export type NotificationKind = typeof NOTIFICATION_KINDS[number];
export type NotificationContext = { kind: 'revision'; head: RevisionAuthorHead | null } | { kind: 'task'; taskVersion: number }
  | { kind: 'wiki'; publicationRevision: number; headVersionId: string; headVersion: number; publishedVersionId: string; publishedVersion: number }
  | { kind: 'paste'; pasteVersion: number; contentVersion: number; contentHash: string };
export interface NotificationEvent { format: 'phabricator.notification-event.v2'; id: string; objectId: string; kind: NotificationKind; cause: { type: string; id: string }; actor: RevisionAuthor | null; createdAt: string; context: NotificationContext }
export interface LegacyNotificationEvent { id: string; revisionId: string; kind: NotificationKind; cause: { type: string; id: string }; actor: RevisionAuthor | null; createdAt: string; head: RevisionAuthorHead | null }
export interface NotificationItem { id: string; event: NotificationEvent; object: { id: string; title: string; kind: 'task' | 'code' | 'paper' | 'document' | 'wiki' | 'paste' }; read: boolean; version: number }
export interface NotificationSummary { principalId: string; horizon: string; unreadCount: number; readVersion: number; accessEpoch: number }
export interface NotificationInbox extends NotificationSummary { items: NotificationItem[]; nextBefore: string | null }
export interface NotificationQuery { filter?: 'all' | 'unread' | 'read'; before?: string; limit?: number }
export type NotificationInput = { action: 'read' | 'unread'; notificationId: string; expectedVersion: number; expectedAccessEpoch: number } | { action: 'read_through'; horizon: string; expectedAccessEpoch: number } | { action: 'read_object'; revisionId: string; horizon: string; expectedAccessEpoch: number } | { action: 'read_object'; objectId: string; horizon: string; expectedAccessEpoch: number };
export interface NotificationReceipt { operationId: string; inputSha256: string; changed: boolean; accessEpoch: number }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).length === allowed.length && Object.keys(v).every(k => allowed.includes(k));
const natural = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const token = (v: unknown): v is string => typeof v === 'string' && v.length >= 32 && v.length <= 2048 && /^[A-Za-z0-9_-]+$/.test(v);
export function isNotificationObjectId(value: unknown): value is string { return isRevisionId(value) || typeof value === 'string' && /^(?:T|W|PA)[1-9]\d{0,14}$/.test(value); }
export function notificationReadObjectId(input: Extract<NotificationInput, { action: 'read_object' }>): string { return 'objectId' in input ? input.objectId : input.revisionId; }
export function notificationInput(value: unknown): NotificationInput {
  if (!object(value) || !natural(value.expectedAccessEpoch)) throw new Error('Provide the inspected notification and access epoch.');
  if (value.action === 'read' || value.action === 'unread') {
    if (!keys(value, ['action', 'notificationId', 'expectedVersion', 'expectedAccessEpoch']) || !uuid(value.notificationId) || !natural(value.expectedVersion)) throw new Error('Provide the inspected notification and read version.');
    return { action: value.action, notificationId: value.notificationId, expectedVersion: value.expectedVersion, expectedAccessEpoch: value.expectedAccessEpoch };
  }
  if (value.action === 'read_through' && keys(value, ['action', 'horizon', 'expectedAccessEpoch']) && token(value.horizon)) return { action: value.action, horizon: value.horizon, expectedAccessEpoch: value.expectedAccessEpoch };
  if (value.action === 'read_object' && keys(value, ['action', 'revisionId', 'horizon', 'expectedAccessEpoch']) && isRevisionId(value.revisionId) && token(value.horizon)) return { action: value.action, revisionId: value.revisionId, horizon: value.horizon, expectedAccessEpoch: value.expectedAccessEpoch };
  if (value.action === 'read_object' && keys(value, ['action', 'objectId', 'horizon', 'expectedAccessEpoch']) && isNotificationObjectId(value.objectId) && token(value.horizon)) return { action: value.action, objectId: value.objectId, horizon: value.horizon, expectedAccessEpoch: value.expectedAccessEpoch };
  throw new Error('Choose a notification read action and its inspected boundary.');
}
export function notificationQuery(value: unknown): Required<Pick<NotificationQuery, 'filter' | 'limit'>> & Pick<NotificationQuery, 'before'> {
  if (!object(value) || Object.keys(value).some(k => !['filter', 'limit', 'before'].includes(k))) throw new Error('Choose valid notification filters.');
  const filter = value.filter ?? 'all', limit = value.limit ?? 25;
  if (!['all', 'unread', 'read'].includes(String(filter)) || !natural(limit) || limit < 1 || limit > NOTIFICATION_LIMITS.page || value.before !== undefined && !token(value.before)) throw new Error('Choose valid notification pagination.');
  return { filter: filter as 'all' | 'unread' | 'read', limit, ...(value.before === undefined ? {} : { before: value.before as string }) };
}
function eventFields(v: Record<string, unknown>): boolean {
  return uuid(v.id) && NOTIFICATION_KINDS.includes(v.kind as NotificationKind) && object(v.cause) && keys(v.cause, ['type', 'id']) && typeof v.cause.type === 'string' && /^[a-z_]{1,40}$/.test(v.cause.type) && typeof v.cause.id === 'string' && v.cause.id.length > 0 && v.cause.id.length <= 240 && !v.cause.id.includes('\0') && (v.actor === null || isRevisionAuthor(v.actor)) && typeof v.createdAt === 'string' && Number.isFinite(Date.parse(v.createdAt));
}
export function isNotificationEvent(v: unknown): v is NotificationEvent {
  if (!object(v) || !keys(v, ['format', 'id', 'objectId', 'kind', 'cause', 'actor', 'createdAt', 'context']) || v.format !== 'phabricator.notification-event.v2' || !eventFields(v) || !object(v.context)) return false;
  return v.context.kind === 'revision' && keys(v.context, ['kind', 'head']) && isRevisionId(v.objectId) && REVISION_NOTIFICATION_KINDS.includes(v.kind as typeof REVISION_NOTIFICATION_KINDS[number]) && (v.context.head === null || isRevisionAuthorHead(v.context.head))
    || v.context.kind === 'task' && keys(v.context, ['kind', 'taskVersion']) && typeof v.objectId === 'string' && /^T[1-9]\d{0,14}$/.test(v.objectId) && TASK_NOTIFICATION_KINDS.includes(v.kind as typeof TASK_NOTIFICATION_KINDS[number]) && natural(v.context.taskVersion) && v.context.taskVersion > 0
    || v.context.kind === 'wiki' && keys(v.context, ['kind', 'publicationRevision', 'headVersionId', 'headVersion', 'publishedVersionId', 'publishedVersion']) && typeof v.objectId === 'string' && /^W[1-9]\d{0,14}$/.test(v.objectId) && WIKI_NOTIFICATION_KINDS.includes(v.kind as typeof WIKI_NOTIFICATION_KINDS[number]) && natural(v.context.publicationRevision) && natural(v.context.headVersion) && natural(v.context.publishedVersion) && v.context.publishedVersion > 0 && v.context.headVersion >= v.context.publishedVersion && v.context.publicationRevision >= v.context.headVersion && uuid(v.context.headVersionId) && uuid(v.context.publishedVersionId) && (v.context.headVersion === v.context.publishedVersion) === (v.context.headVersionId === v.context.publishedVersionId)
    || v.context.kind === 'paste' && keys(v.context, ['kind', 'pasteVersion', 'contentVersion', 'contentHash']) && typeof v.objectId === 'string' && /^PA[1-9]\d{0,14}$/.test(v.objectId) && PASTE_NOTIFICATION_KINDS.includes(v.kind as typeof PASTE_NOTIFICATION_KINDS[number]) && natural(v.context.pasteVersion) && natural(v.context.contentVersion) && v.context.contentVersion > 0 && v.context.pasteVersion >= v.context.contentVersion && typeof v.context.contentHash === 'string' && /^[a-f0-9]{64}$/.test(v.context.contentHash);
}
/** Read projection only: never rewrite legacy event evidence or request bodies. */
export function notificationEvent(v: unknown): NotificationEvent | null {
  if (isNotificationEvent(v)) return v;
  if (!object(v) || !keys(v, ['id', 'revisionId', 'kind', 'cause', 'actor', 'createdAt', 'head']) || !eventFields(v) || !isRevisionId(v.revisionId) || !REVISION_NOTIFICATION_KINDS.includes(v.kind as typeof REVISION_NOTIFICATION_KINDS[number]) || !(v.head === null || isRevisionAuthorHead(v.head))) return null;
  const legacy = v as unknown as LegacyNotificationEvent;
  return { format: 'phabricator.notification-event.v2', id: legacy.id, objectId: legacy.revisionId, kind: legacy.kind, cause: legacy.cause, actor: legacy.actor, createdAt: legacy.createdAt, context: { kind: 'revision', head: legacy.head } };
}
export function isNotificationItem(v: unknown): v is NotificationItem {
  return object(v) && keys(v, ['id', 'event', 'object', 'read', 'version']) && uuid(v.id) && isNotificationEvent(v.event) && object(v.object) && keys(v.object, ['id', 'title', 'kind']) && v.object.id === v.event.objectId && typeof v.object.title === 'string' && v.object.title.length <= 1000 && !v.object.title.includes('\0') && (v.event.context.kind === 'revision' ? ['code', 'paper', 'document'].includes(String(v.object.kind)) : v.object.kind === v.event.context.kind) && typeof v.read === 'boolean' && natural(v.version) && (v.version !== 0 || v.read === false);
}
/** Upgrade a validated schema31 offline item without changing its identity. */
export function notificationItem(v: unknown): NotificationItem | null {
  if (isNotificationItem(v)) return v;
  if (!object(v) || !keys(v, ['id', 'event', 'revision', 'read', 'version']) || !object(v.event) || 'format' in v.event) return null;
  const event = notificationEvent(v.event);
  const result = { id: v.id, event, object: v.revision, read: v.read, version: v.version };
  return isNotificationItem(result) ? result : null;
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
