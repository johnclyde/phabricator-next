import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Store } from './store.ts';
import { createApp } from './app.ts';
import { createAuth } from './auth.ts';
import type { SuiteDetail } from '../shared/suite.ts';
import type { SlowvoteView } from '../shared/slowvote.ts';
import type { PhameBlogData, PhamePostData } from '../shared/phame.ts';

async function fixture() {
  const store = new Store({ path: ':memory:' }), provisioning = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  const owner = await provisioning.createAccount({ username: 'owner', displayName: 'Owner', password: 'Authority owner testing passphrase' });
  const writer = await provisioning.createAccount({ username: 'writer', displayName: 'Writer', password: 'Authority writer testing passphrase' });
  const editor = await provisioning.createAccount({ username: 'editor', displayName: 'Editor', password: 'Authority editor testing passphrase' });
  const reader = await provisioning.createAccount({ username: 'reader', displayName: 'Reader', password: 'Authority reader testing passphrase' });
  const app = createApp({ store, seed: false, authMode: 'password' }); const actors = { owner, writer, editor, reader };
  const tokens = Object.fromEntries(Object.entries(actors).map(([name, person]) => [name, app.auth.createToken(person.id, { name: 'Authority test', scopes: ['read', 'write'] }).token]));
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  async function request(path: string, body?: unknown, who: keyof typeof actors = 'owner', key = randomUUID()) {
    const response = await fetch(`${base}/api/suite/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${tokens[who]}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': key }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as SuiteDetail };
  }
  return { ...app, ...actors, request, close: async () => { await app.close(); store.close(); } };
}

test('Phame selected private readers survive role merging without gaining editorial rights', async () => {
  const f = await fixture(); try {
    const created = await f.request('phame', { kind: 'blog', title: 'Private editorial team', authorIds: [f.writer.id], editorIds: [f.editor.id], access: { visibility: 'members', memberIds: [f.reader.id] } }); assert.equal(created.status, 201, JSON.stringify(created.body)); const id = created.body.record.id;
    assert.deepEqual(new Set(created.body.record.access.memberIds), new Set([f.reader.id, f.writer.id, f.editor.id]));
    const reader = await f.request(`phame/${id}`, undefined, 'reader'); assert.equal(reader.status, 200); assert.equal(reader.body.canEdit, false); assert.equal((await f.request(`phame/${id}/members`, { expectedVersion: 1, editorIds: [f.reader.id] }, 'reader')).status, 403);
    assert.equal((await f.request('phame', { kind: 'post', blogId: id, title: 'Injected', body: 'Not authorized' }, 'reader')).status, 403);
    const draft = await f.request('phame', { kind: 'post', blogId: id, title: 'Draft', body: 'Private draft' }, 'writer'); assert.equal(draft.status, 201); assert.equal((await f.request(`phame/${draft.body.record.id}`, undefined, 'reader')).status, 404);
    const published = await f.request(`phame/${draft.body.record.id}/publish`, { expectedVersion: 1 }, 'writer'); assert.equal(published.status, 200); assert.equal((await f.request(`phame/${draft.body.record.id}`, undefined, 'reader')).status, 200);
  } finally { await f.close(); }
});

test('Phame inherited objects cannot broaden access and current ACL revocation removes draft editors', async () => {
  const f = await fixture(); try {
    const created = await f.request('phame', { kind: 'blog', title: 'Roles', authorIds: [f.writer.id], editorIds: [f.editor.id] }); const blogId = created.body.record.id;
    const draft = await f.request('phame', { kind: 'post', blogId, title: 'Private', body: 'Do not publish', access: { visibility: 'workspace', editorIds: [f.reader.id] } }, 'writer'); assert.equal(draft.status, 201); const id = draft.body.record.id;
    assert.equal((await f.request(`phame/${id}`, undefined, 'reader')).status, 404); assert.equal((await f.request(`phame/${id}/access`, { expectedVersion: 1, access: { visibility: 'workspace', editorIds: [f.reader.id] } }, 'writer')).status, 409);
    assert.equal((await f.request(`phame/${id}`, undefined, 'editor')).body.canEdit, true);
    const updated = await f.request(`phame/${blogId}/access`, { expectedVersion: 1, access: { editorIds: [] } }); assert.equal(updated.status, 200); assert.deepEqual((updated.body.record.data as unknown as PhameBlogData).editorIds, []);
    assert.equal((await f.request(`phame/${id}`, undefined, 'editor')).status, 404); assert.equal((await f.request(`phame/${id}/publish`, { expectedVersion: 1 }, 'editor')).status, 404);
    const observed = await f.request(`phame/${id}`, undefined, 'owner'); assert.equal(observed.body.record.version, 1); assert.equal((observed.body.record.data as unknown as PhamePostData).status, 'draft');
  } finally { await f.close(); }
});

test('Slowvote old successful vote receipts never recover withdrawn result visibility or another person identity', async () => {
  const f = await fixture(); try {
    const created = await f.request('slowvote', { kind: 'poll', title: 'Restricted results', choices: ['One', 'Two'], responseVisibility: 'always' }), id = created.body.record.id;
    const vote = { expectedVersion: 1, choiceIds: ['option-1'] }, key = randomUUID(); const first = await f.request(`slowvote/${id}/vote`, vote, 'writer', key); assert.equal(first.status, 200); assert.equal((first.body.record.data as unknown as SlowvoteView).voterCount, 1);
    const hidden = await f.request(`slowvote/${id}/edit`, { expectedVersion: 2, title: 'Restricted results', responseVisibility: 'owner' }); assert.equal(hidden.status, 200);
    const replay = await f.request(`slowvote/${id}/vote`, vote, 'writer', key); assert.equal(replay.status, 200); const data = replay.body.record.data as unknown as SlowvoteView; assert.equal(data.results, null); assert.equal(data.voterCount, null); assert.deepEqual(data.ownChoiceIds, ['option-1']); assert.equal(replay.body.record.version, 3);
    const thirdParty = await f.request(`slowvote/${id}`, undefined, 'reader'); assert.equal((thirdParty.body.record.data as unknown as SlowvoteView).results, null); assert.equal(thirdParty.body.events.some(event => event.action === 'vote'), false); assert.equal(JSON.stringify(thirdParty.body).includes(f.writer.id), false);
    assert.equal(f.store.database.prepare('SELECT count(*) AS n FROM suite_history WHERE record_id=?').get(id)!.n, 3);
  } finally { await f.close(); }
});

test('Generic access editors never gain ownership-only Slowvote administration', async () => {
  const f = await fixture(); try {
    const created = await f.request('slowvote', { kind: 'poll', title: 'Owner rights', choices: ['Yes', 'No'], access: { visibility: 'members', editorIds: [f.editor.id] } }), id = created.body.record.id;
    const shared = await f.request(`slowvote/${id}`, undefined, 'editor'); assert.equal(shared.status, 200); assert.equal(shared.body.canEdit, false);
    assert.equal((await f.request(`slowvote/${id}/access`, { expectedVersion: 1, access: { editorIds: [f.reader.id] } }, 'editor')).status, 403); assert.equal((await f.request(`slowvote/${id}/close`, { expectedVersion: 1 }, 'editor')).status, 403);
    const vote = await f.request(`slowvote/${id}/vote`, { expectedVersion: 1, choiceIds: ['option-1'] }, 'editor'); assert.equal(vote.status, 200); assert.equal(vote.body.record.version, 2);
  } finally { await f.close(); }
});


test('Phame post creation inherits its blog Space without requiring access to the default Space', async () => {
  const f = await fixture(); try {
    const members = { kind: 'principals' as const, principalIds: [f.owner.id, f.writer.id] };
    const space = f.policies.createSpace({ name: 'Editorial Space', description: '', view: members, edit: { kind: 'principals', principalIds: [f.owner.id] } }, f.owner.id);
    const created = await f.request('phame', { kind: 'blog', title: 'Separate Space blog', authorIds: [f.writer.id], access: { spaceId: space.id } }); assert.equal(created.status, 201);
    const defaultSpace = f.policies.getSpace('S1', f.owner.id);
    f.policies.updateSpace('S1', { expectedVersion: defaultSpace.version, name: defaultSpace.name, description: defaultSpace.description, archived: false, view: { kind: 'principals', principalIds: [f.owner.id] }, edit: { kind: 'principals', principalIds: [f.owner.id] } }, f.owner.id);
    const draft = await f.request('phame', { kind: 'post', blogId: created.body.record.id, title: 'Valid author', body: 'Inherited audience', access: { spaceId: 'S1' } }, 'writer');
    assert.equal(draft.status, 201, JSON.stringify(draft.body)); assert.equal(draft.body.record.access.spaceId, space.id);
    assert.equal((await f.request(`phame/${draft.body.record.id}/publish`, { expectedVersion: 1 }, 'writer')).status, 200);
    assert.equal((await f.request(`phame/${draft.body.record.id}`, undefined, 'reader')).status, 404);
  } finally { await f.close(); }
});
