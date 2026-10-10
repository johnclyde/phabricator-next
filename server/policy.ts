import type { DatabaseSync } from 'node:sqlite';
import type { Audience, Capability, EffectiveAccess, ObjectAccess, ObjectPolicy, PolicyRules, Space } from '../shared/policy.ts';
import { audienceLabel, effectiveAccess, spaceAccess } from '../shared/policy.ts';
import { HttpError, integer, object, optionalString, string } from './validation.ts';

type JsonRow = { data: string };
type PolicyRow = { data: string; space_data: string; owner_id: string | null };
export interface PolicyStoreOptions { principalExists: (id: string) => boolean }
const workspace = (): Audience => ({ kind: 'workspace' });
const sharedRules = (): PolicyRules => ({ view: workspace(), edit: workspace(), interact: workspace() });
const denied = (): EffectiveAccess => ({ view: false, edit: false, interact: false, managePolicy: false });
const notFound = () => new HttpError(404, 'Object was not found.', 'OBJECT_UNAVAILABLE');
const isSpaceId = (id: string) => /^S[1-9]\d{0,14}$/.test(id);
const isObjectId = (id: string) => /^(?:PROJ|R|D|P|L|T|W)[1-9]\d{0,14}$/.test(id);
let savepointNumber = 0;

function transaction<T>(database: DatabaseSync, work: () => T, lock = true): T {
  const name = `policy_write_${++savepointNumber}`;
  database.exec(`SAVEPOINT ${name}`);
  try {
    // Obtain a write lock before reading permissions. This also composes with
    // the request's outer transaction and concurrent operator processes.
    if (lock) database.prepare("UPDATE policy_meta SET value = value WHERE name = 'epoch'").run();
    const result = work();
    database.exec(`RELEASE ${name}`); return result;
  } catch (error) { database.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
}

/** Schema migration only. Never rerun this to repair a missing policy. */
export function initializePolicies(database: DatabaseSync): void {
  transaction(database, () => {
    database.exec(`
      CREATE TABLE policy_spaces (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE object_policies (object_id TEXT PRIMARY KEY REFERENCES entities(id), space_id TEXT NOT NULL REFERENCES policy_spaces(id), data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE INDEX object_policies_space ON object_policies(space_id);
      CREATE TABLE policy_meta (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
      INSERT INTO policy_meta (name, value) VALUES ('epoch', 1), ('space_sequence', 1);
    `);
    const space: Space = { id: 'S1', name: 'Shared workspace', description: 'The default Space for this workspace.', version: 1, isDefault: true, archived: false, view: workspace(), edit: workspace() };
    database.prepare('INSERT INTO policy_spaces (id, data) VALUES (?, ?)').run(space.id, JSON.stringify(space));
    for (const row of database.prepare('SELECT id FROM entities').all() as { id: string }[]) registerDefaultPolicy(database, row.id);
  }, false);
}

/** Call immediately after inserting a new entity, in the same transaction. */
export function registerDefaultPolicy(database: DatabaseSync, id: string): void {
  const policy: ObjectPolicy = { objectId: id, spaceId: 'S1', version: 1, rules: sharedRules() };
  database.prepare('INSERT INTO object_policies (object_id, space_id, data) VALUES (?, ?, ?)').run(id, 'S1', JSON.stringify(policy));
}

export class PolicyStore {
  constructor(private readonly database: DatabaseSync, private readonly options: PolicyStoreOptions) {}
  epoch(): number { return (this.database.prepare("SELECT value FROM policy_meta WHERE name = 'epoch'").get() as { value: number }).value; }
  private changed(): void { this.database.prepare("UPDATE policy_meta SET value = value + 1 WHERE name = 'epoch'").run(); }
  private member(principalId: string): boolean { return Boolean(principalId) && this.options.principalExists(principalId); }
  private space(id: string): Space | undefined {
    if (!isSpaceId(id)) return undefined;
    const row = this.database.prepare('SELECT data FROM policy_spaces WHERE id = ?').get(id) as JsonRow | undefined;
    return row ? JSON.parse(row.data) as Space : undefined;
  }
  private owner(id: string): string | null {
    if (!/^T[1-9]\d*$/.test(id)) return null;
    const row = this.database.prepare("SELECT json_extract(data, '$.ownerId') AS owner_id FROM entities WHERE id = ?").get(id) as { owner_id: unknown } | undefined;
    return typeof row?.owner_id === 'string' ? row.owner_id : null;
  }
  private resolved(id: string, principalId: string): { policy: ObjectPolicy; space: Space; capabilities: EffectiveAccess; ownerId: string | null } | undefined {
    if (!isObjectId(id) || !this.member(principalId)) return undefined;
    const row = this.database.prepare("SELECT p.data, s.data AS space_data, CASE WHEN substr(e.id, 1, 1) = 'T' THEN json_extract(e.data, '$.ownerId') ELSE NULL END AS owner_id FROM object_policies p JOIN policy_spaces s ON s.id = p.space_id JOIN entities e ON e.id = p.object_id WHERE p.object_id = ?").get(id) as PolicyRow | undefined;
    if (!row) return undefined;
    const policy = JSON.parse(row.data) as ObjectPolicy; const space = JSON.parse(row.space_data) as Space;
    const ownerId = typeof row.owner_id === 'string' ? row.owner_id : null;
    return { policy, space, capabilities: effectiveAccess(policy, space, principalId, ownerId === principalId), ownerId };
  }
  spaces(principalId: string): Space[] {
    if (!this.member(principalId)) return [];
    return (this.database.prepare('SELECT data FROM policy_spaces ORDER BY rowid').all() as JsonRow[])
      .map(row => JSON.parse(row.data) as Space).filter(space => spaceAccess(space, principalId).view);
  }
  getSpace(id: string, principalId: string): Space {
    const space = this.member(principalId) ? this.space(id) : undefined;
    if (!space || !spaceAccess(space, principalId).view) throw notFound();
    return space;
  }
  access(id: string, principalId: string): EffectiveAccess {
    if (isSpaceId(id)) {
      const space = this.member(principalId) ? this.space(id) : undefined;
      return space ? spaceAccess(space, principalId) : denied();
    }
    return this.resolved(id, principalId)?.capabilities ?? denied();
  }
  require(id: string, principalId: string, capability: Capability): void {
    const access = this.access(id, principalId);
    if (!access.view) throw notFound();
    if (!access[capability]) throw new HttpError(403, `This object does not allow ${capability} access.`, 'ACTION_FORBIDDEN');
  }
  policy(id: string, principalId: string): ObjectPolicy {
    const result = this.resolved(id, principalId);
    if (!result?.capabilities.view) throw notFound();
    return result.policy;
  }
  describe(id: string, principalId: string): ObjectAccess {
    const result = this.resolved(id, principalId);
    if (!result?.capabilities.view) throw notFound();
    const { policy, space, capabilities, ownerId } = result;
    const label = (capability: Capability) => `${audienceLabel(policy.rules[capability])}${ownerId ? '; task owner also has access' : ''}${space.view.kind === 'workspace' ? '' : '; limited by Space access'}${capability === 'view' ? '' : '; requires object view access'}`;
    return { policy, capabilities, viewLabel: label('view'), editLabel: label('edit'), interactLabel: label('interact'), ...(ownerId ? { automatic: { kind: 'task-owner' as const, principalId: ownerId } } : {}) };
  }
  private audience(input: unknown): Audience {
    const data = object(input, ['kind', 'principalIds']);
    if (data.kind === 'workspace') {
      if (data.principalIds !== undefined) throw new HttpError(400, 'Workspace audiences do not include principal IDs.');
      return workspace();
    }
    if (data.kind !== 'principals' || !Array.isArray(data.principalIds) || data.principalIds.length > 100) throw new HttpError(400, 'Use a workspace audience or at most 100 selected members.');
    const ids = data.principalIds.map((value: unknown) => {
      if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value) || !this.options.principalExists(value)) throw new HttpError(400, 'Selected members must be valid workspace principals.');
      return value;
    });
    if (new Set(ids).size !== ids.length) throw new HttpError(400, 'Selected members must not contain duplicate IDs.');
    return { kind: 'principals', principalIds: ids.sort() };
  }
  private destination(id: unknown, principalId: string, currentSpaceId?: string): Space {
    if (typeof id !== 'string' || !isSpaceId(id)) throw new HttpError(400, 'Space ID is invalid.');
    const space = this.getSpace(id, principalId);
    if (space.archived && space.id !== currentSpaceId) throw new HttpError(409, 'Archived Spaces cannot receive new objects.');
    return space;
  }
  private retain(access: EffectiveAccess): void {
    if (!access.view || !access.edit) throw new HttpError(400, 'Keep your own view and edit access when changing policies.');
  }
  private version(current: number, expected: unknown): number {
    if (integer(expected, 'expectedVersion') !== current) throw new HttpError(409, 'This policy changed. Reload before saving.');
    if (!Number.isSafeInteger(current + 1)) throw new HttpError(409, 'This policy has reached the supported version limit.');
    return current + 1;
  }
  createSpace(input: unknown, principalId: string): Space {
    return transaction(this.database, () => {
      if (!this.member(principalId)) throw notFound();
      const data = object(input, ['name', 'description', 'view', 'edit']);
      const own: Audience = { kind: 'principals', principalIds: [principalId] };
      const space: Space = { id: '', name: string(data.name, 'Name', 120), description: optionalString(data.description, 'Description', 10_000), version: 1, isDefault: false, archived: false, view: data.view === undefined ? own : this.audience(data.view), edit: data.edit === undefined ? own : this.audience(data.edit) };
      this.retain(spaceAccess(space, principalId));
      const sequence = this.database.prepare("UPDATE policy_meta SET value = value + 1 WHERE name = 'space_sequence' RETURNING value").get() as { value: number };
      if (!Number.isSafeInteger(sequence.value) || sequence.value > 999_999_999_999_999) throw new HttpError(409, 'This workspace has reached the supported Space limit.');
      space.id = `S${sequence.value}`;
      this.database.prepare('INSERT INTO policy_spaces (id, data) VALUES (?, ?)').run(space.id, JSON.stringify(space));
      this.changed(); return space;
    });
  }
  updateSpace(id: string, input: unknown, principalId: string): Space {
    return transaction(this.database, () => {
      const current = this.getSpace(id, principalId);
      this.require(id, principalId, 'edit');
      const data = object(input, ['expectedVersion', 'name', 'description', 'view', 'edit', 'archived']);
      if (Object.keys(data).every(key => key === 'expectedVersion')) throw new HttpError(400, 'At least one Space field is required.');
      if (data.archived !== undefined && typeof data.archived !== 'boolean') throw new HttpError(400, 'Archived must be a boolean.');
      if (current.isDefault && data.archived === true) throw new HttpError(400, 'The default Space cannot be archived.');
      const space: Space = { ...current, version: this.version(current.version, data.expectedVersion), name: data.name === undefined ? current.name : string(data.name, 'Name', 120), description: optionalString(data.description, 'Description', 10_000, current.description), view: data.view === undefined ? current.view : this.audience(data.view), edit: data.edit === undefined ? current.edit : this.audience(data.edit), archived: data.archived === undefined ? current.archived : data.archived };
      this.retain(spaceAccess(space, principalId));
      this.database.prepare('UPDATE policy_spaces SET data = ? WHERE id = ?').run(JSON.stringify(space), id);
      this.changed(); return space;
    });
  }
  setPolicy(id: string, input: unknown, principalId: string): ObjectPolicy {
    return transaction(this.database, () => {
      this.require(id, principalId, 'edit');
      const current = this.policy(id, principalId);
      const data = object(input, ['expectedVersion', 'spaceId', 'view', 'edit', 'interact']);
      const space = this.destination(data.spaceId, principalId, current.spaceId);
      const policy: ObjectPolicy = { objectId: id, spaceId: space.id, version: this.version(current.version, data.expectedVersion), rules: { view: this.audience(data.view), edit: this.audience(data.edit), interact: this.audience(data.interact) } };
      this.retain(effectiveAccess(policy, space, principalId, this.owner(id) === principalId));
      this.save(policy); return policy;
    });
  }
  /** Initial policy for an entity just created by the caller's transaction. */
  configureNew(id: string, input: unknown | undefined, principalId: string): ObjectPolicy {
    return transaction(this.database, () => {
      if (!this.member(principalId) || !isObjectId(id)) throw notFound();
      const row = this.database.prepare('SELECT data FROM object_policies WHERE object_id = ?').get(id) as JsonRow | undefined;
      if (!row) throw notFound();
      const current = JSON.parse(row.data) as ObjectPolicy;
      if (current.version !== 1) throw new HttpError(409, 'Initial access can only be configured for a new object.');
      const data = input === undefined ? {} : object(input, ['spaceId', 'view', 'edit', 'interact']);
      const space = this.destination(input === undefined ? 'S1' : data.spaceId, principalId);
      const policy: ObjectPolicy = { objectId: id, spaceId: space.id, version: 1, rules: { view: data.view === undefined ? workspace() : this.audience(data.view), edit: data.edit === undefined ? workspace() : this.audience(data.edit), interact: data.interact === undefined ? workspace() : this.audience(data.interact) } };
      this.retain(effectiveAccess(policy, space, principalId, this.owner(id) === principalId));
      this.save(policy); return policy;
    });
  }
  private save(policy: ObjectPolicy): void {
    this.database.prepare('UPDATE object_policies SET space_id = ?, data = ? WHERE object_id = ?').run(policy.spaceId, JSON.stringify(policy), policy.objectId);
    this.changed();
  }
}
