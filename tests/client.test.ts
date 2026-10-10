import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parseCommand } from '../client/voice.ts';
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
  assert.deepEqual(parseCommand('read changes'), { type: 'changes' });
});
test('voice commands never interpret acceptance or provider calls as authorized operations', () => {
  assert.equal(parseCommand('accept all reviews').type, 'unknown');
  assert.equal(parseCommand('send everything to AI').type, 'unknown');
});
test('offline queue permits only supported idempotent mutation routes', () => {
  assert.equal(canQueue('/api/tasks', 'POST'), true);
  assert.equal(canQueue('/api/tasks/T1', 'PATCH'), true);
  assert.equal(canQueue('/api/revisions/P1/comments', 'POST'), true);
  assert.equal(canQueue('/api/revisions/L3/versions', 'POST'), true);
  assert.equal(canQueue('/api/documents/W1', 'PUT'), true);
  for (const route of ['/api/revisions/D1', '/api/revisions/D1/reviews', '/api/revisions', '/api/projects', '/api/repositories']) {
    assert.equal(canQueue(route, 'POST'), false);
    assert.equal(canQueue(route, 'PATCH'), false);
  }
  assert.equal(canQueue('/api/tasks/T1/extra', 'PATCH'), false);
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
