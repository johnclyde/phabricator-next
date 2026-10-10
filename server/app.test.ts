import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { request as requestHttp } from 'node:http';
import type { AppState, RevisionDetail, Revision, ReviewRun, ReviewComment, WikiDocument, Task, ReviewAnalysis } from '../shared/types.ts';
import { createApp, type AppOptions } from './app.ts';
import { createStore } from './store.ts';
import { seedDemo } from './seed.ts';

async function start(options: AppOptions = {}) {
  const app = createApp({ databasePath: ':memory:', seed: false, ...options });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const request = async <T = { error: string }>(path: string, method = 'GET', data?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${base}${path}`, { method, headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, body: await response.json() as T, headers: response.headers };
  };
  return { ...app, base, request };
}
const revisionInput = { title: 'A precise revision', kind: 'code', files: [{ path: 'main.ts', content: 'export const answer = 42;\n' }] };
const goodAnalysis: ReviewAnalysis = { provider: 'openai', model: 'test-model', summary: 'No supported errors in this snapshot.', findings: [] };

test('immutable revisions retain anchored comments and invalidate acceptance on the next version', async () => {
  const app = await start();
  try {
    const created = await app.request<RevisionDetail>('/api/revisions', 'POST', revisionInput);
    assert.equal(created.status, 201);
    const id = created.body.revision.id; const first = created.body.versions[0]!;
    assert.equal((await app.request(`/api/revisions/${id}`, 'PATCH', { status: 'accepted', expectedVersion: 1 })).status, 409);
    const review = await app.request<ReviewRun>(`/api/revisions/${id}/reviews`, 'POST', { provider: 'local', expectedVersion: 1 });
    assert.equal(review.status, 201); assert.equal(review.body.provider, 'local'); assert.equal(review.body.contentHash, first.contentHash);
    assert.equal((await app.request<Revision>(`/api/revisions/${id}`, 'PATCH', { status: 'accepted', expectedVersion: 1 })).body.status, 'accepted');
    const comment = await app.request<ReviewComment>(`/api/revisions/${id}/comments`, 'POST', { body: 'Keep this line precise.', versionId: first.id, filePath: 'main.ts', line: 1 });
    assert.equal(comment.status, 201);
    const changed = await app.request<RevisionDetail>(`/api/revisions/${id}/versions`, 'POST', { expectedVersion: 1, message: 'Refine the answer', files: [{ path: 'main.ts', content: 'export const answer = 43;\n' }] });
    assert.equal(changed.status, 201); assert.equal(changed.body.revision.status, 'needs_review'); assert.equal(changed.body.revision.currentVersion, 2);
    assert.deepEqual(changed.body.versions[0], first); assert.equal(changed.body.comments[0]!.versionId, first.id);
    assert.notEqual(changed.body.versions[1]!.contentHash, first.contentHash);
    assert.equal((await app.request(`/api/revisions/${id}`, 'PATCH', { status: 'accepted', expectedVersion: 2 })).status, 409);
    assert.equal((await app.request(`/api/revisions/${id}`, 'PATCH', { status: 'closed', expectedVersion: 1 })).status, 409);
    const exported = await app.request<{ revision: Revision; version: RevisionDetail['versions'][number] }>(`/api/revisions/${id}/export?version=1`);
    assert.deepEqual(exported.body.version, first);
    assert.equal((await app.request(`/api/revisions/${id}/export?version=1junk`)).status, 400);
  } finally { await app.close(); }
});

test('concurrent version writes only accept one matching base version', async () => {
  const app = await start();
  try {
    const { body: created } = await app.request<RevisionDetail>('/api/revisions', 'POST', revisionInput);
    const input = { expectedVersion: 1, message: 'A new version', files: [{ path: 'main.ts', content: 'export const answer = 44;' }] };
    const replies = await Promise.all([app.request(`/api/revisions/${created.revision.id}/versions`, 'POST', input), app.request(`/api/revisions/${created.revision.id}/versions`, 'POST', input)]);
    assert.deepEqual(replies.map(reply => reply.status).sort(), [201, 409]);
    const detail = await app.request<RevisionDetail>(`/api/revisions/${created.revision.id}`);
    assert.equal(detail.body.versions.length, 2);
  } finally { await app.close(); }
});

test('review results are discarded if the revision changes while the provider is working', async () => {
  let complete!: (value: ReviewAnalysis) => void; let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const app = await start({ aiConfiguration: () => ({ configured: true, model: 'test-model' }), analyzeAI: async () => { began(); return new Promise(resolve => { complete = resolve; }); } });
  try {
    const { body: created } = await app.request<RevisionDetail>('/api/revisions', 'POST', revisionInput);
    const path = `/api/revisions/${created.revision.id}`;
    const pending = app.request(`${path}/reviews`, 'POST', { provider: 'openai', expectedVersion: 1 });
    await started;
    assert.equal((await app.request(`${path}/versions`, 'POST', { expectedVersion: 1, message: 'Changed during review', files: [{ path: 'main.ts', content: 'export const answer = 45;' }] })).status, 201);
    complete(goodAnalysis);
    assert.equal((await pending).status, 409);
    assert.equal((await app.request<RevisionDetail>(path)).body.reviews.length, 0);
  } finally { await app.close(); }
});

test('persistent idempotency replays one committed response after restart and rejects key reuse', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phab-idempotency-')); const databasePath = join(directory, 'workspace.sqlite');
  let app = await start({ databasePath });
  try {
    const first = await app.request<Task>('/api/tasks', 'POST', { title: 'Write once' }, { 'Idempotency-Key': 'offline-task-1' });
    const again = await app.request<Task>('/api/tasks', 'POST', { title: 'Write once' }, { 'Idempotency-Key': 'offline-task-1' });
    assert.deepEqual(again.body, first.body);
    await app.close(); app = await start({ databasePath });
    assert.deepEqual((await app.request<Task>('/api/tasks', 'POST', { title: 'Write once' }, { 'Idempotency-Key': 'offline-task-1' })).body, first.body);
    assert.equal((await app.request('/api/tasks', 'POST', { title: 'Different body' }, { 'Idempotency-Key': 'offline-task-1' })).status, 409);
    const state = (await app.request<AppState>('/api/state')).body;
    assert.equal(state.tasks.length, 1);
    assert.deepEqual(state.activity.map(event => event.action).sort(), ['created', 'subscription_changed']);
    assert.equal((await app.request('/api/tasks', 'POST', { title: '' }, { 'Idempotency-Key': 'retry-validation' })).status, 400);
    assert.equal((await app.request('/api/tasks', 'POST', { title: 'Corrected input' }, { 'Idempotency-Key': 'retry-validation' })).status, 201);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('concurrent identical review requests share work and one event', async () => {
  let count = 0;
  const app = await start({ aiConfiguration: () => ({ configured: true, model: 'test-model' }), analyzeAI: async () => { count += 1; await new Promise(resolve => setTimeout(resolve, 30)); return goodAnalysis; } });
  try {
    const created = (await app.request<RevisionDetail>('/api/revisions', 'POST', revisionInput)).body;
    const path = `/api/revisions/${created.revision.id}/reviews`; const data = { provider: 'openai', expectedVersion: 1 }; const headers = { 'Idempotency-Key': 'review-once' };
    const [first, second] = await Promise.all([app.request<ReviewRun>(path, 'POST', data, headers), app.request<ReviewRun>(path, 'POST', data, headers)]);
    assert.equal(first.status, 201); assert.deepEqual(first.body, second.body); assert.equal(count, 1);
    const detail = (await app.request<RevisionDetail>(`/api/revisions/${created.revision.id}`)).body;
    assert.equal(detail.reviews.length, 1); assert.equal(detail.activity.filter(event => event.action === 'reviewed').length, 1);
  } finally { await app.close(); }
});

test('validation rejects unsafe files, anchors, unknown properties, and stale wiki edits atomically', async () => {
  const app = await start();
  try {
    for (const input of [{ ...revisionInput, files: [{ path: '../outside', content: 'x' }] }, { ...revisionInput, files: [{ path: 'x', content: '1' }, { path: 'x', content: '2' }] }, { ...revisionInput, repositoryId: 'R404' }, { ...revisionInput, surprise: 'field' }]) {
      assert.equal((await app.request('/api/revisions', 'POST', input)).status, 400);
    }
    let state = (await app.request<AppState>('/api/state')).body; assert.equal(state.revisions.length, 0); assert.equal(state.activity.length, 0);
    const created = (await app.request<RevisionDetail>('/api/revisions', 'POST', revisionInput)).body;
    assert.equal(created.revision.id, 'D1');
    for (const anchor of [{ versionId: 'wrong' }, { versionId: created.versions[0]!.id, filePath: 'missing.ts', line: 1 }, { versionId: created.versions[0]!.id, filePath: 'main.ts', line: 900 }, { versionId: created.versions[0]!.id, line: 1 }]) assert.equal((await app.request(`/api/revisions/${created.revision.id}/comments`, 'POST', { body: 'A comment', ...anchor })).status, 400);
    const document = (await app.request<WikiDocument>('/api/documents', 'POST', { title: 'Notes', slug: 'research/notes', content: '# Notes' })).body;
    const update = { title: 'Notes', slug: 'research/notes', content: '# Revised', expectedVersion: 1 };
    assert.equal((await app.request(`/api/documents/${document.id}`, 'PUT', update)).status, 200);
    assert.equal((await app.request(`/api/documents/${document.id}`, 'PUT', update)).status, 409);
    assert.equal((await app.request('/api/documents', 'POST', { title: 'Collision', slug: 'research/notes', content: '' })).status, 409);
    state = (await app.request<AppState>('/api/state')).body; assert.equal(state.documents.length, 1); assert.equal(state.documents[0]!.version, 2);
  } finally { await app.close(); }
});

test('loopback host/origin checks and body limits reject hostile requests', async () => {
  const app = await start();
  try {
    // Node fetch intentionally rewrites Host; exercise the actual HTTP header with the native client.
    const hostileHostStatus = await new Promise<number | undefined>((resolveStatus, reject) => {
      const req = requestHttp(`${app.base}/api/state`, { headers: { Host: 'attacker.example' } }, res => { res.resume(); res.on('end', () => resolveStatus(res.statusCode)); });
      req.on('error', reject); req.end();
    });
    assert.equal(hostileHostStatus, 403);
    assert.equal((await app.request('/api/tasks', 'POST', { title: 'Injected' }, { Origin: 'https://attacker.example' })).status, 403);
    assert.equal((await app.request('/api/state', 'GET', undefined, { Origin: 'null' })).status, 403);
    assert.equal((await app.request('/api/state', 'GET', undefined, { Origin: 'http://127.0.0.1:5173' })).status, 200);
    assert.equal((await app.request('/api/tasks', 'POST', { title: 'Injected' }, { 'Content-Type': 'text/plain' })).status, 400);
    assert.equal((await app.request('/api/tasks', 'POST', { title: 'Large', description: 'x'.repeat(2_000_000) })).status, 413);
    const badJson = await fetch(`${app.base}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' }); assert.equal(badJson.status, 400);
    assert.equal((await app.request<AppState>('/api/state')).body.tasks.length, 0);
  } finally { await app.close(); }
});

test('static serving contains files and symlinks within the distribution directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phab-static-')); const dist = join(directory, 'dist');
  await mkdir(dist); await writeFile(join(dist, 'index.html'), '<h1>Workspace</h1>'); await writeFile(join(directory, 'secret.txt'), 'secret'); await symlink(join(directory, 'secret.txt'), join(dist, 'escape.txt'));
  const app = await start({ distPath: dist });
  try {
    const page = await fetch(`${app.base}/differential/D1`); assert.equal(page.status, 200); assert.match(await page.text(), /Workspace/);
    assert.match(page.headers.get('Content-Security-Policy')!, /frame-ancestors 'none'/);
    assert.equal((await fetch(`${app.base}/escape.txt`)).status, 404);
    assert.equal((await fetch(`${app.base}/%2e%2e%2fsecret.txt`)).status, 404);
    assert.equal((await fetch(`${app.base}/.git/config`)).status, 404);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('mounted API and frontend stay inside their configured path and canonicalize the mount', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phab-mounted-'));
  const html = '<meta name="application-base" content="/workspace/"><h1>Mounted workspace</h1>';
  await writeFile(join(directory, 'index.html'), html);
  await mkdir(join(directory, 'assets'));
  await writeFile(join(directory, 'assets', 'app.js'), 'console.log("mounted");');
  const app = await start({ basePath: '/workspace', distPath: directory });
  const rawStatus = (path: string) => new Promise<number | undefined>((resolveStatus, reject) => {
    const req = requestHttp(app.base, { path }, res => { res.resume(); res.on('end', () => resolveStatus(res.statusCode)); });
    req.on('error', reject); req.end();
  });
  try {
    assert.equal((await app.request('/workspace/api/health')).status, 200);
    const created = await app.request<RevisionDetail>('/workspace/api/revisions', 'POST', revisionInput);
    assert.equal(created.status, 201);
    assert.equal((await app.request(`/workspace/api/revisions/${created.body.revision.id}/export?version=1`)).status, 200);
    assert.equal((await app.request('/workspace/api/state', 'GET', undefined, { Origin: 'https://attacker.example' })).status, 403);
    for (const path of ['/', '/api/state', '/workspaces/api/state', '/workspace-other', '/workspace/api']) {
      assert.equal((await fetch(`${app.base}${path}`)).status, 404, path);
    }
    assert.equal((await fetch(`${app.base}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"title":"Outside mount"}' })).status, 404);
    assert.equal((await fetch(`${app.base}/`, { method: 'OPTIONS' })).status, 404);
    assert.equal((await fetch(`${app.base}/workspace/api/state`, { method: 'OPTIONS' })).status, 204);
    const page = await fetch(`${app.base}/workspace/differential/D1`);
    assert.equal(page.status, 200); assert.equal(await page.text(), html);
    const asset = await fetch(`${app.base}/workspace/assets/app.js`);
    assert.equal(asset.status, 200); assert.match(asset.headers.get('Cache-Control')!, /immutable/);
    assert.equal((await fetch(`${app.base}/workspace/missing.js`)).status, 404);
    for (const method of ['GET', 'HEAD']) {
      const redirect = await fetch(`${app.base}/workspace?next=%2F%2Fevil.example`, { method, redirect: 'manual' });
      assert.equal(redirect.status, 308);
      assert.equal(redirect.headers.get('Location'), '/workspace/?next=%2F%2Fevil.example');
      assert.equal(await redirect.text(), '');
    }
    assert.equal((await fetch(`${app.base}/workspace`, { method: 'POST', redirect: 'manual' })).status, 404);
    for (const path of ['/workspace/../api/health', '/workspace/%2e%2e/api/health', '/workspace/%2e%2e%2fsecret.txt', '/workspace/%5c..%5csecret.txt', '/workspace/.git/config']) {
      assert.equal(await rawStatus(path), 404, path);
    }
    assert.equal(await rawStatus('/workspace/%zz'), 400);
    assert.equal((await app.request<AppState>('/workspace/api/state')).body.tasks.length, 0);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('server reports incompatible frontend mounts instead of serving a broken application', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phab-mount-build-'));
  const app = await start({ basePath: '/workspace/', distPath: directory });
  try {
    for (const html of ['<h1>Unmarked build</h1>', '<meta name="application-base" content="/"><h1>Root build</h1>']) {
      await writeFile(join(directory, 'index.html'), html);
      const response = await app.request('/workspace/');
      assert.equal(response.status, 503); assert.match(response.body.error, /Rebuild and start with the same APP_BASE_PATH/);
      assert.equal((await fetch(`${app.base}/workspace/`, { method: 'HEAD' })).status, 503);
      assert.equal((await app.request('/workspace/api/health')).status, 200);
    }
    await writeFile(join(directory, 'index.html'), '<meta name="application-base" content="/workspace/"><h1>Matching build</h1>');
    assert.equal((await fetch(`${app.base}/workspace/`)).status, 200);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
  assert.throws(() => createApp({ databasePath: ':memory:', basePath: '/workspace/../' }), /APP_BASE_PATH/);
});

test('document revisions and explicitly configured offline AI use the same version discipline', async () => {
  let providerUsed: string | undefined;
  const app = await start({ aiConfiguration: () => ({ configured: false, model: null, localConfigured: true, localModel: 'sample-model' }), analyzeAI: async (_kind, _files, provider) => { providerUsed = provider; return { ...goodAnalysis, provider: 'ollama', model: 'sample-model' }; } });
  try {
    const created = (await app.request<RevisionDetail>('/api/revisions', 'POST', { title: 'Fictional motion', kind: 'document', files: [{ path: 'motion.md', content: '# Requested relief\nFourteen additional days.' }] })).body;
    assert.equal(created.revision.id, 'L1');
    assert.equal((await app.request(`/api/revisions/${created.revision.id}/reviews`, 'POST', { provider: 'openai', expectedVersion: 1 })).status, 400);
    const review = await app.request<ReviewRun>(`/api/revisions/${created.revision.id}/reviews`, 'POST', { provider: 'ollama', expectedVersion: 1 });
    assert.equal(review.status, 201); assert.equal(providerUsed, 'ollama'); assert.equal(review.body.provider, 'ollama');
    assert.equal((await app.request(`/api/revisions/${created.revision.id}`, 'PATCH', { status: 'accepted', expectedVersion: 1 })).status, 200);
  } finally { await app.close(); }
});

test('new blocking review evidence invalidates acceptance and provider failures never become evidence', async () => {
  let fail = false;
  let blocking = false;
  const app = await start({ aiConfiguration: () => ({ configured: true, model: 'test-model' }), analyzeAI: async () => {
    if (fail) throw new Error('Simulated provider failure');
    return blocking ? { ...goodAnalysis, findings: [{ id: 'test-error', source: 'ai', severity: 'error', filePath: 'main.ts', line: 1, title: 'A blocking defect', body: 'A grounded example defect for this integration test.' }] } : goodAnalysis;
  } });
  try {
    const created = (await app.request<RevisionDetail>('/api/revisions', 'POST', revisionInput)).body;
    const path = `/api/revisions/${created.revision.id}`;
    assert.equal((await app.request(`${path}/reviews`, 'POST', { provider: 'local', expectedVersion: 1 })).status, 201);
    assert.equal((await app.request(path, 'PATCH', { status: 'accepted', expectedVersion: 1 })).status, 200);
    blocking = true;
    assert.equal((await app.request(`${path}/reviews`, 'POST', { provider: 'openai', expectedVersion: 1 })).status, 201);
    let detail = (await app.request<RevisionDetail>(path)).body;
    assert.equal(detail.revision.status, 'changes_requested'); assert.equal(detail.reviews.length, 2);
    assert.ok(detail.activity.some(event => event.action === 'acceptance_invalidated'));
    assert.equal((await app.request(path, 'PATCH', { status: 'accepted', expectedVersion: 1 })).status, 409);
    fail = true;
    assert.equal((await app.request(`${path}/reviews`, 'POST', { provider: 'openai', expectedVersion: 1 })).status, 502);
    detail = (await app.request<RevisionDetail>(path)).body;
    assert.equal(detail.reviews.length, 2);
  } finally { await app.close(); }
});

test('seed disable option leaves a fresh workspace empty across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phab-no-seed-')); const databasePath = join(directory, 'workspace.sqlite');
  let app = await start({ databasePath, seed: false });
  try {
    assert.equal((await app.request<AppState>('/api/state')).body.revisions.length, 0);
    await app.close(); app = await start({ databasePath, seed: true });
    const state = (await app.request<AppState>('/api/state')).body;
    assert.equal(state.revisions.length, 0); assert.equal(state.activity.length, 0);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('fresh database seed contains labelled examples and does not return after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phab-seed-')); const path = join(directory, 'workspace.sqlite');
  let store = createStore({ path });
  try {
    seedDemo(store); const before = store.state({ configured: false, model: null });
    assert.equal(before.revisions.length, 3); assert.ok(before.revisions.some(revision => revision.kind === 'document' && /Sample/.test(revision.title)));
    store.close(); store = createStore({ path }); assert.equal(store.fresh, false); seedDemo(store);
    const after = store.state({ configured: false, model: null }); assert.deepEqual(after, before);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
