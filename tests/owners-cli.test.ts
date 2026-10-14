import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { ownersCommand } from '../cli/owners.ts';
import type { PaperCLI } from '../cli/paper-builds.ts';
import { createApp } from '../server/app.ts';
import { createAuth } from '../server/auth.ts';
import { Store } from '../server/store.ts';
import { ownersDefinition, type OwnersDefinition, type OwnersReceipt } from '../shared/owners.ts';

const definition: OwnersDefinition = { name: 'CLI compiler owners', description: 'Private package text', status: 'active', visibility: 'private', owners: [], dominion: 'strong', autoReview: 'none', auditing: 'none', paths: [{ repositoryId: 'R1', path: '/', excluded: false }] };
const run = (args: string[], token: string) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'cli/index.ts', ...args], { env: { ...process.env, PHABRICATOR_URL: undefined, PHABRICATOR_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += String(data); }); child.stderr.on('data', data => { stderr += String(data); }); child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
});

for (const basePath of ['/', '/review/']) test('Owners CLI reads scoped source and submits exact repeatable mutations at ' + basePath, async () => {
  const store = new Store({ path: ':memory:' }), provision = createAuth({ database: store.database, mode: 'local', provisioning: true, basePath });
  const account = await provision.createAccount({ username: 'alice', displayName: 'Alice', password: 'Owners CLI fixture password' });
  const app = createApp({ store, seed: false, authMode: 'password', basePath }), directory = await mkdtemp(join(tmpdir(), 'owners-cli-'));
  try {
    store.createRepository({ name: 'Compiler', remoteUrl: 'https://example.invalid/compiler.git' });
    const writer = app.auth.createToken(account.id, { name: 'Writer', scopes: ['read', 'write'] }), reader = app.auth.createToken(account.id, { name: 'Reader', scopes: ['read'] });
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const server = 'http://127.0.0.1:' + (app.server.address() as AddressInfo).port + basePath;
    const cli = (args: string[], token = writer.token) => run([...args, '--server', server], token);
    const inventory = await cli(['owners']); assert.equal(inventory.code, 0, inventory.stderr);
    const input = { ...definition, expectedAccessEpoch: JSON.parse(inventory.stdout).accessEpoch }, file = join(directory, 'create.json');
    await writeFile(file, JSON.stringify(input));
    const create = ['create-owners', '--intent', file, '--request-id', 'owners-cli-create'];
    assert.notEqual((await cli(create, reader.token)).code, 0);
    const created = await cli(create); assert.equal(created.code, 0, created.stderr); const receipt = JSON.parse(created.stdout) as OwnersReceipt, pkg = receipt.package!;
    assert.equal(created.stderr.includes(definition.description), false, 'recovery diagnostics omit private package content');
    assert.equal((await cli(['owners', pkg.id], reader.token)).code, 0);
    const matching = await cli(['resolve-owners', 'R1', 'src/file.ts']); assert.equal(matching.code, 0, matching.stderr); assert.equal(JSON.parse(matching.stdout).matches[0].package.id, pkg.id);
    const editFile = join(directory, 'edit.json'); await writeFile(editFile, JSON.stringify({ ...ownersDefinition(pkg), name: 'Current edited package', expectedVersion: pkg.version, expectedAccessEpoch: receipt.accessEpoch }));
    const updated = await cli(['edit-owners', pkg.id, '--intent', editFile, '--request-id', 'owners-cli-edit']); assert.equal(updated.code, 0, updated.stderr);
    const replayed = await cli(create); assert.equal(replayed.code, 0, replayed.stderr); const replay = JSON.parse(replayed.stdout) as OwnersReceipt; assert.equal(replay.receipt.version, 1); assert.equal(replay.package!.version, 2);
    const history = await cli(['owners-history', pkg.id]); assert.equal(history.code, 0, history.stderr); assert.deepEqual(JSON.parse(history.stdout).history.map((entry: { package: { version: number } }) => entry.package.version), [2, 1]);
    const stale = await cli(['edit-owners', pkg.id, '--intent', editFile, '--request-id', 'different-stale-edit']); assert.notEqual(stale.code, 0);
    const source = store.createRevision({ kind: 'code', repositoryId: 'R1', title: 'Routing history fixture', testPlan: 'Inspect paths.', files: [{ path: 'src/file.ts', content: 'const one = 1;' }] }, { principalId: account.id, displayName: 'Alice', credentialId: null, requestId: 'cli-test-source' });
    const routing = await cli(['owners-routing', source.revision.id, '--limit', '10']); assert.equal(routing.code, 0, routing.stderr); assert.deepEqual(JSON.parse(routing.stdout).records, []);
  } finally { await app.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Owners CLI preserves lost-result intents and rejects ambiguous flags, unsafe files and contradictory receipts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'owners-cli-intent-')), file = join(directory, 'request.json');
  const previousOut = console.log, previousError = console.error, printed: string[] = [], calls: unknown[][] = [];
  try {
    console.log = value => { printed.push(String(value)); }; console.error = () => {};
    const input = { ...definition, expectedAccessEpoch: 7 }; await writeFile(file, JSON.stringify(input));
    const options: PaperCLI = { command: 'create-owners', args: [], options: { intent: file, 'request-id': 'uncertain-owners' }, optionNames: ['intent', 'request-id'], download: async () => new Uint8Array(), request: async <T>(...args: Parameters<PaperCLI['request']>) => { calls.push(args); throw new Error('Lost result'); } };
    await assert.rejects(ownersCommand(options), /Lost result/); await assert.rejects(ownersCommand(options), /Lost result/);
    assert.deepEqual(calls, Array.from({ length: 2 }, () => ['/api/owners', 'POST', input, 'uncertain-owners']));
    const linked = join(directory, 'link.json'); await symlink(file, linked);
    await assert.rejects(ownersCommand({ ...options, options: { intent: linked }, optionNames: ['intent'] }));
    for (const patch of [{ command: 'owners', args: ['invalid'], options: {}, optionNames: [] }, { command: 'owners', args: [], options: { limit: '1' }, optionNames: ['limit'] }, { command: 'create-owners', args: [], options: { intent: file }, optionNames: ['intent', 'intent'] }, { command: 'resolve-owners', args: ['R1', '../private'], options: {}, optionNames: [] }, { command: 'owners-routing', args: ['D1'], options: { limit: '101' }, optionNames: ['limit'] }]) await assert.rejects(ownersCommand({ ...options, ...patch }));
    assert.equal(calls.length, 2);
    const id = 'OWN-' + randomUUID(), now = '2026-10-14T00:00:00Z', pkg = { ...definition, id, creatorId: 'alice', version: 1, createdAt: now, updatedAt: now };
    for (const result of [{ package: { ...pkg, name: 'Incorrect persisted definition' }, receipt: { id, version: 1, action: 'create', replayed: false }, accessEpoch: 7 }, { package: pkg, receipt: { id, version: 2, action: 'create', replayed: false }, accessEpoch: 7 }]) await assert.rejects(ownersCommand({ ...options, request: async <T>() => result as T }), /receipt does not match/);
    assert.deepEqual(printed, []);
  } finally { console.log = previousOut; console.error = previousError; await rm(directory, { recursive: true, force: true }); }
});

test('Owners CLI refuses mismatched read identities and invalid routing evidence before printing private content', async () => {
  const original = console.log; let printed = false; console.log = () => { printed = true; };
  try {
    const id = 'OWN-' + randomUUID(), other = 'OWN-' + randomUUID(), now = '2026-10-14T00:00:00Z';
    const base: PaperCLI = { command: 'owners', args: [id], options: {}, optionNames: [], download: async () => new Uint8Array(), request: async <T>() => ({ package: { ...definition, id: other, creatorId: 'alice', version: 1, createdAt: now, updatedAt: now }, canEdit: true, accessEpoch: 1 }) as T };
    await assert.rejects(ownersCommand(base), /requested identity/);
    await assert.rejects(ownersCommand({ ...base, command: 'owners-routing', args: ['D1'], request: async <T>() => ({ records: [{ source: { objectId: 'D2' } }], nextBefore: null, accessEpoch: 1 }) as T }), /requested identity/);
    assert.equal(printed, false);
  } finally { console.log = original; }
});
