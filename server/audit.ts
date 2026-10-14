import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { auditStatus, AUDIT_STATUS_LABELS } from '../shared/audit.ts';
import { isOwnersId } from '../shared/owners.ts';
import type { AuditChange, AuditCommand, AuditDetail, AuditEvent, AuditHistory, AuditHistoryQuery, AuditList, AuditListQuery, AuditRecord, AuditOwnerPackage, Auditor } from '../shared/audit.ts';
import { isGitObjectId } from '../shared/repositories.ts';
import type { GitCommitResult } from '../shared/repositories.ts';
import type { GitAutomationObject } from '../shared/git-automation.ts';
import type { BuildAuthority } from './harbormaster.ts';
import { choice, HttpError, integer, object, optionalString, string } from './validation.ts';

export interface AuditHooks {
  authorize(actor: BuildAuthority, repositoryId: string | null, write: boolean): void;
  /** Personal decisions require interaction, not permission to modify Git refs. */
  interact?(actor: BuildAuthority, repositoryId: string): void;
  /** Return only an active individual account which may see this repository. */
  principal(id: string, repositoryId: string, actor: BuildAuthority): { id: string; displayName: string } | null;
  /** Resolve only saved post-receive subjects. HTTP callers never supply source. */
  source(id: string): GitCommitResult | null;
  /** Package details have their own current visibility boundary. */
  canViewOwnerPackage?(packageId: string, actor: BuildAuthority, packageVersion: number): boolean;
  /** The decision maker must also belong to the captured ownerIds. */
  canResolveOwnerPackage?(packageId: string, actor: BuildAuthority): boolean;
}
interface Row { sequence: number; id: string; repository_id: string; source: string; data: string }
interface EventRow { sequence: number; data: string }
let transaction = 0;
const unavailable = () => new HttpError(404, 'Audit commit was not found.');
const permissionError = (error: unknown): boolean => error instanceof HttpError && [403, 404].includes(error.status);

const AUDIT_SCHEMA = [
  { type: 'table', name: 'audit_commits', sql: 'CREATE TABLE audit_commits(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,repository_id TEXT NOT NULL,source TEXT NOT NULL CHECK(json_valid(source)),data TEXT NOT NULL CHECK(json_valid(data)))' },
  { type: 'table', name: 'audit_events', sql: 'CREATE TABLE audit_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,audit_id TEXT NOT NULL REFERENCES audit_commits(id),version INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),UNIQUE(audit_id,version))' },
  { type: 'index', name: 'audit_commits_repository', sql: 'CREATE INDEX audit_commits_repository ON audit_commits(repository_id,sequence)' },
  { type: 'index', name: 'audit_events_commit', sql: 'CREATE INDEX audit_events_commit ON audit_events(audit_id,sequence)' },
  { type: 'trigger', name: 'audit_commits_source_immutable', sql: "CREATE TRIGGER audit_commits_source_immutable BEFORE UPDATE ON audit_commits WHEN NEW.id<>OLD.id OR NEW.repository_id<>OLD.repository_id OR NEW.source<>OLD.source OR NEW.sequence<>OLD.sequence BEGIN SELECT RAISE(ABORT,'Audit commit source is immutable'); END" },
  { type: 'trigger', name: 'audit_commits_no_delete', sql: "CREATE TRIGGER audit_commits_no_delete BEFORE DELETE ON audit_commits BEGIN SELECT RAISE(ABORT,'Audit commits are immutable'); END" },
  { type: 'trigger', name: 'audit_events_no_update', sql: "CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT,'Audit history is immutable'); END" },
  { type: 'trigger', name: 'audit_events_no_delete', sql: "CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT,'Audit history is immutable'); END" },
];

export function initializeAudit(database: DatabaseSync): void {
  const savepoint = `audit_migrate_${++transaction}`;
  database.exec(`SAVEPOINT ${savepoint}`);
  try {
  for (const definition of AUDIT_SCHEMA) {
    const present = database.prepare('SELECT type,sql FROM sqlite_master WHERE name=?').all(definition.name) as { type: string; sql: string | null }[];
    const normalized = (sql: string) => sql.replace(/\s+/g, ' ').trim().replace(/;$/, '');
    if (present.length && (present.length !== 1 || present[0]!.type !== definition.type || !present[0]!.sql || normalized(present[0]!.sql!) !== normalized(definition.sql))) throw new Error(`Unexpected ${definition.name} schema; Audit migration was not applied.`);
    if (!present.length) database.exec(definition.sql);
  }
  if (database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='git_automation_objects'").get()) {
    const rows = database.prepare("SELECT id,repository_id,kind,source_hash,data FROM git_automation_objects WHERE kind='commit' ORDER BY rowid").iterate() as Iterable<{ id: string; repository_id: string; kind: string; source_hash: string; data: string }>;
    for (const row of rows) {
      const value = JSON.parse(row.data) as GitAutomationObject;
      const hash = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
      if (hash(value) !== row.source_hash || value.id !== row.id || value.repositoryId !== row.repository_id || value.kind !== 'commit' || value.snapshot.objectId !== row.id || value.snapshot.repositoryId !== row.repository_id || value.snapshot.contentType !== 'commit' || !value.commit || row.id !== `GC-${hash([row.repository_id, value.commit.commit.id])}`) throw new Error('Audit migration cannot verify the saved Git commit evidence.');
      const source = { repositoryId: value.repositoryId, objectFormat: value.objectFormat, commit: value.commit.commit };
      validateSource(source);
      const existing = database.prepare('SELECT source FROM audit_commits WHERE id=?').get(row.id) as { source: string } | undefined;
      if (existing) {
        if (!isDeepStrictEqual(JSON.parse(existing.source), source)) throw new Error('Audit migration found conflicting saved commit evidence.');
        continue;
      }
      const createdAt = new Date().toISOString(), actorId = value.snapshot.actorId;
      if (typeof actorId !== 'string' || !actorId || actorId.length > 200) throw new Error('Audit migration cannot verify the saved commit actor.');
      const audit: AuditRecord = { id: row.id, version: 1, source, auditors: [], status: 'none', createdAt, updatedAt: createdAt };
      const event: Omit<AuditEvent, 'sequence'> = { id: randomUUID(), auditId: row.id, auditVersion: 1, action: 'observed', origin: 'receive', actorId, actorName: actorId, comment: '', changes: [], status: 'none', createdAt };
      database.prepare('INSERT INTO audit_commits(id,repository_id,source,data) VALUES(?,?,?,?)').run(audit.id, audit.source.repositoryId, JSON.stringify(source), JSON.stringify(audit));
      database.prepare('INSERT INTO audit_events(id,audit_id,version,data) VALUES(?,?,?,?)').run(event.id, audit.id, 1, JSON.stringify(event));
    }
  }
  database.exec(`RELEASE ${savepoint}`);
  } catch (error) {
    database.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
    throw error;
  }
}

function validateSource(source: GitCommitResult): void {
  if (!/^R[1-9]\d{0,14}$/.test(source.repositoryId) || !['sha1', 'sha256'].includes(source.objectFormat) || !isGitObjectId(source.commit.id, source.objectFormat) || /^0+$/.test(source.commit.id) || !isGitObjectId(source.commit.treeId, source.objectFormat) || /^0+$/.test(source.commit.treeId) || source.commit.parentIds.some(parent => !isGitObjectId(parent, source.objectFormat) || /^0+$/.test(parent))) throw new HttpError(409, 'The saved Git commit source is invalid.');
}

/** Individual audit decisions concern one durable Git object. They never grant
 * push permission, close a Differential revision, or transfer to another commit. */
export class AuditStore {
  constructor(private readonly database: DatabaseSync, private readonly hooks: AuditHooks, private readonly now: () => number = Date.now) {}

  private scope<T>(work: () => T): T {
    const name = `audit_${++transaction}`;
    this.database.exec(`SAVEPOINT ${name}`);
    try {
      this.database.exec('UPDATE audit_commits SET data=data WHERE 0');
      const result = work();
      this.database.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      this.database.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
      throw error;
    }
  }
  private timestamp(): string { return new Date(this.now()).toISOString(); }
  private id(id: string): void { if (!/^GC-[a-f0-9]{64}$/.test(id)) throw unavailable(); }
  private source(id: string): GitCommitResult {
    this.id(id);
    const source = this.hooks.source(id);
    if (!source) throw unavailable();
    validateSource(source);
    // Transport response metadata (for example an access epoch) is not source.
    return { repositoryId: source.repositoryId, objectFormat: source.objectFormat, commit: source.commit };
  }
  private raw(id: string): { row: Row; audit: AuditRecord } {
    this.id(id);
    const row = this.database.prepare('SELECT * FROM audit_commits WHERE id=?').get(id) as Row | undefined;
    if (!row) throw unavailable();
    const audit = JSON.parse(row.data) as AuditRecord;
    if (audit.id !== id || audit.source.repositoryId !== row.repository_id || !isDeepStrictEqual(audit.source, JSON.parse(row.source))) throw new HttpError(409, 'The saved audit source is inconsistent.');
    return { row, audit };
  }
  private checked(id: string, actor: BuildAuthority, write = false): AuditRecord {
    this.hooks.authorize(actor, null, write);
    const { audit } = this.raw(id);
    this.hooks.authorize(actor, audit.source.repositoryId, write);
    if (!isDeepStrictEqual(this.source(id), audit.source)) throw new HttpError(409, 'The saved audit commit source changed.');
    return audit;
  }
  private editable(repositoryId: string, actor: BuildAuthority): boolean {
    try { this.hooks.authorize(actor, repositoryId, true); return true; }
    catch (error) { if (permissionError(error)) return false; throw error; }
  }
  private interact(repositoryId: string, actor: BuildAuthority): void {
    if (this.hooks.interact) this.hooks.interact(actor, repositoryId);
    else this.hooks.authorize(actor, repositoryId, true);
  }
  private canInteract(repositoryId: string, actor: BuildAuthority): boolean {
    try { this.interact(repositoryId, actor); return true; }
    catch (error) { if (permissionError(error)) return false; throw error; }
  }
  private page(query: AuditHistoryQuery): { before: number; limit: number } {
    const before = query.before === undefined ? Number.MAX_SAFE_INTEGER : integer(query.before, 'Page cursor');
    const limit = query.limit === undefined ? 50 : integer(query.limit, 'Page size');
    if (limit > 100) throw new HttpError(400, 'An Audit page may contain at most 100 records.');
    return { before, limit };
  }
  private history(id: string, query: AuditHistoryQuery): AuditHistory {
    const { before, limit } = this.page(query);
    const rows = this.database.prepare('SELECT sequence,data FROM audit_events WHERE audit_id=? AND sequence<? ORDER BY sequence DESC LIMIT ?').all(id, before, limit + 1) as unknown as EventRow[];
    const events = rows.slice(0, limit).map(row => ({ ...JSON.parse(row.data) as Omit<AuditEvent, 'sequence'>, sequence: row.sequence }));
    return { events, nextBefore: rows.length > limit ? events[events.length - 1]!.sequence : null };
  }
  detail(id: string, actor: BuildAuthority, query: AuditHistoryQuery = {}): AuditDetail {
    const audit = this.checked(id, actor);
    return { audit: this.project(audit, actor), history: this.history(id, query), canEdit: this.editable(audit.source.repositoryId, actor), canInteract: this.canInteract(audit.source.repositoryId, actor) };
  }
  private project(audit: AuditRecord, actor: BuildAuthority): AuditRecord {
    if (!audit.ownerPackages) return audit;
    return { ...audit, ownerPackages: audit.ownerPackages.filter(group => this.hooks.canViewOwnerPackage?.(group.packageId, actor, group.packageVersion) === true) };
  }
  list(actor: BuildAuthority, query: AuditListQuery = {}): AuditList {
    this.hooks.authorize(actor, null, false);
    const page = this.page(query), repositoryId = query.repositoryId === undefined ? null : string(query.repositoryId, 'Repository', 100);
    if (repositoryId) this.hooks.authorize(actor, repositoryId, false);
    const status = query.status === undefined ? null : choice(query.status, 'Audit status', Object.keys(AUDIT_STATUS_LABELS));
    const auditorId = query.auditorId === undefined ? null : string(query.auditorId, 'Auditor', 200);
    const visible: { audit: AuditRecord; sequence: number }[] = [];
    let before = page.before, scanned = 0, exhausted = false;
    while (visible.length <= page.limit && scanned < 1000) {
      const rows = this.database.prepare("SELECT * FROM audit_commits WHERE sequence<? AND (? IS NULL OR repository_id=?) AND (? IS NULL OR json_extract(data,'$.status')=?) ORDER BY sequence DESC LIMIT 200").all(before, repositoryId, repositoryId, status, status) as unknown as Row[];
      if (!rows.length) { exhausted = true; break; }
      for (const row of rows) {
        before = row.sequence; scanned++;
        try {
          const audit = this.project(this.checked(row.id, actor), actor);
          // Apply the owner filter only after package projection. Otherwise a
          // query could reveal an owner of a private package through matching.
          if (!auditorId || audit.auditors.some(person => person.principalId === auditorId) || audit.ownerPackages?.some(group => group.ownerIds.includes(auditorId))) visible.push({ audit, sequence: row.sequence });
        }
        catch (error) { if (!permissionError(error)) throw error; }
        if (visible.length > page.limit) break;
      }
      if (rows.length < 200 && visible.length <= page.limit) { exhausted = true; break; }
    }
    const selected = visible.slice(0, page.limit);
    return { audits: selected.map(item => this.project(item.audit, actor)), nextBefore: visible.length > page.limit ? selected[selected.length - 1]!.sequence : !exhausted && scanned >= 1000 ? before : null };
  }
  private event(audit: AuditRecord, action: AuditEvent['action'], origin: AuditEvent['origin'], actor: BuildAuthority, comment: string, changes: AuditChange[]): void {
    const event: Omit<AuditEvent, 'sequence'> = { id: randomUUID(), auditId: audit.id, auditVersion: audit.version, action, origin, actorId: actor.principalId, actorName: actor.displayName, comment, changes, status: audit.status, createdAt: audit.updatedAt };
    this.database.prepare('INSERT INTO audit_events(id,audit_id,version,data) VALUES(?,?,?,?)').run(event.id, audit.id, audit.version, JSON.stringify(event));
  }
  private save(audit: AuditRecord, action: AuditEvent['action'], origin: AuditEvent['origin'], actor: BuildAuthority, comment: string, changes: AuditChange[], personal = false): void {
    if (personal) this.interact(audit.source.repositoryId, actor);
    else this.hooks.authorize(actor, audit.source.repositoryId, true);
    if (!isDeepStrictEqual(this.source(audit.id), audit.source)) throw new HttpError(409, 'The saved audit commit source changed.');
    const previous = audit.version;
    audit.version++;
    audit.status = auditStatus(audit.auditors, audit.ownerPackages);
    audit.updatedAt = this.timestamp();
    const result = this.database.prepare("UPDATE audit_commits SET data=? WHERE id=? AND json_extract(data,'$.version')=?").run(JSON.stringify(audit), audit.id, previous);
    if (result.changes !== 1) throw new HttpError(409, 'The audit changed. Reload before continuing.');
    this.event(audit, action, origin, actor, comment, changes);
  }
  /** Called only for a verified saved post-receive subject. Repeated delivery is
   * harmless and does not manufacture another request or history entry. */
  observe(id: string, actor: BuildAuthority): AuditRecord {
    return this.scope(() => {
      this.hooks.authorize(actor, null, true);
      const source = this.source(id);
      this.hooks.authorize(actor, source.repositoryId, true);
      if (this.database.prepare('SELECT 1 FROM audit_commits WHERE id=?').get(id)) return this.checked(id, actor, true);
      const createdAt = this.timestamp(), audit: AuditRecord = { id, version: 1, source, auditors: [], status: 'none', createdAt, updatedAt: createdAt };
      this.database.prepare('INSERT INTO audit_commits(id,repository_id,source,data) VALUES(?,?,?,?)').run(id, source.repositoryId, JSON.stringify(source), JSON.stringify(audit));
      this.event(audit, 'observed', 'receive', actor, '', []);
      return audit;
    });
  }
  private expected(audit: AuditRecord, value: unknown): void {
    if (integer(value, 'Expected audit version') !== audit.version) throw new HttpError(409, 'The audit changed. Reload before continuing.', 'AUDIT_CHANGED');
  }
  private auditorIds(value: unknown): string[] {
    if (!Array.isArray(value) || value.length < 1 || value.length > 100) throw new HttpError(400, 'Request between 1 and 100 auditors per action.');
    const result = value.map(id => string(id, 'Auditor', 200));
    if (new Set(result).size !== result.length) throw new HttpError(400, 'Choose each auditor once.');
    return result;
  }
  private requestAuditors(audit: AuditRecord, ids: string[], actor: BuildAuthority, comment: string, origin: 'manual' | 'herald'): void {
    const principals = ids.map(id => {
      const principal = this.hooks.principal(id, audit.source.repositoryId, actor);
      if (!principal || principal.id !== id) throw new HttpError(400, 'Each auditor must be an active account with access to this repository.');
      return principal;
    });
    const changes: AuditChange[] = [], timestamp = this.timestamp();
    for (const principal of principals) {
      if (audit.auditors.some(auditor => auditor.principalId === principal.id)) continue;
      audit.auditors.push({ principalId: principal.id, displayName: principal.displayName, status: 'requested', requestedBy: actor.principalId, createdAt: timestamp, updatedAt: timestamp });
      changes.push({ principalId: principal.id, displayName: principal.displayName, before: null, after: 'requested' });
    }
    if (changes.length || comment) this.save(audit, 'request', origin, actor, comment, changes);
  }
  request(id: string, input: unknown, actor: BuildAuthority): AuditDetail {
    return this.scope(() => {
      const audit = this.checked(id, actor, true), data = object(input, ['expectedVersion', 'auditorIds', 'comment']);
      this.expected(audit, data.expectedVersion);
      this.requestAuditors(audit, this.auditorIds(data.auditorIds), actor, optionalString(data.comment, 'Comment', 100_000), 'manual');
      return this.detail(id, actor);
    });
  }
  /** A rule's currently authorized author is the actor. Rule internals are not
   * copied into history where they could disclose a private rule to readers. */
  requestFromHerald(id: string, auditorIds: string[], actor: BuildAuthority): AuditDetail {
    return this.scope(() => {
      this.observe(id, actor);
      const audit = this.checked(id, actor, true);
      this.requestAuditors(audit, this.auditorIds(auditorIds), actor, '', 'herald');
      return this.detail(id, actor);
    });
  }
  /** Trusted routing creates one collective request with immutable package and
   * membership provenance. The ordinary HTTP API cannot manufacture packages. */
  requestFromOwners(id: string, group: Pick<AuditOwnerPackage, 'packageId' | 'packageVersion' | 'packageName' | 'ownerIds'>, actor: BuildAuthority): AuditDetail {
    return this.scope(() => {
      this.observe(id, actor);
      const audit = this.checked(id, actor, true);
      if (audit.ownerPackages?.some(item => item.packageId === group.packageId)) return this.detail(id, actor);
      if (!isOwnersId(group.packageId) || !Number.isSafeInteger(group.packageVersion) || group.packageVersion < 1 || !group.packageName || !Array.isArray(group.ownerIds) || new Set(group.ownerIds).size !== group.ownerIds.length) throw new HttpError(400, 'Choose a valid ownership package and eligible owners.');
      for (const id of group.ownerIds) if (!this.hooks.principal(id, audit.source.repositoryId, actor)) throw new HttpError(400, 'Each package owner must be an active account with repository access.');
      const timestamp = this.timestamp();
      (audit.ownerPackages ??= []).push({ ...structuredClone(group), status: 'requested', requestedBy: actor.principalId, createdAt: timestamp, updatedAt: timestamp, decisionBy: null });
      // Package metadata is intentionally absent from public audit history.
      this.save(audit, 'request', 'owners', actor, '', []);
      return this.detail(id, actor);
    });
  }
  command(id: string, input: unknown, actor: BuildAuthority): AuditDetail {
    return this.scope(() => {
      const audit = this.checked(id, actor), data = object(input, ['expectedVersion', 'command', 'comment']);
      this.interact(audit.source.repositoryId, actor);
      this.expected(audit, data.expectedVersion);
      const command = choice<AuditCommand>(data.command, 'Audit action', ['comment', 'concern', 'accept', 'resign']), comment = optionalString(data.comment, 'Comment', 100_000);
      const changes: AuditChange[] = [];
      if (command === 'comment') {
        if (!comment.trim()) throw new HttpError(400, 'Write a comment before posting.');
      } else {
        let auditor = audit.auditors.find(item => item.principalId === actor.principalId);
        if (command === 'resign' && (!auditor || auditor.status === 'resigned')) throw new HttpError(409, 'Only an active auditor may resign.');
        const status: Auditor['status'] = command === 'concern' ? 'concerned' : command === 'accept' ? 'accepted' : 'resigned';
        if (auditor?.status === status) throw new HttpError(409, 'You have already recorded this audit decision.');
        const before = auditor?.status ?? null, timestamp = this.timestamp();
        if (!auditor) {
          const principal = this.hooks.principal(actor.principalId, audit.source.repositoryId, actor);
          if (!principal || principal.id !== actor.principalId) throw new HttpError(403, 'An active account with repository access is required.');
          auditor = { principalId: principal.id, displayName: principal.displayName, status, requestedBy: actor.principalId, createdAt: timestamp, updatedAt: timestamp };
          audit.auditors.push(auditor);
        } else { auditor.status = status; auditor.updatedAt = timestamp; }
        changes.push({ principalId: auditor.principalId, displayName: auditor.displayName, before, after: status });
        for (const group of audit.ownerPackages ?? []) {
          if (!group.ownerIds.includes(actor.principalId)) continue;
          if (command === 'resign') {
            if (group.decisionBy !== actor.principalId) continue;
            // Withdrawing the latest decision must preserve another eligible
            // owner's acceptance, including a decision made earlier. A former
            // owner may withdraw their own vote without retaining new voting
            // authority through their old package membership.
            const eligible = audit.auditors.filter(person => group.ownerIds.includes(person.principalId)
              && this.hooks.principal(person.principalId, audit.source.repositoryId, actor)
              && this.hooks.canResolveOwnerPackage?.(group.packageId, { principalId: person.principalId, displayName: person.displayName, workspaceId: actor.workspaceId }) === true);
            const remaining = eligible.find(person => person.status === 'accepted') ?? eligible.find(person => person.status === 'concerned');
            group.status = remaining?.status === 'accepted' ? 'accepted' : remaining?.status === 'concerned' ? 'concerned' : 'requested';
            group.decisionBy = remaining?.principalId ?? null;
          } else {
            if (this.hooks.canResolveOwnerPackage?.(group.packageId, actor) !== true) continue;
            group.status = command === 'accept' ? 'accepted' : 'concerned';
            group.decisionBy = actor.principalId;
          }
          group.updatedAt = timestamp;
        }
      }
      this.save(audit, command, 'manual', actor, comment, changes, true);
      return this.detail(id, actor);
    });
  }
}
