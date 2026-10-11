import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import type { ActorAttribution } from '../shared/types.ts';
import { isRevisionId } from '../shared/revision-dependencies.ts';
import { isRevisionAuthor, isRevisionAuthorId, isRevisionAuthorTransaction, type RevisionAuthor } from '../shared/revision-authorship.ts';
import { isRevisionMetadataAttribution } from '../shared/revision-metadata.ts';
import { REVISION_SUBSCRIPTION_LIMITS, isRevisionMuteState, isRevisionMuteTransaction, isRevisionSubscriptionStatus, isRevisionSubscriptionTransaction, revisionSubscriptionInput, validRevisionSubscriptionResult, type RevisionMuteHistory, type RevisionMuteState, type RevisionMuteTransaction, type RevisionSubscriptionExplicitState, type RevisionSubscriptionHistory, type RevisionSubscriptionInput, type RevisionSubscriptionPerson, type RevisionSubscriptionReceipt, type RevisionSubscriptionSnapshot, type RevisionSubscriptionStatus, type RevisionSubscriptionTransaction } from '../shared/revision-subscriptions.ts';
import type { RevisionAuthorshipStore } from './revision-authorship.ts';
import type { RevisionReviewerStore } from './revision-reviewers.ts';
import { HttpError, object } from './validation.ts';

type Roles = { authorVersion: number; reviewerVersion: number; author: RevisionAuthor | null; reviewers: RevisionAuthor[] };
type Explicit = { revisionId: string; principalId: string; displayName: string | null; version: number; state: RevisionSubscriptionExplicitState | null; updatedAt: string | null };
export interface RevisionSubscriptionOperation { retryKeySha256: string | null; id: string; revisionId: string; input: RevisionSubscriptionInput; inputSha256: string; attribution: ActorAttribution; roles: Roles; before: Explicit | RevisionMuteState; subscriptionVersion: number | null; createdAt: string; receipt: RevisionSubscriptionReceipt }
export interface RevisionSubscriptionQuery { after?: string; limit?: number; expectedSubscriptionVersion?: number; expectedAuthorVersion?: number; expectedReviewerVersion?: number }
const invalid = () => new HttpError(409, 'Revision subscription history cannot be verified.', 'REVISION_SUBSCRIPTION_INVALID_RECEIPT');
const conflict = () => new HttpError(409, 'Following, automatic roles or preferences changed. Reload before continuing.', 'REVISION_SUBSCRIPTION_CHANGED');
const limited = () => new HttpError(422, 'Revision subscriptions reached their supported limit.', 'REVISION_SUBSCRIPTION_LIMIT');
const natural = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const roleIdentity = (roles: Roles) => ({ authorId: roles.author?.principalId ?? null, reviewerIds: roles.reviewers.map(person => person.principalId) });
const roleDigest = (roles: Roles) => digest(roleIdentity(roles));
const decode = <T>(value: string): T => { try { return JSON.parse(value) as T; } catch { throw invalid(); } };
let counter = 0;
function scope<T>(db: DatabaseSync, work: () => T, write = false): T {
  const name = `revision_subscriptions_${++counter}`; db.exec(`SAVEPOINT ${name}`);
  try { if (write) db.exec('UPDATE revision_subscriptions SET version=version WHERE 0'); const value = work(); db.exec(`RELEASE ${name}`); return value; }
  catch (error) { db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
}
function parse(input: unknown): RevisionSubscriptionInput { try { return revisionSubscriptionInput(input); } catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'Invalid following preference.', 'REVISION_SUBSCRIPTION_INVALID_INPUT'); } }
export function revisionSubscriptionInputHash(input: RevisionSubscriptionInput): string { return digest(parse(input)); }

/** No backfill: legacy comments never manufacture subscriptions or opt-outs. */
export function initializeRevisionSubscriptions(db: DatabaseSync): void {
  scope(db, () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS revision_subscriptions(revision_id TEXT NOT NULL REFERENCES entities(id),principal_id TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0 AND version<=9007199254740991),state TEXT NOT NULL CHECK(state IN('subscribed','unsubscribed')),data TEXT NOT NULL CHECK(json_valid(data)),PRIMARY KEY(revision_id,principal_id));
      CREATE TABLE IF NOT EXISTS revision_subscription_operations(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES entities(id),principal_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN('subscription','mute')),input_sha256 TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE IF NOT EXISTS revision_subscription_transactions(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES entities(id),sequence INTEGER NOT NULL CHECK(sequence>0 AND sequence<=9007199254740991),principal_id TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0 AND version<=9007199254740991),operation_id TEXT UNIQUE REFERENCES revision_subscription_operations(id),comment_id TEXT UNIQUE REFERENCES comments(id),data TEXT NOT NULL CHECK(json_valid(data)),UNIQUE(revision_id,sequence),UNIQUE(revision_id,principal_id,version));
      CREATE TABLE IF NOT EXISTS revision_mutes(revision_id TEXT NOT NULL REFERENCES entities(id),principal_id TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0 AND version<=9007199254740991),data TEXT NOT NULL CHECK(json_valid(data)),PRIMARY KEY(revision_id,principal_id));
      CREATE TABLE IF NOT EXISTS revision_mute_transactions(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES entities(id),principal_id TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0 AND version<=9007199254740991),operation_id TEXT NOT NULL UNIQUE REFERENCES revision_subscription_operations(id),data TEXT NOT NULL CHECK(json_valid(data)),UNIQUE(revision_id,principal_id,version));
    `);
    for (const table of ['revision_subscription_operations', 'revision_subscription_transactions', 'revision_mute_transactions']) db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Revision subscription evidence is immutable'); END; CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Revision subscription evidence is immutable'); END;`);
    for (const [table, columns] of Object.entries({ revision_subscriptions: ['revision_id', 'principal_id', 'version', 'state', 'data'], revision_subscription_operations: ['id', 'revision_id', 'principal_id', 'kind', 'input_sha256', 'data'], revision_subscription_transactions: ['id', 'revision_id', 'sequence', 'principal_id', 'version', 'operation_id', 'comment_id', 'data'], revision_mutes: ['revision_id', 'principal_id', 'version', 'data'], revision_mute_transactions: ['id', 'revision_id', 'principal_id', 'version', 'operation_id', 'data'] })) {
      if (!isDeepStrictEqual((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name), columns)) throw new Error(`Unexpected ${table} schema; subscription migration was not applied.`);
    }
  });
}

/** The caller owns current VIEW/action authority and validates new people. Mute
 * reads and receipts must only be presented to their authenticated principal. */
export class RevisionSubscriptionStore {
  constructor(private readonly database: DatabaseSync, private readonly authorship: RevisionAuthorshipStore, private readonly reviewers: RevisionReviewerStore) {}
  private requireRevision(id: string): void {
    if (!isRevisionId(id) || !this.database.prepare("SELECT 1 FROM entities WHERE id=? AND kind='revision' AND json_extract(data,'$.id')=?").get(id, id)) throw new HttpError(404, 'Revision subscriptions are unavailable.', 'REVISION_SUBSCRIPTION_UNAVAILABLE');
  }
  private roles(id: string): Roles {
    this.requireRevision(id); const author = this.authorship.state(id), reviewers = this.reviewers.state(id);
    return { authorVersion: author.version, reviewerVersion: reviewers.version, author: author.author, reviewers: reviewers.members.filter(member => member.status !== 'resigned').map(({ principalId, displayName }) => ({ principalId, displayName })) };
  }
  private rolesAt(id: string, authorVersion: number, reviewerVersion: number): Roles {
    if (!natural(authorVersion) || !natural(reviewerVersion)) throw invalid();
    const current = this.authorship.state(id); if (authorVersion > current.version) throw invalid(); let author: RevisionAuthor | null;
    if (authorVersion === 0) author = current.originalAuthor;
    else {
      const row = this.database.prepare('SELECT id,operation_id,data FROM revision_author_transactions WHERE revision_id=? AND author_version=?').get(id, authorVersion) as { id: string; operation_id: string; data: string } | undefined;
      if (!row) throw invalid(); const t = decode<unknown>(row.data); if (!isRevisionAuthorTransaction(t, id) || t.authorVersion !== authorVersion || t.id !== row.id || t.operationId !== row.operation_id) throw invalid(); author = t.author;
    }
    const currentReviewers = this.reviewers.state(id); if (reviewerVersion > currentReviewers.version) throw invalid();
    const reviewers = this.reviewers.stateAt(id, reviewerVersion);
    return { authorVersion, reviewerVersion, author, reviewers: reviewers.members.filter(member => member.status !== 'resigned').map(({ principalId, displayName }) => ({ principalId, displayName })) };
  }
  private automatic(roles: Roles, principalId: string): ('author' | 'reviewer')[] { return [...(roles.author?.principalId === principalId ? ['author' as const] : []), ...(roles.reviewers.some(person => person.principalId === principalId) ? ['reviewer' as const] : [])]; }
  private empty(id: string, principalId: string): Explicit { return { revisionId: id, principalId, displayName: null, version: 0, state: null, updatedAt: null }; }
  private explicitFrom(t: RevisionSubscriptionTransaction): Explicit { return { revisionId: t.revisionId, principalId: t.principalId, displayName: t.displayName, version: t.version, state: t.after, updatedAt: t.createdAt }; }
  private transactionAt(id: string, principalId: string, version: number): RevisionSubscriptionTransaction {
    const row = this.database.prepare('SELECT id,sequence,operation_id,comment_id,data FROM revision_subscription_transactions WHERE revision_id=? AND principal_id=? AND version=?').get(id, principalId, version) as { id: string; sequence: number; operation_id: string | null; comment_id: string | null; data: string } | undefined;
    if (!row) throw invalid(); const t = decode<RevisionSubscriptionTransaction>(row.data);
    if (!isRevisionSubscriptionTransaction(t, id) || !uuid(t.id) || t.id !== row.id || t.principalId !== principalId || t.version !== version || t.subscriptionVersion !== row.sequence || t.operationId !== row.operation_id || t.commentId !== row.comment_id) throw invalid();
    const roles = this.rolesAt(id, t.authorVersion, t.reviewerVersion);
    if (version > 1) {
      const previous = this.database.prepare('SELECT data FROM revision_subscription_transactions WHERE revision_id=? AND principal_id=? AND version=?').get(id, principalId, version - 1) as { data: string } | undefined;
      if (!previous) throw invalid(); const p = decode<unknown>(previous.data); if (!isRevisionSubscriptionTransaction(p, id) || p.version !== version - 1 || p.principalId !== principalId || p.after !== t.before || p.subscriptionVersion >= t.subscriptionVersion) throw invalid();
    }
    if (t.reason === 'comment') {
      if (this.automatic(roles, principalId).length) throw invalid();
      const comment = this.database.prepare("SELECT revision_id,json_extract(data,'$.id') AS id,json_extract(data,'$.revisionId') AS stored_revision,json_type(data,'$.attribution') AS actor_type,substr(json_extract(data,'$.attribution'),1,4097) AS actor,json_extract(data,'$.createdAt') AS created_at FROM comments WHERE id=?").get(t.commentId) as Record<string, unknown> | undefined;
      if (!comment || comment.revision_id !== id || comment.id !== t.commentId || comment.stored_revision !== id || comment.actor_type !== 'object' || typeof comment.actor !== 'string' || !isDeepStrictEqual(decode(comment.actor), t.attribution) || comment.created_at !== t.createdAt) throw invalid();
    }
    return t;
  }
  private explicitAt(id: string, principalId: string, version: number): Explicit { return version === 0 ? this.empty(id, principalId) : this.explicitFrom(this.transactionAt(id, principalId, version)); }
  private explicit(id: string, principalId: string): Explicit {
    if (!isRevisionAuthorId(principalId)) throw new HttpError(400, 'Choose a valid workspace person.');
    const row = this.database.prepare('SELECT version,state,data FROM revision_subscriptions WHERE revision_id=? AND principal_id=?').get(id, principalId) as { version: number; state: string; data: string } | undefined;
    const latest = this.database.prepare('SELECT max(version) AS version FROM revision_subscription_transactions WHERE revision_id=? AND principal_id=?').get(id, principalId) as { version: number | null };
    if (!row) { if (latest.version !== null) throw invalid(); return this.empty(id, principalId); }
    if (!natural(row.version) || row.version === 0 || latest.version !== row.version) throw invalid(); const value = decode<Explicit>(row.data), expected = this.explicitAt(id, principalId, row.version);
    if (row.state !== expected.state || !isDeepStrictEqual(value, expected)) throw invalid(); return value;
  }
  private decorate(value: Explicit, roles: Roles): RevisionSubscriptionStatus {
    const automatic = this.automatic(roles, value.principalId), person = roles.author?.principalId === value.principalId ? roles.author : roles.reviewers.find(item => item.principalId === value.principalId);
    const result = { ...value, displayName: value.displayName ?? person?.displayName ?? null, automatic, following: automatic.length > 0 || value.state === 'subscribed' };
    if (!isRevisionSubscriptionStatus(result, value.revisionId)) throw invalid(); return result;
  }
  private publicVersion(id: string): number { const row = this.database.prepare('SELECT max(sequence) AS version FROM revision_subscription_transactions WHERE revision_id=?').get(id) as { version: number | null }; const version = row.version ?? 0; if (!natural(version)) throw invalid(); return version; }
  status(id: string, principalId: string): RevisionSubscriptionStatus { return scope(this.database, () => this.decorate(this.explicit(id, principalId), this.roles(id))); }
  person(id: string, principalId: string): Omit<RevisionSubscriptionPerson, 'accessEpoch'> { return scope(this.database, () => { const roles = this.roles(id); return { status: this.decorate(this.explicit(id, principalId), roles), authorVersion: roles.authorVersion, reviewerVersion: roles.reviewerVersion, roleDigest: roleDigest(roles) }; }); }
  effective(id: string, principalId: string): boolean { return this.status(id, principalId).following; }
  private muteTransactionAt(id: string, principalId: string, version: number): RevisionMuteTransaction {
    const row = this.database.prepare('SELECT id,operation_id,data FROM revision_mute_transactions WHERE revision_id=? AND principal_id=? AND version=?').get(id, principalId, version) as { id: string; operation_id: string; data: string } | undefined;
    if (!row) throw invalid(); const t = decode<RevisionMuteTransaction>(row.data);
    if (!isRevisionMuteTransaction(t, id, principalId) || !uuid(t.id) || t.id !== row.id || t.operationId !== row.operation_id || t.version !== version) throw invalid();
    if (version > 1) { const previous = this.database.prepare('SELECT data FROM revision_mute_transactions WHERE revision_id=? AND principal_id=? AND version=?').get(id, principalId, version - 1) as { data: string } | undefined; if (!previous) throw invalid(); const p = decode<unknown>(previous.data); if (!isRevisionMuteTransaction(p, id, principalId) || p.version !== version - 1 || p.after !== t.before) throw invalid(); }
    return t;
  }
  private muteAt(id: string, principalId: string, version: number): RevisionMuteState { if (version === 0) return { revisionId: id, principalId, version: 0, muted: false, updatedAt: null }; const t = this.muteTransactionAt(id, principalId, version); return { revisionId: id, principalId, version, muted: t.after, updatedAt: t.createdAt }; }
  private mute(id: string, principalId: string): RevisionMuteState {
    const row = this.database.prepare('SELECT version,data FROM revision_mutes WHERE revision_id=? AND principal_id=?').get(id, principalId) as { version: number; data: string } | undefined;
    const latest = this.database.prepare('SELECT max(version) AS version FROM revision_mute_transactions WHERE revision_id=? AND principal_id=?').get(id, principalId) as { version: number | null };
    if (!row) { if (latest.version !== null) throw invalid(); return this.muteAt(id, principalId, 0); }
    if (!natural(row.version) || row.version === 0 || latest.version !== row.version) throw invalid(); const value = decode<unknown>(row.data); if (!isRevisionMuteState(value, id, principalId) || !isDeepStrictEqual(value, this.muteAt(id, principalId, row.version))) throw invalid(); return value;
  }
  snapshot(id: string, viewerId: string, input: RevisionSubscriptionQuery = {}): Omit<RevisionSubscriptionSnapshot, 'access' | 'accessEpoch'> {
    return scope(this.database, () => {
      const query = object(input, ['after', 'limit', 'expectedSubscriptionVersion', 'expectedAuthorVersion', 'expectedReviewerVersion']), limit = query.limit ?? 25, roles = this.roles(id), version = this.publicVersion(id);
      if (!isRevisionAuthorId(viewerId) || !natural(limit) || limit < 1 || limit > REVISION_SUBSCRIPTION_LIMITS.page || query.after !== undefined && !isRevisionAuthorId(query.after) || ['expectedSubscriptionVersion', 'expectedAuthorVersion', 'expectedReviewerVersion'].some(key => query[key] !== undefined && !natural(query[key]))) throw new HttpError(400, 'Choose valid subscriber pagination and role versions.');
      if (query.expectedSubscriptionVersion !== undefined && query.expectedSubscriptionVersion !== version || query.expectedAuthorVersion !== undefined && query.expectedAuthorVersion !== roles.authorVersion || query.expectedReviewerVersion !== undefined && query.expectedReviewerVersion !== roles.reviewerVersion) throw conflict();
      const rows = this.database.prepare('SELECT principal_id FROM revision_subscriptions WHERE revision_id=? LIMIT ?').all(id, REVISION_SUBSCRIPTION_LIMITS.people + 1) as { principal_id: string }[]; if (rows.length > REVISION_SUBSCRIPTION_LIMITS.people) throw limited();
      const people = [...new Set([...rows.map(row => row.principal_id), ...(roles.author ? [roles.author.principalId] : []), ...roles.reviewers.map(person => person.principalId)])].sort();
      const subscribers: RevisionSubscriptionStatus[] = [];
      for (const principalId of people) { if (query.after !== undefined && principalId <= (query.after as string)) continue; const status = this.decorate(this.explicit(id, principalId), roles); if (status.following) subscribers.push(status); if (subscribers.length > limit) break; }
      const more = subscribers.length > limit; if (more) subscribers.pop();
      return { revisionId: id, subscriptionVersion: version, authorVersion: roles.authorVersion, reviewerVersion: roles.reviewerVersion, roleDigest: roleDigest(roles), subscribers, viewer: this.decorate(this.explicit(id, viewerId), roles), mute: this.mute(id, viewerId), nextAfter: more ? subscribers.at(-1)!.principalId : null };
    });
  }
  history(id: string, input: { before?: number; limit?: number; expectedSubscriptionVersion?: number } = {}): Omit<RevisionSubscriptionHistory, 'accessEpoch'> {
    return scope(this.database, () => {
      this.requireRevision(id); const query = object(input, ['before', 'limit', 'expectedSubscriptionVersion']), limit = this.pageSize(query), version = this.publicVersion(id);
      if (query.expectedSubscriptionVersion !== undefined && (!natural(query.expectedSubscriptionVersion) || query.expectedSubscriptionVersion !== version)) throw conflict();
      const rows = this.database.prepare('SELECT principal_id,version FROM revision_subscription_transactions WHERE revision_id=? AND (? IS NULL OR sequence<?) ORDER BY sequence DESC LIMIT ?').all(id, (query.before as number | undefined) ?? null, (query.before as number | undefined) ?? null, limit + 1) as { principal_id: string; version: number }[];
      const transactions = rows.slice(0, limit).map(row => { const t = this.transactionAt(id, row.principal_id, row.version); if (t.operationId) this.operation(t.operationId); return t; });
      return { revisionId: id, subscriptionVersion: version, transactions, nextBefore: rows.length > limit ? transactions.at(-1)!.subscriptionVersion : null };
    });
  }
  muteHistory(id: string, principalId: string, input: { before?: number; limit?: number; expectedMuteVersion?: number } = {}): Omit<RevisionMuteHistory, 'accessEpoch'> {
    return scope(this.database, () => {
      this.requireRevision(id); if (!isRevisionAuthorId(principalId)) throw new HttpError(400, 'Choose a valid workspace person.'); const query = object(input, ['before', 'limit', 'expectedMuteVersion']), limit = this.pageSize(query), mute = this.mute(id, principalId);
      if (query.expectedMuteVersion !== undefined && (!natural(query.expectedMuteVersion) || query.expectedMuteVersion !== mute.version)) throw conflict();
      const rows = this.database.prepare('SELECT version FROM revision_mute_transactions WHERE revision_id=? AND principal_id=? AND (? IS NULL OR version<?) ORDER BY version DESC LIMIT ?').all(id, principalId, (query.before as number | undefined) ?? null, (query.before as number | undefined) ?? null, limit + 1) as { version: number }[];
      const transactions = rows.slice(0, limit).map(row => { const t = this.muteTransactionAt(id, principalId, row.version); this.operation(t.operationId); return t; });
      return { revisionId: id, principalId, muteVersion: mute.version, transactions, nextBefore: rows.length > limit ? transactions.at(-1)!.version : null };
    });
  }
  private pageSize(query: Record<string, unknown>): number { const limit = query.limit ?? 25; if (!natural(limit) || limit < 1 || limit > REVISION_SUBSCRIPTION_LIMITS.page || query.before !== undefined && (!natural(query.before) || query.before < 1)) throw new HttpError(400, 'Choose valid history pagination.'); return limit; }
  private checkNewPerson(id: string, before: Explicit): void { if (before.version !== 0) return; const row = this.database.prepare('SELECT count(*) AS count FROM revision_subscriptions WHERE revision_id=?').get(id) as { count: number }; if (row.count >= REVISION_SUBSCRIPTION_LIMITS.people) throw limited(); }
  private append(t: RevisionSubscriptionTransaction): void {
    const after = this.explicitFrom(t);
    this.database.prepare('INSERT INTO revision_subscription_transactions(id,revision_id,sequence,principal_id,version,operation_id,comment_id,data) VALUES(?,?,?,?,?,?,?,?)').run(t.id, t.revisionId, t.subscriptionVersion, t.principalId, t.version, t.operationId, t.commentId, JSON.stringify(t));
    this.database.prepare('INSERT INTO revision_subscriptions(revision_id,principal_id,version,state,data) VALUES(?,?,?,?,?) ON CONFLICT(revision_id,principal_id) DO UPDATE SET version=excluded.version,state=excluded.state,data=excluded.data').run(t.revisionId, t.principalId, t.version, t.after, JSON.stringify(after));
  }
  mutate(id: string, input: RevisionSubscriptionInput, actor: ActorAttribution, target?: RevisionAuthor, retryKeySha256: string | null = null): RevisionSubscriptionReceipt {
    const request = parse(input); if (retryKeySha256 !== null && (typeof retryKeySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(retryKeySha256))) throw new HttpError(400, 'Invalid internal retry identity.'); if (!isRevisionMetadataAttribution(actor)) throw new HttpError(400, 'Authenticated subscription attribution is required.');
    return scope(this.database, () => {
      const roles = this.roles(id), subscription = request.action === 'subscribe' || request.action === 'unsubscribe', epoch = (this.database.prepare("SELECT value FROM policy_meta WHERE name='epoch'").get() as { value: number }).value;
      if (!natural(epoch)) throw invalid(); if (epoch !== request.expectedAccessEpoch) throw new HttpError(409, 'Access changed. Reload before continuing.', 'ACCESS_EPOCH_CHANGED');
      if (request.expectedAuthorVersion > roles.authorVersion || request.expectedReviewerVersion > roles.reviewerVersion) throw conflict();
      const observed = this.rolesAt(id, request.expectedAuthorVersion, request.expectedReviewerVersion);
      if (subscription && (request.expectedAuthorVersion !== roles.authorVersion || roleDigest(observed) !== roleDigest(roles))) throw conflict();
      const now = new Date().toISOString(), operationId = randomUUID(), inputSha256 = revisionSubscriptionInputHash(request);
      let before: Explicit | RevisionMuteState, receipt: RevisionSubscriptionReceipt, publicVersion: number | null = null;
      if (request.action === 'subscribe' || request.action === 'unsubscribe') {
        before = this.explicit(id, request.principalId); publicVersion = this.publicVersion(id);
        if (before.version !== request.expectedSubscriptionVersion) throw conflict();
        if (request.principalId === actor.principalId && this.automatic(roles, actor.principalId).length) throw new HttpError(409, 'Automatic authors and reviewers follow through their role. Use personal mute instead.', 'REVISION_SUBSCRIPTION_AUTOMATIC');
        const person = request.principalId === actor.principalId ? { principalId: actor.principalId, displayName: actor.displayName } : target;
        if (!isRevisionAuthor(person) || person.principalId !== request.principalId) throw new HttpError(400, 'A verified workspace person is required.');
        const desired = request.action === 'subscribe' ? 'subscribed' : 'unsubscribed', changed = before.state !== desired;
        if (changed) { this.checkNewPerson(id, before); if (!Number.isSafeInteger(before.version + 1) || !Number.isSafeInteger(publicVersion + 1)) throw limited(); }
        const transaction: RevisionSubscriptionTransaction | null = changed ? { id: randomUUID(), revisionId: id, operationId, subscriptionVersion: publicVersion + 1, principalId: person.principalId, displayName: person.displayName, version: before.version + 1, before: before.state, after: desired, reason: 'explicit', commentId: null, authorVersion: roles.authorVersion, reviewerVersion: roles.reviewerVersion, attribution: { ...actor }, createdAt: now } : null;
        receipt = { revisionId: id, operationId, inputSha256, changed, accessEpoch: epoch, kind: 'subscription', subscriptionVersion: publicVersion + Number(changed), status: this.decorate(transaction ? this.explicitFrom(transaction) : before, roles), transaction };
      } else {
        if (!('expectedMuteVersion' in request)) throw invalid();
        if (request.principalId !== actor.principalId) throw new HttpError(403, 'Personal mute can only be changed for yourself.');
        before = this.mute(id, actor.principalId); if (before.version !== request.expectedMuteVersion) throw conflict();
        const desired = request.action === 'mute', changed = before.muted !== desired; if (changed && !Number.isSafeInteger(before.version + 1)) throw limited();
        const transaction: RevisionMuteTransaction | null = changed ? { id: randomUUID(), revisionId: id, operationId, principalId: actor.principalId, version: before.version + 1, before: before.muted, after: desired, attribution: { ...actor }, createdAt: now } : null;
        receipt = { revisionId: id, operationId, inputSha256, changed, accessEpoch: epoch, kind: 'mute', mute: transaction ? { ...before, version: transaction.version, muted: desired, updatedAt: now } : before, transaction };
      }
      const operation: RevisionSubscriptionOperation = { retryKeySha256, id: operationId, revisionId: id, input: request, inputSha256, attribution: { ...actor }, roles, before, subscriptionVersion: publicVersion, createdAt: now, receipt };
      this.database.prepare('INSERT INTO revision_subscription_operations(id,revision_id,principal_id,kind,input_sha256,data) VALUES(?,?,?,?,?,?)').run(operationId, id, actor.principalId, receipt.kind, inputSha256, JSON.stringify(operation));
      if (receipt.kind === 'subscription' && receipt.transaction) this.append(receipt.transaction);
      if (receipt.kind === 'mute' && receipt.transaction) {
        const t = receipt.transaction; this.database.prepare('INSERT INTO revision_mute_transactions(id,revision_id,principal_id,version,operation_id,data) VALUES(?,?,?,?,?,?)').run(t.id, id, actor.principalId, t.version, operationId, JSON.stringify(t));
        this.database.prepare('INSERT INTO revision_mutes(revision_id,principal_id,version,data) VALUES(?,?,?,?) ON CONFLICT(revision_id,principal_id) DO UPDATE SET version=excluded.version,data=excluded.data').run(id, actor.principalId, receipt.mute.version, JSON.stringify(receipt.mute));
      }
      return receipt;
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
  commented(id: string, commentId: string, actor?: ActorAttribution): void {
    if (!actor || !this.human(actor)) return;
    scope(this.database, () => {
      const roles = this.roles(id), before = this.explicit(id, actor.principalId); if (before.state !== null || this.automatic(roles, actor.principalId).length) return;
      const row = this.database.prepare("SELECT revision_id,json_extract(data,'$.createdAt') AS created_at,json_type(data,'$.attribution') AS actor_type,substr(json_extract(data,'$.attribution'),1,4097) AS actor FROM comments WHERE id=?").get(commentId) as Record<string, unknown> | undefined;
      if (!row || row.revision_id !== id || row.actor_type !== 'object' || typeof row.actor !== 'string' || !isDeepStrictEqual(decode(row.actor), actor) || typeof row.created_at !== 'string' || !Number.isFinite(Date.parse(row.created_at))) throw invalid();
      const capacity = this.database.prepare('SELECT count(*) AS count FROM revision_subscriptions WHERE revision_id=?').get(id) as { count: number };
      // An incidental preference must never prevent an otherwise valid comment.
      if (capacity.count >= REVISION_SUBSCRIPTION_LIMITS.people) return;
      const sequence = this.publicVersion(id) + 1; if (!Number.isSafeInteger(sequence)) throw limited();
      this.append({ id: randomUUID(), revisionId: id, operationId: null, subscriptionVersion: sequence, principalId: actor.principalId, displayName: actor.displayName, version: 1, before: null, after: 'subscribed', reason: 'comment', commentId, authorVersion: roles.authorVersion, reviewerVersion: roles.reviewerVersion, attribution: { ...actor }, createdAt: row.created_at });
    }, true);
  }
  operationRevisionId(id: string): string { if (!uuid(id)) throw invalid(); const row = this.database.prepare('SELECT revision_id FROM revision_subscription_operations WHERE id=?').get(id) as { revision_id: string } | undefined; if (!row || !isRevisionId(row.revision_id)) throw invalid(); return row.revision_id; }
  operation(id: string): RevisionSubscriptionOperation {
    return scope(this.database, () => {
      try {
        const revisionId = this.operationRevisionId(id), row = this.database.prepare('SELECT principal_id,kind,input_sha256,data FROM revision_subscription_operations WHERE id=?').get(id) as { principal_id: string; kind: string; input_sha256: string; data: string }, value = decode<RevisionSubscriptionOperation>(row.data);
        if (!value || Object.keys(value).sort().join(',') !== 'attribution,before,createdAt,id,input,inputSha256,receipt,retryKeySha256,revisionId,roles,subscriptionVersion' || value.retryKeySha256 !== null && (typeof value.retryKeySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.retryKeySha256)) || value.id !== id || value.revisionId !== revisionId || !isRevisionMetadataAttribution(value.attribution) || value.attribution.principalId !== row.principal_id || !isDeepStrictEqual(parse(value.input), value.input) || value.inputSha256 !== row.input_sha256 || value.inputSha256 !== revisionSubscriptionInputHash(value.input) || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || !validRevisionSubscriptionResult(value.receipt, revisionId, value.input, value.attribution.principalId) || value.receipt.kind !== row.kind || value.receipt.operationId !== id || value.receipt.inputSha256 !== value.inputSha256 || value.receipt.accessEpoch !== value.input.expectedAccessEpoch) throw invalid();
        const request = value.input, roles = value.roles;
        if (!roles || !isDeepStrictEqual(roles, this.rolesAt(revisionId, roles.authorVersion, roles.reviewerVersion)) || request.expectedAuthorVersion > roles.authorVersion || request.expectedReviewerVersion > roles.reviewerVersion) throw invalid();
        const observed = this.rolesAt(revisionId, request.expectedAuthorVersion, request.expectedReviewerVersion);
        if (request.action === 'subscribe' || request.action === 'unsubscribe') {
          const receipt = value.receipt; if (receipt.kind !== 'subscription' || !natural(value.subscriptionVersion) || value.subscriptionVersion > this.publicVersion(revisionId) || roles.authorVersion !== request.expectedAuthorVersion || roleDigest(observed) !== roleDigest(roles) || request.principalId === value.attribution.principalId && this.automatic(roles, request.principalId).length) throw invalid();
          const before = this.explicitAt(revisionId, request.principalId, request.expectedSubscriptionVersion), desired = request.action === 'subscribe' ? 'subscribed' : 'unsubscribed', changed = before.state !== desired;
          if (!isDeepStrictEqual(before, value.before) || receipt.changed !== changed || receipt.subscriptionVersion !== value.subscriptionVersion + Number(changed)) throw invalid();
          if (changed) {
            const t = this.transactionAt(revisionId, request.principalId, before.version + 1);
            if (t.operationId !== id || t.before !== before.state || t.after !== desired || t.authorVersion !== roles.authorVersion || t.reviewerVersion !== roles.reviewerVersion || !isDeepStrictEqual(t.attribution, value.attribution) || t.createdAt !== value.createdAt || !isDeepStrictEqual(t, receipt.transaction) || !isDeepStrictEqual(this.decorate(this.explicitFrom(t), roles), receipt.status)) throw invalid();
          } else if (!isDeepStrictEqual(this.decorate(before, roles), receipt.status) || this.database.prepare('SELECT 1 FROM revision_subscription_transactions WHERE operation_id=?').get(id)) throw invalid();
        } else {
          if (!('expectedMuteVersion' in request)) throw invalid();
          const receipt = value.receipt; if (receipt.kind !== 'mute' || value.subscriptionVersion !== null || request.principalId !== value.attribution.principalId) throw invalid();
          const before = this.muteAt(revisionId, request.principalId, request.expectedMuteVersion), desired = request.action === 'mute', changed = before.muted !== desired;
          if (!isDeepStrictEqual(before, value.before) || receipt.changed !== changed || !isDeepStrictEqual(receipt.mute, changed ? { ...before, version: before.version + 1, muted: desired, updatedAt: value.createdAt } : before)) throw invalid();
          if (changed) { const t = this.muteTransactionAt(revisionId, request.principalId, before.version + 1); if (t.operationId !== id || !isDeepStrictEqual(t.attribution, value.attribution) || t.createdAt !== value.createdAt || !isDeepStrictEqual(t, receipt.transaction)) throw invalid(); }
          else if (this.database.prepare('SELECT 1 FROM revision_mute_transactions WHERE operation_id=?').get(id)) throw invalid();
        }
        return value;
      } catch { throw invalid(); }
    });
  }
}
