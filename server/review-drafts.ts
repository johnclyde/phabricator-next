import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import type { ActorAttribution, ReviewComment } from '../shared/types.ts';
import type { RevisionAuthorHead } from '../shared/revision-authorship.ts';
import { isRevisionMetadataAttribution } from '../shared/revision-metadata.ts';
import { isRevisionId } from '../shared/revision-dependencies.ts';
import { REVIEW_DRAFT_LIMITS, isReviewDraftEntry, isReviewDraftId, isReviewDraftReceipt, reviewDraftDiscardInput, reviewDraftPayload, reviewDraftPublishInput, reviewDraftRequestCanonical, reviewDraftSaveInput, validReviewDraftResult, type ReviewDraftChangeReceipt, type ReviewDraftDiscovery, type ReviewDraftEntry, type ReviewDraftInput, type ReviewDraftManifest, type ReviewDraftOperation, type ReviewDraftOperationKind, type ReviewDraftPayload, type ReviewDraftPreview, type ReviewDraftPublicationReceipt, type ReviewDraftReceipt, type ReviewDraftSnapshot } from '../shared/review-drafts.ts';
import { isStoredMentionProof } from './mentions.ts';
import { HttpError } from './validation.ts';

export interface PreparedReviewDraft { sources: { versionId: string; contentHash: string }[]; comment: Pick<ReviewComment, 'body' | 'versionId' | 'filePath' | 'line'> & Partial<Pick<ReviewComment, 'anchor' | 'docxAnchor' | 'suggestion' | 'viewedVersionId' | 'threadId'>> }
interface Options {
  head(id: string): RevisionAuthorHead;
  title(id: string): string;
  validate(id: string, payload: ReviewDraftPayload): PreparedReviewDraft;
  threadVersion(id: string, threadId: string): number;
  publish(id: string, payload: ReviewDraftPayload, actor: ActorAttribution): ReviewComment;
  batch<T>(work: () => T, requestSha256: string): T;
}
const invalid = () => new HttpError(409, 'Private review draft evidence cannot be verified.', 'REVIEW_DRAFT_INVALID_RECEIPT');
const unavailable = () => new HttpError(404, 'Private review draft is unavailable.', 'REVIEW_DRAFT_UNAVAILABLE');
const conflict = () => new HttpError(409, 'Private drafts or their review context changed. Reload and preview again.', 'REVIEW_DRAFT_CHANGED');
const limit = () => new HttpError(422, 'Private review drafts exceed the supported complete review limit.', 'REVIEW_DRAFT_LIMIT');
const sha = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex');
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const natural = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const principal = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 240 && !v.includes('\0') && !/[\uD800-\uDFFF]/u.test(v);
function parse<T>(fn: () => T): T { try { return fn(); } catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'Invalid private review draft.', 'REVIEW_DRAFT_INVALID_INPUT'); } }
function decode<T>(raw: string): T { try { return JSON.parse(raw) as T; } catch { throw invalid(); } }
let sequence = 0;
function scope<T>(db: DatabaseSync, work: () => T, write = false): T {
  const name = `review_drafts_${++sequence}`; db.exec(`SAVEPOINT ${name}`);
  try { if (write) db.exec('UPDATE review_draft_sets SET version=version WHERE 0'); const result = work(); db.exec(`RELEASE ${name}`); return result; }
  catch (error) { db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
}
export function reviewDraftPayloadHash(input: ReviewDraftPayload): string { return sha(JSON.stringify(reviewDraftPayload(input))); }
export function reviewDraftInputHash(kind: ReviewDraftOperationKind, entryId: string | null, input: unknown): string { return sha(reviewDraftRequestCanonical(kind, entryId, input)); }
export function reviewDraftMentionRequestHash(retryKeySha256: string, inputSha256: string): string { if (!digest(retryKeySha256) || !digest(inputSha256)) throw invalid(); return sha(JSON.stringify(['review-draft-publication', retryKeySha256, inputSha256])); }

/** Private rows never enter shared comment queries. Tombstones prevent stale
 * retries resurrecting discarded/published entry identities. */
export function initializeReviewDrafts(db: DatabaseSync): void {
  scope(db, () => {
    const schema = `
      CREATE TABLE IF NOT EXISTS review_draft_sets(revision_id TEXT NOT NULL REFERENCES entities(id),principal_id TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0 AND version<=9007199254740991),updated_at TEXT NOT NULL,PRIMARY KEY(revision_id,principal_id));
      CREATE TABLE IF NOT EXISTS review_draft_entries(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL,principal_id TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0 AND version<=9007199254740991),state TEXT NOT NULL CHECK(state IN('active','discarded','published')),data TEXT NOT NULL CHECK(json_valid(data)),FOREIGN KEY(revision_id,principal_id) REFERENCES review_draft_sets(revision_id,principal_id),CHECK(json_extract(data,'$.id')=id AND json_extract(data,'$.revisionId')=revision_id AND json_extract(data,'$.principalId')=principal_id AND json_extract(data,'$.version')=version AND json_extract(data,'$.state')=state));
      CREATE INDEX IF NOT EXISTS review_draft_entries_owner ON review_draft_entries(principal_id,revision_id,state,id);
      CREATE TABLE IF NOT EXISTS review_draft_operations(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES entities(id),principal_id TEXT NOT NULL,retry_key_sha256 TEXT NOT NULL,input_sha256 TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),UNIQUE(principal_id,retry_key_sha256),CHECK(json_extract(data,'$.id')=id AND json_extract(data,'$.revisionId')=revision_id AND json_extract(data,'$.principalId')=principal_id AND json_extract(data,'$.retryKeySha256')=retry_key_sha256 AND json_extract(data,'$.inputSha256')=input_sha256));
      CREATE TRIGGER IF NOT EXISTS review_draft_operation_no_update BEFORE UPDATE ON review_draft_operations BEGIN SELECT RAISE(ABORT,'Private review operation evidence is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS review_draft_operation_no_delete BEFORE DELETE ON review_draft_operations BEGIN SELECT RAISE(ABORT,'Private review operation evidence is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS review_draft_entry_identity BEFORE UPDATE OF id,revision_id,principal_id ON review_draft_entries BEGIN SELECT RAISE(ABORT,'Private review entry identities are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS review_draft_entry_final BEFORE UPDATE ON review_draft_entries WHEN OLD.state<>'active' BEGIN SELECT RAISE(ABORT,'Discarded and published private review entries cannot change'); END;
      CREATE TRIGGER IF NOT EXISTS review_draft_entry_no_delete BEFORE DELETE ON review_draft_entries BEGIN SELECT RAISE(ABORT,'Private review tombstones are durable'); END;
    `;
    const existing = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name GLOB 'review_draft_*' ORDER BY type,name").all() as { name: string }[];
    if (existing.length) {
      const canonical = new DatabaseSync(':memory:');
      try {
        canonical.exec(schema);
        const expected = canonical.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name GLOB 'review_draft_*' ORDER BY type,name").all() as { name: string }[];
        for (const row of existing) if (!isDeepStrictEqual(row, expected.find(item => item.name === row.name))) throw new Error(`Unexpected ${row.name} schema; private review migration was not applied.`);
      } finally { canonical.close(); }
    }
    db.exec(schema);
    for (const [table, columns] of Object.entries({ review_draft_sets: ['revision_id', 'principal_id', 'version', 'updated_at'], review_draft_entries: ['id', 'revision_id', 'principal_id', 'version', 'state', 'data'], review_draft_operations: ['id', 'revision_id', 'principal_id', 'retry_key_sha256', 'input_sha256', 'data'] })) if (!isDeepStrictEqual((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name), columns)) throw new Error(`Unexpected ${table} schema; private review migration was not applied.`);
  });
}

/** The API supplies current credential/object authorization. All domain methods
 * additionally isolate owners, validate immutable sources and acquire a writer
 * before CAS. Every write is atomic even without an outer Store.mutate. */
export class ReviewDraftStore {
  constructor(private readonly database: DatabaseSync, private readonly options: Options) {}
  private epoch(): number { const row = this.database.prepare("SELECT value FROM policy_meta WHERE name='epoch'").get() as { value: number } | undefined; if (!row || !natural(row.value)) throw invalid(); return row.value; }
  private owner(id: string, owner: string): void { if (!isRevisionId(id) || !principal(owner)) throw unavailable(); this.options.head(id); }
  private set(id: string, owner: string): { version: number; updated_at: string | null } { const row = this.database.prepare('SELECT version,updated_at FROM review_draft_sets WHERE revision_id=? AND principal_id=?').get(id, owner) as { version: number; updated_at: string } | undefined; if (row && (!natural(row.version) || row.version < 1)) throw invalid(); return row ?? { version: 0, updated_at: null }; }
  private entry(id: string, owner: string, entryId: string): ReviewDraftEntry | null {
    const row = this.database.prepare('SELECT version,state,data FROM review_draft_entries WHERE revision_id=? AND principal_id=? AND id=?').get(id, owner, entryId) as { version: number; state: string; data: string } | undefined;
    if (!row) return null; const entry = decode<ReviewDraftEntry>(row.data);
    if (!isReviewDraftEntry(entry, id, owner) || entry.id !== entryId || entry.version !== row.version || entry.state !== row.state || reviewDraftPayloadHash(entry.payload) !== entry.payloadSha256) throw invalid(); return entry;
  }
  private active(id: string, owner: string): ReviewDraftEntry[] {
    const rows = this.database.prepare("SELECT id FROM review_draft_entries WHERE revision_id=? AND principal_id=? AND state='active' ORDER BY id LIMIT ?").all(id, owner, REVIEW_DRAFT_LIMITS.entries + 1) as { id: string }[];
    if (rows.length > REVIEW_DRAFT_LIMITS.entries) throw limit(); return rows.map(row => this.entry(id, owner, row.id)!);
  }
  snapshot(id: string, owner: string): ReviewDraftSnapshot { return scope(this.database, () => { this.owner(id, owner); return { revisionId: id, principalId: owner, setVersion: this.set(id, owner).version, entries: this.active(id, owner), head: this.options.head(id), accessEpoch: this.epoch() }; }); }
  discover(owner: string, canView: (id: string) => boolean, query: { after?: string; limit?: number } = {}): ReviewDraftDiscovery {
    if (!principal(owner) || query.after !== undefined && !isRevisionId(query.after) || query.limit !== undefined && (!natural(query.limit) || query.limit < 1 || query.limit > REVIEW_DRAFT_LIMITS.discovery)) throw new HttpError(400, 'Invalid private draft discovery query.');
    return scope(this.database, () => {
      const items: ReviewDraftDiscovery['items'] = [], page = query.limit ?? REVIEW_DRAFT_LIMITS.discovery;
      // Stream all candidates until one complete visible page is found. Hidden
      // revisions neither consume page slots nor contribute observable counts.
      const statement = this.database.prepare("SELECT s.revision_id,s.version,s.updated_at,COUNT(e.id) AS count FROM review_draft_sets s JOIN review_draft_entries e ON e.revision_id=s.revision_id AND e.principal_id=s.principal_id AND e.state='active' WHERE s.principal_id=? AND (? IS NULL OR s.revision_id>?) GROUP BY s.revision_id ORDER BY s.revision_id LIMIT 100");
      let after = query.after ?? null;
      while (items.length <= page) {
        const rows = statement.all(owner, after, after) as { revision_id: string; version: number; updated_at: string; count: number }[];
        for (const row of rows) { after = row.revision_id; if (!canView(row.revision_id)) continue; if (row.count > REVIEW_DRAFT_LIMITS.entries) throw limit(); items.push({ revisionId: row.revision_id, title: this.options.title(row.revision_id), setVersion: row.version, entryCount: row.count, updatedAt: row.updated_at }); if (items.length > page) break; }
        if (rows.length < 100) break;
      }
      const more = items.length > page; if (more) items.pop(); return { principalId: owner, items, nextAfter: more ? items.at(-1)!.revisionId : null, accessEpoch: this.epoch() };
    });
  }
  preview(id: string, owner: string): ReviewDraftPreview {
    return scope(this.database, () => {
      const snapshot = this.snapshot(id, owner); if (!snapshot.entries.length) throw new HttpError(409, 'Save at least one private draft before previewing.', 'REVIEW_DRAFT_EMPTY');
      const sources = new Map<string, string>(), threads = new Map<string, number>();
      for (const entry of snapshot.entries) { const p = entry.payload; for (const source of this.options.validate(id, p).sources) sources.set(source.versionId, source.contentHash); if (p.kind === 'reply') threads.set(p.threadId, this.options.threadVersion(id, p.threadId)); }
      const manifest: ReviewDraftManifest = { expectedSetVersion: snapshot.setVersion, expectedHead: snapshot.head, expectedAccessEpoch: snapshot.accessEpoch, entries: snapshot.entries.map(e => ({ id: e.id, version: e.version, payloadSha256: e.payloadSha256 })), sources: [...sources].sort(([a], [b]) => a.localeCompare(b)).map(([versionId, contentHash]) => ({ versionId, contentHash })), threads: [...threads].sort(([a], [b]) => a.localeCompare(b)).map(([threadId, version]) => ({ threadId, version })) };
      return { ...snapshot, manifest };
    });
  }
  private credentials(id: string, actor: ActorAttribution, retryKeySha256: string): void { if (!isRevisionMetadataAttribution(actor) || !digest(retryKeySha256)) throw new HttpError(400, 'An authenticated actor and stable retry key are required.', 'REVIEW_DRAFT_INVALID_INPUT'); this.owner(id, actor.principalId); }
  private replay(id: string, kind: ReviewDraftOperationKind, entryId: string | null, input: ReviewDraftInput, actor: ActorAttribution, retryKeySha256: string): ReviewDraftReceipt | null {
    const row = this.database.prepare('SELECT id FROM review_draft_operations WHERE principal_id=? AND retry_key_sha256=?').get(actor.principalId, retryKeySha256) as { id: string } | undefined;
    if (!row) return null; const operation = this.operation(row.id);
    if (operation.revisionId !== id || operation.kind !== kind || operation.entryId !== entryId || operation.inputSha256 !== reviewDraftInputHash(kind, entryId, input) || !isDeepStrictEqual(operation.input, input)) throw new HttpError(409, 'This retry key already names a different private review request.', 'REVIEW_DRAFT_RETRY_MISMATCH');
    return operation.receipt;
  }
  private advance(id: string, owner: string, now: string): number { const before = this.set(id, owner).version; if (!Number.isSafeInteger(before + 1)) throw limit(); const next = before + 1; this.database.prepare('INSERT INTO review_draft_sets(revision_id,principal_id,version,updated_at) VALUES(?,?,?,?) ON CONFLICT(revision_id,principal_id) DO UPDATE SET version=excluded.version,updated_at=excluded.updated_at').run(id, owner, next, now); return next; }
  private writeEntry(entry: ReviewDraftEntry, creating = false): void {
    if (creating) this.database.prepare('INSERT INTO review_draft_entries(id,revision_id,principal_id,version,state,data) VALUES(?,?,?,?,?,?)').run(entry.id, entry.revisionId, entry.principalId, entry.version, entry.state, JSON.stringify(entry));
    else this.database.prepare('UPDATE review_draft_entries SET version=?,state=?,data=? WHERE id=? AND revision_id=? AND principal_id=?').run(entry.version, entry.state, JSON.stringify(entry), entry.id, entry.revisionId, entry.principalId);
  }
  private record(kind: ReviewDraftOperationKind, entryId: string | null, input: ReviewDraftInput, actor: ActorAttribution, retryKeySha256: string, receipt: ReviewDraftReceipt): void {
    const operation: ReviewDraftOperation = { id: receipt.operationId, revisionId: receipt.revisionId, principalId: actor.principalId, kind, entryId, input, inputSha256: receipt.inputSha256, retryKeySha256, attribution: { ...actor }, receipt };
    this.database.prepare('INSERT INTO review_draft_operations(id,revision_id,principal_id,retry_key_sha256,input_sha256,data) VALUES(?,?,?,?,?,?)').run(operation.id, operation.revisionId, operation.principalId, retryKeySha256, operation.inputSha256, JSON.stringify(operation));
  }
  save(id: string, entryId: string, input: unknown, actor: ActorAttribution, retryKeySha256: string): ReviewDraftChangeReceipt {
    const request = parse(() => reviewDraftSaveInput(input)); if (!isReviewDraftId(entryId)) throw new HttpError(400, 'A UUID private draft identity is required.');
    return scope(this.database, () => {
      this.credentials(id, actor, retryKeySha256); const replay = this.replay(id, 'save', entryId, request, actor, retryKeySha256); if (replay) return replay as ReviewDraftChangeReceipt;
      const epoch = this.epoch(); if (request.expectedAccessEpoch !== epoch) throw new HttpError(409, 'Access changed. Reload before saving.', 'ACCESS_EPOCH_CHANGED');
      const before = this.entry(id, actor.principalId, entryId);
      if (!before && this.database.prepare('SELECT 1 FROM review_draft_entries WHERE id=?').get(entryId)) throw unavailable();
      if ((before?.version ?? 0) !== request.expectedEntryVersion || before && before.state !== 'active') throw conflict();
      if (!Number.isSafeInteger(request.expectedEntryVersion + 1)) throw limit(); this.options.validate(id, request.payload);
      const entries = this.active(id, actor.principalId).filter(e => e.id !== entryId), now = new Date().toISOString();
      const entry: ReviewDraftEntry = { id: entryId, revisionId: id, principalId: actor.principalId, version: request.expectedEntryVersion + 1, state: 'active', payload: request.payload, payloadSha256: reviewDraftPayloadHash(request.payload), createdAt: before?.createdAt ?? now, updatedAt: now };
      entries.push(entry); if (entries.length > REVIEW_DRAFT_LIMITS.entries || entries.filter(e => e.payload.kind === 'summary').length > 1 || entries.reduce((n, e) => n + JSON.stringify(e.payload).length, 0) > REVIEW_DRAFT_LIMITS.totalCharacters) throw limit();
      const setVersion = this.advance(id, actor.principalId, now); this.writeEntry(entry, !before);
      const receipt: ReviewDraftChangeReceipt = { kind: 'save', revisionId: id, principalId: actor.principalId, operationId: randomUUID(), inputSha256: reviewDraftInputHash('save', entryId, request), entry, setVersion, accessEpoch: epoch };
      this.record('save', entryId, request, actor, retryKeySha256, receipt); return receipt;
    }, true);
  }
  discard(id: string, entryId: string, input: unknown, actor: ActorAttribution, retryKeySha256: string): ReviewDraftChangeReceipt {
    const request = parse(() => reviewDraftDiscardInput(input)); if (!isReviewDraftId(entryId)) throw unavailable();
    return scope(this.database, () => {
      this.credentials(id, actor, retryKeySha256); const replay = this.replay(id, 'discard', entryId, request, actor, retryKeySha256); if (replay) return replay as ReviewDraftChangeReceipt;
      const epoch = this.epoch(); if (epoch !== request.expectedAccessEpoch) throw new HttpError(409, 'Access changed. Reload before discarding.', 'ACCESS_EPOCH_CHANGED');
      const before = this.entry(id, actor.principalId, entryId); if (!before) throw unavailable(); if (before.version !== request.expectedEntryVersion || before.state !== 'active') throw conflict(); if (!Number.isSafeInteger(before.version + 1)) throw limit();
      const now = new Date().toISOString(), entry: ReviewDraftEntry = { ...before, version: before.version + 1, state: 'discarded', updatedAt: now }, setVersion = this.advance(id, actor.principalId, now); this.writeEntry(entry);
      const receipt: ReviewDraftChangeReceipt = { kind: 'discard', revisionId: id, principalId: actor.principalId, operationId: randomUUID(), inputSha256: reviewDraftInputHash('discard', entryId, request), entry, setVersion, accessEpoch: epoch }; this.record('discard', entryId, request, actor, retryKeySha256, receipt); return receipt;
    }, true);
  }
  publish(id: string, input: unknown, actor: ActorAttribution, retryKeySha256: string): ReviewDraftPublicationReceipt {
    const request = parse(() => reviewDraftPublishInput(input)), inputSha256 = reviewDraftInputHash('publish', null, request);
    return scope(this.database, () => {
      this.credentials(id, actor, retryKeySha256); const replay = this.replay(id, 'publish', null, request, actor, retryKeySha256); if (replay) return replay as ReviewDraftPublicationReceipt;
      const preview = this.preview(id, actor.principalId); if (!isDeepStrictEqual(preview.manifest, request.manifest)) throw conflict();
      if (!Number.isSafeInteger(preview.setVersion + 1) || preview.entries.some(e => !Number.isSafeInteger(e.version + 1))) throw limit();
      return this.options.batch(() => {
        const now = new Date().toISOString();
        const published = preview.entries.map(entry => ({ draftId: entry.id, draftVersion: entry.version, payloadSha256: entry.payloadSha256, comment: this.options.publish(id, entry.payload, actor) }));
        const setVersion = this.advance(id, actor.principalId, now);
        for (const entry of preview.entries) this.writeEntry({ ...entry, state: 'published', version: entry.version + 1, updatedAt: now });
        const receipt: ReviewDraftPublicationReceipt = { kind: 'publish', revisionId: id, principalId: actor.principalId, operationId: randomUUID(), inputSha256, published, setVersion, createdAt: now, accessEpoch: preview.accessEpoch }; this.record('publish', null, request, actor, retryKeySha256, receipt); return receipt;
      }, reviewDraftMentionRequestHash(retryKeySha256, inputSha256));
    }, true);
  }
  operation(id: string): ReviewDraftOperation {
    return scope(this.database, () => {
      if (!isReviewDraftId(id)) throw unavailable(); const row = this.database.prepare('SELECT revision_id,principal_id,retry_key_sha256,input_sha256,data FROM review_draft_operations WHERE id=?').get(id) as { revision_id: string; principal_id: string; retry_key_sha256: string; input_sha256: string; data: string } | undefined; if (!row) throw unavailable();
      const op = decode<ReviewDraftOperation>(row.data);
      try {
        if (op.id !== id || op.revisionId !== row.revision_id || op.principalId !== row.principal_id || !isRevisionMetadataAttribution(op.attribution) || op.attribution.principalId !== op.principalId || op.retryKeySha256 !== row.retry_key_sha256 || !digest(op.retryKeySha256) || op.inputSha256 !== row.input_sha256 || reviewDraftInputHash(op.kind, op.entryId, op.input) !== op.inputSha256 || !isReviewDraftReceipt(op.receipt, op.revisionId, op.principalId) || op.receipt.operationId !== id || op.receipt.inputSha256 !== op.inputSha256 || !validReviewDraftResult(op.receipt, op.revisionId, op.kind, op.input, op.entryId, op.principalId)) throw invalid();
        if (op.receipt.kind !== 'publish') { if (reviewDraftPayloadHash(op.receipt.entry.payload) !== op.receipt.entry.payloadSha256) throw invalid(); }
        else for (const item of op.receipt.published) {
          const draft = this.entry(op.revisionId, op.principalId, item.draftId), comment = this.database.prepare('SELECT data FROM comments WHERE revision_id=? AND id=?').get(op.revisionId, item.comment.id) as { data: string } | undefined;
          if (!draft || draft.state !== 'published' || draft.version !== item.draftVersion + 1 || draft.payloadSha256 !== item.payloadSha256 || !comment || !isDeepStrictEqual(decode(comment.data), item.comment) || item.comment.body !== draft.payload.body || !isDeepStrictEqual(item.comment.attribution, op.attribution)) throw invalid();
          const prepared = this.options.validate(op.revisionId, draft.payload).comment;
          for (const field of ['body', 'versionId', 'filePath', 'line', 'anchor', 'docxAnchor', 'suggestion', 'viewedVersionId'] as const) if (!isDeepStrictEqual(prepared[field], item.comment[field])) throw invalid();
          if (draft.payload.kind === 'reply' ? item.comment.threadId !== prepared.threadId : item.comment.threadId !== item.comment.id) throw invalid();
          if (item.comment.mentions && (!isStoredMentionProof(item.comment.mentions, item.comment.body) || item.comment.mentions.requestSha256 !== reviewDraftMentionRequestHash(op.retryKeySha256, op.inputSha256))) throw invalid();
        }
      } catch { throw invalid(); }
      return op;
    });
  }
  operationIdentity(id: string): { revisionId: string; principalId: string } | null {
    if (!isReviewDraftId(id)) return null;
    const row = this.database.prepare('SELECT revision_id,principal_id FROM review_draft_operations WHERE id=?').get(id) as { revision_id: string; principal_id: string } | undefined;
    return row ? { revisionId: row.revision_id, principalId: row.principal_id } : null;
  }
}
