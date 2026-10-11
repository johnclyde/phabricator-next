import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { createStore } from '../server/store.ts';
import { createAuth } from '../server/auth.ts';
import { createApp } from '../server/app.ts';
import { revisionMetadataInput, type RevisionMetadataSnapshot } from '../shared/revision-metadata.ts';
import { revisionMetadataCommand } from '../cli/revision-metadata.ts';
import { docxCommand } from '../cli/docx.ts';
import type { PaperCLI } from '../cli/paper-builds.ts';
import { createGitFixture } from './git-fixture.ts';

const executable = fileURLToPath(new URL('../cli/index.ts', import.meta.url)), loader = import.meta.resolve('tsx');
function cli(args: string[], token: string, cwd?: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', loader, executable, ...args], { cwd, env: { ...process.env, PHABRICATOR_URL: undefined, PHABRICATOR_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; }); child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; }); child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
}
function input(snapshot: RevisionMetadataSnapshot) {
  return revisionMetadataInput({ title: 'Exact title', summary: '\ufeff  Private metadata\r\n', testPlan: '\tInspect source and results.\n', message: '  Exact edit reason\n', expectedMetadataVersion: snapshot.metadata.version, expectedVersion: snapshot.head.number, expectedVersionId: snapshot.head.versionId, expectedContentHash: snapshot.head.contentHash, expectedAccessEpoch: snapshot.accessEpoch, expectedConfigId: snapshot.configId });
}

for (const basePath of ['/', '/review/']) test(`metadata CLI preserves exact edits, no-op and historical retry at ${basePath}`, async () => {
  const store = createStore({ path: ':memory:' }), provision = createAuth({ database: store.database, mode: 'local', basePath, provisioning: true });
  const author = await provision.createAccount({ username: 'author', displayName: 'Author', password: 'Strong CLI author password' }), editor = await provision.createAccount({ username: 'editor', displayName: 'Editor', password: 'Strong CLI editor password' });
  const app = createApp({ store, seed: false, authMode: 'password', basePath }), directory = await mkdtemp(join(tmpdir(), 'revision-metadata-cli-'));
  try {
    const writer = app.auth.createToken(editor.id, { name: 'Editor', scopes: ['read', 'write'] }), reader = app.auth.createToken(editor.id, { name: 'Read only', scopes: ['read'] });
    const detail = store.createRevision({ testPlan: 'Original plan.', kind: 'paper', title: 'CLI metadata source', files: [{ path: 'draft.txt', content: 'Private exact prose\n' }] }, { principalId: author.id, displayName: author.displayName, credentialId: null, requestId: 'cli-fixture' }), id = detail.revision.id;
    const policy = app.policies.policy(id, author.id); app.policies.setPolicy(id, { expectedVersion: policy.version, spaceId: policy.spaceId, view: { kind: 'workspace' }, edit: { kind: 'workspace' }, interact: { kind: 'principals', principalIds: [author.id] } }, author.id);
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve)); const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}${basePath}`;
    const read = await cli(['revision-metadata', id, '--server', url], reader.token); assert.equal(read.code, 0, read.stderr); const snapshot = JSON.parse(read.stdout) as RevisionMetadataSnapshot; assert.equal(snapshot.access.capabilities.interact, false);
    const data = input(snapshot), intent = join(directory, 'details.json'); await writeFile(intent, JSON.stringify(data));
    const args = ['edit-revision-metadata', id, '--intent', intent, '--request-id', 'exact-cli-details', '--server', url];
    assert.notEqual((await cli(args, reader.token)).code, 0);
    const first = await cli(args, writer.token); assert.equal(first.code, 0, first.stderr); const receipt = JSON.parse(first.stdout); assert.equal(receipt.changed, true); assert.equal(receipt.metadata.summary, data.summary); assert.equal(receipt.transaction.message, data.message); assert.deepEqual(store.detail(id).versions, detail.versions);
    assert.equal(first.stderr.includes('Private metadata'), false); assert.equal(first.stderr.includes(data.message), false); assert.equal(first.stderr.includes('Private exact prose'), false);
    const next = JSON.parse((await cli(['revision-metadata', id, '--server', url], reader.token)).stdout) as RevisionMetadataSnapshot; const noOp = input(next), noOpPath = join(directory, 'noop.json'); await writeFile(noOpPath, JSON.stringify(noOp));
    const unchanged = await cli(['edit-revision-metadata', id, '--intent', noOpPath, '--request-id', 'exact-noop', '--server', url], writer.token); assert.equal(unchanged.code, 0, unchanged.stderr); assert.equal(JSON.parse(unchanged.stdout).changed, false); assert.equal(JSON.parse(unchanged.stdout).transaction, null);
    store.createVersion(id, { expectedVersion: 1, files: [{ path: 'draft.txt', content: 'Later exact prose\n' }], message: 'Later source' });
    const historical = await cli(args, writer.token); assert.equal(historical.code, 0, historical.stderr); assert.deepEqual(JSON.parse(historical.stdout).transaction, receipt.transaction);
    assert.notEqual((await cli(['edit-revision-metadata', id, '--intent', intent, '--request-id', 'fresh-stale', '--server', url], writer.token)).code, 0);
    const history = await cli(['revision-metadata-history', id, '--limit', '1', '--metadata-version', String(receipt.metadata.version), '--server', url], reader.token); assert.equal(history.code, 0, history.stderr); assert.equal(JSON.parse(history.stdout).transactions.length, 1);
    const current = app.policies.policy(id, author.id); app.policies.setPolicy(id, { expectedVersion: current.version, spaceId: current.spaceId, ...current.rules, edit: { kind: 'principals', principalIds: [author.id] } }, author.id); assert.notEqual((await cli(args, writer.token)).code, 0);
  } finally { await app.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('metadata CLI rejects ambiguous options and unsafe intents before transmission', async () => {
  let calls = 0; const request: PaperCLI['request'] = async <T>() => { calls++; return {} as T; };
  const run = (command: string, options: Record<string, string>, optionNames = Object.keys(options)) => revisionMetadataCommand({ command, args: ['P1'], options, optionNames, request, download: async () => new Uint8Array() });
  for (const [command, options, names] of [['revision-metadata', { limit: '1' }, ['limit']], ['revision-metadata-history', { limit: '1' }, ['limit', 'limit']], ['revision-metadata-history', { 'metadata-version': '-1' }, ['metadata-version']], ['edit-revision-metadata', {}, []]] as const) await assert.rejects(run(command, options, [...names]));
  const directory = await mkdtemp(join(tmpdir(), 'metadata-intents-'));
  try {
    const invalid = join(directory, 'extra.json'); await writeFile(invalid, JSON.stringify({ title: 'Unpinned', extra: true })); await assert.rejects(run('edit-revision-metadata', { intent: invalid }));
    const link = join(directory, 'link.json'); await symlink(invalid, link); await assert.rejects(run('edit-revision-metadata', { intent: link }));
    assert.equal(calls, 0); await assert.rejects(run('revision-metadata', {}), /does not match/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('uncertain metadata CLI edits never refresh pins and reject unbound receipts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'metadata-recovery-')); const previousOut = console.log, previousError = console.error; const output: unknown[] = [], recovery: string[] = []; const calls: unknown[][] = [];
  try {
    console.log = value => { output.push(value); }; console.error = value => { recovery.push(String(value)); };
    const data = revisionMetadataInput({ title: 'Private title', summary: 'Private summary', testPlan: 'Private plan', message: 'Private reasoning\n', expectedMetadataVersion: 4, expectedVersion: 3, expectedVersionId: 'immutable-v3', expectedContentHash: 'a'.repeat(64), expectedAccessEpoch: 7, expectedConfigId: 'b'.repeat(64) });
    const intent = join(directory, 'exact.json'); await writeFile(intent, JSON.stringify(data));
    const request: PaperCLI['request'] = async <T>(...args: Parameters<PaperCLI['request']>) => { calls.push(args); throw new Error('Connection closed after write'); };
    const parameters: PaperCLI = { command: 'edit-revision-metadata', args: ['P1'], options: { intent, 'request-id': 'original-details' }, optionNames: ['intent', 'request-id'], request, download: async () => new Uint8Array() };
    await assert.rejects(revisionMetadataCommand(parameters), /Connection closed/); await assert.rejects(revisionMetadataCommand(parameters), /Connection closed/);
    assert.deepEqual(calls, Array.from({ length: 2 }, () => ['/api/revisions/P1/metadata', 'POST', data, 'original-details'])); assert.equal(output.length, 0);
    const record = JSON.parse(recovery[0]!); assert.equal(record.inputSha256, createHash('sha256').update(JSON.stringify(data)).digest('hex')); assert.equal(recovery.some(value => value.includes('Private')), false);
    await assert.rejects(revisionMetadataCommand({ ...parameters, request: async <T>() => ({ revisionId: 'P1', saved: true }) as T }), /receipt does not match/);
  } finally { console.log = previousOut; console.error = previousError; await rm(directory, { recursive: true, force: true }); }
});

test('Word CLI creation preserves optional historical absence and explicitly supplied test-plan choices', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'word-metadata-cli-')), path = join(directory, 'word.json'), calls: unknown[][] = [], oldLog = console.log, oldError = console.error;
  const data = { title: 'Word source', sourceFile: { fileId: 'F1', sha256: 'a'.repeat(64), bytes: 123 }, shareSource: false, expectedAccessEpoch: 3 };
  const request: PaperCLI['request'] = async <T>(...args: Parameters<PaperCLI['request']>) => { calls.push(args); return { saved: true } as T; };
  const run = (options: PaperCLI['options']) => docxCommand({ command: 'import-docx', args: [path], options, optionNames: Object.keys(options), request, download: async () => new Uint8Array() });
  try {
    console.log = console.error = () => {}; await writeFile(path, JSON.stringify(data));
    await run({ 'request-id': 'old-word' }); assert.deepEqual(calls[0], ['/api/revisions/docx', 'POST', data, 'old-word']);
    await run({ 'test-plan': ' \r\n', 'request-id': 'planned-word' }); assert.deepEqual(calls[1], ['/api/revisions/docx', 'POST', { ...data, testPlan: ' \r\n' }, 'planned-word']);
    await writeFile(path, JSON.stringify({ ...data, testPlan: 'Plan in immutable request file.' }));
    await assert.rejects(run({ 'test-plan': 'Conflicting flag' }), /not both/); assert.equal(calls.length, 2);
  } finally { console.log = oldLog; console.error = oldError; await rm(directory, { recursive: true, force: true }); }
});

test('native text and exact Git CLI creation include explicit test plans without changing existing revision saves', async () => {
  const fixture = await createGitFixture(), store = createStore({ path: ':memory:' }), app = createApp({ store, seed: false, gitRepositories: { R1: fixture.barePath } }), directory = await mkdtemp(join(tmpdir(), 'creation-metadata-cli-'));
  try {
    store.createRepository({ name: 'CLI Git source', remoteUrl: 'https://example.test/git.git', description: '', defaultBranch: 'main' });
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve)); const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const path = join(directory, 'paper.txt'); await writeFile(path, 'Exact CLI source\n');
    const text = await cli(['diff', '--title', 'CLI manuscript', '--kind', 'paper', '--test-plan', ' \n ', '--server', url, 'paper.txt'], '', directory); assert.equal(text.code, 0, text.stderr);
    const revision = store.state({ configured: false, model: null, localConfigured: false, localModel: null }).revisions.find(value => value.title === 'CLI manuscript')!; assert.ok(revision); assert.equal(store.revisionMetadata.snapshot(revision.id).metadata.testPlan, ' \n ');
    const git = await cli(['import-git', 'R1', '--commit', fixture.importCommit, '--title', 'CLI Git revision', '--test-plan', 'Inspect exact tree.', '--server', url, '--json'], ''); assert.equal(git.code, 0, git.stderr); const imported = JSON.parse(git.stdout); assert.equal(store.revisionMetadata.snapshot(imported.revision.id).metadata.testPlan, 'Inspect exact tree.');
    const unchanged = await cli(['diff', '--revision', revision.id, '--test-plan', 'Cannot replace metadata during source save.', '--server', url, 'paper.txt'], '', directory); assert.notEqual(unchanged.code, 0); assert.equal(store.detail(revision.id).revision.currentVersion, 1);
  } finally { await app.close(); store.close(); await fixture.close(); await rm(directory, { recursive: true, force: true }); }
});

test('metadata CLI accepts bounded full-size Unicode fields while rejecting oversized request files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'metadata-bounds-')), path = join(directory, 'request.json'), oldError = console.error;
  const data = revisionMetadataInput({ title: 'Bounded Unicode', summary: 'é'.repeat(100_000), testPlan: 'é'.repeat(100_000), message: '', expectedMetadataVersion: 0, expectedVersion: 1, expectedVersionId: 'immutable-source', expectedContentHash: 'a'.repeat(64), expectedAccessEpoch: 1, expectedConfigId: 'b'.repeat(64) });
  let calls = 0;
  const parameters: PaperCLI = { command: 'edit-revision-metadata', args: ['P1'], options: { intent: path, 'request-id': 'large-details' }, optionNames: ['intent', 'request-id'], download: async () => new Uint8Array(), request: async <T>(_path: string, method?: string, body?: unknown) => { calls++; assert.equal(method, 'POST'); assert.deepEqual(body, data); throw new Error('Simulated uncertain result'); } };
  try {
    console.error = () => {}; await writeFile(path, JSON.stringify(data)); await assert.rejects(revisionMetadataCommand(parameters), /uncertain result/); assert.equal(calls, 1);
    await writeFile(path, ' '.repeat(2 * 1024 * 1024 + 1)); await assert.rejects(revisionMetadataCommand(parameters), /regular files no larger/); assert.equal(calls, 1);
  } finally { console.error = oldError; await rm(directory, { recursive: true, force: true }); }
});
