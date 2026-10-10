import type { SessionState } from '../shared/auth';
import { applicationPath, storageKey } from './mount';

export class SessionChangedError extends Error {
  constructor() { super('Your session changed. Reconnect or sign in before continuing.'); this.name = 'SessionChangedError'; }
}
export class RequestError extends Error { constructor(message: string, public status: number) { super(message); } }
export interface WorkspaceSession {
  readonly generation: number;
  readonly state: SessionState;
  readonly memory: Map<string, string>;
  readonly controllers: Set<AbortController>;
  active: boolean;
}
let generation = 0;
let active: WorkspaceSession | null = null;
const listeners = new Set<(reason: string) => void>();

export function currentSession(): WorkspaceSession | null { return active; }
export function sessionIsActive(session: WorkspaceSession | null): session is WorkspaceSession { return session !== null && session.active && active === session; }
export function onSessionLocked(listener: (reason: string) => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function lockSession(reason = 'Your session changed. Please sign in again.'): void {
  generation += 1;
  const previous = active;
  active = null;
  if (previous) {
    previous.active = false;
    for (const controller of previous.controllers) controller.abort();
    previous.controllers.clear(); previous.memory.clear();
  }
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
  for (const listener of listeners) listener(reason);
}
export function activateSession(state: SessionState): WorkspaceSession {
  if (state.mode === 'password' && (!state.account || !state.sessionContext || !state.csrfToken)) throw new SessionChangedError();
  if (active) lockSession();
  const session: WorkspaceSession = { generation: ++generation, state, memory: new Map(), controllers: new Set(), active: true };
  active = session;
  return session;
}
export function assertSession(session: WorkspaceSession | null): asserts session is WorkspaceSession {
  if (!sessionIsActive(session)) throw new SessionChangedError();
  if (session.state.expiresAt && Date.parse(session.state.expiresAt) <= Date.now()) {
    lockSession('Your session expired. Sign in again.'); throw new SessionChangedError();
  }
}

/** Public authentication responses are never persisted or passed through workspace caching. */
export async function sessionRequest(path: '/api/session' | '/api/login' | '/api/logout', options: {
  body?: unknown; csrfToken?: string | null; sessionContext?: string | null; signal?: AbortSignal;
} = {}): Promise<SessionState> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.csrfToken) headers['X-CSRF-Token'] = options.csrfToken;
  if (options.sessionContext) headers['X-Session-Context'] = options.sessionContext;
  const response = await fetch(applicationPath(path), { method: options.body === undefined ? 'GET' : 'POST', headers, credentials: 'same-origin', cache: 'no-store', signal: options.signal, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) });
  const data: unknown = await response.json();
  if (!response.ok) throw new RequestError(typeof data === 'object' && data !== null && 'error' in data ? String(data.error) : `Request failed (${response.status})`, response.status);
  if (!data || typeof data !== 'object' || !('mode' in data) || !['local', 'password'].includes(String(data.mode)) || !('workspaceId' in data) || typeof data.workspaceId !== 'string') throw new Error('The server returned an invalid session.');
  return data as SessionState;
}

export function rememberMode(state: SessionState): void {
  try {
    // A quota failure must not leave a previous local-mode grant behind after
    // the server has told us this workspace now requires authentication.
    localStorage.removeItem(storageKey('verified-mode'));
    localStorage.setItem(storageKey('verified-mode'), JSON.stringify({ mode: state.mode, workspaceId: state.workspaceId }));
  } catch { /* Metadata is optional; unknown installations cannot open offline. */ }
}
export function rememberedLocalSession(): SessionState | null {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(storageKey('verified-mode')) || 'null');
    if (saved && typeof saved === 'object' && 'mode' in saved && saved.mode === 'local' && 'workspaceId' in saved && typeof saved.workspaceId === 'string') return { mode: 'local', workspaceId: saved.workspaceId, account: null, sessionContext: null, csrfToken: null, expiresAt: null };
  } catch { /* Unknown mode always stays locked. */ }
  return null;
}
export function logoutPending(): boolean { try { return localStorage.getItem(storageKey('logout-pending')) === 'true'; } catch { return false; } }
export function markLogoutPending(value: boolean): void {
  try { if (value) localStorage.setItem(storageKey('logout-pending'), 'true'); else localStorage.removeItem(storageKey('logout-pending')); } catch { /* The gate remains locked in memory if storage is unavailable. */ }
}
export function broadcastSessionChange(kind: 'login' | 'logout'): void {
  try { localStorage.setItem(storageKey('session-event'), JSON.stringify({ kind, nonce: crypto.randomUUID() })); } catch { /* Server context checks also prevent cross-account requests. */ }
}
