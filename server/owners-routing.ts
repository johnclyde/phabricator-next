import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { OwnersPackage, OwnersMatch } from '../shared/owners.ts';
import type { OwnersRoutingRecord, OwnersRoutingResult, OwnersRoutingSource } from '../shared/owners-routing.ts';
import { ownersAuditNeeded } from '../shared/owners-routing.ts';
import type { RevisionVersion, ActorAttribution } from '../shared/types.ts';
import type { GitReviewEvidence } from '../shared/git-review-gates.ts';
import type { RevisionReviewerInput } from '../shared/revision-reviewers.ts';
import { revisionPatchBaseline } from '../shared/revision-patch.ts';
import type { Store } from './store.ts';
import type { Auth } from './auth.ts';
import type { PolicyStore } from './policy.ts';
import type { AuditStore } from './audit.ts';
import type { GitAutomationStore } from './git-automation.ts';
import type { BuildActor } from './harbormaster.ts';
import { HttpError } from './validation.ts';

export interface OwnersRoutingPackages {
  match(repositoryId: string, paths: readonly string[]): OwnersMatch[];
  resolvedOwners(pkg: OwnersPackage): string[];
  canView(pkg: OwnersPackage, principalId: string): boolean;
  get(id: string, principalId: string): OwnersPackage;
  snapshot(id: string, version: number): OwnersPackage;
}
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
let serial = 0;
function scope<T>(db: DatabaseSync, work: () => T): T {
  const name = `owners_routing_${++serial}`; db.exec(`SAVEPOINT ${name}`);
  try { const result = work(); db.exec(`RELEASE ${name}`); return result; }
  catch (error) { db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
}
const SCHEMA = [
  ['table', 'owners_routing_records', 'CREATE TABLE owners_routing_records(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,object_id TEXT NOT NULL,source_sha256 TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)))'],
  ['index', 'owners_routing_object', 'CREATE INDEX owners_routing_object ON owners_routing_records(object_id,sequence)'],
  ['trigger', 'owners_routing_no_update', "CREATE TRIGGER owners_routing_no_update BEFORE UPDATE ON owners_routing_records BEGIN SELECT RAISE(ABORT,'Owners routing evidence is immutable'); END"],
  ['trigger', 'owners_routing_no_delete', "CREATE TRIGGER owners_routing_no_delete BEFORE DELETE ON owners_routing_records BEGIN SELECT RAISE(ABORT,'Owners routing evidence is immutable'); END"],
] as const;
export function initializeOwnersRouting(db: DatabaseSync): void {
  scope(db, () => {
    const normalized = (sql: string) => sql.replace(/\s+/g, ' ').trim().replace(/;$/, '');
    for (const [type, name, sql] of SCHEMA) {
      const existing = db.prepare('SELECT type,sql FROM sqlite_master WHERE name=?').all(name) as { type: string; sql: string }[];
      if (existing.length && (existing.length !== 1 || existing[0]!.type !== type || normalized(existing[0]!.sql ?? '') !== normalized(sql))) throw new Error(`Unexpected ${name} schema; Owners routing migration was not applied.`);
      if (!existing.length) db.exec(sql);
    }
  });
}

/** Literal path delta, including deleted names and both sides of renames. A
 * verified imported tree is the baseline; authored-only snapshots use the
 * previous version. Initial authored snapshots route all submitted paths. */
export function ownersRevisionPaths(repositoryId: string, versions: readonly RevisionVersion[], current: RevisionVersion): Pick<OwnersRoutingSource, 'basis' | 'baseVersionId' | 'paths'> {
  const candidate = revisionPatchBaseline(repositoryId, versions, current.id).baseline;
  const baseline = candidate && candidate.id !== current.id ? candidate : [...versions].filter(version => version.number < current.number).sort((a, b) => b.number - a.number)[0] ?? null;
  const files = (version: RevisionVersion | null) => {
    const result = new Map<string, string>();
    for (const file of version?.files ?? []) result.set(file.path, fingerprint(['text', file.content, version?.gitSource?.manifest.find(entry => entry.path === file.path)?.mode ?? baseline?.gitSource?.manifest.find(entry => entry.path === file.path)?.mode ?? '100644']));
    for (const asset of version?.assets ?? []) result.set(asset.path, fingerprint(['asset', asset.sha256, asset.bytes, asset.mediaType]));
    return result;
  };
  const before = files(baseline), after = files(current);
  return { basis: baseline ? baseline === candidate ? 'git-baseline' : 'previous-version' : 'submitted-files', baseVersionId: baseline?.id ?? null, paths: [...new Set([...before.keys(), ...after.keys()])].filter(path => before.get(path) !== after.get(path)).sort() };
}

export class OwnersRouting {
  constructor(private readonly store: Store, private readonly auth: Auth, private readonly policies: PolicyStore, private readonly packages: OwnersRoutingPackages, private readonly audit: AuditStore, private readonly git: GitAutomationStore) {}
  private person(id: string): { principalId: string; displayName: string } | null {
    if (this.auth.mode === 'local' && id === `local:${this.auth.workspaceId}`) return { principalId: id, displayName: 'You' };
    const account = this.auth.listAccounts().find(account => account.id === id && !account.disabled);
    return account ? { principalId: id, displayName: account.displayName } : null;
  }
  canViewPackage(packageId: string, principalId: string, version?: number): boolean {
    try { return this.packages.canView(this.packages.get(packageId, principalId), principalId) && (version === undefined || this.packages.canView(this.packages.snapshot(packageId, version), principalId)); }
    catch (error) { if (error instanceof HttpError && [403, 404].includes(error.status)) return false; throw error; }
  }
  canResolvePackage(packageId: string, principalId: string): boolean {
    try { const pkg = this.packages.get(packageId, principalId); return Boolean(this.person(principalId)) && pkg.status === 'active' && this.packages.resolvedOwners(pkg).includes(principalId); }
    catch (error) { if (error instanceof HttpError && [403, 404].includes(error.status)) return false; throw error; }
  }
  private actor(id: string, eventId: string): ActorAttribution | null {
    const person = this.person(id);
    return person ? { ...person, credentialId: null, requestId: `owners:${fingerprint(eventId)}` } : null;
  }
  private eligible(pkg: OwnersPackage, objectId: string): { owners: string[]; eligible: string[] } {
    const owners = this.packages.resolvedOwners(pkg).sort();
    return { owners, eligible: owners.filter(id => this.person(id) && this.packages.canView(pkg, id) && this.policies.access(objectId, id).view) };
  }
  private result(match: OwnersMatch, objectId: string, mode: string): OwnersRoutingResult {
    const people = this.eligible(match.package, objectId);
    return { package: structuredClone(match.package), paths: [...match.paths], ownerIds: people.owners, eligibleIds: people.eligible, appliedIds: [], mode, status: 'skipped', reason: 'disabled' };
  }
  private record(source: OwnersRoutingSource, actorId: string, run: () => OwnersRoutingResult[]): void {
    const id = `OR-${fingerprint([source.kind, source.objectId, source.versionId])}`;
    scope(this.store.database, () => {
      const existing = this.store.database.prepare('SELECT data,source_sha256 FROM owners_routing_records WHERE id=?').get(id) as { data: string; source_sha256: string } | undefined;
      if (existing) {
        const record = JSON.parse(existing.data) as OwnersRoutingRecord;
        if (fingerprint(record) !== existing.source_sha256 || record.source.objectId !== source.objectId || record.source.versionId !== source.versionId || record.source.contentHash !== source.contentHash) throw new HttpError(409, 'Owners routing source changed.');
        return;
      }
      const record: OwnersRoutingRecord = { id, source, actorId, createdAt: new Date().toISOString(), packages: run() };
      this.store.database.prepare('INSERT INTO owners_routing_records(id,object_id,source_sha256,data) VALUES(?,?,?,?)').run(id, source.objectId, fingerprint(record), JSON.stringify(record));
    });
  }
  revision(id: string, eventId: string, actorId: string): void {
    const detail = this.store.detail(id), repositoryId = detail.revision.repositoryId;
    if (!repositoryId) return;
    const current = detail.versions.find(version => version.number === detail.revision.currentVersion)!;
    const source: OwnersRoutingSource = { kind: 'revision', objectId: id, repositoryId, versionId: current.id, contentHash: current.contentHash, eventId, ...ownersRevisionPaths(repositoryId, detail.versions, current) };
    this.record(source, actorId, () => this.packages.match(repositoryId, source.paths).map(match => {
      const result = this.result(match, id, match.package.autoReview), actor = this.actor(actorId, eventId);
      if (match.package.autoReview === 'none') return result;
      if (!actor || !this.policies.access(id, actorId).edit) return { ...result, status: 'unavailable', reason: 'authority-unavailable' };
      const authorId = this.store.revisionAuthorship.state(id).author?.principalId;
      if (!match.package.autoReview.endsWith('-always') && authorId && result.ownerIds.includes(authorId)) return { ...result, reason: 'owner-author' };
      const review = match.package.autoReview.startsWith('review');
      const targets = result.eligibleIds.filter(target => !review || target !== authorId);
      if (!targets.length) return { ...result, status: 'unavailable', reason: 'no-eligible-owners' };
      try {
        const changed = scope(this.store.database, () => this.store.notifications.batch(() => {
          const changed: string[] = [];
          for (const principalId of targets) {
            const target = this.person(principalId)!;
            if (review) {
              // Automatic routing never re-adds a resigned member or changes a
              // recorded decision, and never makes all owners blocking voters.
              const state = this.store.revisionReviewers.snapshot(id, actorId);
              if (state.head.versionId !== source.versionId || state.head.contentHash !== source.contentHash) throw new HttpError(409, 'Owners routing source changed.');
              if (state.reviewers.members.some(member => member.principalId === principalId)) continue;
              const request: RevisionReviewerInput = { action: 'add', reviewerId: principalId, message: 'Owners automatic review.', expectedReviewerVersion: state.reviewers.version, expectedLifecycleVersion: state.lifecycle.version, expectedAuthorVersion: state.authorship.version, expectedVersion: state.head.number, expectedVersionId: state.head.versionId, expectedContentHash: state.head.contentHash, expectedAccessEpoch: this.policies.epoch(), expectedConfigId: state.configId, expectedEvidenceSha256: state.evidence.sha256 };
              this.store.revisionReviewers.mutate(id, request, actor, target); changed.push(principalId);
            } else {
              const state = this.store.revisionSubscriptions.person(id, principalId);
              if (state.status.automatic.length || state.status.state === 'subscribed' || state.status.state === 'unsubscribed') continue;
              const receipt = this.store.revisionSubscriptions.mutate(id, { action: 'subscribe', principalId, expectedSubscriptionVersion: state.status.version, expectedAuthorVersion: state.authorVersion, expectedReviewerVersion: state.reviewerVersion, expectedAccessEpoch: this.policies.epoch() }, actor, target);
              if (receipt.changed) changed.push(principalId);
            }
          }
          return changed;
        }));
        return { ...result, eligibleIds: targets, appliedIds: changed, status: changed.length ? 'applied' : 'unchanged', reason: changed.length ? 'routed' : 'already-present' };
      } catch (error) {
        if (error instanceof HttpError && [400, 403, 404, 409].includes(error.status)) return { ...result, status: 'unavailable', reason: 'membership-unavailable' };
        throw error;
      }
    }));
  }
  private ownerReviewed(evidence: GitReviewEvidence | undefined, owners: readonly string[]): boolean {
    if (evidence?.association !== 'verified' || !evidence.revision?.accepted) return false;
    const revision = evidence.revision;
    const state = this.store.revisionReviewers.stateAt(revision.revisionId, revision.reviewerVersion);
    return state.members.some(member => owners.includes(member.principalId) && member.status === 'accepted' && member.decision && !member.decision.invalidated && member.decision.head.versionId === revision.versionId && member.decision.head.contentHash === revision.contentHash);
  }
  commit(id: string, actor: BuildActor): void {
    const snapshot = this.git.snapshot(id), repositoryId = snapshot.repositoryId!;
    const source: OwnersRoutingSource = { kind: 'commit', objectId: id, repositoryId, versionId: snapshot.versionId!, contentHash: snapshot.contentHash!, eventId: snapshot.eventId, basis: 'receive', baseVersionId: null, paths: this.git.commitFiles(id).map(file => file.path).sort() };
    this.record(source, actor.principalId, () => this.packages.match(repositoryId, source.paths).map(match => {
      const result = this.result(match, repositoryId, match.package.auditing), mode = match.package.auditing;
      if (mode === 'none') return result;
      const linked = snapshot.git?.review?.revision;
      const evidence = linked && !this.policies.access(linked.revisionId, actor.principalId).view ? undefined : snapshot.git?.review;
      const reviewed = evidence?.association === 'verified' && evidence.revision?.accepted === true;
      const involved = this.ownerReviewed(evidence, result.eligibleIds.filter(principal => !linked || this.policies.access(linked.revisionId, principal).view));
      const trigger = ownersAuditNeeded(mode, reviewed, involved);
      if (!trigger) return { ...result, reason: 'no-audit-needed' };
      if (!this.person(actor.principalId) || !this.policies.access(repositoryId, actor.principalId).edit) return { ...result, status: 'unavailable', reason: 'authority-unavailable' };
      const before = this.audit.detail(id, actor).audit.version;
      const after = this.audit.requestFromOwners(id, { packageId: match.package.id, packageVersion: match.package.version, packageName: match.package.name, ownerIds: result.eligibleIds }, actor);
      // A package with no eligible people stays pending, rather than reporting
      // a successful audit because nobody can currently satisfy the request.
      return { ...result, appliedIds: result.eligibleIds, status: result.eligibleIds.length ? after.audit.version !== before ? 'applied' : 'unchanged' : 'unavailable', reason: !result.eligibleIds.length ? 'no-eligible-owners' : after.audit.version !== before ? 'routed' : 'already-present' };
    }));
  }
  history(objectId: string, principalId: string, before = Number.MAX_SAFE_INTEGER, limit = 25): Omit<import('../shared/owners-routing.ts').OwnersRoutingHistory, 'accessEpoch'> {
    if (!Number.isSafeInteger(before) || before < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, 'Choose valid routing pagination.');
    const policyId = this.git.policyObjectId(objectId) ?? objectId; this.policies.require(policyId, principalId, 'view');
    const rows = this.store.database.prepare('SELECT sequence,id,object_id,source_sha256,data FROM owners_routing_records WHERE object_id=? AND sequence<? ORDER BY sequence DESC LIMIT ?').all(objectId, before, limit + 1) as { sequence: number; id: string; object_id: string; source_sha256: string; data: string }[];
    const records = rows.slice(0, limit).map(row => {
      const record = JSON.parse(row.data) as OwnersRoutingRecord;
      if (record.id !== row.id || record.source.objectId !== row.object_id || fingerprint(record) !== row.source_sha256) throw new HttpError(409, 'Owners routing evidence cannot be verified.');
      return { ...record, packages: record.packages.filter(result => this.canViewPackage(result.package.id, principalId, result.package.version)) };
    });
    return { records, nextBefore: rows.length > limit ? rows[limit - 1]!.sequence : null };
  }
}
