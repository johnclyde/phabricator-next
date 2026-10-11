import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import type { ActorAttribution } from '../shared/types.ts';
import { isRevisionId } from '../shared/revision-dependencies.ts';
import { isRevisionAuthorHead, type RevisionAuthorHead } from '../shared/revision-authorship.ts';
import { DEFAULT_REVISION_METADATA_CONFIG, REVISION_METADATA_LIMITS, isRevisionMetadataAttribution, isRevisionMetadataConfig, isRevisionMetadataState, isRevisionMetadataTransaction, revisionMetadataFields, revisionMetadataInput, validRevisionMetadataResult, type RevisionMetadataConfig, type RevisionMetadataFields, type RevisionMetadataState, type RevisionMetadataSnapshot, type RevisionMetadataInput, type RevisionMetadataTransaction, type RevisionMetadataReceipt, type RevisionMetadataHistory } from '../shared/revision-metadata.ts';
import { HttpError, object } from './validation.ts';

export interface RevisionMetadataOperation { id: string; revisionId: string; input: RevisionMetadataInput; inputSha256: string; attribution: ActorAttribution; head: RevisionAuthorHead; before: RevisionMetadataState; config: RevisionMetadataConfig; createdAt: string; receipt: RevisionMetadataReceipt }
type Baseline = { metadata: RevisionMetadataState; head: RevisionAuthorHead };
const invalid = () => new HttpError(409, 'Revision metadata history cannot be verified.', 'REVISION_METADATA_INVALID_RECEIPT');
const unavailable = () => new HttpError(404, 'Revision metadata is unavailable.', 'REVISION_METADATA_UNAVAILABLE');
const conflict = () => new HttpError(409, 'Revision metadata, source or configuration changed. Reload before continuing.', 'REVISION_METADATA_CHANGED');
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function decode<T>(value: string): T { try { return JSON.parse(value) as T; } catch { throw invalid(); } }
let sequence = 0;
function scope<T>(db: DatabaseSync, work: () => T, write = false): T {
  const name = `revision_metadata_${++sequence}`; db.exec(`SAVEPOINT ${name}`);
  try { if (write) db.exec('UPDATE revision_metadata SET version=version WHERE 0'); const result = work(); db.exec(`RELEASE ${name}`); return result; }
  catch (error) { db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
}
function parse(input: unknown): RevisionMetadataInput { try { return revisionMetadataInput(input); } catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'Invalid revision metadata.', 'REVISION_METADATA_INVALID_INPUT'); } }
export function revisionMetadataInputHash(input: RevisionMetadataInput): string { return hash(JSON.stringify(parse(input))); }
export function revisionMetadataConfigHash(config: RevisionMetadataConfig): string { if (!isRevisionMetadataConfig(config)) throw new Error('Invalid revision metadata configuration.'); return hash(JSON.stringify({ requireTestPlan: config.requireTestPlan })); }

/** Additive and repeatable. Old entity/source/history bytes are not normalized. */
export function initializeRevisionMetadata(db: DatabaseSync): void {
  scope(db, () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS revision_metadata(revision_id TEXT PRIMARY KEY REFERENCES entities(id),version INTEGER NOT NULL CHECK(version>=0 AND version<=9007199254740991),data TEXT NOT NULL CHECK(json_valid(data)),CHECK(json_extract(data,'$.revisionId')=revision_id AND json_extract(data,'$.version')=version));
      CREATE TABLE IF NOT EXISTS revision_metadata_baselines(revision_id TEXT PRIMARY KEY REFERENCES entities(id),data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE IF NOT EXISTS revision_metadata_operations(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES entities(id),input_sha256 TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),CHECK(json_extract(data,'$.id')=id AND json_extract(data,'$.revisionId')=revision_id AND json_extract(data,'$.inputSha256')=input_sha256));
      CREATE TABLE IF NOT EXISTS revision_metadata_transactions(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES entities(id),version INTEGER NOT NULL CHECK(version>0 AND version<=9007199254740991),operation_id TEXT UNIQUE NOT NULL REFERENCES revision_metadata_operations(id),data TEXT NOT NULL CHECK(json_valid(data)),UNIQUE(revision_id,version),CHECK(json_extract(data,'$.id')=id AND json_extract(data,'$.revisionId')=revision_id AND json_extract(data,'$.metadataVersion')=version AND json_extract(data,'$.operationId')=operation_id));
    `);
    for (const table of ['revision_metadata_baselines', 'revision_metadata_operations', 'revision_metadata_transactions']) db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Revision metadata evidence is immutable'); END; CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Revision metadata evidence is immutable'); END;`);
    for (const [table, columns] of Object.entries({ revision_metadata: ['revision_id', 'version', 'data'], revision_metadata_baselines: ['revision_id', 'data'], revision_metadata_operations: ['id', 'revision_id', 'input_sha256', 'data'], revision_metadata_transactions: ['id', 'revision_id', 'version', 'operation_id', 'data'] })) {
      const actual = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name); if (!isDeepStrictEqual(actual, columns)) throw new Error(`Unexpected ${table} schema; metadata migration was not applied.`);
    }
    const store = new RevisionMetadataStore(db);
    for (const row of db.prepare("SELECT e.id FROM entities e LEFT JOIN revision_metadata m ON m.revision_id=e.id WHERE e.kind='revision' AND m.revision_id IS NULL").all() as { id: string }[]) store.ensure(row.id);
  });
}

/** Current object/Space/repository/File authority belongs to the caller. This
 * engine records exact metadata, configuration and immutable source identities. */
export class RevisionMetadataStore {
  readonly config: Readonly<RevisionMetadataConfig>;
  readonly configId: string;
  constructor(private readonly database: DatabaseSync, configuration: Partial<RevisionMetadataConfig> = {}) {
    const config = { ...DEFAULT_REVISION_METADATA_CONFIG, ...configuration }; if (!isRevisionMetadataConfig(config)) throw new Error('Invalid revision metadata configuration.');
    this.config = Object.freeze(config); this.configId = revisionMetadataConfigHash(config);
  }
  creationFields(value: { title: unknown; summary?: unknown; testPlan?: unknown }): RevisionMetadataFields {
    try { return revisionMetadataFields(value, this.config.requireTestPlan); }
    catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'Invalid revision metadata.', 'REVISION_METADATA_INVALID_INPUT'); }
  }
  private entity(id: string): { title: unknown; summary: unknown; testPlan?: unknown; currentVersion: number } {
    if (!isRevisionId(id)) throw unavailable();
    const row = this.database.prepare("SELECT data,json_extract(data,'$.id') AS stored_id,json_type(data,'$.title') AS title_type,json_type(data,'$.summary') AS summary_type,json_type(data,'$.testPlan') AS plan_type,json_extract(data,'$.currentVersion') AS current_version,json_type(data,'$.currentVersion') AS version_type FROM entities WHERE id=? AND kind='revision'").get(id) as Record<string, unknown> | undefined;
    if (!row) throw unavailable();
    if (row.stored_id !== id || row.title_type !== 'text' || row.summary_type !== 'text' || row.plan_type !== null && !['text', 'null'].includes(String(row.plan_type)) || !natural(row.current_version) || row.current_version < 1 || !['integer', 'real'].includes(String(row.version_type))) throw invalid();
    // Decode the metadata JSON itself: extracting a legacy isolated surrogate
    // through SQLite TEXT would normalize its code units at the UTF-8 boundary.
    const raw = decode<Record<string, unknown>>(row.data as string);
    return { title: raw.title, summary: raw.summary, ...(row.plan_type === null ? {} : { testPlan: raw.testPlan }), currentVersion: row.current_version };
  }
  private head(id: string, number?: number): RevisionAuthorHead {
    const entity = this.entity(id);
    const row = this.database.prepare(`SELECT id,revision_id,number,json_extract(data,'$.id') AS stored_id,json_extract(data,'$.revisionId') AS stored_revision,json_extract(data,'$.number') AS stored_number,json_type(data,'$.number') AS number_type,json_extract(data,'$.contentHash') AS content_hash FROM versions WHERE revision_id=? ${number === undefined ? 'ORDER BY number DESC LIMIT 1' : 'AND number=?'}`).get(...(number === undefined ? [id] : [id, number])) as Record<string, unknown> | undefined;
    if (!row || row.revision_id !== id || row.id !== row.stored_id || row.stored_revision !== id || row.number !== row.stored_number || !['integer', 'real'].includes(String(row.number_type)) || number === undefined && row.number !== entity.currentVersion) throw invalid();
    const head = { versionId: row.id, number: row.number, contentHash: row.content_hash }; if (!isRevisionAuthorHead(head)) throw invalid(); return head;
  }
  ensure(id: string, initial?: RevisionMetadataFields): void {
    const entity = this.entity(id); if (this.database.prepare('SELECT 1 FROM revision_metadata WHERE revision_id=?').get(id)) return;
    const metadata: RevisionMetadataState = { revisionId: id, version: 0, title: (initial?.title ?? entity.title) as string, summary: (initial?.summary ?? entity.summary) as string, testPlan: initial ? initial.testPlan : entity.testPlan === undefined ? null : entity.testPlan as string | null, updatedAt: null };
    if (!isRevisionMetadataState(metadata, id)) throw invalid();
    const baseline: Baseline = { metadata, head: this.head(id) };
    this.database.prepare('INSERT INTO revision_metadata_baselines(revision_id,data) VALUES(?,?)').run(id, JSON.stringify(baseline));
    this.database.prepare('INSERT INTO revision_metadata(revision_id,version,data) VALUES(?,0,?)').run(id, JSON.stringify(metadata));
  }
  private stateAt(id: string, version: number): RevisionMetadataState {
    if (!natural(version)) throw invalid();
    if (version > 0) return this.transactionAt(id, version).after;
    const row = this.database.prepare('SELECT data FROM revision_metadata_baselines WHERE revision_id=?').get(id) as { data: string } | undefined;
    if (!row) throw invalid(); const baseline = decode<Baseline>(row.data);
    if (!baseline || Object.keys(baseline).sort().join(',') !== 'head,metadata' || !isRevisionMetadataState(baseline.metadata, id) || baseline.metadata.version !== 0 || !isRevisionAuthorHead(baseline.head) || !isDeepStrictEqual(this.head(id, baseline.head.number), baseline.head)) throw invalid(); return baseline.metadata;
  }
  private transactionAt(id: string, version: number): RevisionMetadataTransaction {
    const row = this.database.prepare('SELECT id,operation_id,data FROM revision_metadata_transactions WHERE revision_id=? AND version=?').get(id, version) as { id: string; operation_id: string; data: string } | undefined;
    if (!row) throw invalid(); const t = decode<RevisionMetadataTransaction>(row.data);
    if (!isRevisionMetadataTransaction(t, id) || !uuid(t.id) || t.id !== row.id || t.operationId !== row.operation_id || t.metadataVersion !== version || !isDeepStrictEqual(this.head(id, t.head.number), t.head)) throw invalid(); return t;
  }
  state(id: string): RevisionMetadataState {
    this.entity(id); const row = this.database.prepare('SELECT version,data FROM revision_metadata WHERE revision_id=?').get(id) as { version: number; data: string } | undefined;
    if (!row || !natural(row.version)) throw invalid(); const state = decode<RevisionMetadataState>(row.data), latest = this.database.prepare('SELECT max(version) AS version FROM revision_metadata_transactions WHERE revision_id=?').get(id) as { version: number | null };
    if (!isRevisionMetadataState(state, id) || state.version !== row.version || (latest.version ?? 0) !== state.version || !isDeepStrictEqual(state, this.stateAt(id, state.version))) throw invalid(); return state;
  }
  snapshot(id: string): Omit<RevisionMetadataSnapshot, 'access' | 'accessEpoch'> { return scope(this.database, () => ({ metadata: this.state(id), head: this.head(id), config: this.config, configId: this.configId })); }
  history(id: string, input: { before?: number; limit?: number; expectedMetadataVersion?: number } = {}): Omit<RevisionMetadataHistory, 'accessEpoch'> {
    return scope(this.database, () => {
      const query = object(input, ['before', 'limit', 'expectedMetadataVersion']), state = this.state(id), limit = query.limit ?? 25;
      if (!natural(limit) || limit < 1 || limit > REVISION_METADATA_LIMITS.page || query.before !== undefined && (!natural(query.before) || query.before < 1) || query.expectedMetadataVersion !== undefined && !natural(query.expectedMetadataVersion)) throw new HttpError(400, 'Choose valid metadata history versions and a page size between 1 and 100.');
      if (query.expectedMetadataVersion !== undefined && query.expectedMetadataVersion !== state.version) throw conflict();
      const rows = this.database.prepare('SELECT version FROM revision_metadata_transactions WHERE revision_id=? AND (? IS NULL OR version<?) ORDER BY version DESC LIMIT ?').all(id, query.before ?? null, query.before ?? null, limit + 1) as { version: number }[];
      const transactions = rows.slice(0, limit).map(row => this.transactionAt(id, row.version)); return { revisionId: id, metadataVersion: state.version, transactions, nextBefore: rows.length > limit ? transactions.at(-1)!.metadataVersion : null };
    });
  }
  mutate(id: string, input: RevisionMetadataInput, actor: ActorAttribution): RevisionMetadataReceipt {
    const request = parse(input); if (!isRevisionMetadataAttribution(actor)) throw new HttpError(400, 'Authenticated metadata attribution is required.');
    const fields = this.creationFields(request);
    return scope(this.database, () => {
      const snapshot = this.snapshot(id), epoch = (this.database.prepare("SELECT value FROM policy_meta WHERE name='epoch'").get() as { value: number }).value;
      if (!natural(epoch)) throw invalid(); if (epoch !== request.expectedAccessEpoch) throw new HttpError(409, 'Access changed. Reload before continuing.', 'ACCESS_EPOCH_CHANGED');
      if (snapshot.metadata.version !== request.expectedMetadataVersion || snapshot.head.number !== request.expectedVersion || snapshot.head.versionId !== request.expectedVersionId || snapshot.head.contentHash !== request.expectedContentHash || this.configId !== request.expectedConfigId) throw conflict();
      const before = snapshot.metadata, changed = before.title !== fields.title || before.summary !== fields.summary || before.testPlan !== fields.testPlan;
      if (changed && !Number.isSafeInteger(before.version + 1)) throw new HttpError(422, 'Revision metadata reached its version limit.', 'REVISION_METADATA_LIMIT');
      const now = new Date().toISOString(), operationId = randomUUID(), inputSha256 = revisionMetadataInputHash(request);
      const after: RevisionMetadataState = changed ? { ...before, ...fields, version: before.version + 1, updatedAt: now } : before;
      const transaction: RevisionMetadataTransaction | null = changed ? { id: randomUUID(), revisionId: id, operationId, metadataVersion: after.version, head: snapshot.head, before, after, message: request.message, attribution: { ...actor }, createdAt: now } : null;
      const receipt: RevisionMetadataReceipt = { revisionId: id, operationId, inputSha256, changed, metadata: after, transaction, accessEpoch: epoch };
      const operation: RevisionMetadataOperation = { id: operationId, revisionId: id, input: request, inputSha256, attribution: { ...actor }, head: snapshot.head, before, config: this.config, createdAt: now, receipt };
      this.database.prepare('INSERT INTO revision_metadata_operations(id,revision_id,input_sha256,data) VALUES(?,?,?,?)').run(operationId, id, inputSha256, JSON.stringify(operation));
      if (transaction) {
        this.database.prepare('INSERT INTO revision_metadata_transactions(id,revision_id,version,operation_id,data) VALUES(?,?,?,?,?)').run(transaction.id, id, after.version, operationId, JSON.stringify(transaction));
        this.database.prepare('UPDATE revision_metadata SET version=?,data=? WHERE revision_id=?').run(after.version, JSON.stringify(after), id);
      }
      return receipt;
    }, true);
  }
  operationRevisionId(id: string): string { if (!uuid(id)) throw invalid(); const row = this.database.prepare('SELECT revision_id FROM revision_metadata_operations WHERE id=?').get(id) as { revision_id: string } | undefined; if (!row || !isRevisionId(row.revision_id)) throw invalid(); return row.revision_id; }
  operation(id: string): RevisionMetadataOperation {
    return scope(this.database, () => {
      try {
        const revisionId = this.operationRevisionId(id), row = this.database.prepare('SELECT input_sha256,data FROM revision_metadata_operations WHERE id=?').get(id) as { input_sha256: string; data: string }, operation = decode<RevisionMetadataOperation>(row.data);
        if (!operation || Object.keys(operation).sort().join(',') !== 'attribution,before,config,createdAt,head,id,input,inputSha256,receipt,revisionId' || operation.id !== id || operation.revisionId !== revisionId || !isRevisionMetadataAttribution(operation.attribution) || !isDeepStrictEqual(parse(operation.input), operation.input) || operation.inputSha256 !== row.input_sha256 || operation.inputSha256 !== revisionMetadataInputHash(operation.input) || !isRevisionMetadataConfig(operation.config) || revisionMetadataConfigHash(operation.config) !== operation.input.expectedConfigId || typeof operation.createdAt !== 'string' || !Number.isFinite(Date.parse(operation.createdAt))) throw invalid();
        const request = operation.input, fields = revisionMetadataFields(request, operation.config.requireTestPlan), before = this.stateAt(revisionId, request.expectedMetadataVersion);
        if (!isDeepStrictEqual(before, operation.before) || !isRevisionAuthorHead(operation.head) || !isDeepStrictEqual(operation.head, this.head(revisionId, request.expectedVersion)) || operation.head.versionId !== request.expectedVersionId || operation.head.contentHash !== request.expectedContentHash || !validRevisionMetadataResult(operation.receipt, revisionId, request, operation.attribution.principalId) || operation.receipt.operationId !== id || operation.receipt.inputSha256 !== operation.inputSha256 || operation.receipt.accessEpoch !== request.expectedAccessEpoch) throw invalid();
        const changed = before.title !== fields.title || before.summary !== fields.summary || before.testPlan !== fields.testPlan;
        const after = changed ? { ...before, ...fields, version: before.version + 1, updatedAt: operation.createdAt } : before;
        if (operation.receipt.changed !== changed || !isDeepStrictEqual(operation.receipt.metadata, after)) throw invalid();
        if (changed) {
          const transaction = this.transactionAt(revisionId, after.version);
          if (!isDeepStrictEqual(transaction, operation.receipt.transaction) || !isDeepStrictEqual(transaction.before, before) || !isDeepStrictEqual(transaction.after, after) || !isDeepStrictEqual(transaction.attribution, operation.attribution) || transaction.createdAt !== operation.createdAt || !isDeepStrictEqual(transaction.head, operation.head)) throw invalid();
        } else if (this.database.prepare('SELECT 1 FROM revision_metadata_transactions WHERE operation_id=?').get(id)) throw invalid();
        return operation;
      } catch { throw invalid(); }
    });
  }
}
