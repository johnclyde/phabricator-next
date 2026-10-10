import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceClient } from '../client/offline.ts';
import { activateSession, currentSession, lockSession, SessionChangedError } from '../client/session.ts';
import type { SessionState } from '../shared/auth.ts';

const identity = (name: string): SessionState => ({ mode: 'password', workspaceId: 'test-workspace', account: { id: name, username: name, displayName: name, disabled: false }, sessionContext: `context-${name}`, csrfToken: `csrf-${name}`, expiresAt: new Date(Date.now() + 60_000).toISOString() });

test('protected content and drafts stay in the verified tab and cannot cross a session boundary', async () => {
  const durable = new Map([['phabricator-next:state', JSON.stringify({ secret: 'legacy-local-content' })]]);
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => durable.get(key) ?? null, setItem: (key: string, value: string) => durable.set(key, value) } });
  try {
    lockSession();
    assert.equal(createWorkspaceClient().readStored('state', null), null);
    const alice = createWorkspaceClient(activateSession(identity('alice')));
    assert.equal(alice.readStored('state', null), null);
    assert.equal(alice.writeStored('draft:task', { title: 'Alice unsaved draft' }), true);
    assert.equal(alice.draftRecords().length, 1);
    await assert.rejects(alice.changeOutbox(() => []), /Offline submission is unavailable/);
    const bob = createWorkspaceClient(activateSession(identity('bob')));
    assert.equal(bob.readStored('draft:task', null), null);
    assert.equal(alice.writeStored('draft:task', { title: 'Late Alice callback' }), false);
    alice.removeStored('draft:task');
    assert.deepEqual(bob.draftRecords(), []);
    assert.equal(durable.size, 1);
    assert.match(durable.values().next().value!, /legacy-local-content/);
  } finally { lockSession(); if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else Reflect.deleteProperty(globalThis, 'localStorage'); }
});

test('late responses and failures cannot install old data or lock a newer account', async () => {
  const previous = globalThis.fetch;
  try {
    for (const status of [200, 401]) {
      let release!: (response: Response) => void;
      let headers: Headers | undefined;
      globalThis.fetch = async (_url, options) => { headers = new Headers(options?.headers); return await new Promise<Response>(resolve => { release = resolve; }); };
      const alice = createWorkspaceClient(activateSession(identity('alice')));
      const response = alice.request('/api/state');
      assert.equal(headers?.get('X-Session-Context'), 'context-alice');
      const bob = activateSession(identity('bob'));
      release(Response.json(status === 200 ? { secret: 'Alice response' } : { error: 'Expired Alice' }, { status }));
      await assert.rejects(response, SessionChangedError);
      assert.equal(currentSession(), bob);
      assert.equal(bob.memory.size, 0);
    }
    let headers: Headers | undefined;
    globalThis.fetch = async (_url, options) => { headers = new Headers(options?.headers); return Response.json({ ok: true }); };
    await createWorkspaceClient().request('/api/tasks', { method: 'POST', body: { title: 'Authorized Bob' } });
    assert.equal(headers?.get('X-Session-Context'), 'context-bob');
    assert.equal(headers?.get('X-CSRF-Token'), 'csrf-bob');
    globalThis.fetch = async () => Response.json({ error: 'Expired' }, { status: 401 });
    await assert.rejects(createWorkspaceClient().request('/api/state'), SessionChangedError);
    assert.equal(currentSession(), null);
  } finally { lockSession(); globalThis.fetch = previous; }
});
