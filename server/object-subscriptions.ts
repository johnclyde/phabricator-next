import type { NotificationPublisher } from './notifications.ts';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import type { PasteTransaction } from '../shared/pastes.ts';
import type { ActorAttribution } from '../shared/types.ts';
import { isRevisionAuthor, isRevisionAuthorId, type RevisionAuthor } from '../shared/revision-authorship.ts';
import { isRevisionMetadataAttribution } from '../shared/revision-metadata.ts';
import { OBJECT_SUBSCRIPTION_LIMITS, isObjectMuteState, isObjectMuteTransaction, isObjectSubscriptionStatus, isSubscriptionObjectId, isObjectSubscriptionTransaction, objectSubscriptionInput, validObjectSubscriptionResult, type ObjectMuteHistory, type ObjectMuteState, type ObjectMuteTransaction, type ObjectSubscriptionExplicitState, type ObjectSubscriptionHistory, type ObjectSubscriptionInput, type ObjectSubscriptionPerson, type ObjectSubscriptionReceipt, type ObjectSubscriptionSnapshot, type ObjectSubscriptionStatus, type ObjectSubscriptionTransaction } from '../shared/object-subscriptions.ts';
import { HttpError, object } from './validation.ts';
import { isStoredMentionProof } from './mentions.ts';

type Explicit = { objectId: string; principalId: string; displayName: string | null; version: number; state: ObjectSubscriptionExplicitState | null; updatedAt: string | null };
export interface ObjectSubscriptionOperation { retryKeySha256: string | null; id: string; objectId: string; input: ObjectSubscriptionInput; inputSha256: string; attribution: ActorAttribution; author: RevisionAuthor | null; before: Explicit | ObjectMuteState; subscriptionVersion: number | null; createdAt: string; receipt: ObjectSubscriptionReceipt }
export interface ObjectSubscriptionQuery { after?: string; limit?: number; expectedSubscriptionVersion?: number; }
const invalid = () => new HttpError(409, 'Object subscription history cannot be verified.', 'OBJECT_SUBSCRIPTION_INVALID_RECEIPT');
const conflict = () => new HttpError(409, 'Following or preferences changed. Reload before continuing.', 'OBJECT_SUBSCRIPTION_CHANGED');
const limited = () => new HttpError(422, 'Object subscriptions reached their supported limit.', 'OBJECT_SUBSCRIPTION_LIMIT');
const natural = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const decode = <T>(value: string): T => { try { return JSON.parse(value) as T; } catch { throw invalid(); } };
let counter = 0;
function scope<T>(db: DatabaseSync, work: () => T, write = false): T {
  const name = `object_subscriptions_${++counter}`; db.exec(`SAVEPOINT ${name}`);
  try { if (write) db.exec('UPDATE object_subscriptions SET version=version WHERE 0'); const value = work(); db.exec(`RELEASE ${name}`); return value; }
  catch (error) { db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
}
function parse(input: unknown): ObjectSubscriptionInput { try { return objectSubscriptionInput(input); } catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'Invalid following preference.', 'OBJECT_SUBSCRIPTION_INVALID_INPUT'); } }
export function objectSubscriptionInputHash(input: ObjectSubscriptionInput): string { return digest(parse(input)); }

const schema = `
  CREATE TABLE IF NOT EXISTS object_subscriptions(object_id TEXT NOT NULL REFERENCES entities(id),principal_id TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0 AND version<=9007199254740991),state TEXT NOT NULL CHECK(state IN('subscribed','unsubscribed')),data TEXT NOT NULL CHECK(json_valid(data)),PRIMARY KEY(object_id,principal_id));
  CREATE TABLE IF NOT EXISTS object_subscription_operations(id TEXT PRIMARY KEY,object_id TEXT NOT NULL REFERENCES entities(id),principal_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN('subscription','mute')),input_sha256 TEXT NOT NULL,preference_version INTEGER NOT NULL CHECK(preference_version>=0),subscription_version INTEGER CHECK(subscription_version>=0),data TEXT NOT NULL CHECK(json_valid(data)));
  CREATE TABLE IF NOT EXISTS object_subscription_transactions(id TEXT PRIMARY KEY,object_id TEXT NOT NULL REFERENCES entities(id),sequence INTEGER NOT NULL CHECK(sequence>0 AND sequence<=9007199254740991),principal_id TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0 AND version<=9007199254740991),operation_id TEXT UNIQUE REFERENCES object_subscription_operations(id),comment_id TEXT UNIQUE REFERENCES paste_transactions(id),data TEXT NOT NULL CHECK(json_valid(data)),UNIQUE(object_id,sequence),UNIQUE(object_id,principal_id,version));
  CREATE TABLE IF NOT EXISTS object_mutes(object_id TEXT NOT NULL REFERENCES entities(id),principal_id TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0 AND version<=9007199254740991),data TEXT NOT NULL CHECK(json_valid(data)),PRIMARY KEY(object_id,principal_id));
  CREATE TABLE IF NOT EXISTS object_mute_transactions(id TEXT PRIMARY KEY,object_id TEXT NOT NULL REFERENCES entities(id),principal_id TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0 AND version<=9007199254740991),operation_id TEXT NOT NULL UNIQUE REFERENCES object_subscription_operations(id),data TEXT NOT NULL CHECK(json_valid(data)),UNIQUE(object_id,principal_id,version));
  ${['object_subscription_operations', 'object_subscription_transactions', 'object_mute_transactions'].map(table => `CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Object subscription evidence is immutable'); END; CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Object subscription evidence is immutable'); END;`).join('\n')}
  ${['object_subscriptions', 'object_mutes'].map(table => `CREATE TRIGGER IF NOT EXISTS ${table}_identity BEFORE UPDATE OF object_id,principal_id ON ${table} BEGIN SELECT RAISE(ABORT,'Object preference identity is immutable'); END; CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Object preferences are durable'); END;`).join('\n')}
`;
/** Additive only. Legacy edits/comments never manufacture preference history. */
export function initializeObjectSubscriptions(db: DatabaseSync): void {
  const canonical = new DatabaseSync(':memory:');
  try {
    canonical.exec(schema);
    const query = "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name GLOB 'object_subscription*' OR name GLOB 'object_mute*' OR tbl_name GLOB 'object_subscription*' OR tbl_name GLOB 'object_mute*'";
    const expected = canonical.prepare(query).all();
    for (const existing of db.prepare(query).all()) if (!expected.some(value => isDeepStrictEqual(value, existing))) throw new Error('Conflicting object subscription schema; migration was not applied.');
    scope(db, () => db.exec(schema));
  } finally { canonical.close(); }
}

/** The caller owns current VIEW/action authority and validates new people. Mute
 * reads and receipts must only be presented to their authenticated principal. */
export class ObjectSubscriptionStore {
  private notificationPublisher?: NotificationPublisher;
  connectNotifications(publisher: NotificationPublisher): void { if (this.notificationPublisher) throw new Error('Notifications already connected.'); this.notificationPublisher = publisher; }
  constructor(private readonly database: DatabaseSync) {}
  private author(id: string): RevisionAuthor | null {
    if (!isSubscriptionObjectId(id)) throw new HttpError(404, 'Object subscriptions are unavailable.', 'OBJECT_SUBSCRIPTION_UNAVAILABLE');
    const row = this.database.prepare("SELECT kind,json_extract(data,'$.id') AS id,json_type(data,'$.authorId') AS author_type,json_extract(data,'$.authorId') AS author_id FROM entities WHERE id=?").get(id) as { kind: string; id: string; author_type: string | null; author_id: unknown } | undefined;
    if (!row || row.id !== id || row.kind !== (id.startsWith('PA') ? 'paste' : 'document')) throw new HttpError(404, 'Object subscriptions are unavailable.', 'OBJECT_SUBSCRIPTION_UNAVAILABLE');
    if (row.kind === 'document') return null;
    const original = this.database.prepare("SELECT json_type(data,'$.attribution') AS actor_type,json_extract(data,'$.attribution') AS actor,json_extract(data,'$.snapshot.authorId') AS author_id,json_extract(data,'$.snapshot.id') AS object_id FROM paste_transactions WHERE paste_id=? AND paste_version=1 AND json_extract(data,'$.kind')='create'").get(id) as { actor_type: string; actor: string; author_id: string; object_id: string } | undefined;
    if (row.author_type !== 'text' || !isRevisionAuthorId(row.author_id) || !original || original.actor_type !== 'object' || typeof original.actor !== 'string') throw invalid();
    const actor = decode<unknown>(original.actor);
    if (!isRevisionMetadataAttribution(actor) || actor.principalId !== row.author_id || original.author_id !== row.author_id || original.object_id !== id) throw invalid();
    return { principalId: actor.principalId, displayName: actor.displayName };
  }
  private automatic(author: RevisionAuthor | null, principalId: string): ('author')[] { return author?.principalId === principalId ? ['author'] : []; }
  private epoch(): number { const value = (this.database.prepare("SELECT value FROM policy_meta WHERE name='epoch'").get() as { value: number }).value; if (!natural(value)) throw invalid(); return value; }
  private empty(id: string, principalId: string): Explicit { return { objectId: id, principalId, displayName: null, version: 0, state: null, updatedAt: null }; }
  private explicitFrom(t: ObjectSubscriptionTransaction): Explicit { return { objectId: t.objectId, principalId: t.principalId, displayName: t.displayName, version: t.version, state: t.after, updatedAt: t.createdAt }; }
  private transactionAt(id: string, principalId: string, version: number): ObjectSubscriptionTransaction {
    const row = this.database.prepare('SELECT id,sequence,operation_id,comment_id,data FROM object_subscription_transactions WHERE object_id=? AND principal_id=? AND version=?').get(id, principalId, version) as { id: string; sequence: number; operation_id: string | null; comment_id: string | null; data: string } | undefined;
    if (!row) throw invalid(); const t = decode<ObjectSubscriptionTransaction>(row.data);
    if (!isObjectSubscriptionTransaction(t, id) || !uuid(t.id) || t.id !== row.id || t.principalId !== principalId || t.version !== version || t.subscriptionVersion !== row.sequence || t.operationId !== row.operation_id || t.commentId !== row.comment_id) throw invalid();
    if (version > 1) {
      const previous = this.database.prepare('SELECT data FROM object_subscription_transactions WHERE object_id=? AND principal_id=? AND version=?').get(id, principalId, version - 1) as { data: string } | undefined;
      if (!previous) throw invalid(); const p = decode<unknown>(previous.data); if (!isObjectSubscriptionTransaction(p, id) || p.version !== version - 1 || p.principalId !== principalId || p.after !== t.before || p.subscriptionVersion >= t.subscriptionVersion) throw invalid();
    }
    if (t.reason === 'comment') {
      if (this.automatic(this.author(id), principalId).length) throw invalid();
      const comment = this.comment(t.commentId!);
      if (comment.pasteId !== id || !isDeepStrictEqual(comment.attribution, t.attribution) || comment.createdAt !== t.createdAt) throw invalid();
    }
    if (t.reason === 'mention') {
      if (this.automatic(this.author(id), principalId).length) throw invalid();
      const comment = this.comment(t.mentionCommentId!);
      if (comment.pasteId !== id || typeof comment.comment !== 'string' || !isStoredMentionProof(comment.mentions, comment.comment) || !isDeepStrictEqual(comment.attribution, t.attribution) || comment.createdAt !== t.createdAt || !comment.mentions.tokens.some(token => token.principalId === principalId && token.displayName === t.displayName)) throw invalid();
    }
    return t;
  }
  private explicitAt(id: string, principalId: string, version: number): Explicit { return version === 0 ? this.empty(id, principalId) : this.explicitFrom(this.transactionAt(id, principalId, version)); }
  private explicit(id: string, principalId: string): Explicit {
    if (!isRevisionAuthorId(principalId)) throw new HttpError(400, 'Choose a valid workspace person.');
    const row = this.database.prepare('SELECT version,state,data FROM object_subscriptions WHERE object_id=? AND principal_id=?').get(id, principalId) as { version: number; state: string; data: string } | undefined;
    const latest = this.database.prepare('SELECT max(version) AS version FROM object_subscription_transactions WHERE object_id=? AND principal_id=?').get(id, principalId) as { version: number | null };
    if (!row) { if (latest.version !== null) throw invalid(); return this.empty(id, principalId); }
    if (!natural(row.version) || row.version === 0 || latest.version !== row.version) throw invalid(); const value = decode<Explicit>(row.data), expected = this.explicitAt(id, principalId, row.version);
    if (row.state !== expected.state || !isDeepStrictEqual(value, expected)) throw invalid();
    const transaction = this.transactionAt(id, principalId, row.version); if (transaction.operationId) this.operation(transaction.operationId);
    return value;
  }
  private decorate(value: Explicit, author: RevisionAuthor | null): ObjectSubscriptionStatus {
    const automatic = this.automatic(author, value.principalId), person = author?.principalId === value.principalId ? author : null;
    const result = { ...value, displayName: value.displayName ?? person?.displayName ?? null, automatic, following: automatic.length > 0 || value.state === 'subscribed' };
    if (!isObjectSubscriptionStatus(result, value.objectId)) throw invalid(); return result;
  }
  private publicVersion(id: string): number { const row = this.database.prepare('SELECT max(sequence) AS version FROM object_subscription_transactions WHERE object_id=?').get(id) as { version: number | null }; const version = row.version ?? 0; if (!natural(version)) throw invalid(); return version; }
  status(id: string, principalId: string): ObjectSubscriptionStatus { return scope(this.database, () => this.decorate(this.explicit(id, principalId), this.author(id))); }
  person(id: string, principalId: string): Omit<ObjectSubscriptionPerson, 'accessEpoch'> { return scope(this.database, () => { const author = this.author(id); return { status: this.decorate(this.explicit(id, principalId), author) }; }); }
  effective(id: string, principalId: string): boolean { return this.status(id, principalId).following; }
  /** Internal delivery selection. Mute preferences never enter public read models. */
  deliveryPreferences(id: string, extra: readonly string[] = []): { recipients: string[]; muted: string[] } {
    return scope(this.database, () => {
      const author = this.author(id), rows = this.database.prepare('SELECT principal_id FROM object_subscriptions WHERE object_id=? LIMIT ?').all(id, OBJECT_SUBSCRIPTION_LIMITS.people + 1) as { principal_id: string }[];
      if (rows.length > OBJECT_SUBSCRIPTION_LIMITS.people || extra.length > 10000) throw limited();
      const recipients = new Set(extra);
      for (const row of rows) if (this.explicit(id, row.principal_id).state === 'subscribed') recipients.add(row.principal_id);
      if (author) recipients.add(author.principalId);
      if (recipients.size > 10000) throw limited();
      const ids = [...recipients].sort();
      return { recipients: ids, muted: ids.filter(person => this.mute(id, person).muted) };
    });
  }
  private muteTransactionAt(id: string, principalId: string, version: number): ObjectMuteTransaction {
    const row = this.database.prepare('SELECT id,operation_id,data FROM object_mute_transactions WHERE object_id=? AND principal_id=? AND version=?').get(id, principalId, version) as { id: string; operation_id: string; data: string } | undefined;
    if (!row) throw invalid(); const t = decode<ObjectMuteTransaction>(row.data);
    if (!isObjectMuteTransaction(t, id, principalId) || !uuid(t.id) || t.id !== row.id || t.operationId !== row.operation_id || t.version !== version) throw invalid();
    if (version > 1) { const previous = this.database.prepare('SELECT data FROM object_mute_transactions WHERE object_id=? AND principal_id=? AND version=?').get(id, principalId, version - 1) as { data: string } | undefined; if (!previous) throw invalid(); const p = decode<unknown>(previous.data); if (!isObjectMuteTransaction(p, id, principalId) || p.version !== version - 1 || p.after !== t.before) throw invalid(); }
    return t;
  }
  private muteAt(id: string, principalId: string, version: number): ObjectMuteState { if (version === 0) return { objectId: id, principalId, version: 0, muted: false, updatedAt: null }; const t = this.muteTransactionAt(id, principalId, version); return { objectId: id, principalId, version, muted: t.after, updatedAt: t.createdAt }; }
  private mute(id: string, principalId: string): ObjectMuteState {
    const row = this.database.prepare('SELECT version,data FROM object_mutes WHERE object_id=? AND principal_id=?').get(id, principalId) as { version: number; data: string } | undefined;
    const latest = this.database.prepare('SELECT max(version) AS version FROM object_mute_transactions WHERE object_id=? AND principal_id=?').get(id, principalId) as { version: number | null };
    if (!row) { if (latest.version !== null) throw invalid(); return this.muteAt(id, principalId, 0); }
    if (!natural(row.version) || row.version === 0 || latest.version !== row.version) throw invalid(); const value = decode<unknown>(row.data); if (!isObjectMuteState(value, id, principalId) || !isDeepStrictEqual(value, this.muteAt(id, principalId, row.version))) throw invalid();
    this.operation(this.muteTransactionAt(id, principalId, row.version).operationId); return value;
  }
  snapshot(id: string, viewerId: string, input: ObjectSubscriptionQuery = {}): Omit<ObjectSubscriptionSnapshot, 'access' | 'accessEpoch'> {
    return scope(this.database, () => {
      const query = object(input, ['after', 'limit', 'expectedSubscriptionVersion']), limit = query.limit ?? 25, author = this.author(id), version = this.publicVersion(id);
      if (!isRevisionAuthorId(viewerId) || !natural(limit) || limit < 1 || limit > OBJECT_SUBSCRIPTION_LIMITS.page || query.after !== undefined && !isRevisionAuthorId(query.after) || ['expectedSubscriptionVersion'].some(key => query[key] !== undefined && !natural(query[key]))) throw new HttpError(400, 'Choose valid subscriber pagination and version.');
      if (query.expectedSubscriptionVersion !== undefined && query.expectedSubscriptionVersion !== version) throw conflict();
      const rows = this.database.prepare('SELECT principal_id FROM object_subscriptions WHERE object_id=? LIMIT ?').all(id, OBJECT_SUBSCRIPTION_LIMITS.people + 1) as { principal_id: string }[]; if (rows.length > OBJECT_SUBSCRIPTION_LIMITS.people) throw limited();
      const people = [...new Set([...rows.map(row => row.principal_id), ...(author ? [author.principalId] : [])])].sort();
      const subscribers: ObjectSubscriptionStatus[] = [];
      for (const principalId of people) { if (query.after !== undefined && principalId <= (query.after as string)) continue; const status = this.decorate(this.explicit(id, principalId), author); if (status.following) subscribers.push(status); if (subscribers.length > limit) break; }
      const more = subscribers.length > limit; if (more) subscribers.pop();
      return { objectId: id, subscriptionVersion: version, subscribers, viewer: this.decorate(this.explicit(id, viewerId), author), mute: this.mute(id, viewerId), nextAfter: more ? subscribers.at(-1)!.principalId : null };
    });
  }
  history(id: string, input: { before?: number; limit?: number; expectedSubscriptionVersion?: number } = {}): Omit<ObjectSubscriptionHistory, 'accessEpoch'> {
    return scope(this.database, () => {
      this.author(id); const query = object(input, ['before', 'limit', 'expectedSubscriptionVersion']), limit = this.pageSize(query), version = this.publicVersion(id);
      if (query.expectedSubscriptionVersion !== undefined && (!natural(query.expectedSubscriptionVersion) || query.expectedSubscriptionVersion !== version)) throw conflict();
      const rows = this.database.prepare('SELECT principal_id,version FROM object_subscription_transactions WHERE object_id=? AND (? IS NULL OR sequence<?) ORDER BY sequence DESC LIMIT ?').all(id, (query.before as number | undefined) ?? null, (query.before as number | undefined) ?? null, limit + 1) as { principal_id: string; version: number }[];
      const transactions = rows.slice(0, limit).map(row => { const t = this.transactionAt(id, row.principal_id, row.version); if (t.operationId) this.operation(t.operationId); return t; });
      return { objectId: id, subscriptionVersion: version, transactions, nextBefore: rows.length > limit ? transactions.at(-1)!.subscriptionVersion : null };
    });
  }
  muteHistory(id: string, principalId: string, input: { before?: number; limit?: number; expectedMuteVersion?: number } = {}): Omit<ObjectMuteHistory, 'accessEpoch'> {
    return scope(this.database, () => {
      this.author(id); if (!isRevisionAuthorId(principalId)) throw new HttpError(400, 'Choose a valid workspace person.'); const query = object(input, ['before', 'limit', 'expectedMuteVersion']), limit = this.pageSize(query), mute = this.mute(id, principalId);
      if (query.expectedMuteVersion !== undefined && (!natural(query.expectedMuteVersion) || query.expectedMuteVersion !== mute.version)) throw conflict();
      const rows = this.database.prepare('SELECT version FROM object_mute_transactions WHERE object_id=? AND principal_id=? AND (? IS NULL OR version<?) ORDER BY version DESC LIMIT ?').all(id, principalId, (query.before as number | undefined) ?? null, (query.before as number | undefined) ?? null, limit + 1) as { version: number }[];
      const transactions = rows.slice(0, limit).map(row => { const t = this.muteTransactionAt(id, principalId, row.version); this.operation(t.operationId); return t; });
      return { objectId: id, principalId, muteVersion: mute.version, transactions, nextBefore: rows.length > limit ? transactions.at(-1)!.version : null };
    });
  }
  private pageSize(query: Record<string, unknown>): number { const limit = query.limit ?? 25; if (!natural(limit) || limit < 1 || limit > OBJECT_SUBSCRIPTION_LIMITS.page || query.before !== undefined && (!natural(query.before) || query.before < 1)) throw new HttpError(400, 'Choose valid history pagination.'); return limit; }
  private checkNewPerson(id: string, before: Explicit): void { if (before.version !== 0) return; const row = this.database.prepare('SELECT count(*) AS count FROM object_subscriptions WHERE object_id=?').get(id) as { count: number }; if (row.count >= OBJECT_SUBSCRIPTION_LIMITS.people) throw limited(); }
  private append(t: ObjectSubscriptionTransaction): void {
    const after = this.explicitFrom(t);
    this.database.prepare('INSERT INTO object_subscription_transactions(id,object_id,sequence,principal_id,version,operation_id,comment_id,data) VALUES(?,?,?,?,?,?,?,?)').run(t.id, t.objectId, t.subscriptionVersion, t.principalId, t.version, t.operationId, t.commentId, JSON.stringify(t));
    this.database.prepare('INSERT INTO object_subscriptions(object_id,principal_id,version,state,data) VALUES(?,?,?,?,?) ON CONFLICT(object_id,principal_id) DO UPDATE SET version=excluded.version,state=excluded.state,data=excluded.data').run(t.objectId, t.principalId, t.version, t.after, JSON.stringify(after));
  }
  mutate(id: string, input: ObjectSubscriptionInput, actor: ActorAttribution, target?: RevisionAuthor, retryKeySha256: string | null = null): ObjectSubscriptionReceipt {
    const request = parse(input); if (retryKeySha256 !== null && (typeof retryKeySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(retryKeySha256))) throw new HttpError(400, 'Invalid internal retry identity.'); if (!isRevisionMetadataAttribution(actor)) throw new HttpError(400, 'Authenticated subscription attribution is required.');
    return scope(this.database, () => {
      const author = this.author(id), epoch = this.epoch();
      if (!natural(epoch)) throw invalid(); if (epoch !== request.expectedAccessEpoch) throw new HttpError(409, 'Access changed. Reload before continuing.', 'ACCESS_EPOCH_CHANGED');
      const now = new Date().toISOString(), operationId = randomUUID(), inputSha256 = objectSubscriptionInputHash(request);
      let before: Explicit | ObjectMuteState, receipt: ObjectSubscriptionReceipt, publicVersion: number | null = null;
      if (request.action === 'subscribe' || request.action === 'unsubscribe') {
        before = this.explicit(id, request.principalId); publicVersion = this.publicVersion(id);
        if (before.version !== request.expectedSubscriptionVersion) throw conflict();
        if (request.principalId === actor.principalId && this.automatic(author, actor.principalId).length) throw new HttpError(409, 'Paste authors follow automatically. Use personal mute instead.', 'OBJECT_SUBSCRIPTION_AUTOMATIC');
        const person = request.principalId === actor.principalId ? { principalId: actor.principalId, displayName: actor.displayName } : target;
        if (!isRevisionAuthor(person) || person.principalId !== request.principalId) throw new HttpError(400, 'A verified workspace person is required.');
        const desired = request.action === 'subscribe' ? 'subscribed' : 'unsubscribed', changed = before.state !== desired;
        if (changed) { this.checkNewPerson(id, before); if (!Number.isSafeInteger(before.version + 1) || !Number.isSafeInteger(publicVersion + 1)) throw limited(); }
        const transaction: ObjectSubscriptionTransaction | null = changed ? { id: randomUUID(), objectId: id, operationId, subscriptionVersion: publicVersion + 1, principalId: person.principalId, displayName: person.displayName, version: before.version + 1, before: before.state, after: desired, reason: 'explicit', commentId: null, attribution: { ...actor }, createdAt: now } : null;
        receipt = { objectId: id, operationId, inputSha256, changed, accessEpoch: epoch, kind: 'subscription', subscriptionVersion: publicVersion + Number(changed), status: this.decorate(transaction ? this.explicitFrom(transaction) : before, author), transaction };
      } else {
        if (!('expectedMuteVersion' in request)) throw invalid();
        if (request.principalId !== actor.principalId) throw new HttpError(403, 'Personal mute can only be changed for yourself.');
        before = this.mute(id, actor.principalId); if (before.version !== request.expectedMuteVersion) throw conflict();
        const desired = request.action === 'mute', changed = before.muted !== desired; if (changed && !Number.isSafeInteger(before.version + 1)) throw limited();
        const transaction: ObjectMuteTransaction | null = changed ? { id: randomUUID(), objectId: id, operationId, principalId: actor.principalId, version: before.version + 1, before: before.muted, after: desired, attribution: { ...actor }, createdAt: now } : null;
        receipt = { objectId: id, operationId, inputSha256, changed, accessEpoch: epoch, kind: 'mute', mute: transaction ? { ...before, version: transaction.version, muted: desired, updatedAt: now } : before, transaction };
      }
      const operation: ObjectSubscriptionOperation = { retryKeySha256, id: operationId, objectId: id, input: request, inputSha256, attribution: { ...actor }, author, before, subscriptionVersion: publicVersion, createdAt: now, receipt };
      this.database.prepare('INSERT INTO object_subscription_operations(id,object_id,principal_id,kind,input_sha256,preference_version,subscription_version,data) VALUES(?,?,?,?,?,?,?,?)').run(operationId, id, actor.principalId, receipt.kind, inputSha256, before.version, publicVersion, JSON.stringify(operation));
      if (receipt.kind === 'subscription' && receipt.transaction) this.append(receipt.transaction);
      if (receipt.kind === 'mute' && receipt.transaction) {
        const t = receipt.transaction; this.database.prepare('INSERT INTO object_mute_transactions(id,object_id,principal_id,version,operation_id,data) VALUES(?,?,?,?,?,?)').run(t.id, id, actor.principalId, t.version, operationId, JSON.stringify(t));
        this.database.prepare('INSERT INTO object_mutes(object_id,principal_id,version,data) VALUES(?,?,?,?) ON CONFLICT(object_id,principal_id) DO UPDATE SET version=excluded.version,data=excluded.data').run(id, actor.principalId, receipt.mute.version, JSON.stringify(receipt.mute));
      }
      if (receipt.kind === 'subscription' && receipt.changed && request.principalId !== actor.principalId) this.notificationPublisher?.({ objectId: id, kind: id.startsWith('PA') ? 'paste_subscribers_changed' : 'wiki_subscribers_changed', cause: { type: 'subscriptions', id: operationId }, attribution: actor }); return receipt;
    }, true);
  }
  /** Only actual enabled accounts or the local workspace identity are people.
   * There is no bot account type today; unknown/application actors are excluded. */
  private human(actor: ActorAttribution): boolean {
    if (!isRevisionMetadataAttribution(actor) || /^(operator|application|bot|system):/.test(actor.principalId)) return false;
    if (this.database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='auth_accounts'").get() && this.database.prepare('SELECT 1 FROM auth_accounts WHERE id=? AND disabled=0').get(actor.principalId)) return true;
    if (!this.database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='auth_meta'").get()) return false;
    const workspace = this.database.prepare("SELECT value FROM auth_meta WHERE name='workspace_id'").get() as { value: string } | undefined;
    const required = this.database.prepare("SELECT value FROM auth_meta WHERE name='require_auth'").get() as { value: string } | undefined;
    return Boolean(workspace && required?.value !== 'true' && actor.principalId === `local:${workspace.value}`);
  }
  private comment(commentId: string): PasteTransaction {
    const row = this.database.prepare('SELECT paste_id,sequence,paste_version,content_version,data FROM paste_transactions WHERE id=?').get(commentId) as { paste_id: string; sequence: number; paste_version: number; content_version: number; data: string } | undefined;
    if (!row) throw invalid(); const value = decode<PasteTransaction>(row.data);
    if (!value || value.id !== commentId || value.pasteId !== row.paste_id || !/^PA[1-9]\d{0,14}$/.test(value.pasteId) || value.kind !== 'comment' || value.sequence !== row.sequence || value.pasteVersion !== row.paste_version || value.contentVersion !== row.content_version || !isRevisionMetadataAttribution(value.attribution) || !Number.isFinite(Date.parse(value.createdAt))) throw invalid();
    return value;
  }
  implicitComment(transaction: PasteTransaction): void {
    if (!transaction?.attribution || !this.human(transaction.attribution)) return;
    scope(this.database, () => {
      const comment = this.comment(transaction.id); if (!isDeepStrictEqual(comment, transaction)) throw invalid();
      const id = comment.pasteId, actor = comment.attribution, author = this.author(id), before = this.explicit(id, actor.principalId);
      if (before.state !== null || this.automatic(author, actor.principalId).length) return;
      const capacity = this.database.prepare('SELECT count(*) AS count FROM object_subscriptions WHERE object_id=?').get(id) as { count: number };
      // A valid comment remains possible when incidental following is at capacity.
      if (capacity.count >= OBJECT_SUBSCRIPTION_LIMITS.people) return;
      const sequence = this.publicVersion(id) + 1; if (!Number.isSafeInteger(sequence)) throw limited();
      this.append({ id: randomUUID(), objectId: id, operationId: null, subscriptionVersion: sequence, principalId: actor.principalId, displayName: actor.displayName, version: 1, before: null, after: 'subscribed', reason: 'comment', commentId: comment.id, attribution: { ...actor }, createdAt: comment.createdAt });
    }, true);
  }
  /** Called only while inserting the original immutable Paste comment. */
  mentioned(value: PasteTransaction): void {
    if (value.mentions === undefined) return;
    scope(this.database, () => {
      const comment = this.comment(value.id);
      if (!isDeepStrictEqual(comment, value) || typeof comment.comment !== 'string' || !isStoredMentionProof(comment.mentions, comment.comment)) throw invalid();
      const id = comment.pasteId, author = this.author(id), people = new Map<string, string>();
      for (const token of comment.mentions.tokens) if (token.principalId !== null) people.set(token.principalId, token.displayName!);
      for (const [principalId, displayName] of people) {
        if (this.automatic(author, principalId).length) continue;
        const before = this.explicit(id, principalId);
        if (before.state === 'subscribed' || this.database.prepare("SELECT 1 FROM object_subscription_transactions WHERE object_id=? AND principal_id=? AND json_extract(data,'$.mentionCommentId')=?").get(id, principalId, comment.id)) continue;
        this.checkNewPerson(id, before);
        const sequence = this.publicVersion(id) + 1, version = before.version + 1;
        if (!Number.isSafeInteger(sequence) || !Number.isSafeInteger(version)) throw limited();
        this.append({ id: randomUUID(), objectId: id, operationId: null, subscriptionVersion: sequence, principalId, displayName, version, before: before.state, after: 'subscribed', reason: 'mention', commentId: null, mentionCommentId: comment.id, attribution: { ...comment.attribution }, createdAt: comment.createdAt });
      }
    }, true);
  }
  operationPrincipalId(id: string): string { if (!uuid(id)) throw invalid(); const row = this.database.prepare('SELECT principal_id FROM object_subscription_operations WHERE id=?').get(id) as { principal_id: string } | undefined; if (!row || !isRevisionAuthorId(row.principal_id)) throw invalid(); return row.principal_id; }
  operationObjectId(id: string): string { if (!uuid(id)) throw invalid(); const row = this.database.prepare('SELECT object_id FROM object_subscription_operations WHERE id=?').get(id) as { object_id: string } | undefined; if (!row || !isSubscriptionObjectId(row.object_id)) throw invalid(); return row.object_id; }
  operation(id: string): ObjectSubscriptionOperation {
    return scope(this.database, () => {
      try {
        const objectId = this.operationObjectId(id), row = this.database.prepare('SELECT principal_id,kind,input_sha256,preference_version,subscription_version,data FROM object_subscription_operations WHERE id=?').get(id) as { principal_id: string; kind: string; input_sha256: string; preference_version: number; subscription_version: number | null; data: string }, value = decode<ObjectSubscriptionOperation>(row.data);
        if (!value || Object.keys(value).sort().join(',') !== 'attribution,author,before,createdAt,id,input,inputSha256,objectId,receipt,retryKeySha256,subscriptionVersion' || value.retryKeySha256 !== null && (typeof value.retryKeySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.retryKeySha256)) || value.id !== id || value.objectId !== objectId || !isRevisionMetadataAttribution(value.attribution) || value.attribution.principalId !== row.principal_id || !isDeepStrictEqual(parse(value.input), value.input) || value.inputSha256 !== row.input_sha256 || value.inputSha256 !== objectSubscriptionInputHash(value.input) || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || !validObjectSubscriptionResult(value.receipt, objectId, value.input, value.attribution.principalId) || value.receipt.kind !== row.kind || value.receipt.operationId !== id || value.receipt.inputSha256 !== value.inputSha256 || value.receipt.accessEpoch !== value.input.expectedAccessEpoch) throw invalid();
        const request = value.input, author = this.author(objectId);
        if (!isDeepStrictEqual(value.author, author) || value.before.version !== row.preference_version || value.subscriptionVersion !== row.subscription_version) throw invalid();
        if (request.action === 'subscribe' || request.action === 'unsubscribe') {
          const receipt = value.receipt; if (receipt.kind !== 'subscription' || !natural(value.subscriptionVersion) || value.subscriptionVersion > this.publicVersion(objectId) || request.principalId === value.attribution.principalId && this.automatic(author, request.principalId).length) throw invalid();
          const before = this.explicitAt(objectId, request.principalId, request.expectedSubscriptionVersion), desired = request.action === 'subscribe' ? 'subscribed' : 'unsubscribed', changed = before.state !== desired;
          if (!isDeepStrictEqual(before, value.before) || receipt.changed !== changed || receipt.subscriptionVersion !== value.subscriptionVersion + Number(changed)) throw invalid();
          if (changed) {
            const t = this.transactionAt(objectId, request.principalId, before.version + 1);
            if (t.operationId !== id || t.before !== before.state || t.after !== desired || !isDeepStrictEqual(t.attribution, value.attribution) || t.createdAt !== value.createdAt || !isDeepStrictEqual(t, receipt.transaction) || !isDeepStrictEqual(this.decorate(this.explicitFrom(t), author), receipt.status)) throw invalid();
          } else if (!isDeepStrictEqual(this.decorate(before, author), receipt.status) || this.database.prepare('SELECT 1 FROM object_subscription_transactions WHERE operation_id=?').get(id)) throw invalid();
        } else {
          if (!('expectedMuteVersion' in request)) throw invalid();
          const receipt = value.receipt; if (receipt.kind !== 'mute' || value.subscriptionVersion !== null || request.principalId !== value.attribution.principalId) throw invalid();
          const before = this.muteAt(objectId, request.principalId, request.expectedMuteVersion), desired = request.action === 'mute', changed = before.muted !== desired;
          if (!isDeepStrictEqual(before, value.before) || receipt.changed !== changed || !isDeepStrictEqual(receipt.mute, changed ? { ...before, version: before.version + 1, muted: desired, updatedAt: value.createdAt } : before)) throw invalid();
          if (changed) { const t = this.muteTransactionAt(objectId, request.principalId, before.version + 1); if (t.operationId !== id || !isDeepStrictEqual(t.attribution, value.attribution) || t.createdAt !== value.createdAt || !isDeepStrictEqual(t, receipt.transaction)) throw invalid(); }
          else if (this.database.prepare('SELECT 1 FROM object_mute_transactions WHERE operation_id=?').get(id)) throw invalid();
        }
        return value;
      } catch { throw invalid(); }
    });
  }
}
