import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fromBufferPromise } from 'yauzl';
import { ZipFile } from 'yazl';
import type { AuthContext } from '../shared/auth.ts';
import { aiProposalHead, aiProposalSourceVersion, aiProposalWordEdits, aiProposalResult, applyAIProposal, type AIProposalGenerateInput, type AIProposalDetail } from '../shared/ai-proposals.ts';
import { createPassageAnchor } from '../shared/anchors.ts';
import { Store } from './store.ts';
import { AIProposalService, type AIProposalOptions } from './ai-proposals.ts';
import { inspectDocx, replaceDocxBatch } from './docx-package.ts';
import { HttpError } from './validation.ts';

const actor: AuthContext = { workspaceId: 'word-proposals', principalId: 'U1', displayName: 'Verified Writer', credentialId: 'word-session', kind: 'session', sessionContext: 'word-session', scopes: ['read', 'write', 'review:hosted', 'review:local'] };
const attribution = { principalId: actor.principalId, displayName: actor.displayName, credentialId: actor.credentialId, requestId: 'word-fixture' };
const config = { configured: true, model: 'test-model', localConfigured: true, localModel: 'local-test' };
const status = (code: number) => (error: unknown) => error instanceof HttpError && error.status === code;
async function entries(bytes: Uint8Array): Promise<Map<string, Buffer>> {
  const zip = await fromBufferPromise(Buffer.from(bytes)), parts = new Map<string, Buffer>();
  try { for await (const entry of zip.eachEntry()) { const chunks: Buffer[] = []; for await (const chunk of await zip.openReadStreamPromise(entry)) chunks.push(Buffer.from(chunk)); parts.set(entry.fileName, Buffer.concat(chunks)); } } finally { zip.close(); }
  return parts;
}
async function packageBytes(count = 2, hiddenMarkup = false): Promise<Buffer> {
  const parts = await entries(await readFile(new URL('../tests/fixtures/docx/roundtrip.docx', import.meta.url)));
  const paragraphs = Array.from({ length: count }, (_, index) => `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Teh </w:t></w:r>${hiddenMarkup && !index ? '<w:bookmarkStart w:id="99" w:name="unprojected"/>' : ''}<w:r><w:rPr><w:i/></w:rPr><w:t>finding ${index}. Same word. Same word.</w:t></w:r></w:p>`).join('');
  parts.set('word/document.xml', Buffer.from(parts.get('word/document.xml')!.toString().replace('<w:body>', `<w:body>${paragraphs}`)));
  const zip = new ZipFile(), chunks: Buffer[] = [], done = new Promise<Buffer>((resolve, reject) => { zip.outputStream.on('data', chunk => chunks.push(Buffer.from(chunk))); zip.outputStream.once('end', () => resolve(Buffer.concat(chunks))); zip.outputStream.once('error', reject); });
  for (const [name, bytes] of parts) zip.addBuffer(bytes, name); zip.end(); return done;
}
const applyInput = (detail: AIProposalDetail) => ({ expectedHead: detail.currentHead, expectedAccessEpoch: detail.accessEpoch, expectedProposalSha256: detail.proposal.proposalSha256! });
const publicRows = (store: Store) => ['entities', 'versions', 'revision_docx_packages', 'activity', 'notification_events', 'notification_deliveries'].map(table => store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
async function fixture(options: { count?: number; hiddenMarkup?: boolean; provider?: AIProposalOptions['provider']; worker?: AIProposalOptions['replaceWordBatch'] } = {}) {
  const store = new Store({ path: ':memory:' }), bytes = await packageBytes(options.count, options.hiddenMarkup), projection = await inspectDocx(bytes);
  const file = store.files.upload({ name: 'manuscript.docx', dataBase64: bytes.toString('base64'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, attribution);
  const epoch = () => Number(store.database.prepare("SELECT value FROM policy_meta WHERE name='epoch'").get()!.value);
  const detail = store.createDocxRevision({ title: 'Word manuscript', testPlan: 'Inspect exact Word package changes.', sourceFile: { fileId: file.id, sha256: file.sha256, bytes: file.bytes }, expectedAccessEpoch: epoch(), shareSource: false }, bytes, projection, attribution), id = detail.revision.id, version = detail.versions[0]!;
  let providerCalls = 0, workerCalls = 0, denied = false, revoked = false;
  const service = new AIProposalService(store, { configuration: () => config, authorize(current) { if (revoked || current.sessionContext !== actor.sessionContext) throw new HttpError(401, 'Session ended'); if (denied) throw new HttpError(404, 'Unavailable'); }, provider: async (...args) => {
    providerCalls++; assert.doesNotThrow(() => store.database.exec('BEGIN IMMEDIATE; ROLLBACK'));
    if (options.provider) return options.provider(...args);
    const source = args[1];
    return { result: { summary: 'Correct supported spelling.', limitations: 'No claims or citations were verified.', edits: source.files.filter(file => file.content.startsWith('Teh ')).map(file => ({ filePath: file.path, start: 0, end: 3, quote: 'Teh', replacement: 'The', explanation: 'Correct the misspelling.' })) }, responseModel: 'test-resolved', providerResponseId: null };
  }, replaceWordBatch: async (...args) => { workerCalls++; assert.doesNotThrow(() => store.database.exec('BEGIN IMMEDIATE; ROLLBACK')); return (options.worker ?? replaceDocxBatch)(...args); } });
  const input = (): AIProposalGenerateInput => ({ provider: 'openai', model: config.model, instruction: 'Fix supported errors only; private editorial instructions.', expectedHead: aiProposalHead(version), expectedAccessEpoch: epoch(), scope: null, allowHosted: true });
  return { store, bytes, projection, version, id, service, input, providerCalls: () => providerCalls, workerCalls: () => workerCalls, deny() { denied = true; }, revoke() { revoked = true; }, close() { store.close(); } };
}

test('Word source uses stable original paragraph positions and excludes notes, comments and tracked passages', async () => {
  const f = await fixture(); try {
    const source = aiProposalSourceVersion(f.version); assert.equal(source.id, f.version.id); assert.equal(source.contentHash, f.version.contentHash); assert.equal(source.docx, undefined); assert.equal(source.files[0]!.path, 'docx/paragraph-1.txt');
    assert.ok(f.projection.notes.length && f.projection.comments.length && f.projection.changes.length);
    for (const file of source.files) { const index = Number(/paragraph-(\d+)/.exec(file.path)![1]) - 1; assert.equal(file.content, f.projection.blocks[index]!.text); assert.ok(f.projection.blocks[index]!.runs.every(run => !run.change && !run.noteId && !run.commentIds?.length && run.rangeId)); }
    const empty = structuredClone(f.version); empty.docx!.projection.blocks = []; assert.throws(() => aiProposalSourceVersion(empty), /no supported/);
    const result = await f.service.generate(f.id, f.input(), randomUUID(), actor); assert.equal(result.proposal.status, 'ready'); assert.equal(result.proposal.result!.edits.length, 2);
    const edits = aiProposalWordEdits(f.version, result.proposal.result!); assert.equal(edits[1]!.blockId, f.projection.blocks[1]!.id);
    const invalid = structuredClone(result.proposal.result!); invalid.edits[1]!.replacement = 'two\nlines'; assert.throws(() => applyAIProposal(f.version, invalid), /single-line/);
  } finally { f.close(); }
});

test('Word generation and atomic tracked application preserve packages, acceptance history, private instructions and exact retries', async () => {
  const f = await fixture(); try {
    const snapshot = f.store.revisionReviewers.snapshot(f.id);
    f.store.revisionReviewers.mutate(f.id, { action: 'accept', message: 'Reviewed Word source.', expectedReviewerVersion: snapshot.reviewers.version, expectedLifecycleVersion: snapshot.lifecycle.version, expectedAuthorVersion: snapshot.authorship.version, expectedVersion: snapshot.head.number, expectedVersionId: snapshot.head.versionId, expectedContentHash: snapshot.head.contentHash, expectedAccessEpoch: f.input().expectedAccessEpoch, expectedConfigId: snapshot.configId, expectedEvidenceSha256: snapshot.evidence.sha256 }, { ...attribution, principalId: 'U2', displayName: 'Independent reviewer' });
    assert.equal(f.store.detail(f.id).revision.status, 'accepted');
    const before = publicRows(f.store), input = f.input(), generationKey = randomUUID(), result = await f.service.generate(f.id, input, generationKey, actor);
    assert.deepEqual(publicRows(f.store), before); assert.deepEqual(await f.service.generate(f.id, input, generationKey, actor), result); assert.equal(f.providerCalls(), 1);
    assert.throws(() => f.service.detail(f.id, result.proposal.id, { ...actor, principalId: 'U2' }), status(404));
    const body = applyInput(result), key = randomUUID(), applied = await f.service.applyAsync(f.id, result.proposal.id, body, key, actor), detail = f.store.detail(f.id), to = detail.versions[1]!;
    assert.equal(detail.revision.status, 'needs_review'); assert.equal(to.docxOperation!.kind, 'replace-batch'); assert.deepEqual(to.docx!.sourceFile, f.version.docx!.sourceFile); assert.deepEqual(detail.versions[0], f.version); assert.equal(to.files.length, 0);
    assert.deepEqual(to.docx!.projection.blocks.slice(0, 2).map(block => block.runs.filter(run => run.change !== 'deleted').map(run => run.text).join('')), ['The finding 0. Same word. Same word.', 'The finding 1. Same word. Same word.']);
    assert.deepEqual(to.docx!.projection.notes, f.projection.notes); assert.deepEqual(to.docx!.projection.comments, f.projection.comments); assert.match(to.message, /AI-assisted.*test-model/); assert.equal(JSON.stringify(detail).includes(input.instruction), false);
    const originalParts = await entries(f.bytes), editedParts = await entries(f.store.docxBytes(f.id, to.id)); for (const [name, bytes] of originalParts) if (name !== f.projection.mainPart) assert.deepEqual(editedParts.get(name), bytes, name);
    assert.deepEqual(await f.service.applyAsync(f.id, result.proposal.id, body, key, actor), applied); assert.equal(f.workerCalls(), 1); assert.equal(f.store.detail(f.id).revision.currentVersion, 2);
    await assert.rejects(f.service.applyAsync(f.id, result.proposal.id, { ...body, expectedProposalSha256: 'b'.repeat(64) }, key, actor), status(409));
    f.deny(); await assert.rejects(f.service.applyAsync(f.id, result.proposal.id, body, key, actor), status(404)); assert.equal(f.workerCalls(), 1);
  } finally { f.close(); }
});

test('Word scope submits only the selected occurrence and rejects multiline, overlap and unsupported edits as a whole', async () => {
  let f!: Awaited<ReturnType<typeof fixture>>;
  f = await fixture({ provider: async (input, source) => {
    assert.equal(source.files.length, 1); assert.equal(source.files[0]!.content, 'Same word.'); assert.equal(JSON.stringify(source).includes('Teh finding'), false);
    return { result: { summary: 'Change the selected occurrence.', limitations: 'No external validation.', edits: [{ filePath: input.scope!.filePath, start: input.scope!.start, end: input.scope!.start + 4, quote: 'Same', replacement: 'Another', explanation: 'Requested exact occurrence.' }] }, responseModel: null, providerResponseId: null };
  } }); try {
    const source = aiProposalSourceVersion(f.version), file = source.files[0]!, start = file.content.lastIndexOf('Same word.'), scope = createPassageAnchor(source, file.path, { start, end: start + 10, quote: 'Same word.' });
    const result = await f.service.generate(f.id, { ...f.input(), scope }, randomUUID(), actor); await f.service.applyAsync(f.id, result.proposal.id, applyInput(result), randomUUID(), actor);
    assert.equal(f.store.detail(f.id).versions[1]!.docx!.projection.blocks[0]!.runs.filter(run => run.change !== 'deleted').map(run => run.text).join(''), 'Teh finding 0. Same word. Another word.');
    const edit = { filePath: file.path, start: 0, end: 3, quote: 'Teh', replacement: 'The', explanation: 'Spelling' }, base = { summary: 'Correction', limitations: 'No external validation' };
    for (const edits of [[edit, edit], [edit, { ...edit, replacement: 'a\nb' }], [edit, { ...edit, filePath: 'docx/paragraph-999.txt' }]]) assert.throws(() => aiProposalResult({ ...base, edits }, f.version, null));
  } finally { f.close(); }
});

test('Word apply rechecks head, access epoch, session and cancellation after worker; failed receipt rolls back all writes', async () => {
  for (const mode of ['policy', 'session', 'epoch', 'abort', 'write'] as const) {
    const controller = new AbortController(); let alter!: () => void;
    const f = await fixture({ worker: async (...args) => { const result = await replaceDocxBatch(...args); alter(); return result; } });
    try {
      const result = await f.service.generate(f.id, f.input(), randomUUID(), actor), before = publicRows(f.store);
      alter = mode === 'policy' ? f.deny : mode === 'session' ? f.revoke : mode === 'epoch' ? () => { f.store.database.exec("UPDATE policy_meta SET value=value+1 WHERE name='epoch'"); } : mode === 'abort' ? () => controller.abort() : () => { f.store.database.exec("CREATE TRIGGER fail_word_ai BEFORE INSERT ON ai_proposal_applications BEGIN SELECT RAISE(ABORT,'receipt failed'); END"); };
      await assert.rejects(f.service.applyAsync(f.id, result.proposal.id, applyInput(result), randomUUID(), actor, controller.signal));
      assert.deepEqual(publicRows(f.store), before); assert.equal(f.store.database.prepare('SELECT count(*) n FROM ai_proposal_applications').get()!.n, 0);
    } finally { f.close(); }
  }
});

test('Word worker rejects hidden complex markup without applying a partial proposal or repeating generation', async () => {
  const f = await fixture({ hiddenMarkup: true }); try {
    const key = randomUUID(), input = f.input(), result = await f.service.generate(f.id, input, key, actor), before = publicRows(f.store); assert.equal(result.proposal.status, 'ready');
    await assert.rejects(f.service.applyAsync(f.id, result.proposal.id, applyInput(result), randomUUID(), actor), /ordinary main-document/);
    assert.deepEqual(publicRows(f.store), before); assert.equal(f.service.detail(f.id, result.proposal.id, actor).proposal.applied, null); await f.service.generate(f.id, input, key, actor); assert.equal(f.providerCalls(), 1);
  } finally { f.close(); }
});

test('Word proposals permit more than 100 supported paragraphs without a passage-count cap', async () => {
  const f = await fixture({ count: 120 }); try { const result = await f.service.generate(f.id, f.input(), randomUUID(), actor); assert.equal(result.proposal.result!.edits.length, 120); const applied = await f.service.applyAsync(f.id, result.proposal.id, applyInput(result), randomUUID(), actor); assert.equal(applied.proposal.applied!.toVersion, 2); assert.equal(f.workerCalls(), 1); } finally { f.close(); }
});

test('Word application reads verify the operation hash rather than trusting an otherwise valid receipt', async () => {
  const f = await fixture(); try {
    const result = await f.service.generate(f.id, f.input(), randomUUID(), actor), input = applyInput(result), key = randomUUID(), applied = await f.service.applyAsync(f.id, result.proposal.id, input, key, actor);
    const to = f.store.detail(f.id).versions[1]!; to.docxOperation!.inputSha256 = 'a'.repeat(64);
    f.store.database.exec('DROP TRIGGER docx_versions_no_update'); f.store.database.prepare('UPDATE versions SET data=? WHERE id=?').run(JSON.stringify(to), applied.proposal.applied!.toVersionId);
    assert.throws(() => f.service.detail(f.id, result.proposal.id, actor), /could not be verified/); await assert.rejects(f.service.applyAsync(f.id, result.proposal.id, input, key, actor), /could not be verified/); assert.equal(f.workerCalls(), 1);
  } finally { f.close(); }
});

test('concurrent Word application retries commit one version and a competing new head prevents the stale application', async () => {
  let release!: () => void, ready!: () => void, first = true;
  const held = new Promise<void>(done => { ready = done; }), gate = new Promise<void>(done => { release = done; });
  const f = await fixture({ worker: async (...args) => { const result = await replaceDocxBatch(...args); if (first) { first = false; ready(); await gate; } return result; } });
  try {
    const proposal = await f.service.generate(f.id, f.input(), randomUUID(), actor), body = applyInput(proposal), key = randomUUID();
    const pending = f.service.applyAsync(f.id, proposal.proposal.id, body, key, actor); await held;
    const applied = await f.service.applyAsync(f.id, proposal.proposal.id, body, key, actor); release(); assert.deepEqual(await pending, applied);
    assert.equal(f.store.detail(f.id).revision.currentVersion, 2); assert.equal(f.store.database.prepare('SELECT count(*) n FROM ai_proposal_applications').get()!.n, 1);
  } finally { release(); f.close(); }
  let advance!: (result: Awaited<ReturnType<typeof replaceDocxBatch>>, replacements: Parameters<typeof replaceDocxBatch>[1]) => void;
  const stale = await fixture({ worker: async (...args) => { const result = await replaceDocxBatch(...args); advance(result, args[1]); return result; } });
  try {
    const proposal = await stale.service.generate(stale.id, stale.input(), randomUUID(), actor);
    advance = (result, replacements) => { stale.store.replaceDocxBatchVersion(stale.id, { expectedVersion: stale.version.number, expectedVersionId: stale.version.id, expectedContentHash: stale.version.contentHash, expectedAccessEpoch: stale.input().expectedAccessEpoch, message: 'Independent edit', replacements }, result.bytes, result.projection, attribution); };
    await assert.rejects(stale.service.applyAsync(stale.id, proposal.proposal.id, applyInput(proposal), randomUUID(), actor), status(409));
    assert.equal(stale.store.detail(stale.id).revision.currentVersion, 2); assert.equal(stale.store.detail(stale.id).versions[1]!.message, 'Independent edit'); assert.equal(stale.store.database.prepare('SELECT count(*) n FROM ai_proposal_applications').get()!.n, 0);
  } finally { stale.close(); }
});

test('Word worker result validation rejects changed attribution or unrelated text before any source commit', async () => {
  for (const tamper of ['attribution', 'text'] as const) {
    const f = await fixture({ worker: async (...args) => {
      const result = await replaceDocxBatch(...args);
      if (tamper === 'attribution') result.projection.changes.find(change => change.author === actor.displayName)!.author = 'Forged author';
      else { const last = result.projection.blocks.at(-1)!; last.text += 'Unexpected change'; last.runs.push({ text: 'Unexpected change' }); }
      return result;
    } });
    try { const proposal = await f.service.generate(f.id, f.input(), randomUUID(), actor), before = publicRows(f.store); await assert.rejects(f.service.applyAsync(f.id, proposal.proposal.id, applyInput(proposal), randomUUID(), actor), /could not be verified/); assert.deepEqual(publicRows(f.store), before); } finally { f.close(); }
  }
});
