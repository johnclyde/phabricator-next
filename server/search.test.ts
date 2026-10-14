import test from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { createStore } from './store.ts';
import { createAuth } from './auth.ts';
import { readManiphestConfig, writeManiphestConfig } from './maniphest.ts';
import { PolicyStore } from './policy.ts';
import { SuiteService } from './suite.ts';
import { initializeSearch, SearchService, searchRequest } from './search.ts';
import { emptySearchQuery, parseSearchQuery, searchTerms, searchParameters, type SavedSearchReceipt, type SavedSearchList, type SearchPage } from '../shared/search.ts';
import type { AuthContext } from '../shared/auth.ts';
import type { ActorAttribution } from '../shared/types.ts';
import type { SuiteDetail } from '../shared/suite.ts';

function fixture(mode: 'local' | 'password' = 'local') {
  const store = createStore({ path: ':memory:' }); initializeSearch(store.database);
  const auth = createAuth({ database: store.database, mode, basePath: '/', provisioning: true });
  const policies = new PolicyStore(store.database, { principalExists: id => auth.listAccounts().some(account => account.id === id && !account.disabled) || mode === 'local' && id === `local:${auth.workspaceId}` });
  const suite = new SuiteService(store, auth, policies), search = new SearchService(store, auth, policies, suite);
  const actor = () => auth.authenticate({ headers: {} } as IncomingMessage, 'write');
  const tokenActor = (id: string) => { const token = auth.createToken(id, { name: 'Search tests', scopes: ['read', 'write'] }); return auth.authenticate({ headers: { authorization: `Bearer ${token.token}` } } as IncomingMessage, 'write'); };
  const attribution = (context = actor()): ActorAttribution => ({ principalId: context.principalId, displayName: context.displayName, credentialId: context.credentialId, requestId: randomUUID() });
  const run = (input: Record<string, unknown> = {}, context = actor(), limit = 50, cursor: string | null = null) => search.read('/api/search', searchParameters(parseSearchQuery(input), limit, cursor), context) as SearchPage;
  const save = (input: Record<string, unknown>, context = actor(), path = '/api/search/queries', key: string = randomUUID()) => search.mutate('POST', path, input, key, context).body as SavedSearchReceipt;
  return { store, auth, policies, suite, search, actor, tokenActor, attribution, run, save, close: () => store.close() };
}

test('portable parser has literal terms, quoted phrases, prefixes, exclusions and canonical typed filters', () => {
  const parsed = parseSearchQuery({ text: '  "legal motion" evid* -obsolete ', kinds: ['task', 'task', 'wiki'], projectIds: ['PROJ2', 'PROJ1'], createdAfter: '2026-01-01' });
  assert.equal(parsed.text, '"legal motion" evid* -obsolete'); assert.deepEqual(parsed.kinds, ['task', 'wiki']); assert.equal(parsed.createdAfter, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(searchTerms(parsed.text), [{ text: 'legal motion', exclude: false, prefix: false }, { text: 'evid', exclude: false, prefix: true }, { text: 'obsolete', exclude: true, prefix: false }]);
  assert.deepEqual(searchTerms('OR NEAR(foo) title:admin').map(term => term.text), ['OR', 'NEAR(foo)', 'title:admin']);
  assert.deepEqual(searchRequest(searchParameters(parsed)), { ...parsed, limit: 50, cursor: null });
  for (const input of [{ unsupported: true }, { kinds: ['secret'] }, { statuses: 'open' }, { text: '"unclosed' }, { text: '-only' }, { text: '***' }, { createdAfter: '2026-02-30' }, { createdAfter: '2026-02-02', createdBefore: '2026-02-01' }, { order: 'sql' }]) assert.throws(() => parseSearchQuery(input));
  for (const params of ['text=a&text=b', 'unknown=a', 'limit=0', 'limit=101', 'limit=1e1', 'kinds=task', 'cursor=bad']) assert.throws(() => searchRequest(new URLSearchParams(params)));
});

test('migration is repeatable and refuses conflicting tables atomically', () => {
  const db = new DatabaseSync(':memory:');
  try { initializeSearch(db); initializeSearch(db); assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 0); }
  finally { db.close(); }
  const invalid = new DatabaseSync(':memory:');
  try { invalid.exec('CREATE TABLE search_query_operations(wrong TEXT)'); assert.throws(() => initializeSearch(invalid), /Unexpected search_query_operations/); assert.equal(invalid.prepare("SELECT 1 FROM sqlite_master WHERE name='search_queries'").get(), undefined); }
  finally { invalid.close(); }
});

test('FTS indexes current sources, task comments, published wiki, paste content and searchable object metadata', () => {
  const f = fixture();
  try {
    const actor = f.actor(), by = f.attribution(actor);
    const task = f.store.createTask({ title: 'Procedural research', description: 'The café contains running evidence and a legal motion.', priority: 'high' }, by);
    f.store.createTaskComment(task.id, { body: 'Commentary quasar material' }, by);
    const revision = f.store.createRevision({ title: 'Clinical paper', kind: 'paper', summary: 'An orbital summary', testPlan: 'Check the proof', files: [{ path: 'main.tex', content: '\\section{Astronomy} currentNebula proof' }] }, by);
    const wiki = f.store.createDocument({ title: 'Notebook', slug: '/', content: 'An independent spectral derivation' }, by);
    f.store.pastes.create({ title: 'A snippet', content: 'Hermitian operators have real eigenvalues' }, by);
    f.store.createProject({ name: 'Linguistics', description: 'Morphological dialect studies' }, by);
    f.store.createRepository({ name: 'Archive', description: 'Palaeography evidence', remoteUrl: 'https://example.test/research.git' }, by);
    assert.deepEqual(f.run({ text: 'cafe run*' }).items.map(item => item.id), [task.id], 'diacritics and explicit prefixes work');
    assert.equal(f.run({ text: '"legal motion" evid* -obsolete' }).total, 1);
    assert.equal(f.run({ text: 'quasar' }).items[0]!.id, task.id);
    assert.equal(f.run({ text: 'currentNebula' }).items[0]!.id, revision.revision.id);
    assert.equal(f.run({ text: 'spectral' }).items[0]!.id, wiki.id);
    assert.equal(f.run({ text: 'Hermitian' }).items[0]!.kind, 'paste');
    assert.equal(f.run({ text: 'Morphological' }).items[0]!.kind, 'project');
    assert.equal(f.run({ text: 'Palaeography' }).items[0]!.kind, 'repository');
    assert.equal(f.run({ text: task.id }).items[0]!.id, task.id);
    assert.equal(f.run({ text: 'cafe', kinds: ['wiki'] }).total, 0);
    const result = f.run({ text: 'quasar' }).items[0]!;
    assert.ok(result.snippet.includes('quasar')); assert.equal('text' in result, false); assert.equal('description' in result, false);
  } finally { f.close(); }
});

test('changed content is immediate and rollback never creates stale search documents', () => {
  const f = fixture(); try {
    const task = f.store.createTask({ title: 'OriginalName', description: 'obsoleteToken' }, f.attribution());
    assert.equal(f.run({ text: 'obsoleteToken' }).total, 1);
    f.store.updateTask(task.id, { expectedVersion: 1, title: 'ChangedName', description: 'replacementToken' }, f.attribution());
    assert.equal(f.run({ text: 'obsoleteToken' }).total, 0); assert.equal(f.run({ text: 'replacementToken' }).total, 1);
    assert.throws(() => f.store.transaction(() => { f.store.createTask({ title: 'rolledbackToken' }); throw new Error('abort'); }));
    assert.equal(f.run({ text: 'rolledbackToken' }).total, 0);
    const revision = f.store.createRevision({ title: 'Source', kind: 'code', summary: '', testPlan: 'Test', files: [{ path: 'file.ts', content: 'removedSourceMarker' }] }, f.attribution());
    f.store.createVersion(revision.revision.id, { expectedVersion: 1, message: 'Replace source', files: [{ path: 'file.ts', content: 'currentSourceMarker' }] }, f.attribution());
    assert.equal(f.run({ text: 'removedSourceMarker' }).total, 0); assert.equal(f.run({ text: 'currentSourceMarker' }).total, 1);
  } finally { f.close(); }
});

test('structured task filters, dates and deterministic paging are validated against the visible snapshot', () => {
  const f = fixture(); try {
    const by = f.attribution(), project = f.store.createProject({ name: 'Physics' }, by);
    const first = f.store.createTask({ title: 'Alpha', priority: 'high', projectIds: [project.id], ownerId: f.actor().principalId }, by);
    f.store.createTask({ title: 'Beta', priority: 'low' }, by); f.store.createTask({ title: 'Gamma', priority: 'high', status: 'resolved' }, by);
    assert.equal(f.run({ kinds: ['task'], statuses: ['open'], priorities: ['high'], ownerIds: ['me'], projectIds: [project.id] }).items[0]!.id, first.id);
    assert.equal(f.run({ kinds: ['task'], ownerIds: ['none'] }).total, 2);
    assert.equal(f.run({ kinds: ['task'], createdBefore: '2000-01-01' }).total, 0);
    assert.equal(f.run({ kinds: ['task'], createdAfter: '2000-01-01', updatedBefore: '2999-01-01' }).total, 3);
    const query = { kinds: ['task'], order: 'title' }, page = f.run(query, f.actor(), 1);
    assert.equal(page.total, 3); assert.equal(page.items[0]!.title, 'Alpha'); assert.ok(page.nextCursor);
    const second = f.run(query, f.actor(), 1, page.nextCursor); assert.equal(second.items[0]!.title, 'Beta');
    const third = f.run(query, f.actor(), 1, second.nextCursor); assert.equal(third.items[0]!.title, 'Gamma'); assert.equal(third.nextCursor, null);
    assert.throws(() => f.run({ kinds: ['task'], order: 'created' }, f.actor(), 1, page.nextCursor), /different query/);
    const changedCursor = `${page.nextCursor!.slice(0, -3)}bad`; assert.throws(() => f.run(query, f.actor(), 1, changedCursor), /Invalid search cursor/);
    f.store.updateTask(first.id, { expectedVersion: first.version, description: 'Changed even if sort key stays the same' }, by);
    assert.throws(() => f.run(query, f.actor(), 1, page.nextCursor), /results changed/i);
  } finally { f.close(); }
});

test('denied objects never affect counts, snippets, relevance or paging; policy changes invalidate cursors', async () => {
  const f = fixture('password'); try {
    const alice = await f.auth.createAccount({ username: 'alice', displayName: 'Alice', password: 'Alice password sufficiently long' }), bob = await f.auth.createAccount({ username: 'bob', displayName: 'Bob', password: 'Bob password sufficiently long' });
    const a = f.tokenActor(alice.id), b = f.tokenActor(bob.id);
    const publicTask = f.store.createTask({ title: 'Shared evidence' }, f.attribution(a));
    f.store.createTask({ title: 'Shared second evidence' }, f.attribution(a));
    const secret = f.store.createTask({ title: 'SecretEvidenceMarker', description: 'evidence evidence evidence' }, f.attribution(a));
    const policy = f.policies.policy(secret.id, a.principalId); f.policies.setPolicy(secret.id, { expectedVersion: policy.version, spaceId: policy.spaceId, ...policy.rules, view: { kind: 'principals', principalIds: [alice.id] } }, alice.id);
    assert.equal(f.run({ text: 'SecretEvidenceMarker' }, b).total, 0);
    const page = f.run({ text: 'evidence', kinds: ['task'] }, b, 1); assert.equal(page.total, 2); assert.ok(page.nextCursor); assert.equal(JSON.stringify(page).includes(secret.id), false);
    assert.equal(f.run({ text: 'evidence', kinds: ['task'] }, a).total, 3);
    assert.throws(() => f.run({ text: 'evidence', kinds: ['task'] }, a, 1, page.nextCursor), /different query/);
    const sharedPolicy = f.policies.policy(publicTask.id, alice.id); f.policies.setPolicy(publicTask.id, { expectedVersion: sharedPolicy.version, spaceId: sharedPolicy.spaceId, ...sharedPolicy.rules, view: { kind: 'principals', principalIds: [alice.id] } }, alice.id);
    assert.throws(() => f.run({ text: 'evidence', kinds: ['task'] }, b, 1, page.nextCursor), /results changed/i);
    assert.equal(f.run({ text: 'evidence' }, b).total, 1);
  } finally { f.close(); }
});

test('saved query CRUD preserves exact retries, expected versions, uniqueness and durable deletion', () => {
  const f = fixture(); try {
    const actor = f.actor(), input = { name: 'Active work', visibility: 'private', query: emptySearchQuery() };
    const created = f.save(input, actor, '/api/search/queries', 'create-key'), id = created.query!.id;
    assert.equal(created.receipt.version, 1); assert.equal(created.receipt.replayed, false);
    assert.equal(f.save(input, actor, '/api/search/queries', 'create-key').receipt.replayed, true);
    assert.throws(() => f.save({ ...input, name: 'Changed' }, actor, '/api/search/queries', 'create-key'), /different request/);
    assert.throws(() => f.save({ ...input, name: 'ACTIVE WORK' }), /already have/);
    const changed = f.save({ ...input, name: 'Public work', visibility: 'workspace', expectedVersion: 1 }, actor, `/api/search/queries/${id}`, 'edit-key');
    assert.equal(changed.query!.version, 2);
    const retry = f.save(input, actor, '/api/search/queries', 'create-key'); assert.equal(retry.receipt.version, 1); assert.equal(retry.query!.version, 2);
    assert.throws(() => f.save({ ...input, expectedVersion: 1 }, actor, `/api/search/queries/${id}`), /changed/);
    const removed = f.save({ expectedVersion: 2 }, actor, `/api/search/queries/${id}/delete`, 'delete-key'); assert.equal(removed.query, null);
    assert.equal(f.save({ expectedVersion: 2 }, actor, `/api/search/queries/${id}/delete`, 'delete-key').receipt.replayed, true);
    assert.equal(f.save(input, actor, '/api/search/queries', 'create-key').query, null);
    assert.equal((f.search.read('/api/search/queries', new URLSearchParams(), actor) as SavedSearchList).queries.length, 0);
    assert.throws(() => f.search.read(`/api/search/queries/${id}`, new URLSearchParams(), actor), /unavailable/);
    assert.throws(() => f.store.database.prepare('DELETE FROM search_queries WHERE id=?').run(id), /tombstones/);
  } finally { f.close(); }
});

test('private and explicitly shared queries enforce owner edits and current referenced-project access', async () => {
  const f = fixture('password'); try {
    const alice = await f.auth.createAccount({ username: 'alice', displayName: 'Alice', password: 'Alice password sufficiently long' }), bob = await f.auth.createAccount({ username: 'bob', displayName: 'Bob', password: 'Bob password sufficiently long' });
    const a = f.tokenActor(alice.id), b = f.tokenActor(bob.id), query = emptySearchQuery();
    const personal = f.save({ name: 'PrivatePhraseMarker', visibility: 'private', query }, a);
    assert.throws(() => f.search.read(`/api/search/queries/${personal.query!.id}`, new URLSearchParams(), b), /unavailable/);
    const shared = f.save({ name: 'Shared query', visibility: 'workspace', query }, a), id = shared.query!.id;
    assert.equal((f.search.read('/api/search/queries', new URLSearchParams(), b) as SavedSearchList).queries.length, 1);
    assert.throws(() => f.save({ name: 'Steal', visibility: 'private', query, expectedVersion: 1 }, b, `/api/search/queries/${id}`), /unavailable/);
    f.save({ name: 'Shared query', visibility: 'private', query, expectedVersion: 1 }, a, `/api/search/queries/${id}`);
    assert.equal((f.search.read('/api/search/queries', new URLSearchParams(), b) as SavedSearchList).queries.length, 0);
    const project = f.store.createProject({ name: 'PrivateProject' }, f.attribution(a));
    f.save({ name: 'Project query', visibility: 'workspace', query: { ...query, projectIds: [project.id] } }, a);
    const policy = f.policies.policy(project.id, alice.id); f.policies.setPolicy(project.id, { expectedVersion: policy.version, spaceId: policy.spaceId, ...policy.rules, view: { kind: 'principals', principalIds: [alice.id] } }, alice.id);
    assert.equal((f.search.read('/api/search/queries', new URLSearchParams(), b) as SavedSearchList).queries.length, 0);
    assert.throws(() => f.save({ name: 'Hidden project', visibility: 'private', query: { ...query, projectIds: [project.id] } }, b), /unavailable/);
  } finally { f.close(); }
});

test('searches suite current bodies without importing ballot, signature or historical draft fields', () => {
  const f = fixture(); try {
    const actor = f.actor();
    const create = (app: string, input: unknown) => (f.suite.mutate('POST', `/api/suite/${app}`, input, randomUUID(), actor).body as SuiteDetail).record;
    const room = create('conpherence', { title: 'Research room', topic: 'Discussion', message: 'conversationNebula' });
    create('slowvote', { title: 'Choose', description: 'ballotDescriptionMarker', choices: ['Alternate nebula', 'Original'], method: 'single', responseVisibility: 'owner' });
    const legal = create('legalpad', { title: 'Agreement', text: 'agreementNebula', preamble: 'Carefully', signatureType: 'none' });
    const blog = create('phame', { kind: 'blog', title: 'Journal', description: 'blogNebula' });
    const post = create('phame', { kind: 'post', title: 'Draft', blogId: blog.id, body: 'privateDraftMarker' });
    assert.equal(f.run({ text: 'conversationNebula' }).items[0]!.id, room.id); assert.equal(f.run({ text: 'agreementNebula' }).items[0]!.id, legal.id);
    assert.equal(f.run({ text: 'ballotDescriptionMarker' }).items[0]!.kind, 'slowvote'); assert.equal(f.run({ text: 'privateDraftMarker' }).total, 0);
    f.suite.mutate('POST', `/api/suite/phame/${post.id}/edit`, { expectedVersion: post.version, title: 'Published', body: 'publicBodyMarker' }, randomUUID(), actor);
    f.suite.mutate('POST', `/api/suite/phame/${post.id}/publish`, { expectedVersion: 2 }, randomUUID(), actor);
    assert.equal(f.run({ text: 'publicBodyMarker' }).items[0]!.id, post.id); assert.equal(f.run({ text: 'privateDraftMarker' }).total, 0);
  } finally { f.close(); }
});

test('a 1,000-document corpus is complete and bounded by paging rather than truncating matches', t => {
  const f = fixture(); try {
    f.store.transaction(() => { for (let i = 0; i < 1000; i++) f.store.createTask({ title: `Benchmark research ${i}`, description: `Corpus evidence number ${i}. A full text result including lexical content.` }); });
    const start = performance.now(), page = f.run({ text: 'research evid*', kinds: ['task'] }, f.actor(), 100), elapsed = performance.now() - start;
    assert.equal(page.total, 1000); assert.equal(page.items.length, 100); assert.ok(page.nextCursor);
    t.diagnostic(`Authorized projection + positional index + first page: ${elapsed.toFixed(0)} ms for 1,000 tasks.`);
    assert.ok(elapsed < 30_000, 'Search must finish a 1,000-task fixture in under 30 seconds.');
  } finally { f.close(); }
});

test('wiki draft and deleted content never enter the workspace index', () => {
  const f = fixture(); try {
    const by = f.attribution(), document = f.store.createDocument({ title: 'Notebook', slug: '/', content: 'publishedWikiMarker' }, by);
    const pins = (id: string) => { const current = f.store.documentDetail(id).document, publication = current.publication!; return { expectedVersion: current.version, expectedHeadVersionId: publication.headVersionId, expectedPublishedVersionId: publication.publishedVersionId, expectedPublicationRevision: publication.revision, expectedAccessEpoch: f.policies.epoch() }; };
    f.store.draftDocument(document.id, { ...pins(document.id), title: 'Unpublished title marker', content: 'privateWikiDraftMarker' }, by);
    assert.equal(f.run({ text: 'publishedWikiMarker' }).total, 1); assert.equal(f.run({ text: 'privateWikiDraftMarker' }).total, 0); assert.equal(f.run({ text: '"Unpublished title"' }).total, 0);
    f.store.deleteDocument(document.id, pins(document.id), by);
    assert.equal(f.run({ text: 'publishedWikiMarker' }).total, 0); assert.equal(f.run({ kinds: ['wiki'] }).total, 0);
  } finally { f.close(); }
});

test('saved query receipts reject altered evidence and revoked credentials cannot replay writes or read search', async () => {
  const f = fixture('password'); try {
    const account = await f.auth.createAccount({ username: 'alice', displayName: 'Alice', password: 'Alice password sufficiently long' }), actor = f.tokenActor(account.id);
    const input = { name: 'Recorded query', visibility: 'private', query: emptySearchQuery() };
    const saved = f.save(input, actor, '/api/search/queries', 'stable');
    const key = `search-query:${actor.workspaceId}:${actor.principalId}:stable`;
    f.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(JSON.stringify({ id: saved.receipt.id, version: 900, action: 'create' }), key);
    assert.throws(() => f.save(input, actor, '/api/search/queries', 'stable'), /receipt|recorded|response|original/i);
    f.auth.setAccountDisabled(account.id, true);
    assert.throws(() => f.run({}, actor)); assert.throws(() => f.save(input, actor, '/api/search/queries', 'another'));
    assert.equal(f.store.database.prepare('SELECT count(*) AS n FROM search_queries').get()!.n, 1);
  } finally { f.close(); }
});

test('source search reaches the end of large current files and returns a bounded relevant excerpt', () => {
  const f = fixture(); try {
    const revision = f.store.createRevision({ title: 'Large manuscript', kind: 'paper', summary: '', testPlan: 'Search the entire source', files: [{ path: 'main.tex', content: `${'ordinary repeated paragraph '.repeat(10000)}EndOfLargeSourceMarker` }] }, f.attribution());
    const found = f.run({ text: 'EndOfLargeSourceMarker' });
    assert.equal(found.total, 1); assert.equal(found.items[0]!.id, revision.revision.id); assert.ok(found.items[0]!.snippet.includes('EndOfLargeSourceMarker')); assert.ok(found.items[0]!.snippet.length <= 504);
  } finally { f.close(); }
});


test('configured task statuses, priorities and typed custom values participate in workspace search', () => {
  const f = fixture(); try {
    const config = structuredClone(readManiphestConfig(f.store.database)), { version, ...fields } = config;
    fields.statuses.push({ key: 'declined', name: 'Declined', closed: true, disabled: false });
    fields.priorities.push({ key: 'critical', name: 'Critical', rank: 100, disabled: false });
    fields.fields.push({ key: 'court', name: 'Court', type: 'text', required: false, disabled: false, options: [] }, { key: 'sealed', name: 'Sealed', type: 'boolean', required: false, disabled: false, options: [] }, { key: 'pages', name: 'Pages', type: 'integer', required: false, disabled: false, options: [] });
    f.store.transaction(() => writeManiphestConfig(f.store.database, { ...fields, expectedVersion: version }, f.actor().principalId));
    const task = f.store.createTask({ title: 'A filing', status: 'declined', priority: 'critical', customFields: { court: 'ChanceryMarker', sealed: false, pages: 42 } }, f.attribution());
    const results = f.run({ text: 'ChanceryMarker false 42', kinds: ['task'], statuses: ['declined'], priorities: ['critical'] });
    assert.equal(results.total, 1); assert.equal(results.items[0]!.id, task.id); assert.equal(results.items[0]!.status, 'declined');
  } finally { f.close(); }
});
