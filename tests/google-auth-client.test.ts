import test from 'node:test';
import assert from 'node:assert/strict';
import { authProvidersRequest, sessionRequest, RequestError } from '../client/session';
const google = { projectId: 'workspace-signin', apiKey: 'public-fixture-api-key-1234567890', authDomain: 'workspace-signin.firebaseapp.com', appId: '1:123456789:web:abcdef123456' };

test('provider discovery is mounted, no-store, abortable and accepts only the pinned public configuration shape', async () => {
  const fetch = globalThis.fetch, document = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelector: () => ({ content: '/workspace/' }) } });
  try {
    const controller = new AbortController(); let result: unknown = { google };
    globalThis.fetch = async (url, options) => { assert.equal(url, '/workspace/api/auth/providers'); assert.equal(options?.cache, 'no-store'); assert.equal(options?.credentials, 'same-origin'); assert.equal(options?.signal, controller.signal); return Response.json(result); };
    assert.deepEqual(await authProvidersRequest(controller.signal), { google });
    result = { google: null }; assert.deepEqual(await authProvidersRequest(controller.signal), { google: null });
    for (const invalid of [{ google, accounts: {} }, { google: null, extra: true }, { google: { ...google, accounts: {} } }, { google: { ...google, authDomain: 'other-project.firebaseapp.com' } }, { google: { ...google, authDomain: 'workspace-signin.firebaseapp.com/path' } }, { google: { ...google, appId: 'invalid' } }]) { result = invalid; await assert.rejects(authProvidersRequest(controller.signal), /invalid/); }
  } finally { globalThis.fetch = fetch; if (document) Object.defineProperty(globalThis, 'document', document); else Reflect.deleteProperty(globalThis, 'document'); }
});

test('Google exchange uses the existing challenge boundary without persistence or automatic retry', async () => {
  const fetch = globalThis.fetch; let calls = 0;
  try {
    globalThis.fetch = async (url, options) => { calls++; assert.equal(url, '/api/login/google'); assert.equal(options?.method, 'POST'); assert.equal(options?.cache, 'no-store'); assert.equal(options?.credentials, 'same-origin'); assert.deepEqual(JSON.parse(String(options?.body)), { idToken: 'one-explicit-test-token' }); assert.equal(new Headers(options?.headers).get('X-CSRF-Token'), 'current-challenge'); return Response.json({ error: 'Identity is not linked.' }, { status: 403 }); };
    await assert.rejects(sessionRequest('/api/login/google', { body: { idToken: 'one-explicit-test-token' }, csrfToken: 'current-challenge' }), error => error instanceof RequestError && error.status === 403 && error.message === 'Identity is not linked.');
    assert.equal(calls, 1);
  } finally { globalThis.fetch = fetch; }
});
