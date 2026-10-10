import type { ObjectAccess } from '../shared/policy';
import { applicationPath, storageKey } from './mount';
import { assertSession, currentSession, lockSession, RequestError, sessionIsActive, type WorkspaceSession, type QuarantinedDraft } from './session';
export { RequestError } from './session';

export type MutationMethod = 'POST' | 'PATCH' | 'PUT';
export interface PendingMutation { id: string; path: string; method: MutationMethod; body: unknown; label: string; createdAt: string; error?: string }
export function canQueue(path: string, method: MutationMethod): boolean {
  return (path === '/api/tasks' && method === 'POST') || (/^\/api\/tasks\/[^/]+$/.test(path) && method === 'PATCH') || (path === '/api/documents' && method === 'POST') || (/^\/api\/documents\/[^/]+$/.test(path) && method === 'PUT') || (/^\/api\/revisions\/[^/]+\/(comments|versions)$/.test(path) && method === 'POST');
}
export function isNetworkError(error: unknown): boolean { return error instanceof TypeError; }
function objectFromPath(path: string): string | null { return /^\/api\/(?:revisions|documents|tasks|projects|repositories|policies|spaces)\/([A-Z]+\d+)(?:[/?]|$)/.exec(path)?.[1] || null; }
function queuedObject(item: PendingMutation): string | null {
  const id = objectFromPath(item.path); if (id) return id;
  if (item.method !== 'POST' || !['/api/tasks', '/api/documents'].includes(item.path)) return null;
  const body = item.body as { access?: { spaceId?: unknown } } | null;
  return body?.access && typeof body.access.spaceId === 'string' ? body.access.spaceId : 'S1';
}
function objectFromKey(key: string): string | null { return /^(?:revision|wiki|version-draft|comment-source):([A-Z]+\d+)(?:[:]|$)/.exec(key)?.[1] || /^draft:document:([A-Z]+\d+):/.exec(key)?.[1] || null; }
function isDraftKey(key: string): boolean { return key.startsWith('draft:') || key.startsWith('version-draft:') || key.startsWith('comment-source:'); }
function hasSavedWork(key: string, value: unknown): boolean { return !key.startsWith('comment-source:') || Boolean(value && typeof value === 'object' && 'body' in value && typeof value.body === 'string' && value.body.trim()); }
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
  const blockedDraft = (key: string): boolean => {
    const id = objectFromKey(key); const capabilities = id ? session?.objectCapabilities.get(id) : null;
    return Boolean(id && isDraftKey(key) && capabilities && !(key.startsWith('comment-source:') ? capabilities.interact : capabilities.edit));
  };
  const savedEntries = (): [string, string][] => {
    if (!sessionIsActive(session)) return [];
    if (!durable) return [...session.memory];
    const entries: [string, string][] = [];
    try { for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i); if (key?.startsWith(contentKey(''))) entries.push([key.slice(contentKey('').length), localStorage.getItem(key) || 'null']); } } catch { /* Unavailable storage stays unreadable. */ }
    return entries;
  };
  const rawRead = (key: string): string | null => { try { return durable ? localStorage.getItem(contentKey(key)) : session?.memory.get(key) || null; } catch { return null; } };
  const rawWrite = (key: string, value: unknown): boolean => { try { const json = JSON.stringify(value); if (durable) localStorage.setItem(contentKey(key), json); else session?.memory.set(key, json); return true; } catch { return false; } };
  const rawRemove = (key: string): boolean => { try { if (durable) localStorage.removeItem(contentKey(key)); else session?.memory.delete(key); return true; } catch { return false; } };
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
  if (durable && sessionIsActive(session) && !session.quarantineLoaded.has(contentKey('quarantined-drafts'))) {
    session.quarantineLoaded.add(contentKey('quarantined-drafts')); syncDurableQuarantine();
    if (rawRead('quarantine-format') !== '2' || rawRead('quarantine-ready') !== '1') {
      if (!persistQuarantine()) recoverOriginals();
    }
    if (typeof window !== 'undefined') {
      const changed = (event: StorageEvent) => {
        if (!sessionIsActive(session)) return;
        if (event.key === null || event.key === contentKey('quarantine-ready') || event.key?.startsWith(contentKey('quarantined-drafts:'))) { syncDurableQuarantine(); quarantineChanged(); }
      };
      window.addEventListener('storage', changed);
      session.cleanupCallbacks.add(() => window.removeEventListener('storage', changed));
    }
  }
  const readStored = <T,>(key: string, fallback: T): T => {
    syncDurableQuarantine();
    if (!sessionIsActive(session) || session.unavailableObjects.has(objectFromKey(key) || '') || blockedDraft(key) || session.quarantinedDrafts.has(key)) return fallback;
    try { const value = rawRead(key); const parsed: unknown = value ? JSON.parse(value) : fallback; return (key === 'outbox' && Array.isArray(parsed) ? (parsed as PendingMutation[]).filter(item => !session.quarantinedDrafts.has(`outbox:${item.id}`)) : parsed) as T; } catch { return fallback; }
  };
  const writeStored = (key: string, value: unknown): boolean => {
    syncDurableQuarantine();
    if (!sessionIsActive(session) || session.unavailableObjects.has(objectFromKey(key) || '')) return false;
    if (blockedDraft(key)) { if (!hasSavedWork(key, value)) return true; return quarantine({ key, objectId: objectFromKey(key)!, value, reason: 'Permission to submit this draft changed' }); }
    if (session.quarantinedDrafts.has(key)) return false;
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
    for (const id of changed) {
      session.unavailableObjects.add(id);
      session.objectGenerations.set(id, (session.objectGenerations.get(id) || 0) + 1);
      for (const [controller, objectId] of session.objectControllers) if (objectId === id) controller.abort();
    }
    const entries = savedEntries();
    for (const [key, json] of entries) {
      const objectId = objectFromKey(key);
      if (!objectId || !changed.includes(objectId)) continue;
      if (isDraftKey(key)) {
        try { const value: unknown = JSON.parse(json); if (hasSavedWork(key, value) && !quarantine({ key, objectId, value, reason: 'Object access changed' })) continue; } catch { continue; }
      }
      removeStored(key);
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
    const cachedState = readStored<{ access?: Record<string, ObjectAccess>; spaces?: { id: string }[] } | null>('state', null);
    const cachedObjects = savedEntries().map(([key]) => objectFromKey(key)).filter((id): id is string => id !== null);
    const known = new Set([...(session.visibleObjects || []), ...session.objectGenerations.keys(), ...cachedObjects, ...rawOutbox().map(queuedObject).filter((id): id is string => id !== null), ...Object.keys(cachedState?.access || {}), ...(cachedState?.spaces || []).map(space => space.id)]);
    invalidateObjects([...known].filter(id => !visible.has(id)));
    for (const [id, value] of Object.entries(access)) session.objectCapabilities.set(id, value.capabilities);
    let draftsChanged = false;
    for (const [key, json] of savedEntries()) if (blockedDraft(key)) {
      try { const value: unknown = JSON.parse(json); if (hasSavedWork(key, value)) { const saved = quarantine({ key, objectId: objectFromKey(key)!, value, reason: 'Permission to submit this draft changed' }); draftsChanged = true; if (!saved) continue; } removeStored(key); } catch { /* Preserve unreadable draft bytes in place. */ }
    }
    const queue = readStored<PendingMutation[]>('outbox', []);
    const forbidden = queue.filter(item => { const id = queuedObject(item); if (id?.startsWith('S')) return !spaceIds.includes(id) || archivedSpaceIds.includes(id); const capabilities = id ? session.objectCapabilities.get(id) : null; return capabilities && !(item.path.endsWith('/comments') ? capabilities.interact : capabilities.edit); });
    for (const item of forbidden) { quarantine({ key: `outbox:${item.id}`, objectId: queuedObject(item)!, value: item, reason: 'Permission or destination Space changed; automatic submission stopped' }); draftsChanged = true; }
    if (draftsChanged) for (const listener of session.accessListeners) listener([]);
    session.visibleObjects = visible;
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
      if (!session.quarantinedDrafts.has(key)) return;
      // Use the same lock as normal outbox changes, then reread the latest queue.
      // Quarantine itself never rewrites this shared aggregate.
      const removed = key.startsWith('outbox:') ? rawWrite('outbox', rawOutbox().filter(item => `outbox:${item.id}` !== key)) : rawRemove(key);
      if (!removed) throw new Error('Could not remove the original saved change. Export it and free browser storage before trying again.');
      if (durable && !rawRemove(recordKey(key))) throw new Error('Could not discard the recovery copy. Export it before trying again.');
      session.quarantinedDrafts.delete(key); session.quarantinePending.delete(key); session.quarantinePersisted.delete(key);
      quarantineChanged();
    };
    if (durable && key.startsWith('outbox:') && typeof navigator !== 'undefined' && navigator.locks) await navigator.locks.request(contentKey('outbox-write'), commit);
    else commit();
  };
  const request = async <T,>(path: string, options?: { method: MutationMethod; body: unknown; id?: string; queued?: boolean }): Promise<T> => {
    assertSession(session);
    syncDurableQuarantine();
    if (options?.queued && (!options.id || !readStored<PendingMutation[]>('outbox', []).some(item => item.id === options.id))) throw new RequestError('This queued change was removed or set aside and cannot submit automatically.', 403, 'ACTION_FORBIDDEN');
    if (options?.id && session.quarantinedDrafts.has(`outbox:${options.id}`)) throw new RequestError('This saved change is set aside for export or discard and cannot submit automatically.', 403, 'ACTION_FORBIDDEN');
    const objectId = objectFromPath(path);
    const accessGeneration = session.accessGeneration;
    if (objectId && !objectId.startsWith('S') && !session.objectGenerations.has(objectId)) session.objectGenerations.set(objectId, 0);
    const objectGeneration = objectId ? session.objectGenerations.get(objectId) || 0 : 0;
    if (objectId && session.unavailableObjects.has(objectId)) throw unavailable();
    const capabilities = objectId ? session.objectCapabilities.get(objectId) : null;
    if (options && capabilities && !(/\/(comments|reviews)(?:[/?]|$)/.test(path) ? capabilities.interact : capabilities.edit)) throw new RequestError('Permission to submit this change has been revoked. Export your unsaved draft to keep it.', 403, 'ACTION_FORBIDDEN');
    const assertObject = () => {
      assertSession(session);
      if (objectId && (session.unavailableObjects.has(objectId) || (session.objectGenerations.get(objectId) || 0) !== objectGeneration)) throw unavailable();
    };
    const controller = new AbortController();
    session.controllers.add(controller);
    if (objectId) session.objectControllers.set(controller, objectId);
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
      assertObject();
      if (path === '/api/state' && accessGeneration !== session.accessGeneration) throw new RequestError('Access changed while loading. Reload the workspace.', 409, 'ACCESS_CHANGED');
      if (!response.ok) {
        const code = typeof data === 'object' && data !== null && 'code' in data ? String(data.code) : undefined;
        if (objectId && code === 'OBJECT_UNAVAILABLE') invalidateObjects([objectId]);
        throw new RequestError(typeof data === 'object' && data !== null && 'error' in data ? String(data.error) : `Request failed (${response.status})`, response.status, code);
      }
      if (typeof data === 'object' && data !== null && 'accessEpoch' in data && typeof data.accessEpoch === 'number') {
        if (data.accessEpoch < session.accessEpoch) throw new RequestError('Access changed while loading. Reload the workspace.', 409, 'ACCESS_CHANGED');
        if (path === '/api/state' && 'access' in data && data.access && typeof data.access === 'object') reconcileAccess(data.access as Record<string, ObjectAccess>, data.accessEpoch, 'spaces' in data && Array.isArray(data.spaces) ? data.spaces.flatMap((space: unknown) => space && typeof space === 'object' && 'id' in space && typeof space.id === 'string' ? [space.id] : []) : [], 'spaces' in data && Array.isArray(data.spaces) ? data.spaces.flatMap((space: unknown) => space && typeof space === 'object' && 'id' in space && typeof space.id === 'string' && 'archived' in space && space.archived === true ? [space.id] : []) : []);
        else session.accessEpoch = data.accessEpoch;
      }
      assertObject();
      return data as T;
    } catch (error) { assertObject(); throw error; }
    finally { session.controllers.delete(controller); session.objectControllers.delete(controller); }
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
      if (key.startsWith('comment-source:')) { try { return Boolean((JSON.parse(value) as { body?: string }).body?.trim()); } catch { return false; } }
      return key.startsWith('draft:') || key.startsWith('version-draft:');
    }).map(([key, value]) => ({ key, value: JSON.parse(value) as unknown }));
    return [...ordinary, ...quarantinedDrafts().map(draft => ({ key: draft.key, value: draft.value }))];
  };
  return { session, durable, unavailableObject, onAccessChange, reconcileAccess, quarantinedDrafts, quarantineWarning, retryQuarantineStorage, discardQuarantinedDraft, readStored, writeStored, removeStored, request, changeOutbox, draftRecords, storageKey: contentKey, assertActive: () => assertSession(session), isActive: () => sessionIsActive(session) };
}
export type WorkspaceClient = ReturnType<typeof createWorkspaceClient>;
// Non-React callers must explicitly establish a session before using these helpers.
export function readStored<T>(key: string, fallback: T): T { return createWorkspaceClient().readStored(key, fallback); }
export function writeStored(key: string, value: unknown): boolean { return createWorkspaceClient().writeStored(key, value); }
export function removeStored(key: string): void { createWorkspaceClient().removeStored(key); }
export function request<T>(path: string, options?: { method: MutationMethod; body: unknown; id?: string; queued?: boolean }): Promise<T> { return createWorkspaceClient().request<T>(path, options); }
export function changeOutbox(change: (current: PendingMutation[]) => PendingMutation[]): Promise<PendingMutation[]> { return createWorkspaceClient().changeOutbox(change); }
