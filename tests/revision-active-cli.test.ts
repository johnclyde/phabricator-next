import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.ts';
import { createAuth } from '../server/auth.ts';
import { createStore } from '../server/store.ts';
import { revisionActiveCommand } from '../cli/revision-active.ts';
import type { PaperCLI } from '../cli/paper-builds.ts';

const executable = fileURLToPath(new URL('../cli/index.ts', import.meta.url)), loader = import.meta.resolve('tsx');
function cli(args: string[], token: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', loader, executable, ...args], { env: { ...process.env, PHABRICATOR_URL: undefined, PHABRICATOR_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; }); child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; }); child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
}
for (const basePath of ['/', '/review/']) test(`Active CLI reads direct responsibility with a read-only token at ${basePath}`, async () => {
  const store = createStore({ path: ':memory:' }), provision = createAuth({ database: store.database, mode: 'local', basePath, provisioning: true });
  const alice = await provision.createAccount({ username: 'alice', displayName: 'Alice', password: 'Strong Active owner password' });
  const bob = await provision.createAccount({ username: 'bob', displayName: 'Bob', password: 'Strong Active other password' });
  const app = createApp({ store, seed: false, authMode: 'password', basePath });
  try {
    const reader = app.auth.createToken(alice.id, { name: 'Read Active', scopes: ['read'] });
    const actor = { principalId: alice.id, displayName: alice.displayName, credentialId: null, requestId: 'active-cli' };
    const input = { kind: 'paper' as const, title: 'Exact manuscript', testPlan: 'Inspect prose.', files: [{ path: 'main.tex', content: 'Exact source.' }] };
    const paper = store.createRevision(input, actor);
    store.createRevision({ ...input, title: 'Other manuscript' }, { ...actor, principalId: bob.id, displayName: bob.displayName });
    store.createRevision({ ...input, kind: 'code', title: 'Manuscript build' }, actor);
    const before = store.detail(paper.revision.id);
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}${basePath}`;
    const run = (args: string[]) => cli(['active-revisions', ...args, '--server', url], reader.token);
    const result = await run(['--kind', 'paper', '--query', 'EXACT']); assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout) as { groups: { key: string; revisions: { id: string }[] }[] };
    assert.equal(output.groups.length, 8);
    assert.deepEqual(output.groups.flatMap(group => group.revisions.map(row => [group.key, row.id])), [['waiting-on-review', paper.revision.id]]);
    const literal = await run(['--kind', 'paper', '--query', '.*']); assert.equal(literal.code, 0, literal.stderr);
    assert.deepEqual(JSON.parse(literal.stdout).groups.flatMap((group: { revisions: unknown[] }) => group.revisions), []);
    for (const args of [['--kind', 'unknown'], ['P1'], ['--kind', 'paper', '--kind', 'code'], ['--intent', 'request.json']]) assert.notEqual((await run(args)).code, 0);
    assert.deepEqual(store.detail(paper.revision.id), before);
  } finally { await app.close(); store.close(); }
});

test('Active CLI refuses missing, partial or mismatched authority without printing revision content', async () => {
  const previous = console.log, output: unknown[] = []; console.log = value => output.push(value);
  const calls: unknown[][] = [];
  try {
    const snapshot = { format: 'revision-active.v1', principalId: 'owner', accessEpoch: 7, closeOnAccept: false, items: [] };
    const state = { currentPrincipalId: 'owner', accessEpoch: 7, revisions: [], revisionActive: snapshot };
    const parameters: PaperCLI = { command: 'active-revisions', args: [], options: {}, optionNames: [], download: async () => new Uint8Array(), request: async <T>(...args: Parameters<PaperCLI['request']>) => { calls.push(args); return state as T; } };
    for (const broken of [null, {}, { ...state, revisionActive: undefined }, { ...state, accessEpoch: 8 }, { ...state, currentPrincipalId: 'someone-else' }, { ...state, revisions: [{ id: 'P1', title: 'Private content' }] }, { ...state, revisions: [null] }]) {
      await assert.rejects(revisionActiveCommand({ ...parameters, request: async <T>(...args: Parameters<PaperCLI['request']>) => { calls.push(args); return broken as T; } }));
    }
    assert.deepEqual(output, []); assert.ok(calls.every(call => call.length === 1 && call[0] === '/api/state'));
    await assert.rejects(revisionActiveCommand({ ...parameters, options: { query: 'x'.repeat(513) }, optionNames: ['query'] }));
    assert.equal(await revisionActiveCommand({ ...parameters, command: 'unrelated' }), false);
  } finally { console.log = previous; }
});
