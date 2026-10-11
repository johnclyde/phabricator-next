import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import type { ActorAttribution, RevisionStatus } from '../shared/types.ts';
import type { RevisionAuthorHead } from '../shared/revision-authorship.ts';
import { isRevisionAuthor, isRevisionAuthorHead, isRevisionAuthorTransaction } from '../shared/revision-authorship.ts';
import { isRevisionId } from '../shared/revision-dependencies.ts';
import { RevisionAuthorshipStore } from './revision-authorship.ts';
import { HttpError, object } from './validation.ts';
import { DEFAULT_REVISION_LIFECYCLE_CONFIG, revisionLifecycleInput, revisionLifecycleActions, isRevisionLifecycleState, isRevisionLifecycleTransaction, isRevisionLifecycleConfig, isRevisionLifecycleEvidence, validRevisionLifecycleResult } from '../shared/revision-lifecycle.ts';
import type { RevisionLifecycleState, RevisionLifecycleConfig, RevisionLifecycleInput, RevisionLifecycleTransaction, RevisionLifecycleReceipt, RevisionLifecycleSnapshot, RevisionLifecycleHistory } from '../shared/revision-lifecycle.ts';

export interface RevisionLifecycleOperation {
  id: string; revisionId: string; input: RevisionLifecycleInput; inputSha256: string;
  attribution: ActorAttribution; before: RevisionLifecycleState; after: RevisionLifecycleState;
  authorship: RevisionLifecycleSnapshot['authorship']; config: RevisionLifecycleConfig;
  evidence: RevisionLifecycleSnapshot['evidence']; reviewProofs: { id: string; sha256: string }[];
  receipt: RevisionLifecycleReceipt;
}
type Snapshot = Omit<RevisionLifecycleSnapshot, 'access' | 'accessEpoch'>;

const invalid = () => new HttpError(409, 'Revision lifecycle cannot be verified.', 'REVISION_LIFECYCLE_INVALID_RECEIPT');
const changed = () => new HttpError(409, 'Revision lifecycle, ownership or source changed. Reload before continuing.', 'REVISION_LIFECYCLE_CHANGED');
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const text = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= maximum && !value.includes('\0');
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const sha = (value: string): string => createHash('sha256').update(value).digest('hex');
let savepoint = 0;
function scope<T>(db: DatabaseSync, work: () => T, write = false): T {
  const name = `revision_lifecycle_${++savepoint}`; db.exec(`SAVEPOINT ${name}`);
  try {
    if (write) db.exec('UPDATE revision_lifecycle SET version=version WHERE 0');
    const result = work(); db.exec(`RELEASE ${name}`); return result;
  } catch (error) { db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
}
function decode<T>(data: string): T { try { return JSON.parse(data) as T; } catch { throw invalid(); } }
function attribution(value: unknown): value is ActorAttribution {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actor = value as Record<string, unknown>;
  return Object.keys(actor).length === 4 && isRevisionAuthor({ principalId: actor.principalId, displayName: actor.displayName })
    && (actor.credentialId === null || text(actor.credentialId, 240)) && text(actor.requestId, 240);
}

/** Additive and repeatable. The containing Store owns the schema version and
 * outer migration transaction. No historical source or event is rewritten. */
export function initializeRevisionLifecycle(db: DatabaseSync): void {
  scope(db, () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS revision_lifecycle(revision_id TEXT PRIMARY KEY REFERENCES entities(id),version INTEGER NOT NULL CHECK(version>=0 AND version<=9007199254740991),data TEXT NOT NULL CHECK(json_valid(data)),CHECK(json_extract(data,'$.revisionId')=revision_id AND json_extract(data,'$.version')=version));
      CREATE TABLE IF NOT EXISTS revision_lifecycle_operations(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES entities(id),input_sha256 TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),CHECK(json_extract(data,'$.id')=id AND json_extract(data,'$.revisionId')=revision_id AND json_extract(data,'$.inputSha256')=input_sha256));
      CREATE TABLE IF NOT EXISTS revision_lifecycle_transactions(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES entities(id),version INTEGER NOT NULL CHECK(version>0 AND version<=9007199254740991),operation_id TEXT UNIQUE REFERENCES revision_lifecycle_operations(id),data TEXT NOT NULL CHECK(json_valid(data)),before_state TEXT NOT NULL CHECK(json_valid(before_state)),after_state TEXT NOT NULL CHECK(json_valid(after_state)),UNIQUE(revision_id,version),CHECK(json_extract(data,'$.id')=id AND json_extract(data,'$.revisionId')=revision_id));
      CREATE TRIGGER IF NOT EXISTS revision_lifecycle_operations_no_update BEFORE UPDATE ON revision_lifecycle_operations BEGIN SELECT RAISE(ABORT,'Revision lifecycle operations are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS revision_lifecycle_operations_no_delete BEFORE DELETE ON revision_lifecycle_operations BEGIN SELECT RAISE(ABORT,'Revision lifecycle operations are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS revision_lifecycle_transactions_no_update BEFORE UPDATE ON revision_lifecycle_transactions BEGIN SELECT RAISE(ABORT,'Revision lifecycle history is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS revision_lifecycle_transactions_no_delete BEFORE DELETE ON revision_lifecycle_transactions BEGIN SELECT RAISE(ABORT,'Revision lifecycle history is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS revision_lifecycle_revision BEFORE INSERT ON revision_lifecycle WHEN NOT EXISTS(SELECT 1 FROM entities WHERE id=NEW.revision_id AND kind='revision') BEGIN SELECT RAISE(ABORT,'Lifecycle requires a revision'); END;
    `);
    for (const [table, columns] of Object.entries({ revision_lifecycle: ['revision_id', 'version', 'data'], revision_lifecycle_operations: ['id', 'revision_id', 'input_sha256', 'data'], revision_lifecycle_transactions: ['id', 'revision_id', 'version', 'operation_id', 'data', 'before_state', 'after_state'] })) {
      const actual = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name);
      if (!isDeepStrictEqual(actual, columns)) throw new Error(`Unexpected ${table} schema; lifecycle migration was not applied.`);
    }
    // Baselines are observations, not invented historical transitions.
    const store = new RevisionLifecycleStore(db);
    for (const row of db.prepare("SELECT e.id FROM entities e LEFT JOIN revision_lifecycle l ON l.revision_id=e.id WHERE e.kind='revision' AND l.revision_id IS NULL").all() as { id: string }[]) store.ensure(row.id, true);
  });
}

function parse(input: unknown): RevisionLifecycleInput {
  try { return revisionLifecycleInput(input); } catch { throw new HttpError(400, 'Choose an exact lifecycle action, source, ownership, evidence and configuration.', 'REVISION_LIFECYCLE_INVALID_INPUT'); }
}
export function revisionLifecycleInputHash(input: RevisionLifecycleInput): string { return sha(JSON.stringify(parse(input))); }
export function revisionLifecycleConfigHash(config: RevisionLifecycleConfig): string {
  return sha(JSON.stringify({ allowReopen: config.allowReopen, alwaysAllowClose: config.alwaysAllowClose, alwaysAllowAbandon: config.alwaysAllowAbandon, closeOnAccept: config.closeOnAccept }));
}

/** Caller authorizes current View/Edit; this storage boundary also checks the
 * current author role, source and lifecycle pins under the same writer lock. */
export class RevisionLifecycleStore {
  readonly config: RevisionLifecycleConfig;
  readonly configId: string;
  constructor(private readonly database: DatabaseSync, configuration: Partial<RevisionLifecycleConfig> = {}) {
    const config = { ...DEFAULT_REVISION_LIFECYCLE_CONFIG, ...configuration };
    if (Object.keys(config).length !== 4 || Object.values(config).some(value => typeof value !== 'boolean')) throw new Error('Invalid revision lifecycle configuration.');
    this.config = Object.freeze(config); this.configId = revisionLifecycleConfigHash(config);
  }
  private metadata(id: string): { status: RevisionStatus; currentVersion: number } {
    if (!isRevisionId(id)) throw new HttpError(404, 'Revision lifecycle is unavailable.', 'REVISION_LIFECYCLE_UNAVAILABLE');
    const row = this.database.prepare("SELECT json_extract(data,'$.id') AS id,json_extract(data,'$.status') AS status,json_type(data,'$.status') AS status_type,json_extract(data,'$.currentVersion') AS version,json_type(data,'$.currentVersion') AS version_type FROM entities WHERE id=? AND kind='revision'").get(id) as Record<string, unknown> | undefined;
    if (!row) throw new HttpError(404, 'Revision lifecycle is unavailable.', 'REVISION_LIFECYCLE_UNAVAILABLE');
    if (row.id !== id || row.status_type !== 'text' || !['draft', 'needs_review', 'changes_requested', 'changes_planned', 'accepted', 'closed', 'abandoned'].includes(String(row.status)) || !natural(row.version) || row.version < 1 || !['integer', 'real'].includes(String(row.version_type))) throw invalid();
    return { status: row.status as RevisionStatus, currentVersion: row.version };
  }
  ensure(id: string, reviewStarted = true): void {
    const metadata = this.metadata(id);
    if (this.database.prepare('SELECT 1 FROM revision_lifecycle WHERE revision_id=?').get(id)) return;
    const lifecycle: RevisionLifecycleState = { revisionId: id, version: 0, status: metadata.status, reviewStarted, closedFromAccepted: null, resumeAcceptanceHead: null, updatedAt: null };
    this.database.prepare('INSERT INTO revision_lifecycle(revision_id,version,data) VALUES(?,0,?)').run(id, JSON.stringify(lifecycle));
  }
  state(id: string): RevisionLifecycleState { return scope(this.database, () => this.readState(id)); }
  private readState(id: string): RevisionLifecycleState {
    const metadata = this.metadata(id), row = this.database.prepare('SELECT version,data FROM revision_lifecycle WHERE revision_id=?').get(id) as { version: number; data: string } | undefined;
    if (!row) throw invalid(); const state = decode<RevisionLifecycleState>(row.data);
    if (!isRevisionLifecycleState(state, id) || state.version !== row.version || state.status !== metadata.status) throw invalid();
    const latest = this.database.prepare('SELECT version FROM revision_lifecycle_transactions WHERE revision_id=? ORDER BY version DESC LIMIT 1').get(id) as { version: number } | undefined;
    if (state.version === 0) { if (latest || state.updatedAt !== null || state.closedFromAccepted !== null || state.resumeAcceptanceHead !== null) throw invalid(); }
    else if (latest?.version !== state.version || !isDeepStrictEqual(this.transactionAt(id, state.version).after, state)) throw invalid();
    return state;
  }
  private head(id: string, number?: number): RevisionAuthorHead {
    const row = this.database.prepare(`SELECT id,revision_id,number,json_extract(data,'$.id') AS stored_id,json_extract(data,'$.revisionId') AS stored_revision,json_extract(data,'$.number') AS stored_number,json_type(data,'$.number') AS number_type,json_extract(data,'$.contentHash') AS content_hash FROM versions WHERE revision_id=? ${number === undefined ? 'ORDER BY number DESC LIMIT 1' : 'AND number=?'}`).get(...(number === undefined ? [id] : [id, number])) as Record<string, unknown> | undefined;
    if (!row || row.revision_id !== id || row.id !== row.stored_id || row.stored_revision !== id || row.number !== row.stored_number || !['integer', 'real'].includes(String(row.number_type))) throw invalid();
    const head = { versionId: row.id, number: row.number, contentHash: row.content_hash }; if (!isRevisionAuthorHead(head)) throw invalid(); return head;
  }
  private evidence(id: string, head: RevisionAuthorHead, ids?: string[]): { evidence: Snapshot['evidence']; proofs: { id: string; sha256: string }[] } {
    // Review bodies are evidence, never manuscript source. Bound their count and
    // aggregate bytes before loading JSON into the process.
    if (ids !== undefined && (ids.length > 1000 || ids.some((id, index) => !text(id, 240) || index > 0 && ids[index - 1]! >= id))) throw invalid();
    const rows = ids === undefined ? this.database.prepare('SELECT id,version_id,length(CAST(data AS BLOB)) AS bytes FROM reviews WHERE revision_id=? AND version_id=? ORDER BY id LIMIT 1001').all(id, head.versionId) as { id: string; version_id: string; bytes: number }[]
      : ids.map(reviewId => this.database.prepare('SELECT id,version_id,length(CAST(data AS BLOB)) AS bytes FROM reviews WHERE revision_id=? AND id=?').get(id, reviewId) as { id: string; version_id: string; bytes: number } | undefined);
    if (rows.length > 1000 || rows.some(row => !row) || rows.reduce((total, row) => total + Number(row!.bytes), 0) > 16 * 1024 * 1024) throw new HttpError(422, 'Revision review evidence exceeds the supported read limit.', 'REVISION_LIFECYCLE_LIMIT');
    const values: unknown[] = [], proofs: { id: string; sha256: string }[] = []; let errorCount = 0;
    for (const row of rows) {
      if (!row || !text(row.id, 240) || row.version_id !== head.versionId || !natural(row.bytes)) throw invalid();
      const raw = (this.database.prepare('SELECT data FROM reviews WHERE revision_id=? AND id=?').get(id, row.id) as { data: string }).data;
      const review = decode<Record<string, unknown>>(raw);
      if (!review || review.id !== row.id || review.revisionId !== id || review.versionId !== head.versionId || review.contentHash !== head.contentHash || !Array.isArray(review.findings)) throw invalid();
      for (const finding of review.findings) {
        if (!finding || typeof finding !== 'object' || !['error', 'warning', 'info'].includes(String(finding.severity))) throw invalid();
        if (finding.severity === 'error') errorCount++;
      }
      values.push(review); proofs.push({ id: row.id, sha256: sha(raw) });
    }
    return { evidence: { sha256: sha(JSON.stringify(values)), reviewIds: proofs.map(row => row.id), errorCount }, proofs };
  }
  snapshot(id: string, principalId = ''): Snapshot {
    return scope(this.database, () => {
      const lifecycle = this.readState(id), head = this.head(id), authored = new RevisionAuthorshipStore(this.database).snapshot(id);
      if (!isDeepStrictEqual(authored.head, head) || head.number !== this.metadata(id).currentVersion) throw invalid();
      const core = { lifecycle, head, authorship: { version: authored.authorship.version, author: authored.authorship.author }, evidence: this.evidence(id, head).evidence, config: this.config, configId: this.configId };
      return { ...core, actions: revisionLifecycleActions(core, principalId) };
    });
  }
  private transactionAt(id: string, version: number): { transaction: RevisionLifecycleTransaction; before: RevisionLifecycleState; after: RevisionLifecycleState } {
    const row = this.database.prepare('SELECT id,operation_id,data,before_state,after_state FROM revision_lifecycle_transactions WHERE revision_id=? AND version=?').get(id, version) as { id: string; operation_id: string | null; data: string; before_state: string; after_state: string } | undefined;
    if (!row) throw invalid(); const transaction = decode<RevisionLifecycleTransaction>(row.data), before = decode<RevisionLifecycleState>(row.before_state), after = decode<RevisionLifecycleState>(row.after_state);
    if (!isRevisionLifecycleTransaction(transaction, id) || !uuid(transaction.id) || transaction.id !== row.id || transaction.operationId !== row.operation_id || transaction.lifecycleVersion !== version
      || !isRevisionLifecycleState(before, id) || !isRevisionLifecycleState(after, id) || after.version !== version || before.version + 1 !== version || transaction.fromStatus !== before.status || transaction.toStatus !== after.status || after.updatedAt !== transaction.createdAt) throw invalid();
    if (!isDeepStrictEqual(this.head(id, transaction.beforeHead.number), transaction.beforeHead) || !isDeepStrictEqual(this.head(id, transaction.head.number), transaction.head)) throw invalid();
    return { transaction, before, after };
  }
  history(id: string, input: { before?: number; limit?: number; expectedLifecycleVersion?: number } = {}): Omit<RevisionLifecycleHistory, 'accessEpoch'> {
    return scope(this.database, () => {
      const query = object(input, ['before', 'limit', 'expectedLifecycleVersion']), state = this.readState(id), limit = query.limit ?? 25;
      if (!natural(limit) || limit < 1 || limit > 100 || query.before !== undefined && (!natural(query.before) || query.before < 1) || query.expectedLifecycleVersion !== undefined && !natural(query.expectedLifecycleVersion)) throw new HttpError(400, 'Choose valid lifecycle history versions and a page size between 1 and 100.');
      if (query.expectedLifecycleVersion !== undefined && query.expectedLifecycleVersion !== state.version) throw changed();
      const rows = this.database.prepare('SELECT version FROM revision_lifecycle_transactions WHERE revision_id=? AND (? IS NULL OR version<?) ORDER BY version DESC LIMIT ?').all(id, query.before ?? null, query.before ?? null, limit + 1) as { version: number }[];
      const transactions = rows.slice(0, limit).map(row => this.transactionAt(id, row.version).transaction);
      return { revisionId: id, lifecycleVersion: state.version, transactions, nextBefore: rows.length > limit ? transactions.at(-1)!.lifecycleVersion : null };
    });
  }
  private append(before: RevisionLifecycleState, after: RevisionLifecycleState, transaction: RevisionLifecycleTransaction): void {
    if (!Number.isSafeInteger(after.version) || after.version !== before.version + 1) throw new HttpError(422, 'Revision lifecycle history reached its version limit.', 'REVISION_LIFECYCLE_LIMIT');
    this.database.prepare('INSERT INTO revision_lifecycle_transactions(id,revision_id,version,operation_id,data,before_state,after_state) VALUES(?,?,?,?,?,?,?)').run(transaction.id, before.revisionId, after.version, transaction.operationId, JSON.stringify(transaction), JSON.stringify(before), JSON.stringify(after));
    this.database.prepare('UPDATE revision_lifecycle SET version=?,data=? WHERE revision_id=?').run(after.version, JSON.stringify(after), before.revisionId);
    this.database.prepare("UPDATE entities SET data=json_set(data,'$.status',?,'$.updatedAt',?) WHERE id=? AND kind='revision'").run(after.status, after.updatedAt, before.revisionId);
  }
  private transition(snapshot: Omit<Snapshot, 'actions'>, input: RevisionLifecycleInput, principalId: string): RevisionLifecycleState {
    const action = revisionLifecycleActions(snapshot, principalId).find(item => item.action === input.action);
    if (!action?.available || !action.targetStatus) throw new HttpError(409, action?.reason ?? 'This lifecycle action is unavailable.', 'REVISION_LIFECYCLE_ACTION_UNAVAILABLE');
    const before = snapshot.lifecycle;
    return { ...before, version: before.version + 1, status: action.targetStatus,
      reviewStarted: before.reviewStarted || input.action === 'request_review' || input.action === 'close' || input.action === 'accept_reviewed',
      closedFromAccepted: input.action === 'close' ? before.status === 'accepted' : before.closedFromAccepted,
      resumeAcceptanceHead: input.action === 'plan_changes' && before.status === 'accepted' ? snapshot.head : null,
      updatedAt: new Date().toISOString() };
  }
  mutate(id: string, input: RevisionLifecycleInput, actor: ActorAttribution): RevisionLifecycleReceipt {
    const request = parse(input); if (!attribution(actor)) throw new HttpError(400, 'Authenticated lifecycle attribution is required.');
    return scope(this.database, () => {
      const snapshot = this.snapshot(id, actor.principalId), { lifecycle, head, authorship } = snapshot;
      const epoch = (this.database.prepare("SELECT value FROM policy_meta WHERE name='epoch'").get() as { value: number }).value;
      if (!natural(epoch)) throw invalid();
      if (epoch !== request.expectedAccessEpoch) throw new HttpError(409, 'Access changed. Reload before continuing.', 'ACCESS_EPOCH_CHANGED');
      if (lifecycle.version !== request.expectedLifecycleVersion || authorship.version !== request.expectedAuthorVersion || head.number !== request.expectedVersion || head.versionId !== request.expectedVersionId || head.contentHash !== request.expectedContentHash || snapshot.configId !== request.expectedConfigId || snapshot.evidence.sha256 !== request.expectedEvidenceSha256) throw changed();
      const after = this.transition(snapshot, request, actor.principalId), operationId = randomUUID(), inputSha256 = revisionLifecycleInputHash(request);
      const transaction: RevisionLifecycleTransaction = { id: randomUUID(), revisionId: id, operationId, lifecycleVersion: after.version, action: request.action, fromStatus: lifecycle.status, toStatus: after.status, beforeHead: head, head, message: request.message, attribution: { ...actor }, createdAt: after.updatedAt!, evidenceSha256: snapshot.evidence.sha256, reviewIds: [...snapshot.evidence.reviewIds] };
      const receipt: RevisionLifecycleReceipt = { revisionId: id, operationId, inputSha256, transaction, accessEpoch: epoch };
      const operation: RevisionLifecycleOperation = { id: operationId, revisionId: id, input: request, inputSha256, attribution: { ...actor }, before: lifecycle, after, authorship, config: this.config, evidence: snapshot.evidence, reviewProofs: this.evidence(id, head).proofs, receipt };
      this.database.prepare('INSERT INTO revision_lifecycle_operations(id,revision_id,input_sha256,data) VALUES(?,?,?,?)').run(operationId, id, inputSha256, JSON.stringify(operation));
      this.append(lifecycle, after, transaction); return receipt;
    }, true);
  }
  sourceUpdated(id: string, actor?: ActorAttribution): void {
    scope(this.database, () => {
      if (actor !== undefined && !attribution(actor)) throw new HttpError(400, 'Invalid source attribution.');
      const before = this.readState(id), head = this.head(id), beforeHead = this.head(id, head.number - 1);
      if (head.number !== this.metadata(id).currentVersion || head.number < 2) throw invalid();
      const status = before.status === 'closed' ? 'closed' : before.status === 'draft' ? 'draft' : before.reviewStarted ? 'needs_review' : 'draft';
      const after: RevisionLifecycleState = { ...before, version: before.version + 1, status, resumeAcceptanceHead: null, updatedAt: new Date().toISOString() }, evidence = this.evidence(id, head).evidence;
      const transaction: RevisionLifecycleTransaction = { id: randomUUID(), revisionId: id, operationId: null, lifecycleVersion: after.version, action: 'source_updated', fromStatus: before.status, toStatus: status, beforeHead, head, message: 'New immutable source version; previous acceptance no longer applies.', attribution: actor ? { ...actor } : null, createdAt: after.updatedAt!, evidenceSha256: evidence.sha256, reviewIds: evidence.reviewIds };
      this.append(before, after, transaction);
    }, true);
  }
  reviewSaved(id: string, actor?: ActorAttribution): void {
    scope(this.database, () => {
      if (actor !== undefined && !attribution(actor)) throw new HttpError(400, 'Invalid review attribution.');
      const before = this.readState(id), head = this.head(id), evidence = this.evidence(id, head).evidence;
      if (!evidence.errorCount || before.status !== 'accepted' && before.resumeAcceptanceHead === null) return;
      const status = before.status === 'accepted' ? 'changes_requested' : before.status;
      const after: RevisionLifecycleState = { ...before, version: before.version + 1, status, resumeAcceptanceHead: null, updatedAt: new Date().toISOString() };
      const transaction: RevisionLifecycleTransaction = { id: randomUUID(), revisionId: id, operationId: null, lifecycleVersion: after.version, action: 'review_invalidated', fromStatus: before.status, toStatus: status, beforeHead: head, head, message: 'Current-version review errors invalidated acceptance.', attribution: actor ? { ...actor } : null, createdAt: after.updatedAt!, evidenceSha256: evidence.sha256, reviewIds: evidence.reviewIds };
      this.append(before, after, transaction);
    }, true);
  }
  operationRevisionId(id: string): string {
    if (!uuid(id)) throw invalid(); const row = this.database.prepare('SELECT revision_id FROM revision_lifecycle_operations WHERE id=?').get(id) as { revision_id: string } | undefined;
    if (!row || !isRevisionId(row.revision_id)) throw invalid(); return row.revision_id;
  }
  operation(id: string): RevisionLifecycleOperation {
    return scope(this.database, () => {
      try {
        const revisionId = this.operationRevisionId(id), row = this.database.prepare('SELECT input_sha256,data FROM revision_lifecycle_operations WHERE id=?').get(id) as { input_sha256: string; data: string }, operation = decode<RevisionLifecycleOperation>(row.data);
        if (!operation || Object.keys(operation).sort().join(',') !== ['id', 'revisionId', 'input', 'inputSha256', 'attribution', 'before', 'after', 'authorship', 'config', 'evidence', 'reviewProofs', 'receipt'].sort().join(',') || operation.id !== id || operation.revisionId !== revisionId || !attribution(operation.attribution) || !isDeepStrictEqual(parse(operation.input), operation.input) || operation.inputSha256 !== row.input_sha256 || operation.inputSha256 !== revisionLifecycleInputHash(operation.input)) throw invalid();
        if (!isRevisionLifecycleConfig(operation.config) || !isRevisionLifecycleEvidence(operation.evidence) || !validRevisionLifecycleResult(operation.receipt, revisionId, operation.input, operation.attribution.principalId)
          || !operation.authorship || Object.keys(operation.authorship).sort().join(',') !== 'author,version' || !natural(operation.authorship.version) || !(operation.authorship.author === null || isRevisionAuthor(operation.authorship.author))) throw invalid();
        const ownership = new RevisionAuthorshipStore(this.database).state(revisionId);
        let historicalAuthor = ownership.originalAuthor;
        if (operation.authorship.version > 0) {
          const authorRow = this.database.prepare('SELECT data FROM revision_author_transactions WHERE revision_id=? AND author_version=?').get(revisionId, operation.authorship.version) as { data: string } | undefined;
          if (!authorRow) throw invalid(); const authorTransaction = decode<unknown>(authorRow.data);
          if (!isRevisionAuthorTransaction(authorTransaction, revisionId) || authorTransaction.authorVersion !== operation.authorship.version) throw invalid();
          historicalAuthor = authorTransaction.author;
        }
        if (operation.authorship.version > ownership.version || !isDeepStrictEqual(historicalAuthor, operation.authorship.author)) throw invalid();
        const saved = this.transactionAt(revisionId, operation.input.expectedLifecycleVersion + 1), { transaction, before, after } = saved, head = this.head(revisionId, operation.input.expectedVersion);
        if (!isDeepStrictEqual(operation.before, before) || !isDeepStrictEqual(operation.after, after) || !isDeepStrictEqual(operation.receipt.transaction, transaction) || !isDeepStrictEqual(transaction.attribution, operation.attribution) || !isDeepStrictEqual(head, transaction.head) || !isDeepStrictEqual(head, transaction.beforeHead)
          || transaction.operationId !== id || transaction.action !== operation.input.action || transaction.message !== operation.input.message || head.versionId !== operation.input.expectedVersionId || head.contentHash !== operation.input.expectedContentHash
          || operation.authorship.version !== operation.input.expectedAuthorVersion || revisionLifecycleConfigHash(operation.config) !== operation.input.expectedConfigId || operation.receipt.revisionId !== revisionId || operation.receipt.operationId !== id || operation.receipt.inputSha256 !== operation.inputSha256 || operation.receipt.accessEpoch !== operation.input.expectedAccessEpoch) throw invalid();
        if (before.version > 0 && !isDeepStrictEqual(this.transactionAt(revisionId, before.version).after, before)) throw invalid();
        const evidence = this.evidence(revisionId, head, operation.evidence.reviewIds);
        if (!isDeepStrictEqual(evidence.evidence, operation.evidence) || !isDeepStrictEqual(evidence.proofs, operation.reviewProofs) || operation.evidence.sha256 !== operation.input.expectedEvidenceSha256 || transaction.evidenceSha256 !== operation.evidence.sha256 || !isDeepStrictEqual(transaction.reviewIds, operation.evidence.reviewIds)) throw invalid();
        const proposed = this.transition({ lifecycle: before, head, authorship: operation.authorship, evidence: operation.evidence, config: operation.config, configId: operation.input.expectedConfigId }, operation.input, operation.attribution.principalId);
        if (!isDeepStrictEqual({ ...proposed, updatedAt: after.updatedAt }, after)) throw invalid();
        return operation;
      } catch { throw invalid(); }
    });
  }
}
