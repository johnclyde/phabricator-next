import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { SuiteDetail } from '../shared/suite';
import type { SlowvoteView } from '../shared/slowvote';
import type { PhamePostData } from '../shared/phame';

async function detail(request: APIRequestContext, baseURL: string, app: string, id: string): Promise<SuiteDetail> {
  const response = await request.get(new URL(`api/suite/${app}/${id}`, baseURL).href); expect(response.ok(), await response.text()).toBe(true); return response.json() as Promise<SuiteDetail>;
}
async function submit(page: Page, app: string, label: string) {
  const editor = page.getByRole('form', { name: `${app} editor` });
  const response = page.waitForResponse(value => value.request().method() === 'POST' && new URL(value.url()).pathname.includes('/api/suite/'));
  await editor.getByRole('button', { name: label, exact: true }).click();
  const result = await response; expect(result.ok(), await result.text()).toBe(true); await expect(editor).toHaveCount(0);
  return (await result.json()) as SuiteDetail;
}
async function command(page: Page, app: string, label: string) { await page.getByRole('button', { name: label, exact: true }).click(); return submit(page, app, label); }
async function visual(page: Page, name: string) { expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' })); await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0); await mkdir('.data/suite-visuals', { recursive: true }); await page.screenshot({ path: `.data/suite-visuals/${name}.png`, fullPage: true }); }

test('Slowvote creates a poll, preserves private results, changes votes, closes and reopens', async ({ page, request, baseURL }, info) => {
  page.on('dialog', dialog => dialog.accept()); const title = `Lunch poll ${randomUUID()}`;
  await page.goto('./#slowvote'); await page.getByRole('button', { name: 'Create poll', exact: true }).click();
  let editor = page.getByRole('form', { name: 'Slowvote editor' });
  await editor.getByLabel('Question', { exact: true }).fill(title); await editor.getByLabel('Description', { exact: true }).fill('Choose a shared lunch.'); await editor.getByLabel('Choices — one per line', { exact: true }).fill('Soup\nSalad\nBread'); await editor.getByLabel('Who can see responses', { exact: true }).selectOption('aftervote');
  const created = await submit(page, 'Slowvote', 'Create poll'); const id = created.record.id;
  await expect(page.getByText('Vote to see responses.', { exact: true })).toBeVisible(); expect((created.record.data as unknown as SlowvoteView).results).toBeNull();
  await page.getByRole('button', { name: 'Vote', exact: true }).click(); editor = page.getByRole('form', { name: 'Slowvote editor' }); await editor.getByLabel('Choose one option', { exact: true }).selectOption('option-1'); await submit(page, 'Slowvote', 'Vote');
  await expect(page.getByText('Your response: Soup', { exact: true })).toBeVisible(); await expect(page.getByText('1 person has responded.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Update your response', exact: true }).click(); editor = page.getByRole('form', { name: 'Slowvote editor' }); await editor.getByLabel('Choose one option', { exact: true }).selectOption('option-2'); await submit(page, 'Slowvote', 'Update your response');
  const voted = await detail(request, baseURL!, 'slowvote', id); expect((voted.record.data as unknown as SlowvoteView).results?.map(item => item.count)).toEqual([0, 1, 0]);
  await command(page, 'Slowvote', 'Withdraw your response'); await expect(page.getByText('Vote to see responses.', { exact: true })).toBeVisible();
  await command(page, 'Slowvote', 'Close poll'); await expect(page.getByRole('button', { name: 'Vote', exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Reopen poll', exact: true })).toBeVisible();
  await command(page, 'Slowvote', 'Reopen poll'); await page.getByRole('button', { name: 'Add comment', exact: true }).click(); editor = page.getByRole('form', { name: 'Slowvote editor' }); await editor.getByLabel('Comment', { exact: true }).fill('Lunch is tomorrow.'); await submit(page, 'Slowvote', 'Add comment');
  await expect(page.locator('.suite-content')).toContainText('Lunch is tomorrow.'); await visual(page, `slowvote-${info.project.name}`);
});

test('Slowvote retains an offline approval ballot and retries an uncertain response exactly once', async ({ page, context, request, baseURL }) => {
  const response = await request.post(new URL('api/suite/slowvote', baseURL!).href, { headers: { 'Idempotency-Key': randomUUID() }, data: { kind: 'poll', title: `Approval ${randomUUID()}`, choices: ['Morning', 'Afternoon'], method: 'multiple', responseVisibility: 'closed' } }); expect(response.ok(), await response.text()).toBe(true); const created = await response.json() as SuiteDetail, id = created.record.id;
  await page.goto(`./#slowvote/${id}`); await page.getByRole('button', { name: 'Vote', exact: true }).click(); let editor = page.getByRole('form', { name: 'Slowvote editor' }); await editor.getByLabel('Morning', { exact: true }).check(); await context.setOffline(true); await editor.getByLabel('Afternoon', { exact: true }).check(); await expect(editor.getByRole('button', { name: 'Vote', exact: true })).toBeDisabled();
  await page.evaluate(() => { location.hash = 'home'; }); await expect(page.getByRole('heading', { name: 'Your workspace', exact: true })).toBeVisible(); await page.evaluate(id => { location.hash = `slowvote/${id}`; }, id); editor = page.getByRole('form', { name: 'Slowvote editor' }); await expect(editor.getByLabel('Morning', { exact: true })).toBeChecked(); await expect(editor.getByLabel('Afternoon', { exact: true })).toBeChecked();
  let writes = 0, dropped = false; page.on('request', value => { if (value.method() === 'POST' && value.url().endsWith(`/${id}/vote`)) writes++; });
  await context.setOffline(false); await expect(editor.getByRole('button', { name: 'Vote', exact: true })).toBeEnabled(); expect(writes).toBe(0);
  await page.route(`**/api/suite/slowvote/${id}/vote`, async route => { if (!dropped) { dropped = true; const result = await route.fetch(); expect(result.ok(), await result.text()).toBe(true); await route.abort('failed'); } else await route.continue(); });
  await editor.getByRole('button', { name: 'Vote', exact: true }).click(); await expect(page.getByRole('region', { name: 'Unconfirmed automation request', exact: true })).toBeVisible(); await page.getByRole('button', { name: 'Retry Exact Request', exact: true }).click(); await expect(editor).toHaveCount(0);
  const after = await detail(request, baseURL!, 'slowvote', id); expect(after.record.version).toBe(2); expect(after.events.filter(event => event.action === 'vote')).toHaveLength(1); expect((after.record.data as unknown as SlowvoteView).ownChoiceIds).toEqual(['option-1', 'option-2']); expect((after.record.data as unknown as SlowvoteView).results).toBeNull(); expect(writes).toBe(2);
});

test('Phame creates a blog and draft, publishes exact content, comments and returns to draft', async ({ page, request, baseURL }, info) => {
  page.on('dialog', dialog => dialog.accept());
  await page.goto('./#phame'); await page.getByRole('button', { name: 'Create blog', exact: true }).click(); let editor = page.getByRole('form', { name: 'Phame editor' }); await editor.getByLabel('Title', { exact: true }).fill(`Research notes ${randomUUID()}`); await editor.getByLabel('Description', { exact: true }).fill('An internal research journal.'); const blog = await submit(page, 'Phame', 'Create blog');
  await page.getByRole('button', { name: 'Write a post', exact: true }).click(); editor = page.getByRole('form', { name: 'Phame editor' }); await editor.getByLabel('Blog ID', { exact: true }).fill(blog.record.id); await editor.getByLabel('Title', { exact: true }).fill('A reproducible experiment'); await editor.getByLabel('Subtitle', { exact: true }).fill('Initial observations'); await editor.getByLabel('Post body', { exact: true }).fill('Draft evidence before publication.'); const post = await submit(page, 'Phame', 'Write a post'), id = post.record.id;
  expect((post.record.data as unknown as PhamePostData).status).toBe('draft'); await expect(page.getByRole('button', { name: 'Add comment', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit post', exact: true }).click(); editor = page.getByRole('form', { name: 'Phame editor' }); await editor.getByLabel('Post body', { exact: true }).fill('The published observation is reproducible.'); await submit(page, 'Phame', 'Edit post');
  await command(page, 'Phame', 'Publish post'); await expect(page.locator('.suite-content')).toContainText('Published'); await page.getByRole('button', { name: 'Add comment', exact: true }).click(); editor = page.getByRole('form', { name: 'Phame editor' }); await editor.getByLabel('Comment', { exact: true }).fill('I repeated this experiment.'); await submit(page, 'Phame', 'Add comment'); await expect(page.locator('.suite-content')).toContainText('I repeated this experiment.');
  const published = await detail(request, baseURL!, 'phame', id); expect((published.record.data as unknown as PhamePostData).status).toBe('published'); expect((published.record.data as unknown as PhamePostData).revisions.map(revision => revision.body)).toEqual(['Draft evidence before publication.', 'The published observation is reproducible.', 'The published observation is reproducible.']);
  await visual(page, `phame-${info.project.name}`); await command(page, 'Phame', 'Return to draft'); const unpublished = await detail(request, baseURL!, 'phame', id); expect((unpublished.record.data as unknown as PhamePostData).status).toBe('draft'); expect((unpublished.record.data as unknown as PhamePostData).publishedAt).toBeNull(); await expect(page.getByRole('button', { name: 'Add comment', exact: true })).toHaveCount(0);
  await command(page, 'Phame', 'Archive post'); await expect(page.getByRole('button', { name: 'Restore as draft', exact: true })).toBeVisible(); await command(page, 'Phame', 'Restore as draft'); await expect(page.getByRole('button', { name: 'Publish post', exact: true })).toBeVisible();
});
