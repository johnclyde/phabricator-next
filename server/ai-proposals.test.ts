import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { AuthContext } from '../shared/auth.ts';
import { createPassageAnchor } from '../shared/anchors.ts';
import { aiProposalHead, isAIProposalDetail, isAIProposalList, type AIProposalGenerateInput } from '../shared/ai-proposals.ts';
import { Store } from './store.ts';
import { HttpError } from './validation.ts';
import { AIProposalService, initializeAIProposals } from './ai-proposals.ts';
import { AIProposalProviderError, type AIProposalGenerator } from './ai-proposal-provider.ts';
import { lifecycleAction } from '../tests/revision-lifecycle-fixture.ts';

const actor: AuthContext = { workspaceId: 'proposal-tests', principalId: 'U1', displayName: 'Writer', credentialId: 'credential-1', kind: 'session', sessionContext: 'session-1', scopes: ['read', 'write', 'review:hosted', 'review:local'] };
const other: AuthContext = { ...actor, principalId: 'U2', credentialId: 'credential-2' };
const attribution = { principalId: actor.principalId, displayName: actor.displayName, credentialId: actor.credentialId, requestId: 'fixture' };
const config = { configured: true, model: 'configured-test-model', localConfigured: true, localModel: 'test-local-model' };
const rawResult = (edits: unknown[] = [{ filePath: 'paper.tex', start: 0, end: 3, quote: 'Teh', replacement: 'The', explanation: 'Correct the misspelled article.' }]) => ({ summary: 'One supported correction.', limitations: 'No external references or experiments were verified.', edits });
const status = (expected: number) => (error: unknown) => error instanceof HttpError && error.status === expected;
function fixture(provider?: AIProposalGenerator) {
  const store = new Store({ path: ':memory:' }); initializeAIProposals(store.database);
  const detail = store.createRevision({ kind: 'paper', title: 'Private manuscript', testPlan: 'Inspect exact source changes.', files: [{ path: 'paper.tex', content: 'Teh result.\nSame word. Same word.\n' }, { path: 'other.tex', content: 'Unrelated secret text.' }] }, attribution);
  const id = detail.revision.id, version = detail.versions[0]!; let calls = 0, denied = false, sessionRevoked = false, edit = true, interact = true;
  const service = new AIProposalService(store, { configuration: () => config, authorize: (current, _id, action) => {
    if (sessionRevoked || current.sessionContext !== actor.sessionContext) throw new HttpError(401, 'Session ended.');
    if (denied) throw new HttpError(404, 'Unavailable.');
    if (action === 'apply' && !edit || action.startsWith('generate:') && !interact) throw new HttpError(403, 'Forbidden.');
  }, provider: async (...args) => { calls++; assert.doesNotThrow(() => store.database.exec('BEGIN IMMEDIATE; ROLLBACK'));  return provider ? provider(...args) : { result: rawResult(), responseModel: 'test-resolved-model', providerResponseId: 'response-fixture' }; } });
  const input = (): AIProposalGenerateInput => ({ provider: 'openai', model: config.model, instruction: 'Fix supported errors only; this instruction is private.', expectedHead: aiProposalHead(version), expectedAccessEpoch: Number(store.database.prepare("SELECT value FROM policy_meta WHERE name='epoch'").get()!.value), scope: null, allowHosted: true });
  return { store, id, version, service, input, calls: () => calls, deny() { denied = true; }, revokeSession() { sessionRevoked = true; }, noEdit() { edit = false; }, noInteract() { interact = false; }, close() { store.close(); } };
}
const applyInput = (detail: Awaited<ReturnType<AIProposalService['generate']>>) => ({ expectedHead: detail.currentHead, expectedAccessEpoch: detail.accessEpoch, expectedProposalSha256: detail.proposal.proposalSha256! });
const publicEvidence = (store: Store) => ['entities', 'versions', 'comments', 'activity', 'reviews', 'notification_events', 'notification_deliveries'].map(table => store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());

test('generation is private, immutable, owner-isolated, and exact retries never call the provider again', async () => {
  const f = fixture(); try {
    const before = publicEvidence(f.store), key = randomUUID(), input = f.input(), result = await f.service.generate(f.id, input, key, actor);
    assert.equal(result.proposal.status, 'ready'); assert.ok(isAIProposalDetail(result)); assert.equal(result.proposal.result!.edits[0]!.anchor.quote, 'Teh'); assert.equal(f.calls(), 1);
    assert.deepEqual(publicEvidence(f.store), before); assert.equal(JSON.stringify(before).includes(input.instruction), false);
    assert.deepEqual(await f.service.generate(f.id, input, key, actor), result); assert.equal(f.calls(), 1);
    assert.ok(isAIProposalList(f.service.list(f.id, actor))); assert.deepEqual(f.service.list(f.id, other).items, []);
    assert.throws(() => f.service.detail(f.id, result.proposal.id, other), status(404));
    await assert.rejects(f.service.generate(f.id, { ...input, instruction: 'Different request' }, key, actor), status(409));
    const second = await f.service.generate(f.id, input, randomUUID(), actor), page = f.service.list(f.id, actor, { limit: 1 });
    assert.equal(page.items[0]!.id, second.proposal.id); assert.ok(page.nextBefore); assert.equal(f.service.list(f.id, actor, { before: page.nextBefore!, limit: 1 }).items[0]!.id, result.proposal.id);
    for (const table of ['ai_proposal_requests', 'ai_proposal_results']) { assert.throws(() => f.store.database.exec(`DELETE FROM ${table}`), /immutable/); assert.throws(() => f.store.database.exec(`UPDATE ${table} SET data=data`), /immutable/); }
  } finally { f.close(); }
});
test('a concurrent exact retry and a recovered pending reservation do not redispatch', async () => {
  let resolve!: (value: { result: unknown; responseModel: null; providerResponseId: null }) => void;
  const f = fixture(() => new Promise(done => { resolve = done; })); try {
    const key = randomUUID(), input = f.input(), running = f.service.generate(f.id, input, key, actor);
    const pending = await f.service.generate(f.id, input, key, actor); assert.equal(pending.proposal.status, 'pending'); assert.equal(f.calls(), 1);
    let redispatch = 0; const recovered = new AIProposalService(f.store, { authorize() {}, configuration: () => config, provider: async () => { redispatch++; throw Error('Do not call'); } });
    assert.equal((await recovered.generate(f.id, input, key, actor)).proposal.status, 'pending'); assert.equal(redispatch, 0);
    resolve({ result: rawResult(), responseModel: null, providerResponseId: null }); assert.equal((await running).proposal.id, pending.proposal.id); assert.equal(f.calls(), 1);
  } finally { f.close(); }
});
test('uncertain failures and shutdown aborts are durable and do not retry provider charges', async () => {
  for (const aborted of [false, true]) {
    const controller = new AbortController(), f = fixture(async () => { if (aborted) { controller.abort(); return { result: rawResult(), responseModel: null, providerResponseId: null }; } throw new AIProposalProviderError('uncertain', 'The request was interrupted; outcome is unknown.'); });
    try { const input = f.input(), key = randomUUID(), first = await f.service.generate(f.id, input, key, actor, controller.signal); assert.equal(first.proposal.status, 'uncertain'); assert.equal(first.proposal.result, null); assert.equal((await f.service.generate(f.id, input, key, actor)).proposal.status, 'uncertain'); assert.equal(f.calls(), 1); } finally { f.close(); }
  }
});
test('scope includes only the exact selected text and rejects edits outside it, repeated quotes remain positional', async () => {
  const f = fixture(async (input, source) => {
    assert.equal(source.scope, 'passage'); assert.equal(source.files.length, 1); assert.equal(source.files[0]!.content, 'Same word.'); assert.equal(JSON.stringify(source).includes('Unrelated secret'), false); assert.equal(source.files[0]!.start, input.scope!.start);
    return { result: rawResult([{ filePath: 'paper.tex', start: input.scope!.start, end: input.scope!.start + 4, quote: 'Same', replacement: 'Another', explanation: 'Change only the explicitly selected occurrence.' }]), responseModel: null, providerResponseId: null };
  }); try {
    const start = f.version.files[0]!.content.lastIndexOf('Same word.'), input = { ...f.input(), scope: createPassageAnchor(f.version, 'paper.tex', { start, end: start + 10, quote: 'Same word.' }) };
    const result = await f.service.generate(f.id, input, randomUUID(), actor), applied = f.service.apply(f.id, result.proposal.id, applyInput(result), randomUUID(), actor);
    assert.equal(applied.proposal.applied!.toVersion, 2); assert.equal(f.store.detail(f.id).versions[1]!.files[0]!.content, 'Teh result.\nSame word. Another word.\n');
  } finally { f.close(); }
  const outside = fixture(); try { const start = 12, input = { ...outside.input(), scope: createPassageAnchor(outside.version, 'paper.tex', { start, end: 16, quote: 'Same' }) }; assert.equal((await outside.service.generate(outside.id, input, randomUUID(), actor)).proposal.status, 'failed'); } finally { outside.close(); }
});
test('overlap, no-op, forged quote, unknown fields and partial provider data fail the whole result', async () => {
  const valid = rawResult().edits[0]!;
  for (const value of [rawResult([valid, valid]), rawResult([{ ...(valid as object), replacement: 'Teh' }]), rawResult([{ ...(valid as object), quote: 'The' }]), { ...rawResult(), extra: true }, rawResult([{ ...(valid as object), explanation: '' }]), rawResult([{ ...(valid as object), replacement: '\ud800' }])]) {
    const f = fixture(async () => ({ result: value, responseModel: null, providerResponseId: null })); try { const before = publicEvidence(f.store), input = f.input(), key = randomUUID(), result = await f.service.generate(f.id, input, key, actor); assert.equal(result.proposal.status, 'failed'); assert.equal(result.proposal.result, null); assert.deepEqual(publicEvidence(f.store), before); await f.service.generate(f.id, input, key, actor); assert.equal(f.calls(), 1); } finally { f.close(); }
  }
});
test('truthful no-change proposals remain inspectable and cannot create a source version', async () => {
  const f = fixture(async () => ({ result: rawResult([]), responseModel: null, providerResponseId: null })); try { const result = await f.service.generate(f.id, f.input(), randomUUID(), actor); assert.equal(result.proposal.status, 'no_changes'); assert.equal(result.canApply, false); assert.ok(isAIProposalDetail(result)); assert.throws(() => f.service.apply(f.id, result.proposal.id, applyInput(result), randomUUID(), actor), status(409)); assert.equal(f.store.detail(f.id).revision.currentVersion, 1); } finally { f.close(); }
});
test('private operations enforce scopes, current credentials, policy and selected access epoch before dispatch', async () => {
  const f = fixture(); try {
    for (const scopes of [['read'], ['read', 'write'], ['write', 'review:hosted'], ['read', 'review:hosted']] as AuthContext['scopes'][]) await assert.rejects(f.service.generate(f.id, f.input(), randomUUID(), { ...actor, scopes }), status(403));
    await assert.rejects(f.service.generate(f.id, { ...f.input(), allowHosted: false }, randomUUID(), actor), status(400));
    await assert.rejects(f.service.generate(f.id, { ...f.input(), expectedAccessEpoch: 999 }, randomUUID(), actor), status(409));
    await assert.rejects(f.service.generate(f.id, { ...f.input(), model: 'not-configured' }, randomUUID(), actor), status(409));
    await assert.rejects(f.service.generate(f.id, f.input(), randomUUID(), { ...actor, sessionContext: 'different' }), status(401));
    f.noInteract(); await assert.rejects(f.service.generate(f.id, f.input(), randomUUID(), actor), status(403)); assert.equal(f.calls(), 0);
    assert.equal(f.store.database.prepare('SELECT count(*) n FROM ai_proposal_requests').get()!.n, 0);
  } finally { f.close(); }
});
test('credential or policy revocation during a call discards returned text and forbids reads and exact retries', async () => {
  for (const mode of ['policy', 'credential'] as const) { let revoke!: () => void; const f = fixture(async () => { revoke(); return { result: rawResult(), responseModel: null, providerResponseId: null }; }); revoke = mode === 'policy' ? f.deny : f.revokeSession; try { const key = randomUUID(), input = f.input(); await assert.rejects(f.service.generate(f.id, input, key, actor), status(mode === 'policy' ? 404 : 401)); await assert.rejects(f.service.generate(f.id, input, key, actor), status(mode === 'policy' ? 404 : 401)); assert.equal(f.calls(), 1); const raw = String(f.store.database.prepare('SELECT data FROM ai_proposal_results').get()!.data); assert.equal(JSON.parse(raw).result, null); assert.equal(raw.includes('Correct the misspelled'), false); } finally { f.close(); } }
});
test('the provider dispatch fence rechecks credential and exact source after asynchronous local setup', async () => {
  for (const mode of ['policy', 'head', 'epoch'] as const) {
    let change!: () => void, submitted = 0;
    const f = fixture(async (_input, _source, _signal, beforeDispatch) => { await Promise.resolve(); change(); beforeDispatch!(); submitted++; return { result: rawResult(), responseModel: null, providerResponseId: null }; });
    change = mode === 'policy' ? f.deny : mode === 'head' ? () => { f.store.createVersion(f.id, { expectedVersion: 1, files: f.version.files, message: 'Concurrent change' }, attribution); } : () => { f.store.database.exec("UPDATE policy_meta SET value=value+1 WHERE name='epoch'"); };
    try { const pending = f.service.generate(f.id, { ...f.input(), provider: 'ollama', model: config.localModel, allowHosted: false }, randomUUID(), actor); if (mode === 'policy') await assert.rejects(pending, status(404)); else assert.equal((await pending).proposal.status, 'failed'); assert.equal(submitted, 0); } finally { f.close(); }
  }
});
test('head or epoch changes during a call save only a failed attempt, while old ready proposals become stale', async () => {
  for (const mode of ['head', 'epoch'] as const) { let change!: () => void; const f = fixture(async () => { change(); return { result: rawResult(), responseModel: null, providerResponseId: null }; }); change = () => { if (mode === 'head') f.store.createVersion(f.id, { expectedVersion: 1, files: f.version.files, message: 'A concurrent upload' }, attribution); else f.store.database.exec("UPDATE policy_meta SET value=value+1 WHERE name='epoch'"); }; try { const result = await f.service.generate(f.id, f.input(), randomUUID(), actor); assert.equal(result.proposal.status, 'failed'); assert.equal(result.proposal.result, null); } finally { f.close(); } }
  const f = fixture(); try { const result = await f.service.generate(f.id, f.input(), randomUUID(), actor); f.store.createVersion(f.id, { expectedVersion: 1, files: f.version.files, message: 'Another source version' }, attribution); const current = f.service.detail(f.id, result.proposal.id, actor); assert.equal(current.stale, true); assert.equal(current.canApply, false); assert.throws(() => f.service.apply(f.id, result.proposal.id, applyInput(result), randomUUID(), actor), status(409)); } finally { f.close(); }
});
test('atomic apply preserves binary figures, invalidates acceptance and keeps private instructions out of public history', async () => {
  const f = fixture(); try {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
    const file = f.store.files.upload({ name: 'figure.png', dataBase64: png.toString('base64'), bytes: png.length, sha256: createHash('sha256').update(png).digest('hex') }, attribution);
    const assets = [{ path: 'figure.png', fileId: file.id, sha256: file.sha256, bytes: file.bytes, mediaType: 'image/png' as const }];
    const source = f.store.createVersion(f.id, { expectedVersion: 1, expectedVersionId: f.version.id, expectedContentHash: f.version.contentHash, files: f.version.files, assets, shareAssets: true, message: 'Attach figure' }, attribution).versions[1]!;
    f.store.saveReview(f.id, 2, { provider: 'local', model: 'deterministic', summary: 'Fixture check.', findings: [] }, attribution); lifecycleAction(f.store, f.id, 'accept_reviewed', attribution);
    const result = await f.service.generate(f.id, { ...f.input(), expectedHead: aiProposalHead(source) }, randomUUID(), actor), input = applyInput(result), key = randomUUID(), before = f.store.detail(f.id);
    const applied = f.service.apply(f.id, result.proposal.id, input, key, actor), after = f.store.detail(f.id);
    assert.ok(isAIProposalDetail(applied)); assert.equal(after.revision.currentVersion, 3); assert.equal(after.revision.status, 'needs_review'); assert.deepEqual(after.versions[2]!.assets, assets); assert.deepEqual(Buffer.from(f.store.files.readBytes(file.id)), png); assert.deepEqual(after.versions.slice(0, 2), before.versions); assert.deepEqual(after.reviews, before.reviews);
    assert.equal(after.versions[2]!.files[0]!.content.startsWith('The result.'), true); assert.match(after.versions[2]!.message, /AI-assisted.*openai.*configured-test-model/); assert.equal(JSON.stringify(after).includes(result.proposal.request.instruction), false);
    assert.deepEqual(f.service.apply(f.id, result.proposal.id, input, key, actor), applied); assert.equal(f.store.detail(f.id).revision.currentVersion, 3);
    assert.throws(() => f.service.apply(f.id, result.proposal.id, { ...input, expectedProposalSha256: 'a'.repeat(64) }, key, actor), status(409));
    f.noEdit(); assert.throws(() => f.service.apply(f.id, result.proposal.id, input, key, actor), status(403));
  } finally { f.close(); }
});
test('a source write failure rolls back source, activity, notifications and application evidence together', async () => {
  const f = fixture(); try {
    const result = await f.service.generate(f.id, f.input(), randomUUID(), actor), before = publicEvidence(f.store);
    f.store.database.exec("CREATE TRIGGER fail_ai_application BEFORE INSERT ON ai_proposal_applications BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
    assert.throws(() => f.service.apply(f.id, result.proposal.id, applyInput(result), randomUUID(), actor), /fixture failure/);
    assert.deepEqual(publicEvidence(f.store), before); assert.equal(f.service.detail(f.id, result.proposal.id, actor).proposal.applied, null);
  } finally { f.close(); }
});
test('schema initializer is repeatable and rolls back unexpected preexisting schemas', () => {
  const db = new DatabaseSync(':memory:'); try { db.exec('CREATE TABLE entities(id TEXT PRIMARY KEY)'); initializeAIProposals(db); const before = db.prepare("SELECT * FROM sqlite_schema WHERE name GLOB 'ai_proposal_*' ORDER BY name").all(); initializeAIProposals(db); assert.deepEqual(db.prepare("SELECT * FROM sqlite_schema WHERE name GLOB 'ai_proposal_*' ORDER BY name").all(), before); } finally { db.close(); }
  const bad = new DatabaseSync(':memory:'); try { bad.exec('CREATE TABLE ai_proposal_results(unexpected TEXT)'); assert.throws(() => initializeAIProposals(bad), /Unexpected/); assert.equal(bad.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='ai_proposal_requests'").get()!.n, 0); } finally { bad.close(); }
});
