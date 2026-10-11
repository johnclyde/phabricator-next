import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { RevisionLifecycleAction, RevisionLifecycleSnapshot } from '../shared/revision-lifecycle';

/** Explicit test setup: inspect current pins, then submit one lifecycle action. */
export async function lifecycleAction(call: (path: string, body?: unknown) => Promise<unknown>, id: string, action: RevisionLifecycleAction) {
  const snapshot = await call(`/revisions/${id}/lifecycle`) as RevisionLifecycleSnapshot;
  return call(`/revisions/${id}/lifecycle`, {
    action, message: 'Explicit lifecycle test action', expectedLifecycleVersion: snapshot.lifecycle.version,
    expectedReviewerVersion: snapshot.reviewers.version, expectedAuthorVersion: snapshot.authorship.version, expectedVersion: snapshot.head.number,
    expectedVersionId: snapshot.head.versionId, expectedContentHash: snapshot.head.contentHash,
    expectedAccessEpoch: snapshot.accessEpoch, expectedConfigId: snapshot.configId, expectedEvidenceSha256: snapshot.evidence.sha256,
  });
}
export async function lifecycleRequest(request: APIRequestContext, base: string, id: string, action: RevisionLifecycleAction) {
  return lifecycleAction(async (path, body) => {
    const response = await request.fetch(new URL(`api${path}`, base).href, { method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { data: body, headers: { 'Idempotency-Key': randomUUID() } }) });
    expect(response.ok(), await response.text()).toBe(true); return response.json();
  }, id, action);
}
export async function closeReviewedRevision(request: APIRequestContext, base: string, id: string) {
  const detail = await (await request.get(new URL(`api/revisions/${id}`, base).href)).json();
  const response = await request.post(new URL(`api/revisions/${id}/reviews`, base).href, { data: { provider: 'local', expectedVersion: detail.revision.currentVersion }, headers: { 'Idempotency-Key': randomUUID() } });
  expect(response.ok(), await response.text()).toBe(true);
  await lifecycleRequest(request, base, id, 'accept_reviewed'); await lifecycleRequest(request, base, id, 'close');
}
export async function chooseLifecycle(page: Page, label: string) {
  const panel = page.getByRole('region', { name: 'Revision Lifecycle', exact: true });
  await panel.getByRole('button', { name: label, exact: true }).click();
  await panel.getByRole('region', { name: 'Lifecycle draft', exact: true }).getByRole('button', { name: 'Confirm Lifecycle Action', exact: true }).click();
}
