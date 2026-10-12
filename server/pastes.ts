import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import type { ActorAttribution } from '../shared/types.ts';
import type { MentionProof } from '../shared/mentions.ts';
import type { CreatePasteInput, UpdatePasteInput, PasteCommentInput, PasteDetail, PasteFieldChange, PasteHistory, PasteListQuery, PastePage, PasteRecord, PasteTransaction, PasteVersion, PasteVersionsPage, PasteVersionSummary } from '../shared/pastes.ts';
import { PASTE_MAX_TITLE, PASTE_MAX_LANGUAGE, PASTE_MAX_COMMENT, PASTE_SNIPPET_LENGTH, PASTE_LIST_MAX_SCAN, PASTE_LIST_MAX_SOURCE_BYTES, validatePasteContent } from '../shared/pastes.ts';
import { registerDefaultPolicy } from './policy.ts';
import { choice, HttpError, integer, object, string } from './validation.ts';

type JsonRow = { data: string };
type Callbacks = { nextId: () => string; event: (id: string, action: string, detail: string, actor: ActorAttribution) => void; batch?: <T>(work: () => T) => T; mentions?: (id: string, body: string, actor: ActorAttribution) => MentionProof | undefined; notify?: (transaction: PasteTransaction) => void };
const hash = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex');
const unavailable = () => new HttpError(404, 'Paste was not found.', 'PASTE_UNAVAILABLE');
const corrupt = () => new HttpError(409, 'Stored paste integrity could not be verified.', 'PASTE_INTEGRITY');
let savepoint = 0;
function id(value: unknown): string { if (typeof value !== 'string' || !/^PA[1-9]\d{0,14}$/.test(value)) throw unavailable(); return value; }
function text(value: unknown, field: string, max: number, empty = false): string {
  const result = string(value, field, max, empty);
  if (/[\uD800-\uDFFF]/u.test(result)) throw new HttpError(400, `${field} must contain valid Unicode text.`);
  return result.trim();
}
function language(value: unknown): string | null { return value === null ? null : text(value, 'Language', PASTE_MAX_LANGUAGE); }
function content(value: unknown) { try { return validatePasteContent(value); } catch (error) { throw new HttpError(400, (error as Error).message); } }
function principal(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value)) throw new HttpError(400, 'Invalid paste author.');
  return value;
}
function next(value: number): number { if (!Number.isSafeInteger(value + 1)) throw new HttpError(409, 'This paste has reached the supported version limit.'); return value + 1; }
function bounds(before?: number, limit?: number) {
  const cursor = before === undefined ? Number.MAX_SAFE_INTEGER : integer(before, 'before');
  const count = limit === undefined ? 25 : integer(limit, 'limit');
  if (count > 100) throw new HttpError(400, 'Paste pages may contain at most 100 results.');
  return { cursor, count };
}
function date(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) throw new HttpError(400, `${field} must be a UTC ISO timestamp.`);
  const parsed = new Date(value); const canonical = value.includes('.') ? value : value.replace('Z', '.000Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== canonical) throw new HttpError(400, `${field} must be a valid UTC ISO timestamp.`);
  return canonical;
}
export function parseCreatePasteInput(input: unknown): CreatePasteInput & { title: string; language: string | null } {
  const data = object(input, ['title', 'language', 'content', 'access']);
  return { title: data.title === undefined ? '' : text(data.title, 'Title', PASTE_MAX_TITLE, true), language: data.language === undefined ? null : language(data.language), content: content(data.content).content, ...(data.access === undefined ? {} : { access: data.access as CreatePasteInput['access'] }) };
}
export function parseUpdatePasteInput(input: unknown): UpdatePasteInput {
  const data = object(input, ['expectedVersion', 'title', 'language', 'content', 'status']);
  return { expectedVersion: integer(data.expectedVersion, 'expectedVersion'), ...(data.title === undefined ? {} : { title: text(data.title, 'Title', PASTE_MAX_TITLE, true) }), ...(data.language === undefined ? {} : { language: language(data.language) }), ...(data.content === undefined ? {} : { content: content(data.content).content }), ...(data.status === undefined ? {} : { status: choice(data.status, 'paste status', ['active', 'archived'] as const) }) };
}
export function parsePasteCommentInput(input: unknown): PasteCommentInput {
  const data = object(input, ['contentVersion', 'body']);
  return { contentVersion: integer(data.contentVersion, 'contentVersion'), body: text(data.body, 'Comment', PASTE_MAX_COMMENT) };
}

/** Schema only; the caller owns the encompassing migration transaction. */
export function initializePastes(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE paste_versions(paste_id TEXT NOT NULL REFERENCES entities(id),number INTEGER NOT NULL CHECK(number>0),data TEXT NOT NULL CHECK(json_valid(data)),PRIMARY KEY(paste_id,number));
    CREATE TABLE paste_transactions(id TEXT PRIMARY KEY,paste_id TEXT NOT NULL REFERENCES entities(id),sequence INTEGER NOT NULL CHECK(sequence>0),paste_version INTEGER NOT NULL CHECK(paste_version>0),content_version INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),UNIQUE(paste_id,sequence),FOREIGN KEY(paste_id,content_version) REFERENCES paste_versions(paste_id,number));
    CREATE INDEX paste_transactions_snapshot ON paste_transactions(paste_id,paste_version);
    CREATE TRIGGER paste_versions_no_update BEFORE UPDATE ON paste_versions BEGIN SELECT RAISE(ABORT,'Paste content versions are immutable'); END;
    CREATE TRIGGER paste_versions_no_delete BEFORE DELETE ON paste_versions BEGIN SELECT RAISE(ABORT,'Paste content versions are immutable'); END;
    CREATE TRIGGER paste_transactions_no_update BEFORE UPDATE ON paste_transactions BEGIN SELECT RAISE(ABORT,'Paste history is immutable'); END;
    CREATE TRIGGER paste_transactions_no_delete BEFORE DELETE ON paste_transactions BEGIN SELECT RAISE(ABORT,'Paste history is immutable'); END;
    CREATE TRIGGER paste_identity_no_update BEFORE UPDATE ON entities WHEN OLD.kind='paste' AND (NEW.id IS NOT OLD.id OR NEW.kind IS NOT OLD.kind OR json_extract(NEW.data,'$.id') IS NOT json_extract(OLD.data,'$.id') OR json_extract(NEW.data,'$.authorId') IS NOT json_extract(OLD.data,'$.authorId') OR json_extract(NEW.data,'$.createdAt') IS NOT json_extract(OLD.data,'$.createdAt')) BEGIN SELECT RAISE(ABORT,'Paste identity is immutable'); END;
  `);
}

/** Storage only: callers enforce current policy for every read, mutation and replay. */
export class PasteStore {
  constructor(private readonly database: DatabaseSync, private readonly callbacks: Callbacks) {}
  private mutation<T>(work: () => T): T {
    const key = `paste_write_${++savepoint}`; this.database.exec(`SAVEPOINT ${key}`);
    try {
      this.database.prepare("UPDATE sequences SET value=value WHERE name='paste'").run();
      const result = this.callbacks.batch ? this.callbacks.batch(work) : work(); this.database.exec(`RELEASE ${key}`); return result;
    } catch (error) { this.database.exec(`ROLLBACK TO ${key}; RELEASE ${key}`); throw error; }
  }
  get(pasteId: string): PasteRecord {
    id(pasteId);
    const row = this.database.prepare("SELECT data FROM entities WHERE id=? AND kind='paste'").get(pasteId) as JsonRow | undefined;
    if (!row) throw unavailable();
    const record = JSON.parse(row.data) as PasteRecord;
    if (record.id !== pasteId || JSON.stringify(record) !== JSON.stringify(this.snapshot(pasteId, record.version))) throw corrupt();
    return record;
  }
  snapshot(pasteId: string, metadataVersion: number): PasteRecord {
    const transaction = this.transition(pasteId, metadataVersion);
    if (!transaction?.snapshot) throw new HttpError(404, 'Paste metadata version was not found.', 'PASTE_VERSION_UNAVAILABLE');
    return transaction.snapshot;
  }
  transition(pasteId: string, metadataVersion: number): PasteTransaction | null {
    id(pasteId); integer(metadataVersion, 'version');
    const row = this.database.prepare("SELECT data FROM paste_transactions WHERE paste_id=? AND paste_version=? AND json_extract(data,'$.kind') IN ('create','edit') ORDER BY sequence LIMIT 1").get(pasteId, metadataVersion) as JsonRow | undefined;
    return row ? JSON.parse(row.data) as PasteTransaction : null;
  }
  version(pasteId: string, number?: number): PasteVersion {
    const record = this.get(pasteId); const target = number === undefined ? record.contentVersion : integer(number, 'version');
    const row = this.database.prepare('SELECT data FROM paste_versions WHERE paste_id=? AND number=?').get(pasteId, target) as JsonRow | undefined;
    if (!row) throw new HttpError(404, 'Paste content version was not found.', 'PASTE_VERSION_UNAVAILABLE');
    const version = JSON.parse(row.data) as PasteVersion;
    try {
      const checked = validatePasteContent(version.content);
      if (version.pasteId !== pasteId || version.number !== target || version.sha256 !== hash(version.content) || version.bytes !== checked.bytes || version.lineCount !== checked.lineCount || (target === record.contentVersion && (record.contentHash !== version.sha256 || record.bytes !== version.bytes || record.lineCount !== version.lineCount))) throw corrupt();
    } catch { throw corrupt(); }
    return version;
  }
  detail(pasteId: string, number?: number): PasteDetail { return { paste: this.get(pasteId), version: this.version(pasteId, number), history: this.history(pasteId) }; }
  versions(pasteId: string, before?: number, limit?: number): PasteVersionsPage {
    this.get(pasteId); const { cursor, count } = bounds(before, limit);
    const rows = this.database.prepare("SELECT json_remove(data,'$.content') AS data FROM paste_versions WHERE paste_id=? AND number<? ORDER BY number DESC LIMIT ?").all(pasteId, cursor, count + 1) as JsonRow[];
    const versions = rows.slice(0, count).map(row => JSON.parse(row.data) as PasteVersionSummary);
    return { versions, nextBefore: rows.length > count ? versions.at(-1)!.number : null };
  }
  history(pasteId: string, before?: number, limit?: number): PasteHistory {
    this.get(pasteId); const { cursor, count } = bounds(before, limit);
    const rows = this.database.prepare('SELECT data FROM paste_transactions WHERE paste_id=? AND sequence<? ORDER BY sequence DESC LIMIT ?').all(pasteId, cursor, count + 1) as JsonRow[];
    const transactions = rows.slice(0, count).map(row => JSON.parse(row.data) as PasteTransaction);
    return { transactions, nextBefore: rows.length > count ? transactions.at(-1)!.sequence : null };
  }
  transaction(pasteId: string, transactionId: string): PasteTransaction {
    this.get(pasteId);
    const row = this.database.prepare('SELECT data FROM paste_transactions WHERE paste_id=? AND id=?').get(pasteId, transactionId) as JsonRow | undefined;
    if (!row) throw new HttpError(404, 'Paste transaction was not found.', 'PASTE_TRANSACTION_UNAVAILABLE');
    return JSON.parse(row.data) as PasteTransaction;
  }
  private append(record: PasteRecord, actor: ActorAttribution, fields: Pick<PasteTransaction, 'kind'> & Partial<PasteTransaction>): PasteTransaction {
    const sequence = (this.database.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM paste_transactions WHERE paste_id=?').get(record.id) as { n: number }).n;
    const transaction: PasteTransaction = { id: randomUUID(), pasteId: record.id, sequence: next(sequence), pasteVersion: record.version, contentVersion: record.contentVersion, contentHash: record.contentHash, createdAt: new Date().toISOString(), attribution: { ...actor }, ...fields };
    this.database.prepare('INSERT INTO paste_transactions(id,paste_id,sequence,paste_version,content_version,data) VALUES(?,?,?,?,?,?)').run(transaction.id, record.id, transaction.sequence, transaction.pasteVersion, transaction.contentVersion, JSON.stringify(transaction));
    return transaction;
  }
  private insertVersion(record: PasteRecord, source: string, actor: ActorAttribution): void {
    const version: PasteVersion = { pasteId: record.id, number: record.contentVersion, content: source, sha256: record.contentHash, bytes: record.bytes, lineCount: record.lineCount, createdAt: record.updatedAt, attribution: { ...actor } };
    this.database.prepare('INSERT INTO paste_versions(paste_id,number,data) VALUES(?,?,?)').run(record.id, version.number, JSON.stringify(version));
  }
  create(input: unknown, actor: ActorAttribution): PasteRecord {
    const data = parseCreatePasteInput(input); const checked = content(data.content); const authorId = principal(actor.principalId);
    return this.mutation(() => {
      const now = new Date().toISOString(); const pasteId = id(this.callbacks.nextId());
      const record: PasteRecord = { id: pasteId, title: data.title, language: data.language, status: 'active', authorId, version: 1, contentVersion: 1, contentHash: hash(data.content), bytes: checked.bytes, lineCount: checked.lineCount, createdAt: now, updatedAt: now };
      this.database.prepare("INSERT INTO entities(id,kind,data) VALUES(?,'paste',?)").run(pasteId, JSON.stringify(record));
      registerDefaultPolicy(this.database, pasteId); this.insertVersion(record, data.content, actor); const transaction = this.append(record, actor, { kind: 'create', snapshot: record });
      this.callbacks.event(pasteId, 'created', 'created this paste', actor); this.callbacks.notify?.(transaction); return record;
    });
  }
  update(pasteId: string, input: unknown, actor: ActorAttribution): PasteRecord {
    const data = parseUpdatePasteInput(input); principal(actor.principalId);
    return this.mutation(() => {
      const previous = this.get(pasteId);
      if (data.expectedVersion !== previous.version) throw new HttpError(409, 'This paste changed. Reload it before saving.', 'PASTE_CONFLICT');
      const changes: PasteFieldChange[] = [];
      for (const field of ['title', 'language', 'status'] as const) if (data[field] !== undefined && data[field] !== previous[field]) changes.push({ field, oldValue: previous[field], newValue: data[field]! });
      const oldVersion = data.content === undefined ? undefined : this.version(pasteId);
      const changedContent = data.content !== undefined && data.content !== oldVersion!.content;
      if (!changes.length && !changedContent) return previous;
      const checked = changedContent ? content(data.content) : null;
      const record: PasteRecord = { ...previous, title: data.title ?? previous.title, language: data.language === undefined ? previous.language : data.language, status: data.status ?? previous.status, version: next(previous.version), updatedAt: new Date().toISOString(), ...(checked ? { contentVersion: next(previous.contentVersion), contentHash: hash(checked.content), bytes: checked.bytes, lineCount: checked.lineCount } : {}) };
      this.database.prepare("UPDATE entities SET data=? WHERE id=? AND kind='paste'").run(JSON.stringify(record), pasteId);
      if (checked) this.insertVersion(record, checked.content, actor);
      const transaction = this.append(record, actor, { kind: 'edit', snapshot: record, ...(changes.length ? { changes } : {}), ...(checked ? { contentChange: { from: previous.contentVersion, to: record.contentVersion, fromHash: previous.contentHash, toHash: record.contentHash } } : {}) });
      this.callbacks.event(pasteId, 'edited', 'edited this paste', actor); this.callbacks.notify?.(transaction); return record;
    });
  }
  comment(pasteId: string, input: unknown, actor: ActorAttribution): PasteTransaction {
    const data = parsePasteCommentInput(input); principal(actor.principalId);
    return this.mutation(() => {
      const record = this.get(pasteId); const version = this.version(pasteId, data.contentVersion);
      const mentions = this.callbacks.mentions?.(pasteId, data.body, actor);
      const transaction = this.append(record, actor, { kind: 'comment', contentVersion: version.number, contentHash: version.sha256, comment: data.body, ...(mentions ? { mentions } : {}) });
      this.callbacks.event(pasteId, 'commented', 'commented on this paste', actor); this.callbacks.notify?.(transaction); return transaction;
    });
  }
  list(query: PasteListQuery = {}, canView: (pasteId: string) => boolean = () => false): PastePage {
    object(query, ['query', 'authorId', 'language', 'status', 'createdAfter', 'createdBefore', 'before', 'limit']);
    const { cursor: initialCursor, count } = bounds(query.before, query.limit); const filters: string[] = []; const args: SQLInputValue[] = [];
    const status = query.status === undefined ? 'active' : choice(query.status, 'paste status', ['active', 'archived', 'all'] as const);
    if (status !== 'all') { filters.push("json_extract(e.data,'$.status')=?"); args.push(status); }
    // Locale-independent Unicode lowercasing, then literal substring matching.
    const term = query.query === undefined ? '' : text(query.query, 'Query', 1000, true).toLowerCase();
    if (query.authorId !== undefined) { filters.push("json_extract(e.data,'$.authorId')=?"); args.push(principal(query.authorId)); }
    if (query.language !== undefined) { filters.push("json_extract(e.data,'$.language') IS ?"); args.push(language(query.language)); }
    const after = query.createdAfter === undefined ? undefined : date(query.createdAfter, 'createdAfter'); const beforeDate = query.createdBefore === undefined ? undefined : date(query.createdBefore, 'createdBefore');
    if (after && beforeDate && after >= beforeDate) throw new HttpError(400, 'createdAfter must precede createdBefore.');
    if (after) { filters.push("json_extract(e.data,'$.createdAt')>?"); args.push(after); }
    if (beforeDate) { filters.push("json_extract(e.data,'$.createdAt')<?"); args.push(beforeDate); }
    const sql = `SELECT e.rowid AS cursor,e.id FROM entities e WHERE e.kind='paste' AND e.rowid<? ${filters.length ? `AND ${filters.join(' AND ')}` : ''} ORDER BY e.rowid DESC LIMIT ?`;
    const rowsAt = (cursor: number, limit: number) => this.database.prepare(sql).all(cursor, ...args, limit) as { cursor: number; id: string }[];
    const pastes: PastePage['pastes'] = []; let cursor = initialCursor; let lastVisible = cursor; let scanned = 0; let sourceBytes = 0;
    for (;;) {
      const rows = rowsAt(cursor, 100);
      for (const row of rows) {
        const previousCursor = cursor; scanned++;
        if (canView(row.id)) {
          const record = this.get(row.id); const titleMatch = !term || record.title.toLowerCase().includes(term);
          if (titleMatch && pastes.length === count) return { pastes, nextBefore: lastVisible };
          // Stop before consuming this candidate, so its source is considered
          // on the continuation. No hidden source is fetched or inspected.
          if (sourceBytes + record.bytes > PASTE_LIST_MAX_SOURCE_BYTES) return { pastes, nextBefore: previousCursor };
          sourceBytes += record.bytes;
          const version = this.version(row.id);
          if (titleMatch || version.content.toLowerCase().includes(term)) {
            if (pastes.length === count) return { pastes, nextBefore: lastVisible };
            let snippet = version.content.slice(0, PASTE_SNIPPET_LENGTH); if (/[\uD800-\uDBFF]$/.test(snippet)) snippet = snippet.slice(0, -1);
            pastes.push({ ...record, snippet }); lastVisible = row.cursor;
          }
        }
        cursor = row.cursor;
        if (scanned === PASTE_LIST_MAX_SCAN) return { pastes, nextBefore: rowsAt(cursor, 1).length ? cursor : null };
      }
      if (rows.length < 100) return { pastes, nextBefore: null };
    }
  }
}
