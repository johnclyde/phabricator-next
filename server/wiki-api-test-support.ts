import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';
import { createAuth } from './auth.ts';
import { Store } from './store.ts';
import type { SessionState } from '../shared/auth.ts';
import type { WikiDetail, WikiDocument } from '../shared/types.ts';
import type { WikiLifecycleReceipt, WikiMovePreview, WikiMoveReceipt } from '../shared/wiki.ts';

export const workspace = { kind: 'workspace' as const };
export const members = (...principalIds: string[]) => ({ kind: 'principals' as const, principalIds });
const password = 'Wiki discovery test-only account password';
export type ConduitEnvelope<T> = { result: T | null; error_code: string | null; error_info: string | null };

export async function startWikiApi(basePath = '/') {
  const store = new Store({ path: ':memory:' });
  const provision = createAuth({ database: store.database, mode: 'local', basePath, provisioning: true });
  const alice = await provision.createAccount({ username: 'alice', displayName: 'Alice', password });
  const bob = await provision.createAccount({ username: 'bob', displayName: 'Bob', password });
  const app = createApp({ store, seed: false, authMode: 'password', basePath });
  const tokens = {
    alice: app.auth.createToken(alice.id, { name: 'Alice', scopes: ['read', 'write'] }),
    bob: app.auth.createToken(bob.id, { name: 'Bob', scopes: ['read', 'write'] }),
    reader: app.auth.createToken(alice.id, { name: 'Read only', scopes: ['read'] }),
    writer: app.auth.createToken(alice.id, { name: 'Write only', scopes: ['write'] }),
  };
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const url = (path: string) => `${origin}${basePath}${path.replace(/^\//, '')}`;
  async function raw<T>(path: string, init: RequestInit = {}) {
    const response = await fetch(url(path), { signal: AbortSignal.timeout(15_000), ...init });
    return { status: response.status, body: await response.json() as T, headers: response.headers };
  }
  async function request<T>(path: string, method = 'GET', input?: unknown, actor: keyof typeof tokens | null = 'alice', key?: string) {
    return raw<T>(path, { method, headers: { ...(actor ? { Authorization: `Bearer ${tokens[actor].token}` } : {}), ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  }
  async function conduit<T>(method: string, input: Record<string, unknown> = {}, actor: keyof typeof tokens | null = 'reader') {
    return raw<ConduitEnvelope<T>>(`/api/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ params: JSON.stringify({ ...input, ...(actor ? { __conduit__: { token: tokens[actor].token } } : {}) }) }) });
  }
  let sequence = 0;
  async function document(slug: string, patch: Record<string, unknown> = {}) {
    const response = await request<WikiDocument>('/api/documents', 'POST', { title: `Page ${slug}`, slug, content: `Content at ${slug}`, ...patch }, 'alice', `discover-create-${++sequence}`);
    assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body;
  }
  async function pins(id: string) {
    const response = await request<WikiDetail>(`/api/documents/${id}`); assert.equal(response.status, 200);
    const publication = response.body.document.publication!;
    return { expectedVersion: publication.headVersion, expectedHeadVersionId: publication.headVersionId, expectedPublishedVersionId: publication.publishedVersionId, expectedPublicationRevision: publication.revision, expectedAccessEpoch: response.body.accessEpoch! };
  }
  async function operation(id: string, kind: 'drafts' | 'publish' | 'delete', input: Record<string, unknown> = {}) {
    const response = await request<WikiLifecycleReceipt>(`/api/documents/${id}/${kind}`, 'POST', { ...await pins(id), ...input }, 'alice', `discover-${kind}-${++sequence}`);
    assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body;
  }
  async function move(id: string, path: string) {
    const preview = await request<WikiMovePreview>(`/api/documents/${id}/move-preview?${new URLSearchParams({ path })}`); assert.equal(preview.status, 200);
    const result = await request<WikiMoveReceipt>(`/api/documents/${id}/move`, 'POST', preview.body.defaultInput, 'alice', `discover-move-${++sequence}`); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body;
  }
  function policy(id: string, patch: Record<string, unknown>, actor = alice.id) {
    const old = app.policies.policy(id, actor);
    return app.policies.setPolicy(id, { expectedVersion: old.version, spaceId: old.spaceId, ...old.rules, ...patch }, actor);
  }
  async function login() {
    const bootstrap = await request<SessionState>('/api/session', 'GET', undefined, null);
    const result = await raw<SessionState>('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: bootstrap.headers.getSetCookie().map(value => value.split(';')[0]!).join('; '), 'X-CSRF-Token': bootstrap.body.csrfToken! }, body: JSON.stringify({ username: 'alice', password }) });
    assert.equal(result.status, 200);
    return { Cookie: result.headers.getSetCookie().filter(value => !/Max-Age=0/i.test(value)).map(value => value.split(';')[0]!).join('; '), Origin: origin, 'X-CSRF-Token': result.body.csrfToken!, 'X-Session-Context': result.body.sessionContext! };
  }
  let closing: Promise<void> | undefined;
  return { ...app, alice, bob, tokens, origin, basePath, url, raw, request, conduit, document, pins, operation, move, policy, login, close: () => closing ??= (async () => { await app.close(); store.close(); })() };
}

export function conduitResult<T>(response: { status: number; body: ConduitEnvelope<T> }): T {
  assert.equal(response.status, 200); assert.equal(response.body.error_code, null, JSON.stringify(response.body)); assert.equal(response.body.error_info, null); assert.notEqual(response.body.result, null); return response.body.result!;
}

export function conduitFailure(response: { status: number; body: ConduitEnvelope<unknown> }, code?: string) {
  assert.equal(response.status, 200); assert.equal(response.body.result, null); assert.equal(typeof response.body.error_code, 'string'); assert.equal(typeof response.body.error_info, 'string'); if (code) assert.equal(response.body.error_code, code);
}
