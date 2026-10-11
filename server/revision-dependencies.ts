import { isRevisionStatus } from '../shared/revision-status.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ActorAttribution } from '../shared/types.ts';
import { isRevisionId, revisionDependencyInput, revisionDependencyChanges, REVISION_DEPENDENCY_LIMITS } from '../shared/revision-dependencies.ts';
import type { RevisionDependencyInput, RevisionDependencyQuery, RevisionDependencyPage, RevisionDependencyHistoryQuery, RevisionDependencyHistory, RevisionDependencyReceipt, RevisionDependencyTransaction, RevisionDependencyReference, RevisionDependencyChange } from '../shared/revision-dependencies.ts';
import { HttpError, object, string } from './validation.ts';
import type { RevisionMetadataState } from '../shared/revision-metadata.ts';

type Receipt = Omit<RevisionDependencyReceipt, 'accessEpoch'>;
export interface RevisionDependencyOperation { id: string; revisionId: string; input: RevisionDependencyInput; inputSha256: string; attribution: ActorAttribution; receipt: Receipt }
type Edge = { child_id: string; parent_id: string };
type TransactionRow = { id: string; revision_id: string; peer_id: string; sequence: number; relationship_version: number; operation_id: string; data: string };
const unavailable = () => new HttpError(404, 'The revision dependency record is unavailable.', 'REVISION_DEPENDENCY_UNAVAILABLE');
const changed = () => new HttpError(409, 'Revision relationships changed. Reload them before continuing.', 'REVISION_DEPENDENCIES_CHANGED');
const limit = () => new HttpError(422, 'This dependency operation exceeds the supported graph or history scan limit.', 'REVISION_DEPENDENCY_LIMIT');
const invalidReceipt = () => new HttpError(409, 'The dependency operation cannot be verified.', 'REVISION_DEPENDENCY_INVALID_RECEIPT');
const nonnegative = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const opposite = (direction: RevisionDependencyInput['direction']) => direction === 'parents' ? 'children' as const : 'parents' as const;
let savepoint = 0;
function normalized(input: unknown): RevisionDependencyInput {
  try { return revisionDependencyInput(input); } catch (error) { throw new HttpError(400, (error as Error).message, 'REVISION_DEPENDENCY_INVALID_INPUT'); }
}
export function revisionDependencyInputHash(input: RevisionDependencyInput): string { return createHash('sha256').update(JSON.stringify(normalized(input))).digest('hex'); }
function actor(value: ActorAttribution): ActorAttribution {
  if (!value || typeof value.principalId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value.principalId)) throw new HttpError(400, 'A valid authenticated dependency author is required.');
  return { principalId: value.principalId, displayName: string(value.displayName, 'Author name', 240), credentialId: value.credentialId === null ? null : string(value.credentialId, 'Credential ID', 240), requestId: string(value.requestId, 'Request ID', 240) };
}
function pageLimit(value: unknown): number { if (value === undefined) return 25; if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > REVISION_DEPENDENCY_LIMITS.page) throw new HttpError(400, 'Choose a page size between 1 and 100.'); return Number(value); }
function next(value: number): number { if (!Number.isSafeInteger(value + 1)) throw limit(); return value + 1; }

/** Additive schema only. The root Store owns migrations and user_version. */
export function initializeRevisionDependencies(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS revision_dependency_versions(revision_id TEXT PRIMARY KEY REFERENCES entities(id),version INTEGER NOT NULL CHECK(version>=0 AND version<=9007199254740991));
    CREATE TABLE IF NOT EXISTS revision_dependency_operations(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES entities(id),input_sha256 TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),CHECK(json_extract(data,'$.id')=id AND json_extract(data,'$.revisionId')=revision_id AND json_extract(data,'$.inputSha256')=input_sha256));
    CREATE TABLE IF NOT EXISTS revision_dependency_edges(child_id TEXT NOT NULL REFERENCES entities(id),parent_id TEXT NOT NULL REFERENCES entities(id),operation_id TEXT NOT NULL REFERENCES revision_dependency_operations(id),PRIMARY KEY(child_id,parent_id),CHECK(child_id<>parent_id));
    CREATE INDEX IF NOT EXISTS revision_dependency_children ON revision_dependency_edges(parent_id,child_id);
    CREATE TABLE IF NOT EXISTS revision_dependency_transactions(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES entities(id),peer_id TEXT NOT NULL REFERENCES entities(id),sequence INTEGER NOT NULL CHECK(sequence>0 AND sequence<=9007199254740991),relationship_version INTEGER NOT NULL CHECK(relationship_version>0 AND relationship_version<=9007199254740991),operation_id TEXT NOT NULL REFERENCES revision_dependency_operations(id),data TEXT NOT NULL CHECK(json_valid(data)),UNIQUE(revision_id,sequence),UNIQUE(operation_id,revision_id,peer_id),CHECK(revision_id<>peer_id),CHECK(json_extract(data,'$.id')=id AND json_extract(data,'$.revisionId')=revision_id AND json_extract(data,'$.change.revisionId')=peer_id AND json_extract(data,'$.sequence')=sequence AND json_extract(data,'$.relationshipVersion')=relationship_version AND json_extract(data,'$.operationId')=operation_id));
    CREATE INDEX IF NOT EXISTS revision_dependency_operation_history ON revision_dependency_transactions(operation_id);
    CREATE TRIGGER IF NOT EXISTS revision_dependency_operations_no_update BEFORE UPDATE ON revision_dependency_operations BEGIN SELECT RAISE(ABORT,'Dependency operations are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS revision_dependency_operations_no_delete BEFORE DELETE ON revision_dependency_operations BEGIN SELECT RAISE(ABORT,'Dependency operations are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS revision_dependency_transactions_no_update BEFORE UPDATE ON revision_dependency_transactions BEGIN SELECT RAISE(ABORT,'Dependency history is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS revision_dependency_transactions_no_delete BEFORE DELETE ON revision_dependency_transactions BEGIN SELECT RAISE(ABORT,'Dependency history is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS revision_dependency_edges_no_update BEFORE UPDATE ON revision_dependency_edges BEGIN SELECT RAISE(ABORT,'Dependency edges must be added or removed'); END;
    CREATE TRIGGER IF NOT EXISTS revision_dependency_edges_revisions BEFORE INSERT ON revision_dependency_edges WHEN NOT EXISTS(SELECT 1 FROM entities WHERE id=NEW.child_id AND kind='revision') OR NOT EXISTS(SELECT 1 FROM entities WHERE id=NEW.parent_id AND kind='revision') BEGIN SELECT RAISE(ABORT,'Dependency endpoints must be revisions'); END;
  `);
}

/** Storage only. API callers enforce current source authority and endpoint view
 * permissions; cycle detection deliberately does not accept a visibility filter. */
export class RevisionDependencyStore {
  constructor(private readonly database: DatabaseSync, private readonly readMetadata: (id: string) => Pick<RevisionMetadataState, 'title' | 'updatedAt'>) {}
  private requireRevision(id: string): void {
    if (!isRevisionId(id) || !this.database.prepare("SELECT 1 FROM entities WHERE id=? AND kind='revision'").get(id)) throw unavailable();
  }
  version(id: string): number {
    this.requireRevision(id);
    const row = this.database.prepare('SELECT version FROM revision_dependency_versions WHERE revision_id=?').get(id) as { version: number } | undefined;
    if (row && !nonnegative(row.version)) throw invalidReceipt(); return row?.version ?? 0;
  }
  private pin(id: string, expected: unknown): number {
    const version = this.version(id);
    if (expected !== undefined && !nonnegative(expected)) throw new HttpError(400, 'Choose a nonnegative relationship version.');
    if (expected !== undefined && version !== expected) throw changed(); return version;
  }
  private mutation<T>(id: string, work: () => T): T {
    const name = `revision_dependency_write_${++savepoint}`; this.database.exec(`SAVEPOINT ${name}`);
    try {
      // SQLite acquires the writer lock even when the initial source has no row.
      this.database.prepare('UPDATE revision_dependency_versions SET version=version WHERE revision_id=?').run(id);
      const result = work(); this.database.exec(`RELEASE ${name}`); return result;
    } catch (error) { this.database.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
  }
  private reading<T>(work: () => T): T {
    const name = `revision_dependency_read_${++savepoint}`; this.database.exec(`SAVEPOINT ${name}`);
    try { const result = work(); this.database.exec(`RELEASE ${name}`); return result; }
    catch (error) { this.database.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
  }
  page(id: string, input: RevisionDependencyQuery, visible: (id: string) => boolean): Omit<RevisionDependencyPage, 'accessEpoch'> { return this.reading(() => this.readPage(id, input, visible)); }
  private readPage(id: string, input: RevisionDependencyQuery, visible: (id: string) => boolean): Omit<RevisionDependencyPage, 'accessEpoch'> {
    const query = object(input, ['direction', 'after', 'limit', 'expectedRelationshipVersion']), version = this.pin(id, query.expectedRelationshipVersion), count = pageLimit(query.limit);
    if (query.direction !== 'parents' && query.direction !== 'children' || query.after !== undefined && !isRevisionId(query.after)) throw new HttpError(400, 'Choose a valid dependency direction and cursor.');
    const direction = query.direction as RevisionDependencyQuery['direction'], source = direction === 'parents' ? 'child_id' : 'parent_id', peer = direction === 'parents' ? 'parent_id' : 'child_id';
    let cursor = query.after as string | undefined ?? '', scanned = 0; const revisions: RevisionDependencyReference[] = [];
    for (;;) {
      const rows = this.database.prepare(`SELECT ${peer} AS id FROM revision_dependency_edges WHERE ${source}=? AND ${peer}>? ORDER BY ${peer} COLLATE BINARY LIMIT 100`).all(id, cursor) as { id: string }[];
      for (const row of rows) {
        if (++scanned > REVISION_DEPENDENCY_LIMITS.graphEdges) throw limit(); cursor = row.id;
        if (!visible(row.id)) continue;
        if (revisions.length === count) return { revisionId: id, direction, relationshipVersion: version, revisions, nextAfter: revisions.at(-1)!.id };
        const item = this.database.prepare("SELECT json_extract(data,'$.id') AS id,json_extract(data,'$.title') AS title,json_extract(data,'$.kind') AS kind,json_extract(data,'$.status') AS status,json_extract(data,'$.currentVersion') AS currentVersion,json_extract(data,'$.updatedAt') AS updatedAt FROM entities WHERE id=? AND kind='revision'").get(row.id) as RevisionDependencyReference | undefined;
        if (!item || item.id !== row.id || typeof item.title !== 'string' || !['code', 'paper', 'document'].includes(item.kind) || !isRevisionStatus(item.status) || !Number.isSafeInteger(item.currentVersion) || item.currentVersion < 1 || typeof item.updatedAt !== 'string') throw invalidReceipt();
        let metadata;
        try { metadata = this.readMetadata(item.id); } catch { throw invalidReceipt(); }
        if (typeof metadata.title !== 'string' || !metadata.title.length || metadata.title.length > 1000 || metadata.title.includes('\0') || metadata.updatedAt !== null && (typeof metadata.updatedAt !== 'string' || !Number.isFinite(Date.parse(metadata.updatedAt)))) throw invalidReceipt();
        revisions.push({ ...item, title: metadata.title, updatedAt: metadata.updatedAt !== null && Date.parse(metadata.updatedAt) > Date.parse(item.updatedAt) ? metadata.updatedAt : item.updatedAt });
      }
      if (rows.length < 100) return { revisionId: id, direction, relationshipVersion: version, revisions, nextAfter: null };
    }
  }
  history(id: string, input: RevisionDependencyHistoryQuery, visible: (id: string) => boolean): Omit<RevisionDependencyHistory, 'accessEpoch'> { return this.reading(() => this.readHistory(id, input, visible)); }
  private readHistory(id: string, input: RevisionDependencyHistoryQuery, visible: (id: string) => boolean): Omit<RevisionDependencyHistory, 'accessEpoch'> {
    const query = object(input, ['before', 'limit', 'expectedRelationshipVersion']), version = this.pin(id, query.expectedRelationshipVersion), count = pageLimit(query.limit);
    if (query.before !== undefined && (!Number.isSafeInteger(query.before) || Number(query.before) < 1)) throw new HttpError(400, 'Choose a positive history cursor.');
    let cursor = query.before as number | undefined, scanned = 0; const transactions: RevisionDependencyTransaction[] = [];
    for (;;) {
      const rows = this.database.prepare(`SELECT id,revision_id,peer_id,sequence,relationship_version,operation_id,data FROM revision_dependency_transactions WHERE revision_id=? ${cursor === undefined ? '' : 'AND sequence<?'} ORDER BY sequence DESC LIMIT 100`).all(id, ...(cursor === undefined ? [] : [cursor])) as TransactionRow[];
      for (const row of rows) {
        if (++scanned > REVISION_DEPENDENCY_LIMITS.graphEdges) throw limit(); cursor = row.sequence;
        if (!visible(row.peer_id)) continue;
        if (transactions.length === count) return { revisionId: id, relationshipVersion: version, transactions, nextBefore: transactions.at(-1)!.sequence };
        transactions.push(this.transaction(row));
      }
      if (rows.length < 100) return { revisionId: id, relationshipVersion: version, transactions, nextBefore: null };
    }
  }
  private transaction(row: TransactionRow): RevisionDependencyTransaction {
    let value: RevisionDependencyTransaction; try { value = JSON.parse(row.data) as RevisionDependencyTransaction; } catch { throw invalidReceipt(); }
    if (value.id !== row.id || value.revisionId !== row.revision_id || value.sequence !== row.sequence || value.relationshipVersion !== row.relationship_version || value.operationId !== row.operation_id || value.change?.revisionId !== row.peer_id
      || !['parents', 'children'].includes(value.change.direction) || !['added', 'removed'].includes(value.change.action) || !Number.isSafeInteger(value.sequence) || value.sequence < 1 || !Number.isSafeInteger(value.relationshipVersion) || value.relationshipVersion < 1 || !uuid(value.id) || !uuid(value.operationId) || value.actor !== value.attribution?.displayName || !Number.isFinite(Date.parse(value.createdAt))) throw invalidReceipt();
    try { if (!equal(actor(value.attribution), value.attribution)) throw invalidReceipt(); } catch { throw invalidReceipt(); } return value;
  }
  /** Proposed graph includes the entire unfiltered ancestor closure of each
   * added child. Disconnected unrelated revisions do not consume its budget. */
  private acyclic(add: Edge[], remove: Edge[]): void {
    if (!add.length) return;
    const removed = new Set(remove.map(edge => JSON.stringify([edge.child_id, edge.parent_id]))), additions = new Map<string, string[]>();
    for (const edge of add) additions.set(edge.child_id, [...additions.get(edge.child_id) ?? [], edge.parent_id]);
    const pending = [...new Set(add.map(edge => edge.child_id))], queued = new Set(pending), graph = new Map<string, Set<string>>(); let edges = 0;
    if (queued.size > REVISION_DEPENDENCY_LIMITS.graphNodes) throw limit();
    while (pending.length) {
      const child = pending.pop()!, parents = new Set<string>();
      const rows = this.database.prepare('SELECT parent_id FROM revision_dependency_edges WHERE child_id=? LIMIT ?').all(child, REVISION_DEPENDENCY_LIMITS.graphEdges - edges + 1) as { parent_id: string }[];
      edges += rows.length; if (edges > REVISION_DEPENDENCY_LIMITS.graphEdges) throw limit();
      for (const row of rows) if (!removed.has(JSON.stringify([child, row.parent_id]))) parents.add(row.parent_id);
      for (const parent of additions.get(child) ?? []) { if (!parents.has(parent) && ++edges > REVISION_DEPENDENCY_LIMITS.graphEdges) throw limit(); parents.add(parent); }
      graph.set(child, parents);
      for (const parent of parents) if (!queued.has(parent)) { queued.add(parent); if (queued.size > REVISION_DEPENDENCY_LIMITS.graphNodes) throw limit(); pending.push(parent); }
    }
    const reverse = new Map<string, string[]>(), remaining = new Map<string, number>(), leaves: string[] = [];
    for (const [child, parents] of graph) { remaining.set(child, parents.size); if (!parents.size) leaves.push(child); for (const parent of parents) { const children = reverse.get(parent) ?? []; children.push(child); reverse.set(parent, children); } }
    let visited = 0;
    while (leaves.length) { const parent = leaves.pop()!; visited++; for (const child of reverse.get(parent) ?? []) { const count = remaining.get(child)! - 1; remaining.set(child, count); if (!count) leaves.push(child); } }
    if (visited !== graph.size) throw new HttpError(409, 'This change would create a revision dependency cycle.', 'REVISION_DEPENDENCY_CYCLE');
  }
  mutate(id: string, input: RevisionDependencyInput, attribution: ActorAttribution): Receipt {
    const data = normalized(input), author = actor(attribution);
    return this.mutation(id, () => {
      const current = this.pin(id, data.expectedRelationshipVersion), changes = revisionDependencyChanges(data), additions: Edge[] = [], removals: Edge[] = [];
      for (const change of changes) {
        this.requireRevision(change.revisionId); if (change.revisionId === id) throw new HttpError(400, 'A revision cannot depend on itself.', 'REVISION_DEPENDENCY_SELF');
        const edge = data.direction === 'parents' ? { child_id: id, parent_id: change.revisionId } : { child_id: change.revisionId, parent_id: id };
        const exists = this.database.prepare('SELECT 1 FROM revision_dependency_edges WHERE child_id=? AND parent_id=?').get(edge.child_id, edge.parent_id);
        if (change.action === 'added' && exists) throw new HttpError(409, 'The selected dependency already exists.', 'REVISION_DEPENDENCY_EXISTS');
        if (change.action === 'removed' && !exists) throw new HttpError(409, 'The selected dependency no longer exists.', 'REVISION_DEPENDENCY_MISSING');
        (change.action === 'added' ? additions : removals).push(edge);
      }
      this.acyclic(additions, removals);
      const versions = new Map([id, ...changes.map(change => change.revisionId)].map(revision => [revision, next(revision === id ? current : this.version(revision))]));
      const createdAt = new Date().toISOString(), operationId = randomUUID(), receipt: Receipt = { revisionId: id, relationshipVersion: versions.get(id)!, operationId, changes, createdAt };
      const operation: RevisionDependencyOperation = { id: operationId, revisionId: id, input: data, inputSha256: revisionDependencyInputHash(data), attribution: author, receipt };
      this.database.prepare('INSERT INTO revision_dependency_operations(id,revision_id,input_sha256,data) VALUES(?,?,?,?)').run(operationId, id, operation.inputSha256, JSON.stringify(operation));
      for (const edge of removals) this.database.prepare('DELETE FROM revision_dependency_edges WHERE child_id=? AND parent_id=?').run(edge.child_id, edge.parent_id);
      for (const edge of additions) this.database.prepare('INSERT INTO revision_dependency_edges(child_id,parent_id,operation_id) VALUES(?,?,?)').run(edge.child_id, edge.parent_id, operationId);
      for (const [revision, version] of versions) this.database.prepare('INSERT INTO revision_dependency_versions(revision_id,version) VALUES(?,?) ON CONFLICT(revision_id) DO UPDATE SET version=excluded.version').run(revision, version);
      const sequence = new Map<string, number>();
      const append = (revisionId: string, change: RevisionDependencyChange) => {
        const previous = sequence.get(revisionId) ?? (this.database.prepare('SELECT COALESCE(MAX(sequence),0) AS value FROM revision_dependency_transactions WHERE revision_id=?').get(revisionId) as { value: number }).value;
        const transaction: RevisionDependencyTransaction = { id: randomUUID(), revisionId, sequence: next(previous), relationshipVersion: versions.get(revisionId)!, operationId, change, actor: author.displayName, attribution: author, createdAt };
        this.database.prepare('INSERT INTO revision_dependency_transactions(id,revision_id,peer_id,sequence,relationship_version,operation_id,data) VALUES(?,?,?,?,?,?,?)').run(transaction.id, revisionId, change.revisionId, transaction.sequence, transaction.relationshipVersion, operationId, JSON.stringify(transaction)); sequence.set(revisionId, transaction.sequence);
      };
      for (const change of changes) { append(id, change); append(change.revisionId, { direction: opposite(change.direction), action: change.action, revisionId: id }); }
      return receipt;
    });
  }
  receiptRevisionId(operationId: string): string {
    if (!uuid(operationId)) throw unavailable();
    const row = this.database.prepare('SELECT revision_id FROM revision_dependency_operations WHERE id=?').get(operationId) as { revision_id: string } | undefined;
    if (!row || !isRevisionId(row.revision_id)) throw unavailable(); return row.revision_id;
  }
  receipt(operationId: string): RevisionDependencyOperation {
    const revisionId = this.receiptRevisionId(operationId), row = this.database.prepare('SELECT input_sha256,data FROM revision_dependency_operations WHERE id=?').get(operationId) as { input_sha256: string; data: string };
    try {
      const operation = JSON.parse(row.data) as RevisionDependencyOperation, input = normalized(operation.input), attribution = actor(operation.attribution), receipt = operation.receipt;
      if (operation.id !== operationId || operation.revisionId !== revisionId || !equal(operation.input, input) || !equal(operation.attribution, attribution) || operation.inputSha256 !== revisionDependencyInputHash(input) || row.input_sha256 !== operation.inputSha256
        || !receipt || !Number.isFinite(Date.parse(receipt.createdAt)) || !Number.isSafeInteger(input.expectedRelationshipVersion + 1)
        || !equal(receipt, { revisionId, relationshipVersion: input.expectedRelationshipVersion + 1, operationId, changes: revisionDependencyChanges(input), createdAt: receipt.createdAt })) throw invalidReceipt();
      const rows = this.database.prepare('SELECT id,revision_id,peer_id,sequence,relationship_version,operation_id,data FROM revision_dependency_transactions WHERE operation_id=? LIMIT ?').all(operationId, REVISION_DEPENDENCY_LIMITS.changes * 2 + 1) as TransactionRow[];
      if (rows.length !== receipt.changes.length * 2) throw invalidReceipt();
      const expected = new Map<string, RevisionDependencyChange>();
      for (const change of receipt.changes) { expected.set(JSON.stringify([revisionId, change.revisionId]), change); expected.set(JSON.stringify([change.revisionId, revisionId]), { direction: opposite(change.direction), action: change.action, revisionId }); }
      for (const row of rows) {
        const transaction = this.transaction(row), key = JSON.stringify([transaction.revisionId, transaction.change.revisionId]), change = expected.get(key);
        if (!change || !equal(transaction.change, change) || !equal(transaction.attribution, attribution) || transaction.createdAt !== receipt.createdAt || transaction.revisionId === revisionId && transaction.relationshipVersion !== receipt.relationshipVersion) throw invalidReceipt(); expected.delete(key);
      }
      if (expected.size) throw invalidReceipt(); return operation;
    } catch { throw invalidReceipt(); }
  }
}
