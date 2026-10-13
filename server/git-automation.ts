import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import type { GitAutomationObject, GitReceiveCommit, GitReceiveFacts, GitReceiveFile, GitReceiveFileInspection, GitReceiveObject, GitReceiveReceipt, GitReceiveUpdate } from '../shared/git-automation.ts';
import type { HeraldAction, HeraldRule, HeraldSnapshot, HeraldTranscript } from '../shared/herald.ts';
import { isGitObjectId, isGitPath, type GitCommitResult, type GitObjectFormat, type GitPerson } from '../shared/repositories.ts';
import type { HeraldHooks, HeraldStore } from './herald.ts';
import { HttpError } from './validation.ts';

export interface GitAutomationHooks extends HeraldHooks {
  /** Recheck configured receiver, active pusher, and repository edit permission.
   * The caller closes over the authenticated receiver; facts cannot select it. */
  canReceive: (facts: GitReceiveFacts) => boolean;
  projectIds: (repositoryId: string) => string[];
}
let serial = 0;
function transaction<T>(db: DatabaseSync, work: () => T): T {
  const name = `git_automation_${++serial}`; db.exec(`SAVEPOINT ${name}`);
  try { const result = work(); db.exec(`RELEASE ${name}`); return result; }
  catch (error) { db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
}
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bad = (message = 'An exact, complete receive-hook inspection is required.') => new HttpError(400, message, 'GIT_RECEIVE_INVALID');
const integrity = () => new HttpError(409, 'Git automation evidence cannot be verified.', 'GIT_AUTOMATION_INTEGRITY');
const unavailable = () => new HttpError(404, 'Git automation evidence is unavailable.', 'GIT_AUTOMATION_UNAVAILABLE');
function object(value: unknown, keys: string[]): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw bad(); return value as Record<string, unknown>; }
function text(value: unknown, maximum: number, empty = false): string { if (typeof value !== 'string' || !empty && !value.length || value.length > maximum || /[\u0000\uD800-\uDFFF]/u.test(value)) throw bad(); return value; }
function oid(value: unknown, format: GitObjectFormat): string { if (typeof value !== 'string' || !isGitObjectId(value, format) || /^0+$/.test(value)) throw bad('Receive facts require full nonzero Git object IDs.'); return value; }
function optionalOid(value: unknown, format: GitObjectFormat): string | null { return value === null ? null : oid(value, format); }
function person(value: unknown): GitPerson {
  const input = object(value, ['name', 'email', 'timestamp']), timestamp = text(input.timestamp, 100);
  if (!Number.isFinite(Date.parse(timestamp))) throw bad('Commit identity timestamps must be complete.');
  return { name: text(input.name, 20_000, true), email: text(input.email, 20_000, true), timestamp };
}
function fileInspection(value: unknown, format: GitObjectFormat): GitReceiveFileInspection {
  const input=object(value,['kind','old','new']);
  if(!['text','binary','non-utf8','too-large','gitlink'].includes(String(input.kind)))throw bad('Choose a complete Git file inspection status.');
  const side=(value:unknown):GitReceiveObject|null=>{
    if(value===null)return null;const item=object(value,['id','mode','bytes']);
    if(!['100644','100755','120000','160000'].includes(String(item.mode))||(item.mode==='160000'?item.bytes!==null:!Number.isSafeInteger(item.bytes)||Number(item.bytes)<0))throw bad('Git file inspections require exact modes and nonnegative byte sizes; only gitlinks omit size.');
    return {id:oid(item.id,format),mode:item.mode as GitReceiveObject['mode'],bytes:item.bytes as number|null};
  };
  const old=side(input.old),next=side(input.new),gitlink=old?.mode==='160000'||next?.mode==='160000';
  if(!old&&!next||old&&next&&old.id===next.id&&old.mode===next.mode||gitlink!==(input.kind==='gitlink'))throw bad('Contradictory changed-file inspection metadata.');
  return {kind:input.kind as GitReceiveFileInspection['kind'],old,new:next};
}
function commit(value: unknown, format: GitObjectFormat): GitReceiveCommit {
  const input = object(value, ['commit', 'files', 'inspectionComplete']);
  if (input.inspectionComplete !== true || !Array.isArray(input.files)) throw bad();
  const source = object(input.commit, ['id', 'treeId', 'parentIds', 'author', 'committer', 'message', 'messageTruncated']);
  if (source.messageTruncated !== false || !Array.isArray(source.parentIds)) throw bad('Truncated commit messages cannot be used for enforcement.');
  const parentIds = source.parentIds.map(value => oid(value, format)); if (new Set(parentIds).size !== parentIds.length) throw bad();
  const files = input.files.map((value):GitReceiveFile => {
    const file = object(value, ['path', 'content', 'added', 'removed', 'inspection']), path = text(file.path, 4_096);
    if (!isGitPath(path)) throw bad('Invalid Git tree path.');
    const result:GitReceiveFile={path,content:text(file.content,8*1024*1024,true),added:text(file.added,8*1024*1024,true),removed:text(file.removed,8*1024*1024,true)};
    // Historical facts remain byte-for-byte in their original generation.
    // In particular, absent inspection metadata is not rewritten as defaults.
    if(Object.hasOwn(file,'inspection')){
      const inspection=fileInspection(file.inspection,format);result.inspection=inspection;
      if(inspection.kind!=='text'&&(result.content!==''||result.added!==''||result.removed!==''))throw bad('Unavailable Git text must not carry partial or placeholder content.');
      if(inspection.kind==='text'&&(!result.content||(!inspection.new||inspection.new.bytes===0)&&result.added!==''||(!inspection.old||inspection.old.bytes===0)&&result.removed!==''))throw bad('Captured Git text contradicts its changed-file metadata.');
      if(!parentIds.length&&inspection.old!==null)throw bad('A root commit cannot have an old file side.');
    }
    return result;
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (new Set(files.map(file => file.path)).size !== files.length) throw bad('Commit inspection contains duplicate paths.');
  if(files.some(file=>Boolean(file.inspection))&&files.some(file=>!file.inspection))throw bad('All changed files in a commit must use the same inspection generation.');
  return { inspectionComplete: true, commit: { id: oid(source.id, format), treeId: oid(source.treeId, format), parentIds, author: person(source.author), committer: person(source.committer), message: text(source.message, 8 * 1024 * 1024, true), messageTruncated: false }, files };
}
function sameCommitObservation(left:GitReceiveCommit|null,right:GitReceiveCommit|null):boolean {
  if(!left||!right)return left===right;
  if(!isDeepStrictEqual(left.commit,right.commit)||left.inspectionComplete!==right.inspectionComplete||left.files.length!==right.files.length)return false;
  return left.files.every((file,index)=>{
    const other=right.files[index]!;if(file.path!==other.path)return false;
    if(file.inspection&&other.inspection){
      if(!isDeepStrictEqual(file.inspection.old,other.inspection.old)||!isDeepStrictEqual(file.inspection.new,other.inspection.new))return false;
      if(file.inspection.kind!==other.inspection.kind)return file.inspection.kind==='too-large'||other.inspection.kind==='too-large';
      return isDeepStrictEqual(file,other);
    }
    // A collector generation can change its literal patch formatting. Git's
    // immutable commit identity and complete changed paths remain unchanged;
    // retain the first observation rather than rewriting or rerunning builds.
    return Boolean(file.inspection)!==Boolean(other.inspection)||isDeepStrictEqual(file,other);
  });
}
export function parseGitReceiveFacts(value: unknown): GitReceiveFacts {
  const input = object(value, ['repositoryId', 'objectFormat', 'phase', 'requestId', 'pusherId', 'inspectionComplete', 'updates']);
  if (input.inspectionComplete !== true || !['sha1', 'sha256'].includes(String(input.objectFormat)) || !['pre', 'post'].includes(String(input.phase)) || !Array.isArray(input.updates) || !input.updates.length) throw bad();
  const repositoryId = text(input.repositoryId, 100), format = input.objectFormat as GitObjectFormat;
  if (!/^R[1-9]\d{0,14}$/.test(repositoryId)) throw bad('Select a repository.');
  const updates: GitReceiveUpdate[] = input.updates.map(value => {
    const update = object(value, ['refName', 'oldId', 'newId', 'oldCommitId', 'newCommitId', 'forced', 'commits']);
    const refName = text(update.refName, 4_096);
    if (!/^refs\/(?:heads|tags)\/.+/.test(refName) || /[\x00-\x20\x7f~^:?*\[\\]/.test(refName) || refName.includes('..') || refName.includes('@{') || refName.endsWith('.') || refName.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock'))) throw bad('Only complete branch and tag ref names are supported.');
    if (typeof update.forced !== 'boolean' || !Array.isArray(update.commits)) throw bad();
    const oldId = optionalOid(update.oldId, format), newId = optionalOid(update.newId, format), oldCommitId = optionalOid(update.oldCommitId, format), newCommitId = optionalOid(update.newCommitId, format);
    if (oldId === newId || oldId === null && oldCommitId !== null || newId === null && newCommitId !== null || newCommitId === null && update.commits.length || update.forced && (oldId === null || newId === null)) throw bad('Inconsistent ref update facts.');
    if (refName.startsWith('refs/heads/') && (oldId !== oldCommitId || newId !== newCommitId)) throw bad('Branch refs must point directly to commits.');
    const commits = update.commits.map(value => commit(value, format)).sort((a, b) => a.commit.id.localeCompare(b.commit.id));
    if (new Set(commits.map(value => value.commit.id)).size !== commits.length) throw bad('Receive inspection contains duplicate commits within a ref.');
    return { refName, oldId, newId, oldCommitId, newCommitId, forced: update.forced, commits };
  }).sort((a, b) => a.refName < b.refName ? -1 : a.refName > b.refName ? 1 : 0);
  if (new Set(updates.map(value => value.refName)).size !== updates.length) throw bad('Receive inspection contains duplicate ref updates.');
  const unique = new Map<string, string>();
  for (const update of updates) for (const source of update.commits) { const fingerprint = hash(source), previous = unique.get(source.commit.id); if (previous && previous !== fingerprint) throw bad('The same commit has inconsistent inspection facts.'); unique.set(source.commit.id, fingerprint); }
  const objects=new Map<string,{type:'blob'|'commit';bytes:number|null}>();
  for(const update of updates)for(const source of update.commits)for(const file of source.files)for(const side of [file.inspection?.old,file.inspection?.new])if(side){const value={type:side.mode==='160000'?'commit' as const:'blob' as const,bytes:side.bytes},known=objects.get(side.id);if(known&&!isDeepStrictEqual(known,value))throw bad('The same Git object has contradictory type or byte-size metadata.');objects.set(side.id,value);}
  return { repositoryId, objectFormat: format, phase: input.phase as 'pre' | 'post', requestId: text(input.requestId, 200), pusherId: text(input.pusherId, 200), inspectionComplete: true, updates };
}

export function initializeGitAutomation(db: DatabaseSync): void {
  transaction(db, () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS git_automation_objects(id TEXT PRIMARY KEY,repository_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN('commit','push-ref','push-content')),source_hash TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),CHECK(json_extract(data,'$.id')=id AND json_extract(data,'$.repositoryId')=repository_id AND json_extract(data,'$.kind')=kind));
      CREATE INDEX IF NOT EXISTS git_automation_objects_repository ON git_automation_objects(repository_id);
      CREATE TABLE IF NOT EXISTS git_receive_records(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,repository_id TEXT NOT NULL,phase TEXT NOT NULL CHECK(phase IN('pre','post')),request_id TEXT NOT NULL,facts_hash TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),UNIQUE(repository_id,phase,request_id),CHECK(json_extract(data,'$.receipt.id')=id AND json_extract(data,'$.receipt.repositoryId')=repository_id AND json_extract(data,'$.receipt.phase')=phase AND json_extract(data,'$.receipt.requestId')=request_id));
      CREATE INDEX IF NOT EXISTS git_receive_records_repository ON git_receive_records(repository_id,sequence);
    `);
    for (const table of ['git_automation_objects', 'git_receive_records']) db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Git automation evidence is immutable'); END; CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Git automation evidence is immutable'); END;`);
    for (const [table, columns] of Object.entries({ git_automation_objects: ['id', 'repository_id', 'kind', 'source_hash', 'data'], git_receive_records: ['sequence', 'id', 'repository_id', 'phase', 'request_id', 'facts_hash', 'data'] })) if (!isDeepStrictEqual((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name), columns)) throw new Error(`Unexpected ${table} schema.`);
  });
}
function json<T>(value: string): T { try { return JSON.parse(value) as T; } catch { throw integrity(); } }
interface SavedReceive { facts: GitReceiveFacts; receipt: GitReceiveReceipt }
export class GitAutomationStore {
  constructor(private readonly database: DatabaseSync, private readonly herald: HeraldStore) {}
  policyObjectId(id: string): string | null { return (this.database.prepare('SELECT repository_id FROM git_automation_objects WHERE id=?').get(id) as { repository_id: string } | undefined)?.repository_id ?? null; }
  private object(id: string): GitAutomationObject {
    const row = this.database.prepare('SELECT repository_id,kind,source_hash,data FROM git_automation_objects WHERE id=?').get(id) as { repository_id: string; kind: string; source_hash: string; data: string } | undefined;
    if (!row) throw unavailable(); const value = json<GitAutomationObject>(row.data);
    if (value.id !== id || value.repositoryId !== row.repository_id || value.kind !== row.kind || value.snapshot?.objectId !== id || value.snapshot.repositoryId !== row.repository_id || value.snapshot.contentType !== row.kind || hash(value) !== row.source_hash) throw integrity();
    return value;
  }
  snapshot(id: string): HeraldSnapshot { return this.object(id).snapshot; }
  commit(id: string): GitCommitResult { const source = this.object(id); if (!source.commit || source.kind !== 'commit') throw unavailable(); return { repositoryId: source.repositoryId, objectFormat: source.objectFormat, commit: source.commit.commit }; }
  private save(value: GitAutomationObject): { object: GitAutomationObject; fresh: boolean } {
    if (this.policyObjectId(value.id)) {
      const existing = this.object(value.id);
      // Branch context and pusher are observations; immutable Git source must
      // agree across every ref and repeated discovery of the same commit.
      if (existing.repositoryId !== value.repositoryId || existing.objectFormat !== value.objectFormat || existing.kind !== value.kind || !sameCommitObservation(existing.commit,value.commit) || value.kind !== 'commit' && !isDeepStrictEqual(existing, value)) throw new HttpError(409, 'This Git subject was already inspected with different facts.', 'GIT_RECEIVE_CHANGED');
      return { object: existing, fresh: false };
    }
    this.database.prepare('INSERT INTO git_automation_objects(id,repository_id,kind,source_hash,data) VALUES(?,?,?,?,?)').run(value.id, value.repositoryId, value.kind, hash(value), JSON.stringify(value)); return { object: value, fresh: true };
  }
  private readReceipt(id: string): GitReceiveReceipt {
    const row = this.database.prepare('SELECT repository_id,phase,request_id,facts_hash,data FROM git_receive_records WHERE id=?').get(id) as { repository_id: string; phase: string; request_id: string; facts_hash: string; data: string } | undefined;
    if (!row) throw unavailable(); const saved = json<SavedReceive>(row.data);
    if (!saved.receipt || saved.receipt.id !== id || saved.receipt.repositoryId !== row.repository_id || saved.receipt.phase !== row.phase || saved.receipt.requestId !== row.request_id || hash(saved.facts) !== row.facts_hash) throw integrity(); return saved.receipt;
  }
  receipt(id: string, canViewRepository: (id: string) => boolean): GitReceiveReceipt {
    const row = this.database.prepare('SELECT repository_id FROM git_receive_records WHERE id=?').get(id) as { repository_id: string } | undefined;
    if (!row || !canViewRepository(row.repository_id)) throw unavailable(); return this.readReceipt(id);
  }
  receipts(query: { repositoryId?: string; before?: number; limit?: number } = {}, canViewRepository: (id: string) => boolean): { receipts: GitReceiveReceipt[]; nextBefore: number | null } {
    const cursor = query.before ?? Number.MAX_SAFE_INTEGER, size = query.limit ?? 50;
    if (!Number.isSafeInteger(cursor) || cursor < 1 || !Number.isSafeInteger(size) || size < 1 || size > 100) throw bad('Choose a valid receive cursor and page size from 1 to 100.');
    const rows = this.database.prepare('SELECT sequence,id,repository_id FROM git_receive_records WHERE sequence<? AND (? IS NULL OR repository_id=?) ORDER BY sequence DESC LIMIT 1001').all(cursor, query.repositoryId ?? null, query.repositoryId ?? null) as { sequence: number; id: string; repository_id: string }[];
    const receipts: GitReceiveReceipt[] = []; let scanned = 0;
    for (const row of rows.slice(0, 1000)) { if (receipts.length === size) break; scanned++; if (canViewRepository(row.repository_id)) receipts.push(this.readReceipt(row.id)); }
    return { receipts, nextBefore: scanned < rows.length ? rows[scanned - 1]!.sequence : null };
  }
  receive(input: unknown, hooks: GitAutomationHooks): GitReceiveReceipt {
    const facts = parseGitReceiveFacts(input), fingerprint = hash(facts), receiptId = `GREC-${hash([facts.repositoryId, facts.phase, facts.requestId])}`;
    return transaction(this.database, () => {
      if (!hooks.canReceive(facts)) throw new HttpError(403, 'This receiver cannot submit inspection facts for the selected pusher and repository.', 'GIT_RECEIVE_FORBIDDEN');
      const existing = this.database.prepare('SELECT facts_hash FROM git_receive_records WHERE id=?').get(receiptId) as { facts_hash: string } | undefined;
      if (existing) { if (existing.facts_hash !== fingerprint) throw new HttpError(409, 'This receive event was already recorded with different facts.', 'GIT_RECEIVE_CHANGED'); return this.readReceipt(receiptId); }
      const projectIds = [...new Set(hooks.projectIds(facts.repositoryId))].sort(); if (projectIds.some(id => !/^PROJ[1-9]\d{0,14}$/.test(id))) throw integrity();
      const eventId = `git-receive:${hash([facts.repositoryId, facts.phase, facts.requestId])}`, subjects: GitAutomationObject[] = [];
      const base = (objectId: string, contentType: 'commit' | 'push-ref' | 'push-content'): HeraldSnapshot => ({ objectId, eventId, contentType, actorId: facts.pusherId, isNew: true, title: '', body: '', comment: '', status: '', priority: null, authorId: null, ownerId: null, repositoryId: facts.repositoryId, projectIds: [...projectIds], subscriberIds: [], reviewerIds: [], files: [], version: 1, versionId: null, contentHash: null, git: { commitId: null, refName: null, refType: null, refChange: null, forced: false, isMerge: false, authorRaw: '', committerRaw: '', branches: [], diffAdded: [], diffRemoved: [] } });
      if (facts.phase === 'pre') for (const update of facts.updates) {
        const id = `GR-${hash([facts.repositoryId, facts.requestId, update.refName])}`, snapshot = base(id, 'push-ref');
        snapshot.title = update.refName; snapshot.versionId = update.newId; snapshot.contentHash = hash(update); snapshot.isNew = update.oldId === null;
        snapshot.git = { ...snapshot.git!, refName: update.refName, refType: update.refName.startsWith('refs/heads/') ? 'branch' : 'tag', refChange: update.oldId === null ? 'create' : update.newId === null ? 'delete' : 'update', forced: update.forced };
        subjects.push({ id, repositoryId: facts.repositoryId, kind: 'push-ref', snapshot, commit: null, objectFormat: facts.objectFormat });
      }
      const commits = new Map<string, GitReceiveCommit>();
      for (const update of facts.updates) for (const source of update.commits) commits.set(source.commit.id, source);
      for (const source of [...commits.values()].sort((a, b) => a.commit.id.localeCompare(b.commit.id))) {
        const kind = facts.phase === 'pre' ? 'push-content' : 'commit', id = kind === 'commit' ? `GC-${hash([facts.repositoryId, source.commit.id])}` : `GP-${hash([facts.repositoryId, facts.requestId, source.commit.id])}`, snapshot = base(id, kind);
        const branches = facts.updates.filter(update => update.refName.startsWith('refs/heads/') && update.commits.some(item => item.commit.id === source.commit.id)).map(update => update.refName.slice('refs/heads/'.length));
        snapshot.title = source.commit.message.split('\n')[0] ?? ''; snapshot.body = source.commit.message; snapshot.files = source.files.map(file => ({ path: file.path, content: file.content })); snapshot.versionId = source.commit.id; snapshot.contentHash = hash(source);
        snapshot.git = { ...snapshot.git!, commitId: source.commit.id, isMerge: source.commit.parentIds.length > 1, authorRaw: `${source.commit.author.name} <${source.commit.author.email}>`, committerRaw: `${source.commit.committer.name} <${source.commit.committer.email}>`, branches, diffAdded: source.files.map(file => ({ path: file.path, content: file.added })), diffRemoved: source.files.map(file => ({ path: file.path, content: file.removed })) };
        if(source.files.some(file=>file.inspection))snapshot.git.fileInspection=source.files.map(file=>({path:file.path,...file.inspection!}));
        subjects.push({ id, repositoryId: facts.repositoryId, kind, snapshot, commit: source, objectFormat: facts.objectFormat });
      }
      // Publish all exact subjects before effects, so commit builds resolve the
      // verified source. No effect can change another rule's input snapshot.
      const saved = subjects.map(subject => this.save(subject)), transcripts: HeraldTranscript[] = [];
      const wrapped: HeraldHooks = { ...hooks, canApply: (rule, action, snapshot) => (facts.phase === 'pre' ? action.type === 'block-push' || action.type === 'nothing' : action.type === 'run-build-plans' || action.type === 'nothing') && hooks.canApply(rule, action, snapshot), apply: (rule: HeraldRule, action: HeraldAction, snapshot: HeraldSnapshot) => {
        if (facts.phase === 'pre' && action.type === 'block-push') return { changed: true, message: action.value };
        return hooks.apply(rule, action, snapshot);
      } };
      for (const source of saved) if (source.fresh) transcripts.push(this.herald.evaluate(source.object.snapshot, wrapped));
      const reasons: string[] = [];
      if (facts.phase === 'pre') for (const transcript of transcripts) {
        for (const action of transcript.actions) if (action.action.type === 'block-push' && action.status === 'applied') reasons.push(action.action.value);
        if (transcript.rules.some(rule => rule.status === 'error') || transcript.actions.some(action => action.status === 'error' || action.status === 'forbidden')) reasons.push('A push rule could not be safely evaluated. Inspect the Herald transcript before retrying.');
      }
      if (!hooks.canReceive(facts)) throw new HttpError(403, 'Receive authority changed while evaluating rules.', 'GIT_RECEIVE_FORBIDDEN');
      const receipt: GitReceiveReceipt = { id: receiptId, repositoryId: facts.repositoryId, phase: facts.phase, requestId: facts.requestId, allowed: reasons.length === 0, reasons: [...new Set(reasons)], transcriptIds: transcripts.map(value => value.id), commitIds: saved.filter(value => value.object.kind === 'commit').map(value => value.object.id), createdAt: new Date().toISOString() };
      this.database.prepare('INSERT INTO git_receive_records(id,repository_id,phase,request_id,facts_hash,data) VALUES(?,?,?,?,?,?)').run(receipt.id, facts.repositoryId, facts.phase, facts.requestId, fingerprint, JSON.stringify({ facts, receipt } satisfies SavedReceive)); return receipt;
    });
  }
}
