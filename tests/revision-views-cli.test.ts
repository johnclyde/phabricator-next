import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.ts';
import { createAuth } from '../server/auth.ts';
import { createStore } from '../server/store.ts';
import { revisionViewsCommand } from '../cli/revision-views.ts';
import type { PaperCLI } from '../cli/paper-builds.ts';
import { revisionViewCreateInput, type RevisionViewResult } from '../shared/revision-views.ts';

const executable = fileURLToPath(new URL('../cli/index.ts', import.meta.url)), loader = import.meta.resolve('tsx');
const filters = { kind: 'paper', query: 'manuscript', status: 'all', projectId: null, following: false, authored: true };
function cli(args: string[], token: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', loader, executable, ...args], { env: { ...process.env, PHABRICATOR_URL: undefined, PHABRICATOR_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; }); child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; }); child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
}
for (const basePath of ['/', '/review/']) test(`saved-view CLI reads own filtered snapshots and preserves exact mutation retries at ${basePath}`, async () => {
  const store = createStore({ path: ':memory:' }), provision = createAuth({ database: store.database, mode: 'local', basePath, provisioning: true });
  const alice = await provision.createAccount({ username: 'alice', displayName: 'Alice', password: 'Strong saved view owner password' });
  const bob = await provision.createAccount({ username: 'bob', displayName: 'Bob', password: 'Strong saved view other password' });
  const app = createApp({ store, seed: false, authMode: 'password', basePath }), directory = await mkdtemp(join(tmpdir(), 'revision-views-cli-'));
  try {
    const writer = app.auth.createToken(alice.id, { name: 'Owner writer', scopes: ['read', 'write'] }), reader = app.auth.createToken(alice.id, { name: 'Owner reader', scopes: ['read'] }), other = app.auth.createToken(bob.id, { name: 'Other owner', scopes: ['read', 'write'] });
    const actor = { principalId: alice.id, displayName: alice.displayName, credentialId: null, requestId: 'saved-view-cli' };
    const paper = store.createRevision({ kind: 'paper', title: 'My manuscript', testPlan: 'Inspect prose.', files: [{ path: 'main.tex', content: 'The exact manuscript.' }] }, actor);
    store.createRevision({ kind: 'code', title: 'Manuscript build', testPlan: 'Compile.', files: [{ path: 'build.ts', content: 'export const build = true;' }] }, actor);
    store.createRevision({ kind: 'paper', title: 'Other manuscript', testPlan: 'Inspect.', files: [{ path: 'main.tex', content: 'Other.' }] }, { ...actor, principalId: bob.id, displayName: bob.displayName });
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}${basePath}`;
    const run = (args: string[], token = writer.token) => cli([...args, '--server', url], token);
    const inventory = await run(['revision-views']); assert.equal(inventory.code, 0, inventory.stderr);
    const input = revisionViewCreateInput({ name: 'My manuscripts', filters, expectedAccessEpoch: JSON.parse(inventory.stdout).accessEpoch });
    const file = join(directory, 'create.json'); await writeFile(file, JSON.stringify(input));
    const createArgs = ['create-revision-view', '--intent', file, '--request-id', 'exact-create'];
    assert.notEqual((await run(createArgs, reader.token)).code, 0);
    const created = await run(createArgs); assert.equal(created.code, 0, created.stderr); const result = JSON.parse(created.stdout) as RevisionViewResult, id = result.view.id;
    assert.equal(created.stderr.includes('My manuscripts'), false, 'recovery diagnostics do not copy private query text');
    const opened = await run(['open-revision-view', id], reader.token); assert.equal(opened.code, 0, opened.stderr);
    assert.deepEqual(JSON.parse(opened.stdout).revisions.map((row: { id: string }) => row.id), [paper.revision.id]);
    assert.notEqual((await run(['revision-views', id], other.token)).code, 0);
    assert.deepEqual(JSON.parse((await run(['revision-views'], other.token)).stdout).views, []);
    const edit = join(directory, 'edit.json'); await writeFile(edit, JSON.stringify({ ...input, name: 'Changed on another device', expectedVersion: result.view.version }));
    const updated = await run(['edit-revision-view', id, '--intent', edit, '--request-id', 'exact-edit']); assert.equal(updated.code, 0, updated.stderr);
    const retried = await run(createArgs); assert.equal(retried.code, 0, retried.stderr); assert.deepEqual(JSON.parse(retried.stdout), result);
    const current = await run(['revision-views', id]); assert.equal(JSON.parse(current.stdout).view.name, 'Changed on another device');
    const stale = await run(['edit-revision-view', id, '--intent', edit, '--request-id', 'different-stale-edit']); assert.notEqual(stale.code, 0);
    const deletion = join(directory, 'delete.json'); await writeFile(deletion, JSON.stringify({ expectedVersion: 2, expectedAccessEpoch: input.expectedAccessEpoch }));
    const deleteArgs = ['delete-revision-view', id, '--intent', deletion, '--request-id', 'exact-delete'];
    const deleted = await run(deleteArgs); assert.equal(deleted.code, 0, deleted.stderr); assert.equal(JSON.parse(deleted.stdout).deleted, true);
    assert.equal((await run(deleteArgs)).stdout, deleted.stdout);
    assert.notEqual((await run(['open-revision-view', id])).code, 0);
    assert.deepEqual(JSON.parse((await run(['revision-views'])).stdout).views, []);
  } finally { await app.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('saved-view CLI rejects malformed requests and receipts without refreshing a lost-response intent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'revision-views-intent-')), file = join(directory, 'request.json');
  const oldOut = console.log, oldError = console.error, calls: unknown[][] = [], output: string[] = [];
  try {
    console.log = value => output.push(String(value)); console.error = () => {};
    const input = revisionViewCreateInput({ name: 'Private query', filters, expectedAccessEpoch: 7 }); await writeFile(file, JSON.stringify(input));
    const parameters: PaperCLI = { command: 'create-revision-view', args: [], options: { intent: file, 'request-id': 'uncertain-view' }, optionNames: ['intent', 'request-id'], download: async () => new Uint8Array(), request: async <T>(...args: Parameters<PaperCLI['request']>) => { calls.push(args); throw new Error('Connection lost after save'); } };
    await assert.rejects(revisionViewsCommand(parameters), /Connection lost/); await assert.rejects(revisionViewsCommand(parameters), /Connection lost/);
    assert.deepEqual(calls, Array.from({ length: 2 }, () => ['/api/revision-views', 'POST', input, 'uncertain-view']));
    const link = join(directory, 'linked.json'); await symlink(file, link);
    await assert.rejects(revisionViewsCommand({ ...parameters, options: { intent: link }, optionNames: ['intent'] }));
    for (const [command, args, options, optionNames] of [['revision-views', [], { limit: '1' }, ['limit']], ['edit-revision-view', ['RV0'], { intent: file }, ['intent']], ['revision-views', ['RV1', 'RV2'], {}, []], ['create-revision-view', [], { intent: file }, ['intent', 'intent']]] as const) await assert.rejects(revisionViewsCommand({ ...parameters, command, args: [...args], options, optionNames: [...optionNames] }));
    assert.equal(calls.length, 2); assert.deepEqual(output, []);
    const now = '2026-10-12T00:00:00.000Z';
    for (const view of [{ id: 'RV1', version: 2, name: input.name, filters: input.filters, createdAt: now, updatedAt: now }, { id: 'RV1', version: 1, name: 'Wrong query', filters: input.filters, createdAt: now, updatedAt: now }]) await assert.rejects(revisionViewsCommand({ ...parameters, request: async <T>() => ({ view, deleted: false, accessEpoch: 7 }) as T }), /receipt does not match/);
  } finally { console.log = oldOut; console.error = oldError; await rm(directory, { recursive: true, force: true }); }
});

test('opening a saved view rejects an identity mismatch or changed access without printing source summaries', async () => {
  const oldOut = console.log; let printed = false; console.log = () => { printed = true; };
  try {
    const now = '2026-10-12T00:00:00.000Z';
    const view = { id: 'RV1', version: 1, name: 'Exact view', filters, createdAt: now, updatedAt: now };
    const base: PaperCLI = { command: 'open-revision-view', args: ['RV1'], options: {}, optionNames: [], download: async () => new Uint8Array(), request: async <T>(path: string) => (path === '/api/state' ? { accessEpoch: 8, revisions: [], projects: [], followingRevisionIds: [], currentPrincipalId: 'owner' } : { view, accessEpoch: 7 }) as T };
    await assert.rejects(revisionViewsCommand(base), /access changed/);
    await assert.rejects(revisionViewsCommand({ ...base, request: async <T>() => ({ view: { ...view, id: 'RV2' }, accessEpoch: 7 }) as T }), /requested identity/);
    assert.equal(printed, false);
  } finally { console.log = oldOut; }
});
