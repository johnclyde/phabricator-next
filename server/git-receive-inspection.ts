import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { structuredPatch } from 'diff';
import { isGitPath, type GitCommit, type GitObjectFormat } from '../shared/repositories.ts';
import type { GitReceiveFile, GitReceiveFileInspection, GitReceiveObject } from '../shared/git-automation.ts';

/** This collector runs only for an explicitly trusted receive hook or configured
 * local landing repository. Hook quarantine never enters the web server. */
export interface InspectedCommit { commit: GitCommit; files: GitReceiveFile[]; branches: string[]; inspectionComplete: true }
export interface InspectedRef { refName: string; oldId: string | null; newId: string | null; oldCommitId: string | null; newCommitId: string | null; forced: boolean; commitIds: string[] }
export interface ReceiveInspection { objectFormat: GitObjectFormat; updates: InspectedRef[]; commits: InspectedCommit[] }
export const RECEIVE_LIMITS = { refs: 100, commits: 500, paths: 1_000, bytes: 8 * 1024 * 1024, blobBytes: 8 * 1024 * 1024, encodedTextBytes: 16 * 1024 * 1024, diffLines: 100_000, diffTimeoutMs: 250, timeoutMs: 60_000 } as const;
const fail = (message: string): never => { throw new Error(message); };
const utf8 = (data: Buffer) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
const oid = (value: string, length: number) => new RegExp(`^[0-9a-f]{${length}}$`).test(value);
const modes = new Set(['100644', '100755', '120000', '160000']);
type ChangedFile = { path: string; old: GitReceiveObject | null; new: GitReceiveObject | null };
function changedFiles(raw: Buffer, length: number): ChangedFile[] {
  if (!raw.length) return [];
  const fields = utf8(raw).split('\0'); if (fields.pop() !== '' || fields.length % 2) fail('Malformed changed-path inspection.');
  const files: ChangedFile[] = [], paths = new Set<string>();
  for (let index = 0; index < fields.length; index += 2) {
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([ADMT])$/.exec(fields[index]!), path = fields[index + 1]!;
    if (!match || !path || !isGitPath(path) || paths.has(path)) fail('Malformed or duplicate changed-path inspection.');
    const side = (mode: string, id: string): GitReceiveObject | null => {
      if (!oid(id, length)) fail('Malformed changed-object identity.');
      if (mode === '000000' && /^0+$/.test(id)) return null;
      if (!modes.has(mode) || /^0+$/.test(id)) fail('Unsupported changed-object mode.');
      return { id, mode: mode as GitReceiveObject['mode'], bytes: null };
    };
    const old = side(match![1]!, match![3]!), next = side(match![2]!, match![4]!);
    if (!old && !next || match![5] === 'A' && (old || !next) || match![5] === 'D' && (!old || next) || ['M', 'T'].includes(match![5]!) && (!old || !next)) fail('Inconsistent changed-object inspection.');
    paths.add(path); files.push({ path, old, new: next });
  }
  return files;
}
function quotedPath(value: string): string {
  const bytes = Buffer.from(value); if ([...bytes].every(byte => byte >= 32 && byte < 127 && byte !== 34 && byte !== 92)) return value;
  return '"' + [...bytes].map(byte => byte === 34 ? '\\"' : byte === 92 ? '\\\\' : byte === 9 ? '\\t' : byte === 10 ? '\\n' : byte === 13 ? '\\r' : byte >= 32 && byte < 127 ? String.fromCharCode(byte) : `\\${byte.toString(8).padStart(3, '0')}`).join('') + '"';
}
function encodedPatchBytes(patch: Pick<GitReceiveFile, 'content' | 'added' | 'removed'>, bytes: number): number {
  let result = bytes + Buffer.byteLength('{"content":"","added":"","removed":""}');
  for (const value of [patch.content, patch.added, patch.removed]) for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) result++;
    else if (code < 32) result += 5;
  }
  return result;
}
function textPatch(file: ChangedFile, before: string, after: string, length: number, timeout: number): Pick<GitReceiveFile, 'content' | 'added' | 'removed'> | null {
  // Bound tokenization as well as edit search. No repository attributes, custom
  // diff driver, textconv, filter or checkout participates in these raw bytes.
  const lines = (value: string) => { let count = 1; for (let index = 0; index < value.length; index++) if (value.charCodeAt(index) === 10 && ++count > RECEIVE_LIMITS.diffLines) return false; return true; };
  if (!lines(before) || !lines(after)) return null;
  const oldPath = quotedPath(`a/${file.path}`), newPath = quotedPath(`b/${file.path}`);
  const patch = structuredPatch(oldPath, newPath, before, after, undefined, undefined, { context: 0, timeout });
  if (!patch) return null;
  const output = [`diff --git ${oldPath} ${newPath}`], added: string[] = [], removed: string[] = [];
  if (!file.old) output.push(`new file mode ${file.new!.mode}`);
  else if (!file.new) output.push(`deleted file mode ${file.old.mode}`);
  else if (file.old.mode !== file.new.mode) output.push(`old mode ${file.old.mode}`, `new mode ${file.new.mode}`);
  if (file.old?.id !== file.new?.id) output.push(`index ${file.old?.id ?? '0'.repeat(length)}..${file.new?.id ?? '0'.repeat(length)}${file.old && file.new && file.old.mode === file.new.mode ? ` ${file.old.mode}` : ''}`);
  if (patch.hunks.length) {
    output.push(`--- ${file.old ? oldPath : '/dev/null'}`, `+++ ${file.new ? newPath : '/dev/null'}`);
    const range = (start: number, count: number) => count === 1 ? String(start) : `${count ? start : start - 1},${count}`;
    for (const hunk of patch.hunks) {
      output.push(`@@ -${range(hunk.oldStart, hunk.oldLines)} +${range(hunk.newStart, hunk.newLines)} @@`);
      for (const line of hunk.lines) { output.push(line); if (line.startsWith('+')) added.push(line.slice(1)); else if (line.startsWith('-')) removed.push(line.slice(1)); }
    }
  }
  return { content: output.join('\n') + '\n', added: added.join('\n'), removed: removed.join('\n') };
}

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
  const run = (args: string[], maximum: number = RECEIVE_LIMITS.bytes, input?: string): Promise<{ data: Buffer; code: number | null }> => new Promise((accept, reject) => {
    const remaining = deadline - Date.now(); if (remaining <= 0) { reject(new Error('Receive inspection exceeded its time limit.')); return; }if(options.signal?.aborted){reject(new Error('Receive inspection was cancelled.'));return;}
    const child = spawn('git', ['--no-pager', '--no-replace-objects', '--literal-pathspecs', '-c', 'protocol.allow=never', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null', '-c', 'diff.external=', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '--git-dir', root, ...args], { cwd: '/', env, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let size = 0, errorBytes = 0; const chunks: Buffer[] = []; let failure: Error | undefined;
    const stop = (message: string) => { failure ??= new Error(message); child.kill('SIGKILL'); };
    const cancel=()=>stop('Receive inspection was cancelled.');options.signal?.addEventListener('abort',cancel,{once:true});
    const timer = setTimeout(() => stop('Receive inspection exceeded its time limit.'), remaining);
    child.stdout!.on('data', (chunk: Buffer) => { size += chunk.length; if (size > maximum) stop('Receive inspection exceeds the supported result limit.'); else chunks.push(chunk); });
    child.stderr!.on('data', (chunk: Buffer) => { errorBytes += chunk.length; if (errorBytes > 32_000) stop('Receive inspection failed.'); });
    child.on('error', () => { failure ??= new Error('The receiving Git executable is unavailable.'); });
    child.on('close', code => { clearTimeout(timer);options.signal?.removeEventListener('abort',cancel); if (failure) reject(failure); else accept({ code, data: Buffer.concat(chunks) }); });if(input !== undefined){child.stdin!.on('error',()=>undefined);child.stdin!.end(input);}if(options.signal?.aborted)cancel();
  });
  const git = async (args: string[], max?: number, input?: string) => { const result = await run(args, max, input); if (result.code !== 0) fail('Git could not completely inspect this receive operation.'); return result.data; };
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
  const commits: InspectedCommit[] = []; let metadataBytes = 0, capturedBytes = 0, encodedTextBytes = 0;
  for (const id of selected) {
    const raw = await git(['cat-file', 'commit', id], maximumCommitBytes);
    if (createHash(objectFormat).update(`commit ${raw.length}\0`).update(raw).digest('hex') !== id) fail('Commit content does not match its identity.');
    const text = utf8(raw), split = text.indexOf('\n\n'); if (split < 0) fail('Malformed commit object.');
    const headers = text.slice(0, split).split('\n'), treeId = headers.find(line => line.startsWith('tree '))?.slice(5) ?? '', parentIds = headers.filter(line => line.startsWith('parent ')).map(line => line.slice(7));
    if (!oid(treeId, length) || parentIds.some(value => !oid(value, length))) fail('Malformed commit ancestry.');
    const person = (kind: string) => { const value = headers.find(line => line.startsWith(`${kind} `)); const match = value && /^.*? (.*) <([^<>]*)> (-?\d+) [+-]\d{4}$/.exec(value); if (!match) return fail('Malformed commit author or committer.'); const date = new Date(Number(match[3]) * 1000); if (!Number.isFinite(date.getTime())) fail('Invalid commit timestamp.'); return { name: match[1]!, email: match[2]!, timestamp: date.toISOString() }; };
    const commit: GitCommit = { id, treeId, parentIds, author: person('author'), committer: person('committer'), message: text.slice(split + 2), messageTruncated: false };
    const pair = parentIds.length ? [parentIds[0]!, id] : ['--root', id];
    const changedRaw = await git(['diff-tree', '--no-commit-id', '-r', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-relative', '--ignore-submodules=none', '--raw', '--no-abbrev', '-z', ...pair, '--']);
    const changed = changedFiles(changedRaw, length);
    if (changed.length > RECEIVE_LIMITS.paths) fail('Receive changed-path limit exceeded.');
    // Batch metadata does not read or allocate oversized blob bodies. Gitlinks
    // refer to another repository and need not be present in this object store.
    const objectIds = [...new Set(changed.flatMap(file => [file.old, file.new]).filter((side): side is GitReceiveObject => side !== null && side.mode !== '160000').map(side => side.id))];
    const metadata = objectIds.length ? await git(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], RECEIVE_LIMITS.bytes, objectIds.join('\n') + '\n') : Buffer.alloc(0);
    const metadataLines = metadata.length ? utf8(metadata).trimEnd().split('\n') : [], sizes = new Map<string, number>();
    if (metadataLines.length !== objectIds.length) fail('Incomplete changed-object metadata.');
    metadataLines.forEach((line, index) => {
      const match = /^([0-9a-f]+) blob (0|[1-9]\d*)$/.exec(line), size = Number(match?.[2]);
      if (!match || match[1] !== objectIds[index] || !Number.isSafeInteger(size) || size < 0) fail('Invalid changed-object metadata.');
      sizes.set(match![1]!, size);
    });
    for (const file of changed) for (const side of [file.old, file.new]) if (side && side.mode !== '160000') side.bytes = sizes.get(side.id)!;
    const files: InspectedCommit['files'] = [];
    const repetitions = updates.filter(update => update.commitIds.includes(id)).length;
    metadataBytes += (raw.length + changedRaw.length + metadata.length) * repetitions;
    if (metadataBytes > RECEIVE_LIMITS.bytes) fail('Receive inspection exceeds the supported metadata size.');
    for (const file of changed) {
      if (options.signal?.aborted) fail('Receive inspection was cancelled.');
      if (Date.now() >= deadline) fail('Receive inspection exceeded its time limit.');
      const inspection: GitReceiveFileInspection = { kind: 'text', old: file.old, new: file.new };
      const result: GitReceiveFile = { path: file.path, content: '', added: '', removed: '', inspection };
      if ([file.old, file.new].some(side => side?.mode === '160000')) inspection.kind = 'gitlink';
      else if ([file.old, file.new].some(side => side && side.bytes! > RECEIVE_LIMITS.blobBytes)) inspection.kind = 'too-large';
      else {
        const read = async (side: GitReceiveObject | null) => {
          if (!side) return Buffer.alloc(0);
          const data = await git(['cat-file', 'blob', side.id], side.bytes!);
          if (data.length !== side.bytes || createHash(objectFormat).update(`blob ${data.length}\0`).update(data).digest('hex') !== side.id) fail('Blob content does not match its identity.');
          return data;
        };
        const before = await read(file.old), after = file.old && file.new?.id === file.old.id ? before : await read(file.new);
        if (before.includes(0) || after.includes(0)) inspection.kind = 'binary';
        else {
          let beforeText: string | undefined, afterText: string | undefined;
          try { beforeText = utf8(before); afterText = utf8(after); } catch { inspection.kind = 'non-utf8'; }
          if (inspection.kind === 'text') {
            const patch = textPatch(file, beforeText!, afterText!, length, Math.min(RECEIVE_LIMITS.diffTimeoutMs, Math.max(1, deadline - Date.now())));
            if (options.signal?.aborted) fail('Receive inspection was cancelled.');
            if (Date.now() >= deadline) fail('Receive inspection exceeded its time limit.');
            const bytes = patch ? Buffer.byteLength(patch.content) + Buffer.byteLength(patch.added) + Buffer.byteLength(patch.removed) : 0;
            const encoded = patch ? encodedPatchBytes(patch, bytes) : 0;
            if (!patch || capturedBytes + bytes * repetitions > RECEIVE_LIMITS.bytes || encodedTextBytes + encoded * repetitions > RECEIVE_LIMITS.encodedTextBytes) inspection.kind = 'too-large';
            else { Object.assign(result, patch); capturedBytes += bytes * repetitions; encodedTextBytes += encoded * repetitions; }
          }
        }
      }
      files.push(result);
    }
    const branches = updates.filter(update => update.refName.startsWith('refs/heads/') && update.commitIds.includes(id)).map(update => update.refName.slice('refs/heads/'.length));
    commits.push({ commit, files, branches, inspectionComplete: true });
  }
  return { objectFormat: objectFormat as GitObjectFormat, updates, commits };
}
