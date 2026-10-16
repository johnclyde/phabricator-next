import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import { lstat, mkdir, open, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { RepositoryAuthorityMode, RepositorySyncAttempt, RepositorySyncDirection, RepositorySyncInput, RepositorySyncReceipt, RepositorySyncSnapshot, RepositorySyncTarget } from '../shared/repository-sync.ts';
import { createGitObserver } from './git.ts';
import { createPublicGitProjection } from './git-public-projection.ts';
import { HttpError } from './validation.ts';

export interface RepositorySyncRemote { url: string; credentialFile?: string }
export interface RepositorySyncMirror extends RepositorySyncRemote { key: string; allowRewrite?: boolean }
export interface RepositorySyncBinding {
  repositoryId: string; path: string; mode: RepositoryAuthorityMode;
  observe?: RepositorySyncRemote; mirrors?: RepositorySyncMirror[]; intervalSeconds?: number;
}
export interface RepositorySyncPlan extends RepositorySyncRemote { key: string; direction: RepositorySyncDirection; allowRewrite?: boolean }
export interface RepositorySyncResult { changedRefs: number; refs?: Record<string, string> }
export interface RepositorySyncTransport {
  sync(binding: Readonly<RepositorySyncBinding>, target: Readonly<RepositorySyncPlan>, context: { signal: AbortSignal; previousRefs: Readonly<Record<string, string>> }): Promise<RepositorySyncResult>;
}
export interface RepositorySyncOptions {
  now?: () => number; timeoutMs?: number; concurrency?: number; transport?: RepositorySyncTransport;
  /** Explicit fixture transport opt-in. Never set this from environment or an HTTP request. */
  allowLocalRemotesForTests?: boolean;
}
interface TargetRow { repository_id: string; target_key: string; configuration: string; data: string; next_at: number | null; requested: number; refs: string }
interface LeaseRow { repository_id: string; token: string; expires_at: number }
interface RequestRow { signature: string }
interface AttemptRow { data: string }
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const idPattern = /^R[1-9]\d{0,48}$/;
const keyPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const oidPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const configError = () => new Error('Repository sync configuration must contain distinct repository IDs, absolute bare paths, one authority, and explicit HTTPS remotes.');
const messages = {
  unavailable: 'The configured repository is unavailable or its configuration changed.',
  transport: 'Git synchronization failed. Check repository availability and operator credentials.',
  conflict: 'The mirror has conflicting changes. Reconcile the destination or explicitly allow rewriting before retrying.',
  credentials: 'The configured credential file is unavailable or unsafe.',
  limit: 'Git synchronization exceeded its time or result limit.',
  cancelled: 'Synchronization was interrupted and is queued for retry.',
  busy: 'The repository is busy. Synchronization will retry.',
};
class SyncError extends HttpError {
  constructor(readonly kind: keyof typeof messages) {
    super(kind === 'busy' || kind === 'conflict' ? 409 : kind === 'cancelled' ? 499 : kind === 'limit' ? 422 : 503, messages[kind], `REPOSITORY_SYNC_${kind.toUpperCase()}`);
  }
}
const checkAbort = (signal: AbortSignal) => { if (signal.aborted) throw new SyncError('cancelled'); };
const safePath = (value: unknown): value is string => typeof value === 'string' && value.length <= 4096 && isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value);
const plain = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
function remote(value: unknown, local = false): value is RepositorySyncRemote {
  if (!plain(value) || typeof value.url !== 'string' || value.url.length > 4096 || /[\x00-\x20\x7f]/.test(value.url) || (value.credentialFile !== undefined && !safePath(value.credentialFile))) return false;
  if (local && safePath(value.url)) return value.credentialFile === undefined;
  try { const url = new URL(value.url); return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password && !url.search && !url.hash && url.href === value.url; } catch { return false; }
}
function validateBindings(value: unknown, local = false): RepositorySyncBinding[] {
  if (!Array.isArray(value) || value.length > 100) throw configError();
  const result: RepositorySyncBinding[] = [];
  for (const item of value) {
    if (!plain(item) || Object.keys(item).some(key => !['repositoryId', 'path', 'mode', 'observe', 'mirrors', 'intervalSeconds'].includes(key)) || typeof item.repositoryId !== 'string' || !idPattern.test(item.repositoryId) || !safePath(item.path) || !['observe', 'host'].includes(String(item.mode))) throw configError();
    if (item.intervalSeconds !== undefined && (!Number.isSafeInteger(item.intervalSeconds) || Number(item.intervalSeconds) < 30 || Number(item.intervalSeconds) > 86400)) throw configError();
    if (item.mode === 'observe' ? !remote(item.observe, local) : item.observe !== undefined) throw configError();
    if (item.observe && Object.keys(item.observe).some(key => !['url', 'credentialFile'].includes(key))) throw configError();
    if (item.mirrors !== undefined && (!Array.isArray(item.mirrors) || item.mirrors.length > 16 || item.mirrors.some(mirror => !remote(mirror, local) || !plain(mirror) || typeof mirror.key !== 'string' || !keyPattern.test(mirror.key) || mirror.key === 'upstream' || (mirror.allowRewrite !== undefined && typeof mirror.allowRewrite !== 'boolean') || Object.keys(mirror).some(key => !['key', 'url', 'credentialFile', 'allowRewrite'].includes(key))))) throw configError();
    const binding = structuredClone(item) as unknown as RepositorySyncBinding;
    if (result.some(previous => previous.repositoryId === binding.repositoryId || previous.path === binding.path) || new Set(binding.mirrors?.map(mirror => mirror.key)).size !== (binding.mirrors?.length ?? 0)) throw configError();
    if (new Set([...(binding.observe ? [binding.observe.url] : []), ...(binding.mirrors ?? []).map(mirror => mirror.url)]).size !== (binding.observe ? 1 : 0) + (binding.mirrors?.length ?? 0)) throw configError();
    result.push(binding);
  }
  return result;
}
export function parseRepositorySyncBindings(raw: string | undefined): RepositorySyncBinding[] {
  if (raw === undefined || raw === '') return [];
  if (raw.length > 200_000) throw configError();
  try { return validateBindings(JSON.parse(raw)); } catch { throw configError(); }
}
function plans(binding: Readonly<RepositorySyncBinding>): RepositorySyncPlan[] {
  return [...(binding.observe ? [{ ...binding.observe, key: 'upstream', direction: 'fetch' as const }] : []), ...(binding.mirrors ?? []).map(mirror => ({ ...mirror, direction: 'push' as const }))];
}
function fingerprint(binding: Readonly<RepositorySyncBinding>): string {
  return hash(JSON.stringify({ repositoryId: binding.repositoryId, path: binding.path, mode: binding.mode, observe: binding.observe ? { url: binding.observe.url, credentialFile: binding.observe.credentialFile ?? null } : null, mirrors: (binding.mirrors ?? []).map(mirror => ({ key: mirror.key, url: mirror.url, credentialFile: mirror.credentialFile ?? null, allowRewrite: mirror.allowRewrite ?? false })), intervalSeconds: binding.intervalSeconds ?? 300 }));
}
export function initializeRepositorySync(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE repository_sync_targets (
      repository_id TEXT NOT NULL, target_key TEXT NOT NULL, configuration TEXT NOT NULL,
      data TEXT NOT NULL, next_at INTEGER, requested INTEGER NOT NULL DEFAULT 0, refs TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY(repository_id,target_key)
    );
    CREATE TABLE repository_sync_attempts (
      id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, configuration TEXT NOT NULL, target_key TEXT NOT NULL,
      started_at INTEGER NOT NULL, data TEXT NOT NULL
    );
    CREATE INDEX repository_sync_attempt_repository ON repository_sync_attempts(repository_id,started_at DESC);
    CREATE TABLE repository_sync_leases (repository_id TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE repository_sync_requests (actor_id TEXT NOT NULL, request_id TEXT NOT NULL, signature TEXT NOT NULL, PRIMARY KEY(actor_id,request_id));
  `);
}

/** Shared cross-process exclusion for receive-pack and replication. Git ref CAS remains the final fence. */
export async function withRepositorySyncLock<T>(path: string, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  checkAbort(signal);
  const metadata = await lstat(path).catch(() => { throw new SyncError('unavailable'); });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new SyncError('unavailable');
  const canonical = await realpath(path), lock = join(canonical, 'phabricator-write.lock');
  const token = randomUUID(), owner = { token, pid: process.pid, host: hostname() };
  let acquired = false;
  for (let attempt = 0; attempt < 3 && !acquired; attempt++) {
    checkAbort(signal);
    try { await mkdir(lock, { mode: 0o700 }); acquired = true; }
    catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw new SyncError('unavailable');
      const info = await lstat(lock); if (!info.isDirectory() || info.isSymbolicLink()) throw new SyncError('unavailable');
      let stale = false;
      try {
        const file = await readBounded(join(lock, 'owner'), 1024);
        const value = JSON.parse(file.toString('utf8')) as { pid?: number; host?: string };
        if (value.host === hostname() && Number.isSafeInteger(value.pid) && Number(value.pid) > 0) {
          try { process.kill(value.pid!, 0); } catch (failure) { if (failure && typeof failure === 'object' && 'code' in failure && failure.code === 'ESRCH') stale = true; }
        }
      } catch { if (Date.now() - info.mtimeMs > 10 * 60_000) stale = true; }
      if (!stale) throw new SyncError('busy');
      const current = await lstat(lock);
      if (current.ino !== info.ino || current.dev !== info.dev) throw new SyncError('busy');
      await rm(lock, { recursive: true });
    }
  }
  if (!acquired) throw new SyncError('busy');
  try {
    await writeFile(join(lock, 'owner'), JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    const current = await lstat(path);
    if (current.ino !== metadata.ino || current.dev !== metadata.dev || await realpath(path) !== canonical) throw new SyncError('unavailable');
    checkAbort(signal); return await operation();
  } finally { await rm(lock, { recursive: true, force: true }); }
}
async function readBounded(path: string, maximum: number, credential = false): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maximum || (credential && ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())))) throw new SyncError(credential ? 'credentials' : 'unavailable');
    const buffer = Buffer.alloc(maximum + 1); let offset = 0;
    while (offset < buffer.length) { const result = await file.read(buffer, offset, buffer.length - offset, offset); if (!result.bytesRead) break; offset += result.bytesRead; }
    if (offset > maximum) throw new SyncError(credential ? 'credentials' : 'limit');
    return buffer.subarray(0, offset);
  } finally { await file.close(); }
}
const environment: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', HOME: '/nonexistent',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0',
  GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_ATTR_NOSYSTEM: '1', GIT_NO_LAZY_FETCH: '1',
  GIT_PAGER: 'cat', GIT_SSH_COMMAND: '/usr/bin/false', LC_ALL: 'C', TZ: 'UTC',
};
const gitOptions = ['--no-replace-objects', '--literal-pathspecs', '--no-pager', '-c', 'protocol.allow=never', '-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'core.commitGraph=false', '-c', 'core.multiPackIndex=false', '-c', 'http.followRedirects=false', '-c', 'fetch.recurseSubmodules=false', '-c', 'fetch.fsckObjects=true', '-c', 'transfer.fsckObjects=true'];
async function credentialEnvironment(target: Readonly<RepositorySyncPlan>): Promise<NodeJS.ProcessEnv> {
  if (!target.credentialFile) return {};
  try {
    const value: unknown = JSON.parse((await readBounded(target.credentialFile, 16_000, true)).toString('utf8'));
    if (!plain(value) || Object.keys(value).sort().join(',') !== 'token,username' || typeof value.username !== 'string' || typeof value.token !== 'string' || !value.username.length || !value.token.length || /[:\x00-\x1f\x7f]/.test(value.username) || /[\x00-\x1f\x7f]/.test(value.token)) throw new SyncError('credentials');
    return { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${target.url}.extraHeader`, GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${value.username}:${value.token}`).toString('base64')}` };
  } catch { throw new SyncError('credentials'); }
}
function runGit(path: string, args: string[], signal: AbortSignal, network: NodeJS.ProcessEnv = {}, input?: string, local = false): Promise<{ code: number | null; data: string }> {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...gitOptions, '-c', 'protocol.https.allow=always', ...(local ? ['-c', 'protocol.file.allow=always'] : []), '--git-dir', path, ...args], { cwd: '/', env: { ...environment, GIT_ALLOW_PROTOCOL: local ? 'https:file' : 'https', ...network }, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
    let failure: SyncError | undefined, size = 0, diagnostics = 0; const chunks: Buffer[] = [];
    const stop = (error: SyncError) => { failure ??= error; try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { child.kill('SIGKILL'); } };
    const cancel = () => stop(new SyncError('cancelled')); signal.addEventListener('abort', cancel, { once: true });
    child.stdout!.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 4_000_000) stop(new SyncError('limit')); else if (!failure) chunks.push(chunk); });
    // Git diagnostics may contain credentials, private paths, or malicious remote text.
    child.stderr!.on('data', (chunk: Buffer) => { diagnostics += chunk.length; if (diagnostics > 256_000) stop(new SyncError('limit')); });
    child.once('error', () => { failure ??= new SyncError('transport'); });
    child.once('close', code => { signal.removeEventListener('abort', cancel); if (failure) reject(failure); else resolve({ code, data: Buffer.concat(chunks).toString('utf8') }); });
    if (input !== undefined) { child.stdin!.on('error', () => undefined); child.stdin!.end(input); }
    if (signal.aborted) cancel();
  });
}
function readRefs(data: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  let count = 0;
  for (const line of data.split('\n').filter(Boolean)) {
    const match = /^([a-f0-9]{40}|[a-f0-9]{64})\s+(refs\/(?:heads|tags)\/[^\s]+)$/.exec(line);
    if (!match || !validRef(match[2]!) || Object.hasOwn(result, match[2]!) || ++count > 10_000) throw new SyncError('limit');
    result[match[2]!] = match[1]!;
  }
  return result;
}
function validRef(ref: string): boolean { return /^refs\/(heads|tags)\/.+/.test(ref) && ref.length <= 1024 && !/[\x00-\x20\x7f~^:?*\[\\]/.test(ref) && !ref.includes('..') && !ref.includes('@{') && !ref.includes('//') && !ref.endsWith('.') && !ref.endsWith('/') && ref.split('/').every(part => !part.startsWith('.') && !part.endsWith('.lock')); }
const changedRefs = (before: Record<string, string>, after: Record<string, string>) => [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(ref => before[ref] !== after[ref]).length;
export class GitRepositorySyncTransport implements RepositorySyncTransport {
  constructor(private readonly allowLocalRemotesForTests = false) {}
  async sync(binding: Readonly<RepositorySyncBinding>, target: Readonly<RepositorySyncPlan>, context: { signal: AbortSignal; previousRefs: Readonly<Record<string, string>> }): Promise<RepositorySyncResult> {
    const { signal } = context;
    return withRepositorySyncLock(binding.path, signal, async () => {
      if ((await createGitObserver({ [binding.repositoryId]: binding.path }).info(binding.repositoryId, signal)).state !== 'ready') throw new SyncError('unavailable');
      const metadata = await stat(binding.path), config = hash(await readBounded(join(binding.path, 'config'), 64_000));
      const env = await credentialEnvironment(target);
      const run = (args: string[], input?: string) => runGit(binding.path, args, signal, env, input, this.allowLocalRemotesForTests);
      const requireGit = async (args: string[], input?: string) => { const result = await run(args, input); if (result.code !== 0) throw new SyncError('transport'); return result.data; };
      const refs = async () => readRefs(await requireGit(['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads/', 'refs/tags/']));
      const before = await refs();
      if (target.direction === 'fetch') {
        if (binding.mode !== 'observe') throw new SyncError('unavailable');
        // Keep every previously advertised object reachable, including deleted branches and tags.
        // An immutable revision must not disappear after an upstream rewrite and later garbage collection.
        const commands: string[] = [];
        for (const id of new Set(Object.values(before))) {
          const ref = `refs/phabricator/observed/${id}`;
          // Content-addressed archival names are idempotent. Do not enumerate the
          // ever-growing archive merely to preserve this bounded set of refs.
          commands.push(`update ${ref} ${id}`);
        }
        if (commands.length) await requireGit(['update-ref', '--stdin'], `start\noption no-deref\n${commands.join('\n')}\nprepare\ncommit\n`);
        await requireGit(['fetch', '--atomic', '--prune', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--no-auto-maintenance', target.url, '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*']);
        const after = await refs(); await assertIdentity(); return { changedRefs: changedRefs(before, after) };
      }
      const destination = readRefs(await requireGit(['ls-remote', '--refs', target.url, 'refs/heads/*', 'refs/tags/*']));
      const changes = [...new Set([...Object.keys(before), ...Object.keys(destination)])].filter(ref => before[ref] !== destination[ref]);
      const leases: string[] = [], specifications: string[] = [];
      for (const ref of changes) {
        const old = destination[ref], next = before[ref];
        if (old && !target.allowRewrite) {
          if (!next) { if (context.previousRefs[ref] !== old) throw new SyncError('conflict'); }
          else if (ref.startsWith('refs/tags/') || (await run(['merge-base', '--is-ancestor', old, next])).code !== 0) throw new SyncError('conflict');
        }
        leases.push(`--force-with-lease=${ref}:${old ?? ''}`);
        specifications.push(`${next ?? ''}:${ref}`);
      }
      // No --mirror: internal proof, review, and archival refs never leave this server.
      if (changes.length) {
        // Ref replication must remain one atomic transaction. Never split a
        // too-large push into partially successful batches to evade argv bounds.
        if ([...leases, ...specifications, target.url].reduce((bytes, value) => bytes + Buffer.byteLength(value) + 1, 0) > 180_000) throw new SyncError('limit');
        const projection = await createPublicGitProjection(binding.repositoryId, binding.path, { signal });
        try {
          const publicRefs = Object.fromEntries(projection.refs.map(ref => [ref.name, ref.objectId]));
          if (changedRefs(before, publicRefs) !== 0) throw new SyncError('unavailable');
          const pushed = await runGit(projection.path, ['push', '--atomic', '--porcelain', ...leases, target.url, ...specifications], signal, env, undefined, this.allowLocalRemotesForTests);
          if (pushed.code !== 0) throw new SyncError('transport');
        } finally { await projection.dispose(); }
      }
      await assertIdentity();
      return { changedRefs: changes.length, refs: before };
      async function assertIdentity() {
        const current = await lstat(binding.path);
        if (current.isSymbolicLink() || current.dev !== metadata.dev || current.ino !== metadata.ino || hash(await readBounded(join(binding.path, 'config'), 64_000)) !== config) throw new SyncError('unavailable');
      }
    });
  }
}

export class RepositorySyncService {
  private readonly bindings = new Map<string, Readonly<RepositorySyncBinding>>();
  private readonly transport: RepositorySyncTransport;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly concurrency: number;
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  constructor(private readonly db: DatabaseSync, bindings: readonly RepositorySyncBinding[], options: RepositorySyncOptions = {}) {
    this.now = options.now ?? Date.now; this.timeoutMs = options.timeoutMs ?? 180_000; this.concurrency = options.concurrency ?? 2;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 50 || this.timeoutMs > 600_000 || !Number.isSafeInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 8) throw configError();
    this.transport = options.transport ?? new GitRepositorySyncTransport(options.allowLocalRemotesForTests ?? false);
    const paths = new Set<string>();
    for (const binding of validateBindings(bindings, options.allowLocalRemotesForTests)) {
      let canonical: string;
      try { canonical = realpathSync(binding.path); } catch { canonical = resolve(binding.path); }
      if (paths.has(canonical)) throw configError(); paths.add(canonical);
      Object.freeze(binding.observe); binding.mirrors?.forEach(Object.freeze); Object.freeze(binding.mirrors); Object.freeze(binding);
      this.bindings.set(binding.repositoryId, binding);
      const configuration = fingerprint(binding);
      for (const target of plans(binding)) {
        const previous = this.row(binding.repositoryId, target.key);
        if (previous?.configuration === configuration) continue;
        const state: RepositorySyncTarget = { key: target.key, direction: target.direction, state: 'queued', lastAttemptAt: null, lastSuccessAt: null, nextAttemptAt: new Date(this.now()).toISOString(), consecutiveFailures: 0, lastError: null, attempts: 0 };
        this.db.prepare('INSERT INTO repository_sync_targets(repository_id,target_key,configuration,data,next_at,requested,refs) VALUES(?,?,?,?,?,0,?) ON CONFLICT(repository_id,target_key) DO UPDATE SET configuration=excluded.configuration,data=excluded.data,next_at=excluded.next_at,requested=0,refs=excluded.refs').run(binding.repositoryId, target.key, configuration, JSON.stringify(state), this.now(), '{}');
      }
    }
  }
  binding(repositoryId: string): Readonly<RepositorySyncBinding> | undefined { return this.bindings.get(repositoryId); }
  private row(repositoryId: string, key: string): TargetRow | undefined { return this.db.prepare('SELECT * FROM repository_sync_targets WHERE repository_id=? AND target_key=?').get(repositoryId, key) as unknown as TargetRow | undefined; }
  snapshot(repositoryId: string): RepositorySyncSnapshot {
    const binding = this.bindings.get(repositoryId);
    if (!binding) return { repositoryId, mode: 'unconfigured', configuration: null, intervalSeconds: null, targets: [], recentAttempts: [] };
    const configuration = fingerprint(binding);
    const recentAttempts = (this.db.prepare('SELECT data FROM repository_sync_attempts WHERE repository_id=? AND configuration=? ORDER BY started_at DESC,rowid DESC LIMIT 50').all(repositoryId, configuration) as unknown as AttemptRow[]).map(row => JSON.parse(row.data) as RepositorySyncAttempt);
    return { repositoryId, mode: binding.mode, configuration, intervalSeconds: binding.intervalSeconds ?? 300, targets: plans(binding).map(target => JSON.parse(this.row(repositoryId, target.key)!.data) as RepositorySyncTarget), recentAttempts };
  }
  request(repositoryId: string, input: RepositorySyncInput & { requestId: string; actorId: string }): { snapshot: RepositorySyncSnapshot; receipt: RepositorySyncReceipt } {
    const binding = this.bindings.get(repositoryId);
    if (this.closed) throw new HttpError(503, 'Repository synchronization is stopping.');
    if (!binding || plans(binding).length === 0) throw new HttpError(409, 'No synchronization targets are configured.', 'REPOSITORY_SYNC_UNCONFIGURED');
    const configuration = fingerprint(binding);
    if (input.expectedConfiguration !== configuration) throw new HttpError(409, 'Repository authority or synchronization configuration changed. Reload before retrying.', 'REPOSITORY_SYNC_CHANGED');
    if (typeof input.requestId !== 'string' || input.requestId.length < 1 || input.requestId.length > 200 || /[\x00-\x20\x7f]/.test(input.requestId) || typeof input.actorId !== 'string' || !input.actorId || input.actorId.length > 200 || !Number.isSafeInteger(input.expectedAccessEpoch) || input.expectedAccessEpoch < 0) throw new HttpError(400, 'Provide an exact synchronization request and access version.');
    const signature = hash(JSON.stringify({ repositoryId, configuration, expectedAccessEpoch: input.expectedAccessEpoch }));
    const savepoint = `repository_sync_request_${randomUUID().replaceAll('-', '')}`;
    this.db.exec(`SAVEPOINT ${savepoint}`);
    let replayed = false;
    try {
      const previous = this.db.prepare('SELECT signature FROM repository_sync_requests WHERE actor_id=? AND request_id=?').get(input.actorId, input.requestId) as RequestRow | undefined;
      if (previous && previous.signature !== signature) throw new HttpError(409, 'This request key belongs to another synchronization request.', 'REPOSITORY_SYNC_REQUEST_CONFLICT');
      replayed = Boolean(previous);
      if (!previous) {
        this.db.prepare('INSERT INTO repository_sync_requests VALUES(?,?,?)').run(input.actorId, input.requestId, signature);
        for (const target of plans(binding)) {
          const row = this.row(repositoryId, target.key)!, state = JSON.parse(row.data) as RepositorySyncTarget;
          if (state.state !== 'running') { state.state = 'queued'; state.nextAttemptAt = new Date(this.now()).toISOString(); }
          this.db.prepare('UPDATE repository_sync_targets SET data=?,next_at=?,requested=requested+1 WHERE repository_id=? AND target_key=? AND configuration=?').run(JSON.stringify(state), state.state === 'running' ? null : this.now(), repositoryId, target.key, configuration);
        }
      }
      this.db.exec(`RELEASE ${savepoint}`);
    } catch (error) { this.db.exec(`ROLLBACK TO ${savepoint}`); this.db.exec(`RELEASE ${savepoint}`); throw error; }
    return { snapshot: this.snapshot(repositoryId), receipt: { requestId: input.requestId, configuration, replayed } };
  }
  /** A successful local write makes configured outbound mirrors due immediately. */
  notifyChanged(repositoryId: string): void {
    const binding = this.bindings.get(repositoryId);
    if (this.closed || !binding) return;
    const configuration = fingerprint(binding);
    this.db.exec('SAVEPOINT repository_sync_notify');
    try {
      for (const target of plans(binding).filter(target => target.direction === 'push')) {
        const row = this.row(repositoryId, target.key);
        if (!row || row.configuration !== configuration) continue;
        const state = JSON.parse(row.data) as RepositorySyncTarget;
        if (state.state === 'queued') continue;
        if (state.state !== 'running') { state.state = 'queued'; state.nextAttemptAt = new Date(this.now()).toISOString(); }
        this.db.prepare('UPDATE repository_sync_targets SET data=?,next_at=?,requested=requested+1 WHERE repository_id=? AND target_key=? AND configuration=?').run(JSON.stringify(state), state.state === 'running' ? null : this.now(), repositoryId, target.key, configuration);
      }
      this.db.exec('RELEASE repository_sync_notify');
    } catch (error) { this.db.exec('ROLLBACK TO repository_sync_notify'); this.db.exec('RELEASE repository_sync_notify'); throw error; }
  }
  start(): void { if (this.closed || this.timer || this.bindings.size === 0) return; this.timer = setInterval(() => { void this.tick().catch(() => undefined); }, 1000); this.timer.unref(); void this.tick().catch(() => undefined); }
  async tick(): Promise<void> {
    if (this.closed) return;
    this.recover();
    for (const binding of this.bindings.values()) {
      if (this.active.size >= this.concurrency) break;
      if (this.active.has(binding.repositoryId)) continue;
      const claim = this.claim(binding);
      if (!claim) continue;
      const controller = new AbortController();
      const promise = this.execute(binding, claim.row, claim.token, claim.attempt, controller).finally(() => { this.active.delete(binding.repositoryId); });
      this.active.set(binding.repositoryId, { controller, promise });
    }
    await Promise.all([...this.active.values()].map(work => work.promise));
  }
  async close(): Promise<void> {
    this.closed = true; if (this.timer) clearInterval(this.timer);
    for (const work of this.active.values()) work.controller.abort();
    await Promise.all([...this.active.values()].map(work => work.promise));
  }
  private recover(): void {
    const expired = this.db.prepare('SELECT * FROM repository_sync_leases WHERE expires_at<=?').all(this.now()) as unknown as LeaseRow[];
    for (const lease of expired) {
      if (this.active.has(lease.repository_id)) continue;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        if (this.db.prepare('DELETE FROM repository_sync_leases WHERE repository_id=? AND token=? AND expires_at<=?').run(lease.repository_id, lease.token, this.now()).changes) {
          const attempts = this.db.prepare('SELECT data FROM repository_sync_attempts WHERE repository_id=?').all(lease.repository_id) as unknown as AttemptRow[];
          for (const item of attempts) { const attempt = JSON.parse(item.data) as RepositorySyncAttempt; if (attempt.status !== 'running') continue; attempt.status = 'interrupted'; attempt.finishedAt = new Date(this.now()).toISOString(); attempt.message = messages.cancelled; this.db.prepare('UPDATE repository_sync_attempts SET data=? WHERE id=?').run(JSON.stringify(attempt), attempt.id); }
          const rows = this.db.prepare('SELECT * FROM repository_sync_targets WHERE repository_id=?').all(lease.repository_id) as unknown as TargetRow[];
          for (const row of rows) { const state = JSON.parse(row.data) as RepositorySyncTarget; if (state.state !== 'running') continue; state.state = 'queued'; state.nextAttemptAt = new Date(this.now()).toISOString(); state.lastError = messages.cancelled; this.db.prepare('UPDATE repository_sync_targets SET data=?,next_at=? WHERE repository_id=? AND target_key=?').run(JSON.stringify(state), this.now(), row.repository_id, row.target_key); }
        }
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
  }
  private claim(binding: Readonly<RepositorySyncBinding>): { row: TargetRow; token: string; attempt: RepositorySyncAttempt } | null {
    const configuration = fingerprint(binding), now = this.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.db.prepare('SELECT 1 FROM repository_sync_leases WHERE repository_id=?').get(binding.repositoryId)) { this.db.exec('COMMIT'); return null; }
      const rows = plans(binding).map(target => this.row(binding.repositoryId, target.key)!).filter(row => row.configuration === configuration && row.next_at !== null && row.next_at <= now).sort((a, b) => a.next_at! - b.next_at! || (a.target_key === 'upstream' ? -1 : 1));
      const row = rows[0];
      if (!row) { this.db.exec('COMMIT'); return null; }
      const state = JSON.parse(row.data) as RepositorySyncTarget, token = randomUUID();
      const attempt: RepositorySyncAttempt = { id: `SYNC-${randomUUID()}`, targetKey: row.target_key, direction: state.direction, startedAt: new Date(now).toISOString(), finishedAt: null, status: 'running', message: null, changedRefs: null };
      state.state = 'running'; state.lastAttemptAt = attempt.startedAt; state.nextAttemptAt = null; state.attempts++;
      this.db.prepare('INSERT INTO repository_sync_leases VALUES(?,?,?)').run(binding.repositoryId, token, now + this.timeoutMs + 30_000);
      this.db.prepare('INSERT INTO repository_sync_attempts VALUES(?,?,?,?,?,?)').run(attempt.id, binding.repositoryId, configuration, row.target_key, now, JSON.stringify(attempt));
      this.db.prepare('UPDATE repository_sync_targets SET data=?,next_at=NULL WHERE repository_id=? AND target_key=?').run(JSON.stringify(state), binding.repositoryId, row.target_key);
      this.db.exec('COMMIT'); return { row: { ...row, data: JSON.stringify(state) }, token, attempt };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private async execute(binding: Readonly<RepositorySyncBinding>, row: TargetRow, token: string, attempt: RepositorySyncAttempt, controller: AbortController): Promise<void> {
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs); timeout.unref();
    let result: RepositorySyncResult | undefined, failure: SyncError | undefined;
    try {
      result = await this.transport.sync(binding, plans(binding).find(target => target.key === row.target_key)!, { signal: controller.signal, previousRefs: JSON.parse(row.refs) as Record<string, string> });
      if (controller.signal.aborted) throw new SyncError(timedOut ? 'limit' : 'cancelled');
      if (!Number.isSafeInteger(result.changedRefs) || result.changedRefs < 0 || (result.refs && (Object.keys(result.refs).length > 10_000 || Object.entries(result.refs).some(([ref, id]) => !validRef(ref) || !oidPattern.test(id))))) throw new SyncError('limit');
    } catch (error) { failure = timedOut ? new SyncError('limit') : controller.signal.aborted ? new SyncError('cancelled') : error instanceof SyncError ? error : new SyncError('transport'); }
    finally { clearTimeout(timeout); }
    const now = this.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const lease = this.db.prepare('SELECT * FROM repository_sync_leases WHERE repository_id=?').get(binding.repositoryId) as unknown as LeaseRow | undefined;
      if (lease?.token !== token) { this.db.exec('COMMIT'); return; }
      const current = this.row(binding.repositoryId, row.target_key)!;
      attempt.finishedAt = new Date(now).toISOString(); attempt.status = failure ? failure.kind === 'cancelled' ? 'interrupted' : 'failed' : 'succeeded'; attempt.message = failure?.message ?? null; attempt.changedRefs = failure ? null : result!.changedRefs;
      this.db.prepare('UPDATE repository_sync_attempts SET data=? WHERE id=?').run(JSON.stringify(attempt), attempt.id);
      if (current.configuration === row.configuration) {
        const state = JSON.parse(current.data) as RepositorySyncTarget, queued = current.requested !== row.requested;
        state.consecutiveFailures = failure ? state.consecutiveFailures + 1 : 0; state.lastError = failure?.message ?? null;
        if (!failure) state.lastSuccessAt = attempt.finishedAt;
        const delay = failure ? Math.min(3600_000, 30_000 * 2 ** Math.min(state.consecutiveFailures - 1, 7)) : (binding.intervalSeconds ?? 300) * 1000;
        const paused = failure?.kind === 'conflict';
        const next = queued || failure?.kind === 'cancelled' ? now : paused ? null : now + delay;
        state.state = queued || failure?.kind === 'cancelled' ? 'queued' : paused ? 'failed' : failure ? 'retrying' : 'idle';
        state.nextAttemptAt = next === null ? null : new Date(next).toISOString();
        this.db.prepare('UPDATE repository_sync_targets SET data=?,next_at=?,refs=? WHERE repository_id=? AND target_key=? AND configuration=?').run(JSON.stringify(state), next, failure || !result?.refs ? current.refs : JSON.stringify(result.refs), binding.repositoryId, row.target_key, row.configuration);
      }
      this.db.prepare('DELETE FROM repository_sync_leases WHERE repository_id=? AND token=?').run(binding.repositoryId, token);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
