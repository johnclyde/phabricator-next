import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { analyzeLocally } from '../shared/review.ts';
import { normalizeBasePath } from '../shared/mount.ts';
import type { ActorAttribution, AppState, ReviewAnalysis, RevisionKind, SourceFile } from '../shared/types.ts';
import { GIT_LIMITS, isGitObjectId, isGitPath } from '../shared/repositories.ts';
import type { AuthContext, AuthMode, AuthScope } from '../shared/auth.ts';
import type { WorkboardQuery } from '../shared/workboards.ts';
import { createAuth, type Auth } from './auth.ts';
import { aiConfiguration, analyzeWithAI } from './ai.ts';
import { createStore, gitImportInput, gitVersionImportInput, type MutationResponse, type Store } from './store.ts';
import type { GitImportSnapshot } from '../shared/repositories.ts';
import { choice, HttpError, integer, object } from './validation.ts';
import { seedDemo } from './seed.ts';
import { PolicyStore } from './policy.ts';
import { AccessLayer } from './access.ts';
import { createGitObserver, type GitObserver } from './git.ts';

const MAX_BODY = 2_000_000;
export interface AppOptions {
  store?: Store;
  databasePath?: string;
  seed?: boolean;
  port?: number;
  distPath?: string;
  basePath?: string;
  authMode?: AuthMode;
  gitRepositories?: Readonly<Record<string, string>>;
  gitObserver?: GitObserver;
  analyzeAI?: (kind: RevisionKind, files: SourceFile[], provider?: 'openai' | 'ollama') => Promise<ReviewAnalysis>;
  aiConfiguration?: () => AppState['ai'];
}
export interface App { server: Server; store: Store; auth: Auth; policies: PolicyStore; close: () => Promise<void> }

function security(req: IncomingMessage, res: ServerResponse, configuredPort: number): void {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')) throw new HttpError(403, 'Only loopback clients are allowed.');
  const ports = new Set([configuredPort, req.socket.localPort ?? configuredPort, 5173]);
  const allowedHosts = [...ports].flatMap(port => [`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!req.headers.host || !allowedHosts.includes(req.headers.host)) throw new HttpError(403, 'Only loopback hosts are allowed.');
  const origin = req.headers.origin;
  if (origin !== undefined && !allowedHosts.some(host => origin === `http://${host}`)) throw new HttpError(403, 'This origin is not allowed.');
  if (req.headers['sec-fetch-site'] === 'cross-site' && !origin) throw new HttpError(403, 'Cross-site requests are not allowed.');
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Idempotency-Key, X-Session-Context, X-CSRF-Token, Authorization');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

async function body(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new HttpError(400, 'Mutation requests require Content-Type: application/json.');
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BODY)) throw new HttpError(413, 'Request body exceeds 2 MB.');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request body exceeds 2 MB.');
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new HttpError(400, 'Request body must be valid JSON.'); }
}

function send(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(value));
}

async function waitForGit<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  let remove = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    const cancel = () => reject(new HttpError(499, 'Repository read was canceled.', 'GIT_ABORTED'));
    signal.addEventListener('abort', cancel, { once: true }); remove = () => signal.removeEventListener('abort', cancel);
    if (signal.aborted) cancel();
  });
  try { return await Promise.race([aborted, work]); } finally { remove(); }
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, dist: string, path: string, basePath: string): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(404, 'Route not found.');
  let pathname: string;
  try { pathname = decodeURIComponent(path); }
  catch { throw new HttpError(400, 'Malformed URL.'); }
  if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some(part => part === '..' || part.startsWith('.'))) throw new HttpError(404, 'File not found.');
  let root: string;
  try { root = await realpath(dist); } catch { throw new HttpError(404, 'Frontend is not built. Run npm run build or use the development server.'); }
  let requested = resolve(root, `.${pathname}`);
  let file: string;
  try {
    if (!(await stat(requested)).isFile()) requested = resolve(root, 'index.html');
    file = await realpath(requested);
  } catch {
    if (extname(pathname)) throw new HttpError(404, 'File not found.');
    file = await realpath(resolve(root, 'index.html'));
  }
  const pathRelative = relative(root, file);
  if (pathRelative.startsWith('..') || isAbsolute(pathRelative)) throw new HttpError(404, 'File not found.');
  let html: Buffer | undefined;
  if (extname(file) === '.html') {
    html = await readFile(file);
    const marker = html.toString('utf8').match(/<meta\b[^>]*\bname=["']application-base["'][^>]*>/i)?.[0];
    const builtBasePath = marker?.match(/\bcontent=["']([^"']*)["']/i)?.[1];
    if ((builtBasePath !== undefined && builtBasePath !== basePath) || (builtBasePath === undefined && basePath !== '/')) {
      throw new HttpError(503, `Frontend mount does not match APP_BASE_PATH (${basePath}). Rebuild and start with the same APP_BASE_PATH.`);
    }
  }
  const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
  res.setHeader('Content-Type', mime[extname(file)] ?? 'application/octet-stream');
  res.setHeader('Cache-Control', pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  res.statusCode = 200;
  if (req.method === 'HEAD') res.end(); else res.end(html ?? await readFile(file));
}

export function createApp(options: AppOptions = {}): App {
  if (options.gitObserver && options.gitRepositories) throw new Error('Provide either gitObserver or gitRepositories, not both.');
  const git = options.gitObserver ?? createGitObserver(options.gitRepositories ?? {});
  const basePath = normalizeBasePath(options.basePath ?? '/');
  const store = options.store ?? createStore({ path: options.databasePath });
  let auth: Auth;
  try { auth = createAuth({ database: store.database, mode: options.authMode ?? 'local', basePath }); }
  catch (error) { if (!options.store) store.close(); throw error; }
  if (options.seed !== false) seedDemo(store);
  const policies = new PolicyStore(store.database, { principalExists: id =>
    (auth.mode === 'local' && id === `local:${auth.workspaceId}`) || Boolean(store.database.prepare('SELECT id FROM auth_accounts WHERE id = ?').get(id)),
  });
  const ai = options.aiConfiguration ?? aiConfiguration;
  const analyzeAI = options.analyzeAI ?? analyzeWithAI;
  const pending = new Map<string, { fingerprint: string; promise: Promise<MutationResponse> }>();
  const gitReads = new Set<AbortController>();

  async function repositoryRead(req: IncomingMessage, res: ServerResponse, context: AuthContext, id: string, section: string | undefined, commitPath: string | undefined, url: URL): Promise<void> {
    const authorize = () => {
      auth.revalidate(context, 'read');
      const access = new AccessLayer(store, auth, policies, context);
      access.require(id);
      return { repository: store.getRepository(id), access: access.describe(id) };
    };
    // Never hold a SQLite snapshot while waiting for a Git process or its queue.
    store.read(authorize);
    const allowed = section === 'tree' || section === 'blob' ? ['commit', 'path'] : section === 'history' ? ['commit', 'path', 'after', 'limit'] : [];
    for (const name of url.searchParams.keys()) if (!allowed.includes(name) || url.searchParams.getAll(name).length !== 1) throw new HttpError(400, 'Invalid repository read parameters.', 'GIT_INVALID_QUERY');
    const commit = commitPath ?? url.searchParams.get('commit');
    if (section && section !== 'refs' && (!commit || !isGitObjectId(commit))) throw new HttpError(400, 'Select a full lowercase commit object ID.', 'GIT_INVALID_QUERY');
    const path = url.searchParams.get('path') ?? '';
    if (!isGitPath(path) || (section === 'blob' && !path)) throw new HttpError(400, 'Select a valid Git tree path.', 'GIT_INVALID_QUERY');
    const bounded = (name: string, fallback: number, min: number, max: number): number => {
      const raw = url.searchParams.get(name);
      if (raw === null) return fallback;
      const value = Number(raw);
      if (!/^(?:0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) throw new HttpError(400, `Invalid history ${name}.`, 'GIT_INVALID_QUERY');
      return value;
    };
    const after = bounded('after', 0, 0, GIT_LIMITS.historyOffset);
    const limit = bounded('limit', GIT_LIMITS.historyDefault, 1, GIT_LIMITS.historyPage);
    const controller = new AbortController();
    const abort = () => controller.abort();
    const close = () => { if (!res.writableEnded) abort(); };
    gitReads.add(controller); req.once('aborted', abort); res.once('close', close);
    if (req.aborted || res.destroyed) abort();
    let removeAbort: (() => void) | undefined;
    try {
      const canceled = new Promise<never>((_resolve, reject) => {
        const fail = () => reject(new HttpError(499, 'Repository read was canceled.', 'GIT_ABORTED'));
        controller.signal.addEventListener('abort', fail, { once: true });
        removeAbort = () => controller.signal.removeEventListener('abort', fail);
        if (controller.signal.aborted) fail();
      });
      const signal = controller.signal;
      const result = await Promise.race([canceled, !section ? git.info(id, signal)
        : section === 'refs' ? git.refs(id, signal)
          : section === 'commits' ? git.commit(id, commit!, signal)
            : section === 'tree' ? git.tree(id, commit!, path, signal)
              : section === 'blob' ? git.blob(id, commit!, path, signal)
                : git.history(id, { commit: commit!, path, after, limit }, signal)]);
      store.read(() => {
        const current = authorize();
        if (!res.destroyed) send(res, 200, !section ? { ...current, observer: result, accessEpoch: policies.epoch() } : { ...result, accessEpoch: policies.epoch() });
      });
    } catch (error) {
      // A failure is also potentially sensitive: revoked readers must not learn
      // whether the repository, object, process or operator binding is available.
      store.read(() => {
        authorize();
        const safe = error instanceof HttpError ? error : new HttpError(503, 'Repository contents are unavailable.', 'GIT_UNAVAILABLE');
        if (!res.destroyed) send(res, safe.status, { error: safe.message, ...(safe.code ? { code: safe.code } : {}) });
      });
    } finally {
      removeAbort?.(); gitReads.delete(controller); req.off('aborted', abort); res.off('close', close);
    }
  }

  async function mutate(method: string, path: string, input: unknown, rawKey: string | undefined, context: AuthContext, signal?: AbortSignal): Promise<MutationResponse> {
    const access = new AccessLayer(store, auth, policies, context);
    const reviewMatch = /^\/api\/revisions\/([DPL]\d+)\/reviews$/.exec(path);
    const importMatch = method === 'POST' ? /^\/api\/repositories\/(R\d+)\/import-revision$/.exec(path) : null;
    const versionImportMatch = method === 'POST' ? /^\/api\/revisions\/([DPL]\d+)\/import-git$/.exec(path) : null;
    let versionImportRepository: string | undefined;
    let scope: AuthScope = 'write';
    if (method === 'POST' && reviewMatch) {
      const data = object(input, ['provider', 'expectedVersion']);
      scope = choice(data.provider, 'provider', ['local', 'openai', 'ollama']) === 'openai' ? 'review:hosted' : 'review:local';
    }
    const authorize = () => {
      auth.revalidate(context, scope); access.authorize(method, path, input);
      if (versionImportRepository) access.require(versionImportRepository);
      if ((importMatch || versionImportMatch) && signal?.aborted) throw new HttpError(499, 'Repository import was canceled.', 'GIT_ABORTED');
    };
    const ownerMutation = method === 'PATCH' && /^\/api\/tasks\/T\d+$/.test(path) && input !== null && typeof input === 'object' && Object.hasOwn(input, 'ownerId');
    const projectMutation = /^\/api\/projects\/PROJ\d+(?:\/(?:membership|members|watchers|silence))?$/.test(path) || (method === 'POST' && path === '/api/projects' && input !== null && typeof input === 'object' && 'parentId' in input && typeof input.parentId === 'string');
    const present = (response: MutationResponse, replayed = true) => access.present(method, path, response, ownerMutation && !replayed, projectMutation && !replayed);
    store.read(authorize);
    const attribution: ActorAttribution = { principalId: context.principalId, displayName: context.displayName, credentialId: context.credentialId, requestId: randomUUID() };
    // Preserve legacy local retries, while every authenticated principal has a
    // separate durable replay namespace. Authorization always precedes replay.
    const key = rawKey && (context.kind === 'local' ? rawKey : `${context.workspaceId}:${context.principalId}:${rawKey}`);
    const fingerprint = createHash('sha256').update(JSON.stringify([method, path, input])).digest('hex');
    if (key) {
      const replay = store.read(() => { authorize(); const saved = store.replay(key, fingerprint); return saved ? present(saved) : undefined; });
      if (replay) return replay;
      const active = pending.get(key);
      if (active) {
        if (active.fingerprint !== fingerprint) throw new HttpError(409, 'This idempotency key is being used for a different request.');
        let response: MutationResponse;
        try { response = await active.promise; } catch (error) { store.read(authorize); throw error; }
        return store.read(() => { authorize(); return present(response); });
      }
    }
    const execute = async (): Promise<MutationResponse> => {
      if (versionImportMatch) {
        const id = versionImportMatch[1]!; const data = gitVersionImportInput(input);
        const repositoryId = store.read(() => { authorize(); return store.requireGitImportVersion(id, data).revision.repositoryId!; });
        versionImportRepository = repositoryId;
        let snapshot: GitImportSnapshot;
        try { snapshot = await waitForGit(git.importSnapshot(repositoryId, data.commitId, signal), signal); }
        catch (error) {
          store.read(authorize);
          if (error instanceof HttpError) throw error;
          throw new HttpError(503, 'Repository contents are unavailable.', 'GIT_UNAVAILABLE');
        }
        return store.mutate(key, fingerprint, () => {
          if (snapshot.repositoryId !== repositoryId) throw new HttpError(422, 'The Git snapshot could not be verified for import.', 'GIT_INVALID_OBJECT');
          return { status: 201, body: store.createVersionFromGit(id, data, snapshot, attribution) };
        }, authorize, present);
      }
      if (importMatch) {
        const repositoryId = importMatch[1]!; const data = gitImportInput(input);
        let snapshot: GitImportSnapshot;
        try { snapshot = await waitForGit(git.importSnapshot(repositoryId, data.commitId, signal), signal); }
        catch (error) {
          store.read(authorize);
          if (error instanceof HttpError) throw error;
          throw new HttpError(503, 'Repository contents are unavailable.', 'GIT_UNAVAILABLE');
        }
        return store.mutate(key, fingerprint, () => {
          const sourcePolicy = policies.policy(repositoryId, context.principalId);
          if (sourcePolicy.kind === 'project') throw new HttpError(409, 'Repository policy cannot be copied.');
          const detail = store.createRevisionFromGit(repositoryId, data, snapshot, attribution);
          policies.configureNew(detail.revision.id, { spaceId: sourcePolicy.spaceId, ...sourcePolicy.rules }, context.principalId);
          return { status: 201, body: detail };
        }, authorize, present);
      }
      if (method === 'POST' && reviewMatch) {
        const data = object(input, ['provider', 'expectedVersion']);
        const provider = choice(data.provider, 'provider', ['local', 'openai', 'ollama']);
        const expectedVersion = integer(data.expectedVersion, 'expectedVersion');
        const detail = store.read(() => { authorize(); return store.requireVersion(reviewMatch[1]!, expectedVersion); });
        const version = detail.versions.find(item => item.number === expectedVersion)!;
        if (provider === 'openai' && !ai().configured) throw new HttpError(400, 'Hosted AI review is not configured by the server operator.');
        if (provider === 'ollama' && !ai().localConfigured) throw new HttpError(400, 'Offline AI review is not configured by the server operator.');
        let analysis: ReviewAnalysis;
        try { analysis = provider === 'local' ? analyzeLocally(detail.revision.kind, version.files) : await analyzeAI(detail.revision.kind, version.files, provider); }
        catch (error) {
          store.read(authorize);
          if (error instanceof HttpError) throw error;
          console.error('Review provider failed:', error instanceof Error ? error.message : 'unknown provider error');
          throw new HttpError(502, 'The review provider failed. No review evidence was saved.');
        }
        return store.mutate(key, fingerprint, () => ({ status: 201, body: store.saveReview(reviewMatch[1]!, expectedVersion, analysis, attribution) }), authorize, present);
      }
      return store.mutate(key, fingerprint, () => {
        if (method === 'POST' && ['/api/projects', '/api/repositories', '/api/tasks', '/api/documents', '/api/revisions'].includes(path)) {
          const { content } = access.creationInput(input);
          const created = path === '/api/projects' ? store.createProject(content, attribution)
            : path === '/api/repositories' ? store.createRepository(content, attribution)
              : path === '/api/tasks' ? store.createTask(content, attribution)
                : path === '/api/documents' ? store.createDocument(content, attribution) : store.createRevision(content, attribution);
          return access.configureCreated({ status: 201, body: created }, input);
        }
        if (method === 'POST' && path === '/api/spaces') {
          const space = policies.createSpace(input, context.principalId);
          store.event(space.id, 'created', `Created Space ${space.name}.`, attribution);
          return { status: 201, body: space };
        }
        const space = /^\/api\/spaces\/(S\d+)$/.exec(path);
        if (method === 'PATCH' && space) {
          const updated = policies.updateSpace(space[1]!, input, context.principalId);
          store.event(updated.id, 'updated', 'Updated Space settings and access rules.', attribution);
          return { status: 200, body: updated };
        }
        const policy = /^\/api\/policies\/((?:PROJ|R|T|W|[DPL])\d+)$/.exec(path);
        if (method === 'PUT' && policy) {
          const updated = policies.setPolicy(policy[1]!, input, context.principalId);
          store.event(updated.objectId, 'policy_updated', 'Updated access rules.', attribution);
          return { status: 200, body: updated };
        }
        const task = /^\/api\/tasks\/(T\d+)$/.exec(path);
        const workboard = /^\/api\/projects\/(PROJ\d+)\/workboard(?:\/(columns|moves|bulk-moves|import)(?:\/([^/]+)(\/reorder)?)?)?$/.exec(path);
        if (workboard) {
          const id = workboard[1]!; const section = workboard[2]; const columnId = workboard[3];
          if (method === 'PUT' && !section) return { status: 200, body: store.configureWorkboard(id, input, attribution) };
          if (method === 'POST' && section === 'moves' && !columnId) return { status: 200, body: store.moveWorkboardCard(id, input, attribution) };
          if (method === 'POST' && section === 'bulk-moves' && !columnId) return { status: 200, body: store.bulkMoveWorkboardCards(id, input, attribution) };
          if (method === 'POST' && section === 'import' && !columnId) return { status: 200, body: store.importWorkboardColumns(id, input, attribution) };
          if (section === 'columns') {
            if (method === 'POST' && !columnId) return { status: 201, body: store.createWorkboardColumn(id, input, attribution) };
            if (method === 'PATCH' && columnId && !workboard[4]) return { status: 200, body: store.updateWorkboardColumn(id, columnId, input, attribution) };
            if (method === 'POST' && columnId && workboard[4]) return { status: 200, body: store.reorderWorkboardColumn(id, columnId, input, attribution) };
          }
        }
        const project = /^\/api\/projects\/(PROJ\d+)(?:\/(members|membership|watchers|silence))?$/.exec(path);
        if (project && ((method === 'PATCH' && !project[2]) || method === 'POST')) {
          const id = project[1]!;
          if (project[2] === 'silence') return { status: 200, body: store.updateProjectSilence(id, input, attribution) };
          const detail = method === 'PATCH' ? store.updateProject(id, input, attribution)
            : project[2] === 'members' ? store.updateProjectMembers(id, input, attribution)
              : project[2] === 'membership' ? store.updateProjectMembership(id, input, attribution)
                : project[2] === 'watchers' ? store.updateProjectWatcher(id, input, attribution) : undefined;
          if (detail) {
            // Filter before paging on the initial write, then preserve these
            // historical rows unchanged when a saved request is retried.
            detail.history = store.projectHistory(id, undefined, undefined, related => access.canView(related));
            return { status: 200, body: detail };
          }
        }
        if (method === 'PATCH' && task) return { status: 200, body: store.updateTask(task[1]!, input, attribution) };
        const taskAction = /^\/api\/tasks\/(T\d+)\/(comments|dependencies|subscriptions|merge|merge-in|projects)$/.exec(path);
        if (method === 'POST' && taskAction?.[2] === 'subscriptions') return { status: 200, body: store.updateTaskSubscription(taskAction[1]!, input, attribution) };
        if (method === 'POST' && taskAction?.[2] === 'comments') return { status: 201, body: store.createTaskComment(taskAction[1]!, input, attribution) };
        if (method === 'POST' && taskAction && ['dependencies', 'merge', 'merge-in', 'projects'].includes(taskAction[2]!)) {
          const detail = taskAction[2] === 'merge' ? store.mergeTask(taskAction[1]!, input, attribution)
            : taskAction[2] === 'merge-in' ? store.mergeTasksInto(taskAction[1]!, input, attribution)
              : taskAction[2] === 'projects' ? store.updateTaskProjects(taskAction[1]!, input, attribution)
                : store.updateTaskDependencies(taskAction[1]!, input, attribution);
          // Fill the initial visible page before saving this historical response.
          // Later replays may filter it further, but must not fetch newer history.
          detail.history = store.taskHistory(taskAction[1]!, undefined, undefined, related => access.canView(related));
          return { status: 200, body: detail };
        }
        const document = /^\/api\/documents\/(W\d+)$/.exec(path);
        if (method === 'PUT' && document) return { status: 200, body: store.updateDocument(document[1]!, input, attribution) };
        const restore = /^\/api\/documents\/(W\d+)\/restore$/.exec(path);
        if (method === 'POST' && restore) return { status: 200, body: store.restoreDocument(restore[1]!, input, attribution) };
        const revision = /^\/api\/revisions\/([DPL]\d+)(?:\/(versions|comments))?$/.exec(path);
        if (revision && method === 'PATCH' && !revision[2]) return { status: 200, body: store.updateRevision(revision[1]!, input, attribution) };
        if (revision && method === 'POST' && revision[2] === 'versions') return { status: 201, body: store.createVersion(revision[1]!, input, attribution) };
        if (revision && method === 'POST' && revision[2] === 'comments') return { status: 201, body: store.createComment(revision[1]!, input, attribution) };
        const preference = /^\/api\/revisions\/([DPL]\d+)\/threads\/([^/]+)\/preference$/.exec(path);
        if (preference && method === 'PATCH') return { status: 200, body: store.setThreadPreference(preference[1]!, preference[2]!, input, context.principalId) };
        const thread = /^\/api\/revisions\/([DPL]\d+)\/threads\/([^/]+)(\/replies)?$/.exec(path);
        if (thread && method === 'POST' && thread[3]) return { status: 201, body: store.createReply(thread[1]!, thread[2]!, input, attribution) };
        if (thread && method === 'PATCH' && !thread[3]) return { status: 200, body: store.updateThread(thread[1]!, thread[2]!, input, attribution) };
        const suggestion = /^\/api\/revisions\/([DPL]\d+)\/suggestions\/([^/]+)\/apply$/.exec(path);
        if (suggestion && method === 'POST') return { status: 201, body: store.applySuggestion(suggestion[1]!, suggestion[2]!, input, attribution) };
        throw new HttpError(404, 'Route not found.');
      }, authorize, present);
    };
    const promise = execute();
    if (key) pending.set(key, { fingerprint, promise });
    try { return await promise; } finally { if (key) pending.delete(key); }
  }

  const server = createServer((req, res) => {
    void (async () => {
      security(req, res, options.port ?? 4310);
      const target = req.url ?? '/';
      if (!target.startsWith('/') || target.startsWith('//') || target.includes('\\') || target.includes('#')) throw new HttpError(400, 'Malformed URL.');
      const pathname = target.split('?')[0]!;
      let decoded: string;
      try { decoded = decodeURIComponent(pathname); } catch { throw new HttpError(400, 'Malformed URL.'); }
      // Validate the original path before URL parsing can normalize traversal.
      if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').some(part => part === '.' || part === '..')) throw new HttpError(404, 'Route not found.');
      const url = new URL(target, 'http://127.0.0.1');
      if (basePath !== '/' && pathname === basePath.slice(0, -1)) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(404, 'Route not found.');
        res.writeHead(308, { Location: `${basePath}${url.search}`, 'Cache-Control': 'no-store' }); res.end(); return;
      }
      if (!pathname.startsWith(basePath)) throw new HttpError(404, 'Route not found.');
      const path = `/${pathname.slice(basePath.length)}`;
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      if (path !== '/api' && !path.startsWith('/api/')) { await serveStatic(req, res, options.distPath ?? resolve('dist'), path, basePath); return; }
      if (req.method === 'GET' && path === '/api/health') { send(res, 200, { ok: true }); return; }
      if (req.method === 'GET' && path === '/api/session') {
        const result = auth.session(req);
        if (result.cookie) res.setHeader('Set-Cookie', result.cookie);
        send(res, 200, result.session); return;
      }
      if (req.method === 'POST' && path === '/api/login') {
        if (url.search) throw new HttpError(400, 'Mutation URLs may not contain query parameters.');
        const input = object(await body(req), ['username', 'password']);
        const result = await auth.login(req, input.username, input.password);
        res.setHeader('Set-Cookie', result.cookie);
        send(res, 200, result.session); return;
      }
      const context = auth.authenticate(req, req.method === 'GET' || /^\/api\/revisions\/[DPL]\d+\/reviews$/.test(path) ? 'read' : 'write');
      if (req.method === 'POST' && path === '/api/logout') {
        if (url.search) throw new HttpError(400, 'Mutation URLs may not contain query parameters.');
        object(await body(req), []);
        auth.revalidate(context);
        const result = auth.logout(context);
        const bootstrap = auth.session(req);
        res.setHeader('Set-Cookie', [result.cookie, ...(bootstrap.cookie ? [bootstrap.cookie] : [])]);
        send(res, 200, bootstrap.session); return;
      }
      if (req.method === 'GET') {
        const repository = /^\/api\/repositories\/(R\d+)(?:\/(refs|tree|blob|history)|\/(commits)\/([^/]+))?$/.exec(path);
        if (repository) { await repositoryRead(req, res, context, repository[1]!, repository[2] ?? repository[3], repository[4], url); return; }
        store.read(() => {
          auth.revalidate(context, 'read');
          const access = new AccessLayer(store, auth, policies, context);
          if (path === '/api/state') { send(res, 200, access.state(ai())); return; }
          const preferences = /^\/api\/revisions\/([DPL]\d+)\/discussion-preferences$/.exec(path);
          if (preferences) {
            access.require(preferences[1]!);
            if (url.search) throw new HttpError(400, 'Discussion preference reads do not accept query parameters.');
            send(res, 200, { ...store.discussionPreferences(preferences[1]!, context.principalId), accessEpoch: policies.epoch() }); return;
          }
          const bulkPreview = /^\/api\/projects\/(PROJ\d+)\/workboard\/bulk-move-preview$/.exec(path);
          if (bulkPreview) {
            const id = bulkPreview[1]!; access.require(id);
            const required = ['sourceColumnId', 'destinationProjectId', 'destinationColumnId'];
            const allowed = [...required, 'status', 'ownerId', 'showHidden'];
            if (required.some(name => url.searchParams.getAll(name).length !== 1) || [...url.searchParams.keys()].some(name => !allowed.includes(name) || url.searchParams.getAll(name).length !== 1)) throw new HttpError(400, 'Bulk preview requires one source column, destination project and destination column, with only supported board filters.');
            const status = url.searchParams.get('status'); const ownerId = url.searchParams.get('ownerId'); const showHidden = url.searchParams.get('showHidden');
            if (showHidden !== null && showHidden !== 'true' && showHidden !== 'false') throw new HttpError(400, 'showHidden must be true or false.');
            send(res, 200, access.workboardBulkMovePreview(id, {
              sourceColumnId: url.searchParams.get('sourceColumnId')!, destinationProjectId: url.searchParams.get('destinationProjectId')!, destinationColumnId: url.searchParams.get('destinationColumnId')!,
              ...(status === null ? {} : { status: choice(status, 'status', ['open', 'all'] as const) }),
              ...(ownerId === null ? {} : { ownerId: ownerId === 'null' ? null : ownerId }), ...(showHidden === null ? {} : { showHidden: showHidden === 'true' }),
            })); return;
          }
          const importPreview = /^\/api\/projects\/(PROJ\d+)\/workboard\/import-preview$/.exec(path);
          if (importPreview) {
            access.require(importPreview[1]!, 'edit');
            if (url.searchParams.getAll('sourceProjectId').length !== 1 || [...url.searchParams.keys()].some(name => name !== 'sourceProjectId')) throw new HttpError(400, 'Import preview requires exactly one sourceProjectId parameter.');
            send(res, 200, access.workboardImportPreview(importPreview[1]!, url.searchParams.get('sourceProjectId'))); return;
          }
          const workboard = /^\/api\/projects\/(PROJ\d+)\/workboard(?:\/(history)|\/columns\/([^/]+)\/cards)?$/.exec(path);
          if (workboard) {
            const id = workboard[1]!; const history = Boolean(workboard[2]); const columnId = workboard[3]; access.require(id);
            const allowed = history ? ['before', 'limit'] : ['status', 'ownerId', 'showHidden', 'limit', ...(columnId ? ['after', 'expectedBoardVersion'] : [])];
            for (const name of url.searchParams.keys()) if (!allowed.includes(name) || url.searchParams.getAll(name).length !== 1) throw new HttpError(400, 'Invalid workboard read parameters.');
            const positive = (name: string): number | undefined => {
              const value = url.searchParams.get(name); if (value === null) return undefined;
              if (!/^[1-9]\d*$/.test(value)) throw new HttpError(400, `${name} must be a positive integer.`);
              return integer(Number(value), name);
            };
            if (history) { send(res, 200, access.workboardHistory(id, positive('before'), positive('limit'))); return; }
            const status = url.searchParams.get('status'); const ownerId = url.searchParams.get('ownerId'); const showHidden = url.searchParams.get('showHidden');
            if (showHidden !== null && showHidden !== 'true' && showHidden !== 'false') throw new HttpError(400, 'showHidden must be true or false.');
            const query: WorkboardQuery = { ...(status === null ? {} : { status: choice(status, 'status', ['open', 'all'] as const) }),
              ...(ownerId === null ? {} : { ownerId: ownerId === 'null' ? null : ownerId }),
              ...(showHidden === null ? {} : { showHidden: showHidden === 'true' }), ...(positive('limit') === undefined ? {} : { limit: positive('limit') }) };
            if (columnId) {
              const expectedBoardVersion = positive('expectedBoardVersion');
              if (expectedBoardVersion === undefined) throw new HttpError(400, 'Card pages require expectedBoardVersion.');
              send(res, 200, access.workboardCards(id, columnId, { ...query, expectedBoardVersion, ...(url.searchParams.has('after') ? { after: url.searchParams.get('after')! } : {}) })); return;
            }
            send(res, 200, access.workboard(id, query)); return;
          }
          if (path === '/api/projects/resolve') {
            if (url.searchParams.getAll('slug').length !== 1 || [...url.searchParams.keys()].some(name => name !== 'slug')) throw new HttpError(400, 'Project resolution requires exactly one slug parameter.');
            send(res, 200, access.resolveProject(url.searchParams.get('slug')!)); return;
          }
          const childPreview = /^\/api\/projects\/(PROJ\d+)\/children\/preview$/.exec(path);
          if (childPreview) {
            access.require(childPreview[1]!, 'edit');
            if (url.searchParams.getAll('kind').length !== 1 || [...url.searchParams.keys()].some(name => name !== 'kind')) throw new HttpError(400, 'Child preview requires exactly one kind parameter.');
            send(res, 200, access.projectChildPreview(childPreview[1]!, choice(url.searchParams.get('kind'), 'project kind', ['project', 'milestone']))); return;
          }
          const project = /^\/api\/projects\/(PROJ\d+)(?:\/(history|members|watchers|preferences))?$/.exec(path);
          if (project) {
            const id = project[1]!; const section = project[2]; access.require(id);
            const allowed = section === 'history' ? ['before', 'limit'] : section === 'members' || section === 'watchers' ? ['after', 'limit'] : [];
            for (const name of url.searchParams.keys()) if (!allowed.includes(name) || url.searchParams.getAll(name).length !== 1) throw new HttpError(400, 'Invalid project read parameters.');
            const positive = (name: string): number | undefined => { const value = url.searchParams.get(name); if (value === null) return undefined; if (!/^[1-9]\d*$/.test(value)) throw new HttpError(400, `${name} must be a positive integer.`); return integer(Number(value), name); };
            const result = section === 'history' ? access.projectHistory(id, positive('before'), positive('limit'))
              : section === 'members' ? access.projectMembers(id, url.searchParams.get('after') ?? undefined, positive('limit'))
                : section === 'watchers' ? access.projectWatchers(id, url.searchParams.get('after') ?? undefined, positive('limit'))
                  : section === 'preferences' ? access.projectPreferences(id) : access.project(id);
            send(res, 200, result); return;
          }
          if (path === '/api/spaces') { send(res, 200, policies.spaces(context.principalId).map(space => access.space(space))); return; }
          const space = /^\/api\/spaces\/(S\d+)$/.exec(path);
          if (space) { send(res, 200, access.space(policies.getSpace(space[1]!, context.principalId))); return; }
          const policy = /^\/api\/policies\/((?:PROJ|R|T|W|[DPL])\d+)$/.exec(path);
          if (policy) { send(res, 200, access.describe(policy[1]!)); return; }
          const subscriptions = /^\/api\/tasks\/(T\d+)\/subscriptions(?:\/([^/]+))?$/.exec(path);
          if (subscriptions) {
            access.require(subscriptions[1]!);
            if (subscriptions[2]) {
              if (url.search) throw new HttpError(400, 'Subscription status URLs may not contain query parameters.');
              let principalId: string;
              try { principalId = decodeURIComponent(subscriptions[2]); } catch { throw new HttpError(400, 'Selected member is unavailable.'); }
              send(res, 200, access.taskSubscriptionStatus(subscriptions[1]!, principalId)); return;
            }
            for (const name of url.searchParams.keys()) if (!['after', 'limit'].includes(name) || url.searchParams.getAll(name).length !== 1) throw new HttpError(400, 'Subscriptions accept only one after cursor and one limit.');
            const limit = url.searchParams.get('limit');
            if (limit !== null && !/^[1-9]\d*$/.test(limit)) throw new HttpError(400, 'limit must be a positive integer.');
            send(res, 200, access.taskSubscriptions(subscriptions[1]!, url.searchParams.get('after') ?? undefined, limit === null ? undefined : integer(Number(limit), 'limit'))); return;
          }
          const task = /^\/api\/tasks\/(T\d+)(\/history)?$/.exec(path);
          if (task) {
            access.require(task[1]!);
            if (task[2]) {
              for (const name of url.searchParams.keys()) {
                if (!['before', 'limit'].includes(name) || url.searchParams.getAll(name).length !== 1) throw new HttpError(400, 'History accepts only one before cursor and one limit.');
              }
              const parameter = (name: string): number | undefined => {
                const value = url.searchParams.get(name);
                if (value === null) return undefined;
                if (!/^[1-9]\d*$/.test(value)) throw new HttpError(400, `${name} must be a positive integer.`);
                return integer(Number(value), name);
              };
              send(res, 200, access.taskHistory(task[1]!, parameter('before'), parameter('limit'))); return;
            }
            if (url.search) throw new HttpError(400, 'Task read URLs may not contain query parameters.');
            send(res, 200, access.task(task[1]!)); return;
          }
          const document = /^\/api\/documents\/(W\d+)(?:\/(history)|\/versions\/([^/]+))?$/.exec(path);
          if (document) {
            access.require(document[1]!);
            const positiveParameter = (value: string, name: string): number => {
              if (!/^[1-9]\d*$/.test(value)) throw new HttpError(400, `${name} must be a positive integer.`);
              return integer(Number(value), name);
            };
            if (document[2]) {
              for (const name of url.searchParams.keys()) {
                if (!['before', 'limit'].includes(name) || url.searchParams.getAll(name).length !== 1) throw new HttpError(400, 'History accepts only one before cursor and one limit.');
              }
              const before = url.searchParams.get('before'); const limit = url.searchParams.get('limit');
              send(res, 200, store.documentHistory(document[1]!, {
                ...(before === null ? {} : { before: positiveParameter(before, 'before') }),
                ...(limit === null ? {} : { limit: positiveParameter(limit, 'limit') }),
              })); return;
            }
            if (url.search) throw new HttpError(400, 'Document read URLs may not contain query parameters.');
            send(res, 200, document[3] ? store.documentVersion(document[1]!, positiveParameter(document[3], 'version')) : access.document(document[1]!)); return;
          }
          const match = /^\/api\/revisions\/([DPL]\d+)(\/export)?$/.exec(path);
          if (match) {
            const detail = access.revision(match[1]!);
            if (!match[2]) { send(res, 200, detail); return; }
            const selected = url.searchParams.get('version');
            if (selected !== null && !/^[1-9]\d*$/.test(selected)) throw new HttpError(400, 'version must be a positive integer.');
            const number = selected === null ? detail.revision.currentVersion : integer(Number(selected), 'version');
            const version = detail.versions.find(item => item.number === number);
            if (!version) throw new HttpError(404, 'Version not found.');
            res.setHeader('Content-Disposition', `attachment; filename="${detail.revision.id}-v${version.number}.json"`);
            send(res, 200, { revision: detail.revision, version }); return;
          }
          throw new HttpError(404, 'Route not found.');
        }); return;
      }
      if (!['POST', 'PATCH', 'PUT'].includes(req.method ?? '')) throw new HttpError(404, 'Route not found.');
      const key = req.headers['idempotency-key'];
      if (key !== undefined && (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(key))) throw new HttpError(400, 'Idempotency-Key must contain 1–200 letters, numbers, dots, underscores, colons, or hyphens.');
      if (url.search) throw new HttpError(400, 'Mutation URLs may not contain query parameters.');
      const input = await body(req);
      if (req.method === 'POST' && (/^\/api\/repositories\/R\d+\/import-revision$/.test(path) || /^\/api\/revisions\/[DPL]\d+\/import-git$/.test(path))) {
        const controller = new AbortController(); const abort = () => controller.abort();
        const close = () => { if (!res.writableEnded) abort(); };
        gitReads.add(controller); req.once('aborted', abort); res.once('close', close);
        if (req.aborted || res.destroyed) abort();
        try { const result = await mutate(req.method, path, input, key, context, controller.signal); if (!res.destroyed) send(res, result.status, result.body); }
        finally { gitReads.delete(controller); req.off('aborted', abort); res.off('close', close); }
      } else {
        const result = await mutate(req.method!, path, input, key, context);
        send(res, result.status, result.body);
      }
    })().catch((error: unknown) => {
      if (res.destroyed) return;
      if (res.headersSent) { res.destroy(); return; }
      if (error instanceof HttpError) send(res, error.status, { error: error.message, ...(error.code ? { code: error.code } : {}) });
      else { console.error('Request failed:', error instanceof Error ? error.message : 'unknown error'); send(res, 500, { error: 'An internal error occurred.' }); }
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  let closing: Promise<void> | undefined;
  return { server, store, auth, policies, close: () => closing ??= (async () => {
    for (const controller of gitReads) controller.abort();
    if (server.listening) await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    if (!options.store) store.close();
  })() };
}
