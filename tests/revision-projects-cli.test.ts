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
import { createGitFixture } from './git-fixture.ts';
import { revisionProjectInput, type RevisionProjectSnapshot, type RevisionProjectHistory, type RevisionProjectReceipt } from '../shared/revision-projects.ts';
import { revisionProjectsCommand } from '../cli/revision-projects.ts';
import { docxCommand } from '../cli/docx.ts';
import type { PaperCLI } from '../cli/paper-builds.ts';

const executable = fileURLToPath(new URL('../cli/index.ts', import.meta.url)), loader = import.meta.resolve('tsx');
function cli(args: string[], token: string, cwd?: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', loader, executable, ...args], { cwd, env: { ...process.env, PHABRICATOR_URL: undefined, PHABRICATOR_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; }); child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; }); child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
}
for (const basePath of ['/', '/review/']) test(`project-tag CLI preserves exact requests and filtered historical tags at ${basePath}`, async () => {
  const store = createStore({ path: ':memory:' }), provision = createAuth({ database: store.database, mode: 'local', basePath, provisioning: true });
  const author = await provision.createAccount({ username: 'author', displayName: 'Author', password: 'Strong project CLI author password' }), editor = await provision.createAccount({ username: 'editor', displayName: 'Editor', password: 'Strong project CLI editor password' });
  const app = createApp({ store, seed: false, authMode: 'password', basePath }), directory = await mkdtemp(join(tmpdir(), 'revision-projects-cli-'));
  try {
    const writer = app.auth.createToken(editor.id, { name: 'Editor', scopes: ['read', 'write'] }), reader = app.auth.createToken(editor.id, { name: 'Reader', scopes: ['read'] }), actor = { principalId: author.id, displayName: author.displayName, credentialId: null, requestId: 'cli-fixture' };
    const first = store.createProject({ name: 'First' }, actor), second = store.createProject({ name: 'Second' }, actor), secret = store.createProject({ name: 'Hidden original' }, actor);
    const policy = (id: string, rules: Record<string, unknown>) => { const p = app.policies.policy(id, author.id); app.policies.setPolicy(id, { expectedVersion: p.version, spaceId: p.spaceId, ...p.rules, ...rules }, author.id); };
    policy(secret.id, { view: { kind: 'principals', principalIds: [author.id] } });
    const detail = store.createRevision({ testPlan: 'Inspect source.', kind: 'paper', title: 'CLI tagged source', projectIds: [secret.id], files: [{ path: 'draft.txt', content: 'Private exact prose\n' }] }, actor), id = detail.revision.id;
    policy(id, { view: { kind: 'workspace' }, edit: { kind: 'workspace' }, interact: { kind: 'principals', principalIds: [author.id] } });
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve)); const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}${basePath}`;
    const read = await cli(['revision-projects', id, '--server', url], reader.token); assert.equal(read.code, 0, read.stderr); const snapshot = JSON.parse(read.stdout) as RevisionProjectSnapshot; assert.deepEqual(snapshot.tags.projectIds, []);
    const input = revisionProjectInput({ action: 'add', projectIds: [second.id, first.id], expectedProjectVersion: snapshot.tags.version, expectedAccessEpoch: snapshot.accessEpoch }), intent = join(directory, 'tags.json'); await writeFile(intent, JSON.stringify(input));
    const args = ['edit-revision-projects', id, '--intent', intent, '--request-id', 'exact-cli-tags', '--server', url]; assert.notEqual((await cli(args, reader.token)).code, 0);
    const saved = await cli(args, writer.token); assert.equal(saved.code, 0, saved.stderr); const receipt = JSON.parse(saved.stdout) as RevisionProjectReceipt; assert.deepEqual(receipt.tags.projectIds, [first.id, second.id].sort()); assert.equal(saved.stdout.includes(secret.id), false); assert.equal(saved.stderr.includes('Private exact prose'), false);
    store.createVersion(id, { expectedVersion: 1, message: 'Later source', files: [{ path: 'draft.txt', content: 'Next source\n' }] }, actor);
    store.revisionProjects.mutate(id, revisionProjectInput({ action: 'set', projectIds: [], expectedProjectVersion: receipt.tags.version, expectedAccessEpoch: app.policies.epoch() }), actor);
    const replay = await cli(args, writer.token); assert.equal(replay.code, 0, replay.stderr); assert.deepEqual(JSON.parse(replay.stdout), receipt);
    const history = await cli(['revision-project-history', id, '--before', '2', '--limit', '1', '--project-version', '2', '--server', url], reader.token); assert.equal(history.code, 0, history.stderr); assert.equal(JSON.parse(history.stdout).transactions[0].projectVersion, 1); assert.equal(history.stdout.includes(secret.id), false);
    const source = join(directory, 'new.txt'); await writeFile(source, 'New CLI source'); const created = await cli(['diff', '--title', 'Tagged CLI creation', '--test-plan', 'Inspect', '--project', first.id, '--project', second.id, '--server', url, 'new.txt'], writer.token, directory); assert.equal(created.code, 0, created.stderr); const createdId = /([DPL][1-9]\d*)/.exec(created.stdout)![1]!; assert.deepEqual(store.detail(createdId).revision.projectIds, [first.id, second.id].sort());
    policy(first.id, { view: { kind: 'principals', principalIds: [author.id] } }); assert.notEqual((await cli(args, writer.token)).code, 0);
  } finally { await app.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Git creation CLI supports repeated tags while preserving the original single-tag retry body', async () => {
  const fixture = await createGitFixture(), store = createStore({ path: ':memory:' }), app = createApp({ store, seed: false, gitRepositories: { R1: fixture.barePath } });
  try {
    const first = store.createProject({ name: 'First' }), second = store.createProject({ name: 'Second' }); store.createRepository({ name: 'Source', remoteUrl: 'https://example.test/repo.git', defaultBranch: 'main' });
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve)); const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/`;
    for (const selected of [[first.id], [second.id, first.id]]) {
      const key = `cli-tags-${selected.length}`, result = await cli(['import-git', 'R1', '--commit', fixture.importCommit, '--title', 'Tagged Git creation', '--test-plan', 'Inspect tree', ...selected.flatMap(id => ['--project', id]), '--request-id', key, '--json', '--server', url], ''); assert.equal(result.code, 0, result.stderr); const detail = JSON.parse(result.stdout); assert.deepEqual(detail.revision.projectIds, [...selected].sort());
      const input = { commitId: fixture.importCommit, kind: 'code', title: 'Tagged Git creation', testPlan: 'Inspect tree', ...(selected.length === 1 ? { projectId: selected[0] } : { projectIds: selected }) };
      const saved = store.database.prepare('SELECT fingerprint FROM idempotency WHERE key=?').get(key) as { fingerprint: string }; assert.equal(saved.fingerprint, createHash('sha256').update(JSON.stringify(['POST', '/api/repositories/R1/import-revision', input])).digest('hex'));
    }
  } finally { await app.close(); store.close(); await fixture.close(); }
});

test('project-tag CLI validates options and files before transport and never refreshes an uncertain intent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'project-tag-intent-')), path = join(directory, 'request.json'), oldOut = console.log, oldError = console.error; const output: unknown[] = [], recovery: string[] = [], calls: unknown[][] = [];
  try {
    console.log = value => { output.push(value); }; console.error = value => { recovery.push(String(value)); };
    const input = revisionProjectInput({ action: 'set', projectIds: ['PROJ2', 'PROJ1'], expectedProjectVersion: 4, expectedAccessEpoch: 9 }); await writeFile(path, JSON.stringify(input));
    const parameters: PaperCLI = { command: 'edit-revision-projects', args: ['P1'], options: { intent: path, 'request-id': 'uncertain-tags' }, optionNames: ['intent', 'request-id'], download: async () => new Uint8Array(), request: async <T>(...args: Parameters<PaperCLI['request']>) => { calls.push(args); throw new Error('Connection closed after save'); } };
    for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(revisionProjectsCommand(parameters), /Connection closed/);
    assert.deepEqual(calls, Array.from({ length: 2 }, () => ['/api/revisions/P1/projects', 'POST', input, 'uncertain-tags'])); assert.equal(output.length, 0); assert.equal(JSON.parse(recovery[0]!).inputSha256, createHash('sha256').update(JSON.stringify(input)).digest('hex')); assert.equal(recovery[0]!.includes('PROJ2'), false);
    const link = join(directory, 'link.json'); await symlink(path, link); await assert.rejects(revisionProjectsCommand({ ...parameters, options: { intent: link }, optionNames: ['intent'] }));
    for (const [command, options, optionNames] of [['revision-projects', { limit: '1' }, ['limit']], ['revision-project-history', { limit: '1' }, ['limit', 'limit']], ['revision-project-history', { before: '0' }, ['before']], ['revision-project-history', { 'project-version': '-1' }, ['project-version']]] as const) await assert.rejects(revisionProjectsCommand({ ...parameters, command, options, optionNames: [...optionNames] }));
    assert.equal(calls.length, 2);
    await assert.rejects(revisionProjectsCommand({ ...parameters, request: async <T>() => ({ revisionId: 'P1', saved: true }) as T }), /receipt does not match/);
  } finally { console.log = oldOut; console.error = oldError; await rm(directory, { recursive: true, force: true }); }
});

test('project-tag CLI rejects a well-shaped history with an incorrect requested cursor or project version', async () => {
  const old = console.log; console.log = () => {};
  const now = '2026-10-11T00:00:00.000Z', tags = { revisionId: 'P1', version: 3, projectIds: ['PROJ1'], updatedAt: now };
  const history: RevisionProjectHistory = { revisionId: 'P1', projectVersion: 3, transactions: [{ id: 'transaction', revisionId: 'P1', operationId: 'operation', projectVersion: 3, before: { ...tags, version: 2 }, after: tags, attribution: { principalId: 'actor', displayName: 'Actor', credentialId: null, requestId: 'request' }, createdAt: now }], nextBefore: null, accessEpoch: 1 };
  const run = (options: Record<string, string>) => revisionProjectsCommand({ command: 'revision-project-history', args: ['P1'], options, optionNames: Object.keys(options), download: async () => new Uint8Array(), request: async <T>() => history as T });
  try { await assert.rejects(run({ before: '3' }), /page and version/); await assert.rejects(run({ 'project-version': '2' }), /page and version/); }
  finally { console.log = old; }
});

test('Word creation CLI preserves ordered tags, legacy scalar and absence while rejecting ambiguous input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'word-project-cli-')), path = join(directory, 'word.json'), calls: unknown[][] = [], oldLog = console.log, oldError = console.error;
  const data = { title: 'Tagged Word source', testPlan: 'Inspect pages.', sourceFile: { fileId: 'F1', sha256: 'a'.repeat(64), bytes: 123 }, shareSource: false, expectedAccessEpoch: 3 };
  const run = () => docxCommand({ command: 'import-docx', args: [path], options: { 'request-id': 'exact-word-tags' }, optionNames: ['request-id'], request: async <T>(...args: Parameters<PaperCLI['request']>) => { calls.push(args); return { saved: true } as T; }, download: async () => new Uint8Array() });
  try {
    console.log = console.error = () => {};
    for (const tags of [{}, { projectId: 'PROJ1' }, { projectIds: ['PROJ2', 'PROJ1'] }]) { const input = { ...data, ...tags }; await writeFile(path, JSON.stringify(input)); await run(); assert.deepEqual(calls.at(-1), ['/api/revisions/docx', 'POST', input, 'exact-word-tags']); }
    for (const tags of [{ projectIds: ['PROJ1', 'PROJ1'] }, { projectIds: ['PROJ1'], projectId: 'PROJ2' }]) { await writeFile(path, JSON.stringify({ ...data, ...tags })); await assert.rejects(run()); }
    assert.equal(calls.length, 3);
  } finally { console.log = oldLog; console.error = oldError; await rm(directory, { recursive: true, force: true }); }
});
