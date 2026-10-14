import test from 'node:test';
import assert from 'node:assert/strict';
import { followConversationUpdates, type ConversationConnection } from '../client/conpherence-live.ts';
import { createWorkspaceClient } from '../client/offline.ts';
import { activateSession, lockSession } from '../client/session.ts';
import type { SessionState } from '../shared/auth.ts';
import type { ConpherenceUpdate } from '../shared/conpherence-live.ts';

const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const identity: SessionState = { mode: 'password', workspaceId: 'live-test', account: { id: 'alice', username: 'alice', displayName: 'Alice', disabled: false }, sessionContext: 'live-context', csrfToken: 'live-csrf', expiresAt: new Date(Date.now() + 60_000).toISOString() };

test('Conpherence follows one read at a time, refreshes heartbeats and ignores a retired response', async () => {
  const controller = new AbortController(), cursors: (number | null)[] = [], statuses: ConversationConnection[] = [];
  let refreshes = 0, deliver!: (update: ConpherenceUpdate) => void;
  const running = followConversationUpdates({
    request: async after => { cursors.push(after); return new Promise(resolve => { deliver = resolve; }); },
    refresh: async () => { refreshes++; }, status: value => statuses.push(value), active: () => true,
  }, controller.signal);
  assert.deepEqual(cursors, [null]);
  deliver({ accessEpoch: 3, changed: true }); await settle();
  assert.equal(refreshes, 1); assert.deepEqual(cursors, [null, 3]);
  deliver({ accessEpoch: 3, changed: false }); await settle();
  assert.equal(refreshes, 2); assert.deepEqual(cursors, [null, 3, 3]);
  deliver({ accessEpoch: 4, changed: true }); await settle();
  assert.equal(refreshes, 3); assert.deepEqual(cursors, [null, 3, 3, 4]);
  controller.abort(); deliver({ accessEpoch: 5, changed: true }); await running;
  assert.equal(refreshes, 3); assert.equal(statuses.at(-1), 'live');
});
test('Conpherence unchanged heartbeats recover a failed content read without a new mutation', async () => {
  const controller = new AbortController(), cursors: (number | null)[] = [];
  let refreshes = 0, contentVisible = false, deliver!: (update: ConpherenceUpdate) => void;
  const running = followConversationUpdates({
    request: async after => { cursors.push(after); return new Promise(resolve => { deliver = resolve; }); },
    // Automation reads retain their own errors rather than rejecting reload().
    refresh: async () => { refreshes++; if (refreshes > 1) contentVisible = true; },
    status: () => {}, active: () => true,
  }, controller.signal);
  deliver({ accessEpoch: 4, changed: true }); await settle(); assert.equal(contentVisible, false);
  deliver({ accessEpoch: 4, changed: false }); await settle();
  assert.equal(contentVisible, true); assert.equal(refreshes, 2); assert.deepEqual(cursors, [null, 4, 4]);
  controller.abort(); deliver({ accessEpoch: 4, changed: false }); await running;
});
test('Conpherence transient reconnect retries only reads with bounded backoff and stops on cancellation', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController(), statuses: ConversationConnection[] = [];
  let requests = 0, refreshes = 0;
  const running = followConversationUpdates({ request: async () => { requests++; throw new TypeError('Offline'); }, refresh: async () => { refreshes++; }, status: value => statuses.push(value), active: () => true }, controller.signal);
  await settle(); assert.equal(requests, 1); assert.equal(statuses.at(-1), 'reconnecting');
  context.mock.timers.tick(999); await settle(); assert.equal(requests, 1);
  context.mock.timers.tick(1); await settle(); assert.equal(requests, 2);
  context.mock.timers.tick(1_999); await settle(); assert.equal(requests, 2);
  controller.abort(); await running;
  context.mock.timers.tick(30_000); await settle(); assert.equal(requests, 2); assert.equal(refreshes, 0);
});
test('Conpherence WorkspaceClient polling carries session identity and aborts without retiring the session', async () => {
  const original = globalThis.fetch;
  const client = createWorkspaceClient(activateSession(identity)), controller = new AbortController();
  let headers!: Headers, method: string | undefined, credentials: RequestCredentials | undefined;
  try {
    globalThis.fetch = async (_path, options) => {
      headers = new Headers(options?.headers); method = options?.method; credentials = options?.credentials;
      return new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(options.signal!.reason), { once: true }));
    };
    const request = client.request('/api/conpherence/updates?after=4', undefined, [], { signal: controller.signal });
    assert.equal(headers.get('X-Session-Context'), 'live-context'); assert.equal(method, 'GET'); assert.equal(credentials, 'same-origin'); assert.equal(client.session!.controllers.size, 1);
    const rejected = assert.rejects(request, { name: 'AbortError' }); controller.abort(); await rejected;
    assert.equal(client.isActive(), true); assert.equal(client.session!.controllers.size, 0);
    await assert.rejects(client.request('/api/conpherence/updates', undefined, [], { signal: controller.signal }), { name: 'AbortError' });
  } finally { globalThis.fetch = original; lockSession(); }
});
test('Conpherence cancellation during response decoding cannot install a late access epoch', async () => {
  const original = globalThis.fetch, client = createWorkspaceClient(activateSession(identity)), controller = new AbortController();
  let deliver!: (value: unknown) => void;
  try {
    globalThis.fetch = async () => { const response = Response.json({}); response.json = () => new Promise(resolve => { deliver = resolve; }); return response; };
    const request = client.request('/api/conpherence/updates', undefined, [], { signal: controller.signal });
    await settle(); const rejected = assert.rejects(request, { name: 'AbortError' });
    controller.abort(); deliver({ accessEpoch: 99, changed: true }); await rejected;
    assert.equal(client.session!.accessEpoch, -1); assert.equal(client.session!.controllers.size, 0);
  } finally { globalThis.fetch = original; lockSession(); }
});
