import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import type { AuthContext } from '../shared/auth.ts';
import type { CalendarData } from '../shared/calendar.ts';
import { calendarParticipants } from '../shared/calendar.ts';
import type { ConpherenceData } from '../shared/conpherence.ts';
import type { LegalpadData } from '../shared/legalpad.ts';
import type { PhameBlogData, PhamePostData } from '../shared/phame.ts';
import type { SlowvoteData } from '../shared/slowvote.ts';
import { slowvoteResultsVisible } from '../shared/slowvote.ts';
import { suiteNotificationApp, type NotificationEvent, type NotificationKind, type SuiteNotificationContext } from '../shared/notifications.ts';
import type { SuiteDetail, SuiteRecord } from '../shared/suite.ts';
import { suiteNotificationPreferenceInput, type SuiteNotificationPreference, type SuiteNotificationPreferenceInput, type SuiteFollowing } from '../shared/suite-notifications.ts';
import type { Store, MutationResponse } from './store.ts';
import { HttpError } from './validation.ts';

const definitions = [
  ['table', 'suite_notification_preferences', 'CREATE TABLE suite_notification_preferences(object_id TEXT NOT NULL REFERENCES suite_records(id),principal_id TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0),following TEXT NOT NULL CHECK(following IN(\'default\',\'following\',\'ignored\')),muted INTEGER NOT NULL CHECK(muted IN(0,1)),email INTEGER NOT NULL CHECK(email IN(0,1)),PRIMARY KEY(object_id,principal_id))'],
  ['table', 'suite_notification_history', 'CREATE TABLE suite_notification_history(object_id TEXT NOT NULL REFERENCES suite_records(id),principal_id TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0),data TEXT NOT NULL CHECK(json_valid(data)),PRIMARY KEY(object_id,principal_id,version))'],
  ['trigger', 'suite_notification_preferences_identity', "CREATE TRIGGER suite_notification_preferences_identity BEFORE UPDATE OF object_id,principal_id ON suite_notification_preferences BEGIN SELECT RAISE(ABORT,'Notification preference identity is immutable'); END"],
  ['trigger', 'suite_notification_preferences_no_delete', "CREATE TRIGGER suite_notification_preferences_no_delete BEFORE DELETE ON suite_notification_preferences BEGIN SELECT RAISE(ABORT,'Notification preferences are durable'); END"],
  ['trigger', 'suite_notification_history_no_update', "CREATE TRIGGER suite_notification_history_no_update BEFORE UPDATE ON suite_notification_history BEGIN SELECT RAISE(ABORT,'Notification preference history is immutable'); END"],
  ['trigger', 'suite_notification_history_no_delete', "CREATE TRIGGER suite_notification_history_no_delete BEFORE DELETE ON suite_notification_history BEGIN SELECT RAISE(ABORT,'Notification preference history is immutable'); END"],
] as const;
export function initializeSuiteNotifications(db: DatabaseSync): void {
  db.exec('SAVEPOINT suite_notifications_schema');
  try {
    for (const [type, name, sql] of definitions) {
      const row = db.prepare('SELECT type,sql FROM sqlite_schema WHERE name=?').get(name) as { type: string; sql: string } | undefined;
      if (row && (row.type !== type || row.sql !== sql)) throw new Error(`Unexpected ${name} schema; notification preferences migration was not applied.`);
      if (!row) db.exec(sql);
    }
    db.exec('RELEASE suite_notifications_schema');
  } catch (error) { db.exec('ROLLBACK TO suite_notifications_schema; RELEASE suite_notifications_schema'); throw error; }
}
interface Projection { projectForPrincipal(id: string, principalId: string): SuiteDetail; rawRecord(id: string): SuiteRecord; canView(id: string, principalId: string): boolean }
interface PreferenceRow { version: number; following: SuiteFollowing; muted: number; email: number }
interface PreferenceEvidence { objectId: string; principalId: string; version: number; input: SuiteNotificationPreferenceInput; actor: Pick<AuthContext, 'principalId' | 'displayName' | 'credentialId'>; createdAt: string; deliveryHigh: number }
const unavailable = () => new HttpError(404, 'Notification preferences are unavailable.', 'NOTIFICATION_UNAVAILABLE');
const invalid = () => new HttpError(409, 'Notification preferences could not be verified.', 'NOTIFICATION_INVALID_RECEIPT');
const noop = (record: SuiteRecord, before: SuiteRecord | null): boolean => !!before && isDeepStrictEqual([record.title, record.access, record.data], [before.title, before.access, before.data]);
/** A private personal preference is not an object edit. It has its own version
 * and immutable evidence, and never adds a public history entry. */
export class SuiteNotifications {
  constructor(private readonly store: Store, private readonly source: Projection, private readonly revalidate: (actor: AuthContext) => void) {}
  private epoch(): number { return Number(this.store.database.prepare("SELECT value FROM policy_meta WHERE name='epoch'").get()!.value); }
  private current(id: string, principalId: string): SuiteDetail { if (!suiteNotificationApp(id)) throw unavailable(); return this.source.projectForPrincipal(id, principalId); }
  private stored(id: string, principalId: string): PreferenceRow {
    const row = this.store.database.prepare('SELECT version,following,muted,email FROM suite_notification_preferences WHERE object_id=? AND principal_id=?').get(id, principalId) as unknown as PreferenceRow | undefined;
    const latest = this.store.database.prepare('SELECT version,data FROM suite_notification_history WHERE object_id=? AND principal_id=? ORDER BY version DESC LIMIT 1').get(id, principalId) as { version: number; data: string } | undefined;
    if (!row) { if (latest) throw invalid(); return { version: 0, following: 'default', muted: 0, email: 0 }; }
    try {
      if (!latest || latest.version !== row.version) throw invalid();
      const evidence = JSON.parse(latest.data) as PreferenceEvidence, input = suiteNotificationPreferenceInput(evidence.input);
      if (evidence.objectId !== id || evidence.principalId !== principalId || evidence.actor.principalId !== principalId || evidence.version !== row.version || input.expectedPreferenceVersion !== row.version - 1 || input.following !== row.following || Number(input.muted) !== row.muted || Number(input.email) !== row.email) throw invalid();
    } catch { throw invalid(); }
    return row;
  }
  private related(record: SuiteRecord): SuiteRecord[] {
    const ids: string[] = [];
    if (record.app === 'phame' && record.kind === 'post') ids.push(String(record.data.blogId));
    if (record.app === 'almanac' && record.kind === 'interface') ids.push(String(record.data.deviceId));
    if (record.app === 'almanac' && record.kind === 'binding') ids.push(String(record.data.serviceId));
    return [record, ...ids.map(id => this.source.rawRecord(id))];
  }
  private defaults(record: SuiteRecord): Set<string> {
    const ids = new Set<string>();
    for (const item of this.related(record)) {
      ids.add(item.ownerId); item.access.editorIds.forEach(id => ids.add(id));
      if (item.app === 'conpherence') (item.data as ConpherenceData).participants.forEach(person => ids.add(person.id));
      if (item.app === 'calendar') { const data = item.data as CalendarData; ids.add(data.hostId); calendarParticipants(data).forEach(person => ids.add(person.id)); }
      if (item.app === 'slowvote') { const data = item.data as unknown as SlowvoteData; data.ballots.forEach(ballot => ids.add(ballot.actorId)); data.comments.forEach(comment => ids.add(comment.actorId)); }
      if (item.app === 'phame' && item.kind === 'blog') { const data = item.data as unknown as PhameBlogData; [...data.authorIds, ...data.editorIds].forEach(id => ids.add(id)); }
      if (item.app === 'legalpad') { const data = item.data as LegalpadData; data.requiredSignerIds.forEach(id => ids.add(id)); data.signatures.forEach(signature => ids.add(signature.signerId)); }
    }
    return ids;
  }
  private effective(record: SuiteRecord, principalId: string, row: PreferenceRow): boolean {
    if (row.following !== 'default') return row.following === 'following';
    if (this.defaults(record).has(principalId)) return true;
    return this.related(record).slice(1).some(parent => { const inherited = this.stored(parent.id, principalId); return inherited.following === 'following' && !inherited.muted; });
  }
  preference(id: string, principalId: string): SuiteNotificationPreference {
    const current = this.current(id, principalId), record = this.source.rawRecord(id), row = this.stored(id, principalId);
    return { objectId: id, app: current.record.app, principalId, version: row.version, following: row.following, muted: !!row.muted, email: !!row.email, effectiveFollowing: this.effective(record, principalId, row), accessEpoch: this.epoch() };
  }
  mutatePreference(id: string, raw: unknown, key: string | undefined, actor: AuthContext): MutationResponse {
    let input: SuiteNotificationPreferenceInput;
    try { input = suiteNotificationPreferenceInput(raw); } catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'Choose notification preferences.'); }
    if (!key || key.length > 200) throw new HttpError(400, 'Changes require a bounded Idempotency-Key.');
    const fingerprint = createHash('sha256').update(JSON.stringify([id, input])).digest('hex');
    return this.store.mutate(`suite-notifications:${actor.workspaceId}:${actor.principalId}:${key}`, fingerprint, () => {
      const current = this.preference(id, actor.principalId);
      if (input.expectedPreferenceVersion !== current.version || input.expectedAccessEpoch !== current.accessEpoch) throw new HttpError(409, 'Your preferences or access changed. Refresh before submitting.', 'NOTIFICATION_CHANGED');
      const version = current.version + 1;
      this.store.database.prepare('INSERT INTO suite_notification_history(object_id,principal_id,version,data) VALUES(?,?,?,?)').run(id, actor.principalId, version, JSON.stringify({ objectId: id, principalId: actor.principalId, version, input, actor: { principalId: actor.principalId, displayName: actor.displayName, credentialId: actor.credentialId }, createdAt: new Date().toISOString(), deliveryHigh: Number(this.store.database.prepare('SELECT coalesce(max(sequence),0) AS high FROM notification_deliveries').get()!.high) } satisfies PreferenceEvidence));
      this.store.database.prepare('INSERT INTO suite_notification_preferences(object_id,principal_id,version,following,muted,email) VALUES(?,?,?,?,?,?) ON CONFLICT(object_id,principal_id) DO UPDATE SET version=excluded.version,following=excluded.following,muted=excluded.muted,email=excluded.email').run(id, actor.principalId, version, input.following, Number(input.muted), Number(input.email));
      return { status: 200, body: { objectId: id, principalId: actor.principalId, version } };
    }, () => { this.revalidate(actor); if (!actor.scopes.includes('write')) throw new HttpError(403, 'Write access is required.'); this.current(id, actor.principalId); }, (response, replayed) => {
      const receipt = response.body as { objectId: string; principalId: string; version: number };
      const evidence = this.store.database.prepare('SELECT data FROM suite_notification_history WHERE object_id=? AND principal_id=? AND version=?').get(id, actor.principalId, receipt.version) as { data: string } | undefined;
      if (!evidence || receipt.objectId !== id || receipt.principalId !== actor.principalId || !isDeepStrictEqual(JSON.parse(evidence.data).input, input)) throw invalid();
      return { status: 200, body: { ...this.preference(id, actor.principalId), receipt: { version: receipt.version, replayed } } };
    });
  }
  /** Opting in applies only to future deliveries. Re-enabling email begins a
   * new boundary; it cannot revive messages from an earlier subscription. */
  emailEligible(id: string, principalId: string, deliverySequence: number): boolean {
    const current = this.preference(id, principalId);
    if (!current.email || current.muted || !current.effectiveFollowing || !Number.isSafeInteger(deliverySequence)) return false;
    const boundary = this.store.database.prepare(`SELECT data FROM suite_notification_history WHERE object_id=? AND principal_id=?
      AND version>(SELECT coalesce(max(version),0) FROM suite_notification_history WHERE object_id=? AND principal_id=? AND json_extract(data,'$.input.email')=0)
      ORDER BY version LIMIT 1`).get(id, principalId, id, principalId) as { data: string } | undefined;
    if (!boundary) throw invalid();
    const evidence = JSON.parse(boundary.data) as PreferenceEvidence, high = evidence.deliveryHigh;
    if (!evidence.input.email || !Number.isSafeInteger(high) || high < 0) throw invalid();
    return deliverySequence > high;
  }
  target = (id: string): { title: string; context: SuiteNotificationContext } => { const record = this.source.rawRecord(id); return { title: record.title, context: { kind: 'suite', app: record.app, version: record.version, action: 'update', audience: 'all' } }; };
  recipients = (id: string): { recipients: string[]; muted: string[] } => {
    const record = this.source.rawRecord(id), candidates = this.defaults(record);
    for (const item of this.related(record)) for (const row of this.store.database.prepare('SELECT principal_id FROM suite_notification_preferences WHERE object_id=? AND following=\'following\'').all(item.id)) candidates.add(String(row.principal_id));
    const recipients: string[] = [], muted: string[] = [];
    for (const principalId of candidates) { const row = this.stored(id, principalId); if (this.effective(record, principalId, row)) recipients.push(principalId); if (row.muted) muted.push(principalId); }
    return { recipients, muted };
  };
  canViewEvent = (event: NotificationEvent, principalId: string): boolean => {
    if (event.context.kind !== 'suite' || !this.source.canView(event.objectId, principalId)) return false;
    const current = this.current(event.objectId, principalId), record = this.source.rawRecord(event.objectId), audience = event.context.audience;
    if (audience === 'all') return true;
    if (audience === 'editors') return current.canEdit;
    if (audience === 'actor-or-editors') return current.canEdit || event.actor?.principalId === principalId;
    return record.app === 'slowvote' && slowvoteResultsVisible(record.data as unknown as SlowvoteData, record.ownerId, principalId);
  };
  publish = (record: SuiteRecord, before: SuiteRecord | null, action: string, actor: AuthContext, eventSequence: number): void => {
    // Imported history is written by its importer without calling this method.
    // Personal read/archive state and genuine no-ops never notify other people.
    if (noop(record, before) || record.app === 'conpherence' && ['read', 'archive', 'unarchive'].includes(action)) return;
    let audience: SuiteNotificationContext['audience'] = 'all', kind: NotificationKind = action === 'create' ? 'suite_created' : action === 'comment' ? 'suite_commented' : 'suite_updated';
    if (record.app === 'conpherence' && action === 'message') kind = 'suite_message';
    if (record.app === 'slowvote' && ['vote', 'withdraw'].includes(action)) { audience = 'results'; kind = 'suite_vote'; }
    if (record.app === 'legalpad' && ['sign', 'withdraw', 'void', 'exempt'].includes(action)) { audience = ['sign', 'withdraw'].includes(action) ? 'actor-or-editors' : 'editors'; kind = 'suite_signature'; }
    if (record.app === 'phame' && record.kind === 'post') {
      if (action === 'publish') kind = 'suite_published';
      else if ((record.data as unknown as PhamePostData).status !== 'published' || before && (before.data as unknown as PhamePostData).status !== 'published') audience = 'editors';
    }
    this.store.notifications.emit({ objectId: record.id, kind, cause: { type: 'suite_transaction', id: String(eventSequence) }, context: { kind: 'suite', app: record.app, version: record.version, action, audience }, attribution: { principalId: actor.principalId, displayName: actor.displayName, credentialId: actor.credentialId, requestId: `suite:${eventSequence}` }, createdAt: record.updatedAt });
  };
}
