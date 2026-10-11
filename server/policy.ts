import type { DatabaseSync } from 'node:sqlite';
import type { Audience, Capability, ProjectCapability, ProjectAudience, EffectiveAccess, ObjectAccess, ObjectPolicy, PolicyRules, Space } from '../shared/policy.ts';
import { audienceLabel, effectiveAccess, spaceAccess } from '../shared/policy.ts';
import { HttpError, integer, object, optionalString, string } from './validation.ts';
import { ancestorIds, effectiveMember, hierarchy } from './project-graph.ts';

type JsonRow = { data: string };
type PolicyRow = { data: string; space_data: string; owner_id: string | null; entity_kind: string; entity_data: string };
type ResolvedPolicy = { policy: ObjectPolicy; space: Space; capabilities: EffectiveAccess; ownerId: string | null; repositoryId?: string; parentId?: string; inheritedFrom?: { projectId: string; policyVersion: number } };
type Traversal = { remaining: number };
/** Per decision: policy nodes, active attachment edges and distinct source File checks. */
export const POLICY_TRAVERSAL_MAX_WORK = 1024;
const traversalExhausted = Symbol('permission traversal exhausted');
function consume(traversal: Traversal): void {
  if (traversal.remaining-- <= 0) throw traversalExhausted;
}
export interface PolicyStoreOptions { principalExists: (id: string) => boolean }
const workspace = (): Audience => ({ kind: 'workspace' });
const sharedRules = (): PolicyRules => ({ view: workspace(), edit: workspace(), interact: workspace() });
const denied = (): EffectiveAccess => ({ view: false, edit: false, interact: false, managePolicy: false });
const notFound = () => new HttpError(404, 'Object was not found.', 'OBJECT_UNAVAILABLE');
const isSpaceId = (id: string) => /^S[1-9]\d{0,14}$/.test(id);
const isObjectId = (id: string) => /^(?:PROJ|R|D|P|L|T|W|F)[1-9]\d{0,14}$/.test(id);
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
  const policy: ObjectPolicy = id.startsWith('PROJ') ? { kind: 'project', objectId: id, spaceId: 'S1', version: 1, rules: { ...sharedRules(), join: workspace() } } : { objectId: id, spaceId: 'S1', version: 1, rules: sharedRules() };
  database.prepare('INSERT INTO object_policies (object_id, space_id, data) VALUES (?, ?, ?)').run(id, 'S1', JSON.stringify(policy));
}

/** Uploads begin private. Automatic author access remains bounded by Space. */
export function registerFilePolicy(database: DatabaseSync, id: string, authorId: string): void {
  const audience: Audience = { kind: 'principals', principalIds: [authorId] };
  const policy: ObjectPolicy = { objectId: id, spaceId: 'S1', version: 1, rules: { view: audience, edit: audience, interact: audience } };
  database.prepare('INSERT INTO object_policies(object_id, space_id, data) VALUES (?, ?, ?)').run(id, 'S1', JSON.stringify(policy));
  database.prepare("UPDATE policy_meta SET value = value + 1 WHERE name = 'epoch'").run();
}

/** Schema 11 migration: enrich current project rules, never historical evidence. */
export function upgradeProjectPolicies(database: DatabaseSync): void {
  for (const row of database.prepare("SELECT p.object_id, p.data FROM object_policies p JOIN entities e ON e.id = p.object_id WHERE e.kind = 'project'").all() as { object_id: string; data: string }[]) {
    const policy = JSON.parse(row.data) as ObjectPolicy;
    if (policy.kind === 'project') continue;
    database.prepare('UPDATE object_policies SET data = ? WHERE object_id = ?').run(JSON.stringify({ ...policy, kind: 'project', rules: { ...policy.rules, join: workspace() } }), row.object_id);
  }
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
    if (!/^[TF][1-9]\d*$/.test(id)) return null;
    const row = this.database.prepare("SELECT CASE WHEN kind = 'file' THEN json_extract(data, '$.authorId') ELSE json_extract(data, '$.ownerId') END AS owner_id FROM entities WHERE id = ?").get(id) as { owner_id: unknown } | undefined;
    return typeof row?.owner_id === 'string' ? row.owner_id : null;
  }
  private projectMember(id: string, principalId: string): boolean {
    if (!id.startsWith('PROJ') || !this.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_relations'").get()) return false;
    if (this.hasHierarchy()) return effectiveMember(this.database, id, principalId);
    return Boolean(this.database.prepare("SELECT 1 FROM project_relations WHERE project_id = ? AND principal_id = ? AND relation = 'member' AND active = 1").get(id, principalId));
  }
  private hasHierarchy(): boolean { return Boolean(this.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_hierarchy'").get()); }
  private projectGraph(id: string) {
    if (!id.startsWith('PROJ') || !this.hasHierarchy()) return undefined;
    const graph = hierarchy(this.database, id); if (!graph) throw notFound();
    ancestorIds(this.database, id); return graph;
  }
  /** Exhaustion invalidates the whole decision, including otherwise successful sibling branches. */
  private resolve(id: string, principalId: string): ResolvedPolicy | undefined {
    try { return this.resolved(id, principalId, new Set(), { remaining: POLICY_TRAVERSAL_MAX_WORK }); }
    catch (error) { if (error === traversalExhausted) return undefined; throw error; }
  }
  private *fileCandidates(id: string, traversal: Traversal): Generator<string> {
    let after = '';
    for (;;) {
      const rows = this.database.prepare("SELECT object_id FROM file_attachments WHERE file_id = ? AND mode = 'attach' AND object_id > ? ORDER BY object_id LIMIT ?").all(id, after, Math.min(32, traversal.remaining + 1)) as { object_id: string }[];
      for (const row of rows) { consume(traversal); after = row.object_id; yield row.object_id; }
      if (rows.length < 32) return;
    }
  }
  private figureDependencies(id: string, traversal: Traversal): { file_id: unknown }[] {
    // History scanning is linear; only distinct dependencies consume graph work.
    // LIMIT also bounds materialized output, without loading text snapshots into JS.
    // Invalid non-array manifests/entries yield NULL and fail closed below.
    return this.database.prepare(`
      SELECT DISTINCT CASE WHEN json_type(v.data, '$.assets') = 'array' AND a.type = 'object'
        THEN json_extract(a.value, '$.fileId') END AS file_id
      FROM versions v LEFT JOIN json_each(v.data, '$.assets') a
      WHERE v.revision_id = ? AND json_type(v.data, '$.assets') IS NOT NULL
        AND json_extract(v.data, '$.assets') <> '[]'
      LIMIT ?
    `).all(id, traversal.remaining + 1) as { file_id: unknown }[];
  }
  private resolved(id: string, principalId: string, seen: Set<string>, traversal: Traversal): ResolvedPolicy | undefined {
    consume(traversal);
    if (!isObjectId(id) || !this.member(principalId)) return undefined;
    if (seen.has(id) || seen.size >= 16) return undefined;
    seen.add(id);
    const row = this.database.prepare("SELECT p.data, s.data AS space_data, e.kind AS entity_kind, e.data AS entity_data, CASE WHEN e.kind = 'task' THEN json_extract(e.data, '$.ownerId') WHEN e.kind = 'file' THEN json_extract(e.data, '$.authorId') ELSE NULL END AS owner_id FROM object_policies p JOIN policy_spaces s ON s.id = p.space_id JOIN entities e ON e.id = p.object_id WHERE p.object_id = ?").get(id) as PolicyRow | undefined;
    if (!row) return undefined;
    const policy = JSON.parse(row.data) as ObjectPolicy; const space = JSON.parse(row.space_data) as Space;
    const ownerId = typeof row.owner_id === 'string' ? row.owner_id : null;
    try {
      let repositoryId: string | undefined;
      if (row.entity_kind === 'revision') {
        const entity: unknown = JSON.parse(row.entity_data);
        if (!entity || typeof entity !== 'object' || Array.isArray(entity)) return undefined;
        const dependency: unknown = (entity as { repositoryId?: unknown }).repositoryId;
        if (dependency !== null) {
          if (typeof dependency !== 'string' || !/^R[1-9]\d{0,14}$/.test(dependency)
            || !this.database.prepare("SELECT 1 FROM entities WHERE id = ? AND kind = 'repository'").get(dependency)
            || !this.resolved(dependency, principalId, new Set(seen), traversal)?.capabilities.view) return undefined;
          repositoryId = dependency;
        }
      }
      const graph = this.projectGraph(id);
      const parent = graph?.parentId ? this.resolved(graph.parentId, principalId, new Set(seen), traversal) : undefined;
      if (graph?.parentId && !parent) return undefined;
      if (graph?.kind === 'milestone') {
        if (!parent || parent.policy.kind !== 'project' || !graph.parentId) return undefined;
        return { policy: { ...parent.policy, objectId: id }, space: parent.space, capabilities: { ...parent.capabilities, managePolicy: false }, ownerId: null, parentId: graph.parentId, inheritedFrom: { projectId: graph.parentId, policyVersion: parent.policy.version } };
      }
      let capabilities = effectiveAccess(policy, space, principalId, ownerId === principalId, this.projectMember(id, principalId), parent?.capabilities);
      if (row.entity_kind === 'file' && !capabilities.view && spaceAccess(space, principalId).view) {
        for (const objectId of this.fileCandidates(id, traversal)) {
          if (this.resolved(objectId, principalId, new Set(seen), traversal)?.capabilities.view) { capabilities = { ...capabilities, view: true }; break; }
        }
      }
      if (row.entity_kind === 'revision' && capabilities.view) {
        // Detail/export contain historical versions, so each immutable source
        // dependency must still be visible, not only the current manifest.
        for (const { file_id: fileId } of this.figureDependencies(id, traversal)) {
          if (typeof fileId !== 'string' || !this.sourceFileVisible(fileId, id, principalId, seen, traversal)) return undefined;
        }
      }
      return { policy, space, capabilities, ownerId, ...(repositoryId ? { repositoryId } : {}), ...(graph?.parentId ? { parentId: graph.parentId } : {}) };
    } catch (error) {
      if (error instanceof HttpError) return undefined;
      throw error;
    }
  }
  private sourceFileVisible(fileId: string, revisionId: string, principalId: string, seen: Set<string>, traversal: Traversal): boolean {
    consume(traversal);
    if (!/^F[1-9]\d{0,14}$/.test(fileId)) return false;
    const row = this.database.prepare("SELECT p.data, s.data AS space_data, json_extract(e.data, '$.authorId') AS author_id FROM object_policies p JOIN policy_spaces s ON s.id = p.space_id JOIN entities e ON e.id = p.object_id AND e.kind = 'file' WHERE p.object_id = ?").get(fileId) as { data: string; space_data: string; author_id: string } | undefined;
    if (!row) return false;
    const policy = JSON.parse(row.data) as ObjectPolicy; const space = JSON.parse(row.space_data) as Space;
    if (!spaceAccess(space, principalId).view) return false;
    if (effectiveAccess(policy, space, principalId, row.author_id === principalId).view) return true;
    // The revision's own rules and other dependencies are checked by resolved.
    // A reviewed direct attachment supplies the grant without recursing P→F→P.
    if (this.database.prepare("SELECT 1 FROM file_attachments WHERE file_id = ? AND object_id = ? AND mode = 'attach'").get(fileId, revisionId)) return true;
    return this.resolved(fileId, principalId, new Set(seen), traversal)?.capabilities.view ?? false;
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
    return this.resolve(id, principalId)?.capabilities ?? denied();
  }
  require(id: string, principalId: string, capability: ProjectCapability): void {
    const access = this.access(id, principalId);
    if (!access.view) throw notFound();
    if (!access[capability]) throw new HttpError(403, `This object does not allow ${capability} access.`, 'ACTION_FORBIDDEN');
  }
  policy(id: string, principalId: string): ObjectPolicy {
    const result = this.resolve(id, principalId);
    if (!result?.capabilities.view) throw notFound();
    return result.policy;
  }
  describe(id: string, principalId: string): ObjectAccess {
    const result = this.resolve(id, principalId);
    if (!result?.capabilities.view) throw notFound();
    const { policy, space, capabilities, ownerId, repositoryId, parentId, inheritedFrom } = result;
    const label = (capability: Capability) => `${audienceLabel(policy.rules[capability])}${ownerId ? (id.startsWith('F') ? '; file author also has access' : '; task owner also has access') : policy.kind === 'project' && capability === 'view' ? '; project members also have access' : ''}${parentId ? capability === 'edit' ? '; parent project editors also have edit access' : capability === 'view' ? '; requires parent project view access' : '' : ''}${space.view.kind === 'workspace' ? '' : '; limited by Space access'}${capability === 'view' ? '' : '; requires object view access'}${repositoryId ? '; requires linked repository view access' : ''}${id.startsWith('F') && capability === 'view' ? '; viewers of explicitly attached objects also have access, within the File Space' : ''}${inheritedFrom ? '; inherited from parent project' : ''}`;
    return { policy, capabilities, viewLabel: label('view'), editLabel: label('edit'), interactLabel: label('interact'), ...(inheritedFrom ? { inheritedFrom } : {}), ...(policy.kind === 'project' ? { joinLabel: `${audienceLabel(policy.rules.join)}; project editors also may join ordinary leaf projects; requires project and Space view access`, automatic: { kind: 'project-member' as const, ...(parentId ? { parentEditProjectId: parentId } : {}) } } : ownerId ? { automatic: { kind: id.startsWith('F') ? 'file-author' as const : 'task-owner' as const, principalId: ownerId } } : {}) };
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
  private projectAudience(input: unknown): ProjectAudience {
    if (input && typeof input === 'object' && 'kind' in input && input.kind === 'project-members') { object(input, ['kind']); return { kind: 'project-members' }; }
    return this.audience(input);
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
      const graph = this.projectGraph(id);
      if (graph?.kind === 'milestone') throw new HttpError(403, 'Milestones inherit access rules. Change the parent project\'s access rules.', 'ACTION_FORBIDDEN');
      const current = this.policy(id, principalId);
      const project = current.kind === 'project';
      const data = object(input, ['expectedVersion', 'spaceId', 'view', 'edit', 'interact', ...(project ? ['join'] : [])]);
      const space = this.destination(data.spaceId, principalId, current.spaceId);
      const base = { objectId: id, spaceId: space.id, version: this.version(current.version, data.expectedVersion) };
      const policy: ObjectPolicy = project ? { ...base, kind: 'project', rules: { view: this.projectAudience(data.view), edit: this.projectAudience(data.edit), interact: this.projectAudience(data.interact), join: data.join === undefined ? current.rules.join : this.projectAudience(data.join) } } : { ...base, rules: { view: this.audience(data.view), edit: this.audience(data.edit), interact: this.audience(data.interact) } };
      this.retain(effectiveAccess(policy, space, principalId, this.owner(id) === principalId, this.projectMember(id, principalId), graph?.parentId ? this.access(graph.parentId, principalId) : undefined));
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
      const project = current.kind === 'project';
      const graph = this.projectGraph(id);
      const parent = graph?.parentId ? this.resolve(graph.parentId, principalId) : undefined;
      if (graph?.parentId && (!parent || !parent.capabilities.view || !parent.capabilities.edit)) throw notFound();
      if (graph?.kind === 'milestone') {
        if (input !== undefined || !parent) throw new HttpError(400, 'Milestones inherit access rules and Space from their parent.');
        this.destination(parent.space.id, principalId);
        this.save({ ...current, spaceId: parent.space.id });
        return this.policy(id, principalId);
      }
      const data = input === undefined ? {} : object(input, ['spaceId', 'view', 'edit', 'interact', ...(project ? ['join'] : [])]);
      const space = this.destination(input === undefined ? parent?.space.id ?? 'S1' : data.spaceId, principalId);
      const base = { objectId: id, spaceId: space.id, version: 1 };
      const policy: ObjectPolicy = project ? { ...base, kind: 'project', rules: { view: data.view === undefined ? workspace() : this.projectAudience(data.view), edit: data.edit === undefined ? workspace() : this.projectAudience(data.edit), interact: data.interact === undefined ? workspace() : this.projectAudience(data.interact), join: data.join === undefined ? workspace() : this.projectAudience(data.join) } } : { ...base, rules: { view: data.view === undefined ? workspace() : this.audience(data.view), edit: data.edit === undefined ? workspace() : this.audience(data.edit), interact: data.interact === undefined ? workspace() : this.audience(data.interact) } };
      this.retain(effectiveAccess(policy, space, principalId, this.owner(id) === principalId, this.projectMember(id, principalId), parent?.capabilities));
      this.save(policy); return policy;
    });
  }
  private save(policy: ObjectPolicy): void {
    this.database.prepare('UPDATE object_policies SET space_id = ?, data = ? WHERE object_id = ?').run(policy.spaceId, JSON.stringify(policy), policy.objectId);
    this.changed();
  }
}
