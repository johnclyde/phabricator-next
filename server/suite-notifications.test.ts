import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from './store.ts';
import { SuiteNotifications, initializeSuiteNotifications } from './suite-notifications.ts';
import { initializeNotificationSuiteTargets } from './notifications.ts';
import { HttpError } from './validation.ts';
import { isNotificationInbox } from '../shared/notifications.ts';
import type { SuiteApp, SuiteRecord } from '../shared/suite.ts';
import type { AuthContext } from '../shared/auth.ts';
import type { SuiteNotificationPreference, SuiteNotificationPreferenceInput } from '../shared/suite-notifications.ts';
const actor = (principalId = 'alice'): AuthContext => ({ principalId, displayName: principalId.toUpperCase(), workspaceId: 'workspace', kind: 'session', sessionContext: 'fixture', credentialId: null, scopes: ['read', 'write'] });
const attribution = (principalId = 'alice') => ({ principalId, displayName: principalId.toUpperCase(), credentialId: null, requestId: 'fixture' });
function fixture() {
  const store = new Store({ path: ':memory:' }); initializeNotificationSuiteTargets(store.database); initializeSuiteNotifications(store.database);
  const records = new Map<string, SuiteRecord>(), hidden = new Set<string>(), disabled = new Set<string>(), revokedEditors = new Set<string>(); let seq = 0;
  const view = (id: string, principal: string): boolean => !hidden.has(`${id}:${principal}`) && !disabled.has(principal) && !!records.get(id);
  const service = new SuiteNotifications(store, { rawRecord: id => records.get(id)!, canView: view, projectForPrincipal: (id, principal) => { if (!view(id, principal)) throw new HttpError(404, 'Unavailable'); const record = records.get(id)!; return { record, events: [], nextBefore: null, canEdit: !revokedEditors.has(`${id}:${principal}`) && (record.ownerId === principal || record.access.editorIds.includes(principal)), accessEpoch: 1 }; } }, () => {});
  store.notifications.configure({ eligible: principal => !disabled.has(principal), canView: view }); store.notifications.connectSuite(service);
  function record(app: SuiteApp, data: Record<string, unknown>, kind: string = app): SuiteRecord {
    const prefix = { almanac: 'ALM', conpherence: 'Z', calendar: 'E', slowvote: 'V', phame: 'J', legalpad: 'LP' }[app];
    const value: SuiteRecord = { id: `${prefix}-${randomUUID()}`, app, kind, data, title: `${app} object`, ownerId: 'alice', version: 1, access: { spaceId: 'S1', visibility: 'workspace', memberIds: [], editorIds: ['bob'] }, createdAt: '2026-10-13T00:00:00Z', updatedAt: '2026-10-13T00:00:00Z' };
    records.set(value.id, value); store.database.prepare('INSERT INTO suite_records(id,app,kind,data) VALUES(?,?,?,?)').run(value.id, app, kind, JSON.stringify(value)); return value;
  }
  function publish(value: SuiteRecord, action = 'edit', who = 'alice', before: SuiteRecord | null = null) { service.publish(value, before, action, actor(who), ++seq); }
  function preference(value: SuiteRecord, changes: Partial<SuiteNotificationPreferenceInput>, who = 'bob', key = randomUUID()) {
    const current = service.preference(value.id, who), input = { expectedPreferenceVersion: current.version, expectedAccessEpoch: current.accessEpoch, following: current.following, muted: current.muted, email: current.email, ...changes };
    return { response: service.mutatePreference(value.id, input, key, actor(who)).body as SuiteNotificationPreference, input, key };
  }
  const inbox = (who = 'bob') => store.notifications.list(who, {}, Number(store.database.prepare("SELECT value FROM policy_meta WHERE name='epoch'").get()!.value));
  return { store, service, records, hidden, disabled, revokedEditors, record, publish, preference, inbox, close: () => store.close() };
}

test('six application updates reach current participants without body snapshots and duplicate causes stay singular', () => {
  const f = fixture(); try {
    const records = [f.record('almanac', {}, 'network'), f.record('conpherence', { participants: [{ id: 'bob' }], messages: [{ body: 'Secret message' }] }), f.record('calendar', { hostId: 'alice', invitees: [{ id: 'bob' }], occurrences: [] }), f.record('slowvote', { ballots: [], comments: [], responseVisibility: 'always', closed: false }), f.record('phame', { authorIds: ['bob'], editorIds: [], description: 'Private draft' }, 'blog'), f.record('legalpad', { requiredSignerIds: ['bob'], signatures: [], contactEmail: 'hidden@example.test' })];
    for (const record of records) f.publish(record, 'create');
    let page = f.inbox(); assert.equal(page.items.length, 6); assert.ok(isNotificationInbox(page, 'bob')); assert.equal(f.inbox('alice').items.length, 0); assert.ok(!JSON.stringify(page).includes('Secret message')); assert.ok(!JSON.stringify(page).includes('hidden@example.test'));
    const latest = records.at(-1)!; f.service.publish(latest, null, 'create', actor(), 6); assert.equal(f.inbox().items.length, 6);
    latest.title = 'Current authorized title'; page = f.inbox(); assert.equal(page.items[0]!.object.title, latest.title);
    f.hidden.add(`${latest.id}:bob`); assert.equal(f.inbox().unreadCount, 5); assert.throws(() => f.store.notifications.deliveryItem('bob', page.items[0]!.id), { code: 'NOTIFICATION_UNAVAILABLE' });
    f.disabled.add('bob'); assert.throws(() => f.inbox(), { code: 'NOTIFICATION_UNAVAILABLE' });
  } finally { f.close(); }
});
test('personal follow, ignore and mute have durable exact retries and permission-rechecked recovery', () => {
  const f = fixture(); try {
    const record = f.record('almanac', {}, 'device'); assert.equal(f.service.preference(record.id, 'carol').effectiveFollowing, false);
    f.preference(record, { following: 'following' }, 'carol'); f.publish(record); assert.equal(f.inbox('carol').items.length, 1);
    f.preference(record, { muted: true }, 'carol'); f.publish(record); assert.equal(f.inbox('carol').items.length, 1);
    const mute = f.preference(record, { following: 'ignored' }); const history = Number(f.store.database.prepare('SELECT count(*) AS n FROM suite_notification_history').get()!.n);
    const replay = f.service.mutatePreference(record.id, mute.input, mute.key, actor('bob')).body as SuiteNotificationPreference & { receipt: { replayed: boolean } }; assert.equal(replay.receipt.replayed, true); assert.equal(Number(f.store.database.prepare('SELECT count(*) AS n FROM suite_notification_history').get()!.n), history);
    f.publish(record); assert.equal(f.inbox().items.length, 2, 'ignore only affects future deliveries');
    assert.throws(() => f.service.mutatePreference(record.id, mute.input, randomUUID(), actor('bob')), { code: 'NOTIFICATION_CHANGED' });
    f.hidden.add(`${record.id}:bob`); assert.throws(() => f.service.mutatePreference(record.id, mute.input, mute.key, actor('bob')), { status: 404 });
    assert.throws(() => f.store.database.exec('DELETE FROM suite_notification_history'), /immutable/);
  } finally { f.close(); }
});
test('hidden poll votes stay out of inbox, counts, read mutations, mail projection and bulk-read evidence after privacy changes', () => {
  const f = fixture(); try {
    const record = f.record('slowvote', { ballots: [{ actorId: 'carol', choiceIds: ['secret-choice'] }], comments: [], responseVisibility: 'always', closed: false });
    f.publish(record, 'vote', 'carol'); const item = f.inbox().items[0]!; assert.equal(item.event.kind, 'suite_vote'); assert.ok(!JSON.stringify(item).includes('secret-choice'));
    record.data.responseVisibility = 'owner'; assert.equal(f.inbox().items.length, 0); assert.equal(f.inbox().unreadCount, 0);
    assert.throws(() => f.store.notifications.deliveryItem('bob', item.id), { code: 'NOTIFICATION_UNAVAILABLE' });
    assert.throws(() => f.store.notifications.mutate('bob', { action: 'read', notificationId: item.id, expectedVersion: 0, expectedAccessEpoch: 0 }, attribution('bob')), { code: 'NOTIFICATION_CHANGED' });
    const current = f.inbox(); assert.throws(() => f.store.notifications.mutate('bob', { action: 'read', notificationId: item.id, expectedVersion: 0, expectedAccessEpoch: current.accessEpoch }, attribution('bob')), { code: 'NOTIFICATION_UNAVAILABLE' });
    const receipt = f.store.notifications.mutate('bob', { action: 'read_through', horizon: current.horizon, expectedAccessEpoch: current.accessEpoch }, attribution('bob')); assert.equal(receipt.changed, false); assert.deepEqual(f.store.notifications.operation(receipt.operationId).affected, []);
  } finally { f.close(); }
});
test('draft-post and Legalpad signature notifications lose visibility with editor rights, never copy private contacts', () => {
  const f = fixture(); try {
    const blog = f.record('phame', { authorIds: ['carol'], editorIds: [] }, 'blog'), post = f.record('phame', { blogId: blog.id, status: 'draft', body: 'Unreleased post' }, 'post');
    f.publish(post); const draft = f.inbox().items[0]!; assert.equal(f.inbox('carol').items.length, 0);
    post.data.status = 'published'; f.revokedEditors.add(`${post.id}:bob`); assert.equal(f.inbox().unreadCount, 0); assert.throws(() => f.store.notifications.deliveryItem('bob', draft.id), { code: 'NOTIFICATION_UNAVAILABLE' });
    const agreement = f.record('legalpad', { requiredSignerIds: ['bob', 'carol'], signatures: [{ signerId: 'carol', companyAddress: 'Secret street', contactEmail: 'private@test.invalid' }] });
    f.publish(agreement, 'sign', 'carol'); const signed = f.inbox().items[0]!; assert.equal(signed.event.kind, 'suite_signature'); assert.ok(!JSON.stringify(signed).includes('Secret street')); assert.ok(!JSON.stringify(signed).includes('private@test.invalid'));
    f.revokedEditors.add(`${agreement.id}:bob`); assert.equal(f.inbox().unreadCount, 0); assert.throws(() => f.store.notifications.deliveryItem('bob', signed.id), { code: 'NOTIFICATION_UNAVAILABLE' });
  } finally { f.close(); }
});
test('parent following routes child updates under current child visibility and child opt-out wins', () => {
  const f = fixture(); try {
    const blog = f.record('phame', { authorIds: [], editorIds: [] }, 'blog'); f.preference(blog, { following: 'following' }, 'carol');
    const post = f.record('phame', { blogId: blog.id, status: 'published' }, 'post'); f.publish(post, 'publish'); assert.equal(f.inbox('carol').items.length, 1);
    f.preference(post, { following: 'ignored' }, 'carol'); f.publish(post); assert.equal(f.inbox('carol').items.length, 1);
    f.preference(post, { following: 'default' }, 'carol'); f.hidden.add(`${post.id}:carol`); f.publish(post); assert.equal(f.inbox('carol').items.length, 0);
  } finally { f.close(); }
});
test('email starts only after opt-in and re-enabling never revives earlier deliveries', () => {
  const f = fixture(); try {
    const record = f.record('almanac', {}, 'device'); f.publish(record); const sequence = () => Number(f.store.database.prepare('SELECT max(sequence) AS n FROM notification_deliveries').get()!.n);
    const first = sequence(); assert.equal(f.service.emailEligible(record.id, 'bob', first), false);
    f.preference(record, { email: true }); assert.equal(f.service.emailEligible(record.id, 'bob', first), false);
    f.publish(record); const second = sequence(); assert.equal(f.service.emailEligible(record.id, 'bob', second), true);
    f.preference(record, { email: false }); assert.equal(f.service.emailEligible(record.id, 'bob', second), false);
    f.preference(record, { email: true }); assert.equal(f.service.emailEligible(record.id, 'bob', second), false);
    f.publish(record); assert.equal(f.service.emailEligible(record.id, 'bob', sequence()), true);
    f.preference(record, { muted: true }); assert.equal(f.service.emailEligible(record.id, 'bob', sequence()), false);
  } finally { f.close(); }
});
test('personal room reads/archives, no-ops and rolled-back updates produce no deliveries', () => {
  const f = fixture(); try {
    const record = f.record('conpherence', { participants: [{ id: 'bob' }], messages: [] });
    for (const action of ['read', 'archive', 'unarchive']) f.publish(record, action);
    f.publish(record, 'edit', 'alice', structuredClone(record)); assert.equal(f.inbox().items.length, 0);
    assert.throws(() => f.store.transaction(() => { f.publish(record, 'message'); throw new Error('Rollback'); }), /Rollback/); assert.equal(f.inbox().items.length, 0);
  } finally { f.close(); }
});
