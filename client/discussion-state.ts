import type { DiscussionPreferences, ThreadPreference } from '../shared/discussion';
export interface DiscussionChoice { revisionId: string; threadId: string; collapsed: boolean; expectedVersion: number | null; requestId: string; attempted: boolean }
export function discussionChoice(value: unknown, revisionId: string, threadId: string): DiscussionChoice | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as DiscussionChoice;
  if (item.revisionId !== revisionId || item.threadId !== threadId || typeof item.collapsed !== 'boolean' || (item.expectedVersion !== null && (!Number.isSafeInteger(item.expectedVersion) || item.expectedVersion < 0)) || typeof item.requestId !== 'string' || !item.requestId || typeof item.attempted !== 'boolean') return null;
  return { revisionId, threadId, collapsed: item.collapsed, expectedVersion: item.expectedVersion, requestId: item.requestId, attempted: item.attempted };
}
export function discussionPreferences(value: unknown, revisionId: string): DiscussionPreferences | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as DiscussionPreferences;
  if (data.revisionId !== revisionId || !Array.isArray(data.preferences) || !Number.isSafeInteger(data.accessEpoch) || Number(data.accessEpoch) < 0) return null;
  const seen = new Set<string>(); const preferences: ThreadPreference[] = [];
  for (const item of data.preferences) {
    if (!item || item.revisionId !== revisionId || typeof item.threadId !== 'string' || !item.threadId || seen.has(item.threadId) || typeof item.collapsed !== 'boolean' || !Number.isSafeInteger(item.version) || item.version < 0 || (item.updatedAt !== null && typeof item.updatedAt !== 'string')) return null;
    seen.add(item.threadId); preferences.push({ revisionId, threadId: item.threadId, collapsed: item.collapsed, version: item.version, updatedAt: item.updatedAt });
  }
  return { revisionId, preferences, accessEpoch: data.accessEpoch };
}
export function choiceMatches(left: DiscussionChoice | null | undefined, right: DiscussionChoice): boolean { return Boolean(left && left.revisionId === right.revisionId && left.threadId === right.threadId && left.collapsed === right.collapsed && left.expectedVersion === right.expectedVersion && left.requestId === right.requestId); }
