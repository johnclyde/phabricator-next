import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { Space } from '../shared/policy';

async function api<T>(request: APIRequestContext, baseURL: string, path: string, body: unknown, method = 'POST'): Promise<T> {
  const response = await request.fetch(new URL(`api${path}`, baseURL).href, { method, data: body, headers: { 'Idempotency-Key': randomUUID() } });
  expect(response.ok(), await response.text()).toBe(true); return response.json() as Promise<T>;
}
async function exported(page: Page, label: string): Promise<unknown> {
  const pending = page.waitForEvent('download'); await page.getByRole('button', { name: label, exact: true }).click();
  const stream = await (await pending).createReadStream(), chunks: Buffer[] = []; for await (const part of stream!) chunks.push(Buffer.from(part));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

test('archiving the selected creation Space disables Paste saves and exact retries while preserving both exportable drafts', async ({ page, request, baseURL }) => {
  let space = await api<Space>(request, baseURL!, '/spaces', { name: `Paste archive boundary ${randomUUID()}` });
  const title = `Retained Paste ${randomUUID()}`, original = 'Original pending source.\n', newer = 'A newer unsent draft remains separate.\n';
  const submissions: { id: string | undefined; body: unknown }[] = [];
  await page.route('**/api/pastes', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    submissions.push({ id: route.request().headers()['idempotency-key'], body: route.request().postDataJSON() });
    await route.fetch(); await route.abort('failed');
  });
  await page.goto('./#pastes'); await page.getByRole('button', { name: 'Create Paste', exact: true }).click();
  await page.getByLabel('Space', { exact: true }).selectOption(space.id); await page.getByLabel('Paste title', { exact: true }).fill(title); await page.getByLabel('Paste content', { exact: true }).fill(original);
  await expect(page.getByRole('button', { name: 'Save Paste', exact: true })).toBeEnabled();
  space = await api<Space>(request, baseURL!, `/spaces/${space.id}`, { expectedVersion: space.version, archived: true }, 'PATCH');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByText('Choose an available Space before saving or retrying. Your draft remains available to export.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save Paste', exact: true })).toBeDisabled(); await expect(page.getByLabel('Paste content', { exact: true })).toHaveValue(original);
  expect(await exported(page, 'Export Paste Draft')).toMatchObject({ spaceId: space.id, title, content: original }); expect(submissions).toHaveLength(0);

  space = await api<Space>(request, baseURL!, `/spaces/${space.id}`, { expectedVersion: space.version, archived: false }, 'PATCH');
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(page.getByRole('button', { name: 'Save Paste', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Save Paste', exact: true }).click(); await expect(page.getByRole('button', { name: 'Retry Exact Paste Change', exact: true })).toBeEnabled(); expect(submissions).toHaveLength(1);
  await page.getByLabel('Paste content', { exact: true }).fill(newer);
  space = await api<Space>(request, baseURL!, `/spaces/${space.id}`, { expectedVersion: space.version, archived: true }, 'PATCH');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByText('Choose an available Space before saving or retrying. Your draft remains available to export.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save Paste', exact: true })).toBeDisabled(); await expect(page.getByRole('button', { name: 'Retry Exact Paste Change', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Paste content', { exact: true })).toHaveValue(newer);
  expect(await exported(page, 'Export Paste Draft')).toMatchObject({ spaceId: space.id, title, content: newer });
  expect(await exported(page, 'Export Paste Request')).toMatchObject({ id: submissions[0]!.id, body: submissions[0]!.body, draft: { title, content: original } });
  expect(submissions).toHaveLength(1);
});
