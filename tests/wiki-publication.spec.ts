import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { WikiDetail, WikiDocument } from '../shared/types';
const name = () => `publication-${randomUUID().slice(0, 8)}`;
async function api<T>(request: APIRequestContext, baseURL: string, path: string, body?: unknown): Promise<T> { const response = body === undefined ? await request.get(new URL(`api${path}`, baseURL).href) : await request.post(new URL(`api${path}`, baseURL).href, { data: body, headers: { 'Idempotency-Key': randomUUID() } }); expect(response.ok(), await response.text()).toBe(true); return response.json(); }
async function create(request: APIRequestContext, baseURL: string): Promise<WikiDocument> { return api(request, baseURL, '/documents', { title: 'Published guide', slug: name(), content: 'Original published content.' }); }
function pins(detail: WikiDetail) { const publication = detail.document.publication!; return { expectedVersion: publication.headVersion, expectedHeadVersionId: publication.headVersionId, expectedPublishedVersionId: publication.publishedVersionId, expectedPublicationRevision: publication.revision, expectedAccessEpoch: detail.accessEpoch }; }
async function saveDraft(page: Page, content: string) { await page.getByRole('button', { name: 'Edit Document', exact: true }).click(); const dialog = page.getByRole('dialog'); await dialog.getByLabel('Content', { exact: true }).fill(content); await dialog.getByRole('button', { name: /^(Save as Draft|Save Draft)$/ }).click(); await expect(dialog).not.toBeVisible(); }
async function publishSelected(page: Page) { await page.getByRole('button', { name: /^(Publish Draft|Publish Older Version)$/ }).click(); await page.getByRole('dialog').getByRole('button', { name: /^(Publish Draft|Publish Older Version)$/ }).click(); await expect(page.getByRole('dialog')).not.toBeVisible(); }
test('saved wiki drafts stay separate from publication and exact older publication preserves history', async ({ page, request, baseURL }, info) => {
  const document = await create(request, baseURL!); await page.goto(`./#${document.id}`); await saveDraft(page, 'Shared draft content.'); await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('2'); await expect(page.locator('.wiki-content')).toHaveText('Shared draft content.'); await expect(page.getByText('This saved draft is visible to everyone who can read the document.', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#${document.id}\\?version=2$`)); await page.reload(); await expect(page.locator('.wiki-content')).toHaveText('Shared draft content.'); await page.goto(`./#${document.id}`); await expect(page.locator('.wiki-content')).toHaveText('Original published content.'); await page.getByRole('button', { name: 'View Draft Version', exact: true }).click(); await saveDraft(page, 'Latest shared draft.'); await publishSelected(page);
  let detail = await api<WikiDetail>(request, baseURL!, `/documents/${document.id}`); expect(detail.document.publication).toMatchObject({ headVersion: 3, publishedVersion: 3, revision: 4 }); const original = detail.history.versions.find(version => version.number === 1)!;
  await page.getByLabel('Version to inspect', { exact: true }).fill('1'); await publishSelected(page); detail = await api(request, baseURL!, `/documents/${document.id}`); expect(detail.document.publication).toMatchObject({ headVersion: 3, publishedVersion: 1, publishedVersionId: original.id, revision: 5 }); expect(detail.history.versions).toHaveLength(3);
  await page.screenshot({ path: `.data/wiki-publication-visual/${process.env.APP_BASE_PATH ? 'mounted' : 'root'}/${info.project.name}.png`, fullPage: true });
  await page.evaluate(() => window.scrollTo(0, 0)); await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await page.screenshot({ path: `.data/wiki-publication-visual/${process.env.APP_BASE_PATH ? 'mounted' : 'root'}/${info.project.name}-viewport.png` });
  await api(request, baseURL!, `/documents/${document.id}/publish`, { ...pins(detail), targetVersionId: detail.head!.id }); await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(page.getByText(`${document.slug} · Published version 3 · Latest content 3`, { exact: true })).toBeVisible(); await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('1'); await page.getByRole('button', { name: 'Published Version', exact: true }).click(); await expect(page.locator('.wiki-content')).toHaveText('Latest shared draft.');
});
test('wiki deletion retains descendants and historical publishing does not reactivate the identity', async ({ page, request, baseURL }) => {
  const document = await create(request, baseURL!), child = await api<WikiDocument>(request, baseURL!, '/documents', { title: 'Retained child', slug: `${document.slug}child`, content: 'Child remains.' }); await page.goto(`./#${document.id}`); await page.getByRole('button', { name: 'Delete Document', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: 'Delete Document', exact: true }).click(); await expect(page.getByRole('dialog')).not.toBeVisible(); await expect(page.getByRole('heading', { name: 'Document Deleted', exact: true })).toBeVisible();
  await page.getByLabel('Version to inspect', { exact: true }).fill('1'); await publishSelected(page); let detail = await api<WikiDetail>(request, baseURL!, `/documents/${document.id}`); expect(detail.document.location!.status).toBe('deleted'); expect(detail.document.publication!.headVersion).toBe(2); await expect(page.locator('.wiki-content')).toHaveText('Original published content.');
  await page.getByRole('button', { name: 'Restore as new version', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: 'Restore as New Version', exact: true }).click(); await expect(page.getByRole('dialog')).not.toBeVisible(); detail = await api(request, baseURL!, `/documents/${document.id}`); expect(detail.document.location!.status).toBe('active'); expect(detail.document.publication).toMatchObject({ headVersion: 3, publishedVersion: 3 }); expect((await api<WikiDetail>(request, baseURL!, `/documents/${child.id}`)).document.content).toBe('Child remains.');
});
test('lost publish receipts recover exact intent while retaining a newer action message', async ({ page, request, baseURL }) => {
  const document = await create(request, baseURL!); await page.goto(`./#${document.id}`); await saveDraft(page, 'Draft to publish exactly.'); await page.getByRole('button', { name: 'Publish Draft', exact: true }).click(); const dialog = page.getByRole('dialog'); await dialog.getByLabel('Action message').fill('Original publication note'); let sends = 0, body = '', key = '';
  await page.route(`**/api/documents/${document.id}/publish`, async route => { sends++; if (sends === 1) { body = route.request().postData()!; key = route.request().headers()['idempotency-key']!; await route.fetch(); await route.abort('failed'); } else { expect(route.request().postData()).toBe(body); expect(route.request().headers()['idempotency-key']).toBe(key); await route.continue(); } });
  await dialog.getByRole('button', { name: 'Publish Draft', exact: true }).click(); await expect(dialog.getByRole('alert')).toBeVisible(); await dialog.getByLabel('Action message').fill('A newer unsent note'); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await page.evaluate(() => { window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('focus')); }); await expect(page.getByRole('button', { name: 'Retry Exact Wiki Change', exact: true })).toBeEnabled(); expect(sends).toBe(1); await page.getByRole('button', { name: 'Retry Exact Wiki Change', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Unconfirmed Wiki Change', exact: true })).not.toBeVisible(); expect(sends).toBe(2);
  expect((await api<WikiDetail>(request, baseURL!, `/documents/${document.id}`)).document.publication!.revision).toBe(3); expect(await page.evaluate(id => Object.keys(localStorage).filter(key => key.includes(`wiki-action:${id}:`)).map(key => JSON.parse(localStorage.getItem(key)!).message), document.id)).toContain('A newer unsent note');
});
test('local wiki drafts preserve their exact publication base through quota failures and later publications', async ({ page, request, baseURL, context }) => {
  const document = await create(request, baseURL!); await page.goto(`./#${document.id}`); await saveDraft(page, 'Shared second version.'); await page.getByRole('button', { name: 'Edit Document', exact: true }).click(); await page.evaluate(() => { const original = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { if (key.includes('wiki-edit:')) throw new DOMException('Test quota', 'QuotaExceededError'); original.call(this, key, value); }; }); await page.getByRole('dialog').getByLabel('Content', { exact: true }).fill('Unsent quota draft.'); await context.setOffline(true); await expect(page.getByRole('dialog').getByRole('button', { name: 'Save Draft', exact: true })).toBeDisabled(); await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click(); await context.setOffline(false);
  const detail = await api<WikiDetail>(request, baseURL!, `/documents/${document.id}`); await api(request, baseURL!, `/documents/${document.id}/publish`, { ...pins(detail), targetVersionId: detail.head!.id }); await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(page.getByText(`${document.slug} · Published version 2 · Latest content 2`, { exact: true })).toBeVisible(); await expect(page.getByRole('heading', { name: 'Retained Local Wiki Drafts', exact: true })).toBeVisible(); const exported = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export Local Edit', exact: true }).click(); const stream = await (await exported).createReadStream(), chunks: Buffer[] = []; for await (const chunk of stream!) chunks.push(Buffer.from(chunk)); expect(JSON.parse(Buffer.concat(chunks).toString())).toMatchObject({ value: { content: 'Unsent quota draft.', pins: { expectedPublicationRevision: 2, expectedPublishedVersionId: detail.document.publication!.publishedVersionId } } });
});
test('content and publication history pages finish independently when both are requested', async ({ page, request, baseURL }) => {
  const document = await create(request, baseURL!);
  for (let number = 2; number <= 23; number++) {
    const detail = await api<WikiDetail>(request, baseURL!, `/documents/${document.id}`);
    await api(request, baseURL!, `/documents/${document.id}/drafts`, { ...pins(detail), title: document.title, content: `Shared draft ${number}.` });
  }
  await page.goto(`./#${document.id}`); await page.getByRole('tab', { name: 'History', exact: true }).click();
  let releaseContent!: () => void, releaseLifecycle!: () => void;
  const content = new Promise<void>(resolve => { releaseContent = resolve; }), lifecycle = new Promise<void>(resolve => { releaseLifecycle = resolve; });
  await page.route(`**/api/documents/${document.id}/history?**`, async route => { const response = await route.fetch(); await content; await route.fulfill({ response }); });
  await page.route(`**/api/documents/${document.id}/transactions?**`, async route => { const response = await route.fetch(); await lifecycle; await route.fulfill({ response }); });
  await page.getByRole('button', { name: 'Load older history', exact: true }).click(); await page.getByRole('button', { name: 'Load Earlier Publication History', exact: true }).click();
  releaseLifecycle(); await expect(page.getByRole('button', { name: 'Inspect Published Version 1', exact: true })).toHaveCount(23);
  releaseContent(); await expect(page.locator('.wiki-history-entry')).toHaveCount(23); await expect(page.getByRole('button', { name: 'Loading history…', exact: true })).not.toBeVisible();
});
test('editing and restoring exact whitespace-bearing titles confirm without stranded requests', async ({ page, request, baseURL }) => {
  const document = await api<WikiDocument>(request, baseURL!, '/documents', { title: '  Original title  ', slug: name(), content: 'Original source.' });
  await page.goto(`./#${document.id}`); await page.getByRole('button', { name: 'Edit Document', exact: true }).click();
  const dialog = page.getByRole('dialog'); await dialog.getByLabel('Title', { exact: true }).fill('  Edited title  '); await dialog.getByLabel('Content', { exact: true }).fill('Edited source.');
  await dialog.getByRole('button', { name: 'Save and Publish', exact: true }).click(); await expect(dialog).not.toBeVisible();
  expect((await api<WikiDetail>(request, baseURL!, `/documents/${document.id}`)).document.title).toBe('  Edited title  ');
  await page.getByLabel('Version to inspect', { exact: true }).fill('1'); await page.getByRole('button', { name: 'Restore as new version', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Restore as New Version', exact: true }).click(); await expect(page.getByRole('dialog')).not.toBeVisible();
  expect((await api<WikiDetail>(request, baseURL!, `/documents/${document.id}`)).document.title).toBe('  Original title  ');
  await expect(page.getByRole('heading', { name: 'Unconfirmed Wiki Change', exact: true })).not.toBeVisible();
});

test.describe('wiki workspace catch-up', () => {
  test.use({ serviceWorkers: 'block' });
  test('equal discovery leaves the editor usable while a newer publication refreshes the pinned reader', async ({ page, request, baseURL }) => {
    const document = await create(request, baseURL!);
    const initial = await api<WikiDetail>(request, baseURL!, `/documents/${document.id}`);
    await api(request, baseURL!, `/documents/${document.id}/drafts`, { ...pins(initial), title: document.title, content: 'Shared second version.' });
    const draft = await api<WikiDetail>(request, baseURL!, `/documents/${document.id}`);
    const stateURL = new URL('api/state', baseURL!).href;
    const detailURL = new URL(`api/documents/${document.id}`, baseURL!).href;
    let holding = true, detailReads = 0, release!: () => void, captured!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { captured = resolve; });
    await page.route(stateURL, async route => {
      if (!holding) { await route.continue(); return; }
      const response = await route.fetch(); captured(); await gate; await route.fulfill({ response });
    });
    await page.route(detailURL, async route => { detailReads++; await route.continue(); });
    try {
      await page.goto(`./#${document.id}`); await ready;
      await page.getByLabel('Version to inspect', { exact: true }).fill('2');
      await page.getByLabel('Version to inspect', { exact: true }).fill('1');
      await page.getByRole('button', { name: 'Edit Document', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Content', { exact: true }).fill('Unsent text survives discovery.');
      const beforeCatchUp = detailReads;
      holding = false; release();
      await expect.poll(() => page.evaluate(id => Object.keys(localStorage).filter(key => key.endsWith(':state')).some(key => JSON.parse(localStorage.getItem(key)!).documents?.some((entry: { id: string; publication?: { revision: number } }) => entry.id === id && entry.publication?.revision === 2)), document.id)).toBe(true);
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(detailReads).toBe(beforeCatchUp);
      await expect(dialog.getByLabel('Content', { exact: true })).toHaveValue('Unsent text survives discovery.');
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.getByRole('button', { name: 'Edit Document', exact: true }).click();
      await expect(dialog.getByLabel('Content', { exact: true })).toHaveValue('Unsent text survives discovery.');
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();

      await api(request, baseURL!, `/documents/${document.id}/publish`, { ...pins(draft), targetVersionId: draft.head!.id });
      // Already online: this refreshes workspace discovery without firing Wiki's
      // focus/reconnect load. Its newer publication counter must request detail.
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await expect(page.getByText(`${document.slug} · Published version 2 · Latest content 2`, { exact: true })).toBeVisible();
      expect(detailReads).toBeGreaterThan(beforeCatchUp);
      await expect(page.getByLabel('Version to inspect', { exact: true })).toHaveValue('1');
      await expect(page.locator('.wiki-content')).toHaveText('Original published content.');
      expect(await page.evaluate(id => Object.keys(localStorage).filter(key => key.includes(`:wiki-edit:${id}:`)).map(key => JSON.parse(localStorage.getItem(key)!)), document.id)).toContainEqual(expect.objectContaining({ content: 'Unsent text survives discovery.', pins: expect.objectContaining({ expectedPublicationRevision: 2, expectedPublishedVersionId: draft.document.publication!.publishedVersionId }) }));
    } finally { holding = false; release(); await page.unrouteAll({ behavior: 'wait' }); }
  });
});
