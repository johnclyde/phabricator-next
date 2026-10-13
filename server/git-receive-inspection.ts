import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { GitCommit, GitObjectFormat } from '../shared/repositories.ts';

/** This collector runs only on the explicitly trusted receiving host, inside a
 * Git receive hook. Its quarantine environment never enters the web server. */
export interface InspectedCommit { commit: GitCommit; files: { path: string; content: string; added: string; removed: string }[]; branches: string[]; inspectionComplete: true }
export interface InspectedRef { refName: string; oldId: string | null; newId: string | null; oldCommitId: string | null; newCommitId: string | null; forced: boolean; commitIds: string[] }
export interface ReceiveInspection { objectFormat: GitObjectFormat; updates: InspectedRef[]; commits: InspectedCommit[] }
export const RECEIVE_LIMITS = { refs: 100, commits: 500, paths: 1_000, bytes: 8 * 1024 * 1024, timeoutMs: 60_000 } as const;
const fail = (message: string): never => { throw new Error(message); };
const utf8 = (data: Buffer) => new TextDecoder('utf-8', { fatal: true }).decode(data);
const oid = (value: string, length: number) => new RegExp(`^[0-9a-f]{${length}}$`).test(value);

export async function inspectReceive(repositoryPath: string, stdin: string, phase: 'pre' | 'post', inherited: NodeJS.ProcessEnv = process.env, options: { maximumCommitBytes?: number; signal?: AbortSignal } = {}): Promise<ReceiveInspection> {
  const maximumCommitBytes=options.maximumCommitBytes??128_000;
  if(!Number.isSafeInteger(maximumCommitBytes)||maximumCommitBytes<1||maximumCommitBytes>1024*1024)fail('Invalid receive commit inspection limit.');
  if(options.signal?.aborted)fail('Receive inspection was cancelled.');
  const root = await realpath(repositoryPath);
  if (!(await lstat(root)).isDirectory()) fail('The configured receiving repository is unavailable.');
  const deadline = Date.now() + RECEIVE_LIMITS.timeoutMs;
  // Preserve only receive-pack's object quarantine, never user configuration,
  // arbitrary Git configuration injection, credentials, hooks or transports.
  const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', GIT_ATTR_NOSYSTEM: '1', LC_ALL: 'C', TZ: 'UTC' };
  if (inherited.GIT_OBJECT_DIRECTORY || inherited.GIT_ALTERNATE_OBJECT_DIRECTORIES) {
    const quarantine = inherited.GIT_OBJECT_DIRECTORY;
    if (!quarantine || phase !== 'pre') fail('Unexpected receive quarantine environment.');
    const directory = await realpath(quarantine!);
    if (resolve(directory, '..') !== join(root, 'objects') || !directory.startsWith(join(root, 'objects', 'tmp_objdir-incoming-'))) fail('Receive quarantine is outside the configured repository.');
    if (!inherited.GIT_ALTERNATE_OBJECT_DIRECTORIES || await realpath(inherited.GIT_ALTERNATE_OBJECT_DIRECTORIES) !== join(root, 'objects')) fail('Unsupported receive object alternates.');
    env.GIT_OBJECT_DIRECTORY = directory; env.GIT_ALTERNATE_OBJECT_DIRECTORIES = join(root, 'objects');
  }
  for (const name of ['shallow', 'info/grafts', 'objects/info/alternates', 'objects/info/http-alternates']) {
    try { await lstat(join(root, name)); fail('Incomplete repositories and object indirection are unsupported by receive rules.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const run = (args: string[], maximum = RECEIVE_LIMITS.bytes): Promise<{ data: Buffer; code: number | null }> => new Promise((accept, reject) => {
    const remaining = deadline - Date.now(); if (remaining <= 0) { reject(new Error('Receive inspection exceeded its time limit.')); return; }if(options.signal?.aborted){reject(new Error('Receive inspection was cancelled.'));return;}
    const child = spawn('git', ['--no-pager', '--no-replace-objects', '--literal-pathspecs', '-c', 'protocol.allow=never', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null', '-c', 'diff.external=', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '--git-dir', root, ...args], { cwd: '/', env, stdio: ['ignore', 'pipe', 'pipe'] });
    let size = 0, errorBytes = 0; const chunks: Buffer[] = []; let failure: Error | undefined;
    const stop = (message: string) => { failure ??= new Error(message); child.kill('SIGKILL'); };
    const cancel=()=>stop('Receive inspection was cancelled.');options.signal?.addEventListener('abort',cancel,{once:true});
    const timer = setTimeout(() => stop('Receive inspection exceeded its time limit.'), remaining);
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > maximum) stop('Receive inspection exceeds the supported result limit.'); else chunks.push(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { errorBytes += chunk.length; if (errorBytes > 32_000) stop('Receive inspection failed.'); });
    child.on('error', () => { failure ??= new Error('The receiving Git executable is unavailable.'); });
    child.on('close', code => { clearTimeout(timer);options.signal?.removeEventListener('abort',cancel); if (failure) reject(failure); else accept({ code, data: Buffer.concat(chunks) }); });if(options.signal?.aborted)cancel();
  });
  const git = async (args: string[], max?: number) => { const result = await run(args, max); if (result.code !== 0) fail('Git could not completely inspect this receive operation.'); return result.data; };
  if (utf8(await git(['rev-parse', '--is-bare-repository'])).trim() !== 'true') fail('Receive rules require a bare repository.');
  const objectFormat = utf8(await git(['rev-parse', '--show-object-format'])).trim();
  if (objectFormat !== 'sha1' && objectFormat !== 'sha256') fail('Unsupported receiving object format.');
  const length = objectFormat === 'sha1' ? 40 : 64;
  if (!stdin.endsWith('\n') || Buffer.byteLength(stdin) > 128_000) fail('Malformed or oversized receive input.');
  const lines = stdin.slice(0, -1).split('\n');
  if (!lines.length || lines.length > RECEIVE_LIMITS.refs) fail('Receive reference limit exceeded.');
  const updates: InspectedRef[] = [], refs = new Set<string>(), selected = new Set<string>();
  const peel = async (id: string | null) => {
    if (!id) return null;
    const result = await run(['rev-parse', '--verify', `${id}^{commit}`], 200);
    if (result.code !== 0) { await git(['cat-file', '-t', id], 100); return null; }
    const value = utf8(result.data).trim(); if (!oid(value, length)) fail('Invalid peeled commit identity.'); return value;
  };
  for (const line of lines) {
    const parts = line.split(' '); const [oldRaw, newRaw, refName] = parts;
    if (parts.length !== 3 || !oldRaw || !newRaw || !refName || !oid(oldRaw, length) || !oid(newRaw, length) || !/^refs\/(heads|tags)\//.test(refName) || refs.has(refName)) fail('Malformed, duplicate or unsupported receiving reference.');
    if ((await run(['check-ref-format', refName!], 100)).code !== 0) fail('Invalid receiving reference.');
    refs.add(refName!);
    const oldId = /^0+$/.test(oldRaw!) ? null : oldRaw!, newId = /^0+$/.test(newRaw!) ? null : newRaw!;
    if (oldId === newId) fail('A receive update must change a reference.');
    const current = await run(['rev-parse', '--verify', '--quiet', refName!], 200);
    const currentId = current.code === 1 ? null : current.code === 0 ? utf8(current.data).trim() : fail('Cannot inspect current receiving reference.');
    if (currentId !== (phase === 'pre' ? oldId : newId)) fail('The receiving reference changed; this observation is stale.');
    const oldCommitId = await peel(oldId), newCommitId = await peel(newId);
    if (refName!.startsWith('refs/heads/') && newId && !newCommitId) fail('Branches must refer to commits.');
    let forced = false;
    if (oldId && newId) {
      if (refName!.startsWith('refs/tags/')) forced = true;
      else { const relation = await run(['merge-base', '--is-ancestor', oldCommitId!, newCommitId!], 100); if (relation.code !== 0 && relation.code !== 1) fail('Could not verify fast-forward status.'); forced = relation.code === 1; }
    }
    let commitIds: string[] = [];
    if (newCommitId) {
      const data = utf8(await git(['rev-list', '--reverse', '--topo-order', `--max-count=${RECEIVE_LIMITS.commits + 1}`, newCommitId, ...(oldCommitId ? ['--not', oldCommitId] : []), '--'], 100_000)).trim();
      commitIds = data ? data.split('\n') : [];
      if (commitIds.some(id => !oid(id, length)) || commitIds.length > RECEIVE_LIMITS.commits) fail('Receive commit limit exceeded; split or bootstrap this repository explicitly.');
      commitIds.forEach(id => selected.add(id));
      if (selected.size > RECEIVE_LIMITS.commits) fail('Receive commit limit exceeded.');
    }
    updates.push({ refName: refName!, oldId, newId, oldCommitId, newCommitId, forced, commitIds });
  }
  const commits: InspectedCommit[] = []; let bytes = 0;
  for (const id of selected) {
    const raw = await git(['cat-file', 'commit', id], maximumCommitBytes);
    if (createHash(objectFormat).update(`commit ${raw.length}\0`).update(raw).digest('hex') !== id) fail('Commit content does not match its identity.');
    const text = utf8(raw), split = text.indexOf('\n\n'); if (split < 0) fail('Malformed commit object.');
    const headers = text.slice(0, split).split('\n'), treeId = headers.find(line => line.startsWith('tree '))?.slice(5) ?? '', parentIds = headers.filter(line => line.startsWith('parent ')).map(line => line.slice(7));
    if (!oid(treeId, length) || parentIds.some(value => !oid(value, length))) fail('Malformed commit ancestry.');
    const person = (kind: string) => { const value = headers.find(line => line.startsWith(`${kind} `)); const match = value && /^.*? (.*) <([^<>]*)> (-?\d+) [+-]\d{4}$/.exec(value); if (!match) return fail('Malformed commit author or committer.'); const date = new Date(Number(match[3]) * 1000); if (!Number.isFinite(date.getTime())) fail('Invalid commit timestamp.'); return { name: match[1]!, email: match[2]!, timestamp: date.toISOString() }; };
    const commit: GitCommit = { id, treeId, parentIds, author: person('author'), committer: person('committer'), message: text.slice(split + 2), messageTruncated: false };
    const pair = parentIds.length ? [parentIds[0]!, id] : ['--root', id];
    const changedRaw = await git(['diff-tree', '--no-commit-id', '-r', '--no-renames', '--name-only', '-z', ...pair, '--']);
    const changedPaths = utf8(changedRaw).split('\0').filter(Boolean);
    if (changedPaths.length > RECEIVE_LIMITS.paths) fail('Receive changed-path limit exceeded.');
    const files: InspectedCommit['files'] = [];
    bytes += raw.length + changedRaw.length;
    if (bytes > RECEIVE_LIMITS.bytes) fail('Receive inspection exceeds the supported total size.');
    for (const path of changedPaths) {
      // Literal paths; no external diff, text conversion, checkout or filters.
      const patch = await git(['diff-tree', '--no-commit-id', '-r', '--no-renames', '--no-ext-diff', '--no-textconv', '--diff-algorithm=myers', '--unified=0', '--full-index', '-p', ...pair, '--', path]);
      const content = utf8(patch); if (/^Binary files .* differ$/m.test(content) || /^GIT binary patch$/m.test(content)) fail('Binary changes require an explicit unsupported-inspection policy; receive rejected.');
      const added: string[] = [], removed: string[] = []; let hunk = false;
      for (const line of content.split('\n')) { if (line.startsWith('diff --git ')) hunk = false; else if (line.startsWith('@@ ')) hunk = true; else if (hunk && line.startsWith('+')) added.push(line.slice(1)); else if (hunk && line.startsWith('-')) removed.push(line.slice(1)); }
      bytes += patch.length; if (bytes > RECEIVE_LIMITS.bytes) fail('Receive inspection exceeds the supported total size.');
      files.push({ path, content, added: added.join('\n'), removed: removed.join('\n') });
    }
    const branches = updates.filter(update => update.refName.startsWith('refs/heads/') && update.commitIds.includes(id)).map(update => update.refName.slice('refs/heads/'.length));
    commits.push({ commit, files, branches, inspectionComplete: true });
  }
  return { objectFormat: objectFormat as GitObjectFormat, updates, commits };
}
