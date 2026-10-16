/** Public synchronization status deliberately excludes operator paths, URLs, and credentials. */
export type RepositoryAuthorityMode = 'observe' | 'host';
export type RepositorySyncDirection = 'fetch' | 'push';
export type RepositorySyncState = 'idle' | 'queued' | 'running' | 'retrying' | 'failed';
export interface RepositorySyncTarget {
  key: string;
  direction: RepositorySyncDirection;
  state: RepositorySyncState;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  nextAttemptAt: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  attempts: number;
}
export interface RepositorySyncAttempt {
  id: string;
  targetKey: string;
  direction: RepositorySyncDirection;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'succeeded' | 'failed' | 'interrupted';
  message: string | null;
  changedRefs: number | null;
}
export interface RepositorySyncSnapshot {
  repositoryId: string;
  mode: RepositoryAuthorityMode | 'unconfigured';
  configuration: string | null;
  intervalSeconds: number | null;
  targets: RepositorySyncTarget[];
  recentAttempts: RepositorySyncAttempt[];
}
export interface RepositorySyncInput { expectedConfiguration: string; expectedAccessEpoch: number }
export interface RepositorySyncReceipt { requestId: string; configuration: string; replayed: boolean }
export interface RepositoryOperations {
  snapshot: RepositorySyncSnapshot;
  canSync: boolean;
  cloneUrl: string | null;
  accessEpoch: number;
  pendingReceives?: number;
  receipt?: RepositorySyncReceipt;
}
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const time = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
const optionalTime = (value: unknown) => value === null || time(value);
const message = (value: unknown) => value === null || (typeof value === 'string' && value.length <= 500);
const configuration = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function isRepositorySyncSnapshot(value: unknown, repositoryId?: string): value is RepositorySyncSnapshot {
  if (!record(value) || typeof value.repositoryId !== 'string' || !/^R[1-9]\d*$/.test(value.repositoryId) || (repositoryId !== undefined && value.repositoryId !== repositoryId) || !['observe', 'host', 'unconfigured'].includes(String(value.mode))) return false;
  if (value.mode === 'unconfigured' ? value.configuration !== null || value.intervalSeconds !== null : !configuration(value.configuration) || !count(value.intervalSeconds) || value.intervalSeconds < 30) return false;
  if (!Array.isArray(value.targets) || value.targets.length > 17 || !Array.isArray(value.recentAttempts) || value.recentAttempts.length > 50) return false;
  if (!value.targets.every(target => record(target) && typeof target.key === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(target.key) && ['fetch', 'push'].includes(String(target.direction)) && ['idle', 'queued', 'running', 'retrying', 'failed'].includes(String(target.state)) && optionalTime(target.lastAttemptAt) && optionalTime(target.lastSuccessAt) && optionalTime(target.nextAttemptAt) && count(target.consecutiveFailures) && count(target.attempts) && message(target.lastError))) return false;
  if (new Set(value.targets.map(target => (target as RepositorySyncTarget).key)).size !== value.targets.length) return false;
  return value.recentAttempts.every(attempt => record(attempt) && typeof attempt.id === 'string' && attempt.id.length <= 100 && typeof attempt.targetKey === 'string' && ['fetch', 'push'].includes(String(attempt.direction)) && ['running', 'succeeded', 'failed', 'interrupted'].includes(String(attempt.status)) && time(attempt.startedAt) && optionalTime(attempt.finishedAt) && message(attempt.message) && (attempt.changedRefs === null || count(attempt.changedRefs)));
}
export function isRepositoryOperations(value: unknown, repositoryId?: string): value is RepositoryOperations {
  if (!record(value) || !isRepositorySyncSnapshot(value.snapshot, repositoryId) || typeof value.canSync !== 'boolean' || !count(value.accessEpoch) || (value.pendingReceives !== undefined && !count(value.pendingReceives))) return false;
  if (value.cloneUrl !== null) {
    if (typeof value.cloneUrl !== 'string' || value.cloneUrl.length > 4096) return false;
    try { const url = new URL(value.cloneUrl); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return false; } catch { return false; }
  }
  return value.receipt === undefined || (record(value.receipt) && typeof value.receipt.requestId === 'string' && value.receipt.requestId.length > 0 && value.receipt.requestId.length <= 200 && configuration(value.receipt.configuration) && typeof value.receipt.replayed === 'boolean');
}
export function validRepositorySyncReceipt(value: unknown, repositoryId: string, requestId: string, input: RepositorySyncInput): value is RepositoryOperations & { receipt: RepositorySyncReceipt } {
  return isRepositoryOperations(value, repositoryId) && value.receipt !== undefined && value.receipt.requestId === requestId && value.receipt.configuration === input.expectedConfiguration && value.snapshot.configuration === input.expectedConfiguration && value.accessEpoch === input.expectedAccessEpoch;
}
