import { applicationPath, storageKey } from './mount';
import { assertSession, currentSession, lockSession, RequestError, sessionIsActive, type WorkspaceSession } from './session';
export { RequestError } from './session';

export type MutationMethod = 'POST' | 'PATCH' | 'PUT';
export interface PendingMutation { id: string; path: string; method: MutationMethod; body: unknown; label: string; createdAt: string; error?: string }
export function canQueue(path: string, method: MutationMethod): boolean {
  return (path === '/api/tasks' && method === 'POST') || (/^\/api\/tasks\/[^/]+$/.test(path) && method === 'PATCH') || (path === '/api/documents' && method === 'POST') || (/^\/api\/documents\/[^/]+$/.test(path) && method === 'PUT') || (/^\/api\/revisions\/[^/]+\/(comments|versions)$/.test(path) && method === 'POST');
}
export function isNetworkError(error: unknown): boolean { return error instanceof TypeError; }

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
  const readStored = <T,>(key: string, fallback: T): T => {
    if (!sessionIsActive(session)) return fallback;
    try { const value = durable ? localStorage.getItem(contentKey(key)) : session.memory.get(key); return value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
  };
  const writeStored = (key: string, value: unknown): boolean => {
    if (!sessionIsActive(session)) return false;
    try { const json = JSON.stringify(value); if (durable) localStorage.setItem(contentKey(key), json); else session.memory.set(key, json); return true; } catch { return false; }
  };
  const removeStored = (key: string): void => {
    if (!sessionIsActive(session)) return;
    try { if (durable) localStorage.removeItem(contentKey(key)); else session.memory.delete(key); } catch { /* Storage can be unavailable. */ }
  };
  const request = async <T,>(path: string, options?: { method: MutationMethod; body: unknown; id?: string }): Promise<T> => {
    assertSession(session);
    const controller = new AbortController();
    session.controllers.add(controller);
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
      assertSession(session);
      if (!response.ok) throw new RequestError(typeof data === 'object' && data !== null && 'error' in data ? String(data.error) : `Request failed (${response.status})`, response.status);
      return data as T;
    } catch (error) { assertSession(session); throw error; }
    finally { session.controllers.delete(controller); }
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
    return [...session.memory].filter(([key, value]) => {
      if (key.startsWith('comment-source:')) { try { return Boolean((JSON.parse(value) as { body?: string }).body?.trim()); } catch { return false; } }
      return key.startsWith('draft:') || key.startsWith('version-draft:');
    }).map(([key, value]) => ({ key, value: JSON.parse(value) as unknown }));
  };
  return { session, durable, readStored, writeStored, removeStored, request, changeOutbox, draftRecords, storageKey: contentKey, assertActive: () => assertSession(session), isActive: () => sessionIsActive(session) };
}
export type WorkspaceClient = ReturnType<typeof createWorkspaceClient>;
// Non-React callers must explicitly establish a session before using these helpers.
export function readStored<T>(key: string, fallback: T): T { return createWorkspaceClient().readStored(key, fallback); }
export function writeStored(key: string, value: unknown): boolean { return createWorkspaceClient().writeStored(key, value); }
export function removeStored(key: string): void { createWorkspaceClient().removeStored(key); }
export function request<T>(path: string, options?: { method: MutationMethod; body: unknown; id?: string }): Promise<T> { return createWorkspaceClient().request<T>(path, options); }
export function changeOutbox(change: (current: PendingMutation[]) => PendingMutation[]): Promise<PendingMutation[]> { return createWorkspaceClient().changeOutbox(change); }
