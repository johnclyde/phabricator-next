import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from './app.ts';
import { createAuth } from './auth.ts';
import { Store } from './store.ts';
import type { CitationIndex } from '../shared/citations.ts';
import type { CitationEvidenceInput, CitationEvidencePage, CitationEvidenceRecord } from '../shared/citation-evidence.ts';
import type { FileRecord } from '../shared/files.ts';
import type { RevisionDetail } from '../shared/types.ts';

const workspace = { kind: 'workspace' as const };
const members = (...principalIds: string[]) => ({ kind: 'principals' as const, principalIds });
const files = [{ path: 'main.tex', content: 'A claim \\cite{proof}.\n' }, { path: 'refs.bib', content: '@article{proof,title={A supporting report}}\n' }];
type Failure = { error: string; code?: string };
type RecordResponse = CitationEvidenceRecord & { accessEpoch: number };

async function start(databasePath = ':memory:') {
  const store = new Store({ path: databasePath });
  const provision = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  const alice = await provision.createAccount({ username: 'alice', displayName: 'Alice', password: 'Alice citation evidence password' });
  const bob = await provision.createAccount({ username: 'bob', displayName: 'Bob', password: 'Bob citation evidence password' });
  const app = createApp({ store, seed: false, authMode: 'password' });
  const tokens = {
    alice: app.auth.createToken(alice.id, { name: 'Alice', scopes: ['read', 'write'] }),
    aliceOther: app.auth.createToken(alice.id, { name: 'Alice other', scopes: ['read', 'write'] }),
    bob: app.auth.createToken(bob.id, { name: 'Bob', scopes: ['read', 'write'] }),
    reader: app.auth.createToken(alice.id, { name: 'Reader', scopes: ['read'] }),
  };
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  async function request<T = Failure>(path: string, method = 'GET', body?: unknown, actor: keyof typeof tokens | null = 'alice', key?: string) {
    const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(10_000), headers: { ...(actor ? { Authorization: `Bearer ${tokens[actor].token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, headers: response.headers, body: await response.json() as T };
  }
  let sequence = 0;
  async function upload(actor: keyof typeof tokens = 'alice') {
    const bytes = Buffer.from('%PDF-1.4\nA supporting report.\n');
    const saved = await request<FileRecord>('/api/files', 'POST', { name: 'report.pdf', dataBase64: bytes.toString('base64'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, actor, `file-${++sequence}`);
    assert.equal(saved.status, 201, JSON.stringify(saved.body)); return saved.body;
  }
  function policy(id: string, changes: Record<string, unknown>, principal = alice.id) {
    const current = app.policies.policy(id, principal);
    return app.policies.setPolicy(id, { expectedVersion: current.version, spaceId: current.spaceId, ...current.rules, ...changes }, principal);
  }
  async function paper() {
    const made = await request<RevisionDetail>('/api/revisions', 'POST', { kind: 'paper', title: 'A manuscript with citations', files }, 'alice', `paper-${++sequence}`);
    assert.equal(made.status, 201, JSON.stringify(made.body)); return made.body;
  }
  async function input(detail: RevisionDetail, file: FileRecord): Promise<CitationEvidenceInput> {
    const version = detail.versions[0]!;
    const response = await request<{ index: CitationIndex }>(`/api/revisions/${detail.revision.id}/citations?version=${version.number}`);
    assert.equal(response.status, 200); assert.ok(response.body.index.entries[0]);
    return { versionId: version.id, contentHash: version.contentHash, targetId: response.body.index.entries[0]!.id, source: { fileId: file.id, sha256: file.sha256, bytes: file.bytes, mediaType: file.mediaType }, verdict: 'supports', quote: '  A verbatim quoted passage.\n', locator: 'page 12', note: 'I reviewed the cited passage.', attested: true, expectedAccessEpoch: app.policies.epoch() };
  }
  const rows = (table: string) => store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  return { ...app, alice, bob, tokens, request, upload, policy, paper, input, rows, close: async () => { await app.close(); store.close(); } };
}

test('evidence reads and writes require the intersection of manuscript authority and source File visibility', async () => {
  const app = await start();
  try {
    const paper = await app.paper(); const file = await app.upload(); const input = await app.input(paper, file);
    const route = `/api/revisions/${paper.revision.id}/citation-evidence`;
    const activity = app.rows('activity'); const attachments = app.rows('file_attachments');
    assert.equal((await app.request(route, 'POST', input, null, 'evidence')).status, 401);
    assert.equal((await app.request(route, 'POST', input, 'reader', 'evidence')).status, 403);
    assert.equal((await app.request(route, 'POST', input)).status, 400);
    const hidden = await app.request(route, 'POST', input, 'bob', 'evidence'); assert.equal(hidden.status, 404); assert.equal(hidden.body.code, 'CITATION_SOURCE_UNAVAILABLE');
    const saved = await app.request<RecordResponse>(route, 'POST', input, 'alice', 'evidence'); assert.equal(saved.status, 201, JSON.stringify(saved.body));
    assert.equal(saved.body.quote, input.quote); assert.equal(saved.body.basis, 'reviewer-attestation');
    assert.deepEqual(app.rows('activity'), activity, 'globally visible activity must not disclose gated evidence'); assert.deepEqual(app.rows('file_attachments'), attachments);
    const child = `${route}/${saved.body.id}`;
    assert.equal((await app.request(child, 'GET', undefined, 'bob')).status, 404);
    const bobPage = await app.request<CitationEvidencePage>(`${route}?versionId=${input.versionId}`, 'GET', undefined, 'bob'); assert.equal(bobPage.status, 200); assert.deepEqual(bobPage.body.records, []);
    assert.equal((await app.request(`/api/revisions/${paper.revision.id}`, 'GET', undefined, 'bob')).status, 200, 'gated evidence does not hide its manuscript');
    app.policy(file.id, { view: workspace });
    assert.equal((await app.request(child, 'GET', undefined, 'bob')).status, 200);
    app.policy(paper.revision.id, { view: members(app.alice.id), edit: members(app.alice.id), interact: members(app.alice.id) });
    assert.equal((await app.request(child, 'GET', undefined, 'bob')).status, 404);
    assert.equal((await app.request(`${route}?versionId=${input.versionId}`, 'GET', undefined, 'bob')).status, 404);
    assert.equal((await app.request(`/api/files/${file.id}`, 'GET', undefined, 'bob')).status, 200, 'manuscript revocation cannot change source File rules');
  } finally { await app.close(); }
});

test('exact retries share a principal receipt, survive head changes and retraction, and recheck current authority', async () => {
  const app = await start();
  try {
    const paper = await app.paper(); const file = await app.upload(); const input = await app.input(paper, file); const id = paper.revision.id;
    const route = `/api/revisions/${id}/citation-evidence`;
    const [first, concurrent] = await Promise.all([app.request<RecordResponse>(route, 'POST', input, 'alice', 'same-evidence'), app.request<RecordResponse>(route, 'POST', input, 'aliceOther', 'same-evidence')]);
    assert.equal(first.status, 201); assert.deepEqual(first.body, concurrent.body); assert.equal(app.rows('citation_evidence').length, 1);
    app.store.createVersion(id, { expectedVersion: 1, message: 'A later draft', files: [{ path: 'main.tex', content: 'Changed source.' }] });
    app.policies.createSpace({ name: 'Unrelated epoch change' }, app.alice.id);
    const replay = await app.request<RecordResponse>(route, 'POST', input, 'aliceOther', 'same-evidence'); assert.equal(replay.status, 201);
    assert.equal(replay.body.versionId, input.versionId); assert.equal(replay.body.accessEpoch, app.policies.epoch());
    assert.equal((await app.request(route, 'POST', input, 'alice', 'fresh-stale-epoch')).status, 409);
    assert.equal((await app.request(route, 'POST', { ...input, note: 'Different operation' }, 'alice', 'same-evidence')).status, 409);
    const retract = await app.request<RecordResponse>(`${route}/${first.body.id}/retract`, 'POST', { expectedRecordVersion: 1, reason: 'I misread the source.' }, 'alice', 'retract');
    assert.equal(retract.status, 200); assert.equal(retract.body.state, 'retracted');
    assert.equal((await app.request<RecordResponse>(route, 'POST', input, 'alice', 'same-evidence')).body.state, 'active', 'creation receipt remains historical');
    assert.equal((await app.request<{ record: CitationEvidenceRecord }>(`${route}/${first.body.id}`)).body.record.state, 'retracted');
    assert.equal((await app.request(`${route}/${first.body.id}/retract`, 'POST', { expectedRecordVersion: 1, reason: 'I misread the source.' }, 'aliceOther', 'retract')).status, 200);
    app.policy(id, { interact: members(app.bob.id) });
    assert.equal((await app.request(route, 'POST', input, 'alice', 'same-evidence')).status, 403);
    app.policy(id, { interact: workspace });
    const space = app.policies.createSpace({ name: 'Supporting source ceiling', view: workspace, edit: members(app.alice.id, app.bob.id) }, app.alice.id);
    app.policy(file.id, { spaceId: space.id });
    app.policies.updateSpace(space.id, { expectedVersion: 1, view: members(app.bob.id), edit: members(app.bob.id) }, app.bob.id);
    assert.equal((await app.request(route, 'POST', input, 'aliceOther', 'same-evidence')).status, 404);
    assert.equal((await app.request(`${route}/${first.body.id}/retract`, 'POST', { expectedRecordVersion: 1, reason: 'I misread the source.' }, 'aliceOther', 'retract')).status, 404);
    app.auth.revokeToken(app.alice.id, app.tokens.aliceOther.record.id);
    assert.equal((await app.request(route, 'POST', input, 'aliceOther', 'same-evidence')).status, 401);
  } finally { await app.close(); }
});

test('retraction requires original author or current editor in addition to interact and source access', async () => {
  const app = await start();
  try {
    const paper = await app.paper(); const file = await app.upload(); app.policy(file.id, { view: workspace });
    const input = await app.input(paper, file); const id = paper.revision.id; const route = `/api/revisions/${id}/citation-evidence`;
    app.policy(id, { edit: members(app.alice.id) }); input.expectedAccessEpoch = app.policies.epoch();
    const saved = await app.request<RecordResponse>(route, 'POST', input, 'alice', 'author'); assert.equal(saved.status, 201);
    const retractRoute = `${route}/${saved.body.id}/retract`; const retraction = { expectedRecordVersion: 1, reason: 'Correct the interpretation' };
    assert.equal((await app.request(retractRoute, 'POST', retraction, 'bob', 'not-editor')).status, 403);
    app.policy(id, { edit: workspace });
    // The original evidence author must actually relinquish revision ownership:
    // narrowing the edit audience alone does not remove an author's automatic edit.
    const ownership = app.store.revisionAuthorship.snapshot(id);
    const handoff = await app.request(`/api/revisions/${id}/authorship`, 'POST', { action: 'assign', authorId: app.bob.id, message: 'Transfer manuscript responsibility', expectedAuthorVersion: ownership.authorship.version, expectedReviewerVersion: ownership.reviewerVersion, expectedLifecycleVersion: ownership.lifecycleVersion, expectedVersion: ownership.head.number, expectedVersionId: ownership.head.versionId, expectedContentHash: ownership.head.contentHash, expectedAccessEpoch: app.policies.epoch() }, 'alice', 'handoff-before-evidence-retraction');
    assert.equal(handoff.status, 200);
    app.policy(id, { edit: members(app.bob.id) }, app.bob.id);
    assert.equal(app.policies.access(id, app.alice.id).edit, false);
    assert.equal((await app.request(retractRoute, 'POST', retraction, 'alice', 'author-retract')).status, 200, 'original author need not be an editor');
    const second = await app.request<RecordResponse>(route, 'POST', { ...input, expectedAccessEpoch: app.policies.epoch() }, 'alice', 'second-author'); assert.equal(second.status, 201);
    assert.equal((await app.request(`${route}/${second.body.id}/retract`, 'POST', retraction, 'bob', 'editor-retract')).status, 200);
    assert.equal((await app.request(`${route}/${second.body.id}/retract`, 'POST', retraction, 'bob', 'another-retraction')).status, 409);
  } finally { await app.close(); }
});

test('version and target reads are exact, filtered pages hide source-gated records, and failed writes leave no receipt', async () => {
  const app = await start();
  try {
    const paper = await app.paper(); const source = await app.upload(); const hidden = await app.upload('bob');
    app.policy(source.id, { view: workspace }); const visibleInput = await app.input(paper, source); const hiddenInput = await app.input(paper, hidden);
    const id = paper.revision.id; const route = `/api/revisions/${id}/citation-evidence`;
    const first = await app.request<RecordResponse>(route, 'POST', visibleInput, 'alice', 'first'); assert.equal(first.status, 201);
    assert.equal((await app.request(route, 'POST', hiddenInput, 'bob', 'hidden')).status, 201);
    const third = await app.request<RecordResponse>(route, 'POST', visibleInput, 'alice', 'third'); assert.equal(third.status, 201);
    const page = await app.request<CitationEvidencePage>(`${route}?versionId=${visibleInput.versionId}&limit=1`);
    assert.deepEqual(page.body.records.map(record => record.id), [third.body.id]); assert.ok(page.body.nextBefore);
    const next = await app.request<CitationEvidencePage>(`${route}?versionId=${visibleInput.versionId}&limit=1&before=${page.body.nextBefore}`);
    assert.deepEqual(next.body.records.map(record => record.id), [first.body.id]); assert.equal(next.body.nextBefore, null);
    for (const query of ['', '?version=0', '?version=1&version=1', '?version=1&extra=1']) assert.equal((await app.request(`/api/revisions/${id}/citations${query}`)).status, 400);
    const missing = await app.request(`/api/revisions/${id}/citations?version=99`); assert.equal(missing.status, 404); assert.equal(missing.body.code, 'CITATION_VERSION_UNAVAILABLE');
    for (const query of ['', '?versionId=x&versionId=y', `?versionId=${visibleInput.versionId}&limit=101`, `?versionId=${visibleInput.versionId}&before=0`]) assert.equal((await app.request(route + query)).status, 400);
    const before = app.rows('citation_evidence'); const receipts = app.rows('idempotency');
    for (const patch of [{ contentHash: '0'.repeat(64) }, { targetId: 'unknown target' }, { attested: false }, { source: { ...visibleInput.source, bytes: source.bytes + 1 } }]) {
      assert.ok([400, 404, 409].includes((await app.request(route, 'POST', { ...visibleInput, ...patch }, 'alice', 'retry-after-error')).status));
      assert.deepEqual(app.rows('citation_evidence'), before); assert.deepEqual(app.rows('idempotency'), receipts);
    }
    assert.equal((await app.request(`/api/revisions/${id}`)).status, 200);
    app.store.database.exec("CREATE TRIGGER fail_citation_receipt BEFORE INSERT ON idempotency WHEN NEW.body LIKE '%reviewer-attestation%' BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END;");
    assert.equal((await app.request(route, 'POST', visibleInput, 'alice', 'atomic-receipt')).status, 500);
    assert.deepEqual(app.rows('citation_evidence'), before); assert.deepEqual(app.rows('idempotency'), receipts);
  } finally { await app.close(); }
});

test('forged saved citation receipts cannot substitute quotes, identities, versions or source Files', async () => {
  const app = await start();
  try {
    const paper = await app.paper(); const file = await app.upload(); const input = await app.input(paper, file); const route = `/api/revisions/${paper.revision.id}/citation-evidence`;
    const saved = await app.request<RecordResponse>(route, 'POST', input, 'alice', 'receipt'); assert.equal(saved.status, 201);
    const row = app.store.database.prepare("SELECT key,body FROM idempotency WHERE body LIKE '%reviewer-attestation%'").get() as { key: string; body: string };
    const original = JSON.parse(row.body) as RecordResponse;
    for (const patch of [{ quote: 'Forged quote' }, { contentHash: '0'.repeat(64) }, { versionNumber: 999 }, { source: { ...original.source, sha256: '0'.repeat(64) } }, { attribution: { ...original.attribution, displayName: 'Someone else' } }]) {
      app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(JSON.stringify({ ...original, ...patch }), row.key);
      assert.equal((await app.request(route, 'POST', input, 'alice', 'receipt')).status, 409);
    }
    app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(row.body, row.key);
    assert.equal((await app.request(route, 'POST', input, 'alice', 'receipt')).status, 201);
    const other = await app.request<RecordResponse>(route, 'POST', { ...input, quote: 'A different complete observation.' }, 'alice', 'other-receipt');
    assert.equal(other.status, 201);
    const substitute = app.store.citationEvidence.get(paper.revision.id, other.body.id);
    app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(JSON.stringify(substitute), row.key);
    assert.equal((await app.request(route, 'POST', input, 'alice', 'receipt')).status, 409, 'a complete different stored record is not this request receipt');
    app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(row.body, row.key);
    const retraction = { expectedRecordVersion: 1, reason: 'Withdraw observation' };
    assert.equal((await app.request(`${route}/${saved.body.id}/retract`, 'POST', retraction, 'alice', 'retract-first')).status, 200);
    assert.equal((await app.request(`${route}/${other.body.id}/retract`, 'POST', retraction, 'alice', 'retract-other')).status, 200);
    const retractionRow = app.store.database.prepare("SELECT key FROM idempotency WHERE json_extract(body,'$.id')=? AND json_extract(body,'$.state')='retracted'").get(saved.body.id) as { key: string };
    app.store.database.prepare('UPDATE idempotency SET body=? WHERE key=?').run(JSON.stringify(app.store.citationEvidence.get(paper.revision.id, other.body.id)), retractionRow.key);
    assert.equal((await app.request(`${route}/${saved.body.id}/retract`, 'POST', retraction, 'alice', 'retract-first')).status, 409, 'a retraction receipt must identify the route child');
  } finally { await app.close(); }
});

test('source revocation committed during the write lock blocks fresh evidence and newly available receipts', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'citation-evidence-lock-')); const databasePath = join(directory, 'workspace.sqlite');
  const app = await start(databasePath); const transaction = app.store.transaction.bind(app.store);
  try {
    for (const phase of ['write', 'replay'] as const) {
      const paper = await app.paper(); const file = await app.upload(); const input = await app.input(paper, file); const originalEpoch = input.expectedAccessEpoch; const route = `/api/revisions/${paper.revision.id}/citation-evidence`; const key = `locked-${phase}`;
      let receipt: { key: string; fingerprint: string; status: number; body: string; created_at: string } | undefined;
      if (phase === 'replay') {
        assert.equal((await app.request(route, 'POST', input, 'alice', key)).status, 201);
        receipt = app.store.database.prepare("SELECT * FROM idempotency WHERE body LIKE '%reviewer-attestation%' ORDER BY rowid DESC LIMIT 1").get() as typeof receipt;
        assert.ok(receipt); app.store.database.prepare('DELETE FROM idempotency WHERE key=?').run(receipt.key);
      }
      const space = app.policies.createSpace({ name: 'Concurrent source boundary', view: workspace, edit: members(app.alice.id, app.bob.id) }, app.alice.id);
      app.policy(file.id, { spaceId: space.id }); input.expectedAccessEpoch = app.policies.epoch();
      // A replay uses its original exact input/fingerprint, while fresh writes use the current epoch.
      if (receipt) input.expectedAccessEpoch = originalEpoch;
      const restricted = { ...space, version: space.version + 1, view: members(app.bob.id), edit: members(app.bob.id) };
      const before = app.rows('citation_evidence'); const replays = app.rows('idempotency').length;
      const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(`
        import { parentPort,workerData } from 'node:worker_threads';
        import { DatabaseSync } from 'node:sqlite';
        const db=new DatabaseSync(workerData.databasePath); db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
        db.prepare('UPDATE policy_spaces SET data=? WHERE id=?').run(JSON.stringify(workerData.space),workerData.space.id);
        db.prepare("UPDATE policy_meta SET value=value+1 WHERE name='epoch'").run();
        if(workerData.receipt){const r=workerData.receipt;db.prepare('INSERT INTO idempotency(key,fingerprint,status,body,created_at) VALUES(?,?,?,?,?)').run(r.key,r.fingerprint,r.status,r.body,r.created_at);}
        parentPort.once('message',()=>{db.exec('COMMIT');db.close();parentPort.close();});parentPort.postMessage('locked');
      `)}`), { workerData: { databasePath, space: restricted, receipt } });
      let entered = 0;
      try {
        await once(worker, 'message');
        app.store.transaction = function<T>(work: () => T): T { entered++; app.store.transaction = transaction; worker.postMessage('commit'); return transaction(work); };
        const response = await app.request(route, 'POST', input, 'alice', key);
        assert.equal(entered, 1, JSON.stringify({ phase, response })); assert.equal(response.status, 404); assert.equal(response.body.code, 'CITATION_SOURCE_UNAVAILABLE');
        assert.deepEqual(app.rows('citation_evidence'), before); assert.equal(app.rows('idempotency').length, replays + (receipt ? 1 : 0));
      } finally { app.store.transaction = transaction; await worker.terminate(); }
    }
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
