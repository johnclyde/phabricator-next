import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { GIT_LIMITS, isGitObjectId, isGitPath } from '../shared/repositories.ts';
import type { GitBlob, GitCommit, GitCommitResult, GitHistory, GitHistoryQuery, GitImportSnapshot, GitObjectFormat, GitObserverInfo, GitPerson, GitRefs, GitTree, GitTreeEntry, GitComparison, GitComparisonFile, GitComparisonQuery, GitComparisonFileQuery, GitComparisonEntry, GitComparisonChange, GitComparisonSide } from '../shared/repositories.ts';
import type { SourceFile } from '../shared/types.ts';
import { files, HttpError } from './validation.ts';

export interface GitObserver {
  info(repositoryId: string, signal?: AbortSignal): Promise<GitObserverInfo>;
  refs(repositoryId: string, signal?: AbortSignal): Promise<GitRefs>;
  commit(repositoryId: string, commit: string, signal?: AbortSignal): Promise<GitCommitResult>;
  tree(repositoryId: string, commit: string, path: string, signal?: AbortSignal): Promise<GitTree>;
  blob(repositoryId: string, commit: string, path: string, signal?: AbortSignal): Promise<GitBlob>;
  history(repositoryId: string, query: GitHistoryQuery, signal?: AbortSignal): Promise<GitHistory>;
  compare(repositoryId: string, query: GitComparisonQuery, signal?: AbortSignal): Promise<GitComparison>;
  compareFile(repositoryId: string, query: GitComparisonFileQuery, signal?: AbortSignal): Promise<GitComparisonFile>;
  importSnapshot(repositoryId: string, commit: string, signal?: AbortSignal): Promise<GitImportSnapshot>;
}

const unavailable = () => new HttpError(503, 'The local Git repository is unavailable or its configuration is unsupported.', 'GIT_UNAVAILABLE');
const missing = () => new HttpError(404, 'The requested Git object or path is unavailable.', 'GIT_OBJECT_UNAVAILABLE');
const corrupt = () => new HttpError(422, 'The Git object cannot be safely decoded or verified.', 'GIT_INVALID_OBJECT');
const invalid = () => new HttpError(400, 'Provide a full Git commit identifier and a valid repository path or history query.', 'GIT_INVALID_QUERY');
const limit = () => new HttpError(422, 'This Git operation exceeds the supported size, time, or result limit.', 'GIT_LIMIT_EXCEEDED');
const aborted = () => new HttpError(499, 'The Git operation was cancelled.', 'GIT_ABORTED');
const unsupportedImport = () => new HttpError(422, 'Import requires a complete nonempty tree of UTF-8 text files with supported source paths. Empty directories, binary files, symlinks and submodules are unsupported.', 'GIT_IMPORT_UNSUPPORTED');
const checkAbort = (signal: AbortSignal): void => { if (signal.aborted) throw aborted(); };

/** Operator configuration only. Never echo private paths or configuration values. */
export function parseGitRepositories(raw: string | undefined): Readonly<Record<string, string>> {
  if (raw === undefined || raw === '') return Object.freeze({});
  const error = () => new Error('APP_GIT_REPOSITORIES must be a JSON object mapping repository IDs to absolute local bare Git paths.');
  if (raw.length > 100_000) throw error();
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw error(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw error();
  const entries = Object.entries(value);
  if (entries.length > 100 || entries.some(([id, path]) => !/^R[1-9]\d*$/.test(id) || id.length > 50 || typeof path !== 'string' || path.length > 4096 || path.includes('\0') || !isAbsolute(path))) throw error();
  return Object.freeze(Object.fromEntries(entries) as Record<string, string>);
}

type Permit = () => void;
class Gate {
  private active = 0;
  private waiting: { signal: AbortSignal; resolve: (release: Permit) => void; reject: (error: Error) => void; cancel: () => void }[] = [];
  async acquire(signal: AbortSignal): Promise<Permit> {
    checkAbort(signal);
    if (this.active < GIT_LIMITS.concurrency) { this.active += 1; return () => this.release(); }
    if (this.waiting.length >= GIT_LIMITS.queued) throw new HttpError(503, 'Git browsing is busy. Retry shortly.', 'GIT_BUSY');
    return new Promise((resolve, reject) => {
      const entry = { signal, resolve, reject, cancel: () => { this.waiting = this.waiting.filter(item => item !== entry); reject(aborted()); } };
      this.waiting.push(entry); signal.addEventListener('abort', entry.cancel, { once: true });
    });
  }
  private release(): void {
    const next = this.waiting.shift();
    if (next) { next.signal.removeEventListener('abort', next.cancel); next.resolve(() => this.release()); }
    else this.active -= 1;
  }
}

const environment: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', HOME: '/nonexistent',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1',
  GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', GIT_OPTIONAL_LOCKS: '0',
  GIT_PAGER: 'cat', GIT_SSH_COMMAND: '/usr/bin/false', LC_ALL: 'C', TZ: 'UTC',
};
const gitOptions = [
  '--no-replace-objects', '--literal-pathspecs', '--no-pager',
  '-c', 'protocol.allow=never', '-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'gc.auto=0',
  '-c', 'maintenance.auto=false', '-c', 'core.commitGraph=false', '-c', 'core.multiPackIndex=false',
];

function run(args: string[], signal: AbortSignal, maximum: number = GIT_LIMITS.outputBytes): Promise<{ data: Buffer; code: number | null }> {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...gitOptions, ...args], { cwd: '/', env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let failure: HttpError | undefined; let size = 0; let errorSize = 0; const chunks: Buffer[] = [];
    const stop = (error: HttpError) => { failure ??= error; child.kill('SIGKILL'); };
    const cancel = () => stop(aborted()); signal.addEventListener('abort', cancel, { once: true });
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > maximum) stop(limit()); else if (!failure) chunks.push(chunk); });
    // Diagnostics can contain operator paths, URLs and credentials. Discard them.
    child.stderr.on('data', (chunk: Buffer) => { errorSize += chunk.length; if (errorSize > 32_000) stop(limit()); });
    child.once('error', () => { failure ??= unavailable(); });
    child.once('close', code => { signal.removeEventListener('abort', cancel); if (failure) reject(failure); else resolve({ data: Buffer.concat(chunks), code }); });
    if (signal.aborted) cancel();
  });
}

async function boundedFile(path: string, maximum: number, optional = false): Promise<Buffer | null> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw unavailable(); }
  try {
    const metadata = await file.stat(); if (!metadata.isFile() || metadata.size > maximum) throw unavailable();
    const buffer = Buffer.alloc(maximum + 1); let length = 0;
    while (length < buffer.length) { const read = await file.read(buffer, length, buffer.length - length, length); if (!read.bytesRead) break; length += read.bytesRead; }
    if (length > maximum) throw unavailable();
    return buffer.subarray(0, length);
  } finally { await file.close(); }
}

async function absent(path: string): Promise<void> {
  try { await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw unavailable(); }
  throw unavailable();
}

/** Reject filesystem indirection; Git object names must never escape this database. */
async function inspectStorage(root: string, signal: AbortSignal): Promise<void> {
  const pending = [join(root, 'objects'), join(root, 'refs')]; let count = 0; let directories = 0;
  while (pending.length) {
    checkAbort(signal); if (++directories > 4096) throw limit();
    const path = pending.pop()!; const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw unavailable();
    const directory = await opendir(path);
    for await (const entry of directory) {
      checkAbort(signal);
      if (++count > 100_000) throw limit();
      if (path === join(root, 'objects', 'pack') && /^pack-(?:[a-f0-9]{40}|[a-f0-9]{64})\.promisor$/.test(entry.name)) throw unavailable();
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) throw unavailable();
      if (entry.isDirectory()) {
        if (directories + pending.length >= 4096) throw limit();
        pending.push(join(path, entry.name));
      }
    }
  }
}

interface RepositoryHandle { path: string; format: GitObjectFormat; signal: AbortSignal }

async function inspectRepository(path: string, signal: AbortSignal): Promise<RepositoryHandle> {
  try {
    checkAbort(signal);
    const metadata = await lstat(path); if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw unavailable();
    const canonical = await realpath(path);
    await boundedFile(join(canonical, 'HEAD'), 4096);
    await boundedFile(join(canonical, 'config'), 64_000);
    const packedRefs = await boundedFile(join(canonical, 'packed-refs'), GIT_LIMITS.outputBytes, true);
    if (packedRefs?.toString('utf8').split('\n').some(line => /^[0-9a-f]+ refs\/replace\//.test(line))) throw unavailable();
    for (const name of ['shallow', 'commondir', 'config.worktree', 'info/grafts', 'objects/info/alternates', 'objects/info/http-alternates', 'refs/replace']) await absent(join(canonical, name));
    await inspectStorage(canonical, signal);
    // Parse only this file and never follow includes or repository discovery.
    const config = await run(['config', '--file', join(canonical, 'config'), '--no-includes', '--null', '--list'], signal);
    if (config.code !== 0) throw unavailable();
    const settings = new Map<string, string>();
    for (const record of config.data.toString('utf8').split('\0').filter(Boolean)) {
      const split = record.indexOf('\n'); const key = (split < 0 ? record : record.slice(0, split)).toLowerCase(); const value = split < 0 ? 'true' : record.slice(split + 1);
      if (settings.has(key)) throw unavailable();
      if (!['core.repositoryformatversion', 'core.filemode', 'core.bare', 'core.logallrefupdates', 'core.ignorecase', 'core.precomposeunicode', 'core.sharedrepository', 'extensions.objectformat'].includes(key) && !/^remote\.[^.]+\.(url|fetch|mirror|tagopt)$/.test(key) && !/^branch\.[^.]+\.(remote|merge)$/.test(key)) throw unavailable();
      settings.set(key, value);
    }
    if (settings.get('core.bare') !== 'true' || !['0', '1'].includes(settings.get('core.repositoryformatversion') ?? '')) throw unavailable();
    const format = settings.get('extensions.objectformat') ?? 'sha1';
    if (format !== 'sha1' && format !== 'sha256') throw unavailable();
    const supported = await run(['--git-dir', canonical, 'rev-parse', '--show-object-format'], signal);
    if (supported.code !== 0 || supported.data.toString('ascii').trim() !== format) throw unavailable();
    return { path: canonical, format, signal };
  } catch (error) { if (error instanceof HttpError) throw error; throw unavailable(); }
}

async function command(repository: RepositoryHandle, args: string[], maximum: number = GIT_LIMITS.outputBytes): Promise<Buffer> {
  const result = await run(['--git-dir', repository.path, ...args], repository.signal, maximum);
  if (result.code !== 0) throw missing();
  return result.data;
}

async function rawObject(repository: RepositoryHandle, id: string, type: 'commit' | 'tree' | 'blob' | 'tag', maximum: number = GIT_LIMITS.outputBytes): Promise<Buffer> {
  if (!isGitObjectId(id, repository.format)) throw invalid();
  const data = await command(repository, ['cat-file', type, id], maximum);
  const actual = createHash(repository.format).update(`${type} ${data.length}\0`).update(data).digest('hex');
  if (actual !== id) throw corrupt();
  return data;
}

function utf8(data: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); }
  catch { throw new HttpError(422, 'This Git metadata uses an unsupported text encoding.', 'GIT_UNSUPPORTED_ENCODING'); }
}

function person(value: string): GitPerson {
  const parsed = /^(.*) <([^<>]*)> (-?\d+) ([+-]\d{4})$/.exec(value);
  if (!parsed) throw corrupt();
  const date = new Date(Number(parsed[3]) * 1000); if (!Number.isFinite(date.getTime())) throw corrupt();
  return { name: parsed[1]!, email: parsed[2]!, timestamp: date.toISOString() };
}

async function readCommit(repository: RepositoryHandle, id: string): Promise<GitCommit> {
  const data = await rawObject(repository, id, 'commit'); const boundary = data.indexOf('\n\n');
  if (boundary < 0 || boundary > 100_000) throw corrupt();
  const headers = utf8(data.subarray(0, boundary)).split('\n');
  const one = (key: string): string => { const lines = headers.filter(line => line.startsWith(`${key} `)); if (lines.length !== 1) throw corrupt(); return lines[0]!.slice(key.length + 1); };
  const treeId = one('tree'); const parentIds = headers.filter(line => line.startsWith('parent ')).map(line => line.slice(7));
  if (!isGitObjectId(treeId, repository.format) || parentIds.some(parent => !isGitObjectId(parent, repository.format))) throw corrupt();
  const body = data.subarray(boundary + 2); const messageTruncated = body.length > GIT_LIMITS.messageBytes;
  // Stream decoding omits a final partial UTF-8 sequence at the byte limit.
  let message: string;
  try { message = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body.subarray(0, GIT_LIMITS.messageBytes), { stream: messageTruncated }); }
  catch { throw new HttpError(422, 'This Git commit message uses an unsupported text encoding.', 'GIT_UNSUPPORTED_ENCODING'); }
  return { id, treeId, parentIds, author: person(one('author')), committer: person(one('committer')), message, messageTruncated };
}

async function readTree(repository: RepositoryHandle, id: string, path: string): Promise<GitTreeEntry[]> {
  const data = await rawObject(repository, id, 'tree'); const entries: GitTreeEntry[] = []; const hashLength = repository.format === 'sha256' ? 32 : 20; let offset = 0;
  while (offset < data.length) {
    if (entries.length >= GIT_LIMITS.treeEntries) throw limit();
    const space = data.indexOf(32, offset); const zero = data.indexOf(0, space + 1);
    if (space < offset || zero <= space + 1 || zero + hashLength >= data.length) throw corrupt();
    const modeBytes = data.subarray(offset, space);
    if (!modeBytes.length || !modeBytes.every(value => value >= 48 && value <= 55)) throw corrupt();
    const mode = modeBytes.toString('ascii').padStart(6, '0'); const name = utf8(data.subarray(space + 1, zero));
    if (!name || name.includes('/') || name === '.' || name === '..') throw corrupt();
    const fullPath = path ? `${path}/${name}` : name; if (!isGitPath(fullPath)) throw limit();
    const objectId = data.subarray(zero + 1, zero + 1 + hashLength).toString('hex');
    const type = mode === '040000' ? 'tree' : mode === '120000' ? 'symlink' : mode === '160000' ? 'submodule' : mode === '100644' || mode === '100755' ? 'file' : null;
    if (!type || entries.some(entry => entry.name === name)) throw corrupt();
    entries.push({ name, path: fullPath, objectId, mode, type, size: null }); offset = zero + 1 + hashLength;
  }
  return entries;
}

async function entryAt(repository: RepositoryHandle, commit: GitCommit, path: string): Promise<GitTreeEntry> {
  if (!path || !isGitPath(path)) throw invalid();
  const parts = path.split('/'); let tree = commit.treeId; let prefix = '';
  for (let index = 0; index < parts.length; index += 1) {
    checkAbort(repository.signal);
    const entry = (await readTree(repository, tree, prefix)).find(item => item.name === parts[index]);
    if (!entry) throw missing();
    if (index === parts.length - 1) return entry;
    if (entry.type !== 'tree') throw missing();
    tree = entry.objectId; prefix = entry.path;
  }
  throw missing();
}

async function objectSize(repository: RepositoryHandle, id: string): Promise<number> {
  const text = (await command(repository, ['cat-file', '-s', id])).toString('ascii').trim();
  if (!/^\d+$/.test(text)) throw missing(); const size = Number(text);
  if (!Number.isSafeInteger(size)) throw limit(); return size;
}

type ChangedEntries = Map<string, { before: GitComparisonEntry | null; after: GitComparisonEntry | null }>;
function comparisonQuery(query: GitComparisonQuery): void {
  if(!query || typeof query!=='object' || (query.base!==null&&(typeof query.base!=='string'||!isGitObjectId(query.base))) || typeof query.target!=='string'||!isGitObjectId(query.target))throw invalid();
}
async function changedEntries(repository:RepositoryHandle,beforeTree:string|null,afterTree:string):Promise<ChangedEntries> {
  const changed:ChangedEntries=new Map(),pending=[{before:beforeTree,after:afterTree as string|null,path:''}];let count=0;
  while(pending.length){
    checkAbort(repository.signal);const pair=pending.pop()!;if(pair.before===pair.after&&pair.path!=='')continue;
    const before=pair.before?await readTree(repository,pair.before,pair.path):[],after=pair.before===pair.after?before:pair.after?await readTree(repository,pair.after,pair.path):[];
    count+=before.length+after.length;if(count>GIT_LIMITS.comparisonEntries)throw limit();
    const left=new Map(before.map(entry=>[entry.name,entry])),right=new Map(after.map(entry=>[entry.name,entry]));
    for(const name of [...new Set([...left.keys(),...right.keys()])].sort()){
      const old=left.get(name)??null,next=right.get(name)??null;
      if(old?.objectId===next?.objectId&&old?.mode===next?.mode)continue;
      const path=(old??next)!.path;
      const entry=(value:GitTreeEntry|null):GitComparisonEntry|null=>value?{path:value.path,objectId:value.objectId,mode:value.mode,type:value.type,size:null}:null;
      changed.set(path,{before:entry(old),after:entry(next)});if(changed.size>GIT_LIMITS.comparisonChanges)throw limit();
      if(old?.type==='tree'||next?.type==='tree')pending.push({before:old?.type==='tree'?old.objectId:null,after:next?.type==='tree'?next.objectId:null,path});
    }
  }
  return changed;
}
async function preflightComparison(repository:RepositoryHandle,entries:ChangedEntries):Promise<void> {
  const sizes=new Map<string,number>();let bytes=0,sources=0,destinations=0;
  for(const pair of entries.values()){
    for(const [side,entry]of [['before',pair.before],['after',pair.after]]as const){
      checkAbort(repository.signal);if(!entry||entry.type==='tree'||entry.type==='submodule')continue;
      if(side==='before')sources++;else if(!pair.before||pair.before.type!==entry.type)destinations++;
      if(sources>GIT_LIMITS.comparisonCandidates||destinations>GIT_LIMITS.comparisonCandidates||sources*destinations>GIT_LIMITS.comparisonCandidatePairs)throw limit();
      let size=sizes.get(entry.objectId);
      if(size===undefined){
        size=await objectSize(repository,entry.objectId);if(size>GIT_LIMITS.comparisonBlobBytes||bytes+size>GIT_LIMITS.comparisonSourceBytes)throw limit();
        // Verify every source admitted to heuristic matching, without retaining
        // bodies in the inventory or trusting Git's object filename alone.
        const data=await rawObject(repository,entry.objectId,'blob',GIT_LIMITS.comparisonBlobBytes);if(data.length!==size)throw corrupt();sizes.set(entry.objectId,size);
      }
      bytes+=size;if(bytes>GIT_LIMITS.comparisonSourceBytes)throw limit();entry.size=size;
    }
  }
}
function comparisonChange(repositoryId:string,query:GitComparisonQuery,status:GitComparisonChange['status'],similarity:number|null,before:GitComparisonEntry|null,after:GitComparisonEntry|null):GitComparisonChange {
  const id=createHash('sha256').update(JSON.stringify(['git-comparison-v1',repositoryId,query.base,query.target,status,similarity,before,after])).digest('hex');
  return {id,status,similarity,before,after};
}
function parseComparison(repositoryId:string,query:GitComparisonQuery,repository:RepositoryHandle,data:Buffer,entries:ChangedEntries):GitComparisonChange[] {
  const fields=utf8(data).split('\0');if(fields.pop()!=='')throw corrupt();
  const changes:GitComparisonChange[]=[],oldCovered=new Set<string>(),newCovered=new Set<string>(),identities=new Set<string>();
  let index=0;
  while(index<fields.length){
    const header=/^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]+) ([0-9a-f]+) ([AMDTRC])([0-9]*)$/.exec(fields[index++]!);if(!header)throw corrupt();
    const oldMode=header[1]!,newMode=header[2]!,oldId=header[3]!,newId=header[4]!,code=header[5]!,score=header[6]!;
    const path=fields[index++],second=code==='R'||code==='C'?fields[index++]:path;
    if(!path||!second||!isGitPath(path)||!isGitPath(second))throw corrupt();
    const before=oldMode==='000000'?null:entries.get(path)?.before??null,after=newMode==='000000'?null:entries.get(second)?.after??null;
    const valid=(entry:GitComparisonEntry|null,mode:string,id:string)=>mode==='000000'?entry===null&&id==='0'.repeat(repository.format==='sha1'?40:64):!!entry&&entry.mode===mode&&entry.objectId===id;
    if(!valid(before,oldMode!,oldId!)||!valid(after,newMode!,newId!))throw corrupt();
    if((code==='A'&&(before!==null||after===null))||(code==='D'&&(before===null||after!==null))||(!['A','D'].includes(code!)&&(!before||!after)))throw corrupt();
    const similarity=score?Number(score):null;
    if((code==='R'||code==='C')?(similarity===null||similarity<0||similarity>100):similarity!==null)throw corrupt();
    if(after&&newCovered.has(after.path))throw corrupt();if(before)oldCovered.add(before.path);if(after)newCovered.add(after.path);
    const status=({A:'added',D:'deleted',M:'modified',T:'type_changed',R:'renamed',C:'copied'}as const)[code as 'A'|'D'|'M'|'T'|'R'|'C'];
    const change=comparisonChange(repositoryId,query,status,similarity,before,after);if(identities.has(change.id))throw corrupt();identities.add(change.id);changes.push(change);
    if(changes.length>GIT_LIMITS.comparisonChanges*2)throw limit();
  }
  // Git may infer moves/copies, but every changed source and destination must
  // remain accounted for. A partial parser result is never a successful diff.
  for(const [path,pair]of entries)if((pair.before&&!oldCovered.has(path))||(pair.after&&!newCovered.has(path)))throw corrupt();
  // Git emits file↔directory transitions as two records. Combine only an
  // actual deletion/addition at the same path; inferred moves retain their
  // distinct identities and descendants retain their own changed entries.
  const additions=new Map(changes.filter(change=>change.status==='added').map(change=>[change.after!.path,change]));
  const removed=new Set<GitComparisonChange>();
  for(const change of changes){
    if(change.status!=='deleted')continue;
    const addition=additions.get(change.before!.path);
    if(addition&&change.before!.type!==addition.after!.type){
      removed.add(change);removed.add(addition);
      changes.push(comparisonChange(repositoryId,query,'type_changed',null,change.before,addition.after));
    }
  }
  const complete=changes.filter(change=>!removed.has(change));
  if(complete.length>GIT_LIMITS.comparisonChanges)throw limit();return complete;
}
async function readComparison(repositoryId:string,query:GitComparisonQuery,repository:RepositoryHandle):Promise<GitComparison> {
  const targetCommit=await readCommit(repository,query.target),baseCommit=query.base?await readCommit(repository,query.base):null;
  const baseTreeId=baseCommit?.treeId??createHash(repository.format).update('tree 0\0').digest('hex'),targetTreeId=targetCommit.treeId;
  const entries=await changedEntries(repository,baseCommit?.treeId??null,targetTreeId);await preflightComparison(repository,entries);
  let changes:GitComparisonChange[];
  if(query.base===null)changes=[...entries.values()].map(pair=>comparisonChange(repositoryId,query,'added',null,null,pair.after));
  else if(!entries.size)changes=[];
  else {
    const raw=await command(repository,['diff-tree','--raw','-z','-r','-t','--no-commit-id','--no-abbrev','--no-ext-diff','--no-textconv','--no-color','--diff-algorithm=myers','--submodule=short','--ignore-submodules=none','-M50%','-C50%',`-l${GIT_LIMITS.comparisonCandidates}`,baseTreeId,targetTreeId,'--']);
    changes=parseComparison(repositoryId,query,repository,raw,entries);
  }
  changes.sort((left,right)=>{const a=left.after?.path??left.before!.path,b=right.after?.path??right.before!.path;return a<b?-1:a>b?1:left.id<right.id?-1:left.id>right.id?1:0;});
  const result:GitComparison={repositoryId,objectFormat:repository.format,baseCommit,targetCommit,baseTreeId,targetTreeId,algorithm:'git-M50-C50',changes};
  if(Buffer.byteLength(JSON.stringify(result))>GIT_LIMITS.outputBytes)throw limit();return result;
}
async function comparisonSide(repositoryId:string,commitId:string,entry:GitComparisonEntry,repository:RepositoryHandle):Promise<GitComparisonSide> {
  const identity={repositoryId,objectFormat:repository.format,commitId,path:entry.path,objectId:entry.objectId,mode:entry.mode};
  if(entry.type==='tree')return {...identity,state:'tree',size:null};
  if(entry.type==='submodule')return {...identity,state:'submodule',size:null};
  const data=await rawObject(repository,entry.objectId,'blob',GIT_LIMITS.comparisonBlobBytes);if(data.length!==entry.size)throw corrupt();
  const common={...identity,size:data.length};
  if(entry.type==='symlink')return {...common,state:'symlink'};
  if(data.length>GIT_LIMITS.blobBytes)return {...common,state:'oversized'};
  if(data.includes(0))return {...common,state:'binary'};
  try{return {...common,state:'text',content:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(data)};}catch{return {...common,state:'unsupported_encoding'};}
}

class LocalGitObserver implements GitObserver {
  private readonly gate = new Gate();
  private readonly bindings: Readonly<Record<string, string>>;
  constructor(bindings: Readonly<Record<string, string>>) { this.bindings = parseGitRepositories(JSON.stringify(bindings)); }
  private async observe<T>(id: string, signal: AbortSignal | undefined, work: (repository: RepositoryHandle) => Promise<T>): Promise<T> {
    if (!Object.hasOwn(this.bindings, id)) throw unavailable();
    const timeout = new AbortController(); let expired = false;
    const timer = setTimeout(() => { expired = true; timeout.abort(); }, GIT_LIMITS.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal; let release: Permit | undefined;
    try {
      release = await this.gate.acquire(combined);
      const repository = await inspectRepository(this.bindings[id]!, combined);
      const result = await work(repository); checkAbort(combined); return result;
    } catch (error) { if (expired && !signal?.aborted) throw limit(); throw error; }
    finally { clearTimeout(timer); release?.(); }
  }
  async info(id: string, signal?: AbortSignal): Promise<GitObserverInfo> {
    if (!Object.hasOwn(this.bindings, id)) return { state: 'unconfigured', message: 'A local Git observer has not been configured for this repository.' };
    try { return await this.observe(id, signal, async repository => ({ state: 'ready', objectFormat: repository.format })); }
    catch (error) { if (signal?.aborted || (error instanceof HttpError && error.code === 'GIT_ABORTED')) throw error; return { state: 'unavailable', message: 'The local Git repository is unavailable or its configuration is unsupported.' }; }
  }
  async refs(id: string, signal?: AbortSignal): Promise<GitRefs> {
    return this.observe(id, signal, async repository => {
      const data = await command(repository, ['for-each-ref', `--count=${GIT_LIMITS.refs + 1}`, '--sort=refname', '--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)', 'refs/heads/', 'refs/tags/']);
      const lines = utf8(data).split('\n').filter(Boolean); if (lines.length > GIT_LIMITS.refs) throw limit();
      const refs: GitRefs['refs'] = [];
      for (const line of lines) {
        const fields = line.split('\0'); if (fields.length !== 5) throw missing();
        const [name, objectId, type, peeled, peeledType] = fields as [string, string, string, string, string];
        if (!isGitObjectId(objectId, repository.format) || (!name.startsWith('refs/heads/') && !name.startsWith('refs/tags/'))) throw missing();
        let commitId = type === 'commit' ? objectId : type === 'tag' && peeledType === 'commit' ? peeled : null;
        if (type === 'tag' && peeledType === 'tag') {
          let current = objectId;
          for (let depth = 0; depth < 16; depth += 1) {
            const tag = utf8(await rawObject(repository, current, 'tag')); const target = /^object ([0-9a-f]+)\ntype (commit|tag|tree|blob)\n/.exec(tag);
            if (!target || !isGitObjectId(target[1]!, repository.format)) throw missing();
            if (target[2] === 'commit') { commitId = target[1]!; break; }
            if (target[2] !== 'tag') break;
            if (depth === 15) throw limit(); current = target[1]!;
          }
        }
        if (commitId !== null && !isGitObjectId(commitId, repository.format)) throw missing();
        refs.push({ name, kind: name.startsWith('refs/heads/') ? 'branch' : 'tag', objectId, commitId });
      }
      const head = utf8((await boundedFile(join(repository.path, 'HEAD'), 4096))!).trim();
      let headCommit = head.startsWith('ref: ') ? refs.find(ref => ref.name === head.slice(5))?.commitId ?? null : null;
      if (isGitObjectId(head, repository.format)) {
        const type = await run(['--git-dir', repository.path, 'cat-file', '-t', head], repository.signal);
        if (type.code === 0 && type.data.toString('ascii').trim() === 'commit') headCommit = head;
      }
      return { repositoryId: id, objectFormat: repository.format, observedAt: new Date().toISOString(), headCommit, refs };
    });
  }
  async commit(id: string, commit: string, signal?: AbortSignal): Promise<GitCommitResult> {
    if (!isGitObjectId(commit)) throw invalid();
    return this.observe(id, signal, async repository => ({ repositoryId: id, objectFormat: repository.format, commit: await readCommit(repository, commit) }));
  }
  async tree(id: string, commit: string, path: string, signal?: AbortSignal): Promise<GitTree> {
    if (!isGitObjectId(commit) || !isGitPath(path)) throw invalid();
    return this.observe(id, signal, async repository => {
      const source = await readCommit(repository, commit); const entry = path ? await entryAt(repository, source, path) : null;
      if (entry && entry.type !== 'tree') throw missing(); const treeId = entry?.objectId ?? source.treeId;
      return { repositoryId: id, objectFormat: repository.format, commitId: commit, path, treeId, entries: await readTree(repository, treeId, path) };
    });
  }
  async blob(id: string, commit: string, path: string, signal?: AbortSignal): Promise<GitBlob> {
    if (!isGitObjectId(commit) || !path || !isGitPath(path)) throw invalid();
    return this.observe(id, signal, async repository => {
      const source = await readCommit(repository, commit); const entry = await entryAt(repository, source, path);
      if (entry.type === 'tree') throw missing();
      const common = { repositoryId: id, objectFormat: repository.format, commitId: commit, path, objectId: entry.objectId, mode: entry.mode };
      if (entry.type === 'submodule') return { ...common, size: null, state: 'submodule' };
      const size = await objectSize(repository, entry.objectId);
      const identity = { ...common, size };
      if (entry.type === 'symlink') return { ...identity, state: 'symlink' };
      if (size > GIT_LIMITS.blobBytes) return { ...identity, state: 'oversized' };
      const data = await rawObject(repository, entry.objectId, 'blob'); if (data.length !== size) throw missing();
      if (data.includes(0)) return { ...identity, state: 'binary' };
      try { return { ...identity, state: 'text', content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data) }; }
      catch { return { ...identity, state: 'unsupported_encoding' }; }
    });
  }
  async history(id: string, query: GitHistoryQuery, signal?: AbortSignal): Promise<GitHistory> {
    const path = query.path ?? ''; const after = query.after ?? 0; const page = query.limit ?? GIT_LIMITS.historyDefault;
    if (!isGitObjectId(query.commit) || !isGitPath(path) || !Number.isSafeInteger(after) || after < 0 || after > GIT_LIMITS.historyOffset || !Number.isSafeInteger(page) || page < 1 || page > GIT_LIMITS.historyPage) throw invalid();
    return this.observe(id, signal, async repository => {
      await readCommit(repository, query.commit);
      const data = await command(repository, ['rev-list', '--date-order', `--skip=${after}`, `--max-count=${page + 1}`, query.commit, '--', ...(path ? [path] : [])]);
      const identifiers = data.toString('ascii').split('\n').filter(Boolean);
      if (identifiers.some(value => !isGitObjectId(value, repository.format)) || new Set(identifiers).size !== identifiers.length || identifiers.length > page + 1) throw missing();
      if (identifiers.length > page && after + page > GIT_LIMITS.historyOffset) throw limit();
      const commits: GitCommit[] = []; let resultBytes = 0;
      for (const value of identifiers.slice(0, page)) {
        const commit = await readCommit(repository, value); resultBytes += Buffer.byteLength(JSON.stringify(commit));
        if (resultBytes > GIT_LIMITS.outputBytes) throw limit();
        commits.push(commit);
      }
      return { repositoryId: id, objectFormat: repository.format, commitId: query.commit, path, commits, nextAfter: identifiers.length > page ? after + page : null };
    });
  }
  async compare(id:string,query:GitComparisonQuery,signal?:AbortSignal):Promise<GitComparison> {
    comparisonQuery(query);return this.observe(id,signal,repository=>readComparison(id,query,repository));
  }
  async compareFile(id:string,query:GitComparisonFileQuery,signal?:AbortSignal):Promise<GitComparisonFile> {
    comparisonQuery(query);
    if((query.beforePath!==null&&(typeof query.beforePath!=='string'||!query.beforePath||!isGitPath(query.beforePath)))||(query.afterPath!==null&&(typeof query.afterPath!=='string'||!query.afterPath||!isGitPath(query.afterPath)))||(query.beforePath===null&&query.afterPath===null)||(query.base===null&&query.beforePath!==null))throw invalid();
    return this.observe(id,signal,async repository=>{
      const comparison=await readComparison(id,query,repository),change=comparison.changes.find(item=>(item.before?.path??null)===query.beforePath&&(item.after?.path??null)===query.afterPath);
      if(!change)throw missing();
      const before=change.before?await comparisonSide(id,query.base!,change.before,repository):null,after=change.after?await comparisonSide(id,query.target,change.after,repository):null;
      const {changes:_changes,algorithm:_algorithm,...identity}=comparison;const result:GitComparisonFile={...identity,change,before,after};
      if(Buffer.byteLength(JSON.stringify(result))>GIT_LIMITS.outputBytes)throw limit();return result;
    });
  }
  async importSnapshot(id: string, commit: string, signal?: AbortSignal): Promise<GitImportSnapshot> {
    if (!isGitObjectId(commit)) throw invalid();
    return this.observe(id, signal, async repository => {
      const source = await readCommit(repository, commit);
      const pending = [{ objectId: source.treeId, path: '' }];
      const leaves: (GitTreeEntry & { mode: '100644' | '100755' })[] = []; let entryCount = 0;
      while (pending.length) {
        checkAbort(repository.signal);
        const tree = pending.pop()!; const entries = await readTree(repository, tree.objectId, tree.path);
        // A file-only snapshot cannot faithfully represent an empty Git subtree.
        if (!entries.length) throw unsupportedImport();
        entryCount += entries.length; if (entryCount > GIT_LIMITS.treeEntries) throw limit();
        for (const entry of entries) {
          if (entry.type === 'tree') pending.push(entry);
          else if (entry.type === 'file' && (entry.mode === '100644' || entry.mode === '100755')) {
            leaves.push({ ...entry, mode: entry.mode }); if (leaves.length > 100) throw limit();
          } else throw unsupportedImport();
        }
      }
      leaves.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
      // Validate all paths before loading any file bodies; do not expose rejected names in diagnostics.
      try { files(leaves.map(entry => ({ path: entry.path, content: '' }))); }
      catch { throw unsupportedImport(); }
      const collected: SourceFile[] = []; const contents = new Map<string, { size: number; content: string }>(); let bytes = 0;
      for (const entry of leaves) {
        checkAbort(repository.signal);
        const cached = contents.get(entry.objectId);
        const size = cached?.size ?? await objectSize(repository, entry.objectId);
        bytes += size; if (size > GIT_LIMITS.blobBytes || bytes > 1_500_000) throw limit();
        if (cached) { collected.push({ path: entry.path, content: cached.content }); continue; }
        const data = await rawObject(repository, entry.objectId, 'blob'); if (data.length !== size) throw corrupt();
        if (data.includes(0)) throw unsupportedImport();
        let content: string;
        try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); }
        catch { throw unsupportedImport(); }
        contents.set(entry.objectId, { size, content });
        collected.push({ path: entry.path, content });
      }
      let validated: SourceFile[];
      try { validated = files(collected); } catch { throw unsupportedImport(); }
      checkAbort(repository.signal);
      return {
        repositoryId: id, objectFormat: repository.format, files: validated,
        provenance: {
          kind: 'git', repositoryId: id, objectFormat: repository.format, commitId: commit,
          treeId: source.treeId, scope: 'complete-text-tree',
          manifest: leaves.map(({ path, mode, objectId }) => ({ path, mode, objectId })),
        },
      };
    });
  }
}

export function createGitObserver(bindings: Readonly<Record<string, string>> = {}): GitObserver { return new LocalGitObserver(bindings); }
