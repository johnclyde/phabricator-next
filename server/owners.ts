import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { isOwnersId, matchOwners, ownersDefinition, parseOwnersDefinition, type OwnersDefinition, type OwnersHistoryEntry, type OwnersMatch, type OwnersOperation, type OwnersPackage } from '../shared/owners.ts';
import type { Auth } from './auth.ts';
import type { PolicyStore } from './policy.ts';
import { effectiveMembers } from './project-graph.ts';
import type { Store } from './store.ts';
import type { ActorAttribution } from '../shared/types.ts';
import { HttpError } from './validation.ts';

const schema = [
  ['table', 'owners_packages', 'CREATE TABLE owners_packages(id TEXT PRIMARY KEY,creator_id TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0),data TEXT NOT NULL CHECK(json_valid(data)))'],
  ['table', 'owners_history', 'CREATE TABLE owners_history(package_id TEXT NOT NULL REFERENCES owners_packages(id),version INTEGER NOT NULL CHECK(version>0),actor_id TEXT NOT NULL,actor_name TEXT NOT NULL,authority_id TEXT NOT NULL,snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),PRIMARY KEY(package_id,version))'],
  ['table', 'owners_operations', 'CREATE TABLE owners_operations(principal_id TEXT NOT NULL,request_hash TEXT NOT NULL,fingerprint TEXT NOT NULL,receipt TEXT NOT NULL CHECK(json_valid(receipt)),PRIMARY KEY(principal_id,request_hash))'],
  ['trigger', 'owners_packages_identity', "CREATE TRIGGER owners_packages_identity BEFORE UPDATE ON owners_packages WHEN NEW.id<>OLD.id OR NEW.creator_id<>OLD.creator_id OR NEW.version<>OLD.version+1 BEGIN SELECT RAISE(ABORT,'Owners package identity is immutable and versions must advance'); END"],
  ['trigger', 'owners_packages_no_delete', "CREATE TRIGGER owners_packages_no_delete BEFORE DELETE ON owners_packages BEGIN SELECT RAISE(ABORT,'Owners packages must be archived'); END"],
  ['trigger', 'owners_history_no_update', "CREATE TRIGGER owners_history_no_update BEFORE UPDATE ON owners_history BEGIN SELECT RAISE(ABORT,'Owners history is immutable'); END"],
  ['trigger', 'owners_history_no_delete', "CREATE TRIGGER owners_history_no_delete BEFORE DELETE ON owners_history BEGIN SELECT RAISE(ABORT,'Owners history is immutable'); END"],
  ['trigger', 'owners_operations_no_update', "CREATE TRIGGER owners_operations_no_update BEFORE UPDATE ON owners_operations BEGIN SELECT RAISE(ABORT,'Owners operations are immutable'); END"],
  ['trigger', 'owners_operations_no_delete', "CREATE TRIGGER owners_operations_no_delete BEFORE DELETE ON owners_operations BEGIN SELECT RAISE(ABORT,'Owners operations are immutable'); END"],
] as const;
export function initializeOwners(database: DatabaseSync): void {
  database.exec('SAVEPOINT owners_schema');
  try {
    for (const [type, name, sql] of schema) {
      const rows = database.prepare('SELECT type,sql FROM sqlite_master WHERE name=?').all(name) as { type: string; sql: string }[];
      const normalize = (value: string) => value.replace(/\s+/g, ' ').trim().replace(/;$/, '');
      if (rows.length && (rows.length !== 1 || rows[0]!.type !== type || normalize(rows[0]!.sql) !== normalize(sql))) throw new Error(`Unexpected ${name} schema; Owners migration was not applied.`);
      if (!rows.length) database.exec(sql);
    }
    database.exec('RELEASE owners_schema');
  } catch (error) { database.exec('ROLLBACK TO owners_schema; RELEASE owners_schema'); throw error; }
}
export interface OwnersAuthority {
  principalEnabled(id: string): boolean;
  canViewRepository(repositoryId: string, principalId: string): boolean;
  canEditRepository(repositoryId: string, principalId: string): boolean;
  canViewProject(projectId: string, principalId: string): boolean;
  projectMemberIds(projectId: string): string[];
}
const unavailable = () => new HttpError(404, 'Owners package is unavailable.');
const invalid = () => new HttpError(409, 'Owners package evidence cannot be verified.');
/** Current local grants/authority must be deliberately handed off before sign-in activation.
 * Creator attribution is historical; an enabled explicit owner can keep a transferred package. */
export function localOwnersPackageIds(database: DatabaseSync, principal: string): string[] {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='owners_packages'").get()) return [];
  const rows = database.prepare('SELECT p.id,p.creator_id,p.data,h.authority_id FROM owners_packages p LEFT JOIN owners_history h ON h.package_id=p.id AND h.version=p.version').all() as { id: string; creator_id: string; data: string; authority_id: string | null }[];
  return rows.filter(row => {
    if (!row.authority_id) throw invalid();
    const value = JSON.parse(row.data) as OwnersPackage, owners = ownersDefinition(value).owners;
    if (row.authority_id === principal || owners.some(owner => owner.kind === 'person' && owner.id === principal)) return true;
    if (row.creator_id !== principal) return false;
    const handedOff = database.prepare('SELECT authority_id FROM owners_history WHERE package_id=? AND actor_id=? ORDER BY version DESC LIMIT 1').get(row.id, 'operator:' + principal.slice(6)) as { authority_id: string } | undefined;
    if (handedOff && database.prepare('SELECT 1 FROM auth_accounts WHERE id=? AND disabled=0').get(handedOff.authority_id)) return false;
    return !owners.some(owner => (owner.kind === 'person' ? [owner.id] : effectiveMembers(database, owner.id)).some(id => id !== principal && !!database.prepare('SELECT 1 FROM auth_accounts WHERE id=? AND disabled=0').get(id)));
  }).map(row => row.id);
}
interface PackageRow { id: string; creator_id: string; version: number; data: string }
interface HistoryRow { package_id: string; version: number; actor_id: string; actor_name: string; snapshot: string }
export class OwnersStore {
  constructor(private readonly database: DatabaseSync, readonly authority: OwnersAuthority, private readonly clock = Date.now) {}
  private packageValue(raw: string, id: string, version: number, creatorId?: string): OwnersPackage {
    try {
      const value = JSON.parse(raw) as OwnersPackage, definition = ownersDefinition(value);
      if (!isOwnersId(value.id) || value.id !== id || value.version !== version || !Number.isSafeInteger(version) || version < 1 || typeof value.creatorId !== 'string' || !value.creatorId || creatorId !== undefined && value.creatorId !== creatorId
        || !Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.updatedAt)) || !isDeepStrictEqual(value, { ...definition, id: value.id, creatorId: value.creatorId, version, createdAt: value.createdAt, updatedAt: value.updatedAt })) throw invalid();
      return value;
    } catch { throw invalid(); }
  }
  private raw(id: string): OwnersPackage {
    if (!isOwnersId(id)) throw unavailable();
    const row = this.database.prepare('SELECT * FROM owners_packages WHERE id=?').get(id) as PackageRow | undefined;
    if (!row) throw unavailable();
    const value = this.packageValue(row.data, id, row.version, row.creator_id);
    const history = this.database.prepare('SELECT snapshot FROM owners_history WHERE package_id=? AND version=?').get(id, value.version) as { snapshot: string } | undefined;
    if (!history || history.snapshot !== row.data) throw invalid(); return value;
  }
  /** Immutable evidence lookup. This deliberately supplies no viewing grant. Callers must project it. */
  snapshot(id: string, version: number): OwnersPackage {
    if (!isOwnersId(id) || !Number.isSafeInteger(version) || version < 1) throw unavailable();
    const current = this.raw(id), row = this.database.prepare('SELECT snapshot FROM owners_history WHERE package_id=? AND version=?').get(id, version) as { snapshot: string } | undefined;
    if (!row || version > current.version) throw unavailable(); return this.packageValue(row.snapshot, id, version, current.creatorId);
  }
  resolvedOwners(pkg: OwnersPackage): string[] {
    const ids = new Set<string>();
    for (const owner of pkg.owners) {
      const principals = owner.kind === 'person' ? [owner.id] : this.authority.projectMemberIds(owner.id);
      for (const principal of principals) if (this.authority.principalEnabled(principal)) ids.add(principal);
    }
    return [...ids].sort();
  }
  private referencesVisible(pkg: OwnersDefinition, principal: string): boolean {
    return pkg.paths.every(path => this.authority.canViewRepository(path.repositoryId, principal))
      && pkg.owners.every(owner => owner.kind === 'person' || this.authority.canViewProject(owner.id, principal));
  }
  private creatorPrincipal(pkg: OwnersPackage): string {
    if (!pkg.creatorId.startsWith('local:')) return pkg.creatorId;
    const transfer = this.database.prepare('SELECT authority_id FROM owners_history WHERE package_id=? AND actor_id=? ORDER BY version DESC LIMIT 1').get(pkg.id, 'operator:' + pkg.creatorId.slice(6)) as { authority_id: string } | undefined;
    return transfer?.authority_id ?? pkg.creatorId;
  }
  canView(pkg: OwnersPackage, principal: string): boolean {
    return this.authority.principalEnabled(principal) && this.referencesVisible(pkg, principal)
      && (pkg.visibility === 'workspace' || this.creatorPrincipal(pkg) === principal || this.resolvedOwners(pkg).includes(principal));
  }
  canEdit(pkg: OwnersPackage, principal: string): boolean {
    return this.canView(pkg, principal) && (this.creatorPrincipal(pkg) === principal || this.resolvedOwners(pkg).includes(principal))
      && pkg.paths.every(path => this.authority.canEditRepository(path.repositoryId, principal));
  }
  get(id: string, principal: string): OwnersPackage { const pkg = this.raw(id); if (!this.canView(pkg, principal)) throw unavailable(); return pkg; }
  requireEdit(id: string, principal: string): OwnersPackage {
    const pkg = this.get(id, principal); if (!this.canEdit(pkg, principal)) throw new HttpError(403, 'Only package owners with edit access to every attached repository can change this package.'); return pkg;
  }
  list(principal: string): OwnersPackage[] {
    return (this.database.prepare('SELECT id FROM owners_packages ORDER BY rowid').all() as { id: string }[]).map(row => this.raw(row.id)).filter(pkg => this.canView(pkg, principal)).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }
  history(id: string, principal: string): OwnersHistoryEntry[] {
    const current = this.get(id, principal);
    return (this.database.prepare('SELECT * FROM owners_history WHERE package_id=? ORDER BY version DESC').all(id) as unknown as HistoryRow[])
      .map(row => ({ package: this.packageValue(row.snapshot, id, row.version, current.creatorId), actorId: row.actor_id, actorName: row.actor_name }))
      .filter(entry => this.canView(entry.package, principal));
  }
  /** A package's latest configuring actor must retain authority. Losing repository edit access,
   * disabling the actor, archiving, or losing a project ceiling suspends future automatic routing. */
  active(): OwnersPackage[] {
    const result: OwnersPackage[] = [];
    for (const row of this.database.prepare('SELECT id FROM owners_packages ORDER BY id').all() as { id: string }[]) {
      const pkg = this.raw(row.id); if (pkg.status !== 'active') continue;
      const editor = this.database.prepare('SELECT authority_id FROM owners_history WHERE package_id=? AND version=?').get(pkg.id, pkg.version) as { authority_id: string };
      if (!this.canEdit(pkg, editor.authority_id)) continue;
      result.push(pkg);
    }
    return result;
  }
  /** Resolve all authoritative claims before filtering for a viewer, so hidden claims never grant ownership. */
  match(repositoryId: string, paths: readonly string[]): OwnersMatch[] { return matchOwners(this.active(), repositoryId, paths); }
  validateDefinition(definition: OwnersDefinition, principal: string): void {
    if (!this.authority.principalEnabled(principal)) throw new HttpError(403, 'An enabled workspace member is required.');
    for (const path of definition.paths) {
      if (!this.authority.canViewRepository(path.repositoryId, principal)) throw new HttpError(404, 'An attached repository is unavailable.');
      if (!this.authority.canEditRepository(path.repositoryId, principal)) throw new HttpError(403, 'Edit access to every attached repository is required to configure its ownership.');
    }
    for (const owner of definition.owners) {
      if (owner.kind === 'person' ? !this.authority.principalEnabled(owner.id) : !this.authority.canViewProject(owner.id, principal)) throw new HttpError(400, 'Choose enabled members or visible projects as owners.');
    }
  }
  create(principal: string, actorName: string, definition: OwnersDefinition): OwnersPackage {
    const parsed = parseOwnersDefinition(definition); this.validateDefinition(parsed, principal);
    const now = new Date(this.clock()).toISOString(), pkg: OwnersPackage = { ...parsed, id: `OWN-${randomUUID()}`, creatorId: principal, version: 1, createdAt: now, updatedAt: now };
    this.database.prepare('INSERT INTO owners_packages(id,creator_id,version,data) VALUES(?,?,?,?)').run(pkg.id, principal, pkg.version, JSON.stringify(pkg));
    this.saveHistory(pkg, principal, actorName); return pkg;
  }
  update(principal: string, actorName: string, id: string, definition: OwnersDefinition, expectedVersion: number): OwnersPackage {
    const before = this.requireEdit(id, principal), parsed = parseOwnersDefinition(definition); this.validateDefinition(parsed, principal);
    if (expectedVersion !== before.version || !Number.isSafeInteger(before.version + 1)) throw new HttpError(409, 'This Owners package changed. Refresh and review the current version before saving.');
    const pkg: OwnersPackage = { ...before, ...parsed, version: before.version + 1, updatedAt: new Date(this.clock()).toISOString() };
    this.database.prepare('UPDATE owners_packages SET version=?,data=? WHERE id=?').run(pkg.version, JSON.stringify(pkg), pkg.id);
    this.saveHistory(pkg, principal, actorName);
    // Owners, dependencies and visibility all change who may retain package content.
    if (before.visibility !== pkg.visibility || !isDeepStrictEqual(before.owners, pkg.owners) || !isDeepStrictEqual(before.paths, pkg.paths)) this.database.prepare("UPDATE policy_meta SET value=value+1 WHERE name='epoch'").run();
    return pkg;
  }
  private saveHistory(pkg: OwnersPackage, principal: string, actorName: string, authorityId = principal): void {
    this.database.prepare('INSERT INTO owners_history(package_id,version,actor_id,actor_name,authority_id,snapshot) VALUES(?,?,?,?,?,?)').run(pkg.id, pkg.version, principal, actorName, authorityId, JSON.stringify(pkg));
  }
  /** Terminal-only callback for Auth's atomic local-policy handoff. Historical creators,
   * requests, routing evidence and old snapshots are never rewritten. */
  transferLocal(fromId: string, toId: string, attribution: ActorAttribution): number {
    if (!fromId.startsWith('local:') || attribution.principalId !== 'operator:' + fromId.slice(6) || !this.authority.principalEnabled(toId) || toId.startsWith('local:')) throw new HttpError(403, 'Owners transfer requires an explicit terminal account handoff.');
    const ids = localOwnersPackageIds(this.database, fromId);
    for (const id of ids) {
      const before = this.raw(id), definition = ownersDefinition(before), selected = new Map<string, OwnersDefinition['owners'][number]>();
      for (const owner of definition.owners) { const value = owner.kind === 'person' && owner.id === fromId ? { ...owner, id: toId } : owner; selected.set(value.kind + ':' + value.id, value); }
      selected.set('person:' + toId, { kind: 'person', id: toId }); definition.owners = [...selected.values()];
      const parsed = parseOwnersDefinition(definition); this.validateDefinition(parsed, toId);
      if (!Number.isSafeInteger(before.version + 1)) throw new HttpError(409, 'An Owners package reached its version limit. No local grants were transferred.');
      const pkg = { ...before, ...parsed, version: before.version + 1, updatedAt: new Date(this.clock()).toISOString() };
      this.database.prepare('UPDATE owners_packages SET version=?,data=? WHERE id=?').run(pkg.version, JSON.stringify(pkg), id);
      this.saveHistory(pkg, attribution.principalId, attribution.displayName, toId);
    }
    if (ids.length) this.database.prepare("UPDATE policy_meta SET value=value+1 WHERE name='epoch'").run();
    return ids.length;
  }
  operation(principal: string, hash: string, fingerprint: string): OwnersOperation | null {
    const row = this.database.prepare('SELECT fingerprint,receipt FROM owners_operations WHERE principal_id=? AND request_hash=?').get(principal, hash) as { fingerprint: string; receipt: string } | undefined;
    if (!row) return null;
    if (row.fingerprint !== fingerprint) throw new HttpError(409, 'This request ID was already used for different Owners changes.');
    let receipt: OwnersOperation;
    try { receipt = JSON.parse(row.receipt) as OwnersOperation; } catch { throw invalid(); }
    if (!receipt || Object.keys(receipt).sort().join(',') !== 'action,id,version' || !isOwnersId(receipt.id) || !Number.isSafeInteger(receipt.version) || receipt.version < 1 || !['create', 'update'].includes(receipt.action) || receipt.action === 'create' && receipt.version !== 1) throw invalid();
    const historical = this.snapshot(receipt.id, receipt.version), actor = this.database.prepare('SELECT actor_id FROM owners_history WHERE package_id=? AND version=?').get(receipt.id, receipt.version) as { actor_id: string };
    if (actor.actor_id !== principal || receipt.action === 'create' && historical.creatorId !== principal) throw invalid(); return receipt;
  }
  recordOperation(principal: string, hash: string, fingerprint: string, receipt: OwnersOperation): void {
    this.database.prepare('INSERT INTO owners_operations(principal_id,request_hash,fingerprint,receipt) VALUES(?,?,?,?)').run(principal, hash, fingerprint, JSON.stringify(receipt));
  }
}
export function createOwnersStore(store: Store, auth: Auth, policies: PolicyStore): OwnersStore {
  const entity = (id: string, kind: string) => !!store.database.prepare('SELECT 1 FROM entities WHERE id=? AND kind=?').get(id, kind);
  return new OwnersStore(store.database, {
    principalEnabled: id => auth.mode === 'local' && id === `local:${auth.workspaceId}` || !!store.database.prepare('SELECT 1 FROM auth_accounts WHERE id=? AND disabled=0').get(id),
    canViewRepository: (id, principal) => entity(id, 'repository') && policies.access(id, principal).view,
    canEditRepository: (id, principal) => entity(id, 'repository') && policies.access(id, principal).edit,
    canViewProject: (id, principal) => entity(id, 'project') && policies.access(id, principal).view,
    projectMemberIds: id => entity(id, 'project') ? effectiveMembers(store.database, id) : [],
  });
}
