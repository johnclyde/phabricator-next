import { isNotificationInbox, isNotificationItem, isNotificationObjectId, isNotificationSummary, notificationInput, notificationItem, notificationReadObjectId, validNotificationResult, type NotificationInbox, type NotificationInput, type NotificationItem, type NotificationKind, type NotificationReceipt, type NotificationSummary } from '../shared/notifications';

export type NotificationFilter = 'all' | 'unread' | 'read';
export interface NotificationPage extends NotificationInbox { filter: NotificationFilter }
export interface NotificationCache { summary: NotificationSummary; pages: NotificationPage[] }
export type NotificationIntent = { id: string; principalId: string; body: NotificationInput } & ({ objectId: string | null } | { revisionId: string | null });
export const notificationIntentObjectId = (intent: NotificationIntent): string | null => 'objectId' in intent ? intent.objectId : intent.revisionId;
export const NOTIFICATION_CACHE_LIMIT = 500;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
export const notificationSummary = ({ principalId, horizon, unreadCount, readVersion, accessEpoch }: NotificationSummary): NotificationSummary => ({ principalId, horizon, unreadCount, readVersion, accessEpoch });
export function notificationPage(value: unknown, principalId: string): value is NotificationPage {
  if (!record(value) || !['all', 'unread', 'read'].includes(String(value.filter)) || !Array.isArray(value.items) || value.items.length > NOTIFICATION_CACHE_LIMIT) return false;
  const { filter, ...page } = value;
  if (!isNotificationInbox({ ...page, items: [] }, principalId) || !value.items.every(isNotificationItem)) return false;
  const items = value.items as NotificationItem[];
  return new Set(items.map(item => item.id)).size === items.length && new Set(items.map(item => item.event.id)).size === items.length && items.every(item => filter === 'all' || item.read === (filter === 'read'));
}
export function notificationCache(value: unknown, principalId: string): NotificationCache | null {
  if (!record(value) || Object.keys(value).length !== 2 || !isNotificationSummary(value.summary, principalId) || !Array.isArray(value.pages) || value.pages.length > 3) return null;
  // Schema31 reading snapshots are projected without rewriting their immutable
  // event identities. Submitted requests take a separate, exact-preserving path.
  const pages: NotificationPage[] = [];
  for (const page of value.pages) {
    if (!record(page) || !Array.isArray(page.items)) return null;
    const projected = { ...page, items: page.items.map(notificationItem) };
    if (!notificationPage(projected, principalId)) return null;
    pages.push(projected);
  }
  const summary = value.summary;
  return new Set(pages.map(page => page.filter)).size === pages.length && pages.every(page => page.accessEpoch === summary.accessEpoch && page.readVersion === summary.readVersion) ? { summary, pages } : null;
}
export function mergeNotifications(previous: NotificationPage, next: NotificationPage): NotificationPage {
  if (!notificationPage(previous, previous.principalId) || !notificationPage(next, previous.principalId) || previous.filter !== next.filter || previous.nextBefore === null || previous.nextBefore === next.nextBefore || previous.readVersion !== next.readVersion || previous.accessEpoch !== next.accessEpoch || previous.items.length + next.items.length > NOTIFICATION_CACHE_LIMIT || next.items.some(item => previous.items.some(old => old.id === item.id || old.event.id === item.event.id))) throw new Error('Notifications changed. Reload this inbox before loading more.');
  // Opaque encrypted boundary tokens may change bytes while naming the same
  // server-validated horizon. Delivery order is independent of actor timestamps.
  return { ...next, horizon: previous.horizon, items: [...previous.items, ...next.items] };
}
export function notificationIntent(value: unknown, principalId: string): NotificationIntent | null {
  if (!record(value) || Object.keys(value).length !== 4 || !uuid(value.id) || value.principalId !== principalId || ('objectId' in value) === ('revisionId' in value)) return null;
  const legacy = 'revisionId' in value, objectId = legacy ? value.revisionId : value.objectId;
  if (!(objectId === null || isNotificationObjectId(objectId) && (!legacy || /^[DPL]\d+$/.test(objectId)))) return null;
  try { const body = notificationInput(value.body); if (body.action === 'read_object' && notificationReadObjectId(body) !== objectId || body.action === 'read_through' && objectId !== null) return null; return { id: value.id, principalId, body, ...(legacy ? { revisionId: objectId } : { objectId }) }; } catch { return null; }
}
export async function verifiedNotificationReceipt(value: unknown, intent: NotificationIntent): Promise<NotificationReceipt> {
  if (!validNotificationResult(value)) throw new Error('The notification receipt is invalid. Retain this exact request for recovery.');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(notificationInput(intent.body))))), byte => byte.toString(16).padStart(2, '0')).join('');
  if (value.inputSha256 !== hash) throw new Error('The receipt belongs to a different notification request. Retry the original request.');
  return value;
}
export function notificationLabel(kind: NotificationKind, objectKind?: NotificationItem['object']['kind']): string { return ({ suite_created: 'created this object', suite_updated: 'updated this object', suite_commented: 'commented', suite_message: 'sent a message', suite_published: 'published this post', suite_signature: 'updated agreement signing', suite_vote: 'updated a ballot', created: `created this ${objectKind === 'task' ? 'task' : objectKind === 'wiki' ? 'document' : objectKind === 'paste' ? 'paste' : 'revision'}`, wiki_updated: 'updated this document', wiki_title_changed: 'changed the document title', wiki_published: 'published document content', wiki_deleted: 'deleted this document', wiki_restored: 'restored this document', wiki_policy_changed: 'changed document access', wiki_subscribers_changed: 'changed document followers', paste_updated: 'updated this paste', paste_commented: 'commented on this paste', paste_archived: 'archived this paste', paste_reactivated: 'reactivated this paste', paste_subscribers_changed: 'changed paste followers', task_updated: 'updated this task', task_commented: 'commented', task_owner_changed: 'changed the task owner', task_projects_changed: 'changed project tags', task_subscribers_changed: 'changed followers', task_dependencies_changed: 'changed task dependencies', task_subtask_status_changed: 'updated a subtask status', task_merged: 'merged duplicate tasks', task_column_changed: 'moved this task on a workboard', source_updated: 'updated the source', commented: 'commented', replied: 'replied to a discussion', suggestion_applied: 'applied a suggestion', review_completed: 'completed a review', reviewers_changed: 'updated reviewers', lifecycle_changed: 'changed review status', author_changed: 'changed the current author', metadata_changed: 'edited revision details', projects_changed: 'changed project tags', subscribers_changed: 'changed followers' })[kind]; }

export function notificationContextLabel(item: NotificationItem): string | null {
  const context = item.event.context;
  if (context.kind === 'suite') return `${context.app[0]!.toUpperCase()}${context.app.slice(1)} · Version ${context.version}`;
  if (context.kind === 'task') return `Task version ${context.taskVersion}`;
  if (context.kind === 'wiki') return `Published v${context.publishedVersion} · Latest content v${context.headVersion}`;
  if (context.kind === 'paste') return `Content v${context.contentVersion} · Paste version ${context.pasteVersion}`;
  return context.head ? `Source v${context.head.number}` : null;
}

export function notificationLink(item: NotificationItem): string { return item.event.context.kind === 'suite' ? `#${item.event.context.app}/${item.object.id}` : `#${item.object.id}`; }
