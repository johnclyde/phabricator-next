import { test, expect, type Page } from '@playwright/test';
import type { RepositoryOperations } from '../shared/repository-sync';

const configuration = 'a'.repeat(64);
function operations(epoch: number, patch: Partial<RepositoryOperations> = {}): RepositoryOperations {
  return { snapshot: { repositoryId: 'R1', mode: 'observe', configuration, intervalSeconds: 300, targets: [{ key: 'upstream', direction: 'fetch', state: 'idle', lastAttemptAt: '2026-10-14T00:00:00Z', lastSuccessAt: '2026-10-14T00:00:00Z', nextAttemptAt: null, consecutiveFailures: 0, lastError: null, attempts: 1 }], recentAttempts: [] }, canSync: true, cloneUrl: null, accessEpoch: epoch, ...patch };
}
const panel = (page: Page) => page.locator('.repository-operations');

test('repository operations render observed status and retain an exact request after a lost response', async ({ page, request }, info) => {
  const epoch = ((await (await request.get('./api/state')).json()) as { accessEpoch: number }).accessEpoch;
  const writes: { requestId: string; body: unknown }[] = [];
  await page.route('**/api/repositories/R1/operations', route => route.fulfill({ json: operations(epoch) }));
  await page.route('**/api/repositories/R1/operations/sync', async route => {
    const current = { requestId: route.request().headers()['idempotency-key']!, body: route.request().postDataJSON() as unknown }; writes.push(current);
    if (writes.length === 1) { await route.abort('failed'); return; }
    await route.fulfill({ json: operations(epoch, { receipt: { requestId: current.requestId, configuration, replayed: true } }) });
  });
  await page.goto('./#R1'); await expect(panel(page)).toContainText('Observed externally'); await expect(panel(page)).toContainText('Automatic synchronization every 5 minutes');
  await panel(page).getByRole('button', { name: 'Refresh Now', exact: true }).click();
  await expect(panel(page).getByRole('heading', { name: 'Unconfirmed synchronization request', exact: true })).toBeVisible();
  await expect(panel(page)).toContainText('The response was lost');
  await page.reload(); await expect(panel(page).getByRole('button', { name: 'Retry Exact Request', exact: true })).toBeVisible();
  expect(writes).toHaveLength(1);
  await panel(page).getByRole('button', { name: 'Retry Exact Request', exact: true }).click();
  await expect(panel(page)).toContainText('Recovered the original synchronization request'); expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
  expect(writes[0]!.body).toEqual({ expectedConfiguration: configuration, expectedAccessEpoch: epoch });
  await expect(panel(page).getByRole('button', { name: 'Retry Exact Request', exact: true })).toHaveCount(0);
  if (info.project.name === 'mobile') expect((await panel(page).getByRole('button', { name: 'Refresh Now', exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await panel(page).screenshot({ path: info.outputPath('repository-operations-observed.png') });
});

test('hosting shows a selectable clone URL and mirror failures with no mutation for readers', async ({ page, request }, info) => {
  const epoch = ((await (await request.get('./api/state')).json()) as { accessEpoch: number }).accessEpoch;
  const snapshot = operations(epoch).snapshot;
  snapshot.mode = 'host'; snapshot.targets = [{ key: 'github', direction: 'push', state: 'retrying', lastAttemptAt: '2026-10-14T00:00:00Z', lastSuccessAt: null, nextAttemptAt: '2026-10-14T00:05:00Z', consecutiveFailures: 1, lastError: 'Mirror update was rejected. Check the configured credentials.', attempts: 1 }];
  snapshot.recentAttempts = [{ id: 'attempt-1', targetKey: 'github', direction: 'push', startedAt: '2026-10-14T00:00:00Z', finishedAt: '2026-10-14T00:00:01Z', status: 'failed', message: 'Mirror update was rejected.', changedRefs: null }];
  const cloneUrl = 'https://review.example.invalid/reviews/git/R1.git';
  await page.route('**/api/repositories/R1/operations', route => route.fulfill({ json: operations(epoch, { snapshot, cloneUrl, canSync: false }) }));
  await page.goto('./#R1'); await expect(panel(page)).toContainText('Hosted here');
  await expect(panel(page).getByLabel('HTTPS clone URL')).toHaveValue(cloneUrl); await expect(panel(page)).toContainText('Mirror: github');
  await expect(panel(page)).toContainText('Waiting to retry'); await expect(panel(page)).toContainText('Mirror update was rejected');
  await expect(panel(page).getByRole('button', { name: 'Sync Mirrors', exact: true })).toHaveCount(0);
  await panel(page).getByText('Recent synchronization attempts', { exact: true }).click(); await expect(panel(page).locator('ol')).toContainText('github');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await panel(page).screenshot({ path: info.outputPath(`repository-operations-hosted-${info.project.name}.png`) });
});

test('offline operations never enqueue work and reconnect never replays a request', async ({ page, request, context }) => {
  const epoch = ((await (await request.get('./api/state')).json()) as { accessEpoch: number }).accessEpoch;
  let writes = 0;
  await page.route('**/api/repositories/R1/operations', route => route.fulfill({ json: operations(epoch) }));
  await page.route('**/api/repositories/R1/operations/sync', async route => { writes++; await route.abort('failed'); });
  await page.goto('./#R1'); await expect(panel(page)).toContainText('Observed externally');
  await context.setOffline(true); await expect(panel(page)).toContainText('Offline: repository operations are read-only');
  await expect(panel(page).getByRole('button', { name: 'Reload Status', exact: true })).toBeDisabled();
  await expect(panel(page).getByRole('button', { name: 'Refresh Now', exact: true })).toHaveCount(0);
  await context.setOffline(false); await expect(panel(page)).toContainText('Observed externally'); expect(writes).toBe(0);
});

test('wrong-repository status is rejected without displaying clone credentials or enabling synchronization', async ({ page, request }) => {
  const epoch = ((await (await request.get('./api/state')).json()) as { accessEpoch: number }).accessEpoch;
  const snapshot = { ...operations(epoch).snapshot, repositoryId: 'R2' };
  await page.route('**/api/repositories/R1/operations', route => route.fulfill({ json: operations(epoch, { snapshot, cloneUrl: 'https://elsewhere.invalid/git/R2.git' }) }));
  await page.goto('./#R1'); await expect(panel(page)).toContainText('snapshot could not be verified');
  await expect(panel(page).getByLabel('HTTPS clone URL')).toHaveCount(0); await expect(panel(page).getByRole('button', { name: 'Refresh Now', exact: true })).toHaveCount(0);
});
