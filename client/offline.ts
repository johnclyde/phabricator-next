import type { ObjectAccess } from '../shared/policy';
import { applicationPath, storageKey } from './mount';
import { assertSession, currentSession, lockSession, RequestError, sessionIsActive, type WorkspaceSession, type QuarantinedDraft } from './session';
export { RequestError } from './session';

export type MutationMethod = 'POST' | 'PATCH' | 'PUT';
export interface PendingMutation { id: string; path: string; method: MutationMethod; body: unknown; label: string; createdAt: string; error?: string }
export function canQueue(path: string, method: MutationMethod, body?: unknown): boolean {
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
function objectFromPath(path: string): string | null { return /^\/api\/(?:revisions|documents|tasks|projects|repositories|policies|spaces)\/([A-Z]+\d+)(?:[/?]|$)/.exec(path)?.[1] || null; }
function queuedObject(item: PendingMutation): string | null {
  const id = objectFromPath(item.path); if (id) return id;
  if (item.method !== 'POST' || !['/api/tasks', '/api/documents', '/api/projects'].includes(item.path)) return null;
  const body = item.body as { parentId?: unknown; access?: { spaceId?: unknown } } | null;
  if (item.path === '/api/projects' && typeof body?.parentId === 'string') return body.parentId;
  return body?.access && typeof body.access.spaceId === 'string' ? body.access.spaceId : 'S1';
}
function objectFromKey(key: string): string | null { return /^(?:revision|wiki|task|project|workboard|workboard-move|project-draft|project-child|task-draft|task-comment|task-projects|version-draft|comment-source):([A-Z]+\d+)(?:[:]|$)/.exec(key)?.[1] || /^draft:document:([A-Z]+\d+):/.exec(key)?.[1] || null; }
function isDraftKey(key: string): boolean { return key.startsWith('draft:') || key.startsWith('version-draft:') || key.startsWith('comment-source:') || key.startsWith('task-draft:') || key.startsWith('task-comment:') || key.startsWith('task-projects:') || (key.startsWith('project-draft:') || key.startsWith('project-child:')) || key.startsWith('workboard-move:'); }
function isRetainedDraftKey(key: string): boolean { return key.startsWith('task-draft:') || key.startsWith('task-comment:') || key.startsWith('task-projects:') || (key.startsWith('project-draft:') || key.startsWith('project-child:')) || key.startsWith('workboard-move:'); }
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
    if (key.startsWith('workboard-move:')) {
      const taskId = /^workboard-move:PROJ\d+:(T\d+)/.exec(key)?.[1];
      const ids = draftObjects(key, value);
      return ids.some(id => session?.unavailableObjects.has(id) || (session?.visibleObjects !== null && session?.visibleObjects !== undefined && !session.visibleObjects.has(id))) || Boolean(taskId && session?.objectCapabilities.get(taskId)?.edit === false);
    }
    const id = objectFromKey(key); const capabilities = id ? session?.objectCapabilities.get(id) : null;
    return Boolean(id && isDraftKey(key) && capabilities && !((key.startsWith('comment-source:') || key.startsWith('task-comment:')) ? capabilities.interact : capabilities.edit));
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
    if (!key.startsWith('workboard-move:')) return primary ? [primary] : [];
    const task = /^workboard-move:PROJ\d+:(T\d+)/.exec(key)?.[1];
    try {
      const draft = (value ?? JSON.parse(rawRead(key) || 'null')) as { proxyProjectId?: string; input?: { position?: { beforeTaskId?: string; afterTaskId?: string } } } | null;
      return [primary, task, draft?.proxyProjectId, draft?.input?.position?.beforeTaskId, draft?.input?.position?.afterTaskId].filter((id): id is string => typeof id === 'string');
    } catch { return [primary, task].filter((id): id is string => typeof id === 'string'); }
  };
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
    if (remove) for (const [key] of savedEntries()) if (key.startsWith('task:') || key.startsWith('project:') || key.startsWith('workboard:')) rawRemove(key);
    for (const listener of session.taskSnapshotListeners) listener();
  };
  let holdingLegacy = false;
  const holdLegacyTaskUpdates = () => {
    if (!sessionIsActive(session) || holdingLegacy) return;
    holdingLegacy = true;
    try {
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
        if (event.key === null || ((event.key?.startsWith(contentKey('task:')) || event.key?.startsWith(contentKey('project:')) || event.key?.startsWith(contentKey('workboard:'))) && event.newValue === null)) invalidateTaskSnapshots(undefined, false);
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
    if (!sessionIsActive(session) || session.unavailableObjects.has(objectFromKey(key) || '') || blockedDraft(key) || hasDraftHold(key)) return fallback;
    try { const value = rawRead(key); const parsed: unknown = value ? JSON.parse(value) : fallback; if (!currentProjectCache(key, parsed)) return fallback; if ((key.startsWith('task:') || key.startsWith('project:') || key.startsWith('workboard:')) && parsed && typeof parsed === 'object' && 'accessEpoch' in parsed && typeof parsed.accessEpoch === 'number' && parsed.accessEpoch < session.accessEpoch) return fallback; return (key === 'outbox' && Array.isArray(parsed) ? (parsed as PendingMutation[]).filter(item => !session.quarantinedDrafts.has(`outbox:${item.id}`)) : parsed) as T; } catch { return fallback; }
  };
  const writeStored = (key: string, value: unknown): boolean => {
    syncDurableQuarantine();
    if (!sessionIsActive(session) || session.unavailableObjects.has(objectFromKey(key) || '')) return false;
    if ((key.startsWith('task:') || key.startsWith('project:') || key.startsWith('workboard:')) && value && typeof value === 'object' && 'accessEpoch' in value && typeof value.accessEpoch === 'number' && value.accessEpoch < session.accessEpoch) return false;
    if (key.startsWith('workboard-move:') && draftObjects(key, value).some(id => session.unavailableObjects.has(id) || (session.visibleObjects !== null && !session.visibleObjects.has(id)))) return quarantine({ key, objectId: objectFromKey(key)!, value, reason: 'A selected move reference is no longer available' });
    if (blockedDraft(key, value)) { if (!hasSavedWork(key, value)) return true; return quarantine({ key, objectId: objectFromKey(key)!, value, reason: 'Permission to submit this draft changed' }); }
    if (hasDraftHold(key)) return false;
    if (key === 'outbox' && Array.isArray(value)) {
      const held = rawOutbox().filter(item => session.quarantinePending.has(`outbox:${item.id}`));
      value = [...held, ...(value as PendingMutation[]).filter(item => !held.some(saved => saved.id === item.id) && !session.quarantinedDrafts.has(`outbox:${item.id}`))];
    }
    return rawWrite(key, value);
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
    const changed = ids.filter(id => !session.unavailableObjects.has(id));
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
      const objectId = objectFromKey(key);
      let value: unknown; try { value = JSON.parse(json); } catch { continue; }
      if (!objectId || (!draftObjects(key, value).some(id => changed.includes(id)) && !heldFamilies.has(key.replace(/:unsaved-memory$/, '')))) continue;
      if (isDraftKey(key)) {
        if (hasSavedWork(key, value) && !quarantine({ key, objectId, value, reason: 'Object access changed' })) continue;
        // The physical durable and failed-write copies may have different refs.
        // Secure and remove only this exact copy, never its newer sibling.
        rawRemoveMatching(key, value);
      } else removeStored(key);
    }
    const queued = readStored<PendingMutation[]>('outbox', []);
    const affected = queued.filter(item => changed.includes(queuedObject(item) || ''));
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
      try { const value: unknown = JSON.parse(json); if (!blockedDraft(key, value) && !blockedFamilies.has(key.replace(/:unsaved-memory$/, ''))) continue; if (hasSavedWork(key, value)) { const saved = quarantine({ key, objectId: objectFromKey(key)!, value, reason: 'Permission to submit this draft changed' }); draftsChanged = true; if (!saved) continue; } rawRemoveMatching(key, value); } catch { /* Preserve unreadable draft bytes in place. */ }
    }
    const queue = readStored<PendingMutation[]>('outbox', []);
    const forbidden = queue.filter(item => { const id = queuedObject(item); if (id?.startsWith('S')) return !spaceIds.includes(id) || archivedSpaceIds.includes(id); const capabilities = id ? session.objectCapabilities.get(id) : null; return capabilities && !((item.path.endsWith('/comments') || item.path.endsWith('/replies')) ? capabilities.interact : capabilities.edit); });
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
  const request = async <T,>(path: string, options?: { method: MutationMethod; body: unknown; id?: string; queued?: boolean }): Promise<T> => {
    assertSession(session);
    syncDurableQuarantine();
    if (options?.queued) { holdLegacyTaskUpdates(); if (!canQueue(path, options.method, options.body)) throw new RequestError('This operation requires an explicit online save and cannot submit from the outbox.', 403, 'ACTION_FORBIDDEN'); }
    if (options?.queued && (!options.id || !readStored<PendingMutation[]>('outbox', []).some(item => item.id === options.id))) throw new RequestError('This queued change was removed or set aside and cannot submit automatically.', 403, 'ACTION_FORBIDDEN');
    if (options?.id && session.quarantinedDrafts.has(`outbox:${options.id}`)) throw new RequestError('This saved change is set aside for export or discard and cannot submit automatically.', 403, 'ACTION_FORBIDDEN');
    const childParent = path === '/api/projects' && options?.method === 'POST' && options.body && typeof options.body === 'object' && 'parentId' in options.body && typeof options.body.parentId === 'string' ? options.body.parentId : null;
    const taskRequest = Boolean(childParent) || /^\/api\/(?:tasks\/T|projects\/PROJ)\d+(?:[/?]|$)/.test(path);
    if (options && taskRequest && session.accessEpoch < 0) {
      // Cached task controls may render before startup's state read completes. Verify
      // access before sending a write so that first verification cannot invalidate
      // its successful response. Later epoch changes still reject stale content.
      initialTaskAccessVerification ??= request('/api/state').finally(() => { initialTaskAccessVerification = null; });
      await initialTaskAccessVerification;
      assertSession(session);
      if (session.accessEpoch < 0) throw new RequestError('Workspace access could not be verified. Reconnect before saving this object.', 409, 'ACCESS_CHANGED');
      syncDurableQuarantine();
      if (options.queued && (!options.id || !readStored<PendingMutation[]>('outbox', []).some(item => item.id === options.id))) throw new RequestError('This queued change was removed or set aside and cannot submit automatically.', 403, 'ACTION_FORBIDDEN');
      if (options.id && session.quarantinedDrafts.has(`outbox:${options.id}`)) throw new RequestError('This saved change is set aside for export or discard and cannot submit automatically.', 403, 'ACTION_FORBIDDEN');
    }
    const objectId = childParent || objectFromPath(path);
    const accessGeneration = session.accessGeneration;
    if (objectId && !objectId.startsWith('S') && !session.objectGenerations.has(objectId)) session.objectGenerations.set(objectId, 0);
    const objectGeneration = objectId ? session.objectGenerations.get(objectId) || 0 : 0;
    const boardMutation = Boolean(options && /^\/api\/projects\/PROJ\d+\/workboard(?:\/|$)/.test(path));
    const boardMove = boardMutation && path.endsWith('/moves') && options?.body && typeof options.body === 'object' ? options.body as { taskId?: unknown; position?: { beforeTaskId?: unknown; afterTaskId?: unknown } } : null;
    const importSource = /^\/api\/projects\/PROJ\d+\/workboard\/import-preview\?/.test(path) && !options ? new URLSearchParams(path.split('?')[1]).get('sourceProjectId') : boardMutation && path.endsWith('/import') && options?.body && typeof options.body === 'object' && 'sourceProjectId' in options.body && typeof options.body.sourceProjectId === 'string' ? options.body.sourceProjectId : null;
    const relatedIds = importSource ? [importSource] : boardMove ? [boardMove.taskId, boardMove.position?.beforeTaskId, boardMove.position?.afterTaskId].filter((id): id is string => typeof id === 'string') : [];
    const relatedGenerations = relatedIds.map(id => ({ id, generation: session.objectGenerations.get(id) || 0 }));
    const referenceUnavailable = () => new RequestError(importSource ? 'The source project is no longer available. Its import preview has been removed.' : 'A selected card is no longer available. Review the move before saving.', 404, importSource ? 'PROJECT_REFERENCE_UNAVAILABLE' : 'TASK_REFERENCE_UNAVAILABLE');
    if (relatedIds.some(id => session.unavailableObjects.has(id) || (session.visibleObjects !== null && !session.visibleObjects.has(id)))) throw referenceUnavailable();
    const ownershipMutation = options?.method === 'PATCH' && /^\/api\/tasks\/T\d+$/.test(path) && options.body && typeof options.body === 'object' && 'ownerId' in options.body;
    const projectMutation = Boolean(childParent) || Boolean(options && /^\/api\/projects\/PROJ\d+(?:\/(membership|members|watchers|silence))?$/.test(path));
    let taskGeneration = session.taskSnapshotGeneration;
    if (objectId && session.unavailableObjects.has(objectId)) throw unavailable();
    const capabilities = objectId ? session.objectCapabilities.get(objectId) : null;
    const subscription = /^\/api\/tasks\/T\d+\/subscriptions$/.test(path) && options?.method === 'POST' ? options.body as { principalId?: unknown; action?: unknown } | null : null;
    const selfId = session.state.account?.id || `local:${session.state.workspaceId}`;
    const projectSelfOperation = projectMutation && (/\/(membership|silence)$/.test(path) || (path.endsWith('/watchers') && options?.body && typeof options.body === 'object' && 'principalId' in options.body && options.body.principalId === selfId));
    const mutationAllowed = capabilities && (boardMove ? typeof boardMove.taskId === 'string' && session.objectCapabilities.get(boardMove.taskId)?.edit === true : projectSelfOperation ? true : subscription ? subscription.principalId === selfId ? true : subscription.action === 'subscribe' ? capabilities.interact || capabilities.edit : capabilities.edit : /\/(comments|reviews|replies)(?:[/?]|$)/.test(path) ? capabilities.interact : capabilities.edit);
    if (options && capabilities && !mutationAllowed) throw new RequestError('Permission to submit this change has been revoked. Export your unsaved draft to keep it.', 403, 'ACTION_FORBIDDEN');
    const assertObject = () => {
      assertSession(session);
      if (objectId && (session.unavailableObjects.has(objectId) || (session.objectGenerations.get(objectId) || 0) !== objectGeneration)) throw unavailable();
      if (relatedGenerations.some(({ id, generation }) => session.unavailableObjects.has(id) || (session.objectGenerations.get(id) || 0) !== generation)) throw referenceUnavailable();
      if (taskRequest && taskGeneration !== session.taskSnapshotGeneration) throw new RequestError(`${path.startsWith('/api/projects/') ? 'Project' : 'Task'} visibility changed while loading. Reload this object; unsaved drafts are retained.`, 409, 'ACCESS_CHANGED');
    };
    const controller = new AbortController();
    session.controllers.add(controller);
    if (taskRequest && !options) session.taskReadControllers.add(controller);
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
      if (response.ok && boardMutation && data && typeof data === 'object' && 'projectId' in data && data.projectId === objectId && 'saved' in data && data.saved === true && 'refreshRequired' in data && data.refreshRequired === true && 'boardVersion' in data && Number.isSafeInteger(data.boardVersion) && Number(data.boardVersion) >= 0) {
        assertSession(session);
        if ('accessEpoch' in data && Number.isSafeInteger(data.accessEpoch) && Number(data.accessEpoch) >= 0) session.accessEpoch = Math.max(session.accessEpoch, Number(data.accessEpoch));
        // A card move may change tags and task versions without a policy change.
        // Never leave an older task, project or board snapshot available offline.
        invalidateTaskSnapshots();
        return { projectId: objectId, saved: true, refreshRequired: true, boardVersion: data.boardVersion, accessEpoch: session.accessEpoch } as T;
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
        if (importSource && code === 'PROJECT_REFERENCE_UNAVAILABLE') invalidateObjects([importSource]);
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
  const draftRecords = (): { key: string; value: unknown }[] => {
    if (!sessionIsActive(session) || durable) return [];
    const ordinary = [...session.memory].filter(([key, value]) => {
      if (key.startsWith('comment-source:') || key.startsWith('task-comment:')) { try { return hasSavedWork(key, JSON.parse(value)); } catch { return false; } }
      return key.startsWith('draft:') || key.startsWith('version-draft:') || key.startsWith('task-draft:') || key.startsWith('task-projects:') || (key.startsWith('project-draft:') || key.startsWith('project-child:')) || key.startsWith('workboard-move:');
    }).map(([key, value]) => ({ key, value: JSON.parse(value) as unknown }));
    return [...ordinary, ...quarantinedDrafts().map(draft => ({ key: draft.key, value: draft.value }))];
  };
  const onTaskSnapshotChange = (listener: () => void) => { session?.taskSnapshotListeners.add(listener); return () => { session?.taskSnapshotListeners.delete(listener); }; };
  return { session, durable, unavailableObject, onAccessChange, onWorkboardSnapshotChange: onTaskSnapshotChange, workboardSnapshotGeneration: () => session?.taskSnapshotGeneration ?? -1, onProjectSnapshotChange: onTaskSnapshotChange, projectSnapshotGeneration: () => session?.taskSnapshotGeneration ?? -1, onTaskSnapshotChange, taskSnapshotGeneration: () => session?.taskSnapshotGeneration ?? -1, reconcileAccess, quarantinedDrafts, draftIsHeld, draftHasUnsavedMemory: (key: string) => Boolean(durable && session?.memory.has(`${key}:unsaved-memory`)), quarantineWarning, retryQuarantineStorage, discardQuarantinedDraft, readStored, writeStored, removeStored, removeStoredIfEqual, request, changeOutbox, draftRecords, storageKey: contentKey, assertActive: () => assertSession(session), isActive: () => sessionIsActive(session) };
}
export type WorkspaceClient = ReturnType<typeof createWorkspaceClient>;
// Non-React callers must explicitly establish a session before using these helpers.
export function readStored<T>(key: string, fallback: T): T { return createWorkspaceClient().readStored(key, fallback); }
export function writeStored(key: string, value: unknown): boolean { return createWorkspaceClient().writeStored(key, value); }
export function removeStored(key: string): void { createWorkspaceClient().removeStored(key); }
export function request<T>(path: string, options?: { method: MutationMethod; body: unknown; id?: string; queued?: boolean }): Promise<T> { return createWorkspaceClient().request<T>(path, options); }
export function changeOutbox(change: (current: PendingMutation[]) => PendingMutation[]): Promise<PendingMutation[]> { return createWorkspaceClient().changeOutbox(change); }
