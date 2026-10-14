import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AuthContext } from '../shared/auth.ts';
import { mailPreferenceInput, type MailPreference } from '../shared/mail.ts';
import type { Auth } from './auth.ts';
import type { Store, MutationResponse } from './store.ts';
import { HttpError } from './validation.ts';
import { smtpMailTransport, validateMailConfiguration, type MailConfiguration, type MailTransport } from './mail-config.ts';

const definitions = [
  ['mail_preferences', 'CREATE TABLE mail_preferences(principal_id TEXT PRIMARY KEY,version INTEGER NOT NULL CHECK(version>0),enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),cursor INTEGER NOT NULL CHECK(cursor>=0),address_hash TEXT NOT NULL)'],
  ['mail_outbox', "CREATE TABLE mail_outbox(id TEXT PRIMARY KEY,notification_id TEXT NOT NULL UNIQUE REFERENCES notification_deliveries(id),principal_id TEXT NOT NULL,preference_version INTEGER NOT NULL,sequence INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN('pending','sending','sent','suppressed','failed','uncertain')),claim TEXT,lease_until INTEGER,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)"],
  ['mail_outbox_state', 'CREATE INDEX mail_outbox_state ON mail_outbox(state,sequence)'],
] as const;
export function initializeMail(db: DatabaseSync): void {
  db.exec('SAVEPOINT mail_schema');
  try {
    for (const [name, sql] of definitions) {
      const row = db.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(name) as { sql: string } | undefined;
      if (row && row.sql !== sql) throw new Error(`Unexpected ${name} schema; mail migration was not applied.`);
      if (!row) db.exec(sql);
    }
    db.exec('RELEASE mail_schema');
  } catch (error) { db.exec('ROLLBACK TO mail_schema; RELEASE mail_schema'); throw error; }
}
interface PreferenceRow { version: number; enabled: number; cursor: number; address_hash: string }
interface Job { id: string; notification_id: string; principal_id: string; preference_version: number; sequence: number }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
/** Outbound notifications are explicit opt-in and contain no object titles,
 * bodies, identities, ballots, signatures, or other source material. */
export class MailService {
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private stopped = false;
  private readonly configuration?: MailConfiguration;
  private readonly transport?: MailTransport;
  constructor(private readonly store: Store, private readonly auth: Auth, configuration: MailConfiguration | undefined,
    private readonly basePath: string, private readonly eligible: (objectId: string, principalId: string, sequence: number) => boolean,
    transport?: MailTransport, private readonly clock = Date.now) {
    this.configuration = configuration && validateMailConfiguration(configuration);
    this.transport = this.configuration ? transport ?? smtpMailTransport(this.configuration) : undefined;
  }
  private row(principal: string): PreferenceRow { return this.store.database.prepare('SELECT version,enabled,cursor,address_hash FROM mail_preferences WHERE principal_id=?').get(principal) as unknown as PreferenceRow | undefined ?? { version: 0, enabled: 0, cursor: 0, address_hash: '' }; }
  private address(principal: string): string | undefined { const recipients = this.configuration?.recipients; return recipients && Object.hasOwn(recipients, principal) ? recipients[principal] : undefined; }
  private epoch(): number { return Number(this.store.database.prepare("SELECT value FROM policy_meta WHERE name='epoch'").get()!.value); }
  private high(principal: string): number { return Number(this.store.database.prepare('SELECT coalesce(max(sequence),0) AS high FROM notification_deliveries WHERE principal_id=?').get(principal)!.high); }
  preference(actor: AuthContext): MailPreference {
    this.auth.revalidate(actor, 'read');
    if (actor.kind === 'token') throw new HttpError(403, 'Email preferences require a personal session.');
    const row = this.row(actor.principalId), address = this.address(actor.principalId), counts = { pending: 0, sent: 0, failed: 0, uncertain: 0 };
    for (const value of this.store.database.prepare('SELECT state,count(*) AS total FROM mail_outbox WHERE principal_id=? GROUP BY state').all(actor.principalId)) {
      const state = String(value.state);
      if (state === 'sending' || state === 'pending') counts.pending += Number(value.total);
      else if (state === 'sent' || state === 'failed' || state === 'uncertain') counts[state] = Number(value.total);
    }
    return { principalId: actor.principalId, version: row.version, enabled: !!row.enabled && !!address && row.address_hash === hash(address), available: !!address && !!this.transport,
      address: address ?? null, accessEpoch: this.epoch(), counts };
  }
  mutate(raw: unknown, key: string | undefined, actor: AuthContext): MutationResponse {
    let input;
    try { input = mailPreferenceInput(raw); } catch (error) { throw new HttpError(400, (error as Error).message); }
    if (!key) throw new HttpError(400, 'Email preferences require an Idempotency-Key.');
    const authorize = () => { this.auth.revalidate(actor, 'write'); this.preference(actor); };
    return this.store.mutate(`mail:${actor.workspaceId}:${actor.principalId}:${key}`, hash(JSON.stringify(input)), () => {
      const current = this.row(actor.principalId), address = this.address(actor.principalId);
      if (input.expectedVersion !== current.version) throw new HttpError(409, 'Email preferences changed. Refresh before saving.');
      if (input.enabled && (!address || !this.transport)) throw new HttpError(409, 'An operator must configure email for your account first.');
      const version = current.version + 1;
      // A new generation never inherits queued or historical mail.
      this.store.database.prepare('INSERT INTO mail_preferences(principal_id,version,enabled,cursor,address_hash) VALUES(?,?,?,?,?) ON CONFLICT(principal_id) DO UPDATE SET version=excluded.version,enabled=excluded.enabled,cursor=excluded.cursor,address_hash=excluded.address_hash')
        .run(actor.principalId, version, Number(input.enabled), this.high(actor.principalId), address ? hash(address) : '');
      this.store.database.prepare("UPDATE mail_outbox SET state='suppressed',updated_at=? WHERE principal_id=? AND state='pending'").run(new Date(this.clock()).toISOString(), actor.principalId);
      return { status: 200, body: { principalId: actor.principalId, version } };
    }, authorize, (receipt, replayed) => ({ status: 200, body: { ...this.preference(actor), receipt: { ...(receipt.body as object), replayed } } }));
  }
  private allowed(job: Job): string | null {
    const row = this.row(job.principal_id), address = this.address(job.principal_id);
    if (!row.enabled || row.version !== job.preference_version || !address || row.address_hash !== hash(address)) return null;
    try {
      const item = this.store.notifications.deliveryItem(job.principal_id, job.notification_id);
      if (!this.eligible(item.object.id, job.principal_id, job.sequence)) return null;
      return address;
    } catch (error) { if (error instanceof HttpError && [401, 403, 404].includes(error.status)) return null; throw error; }
  }
  private enqueue(): void {
    const now = new Date(this.clock()).toISOString();
    this.store.transaction(() => {
      this.store.database.prepare("UPDATE mail_outbox SET state='uncertain',claim=NULL,lease_until=NULL,updated_at=? WHERE state='sending' AND lease_until<?").run(now, this.clock());
      // The preference cursor advances even for currently ineligible deliveries;
      // gaining access later cannot resurrect old messages.
      const people = this.store.database.prepare('SELECT principal_id FROM mail_preferences p WHERE enabled=1 AND EXISTS(SELECT 1 FROM notification_deliveries d WHERE d.principal_id=p.principal_id AND d.sequence>p.cursor) ORDER BY principal_id LIMIT 100').all();
      for (const person of people) {
        const principal = String(person.principal_id), row = this.row(principal);
        const deliveries = this.store.database.prepare('SELECT id,sequence FROM notification_deliveries WHERE principal_id=? AND sequence>? ORDER BY sequence LIMIT 100').all(principal, row.cursor);
        for (const delivery of deliveries) {
          const job: Job = { id: randomUUID(), notification_id: String(delivery.id), sequence: Number(delivery.sequence), principal_id: principal, preference_version: row.version };
          if (this.allowed(job)) this.store.database.prepare("INSERT OR IGNORE INTO mail_outbox(id,notification_id,principal_id,preference_version,sequence,state,created_at,updated_at) VALUES(?,?,?,?,?,'pending',?,?)").run(job.id, job.notification_id, principal, row.version, job.sequence, now, now);
        }
        if (deliveries.length) this.store.database.prepare('UPDATE mail_preferences SET cursor=? WHERE principal_id=?').run(Number(deliveries.at(-1)!.sequence), principal);
      }
    });
  }
  async drain(): Promise<void> {
    if (this.running) return this.running;
    if (!this.transport || !this.configuration || this.stopped) return;
    const work = async () => {
      this.enqueue();
      for (let count = 0; count < 10 && !this.stopped; count++) {
        const claim = randomUUID();
        const selected = this.store.transaction(() => {
          const job = this.store.database.prepare("SELECT id,notification_id,principal_id,preference_version,sequence FROM mail_outbox WHERE state='pending' ORDER BY sequence LIMIT 1").get() as unknown as Job | undefined;
          if (!job) return null;
          const recipient = this.allowed(job), now = new Date(this.clock()).toISOString();
          this.store.database.prepare('UPDATE mail_outbox SET state=?,claim=?,lease_until=?,updated_at=? WHERE id=?').run(recipient ? 'sending' : 'suppressed', recipient ? claim : null, recipient ? this.clock() + 120000 : null, now, job.id);
          return { job, recipient };
        });
        if (!selected) break;
        if (!selected.recipient) continue;
        let state: 'sent' | 'failed' | 'uncertain' = 'sent';
        try {
          // No asynchronous work occurs between current authorization and send.
          // SMTP acceptance cannot be atomically coupled with the local database.
          await this.transport!.send({ recipient: selected.recipient, messageId: `<${selected.job.id}@${new URL(this.configuration!.origin).hostname}>`,
            text: `You have a new notification in your workspace. Sign in to read it:\n\n${this.configuration!.origin}${this.basePath}#notifications\n\nEmail settings are available in Notifications.\n` });
        } catch (error) {
          // Only a definitive SMTP rejection is known not to have been accepted.
          // Socket errors and process crashes may occur after acceptance; never
          // automatically resend those messages and create duplicate mail.
          const code = error && typeof error === 'object' && 'responseCode' in error ? Number(error.responseCode) : 0;
          state = code >= 400 && code <= 599 ? 'failed' : 'uncertain';
        }
        this.store.transaction(() => { this.store.database.prepare('UPDATE mail_outbox SET state=?,claim=NULL,lease_until=NULL,updated_at=? WHERE id=? AND state=\'sending\' AND claim=?')
          .run(state, new Date(this.clock()).toISOString(), selected.job.id, claim); });
      }
    };
    this.running = work();
    try { await this.running; } finally { this.running = undefined; }
  }
  start(): void {
    if (!this.transport || this.timer || this.stopped) return;
    const tick = () => {
      this.timer = setTimeout(() => { this.timer = undefined; void this.drain().catch(() => console.error('Notification email processing failed; inspect mail delivery state.')).finally(() => { if (!this.stopped) tick(); }); }, 5000);
      this.timer.unref();
    };
    tick();
  }
  async close(): Promise<void> { this.stopped = true; if (this.timer) clearTimeout(this.timer); await this.running; this.transport?.close(); }
}
