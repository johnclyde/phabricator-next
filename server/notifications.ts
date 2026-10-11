import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import type { ActorAttribution } from '../shared/types.ts';
import type { RevisionAuthorHead } from '../shared/revision-authorship.ts';
import { isRevisionAuthorId } from '../shared/revision-authorship.ts';
import { isRevisionId } from '../shared/revision-dependencies.ts';
import { isRevisionMetadataAttribution } from '../shared/revision-metadata.ts';
import { NOTIFICATION_LIMITS, isNotificationEvent, isNotificationItem, notificationInput, notificationQuery, validNotificationResult } from '../shared/notifications.ts';
import type { NotificationEvent, NotificationInbox, NotificationInput, NotificationItem, NotificationKind, NotificationQuery, NotificationReceipt, NotificationSummary } from '../shared/notifications.ts';
import { HttpError } from './validation.ts';

export interface NotificationCause { revisionId: string; kind: NotificationKind; cause: { type: string; id: string }; attribution?: ActorAttribution; createdAt?: string; head?: RevisionAuthorHead }
export type NotificationPublisher = (cause: NotificationCause) => void;
export interface NotificationEligibility { eligible: (principalId: string) => boolean; canView: (revisionId: string, principalId: string) => boolean }
interface Options { revision: (id: string) => { title: string; kind: NotificationItem['revision']['kind']; head: RevisionAuthorHead; broadcast: boolean }; recipients: (id: string) => { recipients: string[]; muted: string[] } }
interface Delivery { id: string; sequence: number; event_id: string; principal_id: string; revision_id: string; read: number; version: number }
interface ReadState { read: boolean; version: number }
interface Effect { id: string; revisionId: string; before: ReadState; after: ReadState }
export interface NotificationOperation { id: string; principalId: string; input: NotificationInput; inputSha256: string; retryKeySha256: string | null; attribution: ActorAttribution; beforeReadVersion: number; afterReadVersion: number; affected: Effect[]; affectedRevisionIds: string[]; createdAt: string; receipt: NotificationReceipt }
interface Boundary { kind: 'horizon' | 'cursor'; principalId: string; epoch: number; high: number; filter?: string; before?: number; readVersion?: number }
const natural = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const invalid = () => new HttpError(409, 'Notification history cannot be verified.', 'NOTIFICATION_INVALID_RECEIPT');
const unavailable = () => new HttpError(404, 'Notification is unavailable.', 'NOTIFICATION_UNAVAILABLE');
const limited = () => new HttpError(422, 'Notifications exceed this operation’s complete query limit.', 'NOTIFICATION_LIMIT');
const changed = () => new HttpError(409, 'Notification reading or access changed. Reload the inbox.', 'NOTIFICATION_CHANGED');
const cursorError = () => new HttpError(400, 'The notification boundary is invalid for this inbox.', 'NOTIFICATION_CURSOR_INVALID');
function decode<T>(value: string): T { try { return JSON.parse(value) as T; } catch { throw invalid(); } }
function parse(value: unknown): NotificationInput { try { return notificationInput(value); } catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'Invalid notification action.'); } }
export function notificationInputHash(input: NotificationInput): string { return createHash('sha256').update(JSON.stringify(parse(input))).digest('hex'); }
let serial = 0;
function scope<T>(db: DatabaseSync, work: () => T, write = false): T { const name = `notifications_${++serial}`; db.exec(`SAVEPOINT ${name}`); try { if (write) db.exec('UPDATE notification_read_state SET version=version WHERE 0'); const result = work(); db.exec(`RELEASE ${name}`); return result; } catch (error) { db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; } }
export function initializeNotifications(db: DatabaseSync): void { initializeNotificationSchema(db, true); }
function initializeNotificationSchema(db: DatabaseSync, verifyExisting: boolean): void {
  scope(db, () => {
    if (verifyExisting) {
      const existing = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name GLOB 'notification_*' ORDER BY type,name").all();
      if (existing.length) {
        const canonical = new DatabaseSync(':memory:');
        try {
          initializeNotificationSchema(canonical, false);
          const expected = canonical.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name GLOB 'notification_*' ORDER BY type,name").all() as { name: string }[];
          for (const value of existing as { name: string }[]) if (!isDeepStrictEqual(value, expected.find(row => row.name === value.name))) throw new Error(`Unexpected ${value.name} schema; notification migration was not applied.`);
        } finally { canonical.close(); }
      }
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS notification_events(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL REFERENCES entities(id),cause_type TEXT NOT NULL,cause_id TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),UNIQUE(revision_id,cause_type,cause_id));
      CREATE TABLE IF NOT EXISTS notification_deliveries(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,event_id TEXT NOT NULL REFERENCES notification_events(id),principal_id TEXT NOT NULL,read INTEGER NOT NULL CHECK(read IN(0,1)),version INTEGER NOT NULL CHECK(version>=0),UNIQUE(event_id,principal_id));
      CREATE INDEX IF NOT EXISTS notification_deliveries_person ON notification_deliveries(principal_id,sequence);
      CREATE INDEX IF NOT EXISTS notification_deliveries_unread ON notification_deliveries(principal_id,read,sequence);
      CREATE TABLE IF NOT EXISTS notification_read_state(principal_id TEXT PRIMARY KEY,version INTEGER NOT NULL CHECK(version>0));
      CREATE TABLE IF NOT EXISTS notification_operations(id TEXT PRIMARY KEY,principal_id TEXT NOT NULL,input_sha256 TEXT NOT NULL,before_version INTEGER NOT NULL CHECK(before_version>=0),after_version INTEGER NOT NULL CHECK(after_version>=before_version AND after_version<=before_version+1),data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE UNIQUE INDEX IF NOT EXISTS notification_operations_generation ON notification_operations(principal_id,after_version) WHERE after_version>before_version;
      CREATE TABLE IF NOT EXISTS notification_read_changes(notification_id TEXT NOT NULL REFERENCES notification_deliveries(id),version INTEGER NOT NULL CHECK(version>0),operation_id TEXT NOT NULL REFERENCES notification_operations(id),before_read INTEGER NOT NULL CHECK(before_read IN(0,1)),after_read INTEGER NOT NULL CHECK(after_read IN(0,1)),PRIMARY KEY(notification_id,version),CHECK(before_read<>after_read));
      CREATE TABLE IF NOT EXISTS notification_cursor_secret(id INTEGER PRIMARY KEY CHECK(id=1),secret BLOB NOT NULL CHECK(length(secret)=32));
      CREATE TRIGGER IF NOT EXISTS notification_delivery_identity BEFORE UPDATE OF sequence,id,event_id,principal_id ON notification_deliveries BEGIN SELECT RAISE(ABORT,'Notification identities are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS notification_delivery_no_delete BEFORE DELETE ON notification_deliveries BEGIN SELECT RAISE(ABORT,'Notification deliveries are durable'); END;
    `);
    for (const table of ['notification_events', 'notification_operations', 'notification_read_changes', 'notification_cursor_secret']) db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Notification evidence is immutable'); END; CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Notification evidence is immutable'); END;`);
    for (const [table, columns] of Object.entries({ notification_events: ['id', 'revision_id', 'cause_type', 'cause_id', 'data'], notification_deliveries: ['sequence', 'id', 'event_id', 'principal_id', 'read', 'version'], notification_read_state: ['principal_id', 'version'], notification_operations: ['id', 'principal_id', 'input_sha256', 'before_version', 'after_version', 'data'], notification_read_changes: ['notification_id', 'version', 'operation_id', 'before_read', 'after_read'], notification_cursor_secret: ['id', 'secret'] })) if (!isDeepStrictEqual((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name), columns)) throw new Error(`Unexpected ${table} schema; notification migration was not applied.`);
    db.prepare('INSERT OR IGNORE INTO notification_cursor_secret(id,secret) VALUES(1,?)').run(randomBytes(32));
  });
}

/** Logical causes are queued only within a synchronous writer scope. The outer
 * Store scope flushes after final creation policy configuration, before commit. */
export class NotificationStore {
  private eligibility: NotificationEligibility | null = null;
  private queues: NotificationCause[][] = [];
  constructor(private readonly database: DatabaseSync, private readonly options: Options) {}
  configure(eligibility: NotificationEligibility): void { if (this.eligibility) throw new Error('Notification eligibility is already configured.'); this.eligibility = eligibility; }
  batch<T>(work: () => T): T { const queue: NotificationCause[] = []; this.queues.push(queue); try { const result = work(); this.queues.pop(); const parent = this.queues.at(-1); if (parent) parent.push(...queue); else for (const cause of queue) this.publish(cause); return result; } catch (error) { if (this.queues.at(-1) === queue) this.queues.pop(); throw error; } }
  flush(): void { const queue = this.queues.at(-1); if (queue) for (const cause of queue.splice(0)) this.publish(cause); }
  emit: NotificationPublisher = cause => { if (!this.eligibility) return; const revision = this.options.revision(cause.revisionId); if (!revision.broadcast) return; const captured = { ...cause, head: cause.head ?? revision.head, createdAt: cause.createdAt ?? new Date().toISOString() }; const queue = this.queues.at(-1); if (queue) queue.push(captured); else this.publish(captured); };
  /** Suppress a nested source event when a suggestion supplies its own cause. */
  discard(causeType: string, causeId: string): void { for (const queue of this.queues) for (let i = queue.length - 1; i >= 0; i--) if (queue[i]!.cause.type === causeType && queue[i]!.cause.id === causeId) queue.splice(i, 1); }
  private epoch(): number { const epoch = (this.database.prepare("SELECT value FROM policy_meta WHERE name='epoch'").get() as { value: number }).value; if (!natural(epoch)) throw invalid(); return epoch; }
  private person(id: string): void { if (!isRevisionAuthorId(id) || !this.eligibility?.eligible(id)) throw unavailable(); }
  private visible(id: string, principalId: string): boolean { return !!this.eligibility?.eligible(principalId) && this.eligibility.canView(id, principalId); }
  private publish(cause: NotificationCause): void {
    if (!this.eligibility) return;
    const revision = this.options.revision(cause.revisionId); if (!revision.broadcast) return;
    if (this.database.prepare('SELECT 1 FROM notification_events WHERE revision_id=? AND cause_type=? AND cause_id=?').get(cause.revisionId, cause.cause.type, cause.cause.id)) return;
    const event: NotificationEvent = { id: randomUUID(), revisionId: cause.revisionId, kind: cause.kind, cause: { ...cause.cause }, actor: cause.attribution ? { principalId: cause.attribution.principalId, displayName: cause.attribution.displayName } : null, createdAt: cause.createdAt ?? new Date().toISOString(), head: cause.head ?? revision.head };
    if (!isNotificationEvent(event)) throw invalid();
    const preferences = this.options.recipients(cause.revisionId), muted = new Set(preferences.muted), candidates = [...new Set(preferences.recipients)]; if (candidates.length > NOTIFICATION_LIMITS.recipients) throw limited();
    const recipients = candidates.filter(id => id !== event.actor?.principalId && !muted.has(id) && this.visible(cause.revisionId, id));
    this.database.prepare('INSERT INTO notification_events(id,revision_id,cause_type,cause_id,data) VALUES(?,?,?,?,?)').run(event.id, event.revisionId, event.cause.type, event.cause.id, JSON.stringify(event));
    for (const principalId of recipients) this.database.prepare('INSERT INTO notification_deliveries(id,event_id,principal_id,read,version) VALUES(?,?,?,0,0)').run(randomUUID(), event.id, principalId);
  }
  private secret(): Buffer { const row = this.database.prepare('SELECT secret FROM notification_cursor_secret WHERE id=1').get() as { secret: Uint8Array } | undefined; if (!row || row.secret.byteLength !== 32) throw invalid(); return Buffer.from(row.secret); }
  private seal(boundary: Boundary): string { const value = Buffer.from(JSON.stringify(boundary)), payload = randomBytes(512); if (value.length > 510) throw invalid(); payload.writeUInt16BE(value.length); value.copy(payload, 2); const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.secret(), iv); cipher.setAAD(Buffer.from('phabricator.notifications.v1')); const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url'); }
  private unseal(value: string, kind: Boundary['kind'], principalId: string, epoch: number): Boundary {
    try { const raw = Buffer.from(value, 'base64url'); if (raw.length !== 540 || raw.toString('base64url') !== value) throw cursorError(); const decipher = createDecipheriv('aes-256-gcm', this.secret(), raw.subarray(0, 12)); decipher.setAAD(Buffer.from('phabricator.notifications.v1')); decipher.setAuthTag(raw.subarray(12, 28)); const payload = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]), length = payload.readUInt16BE(); if (length > 510) throw cursorError(); const b = JSON.parse(payload.subarray(2, length + 2).toString('utf8')) as Boundary; if (b.kind !== kind || b.principalId !== principalId || !natural(b.high) || !natural(b.epoch) || kind === 'cursor' && (!natural(b.before) || !natural(b.readVersion) || !['all', 'read', 'unread'].includes(b.filter!))) throw cursorError(); if (b.epoch !== epoch) throw changed(); return b; } catch (error) { if (error instanceof HttpError) throw error; throw cursorError(); }
  }
  private high(principalId: string): number { return (this.database.prepare('SELECT coalesce(max(sequence),0) AS high FROM notification_deliveries WHERE principal_id=?').get(principalId) as { high: number }).high; }
  private generation(principalId: string): number { const row = this.database.prepare('SELECT version FROM notification_read_state WHERE principal_id=?').get(principalId) as { version: number } | undefined; const result = row?.version ?? 0, last = (this.database.prepare('SELECT coalesce(max(after_version),0) AS version FROM notification_operations WHERE principal_id=?').get(principalId) as { version: number }).version; if (!natural(result) || result !== last) throw invalid(); return result; }
  private unread(principalId: string, view: Map<string, boolean>): number {
    const rows = this.database.prepare('SELECT e.revision_id,count(*) AS count FROM notification_deliveries d JOIN notification_events e ON e.id=d.event_id WHERE d.principal_id=? AND d.read=0 GROUP BY e.revision_id LIMIT ?').all(principalId, NOTIFICATION_LIMITS.unreadRevisions + 1) as { revision_id: string; count: number }[];
    if (rows.length > NOTIFICATION_LIMITS.unreadRevisions) throw limited(); let count = 0;
    for (const row of rows) { if (!view.has(row.revision_id)) view.set(row.revision_id, this.visible(row.revision_id, principalId)); if (view.get(row.revision_id)) count += row.count; }
    if (!natural(count)) throw limited(); return count;
  }
  summary(principalId: string, accessEpoch: number): NotificationSummary { return scope(this.database, () => { this.person(principalId); if (accessEpoch !== this.epoch()) throw changed(); return { principalId, horizon: this.seal({ kind: 'horizon', principalId, epoch: accessEpoch, high: this.high(principalId) }), unreadCount: this.unread(principalId, new Map()), readVersion: this.generation(principalId), accessEpoch }; }); }
  private delivery(id: string, principalId: string): Delivery { if (!uuid(id)) throw unavailable(); const row = this.database.prepare('SELECT d.*,e.revision_id FROM notification_deliveries d JOIN notification_events e ON e.id=d.event_id WHERE d.id=? AND d.principal_id=?').get(id, principalId) as unknown as Delivery | undefined; if (!row || !isRevisionId(row.revision_id)) throw unavailable(); return row; }
  notificationRevisionId(principalId: string, id: string): string { this.person(principalId); return this.delivery(id, principalId).revision_id; }
  private readAt(row: Delivery, version = row.version): ReadState {
    if (!natural(version) || version > row.version) throw invalid(); if (version === 0) return { read: false, version: 0 };
    const state = this.database.prepare('SELECT before_read,after_read FROM notification_read_changes WHERE notification_id=? AND version=?').get(row.id, version) as { before_read: number; after_read: number } | undefined;
    if (!state || ![0, 1].includes(state.before_read) || state.after_read !== 1 - state.before_read) throw invalid();
    if (version === 1 ? state.before_read !== 0 : state.before_read !== (this.database.prepare('SELECT after_read FROM notification_read_changes WHERE notification_id=? AND version=?').get(row.id, version - 1) as { after_read?: number } | undefined)?.after_read) throw invalid();
    return { read: !!state.after_read, version };
  }
  private readCurrent(row: Delivery): ReadState { const state = this.readAt(row); if (Number(state.read) !== row.read) throw invalid(); const latest = (this.database.prepare('SELECT coalesce(max(version),0) AS version FROM notification_read_changes WHERE notification_id=?').get(row.id) as { version: number }).version; if (latest !== row.version) throw invalid(); return state; }
  private item(row: Delivery): NotificationItem { const stored = this.database.prepare('SELECT data,cause_type,cause_id FROM notification_events WHERE id=?').get(row.event_id) as { data: string; cause_type: string; cause_id: string }; const event = decode<NotificationEvent>(stored.data); if (!isNotificationEvent(event) || event.id !== row.event_id || event.revisionId !== row.revision_id || event.cause.type !== stored.cause_type || event.cause.id !== stored.cause_id) throw invalid(); const revision = this.options.revision(row.revision_id), result: NotificationItem = { id: row.id, event, revision: { id: row.revision_id, title: revision.title, kind: revision.kind }, ...this.readCurrent(row) }; if (!isNotificationItem(result)) throw invalid(); return result; }
  list(principalId: string, input: NotificationQuery = {}, accessEpoch: number): NotificationInbox {
    return scope(this.database, () => {
      this.person(principalId); if (accessEpoch !== this.epoch()) throw changed(); let query: ReturnType<typeof notificationQuery>; try { query = notificationQuery(input); } catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'Invalid inbox query.'); }
      const readVersion = this.generation(principalId), b = query.before ? this.unseal(query.before, 'cursor', principalId, accessEpoch) : null;
      if (b && (b.filter !== query.filter || b.readVersion !== readVersion)) throw changed(); const high = b?.high ?? this.high(principalId); let before = b?.before ?? high + 1, scanned = 0;
      const view = new Map<string, boolean>(), items: NotificationItem[] = []; let more = false;
      const condition = query.filter === 'all' ? '' : ` AND d.read=${query.filter === 'read' ? 1 : 0}`;
      while (scanned < NOTIFICATION_LIMITS.scan && items.length < query.limit) {
        const rows = this.database.prepare(`SELECT d.*,e.revision_id FROM notification_deliveries d JOIN notification_events e ON e.id=d.event_id WHERE d.principal_id=? AND d.sequence<=? AND d.sequence<?${condition} ORDER BY d.sequence DESC LIMIT ?`).all(principalId, high, before, Math.min(100, NOTIFICATION_LIMITS.scan - scanned)) as unknown as Delivery[];
        if (!rows.length) break;
        for (const row of rows) { scanned++; before = row.sequence; if (!view.has(row.revision_id)) view.set(row.revision_id, this.visible(row.revision_id, principalId)); if (view.get(row.revision_id)) items.push(this.item(row)); if (items.length === query.limit) break; }
        if (rows.length < 100 && items.length < query.limit) break;
      }
      more = !!this.database.prepare(`SELECT 1 FROM notification_deliveries d WHERE d.principal_id=? AND d.sequence<=? AND d.sequence<?${condition} LIMIT 1`).get(principalId, high, before);
      return { principalId, items, nextBefore: more ? this.seal({ kind: 'cursor', principalId, epoch: accessEpoch, high, before, filter: query.filter, readVersion }) : null, horizon: this.seal({ kind: 'horizon', principalId, epoch: accessEpoch, high }), unreadCount: this.unread(principalId, view), readVersion, accessEpoch };
    });
  }
  mutate(principalId: string, input: NotificationInput, actor: ActorAttribution, retryKeySha256: string | null = null): NotificationReceipt {
    const request = parse(input); if (!isRevisionMetadataAttribution(actor) || actor.principalId !== principalId || retryKeySha256 !== null && !digest(retryKeySha256)) throw new HttpError(400, 'Authenticated notification attribution is required.');
    return scope(this.database, () => {
      this.person(principalId); const epoch = this.epoch(); if (request.expectedAccessEpoch !== epoch) throw changed(); const rows: Delivery[] = [], view = new Map<string, boolean>();
      if (request.action === 'read' || request.action === 'unread') { const row = this.delivery(request.notificationId, principalId); if (!this.visible(row.revision_id, principalId)) throw unavailable(); if (this.readCurrent(row).version !== request.expectedVersion) throw changed(); rows.push(row); }
      else {
        if (request.action === 'read_object' && !this.visible(request.revisionId, principalId)) throw unavailable();
        const boundary = this.unseal(('horizon' in request ? request.horizon : ''), 'horizon', principalId, epoch);
        const candidates = this.database.prepare(`SELECT d.*,e.revision_id FROM notification_deliveries d JOIN notification_events e ON e.id=d.event_id WHERE d.principal_id=? AND d.sequence<=? AND d.read=0${request.action === 'read_object' ? ' AND e.revision_id=?' : ''} ORDER BY d.sequence LIMIT ?`).all(principalId, boundary.high, ...(request.action === 'read_object' ? [request.revisionId] : []), NOTIFICATION_LIMITS.readRows + 1) as unknown as Delivery[];
        if (candidates.length > NOTIFICATION_LIMITS.readRows) throw limited();
        for (const row of candidates) { if (!view.has(row.revision_id)) view.set(row.revision_id, this.visible(row.revision_id, principalId)); if (view.get(row.revision_id)) rows.push(row); }
      }
      const affected = rows.map(row => { const before = this.readCurrent(row), desired = request.action !== 'unread'; return { id: row.id, revisionId: row.revision_id, before, after: { read: desired, version: before.version + Number(before.read !== desired) } }; });
      const changedValue = affected.some(row => row.before.read !== row.after.read), beforeReadVersion = this.generation(principalId), afterReadVersion = beforeReadVersion + Number(changedValue); if (!natural(afterReadVersion) || affected.some(row => !natural(row.after.version))) throw limited();
      const operationId = randomUUID(), inputSha256 = notificationInputHash(request), receipt: NotificationReceipt = { operationId, inputSha256, changed: changedValue, accessEpoch: epoch };
      const operation: NotificationOperation = { id: operationId, principalId, input: request, inputSha256, retryKeySha256, attribution: { ...actor }, beforeReadVersion, afterReadVersion, affected, affectedRevisionIds: [...new Set([...affected.map(row => row.revisionId), ...(request.action === 'read_object' ? [request.revisionId] : [])])].sort(), createdAt: new Date().toISOString(), receipt };
      this.database.prepare('INSERT INTO notification_operations(id,principal_id,input_sha256,before_version,after_version,data) VALUES(?,?,?,?,?,?)').run(operationId, principalId, inputSha256, beforeReadVersion, afterReadVersion, JSON.stringify(operation));
      for (const row of affected) if (row.before.read !== row.after.read) { this.database.prepare('INSERT INTO notification_read_changes(notification_id,version,operation_id,before_read,after_read) VALUES(?,?,?,?,?)').run(row.id, row.after.version, operationId, Number(row.before.read), Number(row.after.read)); this.database.prepare('UPDATE notification_deliveries SET read=?,version=? WHERE id=?').run(Number(row.after.read), row.after.version, row.id); }
      if (changedValue) this.database.prepare('INSERT INTO notification_read_state(principal_id,version) VALUES(?,?) ON CONFLICT(principal_id) DO UPDATE SET version=excluded.version').run(principalId, afterReadVersion);
      return receipt;
    }, true);
  }
  operationPrincipalId(id: string): string { if (!uuid(id)) throw invalid(); const row = this.database.prepare('SELECT principal_id FROM notification_operations WHERE id=?').get(id) as { principal_id: string } | undefined; if (!row || !isRevisionAuthorId(row.principal_id)) throw invalid(); return row.principal_id; }
  operation(id: string): NotificationOperation {
    return scope(this.database, () => {
      const principalId = this.operationPrincipalId(id), row = this.database.prepare('SELECT rowid,input_sha256,before_version,after_version,data FROM notification_operations WHERE id=?').get(id) as { rowid: number; input_sha256: string; before_version: number; after_version: number; data: string }; const op = decode<NotificationOperation>(row.data);
      try {
        const input = parse(op.input); if (!op || Object.keys(op).sort().join(',') !== ['id','principalId','input','inputSha256','retryKeySha256','attribution','beforeReadVersion','afterReadVersion','affected','affectedRevisionIds','createdAt','receipt'].sort().join(',') || op.beforeReadVersion !== row.before_version || op.afterReadVersion !== row.after_version || op.beforeReadVersion !== (this.database.prepare('SELECT coalesce(max(after_version),0) AS version FROM notification_operations WHERE principal_id=? AND rowid<?').get(principalId,row.rowid) as {version:number}).version || op.id !== id || op.principalId !== principalId || !isDeepStrictEqual(input, op.input) || op.inputSha256 !== row.input_sha256 || op.inputSha256 !== notificationInputHash(input) || op.retryKeySha256 !== null && !digest(op.retryKeySha256) || !isRevisionMetadataAttribution(op.attribution) || op.attribution.principalId !== principalId || !Number.isFinite(Date.parse(op.createdAt)) || !Array.isArray(op.affected) || op.affected.length > NOTIFICATION_LIMITS.readRows || new Set(op.affected.map(e => e.id)).size !== op.affected.length || !natural(op.beforeReadVersion) || !natural(op.afterReadVersion)) throw invalid();
        let didChange = false; const expectedChanges = [];
        for (const effect of op.affected) {
          if (!effect || Object.keys(effect).sort().join(',') !== 'after,before,id,revisionId' || !effect.before || !effect.after || Object.keys(effect.before).sort().join(',') !== 'read,version' || Object.keys(effect.after).sort().join(',') !== 'read,version') throw invalid();
          const delivery = this.delivery(effect.id, principalId), before = this.readAt(delivery, effect.before.version), desired = input.action !== 'unread', after = { read: desired, version: before.version + Number(before.read !== desired) };
          if (effect.revisionId !== delivery.revision_id || !isDeepStrictEqual(before, effect.before) || !isDeepStrictEqual(after, effect.after) || input.action === 'read_object' && effect.revisionId !== input.revisionId) throw invalid();
          if (before.read !== desired) { didChange = true; expectedChanges.push({ notification_id: effect.id, version: after.version, before_read: Number(before.read), after_read: Number(desired) }); }
        }
        if (input.action === 'read' || input.action === 'unread') { if (op.affected.length !== 1 || op.affected[0]!.id !== input.notificationId || op.affected[0]!.before.version !== input.expectedVersion) throw invalid(); }
        else { const horizon = this.unseal(('horizon' in input ? input.horizon : ''), 'horizon', principalId, input.expectedAccessEpoch); if (op.affected.some(effect => effect.before.read || this.delivery(effect.id, principalId).sequence > horizon.high)) throw invalid(); }
        const changes = this.database.prepare('SELECT notification_id,version,before_read,after_read FROM notification_read_changes WHERE operation_id=? ORDER BY notification_id').all(id);
        expectedChanges.sort((a, b) => a.notification_id.localeCompare(b.notification_id));
        if (!isDeepStrictEqual(JSON.parse(JSON.stringify(changes)), expectedChanges) || op.afterReadVersion !== op.beforeReadVersion + Number(didChange) || op.afterReadVersion > this.generation(principalId) || !isDeepStrictEqual(op.affectedRevisionIds, [...new Set([...op.affected.map(e => e.revisionId), ...(input.action === 'read_object' ? [input.revisionId] : [])])].sort()) || !validNotificationResult(op.receipt) || !isDeepStrictEqual(op.receipt, { operationId: id, inputSha256: op.inputSha256, changed: didChange, accessEpoch: input.expectedAccessEpoch })) throw invalid();
        return op;
      } catch (error) { if (error instanceof HttpError && error.code === 'NOTIFICATION_INVALID_RECEIPT') throw error; throw invalid(); }
    });
  }
}
