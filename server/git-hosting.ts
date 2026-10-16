import { spoolGitRequest } from './git-hosting-body.ts';
import { createPublicGitProjection } from './git-public-projection.ts';
import { validateGitReceiveInput } from './git-receive-input.ts';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { AuthContext } from '../shared/auth.ts';
import type { GitReceiveFacts } from '../shared/git-automation.ts';
import type { Auth } from './auth.ts';
import type { Automation } from './automation.ts';
import { createGitObserver } from './git.ts';
import { inspectReceive } from './git-receive-inspection.ts';
import type { PolicyStore } from './policy.ts';
import type { Store } from './store.ts';
import { withRepositorySyncLock, type RepositorySyncBinding } from './repository-sync.ts';
import { HttpError } from './validation.ts';

export const HOSTED_GIT_LIMITS = { requestBytes: 128 * 1024 * 1024, responseBytes: 512 * 1024 * 1024, timeoutMs: 120_000, concurrent: 4 } as const;
const unavailable = () => new HttpError(503, 'Git hosting is unavailable. Check repository operations and retry.', 'GIT_HOSTING_UNAVAILABLE');
const environment: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', HOME: '/nonexistent', LC_ALL: 'C', TZ: 'UTC',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0',
  GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', GIT_ATTR_NOSYSTEM: '1',
};
const gitOptions = ['--no-replace-objects', '--literal-pathspecs', '--no-pager', '-c', 'credential.helper=', '-c', 'protocol.allow=never', '-c', 'core.fsmonitor=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'receive.fsckObjects=true', '-c', 'receive.shallowUpdate=false', '-c', 'receive.updateServerInfo=false', '-c', 'receive.advertisePushOptions=false', '-c', 'uploadpack.allowAnySHA1InWant=false', '-c', 'uploadpack.allowReachableSHA1InWant=false', '-c', 'uploadpack.allowTipSHA1InWant=false', '-c', 'uploadpack.allowRefInWant=false', '-c', 'uploadpack.allowFilter=false', '-c', 'transfer.hideRefs=refs/', '-c', 'transfer.hideRefs=!refs/heads/', '-c', 'transfer.hideRefs=!refs/tags/'];
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const now = () => new Date().toISOString();
interface ReceiveRow { id: string; repository_id: string; configuration: string; actor: string; state: string; input: string; accepted: string | null; facts: string | null }
export function initializeHostedGit(db: DatabaseSync): void {
  db.exec(`CREATE TABLE hosted_git_receives(id TEXT PRIMARY KEY,repository_id TEXT NOT NULL REFERENCES entities(id),configuration TEXT NOT NULL,actor TEXT NOT NULL CHECK(json_valid(actor)),state TEXT NOT NULL CHECK(state IN ('prepared','accepted','complete','rejected','pending')),input TEXT NOT NULL,accepted TEXT,facts TEXT CHECK(facts IS NULL OR json_valid(facts)),created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE INDEX hosted_git_receives_pending ON hosted_git_receives(repository_id,state);`);
}

/** Native smart HTTP transport. It never uses repository-provided hook programs.
 * Authentication and receive facts are supplied by this process, not Git clients. */
export class GitHostingService {
  private readonly active = new Set<AbortController>();
  private readonly work = new Set<Promise<void>>();
  private closing = false;
  constructor(private readonly store: Store, private readonly auth: Auth, private readonly policies: PolicyStore, private readonly automation: Automation, private readonly binding: (id: string) => Readonly<RepositorySyncBinding> | undefined, private readonly configuration: (id: string) => string, private readonly changed: (id: string) => void) {}
  pending(repositoryId: string): number { return (this.store.database.prepare("SELECT count(*) AS n FROM hosted_git_receives WHERE repository_id=? AND state IN ('prepared','accepted','pending')").get(repositoryId) as { n: number }).n; }
  private authorize(id: string, context: AuthContext, write: boolean): void {
    this.auth.revalidate(context, 'read'); if (write) this.auth.revalidate(context, 'write');
    this.policies.require(id, context.principalId, 'view'); if (write) this.policies.require(id, context.principalId, 'edit');
    this.store.getRepository(id);
    if (!this.binding(id) || write && this.binding(id)?.mode !== 'host') throw new HttpError(403, 'This repository is not configured for primary Git hosting.', 'GIT_NOT_HOSTED');
  }
  serve(req: IncomingMessage, res: ServerResponse, id: string, part: string, query: URLSearchParams): Promise<void> {
    const work = this.handle(req, res, id, part, query); this.work.add(work); void work.finally(() => this.work.delete(work)).catch(() => undefined); return work;
  }
  private async handle(req: IncomingMessage, res: ServerResponse, id: string, part: string, query: URLSearchParams): Promise<void> {
    const advertise = part === 'info/refs';
    const service = advertise ? query.get('service') : part;
    if (!['git-upload-pack', 'git-receive-pack'].includes(service ?? '') || (advertise ? req.method !== 'GET' || [...query.keys()].length !== 1 : req.method !== 'POST' || [...query.keys()].length !== 0)) throw new HttpError(404, 'Git service not found.');
    const write = service === 'git-receive-pack';
    let context: AuthContext;
    try { context = this.auth.authenticateGit(req, write ? 'write' : 'read'); }
    catch (error) { if (error instanceof HttpError && error.status === 401) res.setHeader('WWW-Authenticate', 'Basic realm="Phabricator Git", charset="UTF-8"'); throw error; }
    this.authorize(id, context, write);
    if (this.closing || this.active.size >= HOSTED_GIT_LIMITS.concurrent || process.platform === 'win32') throw unavailable();
    if (!advertise && req.headers['content-type'] !== `application/x-${service}-request`) throw new HttpError(415, 'Expected the Git smart HTTP request content type.');
    const declared = req.headers['content-length'];
    if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > HOSTED_GIT_LIMITS.requestBytes || advertise && Number(declared) !== 0)) throw new HttpError(413, 'Git request exceeds its supported size.');
    const protocol = req.headers['git-protocol'];
    if (protocol !== undefined && protocol !== 'version=1' && protocol !== 'version=2') throw new HttpError(400, 'Unsupported Git protocol negotiation.');
    const controller = new AbortController(), deadline = AbortSignal.any([controller.signal, AbortSignal.timeout(HOSTED_GIT_LIMITS.timeoutMs)]);
    const abort = () => controller.abort(), disconnected = () => { if (!res.writableEnded) abort(); };
    this.active.add(controller); req.once('aborted', abort); res.once('close', disconnected);
    let directory: string | undefined;
    try {
      directory = await mkdtemp(join(tmpdir(), 'phab-git-'));
      await chmod(directory, 0o700);
      const selected = this.binding(id)!;
      const repositoryPath = await realpath(selected.path), config = this.configuration(id);
      const info = await createGitObserver({ [id]: selected.path }).info(id, deadline);
      if (info.state !== 'ready') throw unavailable();
      let bytes = 0;
      const input = join(directory, 'request');
      if (!advertise) bytes = await spoolGitRequest(req, input, deadline, HOSTED_GIT_LIMITS.requestBytes);
      const workingDirectory = directory;
      const execute = async () => {
        this.authorize(id, context, write);
        if (this.configuration(id) !== config) throw unavailable();
        if (write && !advertise) await this.recover(id, repositoryPath, config, deadline);
        const projection = await createPublicGitProjection(id, repositoryPath, { parentDirectory: workingDirectory, signal: deadline });
        try {
          const commands = write && !advertise ? await validateGitReceiveInput(input, bytes, projection, deadline) : null;
          this.authorize(id, context, write);
          await this.backend(req, res, context, id, write && !advertise ? repositoryPath : projection.path, workingDirectory, input, bytes, advertise, service!, protocol, config, deadline, commands);
        } finally { await projection.dispose(); }
      };
      if (write && !advertise) await withRepositorySyncLock(repositoryPath, deadline, execute); else await execute();
    } finally {
      controller.abort(); this.active.delete(controller); req.off('aborted', abort); res.off('close', disconnected);
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
  private async backend(req: IncomingMessage, res: ServerResponse, context: AuthContext, id: string, repositoryPath: string, directory: string, input: string, bytes: number, advertise: boolean, service: string, protocol: string | string[] | undefined, config: string, signal: AbortSignal, commands: string | null): Promise<void> {
    const write = service === 'git-receive-pack', requestId = 'http-' + randomUUID();
    const socketPath = join(directory, 'hook.sock'), capability = randomBytes(32).toString('hex');
    let hookServer: Server | undefined, preStarted = false, postStarted = false;
    if (write && !advertise) {
      const hooks = join(directory, 'hooks');
      const { mkdir } = await import('node:fs/promises'); await mkdir(hooks, { mode: 0o700 });
      const runner = fileURLToPath(new URL('../bin/git-hook.mjs', import.meta.url));
      for (const phase of ['pre', 'post']) await writeFile(join(hooks, `${phase}-receive`), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(runner)} ${phase}\n`, { mode: 0o700 });
      hookServer = createServer((hookReq, hookRes) => { void (async () => {
        const supplied = Buffer.from(hookReq.headers.authorization ?? ''), expected = Buffer.from('Bearer ' + capability);
        if (hookReq.method !== 'POST' || !['/pre', '/post'].includes(hookReq.url ?? '') || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw unavailable();
        let size = 0; const chunks: Buffer[] = [];
        for await (const chunk of hookReq) { size += chunk.length; if (size > 600_000) throw unavailable(); chunks.push(Buffer.from(chunk)); }
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'alternates,quarantine,stdin') throw unavailable();
        const data = value as { stdin: string; quarantine: string | null; alternates: string | null };
        if (typeof data.stdin !== 'string' || Buffer.byteLength(data.stdin) > 512_000 || [data.quarantine, data.alternates].some(item => item !== null && (typeof item !== 'string' || item.length > 4096))) throw unavailable();
        const phase = hookReq.url === '/pre' ? 'pre' : 'post';
        if (phase === 'pre' && data.stdin !== commands) throw unavailable();
        if (phase === 'pre' ? preStarted : !preStarted || postStarted) throw unavailable();
        if (phase === 'pre') preStarted = true; else postStarted = true;
        if (phase === 'post' && (data.quarantine || data.alternates)) throw unavailable();
        const inherited = phase === 'pre' ? { GIT_OBJECT_DIRECTORY: data.quarantine ?? undefined, GIT_ALTERNATE_OBJECT_DIRECTORIES: data.alternates ?? undefined } : {};
        if (phase === 'post') this.store.database.prepare("UPDATE hosted_git_receives SET state='accepted',accepted=?,updated_at=? WHERE id=? AND state='prepared'").run(data.stdin, now(), requestId);
        const inspected = await inspectReceive(repositoryPath, data.stdin, phase, inherited, { signal });
        const facts: GitReceiveFacts = { repositoryId: id, objectFormat: inspected.objectFormat, phase, requestId, pusherId: context.principalId, inspectionComplete: true, updates: inspected.updates.map(({ commitIds, ...update }) => ({ ...update, commits: commitIds.map(commitId => { const item = inspected.commits.find(commit => commit.commit.id === commitId)!; return { commit: item.commit, files: item.files, inspectionComplete: true }; }) })) };
        if (phase === 'pre') this.store.database.prepare("INSERT INTO hosted_git_receives(id,repository_id,configuration,actor,state,input,facts,created_at,updated_at) VALUES(?,?,?,?,'prepared',?,?,?,?)").run(requestId, id, config, JSON.stringify(context), data.stdin, JSON.stringify(facts), now(), now());
        this.authorize(id, context, true);
        const receipt = this.automation.hostedReceive(facts, context);
        if (phase === 'pre' && !receipt.allowed) this.store.database.prepare("UPDATE hosted_git_receives SET state='rejected',updated_at=? WHERE id=?").run(now(), requestId);
        if (phase === 'post') { this.store.database.prepare("UPDATE hosted_git_receives SET state='complete',updated_at=? WHERE id=?").run(now(), requestId); this.changed(id); }
        if (signal.aborted) throw unavailable();
        hookRes.writeHead(200, { 'Content-Type': 'application/json' }); hookRes.end(JSON.stringify({ allowed: receipt.allowed }));
      })().catch(() => { if (!hookRes.headersSent) hookRes.writeHead(503, { 'Content-Type': 'application/json' }); hookRes.end('{"allowed":false}'); }); });
      await new Promise<void>((resolve, reject) => { hookServer!.once('error', reject); hookServer!.listen(socketPath, resolve); }); await chmod(socketPath, 0o600);
    }
    try {
      const child = spawn('git', [...gitOptions, '-c', `core.hooksPath=${write && !advertise ? join(directory, 'hooks') : '/dev/null'}`, '-c', 'http.receivepack=true', '-c', 'http.uploadpack=true', '-c', 'http.getanyfile=false', 'http-backend'], {
        cwd: '/', detached: true, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        env: { ...environment, GIT_PROJECT_ROOT: dirname(repositoryPath), PATH_INFO: '/' + basename(repositoryPath) + '/' + (advertise ? 'info/refs' : service), QUERY_STRING: advertise ? 'service=' + service : '', REQUEST_METHOD: advertise ? 'GET' : 'POST', CONTENT_TYPE: advertise ? '' : `application/x-${service}-request`, CONTENT_LENGTH: String(bytes), REMOTE_USER: context.principalId, REMOTE_ADDR: '127.0.0.1', GIT_HTTP_EXPORT_ALL: '1', ...(protocol ? { GIT_PROTOCOL: String(protocol) } : {}), PHAB_GIT_HOOK_SOCKET: socketPath, PHAB_GIT_HOOK_CAPABILITY: capability },
      });
      const stop = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } } };
      signal.addEventListener('abort', stop, { once: true });
      const recheck = setInterval(() => { try { this.authorize(id, context, write); } catch { stop(); } }, 250); recheck.unref();
      let header = Buffer.alloc(0), headersDone = false, size = 0, diagnostics = 0, failure: unknown;
      child.stderr.on('data', (chunk: Buffer) => { diagnostics += chunk.length; if (diagnostics > 64_000) { failure = unavailable(); stop(); } });
      const output = (async () => {
        for await (const raw of child.stdout) {
          let chunk = Buffer.from(raw as Uint8Array); size += chunk.length;
          if (size > HOSTED_GIT_LIMITS.responseBytes) throw unavailable();
          this.authorize(id, context, write);
          if (!headersDone) {
            header = Buffer.concat([header, chunk]); let at = header.indexOf('\r\n\r\n'), separator = 4;
            if (at < 0) { at = header.indexOf('\n\n'); separator = 2; }
            if (at < 0) { if (header.length > 16_000) throw unavailable(); continue; }
            const lines = header.subarray(0, at).toString('ascii').split(/\r?\n/);
            const status = lines.find(line => line.toLowerCase().startsWith('status:'));
            if (status && !/^Status:\s*200\b/i.test(status)) throw unavailable();
            const type = lines.find(line => line.toLowerCase().startsWith('content-type:'))?.split(':').slice(1).join(':').trim();
            if (type !== `application/x-${service}-${advertise ? 'advertisement' : 'result'}`) throw unavailable();
            res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); headersDone = true; chunk = header.subarray(at + separator); header = Buffer.alloc(0);
          }
          if (chunk.length && !res.write(chunk)) await new Promise<void>((resolve, reject) => { const cancel = () => reject(unavailable()); res.once('drain', () => { signal.removeEventListener('abort', cancel); resolve(); }); signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel(); });
        }
        if (!headersDone) throw unavailable();
      })().catch(error => { failure = error; stop(); });
      const exit = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      child.stdin.on('error', () => undefined);
      const sending = advertise ? Promise.resolve(child.stdin.end()) : pipeline(createReadStream(input), child.stdin).catch(error => { failure = error; stop(); });
      if (signal.aborted) stop();
      try { const code = await exit; await sending; await output; if (code !== 0 || signal.aborted || failure) throw failure ?? unavailable(); }
      finally { clearInterval(recheck); signal.removeEventListener('abort', stop); stop(); }
      if (write && !advertise) {
        // A post hook failure cannot undo accepted refs. Keep the durable record
        // for recovery instead of reporting the accepted Git update as rejected.
        try { await this.recover(id, repositoryPath, config, AbortSignal.timeout(60_000)); } catch { /* pending state is exposed and blocks a later receive */ }
      }
      res.end();
    } finally { if (hookServer) await new Promise<void>(resolve => { hookServer!.closeAllConnections(); hookServer!.close(() => resolve()); }); }
  }
  private async recover(id: string, path: string, configuration: string, signal: AbortSignal): Promise<void> {
    const rows = this.store.database.prepare("SELECT * FROM hosted_git_receives WHERE repository_id=? AND state IN ('prepared','accepted','pending') ORDER BY created_at").all(id) as unknown as ReceiveRow[];
    for (const row of rows) {
      if (row.configuration !== configuration) throw new HttpError(409, 'A previous receive needs recovery under its original configuration.', 'GIT_RECEIVE_PENDING');
      try {
        const actor = JSON.parse(row.actor) as AuthContext;
        let accepted = row.accepted;
        if (accepted === null) {
          const refs = await createGitObserver({ [id]: path }).refs(id, signal);
          const ids = new Map(refs.refs.map(ref => [ref.name, ref.objectId]));
          accepted = row.input.trimEnd().split('\n').filter(line => {
            const [oldId, newId, ref] = line.split(' '), actual = ids.get(ref!) ?? null;
            const old = /^0+$/.test(oldId!) ? null : oldId!, next = /^0+$/.test(newId!) ? null : newId!;
            if (actual === next) return true; if (actual === old) return false; throw unavailable();
          }).join('\n');
          if (accepted) accepted += '\n';
          this.store.database.prepare('UPDATE hosted_git_receives SET accepted=?,updated_at=? WHERE id=?').run(accepted, now(), row.id);
        }
        if (!accepted) { this.store.database.prepare("UPDATE hosted_git_receives SET state='rejected',updated_at=? WHERE id=?").run(now(), row.id); continue; }
        const inspected = await inspectReceive(path, accepted, 'post', {}, { signal });
        const facts: GitReceiveFacts = { repositoryId: id, objectFormat: inspected.objectFormat, phase: 'post', requestId: row.id, pusherId: actor.principalId, inspectionComplete: true, updates: inspected.updates.map(({ commitIds, ...update }) => ({ ...update, commits: commitIds.map(commitId => { const item = inspected.commits.find(commit => commit.commit.id === commitId)!; return { commit: item.commit, files: item.files, inspectionComplete: true }; }) })) };
        this.authorize(id, actor, true); this.automation.hostedReceive(facts, actor);
        this.store.database.prepare("UPDATE hosted_git_receives SET state='complete',updated_at=? WHERE id=?").run(now(), row.id); this.changed(id);
      } catch { this.store.database.prepare("UPDATE hosted_git_receives SET state='pending',updated_at=? WHERE id=?").run(now(), row.id); throw new HttpError(409, 'An accepted or interrupted push needs receive-history recovery before another push.', 'GIT_RECEIVE_PENDING'); }
    }
  }
  async close(): Promise<void> { this.closing = true; for (const controller of this.active) controller.abort(); await Promise.allSettled([...this.work]); }
}
