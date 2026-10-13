import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { DrydockLeaseDetail, DrydockWorkingCopy } from '../shared/drydock.ts';
import type { AuthContext } from '../shared/auth.ts';
import type { GitCommitResult } from '../shared/repositories.ts';
import { isGitObjectId } from '../shared/repositories.ts';
import { analyzeLocally } from '../shared/review.ts';
import { sourceSnapshotCanonical } from '../shared/source-snapshot.ts';
import type { RevisionKind, RevisionVersion } from '../shared/types.ts';
import { buildPlanInput, buildReportInput, type Build, type Buildable, type BuildArtifact, type BuildClaim, type BuildClaimInput, type BuildCommandInput, type BuildDetail, type BuildEvent, type BuildPlan, type BuildPlanInput, type BuildReport, type BuildReportInput, type BuildRunInput, type BuildTarget, type BuildStep } from '../shared/harbormaster.ts';
import { HttpError, integer, object, string } from './validation.ts';

export interface BuildActor { principalId: string; displayName: string; workspaceId: string }
export type BuildAuthority = AuthContext | BuildActor;
export interface HarbormasterHooks {
  authorize(context: BuildAuthority, objectId: string | null, write: boolean): void;
  source(revisionId: string, versionId: string, contentHash: string): { version: RevisionVersion; kind: RevisionKind };
  mayManagePlan?(context: BuildAuthority, plan: BuildPlan): boolean;
  allowHttp?(endpoint: string, context: BuildAuthority): void;
  httpActor?(endpoint: string, creator: BuildAuthority): BuildActor;
  checkWorkingCopy?(step: BuildStep, actor: BuildAuthority): void;
  workingCopy?(build: Build, source: Buildable, target: BuildTarget, step: BuildStep, actor: BuildAuthority): DrydockLeaseDetail;
  workingCopies?(buildId: string, actor: BuildAuthority, requiredTargetIds?: string[]): DrydockWorkingCopy[];
  releaseWorkingCopies?(buildId: string, actor: BuildAuthority): void;
}
interface Row { data: string }
interface TargetRow extends Row { lease_hash: string | null; lease_principal: string | null; lease_until: number | null }
const hash = (input: string): string => createHash('sha256').update(input).digest('hex');
const terminal = (status: string): boolean => ['passed', 'failed', 'aborted'].includes(status);
const LEASE_MS = 5 * 60_000;
let savepoint = 0;
const decode = <T>(row: Row): T => JSON.parse(row.data) as T;
function parsed<T>(parse: (value: unknown) => T, value: unknown): T { try { return parse(value); } catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'Invalid build input.'); } }

export function initializeHarbormaster(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS harbormaster_plans(id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
    CREATE TABLE IF NOT EXISTS harbormaster_plan_versions(plan_id TEXT NOT NULL REFERENCES harbormaster_plans(id),version INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),PRIMARY KEY(plan_id,version));
    CREATE TABLE IF NOT EXISTS harbormaster_buildables(id TEXT PRIMARY KEY,identity TEXT UNIQUE NOT NULL,object_id TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)));
    CREATE TABLE IF NOT EXISTS harbormaster_builds(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,buildable_id TEXT NOT NULL REFERENCES harbormaster_buildables(id),actor TEXT NOT NULL CHECK(json_valid(actor)),data TEXT NOT NULL CHECK(json_valid(data)));
    CREATE TABLE IF NOT EXISTS harbormaster_targets(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,build_id TEXT NOT NULL REFERENCES harbormaster_builds(id),lease_hash TEXT,lease_principal TEXT,lease_until INTEGER,data TEXT NOT NULL CHECK(json_valid(data)));
    CREATE INDEX IF NOT EXISTS harbormaster_targets_build ON harbormaster_targets(build_id,sequence);
    CREATE TABLE IF NOT EXISTS harbormaster_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,build_id TEXT NOT NULL REFERENCES harbormaster_builds(id),data TEXT NOT NULL CHECK(json_valid(data)));
    CREATE TABLE IF NOT EXISTS harbormaster_reports(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,target_id TEXT NOT NULL REFERENCES harbormaster_targets(id),attempt INTEGER NOT NULL,report_key TEXT NOT NULL,fingerprint TEXT NOT NULL,actor_id TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),UNIQUE(target_id,attempt,report_key));
    CREATE TABLE IF NOT EXISTS harbormaster_artifacts(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,target_id TEXT NOT NULL REFERENCES harbormaster_targets(id),attempt INTEGER NOT NULL,artifact_key TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),UNIQUE(target_id,attempt,artifact_key));
  `);
  for (const table of ['harbormaster_plan_versions', 'harbormaster_buildables', 'harbormaster_events', 'harbormaster_reports', 'harbormaster_artifacts']) database.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Build evidence is immutable'); END; CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Build evidence is immutable'); END;`);
  const columns = {
    harbormaster_plans: ['id', 'data'], harbormaster_plan_versions: ['plan_id', 'version', 'data'],
    harbormaster_buildables: ['id', 'identity', 'object_id', 'data'], harbormaster_builds: ['sequence', 'id', 'buildable_id', 'actor', 'data'],
    harbormaster_targets: ['sequence', 'id', 'build_id', 'lease_hash', 'lease_principal', 'lease_until', 'data'], harbormaster_events: ['sequence', 'id', 'build_id', 'data'],
    harbormaster_reports: ['sequence', 'id', 'target_id', 'attempt', 'report_key', 'fingerprint', 'actor_id', 'data'], harbormaster_artifacts: ['sequence', 'id', 'target_id', 'attempt', 'artifact_key', 'data'],
  };
  for (const [table, expected] of Object.entries(columns)) if (JSON.stringify((database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name)) !== JSON.stringify(expected)) throw new Error(`Unexpected ${table} schema; Harbormaster migration was not applied.`);
}

/** Plans, execution state and receipts share the caller's writer transaction.
 * Async dispatch happens only after claim commits; callbacks are fenced to it. */
export class HarbormasterStore {
  constructor(private readonly database: DatabaseSync, private readonly hooks: HarbormasterHooks, private readonly now: () => number = Date.now) {}
  private scope<T>(work: () => T, write = false): T {
    const name = `harbormaster_${++savepoint}`; this.database.exec(`SAVEPOINT ${name}`);
    try { if (write) this.database.exec('UPDATE harbormaster_plans SET data=data WHERE 0'); const result = work(); this.database.exec(`RELEASE ${name}`); return result; }
    catch (error) { this.database.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
  }
  private timestamp(): string { return new Date(this.now()).toISOString(); }
  private rawPlan(id: string): BuildPlan { const row = this.database.prepare('SELECT data FROM harbormaster_plans WHERE id=?').get(id) as Row | undefined; if (!row) throw new HttpError(404, 'Build plan was not found.'); return decode(row); }
  private rawBuild(id: string): Build { const row = this.database.prepare('SELECT data FROM harbormaster_builds WHERE id=?').get(id) as Row | undefined; if (!row) throw new HttpError(404, 'Build was not found.'); return decode(row); }
  private rawTarget(id: string): TargetRow { const row = this.database.prepare('SELECT * FROM harbormaster_targets WHERE id=?').get(id) as unknown as TargetRow | undefined; if (!row) throw new HttpError(404, 'Build target was not found.'); return row; }
  private buildable(id: string): Buildable { const row = this.database.prepare('SELECT data FROM harbormaster_buildables WHERE id=?').get(id) as Row | undefined; if (!row) throw new HttpError(409, 'Buildable history is unavailable.'); return decode(row); }
  private objectId(buildable: Buildable): string { return (buildable.revisionId ?? buildable.repositoryId)!; }
  private authorizeBuild(id: string, context: BuildAuthority, write: boolean): Build { const build = this.rawBuild(id); this.hooks.authorize(context, this.objectId(this.buildable(build.buildableId)), write); return build; }
  private targets(buildId: string): BuildTarget[] { return (this.database.prepare('SELECT data FROM harbormaster_targets WHERE build_id=? ORDER BY sequence').all(buildId) as unknown as Row[]).map(row => decode<BuildTarget>(row)); }
  private updateBuild(build: Build): void { build.version++; build.updatedAt = this.timestamp(); this.database.prepare('UPDATE harbormaster_builds SET data=? WHERE id=?').run(JSON.stringify(build), build.id); }
  private updateTarget(target: BuildTarget): void { target.version++; this.database.prepare('UPDATE harbormaster_targets SET data=? WHERE id=?').run(JSON.stringify(target), target.id); }
  private clearLease(target: BuildTarget): void { target.leaseUntil = null; this.database.prepare('UPDATE harbormaster_targets SET lease_hash=NULL,lease_principal=NULL,lease_until=NULL WHERE id=?').run(target.id); }
  private event(buildId: string, type: string, detail: string, context: BuildAuthority, targetId: string | null = null): void {
    const event: BuildEvent = { id: randomUUID(), buildId, targetId, type, detail, actorId: context.principalId, createdAt: this.timestamp() };
    this.database.prepare('INSERT INTO harbormaster_events(id,build_id,data) VALUES(?,?,?)').run(event.id, buildId, JSON.stringify(event));
  }
  private endpointAllowed(plan: BuildPlanInput, context: BuildAuthority): void {
    for (const step of plan.steps) if (step.kind === 'working-copy') { if (!this.hooks.checkWorkingCopy) throw new HttpError(409, 'Drydock working copies are not configured.'); this.hooks.checkWorkingCopy(step, context); }
    for (const step of plan.steps) if (step.kind === 'http') { if (!this.hooks.allowHttp) throw new HttpError(409, 'HTTP build endpoints have not been configured by the operator.'); this.hooks.allowHttp(step.endpoint!, context); }
  }
  private source(buildable: Buildable): RevisionVersion | null {
    if (buildable.sourceKind === 'commit') return null;
    const { version, kind } = this.hooks.source(buildable.revisionId!, buildable.versionId!, buildable.contentHash);
    if (version.id !== buildable.versionId || version.revisionId !== buildable.revisionId || version.number !== buildable.versionNumber || version.contentHash !== buildable.contentHash || kind !== buildable.kind || hash(sourceSnapshotCanonical(version.files, version.assets, version.docx)) !== buildable.contentHash) throw new HttpError(409, 'The immutable build source does not match its recorded identity.', 'BUILD_SOURCE_MISMATCH');
    return version;
  }
  plan(id: string, context: BuildAuthority): BuildPlan { this.hooks.authorize(context, null, false); return this.rawPlan(id); }
  planVersion(id: string, version: number, context: BuildAuthority): BuildPlan {
    this.hooks.authorize(context, null, false); const row = this.database.prepare('SELECT data FROM harbormaster_plan_versions WHERE plan_id=? AND version=?').get(id, integer(version, 'Plan version')) as Row | undefined;
    if (!row) throw new HttpError(404, 'Build plan version was not found.'); return decode(row);
  }
  plans(context: BuildAuthority): BuildPlan[] { this.hooks.authorize(context, null, false); return (this.database.prepare('SELECT data FROM harbormaster_plans ORDER BY rowid DESC').all() as unknown as Row[]).map(row => decode<BuildPlan>(row)); }
  createPlan(input: unknown, context: BuildAuthority): BuildPlan {
    return this.scope(() => {
      this.hooks.authorize(context, null, true); const data = parsed(buildPlanInput, input); this.endpointAllowed(data, context); const createdAt = this.timestamp();
      const plan: BuildPlan = { ...data, id: `HMPLAN-${randomUUID()}`, version: 1, ownerId: context.principalId, createdAt, updatedAt: createdAt };
      this.database.prepare('INSERT INTO harbormaster_plans VALUES(?,?)').run(plan.id, JSON.stringify(plan)); this.database.prepare('INSERT INTO harbormaster_plan_versions VALUES(?,?,?)').run(plan.id, plan.version, JSON.stringify(plan)); return plan;
    }, true);
  }
  updatePlan(id: string, input: unknown, context: BuildAuthority): BuildPlan {
    return this.scope(() => {
      this.hooks.authorize(context, null, true); const data = object(input, ['expectedVersion', 'name', 'description', 'enabled', 'steps']), current = this.rawPlan(id);
      if (current.ownerId !== context.principalId && !this.hooks.mayManagePlan?.(context, current)) throw new HttpError(403, 'Only the plan owner or an automation manager can edit this plan.');
      if (integer(data.expectedVersion, 'Expected plan version') !== current.version) throw new HttpError(409, 'The build plan changed. Reload before editing.');
      const { expectedVersion: _expected, ...fields } = data, configuration = parsed(buildPlanInput, fields); this.endpointAllowed(configuration, context);
      const plan = { ...current, ...configuration, version: current.version + 1, updatedAt: this.timestamp() };
      this.database.prepare('UPDATE harbormaster_plans SET data=? WHERE id=?').run(JSON.stringify(plan), id); this.database.prepare('INSERT INTO harbormaster_plan_versions VALUES(?,?,?)').run(id, plan.version, JSON.stringify(plan)); return plan;
    }, true);
  }
  private selectedPlan(input: unknown, context: BuildAuthority): BuildPlan {
    const data = object(input, ['planId', 'planVersion', 'versionId', 'contentHash']);
    const plan = this.rawPlan(string(data.planId, 'Plan ID', 100));
    if (integer(data.planVersion, 'Plan version') !== plan.version) throw new HttpError(409, 'The selected build plan has changed.');
    if (!plan.enabled) throw new HttpError(409, 'The selected build plan is disabled.'); this.endpointAllowed(plan, context); return plan;
  }
  private saveBuildable(value: Omit<Buildable, 'id' | 'createdAt'>): Buildable {
    const identity = hash(JSON.stringify(value)), existing = this.database.prepare('SELECT data FROM harbormaster_buildables WHERE identity=?').get(identity) as Row | undefined;
    if (existing) return decode(existing);
    const buildable: Buildable = { ...value, id: `HMBL-${randomUUID()}`, createdAt: this.timestamp() };
    this.database.prepare('INSERT INTO harbormaster_buildables VALUES(?,?,?,?)').run(buildable.id, identity, this.objectId(buildable), JSON.stringify(buildable)); return buildable;
  }
  run(revisionId: string, input: unknown, context: BuildAuthority): BuildDetail {
    return this.scope(() => {
      this.hooks.authorize(context, revisionId, true); const plan = this.selectedPlan(input, context), data = input as BuildRunInput;
      const versionId = string(data.versionId, 'Source version ID', 100), contentHash = string(data.contentHash, 'Source content hash', 64);
      if (!/^[a-f0-9]{64}$/.test(contentHash)) throw new HttpError(400, 'Use the immutable source SHA-256 hash.');
      if (plan.steps.some(step => step.kind === 'working-copy')) throw new HttpError(400, 'Drydock working copies require an immutable Git commit build.');
      const source = this.hooks.source(revisionId, versionId, contentHash);
      const buildable = this.saveBuildable({ sourceKind: 'revision', revisionId, repositoryId: null, commitId: null, treeId: null, objectFormat: null, versionId, versionNumber: source.version.number, contentHash, kind: source.kind });
      this.source(buildable); return this.startBuild(buildable, plan, context, null);
    }, true);
  }
  /** Only pass a commit returned by the server's configured immutable Git observer. */
  runCommit(source: GitCommitResult, input: unknown, context: BuildAuthority): BuildDetail {
    return this.scope(() => {
      this.hooks.authorize(context, source.repositoryId, true); const plan = this.selectedPlan(input, context);
      if (!isGitObjectId(source.commit.id, source.objectFormat) || !isGitObjectId(source.commit.treeId, source.objectFormat)) throw new HttpError(400, 'Use a verified immutable Git commit.');
      if (plan.steps.some(step => step.kind === 'local-checks')) throw new HttpError(400, 'Commit builds require an external or HTTP worker; local checks require an imported source revision.');
      const buildable = this.saveBuildable({ sourceKind: 'commit', revisionId: null, repositoryId: source.repositoryId, commitId: source.commit.id, treeId: source.commit.treeId, objectFormat: source.objectFormat, versionId: null, versionNumber: null, contentHash: hash(JSON.stringify({ repositoryId: source.repositoryId, objectFormat: source.objectFormat, commitId: source.commit.id, treeId: source.commit.treeId })), kind: 'code' });
      return this.startBuild(buildable, plan, context, null);
    }, true);
  }
  private startBuild(buildable: Buildable, plan: BuildPlan, context: BuildAuthority, restartOf: string | null): BuildDetail {
    const now = this.timestamp(), build: Build = { id: `HMB-${randomUUID()}`, buildableId: buildable.id, revisionId: buildable.revisionId, planId: plan.id, planVersion: plan.version, plan, version: 1, status: 'pending', createdBy: context.principalId, createdAt: now, updatedAt: now, restartOf };
    const actor: BuildActor = { principalId: context.principalId, displayName: context.displayName, workspaceId: context.workspaceId };
    this.database.prepare('INSERT INTO harbormaster_builds(id,buildable_id,actor,data) VALUES(?,?,?,?)').run(build.id, buildable.id, JSON.stringify(actor), JSON.stringify(build));
    for (const step of plan.steps) {
      const target: BuildTarget = { id: `HMT-${randomUUID()}`, buildId: build.id, stepKey: step.key, status: step.dependsOn.length ? 'blocked' : 'pending', version: 1, attempt: 0, worker: null, leaseUntil: null, startedAt: null, finishedAt: null };
      this.database.prepare('INSERT INTO harbormaster_targets(id,build_id,data) VALUES(?,?,?)').run(target.id, build.id, JSON.stringify(target));
    }
    this.event(build.id, restartOf ? 'restart' : 'created', restartOf ? `Restarted ${restartOf} using its immutable plan and source.` : `Queued plan version ${plan.version}.`, context);
    this.advance(build.id, context); return this.detail(build.id, context);
  }
  detail(id: string, context: BuildAuthority): BuildDetail {
    return this.scope(() => {
      const build = this.authorizeBuild(id, context, false), targets = this.targets(id);
      const records = <T>(table: 'harbormaster_reports' | 'harbormaster_artifacts'): T[] => (this.database.prepare(`SELECT r.data FROM ${table} r JOIN harbormaster_targets t ON t.id=r.target_id WHERE t.build_id=? ORDER BY r.sequence`).all(id) as unknown as Row[]).map(row => decode<T>(row));
      return { build, buildable: this.buildable(build.buildableId), targets, events: (this.database.prepare('SELECT data FROM harbormaster_events WHERE build_id=? ORDER BY sequence').all(id) as unknown as Row[]).map(row => decode<BuildEvent>(row)), reports: records<BuildReport>('harbormaster_reports'), artifacts: records<BuildArtifact>('harbormaster_artifacts') };
    });
  }
  list(context: BuildAuthority, objectId?: string): Build[] {
    this.hooks.authorize(context, objectId ?? null, false);
    const rows = this.database.prepare('SELECT b.data FROM harbormaster_builds b JOIN harbormaster_buildables a ON a.id=b.buildable_id WHERE (? IS NULL OR a.object_id=?) ORDER BY b.sequence DESC').all(objectId ?? null, objectId ?? null) as unknown as Row[];
    return rows.map(row => decode<Build>(row)).filter(build => { try { this.hooks.authorize(context, this.objectId(this.buildable(build.buildableId)), false); return true; } catch (error) { if (error instanceof HttpError && [403, 404].includes(error.status)) return false; throw error; } });
  }
  command(id: string, input: unknown, context: BuildAuthority): BuildDetail {
    return this.scope(() => {
      const data = object(input, ['command', 'expectedVersion']), build = this.authorizeBuild(id, context, true);
      if (integer(data.expectedVersion, 'Expected build version') !== build.version) throw new HttpError(409, 'Build state changed. Reload before continuing.');
      if (!['pause', 'resume', 'abort', 'restart'].includes(String(data.command))) throw new HttpError(400, 'Unknown build command.');
      const command = data.command as BuildCommandInput['command'];
      if (command === 'restart') {
        if (!terminal(build.status)) throw new HttpError(409, 'Abort or finish the current build before restarting it.');
        this.endpointAllowed(build.plan, context); this.source(this.buildable(build.buildableId)); return this.startBuild(this.buildable(build.buildableId), build.plan, context, build.id);
      }
      if (terminal(build.status)) throw new HttpError(409, 'This build has finished. Restart it to run again.');
      if (command === 'resume' && build.status !== 'paused' || command === 'pause' && build.status === 'paused') throw new HttpError(409, 'This command does not match the current build state.');
      build.status = command === 'abort' ? 'aborted' : command === 'pause' ? 'paused' : 'pending';
      if (command === 'abort') for (const target of this.targets(id)) if (!terminal(target.status)) { target.status = 'aborted'; target.finishedAt = this.timestamp(); this.clearLease(target); this.updateTarget(target); }
      this.updateBuild(build); this.event(id, command, command === 'pause' ? 'Paused scheduling; already running targets may finish.' : command === 'resume' ? 'Resumed build scheduling.' : 'Aborted unfinished targets and invalidated their leases.', context);
      if (command === 'abort') this.hooks.releaseWorkingCopies?.(id, context);
      if (command === 'resume') this.advance(id, context); return this.detail(id, context);
    }, true);
  }
  private workingCopyDependencies(build: Build, target: BuildTarget): string[] {
    const steps = new Map(build.plan.steps.map(step => [step.key, step])), needed = new Set<string>();
    const queue = [...steps.get(target.stepKey)!.dependsOn];
    for (let index = 0; index < queue.length; index++) { const key = queue[index]!; if (needed.has(key)) continue; needed.add(key); queue.push(...steps.get(key)!.dependsOn); }
    return this.targets(build.id).filter(item => needed.has(item.stepKey) && steps.get(item.stepKey)!.kind === 'working-copy').map(item => item.id);
  }
  claim(input: unknown, context: BuildAuthority): BuildClaim {
    return this.scope(() => {
      const data = object(input, ['targetId', 'expectedVersion', 'worker']), id = string(data.targetId, 'Target ID', 100), row = this.rawTarget(id), target = decode<BuildTarget>(row), build = this.authorizeBuild(target.buildId, context, true), step = build.plan.steps.find(item => item.key === target.stepKey)!;
      if (integer(data.expectedVersion, 'Expected target version') !== target.version) throw new HttpError(409, 'Build target changed. Reload before claiming.');
      if (terminal(build.status) || build.status === 'paused') throw new HttpError(409, 'This build is not accepting work.');
      if (target.status !== 'pending' && !(target.status === 'building' && row.lease_until !== null && row.lease_until <= this.now())) throw new HttpError(409, 'This target is blocked, already leased, or finished.');
      const worker = string(data.worker, 'Worker label', 100); if (step.kind === 'local-checks' || step.kind === 'working-copy' || worker !== step.worker) throw new HttpError(400, 'Choose the worker label configured for this target.');
      this.endpointAllowed({ ...build.plan, steps: [step] }, context); const source = this.source(this.buildable(build.buildableId));
      const workingCopies = this.hooks.workingCopies?.(build.id, context, this.workingCopyDependencies(build, target));
      const leaseToken = randomBytes(32).toString('hex'), until = this.now() + LEASE_MS; target.status = 'building'; target.attempt++; target.worker = worker; target.leaseUntil = new Date(until).toISOString(); target.startedAt = this.timestamp(); target.finishedAt = null;
      this.updateTarget(target); this.database.prepare('UPDATE harbormaster_targets SET lease_hash=?,lease_principal=?,lease_until=? WHERE id=?').run(hash(leaseToken), context.principalId, until, id);
      build.status = 'building'; this.updateBuild(build); this.event(build.id, 'claimed', `Worker ${worker} claimed attempt ${target.attempt}.`, context, target.id);
      return { target, leaseToken, leaseUntil: target.leaseUntil, buildable: this.buildable(build.buildableId), step, source, ...(workingCopies?.length ? { workingCopies } : {}) };
    }, true);
  }
  report(targetId: string, input: unknown, context: BuildAuthority): BuildDetail {
    return this.scope(() => {
      const data = parsed(buildReportInput, input), row = this.rawTarget(targetId), target = decode<BuildTarget>(row), build = this.authorizeBuild(target.buildId, context, true), fingerprint = hash(JSON.stringify(data));
      const prior = this.database.prepare('SELECT fingerprint,actor_id FROM harbormaster_reports WHERE target_id=? AND attempt=? AND report_key=?').get(targetId, target.attempt, data.reportId) as { fingerprint: string; actor_id: string } | undefined;
      if (prior) { if (prior.fingerprint !== fingerprint || prior.actor_id !== context.principalId) throw new HttpError(409, 'This report identity was already used with different contents or authority.'); return this.detail(build.id, context); }
      if (target.status !== 'building' || terminal(build.status) || row.lease_hash !== hash(data.leaseToken) || row.lease_principal !== context.principalId || row.lease_until === null || row.lease_until <= this.now()) throw new HttpError(409, 'This build lease expired, finished, or belongs to another worker.', 'BUILD_LEASE_CHANGED');
      this.source(this.buildable(build.buildableId));
      if (data.type !== 'fail') this.hooks.workingCopies?.(build.id, context, this.workingCopyDependencies(build, target));
      this.recordReport(target, data, context);
      if (data.type === 'work') { const until = this.now() + LEASE_MS; target.leaseUntil = new Date(until).toISOString(); this.database.prepare('UPDATE harbormaster_targets SET lease_until=? WHERE id=?').run(until, target.id); }
      else { target.status = data.type === 'pass' ? 'passed' : 'failed'; target.finishedAt = this.timestamp(); this.clearLease(target); }
      this.updateTarget(target); this.updateBuild(build); this.event(build.id, data.type, `Attempt ${target.attempt}: ${data.type}.`, context, target.id); this.advance(build.id, context); return this.detail(build.id, context);
    }, true);
  }
  private recordReport(target: BuildTarget, data: BuildReportInput, context: BuildAuthority): void {
    const report: BuildReport = { id: randomUUID(), targetId: target.id, attempt: target.attempt, type: data.type, log: data.log ?? '', unit: data.unit ?? [], lint: data.lint ?? [], createdAt: this.timestamp(), actorId: context.principalId };
    this.database.prepare('INSERT INTO harbormaster_reports(id,target_id,attempt,report_key,fingerprint,actor_id,data) VALUES(?,?,?,?,?,?,?)').run(report.id, target.id, target.attempt, data.reportId, hash(JSON.stringify(data)), context.principalId, JSON.stringify(report));
    for (const item of data.artifacts ?? []) {
      if (this.database.prepare('SELECT 1 FROM harbormaster_artifacts WHERE target_id=? AND attempt=? AND artifact_key=?').get(target.id, target.attempt, item.key)) throw new HttpError(409, 'An artifact with this key already exists for this target attempt.');
      const artifact: BuildArtifact = { ...item, id: randomUUID(), targetId: target.id, attempt: target.attempt, createdAt: this.timestamp() };
      this.database.prepare('INSERT INTO harbormaster_artifacts(id,target_id,attempt,artifact_key,data) VALUES(?,?,?,?,?)').run(artifact.id, target.id, target.attempt, artifact.key, JSON.stringify(artifact));
    }
  }
  private advance(id: string, context: BuildAuthority): void {
    const build = this.rawBuild(id); if (terminal(build.status) || build.status === 'paused') return;
    this.hooks.authorize(context, this.objectId(this.buildable(build.buildableId)), true);
    const targets = this.targets(id);
    let lostWorkingCopy = false;
    for (const target of targets) {
      const step = build.plan.steps.find(item => item.key === target.stepKey)!;
      if (step.kind !== 'working-copy' || target.status !== 'passed') continue;
      const lease = this.hooks.workingCopy?.(build, this.buildable(build.buildableId), target, step, context).lease;
      if (lease?.status === 'active') continue;
      target.status = 'failed'; target.finishedAt = this.timestamp(); this.updateTarget(target);
      this.recordReport(target, { leaseToken: 'drydock', reportId: `drydock-lost-${target.id}`, type: 'fail', log: 'The working-copy lease expired or its authorization was withdrawn before the build finished.' }, context);
      this.event(id, 'working-copy-lost', 'A required working copy is no longer usable.', context, target.id); lostWorkingCopy = true;
    }
    if (lostWorkingCopy) for (const target of targets) if (!terminal(target.status)) { target.status = 'aborted'; target.finishedAt = this.timestamp(); this.clearLease(target); this.updateTarget(target); }
    const byKey = new Map(targets.map(target => [target.stepKey, target])); let changed = true;
    while (changed) {
      changed = false;
      for (const step of build.plan.steps) {
        const target = byKey.get(step.key)!; if (terminal(target.status) || target.status === 'building' && step.kind !== 'working-copy') continue;
        const dependencies = step.dependsOn.map(key => byKey.get(key)!);
        if (dependencies.some(dependency => dependency.status === 'failed' || dependency.status === 'aborted')) { target.status = 'aborted'; target.finishedAt = this.timestamp(); this.updateTarget(target); this.event(id, 'dependency-failed', 'A required dependency did not pass.', context, target.id); changed = true; continue; }
        if (dependencies.some(dependency => dependency.status !== 'passed')) continue;
        if (target.status === 'blocked') { target.status = 'pending'; this.updateTarget(target); changed = true; }
        if (step.kind === 'working-copy') {
          if (!this.hooks.workingCopy) throw new HttpError(409, 'Drydock working copies are not configured.');
          const detail = this.hooks.workingCopy(build, this.buildable(build.buildableId), target, step, context);
          const next = detail.lease.status === 'active' ? 'passed' : ['pending', 'acquired'].includes(detail.lease.status) ? 'building' : 'failed';
          if (target.status !== next || target.drydockLeaseId !== detail.lease.id) {
            if (!target.attempt) { target.attempt = 1; target.startedAt = this.timestamp(); }
            target.drydockLeaseId = detail.lease.id; target.status = next; target.worker = step.worker;
            if (terminal(next)) { target.finishedAt = this.timestamp(); this.recordReport(target, { leaseToken: 'drydock', reportId: `drydock-${detail.lease.id}`, type: next === 'passed' ? 'pass' : 'fail', log: next === 'passed' ? `Working copy ${detail.resource!.handle} is ready for this immutable commit.` : 'Drydock could not acquire a usable working copy.' }, context); }
            this.updateTarget(target); this.event(id, 'working-copy', `Drydock lease ${detail.lease.id}: ${detail.lease.status}.`, context, target.id); changed = true;
          }
          continue;
        }
        if (step.kind !== 'local-checks') continue;
        const source = this.source(this.buildable(build.buildableId)); if (!source || source.docx) { target.status = 'failed'; target.attempt++; target.startedAt = this.timestamp(); target.finishedAt = this.timestamp(); this.recordReport(target, { leaseToken: 'local', reportId: `local-${target.attempt}`, type: 'fail', log: 'Local deterministic text checks do not support this source format.' }, context); }
        else {
          const analysis = analyzeLocally(this.buildable(build.buildableId).kind, source.files); target.attempt++; target.startedAt = this.timestamp(); target.finishedAt = this.timestamp(); target.status = analysis.findings.some(finding => finding.severity === 'error') ? 'failed' : 'passed';
          this.recordReport(target, { leaseToken: 'local', reportId: `local-${target.attempt}`, type: target.status === 'passed' ? 'pass' : 'fail', log: analysis.summary, lint: analysis.findings.map(finding => ({ name: finding.title, code: finding.id, severity: finding.severity === 'info' ? 'advice' : finding.severity, path: finding.filePath, line: finding.line, description: finding.body })) }, context);
        }
        this.updateTarget(target); this.event(id, 'local-checks', 'Completed deterministic local text checks; no code, compiler or AI provider was executed.', context, target.id); changed = true;
      }
    }
    build.status = targets.every(target => terminal(target.status)) ? targets.some(target => target.status === 'failed' || target.status === 'aborted') ? 'failed' : 'passed' : targets.some(target => target.status === 'building') ? 'building' : 'pending'; this.updateBuild(build);
    if (terminal(build.status)) this.hooks.releaseWorkingCopies?.(id, context);
  }
  /** Reconcile resource readiness from the durable allocator; source execution stays in workers. */
  reconcileWorkingCopies(shouldStop: () => boolean = () => false): void {
    for (const row of this.database.prepare("SELECT id,actor FROM harbormaster_builds WHERE json_extract(data,'$.status') IN ('pending','building') ORDER BY sequence").all() as { id: string; actor: string }[]) {
      if (shouldStop()) return;
      const build = this.rawBuild(row.id); if (!build.plan.steps.some(step => step.kind === 'working-copy')) continue;
      try { this.scope(() => this.advance(row.id, JSON.parse(row.actor) as BuildActor), true); } catch (error) { if (!(error instanceof HttpError && [401, 403, 404, 409].includes(error.status))) throw error; }
    }
  }
  /** Metadata only: source never leaves this server through HTTP build dispatch. */
  async dispatchHttp(id: string, context: BuildAuthority, fetcher: typeof fetch = fetch, shouldStop: () => boolean = () => false): Promise<void> {
    if (shouldStop()) return;
    this.recoverExpiredHttp(id, context);
    const detail = this.detail(id, context); if (terminal(detail.build.status) || detail.build.status === 'paused') return;
    this.authorizeBuild(id, context, true);
    for (const target of detail.targets) {
      if (shouldStop()) return;
      const step = detail.build.plan.steps.find(item => item.key === target.stepKey)!;
      if (step.kind !== 'http' || target.status !== 'pending') continue;
      if (!this.hooks.httpActor) throw new HttpError(409, 'An HTTP build worker identity has not been configured by the operator.');
      const worker = this.hooks.httpActor(step.endpoint!, context);
      if (worker.workspaceId !== context.workspaceId) throw new HttpError(403, 'The HTTP worker must belong to this workspace.');
      const claim = this.claim({ targetId: target.id, expectedVersion: target.version, worker: step.worker! }, worker);
      try {
        const response = await fetcher(step.endpoint!, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'harbormaster.build', buildId: detail.build.id, targetId: target.id, attempt: claim.target.attempt, leaseToken: claim.leaseToken, leaseUntil: claim.leaseUntil, buildable: claim.buildable, step: claim.step, ...(claim.workingCopies?.length ? { workingCopies: claim.workingCopies } : {}) }) });
        await response.body?.cancel();
        this.report(target.id, { leaseToken: claim.leaseToken, reportId: randomUUID(), type: response.ok ? 'work' : 'fail', log: `HTTP build dispatch returned status ${response.status}.` }, worker);
      } catch (error) {
        try { this.report(target.id, { leaseToken: claim.leaseToken, reportId: randomUUID(), type: 'fail', log: 'HTTP build dispatch failed or timed out. Restart the build to try again.' }, worker); } catch (reportError) { if (!(reportError instanceof HttpError && reportError.code === 'BUILD_LEASE_CHANGED')) throw reportError; }
        if (error instanceof HttpError && error.code !== 'BUILD_LEASE_CHANGED') throw error;
      }
    }
  }
  private recoverExpiredHttp(id: string, context: BuildAuthority): void {
    this.scope(() => {
      const build = this.authorizeBuild(id, context, true); if (terminal(build.status)) return;
      let recovered = false;
      for (const target of this.targets(id)) {
        const step = build.plan.steps.find(item => item.key === target.stepKey)!;
        if (step.kind !== 'http' || target.status !== 'building' || !target.leaseUntil || Date.parse(target.leaseUntil) > this.now()) continue;
        target.status = 'failed'; target.finishedAt = this.timestamp(); this.clearLease(target); this.updateTarget(target);
        this.recordReport(target, { leaseToken: 'expired', reportId: randomUUID(), type: 'fail', log: 'HTTP worker lease expired. The request was not sent again because it may have reached the external system. Restart explicitly to try again.' }, context);
        this.event(id, 'lease-expired', 'HTTP worker lease expired; no automatic duplicate dispatch.', context, target.id); recovered = true;
      }
      if (recovered) { this.updateBuild(build); this.advance(id, context); }
    }, true);
  }
  /** Operator service calls this periodically; creator authority is rechecked. */
  async dispatchPendingHttp(fetcher: typeof fetch = fetch, shouldStop: () => boolean = () => false): Promise<void> {
    if (shouldStop()) return;
    const rows = this.database.prepare("SELECT id,actor FROM harbormaster_builds WHERE json_extract(data,'$.status') IN ('pending','building') ORDER BY sequence").all() as { id: string; actor: string }[];
    for (const row of rows) {
      if (shouldStop()) return;
      const actor = JSON.parse(row.actor) as BuildActor;
      try { await this.dispatchHttp(row.id, actor, fetcher, shouldStop); } catch (error) { if (!(error instanceof HttpError && [401, 403, 404, 409].includes(error.status))) throw error; }
    }
  }
}
