import test from 'node:test';
import assert from 'node:assert/strict';
import { conduitFailure, conduitResult, members, startWikiApi, workspace, type ConduitEnvelope } from './wiki-api-test-support.ts';

interface LegacyDocument { phid: string; uri: string; slug: string; version: number; authorPHID: null; title: string; content: string; status: string; description: string; dateCreated: number }
type Api = Awaited<ReturnType<typeof startWikiApi>>;
type Actor = keyof Api['tokens'];
async function write(app: Api, method: 'create' | 'edit', input: Record<string, unknown>, key?: string, actor: Actor = 'alice', token = app.tokens[actor].token) {
  return app.raw<ConduitEnvelope<LegacyDocument>>(`/api/phriction.${method}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(key ? { 'Idempotency-Key': key } : {}) }, body: new URLSearchParams({ params: JSON.stringify({ ...input, __conduit__: { token } }) }) });
}
function rows(app: Api, id: string) { return app.store.database.prepare('SELECT id, number, data FROM wiki_versions WHERE document_id=? ORDER BY number').all(id); }
function documentId(app: Api, slug: string): string { const row = app.store.database.prepare('SELECT document_id AS id FROM wiki_locations WHERE path=?').get(slug) as { id: string } | undefined; assert.ok(row); return row.id; }

test('Conduit create preserves raw source, whitespace and zero strings and returns the original legacy shape at both mounts', async () => {
  for (const basePath of ['/', '/workspace/']) {
    const app = await startWikiApi(basePath);
    try {
      const root = conduitResult(await write(app, 'create', { slug: '/', title: '  Root  ', content: '\ufeffRoot\r\n', description: '0' }));
      assert.deepEqual(Object.keys(root).sort(), ['phid', 'uri', 'slug', 'version', 'authorPHID', 'title', 'content', 'status', 'description', 'dateCreated'].sort());
      assert.equal(root.title, '  Root  '); assert.equal(root.content, '\ufeffRoot\r\n'); assert.equal(root.description, '0'); assert.equal(root.version, 1); assert.equal(root.status, 'exists'); assert.equal(root.authorPHID, null); assert.equal(root.uri, `${app.origin}${basePath}w/`);
      for (const [slug, title, content] of [['//Zero///', '0', '0'], ['Space Page?', ' \t ', '\r\n \t'], ['   ', 'Whitespace slug', 'Whitespace path source']]) {
        const saved = conduitResult(await write(app, 'create', { slug, title, content }));
        assert.equal(saved.title, title); assert.equal(saved.content, content); assert.equal(saved.description, ''); assert.equal(saved.version, 1);
        assert.equal(saved.slug, slug === '//Zero///' ? 'zero/' : slug === '   ' ? '_/' : 'space_page/');
        assert.equal(saved.uri, `${app.origin}${basePath}w/${saved.slug}`);
        const info = conduitResult(await app.conduit<LegacyDocument>('phriction.info', { slug })); assert.deepEqual(info, saved);
      }
      const form = conduitResult(await app.raw<ConduitEnvelope<LegacyDocument>>('/api/phriction.create', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ 'api.token': app.tokens.writer.token, slug: 'plain/', title: 'Plain', content: 'Exact + & % \r\n', description: 'Form notes' }) }));
      assert.equal(form.content, 'Exact + & % \r\n'); assert.equal(form.description, 'Form notes');
    } finally { await app.close(); }
  }
});

test('Conduit write validation rejects unsupported types and empty required values without leaking supplied secrets or allocating pages', async () => {
  const app = await startWikiApi();
  try {
    await app.document('/'); const page = await app.document('existing/'); const before = rows(app, page.id);
    for (const input of [
      { title: 'Title', content: 'Body' }, { slug: '', title: 'Title', content: 'Body' }, { slug: 'new/', content: 'Body' }, { slug: 'new/', title: 'Title' },
      { slug: 'new/', title: '', content: 'Body' }, { slug: 'new/', title: 'Title', content: '' }, { slug: 'new/', title: null, content: 'Body' },
      { slug: 'new/', title: 3, content: 'Body' }, { slug: 'new/', title: 'Title', content: ['secret'] }, { slug: 'new/', title: 'Title', content: 'Body', description: {} },
      { slug: 'new/', title: 'Title', content: 'Body', 'secret-field-do-not-echo': 'secret-value-do-not-echo' },
      { slug: 'new/', title: 'Title', content: '\ud800' }, { slug: 'new/', title: 'Title', content: 'a\0b' },
    ]) {
      const result = await write(app, 'create', input); conduitFailure(result, 'ERR-INVALID-PARAMETER'); assert.doesNotMatch(JSON.stringify(result.body), /secret-field|secret-value|\ud800/);
    }
    for (const input of [{ slug: '' }, { slug: 'existing/', title: false }, { slug: 'existing/', content: 0 }, { slug: 'existing/', description: [] }, { slug: 'existing/', expectedVersion: 1 }]) conduitFailure(await write(app, 'edit', input), 'ERR-INVALID-PARAMETER');
    assert.deepEqual(rows(app, page.id), before); assert.equal(app.store.database.prepare("SELECT COUNT(*) AS count FROM entities WHERE kind='document'").get()!.count, 2);
  } finally { await app.close(); }
});

test('Conduit edit drops falsey and equal fields, ignores description-only changes, and keeps immutable history untouched on no effect', async () => {
  const app = await startWikiApi();
  try {
    await app.document('/'); const first = conduitResult(await write(app, 'create', { slug: 'effects/', title: 'Published title', content: 'Published body', description: 'Original message' })); const id = documentId(app, first.slug), before = rows(app, id);
    const transactionCount = app.store.documentTransactions(id, { limit: 100 }).transactions.length;
    for (const patch of [{}, { description: 'Unrecorded message' }, { title: '', content: '' }, { title: '0', content: '0' }, { title: null, content: null, description: null }, { title: first.title, content: first.content, description: 'Still no effect' }]) {
      assert.deepEqual(conduitResult(await write(app, 'edit', { slug: first.slug, ...patch })), first);
      assert.deepEqual(rows(app, id), before);
    }
    assert.equal(app.store.documentTransactions(id, { limit: 100 }).transactions.length, transactionCount);
    const changed = conduitResult(await write(app, 'edit', { slug: first.slug, content: 'Changed exact body\r\n', description: '0' })); assert.equal(changed.version, 2); assert.equal(changed.title, first.title); assert.equal(changed.description, '0');
    const retitled = conduitResult(await write(app, 'edit', { slug: first.slug, title: ' \t ' })); assert.equal(retitled.version, 3); assert.equal(retitled.title, ' \t '); assert.equal(retitled.content, changed.content); assert.equal(retitled.description, '');
    assert.deepEqual(rows(app, id).slice(0, 1), before);
  } finally { await app.close(); }
});

test('Conduit legacy effects compare title against publication and body against head, then publish a clone of the published source', async () => {
  const app = await startWikiApi();
  try {
    await app.document('/'); const page = await app.document('draft-comparison/', { title: 'Published title', content: 'Published body' });
    await app.operation(page.id, 'drafts', { title: 'Draft title', content: 'Draft body', message: 'Unpublished draft' }); const draft = app.store.documentVersion(page.id, 2), before = rows(app, page.id);
    const noop = conduitResult(await write(app, 'edit', { slug: page.slug, title: page.title, content: draft.content, description: 'No surviving effects' })); assert.equal(noop.version, 1); assert.equal(noop.content, 'Published body'); assert.deepEqual(rows(app, page.id), before);
    const title = conduitResult(await write(app, 'edit', { slug: page.slug, title: 'New published title', content: draft.content, description: 'Only title survives' })); assert.equal(title.version, 3); assert.equal(title.title, 'New published title'); assert.equal(title.content, 'Published body'); assert.equal(title.description, 'Only title survives');
    assert.deepEqual(app.store.documentVersion(page.id, 2), draft);
    await app.operation(page.id, 'drafts', { title: 'Newest draft heading', content: 'Newest draft body' });
    const body = conduitResult(await write(app, 'edit', { slug: page.slug, content: title.content })); assert.equal(body.version, 5, 'published body differs from latest head and is therefore an effective content transaction'); assert.equal(body.title, title.title); assert.equal(body.content, title.content);
    const full = conduitResult(await write(app, 'edit', { slug: page.slug, title: 'Both title', content: 'Both body' })); assert.equal(full.version, 6, 'two effective fields allocate only one immutable version');
  } finally { await app.close(); }
});

test('Conduit create cannot replace active, deleted, moved, stub or hidden occupants; effective edit reactivates inactive paths', async () => {
  const app = await startWikiApi();
  try {
    await app.document('/'); const active = await app.document('active/'), deleted = await app.document('deleted/'), moved = await app.document('moved/'), stub = await app.document('stub/'), hidden = await app.document('hidden/');
    await app.operation(deleted.id, 'delete'); await app.move(moved.id, 'destination/'); await app.operation(stub.id, 'delete');
    app.store.database.prepare("UPDATE wiki_locations SET status='stub' WHERE document_id=?").run(stub.id);
    app.policy(hidden.id, { view: members(app.bob.id), edit: members(app.bob.id) }, app.bob.id);
    for (const page of [active, deleted, moved, stub, hidden]) conduitFailure(await write(app, 'create', { slug: page.slug, title: 'Replacement', content: 'Replacement' }), 'ERR-BAD-DOCUMENT');
    for (const page of [deleted, moved, stub]) {
      const old = rows(app, page.id);
      for (const patch of [{}, { title: 'Changed title' }, { description: 'Description only' }, { content: '0' }, { content: '' }]) conduitFailure(await write(app, 'edit', { slug: page.slug, ...patch }), 'ERR-INVALID-PARAMETER');
      assert.deepEqual(rows(app, page.id), old);
      const changed = conduitResult(await write(app, 'edit', { slug: page.slug, content: 'Recreated content' })); assert.equal(changed.status, 'exists'); assert.equal(changed.version, old.length + 1); assert.equal(changed.content, 'Recreated content'); assert.equal(app.store.documentLocation(page.id).movedToId, null); assert.deepEqual(rows(app, page.id).slice(0, old.length), old);
    }
  } finally { await app.close(); }
});

test('Conduit validation precedes no-effect filtering, including the historical blank-publication edge', async () => {
  const app = await startWikiApi();
  try {
    await app.document('/'); const page = await app.document('blank-edge/', { title: 'Original title', content: 'Original body' });
    await app.operation(page.id, 'delete'); await app.operation(page.id, 'drafts', { title: page.title, content: 'Unpublished recovery body' });
    const before = rows(app, page.id);
    const noop = conduitResult(await write(app, 'edit', { slug: page.slug, content: 'Unpublished recovery body' })); assert.equal(noop.content, ''); assert.equal(noop.status, 'deleted'); assert.equal(noop.version, 2); assert.deepEqual(rows(app, page.id), before);
    const changed = conduitResult(await write(app, 'edit', { slug: page.slug, title: 'Title effect', content: 'Unpublished recovery body' }));
    assert.equal(changed.version, 4); assert.equal(changed.status, 'exists'); assert.equal(changed.title, 'Title effect'); assert.equal(changed.content, '', 'content passed validation but was filtered against head, so title publishes the blank published baseline');
    conduitFailure(await write(app, 'edit', { slug: page.slug, description: 'Blank source still fails validation' }), 'ERR-INVALID-PARAMETER');
    const recovered = conduitResult(await write(app, 'edit', { slug: page.slug, content: 'Actual replacement body' })); assert.equal(recovered.content, 'Actual replacement body');
  } finally { await app.close(); }
});

test('Conduit creation inherits parent authority and requires parent edit while existing child edits need only ancestor view', async () => {
  const app = await startWikiApi();
  try {
    await app.document('/'); const parent = await app.document('parent/'), child = await app.document('parent/existing/');
    const space = app.policies.createSpace({ name: 'Parent Space', view: workspace, edit: workspace }, app.alice.id);
    app.policy(parent.id, { spaceId: space.id, view: members(app.alice.id, app.bob.id), edit: members(app.alice.id, app.bob.id), interact: members(app.bob.id) });
    const created = conduitResult(await write(app, 'create', { slug: 'parent/new/', title: 'Inherited', content: 'Inherited body' }));
    const inherited = app.policies.policy(documentId(app, created.slug), app.alice.id), expected = app.policies.policy(parent.id, app.alice.id); assert.equal(inherited.spaceId, space.id); assert.deepEqual(inherited.rules, expected.rules);
    app.policy(parent.id, { edit: members(app.bob.id) }, app.bob.id);
    conduitFailure(await write(app, 'create', { slug: 'parent/denied/', title: 'Denied', content: 'Denied' }));
    assert.equal(conduitResult(await write(app, 'edit', { slug: child.slug, content: 'Existing child remains editable' })).content, 'Existing child remains editable');
    conduitFailure(await write(app, 'create', { slug: 'missing/intermediate/new/', title: 'Missing ancestors', content: 'No implicit parents' }));
    assert.equal(app.store.database.prepare("SELECT COUNT(*) AS count FROM wiki_locations WHERE path LIKE 'missing/%'").get()!.count, 0);
    app.policy(parent.id, { view: members(app.bob.id) }, app.bob.id);
    conduitFailure(await write(app, 'edit', { slug: child.slug, content: 'Hidden ancestor write' }), 'ERR-BAD-DOCUMENT');
    conduitFailure(await write(app, 'create', { slug: 'parent/hidden/', title: 'Hidden ancestor', content: 'Hidden ancestor' }));
  } finally { await app.close(); }
});

test('Conduit writes require current write scope and cookie CSRF, including no-effect edits and revoked credentials', async () => {
  const app = await startWikiApi();
  try {
    await app.document('/'); const page = await app.document('authentication/');
    conduitFailure(await write(app, 'edit', { slug: page.slug }, undefined, 'reader'), 'ERR-INVALID-AUTH');
    assert.equal(conduitResult(await write(app, 'edit', { slug: page.slug, content: 'Write-only scope is sufficient' }, undefined, 'writer')).content, 'Write-only scope is sufficient');
    const headers = await app.login();
    const cookieWrite = (extra: Record<string, string>, input: Record<string, unknown>) => app.raw<ConduitEnvelope<LegacyDocument>>('/api/phriction.edit', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(input) });
    assert.equal(conduitResult(await cookieWrite({}, { slug: page.slug, content: 'Browser source' })).content, 'Browser source');
    conduitFailure(await cookieWrite({ 'X-CSRF-Token': 'invalid' }, { slug: page.slug, content: 'Rejected' }), 'ERR-INVALID-AUTH');
    conduitFailure(await cookieWrite({ 'X-Session-Context': 'retired' }, { slug: page.slug, content: 'Rejected' }), 'ERR-INVALID-AUTH');
    conduitFailure(await cookieWrite({}, { slug: page.slug, content: 'Rejected', 'api.token': app.tokens.alice.token }), 'ERR-INVALID-AUTH');
    app.auth.revokeToken(app.alice.id, app.tokens.writer.record.id);
    conduitFailure(await write(app, 'edit', { slug: page.slug }, undefined, 'writer'), 'ERR-INVALID-AUTH');
    app.policy(page.id, { edit: members(app.bob.id) }, app.bob.id);
    conduitFailure(await write(app, 'edit', { slug: page.slug }), 'ERR-BAD-DOCUMENT');
    conduitFailure(await write(app, 'edit', { slug: 'missing/' }), 'ERR-BAD-DOCUMENT');
  } finally { await app.close(); }
});

test('Conduit retry keys replay exact historical creates, changes and no-ops across credential rotation and transport normalization', async () => {
  const app = await startWikiApi();
  try {
    await app.document('/');
    const createInput = { slug: '//Retry///', title: 'Retry title', content: 'Initial body', description: 'Initial message' };
    const initial = conduitResult(await write(app, 'create', createInput, 'create-retry'));
    const id = documentId(app, initial.slug), alternate = app.auth.createToken(app.alice.id, { name: 'Rotated credential', scopes: ['write'] });
    const editInput = { slug: initial.slug, content: 'Changed body', description: 'Changed message' };
    const changed = conduitResult(await write(app, 'edit', editInput, 'edit-retry'));
    const noopInput = { slug: initial.slug, title: changed.title, content: changed.content, description: 'No effect message' };
    const noop = conduitResult(await write(app, 'edit', noopInput, 'noop-retry'));
    const noopRows = rows(app, id); assert.equal(noop.version, 2); assert.equal(noop.description, editInput.description);
    await write(app, 'edit', { slug: initial.slug, title: 'Newest title', content: 'Newest content', description: 'Newest notes' });
    await app.operation(id, 'delete'); const currentRows = rows(app, id);
    assert.deepEqual(conduitResult(await write(app, 'create', createInput, 'create-retry', 'alice', alternate.token)), initial);
    assert.deepEqual(conduitResult(await write(app, 'edit', editInput, 'edit-retry', 'alice', alternate.token)), changed);
    assert.deepEqual(conduitResult(await write(app, 'edit', noopInput, 'noop-retry', 'alice', alternate.token)), noop, 'a saved no-op never becomes a new edit after content changes');
    const formReplay = await app.raw<ConduitEnvelope<LegacyDocument>>('/api/phriction.create', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': 'create-retry' }, body: new URLSearchParams({ description: createInput.description, content: createInput.content, title: createInput.title, slug: 'retry/', 'api.token': alternate.token }) });
    assert.deepEqual(conduitResult(formReplay), initial); assert.deepEqual(rows(app, id), currentRows); assert.deepEqual(currentRows.slice(0, 2), noopRows);
    conduitFailure(await write(app, 'edit', { ...editInput, content: 'Different request' }, 'edit-retry'), 'ERR-CONFLICT');
    conduitFailure(await write(app, 'edit', { slug: initial.slug, content: 'Different method' }, 'create-retry'), 'ERR-CONFLICT');
    conduitFailure(await write(app, 'create', createInput, 'create-retry', 'bob'), 'ERR-BAD-DOCUMENT',);
    const bobResult = conduitResult(await write(app, 'edit', { slug: initial.slug, content: 'Bob new body' }, 'edit-retry', 'bob')); assert.equal(bobResult.status, 'exists'); assert.equal(bobResult.version, currentRows.length + 1, 'another principal has a separate retry namespace');
    assert.equal(app.store.database.prepare('SELECT COUNT(*) AS count FROM wiki_conduit_receipts WHERE document_id=?').get(id)!.count, 5, 'successful no-ops have immutable execution evidence, retries do not add receipts');
  } finally { await app.close(); }
});

test('Conduit replay rechecks edit permission, ancestors, Space and token scope before exposing the saved historical result', async () => {
  const app = await startWikiApi();
  try {
    await app.document('/'); const parent = await app.document('authority/'), child = await app.document('authority/child/');
    const input = { slug: child.slug, content: 'Private historical result' }; conduitResult(await write(app, 'edit', input, 'private-retry'));
    app.policy(child.id, { edit: members(app.bob.id) }, app.bob.id);
    conduitFailure(await write(app, 'edit', input, 'private-retry'), 'ERR-BAD-DOCUMENT');
    app.policy(child.id, { edit: workspace }, app.bob.id); app.policy(parent.id, { view: members(app.bob.id), edit: members(app.bob.id) }, app.bob.id);
    const denied = await write(app, 'edit', input, 'private-retry'); conduitFailure(denied, 'ERR-BAD-DOCUMENT'); assert.doesNotMatch(JSON.stringify(denied.body), /Private historical/);
    app.policy(parent.id, { view: workspace, edit: workspace }, app.bob.id);
    const space = app.policies.createSpace({ name: 'Restricted after save', view: workspace, edit: workspace }, app.bob.id); app.policy(child.id, { spaceId: space.id }, app.bob.id);
    app.policies.updateSpace(space.id, { expectedVersion: space.version, view: members(app.bob.id), edit: members(app.bob.id) }, app.bob.id);
    conduitFailure(await write(app, 'edit', input, 'private-retry'), 'ERR-BAD-DOCUMENT');
    conduitFailure(await write(app, 'edit', input, 'private-retry', 'reader'), 'ERR-INVALID-AUTH');
    app.auth.revokeToken(app.alice.id, app.tokens.alice.record.id);
    conduitFailure(await write(app, 'edit', input, 'private-retry'), 'ERR-INVALID-AUTH');
  } finally { await app.close(); }
});

test('Conduit retries reject canonical receipt substitution across keys, inputs, actors and documents', async () => {
  const app = await startWikiApi();
  try {
    await app.document('/'); const page = await app.document('receipt-bindings/'), other = await app.document('other-bindings/');
    const input = { slug: page.slug, content: 'Same request body', description: 'Same request message' };
    conduitResult(await write(app, 'edit', input, 'binding-first'));
    conduitResult(await write(app, 'edit', input, 'binding-second'));
    conduitResult(await write(app, 'edit', { ...input, content: 'Different request body' }, 'binding-third'));
    conduitResult(await write(app, 'edit', input, 'binding-bob', 'bob'));
    conduitResult(await write(app, 'edit', { ...input, slug: other.slug }, 'binding-other'));
    const saved = (rawKey: string, principal = app.alice.id) => {
      const found = app.store.database.prepare("SELECT key, fingerprint, body FROM idempotency WHERE json_valid(key) AND json_extract(key,'$[0]')='conduit' AND json_extract(key,'$[2]')=? AND json_extract(key,'$[3]')=?").get(principal, rawKey) as { key: string; fingerprint: string; body: string } | undefined; assert.ok(found); return found;
    };
    const first = saved('binding-first'); const rowsBefore = rows(app, page.id), hidden = saved('binding-other');
    const hiddenReceiptId = (JSON.parse(hidden.body) as { id: string }).id;
    app.policy(other.id, { view: members(app.bob.id), edit: members(app.bob.id) }, app.bob.id);
    const readReceipt = app.store.wikiConduitReceipt.bind(app.store); let hiddenReads = 0;
    app.store.wikiConduitReceipt = id => { if (id === hiddenReceiptId) hiddenReads++; return readReceipt(id); };
    const smuggled = { body: JSON.stringify({ ...(JSON.parse(first.body) as Record<string, unknown>), id: hiddenReceiptId }) };
    for (const replacement of [saved('binding-second'), saved('binding-third'), saved('binding-bob', app.bob.id), hidden, smuggled]) {
      app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(replacement.body, first.key);
      conduitFailure(await write(app, 'edit', input, 'binding-first'), 'ERR-INVALID-RECEIPT');
    }
    assert.equal(hiddenReads, 0, 'a forged response for an unrelated hidden document is rejected before the canonical getter loads its source');
    app.store.wikiConduitReceipt = readReceipt;
    app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(first.body, first.key);
    assert.equal(conduitResult(await write(app, 'edit', input, 'binding-first')).content, input.content);
    const differentInput = { ...input, content: 'Different request body' }, third = saved('binding-third');
    app.store.database.prepare('UPDATE idempotency SET fingerprint=? WHERE key=?').run(third.fingerprint, first.key);
    conduitFailure(await write(app, 'edit', differentInput, 'binding-first'), 'ERR-INVALID-RECEIPT',);
    assert.deepEqual(rows(app, page.id), rowsBefore);
  } finally { await app.close(); }
});

test('Conduit optional retry keys are bounded and concurrent identical writes produce one content version and receipt', async () => {
  const app = await startWikiApi();
  try {
    await app.document('/'); const page = await app.document('concurrent/'); const input = { slug: page.slug, content: 'Concurrent exact content' };
    for (const key of ['x'.repeat(201), 'contains spaces', 'invalid/slash']) conduitFailure(await write(app, 'edit', input, key), 'ERR-INVALID-PARAMETER');
    const results = await Promise.all(Array.from({ length: 6 }, () => write(app, 'edit', input, 'simultaneous')));
    const first = conduitResult(results[0]!); for (const result of results) assert.deepEqual(conduitResult(result), first);
    assert.equal(first.version, 2); assert.equal(rows(app, page.id).length, 2); assert.equal(app.store.database.prepare('SELECT COUNT(*) AS count FROM wiki_conduit_receipts WHERE document_id=?').get(page.id)!.count, 1);
    const unkeyed = conduitResult(await write(app, 'edit', input)); assert.deepEqual(unkeyed, first); assert.equal(rows(app, page.id).length, 2); assert.equal(app.store.database.prepare('SELECT COUNT(*) AS count FROM wiki_conduit_receipts WHERE document_id=?').get(page.id)!.count, 2);
    assert.throws(() => app.store.database.prepare('UPDATE wiki_conduit_receipts SET data=data').run(), /immutable/); assert.throws(() => app.store.database.prepare('DELETE FROM wiki_conduit_receipts').run(), /immutable/);
  } finally { await app.close(); }
});
