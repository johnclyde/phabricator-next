import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import type { ActorAttribution, RevisionStatus } from '../shared/types.ts';
import { isRevisionId } from '../shared/revision-dependencies.ts';
import { isRevisionAuthor, isRevisionAuthorHead, isRevisionAuthorTransaction, isRevisionAuthorship, revisionAuthorInput, validRevisionAuthorResult, REVISION_AUTHOR_LIMITS } from '../shared/revision-authorship.ts';
import type { RevisionAuthor, RevisionAuthorHead, RevisionAuthorHistory, RevisionAuthorInput, RevisionAuthorReceipt, RevisionAuthorTransaction, RevisionAuthorship } from '../shared/revision-authorship.ts';
import { HttpError, object } from './validation.ts';

export interface RevisionAuthorOperation { id: string; revisionId: string; input: RevisionAuthorInput; inputSha256: string; attribution: ActorAttribution; receipt: RevisionAuthorReceipt }
export interface RevisionAuthorHistoryQuery { before?: number; limit?: number; expectedAuthorVersion?: number }
const unavailable = () => new HttpError(404, 'Revision authorship is unavailable.', 'REVISION_AUTHOR_UNAVAILABLE');
const invalid = () => new HttpError(409, 'Revision authorship cannot be verified.', 'REVISION_AUTHOR_INVALID_RECEIPT');
const changed = () => new HttpError(409, 'Revision ownership or source changed. Reload before continuing.', 'REVISION_AUTHOR_CHANGED');
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
let sequence = 0;
function scope<T>(db: DatabaseSync, work: () => T, write = false): T {
  const name = `revision_author_${++sequence}`; db.exec(`SAVEPOINT ${name}`);
  try {
    if (write) db.exec('UPDATE revision_authorship SET version=version WHERE 0');
    const result = work(); db.exec(`RELEASE ${name}`); return result;
  } catch (error) { db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
}
function parse(input: unknown): RevisionAuthorInput {
  try { return revisionAuthorInput(input); } catch { throw new HttpError(400, 'Provide an exact author action, source identity, author version and access epoch.', 'REVISION_AUTHOR_INVALID_INPUT'); }
}
export function revisionAuthorInputHash(input: RevisionAuthorInput): string { return createHash('sha256').update(JSON.stringify(parse(input))).digest('hex'); }
function attribution(value: unknown): value is ActorAttribution {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).length === 4 && isRevisionAuthor({ principalId: v.principalId, displayName: v.displayName })
    && (v.credentialId === null || text(v.credentialId, 240)) && text(v.requestId, 240);
}
function decode<T>(data: string): T { try { return JSON.parse(data) as T; } catch { throw invalid(); } }

/** Only a self-consistent immutable version-one attribution establishes the
 * initial owner. Legacy display strings or later contributors never do. */
function originalAuthor(db: DatabaseSync, id: string): RevisionAuthor | null {
  const row = db.prepare(`SELECT id,revision_id,number,json_extract(data,'$.id') AS stored_id,
    json_extract(data,'$.revisionId') AS stored_revision,json_extract(data,'$.number') AS stored_number,
    json_type(data,'$.number') AS number_type,json_type(data,'$.attribution') AS actor_type,substr(json_extract(data,'$.attribution'),1,4097) AS actor
    FROM versions WHERE revision_id=? AND number=1`).get(id) as Record<string, unknown> | undefined;
  if (!row || !text(row.id, 240) || row.revision_id !== id || row.number !== 1 || row.stored_id !== row.id || row.stored_revision !== id || row.stored_number !== 1 || !['integer', 'real'].includes(String(row.number_type)) || row.actor_type !== 'object' || typeof row.actor !== 'string') return null;
  let actor: unknown; try { actor = JSON.parse(row.actor); } catch { return null; }
  return attribution(actor) ? { principalId: actor.principalId, displayName: actor.displayName } : null;
}

/** Additive and repeatable; the root Store owns user_version and migration
 * transaction. Existing source, credentials, receipts and histories stay exact. */
export function initializeRevisionAuthorship(db: DatabaseSync): void {
  scope(db, () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS revision_authorship(revision_id TEXT PRIMARY KEY REFERENCES entities(id),version INTEGER NOT NULL CHECK(version>=0 AND version<=9007199254740991),author_id TEXT,data TEXT NOT NULL CHECK(json_valid(data)),CHECK(json_extract(data,'$.revisionId')=revision_id AND json_extract(data,'$.version')=version AND json_extract(data,'$.author.principalId') IS author_id));
      CREATE TABLE IF NOT EXISTS revision_author_operations(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES entities(id),input_sha256 TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),CHECK(json_extract(data,'$.id')=id AND json_extract(data,'$.revisionId')=revision_id AND json_extract(data,'$.inputSha256')=input_sha256));
      CREATE TABLE IF NOT EXISTS revision_author_transactions(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES entities(id),author_version INTEGER NOT NULL CHECK(author_version>0 AND author_version<=9007199254740991),operation_id TEXT NOT NULL UNIQUE REFERENCES revision_author_operations(id),data TEXT NOT NULL CHECK(json_valid(data)),UNIQUE(revision_id,author_version),CHECK(json_extract(data,'$.id')=id AND json_extract(data,'$.revisionId')=revision_id AND json_extract(data,'$.authorVersion')=author_version AND json_extract(data,'$.operationId')=operation_id));
      CREATE TRIGGER IF NOT EXISTS revision_author_operations_no_update BEFORE UPDATE ON revision_author_operations BEGIN SELECT RAISE(ABORT,'Revision author operations are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS revision_author_operations_no_delete BEFORE DELETE ON revision_author_operations BEGIN SELECT RAISE(ABORT,'Revision author operations are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS revision_author_transactions_no_update BEFORE UPDATE ON revision_author_transactions BEGIN SELECT RAISE(ABORT,'Revision author history is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS revision_author_transactions_no_delete BEFORE DELETE ON revision_author_transactions BEGIN SELECT RAISE(ABORT,'Revision author history is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS revision_authorship_revision BEFORE INSERT ON revision_authorship WHEN NOT EXISTS(SELECT 1 FROM entities WHERE id=NEW.revision_id AND kind='revision') BEGIN SELECT RAISE(ABORT,'Authorship requires a revision'); END;
    `);
    for (const [table, columns] of Object.entries({ revision_authorship: ['revision_id', 'version', 'author_id', 'data'], revision_author_operations: ['id', 'revision_id', 'input_sha256', 'data'], revision_author_transactions: ['id', 'revision_id', 'author_version', 'operation_id', 'data'] })) {
      const actual = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name);
      if (!isDeepStrictEqual(actual, columns)) throw new Error(`Unexpected ${table} schema; authorship migration was not applied.`);
    }
    const store = new RevisionAuthorshipStore(db);
    for (const row of db.prepare("SELECT e.id FROM entities e LEFT JOIN revision_authorship a ON a.revision_id=e.id WHERE e.kind='revision' AND a.revision_id IS NULL").all() as { id: string }[]) store.ensure(row.id);
  });
}

/** Storage boundary: the caller checks current revision authority and validates
 * an assignment target as an active workspace principal before calling mutate. */
export class RevisionAuthorshipStore {
  constructor(private readonly database: DatabaseSync) {}
  private requireRevision(id: string): void {
    if (!isRevisionId(id) || !this.database.prepare("SELECT 1 FROM entities WHERE id=? AND kind='revision'").get(id)) throw unavailable();
  }
  ensure(id: string): void {
    this.requireRevision(id);
    if (this.database.prepare('SELECT 1 FROM revision_authorship WHERE revision_id=?').get(id)) return;
    const author = originalAuthor(this.database, id);
    const value: RevisionAuthorship = { revisionId: id, version: 0, author, originalAuthor: author, updatedAt: null };
    this.database.prepare('INSERT INTO revision_authorship(revision_id,version,author_id,data) VALUES(?,0,?,?)').run(id, author?.principalId ?? null, JSON.stringify(value));
  }
  state(id: string): RevisionAuthorship { return scope(this.database, () => this.readState(id)); }
  private readState(id: string): RevisionAuthorship {
    this.requireRevision(id);
    const row = this.database.prepare('SELECT version,author_id,data FROM revision_authorship WHERE revision_id=?').get(id) as { version: number; author_id: string | null; data: string } | undefined;
    if (!row) throw invalid();
    const state = decode<RevisionAuthorship>(row.data), original = originalAuthor(this.database, id);
    if (!isRevisionAuthorship(state, id) || state.version !== row.version || (state.author?.principalId ?? null) !== row.author_id || !isDeepStrictEqual(state.originalAuthor, original)) throw invalid();
    const latest = this.database.prepare('SELECT author_version FROM revision_author_transactions WHERE revision_id=? ORDER BY author_version DESC LIMIT 1').get(id) as { author_version: number } | undefined;
    if (state.version === 0) {
      if (latest || state.updatedAt !== null || !isDeepStrictEqual(state.author, original)) throw invalid();
    } else {
      if (latest?.author_version !== state.version) throw invalid();
      const transaction = this.transactionAt(id, state.version);
      if (!isDeepStrictEqual(state.author, transaction.author) || state.updatedAt !== transaction.createdAt) throw invalid();
    }
    return state;
  }
  private versionHead(id: string, versionId?: string): RevisionAuthorHead {
    const row = this.database.prepare(`SELECT id,revision_id,number,json_extract(data,'$.id') AS stored_id,json_extract(data,'$.revisionId') AS stored_revision,
      json_extract(data,'$.number') AS stored_number,json_type(data,'$.number') AS number_type,json_extract(data,'$.contentHash') AS content_hash
      FROM versions WHERE revision_id=? ${versionId === undefined ? 'ORDER BY number DESC LIMIT 1' : 'AND id=?'}`).get(...(versionId === undefined ? [id] : [id, versionId])) as Record<string, unknown> | undefined;
    if (!row || row.revision_id !== id || row.stored_id !== row.id || row.stored_revision !== id || row.stored_number !== row.number || !['integer', 'real'].includes(String(row.number_type))) throw invalid();
    const head = { versionId: row.id, number: row.number, contentHash: row.content_hash };
    if (!isRevisionAuthorHead(head)) throw invalid(); return head;
  }
  snapshot(id: string): { authorship: RevisionAuthorship; head: RevisionAuthorHead; status: RevisionStatus } {
    return scope(this.database, () => {
      const authorship = this.readState(id), head = this.versionHead(id);
      const row = this.database.prepare("SELECT json_extract(data,'$.id') AS id,json_extract(data,'$.status') AS status,json_extract(data,'$.currentVersion') AS version,json_type(data,'$.currentVersion') AS version_type FROM entities WHERE id=? AND kind='revision'").get(id) as Record<string, unknown>;
      if (row.id !== id || typeof row.status !== 'string' || !['draft', 'needs_review', 'changes_requested', 'accepted', 'closed'].includes(row.status) || row.version !== head.number || !['integer', 'real'].includes(String(row.version_type))) throw invalid();
      return { authorship, head, status: row.status as RevisionStatus };
    });
  }
  private transactionAt(id: string, version: number): RevisionAuthorTransaction {
    const row = this.database.prepare('SELECT id,operation_id,data FROM revision_author_transactions WHERE revision_id=? AND author_version=?').get(id, version) as { id: string; operation_id: string; data: string } | undefined;
    if (!row) throw invalid(); const value = decode<RevisionAuthorTransaction>(row.data);
    if (!isRevisionAuthorTransaction(value, id) || value.id !== row.id || value.operationId !== row.operation_id || value.authorVersion !== version || !uuid(value.id) || !uuid(value.operationId)) throw invalid();
    return value;
  }
  history(id: string, input: RevisionAuthorHistoryQuery = {}): Omit<RevisionAuthorHistory, 'accessEpoch'> {
    return scope(this.database, () => {
      const query = object(input, ['before', 'limit', 'expectedAuthorVersion']), state = this.readState(id), count = query.limit ?? 25;
      if (!natural(count) || count < 1 || count > REVISION_AUTHOR_LIMITS.page || query.before !== undefined && (!natural(query.before) || query.before < 1) || query.expectedAuthorVersion !== undefined && !natural(query.expectedAuthorVersion)) throw new HttpError(400, 'Choose valid author history versions and a page size between 1 and 100.');
      if (query.expectedAuthorVersion !== undefined && query.expectedAuthorVersion !== state.version) throw changed();
      const rows = this.database.prepare('SELECT author_version FROM revision_author_transactions WHERE revision_id=? AND (? IS NULL OR author_version<?) ORDER BY author_version DESC LIMIT ?').all(id, query.before ?? null, query.before ?? null, count + 1) as { author_version: number }[];
      const transactions = rows.slice(0, count).map(row => this.transactionAt(id, row.author_version));
      return { revisionId: id, authorVersion: state.version, transactions, nextBefore: rows.length > count ? transactions.at(-1)!.authorVersion : null };
    });
  }
  mutate(id: string, input: RevisionAuthorInput, actor: ActorAttribution, targetRef?: RevisionAuthor): RevisionAuthorReceipt {
    const request = parse(input);
    if (!attribution(actor)) throw new HttpError(400, 'Authenticated revision authorship attribution is required.');
    const author = request.action === 'commandeer' ? { principalId: actor.principalId, displayName: actor.displayName } : targetRef;
    if (!isRevisionAuthor(author) || request.action === 'assign' && author.principalId !== request.authorId) throw new HttpError(400, 'Choose a valid workspace author.');
    return scope(this.database, () => {
      const { authorship, head, status } = this.snapshot(id);
      const epoch = this.database.prepare("SELECT value FROM policy_meta WHERE name='epoch'").get() as { value: number } | undefined;
      if (!epoch || !natural(epoch.value) || !Number.isSafeInteger(epoch.value + 1)) throw invalid();
      if (epoch.value !== request.expectedAccessEpoch) throw new HttpError(409, 'Access changed. Reload before transferring this revision.', 'ACCESS_EPOCH_CHANGED');
      if (authorship.version !== request.expectedAuthorVersion || head.number !== request.expectedVersion || head.versionId !== request.expectedVersionId || head.contentHash !== request.expectedContentHash) throw changed();
      if (request.action === 'commandeer' && status === 'closed') throw new HttpError(409, 'Closed revisions cannot be commandeered.', 'REVISION_AUTHOR_CLOSED');
      if (authorship.author?.principalId === author.principalId) throw new HttpError(409, 'This principal is already the revision author.', 'REVISION_AUTHOR_NO_EFFECT');
      if (!Number.isSafeInteger(authorship.version + 1)) throw new HttpError(422, 'The revision author history reached its version limit.', 'REVISION_AUTHOR_LIMIT');
      const now = new Date().toISOString(), operationId = randomUUID(), inputSha256 = revisionAuthorInputHash(request);
      const transaction: RevisionAuthorTransaction = { id: randomUUID(), revisionId: id, operationId, authorVersion: authorship.version + 1, action: request.action, previousAuthor: authorship.author, author: { ...author }, head, message: request.message, attribution: { ...actor }, createdAt: now };
      const receipt: RevisionAuthorReceipt = { revisionId: id, operationId, inputSha256, transaction, accessEpoch: epoch.value + 1 };
      const operation: RevisionAuthorOperation = { id: operationId, revisionId: id, input: request, inputSha256, attribution: { ...actor }, receipt };
      this.database.prepare('INSERT INTO revision_author_operations(id,revision_id,input_sha256,data) VALUES(?,?,?,?)').run(operationId, id, inputSha256, JSON.stringify(operation));
      this.database.prepare('INSERT INTO revision_author_transactions(id,revision_id,author_version,operation_id,data) VALUES(?,?,?,?,?)').run(transaction.id, id, transaction.authorVersion, operationId, JSON.stringify(transaction));
      const next: RevisionAuthorship = { revisionId: id, version: transaction.authorVersion, author: transaction.author, originalAuthor: authorship.originalAuthor, updatedAt: now };
      this.database.prepare('UPDATE revision_authorship SET version=?,author_id=?,data=? WHERE revision_id=?').run(next.version, author.principalId, JSON.stringify(next), id);
      this.database.prepare("UPDATE policy_meta SET value=value+1 WHERE name='epoch'").run();
      return receipt;
    }, true);
  }
  operationRevisionId(id: string): string {
    if (!uuid(id)) throw invalid();
    const row = this.database.prepare('SELECT revision_id FROM revision_author_operations WHERE id=?').get(id) as { revision_id: string } | undefined;
    if (!row || !isRevisionId(row.revision_id)) throw invalid(); return row.revision_id;
  }
  operation(id: string): RevisionAuthorOperation {
    return scope(this.database, () => {
      const revisionId = this.operationRevisionId(id);
      const row = this.database.prepare('SELECT input_sha256,data FROM revision_author_operations WHERE id=?').get(id) as { input_sha256: string; data: string };
      const value = decode<RevisionAuthorOperation>(row.data);
      try {
        if (!value || Object.keys(value).length !== 6 || value.id !== id || value.revisionId !== revisionId || !attribution(value.attribution) || !isDeepStrictEqual(parse(value.input), value.input) || value.inputSha256 !== row.input_sha256 || value.inputSha256 !== revisionAuthorInputHash(value.input)
          || !validRevisionAuthorResult(value.receipt, revisionId, value.input, value.attribution.principalId) || value.receipt.operationId !== id || value.receipt.inputSha256 !== value.inputSha256 || value.receipt.accessEpoch !== value.input.expectedAccessEpoch + 1) throw invalid();
        const transaction = this.transactionAt(revisionId, value.input.expectedAuthorVersion + 1);
        const previous = transaction.authorVersion === 1 ? originalAuthor(this.database, revisionId) : this.transactionAt(revisionId, transaction.authorVersion - 1).author;
        if (!isDeepStrictEqual(value.receipt.transaction, transaction) || !isDeepStrictEqual(transaction.attribution, value.attribution) || !isDeepStrictEqual(transaction.previousAuthor, previous)
          || !isDeepStrictEqual(transaction.head, this.versionHead(revisionId, transaction.head.versionId))) throw invalid();
        return value;
      } catch { throw invalid(); }
    });
  }
}
