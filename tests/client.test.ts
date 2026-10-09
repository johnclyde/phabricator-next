import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../client/voice.ts';
import { canQueue, RequestError, isNetworkError } from '../client/offline.ts';

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
    const first = { id: 'one', path: '/api/tasks', method: 'POST' as const, body: { title: 'First' }, label: 'First task', createdAt: '2026-10-09' };
    const second = { ...first, id: 'two', body: { title: 'Second' }, label: 'Second task' };
    writeStored('outbox', [first]);
    const staleTab = readStored<typeof first[]>('outbox', []);
    await changeOutbox(current => [...current, second]);
    const result = await changeOutbox(current => current.filter(item => item.id !== staleTab[0].id));
    assert.deepEqual(result.map(item => item.id), ['two']);
    assert.deepEqual(readStored<typeof first[]>('outbox', []).map(item => item.id), ['two']);
  } finally { if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor); else Reflect.deleteProperty(globalThis, 'localStorage'); }
});
