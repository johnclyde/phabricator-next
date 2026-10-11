import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createStore } from '../server/store.ts';
import { createAuth } from '../server/auth.ts';
import { createApp } from '../server/app.ts';
import type { RevisionDetail } from '../shared/types.ts';
import { revisionDependenciesCommand } from '../cli/revision-dependencies.ts';
import type { PaperCLI } from '../cli/paper-builds.ts';

const executable = fileURLToPath(new URL('../cli/index.ts', import.meta.url)), loader = import.meta.resolve('tsx');
function cli(args: string[], token: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', loader, executable, ...args], { env: { ...process.env, PHABRICATOR_URL: undefined, PHABRICATOR_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; }); child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; }); child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

for (const basePath of ['/', '/review/']) test(`dependency CLI preserves explicit graph intent, paging and exact replay at ${basePath}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phab-dependencies-cli-')), store = createStore({ path: ':memory:' });
  const provision = createAuth({ database: store.database, mode: 'local', basePath, provisioning: true });
  const account = await provision.createAccount({ username: 'writer', displayName: 'Dependency Writer', password: 'A strong dependency fixture password' });
  const app = createApp({ store, seed: false, authMode: 'password', basePath });
  try {
    const writer = app.auth.createToken(account.id, { name: 'Writer', scopes: ['read', 'write'] }), reader = app.auth.createToken(account.id, { name: 'Reader', scopes: ['read'] });
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}${basePath}`;
    const create = async (kind: 'code' | 'paper' | 'document') => {
      const response = await fetch(new URL('api/revisions', url), { method: 'POST', headers: { Authorization: `Bearer ${writer.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ testPlan: 'Fixture verification plan.', title: `Exact ${kind} \u001b[31m title \u202e`, kind, files: [{ path: 'draft.txt', content: 'Retain the original source.\n' }] }) });
      const result = await response.json() as RevisionDetail; assert.equal(response.status, 201, JSON.stringify(result)); return result;
    };
    const [code, paper, document] = await Promise.all([create('code'), create('paper'), create('document')]);
    const id = paper.revision.id, input = { direction: 'parents', add: [document.revision.id, code.revision.id], remove: [], expectedRelationshipVersion: 0, expectedAccessEpoch: app.policies.epoch() }, path = join(directory, 'change.json');
    await writeFile(path, JSON.stringify(input));
    const args = ['edit-revision-dependencies', id, '--intent', path, '--request-id', 'dependency-intent', '--server', url];
    const first = await cli(args, writer.token); assert.equal(first.code, 0, first.stderr); const receipt = JSON.parse(first.stdout); assert.equal(receipt.relationshipVersion, 1); assert.equal(receipt.changes.length, 2);
    const replay = await cli(args, writer.token); assert.equal(replay.code, 0, replay.stderr); assert.deepEqual(JSON.parse(replay.stdout), receipt);
    assert.notEqual((await cli(args, reader.token)).code, 0);
    const pageArgs = ['revision-dependencies', id, '--direction', 'parents', '--limit', '1', '--relationship-version', '1', '--server', url];
    const firstPage = await cli(pageArgs, reader.token); assert.equal(firstPage.code, 0, firstPage.stderr); assert.ok(!firstPage.stdout.includes('\u001b') && !firstPage.stdout.includes('\u202e')); const one = JSON.parse(firstPage.stdout); assert.equal(one.revisions.length, 1); assert.ok(one.nextAfter);
    const secondPage = await cli([...pageArgs, '--after', one.nextAfter], reader.token); assert.equal(secondPage.code, 0, secondPage.stderr); const two = JSON.parse(secondPage.stdout); assert.equal(two.revisions.length, 1); assert.equal(two.nextAfter, null); assert.notEqual(one.revisions[0].id, two.revisions[0].id);
    const inverse = await cli(['revision-dependencies', code.revision.id, '--direction', 'children', '--server', url], reader.token); assert.equal(inverse.code, 0, inverse.stderr); assert.equal(JSON.parse(inverse.stdout).revisions[0].id, id);
    const history = await cli(['revision-dependency-history', id, '--limit', '1', '--server', url], reader.token); assert.equal(history.code, 0, history.stderr); const events = JSON.parse(history.stdout); assert.equal(events.transactions.length, 1); assert.ok(events.nextBefore); assert.equal(events.transactions[0].operationId, receipt.operationId);
    const rest = await cli(['revision-dependency-history', id, '--before', String(events.nextBefore), '--server', url], reader.token); assert.equal(rest.code, 0, rest.stderr); assert.equal(JSON.parse(rest.stdout).transactions.length, 1);
    const remove = { ...input, add: [], remove: [code.revision.id], expectedRelationshipVersion: 1 }; await writeFile(path, JSON.stringify(remove));
    assert.notEqual((await cli(args, writer.token)).code, 0, 'same identity cannot be reused for another body');
    const removed = await cli(args.map(value => value === 'dependency-intent' ? 'remove-intent' : value), writer.token); assert.equal(removed.code, 0, removed.stderr);
    await writeFile(path, JSON.stringify(input)); const oldReplay = await cli(args, writer.token); assert.equal(oldReplay.code, 0, oldReplay.stderr); assert.deepEqual(JSON.parse(oldReplay.stdout), receipt, 'later graph changes cannot replace the historical receipt');
    assert.notEqual((await cli(pageArgs, reader.token)).code, 0, 'a pinned old page must conflict');
    for (const original of [code, paper, document]) { const current = store.detail(original.revision.id); assert.deepEqual(current.versions, original.versions); assert.deepEqual(current.reviews, original.reviews); assert.equal(current.revision.status, original.revision.status); }
  } finally { await app.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('dependency CLI rejects ambiguous options and unsafe retained requests before sending', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phab-dependency-invalid-')), intent = join(directory, 'intent.json'); let calls = 0;
  const request: PaperCLI['request'] = async <T>() => { calls++; return {} as T; };
  const run = (options = { intent }, optionNames = ['intent']) => revisionDependenciesCommand({ command: 'edit-revision-dependencies', args: ['P1'], options, optionNames, request, download: async () => new Uint8Array() });
  try {
    const base = { direction: 'parents', add: ['P2'], remove: [], expectedRelationshipVersion: 0, expectedAccessEpoch: 0 };
    for (const bad of [{ ...base, add: ['P1'] }, { ...base, remove: ['P2'] }, { ...base, extra: true }, [], 'x'.repeat(256 * 1024)]) { await writeFile(intent, JSON.stringify(bad)); await assert.rejects(run()); }
    await writeFile(intent, JSON.stringify(base)); await assert.rejects(run({ intent }, ['intent', 'intent']));
    const linked = join(directory, 'linked.json'); await symlink(intent, linked); await assert.rejects(run({ intent: linked }));
    await writeFile(intent, Buffer.from([0xff, 0xfe])); await assert.rejects(run());
    assert.equal(calls, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
