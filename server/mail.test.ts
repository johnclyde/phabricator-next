import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { Store } from './store.ts';
import { createAuth, type Auth } from './auth.ts';
import { PolicyStore } from './policy.ts';
import { SuiteService } from './suite.ts';
import { SuiteNotifications } from './suite-notifications.ts';
import { MailService } from './mail.ts';
import { mailbox, mailFromEnvironment, validateMailConfiguration, type MailConfiguration, type MailMessage, type MailTransport } from './mail-config.ts';
import type { AuthContext } from '../shared/auth.ts';
import type { SuiteDetail } from '../shared/suite.ts';
import type { MailPreference } from '../shared/mail.ts';
import type { SuiteNotificationPreferenceInput } from '../shared/suite-notifications.ts';

const password = 'Disposable notification mail test passphrase', origin = 'http://127.0.0.1:4310';
const request = (headers: Record<string, string | undefined> = {}, method = 'GET') => ({ method, headers: { host: '127.0.0.1:4310', ...headers } }) as IncomingMessage;
async function login(auth: Auth, username: string): Promise<AuthContext> {
  const challenge = auth.session(request());
  const result = await auth.login(request({ origin, cookie: challenge.cookie!.split(';')[0], 'x-csrf-token': challenge.session.csrfToken! }, 'POST'), username, password);
  return auth.authenticate(request({ origin, cookie: result.cookie.split(';')[0], 'x-session-context': result.session.sessionContext!, 'x-csrf-token': result.session.csrfToken! }), 'write');
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(send?: (message: MailMessage) => Promise<void>) {
  const store = new Store({ path: ':memory:' }), provisioning = createAuth({ database: store.database, mode: 'local', basePath: '/review/', provisioning: true });
  await provisioning.createAccount({ username: 'alice', displayName: 'Sensitive Author', password });
  await provisioning.createAccount({ username: 'bob', displayName: 'Sensitive Recipient', password });
  const auth = createAuth({ database: store.database, mode: 'password', basePath: '/review/' });
  const alice = await login(auth, 'alice'), bob = await login(auth, 'bob');
  const policies = new PolicyStore(store.database, { principalExists: id => !!store.database.prepare('SELECT id FROM auth_accounts WHERE id=?').get(id) });
  const suite = new SuiteService(store, auth, policies), notifications = new SuiteNotifications(store, suite, actor => auth.revalidate(actor, 'write'));
  suite.connectNotifications(notifications.publish); store.notifications.connectSuite(notifications);
  store.notifications.configure({ eligible: id => !!store.database.prepare('SELECT id FROM auth_accounts WHERE id=? AND disabled=0').get(id), canView: (id, principal) => suite.canView(id, principal) });
  const messages: MailMessage[] = [], closed: string[] = [];
  const transport: MailTransport = { send: async message => { messages.push(message); await send?.(message); }, close: () => { closed.push('closed'); } };
  const configuration: MailConfiguration = { from: 'workspace@example.test', origin: 'https://workspace.example.test', host: 'smtp.example.test', port: 465, secure: true, recipients: { [bob.principalId]: 'recipient@example.test' } };
  let now = Date.now();
  const createMail = (config: MailConfiguration | undefined = configuration, otherTransport = transport) => new MailService(store, auth, config, '/review/', (id, principal, sequence) => notifications.emailEligible(id, principal, sequence), otherTransport, () => now);
  const mail = createMail();
  const preference = (enabled: boolean, service = mail) => service.mutate({ expectedVersion: service.preference(bob).version, enabled }, randomUUID(), bob).body as MailPreference;
  const room = () => (suite.mutate('POST', '/api/suite/conpherence', { kind: 'room', title: 'Sensitive room title', participantIds: [bob.principalId], message: 'Sensitive initial message with contact@example.test' }, randomUUID(), alice).body as SuiteDetail).record.id;
  const command = (id: string, action: string, body: object = {}, actor = alice) => suite.mutate('POST', `/api/suite/conpherence/${id}/${action}`, { ...body, expectedVersion: suite.rawRecord(id).version }, randomUUID(), actor);
  let number = 0;
  const publish = (id: string) => command(id, 'message', { body: `Sensitive text ${++number}; contact@example.test` });
  const objectPreference = (id: string, change: Partial<SuiteNotificationPreferenceInput>) => {
    const current = notifications.preference(id, bob.principalId);
    return notifications.mutatePreference(id, { expectedPreferenceVersion: current.version, expectedAccessEpoch: current.accessEpoch, following: current.following, muted: current.muted, email: current.email, ...change }, randomUUID(), bob);
  };
  const states = () => store.database.prepare('SELECT state FROM mail_outbox ORDER BY sequence').all().map(row => row.state);
  return { store, auth, alice, bob, policies, suite, notifications, configuration, createMail, mail, messages, closed, preference, room, command, publish, objectPreference, states, advance: (ms: number) => { now += ms; }, close: async () => { await mail.close(); store.close(); } };
}

test('mail configuration rejects ambiguous addresses, insecure origins and partial SMTP credentials', () => {
  assert.equal(mailFromEnvironment({}), undefined);
  const config: MailConfiguration = { from: 'workspace@example.test', origin: 'https://workspace.example.test', recipients: { bob: 'bob+review@example.test' }, host: 'smtp.example.test', port: 465, secure: true };
  assert.deepEqual(validateMailConfiguration(config), config);
  for (const address of ['Bob <bob@example.test>', 'bob(comment)@example.test', 'bob@example.test,other@example.test', 'bob@example.test\r\nBcc:other@example.test', '"bob"@example.test', 'bob@localhost']) assert.equal(mailbox(address), false, address);
  for (const changed of [{ origin: 'http://workspace.example.test' }, { origin: 'https://workspace.example.test/private/' }, { from: 'x@example.test\nBcc:y@example.test' }, { recipients: { bob: 'a@example.test,b@example.test' } }, { username: 'user' }, { password: 'secret' }, { host: 'smtp.example.test\n' }, { port: 0 }]) assert.throws(() => validateMailConfiguration({ ...config, ...changed }));
  assert.throws(() => mailFromEnvironment({ APP_MAIL_FROM: config.from }), /require APP_SMTP_HOST/);
  assert.throws(() => mailFromEnvironment({ APP_SMTP_HOST: config.host, APP_SMTP_SECURE: 'yes' }), /true or false/);
  const environment = { APP_SMTP_HOST: config.host, APP_MAIL_FROM: config.from, APP_PUBLIC_ORIGIN: config.origin, APP_MAIL_RECIPIENTS: JSON.stringify(config.recipients) };
  assert.equal(mailFromEnvironment(environment)!.secure, true); assert.equal(mailFromEnvironment(environment)!.port, 465);
  assert.equal(mailFromEnvironment({ ...environment, APP_SMTP_SECURE: 'false' })!.secure, false); assert.equal(mailFromEnvironment({ ...environment, APP_SMTP_SECURE: 'false' })!.port, 587);
  assert.throws(() => mailFromEnvironment({ ...environment, APP_SMTP_USERNAME: 'user' }), /SMTP configuration/);
  assert.throws(() => mailFromEnvironment({ ...environment, APP_SMTP_PASSWORD: 'secret' }), /SMTP configuration/);
  assert.throws(() => mailFromEnvironment({ ...environment, APP_PUBLIC_ORIGIN: 'http://workspace.example.test' }), /HTTPS/);
  assert.throws(() => mailFromEnvironment({ ...environment, APP_MAIL_FROM: undefined }), /SMTP configuration/);
  assert.throws(() => mailFromEnvironment({ ...environment, APP_MAIL_RECIPIENTS: 'not-json' }), /JSON account-to-address map/);
});
test('mail requires personal opt-in and per-object email eligibility without replaying history or source text', async () => {
  const f = await fixture(); try {
    const id = f.room(); assert.equal(f.mail.preference(f.bob).enabled, false);
    f.publish(id); await f.mail.drain(); assert.equal(f.messages.length, 0);
    f.preference(true); f.publish(id); await f.mail.drain(); assert.equal(f.messages.length, 0, 'account opt-in alone cannot send room mail');
    f.objectPreference(id, { email: true }); await f.mail.drain(); assert.equal(f.messages.length, 0, 'room opt-in cannot resurrect older deliveries');
    f.publish(id); await f.mail.drain(); await f.mail.drain(); assert.equal(f.messages.length, 1); assert.deepEqual(f.states(), ['sent']);
    const message = f.messages[0]!;
    assert.equal(message.recipient, 'recipient@example.test'); assert.match(message.messageId, /^<[a-f0-9-]+@workspace\.example\.test>$/);
    assert.equal(message.text, 'You have a new notification in your workspace. Sign in to read it:\n\nhttps://workspace.example.test/review/#notifications\n\nEmail settings are available in Notifications.\n');
    for (const value of ['Sensitive', 'contact@example.test', f.alice.displayName, f.bob.displayName, id]) assert.ok(!message.text.includes(value));
    assert.deepEqual(f.mail.preference(f.bob).counts, { pending: 0, sent: 1, failed: 0, uncertain: 0 });
  } finally { await f.close(); }
});
test('mail preference retries stay exact and revoked sessions or tokens cannot change personal consent', async () => {
  const f = await fixture(); try {
    const key = randomUUID(), input = { expectedVersion: 0, enabled: true };
    const first = f.mail.mutate(input, key, f.bob).body as MailPreference;
    const replay = f.mail.mutate(input, key, f.bob).body as MailPreference & { receipt: { replayed: boolean } };
    assert.equal(replay.version, first.version); assert.equal(replay.receipt.replayed, true);
    assert.throws(() => f.mail.mutate({ ...input, enabled: false }, key, f.bob), { status: 409 });
    const token = f.auth.createToken(f.bob.principalId, { name: 'Disposable test', scopes: ['read', 'write'] });
    const actor = f.auth.authenticate(request({ authorization: `Bearer ${token.token}` }), 'write');
    assert.throws(() => f.mail.preference(actor), { status: 403 });
    assert.throws(() => f.mail.mutate({ expectedVersion: first.version, enabled: false }, randomUUID(), actor), { status: 403 });
    f.auth.logout(f.bob);
    assert.throws(() => f.mail.mutate(input, key, f.bob), { status: 401 });
  } finally { await f.close(); }
});
test('mail disabling and re-enabling starts a new generation and does not resurrect eligible old deliveries', async () => {
  const f = await fixture(); try {
    const id = f.room(); f.preference(true); f.objectPreference(id, { email: true });
    f.publish(id); f.preference(false); await f.mail.drain(); assert.equal(f.messages.length, 0);
    f.preference(true); await f.mail.drain(); assert.equal(f.messages.length, 0);
    f.publish(id); await f.mail.drain(); assert.equal(f.messages.length, 1);
    f.objectPreference(id, { muted: true }); f.publish(id); await f.mail.drain(); assert.equal(f.messages.length, 1);
    f.objectPreference(id, { muted: false, email: false }); f.publish(id); await f.mail.drain(); assert.equal(f.messages.length, 1);
    f.objectPreference(id, { email: true }); await f.mail.drain(); assert.equal(f.messages.length, 1);
  } finally { await f.close(); }
});
test('mail checks current Space and participant visibility, disabled accounts, and changed recipient mappings', async () => {
  for (const revoke of ['space', 'participant', 'disabled', 'address'] as const) {
    const f = await fixture(); let alternate: MailService | undefined;
    try {
      const id = f.room(); f.preference(true); f.objectPreference(id, { email: true }); f.publish(id);
      if (revoke === 'space') { const space = f.policies.getSpace('S1', f.alice.principalId); f.policies.updateSpace('S1', { expectedVersion: space.version, view: { kind: 'principals', principalIds: [f.alice.principalId] } }, f.alice.principalId); }
      if (revoke === 'participant') f.command(id, 'participants', { participantIds: [f.alice.principalId] });
      if (revoke === 'disabled') f.auth.setAccountDisabled(f.bob.principalId, true);
      if (revoke === 'address') alternate = f.createMail({ ...f.configuration, recipients: { [f.bob.principalId]: 'changed@example.test' } });
      await (alternate ?? f.mail).drain(); assert.equal(f.messages.length, 0, revoke);
      if (alternate) assert.equal(alternate.preference(f.bob).enabled, false);
    } finally { await alternate?.close(); await f.close(); }
  }
});
test('mail revalidates pending jobs after an in-flight send and concurrent drain calls never duplicate a delivery', async () => {
  const gate = deferred(), f = await fixture(async () => gate.promise);
  try {
    const id = f.room(); f.preference(true); f.objectPreference(id, { email: true }); f.publish(id); f.publish(id);
    const first = f.mail.drain(), second = f.mail.drain();
    assert.equal(f.messages.length, 1); assert.deepEqual(f.states(), ['sending', 'pending']);
    f.objectPreference(id, { muted: true }); gate.resolve(); await Promise.all([first, second]);
    assert.equal(f.messages.length, 1); assert.deepEqual(f.states(), ['sent', 'suppressed']);
    await f.mail.drain(); assert.equal(f.messages.length, 1);
  } finally { gate.resolve(); await f.close(); }
});
test('mail crash leases and ambiguous transport failures become uncertain and are never automatically retried', async () => {
  const gate = deferred(), f = await fixture(async () => gate.promise); let recovery: MailService | undefined;
  try {
    const id = f.room(); f.preference(true); f.objectPreference(id, { email: true }); f.publish(id);
    const sending = f.mail.drain(); assert.deepEqual(f.states(), ['sending']);
    f.advance(120_001); recovery = f.createMail(); await recovery.drain(); assert.deepEqual(f.states(), ['uncertain']); assert.equal(f.messages.length, 1);
    gate.resolve(); await sending; await recovery.drain(); assert.deepEqual(f.states(), ['uncertain']); assert.equal(f.messages.length, 1, 'late completion cannot overwrite expired claim');
  } finally { gate.resolve(); await recovery?.close(); await f.close(); }
  for (const error of [new Error('Socket closed after possible acceptance'), Object.assign(new Error('Rejected'), { responseCode: 550 })]) {
    const g = await fixture(async () => { throw error; }); try {
      const id = g.room(); g.preference(true); g.objectPreference(id, { email: true }); g.publish(id);
      await g.mail.drain(); await g.mail.drain(); assert.equal(g.messages.length, 1); assert.deepEqual(g.states(), ['responseCode' in error ? 'failed' : 'uncertain']);
    } finally { await g.close(); }
  }
});
test('mail drain remains bounded, closes after the active send, and never resumes after close', async () => {
  const gate = deferred(), f = await fixture(async () => gate.promise);
  try {
    const id = f.room(); f.preference(true); f.objectPreference(id, { email: true }); f.publish(id); f.publish(id);
    const draining = f.mail.drain(), closing = f.mail.close();
    assert.equal(f.messages.length, 1); assert.equal(f.closed.length, 0);
    gate.resolve(); await Promise.all([draining, closing]); assert.equal(f.closed.length, 1); assert.deepEqual(f.states(), ['sent', 'pending']);
    await f.mail.drain(); assert.equal(f.messages.length, 1);
  } finally { gate.resolve(); await f.close(); }
  const g = await fixture(); try {
    const id = g.room(); g.preference(true); g.objectPreference(id, { email: true });
    for (let count = 0; count < 12; count++) g.publish(id);
    await g.mail.drain(); assert.equal(g.messages.length, 10); assert.equal(g.states().filter(state => state === 'pending').length, 2);
    await g.mail.drain(); assert.equal(g.messages.length, 12); assert.equal(new Set(g.messages.map(message => message.messageId)).size, 12);
  } finally { await g.close(); }
});
