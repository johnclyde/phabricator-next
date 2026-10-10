import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ActorAttribution, Activity, AppState, Project, Repository, Revision, RevisionDetail, RevisionVersion, ReviewAnalysis, ReviewComment, ReviewRun, SourceFile, Task, WikiDetail, WikiDocument, WikiHistory, WikiVersion, WikiVersionSummary } from '../shared/types.ts';
import { choice, files, HttpError, integer, object, optionalString, remoteUrl, string } from './validation.ts';
import { initializePolicies, registerDefaultPolicy } from './policy.ts';

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
  constructor(options: StoreOptions = {}) {
    const path = options.path ?? '.data/phabricator.sqlite';
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
    const version = (this.database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version > 4) { this.database.close(); throw new Error(`Database schema ${version} is newer than this application supports.`); }
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
  mutate(key: string | undefined, fingerprint: string, work: () => MutationResponse, authorize?: () => void, present?: (response: MutationResponse) => MutationResponse): MutationResponse {
    return this.transaction(() => {
      // Credential revocation in another process may commit while BEGIN waits.
      // Check authority after acquiring the write lock and before replay/writes.
      authorize?.();
      if (key) {
        const existing = this.replay(key, fingerprint);
        if (existing) return present ? present(existing) : existing;
      }
      const response = work();
      if (key) this.database.prepare('INSERT INTO idempotency (key, fingerprint, status, body, created_at) VALUES (?, ?, ?, ?, ?)').run(key, fingerprint, response.status, JSON.stringify(response.body), new Date().toISOString());
      return present ? present(response) : response;
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
    const row = this.database.prepare('SELECT data FROM entities WHERE kind = ? AND id = ?').get(kind, id) as JsonRow | undefined;
    if (!row) throw new HttpError(404, `${kind} ${id} was not found.`);
    return JSON.parse(row.data) as T;
  }
  private all<T extends Entity>(kind: Kind): T[] {
    return (this.database.prepare('SELECT data FROM entities WHERE kind = ? ORDER BY rowid DESC').all(kind) as JsonRow[]).map(row => JSON.parse(row.data) as T);
  }
  private save(kind: Kind, value: Entity): void {
    const created = this.database.prepare('INSERT INTO entities (id, kind, data) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING').run(value.id, kind, JSON.stringify(value));
    if (created.changes) registerDefaultPolicy(this.database, value.id);
    else this.database.prepare('UPDATE entities SET data = ? WHERE id = ?').run(JSON.stringify(value), value.id);
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
    return { projects: this.all('project'), repositories: this.all('repository'), revisions: this.all('revision'), tasks: this.all('task'), documents: this.all('document'), activity: this.activities(), spaces: [], access: {}, principals: [], accessEpoch: 0, canCreate: false, ai, mode };
  }
  createProject(input: unknown, attribution?: ActorAttribution): Project {
    const data = object(input, ['name', 'description', 'color']);
    const color = data.color === undefined ? '#5b83b5' : string(data.color, 'Color', 7);
    if (!/^#[a-f\d]{6}$/i.test(color)) throw new HttpError(400, 'Color must be a six-digit hexadecimal color.');
    const project: Project = { id: this.nextId('project', 'PROJ'), name: string(data.name, 'Name'), description: optionalString(data.description, 'Description'), color };
    this.save('project', project); this.event(project.id, 'created', `Created project ${project.name}.`, attribution); return project;
  }
  createRepository(input: unknown, attribution?: ActorAttribution): Repository {
    const data = object(input, ['name', 'remoteUrl', 'description', 'defaultBranch']);
    const repository: Repository = { id: this.nextId('repository', 'R'), name: string(data.name, 'Name'), remoteUrl: remoteUrl(data.remoteUrl), description: optionalString(data.description, 'Description'), defaultBranch: data.defaultBranch === undefined ? 'main' : string(data.defaultBranch, 'Default branch') };
    this.save('repository', repository); this.event(repository.id, 'registered', `Registered ${repository.name}; no remote content fetched.`, attribution); return repository;
  }
  createTask(input: unknown, attribution?: ActorAttribution): Task { return this.writeTask(input, undefined, attribution); }
  updateTask(id: string, input: unknown, attribution?: ActorAttribution): Task { return this.writeTask(input, this.get<Task>('task', id), attribution); }
  private writeTask(input: unknown, current?: Task, attribution?: ActorAttribution): Task {
    const data = object(input, ['title', 'description', 'status', 'priority', 'projectId']);
    if (current && Object.keys(data).length === 0) throw new HttpError(400, 'At least one task field is required.');
    const now = new Date().toISOString();
    const task: Task = {
      id: current?.id ?? this.nextId('task', 'T'), title: data.title === undefined && current ? current.title : string(data.title, 'Title'),
      description: data.description === undefined && current ? current.description : optionalString(data.description, 'Description'),
      status: data.status === undefined ? current?.status ?? 'open' : choice(data.status, 'status', ['open', 'in_progress', 'resolved']),
      priority: data.priority === undefined ? current?.priority ?? 'normal' : choice(data.priority, 'priority', ['low', 'normal', 'high', 'urgent']),
      projectId: data.projectId === undefined && current ? current.projectId : this.reference(data.projectId, 'project'),
      createdAt: current?.createdAt ?? now, updatedAt: now,
    };
    this.save('task', task); this.event(task.id, current ? 'updated' : 'created', `${current ? 'Updated' : 'Created'} task ${task.title}.`, attribution); return task;
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
    const data = object(input, ['body', 'versionId', 'filePath', 'line']); const detail = this.detail(id);
    const versionId = string(data.versionId, 'Version ID', 100); const version = detail.versions.find(item => item.id === versionId);
    if (!version) throw new HttpError(400, 'Comment version does not belong to this revision.');
    const filePath = data.filePath === undefined || data.filePath === null ? null : string(data.filePath, 'File path', 240);
    const file = filePath ? version.files.find(item => item.path === filePath) : undefined;
    if (filePath && !file) throw new HttpError(400, 'Comment file does not exist in the selected version.');
    const line = data.line === undefined || data.line === null ? null : integer(data.line, 'Line');
    if (line !== null && (!file || line > file.content.split('\n').length)) throw new HttpError(400, 'Comment line must exist in the selected file and version.');
    const comment: ReviewComment = { id: randomUUID(), revisionId: id, versionId, filePath, line, body: string(data.body, 'Comment', 20_000), author: attribution?.displayName ?? 'You', ...(attribution ? { attribution } : {}), createdAt: new Date().toISOString() };
    this.database.prepare('INSERT INTO comments (id, revision_id, version_id, data) VALUES (?, ?, ?, ?)').run(comment.id, id, versionId, JSON.stringify(comment));
    this.event(id, 'commented', `Commented on version ${version.number}${filePath ? `, ${filePath}${line ? `:${line}` : ''}` : ''}.`, attribution); return comment;
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
    const reviews = (this.database.prepare('SELECT data FROM reviews WHERE revision_id = ? ORDER BY rowid DESC').all(id) as JsonRow[]).map(row => JSON.parse(row.data) as ReviewRun);
    return { revision, versions, comments, reviews, activity: this.activities(id) };
  }
}

export function createStore(options: StoreOptions = {}): Store { return new Store(options); }
