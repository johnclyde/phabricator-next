import type { SessionState } from '../shared/auth';
import type { AuthProviders } from '../shared/google-auth';
import { applicationPath, storageKey } from './mount';

export class SessionChangedError extends Error {
  constructor() { super('Your session changed. Reconnect or sign in before continuing.'); this.name = 'SessionChangedError'; }
}
export class RequestError extends Error { constructor(message: string, public status: number, public code?: string) { super(message); } }
export interface QuarantinedDraft { recoveryId: string; key: string; objectId: string; value: unknown; reason: string }
export interface WorkspaceSession {
  readonly generation: number;
  readonly state: SessionState;
  readonly memory: Map<string, string>;
  readonly controllers: Set<AbortController>;
  readonly objectControllers: Map<AbortController, string>;
  readonly objectCapabilities: Map<string, { edit: boolean; interact: boolean }>;
  readonly objectGenerations: Map<string, number>;
  readonly revisionRepositories: Map<string, string>;
  readonly revisionFiles: Map<string, Set<string>>;
  readonly unavailableObjects: Set<string>;
  readonly cleanupCallbacks: Set<() => void>;
  readonly quarantinePersisted: Set<string>;
  readonly quarantineLoaded: Set<string>;
  readonly quarantinePending: Set<string>;
  quarantineWarning: string;
  readonly quarantinedDrafts: Map<string, QuarantinedDraft>;
  readonly accessListeners: Set<(objectIds: string[]) => void>;
  readonly taskSnapshotListeners: Set<() => void>;
  readonly taskReadControllers: Set<AbortController>;
  taskSnapshotGeneration: number;
  visibleObjects: Set<string> | null;
  accessEpoch: number;
  accessGeneration: number;
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
    for (const cleanup of previous.cleanupCallbacks) cleanup(); previous.cleanupCallbacks.clear();
    for (const controller of previous.controllers) controller.abort();
    previous.controllers.clear(); previous.memory.clear(); previous.objectControllers.clear();
    previous.quarantinedDrafts.clear(); previous.accessListeners.clear(); previous.taskSnapshotListeners.clear(); previous.taskReadControllers.clear();
  }
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
  for (const listener of listeners) listener(reason);
}
export function activateSession(state: SessionState): WorkspaceSession {
  if (state.mode === 'password' && (!state.account || !state.sessionContext || !state.csrfToken)) throw new SessionChangedError();
  if (active) lockSession();
  const session: WorkspaceSession = { generation: ++generation, state, memory: new Map(), controllers: new Set(), objectControllers: new Map(), objectCapabilities: new Map(), objectGenerations: new Map(), revisionRepositories: new Map(), revisionFiles: new Map(), unavailableObjects: new Set(), cleanupCallbacks: new Set(), quarantinePersisted: new Set(), quarantineLoaded: new Set(), quarantinePending: new Set(), quarantineWarning: '', quarantinedDrafts: new Map(), accessListeners: new Set(), taskSnapshotListeners: new Set(), taskReadControllers: new Set(), taskSnapshotGeneration: 0, visibleObjects: null, accessEpoch: -1, accessGeneration: 0, active: true };
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
export async function sessionRequest(path: '/api/session' | '/api/login' | '/api/login/google' | '/api/logout', options: {
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

/** Public sign-in configuration is read online and is never workspace content or a stored grant. */
export async function authProvidersRequest(signal?: AbortSignal): Promise<AuthProviders> {
  const response = await fetch(applicationPath('/api/auth/providers'), { credentials: 'same-origin', cache: 'no-store', signal });
  if (!response.ok) throw new Error('Google sign-in availability could not be checked. Password sign-in remains available.');
  const value: unknown = await response.json();
  if (!value || typeof value !== 'object' || !('google' in value)) throw new Error('The server returned invalid sign-in settings.');
  const config = value.google;
  if (config === null && Object.keys(value).length === 1) return { google: null };
  if (Object.keys(value).length !== 1 || !config || typeof config !== 'object' || Object.keys(config).sort().join(',') !== 'apiKey,appId,authDomain,projectId') throw new Error('The server returned invalid Google sign-in settings.');
  const row = config as Record<string, unknown>;
  if (typeof row.projectId !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(row.projectId) || row.authDomain !== `${row.projectId}.firebaseapp.com` || typeof row.apiKey !== 'string' || !/^[A-Za-z0-9_-]{20,256}$/.test(row.apiKey) || typeof row.appId !== 'string' || !/^1:[0-9]{1,30}:web:[a-f0-9]{8,64}$/.test(row.appId)) throw new Error('The server returned invalid Google sign-in settings.');
  return value as AuthProviders;
}
