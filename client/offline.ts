import { canonicalWikiPath } from '../shared/wiki';
import type { WikiAuthority } from './wiki-client';
import { comparisonMetadata, isComparisonSelection } from './comparison-model';
import { repositorySelection } from './repository-cache';
import type { BulkMoveWorkboardCardsInput } from '../shared/workboards';
import type { ObjectAccess } from '../shared/policy';
import { applicationPath, storageKey } from './mount';
import { assertSession, currentSession, lockSession, RequestError, sessionIsActive, type WorkspaceSession, type QuarantinedDraft } from './session';
export { RequestError } from './session';

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
function objectFromPath(path: string): string | null { return /^\/api\/(?:pastes|files|revisions|documents|tasks|projects|repositories|policies|spaces)\/([A-Z]+\d+)(?:[/?]|$)/.exec(path)?.[1] || null; }
function queuedObject(item: PendingMutation): string | null {
  const id = objectFromPath(item.path); if (id) return id;
  if (item.method !== 'POST' || !['/api/tasks', '/api/documents', '/api/projects'].includes(item.path)) return null;
  const body = item.body as { parentId?: unknown; access?: { spaceId?: unknown } } | null;
  if (item.path === '/api/projects' && typeof body?.parentId === 'string') return body.parentId;
  return body?.access && typeof body.access.spaceId === 'string' ? body.access.spaceId : 'S1';
}
function objectFromKey(key: string): string | null { return /^(?:wiki-move|wiki-request|wiki-edit|wiki-action|wiki-action-request|docx-draft|docx-request|docx-selection|paste|paste-version|paste-selection|paste-history|paste-draft|paste-comment|paste-request|paste-create|citation-draft|file|file-draft|repository|repository-import|revision-git-import|revision-source|revision|revision-comparison|discussion-preferences|discussion-choice|wiki|task|project|workboard|workboard-move|project-draft|project-child|task-draft|task-comment|task-projects|version-draft|comment-source):([A-Z]+\d+)(?:[:]|$)/.exec(key)?.[1] || /^draft:document:([A-Z]+\d+):/.exec(key)?.[1] || null; }
function isDraftKey(key: string): boolean { return /^(?:wiki-move|wiki-request|wiki-edit|wiki-action|wiki-action-request|docx-draft|docx-request|paste-draft|paste-comment|paste-request|paste-create):/.test(key) || key.startsWith('citation-draft:') || key === 'file-uploads' || key.startsWith('file-draft:') || (key.startsWith('repository-import:') || key.startsWith('revision-git-import:')) || key.startsWith('draft:') || key.startsWith('version-draft:') || key.startsWith('comment-source:') || key.startsWith('task-draft:') || key.startsWith('task-comment:') || key.startsWith('task-projects:') || (key.startsWith('project-draft:') || key.startsWith('project-child:')) || key.startsWith('workboard-move:'); }
// Personal presentation choices retain quota-failed memory, but are purged on view loss rather than treated as content drafts.
function isRetainedDraftKey(key: string): boolean { return key.startsWith('draft:document:') || /^(?:wiki-move|wiki-request|wiki-edit|wiki-action|wiki-action-request|docx-draft|docx-request|paste-draft|paste-comment|paste-request|paste-create):/.test(key) || key.startsWith('citation-draft:') || key === 'file-uploads' || key === 'file-uploads:unsaved-memory' || key.startsWith('file-draft:') || key.startsWith('discussion-choice:') || key.startsWith('version-draft:') || key.startsWith('comment-source:') || (key.startsWith('repository-import:') || key.startsWith('revision-git-import:')) || key.startsWith('task-draft:') || key.startsWith('task-comment:') || key.startsWith('task-projects:') || (key.startsWith('project-draft:') || key.startsWith('project-child:')) || key.startsWith('workboard-move:'); }
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
    if (key.startsWith('draft:document:new')) { let authority: WikiAuthority | undefined; try { authority = ((value ?? JSON.parse(rawRead(key) || 'null')) as { wikiAuthority?: WikiAuthority } | null)?.wikiAuthority; } catch { /* Preserve unreadable drafts. */ } return draftObjects(key, value).some(id => session?.unavailableObjects.has(id) || (session?.visibleObjects && !session.visibleObjects.has(id))) || Boolean(authority?.parentId && session?.objectCapabilities.get(authority.parentId)?.edit === false); }
    if (/^wiki-(?:move|request|edit|action|action-request):/.test(key)) { const ids = draftObjects(key, value), target = objectFromKey(key); let edits: string[] = []; try { edits = ((value ?? JSON.parse(rawRead(key) || 'null')) as { editIds?: string[] } | null)?.editIds || []; } catch { /* Keep unreadable recovery. */ } return ids.some(id => session?.unavailableObjects.has(id) || (session?.visibleObjects && !session.visibleObjects.has(id))) || [target, ...edits].some(id => id && session?.objectCapabilities.get(id)?.edit === false); }
    if (/^docx-(?:draft|request):/.test(key)) { const ids = draftObjects(key, value), target = objectFromKey(key); return ids.some(id => session?.unavailableObjects.has(id) || (session?.visibleObjects !== null && session?.visibleObjects !== undefined && !session.visibleObjects.has(id))) || Boolean(target && session?.objectCapabilities.get(target)?.edit === false); }
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
    for (const [key, value] of session.memory) if (isRetainedDraftKey(key)) entries.push([key, value]);
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
    if (/^wiki-(?:move|request|edit|action|action-request):/.test(key) || key.startsWith('draft:document:')) { try { const draft = (value ?? JSON.parse(rawRead(key) || 'null')) as { authorityIds?: string[]; wikiAuthority?: WikiAuthority; spaceId?: string } | null; return [...new Set([...(primary ? [primary] : []), ...(draft?.authorityIds || draft?.wikiAuthority?.ancestorIds || []), ...(key.startsWith('draft:document:new') && draft?.spaceId ? [draft.spaceId] : [])])]; } catch { return primary ? [primary] : []; } }
    if (/^docx-(?:draft|request):/.test(key)) { try { const draft = (value ?? JSON.parse(rawRead(key) || 'null')) as { sourceFile?: { fileId?: unknown }; body?: { sourceFile?: { fileId?: unknown } } } | null; const file = draft?.sourceFile?.fileId ?? draft?.body?.sourceFile?.fileId; return [...(primary ? [primary] : []), ...(typeof file === 'string' && /^F\d+$/.test(file) ? [file] : [])]; } catch { return primary ? [primary] : []; } }
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
  const recordKey = (key: string) => `quarantined-drafts:${encodeURIComponent(key)}`;
  const quarantineChanged = () => { if (sessionIsActive(session)) for (const listener of session.accessListeners) listener([]); };
  const storageFailure = () => {
    if (!sessionIsActive(session)) return;
    // This small marker is initialized before ordinary work is saved. Removing
    // it works at quota and makes subsequent tabs/reloads hold the original bytes.
    rawRemove('quarantine-ready');
    session.quarantineWarning = 'Browser storage could not save every recovery copy. Original drafts and queued changes are retained and automatic submission is blocked. Export the drafts now, or free browser storage and retry saving them. Keep this page open until you have a copy.';
  };
  const parseDraft = (json: string): QuarantinedDraft | null => {
    try { const item: unknown = JSON.parse(json); return item && typeof item === 'object' && 'key' in item && typeof item.key === 'string' && 'objectId' in item && typeof item.objectId === 'string' && 'value' in item && 'reason' in item && typeof item.reason === 'string' ? item as QuarantinedDraft : null; } catch { return null; }
  };
  const recoverOriginals = () => {
    if (!sessionIsActive(session)) return;
    for (const [key, json] of savedEntries()) if (isDraftKey(key) && !session.quarantinedDrafts.has(key)) {
      try { const value: unknown = JSON.parse(json); if (hasSavedWork(key, value)) { session.quarantinedDrafts.set(key, { key, objectId: objectFromKey(key) || 'Workspace', value, reason: 'Saved work held for explicit export or discard' }); session.quarantinePending.add(key); } } catch { /* Preserve unreadable original bytes. */ }
    }
    for (const item of rawOutbox()) if (!session.quarantinedDrafts.has(`outbox:${item.id}`)) {
      const key = `outbox:${item.id}`; session.quarantinedDrafts.set(key, { key, objectId: queuedObject(item) || 'Workspace', value: item, reason: 'Queued change held for explicit recovery; automatic submission stopped' }); session.quarantinePending.add(key);
    }
  };
  const syncDurableQuarantine = () => {
    if (!durable || !sessionIsActive(session)) return;
    const found = new Set<string>();
    for (const [key, json] of savedEntries()) if (key.startsWith('quarantined-drafts:')) {
      const draft = parseDraft(json);
      if (!draft) { storageFailure(); continue; }
      found.add(draft.key);
      if (!session.quarantinePending.has(draft.key)) session.quarantinedDrafts.set(draft.key, draft);
    }
    for (const key of session.quarantinePersisted) if (!found.has(key) && !session.quarantinePending.has(key)) session.quarantinedDrafts.delete(key);
    session.quarantinePersisted.clear(); for (const key of found) session.quarantinePersisted.add(key);
    if (rawRead('quarantine-format') === '2' && rawRead('quarantine-ready') !== '1') { recoverOriginals(); storageFailure(); }
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
  const quarantine = (draft: QuarantinedDraft): boolean => {
    if (!sessionIsActive(session)) return false;
    syncDurableQuarantine(); session.quarantinedDrafts.set(draft.key, draft);
    if (durable) session.quarantinePending.add(draft.key);
    const saved = persistQuarantine(); quarantineChanged(); return saved;
  };
  const invalidateTaskSnapshots = (except?: AbortController, remove = true) => {
    if (!sessionIsActive(session)) return;
    session.taskSnapshotGeneration += 1;
    for (const controller of session.taskReadControllers) if (controller !== except) controller.abort();
    if (remove) for (const [key, value] of savedEntries()) if ((key.startsWith('revision:') && (() => { try { return docxSnapshot(key, JSON.parse(value)); } catch { return false; } })()) || key.startsWith('wiki:') || key.startsWith('wiki-path:') || key.startsWith('wiki-search:') || key.startsWith('paste:') || key.startsWith('paste-version:') || key.startsWith('paste-history:') || key.startsWith('paste-list:') || key.startsWith('task:') || key.startsWith('project:') || key.startsWith('workboard:') || key.startsWith('discussion-preferences:') || /^repository:R\d+:cache$/.test(key)) rawRemove(key);
    for (const listener of session.taskSnapshotListeners) listener();
  };
  let holdingLegacy = false;
  const holdLegacyTaskUpdates = () => {
    if (!sessionIsActive(session) || holdingLegacy) return;
    holdingLegacy = true;
    try {
      const wikiState = (() => { try { return JSON.parse(rawRead('state') || 'null') as { documents?: { id: string; slug: string; version: number; location?: { path: string; status: string } }[] } | null; } catch { return null; } })();
      for (const item of rawOutbox()) if ((item.path === '/api/documents' && item.method === 'POST' && (!canQueue(item.path, item.method, item.body) || !item.wikiAuthority)) || (/^\/api\/documents\/W\d+$/.test(item.path) && item.method === 'PUT' && (() => { const current = wikiState?.documents?.find(document => document.id === objectFromPath(item.path)); const input = item.body as { slug?: unknown; expectedVersion?: unknown }; if (!current) return false; try { return (current.location?.status !== undefined && current.location.status !== 'active' && input.expectedVersion !== current.version) || (typeof input?.slug === 'string' && canonicalWikiPath(input.slug) !== (current.location?.path || canonicalWikiPath(current.slug))); } catch { return true; } })())) if (!session.quarantinedDrafts.has(`outbox:${item.id}`)) quarantine({ key: `outbox:${item.id}`, objectId: queuedObject(item)!, value: item, reason: 'This older wiki request needs a new path and parent review. Export it before preparing a separate change; it will not submit automatically.' });
      for (const item of rawOutbox()) if ((item.path === '/api/projects' || /^\/api\/projects\/PROJ\d+$/.test(item.path)) && !canQueue(item.path, item.method, item.body) && !session.quarantinedDrafts.has(`outbox:${item.id}`)) quarantine({ key: `outbox:${item.id}`, objectId: queuedObject(item)!, value: item, reason: 'This older project change has no valid source version or includes an operation that requires an online review. Export and review it explicitly; automatic submission stopped.' });
      for (const [key, json] of savedEntries()) if (key.startsWith('project-draft:') && !session.quarantinedDrafts.has(key)) { try { const draft = JSON.parse(json) as { expectedVersion?: unknown }; if (!Number.isSafeInteger(draft.expectedVersion) || Number(draft.expectedVersion) < 1) quarantine({ key, objectId: objectFromKey(key)!, value: draft, reason: 'This older project draft has no recorded source version. Export the entire draft and review it against the current project before saving.' }); } catch { /* Preserve unreadable original bytes. */ } }
      for (const item of rawOutbox()) if (((item.method === 'PATCH' && /^\/api\/tasks\/T\d+$/.test(item.path)) || (item.method === 'POST' && item.path === '/api/tasks')) && !session.quarantinedDrafts.has(`outbox:${item.id}`)) {
        const body = item.body as { expectedVersion?: unknown; ownerId?: unknown; projectId?: unknown; projectIds?: unknown } | null;
        if (item.method === 'PATCH' && body && ('projectId' in body || 'projectIds' in body)) { quarantine({ key: `outbox:${item.id}`, objectId: queuedObject(item)!, value: item, reason: 'This saved field change uses an older project replacement format. Export the whole change, then review ordinary fields and project tags separately. Automatic submission is stopped.' }); continue; }
        if (body && 'ownerId' in body && (item.method === 'PATCH' || body.ownerId !== null)) { quarantine({ key: `outbox:${item.id}`, objectId: queuedObject(item)!, value: item, reason: 'Assignment changes require an online review of access effects. Export this saved change and assign the task explicitly. Automatic submission is stopped.' }); continue; }
        if (item.method === 'PATCH' && (!body || !Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 1)) quarantine({ key: `outbox:${item.id}`, objectId: queuedObject(item)!, value: item, reason: 'This older task change has no source version. Export it, inspect the current task, and make a new edit explicitly. Automatic submission is stopped.' });
      }
      for (const [key, json] of savedEntries()) if (key.startsWith('task-draft:') && !session.quarantinedDrafts.has(key)) {
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
        if (event.key === null || ((event.key?.startsWith(contentKey('wiki:')) || event.key?.startsWith(contentKey('wiki-path:')) || event.key?.startsWith(contentKey('wiki-search:')) || event.key?.startsWith(contentKey('revision:')) || event.key?.startsWith(contentKey('paste:')) || event.key?.startsWith(contentKey('paste-version:')) || event.key?.startsWith(contentKey('paste-list:')) || event.key?.startsWith(contentKey('task:')) || event.key?.startsWith(contentKey('project:')) || event.key?.startsWith(contentKey('workboard:')) || event.key?.startsWith(contentKey('repository:'))) && event.newValue === null)) invalidateTaskSnapshots(undefined, false);
      };
      window.addEventListener('storage', changed);
      session.cleanupCallbacks.add(() => window.removeEventListener('storage', changed));
    }
  }
  const hasDraftHold = (key: string): boolean => {
    if (session?.quarantinedDrafts.has(key)) return true;
    if (!isRetainedDraftKey(key)) return false;
    const base = key.replace(/:unsaved-memory$/, '');
    return Boolean(session?.quarantinedDrafts.has(base) || session?.quarantinedDrafts.has(`${base}:unsaved-memory`));
  };
  const draftIsHeld = (key: string): boolean => { syncDurableQuarantine(); return sessionIsActive(session) && hasDraftHold(key); };
  const readStored = <T,>(key: string, fallback: T): T => {
    syncDurableQuarantine();
    if (key === 'outbox' || key.startsWith('task-draft:') || (key.startsWith('project-draft:') || key.startsWith('project-child:'))) holdLegacyTaskUpdates();
    if (!sessionIsActive(session) || session.unavailableObjects.has(objectFromKey(key) || '') || session.unavailableObjects.has(session.revisionRepositories.get(objectFromKey(key) || '') || '') || [...(session.revisionFiles.get(objectFromKey(key) || '') || [])].some(id => session.unavailableObjects.has(id)) || blockedDraft(key) || hasDraftHold(key)) return fallback;
    try { const value = rawRead(key); const parsed: unknown = value ? JSON.parse(value) : fallback; if (!currentProjectCache(key, parsed) || !currentWikiSearchCache(key, parsed)) return fallback; if ((docxSnapshot(key, parsed) || key.startsWith('wiki:') || key.startsWith('wiki-path:') || key.startsWith('wiki-search:') || key.startsWith('paste:') || key.startsWith('paste-version:') || key.startsWith('paste-history:') || key.startsWith('paste-list:') || key.startsWith('task:') || key.startsWith('project:') || key.startsWith('workboard:') || key.startsWith('discussion-preferences:') || /^repository:R\d+:cache$/.test(key)) && parsed && typeof parsed === 'object' && 'accessEpoch' in parsed && typeof parsed.accessEpoch === 'number' && parsed.accessEpoch < session.accessEpoch) return fallback; return (key === 'outbox' && Array.isArray(parsed) ? (parsed as PendingMutation[]).filter(item => !session.quarantinedDrafts.has(`outbox:${item.id}`)) : parsed) as T; } catch { return fallback; }
  };
  const writeStored = (key: string, value: unknown): boolean => {
    syncDurableQuarantine();
    if (!currentWikiSearchCache(key, value)) return false;
    if (!sessionIsActive(session) || session.unavailableObjects.has(objectFromKey(key) || '') || session.unavailableObjects.has(session.revisionRepositories.get(objectFromKey(key) || '') || '') || [...(session.revisionFiles.get(objectFromKey(key) || '') || [])].some(id => session.unavailableObjects.has(id))) return false;
    if (key === 'state' || key.startsWith('revision:')) rememberRevisionSources(value);
    if (key.startsWith('revision-comparison:')) { if (!isComparisonSelection(value, objectFromKey(key) || '')) return false; value = comparisonMetadata(value); }
    if (/^repository:R\d+:selection$/.test(key)) { const selection = repositorySelection(value); if (!selection) return false; value = selection; }
    if ((docxSnapshot(key, value) || key.startsWith('wiki:') || key.startsWith('wiki-path:') || key.startsWith('wiki-search:') || key.startsWith('paste:') || key.startsWith('paste-version:') || key.startsWith('paste-history:') || key.startsWith('paste-list:') || key.startsWith('task:') || key.startsWith('project:') || key.startsWith('workboard:') || key.startsWith('discussion-preferences:') || /^repository:R\d+:cache$/.test(key)) && value && typeof value === 'object' && 'accessEpoch' in value && typeof value.accessEpoch === 'number' && value.accessEpoch < session.accessEpoch) return false;
    if (key.startsWith('workboard-move:') && draftObjects(key, value).some(id => session.unavailableObjects.has(id) || (session.visibleObjects !== null && !session.visibleObjects.has(id)))) return quarantine({ key, objectId: objectFromKey(key)!, value, reason: 'A selected move reference is no longer available' });
    if (blockedDraft(key, value)) { if (!hasSavedWork(key, value)) return true; return quarantine({ key, objectId: objectFromKey(key) || draftObjects(key, value)[0] || 'S1', value, reason: 'Permission to submit this draft changed' }); }
    if (hasDraftHold(key)) return false;
    if (key === 'outbox' && Array.isArray(value)) {
      const held = rawOutbox().filter(item => session.quarantinePending.has(`outbox:${item.id}`));
      value = [...held, ...(value as PendingMutation[]).filter(item => !held.some(saved => saved.id === item.id) && !session.quarantinedDrafts.has(`outbox:${item.id}`))];
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
  const clearDiscussionChoice = async (key: string, expected: unknown, stillCurrent: () => boolean = () => true): Promise<boolean> => {
    if (!/^discussion-choice:[DPL]\d+:[^:]+$/.test(key)) return false;
    const commit = () => { if (!stillCurrent() || !sessionIsActive(session) || unavailableObject(objectFromKey(key)!)) return false; return removeStoredIfEqual(key, expected); };
    if (typeof navigator !== 'undefined' && navigator.locks) return navigator.locks.request(contentKey(`presentation-write:${key}`), commit);
    return commit();
  };
  const removeStored = (key: string): void => {
    if (!sessionIsActive(session) || session.quarantinePending.has(key)) return;
    rawRemove(key);
  };
  const removeStoredIfEqual = (key: string, expected: unknown): boolean => {
    syncDurableQuarantine();
    if (!sessionIsActive(session) || hasDraftHold(key)) return false;
    return rawRemoveMatching(key, expected);
  };
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
        if (hasSavedWork(key, value) && !quarantine({ key, objectId, value, reason: 'Object access changed' })) continue;
        // The physical durable and failed-write copies may have different refs.
        // Secure and remove only this exact copy, never its newer sibling.
        rawRemoveMatching(key, value);
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
      try { const value: unknown = JSON.parse(json); if (!blockedDraft(key, value) && !blockedFamilies.has(key.replace(/:unsaved-memory$/, ''))) continue; if (hasSavedWork(key, value)) { const saved = quarantine({ key, objectId: objectFromKey(key) || draftObjects(key, value)[0] || 'S1', value, reason: 'Permission to submit this draft changed' }); draftsChanged = true; if (!saved) continue; } rawRemoveMatching(key, value); } catch { /* Preserve unreadable draft bytes in place. */ }
    }
    const queue = readStored<PendingMutation[]>('outbox', []);
    const forbidden = queue.filter(item => { const id = queuedObject(item); if (item.wikiAuthority && (item.wikiAuthority.ancestorIds.some(ancestor => !visible.has(ancestor)) || (item.wikiAuthority.parentId && session.objectCapabilities.get(item.wikiAuthority.parentId)?.edit === false))) return true; if (id?.startsWith('S')) return !spaceIds.includes(id) || archivedSpaceIds.includes(id); const capabilities = id ? session.objectCapabilities.get(id) : null; return capabilities && !((item.path.endsWith('/comments') || item.path.endsWith('/replies')) ? capabilities.interact : capabilities.edit); });
    for (const item of forbidden) { quarantine({ key: `outbox:${item.id}`, objectId: queuedObject(item)!, value: item, reason: 'Permission or destination Space changed; automatic submission stopped' }); draftsChanged = true; }
    if (draftsChanged) for (const listener of session.accessListeners) listener([]);
    session.visibleObjects = visible;
    if (epoch !== session.accessEpoch) invalidateTaskSnapshots();
    session.accessEpoch = epoch;
    for (const id of visible) session.unavailableObjects.delete(id);
  };
  const quarantinedDrafts = () => { syncDurableQuarantine(); return sessionIsActive(session) ? [...session.quarantinedDrafts.values()] : []; };
  const quarantineWarning = () => sessionIsActive(session) ? session.quarantineWarning : '';
  const retryQuarantineStorage = () => { assertSession(session); syncDurableQuarantine(); const saved = persistQuarantine(); quarantineChanged(); return saved; };
  const discardQuarantinedDraft = async (key: string): Promise<void> => {
    assertSession(session);
    const commit = () => {
      assertSession(session); syncDurableQuarantine();
      const recovery = session.quarantinedDrafts.get(key);
      if (!recovery) return;
      // Use the same lock as normal outbox changes, then reread the latest queue.
      // Quarantine itself never rewrites this shared aggregate.
      const removed = key.startsWith('outbox:') ? rawWrite('outbox', rawOutbox().filter(item => `outbox:${item.id}` !== key)) : rawRemoveMatching(key, recovery.value);
      if (!removed) throw new Error('Could not remove the original saved change. Export it and free browser storage before trying again.');
      if (durable && !rawRemove(recordKey(key))) throw new Error('Could not discard the recovery copy. Export it before trying again.');
      session.quarantinedDrafts.delete(key); session.quarantinePending.delete(key); session.quarantinePersisted.delete(key);
      quarantineChanged();
    };
    if (durable && key.startsWith('outbox:') && typeof navigator !== 'undefined' && navigator.locks) await navigator.locks.request(contentKey('outbox-write'), commit);
    else commit();
  };
  let initialTaskAccessVerification: Promise<unknown> | null = null;
  const request = async <T,>(path: string, options?: { method: MutationMethod; body: unknown; id?: string; queued?: boolean }, authorityIds: readonly string[] = []): Promise<T> => {
    assertSession(session);
    syncDurableQuarantine();
    if (options?.queued) { holdLegacyTaskUpdates(); if (!canQueue(path, options.method, options.body)) throw new RequestError('This operation requires an explicit online save and cannot submit from the outbox.', 403, 'ACTION_FORBIDDEN'); }
    if (options?.queued && (!options.id || !readStored<PendingMutation[]>('outbox', []).some(item => item.id === options.id))) throw new RequestError('This queued change was removed or set aside and cannot submit automatically.', 403, 'ACTION_FORBIDDEN');
    if (options?.id && session.quarantinedDrafts.has(`outbox:${options.id}`)) throw new RequestError('This saved change is set aside for export or discard and cannot submit automatically.', 403, 'ACTION_FORBIDDEN');
    const childParent = path === '/api/projects' && options?.method === 'POST' && options.body && typeof options.body === 'object' && 'parentId' in options.body && typeof options.body.parentId === 'string' ? options.body.parentId : null;
    const citationRequest = /^\/api\/revisions\/[DPL]\d+\/(?:citations|citation-evidence)(?:[/?]|$)/.test(path);
    const docxRequest = /^\/api\/revisions(?:\/[DPL]\d+)?\/docx(?:[/?]|$)/.test(path);
    const docxDiscussionExport = options?.method === 'POST' && /^\/api\/revisions\/[DPL]\d+\/docx\/export-discussion$/.test(path);
    const pasteRequest = /^\/api\/pastes(?:[/?]|$)/.test(path);
    const wikiRequest = /^\/api\/(?:wiki(?:[/?]|$)|documents(?:[/?]|$))/.test(path);
    const repositoryRequest = !options && /^\/api\/repositories\/R\d+(?:[/?]|$)/.test(path);
    const taskRequest = repositoryRequest || wikiRequest || /^\/api\/revisions\/L\d+$/.test(path) || docxRequest || pasteRequest || citationRequest || Boolean(childParent) || /^\/api\/files(?:[/?]|$)/.test(path) || /^\/api\/(?:tasks\/T|projects\/PROJ)\d+(?:[/?]|$)/.test(path);
    if ((options || docxRequest || pasteRequest || citationRequest || path.startsWith('/api/files')) && taskRequest && session.accessEpoch < 0) {
      // Cached task controls may render before startup's state read completes. Verify
      // access before sending a write so that first verification cannot invalidate
      // its successful response. Later epoch changes still reject stale content.
      initialTaskAccessVerification ??= request('/api/state').finally(() => { initialTaskAccessVerification = null; });
      await initialTaskAccessVerification;
      assertSession(session);
      if (session.accessEpoch < 0) throw new RequestError('Workspace access could not be verified. Reconnect before saving this object.', 409, 'ACCESS_CHANGED');
      syncDurableQuarantine();
      if (options?.queued && (!options.id || !readStored<PendingMutation[]>('outbox', []).some(item => item.id === options.id))) throw new RequestError('This queued change was removed or set aside and cannot submit automatically.', 403, 'ACTION_FORBIDDEN');
      if (options?.id && session.quarantinedDrafts.has(`outbox:${options.id}`)) throw new RequestError('This saved change is set aside for export or discard and cannot submit automatically.', 403, 'ACTION_FORBIDDEN');
    }
    const objectId = childParent || objectFromPath(path);
    const sourceRepository = objectId ? session.revisionRepositories.get(objectId) : undefined;
    if (sourceRepository && session.unavailableObjects.has(sourceRepository)) throw unavailable();
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
    const relatedIds = [...new Set([...authorityIds, ...(queuedWiki?.ancestorIds || []), ...(bulkDestination ? [bulkDestination, ...bulkTaskIds] : importSource ? [importSource] : boardMove ? [boardMove.taskId, boardMove.position?.beforeTaskId, boardMove.position?.afterTaskId].filter((id): id is string => typeof id === 'string') : [])])];
    const relatedGenerations = relatedIds.map(id => ({ id, generation: session.objectGenerations.get(id) || 0 }));
    const referenceUnavailable = () => {
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
    if (objectId && session.unavailableObjects.has(objectId)) throw unavailable();
    const capabilities = objectId ? session.objectCapabilities.get(objectId) : null;
    const subscription = /^\/api\/tasks\/T\d+\/subscriptions$/.test(path) && options?.method === 'POST' ? options.body as { principalId?: unknown; action?: unknown } | null : null;
    const selfId = session.state.account?.id || `local:${session.state.workspaceId}`;
    const projectSelfOperation = projectMutation && (/\/(membership|silence)$/.test(path) || (path.endsWith('/watchers') && options?.body && typeof options.body === 'object' && 'principalId' in options.body && options.body.principalId === selfId));
    const mutationAllowed = capabilities && (docxDiscussionExport ? true : citationRequest ? capabilities.interact : bulkMove ? bulkTaskIds.length > 0 && bulkTaskIds.length === bulkMove.tasks?.length && bulkTaskIds.every(id => session.objectCapabilities.get(id)?.edit === true) : boardMove ? typeof boardMove.taskId === 'string' && session.objectCapabilities.get(boardMove.taskId)?.edit === true : projectSelfOperation ? true : /^\/api\/revisions\/[DPL]\d+\/threads\/[^/]+\/preference$/.test(path) ? true : subscription ? subscription.principalId === selfId ? true : subscription.action === 'subscribe' ? capabilities.interact || capabilities.edit : capabilities.edit : /\/(comments|reviews|replies)(?:[/?]|$)/.test(path) ? capabilities.interact : capabilities.edit);
    if (options && capabilities && !mutationAllowed) throw new RequestError('Permission to submit this change has been revoked. Export your unsaved draft to keep it.', 403, 'ACTION_FORBIDDEN');
    const assertObject = () => {
      assertSession(session);
      if (objectId && [...(session.revisionFiles.get(objectId) || [])].some(id => session.unavailableObjects.has(id))) { invalidateObjects([objectId]); throw unavailable(); }
      if (objectId && session.unavailableObjects.has(session.revisionRepositories.get(objectId) || '')) { invalidateObjects([objectId]); throw unavailable(); }
      if (objectId && (session.unavailableObjects.has(objectId) || (session.objectGenerations.get(objectId) || 0) !== objectGeneration)) throw unavailable();
      if (relatedGenerations.some(({ id, generation }) => session.unavailableObjects.has(id) || (session.objectGenerations.get(id) || 0) !== generation)) throw referenceUnavailable();
      if (taskRequest && taskGeneration !== session.taskSnapshotGeneration) throw new RequestError(`${repositoryRequest ? 'Repository' : citationRequest ? 'Citation evidence' : path.startsWith('/api/files') ? 'File' : path.startsWith('/api/projects/') ? 'Project' : 'Task'} visibility changed while loading. Reload this object; unsaved drafts are retained.`, 409, 'ACCESS_CHANGED');
    };
    const controller = new AbortController();
    session.controllers.add(controller);
    if (taskRequest && (!options || docxDiscussionExport)) session.taskReadControllers.add(controller);
    // A committed handoff may revoke this object's access before its receipt arrives.
    // Session invalidation still aborts it; object invalidation must allow the receipt.
    if (objectId && !ownershipMutation && !projectMutation && !boardMutation) session.objectControllers.set(controller, objectId);
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
        else { if (data.accessEpoch !== session.accessEpoch) { invalidateTaskSnapshots(controller); taskGeneration = session.taskSnapshotGeneration; } session.accessEpoch = data.accessEpoch; }
      }
      assertObject();
      return data as T;
    } catch (error) { assertObject(); throw error; }
    finally { session.controllers.delete(controller); session.objectControllers.delete(controller); session.taskReadControllers.delete(controller); }
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
    const submitted = submittedBulkMoves().map(value => ({ key: `submitted-bulk:${value.requestId}`, value }));
    if (durable) return [...submitted, ...[...session.memory].filter(([key]) => isRetainedDraftKey(key) && key.endsWith(':unsaved-memory')).map(([key, value]) => ({ key, value: JSON.parse(value) as unknown }))];
    const ordinary = [...session.memory].filter(([key, value]) => {
      if (key.startsWith('comment-source:') || key.startsWith('task-comment:')) { try { return hasSavedWork(key, JSON.parse(value)); } catch { return false; } }
      return /^(?:wiki-move|wiki-request|wiki-edit|wiki-action|wiki-action-request|docx-draft|docx-request|paste-draft|paste-comment|paste-request|paste-create):/.test(key) || key.startsWith('citation-draft:') || key === 'file-uploads' || key.startsWith('file-draft:') || key.startsWith('discussion-choice:') || (key.startsWith('repository-import:') || key.startsWith('revision-git-import:')) || key.startsWith('draft:') || key.startsWith('version-draft:') || key.startsWith('task-draft:') || key.startsWith('task-projects:') || (key.startsWith('project-draft:') || key.startsWith('project-child:')) || key.startsWith('workboard-move:');
    }).map(([key, value]) => ({ key, value: JSON.parse(value) as unknown }));
    return [...ordinary, ...quarantinedDrafts().map(draft => ({ key: draft.key, value: draft.value })), ...submitted];
  };
  const savedDraftRecords = (prefix: string): { key: string; value: unknown }[] => {
    if (!sessionIsActive(session)) return [];
    const keys = [...new Set(savedEntries().map(([key]) => key.replace(/:unsaved-memory$/, '')).filter(key => isDraftKey(key) && key.startsWith(prefix)))];
    return keys.flatMap(key => { const value = readStored<unknown>(key, null); return value === null ? [] : [{ key, value }]; });
  };
  const onTaskSnapshotChange = (listener: () => void) => { session?.taskSnapshotListeners.add(listener); return () => { session?.taskSnapshotListeners.delete(listener); }; };
  return { session, durable, retireUnavailableObject: (id: string) => { assertSession(session); invalidateObjects([id]); }, savedDraftRecords, onRepositorySnapshotChange: onTaskSnapshotChange, repositorySnapshotGeneration: () => session?.taskSnapshotGeneration ?? -1, unavailableObject, onAccessChange, onWorkboardSnapshotChange: onTaskSnapshotChange, workboardSnapshotGeneration: () => session?.taskSnapshotGeneration ?? -1, onProjectSnapshotChange: onTaskSnapshotChange, projectSnapshotGeneration: () => session?.taskSnapshotGeneration ?? -1, onTaskSnapshotChange, taskSnapshotGeneration: () => session?.taskSnapshotGeneration ?? -1, reconcileAccess, quarantinedDrafts, draftIsHeld, draftHasUnsavedMemory: (key: string) => Boolean(durable && session?.memory.has(`${key}:unsaved-memory`)), quarantineWarning, retryQuarantineStorage, discardQuarantinedDraft, readStored, writeStored, writeDiscussionChoice, clearDiscussionChoice, removeStored, removeStoredIfEqual, request, changeOutbox, draftRecords, submittedBulkMoves, retainSubmittedBulkMove, clearSubmittedBulkMove, storageKey: contentKey, assertActive: () => assertSession(session), isActive: () => sessionIsActive(session) };
}
export type WorkspaceClient = ReturnType<typeof createWorkspaceClient>;
// Non-React callers must explicitly establish a session before using these helpers.
export function readStored<T>(key: string, fallback: T): T { return createWorkspaceClient().readStored(key, fallback); }
export function writeStored(key: string, value: unknown): boolean { return createWorkspaceClient().writeStored(key, value); }
export function removeStored(key: string): void { createWorkspaceClient().removeStored(key); }
export function request<T>(path: string, options?: { method: MutationMethod; body: unknown; id?: string; queued?: boolean }): Promise<T> { return createWorkspaceClient().request<T>(path, options); }
export function changeOutbox(change: (current: PendingMutation[]) => PendingMutation[]): Promise<PendingMutation[]> { return createWorkspaceClient().changeOutbox(change); }
