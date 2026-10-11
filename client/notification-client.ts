import { isNotificationInbox, isNotificationItem, isNotificationSummary, notificationInput, validNotificationResult, type NotificationInbox, type NotificationInput, type NotificationItem, type NotificationKind, type NotificationReceipt, type NotificationSummary } from '../shared/notifications';

export type NotificationFilter = 'all' | 'unread' | 'read';
export interface NotificationPage extends NotificationInbox { filter: NotificationFilter }
export interface NotificationCache { summary: NotificationSummary; pages: NotificationPage[] }
export interface NotificationIntent { id: string; principalId: string; body: NotificationInput; revisionId: string | null }
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
  if (!record(value) || Object.keys(value).length !== 2 || !isNotificationSummary(value.summary, principalId) || !Array.isArray(value.pages) || value.pages.length > 3 || !value.pages.every(page => notificationPage(page, principalId))) return null;
  const pages = value.pages as NotificationPage[], summary = value.summary;
  return new Set(pages.map(page => page.filter)).size === pages.length && pages.every(page => page.accessEpoch === summary.accessEpoch && page.readVersion === summary.readVersion) ? { summary, pages } : null;
}
export function mergeNotifications(previous: NotificationPage, next: NotificationPage): NotificationPage {
  if (!notificationPage(previous, previous.principalId) || !notificationPage(next, previous.principalId) || previous.filter !== next.filter || previous.nextBefore === null || previous.nextBefore === next.nextBefore || previous.readVersion !== next.readVersion || previous.accessEpoch !== next.accessEpoch || previous.items.length + next.items.length > NOTIFICATION_CACHE_LIMIT || next.items.some(item => previous.items.some(old => old.id === item.id || old.event.id === item.event.id))) throw new Error('Notifications changed. Reload this inbox before loading more.');
  // Opaque encrypted boundary tokens may change bytes while naming the same
  // server-validated horizon. Delivery order is independent of actor timestamps.
  return { ...next, horizon: previous.horizon, items: [...previous.items, ...next.items] };
}
export function notificationIntent(value: unknown, principalId: string): NotificationIntent | null {
  if (!record(value) || Object.keys(value).length !== 4 || !uuid(value.id) || value.principalId !== principalId || !(value.revisionId === null || typeof value.revisionId === 'string' && /^[DPL]\d+$/.test(value.revisionId))) return null;
  try { const body = notificationInput(value.body); return body.action === 'read_object' && body.revisionId !== value.revisionId || body.action === 'read_through' && value.revisionId !== null ? null : { id: value.id, principalId, body, revisionId: value.revisionId }; } catch { return null; }
}
export async function verifiedNotificationReceipt(value: unknown, intent: NotificationIntent): Promise<NotificationReceipt> {
  if (!validNotificationResult(value)) throw new Error('The notification receipt is invalid. Retain this exact request for recovery.');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(notificationInput(intent.body))))), byte => byte.toString(16).padStart(2, '0')).join('');
  if (value.inputSha256 !== hash) throw new Error('The receipt belongs to a different notification request. Retry the original request.');
  return value;
}
export function notificationLabel(kind: NotificationKind): string { return ({ created: 'created this revision', source_updated: 'updated the source', commented: 'commented', replied: 'replied to a discussion', suggestion_applied: 'applied a suggestion', review_completed: 'completed a review', reviewers_changed: 'updated reviewers', lifecycle_changed: 'changed review status', author_changed: 'changed the current author', metadata_changed: 'edited revision details', projects_changed: 'changed project tags', subscribers_changed: 'changed followers' })[kind]; }
