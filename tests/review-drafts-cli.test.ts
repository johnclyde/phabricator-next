import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { Store } from '../server/store.ts';
import { createApp } from '../server/app.ts';
import { createAuth } from '../server/auth.ts';
import { reviewDraftsCommand } from '../cli/review-drafts.ts';
import type { PaperCLI } from '../cli/paper-builds.ts';
import { reviewDraftRequestCanonical, type ReviewDraftPreview, type ReviewDraftSaveInput, type ReviewDraftSnapshot } from '../shared/review-drafts.ts';
import type { ActorAttribution } from '../shared/types.ts';

const executable = fileURLToPath(new URL('../cli/index.ts', import.meta.url)), loader = import.meta.resolve('tsx');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function cli(args: string[], token = '', input?: string | Buffer) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', loader, executable, ...args], { env: { ...process.env, PHABRICATOR_URL: undefined, PHABRICATOR_TOKEN: token }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; }); child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; }); child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr })); child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}
const actor: ActorAttribution = { principalId: 'alice', displayName: 'Alice', credentialId: null, requestId: 'cli-fixture' };
function fixture(store: Store) {
  const detail = store.createRevision({ kind: 'paper', title: 'CLI private review', testPlan: 'Read exact source.', files: [{ path: 'paper.tex', content: 'Original argument.\n' }] }, actor), id = detail.revision.id, version = detail.versions[0]!;
  const input: ReviewDraftSaveInput = { expectedEntryVersion: 0, expectedAccessEpoch: 1, payload: { kind: 'comment', body: '\ufeff  Exact unpublished reasoning\r\n', versionId: version.id, contentHash: version.contentHash, filePath: 'paper.tex', line: 1, passage: { start: 0, end: 8, quote: 'Original' }, suggestion: { replacement: 'Revised' } } };
  return { id, input };
}
function parameters(command: string, args: string[], options: PaperCLI['options'], request: PaperCLI['request'], optionNames = Object.keys(options)): PaperCLI { return { command, args, options, optionNames, request, download: async () => new Uint8Array() }; }

for (const basePath of ['/', '/mounted/']) test(`private draft CLI stages, discovers, previews, publishes and recovers exactly at ${basePath}`, async () => {
  const store = new Store({ path: ':memory:' }), provision = createAuth({ database: store.database, mode: 'local', basePath, provisioning: true });
  const author = await provision.createAccount({ username: 'author', displayName: 'Author', password: 'Private CLI author password' }), reviewer = await provision.createAccount({ username: 'reviewer', displayName: 'Reviewer', password: 'Private CLI reviewer password' });
  const app = createApp({ store, seed: false, authMode: 'password', basePath }), directory = await mkdtemp(join(tmpdir(), 'review-drafts-cli-'));
  try {
    const writer = app.auth.createToken(reviewer.id, { name: 'Reviewer', scopes: ['read', 'write'] }), reader = app.auth.createToken(reviewer.id, { name: 'Reader', scopes: ['read'] }), other = app.auth.createToken(author.id, { name: 'Author', scopes: ['read', 'write'] });
    const detail = store.createRevision({ kind: 'paper', title: 'Private CLI manuscript', testPlan: 'Read text.', files: [{ path: 'paper.tex', content: 'Original argument.\n' }] }, { principalId: author.id, displayName: author.displayName, credentialId: null, requestId: 'fixture' }), id = detail.revision.id, version = detail.versions[0]!;
    const policy = app.policies.policy(id, author.id); app.policies.setPolicy(id, { expectedVersion: policy.version, spaceId: policy.spaceId, view: { kind: 'workspace' }, interact: { kind: 'workspace' }, edit: { kind: 'principals', principalIds: [author.id] } }, author.id);
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve)); const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}${basePath}`;
    const run = (args: string[], token = writer.token, input?: string | Buffer) => cli([...args, '--server', url], token, input);
    const entryId = randomUUID(), input: ReviewDraftSaveInput = { expectedEntryVersion: 0, expectedAccessEpoch: app.policies.epoch(), payload: { kind: 'comment', body: '\ufeff  Exact unpublished @author text\r\n', versionId: version.id, contentHash: version.contentHash, filePath: 'paper.tex', line: 1, passage: { start: 0, end: 8, quote: 'Original' }, suggestion: { replacement: 'Revised' } } };
    const intent = join(directory, 'entry.json'); await writeFile(intent, JSON.stringify(input));
    const saveArgs = ['save-review-draft', id, entryId, '--intent', intent, '--request-id', 'save-exact-entry'];
    assert.notEqual((await run(saveArgs, reader.token)).code, 0);
    const saved = await run(['save-review-draft', id, entryId, '--intent', '-', '--request-id', 'save-exact-entry'], writer.token, JSON.stringify(input)); assert.equal(saved.code, 0, saved.stderr); assert.equal(JSON.parse(saved.stdout).entry.payload.body, input.payload.body); assert.equal(saved.stderr.includes('unpublished'), false); assert.equal(saved.stderr.includes('Original'), false); assert.equal(store.detail(id).comments.length, 0);
    const retrySave = await run(saveArgs); assert.equal(retrySave.code, 0, retrySave.stderr); assert.equal(JSON.parse(retrySave.stdout).operationId, JSON.parse(saved.stdout).operationId);
    const own = await run(['review-drafts', id], reader.token); assert.equal(own.code, 0, own.stderr); const snapshot = JSON.parse(own.stdout) as ReviewDraftSnapshot; assert.equal(snapshot.entries.length, 1); assert.equal(snapshot.principalId, reviewer.id);
    const foreign = await run(['review-drafts', id], other.token); assert.equal(foreign.code, 0); assert.deepEqual(JSON.parse(foreign.stdout).entries, []);
    const discovered = await run(['review-drafts', '--limit', '1']); assert.equal(discovered.code, 0, discovered.stderr); assert.equal(JSON.parse(discovered.stdout).items[0].revisionId, id);
    const discardId = randomUUID(), discardSave = { ...input, payload: { ...input.payload, body: 'Remove this private alternative' } }; const staged = await run(['save-review-draft', id, discardId, '--intent', '-', '--request-id', 'discard-staging'], writer.token, JSON.stringify(discardSave)); assert.equal(staged.code, 0, staged.stderr);
    const discardInput = { expectedEntryVersion: 1, expectedAccessEpoch: app.policies.epoch() }; const discarded = await run(['discard-review-draft', id, discardId, '--intent', '-', '--request-id', 'discard-exact'], writer.token, JSON.stringify(discardInput)); assert.equal(discarded.code, 0, discarded.stderr); assert.equal(JSON.parse(discarded.stdout).entry.state, 'discarded');
    const preview = await run(['preview-review-drafts', id], reader.token); assert.equal(preview.code, 0, preview.stderr); const prepared = JSON.parse(preview.stdout) as ReviewDraftPreview; assert.equal(prepared.entries.length, 1);
    const previewPath = join(directory, 'review-preview.json'); await writeFile(previewPath, preview.stdout);
    const publishArgs = ['publish-review-drafts', id, '--intent', previewPath, '--request-id', 'publish-exact-review']; assert.notEqual((await run(publishArgs, reader.token)).code, 0);
    const published = await run(publishArgs); assert.equal(published.code, 0, published.stderr); const receipt = JSON.parse(published.stdout); assert.equal(receipt.published[0].comment.body, input.payload.body); assert.equal(receipt.published[0].comment.anchor.quote, 'Original'); assert.equal(store.detail(id).comments.length, 1);
    store.createVersion(id, { expectedVersion: 1, message: 'Later source', files: [{ path: 'paper.tex', content: 'Later argument.' }] });
    const recovered = await run(publishArgs); assert.equal(recovered.code, 0, recovered.stderr); assert.deepEqual(JSON.parse(recovered.stdout).published, receipt.published); assert.equal(store.detail(id).comments.length, 1);
    assert.notEqual((await run(['publish-review-drafts', id, '--intent', previewPath, '--request-id', 'fresh-stale-review'])).code, 0);
    const active = await run(['review-drafts', id]); assert.deepEqual(JSON.parse(active.stdout).entries, []);
    const current = app.policies.policy(id, author.id); app.policies.setPolicy(id, { expectedVersion: current.version, spaceId: current.spaceId, ...current.rules, interact: { kind: 'principals', principalIds: [author.id] } }, author.id); assert.notEqual((await run(publishArgs)).code, 0);
  } finally { await app.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('private draft CLI rejects ambiguous options and unsafe or malformed files before any network request', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'review-draft-intents-')); let calls = 0; const request: PaperCLI['request'] = async <T>() => { calls++; return {} as T; };
  try {
    for (const args of [parameters('review-drafts', [], { limit: '0' }, request), parameters('review-drafts', ['P1'], { after: 'P1' }, request), parameters('review-drafts', [], { limit: '1' }, request, ['limit', 'limit']), parameters('review-drafts', [], { principal: 'other' }, request), parameters('save-review-draft', ['P1', 'bad-id'], { intent: '-' }, request), parameters('publish-review-drafts', ['P1'], {}, request)]) await assert.rejects(reviewDraftsCommand(args));
    const path = join(directory, 'invalid.json'); await writeFile(path, JSON.stringify({ expectedEntryVersion: 0, payload: { body: 'Unpinned' } })); const entryId = randomUUID();
    const run = (intent: string) => reviewDraftsCommand(parameters('save-review-draft', ['P1', entryId], { intent }, request));
    await assert.rejects(run(path)); const link = join(directory, 'link.json'); await symlink(path, link); await assert.rejects(run(link)); await assert.rejects(run(directory));
    await writeFile(path, Buffer.from([0xff, 0xfe])); await assert.rejects(run(path)); await writeFile(path, ' '.repeat(2 * 1024 * 1024 + 1)); await assert.rejects(run(path), /regular files no larger/);
    assert.equal(calls, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('uncertain CLI saves preserve request identity and never refresh pins or print private recovery content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'review-draft-uncertain-')), store = new Store({ path: ':memory:' }), previousOut = console.log, previousError = console.error; const recovery: string[] = [], output: string[] = [], calls: unknown[][] = [];
  try {
    console.log = value => output.push(String(value)); console.error = value => recovery.push(String(value));
    const f = fixture(store), id = randomUUID(), path = join(directory, 'request.json'); await writeFile(path, JSON.stringify(f.input));
    const request: PaperCLI['request'] = async <T>(...args: Parameters<PaperCLI['request']>) => { calls.push(args); throw new Error('Disconnected after send'); };
    const args = parameters('save-review-draft', [f.id, id], { intent: path, 'request-id': 'fixed-save' }, request);
    await assert.rejects(reviewDraftsCommand(args), /Disconnected/); await assert.rejects(reviewDraftsCommand(args), /Disconnected/);
    assert.deepEqual(calls, Array.from({ length: 2 }, () => [`/api/revisions/${f.id}/review-drafts/${id}`, 'PUT', f.input, 'fixed-save'])); assert.deepEqual(output, []);
    const record = JSON.parse(recovery[0]!); assert.equal(record.inputSha256, digest(reviewDraftRequestCanonical('save', id, f.input))); assert.equal(record.requestId, 'fixed-save'); assert.equal(recovery.some(line => line.includes('unpublished') || line.includes('Original') || line.includes('Revised')), false);
    await assert.rejects(reviewDraftsCommand({ ...args, request: async <T>() => ({ saved: true }) as T }), /receipt does not match/);
  } finally { console.log = previousOut; console.error = previousError; store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('CLI complete preview and publication reject tampered draft hashes, partial manifests and mismatched literal receipt text', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'review-draft-preview-')), store = new Store({ path: ':memory:' }), previousOut = console.log, previousError = console.error; let calls = 0;
  try {
    console.log = console.error = () => {};
    const f = fixture(store), entryId = randomUUID(); store.reviewDrafts.save(f.id, entryId, f.input, actor, digest('save')); const preview = store.reviewDrafts.preview(f.id, actor.principalId), path = join(directory, 'preview.json');
    const request: PaperCLI['request'] = async <T>() => { calls++; throw new Error('Unexpected request'); };
    const run = () => reviewDraftsCommand(parameters('publish-review-drafts', [f.id], { intent: path, 'request-id': 'publish-fixed' }, request));
    for (const bad of [{ manifest: preview.manifest }, { ...preview, entries: [{ ...preview.entries[0]!, payload: { ...preview.entries[0]!.payload, body: 'Altered private text' } }] }, { ...preview, manifest: { ...preview.manifest, entries: [] } }, { ...preview, manifest: { ...preview.manifest, sources: [{ versionId: f.input.payload.kind !== 'reply' ? f.input.payload.versionId : '', contentHash: 'b'.repeat(64) }] } }]) { await writeFile(path, JSON.stringify(bad)); await assert.rejects(run(), /complete unchanged JSON/); }
    assert.equal(calls, 0); await writeFile(path, JSON.stringify(preview)); const receipt = store.reviewDrafts.publish(f.id, { manifest: preview.manifest }, actor, digest('publish'));
    const malicious = { ...receipt, published: receipt.published.map(item => ({ ...item, comment: { ...item.comment, body: 'Different published text' } })) };
    await assert.rejects(reviewDraftsCommand(parameters('publish-review-drafts', [f.id], { intent: path, 'request-id': 'publish-fixed' }, async <T>() => malicious as T)), /reviewed text and anchors/);
    assert.equal(await reviewDraftsCommand(parameters('publish-review-drafts', [f.id], { intent: path, 'request-id': 'publish-fixed' }, async <T>() => receipt as T)), true);
    await assert.rejects(reviewDraftsCommand(parameters('review-drafts', [f.id], {}, async <T>() => ({ ...preview, entries: [{ ...preview.entries[0]!, payloadSha256: 'a'.repeat(64) }] }) as T)), /does not match/);
  } finally { console.log = previousOut; console.error = previousError; store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('stdin intent parsing fails locally for missing, malformed, non-object and oversized UTF-8 input', async () => {
  const args = ['save-review-draft', 'P1', randomUUID(), '--intent', '-', '--request-id', 'stdin-parse', '--server', 'http://127.0.0.1:1'];
  for (const value of ['', '[]', '{not json}', Buffer.from([0xff]), ' '.repeat(2 * 1024 * 1024 + 1)]) { const result = await cli(args, '', value); assert.notEqual(result.code, 0); assert.equal(result.stderr.includes('fetch failed'), false); assert.equal(result.stdout, ''); }
});
