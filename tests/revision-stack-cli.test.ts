import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createStore } from '../server/store.ts';
import { createAuth } from '../server/auth.ts';
import { createApp } from '../server/app.ts';
import { revisionDependenciesCommand } from '../cli/revision-dependencies.ts';
import type { PaperCLI } from '../cli/paper-builds.ts';
import type { RevisionLifecycleSnapshot } from '../shared/revision-lifecycle.ts';
import type { RevisionDetail } from '../shared/types.ts';
import { canonicalRevisionStack, type RevisionStack } from '../shared/revision-stack.ts';

const executable = fileURLToPath(new URL('../cli/index.ts', import.meta.url)), loader = import.meta.resolve('tsx');
function cli(args: string[], token: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', loader, executable, ...args], { env: { ...process.env, PHABRICATOR_URL: undefined, PHABRICATOR_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; }); child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; }); child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
}
for (const basePath of ['/', '/review/']) test(`stack CLI verifies complete snapshots with read-only credentials at ${basePath}`, async () => {
  const store = createStore({ path: ':memory:' }), provision = createAuth({ database: store.database, mode: 'local', basePath, provisioning: true });
  const author = await provision.createAccount({ username: 'writer', displayName: 'Original writer', password: 'Strong stack fixture password' });
  const app = createApp({ store, seed: false, authMode: 'password', basePath });
  try {
    const writer = app.auth.createToken(author.id, { name: 'Writer', scopes: ['read', 'write'] }), reader = app.auth.createToken(author.id, { name: 'Reader', scopes: ['read'] });
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}${basePath}`;
    const call = async <T>(path: string, body?: unknown, method = 'POST'): Promise<T> => {
      const response = await fetch(new URL(`api${path}`, url), { method: body === undefined ? 'GET' : method, headers: { Authorization: `Bearer ${writer.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const data = await response.json(); assert.ok(response.ok, JSON.stringify(data)); return data as T;
    };
    const create = (kind: 'paper' | 'document' | 'code') => call<RevisionDetail>('/revisions', { testPlan: 'Fixture verification plan.', kind, title: `${kind} \u001b[31m \u202e stack`, files: [{ path: 'draft.txt', content: 'Exact source\n' }] });
    const [paper, parent, sibling] = await Promise.all([create('paper'), create('document'), create('code')]);
    for (const id of [paper.revision.id, sibling.revision.id]) await call(`/revisions/${id}/dependencies`, { direction: 'parents', add: [parent.revision.id], remove: [], expectedRelationshipVersion: 0, expectedAccessEpoch: app.policies.epoch() });
    const args = ['revision-stack', paper.revision.id, '--server', url], first = await cli(args, reader.token);
    assert.equal(first.code, 0, first.stderr); assert.equal(first.stdout.includes('\u001b'), false); assert.equal(first.stdout.includes('\u202e'), false);
    const stack = JSON.parse(first.stdout) as RevisionStack; assert.equal(stack.nodes.length, 3); assert.equal(stack.edges.length, 2); assert.deepEqual(stack.openParentIds, [parent.revision.id]);
    assert.equal(createHash('sha256').update(canonicalRevisionStack(stack)).digest('hex'), stack.snapshotId);
    assert.ok(stack.nodes.every(node => node.author?.principalId === author.id));
    const pinned = await cli([...args, '--snapshot', stack.snapshotId], reader.token); assert.equal(pinned.code, 0, pinned.stderr); assert.deepEqual(JSON.parse(pinned.stdout), stack);
    const lifecycle = await call<RevisionLifecycleSnapshot>(`/revisions/${parent.revision.id}/lifecycle`);
    await call(`/revisions/${parent.revision.id}/lifecycle`, { action: 'abandon', message: '', expectedLifecycleVersion: lifecycle.lifecycle.version, expectedReviewerVersion: lifecycle.reviewers.version, expectedAuthorVersion: lifecycle.authorship.version, expectedVersion: lifecycle.head.number, expectedVersionId: lifecycle.head.versionId, expectedContentHash: lifecycle.head.contentHash, expectedAccessEpoch: lifecycle.accessEpoch, expectedConfigId: lifecycle.configId, expectedEvidenceSha256: lifecycle.evidence.sha256 });
    const stale = await cli([...args, '--snapshot', stack.snapshotId], reader.token); assert.notEqual(stale.code, 0); assert.equal(stale.stdout, '');
    const fresh = await cli(args, reader.token); assert.equal(fresh.code, 0, fresh.stderr); const next = JSON.parse(fresh.stdout) as RevisionStack; assert.deepEqual(next.openParentIds, []); assert.notEqual(next.snapshotId, stack.snapshotId); assert.equal(next.nodes.length, 3);
    assert.deepEqual(store.detail(paper.revision.id).versions, paper.versions); assert.deepEqual(store.detail(parent.revision.id).versions, parent.versions);
    app.auth.revokeToken(author.id, reader.record.id); assert.notEqual((await cli(args, reader.token)).code, 0);
  } finally { await app.close(); store.close(); }
});

test('stack CLI rejects incomplete graphs, wrong hashes and ambiguous options without printing data', async () => {
  let calls = 0; const request: PaperCLI['request'] = async <T>() => { calls++; return {} as T; };
  const run = (options: Record<string, string> = {}, optionNames: string[] = []) => revisionDependenciesCommand({ command: 'revision-stack', args: ['P1'], options, optionNames, request, download: async () => new Uint8Array() });
  for (const [options, names] of [[{ snapshot: 'x' }, ['snapshot']], [{ direction: 'parents' }, ['direction']], [{ snapshot: 'a'.repeat(64) }, ['snapshot', 'snapshot']]] as const) await assert.rejects(run(options, [...names]));
  assert.equal(calls, 0); await assert.rejects(run(), /could not be verified/); assert.equal(calls, 1);
  const value: RevisionStack = { format: 'phabricator.revision-stack.v3', revisionId: 'P1', accessEpoch: 0, closeOnAccept: false, snapshotId: 'b'.repeat(64), nodes: [{ id: 'P1', title: 'Private source label', kind: 'paper', status: 'needs_review', currentVersion: 1, updatedAt: '2026-10-11T00:00:00Z', relationshipVersion: 0, head: { versionId: 'head', number: 1, contentHash: 'a'.repeat(64) }, author: null, originalAuthor: null, authorVersion: 0, lifecycleVersion: 0 }], edges: [], openParentIds: [] };
  await assert.rejects(revisionDependenciesCommand({ command: 'revision-stack', args: ['P1'], options: {}, optionNames: [], request: async <T>() => value as T, download: async () => new Uint8Array() }), /could not be verified/);
});
