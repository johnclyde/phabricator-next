import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { discussionSummary, parseCommand } from '../client/voice.ts';
import type { ReviewComment, RevisionVersion, ReviewThread } from '../shared/types.ts';
import { canQueue, RequestError, isNetworkError } from '../client/offline.ts';
import { applicationBase, applicationPath, storageKey } from '../client/mount.ts';
import { activateSession, lockSession } from '../client/session.ts';

const localSession = () => activateSession({ mode: 'local', workspaceId: 'test-workspace', account: null, sessionContext: null, csrfToken: null, expiresAt: null });

test('voice commands navigate familiar application names and research drafts', () => {
  assert.deepEqual(parseCommand('Open Phriction.'), { type: 'navigate', view: 'wiki' });
  assert.deepEqual(parseCommand('go to the papers'), { type: 'navigate', view: 'papers' });
  assert.deepEqual(parseCommand('open drafts'), { type: 'navigate', view: 'drafts' });
});
test('voice task creation is a draft command and preserves content case', () => {
  assert.deepEqual(parseCommand('Create a task called Check LaTeX References.'), { type: 'task', title: 'Check LaTeX References' });
  assert.deepEqual(parseCommand('Search for Smith 2021'), { type: 'search', query: 'Smith 2021' });
  assert.deepEqual(parseCommand('show in progress'), { type: 'filter', value: 'in_progress' });
  assert.deepEqual(parseCommand('read summary'), { type: 'summary' });
  assert.deepEqual(parseCommand('show my tasks'), { type: 'taskFilter', value: 'mine' });
  assert.deepEqual(parseCommand('show duplicate'), { type: 'filter', value: 'duplicate' });
  assert.equal(parseCommand('merge this task as duplicate').type, 'unknown');
  assert.deepEqual(parseCommand('show unassigned tasks'), { type: 'taskFilter', value: 'unassigned' });
  assert.deepEqual(parseCommand('show tasks I follow'), { type: 'taskFilter', value: 'following' });
  assert.deepEqual(parseCommand('assign this task to me').type, 'unknown');
  assert.deepEqual(parseCommand('read changes'), { type: 'changes' });
  assert.deepEqual(parseCommand('Read the discussion.'), { type: 'discussion' });
  assert.deepEqual(parseCommand('read open threads'), { type: 'discussion' });
});
test('voice commands never interpret acceptance or provider calls as authorized operations', () => {
  assert.equal(parseCommand('accept all reviews').type, 'unknown');
  assert.equal(parseCommand('send everything to AI').type, 'unknown');
  assert.equal(parseCommand('resolve all threads').type, 'unknown');
});
test('spoken discussion preserves original-version provenance, groups replies and limits long source excerpts', () => {
  const version: RevisionVersion = { id: 'v1', revisionId: 'P1', number: 1, files: [{ path: 'paper.tex', content: 'Original claim' }], message: 'Original', contentHash: 'hash', createdAt: '2026-10-10' };
  const root: ReviewComment = { id: 'one', threadId: 'one', revisionId: 'P1', versionId: 'v1', filePath: 'paper.tex', line: 1, body: 'Check the citation.', author: 'Reader', createdAt: '2026-10-10', anchor: { versionId: 'v1', contentHash: 'hash', filePath: 'paper.tex', start: 0, end: 14, quote: 'Original claim', prefix: '', suffix: '' } };
  const thread: ReviewThread = { id: 'one', rootCommentId: 'one', revisionId: 'P1', status: 'open', version: 2, createdAt: '2026-10-10', updatedAt: '2026-10-10' };
  const summary = discussionSummary({ versions: [version, { ...version, id: 'v2', number: 2 }], comments: [root, { ...root, id: 'reply', viewedVersionId: 'v2', body: 'Replying on the new version.' }, { ...root, id: 'resolved', threadId: 'resolved', body: 'Resolved content should not be read aloud.' }], threads: [thread, { ...thread, id: 'resolved', rootCommentId: 'resolved', status: 'resolved' }] });
  assert.match(summary, /1 open and 1 resolved/); assert.match(summary, /Thread from version 1, 2 comments/);
  assert.match(summary, /Original passage: Original claim/); assert.match(summary, /Check the citation/);
  assert.doesNotMatch(summary, /Resolved content should not/);
  const long = Array.from({ length: 20 }, (_, index) => ({ ...root, id: String(index), threadId: undefined, body: 'Long comment '.repeat(1500), anchor: { ...root.anchor!, quote: 'Long source '.repeat(1500) } }));
  const bounded = discussionSummary({ versions: [version], comments: long, threads: [] });
  assert.match(bounded, /20 open/); assert.match(bounded, /first three/); assert.ok(bounded.length < 1600);
  assert.match(discussionSummary({ versions: [], comments: [], threads: [] }), /No discussion/);
});
test('offline queue permits only supported idempotent mutation routes', () => {
  assert.equal(canQueue('/api/tasks', 'POST'), true);
  assert.equal(canQueue('/api/tasks/T1', 'PATCH'), true);
  assert.equal(canQueue('/api/tasks/T1/comments', 'POST'), true);
  assert.equal(canQueue('/api/tasks/T1/dependencies', 'POST'), false);
  assert.equal(canQueue('/api/tasks/T1/merge', 'POST'), false);
  assert.equal(canQueue('/api/tasks/T1/merge-in', 'POST'), false);
  assert.equal(canQueue('/api/tasks/T1/subscriptions', 'POST', { principalId: 'alice', action: 'subscribe', expectedMembershipVersion: 0 }), false);
  assert.equal(canQueue('/api/tasks/T1', 'PATCH', { ownerId: null, expectedVersion: 1 }), false);
  assert.equal(canQueue('/api/tasks', 'POST', { ownerId: 'alice' }), false);
  assert.equal(canQueue('/api/tasks', 'POST', { ownerId: null }), true);
  assert.equal(canQueue('/api/revisions/P1/comments', 'POST'), true);
  assert.equal(canQueue('/api/revisions/L3/versions', 'POST'), true);
  assert.equal(canQueue('/api/documents/W1', 'PUT'), true);
  for (const route of ['/api/revisions/D1', '/api/revisions/D1/reviews', '/api/revisions', '/api/projects', '/api/repositories']) {
    assert.equal(canQueue(route, 'POST'), false);
    assert.equal(canQueue(route, 'PATCH'), false);
  }
  assert.equal(canQueue('/api/tasks/T1/extra', 'PATCH'), false);
  assert.equal(canQueue('/api/revisions/L1/suggestions/comment-id/apply', 'POST'), false, 'source-changing suggestions require a live current-version check');
});
test('server errors and conflicts do not become offline retries', () => {
  assert.equal(isNetworkError(new RequestError('Version changed', 409)), false);
  assert.equal(isNetworkError(new RequestError('Validation failed', 400)), false);
  assert.equal(isNetworkError(new TypeError('Failed to fetch')), true);
});

test('outbox removal reads the latest stored queue rather than a stale tab snapshot', async () => {
  const { changeOutbox, writeStored, readStored } = await import('../client/offline.ts');
  const memory = new Map<string, string>();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value) } });
  try {
    localSession();
    const first = { id: 'one', path: '/api/tasks', method: 'POST' as const, body: { title: 'First' }, label: 'First task', createdAt: '2026-10-09' };
    const second = { ...first, id: 'two', body: { title: 'Second' }, label: 'Second task' };
    writeStored('outbox', [first]);
    const staleTab = readStored<typeof first[]>('outbox', []);
    await changeOutbox(current => [...current, second]);
    const result = await changeOutbox(current => current.filter(item => item.id !== staleTab[0].id));
    assert.deepEqual(result.map(item => item.id), ['two']);
    assert.deepEqual(readStored<typeof first[]>('outbox', []).map(item => item.id), ['two']);
  } finally { lockSession(); if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor); else Reflect.deleteProperty(globalThis, 'localStorage'); }
});

test('mounted browser requests and drafts stay with their installation while root drafts remain readable', async () => {
  const { changeOutbox, writeStored, readStored, removeStored, request } = await import('../client/offline.ts');
  const memory = new Map([['phabricator-next:draft:task', JSON.stringify({ title: 'Existing root draft' })]]);
  const requests: string[] = [], locks: string[] = [];
  let base = '/';
  const replacements = {
    document: { querySelector: () => ({ content: base }) },
    localStorage: { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) },
    navigator: { locks: { request: async (name: string, commit: () => unknown) => { locks.push(name); return commit(); } } },
    fetch: async (path: string) => { requests.push(path); return Response.json({ ok: true }); },
  };
  const originals = Object.fromEntries(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { configurable: true, value });
  try {
    localSession();
    assert.deepEqual(readStored('draft:task', null), { title: 'Existing root draft' });
    assert.equal(applicationPath('/api/state'), '/api/state');
    base = '/workspace';
    assert.equal(applicationBase(), '/workspace/');
    assert.equal(applicationPath('/icon.svg'), '/workspace/icon.svg');
    assert.equal(readStored('draft:task', null), null);
    assert.equal(writeStored('draft:task', { title: 'Mounted draft' }), true);
    await request('/api/state');
    const queued = await changeOutbox(() => [{ id: 'mounted', path: '/api/tasks', method: 'POST', body: { title: 'Offline' }, label: 'Task', createdAt: '2026-10-10' }]);
    assert.equal(queued[0].path, '/api/tasks');
    assert.deepEqual(locks, [storageKey('outbox-write', '/workspace/')]);
    assert.deepEqual(requests, ['/workspace/api/state']);
    base = '/workspace-other/';
    assert.equal(readStored('draft:task', null), null);
    assert.deepEqual(readStored('outbox', []), []);
    base = '/workspace/';
    assert.deepEqual(readStored('draft:task', null), { title: 'Mounted draft' });
    removeStored('draft:task');
    assert.equal(readStored('draft:task', null), null);
    base = '/';
    assert.deepEqual(readStored('draft:task', null), { title: 'Existing root draft' });
    assert.deepEqual(readStored('outbox', []), []);
  } finally {
    lockSession();
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('service worker caches only its own shell assets and retires only its own cache versions', async () => {
  const scope = 'https://example.test/workspace/';
  const prefix = `phabricator-next-shell:${encodeURIComponent(scope)}:`;
  const sibling = `phabricator-next-shell:${encodeURIComponent('https://example.test/other/')}:v1`;
  const handlers: Record<string, (event: { waitUntil?: (promise: Promise<unknown>) => void; request?: { url: string; method: string; mode: string }; respondWith?: (promise: Promise<unknown>) => void }) => void> = {};
  const added: string[] = [], stored: string[] = [], deleted: string[] = [];
  const html = '<meta name="application-base" content="/workspace/"><script src="/workspace/assets/app-123.js"></script><link href="/workspace/assets/app-123.css"><script src="/api/source.js"></script><script src="/other/assets/app.js"></script>';
  const cache = {
    addAll: async (requests: Request[]) => { added.push(...requests.map(request => request.url)); },
    put: async (path: string) => { stored.push(path); },
    match: async () => new Response('cached'),
  };
  runInNewContext(readFileSync(new URL('../client/public/sw.js', import.meta.url), 'utf8'), {
    URL, Request, Set,
    self: { registration: { scope }, addEventListener: (name: string, handler: typeof handlers[string]) => { handlers[name] = handler; }, skipWaiting: async () => {}, clients: { claim: async () => {} } },
    caches: { open: async () => cache, keys: async () => [`${prefix}v1`, `${prefix}v2`, sibling, 'phabricator-next-shell-v1', 'another-app'], delete: async (key: string) => { deleted.push(key); } },
    fetch: async () => new Response(html, { headers: { 'Content-Type': 'text/html' } }),
  });
  const pending: Promise<unknown>[] = [];
  handlers.install({ waitUntil: promise => { pending.push(promise); } });
  await Promise.all(pending);
  assert.deepEqual(stored, [scope]);
  assert.deepEqual(added, [`${scope}icon.svg`, `${scope}manifest.webmanifest`, `${scope}assets/app-123.js`, `${scope}assets/app-123.css`]);
  handlers.activate({ waitUntil: promise => { pending.push(promise); } });
  await Promise.all(pending);
  assert.deepEqual(deleted, [`${prefix}v1`]);
  for (const path of ['/api/state', '/workspace/api/state', '/workspace/auth/login', '/workspace/assets/private.json', '/other/', '/', '/workspace/?auth=code']) {
    let intercepted = false;
    handlers.fetch({ request: { url: `https://example.test${path}`, method: 'GET', mode: 'navigate' }, respondWith: () => { intercepted = true; } });
    assert.equal(intercepted, false, path);
  }
});

test('observing password mode invalidates a prior offline-local grant even when storage is full', async () => {
  const { rememberMode, rememberedLocalSession } = await import('../client/session.ts');
  const memory = new Map([[storageKey('verified-mode'), JSON.stringify({ mode: 'local', workspaceId: 'existing' })]]);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => memory.get(key) ?? null,
    removeItem: (key: string) => memory.delete(key),
    setItem: () => { throw new DOMException('Storage full', 'QuotaExceededError'); },
  } });
  try {
    assert.equal(rememberedLocalSession()?.workspaceId, 'existing');
    rememberMode({ mode: 'password', workspaceId: 'existing', account: null, sessionContext: null, csrfToken: 'challenge', expiresAt: null });
    assert.equal(rememberedLocalSession(), null);
  } finally { if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor); else Reflect.deleteProperty(globalThis, 'localStorage'); }
});


test('voice opens numbered tasks without performing implicit mutations', () => {
  for (const input of ['open T12', 'open T 12', 'open task 12', 'open task12', 'show the task 12']) assert.deepEqual(parseCommand(input), { type: 'openObject', id: 'T12' });
  for (const input of ['resolve task 12', 'close T12', 'add dependency T12', 'open task 0']) assert.equal(parseCommand(input).type, 'unknown');
});
