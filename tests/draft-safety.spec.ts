import { test, expect, type Page } from '@playwright/test';

async function queueTask(page: Page, title: string) {
  await page.goto('./#tasks');
  await page.getByRole('button', { name: 'Create Task', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Title', exact: true }).fill(title);
  await dialog.getByRole('button', { name: 'Create Task', exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

test('discarding in another tab retains newer offline edits', async ({ page, context }, info) => {
  await page.goto('./#tasks');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  const other = await context.newPage();
  await other.goto('./#tasks');
  await expect(other.getByRole('heading', { name: 'Maniphest', exact: true })).toBeVisible();
  await context.setOffline(true);
  const first = `Discarded ${info.project.name} ${Date.now()}`;
  const second = `Preserved ${info.project.name} ${Date.now()}`;
  await queueTask(page, first);
  await page.getByRole('button', { name: /Offline outbox, 1 pending/ }).click();
  await queueTask(other, second);
  await expect(page.getByRole('button', { name: /Offline outbox, 2 pending/ })).toBeVisible();
  page.once('dialog', dialog => void dialog.accept());
  await page.getByRole('button', { name: 'Discard', exact: true }).first().click();
  await expect(other.getByRole('button', { name: /Offline outbox, 1 pending/ })).toBeVisible();
  await page.getByText('View saved change', { exact: true }).click();
  await expect(page.locator('.outbox-item pre')).toContainText(second);
  await context.setOffline(false);
  await expect(page.getByText('Everything is synchronized.', { exact: false })).toBeVisible();
  await page.goto('./#tasks');
  await expect(page.getByText(second, { exact: true })).toHaveCount(1);
  await expect(page.getByText(first, { exact: true })).toHaveCount(0);
});

test('inline comment draft keeps the original version and location after reload', async ({ page, request, baseURL }) => {
  const response = await request.get(new URL('api/revisions/L3', baseURL).href);
  expect(response.ok()).toBe(true);
  const detail = await response.json() as import('../shared/types').RevisionDetail;
  const versionId = detail.versions.find(version => version.number === 1)!.id;
  await page.goto('./#L3');
  await page.getByLabel('Version to inspect', { exact: true }).selectOption('1');
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await page.getByRole('button', { name: 'Comment on line 7', exact: true }).click();
  await page.getByRole('textbox', { name: 'Review comment', exact: true }).fill('This passage needs a precise duration.');
  await expect.poll(() => page.evaluate(key => {
    const storage = Object.keys(localStorage).find(value => value.endsWith(`:${key}`));
    return storage ? JSON.parse(localStorage.getItem(storage)!) as unknown : null;
  }, `comment-source:L3:${versionId}`)).toEqual({ body: 'This passage needs a precise duration.', versionId, filePath: 'motion.md', line: 7 });
  await page.reload();
  await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('1');
  await expect(page.getByRole('textbox', { name: 'Review comment', exact: true })).toHaveValue('This passage needs a precise duration.');
  await page.getByLabel('Version to inspect', { exact: true }).selectOption('2');
  await expect(page.getByRole('textbox', { name: 'Review comment', exact: true })).toHaveValue('');
  await page.getByLabel('Version to inspect', { exact: true }).selectOption('1');
  await expect(page.getByRole('textbox', { name: 'Review comment', exact: true })).toHaveValue('This passage needs a precise duration.');
  await expect(page.locator('.comment-target')).toContainText('motion.md:7');
  await page.getByRole('button', { name: 'Add Comment', exact: true }).click();
  await expect(page.locator('.comment').last()).toContainText('v1 · motion.md:7');
});

test('storage failures keep draft text visible and offer export', async ({ page }) => {
  await page.goto('./#tasks');
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key: string, value: string) {
      if (key.startsWith('phabricator-next:') && key.includes(':draft:')) throw new DOMException('Test quota exhausted', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  await page.getByRole('button', { name: 'Create Task', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Title', exact: true }).fill('Keep this unsaved text');
  await expect(dialog.getByText('This draft is only in this tab. Keep it open or export it.', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Export Draft', exact: true })).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Keep this unsaved text');
  await expect(dialog.getByText('Draft saved on this device', { exact: true })).not.toBeVisible();
});
