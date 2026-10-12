import { isReviewDraftSnapshot } from '../shared/review-drafts';
import { intentValue as reviewDraftIntent, editValue as reviewDraftEdit } from './review-draft-model';
import { subscriptionAuthority as objectSubscriptionAuthority, subscriptionReading as objectSubscriptionReading } from './object-subscriptions';
import { taskMuteReading } from './task-notifications';
import { projectTagReading } from './revision-projects';
import { notificationCache, notificationIntent, notificationIntentObjectId } from './notification-client';
import { subscriptionAuthority, subscriptionReading } from './revision-subscriptions';
import { metadataReading } from './revision-metadata';
import { reviewerAuthority, reviewerReading } from './revision-reviewers';
import { lifecycleReading } from './revision-lifecycle';
import { authorDraft, authorReading, verifiedAuthorResult } from './revision-authorship';
import { dependencySnapshot } from './revision-dependencies';
import { isRevisionStack } from '../shared/revision-stack';
import { canonicalWikiPath } from '../shared/wiki';
import type { WikiAuthority } from './wiki-client';
import { comparisonMetadata, isComparisonSelection } from './comparison-model';
import { docxComparisonMetadata, isDocxComparisonSelection } from './docx-comparison-model';
import { findingSelectionMetadata, isFindingSelection } from './finding-navigation-model';
import { repositorySelection } from './repository-cache';
import type { BulkMoveWorkboardCardsInput } from '../shared/workboards';
import type { ObjectAccess } from '../shared/policy';
import { applicationPath, storageKey } from './mount';
import { assertSession, currentSession, lockSession, RequestError, sessionIsActive, type WorkspaceSession, type QuarantinedDraft } from './session';
export { RequestError } from './session';

interface RevisionStackLifetime {
  generation: number;
  listeners: Set<() => void>;
  controllers: Set<AbortController>;
  metadata: Map<string, string> | null;
}
const revisionStackLifetimes = new WeakMap<WorkspaceSession, RevisionStackLifetime>();
interface NotificationLifetime { generation: number; listeners: Set<() => void>; controllers: Set<AbortController> }
const notificationLifetimes = new WeakMap<WorkspaceSession, NotificationLifetime>();
// Informational responses can advance the observed epoch without supplying the
// workspace's visibility and capability snapshot needed by a subsequent write.
const verifiedAuthorityEpochs = new WeakMap<WorkspaceSession, number>();
interface DraftRetention { baseline: string | null; latest: string; generation: number }
const draftRetentions = new WeakMap<WorkspaceSession, Map<string, DraftRetention>>();
// Only a successful cleanup by this session permits an already mounted editor
// to start over from an absent durable slot. Another tab deleting a draft does not.
const clearedDraftBaselines = new WeakMap<WorkspaceSession, Map<string, string>>();
function notificationLifetime(session: WorkspaceSession | null): NotificationLifetime | null {
  if (!session) return null;
  let lifetime = notificationLifetimes.get(session);
  if (!lifetime) {
    lifetime = { generation: 0, listeners: new Set(), controllers: new Set() }; notificationLifetimes.set(session, lifetime);
    const retained = lifetime;
    session.cleanupCallbacks.add(() => { retained.generation++; for (const controller of retained.controllers) controller.abort(); retained.controllers.clear(); retained.listeners.clear(); notificationLifetimes.delete(session); });
  }
  return lifetime;
}
function stackLifetime(session: WorkspaceSession | null): RevisionStackLifetime | null {
  if (!session) return null;
  let lifetime = revisionStackLifetimes.get(session);
  if (!lifetime) {
    lifetime = { generation: 0, listeners: new Set(), controllers: new Set(), metadata: null };
    revisionStackLifetimes.set(session, lifetime);
    const retained = lifetime;
    session.cleanupCallbacks.add(() => { retained.generation++; for (const controller of retained.controllers) controller.abort(); retained.controllers.clear(); retained.listeners.clear(); retained.metadata = null; revisionStackLifetimes.delete(session); });
  }
  return lifetime;
}
function revisionStackMetadata(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const revision = value as Record<string, unknown>;
  return typeof revision.id === 'string' ? JSON.stringify([revision.title, revision.kind, revision.status, revision.currentVersion, revision.updatedAt, revision.authorVersion ?? 0, revision.lifecycleVersion ?? 0]) : null;
}

export type MutationMethod = 'POST' | 'PATCH' | 'PUT';
export interface SubmittedBulkMove { projectId: string; sourceProxyId: string | null; requestId: string; input: BulkMoveWorkboardCardsInput }
export interface PendingMutation { id: string; path: string; method: MutationMethod; body: unknown; label: string; createdAt: string; error?: string; wikiAuthority?: WikiAuthority }
export function canQueue(path: string, method: MutationMethod, body?: unknown): boolean {
  if (path === '/api/documents' && method === 'POST') { try { return Boolean(body && typeof body === 'object' && 'slug' in body && typeof body.slug === 'string' && canonicalWikiPath(body.slug) === body.slug && 'expectedAccessEpoch' in body && Number.isSafeInteger(body.expectedAccessEpoch) && Number(body.expectedAccessEpoch) >= 0); } catch { return false; } }
  if (/^\/api\/revisions\/[^/]+\/versions$/.test(path) && body && typeof body === 'object' && ['assets', 'shareAssets', 'expectedAccessEpoch'].some(key => key in body)) return false;
  if (path === '/api/projects' && method === 'POST') {
    if (!body || typeof body !== 'object') return false;
    const input = body as { memberIds?: unknown; access?: unknown; parentId?: unknown; kind?: unknown };
    if (input.parentId != null || (input.kind !== undefined && input.kind !== 'project') || ['expectedParentVersion', 'expectedHierarchyVersion', 'expectedParentMembersVersion', 'confirmMembershipConversion'].some(key => key in input)) return false;
    return (input.memberIds === undefined || (Array.isArray(input.memberIds) && input.memberIds.length === 0)) && (input.access === undefined || Boolean(input.access && typeof input.access === 'object' && Object.keys(input.access).every(key => key === 'spaceId')));
  }
  if (/^\/api\/projects\/PROJ\d+$/.test(path) && method === 'PATCH') return Boolean(body && typeof body === 'object' && 'expectedVersion' in body && Number.isSafeInteger(body.expectedVersion) && Number(body.expectedVersion) > 0 && Object.keys(body).every(key => ['expectedVersion', 'name', 'description', 'status', 'color', 'colorKey', 'icon', 'aliases'].includes(key)));
  if ((path === '/api/tasks' || /^\/api\/tasks\/T\d+$/.test(path)) && body && typeof body === 'object' && 'ownerId' in body && (method === 'PATCH' || body.ownerId !== null)) return false;
  return (path === '/api/tasks' && method === 'POST') || (/^\/api\/tasks\/[^/]+\/(comments|projects)$/.test(path) && method === 'POST') || (/^\/api\/tasks\/[^/]+$/.test(path) && method === 'PATCH') || (path === '/api/documents' && method === 'POST') || (/^\/api\/documents\/[^/]+$/.test(path) && method === 'PUT') || (/^\/api\/revisions\/[^/]+\/(comments|versions)$/.test(path) && method === 'POST') || (/^\/api\/revisions\/[^/]+\/threads\/[^/]+\/replies$/.test(path) && method === 'POST');
}
export function isNetworkError(error: unknown): boolean { return error instanceof TypeError; }
function objectFromPath(path: string): string | null { return /^\/api\/(?:objects|pastes|files|revisions|documents|tasks|projects|repositories|policies|spaces)\/([A-Z]+\d+)(?:[/?]|$)/.exec(path)?.[1] || null; }
function queuedObject(item: PendingMutation): string | null {
  const id = objectFromPath(item.path); if (id) return id;
  if (item.method !== 'POST' || !['/api/tasks', '/api/documents', '/api/projects'].includes(item.path)) return null;
  const body = item.body as { parentId?: unknown; access?: { spaceId?: unknown } } | null;
  if (item.path === '/api/projects' && typeof body?.parentId === 'string') return body.parentId;
  return body?.access && typeof body.access.spaceId === 'string' ? body.access.spaceId : 'S1';
}
function objectFromKey(key: string): string | null { return /^(?:object-subscriptions|object-subscription-draft|object-subscription-request|task-mute|task-mute-draft|task-mute-request|revision-projects|revision-project-draft|revision-project-request|revision-subscriptions|revision-subscription-draft|revision-subscription-request|revision-metadata|revision-metadata-draft|revision-metadata-request|revision-reviewers|revision-reviewer-draft|revision-reviewer-request|revision-lifecycle|revision-lifecycle-draft|revision-lifecycle-request|revision-authorship|revision-author-draft|revision-author-request|revision-stack|revision-dependencies|revision-dependency-draft|revision-dependency-request|wiki-move|wiki-request|wiki-edit|wiki-action|wiki-action-request|review-draft-edit|review-draft-summary|review-draft-request|transcript-edit-draft|transcript-edit-request|docx-draft|docx-request|docx-selection|docx-comparison|paste|paste-version|paste-selection|paste-history|paste-draft|paste-comment|paste-request|paste-create|citation-draft|file|file-draft|repository|repository-import|revision-git-import|review-drafts|revision-source|revision|revision-comparison|review-findings|discussion-preferences|discussion-choice|wiki|task|project|workboard|workboard-move|project-draft|project-child|task-draft|task-comment|task-projects|version-draft|comment-source):([A-Z]+\d+)(?:[:]|$)/.exec(key)?.[1] || /^draft:document:([A-Z]+\d+):/.exec(key)?.[1] || null; }
function isDraftKey(key: string): boolean { return /^(?:object-subscription-draft|object-subscription-request|task-mute-draft|task-mute-request):/.test(key) || key.startsWith('notification-request:') || /^(?:revision-project-draft|revision-project-request|revision-subscription-draft|revision-subscription-request|revision-metadata-draft|revision-metadata-request|revision-reviewer-draft|revision-reviewer-request|revision-lifecycle-draft|revision-lifecycle-request|revision-author-draft|revision-author-request|revision-dependency-draft|revision-dependency-request|wiki-move|wiki-request|wiki-edit|wiki-action|wiki-action-request|review-draft-edit|review-draft-summary|review-draft-request|transcript-edit-draft|transcript-edit-request|docx-draft|docx-request|paste-draft|paste-comment|paste-request|paste-create):/.test(key) || key.startsWith('citation-draft:') || key === 'file-uploads' || key.startsWith('file-draft:') || (key.startsWith('repository-import:') || key.startsWith('revision-git-import:')) || key.startsWith('draft:') || key.startsWith('version-draft:') || key.startsWith('comment-source:') || key.startsWith('task-draft:') || key.startsWith('task-comment:') || key.startsWith('task-projects:') || (key.startsWith('project-draft:') || key.startsWith('project-child:')) || key.startsWith('workboard-move:'); }
// Personal presentation choices retain quota-failed memory, but are purged on view loss rather than treated as content drafts.
function isRetainedDraftKey(key: string): boolean { return /^(?:object-subscription-draft|object-subscription-request|task-mute-draft|task-mute-request):/.test(key) || key.startsWith('notification-request:') || key.startsWith('draft:') || /^(?:revision-project-draft|revision-project-request|revision-subscription-draft|revision-subscription-request|revision-metadata-draft|revision-metadata-request|revision-reviewer-draft|revision-reviewer-request|revision-lifecycle-draft|revision-lifecycle-request|revision-author-draft|revision-author-request|revision-dependency-draft|revision-dependency-request|wiki-move|wiki-request|wiki-edit|wiki-action|wiki-action-request|review-draft-edit|review-draft-summary|review-draft-request|transcript-edit-draft|transcript-edit-request|docx-draft|docx-request|paste-draft|paste-comment|paste-request|paste-create):/.test(key) || key.startsWith('citation-draft:') || key === 'file-uploads' || key === 'file-uploads:unsaved-memory' || key.startsWith('file-draft:') || key.startsWith('discussion-choice:') || key.startsWith('version-draft:') || key.startsWith('comment-source:') || (key.startsWith('repository-import:') || key.startsWith('revision-git-import:')) || key.startsWith('task-draft:') || key.startsWith('task-comment:') || key.startsWith('task-projects:') || (key.startsWith('project-draft:') || key.startsWith('project-child:')) || key.startsWith('workboard-move:'); }
/** One lock for each scalar editor and its exact-value cleanup. Collections own their merge locks. */
export function retainedDraftLockName(key: string): string | null {
  const base = key.replace(/:unsaved-memory$/, '');
  if (base.startsWith('discussion-choice:')) return `presentation-write:${base}`;
  if (!isDraftKey(base) || base === 'file-uploads') return null;
  return `${base.startsWith('transcript-edit-draft:') ? 'transcript-draft' : 'file-intent'}:${base}`;
}
function hasSavedWork(key: string, value: unknown): boolean { return !(key.startsWith('comment-source:') || key.startsWith('task-comment:')) || Boolean(value && typeof value === 'object' && (('body' in value && typeof value.body === 'string' && value.body.trim()) || ('suggestion' in value && value.suggestion))); }
function hasProjectHierarchy(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const project = value as Record<string, unknown>;
  return (project.kind === 'project' || project.kind === 'milestone') && (project.parentId === null || typeof project.parentId === 'string') && typeof project.displayName === 'string' && Number.isSafeInteger(project.hierarchyVersion) && ['direct', 'descendants', 'inherited'].includes(String(project.membershipMode));
}
function currentProjectCache(key: string, value: unknown): boolean {
  if (!value || typeof value !== 'object') return true;
  const data = value as Record<string, unknown>;
  if (key === 'state' && Array.isArray(data.projects)) return data.projects.every(hasProjectHierarchy);
  if (!key.startsWith('project:')) return true;
  if (data.project && (!hasProjectHierarchy(data.project) || !data.hierarchy)) return false;
  if (data.viewer && typeof data.viewer === 'object') {
    const viewer = data.viewer as Record<string, unknown>;
    return Array.isArray(viewer.watchingInheritedFrom) && typeof viewer.effectiveWatching === 'boolean' && Boolean(viewer.membership && typeof viewer.membership === 'object' && 'source' in viewer.membership);
  }
  return true;
}
function docxSnapshot(key: string, value: unknown): boolean { return key.startsWith('revision:') && Boolean(value && typeof value === 'object' && 'versions' in value && Array.isArray(value.versions) && value.versions.some((version: unknown) => version && typeof version === 'object' && 'docx' in version)); }
function currentWikiSearchCache(key: string, value: unknown): boolean { return !key.startsWith('wiki-search:') || Boolean(value && typeof value === 'object' && 'accessEpoch' in value && Number.isSafeInteger(value.accessEpoch) && Number(value.accessEpoch) >= 0 && 'documents' in value && Array.isArray(value.documents)); }
function unavailable(): RequestError { return new RequestError('This object is unavailable or you no longer have access. Unsaved drafts have been set aside for export.', 404, 'OBJECT_UNAVAILABLE'); }


/** Every method captures one session. Old component callbacks cannot access a new account's data. */
export function createWorkspaceClient(session: WorkspaceSession | null = currentSession()) {
  const durable = session?.state.mode === 'local';
  const stacks = stackLifetime(session);
  const notifications = notificationLifetime(session);
  let prefix = '';
  if (durable && session) {
    const bindingKey = storageKey('local-storage-workspace');
    try {
      let bound = localStorage.getItem(bindingKey);
      if (!bound) { localStorage.setItem(bindingKey, session.state.workspaceId); bound = session.state.workspaceId; }
      if (bound !== session.state.workspaceId) prefix = `workspace:${encodeURIComponent(session.state.workspaceId)}:`;
    } catch { prefix = `workspace:${encodeURIComponent(session.state.workspaceId)}:`; }
  }
  const contentKey = (key: string) => storageKey(prefix + key);
  const blockedDraft = (key: string, value?: unknown): boolean => {
    if (/^review-draft-(?:edit|summary|request):/.test(key)) {
      const target = objectFromKey(key), capabilities = target ? session?.objectCapabilities.get(target) : undefined;
      let input = value; try { input ??= JSON.parse(rawRead(key) || 'null'); } catch { /* Preserve malformed recovery bytes. */ }
      const discard = key.startsWith('review-draft-request:') && reviewDraftIntent(input, target || '', session?.state.account?.id || `local:${session?.state.workspaceId}`)?.kind === 'discard';
      return draftObjects(key, input).some(id => session?.unavailableObjects.has(id) || session?.visibleObjects != null && !session.visibleObjects.has(id)) || Boolean(capabilities && !discard && !capabilities.interact);
    }
    if (key.startsWith('notification-request:') || /^task-mute-(?:draft|request):/.test(key)) return draftObjects(key, value).some(id => session?.unavailableObjects.has(id) || session?.visibleObjects !== null && session?.visibleObjects !== undefined && !session.visibleObjects.has(id));
    if (key.startsWith('draft:document:new')) { let authority: WikiAuthority | undefined; try { authority = ((value ?? JSON.parse(rawRead(key) || 'null')) as { wikiAuthority?: WikiAuthority } | null)?.wikiAuthority; } catch { /* Preserve unreadable drafts. */ } return draftObjects(key, value).some(id => session?.unavailableObjects.has(id) || (session?.visibleObjects && !session.visibleObjects.has(id))) || Boolean(authority?.parentId && session?.objectCapabilities.get(authority.parentId)?.edit === false); }
    if (/^wiki-(?:move|request|edit|action|action-request):/.test(key)) { const ids = draftObjects(key, value), target = objectFromKey(key); let edits: string[] = []; try { edits = ((value ?? JSON.parse(rawRead(key) || 'null')) as { editIds?: string[] } | null)?.editIds || []; } catch { /* Keep unreadable recovery. */ } return ids.some(id => session?.unavailableObjects.has(id) || (session?.visibleObjects && !session.visibleObjects.has(id))) || [target, ...edits].some(id => id && session?.objectCapabilities.get(id)?.edit === false); }
    if (/^object-subscription-(?:draft|request):/.test(key)) {
      const target = objectFromKey(key); let input = value;
      try { input ??= JSON.parse(rawRead(key) || 'null'); } catch { /* Preserve unreadable recovery. */ }
      const authority = objectSubscriptionAuthority(input, session?.state.account?.id || `local:${session?.state.workspaceId}`), capabilities = target ? session?.objectCapabilities.get(target) : undefined;
      return draftObjects(key, value).some(id => session?.unavailableObjects.has(id) || session?.visibleObjects != null && !session.visibleObjects.has(id)) || Boolean(capabilities && (authority === 'view' ? false : authority === 'interact_or_edit' ? !capabilities.interact && !capabilities.edit : !capabilities.edit));
    }
    if (/^revision-subscription-(?:draft|request):/.test(key)) {
      const target = objectFromKey(key); let input = value;
      try { input ??= JSON.parse(rawRead(key) || 'null'); } catch { /* Keep unreadable work for export. */ }
      const authority = subscriptionAuthority(input, session?.state.account?.id || `local:${session?.state.workspaceId}`), capabilities = target ? session?.objectCapabilities.get(target) : undefined;
      return Boolean(capabilities && (authority === 'view' ? false : authority === 'interact_or_edit' ? !capabilities.interact && !capabilities.edit : !capabilities.edit));
    }
    if (/^revision-reviewer-(?:draft|request):/.test(key)) {
      const target = objectFromKey(key); let input = value;
      try { input ??= JSON.parse(rawRead(key) || 'null'); } catch { /* Keep unreadable work for export. */ }
      const authority = reviewerAuthority(input);
      return Boolean(target && session?.objectCapabilities.get(target)?.[authority ?? 'edit'] === false);
    }
    if (/^revision-project-(?:draft|request):/.test(key) || key.startsWith('repository-import:') || key.startsWith('draft:revision:')) { const ids = draftObjects(key, value), target = objectFromKey(key); return ids.some(id => session?.unavailableObjects.has(id) || (session?.visibleObjects && !session.visibleObjects.has(id))) || Boolean(target && !key.startsWith('repository-import:') && session?.objectCapabilities.get(target)?.edit === false); }
    if (/^revision-dependency-(?:draft|request):/.test(key)) { const ids = draftObjects(key, value), target = objectFromKey(key); return ids.some(id => session?.unavailableObjects.has(id) || (session?.visibleObjects && !session.visibleObjects.has(id))) || Boolean(target && session?.objectCapabilities.get(target)?.edit === false); }
    if (/^(?:docx|transcript-edit)-(?:draft|request):/.test(key)) { const ids = draftObjects(key, value), target = objectFromKey(key); return ids.some(id => session?.unavailableObjects.has(id) || (session?.visibleObjects !== null && session?.visibleObjects !== undefined && !session.visibleObjects.has(id))) || Boolean(target && session?.objectCapabilities.get(target)?.edit === false); }
    if (key.startsWith('paste-create:')) { const space = objectFromKey(key); return Boolean(space && (session?.unavailableObjects.has(space) || (session?.visibleObjects && !session.visibleObjects.has(space)))); }
    if (key.startsWith('citation-draft:')) { const ids = draftObjects(key, value), target = objectFromKey(key); return ids.some(id => session?.unavailableObjects.has(id) || (session?.visibleObjects !== null && session?.visibleObjects !== undefined && !session.visibleObjects.has(id))) || Boolean(target && session?.objectCapabilities.get(target)?.interact === false); }
    if (key.startsWith('revision-git-import:')) {
      const ids = draftObjects(key, value); const target = objectFromKey(key);
      return ids.some(id => session?.unavailableObjects.has(id) || (session?.visibleObjects !== null && session?.visibleObjects !== undefined && !session.visibleObjects.has(id))) || Boolean(target && session?.objectCapabilities.get(target)?.edit === false);
    }
    if (key.startsWith('workboard-move:')) {
      const taskId = /^workboard-move:PROJ\d+:(T\d+)/.exec(key)?.[1];
      const ids = draftObjects(key, value);
      return ids.some(id => session?.unavailableObjects.has(id) || (session?.visibleObjects !== null && session?.visibleObjects !== undefined && !session.visibleObjects.has(id))) || Boolean(taskId && session?.objectCapabilities.get(taskId)?.edit === false);
    }
    const id = objectFromKey(key); const capabilities = id ? session?.objectCapabilities.get(id) : null;
    return Boolean(id && isDraftKey(key) && capabilities && !((key.startsWith('paste-comment:') || (key.startsWith('paste-request:') && (value ?? (() => { try { return JSON.parse(rawRead(key) || 'null'); } catch { return null; } })())?.kind === 'comment') || key.startsWith('comment-source:') || key.startsWith('task-comment:')) ? capabilities.interact : capabilities.edit));
  };
  const savedEntries = (): [string, string][] => {
    if (!sessionIsActive(session)) return [];
    if (!durable) return [...session.memory];
    const entries: [string, string][] = [];
    try { for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i); if (key?.startsWith(contentKey(''))) entries.push([key.slice(contentKey('').length), localStorage.getItem(key) || 'null']); } } catch { /* Unavailable storage stays unreadable. */ }
    // Keep failed task writes separately from durable bytes: another tab may
    // have saved a different draft, and both copies must remain recoverable.
    for (const [key, value] of session.memory) if (isRetainedDraftKey(key)) {
      // Successful saves keep a tab-local shadow so a later save in
      // another tab cannot displace the editor's exact bytes on navigation.
      // Equal physical copies need only one recovery entry.
      if (key.endsWith(':unsaved-memory') && entries.some(([savedKey, saved]) => savedKey === key.slice(0, -':unsaved-memory'.length) && saved === value)) continue;
      entries.push([key, value]);
    }
    return entries;
  };
  const rawRead = (key: string): string | null => { if (durable && isRetainedDraftKey(key)) { const retained = session?.memory.get(`${key}:unsaved-memory`) || session?.memory.get(key); if (retained) return retained; } try { return durable ? localStorage.getItem(contentKey(key)) : session?.memory.get(key) || null; } catch { return null; } };
  const rawWrite = (key: string, value: unknown): boolean => { try { const json = JSON.stringify(value); if (durable) { localStorage.setItem(contentKey(key), json); if (isRetainedDraftKey(key)) session?.memory.delete(`${key}:unsaved-memory`); } else session?.memory.set(key, json); return true; } catch { if (durable && isRetainedDraftKey(key) && !key.endsWith(':unsaved-memory')) session?.memory.set(`${key}:unsaved-memory`, JSON.stringify(value)); return false; } };
  const rawRemove = (key: string): boolean => { try { if (durable) { localStorage.removeItem(contentKey(key)); if (isRetainedDraftKey(key)) { session?.memory.delete(key); session?.memory.delete(`${key}:unsaved-memory`); } } else session?.memory.delete(key); return true; } catch { return false; } };
  const rawRemoveMatching = (key: string, expected: unknown): boolean => {
    const expectedJson = JSON.stringify(expected);
    try {
      // Compare each physical copy separately. rawRead can prefer an unsaved
      // memory copy over a different durable draft saved by another tab.
      if (durable && localStorage.getItem(contentKey(key)) === expectedJson) localStorage.removeItem(contentKey(key));
      if (session?.memory.get(key) === expectedJson) session.memory.delete(key);
      if (durable && isRetainedDraftKey(key) && !key.endsWith(':unsaved-memory') && session?.memory.get(`${key}:unsaved-memory`) === expectedJson) session.memory.delete(`${key}:unsaved-memory`);
      return true;
    } catch { return false; }
  };
  const draftObjects = (key: string, value?: unknown): string[] => {
    const primary = objectFromKey(key);
    if (key.startsWith('notifications:')) { const cache = notificationCache(value, session?.state.account?.id || `local:${session?.state.workspaceId}`); return cache?.pages.flatMap(page => page.items.map(item => item.event.objectId)) || []; }
    if (key.startsWith('notification-request:')) { try { const intent = notificationIntent(value ?? JSON.parse(rawRead(key) || 'null'), session?.state.account?.id || `local:${session?.state.workspaceId}`); return intent && notificationIntentObjectId(intent) ? [notificationIntentObjectId(intent)!] : []; } catch { return []; } }
    const selectedProjects = (input: unknown): string[] => { if (!input || typeof input !== 'object') return []; const value = input as { projectId?: unknown; projectIds?: unknown }; let ids = value.projectIds; if (typeof ids === 'string') { try { ids = JSON.parse(ids); } catch { ids = []; } } return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && /^PROJ\d+$/.test(id)) : typeof value.projectId === 'string' && /^PROJ\d+$/.test(value.projectId) ? [value.projectId] : []; };
    if (/^revision-project-(?:draft|request):/.test(key) || key.startsWith('repository-import:') || key.startsWith('draft:revision:')) { try { const draft = value ?? JSON.parse(rawRead(key) || 'null'); const input = draft?.body || draft?.input || draft; return [...new Set([...(primary ? [primary] : []), ...selectedProjects(input)])]; } catch { return primary ? [primary] : []; } }
    if (key.startsWith('revision-projects:')) { const reading = projectTagReading(value, primary || ''); return [...new Set([...(primary ? [primary] : []), ...(reading ? [...reading.snapshot.tags.projectIds, ...reading.history.transactions.flatMap(item => [...item.before.projectIds, ...item.after.projectIds])] : [])])]; }
    if (/^revision-dependency-(?:draft|request):/.test(key)) { try { const draft = (value ?? JSON.parse(rawRead(key) || 'null')) as { add?: unknown[]; remove?: unknown[]; body?: { add?: unknown[]; remove?: unknown[] } } | null; const input = draft?.body || draft; return [...new Set([...(primary ? [primary] : []), ...[...(input?.add || []), ...(input?.remove || [])].filter((id): id is string => typeof id === 'string' && /^[DPL]\d+$/.test(id))])]; } catch { return primary ? [primary] : []; } }
    if (key.startsWith('revision-stack:')) return [...new Set([...(primary ? [primary] : []), ...(isRevisionStack(value, primary || '') ? value.nodes.map(node => node.id) : [])])];
    if (key.startsWith('revision-dependencies:')) { const snapshot = dependencySnapshot(value, primary || ''); return [...new Set([...(primary ? [primary] : []), ...(snapshot ? [...snapshot.parents.revisions.map(item => item.id), ...snapshot.children.revisions.map(item => item.id), ...snapshot.history.transactions.map(item => item.change.revisionId)] : [])])]; }
    if (/^wiki-(?:move|request|edit|action|action-request):/.test(key) || key.startsWith('draft:document:')) { try { const draft = (value ?? JSON.parse(rawRead(key) || 'null')) as { authorityIds?: string[]; wikiAuthority?: WikiAuthority; spaceId?: string } | null; return [...new Set([...(primary ? [primary] : []), ...(draft?.authorityIds || draft?.wikiAuthority?.ancestorIds || []), ...(key.startsWith('draft:document:new') && draft?.spaceId ? [draft.spaceId] : [])])]; } catch { return primary ? [primary] : []; } }
    if (/^review-drafts:|^review-draft-(?:edit|summary|request):/.test(key)) return [...new Set([...(primary ? [primary] : []), ...(primary && session?.revisionRepositories.get(primary) ? [session.revisionRepositories.get(primary)!] : []), ...(primary ? session?.revisionFiles.get(primary) || [] : [])])];
    if (/^transcript-edit-(?:draft|request):/.test(key)) {
      try {
        const draft = (value ?? JSON.parse(rawRead(key) || 'null')) as { sourceFile?: { fileId?: unknown }; draft?: { sourceFile?: { fileId?: unknown } } } | null;
        const file = draft?.sourceFile?.fileId ?? draft?.draft?.sourceFile?.fileId;
        return [...new Set([...(primary ? [primary] : []), ...(primary && session?.revisionRepositories.get(primary) ? [session.revisionRepositories.get(primary)!] : []), ...(primary ? session?.revisionFiles.get(primary) || [] : []), ...(typeof file === 'string' && /^F\d+$/.test(file) ? [file] : [])])];
      } catch { return primary ? [primary] : []; }
    }
    if (/^docx-(?:draft|request):/.test(key)) { try { const draft = (value ?? JSON.parse(rawRead(key) || 'null')) as { sourceFile?: { fileId?: unknown }; projectIds?: string[]; body?: { sourceFile?: { fileId?: unknown }; projectIds?: string[] } } | null; const file = draft?.sourceFile?.fileId ?? draft?.body?.sourceFile?.fileId; return [...(primary ? [primary] : []), ...(typeof file === 'string' && /^F\d+$/.test(file) ? [file] : []), ...selectedProjects(draft?.body || draft)]; } catch { return primary ? [primary] : []; } }
    if (key.startsWith('citation-draft:')) { try { const draft = (value ?? JSON.parse(rawRead(key) || 'null')) as { source?: { fileId?: unknown }; body?: { source?: { fileId?: unknown } } } | null; const source = draft?.source?.fileId ?? draft?.body?.source?.fileId; return [...(primary ? [primary] : []), ...(typeof source === 'string' && /^F\d+$/.test(source) ? [source] : [])]; } catch { return primary ? [primary] : []; } }
    if (key.startsWith('revision-git-import:')) {
      try { const draft = (value ?? JSON.parse(rawRead(key) || 'null')) as { repositoryId?: unknown } | null; return [primary, typeof draft?.repositoryId === 'string' && /^R\d+$/.test(draft.repositoryId) ? draft.repositoryId : null].filter((id): id is string => typeof id === 'string'); } catch { return primary ? [primary] : []; }
    }
    if (key.startsWith('version-draft:')) {
      const draft = value as { assets?: { fileId?: unknown }[] } | undefined;
      return [...(primary ? [primary] : []), ...(Array.isArray(draft?.assets) ? draft.assets.flatMap(asset => typeof asset?.fileId === 'string' && /^F\d+$/.test(asset.fileId) ? [asset.fileId] : []) : [])];
    }
    if (!key.startsWith('workboard-move:')) return primary ? [primary] : [];
    const task = /^workboard-move:PROJ\d+:(T\d+)/.exec(key)?.[1];
    try {
      const draft = (value ?? JSON.parse(rawRead(key) || 'null')) as { proxyProjectId?: string; input?: { position?: { beforeTaskId?: string; afterTaskId?: string } } } | null;
      return [primary, task, draft?.proxyProjectId, draft?.input?.position?.beforeTaskId, draft?.input?.position?.afterTaskId].filter((id): id is string => typeof id === 'string');
    } catch { return [primary, task].filter((id): id is string => typeof id === 'string'); }
  };
  const rememberRevisionSources = (value: unknown): void => {
    if (!sessionIsActive(session) || !value || typeof value !== 'object') return;
    const data = value as { revision?: { id?: unknown; repositoryId?: unknown }; revisions?: { id?: unknown; repositoryId?: unknown }[]; versions?: { assets?: { fileId?: unknown }[]; docx?: { sourceFile?: { fileId?: unknown } } }[] };
    const rows = Array.isArray(data.revisions) ? data.revisions : data.revision ? [data.revision] : [];
    for (const item of rows) {
      if (!item || typeof item.id !== 'string' || !/^[DPL]\d+$/.test(item.id)) continue;
      if (typeof item.repositoryId === 'string' && /^R\d+$/.test(item.repositoryId)) session.revisionRepositories.set(item.id, item.repositoryId);
      if (data.revision?.id === item.id && Array.isArray(data.versions)) {
        const assets = new Set(session.revisionFiles.get(item.id) || []);
        for (const version of data.versions) for (const asset of version.assets || []) if (typeof asset.fileId === 'string' && /^F\d+$/.test(asset.fileId)) assets.add(asset.fileId);
        for (const version of data.versions) if (typeof version.docx?.sourceFile?.fileId === 'string' && /^F\d+$/.test(version.docx.sourceFile.fileId)) assets.add(version.docx.sourceFile.fileId);
        session.revisionFiles.set(item.id, assets);
      }
      try { const previous = JSON.parse(rawRead(`revision-source:${item.id}`) || 'null') as { fileIds?: unknown } | null; if (Array.isArray(previous?.fileIds)) session.revisionFiles.set(item.id, new Set([...(session.revisionFiles.get(item.id) || []), ...previous.fileIds.filter((id): id is string => typeof id === 'string' && /^F\d+$/.test(id))])); } catch { /* Historical dependencies already learned in this session stay retained. */ }
      rawWrite(`revision-source:${item.id}`, { repositoryId: session.revisionRepositories.get(item.id) || null, fileIds: [...(session.revisionFiles.get(item.id) || [])] });
    }
  };
  const learnSavedRevisionSources = (): void => {
    if (!sessionIsActive(session)) return;
    for (const [key, json] of savedEntries()) {
      try {
        const value = JSON.parse(json) as { repositoryId?: unknown; fileIds?: unknown };
        if (key.startsWith('revision-source:') && value && typeof value === 'object') {
          const id = key.slice('revision-source:'.length);
          if (typeof value.repositoryId === 'string' && /^R\d+$/.test(value.repositoryId)) session.revisionRepositories.set(id, value.repositoryId);
          if (Array.isArray(value.fileIds)) session.revisionFiles.set(id, new Set([...(session.revisionFiles.get(id) || []), ...value.fileIds.filter((file): file is string => typeof file === 'string' && /^F\d+$/.test(file))]));
        } else if (key === 'state' || key.startsWith('revision:')) rememberRevisionSources(value);
      } catch { /* Unreadable caches do not authorize source. */ }
    }
  };
  learnSavedRevisionSources();
  const rawOutbox = (): PendingMutation[] => { try { return JSON.parse(rawRead('outbox') || '[]') as PendingMutation[]; } catch { return []; } };
  // Recovery records are immutable and independently addressable. The logical
  // draft key is not an identity: two tabs may hold different work at that key.
  const recordKey = (recoveryId: string) => `quarantined-drafts:${recoveryId}`;
  const heldDrafts = (key: string) => [...(session?.quarantinedDrafts.values() || [])].filter(draft => draft.key === key);
  const heldFamily = (key: string) => [...(session?.quarantinedDrafts.values() || [])].some(draft => draft.key.replace(/:unsaved-memory$/, '') === key.replace(/:unsaved-memory$/, ''));
  const quarantineChanged = () => { if (sessionIsActive(session)) for (const listener of session.accessListeners) listener([]); };
  const storageFailure = () => {
    if (!sessionIsActive(session)) return;
    // This small marker is initialized before ordinary work is saved. Removing
    // it works at quota and makes subsequent tabs/reloads hold the original bytes.
    rawRemove('quarantine-ready');
    session.quarantineWarning = 'Browser storage could not save every recovery copy. Original drafts and queued changes are retained and automatic submission is blocked. Export the drafts now, or free browser storage and retry saving them. Keep this page open until you have a copy.';
  };
  const parseDraft = (json: string, recoveryId: string): QuarantinedDraft | null => {
    // The physical path supplies identity for both legacy and current records.
    try { const item: unknown = JSON.parse(json); return item && typeof item === 'object' && 'key' in item && typeof item.key === 'string' && 'objectId' in item && typeof item.objectId === 'string' && 'value' in item && 'reason' in item && typeof item.reason === 'string' ? { ...item, recoveryId } as QuarantinedDraft : null; } catch { return null; }
  };
  const addRecovery = (draft: Omit<QuarantinedDraft, 'recoveryId'>): boolean => {
    if (!sessionIsActive(session)) return false;
    const json = JSON.stringify(draft.value);
    if (heldDrafts(draft.key).some(held => JSON.stringify(held.value) === json)) return false;
    const recoveryId = `record:${crypto.randomUUID()}`;
    session.quarantinedDrafts.set(recoveryId, { ...draft, value: JSON.parse(json) as unknown, recoveryId });
    if (durable) session.quarantinePending.add(recoveryId);
    return true;
  };
  const recoverOriginals = (all = true): boolean => {
    if (!sessionIsActive(session)) return false;
    let changed = false;
    for (const [key, json] of savedEntries()) if (isDraftKey(key) && (all || heldFamily(key))) {
      try { const value: unknown = JSON.parse(json); if (hasSavedWork(key, value)) changed = addRecovery({ key, objectId: objectFromKey(key) || 'Workspace', value, reason: 'Saved work held for explicit export or discard' }) || changed; } catch { /* Preserve unreadable original bytes. */ }
    }
    for (const item of rawOutbox()) if (all || heldFamily(`outbox:${item.id}`)) {
      const key = `outbox:${item.id}`; changed = addRecovery({ key, objectId: queuedObject(item) || 'Workspace', value: item, reason: 'Queued change held for explicit recovery; automatic submission stopped' }) || changed;
    }
    return changed;
  };
  const syncDurableQuarantine = () => {
    if (!durable || !sessionIsActive(session)) return;
    const found = new Set<string>();
    for (const [key, json] of savedEntries()) if (key.startsWith('quarantined-drafts:')) {
      const draft = parseDraft(json, key.slice('quarantined-drafts:'.length));
      if (!draft) { storageFailure(); continue; }
      found.add(draft.recoveryId);
      if (!session.quarantinePending.has(draft.recoveryId)) session.quarantinedDrafts.set(draft.recoveryId, draft);
    }
    // Preserve a different original discovered in this tab before retiring a
    // hold which another tab discarded. Otherwise its removal could silently
    // turn those later bytes back into an ordinary, replayable draft.
    const capturedOriginals = recoverOriginals(false);
    for (const key of session.quarantinePersisted) if (!found.has(key) && !session.quarantinePending.has(key)) session.quarantinedDrafts.delete(key);
    session.quarantinePersisted.clear(); for (const key of found) session.quarantinePersisted.add(key);
    if (rawRead('quarantine-format') === '2' && rawRead('quarantine-ready') !== '1') { recoverOriginals(); storageFailure(); }
    else if (capturedOriginals) persistQuarantine();
  };
  const persistQuarantine = (): boolean => {
    if (!sessionIsActive(session)) return false;
    if (!durable) return true;
    let saved = true;
    // Separate records prevent simultaneous tabs from overwriting each other's
    // quarantine lists. Only this tab's pending records are written.
    for (const key of [...session.quarantinePending]) {
      const draft = session.quarantinedDrafts.get(key);
      if (!draft) continue;
      if (rawWrite(recordKey(key), draft)) { session.quarantinePending.delete(key); session.quarantinePersisted.add(key); }
      else saved = false;
    }
    if (saved) {
      try { localStorage.setItem(contentKey('quarantine-format'), '2'); localStorage.setItem(contentKey('quarantine-ready'), '1'); session.quarantineWarning = ''; return true; } catch { saved = false; }
    }
    storageFailure(); return saved;
  };
  const quarantine = (draft: Omit<QuarantinedDraft, 'recoveryId'>): boolean => {
    if (!sessionIsActive(session)) return false;
    syncDurableQuarantine(); addRecovery(draft);
    const saved = persistQuarantine(); quarantineChanged(); return saved;
  };
  const invalidateRevisionStacks = (except?: AbortController, remove = true) => {
    if (!sessionIsActive(session) || !stacks) return;
    stacks.generation++;
    for (const controller of stacks.controllers) if (controller !== except) controller.abort();
    if (remove) for (const [key] of savedEntries()) if (key.startsWith('revision-stack:')) rawRemove(key);
    for (const listener of stacks.listeners) listener();
  };
  const reconcileStackMetadata = (value: unknown) => {
    if (!sessionIsActive(session) || !stacks || !value || typeof value !== 'object' || !('revisions' in value) || !Array.isArray(value.revisions)) return;
    const metadata = new Map<string, string>();
    for (const revision of value.revisions) { const fingerprint = revisionStackMetadata(revision); if (fingerprint !== null) metadata.set((revision as { id: string }).id, fingerprint); }
    let changed = stacks.metadata !== null && [...stacks.metadata].some(([id, fingerprint]) => metadata.get(id) !== fingerprint);
    if (!changed) for (const [key, json] of savedEntries()) if (key.startsWith('revision-stack:')) {
      try { const graph: unknown = JSON.parse(json); if (!isRevisionStack(graph, objectFromKey(key) || '') || graph.nodes.some(node => metadata.get(node.id) !== revisionStackMetadata(node))) { changed = true; break; } } catch { changed = true; break; }
    }
    stacks.metadata = metadata;
    if (changed) invalidateRevisionStacks();
  };
  const invalidateNotifications = (except?: AbortController, remove = true) => {
    if (!sessionIsActive(session) || !notifications) return;
    notifications.generation++;
    for (const controller of notifications.controllers) if (controller !== except) controller.abort();
    if (remove) for (const [key] of savedEntries()) if (key.startsWith('notifications:')) rawRemove(key);
    for (const listener of notifications.listeners) listener();
  };
  const invalidateTaskSnapshots = (except?: AbortController, remove = true) => {
    if (!sessionIsActive(session)) return;
    session.taskSnapshotGeneration += 1;
    invalidateNotifications(except, remove);
    invalidateRevisionStacks(except, remove);
    for (const controller of session.taskReadControllers) if (controller !== except) controller.abort();
    if (remove) for (const [key, value] of savedEntries()) if (key.startsWith('review-drafts:') || (key.startsWith('revision:') && (() => { try { return docxSnapshot(key, JSON.parse(value)); } catch { return false; } })()) || key.startsWith('revision-projects:') || key.startsWith('object-subscriptions:') || key.startsWith('revision-subscriptions:') || key.startsWith('revision-metadata:') || key.startsWith('revision-reviewers:') || key.startsWith('revision-lifecycle:') || key.startsWith('revision-authorship:') || key.startsWith('revision-dependencies:') || key.startsWith('wiki:') || key.startsWith('wiki-path:') || key.startsWith('wiki-search:') || key.startsWith('paste:') || key.startsWith('paste-version:') || key.startsWith('paste-history:') || key.startsWith('paste-list:') || key.startsWith('task-mute:') || key.startsWith('task:') || key.startsWith('project:') || key.startsWith('workboard:') || key.startsWith('discussion-preferences:') || /^repository:R\d+:cache$/.test(key)) rawRemove(key);
    for (const listener of session.taskSnapshotListeners) listener();
  };
  let holdingLegacy = false;
  const holdLegacyTaskUpdates = () => {
    if (!sessionIsActive(session) || holdingLegacy) return;
    holdingLegacy = true;
    try {
      const wikiState = (() => { try { return JSON.parse(rawRead('state') || 'null') as { documents?: { id: string; slug: string; version: number; location?: { path: string; status: string } }[] } | null; } catch { return null; } })();
      for (const item of rawOutbox()) if ((item.path === '/api/documents' && item.method === 'POST' && (!canQueue(item.path, item.method, item.body) || !item.wikiAuthority)) || (/^\/api\/documents\/W\d+$/.test(item.path) && item.method === 'PUT' && (() => { const current = wikiState?.documents?.find(document => document.id === objectFromPath(item.path)); const input = item.body as { slug?: unknown; expectedVersion?: unknown }; if (!current) return false; try { return (current.location?.status !== undefined && current.location.status !== 'active' && input.expectedVersion !== current.version) || (typeof input?.slug === 'string' && canonicalWikiPath(input.slug) !== (current.location?.path || canonicalWikiPath(current.slug))); } catch { return true; } })())) if (!heldFamily(`outbox:${item.id}`)) quarantine({ key: `outbox:${item.id}`, objectId: queuedObject(item)!, value: item, reason: 'This older wiki request needs a new path and parent review. Export it before preparing a separate change; it will not submit automatically.' });
      for (const item of rawOutbox()) if ((item.path === '/api/projects' || /^\/api\/projects\/PROJ\d+$/.test(item.path)) && !canQueue(item.path, item.method, item.body) && !heldFamily(`outbox:${item.id}`)) quarantine({ key: `outbox:${item.id}`, objectId: queuedObject(item)!, value: item, reason: 'This older project change has no valid source version or includes an operation that requires an online review. Export and review it explicitly; automatic submission stopped.' });
      for (const [key, json] of savedEntries()) if (key.startsWith('project-draft:') && !heldFamily(key)) { try { const draft = JSON.parse(json) as { expectedVersion?: unknown }; if (!Number.isSafeInteger(draft.expectedVersion) || Number(draft.expectedVersion) < 1) quarantine({ key, objectId: objectFromKey(key)!, value: draft, reason: 'This older project draft has no recorded source version. Export the entire draft and review it against the current project before saving.' }); } catch { /* Preserve unreadable original bytes. */ } }
      for (const item of rawOutbox()) if (((item.method === 'PATCH' && /^\/api\/tasks\/T\d+$/.test(item.path)) || (item.method === 'POST' && item.path === '/api/tasks')) && !heldFamily(`outbox:${item.id}`)) {
        const body = item.body as { expectedVersion?: unknown; ownerId?: unknown; projectId?: unknown; projectIds?: unknown } | null;
        if (item.method === 'PATCH' && body && ('projectId' in body || 'projectIds' in body)) { quarantine({ key: `outbox:${item.id}`, objectId: queuedObject(item)!, value: item, reason: 'This saved field change uses an older project replacement format. Export the whole change, then review ordinary fields and project tags separately. Automatic submission is stopped.' }); continue; }
        if (body && 'ownerId' in body && (item.method === 'PATCH' || body.ownerId !== null)) { quarantine({ key: `outbox:${item.id}`, objectId: queuedObject(item)!, value: item, reason: 'Assignment changes require an online review of access effects. Export this saved change and assign the task explicitly. Automatic submission is stopped.' }); continue; }
        if (item.method === 'PATCH' && (!body || !Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 1)) quarantine({ key: `outbox:${item.id}`, objectId: queuedObject(item)!, value: item, reason: 'This older task change has no source version. Export it, inspect the current task, and make a new edit explicitly. Automatic submission is stopped.' });
      }
      for (const [key, json] of savedEntries()) if (key.startsWith('task-draft:') && !heldFamily(key)) {
        try { const draft: unknown = JSON.parse(json); if (draft && typeof draft === 'object' && ((('changed' in draft && Array.isArray(draft.changed)) ? draft.changed.some(field => field === 'projectId' || field === 'projectIds') : 'projectId' in draft || 'projectIds' in draft))) quarantine({ key, objectId: objectFromKey(key)!, value: draft, reason: 'This field draft includes an older project replacement. Export the whole draft and review its fields and project tags separately before saving.' }); } catch { /* Keep unreadable drafts unchanged for explicit recovery. */ }
      }
    } finally { holdingLegacy = false; }
  };
  if (durable && sessionIsActive(session) && !session.quarantineLoaded.has(contentKey('quarantined-drafts'))) {
    session.quarantineLoaded.add(contentKey('quarantined-drafts')); syncDurableQuarantine();
    if (rawRead('quarantine-format') !== '2' || rawRead('quarantine-ready') !== '1') {
      if (!persistQuarantine()) recoverOriginals();
    }
    if (typeof window !== 'undefined') {
      const changed = (event: StorageEvent) => {
        if (!sessionIsActive(session)) return;
        if (event.key === null || event.key === contentKey('quarantine-ready') || event.key?.startsWith(contentKey('quarantined-drafts:'))) { syncDurableQuarantine(); quarantineChanged(); }
        if (event.key?.startsWith(contentKey('revision-stack:')) && event.newValue === null) invalidateRevisionStacks(undefined, false);
        if (event.key?.startsWith(contentKey('notifications:')) && event.newValue === null) invalidateNotifications(undefined, false);
        if (event.key === null || ((event.key?.startsWith(contentKey('revision-projects:')) || event.key?.startsWith(contentKey('object-subscriptions:')) || event.key?.startsWith(contentKey('revision-subscriptions:')) || event.key?.startsWith(contentKey('revision-metadata:')) || event.key?.startsWith(contentKey('revision-reviewers:')) || event.key?.startsWith(contentKey('revision-lifecycle:')) || event.key?.startsWith(contentKey('revision-authorship:')) || event.key?.startsWith(contentKey('revision-dependencies:')) || event.key?.startsWith(contentKey('wiki:')) || event.key?.startsWith(contentKey('wiki-path:')) || event.key?.startsWith(contentKey('wiki-search:')) || event.key?.startsWith(contentKey('revision:')) || event.key?.startsWith(contentKey('paste:')) || event.key?.startsWith(contentKey('paste-version:')) || event.key?.startsWith(contentKey('paste-list:')) || event.key?.startsWith(contentKey('task-mute:')) || event.key?.startsWith(contentKey('task:')) || event.key?.startsWith(contentKey('project:')) || event.key?.startsWith(contentKey('workboard:')) || event.key?.startsWith(contentKey('repository:'))) && event.newValue === null)) invalidateTaskSnapshots(undefined, false);
      };
      window.addEventListener('storage', changed);
      session.cleanupCallbacks.add(() => window.removeEventListener('storage', changed));
    }
  }
  const hasDraftHold = (key: string): boolean => {
    return heldDrafts(key).length > 0 || (isRetainedDraftKey(key) && heldFamily(key));
  };
  const draftIsHeld = (key: string): boolean => { syncDurableQuarantine(); return sessionIsActive(session) && hasDraftHold(key); };
  const readStored = <T,>(key: string, fallback: T): T => {
    syncDurableQuarantine();
    if (key === 'outbox' || key.startsWith('task-draft:') || (key.startsWith('project-draft:') || key.startsWith('project-child:'))) holdLegacyTaskUpdates();
    if (!sessionIsActive(session) || session.unavailableObjects.has(objectFromKey(key) || '') || session.unavailableObjects.has(session.revisionRepositories.get(objectFromKey(key) || '') || '') || [...(session.revisionFiles.get(objectFromKey(key) || '') || [])].some(id => session.unavailableObjects.has(id)) || blockedDraft(key) || hasDraftHold(key)) return fallback;
    try { const value = rawRead(key); const parsed: unknown = value ? JSON.parse(value) : fallback; if (key.startsWith('review-drafts:') && (!isReviewDraftSnapshot(parsed, objectFromKey(key) || '', session.state.account?.id || `local:${session.state.workspaceId}`) || parsed.accessEpoch < session.accessEpoch)) return fallback; if (key.startsWith('object-subscriptions:')) { const reading = objectSubscriptionReading(parsed, objectFromKey(key) || '', session.state.account?.id || `local:${session.state.workspaceId}`); if (!reading || reading.snapshot.accessEpoch < session.accessEpoch) return fallback; } if (key.startsWith('task-mute:')) { const reading = taskMuteReading(parsed, objectFromKey(key) || '', session.state.account?.id || `local:${session.state.workspaceId}`); if (!reading || reading.snapshot.accessEpoch < session.accessEpoch) return fallback; } if (key.startsWith('notifications:')) { const reading = notificationCache(parsed, session.state.account?.id || `local:${session.state.workspaceId}`); if (!reading || reading.summary.accessEpoch < session.accessEpoch || reading.pages.some(page => page.items.some(item => session.unavailableObjects.has(item.event.objectId) || session.visibleObjects !== null && !session.visibleObjects.has(item.event.objectId)))) return fallback; } if ((key.startsWith('revision-stack:') && (!isRevisionStack(parsed, objectFromKey(key) || '') || parsed.nodes.some(node => session.unavailableObjects.has(node.id) || (session.visibleObjects !== null && !session.visibleObjects.has(node.id))))) || (key.startsWith('revision-projects:') && (!projectTagReading(parsed, objectFromKey(key) || '') || projectTagReading(parsed, objectFromKey(key) || '')!.snapshot.accessEpoch < session.accessEpoch)) || (key.startsWith('revision-subscriptions:') && (!subscriptionReading(parsed, objectFromKey(key) || '', session.state.account?.id || `local:${session.state.workspaceId}`) || subscriptionReading(parsed, objectFromKey(key) || '')!.snapshot.accessEpoch < session.accessEpoch)) || (key.startsWith('revision-metadata:') && (!metadataReading(parsed, objectFromKey(key) || '') || metadataReading(parsed, objectFromKey(key) || '')!.snapshot.accessEpoch < session.accessEpoch)) || (key.startsWith('revision-reviewers:') && (!reviewerReading(parsed, objectFromKey(key) || '') || reviewerReading(parsed, objectFromKey(key) || '')!.snapshot.accessEpoch < session.accessEpoch)) || (key.startsWith('revision-lifecycle:') && (!lifecycleReading(parsed, objectFromKey(key) || '') || lifecycleReading(parsed, objectFromKey(key) || '')!.snapshot.accessEpoch < session.accessEpoch)) || (key.startsWith('revision-authorship:') && (!authorReading(parsed, objectFromKey(key) || '') || authorReading(parsed, objectFromKey(key) || '')!.snapshot.accessEpoch < session.accessEpoch)) || (key.startsWith('revision-dependencies:') && !dependencySnapshot(parsed, objectFromKey(key) || '')) || !currentProjectCache(key, parsed) || !currentWikiSearchCache(key, parsed)) return fallback; if ((docxSnapshot(key, parsed) || key.startsWith('review-drafts:') || key.startsWith('revision-stack:') || key.startsWith('revision-projects:') || key.startsWith('object-subscriptions:') || key.startsWith('revision-subscriptions:') || key.startsWith('revision-metadata:') || key.startsWith('revision-reviewers:') || key.startsWith('revision-lifecycle:') || key.startsWith('revision-authorship:') || key.startsWith('revision-dependencies:') || key.startsWith('wiki:') || key.startsWith('wiki-path:') || key.startsWith('wiki-search:') || key.startsWith('paste:') || key.startsWith('paste-version:') || key.startsWith('paste-history:') || key.startsWith('paste-list:') || key.startsWith('task-mute:') || key.startsWith('task:') || key.startsWith('project:') || key.startsWith('workboard:') || key.startsWith('discussion-preferences:') || /^repository:R\d+:cache$/.test(key)) && parsed && typeof parsed === 'object' && 'accessEpoch' in parsed && typeof parsed.accessEpoch === 'number' && parsed.accessEpoch < session.accessEpoch) return fallback; return (key === 'outbox' && Array.isArray(parsed) ? (parsed as PendingMutation[]).filter(item => !heldFamily(`outbox:${item.id}`)) : parsed) as T; } catch { return fallback; }
  };
  const validPrivateReviewStorage = (key: string, value: unknown): boolean => {
    const base = key.replace(/:unsaved-memory$/, ''), id = objectFromKey(base) || '', principal = session?.state.account?.id || `local:${session?.state.workspaceId}`;
    if (base.startsWith('review-drafts:')) return /^review-drafts:[DPL][1-9]\d{0,14}$/.test(base) && isReviewDraftSnapshot(value, id, principal) && value.accessEpoch >= (session?.accessEpoch ?? -1);
    if (base.startsWith('review-draft-request:')) return /^review-draft-request:[DPL][1-9]\d{0,14}$/.test(base) && Boolean(reviewDraftIntent(value, id, principal));
    if (base.startsWith('review-draft-edit:') || base.startsWith('review-draft-summary:')) { const draft = reviewDraftEdit(value); return Boolean(draft && (base === `review-draft-edit:${id}:${draft.id}` || base === `review-draft-summary:${id}` && draft.payload.kind === 'summary')); }
    return true;
  };
  const writeStored = (key: string, value: unknown): boolean => {
    if (!validPrivateReviewStorage(key, value)) return false;
    syncDurableQuarantine();
    if (key.startsWith('object-subscriptions:')) { const reading = objectSubscriptionReading(value, objectFromKey(key) || '', session?.state.account?.id || `local:${session?.state.workspaceId}`); if (!reading || reading.snapshot.accessEpoch < (session?.accessEpoch ?? -1)) return false; }
    if (key.startsWith('task-mute:')) { const reading = taskMuteReading(value, objectFromKey(key) || '', session?.state.account?.id || `local:${session?.state.workspaceId}`); if (!reading || reading.snapshot.accessEpoch < (session?.accessEpoch ?? -1)) return false; }
    if (key.startsWith('notifications:')) { const reading = notificationCache(value, session?.state.account?.id || `local:${session?.state.workspaceId}`); if (!reading || reading.summary.accessEpoch < (session?.accessEpoch ?? -1) || reading.pages.some(page => page.items.some(item => session?.unavailableObjects.has(item.event.objectId) || session?.visibleObjects != null && !session.visibleObjects.has(item.event.objectId)))) return false; }
    if ((key.startsWith('revision-stack:') && (!isRevisionStack(value, objectFromKey(key) || '') || value.nodes.some(node => session?.unavailableObjects.has(node.id) || (session?.visibleObjects != null && !session.visibleObjects.has(node.id))))) || (key.startsWith('revision-projects:') && (!projectTagReading(value, objectFromKey(key) || '') || projectTagReading(value, objectFromKey(key) || '')!.snapshot.accessEpoch < (session?.accessEpoch ?? -1))) || (key.startsWith('revision-subscriptions:') && (!subscriptionReading(value, objectFromKey(key) || '', session?.state.account?.id || `local:${session?.state.workspaceId}`) || subscriptionReading(value, objectFromKey(key) || '')!.snapshot.accessEpoch < (session?.accessEpoch ?? -1))) || (key.startsWith('revision-metadata:') && (!metadataReading(value, objectFromKey(key) || '') || metadataReading(value, objectFromKey(key) || '')!.snapshot.accessEpoch < (session?.accessEpoch ?? -1))) || (key.startsWith('revision-reviewers:') && (!reviewerReading(value, objectFromKey(key) || '') || reviewerReading(value, objectFromKey(key) || '')!.snapshot.accessEpoch < (session?.accessEpoch ?? -1))) || (key.startsWith('revision-lifecycle:') && (!lifecycleReading(value, objectFromKey(key) || '') || lifecycleReading(value, objectFromKey(key) || '')!.snapshot.accessEpoch < (session?.accessEpoch ?? -1))) || (key.startsWith('revision-authorship:') && (!authorReading(value, objectFromKey(key) || '') || authorReading(value, objectFromKey(key) || '')!.snapshot.accessEpoch < (session?.accessEpoch ?? -1))) || (key.startsWith('revision-dependencies:') && !dependencySnapshot(value, objectFromKey(key) || '')) || !currentWikiSearchCache(key, value)) return false;
    if (!sessionIsActive(session) || session.unavailableObjects.has(objectFromKey(key) || '') || session.unavailableObjects.has(session.revisionRepositories.get(objectFromKey(key) || '') || '') || [...(session.revisionFiles.get(objectFromKey(key) || '') || [])].some(id => session.unavailableObjects.has(id))) return false;
    if (key === 'state' || key.startsWith('revision:')) rememberRevisionSources(value);
    if (key.startsWith('revision-comparison:')) { if (!isComparisonSelection(value, objectFromKey(key) || '')) return false; value = comparisonMetadata(value); }
    if (key.startsWith('docx-comparison:')) { if (!isDocxComparisonSelection(value, objectFromKey(key) || '')) return false; value = docxComparisonMetadata(value); }
    if (key.startsWith('review-findings:')) { if (!isFindingSelection(value, objectFromKey(key) || '')) return false; value = findingSelectionMetadata(value); }
    if (/^repository:R\d+:selection$/.test(key)) { const selection = repositorySelection(value); if (!selection) return false; value = selection; }
    if ((docxSnapshot(key, value) || key.startsWith('review-drafts:') || key.startsWith('revision-stack:') || key.startsWith('revision-projects:') || key.startsWith('object-subscriptions:') || key.startsWith('revision-subscriptions:') || key.startsWith('revision-metadata:') || key.startsWith('revision-reviewers:') || key.startsWith('revision-lifecycle:') || key.startsWith('revision-authorship:') || key.startsWith('revision-dependencies:') || key.startsWith('wiki:') || key.startsWith('wiki-path:') || key.startsWith('wiki-search:') || key.startsWith('paste:') || key.startsWith('paste-version:') || key.startsWith('paste-history:') || key.startsWith('paste-list:') || key.startsWith('task-mute:') || key.startsWith('task:') || key.startsWith('project:') || key.startsWith('workboard:') || key.startsWith('discussion-preferences:') || /^repository:R\d+:cache$/.test(key)) && value && typeof value === 'object' && 'accessEpoch' in value && typeof value.accessEpoch === 'number' && value.accessEpoch < session.accessEpoch) return false;
    if (key.startsWith('workboard-move:') && draftObjects(key, value).some(id => session.unavailableObjects.has(id) || (session.visibleObjects !== null && !session.visibleObjects.has(id)))) return quarantine({ key, objectId: objectFromKey(key)!, value, reason: 'A selected move reference is no longer available' });
    if (blockedDraft(key, value)) { if (!hasSavedWork(key, value)) return true; return quarantine({ key, objectId: objectFromKey(key) || draftObjects(key, value)[0] || 'S1', value, reason: 'Permission to submit this draft changed' }); }
    if (hasDraftHold(key)) return false;
    if (key === 'outbox' && Array.isArray(value)) {
      const held = rawOutbox().filter(item => heldFamily(`outbox:${item.id}`));
      value = [...held, ...(value as PendingMutation[]).filter(item => !held.some(saved => saved.id === item.id) && !heldFamily(`outbox:${item.id}`))];
    }
    return rawWrite(key, value);
  };
  const writeDiscussionChoice = async (key: string, expected: unknown, value: unknown, stillCurrent: () => boolean = () => true): Promise<'saved' | 'memory' | 'changed' | 'unavailable'> => {
    if (!/^discussion-choice:[DPL]\d+:[^:]+$/.test(key)) return 'unavailable';
    const commit = () => {
      syncDurableQuarantine();
      const objectId = objectFromKey(key)!;
      if (!stillCurrent() || !sessionIsActive(session) || unavailableObject(objectId) || unavailableObject(session.revisionRepositories.get(objectId) || '') || hasDraftHold(key)) return 'unavailable' as const;
      const expectedJson = expected === null ? null : JSON.stringify(expected);
      // Compare both physical copies. A tab's failed write must never shadow and
      // overwrite another tab's newer durable choice.
      let durableValue: string | null = null;
      try { durableValue = durable ? localStorage.getItem(contentKey(key)) : session.memory.get(key) || null; } catch { /* Failed storage still retains the current tab's memory. */ }
      const memory = durable ? session.memory.get(`${key}:unsaved-memory`) || null : null;
      if ((memory || durableValue) !== expectedJson || (memory && durableValue && durableValue !== expectedJson)) return 'changed' as const;
      return writeStored(key, value) ? 'saved' as const : 'memory' as const;
    };
    if (typeof navigator !== 'undefined' && navigator.locks) return navigator.locks.request(contentKey(`presentation-write:${key}`), commit);
    return commit();
  };
  const draftHasUnsavedMemory = (key: string): boolean => {
    const shadow = durable ? session?.memory.get(`${key}:unsaved-memory`) : undefined;
    if (shadow === undefined) return false;
    try { return localStorage.getItem(contentKey(key)) !== shadow; } catch { return true; }
  };
  /** Retain immediately, then compare-and-swap only this editor's durable baseline. */
  const retainDraft = async (key: string, value: unknown, expectedPrevious: unknown, isCurrent: () => boolean = () => true): Promise<'saved' | 'memory' | 'unavailable'> => {
    const lock = retainedDraftLockName(key);
    if (!lock || key.startsWith('discussion-choice:') || key.endsWith(':unsaved-memory')) return 'unavailable';
    // Capture the caller's bytes before any asynchronous work or callback.
    let json: string, expected: string | null, captured: unknown;
    try {
      json = JSON.stringify(value); expected = expectedPrevious === null ? null : JSON.stringify(expectedPrevious);
      if (typeof json !== 'string' || (expected !== null && typeof expected !== 'string')) return 'unavailable';
      captured = JSON.parse(json) as unknown;
    } catch { return 'unavailable'; }
    syncDurableQuarantine();
    const allowed = () => {
      try { assertSession(session); if (!isCurrent()) return false; } catch { return false; }
      return validPrivateReviewStorage(key, captured) && !hasDraftHold(key) && !blockedDraft(key, captured) && !draftObjects(key, captured).some(id => session!.unavailableObjects.has(id));
    };
    if (!allowed() || !session) return 'unavailable';
    if (!durable) { session.memory.set(key, json); return 'saved'; }
    let states = draftRetentions.get(session);
    if (!states) {
      states = new Map(); draftRetentions.set(session, states); const owner = session;
      session.cleanupCallbacks.add(() => { states!.clear(); draftRetentions.delete(owner); clearedDraftBaselines.delete(owner); });
    }
    const shadowKey = `${key}:unsaved-memory`, previousShadow = session.memory.get(shadowKey);
    let state = states.get(key);
    if (!state || previousShadow !== state.latest) {
      const cleared = clearedDraftBaselines.get(session);
      state = { baseline: expected !== null && cleared?.get(key) === expected ? null : expected, latest: json, generation: 0 };
      states.set(key, state); cleared?.delete(key);
    } else if (expected !== state.latest && json !== state.latest) return 'unavailable';
    state.latest = json; const generation = ++state.generation;
    session.memory.set(shadowKey, json);
    const commit = () => {
      syncDurableQuarantine();
      if (!allowed() || states!.get(key) !== state || session.memory.get(shadowKey) !== json) return 'unavailable' as const;
      if (state.generation !== generation) return 'memory' as const;
      try {
        const current = localStorage.getItem(contentKey(key));
        if (current !== state.baseline && current !== json) return 'memory' as const;
        localStorage.setItem(contentKey(key), json); state.baseline = json;
        return 'saved' as const;
      } catch { return 'memory' as const; }
    };
    // Without a writer lock we retain a private recovery copy, never overwrite a
    // physical draft after an uncoordinated check against another tab's work.
    if (typeof navigator === 'undefined' || !navigator.locks) return 'memory';
    try { return await navigator.locks.request(contentKey(lock), commit); }
    catch { return allowed() && session.memory.get(shadowKey) === json ? 'memory' : 'unavailable'; }
  };
  const retainTranscriptEditDraft = (key: string, value: unknown, expectedPrevious: unknown): Promise<'saved' | 'memory' | 'unavailable'> =>
    /^transcript-edit-draft:[DPL][1-9]\d{0,14}:[A-Za-z0-9_-]+$/.test(key) ? retainDraft(key, value, expectedPrevious) : Promise.resolve('unavailable');
  const clearDiscussionChoice = async (key: string, expected: unknown, stillCurrent: () => boolean = () => true): Promise<boolean> => {
    if (!/^discussion-choice:[DPL]\d+:[^:]+$/.test(key)) return false;
    const commit = () => { if (!stillCurrent() || !sessionIsActive(session) || unavailableObject(objectFromKey(key)!)) return false; return removeStoredIfEqual(key, expected); };
    if (typeof navigator !== 'undefined' && navigator.locks) return navigator.locks.request(contentKey(`presentation-write:${key}`), commit);
    return commit();
  };
  const removeStored = (key: string): void => {
    if (!sessionIsActive(session) || heldFamily(key)) return;
    rawRemove(key);
  };
  const removeStoredIfEqual = (key: string, expected: unknown): boolean => {
    syncDurableQuarantine();
    if (!sessionIsActive(session) || hasDraftHold(key)) return false;
    return rawRemoveMatching(key, expected);
  };
  /** Cleanup shares the writer lock, pins each physical copy, and retires queued older writes. */
  const removeRetainedDraftIfEqual = async (key: string, expected: unknown, isCurrent: () => boolean = () => true): Promise<boolean> => {
    const lock = retainedDraftLockName(key);
    if (!lock || key.startsWith('discussion-choice:') || key.endsWith(':unsaved-memory')) return false;
    let json: string;
    try { json = JSON.stringify(expected); if (typeof json !== 'string') return false; expected = JSON.parse(json) as unknown; } catch { return false; }
    syncDurableQuarantine();
    const allowed = () => {
      try { assertSession(session); if (!isCurrent()) return false; } catch { return false; }
      return !hasDraftHold(key) && !blockedDraft(key, expected) && !draftObjects(key, expected).some(id => session!.unavailableObjects.has(id));
    };
    if (!allowed() || !session) return false;
    if (!durable) {
      const saved = session.memory.get(key);
      if (saved !== undefined && saved !== json) return false;
      session.memory.delete(key); return true;
    }
    // A retired write still has exportable bytes until cleanup actually commits.
    const shadowKey = `${key}:unsaved-memory`, states = draftRetentions.get(session);
    if (states?.get(key)?.latest === json) states.delete(key);
    const remainingState = states?.get(key), memory = session.memory.get(key), shadow = session.memory.get(shadowKey);
    const unchangedMemory = () => session.memory.get(key) === memory && session.memory.get(shadowKey) === shadow
      && (memory === undefined || memory === json) && (shadow === undefined || shadow === json)
      && draftRetentions.get(session)?.get(key) === remainingState;
    const commit = (canRemoveDurable: boolean) => {
      syncDurableQuarantine();
      if (!allowed() || !unchangedMemory()) return false;
      try {
        const saved = localStorage.getItem(contentKey(key));
        if (saved === json) {
          if (!canRemoveDurable) return false;
          localStorage.removeItem(contentKey(key));
        } else if (saved !== null && memory !== json && shadow !== json) return false;
        if (memory === json) session.memory.delete(key);
        if (shadow === json) session.memory.delete(shadowKey);
        let cleared = clearedDraftBaselines.get(session);
        if (!cleared) { cleared = new Map(); clearedDraftBaselines.set(session, cleared); }
        cleared.set(key, json);
        return true;
      } catch { return false; }
    };
    if (typeof navigator === 'undefined' || !navigator.locks) return commit(false);
    try { return await navigator.locks.request(contentKey(lock), () => commit(true)); }
    catch { return false; }
  };
  const removeTranscriptEditStoredIfEqual = (key: string, expected: unknown, isCurrent: () => boolean = () => true): Promise<boolean> =>
    /^transcript-edit-(?:draft:[DPL][1-9]\d{0,14}:[A-Za-z0-9_-]+|request:[DPL][1-9]\d{0,14})$/.test(key) ? removeRetainedDraftIfEqual(key, expected, isCurrent) : Promise.resolve(false);
  const unavailableObject = (id: string) => session?.unavailableObjects.has(id) ?? false;
  const onAccessChange = (listener: (ids: string[]) => void) => {
    session?.accessListeners.add(listener);
    return () => { session?.accessListeners.delete(listener); };
  };
  const invalidateObjects = (ids: string[]) => {
    if (!sessionIsActive(session)) return;
    learnSavedRevisionSources();
    const linked = [...session.revisionRepositories].filter(([, repositoryId]) => ids.includes(repositoryId)).map(([id]) => id);
    linked.push(...[...session.revisionFiles].filter(([, files]) => ids.some(id => files.has(id))).map(([id]) => id));
    const changed = [...new Set([...ids, ...linked])].filter(id => !session.unavailableObjects.has(id));
    if (!changed.length) return;
    session.accessGeneration += 1;
    invalidateTaskSnapshots();
    for (const id of changed) {
      session.unavailableObjects.add(id);
      session.objectGenerations.set(id, (session.objectGenerations.get(id) || 0) + 1);
      for (const [controller, objectId] of session.objectControllers) if (objectId === id) controller.abort();
    }
    const entries = savedEntries();
    const heldFamilies = new Set(entries.flatMap(([key, json]) => { try { return isRetainedDraftKey(key) && draftObjects(key, JSON.parse(json)).some(id => changed.includes(id)) ? [key.replace(/:unsaved-memory$/, '')] : []; } catch { return []; } }));
    for (const [key, json] of entries) {
      let value: unknown; try { value = JSON.parse(json); } catch { continue; }
      const objectId = objectFromKey(key) || draftObjects(key, value)[0];
      if (!objectId || (!draftObjects(key, value).some(id => changed.includes(id)) && !heldFamilies.has(key.replace(/:unsaved-memory$/, '')))) continue;
      if (isDraftKey(key)) {
        if (hasSavedWork(key, value)) quarantine({ key, objectId, value, reason: 'Object access changed' });
        // A synchronous access notification cannot acquire the draft writer's
        // lock. Hold originals immediately; explicit recovery removes them.
      } else removeStored(key);
    }
    const queued = readStored<PendingMutation[]>('outbox', []);
    const affected = queued.filter(item => changed.includes(queuedObject(item) || '') || item.wikiAuthority?.ancestorIds.some(id => changed.includes(id)));
    for (const item of affected) quarantine({ key: `outbox:${item.id}`, objectId: queuedObject(item)!, value: item, reason: 'Object or destination Space access changed; automatic submission stopped' });
    // Aggregate snapshots can contain any of the revoked objects; refetch them.
    removeStored('state');
    for (const listener of session.accessListeners) listener(changed);
  };
  const reconcileAccess = (access: Record<string, ObjectAccess>, epoch: number, spaceIds: string[] = [], archivedSpaceIds: string[] = []): void => {
    assertSession(session);
    if (!Number.isSafeInteger(epoch) || epoch < session.accessEpoch) throw new RequestError('Access changed while loading. Reload the workspace.', 409, 'ACCESS_CHANGED');
    const visible = new Set([...Object.keys(access), ...spaceIds]);
    // Old presentation caches are not renderable, but their IDs still matter for revocation.
    const cachedState = (() => { try { return JSON.parse(rawRead('state') || 'null') as { access?: Record<string, ObjectAccess>; spaces?: { id: string }[] } | null; } catch { return null; } })();
    const cachedObjects = savedEntries().flatMap(([key, json]) => { try { return draftObjects(key, JSON.parse(json)); } catch { return []; } });
    const known = new Set([...(session.visibleObjects || []), ...session.objectGenerations.keys(), ...cachedObjects, ...rawOutbox().map(queuedObject).filter((id): id is string => id !== null), ...Object.keys(cachedState?.access || {}), ...(cachedState?.spaces || []).map(space => space.id)]);
    invalidateObjects([...known].filter(id => !visible.has(id)));
    for (const [id, value] of Object.entries(access)) session.objectCapabilities.set(id, value.capabilities);
    let draftsChanged = false;
    const draftEntries = savedEntries();
    const blockedFamilies = new Set(draftEntries.flatMap(([key, json]) => { try { return isRetainedDraftKey(key) && blockedDraft(key, JSON.parse(json)) ? [key.replace(/:unsaved-memory$/, '')] : []; } catch { return []; } }));
    for (const [key, json] of draftEntries) {
      try { const value: unknown = JSON.parse(json); if (!blockedDraft(key, value) && !blockedFamilies.has(key.replace(/:unsaved-memory$/, ''))) continue; if (hasSavedWork(key, value)) { quarantine({ key, objectId: objectFromKey(key) || draftObjects(key, value)[0] || 'S1', value, reason: 'Permission to submit this draft changed' }); draftsChanged = true; } } catch { /* Preserve unreadable draft bytes in place. */ }
    }
    const queue = readStored<PendingMutation[]>('outbox', []);
    const forbidden = queue.filter(item => { const id = queuedObject(item); if (item.wikiAuthority && (item.wikiAuthority.ancestorIds.some(ancestor => !visible.has(ancestor)) || (item.wikiAuthority.parentId && session.objectCapabilities.get(item.wikiAuthority.parentId)?.edit === false))) return true; if (id?.startsWith('S')) return !spaceIds.includes(id) || archivedSpaceIds.includes(id); const capabilities = id ? session.objectCapabilities.get(id) : null; return capabilities && !((item.path.endsWith('/comments') || item.path.endsWith('/replies')) ? capabilities.interact : capabilities.edit); });
    for (const item of forbidden) { quarantine({ key: `outbox:${item.id}`, objectId: queuedObject(item)!, value: item, reason: 'Permission or destination Space changed; automatic submission stopped' }); draftsChanged = true; }
    if (draftsChanged) for (const listener of session.accessListeners) listener([]);
    session.visibleObjects = visible;
    if (epoch !== session.accessEpoch) invalidateTaskSnapshots();
    session.accessEpoch = epoch;
    for (const id of visible) session.unavailableObjects.delete(id);
    verifiedAuthorityEpochs.set(session, epoch);
  };
  const quarantinedDrafts = () => { syncDurableQuarantine(); return sessionIsActive(session) ? [...session.quarantinedDrafts.values()] : []; };
  const quarantineWarning = () => sessionIsActive(session) ? session.quarantineWarning : '';
  const retryQuarantineStorage = () => { assertSession(session); syncDurableQuarantine(); const saved = persistQuarantine(); quarantineChanged(); return saved; };
  const recoveryLock = (key: string): string | null => key.startsWith('outbox:') ? 'outbox-write' : key.replace(/:unsaved-memory$/, '') === 'file-uploads' ? 'file-uploads-write' : retainedDraftLockName(key);
  const withRecoveryLock = async (key: string, commit: () => void): Promise<void> => {
    if (!durable) { commit(); return; }
    const lock = recoveryLock(key);
    if (!lock || typeof navigator === 'undefined' || !navigator.locks) throw new Error('This browser cannot safely coordinate recovery cleanup between tabs. Your saved copies are unchanged. Export them or retry in a browser with Web Locks support.');
    await navigator.locks.request(contentKey(lock), commit);
  };
  const sameRecovery = (left: QuarantinedDraft | undefined | null, right: QuarantinedDraft): boolean => Boolean(left && JSON.stringify(left) === JSON.stringify(right));
  const removeRecoveryRecord = (recovery: QuarantinedDraft): void => {
    assertSession(session);
    if (!sameRecovery(session.quarantinedDrafts.get(recovery.recoveryId), recovery)) return;
    if (durable) {
      const physical = localStorage.getItem(contentKey(recordKey(recovery.recoveryId)));
      if (physical !== null && !sameRecovery(parseDraft(physical, recovery.recoveryId), recovery)) throw new Error('This recovery copy changed. Review its current contents before discarding it.');
      if (physical !== null) localStorage.removeItem(contentKey(recordKey(recovery.recoveryId)));
    }
    session.quarantinedDrafts.delete(recovery.recoveryId); session.quarantinePending.delete(recovery.recoveryId); session.quarantinePersisted.delete(recovery.recoveryId);
  };
  // Capture generations before waiting. A later edit with identical text is
  // still a new edit, and must not be removed by an older receipt or click.
  const matchingOriginalCleanup = (key: string, expected: unknown): (() => void) => {
    assertSession(session);
    const json = JSON.stringify(expected), base = key.replace(/:unsaved-memory$/, ''), states = draftRetentions.get(session);
    if (states?.get(base)?.latest === json) states.delete(base);
    const state = states?.get(base), generation = state?.generation, memory = session.memory.get(key), shadowKey = `${key}:unsaved-memory`, shadow = session.memory.get(shadowKey);
    return () => {
      assertSession(session);
      if (draftRetentions.get(session)?.get(base) !== state || state?.generation !== generation) return;
      if (key.startsWith('outbox:')) {
        const existing = rawOutbox(), next = existing.filter(item => JSON.stringify(item) !== json);
        if (next.length !== existing.length && !rawWrite('outbox', next)) throw new Error('The original queued change could not be removed. Export it before retrying.');
      } else {
        let removed = false;
        if (durable && localStorage.getItem(contentKey(key)) === json) { localStorage.removeItem(contentKey(key)); removed = true; }
        if (memory === json && session.memory.get(key) === memory) { session.memory.delete(key); removed = true; }
        if (durable && !key.endsWith(':unsaved-memory') && shadow === json && session.memory.get(shadowKey) === shadow) { session.memory.delete(shadowKey); removed = true; }
        // Like ordinary exact cleanup, this authorizes a still-mounted editor
        // to restart from the absent slot after its acknowledged old value.
        // A newer retained generation continues to own its own baseline.
        if (durable && removed && !state) {
          let cleared = clearedDraftBaselines.get(session);
          if (!cleared) { cleared = new Map(); clearedDraftBaselines.set(session, cleared); }
          cleared.set(base, json);
        }
      }
    };
  };
  const discardQuarantinedDraft = async (selected: QuarantinedDraft | string): Promise<void> => {
    assertSession(session); syncDurableQuarantine();
    // Legacy callers resolve once, before the first await. UI callers pass the
    // clicked record so another same-key recovery can never take its place.
    const candidate = typeof selected === 'string' ? session.quarantinedDrafts.get(selected) || heldDrafts(selected)[0] : selected;
    if (!candidate) return;
    const recovery = JSON.parse(JSON.stringify(candidate)) as QuarantinedDraft;
    if (!sameRecovery(session.quarantinedDrafts.get(recovery.recoveryId), recovery)) return;
    const clearOriginal = matchingOriginalCleanup(recovery.key, recovery.value);
    await withRecoveryLock(recovery.key, () => {
      assertSession(session); syncDurableQuarantine();
      if (!sameRecovery(session.quarantinedDrafts.get(recovery.recoveryId), recovery)) return;
      clearOriginal(); removeRecoveryRecord(recovery); quarantineChanged();
    });
  };
  /** Clear only confirmed copies; a newer draft in either storage tier survives. */
  const acknowledgeRevisionAuthorIntent = async (requestKey: string, intent: unknown, draftKey: string, draft: unknown): Promise<void> => {
    assertSession(session);
    const id = /^revision-author-request:([DPL][1-9]\d*)$/.exec(requestKey)?.[1];
    if (!id || draftKey !== `revision-author-draft:${id}`) throw new Error('Invalid authorship recovery keys.');
    syncDurableQuarantine();
    const copies = ([[requestKey, intent], [draftKey, draft]] as const).map(([key, expected]) => ({ key, clearOriginal: matchingOriginalCleanup(key, expected), recoveries: [...session.quarantinedDrafts.values()].filter(held => held.key.replace(/:unsaved-memory$/, '') === key && JSON.stringify(held.value) === JSON.stringify(expected)).map(held => JSON.parse(JSON.stringify(held)) as QuarantinedDraft) }));
    // Authorship handoff intentionally permits cleanup after view loss, but
    // only for the verified submission in the still-active original session.
    for (const copy of copies) await withRecoveryLock(copy.key, () => {
      assertSession(session); syncDurableQuarantine(); copy.clearOriginal();
      for (const recovery of copy.recoveries) removeRecoveryRecord(recovery);
      quarantineChanged();
    });
  };
  let initialTaskAccessVerification: Promise<unknown> | null = null;
  const request = async <T,>(path: string, options?: { method: MutationMethod; body: unknown; id?: string; queued?: boolean }, authorityIds: readonly string[] = []): Promise<T> => {
    assertSession(session);
    syncDurableQuarantine();
    if (options?.queued) { holdLegacyTaskUpdates(); if (!canQueue(path, options.method, options.body)) throw new RequestError('This operation requires an explicit online save and cannot submit from the outbox.', 403, 'ACTION_FORBIDDEN'); }
    if (options?.queued && (!options.id || !readStored<PendingMutation[]>('outbox', []).some(item => item.id === options.id))) throw new RequestError('This queued change was removed or set aside and cannot submit automatically.', 403, 'ACTION_FORBIDDEN');
    if (options?.id && heldFamily(`outbox:${options.id}`)) throw new RequestError('This saved change is set aside for export or discard and cannot submit automatically.', 403, 'ACTION_FORBIDDEN');
    const childParent = path === '/api/projects' && options?.method === 'POST' && options.body && typeof options.body === 'object' && 'parentId' in options.body && typeof options.body.parentId === 'string' ? options.body.parentId : null;
    const notificationRequest = /^\/api\/notifications(?:[/?]|$)/.test(path);
    const stackRequest = !options && /^\/api\/revisions\/[DPL]\d+\/dependencies\/graph(?:[?]|$)/.test(path);
    const revisionProjectRequest = /^\/api\/revisions\/[DPL]\d+\/projects(?:[/?]|$)/.test(path);
    const objectSubscriptionRequest = /^\/api\/objects\/(?:W|PA)[1-9]\d*\/subscriptions(?:[/?]|$)/.test(path);
    const revisionSubscriptionRequest = /^\/api\/revisions\/[DPL]\d+\/subscriptions(?:[/?]|$)/.test(path);
    const reviewDraftRequest = /^\/api\/(?:review-drafts(?:[?]|$)|revisions\/[DPL]\d+\/review-drafts(?:[/?]|$))/.test(path);
    const reviewDraftDiscard = reviewDraftRequest && options?.method === 'POST' && /\/discard$/.test(path);
    if (reviewDraftRequest && options?.queued) throw new RequestError('Private review drafts require an explicit online action and cannot be queued.', 403, 'ACTION_FORBIDDEN');
    const metadataRequest = /^\/api\/revisions\/[DPL]\d+\/metadata(?:[/?]|$)/.test(path);
    const reviewerRequest = /^\/api\/revisions\/[DPL]\d+\/reviewers(?:[/?]|$)/.test(path);
    const reviewerMutationAuthority = reviewerRequest && options ? reviewerAuthority(options.body) : null;
    const lifecycleRequest = /^\/api\/revisions\/[DPL]\d+\/lifecycle(?:[/?]|$)/.test(path);
    const authorRequest = /^\/api\/revisions\/[DPL]\d+\/authorship(?:[/?]|$)/.test(path);
    const authorMutation = authorRequest && options?.method === 'POST' && /^\/api\/revisions\/[DPL]\d+\/authorship$/.test(path) && Boolean(options.id) ? authorDraft(options.body) : null;
    const authorRecovery = Boolean(authorMutation && session.unavailableObjects.has(objectFromPath(path) || ''));
    const dependencyRequest = /^\/api\/revisions\/[DPL]\d+\/dependencies(?:[/?]|$)/.test(path);
    const citationRequest = /^\/api\/revisions\/[DPL]\d+\/(?:citations|citation-evidence)(?:[/?]|$)/.test(path);
    const docxRequest = /^\/api\/revisions(?:\/[DPL]\d+)?\/docx(?:[/?]|$)/.test(path);
    const docxDiscussionExport = options?.method === 'POST' && /^\/api\/revisions\/[DPL]\d+\/docx\/export-discussion$/.test(path);
    const pasteRequest = /^\/api\/pastes(?:[/?]|$)/.test(path);
    const wikiRequest = /^\/api\/(?:wiki(?:[/?]|$)|documents(?:[/?]|$))/.test(path);
    const repositoryRequest = !options && /^\/api\/repositories\/R\d+(?:[/?]|$)/.test(path);
    const taskRequest = reviewDraftRequest || objectSubscriptionRequest || revisionProjectRequest || revisionSubscriptionRequest || metadataRequest || reviewerRequest || lifecycleRequest || authorRequest || dependencyRequest || repositoryRequest || wikiRequest || /^\/api\/revisions\/L\d+$/.test(path) || docxRequest || pasteRequest || citationRequest || Boolean(childParent) || /^\/api\/files(?:[/?]|$)/.test(path) || /^\/api\/(?:tasks\/T|projects\/PROJ)\d+(?:[/?]|$)/.test(path);
    if ((notificationRequest && options || options || reviewDraftRequest || objectSubscriptionRequest || revisionProjectRequest || revisionSubscriptionRequest || metadataRequest || reviewerRequest || lifecycleRequest || authorRequest || dependencyRequest || docxRequest || pasteRequest || citationRequest || path.startsWith('/api/files')) && (taskRequest || notificationRequest) && (session.accessEpoch < 0 || Boolean(options && !authorRecovery && (session.visibleObjects === null || verifiedAuthorityEpochs.get(session) !== session.accessEpoch)))) {
      // Cached task controls may render before startup's state read completes. Verify
      // access before sending a write so that first verification cannot invalidate
      // its successful response. An informational read can learn the epoch before
      // the workspace has supplied visibility and capabilities; that is not write
      // authority. Later epoch changes still reject stale content.
      initialTaskAccessVerification ??= request('/api/state').finally(() => { initialTaskAccessVerification = null; });
      await initialTaskAccessVerification;
      assertSession(session);
      if (session.accessEpoch < 0 || options && (session.visibleObjects === null || verifiedAuthorityEpochs.get(session) !== session.accessEpoch)) throw new RequestError('Workspace access could not be verified. Reconnect before saving this object.', 409, 'ACCESS_CHANGED');
      const initialTarget = childParent || objectFromPath(path);
      if (options && !authorMutation && initialTarget && !session.visibleObjects!.has(initialTarget)) { invalidateObjects([initialTarget]); throw unavailable(); }
      syncDurableQuarantine();
      if (options?.queued && (!options.id || !readStored<PendingMutation[]>('outbox', []).some(item => item.id === options.id))) throw new RequestError('This queued change was removed or set aside and cannot submit automatically.', 403, 'ACTION_FORBIDDEN');
      if (options?.id && heldFamily(`outbox:${options.id}`)) throw new RequestError('This saved change is set aside for export or discard and cannot submit automatically.', 403, 'ACTION_FORBIDDEN');
    }
    const objectId = childParent || objectFromPath(path);
    const sourceRepository = objectId ? session.revisionRepositories.get(objectId) : undefined;
    if (!authorMutation && sourceRepository && session.unavailableObjects.has(sourceRepository)) throw unavailable();
    const accessGeneration = session.accessGeneration;
    if (objectId && !objectId.startsWith('S') && !session.objectGenerations.has(objectId)) session.objectGenerations.set(objectId, 0);
    const objectGeneration = objectId ? session.objectGenerations.get(objectId) || 0 : 0;
    const boardMutation = Boolean(options && /^\/api\/projects\/PROJ\d+\/workboard(?:\/|$)/.test(path));
    const boardMove = boardMutation && path.endsWith('/moves') && options?.body && typeof options.body === 'object' ? options.body as { taskId?: unknown; position?: { beforeTaskId?: unknown; afterTaskId?: unknown } } : null;
    const importSource = /^\/api\/projects\/PROJ\d+\/workboard\/import-preview\?/.test(path) && !options ? new URLSearchParams(path.split('?')[1]).get('sourceProjectId') : boardMutation && path.endsWith('/import') && options?.body && typeof options.body === 'object' && 'sourceProjectId' in options.body && typeof options.body.sourceProjectId === 'string' ? options.body.sourceProjectId : null;
    const bulkMove = boardMutation && path.endsWith('/bulk-moves') && options?.body && typeof options.body === 'object' ? options.body as { destinationProjectId?: unknown; tasks?: { taskId?: unknown }[] } : null;
    const bulkDestination = /^\/api\/projects\/PROJ\d+\/workboard\/bulk-move-preview\?/.test(path) && !options ? new URLSearchParams(path.split('?')[1]).get('destinationProjectId') : bulkMove && typeof bulkMove.destinationProjectId === 'string' ? bulkMove.destinationProjectId : null;
    const bulkTaskIds = bulkMove && Array.isArray(bulkMove.tasks) ? bulkMove.tasks.flatMap(task => task && typeof task.taskId === 'string' ? [task.taskId] : []) : [];
    const queuedWiki = options?.queued ? readStored<PendingMutation[]>('outbox', []).find(item => item.id === options.id)?.wikiAuthority : undefined;
    if (queuedWiki?.parentId && session.objectCapabilities.get(queuedWiki.parentId)?.edit === false) throw new RequestError('The wiki parent is no longer editable. Export this creation draft.', 403, 'ACTION_FORBIDDEN');
    const creationProjects = options && (path === '/api/revisions' || path === '/api/revisions/docx' || /^\/api\/repositories\/R\d+\/import-revision$/.test(path)) && options.body && typeof options.body === 'object' ? options.body as { projectIds?: unknown; projectId?: unknown } : null;
    const selectedProjectIds = revisionProjectRequest && options?.body && typeof options.body === 'object' && 'projectIds' in options.body && Array.isArray(options.body.projectIds) ? options.body.projectIds.filter((id): id is string => typeof id === 'string' && /^PROJ\d+$/.test(id)) : creationProjects ? Array.isArray(creationProjects.projectIds) ? creationProjects.projectIds.filter((id): id is string => typeof id === 'string' && /^PROJ\d+$/.test(id)) : typeof creationProjects.projectId === 'string' && /^PROJ\d+$/.test(creationProjects.projectId) ? [creationProjects.projectId] : [] : [];
    const relatedIds = [...new Set([...authorityIds, ...selectedProjectIds, ...(queuedWiki?.ancestorIds || []), ...(bulkDestination ? [bulkDestination, ...bulkTaskIds] : importSource ? [importSource] : boardMove ? [boardMove.taskId, boardMove.position?.beforeTaskId, boardMove.position?.afterTaskId].filter((id): id is string => typeof id === 'string') : [])])];
    const relatedGenerations = relatedIds.map(id => ({ id, generation: session.objectGenerations.get(id) || 0 }));
    const referenceUnavailable = () => {
      if (revisionProjectRequest || selectedProjectIds.some(id => session.unavailableObjects.has(id) || session.visibleObjects !== null && !session.visibleObjects.has(id) || relatedGenerations.some(item => item.id === id && item.generation !== (session.objectGenerations.get(id) || 0)))) return new RequestError('A selected project is unavailable. Your tag draft remains available for export.', 404, 'REVISION_PROJECT_UNAVAILABLE');
      if (dependencyRequest) return new RequestError('A selected related revision is unavailable. Your relationship draft remains available for export.', 404, 'REVISION_DEPENDENCY_UNAVAILABLE');
      if (wikiRequest) return new RequestError('A wiki parent or destination is unavailable. Your draft remains available for export.', 404, 'WIKI_PATH_UNAVAILABLE');
      if (docxRequest) return new RequestError('The original Word file is unavailable. Your unsaved work remains available for export.', 404, 'DOCX_SOURCE_UNAVAILABLE');
      if (citationRequest) return new RequestError('The supporting File is unavailable. Your evidence draft remains available for export.', 404, 'CITATION_SOURCE_UNAVAILABLE');
      if (/^\/api\/revisions\/[DPL]\d+\/import-git$/.test(path)) return new RequestError('The source repository is unavailable. The original version import request is retained for export or explicit retry after access returns.', 404, 'REPOSITORY_REFERENCE_UNAVAILABLE');
      const changed = (id: string) => session.unavailableObjects.has(id) || (session.visibleObjects !== null && !session.visibleObjects.has(id)) || relatedGenerations.some(item => item.id === id && item.generation !== (session.objectGenerations.get(id) || 0));
      const code = authorityIds.some(changed) ? 'COLUMN_UNAVAILABLE' : bulkTaskIds.some(changed) ? 'TASK_REFERENCE_UNAVAILABLE' : (bulkDestination || importSource) ? 'PROJECT_REFERENCE_UNAVAILABLE' : 'TASK_REFERENCE_UNAVAILABLE';
      return new RequestError(bulkDestination ? 'A selected column, project or task is no longer available. Review a new bulk move preview.' : importSource ? 'The source project is no longer available. Its import preview has been removed.' : 'A selected card is no longer available. Review the move before saving.', 404, code);
    };
    if (relatedIds.some(id => session.unavailableObjects.has(id) || (session.visibleObjects !== null && !session.visibleObjects.has(id)))) throw referenceUnavailable();
    const ownershipMutation = options?.method === 'PATCH' && /^\/api\/tasks\/T\d+$/.test(path) && options.body && typeof options.body === 'object' && 'ownerId' in options.body;
    const projectMutation = Boolean(childParent) || Boolean(options && /^\/api\/projects\/PROJ\d+(?:\/(membership|members|watchers|silence))?$/.test(path));
    let taskGeneration = session.taskSnapshotGeneration;
    let stackGeneration = stacks?.generation;
    let notificationGeneration = notifications?.generation;
    if (!authorMutation && objectId && session.unavailableObjects.has(objectId)) throw unavailable();
    const capabilities = objectId ? session.objectCapabilities.get(objectId) : null;
    const subscription = /^\/api\/tasks\/T\d+\/subscriptions$/.test(path) && options?.method === 'POST' ? options.body as { principalId?: unknown; action?: unknown } | null : null;
    const selfId = session.state.account?.id || `local:${session.state.workspaceId}`;
    const projectSelfOperation = projectMutation && (/\/(membership|silence)$/.test(path) || (path.endsWith('/watchers') && options?.body && typeof options.body === 'object' && 'principalId' in options.body && options.body.principalId === selfId));
    const followingAuthority = options ? objectSubscriptionRequest ? objectSubscriptionAuthority(options.body, selfId) : revisionSubscriptionRequest ? subscriptionAuthority(options.body, selfId) : null : null;
    const mutationAllowed = capabilities && (/^\/api\/tasks\/T\d+\/mute$/.test(path) && options?.method === 'POST' ? true : objectSubscriptionRequest || revisionSubscriptionRequest ? followingAuthority === 'view' || followingAuthority === 'interact_or_edit' && (capabilities.interact || capabilities.edit) || followingAuthority === 'edit' && capabilities.edit : reviewDraftRequest ? reviewDraftDiscard || capabilities.interact : reviewerRequest ? reviewerMutationAuthority !== null && capabilities[reviewerMutationAuthority] : docxDiscussionExport ? true : citationRequest ? capabilities.interact : bulkMove ? bulkTaskIds.length > 0 && bulkTaskIds.length === bulkMove.tasks?.length && bulkTaskIds.every(id => session.objectCapabilities.get(id)?.edit === true) : boardMove ? typeof boardMove.taskId === 'string' && session.objectCapabilities.get(boardMove.taskId)?.edit === true : projectSelfOperation ? true : /^\/api\/revisions\/[DPL]\d+\/threads\/[^/]+\/preference$/.test(path) ? true : subscription ? subscription.principalId === selfId ? true : subscription.action === 'subscribe' ? capabilities.interact || capabilities.edit : capabilities.edit : /\/(comments|reviews|replies)(?:[/?]|$)/.test(path) ? capabilities.interact : capabilities.edit);
    if (!authorMutation && options && capabilities && !mutationAllowed) throw new RequestError('Permission to submit this change has been revoked. Export your unsaved draft to keep it.', 403, 'ACTION_FORBIDDEN');
    const assertObject = () => {
      assertSession(session);
      if (objectId && [...(session.revisionFiles.get(objectId) || [])].some(id => session.unavailableObjects.has(id))) { invalidateObjects([objectId]); throw unavailable(); }
      if (objectId && session.unavailableObjects.has(session.revisionRepositories.get(objectId) || '')) { invalidateObjects([objectId]); throw unavailable(); }
      if (objectId && (session.unavailableObjects.has(objectId) || (session.objectGenerations.get(objectId) || 0) !== objectGeneration)) throw unavailable();
      if (relatedGenerations.some(({ id, generation }) => session.unavailableObjects.has(id) || (session.objectGenerations.get(id) || 0) !== generation)) throw referenceUnavailable();
      if (notificationRequest && notificationGeneration !== notifications?.generation) throw new RequestError('Notification visibility changed. Reload your inbox; the exact request is retained.', 409, 'ACCESS_CHANGED');
      if (stackRequest && stackGeneration !== stacks?.generation) throw new RequestError('The revision stack changed while loading. Reload its current relationships.', 409, 'REVISION_STACK_CHANGED');
      if (taskRequest && taskGeneration !== session.taskSnapshotGeneration) throw new RequestError(`${reviewDraftRequest ? 'Private review' : revisionProjectRequest ? 'Revision project tags' : objectSubscriptionRequest ? 'Following' : revisionSubscriptionRequest ? 'Revision following' : metadataRequest ? 'Revision details' : reviewerRequest ? 'Revision reviewers' : lifecycleRequest ? 'Revision lifecycle' : dependencyRequest ? 'Related revision' : repositoryRequest ? 'Repository' : citationRequest ? 'Citation evidence' : path.startsWith('/api/files') ? 'File' : path.startsWith('/api/projects/') ? 'Project' : 'Task'} visibility changed while loading. Reload this object; unsaved drafts are retained.`, 409, 'ACCESS_CHANGED');
    };
    const controller = new AbortController();
    session.controllers.add(controller);
    if (stackRequest) stacks?.controllers.add(controller);
    if (notificationRequest && !options) notifications?.controllers.add(controller);
    if (taskRequest && (!options || docxDiscussionExport)) session.taskReadControllers.add(controller);
    // A committed handoff may revoke this object's access before its receipt arrives.
    // Session invalidation still aborts it; object invalidation must allow the receipt.
    if (objectId && !authorMutation && !ownershipMutation && !projectMutation && !boardMutation) session.objectControllers.set(controller, objectId);
    const headers: Record<string, string> = {};
    if (session.state.sessionContext) headers['X-Session-Context'] = session.state.sessionContext;
    if (options) {
      headers['Content-Type'] = 'application/json'; headers['Idempotency-Key'] = options.id || crypto.randomUUID();
      if (session.state.csrfToken) headers['X-CSRF-Token'] = session.state.csrfToken;
    }
    try {
      const response = await fetch(applicationPath(path), { method: options?.method || 'GET', headers, credentials: 'same-origin', cache: 'no-store', signal: controller.signal, ...(options ? { body: JSON.stringify(options.body) } : {}) });
      assertSession(session);
      if (response.status === 401) { lockSession('Your session ended or changed in another tab. Sign in again.'); throw new RequestError('Your session ended. Sign in again.', 401); }
      const data: unknown = await response.json();
      if (response.ok) rememberRevisionSources(data);
      if (response.ok && bulkMove && !(data && typeof data === 'object' && 'projectId' in data && data.projectId === objectId && 'saved' in data && data.saved === true && 'refreshRequired' in data && data.refreshRequired === true && 'boardVersion' in data && Number.isSafeInteger(data.boardVersion) && Number(data.boardVersion) > 0 && 'destinationProjectId' in data && data.destinationProjectId === bulkDestination && 'destinationBoardVersion' in data && Number.isSafeInteger(data.destinationBoardVersion) && Number(data.destinationBoardVersion) > 0)) throw new RequestError('The server returned an unrecognized move receipt. Keep the submitted request and retry it exactly to confirm the outcome.', 502, 'INVALID_RECEIPT');
      if (response.ok && boardMutation && data && typeof data === 'object' && 'projectId' in data && data.projectId === objectId && 'saved' in data && data.saved === true && 'refreshRequired' in data && data.refreshRequired === true && 'boardVersion' in data && Number.isSafeInteger(data.boardVersion) && Number(data.boardVersion) >= 0) {
        assertSession(session);
        if ('accessEpoch' in data && Number.isSafeInteger(data.accessEpoch) && Number(data.accessEpoch) >= 0) session.accessEpoch = Math.max(session.accessEpoch, Number(data.accessEpoch));
        // A card move may change tags and task versions without a policy change.
        // Never leave an older task, project or board snapshot available offline.
        invalidateTaskSnapshots();
        return { projectId: objectId, saved: true, refreshRequired: true, boardVersion: data.boardVersion, ...(bulkMove && 'destinationProjectId' in data && data.destinationProjectId === bulkDestination && 'destinationBoardVersion' in data && Number.isSafeInteger(data.destinationBoardVersion) && Number(data.destinationBoardVersion) >= 0 ? { destinationProjectId: data.destinationProjectId, destinationBoardVersion: data.destinationBoardVersion } : {}), accessEpoch: session.accessEpoch } as T;
      }
      if (response.ok && authorMutation && objectId) {
        const result = await verifiedAuthorResult(data, objectId, authorMutation, selfId);
        assertSession(session);
        if ('accessLost' in result) {
          session.accessEpoch = Math.max(session.accessEpoch, result.accessEpoch); invalidateObjects([objectId]);
          return result as T;
        }
      }
      // A committed reassignment may remove the caller's view. This content-free receipt
      // remains a success even when a concurrent refresh already observed that loss.
      if (response.ok && (ownershipMutation || projectMutation) && data && typeof data === 'object' && 'id' in data && (data.id === objectId || (childParent && typeof data.id === 'string' && /^PROJ\d+$/.test(data.id))) && 'saved' in data && data.saved === true && 'accessLost' in data && data.accessLost === true && 'accessEpoch' in data && Number.isSafeInteger(data.accessEpoch)) {
        assertSession(session); session.accessEpoch = Math.max(session.accessEpoch, Number(data.accessEpoch)); invalidateObjects([String(data.id)]);
        return { id: data.id, saved: true, accessLost: true, accessEpoch: data.accessEpoch } as T;
      }
      if (response.ok && childParent && data && typeof data === 'object' && 'id' in data && typeof data.id === 'string' && /^PROJ\d+$/.test(data.id) && (session.unavailableObjects.has(childParent) || (session.objectGenerations.get(childParent) || 0) !== objectGeneration || taskGeneration !== session.taskSnapshotGeneration)) {
        // Creation committed, but its returned profile may predate a permission change.
        // Preserve only a receipt; the caller refreshes authorized state before rendering.
        return { id: data.id, saved: true, refreshRequired: true, accessEpoch: session.accessEpoch } as T;
      }
      assertObject();
      if (path === '/api/state' && accessGeneration !== session.accessGeneration) throw new RequestError('Access changed while loading. Reload the workspace.', 409, 'ACCESS_CHANGED');
      if (!response.ok) {
        const code = typeof data === 'object' && data !== null && 'code' in data ? String(data.code) : undefined;
        if (objectId && code === 'OBJECT_UNAVAILABLE') invalidateObjects([objectId]);
        if (docxRequest && code === 'DOCX_SOURCE_UNAVAILABLE') { const body = options?.body as { sourceFile?: { fileId?: unknown } } | undefined; const fileIds = typeof body?.sourceFile?.fileId === 'string' ? [body.sourceFile.fileId] : authorityIds.filter(id => /^F\d+$/.test(id)); if (fileIds.length) invalidateObjects(fileIds); }
        if (citationRequest && code === 'CITATION_SOURCE_UNAVAILABLE') { const source = options?.body && typeof options.body === 'object' && 'source' in options.body ? options.body.source as { fileId?: unknown } | null : null; const fileIds = typeof source?.fileId === 'string' && /^F\d+$/.test(source.fileId) ? [source.fileId] : authorityIds.filter(id => /^F\d+$/.test(id)); if (fileIds.length) invalidateObjects([...fileIds]); }
        if ((importSource || bulkDestination) && code === 'PROJECT_REFERENCE_UNAVAILABLE') invalidateObjects([importSource || bulkDestination!]);
        throw new RequestError(typeof data === 'object' && data !== null && 'error' in data ? String(data.error) : `Request failed (${response.status})`, response.status, code);
      }
      if (typeof data === 'object' && data !== null && 'accessEpoch' in data && typeof data.accessEpoch === 'number') {
        if (data.accessEpoch < session.accessEpoch) throw new RequestError('Access changed while loading. Reload the workspace.', 409, 'ACCESS_CHANGED');
        if (path === '/api/state' && 'access' in data && data.access && typeof data.access === 'object') reconcileAccess(data.access as Record<string, ObjectAccess>, data.accessEpoch, 'spaces' in data && Array.isArray(data.spaces) ? data.spaces.flatMap((space: unknown) => space && typeof space === 'object' && 'id' in space && typeof space.id === 'string' ? [space.id] : []) : [], 'spaces' in data && Array.isArray(data.spaces) ? data.spaces.flatMap((space: unknown) => space && typeof space === 'object' && 'id' in space && typeof space.id === 'string' && 'archived' in space && space.archived === true ? [space.id] : []) : []);
        else { if (data.accessEpoch !== session.accessEpoch) { invalidateTaskSnapshots(controller); taskGeneration = session.taskSnapshotGeneration; } session.accessEpoch = data.accessEpoch; stackGeneration = stacks?.generation; notificationGeneration = notifications?.generation; }
      }
      if (path === '/api/state' && response.ok) reconcileStackMetadata(data);
      assertObject();
      return data as T;
    } catch (error) { assertObject(); throw error; }
    finally { notifications?.controllers.delete(controller); stacks?.controllers.delete(controller); session.controllers.delete(controller); session.objectControllers.delete(controller); session.taskReadControllers.delete(controller); }
  };
  const changeOutbox = async (change: (current: PendingMutation[]) => PendingMutation[]): Promise<PendingMutation[]> => {
    assertSession(session);
    if (!durable) throw new Error('Offline submission is unavailable in a password-protected workspace. Keep the draft open or export it, then reconnect to save.');
    const commit = () => {
      assertSession(session);
      const next = change(readStored<PendingMutation[]>('outbox', []));
      if (!writeStored('outbox', next)) throw new Error('Browser storage is unavailable. Your change has not been saved. Keep the draft open or export it.');
      return next;
    };
    if (typeof navigator !== 'undefined' && navigator.locks) return navigator.locks.request(contentKey('outbox-write'), commit);
    return commit();
  };
  const submittedBulkMoves = (): SubmittedBulkMove[] => {
    if (!sessionIsActive(session)) return [];
    return [...session.memory].filter(([key]) => key.startsWith('submitted-bulk:')).map(([, value]) => JSON.parse(value) as SubmittedBulkMove);
  };
  const retainSubmittedBulkMove = (value: SubmittedBulkMove): SubmittedBulkMove => {
    assertSession(session);
    // Deliberately whitelist only request identifiers and immutable pins. This map
    // stays in session memory even in local mode; no draft/cache writer is used.
    const retained: SubmittedBulkMove = { projectId: value.projectId, sourceProxyId: value.sourceProxyId, requestId: value.requestId, input: { sourceColumnId: value.input.sourceColumnId, destinationProjectId: value.input.destinationProjectId, destinationColumnId: value.input.destinationColumnId, expectedBoardVersion: value.input.expectedBoardVersion, expectedDestinationBoardVersion: value.input.expectedDestinationBoardVersion, tasks: value.input.tasks.map(task => ({ taskId: task.taskId, expectedTaskVersion: task.expectedTaskVersion })) } };
    const key = `submitted-bulk:${value.requestId}`; const json = JSON.stringify(retained); const previous = session.memory.get(key);
    if (previous && previous !== json) throw new Error('A submitted request cannot change its task list or versions. Retain it for retry and prepare a new request explicitly.');
    session.memory.set(key, json); for (const listener of session.accessListeners) listener([]); return retained;
  };
  const clearSubmittedBulkMove = (expected: SubmittedBulkMove): boolean => {
    if (!sessionIsActive(session)) return false;
    const key = `submitted-bulk:${expected.requestId}`;
    if (session.memory.get(key) !== JSON.stringify(expected)) return false;
    session.memory.delete(key); for (const listener of session.accessListeners) listener([]); return true;
  };
  const draftRecords = (): { key: string; value: unknown }[] => {
    if (!sessionIsActive(session)) return [];
    const held = quarantinedDrafts();
    const submitted = submittedBulkMoves().map(value => ({ key: `submitted-bulk:${value.requestId}`, value }));
    if (durable) return [...submitted, ...[...session.memory].filter(([key]) => isRetainedDraftKey(key) && key.endsWith(':unsaved-memory') && draftHasUnsavedMemory(key.slice(0, -':unsaved-memory'.length))).map(([key, value]) => ({ key, value: JSON.parse(value) as unknown }))];
    const ordinary = [...session.memory].filter(([key, value]) => {
      if (key.startsWith('comment-source:') || key.startsWith('task-comment:')) { try { return hasSavedWork(key, JSON.parse(value)); } catch { return false; } }
      return /^(?:revision-project-draft|revision-project-request|revision-subscription-draft|revision-subscription-request|revision-metadata-draft|revision-metadata-request|revision-reviewer-draft|revision-reviewer-request|revision-lifecycle-draft|revision-lifecycle-request|revision-author-draft|revision-author-request|revision-dependency-draft|revision-dependency-request|wiki-move|wiki-request|wiki-edit|wiki-action|wiki-action-request|review-draft-edit|review-draft-summary|review-draft-request|transcript-edit-draft|transcript-edit-request|docx-draft|docx-request|paste-draft|paste-comment|paste-request|paste-create):/.test(key) || key.startsWith('citation-draft:') || key === 'file-uploads' || key.startsWith('file-draft:') || key.startsWith('discussion-choice:') || (key.startsWith('repository-import:') || key.startsWith('revision-git-import:')) || key.startsWith('draft:') || key.startsWith('version-draft:') || key.startsWith('task-draft:') || key.startsWith('task-projects:') || (key.startsWith('project-draft:') || key.startsWith('project-child:')) || key.startsWith('workboard-move:');
    }).map(([key, value]) => ({ key, value: JSON.parse(value) as unknown }));
    return [...ordinary.filter(row => !held.some(draft => draft.key === row.key && JSON.stringify(draft.value) === JSON.stringify(row.value))), ...held.map(draft => ({ key: draft.key, value: draft.value })), ...submitted];
  };
  const savedDraftRecords = (prefix: string): { key: string; value: unknown }[] => {
    if (!sessionIsActive(session)) return [];
    const keys = [...new Set(savedEntries().map(([key]) => key.replace(/:unsaved-memory$/, '')).filter(key => isDraftKey(key) && key.startsWith(prefix)))];
    return keys.flatMap(key => { const value = readStored<unknown>(key, null); return value === null ? [] : [{ key, value }]; });
  };
  const onTaskSnapshotChange = (listener: () => void) => { session?.taskSnapshotListeners.add(listener); return () => { session?.taskSnapshotListeners.delete(listener); }; };
  const onRevisionStackChange = (listener: () => void) => { stacks?.listeners.add(listener); return () => { stacks?.listeners.delete(listener); }; };
  return { session, durable, invalidateNotifications: () => invalidateNotifications(), notificationGeneration: () => notifications?.generation ?? -1, onNotificationChange: (listener: () => void) => { notifications?.listeners.add(listener); return () => { notifications?.listeners.delete(listener); }; }, acknowledgeRevisionAuthorIntent, invalidateRevisionStacks: () => invalidateRevisionStacks(), onRevisionStackChange, revisionStackGeneration: () => stacks?.generation ?? -1, retireUnavailableObject: (id: string) => { assertSession(session); invalidateObjects([id]); }, savedDraftRecords, onRepositorySnapshotChange: onTaskSnapshotChange, repositorySnapshotGeneration: () => session?.taskSnapshotGeneration ?? -1, unavailableObject, onAccessChange, onWorkboardSnapshotChange: onTaskSnapshotChange, workboardSnapshotGeneration: () => session?.taskSnapshotGeneration ?? -1, onProjectSnapshotChange: onTaskSnapshotChange, projectSnapshotGeneration: () => session?.taskSnapshotGeneration ?? -1, onTaskSnapshotChange, taskSnapshotGeneration: () => session?.taskSnapshotGeneration ?? -1, reconcileAccess, quarantinedDrafts, draftIsHeld, draftHasUnsavedMemory, retainDraft, removeRetainedDraftIfEqual, retainTranscriptEditDraft, quarantineWarning, retryQuarantineStorage, discardQuarantinedDraft, readStored, writeStored, writeDiscussionChoice, clearDiscussionChoice, removeStored, removeStoredIfEqual, removeTranscriptEditStoredIfEqual, request, changeOutbox, draftRecords, submittedBulkMoves, retainSubmittedBulkMove, clearSubmittedBulkMove, storageKey: contentKey, assertActive: () => assertSession(session), isActive: () => sessionIsActive(session) };
}
export type WorkspaceClient = ReturnType<typeof createWorkspaceClient>;
// Non-React callers must explicitly establish a session before using these helpers.
export function readStored<T>(key: string, fallback: T): T { return createWorkspaceClient().readStored(key, fallback); }
export function writeStored(key: string, value: unknown): boolean { return createWorkspaceClient().writeStored(key, value); }
export function removeStored(key: string): void { createWorkspaceClient().removeStored(key); }
export function request<T>(path: string, options?: { method: MutationMethod; body: unknown; id?: string; queued?: boolean }): Promise<T> { return createWorkspaceClient().request<T>(path, options); }
export function changeOutbox(change: (current: PendingMutation[]) => PendingMutation[]): Promise<PendingMutation[]> { return createWorkspaceClient().changeOutbox(change); }
