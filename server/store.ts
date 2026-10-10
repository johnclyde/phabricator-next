import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ActorAttribution, Activity, AppState, PassageAnchor, Project, Repository, Revision, RevisionDetail, RevisionVersion, ReviewAnalysis, ReviewComment, ReviewRun, ReviewThread, ReviewThreadEvent, SourceFile, SuggestedReplacement, SuggestionApplication, Task, TaskDetail, TaskField, TaskFieldChange, TaskHistory, TaskReference, TaskSubscriptionPage, TaskSubscriptionState, TaskSubscriptionStatus, TaskTransaction, WikiDetail, WikiDocument, WikiHistory, WikiVersion, WikiVersionSummary } from '../shared/types.ts';
import { choice, files, HttpError, integer, object, optionalString, remoteUrl, string } from './validation.ts';
import { initializePolicies, registerDefaultPolicy, upgradeProjectPolicies } from './policy.ts';
import { initializeProjects, ProjectStore } from './projects.ts';
import { initializeProjectHierarchy } from './project-graph.ts';
import { normalizeProjectTags } from '../shared/project-hierarchy.ts';
import type { ProjectChildPreview, ProjectKind, ProjectDetail, ProjectHistory, ProjectMembersPage, ProjectPreferences, ProjectWatchersPage } from '../shared/projects.ts';
import { createPassageAnchor } from '../shared/anchors.ts';
import { applySuggestedReplacement, validateSuggestion } from '../shared/suggestions.ts';

type Entity = Project | Repository | Revision | Task | WikiDocument;
type Kind = 'project' | 'repository' | 'revision' | 'task' | 'document';
export interface MutationResponse { status: number; body: unknown }
export interface StoredResponse extends MutationResponse { fingerprint: string }
export interface StoreOptions { path?: string }
type JsonRow = { data: string };

export function contentHash(sourceFiles: SourceFile[]): string {
  const canonical = [...sourceFiles].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(({ path, content }) => ({ path, content }));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export class Store {
  readonly database: DatabaseSync;
  readonly fresh: boolean;
  private taskProjectsReady = false;
  private projects: ProjectStore;
  constructor(options: StoreOptions = {}) {
    const path = options.path ?? '.data/phabricator.sqlite';
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
    const version = (this.database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version > 12) { this.database.close(); throw new Error(`Database schema ${version} is newer than this application supports.`); }
    this.fresh = version === 0;
    if (version === 0) this.database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE entities (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('project','repository','revision','task','document')), data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE INDEX entities_kind ON entities(kind);
      CREATE UNIQUE INDEX documents_slug ON entities(json_extract(data, '$.slug')) WHERE kind = 'document';
      CREATE TABLE versions (id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES entities(id), number INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(revision_id, number));
      CREATE TABLE comments (id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES entities(id), version_id TEXT NOT NULL REFERENCES versions(id), data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE reviews (id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES entities(id), version_id TEXT NOT NULL REFERENCES versions(id), data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE activity (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, object_id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE INDEX activity_object ON activity(object_id, sequence);
      CREATE TABLE sequences (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE idempotency (key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, status INTEGER NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)), created_at TEXT NOT NULL);
      PRAGMA user_version = 1;
      COMMIT;
    `);
    if (version < 2) {
      try {
        this.transaction(() => {
          this.database.exec(`
            CREATE TABLE wiki_versions (id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES entities(id), number INTEGER NOT NULL CHECK(number > 0), data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(document_id, number));
            CREATE TRIGGER wiki_versions_no_update BEFORE UPDATE ON wiki_versions BEGIN SELECT RAISE(ABORT, 'Wiki versions are immutable'); END;
            CREATE TRIGGER wiki_versions_no_delete BEFORE DELETE ON wiki_versions BEGIN SELECT RAISE(ABORT, 'Wiki versions are immutable'); END;
          `);
          // Schema 1 kept only the latest document. Preserve exactly that known
          // snapshot and version number; earlier edits and authors are unknown.
          for (const document of this.all<WikiDocument>('document')) this.saveWikiVersion(document, {
            kind: 'legacy', author: null, message: 'Latest content preserved from the previous storage format. Earlier history is unavailable.', restoredFrom: null,
          });
          this.database.exec('PRAGMA user_version = 2');
        });
      } catch (error) { this.database.close(); throw error; }
    }
    if (version < 4) {
      try { this.transaction(() => { initializePolicies(this.database); this.database.exec('PRAGMA user_version = 4'); }); }
      catch (error) { this.database.close(); throw error; }
    }
    if (version < 5) {
      try {
        this.transaction(() => {
          this.database.exec(`
            CREATE TABLE review_threads (id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES entities(id), root_comment_id TEXT NOT NULL UNIQUE REFERENCES comments(id), data TEXT NOT NULL CHECK(json_valid(data)));
            CREATE INDEX review_threads_revision ON review_threads(revision_id);
            CREATE TABLE thread_events (id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES entities(id), thread_id TEXT NOT NULL REFERENCES review_threads(id), version_id TEXT NOT NULL REFERENCES versions(id), data TEXT NOT NULL CHECK(json_valid(data)));
            CREATE INDEX thread_events_revision ON thread_events(revision_id);
            CREATE TRIGGER comments_no_update BEFORE UPDATE ON comments BEGIN SELECT RAISE(ABORT, 'Review comments are immutable'); END;
            CREATE TRIGGER comments_no_delete BEFORE DELETE ON comments BEGIN SELECT RAISE(ABORT, 'Review comments are immutable'); END;
            CREATE TRIGGER thread_events_no_update BEFORE UPDATE ON thread_events BEGIN SELECT RAISE(ABORT, 'Thread events are immutable'); END;
            CREATE TRIGGER thread_events_no_delete BEFORE DELETE ON thread_events BEGIN SELECT RAISE(ABORT, 'Thread events are immutable'); END;
          `);
          // Existing comments are already historical evidence. Only add their
          // thread records; never rewrite their JSON, anchors or attribution.
          for (const row of this.database.prepare('SELECT id, revision_id, data FROM comments ORDER BY rowid').all() as { id: string; revision_id: string; data: string }[]) {
            const comment = JSON.parse(row.data) as ReviewComment;
            const thread: ReviewThread = { id: row.id, revisionId: row.revision_id, rootCommentId: row.id, status: 'open', version: 1, createdAt: comment.createdAt, updatedAt: comment.createdAt };
            this.database.prepare('INSERT INTO review_threads (id, revision_id, root_comment_id, data) VALUES (?, ?, ?, ?)').run(thread.id, thread.revisionId, thread.rootCommentId, JSON.stringify(thread));
          }
          this.database.exec('PRAGMA user_version = 5');
        });
      } catch (error) { this.database.close(); throw error; }
    }
    if (version < 6) {
      try {
        this.transaction(() => {
          this.database.exec(`
            CREATE TABLE suggestion_applications (id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES entities(id), comment_id TEXT NOT NULL UNIQUE REFERENCES comments(id), thread_id TEXT NOT NULL REFERENCES review_threads(id), from_version_id TEXT NOT NULL REFERENCES versions(id), to_version_id TEXT NOT NULL REFERENCES versions(id), data TEXT NOT NULL CHECK(json_valid(data)));
            CREATE INDEX suggestion_applications_revision ON suggestion_applications(revision_id);
            CREATE TRIGGER suggestion_applications_no_update BEFORE UPDATE ON suggestion_applications BEGIN SELECT RAISE(ABORT, 'Suggestion applications are immutable'); END;
            CREATE TRIGGER suggestion_applications_no_delete BEFORE DELETE ON suggestion_applications BEGIN SELECT RAISE(ABORT, 'Suggestion applications are immutable'); END;
            PRAGMA user_version = 6;
          `);
        });
      } catch (error) { this.database.close(); throw error; }
    }
    if (version < 7) {
      try {
        this.transaction(() => {
          this.database.exec(`
            CREATE TABLE task_transactions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES entities(id), sequence INTEGER NOT NULL CHECK(sequence > 0), task_version INTEGER NOT NULL CHECK(task_version > 0), data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(task_id, sequence));
            CREATE TRIGGER task_transactions_no_update BEFORE UPDATE ON task_transactions BEGIN SELECT RAISE(ABORT, 'Task transactions are immutable'); END;
            CREATE TRIGGER task_transactions_no_delete BEFORE DELETE ON task_transactions BEGIN SELECT RAISE(ABORT, 'Task transactions are immutable'); END;
            CREATE TABLE task_dependencies (task_id TEXT NOT NULL REFERENCES entities(id), dependency_id TEXT NOT NULL REFERENCES entities(id), PRIMARY KEY(task_id, dependency_id), CHECK(task_id <> dependency_id));
            CREATE INDEX task_dependencies_inverse ON task_dependencies(dependency_id, task_id);
          `);
          const migratedAt = new Date().toISOString();
          // Earlier schemas kept only the current task. Record an explicitly
          // unknown-author baseline at migration time, not invented edits.
          for (const old of this.all<Task>('task')) {
            const task = { ...old, version: 1 };
            this.save('task', task);
            this.appendTaskTransaction(task, { kind: 'legacy', snapshot: task }, undefined, migratedAt);
          }
          this.database.exec('PRAGMA user_version = 7');
        });
      } catch (error) { this.database.close(); throw error; }
    }
    if (version < 8) {
      try {
        this.transaction(() => {
          this.database.exec(`
            CREATE TABLE task_subscriptions (task_id TEXT NOT NULL REFERENCES entities(id), principal_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('subscribed', 'unsubscribed')), version INTEGER NOT NULL CHECK(version > 0), updated_at TEXT NOT NULL, PRIMARY KEY(task_id, principal_id));
            CREATE INDEX task_subscriptions_principal ON task_subscriptions(principal_id, state, task_id);
          `);
          for (const task of this.all<Task>('task')) {
            const row = this.database.prepare('SELECT data FROM task_transactions WHERE task_id = ? AND sequence = 1').get(task.id) as JsonRow | undefined;
            const created = row ? JSON.parse(row.data) as TaskTransaction : undefined;
            const attribution = created?.attribution;
            const authorId = created?.kind === 'create' && created.taskId === task.id && created.sequence === 1 && created.taskVersion === 1
              && created.snapshot?.id === task.id && created.snapshot.version === 1 && created.snapshot.createdAt === task.createdAt
              && attribution && typeof attribution.principalId === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(attribution.principalId)
              && typeof attribution.displayName === 'string' && created.actor === attribution.displayName
              ? attribution.principalId : null;
            // New current fields do not rewrite historical snapshots, infer
            // prior assignment, or retroactively subscribe historical actors.
            this.save('task', { ...task, ownerId: null, authorId });
          }
          this.database.exec('PRAGMA user_version = 8');
        });
      } catch (error) { this.database.close(); throw error; }
    }
    if (version < 9) {
      try {
        this.transaction(() => {
          // Duplicate links retain historical relationships, not canonical
          // aliases. Existing tasks, history and replay bytes remain intact.
          this.database.exec(`
            CREATE TABLE task_duplicates (source_id TEXT NOT NULL REFERENCES entities(id), target_id TEXT NOT NULL REFERENCES entities(id), operation_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(source_id, target_id), CHECK(source_id <> target_id));
            CREATE INDEX task_duplicates_target ON task_duplicates(target_id, source_id);
            CREATE TRIGGER task_duplicates_no_update BEFORE UPDATE ON task_duplicates BEGIN SELECT RAISE(ABORT, 'Task duplicate links are immutable'); END;
            CREATE TRIGGER task_duplicates_no_delete BEFORE DELETE ON task_duplicates BEGIN SELECT RAISE(ABORT, 'Task duplicate links are immutable'); END;
            PRAGMA user_version = 9;
          `);
        });
      } catch (error) { this.database.close(); throw error; }
    }
    if (version < 10) {
      try {
        this.transaction(() => {
          this.database.exec(`
            CREATE TABLE task_projects (task_id TEXT NOT NULL REFERENCES entities(id), project_id TEXT NOT NULL REFERENCES entities(id), PRIMARY KEY(task_id, project_id));
            CREATE INDEX task_projects_project ON task_projects(project_id, task_id);
          `);
          // Canonical edges are new storage, not new edits. Leave all existing
          // entity, history and replay JSON exactly as it was recorded.
          const rows = this.database.prepare("SELECT id, data FROM entities WHERE kind = 'task'").all() as { id: string; data: string }[];
          for (const row of rows) {
            const old = JSON.parse(row.data) as { projectId?: unknown };
            if (old.projectId === null || old.projectId === undefined) continue;
            if (typeof old.projectId !== 'string' || !/^PROJ[1-9]\d*$/.test(old.projectId) || !this.database.prepare("SELECT 1 FROM entities WHERE id = ? AND kind = 'project'").get(old.projectId)) throw new Error(`Task ${row.id} has an invalid legacy project reference. Repair it before upgrading.`);
            this.database.prepare('INSERT INTO task_projects (task_id, project_id) VALUES (?, ?)').run(row.id, old.projectId);
          }
          this.database.exec('PRAGMA user_version = 10');
        });
      } catch (error) { this.database.close(); throw error; }
    }
    this.taskProjectsReady = true;
    if (version < 11) {
      try { this.transaction(() => { initializeProjects(this.database); upgradeProjectPolicies(this.database); this.database.exec('PRAGMA user_version = 11'); }); }
      catch (error) { this.database.close(); throw error; }
    }
    if (version < 12) {
      try { this.transaction(() => { initializeProjectHierarchy(this.database); this.database.exec('PRAGMA user_version = 12'); }); }
      catch (error) { this.database.close(); throw error; }
    }
    this.projects = new ProjectStore(this.database, { nextId: () => this.nextId('project', 'PROJ'), event: (id, action, detail, attribution) => this.event(id, action, detail, attribution), activities: id => this.activities(id) });
  }

  close(): void { this.database.close(); }
  read<T>(work: () => T): T {
    this.database.exec('SAVEPOINT read_snapshot');
    try { const result = work(); this.database.exec('RELEASE read_snapshot'); return result; }
    catch (error) { this.database.exec('ROLLBACK TO read_snapshot; RELEASE read_snapshot'); throw error; }
  }
  transaction<T>(work: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.database.exec('COMMIT'); return result; }
    catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }
  mutate(key: string | undefined, fingerprint: string, work: () => MutationResponse, authorize?: () => void, present?: (response: MutationResponse, replayed: boolean) => MutationResponse): MutationResponse {
    return this.transaction(() => {
      // Credential revocation in another process may commit while BEGIN waits.
      // Check authority after acquiring the write lock and before replay/writes.
      authorize?.();
      if (key) {
        const existing = this.replay(key, fingerprint);
        if (existing) return present ? present(existing, true) : existing;
      }
      const response = work();
      if (key) this.database.prepare('INSERT INTO idempotency (key, fingerprint, status, body, created_at) VALUES (?, ?, ?, ?, ?)').run(key, fingerprint, response.status, JSON.stringify(response.body), new Date().toISOString());
      return present ? present(response, false) : response;
    });
  }
  replay(key: string, fingerprint: string): MutationResponse | undefined {
    const row = this.database.prepare('SELECT fingerprint, status, body FROM idempotency WHERE key = ?').get(key) as { fingerprint: string; status: number; body: string } | undefined;
    if (!row) return undefined;
    if (row.fingerprint !== fingerprint) throw new HttpError(409, 'This idempotency key was already used for a different request.');
    return { status: row.status, body: JSON.parse(row.body) as unknown };
  }
  private nextId(name: string, prefix: string): string {
    const row = this.database.prepare('INSERT INTO sequences (name, value) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value').get(name) as { value: number };
    return `${prefix}${row.value}`;
  }
  private get<T extends Entity>(kind: Kind, id: string): T {
    if (kind === 'project' && this.projects) return this.projects.get(id) as T;
    const row = this.database.prepare('SELECT data FROM entities WHERE kind = ? AND id = ?').get(kind, id) as JsonRow | undefined;
    if (!row) throw new HttpError(404, `${kind} ${id} was not found.`);
    const value = JSON.parse(row.data) as T;
    return kind === 'task' && this.taskProjectsReady ? this.hydrateTask(value as Task) as T : value;
  }
  private all<T extends Entity>(kind: Kind): T[] {
    if (kind === 'project' && this.projects) return this.projects.all() as T[];
    const values = (this.database.prepare('SELECT data FROM entities WHERE kind = ? ORDER BY rowid DESC').all(kind) as JsonRow[]).map(row => JSON.parse(row.data) as T);
    if (kind !== 'task' || !this.taskProjectsReady) return values;
    const projects = new Map<string, string[]>();
    for (const row of this.database.prepare('SELECT task_id, project_id FROM task_projects ORDER BY task_id, project_id').all() as { task_id: string; project_id: string }[]) {
      const ids = projects.get(row.task_id) ?? []; ids.push(row.project_id); projects.set(row.task_id, ids);
    }
    return values.map(value => this.hydrateTask(value as Task, projects.get(value.id) ?? []) as T);
  }
  private hydrateTask(value: Task, projectIds?: string[]): Task {
    const { projectId: _legacyProjectId, projectIds: _oldProjectIds, ...metadata } = value as Task & { projectId?: unknown };
    return { ...metadata, projectIds: projectIds ?? (this.database.prepare('SELECT project_id FROM task_projects WHERE task_id = ? ORDER BY project_id').all(value.id) as { project_id: string }[]).map(row => row.project_id) };
  }
  private save(kind: Kind, value: Entity): void {
    let metadata: Entity | Omit<Task, 'projectIds'> = value;
    if (kind === 'task' && this.taskProjectsReady) {
      const { projectId: _legacyProjectId, projectIds: _projectIds, ...rest } = value as Task & { projectId?: unknown };
      metadata = rest;
    }
    const json = JSON.stringify(metadata);
    const created = this.database.prepare('INSERT INTO entities (id, kind, data) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING').run(value.id, kind, json);
    if (created.changes) registerDefaultPolicy(this.database, value.id);
    else this.database.prepare('UPDATE entities SET data = ? WHERE id = ?').run(json, value.id);
  }
  private reference(value: unknown, kind: 'project' | 'repository'): string | null {
    if (value === null || value === undefined) return null;
    const id = string(value, `${kind} ID`, 50);
    try { this.get(kind, id); } catch { throw new HttpError(400, `Unknown ${kind}: ${id}.`); }
    return id;
  }
  event(objectId: string, action: string, detail: string, attribution?: ActorAttribution): void {
    const value: Activity = { id: randomUUID(), objectId, actor: attribution?.displayName ?? 'You', ...(attribution ? { attribution } : {}), action, detail, createdAt: new Date().toISOString() };
    this.database.prepare('INSERT INTO activity (id, object_id, data) VALUES (?, ?, ?)').run(value.id, objectId, JSON.stringify(value));
  }
  activities(objectId?: string, visible?: (id: string) => boolean): Activity[] {
    const rows = objectId
      ? this.database.prepare('SELECT data FROM activity WHERE object_id = ? ORDER BY sequence DESC LIMIT 200').all(objectId)
      : this.database.prepare(`SELECT data FROM activity ORDER BY sequence DESC${visible ? '' : ' LIMIT 200'}`).all();
    return (rows as JsonRow[]).map(row => JSON.parse(row.data) as Activity).filter(item => !visible || visible(item.objectId)).slice(0, 200);
  }
  state(ai: AppState['ai'], mode: AppState['mode'] = 'local-single-user'): AppState {
    return { projects: this.all('project'), repositories: this.all('repository'), revisions: this.all('revision'), tasks: this.all('task'), documents: this.all('document'), activity: this.activities(), spaces: [], access: {}, principals: [], currentPrincipalId: '', followingTaskIds: [], joinedProjectIds: [], watchingProjectIds: [], accessEpoch: 0, canCreate: false, ai, mode };
  }
  createProject(input: unknown, attribution?: ActorAttribution): Project {
    return this.projects.create(input, attribution);
  }
  getProject(id: string): Project { return this.projects.get(id); }
  projectDetail(id: string, viewerId: string): ProjectDetail { return this.projects.detail(id, viewerId); }
  projectChildPreview(id: string, kind: ProjectKind): ProjectChildPreview { return this.projects.childPreview(id, kind); }
  projectHistory(id: string, before?: number, limit?: number, visible?: (id: string) => boolean): ProjectHistory { return this.projects.history(id, before, limit, visible); }
  projectMembers(id: string, viewerId: string, after?: string, limit?: number): ProjectMembersPage { return this.projects.members(id, viewerId, after, limit); }
  projectWatchers(id: string, viewerId: string, after?: string, limit?: number): ProjectWatchersPage { return this.projects.watchers(id, viewerId, after, limit); }
  projectPreferences(id: string, viewerId: string): ProjectPreferences { return this.projects.preferences(id, viewerId); }
  updateProject(id: string, input: unknown, attribution?: ActorAttribution): ProjectDetail { return this.projects.update(id, input, attribution); }
  updateProjectMembers(id: string, input: unknown, attribution?: ActorAttribution): ProjectDetail { return this.projects.updateMembers(id, input, attribution); }
  updateProjectMembership(id: string, input: unknown, attribution: ActorAttribution): ProjectDetail { return this.projects.updateMembership(id, input, attribution); }
  updateProjectWatcher(id: string, input: unknown, attribution: ActorAttribution): ProjectDetail { return this.projects.updateWatcher(id, input, attribution); }
  updateProjectSilence(id: string, input: unknown, attribution: ActorAttribution): ProjectPreferences { return this.projects.updateSilence(id, input, attribution); }
  transferLocalProjectMemberships(fromId: string, toId: string, attribution: ActorAttribution): number { return this.projects.transferMemberships(fromId, toId, attribution); }
  createRepository(input: unknown, attribution?: ActorAttribution): Repository {
    const data = object(input, ['name', 'remoteUrl', 'description', 'defaultBranch']);
    const repository: Repository = { id: this.nextId('repository', 'R'), name: string(data.name, 'Name'), remoteUrl: remoteUrl(data.remoteUrl), description: optionalString(data.description, 'Description'), defaultBranch: data.defaultBranch === undefined ? 'main' : string(data.defaultBranch, 'Default branch') };
    this.save('repository', repository); this.event(repository.id, 'registered', `Registered ${repository.name}; no remote content fetched.`, attribution); return repository;
  }
  private taskMutation<T>(work: () => T): T {
    this.database.exec('SAVEPOINT task_write');
    try {
      // Lock before loading task versions or traversing the dependency graph.
      this.database.prepare("UPDATE sequences SET value = value WHERE name = 'task'").run();
      const result = work(); this.database.exec('RELEASE task_write'); return result;
    } catch (error) { this.database.exec('ROLLBACK TO task_write; RELEASE task_write'); throw error; }
  }
  private advanceTask(task: Task, now: string): Task {
    if (!Number.isSafeInteger(task.version) || task.version < 1 || !Number.isSafeInteger(task.version + 1)) throw new HttpError(409, 'This task has reached the supported version limit.');
    return { ...task, version: task.version + 1, updatedAt: now };
  }
  private appendTaskTransaction(task: Task, data: Pick<TaskTransaction, 'kind' | 'snapshot' | 'changes' | 'comment' | 'dependency' | 'dependencyStatus' | 'subscription' | 'merge' | 'project'>, attribution?: ActorAttribution, now = new Date().toISOString()): TaskTransaction {
    const last = this.database.prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM task_transactions WHERE task_id = ?').get(task.id) as { sequence: number };
    const sequence = last.sequence + 1;
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new HttpError(409, 'This task has reached the supported history limit.');
    const transaction: TaskTransaction = { id: randomUUID(), taskId: task.id, sequence, taskVersion: task.version, actor: data.kind === 'legacy' ? null : attribution?.displayName ?? 'You', ...(attribution ? { attribution } : {}), createdAt: now, ...data };
    this.database.prepare('INSERT INTO task_transactions (id, task_id, sequence, task_version, data) VALUES (?, ?, ?, ?, ?)').run(transaction.id, task.id, sequence, task.version, JSON.stringify(transaction));
    return transaction;
  }
  createTask(input: unknown, attribution?: ActorAttribution): Task { return this.taskMutation(() => this.writeTask(input, undefined, attribution)); }
  updateTask(id: string, input: unknown, attribution?: ActorAttribution): Task { return this.taskMutation(() => this.writeTask(input, this.get<Task>('task', id), attribution)); }
  /** Explicit operator handoff; authorship and existing preferences stay historical. */
  transferTaskOwners(fromId: string, toId: string, attribution: ActorAttribution): number {
    this.taskPrincipal(fromId); this.taskPrincipal(toId);
    return this.taskMutation(() => {
      if (fromId === toId) return 0;
      const rows = this.database.prepare("SELECT data FROM entities WHERE kind = 'task' AND json_extract(data, '$.ownerId') = ? ORDER BY id").all(fromId) as JsonRow[];
      for (const row of rows) {
        const task = this.hydrateTask(JSON.parse(row.data) as Task);
        this.updateTask(task.id, { expectedVersion: task.version, ownerId: toId }, attribution);
      }
      return rows.length;
    });
  }
  private writeTask(input: unknown, current?: Task, attribution?: ActorAttribution): Task {
    const fields: Exclude<TaskField, 'projectId'>[] = ['title', 'description', 'status', 'priority', 'ownerId'];
    const data = object(input, current ? [...fields, 'expectedVersion', 'projectIds', 'projectId'] : [...fields, 'projectIds', 'projectId']);
    if (current && ('projectId' in data || 'projectIds' in data)) throw new HttpError(400, 'Change project tags with the separate task projects action.');
    if (current && integer(data.expectedVersion, 'expectedVersion') !== current.version) throw new HttpError(409, 'This task changed. Reload before saving.');
    if (current && !fields.some(field => data[field] !== undefined)) throw new HttpError(400, 'At least one task field is required.');
    const now = new Date().toISOString();
    const values = {
      title: data.title === undefined && current ? current.title : string(data.title, 'Title'),
      description: data.description === undefined && current ? current.description : optionalString(data.description, 'Description'),
      status: data.status === undefined ? current?.status ?? 'open' : data.status === 'duplicate' && current?.status === 'duplicate' ? 'duplicate' as const : choice(data.status, 'status', ['open', 'in_progress', 'resolved']),
      priority: data.priority === undefined ? current?.priority ?? 'normal' : choice(data.priority, 'priority', ['low', 'normal', 'high', 'urgent']),
      ownerId: data.ownerId === undefined && current ? current.ownerId : data.ownerId === undefined || data.ownerId === null ? null : this.taskPrincipal(data.ownerId),
    };
    if (!current && 'projectIds' in data && 'projectId' in data) throw new HttpError(400, 'Use projectIds or the legacy projectId field, not both.');
    const projectIds = current?.projectIds ?? this.normalizeTaskProjectIds(this.taskProjectIds('projectIds' in data ? data.projectIds : data.projectId === undefined || data.projectId === null ? [] : [data.projectId]));
    const changes: TaskFieldChange[] = current ? fields.filter(field => values[field] !== current[field]).map(field => ({ field, oldValue: current[field], newValue: values[field] })) : [];
    if (current && changes.length === 0) return current;
    const task: Task = current ? { ...this.advanceTask(current, now), ...values } : { id: this.nextId('task', 'T'), ...values, projectIds, authorId: attribution ? this.taskPrincipal(attribution.principalId) : null, version: 1, createdAt: now, updatedAt: now };
    const parents = current && task.status !== current.status
      ? (this.database.prepare('SELECT task_id FROM task_dependencies WHERE dependency_id = ? ORDER BY task_id').all(task.id) as { task_id: string }[]).map(row => this.advanceTask(this.get<Task>('task', row.task_id), now)) : [];
    this.save('task', task);
    if (!current) for (const projectId of projectIds) this.database.prepare('INSERT INTO task_projects (task_id, project_id) VALUES (?, ?)').run(task.id, projectId);
    this.appendTaskTransaction(task, current ? { kind: 'edit', changes } : { kind: 'create', snapshot: task }, attribution, now);
    this.event(task.id, current ? 'updated' : 'created', `${current ? 'Updated' : 'Created'} task ${task.title}.`, attribution);
    if (task.ownerId !== (current?.ownerId ?? null)) {
      const row = this.database.prepare("SELECT value FROM policy_meta WHERE name = 'epoch'").get() as { value: number };
      if (!Number.isSafeInteger(row.value + 1)) throw new HttpError(409, 'The workspace has reached the supported policy epoch limit.');
      this.database.prepare("UPDATE policy_meta SET value = value + 1 WHERE name = 'epoch'").run();
      if (current?.ownerId) this.changeTaskSubscription(task, current.ownerId, 'subscribed', 'former_owner', attribution, now);
    }
    if (!current && task.authorId) this.changeTaskSubscription(task, task.authorId, 'subscribed', 'created', attribution, now);
    for (const parent of parents) {
      this.save('task', parent);
      this.appendTaskTransaction(parent, { kind: 'dependency_status', dependencyStatus: { taskId: task.id, oldStatus: current!.status, newStatus: task.status } }, attribution, now);
      this.event(parent.id, 'dependency_status_changed', 'A dependency changed status.', attribution);
    }
    return task;
  }
  private taskProjectIds(value: unknown): string[] {
    if (!Array.isArray(value) || value.length > 100) throw new HttpError(400, 'projectIds must contain at most 100 project IDs.');
    const ids = value.map(value => {
      const id = string(value, 'Project ID', 50);
      if (!/^PROJ[1-9]\d*$/.test(id)) throw new HttpError(400, 'Choose a valid project.');
      return id;
    });
    if (new Set(ids).size !== ids.length) throw new HttpError(400, 'Choose each project only once.');
    for (const id of ids) this.reference(id, 'project');
    return ids;
  }
  private normalizeTaskProjectIds(ids: string[]): string[] {
    const graph = this.database.prepare('SELECT project_id AS id, parent_id AS parentId, kind FROM project_hierarchy').all() as { id: string; parentId: string | null; kind: ProjectKind }[];
    try { return normalizeProjectTags(ids, graph).sort(); } catch { throw new HttpError(409, 'The project hierarchy is incomplete or invalid.'); }
  }
  updateTaskProjects(id: string, input: unknown, attribution?: ActorAttribution): TaskDetail {
    return this.taskMutation(() => {
      const data = object(input, ['action', 'projectIds', 'expectedVersion']);
      const action = choice(data.action, 'action', ['add', 'remove', 'set']);
      const current = this.get<Task>('task', id);
      if (integer(data.expectedVersion, 'expectedVersion') !== current.version) throw new HttpError(409, 'This task changed. Reload before changing project tags.');
      const selected = this.taskProjectIds(data.projectIds);
      const selectedSet = new Set(selected); const existing = new Set(current.projectIds);
      const wanted = action === 'remove' ? current.projectIds.filter(projectId => !selectedSet.has(projectId)) : this.normalizeTaskProjectIds(action === 'set' ? selected : [...current.projectIds, ...selected]);
      const wantedSet = new Set(wanted);
      const removed = current.projectIds.filter(projectId => !wantedSet.has(projectId));
      const added = wanted.filter(projectId => !existing.has(projectId));
      if (!removed.length && !added.length) return this.taskDetail(id);
      const now = new Date().toISOString(); const operationId = randomUUID();
      const task = this.advanceTask(current, now);
      for (const projectId of removed) this.database.prepare('DELETE FROM task_projects WHERE task_id = ? AND project_id = ?').run(id, projectId);
      for (const projectId of added) this.database.prepare('INSERT INTO task_projects (task_id, project_id) VALUES (?, ?)').run(id, projectId);
      this.save('task', task);
      for (const projectId of removed) this.appendTaskTransaction(task, { kind: 'project', project: { projectId, action: 'removed', operationId } }, attribution, now);
      for (const projectId of added) this.appendTaskTransaction(task, { kind: 'project', project: { projectId, action: 'added', operationId } }, attribution, now);
      this.event(id, 'projects_changed', 'Updated project tags.', attribution);
      return this.taskDetail(id);
    });
  }
  taskHistory(id: string, before?: number, limit = 50, visible?: (id: string) => boolean): TaskHistory {
    this.get<Task>('task', id);
    const cursor = before === undefined ? null : integer(before, 'before');
    const size = integer(limit, 'limit');
    if (size > 100) throw new HttpError(400, 'limit must be at most 100.');
    const canSee = (item: TaskTransaction) => !visible || ((!item.dependency || visible(item.dependency.taskId)) && (!item.dependencyStatus || visible(item.dependencyStatus.taskId)) && (!item.merge || visible(item.merge.taskId)) && (!item.project || visible(item.project.projectId)));
    const pageStatement = this.database.prepare(cursor === null
      ? 'SELECT data FROM task_transactions WHERE task_id = ? ORDER BY sequence DESC'
      : 'SELECT data FROM task_transactions WHERE task_id = ? AND sequence < ? ORDER BY sequence DESC');
    const rows = cursor === null ? pageStatement.iterate(id) : pageStatement.iterate(id, cursor);
    const available: TaskTransaction[] = [];
    for (const row of rows) {
      const item = JSON.parse((row as JsonRow).data) as TaskTransaction;
      if (canSee(item)) available.push(item);
      if (available.length > size) break;
    }
    let firstAvailableSequence: number | null = null;
    const firstStatement = this.database.prepare('SELECT data FROM task_transactions WHERE task_id = ? ORDER BY sequence ASC');
    for (const row of firstStatement.iterate(id)) {
      const item = JSON.parse((row as JsonRow).data) as TaskTransaction;
      if (canSee(item)) { firstAvailableSequence = item.sequence; break; }
    }
    const page = available.slice(0, size);
    return { transactions: page, nextBefore: available.length > size ? page[page.length - 1]!.sequence : null, firstAvailableSequence };
  }
  taskDetail(id: string): TaskDetail {
    const task = this.get<Task>('task', id);
    const references = (direction: 'depends_on' | 'blocks' | 'duplicate_of' | 'duplicates'): TaskReference[] => {
      const queries = {
        depends_on: 'SELECT e.data FROM task_dependencies d JOIN entities e ON e.id = d.dependency_id WHERE d.task_id = ? ORDER BY d.dependency_id',
        blocks: 'SELECT e.data FROM task_dependencies d JOIN entities e ON e.id = d.task_id WHERE d.dependency_id = ? ORDER BY d.task_id',
        duplicate_of: 'SELECT e.data FROM task_duplicates d JOIN entities e ON e.id = d.target_id WHERE d.source_id = ? ORDER BY d.target_id',
        duplicates: 'SELECT e.data FROM task_duplicates d JOIN entities e ON e.id = d.source_id WHERE d.target_id = ? ORDER BY d.source_id',
      };
      const rows = this.database.prepare(queries[direction]).all(id);
      return (rows as JsonRow[]).map(row => { const value = JSON.parse(row.data) as Task; return { id: value.id, title: value.title, status: value.status, priority: value.priority, version: value.version }; });
    };
    return { task, history: this.taskHistory(id), dependsOn: references('depends_on'), blocks: references('blocks'), duplicateOf: references('duplicate_of'), duplicates: references('duplicates'), activity: this.activities(id) };
  }
  private mergeTaskId(value: unknown): string {
    const id = string(value, 'Task ID', 50);
    if (!/^T[1-9]\d*$/.test(id)) throw new HttpError(400, 'Choose a valid task.');
    return id;
  }
  mergeTask(sourceId: string, input: unknown, attribution?: ActorAttribution): TaskDetail {
    return this.taskMutation(() => {
      const data = object(input, ['taskId', 'expectedVersion', 'expectedTargetVersion']);
      this.applyTaskMerge(this.mergeTaskId(data.taskId), integer(data.expectedTargetVersion, 'expectedTargetVersion'), [
        { taskId: this.mergeTaskId(sourceId), expectedVersion: integer(data.expectedVersion, 'expectedVersion') },
      ], attribution);
      return this.taskDetail(sourceId);
    });
  }
  mergeTasksInto(targetId: string, input: unknown, attribution?: ActorAttribution): TaskDetail {
    return this.taskMutation(() => {
      const data = object(input, ['sources', 'expectedVersion']);
      if (!Array.isArray(data.sources) || data.sources.length < 1 || data.sources.length > 100) throw new HttpError(400, 'Choose between 1 and 100 source tasks.');
      const sources = data.sources.map(value => {
        const source = object(value, ['taskId', 'expectedVersion']);
        return { taskId: this.mergeTaskId(source.taskId), expectedVersion: integer(source.expectedVersion, 'expectedVersion') };
      });
      this.applyTaskMerge(this.mergeTaskId(targetId), integer(data.expectedVersion, 'expectedVersion'), sources, attribution);
      return this.taskDetail(targetId);
    });
  }
  private applyTaskMerge(targetId: string, expectedTargetVersion: number, sources: { taskId: string; expectedVersion: number }[], attribution?: ActorAttribution): void {
    const ids = sources.map(source => source.taskId);
    if (new Set(ids).size !== ids.length) throw new HttpError(400, 'Choose each source task only once.');
    if (ids.includes(targetId)) throw new HttpError(400, 'A task cannot be merged into itself.');
    const originals = new Map<string, Task>();
    for (const endpoint of [{ taskId: targetId, expectedVersion: expectedTargetVersion }, ...sources]) {
      const row = this.database.prepare("SELECT data FROM entities WHERE kind = 'task' AND id = ?").get(endpoint.taskId) as JsonRow | undefined;
      if (!row) throw new HttpError(404, 'A selected task is unavailable.', 'TASK_UNAVAILABLE');
      const task = this.hydrateTask(JSON.parse(row.data) as Task);
      if (task.version !== endpoint.expectedVersion) throw new HttpError(409, 'A selected task changed. Reload before merging.');
      originals.set(task.id, task);
    }
    const now = new Date().toISOString(); const operationId = randomUUID();
    const changed = new Map<string, Task>();
    const advance = (id: string): Task => {
      let task = changed.get(id);
      if (!task) { task = this.advanceTask(originals.get(id) ?? this.get<Task>('task', id), now); changed.set(id, task); }
      return task;
    };
    const target = advance(targetId);
    const parentEffects: { parentId: string; sourceId: string; oldStatus: Task['status'] }[] = [];
    for (const id of ids) {
      const source = originals.get(id)!; advance(id).status = 'duplicate';
      if (source.status === 'duplicate') continue;
      for (const parent of this.database.prepare('SELECT task_id FROM task_dependencies WHERE dependency_id = ? ORDER BY task_id').all(id) as { task_id: string }[]) {
        advance(parent.task_id);
        parentEffects.push({ parentId: parent.task_id, sourceId: id, oldStatus: source.status });
      }
    }
    // Every endpoint CAS is checked against the original snapshot. A task
    // advances only once even when also a parent of several merged sources.
    for (const task of changed.values()) this.save('task', task);
    for (const id of ids) {
      // A fresh merge may close this task again or carry new followers. Keep
      // the first link immutable while recording this operation separately.
      this.database.prepare('INSERT INTO task_duplicates (source_id, target_id, operation_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(source_id, target_id) DO NOTHING').run(id, targetId, operationId, now);
      const original = originals.get(id)!; const source = changed.get(id)!;
      this.appendTaskTransaction(source, { kind: 'merge', merge: { taskId: targetId, direction: 'merged_into', operationId }, ...(original.status === 'duplicate' ? {} : { changes: [{ field: 'status', oldValue: original.status, newValue: 'duplicate' }] }) }, attribution, now);
      this.appendTaskTransaction(target, { kind: 'merge', merge: { taskId: id, direction: 'merged_from', operationId } }, attribution, now);
      this.event(id, 'merged', 'Closed this task as a duplicate.', attribution);
    }
    this.event(targetId, 'duplicates_merged', 'Merged duplicate tasks into this task.', attribution);
    for (const effect of parentEffects) {
      const parent = changed.get(effect.parentId)!;
      this.appendTaskTransaction(parent, { kind: 'dependency_status', dependencyStatus: { taskId: effect.sourceId, oldStatus: effect.oldStatus, newStatus: 'duplicate' } }, attribution, now);
      this.event(parent.id, 'dependency_status_changed', 'A dependency changed status.', attribution);
    }
    // Carry only the source's explicit subscribers, author and automatic
    // owner. Explicit merge additions override destination opt-out, without
    // changing source preferences or representing the recipient as actor.
    const parameters = ids.map(() => '?').join(',');
    const recipients = this.database.prepare(`SELECT principal_id FROM (
      SELECT principal_id FROM task_subscriptions WHERE task_id IN (${parameters}) AND state = 'subscribed'
      UNION SELECT json_extract(data, '$.authorId') FROM entities WHERE id IN (${parameters})
      UNION SELECT json_extract(data, '$.ownerId') FROM entities WHERE id IN (${parameters})
    ) WHERE principal_id IS NOT NULL ORDER BY principal_id`);
    for (const row of recipients.iterate(...ids, ...ids, ...ids) as Iterable<{ principal_id: string }>) this.changeTaskSubscription(target, row.principal_id, 'subscribed', 'merged', attribution, now);
  }
  createTaskComment(id: string, input: unknown, attribution?: ActorAttribution): TaskTransaction {
    return this.taskMutation(() => {
      const data = object(input, ['body']); const body = string(data.body, 'Comment', 20_000);
      const task = this.get<Task>('task', id);
      if (attribution && attribution.principalId !== task.ownerId) {
        const principalId = this.taskPrincipal(attribution.principalId);
        const membership = this.subscriptionForTask(task, principalId);
        if (membership.state === null) this.changeTaskSubscription(task, principalId, 'subscribed', 'commented', attribution);
      }
      const transaction = this.appendTaskTransaction(task, { kind: 'comment', comment: body }, attribution);
      this.event(id, 'commented', 'Commented on this task.', attribution);
      return transaction;
    });
  }
  private taskPrincipal(value: unknown): string {
    const principalId = string(value, 'Principal ID', 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(principalId)) throw new HttpError(400, 'Choose a valid workspace principal.');
    return principalId;
  }
  private subscriptionForTask(task: Task, principalId: string): TaskSubscriptionStatus {
    const row = this.database.prepare('SELECT state, version, updated_at FROM task_subscriptions WHERE task_id = ? AND principal_id = ?').get(task.id, principalId) as { state: TaskSubscriptionState; version: number; updated_at: string } | undefined;
    const automatic = task.ownerId === principalId;
    return { taskId: task.id, principalId, state: row?.state ?? null, version: row?.version ?? 0, automatic, subscribed: automatic || row?.state === 'subscribed', updatedAt: row?.updated_at ?? null };
  }
  subscriptionStatus(taskId: string, principalId: string): TaskSubscriptionStatus {
    return this.subscriptionForTask(this.get<Task>('task', taskId), this.taskPrincipal(principalId));
  }
  taskSubscriptions(taskId: string, viewerId: string, after?: string, limit = 50): TaskSubscriptionPage {
    const task = this.get<Task>('task', taskId); const viewer = this.subscriptionForTask(task, this.taskPrincipal(viewerId));
    const cursor = after === undefined ? null : this.taskPrincipal(after);
    const size = integer(limit, 'limit'); if (size > 100) throw new HttpError(400, 'limit must be at most 100.');
    const rows = this.database.prepare(`SELECT principal_id FROM (
      SELECT principal_id FROM task_subscriptions WHERE task_id = ? AND state = 'subscribed'
      UNION SELECT ? AS principal_id WHERE ? IS NOT NULL
    ) WHERE (? IS NULL OR principal_id > ?) ORDER BY principal_id LIMIT ?`).all(taskId, task.ownerId, task.ownerId, cursor, cursor, size + 1) as { principal_id: string }[];
    const subscribers = rows.slice(0, size).map(row => this.subscriptionForTask(task, row.principal_id));
    return { subscribers, nextAfter: rows.length > size ? subscribers[subscribers.length - 1]!.principalId : null, viewer };
  }
  private changeTaskSubscription(task: Task, principalId: string, state: TaskSubscriptionState, reason: NonNullable<TaskTransaction['subscription']>['reason'], attribution?: ActorAttribution, now = new Date().toISOString()): TaskSubscriptionStatus {
    const current = this.subscriptionForTask(task, principalId);
    if (current.state === state) return current;
    const version = current.version + 1;
    if (!Number.isSafeInteger(version) || version < 1) throw new HttpError(409, 'This membership has reached the supported version limit.');
    this.database.prepare(`INSERT INTO task_subscriptions (task_id, principal_id, state, version, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(task_id, principal_id) DO UPDATE SET state = excluded.state, version = excluded.version, updated_at = excluded.updated_at`).run(task.id, principalId, state, version, now);
    this.appendTaskTransaction(task, { kind: 'subscription', subscription: { principalId, oldState: current.state, newState: state, membershipVersion: version, reason } }, attribution, now);
    this.event(task.id, 'subscription_changed', 'Updated task subscription preferences.', attribution);
    return this.subscriptionForTask(task, principalId);
  }
  updateTaskSubscription(id: string, input: unknown, attribution: ActorAttribution): TaskSubscriptionStatus {
    return this.taskMutation(() => {
      const data = object(input, ['principalId', 'action', 'expectedMembershipVersion']);
      const principalId = this.taskPrincipal(data.principalId);
      const action = choice(data.action, 'action', ['subscribe', 'unsubscribe']);
      const expected = data.expectedMembershipVersion;
      if (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 0) throw new HttpError(400, 'expectedMembershipVersion must be a nonnegative integer.');
      const task = this.get<Task>('task', id); const current = this.subscriptionForTask(task, principalId);
      if (current.version !== expected) throw new HttpError(409, 'This subscription changed. Reload before changing it.');
      if (action === 'unsubscribe' && current.automatic) throw new HttpError(409, 'The current owner is automatically subscribed. Reassign the task before unsubscribing.');
      return this.changeTaskSubscription(task, principalId, action === 'subscribe' ? 'subscribed' : 'unsubscribed', 'explicit', attribution);
    });
  }
  updateTaskDependencies(id: string, input: unknown, attribution?: ActorAttribution): TaskDetail {
    return this.taskMutation(() => {
      const data = object(input, ['taskId', 'action', 'expectedVersion']);
      const dependencyId = string(data.taskId, 'Dependency task ID', 50);
      if (!/^T[1-9]\d*$/.test(dependencyId)) throw new HttpError(400, 'Choose a valid dependency task.');
      const action = choice(data.action, 'action', ['add', 'remove']);
      const current = this.get<Task>('task', id);
      if (integer(data.expectedVersion, 'expectedVersion') !== current.version) throw new HttpError(409, 'This task changed. Reload before changing dependencies.');
      if (dependencyId === id) throw new HttpError(400, 'A task cannot depend on itself.');
      const row = this.database.prepare("SELECT data FROM entities WHERE kind = 'task' AND id = ?").get(dependencyId) as JsonRow | undefined;
      if (!row) throw new HttpError(404, 'Dependency task was not found.', 'TASK_UNAVAILABLE');
      const dependency = this.hydrateTask(JSON.parse(row.data) as Task);
      const exists = Boolean(this.database.prepare('SELECT 1 FROM task_dependencies WHERE task_id = ? AND dependency_id = ?').get(id, dependencyId));
      if ((action === 'add') === exists) throw new HttpError(409, action === 'add' ? 'This dependency already exists.' : 'This dependency no longer exists.');
      if (action === 'add' && this.database.prepare(`WITH RECURSIVE reachable(id) AS (
        SELECT dependency_id FROM task_dependencies WHERE task_id = ?
        UNION SELECT d.dependency_id FROM task_dependencies d JOIN reachable r ON d.task_id = r.id
      ) SELECT 1 FROM reachable WHERE id = ? LIMIT 1`).get(dependencyId, id)) throw new HttpError(409, 'This dependency would create a cycle.');
      const now = new Date().toISOString(); const task = this.advanceTask(current, now); const other = this.advanceTask(dependency, now);
      if (action === 'add') this.database.prepare('INSERT INTO task_dependencies (task_id, dependency_id) VALUES (?, ?)').run(id, dependencyId);
      else this.database.prepare('DELETE FROM task_dependencies WHERE task_id = ? AND dependency_id = ?').run(id, dependencyId);
      this.save('task', task); this.save('task', other);
      const change = action === 'add' ? 'added' : 'removed';
      this.appendTaskTransaction(task, { kind: 'dependency', dependency: { taskId: other.id, action: change, direction: 'depends_on' } }, attribution, now);
      this.appendTaskTransaction(other, { kind: 'dependency', dependency: { taskId: task.id, action: change, direction: 'blocks' } }, attribution, now);
      this.event(task.id, `dependency_${change}`, `${action === 'add' ? 'Added' : 'Removed'} a task dependency.`, attribution);
      this.event(other.id, `dependency_${change}`, `${action === 'add' ? 'Added' : 'Removed'} a task blocked by this task.`, attribution);
      return this.taskDetail(id);
    });
  }
  private documentMutation(work: () => WikiDocument): WikiDocument {
    // A savepoint preserves atomic history even for callers outside mutate(),
    // and composes with the transaction used for replay and demo seeding.
    this.database.exec('SAVEPOINT wiki_document_write');
    try { const document = work(); this.database.exec('RELEASE wiki_document_write'); return document; }
    catch (error) { this.database.exec('ROLLBACK TO wiki_document_write; RELEASE wiki_document_write'); throw error; }
  }
  createDocument(input: unknown, attribution?: ActorAttribution): WikiDocument { return this.documentMutation(() => this.writeDocument(input, undefined, null, attribution)); }
  updateDocument(id: string, input: unknown, attribution?: ActorAttribution): WikiDocument { return this.documentMutation(() => this.writeDocument(input, this.get<WikiDocument>('document', id), null, attribution)); }
  restoreDocument(id: string, input: unknown, attribution?: ActorAttribution): WikiDocument {
    return this.documentMutation(() => {
      const data = object(input, ['version', 'expectedVersion', 'message']);
      const current = this.get<WikiDocument>('document', id);
      if (integer(data.expectedVersion, 'expectedVersion') !== current.version) throw new HttpError(409, 'This document changed. Reload before restoring.');
      const selected = this.documentVersion(id, integer(data.version, 'version'));
      return this.writeDocument({
        title: selected.title, content: selected.content, slug: current.slug, expectedVersion: current.version,
        message: data.message === undefined ? `Restored content from version ${selected.number}. Current slug retained.` : data.message,
      }, current, selected.number, attribution);
    });
  }
  private writeDocument(input: unknown, current?: WikiDocument, restoredFrom: number | null = null, attribution?: ActorAttribution): WikiDocument {
    const data = object(input, ['title', 'slug', 'content', 'expectedVersion', 'message']);
    if (current && integer(data.expectedVersion, 'expectedVersion') !== current.version) throw new HttpError(409, 'This document changed. Reload before saving.');
    if (!current && data.expectedVersion !== undefined) throw new HttpError(400, 'expectedVersion is only used when updating a document.');
    const slug = string(data.slug, 'Slug', 160);
    if (!/^[a-z0-9]+(?:[-/][a-z0-9]+)*$/.test(slug)) throw new HttpError(400, 'Slug must contain lowercase letters, numbers, hyphens, or slash-separated paths.');
    if (this.all<WikiDocument>('document').some(doc => doc.slug === slug && doc.id !== current?.id)) throw new HttpError(409, 'This slug is unavailable.');
    const message = optionalString(data.message, 'Message', 10_000, current ? 'Updated document' : 'Initial version');
    const now = new Date().toISOString();
    const document: WikiDocument = { id: current?.id ?? this.nextId('document', 'W'), title: string(data.title, 'Title'), slug, content: string(data.content, 'Content', 500_000, true), version: (current?.version ?? 0) + 1, createdAt: current?.createdAt ?? now, updatedAt: now };
    if (!Number.isSafeInteger(document.version)) throw new HttpError(409, 'This document has reached the supported version limit.');
    this.save('document', document);
    this.saveWikiVersion(document, { kind: restoredFrom === null ? current ? 'edit' : 'create' : 'restore', author: attribution?.displayName ?? 'You', ...(attribution ? { attribution } : {}), message, restoredFrom });
    this.event(document.id, restoredFrom === null ? current ? 'updated' : 'created' : 'restored', restoredFrom === null
      ? `Saved document ${document.title}, version ${document.version}.`
      : `Restored content from version ${restoredFrom} as version ${document.version}. Current slug retained.`, attribution);
    return document;
  }
  private saveWikiVersion(document: WikiDocument, metadata: Pick<WikiVersion, 'kind' | 'author' | 'message' | 'restoredFrom' | 'attribution'>): WikiVersion {
    const version: WikiVersion = {
      id: randomUUID(), documentId: document.id, number: document.version, title: document.title,
      slug: document.slug, content: document.content, createdAt: document.updatedAt, ...metadata,
    };
    this.database.prepare('INSERT INTO wiki_versions (id, document_id, number, data) VALUES (?, ?, ?, ?)').run(version.id, document.id, version.number, JSON.stringify(version));
    return version;
  }
  documentHistory(id: string, options: { before?: number; limit?: number } = {}): WikiHistory {
    this.get<WikiDocument>('document', id);
    const before = options.before === undefined ? null : integer(options.before, 'before');
    const limit = options.limit === undefined ? 20 : integer(options.limit, 'limit');
    if (limit > 100) throw new HttpError(400, 'limit must be at most 100.');
    const rows = this.database.prepare("SELECT json_remove(data, '$.content') AS data FROM wiki_versions WHERE document_id = ? AND (? IS NULL OR number < ?) ORDER BY number DESC LIMIT ?").all(id, before, before, limit + 1) as JsonRow[];
    const versions = rows.slice(0, limit).map(row => JSON.parse(row.data) as WikiVersionSummary);
    const first = this.database.prepare('SELECT MIN(number) AS number FROM wiki_versions WHERE document_id = ?').get(id) as { number: number };
    return { versions, nextBefore: rows.length > limit ? versions[versions.length - 1]!.number : null, firstAvailableVersion: first.number };
  }
  documentVersion(id: string, number: number): WikiVersion {
    this.get<WikiDocument>('document', id);
    integer(number, 'version');
    const row = this.database.prepare('SELECT data FROM wiki_versions WHERE document_id = ? AND number = ?').get(id, number) as JsonRow | undefined;
    if (!row) throw new HttpError(404, `Version ${number} of document ${id} was not found.`);
    return JSON.parse(row.data) as WikiVersion;
  }
  documentDetail(id: string): WikiDetail {
    return { document: this.get<WikiDocument>('document', id), history: this.documentHistory(id), activity: this.activities(id) };
  }
  createRevision(input: unknown, attribution?: ActorAttribution): RevisionDetail {
    const data = object(input, ['title', 'summary', 'kind', 'files', 'repositoryId', 'projectId']);
    const kind = choice(data.kind, 'kind', ['code', 'paper', 'document']);
    const source = files(data.files);
    const now = new Date().toISOString();
    const revision: Revision = { id: this.nextId('revision', kind === 'code' ? 'D' : kind === 'paper' ? 'P' : 'L'), title: string(data.title, 'Title'), summary: optionalString(data.summary, 'Summary'), kind, status: 'needs_review', repositoryId: this.reference(data.repositoryId, 'repository'), projectId: this.reference(data.projectId, 'project'), currentVersion: 1, createdAt: now, updatedAt: now };
    this.save('revision', revision); this.saveVersion(revision, source, 'Initial version', attribution); this.event(revision.id, 'created', `Created ${kind === 'paper' ? 'paper' : 'revision'} ${revision.title}.`, attribution); return this.detail(revision.id);
  }
  private saveVersion(revision: Revision, source: SourceFile[], message: string, attribution?: ActorAttribution): RevisionVersion {
    const version: RevisionVersion = { ...(attribution ? { attribution } : {}), id: randomUUID(), revisionId: revision.id, number: revision.currentVersion, files: source, message, contentHash: contentHash(source), createdAt: new Date().toISOString() };
    this.database.prepare('INSERT INTO versions (id, revision_id, number, data) VALUES (?, ?, ?, ?)').run(version.id, revision.id, version.number, JSON.stringify(version)); return version;
  }
  requireVersion(id: string, expected: unknown): RevisionDetail {
    const version = integer(expected, 'expectedVersion'); const detail = this.detail(id);
    if (detail.revision.currentVersion !== version) throw new HttpError(409, 'This revision changed. Reload before continuing.');
    return detail;
  }
  createVersion(id: string, input: unknown, attribution?: ActorAttribution): RevisionDetail {
    const data = object(input, ['files', 'message', 'expectedVersion']);
    const { revision } = this.requireVersion(id, data.expectedVersion);
    const source = files(data.files); const message = string(data.message, 'Message', 10_000);
    revision.currentVersion += 1; revision.status = 'needs_review'; revision.updatedAt = new Date().toISOString();
    this.save('revision', revision); this.saveVersion(revision, source, message, attribution); this.event(id, 'version_created', `Uploaded version ${revision.currentVersion}. Previous acceptance no longer applies.`, attribution); return this.detail(id);
  }
  updateRevision(id: string, input: unknown, attribution?: ActorAttribution): Revision {
    const data = object(input, ['status', 'expectedVersion']);
    const detail = this.requireVersion(id, data.expectedVersion);
    const status = choice(data.status, 'status', ['draft', 'needs_review', 'changes_requested', 'accepted', 'closed']);
    const version = detail.versions.find(item => item.number === detail.revision.currentVersion)!;
    if (status === 'accepted') {
      const reviews = detail.reviews.filter(review => review.versionId === version.id && review.contentHash === version.contentHash);
      if (!reviews.length || reviews.some(review => review.findings.some(finding => finding.severity === 'error'))) throw new HttpError(409, 'Acceptance requires current-version review evidence with no error findings.');
    }
    const revision = { ...detail.revision, status, updatedAt: new Date().toISOString() };
    this.save('revision', revision); this.event(id, status, `${status === 'closed' ? 'Manually closed' : `Set status to ${status.replaceAll('_', ' ')}`} at version ${revision.currentVersion}.`, attribution); return revision;
  }
  createComment(id: string, input: unknown, attribution?: ActorAttribution): ReviewComment {
    return this.discussionMutation(() => {
      const data = object(input, ['body', 'versionId', 'filePath', 'line', 'passage', 'suggestion']);
      const version = this.commentVersion(id, data.versionId);
      const filePath = data.filePath === undefined || data.filePath === null ? null : string(data.filePath, 'File path', 240);
      const file = filePath ? version.files.find(item => item.path === filePath) : undefined;
      if (filePath && !file) throw new HttpError(400, 'Comment file does not exist in the selected version.');
      let line = data.line === undefined || data.line === null ? null : integer(data.line, 'Line');
      if (line !== null && (!file || line > file.content.split('\n').length)) throw new HttpError(400, 'Comment line must exist in the selected file and version.');
      let anchor: PassageAnchor | undefined;
      if (data.passage !== undefined) {
        if (!filePath || !file) throw new HttpError(400, 'A passage requires a file in the selected version.');
        const passage = object(data.passage, ['start', 'end', 'quote']);
        if (typeof passage.start !== 'number' || typeof passage.end !== 'number') throw new HttpError(400, 'Passage offsets must be numbers.');
        const quote = string(passage.quote, 'Passage quote', 20_000, true);
        try { anchor = createPassageAnchor(version, filePath, { start: passage.start, end: passage.end, quote }); }
        catch (error) { if (error instanceof RangeError) throw new HttpError(400, error.message); throw error; }
        const firstLine = file.content.slice(0, anchor.start).split('\n').length;
        if (line !== null && line !== firstLine) throw new HttpError(400, 'Comment line must match the beginning of the selected passage.');
        line = firstLine;
      }
      let suggestion: SuggestedReplacement | undefined;
      if (data.suggestion !== undefined) {
        if (!anchor) throw new HttpError(400, 'A suggested replacement requires an exact passage anchor.');
        const proposed = object(data.suggestion, ['replacement']);
        try { suggestion = validateSuggestion(anchor, { replacement: string(proposed.replacement, 'Suggested replacement', 20_000, true) }); }
        catch (error) { if (error instanceof RangeError) throw new HttpError(400, error.message); throw error; }
      }
      const commentId = randomUUID();
      const comment: ReviewComment = { id: commentId, threadId: commentId, revisionId: id, versionId: version.id, filePath, line, ...(anchor ? { anchor } : {}), ...(suggestion ? { suggestion } : {}), body: string(data.body, 'Comment', 20_000), author: attribution?.displayName ?? 'You', ...(attribution ? { attribution } : {}), createdAt: new Date().toISOString() };
      this.insertComment(comment);
      const thread: ReviewThread = { id: commentId, revisionId: id, rootCommentId: commentId, status: 'open', version: 1, createdAt: comment.createdAt, updatedAt: comment.createdAt };
      this.database.prepare('INSERT INTO review_threads (id, revision_id, root_comment_id, data) VALUES (?, ?, ?, ?)').run(thread.id, id, commentId, JSON.stringify(thread));
      this.event(id, 'commented', `Commented on version ${version.number}${filePath ? `, ${filePath}${line ? `:${line}` : ''}` : ''}.`, attribution); return comment;
    });
  }
  private discussionMutation<T>(work: () => T): T {
    this.database.exec('SAVEPOINT discussion_write');
    try {
      // A no-op write acquires the SQLite writer lock before thread versions
      // are read, including direct Store callers outside an API transaction.
      this.database.prepare("UPDATE sequences SET value = value WHERE name = 'revision'").run();
      const result = work(); this.database.exec('RELEASE discussion_write'); return result;
    } catch (error) { this.database.exec('ROLLBACK TO discussion_write; RELEASE discussion_write'); throw error; }
  }
  private commentVersion(id: string, value: unknown): RevisionVersion {
    this.get<Revision>('revision', id);
    const versionId = string(value, 'Version ID', 100);
    const row = this.database.prepare('SELECT data FROM versions WHERE revision_id = ? AND id = ?').get(id, versionId) as JsonRow | undefined;
    if (!row) throw new HttpError(400, 'Comment version does not belong to this revision.');
    return JSON.parse(row.data) as RevisionVersion;
  }
  private thread(id: string, threadId: string): ReviewThread {
    const row = typeof threadId === 'string' && threadId.length <= 100
      ? this.database.prepare('SELECT data FROM review_threads WHERE revision_id = ? AND id = ?').get(id, threadId) as JsonRow | undefined : undefined;
    if (!row) throw new HttpError(404, 'Discussion thread was not found.', 'THREAD_UNAVAILABLE');
    return JSON.parse(row.data) as ReviewThread;
  }
  private insertComment(comment: ReviewComment): void {
    this.database.prepare('INSERT INTO comments (id, revision_id, version_id, data) VALUES (?, ?, ?, ?)').run(comment.id, comment.revisionId, comment.versionId, JSON.stringify(comment));
  }
  private advanceThread(thread: ReviewThread, now: string): ReviewThread {
    if (!Number.isSafeInteger(thread.version + 1)) throw new HttpError(409, 'This discussion has reached the supported version limit.');
    return { ...thread, version: thread.version + 1, updatedAt: now };
  }
  private saveThread(thread: ReviewThread): void {
    this.database.prepare('UPDATE review_threads SET data = ? WHERE id = ? AND revision_id = ?').run(JSON.stringify(thread), thread.id, thread.revisionId);
  }
  createReply(id: string, threadId: string, input: unknown, attribution?: ActorAttribution): ReviewComment {
    return this.discussionMutation(() => {
      const thread = this.thread(id, threadId);
      const data = object(input, ['body', 'viewedVersionId']);
      const viewedVersion = this.commentVersion(id, data.viewedVersionId);
      const row = this.database.prepare('SELECT data FROM comments WHERE revision_id = ? AND id = ?').get(id, thread.rootCommentId) as JsonRow | undefined;
      if (!row) throw new HttpError(404, 'Discussion thread was not found.', 'THREAD_UNAVAILABLE');
      const root = JSON.parse(row.data) as ReviewComment;
      const comment: ReviewComment = { id: randomUUID(), threadId, revisionId: id, versionId: root.versionId, viewedVersionId: viewedVersion.id, filePath: root.filePath, line: root.line, ...(root.anchor ? { anchor: root.anchor } : {}), body: string(data.body, 'Reply', 20_000), author: attribution?.displayName ?? 'You', ...(attribution ? { attribution } : {}), createdAt: new Date().toISOString() };
      const updated = this.advanceThread(thread, comment.createdAt);
      this.insertComment(comment); this.saveThread(updated);
      this.event(id, 'replied', `Replied to a discussion while viewing version ${viewedVersion.number}.`, attribution);
      return comment;
    });
  }
  updateThread(id: string, threadId: string, input: unknown, attribution?: ActorAttribution): ReviewThread {
    return this.discussionMutation(() => {
      const current = this.thread(id, threadId);
      const data = object(input, ['status', 'expectedThreadVersion', 'versionId']);
      if (integer(data.expectedThreadVersion, 'expectedThreadVersion') !== current.version) throw new HttpError(409, 'This discussion changed. Reload its replies before changing its status.');
      const status = choice(data.status, 'status', ['open', 'resolved']);
      if (status === current.status) throw new HttpError(409, 'This discussion already has the requested status.');
      const version = this.commentVersion(id, data.versionId);
      const thread = { ...this.advanceThread(current, new Date().toISOString()), status };
      const event: ReviewThreadEvent = { id: randomUUID(), revisionId: id, threadId, action: status === 'resolved' ? 'resolved' : 'reopened', versionId: version.id, threadVersion: thread.version, actor: attribution?.displayName ?? 'You', ...(attribution ? { attribution } : {}), createdAt: thread.updatedAt };
      this.saveThread(thread);
      this.database.prepare('INSERT INTO thread_events (id, revision_id, thread_id, version_id, data) VALUES (?, ?, ?, ?, ?)').run(event.id, id, threadId, version.id, JSON.stringify(event));
      this.event(id, event.action, `${status === 'resolved' ? 'Resolved' : 'Reopened'} a discussion while viewing version ${version.number}.`, attribution);
      return thread;
    });
  }
  applySuggestion(id: string, commentId: string, input: unknown, attribution?: ActorAttribution): RevisionDetail {
    return this.discussionMutation(() => {
      const missing = () => new HttpError(404, 'Suggested replacement was not found.', 'SUGGESTION_UNAVAILABLE');
      const row = typeof commentId === 'string' && commentId.length <= 100
        ? this.database.prepare('SELECT c.data AS comment_data, t.data AS thread_data FROM comments c JOIN review_threads t ON t.root_comment_id = c.id AND t.revision_id = c.revision_id WHERE c.revision_id = ? AND c.id = ?').get(id, commentId) as { comment_data: string; thread_data: string } | undefined : undefined;
      if (!row) throw missing();
      const comment = JSON.parse(row.comment_data) as ReviewComment;
      const thread = JSON.parse(row.thread_data) as ReviewThread;
      if (!comment.anchor || !comment.suggestion || comment.threadId !== thread.id || thread.rootCommentId !== comment.id || comment.viewedVersionId !== undefined) throw missing();
      if (this.database.prepare('SELECT id FROM suggestion_applications WHERE comment_id = ?').get(comment.id)) throw new HttpError(409, 'This suggested replacement has already been applied.');
      const data = object(input, ['expectedVersion', 'expectedVersionId', 'expectedContentHash', 'expectedThreadVersion']);
      const detail = this.requireVersion(id, data.expectedVersion);
      const expectedVersionId = string(data.expectedVersionId, 'Expected version ID', 100);
      const expectedContentHash = string(data.expectedContentHash, 'Expected content hash', 64);
      if (!/^[a-f0-9]{64}$/.test(expectedContentHash)) throw new HttpError(400, 'Expected content hash must be a SHA-256 digest.');
      if (integer(data.expectedThreadVersion, 'expectedThreadVersion') !== thread.version) throw new HttpError(409, 'This discussion changed. Reload its replies before applying the suggestion.');
      const from = detail.versions.find(version => version.number === detail.revision.currentVersion)!;
      const actualHash = contentHash(from.files);
      if (from.id !== expectedVersionId || actualHash !== expectedContentHash || actualHash !== from.contentHash
        || comment.versionId !== from.id || comment.anchor.versionId !== from.id || comment.anchor.contentHash !== actualHash
        || comment.filePath !== comment.anchor.filePath) throw new HttpError(409, 'The suggestion must match the exact current source version and content. Review the current source before proposing another replacement.');
      let source: SourceFile[];
      try { source = applySuggestedReplacement(from, comment.anchor, comment.suggestion); }
      catch (error) { if (error instanceof RangeError) throw new HttpError(409, 'The saved suggestion no longer matches its original source. Review the source before proposing another replacement.'); throw error; }
      // Validate the complete result, including UTF-8 byte limits, before any
      // source write. Provider/client input cannot supply an alternative patch.
      const validated = files(source);
      if (!Number.isSafeInteger(detail.revision.currentVersion + 1)) throw new HttpError(409, 'This revision has reached the supported version limit.');
      const nextThread = this.advanceThread(thread, new Date().toISOString());
      const updated = this.createVersion(id, { files: validated, message: `Applied suggested replacement from version ${from.number}.`, expectedVersion: from.number }, attribution);
      const to = updated.versions.find(version => version.number === updated.revision.currentVersion)!;
      const application: SuggestionApplication = {
        id: randomUUID(), revisionId: id, commentId: comment.id, threadId: thread.id, fromVersionId: from.id, toVersionId: to.id,
        fromContentHash: actualHash, toContentHash: to.contentHash, threadVersion: nextThread.version,
        actor: attribution?.displayName ?? 'You', ...(attribution ? { attribution } : {}), createdAt: nextThread.updatedAt,
      };
      this.saveThread(nextThread);
      this.database.prepare('INSERT INTO suggestion_applications (id, revision_id, comment_id, thread_id, from_version_id, to_version_id, data) VALUES (?, ?, ?, ?, ?, ?, ?)').run(application.id, id, comment.id, thread.id, from.id, to.id, JSON.stringify(application));
      this.event(id, 'suggestion_applied', `Applied a suggested replacement from version ${from.number} as version ${to.number}. Discussion status is unchanged.`, attribution);
      return this.detail(id);
    });
  }
  saveReview(id: string, expectedVersion: number, analysis: ReviewAnalysis, attribution?: ActorAttribution): ReviewRun {
    const detail = this.requireVersion(id, expectedVersion); const version = detail.versions.find(item => item.number === expectedVersion)!;
    const review: ReviewRun = { ...analysis, ...(attribution ? { attribution } : {}), id: randomUUID(), revisionId: id, versionId: version.id, contentHash: version.contentHash, createdAt: new Date().toISOString() };
    this.database.prepare('INSERT INTO reviews (id, revision_id, version_id, data) VALUES (?, ?, ?, ?)').run(review.id, id, version.id, JSON.stringify(review));
    if (detail.revision.status === 'accepted' && analysis.findings.some(finding => finding.severity === 'error')) {
      this.save('revision', { ...detail.revision, status: 'changes_requested', updatedAt: new Date().toISOString() });
      this.event(id, 'acceptance_invalidated', `New review errors invalidated acceptance of version ${expectedVersion}.`, attribution);
    }
    this.event(id, 'reviewed', `${analysis.provider === 'local' ? 'Local checks' : 'AI review'} completed for version ${expectedVersion}: ${analysis.findings.length} findings.`, attribution); return review;
  }
  detail(id: string): RevisionDetail {
    const revision = this.get<Revision>('revision', id);
    const versions = (this.database.prepare('SELECT data FROM versions WHERE revision_id = ? ORDER BY number').all(id) as JsonRow[]).map(row => JSON.parse(row.data) as RevisionVersion);
    const comments = (this.database.prepare('SELECT data FROM comments WHERE revision_id = ? ORDER BY rowid').all(id) as JsonRow[]).map(row => JSON.parse(row.data) as ReviewComment);
    const threads = (this.database.prepare('SELECT data FROM review_threads WHERE revision_id = ? ORDER BY rowid').all(id) as JsonRow[]).map(row => JSON.parse(row.data) as ReviewThread);
    const threadEvents = (this.database.prepare('SELECT data FROM thread_events WHERE revision_id = ? ORDER BY rowid').all(id) as JsonRow[]).map(row => JSON.parse(row.data) as ReviewThreadEvent);
    const suggestionApplications = (this.database.prepare('SELECT data FROM suggestion_applications WHERE revision_id = ? ORDER BY rowid').all(id) as JsonRow[]).map(row => JSON.parse(row.data) as SuggestionApplication);
    const reviews = (this.database.prepare('SELECT data FROM reviews WHERE revision_id = ? ORDER BY rowid DESC').all(id) as JsonRow[]).map(row => JSON.parse(row.data) as ReviewRun);
    return { revision, versions, comments, threads, threadEvents, suggestionApplications, reviews, activity: this.activities(id) };
  }
}

export function createStore(options: StoreOptions = {}): Store { return new Store(options); }
