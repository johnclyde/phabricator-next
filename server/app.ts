import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { analyzeLocally } from '../shared/review.ts';
import { analyzeCitations } from '../shared/citations.ts';
import { PASTE_MAX_BYTES, type PasteListQuery } from '../shared/pastes.ts';
import { normalizeBasePath } from '../shared/mount.ts';
import type { ActorAttribution, AppState, ReviewAnalysis, RevisionKind, RevisionVersion, SourceFile } from '../shared/types.ts';
import { GIT_LIMITS, isGitObjectId, isGitPath } from '../shared/repositories.ts';
import type { AuthContext, AuthMode, AuthScope } from '../shared/auth.ts';
import type { WorkboardQuery } from '../shared/workboards.ts';
import { createAuth, type Auth } from './auth.ts';
import { aiConfiguration, analyzeWithAI } from './ai.ts';
import { createStore, gitImportInput, gitVersionImportInput, parseDocxImportInput, parseDocxReimportInput, parseDocxReplaceInput, type MutationResponse, type Store } from './store.ts';
import { exportDocxDiscussion, inspectDocx, replaceDocx } from './docx-package.ts';
import { DOCX_LIMITS, type DocxFileIdentity } from '../shared/docx.ts';
import { docxDiscussionFilename, type DocxDiscussionExport } from '../shared/docx-discussion.ts';
import type { GitImportSnapshot } from '../shared/repositories.ts';
import { choice, HttpError, integer, object } from './validation.ts';
import { seedDemo } from './seed.ts';
import { PolicyStore, registerFilePolicy } from './policy.ts';
import type { FileListQuery } from '../shared/files.ts';
import { AccessLayer } from './access.ts';
import { createGitObserver, type GitObserver } from './git.ts';
import { PaperBuildService, type PaperRunner } from './paper-builds.ts';
import { canonicalWikiPath } from '../shared/wiki.ts';
import { conduitRequest } from './conduit.ts';
import { wikiDocumentQuery } from './wiki-query.ts';
import { parseRevisionDependencyInput } from './store.ts';
import { revisionAuthorInput } from '../shared/revision-authorship.ts';
import { revisionLifecycleInput, type RevisionLifecycleConfig } from '../shared/revision-lifecycle.ts';

const MAX_BODY = 2_000_000;
export interface AppOptions {
  store?: Store;
  databasePath?: string;
  seed?: boolean;
  port?: number;
  distPath?: string;
  basePath?: string;
  authMode?: AuthMode;
  revisionLifecycle?: RevisionLifecycleConfig;
  gitRepositories?: Readonly<Record<string, string>>;
  gitObserver?: GitObserver;
  paperRunner?: PaperRunner | null;
  docxProcessor?: { inspect: typeof inspectDocx; replace: typeof replaceDocx; exportDiscussion?: typeof exportDocxDiscussion };
  analyzeAI?: (kind: RevisionKind, files: SourceFile[], provider?: 'openai' | 'ollama') => Promise<ReviewAnalysis>;
  aiConfiguration?: () => AppState['ai'];
}
export interface App { server: Server; store: Store; auth: Auth; policies: PolicyStore; paperBuilds: PaperBuildService; close: () => Promise<void> }

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

async function body(req: IncomingMessage, maximum = MAX_BODY): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new HttpError(400, 'Mutation requests require Content-Type: application/json.');
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maximum)) throw new HttpError(413, 'Request body exceeds the route limit.');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > maximum) throw new HttpError(413, 'Request body exceeds the route limit.');
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
  const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
  res.setHeader('Content-Type', mime[extname(file)] ?? 'application/octet-stream');
  res.setHeader('Cache-Control', pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  res.statusCode = 200;
  if (req.method === 'HEAD') res.end(); else res.end(html ?? await readFile(file));
}

export function createApp(options: AppOptions = {}): App {
  if (options.gitObserver && options.gitRepositories) throw new Error('Provide either gitObserver or gitRepositories, not both.');
  if (options.store && options.revisionLifecycle) throw new Error('Configure revisionLifecycle on the supplied Store, or let createApp create the Store.');
  const git = options.gitObserver ?? createGitObserver(options.gitRepositories ?? {});
  const basePath = normalizeBasePath(options.basePath ?? '/');
  const store = options.store ?? createStore({ path: options.databasePath, revisionLifecycle: options.revisionLifecycle });
  let auth: Auth;
  try { auth = createAuth({ database: store.database, mode: options.authMode ?? 'local', basePath, transferRevisionAuthors: (fromId, toId, attribution) => store.transferLocalRevisionAuthors(fromId, toId, attribution) }); }
  catch (error) { if (!options.store) store.close(); throw error; }
  if (options.seed !== false) seedDemo(store);
  const policies = new PolicyStore(store.database, { principalExists: id =>
    (auth.mode === 'local' && id === `local:${auth.workspaceId}`) || Boolean(store.database.prepare('SELECT id FROM auth_accounts WHERE id = ?').get(id)),
  });
  const ai = options.aiConfiguration ?? aiConfiguration;
  const analyzeAI = options.analyzeAI ?? analyzeWithAI;
  const paperBuilds = new PaperBuildService(store, auth, policies, options.paperRunner ?? null);
  paperBuilds.start();
  const pending = new Map<string, { fingerprint: string; promise: Promise<MutationResponse> }>();
  const gitReads = new Set<AbortController>();
  const docxWork = new Set<Promise<unknown>>();
  async function trackDocxWork<T>(promise: Promise<T>): Promise<T> {
    docxWork.add(promise);
    try { return await promise; } finally { docxWork.delete(promise); }
  }

  async function docxDiscussionRead(req: IncomingMessage, res: ServerResponse, context: AuthContext, id: string, url: URL): Promise<void> {
    const access = new AccessLayer(store, auth, policies, context);
    const authorize = () => { auth.revalidate(context, 'read'); access.require(id); };
    store.read(authorize);
    if (url.search) throw new HttpError(400, 'Word discussion exports do not accept query parameters.');
    if (closing) throw new HttpError(503, 'The application is shutting down.', 'DOCX_UNAVAILABLE');
    const controller = new AbortController(); const abort = () => controller.abort();
    const close = () => { if (!res.writableEnded) abort(); };
    gitReads.add(controller); req.once('aborted', abort); res.once('close', close);
    if (req.aborted || res.destroyed) abort();
    await trackDocxWork((async () => {
      let input: unknown;
      let selected: ReturnType<Store['docxDiscussion']> | undefined;
      const current = () => {
        authorize();
        if (!selected) return;
        const latest = store.docxDiscussion(id, input);
        if (!isDeepStrictEqual(latest.comments, selected.comments)) throw new HttpError(409, 'The selected discussions changed. Refresh them before exporting.', 'DOCX_DISCUSSION_CHANGED');
      };
      try {
        input = await body(req);
        selected = store.read(() => { authorize(); return store.docxDiscussion(id, input); });
        if (controller.signal.aborted || closing) throw new HttpError(499, 'Word discussion export was canceled.', 'DOCX_CANCELED');
        const result = await (options.docxProcessor?.exportDiscussion ?? exportDocxDiscussion)(selected.bytes, selected.comments, controller.signal);
        store.read(() => {
          current();
          if (controller.signal.aborted || closing) throw new HttpError(499, 'Word discussion export was canceled.', 'DOCX_CANCELED');
          if (!(result.bytes instanceof Uint8Array) || !result.bytes.length || result.bytes.length > DOCX_LIMITS.compressedBytes) throw new HttpError(503, 'Word discussion export is unavailable.', 'DOCX_UNAVAILABLE');
          const output: DocxDiscussionExport = {
            format: 'phabricator.docx.discussion-export.v1', revisionId: id, versionId: selected!.version.id,
            versionNumber: selected!.version.number, contentHash: selected!.version.contentHash, sourceSha256: selected!.version.docx!.sha256,
            accessEpoch: policies.epoch(), threads: selected!.input.threads, fileName: docxDiscussionFilename(id, selected!.version.number),
            bytes: result.bytes.length, sha256: createHash('sha256').update(result.bytes).digest('hex'), dataBase64: Buffer.from(result.bytes).toString('base64'),
          };
          if (!res.destroyed) { res.setHeader('X-Access-Epoch', output.accessEpoch); send(res, 200, output); }
        });
      } catch (error) {
        store.read(current);
        throw error instanceof HttpError ? error : new HttpError(503, 'Word discussion export is unavailable.', 'DOCX_UNAVAILABLE');
      } finally { gitReads.delete(controller); req.off('aborted', abort); res.off('close', close); }
    })());
  }

  async function repositoryRead(req: IncomingMessage, res: ServerResponse, context: AuthContext, id: string, section: string | undefined, commitPath: string | undefined, url: URL): Promise<void> {
    const authorize = () => {
      auth.revalidate(context, 'read');
      const access = new AccessLayer(store, auth, policies, context);
      access.require(id);
      return { repository: store.getRepository(id), access: access.describe(id) };
    };
    // Never hold a SQLite snapshot while waiting for a Git process or its queue.
    store.read(authorize);
    const comparison = section === 'compare' || section === 'compare/file' || section === 'compare/patch';
    const allowed = comparison ? ['base', 'target', ...(section === 'compare/file' ? ['beforePath', 'afterPath'] : [])]
      : section === 'tree' || section === 'blob' || section === 'blame' ? ['commit', 'path'] : section === 'history' ? ['commit', 'path', 'after', 'limit'] : [];
    for (const name of url.searchParams.keys()) if (!allowed.includes(name) || url.searchParams.getAll(name).length !== 1) throw new HttpError(400, 'Invalid repository read parameters.', 'GIT_INVALID_QUERY');
    const commit = commitPath ?? url.searchParams.get('commit');
    if (section && section !== 'refs' && !comparison && (!commit || !isGitObjectId(commit))) throw new HttpError(400, 'Select a full lowercase commit object ID.', 'GIT_INVALID_QUERY');
    const base = url.searchParams.get('base'), target = url.searchParams.get('target');
    if (comparison && (!base || (base !== 'empty' && !isGitObjectId(base)) || !target || !isGitObjectId(target) || (base !== 'empty' && base.length !== target.length))) throw new HttpError(400, 'Select exact base and target commit IDs, or an explicit empty base tree.', 'GIT_INVALID_QUERY');
    const beforePath = url.searchParams.get('beforePath'), afterPath = url.searchParams.get('afterPath');
    if (section === 'compare/file' && ((beforePath === null && afterPath === null) || (base === 'empty' && beforePath !== null) || [beforePath, afterPath].some(value => value !== null && (!value || !isGitPath(value))))) throw new HttpError(400, 'Select the exact before and after paths of one committed change.', 'GIT_INVALID_QUERY');
    const path = url.searchParams.get('path') ?? '';
    if (!isGitPath(path) || ((section === 'blob' || section === 'blame') && !path)) throw new HttpError(400, 'Select a valid Git tree path.', 'GIT_INVALID_QUERY');
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
      const result = await Promise.race([canceled, section === 'compare' ? git.compare(id, { base: base === 'empty' ? null : base!, target: target! }, signal)
        : section === 'compare/file' ? git.compareFile(id, { base: base === 'empty' ? null : base!, target: target!, beforePath, afterPath }, signal)
        : section === 'compare/patch' ? git.patch(id, { base: base === 'empty' ? null : base!, target: target! }, signal)
        : !section ? git.info(id, signal)
        : section === 'refs' ? git.refs(id, signal)
          : section === 'commits' ? git.commit(id, commit!, signal)
            : section === 'tree' ? git.tree(id, commit!, path, signal)
              : section === 'blob' ? git.blob(id, commit!, path, signal)
                : section === 'blame' ? git.blame(id, commit!, path, signal)
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
    const lifecycle = method === 'POST' ? /^\/api\/revisions\/([DPL][1-9]\d{0,14})\/lifecycle$/.exec(path) : null;
    if (lifecycle) {
      const id = lifecycle[1]!;
      const authorize = () => { auth.revalidate(context, 'write'); access.require(id, 'edit'); };
      store.read(authorize);
      if (!rawKey) throw new HttpError(400, 'Lifecycle actions require an Idempotency-Key.');
      let data;
      try { data = revisionLifecycleInput(input); } catch { throw new HttpError(400, 'Provide an exact lifecycle action, message and current lifecycle, author, source, access, configuration and evidence pins.'); }
      const key = context.kind === 'local' ? rawKey : `${context.workspaceId}:${context.principalId}:${rawKey}`;
      const fingerprint = createHash('sha256').update(JSON.stringify([method, path, data])).digest('hex');
      const actor: ActorAttribution = { principalId: context.principalId, displayName: context.displayName, credentialId: context.credentialId, requestId: randomUUID() };
      return store.mutate(key, fingerprint, () => ({ status: 200, body: store.revisionLifecycle.mutate(id, data, actor) }), authorize, response => access.presentRevisionLifecycle(id, data, response));
    }
    if (method === 'PATCH' && /^\/api\/revisions\/[DPL][1-9]\d{0,14}$/.test(path)) {
      store.read(() => { auth.revalidate(context, 'write'); access.authorize(method, path, input); });
      // Old saved status JSON has no immutable action record. Preserve its bytes,
      // but never treat it as proof of an action or borrow a current result.
      const key = rawKey && (context.kind === 'local' ? rawKey : `${context.workspaceId}:${context.principalId}:${rawKey}`);
      if (key && store.database.prepare('SELECT 1 FROM idempotency WHERE key=?').get(key)) throw new HttpError(409, 'This historical status receipt cannot prove a lifecycle action. Reload the revision; its saved record has been preserved.', 'REVISION_LIFECYCLE_LEGACY_RECEIPT');
      throw new HttpError(409, 'Choose an explicit revision lifecycle action with current source and lifecycle pins.', 'REVISION_LIFECYCLE_ACTION_REQUIRED');
    }
    const authorship = method === 'POST' ? /^\/api\/revisions\/([DPL][1-9]\d{0,14})\/authorship$/.exec(path) : null;
    if (authorship) {
      auth.revalidate(context, 'write');
      if (!rawKey) throw new HttpError(400, 'Authorship changes require an Idempotency-Key.');
      let data;
      try { data = revisionAuthorInput(input); } catch { throw new HttpError(400, 'Provide an exact author action, source identity, author version and access epoch.'); }
      const id = authorship[1]!;
      const key = context.kind === 'local' ? rawKey : `${context.workspaceId}:${context.principalId}:${rawKey}`;
      const fingerprint = createHash('sha256').update(JSON.stringify([method, path, data])).digest('hex');
      const actor: ActorAttribution = { principalId: context.principalId, displayName: context.displayName, credentialId: context.credentialId, requestId: randomUUID() };
      // This dedicated replay path can acknowledge a proved self-handoff after
      // its author loses access. No other mutation bypasses current authority.
      return store.mutate(key, fingerprint, () => {
        const author = access.revisionAuthorTarget(id, data);
        if (data.expectedAccessEpoch !== policies.epoch()) throw new HttpError(409, 'Access changed. Reload authorship before saving.', 'ACCESS_EPOCH_CHANGED');
        return { status: 200, body: store.revisionAuthorship.mutate(id, data, actor, author) };
      }, () => auth.revalidate(context, 'write'), response => access.presentRevisionAuthor(id, data, response));
    }
    const reviewMatch = /^\/api\/revisions\/([DPL]\d+)\/reviews$/.exec(path);
    const importMatch = method === 'POST' ? /^\/api\/repositories\/(R\d+)\/import-revision$/.exec(path) : null;
    const versionImportMatch = method === 'POST' ? /^\/api\/revisions\/([DPL]\d+)\/import-git$/.exec(path) : null;
    const docxCreate = method === 'POST' && path === '/api/revisions/docx';
    const docxWrite = method === 'POST' ? /^\/api\/revisions\/([DPL]\d+)\/docx\/(import|replace)$/.exec(path) : null;
    if ((docxCreate || docxWrite) && closing) throw new HttpError(503, 'The application is shutting down.', 'DOCX_UNAVAILABLE');
    if ((docxCreate || docxWrite) && !rawKey) throw new HttpError(400, 'Word document mutations require an Idempotency-Key.');
    if (method === 'POST' && /^\/api\/documents\/W\d+\/(?:move|drafts|publish|delete)$/.test(path) && !rawKey) throw new HttpError(400, 'Wiki lifecycle operations require an Idempotency-Key.');
    const paper = method === 'POST' ? /^\/api\/revisions\/([DPL]\d+)\/paper-builds(?:\/([^/]+)\/(cancel|retry))?$/.exec(path) : null;
    if (paper && !rawKey) throw new HttpError(400, 'Paper build mutations require an Idempotency-Key.');
    if (/^\/api\/pastes(?:\/|$)/.test(path) && !rawKey) throw new HttpError(400, 'Paste mutations require an Idempotency-Key.');
    if (path.startsWith('/api/files') && !rawKey) throw new HttpError(400, 'File mutations require an Idempotency-Key.');
    const citationEvidence = method === 'POST' ? /^\/api\/revisions\/([DPL]\d+)\/citation-evidence(?:\/([^/]+)\/retract)?$/.exec(path) : null;
    if (citationEvidence && !rawKey) throw new HttpError(400, 'Citation evidence mutations require an Idempotency-Key.');
    const dependencies = method === 'POST' ? /^\/api\/revisions\/([DPL][1-9]\d{0,14})\/dependencies$/.exec(path) : null;
    if (dependencies && !rawKey) throw new HttpError(400, 'Dependency changes require an Idempotency-Key.');
    let versionImportRepository: string | undefined;
    let scope: AuthScope = 'write';
    if (method === 'POST' && reviewMatch) {
      const data = object(input, ['provider', 'expectedVersion']);
      scope = choice(data.provider, 'provider', ['local', 'openai', 'ollama']) === 'openai' ? 'review:hosted' : 'review:local';
    }
    const authorize = () => {
      auth.revalidate(context, scope); access.authorize(method, path, input);
      if (versionImportRepository) access.require(versionImportRepository);
      if (paper?.[2]) paperBuilds.get(paper[1]!, paper[2], context);
      if ((importMatch || versionImportMatch) && signal?.aborted) throw new HttpError(499, 'Repository import was canceled.', 'GIT_ABORTED');
      if ((docxCreate || docxWrite) && signal?.aborted) throw new HttpError(499, 'Word document processing was canceled.', 'DOCX_ABORTED');
    };
    const ownerMutation = method === 'PATCH' && /^\/api\/tasks\/T\d+$/.test(path) && input !== null && typeof input === 'object' && Object.hasOwn(input, 'ownerId');
    const projectMutation = /^\/api\/projects\/PROJ\d+(?:\/(?:membership|members|watchers|silence))?$/.test(path) || (method === 'POST' && path === '/api/projects' && input !== null && typeof input === 'object' && 'parentId' in input && typeof input.parentId === 'string');
    const present = (response: MutationResponse, replayed = true) => access.present(method, path, response, ownerMutation && !replayed, projectMutation && !replayed, input);
    store.read(authorize);
    const attribution: ActorAttribution = { principalId: context.principalId, displayName: context.displayName, credentialId: context.credentialId, requestId: randomUUID() };
    // Preserve legacy local retries, while every authenticated principal has a
    // separate durable replay namespace. Authorization always precedes replay.
    const key = rawKey && (context.kind === 'local' ? rawKey : `${context.workspaceId}:${context.principalId}:${rawKey}`);
    const fingerprint = createHash('sha256').update(JSON.stringify([method, path, dependencies ? parseRevisionDependencyInput(input) : input])).digest('hex');
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
      if (docxCreate || docxWrite) {
        const selectedFile = (identity: DocxFileIdentity) => {
          const file = store.files.get(identity.fileId);
          if (file.sha256 !== identity.sha256 || file.bytes !== identity.bytes) throw new HttpError(409, 'The selected File does not match the inspected Word package.', 'DOCX_SOURCE_CHANGED');
          if (file.status !== 'active') throw new HttpError(409, 'Archived Files cannot be imported into a Word version.');
          return store.files.readBytes(file.id);
        };
        const requireEpoch = (epoch: number) => {
          if (epoch !== policies.epoch()) throw new HttpError(409, 'Access changed since this document inspection. Reload before saving.', 'ACCESS_EPOCH_CHANGED');
        };
        if (docxWrite?.[2] === 'replace') {
          const id = docxWrite[1]!; const data = parseDocxReplaceInput(input);
          const original = store.read(() => { authorize(); const version = store.requireDocxVersion(id, data); return store.docxBytes(id, version.id); });
          let edited: Awaited<ReturnType<typeof replaceDocx>>;
          try { edited = await (options.docxProcessor?.replace ?? replaceDocx)(original, data, { author: attribution.displayName, date: new Date().toISOString() }, signal); }
          catch (error) { store.read(authorize); throw error; }
          return store.mutate(key, fingerprint, () => ({ status: 201, body: store.replaceDocxVersion(id, data, edited.bytes, edited.projection, attribution) }), authorize, present);
        }
        const data = docxCreate ? parseDocxImportInput(input) : parseDocxReimportInput(input);
        const bytes = store.read(() => {
          authorize(); requireEpoch(data.expectedAccessEpoch);
          if (docxWrite) store.requireDocxVersion(docxWrite[1]!, parseDocxReimportInput(input));
          return selectedFile(data.sourceFile);
        });
        let projection: Awaited<ReturnType<typeof inspectDocx>>;
        try { projection = await (options.docxProcessor?.inspect ?? inspectDocx)(bytes, signal); }
        catch (error) { store.read(authorize); throw error; }
        return store.mutate(key, fingerprint, () => {
          requireEpoch(data.expectedAccessEpoch); selectedFile(data.sourceFile);
          if (docxCreate) return access.configureCreated({ status: 201, body: store.createDocxRevision(parseDocxImportInput(input), bytes, projection, attribution) }, input);
          return { status: 201, body: store.createDocxVersion(docxWrite![1]!, parseDocxReimportInput(input), bytes, projection, attribution) };
        }, authorize, present);
      }
      if (paper) return store.mutate(key, fingerprint, () => ({ status: paper[3] === 'cancel' ? 200 : 201, body: paper[3] === 'cancel' ? paperBuilds.cancel(paper[1]!, paper[2]!, input, context) : paper[3] === 'retry' ? paperBuilds.retry(paper[1]!, paper[2]!, input, context) : paperBuilds.submit(paper[1]!, input, context) }), authorize, present);
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
        if (version.docx) throw new HttpError(409, 'Word package review requires a disclosed document projection. Automated Word review is not available yet.', 'DOCX_REVIEW_UNSUPPORTED');
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
        if (dependencies) {
          const change = parseRevisionDependencyInput(input);
          if (change.expectedAccessEpoch !== policies.epoch()) throw new HttpError(409, 'Access changed. Review the current revision audience before changing dependencies.', 'ACCESS_EPOCH_CHANGED');
          const receipt = store.revisionDependencies.mutate(dependencies[1]!, change, attribution);
          for (const id of [dependencies[1]!, ...change.add, ...change.remove]) store.event(id, 'dependencies_changed', 'Updated revision dependencies.', attribution);
          return { status: 200, body: receipt };
        }
        if (citationEvidence) {
          const id = citationEvidence[1]!;
          if (citationEvidence[2]) return { status: 200, body: store.citationEvidence.retract(id, citationEvidence[2], input, attribution) };
          if (!input || typeof input !== 'object' || !('expectedAccessEpoch' in input) || input.expectedAccessEpoch !== policies.epoch()) throw new HttpError(409, 'Access changed since this source inspection. Reload access before recording it.', 'ACCESS_EPOCH_CHANGED');
          return { status: 201, body: store.citationEvidence.create(id, input, attribution) };
        }
        const assetWrite = method === 'POST' && (path === '/api/revisions' || /^\/api\/revisions\/[DPL]\d+\/versions$/.test(path)) && input !== null && typeof input === 'object' && 'assets' in input;
        const attachment = method === 'POST' ? /^\/api\/files\/(F\d+)\/attachments$/.exec(path) : null;
        if (assetWrite || (attachment && input !== null && typeof input === 'object' && 'mode' in input && input.mode === 'attach')) {
          if (!input || typeof input !== 'object' || !('expectedAccessEpoch' in input) || input.expectedAccessEpoch !== policies.epoch()) throw new HttpError(409, 'Access changed since this sharing preview. Reload and review the audience before saving.', 'ACCESS_EPOCH_CHANGED');
        }
        if (method === 'POST' && path === '/api/files') {
          const file = store.files.upload(input, attribution);
          registerFilePolicy(store.database, file.id, context.principalId);
          store.database.prepare('INSERT INTO file_upload_receipts(principal_id, request_key, file_id) VALUES (?, ?, ?)').run(context.principalId, rawKey!, file.id);
          store.event(file.id, 'uploaded', `Uploaded ${file.name}.`, attribution);
          return { status: 201, body: file };
        }
        const file = /^\/api\/files\/(F\d+)$/.exec(path);
        if (method === 'PATCH' && file) return { status: 200, body: store.files.update(file[1]!, input, attribution) };
        if (attachment) {
          const binding = store.files.setAttachment(attachment[1]!, input, attribution);
          store.database.prepare("UPDATE policy_meta SET value = value + 1 WHERE name = 'epoch'").run();
          return { status: 200, body: binding };
        }
        if (method === 'POST' && ['/api/projects', '/api/repositories', '/api/tasks', '/api/documents', '/api/revisions', '/api/pastes'].includes(path)) {
          const { content } = access.creationInput(input);
          const created = path === '/api/pastes' ? store.pastes.create(content, attribution) : path === '/api/projects' ? store.createProject(content, attribution)
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
        const policy = /^\/api\/policies\/((?:PROJ|PA|R|T|W|F|[DPL])\d+)$/.exec(path);
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
        const paste = /^\/api\/pastes\/(PA[1-9]\d{0,14})(\/comments)?$/.exec(path);
        if (paste && method === 'PATCH' && !paste[2]) return { status: 200, body: store.pastes.update(paste[1]!, input, attribution) };
        if (paste && method === 'POST' && paste[2]) return { status: 201, body: store.pastes.comment(paste[1]!, input, attribution) };
        const document = /^\/api\/documents\/(W\d+)$/.exec(path);
        if (method === 'PUT' && document) return { status: 200, body: store.updateDocument(document[1]!, input, attribution) };
        const wikiLifecycle = /^\/api\/documents\/(W\d+)\/(drafts|publish|delete)$/.exec(path);
        if (method === 'POST' && wikiLifecycle) {
          const id = wikiLifecycle[1]!;
          const receipt = wikiLifecycle[2] === 'drafts' ? store.draftDocument(id, input, attribution)
            : wikiLifecycle[2] === 'publish' ? store.publishDocument(id, input, attribution) : store.deleteDocument(id, input, attribution);
          return { status: 200, body: receipt };
        }
        const wikiMove = /^\/api\/documents\/(W\d+)\/move$/.exec(path);
        if (method === 'POST' && wikiMove) {
          const receipt = store.moveDocument(wikiMove[1]!, input, attribution);
          policies.configureWikiMove(receipt.source.id, receipt.destination.id, context.principalId, receipt.destination.version === 1);
          return { status: 200, body: receipt };
        }
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
    const promise = docxCreate || docxWrite ? trackDocxWork(execute()) : execute();
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
      if ((req.method === 'GET' || req.method === 'HEAD') && path.startsWith('/w/')) {
        if (url.search) throw new HttpError(400, 'Wiki links do not accept query parameters.');
        let wikiPath: string;
        try { wikiPath = canonicalWikiPath(decodeURIComponent(path.slice(3))); } catch { throw new HttpError(400, 'Invalid wiki path.'); }
        const fragment = wikiPath === '/' ? '' : wikiPath.split('/').map(encodeURIComponent).join('/');
        res.writeHead(302, { Location: `${basePath}#wiki/${fragment}`, 'Cache-Control': 'no-store' }); res.end(); return;
      }
      if (path !== '/api' && !path.startsWith('/api/')) { await serveStatic(req, res, options.distPath ?? resolve('dist'), path, basePath); return; }
      if (path.startsWith('/api/phriction.')) {
        send(res, 200, await conduitRequest(req, path.slice(5), url, store, auth, policies, basePath)); return;
      }
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
      const docxDiscussionExport = req.method === 'POST' ? /^\/api\/revisions\/([DPL][1-9]\d{0,14})\/docx\/export-discussion$/.exec(path) : null;
      const context = auth.authenticate(req, req.method === 'GET' || docxDiscussionExport || /^\/api\/revisions\/[DPL]\d+\/reviews$/.test(path) ? 'read' : 'write');
      if (docxDiscussionExport) { await docxDiscussionRead(req, res, context, docxDiscussionExport[1]!, url); return; }
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
        const repository = /^\/api\/repositories\/(R\d+)(?:\/(refs|tree|blob|blame|history|compare(?:\/(?:file|patch))?)|\/(commits)\/([^/]+))?$/.exec(path);
        if (repository) { await repositoryRead(req, res, context, repository[1]!, repository[2] ?? repository[3], repository[4], url); return; }
        const docxInspection = /^\/api\/files\/(F[1-9]\d{0,14})\/docx$/.exec(path);
        if (docxInspection) {
          if (closing) throw new HttpError(503, 'The application is shutting down.', 'DOCX_UNAVAILABLE');
          const controller = new AbortController(); const abort = () => controller.abort();
          const close = () => { if (!res.writableEnded) abort(); };
          const access = new AccessLayer(store, auth, policies, context); const fileId = docxInspection[1]!;
          const authorize = () => { auth.revalidate(context, 'read'); access.require(fileId); };
          const original = store.read(() => {
            authorize(); if (url.search) throw new HttpError(400, 'Word inspections do not accept query parameters.');
            return { file: store.files.get(fileId), bytes: store.files.readBytes(fileId) };
          });
          gitReads.add(controller); req.once('aborted', abort); res.once('close', close);
          if (req.aborted || res.destroyed) abort();
          await trackDocxWork((async () => {
            try {
              const projection = await (options.docxProcessor?.inspect ?? inspectDocx)(original.bytes, controller.signal);
              store.read(() => {
                authorize();
                if (!res.destroyed) send(res, 200, { sourceFile: { fileId, sha256: original.file.sha256, bytes: original.file.bytes }, fileName: original.file.originalName, projection, accessEpoch: policies.epoch() });
              });
            } catch (error) { store.read(authorize); throw error; }
            finally { gitReads.delete(controller); req.off('aborted', abort); res.off('close', close); }
          })());
          return;
        }
        store.read(() => {
          auth.revalidate(context, 'read');
          const access = new AccessLayer(store, auth, policies, context);
          if (path === '/api/state') { send(res, 200, access.state(ai())); return; }
          const lifecycle = /^\/api\/revisions\/([DPL][1-9]\d{0,14})\/lifecycle(\/history)?$/.exec(path);
          if (lifecycle) {
            const id = lifecycle[1]!; access.require(id);
            const allowed = lifecycle[2] ? ['before', 'limit', 'expectedLifecycleVersion'] : [];
            for (const name of url.searchParams.keys()) if (!allowed.includes(name) || url.searchParams.getAll(name).length !== 1) throw new HttpError(400, 'Invalid revision lifecycle query.');
            const parameter = (name: string): number | undefined => {
              const raw = url.searchParams.get(name); if (raw === null) return undefined;
              if (!(name === 'expectedLifecycleVersion' ? /^(?:0|[1-9]\d*)$/ : /^[1-9]\d*$/).test(raw) || !Number.isSafeInteger(Number(raw))) throw new HttpError(400, 'Provide a valid lifecycle history cursor and limit.');
              return Number(raw);
            };
            send(res, 200, lifecycle[2] ? access.revisionLifecycleHistory(id, { before: parameter('before'), limit: parameter('limit'), expectedLifecycleVersion: parameter('expectedLifecycleVersion') }) : access.revisionLifecycle(id)); return;
          }
          const authorship = /^\/api\/revisions\/([DPL][1-9]\d{0,14})\/authorship(\/history)?$/.exec(path);
          if (authorship) {
            const id = authorship[1]!; access.require(id);
            const allowed = authorship[2] ? ['before', 'limit', 'expectedAuthorVersion'] : [];
            for (const name of url.searchParams.keys()) if (!allowed.includes(name) || url.searchParams.getAll(name).length !== 1) throw new HttpError(400, 'Invalid revision authorship query.');
            const parameter = (name: string): number | undefined => {
              const raw = url.searchParams.get(name); if (raw === null) return undefined;
              if (!(name === 'expectedAuthorVersion' ? /^(?:0|[1-9]\d*)$/ : /^[1-9]\d*$/).test(raw) || !Number.isSafeInteger(Number(raw))) throw new HttpError(400, 'Provide a valid authorship history cursor and limit.');
              return Number(raw);
            };
            send(res, 200, authorship[2] ? access.revisionAuthorHistory(id, { before: parameter('before'), limit: parameter('limit'), expectedAuthorVersion: parameter('expectedAuthorVersion') }) : access.revisionAuthorship(id)); return;
          }
          const stack = /^\/api\/revisions\/([DPL][1-9]\d{0,14})\/dependencies\/graph$/.exec(path);
          if (stack) {
            const id = stack[1]!; access.require(id);
            if ([...url.searchParams.keys()].some(name => name !== 'expectedSnapshotId' || url.searchParams.getAll(name).length !== 1)) throw new HttpError(400, 'Invalid revision stack query.');
            const pin = url.searchParams.get('expectedSnapshotId');
            if (pin !== null && !/^[a-f0-9]{64}$/.test(pin)) throw new HttpError(400, 'Select an exact revision stack snapshot.');
            send(res, 200, store.revisionStack.read(id, peer => access.canView(peer), policies.epoch(), pin ?? undefined)); return;
          }
          const dependencies = /^\/api\/revisions\/([DPL][1-9]\d{0,14})\/dependencies(\/history)?$/.exec(path);
          if (dependencies) {
            const id = dependencies[1]!; access.require(id);
            const history = Boolean(dependencies[2]);
            const allowed = history ? ['before', 'limit', 'expectedRelationshipVersion'] : ['direction', 'after', 'limit', 'expectedRelationshipVersion'];
            if ([...url.searchParams.keys()].some(name => !allowed.includes(name) || url.searchParams.getAll(name).length !== 1)) throw new HttpError(400, 'Invalid dependency page parameters.');
            const number = (name: string, zero = false): number | undefined => {
              const value = url.searchParams.get(name); if (value === null) return undefined;
              if (!(zero ? /^(?:0|[1-9]\d*)$/ : /^[1-9]\d*$/).test(value) || !Number.isSafeInteger(Number(value))) throw new HttpError(400, 'Invalid dependency page parameters.');
              return Number(value);
            };
            const query = { limit: number('limit'), expectedRelationshipVersion: number('expectedRelationshipVersion', true) };
            const page = history ? store.revisionDependencies.history(id, { ...query, before: number('before') }, peer => access.canView(peer))
              : store.revisionDependencies.page(id, { ...query, direction: choice(url.searchParams.get('direction'), 'direction', ['parents', 'children']), ...(url.searchParams.has('after') ? { after: url.searchParams.get('after')! } : {}) }, peer => access.canView(peer));
            send(res, 200, { ...page, accessEpoch: policies.epoch() }); return;
          }
          const docxDownload = /^\/api\/revisions\/([DPL][1-9]\d{0,14})\/docx\/([^/]+)\/download$/.exec(path);
          if (docxDownload) {
            const id = docxDownload[1]!; access.require(id);
            if (url.search) throw new HttpError(400, 'Word downloads require an exact version and no query parameters.');
            const version = store.detail(id).versions.find(item => item.id === docxDownload[2]);
            if (!version?.docx) throw new HttpError(404, 'Word package version was not found.', 'DOCX_VERSION_UNAVAILABLE');
            const bytes = store.docxBytes(id, version.id);
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'); res.setHeader('Content-Length', bytes.byteLength);
            res.setHeader('Content-Disposition', `attachment; filename="${id}-v${version.number}.docx"; filename*=UTF-8''${encodeURIComponent(version.docx.fileName).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`);
            res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox"); res.setHeader('Cache-Control', 'private, no-store');
            res.setHeader('X-Content-SHA256', version.docx.sha256); res.setHeader('X-Content-Version', version.number); res.setHeader('X-Revision-Version-ID', version.id); res.setHeader('X-Access-Epoch', policies.epoch());
            res.end(bytes); return;
          }
          const paste = /^\/api\/pastes(?:\/(PA[1-9]\d{0,14})(?:\/(history|versions|raw)(?:\/([^/]+))?)?)?$/.exec(path);
          if (paste) {
            const id = paste[1], section = paste[2], selected = paste[3];
            if (id) access.require(id);
            const allowed = !id ? ['query', 'authorId', 'language', 'status', 'createdAfter', 'createdBefore', 'before', 'limit']
              : section === 'raw' ? ['version'] : section && !selected ? ['before', 'limit'] : [];
            if ([...url.searchParams.keys()].some(name => !allowed.includes(name) || url.searchParams.getAll(name).length !== 1)) throw new HttpError(400, 'Invalid Paste query parameters.');
            const positive = (name: string): number | undefined => {
              const value = url.searchParams.get(name); if (value === null) return undefined;
              if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new HttpError(400, `Invalid Paste ${name}.`);
              return Number(value);
            };
            if (!id) {
              const query: PasteListQuery = { before: positive('before'), limit: positive('limit') };
              for (const name of ['query', 'authorId', 'createdAfter', 'createdBefore'] as const) if (url.searchParams.has(name)) query[name] = url.searchParams.get(name)!;
              if (url.searchParams.has('language')) query.language = url.searchParams.get('language') || null;
              if (url.searchParams.has('status')) query.status = url.searchParams.get('status') as PasteListQuery['status'];
              send(res, 200, access.pastes(query)); return;
            }
            if (!section) { send(res, 200, access.paste(id)); return; }
            if (selected && section !== 'versions') throw new HttpError(404, 'Paste route not found.');
            if (section === 'history') { send(res, 200, { ...store.pastes.history(id, positive('before'), positive('limit')), accessEpoch: policies.epoch() }); return; }
            if (section === 'versions' && !selected) { send(res, 200, { ...store.pastes.versions(id, positive('before'), positive('limit')), accessEpoch: policies.epoch() }); return; }
            const number = section === 'raw' ? positive('version') : selected && /^[1-9]\d*$/.test(selected) && Number.isSafeInteger(Number(selected)) ? Number(selected) : undefined;
            if (number === undefined) throw new HttpError(400, 'Select an exact positive Paste content version.');
            const version = store.pastes.version(id, number);
            if (section === 'raw') {
              const bytes = Buffer.from(version.content, 'utf8');
              res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.setHeader('Content-Length', bytes.byteLength);
              res.setHeader('Content-Disposition', `attachment; filename="${id}-v${number}.txt"`);
              res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox"); res.setHeader('Cache-Control', 'private, no-store');
              res.setHeader('X-Content-SHA256', version.sha256); res.setHeader('X-Content-Version', number); res.setHeader('X-Access-Epoch', policies.epoch());
              res.end(bytes); return;
            }
            send(res, 200, { version, accessEpoch: policies.epoch() }); return;
          }
          const citationInventory = /^\/api\/revisions\/([DPL]\d+)\/citations$/.exec(path);
          if (citationInventory) {
            const id = citationInventory[1]!; access.require(id);
            if (url.searchParams.getAll('version').length !== 1 || [...url.searchParams.keys()].some(name => name !== 'version')) throw new HttpError(400, 'Citation inventory requires one exact version number.');
            const rawVersion = url.searchParams.get('version')!;
            if (!/^[1-9]\d*$/.test(rawVersion) || !Number.isSafeInteger(Number(rawVersion))) throw new HttpError(400, 'Select a positive version number.');
            const row = store.database.prepare('SELECT data FROM versions WHERE revision_id = ? AND number = ?').get(id, Number(rawVersion)) as { data: string } | undefined;
            if (!row) throw new HttpError(404, 'Citation source version was not found.', 'CITATION_VERSION_UNAVAILABLE');
            const version = JSON.parse(row.data) as RevisionVersion;
            if (version.docx) throw new HttpError(409, 'Citation indexing for Word packages is not available yet.', 'DOCX_CITATIONS_UNSUPPORTED');
            send(res, 200, { revisionId: id, version: { id: version.id, number: version.number, contentHash: version.contentHash }, index: analyzeCitations(version.files), accessEpoch: policies.epoch() }); return;
          }
          const citationRecords = /^\/api\/revisions\/([DPL]\d+)\/citation-evidence(?:\/([^/]+))?$/.exec(path);
          if (citationRecords) {
            const id = citationRecords[1]!; access.require(id);
            if (citationRecords[2]) {
              if (url.search) throw new HttpError(400, 'Citation record reads do not accept query parameters.');
              send(res, 200, { record: access.citationEvidence(id, citationRecords[2]), accessEpoch: policies.epoch() }); return;
            }
            const allowed = ['versionId', 'targetId', 'before', 'limit'];
            if (url.searchParams.getAll('versionId').length !== 1 || [...url.searchParams.keys()].some(name => !allowed.includes(name) || url.searchParams.getAll(name).length !== 1)) throw new HttpError(400, 'Citation evidence requires an exact versionId and supported paging parameters.');
            const positive = (name: string) => { const value = url.searchParams.get(name); if (value !== null && (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))) throw new HttpError(400, 'Invalid citation evidence page.'); return value === null ? undefined : Number(value); };
            send(res, 200, { ...store.citationEvidence.list(id, { versionId: url.searchParams.get('versionId')!, ...(url.searchParams.has('targetId') ? { targetId: url.searchParams.get('targetId')! } : {}), before: positive('before'), limit: positive('limit') }, fileId => access.canView(fileId)), accessEpoch: policies.epoch() }); return;
          }
          const uploadReceipt = /^\/api\/files\/uploads\/([A-Za-z0-9._:-]{1,200})$/.exec(path);
          if (uploadReceipt) {
            if (url.search) throw new HttpError(400, 'Upload receipts do not accept query parameters.');
            const row = store.database.prepare('SELECT file_id FROM file_upload_receipts WHERE principal_id = ? AND request_key = ?').get(context.principalId, uploadReceipt[1]!) as { file_id: string } | undefined;
            if (!row) throw new HttpError(404, 'This upload has no committed receipt.', 'UPLOAD_RECEIPT_UNAVAILABLE');
            access.require(row.file_id); send(res, 200, store.files.get(row.file_id)); return;
          }
          const attachmentRead = /^\/api\/files\/(F\d+)\/attachments\/((?:PROJ|PA|R|T|W|[DPL])[1-9]\d{0,14})$/.exec(path);
          if (attachmentRead) {
            if (url.search) throw new HttpError(400, 'An attachment lookup does not accept query parameters.');
            const fileId = attachmentRead[1]!; const targetId = attachmentRead[2]!; access.require(fileId);
            if (!access.canView(targetId)) throw new HttpError(400, 'This attachment target is unavailable.');
            send(res, 200, { attachment: store.files.attachment(fileId, targetId), accessEpoch: policies.epoch() }); return;
          }
          const file = /^\/api\/files(?:\/(F\d+)(?:\/(data|history|attachments))?)?$/.exec(path);
          if (file) {
            const names = !file[1] ? ['before', 'limit', 'name', 'authorId', 'status'] : file[2] === 'history' || file[2] === 'attachments' ? ['before', 'limit'] : [];
            if ([...url.searchParams.keys()].some(name => !names.includes(name) || url.searchParams.getAll(name).length !== 1)) throw new HttpError(400, 'Invalid file query.');
            const number = (name: string) => { const value = url.searchParams.get(name); if (value !== null && !/^[1-9]\d*$/.test(value)) throw new HttpError(400, 'Invalid file page.'); return value === null ? undefined : Number(value); };
            if (!file[1]) {
              const query: FileListQuery = { before: number('before'), limit: number('limit') };
              for (const name of ['name', 'authorId', 'status'] as const) if (url.searchParams.has(name)) Object.assign(query, { [name]: url.searchParams.get(name) });
              send(res, 200, access.files(query)); return;
            }
            const id = file[1]; access.require(id);
            if (file[2] === 'data') {
              const metadata = store.files.get(id); const bytes = store.files.readBytes(id);
              res.setHeader('Content-Type', metadata.mediaType); res.setHeader('Content-Length', bytes.byteLength);
              res.setHeader('Content-Disposition', `attachment; filename="${id}"; filename*=UTF-8''${encodeURIComponent(metadata.originalName).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`);
              res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox"); res.setHeader('Cache-Control', 'private, no-store');
              res.setHeader('X-Content-SHA256', metadata.sha256); res.setHeader('X-Access-Epoch', policies.epoch()); res.end(bytes); return;
            }
            if (file[2] === 'history') { send(res, 200, { ...store.files.history(id, number('before'), number('limit'), objectId => access.canView(objectId)), accessEpoch: policies.epoch() }); return; }
            if (file[2] === 'attachments') { send(res, 200, { ...store.files.attachments(id, { before: number('before'), limit: number('limit') }, objectId => access.canView(objectId)), accessEpoch: policies.epoch() }); return; }
            send(res, 200, access.file(id)); return;
          }
          const paper = /^\/api\/revisions\/([DPL]\d+)\/paper-builds(?:\/([^/]+)(?:\/(synctex)|\/artifacts\/([^/]+))?)?$/.exec(path);
          if (paper) {
            const id = paper[1]!; access.require(id);
            if (!paper[2]) {
              if ([...url.searchParams.keys()].some(name => !['before','limit'].includes(name) || url.searchParams.getAll(name).length !== 1)) throw new HttpError(400, 'Invalid paper build list parameters.');
              const pageNumber = (name: string) => { const value = url.searchParams.get(name); if (value !== null && !/^[1-9]\d*$/.test(value)) throw new HttpError(400, 'Invalid paper build page.'); return value === null ? undefined : Number(value); };
              send(res, 200, paperBuilds.list(id, context, pageNumber('before'), pageNumber('limit'))); return;
            }
            if (url.search) throw new HttpError(400, 'Paper build reads do not accept query parameters.');
            if (paper[3]) { send(res, 200, paperBuilds.synctex(id, paper[2], context)); return; }
            if (paper[4]) {
              const artifact = paperBuilds.artifact(id, paper[2], paper[4], context);
              res.setHeader('Content-Type', artifact.metadata.mediaType); res.setHeader('Content-Length', artifact.metadata.bytes);
              res.setHeader('Content-Disposition', `attachment; filename="${artifact.metadata.name}"`);
              res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Access-Epoch', policies.epoch());
              res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
              res.end(artifact.data); return;
            }
            send(res, 200, { build: paperBuilds.get(id, paper[2], context), accessEpoch: policies.epoch() }); return;
          }
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
          const policy = /^\/api\/policies\/((?:PROJ|PA|R|T|W|F|[DPL])\d+)$/.exec(path);
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
          if (path === '/api/documents') { send(res, 200, access.searchWikiDocuments(wikiDocumentQuery(url.searchParams))); return; }
          if (path === '/api/wiki') {
            for (const name of url.searchParams.keys()) if (!['path', 'after', 'limit'].includes(name) || url.searchParams.getAll(name).length !== 1) throw new HttpError(400, 'Wiki browsing accepts one path, after cursor and limit.');
            const value = url.searchParams.get('path');
            if (value === null) throw new HttpError(400, 'Provide a wiki path.');
            const rawLimit = url.searchParams.get('limit');
            if (rawLimit !== null && !/^[1-9]\d*$/.test(rawLimit)) throw new HttpError(400, 'limit must be a positive integer.');
            send(res, 200, access.wikiPathResult(value, url.searchParams.get('after') ?? undefined, rawLimit === null ? undefined : integer(Number(rawLimit), 'limit'))); return;
          }
          const wikiMovePreview = /^\/api\/documents\/(W\d+)\/move-preview$/.exec(path);
          if (wikiMovePreview) {
            if ([...url.searchParams.keys()].some(name => name !== 'path') || url.searchParams.getAll('path').length !== 1) throw new HttpError(400, 'Provide one destination path.');
            send(res, 200, access.wikiMovePreview(wikiMovePreview[1]!, url.searchParams.get('path')!)); return;
          }
          const document = /^\/api\/documents\/(W\d+)(?:\/(history|transactions)|\/versions\/([^/]+))?$/.exec(path);
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
              const options = {
                ...(before === null ? {} : { before: positiveParameter(before, 'before') }),
                ...(limit === null ? {} : { limit: positiveParameter(limit, 'limit') }),
              };
              send(res, 200, document[2] === 'transactions' ? access.documentTransactions(document[1]!, options) : access.documentHistory(document[1]!, options)); return;
            }
            if (url.search) throw new HttpError(400, 'Document read URLs may not contain query parameters.');
            send(res, 200, document[3] ? access.documentVersion(document[1]!, positiveParameter(document[3], 'version')) : access.document(document[1]!)); return;
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
      const input = await body(req, req.method === 'POST' && path === '/api/files' ? 24 * 1024 * 1024 : /^\/api\/pastes(?:\/PA[1-9]\d{0,14})?$/.test(path) ? PASTE_MAX_BYTES * 6 + 65_536 : MAX_BODY);
      if (req.method === 'POST' && (/^\/api\/repositories\/R\d+\/import-revision$/.test(path) || /^\/api\/revisions\/[DPL]\d+\/import-git$/.test(path) || path === '/api/revisions/docx' || /^\/api\/revisions\/[DPL]\d+\/docx\/(?:import|replace)$/.test(path))) {
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
  return { server, store, auth, policies, paperBuilds, close: () => closing ??= (async () => {
    for (const controller of gitReads) controller.abort();
    await paperBuilds.close();
    if (server.listening) await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    await Promise.allSettled([...docxWork]);
    if (!options.store) store.close();
  })() };
}
