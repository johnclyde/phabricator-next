import assert from 'node:assert/strict';
import test from 'node:test';
import { phameModule as module } from './suite-phame.ts';
import type { SuiteContext } from './suite-contract.ts';
import type { SuiteRecord } from '../shared/suite.ts';
import type { PhameBlogData, PhamePostData } from '../shared/phame.ts';
import { HttpError } from './validation.ts';
function fixture() {
  const records = new Map<string, SuiteRecord>(), hidden = new Set<string>(); let counter = 0;
  const context = (who = 'owner'): SuiteContext => {
    const ctx: SuiteContext = { actor: { principalId: who, displayName: who, workspaceId: 'w', kind: 'local', credentialId: null, sessionContext: null, scopes: ['read', 'write'] }, now: '2026-10-13T12:00:00Z', get(id) { const record = records.get(id); if (!record || hidden.has(id)) throw new HttpError(404, 'Not found'); return record; }, list: () => [...records.values()], exists: (_app, kind, predicate) => [...records.values()].some(record => record.kind === kind && predicate(record)), canEdit: record => module.canEdit!(record, ctx), requireEdit(record) { if (!ctx.canEdit(record)) throw new HttpError(403, 'Forbidden'); }, requirePerson(id) { if (id === 'disabled') throw new HttpError(400, 'Inactive person'); return { id, displayName: id }; } }; return ctx;
  };
  function create(input: unknown, who = 'owner'): SuiteRecord { const value = module.create(input, context(who)); const record: SuiteRecord = { ...value, id: `J${++counter}`, app: 'phame', ownerId: who, version: 1, access: { spaceId: 'S1', visibility: 'workspace', memberIds: [], editorIds: [], ...value.access }, createdAt: context().now, updatedAt: context().now }; records.set(record.id, record); return record; }
  function act(record: SuiteRecord, action: string, input: unknown = {}, who = 'owner'): SuiteRecord { const value = module.command(record, action, input, context(who)); const changed: SuiteRecord = { ...record, ...value, access: { ...record.access, ...value.access }, version: record.version + 1 }; records.set(record.id, changed); return changed; }
  const blog = create({ kind: 'blog', title: 'Research', authorIds: ['writer'], editorIds: ['editor'] });
  const post = () => create({ kind: 'post', blogId: blog.id, title: 'Methods', body: 'Draft source.' }, 'writer');
  return { records, hidden, context, create, act, blog, post };
}
test('Phame separates blog author permission from administration', () => {
  const f = fixture(); assert.equal(module.canEdit!(f.blog, f.context('writer')), false); assert.equal(module.canEdit!(f.blog, f.context('editor')), true); assert.equal(f.post().ownerId, 'writer');
  assert.throws(() => f.create({ kind: 'post', blogId: f.blog.id, title: 'No', body: 'No' }, 'reader'), /authors and editors/); assert.throws(() => f.act(f.blog, 'members', { editorIds: ['writer'] }, 'writer'), /Forbidden/);
});
test('Phame drafts and archives are visible only to author/current blog editors', () => {
  const f = fixture(); const post = f.post(); assert.equal(module.canView!(post, f.context('reader')), false); assert.equal(module.canView!(post, f.context('writer')), true); assert.equal(module.canView!(post, f.context('editor')), true);
  const published = f.act(post, 'publish', {}, 'writer'); assert.equal(module.canView!(published, f.context('reader')), true); const archived = f.act(published, 'archive', {}, 'editor'); assert.equal(module.canView!(archived, f.context('reader')), false);
});
test('Phame posts inherit current parent access and edits do not retain revoked editor rights', () => {
  const f = fixture(); const post = f.post(); assert.equal(module.accessSource!(post), f.blog.id); assert.equal(module.canEdit!(post, f.context('editor')), true);
  f.act(f.blog, 'members', { editorIds: ['new-editor'] }); assert.equal(module.canEdit!(post, f.context('editor')), false); assert.equal(module.canEdit!(post, f.context('new-editor')), true);
  f.hidden.add(f.blog.id); assert.throws(() => module.canView!(post, f.context('writer')), /Not found/); assert.throws(() => f.act(post, 'publish', {}, 'writer'), /Not found/);
});
test('Phame content history preserves exact versions while hiding unpublished drafts from readers', () => {
  const f = fixture(); let post = f.post(); post = f.act(post, 'edit', { title: 'Methods revised', body: 'Second secret draft.', subtitle: 'Background' }, 'writer'); post = f.act(post, 'publish', {}, 'writer');
  const current = f.act(post, 'edit', { title: 'Methods revised', body: 'Published revision.', subtitle: 'Background' }, 'editor');
  const publicData = module.present!(current, f.context('reader')).data as unknown as PhamePostData; assert.deepEqual(publicData.revisions.map(revision => revision.version), [3, 4]); assert.equal(JSON.stringify(publicData).includes('Draft source.'), false);
  const editorData = module.present!(current, f.context('editor')).data as unknown as PhamePostData; assert.equal(editorData.revisions.length, 4); assert.equal(editorData.revisions[0]?.body, 'Draft source.'); assert.equal(editorData.revisions[1]?.body, 'Second secret draft.');
});
test('Phame unpublish and restore explicitly return to draft and clear publish time', () => {
  const f = fixture(); let post = f.act(f.post(), 'publish', {}, 'writer'); assert.equal((post.data as unknown as PhamePostData).publishedAt, f.context().now);
  post = f.act(post, 'unpublish', {}, 'writer'); assert.equal((post.data as unknown as PhamePostData).publishedAt, null); assert.equal(module.canView!(post, f.context('reader')), false);
  post = f.act(post, 'archive', {}, 'writer'); assert.throws(() => f.act(post, 'publish', {}, 'writer'), /Only a draft/); post = f.act(post, 'restore', {}, 'writer'); assert.equal((post.data as unknown as PhamePostData).status, 'draft');
});
test('Phame archived blog blocks new posts, publication, edits and discussion', () => {
  const f = fixture(); const draft = f.post(), published = f.act(draft, 'publish', {}, 'writer'); f.act(f.blog, 'archive');
  assert.throws(() => f.post(), /Restore the blog/); assert.throws(() => f.act(published, 'edit', { title: 'Changed', body: 'Changed' }, 'writer'), /Restore the blog/); assert.throws(() => f.act(published, 'comment', { body: 'Hi' }, 'reader'), /Restore the blog/);
  assert.equal(module.canView!(published, f.context('reader')), true);
});
test('Phame published comments preserve current actor; drafts are not discussion channels', () => {
  const f = fixture(); const post = f.post(); assert.throws(() => f.act(post, 'comment', { body: 'Hi' }, 'writer'), /Publish the post/);
  const changed = f.act(f.act(post, 'publish', {}, 'writer'), 'comment', { body: 'A useful result.' }, 'reader'); assert.equal((changed.data as unknown as PhamePostData).comments[0]?.actorId, 'reader'); assert.equal(module.canEdit!(changed, f.context('reader')), false);
  assert.throws(() => f.act(changed, 'comment', { body: 'Hi', actorId: 'writer' }, 'reader'), /Unknown field/);
});
test('Phame roles validate active people and keep nonrole members when changing roles', () => {
  const f = fixture(); assert.throws(() => f.act(f.blog, 'members', { authorIds: ['disabled'] }), /Inactive person/); f.blog.access.memberIds.push('reader');
  const changed = f.act(f.blog, 'members', { authorIds: ['next-author'], editorIds: [] }); assert.deepEqual(changed.access.memberIds.sort(), ['next-author', 'reader']); assert.deepEqual((changed.data as unknown as PhameBlogData).editorIds, []);
});
test('Phame validates kind-specific inputs and never accepts domains or caller publication states', () => {
  const f = fixture(); assert.throws(() => f.create({ kind: 'blog', title: 'External', domain: 'example.org' }), /Unknown field/); assert.throws(() => f.create({ kind: 'post', title: 'Forged', blogId: f.blog.id, status: 'published' }, 'writer'), /Unknown field/); assert.throws(() => f.create({ kind: 'blog', title: 'No', body: 'No' }), /Unknown field/);
  const empty = f.create({ kind: 'post', blogId: f.blog.id, title: 'Empty' }, 'writer'); assert.throws(() => f.act(empty, 'publish', {}, 'writer'), /Write the post/);
});
test('Phame generic access edits and role controls share current editor authority', () => {
  const f = fixture(); const changed = { ...f.blog, access: { ...f.blog.access, editorIds: ['policy-editor'] } }; f.records.set(changed.id, changed);
  assert.equal(module.canEdit!(changed, f.context('editor')), false); assert.equal(module.canEdit!(changed, f.context('policy-editor')), true);
  assert.deepEqual((module.present!(changed, f.context('owner')).data as unknown as PhameBlogData).editorIds, ['policy-editor']);
  const updated = f.act(changed, 'members', { authorIds: ['writer'] }); assert.deepEqual(updated.access.editorIds, ['policy-editor']);
});
