import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { REVISION_VIEW_LIMITS, isRevisionSavedView, isRevisionViewId, revisionViewInput, revisionViewNameKey, validRevisionViewResult, type RevisionSavedView, type RevisionViewAction, type RevisionViewCreateInput, type RevisionViewDeleteInput, type RevisionViewEditInput, type RevisionViewInput, type RevisionViewResult } from '../shared/revision-views.ts';
import { HttpError } from './validation.ts';

interface StoredView { id: string; sequence: number; principal_id: string; version: number; deleted: number; kind: string; name_key: string; data: string }
interface Operation { principalId: string; action: RevisionViewAction; viewId: string; retryKeySha256: string; inputSha256: string; input: RevisionViewInput; before: RevisionSavedView | null; result: RevisionViewResult }
const unavailable = () => new HttpError(404, 'Saved revision view is unavailable.', 'REVISION_VIEW_UNAVAILABLE');
const invalid = () => new HttpError(409, 'Saved revision view evidence cannot be verified.', 'REVISION_VIEW_INVALID_RECEIPT');
const changed = () => new HttpError(409, 'The saved revision view changed. Reload before editing.', 'REVISION_VIEW_CHANGED');
const limited = () => new HttpError(422, 'An account may keep at most 100 saved revision views.', 'REVISION_VIEW_LIMIT');
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const principal = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 240 && !v.includes('\0') && !/[\uD800-\uDFFF]/u.test(v);
const natural = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const inputHash = (action: RevisionViewAction, id: string | null, input: RevisionViewInput) => hash(JSON.stringify([action, id, input]));
function decode<T>(value: string): T { try { return JSON.parse(value) as T; } catch { throw invalid(); } }
function parse(action: RevisionViewAction, value: unknown): RevisionViewInput { try { return revisionViewInput(action, value); } catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'Invalid saved revision view.', 'REVISION_VIEW_INVALID_INPUT'); } }
let counter = 0;
function scope<T>(db: DatabaseSync, work: () => T, write = false): T {
  const name = `revision_views_${++counter}`; db.exec(`SAVEPOINT ${name}`);
  try { if (write) db.exec('UPDATE revision_view_sequence SET value=value WHERE 0'); const result = work(); db.exec(`RELEASE ${name}`); return result; }
  catch (error) { db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
}

export function initializeRevisionViews(db: DatabaseSync): void {
  scope(db, () => {
    const schema = `
      CREATE TABLE IF NOT EXISTS revision_view_sequence(singleton INTEGER PRIMARY KEY CHECK(singleton=1),value INTEGER NOT NULL CHECK(value>=0 AND value<=999999999999999));
      CREATE TABLE IF NOT EXISTS revision_view_records(id TEXT PRIMARY KEY,sequence INTEGER NOT NULL UNIQUE CHECK(sequence>0 AND sequence<=999999999999999),principal_id TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0 AND version<=9007199254740991),deleted INTEGER NOT NULL CHECK(deleted IN(0,1)),kind TEXT NOT NULL CHECK(kind IN('code','paper','document')),name_key TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),CHECK(id='RV'||sequence AND json_extract(data,'$.id')=id AND json_extract(data,'$.version')=version AND json_extract(data,'$.filters.kind')=kind));
      CREATE UNIQUE INDEX IF NOT EXISTS revision_view_active_names ON revision_view_records(principal_id,kind,name_key) WHERE deleted=0;
      CREATE INDEX IF NOT EXISTS revision_view_owner ON revision_view_records(principal_id,deleted,kind,name_key,sequence);
      CREATE TABLE IF NOT EXISTS revision_view_operations(principal_id TEXT NOT NULL,retry_key_sha256 TEXT NOT NULL,view_id TEXT NOT NULL REFERENCES revision_view_records(id),view_version INTEGER NOT NULL CHECK(view_version>0 AND view_version<=9007199254740991),input_sha256 TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),PRIMARY KEY(principal_id,retry_key_sha256),UNIQUE(view_id,view_version),CHECK(json_extract(data,'$.principalId')=principal_id AND json_extract(data,'$.viewId')=view_id AND json_extract(data,'$.retryKeySha256')=retry_key_sha256 AND json_extract(data,'$.inputSha256')=input_sha256 AND json_extract(data,'$.result.view.version')=view_version));
      CREATE TRIGGER IF NOT EXISTS revision_view_operation_no_update BEFORE UPDATE ON revision_view_operations BEGIN SELECT RAISE(ABORT,'Saved revision view evidence is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS revision_view_operation_no_delete BEFORE DELETE ON revision_view_operations BEGIN SELECT RAISE(ABORT,'Saved revision view evidence is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS revision_view_identity BEFORE UPDATE OF id,sequence,principal_id ON revision_view_records BEGIN SELECT RAISE(ABORT,'Saved revision view identity is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS revision_view_final BEFORE UPDATE ON revision_view_records WHEN OLD.deleted=1 BEGIN SELECT RAISE(ABORT,'Deleted saved revision views cannot change'); END;
      CREATE TRIGGER IF NOT EXISTS revision_view_no_delete BEFORE DELETE ON revision_view_records BEGIN SELECT RAISE(ABORT,'Saved revision view tombstones are durable'); END;
    `;
    const existing = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name GLOB 'revision_view_*' ORDER BY type,name").all() as { name: string }[];
    if (existing.length) {
      const canonical = new DatabaseSync(':memory:');
      try {
        canonical.exec(schema);
        const expected = canonical.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name GLOB 'revision_view_*' ORDER BY type,name").all() as { name: string }[];
        for (const row of existing) if (!isDeepStrictEqual(row, expected.find(item => item.name === row.name))) throw new Error(`Unexpected ${row.name} schema; saved revision view migration was not applied.`);
      } finally { canonical.close(); }
    }
    db.exec(schema);
    db.prepare('INSERT OR IGNORE INTO revision_view_sequence(singleton,value) VALUES(1,0)').run();
  });
}

/** Private preferences do not enter entities, activity, notifications or shared revision state. */
export class RevisionViewStore {
  constructor(private readonly database: DatabaseSync) {}
  private epoch(): number {
    const row = this.database.prepare("SELECT value FROM policy_meta WHERE name='epoch'").get() as { value: number } | undefined;
    if (!row || !natural(row.value)) throw invalid(); return row.value;
  }
  requireOwner(owner: string, id: string): void {
    if (!principal(owner) || !isRevisionViewId(id) || !this.database.prepare('SELECT 1 FROM revision_view_records WHERE id=? AND principal_id=?').get(id, owner)) throw unavailable();
  }
  private operation(owner: string, key: string): Operation | null {
    const row = this.database.prepare('SELECT view_id,view_version,input_sha256,data FROM revision_view_operations WHERE principal_id=? AND retry_key_sha256=?').get(owner, key) as { view_id: string; view_version: number; input_sha256: string; data: string } | undefined;
    if (!row) return null;
    const operation = decode<Operation>(row.data);
    if (!operation || typeof operation !== 'object' || operation.principalId !== owner || operation.viewId !== row.view_id || operation.retryKeySha256 !== key || operation.inputSha256 !== row.input_sha256 || !['create', 'edit', 'delete'].includes(operation.action)) throw invalid();
    this.requireOwner(owner, operation.viewId);
    let input: RevisionViewInput;
    try { input = revisionViewInput(operation.action, operation.input); } catch { throw invalid(); }
    if (!isDeepStrictEqual(input, operation.input) || operation.inputSha256 !== inputHash(operation.action, operation.action === 'create' ? null : operation.viewId, input)
      || !validRevisionViewResult(operation.result, operation.action, input, operation.viewId) || operation.result.view.version !== row.view_version || operation.result.accessEpoch !== input.expectedAccessEpoch) throw invalid();
    if (operation.action === 'create') { if (operation.before !== null) throw invalid(); }
    else {
      const before = operation.before;
      if (!isRevisionSavedView(before) || before.id !== operation.viewId || before.version + 1 !== operation.result.view.version || before.createdAt !== operation.result.view.createdAt || before.updatedAt > operation.result.view.updatedAt) throw invalid();
      const previous = this.database.prepare('SELECT data FROM revision_view_operations WHERE principal_id=? AND view_id=? AND view_version=?').get(owner, operation.viewId, before.version) as { data: string } | undefined;
      const prior = previous ? decode<Operation>(previous.data) : null;
      if (!prior || prior.result.deleted || !isDeepStrictEqual(prior.result.view, before)) throw invalid();
      if (operation.action === 'delete' && !isDeepStrictEqual(operation.result.view, { ...before, version: before.version + 1, updatedAt: operation.result.view.updatedAt })) throw invalid();
    }
    return operation;
  }
  private record(owner: string, id: string): { view: RevisionSavedView; deleted: boolean } {
    this.requireOwner(owner, id);
    const row = this.database.prepare('SELECT * FROM revision_view_records WHERE id=? AND principal_id=?').get(id, owner) as unknown as StoredView;
    const view = decode<RevisionSavedView>(row.data);
    if (!isRevisionSavedView(view) || view.id !== id || id !== `RV${row.sequence}` || view.version !== row.version || view.filters.kind !== row.kind || revisionViewNameKey(view.name) !== row.name_key || ![0, 1].includes(row.deleted)) throw invalid();
    const latest = this.database.prepare('SELECT retry_key_sha256 FROM revision_view_operations WHERE principal_id=? AND view_id=? ORDER BY view_version DESC LIMIT 1').get(owner, id) as { retry_key_sha256: string } | undefined;
    const operation = latest && this.operation(owner, latest.retry_key_sha256);
    if (!operation || operation.result.deleted !== Boolean(row.deleted) || !isDeepStrictEqual(operation.result.view, view)) throw invalid();
    return { view, deleted: Boolean(row.deleted) };
  }
  list(owner: string): RevisionSavedView[] {
    if (!principal(owner)) throw unavailable();
    return scope(this.database, () => {
      const rows = this.database.prepare('SELECT id FROM revision_view_records WHERE principal_id=? AND deleted=0 ORDER BY kind,name_key,sequence LIMIT ?').all(owner, REVISION_VIEW_LIMITS.views + 1) as { id: string }[];
      if (rows.length > REVISION_VIEW_LIMITS.views) throw limited(); return rows.map(row => this.record(owner, row.id).view);
    });
  }
  get(owner: string, id: string): RevisionSavedView { return scope(this.database, () => { const stored = this.record(owner, id); if (stored.deleted) throw unavailable(); return stored.view; }); }
  /** Verify outer idempotency evidence against the immutable private operation before presenting it. */
  present(owner: string, action: RevisionViewAction, id: string | null, input: RevisionViewInput, retryKeySha256: string, value: unknown): RevisionViewResult {
    const operation = this.operation(owner, retryKeySha256);
    if (!operation || operation.action !== action || id !== null && operation.viewId !== id || !isDeepStrictEqual(operation.input, input) || !isDeepStrictEqual(operation.result, value)) throw invalid();
    this.record(owner, operation.viewId);
    return { ...operation.result, accessEpoch: this.epoch() };
  }
  mutate(owner: string, action: RevisionViewAction, id: string | null, value: unknown, retryKeySha256: string, canViewProject: (id: string) => boolean): RevisionViewResult {
    return scope(this.database, () => {
      if (!principal(owner)) throw unavailable();
      if (action !== 'create') this.requireOwner(owner, id ?? '');
      if (!['create', 'edit', 'delete'].includes(action) || action === 'create' && id !== null || !digest(retryKeySha256)) throw new HttpError(400, 'A saved-view action and stable retry key are required.', 'REVISION_VIEW_INVALID_INPUT');
      const input = parse(action, value), fingerprint = inputHash(action, id, input), replay = this.operation(owner, retryKeySha256);
      if (replay) {
        if (replay.action !== action || action !== 'create' && replay.viewId !== id || replay.inputSha256 !== fingerprint || !isDeepStrictEqual(replay.input, input)) throw new HttpError(409, 'This retry key already names a different saved-view request.', 'REVISION_VIEW_RETRY_MISMATCH');
        this.record(owner, replay.viewId); return replay.result;
      }
      const epoch = this.epoch(); if (epoch !== input.expectedAccessEpoch) throw new HttpError(409, 'Access changed. Reload before changing the saved view.', 'ACCESS_EPOCH_CHANGED');
      const stored = id === null ? null : this.record(owner, id), before = stored?.view ?? null;
      if (stored && (stored.deleted || before!.version !== (input as RevisionViewEditInput | RevisionViewDeleteInput).expectedVersion)) throw changed();
      if (before && !Number.isSafeInteger(before.version + 1)) throw new HttpError(422, 'Saved-view version limit reached.', 'REVISION_VIEW_LIMIT');
      const writing = action === 'delete' ? null : input as RevisionViewCreateInput;
      if (writing?.filters.projectId && writing.filters.projectId !== before?.filters.projectId && !canViewProject(writing.filters.projectId)) throw new HttpError(404, 'Selected project is unavailable.', 'PROJECT_UNAVAILABLE');
      if (writing && this.database.prepare('SELECT 1 FROM revision_view_records WHERE principal_id=? AND kind=? AND name_key=? AND deleted=0 AND id<>?').get(owner, writing.filters.kind, revisionViewNameKey(writing.name), id ?? '')) throw new HttpError(409, 'A saved view with this name already exists for this revision kind.', 'REVISION_VIEW_NAME_CONFLICT');
      let sequence: number;
      if (action === 'create') {
        const count = (this.database.prepare('SELECT count(*) AS count FROM revision_view_records WHERE principal_id=? AND deleted=0').get(owner) as { count: number }).count;
        if (count >= REVISION_VIEW_LIMITS.views) throw limited();
        const current = this.database.prepare('SELECT value FROM revision_view_sequence WHERE singleton=1').get() as { value: number } | undefined;
        if (!current || !natural(current.value) || current.value >= 999999999999999) throw new HttpError(422, 'Saved-view identity limit reached.', 'REVISION_VIEW_LIMIT');
        sequence = current.value + 1; id = `RV${sequence}`;
        this.database.prepare('UPDATE revision_view_sequence SET value=? WHERE singleton=1').run(sequence);
      } else sequence = Number(id!.slice(2));
      const now = new Date(Math.max(Date.now(), before ? Date.parse(before.updatedAt) : 0)).toISOString();
      const view: RevisionSavedView = { id: id!, version: before ? before.version + 1 : 1, name: writing?.name ?? before!.name, filters: writing?.filters ?? before!.filters, createdAt: before?.createdAt ?? now, updatedAt: now };
      const deleted = action === 'delete', result: RevisionViewResult = { view, deleted, accessEpoch: epoch };
      if (action === 'create') this.database.prepare('INSERT INTO revision_view_records(id,sequence,principal_id,version,deleted,kind,name_key,data) VALUES(?,?,?,?,?,?,?,?)').run(view.id, sequence, owner, view.version, Number(deleted), view.filters.kind, revisionViewNameKey(view.name), JSON.stringify(view));
      else this.database.prepare('UPDATE revision_view_records SET version=?,deleted=?,kind=?,name_key=?,data=? WHERE id=? AND principal_id=?').run(view.version, Number(deleted), view.filters.kind, revisionViewNameKey(view.name), JSON.stringify(view), view.id, owner);
      const operation: Operation = { principalId: owner, action, viewId: view.id, retryKeySha256, inputSha256: fingerprint, input, before, result };
      this.database.prepare('INSERT INTO revision_view_operations(principal_id,retry_key_sha256,view_id,view_version,input_sha256,data) VALUES(?,?,?,?,?,?)').run(owner, retryKeySha256, view.id, view.version, fingerprint, JSON.stringify(operation));
      return result;
    }, true);
  }
}
