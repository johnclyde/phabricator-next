import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Activity, ActorAttribution } from '../shared/types.ts';
import type { Project, ProjectDetail, ProjectFieldChange, ProjectHistory, ProjectMembersPage, ProjectPreferences, ProjectRelation, ProjectRelationStatus, ProjectSnapshot, ProjectTransaction, ProjectWatchersPage } from '../shared/projects.ts';
import { isValidProjectSlug, normalizeProjectSlug, PROJECT_COLORS, PROJECT_COLOR_HEX, PROJECT_ICONS } from '../shared/projects.ts';
import { choice, HttpError, integer, object, optionalString, string } from './validation.ts';
import { registerDefaultPolicy } from './policy.ts';

type JsonRow = { data: string };
type RelationRow = { principal_id: string; relation: ProjectRelation; active: number; version: number; updated_at: string };
type TransactionData = Pick<ProjectTransaction, 'kind' | 'snapshot' | 'changes' | 'relation'>;
interface ProjectStoreOptions {
  nextId: () => string;
  event: (id: string, action: string, detail: string, attribution?: ActorAttribution) => void;
  activities: (id: string) => Activity[];
}
let savepoint = 0;

function nonnegative(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new HttpError(400, `${field} must be a nonnegative integer.`);
  return value;
}
function increment(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(value + 1)) throw new HttpError(409, `This project has reached the supported ${field} limit.`);
  return value + 1;
}
function principal(value: unknown): string {
  const id = string(value, 'Principal ID', 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(id)) throw new HttpError(400, 'Invalid principal ID.');
  return id;
}
function principals(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100) throw new HttpError(400, 'Provide at most 100 principal IDs.');
  const ids = value.map(principal);
  if (new Set(ids).size !== ids.length) throw new HttpError(400, 'Principal IDs must be unique.');
  return ids.sort();
}
function slug(value: unknown): string {
  const normalized = normalizeProjectSlug(string(value, 'Project alias', 1_024));
  if (!isValidProjectSlug(normalized)) throw new HttpError(400, 'Project aliases must normalize to a nonempty name of at most 128 characters.');
  return normalized;
}
function aliases(value: unknown, primary: string): string[] {
  if (!Array.isArray(value) || value.length > 100) throw new HttpError(400, 'Provide at most 100 project aliases.');
  return [...new Set(value.map(slug))].filter(value => value !== primary).sort();
}
function colorFields(data: Record<string, unknown>, current?: Project): Pick<Project, 'color' | 'colorKey'> {
  if ('color' in data && 'colorKey' in data) throw new HttpError(400, 'Choose a named color or a custom color, not both.');
  if ('colorKey' in data) {
    const colorKey = choice(data.colorKey, 'project color', PROJECT_COLORS);
    return { colorKey, color: PROJECT_COLOR_HEX[colorKey] };
  }
  if ('color' in data) {
    const color = string(data.color, 'Color', 7).toLowerCase();
    if (!/^#[a-f\d]{6}$/.test(color)) throw new HttpError(400, 'Color must be a six-digit hexadecimal color.');
    return { color, colorKey: null };
  }
  return current ? { color: current.color, colorKey: current.colorKey } : { colorKey: 'blue', color: PROJECT_COLOR_HEX.blue };
}

/** One-time schema migration. Existing entities and saved responses remain byte-for-byte historical. */
export function initializeProjects(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE project_profiles (project_id TEXT PRIMARY KEY REFERENCES entities(id), data TEXT NOT NULL CHECK(json_valid(data)), members_version INTEGER NOT NULL DEFAULT 0 CHECK(members_version >= 0));
    CREATE TABLE project_aliases (slug TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES entities(id));
    CREATE INDEX project_aliases_project ON project_aliases(project_id, slug);
    CREATE TABLE project_relations (project_id TEXT NOT NULL REFERENCES entities(id), principal_id TEXT NOT NULL, relation TEXT NOT NULL CHECK(relation IN ('member','watcher','silenced')), active INTEGER NOT NULL CHECK(active IN (0,1)), version INTEGER NOT NULL CHECK(version > 0), updated_at TEXT NOT NULL, PRIMARY KEY(project_id, principal_id, relation));
    CREATE INDEX project_relations_principal ON project_relations(principal_id, relation, active, project_id);
    CREATE TABLE project_transactions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES entities(id), sequence INTEGER NOT NULL CHECK(sequence > 0), project_version INTEGER NOT NULL CHECK(project_version > 0), data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(project_id, sequence));
    CREATE TRIGGER project_transactions_no_update BEFORE UPDATE ON project_transactions BEGIN SELECT RAISE(ABORT, 'Project transactions are immutable'); END;
    CREATE TRIGGER project_transactions_no_delete BEFORE DELETE ON project_transactions BEGIN SELECT RAISE(ABORT, 'Project transactions are immutable'); END;
    CREATE TABLE project_preference_events (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES entities(id), principal_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version > 0), data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(project_id, principal_id, version));
    CREATE TRIGGER project_preference_events_no_update BEFORE UPDATE ON project_preference_events BEGIN SELECT RAISE(ABORT, 'Project preference events are immutable'); END;
    CREATE TRIGGER project_preference_events_no_delete BEFORE DELETE ON project_preference_events BEGIN SELECT RAISE(ABORT, 'Project preference events are immutable'); END;
  `);
  const records = (database.prepare("SELECT data FROM entities WHERE kind = 'project' ORDER BY id").all() as JsonRow[]).map(row => JSON.parse(row.data) as ProjectSnapshot);
  const counts = new Map<string, number>();
  for (const record of records) {
    const candidate = normalizeProjectSlug(record.name);
    if (isValidProjectSlug(candidate)) counts.set(candidate, (counts.get(candidate) ?? 0) + 1);
  }
  const reserved = new Set(counts.keys());
  for (const record of records) {
    const candidate = normalizeProjectSlug(record.name);
    const generated = counts.get(candidate) !== 1 || !isValidProjectSlug(candidate);
    let primarySlug = candidate;
    if (generated) {
      const stem = `legacy-${record.id.toLowerCase()}`; primarySlug = stem;
      for (let suffix = 2; reserved.has(primarySlug); suffix++) primarySlug = `${stem}-${suffix}`;
      reserved.add(primarySlug);
    }
    const colorKey = PROJECT_COLORS.find(key => PROJECT_COLOR_HEX[key].toLowerCase() === record.color.toLowerCase()) ?? null;
    const profile: Project = { id: record.id, name: record.name, description: record.description, color: record.color, version: 1, status: 'active', icon: 'project', colorKey, primarySlug, primarySlugSource: generated ? 'generated' : 'name', aliases: [], authorId: null, createdAt: null, updatedAt: null, membershipLocked: false };
    database.prepare('INSERT INTO project_profiles (project_id, data, members_version) VALUES (?, ?, 0)').run(record.id, JSON.stringify(profile));
    database.prepare('INSERT INTO project_aliases (slug, project_id) VALUES (?, ?)').run(primarySlug, record.id);
    const baseline: ProjectTransaction = { id: randomUUID(), projectId: record.id, sequence: 1, projectVersion: 1, kind: 'legacy', actor: null, createdAt: null, snapshot: record };
    database.prepare('INSERT INTO project_transactions (id, project_id, sequence, project_version, data) VALUES (?, ?, 1, 1, ?)').run(baseline.id, record.id, JSON.stringify(baseline));
  }
}

export class ProjectStore {
  constructor(private readonly database: DatabaseSync, private readonly options: ProjectStoreOptions) {}
  private mutation<T>(work: () => T): T {
    const name = `project_write_${++savepoint}`;
    this.database.exec(`SAVEPOINT ${name}`);
    try {
      // Lock before reading metadata or relation versions, including nested callers.
      this.database.prepare("UPDATE sequences SET value = value WHERE name = 'project'").run();
      const result = work(); this.database.exec(`RELEASE ${name}`); return result;
    } catch (error) { this.database.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
  }
  get(id: string): Project {
    const row = this.database.prepare("SELECT p.data FROM project_profiles p JOIN entities e ON e.id = p.project_id AND e.kind = 'project' WHERE p.project_id = ?").get(id) as JsonRow | undefined;
    if (!row) throw new HttpError(404, 'Project was not found.', 'OBJECT_UNAVAILABLE');
    const project = JSON.parse(row.data) as Project;
    project.aliases = (this.database.prepare('SELECT slug FROM project_aliases WHERE project_id = ? AND slug <> ? ORDER BY slug').all(id, project.primarySlug) as { slug: string }[]).map(row => row.slug);
    return project;
  }
  all(): Project[] {
    const values = (this.database.prepare("SELECT p.data FROM entities e JOIN project_profiles p ON p.project_id = e.id WHERE e.kind = 'project' ORDER BY e.rowid DESC").all() as JsonRow[]).map(row => JSON.parse(row.data) as Project);
    const byId = new Map(values.map(project => [project.id, project]));
    for (const project of values) project.aliases = [];
    for (const row of this.database.prepare('SELECT project_id, slug FROM project_aliases ORDER BY slug').all() as { project_id: string; slug: string }[]) {
      const project = byId.get(row.project_id); if (project && project.primarySlug !== row.slug) project.aliases.push(row.slug);
    }
    return values;
  }
  private save(project: Project): void {
    for (const name of [project.primarySlug, ...project.aliases]) {
      const row = this.database.prepare('SELECT project_id FROM project_aliases WHERE slug = ?').get(name) as { project_id: string } | undefined;
      if (row && row.project_id !== project.id) throw new HttpError(409, 'A project name or alias is already in use.');
    }
    this.database.prepare('INSERT INTO project_profiles (project_id, data, members_version) VALUES (?, ?, 0) ON CONFLICT(project_id) DO UPDATE SET data = excluded.data').run(project.id, JSON.stringify({ ...project, aliases: [] }));
    this.database.prepare('DELETE FROM project_aliases WHERE project_id = ?').run(project.id);
    for (const name of [project.primarySlug, ...project.aliases]) this.database.prepare('INSERT INTO project_aliases (slug, project_id) VALUES (?, ?)').run(name, project.id);
  }
  private append(project: Project, data: TransactionData, attribution?: ActorAttribution, now = new Date().toISOString()): ProjectTransaction {
    const row = this.database.prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM project_transactions WHERE project_id = ?').get(project.id) as { sequence: number };
    const transaction: ProjectTransaction = { id: randomUUID(), projectId: project.id, sequence: increment(row.sequence, 'history'), projectVersion: project.version, actor: attribution?.displayName ?? 'You', ...(attribution ? { attribution } : {}), createdAt: now, ...data };
    this.database.prepare('INSERT INTO project_transactions (id, project_id, sequence, project_version, data) VALUES (?, ?, ?, ?, ?)').run(transaction.id, project.id, transaction.sequence, project.version, JSON.stringify(transaction));
    return transaction;
  }
  create(input: unknown, attribution?: ActorAttribution): Project {
    return this.mutation(() => {
      const data = object(input, ['name', 'description', 'color', 'colorKey', 'icon', 'aliases', 'memberIds']);
      const name = string(data.name, 'Name'); const primarySlug = slug(name); const now = new Date().toISOString();
      const memberIds = data.memberIds === undefined ? [] : principals(data.memberIds);
      const project: Project = { id: this.options.nextId(), name, description: optionalString(data.description, 'Description'), ...colorFields(data), version: 1, status: 'active', icon: data.icon === undefined ? 'project' : choice(data.icon, 'project icon', PROJECT_ICONS), primarySlug, primarySlugSource: 'name', aliases: data.aliases === undefined ? [] : aliases(data.aliases, primarySlug), authorId: attribution?.principalId ?? null, createdAt: now, updatedAt: now, membershipLocked: false };
      const { id, description, color } = project;
      this.database.prepare("INSERT INTO entities (id, kind, data) VALUES (?, 'project', ?)").run(id, JSON.stringify({ id, name, description, color }));
      registerDefaultPolicy(this.database, id); this.save(project); this.append(project, { kind: 'create', snapshot: project }, attribution, now);
      this.options.event(id, 'created', `Created project ${name}.`, attribution);
      this.changeMembers(project, memberIds, [], 'initial', attribution, now);
      return project;
    });
  }
  update(id: string, input: unknown, attribution?: ActorAttribution): ProjectDetail {
    return this.mutation(() => {
      const project = this.get(id); const data = object(input, ['expectedVersion', 'name', 'description', 'status', 'icon', 'color', 'colorKey', 'aliases']);
      if (integer(data.expectedVersion, 'expectedVersion') !== project.version) throw new HttpError(409, 'This project changed. Reload before saving.');
      if (Object.keys(data).length === 1) throw new HttpError(400, 'At least one project field is required.');
      const name = data.name === undefined ? project.name : string(data.name, 'Name');
      const renamed = name !== project.name; const primarySlug = renamed ? slug(name) : project.primarySlug;
      let nextAliases = data.aliases === undefined ? project.aliases : aliases(data.aliases, primarySlug);
      nextAliases = [...new Set([...nextAliases, ...(renamed ? [project.primarySlug] : [])])].filter(value => value !== primarySlug).sort();
      const values = { name, description: optionalString(data.description, 'Description', 100_000, project.description), status: data.status === undefined ? project.status : choice(data.status, 'project status', ['active', 'archived'] as const), icon: data.icon === undefined ? project.icon : choice(data.icon, 'project icon', PROJECT_ICONS), ...colorFields(data, project), primarySlug, aliases: nextAliases };
      const changes: ProjectFieldChange[] = [];
      for (const field of ['name', 'description', 'status', 'icon', 'color', 'colorKey', 'primarySlug', 'aliases'] as const) if (JSON.stringify(project[field]) !== JSON.stringify(values[field])) changes.push({ field, oldValue: project[field], newValue: values[field] });
      if (changes.length) {
        const now = new Date().toISOString(); const updated: Project = { ...project, ...values, ...(renamed ? { primarySlugSource: 'name' as const } : {}), version: increment(project.version, 'version'), updatedAt: now };
        this.save(updated); this.append(updated, { kind: 'edit', changes }, attribution, now); this.options.event(id, 'updated', 'Updated project profile.', attribution);
      }
      return this.detail(id, attribution?.principalId ?? '');
    });
  }
  detail(id: string, viewerId: string): ProjectDetail {
    return { project: this.get(id), history: this.history(id), viewer: this.preferences(id, viewerId), membersVersion: this.membersVersion(id), activity: this.options.activities(id) };
  }
  history(id: string, before?: number, limit = 50): ProjectHistory {
    this.get(id); if (before !== undefined) integer(before, 'before'); integer(limit, 'limit');
    if (limit > 100) throw new HttpError(400, 'History limit must be at most 100.');
    const rows = this.database.prepare('SELECT data FROM project_transactions WHERE project_id = ? AND (? IS NULL OR sequence < ?) ORDER BY sequence DESC LIMIT ?').all(id, before ?? null, before ?? null, limit + 1) as JsonRow[];
    const transactions = rows.slice(0, limit).map(row => JSON.parse(row.data) as ProjectTransaction);
    const first = this.database.prepare('SELECT MIN(sequence) AS sequence FROM project_transactions WHERE project_id = ?').get(id) as { sequence: number | null };
    return { transactions, nextBefore: rows.length > limit ? transactions.at(-1)!.sequence : null, firstAvailableSequence: first.sequence };
  }
  private membersVersion(id: string): number { return (this.database.prepare('SELECT members_version FROM project_profiles WHERE project_id = ?').get(id) as { members_version: number }).members_version; }
  private relation(id: string, principalId: string, relation: ProjectRelation): ProjectRelationStatus {
    const row = this.database.prepare('SELECT principal_id, relation, active, version, updated_at FROM project_relations WHERE project_id = ? AND principal_id = ? AND relation = ?').get(id, principalId, relation) as RelationRow | undefined;
    return { projectId: id, principalId, relation, active: !!row?.active, version: row?.version ?? 0, updatedAt: row?.updated_at ?? null };
  }
  preferences(id: string, viewerId: string): ProjectPreferences {
    this.get(id); return { projectId: id, membership: this.relation(id, viewerId, 'member'), watching: this.relation(id, viewerId, 'watcher'), silence: this.relation(id, viewerId, 'silenced') };
  }
  private page(id: string, relation: 'member' | 'watcher', after: string | undefined, limit: number): { rows: ProjectRelationStatus[]; nextAfter: string | null } {
    this.get(id); if (after !== undefined) principal(after); integer(limit, 'limit');
    if (limit > 100) throw new HttpError(400, 'Page limit must be at most 100.');
    const raw = this.database.prepare('SELECT principal_id, relation, active, version, updated_at FROM project_relations WHERE project_id = ? AND relation = ? AND active = 1 AND (? IS NULL OR principal_id > ?) ORDER BY principal_id LIMIT ?').all(id, relation, after ?? null, after ?? null, limit + 1) as RelationRow[];
    const rows = raw.slice(0, limit).map(row => ({ projectId: id, principalId: row.principal_id, relation: row.relation, active: !!row.active, version: row.version, updatedAt: row.updated_at }));
    return { rows, nextAfter: raw.length > limit ? rows.at(-1)!.principalId : null };
  }
  members(id: string, viewerId: string, after?: string, limit = 50): ProjectMembersPage {
    const page = this.page(id, 'member', after, limit);
    return { members: page.rows, collectionVersion: this.membersVersion(id), nextAfter: page.nextAfter, viewer: this.preferences(id, viewerId) };
  }
  watchers(id: string, viewerId: string, after?: string, limit = 50): ProjectWatchersPage {
    const page = this.page(id, 'watcher', after, limit);
    return { watchers: page.rows, nextAfter: page.nextAfter, viewer: this.preferences(id, viewerId) };
  }
  private writeRelation(id: string, principalId: string, relation: ProjectRelation, active: boolean, now: string): ProjectRelationStatus {
    const old = this.relation(id, principalId, relation);
    const version = increment(old.version, 'preference version');
    this.database.prepare('INSERT INTO project_relations (project_id, principal_id, relation, active, version, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, principal_id, relation) DO UPDATE SET active = excluded.active, version = excluded.version, updated_at = excluded.updated_at').run(id, principalId, relation, Number(active), version, now);
    return { projectId: id, principalId, relation, active, version, updatedAt: now };
  }
  private changeMembers(project: Project, added: string[], removed: string[], reason: NonNullable<ProjectTransaction['relation']>['reason'], attribution?: ActorAttribution, now = new Date().toISOString()): void {
    if (!added.length && !removed.length) return;
    const version = increment(this.membersVersion(project.id), 'membership collection'); const operationId = randomUUID();
    this.database.prepare('UPDATE project_profiles SET members_version = ? WHERE project_id = ?').run(version, project.id);
    const epoch = (this.database.prepare("SELECT value FROM policy_meta WHERE name = 'epoch'").get() as { value: number }).value;
    this.database.prepare("UPDATE policy_meta SET value = ? WHERE name = 'epoch'").run(increment(epoch, 'access epoch'));
    for (const [ids, active] of [[removed, false], [added, true]] as const) for (const principalId of ids) {
      const relation = this.writeRelation(project.id, principalId, 'member', active, now);
      this.append(project, { kind: 'member', relation: { principalId, relation: 'member', oldActive: !active, active, version: relation.version, membersVersion: version, operationId, reason } }, attribution, now);
    }
    this.options.event(project.id, 'members_changed', 'Updated project membership.', attribution);
  }
  updateMembers(id: string, input: unknown, attribution?: ActorAttribution): ProjectDetail {
    return this.mutation(() => {
      const project = this.get(id); const data = object(input, ['action', 'principalIds', 'expectedCollectionVersion']);
      const action = choice(data.action, 'membership action', ['add', 'remove', 'set'] as const); const selected = principals(data.principalIds);
      if (nonnegative(data.expectedCollectionVersion, 'expectedCollectionVersion') !== this.membersVersion(id)) throw new HttpError(409, 'Project membership changed. Reload before saving.');
      const current = (this.database.prepare("SELECT principal_id FROM project_relations WHERE project_id = ? AND relation = 'member' AND active = 1 ORDER BY principal_id").all(id) as { principal_id: string }[]).map(row => row.principal_id);
      const existing = new Set(current); const wanted = new Set(selected);
      this.changeMembers(project, action === 'remove' ? [] : selected.filter(value => !existing.has(value)), action === 'add' ? [] : current.filter(value => action === 'set' ? !wanted.has(value) : wanted.has(value)), 'explicit', attribution);
      return this.detail(id, attribution?.principalId ?? '');
    });
  }
  updateMembership(id: string, input: unknown, attribution: ActorAttribution): ProjectDetail {
    return this.mutation(() => {
      const project = this.get(id); const principalId = principal(attribution.principalId); const data = object(input, ['action', 'expectedVersion']);
      const active = choice(data.action, 'membership action', ['join', 'leave'] as const) === 'join'; const previous = this.relation(id, principalId, 'member');
      if (nonnegative(data.expectedVersion, 'expectedVersion') !== previous.version) throw new HttpError(409, 'Your project membership changed. Reload before saving.');
      if (previous.active !== active) this.changeMembers(project, active ? [principalId] : [], active ? [] : [principalId], active ? 'joined' : 'left', attribution);
      return this.detail(id, principalId);
    });
  }
  updateWatcher(id: string, input: unknown, attribution: ActorAttribution): ProjectDetail {
    return this.mutation(() => {
      const project = this.get(id); const data = object(input, ['principalId', 'action', 'expectedVersion']); const principalId = principal(data.principalId);
      const active = choice(data.action, 'watch action', ['watch', 'unwatch'] as const) === 'watch';
      if (active && principalId !== attribution.principalId) throw new HttpError(400, 'Only a person can choose to watch a project for themselves.');
      const previous = this.relation(id, principalId, 'watcher');
      if (nonnegative(data.expectedVersion, 'expectedVersion') !== previous.version) throw new HttpError(409, 'Project watching changed. Reload before saving.');
      if (previous.active !== active) {
        const now = new Date().toISOString(); const relation = this.writeRelation(id, principalId, 'watcher', active, now);
        this.append(project, { kind: 'watcher', relation: { principalId, relation: 'watcher', oldActive: previous.active, active, version: relation.version, operationId: randomUUID(), reason: 'explicit' } }, attribution, now);
        this.options.event(id, 'watchers_changed', 'Updated project watching.', attribution);
      }
      return this.detail(id, attribution.principalId);
    });
  }
  updateSilence(id: string, input: unknown, attribution: ActorAttribution): ProjectPreferences {
    return this.mutation(() => {
      this.get(id); const principalId = principal(attribution.principalId); const data = object(input, ['silenced', 'expectedVersion']);
      if (typeof data.silenced !== 'boolean') throw new HttpError(400, 'silenced must be a boolean.');
      if (!this.relation(id, principalId, 'member').active) throw new HttpError(409, 'Only current members can change member mail preferences.');
      const previous = this.relation(id, principalId, 'silenced');
      if (nonnegative(data.expectedVersion, 'expectedVersion') !== previous.version) throw new HttpError(409, 'Your mail preference changed. Reload before saving.');
      if (previous.active !== data.silenced) {
        const now = new Date().toISOString(); const relation = this.writeRelation(id, principalId, 'silenced', data.silenced, now); const eventId = randomUUID();
        const event = { id: eventId, projectId: id, principalId, oldActive: previous.active, active: relation.active, version: relation.version, actor: attribution.displayName, attribution, createdAt: now };
        this.database.prepare('INSERT INTO project_preference_events (id, project_id, principal_id, version, data) VALUES (?, ?, ?, ?, ?)').run(eventId, id, principalId, relation.version, JSON.stringify(event));
      }
      return this.preferences(id, principalId);
    });
  }
  transferMemberships(fromId: string, toId: string, attribution: ActorAttribution): number {
    principal(fromId); principal(toId);
    return this.mutation(() => {
      if (fromId === toId) return 0;
      const rows = this.database.prepare("SELECT project_id FROM project_relations WHERE principal_id = ? AND relation = 'member' AND active = 1 ORDER BY project_id").all(fromId) as { project_id: string }[];
      for (const row of rows) this.changeMembers(this.get(row.project_id), this.relation(row.project_id, toId, 'member').active ? [] : [toId], [fromId], 'transferred', attribution);
      return rows.length;
    });
  }
}
