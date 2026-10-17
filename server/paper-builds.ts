import { isDeepStrictEqual } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AuthContext } from '../shared/auth.ts';
import type { PaperArtifactKind, PaperBuild, PaperBuildArtifact, PaperBuildConfiguration, PaperBuildDiagnostic, PaperBuildInput, PaperBuildPage, PaperSyncTeX, PaperSyncTeXMap, PaperToolchain } from '../shared/paper-builds.ts';
import type { SourceFile } from '../shared/types.ts';
import type { RevisionAsset } from '../shared/files.ts';
import { sourceSnapshotCanonical, validateSourceSnapshot } from '../shared/source-snapshot.ts';
import type { Auth } from './auth.ts';
import type { PolicyStore } from './policy.ts';
import type { Store } from './store.ts';
import { HttpError, object, string } from './validation.ts';
import { validatePaperBuildConcurrency, type PaperBuildConcurrency } from './paper-build-config.ts';

/** Runner boundary is deliberately independent of HTTP and durable job storage. */
export interface PaperRunner {
  toolchain: PaperToolchain;
  run(input: { revisionId: string; versionId: string; contentHash: string; files: SourceFile[]; assets?: (RevisionAsset & { data: Uint8Array })[]; entrypoint: string }, signal: AbortSignal): Promise<{
    success: boolean; artifacts: { kind: PaperArtifactKind; name: string; mediaType: string; data: Uint8Array }[];
    diagnostics: PaperBuildDiagnostic[]; error: string | null;
  }>;
}
interface JobRow { sequence: number; id: string; revision_id: string; version_id: string; context: string; data: string; lease_token: string | null; lease_until: number | null }
interface ArtifactRow { metadata: string; data: Uint8Array }
const KINDS: PaperArtifactKind[] = ['pdf', 'log', 'manifest', 'synctex', 'mapping'];
const TERMINAL = new Set(['succeeded', 'failed', 'canceled']);
const LEASE_MS = 30_000;
const MAX_ATTEMPTS = 3;
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

export function initializePaperBuilds(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE paper_builds (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, revision_id TEXT NOT NULL REFERENCES entities(id), version_id TEXT NOT NULL REFERENCES versions(id), context TEXT NOT NULL CHECK(json_valid(context)), data TEXT NOT NULL CHECK(json_valid(data)), lease_token TEXT, lease_until INTEGER);
    CREATE INDEX paper_builds_revision ON paper_builds(revision_id, sequence);
    CREATE TABLE paper_build_artifacts (build_id TEXT NOT NULL REFERENCES paper_builds(id), attempt INTEGER NOT NULL CHECK(attempt > 0), kind TEXT NOT NULL CHECK(kind IN ('pdf','log','manifest','synctex','mapping')), metadata TEXT NOT NULL CHECK(json_valid(metadata)), data BLOB NOT NULL, PRIMARY KEY(build_id, attempt, kind));
    CREATE TRIGGER paper_build_artifacts_no_update BEFORE UPDATE ON paper_build_artifacts BEGIN SELECT RAISE(ABORT, 'Paper build artifacts are immutable'); END;
    CREATE TRIGGER paper_build_artifacts_no_delete BEFORE DELETE ON paper_build_artifacts BEGIN SELECT RAISE(ABORT, 'Paper build artifacts are immutable'); END;
  `);
}
export function paperBuildInput(input: unknown): PaperBuildInput {
  const data = object(input, ['versionId', 'contentHash', 'entrypoint', 'toolchainId']);
  const result = { versionId: string(data.versionId, 'Version ID', 100), contentHash: string(data.contentHash, 'Content hash', 64), entrypoint: string(data.entrypoint, 'Entrypoint', 500), toolchainId: string(data.toolchainId, 'Toolchain ID', 64) };
  if (!/^[a-f0-9]{64}$/.test(result.contentHash) || !/^[a-f0-9]{64}$/.test(result.toolchainId)) throw new HttpError(400, 'Content and toolchain hashes must be SHA-256 digests.');
  if (!result.entrypoint.endsWith('.tex') || result.entrypoint.startsWith('/') || result.entrypoint.includes('\\') || result.entrypoint.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.')) || /[\x00-\x1f\x7f]/.test(result.entrypoint)) throw new HttpError(400, 'Choose an existing relative .tex source path.');
  return result;
}

export class PaperBuildService {
  private timer?: ReturnType<typeof setInterval>;
  private running = new Map<string, { token: string; controller: AbortController; promise: Promise<void> }>();
  private stopping = false;
  private readonly concurrency: PaperBuildConcurrency;
  readonly configuration: PaperBuildConfiguration;
  constructor(private store: Store, private auth: Auth, private policies: PolicyStore, private runner: PaperRunner | null = null, private now: () => number = Date.now, concurrency: number = 2) {
    this.concurrency = validatePaperBuildConcurrency(concurrency);
    this.configuration = runner ? { available: true, reason: null, toolchain: runner.toolchain, toolchainId: hash(JSON.stringify(['paper-build-v1', 'tex-container-v1', runner.toolchain])) }
      : { available: false, reason: 'An isolated paper compiler is not configured by the server operator.', toolchain: null, toolchainId: null };
  }
  start(): void {
    if (this.timer || this.stopping) return;
    this.timer = setInterval(() => this.tick(), 1_000); this.timer.unref();
    this.wake();
  }
  wake(): void { queueMicrotask(() => { if (!this.stopping) this.tick(); }); }
  private authorize(context: AuthContext, revisionId: string, write = false): void {
    this.auth.revalidate(context, write ? 'write' : 'read');
    this.policies.require(revisionId, context.principalId, write ? 'edit' : 'view');
  }
  private row(id: string): JobRow {
    const row = this.store.database.prepare('SELECT * FROM paper_builds WHERE id=?').get(id) as unknown as JobRow | undefined;
    if (!row) throw new HttpError(404, 'Paper build was not found.', 'PAPER_BUILD_UNAVAILABLE');
    return row;
  }
  private selected(revisionId: string, id: string): JobRow { const row = this.row(id); if (row.revision_id !== revisionId) throw new HttpError(404, 'Paper build was not found.', 'PAPER_BUILD_UNAVAILABLE'); return row; }
  private source(revisionId: string, input: PaperBuildInput) {
    const detail = this.store.detail(revisionId);
    const version = detail.versions.find(item => item.id === input.versionId);
    if (!version || version.contentHash !== input.contentHash) throw new HttpError(409, 'The selected immutable source version does not match.', 'PAPER_SOURCE_MISMATCH');
    if (version.docx) throw new HttpError(409, 'TeX compilation does not support DOCX versions.', 'DOCX_OPERATION_UNSUPPORTED');
    if (detail.revision.kind !== 'paper') throw new HttpError(400, 'Paper compilation requires a paper revision.');
    try { validateSourceSnapshot(version.files, version.assets); }
    catch { throw new HttpError(409, 'The selected source namespace or asset identity is invalid.', 'PAPER_SOURCE_MISMATCH'); }
    const actual = hash(sourceSnapshotCanonical(version.files, version.assets));
    if (actual !== input.contentHash) throw new HttpError(409, 'The selected source integrity check failed.', 'PAPER_SOURCE_MISMATCH');
    if (!version.files.some(file => file.path === input.entrypoint)) throw new HttpError(400, 'The selected .tex entrypoint is absent from this source version.');
    return version;
  }
  private toolchain(input: PaperBuildInput): void {
    if (!this.runner) throw new HttpError(503, this.configuration.reason!, 'PAPER_COMPILER_UNAVAILABLE');
    if (input.toolchainId !== this.configuration.toolchainId) throw new HttpError(409, 'The selected compiler configuration is no longer available. Reload the compiler settings.', 'PAPER_TOOLCHAIN_CHANGED');
  }
  get(revisionId: string, id: string, context: AuthContext): PaperBuild { this.authorize(context, revisionId); return JSON.parse(this.selected(revisionId, id).data) as PaperBuild; }
  list(revisionId: string, context: AuthContext, before?: number, limit = 25): PaperBuildPage {
    this.authorize(context, revisionId);
    if ((before !== undefined && (!Number.isSafeInteger(before) || before < 1)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, 'Invalid paper build page.');
    const rows = this.store.database.prepare('SELECT sequence,data FROM paper_builds WHERE revision_id=? AND sequence<? ORDER BY sequence DESC LIMIT ?').all(revisionId, before ?? Number.MAX_SAFE_INTEGER, limit + 1) as { sequence: number; data: string }[];
    const builds = rows.slice(0,limit).map(row => JSON.parse(row.data) as PaperBuild);
    return { builds, nextBefore: rows.length > limit ? rows[limit - 1]!.sequence : null, configuration: this.configuration, accessEpoch: this.policies.epoch() };
  }
  /** Called inside Store.mutate's writer transaction, after replay authorization. */
  submit(revisionId: string, input: unknown, context: AuthContext): PaperBuild {
    this.authorize(context, revisionId, true); const data = paperBuildInput(input); this.toolchain(data); const source = this.source(revisionId, data);
    const queued = this.store.database.prepare("SELECT count(*) AS total FROM paper_builds WHERE json_extract(data,'$.status') IN ('queued','running')").get() as { total: number };
    if (queued.total >= 100) throw new HttpError(429, 'The paper compiler queue is full. Try again after a build finishes.');
    const build: PaperBuild = { ...data, id: `PB${randomUUID()}`, revisionId, versionNumber: source.number, requestedBy: context.principalId, toolchain: this.runner!.toolchain, status: 'queued', attempt: 0, createdAt: new Date(this.now()).toISOString(), startedAt: null, finishedAt: null, error: null, diagnostics: [], artifacts: [], attempts: [] };
    this.store.database.prepare('INSERT INTO paper_builds(id,revision_id,version_id,context,data) VALUES(?,?,?,?,?)').run(build.id,revisionId,source.id,JSON.stringify(context),JSON.stringify(build));
    this.wake(); return build;
  }
  cancel(revisionId: string, id: string, input: unknown, context: AuthContext): PaperBuild {
    this.authorize(context, revisionId, true); object(input, []); const build = JSON.parse(this.selected(revisionId, id).data) as PaperBuild;
    if (!TERMINAL.has(build.status)) {
      const finishedAt = new Date(this.now()).toISOString(); build.status = 'canceled'; build.finishedAt = finishedAt; build.error = 'Canceled by a workspace editor.';
      const attempt = build.attempts.at(-1); if (attempt && !attempt.finishedAt) Object.assign(attempt, { status: 'canceled', finishedAt, error: build.error });
      this.save(build, null, null); this.running.get(id)?.controller.abort();
    }
    return build;
  }
  retry(revisionId: string, id: string, input: unknown, context: AuthContext): PaperBuild {
    this.authorize(context, revisionId, true); object(input, []); const old = JSON.parse(this.selected(revisionId,id).data) as PaperBuild;
    if (!TERMINAL.has(old.status)) throw new HttpError(409, 'Only a finished build can be retried.');
    return this.submit(revisionId, {versionId:old.versionId,contentHash:old.contentHash,entrypoint:old.entrypoint,toolchainId:old.toolchainId},context);
  }
  artifact(revisionId: string, id: string, kind: string, context: AuthContext): { metadata: PaperBuildArtifact; data: Uint8Array } {
    const build = this.get(revisionId,id,context);
    if (!KINDS.includes(kind as PaperArtifactKind) || !build.artifacts.some(item => item.kind === kind)) throw new HttpError(404, 'Paper artifact was not found.', 'PAPER_ARTIFACT_UNAVAILABLE');
    const row = this.store.database.prepare('SELECT metadata,data FROM paper_build_artifacts WHERE build_id=? AND attempt=? AND kind=?').get(id,build.attempt,kind) as unknown as ArtifactRow | undefined;
    if (!row) throw new HttpError(404, 'Paper artifact was not found.', 'PAPER_ARTIFACT_UNAVAILABLE');
    const metadata = JSON.parse(row.metadata) as PaperBuildArtifact;
    if (row.data.byteLength !== metadata.bytes || hash(row.data) !== metadata.sha256) throw new HttpError(500, 'Paper artifact integrity verification failed.');
    return { metadata, data: row.data };
  }
  synctex(revisionId: string, id: string, context: AuthContext): PaperSyncTeX {
    const build = this.get(revisionId,id,context); const artifact = this.artifact(revisionId,id,'mapping',context);
    const map = JSON.parse(Buffer.from(artifact.data).toString('utf8')) as PaperSyncTeXMap;
    return { ...map, origin:'top-left',units:'pt',versionId:build.versionId,contentHash:build.contentHash,accessEpoch:this.policies.epoch() };
  }
  private save(build: PaperBuild, token: string | null, until: number | null): void { this.store.database.prepare('UPDATE paper_builds SET data=?,lease_token=?,lease_until=? WHERE id=?').run(JSON.stringify(build),token,until,build.id); }
  private terminal(build: PaperBuild, error: string, status: 'failed' | 'canceled' = 'failed'): void {
    const finishedAt = new Date(this.now()).toISOString(); build.status=status; build.error=error; build.finishedAt=finishedAt;
    const attempt=build.attempts.at(-1); if(attempt && !attempt.finishedAt) Object.assign(attempt,{status,finishedAt,error}); this.save(build,null,null);
  }
  private recover(): void {
    const rows = this.store.database.prepare("SELECT * FROM paper_builds WHERE json_extract(data,'$.status')='running' AND lease_until<=?").all(this.now()) as unknown as JobRow[];
    for (const row of rows) {
      const build=JSON.parse(row.data) as PaperBuild; const error='The compiler attempt was interrupted before publication.';
      if (build.attempt >= MAX_ATTEMPTS) { this.terminal(build,error); continue; }
      const previous=build.attempts.at(-1)!; Object.assign(previous,{status:'failed',finishedAt:new Date(this.now()).toISOString(),error});
      build.status='queued'; build.error=null; build.startedAt=null; this.save(build,null,null);
    }
  }
  /** One bounded scheduler pass. Exposed for lifecycle verification with a controlled clock. */
  tick(): void {
    if (this.stopping) return;
    try {
      this.store.transaction(() => {
        this.recover();
        for (const [id, active] of this.running) {
          const row=this.row(id); const build=JSON.parse(row.data) as PaperBuild;
          if (build.status !== 'running' || row.lease_token !== active.token) { active.controller.abort(); continue; }
          try { this.authorize(JSON.parse(row.context) as AuthContext,row.revision_id,true); }
          catch { this.terminal(build,'The submitting credential or source permission is no longer available.'); active.controller.abort(); }
        }
      });
      while (this.running.size < this.concurrency) {
        const claim = this.claim(); if (!claim) break;
        const controller = new AbortController();
        const promise = this.execute(claim.build,claim.token,controller).finally(() => { if(this.running.get(claim.build.id)?.token===claim.token)this.running.delete(claim.build.id); if(!this.stopping) this.wake(); });
        this.running.set(claim.build.id,{token:claim.token,controller,promise});
      }
    } catch (error) { console.error('Paper build scheduler failed:', error instanceof Error ? error.message : 'unknown error'); }
  }
  private claim(): {build:PaperBuild; token:string} | null {
    return this.store.transaction(() => {
      const active=this.store.database.prepare("SELECT count(*) AS total FROM paper_builds WHERE json_extract(data,'$.status')='running'").get() as {total:number}; if(active.total>=this.concurrency) return null;
      const rows=this.store.database.prepare("SELECT * FROM paper_builds WHERE json_extract(data,'$.status')='queued' ORDER BY sequence LIMIT 100").all() as unknown as JobRow[]; const row=rows.find(candidate=>!this.running.has(candidate.id)); if(!row) return null;
      const build=JSON.parse(row.data) as PaperBuild;
      try { this.authorize(JSON.parse(row.context) as AuthContext,row.revision_id,true); this.toolchain(build); this.source(row.revision_id,build); }
      catch (error) { this.terminal(build,error instanceof HttpError && (error.code==='PAPER_TOOLCHAIN_CHANGED' || error.code==='PAPER_COMPILER_UNAVAILABLE') ? error.message : 'The submitting credential or source permission is no longer available.'); this.wake(); return null; }
      const token=randomUUID(); build.status='running'; build.attempt++; build.startedAt=new Date(this.now()).toISOString(); build.attempts.push({number:build.attempt,status:'running',startedAt:build.startedAt,finishedAt:null,error:null}); this.save(build,token,this.now()+LEASE_MS); return {build,token};
    });
  }
  private async execute(build: PaperBuild, token: string, controller: AbortController): Promise<void> {
    const heartbeat=setInterval(() => {
      try { this.store.transaction(() => { const row=this.row(build.id); if(row.lease_token!==token || (row.lease_until ?? 0)<=this.now()) {controller.abort();return;} this.authorize(JSON.parse(row.context) as AuthContext,row.revision_id,true); this.store.database.prepare('UPDATE paper_builds SET lease_until=? WHERE id=? AND lease_token=?').run(this.now()+LEASE_MS,build.id,token); }); }
      catch { controller.abort(); }
    },5_000); heartbeat.unref();
    try {
      const { version, assets }=this.store.read(() => {
        const row=this.row(build.id); this.authorize(JSON.parse(row.context) as AuthContext,row.revision_id,true);
        const version=this.source(build.revisionId,build);
        return { version, assets:this.store.files.resolveAssets(version.assets ?? []) };
      });
      const result=await this.runner!.run({revisionId:build.revisionId,versionId:build.versionId,contentHash:build.contentHash,files:version.files,...(assets.length?{assets}:{}),entrypoint:build.entrypoint},controller.signal);
      this.store.transaction(() => {
        const row=this.row(build.id); if(row.lease_token!==token || (row.lease_until ?? 0)<=this.now()) return;
        const current=JSON.parse(row.data) as PaperBuild; if(current.status!=='running') return;
        try { this.authorize(JSON.parse(row.context) as AuthContext,row.revision_id,true); this.source(build.revisionId,build); this.toolchain(build); }
        catch { this.terminal(current,'The submitting credential or source permission is no longer available.'); return; }
        if (this.stopping || controller.signal.aborted) { this.interrupted(current); return; }
        const artifacts=this.validateArtifacts(result.artifacts,result.success,version.files,version.assets ?? [],build);
        current.diagnostics=result.diagnostics.slice(0,200).map(item => ({severity:['info','warning','error'].includes(item.severity)?item.severity:'error',message:item.message.slice(0,2_000),...(item.path && version.files.some(file=>file.path===item.path)?{path:item.path,...(Number.isSafeInteger(item.line) && item.line!>0 ? {line:item.line}: {})}:{})}));
        for(const item of artifacts) this.store.database.prepare('INSERT INTO paper_build_artifacts(build_id,attempt,kind,metadata,data) VALUES(?,?,?,?,?)').run(build.id,build.attempt,item.metadata.kind,JSON.stringify(item.metadata),item.data);
        current.artifacts=artifacts.map(item=>item.metadata); current.status=result.success?'succeeded':'failed'; current.finishedAt=new Date(this.now()).toISOString(); current.error=result.success?null:(result.error??'Compilation failed.').slice(0,2_000);
        Object.assign(current.attempts.at(-1)!,{status:current.status,finishedAt:current.finishedAt,error:current.error}); this.save(current,null,null);
      });
    } catch {
      this.store.transaction(() => { const row=this.row(build.id); if(row.lease_token!==token || (row.lease_until??0)<=this.now()) return; const current=JSON.parse(row.data) as PaperBuild; if(this.stopping) this.interrupted(current); else this.terminal(current,controller.signal.aborted?'The compiler attempt was canceled before publication.':'The isolated compiler failed before verified artifacts could be published.'); });
    } finally { clearInterval(heartbeat); }
  }
  private interrupted(build: PaperBuild): void {
    const error='The server stopped before this attempt could publish.'; const attempt=build.attempts.at(-1)!; Object.assign(attempt,{status:'failed',finishedAt:new Date(this.now()).toISOString(),error});
    if(build.attempt>=MAX_ATTEMPTS) {this.terminal(build,error);return;} build.status='queued';build.startedAt=null;build.error=null;this.save(build,null,null);
  }
  private validateArtifacts(artifacts: Awaited<ReturnType<PaperRunner['run']>>['artifacts'],success:boolean,files:SourceFile[],assets:RevisionAsset[],build:PaperBuild): {metadata:PaperBuildArtifact;data:Uint8Array}[] {
    if(artifacts.length>5) throw new Error('Too many compiler artifacts.'); let total=0; const seen=new Set<string>();
    const sourceLines=new Map(files.map(file=>[file.path,file.content.split('\n').length]));
    const result=artifacts.map(item=>{
      if(!KINDS.includes(item.kind) || seen.has(item.kind) || !(item.data instanceof Uint8Array) || item.data.byteLength>MAX_ARTIFACT_BYTES || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(item.name)) throw new Error('Invalid compiler artifact.');
      seen.add(item.kind);total+=item.data.byteLength;
      if(!success && ['pdf','synctex','mapping'].includes(item.kind)) throw new Error('Failed compilation returned successful artifacts.');
      if(item.kind==='pdf' && !Buffer.from(item.data.subarray(0,5)).equals(Buffer.from('%PDF-'))) throw new Error('Invalid PDF artifact.');
      if(item.kind==='mapping') {
        const mapping=JSON.parse(Buffer.from(item.data).toString('utf8')) as PaperSyncTeXMap;
        if(mapping.origin!=='top-left'||mapping.units!=='pt'||!Array.isArray(mapping.pages)||!Array.isArray(mapping.points)||mapping.pages.length>1_000||mapping.points.length>100_000) throw new Error('Invalid source map.');
        const pages=new Set<number>(); for(const page of mapping.pages) {if(!Number.isSafeInteger(page.page)||page.page<1||pages.has(page.page)||!Number.isFinite(page.width)||!Number.isFinite(page.height)||page.width<=0||page.height<=0||page.width>14_400||page.height>14_400) throw new Error('Invalid PDF page.'); pages.add(page.page);}
        for(const point of mapping.points) if(!sourceLines.has(point.path)||!Number.isSafeInteger(point.line)||point.line<1||point.line>sourceLines.get(point.path)!||!pages.has(point.page)||![point.x,point.y,point.width,point.height].every(Number.isFinite)||point.width<0||point.height<0||Math.abs(point.x)>28_800||Math.abs(point.y)>28_800||point.width>28_800||point.height>28_800) throw new Error('Invalid source location.');
      }
      const mediaType=({pdf:'application/pdf',log:'text/plain; charset=utf-8',manifest:'application/json',synctex:'application/gzip',mapping:'application/json'} satisfies Record<PaperArtifactKind,string>)[item.kind];
      return {metadata:{kind:item.kind,name:item.name,mediaType,sha256:hash(item.data),bytes:item.data.byteLength},data:item.data};
    });
    if(total>MAX_TOTAL_BYTES || (success && !['pdf','log','manifest','synctex','mapping'].every(kind=>seen.has(kind)))) throw new Error('Missing or excessive compiler artifacts.');
    const manifest=result.find(item=>item.metadata.kind==='manifest');
    if(manifest) {
      const actual=JSON.parse(Buffer.from(manifest.data).toString('utf8')) as unknown;
      const expected={schema:assets.length?2:1,revisionId:build.revisionId,versionId:build.versionId,contentHash:build.contentHash,entrypoint:build.entrypoint,toolchain:build.toolchain,
        files:[...files].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0).map(file=>({path:file.path,sha256:hash(file.content),bytes:Buffer.byteLength(file.content)})),
        ...(assets.length?{assets:[...assets].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0).map(({path,fileId,sha256,bytes,mediaType})=>({path,fileId,sha256,bytes,mediaType}))}:{}),
        artifacts:result.filter(item=>item.metadata.kind!=='manifest').map(item=>({kind:item.metadata.kind,sha256:item.metadata.sha256,bytes:item.metadata.bytes})).sort((a,b)=>a.kind<b.kind?-1:a.kind>b.kind?1:0)};
      if(!isDeepStrictEqual(actual,expected)) throw new Error('Compiler manifest does not match the immutable source and artifacts.');
    }
    return result;
  }
  async close(): Promise<void> {
    this.stopping=true; if(this.timer)clearInterval(this.timer); for(const active of this.running.values())active.controller.abort();
    await Promise.allSettled([...this.running.values()].map(active=>active.promise));
  }
}
