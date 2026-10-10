import { test, expect, type Page } from '@playwright/test';
import { normalizeBasePath } from '../shared/mount';
import { authAccounts } from './auth-fixture';

const base = normalizeBasePath(process.env.APP_BASE_PATH);
test.use({ baseURL: `http://127.0.0.1:4312${base}` });
async function signIn(page: Page, index = 0) {
  const account = authAccounts[index]!;
  await expect(page.getByRole('heading', { name: 'Sign in to your workspace' })).toBeVisible();
  await page.getByLabel('Username', { exact: true }).fill(account.username);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page.locator('.signed-in-user')).toHaveText(account.displayName);
}
async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Sign Out', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText(/every tab/i);
  await page.getByRole('button', { name: /sign out and clear drafts/i }).click();
}

test('password workspaces verify access before rendering or persisting content', async ({ page }, info) => {
  const requests: string[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/state')) requests.push(request.url()); });
  await page.goto('./#home');
  await expect(page.getByRole('heading', { name: 'Sign in to your workspace' })).toBeVisible();
  expect(requests).toEqual([]);
  await page.screenshot({ path: `.data/${info.project.name}-signin.png`, fullPage: true });
  await signIn(page);
  const title = `Protected task ${info.project.name} ${Date.now()}`;
  await page.getByRole('button', { name: 'Create Task', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Title', { exact: true }).fill(title);
  await dialog.getByRole('button', { name: 'Create Task', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.reload();
  await expect(page.locator('.signed-in-user')).toHaveText('Alice Researcher');
  await expect(page.getByText(title, { exact: true })).toBeVisible();
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(storage).not.toContain(title);
  expect(storage).not.toContain('context-');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: `.data/${info.project.name}-authenticated.png`, fullPage: true });
  await signOut(page);
  await expect(page.getByRole('heading', { name: 'Sign in to your workspace' })).toBeVisible();
  await expect(page.getByText(title, { exact: true })).toHaveCount(0);
});

test('protected offline drafts can be exported and failed logout remains locked', async ({ page, context }) => {
  await page.goto('./#home'); await signIn(page);
  await page.getByRole('button', { name: 'Create Task', exact: true }).click();
  const title = `Unsaved private task ${Date.now()}`;
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Title', { exact: true }).fill(title);
  await context.setOffline(true);
  await dialog.getByRole('button', { name: 'Create Task', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog.getByLabel('Title', { exact: true })).toHaveValue(title);
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export Draft', exact: true }).click();
  const stream = await (await download).createReadStream();
  const chunks: Buffer[] = []; for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString()).toContain(title);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await signOut(page);
  await expect(page.getByRole('button', { name: 'Retry sign out', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create Task', exact: true })).toHaveCount(0);
  await context.setOffline(false);
  await expect(page.getByRole('heading', { name: 'Sign in to your workspace' })).toBeVisible();
  await signIn(page);
  await expect(page.getByText(title, { exact: true })).toHaveCount(0);
});

test('account switching across tabs locks old drafts and rejects the old session context', async ({ page, context }) => {
  await page.goto('./#home'); await signIn(page);
  const old = await page.evaluate(async path => (await fetch(`${path}api/session`)).json(), base);
  await page.getByRole('button', { name: 'Create Task', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Title', { exact: true }).fill('Only Alice unsaved draft');
  const other = await context.newPage(); await other.goto('./#home');
  await expect(other.locator('.signed-in-user')).toHaveText('Alice Researcher');
  await signOut(other);
  await expect(page.getByRole('heading', { name: 'Sign in to your workspace' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toHaveCount(0);
  await signIn(other, 1);
  await expect(page.locator('.signed-in-user')).toHaveText('Bob Editor');
  const status = await page.evaluate(async ({ path, context }) => (await fetch(`${path}api/state`, { headers: { 'X-Session-Context': context } })).status, { path: base, context: old.sessionContext as string });
  expect(status).toBe(401);
  await page.getByRole('button', { name: 'Create Task', exact: true }).click();
  await expect(page.getByRole('dialog').getByLabel('Title', { exact: true })).toHaveValue('');
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain('Only Alice unsaved draft');
});

test('a protected workspace stays locked on offline reload even with the app shell installed', async ({ page, context }) => {
  await page.goto('./#home'); await signIn(page);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Workspace locked' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create Task', exact: true })).toHaveCount(0);
  await expect(page.locator('.signed-in-user')).toHaveCount(0);
  await context.setOffline(false);
  await expect(page.locator('.signed-in-user')).toHaveText('Alice Researcher');
});
