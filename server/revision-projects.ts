import type { NotificationPublisher } from './notifications.ts';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import type { ActorAttribution } from '../shared/types.ts';
import { isRevisionId } from '../shared/revision-dependencies.ts';
import { isRevisionMetadataAttribution } from '../shared/revision-metadata.ts';
import { MAX_PROJECT_DEPTH, normalizeProjectTags, type ProjectTagNode } from '../shared/project-hierarchy.ts';
import { REVISION_PROJECT_LIMITS, isRevisionProjectId, isRevisionProjectState, isRevisionProjectTransaction, revisionProjectCreationInput, revisionProjectInput, validRevisionProjectResult, type RevisionProjectState, type RevisionProjectInput, type RevisionProjectSnapshot, type RevisionProjectTransaction, type RevisionProjectReceipt, type RevisionProjectHistory } from '../shared/revision-projects.ts';
import { HttpError, object } from './validation.ts';

export interface RevisionProjectOperation { id: string; revisionId: string; input: RevisionProjectInput; inputSha256: string; retryKeySha256: string | null; before: RevisionProjectState; hierarchy: ProjectTagNode[]; attribution: ActorAttribution; createdAt: string; receipt: RevisionProjectReceipt }
interface RevisionProjectResponseProjection { revisionId: string; projectIds: string[]; projectVersion: number; projectId: string | null; currentVersion: number; versionId: string; contentHash: string }
interface RevisionProjectResponseBinding { keySha256: string; fingerprint: string; status: number; projection: RevisionProjectResponseProjection }
type Response = { status: number; body: unknown };
const record = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const invalid = () => new HttpError(409, 'Revision project-tag history cannot be verified.', 'REVISION_PROJECT_INVALID_RECEIPT');
const unavailable = () => new HttpError(404, 'Revision project tags are unavailable.', 'REVISION_PROJECT_UNAVAILABLE');
const conflict = () => new HttpError(409, 'Revision project tags changed. Reload before continuing.', 'REVISION_PROJECT_CHANGED');
const natural = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
function decode<T>(value: string): T { try { return JSON.parse(value) as T; } catch { throw invalid(); } }
let sequence = 0;
function scope<T>(db: DatabaseSync, work: () => T, write = false): T {
  const name = `revision_projects_${++sequence}`; db.exec(`SAVEPOINT ${name}`);
  try { if (write) db.exec('UPDATE revision_projects SET version=version WHERE 0'); const result = work(); db.exec(`RELEASE ${name}`); return result; }
  catch (error) { db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
}
function parse(value: unknown): RevisionProjectInput { try { return revisionProjectInput(value); } catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'Invalid project tags.', 'REVISION_PROJECT_INVALID_INPUT'); } }
export function revisionProjectInputHash(input: RevisionProjectInput): string { return createHash('sha256').update(JSON.stringify(parse(input))).digest('hex'); }

/** Additive baselines preserve the original scalar and every historical row. */
export function initializeRevisionProjects(db: DatabaseSync): void {
  scope(db, () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS revision_projects(revision_id TEXT PRIMARY KEY REFERENCES entities(id),version INTEGER NOT NULL CHECK(version>=0 AND version<=9007199254740991),data TEXT NOT NULL CHECK(json_valid(data)),CHECK(json_extract(data,'$.revisionId')=revision_id AND json_extract(data,'$.version')=version));
      CREATE TABLE IF NOT EXISTS revision_project_baselines(revision_id TEXT PRIMARY KEY REFERENCES entities(id),data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE IF NOT EXISTS revision_project_operations(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES entities(id),input_sha256 TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),CHECK(json_extract(data,'$.id')=id AND json_extract(data,'$.revisionId')=revision_id AND json_extract(data,'$.inputSha256')=input_sha256));
      CREATE TABLE IF NOT EXISTS revision_project_transactions(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES entities(id),version INTEGER NOT NULL CHECK(version>0 AND version<=9007199254740991),operation_id TEXT UNIQUE NOT NULL REFERENCES revision_project_operations(id),data TEXT NOT NULL CHECK(json_valid(data)),UNIQUE(revision_id,version),CHECK(json_extract(data,'$.id')=id AND json_extract(data,'$.revisionId')=revision_id AND json_extract(data,'$.projectVersion')=version AND json_extract(data,'$.operationId')=operation_id));
      CREATE TABLE IF NOT EXISTS revision_project_response_bindings(key_sha256 TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,revision_id TEXT NOT NULL REFERENCES entities(id),status INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),CHECK(json_extract(data,'$.keySha256')=key_sha256 AND json_extract(data,'$.fingerprint')=fingerprint AND json_extract(data,'$.projection.revisionId')=revision_id AND json_extract(data,'$.status')=status));
    `);
    for (const table of ['revision_project_baselines', 'revision_project_operations', 'revision_project_transactions', 'revision_project_response_bindings']) db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Revision project evidence is immutable'); END; CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Revision project evidence is immutable'); END;`);
    for (const [table, columns] of Object.entries({ revision_projects: ['revision_id', 'version', 'data'], revision_project_baselines: ['revision_id', 'data'], revision_project_operations: ['id', 'revision_id', 'input_sha256', 'data'], revision_project_transactions: ['id', 'revision_id', 'version', 'operation_id', 'data'], revision_project_response_bindings: ['key_sha256', 'fingerprint', 'revision_id', 'status', 'data'] })) if (!isDeepStrictEqual((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name), columns)) throw new Error(`Unexpected ${table} schema; project-tag migration was not applied.`);
    const store = new RevisionProjectStore(db);
    for (const row of db.prepare("SELECT e.id FROM entities e LEFT JOIN revision_projects p ON p.revision_id=e.id WHERE e.kind='revision' AND p.revision_id IS NULL").all() as { id: string }[]) store.ensure(row.id);
  });
}

/** Source and selected-project authority are checked by the caller under the
 * same writer transaction. Tags never confer access or change source evidence. */
export class RevisionProjectStore {
  private notificationPublisher?: NotificationPublisher;
  connectNotifications(publisher: NotificationPublisher): void { if (this.notificationPublisher) throw new Error('Notifications already connected.'); this.notificationPublisher = publisher; }
  constructor(private readonly database: DatabaseSync) {}
  private entity(id: string): Record<string, unknown> {
    if (!isRevisionId(id)) throw unavailable(); const row = this.database.prepare("SELECT data FROM entities WHERE id=? AND kind='revision'").get(id) as { data: string } | undefined;
    if (!row) throw unavailable(); const value = decode<Record<string, unknown>>(row.data); if (!value || Array.isArray(value) || value.id !== id) throw invalid(); return value;
  }
  /** Read only selected/current tags and their complete immutable ancestry.
   * Project ancestry cannot change under the existing project schema triggers. */
  private graph(ids: readonly string[]): ProjectTagNode[] {
    const nodes = new Map<string, ProjectTagNode>();
    for (const id of ids) {
      let current: string | null = id; const seen = new Set<string>();
      while (current !== null) {
        if (seen.has(current) || seen.size > MAX_PROJECT_DEPTH || nodes.size > 2 * REVISION_PROJECT_LIMITS.projects * (MAX_PROJECT_DEPTH + 1)) throw invalid(); seen.add(current);
        const row: ProjectTagNode | undefined = this.database.prepare("SELECT h.project_id AS id,h.parent_id AS parentId,h.kind FROM project_hierarchy h JOIN entities e ON e.id=h.project_id AND e.kind='project' WHERE h.project_id=?").get(current) as ProjectTagNode | undefined;
        if (!row || !isRevisionProjectId(row.id) || row.parentId !== null && !isRevisionProjectId(row.parentId) || !['project', 'milestone'].includes(row.kind)) throw unavailable();
        nodes.set(row.id, { id: row.id, parentId: row.parentId, kind: row.kind }); current = row.parentId;
      }
    }
    const graph = [...nodes.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    try { normalizeProjectTags(ids, graph); } catch { throw invalid(); } return graph;
  }
  private normalized(input: RevisionProjectInput, before: RevisionProjectState, graph: ProjectTagNode[]): string[] {
    const selected = new Set(input.projectIds);
    let ids: string[]; try { ids = input.action === 'remove' ? before.projectIds.filter(id => !selected.has(id)) : normalizeProjectTags(input.action === 'set' ? input.projectIds : [...before.projectIds, ...input.projectIds], graph).sort(); } catch { throw invalid(); }
    if (ids.length > REVISION_PROJECT_LIMITS.projects) throw new HttpError(422, 'A revision may have at most 100 project tags.', 'REVISION_PROJECT_LIMIT'); return ids;
  }
  creationTags(input: { projectId?: unknown; projectIds?: unknown }): string[] {
    let parsed: ReturnType<typeof revisionProjectCreationInput>; try { parsed = revisionProjectCreationInput(input); } catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'Invalid project tags.', 'REVISION_PROJECT_INVALID_INPUT'); }
    const ids = parsed.projectIds ?? (parsed.projectId ? [parsed.projectId] : []); return normalizeProjectTags(ids, this.graph(ids)).sort();
  }
  ensure(id: string, initial?: string[]): void {
    this.entity(id); if (this.database.prepare('SELECT 1 FROM revision_projects WHERE revision_id=?').get(id)) { this.state(id); return; }
    if (this.database.prepare('SELECT 1 FROM revision_project_baselines WHERE revision_id=?').get(id)) throw invalid();
    const raw = this.entity(id), ids = initial ?? (raw.projectId === null || raw.projectId === undefined ? [] : [raw.projectId]);
    if (!Array.isArray(ids) || !ids.every(isRevisionProjectId)) throw invalid();
    const tags: RevisionProjectState = { revisionId: id, version: 0, projectIds: [...ids].sort(), updatedAt: null };
    if (!isRevisionProjectState(tags, id)) throw invalid(); this.graph(tags.projectIds);
    this.database.prepare('INSERT INTO revision_project_baselines(revision_id,data) VALUES(?,?)').run(id, JSON.stringify(tags));
    this.database.prepare('INSERT INTO revision_projects(revision_id,version,data) VALUES(?,0,?)').run(id, JSON.stringify(tags));
  }
  private transactionAt(id: string, version: number): RevisionProjectTransaction {
    const row = this.database.prepare('SELECT id,operation_id,data FROM revision_project_transactions WHERE revision_id=? AND version=?').get(id, version) as { id: string; operation_id: string; data: string } | undefined;
    if (!row) throw invalid(); const t = decode<RevisionProjectTransaction>(row.data);
    if (!isRevisionProjectTransaction(t, id) || !uuid(t.id) || t.id !== row.id || t.operationId !== row.operation_id || t.projectVersion !== version || isDeepStrictEqual(t.before.projectIds, t.after.projectIds)) throw invalid(); return t;
  }
  private stateAt(id: string, version: number): RevisionProjectState {
    if (!natural(version)) throw invalid(); if (version > 0) return this.transactionAt(id, version).after;
    const row = this.database.prepare('SELECT data FROM revision_project_baselines WHERE revision_id=?').get(id) as { data: string } | undefined; if (!row) throw invalid(); const tags = decode<RevisionProjectState>(row.data);
    if (!isRevisionProjectState(tags, id) || tags.version !== 0) throw invalid(); return tags;
  }
  state(id: string): RevisionProjectState {
    this.entity(id); const row = this.database.prepare('SELECT version,data FROM revision_projects WHERE revision_id=?').get(id) as { version: number; data: string } | undefined;
    if (!row || !natural(row.version)) throw invalid(); const tags = decode<RevisionProjectState>(row.data), latest = this.database.prepare('SELECT max(version) AS version FROM revision_project_transactions WHERE revision_id=?').get(id) as { version: number | null };
    if (!isRevisionProjectState(tags, id) || tags.version !== row.version || (latest.version ?? 0) !== tags.version || !isDeepStrictEqual(tags, this.stateAt(id, tags.version))) throw invalid(); return tags;
  }
  /** Historical presentation proof; source mutations do not create tag events. */
  historicalState(id: string, version: number): RevisionProjectState {
    return scope(this.database, () => { const current = this.state(id); if (!natural(version) || version > current.version) throw invalid(); return this.stateAt(id, version); });
  }
  private responseProjection(response: Response): RevisionProjectResponseProjection | null {
    if (!record(response.body) || !record(response.body.revision)) return null;
    const revision = response.body.revision;
    if (!isRevisionId(revision.id) || !natural(revision.currentVersion) || revision.currentVersion < 1 || !natural(revision.projectVersion) || !Array.isArray(revision.projectIds) || !revision.projectIds.every(isRevisionProjectId) || revision.projectIds.length > REVISION_PROJECT_LIMITS.projects || revision.projectIds.some((id, i, ids) => i > 0 && ids[i - 1]! >= id) || revision.projectId !== (revision.projectIds[0] ?? null) || !Array.isArray(response.body.versions)) throw invalid();
    const heads = response.body.versions.filter((value: unknown) => record(value) && value.number === revision.currentVersion);
    if (heads.length !== 1) throw invalid(); const head: unknown = heads[0];
    if (!record(head) || head.revisionId !== revision.id || typeof head.id !== 'string' || head.id.length < 1 || head.id.length > 240 || !digest(head.contentHash)) throw invalid();
    return { revisionId: revision.id, projectIds: [...revision.projectIds], projectVersion: revision.projectVersion, projectId: revision.projectId as string | null, currentVersion: revision.currentVersion, versionId: head.id, contentHash: head.contentHash };
  }
  private verifyProjection(projection: RevisionProjectResponseProjection): void {
    const tags = this.historicalState(projection.revisionId, projection.projectVersion);
    if (!isDeepStrictEqual(tags.projectIds, projection.projectIds) || projection.projectId !== (tags.projectIds[0] ?? null)) throw invalid();
    const row = this.database.prepare("SELECT id,json_extract(data,'$.id') AS data_id,json_extract(data,'$.revisionId') AS revision_id,json_extract(data,'$.number') AS number,json_extract(data,'$.contentHash') AS hash FROM versions WHERE revision_id=? AND number=?").get(projection.revisionId, projection.currentVersion) as { id: string; data_id: string; revision_id: string; number: number; hash: string } | undefined;
    if (!row || row.id !== projection.versionId || row.data_id !== projection.versionId || row.revision_id !== projection.revisionId || row.number !== projection.currentVersion || row.hash !== projection.contentHash) throw invalid();
  }
  /** Atomically bind the exact observed tag state in fresh keyed RevisionDetail
   * responses. This includes source no-ops; it never changes a source payload. */
  captureResponse(key: string, fingerprint: string, response: Response): void {
    const projection = this.responseProjection(response); if (!projection) return;
    scope(this.database, () => {
      if (!natural(response.status) || response.status < 100 || response.status > 599 || typeof fingerprint !== 'string' || !fingerprint) throw invalid();
      this.verifyProjection(projection);
      const keySha256 = createHash('sha256').update(key).digest('hex');
      const binding: RevisionProjectResponseBinding = { keySha256, fingerprint, status: response.status, projection };
      this.database.prepare('INSERT INTO revision_project_response_bindings(key_sha256,fingerprint,revision_id,status,data) VALUES(?,?,?,?,?)').run(keySha256, fingerprint, projection.revisionId, response.status, JSON.stringify(binding));
    }, true);
  }
  /** Unbound legacy receipts remain untouched. A binding is checked by key
   * before inspecting the response, so stripping fields cannot bypass proof. */
  verifyResponse(key: string, fingerprint: string, response: Response): void {
    scope(this.database, () => {
      const keySha256 = createHash('sha256').update(key).digest('hex');
      const row = this.database.prepare('SELECT fingerprint,revision_id,status,data FROM revision_project_response_bindings WHERE key_sha256=?').get(keySha256) as { fingerprint: string; revision_id: string; status: number; data: string } | undefined;
      if (!row) return;
      const binding = decode<RevisionProjectResponseBinding>(row.data), projection = this.responseProjection(response);
      if (!binding || Object.keys(binding).sort().join(',') !== 'fingerprint,keySha256,projection,status' || binding.keySha256 !== keySha256 || binding.fingerprint !== fingerprint || row.fingerprint !== fingerprint || binding.status !== response.status || row.status !== response.status || !projection || row.revision_id !== projection.revisionId || !isDeepStrictEqual(binding.projection, projection)) throw invalid();
      this.verifyProjection(projection);
    });
  }
  snapshot(id: string): Omit<RevisionProjectSnapshot, 'access' | 'accessEpoch'> { return scope(this.database, () => ({ tags: this.state(id) })); }
  history(id: string, input: { before?: number; limit?: number; expectedProjectVersion?: number } = {}): Omit<RevisionProjectHistory, 'accessEpoch'> {
    return scope(this.database, () => {
      const query = object(input, ['before', 'limit', 'expectedProjectVersion']), tags = this.state(id), limit = query.limit ?? 25;
      if (!natural(limit) || limit < 1 || limit > REVISION_PROJECT_LIMITS.page || query.before !== undefined && (!natural(query.before) || query.before < 1) || query.expectedProjectVersion !== undefined && !natural(query.expectedProjectVersion)) throw new HttpError(400, 'Choose valid project history versions and a page size between 1 and 100.');
      if (query.expectedProjectVersion !== undefined && query.expectedProjectVersion !== tags.version) throw conflict();
      const rows = this.database.prepare('SELECT version FROM revision_project_transactions WHERE revision_id=? AND (? IS NULL OR version<?) ORDER BY version DESC LIMIT ?').all(id, query.before ?? null, query.before ?? null, limit + 1) as { version: number }[];
      const transactions = rows.slice(0, limit).map(row => this.transactionAt(id, row.version)); return { revisionId: id, projectVersion: tags.version, transactions, nextBefore: rows.length > limit ? transactions.at(-1)!.projectVersion : null };
    });
  }
  mutate(id: string, input: RevisionProjectInput, actor: ActorAttribution, retryKeySha256: string | null = null): RevisionProjectReceipt {
    const request = parse(input); if (!isRevisionMetadataAttribution(actor) || retryKeySha256 !== null && !digest(retryKeySha256)) throw new HttpError(400, 'Authenticated project-tag attribution and valid retry identity are required.');
    return scope(this.database, () => {
      const before = this.state(id), epoch = (this.database.prepare("SELECT value FROM policy_meta WHERE name='epoch'").get() as { value: number }).value;
      if (!natural(epoch)) throw invalid(); if (epoch !== request.expectedAccessEpoch) throw new HttpError(409, 'Access changed. Reload before continuing.', 'ACCESS_EPOCH_CHANGED');
      if (before.version !== request.expectedProjectVersion) throw conflict();
      const hierarchy = this.graph([...before.projectIds, ...request.projectIds]), projectIds = this.normalized(request, before, hierarchy), changed = !isDeepStrictEqual(before.projectIds, projectIds);
      if (changed && !Number.isSafeInteger(before.version + 1)) throw new HttpError(422, 'Revision project tags reached their version limit.', 'REVISION_PROJECT_LIMIT');
      const createdAt = new Date().toISOString(), operationId = randomUUID(), inputSha256 = revisionProjectInputHash(request), after: RevisionProjectState = changed ? { revisionId: id, version: before.version + 1, projectIds, updatedAt: createdAt } : before;
      const transaction: RevisionProjectTransaction | null = changed ? { id: randomUUID(), revisionId: id, operationId, projectVersion: after.version, before, after, attribution: { ...actor }, createdAt } : null;
      const receipt: RevisionProjectReceipt = { revisionId: id, operationId, inputSha256, changed, tags: after, transaction, accessEpoch: epoch };
      const operation: RevisionProjectOperation = { id: operationId, revisionId: id, input: request, inputSha256, retryKeySha256, before, hierarchy, attribution: { ...actor }, createdAt, receipt };
      this.database.prepare('INSERT INTO revision_project_operations(id,revision_id,input_sha256,data) VALUES(?,?,?,?)').run(operationId, id, inputSha256, JSON.stringify(operation));
      if (transaction) { this.database.prepare('INSERT INTO revision_project_transactions(id,revision_id,version,operation_id,data) VALUES(?,?,?,?,?)').run(transaction.id, id, after.version, operationId, JSON.stringify(transaction)); this.database.prepare('UPDATE revision_projects SET version=?,data=? WHERE revision_id=?').run(after.version, JSON.stringify(after), id); }
      if (changed) this.notificationPublisher?.({ revisionId: id, kind: 'projects_changed', cause: { type: 'projects', id: operationId }, attribution: actor }); return receipt;
    }, true);
  }
  operationRevisionId(id: string): string { if (!uuid(id)) throw invalid(); const row = this.database.prepare('SELECT revision_id FROM revision_project_operations WHERE id=?').get(id) as { revision_id: string } | undefined; if (!row || !isRevisionId(row.revision_id)) throw invalid(); return row.revision_id; }
  operation(id: string): RevisionProjectOperation {
    return scope(this.database, () => {
      try {
        const revisionId = this.operationRevisionId(id), row = this.database.prepare('SELECT input_sha256,data FROM revision_project_operations WHERE id=?').get(id) as { input_sha256: string; data: string }, operation = decode<RevisionProjectOperation>(row.data);
        if (!operation || Object.keys(operation).sort().join(',') !== 'attribution,before,createdAt,hierarchy,id,input,inputSha256,receipt,retryKeySha256,revisionId' || operation.id !== id || operation.revisionId !== revisionId || !isRevisionMetadataAttribution(operation.attribution) || !isDeepStrictEqual(parse(operation.input), operation.input) || operation.inputSha256 !== row.input_sha256 || operation.inputSha256 !== revisionProjectInputHash(operation.input) || operation.retryKeySha256 !== null && !digest(operation.retryKeySha256) || typeof operation.createdAt !== 'string' || operation.createdAt.length > 64 || !Number.isFinite(Date.parse(operation.createdAt))) throw invalid();
        const request = operation.input, before = this.stateAt(revisionId, request.expectedProjectVersion), hierarchy = this.graph([...before.projectIds, ...request.projectIds]);
        if (!isDeepStrictEqual(before, operation.before) || !isDeepStrictEqual(hierarchy, operation.hierarchy) || !validRevisionProjectResult(operation.receipt, revisionId, request, operation.attribution.principalId) || operation.receipt.operationId !== id || operation.receipt.inputSha256 !== operation.inputSha256 || operation.receipt.accessEpoch !== request.expectedAccessEpoch) throw invalid();
        const projectIds = this.normalized(request, before, operation.hierarchy), changed = !isDeepStrictEqual(before.projectIds, projectIds), after: RevisionProjectState = changed ? { revisionId, version: before.version + 1, projectIds, updatedAt: operation.createdAt } : before;
        if (operation.receipt.changed !== changed || !isDeepStrictEqual(operation.receipt.tags, after)) throw invalid();
        if (changed) { const transaction = this.transactionAt(revisionId, after.version); if (!isDeepStrictEqual(transaction, operation.receipt.transaction) || !isDeepStrictEqual(transaction.before, before) || !isDeepStrictEqual(transaction.after, after) || !isDeepStrictEqual(transaction.attribution, operation.attribution) || transaction.createdAt !== operation.createdAt) throw invalid(); }
        else if (this.database.prepare('SELECT 1 FROM revision_project_transactions WHERE operation_id=?').get(id)) throw invalid();
        return operation;
      } catch { throw invalid(); }
    });
  }
}
