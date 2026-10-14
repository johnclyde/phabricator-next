import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Store } from './store.ts';
import { createApp } from './app.ts';
import { createAuth } from './auth.ts';
import type { SuiteDetail } from '../shared/suite.ts';
import type { NotificationInbox, NotificationReceipt } from '../shared/notifications.ts';
import type { SuiteNotificationPreference } from '../shared/suite-notifications.ts';
async function fixture() {
  const store = new Store({ path: ':memory:' }), provisioning = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  const alice = await provisioning.createAccount({ username: 'alice', displayName: 'Alice', password: 'Notification Alice fixture phrase' }), bob = await provisioning.createAccount({ username: 'bob', displayName: 'Bob', password: 'Notification Bob fixture phrase' }), carol = await provisioning.createAccount({ username: 'carol', displayName: 'Carol', password: 'Notification Carol fixture phrase' });
  const app = createApp({ store, seed: false, authMode: 'password' });
  const tokens = { alice: app.auth.createToken(alice.id, { name: 'Writer', scopes: ['read', 'write'] }).token, bob: app.auth.createToken(bob.id, { name: 'Writer', scopes: ['read', 'write'] }).token, carol: app.auth.createToken(carol.id, { name: 'Writer', scopes: ['read', 'write'] }).token };
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  async function request<T = SuiteDetail>(path: string, body?: unknown, who: keyof typeof tokens = 'alice', key = randomUUID()) {
    const result = await fetch(origin + '/api/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${tokens[who]}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': key }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: result.status, body: await result.json() as T };
  }
  async function create(app: string, input: unknown) { const result = await request('suite/' + app, input); assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body; }
  async function inbox(who: keyof typeof tokens = 'bob') { const result = await request<NotificationInbox>('notifications', undefined, who); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; }
  return { ...app, alice, bob, carol, request, create, inbox, close: async () => { await app.close(); store.close(); } };
}

test('HTTP room deliveries, preference retries, personal silence and read receipts obey current membership', async () => {
  const f = await fixture(); try {
    let detail = await f.create('conpherence', { kind: 'room', title: 'Private conversation', participantIds: [f.bob.id] }); const id = detail.record.id;
    let inbox = await f.inbox(); assert.equal(inbox.items.length, 1); assert.equal(inbox.items[0]!.object.id, id);
    const path = `suite/conpherence/${id}/notifications`, prefs = await f.request<SuiteNotificationPreference>(path, undefined, 'bob'); assert.equal(prefs.status, 200); assert.equal(prefs.body.effectiveFollowing, true);
    const mutationKey = randomUUID(), message = { expectedVersion: detail.record.version, body: 'Private message never copied into notification' };
    const posted = await f.request(`suite/conpherence/${id}/message`, message, 'alice', mutationKey); assert.equal(posted.status, 200, JSON.stringify(posted.body)); detail = posted.body;
    assert.equal((await f.request(`suite/conpherence/${id}/message`, message, 'alice', mutationKey)).status, 200); inbox = await f.inbox(); assert.equal(inbox.items.length, 2); assert.ok(!JSON.stringify(inbox).includes(message.body));
    const notification = inbox.items[0]!, readKey = randomUUID(), read = { action: 'read' as const, notificationId: notification.id, expectedVersion: notification.version, expectedAccessEpoch: inbox.accessEpoch };
    const receipt = await f.request<NotificationReceipt>('notifications/read', read, 'bob', readKey); assert.equal(receipt.status, 200, JSON.stringify(receipt.body)); assert.equal((await f.inbox()).unreadCount, 1);
    const fresh = await f.request<SuiteNotificationPreference>(path, undefined, 'bob'), prefInput = { expectedPreferenceVersion: fresh.body.version, expectedAccessEpoch: fresh.body.accessEpoch, following: 'default', muted: true, email: false }, prefKey = randomUUID();
    const saved = await f.request<SuiteNotificationPreference>(path, prefInput, 'bob', prefKey); assert.equal(saved.status, 200, JSON.stringify(saved.body)); assert.equal((await f.request(path, prefInput, 'bob', prefKey)).status, 200);
    const changed = await f.request(`suite/conpherence/${id}/message`, { expectedVersion: detail.record.version, body: 'Muted future message' }); assert.equal(changed.status, 200); detail = changed.body; assert.equal((await f.inbox()).items.length, 2);
    const remove = await f.request(`suite/conpherence/${id}/participants`, { expectedVersion: detail.record.version, participantIds: [f.alice.id] }); assert.equal(remove.status, 200, JSON.stringify(remove.body));
    assert.equal((await f.inbox()).unreadCount, 0); assert.equal((await f.inbox()).items.length, 0);
    assert.equal((await f.request(path, undefined, 'bob')).status, 404); assert.equal((await f.request(path, prefInput, 'bob', prefKey)).status, 404);
    assert.equal((await f.request('notifications/read', read, 'bob', readKey)).status, 404, 'saved read receipt cannot disclose revoked room identity');
  } finally { await f.close(); }
});
test('HTTP parent subscriptions and draft event privacy follow the current blog roles', async () => {
  const f = await fixture(); try {
    let blog = await f.create('phame', { kind: 'blog', title: 'Workspace blog', editorIds: [f.bob.id], authorIds: [f.alice.id] });
    const prefs = await f.request<SuiteNotificationPreference>(`suite/phame/${blog.record.id}/notifications`, undefined, 'carol'); assert.equal(prefs.status, 200);
    assert.equal((await f.request(`suite/phame/${blog.record.id}/notifications`, { expectedPreferenceVersion: 0, expectedAccessEpoch: prefs.body.accessEpoch, following: 'following', muted: false, email: false }, 'carol')).status, 200);
    const post = await f.create('phame', { kind: 'post', title: 'Unreleased announcement', blogId: blog.record.id, body: 'Draft detail', subtitle: '' });
    assert.equal((await f.inbox('carol')).items.length, 0); const draftNotice = (await f.inbox()).items.find(item => item.object.id === post.record.id)!; assert.ok(draftNotice);
    const publish = await f.request(`suite/phame/${post.record.id}/publish`, { expectedVersion: 1 }); assert.equal(publish.status, 200, JSON.stringify(publish.body)); assert.equal((await f.inbox('carol')).items[0]!.event.kind, 'suite_published');
    const members = await f.request(`suite/phame/${blog.record.id}/members`, { expectedVersion: blog.record.version, editorIds: [], authorIds: [f.alice.id] }); assert.equal(members.status, 200, JSON.stringify(members.body)); blog = members.body;
    const bobInbox = await f.inbox(); assert.ok(!bobInbox.items.some(item => item.id === draftNotice.id)); assert.ok(bobInbox.items.some(item => item.object.id === post.record.id && item.event.kind === 'suite_published'));
    assert.equal((await f.request(`suite/almanac/${blog.record.id}/notifications`, undefined, 'bob')).status, 404);
    const restrict = await f.request(`suite/phame/${blog.record.id}/access`, { expectedVersion: blog.record.version, access: { visibility: 'members', memberIds: [], editorIds: [] } }); assert.equal(restrict.status, 200, JSON.stringify(restrict.body)); assert.equal((await f.inbox('carol')).items.length, 0);
  } finally { await f.close(); }
});
test('HTTP hidden poll ballots have no deliveries and current result privacy hides previously delivered votes', async () => {
  const f = await fixture(); try {
    let poll = await f.create('slowvote', { kind: 'poll', title: 'Private choices', choices: ['A', 'B'], responseVisibility: 'always', method: 'single' });
    const pref = await f.request<SuiteNotificationPreference>(`suite/slowvote/${poll.record.id}/notifications`, undefined, 'bob');
    assert.equal((await f.request(`suite/slowvote/${poll.record.id}/notifications`, { expectedPreferenceVersion: 0, expectedAccessEpoch: pref.body.accessEpoch, following: 'following', muted: false, email: false }, 'bob')).status, 200);
    const choices = poll.record.data.choices as { id: string }[]; const vote = await f.request(`suite/slowvote/${poll.record.id}/vote`, { expectedVersion: poll.record.version, choiceIds: [choices[0]!.id] }, 'carol'); assert.equal(vote.status, 200, JSON.stringify(vote.body)); poll = vote.body;
    const notice = (await f.inbox()).items[0]!; assert.equal(notice.event.kind, 'suite_vote'); assert.ok(!JSON.stringify(notice).includes(choices[0]!.id));
    const privacy = await f.request(`suite/slowvote/${poll.record.id}/edit`, { expectedVersion: poll.record.version, title: poll.record.title, description: '', responseVisibility: 'owner' }); assert.equal(privacy.status, 200, JSON.stringify(privacy.body)); poll = privacy.body;
    assert.ok(!(await f.inbox()).items.some(item => item.id === notice.id));
    assert.equal((await f.request(`suite/slowvote/${poll.record.id}/vote`, { expectedVersion: poll.record.version, choiceIds: [choices[1]!.id] }, 'carol')).status, 200);
    assert.ok(!(await f.inbox()).items.some(item => item.event.kind === 'suite_vote'));
  } finally { await f.close(); }
});
