export type MutationMethod = 'POST' | 'PATCH' | 'PUT';
export interface PendingMutation { id: string; path: string; method: MutationMethod; body: unknown; label: string; createdAt: string; error?: string }
const PREFIX = 'phabricator-next:';
export function readStored<T>(key: string, fallback: T): T {
  try { const value = localStorage.getItem(PREFIX + key); return value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
}
export function writeStored(key: string, value: unknown): boolean {
  try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); return true; } catch { return false; }
}
export function removeStored(key: string): void { try { localStorage.removeItem(PREFIX + key); } catch { /* storage can be unavailable */ } }
export function canQueue(path: string, method: MutationMethod): boolean {
  return (path === '/api/tasks' && method === 'POST') || (/^\/api\/tasks\/[^/]+$/.test(path) && method === 'PATCH') || (path === '/api/documents' && method === 'POST') || (/^\/api\/documents\/[^/]+$/.test(path) && method === 'PUT') || (/^\/api\/revisions\/[^/]+\/(comments|versions)$/.test(path) && method === 'POST');
}
export class RequestError extends Error { constructor(message: string, public status: number) { super(message); } }
export async function request<T>(path: string, options?: { method: MutationMethod; body: unknown; id?: string }): Promise<T> {
  const response = await fetch(path, options ? { method: options.method, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': options.id || crypto.randomUUID() }, body: JSON.stringify(options.body) } : undefined);
  const data: unknown = await response.json();
  if (!response.ok) throw new RequestError(typeof data === 'object' && data !== null && 'error' in data ? String(data.error) : `Request failed (${response.status})`, response.status);
  return data as T;
}
export function isNetworkError(error: unknown): boolean { return error instanceof TypeError; }

export async function changeOutbox(change: (current: PendingMutation[]) => PendingMutation[]): Promise<PendingMutation[]> {
  const commit = () => {
    const next = change(readStored<PendingMutation[]>('outbox', []));
    if (!writeStored('outbox', next)) throw new Error('Browser storage is unavailable. Your change has not been saved. Keep the draft open or export it.');
    return next;
  };
  if (typeof navigator !== 'undefined' && navigator.locks) return navigator.locks.request('phabricator-next:outbox-write', commit);
  return commit();
}
