import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, lstat, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GitObjectFormat } from '../shared/repositories.ts';
import { createGitObserver } from './git.ts';
import { HttpError } from './validation.ts';

export interface PublicGitRef { name: string; objectId: string }
export interface PublicGitProjection {
  readonly path: string;
  readonly objectFormat: GitObjectFormat;
  readonly refs: readonly PublicGitRef[];
  /** Public branch selected as symbolic HEAD; null for an unborn or tag-only repository. */
  readonly head: string | null;
  dispose(): Promise<void>;
}
export interface PublicGitProjectionOptions {
  signal?: AbortSignal;
  parentDirectory?: string;
  maxPackBytes?: number;
  timeoutMs?: number;
}
const unavailable = () => new HttpError(503, 'The public Git repository snapshot is unavailable.', 'GIT_PUBLIC_PROJECTION_UNAVAILABLE');
const limit = () => new HttpError(422, 'The public Git repository snapshot exceeds its supported size or time limit.', 'GIT_PUBLIC_PROJECTION_LIMIT');
const cancelled = () => new HttpError(499, 'The Git repository snapshot was cancelled.', 'GIT_PUBLIC_PROJECTION_CANCELLED');
const environment: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', HOME: '/nonexistent', LC_ALL: 'C', TZ: 'UTC',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0',
  GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '',
  GIT_ATTR_NOSYSTEM: '1', GIT_SSH_COMMAND: '/usr/bin/false', GIT_PAGER: 'cat',
};
const gitOptions = ['--no-replace-objects', '--literal-pathspecs', '--no-pager',
  '-c', 'protocol.allow=never', '-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null', '-c', 'core.untrackedCache=false',
  '-c', 'core.commitGraph=false', '-c', 'core.multiPackIndex=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
  '-c', 'pack.allowPackReuse=false', '-c', 'pack.useBitmaps=false', '-c', 'pack.threads=1', '-c', 'pack.window=0',
  '-c', 'transfer.fsckObjects=true'];
const oid = (value: string, format: GitObjectFormat) => (format === 'sha1' ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/).test(value);
function validRef(ref: string): boolean {
  return /^refs\/(heads|tags)\/.+/.test(ref) && ref.length <= 1024 && !/[\x00-\x20\x7f~^:?*\[\\]/.test(ref) && !ref.includes('..') && !ref.includes('@{') && !ref.includes('//') && !ref.endsWith('.') && !ref.endsWith('/') && ref.split('/').every(part => !part.startsWith('.') && !part.endsWith('.lock'));
}
function check(signal: AbortSignal): void { if (signal.aborted) throw cancelled(); }
interface CommandOptions { input?: string; inputFile?: string; outputFile?: string; maximum?: number }
/** Spool packs with backpressure; diagnostics never escape to logs or HTTP. */
async function run(path: string | null, args: string[], signal: AbortSignal, options: CommandOptions = {}): Promise<{ code: number | null; data: Buffer; bytes: number }> {
  check(signal);
  const destination = options.outputFile ? await open(options.outputFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600) : null;
  let source: Awaited<ReturnType<typeof open>> | null = null;
  try {
    if (options.inputFile) { source = await open(options.inputFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); const info = await source.stat(); if (!info.isFile()) throw unavailable(); }
    check(signal);
    const child = spawn('git', [...gitOptions, ...(path ? ['--git-dir', path] : []), ...args], { cwd: '/', env: environment, stdio: [options.input !== undefined || source ? 'pipe' : 'ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
    let failure: unknown, bytes = 0, errorBytes = 0;
    const chunks: Buffer[] = [];
    const stop = () => { try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { child.kill('SIGKILL'); } };
    const abort = () => { failure ??= cancelled(); stop(); };
    signal.addEventListener('abort', abort, { once: true });
    const exited = new Promise<number | null>(resolve => { child.once('error', () => { failure ??= unavailable(); }); child.once('close', resolve); });
    child.stderr!.on('data', (chunk: Buffer) => { errorBytes += chunk.length; if (errorBytes > 64_000) { failure ??= limit(); stop(); } });
    child.stdin?.on('error', () => undefined);
    const sending = source ? (async () => {
      // Read from the verified descriptor, never reopen a path after validation.
      const reader = source!.createReadStream({ autoClose: false });
      try {
        for await (const chunk of reader) {
          check(signal);
          if (child.stdin!.destroyed || !child.stdin!.writable) throw unavailable();
          if (!child.stdin!.write(chunk)) await new Promise<void>((resolve, reject) => {
            const cleanup = () => { child.stdin!.off('drain', done); child.stdin!.off('error', failed); child.stdin!.off('close', closed); signal.removeEventListener('abort', aborted); };
            const done = () => { cleanup(); resolve(); }, failed = () => { cleanup(); reject(unavailable()); }, closed = () => { cleanup(); reject(unavailable()); }, aborted = () => { cleanup(); reject(cancelled()); };
            child.stdin!.once('drain', done); child.stdin!.once('error', failed); child.stdin!.once('close', closed); signal.addEventListener('abort', aborted, { once: true });
            if (signal.aborted) aborted();
            else if (child.stdin!.destroyed || !child.stdin!.writable) closed();
          });
        }
        child.stdin!.end();
      } finally { reader.destroy(); }
    })().catch(error => { failure ??= error; stop(); }) : Promise.resolve(child.stdin?.end(options.input));
    const output = (async () => {
      for await (const raw of child.stdout!) {
        const chunk = Buffer.from(raw as Uint8Array); bytes += chunk.length;
        if (bytes > (options.maximum ?? 4_000_000)) throw limit();
        check(signal);
        if (destination) {
          let offset = 0;
          while (offset < chunk.length) { const written = await destination.write(chunk, offset, chunk.length - offset); if (!written.bytesWritten) throw unavailable(); offset += written.bytesWritten; }
        } else chunks.push(chunk);
      }
    })().catch(error => { failure ??= error; stop(); });
    if (signal.aborted) abort();
    try { const code = await exited; await sending; await output; if (failure) throw failure; check(signal); return { code, data: Buffer.concat(chunks), bytes }; }
    finally { signal.removeEventListener('abort', abort); stop(); }
  } finally { await source?.close(); await destination?.close(); }
}

/**
 * Upload-pack protocol v2 may satisfy a known object ID even with hideRefs.
 * Give it a separate object database containing only current public reachability.
 * No alternates, hardlinks, shared packs, or repository-provided hooks are used.
 */
export async function createPublicGitProjection(repositoryId: string, sourcePath: string, options: PublicGitProjectionOptions = {}): Promise<PublicGitProjection> {
  const maximum = options.maxPackBytes ?? 512 * 1024 * 1024, timeoutMs = options.timeoutMs ?? 120_000;
  if (!/^R[1-9]\d{0,48}$/.test(repositoryId) || !Number.isSafeInteger(maximum) || maximum < 12 || maximum > 2 * 1024 * 1024 * 1024 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw unavailable();
  const timer = AbortSignal.timeout(timeoutMs), signal = options.signal ? AbortSignal.any([options.signal, timer]) : timer;
  check(signal);
  let directory: string | null = null;
  try {
    const info = await createGitObserver({ [repositoryId]: sourcePath }).info(repositoryId, signal);
    if (info.state !== 'ready') throw unavailable();
    const canonical = await realpath(sourcePath), metadata = await lstat(sourcePath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw unavailable();
    const format = info.objectFormat;
    const capture = await run(canonical, ['for-each-ref', '--format=%(objectname) %(refname) %(symref)', 'refs/heads/', 'refs/tags/'], signal);
    if (capture.code !== 0) throw unavailable();
    const refs: PublicGitRef[] = [], names = new Set<string>();
    for (const line of capture.data.toString('utf8').split('\n').filter(Boolean)) {
      const match = /^(\S+) (\S+) $/.exec(line);
      // Symbolic refs are rejected rather than permitting a public alias into internal state.
      if (!match || !oid(match[1]!, format) || !validRef(match[2]!) || names.has(match[2]!) || refs.length >= 10_000) throw unavailable();
      names.add(match[2]!); refs.push({ name: match[2]!, objectId: match[1]! });
    }
    const sourceHead = await run(canonical, ['symbolic-ref', '--quiet', 'HEAD'], signal, { maximum: 4096 });
    const selected = sourceHead.code === 0 ? sourceHead.data.toString('utf8').trim() : null;
    const branches = refs.filter(ref => ref.name.startsWith('refs/heads/'));
    const head = branches.find(ref => ref.name === selected)?.name ?? branches.find(ref => ref.name === 'refs/heads/main')?.name ?? branches[0]?.name ?? null;
    directory = await mkdtemp(join(options.parentDirectory ?? tmpdir(), 'phab-public-git-')); await chmod(directory, 0o700);
    const path = join(directory, 'repository.git'), pack = join(directory, 'public.pack');
    const initialized = await run(null, ['init', '--bare', '--template=', '--initial-branch=main', `--object-format=${format}`, path], signal, { maximum: 4096 });
    if (initialized.code !== 0) throw unavailable();
    if (refs.length) {
      const packed = await run(canonical, ['pack-objects', '--revs', '--stdout', '--no-reuse-delta', '--no-reuse-object', '--window=0', '--compression=1'], signal, { input: [...new Set(refs.map(ref => ref.objectId))].join('\n') + '\n', outputFile: pack, maximum });
      if (packed.code !== 0) throw unavailable();
      const header = await open(pack, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const bytes = Buffer.alloc(12), read = await header.read(bytes, 0, 12, 0);
        if (read.bytesRead !== 12 || bytes.subarray(0, 4).toString('ascii') !== 'PACK' || ![2, 3].includes(bytes.readUInt32BE(4)) || bytes.readUInt32BE(8) > 1_000_000) throw limit();
      } finally { await header.close(); }
      const indexed = await run(path, ['index-pack', '--stdin', '--strict'], signal, { inputFile: pack, maximum: 4096 });
      if (indexed.code !== 0) throw unavailable();
      await rm(pack);
      const updates = refs.map(ref => `create ${ref.name} ${ref.objectId}`);
      const updated = await run(path, ['update-ref', '--stdin'], signal, { input: `start\noption no-deref\n${updates.join('\n')}\nprepare\ncommit\n`, maximum: 4096 });
      if (updated.code !== 0) throw unavailable();
    }
    await writeFile(join(path, 'HEAD'), `ref: ${head ?? 'refs/heads/main'}\n`, { mode: 0o600 });
    const current = await lstat(sourcePath);
    if (current.isSymbolicLink() || current.dev !== metadata.dev || current.ino !== metadata.ino || await realpath(sourcePath) !== canonical) throw unavailable();
    check(signal);
    const ownedDirectory = directory;
    const projection: PublicGitProjection = { path, objectFormat: format, refs: Object.freeze(refs.map(ref => Object.freeze(ref))), head, dispose: async () => { await rm(ownedDirectory, { recursive: true, force: true }); } };
    return Object.freeze(projection);
  } catch (error) {
    if (directory) await rm(directory, { recursive: true, force: true });
    if (options.signal?.aborted) throw cancelled();
    if (timer.aborted) throw limit();
    if (error instanceof HttpError) throw error;
    throw unavailable();
  }
}
