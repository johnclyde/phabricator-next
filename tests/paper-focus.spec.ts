import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { RevisionDetail } from '../shared/types';
import { normalizeBasePath } from '../shared/mount';

const SOURCE = '\\section{An argument}\nThe exact original claim remains available.\nA supporting explanation.\n';
const secondary = ['Paper details', 'Review and publishing', 'Review tools', 'AI edit proposals'];
const summary = (page: Page, label: string) => page.locator('summary').filter({ hasText: new RegExp(`^${label}$`) });
const group = (page: Page, label: string) => summary(page, label).locator('..');
const ai = (page: Page) => page.getByRole('region', { name: 'AI edit proposals', exact: true });
async function api<T>(request: APIRequestContext, baseURL: string, path: string, body?: unknown): Promise<T> {
  const response = await request.fetch(new URL(`api${path}`, baseURL).href, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { data: body, headers: { 'Idempotency-Key': randomUUID() } }),
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<T>;
}
async function paper(request: APIRequestContext, baseURL: string) {
  return api<RevisionDetail>(request, baseURL, '/revisions', {
    kind: 'paper', title: `Focused manuscript ${randomUUID()}`, summary: 'An exact source manuscript.',
    testPlan: 'Verify focused writing, retained drafts, and explicit review controls.',
    files: [{ path: 'main.tex', content: SOURCE }],
  });
}
async function open(page: Page, id: string) {
  await page.goto(`./#${id}`);
  await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('1');
}
async function command(page: Page, text: string) {
  await page.getByLabel('Workspace command', { exact: true }).fill(text);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
}

test('paper writing starts focused and secondary panels retain unsent drafts when closed', async ({ page, request, baseURL }, info) => {
  const detail = await paper(request, baseURL!);
  await page.goto('./#papers');
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.sidebar')).toHaveAttribute('inert', '');
  await menu.click();
  await expect(page.getByRole('navigation', { name: 'Applications', exact: true })).toBeVisible();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  const closeNavigation = page.locator('.sidebar').getByRole('button', { name: 'Close navigation', exact: true });
  await expect(closeNavigation).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  expect(await page.locator('.sidebar').evaluate(element => element.contains(document.activeElement))).toBe(true);
  await expect(closeNavigation).not.toBeFocused();
  await page.keyboard.press('Tab');
  await expect(closeNavigation).toBeFocused();
  await closeNavigation.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await expect(menu).toBeFocused();
  await menu.click();
  await expect(closeNavigation).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.sidebar')).toHaveAttribute('inert', '');
  await expect(menu).toBeFocused();

  await menu.click();
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();

  await open(page, detail.revision.id);
  await expect(page.locator('.sidebar')).toHaveAttribute('inert', '');
  for (const label of secondary) {
    await expect(summary(page, label)).toBeVisible();
    await expect(group(page, label)).not.toHaveAttribute('open', '');
  }
  await expect(page.locator('.revision-comparison-panel')).toBeVisible();
  await expect(page.getByLabel('Review comment', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run Local Checks', exact: true })).toBeHidden();
  expect(await page.locator('.discussion').evaluate(element => {
    const details = [...document.querySelectorAll('summary')].find(node => node.textContent === 'Paper details')?.parentElement;
    return Boolean(details && (element.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING));
  })).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const folder = `.data/paper-focus-visual/${normalizeBasePath(process.env.APP_BASE_PATH) === '/' ? 'root' : 'mounted'}`;
  await mkdir(folder, { recursive: true });
  await page.screenshot({ path: `${folder}/${info.project.name}.png` });

  const comment = page.getByLabel('Review comment', { exact: true });
  await comment.fill('An unsent comment remains on this exact version.');
  await summary(page, 'Paper details').click();
  const metadata = page.getByRole('region', { name: 'Revision Details', exact: true, includeHidden: true });
  await metadata.getByRole('button', { name: 'Edit Revision', exact: true }).click();
  const title = metadata.getByLabel('Revision title', { exact: true });
  await title.fill('An unsaved manuscript title');
  await summary(page, 'Paper details').click();
  await expect(title).toHaveCount(1);
  await expect(title).toBeHidden();
  await summary(page, 'Paper details').click();
  await expect(title).toHaveValue('An unsaved manuscript title');
  await expect(comment).toHaveValue('An unsent comment remains on this exact version.');
  const unchanged = await api<RevisionDetail>(request, baseURL!, `/revisions/${detail.revision.id}`);
  expect(unchanged.revision.title).toBe(detail.revision.title);
  expect(unchanged.versions).toEqual(detail.versions);
});

test('selecting a source passage reveals AI instructions without generating or applying edits', async ({ page, request, baseURL }) => {
  const detail = await paper(request, baseURL!), writes: string[] = [];
  page.on('request', row => { if (row.method() === 'POST' && row.url().includes(`/revisions/${detail.revision.id}/ai-proposals`)) writes.push(row.url()); });
  await open(page, detail.revision.id);
  await expect(group(page, 'AI edit proposals')).not.toHaveAttribute('open', '');
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await page.getByLabel('Passage start line', { exact: true }).fill('2');
  await page.getByLabel('Passage end line', { exact: true }).fill('2');
  await page.getByRole('button', { name: 'Use line range for AI', exact: true }).click();
  await expect(group(page, 'AI edit proposals')).toHaveAttribute('open', '');
  await expect(ai(page).getByLabel('Editing instruction', { exact: true })).toBeVisible();
  await ai(page).getByRole('button', { name: 'Use selected passage only', exact: true }).click();
  await expect(ai(page).locator('.automation-evidence').first()).toHaveText('The exact original claim remains available.\n');
  await ai(page).getByLabel('Editing instruction', { exact: true }).fill('Clarify the selected claim.');
  await summary(page, 'AI edit proposals').click();
  await summary(page, 'AI edit proposals').click();
  await expect(ai(page).getByLabel('Editing instruction', { exact: true })).toHaveValue('Clarify the selected claim.');
  expect(writes).toEqual([]);
  expect((await api<RevisionDetail>(request, baseURL!, `/revisions/${detail.revision.id}`)).versions).toEqual(detail.versions);
});

test('voice commands reveal the matching paper tools while preserving their exact source', async ({ page, request, baseURL }) => {
  const detail = await paper(request, baseURL!), writes: string[] = [];
  page.on('request', row => { if (row.method() === 'POST' && row.url().includes(`/revisions/${detail.revision.id}/ai-proposals`)) writes.push(row.url()); });
  await open(page, detail.revision.id);
  await page.getByRole('button', { name: 'Voice and commands', exact: true }).click();
  await command(page, 'set AI instruction to Keep the mathematical claim unchanged.');
  await expect(group(page, 'AI edit proposals')).toHaveAttribute('open', '');
  await expect(ai(page).getByLabel('Editing instruction', { exact: true })).toHaveValue('Keep the mathematical claim unchanged.');
  await expect(group(page, 'Review and publishing')).not.toHaveAttribute('open', '');
  await command(page, 'read stack');
  await expect(group(page, 'Review and publishing')).toHaveAttribute('open', '');
  const stack = page.getByRole('region', { name: 'Revision Stack', exact: true });
  await expect(stack).toBeVisible();
  await expect(stack.locator('.revision-stack-node')).toHaveCount(1);
  expect(writes).toEqual([]);
  expect((await api<RevisionDetail>(request, baseURL!, `/revisions/${detail.revision.id}`)).versions).toEqual(detail.versions);
});
