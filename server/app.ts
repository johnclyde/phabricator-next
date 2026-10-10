import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { analyzeLocally } from '../shared/review.ts';
import { normalizeBasePath } from '../shared/mount.ts';
import type { ActorAttribution, AppState, ReviewAnalysis, RevisionKind, SourceFile } from '../shared/types.ts';
import type { AuthContext, AuthMode, AuthScope } from '../shared/auth.ts';
import { createAuth, type Auth } from './auth.ts';
import { aiConfiguration, analyzeWithAI } from './ai.ts';
import { createStore, type MutationResponse, type Store } from './store.ts';
import { choice, HttpError, integer, object } from './validation.ts';
import { seedDemo } from './seed.ts';

const MAX_BODY = 2_000_000;
export interface AppOptions {
  store?: Store;
  databasePath?: string;
  seed?: boolean;
  port?: number;
  distPath?: string;
  basePath?: string;
  authMode?: AuthMode;
  analyzeAI?: (kind: RevisionKind, files: SourceFile[], provider?: 'openai' | 'ollama') => Promise<ReviewAnalysis>;
  aiConfiguration?: () => AppState['ai'];
}
export interface App { server: Server; store: Store; auth: Auth; close: () => Promise<void> }

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
  const basePath = normalizeBasePath(options.basePath ?? '/');
  const store = options.store ?? createStore({ path: options.databasePath });
  let auth: Auth;
  try { auth = createAuth({ database: store.database, mode: options.authMode ?? 'local', basePath }); }
  catch (error) { if (!options.store) store.close(); throw error; }
  if (options.seed !== false) seedDemo(store);
  const ai = options.aiConfiguration ?? aiConfiguration;
  const analyzeAI = options.analyzeAI ?? analyzeWithAI;
  const pending = new Map<string, { fingerprint: string; promise: Promise<MutationResponse> }>();

  async function mutate(method: string, path: string, input: unknown, rawKey: string | undefined, context: AuthContext): Promise<MutationResponse> {
    const reviewMatch = /^\/api\/revisions\/([DPL]\d+)\/reviews$/.exec(path);
    let scope: AuthScope = 'write';
    if (method === 'POST' && reviewMatch) {
      const data = object(input, ['provider', 'expectedVersion']);
      scope = choice(data.provider, 'provider', ['local', 'openai', 'ollama']) === 'openai' ? 'review:hosted' : 'review:local';
    }
    auth.revalidate(context, scope);
    const attribution: ActorAttribution = { principalId: context.principalId, displayName: context.displayName, credentialId: context.credentialId, requestId: randomUUID() };
    // Preserve legacy local retries, while every authenticated principal has a
    // separate durable replay namespace. Authorization always precedes replay.
    const key = rawKey && (context.kind === 'local' ? rawKey : `${context.workspaceId}:${context.principalId}:${rawKey}`);
    const fingerprint = createHash('sha256').update(JSON.stringify([method, path, input])).digest('hex');
    if (key) {
      const replay = store.replay(key, fingerprint);
      if (replay) return replay;
      const active = pending.get(key);
      if (active) {
        if (active.fingerprint !== fingerprint) throw new HttpError(409, 'This idempotency key is being used for a different request.');
        const response = await active.promise;
        auth.revalidate(context, scope);
        return response;
      }
    }
    const execute = async (): Promise<MutationResponse> => {
      if (method === 'POST' && reviewMatch) {
        const data = object(input, ['provider', 'expectedVersion']);
        const provider = choice(data.provider, 'provider', ['local', 'openai', 'ollama']);
        const expectedVersion = integer(data.expectedVersion, 'expectedVersion');
        const detail = store.requireVersion(reviewMatch[1]!, expectedVersion);
        const version = detail.versions.find(item => item.number === expectedVersion)!;
        if (provider === 'openai' && !ai().configured) throw new HttpError(400, 'Hosted AI review is not configured by the server operator.');
        if (provider === 'ollama' && !ai().localConfigured) throw new HttpError(400, 'Offline AI review is not configured by the server operator.');
        let analysis: ReviewAnalysis;
        try { analysis = provider === 'local' ? analyzeLocally(detail.revision.kind, version.files) : await analyzeAI(detail.revision.kind, version.files, provider); }
        catch (error) {
          if (error instanceof HttpError) throw error;
          console.error('Review provider failed:', error instanceof Error ? error.message : 'unknown provider error');
          throw new HttpError(502, 'The review provider failed. No review evidence was saved.');
        }
        auth.revalidate(context, scope);
        return store.mutate(key, fingerprint, () => ({ status: 201, body: store.saveReview(reviewMatch[1]!, expectedVersion, analysis, attribution) }), () => auth.revalidate(context, scope));
      }
      return store.mutate(key, fingerprint, () => {
        if (method === 'POST' && path === '/api/projects') return { status: 201, body: store.createProject(input, attribution) };
        if (method === 'POST' && path === '/api/repositories') return { status: 201, body: store.createRepository(input, attribution) };
        if (method === 'POST' && path === '/api/tasks') return { status: 201, body: store.createTask(input, attribution) };
        if (method === 'POST' && path === '/api/documents') return { status: 201, body: store.createDocument(input, attribution) };
        if (method === 'POST' && path === '/api/revisions') return { status: 201, body: store.createRevision(input, attribution) };
        const task = /^\/api\/tasks\/(T\d+)$/.exec(path);
        if (method === 'PATCH' && task) return { status: 200, body: store.updateTask(task[1]!, input, attribution) };
        const document = /^\/api\/documents\/(W\d+)$/.exec(path);
        if (method === 'PUT' && document) return { status: 200, body: store.updateDocument(document[1]!, input, attribution) };
        const restore = /^\/api\/documents\/(W\d+)\/restore$/.exec(path);
        if (method === 'POST' && restore) return { status: 200, body: store.restoreDocument(restore[1]!, input, attribution) };
        const revision = /^\/api\/revisions\/([DPL]\d+)(?:\/(versions|comments))?$/.exec(path);
        if (revision && method === 'PATCH' && !revision[2]) return { status: 200, body: store.updateRevision(revision[1]!, input, attribution) };
        if (revision && method === 'POST' && revision[2] === 'versions') return { status: 201, body: store.createVersion(revision[1]!, input, attribution) };
        if (revision && method === 'POST' && revision[2] === 'comments') return { status: 201, body: store.createComment(revision[1]!, input, attribution) };
        throw new HttpError(404, 'Route not found.');
      }, () => auth.revalidate(context, scope));
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
        if (path === '/api/state') { send(res, 200, store.state(ai(), auth.mode === 'local' ? 'local-single-user' : 'authenticated-workspace')); return; }
        const document = /^\/api\/documents\/(W\d+)(?:\/(history)|\/versions\/([^/]+))?$/.exec(path);
        if (document) {
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
          send(res, 200, document[3] ? store.documentVersion(document[1]!, positiveParameter(document[3], 'version')) : store.documentDetail(document[1]!)); return;
        }
        const match = /^\/api\/revisions\/([DPL]\d+)(\/export)?$/.exec(path);
        if (match) {
          const detail = store.detail(match[1]!);
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
      }
      if (!['POST', 'PATCH', 'PUT'].includes(req.method ?? '')) throw new HttpError(404, 'Route not found.');
      const key = req.headers['idempotency-key'];
      if (key !== undefined && (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(key))) throw new HttpError(400, 'Idempotency-Key must contain 1–200 letters, numbers, dots, underscores, colons, or hyphens.');
      if (url.search) throw new HttpError(400, 'Mutation URLs may not contain query parameters.');
      const result = await mutate(req.method!, path, await body(req), key, context);
      send(res, result.status, result.body);
    })().catch((error: unknown) => {
      if (res.headersSent) { res.destroy(); return; }
      if (error instanceof HttpError) send(res, error.status, { error: error.message });
      else { console.error('Request failed:', error instanceof Error ? error.message : 'unknown error'); send(res, 500, { error: 'An internal error occurred.' }); }
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return { server, store, auth, close: async () => {
    if (server.listening) await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    if (!options.store) store.close();
  } };
}
